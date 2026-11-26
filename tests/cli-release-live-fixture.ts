// What the release-on-real-services tests share: a release of this repository unpacked into
// a version directory, installed by its own `install-self`, and a stand-in service manager
// that answers every start request with the real program `current` names.
//
// The failures guarded here are the ones every one of those files needs the same scene for:
// - a version is unpacked from a copy of this checkout, never from the checkout itself, so
//   a test may change the code a candidate ships without touching the working tree;
// - the service manager is the one thing stood in for: `serviceEnv` leaves no PATH, so
//   nothing of the developer's machine (a Claude Code, an ssh) is reached. Every start the
//   manager is asked for is a real service of the installed release, on its own port;
// - a command of the release runs in the test's own directories (it stops and starts
//   services, writes `current`, reads the ledger) for as long as it runs: a test that fails
//   before it awaits the command must not have those directories removed under it, nor let
//   it run on into the next test.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { after } from 'node:test';
import type { TestContext } from 'node:test';
import { ownerId } from '../cli/autostart.ts';
import { serviceSpec } from '../cli/install.ts';
import { runCli } from '../cli/main.ts';
import { consoleSession, serviceState } from '../cli/service-client.ts';
import type { ExecResult } from '../cli/system.ts';
import { openLedger } from '../service/ledger.ts';
import { peekLedger } from '../service/ledger-peek.ts';
import { hostProcesses } from '../service/processes.ts';
import { serviceSettings } from '../service/service-settings.ts';
import type { Call, RealService, Stage } from './cli-helpers.ts';
import { ownProcess, realApp, releaseRoot, stage, startRealService, until } from './cli-helpers.ts';
import { LOGIN, MACHINE, USER, holdMachine } from './helpers.ts';

export const NODE = process.execPath;
export const OLD = '1.0.0';
export const NEW = '1.1.0';

// This checkout as a release, prepared once for the whole file. Every test unpacks its own
// version out of it (`realApp` copies it, `install-self` moves that copy into place) and
// never writes into it, so one copy is enough for all of them; it is removed when the
// file ends. Register the shared directory's teardown before preparing the copy, so a
// failure during preparation also removes its temporary parent.
const cleanup: (() => Promise<void>)[] = [];
after(async () => {
  for (const run of cleanup) await run();
});
const fileTeardown = { after: (run: () => Promise<void>): void => { cleanup.push(run); } } as unknown as TestContext;
let sharedSource: string | undefined;
export function releaseSource(): string {
  if (sharedSource === undefined) {
    sharedSource = releaseRoot(fileTeardown);
  }
  return sharedSource;
}

// ---- A real release, installed the way the console's path installs it ----

export interface Live {
  t: TestContext;
  s: Stage;
  prefix: string;
  // The release of this repository every version is unpacked from.
  source: string;
  // Whether the last command started here has returned: from then on it asks nothing more
  // of the service manager.
  finished: boolean;
}

export function liveStage(t: TestContext, options: { healthWindowMs?: number; startWaitMs?: number; platform?: NodeJS.Platform; respond?: (call: Call) => Partial<ExecResult> | undefined } = {}): Live {
  // A service of these tests runs as this machine's own process, so a test that asks it
  // about this installation's launcher has to install for the platform it runs on.
  const s = stage(t, {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.respond === undefined ? {} : { respond: options.respond }),
  });
  // A real Node and a real service take longer than the stand-in the other CLI tests use.
  s.cli.timing = { pollMs: 20, stopWaitMs: 20_000, startWaitMs: options.startWaitMs ?? 20_000 };
  const prefix = join(s.dir, 'prefix');
  mkdirSync(s.dataDir, { recursive: true });
  if (options.healthWindowMs !== undefined) {
    const ledger = openLedger(join(s.dataDir, 'ledger.db'));
    try {
      serviceSettings({ ledger, dataDir: s.dataDir, log: () => {} }).set('release.healthWindowMs', options.healthWindowMs, USER);
    } finally {
      ledger.close();
    }
  }
  return { t, s, prefix, source: releaseSource(), finished: true };
}

// The version unpacked where the install scripts put it, then installed by its own
// `install-self`. `mutate` makes the candidate that must fail: different code in the
// package, which is how a bad release really arrives.
export function installVersion(live: Live, version: string, { automatic = true, mutate }: { automatic?: boolean; mutate?: (root: string) => void } = {}): Promise<number> {
  const { s, prefix, source } = live;
  s.cli.appRoot = realApp(join(prefix, 'versions', `.staging-${process.pid}-${version}`), version, { source, ...(mutate ? { mutate } : {}) });
  s.out.length = 0;
  s.err.length = 0;
  live.finished = false;
  const running = runCli(['install-self', '--prefix', prefix, '--node', NODE, ...(automatic ? ['--automatic'] : [])], s.cli).finally(() => {
    live.finished = true;
  });
  // The command works in this test's directories (it stops and starts services, writes
  // `current`, reads the ledger) for as long as it runs. A test that fails before it awaits
  // the command must not have those directories removed under it, or let it run on into
  // the next test: it ends with the test, as a process the test started does.
  ownProcess(live.t, async () => {
    await running.catch(() => {});
  });
  return running;
}

// An autostart this installation owns, written by some earlier version: what makes the
// service manager this installation's to stop and start.
export const ownUnit = (s: Stage, prefix: string): void => {
  const file = join(s.home, '.config', 'systemd', 'user', 'tycho.service');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `# tycho-autostart owner:${ownerId(serviceSpec(s.cli.system, join(prefix, 'versions', OLD)))}\nan older format\n`);
};

// The manager, as these tests run it: every request to start the service starts the real
// program `current` names.
export function manager(t: TestContext, live: Live) {
  const { s, prefix } = live;
  const asked = (verb: string): number => s.calls.filter(({ file, args }) => file === 'systemctl' && args.includes(verb)).length;
  const starts = (): number => asked('start') + asked('--now');
  const up: RealService[] = [];
  let served = 0;
  return {
    starts,
    stops: (): number => asked('stop'),
    // Waits for the manager to be asked, then serves that request: null when the program
    // `current` names does not come up at all. How long the command takes to get there is
    // its own (a candidate's health window, its stop, a scan of the process table, each
    // bounded by the command's timing), so what is waited for is the command: asked, or
    // returned without asking — which fails at once, with what it said. The deadline is
    // only a backstop for a command that hangs.
    async serve(what = '请服务管理器启动服务'): Promise<ChildProcess | null> {
      const { stopWaitMs, startWaitMs } = s.cli.timing;
      await until(what, () => starts() > served || live.finished, 4 * (stopWaitMs + startWaitMs));
      assert.ok(starts() > served, `没有等到：${what}，命令已经结束。命令的输出：\n${s.text()}`);
      served = starts();
      const service = await startRealService(t, prefix, s.dataDir);
      up.push(service);
      return service.port === null ? null : service.child;
    },
    // What the program served last wrote: the evidence when it did not come up.
    said: (): string => `服务的输出：${up.at(-1)?.said() || '（什么都没写）'}`,
    async stopAll(): Promise<void> {
      for (const service of up) service.child.kill();
    },
  };
}

// The version in use, started as the manager would start it, and up: where every release
// test begins. What it wrote is the answer when it is not.
export async function oldUp(t: TestContext, prefix: string, dataDir: string): Promise<void> {
  const service = await startRealService(t, prefix, dataDir);
  const { exitCode, signalCode } = service.child;
  const state = exitCode === null && signalCode === null ? '还在运行' : `已退出（${signalCode ?? `退出码 ${exitCode}`}）`;
  assert.notEqual(service.port, null, `旧版服务要起得来。它${state}，服务的输出：${service.said() || '（什么都没写）'}`);
}

export const currentOf = (prefix: string): string => readFileSync(join(prefix, 'current'), 'utf8').trim();

// What the installer has put in place: a staging directory belongs to the command that
// unpacked it, and is collected when that command finishes.
export const versionsIn = (prefix: string): string[] =>
  readdirSync(join(prefix, 'versions')).filter((name) => !name.startsWith('.')).sort();

// The schema the ledger records, or null when it records none.
export function ledgerVersion(dataDir: string): number | null {
  // Asked with and without a service running: as a reader that may meet its writer.
  const peek = peekLedger(join(dataDir, 'ledger.db'), 'live');
  assert.ok(peek.known, peek.known ? '' : peek.error);
  return peek.version;
}

// Whether this machine lets the marker scan run at all. It is the service's own scan, and
// a sandbox that refuses to start the process-table program refuses it here too.
export async function scanWorks(): Promise<boolean> {
  try {
    await hostProcesses.find('tycho-a-marker-nobody-has');
    return true;
  } catch {
    return false;
  }
}

// A project of the owner's, with a machine and a login of its own: what the tests that
// seed work start from. The rows are the ledger's, written as the console writes them.
export function seedProject(ledger: ReturnType<typeof openLedger>, name: string): string {
  ledger.setWhitelist({ console: ['console'] }, USER);
  holdMachine(ledger, MACHINE, USER);
  ledger.putMachineLogin(LOGIN.login, USER);
  return ledger.createProject({ name, loginMode: 'all' }, USER);
}

// ---- The ways a release is made bad ----

// The console's own build gone: the page is served, the file it names is not.
export const loseConsoleAssets = (root: string): void => {
  rmSync(join(root, 'console', 'dist', 'assets'), { recursive: true, force: true });
};

// A service that comes up and cannot read its ledger: what /api/release-check answers.
export const breakLedgerRead = (root: string): void => {
  const file = join(root, 'service', 'main.ts');
  const source = readFileSync(file, 'utf8');
  const patched = source.replace('ledger.listActiveRuns();', "throw new Error('database is locked');");
  assert.notEqual(patched, source, '要能在这一版的 service/main.ts 里找到那一次账本读取');
  writeFileSync(file, patched);
};

// A package that crashes on its way up: the data directory's lock taken, and the process
// gone before it has announced itself, without tidying — a bug in a start, or a kill. What
// it leaves is what the upgrade reads to know the candidate died rather than wait it out.
export const breakEntry = (root: string): void => {
  const file = join(root, 'service', 'main.ts');
  const source = readFileSync(file, 'utf8');
  const patched = source.replace('acquireLock(lock, log);', 'acquireLock(lock, log);\n  process.exit(1);');
  assert.notEqual(patched, source, '要能在这一版的 service/main.ts 里找到拿锁的那一行');
  writeFileSync(file, patched);
};

export const declareLedger = (ledger: number) => (root: string): void => {
  const manifest = join(root, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...(JSON.parse(readFileSync(manifest, 'utf8')) as object), tycho: { ledger, basis: '这一版不动账本' } }));
};

// A ledger from the version before this program, as an older release left it.
export function oldLedger(path: string, version: number): void {
  const conn = new DatabaseSync(path);
  try {
    conn.exec(readFileSync(join(import.meta.dirname, 'fixtures', 'ledger', `schema-v${version}.sql`), 'utf8'));
    conn.prepare(`INSERT INTO setting VALUES ('version', ?, 'schema_version', ?)`).run(new Date().toISOString(), String(version));
  } finally {
    conn.close();
  }
}

// A message through the service's own API, signed in the way a browser does.
export async function sayToService(dataDir: string, text: string, projectId: string): Promise<number> {
  for (let waited = 0; waited < 60_000; waited += 50) {
    const state = await serviceState(dataDir);
    if (state.state === 'running') {
      const session = await consoleSession(dataDir, state);
      assert.ok('cookie' in session, `要能登录：${'problem' in session ? session.problem : ''}`);
      const response = await fetch(`http://127.0.0.1:${state.port}/api/messages`, {
        method: 'POST',
        headers: { cookie: session.cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${state.port}` },
        body: JSON.stringify({ text, project_id: projectId }),
      });
      return response.status;
    }
    await sleep(50);
  }
  throw new Error('没有等到服务起来，插话没有送到');
}
