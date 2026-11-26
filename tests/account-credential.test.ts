// Guards the shape that keeps the ledger and the token files from disagreeing: one file
// per number the ledger names, the ledger's commit as the only point a token takes
// effect, best-effort deletion of what nobody names, orphan cleanup at a start, and the
// two words the page shows. Each test here is one way the older, account-named layout
// could use, overwrite or lose another account's token. And an account is a login tycho
// keeps (docs/design/accounts-machines-decoupled.md): it is never left without a token —
// not by clearing it, and not by moving it to another executor.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { createAccounts } from '../service/accounts.ts';
import { credentialRejected } from '../service/ledger.ts';
import { accountCredentialFile, accountsSecretDir, readSecret } from '../service/secrets.ts';
import { fixture, MACHINE, USER, RUN_LIMIT_MS, holdMachine } from './helpers.ts';

const TOKEN = 'private-account-token-78a';
const AT = '2026-11-01T00:00:00.000Z';
class Crash extends Error {}
const FIRST = 'first-private-token';
const settings = { executor: 'claude', tiers: { execute: { kind: 'content', text: '{"model":"m"}' } } };
// What an account is made with: its token.
const input = { ...settings, credential: FIRST };
const setup = (t: Parameters<typeof fixture>[0]) => {
  const f = fixture(t, {}, false);
  const accounts = createAccounts({ ledger: f.ledger, executors: { claude: claudeAdapter, codex: codexAdapter }, credentialExecutors: ['claude'], dataDir: f.dir, log: () => {} });
  const { account: { id: oneId } } = accounts.put({ name: 'one', ...input }, USER);
  return { f, accounts, oneId };
};
const refOf = (f: ReturnType<typeof fixture>, id: string): string =>
  f.peek<{ credential_ref: string }>('SELECT credential_ref FROM account WHERE id = ?', id)[0]!.credential_ref;
const markRejected = (f: ReturnType<typeof fixture>, id: string, ref: string): void =>
  f.force("INSERT INTO login_state (id, created_at, credential_rejected_ref) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET credential_rejected_ref = excluded.credential_rejected_ref", id, AT, ref);
const credentialActions = (f: ReturnType<typeof fixture>): string[] =>
  f.peek<{ action: string }>("SELECT action FROM change WHERE action LIKE 'account.credential%' ORDER BY seq").map(row => row.action);

test('a token is a file the ledger names by number: write only, and gone once replaced or deleted', (t) => {
  const { f, accounts, oneId } = setup(t);
  const first = refOf(f, oneId);
  assert.equal(readSecret(accountCredentialFile(f.dir, first)), FIRST, '建账号时填的令牌就在它自己的文件里');
  assert.equal(accounts.get(oneId)!.credential, 'set');
  accounts.setCredential(oneId, TOKEN, USER);
  const ref = refOf(f, oneId);
  const file = accountCredentialFile(f.dir, ref);
  assert.equal(readSecret(file), TOKEN);
  assert.equal(existsSync(accountCredentialFile(f.dir, first)), false, '换下来的那个文件删掉');
  assert.ok(!file.includes('one'), '文件名不来自账号名');
  assert.equal(accounts.get(oneId)!.credential, 'set');
  assert.ok(!JSON.stringify({ rows: f.dump(), accounts: accounts.list() }).includes(TOKEN));
  assert.deepEqual(credentialActions(f), ['account.credential_set']);
  assert.equal('clearCredential' in accounts, false, '没有清掉令牌这回事：没有登录的账号不是账号');
  accounts.setCredential(oneId, TOKEN, USER);
  const again = refOf(f, oneId);
  assert.notEqual(again, ref, '每填一次一个新编号');
  accounts.remove(oneId, USER);
  assert.equal(existsSync(accountCredentialFile(f.dir, again)), false);
});

test('an executor whose login tycho cannot keep, and whitespace or oversized tokens, are refused without storing anything', (t) => {
  const { f, accounts, oneId } = setup(t);
  const ref = refOf(f, oneId);
  const dir = join(f.dir, 'secrets', 'accounts');
  const files = readdirSync(dir);
  assert.throws(() => accounts.put({ ...({ ...input, executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m' } } }), name: 'codex' }, USER), /只能是机器自己的登录/);
  assert.equal(f.ledger.getAccount('codex'), undefined);
  for (const value of ['', ' token', 'token ', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(501)]) {
    assert.throws(() => accounts.setCredential(oneId, value, USER));
  }
  assert.equal(refOf(f, oneId), ref);
  assert.deepEqual(readdirSync(dir), files, '一个字节都没写');
});

test('startup removes files no account names, including drafts of the older layout', (t) => {
  const { f, accounts, oneId } = setup(t);
  accounts.setCredential(oneId, TOKEN, USER);
  const ref = refOf(f, oneId);
  const file = accountCredentialFile(f.dir, ref);
  const dir = join(f.dir, 'secrets', 'accounts');
  for (const name of ['gone', 'one.new', 'one']) writeFileSync(join(dir, name), 'orphan');
  accounts.cleanCredentials();
  assert.equal(readFileSync(file, 'utf8').trim(), TOKEN, '在用的文件不动');
  for (const name of ['gone', 'one.new', 'one']) assert.equal(existsSync(join(dir, name)), false, name);
});

for (const point of ['beforeCommit', 'afterCommit'] as const) test('replacing a rejected token, crashing at ' + point + ' keeps exactly what the ledger says', (t) => {
  let armed = false;
  const f = fixture(t, { testHooks: {
    ...(point === 'beforeCommit'
      ? { beforeCommit(actions: string[]) { if (armed && actions.includes('account.credential_set')) throw new Crash(); } }
      : { afterCommit(actions: string[], retire: () => void) { if (armed && actions.includes('account.credential_set')) { retire(); throw new Crash(); } } }),
  } }, false);
  const make = (ledger: typeof f.ledger) => createAccounts({ ledger, executors: { claude: claudeAdapter }, credentialExecutors: ['claude'], dataDir: f.dir, log: () => {} });
  const accounts = make(f.ledger);
  const { account: { id: oneId } } = accounts.put({ name: 'one', ...settings, credential: TOKEN }, USER);
  const oldRef = refOf(f, oneId);
  const oldFile = accountCredentialFile(f.dir, oldRef);
  markRejected(f, oneId, oldRef);
  assert.equal(accounts.get(oneId)!.credential, 'rejected');
  armed = true;
  assert.throws(() => accounts.setCredential(oneId, 'replacement-private-token', USER), Crash);
  armed = false;
  const inserted = readdirSync(join(f.dir, 'secrets', 'accounts')).filter((name) => name !== oldRef);
  const restarted = make(f.open());
  restarted.cleanCredentials();
  if (point === 'beforeCommit') {
    assert.equal(refOf(f, oneId), oldRef, '没提交的编号不作数');
    assert.equal(readSecret(oldFile), TOKEN);
    assert.equal(restarted.get(oneId)!.credential, 'rejected', '旧令牌仍然失效着，不能放行');
  } else {
    const newRef = refOf(f, oneId);
    assert.notEqual(newRef, oldRef);
    assert.deepEqual(inserted, [newRef], '提交后生效的就是刚写下的那个文件');
    assert.equal(readSecret(accountCredentialFile(f.dir, newRef)), 'replacement-private-token');
    assert.equal(restarted.get(oneId)!.credential, 'set', '换掉之后旧失效标记自然过期');
    assert.equal(existsSync(oldFile), false, '旧文件在提交之后删掉');
  }
  assert.ok(!JSON.stringify(f.dump()).includes('replacement-private-token'));
});

test('replacing a token moves the account to the new one even when the old file cannot be removed', (t) => {
  const logs: string[] = [];
  const f = fixture(t, {}, false);
  const accounts = createAccounts({ ledger: f.ledger, executors: { claude: claudeAdapter }, credentialExecutors: ['claude'], dataDir: f.dir, log: (line) => logs.push(line) });
  const { account: { id: oneId } } = accounts.put({ name: 'one', ...settings, credential: TOKEN }, USER);
  const ref = refOf(f, oneId);
  const file = accountCredentialFile(f.dir, ref);
  // Something that cannot be removed as a file: deletion can only fail.
  rmSync(file);
  mkdirSync(file);
  accounts.setCredential(oneId, 'next-private-token', USER);
  const next = refOf(f, oneId);
  assert.notEqual(next, ref);
  assert.deepEqual(accounts.credentialOf(oneId), { ref: next, value: 'next-private-token' });
  assert.ok(logs.some((line) => line.includes('没删掉')), '删不掉只记日志');
  // A Run made now carries the new number, whatever is still on disk.
  holdMachine(f.ledger, MACHINE, USER);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, { login: f.ledger.getAccount(oneId)!, machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'claude' }, expectedRevision: task.revision }, USER);
  assert.equal(JSON.parse(run.snapshot_json).credential_ref, next);
  rmSync(file, { recursive: true, force: true });
});

test('account names differing only in case own separate tokens', (t) => {
  const { f, accounts, oneId } = setup(t);
  const { account: { id: upperId } } = accounts.put({ ...({ ...settings, credential: 'another-private-token' }), name: 'ONE' }, USER);
  accounts.setCredential(oneId, TOKEN, USER);
  const lower = refOf(f, oneId);
  const upper = refOf(f, upperId);
  assert.notEqual(lower, upper);
  assert.equal(readSecret(accountCredentialFile(f.dir, lower)), TOKEN);
  assert.equal(readSecret(accountCredentialFile(f.dir, upper)), 'another-private-token');
  assert.equal(accounts.get(oneId)!.credential, 'set');
  assert.equal(accounts.get(upperId)!.credential, 'set');
  accounts.setCredential(upperId, 'third-private-token', USER);
  assert.equal(readSecret(accountCredentialFile(f.dir, lower)), TOKEN, '换一个不动另一个');
  assert.equal(accounts.get(oneId)!.credential, 'set');
  accounts.remove(upperId, USER);
  assert.equal(readSecret(accountCredentialFile(f.dir, lower)), TOKEN, '删一个不动另一个');
});

test("reading a token goes by the ledger alone: a file the account's number does not name is not its token", (t) => {
  const { f, accounts, oneId } = setup(t);
  // The pair Windows cannot tell apart by file name. The ledger's number, and not the
  // account's name, is what says whose a file is: an account whose own file is gone hands
  // out no token however another account is spelled. Written straight where the store
  // keeps one, since what is under test is the reading side.
  const { account: { id: upperId } } = accounts.put({ ...({ ...settings, credential: 'upper-private-token' }), name: 'ONE' }, USER);
  rmSync(accountCredentialFile(f.dir, refOf(f, upperId)));
  const ref = 'ref-0000-0000-0000-00000000000a';
  mkdirSync(accountsSecretDir(f.dir), { recursive: true });
  writeFileSync(accountCredentialFile(f.dir, ref), `${TOKEN}\n`);
  f.ledger.recordAccountCredential(oneId, ref, USER);
  assert.equal(accounts.get(oneId)!.credential, 'set');
  assert.deepEqual(accounts.credentialOf(oneId), { ref, value: TOKEN });
  assert.equal(accounts.credentialOf(upperId), undefined, '另一个账号自己的文件没了，读出来的就是没有');
  assert.equal(accounts.credentialOf('One'), undefined, '没有这个账号');
  // A number the ledger still names, whose file is gone: nothing to hand out, and still
  // not the other account's.
  rmSync(accountCredentialFile(f.dir, ref));
  assert.equal(accounts.get(oneId)!.credential, 'missing');
  assert.equal(accounts.credentialOf(oneId), undefined);
  assert.equal(accounts.credentialOf(upperId), undefined);
});

test('a token file is never named by the account, so any account name works', (t) => {
  const { f, accounts, oneId } = setup(t);
  for (const name of ['C:x', 'old.new', 'CON', '集群-claude']) {
    const { account: { id } } = accounts.put({ ...settings, credential: TOKEN, name }, USER);
    const ref = refOf(f, id);
    assert.equal(readSecret(accountCredentialFile(f.dir, ref)), TOKEN, id);
    assert.ok(!accountCredentialFile(f.dir, ref).includes(name), name);
  }
});

test('changing the executor takes a new token in the same write and drops the old one\'s file', (t) => {
  const f = fixture(t, {}, false);
  const accounts = createAccounts({ ledger: f.ledger, executors: { claude: claudeAdapter, other: { ...claudeAdapter } }, credentialExecutors: ['claude', 'other'], dataDir: f.dir, log: () => {} });
  const { account: { id: oneId } } = accounts.put({ name: 'one', ...settings, credential: TOKEN }, USER);
  const ref = refOf(f, oneId);
  const file = accountCredentialFile(f.dir, ref);
  markRejected(f, oneId, ref);
  assert.equal(accounts.get(oneId)!.credential, 'rejected');
  // Without a token for the new executor nothing changes.
  assert.throws(() => accounts.put({ id: oneId, name: 'one', ...({ ...settings, executor: 'other' }) }, USER), /换执行器要同时填新执行器的登录令牌/);
  assert.equal(refOf(f, oneId), ref);
  assert.equal(f.ledger.getAccount(oneId)!.executor, 'claude');
  const { account } = accounts.put({ id: oneId, name: 'one', ...({ ...settings, executor: 'other', credential: 'other-private-token' }) }, USER);
  assert.equal(account.credential, 'set', '新令牌，旧的失效标记不算数');
  assert.notEqual(refOf(f, oneId), ref);
  assert.equal(accounts.credentialOf(oneId)!.value, 'other-private-token');
  assert.equal(existsSync(file), false);
});

test('a file removed by hand names nothing: the account reports a missing credential and hands out no token', (t) => {
  const { f, accounts, oneId } = setup(t);
  accounts.setCredential(oneId, TOKEN, USER);
  const ref = refOf(f, oneId);
  rmSync(accountCredentialFile(f.dir, ref));
  assert.equal(accounts.get(oneId)!.credential, 'missing');
  assert.equal(accounts.credentialOf(oneId), undefined, '编号还在，文件没了，就没有令牌可用');
});

test('a token that lands in an unremovable file is still nobody\'s after the account is deleted', (t) => {
  const { f, accounts, oneId } = setup(t);
  accounts.setCredential(oneId, TOKEN, USER);
  const ref = refOf(f, oneId);
  accounts.remove(oneId, USER);
  assert.equal(f.ledger.getAccount(oneId), undefined);
  assert.equal(existsSync(accountCredentialFile(f.dir, ref)), false);
  // As at a start: a file no account names is removed even if the removal it wanted failed.
  writeFileSync(accountCredentialFile(f.dir, ref), 'left behind');
  accounts.cleanCredentials();
  assert.equal(existsSync(accountCredentialFile(f.dir, ref)), false);
});
