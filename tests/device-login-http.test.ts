// Guards against anonymous or foreign approvals, premature cookies, cross-entrance redemption,
// unbounded pending requests, quota bypass, scripted waiting pages, and restart/secret leaks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createAuth, MAX_PENDING_DEVICE_LOGINS } from '../service/auth.ts';
import { consoleApp } from './console-helpers.ts';
import { tuned, USER } from './helpers.ts';

const PUBLIC = 'https://tycho.example';
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36';
const MISSING = '没有这个号码，或者它已经过期';

async function setup(t: TestContext, options: Parameters<typeof consoleApp>[1] = {}) {
  const app = await consoleApp(t, options);
  app.settings.set('http.publicUrl', PUBLIC, USER);
  const port = await app.http.outside.listen(0);
  const outside = `http://127.0.0.1:${port}`;
  const ask = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown, out = false) =>
    fetch((out ? outside : app.url) + (path.startsWith('/login#') ? '/login' : path), {
      method, headers: { ...headers, ...(path.startsWith('/login#') ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, redirect: 'manual',
      ...(path.startsWith('/login#') ? { body: new URLSearchParams({ credential: path.slice('/login#'.length) }) }
        : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function begin(out = false, source = '') {
    const response = await ask('/login/device', 'POST', { Origin: out ? PUBLIC : app.url, 'User-Agent': UA, 'X-Forwarded-For': source }, undefined, out);
    assert.equal(response.status, 303);
    assert.ok(response.headers.getSetCookie().every(line => !/^tycho=/.test(line)), 'creation has no session');
    const cookie = response.headers.getSetCookie().find(line => /Path=\/login\/device/.test(line))!.split(';')[0]!;
    const credential = cookie.split('=')[1]!;
    const path = response.headers.get('location')!;
    const wait = await ask(path, 'GET', { Cookie: cookie }, undefined, out);
    assert.equal(wait.status, 200);
    assert.equal(wait.headers.get('set-cookie'), null);
    const html = await wait.text();
    const code = /<h1>(\d{6})<\/h1>/.exec(html)![1]!;
    return { path, code, html, wait, cookie, credential };
  }
  return { app, outside, ask, begin };
}

test('waiting pages need only HTML and the new browser alone receives an entrance-bound cookie', async (t) => {
  const { app, ask, begin } = await setup(t, { channels: () => ({ wecom: {} }) });
  assert.match(await (await ask('/login')).text(), /method="post" action="\/login\/device"/);
  for (const out of [false, true]) {
    const req = await begin(out);
    assert.equal(req.path, '/login/device');
    assert.equal(req.wait.headers.get('referrer-policy'), 'strict-origin');
    assert.match(req.html, /<meta http-equiv="refresh" content="\d+">/);
    assert.doesNotMatch(req.html, /<script|onload|onclick/i);
    assert.match(req.html, /分钟内有效/);
    assert.ok(req.html.includes('登录 ' + req.code));
    assert.equal((await ask('/login/device/' + req.code, 'GET', {}, undefined, out)).headers.get('set-cookie'), null);
    const lookup = await app.post('/api/admissions/lookup', { code: req.code });
    assert.equal(lookup.status, 200);
    const [detail, ...others] = (await lookup.json() as { matches: { kind: string; entry: string; device: string; created_at: number }[] }).matches;
    assert.equal(others.length, 0);
    assert.equal(detail!.kind, 'device');
    assert.equal(detail!.entry, out ? 'outside' : 'inside');
    assert.equal(detail!.device, 'Chrome · Windows');
    assert.equal(typeof detail!.created_at, 'number');
    const allowed = await app.post('/api/admissions/approve', { kind: 'device', code: req.code });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('set-cookie'), null);
    const wrong = await ask(req.path, 'GET', { Cookie: req.cookie }, undefined, !out);
    assert.equal(wrong.status, 410);
    assert.ok(wrong.headers.getSetCookie().every(line => !/^tycho=/.test(line)));
    assert.ok(wrong.headers.getSetCookie().some(line => /Max-Age=0/.test(line)));
    const finished = await ask(req.path, 'GET', { Cookie: req.cookie }, undefined, out);
    assert.equal(finished.status, 303);
    assert.equal(finished.headers.get('location'), '/');
    assert.equal(finished.headers.get('referrer-policy'), 'strict-origin');
    const cookie = finished.headers.get('set-cookie')!;
    assert.equal(cookie.includes('; Secure;'), out);
    assert.equal((await ask('/api/state', 'GET', { Cookie: cookie }, undefined, out)).status, 200);
    assert.equal((await ask('/api/state', 'GET', { Cookie: cookie }, undefined, !out)).status, 401);
    assert.equal((await ask(req.path, 'GET', { Cookie: req.cookie }, undefined, out)).status, 410);
    const changes = app.f.peek<{ detail_json: string }>("SELECT detail_json FROM change WHERE action LIKE 'console.device.%'");
    assert.ok(!JSON.stringify(changes).includes(req.credential));
    assert.ok(!JSON.stringify(changes).includes(req.code));
  }
});

test('approval endpoints require a login and a same-site source at either listener', async (t) => {
  const { app, ask, begin } = await setup(t);
  const req = await begin();
  for (const action of ['lookup', 'approve', 'reject']) {
    for (const out of [false, true]) {
      const path = '/api/admissions/' + action;
      assert.equal((await ask(path, 'POST', { Origin: out ? PUBLIC : app.url }, { kind: 'device', code: req.code }, out)).status, 401);
    }
    assert.equal((await app.post('/api/admissions/' + action, { kind: 'device', code: req.code }, { Cookie: app.cookie, Origin: 'https://evil.example' })).status, 403);
  }
  const outsideLogin = await ask(await app.newLink(), 'POST', { Origin: PUBLIC }, undefined, true);
  const cookie = outsideLogin.headers.get('set-cookie')!;
  for (const action of ['lookup', 'approve', 'reject']) {
    assert.equal((await ask('/api/admissions/' + action, 'POST', { Cookie: cookie, Origin: 'https://evil.example' }, { kind: 'device', code: req.code }, true)).status, 403);
  }
  assert.equal((await ask('/api/admissions/lookup', 'POST', { Cookie: cookie, Origin: PUBLIC }, { code: req.code }, true)).status, 200);
  assert.equal((await ask('/api/admissions/approve', 'POST', { Cookie: cookie, Origin: PUBLIC }, { kind: 'device', code: req.code }, true)).status, 200);
  assert.equal((await ask(req.path, 'GET', { Cookie: req.cookie })).status, 303);
});

test('rejected, expired or lost requests explain how to restart and never grant sessions', async (t) => {
  let now = 1_000_000;
  const { app, ask, begin } = await setup(t, { now: () => now });
  const req = await begin();
  assert.doesNotMatch(req.html, /企业微信/);
  assert.equal((await app.post('/api/admissions/reject', { kind: 'device', code: req.code })).status, 200);
  const rejected = await ask(req.path, 'GET', { Cookie: req.cookie });
  assert.equal(rejected.status, 410);
  assert.ok(rejected.headers.getSetCookie().every(line => !/^tycho=/.test(line)));
  assert.ok(rejected.headers.getSetCookie().some(line => /Max-Age=0/.test(line)));
  assert.match(await rejected.text(), /没有被放行[\s\S]*重新开始/);
  const expired = await begin();
  now += app.settings.get('login.linkTtlMs');
  const ended = await ask(expired.path, 'GET', { Cookie: expired.cookie });
  assert.equal(ended.status, 410);
  assert.ok(ended.headers.getSetCookie().every(line => !/^tycho=/.test(line)));
  assert.ok(ended.headers.getSetCookie().some(line => /Max-Age=0/.test(line)));
  assert.match(await ended.text(), /请重新开始/);
  const restarted = await ask('/login/device', 'GET', { Cookie: 'tycho_pending=' + 'f'.repeat(64) });
  assert.equal(restarted.status, 410);
  assert.match(await restarted.text(), /服务已重启[\s\S]*重新开始/);
  for (const code of [req.code, expired.code, 'bad', 123456]) {
    const missing = await app.post('/api/admissions/lookup', { code });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: string }).error, MISSING);
  }
  const reopened = createAuth({ ledger: app.f.ledger, linkTtlMs: () => 60_000, sessionDays: () => 30, temporarySessionMs: tuned('login.temporarySessionMs') });
  assert.equal(reopened.deviceLogin(expired.credential, false).state, 'missing');
});

test('pending capacity returns 429 and outsider creation shares the failed-link source bucket', async (t) => {
  const { app, ask, begin } = await setup(t, { now: () => 1_000_000 });
  for (let i = 0; i < MAX_PENDING_DEVICE_LOGINS; i++) await begin();
  const full = await ask('/login/device', 'POST', app.origin);
  assert.equal(full.status, 429);
  assert.match(await full.text(), /现在等着放行的设备太多，稍后再试/);
  assert.equal((await ask('/login/device', 'POST', { Origin: 'https://evil.example' })).status, 403);

  const other = await setup(t, { now: () => 1_000_000 });
  const headers = { Origin: PUBLIC, 'X-Forwarded-For': '203.0.113.7' };
  for (let i = 0; i < 9; i++) await other.begin(true, '203.0.113.7');
  const dead = '/login#' + '0'.repeat(64);
  assert.equal((await other.ask(dead, 'POST', headers, undefined, true)).status, 410);
  assert.equal((await other.ask('/login/device', 'POST', headers, undefined, true)).status, 429);
  assert.equal((await other.ask(dead, 'POST', headers, undefined, true)).status, 429);
  const good = await other.ask(await other.app.newLink(), 'POST', headers, undefined, true);
  assert.equal(good.status, 303);
  await other.begin(true, '198.51.100.9');
});

test('a failed session write returns no cookie, keeps its credential retryable and retains strict-origin', async (t) => {
  const { app, ask, begin } = await setup(t);
  const req = await begin();
  app.f.force("CREATE TRIGGER refuse_device_decision BEFORE INSERT ON change BEGIN SELECT RAISE(ABORT, 'no'); END");
  assert.ok((await app.post('/api/admissions/approve', { kind: 'device', code: req.code })).status >= 500);
  const stillWaiting = await ask(req.path, 'GET', { Cookie: req.cookie });
  assert.equal(stillWaiting.status, 200);
  assert.equal(stillWaiting.headers.get('set-cookie'), null);
  app.f.force('DROP TRIGGER refuse_device_decision');
  app.f.ledger.recover();
  assert.equal((await app.post('/api/admissions/approve', { kind: 'device', code: req.code })).status, 200);
  app.f.force("CREATE TRIGGER refuse_device_session BEFORE INSERT ON setting BEGIN SELECT RAISE(ABORT, 'no'); END");
  const failed = await ask(req.path, 'GET', { Cookie: req.cookie });
  assert.ok(failed.status >= 500);
  assert.equal(failed.headers.get('set-cookie'), null);
  assert.equal(failed.headers.get('referrer-policy'), 'strict-origin');
  app.f.force('DROP TRIGGER refuse_device_session');
  app.f.ledger.recover();
  const retried = await ask(req.path, 'GET', { Cookie: req.cookie });
  assert.equal(retried.status, 303);
  assert.ok(retried.headers.get('set-cookie'));
  assert.equal((await ask(req.path, 'GET', { Cookie: req.cookie })).status, 410);
});
