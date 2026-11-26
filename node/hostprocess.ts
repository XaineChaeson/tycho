// What this machine can say about its own processes, for the per-round watch process
// (docs/design/nodes.md §4.3). Two different questions, with two different proofs:
//
//   - "Is this the process I started?" — the pid and the moment the system says it began.
//     A pid alone names another process once the first is gone, and the moment is what
//     tells them apart. No WMI is needed for this one.
//   - "Is anything of this round still running?" — the processes below the one recorded,
//     and the processes carrying the round's marker. On Windows that means WMI, which can
//     be refused; then the answer is "unknown", never "nothing is there".
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAlive, processStartLater } from '../service/lock.ts';
import { carries, procTable, psTable } from '../service/processes.ts';
import type { ProcessRow } from '../service/processes.ts';
import { defaultProcInfo, type ProcRow } from '../service/procinfo.ts';

const run = promisify(execFile);
// As service/processes.ts: a bound on one system command, not something the owner tunes;
// and this runs on a machine that has no configuration of its own.
const PROCESS_COMMAND_MS = 30_000;

// The parent links of a machine's processes, and where a marker may be found in them: the
// command line, and (Linux) the environment.
interface ParentLinks {
  pid: number;
  ppid: number;
  text?: string;
}

// The processes below one root, from a table of parent links: itself included. Pure, so
// the shape of a machine's answer can be tested without one.
export function subtree(table: readonly ParentLinks[], root: number): number[] {
  const children = new Map<number, number[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const found: number[] = [];
  const seen = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (pid <= 1 || seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

export interface HostProcesses {
  alive(pid: number): boolean;
  // When the system says this process began, as text that only compares with itself. Asked
  // without holding the thread: on Windows it is a program run per pid, and the client's
  // poll must not wait on it (nodes.md §4.4).
  startOf(pid: number): Promise<string | undefined>;
  // This process and everything below it. Undefined when the machine cannot say.
  descendants(root: number): Promise<number[] | undefined>;
  // The whole table, where the machine can read it in one look: a caller with two roots to
  // ask about reads it once and takes both subtrees from the same answer. Absent where the
  // machine has no such answer, and the caller asks descendants() instead.
  table?(): Promise<ProcRow[] | undefined>;
  // Every process carrying this round's marker, wherever it is. Undefined when it cannot
  // be read.
  tagged(marker: string): Promise<number[] | undefined>;
  // End one process and everything below it, by the parent links. Resolves either way; the
  // caller looks again, and that look is the proof.
  endTree(root: number, signal: 'INT' | 'KILL'): Promise<void>;
  // End the process group this pid leads. Only whoever started that leader knows the number
  // is a group's: a group signalled by mistake is somebody else's, so this is never asked of
  // a pid that was merely found.
  endGroup(root: number, signal: 'INT' | 'KILL'): Promise<void>;
  // Whether the process group this one leads still has anything in it. Undefined where the
  // system has no such notion (Windows): the group is one answer that needs no table.
  groupAlive?(root: number): boolean | undefined;
}

// Windows answers through one compiled helper where this machine has one, and through WMI
// in a PowerShell where it has not (service/procinfo.ts), so a busy machine's look at its
// processes does not cost a PowerShell per question.
function windowsProcesses(): HostProcesses {
  const info = () => defaultProcInfo();
  return {
    alive: (pid) => isAlive(pid),
    startOf: async (pid) => (await info().startsLater([pid])).get(pid),

    async descendants(root) {
      try {
        const table = await info().table();
        return table === undefined ? undefined : subtree(table, root);
      } catch {
        // Refused, or nothing answered: this proves nothing about what is running.
        return undefined;
      }
    },

    async table() {
      try {
        return await info().table();
      } catch {
        return undefined;
      }
    },

    async tagged(marker) {
      try {
        return await info().tagged(marker);
      } catch {
        return undefined;
      }
    },

    async endTree(root, signal) {
      // `taskkill /T /F` ends the tree by the parent links, which is the only handle
      // Windows gives; there is no graceful signal to send first, and no group either.
      await killTree(root);
      void signal;
    },

    // No process groups on Windows: the tree is what there is, and the tree is the answer.
    async endGroup(root, signal) {
      await killTree(root);
      void signal;
    },
  };
}

// The whole tree below one pid, the only way Windows has to end what a command started.
// Exported for the one other caller that starts a command of its own and may have to end it
// past a deadline (node/executors.ts).
async function killTree(root: number): Promise<void> {
  try {
    await run('taskkill', ['/T', '/F', '/PID', String(root)], { windowsHide: true, timeout: PROCESS_COMMAND_MS });
  } catch {
    // Gone already, refused, or nothing answered. The caller looks again, and that
    // look is what says whether anything is left.
  }
}

// A stop request is only half the proof: an exited Windows wrapper can leave children
// holding its output pipes. The final process-table read proves whether they are gone.
export async function stopProbeTree(root: number, platform: NodeJS.Platform, processes: HostProcesses = selectProcesses(platform)): Promise<boolean> {
  try {
    if (platform !== 'win32') {
      await processes.endGroup(root, 'KILL');
      return processes.groupAlive?.(root) === false;
    }
    const before = await processes.descendants(root);
    await processes.endTree(root, 'KILL');
    // taskkill cannot use an exited root; the table still names its surviving children.
    for (const pid of (before ?? []).toReversed()) {
      if (pid !== root && processes.alive(pid)) await processes.endTree(pid, 'KILL');
    }
    const after = await processes.descendants(root);
    return before !== undefined && after !== undefined && [...before, ...after].every((pid) => !processes.alive(pid));
  } catch {
    return false;
  }
}

async function posixTable(platform: NodeJS.Platform): Promise<ProcessRow[]> {
  return platform === 'linux' ? procTable() : psTable();
}

function posixProcesses(platform: NodeJS.Platform): HostProcesses {
  const descendants = async (root: number): Promise<number[] | undefined> => {
    try {
      return subtree(await posixTable(platform), root);
    } catch {
      return undefined;
    }
  };
  // A negative target is a process group. Gone already, or not ours to signal: the caller's
  // next look decides, and it is the only thing that proves anything.
  const send = (target: number, signal: 'INT' | 'KILL'): void => {
    try {
      process.kill(target, signal === 'INT' ? 'SIGINT' : 'SIGKILL');
    } catch {
      // The look again is what says whether anything is left.
    }
  };
  return {
    alive: (pid) => isAlive(pid),
    startOf: (pid) => processStartLater(pid),
    descendants,

    async tagged(marker) {
      try {
        return (await posixTable(platform)).filter((row) => carries(row.text, marker)).map((row) => row.pid);
      } catch {
        return undefined;
      }
    },

    async endTree(root, signal) {
      send(root, signal);
      // Anything below it that the signal did not reach: a survivor may have no living
      // parent left to be found through, so only the kill pass walks the links.
      if (signal === 'KILL') for (const pid of (await descendants(root)) ?? []) send(pid, signal);
    },

    // The group of a round's Worker, which the watch made by starting it detached: one
    // signal reaches everything it started, whether or not the parent links still do.
    async endGroup(root, signal) {
      send(-root, signal);
      if (signal === 'KILL') {
        for (const pid of (await descendants(root)) ?? []) send(pid, signal);
        send(root, signal);
      }
    },

    // One signal that is answered or refused, with nothing read: the group of a round is
    // the processes it started, which is the question residue asks.
    groupAlive(root) {
      try {
        process.kill(-root, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined;
      }
    },
  };
}

export function selectProcesses(platform: NodeJS.Platform = process.platform): HostProcesses {
  return platform === 'win32' ? windowsProcesses() : posixProcesses(platform);
}
