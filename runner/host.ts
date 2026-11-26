// What the Runner asks of a machine, as a closed set (docs/design/nodes.md §4.1). Every
// call is one of the seven the client understands; nothing here takes a script path or an
// arbitrary command. The rules that judge, settle and continue a Run are the Runner's and
// are the same whatever answers them.
//
// A run directory is spelled relative to the client's data directory, with the prefix the
// protocol has always carried (".tycho/tasks/<task>/runs/<run>"); the client resolves it
// under its own data directory (nodes.md §7). The Runner never learns where that is.
import type {CaptureRange,ResultRange} from '../shared/node-output.ts';
import type { NodeExecutorReport, NodeSourceHead } from '../shared/node-protocol.ts';
import type { CodeCheck } from '../shared/roles.ts';
import type { CredentialWay } from '../adapters/types.ts';

export class Unreachable extends Error {
  override name = 'Unreachable';
}

// The machine answered and its answer was a failure that is not about being away: it could
// not read what it was asked for (a process table it may not read, a listing it could not
// build). It is told apart from Unreachable because the two callers treat it differently:
// housekeeping logs it, an inventory reports it, and neither may read it as "the machine
// has gone" — that would judge a Run from a question nobody answered.
export class ListingFailed extends Error {
  override name = 'ListingFailed';
}

// The machine answered about a round and its answer is that it cannot tell whether anything
// of it is left, with why. Not Unreachable: no stretch out of contact begins and no grace
// period judges it; the round stays unknown, with these words, until a look can say.
export class Unverifiable extends Error {
  override name = 'Unverifiable';
}

// Where a round's files live, as the protocol spells it. A node client resolves it under its
// own data directory (docs/design/nodes.md §7), which is the only place that knows where that is.
export const runDirOf = (taskId: string, runId: string): string => `.tycho/tasks/${taskId}/runs/${runId}`;

export interface Range {
  bytes: Buffer;
  // Size and mtime (seconds) of the remote file now; 0 when it does not exist.
  size: number;
  mtime: number;
}

// One file of a snapshot as the machine reported writing it. The host compares the hash
// with the bytes it sent (nodes.md §6, the last line of the table); `bytes` is what the
// machine wrote.
export interface PlacedFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface StartRequest {
  source?:string;
  runDir: string;
  taskId: string;
  runId: string;
  // Which round of its Task this is, from 1.
  round: number;
  argv: string[];
  env: Record<string, string>;
  // How the Worker is handed the account's login (the executor's own declaration); null for a
  // machine's own login. The secret itself is never in the command: the machine fetches it
  // over its own channel when it starts the round (nodes.md §9).
  credential: CredentialWay | null;
  // Whether this round's task has an open quota for spawning machines (nodes.md §1.3). The
  // machine fetches the one-time join materials itself when it starts the round, so the
  // material's clock starts when it is in hand; nothing is minted here.
  invite?: boolean;
  // How long this round may run. The Runner's own clock ends it too; a transport whose
  // machine has a process of its own can hand this over as a local backstop (nodes.md §4.2).
  timeoutMs?: number;
  modelIdleTimeoutMs?: number;
}

export interface StartedRound {
  // The start's own codes: 0 started, 2 nothing was started, 3 the gate was already taken,
  // 4 a stop overtook it, 6 a later round of the Task holds the instance.
  code: number;
  stdout: string;
  // With 2: why, in the machine's words, when it knew before it tried.
  stderr: string;
  pid?: number;
  startedAt?: string;
  // Code 0 without this says the process was started and its own evidence (pid and the
  // moment it began) was not read back before the answer. The gate is still this round's,
  // and the next question is a state question — never a reason to start anything again.
  confirmed?: boolean;
}

export interface RunOnMachine {
  task_id: string;
  run_id: string;
}

// One file a round left under its own artifacts/, as the machine listed it.
export interface ArtifactOnMachine {
  name: string;
  sha256: string;
  bytes: number;
}

// §4's table, as one machine answers it. `unknown` non-null says this answer cannot be
// trusted about processes: the Run is then unknown, never ended.
export interface RemoteState {
  started: boolean;
  launcher_alive: boolean;
  pid_alive: boolean;
  marked: boolean;
  exit: number | null;
  unknown?: string | null;
  // The machine's evidence that no Worker of this round ever ran (node/runbox.ts).
  not_started?: string;
  // A read-only round's code check, as the machine's watch wrote it (node/code-check.ts).
  code_check?: CodeCheck;
  // Where this round's code stood, as its machine read it when the round was over (docs/design/
  // code-sources.md §8 第 4、6 条): the remote branch head of a repository round, a folder's
  // HEAD, and the HEAD the round began from. A review is bound to these, and the Task's start
  // is its first round's. Absent: the machine reported none.
  source_head?: NodeSourceHead;
}

// What a machine that came back by itself says about the executors on it, and whether that
// answer is from just now (docs/design/nodes.md §1.2, §11 step 5). The client looks at its
// own machine and reports; a host that cannot ask it says so, and hands back what it last
// heard rather than nothing.
export interface ExecutorsAnswer {
  // Whether the machine's client is here right now.
  connected: boolean;
  // What it reported, fresh or not. Null: it has never reported.
  report: NodeExecutorReport | null;
  // Whether `report` was read just now, by asking this machine to look again.
  fresh: boolean;
  // Why it could not be asked, when it could not.
  problem?: string;
}

export interface RemoteHost {
  readCapture?(request:{run_dir:string;source:string;stream:'stdout'|'stderr';offset:number;bytes:number}):Promise<CaptureRange>;
  readResult?(request:{run_dir:string;source:string;offset:number;bytes:number}):Promise<ResultRange>;
  // Write this round's snapshot on the machine and report what was written. Placing a
  // snapshot is not starting: a machine that fails here has started nothing.
  place(runDir: string, localDir: string): Promise<PlacedFile[]>;
  start(request: StartRequest): Promise<StartedRound>;
  // Revoke the start, take the gate, end the round's own processes. Throws Unreachable
  // when the machine cannot say that nothing is left, which proves nothing either way.
  stop(runDir: string): Promise<void>;
  state(runDir: string): Promise<RemoteState>;
  list(options: { aliveOnly: boolean }): Promise<RunOnMachine[]>;
  readRange(path: string, offset: number, options?: { fileLimitBytes: number }): Promise<Range>;
  // What this round left under its own artifacts/, with the hash of each file.
  artifacts(runDir: string): Promise<ArtifactOnMachine[]>;
  // Drop what this round staged on the machine; refused while it still has processes.
  dropRun(runDir: string): Promise<void>;
  // Whether a client for this machine is connected right now.
  connected(): boolean;
}
