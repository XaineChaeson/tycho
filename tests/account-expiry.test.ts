// Guards the expected expiry of a login tycho keeps (docs/design/native-login.md §2, rulings J
// and L): the moment a token came in being guessed from the audit or lost when the account is
// edited without a new token; an estimate given for an executor that declares no lifetime, or
// one given at all when the moment the token came in is unknown; the console's account
// answers missing the two facts; an expiry notice pushed twice for one credential, or again
// after that credential was replaced; a notice still going out for a credential the account no
// longer holds; a queued reminder that keeps using an estimate frozen into its payload while
// the executor's declared lifetime has changed; the scan silently doing nothing because a
// caller forgot to hand it the executors' declarations; a first notice lost because the
// reminder window was narrowed after it was queued; and the version 29 → 30 step inventing a
// moment for accounts that were there before it.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { expectedExpiry, expiryDay } from '../shared/credential.ts';
import { PUSH_LEVELS } from '../service/pushes.ts';
import { openLedger } from '../service/ledger.ts';
import { verifySnapshot } from '../service/db.ts';
import { consoleApp } from './console-helpers.ts';
import { claudeTier, fixture, tune, USER } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const LIFETIME = 365;
// A token that came in at the start of 2026 with a year to live.
const CAME_IN = '2026-01-01T00:00:00.000Z';
const EXPIRES = '2027-01-01T00:00:00.000Z';
const ACCOUNT = { id: 't1', name: 'claude', executor: 'claude', tiers: { execute: claudeTier('model') } };
const NOTICE_ROWS = `SELECT kind, payload_json FROM outbox WHERE channel = 'wecom' AND json_extract(payload_json, '$.external_id') LIKE 'account-expiry:%' ORDER BY rowid`;

interface Notice { kind: string; payload: Record<string, any> }
const noticesIn = (file: string): Notice[] => {
  const conn = new DatabaseSync(file, { readOnly: true });
  try {
    return (conn.prepare(NOTICE_ROWS).all() as { kind: string; payload_json: string }[])
      .map(({ kind, payload_json }) => ({ kind, payload: JSON.parse(payload_json) as Record<string, any> }));
  } finally {
    conn.close();
  }
};

test('the expected expiry is the moment the token came in plus what the executor declares', () => {
  assert.equal(expectedExpiry(CAME_IN, LIFETIME), EXPIRES);
  assert.equal(expectedExpiry(CAME_IN, 30), '2026-01-31T00:00:00.000Z');
  assert.equal(expectedExpiry(CAME_IN, undefined), null, '没声明有效期的执行器没有预计到期');
  assert.equal(expectedExpiry(null, LIFETIME), null, '不知道令牌哪天进来的：不猜');
  assert.equal(expectedExpiry('not a moment', LIFETIME), null);
  assert.equal(expiryDay(EXPIRES), '2027-01-01');
  assert.equal(expiryDay(null), '—');
});

test('a credential is stamped with when it came in, and only a new credential moves it', (t) => {
  const f = fixture(t);
  const made = f.ledger.putAccount(ACCOUNT, USER, 'ref-one');
  assert.equal(made.created, true);
  const at = f.ledger.accountCredentialAt(ACCOUNT.id);
  assert.ok(at !== null && !Number.isNaN(Date.parse(at)), '新建账号就有时刻');
  // Editing the account without a token leaves the moment alone: the token did not change.
  f.ledger.putAccount({ ...ACCOUNT, tiers: { execute: claudeTier('another-model') } }, USER);
  assert.equal(f.ledger.accountCredentialAt(ACCOUNT.id), at, '换档位不是换令牌');
  // A replacement, in the same write that names the new token file.
  f.force(`UPDATE account SET credential_at = ? WHERE id = ?`, '2020-01-01T00:00:00.000Z', ACCOUNT.id);
  f.ledger.recordAccountCredential(ACCOUNT.id, 'ref-two', USER);
  const moved = f.ledger.accountCredentialAt(ACCOUNT.id);
  assert.ok(moved !== null && moved !== '2020-01-01T00:00:00.000Z', '换了令牌就重新计时');
  assert.equal(f.ledger.accountCredentialAt('nobody'), null, '账本里没有的账号没有时刻');
  // The moment and the estimate are one derivation, the ledger's own: the console asks it
  // rather than adding the executor's days by a rule of its own.
  assert.deepEqual(f.ledger.accountExpiry(ACCOUNT.id), { credentialAt: moved, expected: expectedExpiry(moved, LIFETIME) });
  assert.deepEqual(f.ledger.accountExpiry('nobody'), { credentialAt: null, expected: null });
});

test('the expiry notice goes out once per credential, from the ledger\'s own declaration of a lifetime', (t) => {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'wecom']);
  assert.equal(PUSH_LEVELS['account_expiry'], 'wait');
  // Two logins, both declared a year: one five days from its estimate, one twenty. The scan is
  // driven at this moment, and whether a queued notice still waits is asked at this moment too.
  const now = Date.now();
  const soon = { ...ACCOUNT, id: 'soon', name: 'soon' };
  const later = { ...ACCOUNT, id: 'later', name: 'later' };
  const cameIn = (daysLeft: number): string => new Date(now + daysLeft * DAY - LIFETIME * DAY).toISOString();
  const expires = (daysLeft: number): string => new Date(now + daysLeft * DAY).toISOString();
  f.ledger.putAccount(soon, USER, 'ref-soon');
  f.ledger.putAccount(later, USER, 'ref-later');
  f.force(`UPDATE account SET credential_at = ? WHERE id = 'soon'`, cameIn(5));
  f.force(`UPDATE account SET credential_at = ? WHERE id = 'later'`, cameIn(20));

  // The window is the setting's: 30 days by default, so both are inside it, and one notice
  // each however often the scan runs. No lifetime is handed in: the ledger holds the executors'
  // declarations and reads them itself, so a caller cannot forget them and get silence.
  f.ledger.expiryReminders(new Date(now));
  const first = noticesIn(f.path);
  assert.deepEqual(first.map(({ kind }) => kind), ['account_expiry', 'account_expiry']);
  assert.deepEqual(
    first.map(({ payload }) => ({ account_id: payload.account_id, account_name: payload.account_name, credential_at: payload.credential_at, expected_expiry: payload.expected_expiry })),
    [
      { account_id: 'soon', account_name: 'soon', credential_at: cameIn(5), expected_expiry: expires(5) },
      { account_id: 'later', account_name: 'later', credential_at: cameIn(20), expected_expiry: expires(20) },
    ],
  );
  assert.match(String(first[0]!.payload.external_id), /^account-expiry:soon:/);
  f.ledger.expiryReminders(new Date(now));
  assert.equal(noticesIn(f.path).length, 2, '同一份凭据只推一次');
  assert.equal(f.ledger.pushStillWaiting('account_expiry', first[0]!.payload), true, '还没换凭据：提醒还等着');
  assert.equal(f.ledger.pushStillWaiting('account_expiry', { ...first[0]!.payload, credential_at: 'another' }), false, '凭据对不上：不是同一件事');
  // Narrowing the window takes the one that is not close enough out of the reminder period:
  // a queued reminder for it stops going out.
  tune(f.ledger, 'accounts.expiryRemindDays', 10);
  assert.equal(f.ledger.pushStillWaiting('account_expiry', first[0]!.payload), true, '五天之外的还在提醒期');
  assert.equal(f.ledger.pushStillWaiting('account_expiry', first[1]!.payload), false, '二十天之外的已经不在提醒期');

  // A token stored again is a new credential: the reminder is counted again from its own moment.
  f.ledger.recordAccountCredential('soon', 'ref-next', USER);
  assert.equal(f.ledger.pushStillWaiting('account_expiry', first[0]!.payload), false, '换了凭据，旧的提醒不再等');
  f.force(`UPDATE account SET credential_at = ? WHERE id = 'soon'`, cameIn(3));
  f.ledger.expiryReminders(new Date(now));
  const all = noticesIn(f.path);
  assert.equal(all.length, 3, '新凭据重新计一次');
  assert.equal(all[2]!.payload.credential_at, cameIn(3));

  // Nothing is pushed without a lifetime, or without the moment the token came in: the
  // executors that declare none (Codex, dsh) are never pushed about, whatever the moment says.
  f.force(`UPDATE account SET credential_at = NULL WHERE id = 'soon'`);
  f.force(`UPDATE account SET credential_at = NULL WHERE id = 'later'`);
  f.ledger.expiryReminders(new Date(now));
  assert.equal(codexAdapter.credentialLifetimeDays, undefined);
  assert.equal(dshAdapter.credentialLifetimeDays, undefined);
  f.ledger.putAccount({ id: 'nolife', name: 'nolife', executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m\n' } } }, USER, 'ref-nolife');
  f.force(`UPDATE account SET credential_at = ? WHERE id = 'nolife'`, cameIn(1));
  assert.deepEqual(f.ledger.expiringAccounts(new Date(now)).map(({ id }) => id), [], '没声明有效期就不算在提醒期里');
  f.ledger.expiryReminders(new Date(now));
  assert.equal(noticesIn(f.path).length, 3, '不知道有效期就不推，不拿机器自己的时间补');
});

test('a queued reminder recomputes the estimate from the ledger\'s row, and a first notice waits only on the credential', (t) => {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'wecom']);
  const now = Date.now();
  const cameIn = new Date(now + 5 * DAY - LIFETIME * DAY).toISOString();
  f.ledger.putAccount(ACCOUNT, USER, 'ref-one');
  f.force(`UPDATE account SET credential_at = ? WHERE id = ?`, cameIn, ACCOUNT.id);
  f.ledger.expiryReminders(new Date(now));
  const notice = noticesIn(f.path)[0]!.payload;
  // The payload's own estimate is only display: the row and the declaration are what say
  // whether it is still in the window. A lifetime changed since it was queued does not leave
  // the check reading a frozen date.
  assert.equal(f.ledger.pushStillWaiting('account_expiry', { ...notice, expected_expiry: '2099-01-01T00:00:00.000Z' }), true);
  assert.equal(f.ledger.pushStillWaiting('account_expiry', { ...notice, expected_expiry: CAME_IN }), true, '过期的那个值不作数：按账本当前的行重算');
  // The first notice goes out while the account holds that credential, even after the window
  // was narrowed so far that the reminder period is over: it entered the period once, and that
  // is a fact the owner has not seen.
  tune(f.ledger, 'accounts.expiryRemindDays', 1);
  assert.equal(f.ledger.pushStillWaiting('account_expiry', notice), false);
  assert.equal(f.ledger.expiryCredentialCurrent(notice), true, '凭据还是当前那份：初发照发');
  f.ledger.recordAccountCredential(ACCOUNT.id, 'ref-two', USER);
  assert.equal(f.ledger.expiryCredentialCurrent(notice), false, '换了凭据：初发不发了');
  // The new credential is inside the window as it stands now (a day): counted again from its
  // own moment.
  const cameInSoon = new Date(now + DAY / 2 - LIFETIME * DAY).toISOString();
  f.force(`UPDATE account SET credential_at = ? WHERE id = ?`, cameInSoon, ACCOUNT.id);
  const next = noticesIn(f.path).length;
  f.ledger.expiryReminders(new Date(now));
  assert.ok(noticesIn(f.path).length > next, '新凭据重新计一次');
  // An account removed since: neither the first notice nor a reminder waits for it.
  f.ledger.deleteAccount(ACCOUNT.id, USER, { confirmed: true });
  assert.equal(f.ledger.expiryCredentialCurrent(notice), false);
  assert.equal(f.ledger.pushStillWaiting('account_expiry', notice), false);
});

test('the accounts page carries when the token came in and when it is expected to run out', async (t) => {
  const app = await consoleApp(t);
  const claude = (await accountsOf(app)).find(({ id }) => id === 't1')!;
  assert.ok(claude.credential_at !== null && !Number.isNaN(Date.parse(claude.credential_at!)), '账号页给出令牌进来的时刻');
  assert.equal(claude.expected_expiry, expectedExpiry(claude.credential_at!, claudeAdapter.credentialLifetimeDays));
  assert.equal(claudeAdapter.credentialLifetimeDays, LIFETIME, '适配器声明大约一年');

  // An executor whose lifetime nothing declares: no estimate, whatever the moment says.
  app.f.ledger.putAccount({ id: 'own', name: 'own', executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m\n' } } }, USER, 'ref-own');
  app.f.force(`UPDATE account SET credential_at = ? WHERE id = 'own'`, CAME_IN);
  const own = (await accountsOf(app)).find(({ id }) => id === 'own')!;
  assert.equal(own.credential_at, CAME_IN);
  assert.equal(own.expected_expiry, null, '没声明的执行器没有预计到期');
});

test('29 → 30 leaves the moment of an existing credential unknown, does not guess it, and drops dangling project logins', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-credential-at-'));
  const path = join(dir, 'ledger.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL('./fixtures/ledger/schema-v29.sql', import.meta.url), 'utf8'));
  old.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '29');
    INSERT INTO account (id, name, created_at, updated_at, executor, tiers_json, credential_ref) VALUES ('kept', 'kept', 'now', 'now', 'claude', '{"execute":{"kind":"content","text":"m"}}', 'ref');
    INSERT INTO project (id, created_at, name, logins_json) VALUES ('p', 'now', 'p', '["kept","gone"]');
    INSERT INTO project (id, created_at, name, logins_json) VALUES ('q', 'now', 'q', '["gone"]');
    INSERT INTO project (id, created_at, name, logins_json) VALUES ('r', 'now', 'r', '["kept","old-acc","old-own"]');
    -- What the two removed logins went by, as their deletions recorded it.
    INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES ('c1', 'now', 'now', 'user', 'account.delete', '{"account_id":"old-acc","account":{"name":"旧账号"}}');
    INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES ('c2', 'now', 'now', 'user', 'machine_login.delete', '{"login_id":"old-own","login_name":"h9/codex"}');`);
  old.close();
  // The recorded schema is a real version 29 ledger, not merely a file claiming to be one.
  assert.equal(verifySnapshot(path).get('schema_version'), '29');
  const ledger = openLedger(path, { log: () => {} });
  try {
    assert.equal(ledger.accountCredentialAt('kept'), null, '旧账号不知道令牌哪天进来的');
    // A deletion before this version left the reference behind; the step drops it and says so,
    // while the logins that still exist are left alone.
    assert.deepEqual(JSON.parse(ledger.getProject('p').logins_json), ['kept']);
    assert.deepEqual(JSON.parse(ledger.getProject('q').logins_json), []);
    // Its token is not stored again, so nothing is reminded about.
    ledger.setChannels(['console', 'wecom']);
    ledger.expiryReminders(new Date('2099-01-01T00:00:00.000Z'));
    assert.equal(noticesIn(path).length, 0, '不知道时刻就不推，不拿审计时间补');
    // A token stored now is a moment this version knows.
    ledger.recordAccountCredential('kept', 'ref-two', USER);
    assert.ok(ledger.accountCredentialAt('kept') !== null);
  } finally {
    ledger.close();
  }
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = (after.prepare(`SELECT detail_json FROM change WHERE action = 'project.update' ORDER BY seq`).all() as { detail_json: string }[])
      .map((row) => JSON.parse(row.detail_json) as Record<string, unknown>);
    assert.deepEqual(rows, [
      { project_id: 'p', logins: { from: ['kept', 'gone'], to: ['kept'] }, logins_removed: ['已删除的登录'], reason: '升级时清掉项目允许清单里已经不存在的登录' },
      { project_id: 'q', logins: { from: ['gone'], to: [] }, logins_removed: ['已删除的登录'], reason: '升级时清掉项目允许清单里已经不存在的登录' },
      // The name each removed login went by comes from the change that removed it, never the
      // internal number and never a kind guessed from it.
      { project_id: 'r', logins: { from: ['kept', 'old-acc', 'old-own'], to: ['kept'] }, logins_removed: ['旧账号', 'h9/codex'], reason: '升级时清掉项目允许清单里已经不存在的登录' },
    ]);
  } finally {
    after.close();
  }
});

async function accountsOf(app: Awaited<ReturnType<typeof consoleApp>>): Promise<{ id: string; credential_at: string | null; expected_expiry: string | null }[]> {
  const response = await app.get('/api/accounts');
  assert.equal(response.status, 200);
  return ((await response.json()) as { accounts: { id: string; credential_at: string | null; expected_expiry: string | null }[] }).accounts;
}
