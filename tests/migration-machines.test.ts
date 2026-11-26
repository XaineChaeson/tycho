import { migrationId, migrationNames } from './migration-names.ts';
// Guards the step from ledger version 23 to 24 (docs/design/nodes.md §11 step 6: machines join
// only through their client) against:
//   - a machine that never joined surviving the step, or taking its own logins' rows, their
//     place in projects' lists and their learned state with it only in part,
//   - a round still running on such a machine being continued from, or settled as anything
//     but a round on a removed machine: its result is never taken,
//   - its Task left anywhere but back in the queue, and a Task pinned to its own login moved
//     onto another login instead of stopping with the reason,
//   - a login of a machine deleted before the step left in a project's list,
//   - a project whose list named only that machine reading afterwards as "any machine",
//   - a project's list naming a machine by its name after the step, so that a machine that
//     joins later under a deleted machine's name is in it,
//   - nothing in the timeline saying what the step removed,
//   - a crash on either side of the step's commit leaving a ledger between the two versions, or
//     a failure inside the step leaving part of it written or its audit written twice,
//     and a ledger of the new version not verifying as one.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { createRunner } from '../runner/runner.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { createLogins } from '../service/logins.ts';
import { PRESET_ROLES } from '../shared/roles.ts';
import { fakeRemote } from './fake-remote.ts';
import { DISPATCH_TUNED, holdMachine, RUNNER_TUNED, testMachine, machineNamesOf } from './helpers.ts';

const V23 = readFileSync(new URL('./fixtures/ledger/schema-v23.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';
const EXECUTORS = { claude: claudeAdapter, codex: codexAdapter };
class Crash extends Error {}

// The owner's shape at version 23: one machine reached over SSH, with a Codex login of its
// own, a round running on it and a Task pinned to that login, and one machine whose client joined.
function version23(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate23-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V23);
  const run = (sql: string, ...params: (string | null)[]) => conn.prepare(sql).run(...params);
  run(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '23')`, AT);
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) role.run(each.id, AT, AT, each.name, each.description, each.default_tier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  run(`INSERT INTO machine (id, created_at, updated_at, host, ssh_config, note) VALUES ('cluster-a1', ?, ?, 'me@cluster-a1', '/home/me/.ssh/config', '集群实例')`, AT, AT);
  run(`INSERT INTO machine (id, created_at, updated_at, host, node_id, token_hash, platform, joined_at) VALUES ('DEV-WORKSTATION', ?, ?, 'dev-workstation', 'a1b2c3d4e5f60718', 'hash-of-the-token', 'win32', ?)`, AT, AT, AT);
  for (const machine of ['cluster-a1', 'DEV-WORKSTATION']) {
    run(`INSERT INTO machine_login (machine_id, executor, created_at, updated_at, tiers_json) VALUES (?, 'codex', ?, ?, '{"execute":{"kind":"content","text":"model=\\"x\\"\\n"}}')`, machine, AT, AT);
    run(`INSERT INTO login_state (id, created_at, rest_until) VALUES (?, ?, '2026-11-02T00:00:00.000Z')`, `${machine}/codex`, AT);
  }
  run(`INSERT INTO project (id, created_at, name, logins_json, machines_json) VALUES ('p-only', ?, '只在集群', '["cluster-a1/codex","DEV-WORKSTATION/codex"]', '["cluster-a1"]')`, AT);
  run(`INSERT INTO project (id, created_at, name, logins_json, machines_json) VALUES ('p-both', ?, '两台都行', '["DEV-WORKSTATION/codex"]', '["DEV-WORKSTATION","cluster-a1"]')`, AT);
  run(`INSERT INTO project (id, created_at, name, logins_json, machines_json, login_mode) VALUES ('p-any', ?, '不限', '[]', '[]', 'all')`, AT);
  run(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, login_id, role_id, state, created_by) VALUES ('k1', ?, 'p-both', '跑在集群上的', '目标', '验收', NULL, 'implement', 'running', 'router')`, AT);
  // A Task pinned to the removed machine's own login, waiting in the queue.
  run(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, login_id, role_id, state, created_by) VALUES ('k2', ?, 'p-both', '钉在集群登录上的', '目标', '验收', 'cluster-a1/codex', 'implement', 'queued', 'router')`, AT);
  const snapshot = { brief: 'b', executor: 'codex', timeout_ms: 600_000, login: { executor: 'codex', machine: 'cluster-a1' }, machine: { host: 'me@cluster-a1', ssh_config: '/home/me/.ssh/config', note: '集群实例' } };
  run(`INSERT INTO run (id, created_at, task_id, task_revision, login_id, host, machine_id, node_id, state, marker, snapshot_json, started_at)
    VALUES ('r1', ?, 'k1', 1, 'cluster-a1/codex', 'me@cluster-a1', 'cluster-a1', NULL, 'running', 'tycho-run:r1', ?, ?)`, AT, JSON.stringify(snapshot), AT);
  conn.close();
  return path;
}

const version = (path: string): string => {
  const conn = new DatabaseSync(path, { readOnly: true });
  try {
    return String(JSON.parse((conn.prepare(`SELECT value_json FROM setting WHERE key = 'schema_version'`).get() as { value_json: string }).value_json));
  } finally {
    conn.close();
  }
};

test('a machine that never joined goes with its own logins; the one that joined stays, and projects keep restricting', (t) => {
  const path = version23(t);
  const ledger = openLedger(path, { copyBeforeUpgrade: false, log: () => {} });
  assert.equal(SCHEMA_VERSION, 47);
  assert.equal(ledger.getMachine('cluster-a1'), undefined);
  assert.equal(ledger.getMachineLogin('cluster-a1', 'codex'), undefined);
  assert.equal(ledger.loginState('cluster-a1/codex')?.rest_until ?? null, null, '它学到的状态一起走');
  const joined = ledger.getMachine('DEV-WORKSTATION')!;
  assert.deepEqual([joined.host, joined.nodeId, joined.platform], ['dev-workstation', 'a1b2c3d4e5f60718', 'win32']);
  assert.equal(ledger.machineByNodeToken('hash-of-the-token')?.id, 'DEV-WORKSTATION', '它的令牌照旧能用');
  assert.ok(ledger.getMachineLogin('DEV-WORKSTATION', 'codex'));

  // A list that named only the removed machine allows none, not any.
  assert.deepEqual(machineNamesOf(ledger, 'p-only'), { names: [], gone: 1 });
  const only = ledger.machineRange({ project_id: 'p-only', knowledge_json: null });
  assert.ok('conflict' in only && /允许的机器都已经删掉了/.test(only.conflict), JSON.stringify(only));
  assert.deepEqual(machineNamesOf(ledger, 'p-both'), { names: ['DEV-WORKSTATION'], gone: 1 });
  assert.deepEqual(machineNamesOf(ledger, 'p-any'), { names: [], gone: 0 });
  assert.deepEqual(migrationNames(ledger, ledger.getProject('p-only').logins_json), ['DEV-WORKSTATION/codex']);
  assert.deepEqual(migrationNames(ledger, ledger.getProject('p-both').logins_json), ['DEV-WORKSTATION/codex']);

  // A machine that joins later under the removed one's name is in no project's list.
  holdMachine(ledger, testMachine('cluster-a1'));
  assert.deepEqual(machineNamesOf(ledger, 'p-only'), { names: [], gone: 1 });
  assert.deepEqual(machineNamesOf(ledger, 'p-both'), { names: ['DEV-WORKSTATION'], gone: 1 });

  // The timeline says what went and why.
  const said = (action: string) => {
    const conn = new DatabaseSync(path, { readOnly: true });
    try {
      return conn.prepare(`SELECT actor, detail_json FROM change WHERE action = ? ORDER BY seq`).all(action) as { actor: string; detail_json: string }[];
    } finally {
      conn.close();
    }
  };
  const removed = said('machine.delete').map(({ actor, detail_json }) => ({ actor, ...JSON.parse(detail_json) }));
  assert.equal(removed.length, 1);
  assert.deepEqual([removed[0].actor, removed[0].machine_id, removed[0].machine.ssh_config, removed[0].logins], ['migration', 'cluster-a1', '/home/me/.ssh/config', ['cluster-a1/codex']]);
  const projects = said('project.update').filter(({ actor }) => actor === 'migration').map(({ detail_json }) => JSON.parse(detail_json));
  assert.deepEqual(projects.map(({ project_id, machines_gone }) => [project_id, machines_gone]), [['p-only', ['cluster-a1']], ['p-both', ['cluster-a1']]]);
  assert.deepEqual(projects[0].logins, { from: ['cluster-a1/codex', 'DEV-WORKSTATION/codex'], to: ['DEV-WORKSTATION/codex'] });
  ledger.close();
});

test('a round still running on the removed machine is settled at the inventory as one on a removed machine', async (t) => {
  const path = version23(t);
  const ledger = openLedger(path, { copyBeforeUpgrade: false, log: () => {} });
  const remote = fakeRemote();
  const runner = createRunner({ ...RUNNER_TUNED, ledger, adapters: EXECUTORS,
    logins: createLogins({ ledger, accounts: { get: ledger.getAccount, list: ledger.listAccounts }, executors: EXECUTORS }),
    machines: { get: ledger.getMachine, list: ledger.listMachines }, connect: remote.connect, log: () => {},
  });
  assert.deepEqual(await runner.recover(), [{ runId: 'r1', verdict: 'lost' }]);
  const run = ledger.getRun('r1');
  assert.deepEqual([run.state, run.exit_kind, JSON.parse(run.error_json!).lost.basis], ['ended', 'lost', 'removed']);
  assert.deepEqual(remote.calls, [], '那台机器已经不在：不问它，也不向别的机器发它的东西');
  assert.deepEqual([ledger.getTask('k1').state, ledger.getTask('k1').reason], ['queued', null], '任务按既有规则回到队列接着走，不等这一轮');
  ledger.close();
});

test('a crash on either side of the step\'s commit leaves version 23 or 24 whole, and the next open finishes', (t) => {
  for (const side of ['before', 'after'] as const) {
    const path = version23(t);
    assert.throws(() => new Db(path, false, {
      [side === 'before' ? 'beforeMigrationCommit' : 'afterMigrationCommit']: (from: number) => { if (from === 23) throw new Crash(); },
    }, { copyBeforeUpgrade: false }), Crash);
    assert.equal(version(path), side === 'before' ? '23' : '24');
    const db = new Db(path, false, {}, { copyBeforeUpgrade: false });
    assert.deepEqual(db.all<{ id: string }>('SELECT id FROM machine ORDER BY id').map(({ id }) => id), ['DEV-WORKSTATION']);
    assert.equal(db.all<{ name: string }>(`SELECT name FROM pragma_table_info('machine') WHERE name = 'ssh_config'`).length, 0);
    db.close();
    assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
  }
});

// A login of a machine deleted before the step (an older program left projects' references
// to it behind) is gone from projects too: otherwise a machine joining later under that name
// and given that login would be in the project's logins without the owner saying so.
test('a login of a machine deleted before the step leaves projects too, said apart from the step\'s own', (t) => {
  const path = version23(t);
  const conn = new DatabaseSync(path);
  conn.prepare(`INSERT INTO project (id, created_at, name, logins_json, machines_json) VALUES ('p-stale', ?, '旧引用', '["old/codex","DEV-WORKSTATION/codex"]', '[]')`).run(AT);
  conn.close();
  const ledger = openLedger(path, { copyBeforeUpgrade: false, log: () => {} });
  assert.deepEqual(migrationNames(ledger, ledger.getProject('p-stale').logins_json), ['DEV-WORKSTATION/codex']);
  const read = new DatabaseSync(path, { readOnly: true });
  const said = (read.prepare(`SELECT detail_json FROM change WHERE action = 'project.update' AND actor = 'migration' ORDER BY seq`).all() as { detail_json: string }[])
    .map(({ detail_json }) => JSON.parse(detail_json) as { project_id: string; logins_removed?: { machine_removed: string[]; no_such_login: string[] } });
  read.close();
  assert.deepEqual(said.find(({ project_id }) => project_id === 'p-stale')?.logins_removed, { machine_removed: [], no_such_login: ['old/codex'] });
  assert.deepEqual(said.find(({ project_id }) => project_id === 'p-only')?.logins_removed, { machine_removed: ['cluster-a1/codex'], no_such_login: [] });
  // A machine of that name joins later and is given that login: the project does not take it.
  holdMachine(ledger, testMachine('old'));
  ledger.putMachineLogin({ executor: 'codex', machine: 'old', tiers: { execute: { kind: 'content', text: 'model="x"\n' } } }, { actor: 'console' });
  assert.equal(ledger.loginPool({ project_id: 'p-stale' }).ids.includes('old/codex'), false);
  ledger.close();
});

// What becomes of the work on the removed machine, said to the state and the reason: the round
// that was running is settled as one on a removed machine and its Task goes on. Version 26
// clears the removed login's pin with an audit, so that Task can use the remaining pool.
test('a removed login pin is cleared and audited; both Tasks can use the remaining login', async (t) => {
  const path = version23(t);
  const ledger = openLedger(path, { copyBeforeUpgrade: false, log: () => {} });
  const logins = createLogins({ ledger, accounts: { get: ledger.getAccount, list: ledger.listAccounts }, executors: EXECUTORS });
  const remote = fakeRemote();
  const runner = createRunner({ ...RUNNER_TUNED, ledger, adapters: EXECUTORS, logins,
    machines: { get: ledger.getMachine, list: ledger.listMachines }, connect: remote.connect, log: () => {},
  });
  assert.equal(ledger.getTask('k2').state, 'queued', '迁移本身不碰任务');
  await runner.recover();
  // The round on the removed machine is settled as such, and its Task goes back to the queue
  // as after any lost round, with nothing for the owner to do.
  assert.deepEqual([ledger.getTask('k1').state, ledger.getTask('k1').reason], ['queued', null]);
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED, ledger, runTimeoutMs: () => 60_000,
    runner: { ...runner, watch: async () => {} }, logins, machines: { get: ledger.getMachine, list: ledger.listMachines },
    executors: EXECUTORS, log: () => {},
  });
  await dispatcher.tick();
  await dispatcher.tick();
  dispatcher.stop();
  // It goes on with the project's remaining login on the machine that joined.
  assert.deepEqual(ledger.listRuns('k1').map((run) => [run.id === 'r1', run.state, run.exit_kind, run.login_id, run.machine_id]), [
    [true, 'ended', 'lost', null, 'cluster-a1'],
    [false, 'running', null, migrationId(ledger, 'DEV-WORKSTATION/codex'), 'DEV-WORKSTATION'],
  ]);
  assert.equal(ledger.getTask('k1').state, 'running');
  // The uid migration cleared the pin, with the old name retained in the audit.
  assert.equal(ledger.getTask('k2').login_id, null, '版本 26 清掉已不存在登录的钉住引用');
  assert.notEqual(ledger.getTask('k2').state, 'held');
  assert.deepEqual(ledger.listRuns('k2').map(({ login_id }) => login_id), [migrationId(ledger, 'DEV-WORKSTATION/codex')]);
  assert.ok(ledger.listChanges({ taskId: 'k2' }).some(({ action, detail_json }) => action === 'task.update' && detail_json?.includes('cluster-a1/codex')));
  ledger.close();
});

// A failure inside the step leaves version 23 exactly as it was — every table — and the step
// run again on the next open writes its audit once, not once per attempt.
test('a failure inside the step leaves the whole ledger as it was, and the reopen audits once', (t) => {
  const path = version23(t);
  const dump = (): Record<string, unknown[]> => {
    const conn = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = (conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map(({ name }) => name);
      return Object.fromEntries(tables.map((name) => [name, conn.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
    } finally {
      conn.close();
    }
  };
  const before = dump();
  assert.throws(() => new Db(path, false, { beforeMigrationCommit(from) { if (from === 23) throw new Crash(); } }, { copyBeforeUpgrade: false }), Crash);
  assert.deepEqual(dump(), before, '删机器、删登录、重建机器表、改项目、写审计，一起没有');
  new Db(path, false, {}, { copyBeforeUpgrade: false }).close();
  assert.equal(version(path), String(SCHEMA_VERSION));
  const conn = new DatabaseSync(path, { readOnly: true });
  const count = (action: string): number => (conn.prepare(`SELECT count(*) AS n FROM change WHERE actor = 'migration' AND action = ?`).get(action) as { n: number }).n;
  assert.deepEqual([count('machine.delete'), count('project.update')], [1, 2], '审计只写一遍');
  conn.close();
});
