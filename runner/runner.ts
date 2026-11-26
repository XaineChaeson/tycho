import {captureOf} from '../service/capture-result.ts';
import {readCaptureResult} from './capture-result.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { executorCheckTimeoutMs, MODEL_LIST_TIMEOUT_MS } from '../node/executors.ts';
import type { Adapter, Launch, NormalizedEvent, Reading, Turn } from '../adapters/types.ts';
import { DegradedError, InputError } from '../service/errors.ts';
import { revisionSet } from '../service/knowledge.ts';
import type { Ctx, Ledger, Receipt, RunRow, SettleOptions, UnknownCause } from '../service/ledger.ts';
import { loginRefused, neverStarted, unconfirmedSince, unknownFrom, unreachableSince, workerNeverRan } from '../service/ledger.ts';
import type { ReleaseFile } from '../service/releases.ts';
import { ARTIFACT_NAME_RULE, artifactNameIsUsable, sameBytes } from '../service/releases.ts';
import type { ArtifactOnMachine, ExecutorsAnswer, RemoteHost, RemoteState } from './host.ts';
import { bounded } from './display.ts';
import { ListingFailed, Unreachable, Unverifiable, runDirOf } from './host.ts';
import type { Snapshot, SnapshotFile, Login, LoginStore, Machine, MachineStore } from './snapshot.ts';
import { hider } from './redact.ts';
import { sameConfig, loginConfig, machineConfig, eligibleMachines, machineInputsHere, runMachineUid, runOnMachine, roundTurn, tierFor, writeSnapshot } from './snapshot.ts';
import type { Reported } from '../service/readonly.ts';
import { loginName } from '../shared/logins.ts';
import type { SnapshotSource } from '../shared/sources.ts';
import type { NodeEntryReport } from '../shared/node-protocol.ts';
import { prepareOwnerOnlyDirectory } from '../service/secrets.ts';
import { redactWorkerDiagnosticText } from '../service/router-call-text.ts';
const REPORT_RECOVERY_BYTES = 8 * 1024 * 1024;
import { DEFAULT_DIAGNOSTIC_POLICY, diagnosticSource, HISTORY_EVENT_BYTES, pruneCheckpoints, readCheckpoint, writeCheckpoint } from './diagnostic-history.ts';
import type { DiagnosticCheckpoint, DiagnosticPolicy } from './diagnostic-history.ts';

export type { RemoteState } from './host.ts';

const RUNNER: Ctx = { actor: 'runner' };
// The rhythms below (how often a Run is looked at, how long a machine that failed rests,
// how fresh an answer stands for a probe, how often leftovers are swept) are constants:
// they are how promptly the service notices things, not behaviour the owner tunes. What
// the owner does tune (time limits, grace periods, sizes) is in service/settings.ts.
const DEFAULT_POLL_MS = 5000;
const TIMEOUT_REASON = '超时';
const INTERRUPTED_REASON = '已中断';
// A start's own code: nothing was started.
const NOT_STARTED = 2;
const GATE_TAKEN = 3;
const START_REVOKED = 4;
// A start's own code: the instance already holds a later round of the Task.
const START_SUPERSEDED = 6;
// In `exit`, from the start or from the watch beside the Worker, for the same reason.
const SUPERSEDED_EXIT = 86;

// Read to see whether a machine answers; it need not exist.
const PROBE_PATH = '.tycho/probe';
// The owner is waiting on a page for a connection test: one wait for a machine to answer.
export const CHECK_TIMEOUT_MS = executorCheckTimeoutMs(MODEL_LIST_TIMEOUT_MS);
const CHECK_OUTPUT_CHARS = 200;
// One block is one readRange. A poll stops here so that a fast writer cannot
// hold the queue the stop and the clock are waiting in.
const BLOCKS_PER_POLL = 2;
const NEWLINE = 0x0a;
const MAX_RAW_DIAGNOSTIC_LINE = 4 * 1024 * 1024;
const DEFAULT_DIAGNOSTIC_RETENTION_MS = 7 * 86_400_000;
const DIAGNOSTIC_BACKLOG = '还有 Worker 诊断输出待同步，重新打开现场可以继续读取。';
const DIAGNOSTIC_SOURCE_LOST = 'Worker 原始输出缩短或被替换，只保留了主机已收到的诊断。';
const DIAGNOSTIC_CREDENTIAL_LOST = '这一轮使用的旧凭据已无法确认，后续原始输出未导入。';
const DIAGNOSTIC_REGISTRATION_GONE = '这一轮的原节点登记已不存在，后续 Worker 诊断未导入。';

export type Verdict = 'waiting' | 'running' | 'lost' | 'ended' | 'unknown';

// What one host holds that the ledger does not know. `runs` is null when it could
// not be counted, which says nothing about what is out there.
export interface OrphanReport {
  machine_id: string;
  host: string;
  runs: { task_id: string; run_id: string; alive: boolean }[] | null;
  error?: string;
}

// What is known about one machine a login may use, from the calls made to it.
export interface MachineFact {
  login_id: string;
  machine_id: string;
  host: string;
  // Null until this process has tried to reach it.
  up: boolean | null;
  last_ok_at: string | null;
  active_runs: number;
}

// One machine's answer to a connection test.
export interface MachineCheck {
  machine_id: string;
  host: string;
  reachable: boolean;
  // Why not, or what the machine said in place of a version.
  error?: string;
  // The last line the executor's command prints for --version; null when it has none.
  version: string | null;
  // Null when the executor cannot say without a whole turn, or the machine did not answer.
  logged_in: boolean | null;
}

export interface RunnerOptions {
  ledger: Ledger;
  adapters: Record<string, Adapter>;
  logins: LoginStore;
  machines: MachineStore;
  // How a machine is reached: its client, over the node channel (runner/node-channel.ts).
  // `timeoutMs` bounds every call to the machine; absent means the transport's own limit.
  connect: (target: Machine, options?: { timeoutMs?: number }) => RemoteHost;
  // What a machine says about the executors on it, asked now when it can be asked
  // (nodes.md §1.2, §11 step 5). Absent when the service has no node channel, and then a
  // machine cannot be asked at all.
  executors?: (machineId: string, timeoutMs: number) => Promise<ExecutorsAnswer>;
  // How long a connection test waits for one machine.
  checkTimeoutMs?: number | (() => number);
  // An account's token for an executor that takes one, with the number the ledger names
  // it by; nothing for a machine's own login. Read only at the point of use; never part of
  // a Run or a remote file.
  credential?: (loginId: string) => { ref: string; value: string } | undefined;
  // Current host-managed GitHub token, if connected. Read when hiding round output so a
  // Worker echoing GH_TOKEN / GITHUB_TOKEN / TYCHO_GITHUB_TOKEN never leaks it into logs,
  // live events, receipts, or reports.
  githubToken?: () => string | null;
  // Machines a task may spawn (nodes.md §1.3): whether a task has an open quota. The
  // materials themselves are minted when the machine fetches them, never here.
  invite?: { open(taskId: string): boolean };
  // How long a Run may stay out of contact before it is judged gone. Read when used.
  lostGraceMs: () => number;
  // The settings machine.cooldownMs, machine.probeFreshMs and machine.sweepMs, read when used:
  // how long a machine that did not answer is left alone, how recent an answer spares the
  // probe before a start, and how often a machine is swept of what has ended.
  cooldownMs: () => number;
  probeFreshMs: () => number;
  sweepMs: () => number;
  // What the host is willing to take from one Run's artifacts, per file and in all: the
  // settings artifacts.fileLimitMb and artifacts.totalLimitMb, read at each fetch. Past
  // them a file is reported rather than held in memory.
  artifactFileLimitBytes: () => number;
  // How much of each text of a tool call (output, input, reason, patch) a page keeps: the
  // setting site.outputLimitKb, read as each line is read.
  displayTextBytes: () => number;
  diagnosticsDir?: string;
  diagnosticsRetentionMs?: () => number;
  // Current per-Run retained suffix, separate from the fixed raw-line/parser envelopes.
  diagnosticsPolicy?: () => DiagnosticPolicy;
  // Registered evidence needed by a review, prepared for this round's own snapshot.
  reviewFiles?: (run: RunRow) => readonly SnapshotFile[];
  artifactsLimitBytes: () => number;
  // Whether this machine's client is refusing to speak to this host, because the two are of
  // different protocol versions (nodes.md §5.3). A refusal is not "the machine has gone":
  // nothing is judged lost and nothing is continued while that is what it says.
  refusesProtocol?: (machineId: string) => boolean;
  // The wall clock: what the ledger's times are in, and all a restart has to go by.
  now?: () => number;
  // Counts time passing and nothing else. Whatever this process saw begin is timed by
  // it, so that a wall clock set forward or back changes no judgment.
  monotonic?: () => number;
  log?: (line: string) => void;
  // Whether a machine can take a new round of this executor — read-only or not — by what it
  // last reported of itself (service/readonly.ts). Asked only when a round that never started
  // moves to another machine. Absent: none takes a read-only round.
  fits?: (machineId: string, executor: string, readOnly: boolean, account: boolean) => boolean;
  // New-work admission, separate from executor facts used by check. The service supplies
  // this explicitly; older injected callers may already admit the candidates themselves.
  outputReady?: (machineId: string) => boolean;
  // What a machine last reported of one of its executors, or null: a round moved there before it
  // started is recorded and started with what it may read on that machine.
  reported?: Reported;
  reportedEntry?: (machineId: string) => NodeEntryReport | null;
  externalEntryEnabled?: () => boolean;
  // Invoked asynchronously after a Run settles cleanly (receipt present or exitCode === 0)
  // so the host can pull visual deliverables without blocking settlement.
  onRunSettled?: (run: RunRow, receipt: Receipt | null) => void | Promise<void>;
}

// What this process has seen of one machine, timed by the monotonic clock. Not kept
// across restarts: a restart learns it again from its first contact.
interface Contact {
  up?: boolean;
  // Whether okAt is a time at all: the clock may read 0.
  answered: boolean;
  okAt: number;
  failedAt: number;
  sweptAt?: number;
  // Answered again after failing to: whatever the ledger ended meanwhile is cleared.
  returned: boolean;
  sweeping: boolean;
}

type TailListener = (event: NormalizedEvent, index: number) => void;

interface TailState {
  offset: number;
  captureDiscard?:boolean;
  discardOversize?:boolean;
  // Bytes, not text: a chunk can end inside a line or inside a character.
  partial: Buffer[];
  partialBytes: number;
  size: number;
  mtime: number;
  // Once anything is dropped, the first entry is the mark that says so.
  events: NormalizedEvent[];
  dropped: number;
  listeners: Set<TailListener>;
  history?: {
    source: string;
    sizes: number[];
    bytes: number;
    discarding: boolean;
    sourceLost: boolean;
    finished: boolean;
    dirty: boolean;
    issue?: string;
  };
}

interface EventSnapshot {
  events: readonly NormalizedEvent[];
  firstIndex: number;
  loaded: boolean;
  reason?: string;
}

// The two waits an unknown Run can be in: each began at some moment and ends with the
// grace period.
type Wait = Extract<UnknownCause, 'unreachable' | 'unconfirmed'>;

const hasProcesses = (state: RemoteState): boolean => state.pid_alive || state.marked;

// §4's table. `exit` ends a Run with a live group only when nobody asked it to
// stop: the wrapper wrote it after the Worker ended, so what is left is a
// background process, which verify clears before settling. A stop must see the
// group gone, whatever `exit` says. A machine that could not read the process table
// answers nothing anybody can act on, so the Run is unknown (nodes.md §4.3).
export function judge(state: RemoteState | null, stopIntent: boolean): Verdict {
  if (!state?.started) return 'unknown';
  if (state.unknown) return 'unknown';
  if (state.exit !== null) return hasProcesses(state) && stopIntent ? 'running' : 'ended';
  if (state.pid_alive) return 'running';
  if (state.launcher_alive) return 'waiting';
  // A marked process outside the group: the launcher died after spawning it, or the
  // wrapper is gone and something it left behind is not.
  if (state.marked) return 'running';
  return stopIntent ? 'ended' : 'lost';
}

const RECEIPT_OPEN_RE = /```receipt[^\S\n]*\r?\n/g;
const JSON_OPEN_RE = /```json[^\S\n]*\r?\n/g;
const FALLBACK_RECEIPT_STATUSES = new Set([
  'done',
  'waiting',
  'failed',
  'need_input',
  'blocked',
  'wait_timer',
]);

function lastFencedBlock(text: string, openPattern: RegExp): { found: boolean; block?: string } {
  let lastEnd = -1;
  for (const match of text.matchAll(openPattern)) {
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd < 0) return { found: false };
  const close = text.slice(lastEnd).match(/^([\s\S]*?)\r?\n?```/);
  return close ? { found: true, block: close[1] } : { found: true };
}

function parseJsonObject(block: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(block);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// The last block only: the message may show a receipt before writing its own,
// and trailing prose/emoji after a closed fence must not invalidate the receipt.
export function parseReceipt(text: string | undefined): Receipt | null {
  if (text === undefined) return null;
  const receiptFence = lastFencedBlock(text, RECEIPT_OPEN_RE);
  if (receiptFence.found) {
    if (receiptFence.block === undefined) return null;
    return parseJsonObject(receiptFence.block) as Receipt | null;
  }
  const jsonFence = lastFencedBlock(text, JSON_OPEN_RE);
  if (jsonFence.block === undefined) return null;
  const parsed = parseJsonObject(jsonFence.block);
  if (parsed === null || typeof parsed.status !== 'string' || !FALLBACK_RECEIPT_STATUSES.has(parsed.status)) {
    return null;
  }
  return parsed as unknown as Receipt;
}

// What any transport handed over, checked once whichever way it came: a name that breaks
// the artifact name rule is not taken, and a listing that names a file twice or gives a
// size no file has cannot be trusted whole. Names that differ only in case are one file on
// a host whose disk ignores case, so they are refused on every host.
function checkArtifacts(listed: readonly ArtifactOnMachine[]): { files: ArtifactOnMachine[]; problem: string | null } {
  const seen = new Map<string, string>();
  for (const { name, bytes } of listed) {
    if (!artifactNameIsUsable(name)) return { files: [], problem: `产物清单里的文件名不能用：${name}。${ARTIFACT_NAME_RULE}` };
    const key = name.toLowerCase();
    const before = seen.get(key);
    if (before === name) return { files: [], problem: `产物清单损坏：${name} 列了两次` };
    if (before !== undefined) return { files: [], problem: `产物清单里 ${before} 和 ${name} 在主机上会是同一个文件（主机的磁盘可能不分大小写），整份不取` };
    if (!Number.isSafeInteger(bytes) || bytes < 0) return { files: [], problem: `产物清单损坏：${name} 的大小不对：${bytes}` };
    seen.set(key, name);
  }
  return { files: listed.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })), problem: null };
}

function failureReason(reading: Reading): string | undefined {
  const error = reading.error;
  if (!error) return undefined;
  // A used-up quota or a refused login is settled as what it is, not as a failure: these
  // words only show where something else decided how the Run ended.
  if (error.kind === 'quota') return `额度用完：${error.message}`;
  return error.kind === 'other' ? error.message : `登录失效：${error.message}`;
}

function snapshotOf(run: RunRow): Snapshot {
  return JSON.parse(run.snapshot_json) as Snapshot;
}

function runDir(run: RunRow): string {
  return runDirOf(run.task_id, run.id);
}


function hasStopIntent(run: RunRow): boolean {
  return run.state === 'stopping' || unknownFrom(run) === 'stopping';
}

export class HistoryLoadError extends Error {
  override name = 'HistoryLoadError';
}

export function createRunner(options: RunnerOptions) {
  const { ledger, adapters, logins, machines } = options;
  const connect = options.connect;
  const checkTimeoutMs = () => typeof options.checkTimeoutMs === 'function' ? options.checkTimeoutMs() : (options.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
  const graceMs = options.lostGraceMs;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const log = options.log ?? ((line: string) => console.error(line));
  const diagnosticsDir = options.diagnosticsDir;
  const diagnosticsRetentionMs = options.diagnosticsRetentionMs ?? (() => DEFAULT_DIAGNOSTIC_RETENTION_MS);
  const diagnosticsPolicy = options.diagnosticsPolicy ?? (() => DEFAULT_DIAGNOSTIC_POLICY);
  const writingDiagnostics = new Set<string>();
  let diagnosticsReady = false;
  const contacts = new Map<string, Contact>();
  // The waits of unknown Runs that this process saw begin, as "<cause> <run id>", with
  // the monotonic time they began at.
  const begun = new Map<string, number>();
  const tails = new Map<string, TailState>();
  // In memory only: a restart in the middle of a timeout stop settles as a plain
  // interrupt, which loses the word "timeout" and nothing else.
  const stopReasons = new Map<string, string>();
  const queues = new Map<string, Promise<unknown>>();

  // verify, tail and interrupt share round trips to the machine and could otherwise
  // settle the same Run twice from overlapping polls.
  function serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(runId) ?? Promise.resolve()).then(fn, fn);
    queues.set(runId, next.catch(() => {}));
    return next;
  }

  function loginOf(run: RunRow): Login {
    const login = run.login_id === null ? undefined : logins.get(run.login_id);
    if (!login) throw new InputError(`${loginName(run.login_name ?? '已删除的登录')} 已经不在了`);
    return login;
  }

  // The machine a Run is bound to, by the name it was placed on. Whether that is still the
  // same machine is samePlace's question: a name can come back as another machine.
  function machineOf(run: RunRow): Machine | undefined {
    return run.machine_id === null ? undefined : machines.get(run.machine_id);
  }

  // Where this Run is: the machine it was placed on, while that is still the machine its
  // node identity says (nodes.md §7, §9).
  function siteOf(run: RunRow): Machine {
    const machine = machineOf(run);
    if (!machine || !samePlace(run, machine)) throw new Unreachable(`这一轮所在的机器已经不在了：${run.machine_id ?? run.host}`);
    return machine;
  }

  // Where the Run's Task may go now; null when nowhere (a knowledge Task whose projects share no machine).
  function rangeOf(run: RunRow): { allowed: string[]; projectId: string | null } | null {
    const range = ledger.machineRange(ledger.getTask(run.task_id));
    return 'conflict' in range ? null : range;
  }

  // The source this round was told to use, from its own snapshot (docs/design/code-sources.md
  // §8.11): the source a Task is pinned to decides what its later rounds work on, whatever the
  // project's list says since.
  function sourceOf(run: RunRow): SnapshotSource | undefined {
    try {
      return (JSON.parse(run.snapshot_json) as { source?: SnapshotSource }).source;
    } catch {
      // A snapshot nobody can read holds no source to be fixed to.
      return undefined;
    }
  }

  // Whether two of a Task's rounds name the same source binding: the identity the host prepared
  // each round with (shared/sources.ts bindingKey). The commit a review round names is not part
  // of that — a review works in a checkout of its own and leaves nothing on any machine.
  function sameSourceName(a: SnapshotSource | undefined, b: SnapshotSource | undefined): boolean {
    return a !== undefined && b !== undefined && a.binding_key === b.binding_key;
  }

  // The earlier round of this Task that already worked on the source this Run was told to use:
  // its machine is where the work of that source is. Undefined while this Run is the first one
  // of the source — then nothing is on any machine yet, and this round may go wherever one
  // answers (§2). The Run being judged is not counted: it is the one asking.
  function sourceRound(run: RunRow): RunRow | undefined {
    const source = sourceOf(run);
    return ledger.listRuns(run.task_id).find((earlier) =>
      earlier.id !== run.id && earlier.machine_id !== null && !neverStarted(earlier) && !workerNeverRan(earlier) && sameSourceName(sourceOf(earlier), source));
  }

  // Whether the source fixes this Run to the machine it is on, so that neither the project's
  // machine list nor a failed upload may move it: a folder source names its machine outright
  // (the owner named it, and the project's list does not narrow it, §2), and a repository round
  // after the source's first one has its checkout on the machine that first round ran on.
  function sourceFixesMachine(run: RunRow): boolean {
    const source = sourceOf(run);
    if (source === undefined) return false;
    return source.kind === 'folder' || sourceRound(run) !== undefined;
  }

  function availableTo(login: Login, run: RunRow): Machine[] {
    const range = rangeOf(run);
    return range === null ? [] : eligibleMachines(login, range.allowed, machines, range.projectId);
  }

  // Whether the machine a Run is bound to is still that machine: the same node identity. It
  // says nothing of the login the round ran as.
  function samePlace(run: RunRow, machine: Machine): boolean {
    return runOnMachine(run, machine);
  }

  // Where a round's history is read from: its own machine, as long as that is still the
  // place it ran. Whether the login it ran as is still a login, or still allowed there,
  // decides whether work may go on — not whether what was done can be read.
  function placeStands(run: RunRow): boolean {
    const machine = machineOf(run);
    return machine !== undefined && samePlace(run, machine);
  }

  function standing(run: RunRow): 'ok' | 'removed' | 'unknown' {
    const login = run.login_id === null ? undefined : logins.get(run.login_id);
    if (!login) return ledger.loginWasDeleted(run.login_id) ? 'removed' : 'unknown';
    const machine = machineOf(run);
    if (!machine) return 'removed';
    if (runMachineUid(run) === undefined) return 'unknown';
    // A source that names its own machine (a folder), or one whose checkout is already on a
    // machine (a repository's later rounds), is judged by the machine itself: the project's
    // list must not read the machine the owner named as a machine removed (docs/design/
    // code-sources.md §2). Any other round is judged by where its Task may go.
    if (!sourceFixesMachine(run) && !availableTo(login, run).some(({ id }) => id === machine.id)) return 'removed';
    return samePlace(run, machine) ? 'ok' : 'removed';
  }

  // A probe or upload cannot authorize a start under subsequently changed inputs. A round
  // is started only on the login its snapshot recorded, as that login still is: one made
  // before logins were recorded is not started at all — it never was, and it is placed again.
  function startAllowed(run: RunRow): boolean {
    if (standing(run) !== 'ok') return false;
    const login = loginOf(run);
    const machine = machineOf(run)!;
    const recorded = snapshotOf(run);
    if (login.credential === 'missing') return false;
    if (loginRefused(ledger.loginState(login.id), recorded.credential_ref ?? null)) return false;
    if (!recorded.login || !sameConfig(recorded.login, loginConfig(login))) return false;
    if (!recorded.machine || !sameConfig(recorded.machine, machineConfig(machine))) return false;
    return true;
  }

  // One machine, one key: the identity its client made. The name alone is not one.
  const machineKey = (target: Machine): string => target.uid ?? '';

  const runMachineKey = (run: RunRow): string => runMachineUid(run) ?? '';

  function contactOf(target: Machine): Contact {
    const key = machineKey(target);
    let contact = contacts.get(key);
    if (!contact) {
      contact = { answered: false, okAt: 0, failedAt: 0, returned: false, sweeping: false };
      contacts.set(key, contact);
    }
    return contact;
  }

  // Every call to a machine goes through here, so what is known about reaching it
  // comes from the calls themselves and not from a separate heartbeat.
  function reach(target: Machine, timeoutMs?: number): RemoteHost {
    const host = connect(target, timeoutMs === undefined ? undefined : { timeoutMs });
    const contact = contactOf(target);
    async function noted<T>(call: () => Promise<T>): Promise<T> {
      try {
        const value = await call();
        if (contact.up === false) contact.returned = true;
        contact.up = true;
        contact.answered = true;
        contact.okAt = monotonic();
        return value;
      } catch (err) {
        if (err instanceof Unreachable) {
          contact.up = false;
          contact.failedAt = monotonic();
        }
        throw err;
      }
    }
    return {
      place: (runDir, localDir) => noted(() => host.place(runDir, localDir)),
      ...(host.readCapture?{readCapture:(request:Parameters<NonNullable<RemoteHost['readCapture']>>[0])=>noted(()=>host.readCapture!(request))}:{}),
      ...(host.readResult?{readResult:(request:Parameters<NonNullable<RemoteHost['readResult']>>[0])=>noted(()=>host.readResult!(request))}:{}),
      start: (request) => noted(() => host.start(request)),
      stop: (runDir) => noted(() => host.stop(runDir)),
      state: (runDir) => noted(() => host.state(runDir)),
      list: (asking) => noted(() => host.list(asking)),
      readRange: (remotePath, offset, options) => noted(() => host.readRange(remotePath, offset, options)),
      artifacts: (runDir) => noted(() => host.artifacts(runDir)),
      dropRun: (runDir) => noted(() => host.dropRun(runDir)),
      connected: () => host.connected(),
    };
  }

  const hostOf = (run: RunRow): RemoteHost => reach(siteOf(run));

  const sinceOf = (run: RunRow, cause: Wait): string | undefined =>
    cause === 'unreachable' ? unreachableSince(run) : unconfirmedSince(run);

  // Whether one of an unknown Run's waits has lasted the grace period. A wait this
  // process saw begin is timed by the monotonic clock alone: the wall clock can only
  // disagree with it by having been set, forward (which must not judge early) or back
  // (which must not put the judgment off). One that began before this process did has
  // only the ledger's wall-clock time, which a restart does not reset; the callers add
  // that this process must itself have just failed to reach the machine.
  function pastGrace(run: RunRow, cause: Wait): boolean {
    const since = sinceOf(run, cause);
    if (since === undefined) return false;
    const seen = begun.get(`${cause} ${run.id}`);
    return (seen === undefined ? now() - Date.parse(since) : monotonic() - seen) >= graceMs();
  }

  // The wait that decides what happens to an unknown Run next. While its machine does
  // not answer that is the stretch out of contact: the start cannot be revoked there.
  function overdue(run: RunRow): boolean {
    return pastGrace(run, unreachableSince(run) === undefined ? 'unconfirmed' : 'unreachable');
  }

  // Whether the machine this Run is on has told this host that the two speak different
  // protocol versions. Nothing is judged and nothing is continued while that is so (§5.3).
  function refusesProtocol(run: RunRow): boolean {
    return run.machine_id !== null && options.refusesProtocol?.(run.machine_id) === true;
  }

  // Records what a look at an unknown Run found, and which waits began with it.
  function noteUnknown(run: RunRow, cause: Wait): RunRow {
    ledger.markRunUnknown(run.id, cause);
    const noted = ledger.getRun(run.id);
    if (sinceOf(run, cause) === undefined) begun.set(`${cause} ${run.id}`, monotonic());
    if (cause === 'unconfirmed') begun.delete(`unreachable ${run.id}`);
    return noted;
  }

  const lostSpan = (run: RunRow) => ({
    since: unreachableSince(run) ?? unconfirmedSince(run),
    until: new Date(now()).toISOString(),
  });

  // §5: which machine of a target takes the next Run. Machines in a loss record are
  // left out: one that holds a Run out of contact, or failed to answer within the
  // cooldown. The rest go by fewest active Runs, then by their order in the target, and the
  // first that answers is it. `forContinuation` asks only whether any machine answers
  // now: a Run whose start was never confirmed sits on a machine that may well answer,
  // and its own record must not be what keeps it from being judged. `tried` are
  // machines the caller has already found wanting for this Run. `timeoutMs` bounds each probe
  // for a caller the owner waits on; absent, the transport's own limit.
  async function findMachine(
    _login: Login,
    available: Machine[],
    forContinuation = false,
    tried: ReadonlySet<string> = new Set(),
    timeoutMs?: number,
    preferOrder = false,
  ): Promise<Machine | undefined> {
    const active = ledger.listActiveRuns();
    const candidates = available.map((machine, index) => ({ machine, index,
      runs: active.filter((run) => runMachineKey(run) === machineKey(machine)),
    })).filter(({ machine, runs }) => {
      if (tried.has(machine.id)) return false;
      const contact = contactOf(machine);
      if (contact.up === false && monotonic() - contact.failedAt < options.cooldownMs()) return false;
      return forContinuation || !runs.some((run) => unreachableSince(run) !== undefined);
    }).sort((a, b) => (preferOrder
      ? a.index - b.index || a.runs.length - b.runs.length
      : a.runs.length - b.runs.length || a.index - b.index));
    for (const { machine } of candidates) {
      const contact = contactOf(machine);
      const host = reach(machine, timeoutMs);
      // A machine that says its client is not here is not one to ask: the answer would be
      // "not connected" at once, and reading that as a machine that failed to answer would
      // keep every round off it for the cooldown — including the moment its client comes
      // back (docs/design/nodes.md §4.4). Asked before the cache of its last answer: a
      // client that went away a moment after answering is gone now, whatever it said then.
      if (!host.connected()) continue;
      if (!forContinuation && contact.up && monotonic() - contact.okAt < options.probeFreshMs()) return machine;
      try {
        await host.readRange(PROBE_PATH, 0);
        return machine;
      } catch (err) {
        if (!(err instanceof Unreachable)) throw err;
      }
    }
    return undefined;
  }

  // The snapshot says what actually ran; the login may have changed executor since, or be
  // gone. A snapshot that never recorded it is read by the login it names, while there is one.
  function adapterOf(run: RunRow): Adapter {
    const executor = snapshotOf(run).executor ?? loginOf(run).executor;
    const adapter = adapters[executor];
    if (!adapter) throw new InputError(`没有执行器 ${executor} 的适配器`);
    return adapter;
  }

  function diagnosticsExpired(run: RunRow): boolean {
    return run.ended_at !== null && Date.parse(run.ended_at) <= now() - diagnosticsRetentionMs();
  }

  function tailOf(runId: string, run?: RunRow): TailState {
    let state = tails.get(runId);
    if (diagnosticsDir && !run && ledger.hasRun(runId)) run = ledger.getRun(runId);
    const source = diagnosticsDir && run && !diagnosticsExpired(run) ? diagnosticSource(run) : undefined;
    if (state && source === state.history?.source) { trimHistory(state); return state; }
    state = { offset: 0, partial: [], partialBytes: 0, size: 0, mtime: 0, events: [], dropped: 0, listeners: state?.listeners ?? new Set() };
    tails.set(runId, state);
    if (!diagnosticsDir || !source) return state;
    const history: NonNullable<TailState['history']> = {
      source, sizes: [], bytes: 0, discarding: false, sourceLost: false, finished: false, dirty: false,
    };
    state.history = history;
    try {
      const saved = readCheckpoint(diagnosticsDir, runId, source);
      if (saved) {
        state.offset = saved.cursor;
        state.dropped = saved.dropped;
        state.events = saved.events;
        history.sizes = saved.events.map(eventBytes);
        history.bytes = history.sizes.reduce((sum, size) => sum + size, 0);
        history.discarding = saved.discarding;
        history.sourceLost = saved.sourceLost;
        history.finished = saved.finished;
      }
    } catch {
      history.issue = '主机保留的 Worker 诊断记录无法读取，正在尝试从原机器补回。';
    }
    trimHistory(state);
    return state;
  }

  async function checkpoint(run: RunRow, state: TailState): Promise<void> {
    trimHistory(state);
    const history = state.history;
    if (!diagnosticsDir || !history?.dirty || !ledger.hasRun(run.id)) return;
    writingDiagnostics.add(run.id);
    try {
      if (!diagnosticsReady) {
        prepareOwnerOnlyDirectory(diagnosticsDir);
        diagnosticsReady = true;
      }
      const saved: DiagnosticCheckpoint = {
        version: 1, source: history.source, cursor: state.offset - state.partialBytes,
        dropped: state.dropped, discarding: history.discarding, sourceLost: history.sourceLost,
        finished: history.finished, events: state.events,
      };
      await writeCheckpoint(diagnosticsDir, run.id, saved);
      history.dirty = false;
      delete history.issue;
    } catch {
      history.issue = '主机暂时无法保存 Worker 诊断，已显示的内容可能在服务重启后丢失。';
    } finally {
      writingDiagnostics.delete(run.id);
    }
  }

  function pruneDiagnostics(): void {
    if (!diagnosticsDir) return;
    const removeRun = (id: string): boolean => !ledger.hasRun(id) || diagnosticsExpired(ledger.getRun(id));
    pruneCheckpoints(diagnosticsDir, removeRun, writingDiagnostics);
    for (const [id, state] of tails) {
      if (!writingDiagnostics.has(id) && state.listeners.size === 0 && removeRun(id)) tails.delete(id);
    }
  }

  // A machine answers §4's fields itself; what it cannot read comes back as `unknown`.
  const readStateAt = (host: RemoteHost, dir: string): Promise<RemoteState> => host.state(dir);

  const readState = (run: RunRow): Promise<RemoteState> => readStateAt(hostOf(run), runDir(run));

  // What a round's output is read through, wherever it is read as text: the secret the round
  // was handed is taken out here, before anything is parsed, shown or kept (runner/redact.ts).
  // The login's secret as the service holds it now: a round whose login is gone, or a
  // machine's own, was handed none.
  // The secret each round was handed at its start, by Run: the login may hold another by the time
  // its output is read. Kept for as long as this service runs.
  const handed = new Map<string, string>();
  const handedGithub = new Map<string, string>();
  const hiding = (run: RunRow): ((text: string) => string) => {
    const extra = adapters[snapshotOf(run).executor ?? '']?.secretStrings;
    const expand = (secret: string | undefined): readonly string[] => (secret ? [secret, ...(extra ? extra(secret) : [])] : []);
    return hider([
      ...expand(run.login_id === null ? undefined : options.credential?.(run.login_id)?.value),
      ...expand(handed.get(run.id)),
      options.githubToken?.() ?? undefined,
      handedGithub.get(run.id),
    ]);
  };

  async function readAll(run: RunRow, name: string): Promise<string> {
    const host = hostOf(run);
    const path = `${runDir(run)}/${name}`;
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const { bytes, size } = await host.readRange(path, offset);
      chunks.push(bytes);
      offset += bytes.length;
      if (bytes.length === 0 || offset >= size) return hiding(run)(Buffer.concat(chunks).toString('utf8'));
    }
  }

  // Both are display only: neither may get in the way of a verdict or a settlement.
  function parsed(adapter: Adapter, line: string): NormalizedEvent[] {
    try {
      return adapter.parse(line);
    } catch {
      return [];
    }
  }

  // What a Run's page shows. How much quota the account has left is about the target.
  const displayEvents = (adapter: Adapter, line: string): NormalizedEvent[] => parsed(adapter, line).filter((event) => event.kind !== 'quota').map((event) => bounded(event, options.displayTextBytes()));

  // What the executor said about its login's quota goes to the Run's login. Not being
  // able to record it must not stop the reading that came across it.
  function noteUsage(run: RunRow, events: NormalizedEvent[]): void {
    const windows = events.flatMap((event) => (event.kind === 'quota' ? [{ window: event.window, used: event.used, resetsAt: event.resetsAt }] : []));
    if (windows.length === 0) return;
    try {
      ledger.noteUsage(run.login_id, windows, snapshotOf(run).credential_ref ?? null, snapshotOf(run).quota_generation ?? null);
    } catch (err) {
      log(`${loginName(run.login_name ?? '已删除的登录')} 的用量没记下：${String(err)}`);
    }
  }

  function notify(listener: TailListener, event: NormalizedEvent, index: number): void {
    try {
      listener(event, index);
    } catch {
      // The other subscribers and the Run go on.
    }
  }

  const eventBytes = (event: NormalizedEvent): number => Buffer.byteLength(JSON.stringify(event)) + 1;

  function trimHistory(state: TailState): void {
    const history = state.history;
    const policy = history ? diagnosticsPolicy() : DEFAULT_DIAGNOSTIC_POLICY;
    const marker = state.dropped > 0 ? 1 : 0;
    const oldMarkerBytes = history && marker ? history.sizes[0]! : 0;
    let remove = 0, bytes = history?.bytes ?? 0, markSize = oldMarkerBytes;
    // Count and bytes both describe this one suffix. Remove its prefix in one splice
    // so reading an older, larger checkpoint under a smaller policy is linear work.
    while (state.events.length - marker - remove > policy.maxEvents
      || (history && bytes - oldMarkerBytes + markSize > policy.maxBytes)) {
      const index = marker + remove;
      if (index >= state.events.length) break;
      if (history) bytes -= history.sizes[index]!;
      remove++;
      markSize = eventBytes({ kind: 'truncated', dropped: state.dropped + remove });
    }
    if (!remove) return;
    state.dropped += remove;
    state.events.splice(0, marker + remove, { kind: 'truncated', dropped: state.dropped });
    if (history) {
      history.sizes.splice(0, marker + remove, markSize);
      history.bytes = bytes - oldMarkerBytes + markSize;
      history.dirty = true;
    }
  }

  // A Run can emit without end. A checkpoint contains only this suffix of the raw log.
  function remember(state: TailState, event: NormalizedEvent): void {
    state.events.push(event);
    const history = state.history;
    if (history) {
      const size = eventBytes(event);
      history.sizes.push(size);
      history.bytes += size;
      history.dirty = true;
    }
    trimHistory(state);
    const index = Math.max(state.dropped - 1, 0) + state.events.length - 1;
    for (const listener of state.listeners) notify(listener, event, index);
  }

  function diagnosticGap(state: TailState, message: string): void {
    remember(state, { kind: 'diagnostic', level: 'warning', message });
  }

  function credentialCanBeHidden(run: RunRow): boolean {
    const ref = snapshotOf(run).credential_ref;
    if (ref === undefined || handed.has(run.id)) return true;
    const held = run.login_id === null ? undefined : options.credential?.(run.login_id);
    return held?.ref === ref && held.value.length >= 8;
  }

  function feed(run: RunRow, state: TailState, bytes: Buffer, active: boolean): void {
    const adapter = adapterOf(run);
    const hide = hiding(run);
    const history = state.history;
    let start = 0;
    for (;;) {
      const end = bytes.indexOf(NEWLINE, start);
      if (end < 0) break;
      // A whole line at a time: a secret cut by the edge of a block is whole again here.
      const segment = bytes.subarray(start, end);
      const oversized=state.captureDiscard||(history&&(history.discarding||state.partialBytes+segment.length>MAX_RAW_DIAGNOSTIC_LINE));
      if (oversized) {
        const fromGap=state.captureDiscard,tooLong=state.discardOversize||state.partialBytes+segment.length>MAX_RAW_DIAGNOSTIC_LINE;state.captureDiscard=false;state.discardOversize=false;
        if(history)history.discarding = false;
        diagnosticGap(state, fromGap?'缺口后的不完整 Worker 诊断记录已跳过。':tooLong?'一条 Worker 诊断原始记录超过单行上限，已跳过。':'一条无法完整解析的 Worker 诊断记录已跳过。');
      } else {
        const line = hide(Buffer.concat([...state.partial, segment]).toString('utf8'));
        const events = parsed(adapter, line);
        if (active) noteUsage(run, events);
        for (const each of events) {
          if (each.kind === 'quota' || each.kind === 'truncated') continue;
          let event: NormalizedEvent = each;
          if (history) {
            // Redact the whole field before the display cap can divide a header or token.
            event = JSON.parse(JSON.stringify(event, (_key, field: unknown) =>
              typeof field === 'string' ? redactWorkerDiagnosticText(field, hide) : field)) as NormalizedEvent;
          }
          event = bounded(event, options.displayTextBytes());
          if (history && eventBytes(event) + 128 >= HISTORY_EVENT_BYTES) {
            diagnosticGap(state, '一条 Worker 诊断记录超过单事件解析安全上限，已跳过。');
            continue;
          }
          remember(state, event);
        }
      }
      state.partial = [];
      state.partialBytes = 0;
      start = end + 1;
    }
    if (start === bytes.length) return;
    const fragment = bytes.subarray(start);
    if (state.captureDiscard || (history && (history.discarding || state.partialBytes + fragment.length > MAX_RAW_DIAGNOSTIC_LINE))) {
      if(!state.captureDiscard&&state.partialBytes+fragment.length>MAX_RAW_DIAGNOSTIC_LINE)state.discardOversize=true;
      if(history)history.discarding = true;
      state.partial = [];
      state.partialBytes = 0;
      return;
    }
    state.partial.push(fragment);
    state.partialBytes += fragment.length;
  }

  async function readProgress(run: RunRow, blocks: number, final = false, temporary?:TailState): Promise<string | undefined> {
    const active = !temporary&&run.state !== 'ended';
    const state = temporary??tailOf(run.id, run);
    const history = state.history;
    if (history?.sourceLost || history?.finished) {
      await checkpoint(run, state);
      return history.sourceLost ? DIAGNOSTIC_SOURCE_LOST : undefined;
    }
    if (history && !placeStands(run)) return DIAGNOSTIC_REGISTRATION_GONE;
    if (history && !credentialCanBeHidden(run)) return DIAGNOSTIC_CREDENTIAL_LOST;
    const host = hostOf(run);
    const path = `${runDir(run)}/stdout.ndjson`;
    const spec=captureOf(run);
    if(spec){
      if(!host.readCapture)return '执行节点需升级后读取有界诊断';
      try{for(let block=0;block<blocks;block++){
        if(!placeStands(run)||!credentialCanBeHidden(run))return '原轮次登记或凭据不可核对';
        const range=await host.readCapture({run_dir:runDir(run),source:spec.source,stream:'stdout',offset:state.offset,bytes:256*1024});
        if(!placeStands(run)||!credentialCanBeHidden(run))return '原轮次登记或凭据不可核对';
        if(range.state!=='range')return range.reason;
        if(range.source===spec.source&&Number.isSafeInteger(range.end)&&range.end<state.offset){if(history){history.sourceLost=true;history.dirty=true;}diagnosticGap(state,DIAGNOSTIC_SOURCE_LOST);return DIAGNOSTIC_SOURCE_LOST;}
        if(![range.base,range.end,range.committed_end,range.start].every(n=>Number.isSafeInteger(n)&&n>=0)||range.source!==spec.source||!Number.isSafeInteger(range.start)||range.start<state.offset||range.start>range.committed_end||range.committed_end>range.end||range.base>range.committed_end)throw new Unverifiable('有界诊断范围不符');
        if(range.start>state.offset&&(!range.gap||range.gap.from!==state.offset||range.gap.to!==range.start))throw new Unverifiable('有界诊断缺少缺口凭据');
        if(range.gap){state.partial=[];state.partialBytes=0;state.captureDiscard=true;if(history){history.discarding=true;history.dirty=true;}diagnosticGap(state,'节点原始诊断存在缺口：'+range.gap.from+'..'+range.gap.to);}
        const bytes=Buffer.from(range.base64,'base64');if(bytes.length>256*1024||range.start+bytes.length>range.committed_end)throw new Unverifiable('有界诊断数据超出已提交范围');
        state.offset=range.start;if(history)history.dirty||=bytes.length>0;feed(run,state,bytes,active);state.offset+=bytes.length;state.size=range.end;if(active&&bytes.length)ledger.touchRun(run.id,new Date(now()).toISOString());
        if(!bytes.length||state.offset>=range.committed_end){if(range.sealed&&state.offset>=range.end){if(state.partialBytes>0||state.captureDiscard||history?.discarding)feed(run,state,Buffer.from('\n'),active);if(history){history.finished=true;history.dirty=true;}}return range.issue;}
      }return DIAGNOSTIC_BACKLOG;}finally{if(!temporary)await checkpoint(run,state);}
    }
    try {
      for (let block = 0; block < blocks; block += 1) {
        const { bytes, size, mtime } = await host.readRange(path, state.offset);
        if (history) {
          if (!placeStands(run)) return DIAGNOSTIC_REGISTRATION_GONE;
          if (bytes.length === 0 && size === 0 && mtime === 0) return '原始输出不存在';
          if (size < state.offset) {
            history.sourceLost = true;
            diagnosticGap(state, DIAGNOSTIC_SOURCE_LOST);
            return DIAGNOSTIC_SOURCE_LOST;
          }
          if (state.offset + bytes.length > size || (bytes.length === 0 && size > state.offset)) {
            return 'Worker 原始输出未能连续读取，可以重新打开现场重试。';
          }
          if (!credentialCanBeHidden(run)) return DIAGNOSTIC_CREDENTIAL_LOST;
          history.dirty ||= bytes.length > 0;
        }
        feed(run, state, bytes, active);
        state.offset += bytes.length;
        if (size !== state.size || mtime !== state.mtime) {
          state.size = size;
          state.mtime = mtime;
          if (active && mtime > 0) ledger.touchRun(run.id, new Date(mtime * 1000).toISOString());
        }
        if (bytes.length === 0 || state.offset >= size) {
          if (history && final) {
            if (state.partialBytes > 0 || history.discarding) feed(run, state, Buffer.from('\n'), active);
            history.finished = true;
            history.dirty = true;
          }
          return;
        }
      }
      return DIAGNOSTIC_BACKLOG;
    } finally {
      await checkpoint(run, state);
    }
  }

  function eventSnapshotOf(state: TailState, reason?: string, loaded = true): EventSnapshot {
    return {
      events: state.events,
      firstIndex: Math.max(state.dropped - 1, 0),
      loaded,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  async function durableEventSnapshot(run: RunRow): Promise<EventSnapshot> {
    const current = ledger.getRun(run.id);
    const state = tailOf(current.id, current);
    if (diagnosticsExpired(current)) {
      return eventSnapshotOf(state, 'Worker 诊断保留期已过，工作结果和产物状态仍可查看。', false);
    }
    await checkpoint(current, state);
    const history = state.history;
    if (!history) return eventSnapshotOf(state, '这一轮没有可信的节点登记，无法补回 Worker 诊断。', state.events.length > 0);
    if (current.state !== 'ended') {
      const problem = history.sourceLost ? DIAGNOSTIC_SOURCE_LOST
        : !placeStands(current) ? DIAGNOSTIC_REGISTRATION_GONE
        : !credentialCanBeHidden(current) ? DIAGNOSTIC_CREDENTIAL_LOST
        : history.issue;
      return eventSnapshotOf(state, problem, !problem || state.events.length > 0);
    }
    let problem: string | undefined;
    try {
      // Completed and stopped rounds have a closed spool. A lost round might still
      // produce output remotely, so an EOF there does not finalize the checkpoint.
      problem = await readProgress(current, BLOCKS_PER_POLL, current.exit_kind !== 'lost');
      if (!problem && current.exit_kind === 'lost') {
        problem = '这一轮以失联结束，只显示目前已收到的 Worker 诊断。';
      }
    } catch {
      problem = '暂时无法读取这一轮的原始 Worker 诊断，可以在原机器连回后重试。';
    }
    return eventSnapshotOf(state, problem ?? history.issue, !problem || state.events.length > 0);
  }

  async function loadEvents(run: RunRow): Promise<readonly NormalizedEvent[]> {
    if(captureOf(run)){if(!placeStands(run))throw new HistoryLoadError('这一轮所在的机器已经不在了，或者已经换成了另一台');const state:TailState={offset:0,partial:[],partialBytes:0,size:0,mtime:0,events:[],dropped:0,listeners:new Set()};try{const problem=await readProgress(run,Infinity,true,state);if(problem)throw new HistoryLoadError(problem);return state.events;}catch(error){if(error instanceof HistoryLoadError)throw error;throw new HistoryLoadError((error as Error).message);}}
    try {
      if (!placeStands(run)) throw new Error('这一轮所在的机器已经不在了，或者已经换成了另一台');
      const host = hostOf(run);
      const adapter = adapterOf(run);
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const { bytes, size, mtime } = await host.readRange(`${runDir(run)}/stdout.ndjson`, offset);
        if (offset === 0 && size === 0 && mtime === 0) throw new Error('原始输出不存在');
        chunks.push(bytes);
        offset += bytes.length;
        if (!bytes.length || offset >= size) break;
      }
      return hiding(run)(Buffer.concat(chunks).toString('utf8')).split('\n')
        .filter((line) => line.length > 0).flatMap((line) => displayEvents(adapter, line));
    } catch (error) {
      throw new HistoryLoadError((error as Error).message);
    }
  }

  // §3: back to running or stopping first, so a found executor settles the
  // ordinary way.
  function restore(run: RunRow): void {
    if (run.state === 'launching' || run.state === 'unknown') ledger.markRunRunning(run.id);
  }

  async function capturedResult(run:RunRow){
    const spec=captureOf(run);if(!spec)throw new InputError('这一轮不是有界输出');
    const host=hostOf(run);if(!host.readResult)throw new Unverifiable('执行节点需升级后读取原生结果');
    const guard=():void=>{if(!placeStands(run)||!credentialCanBeHidden(run))throw new InputError('原轮次登记或凭据代次已变化，不能读取原生结果');};
    return readCaptureResult(runDir(run),spec,host.readResult.bind(host),guard,hiding(run));
  }

  async function settleLocked(run: RunRow, exitCode: number | null, opts: SettleOptions): Promise<void> {
    const stopping = hasStopIntent(run),spec=captureOf(run);
    const notAdopted=stopping||opts.kind!==undefined||opts.workerNotStarted!==undefined;
    let captured:Awaited<ReturnType<typeof capturedResult>>|undefined;
    if(spec){
      if(notAdopted&&!credentialCanBeHidden(run))captured={evidence:{source:spec.source,complete:false},issue:'原凭据代次不可读，结果明确不采用'};
      else try{captured=await capturedResult(run);}catch(error){
        const permanent=error instanceof InputError;
        if(!permanent&&(!notAdopted||!(error instanceof Unverifiable||error instanceof ListingFailed||error instanceof Unreachable)))throw error;
        captured={evidence:{source:spec.source,complete:false},issue:(error as Error).message};
      }
    }
    const reading=captured?.reading??(captured?{finished:false,error:{kind:'other' as const,message:captured.issue??'原生结果不可核实'}}:adapterOf(run).result(await readAll(run,'stdout.ndjson'),exitCode,await readAll(run,'stderr.log')));
    if(captured?.issue&&!stopping){if(opts.workerNotStarted!==undefined)opts={...opts,reason:opts.reason??opts.workerNotStarted};else if(opts.kind===undefined)opts={...opts,kind:'interrupted',reason:captured.issue+'；请核现场后改文件交付或调限，不自动重做已启动任务'};}
    // A failure with exit 0 must not reach the table's "exit 0, done" row.
    const receipt = reading.error && exitCode === 0 ? null : parseReceipt(reading.text);
    const reason = stopReasons.get(run.id) ?? opts.reason ?? (stopping ? undefined : failureReason(reading));
    // The quota running out under a Run is said to the ledger whatever else ended the Run:
    // the target rests either way. It is how the Run ended only where nothing else is: a
    // stop asked for, a loss and a later round of the Task keep their own endings.
    const used = reading.error?.kind === 'quota' ? reading.error : undefined;
    const quota = used ? { quota: { message: used.message, ...(used.resetsAt ? { resetsAt: used.resetsAt } : {}) } } : {};
    // The executor refused the login the round ran as, whichever kind: an account's token or
    // a machine's own sign-in. Either way the login takes no more work until it is put right.
    const rejected = reading.error?.kind === 'auth';
    const kind = !stopping && opts.kind === undefined
      ? rejected ? { kind: 'auth' as const } : used ? { kind: 'quota' as const } : {} : {};
    // No poll follows, and with the group gone the file has stopped growing.
    await readProgress(run, diagnosticsDir ? BLOCKS_PER_POLL : Infinity, opts.kind !== 'lost').catch(() => {});
    ledger.settleRun(run.id, exitCode, receipt, {
      ...(captured?{captureResult:captured.evidence}:{outputProcessed:true as const}),
      ...opts,
      ...kind,
      ...quota,
      ...(reason === undefined ? {} : { reason }),
      ...(reading.text === undefined ? {} : { finalReply: reading.text }),
      ...(reading.sessionRef === undefined ? {} : { sessionRef: reading.sessionRef }),
      ...(reading.usage === undefined ? {} : { usage: reading.usage }),
    });
    stopReasons.delete(run.id);
    if (options.onRunSettled && (receipt !== null || exitCode === 0)) {
      const settled = ledger.getRun(run.id) ?? run;
      void Promise.resolve()
        .then(() => options.onRunSettled!(settled, receipt))
        .catch(() => {});
    }
  }

  // A stop that failed proves nothing about the host, like one that never arrived:
  // a start may still be on its way, so nothing may be read as "gone" after it. A machine
  // that cannot say that nothing is left throws, which is the same case.
  const stopRemote = (run: RunRow): Promise<void> => hostOf(run).stop(runDir(run));

  // §4: the Run's place was taken away, so it is gone without anyone looking. A stop
  // asked for still ends as a stop.
  function settleRemoved(run: RunRow): Verdict {
    const stopIntent = hasStopIntent(run);
    const lost = { basis: 'removed' as const, ...lostSpan(run) };
    ledger.settleRun(run.id, null, null, stopIntent
      ? { kind: 'interrupted', reason: `${stopReasons.get(run.id) ?? INTERRUPTED_REASON}（机器被移除）`, lost }
      : { kind: 'lost', lost });
    stopReasons.delete(run.id);
    return stopIntent ? 'ended' : 'lost';
  }

  // §4's three kinds of evidence that a Run is gone. Seen: the table's rows, as before.
  // Removed: the machine left the target. Presumed: out of contact past the grace
  // period, and only when a continuation is about to be sent, so that this machine
  // losing its own network judges nothing. `sending` says whether one still is, and is
  // asked here, in the Run's own queue, at the moment of the judgment: the probes before
  // it take as long as the machine likes, and a pause or a stop may have come meanwhile.
  // A stop out of contact past the grace period ends without that condition: nothing is
  // waiting to be started.
  async function verifyLocked(runId: string, sending?: () => boolean): Promise<Verdict> {
    const run = ledger.getRun(runId);
    if (run.state === 'ended') return 'ended';
    const stopIntent = hasStopIntent(run);
    const place = standing(run);
    if (place === 'removed') return settleRemoved(run);
    if (place === 'unknown') {
      // No machine is asked and no wait begins: only the owner can say where this was.
      ledger.markRunUnknown(run.id, 'no_target');
      return 'unknown';
    }
    try {
      // §5.6: a stop finishes first, also when a restart interrupted it.
      if (stopIntent) await stopRemote(run);
      return await actOn(run, await readState(run), stopIntent, sending, false);
    } catch (err) {
      if (err instanceof Unverifiable) return unverifiable(runId, err.message);
      if (!(err instanceof Unreachable)) throw err;
      const current = ledger.getRun(runId);
      if (current.state === 'ended') return 'ended';
      const silent = noteUnknown(current, 'unreachable');
      // §5.3: a client of another protocol version refuses to talk, and that is not the same
      // as a machine that has gone. The Run stays unknown until the two agree, rather than
      // being judged lost after the grace period and continued somewhere else.
      if (refusesProtocol(current)) return 'unknown';
      if (!pastGrace(silent, 'unreachable')) return 'unknown';
      const lost = { basis: 'presumed' as const, ...lostSpan(silent) };
      if (hasStopIntent(silent)) {
        // Stop intent still wins: nobody saw it end, and it ends as interrupted.
        const reason = `${stopReasons.get(runId) ?? INTERRUPTED_REASON}（机器失联）`;
        ledger.settleRun(runId, null, null, { kind: 'interrupted', reason, lost });
        stopReasons.delete(runId);
        return 'ended';
      }
      if (!sending?.()) return 'unknown';
      ledger.settleRun(runId, null, null, { kind: 'lost', lost });
      return 'lost';
    }
  }

  // A machine that answers that it cannot tell (nodes.md §4.3). Nothing about the round is
  // known, so nothing is settled and no wait runs out on it: it stays unknown, with the
  // machine's words, until a look can say — or until the machine goes away or is removed,
  // which the rules above judge as they always do.
  function unverifiable(runId: string, said: string): Verdict {
    const current = ledger.getRun(runId);
    if (current.state === 'ended') return 'ended';
    ledger.markRunUnknown(current.id, 'unverifiable', said);
    begun.delete(`unreachable ${current.id}`);
    begun.delete(`unconfirmed ${current.id}`);
    return 'unknown';
  }

  // §4's table applied to one answer of the machine. `revoked`: this is the answer read
  // after the start was revoked, which is all there will ever be, and it is judged like any
  // other: a round found finished is settled with its code, one found gone is lost.
  async function actOn(run: RunRow, state: RemoteState, stopIntent: boolean, sending: (() => boolean) | undefined, revoked: boolean): Promise<Verdict> {
    // The machine shows the round started, whether or not its start was ever answered:
    // that is kept before anything is settled, so that a round judged lost below still
    // counts as one that may have written (roles-and-tiers.md §4 ②).
    // Unless the machine says no Worker of it ever ran, which is the stronger evidence.
    if (state?.started && run.started_at === null && state.not_started === undefined) ledger.noteRunStarted(run.id);
    const verdict = judge(state, stopIntent);
    switch (verdict) {
      case 'unknown': {
        // The round started and the machine says it cannot tell what became of it.
        if (state.started && state.unknown) return unverifiable(run.id, state.unknown);
        if (revoked) break;
        // The machine answered, which ends any stretch out of contact; what it is
        // waited for now is the start, from the first answer like this one.
        const waiting = noteUnknown(run, 'unconfirmed');
        if (!pastGrace(waiting, 'unconfirmed') || !sending?.()) break;
        // The machine answers and the start never showed. Revoking it takes the gate,
        // so what is there after this is all there will ever be.
        await stopRemote(waiting);
        return actOn(ledger.getRun(run.id), await readState(waiting), false, sending, true);
      }
      case 'running':
        restore(run);
        break;
      case 'lost':
        await settleLocked(run, null, { kind: 'lost', lost: { basis: 'seen', ...lostSpan(run) } });
        break;
      case 'ended': {
        // A Run's processes do not outlive it, and they could still be writing
        // the output read below.
        const residue = hasProcesses(state);
        if (residue) {
          await stopRemote(run);
          if (hasProcesses(await readState(run))) {
            ledger.reportStuckResidue(run.id);
            restore(run);
            return 'running';
          }
        }
        restore(run);
        // A later round of the Task holds the instance: this one's result is not one.
        const superseded = state.exit === SUPERSEDED_EXIT && !stopIntent;
        await settleLocked(ledger.getRun(run.id), state.exit, {
          ...(stopIntent ? { kind: 'interrupted' as const } : {}),
          ...(state.not_started === undefined || superseded ? {} : { workerNotStarted: state.not_started }),
          ...(state.code_check === undefined ? {} : { codeCheck: state.code_check }),
          // Where the round's code stood when it was over: a review is bound to it, and the
          // Task's start is the first round's (docs/design/code-sources.md §8 第 4、6 条).
          ...(state.source_head === undefined ? {} : { sourceHead: state.source_head }),
          ...(superseded ? { kind: 'lost' as const, lost: { basis: 'superseded' as const } } : {}),
          ...(residue ? { residue } : {}),
        });
        break;
      }
      case 'waiting':
        // The launcher is there and has not got to its Worker. The Run is starting, as
        // it was before contact was lost, and the wall clock ends that wait.
        if (run.state === 'unknown') ledger.markRunLaunching(run.id);
        break;
    }
    return verdict;
  }

  async function interruptLocked(runId: string, ctx: Ctx): Promise<Verdict> {
    const run = ledger.getRun(runId);
    if (run.state === 'ended') return 'ended';
    // The ledger first: if it cannot record the stop, no signal goes out.
    if (!hasStopIntent(run)) ledger.markRunStopping(runId, ctx);
    return verifyLocked(runId);
  }

  // §4: from created_at, which no confirmation or restart moves. An unknown Run
  // has no clock; a launching one does, since a launcher that never returns
  // would otherwise hold the Task forever, and stop.sh is safe at that point.
  async function enforceClock(run: RunRow): Promise<boolean> {
    // A Run whose place is gone or cannot be told has no clock either: verify speaks for it.
    const clocked = (run.state === 'running' || run.state === 'launching') && standing(run) === 'ok';
    // Every snapshot records its limit: createRun is where that is made sure of.
    if (!clocked || Date.now() - Date.parse(run.created_at) <= snapshotOf(run).timeout_ms) return false;
    // A Worker that finished and was only noticed late has a result, not a timeout.
    const state = await readState(run).catch((err: unknown) => {
      if (err instanceof Unreachable) return null;
      throw err;
    });
    if (judge(state, false) === 'ended') {
      await verifyLocked(run.id);
      return true;
    }
    stopReasons.set(run.id, TIMEOUT_REASON);
    await interruptLocked(run.id, RUNNER);
    return true;
  }

  // §4, the third fence: a Run the ledger has ended may still have processes on a
  // machine nobody could reach when it was judged gone. Whatever is alive there and
  // ended here is stopped; a Run the ledger does not know is never touched.
  async function sweepHost(target: Machine): Promise<void> {
    const name = target.id;
    const host = reach(target);
    for (const { task_id: taskId, run_id: runId } of await host.list({ aliveOnly: true })) {
      if (!ledger.hasRun(runId)) continue;
      const run = ledger.getRun(runId);
      if (run.state !== 'ended' || run.task_id !== taskId) continue;
      try {
        await host.stop(runDir(run));
      } catch (err) {
        // The stop went out and the machine cannot tell whether it took: said, and asked
        // again on the next sweep, without holding up the other rounds of this machine.
        if (!(err instanceof Unverifiable)) throw err;
        log(`${name} 上已结束的 Run ${runId} 发了停止，但机器说不清停没停干净：${err.message}`);
        continue;
      }
      log(`${name} 上已结束的 Run ${runId} 还有进程，已清掉`);
    }
  }

  async function orphansOn(target: Machine): Promise<OrphanReport> {
    const report = { machine_id: target.id, host: target.host };
    try {
      const host = reach(target);
      const runs = [];
      for (const { task_id: taskId, run_id: runId } of await host.list({ aliveOnly: false })) {
        if (ledger.hasRun(runId)) continue;
        const state = await readStateAt(host, `.tycho/tasks/${taskId}/runs/${runId}`);
        runs.push({ task_id: taskId, run_id: runId, alive: hasProcesses(state) || state.launcher_alive });
      }
      return { ...report, runs };
    } catch (err) {
      // A listing the machine could not build says nothing about what is out there: it is
      // reported as such, like a machine that did not answer (runner/host.ts).
      if (!(err instanceof Unreachable) && !(err instanceof ListingFailed)) throw err;
      return { ...report, runs: null, error: err.message };
    }
  }

  const verify = (run: RunRow): Promise<Verdict> => serial(run.id, () => verifyLocked(run.id));

  // Display only, so an unreachable host is verify's to report. The clock comes
  // first because no reading may stand in its way.
  function tail(run: RunRow): Promise<void> {
    return serial(run.id, async () => {
      const current = ledger.getRun(run.id);
      if (current.state === 'ended' || standing(current) !== 'ok' || (await enforceClock(current))) return;
      try {
        await readProgress(current, BLOCKS_PER_POLL);
      } catch (err) {
        if (!(err instanceof Unreachable)) throw err;
      }
    });
  }

  // getRun answers in degraded mode too, and a start is exactly what §2 stops. So does
  // an inventory: a Run that got this far before it began starts nothing until verified.
  function mayStart(runId: string): boolean {
    const { degraded, recovering } = ledger.dispatchConditions();
    if (degraded) throw new DegradedError('服务处于降级模式，不发启动');
    if (recovering) throw new DegradedError('服务正在恢复清点，不发启动');
    return ledger.getRun(runId).state === 'launching';
  }

  // What a machine answers about one executor: its own client read this on the machine
  // (nodes.md §1.2). "Reachable" here is the machine answering about
  // itself just now; what it last reported is still shown when it cannot be asked, and the
  // error says which of the two this is.
  //
  // What that machine is signed in as is a fact about the machine and the user it runs as,
  // not about an account: an account runs on its own token, and this check cannot try it
  // there. For a machine's own login it is the very login the round would run as. The two sources are kept apart rather than mixed (§1.2), and
  // an account with a token is told nothing about the machine's own login.
  function nodeCheck(machine: Machine, name: string, executor: string, asked: ExecutorsAnswer, usesOwnLogin: boolean): MachineCheck {
    const found = asked.report?.executors.find((each) => each.executor === executor);
    const base: MachineCheck = {
      machine_id: machine.id, host: name, reachable: asked.fresh,
      version: found?.version ?? null, logged_in: usesOwnLogin ? found?.logged_in ?? null : null,
    };
    if (!asked.fresh) return { ...base, error: `${asked.problem ?? '没能让这台机器现在看一次'}；下面是它上次报的` };
    if (!found) return { ...base, error: `这台机器上的客户端没有报过 ${executor}：它可能不认这个执行器` };
    // The machine's own words keep every place it looked in (node/locate.ts).
    if (!found.installed) return { ...base, error: found.error ?? `这台机器上没有装 ${executor}` };
    if (found.error !== undefined) return { ...base, error: found.error };
    return base;
  }

  // A connection test of one machine: whether it answers, what version of the executor's
  // command it has, and whether that is signed in when the executor can say. The client
  // takes the closed set, so there is no command line to ask an executor with: it looks at
  // its own executors again and answers (nodes.md §1.2, §11 step 5). Bounded by the wait.
  async function checkHost(target: Login, machine: Machine): Promise<MachineCheck> {
    const name = machine.host;
    const unanswered = { machine_id: machine.id, host: name, reachable: false, version: null, logged_in: null };
    if (!adapters[target.executor]) return { ...unanswered, error: `没有执行器 ${target.executor} 的适配器` };
    const usesOwnLogin = !(adapters[target.executor]!.credential && options.credential?.(target.id) !== undefined);
    const timedOut = Symbol('timed out');
    const timer = Promise.withResolvers<typeof timedOut>();
    const timeout = checkTimeoutMs();
    const clock = setTimeout(() => timer.resolve(timedOut), timeout);
    try {
      const asked = (async () => options.executors === undefined
        ? { connected: false, report: null, fresh: false, problem: '服务里没有这条到机器的通道' } as ExecutorsAnswer
        : await options.executors!(machine.id, timeout))();
      // Left to end by itself once the wait is over; nothing reads it then.
      asked.catch(() => {});
      const answer = await Promise.race([asked, timer.promise]);
      if (answer === timedOut) return { ...unanswered, error: `${timeout / 1000} 秒内没有回答` };
      return nodeCheck(machine, name, target.executor, answer, usesOwnLogin);
    } finally {
      clearTimeout(clock);
    }
  }

  return {
    verify,
    tail,

    findMachine,

    // What the pages show about machines: what this process has learned from its own
    // calls, never a call made for the page.
    machines(): MachineFact[] {
      const active = ledger.listActiveRuns();
      return logins.list().flatMap((login) => eligibleMachines(login, [], machines).map((machine) => {
        const contact = contactOf(machine);
        return {
          login_id: login.id,
          machine_id: machine.id,
          host: machine.host,
          up: contact.up ?? null,
          last_ok_at: contact.answered ? new Date(now() - (monotonic() - contact.okAt)).toISOString() : null,
          active_runs: active.filter((run) => run.login_id === login.id && runMachineKey(run) === machineKey(machine)).length,
        };
      }));
    },

    // A login's connection test (docs/design/accounts-machines-decoupled.md "控制台"): one
    // machine that has the executor and answers now (probed, not taken from an earlier answer:
    // the owner asks about this moment), asked once.
    // Null when there is none to ask: that is not a failure of the login.
    async check(login: Login): Promise<MachineCheck | null> {
      const fitting = eligibleMachines(login, [], machines).filter((machine) => options.fits?.(machine.id, login.executor, false, login.machine === undefined) ?? true);
      const machine = await findMachine(login, fitting, true, new Set(), checkTimeoutMs());
      return machine ? checkHost(login, machine) : null;
    },

    // A machine's client answering for itself: the check asks it to look at its own machine
    // again, and what it read is on the page's line for it (nodes.md §1.2, §11 step 5).
    async checkMachine(machine: Machine): Promise<{ machine_id: string; host: string; reachable: boolean; error?: string }> {
      const report = { machine_id: machine.id, host: machine.host };
      const asked = options.executors === undefined
        ? { connected: false, report: null, fresh: false, problem: '服务里没有这条到机器的通道' } as ExecutorsAnswer
        : await options.executors(machine.id, checkTimeoutMs());
      return asked.fresh
        ? { ...report, reachable: true }
        : { ...report, reachable: false, error: (asked.problem ?? '机器没有回答').slice(0, CHECK_OUTPUT_CHARS) };
    },

    // Unknown Runs whose wait has lasted the grace period: their Tasks may go on, once a
    // machine is there to go on with. A machine whose client refuses to speak is not one of
    // those: nothing about the Run on it has been learned (§5.3).
    lostCandidates(): RunRow[] {
      const unknown = ledger.listActiveRuns().filter((run) => run.state === 'unknown');
      const waiting = new Set(unknown.flatMap(({ id }) => [`unreachable ${id}`, `unconfirmed ${id}`]));
      for (const key of begun.keys()) if (!waiting.has(key)) begun.delete(key);
      return unknown.filter((run) => !hasStopIntent(run) && overdue(run) && !refusesProtocol(run));
    },

    // §4: the last look before a continuation goes out, for as long as `sending` says
    // one is going out. Still out of contact settles the Run as lost; an executor found
    // alive takes it back to running and nothing is lost.
    presume: (run: RunRow, sending: () => boolean): Promise<Verdict> => serial(run.id, () => verifyLocked(run.id, sending)),

    // §4: giving a Task up does not wait for a machine that may never come back. One
    // that answers is stopped first.
    async abandon(taskId: string, reason: string, ctx: Ctx): Promise<void> {
      const run = ledger.listActiveRuns().find((active) => active.task_id === taskId);
      if (run?.state !== 'unknown') {
        ledger.abandonTask(taskId, reason, ctx);
        return;
      }
      // Before the stop goes out: a refused request must not have stopped anything.
      if (reason.trim() === '') throw new InputError('放弃理由不能为空');
      await serial(run.id, async () => {
        await interruptLocked(run.id, ctx);
        const unreachable = ledger.getRun(run.id).state === 'unknown';
        ledger.abandonTask(taskId, reason, ctx, unreachable ? { runId: run.id } : undefined);
      });
    },

    // A machine's client is back (service/nodes.ts says so when it polls again). What this
    // host ended while the machine was away — a Round it judged lost, a Task the owner gave
    // up — is cleared on it by the next sweep rather than up to the sweep's own interval
    // later, and the round it says it has running is asked about at once (nodes.md §4.4).
    // The request stands until a sweep reaches the machine: one that could not is tried
    // again at once (`sweep`).
    machineBack(machineId: string): void {
      const machine = machines.get(machineId);
      if (machine) contactOf(machine).returned = true;
    },

    // Clears, on each machine, what the ledger ended while it did not answer: as soon
    // as it is seen to answer again, and every `sweepMs` anyway. The listing is its
    // own probe, because a Task given up or interrupted out of contact leaves nobody
    // else with a reason to ask that machine again; one that does not answer is asked
    // every `cooldownMs`. A failure is logged and the next round tries again.
    async sweep(): Promise<void> {
      await Promise.all(machines.list().map(async (target) => {
        const contact = contactOf(target);
        // A machine whose client is not here is not a machine that failed to answer: nothing
        // is asked and nothing is recorded about it, so a machine that was away for a while
        // is offered work and swept the moment it comes back rather than a cooldown later
        // (nodes.md §4.4).
        if (!reach(target).connected()) return;
        const every = contact.up === false ? options.cooldownMs() : options.sweepMs();
        const due = contact.returned || contact.sweptAt === undefined || monotonic() - contact.sweptAt >= every;
        if (contact.sweeping || !due) return;
        contact.sweeping = true;
        // Take only the request this sweep serves; a return during it needs another sweep.
        const returned = contact.returned;
        contact.returned = false;
        contact.sweptAt = monotonic();
        try {
          await sweepHost(target);
        } catch (err) {
          // Still out of contact is the expected case and says nothing new — but a sweep
          // that never reached the machine has cleared nothing, so what asked for it (a
          // machine that came back, one that answered again after failing to) is still
          // owed: it is swept again at once rather than after the cooldown, which is about
          // handing a machine that just failed new work, not about the clearing a machine's
          // own poll asked for (nodes.md §4.4).
          if (err instanceof Unreachable) {
            contact.returned ||= returned;
            return;
          }
          log(`清理 ${target.id} 上已结束的 Run 失败，下次再清：${String(err)}`);
        } finally {
          contact.sweeping = false;
        }
      }));
    },

    // Only called for a Run the ledger just created. Nothing here retries a start:
    // once a start may have reached the machine, the only way forward is verify. Placing the
    // snapshot is not a start: a machine that does not take it has started nothing, so
    // another may. Where the round's code comes from (a repository to clone, a folder
    // already on the machine) travels in the snapshot itself (`source.json`), so nothing
    // binary is handed beside it.
    async launch(run: RunRow): Promise<void> {
      if (!mayStart(run.id)) return;
      const adapter = adapterOf(run);
      const dir = runDir(run);
      const local = mkdtempSync(join(tmpdir(), 'tycho-snapshot-'));
      try {
        const evidence = options.reviewFiles?.(run) ?? [];
        writeSnapshot(snapshotOf(run), local, evidence);
        let placed = run;
        // The target changed, or lost this machine, after the Run was created for it:
        // nothing more is sent, and the Run ends the way one on a removed machine does.
        const withdraw = (): Promise<void> => serial(run.id, async () => {
          const current = ledger.getRun(run.id);
          if (current.state !== 'ended') settleRemoved(current);
        });
        // Each machine gets the snapshot once, so this ends whatever the machines do.
        const tried = new Set<string>();
        for (;;) {
          try {
            writeSnapshot(snapshotOf(placed),local,evidence);
            // What the machine reports it wrote is checked against the bytes sent
            // (nodes.md §6, the last line of the table).
            const written = await hostOf(placed).place(dir, local);
            for (const file of written) {
              if (!sameBytes(readFileSync(join(local, ...file.path.split('/'))), file)) {
                throw new Unreachable(`${placed.host} 上写下去的 ${file.path} 和发出去的对不上`);
              }
            }
            if (evidence.some((file) => !written.some((item) => item.path === file.path))) {
              throw new Unreachable(`${placed.host} 没有写下这一轮的审阅产物快照`);
            }
            break;
          } catch (err) {
            if (!(err instanceof Unreachable)) throw err;
            tried.add(placed.machine_id ?? placed.host);
            const target = placed.login_id === null ? undefined : logins.get(placed.login_id);
            // Moved only to a machine that can run this round as its snapshot says: one whose
            // executor works there, and, for a read-only round, whose read-only way starts there.
            // A folder source never travels: its code is on one machine, and this program does
            // not copy it (docs/design/code-sources.md §2). Neither does a repository round
            // whose source already worked somewhere: that machine holds the checkout, pushed or
            // not, so this round waits for it rather than cloning the work afresh elsewhere
            // (§8.7). The round did not start, and the next dispatch asks after that machine.
            const snapshot = snapshotOf(placed);
            const readOnly = snapshot.access?.permission === 'read';
            const rehostTask = ledger.getTask(placed.task_id);
            const movable = snapshot.source?.kind !== 'folder' && rehostTask?.machine_id === null && sourceRound(placed) === undefined;
            const inputsHere = (machine: Machine) => machineInputsHere(snapshot, adapters,
              snapshot.executor === undefined ? null : options.reported?.(machine.id, snapshot.executor) ?? null,
              options.reportedEntry?.(machine.id), options.externalEntryEnabled?.() ?? false);
            const preparedKnowledge = revisionSet(snapshot.knowledge ?? []);
            const fitting = movable && target && rehostTask && availableTo(target, placed)
              .filter((each) => (options.outputReady?.(each.id) ?? true)
                && (options.fits?.(each.id, target.executor, readOnly, target.machine === undefined) ?? !readOnly)
                && revisionSet(ledger.applicable(rehostTask.project_id, rehostTask.role_id, undefined, each.id)) === preparedKnowledge);
            const next = target && fitting && (await findMachine(target, fitting, false, tried));
            const moved = await serial(run.id, async () => {
              if (!mayStart(run.id)) return undefined;
              // The machine found may be one of a target that is no longer this Run's.
              if (!startAllowed(placed)) {
                settleRemoved(ledger.getRun(run.id));
                return undefined;
              }
              if (next) {
                const nextInputs = inputsHere(next);
                try {
                  return ledger.rehostRun(run.id, next, nextInputs);
                } catch (rehostErr) {
                  if (!(rehostErr instanceof InputError)) throw rehostErr;
                }
              }
              ledger.settleRun(run.id, null, null, { kind: 'lost', lost: { basis: 'not_started' } });
              return undefined;
            });
            if (!moved) return;
            placed = moved;
          }
        }
        // Asked again here, with nothing awaited between the answers and the start: the
        // upload took as long as the machine liked.
        if (!mayStart(run.id)) return;
        if (!startAllowed(placed)) return await withdraw();
        const snapshot = snapshotOf(placed);
        // The number must be the one the Run was created with: the owner may have
        // replaced or cleared the token while the upload took. A number whose file is
        // gone is the same case, because nothing names a token that is not there.
        const held = adapter.credential && placed.login_id !== null ? options.credential?.(placed.login_id) : undefined;
        if ((snapshot.credential_ref ?? null) !== (held?.ref ?? null)) return await withdraw();
        // What this round is handed is hidden from its output even once the owner replaces it.
        if (held) handed.set(run.id, held.value);
        const ghToken = options.githubToken?.();
        if (ghToken) handedGithub.set(run.id, ghToken);
        // A resumed round is handed the tier and the permission its own snapshot recorded,
        // not the login as it is now: the round that started this session is the one
        // being continued.
        const turn = roundTurn(snapshot, run.id);
        const { argv, env } = snapshot.session_ref ? adapter.resume(turn) : adapter.launch(turn);
        // Which round of its Task this is: the machine lets no earlier one start after it.
        const round = ledger.listRuns(run.task_id).findIndex(({ id }) => id === run.id) + 1;
        const started = await hostOf(placed).start({
          runDir: dir,
          ...(snapshot.output_capture?{source:snapshot.output_capture.source}:{}),
          taskId: run.task_id,
          runId: run.id,
          round,
          argv,
          env,
          credential: held ? adapter.credential!({ ...(snapshot.login?.provider ? { provider: snapshot.login.provider } : {}) }) : null,
          // When this task may spawn machines (nodes.md §1.3), the machine fetches the join
          // materials with the credential, and says where they join at (node/client.ts).
          ...(options.invite?.open(run.task_id) === true ? { invite: true } : {}),
          ...(snapshot.timeout_ms === undefined ? {} : { timeoutMs: snapshot.timeout_ms }),
          ...(snapshot.model_idle_timeout_ms === undefined ? {} : { modelIdleTimeoutMs: snapshot.model_idle_timeout_ms }),
        });
        const { code } = started;
        // The machine said, before it tried, that it started nothing and why (no snapshot, a
        // credential it could not take): no gate is taken there and nothing ran. Settled as a
        // round that never started, with the machine's own words — never left to be read later
        // as one that started and was lost.
        if (code === NOT_STARTED && started.stderr !== '') {
          await serial(run.id, async () => {
            const now = ledger.getRun(run.id);
            if (now.state === 'launching') await settleLocked(now, null, { workerNotStarted: started.stderr });
          });
          return;
        }
        if (code === GATE_TAKEN || code === START_REVOKED || code === START_SUPERSEDED) {
          await serial(run.id, () => verifyLocked(run.id));
          return;
        }
        // Anything else stays launching for the table: a stop may have moved the
        // Run meanwhile, and only verify can say what is out there. Code 0 is the gate
        // being this round's, whether or not the answer carried the process evidence.
        if (code === 0 && ledger.getRun(run.id).state === 'launching') {
          ledger.markRunRunning(run.id);
        }
      } catch (err) {
        if (!(err instanceof Unreachable)) throw err;
      } finally {
        rmSync(local, { recursive: true, force: true });
      }
    },

    // verify plus the requirement that it ended: no way around the stop check.
    settle(run: RunRow): Promise<void> {
      return serial(run.id, async () => {
        const verdict = await verifyLocked(run.id);
        if (verdict !== 'ended') throw new InputError(`Run ${run.id} 核实结果为 ${verdict}，不能结算`);
      });
    },

    interrupt: (run: RunRow, ctx: Ctx = RUNNER): Promise<Verdict> => serial(run.id, () => interruptLocked(run.id, ctx)),

    // One Run's broken target must not leave the others unchecked. A failing
    // database is everyone's problem and goes through.
    // A signal that fires ends it between Runs: one call in flight can take minutes. The
    // check is inside the queue, where a Run's turn can come long after the stop.
    async recover(signal?: AbortSignal): Promise<({ runId: string; verdict: Verdict } | { runId: string; error: string })[]> {
      const results = [];
      ledger.continueStranded();
      for (const run of ledger.listActiveRuns()) {
        try {
          const verdict = await serial(run.id, async () => (signal?.aborted ? undefined : verifyLocked(run.id)));
          if (!verdict) return results;
          results.push({ runId: run.id, verdict });
        } catch (err) {
          if (!(err instanceof InputError) && !(err instanceof Unreachable)) throw err;
          // A Run nobody here can read, such as one whose executor has no adapter any
          // more: unknown is what that is.
          const failed = ledger.getRun(run.id);
          if (failed.state !== 'ended') noteUnknown(failed, 'unreachable');
          results.push({ runId: run.id, error: err.message });
        }
      }
      return results;
    },

    // §2: what a backup cannot know about. Reported, never acted on.
    inventoryOrphans: (): Promise<OrphanReport[]> => Promise.all(machines.list().map(orphansOn)),

    // Follows a Run to its end. An unknown Run stays followed: the host may come back.
    async watch(run: RunRow, watching: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<void> {
      const { intervalMs = DEFAULT_POLL_MS, signal } = watching;
      while (!signal?.aborted) {
        await serial(run.id, () => enforceClock(ledger.getRun(run.id)));
        if (ledger.getRun(run.id).state === 'running') await tail(run);
        await verify(run);
        if (ledger.getRun(run.id).state === 'ended') return;
        try {
          await sleep(intervalMs, undefined, { signal });
        } catch {
          return;
        }
      }
    },

    async eventSnapshot(run: RunRow): Promise<EventSnapshot> {
      if (diagnosticsDir) return serial(run.id, () => durableEventSnapshot(run));
      const state = tailOf(run.id);
      if (run.state !== 'ended' || state.events.length > 0) return eventSnapshotOf(state);
      try {
        return { events: await loadEvents(run), firstIndex: 0, loaded: true };
      } catch (error) {
        return eventSnapshotOf(state, (error as Error).message, false);
      }
    },
    async loadEvents(run: RunRow): Promise<readonly NormalizedEvent[]> {
      if (!diagnosticsDir) return loadEvents(run);
      const snapshot = await serial(run.id, () => durableEventSnapshot(run));
      if (!snapshot.loaded) throw new HistoryLoadError(snapshot.reason);
      return snapshot.events;
    },
    pruneDiagnostics,

    async recoverRunReport(run: RunRow) {
      return serial(run.id, async () => {
        const current = ledger.getRun(run.id);
        const saved = ledger.runReport(current.id);
        if (saved) return saved;
        ledger.reportRecoveryReceipt(current.id);
        if (!placeStands(current)) throw new InputError('原执行节点已经移除或重新登记，最后回复未保存，无法恢复');
        if (!credentialCanBeHidden(current)) throw new InputError('原轮次凭据已不可核对，无法安全恢复最后回复');
        if(captureOf(current)){const result=await capturedResult(current);const reading=result.reading;const receipt=reading&&parseReceipt(reading.text);if(!reading?.finished||reading.error||!receipt||reading.text===undefined)throw new InputError(result.issue??'原生结果没有可恢复的完整报告');return ledger.recordRecoveredRunReport(current.id,receipt,reading.text);}
        const host = hostOf(current);
        let remaining = REPORT_RECOVERY_BYTES;
        const raw = async (name: string, required: boolean): Promise<string> => {
          if (remaining <= 0) throw new InputError('历史原输出超过恢复安全上限（8 MiB），无法恢复');
          const chunks: Buffer[] = [];
          let offset = 0, expectedSize: number | undefined, expectedMtime: number | undefined;
          for (;;) {
            const range = await host.readRange(`${runDir(current)}/${name}`, offset, { fileLimitBytes: remaining })
              .catch((error: unknown) => { throw new InputError('历史原输出无法恢复：' + (error as Error).message); });
            if (!placeStands(current) || !credentialCanBeHidden(current)) throw new InputError('原轮次身份或凭据已变化，无法恢复');
            if (range.size === 0 && range.mtime === 0) {
              if (required) throw new InputError('原始输出已不存在，最后回复未保存，无法恢复');
              return '';
            }
            expectedSize ??= range.size; expectedMtime ??= range.mtime;
            if (range.size > remaining || range.size !== expectedSize || range.mtime !== expectedMtime
              || range.bytes.length > remaining - offset || offset + range.bytes.length > range.size
              || (range.bytes.length === 0 && offset < range.size)) throw new InputError('历史原输出超限、不连续或读取中变化，无法恢复');
            chunks.push(range.bytes); offset += range.bytes.length;
            if (offset === range.size) break;
          }
          remaining -= offset;
          try { return hiding(current)(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
          catch { throw new InputError('历史原输出不是完整 UTF-8 文本，无法恢复'); }
        };
        // Read stderr first so a full budget cannot hide whether an error stream exists.
        const stderr = await raw('stderr.log', false);
        const stdout = await raw('stdout.ndjson', true);
        const reading = adapterOf(current).result(stdout, current.exit_code, stderr);
        const receipt = parseReceipt(reading.text);
        if (!reading.finished || reading.error || receipt === null || reading.text === undefined) throw new InputError('历史原输出没有完整、可核对的最终回复，无法恢复');
        return ledger.recordRecoveredRunReport(current.id, receipt, reading.text);
      });
    },

    // The caller has resolved a receipt's report reference to this Run's artifact name.
    // Read through the original node identity without registering or accepting anything.
    async readReportFile(run: RunRow, name: string, maxBytes: number): Promise<Buffer> {
      if (!placeStands(run)) throw new InputError('原执行节点已经移除或重新登记，不能读取旧轮次的报告');
      const host = hostOf(run);
      // Report text fits in one existing read chunk. No directory scan or sibling hash:
      // unregistered output has no authoritative digest to compare against.
      const range = await host.readRange(`${runDir(run)}/artifacts/${name}`, 0, { fileLimitBytes: maxBytes });
      if (!placeStands(run)) throw new InputError('原执行节点已经移除或重新登记，不能读取旧轮次的报告');
      if (range.size === 0 && range.mtime === 0) throw new InputError('执行节点上没有这份报告，文件可能已清理');
      if (range.size > maxBytes || range.bytes.length > maxBytes) throw new InputError('报告超过文本查看上限（128 KiB）');
      if (range.bytes.length !== range.size) throw new InputError('报告在读取时发生变化或未能完整读取，请稍后重试');
      return range.bytes;
    },

    // Bounded head + tail preview of a Run's raw stderr for offline diagnostics.
    // Supports both format-1 bounded capture (`stream: 'stderr'`) and legacy `stderr.log`.
    // Re-verifies node registration and credential hiding across every async read and redacts
    // each full line with the run's live credential hider before slicing.
    async readStderrSnippet(run: RunRow): Promise<{ head: string[]; tail: string[]; loaded: boolean; reason?: string }> {
      const SLICE_BYTES = 32 * 1024;
      const toLines = (buf: Buffer, hide: (text: string) => string): string[] =>
        buf.toString('utf8')
          .split(/\r?\n/)
          .map((line) => redactWorkerDiagnosticText(line.trimEnd(), hide))
          .filter((line) => line.trim() !== '');
      const guardReason = (): string | null =>
        (!placeStands(run) || !credentialCanBeHidden(run)) ? '原轮次登记或凭据不可核对，已跳过 stderr 读取' : null;
      try {
        const initialGuard = guardReason();
        if (initialGuard !== null) return { head: [], tail: [], loaded: false, reason: initialGuard };
        const host = hostOf(run);
        const spec = captureOf(run);
        if (spec) {
          if (!host.readCapture) return { head: [], tail: [], loaded: false, reason: '执行节点需升级后读取有界 stderr' };
          const first = await host.readCapture({ run_dir: runDir(run), source: spec.source, stream: 'stderr', offset: 0, bytes: SLICE_BYTES });
          const afterFirst = guardReason();
          if (afterFirst !== null) return { head: [], tail: [], loaded: false, reason: afterFirst };
          if (first.state !== 'range') return { head: [], tail: [], loaded: false, reason: first.reason };
          const firstBytes = Buffer.from(first.base64, 'base64');
          const headLines = toLines(firstBytes, hiding(run));
          const gapReason = first.gap ? `stderr 存在缺口：${first.gap.from}..${first.gap.to}` : first.issue;
          if (first.committed_end <= first.start + firstBytes.length) {
            return { head: headLines.slice(0, 8), tail: headLines.slice(-20), loaded: true, ...(gapReason ? { reason: gapReason } : {}) };
          }
          const tailOffset = Math.max(first.base, first.committed_end - SLICE_BYTES);
          const last = await host.readCapture({ run_dir: runDir(run), source: spec.source, stream: 'stderr', offset: tailOffset, bytes: SLICE_BYTES });
          const afterLast = guardReason();
          if (afterLast !== null) return { head: [], tail: [], loaded: false, reason: afterLast };
          if (last.state !== 'range') {
            return { head: headLines.slice(0, 8), tail: headLines.slice(-20), loaded: true, reason: last.reason };
          }
          const tailLines = toLines(Buffer.from(last.base64, 'base64'), hiding(run));
          return { head: headLines.slice(0, 8), tail: tailLines.slice(-20), loaded: true, ...(gapReason ? { reason: gapReason } : {}) };
        }
        const path = `${runDir(run)}/stderr.log`;
        const first = await host.readRange(path, 0);
        const afterFirst = guardReason();
        if (afterFirst !== null) return { head: [], tail: [], loaded: false, reason: afterFirst };
        if (first.size === 0 && first.mtime === 0) return { head: [], tail: [], loaded: false, reason: '原始 stderr.log 不存在' };
        const headLines = toLines(first.bytes, hiding(run));
        if (first.size <= first.bytes.length) {
          return { head: headLines.slice(0, 8), tail: headLines.slice(-20), loaded: true };
        }
        const tailOffset = Math.max(0, first.size - SLICE_BYTES);
        const last = await host.readRange(path, tailOffset);
        const afterLast = guardReason();
        if (afterLast !== null) return { head: [], tail: [], loaded: false, reason: afterLast };
        const tailLines = toLines(last.bytes, hiding(run));
        return { head: headLines.slice(0, 8), tail: tailLines.slice(-20), loaded: true };
      } catch (err) {
        return { head: [], tail: [], loaded: false, reason: (err as Error).message || '读取 stderr 失败' };
      }
    },

    // The files a Run left under its own artifacts/, taken over the same read channel the
    // events come by and written into a directory of the host's. What did not hash as the
    // machine said it did is reported, not written. Nothing there is not a failure to
    // report: a machine that is gone leaves the Task's acceptance to go on without it.
    async fetchArtifacts(run: RunRow, into: string): Promise<{ files: ReleaseFile[]; problem: string | null }> {
      try {
        if (!placeStands(run)) return { files: [], problem: '这一轮所在的机器已经不在了，或者已经换成了另一台，没有取产物' };
        const host = hostOf(run);
        const { files, problem } = checkArtifacts(await host.artifacts(runDir(run)));
        if (problem !== null) return { files: [], problem };
        if (files.length === 0) return { files: [], problem: null };
        mkdirSync(into, { recursive: true });
        const kept: ReleaseFile[] = [];
        const refused: string[] = [];
        let total = 0;
        const perFile = options.artifactFileLimitBytes();
        const inAll = options.artifactsLimitBytes();
        for (const { name, sha256, bytes } of files) {
          if (bytes > perFile || total + bytes > inAll) {
            refused.push(`${name} 太大（${bytes} 字节），没有取`);
            continue;
          }
          const chunks: Buffer[] = [];
          for (let offset = 0; offset < bytes;) {
            const { bytes: block } = await host.readRange(`${runDir(run)}/artifacts/${name}`, offset);
            if (block.length === 0) break;
            chunks.push(block);
            offset += block.length;
          }
          const body = Buffer.concat(chunks);
          if (!sameBytes(body, { sha256, bytes })) {
            refused.push(`${name} 取回来和机器上的对不上，没有留下`);
            continue;
          }
          writeFileSync(join(into, name), body);
          total += body.length;
          kept.push({ name, sha256, bytes: body.length });
        }
        return { files: kept, problem: refused.length === 0 ? null : refused.join('；') };
      } catch (err) {
        return { files: [], problem: `取产物失败：${(err as Error).message}` };
      }
    },

    events: (runId: string): readonly NormalizedEvent[] => tailOf(runId).events,
    // Position in the Run's whole event sequence of events()[0], for a reader that
    // numbers events across the ones this log has dropped.
    eventBase: (runId: string): number => Math.max(tailOf(runId).dropped - 1, 0),

    subscribe(runId: string, listener: TailListener): () => void {
      const { listeners } = tailOf(runId);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Runner = ReturnType<typeof createRunner>;
