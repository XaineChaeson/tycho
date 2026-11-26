import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { createLogins } from '../service/logins.ts';
import { createTools } from '../service/tools.ts';
import { createAccounts } from '../service/accounts.ts';
import { createClaudeLogin } from '../service/claude-login.ts';
import { serviceSettings } from '../service/service-settings.ts';
import { consoleApp } from './console-helpers.ts';
import { accepting, claudeTier, codexTier, fixture, holdMachine, RUN_LIMIT_MS, testMachine, USER } from './helpers.ts';

test('router tools speak current login names while task references hold internal ids', async (t) => {
  const f = fixture(t);
  const id = '01LOGININTERNALNUMBER';
  f.ledger.putAccount({ id, name: '当前账号', executor: 'claude', tiers: { execute: claudeTier('test') } }, USER, 'ref');
  f.ledger.setProjectLogins(f.projectId, [id], USER);
  const logins = createLogins({ ledger: f.ledger, accounts: { get: f.ledger.getAccount, list: f.ledger.listAccounts }, executors: ADAPTERS });
  const tools = createTools({ ledger: f.ledger, logins, machines: { list: () => [] }, accept: accepting(f.ledger), runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} } });
  const here = { projectId: f.projectId };
  const listed = await tools.call('list_logins', {}, USER, here);
  assert.equal(JSON.parse(listed.content[0]!.text)[0].id, '当前账号');
  const create = await tools.call('create_task', { title: '任务', goal: '目标', acceptance: '验收', role_id: 'implement', login_id: '当前账号' }, USER, here);
  assert.equal(create.isError, undefined, create.content[0]!.text);
  const task = f.ledger.listTasks({ projectId: f.projectId }).find(({ title }) => title === '任务')!;
  assert.equal(task.login_id, id);
  f.ledger.putAccount({ ...f.ledger.getAccount(id)!, name: '改名以后' }, USER);
  const shown = await tools.call('get_task', { task_id: task.id }, USER, here);
  assert.equal(JSON.parse(shown.content[0]!.text).task.login_id, '改名以后');
  const missing = await tools.call('create_task', { title: '旧名', goal: '目标', acceptance: '验收', role_id: 'implement', login_id: '当前账号' }, USER, here);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /改名以后/);
  const internal = await tools.call('create_task', { title: '内部编号', goal: '目标', acceptance: '验收', role_id: 'implement', login_id: id }, USER, here);
  assert.equal(internal.isError, true, '工具不另收内部编号');
  f.ledger.putMachineLogin({ machine: 'h1', executor: 'codex', tiers: { execute: { kind: 'content', text: 'model="test"' } } }, USER);
  const own = f.ledger.getMachineLogin('h1', 'codex')!;
  assert.notEqual(own.id, 'h1/codex');
  f.ledger.setProjectLogins(f.projectId, [id, own.id], USER);
  const placed = await tools.call('create_task', { title: '机器的登录', goal: '目标', acceptance: '验收', role_id: 'implement', login_id: 'h1/codex' }, USER, here);
  assert.equal(placed.isError, undefined, placed.content[0]!.text);
  assert.equal(f.ledger.listTasks({ projectId: f.projectId }).find(({ title }) => title === '机器的登录')!.login_id, own.id);
  const run = f.ledger.createRun(task.id, { login: f.ledger.getAccount(id)!, machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: task.revision }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 1, null, { kind: 'quota', quota: { message: '额度没了' } });
  const notice = f.ledger.listMessages({ projectId: f.projectId, limit: 20 }).find(({ channel, text }) => channel === 'internal' && text.includes(run.id))!;
  assert.equal(notice.text.includes(id), false, '负责人内部事件使用名字');
  assert.match(notice.text, /改名以后/);
  assert.ok(f.ledger.listChanges({ taskId: task.id }).some(({ detail_json }) => detail_json?.includes(id)), '审计仍记录编号');
  f.ledger.putAccount({ ...f.ledger.getAccount(id)!, name: '结算后又改名' }, USER);
  const quotaView = JSON.parse((await tools.call('get_task', { task_id: task.id }, USER, here)).content[0]!.text);
  assert.equal(quotaView.runs[0].error.quota.login_id, run.login_name, '历史额度显示优先使用Run名字快照');
  assert.equal(JSON.parse(f.ledger.getRun(run.id).error_json!).quota.login_id, id, '展示转换不改账本');
  f.ledger.deleteAccount(id, USER, { confirmed: true });
  const deletedView = JSON.parse((await tools.call('get_task', { task_id: task.id }, USER, here)).content[0]!.text);
  assert.equal(deletedView.runs[0].error.quota.login_id, run.login_name, '原登录不在时显示Run名字快照');
});

test('router account settings accept only an existing internal account id', (t) => {
  const f = fixture(t);
  f.ledger.putAccount({ id: 'internal', name: '显示名字', executor: 'claude', tiers: { execute: claudeTier('test') } }, USER, 'ref');
  const settings = serviceSettings({ ledger: f.ledger, dataDir: f.dir });
  assert.throws(() => settings.set('router.account', '显示名字', USER), /账号/);
  settings.set('router.account', 'internal', USER);
  assert.equal(settings.get('router.account'), 'internal');
});

test('account HTTP creates by name then renames by immutable id', async (t) => {
  const { send } = await consoleApp(t);
  // An account whose login the owner types in: the page cannot hand in one that tycho obtains
  // by a login session (docs/design/native-login.md §5).
  const created = await send('POST', '/api/accounts', { name: '可改名字', executor: 'codex', credential: 'test-token', tiers: { execute: codexTier('test') } });
  assert.equal(created.status, 201);
  const first = ((await created.json()) as { account: { id: string; name: string } }).account;
  assert.notEqual(first.id, first.name);
  assert.equal(first.name, '可改名字');
  const changed = await send('PUT', `/api/accounts/${first.id}`, { name: '已经改名' });
  assert.equal(changed.status, 200);
  assert.equal(((await changed.json()) as { account: { name: string } }).account.name, '已经改名');
  const byName = await send('PUT', '/api/accounts/已经改名', { name: '误按名字更新' });
  assert.equal(byName.status, 400);
});

test('HTTP login settings write, store and return ids while the login list supplies names', async (t) => {
  const { f, send, get } = await consoleApp(t);
  f.ledger.renameAccount('t1', '设置里的账号', USER);
  f.ledger.putMachineLogin({ machine: 'h1', executor: 'codex', tiers: { execute: { kind: 'content', text: 'model="test"' } } }, USER);
  const own = f.ledger.getMachineLogin('h1', 'codex')!;
  for (const [key, value, wrong] of [
    ['router.account', 't1', '设置里的账号'],
    ['knowledge.logins', [own.id, 't1'], [own.name, '设置里的账号']],
  ] as const) {
    assert.equal((await send('PUT', `/api/settings/${key}`, { value: wrong })).status, 400, `${key} rejects display names`);
    const response = await send('PUT', `/api/settings/${key}`, { value });
    assert.equal(response.status, 200);
    const result = await response.json() as { settings: { key: string; value: unknown }[] };
    assert.deepEqual(result.settings.find((entry) => entry.key === key)!.value, value);
    const tunables = JSON.parse(f.peek<{ value_json: string }>("SELECT value_json FROM setting WHERE key = 'tunables'")[0]!.value_json);
    assert.deepEqual(tunables[key], value);
  }
  const shown = await (await get('/api/accounts')).json() as { accounts: { id: string; name: string }[] };
  assert.equal(shown.accounts.find(({ id }) => id === 't1')!.name, '设置里的账号');
  const machines = await (await get('/api/machines')).json() as { machines: { logins: { id: string; name: string }[] }[] };
  assert.equal(machines.machines.flatMap(({ logins }) => logins).find(({ id }) => id === own.id)!.name, 'h1/codex');
  const settings = await (await get('/api/settings')).json() as { settings: { key: string; value: unknown }[] };
  assert.equal(settings.settings.find(({ key }) => key === 'router.account')!.value, 't1');
  assert.deepEqual(settings.settings.find(({ key }) => key === 'knowledge.logins')!.value, [own.id, 't1']);
});

test('machine HTTP distinguishes a fresh host from an unresolved migrated local registration', async (t) => {
  const { f, get } = await consoleApp(t);
  const read = async () => await (await get('/api/machines')).json() as { host_machine?: string | null };
  assert.equal(Object.hasOwn(await read(), 'host_machine'), false, '从未本机接入，没有待恢复的绑定');
  f.force("INSERT INTO setting (id, created_at, key, value_json) VALUES ('host', 'now', 'host_machine_uid', 'null')");
  assert.equal((await read()).host_machine, null, '迁移确认有旧本机接入，但认不出登记');
  f.ledger.joinMachine({ id: 'local', host: 'host', nodeId: 'local-node', tokenHash: 'test-hash', platform: 'test', source: null, ephemeral: false, local: true }, USER);
  assert.equal((await read()).host_machine, 'local');
});

test('HTTP quota history keeps the round name after rename without rewriting evidence', async (t) => {
  const { f, get } = await consoleApp(t);
  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title: '额度历史', goal: '目标', acceptance: '验收', loginId: 't1' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { login: f.ledger.getAccount('t1')!, machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: task.revision }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 1, null, { kind: 'quota', quota: { message: '额度没了' } });
  const evidence = f.ledger.getRun(run.id).error_json;
  f.ledger.renameAccount('t1', '后来改名', USER);
  const view = await (await get(`/api/tasks/${task.id}`)).json() as { runs: { error: { quota: { login_id: string; login_name: string } } }[] };
  assert.equal(view.runs[0]!.error.quota.login_id, run.login_name);
  assert.equal(view.runs[0]!.error.quota.login_name, run.login_name);
  assert.equal(f.ledger.getRun(run.id).error_json, evidence);
});

test('HTTP rename keeps task ids and displays the current name; machine routes use the registered login id', async (t) => {
  const { f, send, get } = await consoleApp(t);
  const pinned = f.ledger.createTask({ projectId: f.projectId, title: '按编号钉住', goal: '目标', acceptance: '验收', roleId: 'implement', loginId: 't1' }, USER);
  const renamed = await send('PUT', '/api/accounts/t1', { name: '现在的名字' });
  assert.equal(renamed.status, 200);
  const task = ((await (await get(`/api/tasks/${pinned.id}`)).json()) as { task: { login_id: string; login_name: string } }).task;
  assert.equal(task.login_id, 't1');
  assert.equal(task.login_name, '现在的名字');
  const byName = await send('PUT', `/api/accounts/${encodeURIComponent('现在的名字')}`, { name: '误按名字更新' });
  assert.equal(byName.status, 400);
  const made = await send('PUT', `/api/machines/${f.ledger.getMachine('h1')!.uid}/logins/codex`, { tiers: { execute: { kind: 'content', text: 'model="test"' } } });
  assert.equal(made.status, 201);
  const own = f.ledger.getMachineLogin('h1', 'codex')!;
  assert.notEqual(own.id, 'h1/codex');
  const shown = (await made.json()) as { machine: { logins: { id: string; name: string; executor: string }[] } };
  assert.equal(shown.machine.logins.find(({ executor }) => executor === 'codex')!.id, own.id);
  assert.equal(shown.machine.logins.find(({ executor }) => executor === 'codex')!.name, 'h1/codex');
  const retried = await send('POST', `/api/logins/${own.id}/retry`);
  assert.equal(retried.status, 200);
  assert.deepEqual(f.peek('SELECT * FROM login_state WHERE id = ?', 'h1/codex'), []);
});

test('stale machine and login forms cannot write a replacement registration or login', async (t) => {
  const { f, send } = await consoleApp(t);
  const settings = { tiers: { execute: { kind: 'content', text: 'model="test"' } } };
  const oldUid = f.ledger.getMachine('h1')!.uid;
  f.ledger.deleteMachine('h1', USER, { confirmed: true });
  holdMachine(f.ledger, testMachine('h1', 'new-host'), USER);
  const currentUid = f.ledger.getMachine('h1')!.uid;
  assert.notEqual(currentUid, oldUid);
  assert.equal((await send('PUT', `/api/machines/${oldUid}/logins/codex`, settings)).status, 400);
  assert.equal(f.ledger.getMachineLogin('h1', 'codex'), undefined);
  assert.equal((await send('PUT', '/api/machines/h1/logins/codex', settings)).status, 400, '机器名不是登记编号');
  assert.equal((await send('PUT', `/api/machines/${currentUid}/logins/codex`, settings)).status, 201);
  const oldId = f.ledger.getMachineLogin('h1', 'codex')!.id;
  f.ledger.deleteMachineLogin('h1', 'codex', USER);
  assert.equal((await send('PUT', `/api/machines/${currentUid}/logins/codex`, settings)).status, 201);
  const newId = f.ledger.getMachineLogin('h1', 'codex')!.id;
  assert.notEqual(newId, oldId);
  assert.equal((await send('PUT', `/api/logins/${oldId}`, settings)).status, 400);
  assert.equal((await send('DELETE', `/api/logins/${oldId}`)).status, 400);
  assert.equal((await send('POST', `/api/logins/${oldId}/retry`)).status, 400);
  // Writing by registration and executor sets that login up whether or not one exists (a login
  // the machine reported is adopted before the owner's form is saved): it updates, keeping its id.
  assert.equal((await send('PUT', `/api/machines/${currentUid}/logins/codex`, settings)).status, 200, '按登记编号和执行器写，已经有就更新');
  assert.equal(f.ledger.getMachineLogin('h1', 'codex')!.id, newId);
  assert.equal(f.ledger.getMachineLogin('h1', 'codex')!.id, newId);
  assert.equal((await send('PUT', `/api/logins/${newId}`, settings)).status, 200);
  assert.equal((await send('POST', `/api/logins/${newId}/retry`)).status, 200);
  assert.equal((await send('DELETE', `/api/logins/${newId}`)).status, 200);
});

test('native relogin binds an account id while its displayed name follows renames', async (t) => {
  const f = fixture(t);
  f.ledger.putAccount({ id: 'internal', name: '名字', executor: 'claude', tiers: { execute: claudeTier('test') } }, USER, 'ref');
  const accounts = createAccounts({ ledger: f.ledger, dataDir: f.dir, executors: ADAPTERS, credentialExecutors: ['claude'] });
  const login = createClaudeLogin({ dataDir: f.dir, accounts, ledger: f.ledger, platform: 'win32', models: { executors: ADAPTERS, timeoutMs: 1, fetch: async () => { throw new Error('must not request'); } },
    limitMs: () => 1000, cleanupMs: () => 10, settleMs: () => 1, log: () => {},
    bridgeRuntime: { prepare: async () => ({ bridge: undefined, problems: [] }), start: () => { throw new Error('must not start'); } } });
  t.after(() => login.stopAll());
  assert.throws(() => login.start('名字', 'relogin', USER), /账号不存在/);
  const session = login.start('internal', 'relogin', USER);
  assert.equal(session.account, 'internal');
  assert.equal(session.name, '名字');
  f.ledger.putAccount({ ...f.ledger.getAccount('internal')!, name: '新名字' }, USER);
  assert.equal(login.get(session.id).name, '新名字');
  // A new login may be started with a name an account already has: nothing is checked at
  // start, and no account is touched until a save decides the name
  // (docs/design/native-login.md §2).
  const fresh = login.start('新名字', 'new', USER);
  assert.equal(fresh.name, '新名字', '窗口先按写下的名字显示');
  login.cancel(fresh.id);
  assert.equal(f.ledger.getAccount('internal')!.name, '新名字', '开始登录不动已有的账号');
});
