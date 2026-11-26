// Guards against credential-bearing device lists, lost legacy sessions, mutable temporary deadlines,
// non-atomic revocations, stale memory authentication, and settings that outlive their intended scope.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from '../service/auth.ts';
import { createSettings } from '../service/settings.ts';
import { fixture, USER } from './helpers.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36';

test('sessions carry their device, entrance, login method and deadline, while old sessions remain readable', t => {
  const f = fixture(t);
  let clock = 1_000_000;
  const auth = createAuth({ ledger: f.ledger, linkTtlMs: () => 60_000, sessionDays: () => 30, temporarySessionMs: () => 12 * HOUR, now: () => clock });
  const cookie = auth.login(auth.createLink().credential, true, UA)!;
  const current = auth.authenticate(cookie, true)!;
  f.ledger.addConsoleSession({ id: 'legacy', created_at: current.created_at, last_seen_at: current.created_at }, USER, '');
  const rows = auth.listSessions(current.id);
  assert.deepEqual(rows.map(({ device, entry, method, current }) => ({ device, entry, method, current })), [
    { device: 'Chrome · Windows', entry: 'outside', method: 'link', current: true },
    { device: '未知设备', entry: 'inside', method: null, current: false },
  ]);
  assert.equal(Date.parse(rows[0]!.expires_at), clock + 30 * DAY);
  assert.equal(Date.parse(rows[1]!.expires_at), clock + 30 * DAY);
  assert.ok(!JSON.stringify(rows).includes(cookie.split(';')[0]!.slice(6)));
  // Use is written down every few minutes, not with every request: a page load is not a write.
  const loggedIn = auth.listSessions(current.id)[0]!.last_seen_at;
  clock += 1000;
  auth.used(current.id);
  assert.equal(auth.listSessions(current.id)[0]!.last_seen_at, loggedIn);
  clock += 5 * 60_000;
  auth.used(current.id);
  assert.equal(auth.listSessions(current.id)[0]!.last_seen_at, new Date(clock).toISOString());
  assert.equal(f.ledger.listConsoleSessions()[0]!.last_seen_at, current.last_seen_at, 'device activity must not consume the unread summary cursor');
  auth.touch(current.id);
  assert.equal(f.ledger.listConsoleSessions()[0]!.device, 'Chrome · Windows');
  assert.equal(f.ledger.listConsoleSessions()[0]!.expires_at, rows[0]!.expires_at);
});

test('temporary approvals snapshot the setting at approval, expire on the boundary and survive restart', t => {
  const f = fixture(t);
  let clock = 1_000_000;
  let days = 30;
  const settings = createSettings({ ledger: f.ledger });
  const options = { ledger: f.ledger, linkTtlMs: () => 60_000, sessionDays: () => days, temporarySessionMs: () => settings.get('login.temporarySessionMs'), now: () => clock };
  const auth = createAuth(options);
  const collect = (temporary: boolean, method: 'device' | 'wecom' = 'device') => {
    const request = auth.createDeviceLogin(false, UA)!;
    const decided = auth.decideDeviceLogin(request.code, true, USER, temporary, method)!;
    return { request, decided };
  };
  const short = collect(true, 'wecom');
  assert.equal(short.decided.duration_ms, 12 * HOUR);
  settings.set('login.temporarySessionMs', HOUR, USER);
  const result = auth.deviceLogin(short.request.credential, false);
  assert.equal(result.state, 'approved');
  if (result.state !== 'approved') return;
  assert.match(result.cookie, /Max-Age=43200$/);
  const shorter = collect(true);
  assert.equal(shorter.decided.duration_ms, HOUR);
  const next = auth.deviceLogin(shorter.request.credential, false);
  assert.equal(next.state, 'approved');
  if (next.state !== 'approved') return;
  assert.match(next.cookie, /Max-Age=3600$/);
  const long = auth.login(auth.createLink().credential)!;
  assert.match(long, /Max-Age=2592000$/);
  const reopened = createAuth(options);
  assert.equal(reopened.listSessions('')[0]!.method, 'wecom');
  clock += HOUR;
  assert.equal(reopened.authenticate(next.cookie), undefined);
  assert.ok(reopened.authenticate(result.cookie));
  clock += 11 * HOUR - 1;
  assert.ok(reopened.authenticate(result.cookie));
  days = 365;
  clock += 1;
  assert.equal(reopened.authenticate(result.cookie), undefined, 'raising the day setting cannot extend a temporary login');
  assert.ok(reopened.authenticate(long));
  assert.equal(reopened.listSessions('').length, 1);
});

test('lowering login days also caps temporary sessions; raising the temporary setting does not change existing sessions', t => {
  const f = fixture(t);
  let clock = 1_000_000;
  let days = 30;
  let duration = 7 * DAY;
  const auth = createAuth({ ledger: f.ledger, linkTtlMs: () => 60_000, sessionDays: () => days, temporarySessionMs: () => duration, now: () => clock });
  const request = auth.createDeviceLogin(false, UA)!;
  auth.decideDeviceLogin(request.code, true, USER, true);
  const short = auth.deviceLogin(request.credential, false);
  assert.equal(short.state, 'approved');
  if (short.state !== 'approved') return;
  const long = auth.login(auth.createLink().credential)!;
  clock += 2 * DAY;
  duration = 12 * HOUR;
  assert.ok(auth.authenticate(short.cookie));
  days = 1;
  assert.equal(auth.authenticate(short.cookie), undefined);
  assert.equal(auth.authenticate(long), undefined);
  days = 30;
  assert.ok(auth.authenticate(short.cookie));
  clock += 5 * DAY;
  assert.equal(auth.authenticate(short.cookie), undefined);
  assert.ok(auth.authenticate(long));
});

test('revoking others is one durable operation and invalidates previously verified cookies', t => {
  const f = fixture(t);
  const auth = createAuth({ ledger: f.ledger, linkTtlMs: () => 60_000, sessionDays: () => 30, temporarySessionMs: () => 12 * HOUR });
  const login = (outside = false) => auth.login(auth.createLink().credential, outside, UA)!;
  const current = login();
  const inside = login();
  const outside = login(true);
  const id = auth.authenticate(current)!.id;
  auth.authenticate(inside);
  auth.authenticate(outside, true);
  f.force("CREATE TRIGGER refuse_revoke BEFORE INSERT ON change BEGIN SELECT RAISE(ABORT, 'no revoke'); END");
  assert.throws(() => auth.revokeOthers(id, USER));
  assert.equal(f.ledger.listConsoleSessions().length, 3);
  f.force('DROP TRIGGER refuse_revoke');
  f.ledger.recover();
  assert.equal(auth.revokeOthers(id, USER).length, 2);
  assert.equal(f.ledger.listConsoleSessions().length, 1);
  assert.ok(auth.authenticate(current));
  assert.equal(auth.authenticate(inside), undefined);
  assert.equal(auth.authenticate(outside, true), undefined);
  const changes = f.peek<{ actor: string; detail_json: string; at: string }>("SELECT actor, detail_json, at FROM change WHERE action = 'console.logout'");
  assert.equal(changes.length, 2);
  assert.ok(changes.every(row => row.actor === 'user' && row.at && JSON.parse(row.detail_json).device === 'Chrome · Windows'));
  assert.ok(!JSON.stringify(changes).includes(inside.split(';')[0]!.slice(6)));
});

test('temporary duration is a login setting with inclusive bounds', t => {
  const f = fixture(t);
  const settings = createSettings({ ledger: f.ledger });
  const entry = settings.list().find(row => row.key === 'login.temporarySessionMs')!;
  assert.deepEqual([entry.group, entry.title, entry.value, entry.unit], ['登录', '临时放行保持多久', 12 * HOUR, 'hours']);
  assert.throws(() => settings.set('login.temporarySessionMs', HOUR - 1, USER), /不能小于 1 小时/);
  assert.throws(() => settings.set('login.temporarySessionMs', 7 * DAY + 1, USER), /不能大于 7 天/);
  for (const value of [HOUR, 7 * DAY]) { settings.set('login.temporarySessionMs', value, USER); assert.equal(settings.get('login.temporarySessionMs'), value); }
});
