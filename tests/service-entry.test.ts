// Guards against the service's own entry point (what `tycho run` and `npm start` execute)
// mishandling what reaches it from outside: a signal during the start killing the process
// with the lock and the ledger left as they were; a terminal closing (SIGHUP) counted as
// a crash; a port named for one run being ignored or written into the settings; a port
// already taken reported without the way out; TYCHO_PORT=0 refused, or service.json
// naming 0 (or the port asked for) instead of the one the system picked; and the hint
// after a start naming a command the owner does not have.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openLedger } from '../service/ledger.ts';
import { freePort } from './helpers.ts';
import { isAlive } from '../service/lock.ts';

const MAIN = join(import.meta.dirname, '..', 'service', 'main.ts');
const STOP = join(import.meta.dirname, '..', 'service', 'stop.ts');
const options = { timeout: 60_000 };
const NO_SIGNALS = process.platform === 'win32' && 'Windows 没有可以发给另一个进程的终止信号';

interface Entry {
  child: ChildProcess;
  dataDir: string;
  seen: { err: string };
  exit: Promise<number | null>;
}

// The real entry on an empty data directory, with no Claude Code to be found: the Router
// stays down and the service runs all the same.
function entry(t: TestContext, env: Record<string, string> = {}): Entry {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'tycho-entry-')), 'data');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
  const child = spawn(process.execPath, [MAIN], {
    // LOCALAPPDATA too: the desktop app's Claude Code is found there, and this test has no
    // business starting the one on the machine.
    env: { ...inherited, PATH: dirname(process.execPath), LOCALAPPDATA: dataDir, TYCHO_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const seen = { err: '' };
  child.stderr!.on('data', (chunk: Buffer) => (seen.err += chunk.toString('utf8')));
  const exit = once(child, 'exit').then(([code]) => code as number | null);
  t.after(async () => {
    child.kill('SIGKILL');
    await exit;
    rmSync(dirname(dataDir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { child, dataDir, seen, exit };
}

async function until(what: () => string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`没有等到：${what()}`);
    await sleep(20);
  }
}

interface Announced {
  port: number;
  token: string;
}

async function announced({ dataDir, seen }: Entry): Promise<Announced> {
  const file = join(dataDir, 'service.json');
  let info: Announced | undefined;
  await until(() => `服务登记（${seen.err}）`, () => {
    try {
      info = JSON.parse(readFileSync(file, 'utf8')) as Announced;
      return true;
    } catch {
      return false;
    }
  });
  return info!;
}

const shutdown = ({ port, token }: Announced): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

// The entry up on a port the system picked for it: only the process that binds can know a
// port is free, and other test files take ports beside this one.
async function up(t: TestContext, env: Record<string, string> = {}): Promise<{ started: Entry; info: Announced }> {
  const started = entry(t, { ...env, TYCHO_PORT: '0' });
  const info = await Promise.race([announced(started), started.exit.then(() => null)]);
  if (info === null) throw new Error(`服务没有起来：${started.seen.err}`);
  return { started, info };
}

test('TYCHO_PORT=0: the system picks the port, service.json names the one taken, and it answers', options, async (t) => {
  const { started, info } = await up(t);
  assert.ok(Number.isInteger(info.port) && info.port > 0, `service.json 写的是实际端口，不是 0：${info.port}`);
  assert.equal((await fetch(`http://127.0.0.1:${info.port}/login`)).status, 200, '写下的端口上就是这个服务');
  assert.equal((await shutdown(info)).status, 202);
  assert.equal(await started.exit, 0, started.seen.err);
  const ledger = openLedger(join(started.dataDir, 'ledger.db'), { readOnly: true });
  const stored = ledger.getTunables();
  ledger.close();
  assert.deepEqual(stored, {}, '0 也不进设置');
});

test('a port named for this run is the one listened on, and the settings keep theirs', options, async (t) => {
  // A named port has to be found free first, and another process can take it before the
  // service binds it: what is tested is the port the service was named, so that one run
  // is tried again on another port.
  let named: { started: Entry; info: Announced; port: number } | undefined;
  for (let attempt = 0; named === undefined; attempt += 1) {
    const port = await freePort();
    const started = entry(t, { TYCHO_PORT: String(port) });
    const info = await Promise.race([announced(started), started.exit.then(() => null)]);
    if (info !== null) named = { started, info, port };
    else if (attempt >= 4 || !/已被占用/.test(started.seen.err)) throw new Error(`服务没有起来：${started.seen.err}`);
  }
  const { started, info, port } = named;
  assert.equal(info.port, port);
  assert.equal((await shutdown(info)).status, 202);
  assert.equal(await started.exit, 0, started.seen.err);
  const ledger = openLedger(join(started.dataDir, 'ledger.db'), { readOnly: true });
  const stored = ledger.getTunables();
  ledger.close();
  assert.deepEqual(stored, {}, '这一次的端口不进设置');
});

test('a port for this run that is not a port fails the start and says so', options, async (t) => {
  const started = entry(t, { TYCHO_PORT: 'eighty' });
  assert.equal(await started.exit, 1);
  assert.match(started.seen.err, /TYCHO_PORT/);
  assert.equal(existsSync(join(started.dataDir, 'lock')), false);
});

test('a port already taken fails the start with the command that runs on another one', options, async (t) => {
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => taken.close());
  const { port } = taken.address() as AddressInfo;

  const installed = entry(t, { TYCHO_PORT: String(port), TYCHO_STARTED_BY: 'tycho' });
  assert.equal(await installed.exit, 1);
  assert.match(installed.seen.err, new RegExp(`端口 ${port} 已被占用`));
  assert.match(installed.seen.err, /tycho run --port <端口>/);
  assert.equal(existsSync(join(installed.dataDir, 'lock')), false);

  const checkout = entry(t, { TYCHO_PORT: String(port) });
  assert.equal(await checkout.exit, 1);
  assert.match(checkout.seen.err, /TYCHO_PORT=<端口> npm start/);
});

test('the hint after a start names the command this way of starting has', options, async (t) => {
  const { started: installed, info } = await up(t, { TYCHO_STARTED_BY: 'tycho' });
  await until(() => '启动后的提示', () => /打开控制台|登录链接/.test(installed.seen.err));
  assert.match(installed.seen.err, /tycho open/);
  assert.doesNotMatch(installed.seen.err, /npm run/);
  await shutdown(info);
  assert.equal(await installed.exit, 0, installed.seen.err);

  const { started: checkout, info: other } = await up(t);
  await until(() => '启动后的提示', () => /打开控制台|登录链接/.test(checkout.seen.err));
  assert.match(checkout.seen.err, /npm run login-link/);
  assert.doesNotMatch(checkout.seen.err, /tycho open/);
  await shutdown(other);
  assert.equal(await checkout.exit, 0, checkout.seen.err);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`${signal} to a running service is a clean stop: exit code 0, nothing left behind`, { ...options, skip: NO_SIGNALS }, async (t) => {
    const { started } = await up(t);
    started.child.kill(signal);
    assert.equal(await started.exit, 0, started.seen.err);
    assert.equal(existsSync(join(started.dataDir, 'lock')), false);
    assert.equal(existsSync(join(started.dataDir, 'service.json')), false);
  });

  test(`${signal} while the service is still starting ends the start cleanly`, { ...options, skip: NO_SIGNALS }, async (t) => {
    const started = entry(t, { TYCHO_PORT: '0' });
    // The lock is the first thing a start takes; the handlers are in place before it.
    await until(() => '启动开始', () => existsSync(join(started.dataDir, 'lock')) || started.child.exitCode !== null);
    started.child.kill(signal);
    assert.equal(await started.exit, 0, started.seen.err);
    assert.equal(existsSync(join(started.dataDir, 'lock')), false);
  });
}

test('npm run stop reaches the running service through service.json, and comes back once it is gone', options, async (t) => {
  const { started } = await up(t);
  const stopped = spawnSync(process.execPath, [STOP], { env: { ...process.env, TYCHO_DATA: started.dataDir }, encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /服务已停止/);
  // Already gone when the command returned, not merely asked to go. Asked of the
  // operating system: this process has not been told of the exit yet.
  assert.equal(isAlive(started.child.pid!), false);
  assert.equal(await started.exit, 0);
  assert.equal(existsSync(join(started.dataDir, 'lock')), false);
});
