import './guard.ts';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeManifest } from '../cli/manifest.ts';
import type { Cli, ExecResult, System } from '../cli/system.ts';
import { RELEASE_DIRS, RELEASE_FILES } from '../scripts/pack.ts';
import { SCHEMA_VERSION } from '../service/db.ts';
import { isAlive } from '../service/lock.ts';
import { CONSOLE_DIST } from './helpers.ts';

export const REPO = join(import.meta.dirname, '..');
export const STUB_SERVICE = join(import.meta.dirname, 'cli-stub-service.ts');

export interface Call {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

// What the helpers here started and made for one test, torn down by one hook of its own:
// every process ended and seen gone first, newest first, then every directory removed.
// Hooks run in the order they were registered, so a directory made before a process was
// started would otherwise go first — under a process that Windows will not delete it
// from, or that goes on writing into it. A process that does not end, or a directory
// that cannot be removed, fails the test: left behind, it skews the timing of the tests
// after it and every listing of processes on this machine.
interface Teardown {
  processes: (() => Promise<void>)[];
  dirs: string[];
}
const teardowns = new WeakMap<TestContext, Teardown>();

function teardownOf(t: TestContext): Teardown {
  const known = teardowns.get(t);
  if (known) return known;
  const own: Teardown = { processes: [], dirs: [] };
  teardowns.set(t, own);
  t.after(async () => {
    const failures: unknown[] = [];
    for (const stop of own.processes.reverse()) {
      try {
        await stop();
      } catch (err) {
        failures.push(err);
      }
    }
    // A process that did not end may still stand in its directory: removing it would
    // only add a second, misleading failure.
    if (failures.length === 0) {
      for (const dir of own.dirs.reverse()) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        } catch (err) {
          failures.push(err);
        }
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `测试的清理没做完：${failures.map((err) => (err as Error).message).join('；')}`);
  });
  return own;
}

// A process of this test's, ended (and seen gone) by `stop` before any of its directories
// are removed. `stop` may already have been called by the test itself: it must be safe to
// call again.
export function ownProcess(t: TestContext, stop: () => Promise<void>): void {
  teardownOf(t).processes.push(stop);
}

// How long a process of a test's is given to leave by itself once asked, and how long it
// is then given to be gone once it is made to. On POSIX the asking (SIGTERM, a shutdown
// request) is only a request, and some stand-ins take their time on purpose
// (STUB_STOP_DELAY_MS); on Windows `kill()` already ends the process. These are this
// test's own processes, so one that has not left is ended outright.
export interface Ending {
  graceMs?: number;
  waitMs?: number;
}

// Ends a child process this test started and waits until it is gone: asked first, then
// made to. One that has already left is what this was for. Only one that outlives SIGKILL
// is a failure.
export async function endChild(child: ChildProcess, { graceMs = 2_000, waitMs = 20_000 }: Ending = {}): Promise<void> {
  if (child.pid === undefined) return;
  const gone = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const left = (ms: number): Promise<void> =>
    gone()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
  if (!gone()) child.kill();
  await left(graceMs);
  if (!gone()) child.kill('SIGKILL');
  await left(waitMs);
  // Its own exit seen is the answer: the pid is free from then on, and on a busy machine
  // (Windows reuses pids within seconds) asking about it again can find someone else.
  if (!gone()) throw new Error(`测试起的进程 ${child.pid} 强行结束后过了 ${waitMs / 1000} 秒还在`);
}

// The same for a process this test only knows by pid, already asked to leave some other
// way (a shutdown request): given the grace, then ended outright.
export async function endPid(pid: number, { graceMs = 2_000, waitMs = 20_000 }: Ending = {}): Promise<void> {
  const until = async (ms: number): Promise<void> => {
    for (let waited = 0; isAlive(pid) && waited < ms; waited += 50) await sleep(50);
  };
  await until(graceMs);
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      // Gone between the look and the signal: what the signal was for.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  await until(waitMs);
  if (isAlive(pid)) throw new Error(`测试的进程 ${pid} 强行结束后过了 ${waitMs / 1000} 秒还在`);
}

export function tempDir(t: TestContext, name = 'tycho-cli-'): string {
  const own = teardownOf(t);
  // As the file system spells it: on macOS the temporary directory is behind a symlink.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), name)));
  own.dirs.push(dir);
  return dir;
}

// This checkout as a release is packed from it, in a directory of the test's own: the
// sources as they are here, and for the console a stand-in build beside a frontend
// project that must stay out of the package. Packing the checkout itself would need the
// console built first, which takes a toolchain these tests do not ask for, and would
// write into the repository. `built: false` is a clone nobody has built yet.
export function releaseRoot(t: TestContext, { built = true }: { built?: boolean } = {}): string {
  const root = join(tempDir(t), 'checkout');
  const put = (path: string, content = ''): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  // What the packer itself leaves out is left out here too, only to keep the copy small.
  const wanted = (source: string): boolean => source === REPO || (!basename(source).startsWith('.') && basename(source) !== 'node_modules');
  for (const dir of RELEASE_DIRS.filter((each) => !each.startsWith('console'))) {
    cpSync(join(REPO, dir), join(root, dir), { recursive: true, filter: wanted });
  }
  for (const file of RELEASE_FILES) copyFileSync(join(REPO, file), join(root, file));
  if (built) cpSync(CONSOLE_DIST, join(root, 'console', 'dist'), { recursive: true });
  put('console/package.json', '{"name":"tycho-console","private":true}');
  put('console/package-lock.json', '{}');
  put('console/index.html', '<!doctype html>');
  put('console/src/main.tsx', 'export {};');
  put('console/node_modules/some-package/index.js', 'export {};');
  put('tests/a.test.ts');
  put('docs/a.md');
  return root;
}

// A directory shaped like an unpacked release: a version, the Node this repository asks
// for, a service entry that is the stub, and a restore entry that records how it was called.
// `ledger` is what the package declares it writes (package.json's tycho.ledger), which the
// automatic path checks before it will install anything.
export function stubApp(appRoot: string, version = '1.0.0', { ledger = SCHEMA_VERSION }: { ledger?: number | null } = {}): string {
  mkdirSync(join(appRoot, 'service'), { recursive: true });
  mkdirSync(join(appRoot, 'cli'), { recursive: true });
  const { engines } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { engines: unknown };
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({
    name: 'tycho', version, type: 'module', engines,
    ...(ledger === null ? {} : { tycho: { ledger, basis: '测试用的包：它自己说不动账本' } }),
  }));
  copyFileSync(STUB_SERVICE, join(appRoot, 'service', 'main.ts'));
  writeFileSync(join(appRoot, 'cli', 'main.ts'), `console.log('stub cli ${version}');\n`);
  writeFileSync(
    join(appRoot, 'service', 'restore.ts'),
    [
      `import { writeFileSync } from 'node:fs';`,
      `import { join } from 'node:path';`,
      `writeFileSync(join(process.env.TYCHO_DATA, 'restore-call.json'), JSON.stringify(process.argv.slice(2)));`,
      `process.exit(Number(process.env.STUB_RESTORE_EXIT ?? 0));`,
      '',
    ].join('\n'),
  );
  // What pack.ts ships with every release: how a reinstall tells the same program from another.
  writeManifest(appRoot);
  return appRoot;
}

// The same directory, but a real release of this repository: every file the packer ships,
// including the built console, so what starts from it is this repository's own
// service/main.ts and not a stand-in. `mutate` is where a test makes the package the
// candidate that must fail — the way a real bad release is made, by shipping different
// code, not by standing in for the service.
export function realApp(appRoot: string, version: string, { source, mutate }: { source: string; mutate?: (root: string) => void }): string {
  cpSync(source, appRoot, { recursive: true });
  const manifest = join(appRoot, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...(JSON.parse(readFileSync(manifest, 'utf8')) as object), version }));
  // Before the mutation: a bad candidate is the release that was packed, failing where it runs.
  writeManifest(appRoot);
  mutate?.(appRoot);
  return appRoot;
}

// The environment a real service of a test is started with: this machine's, less
// everything that would make it reach outside the test — the Claude Code on PATH or
// in a native install under the owner's home, which would start a Router. `own` is a
// directory of the test's, removed with it.
export function serviceEnv(own: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const bare = join(tmpdir(), 'tycho-no-path');
  mkdirSync(bare, { recursive: true });
  return {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    USERPROFILE: join(own, 'no-home'),
    HOME: join(own, 'no-home'),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    // Keep the developer's desktop app installations out of this isolated environment.
    ...(process.platform === 'win32' ? { LOCALAPPDATA: join(own, 'localappdata') } : {}),
    PATH: bare,
    ...extra,
  };
}

export interface RealService {
  // Null when the program `current` names did not come up.
  port: number | null;
  child: ChildProcess;
  version: string;
  // What the program wrote to its standard error so far: the evidence of why one did
  // not come up, which a service manager would keep in its journal.
  said(): string;
}

// The program `current` names, started the way the launcher starts it: what a service
// manager would run, with nothing of it stood in for. A program that cannot start (or
// cannot open its ledger) is a real failure of a real candidate: the answer is null.
// `pollMs` is how often service.json is looked at; only the helper's own test changes it.
export async function startRealService(
  t: TestContext,
  prefix: string,
  dataDir: string,
  env: Record<string, string> = {},
  { pollMs = 20 }: { pollMs?: number } = {},
): Promise<RealService> {
  const version = readFileSync(join(prefix, 'current'), 'utf8').trim();
  const entry = join(prefix, 'versions', version, 'service', 'main.ts');
  // Beside the data directory, not in it: the service's own files are what the tests read.
  const logs = join(dataDir, '..', 'service-output');
  mkdirSync(logs, { recursive: true });
  const log = join(logs, `${version}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
  const fd = openSync(log, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [entry], {
      // 0: the service binds a free port itself and names it in service.json. A port found free
      // here and handed over can be taken by another process before the service binds it.
      env: { ...serviceEnv(join(dataDir, '..'), env), TYCHO_DATA: dataDir, TYCHO_PORT: '0' },
      stdio: ['ignore', fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  ownProcess(t, () => endChild(child));
  const said = (): string => {
    try {
      return readFileSync(log, 'utf8');
    } catch {
      return '';
    }
  };
  return { port: await answered(dataDir, child, said, pollMs), child, version, said };
}

// The port this process wrote into service.json; null if it never came up. Its own entry,
// not a file with the right shape: the one before it leaves the file behind until it exits.
// service.json alone is not enough: a candidate an upgrade stops at once lives a few
// milliseconds, and the service removes the file as it exits, so a poll can miss all of it.
// Once the process is gone, its own output says whether it came up: the line below is
// written after service.json and stays in the log.
async function answered(dataDir: string, child: ChildProcess, said: () => string, pollMs: number, waitMs = 30_000): Promise<number | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const port = Number(/服务已启动：http:\/\/[^\s，]+:(\d+)/.exec(said())?.[1]);
      return Number.isInteger(port) && port > 0 ? port : null;
    }
    try {
      const { port, pid } = JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { port?: number; pid?: number };
      if (pid === child.pid && Number.isInteger(port) && port! > 0) return port!;
    } catch {
      // Not written yet, or written by the service before this one.
    }
    await sleep(pollMs);
  }
  return null;
}

// What the service manager of an installed autostart does in these tests: asked to start
// the service, it starts the real program `current` names. Every start the fake systemctl
// is asked for is answered here, so the versions that come up are the ones the installer
// switched to — including the one before it, after a rollback.
export function managerServes(t: TestContext, s: Stage, { prefix, dataDir, env = {} }: { prefix: string; dataDir: string; env?: Record<string, string> }) {
  const starts = (): number => s.calls.filter(({ file, args }) => file === 'systemctl' && (args.includes('start') || args.includes('--now'))).length;
  const served = new Set<number>();
  const up: RealService[] = [];
  return {
    // Waits for the manager to be asked to start, then serves that request. Null when the
    // program it points at does not come up.
    async serve(what = '请服务管理器启动服务'): Promise<RealService | null> {
      await until(what, () => starts() > served.size);
      served.add(starts());
      const service = await startRealService(t, prefix, dataDir, env);
      up.push(service);
      return service.port === null ? null : service;
    },
    starts,
    up,
    // Everything started here, still running.
    async stopAll(): Promise<void> {
      for (const service of up) await endChild(service.child);
    },
  };
}

export interface StageOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string>;
  appRoot?: string;
  system?: Partial<System>;
  // Answers a program the CLI runs; absent or undefined means it succeeded silently.
  respond?: (call: Call) => Partial<ExecResult> | undefined;
  // Why a program to be left running could not be started; absent means it was.
  refuseLaunch?: (call: Call) => string | null;
}

export interface Stage {
  cli: Cli;
  dir: string;
  home: string;
  dataDir: string;
  out: string[];
  err: string[];
  // Every program run to its end, and every program started and left running.
  calls: Call[];
  launched: Call[];
  text(): string;
}

// A CLI whose machine is a temporary directory and two recorders. Nothing in it reaches
// the real home directory, PATH or service manager.
export function stage(t: TestContext, options: StageOptions = {}): Stage {
  const dir = tempDir(t);
  const home = join(dir, 'home');
  const dataDir = join(dir, 'data');
  // A service that a failed test left running is asked to stop before the directory is
  // removed, or the test file would never finish. Asked the way the command asks, never
  // by pid: tests write service.json files by hand that name this very process or its
  // parent.
  ownProcess(t, async () => {
    for (const where of [dataDir, join(home, '.tycho', 'host')]) {
      let pid: number | undefined;
      try {
        const said = JSON.parse(readFileSync(join(where, 'service.json'), 'utf8')) as { port: number; token: string; pid?: number };
        await fetch(`http://127.0.0.1:${said.port}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${said.token}` }, signal: AbortSignal.timeout(2000) });
        pid = said.pid;
      } catch {
        // No service there, or nothing that answers.
        continue;
      }
      // It answered, so it is a service of this test and is on its way out; one that
      // takes longer than the grace is ended outright. Windows will not remove a
      // directory a process still has open: it has to be gone, not merely asked.
      // Not a pid a test wrote by hand to mean this process or its parent.
      if (pid === undefined || pid === process.pid || pid === process.ppid) continue;
      await endPid(pid);
    }
  });
  mkdirSync(home);
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const launched: Call[] = [];
  // The same on every host unless a test asks: nothing here runs a platform's own tools.
  const platform = options.platform ?? 'linux';
  const system: System = {
    platform,
    env: {
      // What a child node needs on Windows; nothing of the developer's own setup.
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      TYCHO_DATA: dataDir,
      PATH: '',
      ...(platform === 'win32' ? { APPDATA: join(dir, 'appdata'), USERDOMAIN: 'PC', USERNAME: 'owner' } : { SHELL: '/bin/bash' }),
      ...options.env,
    },
    home,
    user: 'owner',
    uid: platform === 'win32' ? -1 : 501,
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    // Which system version this made-up machine runs: none, unless a test names the one it
    // stands in for. A build that is not there is not Windows 10 1809 or later, and a
    // console host with `--headless` is not written into a definition (see conhostPath).
    release: '',
    exec(file, args, execOptions = {}) {
      const call = { file, args, env: execOptions.env ?? {}, ...(execOptions.cwd === undefined ? {} : { cwd: execOptions.cwd }) };
      calls.push(call);
      return { code: 0, stdout: '', stderr: '', ...options.respond?.(call) };
    },
    launch(file, args, launchOptions = {}) {
      const call = { file, args, env: launchOptions.env ?? {} };
      launched.push(call);
      return options.refuseLaunch?.(call) ?? null;
    },
    ...options.system,
  };
  const cli: Cli = {
    system,
    appRoot: options.appRoot ?? stubApp(join(dir, 'app')),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    timing: { pollMs: 20, stopWaitMs: 5000, startWaitMs: 1000 },
  };
  return { cli, dir, home, dataDir, out, err, calls, launched, text: () => [...out, ...err].join('\n') };
}

export async function until(what: string, condition: () => boolean, waitMs = 10_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`没有等到：${what}`);
    await sleep(20);
  }
}

// Whether a service has finished announcing itself here. The file appears before its
// content does, so its existence alone says nothing yet.
export function announced(dataDir: string): boolean {
  try {
    return typeof (JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { pid?: unknown }).pid === 'number';
  } catch {
    return false;
  }
}

// A stub service on this data directory, up by the time this returns. `script` is where
// it runs from, which is what it says its program directory is: the copy inside a
// made-up release when a test needs a service of that installation.
export async function startStub(t: TestContext, dataDir: string, env: Record<string, string> = {}, script = STUB_SERVICE): Promise<ChildProcess> {
  mkdirSync(dataDir, { recursive: true });
  // Its output goes beside the data directory. It is what says the stand-in has announced
  // itself: service.json alone can be written, read by the command under test and removed
  // again (a candidate that fails its check is stopped at once) between two looks at it,
  // while what the stand-in wrote stays. It is also the evidence when one does not come up.
  const log = join(dataDir, '..', `stub-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
  const fd = openSync(log, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [script], { env: { ...process.env, TYCHO_DATA: dataDir, ...env }, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  ownProcess(t, () => endChild(child));
  const said = (): string => {
    try {
      return readFileSync(log, 'utf8');
    } catch {
      return '';
    }
  };
  try {
    await until('替身服务宣布自己起来了', () => said().includes('stub service announced'));
  } catch (err) {
    const state = child.exitCode === null && child.signalCode === null ? '还在运行' : `已退出（${child.signalCode ?? `退出码 ${child.exitCode}`}）`;
    throw new Error(`${(err as Error).message}；替身服务${state}，它的输出：${said() || '（什么都没写）'}`);
  }
  return child;
}

export const exited = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });

// A data directory another live process holds without having announced a service.
export function holdDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'lock'), JSON.stringify({ pid: process.pid }));
}

// The service entry of a release installed in a prefix.
export const installedStub = (prefix: string, version: string): string => join(prefix, 'versions', version, 'service', 'main.ts');

// Asked of the operating system: a ChildProcess learns of its exit an event-loop turn
// after a command that waited for the process has already returned.
export const alive = (child: ChildProcess): boolean => isAlive(child.pid!);
