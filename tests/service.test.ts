// Guards against start-up timing that cannot say where a wait went: a phase that took the
// seconds is named both on its own line and in the summary, and every phase is in the summary.
// Guards against the service's own lifecycle breaking a floor: a second service on one
// data directory touching the first, a stale lock blocking a start for good, a start
// that fails halfway leaving a port, a lock or a process behind, a stop during which
// the Router keeps working, and a stop anyone can ask for. And against a service started
// on the second machine of a shared home (a cluster instance) taking the first machine's
// live lock for a stale one and writing the same ledger.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { openLedger } from '../service/ledger.ts';
import { startService } from '../service/main.ts';
import { hostProcesses, type Processes } from '../service/processes.ts';
import { createTools } from '../service/tools.ts';
import { memoryLogins, noAccept, freePort } from './helpers.ts';
import { pageProject } from './stage.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const STOP = join(import.meta.dirname, '..', 'service', 'stop.ts');
const CLAUDE = [process.execPath, FAKE];
const options = { timeout: 60_000 };

test('startup timing names the slow phase on its own line and in the summary', options, async (t) => {
  const { dataDir, running } = setup(t);
  // An old Router context the ledger still lists, and a process table that takes its time
  // answering for it: clearing it is the start-up wait this measures (§5.6).
  const ledger = openLedger(join(dataDir, 'ledger.db'));
  const OWNER = { actor: 'test' };
  const projectId = ledger.createProject({ name: '试跑', loginMode: 'all' }, OWNER);
  ledger.openContext({ projectId, segmentId: ledger.ensureSegment(projectId).id, marker: 'old-router', launch: {}, knowledge: [] });
  ledger.close();
  const processes: Processes = {
    // Every look at the table takes its time: whichever start-up step asks it, the phase it
    // belongs to is the one the summary has to name.
    find: async () => { await sleep(6000); return []; },
    kill: async () => { throw new Error('没有进程要结束'); },
  };
  const said: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  const service = await startService({ dataDir, port: 0, claude: CLAUDE, processes });
  running.push(service);
  const summary = said.find((line) => line.includes('启动用了'));
  assert.ok(summary !== undefined, `没有启动汇总行：\n${said.join('\n')}`);
  assert.match(summary, /清理旧负责人 [\d.]+ 秒（查询 1 次，匹配 0 个进程）/);
  assert.match(said.join('\n'), /启动阶段 清理旧负责人 用了 [\d.]+ 秒（查询 1 次，匹配 0 个进程）/);
});

type Service = Awaited<ReturnType<typeof startService>>;

function setup(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-service-'));
  const running: Service[] = [];
  const previous = { ...process.env };
  t.after(async () => {
    for (const service of running) await service.stop();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    rmSync(dataDir, { recursive: true, force: true });
  });
  const tools = createTools({
    ledger: undefined as never,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({}),
    machines: undefined as never,
    accept: noAccept,
  });
  Object.assign(process.env, {
    FAKE_CLAUDE_LOG: join(dataDir, 'fake.log'),
    FAKE_CLAUDE_TOOLS: JSON.stringify(tools.names.map((name) => `mcp__tycho__${name}`)),
  });
  const start = async (port = 0): Promise<Service> => {
    const service = await startService({ dataDir, port, claude: CLAUDE, dispatchIntervalMs: 50 });
    running.push(service);
    return service;
  };
  const lockFile = join(dataDir, 'lock');
  return { dataDir, lockFile, start, running };
}

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

const send = (service: Service, text: string): string =>
  service.ledger.receiveMessage({ channel: 'console', externalId: text, actor: 'console', text, projectId: pageProject(service) }).id;

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'close');
  return child.pid!;
}

async function stopScript(dataDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [STOP], { env: { ...process.env, TYCHO_DATA: dataDir } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

test('a second service on the same data directory leaves without touching the first', options, async (t) => {
  const { start, lockFile } = setup(t);
  const first = await start();
  const message = send(first, '先来一条');
  await until(() => first.ledger.getMessage(message).state === 'processed', '第一份处理消息');
  const session = first.ledger.currentContext(first.ledger.listProjects()[0]?.id ?? '')!;
  const lock = readFileSync(lockFile, 'utf8');

  const results = await Promise.allSettled([start(), start()]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(String(result.status === 'rejected' && result.reason), new RegExp(`另一份服务（${process.pid}）`));
  }

  assert.equal(readFileSync(lockFile, 'utf8'), lock);
  assert.deepEqual(await hostProcesses.find(session.marker), [first.session.status().pid]);
  const next = send(first, '第二条');
  await until(() => first.ledger.getMessage(next).state === 'processed', '第一份继续处理');
  assert.equal(first.ledger.currentContext(first.ledger.listProjects()[0]?.id ?? '')?.id, session.id);
});

test('a lock from another machine is left alone and the service does not start', options, async (t) => {
  const { dataDir, start, lockFile } = setup(t);
  // What the second machine of a shared home sees of the first machine's live service:
  // a pid that means nothing here, and a machine this one cannot look at.
  const body = JSON.stringify({ pid: await deadPid(), machine: 'another-machine', hostname: 'node-b', started_at: 'then' });
  writeFileSync(lockFile, body);
  await assert.rejects(start(), /another-machine/);
  assert.equal(readFileSync(lockFile, 'utf8'), body, '另一台机器的锁原样不动');
  assert.equal(existsSync(join(dataDir, 'ledger.db')), false, '不打开、也不建账本');
  assert.equal(existsSync(join(dataDir, 'service.json')), false, '不写实例身份');
});

test('a lock left by a dead process is taken over and released on stop', options, async (t) => {
  const { start, lockFile, running } = setup(t);
  writeFileSync(lockFile, JSON.stringify({ pid: await deadPid(), started_at: 'then' }));
  const service = await start();
  assert.equal((JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number }).pid, process.pid);
  await service.stop();
  running.length = 0;
  assert.equal(existsSync(lockFile), false);
});

test('a lock that says nothing is reported, not guessed at', options, async (t) => {
  const { start, lockFile } = setup(t);
  writeFileSync(lockFile, '');
  await assert.rejects(start(), /读不出 pid/);
  assert.equal(existsSync(lockFile), true);
});

test('a port in use fails the start and leaves nothing behind', options, async (t) => {
  const { start, lockFile, dataDir, running } = setup(t);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  await assert.rejects(start(port), new RegExp(`端口 ${port} 已被占用`));
  assert.equal(existsSync(lockFile), false);
  assert.equal(existsSync(join(dataDir, 'service.json')), false);
  // The ledger is closed and the directory free: a fresh start works.
  const service = await start();
  assert.equal(service.session.status().error, null);
  await service.stop();
  running.length = 0;
});

test('a Session Host that fails after HTTP is up gives the port back', options, async (t) => {
  const { start, lockFile, dataDir } = setup(t);
  writeFileSync(join(dataDir, 'router'), 'in the way');
  const port = await freePort();
  await assert.rejects(start(port), /EEXIST|ENOTDIR/);
  assert.equal(existsSync(lockFile), false);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
});

test('a step that fails during teardown does not stop the ones after it', options, async (t) => {
  const { start, lockFile, dataDir, running } = setup(t);
  const service = await start();
  const info = join(dataDir, 'service.json');
  rmSync(info);
  mkdirSync(info);
  assert.equal(await service.stop(), false);
  running.length = 0;
  assert.equal(existsSync(lockFile), false);
});

test('stop interrupts the Router at once and it takes no new message', options, async (t) => {
  const { start, running, dataDir } = setup(t);
  const service = await start();
  const { ledger, session } = service;
  const before = send(service, '先来一条');
  await until(() => ledger.getMessage(before).state === 'processed', '第一条');
  const held = send(service, '长回合');
  await until(() => readFileSync(join(dataDir, 'fake.log'), 'utf8').includes('"user":"长回合"'), '开始回合');
  const stopping = service.stop();
  // No await in between: this is what stop() has already done when it returns.
  assert.ok('refused' in session.admitTool(session.toolTokens()[0]));
  const later = send(service, '停止时来的');
  session.kick();
  await stopping;
  running.length = 0;
  assert.equal(session.status().alive, false);
  const reopened = openLedger(join(dataDir, 'ledger.db'));
  const states = [held, later].map((id) => reopened.getMessage(id).state);
  reopened.close();
  assert.deepEqual(states, ['unverified', 'received']);
});

test('npm run stop says so when nothing is running, or what ran is gone', options, async (t) => {
  // The same command as `tycho stop`, with its answers: nothing to stop is the state
  // that was asked for.
  const { dataDir } = setup(t);
  const missing = await stopScript(dataDir);
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stdout, /服务没有在运行/);

  const closed = createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const { port } = closed.address() as AddressInfo;
  closed.close();
  await once(closed, 'close');
  writeFileSync(join(dataDir, 'service.json'), JSON.stringify({ pid: 1, port, token: 'x' }));
  const stale = await stopScript(dataDir);
  assert.equal(stale.code, 0, stale.stderr);
  assert.match(stale.stdout, /没有在运行（上次没有正常退出/);
});

test('/api/shutdown needs the token in service.json and then stops the service', options, async (t) => {
  const { start, dataDir, running, lockFile } = setup(t);
  const service = await start();
  const info = JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { pid: number; port: number; token: string };
  assert.deepEqual([info.pid, info.port], [process.pid, service.port]);
  const url = `http://127.0.0.1:${service.port}/api/shutdown`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(service.session.status().error, null, '没停，负责人也没停摆');

  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` } });
  assert.equal(response.status, 202);
  assert.equal(await service.stopped, true);
  running.length = 0;
  assert.equal(existsSync(lockFile), false);
  assert.equal(existsSync(join(dataDir, 'service.json')), false);
});

// A service that went without a word could not be told from a crash afterwards (2026-11-08).
test('a stop says in the log who asked for it: the local stop request, or the signal', options, async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: unknown) => void lines.push(String(line)));
  const { start, dataDir, running } = setup(t);
  const service = await start();
  const { token } = JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { token: string };
  await fetch(`http://127.0.0.1:${service.port}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(await service.stopped, true);
  running.length = 0;
  assert.ok(lines.some((line) => line.includes('服务正在停止：收到本机的停止请求')), lines.join(' | '));

  const request = new AbortController();
  const signalled = await startService({ dataDir, port: 0, claude: CLAUDE, stopSignal: request.signal });
  running.push(signalled);
  request.abort('收到信号 SIGINT');
  assert.equal(await signalled.stopped, true);
  running.length = 0;
  assert.ok(lines.some((line) => line.includes('服务正在停止：收到信号 SIGINT')), lines.join(' | '));
});

test('service.json and /api/instance say which program is running, the route to the token only', options, async (t) => {
  const { start, dataDir } = setup(t);
  const service = await start();
  const info = JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as Record<string, unknown>;
  const repo = realpathSync.native(join(import.meta.dirname, '..'));
  const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };
  assert.deepEqual([info.pid, info.version, info.program_dir], [process.pid, version, repo]);
  assert.ok(Date.parse(info.started_at as string) <= Date.now());

  const url = `http://127.0.0.1:${service.port}/api/instance`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const answer = await fetch(url, { headers: { Authorization: `Bearer ${info.token as string}` } });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), {
    pid: process.pid, version, program_dir: repo, started_at: info.started_at, port: service.port, host: '127.0.0.1', data_dir: dataDir,
  });
});

test('/api/doctor answers the token in service.json as it answers a signed-in browser', options, async (t) => {
  const { start, dataDir } = setup(t);
  const service = await start();
  const { token } = JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { token: string };
  const url = `http://127.0.0.1:${service.port}/api/doctor`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const answer = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(answer.status, 200);
  const { checks } = (await answer.json()) as { checks: { id: string }[] };
  assert.ok(checks.some(({ id }) => id === 'router'), '运行中才有的事实由服务自己回答');
});

test('a stop asked for while the service is still starting ends the start cleanly', options, async (t) => {
  const { dataDir, lockFile, running } = setup(t);
  const request = new AbortController();
  const starting = startService({ dataDir, port: 0, claude: CLAUDE, stopSignal: request.signal });
  // The lock is taken and the ledger open; the port is not.
  assert.equal(existsSync(lockFile), true);
  request.abort();
  const service = await starting;
  // Stopped after the test whatever it did with the request.
  running.push(service);
  assert.equal(await Promise.race([service.stopped, sleep(10_000).then(() => 'still running')]), true);
  assert.equal(existsSync(lockFile), false);
  assert.equal(existsSync(join(dataDir, 'service.json')), false);
});
