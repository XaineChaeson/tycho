import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { defaultProcInfo, type ProcInfo } from './procinfo.ts';

// By its full path: a service started with a short PATH still has to see its own processes.
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const TASKKILL = join(SYSTEM32, 'taskkill.exe');

const run = promisify(execFile);

// How long one look at the process table may take. A constant: it bounds a system command,
// which is this program's own patience, not behaviour the owner tunes.
const PROCESS_COMMAND_MS = 30_000;
// With every environment in it, `ps` on a busy machine prints megabytes.
const PS_BUFFER_BYTES = 256 * 1024 * 1024;

// The Router is started with its marker here as well as on its command line. What it
// starts inherits the variable, and a CLI can overwrite its own command line (setting a
// process title does) but not the environment it was given. On Windows the search reads
// command lines only (service/procinfo.ts); on POSIX it reads both.
export const MARKER_ENV = 'TYCHO_ROUTER_MARKER';

export interface Processes {
  // Every running process that carries the marker.
  find(marker: string): Promise<number[]>;
  // Ends the process and everything it started. The marker is whose tree the caller
  // takes it for. The caller looks again afterwards: this proves nothing by returning.
  kill(pid: number, marker: string): Promise<void>;
}

// What the root of a tree is started with so that kill() can end the tree: on POSIX a
// process group (and session) of its own, which one signal reaches whole. The pipes are
// not affected, and a signal sent to the service's group, Ctrl+C in its terminal, no
// longer reaches the Router behind the Host's back. On Windows taskkill follows the parent
// links instead, and what a Ctrl+C reaches is a console: windowsHide with no standard
// handle inherited gives the child a console of its own with no window (CREATE_NO_WINDOW),
// so a Ctrl+C the Router or anything below it sends to its console stays there
// (tests/console-ctrl-c.test.ts). `detached` there would mean no console at all, and a
// child that then attaches to its parent's console would send straight into the service's.
export const rootSpawnOptions = (platform: NodeJS.Platform): { windowsHide: true; detached: boolean } => ({
  windowsHide: true,
  detached: platform !== 'win32',
});

// The marker travels in the environment (see service/procinfo.ts), so that the query's own
// command line never carries it. The search itself is the machine's (service/procinfo.ts);
// a test gives its own, to see what a query that cannot be made does here.
export function windowsProcessesWith(info: ProcInfo): Processes {
  return {
    async find(marker) {
      const pids = await info.tagged(marker);
      // A search that could not be made proves nothing about what is running: the caller
      // stops on this rather than reading it as "no such process".
      if (pids === undefined) throw new Error(`说不清有哪些进程带着标记 ${marker}：这台机器上读不到进程的命令行`);
      return pids;
    },
    // Killing a tree also kills the other matches, so "not found" is the normal
    // case for all but the first. The caller looks again for what is left.
    async kill(pid) {
      await run(TASKKILL, ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: PROCESS_COMMAND_MS }).catch(
        () => {},
      );
    },
  };
}

export const windowsProcesses: Processes = windowsProcessesWith(defaultProcInfo());

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  // Where the marker is looked for: the command line, and the environment where it can be read.
  text: string;
  // When it started, where the table says: with the pid, which process this is. A pid
  // alone comes to mean another process once the first is gone.
  born?: string;
}

// The marker stands alone or inside `mcp-<marker>.json`. An id that merely begins or
// ends with it belongs to someone else, hence the hyphen on the one side only.
const BEFORE = /[0-9A-Za-z_]/;
const AFTER = /[0-9A-Za-z_-]/;

export function carries(text: string, marker: string): boolean {
  if (marker === '') return false;
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
    const before = text[at - 1];
    const after = text[at + marker.length];
    if (!(before !== undefined && BEFORE.test(before)) && !(after !== undefined && AFTER.test(after))) return true;
  }
  return false;
}

// /proc as the search reads it: `names` is its listing, `read` takes "<pid>/stat".
export interface ProcFs {
  names(): Promise<string[]>;
  read(name: string): Promise<string>;
}

const realProc: ProcFs = {
  names: () => readdir('/proc'),
  read: (name) => readFile(`/proc/${name}`, 'utf8'),
};

// A process that ended since the listing, and one that is not ours to read. Any other
// failure says nothing about the process, and skipping it could hide a leftover.
const GONE = ['ENOENT', 'ESRCH'];
const DENIED = ['EACCES', 'EPERM'];

// For a read that may fail in these ways: the failure becomes undefined.
const unless = (codes: string[]) => (err: unknown): undefined => {
  if (!codes.includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
};

// After the command name, which may hold spaces and brackets: state, parent, group,
// and sixteen fields on, the start time.
const STAT_FIELDS = /^ \S (\d+) (\d+)(?: \S+){16} (\d+) /;

export async function procTable(fs: ProcFs = realProc): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = [];
  // One process at a time: a burst of opens could run into the limit on open files.
  for (const name of await fs.names()) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await fs.read(`${name}/stat`);
      const rest = stat.slice(stat.lastIndexOf(')') + 1);
      // Dead (X) and not yet out of the table, or ended and waiting to be collected (Z):
      // nothing of it runs. A dead one's line has -1 where its group was, so it is told
      // apart before the line is read as a process's.
      if (/^ [XxZ] /.test(rest)) continue;
      const fields = STAT_FIELDS.exec(rest);
      if (!fields) throw new Error(`/proc/${name}/stat 读不懂：${stat.slice(0, 200)}`);
      const [, ppid, pgid, born] = fields;
      const environ = (await fs.read(`${name}/environ`).catch(unless([...GONE, ...DENIED]))) ?? '';
      // Read last, so that it speaks for what was read before it. A process gives up
      // its memory before it leaves the table, and from then on this comes back empty:
      // nothing of it runs any more, whatever its state says. Listed without its marker
      // it would look like a live stranger. A kernel thread never had one.
      const cmdline = await fs.read(`${name}/cmdline`).catch(unless(DENIED));
      if (cmdline === '') continue;
      rows.push({ pid: Number(name), ppid: Number(ppid), pgid: Number(pgid), born, text: `${cmdline ?? ''}\0${environ}` });
    } catch (err) {
      unless([...GONE, ...DENIED])(err);
    }
  }
  return rows;
}

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;
// A zombie, and a process "trying to exit", as BSD ps marks them.
const PS_DEAD = /[ZE]/;

// Rows of `pid ppid pgid stat command`. An argument can hold line breaks, so a line
// that is not a row belongs to the command above it.
export function parsePs(stdout: string): ProcessRow[] {
  const rows: (ProcessRow & { stat: string })[] = [];
  const lines = stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const row = PS_ROW.exec(line);
    const last = rows.at(-1);
    if (row) {
      const [, pid, ppid, pgid, stat, text] = row;
      rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat: stat!, text: text! });
    } else if (last) {
      last.text += `\n${line}`;
    } else {
      throw new Error(`ps 的输出不是进程表：${line.slice(0, 200)}`);
    }
  }
  return rows.filter(({ stat }) => !PS_DEAD.test(stat)).map(({ pid, ppid, pgid, text }) => ({ pid, ppid, pgid, text }));
}

// macOS has no /proc. -ww: the whole command line. -E: the environment after it, for
// the processes this user may read. One -o per column: POSIX reads everything after a
// `=` as that column's heading, commas included.
const PS_ARGS = ['-axwwE', ...['pid', 'ppid', 'pgid', 'stat', 'command'].flatMap((column) => ['-o', `${column}=`])];

export async function psTable(): Promise<ProcessRow[]> {
  const { stdout } = await run('ps', PS_ARGS, { timeout: PROCESS_COMMAND_MS, maxBuffer: PS_BUFFER_BYTES });
  return parsePs(stdout);
}

type Signal = 'SIGTERM' | 'SIGKILL';

export interface PosixSystem {
  // Every running process.
  table(): Promise<ProcessRow[]>;
  // A negative target is a process group.
  signal(target: number, signal: Signal): void;
  sleep(ms: number): Promise<unknown>;
  // Milliseconds on a clock that only runs forward.
  now(): number;
  // This process: never found, never signalled.
  self: number;
}

interface KillTiming {
  // How long the tree has to end by itself after SIGTERM, before SIGKILL.
  termGraceMs: number;
  // How long to watch for the tree to go after SIGKILL.
  killWaitMs: number;
  pollMs: number;
}

const KILL_TIMING: KillTiming = { termGraceMs: 3000, killWaitMs: 2000, pollMs: 100 };

// The target is gone already, or it is no longer ours to signal. In the second case the
// caller's next look still finds it and stops there.
const SIGNAL_MISSED = ['ESRCH', 'EPERM'];

export function posixProcesses(system: PosixSystem, timing: Partial<KillTiming> = {}): Processes {
  const { termGraceMs, killWaitMs, pollMs } = { ...KILL_TIMING, ...timing };

  // Of the tree, what is running: the processes seen before, the members of the group,
  // and everything started by any of them, by the parent links as they stand.
  function running(rows: ProcessRow[], seen: Map<number, string | undefined>, group: number | undefined): ProcessRow[] {
    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    const found = new Map<number, ProcessRow>();
    const queue = rows.filter((row) => (seen.has(row.pid) && seen.get(row.pid) === row.born) || row.pgid === group);
    for (let row = queue.pop(); row; row = queue.pop()) {
      if (row.pid <= 1 || row.pid === system.self || found.has(row.pid)) continue;
      found.set(row.pid, row);
      queue.push(...(children.get(row.pid) ?? []));
    }
    return [...found.values()];
  }

  function send(signal: Signal, rows: ProcessRow[], group: number | undefined): void {
    const targets = rows.filter((row) => row.pgid !== group).map((row) => row.pid);
    if (group !== undefined && rows.some((row) => row.pgid === group)) targets.unshift(-group);
    for (const target of targets) {
      try {
        system.signal(target, signal);
      } catch (err) {
        if (!SIGNAL_MISSED.includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      }
    }
  }

  // The table with the target in it, or undefined when the target is gone. A pid can
  // come to mean another process: signalling on the strength of the number alone is how
  // a stranger gets killed, and saying nothing would pass a live Router off as gone. One
  // look can catch a process with nothing to show yet, or any more, hence the second.
  async function rooted(pid: number, marker: string): Promise<{ rows: ProcessRow[]; root: ProcessRow } | undefined> {
    for (const last of [false, true]) {
      const rows = await system.table();
      const root = rows.find((row) => row.pid === pid);
      if (!root) return undefined;
      if (carries(root.text, marker)) return { rows, root };
      if (!last) await system.sleep(pollMs);
    }
    throw new Error(`进程 ${pid} 不带标记 ${marker}，不发信号`);
  }

  return {
    async find(marker) {
      const rows = await system.table();
      return rows.filter((row) => row.pid !== system.self && carries(row.text, marker)).map((row) => row.pid);
    },

    async kill(pid, marker) {
      // 0 and negative numbers address process groups, and 1 is init.
      if (!Number.isInteger(pid) || pid <= 1 || pid === system.self) throw new Error(`不向 pid ${pid} 发信号`);
      const start = await rooted(pid, marker);
      if (!start) return;
      const { rows, root } = start;
      // The group is signalled whole only where the target leads it, which is what
      // rootSpawnOptions arranges: any other group has members that are not the tree's.
      const self = rows.find((row) => row.pid === system.self);
      const group = root.pgid === pid && self?.pgid !== pid ? pid : undefined;

      // What was seen once stays in: after the first signal a survivor may have no
      // living parent left to be reached through.
      const seen = new Map([[pid, root.born]]);
      let alive = running(rows, seen, group);
      for (const [signal, waitMs] of [['SIGTERM', termGraceMs], ['SIGKILL', killWaitMs]] as const) {
        send(signal, alive, group);
        // By the clock: on a machine with thousands of processes a look at the table
        // takes longer than the pause before it.
        for (const deadline = system.now() + waitMs; alive.length > 0 && system.now() < deadline; ) {
          for (const row of alive) seen.set(row.pid, row.born);
          await system.sleep(pollMs);
          alive = running(await system.table(), seen, group);
        }
        if (alive.length === 0) return;
      }
    },
  };
}

const posixSystem = (table: () => Promise<ProcessRow[]>): PosixSystem => ({
  table,
  signal: (target, signal) => void process.kill(target, signal),
  sleep,
  now: () => performance.now(),
  self: process.pid,
});

export const linuxProcesses = posixProcesses(posixSystem(procTable));
export const psProcesses = posixProcesses(posixSystem(psTable));

// Reported where it is used, so the service stays up to say why its Router does not.
function unsupported(platform: string): Processes {
  const refuse = (): never => {
    throw new Error(`这个系统（${platform}）上还不会查找和结束负责人进程，支持的是 Windows、Linux 和 macOS`);
  };
  return { find: async () => refuse(), kill: async () => refuse() };
}

export function selectProcesses(platform: NodeJS.Platform): Processes {
  if (platform === 'win32') return windowsProcesses;
  if (platform === 'linux') return linuxProcesses;
  return platform === 'darwin' ? psProcesses : unsupported(platform);
}

export const hostProcesses = selectProcesses(process.platform);
