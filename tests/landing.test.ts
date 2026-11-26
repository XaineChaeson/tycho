// Guards a merge round being the ledger's own structure rather than words in its goal, and the
// result of a pull request going in being the same one a local integration leaves
// (docs/design/project-sessions.md 文末 "负责人可以自己做的事"), against:
// - a landing Task recognised by its goal: an edit to the goal losing the round that is already
//   merging the same commit, so a second one is made;
// - landing_json changed by anything but creating the Task, or written on a Task that is not the
//   child of the Task it lands;
// - a merge round that settled with the platform's merge leaving nothing on its parent, or a
//   platform refusal (no commit in the receipt) leaving something there all the same;
// - a round that did not settle ready (a short delivery, a pull request no one can tell) landing
//   its parent all the same;
// - a merge Task's goal, acceptance or scope changed after it was made, which would let it merge
//   another commit while the ledger still records the reviewed one, or a merge Task made to land
//   another Task than its parent;
// - the parent's result written with a different action, detail or push than a local integration:
//   the branch the service cannot know filled in, the reviewed commit taken from the receipt, or
//   the owner told twice (the merged event's push and the integrated result);
// - a subscription to "已合入" not hearing the integration, or hearing the same occurrence twice;
// - a receipt naming several pull requests, or several commits, or an address that is not one,
//   settling as a full delivery instead of stopping for an incomplete one with the same refusal
//   the merge entry uses;
// - a version 32 ledger not taken forward with every old Task landing nothing.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { consoleApp } from './console-helpers.ts';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { createLandingTask, landableOf, landingOf, resolveLandingRole } from '../service/land.ts';
import { openLedger, type RunRow } from '../service/ledger.ts';
import { createTools } from '../service/tools.ts';
import { accepting, DONE, fixture, memoryLogins, RUN_LIMIT_MS, USER, type Fixture } from './helpers.ts';

const PR = 'https://github.com/o/r/pull/7';
const SRC = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);
const PR_SHAPE = '这一轮回执里的 PR 不是一个 PR 或 MR 的网址（https://…/pull/<编号> 或 https://…/-/merge_requests/<编号>）：不合';
const PR_COUNT = (n: number): string => `这一轮的回执里有 ${n} 个 PR：说不清合哪一个，不合`;

// A Task under `parentId` that merges that parent's pull request, made the one way it is made.
function landingChild(f: Fixture, parentId: string, commit = SRC) {
  return f.ledger.createTask({
    projectId: f.projectId,
    parentId,
    roleId: 'verify',
    title: '合入：任务',
    goal: '把 PR 合进去',
    acceptance: '交回合入后的提交',
    landing: { of: parentId, pr: PR, commit },
  }, USER);
}

// One round of a Task that says it settled with `receipt`.
function round(f: Fixture, taskId: string, receipt: Record<string, unknown>): RunRow {
  f.ledger.queueTask(taskId, USER);
  const run = f.ledger.createRun(taskId, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: f.task(taskId).revision }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, receipt as never);
  return f.run(run.id);
}

// A Task waiting to be accepted, as the merge round of one would be before anything is merged.
function readyTask(f: Fixture): string {
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  return task.id;
}

const mergedPushes = (f: Fixture) => f.peek<{ kind: string; state: string }>(
  `SELECT kind, state FROM push WHERE kind IN ('merged', 'integrated') ORDER BY rowid`,
);

test('合入的那一轮结算：父任务上落的和本机并入是同一种结果，订阅听见，主人只收到一条', (t) => {
  const f = fixture(t);
  const parent = f.newTask({ roleId: 'verify' });
  f.force(`UPDATE task SET state = 'done', closed_at = '2026-01-01T00:00:00Z' WHERE id = ?`, parent.id);
  const child = landingChild(f, parent.id);
  assert.deepEqual(JSON.parse(f.task(child.id).landing_json!), { of: parent.id, pr: PR, commit: SRC }, '建任务时把合入的是什么写进账本');
  const heard = f.ledger.createTrigger(f.projectId, { name: '订阅已合入', instruction: '接着处理 {{task_id}}', source: 'event', event: { kind: 'merged' } }, USER);

  round(f, child.id, { status: 'done', summary: '合了', artifacts: [{ kind: 'report', ref: 'r.md' }, { kind: 'commit', ref: MERGED }] });

  assert.equal(f.task(child.id).state, 'done', '合入成功后子任务直接关闭为已完成');
  assert.ok(f.task(child.id).closed_at !== null);
  assert.equal(f.peek(`SELECT 1 FROM push WHERE kind = 'work_ready'`).length, 0, '不把已并入的父任务再拉回待验收');
  const lines = f.peek<{ task_id: string; run_id: string | null; detail_json: string }>(
    `SELECT task_id, run_id, detail_json FROM change WHERE action = 'task.integrate'`,
  );
  assert.equal(lines.length, 1, '父任务上留一行并入');
  assert.equal(lines[0]!.task_id, parent.id);
  assert.deepEqual(JSON.parse(lines[0]!.detail_json), {
    branch: null,
    commit: MERGED,
    source_commit: SRC,
    pr: PR,
    landing_task_id: child.id,
  }, '基准分支不知道就写 null，审过的提交从 landing_json 来，合入后的提交从回执来');

  const fires = f.ledger.listTriggerFires({ triggerId: heard.id, limit: 10 });
  assert.equal(fires.length, 1, '订阅“已合入”的触发器听见了');
  assert.equal(fires[0]!.event_id, `task.integrate:${parent.id}:${MERGED}`, '并入主线的编号用自己的一格前缀');
  assert.equal(fires[0]!.data.task_id, parent.id);
  assert.equal(fires[0]!.data.commit, MERGED);
  assert.equal(fires[0]!.data.branch, null);

  assert.deepEqual(mergedPushes(f).map(({ kind }) => kind), ['integrated'], '一件事只有一条推送：并入的成果，没有第二条“合入”');
  assert.deepEqual(f.peek<{ kind: string }>(`SELECT kind FROM outbox WHERE kind IN ('merged', 'integrated') ORDER BY rowid`).map(({ kind }) => kind), ['integrated']);
});

test('合入子任务按账本里的结构认，不按目标文字：目标被改也还认得，结束后才能再建一个', (t) => {
  const f = fixture(t);
  const parent = f.newTask();
  const child = landingChild(f, parent.id);
  f.ledger.queueTask(child.id, USER);
  const of = () => landingOf(f.ledger.listTasks({ projectId: f.projectId }), parent.id, SRC)?.id;

  assert.equal(of(), child.id, '同一个提交的合入任务还在，就返回它');
  // The ledger refuses to edit it through updateTask; a ledger written by an older program may
  // still hold another goal, and the structure is what recognition reads.
  f.force(`UPDATE task SET goal = ? WHERE id = ?`, '把 PR 合进去，这次换个说法', child.id);
  assert.equal(f.task(child.id).landing_json, JSON.stringify({ of: parent.id, pr: PR, commit: SRC }), '目标改了它也不变');
  assert.equal(of(), child.id, '目标被改过也还认得');

  f.force(`UPDATE task SET state = 'done' WHERE id = ?`, child.id);
  assert.equal(of(), undefined, '结束之后不再算在');
  const again = landingChild(f, parent.id);
  assert.notEqual(again.id, child.id, '结束后可以再建一个合入任务');
  assert.equal(of(), again.id);
});

test('合入子任务可以更新目标、验收标准、范围和优先级，且保留 landing_json 结构', (t) => {
  const f = fixture(t);
  const parent = f.newTask();
  const child = landingChild(f, parent.id);
  const beforeLanding = f.task(child.id).landing_json;
  f.ledger.updateTask(child.id, { goal: '合另一个提交', acceptance: '标准换了', scope: '范围换了', priority: 5 }, USER);
  const after = f.task(child.id);
  assert.equal(after.goal, '合另一个提交');
  assert.equal(after.priority, 5);
  assert.equal(after.landing_json, beforeLanding, 'landing_json 结构不受字段编辑影响');
});

test('合入子任务要并入的那个任务必须是它的父任务', (t) => {
  const f = fixture(t);
  const parent = f.newTask();
  const other = f.newTask();
  assert.throws(
    () => f.ledger.createTask({
      projectId: f.projectId,
      parentId: other.id,
      roleId: 'verify',
      title: '合入：任务',
      goal: '把 PR 合进去',
      acceptance: '交回合入后的提交',
      landing: { of: parent.id, pr: PR, commit: SRC },
    }, USER),
    /合入任务要把它并入的那一个任务作为父任务/,
  );
});

test('父任务只在那一轮结算为待验收且回执有提交时落结果：平台没合、回执说没成时不落；缺报告或多提交照常落结果', async (t) => {
  for (const [what, receipt, state, reason] of [
    ['回执里没有提交', { status: 'done', summary: '没合', artifacts: [{ kind: 'report', ref: 'r.md' }] }, 'held', /没合/],
    ['回执说没有完成', { status: 'failed', summary: '平台拒绝', artifacts: [{ kind: 'report', ref: 'r.md' }, { kind: 'commit', ref: MERGED }] }, 'held', /平台拒绝/],
  ] as const) {
    await t.test(what, (sub) => {
      const f = fixture(sub);
      const parent = f.newTask({ roleId: 'verify' });
      f.force(`UPDATE task SET state = 'done', closed_at = '2026-01-01T00:00:00Z' WHERE id = ?`, parent.id);
      const child = landingChild(f, parent.id);
      const heard = f.ledger.createTrigger(f.projectId, { name: '订阅', instruction: '处理', source: 'event', event: { kind: 'merged' } }, USER);

      round(f, child.id, receipt as never);
      const now = f.task(child.id);
      assert.equal(now.state, state, what);
      if (reason !== undefined) assert.match(now.reason!, reason);
      assert.deepEqual(f.peek(`SELECT 1 FROM change WHERE action = 'task.integrate'`), [], '父任务上没有并入');
      assert.equal(f.ledger.listTriggerFires({ triggerId: heard.id, limit: 10 }).length, 0, '也没有“已合入”事件');
      assert.deepEqual(mergedPushes(f), [], '也没有推给主人');
    });
  }
  for (const [what, receipt] of [
    ['回执说完成但缺报告', { status: 'done', summary: '合了', artifacts: [{ kind: 'commit', ref: MERGED }] }],
    ['回执说完成且报了两个提交', { status: 'done', summary: '合了', artifacts: [{ kind: 'report', ref: 'r.md' }, { kind: 'commit', ref: MERGED }, { kind: 'commit', ref: 'c'.repeat(40) }] }],
  ] as const) {
    await t.test(what, (sub) => {
      const f = fixture(sub);
      const parent = f.newTask({ roleId: 'verify' });
      f.force(`UPDATE task SET state = 'done', closed_at = '2026-01-01T00:00:00Z' WHERE id = ?`, parent.id);
      const child = landingChild(f, parent.id);
      round(f, child.id, receipt as never);
      assert.equal(f.task(child.id).state, 'done', what);
      assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'task.integrate'`).length, 1, '父任务正常落并入结果');
    });
  }
});

test('结算不再因多个 PR 或普通 PR 网址按交付不齐停住，所有完成回执照常进入待验收', async (t) => {
  for (const [what, artifacts] of [
    ['两个 PR', [{ kind: 'report', ref: 'r.md' }, { kind: 'pr', ref: PR }, { kind: 'pr', ref: `${PR}8` }]],
    ['普通网址 PR', [{ kind: 'report', ref: 'r.md' }, { kind: 'pr', ref: 'https://example.com/o/r' }]],
    ['合格的一个 PR', [{ kind: 'report', ref: 'r.md' }, { kind: 'pr', ref: PR }]],
    ['没有 PR 项', [{ kind: 'report', ref: 'r.md' }]],
  ] as const) {
    await t.test(what, (sub) => {
      const f = fixture(sub);
      const id = f.newTask({ roleId: 'verify' }).id;
      round(f, id, { status: 'done', summary: '完成', artifacts });
      assert.equal(f.task(id).state, 'ready', what);
    });
  }
});

test('控制台的本机合并接口已删掉，并入主线入口 POST /api/tasks/:id/integrate 统一走 PR 合入', async (t) => {
  const { f, post } = await consoleApp(t);
  const body = { run_id: 'whatever', name: 'work.bundle', sha256: '0'.repeat(64), bytes: 1, branch: 'main' };
  assert.equal((await post('/api/tasks/whatever/merge', body)).status, 404);
  // Non-existent or non-done/non-PR task is rejected with 400
  assert.equal((await post('/api/tasks/whatever/integrate', {})).status, 400);
  const noPr = readyTask(f);
  f.ledger.acceptTask(noPr, '看过', USER, { withoutReview: true });
  assert.equal((await post(`/api/tasks/${noPr}/integrate`, {})).status, 400);

  // Accepted task with PR creates a landing child task (201), and deduplicates on repeat (200)
  const withPr = f.newTask({ roleId: 'verify' }).id;
  round(f, withPr, { status: 'done', summary: '改好', artifacts: [{ kind: 'report', ref: 'r.md' }, { kind: 'commit', ref: SRC }, { kind: 'pr', ref: PR }] });
  f.ledger.acceptTask(withPr, '看过', USER);
  const firstRes = await post(`/api/tasks/${withPr}/integrate`, {});
  assert.equal(firstRes.status, 201);
  const firstBody = await firstRes.json() as { made: boolean; task_id: string; pr: string; commit: string };
  assert.equal(firstBody.made, true);
  assert.equal(firstBody.pr, PR);
  assert.equal(firstBody.commit, SRC);
  const secondRes = await post(`/api/tasks/${withPr}/integrate`, {});
  assert.equal(secondRes.status, 200);
  const secondBody = await secondRes.json() as { made: boolean; task_id: string; pr: string; commit: string };
  assert.equal(secondBody.made, false);
  assert.equal(secondBody.task_id, firstBody.task_id);
});

// The Router's tool is still an entrance, and only for a round that opened a pull request.
test('integrate_task 只合 PR：没有 PR 时不说并进主机上的检出', async (t) => {
  const f = fixture(t);
  f.ledger.setProjectGrants(f.projectId, ['integrate'], USER);
  const id = readyTask(f);
  f.ledger.acceptTask(id, '看过', USER, { withoutReview: true });
  const tools = createTools({
    ledger: f.ledger,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({ [f.login.login.id]: f.login.login }),
    machines: { list: () => [] },
    accept: accepting(f.ledger),
  });
  const said = await tools.call('integrate_task', { task_id: id }, { actor: 'router' }, { projectId: f.projectId });
  assert.equal(said.isError, true);
  assert.match(said.content[0]!.text, /没有 PR：tycho 不把代码并进主机上的检出/);
});

test('版本 32 的账本升上来：旧任务的 landing_json 都是 null', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-landing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./fixtures/ledger/schema-v32.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '32');
    INSERT INTO project (id, created_at, name) VALUES ('p', 'now', '旧项目');
    INSERT INTO task (id, created_at, project_id, title, goal, state, created_by) VALUES ('t', 'now', 'p', '旧任务', '目标', 'done', 'user');`);
  db.close();
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    assert.equal(ledger.getTask('t').landing_json, null);
  } finally { ledger.close(); }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});

test('resolveLandingRole 按职能属性（可写且交报告）兜底，删掉或改掉 verify 仍可合 PR', () => {
  const custom = {
    id: 'orchestrate',
    name: '协调',
    description: '环境协调与合并',
    default_tier: 'operate' as const,
    permission: 'write' as const,
    deliverable: 'report' as const,
    needs_review: false,
  };
  const readOnlyVerify = {
    id: 'verify',
    name: '验证',
    description: '只读验证',
    default_tier: 'operate' as const,
    permission: 'read' as const,
    deliverable: 'report' as const,
    needs_review: false,
  };
  const resolved = resolveLandingRole([readOnlyVerify, custom]);
  assert.ok('role' in resolved);
  assert.equal(resolved.role.id, 'orchestrate');

  const refused = resolveLandingRole([readOnlyVerify]);
  assert.ok('refusal' in refused);
  assert.match(refused.refusal, /只读/);
});

test('landableOf 和 createLandingTask 统一判断可合入性并防重复合入', (t) => {
  const f = fixture(t);
  const task = f.newTask({ roleId: 'verify' });
  assert.equal(landableOf(f.ledger, task.id).landable, false);

  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', tier: 'operate' }, expectedRevision: 1 }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '开了 PR', artifacts: [{ kind: 'report', ref: 'r.md' }, { kind: 'commit', ref: SRC }, { kind: 'pr', ref: PR }] });
  assert.equal(landableOf(f.ledger, task.id).landable, false, '未验收前不能合入');

  f.ledger.acceptTask(task.id, '验收通过', USER);
  const info = landableOf(f.ledger, task.id);
  assert.deepEqual(info, {
    landable: true,
    pr: PR,
    commit: SRC,
    already_integrated: false,
    active_landing_task_id: null,
    reason: null,
  });

  const first = createLandingTask(f.ledger, task.id, USER);
  assert.equal(first.made, true);
  assert.equal(first.pr, PR);
  assert.equal(first.commit, SRC);
  assert.equal(first.child.state, 'queued');

  const second = createLandingTask(f.ledger, task.id, USER);
  assert.equal(second.made, false);
  assert.equal(second.child.id, first.child.id);
  assert.equal(landableOf(f.ledger, task.id).active_landing_task_id, first.child.id);
  assert.equal(landableOf(f.ledger, task.id).landable, false);

  // Complete landing with merged commit -> child closes to done and parent becomes already_integrated
  const landRun = f.ledger.createRun(first.child.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', tier: 'operate' }, expectedRevision: 1 }, USER);
  f.ledger.markRunRunning(landRun.id);
  f.ledger.settleRun(landRun.id, 0, { status: 'done', summary: '已合入', artifacts: [{ kind: 'report', ref: 'r.md' }, { kind: 'commit', ref: MERGED }] });
  assert.equal(f.task(first.child.id).state, 'done');
  assert.equal(landableOf(f.ledger, task.id).already_integrated, true);
  assert.equal(landableOf(f.ledger, task.id).landable, false);
  assert.throws(() => createLandingTask(f.ledger, task.id, USER), /已经并入主线/);
});
