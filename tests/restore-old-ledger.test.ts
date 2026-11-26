// A version 4 backup predates joined node identities and ledger-held accounts. Since
// version 24 its SSH machines are removed. Restore settles those rounds and holds the
// tasks; creating same-named accounts or machines must never reconnect their history.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loginMissing, unreachableSince } from '../service/ledger.ts';
import { restoreBackup } from '../service/restore.ts';
import { signIn, stage, until } from './stage.ts';
import { codexTier, holdMachine, testMachine } from './helpers.ts';

const V4 = readFileSync(new URL('./fixtures/ledger/schema-v4.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';

// A backup the previous version of the program took: two Tasks at work on two accounts.
// One Run was running; the other had been out of contact for days, far past any grace
// period, which is the Run a hasty rule would continue first.
function oldBackup(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-old-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.db');
  const conn = new DatabaseSync(file);
  conn.exec(V4);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('s1', AT, 'schema_version', '4');
  setting.run('s2', AT, 'whitelist', JSON.stringify({ console: ['console'] }));
  setting.run('s3', AT, 'pause.user', 'false');
  conn.prepare(`INSERT INTO project (id, created_at, name, allowed_targets_json) VALUES ('p1', ?, '试跑', '["t1","t2"]')`).run(AT);
  const task = conn.prepare(
    `INSERT INTO task (id, created_at, project_id, title, goal, acceptance, target_id, tier, state, reason, created_by)
     VALUES (?, ?, 'p1', ?, '目标', '验收', ?, 'execute', ?, ?, 'router')`,
  );
  task.run('k1', AT, '在跑的任务', 't1', 'running', null);
  task.run('k2', AT, '失联的任务', 't2', 'needs_verification', '执行机器失联，核实中');
  const run = conn.prepare(
    `INSERT INTO run (id, created_at, task_id, task_revision, target_id, host, state, marker, snapshot_json, error_json, started_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, '{"brief":"b","executor":"claude"}', ?, ?)`,
  );
  run.run('r1', AT, 'k1', 't1', 'h1', 'running', 'tycho-run:r1', null, AT);
  run.run('r2', AT, 'k2', 't2', 'h2', 'unknown', 'tycho-run:r2', JSON.stringify({ unknown_from: 'running', unreachable_since: AT }), AT);
  const change = conn.prepare(`INSERT INTO change (id, created_at, at, actor, task_id, run_id, action) VALUES (?, ?, ?, 'dispatcher', ?, ?, 'run.create')`);
  change.run('c1', AT, AT, 'k1', 'r1');
  change.run('c2', AT, AT, 'k2', 'r2');
  conn.close();
  return file;
}

test('restoring an SSH-era backup settles rounds on removed machines without asking or rebinding them', async (t) => {
  const s = stage(t, {});
  restoreBackup(s.dataDir, oldBackup(t));
  const service = await s.start();
  const { ledger } = service;

  // Since version 24 only joined node identities are machines. These old SSH rounds
  // have none; creating an account or a machine with the old name cannot recover one.
  await sleep(200);
  assert.deepEqual(s.remote.calls, [], '旧机器没有节点身份，不向任何机器发请求');
  for (const [id, name, task] of [['r1', 't1', 'k1'], ['r2', 't2', 'k2']] as const) {
    const run = ledger.getRun(id);
    assert.equal(run.state, 'ended', id);
    assert.equal(run.exit_kind, 'lost', id);
    assert.equal(JSON.parse(run.error_json!).lost.basis, 'removed');
    assert.equal(run.login_id, null, '未结束的旧轮次清除悬空登录引用');
    assert.equal(run.login_name, name);
    assert.equal(loginMissing(run), false, id);
    assert.equal(ledger.getTask(task).state, 'held', '恢复的任务等主人确认，不自动派发');
    assert.equal(ledger.listChanges({ taskId: task }).filter(({ action }) => action === 'run.settle').length, 1);
    assert.equal(ledger.listChanges({ taskId: task }).some(({ action }) => action === 'task.continue'), false);
  }
  assert.equal(unreachableSince(ledger.getRun('r2')), undefined);
  assert.deepEqual(service.runner.lostCandidates(), []);
  const before = ['r1', 'r2'].map((id) => ledger.getRun(id));

  const browser = await signIn(service);
  const overview = (await (await browser.get('/api/overview')).json()) as { restore: { missing_logins: string[]; runs: { id: string; state: string; exit_kind: string | null }[] } };
  assert.deepEqual(overview.restore.missing_logins, []);
  assert.deepEqual(overview.restore.runs.map(({ id, state, exit_kind }) => [id, state, exit_kind]), [['r1', 'ended', 'lost'], ['r2', 'ended', 'lost']]);
  const { checks } = (await (await browser.get('/api/doctor')).json()) as { checks: { id: string }[] };
  assert.equal(checks.some(({ id }) => id.startsWith('login-missing:')), false);
  const page = (await (await browser.get('/api/tasks/k1')).json()) as { task: { state: string; lost?: unknown } };
  assert.equal(page.task.state, 'held');
  assert.equal(page.task.lost, undefined, '恢复后停住的任务不再显示等待核实');

  holdMachine(ledger, testMachine('h1'), { actor: 'console' });
  // Named the same as the old objects, which no new object may inherit: an account whose login
  // the owner types is the one a page makes (docs/design/native-login.md §5).
  for (const name of ['t1', 't2']) {
    const response = await browser.post('/api/accounts', { name, executor: 'codex', credential: 'token-' + name, tiers: { execute: codexTier('m') } });
    assert.equal(response.status, 201);
    const { account } = await response.json() as { account: { id: string } };
    assert.notEqual(account.id, name);
  }
  await sleep(200);
  assert.deepEqual(['r1', 'r2'].map((id) => ledger.getRun(id)), before, '同名新对象不改变旧轮次');
  // A machine that joins is inventoried like any other; what must not happen is a question about the old rounds.
  assert.deepEqual(s.remote.calls.filter(({ runId }) => runId === 'r1' || runId === 'r2'), [], '不向新接入的同名机器问旧轮次');
});

test('a login the owner deleted is a removed machine, not a missing configuration', async (t) => {
  const s = stage(t);
  const service = await s.start();
  const run = await s.launched(service, s.queued(service));
  const calls = s.remote.calls.length;
  service.ledger.deleteMachineLogin('h1', 'claude', { actor: 'console' });
  await until(() => service.ledger.getRun(run.id).state === 'ended', '删掉目标以后，它上面的 Run 按机器被移除结算');
  assert.equal(JSON.parse(service.ledger.getRun(run.id).error_json!).lost.basis, 'removed');
  assert.equal(loginMissing(service.ledger.getRun(run.id)), false);
  assert.deepEqual(s.remote.calls.slice(calls).filter(({ script, runId }) => script === 'stop.sh' && runId === run.id), [], '不看就能下的判定');
});
