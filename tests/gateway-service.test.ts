// Guards against the gateway's pieces not holding together in a running service: a
// phone that comes in through the gateway not being able to sign in, send a message and
// see the reply; the same listener letting it stop the service; the state and the
// self-check saying something other than what the connection is doing; a setting changed
// in the console waiting for a restart, or leaving the old listener or the old ssh
// behind; a service with no gateway set listening for one all the same; the port of this
// run, or service.json, taking the gateway's listener for the service's own; a stop
// leaving an ssh running; an ssh left by a service that never stopped surviving the next
// start; and a listener that cannot come up taking the service down with it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loginTokenFile, serviceFile } from '../service/config.ts';
import type { DoctorCheck } from '../service/doctor.ts';
import type { GatewayStatus } from '../service/gateway.ts';
import { gatewayMarker, sshArgs } from '../service/gateway.ts';
// Whether an ssh of this test is still there is asked of the process table by its marker,
// the way the service itself asks: a pid is handed out again as soon as its process is gone
// (on Windows within seconds under a busy test suite), so "is this pid alive" answers for
// whatever process has it now.
import { hostProcesses } from '../service/processes.ts';
import type { Service } from './stage.ts';
import { signIn, stage, until } from './stage.ts';
import { freePort } from './helpers.ts';

const FAKE_SSH = join(import.meta.dirname, 'fake-ssh.mjs');
const SSH = [process.execPath, FAKE_SSH];
const PUBLIC = 'https://tycho.example';
const DOOR = 'deploy@door.example';
const USER = { actor: 'test' };
const options = { timeout: 120_000 };

function listenOn(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Whether anything answers there. A listener that is closed refuses at once.
const answers = (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/login`).then((response) => response.status === 200, () => false);

function setup(t: TestContext, plan?: string[]) {
  const s = stage(t);
  const log = join(s.dataDir, 'ssh.log');
  const planFile = join(s.dataDir, 'ssh-plan.json');
  if (plan) writeFileSync(planFile, JSON.stringify(plan));
  // The stage puts the environment back as it found it.
  Object.assign(process.env, { FAKE_SSH_LOG: log, FAKE_SSH_PLAN: planFile });
  const starts = (): { pid: number; argv: string[] }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { pid: number; argv: string[] }) : [];
  const forwards = (): string[] => starts().map(({ argv }) => argv[argv.indexOf('-R') + 1]!);
  return { ...s, starts, forwards, plan: (next: string[]) => writeFileSync(planFile, JSON.stringify(next)) };
}

const state = (service: Service): GatewayStatus => service.gateway.status();
const connected = (service: Service): Promise<unknown> => until(() => state(service).state === 'connected', '门牌连上');

test('through the gateway: sign in with a link, send a message, see the reply arrive; and the same listener stops nothing', options, async (t) => {
  const s = setup(t);
  const localPort = await freePort();
  const service = await s.start({ ssh: SSH }, { settings: { 'gateway.ssh': DOOR, 'gateway.localPort': localPort, 'http.publicUrl': PUBLIC } });
  await connected(service);
  assert.deepEqual(s.forwards(), [`127.0.0.1:18787:127.0.0.1:${localPort}`], 'ssh 把门牌的端口转到对外入口');
  const out = `http://127.0.0.1:${localPort}`;
  // What the gateway's reverse proxy adds to what a phone sends.
  const phone = { Origin: PUBLIC, 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' };

  // The link as WeCom or the command hands it out: on the public address.
  const local = JSON.parse(readFileSync(serviceFile(s.dataDir), 'utf8')) as { port: number; token: string };
  const made = await fetch(`http://127.0.0.1:${local.port}/api/login-links`, {
    method: 'POST', headers: { Authorization: `Bearer ${readFileSync(loginTokenFile(s.dataDir), 'utf8')}` },
  });
  const { path, url } = (await made.json()) as { path: string; url: string };
  assert.equal(url, `${PUBLIC}${path}`);

  assert.equal((await fetch(`${out}/`, { redirect: 'manual' })).status, 302);
  assert.match(path, /^\/login#[0-9a-f]{64}$/);
  assert.match(await (await fetch(`${out}/login`, { headers: phone })).text(), /method="post" action="\/login"/);
  const login = await fetch(`${out}/login`, { method: 'POST',
    headers: { ...phone, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: new URL(path, out).hash.slice(1) }), redirect: 'manual' });
  assert.equal(login.status, 303);
  assert.match(login.headers.get('set-cookie')!, /; Secure;/);
  const browser = { ...phone, Cookie: login.headers.get('set-cookie')!.split(';')[0]! };
  assert.equal((await fetch(`${out}/`, { headers: browser })).status, 200);

  const abort = new AbortController();
  const stream = await fetch(`${out}/api/stream`, { headers: browser, signal: abort.signal });
  assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  // Said on a project's page, as the console does.
  const projectId = service.ledger.createProject({ name: '试跑' }, { actor: 'test' });
  const sent = await fetch(`${out}/api/messages`, { method: 'POST', headers: browser, body: JSON.stringify({ text: '你好', project_id: projectId }) });
  assert.equal(sent.status, 201);
  while (!seen.includes('回复：你好')) {
    const { value, done } = await reader.read();
    assert.equal(done, false, `流在回复到达之前就断了：${seen}`);
    seen += decoder.decode(value, { stream: true });
  }
  abort.abort();

  // What the pages are told about the gateway, and what the self-check makes of it.
  const { gateway } = (await (await fetch(`${out}/api/state`, { headers: browser })).json()) as { gateway: GatewayStatus };
  assert.deepEqual([gateway.state, gateway.error], ['connected', null]);
  assert.ok(Date.parse(gateway.since!) <= Date.now());
  const { checks } = (await (await fetch(`${out}/api/doctor`, { headers: browser })).json()) as { checks: DoctorCheck[] };
  const check = (id: string): DoctorCheck => checks.find((each) => each.id === id)!;
  assert.deepEqual([check('gateway').level, check('gateway').text], ['ok', `已连接 ${DOOR}`]);
  assert.deepEqual([check('gateway-url').level, check('gateway-url').text], ['ok', PUBLIC]);

  // The token this machine's commands use is worth nothing out there.
  const bearer = { Authorization: `Bearer ${local.token}` };
  assert.equal((await fetch(`${out}/api/shutdown`, { method: 'POST', headers: bearer })).status, 401);
  assert.equal((await fetch(`${out}/api/shutdown`, { method: 'POST', headers: { ...browser, ...bearer } })).status, 404);
  assert.equal((await fetch(`${out}/api/doctor`, { headers: bearer })).status, 401);
  // On the inside listener the same token is the command's, and says where the service
  // really listens: the gateway's listener is not it.
  const instance = (await (await fetch(`http://127.0.0.1:${local.port}/api/instance`, { headers: bearer })).json()) as { port: number };
  assert.deepEqual([local.port, instance.port], [service.port, service.port]);
  assert.notEqual(service.port, localPort);
  assert.equal(state(service).state, 'connected', '服务还在');
});

test('with no gateway set: no listener for one, no ssh, and the state says it is off', options, async (t) => {
  const s = setup(t);
  const localPort = await freePort();
  const service = await s.start({ ssh: SSH }, { settings: { 'gateway.localPort': localPort, 'http.publicUrl': PUBLIC } });
  const inside = await signIn(service);
  const { gateway } = (await (await inside.get('/api/state')).json()) as { gateway: GatewayStatus };
  assert.deepEqual(gateway, { state: 'off', since: null, error: null });
  assert.equal(await answers(localPort), false, '没启用就不监听对外端口');
  assert.deepEqual(s.starts(), []);
  assert.equal(existsSync(join(s.dataDir, 'gateway.pid')), false);
  const { checks } = (await (await inside.get('/api/doctor')).json()) as { checks: DoctorCheck[] };
  assert.deepEqual(checks.filter(({ id }) => id.startsWith('gateway')).map(({ id, level }) => [id, level]), [['gateway', 'ok']]);
});

test('the settings take effect as they are saved: on, another port, off, with nothing of the old left', options, async (t) => {
  const s = setup(t);
  const [first, second] = [await freePort(), await freePort()];
  const service = await s.start({ ssh: SSH }, { settings: { 'gateway.localPort': first, 'http.publicUrl': PUBLIC } });
  assert.equal(await answers(first), false);

  service.settings.set('gateway.ssh', DOOR, USER);
  await connected(service);
  assert.equal(await answers(first), true, '填上门牌机器就启用');
  assert.deepEqual(s.forwards(), [`127.0.0.1:18787:127.0.0.1:${first}`]);

  service.settings.set('gateway.localPort', second, USER);
  await until(() => s.starts().length === 2, '按新端口重连');
  await connected(service);
  assert.equal(await answers(second), true);
  assert.equal(await answers(first), false, '旧的对外端口不再监听');
  assert.deepEqual(await hostProcesses.find(gatewayMarker(s.dataDir)), [s.starts()[1]!.pid], '旧的 ssh 不留，只有新的在');
  assert.equal(s.forwards()[1], `127.0.0.1:18787:127.0.0.1:${second}`);

  service.settings.set('gateway.remotePort', 19000, USER);
  await until(() => s.forwards()[2] === `127.0.0.1:19000:127.0.0.1:${second}`, '按新的门牌端口重连');
  await connected(service);

  const key = join(s.dataDir, 'door key');
  writeFileSync(key, 'not a real key');
  service.settings.set('gateway.keyFile', key, USER);
  await until(() => s.starts().length === 4, '按新的密钥重连');
  assert.deepEqual(s.starts()[3]!.argv, sshArgs({ ssh: DOOR, keyFile: key, remotePort: 19000, localPort: second }, gatewayMarker(s.dataDir)));
  await connected(service);

  service.settings.set('gateway.ssh', '', USER);
  await until(() => state(service).state === 'off', '停用');
  assert.equal(await answers(second), false, '停用后不再监听');
  assert.deepEqual(await hostProcesses.find(gatewayMarker(s.dataDir)), [], '停用后没有带这个数据目录标记的 ssh 留下');

  assert.throws(() => service.settings.set('gateway.ssh', '-oProxyCommand=calc@door', USER), /用户名@地址/);
  assert.equal(service.settings.get('gateway.ssh'), '');
});

test('a connection that cannot be made is told as it is, and the service goes on', options, async (t) => {
  const s = setup(t, ['refused']);
  const localPort = await freePort();
  const service = await s.start({ ssh: SSH }, { settings: { 'gateway.ssh': DOOR, 'gateway.localPort': localPort, 'http.publicUrl': 'http://tycho.example' } });
  await until(() => state(service).state === 'down', '报出连不上');
  const inside = await signIn(service);
  const { gateway } = (await (await inside.get('/api/state')).json()) as { gateway: GatewayStatus };
  assert.equal(gateway.error, 'ssh: connect to host door.example port 22: Connection refused');
  const { checks } = (await (await inside.get('/api/doctor')).json()) as { checks: DoctorCheck[] };
  const check = (id: string): DoctorCheck => checks.find((each) => each.id === id)!;
  assert.equal(check('gateway').level, 'fail');
  assert.match(check('gateway').text, /连不上 deploy@door\.example，会一直重试：ssh: connect to host door\.example port 22: Connection refused/);
  assert.equal(check('gateway').fix?.href, '#/settings/gateway.ssh');
  assert.equal(check('gateway-url').level, 'fail');
  assert.match(check('gateway-url').text, /不是 https/);
  // It comes up by itself once the gateway answers.
  s.plan(['up']);
  await connected(service);
  assert.equal((await inside.post('/api/messages', { text: '照常' })).status, 201);
});

test('a listener port that is taken is the gateway\'s problem, not the service\'s, and clears when the port does', options, async (t) => {
  const s = setup(t);
  const blocker = await listenOn(0);
  const localPort = (blocker.address() as AddressInfo).port;
  try {
    const service = await s.start({ ssh: SSH }, { settings: { 'gateway.ssh': DOOR, 'gateway.localPort': localPort, 'http.publicUrl': PUBLIC } });
    await until(() => state(service).state === 'down', '报出端口被占');
    assert.match(state(service).error!, new RegExp(`对外入口的端口 ${localPort} 被别的程序占着`));
    assert.deepEqual(s.starts(), [], '入口没起来就不连门牌');
    const inside = await signIn(service);
    assert.equal((await inside.get('/api/state')).status, 200);
    await new Promise((resolve) => blocker.close(resolve));
    await connected(service);
    assert.equal(await answers(localPort), true);
  } finally {
    blocker.close();
  }
});

test('the gateway\'s listener is never put on the service\'s own port, where this machine\'s requests would land on it', options, async (t) => {
  const s = setup(t);
  const port = await freePort();
  // Listening on every interface: Windows would let 127.0.0.1 be bound beside it.
  const service = await s.start({ ssh: SSH, port }, { settings: { 'gateway.ssh': DOOR, 'gateway.localPort': port, 'http.publicUrl': PUBLIC, 'http.host': '0.0.0.0' } });
  await until(() => state(service).state === 'down', '报出端口相同');
  assert.match(state(service).error!, new RegExp(`对外入口的端口不能和服务自己的端口（${port}）相同`));
  assert.deepEqual(s.starts(), []);
  // The loopback still reaches the inside listener and its machine-only routes.
  const { token } = JSON.parse(readFileSync(serviceFile(s.dataDir), 'utf8')) as { token: string };
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/instance`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

test('the port given for this run is the inside listener\'s alone', options, async (t) => {
  const s = setup(t);
  const [inside, localPort] = [await freePort(), await freePort()];
  const service = await s.start({ ssh: SSH, port: inside }, { settings: { 'gateway.ssh': DOOR, 'gateway.localPort': localPort, 'http.publicUrl': PUBLIC } });
  await connected(service);
  assert.equal(service.port, inside);
  assert.equal((JSON.parse(readFileSync(serviceFile(s.dataDir), 'utf8')) as { port: number }).port, inside);
  assert.deepEqual(s.forwards(), [`127.0.0.1:18787:127.0.0.1:${localPort}`]);
  assert.equal(await answers(localPort), true);
});

test('a stop leaves no ssh; one left by a service that never stopped is ended by the next start, found by its marker', options, async (t) => {
  const s = setup(t);
  const localPort = await freePort();
  const settings = { 'gateway.ssh': DOOR, 'gateway.localPort': localPort, 'http.publicUrl': PUBLIC };
  const first = await s.start({ ssh: SSH }, { settings });
  await connected(first);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, 'gateway.pid'), 'utf8')), { state: 'starting', marker: gatewayMarker(s.dataDir) });
  await s.stop(first);
  assert.deepEqual(await hostProcesses.find(gatewayMarker(s.dataDir)), [], '停服后不留 ssh');
  assert.equal(existsSync(join(s.dataDir, 'gateway.pid')), false);
  assert.equal(await answers(localPort), false);

  // What a killed service leaves: its ssh still running, and the record of it.
  const left = spawn(process.execPath, [FAKE_SSH, ...sshArgs({ ssh: DOOR, keyFile: '', remotePort: 18787, localPort }, gatewayMarker(s.dataDir))!], { stdio: 'ignore', windowsHide: true });
  // Another data directory's, which is not this service's to touch.
  const foreign = spawn(process.execPath, [FAKE_SSH, ...sshArgs({ ssh: DOOR, keyFile: '', remotePort: 18787, localPort }, 'TYCHO_GATEWAY_ffffffffffffffff')!], { stdio: 'ignore', windowsHide: true });
  try {
    await until(() => s.starts().length === 3, '两个留下的 ssh 起来');
    writeFileSync(join(s.dataDir, 'gateway.pid'), `${left.pid}\n`);
    // The real search of the process table, as the service runs it.
    const second = await s.start({ ssh: SSH });
    await connected(second);
    assert.deepEqual(await hostProcesses.find(gatewayMarker(s.dataDir)), [s.starts()[3]!.pid], '上次留下的被清掉，只有这一次的在');
    assert.deepEqual(await hostProcesses.find('TYCHO_GATEWAY_ffffffffffffffff'), [foreign.pid], '别的数据目录的不动');
    assert.equal(s.starts().length, 4);
    assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, 'gateway.pid'), 'utf8')), { state: 'starting', marker: gatewayMarker(s.dataDir) });
  } finally {
    left.kill();
    foreign.kill();
  }
});
