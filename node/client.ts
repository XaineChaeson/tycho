import {captureController,outputMetadata} from './capture.ts';
import {normalizeCaptureSpec} from '../shared/node-output.ts';
import { entryPublisherOf, isEntryRepairAction } from '../shared/node-protocol.ts';
// The machine's client (docs/design/nodes.md §4, §8): join once, then hold a long poll
// open and do what comes back. Everything it can be asked is in shared/node-protocol.ts;
// nothing else reaches this machine.
//
// The client is not the round's owner: it starts a watch process per round and reads what
// that process writes (node/watch.ts). A client that dies mid-round therefore loses
// nothing — the gate was taken once, and the next client reads the evidence.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { prepareOwnerOnlyDirectory, writeOwnerOnly } from '../service/secrets.ts';
import type { ServiceManagerReport } from '../shared/service-manager.ts';
import type {
  NodeArtifact, NodeCommand, NodeCredentialAnswer, NodeEntryContent, NodeEntryReport, NodeExecutorReport, NodeExecutorStatus, NodeFacts, NodeFileHash, NodeJoinAnswer, NodeJoinRequest,
  NodePollAnswer, NodePollRequest, NodeQuotaStatus, NodeRange, NodeRepairEntryResult, NodeReportRequest, NodeSkillsManifest, NodeSkillsReport, NodeSnapshot, NodeStart, NodeStartResult, NodeStopResult, NodeUpdateExecutorResult,
} from '../shared/node-protocol.ts';
import { HOST_URL_ENV, JOIN_MATERIALS_ENV, NODE_CHUNK_BYTES, NODE_HOLD_HEADER, NODE_POLL_MARGIN_MS, NODE_PROTOCOL, NODE_SKILLS_PACKAGE_PREFIX, signInEnded, wayProblem } from '../shared/node-protocol.ts';
import { defaultExecutorSkillDirs, scanLocalNonMirrorSkills, syncNodeSkills } from './skill-sync.ts';
import type { CommandRun, ExecutorQuestion, TalkRun } from './executors.ts';
import { MODEL_LIST_TIMEOUT_MS, probeExecutors, QUOTA_READ_TIMEOUT_MS, readQuota, shippedQuestions } from './executors.ts';
import { runExecutorUpdate } from './executor-updater.ts';
import { findQuotaPlugin } from './quota-plugins.ts';
import { roundDirs } from './launch.ts';
import { createMachineSignIns } from './sign-in.ts';
import type { SignInOptions } from './sign-in.ts';
import { browseDirs, createDir, renameDir } from './fs-browse.ts';
import { ADAPTERS } from '../adapters/all.ts';
import { readLookupEnv } from './lookup-env.ts';
import type { LookupEnv } from './lookup-env.ts';
import { appVersion } from '../cli/paths.ts';
import { applyEntry, entryTargets, repairEntry } from './global-entry.ts';
import type { EntryOptions } from './global-entry.ts';
import { selectProcesses, stopProbeTree } from './hostprocess.ts';
import { createReleaseFollow, releaseIdle } from './follow.ts';
import type { ReleaseBusy, ReleaseFollowOptions } from './follow.ts';
import type { HostProcesses } from './hostprocess.ts';
import { aliveOf, boxOf, dropRun, dropTaskCode, listRuns, lookAtRound, readWatchEvidence, requestStop, runState, takeGate, Unreadable } from './runbox.ts';
import { machineScope } from './runbox.ts';
import type { ProcessEvidence, RunBox } from './runbox.ts';

// How long a request may take to be answered. Not a setting: the client runs on another
// machine and has no configuration of its own, and these are the client's own patience,
// not behaviour the owner tunes. How long a poll is held is the host's (NODE_HOLD_HEADER).
const DEFAULT_REQUEST_MS = 60_000;
// The same holds for the rest: how long a start, a stop and a reconnect wait, and how long
// a join that was not let in is kept, are this client's own patience.
const START_WAIT_MS = 20_000;
const STOP_GRACE_MS = 10_000;
const STOP_KILL_MS = 2_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

const TOKEN_FILE = 'token';
const JOIN_FILE = 'join.json';
const ID_FILE = 'id';
const PENDING_JOIN_TTL_MS = 24 * 60 * 60 * 1000;

export class NodeHttpError extends Error {
  override name = 'NodeHttpError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// What this machine's client keeps under its data directory. The identity is made once and
// kept: it is not the hostname and not the operating system's machine id, which cloned
// images share (nodes.md §7). It lives under the directory this machine is known by, so that
// two machines sharing one data directory never read each other's identity or evidence.
export interface NodeIdentity {
  id: string;
  dir: string;
  dataDir: string;
}

// The identity this machine already keeps under a data directory, read and not made: for
// whoever asks about the client (an upgrade, an uninstall) without being one.
export function existingIdentity(dataDir: string): NodeIdentity | undefined {
  const nodes = machineScope(dataDir);
  let names: string[];
  try {
    names = readdirSync(nodes);
  } catch {
    return undefined;
  }
  // The identity is the directory: one directory per machine identity, and a name in it.
  const id = names.find((name) => /^[0-9a-f]{32}$/.test(name) && existsSync(join(nodes, name, ID_FILE)));
  return id === undefined ? undefined : { id, dir: join(nodes, id), dataDir };
}

export function identityOf(dataDir: string): NodeIdentity {
  const held = existingIdentity(dataDir);
  if (held !== undefined) return held;
  const nodes = machineScope(dataDir);
  const id = randomBytes(16).toString('hex');
  const dir = join(nodes, id);
  prepareOwnerOnlyDirectory(dir);
  writeOwnerOnly(join(dir, ID_FILE), `${id}\n`);
  return { id, dir, dataDir };
}

export const readToken = (identity: NodeIdentity): string | undefined => {
  try {
    const token = readFileSync(join(identity.dir, TOKEN_FILE), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
};

export function writeToken(identity: NodeIdentity, token: string): void {
  writeOwnerOnly(join(identity.dir, TOKEN_FILE), `${token}\n`);
}

export const clearToken = (identity: NodeIdentity): void => rmSync(join(identity.dir, TOKEN_FILE), { force: true });

// A join the owner has not answered yet, with the secret only this machine holds. Kept so
// that a client restarted while waiting claims the same registration instead of asking for
// a second one (nodes.md §9, "兑换要能重试认领"). The address is part of it: a secret the
// host of one address gave out means nothing at another.
export function readPendingJoin(identity: NodeIdentity): { secret: string; code: string; origin: string } | undefined {
  try {
    const held = JSON.parse(readFileSync(join(identity.dir, JOIN_FILE), 'utf8')) as { secret?: unknown; code?: unknown; origin?: unknown; at?: unknown };
    if (typeof held.secret !== 'string' || typeof held.at !== 'number') return undefined;
    if (Date.now() - held.at > PENDING_JOIN_TTL_MS) return undefined;
    return {
      secret: held.secret,
      code: typeof held.code === 'string' ? held.code : '',
      origin: typeof held.origin === 'string' ? held.origin : '',
    };
  } catch {
    return undefined;
  }
}

export function writePendingJoin(identity: NodeIdentity, pending: { secret: string; code: string; origin: string }): void {
  writeOwnerOnly(join(identity.dir, JOIN_FILE), `${JSON.stringify({ ...pending, at: Date.now() })}\n`);
}

export const clearPendingJoin = (identity: NodeIdentity): void => rmSync(join(identity.dir, JOIN_FILE), { force: true });

// `tycho node leave`: this machine stops taking work. The mark is local because the running
// client is another process in another terminal — the host cannot reach it — and because
// leaving is this machine's own act: the machine on the host stays until the owner deletes it
// (nodes.md §9). A later join clears it.
const LEFT_FILE = 'left';
export const leaveRequested = (identity: NodeIdentity): boolean => existsSync(join(identity.dir, LEFT_FILE));
export const requestLeave = (identity: NodeIdentity): void => writeFileSync(join(identity.dir, LEFT_FILE), `${new Date().toISOString()}\n`);
export const clearLeave = (identity: NodeIdentity): void => rmSync(join(identity.dir, LEFT_FILE), { force: true });

// `tycho node service stop`: the client running under this identity is asked to leave its
// loop, by the pid it holds the lock with. Asked of the client itself and never of its
// service manager, because a manager's stop ends everything the client started — systemd's
// cgroup, a scheduled task's job — and the rounds running under their own watch processes
// are exactly what must go on (nodes.md §4.2). The mark names the pid so that one left
// behind by a client that died before reading it is not an order for the next client.
// Unlike a leave, the machine stays joined: the next start takes work again.
const STOP_FILE = 'stop';
export const requestClientStop = (identity: NodeIdentity, pid: number): void => writeFileSync(join(identity.dir, STOP_FILE), `${pid}\n`);
export function clientStopRequestedFor(identity: NodeIdentity, pid: number): boolean {
  try {
    return Number(readFileSync(join(identity.dir, STOP_FILE), 'utf8').trim()) === pid;
  } catch {
    return false;
  }
}
export const clearClientStop = (identity: NodeIdentity): void => rmSync(join(identity.dir, STOP_FILE), { force: true });
// How often a running client looks for a stop or a leave asked of it from another process.
const STOP_CHECK_MS = 1000;

export function factsOf(identity: NodeIdentity, name?: string): NodeFacts {
  const release = `${process.platform} ${process.version}`;
  return {
    node_id: identity.id,
    name: name ?? hostname() ?? 'machine',
    platform: release,
    hostname: hostname() ?? '',
  };
}

// Where the watch entry is, as this program spells it.
const watchEntry = (): string => join(import.meta.dirname, 'watch.ts');

// A request ends by itself after `ms`, or after the limit it is given again, and a stop
// ends it at once. The timer does not keep this process alive: a client that has been told
// to stop has to be able to leave.
function within(ms: number, signal?: AbortSignal): { signal: AbortSignal; done(): void; again(ms: number): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (limit: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`请求超过 ${limit} 毫秒没有回答`)), limit);
    timer.unref?.();
  };
  arm(ms);
  return {
    signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
    done: () => clearTimeout(timer),
    again: arm,
  };
}

// The hold a poll's answer says the host is keeping it for, when it says one.
function holdOf(response: Response): number | undefined {
  const said = response.headers.get(NODE_HOLD_HEADER);
  const hold = said === null ? Number.NaN : Number(said);
  return Number.isSafeInteger(hold) && hold >= 0 ? hold : undefined;
}

interface ClientOptions {
  serviceManager?: () => ServiceManagerReport | undefined;
  dataDir: string;
  origin: string;
  token: string;
  facts: NodeFacts;
  procs?: HostProcesses;
  log?: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  // How this machine asks its own executors about themselves (nodes.md §1.2). The program's
  // own declarations and this machine's login shell unless a test stands them in: no test may
  // run a real executor's command.
  executors?: { questions?: ExecutorQuestion[]; run?: CommandRun; talk?: TalkRun; timeoutMs?: number; modelsTimeoutMs?: number; quotaTimeoutMs?: number; now?: () => number };
  // The version this client tells an executor it is, where an executor's own conversation names
  // one (the Codex app-server handshake). The program's own version unless a test gives one.
  version?: string;
  // How this machine's lookup environment is read (node/lookup-env.ts); a test gives its own.
  lookupEnv?: () => Promise<LookupEnv>;
  // Where the executors' own directories are, for the global entry: this process's environment
  // and home unless a test points them elsewhere (node/global-entry.ts).
  entry?: Pick<EntryOptions, 'env' | 'home'>;
  // Optional overrides for Host -> Node incremental skill bundle mirroring.
  skills?: { linkDirs?: readonly string[]; skipLinkDirs?: readonly string[]; enabled?: boolean };
  // Whether this machine has been told to stop taking work (`tycho node leave`, another
  // process in another terminal). Asked between polls; the rounds already running are not
  // this client's to end.
  stopped?: () => boolean;
  // The adapters whose sign-in this machine may run (node/sign-in.ts): the program's own unless
  // a test stands one in. No test may run a real executor's sign-in.
  signIn?: { adapters?: SignInOptions['adapters'] };
  // Where this client follows the host's version from (docs/design/nodes.md §1.4). Absent in a
  // test that does not exercise it: nothing then asks the host which version to run. The
  // program directory is this process's own unless a test runs a client of another one.
  release?: {
    identityDir: string;
    appRoot?: string;
    update?: ReleaseFollowOptions['update'];
    fetch?: ReleaseFollowOptions['fetch'];
    now?: ReleaseFollowOptions['now'];
  };
}

// The join itself, which needs no token: the six digits point at the request, and the
// secret the machine kept is what exchanges for one (docs/design/nodes.md §9). It is one
// function so that `tycho node join` and a test reach the host the same way.
export async function joinHost(options: {
  origin: string;
  facts: NodeFacts;
  claim?: { secret: string };
  // The other way in (nodes.md §1.3): a one-time material and the secret this machine made
  // for it, in place of the six digits.
  invite?: { material: string; secret: string };
  fetch?: typeof globalThis.fetch;
}): Promise<NodeJoinAnswer> {
  const doFetch = options.fetch ?? globalThis.fetch;

  const response = await doFetch(`${options.origin.replace(/\/+$/, '')}/api/node/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: NODE_PROTOCOL, facts: options.facts,
      ...(options.claim === undefined ? {} : { claim: options.claim }),
      ...(options.invite === undefined ? {} : { invite: options.invite }),
    } satisfies NodeJoinRequest),
    signal: within(DEFAULT_REQUEST_MS).signal,
  });
  const text = await response.text();
  const answer = (text ? JSON.parse(text) : {}) as NodeJoinAnswer & { error?: string };
  if (!response.ok) throw new NodeHttpError(response.status, answer.error ?? `加入失败：主机回答 ${response.status}`);
  return answer;
}

// How many rounds this machine still has something to answer for: alive, or not readable at
// all. A round whose ending is recorded is over, and does not keep a version swap waiting.
// Rounds of another machine identity sharing the data directory have no evidence here and are
// not this machine's to wait for (nodes.md §1.4, §7).
export async function busyRuns(dataDir: string, procs: HostProcesses): Promise<number> {
  let runs = 0;
  for (const held of listRuns(dataDir)) {
    const box = boxOf(dataDir, held.relative);
    if (!existsSync(join(box.runDir, 'started')) || !existsSync(box.procDir)) continue;
    if (aliveOf(await runState(box, procs)).alive !== false) runs += 1;
  }
  return runs;
}

export function createClient(options: ClientOptions) {
  const { dataDir, origin } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const procs = options.procs ?? selectProcesses();
  const output=captureController(dataDir,options.facts.node_id,procs);
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = origin.replace(/\/+$/, '');

  async function call<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal, held = false): Promise<T> {
    const clock = within(timeoutMs, signal);
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ protocol: NODE_PROTOCOL, ...(body as object) }),
        // A stop ends the request it is waiting on: a poll held open would otherwise keep
        // this process alive until the hold runs out.
        signal: clock.signal,
      });
      // A held poll waits as long as the host said it holds it, and the way between them.
      const hold = held ? holdOf(response) : undefined;
      if (hold !== undefined) clock.again(hold + NODE_POLL_MARGIN_MS);
      const text = await response.text();
      if (!response.ok) {
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // Not JSON: the text is what there is.
        }
        throw new NodeHttpError(response.status, message || `主机回答 ${response.status}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clock.done();
    }
  }

  const post = <T>(path: string, body: unknown, timeoutMs = DEFAULT_REQUEST_MS, signal?: AbortSignal, held = false): Promise<T> => call<T>(path, body, timeoutMs, signal, held);

  async function get<T>(path: string, timeoutMs = DEFAULT_REQUEST_MS): Promise<T> {
    const clock = within(timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${options.token}` },
        signal: clock.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new NodeHttpError(response.status, text);
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clock.done();
    }
  }

  // What this machine last read from its own executors (nodes.md §1.2). Asked when the
  // client starts, again on a clock, and at once when the host asks for it. One look at a
  // time: a timer and a probe landing together must not run the same commands twice, and a
  // look that fails leaves the last report standing rather than emptying the page.
  let executors: NodeExecutorReport | null = null;
  let looking: Promise<NodeExecutorReport> | null = null;
  const questions = options.executors?.questions ?? shippedQuestions();

  // The one environment this machine finds its executors' commands in (node/lookup-env.ts):
  // read again at every look at the executors, which is when the owner expects a newly
  // installed one to be seen, and handed to each round's watch process as it stands then, so
  // that a round starts the command the last report named.
  let lookup: Promise<LookupEnv> | null = null;
  function refreshLookup(): Promise<LookupEnv> {
    const reading = (options.lookupEnv ?? (() => readLookupEnv()))().then((read) => {
      if (read.problem !== undefined) log(read.problem);
      return read;
    });
    lookup = reading;
    return reading;
  }
  const lookupEnv = async (): Promise<NodeJS.ProcessEnv> => (await (lookup ?? refreshLookup())).env;

  // The executors' own sign-ins this machine was asked to run (docs/design/native-login.md).
  // A sign-in that ends 0 makes the machine look at its executors at once: the host hears the
  // login before the clock would have told it.
  const signIns = createMachineSignIns({
    adapters: options.signIn?.adapters ?? ADAPTERS,
    lookupEnv,
    exclude: roundDirs(dataDir),
    procs,
    log,
    onDone: () => void look(),
  });

  // The poll loop's own signal: a leave, a retire, or a version swap ends it (see below).
  const leaving = new AbortController();

  // What "this machine is idle" means for a version swap (docs/design/nodes.md §1.4). The poll
  // loop answers it from its own survey (busyNow, below); this look is for the 426 path, where
  // the loop is gone and nothing else would notice a round that is still running. Rounds are
  // this client's own: a shared data directory holds other machines' rounds too, and their
  // process evidence is not here, so only a round with this machine's own evidence directory
  // counts. A round that cannot be read is "not idle": unknown is not over.
  async function releaseBusy(): Promise<ReleaseBusy> {
    return {
      runs: await busyRuns(dataDir, procs),
      commands: inFlight.size,
      signIns: signIns.report().filter((each) => !signInEnded(each.state)).length,
    };
  }

  const follower = options.release === undefined ? null : createReleaseFollow({
    appRoot: options.release.appRoot ?? join(import.meta.dirname, '..'),
    identityDir: options.release.identityDir,
    origin: base,
    token: options.token,
    log,
    busy: releaseBusy,
    stopPolling: () => leaving.abort(),
    ...(options.release.update === undefined ? {} : { update: options.release.update }),
    // The same way this client reaches the host, unless the test that stood one in for the
    // client gave the follower another.
    ...((options.release.fetch ?? options.fetch) === undefined ? {} : { fetch: (options.release.fetch ?? options.fetch)! }),
    ...(options.release.now === undefined ? {} : { now: options.release.now }),
  });

  function look(): Promise<NodeExecutorReport> {
    looking ??= refreshLookup().then((read) => probeExecutors({
      questions,
      env: read.env,
      exclude: roundDirs(dataDir),
      ...(options.executors?.run === undefined ? {} : { run: options.executors.run }),
      ...(options.executors?.timeoutMs === undefined ? {} : { timeoutMs: options.executors.timeoutMs }),
      // Its own span, as the host last said it (node.modelListTimeoutMs); until then the
      // client's own 30 seconds, which is what a client of an older host keeps.
      modelsTimeoutMs: options.executors?.modelsTimeoutMs ?? modelsTimeout ?? MODEL_LIST_TIMEOUT_MS,
      ...(options.executors?.now === undefined ? {} : { now: options.executors.now }),
    }).then((report) => {
      executors = report;
      // Beside the report, never in front of it: what a read of a login's own quota learns
      // rides a later report (startQuotaReads).
      startQuotaReads(report, read.env);
      // An executor found since the entry was last written gets it now.
      writeEntry();
      return report;
    })).catch((error: unknown) => {
      // Nothing here is a reason to stop working: the machine keeps its rounds, and the page
      // keeps whatever it was last told.
      log(`问这台机器上的执行器失败：${(error as Error).message}`);
      return executors ?? { at: new Date().toISOString(), executors: [] };
    }).finally(() => {
      looking = null;
    });
    return looking;
  }

  // --- what this machine's own logins' quota is (docs/design/usage.md §3) --------------------
  //
  // A login that lives on this machine can only be asked here, so its executor's own declaration
  // (Adapter.machineQuota) says how, and the answer is parsed here: only the windows leave the
  // machine. The read is started when a look ends and is not waited for — the Claude Code one
  // took 55 seconds when it was measured — so a report is never late for it; what it learns is
  // put into the report that was just read, and the next poll carries it. One read per executor
  // at a time: the clock may look again while one is still going, and two of these commands at
  // once would be two turns of a session on that machine.
  //
  // Nothing a read started outlives this client (nodes.md §4.2). The client's own leaving sets
  // the stop below: a read under way ends its command's tree and confirms that with the process
  // table before it hands back, and one a look would start after the stop began is not started
  // at all. A tree a read could not confirm gone is still owed an ending — it is stopped and
  // looked at again by run's own ending, which is the last moment anyone can.
  const quotaReads = new Map<string, Promise<void>>();
  const stopQuotaReads = new AbortController();
  const owedQuota = new Map<number, string>();
  // The program's own version, read where the program says it is.
  const version = options.version ?? ((): string => {
    try {
      return appVersion(join(import.meta.dirname, '..'));
    } catch {
      return 'unknown';
    }
  })();

  // Only an executor that is here, is not a version this program cannot work with, and either
  // reported itself signed in or said nothing about it: a login the machine says it is not
  // signed in to has no quota to read.
  const quotable = (status: NodeExecutorStatus): boolean =>
    status.installed && status.unusable === undefined && status.logged_in !== false;

  const sameQuotaOwner = (a: NodeExecutorStatus, b: NodeExecutorStatus): boolean =>
    a.identity?.organizationId === b.identity?.organizationId && a.identity?.quotaOwner === b.identity?.quotaOwner;

  function startQuotaReads(report: NodeExecutorReport, env: NodeJS.ProcessEnv): void {
    // A stop that has begun is not a moment to start one: the client is leaving, and a command
    // started now would have nobody left to end it (see run's own ending).
    if (stopQuotaReads.signal.aborted) return;
    for (const status of report.executors) {
      const way = questions.find((each) => each.executor === status.executor)?.quota;
      const hasPlugin = findQuotaPlugin(status.executor, env) !== null;
      if ((way === undefined && !hasPlugin) || !quotable(status) || quotaReads.has(status.executor)) continue;
      const going = readQuota(way, {
        executor: status.executor,
        version,
        timeoutMs: options.executors?.quotaTimeoutMs ?? quotaTimeout ?? QUOTA_READ_TIMEOUT_MS,
        ...(options.executors?.run === undefined ? {} : { run: options.executors.run }),
        ...(options.executors?.talk === undefined ? {} : { talk: options.executors.talk }),
        exclude: roundDirs(dataDir),
        env,
        signal: stopQuotaReads.signal,
        // A tree this read could not confirm gone keeps its ending owed here (run's own ending).
        onOwed: (pid, argv) => owedQuota.set(pid, argv.join(' ')),
        ...(options.executors?.now === undefined ? {} : { now: options.executors.now }),
      }).then((answer) => keepQuota(status, answer)).catch(() => {}).finally(() => {
        quotaReads.delete(status.executor);
        // A probe found a new login while the previous one was still reading. It could not
        // start its own read until that command ended.
        if (executors && executors.executors.some((current) => current.executor === status.executor
          && quotable(current) && !sameQuotaOwner(current, status))) void look();
      });
      quotaReads.set(status.executor, going);
    }
  }

  // A reading belongs to the login seen before it started. A new probe may have found a
  // different login while the command was running.
  function keepQuota(login: NodeExecutorStatus, answer: NodeQuotaStatus): void {
    const report = executors;
    if (report === null) return;
    const at = report.executors.findIndex((each) => each.executor === login.executor);
    const current = report.executors[at];
    if (!current || !quotable(current) || !sameQuotaOwner(current, login)) return;
    const held = current.quota;
    if (held !== undefined && Date.parse(held.at) >= Date.parse(answer.at)) return;
    report.executors[at] = { ...current, quota: answer };
  }

  // The global entry: apply new content and newly found executors immediately, then recheck
  // before each normal poll. Another publisher may have changed the file without our content
  // changing; this lightweight check never probes executors, logins or models.
  // Name the content even when applying it fails, so the host need not resend the same content
  // to retry: the next poll reports a fresh attempt and the actual projection.
  let entryContent: NodeEntryContent | null = null;
  let entryReport: NodeEntryReport = { digest: null, at: new Date().toISOString(), executors: [] };
  function writeEntry(): void {
    if (entryContent === null || executors === null) return;
    const installed = executors.executors.filter(({ installed }) => installed).map(({ executor }) => executor);
    try {
      const statuses = applyEntry(entryContent, entryTargets(installed), options.entry ?? {});
      entryReport = { digest: entryContent.digest, at: new Date().toISOString(), executors: statuses };
    } catch (error) {
      log(`写执行器的全局指令入口没做成：${(error as Error).message}`);
    }
  }
  function takeEntry(value: unknown): void {
    const given = value as Partial<NodeEntryContent> | undefined;
    if (given === null || typeof given !== 'object' || typeof given.digest !== 'string' || !Array.isArray(given.revisions)
      || !given.revisions.every((each) => typeof each === 'string') || (given.text !== null && typeof given.text !== 'string')) return;
    const publisher = entryPublisherOf(given.publisher);
    entryContent = { publisher, digest: given.digest, revisions: given.revisions, text: given.text, ...(typeof given.problem === 'string' ? { problem: given.problem } : {}) };
    writeEntry();
  }

  const LOCAL_SKILLS_REFRESH_MS = 60_000;
  let skillsReport: NodeSkillsReport = { digest: '', synced: [] };
  let localSkillsAt = 0;
  let skillsSyncChain: Promise<void> = Promise.resolve();
  let desiredSkills: NodeSkillsManifest | null = null;
  function resolvedSkillDirs(): { mirrorDir: string; linkDirs: readonly string[]; skipLinkDirs: readonly string[] } {
    return {
      mirrorDir: join(machineScope(dataDir), 'skills-mirror'),
      linkDirs: options.skills?.linkDirs ?? defaultExecutorSkillDirs(options.entry?.env, options.entry?.home),
      skipLinkDirs: [join(dataDir, 'skills'), ...(options.skills?.skipLinkDirs ?? [])],
    };
  }
  function refreshLocalSkills(force = false): void {
    if (options.skills?.enabled === false) return;
    const nowMs = Date.now();
    if (!force && nowMs - localSkillsAt < LOCAL_SKILLS_REFRESH_MS) return;
    localSkillsAt = nowMs;
    try {
      const scanned = scanLocalNonMirrorSkills(resolvedSkillDirs());
      skillsReport = { ...skillsReport, local_skills: scanned };
    } catch {
      // Never fail a poll because a local skill directory could not be scanned.
    }
  }
  async function getBinary(path: string, timeoutMs = DEFAULT_REQUEST_MS): Promise<Buffer> {
    const clock = within(timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${options.token}` },
        signal: clock.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new NodeHttpError(response.status, text || `HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clock.done();
    }
  }
  function takeSkills(value: unknown): void {
    if (options.skills?.enabled === false) return;
    const given = value as Partial<NodeSkillsManifest> | undefined;
    if (given === null || typeof given !== 'object' || typeof given.digest !== 'string' || !Array.isArray(given.items)) return;
    desiredSkills = given as NodeSkillsManifest;
    skillsSyncChain = skillsSyncChain.then(async () => {
      const manifest = desiredSkills;
      if (manifest === null || manifest.digest === skillsReport.digest) return;
      const { mirrorDir, linkDirs, skipLinkDirs } = resolvedSkillDirs();
      if (manifest.items.length === 0 && !existsSync(mirrorDir)) {
        const scanned = scanLocalNonMirrorSkills({ mirrorDir, linkDirs, skipLinkDirs });
        localSkillsAt = Date.now();
        skillsReport = { digest: manifest.digest, synced: [], local_skills: scanned };
        return;
      }
      try {
        skillsReport = await syncNodeSkills({
          mirrorDir,
          manifest,
          fetchBundle: (slug) => getBinary(`${NODE_SKILLS_PACKAGE_PREFIX}/${encodeURIComponent(slug)}`),
          linkDirs,
          skipLinkDirs,
        });
        localSkillsAt = Date.now();
      } catch (error) {
        log(`同步主机技能包失败：${(error as Error).message}`);
        skillsReport = { ...skillsReport, error: (error as Error).message };
      }
    });
  }

  // Told by the host that this machine's work is over (an ephemeral machine whose task has
  // ended): it answers, leaves, and stops polling. True once the leave has been taken.
  let retired = false;

  // A path the host sent is relative to this machine's data directory, and stays inside
  // it: nothing here takes an absolute path or a way out of the tree.
  function inside(relative: string): string {
    const clean = relative.replace(/^\.tycho\//, '').replace(/\\/g, '/');
    if (clean.split('/').includes('..')) throw new Error(`路径不能用：${relative}`);
    const full = resolve(dataDir, ...clean.split('/'));
    const root = resolve(dataDir);
    if (full !== root && !full.startsWith(root + sep)) throw new Error(`路径不在数据目录里：${relative}`);
    // A lexical child can be a junction into another Run (or outside this data root).
    // Trust the configured root itself; below it, outputs must be ordinary tree entries.
    let at = root;
    for (const part of full.slice(root.length + 1).split(sep).filter(Boolean)) {
      at = join(at, part);
      const entry = lstatSync(at, { throwIfNoEntry: false });
      if (!entry) break;
      if (entry.isSymbolicLink()) throw new Error(`路径包含链接，不能读取这一轮的文件：${relative}`);
    }
    return full;
  }

  async function prepare(command: { run_dir: string }): Promise<NodeFileHash[]> {
    const box = boxOf(dataDir, command.run_dir);
    const runId = box.runId;
    const answer = await get<NodeSnapshot>(`/api/node/runs/${encodeURIComponent(runId)}/snapshot`);
    const finalDir = join(box.runDir, 'snapshot');
    // The whole snapshot or none of it: written under another name and moved into place once
    // every file is there, so a prepare cut short leaves no snapshot/ a start would take — a
    // read-only round whose access.json had not arrived would otherwise be started writable.
    const snapshotDir = join(box.runDir, `snapshot.incoming.${process.pid}`);
    rmSync(finalDir, { recursive: true, force: true });
    rmSync(snapshotDir, { recursive: true, force: true });
    mkdirSync(snapshotDir, { recursive: true });
    const written: NodeFileHash[] = [];
    for (const file of answer.files) {
      const body = file.encoding === 'base64' ? Buffer.from(file.text, 'base64') : Buffer.from(file.text, 'utf8');
      const at = resolve(snapshotDir, ...file.path.split('/'));
      if (!at.startsWith(resolve(snapshotDir) + sep)) throw new Error(`快照里的路径不能用：${file.path}`);
      mkdirSync(join(at, '..'), { recursive: true });
      writeFileSync(at, body);
      written.push({ path: file.path, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length });
    }
    renameSync(snapshotDir, finalDir);
    return written;
  }

  // The watch process, with the credential and the Worker's environment handed to it in
  // its own environment: neither is on a command line, in a file, or in anything the host
  // reads back. The watch takes both out of the environment it gives the Worker, which gets
  // the credential the way its executor reads it instead (nodes.md §9).
  async function startWatch(box: RunBox, command: NodeStart, credential: string | undefined, materials: string[] | null, githubToken: string | undefined): Promise<NodeStartResult> {
    const meta=outputMetadata(dataDir,command.run_dir);
    if(meta){if(command.source!==meta.capture.source||!await output.pool.lease(meta.capture.source,box.relative))return {code:2,pid:null,started_at:null,confirmed:false,error:'输出预留不存在或绑定不符，未启动'};}
    else if(command.source!==undefined)return {code:2,pid:null,started_at:null,confirmed:false,error:'缺输出元数据，未启动'};
    const args = [
      watchEntry(),
      `--data=${dataDir}`,
      `--run=${command.run_dir}`,
      `--round=${command.round}`,
      ...(command.source===undefined?[]:[`--source=${command.source}`,`--node-id=${options.facts.node_id}`]),
      ...(command.credential === null ? [] : [`--credential=${command.credential.variable}`]),
      ...(command.timeout_ms === undefined ? [] : [`--timeout-ms=${command.timeout_ms}`]),
      ...(command.model_idle_timeout_ms === undefined ? [] : [`--model-idle-timeout-ms=${command.model_idle_timeout_ms}`]),
      '--',
      ...command.argv,
    ];
    // A round that may spawn machines gets their materials and the address they join at in
    // its environment, by way of the same handover as the credential (nodes.md §1.3). The
    // address is the one this client polls: it is reachable from here.
    const env = materials === null ? command.env : { ...command.env, [JOIN_MATERIALS_ENV]: materials.join(' '), [HOST_URL_ENV]: base };
    // Where the Worker's command is found. The watch inherits this process's environment, so
    // only one read elsewhere (a login shell's) is handed over; on Windows it is that one.
    const found = await lookupEnv();
    const handedLookup = found === process.env ? undefined : (found as Record<string, string>);
    const child = spawnWatch(args, dataDir, {
      env,
      ...(credential === undefined ? {} : { credential }),
      ...(githubToken === undefined ? {} : { githubToken }),
      ...(handedLookup === undefined ? {} : { lookup: handedLookup }),
    });
    child.unref();
    // Either the watch registers itself (pid and the moment it began), or it leaves with
    // one of the codes the client reports. Nothing else is a reason to start anything.
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        log(`第 ${command.round} 轮的看管进程没能启动：${error.message}`);
        resolve(null);
      });
      child.once('exit', (code) => resolve(code));
    });
    const deadline = Date.now() + START_WAIT_MS;
    let exitCode: number | null | undefined;
    void exited.then((code) => {
      exitCode = code;
    });
    // A registration that cannot be read confirms nothing: the wait goes on, and past it the
    // host asks state, which says what cannot be read.
    const registered = (): ProcessEvidence => {
      try {
        return readWatchEvidence(box);
      } catch (error) {
        if (error instanceof Unreadable) return {};
        throw error;
      }
    };
    for (;;) {
      const evidence = registered();
      if (evidence.pid === child.pid && evidence.pid !== undefined) {
        return { code: 0, confirmed: true, pid: evidence.pid, started_at: evidence.at ?? null };
      }
      if (exitCode !== undefined && exitCode !== null) {
        // A code of its own is the watch's answer; anything else is "nothing was started".
        const codes = [3, 4, 6];
        return { code: codes.includes(exitCode) ? exitCode : 2, confirmed: false, pid: null, started_at: null };
      }
      if (Date.now() > deadline) {
        // The gate may be this round's and the evidence not written yet. The host asks
        // state rather than sending the start again (nodes.md §4.2).
        log(`第 ${command.round} 轮的看管进程 ${START_WAIT_MS} 毫秒内没有登记自己：改问状态，不重发启动`);
        return { code: 0, confirmed: false, pid: null, started_at: null };
      }
      await sleep(100);
    }
  }

  const updatingExecutors = new Set<string>();

  async function start(command: NodeStart): Promise<NodeStartResult> {
    if (updatingExecutors.size > 0) {
      return {
        code: 2,
        confirmed: false,
        pid: null,
        started_at: null,
        error: `本机正在更新执行器（${[...updatingExecutors].join(', ')}），暂不启动新轮次`,
      };
    }
    const box = boxOf(dataDir, command.run_dir);
    if (!existsSync(join(box.runDir, 'snapshot', 'brief.md'))) {
      return { code: 2, confirmed: false, pid: null, started_at: null, error: '这一轮的快照还没有落盘，不启动' };
    }
    // The host names the variable; one no system takes is a round that does not start here.
    const wrongWay = wayProblem(command.credential);
    if (wrongWay !== undefined) return { code: 2, confirmed: false, pid: null, started_at: null, error: wrongWay };
    let credential: string | undefined;
    let materials: string[] | null = null;
    let githubToken: string | undefined;
    if (command.credential !== null || command.invite === true || command.github === true) {
      try {
        const answer = await post<NodeCredentialAnswer>(`/api/node/runs/${encodeURIComponent(box.runId)}/credential`, {});
        if (command.credential !== null) {
          if (typeof answer.value !== 'string' || answer.value === '') throw new Error('主机没有给这一轮的令牌');
          credential = answer.value;
        }
        // A quota that closed between the dispatch and now gives none: the round starts
        // without, and its Worker finds no materials.
        materials = command.invite === true && answer.materials !== null && answer.materials.length > 0 ? answer.materials : null;
        if (typeof answer.github_token === 'string' && answer.github_token !== '') {
          githubToken = answer.github_token;
        }
      } catch (error) {
        // If only the optional managed GitHub token was requested and GitHub was disconnected
        // between poll and start (409), continue starting the round without it.
        if (!(command.credential === null && command.invite !== true && error instanceof NodeHttpError && error.status === 409)) {
          return { code: 2, confirmed: false, pid: null, started_at: null, error: `取不到这一轮的凭据：${(error as Error).message}` };
        }
      }
    }
    return startWatch(box, command, credential, materials, githubToken);
  }

  // Only "nothing of this round is there" is an answer; a machine that cannot tell says
  // so, and the caller keeps treating the round as possibly alive (nodes.md §4.3). A round
  // whose ending was recorded is answered from that record, without a scan.
  async function stillThere(box: RunBox): Promise<NodeStopResult> {
    return aliveOf(await runState(box, procs));
  }

  async function stop(command: { run_dir: string }): Promise<NodeStopResult> {
    const box = boxOf(dataDir, command.run_dir);
    // The revocation first, then the gate, then the processes: whatever a start on its way
    // does from here on, it sees the stop (nodes.md §4.1).
    requestStop(box);
    // Taking the gate keeps a start on its way from launching after the stop; one already
    // there is a start that got there first, and its stop mark is written above.
    takeGate(box);
    // What is stopped is what this machine can point at *now*, not the pid that was written
    // when the round started: the watch process can be gone while its Worker runs on
    // (nodes.md §4.3). A pid that is no longer this round's is never signalled.
    const first = await lookAtRound(box, procs);
    // While the watch process is still alive (`watchHolder === 'ours'`, so its pid is in
    // `first.roots`), signal only the worker PIDs during the grace window so `watch.ts` can
    // flush output, finish capture, and preserve `session_ref` (critical on Windows where
    // `endGroup` uses `taskkill /T /F`). Force-kill `watch.pid` only after STOP_GRACE_MS.
    let watchPid: number | undefined;
    try {
      const watch = readWatchEvidence(box);
      if (watch.pid !== undefined && first.roots.includes(watch.pid)) {
        watchPid = watch.pid;
      }
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
    }
    const graceRoots = watchPid === undefined ? first.roots : first.roots.filter((pid) => pid !== watchPid);
    const graceLive = watchPid === undefined ? first.live : first.live.filter((pid) => pid !== watchPid);
    for (const pid of graceRoots) await procs.endGroup(pid, 'INT');
    for (const pid of graceLive.filter((each) => !first.roots.includes(each))) await procs.endTree(pid, 'INT');
    const deadline = Date.now() + STOP_GRACE_MS;
    for (let there = await stillThere(box); there.alive === true && Date.now() < deadline; there = await stillThere(box)) {
      await sleep(200);
    }
    if ((await stillThere(box)).alive === true) {
      const again = await lookAtRound(box, procs);
      for (const pid of again.roots) await procs.endGroup(pid, 'KILL');
      for (const pid of again.live.filter((each) => !again.roots.includes(each))) await procs.endTree(pid, 'KILL');
      const killDeadline = Date.now() + STOP_KILL_MS;
      while ((await stillThere(box)).alive === true && Date.now() < killDeadline) await sleep(200);
    }
    return stillThere(box);
  }

  // The closed set of §4.1, and nothing else. Everything a command can be is in the
  // protocol; an unknown kind is a machine and a host that disagree about the version.
  async function execute(command: NodeCommand): Promise<unknown> {
    switch (command.kind) {
      case 'prepare':
        return prepare(command);
      case 'start':
        return start(command);
      case 'stop':
        return stop(command);
      case 'state':
        return runState(boxOf(dataDir, command.run_dir), procs);
      case 'list': {
        const runs = [];
        for (const held of listRuns(dataDir)) {
          const box = boxOf(dataDir, held.relative);
          if (!existsSync(join(box.runDir, 'started'))) continue;
          const { alive } = aliveOf(await runState(box, procs));
          // A round this machine cannot vouch for is not one it may leave out: the host's
          // sweep goes by this listing to stop what it has ended (nodes.md §4.4).
          if (command.alive_only && alive === false) continue;
          runs.push({ task_id: held.task_id, run_id: held.run_id, alive });
        }
        return runs;
      }
      case 'prepare_capture': {
        const spec=normalizeCaptureSpec(command.spec);const reserved=await output.prepare(command.run_dir,spec);
        if(reserved.state!=='ready')return reserved;
        const files=await prepare(command);const meta=outputMetadata(dataDir,command.run_dir);
        if(!meta||JSON.stringify(meta.capture)!==JSON.stringify(spec))throw new Error('快照输出绑定不符，未启动');
        return {state:'ready',files};
      }
      case 'read_capture':
        return output.pool.readCapture({...command,bytes:Math.min(command.bytes,256*1024)});
      case 'read_result':
        return output.pool.readResult({...command,bytes:Math.min(command.bytes,256*1024)});
      case 'read_output':
        return readOutput(command);
      case 'read_file':
        return readOutput(command, true);
      case 'artifacts':
        return artifacts(boxOf(dataDir, command.run_dir));
      case 'drop_run':
        await dropRun(boxOf(dataDir, command.run_dir), procs);
        return { dropped: true };
      // A finished work's code copy on this machine (service/retention.ts). Only that Task's
      // repo/: its rounds' records stay, and the command is safe to repeat.
      case 'drop_task_code':
        await dropTaskCode(dataDir, command.task_dir, procs);
        return { dropped: true };
      // The one command that asks nothing about a round: what the executors on this machine
      // are, asked again now (nodes.md §1.2). It carries no arguments, so what runs is this
      // machine's own closed set and nothing else.
      case 'probe':
        return look();
      // An ephemeral machine's work here is over (nodes.md §1.3). Answered first; the leave
      // goes out once the answer has (see pollLoop).
      case 'retire':
        return { leaving: true };
      // An executor's own sign-in, by name: the command is this machine's adapter's, and of what
      // the host sent only the id, the executor and the limit are read.
      case 'sign_in':
        return signIns.start({ sign_in_id: command.sign_in_id, executor: command.executor, timeout_ms: command.timeout_ms });
      case 'sign_in_code':
        return signIns.submitCode(String(command.sign_in_id), String(command.code));
      case 'sign_in_cancel':
        return signIns.cancel(String(command.sign_in_id));
      case 'browse_dirs':
        return browseDirs({ path: command.path, show_hidden: command.show_hidden });
      case 'create_dir':
        return createDir({ parent: command.parent, name: command.name });
      case 'rename_dir':
        return renameDir({ path: command.path, name: command.name });
      case 'repair_entry': {
        if (typeof command.executor !== 'string' || command.executor.trim() === '') throw new Error('缺少要修复的执行器名称');
        if (!isEntryRepairAction(command.action)) throw new Error(`不支持的入口修复方式：${String(command.action)}`);
        const given = command.content as Partial<NodeEntryContent> | undefined;
        if (given === null || typeof given !== 'object' || typeof given.digest !== 'string' || !Array.isArray(given.revisions)
          || !given.revisions.every((each) => typeof each === 'string') || (given.text !== null && typeof given.text !== 'string')) {
          throw new Error('主机没有提供合法的全局知识入口内容');
        }
        const publisher = entryPublisherOf(given.publisher);
        if (!('id' in publisher)) throw new Error(publisher.problem);
        const target = entryTargets([command.executor])[0];
        if (target === undefined) throw new Error('不支持该执行器的全局入口修复');
        const nextContent: NodeEntryContent = {
          publisher,
          digest: given.digest,
          revisions: given.revisions,
          text: given.text,
          ...(typeof given.problem === 'string' ? { problem: given.problem } : {}),
        };
        const { status, backup_path } = repairEntry(command.action, nextContent, target, options.entry ?? {});
        entryContent = nextContent;
        writeEntry();
        if (executors === null || !entryReport.executors.some((each) => each.executor === status.executor)) {
          const rest = entryReport.executors.filter((each) => each.executor !== status.executor);
          entryReport = {
            digest: nextContent.digest,
            at: new Date().toISOString(),
            executors: [...rest, status],
          };
        }
        return {
          status,
          ...(backup_path === undefined ? {} : { backup_path }),
          report: entryReport,
        } satisfies NodeRepairEntryResult;
      }
      case 'update_executor': {
        const executor = typeof command.executor === 'string' ? command.executor.trim() : '';
        if (!executor) throw new Error('缺少要更新的执行器名称');
        const beforeStatus = executors?.executors.find((each) => each.executor === executor) ?? null;
        const beforeVersion = beforeStatus?.version ?? null;
        // Idle-safe gate: never upgrade an executor CLI while any Worker round, sign-in, or concurrent update is active.
        const busyState = await releaseBusy();
        if (busyState.runs > 0 || busyState.signIns > 0 || updatingExecutors.has(executor)) {
          return {
            ok: false,
            executor,
            method: 'busy',
            before_version: beforeVersion,
            after_version: beforeVersion,
            updated: false,
            busy: true,
            error: updatingExecutors.has(executor)
              ? `执行器 ${executor} 已有正在进行的更新，请等待完成`
              : busyState.runs > 0
                ? `本机有 ${busyState.runs} 个任务正在运行，等待空闲后再更新`
                : '本机有登录流程正在进行，等待结束后再更新',
          } satisfies NodeUpdateExecutorResult;
        }
        updatingExecutors.add(executor);
        try {
          const read = await refreshLookup();
          const outcome = await runExecutorUpdate({
            executor,
            installedPath: beforeStatus?.path,
            ...(typeof command.timeout_ms === 'number' && Number.isFinite(command.timeout_ms) ? { timeoutMs: command.timeout_ms } : {}),
            env: read.env,
            exclude: roundDirs(dataDir),
            signal: leaving.signal,
            ...(options.executors?.run === undefined ? {} : { run: options.executors.run }),
          });
          if (!outcome.ok) {
            return {
              ok: false,
              executor,
              method: outcome.method,
              before_version: beforeVersion,
              after_version: beforeVersion,
              updated: false,
              ...(outcome.error ? { error: outcome.error } : {}),
              ...(outcome.output ? { output: outcome.output } : {}),
            } satisfies NodeUpdateExecutorResult;
          }
          // Immediately re-probe executors so the host receives the new version and refreshed model catalog.
          const freshReport = await look();
          const afterStatus = freshReport.executors.find((each) => each.executor === executor) ?? null;
          const afterVersion = afterStatus?.version ?? null;
          if (!beforeStatus?.installed && !afterStatus?.installed) {
            return {
              ok: false,
              executor,
              method: outcome.method,
              before_version: beforeVersion,
              after_version: afterVersion,
              updated: false,
              error: `安装命令已结束但仍未检测到 ${executor}（请展开日志确认网络、代理或安装目录）`,
              ...(outcome.output ? { output: outcome.output } : {}),
              report: freshReport,
            } satisfies NodeUpdateExecutorResult;
          }
          return {
            ok: true,
            executor,
            method: outcome.method,
            before_version: beforeVersion,
            after_version: afterVersion,
            updated: afterStatus?.installed === true && (!beforeStatus?.installed || (afterVersion !== null && afterVersion !== beforeVersion)),
            ...(outcome.output ? { output: outcome.output } : {}),
            report: freshReport,
          } satisfies NodeUpdateExecutorResult;
        } finally {
          updatingExecutors.delete(executor);
        }
      }
      default: {
        const never: never = command;
        throw new Error(`主机发来一条不认识的命令：${JSON.stringify(never)}`);
      }
    }
  }

  async function readOutput(command: { path: string; offset: number; bytes: number; file_limit_bytes?: number }, requireLimit = false): Promise<NodeRange> {
    if (requireLimit || command.file_limit_bytes !== undefined) {
      if (!Number.isSafeInteger(command.file_limit_bytes) || command.file_limit_bytes! < 0) throw new Error('文件大小上限不合法');
    }
    const at = inside(command.path);
    const found = statSync(at, { throwIfNoEntry: false });
    if (!found?.isFile()) return { base64: '', size: 0, mtime: 0 };
    if (command.file_limit_bytes !== undefined) {
      if (found.size > command.file_limit_bytes) throw new Error('报告超过文本查看上限');
    }
    const start = Math.max(0, Math.floor(command.offset));
    const want = Math.min(NODE_CHUNK_BYTES, Math.max(0, Math.floor(command.bytes)), Math.max(0, found.size - start));
    if (want === 0) return { base64: '', size: found.size, mtime: Math.floor(found.mtimeMs / 1000) };
    const chunks: Buffer[] = [];
    await new Promise<void>((resolveRead, rejectRead) => {
      const stream = createReadStream(at, { start, end: start + want - 1 });
      stream.on('data', (chunk) => chunks.push(chunk as Buffer));
      stream.on('error', rejectRead);
      stream.on('end', resolveRead);
    });
    return {
      base64: Buffer.concat(chunks).toString('base64'),
      size: found.size,
      mtime: Math.floor(found.mtimeMs / 1000),
    };
  }

  function artifacts(box: RunBox): NodeArtifact[] {
    const dir = inside(box.relative + '/artifacts');
    const names = safeReaddir(dir);
    // The host takes what is listed as everything the round left: a name it could not
    // take whole (artifacts.sh lists one file a line) is not skipped, it refuses the lot.
    if (names.some((name) => /[\r\n]/.test(name))) throw new Error('产物清单损坏：文件名里有换行');
    const found: NodeArtifact[] = [];
    for (const name of names) {
      const at = inside(box.relative + '/artifacts/' + name);
      const stat = statSync(at, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      found.push({ name, sha256: createHash('sha256').update(readFileSync(at)).digest('hex'), bytes: stat.size });
    }
    return found;
  }

  // What this machine has running, said to the host with every poll. A round whose processes
  // cannot be read is said as unknown: how many rounds this machine holds is its history, not
  // its load (nodes.md §4.3).
  async function aliveRuns(): Promise<{ task_id: string; run_id: string; alive: boolean | null }[]> {
    const runs = [];
    for (const held of listRuns(dataDir)) {
      const box = boxOf(dataDir, held.relative);
      if (!existsSync(join(box.runDir, 'started'))) continue;
      runs.push({ task_id: held.task_id, run_id: held.run_id, alive: aliveOf(await runState(box, procs)).alive });
    }
    return runs;
  }

  // §8.1: one long poll, then do what came back. The result of each command goes out on
  // its own request as soon as it is known, so a slow stop holds nothing else up.
  // Cut short by a leave the host asked for, like a stop asked from another process.

  // What has been taken out of the queue and not finished: a command's own work and the
  // report that answers for it. Held across the whole client, not inside the loop, because
  // the loop is not what owns the answer: this machine already answered the host for these
  // commands, and `run` returning is this client being gone (nodes.md §7 — a replacement
  // client must not work beside one still finishing what it took).
  const inFlight = new Set<Promise<void>>();

  // How often this machine looks at its own executors again (nodes.md §1.2): the host's
  // setting node.executorRefreshMs, told with every poll answer. Before the first answer there
  // is only the look made when the client starts; the console's "test connection" makes it
  // look at once with a probe command. A login changes rarely, and each look runs the
  // executors' own commands.
  let lookEvery: number | undefined;
  let lookTimer: ReturnType<typeof setInterval> | undefined;
  // How long the models question may take, as the host last said it (node.modelListTimeoutMs).
  // Undefined until an answer carries one: then the client's own 30 seconds stands.
  let modelsTimeout: number | undefined;
  function modelListTimeoutMs(given: unknown): void {
    if (typeof given !== 'number' || !(given > 0) || given === modelsTimeout) return;
    modelsTimeout = given;
  }
  // How long a read of one login's own quota may take, as the host last said it
  // (node.quotaReadTimeoutMs). Undefined until an answer carries one: then this client's own
  // 120 seconds stands, which is what a client of an older host keeps.
  let quotaTimeout: number | undefined;
  function quotaReadTimeoutMs(given: unknown): void {
    if (typeof given !== 'number' || !(given > 0) || given === quotaTimeout) return;
    quotaTimeout = given;
  }
  function lookEveryMs(every: unknown): void {
    if (typeof every !== 'number' || !(every > 0) || every === lookEvery) return;
    lookEvery = every;
    clearInterval(lookTimer);
    lookTimer = setInterval(() => void look(), every);
    // A client that has stopped taking work must not keep asking the machine's executors.
    lookTimer.unref?.();
  }

  async function pollLoop(outer?: AbortSignal): Promise<void> {
    const signal = outer === undefined ? leaving.signal : AbortSignal.any([outer, leaving.signal]);
    let cursor: string | null = null;
    let attempt = 0;
    // What this machine has running, as of its last look. The host counts this machine as
    // here for only a moment between two polls (service/nodes.ts), and one look at the
    // process table — a PowerShell per round on Windows — can take longer than that moment.
    // So the look is taken between polls without holding the next one up, and a poll says
    // what the last look found. Two polls are the exception and look first: the first one,
    // and the first after an outage — those are the polls the host reclaims by (nodes.md §4.4).
    let runs: Awaited<ReturnType<typeof aliveRuns>> | undefined;
    let looking: Promise<void> | undefined;
    // A start command's round exists only after the command has run: a look taken with the poll
    // answer that carried it began before the round's gate was written and does not have it. Once
    // that command is done the loop looks once more, still on its own, before it may decide the
    // machine is idle; otherwise the stale list would let it leave with the new round running.
    let surveyAfterStart = false;
    const refresh = (): Promise<void> => (looking ??= aliveRuns()
      .then((found) => {
        runs = found;
      })
      .catch((error: unknown) => log(`清点这台机器上的轮次没做成：${(error as Error).message}`))
      .finally(() => {
        looking = undefined;
      }));
    // "Is this machine idle", from what the poll loop itself already holds: the rounds it
    // last surveyed (the same list it reports to the host), the commands still being carried
    // out, and the sign-ins still running. No second look at the process table.
    const busyNow = (): ReleaseBusy => ({
      runs: (runs ?? []).filter((run) => run.alive !== false).length,
      commands: inFlight.size,
      signIns: signIns.report().filter((each) => !signInEnded(each.state)).length,
    });
    while (!signal.aborted && !options.stopped?.()) {
      let answer: NodePollAnswer;
      try {
        if (surveyAfterStart) {
          surveyAfterStart = false;
          // Wait out a look that may still be carrying the answer from before the command, so
          // that this one, and not that older list, is what the decision below reads.
          if (looking !== undefined) await looking;
          runs = await aliveRuns();
        } else {
          runs ??= await aliveRuns();
        }
        // The one moment a version swap is decided: the previous poll is over and the next is
        // not sent yet, so no command is on its way. Nothing of this machine's is running or
        // unclear, no command is in flight and no sign-in is under way — only then does the
        // client leave and the supervisor start the version `current` names (§1.4).
        if (follower !== null && follower.swapTarget() !== null && releaseIdle(busyNow())) {
          follower.swapNow();
          return;
        }
        writeEntry();
        refreshLocalSkills();
        const outputPage=await output.report();
        answer = await post<NodePollAnswer>(
          '/api/node/poll',
          {
            cursor,
            runs,
            facts: options.facts,
            ...(options.serviceManager === undefined ? {} : { service_manager: options.serviceManager() }),
            // What this machine read from its own executors travels with the poll, like what
            // it says is running: the host keeps the last one for the pages (nodes.md §1.2).
            ...(executors === null ? {} : { executors }),
            entry: entryReport,
            ...(options.skills?.enabled === false ? {} : { skills: skillsReport }),
            sign_ins: signIns.report(),
            // This client can be told to drop a Task's code copy once its work has ended and
            // the retention period passed (service/retention.ts). A client from before it
            // never says so, and its machine's copies are left alone.
            drops_task_code: true,bounded_output:1,output:{capacity:outputPage.capacity,references:outputPage.references,legacy:outputPage.legacy},
          } satisfies Omit<NodePollRequest, 'protocol'>,
          // Until the answer starts: then as long as the host says it holds this poll.
          DEFAULT_REQUEST_MS,
          signal,
          true,
        );
        outputPage.advance();
        if(answer.output_policy!==undefined)await output.takePolicy(answer.output_policy);
        for(const released of answer.output_releases??[]){try{await output.release(released);}catch(error){log('输出释放未完成：'+(error as Error).message);}}
        const reconnected = attempt > 0;
        attempt = 0;
        lookEveryMs(answer.look_every_ms);
        modelListTimeoutMs(answer.models_timeout_ms);
        quotaReadTimeoutMs(answer.quota_timeout_ms);
        // First poll after an outage: the host may have moved on to another version while
        // this machine was away (docs/design/nodes.md §1.4).
        if (reconnected) void follower?.start();
      } catch (error) {
        if (signal?.aborted) return;
        // A protocol refusal is not this process's error while there is a way to move to the
        // host's version: it stops polling, does what §1.4 says, and leaves when idle. The one
        // exception is a client already on the host's version — then the mismatch is something
        // else, and it is reported as it always was.
        if (error instanceof NodeHttpError && error.status === 426 && follower !== null) {
          if (await follower.mismatch(error, signal)) throw error;
          await follower.leaveWhenIdle(signal);
          return;
        }
        if (error instanceof NodeHttpError && (error.status === 401 || error.status === 403 || error.status === 426)) throw error;
        const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
        attempt += 1;
        log(`连不上主机（${(error as Error).message}），${Math.round(wait / 1000)} 秒后再试`);
        try {
          await sleep(wait, undefined, { signal });
        } catch {
          return;
        }
        // The first poll after an outage looks first (see above).
        runs = undefined;
        continue;
      }
      void refresh();
      if (answer.entry !== undefined) takeEntry(answer.entry);
      if (answer.skills !== undefined) takeSkills(answer.skills);
      // Before the command it carries: a sign-in this answer starts is not in its list yet.
      if (Array.isArray(answer.sign_ins)) signIns.keep(answer.sign_ins.filter((id): id is string => typeof id === 'string'));
      const command: NodeCommand | null = answer.command;
      if (command !== null) {
        cursor = command.id;
        const job = (async () => {
          try {
            const result = await execute(command);
            await post('/api/node/report', { command_id: command.id, ok: true, result } satisfies Omit<NodeReportRequest, 'protocol'>);
            if (command.kind === 'retire') {
              await post('/api/node/leave', {});
              retired = true;
              leaving.abort();
            }
          } catch (error) {
            log(`这一步没做成（${command.kind}）：${(error as Error).message}`);
            try {
              await post('/api/node/report', { command_id: command.id, ok: false, error: (error as Error).message } satisfies Omit<NodeReportRequest, 'protocol'>);
            } catch {
              // The host will ask about this round again; a report that cannot go out is
              // not a reason to stop working.
            }
          }
        })().finally(() => {
          inFlight.delete(job);
          // This command's round, if any, began after the look that came with its poll
          // answer: the loop takes one more look of its own before it may see the machine
          // as idle (see surveyAfterStart).
          if (command.kind === 'start') surveyAfterStart = true;
        });
        inFlight.add(job);
      }
      // What it is waiting for, from the rounds and the command this poll carried. Only a
      // change is reported (node/follow.ts).
      void follower?.afterPoll(busyNow());
    }
  }

  return {
    execute,
    aliveRuns,
    stillThere,
    facts: options.facts,

    // What this machine last read from its own executors. Exposed so that the probe command,
    // the clock and a test all get the same one look at a time (node/executors.ts).
    look,

    // The sign-ins this machine holds, as the next poll says them.
    signIns: (): ReturnType<typeof signIns.report> => signIns.report(),
    stopSignIns: (): Promise<void> => signIns.stopAll(),

    async run(signal?: AbortSignal): Promise<void> {
      // 接入时 and after that on the host's clock (lookEveryMs). The first look is started before the
      // first poll, so the report rides the first poll that goes out once it is done: a poll
      // the host is holding open is answered when the host answers it, not when this machine
      // has something to say (a held poll is never cut short here — a command already handed
      // into it would be given up on for nothing).
      void look();
      // Which version the host runs, asked at every start (docs/design/nodes.md §1.4). It is
      // not waited for: a machine the protocol allows goes on taking work while it looks.
      void follower?.start();
      // A stop or a leave asked from another process is a mark on disk (`stopped`). It is
      // looked for every second, and the poll in flight is cut short so that stopping does
      // not wait out a hold: a command that connection carried and this client never named
      // goes back to the host's queue, which is the host's own rule for a connection that
      // breaks (nodes.md §8.2).
      const stopping = new AbortController();
      const asked = setInterval(() => {
        if (options.stopped?.()) stopping.abort();
      }, STOP_CHECK_MS);
      asked.unref?.();
      // The stop this client is under reaches the reads it started at once, so that a look
      // landing after it begins starts nothing new (startQuotaReads).
      const stopSignal = signal === undefined ? stopping.signal : AbortSignal.any([signal, stopping.signal]);
      stopSignal.addEventListener('abort', () => stopQuotaReads.abort(), { once: true });
      try {
        await pollLoop(stopSignal);
      } finally {
        clearInterval(lookTimer);
        lookTimer = undefined;
        lookEvery = undefined;
        clearInterval(asked);
        follower?.stop();
        // Nothing this client started outlives it. A read of a login's own quota is told to stop
        // and waited for: it ends the command it started and confirms that with the process table
        // (node/executors.ts), so nothing of it is still running when this returns. What a read
        // could not confirm is stopped and looked at once more here — this leaving is the last
        // moment anyone can — and said as such when it still cannot be (nodes.md §4.2).
        stopQuotaReads.abort();
        await Promise.allSettled([...quotaReads.values()]);
        for (const [pid, what] of owedQuota) {
          const confirmed = await stopProbeTree(pid, process.platform, procs).catch(() => false);
          if (!confirmed) log(`读额度用的 ${what}（pid ${pid}）没能确认已经结束`);
        }
        owedQuota.clear();
        // Nothing this client started for a sign-in outlives it.
        await signIns.stopAll();
        // What it had already taken out of the queue finishes first — the command and the
        // report that answers for it. A command is not cancelled here: it was answered for
        // the moment it left the host's queue, and a report that never went out would leave
        // the host reading a round it never heard the end of. The watch process and the
        // Worker are not this client's to end (nodes.md §4.2) and are not waited on.
        await Promise.allSettled([...inFlight]);
      }
    },

    // What a join answers, held for the machine that asked.
    join: (claim: { secret: string } | undefined): Promise<NodeJoinAnswer> => joinHost({ origin: base, facts: options.facts, ...(claim === undefined ? {} : { claim }) }),

    // Whether the host takes this machine's token right now. A question of its own, which
    // takes nothing out of the queue: asking about this machine must not eat the command it
    // was about to be given (nodes.md §8.2).
    async status(timeoutMs = 3000): Promise<'connected' | 'unreachable'> {
      try {
        await post('/api/node/status', {}, timeoutMs);
        return 'connected';
      } catch (error) {
        if (error instanceof NodeHttpError) throw error;
        return 'unreachable';
      }
    },

    async leave(): Promise<void> {
      await post('/api/node/leave', {});
    },

    // Whether this client left because the host told it its work was over.
    retired: (): boolean => retired,

    // Whether the client stopped so that its supervisor starts the version it installed
    // (docs/design/nodes.md §1.4): the process then leaves with SWAP_EXIT.
    swapRequested: (): boolean => follower?.swapped() ?? false,
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// A child of its own, detached: the client may be restarted, upgraded or killed while a
// round is running, and the round is the watch process's from then on (nodes.md §4.2).
// Nothing is piped to it — a round's output goes to files of its own — so what it needs to
// know travels in the environment it is started with.
export const HANDOVER_ENV = 'TYCHO_NODE_HANDOVER';

function spawnWatch(args: string[], dataDir: string, handover: { env: Record<string, string>; credential?: string; githubToken?: string; lookup?: Record<string, string> }) {
  return spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, TYCHO_DATA: dataDir, [HANDOVER_ENV]: JSON.stringify(handover) },
  });
}
