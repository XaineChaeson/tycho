// The watch process: one per round, started by the client and outliving it
// (docs/design/nodes.md §4.2). It owns the round from the gate on —
//
//   1. take the gate (`mkdir started`), register its pid and the moment it began,
//   2. publish its round marker, and refuse to start if a later round is already there,
//   3. start the Worker, with the credential in the variable its executor reads it from,
//   4. wait for it, record what it left behind and then the exit code, and leave.
//
// Nothing here asks the host anything and nothing here is asked: the client reads the
// files this process writes. That is what makes a client restart harmless — the gate was
// taken once, and the next client finds the round running and reads its output.
//
// Its own exit code says what happened, in the codes the client reports for a start:
//   0 ran to the end, 2 nothing was started, 3 the gate was already taken, 4 a stop
//   overtook the start, 6 a later round of the Task holds the instance.
import {openCapture,outputMetadata} from './capture.ts';
import { createRoundWatchdog } from './watchdog.ts';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startedAs } from '../service/entry.ts';
import { executorDirOf } from '../service/home-paths.ts';
import { processStart } from '../service/lock.ts';
import { parseUnifiedDiff, type TaskDiffFile } from '../service/diff.ts';
import { removeCodexAuthFile } from '../adapters/codex-auth.ts';
import { extractDesktopProvidersPatch } from '../adapters/dsh-routes.ts';
import { HANDOVER_ENV } from './client.ts';
import { ARTIFACTS_PLACEHOLDER, ARTIFACTS_TOML_PLACEHOLDER, MATERIALS_PLACEHOLDER, tomlString, wayProblem } from '../shared/node-protocol.ts';
import { selectProcesses } from './hostprocess.ts';
import type { HostProcesses } from './hostprocess.ts';
import type { LeftBehind, RunBox } from './runbox.ts';
import { launchOf, roundDirs } from './launch.ts';
import type { Launch } from './launch.ts';
import { noteNotStarted, prepareSource } from './source.ts';
import { beginRound, endRound } from './source-head.ts';
import { envHome } from './global-entry.ts';
import { ADAPTERS } from '../adapters/all.ts';
import { checkAgainst, dropOwn, folderChangeOf, readFolder, readOnlyRound, scratchOf, takeBaseline, writeCodeCheck } from './code-check.ts';
import type { Baseline } from './code-check.ts';
import type { NodeCodeCheck } from '../shared/node-protocol.ts';
import {
  boxOf, highestRound, markSuperseded, markerOf, publishRound, readExit, residueOf, stopRequested, Unreadable,
  takeGate, writeExit, writeLeft, writeNotStarted, writeWatchEvidence, writeWorkerEvidence,
} from './runbox.ts';

const GATE_TAKEN = 3;
const START_REVOKED = 4;
const START_SUPERSEDED = 6;
// Nothing was started: the code for a round whose code would not unpack, and for
// one whose Worker could not be run at all.
const NOTHING_STARTED = 2;
// What a stop or the local limit leaves as the ending when the Worker gave no code.
const KILLED_EXIT = 137;
const SUPERSEDED_EXIT = 86;
const ROUND_CHECK_MS = 10_000;
const STOP_CHECK_MS = 500;
const DIFF_TIMEOUT_MS = 5_000;
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
// How long a signalled round has to end by itself before its tree is killed.
const TERM_GRACE_MS = 5_000;
// How long what the round left behind has to go after it is ended, and how often it is
// looked at again while it does.
const RESIDUE_WAIT_MS = 5_000;
const RESIDUE_POLL_MS = 100;

interface WatchOptions {
  source?:string;nodeId?:string;
  dataDir: string;
  runDir: string;
  round: number;
  argv: string[];
  env: Record<string, string>;
  // How the Worker reads its credential (the executor's declaration, as the host sent it): the
  // name of the variable it goes in, and the token itself, which the client hands over in this
  // process's environment, never on a command line. The name is checked here before anything is
  // started: a name no system takes is a round that does not start.
  credentialVariable: string | null;
  credential?: string;
  // Optional host-managed GitHub token handed over via HANDOVER_ENV (never CLI argv).
  githubToken?: string;
  // The machine's lookup environment (node/lookup-env.ts), which the Worker's command is found
  // in: the client hands it over when it is not the one this process inherited (a login
  // shell's). Never the host's `env` above, which is the Worker's once its command is found.
  lookupEnv?: NodeJS.ProcessEnv;
  // How long this round may run here. The host has the same limit and stops the round
  // first; this one is what ends it when the host cannot be reached (nodes.md §4.4).
  timeoutMs?: number;
  // State-aware watchdog: max silence while waiting on model/init with no active tool/subprocess.
  modelIdleTimeoutMs?: number;
  // This machine's process table; a test gives one whose answers it decides.
  procs?: HostProcesses;
}

interface WatchArgs {
  source?:string;nodeId?:string;
  dataDir: string;
  runDir: string;
  round: number;
  argv: string[];
  credentialVariable: string | null;
  timeoutMs?: number;
  modelIdleTimeoutMs?: number;
}

export function parseWatchArgs(argv: string[]): WatchArgs {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  let after = false;
  for (const arg of argv) {
    if (after) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      after = true;
      continue;
    }
    const found = /^--([\w-]+)=(.*)$/.exec(arg);
    // One spelling for each: a switch this watch does not take (an older one's) is refused, never
    // read as if it were absent — a credential dropped that way would run the round as the machine.
    if (!found || !WATCH_SWITCHES.has(found[1]!)) throw new Error(`watch：不认识的参数 ${arg}`);
    values[found[1]!] = found[2]!;
  }
  const required = (name: string): string => {
    const value = values[name];
    if (value === undefined || value === '') throw new Error(`watch：缺少 --${name}`);
    return value;
  };
  const round = Number(required('round'));
  if (!Number.isInteger(round) || round < 1) throw new Error('watch：--round 应为正整数');
  return {
    ...(values.source===undefined?{}:{source:values.source,nodeId:required('node-id')}),
    dataDir: required('data'),
    runDir: required('run'),
    round,
    argv: rest,
    credentialVariable: values.credential === undefined || values.credential === '' ? null : values.credential,
    ...(values['timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['timeout-ms']) }),
    ...(values['model-idle-timeout-ms'] === undefined ? {} : { modelIdleTimeoutMs: Number(values['model-idle-timeout-ms']) }),
  };
}

const WATCH_SWITCHES = new Set(['data', 'run', 'round', 'credential', 'timeout-ms', 'model-idle-timeout-ms', 'source', 'node-id']);

// The watch's own notes go beside the round: they are for whoever has to read what
// happened, and they are never the evidence a judgment rests on.
function logger(box: RunBox): (line: string) => void {
  const path = join(box.runDir, 'watch.log');
  return (line: string): void => {
    try {
      writeFileSync(path, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
    } catch {
      // A round that cannot write its notes still runs.
    }
  };
}

// Ephemeral GIT_ASKPASS + GH_TOKEN environment for zero-config GitHub clone/push/gh
// inside a round. The token is never written to disk in the askpass helper — it only
// flows through TYCHO_GITHUB_TOKEN in the child process environment.
export function prepareGitHubEnv(
  scratchDir: string,
  token: string,
  platform: NodeJS.Platform = process.platform,
): { env: Record<string, string>; cleanup: () => void } {
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const isWin = platform === 'win32';
  const askpassPath = join(scratchDir, isWin ? 'git-askpass.cmd' : 'git-askpass.sh');
  const script = isWin
    ? '@echo off\r\necho %~1 | findstr /I "github.com" >nul\r\nif not %errorlevel%==0 exit /b 0\r\necho %~1 | findstr /I "username" >nul\r\nif %errorlevel%==0 (\r\n  echo x-access-token\r\n) else (\r\n  echo %TYCHO_GITHUB_TOKEN%\r\n)\r\n'
    : '#!/bin/sh\ncase "$1" in\n  *[Gg][Ii][Tt][Hh][Uu][Bb].[Cc][Oo][Mm]*)\n    case "$1" in\n      *[Uu]sername*) printf \'%s\\n\' \'x-access-token\' ;;\n      *) printf \'%s\\n\' "$TYCHO_GITHUB_TOKEN" ;;\n    esac\n    ;;\n  *) exit 0 ;;\nesac\n';
  writeFileSync(askpassPath, script, { mode: 0o700 });
  if (!isWin) chmodSync(askpassPath, 0o700);
  return {
    env: {
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      TYCHO_GITHUB_TOKEN: token,
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: '0',
    },
    cleanup: () => {
      rmSync(askpassPath, { force: true });
    },
  };
}

// The Worker's environment: the one the host sent plus this process's own, with the
// handover taken out. The credential is put back where the executor reads it, as the value of
// the variable it names — what it starts inherits that, and the machine is the boundary
// (native-login.md, nodes.md §9). Nobody watches a round's screen: git asks for no credential
// (on a terminal or in a window) and fails instead, which the brief says is a remote out of
// reach, not a round that waits out its time.
export function workerEnv(
  inherited: NodeJS.ProcessEnv,
  options: Pick<WatchOptions, 'env' | 'credentialVariable' | 'credential'>,
  runId: string,
  preparedCredentialEnv?: Record<string, string | undefined>,
  githubEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const { [HANDOVER_ENV]: _handover, ...rest } = inherited;
  const variable = options.credential === undefined ? null : options.credentialVariable;
  const merged: NodeJS.ProcessEnv = {
    ...rest,
    ...options.env,
    ...(githubEnv ?? {}),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    SSH_ASKPASS_REQUIRE: 'never',
    TYCHO_RUN: runId,
  };
  if (preparedCredentialEnv !== undefined) {
    for (const [key, value] of Object.entries(preparedCredentialEnv)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }
  if (variable !== null) merged[variable] = options.credential!;
  return merged;
}

// The machine's own paths where the host wrote the placeholders (shared/node-protocol.ts): the
// material the round reads and the directory it delivers into, and — for an executor whose own
// option is TOML — that same directory already written as a TOML string. The replacement is a
// function, so that a directory whose own name carries a dollar sign is a path and not a
// pattern's `$&`, `$'`, `` $` `` or `$$`; the TOML one is substituted before the plain one so that
// this name is never read as a prefix of the other.
export function fillPlaces(argv: readonly string[], dirs: { materials: string; artifacts: string }): string[] {
  return argv.map((arg) => arg
    .replaceAll(MATERIALS_PLACEHOLDER, () => dirs.materials)
    .replaceAll(ARTIFACTS_TOML_PLACEHOLDER, () => tomlString(dirs.artifacts))
    .replaceAll(ARTIFACTS_PLACEHOLDER, () => dirs.artifacts));
}

export async function runWatch(options: WatchOptions): Promise<number> {
  const box = boxOf(options.dataDir, options.runDir);
  const note = logger(box);
  const procs = options.procs ?? selectProcesses();

  if (!takeGate(box)) {
    note('闸门已经被占：这一轮不在这里重新启动');
    return GATE_TAKEN;
  }
  writeWatchEvidence(box, process.pid, processStart(process.pid));
  if (stopRequested(box)) {
    note('一开始就有停止标记：什么都没起');
    return START_REVOKED;
  }
  const latest = publishRound(box, options.round);
  if (latest > options.round) {
    note(`任务里已经有第 ${latest} 轮：这一轮（第 ${options.round} 轮）不启动`);
    writeLeft(box, 'none');
    writeExit(box, SUPERSEDED_EXIT);
    return START_SUPERSEDED;
  }

  const wrongWay = options.credentialVariable === null ? undefined : wayProblem({ via: 'env', variable: options.credentialVariable });
  if (wrongWay !== undefined) return notStarted(box, note, wrongWay);
  // A variable named and no credential handed over: started, the round would run as the machine.
  if (options.credentialVariable !== null && (options.credential === undefined || options.credential === '')) {
    return notStarted(box, note, '这一轮要用账号的登录，看管进程却没有拿到它：不开工');
  }
  // And a token with nowhere to put it would be dropped in silence, which is the same mistake.
  if (options.credentialVariable === null && options.credential !== undefined) {
    return notStarted(box, note, '看管进程拿到了令牌，却不知道放进哪个变量：不开工');
  }

  // Where this round's code is, prepared here and now: after the gate and the round marker,
  // and before anything is started, so that a round whose code cannot be prepared is one
  // that never ran (docs/design/code-sources.md §2). A read-only round's checkout is
  // baselined before the Worker starts (node/code-check.ts): a round whose code could not be
  // checked afterwards is not started.
  const githubEnv = options.githubToken !== undefined && options.githubToken !== ''
    ? prepareGitHubEnv(scratchOf(box), options.githubToken)
    : undefined;
  let preparedCredential: Record<string, string | undefined> | undefined;
  try {
  const readOnly = readOnlyRound(box);
  if (typeof readOnly === 'string') return endUnstarted(box, note, readOnly);
  const prepared = prepareSource(box, readOnly, githubEnv?.env);
  if (typeof prepared === 'string') return endUnstarted(box, note, prepared);
  let checked: { repo: string; base?: Baseline } | null = null;
  if (readOnly && prepared.check !== null) {
    try {
      checked = { repo: prepared.check, base: takeBaseline(prepared.check, scratchOf(box)) };
    } catch (error) {
      checked = { repo: prepared.check };
      note(`记不下这一轮代码的基线（仅作提示，不阻止开工）：${(error as Error).message}`);
    }
  }
  // A read-only round whose code is a folder reads that folder now and again once it is over:
  // information for the host, never a check (docs/design/code-sources.md §8.1, §8.2). The
  // reading only reads — the folder is not tycho's, and nothing is written into it.
  const folderBefore = readOnly && prepared.folder !== null ? readFolder(prepared.folder, scratchOf(box)) : null;
  // Where this round delivers what it made: always created on both writable and read-only
  // rounds so review/report artifacts can be written cleanly.
  try {
    mkdirSync(join(box.runDir, 'artifacts'), { recursive: true });
  } catch (error) {
    return endUnstarted(box, note, `开不出这一轮交东西的 artifacts/ 目录：${(error as Error).message}：这一轮没有开工`);
  }
  // Where the code stood when this round began: the Task's start is its first round's, and a
  // review's range is measured from it (docs/design/code-sources.md §8 第 6 条).
  const began = beginRound(box, note);

  // The Worker's command, found the way the probe found it (node/launch.ts): in the machine's
  // lookup environment, never the one the host sent, which only the Worker it starts gets.
  // On Windows an npm install leaves a `.cmd` wrapper that a bare spawn neither finds nor may start.
  // The material's place is the machine's to fill in: the arguments were built where the data
  // directory is not known, and the Worker's working directory is not under it.
  const argv = fillPlaces(options.argv, { materials: join(box.runDir, 'snapshot'), artifacts: join(box.runDir, 'artifacts') });
  const { [HANDOVER_ENV]: _handover, ...inherited } = process.env;
  if (options.credential !== undefined && options.credentialVariable !== null) {
    const adapter = Object.values(ADAPTERS).find((each) => each.prepareCredential !== undefined && each.probe?.command === options.argv[0]);
    if (adapter?.prepareCredential) {
      let baseExecutorDir: string | undefined;
      if (adapter.globalEntry) {
        try {
          baseExecutorDir = executorDirOf(inherited, envHome(inherited), adapter.globalEntry.home.env, adapter.globalEntry.home.dir);
        } catch {
          baseExecutorDir = undefined;
        }
      }
      try {
        preparedCredential = adapter.prepareCredential({
          variable: options.credentialVariable,
          credential: options.credential,
          scratchDir: scratchOf(box),
          taskDir: box.taskDir,
          ...(baseExecutorDir === undefined ? {} : { baseExecutorDir }),
        });
      } catch (error) {
        return notStarted(box, note, (error as Error).message);
      }
    }
  }
  const env = workerEnv(process.env, options, box.runId, preparedCredential, githubEnv?.env);
  const lookup = options.lookupEnv ?? inherited;
  // For machine-local dsh rounds, unify Desktop and Headless custom `llm-pi-ai` providers:
  // layer Desktop's `llm-pi-ai` block right before any `--patch` tier overlay so custom gateways
  // and models added in DeepSeek Harness Desktop are immediately runnable in headless mode.
  if (argv[0] === 'dsh' && options.credential === undefined) {
    const desktopPatch = extractDesktopProvidersPatch({ env: lookup });
    if (desktopPatch) {
      try {
        const patchFile = join(box.runDir, 'snapshot', 'desktop-providers.patch.yml');
        writeFileSync(patchFile, desktopPatch, 'utf8');
        const profileIdx = argv.indexOf('--profile');
        const insertAt = profileIdx >= 0 && profileIdx + 2 <= argv.length ? profileIdx + 2 : 1;
        argv.splice(insertAt, 0, '--patch', patchFile);
      } catch { /* non-fatal: proceed with headless profile as-is */ }
    }
  }
  const exclude = roundDirs(box.dataDir, box.taskDir);
  let launch: Launch;
  try {
    launch = launchOf(argv, lookup, process.platform, { cwd: prepared.cwd, exclude });
  } catch (error) {
    return notStarted(box, note, (error as Error).message);
  }
  let capture:Awaited<ReturnType<typeof openCapture>>;
  try{capture=await openCapture(options.dataDir,options.nodeId??'',options.runDir,options.source);}catch(error){return notStarted(box,note,(error as Error).message);}
  const out=capture?undefined:openSync(join(box.runDir,'stdout.ndjson'),'a');
  const err=capture?undefined:openSync(join(box.runDir,'stderr.log'),'a');
  const stdio: Parameters<typeof spawn>[2]['stdio'] = capture?['ignore','pipe','pipe']:['ignore',out!,err!];
  let child: ChildProcess;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: prepared.cwd,
      env,
      stdio,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
      // A group of the Worker's own, where the system has groups: ending this round then
      // reaches everything it started, also after the watch process is gone (nodes.md §4.2,
      // §4.4). On Windows the parent links plus `taskkill /T` are what there is instead. The
      // watch process has no console (the client starts it detached), so the Worker gets one of
      // its own, and a Ctrl+C sent there reaches neither (tests/console-ctrl-c.test.ts).
      detached: workerOwnGroup(),
    });
  } catch (error) {
    if(out!==undefined)closeSync(out);if(err!==undefined)closeSync(err);
    await capture?.finish(null,'Worker未启动');
    return notStarted(box, note, (error as Error).message);
  }
  if(out!==undefined)closeSync(out);if(err!==undefined)closeSync(err);
  let ending: 'done' | 'stop' | 'superseded' | 'limit' | 'turn_hang' | 'idle' = 'done';
  let endingDetail: string | undefined;
  const asked = Promise.withResolvers<void>();
  const ask = (why: 'stop' | 'superseded' | 'limit' | 'turn_hang' | 'idle', detail?: string): void => {
    if (ending !== 'done') return;
    ending = why;
    endingDetail = detail;
    asked.resolve();
  };
  let executorName: string | undefined;
  try {
    executorName = outputMetadata(options.dataDir, options.runDir)?.executor;
  } catch {
    executorName = undefined;
  }
  if (executorName === undefined) {
    executorName = Object.entries(ADAPTERS).find(([, adapter]) => adapter.probe?.command === options.argv[0])?.[0];
  }
  const watchdog = capture
    ? createRoundWatchdog({
        ...(executorName === undefined ? {} : { executor: executorName }),
        ...(options.modelIdleTimeoutMs === undefined ? {} : { modelIdleTimeoutMs: options.modelIdleTimeoutMs }),
        hasDescendantProcesses: async () => {
          const found = await residueOf(child.pid!, box.runId, procs);
          return found.left === 'unverified' || found.found.some((pid) => pid !== child.pid);
        },
        onTrigger: (reason, detail) => {
          ask(reason === 'turn_completed_hang' ? 'turn_hang' : 'idle', detail);
        },
        onNote: (msg) => note(msg),
      })
    : undefined;
  child.stdout?.on('data', (bytes: Buffer) => {
    capture?.feed('stdout', bytes);
    watchdog?.feedStdout(bytes);
  });
  child.stderr?.on('data', (bytes: Buffer) => {
    capture?.feed('stderr', bytes);
    watchdog?.feedStderr(bytes);
  });
  const outputClosed = capture ? new Promise<void>((resolve) => child.once('close', () => resolve())) : Promise.resolve();
  // No pid: the system refused to start it, and says why in the error that follows. Nothing
  // ran, so this round did not start — not a Worker that was killed (exit 137).
  if (child.pid === undefined) {
    watchdog?.dispose();
    const refused = await new Promise<Error>((resolve) => child.once('error', resolve));
    await outputClosed;await capture?.finish(null,'Worker未启动：'+refused.message);
    return notStarted(box, note, refused.message);
  }
  // The Worker's own pid and moment, before anything can go wrong: the watch process can be
  // killed while the Worker runs on, and this is what still proves whose it is (nodes.md §4.3).
  writeWorkerEvidence(box, child.pid, processStart(child.pid));
  note(`第 ${options.round} 轮已启动：pid ${child.pid}（Worker ${options.argv[0]}）`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => ask('stop'));
  const limit = options.timeoutMs !== undefined && options.timeoutMs > 0
    ? setTimeout(() => ask('limit'), options.timeoutMs)
    : undefined;
  limit?.unref?.();

  // Poll stopRequested responsively so interrupts finish well within STOP_GRACE_MS,
  // while keeping round supersession and watchdog heartbeat checks on ROUND_CHECK_MS.
  const stopChecking = setInterval(() => {
    if (stopRequested(box)) ask('stop');
  }, STOP_CHECK_MS);
  stopChecking.unref?.();
  if (stopRequested(box)) ask('stop');

  const checking = setInterval(() => {
    if (stopRequested(box)) ask('stop');
    if (highestRound(box) > options.round) ask('superseded');
    void watchdog?.tick();
  }, ROUND_CHECK_MS);
  checking.unref?.();

  let finished = false;
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      note(`Worker 出错：${error.message}`);
      finished = true;
      resolve(null);
    });
    child.once('exit', (code) => {
      finished = true;
      resolve(code);
    });
  });

  const winner = await Promise.race([
    exited.then((code) => ({ won: 'exited' as const, code })),
    asked.promise.then(() => ({ won: 'asked' as const, code: null as number | null })),
  ]);
  watchdog?.dispose();
  const stopReason = ending as 'done' | 'stop' | 'superseded' | 'limit' | 'turn_hang' | 'idle';
  let final: number | null = winner.won === 'exited' ? winner.code : null;
  // A superseded round ends as that, whatever its Worker said on the way out.
  let supersededCode: number | null = null;
  if (stopReason === 'superseded') {
    markSuperseded(box);
    supersededCode = SUPERSEDED_EXIT;
  }
  if (stopReason !== 'done') {
    const why = stopReason;
    note(
      why === 'superseded'
        ? '任务里已经有更后一轮：结束这一轮的进程'
        : why === 'limit'
          ? '到本地时限：结束这一轮的进程'
          : why === 'turn_hang'
            ? (endingDetail ?? '执行器已完成但进程未退出：清理进程树并保留结果')
            : why === 'idle'
              ? (endingDetail ?? '等待模型长时间无响应：结束这一轮的进程')
              : '收到停止：结束这一轮的进程',
    );
    if (!finished) {
      if (process.platform === 'win32') {
        if (child.pid !== undefined) await procs.endGroup(child.pid, 'KILL');
        final = await Promise.race([exited, delay(1_000).then(() => null)]);
      } else {
        await endWorker(child.pid, procs);
        final = await Promise.race([exited, delay(TERM_GRACE_MS).then(() => null)]);
        if (final === null && child.pid !== undefined) {
          // Nothing answered to the interrupt: the group is killed, which is not a normal end
          // and is recorded as one.
          await procs.endGroup(child.pid, 'KILL');
        }
      }
      if (final === null) {
        final = KILLED_EXIT;
      }
    } else if (final === null) {
      // Child exited in the same tick that `asked` won the race: collect its resolved exit code.
      final = await Promise.race([exited, delay(50).then(() => null)]);
    }
  }
  clearInterval(stopChecking);
  clearInterval(checking);
  if (limit) clearTimeout(limit);

  const endingCode = supersededCode ?? final ?? recordedExit(box) ?? KILLED_EXIT;
  // What is left is settled and then recorded, both before the code: a client that reads the
  // code then knows whether anything of this round survived, without a scan that may be
  // refused. A round's processes do not outlive it (nodes.md §4.2, §6).
  const left = await clearResidue(box, procs, child.pid, note).catch(() => 'unverified' as const);
  // What this machine read of the round's code once nothing of it runs any more: where the code
  // stands and, for a repository round that could push, the remote head of its branch. Skip on
  // explicit stop so slow `git ls-remote` never blows past STOP_GRACE_MS.
  if (stopReason !== 'stop') {
    endRound(box, began, note);
    if (existsSync(join(prepared.cwd, '.git'))) {
      writeBoundedGitDiff(box, prepared.cwd, began?.head ?? null);
    }
  }
  // A read-only round's code is checked once nothing of it runs any more, and the evidence is
  // on disk before the exit code: a code with no evidence beside it is a check not made.
  // A record that cannot be written leaves the round ended all the same: the exit code goes on
  // without it, and the host reads that as a check it cannot vouch for, never as a lost round.
  if (readOnly) {
    const advisory: NodeCodeCheck = checked !== null
      ? checkAgainst(checked.repo, checked.base, scratchOf(box))
      : {
          result: 'no-code' as const,
          ...(folderBefore === null || prepared.folder === null
            ? {}
            : { folder_change: folderChangeOf(folderBefore, readFolder(prepared.folder, scratchOf(box))) }),
        };
    try {
      writeCodeCheck(box, advisory);
    } catch (error) {
      note(`代码核对的记录没能写下：${(error as Error).message}`);
    }
    dropOwn(box);
    note(`代码核对（仅提示）：${advisory.result}${advisory.result === 'changed' ? `：${advisory.changes.join('；')}` : advisory.result === 'unverifiable' ? `：${advisory.why}` : ''}`);
  }
  if(capture){
    if(left!=='none' || stopReason === 'turn_hang'){child.stdout?.destroy();child.stderr?.destroy();}
    await outputClosed;
    const captureProblem = stopReason === 'idle'
      ? (endingDetail ?? '等待模型长时间无响应，已自动中止')
      : (left === 'none' || stopReason === 'turn_hang' ? undefined : '无法核实采集流完整性');
    try{await capture.finish(endingCode, captureProblem);}catch(error){note('原生结果无法封存：'+(error as Error).message);}
  }
  try {
    rmSync(scratchOf(box), { recursive: true, force: true });
  } catch {
    // Scratch files held open by OS stay unread and go with run retention.
  }
  writeLeft(box, left);
  writeExit(box, endingCode);
  note(`第 ${options.round} 轮结束：exit ${endingCode}，留下的进程：${left}`);
  return 0;
  } finally {
    if (preparedCredential?.CODEX_HOME) {
      removeCodexAuthFile(preparedCredential.CODEX_HOME);
    }
    githubEnv?.cleanup();
  }
}

function trimUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
}

// Best-effort bounded git diff capture (max 256 KiB, max 5s total budget) written to
// `<runDir>/diff.json` so remote diffs can be persisted and served without re-cloning.
// Never mutates the working tree or `.git/index` and never fails a round.
function writeBoundedGitDiff(box: RunBox, cwd: string, startHead: string | null): void {
  try {
    const deadline = Date.now() + DIFF_TIMEOUT_MS;
    const cleanEnv: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_OPTIONAL_LOCKS: '0',
    };
    const gitOut = (args: string[]): string | null => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const res = spawnSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: remaining,
        maxBuffer: 4 * 1024 * 1024,
        env: cleanEnv,
      });
      if (res.error || res.status !== 0) return null;
      return typeof res.stdout === 'string' ? res.stdout : '';
    };

    const commit = gitOut(['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim() || null;
    const rawBranch = gitOut(['symbolic-ref', '--short', '--quiet', 'HEAD'])?.trim() || null;
    const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;

    let base = startHead && startHead.trim() !== '' ? startHead.trim() : null;
    if (!base && commit) {
      base = gitOut(['merge-base', 'HEAD', 'origin/HEAD'])?.trim() || null;
      if (!base) base = gitOut(['rev-parse', '--verify', '--quiet', 'HEAD~1'])?.trim() || null;
    }

    const rawDiff = base
      ? (gitOut(['diff', '--no-color', '--find-renames', base]) ?? '')
      : commit
        ? (gitOut(['diff', '--no-color', '--find-renames', 'HEAD']) ?? '')
        : '';

    const parsed = parseUnifiedDiff(rawDiff, MAX_DIFF_BYTES);
    const files: TaskDiffFile[] = [...parsed.files];
    let truncated = parsed.truncated;
    let usedBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.patch, 'utf8'), 0);

    const untrackedOut = gitOut(['ls-files', '--others', '--exclude-standard']);
    if (untrackedOut) {
      const existing = new Set(files.map((file) => file.path));
      for (const rawName of untrackedOut.split(/\r?\n/)) {
        const relPath = rawName.trim();
        if (!relPath || existing.has(relPath)) continue;
        if (Date.now() >= deadline) {
          truncated = true;
          break;
        }
        const fullPath = join(cwd, relPath);
        let st;
        try {
          st = statSync(fullPath);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (st.size > MAX_UNTRACKED_FILE_BYTES) {
          files.push({
            path: relPath,
            status: 'added',
            additions: 0,
            deletions: 0,
            patch: `diff --git a/${relPath} b/${relPath}\nnew file\nBinary or large file (${st.size} bytes)`,
          });
          continue;
        }
        let buf: Buffer;
        try {
          buf = readFileSync(fullPath);
        } catch {
          continue;
        }
        if (buf.includes(0)) {
          files.push({
            path: relPath,
            status: 'added',
            additions: 0,
            deletions: 0,
            patch: `diff --git a/${relPath} b/${relPath}\nnew file\nBinary file`,
          });
          continue;
        }
        const content = buf.toString('utf8').replace(/\r\n/g, '\n');
        const lines = content === '' ? [] : content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
        const body = lines.map((line) => `+${line}`).join('\n');
        const fullPatch = [
          `diff --git a/${relPath} b/${relPath}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${relPath}`,
          ...(lines.length > 0 ? [`@@ -0,0 +1,${lines.length} @@`, body] : []),
        ].join('\n');
        const remaining = Math.max(0, MAX_DIFF_BYTES - usedBytes);
        const patchBytes = Buffer.byteLength(fullPatch, 'utf8');
        let patch = fullPatch;
        if (patchBytes > remaining) {
          truncated = true;
          patch = remaining > 0 ? trimUtf8(fullPatch, remaining) : '';
          usedBytes = MAX_DIFF_BYTES;
        } else {
          usedBytes += patchBytes;
        }
        files.push({ path: relPath, status: 'added', additions: lines.length, deletions: 0, patch });
      }
    }

    const payload = {
      source: 'git' as const,
      commit,
      base,
      branch,
      files,
      truncated,
    };
    let serialized = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DIFF_BYTES) {
      payload.truncated = true;
      for (let i = payload.files.length - 1; i >= 0 && Buffer.byteLength(serialized, 'utf8') > MAX_DIFF_BYTES; i -= 1) {
        const overflow = Buffer.byteLength(serialized, 'utf8') - MAX_DIFF_BYTES;
        const current = payload.files[i]!.patch;
        const keep = Math.max(0, Buffer.byteLength(current, 'utf8') - overflow - 64);
        payload.files[i]!.patch = keep > 0 ? trimUtf8(current, keep) : '';
        serialized = `${JSON.stringify(payload)}\n`;
      }
      while (payload.files.length > 0 && Buffer.byteLength(serialized, 'utf8') > MAX_DIFF_BYTES) {
        payload.files.pop();
        serialized = `${JSON.stringify(payload)}\n`;
      }
    }
    const target = join(box.runDir, 'diff.json');
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, serialized);
    renameSync(tmp, target);
  } catch {
    // Best-effort diff capture; never fail or delay settlement of a round.
  }
}

// A code already on disk for this round, when the Worker gave none. One that cannot be read
// is not one: this process ends the round with its own code instead.
function recordedExit(box: RunBox): number | null {
  try {
    return readExit(box);
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

// A round whose Worker could not be run at all: the ending for a round that did
// not start, with the system's words in stderr.log, where the host reads why a round ended.
const notStarted = (box: RunBox, note: (line: string) => void, said: string): number => endUnstarted(box, note, `Worker 没能启动：${said}`);

// The ending of a round no Worker ran in: why, where the host reads it (stderr.log) and as
// the machine's evidence that nothing ran, then nothing left, then the code.
function endUnstarted(box: RunBox, note: (line: string) => void, reason: string): number {
  note(reason);
  dropOwn(box);
  noteNotStarted(box, reason);
  writeNotStarted(box, reason);
  writeLeft(box, 'none');
  writeExit(box, NOTHING_STARTED);
  return NOTHING_STARTED;
}

// The Worker's own process group, where the system has groups, so that ending this round
// reaches everything the Worker started even after the watch process is gone (nodes.md
// §4.2, §4.4). On Windows there is no such thing, and `taskkill /T` follows the parent
// links instead; starting it detached there would mean no console at all.
export const workerOwnGroup = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32';

// A round leaves nothing running behind it. What the Worker left is ended here — its whole
// group first, then whatever escaped it — and then looked at again: only a look that finds
// nothing is recorded as `none`, and one that cannot be made is `unverified`.
async function clearResidue(
  box: RunBox,
  procs: HostProcesses,
  worker: number | undefined,
  note: (line: string) => void,
): Promise<LeftBehind> {
  const root = worker ?? process.pid;
  let found = await residueOf(root, box.runId, procs);
  if (found.left !== 'some') return found.left;
  note(`这一轮还留下 ${found.found.join(' ')}：结束它们`);
  const escaped = new Set(found.found.filter((pid) => pid !== root));
  if (worker !== undefined) await procs.endGroup(worker, 'KILL');
  for (const pid of escaped) await procs.endTree(pid, 'KILL');
  for (const deadline = Date.now() + RESIDUE_WAIT_MS; ; ) {
    found = await residueOf(root, box.runId, procs);
    if (found.left !== 'some' || Date.now() > deadline) return found.left;
    await delay(RESIDUE_POLL_MS);
  }
}

// The Worker's group first, then the processes themselves: an interrupt a CLI can act on
// before the kill. On Windows there is no signal to send, and the taskkill is all there is.
async function endWorker(pid: number | undefined, procs: HostProcesses): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === 'win32') return;
  await procs.endGroup(pid, 'INT');
}

// Holds the process: once the Worker has exited, a wait in the round's ending may be all
// that is left running here, and the record and the exit code still have to be written
// after it. The command-line entry ends with process.exit, so nothing waits on it longer.
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

if (startedAs(import.meta.filename)) {
  // The handover (the Worker's environment and the credential) comes in this process's own
  // environment; the Worker never sees either of those two entries (nodes.md §9).
  let handover: { env?: Record<string, string>; credential?: string; githubToken?: string; lookup?: Record<string, string> } = {};
  try {
    handover = JSON.parse(process.env[HANDOVER_ENV] ?? '{}') as typeof handover;
  } catch {
    handover = {};
  }
  let options: WatchArgs;
  try {
    options = parseWatchArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error));
    process.exit(2);
  }
  runWatch({
    ...options,
    env: handover.env ?? {},
    ...(handover.credential === undefined ? {} : { credential: handover.credential }),
    ...(handover.githubToken === undefined ? {} : { githubToken: handover.githubToken }),
    ...(handover.lookup === undefined ? {} : { lookupEnv: handover.lookup }),
  }).then((code) => process.exit(code), (error: unknown) => {
    console.error(String(error));
    process.exit(2);
  });
}

export { GATE_TAKEN, START_REVOKED, START_SUPERSEDED, SUPERSEDED_EXIT, KILLED_EXIT };
