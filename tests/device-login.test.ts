// Guards against a six-digit locator becoming a credential, a repeated or expired exchange,
// cross-listener cookies, unaudited decisions, secret leakage, and failed writes granting access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth, describeDevice, MAX_PENDING_DEVICE_LOGINS } from '../service/auth.ts';
import { fixture, tuned, USER } from './helpers.ts';

const TTL = 60_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';

test('only the originating credential and entrance can collect an approved login, once', (t) => {
  const f = fixture(t);
  const auth = createAuth({ ledger: f.ledger, linkTtlMs: () => TTL, sessionDays: () => 30, temporarySessionMs: tuned('login.temporarySessionMs') });
  const request = auth.createDeviceLogin(true, UA)!;
  const secret = request.credential;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.match(request.code, /^\d{6}$/);
  assert.equal(auth.deviceLogin(request.code, true).state, 'missing');
  assert.equal(auth.deviceLogin(secret, true).state, 'pending');
  assert.equal(f.ledger.listConsoleSessions().length, 0);
  assert.equal(auth.deviceLogin(secret, false).state, 'missing');
  assert.equal(auth.lookupDeviceLogin(request.code)?.device, 'Chrome · Windows');
  assert.ok(auth.decideDeviceLogin(request.code, true, USER));
  assert.equal(auth.decideDeviceLogin(request.code, false, USER), undefined);
  assert.equal(auth.lookupDeviceLogin(request.code), undefined);
  assert.equal(auth.deviceLogin(secret, false).state, 'missing');
  const result = auth.deviceLogin(secret, true);
  assert.equal(result.state, 'approved');
  if (result.state !== 'approved') return;
  assert.match(result.cookie, /; Secure;/);
  assert.ok(auth.authenticate(result.cookie, true));
  assert.equal(auth.authenticate(result.cookie, false), undefined);
  assert.equal(auth.deviceLogin(secret, true).state, 'missing');
  const audit = f.peek<{ action: string; actor: string; detail_json: string; at: string }>("SELECT action, actor, detail_json, at FROM change WHERE action LIKE 'console.device.%'");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, 'console.device.approve');
  assert.equal(audit[0]!.actor, 'user');
  assert.ok(audit[0]!.at);
  assert.deepEqual(JSON.parse(audit[0]!.detail_json), { entry: 'outside', device: 'Chrome · Windows' });
  const persisted = JSON.stringify(f.dump());
  assert.ok(!persisted.includes(secret));
  assert.ok(!persisted.includes(request.code));
});

test('rejection, expiry and a restart never grant a session', (t) => {
  const f = fixture(t);
  let now = 1_000_000;
  let ttl = TTL;
  const options = { ledger: f.ledger, linkTtlMs: () => ttl, sessionDays: () => 30, temporarySessionMs: tuned('login.temporarySessionMs'), now: () => now };
  const auth = createAuth(options);
  const rejected = auth.createDeviceLogin(false, UA)!;
  assert.ok(auth.decideDeviceLogin(rejected.code, false, USER));
  assert.equal(auth.deviceLogin(rejected.credential, false).state, 'rejected');
  assert.equal(auth.decideDeviceLogin(rejected.code, true, USER), undefined);
  const old = auth.createDeviceLogin(false, UA)!;
  ttl = 1000;
  const short = auth.createDeviceLogin(false, UA)!;
  assert.equal(short.expires_at, now + 1000);
  now += 1000;
  assert.equal(auth.decideDeviceLogin(short.code, true, USER), undefined);
  assert.equal(auth.deviceLogin(short.credential, false).state, 'missing');
  assert.ok(auth.decideDeviceLogin(old.code, true, USER));
  now += TTL;
  assert.equal(auth.deviceLogin(old.credential, false).state, 'missing');
  const pending = auth.createDeviceLogin(false, UA)!;
  const reopened = createAuth(options);
  assert.equal(reopened.deviceLogin(pending.credential, false).state, 'missing');
  assert.equal(f.ledger.listConsoleSessions().length, 0);
  assert.equal(f.peek<{ action: string }>("SELECT action FROM change WHERE action = 'console.device.reject'").length, 1);
});

test('pending numbers are unique, bounded, and capacity is returned after decisions or expiry', (t) => {
  const f = fixture(t);
  let now = 1_000_000;
  const auth = createAuth({ ledger: f.ledger, linkTtlMs: () => TTL, sessionDays: () => 30, temporarySessionMs: tuned('login.temporarySessionMs'), now: () => now });
  const requests = Array.from({ length: MAX_PENDING_DEVICE_LOGINS }, () => auth.createDeviceLogin(false, UA)!);
  assert.equal(new Set(requests.map(r => r.code)).size, MAX_PENDING_DEVICE_LOGINS);
  assert.equal(auth.createDeviceLogin(false, UA), undefined);
  auth.decideDeviceLogin(requests[0]!.code, false, USER);
  assert.ok(auth.createDeviceLogin(false, UA));
  now += TTL;
  assert.ok(auth.createDeviceLogin(false, UA));
});

test('a decision or exchange whose durable write fails leaves the request unadvanced', (t) => {
  const f = fixture(t);
  const auth = createAuth({ ledger: f.ledger, linkTtlMs: () => TTL, sessionDays: () => 30, temporarySessionMs: tuned('login.temporarySessionMs') });
  const request = auth.createDeviceLogin(false, UA)!;
  const secret = request.credential;
  f.force("CREATE TRIGGER refuse_decision BEFORE INSERT ON change BEGIN SELECT RAISE(ABORT, 'no'); END");
  assert.throws(() => auth.decideDeviceLogin(request.code, true, USER));
  assert.equal(auth.deviceLogin(secret, false).state, 'pending');
  f.force('DROP TRIGGER refuse_decision');
  f.ledger.recover();
  auth.decideDeviceLogin(request.code, true, USER);
  f.force("CREATE TRIGGER refuse_session BEFORE INSERT ON setting BEGIN SELECT RAISE(ABORT, 'no'); END");
  assert.throws(() => auth.deviceLogin(secret, false));
  f.force('DROP TRIGGER refuse_session');
  f.ledger.recover();
  assert.equal(auth.deviceLogin(secret, false).state, 'approved');
});

test('device descriptions recognize common browsers and systems, and cap unknown user agents', () => {
  assert.equal(describeDevice(UA), 'Chrome · Windows');
  assert.equal(describeDevice(UA + ' Edg/130.0'), 'Edge · Windows');
  assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari · iPhone');
  assert.equal(describeDevice('Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/132.0'), 'Firefox · Linux');
  assert.equal(describeDevice('unknown'.repeat(30)), 'unknown'.repeat(30).slice(0, 80));
});
