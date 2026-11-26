// Guards the console's way in to a sign-in made on a machine (service/http.ts, service/sign-ins.ts)
// against: the routes answering without the owner's sign-in, or missing on the outside listener
// (the owner signs a machine in from a phone too); an answer whose shape the console cannot rely
// on; an unknown sign-in answered as anything but 404; a refusal answered as a server error; and
// the one-time code reaching the service log or the change log.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import type { Machine } from '../runner/snapshot.ts';
import { createSignIns } from '../service/sign-ins.ts';
import { createNodes } from '../service/nodes.ts';
import { NODE_HOLD_HEADER, NODE_PROTOCOL } from '../shared/node-protocol.ts';
import type { SignInView } from '../shared/sign-in.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, memoryMachines, NODES_TUNED, USER } from './helpers.ts';

const MACHINES: Record<string, Machine> = { m1: { id: 'm1', host: 'm1', nodeId: 'a1a1a1a1a1a1a1a1' } };
const URL = 'https://auth.openai.com/codex/device';
const CODE = 'WXYZ-98765';
const PUBLIC = 'https://tycho.example';

async function bench(t: TestContext) {
  const f = fixture(t);
  memoryMachines(MACHINES, f.ledger);
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };
  const signIns = createSignIns({
    ledger: f.ledger,
    nodes: {
      connected: (id) => id === 'm1',
      reportedExecutors: () => ({
        at: 'x',
        executors: [
          { executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: false },
          { executor: 'gemini', installed: true, version: 'agy 1.5.10', logged_in: null },
        ],
      }),
      send: (async (_machine: string, command: { kind: string; sign_in_id: string; executor?: string }) => (
        command.kind === 'sign_in_code'
          ? { id: command.sign_in_id, executor: 'gemini', state: 'exchanging' }
          : { id: command.sign_in_id, executor: command.executor ?? 'codex', state: 'starting' }
      )) as never,
    },
    executors: ADAPTERS,
    limitMs: () => 60_000,
    graceMs: () => 10_000,
    log,
    sweepMs: 3_600_000,
  });
  t.after(() => signIns.close());
  const app = await consoleApp(t, { f, signIns, log });
  return { f, app, signIns, lines };
}

test('三个接口：要主人登录；形状固定；不认识的编号 404；拒绝是 400', async (t) => {
  const { app, signIns } = await bench(t);
  // Without the owner's sign-in nothing answers.
  for (const [method, path] of [['POST', '/api/sign-ins'], ['GET', '/api/sign-ins/x'], ['POST', '/api/sign-ins/x/code'], ['POST', '/api/sign-ins/x/cancel']] as const) {
    const refused = await app.send(method, path, method === 'POST' ? {} : undefined, app.origin);
    assert.equal(refused.status, 401, `${method} ${path}`);
  }
  const started = await app.send('POST', '/api/sign-ins', { machine: 'm1', executor: 'codex' });
  assert.equal(started.status, 201);
  const view = ((await started.json()) as { sign_in: SignInView }).sign_in;
  assert.deepEqual(Object.keys(view).sort(), ['code', 'executor', 'id', 'machine', 'reason', 'signed_in', 'state', 'url']);
  assert.deepEqual({ ...view, id: 'x' }, { id: 'x', machine: 'm1', executor: 'codex', state: 'starting', url: null, code: null, reason: null, signed_in: false });

  signIns.reported('m1', [{ id: view.id, executor: 'codex', state: 'waiting', url: URL, code: CODE }]);
  const read = await app.get(`/api/sign-ins/${view.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(((await read.json()) as { sign_in: SignInView }).sign_in, { ...view, state: 'waiting', url: URL, code: CODE });

  const cancelled = await app.send('POST', `/api/sign-ins/${view.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(((await cancelled.json()) as { sign_in: SignInView }).sign_in.state, 'cancelled');

  assert.equal((await app.get('/api/sign-ins/nobody')).status, 404);
  assert.equal((await app.send('POST', '/api/sign-ins/nobody/code', { code: 'abc' })).status, 404);
  assert.equal((await app.send('POST', '/api/sign-ins/nobody/cancel')).status, 404);
  const refused = await app.send('POST', '/api/sign-ins', { machine: 'm1', executor: 'claude' });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /claude 不能从这里登录/);
  assert.equal((await app.send('POST', '/api/sign-ins', { machine: 'gone', executor: 'codex' })).status, 400);
});

test('接口在对外监听上也有：手机经门牌也能发起和查看', async (t) => {
  const { app } = await bench(t);
  app.settings.set('http.publicUrl', PUBLIC, USER);
  const port = await app.http.outside.listen(0);
  const credential = new globalThis.URL(await app.newLink(), app.url).hash.slice(1);
  assert.match(credential, /^[0-9a-f]{64}$/);
  const exchange = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST', headers: { Origin: PUBLIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential }), redirect: 'manual',
  });
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  const ask = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Cookie: cookie, Origin: PUBLIC, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const started = await ask('POST', '/api/sign-ins', { machine: 'm1', executor: 'codex' });
  assert.equal(started.status, 201);
  const id = ((await started.json()) as { sign_in: SignInView }).sign_in.id;
  assert.equal((await ask('GET', `/api/sign-ins/${id}`)).status, 200);
  assert.equal((await ask('POST', `/api/sign-ins/${id}/cancel`)).status, 200);
});

test('用户码不出现在服务日志和 change 里', async (t) => {
  const { f, app, signIns, lines } = await bench(t);
  const started = await app.send('POST', '/api/sign-ins', { machine: 'm1', executor: 'codex' });
  const id = ((await started.json()) as { sign_in: SignInView }).sign_in.id;
  signIns.reported('m1', [{ id, executor: 'codex', state: 'waiting', url: URL, code: CODE }]);
  assert.equal(((await (await app.get(`/api/sign-ins/${id}`)).json()) as { sign_in: SignInView }).sign_in.code, CODE);
  signIns.reported('m1', [{ id, executor: 'codex', state: 'done' }]);
  assert.ok(lines.length > 0, '日志记了发生了什么');
  assert.equal(lines.join('\n').includes(CODE), false, '服务日志里没有用户码');
  assert.equal(JSON.stringify(f.peek('SELECT * FROM change')).includes(CODE), false, 'change 里没有用户码');
});

// The poll carries a machine's sign-ins both ways, through the hub the service really has: what
// the machine says reaches the sign-ins, the answer names the ones the host still holds, and a
// machine with one under way is held for a moment only.
test('poll 两头都带着登录：上报推进状态、回答列出主机还记着的、登录进行中挂起时间变短', async (t) => {
  const f = fixture(t);
  const hub = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: (id) => (signIns.hurried(id) ? 50 : 2_000), commandTimeoutMs: () => 5_000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const request = hub.register({ node_id: 'a1b2c3d4e5f60718', name: 'm1', platform: 'test', hostname: 'm1' });
  const machine = hub.approve(request.code, USER)!;
  const claimed = hub.claim(request.secret);
  const token = claimed.state === 'approved' ? claimed.token : '';
  const lines: string[] = [];
  const signIns = createSignIns({ ledger: f.ledger, nodes: hub, executors: ADAPTERS, limitMs: () => 60_000, graceMs: () => 10_000, log: (line) => lines.push(line), sweepMs: 3_600_000 });
  t.after(() => signIns.close());
  hub.onSignIns(signIns.reported);
  const app = await consoleApp(t, { f, nodes: hub, signIns });
  const poll = async (body: Record<string, unknown>) => {
    const response = await fetch(`${app.url}/api/node/poll`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: NODE_PROTOCOL, cursor: null, runs: [], facts: { node_id: 'a1b2c3d4e5f60718', name: 'm1', platform: 'test', hostname: 'm1' }, ...body }),
    });
    return { hold: response.headers.get(NODE_HOLD_HEADER), body: (await response.json()) as { command: { id: string; kind: string; sign_in_id?: string } | null; sign_ins: string[] } };
  };
  const executors = { at: '2026-11-11T00:00:00.000Z', executors: [{ executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: false }] };
  // The machine is here and has said codex is installed.
  const first = poll({ executors });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = signIns.start(machine.id, 'codex');
  const handed = await first;
  assert.equal(handed.body.command?.kind, 'sign_in');
  assert.equal(handed.body.command?.sign_in_id, started.id);
  assert.deepEqual(handed.body.sign_ins, [started.id], '带着命令的那个回答里已经列着它');
  const second = await poll({ cursor: handed.body.command!.id, sign_ins: [{ id: started.id, executor: 'codex', state: 'waiting', url: URL, code: CODE }] });
  assert.equal(second.hold, '50', '登录进行中，挂起时间压短');
  assert.equal(signIns.get(started.id)?.code, CODE);
  const third = await poll({ sign_ins: [{ id: started.id, executor: 'codex', state: 'done' }] });
  assert.deepEqual(third.body.sign_ins, [], '主机见过终态，就不再列它');
  assert.equal(signIns.get(started.id)?.state, 'done');
  assert.equal(lines.join('\n').includes(CODE), false);
});

test('POST /api/sign-ins/:id/code 递交粘贴授权码并转入 exchanging，日志与审计不落密文', async (t) => {
  const { f, app, signIns, lines } = await bench(t);
  const started = await app.send('POST', '/api/sign-ins', { machine: 'm1', executor: 'gemini' });
  assert.equal(started.status, 201);
  const id = ((await started.json()) as { sign_in: SignInView }).sign_in.id;
  const googleUrl = 'https://accounts.google.com/o/oauth2/auth?client_id=123';
  signIns.reported('m1', [{ id, executor: 'gemini', state: 'waiting', url: googleUrl, accepts_code: true }]);

  const waiting = ((await (await app.get(`/api/sign-ins/${id}`)).json()) as { sign_in: SignInView }).sign_in;
  assert.equal(waiting.accepts_code, true);
  assert.equal(waiting.url, googleUrl);

  const pasted = 'https://antigravity.google/oauth-callback?code=4%2F0AeanS0SecretCallback_777&state=xyz';
  const submitted = await app.send('POST', `/api/sign-ins/${id}/code`, { code: pasted });
  assert.equal(submitted.status, 200);
  const after = ((await submitted.json()) as { sign_in: SignInView }).sign_in;
  assert.equal(after.state, 'exchanging');
  assert.equal(after.accepts_code, undefined);
  assert.equal(lines.join('\n').includes('SecretCallback_777'), false);
  assert.equal(JSON.stringify(f.peek('SELECT * FROM change')).includes('SecretCallback_777'), false);
});
