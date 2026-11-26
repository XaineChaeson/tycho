// Guards the one rule that decides a new account's name (docs/design/native-login.md §2):
// a name an owner has to invent before an account can exist; a default made of an id nobody
// reads as a name (the organization a Claude login reports), or one that is refused because a
// name is already held; a rule that lives outside the transaction that writes the row, so two
// creations can choose the same one; and a deletion that leaves the login named in the projects that allowed it, or that does not say
// which projects it was removed from and what each has left.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import { accountNameProblem } from '../shared/logins.ts';
import { claudeTier, fixture, USER } from './helpers.ts';
import { consoleApp } from './console-helpers.ts';

const tiers = { execute: claudeTier('m') };

test('a new account\'s default name is the executor\'s, and a clash is numbered', (t) => {
  const f = fixture(t);
  const make = (id: string) => f.ledger.putAccount({ id, executor: 'claude', tiers }, USER, `ref-${id}`);

  make('a1');
  assert.equal(f.ledger.getAccount('a1')!.name, 'claude 账号', '用执行器的名字');
  // A clash is numbered, never refused: a name is display, and the id is the reference.
  make('a2');
  assert.equal(f.ledger.getAccount('a2')!.name, 'claude 账号 2');
  // The login's organization is kept beside the account, never made its name.
  f.ledger.noteIdentity('a2', { organizationId: '3f6982b1-cb66-4a3c-95d1-5325e8e544a5' });
  assert.equal(f.ledger.getAccount('a2')!.name, 'claude 账号 2', '组织标识不是名字');
  assert.deepEqual(f.ledger.loginState('a2').identity, { organizationId: '3f6982b1-cb66-4a3c-95d1-5325e8e544a5' });
  assert.equal(f.ledger.getAccount('a1')!.name, 'claude 账号', '起默认名不改别的账号');

  // The preview the login window reads is the same rule, and writes nothing.
  const before = f.ledger.listAccounts().length;
  assert.equal(f.ledger.defaultAccountName('claude'), 'claude 账号 3');
  assert.equal(f.ledger.listAccounts().length, before, '只是读：不建账号');

  // A name the owner wrote is the base, numbered the same way.
  f.ledger.putAccount({ id: 'a7', name: 'claude 账号', executor: 'claude', tiers }, USER, 'ref-a7');
  assert.equal(f.ledger.getAccount('a7')!.name, 'claude 账号 3');
  // Every default name the ledger can produce passes the one shape check an owner's save
  // goes through: none of them locks the account out of the console's edit form.
  for (const account of f.ledger.listAccounts()) assert.equal(accountNameProblem(account.name), null, account.name);
  // A rename is still refused for a name already held: that is the owner's word, not a default.
  assert.throws(() => f.ledger.renameAccount('a7', 'claude 账号', USER), (err: Error) => err instanceof InputError && /重名/.test(err.message));
});

test('an identity an older program kept beyond the organization is read as the organization alone', (t) => {
  const f = fixture(t);
  f.ledger.putAccount({ id: 'old', executor: 'claude', tiers }, USER, 'ref-old');
  f.ledger.noteIdentity('old', { organizationId: 'org-a' });
  f.force('UPDATE login_state SET identity_json = ? WHERE id = ?', '{"organizationId":"org-a","email":"me@example.test"}', 'old');
  assert.deepEqual(f.ledger.loginState('old').identity, { organizationId: 'org-a' });
  f.ledger.noteIdentity('old', { organizationId: 'org-a' });
  assert.deepEqual(JSON.parse(f.peek<{ identity_json: string }>('SELECT identity_json FROM login_state WHERE id = ?', 'old')[0]!.identity_json), { organizationId: 'org-a' });
});

test('an account the ledger named can be saved with the console\'s full form, original name included', async (t) => {
  const app = await consoleApp(t);
  const f = app.f;
  f.ledger.putAccount({ id: 'd1', executor: 'claude', tiers }, USER, 'ref-d1');
  f.ledger.putAccount({ id: 'd2', executor: 'claude', tiers }, USER, 'ref-d2');
  f.ledger.putAccount({ id: 'd3', executor: 'claude', tiers }, USER, 'ref-d3');
  assert.deepEqual(['d1', 'd2', 'd3'].map((id) => f.ledger.getAccount(id)!.name), ['claude 账号', 'claude 账号 2', 'claude 账号 3']);
  for (const id of ['d1', 'd2', 'd3']) {
    const held = f.ledger.getAccount(id)!;
    // The console sends the whole form, its name included, when the owner edits tiers.
    const saved = await app.send('PUT', `/api/accounts/${id}`, {
      name: held.name, executor: held.executor,
      tiers: held.tiers, permission_mode: held.permissionMode ?? null, timeout_ms: held.timeoutMs ?? null, max_runs: held.maxRuns ?? null,
    });
    assert.equal(saved.status, 200, `${held.name}：${await saved.clone().text()}`);
  }
});

test('deleting an account takes it out of every project that allowed it, and says what each has left', (t) => {
  const f = fixture(t);
  f.ledger.putAccount({ id: 't1', name: 't1', executor: 'claude', tiers }, USER, 'ref-t1');
  f.ledger.putAccount({ id: 't2', name: 't2', executor: 'claude', tiers }, USER, 'ref-t2');
  f.ledger.putMachineLogin({ executor: 'claude', machine: 'h1', tiers }, USER);
  const ownId = f.ledger.getMachineLogin('h1', 'claude')!.id;
  const only = f.ledger.createProject({ name: '只有一个', logins: ['t1'] }, USER);
  const two = f.ledger.createProject({ name: '有两个', logins: ['t1', 't2'] }, USER);
  const withOwn = f.ledger.createProject({ name: '还有机器的登录', logins: ['t1', ownId] }, USER);
  const listed = (id: string): string[] => JSON.parse(f.peek<{ logins_json: string }>('SELECT logins_json FROM project WHERE id = ?', id)[0]!.logins_json) as string[];

  const { projects } = f.ledger.deleteAccount('t1', USER, { confirmed: true });
  assert.deepEqual(projects, [
    { id: only, name: '只有一个', remaining: 0 },
    { id: two, name: '有两个', remaining: 1 },
    { id: withOwn, name: '还有机器的登录', remaining: 1 },
  ]);
  for (const id of [only, two, withOwn]) assert.ok(!listed(id).includes('t1'), `项目 ${id} 的清单里去掉了它`);
  assert.deepEqual(listed(two), ['t2'], '别的登录留着');
  // Each affected project records it in its own timeline, by the name the login went by.
  const audits = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'project.update' ORDER BY seq`)
    .map((row) => JSON.parse(row.detail_json) as { project_id: string; login_removed?: string; reason?: string })
    .filter((detail) => detail.login_removed !== undefined);
  assert.deepEqual(audits.map(({ project_id, login_removed }) => [project_id, login_removed]), [[only, 't1'], [two, 't1'], [withOwn, 't1']]);
  assert.match(String(audits[0]!.reason), /登录 t1 被删掉/);
  // The deletion itself records what projects it was removed from.
  const deleted = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'account.delete'`)[0]!;
  assert.deepEqual((JSON.parse(deleted.detail_json) as { projects: string[] }).projects, ['只有一个', '有两个', '还有机器的登录']);
});

test('deleting a machine\'s own login takes it out of the projects too', (t) => {
  const f = fixture(t);
  f.ledger.putAccount({ id: 't1', name: 't1', executor: 'claude', tiers }, USER, 'ref-t1');
  f.ledger.putMachineLogin({ executor: 'codex', machine: 'h1', tiers: { execute: { kind: 'content', text: 'model=m\n' } } }, USER);
  const ownId = f.ledger.getMachineLogin('h1', 'codex')!.id;
  const project = f.ledger.createProject({ name: '用它', logins: [ownId, 't1'] }, USER);
  const { projects } = f.ledger.deleteMachineLogin('h1', 'codex', USER);
  assert.deepEqual(projects, [{ id: project, name: '用它', remaining: 1 }]);
  assert.deepEqual(JSON.parse(f.peek<{ logins_json: string }>('SELECT logins_json FROM project WHERE id = ?', project)[0]!.logins_json), ['t1']);
  const gone = f.ledger.deletedAccountName(ownId);
  assert.equal(gone, 'h1/codex', '删掉的那份登录按它当时叫的名字被记住');
});

test('a project allowing every login counts that pool, not its stale list, when a login is deleted', (t) => {
  const f = fixture(t, {}, false);
  f.ledger.putAccount({ id: 't1', name: 't1', executor: 'claude', tiers }, USER, 'ref-t1');
  f.ledger.putAccount({ id: 't2', name: 't2', executor: 'claude', tiers }, USER, 'ref-t2');
  // The list still names t1, but the project dispatches on every login: t2 remains after t1
  // goes. Counting the list would say 0 and claim the project has nowhere to run.
  const project = f.ledger.createProject({ name: '全部登录', logins: ['t1'], loginMode: 'all' }, USER);
  const { projects } = f.ledger.deleteAccount('t1', USER);
  assert.deepEqual(projects, [{ id: project, name: '全部登录', remaining: 1 }]);
  assert.deepEqual(JSON.parse(f.peek<{ logins_json: string }>('SELECT logins_json FROM project WHERE id = ?', project)[0]!.logins_json), [], '清单照旧去掉它');
});
