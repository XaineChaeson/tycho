// One round's files on the machine that runs it (docs/design/nodes.md §4.2, §7). Two roots,
// because a shared data directory (a cluster instance's home) is shared on purpose in one
// part and not in the other:
//
//   <数据目录>/tasks/<task>/runs/<run>/         the round's own material, shared on purpose
//     started/          the gate: whoever makes this directory owns the start, once
//     exit              the Worker's exit code
//     stdout.ndjson, stderr.log, snapshot/, artifacts/
//   <数据目录>/nodes/<机器>/runs/<task>/<run>/   what only this machine can say
//     pid, at           the watch process: its pid, and when the system says it began
//     worker-pid, worker-at   the Worker itself, so a stop still has it after the watch died
//     left              what the watch found still running when it finished
//     stop              the owner revoked this start
//
// A pid and a moment mean nothing in another machine's process namespace (§7): they never
// sit beside the round's shared material, and a machine never reads another's. The gate and
// the round markers stay shared, which is what keeps them from being started twice.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { NodeState } from '../shared/node-protocol.ts';
import { machineId } from '../service/lock.ts';
import { subtree, type HostProcesses } from './hostprocess.ts';
import { readCodeCheck } from './code-check.ts';
import { readSourceHead } from './source-head.ts';

export type LeftBehind = 'none' | 'some' | 'unverified';

export interface RunBox {
  dataDir: string;
  // What the host called this round, stripped of the protocol's prefix: "tasks/<task>/runs/<run>".
  relative: string;
  // The round's own material: shared wherever the data directory is.
  runDir: string;
  // This machine's evidence about the round's processes. Never shared, never read by another.
  procDir: string;
  taskDir: string;
  taskId: string;
  runId: string;
}

// What this machine calls itself in the data directory's own tree. The same answer the
// service's lock uses (service/lock.ts): pids and evidence written here are this machine's
// and no other's, and a machine that cannot name itself gets one name to share.
export function machineScope(dataDir: string): string {
  const name = (machineId() ?? 'unnamed').replace(/[^\w.@-]/g, '_');
  return join(dataDir, 'nodes', name);
}

export function boxOf(dataDir: string, relative: string, machine: string = machineScope(dataDir)): RunBox {
  const clean = relative.replace(/^\.tycho\//, '').replace(/\\/g, '/');
  if (clean.includes('..') || !/^tasks\/[^/]+\/runs\/[^/]+$/.test(clean)) {
    throw new Error(`这一轮的路径不对：${relative}`);
  }
  const parts = clean.split('/');
  const runDir = join(dataDir, ...parts);
  return {
    dataDir,
    relative: clean,
    runDir,
    procDir: join(machine, 'runs', ...parts.slice(1)),
    taskDir: dirname(dirname(runDir)),
    taskId: parts[1]!,
    runId: basename(runDir),
  };
}

// The environment marker every process of a round carries, and that the watch's own
// command line spells out for the Windows scan (node/hostprocess.ts).
export const markerOf = (runId: string): string => `TYCHO_RUN=${runId}`;

// A record that is there and cannot be read, or reads as nothing its writer ever writes.
// Only a file that is not there means "not recorded"; anything else is something this
// machine cannot say, and saying "nothing" for it would settle a finished round as lost.
export class Unreadable extends Error {}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Unreadable(`读不出 ${basename(path)}：${(error as Error).message}`);
  }
};

const garbled = (path: string, text: string): Unreadable =>
  new Unreadable(`${basename(path)} 的内容不对：${JSON.stringify(text.slice(0, 40))}`);

// Whole or not at all: a half-written exit code would read as another code.
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, text);
  renameSync(partial, path);
}

export const gateTaken = (box: RunBox): boolean => existsSync(join(box.runDir, 'started'));

// False when somebody else holds the gate: then this round is not this process's to start.
// One `mkdir` without `recursive`: that is the atomic step, and a directory that is
// already there is another starter's.
export function takeGate(box: RunBox): boolean {
  mkdirSync(box.runDir, { recursive: true });
  try {
    mkdirSync(join(box.runDir, 'started'));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export interface ProcessEvidence {
  pid?: number;
  at?: string;
}

function writeEvidence(box: RunBox, name: string, pid: number, at: string | undefined): void {
  writeAtomic(join(box.procDir, `${name}-at`), `${at ?? ''}\n`);
  writeAtomic(join(box.procDir, `${name}-pid`), `${pid}\n`);
}

function readEvidence(box: RunBox, name: string): ProcessEvidence {
  const pidPath = join(box.procDir, `${name}-pid`);
  const text = readText(pidPath);
  const pid = text === null ? undefined : Number(text);
  if (text !== null && !(Number.isInteger(pid) && pid! > 0)) throw garbled(pidPath, text);
  const at = readText(join(box.procDir, `${name}-at`));
  return { ...(pid === undefined ? {} : { pid }), ...(at ? { at } : {}) };
}

export const writeWatchEvidence = (box: RunBox, pid: number, at: string | undefined): void => writeEvidence(box, 'watch', pid, at);
export const readWatchEvidence = (box: RunBox): ProcessEvidence => readEvidence(box, 'watch');
// The Worker's own pid and moment: the watch process can die while its Worker runs on, and
// this is what still proves whose that process is (nodes.md §4.3).
export const writeWorkerEvidence = (box: RunBox, pid: number, at: string | undefined): void => writeEvidence(box, 'worker', pid, at);
export const readWorkerEvidence = (box: RunBox): ProcessEvidence => readEvidence(box, 'worker');
// Whether the watch got as far as a Worker: any trace of its evidence, readable or not.
const workerStarted = (box: RunBox): boolean =>
  existsSync(join(box.procDir, 'worker-pid')) || existsSync(join(box.procDir, 'worker-at'));

export function readExit(box: RunBox): number | null {
  const path = join(box.runDir, 'exit');
  const text = readText(path);
  if (text === null) return null;
  if (!/^-?\d+$/.test(text)) throw garbled(path, text);
  return Number(text);
}

export const writeExit = (box: RunBox, code: number): void => writeAtomic(join(box.runDir, 'exit'), `${code}\n`);

export function readLeft(box: RunBox): LeftBehind | null {
  const path = join(box.procDir, 'left');
  const text = readText(path);
  if (text === null) return null;
  // `unknown` is what a version that recorded it this way wrote; it means the same as
  // `unverified`.
  if (text === 'unknown') return 'unverified';
  if (text === 'none' || text === 'some' || text === 'unverified') return text;
  throw garbled(path, text);
}

export const writeLeft = (box: RunBox, value: LeftBehind): void => writeAtomic(join(box.procDir, 'left'), `${value}\n`);

// The exit code of a round nothing was started in (node/watch.ts).
const NOTHING_STARTED_EXIT = 2;

// The watch's own word that the Worker never ran (its code would not unpack, or the system
// would not start it), with why. Written before the exit code and never by a round that got
// as far as a Worker: it is what lets the host count the round as one that did not start,
// which an exit code of 2 alone cannot say (a Worker may exit 2 itself). The file belongs to
// the same system user as the Worker, so this guards against misreading, not against a
// Worker set on lying: the machine itself is the boundary (nodes.md §4.2).
const NOT_STARTED_CHARS = 2_000;
export const writeNotStarted = (box: RunBox, reason: string): void => writeAtomic(join(box.procDir, 'not-started'), `${reason.slice(0, NOT_STARTED_CHARS)}\n`);
export function readNotStarted(box: RunBox): string | null {
  const text = readText(join(box.procDir, 'not-started'));
  return text === null || text === '' ? null : text;
}

export const stopRequested = (box: RunBox): boolean => existsSync(join(box.procDir, 'stop'));

// The revocation comes before anything is signalled: whatever the start does from here on,
// it sees it.
export function requestStop(box: RunBox): void {
  mkdirSync(box.procDir, { recursive: true });
  writeFileSync(join(box.procDir, 'stop'), '');
}

export const superseded = (box: RunBox): boolean => existsSync(join(box.procDir, 'superseded'));

export const markSuperseded = (box: RunBox): void => {
  mkdirSync(box.procDir, { recursive: true });
  writeFileSync(join(box.procDir, 'superseded'), '');
};

// The highest round marker of a Task, 0 when there is none. Markers are never removed
// while the Task has processes, so the highest is all a start or a watch reads.
export function highestRound(box: RunBox): number {
  let top = 0;
  try {
    for (const name of readdirSync(join(box.taskDir, 'rounds'))) {
      if (/^\d+$/.test(name)) top = Math.max(top, Number(name));
    }
  } catch {
    // No rounds directory yet: this round will make it.
  }
  return top;
}

// This round's own marker, then the highest: a later round starting at the same moment is
// seen by this read or, failing that, by the watch within ten seconds.
export function publishRound(box: RunBox, round: number): number {
  mkdirSync(join(box.taskDir, 'rounds'), { recursive: true });
  writeFileSync(join(box.taskDir, 'rounds', String(round)), '');
  return highestRound(box);
}

// Every round this data directory holds. `alive` is asked only where it is wanted: it
// costs a look at the process table.
export function listRuns(dataDir: string): { task_id: string; run_id: string; relative: string }[] {
  const tasks = join(dataDir, 'tasks');
  const found: { task_id: string; run_id: string; relative: string }[] = [];
  for (const taskId of safeReaddir(tasks)) {
    for (const runId of safeReaddir(join(tasks, taskId, 'runs'))) {
      found.push({ task_id: taskId, run_id: runId, relative: `tasks/${taskId}/runs/${runId}` });
    }
  }
  return found;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'));
  } catch {
    return [];
  }
}

// What a pid's number says about whose it is (nodes.md §4.3). A pid alone names nothing:
// once its process is gone the system hands the number to another one.
//   ours    — this machine holds it, and the moment it began is the one recorded;
//   gone    — nobody holds it, so the number has not been handed on, and what is below it
//             was this round's when it was written (that is how a Worker that outlived its
//             watch is found);
//   foreign — another process holds the number now: neither it nor its children are ours;
//   unsure  — a live process whose beginning cannot be read or was never recorded: nothing
//             about it can be proved, so nothing of it is touched.
type Holder = 'ours' | 'gone' | 'foreign' | 'unsure';

async function holderOf(procs: HostProcesses, pid: number, at: string | undefined): Promise<Holder> {
  if (!procs.alive(pid)) return 'gone';
  if (at === undefined || at === '') return 'unsure';
  const began = await procs.startOf(pid);
  if (began === undefined) return 'unsure';
  return began === at ? 'ours' : 'foreign';
}

interface RoundLook {
  // The round's own processes this machine can point at now: the watch and the Worker where
  // they are proved this round's, and everything found below or carrying its marker.
  live: number[];
  // The pids that lead a process group of the round's own: the watch, which the client
  // starts in one, and the Worker, which the watch starts in one. Everything else found is
  // a single process: a group number nobody can prove is not signalled.
  roots: number[];
  // A marked process outside those trees.
  marked: number[];
  // Why nothing can be said, when nothing was found and the machine could not look whole.
  blind: string | null;
}

const BLIND_TABLE = '这台机器上读不到进程表，说不清这一轮还有没有进程';
const BLIND_PID = (pid: number): string => `记下的进程号 ${pid} 现在已经属于别的程序，说不清这一轮还有没有进程`;
const BLIND_START = (pid: number): string => `读不到进程 ${pid} 的启动时刻，说不清这一轮还有没有进程`;
const BLIND_RECORD = (why: string): string => `这一轮的记录读不出来，说不清它还有没有进程、结束了没有：${why}`;

// The processes of one round, as this machine can see them right now. Both the state answer
// and a stop read the same look: a stop must end exactly what the look found, also when the
// watch process that started it is long gone.
export async function lookAtRound(box: RunBox, procs: HostProcesses): Promise<RoundLook> {
  // A record that cannot be read points at nothing, and leaves this look blind: what it
  // would have named may still be running.
  let blind: string | null = null;
  const evidence = (read: () => ProcessEvidence): ProcessEvidence => {
    try {
      return read();
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      blind ??= BLIND_RECORD(error.message);
      return {};
    }
  };
  const watch = evidence(() => readWatchEvidence(box));
  const worker = evidence(() => readWorkerEvidence(box));
  const watchHolder = watch.pid === undefined ? 'gone' : await holderOf(procs, watch.pid, watch.at);
  const workerHolder = worker.pid === undefined ? 'gone' : await holderOf(procs, worker.pid, worker.at);

  // Both subtrees come from one look at the table where the machine can read it whole: one
  // look is the same answer as two, and on Windows each look is a whole enumeration.
  const whole = procs.table === undefined ? undefined : await procs.table();

  // A pid that is ours, or one nobody holds any more, may speak for what is below it.
  const belowOf = new Set<number>();
  let readable = true;
  for (const [evidence, holder] of [[watch, watchHolder], [worker, workerHolder]] as const) {
    const pid = evidence.pid;
    if (pid === undefined) continue;
    if (holder === 'foreign' || holder === 'unsure') {
      blind ??= holder === 'foreign' ? BLIND_PID(pid) : BLIND_START(pid);
      continue;
    }
    const found = whole === undefined ? await procs.descendants(pid) : subtree(whole, pid);
    if (found === undefined) {
      readable = false;
      continue;
    }
    for (const each of found) if (each !== pid) belowOf.add(each);
  }
  const tagged = await procs.tagged(markerOf(box.runId));
  if (tagged === undefined) readable = false;

  const roots: number[] = [];
  const live = new Set<number>();
  if (watchHolder === 'ours' && watch.pid !== undefined) roots.push(watch.pid);
  if (workerHolder === 'ours' && worker.pid !== undefined) roots.push(worker.pid);
  for (const pid of roots) live.add(pid);
  for (const pid of belowOf) live.add(pid);
  const marked = (tagged ?? []).filter((pid) => !live.has(pid));
  const nothing = live.size === 0 && marked.length === 0;
  return { live: [...live], roots, marked, blind: nothing ? (blind ?? (readable ? null : BLIND_TABLE)) : null };
}

const hasProcesses = (state: NodeState): boolean => state.pid_alive || state.marked;

// Whether anything of a round is still there, as one answer: true, false, or null with why
// this machine cannot tell. Every command that acts on that question reads it here.
export function aliveOf(state: NodeState): { alive: boolean | null; unknown?: string } {
  if (hasProcesses(state) || state.launcher_alive) return { alive: true };
  return state.unknown === null ? { alive: false } : { alive: null, unknown: state.unknown };
}

// §4's table as this machine answers it. The ending is read only after the process itself
// has been looked at: the watch writes the code and then leaves, and a question that read
// the files first would answer "nothing is running" for a round that has just finished.
export async function runState(box: RunBox, procs: HostProcesses): Promise<NodeState> {
  try {
    return await stateOf(box, procs);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    // Neither "running" nor "over": a record that is there and cannot be read is said as
    // what it is, and the host keeps the round unknown (nodes.md §4.3).
    return { started: gateTaken(box), launcher_alive: false, pid_alive: false, marked: false, exit: null, unknown: BLIND_RECORD(error.message) };
  }
}

async function stateOf(box: RunBox, procs: HostProcesses): Promise<NodeState> {
  const started = gateTaken(box);
  if (!started) return { started: false, launcher_alive: false, pid_alive: false, marked: false, exit: readExit(box), unknown: null };

  const stop = stopRequested(box);
  // What the watch wrote last — its exit code and "nothing of the round was left" — answers
  // without a scan that may be refused, which is what a finished round on a locked-down
  // machine has to have. Nothing starts after the watch took the gate, so it stands.
  // An ending that cannot be read answers nothing by itself; the processes are still looked
  // at, and only when none is found does it make the answer "cannot tell".
  type Ending = { exit: number | null; left: LeftBehind | null; unreadable: string | null };
  const ending = (): Ending => {
    try {
      return { exit: readExit(box), left: readLeft(box), unreadable: null };
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      return { exit: null, left: null, unreadable: BLIND_RECORD(error.message) };
    }
  };
  const settled = (held: Ending): boolean => held.exit !== null && held.left === 'none';
  // "Nothing ran" counts only for a round that ended as one (code 2) and whose watch left
  // no trace of a Worker: a Worker that ran can write that file too, and once one was
  // started, what it may have written is never taken back on its own word.
  const over = (exit: number): NodeState => {
    const never = exit === NOTHING_STARTED_EXIT && !workerStarted(box) ? readNotStarted(box) : null;
    // A read-only round's code check and where this round's code stood, both written before the
    // exit code (node/code-check.ts, node/source-head.ts).
    const check = readCodeCheck(box);
    const head = readSourceHead(box);
    return {
      started: true, launcher_alive: false, pid_alive: false, marked: false, exit, unknown: null,
      ...(never === null ? {} : { not_started: never }), ...(check === null ? {} : { code_check: check }),
      ...(head === null ? {} : { source_head: head }),
    };
  };
  const first = ending();
  if (settled(first)) return over(first.exit!);

  const watch = readWatchEvidence(box);
  const watchHolder = watch.pid === undefined ? 'gone' : await holderOf(procs, watch.pid, watch.at);
  if (watchHolder === 'ours' || watchHolder === 'unsure') {
    // The process that owns this round is running — or one nobody can prove is somebody
    // else's holds its number. Nothing starts after the gate, so the round is not over, and
    // saying it is would be the answer that settles a live round as lost (nodes.md §4.3).
    return { started: true, launcher_alive: false, pid_alive: true, marked: false, exit: first.exit, unknown: null };
  }
  if (watch.pid === undefined) {
    // Between the gate and the pid there is a watch that has not registered yet, and nothing
    // can tell that from one that died there: it counts as alive, and the wall clock ends it.
    return { started: true, launcher_alive: !stop, pid_alive: false, marked: false, exit: first.exit, unknown: null };
  }

  // Whether anything survived the round is a question about the processes there are now, not
  // about the record the watch left: it may have been cleaned since (nodes.md §4.3). The
  // record is read again here, after the look, so that a watch which wrote its ending while
  // this question was being answered is still seen to have finished.
  const look = await lookAtRound(box, procs);
  const after = ending();
  if (settled(after)) return over(after.exit!);
  return {
    started: true,
    launcher_alive: false,
    pid_alive: look.live.length > 0,
    marked: look.marked.length > 0,
    exit: after.exit,
    unknown: look.blind ?? (look.live.length === 0 && look.marked.length === 0 ? after.unreadable : null),
  };
}

export interface Residue {
  left: LeftBehind;
  // What is still there, so that a caller that means to end the round can end exactly this.
  found: number[];
}

// What the watch found when it finished, as the record `runState` reads above. Where the
// machine cannot list processes, the round's own process group answers for the POSIX side;
// nothing answering at all is recorded as `unverified`, never as "nothing was left".
export async function residueOf(root: number, runId: string, procs: HostProcesses): Promise<Residue> {
  // Two independent questions — what is below this process, and what carries the round's
  // marker — so the round waits for the longer of the two and not for both. On Windows each
  // is a whole process-table enumeration of its own, and they do not read one another.
  const [tree, tagged] = await Promise.all([procs.descendants(root), procs.tagged(markerOf(runId))]);
  if (tree === undefined && tagged === undefined) {
    const group = procs.groupAlive?.(root);
    if (group === false) return { left: 'none', found: [] };
    if (group === true) return { left: 'some', found: [root] };
    return { left: 'unverified', found: [] };
  }
  const found = [...new Set([...(tree ?? []), ...(tagged ?? [])])].filter((pid) => pid !== root);
  return { left: found.length > 0 ? 'some' : 'none', found };
}

// Cleanup of a round the host is done with. Refused while the round still has processes:
// a half-removed round is worse than one left in place.
export async function dropRun(box: RunBox, procs: HostProcesses): Promise<void> {
  const state = await runState(box, procs);
  const { alive, unknown } = aliveOf(state);
  if (alive === true) throw new Error(`这一轮还有进程，不能清理：${box.runId}`);
  if (alive === null) throw new Error(`说不清这一轮还有没有进程，不能清理：${box.runId}（${unknown}）`);  rmSync(join(box.runDir, 'snapshot'), { recursive: true, force: true });
}

// Where one Task's directory is, as the host names it: "tasks/<task>" and nothing else. The
// same rule a round's path follows, refused rather than cleaned up when it can only come from
// outside.
export function taskDirRelative(relative: string): string {
  const clean = relative.replace(/^\.tycho\//, '').replace(/\\/g, '/');
  if (clean.includes('..') || !/^tasks\/[^/]+$/.test(clean)) throw new Error(`这个任务的路径不对：${relative}`);
  return clean;
}

// Remove this Task's code copies on this machine — one directory per source binding it ever
// worked from, `tasks/<task>/<binding_key>/` (plus the old `tasks/<task>/<source id>/` and
// `tasks/<task>/repo/`) — once the work it belongs to ended and its retention period passed
// (service/retention.ts). Refused while any
// round of the Task still has a process, or one this machine cannot speak for: a Task whose
// code is half removed is not told apart from one still working. The rounds' own records
// under runs/ and the round markers under rounds/ stay: they are history and marks, not a copy
// of the code. A Task that never cloned any code has nothing to remove, which is a success.
// A folder source is not a copy of tycho's and is never under this directory: nothing here
// reaches it.
export async function dropTaskCode(dataDir: string, relative: string, procs: HostProcesses): Promise<void> {
  const dir = taskDirRelative(relative);
  const taskDir = join(dataDir, ...dir.split('/'));
  for (const runId of safeReaddir(join(taskDir, 'runs'))) {
    const box = boxOf(dataDir, `${dir}/runs/${runId}`);
    const { alive, unknown } = aliveOf(await runState(box, procs));
    if (alive === true) throw new Error(`这个任务还有一轮有进程，不能清理：${runId}`);
    if (alive === null) throw new Error(`说不清这个任务还有没有进程，不能清理：${runId}（${unknown}）`);
  }
  for (const name of safeReaddir(taskDir)) {
    if (name === 'runs' || name === 'rounds') continue;
    const at = join(taskDir, name);
    if (statSync(at, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    rmSync(at, { recursive: true, force: true });
  }
}
