import { migrationId, migrationNames } from './migration-names.ts';
// Guards the step to version 18 (docs/design/accounts-machines-decoupled.md, 迁移): an
// account that kept no login of its own left as an account, or merged onto the wrong
// machines, or onto none when it named none; its tiers, limits or learned state lost on the
// way; a project's ordered list, a pinned Task not yet ended or a round still out there
// left pointing at a name that is no longer anything; the Router's binding to such an
// account cleared, which reads as the owner's choice to bind none; a pin on several machines
// guessed at instead of let go with its reason on the timeline; an account that keeps its
// token losing anything but its machine list; an ended Task, an ended Run or any snapshot
// rewritten; and a crash on either side of the commit leaving half of each, or a reopen
// running the step again. Built on the recorded version 17 schema, never today's.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { createLogins } from '../service/logins.ts';
import { joinedBefore24 } from './helpers.ts';

const V17 = readFileSync(new URL('./fixtures/ledger/schema-v17.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';
const EXECUTORS = { claude: claudeAdapter, codex: codexAdapter, dsh: dshAdapter };
const CODEX_TIERS = '{"decide":{"kind":"content","text":"model=\\"<甲>\\"\\nmodel_reasoning_effort=\\"high\\"\\n"},"execute":{"kind":"content","text":"model=\\"<乙>\\"\\n"}}';
const LIVE_SNAPSHOT = '{"brief":"b","executor":"codex","account":{"executor":"codex","machines":["cluster-1"]}}';

class Crash extends Error {}

// A ledger as version 17 left it, holding one of each thing the step has a rule for.
function version17(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate17-'));
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec(V17);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('s-version', AT, 'schema_version', '17');
  setting.run('s-tunables', AT, 'tunables', JSON.stringify({ 'router.account': 'anywhere', 'router.tier': 'decide', 'run.timeoutMs': 1000 }));
  const machine = conn.prepare('INSERT INTO machine (id, created_at, updated_at, host, node_id, left_at) VALUES (?, ?, ?, ?, ?, ?)');
  machine.run('DEV-WORKSTATION', AT, AT, 'DEV-WORKSTATION', 'node-0000000000a', null);
  machine.run('cluster-1', AT, AT, 'cluster-1', null, null);
  machine.run('cluster-2', AT, AT, 'cluster-2', null, null);
  // A spawned machine whose registration has ended: nobody's to use, and given no login.
  machine.run('gone-box', AT, AT, 'gone-box', 'node-000000000gg', AT);
  const account = conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, config_dir, tiers_json, permission_mode, timeout_ms, max_runs, machines_json, credential_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // An account that keeps a token: only its machine list goes.
  account.run('claude', AT, AT, 'claude', '/home/me/.claude', '{"decide":{"kind":"content","text":"{\\"model\\":\\"<丙>\\"}"}}', 'bypassPermissions', 3_600_000, 3, '["DEV-WORKSTATION"]', 'ref-claude');
  // Two that kept none, one machine each: the owner's own shape.
  account.run('local-codex', AT, AT, 'codex', '/home/me/.codex', CODEX_TIERS, null, 1000, 2, '["DEV-WORKSTATION"]', null);
  account.run('cluster-codex', AT, AT, 'codex', null, CODEX_TIERS, null, null, null, '["cluster-1"]', null);
  // One that named two machines, one of them a machine the ledger no longer has.
  account.run('multi', AT, AT, 'dsh', null, '{"execute":{"kind":"ref","value":"/tiers/execute.patch.yml"}}', 'workspace-write', null, 1, '["cluster-1","cluster-2","vanished"]', null);
  // One that named none: every machine there is.
  account.run('anywhere', AT, AT, 'claude', null, '{"decide":{"kind":"ref","value":"/tiers/router.json"}}', null, null, null, '[]', null);
  const state = conn.prepare(`INSERT INTO account_state (id, created_at, rest_seq, rest_until, rest_streak, rest_reason, usage_json, credential_rejected_ref, models_json, models_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  state.run('local-codex', AT, 4, '2099-01-01T00:00:00.000Z', 2, '额度用完', '{"five_hour":{"used":0.9,"resets_at":null,"at":"2026-11-01T00:00:00.000Z"}}', null, '[{"id":"<甲>"}]', AT);
  state.run('claude', AT, null, null, 0, null, '{}', 'ref-old', '[]', null);
  const project = conn.prepare('INSERT INTO project (id, created_at, name, accounts_json, machines_json) VALUES (?, ?, ?, ?, ?)');
  project.run('p1', AT, '主项目', '["claude","local-codex","cluster-codex"]', '[]');
  // A project that keeps its work on cluster-2: only the login there is any use to it.
  project.run('p2', AT, '只在二号', '["multi","gone"]', '["cluster-2"]');
  project.run('p3', AT, '没动的', '["claude"]', '[]');
  const task = conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, account_id, role_id, state, created_by)
    VALUES (?, ?, ?, ?, '目标', '验收', ?, 'implement', ?, 'router')`);
  task.run('k-one', AT, 'p1', '钉在本机 codex', 'local-codex', 'queued');
  task.run('k-many', AT, 'p2', '钉在多台的', 'multi', 'queued');
  task.run('k-claude', AT, 'p1', '钉在带令牌的账号', 'claude', 'queued');
  task.run('k-done', AT, 'p1', '做完了的', 'local-codex', 'done');
  task.run('k-live', AT, 'p1', '正在跑的', 'cluster-codex', 'running');
  task.run('k-free', AT, 'p1', '不钉的', null, 'queued');
  const run = conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, account_id, host, machine_id, state, marker, snapshot_json)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`);
  run.run('r-live', AT, 'k-live', 'cluster-codex', 'cluster-1', 'cluster-1', 'running', 'tycho-run:r-live', LIVE_SNAPSHOT);
  run.run('r-done', AT, 'k-done', 'local-codex', 'DEV-WORKSTATION', 'DEV-WORKSTATION', 'ended', 'tycho-run:r-done', '{"brief":"old"}');
  conn.close();
  const read = <T>(sql: string): T[] => {
    const peek = new DatabaseSync(path);
    try {
      return peek.prepare(sql).all().map((row) => ({ ...row })) as T[];
    } finally {
      peek.close();
    }
  };
  const version = (): string => read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json;
  const tables = (): string[] => read<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(({ name }) => name);
  const dump = () => Object.fromEntries(tables().map((name) => [name, read(`SELECT * FROM ${name} ORDER BY rowid`)]));
  return { dir, path, read, version, dump, closing };
}

const migrated = (old: ReturnType<typeof version17>) => {
  const ledger = old.closing(openLedger(old.path, joinedBefore24(old.path)));
  const logins = createLogins({ ledger, accounts: { get: ledger.getAccount, list: ledger.listAccounts }, executors: EXECUTORS });
  return { ledger, logins };
};

test('an account that keeps a token stays an account and loses only its machine list', (t) => {
  const old = version17(t);
  const { ledger } = migrated(old);
  assert.equal(old.version(), String(SCHEMA_VERSION));
  assert.deepEqual(ledger.listAccounts().map(({ name }) => name), ['claude'], '没有令牌的账号都不再是账号');
  const { created_at: _made, updated_at: _changed, ...claude } = ledger.getAccount(migrationId(ledger, 'claude'))!;
  assert.deepEqual({ ...claude, tiers: { ...claude.tiers } }, {
    id: migrationId(ledger, 'claude'), name: 'claude', executor: 'claude', permissionMode: 'bypassPermissions',
    tiers: { decide: { kind: 'content', text: '{"model":"<丙>"}' } }, timeoutMs: 3_600_000, maxRuns: 3,
  });
  assert.equal(ledger.accountCredentialRef(migrationId(ledger, 'claude')), 'ref-claude', '令牌编号不动');
  assert.equal(ledger.loginState(migrationId(ledger, 'claude')).credential_rejected_ref, 'ref-old', '学到的状态不动');
  assert.equal(old.read<{ name: string }>(`SELECT name FROM pragma_table_info('account')`).some(({ name }) => name === 'machines_json'), false, '账号表没有机器清单这一列');
});

test('an account with no token becomes the login of each machine it named, with its tiers, limits and what was learned', (t) => {
  const old = version17(t);
  const { ledger, logins } = migrated(old);
  // The tiers as the step stored them: a value an older program wrote as a file on the
  // machine is carried over as it was, though the running program reads only content.
  const stored = new Map(old.read<{ machine_id: string; executor: string; tiers_json: string }>('SELECT machine_id, executor, tiers_json FROM machine_login')
    .map(({ machine_id, executor, tiers_json }) => [`${machine_id}/${executor}`, tiers_json]));
  const own = ledger.listMachineLogins().map(({ name, permissionMode, timeoutMs, maxRuns }) => ({ id: name, tiers: stored.get(name), permissionMode, timeoutMs, maxRuns }));
  assert.deepEqual(own, [
    { id: 'DEV-WORKSTATION/codex', tiers: CODEX_TIERS, permissionMode: undefined, timeoutMs: 1000, maxRuns: 2 },
    { id: 'cluster-1/codex', tiers: CODEX_TIERS, permissionMode: undefined, timeoutMs: undefined, maxRuns: undefined },
    // Several machines, one login each; a machine the ledger no longer has gets none.
    { id: 'cluster-1/dsh', tiers: '{"execute":{"kind":"ref","value":"/tiers/execute.patch.yml"}}', permissionMode: 'workspace-write', timeoutMs: undefined, maxRuns: 1 },
    { id: 'cluster-2/dsh', tiers: '{"execute":{"kind":"ref","value":"/tiers/execute.patch.yml"}}', permissionMode: 'workspace-write', timeoutMs: undefined, maxRuns: 1 },
    // One that named none: every machine still registered, and not the one that has left.
    { id: 'DEV-WORKSTATION/claude', tiers: '{"decide":{"kind":"ref","value":"/tiers/router.json"}}', permissionMode: undefined, timeoutMs: undefined, maxRuns: undefined },
    { id: 'cluster-1/claude', tiers: '{"decide":{"kind":"ref","value":"/tiers/router.json"}}', permissionMode: undefined, timeoutMs: undefined, maxRuns: undefined },
    { id: 'cluster-2/claude', tiers: '{"decide":{"kind":"ref","value":"/tiers/router.json"}}', permissionMode: undefined, timeoutMs: undefined, maxRuns: undefined },
  ]);
  // The rest, the usage and the model list go with the login; the old name's row goes.
  const learned = ledger.loginState(migrationId(ledger, 'DEV-WORKSTATION/codex'));
  assert.deepEqual([learned.rest_until, learned.rest_streak, learned.rest_reason, learned.usage.map(({ window, used }) => [window, used]), learned.models, learned.models_at],
    ['2099-01-01T00:00:00.000Z', 2, '额度用完', [['five_hour', 0.9]], [{ id: '<甲>' }], AT]);
  assert.deepEqual(old.read(`SELECT id FROM login_state WHERE id = 'local-codex'`), []);
  // And the store reads them back as logins of their machines.
  assert.equal(logins.get(migrationId(ledger, 'cluster-2/dsh'))!.machine, 'cluster-2');
  assert.deepEqual(logins.list().map(({ name }) => name), ['claude', 'DEV-WORKSTATION/codex', 'cluster-1/codex', 'cluster-1/dsh', 'cluster-2/dsh', 'DEV-WORKSTATION/claude', 'cluster-1/claude', 'cluster-2/claude']);
  // What each account became is on record, so a round of it left behind reads as removed.
  const records = old.read<{ actor: string; task_id: string | null; detail_json: string }>(`SELECT actor, task_id, detail_json FROM change WHERE action = 'login.migrate' AND json_extract(detail_json, '$.account_id') IS NOT NULL ORDER BY seq`);
  assert.deepEqual(records.map(({ actor, detail_json }) => [actor, JSON.parse(detail_json)]), [
    ['migration', { account_id: 'local-codex', logins: ['DEV-WORKSTATION/codex'] }],
    ['migration', { account_id: 'cluster-codex', logins: ['cluster-1/codex'] }],
    ['migration', { account_id: 'multi', logins: ['cluster-1/dsh', 'cluster-2/dsh'] }],
    ['migration', { account_id: 'anywhere', logins: ['DEV-WORKSTATION/claude', 'cluster-1/claude', 'cluster-2/claude'] }],
  ]);
  assert.equal(ledger.loginWasDeleted('local-codex'), true);
  assert.equal(ledger.loginWasDeleted('never-was'), false);
});

test('a project lists the logins its accounts became, in order, only those its machines can run', (t) => {
  const old = version17(t);
  const { ledger } = migrated(old);
  assert.deepEqual(migrationNames(ledger, ledger.getProject('p1').logins_json), ["claude","DEV-WORKSTATION/codex","cluster-1/codex"]);
  // multi's login on cluster-1 could never run this project's work. Version 26 also
  // clears the dangling name; step 18's original audit remains unchanged below.
  assert.deepEqual(migrationNames(ledger, ledger.getProject('p2').logins_json), ["cluster-2/dsh"]);
  assert.deepEqual(migrationNames(ledger, ledger.getProject('p3').logins_json), ["claude"]);
  const audit = old.read<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'login.migrate' AND json_extract(detail_json, '$.project_id') IS NOT NULL ORDER BY seq`).map(({ detail_json }) => JSON.parse(detail_json));
  assert.deepEqual(audit, [
    { project_id: 'p1', logins: { from: ['claude', 'local-codex', 'cluster-codex'], to: ['claude', 'DEV-WORKSTATION/codex', 'cluster-1/codex'] } },
    { project_id: 'p2', logins: { from: ['multi', 'gone'], to: ['cluster-2/dsh', 'gone'] } },
  ]);
});

test('a pin moves to the one login its account became; one on several machines is let go with the reason on the timeline', (t) => {
  const old = version17(t);
  const { ledger } = migrated(old);
  assert.deepEqual(['k-one', 'k-many', 'k-claude', 'k-done', 'k-live', 'k-free'].map((id) => ledger.getTask(id).login_id),
    [migrationId(ledger, 'DEV-WORKSTATION/codex'), null, migrationId(ledger, 'claude'), null, migrationId(ledger, 'cluster-1/codex'), null]);
  const why = (taskId: string) => ledger.listChanges({ taskId }).filter(({ action }) => action === 'login.migrate').map(({ actor, detail_json }) => [actor, JSON.parse(detail_json!)]);
  assert.deepEqual(why('k-one'), [['migration', { login_id: { from: 'local-codex', to: 'DEV-WORKSTATION/codex' }, reason: '原来指定的账号 local-codex 没有自己的登录，用的是机器 DEV-WORKSTATION 自己的登录；现在指定那台机器上的这份登录' }]]);
  assert.deepEqual(why('k-many'), [['migration', { login_id: { from: 'multi', to: null }, reason: '原来指定的账号 multi 没有自己的登录，用的是 2 台机器各自的登录；现在不再指定，由派发在项目允许的登录里挑' }]]);
  assert.deepEqual([why('k-claude'), why('k-done'), why('k-free')], [[], [], []], '带令牌的、已经结束的、本来没钉的都不动');
  assert.deepEqual(['k-one', 'k-many', 'k-done'].map((id) => ledger.getTask(id).state), ['queued', 'queued', 'done'], '任务的状态不动');
});

test('a round still out there counts against its login; historical names and every snapshot stay as they were', (t) => {
  const old = version17(t);
  const { ledger } = migrated(old);
  assert.equal(ledger.getRun('r-live').login_id, migrationId(ledger, 'cluster-1/codex'));
  assert.equal(ledger.getRun('r-live').snapshot_json, LIVE_SNAPSHOT, '快照是实际输入，不改写');
  assert.equal(ledger.getRun('r-done').login_name, 'local-codex', '结束的那一轮是历史');
  assert.equal(ledger.getRun('r-done').snapshot_json, '{"brief":"old"}');
});

// Step 18's original audit survives; step 26 clears its now-dangling name and audits that
// separately rather than letting a future account of that name inherit the binding.
test('the Router folded-account audit survives; the later uid migration clears its dangling binding', (t) => {
  const old = version17(t);
  const { ledger } = migrated(old);
  assert.deepEqual(ledger.getTunables(), { 'router.account': '', 'router.tier': 'decide', 'run.timeoutMs': 1000, 'knowledge.externalEntry': true });
  assert.equal(ledger.accountFolded('anywhere'), true);
  const [noted] = old.read<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'login.migrate' AND json_extract(detail_json, '$.router_account') IS NOT NULL`);
  assert.deepEqual(JSON.parse(noted!.detail_json), {
    router_account: 'anywhere',
    reason: '负责人绑定的账号 anywhere 没有自己的登录令牌，在这次迁移里并掉了；负责人停下，等你在设置里重新绑定一个带令牌的账号',
  });
});

// The owner's ledger as it stands (2026-11-09): one Claude account with a token, two Codex
// accounts with none, each listing one machine.
test('the owner\'s shape: the Claude account stays, each Codex one becomes its machine\'s login, and the project follows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate17-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec(V17);
  conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('v', ?, 'schema_version', '17')`).run(AT);
  conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('t', ?, 'tunables', ?)`).run(AT, JSON.stringify({ 'router.account': 'claude', 'router.tier': 'decide' }));
  for (const id of ['DEV-WORKSTATION', 'cluster-gpu']) conn.prepare('INSERT INTO machine (id, created_at, updated_at, host) VALUES (?, ?, ?, ?)').run(id, AT, AT, id);
  const account = conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, tiers_json, machines_json, credential_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  account.run('claude', AT, AT, 'claude', '{"decide":{"kind":"content","text":"{}"}}', '[]', 'ref-1');
  account.run('local-codex', AT, AT, 'codex', CODEX_TIERS, '["DEV-WORKSTATION"]', null);
  account.run('cluster-codex', AT, AT, 'codex', CODEX_TIERS, '["cluster-gpu"]', null);
  conn.prepare(`INSERT INTO project (id, created_at, name, accounts_json) VALUES ('p', ?, 'tycho', '["claude","local-codex","cluster-codex"]')`).run(AT);
  conn.close();
  const ledger = openLedger(path, joinedBefore24(path));
  try {
    const logins = createLogins({ ledger, accounts: { get: ledger.getAccount, list: ledger.listAccounts }, executors: EXECUTORS });
    assert.deepEqual(logins.list().map(({ name, machine }) => [name, machine ?? null]), [['claude', null], ['DEV-WORKSTATION/codex', 'DEV-WORKSTATION'], ['cluster-gpu/codex', 'cluster-gpu']]);
    assert.deepEqual(migrationNames(ledger, ledger.getProject('p').logins_json), ['claude','DEV-WORKSTATION/codex','cluster-gpu/codex']);
    assert.deepEqual(ledger.getTunables(), { 'router.account': migrationId(ledger, 'claude'), 'router.tier': 'decide', 'knowledge.externalEntry': true }, '负责人绑的是带令牌的账号：不动');
  } finally { ledger.close(); }
});

for (const point of ['before', 'after'] as const) {
  test(`a crash ${point} the step's commit leaves version 17 or version 18 whole, and a reopen does not run it twice`, (t) => {
    const old = version17(t);
    const before = old.dump();
    const hooks = point === 'before'
      ? { beforeMigrationCommit(from: number) { if (from === 17) throw new Crash(); } }
      : { afterMigrationCommit(from: number) { if (from === 17) throw new Crash(); } };
    assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
    if (point === 'before') {
      assert.equal(old.version(), '17');
      const { ['ledger.before-v18.db']: _copy, ...now } = old.dump();
      assert.deepEqual(now, before, '提交之前：改名、建表、并账号、改指向一起没有');
    } else {
      assert.equal(old.version(), '18');
      assert.equal(old.read(`SELECT 1 FROM account WHERE id = 'local-codex'`).length, 0);
      assert.equal(old.read(`SELECT 1 FROM machine_login`).length, 7);
    }
    const ran: number[] = [];
    old.closing(new Db(old.path, false, { beforeMigrationCommit(from) { ran.push(from); }, ...joinedBefore24(old.path).testHooks }, { log: () => {} }));
    // The steps after it are not this test's: only whether step 17 ran again.
    assert.deepEqual(ran.filter((from) => from === 17), point === 'before' ? [17] : [], '提交了的不再做一遍');
    const result = old.dump();
    // Whichever way it went, the ledger is the one a clean run of the step leaves.
    const clean = version17(t);
    clean.closing(new Db(clean.path, false, joinedBefore24(clean.path).testHooks, { log: () => {} }));
    // A machine's registration (version 24) is new each time: a project's list is compared by
    // the names its registrations stand for.
    const strip = (dump: Record<string, unknown[]>) => {
      const names = new Map(((dump.machine ?? []) as { id: string; uid: string }[]).map(({ id, uid }) => [uid, id]));
      const loginNames = new Map([...(dump.account ?? []) as {id:string;name:string}[], ...(dump.machine_login ?? []) as {id:string;machine_id:string;executor:string}[]].map((r) => [r.id, 'name' in r ? r.name : `${r.machine_id}/${r.executor}`]));
      // Deleted logins retained by ended rounds also receive fresh ids at version 26.
      for (const run of (dump.run ?? []) as { login_id: string | null; login_name: string | null }[]) {
        if (run.login_id !== null && run.login_name !== null && !loginNames.has(run.login_id)) loginNames.set(run.login_id, `historical:${run.login_name}`);
      }
      const normalize = (value: unknown): unknown => typeof value === 'string' ? [...loginNames, ...names].reduce((text, [id, name]) => text.replaceAll(id, name), value) : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, normalize(v)])) : value;
      const named = (row: Record<string, unknown>) => (typeof row.machines_json === 'string'
        ? { ...row, machines_json: (JSON.parse(row.machines_json) as string[]).map((uid) => names.get(uid) ?? 'gone') }
        : row);
      return Object.fromEntries(Object.entries(dump).map(([name, rows]) => [name, (rows as Record<string, unknown>[]).map(({ id: _id, uid: _uid, created_at: _c, at: _at, seq: _seq, updated_at: _u, ...rest }) => normalize(named(rest)))]));
    };
    assert.deepEqual(strip(result), strip(clean.dump()));
    assert.deepEqual(old.read<{ n: number }>(`SELECT count(*) AS n FROM change WHERE action = 'login.migrate'`)[0]!.n, 10, '审计只写一遍：两个项目、三个钉、负责人、四个账号');
    verifySnapshot(old.path);
  });
}

test('a ledger with no account to merge comes through with its accounts as they were, and writes no audit row', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate17-none-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec(V17);
  conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('v', ?, 'schema_version', '17')`).run(AT);
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, tiers_json, machines_json, credential_ref) VALUES ('claude', ?, ?, 'claude', '{}', '["h1"]', 'ref-1')`).run(AT, AT);
  conn.close();
  new Db(path, false, {}, { log: () => {} }).close();
  const read = new DatabaseSync(path);
  try {
    assert.deepEqual(read.prepare('SELECT name AS id, credential_ref FROM account').all().map((row) => ({ ...row })), [{ id: 'claude', credential_ref: 'ref-1' }]);
    assert.deepEqual(read.prepare(`SELECT * FROM change`).all(), []);
    assert.equal(read.prepare(`SELECT name FROM pragma_table_info('account') WHERE name = 'machines_json'`).all().length, 0);
  } finally { read.close(); }
});
