// Which executors this machine has, and whether they are signed in (docs/design/nodes.md
// §1.2, §11 step 5).
//
// Three things this file is careful about:
//   - The questions are a closed set. One per adapter this program ships, each one a command
//     that adapter declares; nothing the host sends can add a question, change one or carry a
//     command line of its own (the probe command in shared/node-protocol.ts has no fields).
//   - They are found in this machine's lookup environment (node/lookup-env.ts: a login
//     shell's on POSIX, because a client started by a scheduler has none of the PATH a login
//     has) and started the way a Worker is (node/launch.ts): the point of the answer is what
//     a Worker on this machine would find (nodes.md §1.2: "登录查询通过不等于实际能跑").
//   - What is read is the exit code and the version line, and — from the commands an adapter
//     declares for it — the models that command lists (parsed here by that adapter), the
//     organization id of its own login (the same login answer, parsed by the adapter) and
//     whether the executor would take the token tycho hands an account's round, asked with a
//     placeholder value. The rest of what a command prints stays on this machine: no email, no
//     usage, nothing else is parsed, and a login is never turned into an account.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ADAPTERS } from '../adapters/all.ts';
import type { Adapter, CredentialCheck, MachineQuota, MinVersion, ModelInfo, ModelQuery, QuotaReading, QuotaStep, QuotaWindow, ReadOnlyWay } from '../adapters/types.ts';
import type { ExecutorIdentity } from '../shared/logins.ts';
import { tooOld } from '../adapters/version.ts';
import { NODE_CONFIG_NAMES_MAX, NODE_MODEL_EFFORTS_MAX, NODE_MODELS_MAX, NODE_QUOTA_WINDOWS_MAX } from '../shared/node-protocol.ts';
import type { NodeExecutorReport, NodeExecutorStatus, NodeQuotaStatus } from '../shared/node-protocol.ts';
import type { ConfigKind } from '../shared/machine-inputs.ts';
import { stopProbeTree } from './hostprocess.ts';
import { mergeQuotaWindows, runQuotaPlugin } from './quota-plugins.ts';
import { CommandMissing, launchOf } from './launch.ts';
import { missingText } from './locate.ts';
import type { Launch } from './launch.ts';
import type { HostProcesses } from './hostprocess.ts';

// How long one question may take. Per executor the version first, then its other questions
// side by side, and the executors side by side. The models question is the exception: it has
// its own span below, so a whole look may outlast this one.
export const PROBE_TIMEOUT_MS = 6_000;
// The one command that lists an executor's models gets its own deadline: right after a
// sign-in it may have to reach the vendor for the list (docs/design/nodes.md §1.2). The host
// says the span (node.modelListTimeoutMs); this is what a client of an older host uses.
export const MODEL_LIST_TIMEOUT_MS = 30_000;
// How long a read of one of this machine's own logins' quota may take, when the host has not
// said (node.quotaReadTimeoutMs, told with every poll answer). It has a span of its own for the
// same reason the models question does: the Claude Code one counts what this machine's own
// sessions used before it answers, which took 55 seconds when it was measured, and it is read
// beside a report rather than in front of one, so its span never delays anything.
export const QUOTA_READ_TIMEOUT_MS = 120_000;
// Version precedes the parallel probes; allow time for shutdown and the reply.
export function executorCheckTimeoutMs(modelsTimeoutMs: number): number {
  return PROBE_TIMEOUT_MS + Math.max(PROBE_TIMEOUT_MS, modelsTimeoutMs) + 10_000;
}
// A version line is one line of what a CLI prints; anything longer is not one.
const VERSION_CHARS = 200;

// One question to one executor, as its adapter declares it: the command, the arguments that
// make it print its version, and — when the adapter declares one — the arguments that make it
// say whether it is signed in.
export interface ExecutorQuestion {
  executor: string;
  command: string;
  version: string[];
  login?: string[];
  // Identity projected from the machine's login-status answer, when it carries one.
  loginIdentity?: (stdout: string, stderr: string) => ExecutorIdentity;
  identityTalk?: NonNullable<Adapter['identityTalk']>;
  // The executor's read-only way, whose probe is asked after the version; and the lowest
  // version its commands work on, below which nothing else is asked.
  readOnly?: Pick<ReadOnlyWay, 'layer' | 'probe'>;
  minVersion?: MinVersion;
  // Whether the executor would take the token tycho hands an account's round, asked after the
  // version: the adapter's command and reading, and the variable the placeholder goes in.
  credential?: CredentialCheck & { variable: string };
  // The command that lists the models this executor can run here, and how its adapter reads
  // the answer. Absent when the adapter declares none to run on a machine.
  models?: Omit<Extract<ModelQuery, { kind: 'command' }>, 'kind'>;
  // The commands that list its own configuration here, kind by kind: only the ones the adapter
  // declares can be asked without starting anything of the machine's.
  config?: { kind: ConfigKind; argv: string[]; parse(stdout: string): string[] | undefined }[];
  // How one of this executor's own logins here is asked for its quota, run on this machine
  // because that is where the login is (Adapter.machineQuota). Read beside the report and never
  // in front of it: the client starts this when a look ends, and the answer rides a later
  // report (docs/design/usage.md §3).
  quota?: MachineQuota;
}

// What an adapter declares, in this shape. An adapter with no `probe` has no command of its
// own to ask, and nothing is asked about it.
export function questionsFrom(adapters: Record<string, Adapter>): ExecutorQuestion[] {
  return Object.entries(adapters).flatMap(([executor, adapter]) => {
    const probe = adapter.probe;
    if (!probe) return [];
    // Asked as the machine's own login would: with no token. A query over HTTP is the
    // service's to make, not this machine's.
    const models = adapter.listModels?.({});
    const credential = adapter.credentialCheck === undefined || adapter.credential === undefined
      ? undefined
      : { ...adapter.credentialCheck, variable: adapter.credential({}).variable };
    return [{
      executor,
      command: probe.command,
      version: probe.version,
      ...(adapter.loginStatus === undefined ? {} : { login: adapter.loginStatus }),
      ...(adapter.loginIdentity === undefined ? {} : { loginIdentity: adapter.loginIdentity }),
      ...(adapter.identityTalk === undefined ? {} : { identityTalk: adapter.identityTalk }),
      readOnly: adapter.readOnly === undefined
        ? { layer: 'contract' as const }
        : { layer: adapter.readOnly.layer, ...(adapter.readOnly.probe === undefined ? {} : { probe: adapter.readOnly.probe }) },
      ...(adapter.minVersion === undefined ? {} : { minVersion: adapter.minVersion }),
      ...(credential === undefined ? {} : { credential }),
      ...(models?.kind === 'command' ? { models } : {}),
      ...(adapter.machineQuota === undefined ? {} : { quota: adapter.machineQuota }),
    }];
  });
}

export interface CommandAnswer {
  stdout: string;
  stderr: string;
  // Null when the command could not be run to an exit code at all: not found, refused, or
  // ended by the deadline. `failure` says which, in the owner's words.
  code: number | null;
  failure?: string;
  // Where the command was found, when it was (node/locate.ts).
  path?: string;
  // The root of a command tree that was ended but not proven gone: whoever reads this answer
  // still owes it an ending (readQuota hands it to the caller that can still act).
  owed?: number;
}

// One command, run and read to its end. `env` is added to the machine's lookup environment for
// this command only: the credential probe puts its placeholder in the one variable it asks about
// and changes nothing else. `signal`, where the caller has one, is that caller leaving: the
// command's tree is ended and looked at again, exactly as one that ran past its deadline.
export type CommandRun = (argv: string[], timeoutMs: number, env?: Record<string, string>, signal?: AbortSignal) => Promise<CommandAnswer>;

// A command tree that was ended but not proven gone, with the command that was run. Handed to
// whoever can still act, which is what keeps the ending owed rather than forgotten
// (QuotaReadOptions.onOwed; node/client.ts stops these against the process table before it
// leaves).
export type OwedCommand = (pid: number, argv: readonly string[]) => void;

interface ProbeOptions {
  questions: ExecutorQuestion[];
  // Directories no command is looked up in: the machine's rounds (node/launch.ts).
  exclude?: string[];
  // The machine's lookup environment (node/lookup-env.ts), which commands are found and run
  // in. This process's own when none is given.
  env?: NodeJS.ProcessEnv;
  // How to run one command. Found and started like a Worker unless a test stands one in.
  run?: CommandRun;
  timeoutMs?: number;
  talk?: TalkRun;
  // How long the models question may take, when it is not the same as the other probes'.
  modelsTimeoutMs?: number;
  now?: () => number;
}

// The last line of what the command printed, which is where a CLI puts its version. stdout
// first, stderr only when stdout said nothing: a warning on stderr is not a version
// (tests/fixtures/login-status: `codex --version` warns on stderr and answers on stdout).
export function versionLine(stdout: string, stderr: string): string | null {
  const line = (text: string): string | undefined => text.split('\n').map((each) => each.trim()).filter((each) => each !== '').at(-1);
  const said = line(stdout) ?? line(stderr);
  return said === undefined ? null : said.slice(0, VERSION_CHARS);
}

// One question, found and started the way the watch process finds and starts a Worker
// (node/launch.ts), in the machine's lookup environment (node/lookup-env.ts), so that what
// the probe finds is what a round runs. A command that is not there throws, and is reported
// as not installed with every place that was looked in.
export function shellInvocation(argv: string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exclude: string[] = []): Launch {
  return launchOf(argv, env, platform, { exclude });
}

// Run one command and read it to its end, or to the deadline. A command that outlives the
// deadline is ended here: a hung CLI left behind would keep running for the rest of the day,
// and the machine's own files are not this program's to leave half-open. So is one the caller
// stops holding (`signal`): the client leaving ends the commands it started the same way, and
// the process table read again is what says whether it worked.
export function shellRun(argv: string[], timeoutMs: number, platform: NodeJS.Platform = process.platform, runtime: { spawn?: typeof spawn; processes?: HostProcesses; env?: NodeJS.ProcessEnv; extraEnv?: Record<string, string>; launch?: Launch; exclude?: string[]; signal?: AbortSignal; cwd?: string } = {}): Promise<CommandAnswer> {
  const env = runtime.env ?? process.env;
  // A stop that has already begun is not a command: nothing is found, nothing is started, and
  // nothing is left for anyone to end.
  if (runtime.signal?.aborted) return Promise.resolve({ stdout: '', stderr: '', code: null, failure: `${argv.join(' ')} 在停止之后没有开跑` });
  let launch: Launch;
  try {
    launch = runtime.launch ?? shellInvocation(argv, platform, env, runtime.exclude);
  } catch (error) {
    const failure = error instanceof CommandMissing ? error.message : `运行不了 ${argv[0]}：${(error as Error).message}`;
    return Promise.resolve({ stdout: '', stderr: '', code: null, failure });
  }
  const { command, args } = launch;
  return new Promise<CommandAnswer>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let ending = false;
    let child: ChildProcess;
    const finish = (answer: { code: number | null; failure?: string; owed?: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      runtime.signal?.removeEventListener('abort', released);
      const path = launch.found;
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code: answer.code,
        ...(answer.failure === undefined ? {} : { failure: answer.failure }),
        ...(path === undefined || answer.code === null ? {} : { path }),
        ...(answer.owed === undefined ? {} : { owed: answer.owed }),
      });
    };
    // It has to go: past its deadline, or because the caller is leaving. Its tree is ended and
    // the process table read again, and only that look confirms it is gone (stopProbeTree).
    // What that look cannot confirm is said rather than passed over, and the root travels with
    // the answer, so that whoever read it can still end what is owed.
    const end = (said: string): void => {
      if (ending || settled) return;
      ending = true;
      clearTimeout(clock);
      void (async () => {
        const confirmed = child.pid !== undefined && await stopProbeTree(child.pid, platform, runtime.processes).catch(() => false);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish({
          code: null,
          failure: `${argv.join(' ')} ${said}${confirmed ? '' : '；无法确认探针进程树已经结束'}`,
          ...(!confirmed && child.pid !== undefined ? { owed: child.pid } : {}),
        });
      })();
    };
    const released = (): void => end('已经停止');
    try {
      child = (runtime.spawn ?? spawn)(command, args, {
        env: runtime.extraEnv === undefined ? env : { ...env, ...runtime.extraEnv },
        cwd: runtime.cwd,
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A group of its own on the platforms that have them, so that ending a command that
        // ran past its deadline reaches whatever it started as well.
        detached: platform !== 'win32',
      });
    } catch (error) {
      resolve({ stdout: '', stderr: '', code: null, failure: `运行不了 ${argv[0]}：${(error as Error).message}` });
      return;
    }
    const clock = setTimeout(() => end(`超过 ${timeoutMs} 毫秒没有回答`), timeoutMs);
    runtime.signal?.addEventListener('abort', released, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (ending) return;
      const missing = error.code === 'ENOENT';
      finish({
        code: null,
        // Found a moment ago, gone when started: the same words as not found, at that one place.
        failure: missing ? missingText(argv[0]!, [launch.found ?? command]) : `运行不了 ${argv[0]}：${error.message}`,
      });
    });
    child.on('close', (code) => {
      if (ending) return;
      // Whatever code the executor exits with, it was there: not found never gets this far.
      finish({ code });
    });
  });
}

// What became of one short conversation: the line that answered its last step, or why it never
// got there. `answer` null with a `failure` is a reading that did not happen; the two are never
// both set, and neither carries anything the command printed. `unconfirmed` is the third case:
// the answer is in and is handed over, but the command's own tree was not proven gone — whose
// root is in `owed`, an ending its reader still owes.
export interface TalkAnswer {
  answer: string | null;
  failure?: string;
  unconfirmed?: string;
  owed?: number;
}

// What a conversation says when its answer is in but its command's tree could not be confirmed
// gone. The same words the probes use for the same state, so that a reader meets one wording.
const UNCONFIRMED_TALK = '无法确认读额度命令的进程树已经结束';

// How one `talk` reading is made. Found and started like the probes unless a test stands one in.
// `signal`, where the caller has one, is that caller leaving: the conversation is ended and its
// tree looked at again, as one that ran past its deadline is.
export type TalkRun = (argv: string[], steps: readonly QuotaStep[], timeoutMs: number, signal?: AbortSignal) => Promise<TalkAnswer>;

// One short conversation with a command, on its standard input and output: each step's lines
// are written, the line that answers that step is waited for, and only then the next step is
// written. Once the last answer is in, its standard input is closed and the process tree is
// ended — that answer is what the caller wanted, and a server left running on the machine would
// be nobody's to clean up. `argv` is found and started the way a Worker is (node/launch.ts), and
// a command that outlives its deadline — or one the caller stops holding — is ended with its
// tree (stopProbeTree), which is also what says whether it is really gone.
export function shellTalk(argv: string[], steps: readonly QuotaStep[], timeoutMs: number, platform: NodeJS.Platform = process.platform, runtime: { spawn?: typeof spawn; processes?: HostProcesses; env?: NodeJS.ProcessEnv; launch?: Launch; exclude?: string[]; signal?: AbortSignal } = {}): Promise<TalkAnswer> {
  if (steps.length === 0) return Promise.resolve({ answer: null, failure: `${argv.join(' ')} 的对话没有说要发什么` });
  // A stop that has already begun is not a conversation: nothing is found, nothing is started.
  if (runtime.signal?.aborted) return Promise.resolve({ answer: null, failure: `${argv.join(' ')} 在停止之后没有开跑` });
  const env = runtime.env ?? process.env;
  let launch: Launch;
  try {
    launch = runtime.launch ?? shellInvocation(argv, platform, env, runtime.exclude);
  } catch (error) {
    const failure = error instanceof CommandMissing ? error.message : `运行不了 ${argv[0]}：${(error as Error).message}`;
    return Promise.resolve({ answer: null, failure });
  }
  const { command, args } = launch;
  return new Promise<TalkAnswer>((resolve) => {
    let settled = false;
    let ending = false;
    let answered: string | null = null;
    let child: ChildProcess;
    const finish = (result: TalkAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      runtime.signal?.removeEventListener('abort', released);
      resolve(result);
    };
    // The command has to go: its deadline, the caller leaving, or its answer being in. Its tree
    // is ended and the process table read again, and only that look confirms it is gone
    // (stopProbeTree). A tree it cannot confirm is not washed away with the handle: the root
    // travels with the answer, and an answer that came beside it says so rather than passing for
    // a clean success.
    const end = (result: (confirmed: boolean) => TalkAnswer): void => {
      if (ending || settled) return;
      ending = true;
      clearTimeout(clock);
      void (async () => {
        const confirmed = child.pid !== undefined && await stopProbeTree(child.pid, platform, runtime.processes).catch(() => false);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        // The handle is let go of either way — a command of ours must not hold this process
        // open — but an unconfirmed tree is not forgotten with it: its root is in the answer.
        child.unref();
        const said = result(confirmed);
        finish(!confirmed && child.pid !== undefined ? { ...said, owed: child.pid } : said);
      })();
    };
    // The answer is in: stop writing, end what is left of the command, and hand it over. The
    // deadline is off first, so a command that is slow to go is not reported as one that never
    // answered.
    const done = (line: string): void => {
      answered = line;
      child.stdin?.end();
      end((confirmed) => ({ answer: line, ...(confirmed ? {} : { unconfirmed: UNCONFIRMED_TALK }) }));
    };
    const released = (): void => end((confirmed) => ({
      answer: null,
      failure: `${argv.join(' ')} 已经停止${confirmed ? '' : '；无法确认探针进程树已经结束'}`,
    }));
    const write = (say: readonly string[]): void => {
      for (const line of say) child.stdin?.write(`${line}\n`);
    };
    try {
      child = (runtime.spawn ?? spawn)(command, args, {
        env,
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        stdio: ['pipe', 'pipe', 'pipe'],
        // A group of its own on the platforms that have them, so that ending one that ran past
        // its deadline reaches whatever it started as well.
        detached: platform !== 'win32',
      });
    } catch (error) {
      resolve({ answer: null, failure: `运行不了 ${argv[0]}：${(error as Error).message}` });
      return;
    }
    let step = 0;
    const clock = setTimeout(() => end((confirmed) => ({
      answer: null,
      failure: `${argv.join(' ')} 超过 ${timeoutMs} 毫秒没有回答${confirmed ? '' : '；无法确认探针进程树已经结束'}`,
    })), timeoutMs);
    runtime.signal?.addEventListener('abort', released, { once: true });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (settled || answered !== null) return;
      const current = steps[step]!;
      if (!current.answers(line)) return;
      if (step === steps.length - 1) {
        done(line);
        return;
      }
      step += 1;
      // The step after this one is written only now: it is this answer that says the command
      // is ready for it.
      write(steps[step]!.say);
    });
    child.stderr?.resume();
    child.stdin?.on('error', () => { /* a command that closed its input ends the conversation below */ });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (ending || answered !== null) return;
      const missing = error.code === 'ENOENT';
      finish({
        answer: null,
        // Found a moment ago, gone when started: the same words as not found, at that one place.
        failure: missing ? missingText(argv[0]!, [launch.found ?? command]) : `运行不了 ${argv[0]}：${error.message}`,
      });
    });
    child.on('close', (code) => {
      if (ending || answered !== null) return;
      finish({ answer: null, failure: `${argv.join(' ')} 退出了（退出码 ${code === null ? '未知' : code}），没有得到回答` });
    });
    write(steps[0]!.say);
  });
}

// What became of one reading of one of this machine's own logins' quota. Only the windows and
// the moment they were read leave the machine: the answer is parsed here by the adapter's own
// declaration, and nothing else of what the command printed is read.
export interface QuotaReadOptions {
  // Executor name, used to discover optional local quota probe plugins (~/.tycho/quota-probes/<executor>.mjs).
  executor?: string;
  // The version this client tells the executor it is, where the declaration's conversation
  // names one (the Codex handshake).
  version: string;
  timeoutMs: number;
  // How a `command` reading is run, and how a `talk` one is: the same way the probes are run
  // unless a test stands one in.
  run?: CommandRun;
  talk?: TalkRun;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exclude?: string[];
  processes?: HostProcesses;
  now?: () => number;
  // The caller leaving: the command this read started is ended and its tree looked at again
  // (node/client.ts, run's own ending). A read that has not started by then does not start.
  signal?: AbortSignal;
  // A command tree this read could not prove gone goes here, with the command it ran: the
  // reading is over, but the ending is not, and this is what keeps it owed (node/client.ts stops
  // these against the process table before it leaves).
  onOwed?: OwedCommand;
}

async function applyQuotaPlugin(
  builtin: NodeQuotaStatus,
  options: QuotaReadOptions,
  at: () => string,
): Promise<NodeQuotaStatus> {
  if (!options.executor) return builtin;
  const pluginRes = await runQuotaPlugin(
    {
      executor: options.executor,
      builtin: {
        windows: builtin.windows,
        ...(builtin.error === undefined ? {} : { error: builtin.error }),
        ...(builtin.absent === undefined ? {} : { absent: builtin.absent }),
      },
    },
    {
      timeoutMs: options.timeoutMs,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  if (pluginRes === null) return builtin;
  if ('error' in pluginRes) {
    // Keep any valid built-in windows alongside the plugin error note.
    if (builtin.windows.length > 0) return { ...builtin, error: pluginRes.error };
    return { at: at(), windows: [], error: pluginRes.error };
  }
  if (pluginRes.problem) {
    if (pluginRes.mode === 'merge' && builtin.windows.length > 0) {
      return { ...builtin, error: pluginRes.problem };
    }
    return { at: at(), windows: [], error: pluginRes.problem };
  }
  const merged = mergeQuotaWindows(builtin.windows, pluginRes.windows ?? [], pluginRes.mode);
  const misfit = unfitQuota(merged);
  if (misfit !== undefined) return { at: at(), windows: [], error: misfit };
  return merged.length > 0
    ? { at: at(), windows: merged }
    : { at: at(), windows: [], absent: true };
}

export async function readQuota(way: MachineQuota | undefined, options: QuotaReadOptions): Promise<NodeQuotaStatus> {
  const now = options.now ?? Date.now;
  const at = (): string => new Date(now()).toISOString();
  const failed = (problem: string): NodeQuotaStatus => ({ at: at(), windows: [], error: problem });
  if (way === undefined) {
    return applyQuotaPlugin({ at: at(), windows: [], absent: true }, options, at);
  }
  // The moment is read after the answer, so that a report arriving late shows the moment the
  // machine actually read the figures, not the moment they were asked for.
  const learned = (read: () => QuotaReading): NodeQuotaStatus => {
    let answer: QuotaReading;
    try {
      answer = read();
    } catch {
      // What it choked on may quote the answer: said without it.
      return failed('额度的回答读不出来');
    }
    if ('problem' in answer) return failed(answer.problem);
    const misfit = unfitQuota(answer.windows);
    if (misfit !== undefined) return failed(misfit);
    // An answer that named no window travels as an absent reading: the host keeps the last
    // figures and says so neutrally, instead of treating a valid answer as a failure.
    return answer.absent === true ? { at: at(), windows: [], absent: true } : { at: at(), windows: answer.windows };
  };
  const platform = options.platform ?? process.platform;
  // What a command could not prove gone when it was ended is not this read's to forget: it is
  // handed up with the reading, so that whoever owns this machine's leaving still ends it.
  const owes = (owed: number | undefined): void => {
    if (owed !== undefined && 'argv' in way) options.onOwed?.(owed, way.argv);
  };
  if (way.kind === 'probe') {
    let reading: QuotaReading;
    try {
      reading = await way.read({
        env: options.env ?? process.env,
        timeoutMs: options.timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      return applyQuotaPlugin(failed(`读取本地额度失败：${error instanceof Error ? error.message : String(error)}`), options, at);
    }
    return applyQuotaPlugin(learned(() => reading), options, at);
  }
  if (way.kind === 'command') {
    const run = options.run ?? ((argv: string[], timeoutMs: number, _env?: Record<string, string>, signal?: AbortSignal) => shellRun(argv, timeoutMs, platform, {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      ...(signal === undefined ? {} : { signal }),
    }));
    const answer = await runQuietly(run, [...way.argv], options.timeoutMs, undefined, options.signal);
    owes(answer.owed);
    if (answer.failure !== undefined || answer.code === null) return applyQuotaPlugin(failed(answer.failure ?? `运行不了 ${way.argv.join(' ')}`), options, at);
    // A command that ended otherwise did not answer the question: its output is not read as
    // figures, as for the models and configuration questions.
    if (answer.code !== 0) return applyQuotaPlugin(failed(`${way.argv.join(' ')} 退出码 ${answer.code}`), options, at);
    return applyQuotaPlugin(learned(() => way.parse(answer.stdout)), options, at);
  }
  const talk = options.talk ?? ((argv: string[], steps: readonly QuotaStep[], timeoutMs: number, signal?: AbortSignal) => shellTalk(argv, steps, timeoutMs, platform, {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.processes === undefined ? {} : { processes: options.processes }),
    ...(signal === undefined ? {} : { signal }),
  }));
  const answer = await talk([...way.argv], way.steps(options.version), options.timeoutMs, options.signal).catch((error: unknown): TalkAnswer => ({
    answer: null, failure: `运行不了 ${way.argv[0]}：${(error as Error).message}`,
  }));
  owes(answer.owed);
  if (answer.failure !== undefined || answer.answer === null) return applyQuotaPlugin(failed(answer.failure ?? `${way.argv.join(' ')} 没有得到回答`), options, at);
  const status = await applyQuotaPlugin(learned(() => way.parse(answer.answer!)), options, at);
  // The answer is in, so the figures travel as they always do; a command tree that could not be
  // proven gone is said beside them rather than in place of them. The host keeps both (the one
  // field is free text), and a reader sees the reading and what is still owed with it.
  if (answer.unconfirmed === undefined) return status;
  return { ...status, error: status.error === undefined ? answer.unconfirmed : `${status.error}；${answer.unconfirmed}` };
}

// Why a reading cannot travel in a report (the limits in shared/node-protocol.ts), or nothing.
// The host refuses a whole report over one window out of shape, and a report goes with every
// poll: a reading that does not fit is said here as no reading, with why.
function unfitQuota(windows: readonly QuotaWindow[]): string | undefined {
  if (windows.length > NODE_QUOTA_WINDOWS_MAX) return `读到的额度窗口超过一份报告能带的 ${NODE_QUOTA_WINDOWS_MAX} 个`;
  if (windows.some(({ window }) => window.trim() === '' || /[\u0000-\u001f\u007f]/.test(window))) return '读到的额度窗口里有不是一行文字的名字';
  if (windows.some(({ used }) => !(used >= 0 && used <= 1))) return '读到的额度窗口里有不在 0 到 1 之间的比例';
  if (windows.some(({ resets_at: resets }) => resets !== null && !Number.isFinite(Date.parse(resets)))) return '读到的额度窗口里有读不出来的重置时刻';
  return undefined;
}

// What this machine's executors are, asked now. One executor's failure is that executor's
// own: the others are asked and reported all the same.
export async function probeExecutors(options: ProbeOptions): Promise<NodeExecutorReport> {
  const run = options.run ?? ((argv: string[], timeoutMs: number, extra?: Record<string, string>) => shellRun(argv, timeoutMs, process.platform, {
    exclude: options.exclude ?? [],
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(extra === undefined ? {} : { extraEnv: extra }),
  }));
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const modelsTimeoutMs = options.modelsTimeoutMs ?? MODEL_LIST_TIMEOUT_MS;
  const at = new Date((options.now ?? Date.now)()).toISOString();
  const talk: TalkRun | undefined = options.talk ?? (options.run === undefined
    ? (argv, steps, ms) => shellTalk(argv, steps, ms, process.platform, { env: options.env, exclude: options.exclude })
    : undefined);
  const executors = await Promise.all(options.questions.map(async (question) => askOne(question, run, talk, timeoutMs, modelsTimeoutMs)));
  return { at, executors };
}

async function askOne(question: ExecutorQuestion, run: CommandRun, talk: TalkRun | undefined, timeoutMs: number, modelsTimeoutMs: number): Promise<NodeExecutorStatus> {
  const argv = [question.command, ...question.version];
  const version = await runQuietly(run, argv, timeoutMs);
  if (version.failure !== undefined || version.code === null) {
    return { executor: question.executor, installed: false, version: null, logged_in: null, error: version.failure ?? `运行不了 ${argv.join(' ')}` };
  }
  // Nothing is started on a machine that cannot run the executor's own command, and the
  // login question is not asked either.
  if (version.code !== 0) {
    const said = versionLine(version.stdout, version.stderr);
    return {
      executor: question.executor, installed: true, version: null, logged_in: null,
      error: `${argv.join(' ')} 没有读出版本：${said ?? `退出码 ${version.code}`}`,
    };
  }
  const said = versionLine(version.stdout, version.stderr);
  // Advisory only: never mark an executor unusable or block dispatch on version strings.
  const versionWarning = question.minVersion === undefined || said === null ? undefined : tooOld(question.minVersion, said);
  const loginRead = question.login === undefined ? undefined : runQuietly(run, [question.command, ...question.login], timeoutMs);
  const modelsRead = question.models === undefined ? undefined : listModels(question.models, run, modelsTimeoutMs);
  const [login, readOnly, modelAnswer, credential, config, talkedIdentity] = await Promise.all([
    loginRead,
    question.readOnly === undefined ? undefined : probeReadOnly(question.readOnly, run, timeoutMs),
    modelsRead,
    question.credential === undefined ? undefined : probeCredential(question.credential, run, timeoutMs),
    question.config === undefined ? undefined : Promise.all(question.config.map((query) => listConfig(query, run, timeoutMs))),
    question.identityTalk === undefined || talk === undefined ? undefined
      : loginRead !== undefined
        ? loginRead.then((res) => res.code === 0 && !res.failure
          ? readTalkIdentity(question.identityTalk!, talk, said ?? '', timeoutMs) : undefined)
        : modelsRead !== undefined
          ? modelsRead.then((res) => res.models && res.models.list.length > 0
            ? readTalkIdentity(question.identityTalk!, talk, said ?? '', timeoutMs) : undefined)
          : readTalkIdentity(question.identityTalk!, talk, said ?? '', timeoutMs),
  ]);
  const models = modelAnswer?.models;
  const status: NodeExecutorStatus = {
    executor: question.executor, installed: true, version: said, logged_in: null,
    ...(version.path === undefined ? {} : { path: version.path }),
    ...(versionWarning === undefined ? {} : { error: versionWarning }),
    ...(readOnly === undefined ? {} : { read_only: versionWarning === undefined || readOnly.error !== undefined ? readOnly : { ...readOnly, error: versionWarning } }),
    ...(models === undefined ? {} : { models }),
    ...(credential === undefined ? {} : { credential }),
    ...(config === undefined ? {} : { config }),
  };
  const extra = talkedIdentity ?? modelAnswer?.identity;
  if (login === undefined) return { ...status, ...(extra === undefined ? {} : { identity: extra }) };
  if (login.failure !== undefined || login.code === null) {
    return { ...status, error: login.failure ?? `运行不了 ${[question.command, ...question.login!].join(' ')}` };
  }
  // The same answer the login question already needed, read for the organization id by the
  // adapter's own parser: nothing else of the answer travels, and a signed-out answer has no
  // identity to read. The exit code is the whole of the login answer: 0 is signed in.
  let identity: ExecutorIdentity | undefined = login.code === 0 ? extra : undefined;
  if (question.loginIdentity !== undefined) {
    try {
      identity = login.code === 0 ? question.loginIdentity(login.stdout, login.stderr) : { accountLabel: null };
    } catch {
      identity = undefined;
    }
  }
  return {
    ...status,
    ...(identity === undefined ? {} : { identity }),
    logged_in: login.code === 0,
  };
}

// How much of a probe's own words a report carries: enough for the line that says why.
const PROBE_WORDS = 240;

// What the probe said, as one line a page can show: its last words, stderr first — where a
// CLI puts why it failed — and stdout when stderr said nothing.
function wordsOf(answer: CommandAnswer): string {
  const flat = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = flat(answer.stderr) || flat(answer.stdout);
  return words.length > PROBE_WORDS ? `…${words.slice(-PROBE_WORDS)}` : words;
}

// Whether the read-only way starts on this machine (roles-and-tiers.md §5). Only a clean
// answer is "available": a command that failed, did not answer, or answered without what the
// declaration checks for is not — what cannot be told is never taken for yes.
async function probeReadOnly(way: NonNullable<ExecutorQuestion['readOnly']>, run: CommandRun, timeoutMs: number): Promise<NonNullable<NodeExecutorStatus['read_only']>> {
  // No extra probe required when read-only relies on the native harness + post-round
  // code-baseline verification (`node/code-check.ts`).
  if (way.probe === undefined) return { available: true, layer: way.layer, checks_code: true };
  const argv = way.probe.argv;
  const answer = await runQuietly(run, argv, timeoutMs);
  const no = (error: string) => ({ available: false, layer: way.layer, error });
  if (answer.failure !== undefined || answer.code === null) return no(answer.failure ?? `运行不了 ${argv.join(' ')}`);
  if (answer.code !== 0) return no(`${argv.join(' ')} 退出码 ${answer.code}${wordsOf(answer) ? `：${wordsOf(answer)}` : ''}`);
  const missing = way.probe.check?.(answer.stdout, answer.stderr);
  // This client checks a read-only round's code once it is over (node/code-check.ts).
  return missing === undefined ? { available: true, layer: way.layer, checks_code: true } : no(missing);
}

// A value that is plainly not a token. The probe hands the executor this, never a real one: a
// command that echoes its environment then leaks nothing.
const CREDENTIAL_PROBE = 'tycho-credential-probe';

// Advisory-only diagnostic probe: never blocks dispatch (`adopted: true`), while still
// surfacing any probe warning in `error` for visibility.
async function probeCredential(question: NonNullable<ExecutorQuestion['credential']>, run: CommandRun, timeoutMs: number): Promise<NonNullable<NodeExecutorStatus['credential']>> {
  const argv = question.argv;
  const answer = await runQuietly(run, argv, timeoutMs, { [question.variable]: CREDENTIAL_PROBE });
  if (answer.failure !== undefined || answer.code === null) return { adopted: true, error: answer.failure ?? `运行不了 ${argv.join(' ')}` };
  const why = question.check(answer.stdout, answer.stderr);
  return why === undefined ? { adopted: true } : { adopted: true, error: why };
}

// Only the adapter's projected identity leaves this process, even when a CLI fails.
async function readTalkIdentity(probe: NonNullable<ExecutorQuestion['identityTalk']>, talk: TalkRun, version: string, timeoutMs: number): Promise<ExecutorIdentity | undefined> {
  try {
    const answer = await talk(probe.argv, probe.steps(version), timeoutMs);
    if (answer.answer !== null && answer.failure === undefined) return probe.parse(answer.answer);
  } catch { /* An optional identity reading failed. */ }
  return undefined;
}

// A configuration dump can carry secrets. Keep only what the adapter reads.
async function listModels(query: NonNullable<ExecutorQuestion['models']>, run: CommandRun, timeoutMs: number): Promise<Pick<NodeExecutorStatus, 'models' | 'identity'>> {
  const asked = query.argv.join(' ');
  const answer = await runQuietly(run, query.argv, timeoutMs);
  const none = (error: string) => ({ models: { list: [], error } });
  if (answer.failure !== undefined || answer.code === null) return none(answer.failure ?? `运行不了 ${asked}`);
  if (answer.code !== 0) return none(`${asked} 退出码 ${answer.code}`);
  let identity: ExecutorIdentity | undefined;
  try {
    identity = query.identity?.(answer.stdout);
  } catch { /* An optional identity reading failed. */ }
  let models: NonNullable<NodeExecutorStatus['models']>;
  try {
    const list = query.parse(answer.stdout);
    const problem = list.length === 0 ? '没有列出任何模型' : unfit(list);
    models = problem === undefined ? { list } : { list: [], error: `${asked} ${problem}` };
  } catch {
    // What the parser choked on may quote the answer.
    models = { list: [], error: `${asked} 的回答读不出来` };
  }
  return { models, ...(identity === undefined ? {} : { identity }) };
}

// One kind of the executor's own configuration here, as its own command lists it. Like the
// models, only the names the adapter parses out are kept and a reason never quotes the answer:
// a configuration listing may carry an MCP server's environment and its secrets.
async function listConfig(query: NonNullable<ExecutorQuestion['config']>[number], run: CommandRun, timeoutMs: number): Promise<NonNullable<NodeExecutorStatus['config']>[number]> {
  const asked = query.argv.join(' ');
  const answer = await runQuietly(run, query.argv, timeoutMs);
  const none = (error: string) => ({ kind: query.kind, error });
  if (answer.failure !== undefined || answer.code === null) return none(answer.failure ?? `运行不了 ${asked}`);
  if (answer.code !== 0) return none(`${asked} 退出码 ${answer.code}`);
  let names: string[] | undefined;
  try {
    names = query.parse(answer.stdout);
  } catch {
    names = undefined;
  }
  if (names === undefined) return none(`${asked} 的回答读不出来`);
  if (names.length > NODE_CONFIG_NAMES_MAX) return none(`${asked} 列出了 ${names.length} 项，超过一份报告能带的 ${NODE_CONFIG_NAMES_MAX} 项`);
  if (names.some((name) => name.trim() === '' || /[\u0000-\u001f\u007f]/.test(name))) return none(`${asked} 列出的名字里有不是一行文字的`);
  return { kind: query.kind, names };
}

// Why a list cannot travel in a report (the limits in shared/node-protocol.ts). The host
// refuses a whole report over one model out of shape, and a report goes with every poll: a
// list that does not fit is said here as no list, so the machine is never cut off by it.
function unfit(list: ModelInfo[]): string | undefined {
  if (list.length > NODE_MODELS_MAX) return `列出了 ${list.length} 个模型，超过一份报告能带的 ${NODE_MODELS_MAX} 个`;
  if (list.some(({ efforts }) => (efforts?.length ?? 0) > NODE_MODEL_EFFORTS_MAX)) return `列出的模型里有推理强度超过 ${NODE_MODEL_EFFORTS_MAX} 个的`;
  const words = list.flatMap(({ id, name, efforts, defaultEffort }) => [id, name ?? '', defaultEffort ?? '', ...(efforts ?? [])]);
  if (list.some(({ id }) => id.trim() === '') || words.some((each) => /[\u0000-\u001f\u007f]/.test(each))) return '列出的模型里有不是一行文字的名字';
  return undefined;
}

// A run that did not answer is one answer of its own, not a failure of the look.
async function runQuietly(run: CommandRun, argv: string[], timeoutMs: number, env?: Record<string, string>, signal?: AbortSignal): Promise<CommandAnswer> {
  try {
    return await run(argv, timeoutMs, env, signal);
  } catch (error) {
    return { stdout: '', stderr: '', code: null, failure: `运行不了 ${argv[0]}：${(error as Error).message}` };
  }
}

// The questions this program asks on a machine, from the adapters it ships.
export const shippedQuestions = (): ExecutorQuestion[] => questionsFrom(ADAPTERS);
