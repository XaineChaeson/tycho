// Guards against leaked credentials, invisible or mislabelled sessions, unauthorized or partial revocation,
// streams surviving revocation, and temporary approval cookies or sessions outliving their chosen duration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { consoleApp } from './console-helpers.ts';
import { USER } from './helpers.ts';

const PUBLIC = 'https://tycho.example';
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-11-06T00:00:00.000Z');
const iso = (at: number): string => new Date(at).toISOString();
const secret = (cookie: string): string => cookie.split(';')[0]!.split('=')[1]!;
const id = (cookie: string): string => createHash('sha256').update(secret(cookie)).digest('hex');

interface Session {
  id: string;
  device: string;
  entry: 'inside' | 'outside';
  method: 'link' | 'device' | 'wecom' | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
}
interface Sessions { sessions: Session[]; session_days: number; temporary_ms: number }

async function setup(t: TestContext, options: Parameters<typeof consoleApp>[1] = {}) {
  const app = await consoleApp(t, options);
  app.settings.set('http.publicUrl', PUBLIC, USER);
  const port = await app.http.outside.listen(0);
  const outside = 'http://127.0.0.1:' + port;
  const ask = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown, out = false) =>
    fetch((out ? outside : app.url) + (path.startsWith('/login#') ? '/login' : path), {
      method, headers: { ...headers, ...(path.startsWith('/login#') ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, redirect: 'manual',
      ...(path.startsWith('/login#') ? { body: new URLSearchParams({ credential: path.slice('/login#'.length) }) }
        : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function signIn(out = false, userAgent = UA) {
    const response = await ask(await app.newLink(), 'POST', { Origin: out ? PUBLIC : app.url, 'User-Agent': userAgent }, undefined, out);
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }
  async function begin(out = false) {
    const response = await ask('/login/device', 'POST', { Origin: out ? PUBLIC : app.url, 'User-Agent': UA }, undefined, out);
    assert.equal(response.status, 303);
    const path = response.headers.get('location')!;
    const pendingCookie = response.headers.getSetCookie().find(line => /Path=\/login\/device/.test(line))!.split(';')[0]!;
    const credential = pendingCookie.split('=')[1]!;
    const html = await (await ask(path, 'GET', { Cookie: pendingCookie }, undefined, out)).text();
    return { path, code: /<h1>(\d{6})<\/h1>/.exec(html)![1]!, pendingCookie, credential };
  }
  async function approve(temporary = false, out = false) {
    const request = await begin(out);
    assert.equal((await app.post('/api/admissions/approve', { kind: 'device', code: request.code, temporary })).status, 200);
    const response = await ask(request.path, 'GET', { Cookie: request.pendingCookie }, undefined, out);
    assert.equal(response.status, 303);
    return { response, cookie: response.headers.get('set-cookie')!.split(';')[0]!, request };
  }
  const list = async (cookie = app.cookie, out = false): Promise<Sessions> => {
    const response = await ask('/api/console-sessions', 'GET', { Cookie: cookie }, undefined, out);
    assert.equal(response.status, 200);
    return await response.json() as Sessions;
  };
  const openStream = async (cookie: string, out = false) => {
    const response = await ask('/api/stream', 'GET', { Cookie: cookie }, undefined, out);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    return reader;
  };
  return { app, ask, signIn, begin, approve, list, openStream };
}

test('session lists show both entrances, the current browser, old devices and only irreversible identifiers', async (t) => {
  let clock = START;
  const { app, ask, signIn, approve, list } = await setup(t, { now: () => clock });
  const linked = await signIn(true);
  const allowed = await approve();
  const legacySecret = 'a'.repeat(64);
  const legacyCookie = 'tycho=' + legacySecret;
  app.f.ledger.addConsoleSession({ id: id(legacyCookie), created_at: iso(clock), last_seen_at: iso(clock) }, USER, iso(clock - 30 * DAY));
  clock += HOUR;
  assert.equal((await ask('/api/state', 'GET', { Cookie: linked }, undefined, true)).status, 200);
  const inside = await list();
  const outside = await list(linked, true);
  assert.equal(inside.session_days, 30);
  assert.equal(inside.temporary_ms, 12 * HOUR);
  assert.equal(inside.sessions.length, 4);
  assert.equal(inside.sessions.filter(session => session.current).length, 1);
  assert.equal(inside.sessions.find(session => session.current)!.id, id(app.cookie));
  assert.equal(outside.sessions.filter(session => session.current).length, 1);
  assert.equal(outside.sessions.find(session => session.current)!.id, id(linked));
  assert.deepEqual(inside.sessions.map(({ current: _current, ...session }) => session).sort((a, b) => a.id.localeCompare(b.id)),
    outside.sessions.map(({ current: _current, ...session }) => session).sort((a, b) => a.id.localeCompare(b.id)));
  const external = inside.sessions.find(session => session.id === id(linked))!;
  assert.deepEqual({ device: external.device, entry: external.entry, method: external.method, created_at: external.created_at,
    last_seen_at: external.last_seen_at, expires_at: external.expires_at }, {
    device: 'Chrome · Windows', entry: 'outside', method: 'link', created_at: iso(START), last_seen_at: iso(clock), expires_at: iso(START + 30 * DAY),
  });
  const device = inside.sessions.find(session => session.id === id(allowed.cookie))!;
  assert.equal(device.device, 'Chrome · Windows');
  assert.equal(device.entry, 'inside');
  assert.equal(device.method, 'device');
  const old = inside.sessions.find(session => session.id === id(legacyCookie))!;
  assert.equal(old.device, '未知设备');
  assert.equal(old.method, null);
  assert.equal(old.entry, 'inside');
  assert.equal(old.expires_at, iso(START + 30 * DAY));
  const serialized = JSON.stringify(inside);
  for (const credential of [app.cookie, linked, allowed.cookie, legacyCookie].map(secret).concat(allowed.request.credential)) {
    assert.ok(!serialized.includes(credential), '清单不能带 Cookie 或待领取凭据');
  }
  for (const session of inside.sessions) assert.deepEqual(Object.keys(session).sort(), [
    'id', 'device', 'entry', 'method', 'created_at', 'last_seen_at', 'expires_at', 'current',
  ].sort(), '清单只含展示字段，不含登录凭据');
  for (const session of inside.sessions) assert.match(session.id, /^[0-9a-f]{64}$/);
});

test('listing and revocation require a login; writes reject foreign origins on either listener', async (t) => {
  const { app, ask, signIn, list } = await setup(t);
  const external = await signIn(true);
  const victim = await signIn();
  const paths = ['/api/console-sessions/' + id(victim) + '/revoke', '/api/console-sessions/revoke-others'];
  for (const out of [false, true]) {
    assert.equal((await ask('/api/console-sessions', 'GET', {}, undefined, out)).status, 401);
    for (const path of paths) {
      assert.equal((await ask(path, 'POST', { Origin: out ? PUBLIC : app.url }, {}, out)).status, 401);
      for (const headers of [{}, { Origin: 'https://evil.example' }] as Record<string, string>[]) {
        const response = await ask(path, 'POST', { Cookie: out ? external : app.cookie, ...headers }, {}, out);
        assert.equal(response.status, 403);
      }
    }
  }
  assert.equal((await list()).sessions.length, 3, '拒绝的退出请求没有副作用');
});

test('revoking an outside device closes its stream immediately, rejects its cookie and records who revoked which device', { timeout: 5000 }, async (t) => {
  const { app, ask, signIn, list, openStream } = await setup(t);
  const cookie = await signIn(true);
  const reader = await openStream(cookie, true);
  assert.equal(app.stream.size, 1);
  const before = app.f.peek<{ seq: number }>('SELECT MAX(seq) AS seq FROM change')[0]!.seq;
  const response = await app.post('/api/console-sessions/' + id(cookie) + '/revoke', {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(app.stream.size, 0, '不能等心跳才断开');
  assert.equal((await reader.read()).done, true);
  assert.equal((await ask('/api/state', 'GET', { Cookie: cookie }, undefined, true)).status, 401);
  assert.equal((await app.get('/api/state')).status, 200);
  assert.equal((await list()).sessions.length, 1);
  const changes = app.f.peek<{ actor: string; at: string; detail_json: string }>(
    "SELECT actor, at, detail_json FROM change WHERE seq > ? AND action = 'console.logout'", String(before));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.actor, 'console:' + id(app.cookie));
  assert.ok(Number.isFinite(Date.parse(changes[0]!.at)));
  const detail = JSON.parse(changes[0]!.detail_json) as { session_id: string; device: string; entry: string };
  assert.deepEqual({ session_id: detail.session_id, device: detail!.device, entry: detail!.entry }, {
    session_id: id(cookie), device: 'Chrome · Windows', entry: 'outside',
  });
  for (const credential of [secret(app.cookie), secret(cookie)]) assert.ok(!JSON.stringify(changes).includes(credential));
});

test('revoke others keeps only this device across entrances and closes every other stream', { timeout: 5000 }, async (t) => {
  const { app, ask, signIn, list, openStream } = await setup(t);
  const inside = await signIn();
  const outside = await signIn(true);
  const insideReader = await openStream(inside);
  const outsideReader = await openStream(outside, true);
  const thisReader = await openStream(app.cookie);
  const response = await app.post('/api/console-sessions/revoke-others', {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(app.stream.size, 1);
  assert.equal((await insideReader.read()).done, true);
  assert.equal((await outsideReader.read()).done, true);
  for (const [cookie, out] of [[inside, false], [outside, true]] as const) {
    assert.equal((await ask('/api/state', 'GET', { Cookie: cookie }, undefined, out)).status, 401);
  }
  const sessions = (await list()).sessions;
  assert.deepEqual(sessions.map(session => [session.id, session.current]), [[id(app.cookie), true]]);
  assert.equal((await app.get('/api/state')).status, 200);
  await thisReader.cancel();
});

test('an outside browser can revoke all other entrances, then clear its own Secure cookie', async (t) => {
  const { app, ask, signIn, list } = await setup(t);
  const cookie = await signIn(true);
  const headers = { Cookie: cookie, Origin: PUBLIC };
  const response = await ask('/api/console-sessions/revoke-others', 'POST', headers, {}, true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await app.get('/api/state')).status, 401);
  assert.deepEqual((await list(cookie, true)).sessions.map(session => [session.id, session.current]), [[id(cookie), true]]);
  const logout = await ask('/api/console-sessions/' + id(cookie) + '/revoke', 'POST', headers, {}, true);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie')!, /^tycho=;.*; Secure; Max-Age=0$/);
  assert.equal((await ask('/api/state', 'GET', headers, undefined, true)).status, 401);
  assert.equal(app.f.ledger.listConsoleSessions().length, 0);
});

test('revoking this device clears its cookie and its stream like logout', { timeout: 5000 }, async (t) => {
  const { app, openStream } = await setup(t);
  const reader = await openStream(app.cookie);
  const response = await app.post('/api/console-sessions/' + id(app.cookie) + '/revoke', {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie')!, /^tycho=;.*Max-Age=0$/);
  assert.equal((await reader.read()).done, true);
  assert.equal((await app.get('/api/state')).status, 401);
});

test('failed revocation commits neither session removal nor audit and leaves its stream attached', async (t) => {
  const { app, signIn, list, openStream } = await setup(t);
  const cookie = await signIn();
  const reader = await openStream(cookie);
  const before = app.f.peek('SELECT * FROM change');
  app.f.force("CREATE TRIGGER refuse_session_revoke BEFORE INSERT ON change BEGIN SELECT RAISE(ABORT, 'revoke refused'); END");
  try {
    const response = await app.post('/api/console-sessions/' + id(cookie) + '/revoke', {});
    assert.ok(response.status >= 500);
    assert.equal(app.stream.size, 1);
    assert.ok(app.f.ledger.listConsoleSessions().some(session => session.id === id(cookie)));
    assert.deepEqual(app.f.peek('SELECT * FROM change'), before);
  } finally {
    app.f.force('DROP TRIGGER refuse_session_revoke');
    app.f.ledger.recover();
  }
  assert.equal((await app.get('/api/state', { Cookie: cookie })).status, 200);
  assert.equal((await list()).sessions.length, 2);
  await reader.cancel();
});

test('temporary approval cookies match the chosen lifetime on either entrance and expire without shortening normal sessions', async (t) => {
  let clock = START;
  const { app, ask, approve, list } = await setup(t, { now: () => clock });
  const shortInside = await approve(true);
  const shortOutside = await approve(true, true);
  const long = await approve();
  for (const result of [shortInside, shortOutside]) {
    assert.match(result.response.headers.getSetCookie().find(line => /^tycho=/.test(line))!, /Max-Age=43200$/);
    assert.equal((await list()).sessions.find(session => session.id === id(result.cookie))!.expires_at, iso(START + 12 * HOUR));
  }
  assert.match(shortOutside.response.headers.getSetCookie().find(line => /^tycho=/.test(line))!, /; Secure;/);
  assert.match(long.response.headers.getSetCookie().find(line => /^tycho=/.test(line))!, /Max-Age=2592000$/);
  clock += 12 * HOUR - 1;
  for (const [cookie, out] of [[shortInside.cookie, false], [shortOutside.cookie, true]] as const) {
    assert.equal((await ask('/api/state', 'GET', { Cookie: cookie }, undefined, out)).status, 200);
  }
  clock += 1;
  for (const [cookie, out] of [[shortInside.cookie, false], [shortOutside.cookie, true]] as const) {
    assert.equal((await ask('/api/state', 'GET', { Cookie: cookie }, undefined, out)).status, 401);
  }
  assert.equal((await app.get('/api/state', { Cookie: long.cookie })).status, 200);
  assert.equal((await list()).sessions.length, 2);
});

test('temporary duration settings enforce their bounds and affect new approvals immediately without extending old ones', async (t) => {
  const { app, approve, list } = await setup(t, { now: () => START });
  const first = await approve(true);
  const set = (value: unknown) => app.send('PUT', '/api/settings/login.temporarySessionMs', { value });
  for (const value of [HOUR - 1, 7 * DAY + 1, '12', null]) {
    const response = await set(value);
    assert.equal(response.status, 400, String(value));
  }
  assert.equal((await set(HOUR)).status, 200);
  const pending = await approve(true);
  assert.match(pending.response.headers.getSetCookie().find(line => /^tycho=/.test(line))!, /Max-Age=3600$/);
  assert.equal((await set(7 * DAY)).status, 200);
  const last = await approve(true);
  assert.match(last.response.headers.getSetCookie().find(line => /^tycho=/.test(line))!, /Max-Age=604800$/);
  const sessions = await list();
  assert.equal(sessions.temporary_ms, 7 * DAY);
  for (const [cookie, lifetime] of [[first.cookie, 12 * HOUR], [pending.cookie, HOUR], [last.cookie, 7 * DAY]] as const) {
    assert.equal(sessions.sessions.find(session => session.id === id(cookie))!.expires_at, iso(START + lifetime));
  }
});

test('reducing normal retention expires temporary sessions by age too, and increasing it never extends their fixed deadline', async (t) => {
  let clock = START;
  const { app, ask, approve, list } = await setup(t, { now: () => clock });
  app.settings.set('login.temporarySessionMs', 7 * DAY, USER);
  const short = await approve(true);
  app.settings.set('login.sessionDays', 60, USER);
  assert.equal((await list()).sessions.find(session => session.id === id(short.cookie))!.expires_at, iso(START + 7 * DAY));
  clock += 2 * DAY;
  const current = await app.signIn();
  app.settings.set('login.sessionDays', 1, USER);
  assert.equal((await ask('/api/state', 'GET', { Cookie: short.cookie })).status, 401);
  assert.equal((await app.get('/api/state', { Cookie: current })).status, 200);
});
