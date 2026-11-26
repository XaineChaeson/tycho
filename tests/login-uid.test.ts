// Guards references against a rename, account name reuse, and machine re-registration.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { createAccounts } from '../service/accounts.ts';
import { createLogins } from '../service/logins.ts';
import { ulid } from '../service/ids.ts';
import { routerMaterial } from '../service/router-material.ts';
import { fixture, USER, content, testMachine, holdMachine } from './helpers.ts';

test('ledger references, learned state and historical names stay on their ids through rename and name reuse', (t) => {
  const f = fixture(t, {}, false);
  const input = { id: ulid(), name: 'alice', executor: 'claude', tiers: { execute: content('{}') } };
  f.ledger.putAccount(input, USER, 'credential-ref');
  holdMachine(f.ledger, testMachine('m'));
  f.ledger.setProjectLogins(f.projectId, [input.id], USER);
  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title: 'task', goal: 'do', acceptance: 'done', loginId: input.id }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { login: input, machine: f.ledger.getMachine('m')!, expectedRevision: 1, snapshot: { tier: 'execute', timeout_ms: 1000 } }, USER);
  f.ledger.noteIdentity(input.id, { organizationId: 'org' });
  f.ledger.noteUsage(input.id, [{ window: 'week', used: 0.7, resetsAt: null }]);
  const accounts = createAccounts({ ledger: f.ledger, executors: ADAPTERS });
  accounts.put({ ...input, name: 'bob' }, USER);
  assert.equal(accounts.get(input.id)!.name, 'bob');
  assert.equal(f.ledger.getTask(task.id).login_id, input.id);
  assert.equal(f.ledger.getRun(run.id).login_id, input.id);
  assert.equal(f.ledger.getRun(run.id).login_name, 'alice');
  assert.equal(f.ledger.accountCredentialRef(input.id), 'credential-ref');
  assert.equal(f.ledger.loginState(input.id).usage[0]!.used, 0.7);
  assert.deepEqual(f.ledger.loginState(input.id).identity, { organizationId: 'org' });
  const logins = createLogins({ ledger: f.ledger, accounts, executors: ADAPTERS });
  assert.equal(logins.get('bob'), undefined);
  assert.equal(logins.list().find(({ name }) => name === 'alice'), undefined);
  assert.equal(logins.list().find(({ name }) => name === 'bob')!.id, input.id);
  const other = { ...input, id: ulid(), name: 'other' };
  f.ledger.putAccount(other, USER, 'another-ref');
  assert.throws(() => accounts.put({ ...other, name: 'bob' }, USER), /重名/);
  f.ledger.deleteAccount(input.id, USER, { confirmed: true });
  f.ledger.putAccount({ ...input, id: ulid(), name: 'bob' }, USER, 'new-ref');
  assert.deepEqual(f.ledger.loginPool(f.ledger.getTask(task.id)).ids, []);
  assert.deepEqual(f.ledger.loginState(input.id).identity, {});
  assert.equal(f.ledger.getRun(run.id).login_name, 'alice');
  assert.equal(f.ledger.loginWasDeleted(input.id), true);
});

test('account rename preserves references and credentials; reusing its name inherits nothing', (t) => {
  const f = fixture(t, {}, false);
  const accounts = createAccounts({ ledger: f.ledger, executors: ADAPTERS, credentialExecutors: ['claude'], dataDir: f.dir });
  const input = { executor: 'claude', tiers: { execute: content('{}') }, credential: 'fake-token' };
  const first = accounts.put({ ...input, name: 'alice' }, USER).account;
  assert.match(first.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(first.name, 'alice');
  f.ledger.setProjectLogins(f.projectId, [first.id], USER);
  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title: 'task', goal: 'do', acceptance: 'done', loginId: first.id }, USER);
  const credential = f.ledger.accountCredentialRef(first.id);
  accounts.put({ ...input, id: first.id, name: 'bob', credential: undefined }, USER);
  assert.equal(accounts.get(first.id)!.name, 'bob');
  assert.equal(f.ledger.accountCredentialRef(first.id), credential);
  assert.equal(f.ledger.getTask(task.id)!.login_id, first.id);
  const logins = createLogins({ ledger: f.ledger, accounts, executors: ADAPTERS });
  assert.equal(logins.list().find(({ name }) => name === 'bob')!.id, first.id);
  assert.equal(logins.list().find(({ name }) => name === 'alice'), undefined);
  assert.equal(logins.get('bob'), undefined, 'internal lookups never accept names');
  const other = accounts.put({ ...input, name: 'alice' }, USER).account;
  assert.throws(() => accounts.put({ ...input, id: other.id, name: 'bob' }, USER), /重名|已经存在|已存在/);
  accounts.remove(first.id, USER, { confirmed: true });
  const again = accounts.put({ ...input, name: 'bob' }, USER).account;
  assert.notEqual(again.id, first.id);
  assert.equal(f.ledger.getTask(task.id)!.login_id, first.id);
  assert.deepEqual(f.ledger.loginPool(f.ledger.getTask(task.id)!).ids, []);
});

test('machine login ids survive settings changes and never survive deletion and re-registration', (t) => {
  const f = fixture(t, {}, false);
  holdMachine(f.ledger, testMachine('m'));
  const input = { machine: 'm', executor: 'codex', tiers: { execute: content('model="x"') } };
  f.ledger.putMachineLogin(input, USER);
  const first = f.ledger.getMachineLogin('m', 'codex')!;
  assert.match(first.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  f.ledger.putMachineLogin({ ...input, maxRuns: 2 }, USER);
  assert.equal(f.ledger.getMachineLogin('m', 'codex')!.id, first.id);
  f.ledger.setProjectLogins(f.projectId, [first.id], USER);
  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title: 'task', goal: 'do', acceptance: 'done', loginId: first.id }, USER);
  f.ledger.deleteMachine('m', USER);
  holdMachine(f.ledger, { ...testMachine('m'), nodeId: 'replacement' });
  f.ledger.putMachineLogin(input, USER);
  assert.notEqual(f.ledger.getMachineLogin('m', 'codex')!.id, first.id);
  assert.equal(f.ledger.getTask(task.id)!.login_id, first.id);
  assert.deepEqual(f.ledger.loginPool(f.ledger.getTask(task.id)!).ids, []);
});

test('renaming preserves even retired tier bytes and does not require repairing unrelated configuration', (t) => {
  const f = fixture(t, {}, false);
  const id = ulid();
  f.ledger.putAccount({ id, name: 'old', executor: 'claude', tiers: { execute: content('{}') } }, USER, 'ref');
  const retired = '{"execute":{"kind":"file","value":"old-profile"}}';
  f.force('UPDATE account SET tiers_json = ? WHERE id = ?', retired, id);
  const accounts = createAccounts({ ledger: f.ledger, executors: ADAPTERS });
  accounts.put({ id, name: 'renamed' }, USER);
  assert.equal(accounts.get(id)!.name, 'renamed');
  assert.equal(f.peek<{ tiers_json: string }>('SELECT tiers_json FROM account WHERE id = ?', id)[0]!.tiers_json, retired);
});

test('a remote registration reusing the local machine name cannot become the Router host login', (t) => {
  const f = fixture(t, {}, false);
  f.ledger.joinMachine({ id: 'local', host: 'pc', nodeId: 'first', tokenHash: 'token', platform: 'test', source: null, ephemeral: false, local: true }, USER);
  assert.equal(f.ledger.hostMachine(), 'local');
  f.ledger.deleteMachine('local', USER);
  holdMachine(f.ledger, testMachine('local'));
  assert.equal(f.ledger.hostMachine(), undefined);
});

test('Router recovery material speaks current login names, including after an account rename', (t) => {
  const f = fixture(t, {}, false);
  const login = { id: ulid(), name: 'alice', executor: 'claude', tiers: { execute: content('{}') } };
  f.ledger.putAccount(login, USER, 'ref');
  holdMachine(f.ledger, testMachine('m'));
  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title: 'task', goal: 'do', acceptance: 'done', loginId: login.id }, USER);
  f.ledger.queueTask(task.id, USER);
  f.ledger.createRun(task.id, { login, machine: f.ledger.getMachine('m')!, expectedRevision: 1, snapshot: { tier: 'execute', timeout_ms: 1000 } }, USER);
  f.ledger.renameAccount(login.id, 'bob', USER);
  const material = routerMaterial(f.ledger, f.projectId, 100_000).text;
  assert.equal(material.includes(login.id), false);
  assert.equal((material.match(/"login_id":"bob"/g) ?? []).length, 2);
});

test('a login deleted while preparing a round is refused by its known name', (t) => {
  const f = fixture(t, {}, false);
  const login = { id: ulid(), name: '已知名字', executor: 'claude', tiers: { execute: content('{}') } };
  f.ledger.putAccount(login, USER, 'ref');
  holdMachine(f.ledger, testMachine('m'));
  f.ledger.setProjectLogins(f.projectId, [login.id], USER);
  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title: '任务', goal: '目标', acceptance: '验收' }, USER);
  f.ledger.queueTask(task.id, USER);
  f.ledger.deleteAccount(login.id, USER, { confirmed: true });
  assert.throws(() => f.ledger.createRun(task.id, { login, machine: f.ledger.getMachine('m')!, expectedRevision: task.revision, snapshot: {} }, USER), /账号 已知名字 已经不在了/);
});
