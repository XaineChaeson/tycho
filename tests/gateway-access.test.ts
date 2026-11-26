// Guards against an outside owner losing console management capabilities, settings gaining
// listener-specific permission metadata, and raw HTTP spellings reaching token-only routes.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { consoleApp, LOGIN_TOKEN, SHUTDOWN_TOKEN, TOOL_TOKEN } from './console-helpers.ts';
import { holdMachine, testMachine } from './helpers.ts';

const PUBLIC = 'https://tycho.example';
const MANAGEMENT_SETTINGS = [
  'gateway.ssh', 'gateway.keyFile', 'gateway.remotePort', 'gateway.localPort',
  'http.host', 'http.port', 'http.publicUrl', 'router.cli', 'router.account',
  'router.tier', 'backup.dir', 'wecom.url', 'wecom.owner',
];

async function setup(t: TestContext) {
  const app = await consoleApp(t);
  app.settings.set('http.publicUrl', PUBLIC, { actor: 'console' });
  const port = await app.http.outside.listen(0);
  const url = 'http://127.0.0.1:' + port;
  const credential = new URL(await app.newLink(), app.url).hash.slice(1);
  assert.match(credential, /^[0-9a-f]{64}$/);
  const login = await fetch(url + '/login', { method: 'POST',
    headers: { Origin: PUBLIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential }), redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const headers = { Cookie: cookie, Origin: PUBLIC };
  const ask = (method: string, path: string, body?: unknown) => fetch(url + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
  });
  return { app, port, cookie, ask };
}

test('the outside owner can write and reset every host management setting', async (t) => {
  const { app, port, cookie, ask } = await setup(t);
  const file = join(app.f.dir, 'test-program-and-key');
  writeFileSync(file, 'test only');
  const backup = join(app.f.dir, 'backup-disk');
  mkdirSync(backup);
  const values: Record<string, string | number> = {
    'gateway.ssh': 'deploy@door.example', 'gateway.keyFile': file,
    'gateway.remotePort': 18081, 'gateway.localPort': 18082,
    'http.host': '0.0.0.0', 'http.port': 18083, 'http.publicUrl': PUBLIC,
    'router.cli': file, 'router.account': app.accounts.list()[0]!.id, 'router.tier': 'decide',
    'backup.dir': backup,
    'wecom.url': 'wss://wecom.example/channel', 'wecom.owner': 'mobile-owner',
  };
  for (const key of MANAGEMENT_SETTINGS) {
    assert.equal((await ask('PUT', '/api/settings/' + key, { value: values[key] })).status, 200, key);
    assert.equal(app.settings.list().find((entry) => entry.key === key)!.value, values[key], key);
  }
  // Changing the public address also changes the next write's accepted origin.
  const replacement = 'https://changed.example';
  assert.equal((await ask('PUT', '/api/settings/http.publicUrl', { value: replacement })).status, 200);
  const order = [...MANAGEMENT_SETTINGS.filter((key) => key !== 'http.publicUrl'), 'http.publicUrl'];
  for (const key of order) {
    const response = await fetch('http://127.0.0.1:' + port + '/api/settings/' + key, {
      method: 'DELETE', headers: { Cookie: cookie, Origin: replacement },
    });
    assert.equal(response.status, 200, key);
  }
});

test('inside and outside settings expose the same values without write permission metadata', async (t) => {
  const { app, ask } = await setup(t);
  const inside = await (await app.get('/api/settings')).json();
  const outside = await (await ask('GET', '/api/settings')).json();
  assert.deepEqual(outside, inside);
  for (const entry of (outside as { settings: Record<string, unknown>[] }).settings) {
    assert.equal(Object.hasOwn(entry, 'localOnly'), false, String(entry.key));
    assert.equal(Object.hasOwn(entry, 'writable'), false, String(entry.key));
  }
});

test('the outside owner can manage all account and machine fields and router controls', async (t) => {
  const { app, ask } = await setup(t);
  // A machine joins by itself; what the owner writes about one is its note.
  holdMachine(app.f.ledger, testMachine('mobile-worker', 'worker.example'));
  assert.equal((await ask('PUT', '/api/machines/mobile-worker', { note: '手机添加' })).status, 200);
  assert.equal(app.f.ledger.getMachine('mobile-worker')!.note, '手机添加');
  assert.equal((await ask('PUT', '/api/machines/mobile-worker', { note: '' })).status, 200);
  assert.equal(app.f.ledger.getMachine('mobile-worker')!.note, undefined);
  assert.equal(app.f.ledger.getMachine('mobile-worker')!.host, 'worker.example');
  assert.equal((await ask('GET', '/api/machines')).status, 200);
  assert.equal((await ask('POST', '/api/machines/mobile-worker/check')).status, 200);
  // An account made from outside is one whose secret is typed: a Codex API key.
  const body = { executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m\n' } }, credential: 'mobile-key',
    timeout_ms: 1234, max_runs: 2 };
  const created = await ask('POST', '/api/accounts', { ...body, name: 'mobile' });
  assert.equal(created.status, 201);
  const { account: { id } } = (await created.json()) as { account: { id: string } };
  const account = app.accounts.get(id)!;
  assert.equal(account.credential, 'set');
  assert.equal(account.timeoutMs, 1234);
  assert.equal(account.maxRuns, 2);
  assert.equal((await ask('PUT', `/api/accounts/${id}`, { ...body, max_runs: null })).status, 200);
  assert.equal(app.accounts.get(id)!.maxRuns, undefined);
  assert.equal((await ask('POST', `/api/accounts/${id}/check`)).status, 200);
  // And the fields of an account whose login is not typed, its permission mode among them.
  const held = app.accounts.get('t1')!;
  assert.equal((await ask('PUT', '/api/accounts/t1', { executor: held.executor, tiers: held.tiers, permission_mode: 'plan' })).status, 200);
  assert.equal(app.accounts.get('t1')!.permissionMode, 'plan');
  assert.equal((await ask('DELETE', `/api/accounts/${id}`)).status, 200);
  assert.equal((await ask('DELETE', '/api/machines/mobile-worker')).status, 200);
  assert.equal((await ask('POST', '/api/router/restart')).status, 202);
  assert.equal((await ask('POST', '/api/pause', { paused: true })).status, 200);
});

// The new object routes follow the outside browser session and public Origin rules too.
test('machine routes outside require that listener login and its public Origin for writes', async (t) => {
  const { app, port, cookie } = await setup(t);
  const url = 'http://127.0.0.1:' + port;
  const routes = [['GET', '/api/machines'], ['POST', '/api/accounts/t1/check'],
    ['PUT', '/api/machines/from-outside'], ['DELETE', '/api/machines/h1'], ['POST', '/api/machines/h1/check']] as const;
  const before = app.f.dump();
  for (const [method, path] of routes) {
    for (const token of [LOGIN_TOKEN, SHUTDOWN_TOKEN, TOOL_TOKEN]) {
      const response = await fetch(url + path, { method, headers: { Authorization: 'Bearer ' + token, Origin: PUBLIC },
        ...(method === 'PUT' ? { body: JSON.stringify({ host: 'worker.example' }) } : {}) });
      assert.equal(response.status, 401, method + ' ' + path + ': 本机令牌不能替代对外登录');
    }
    if (method === 'GET') continue;
    for (const origin of ['', 'https://evil.example']) {
      const response = await fetch(url + path, { method, headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
        ...(method === 'PUT' ? { body: JSON.stringify({ host: 'worker.example' }) } : {}) });
      assert.equal(response.status, 403, method + ' ' + path + ': 来源必须是门牌的对外地址');
    }
  }
  assert.deepEqual(app.f.dump(), before, '被拒的请求不能改机器、账号或账本');
});

test('the outside owner can replace the wecom secret and enable or disable its bot', async (t) => {
  const { app, ask } = await setup(t);
  const saved = await ask('PUT', '/api/wecom/secret', { secret: 'test-only-secret' });
  assert.equal(saved.status, 200, await saved.text());
  assert.equal((await ask('PUT', '/api/settings/wecom.owner', { value: 'mobile-owner' })).status, 200);
  assert.equal((await ask('PUT', '/api/settings/wecom.botId', { value: 'mobile-bot' })).status, 200);
  assert.equal(app.settings.get('wecom.botId'), 'mobile-bot');
  assert.equal((await ask('DELETE', '/api/settings/wecom.botId')).status, 200);
  assert.equal((await ask('DELETE', '/api/settings/wecom.owner')).status, 200);
});

// Use the wire: fetch normalizes some of the very spellings being tested.
function raw(port: number, method: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('原始 HTTP 请求没有结束')));
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => { response += chunk.toString(); });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1])));
    socket.on('connect', () => socket.write(method + ' ' + path + ' HTTP/1.1\r\n' +
      Object.entries({ Host: 'forged.example', Connection: 'close', 'Content-Length': '0', ...headers }).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n'));
  });
}

test('raw methods, path variants, absolute accounts and forged proxy headers never expose local routes outside', async (t) => {
  const { app, port, cookie } = await setup(t);
  const endpoints = [['POST', '/tools/list'], ['POST', '/tools/call'], ['POST', '/api/login-links'],
    ['POST', '/api/shutdown'], ['GET', '/api/instance']];
  for (const [method, path] of endpoints) {
    const variants = [
      ['HEAD', path!], ['OPTIONS', path!], [method!, path!.toUpperCase()], [method!, path! + '/'],
      [method!, path!.replace('a', '%61').replace('tools', '%74ools')],
      [method!, '/' + path!], [method!, 'http://localhost' + path!], [method!, path!],
    ];
    for (const [verb, account] of variants) {
      for (const token of [TOOL_TOKEN, LOGIN_TOKEN, SHUTDOWN_TOKEN]) {
        const status = await raw(port, verb!, account!, { Cookie: cookie, Origin: PUBLIC,
          Authorization: 'Bearer ' + token, Host: 'localhost:' + app.port, 'X-Forwarded-For': '127.0.0.1' });
        assert.equal(status, 404, verb + ' ' + account);
      }
    }
  }
  assert.equal(await raw(port, 'GET', 'http://localhost/api/doctor', { Authorization: 'Bearer ' + SHUTDOWN_TOKEN, 'X-Forwarded-For': '127.0.0.1' }), 401);
  assert.equal(app.state.shutdowns, 0);
  assert.equal(app.state.calls, 0);
});
