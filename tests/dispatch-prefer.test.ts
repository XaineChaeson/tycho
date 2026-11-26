// Guards dispatch against the preference layers being flattened into one another
// (docs/design/roles-and-tiers.md §11): the tier's global order ignored in favour of a
// project's list order; the Router's preference not tried first, or still waited on after
// all of it is used up instead of falling back to the order; a preference naming a login
// without the tier taken as a reason to wait; a pinned Task moved by a preference; the
// wait a Task reports changing when no group has anything; and a second review of one
// product not going to an executor that has not seen it, or waiting on that group when it
// is full instead of falling back to the order. And a preference dropped by a rework or by
// a review rejection that escalates the Task to the decide tier.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import type { Account, LoginStore } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { DISPATCH_TUNED, claudeTier, codexTier, DONE, dshTier, fixture, readOnlyEverywhere, tuned, USER } from './helpers.ts';

const A: Account = { id: 'a', name: 'a', executor: 'claude', tiers: { execute: claudeTier('/a.json'), decide: claudeTier('/ad.json') } };
const B: Account = { id: 'b', name: 'b', executor: 'codex', tiers: { execute: codexTier('execute'), decide: codexTier('decide') } };
const C: Account = { id: 'c', name: 'c', executor: 'codex', tiers: { decide: codexTier('decide') } };

function setup(t: TestContext) {
  const f = fixture(t);
  for (const account of [A, B, C]) f.ledger.putAccount(account, USER, `ref-${account.id}`);
  // Read through the ledger: the owner's change to an account (its ceiling, say) is a row
  // there, and the dispatcher must see it as the owner left it.
  const store: LoginStore = {
    get: (id) => f.ledger.getAccount(id) ?? f.ledger.listMachineLogins().find((login) => login.id === id),
    list: () => [...f.ledger.listAccounts(), ...f.ledger.listMachineLogins()],
  };
  const machines = { get: (id: string) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() };
  const everywhere = readOnlyEverywhere(machines);
  const launched: string[] = [];
  const dispatcher = createDispatcher({
    ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    logins: store,
    machines: everywhere.machines,
    reported: everywhere.reported,
    executors: ADAPTERS,
    runner: {
      findMachine: async (_login, offered) => offered[0],
      launch: async (run) => { launched.push(run.id); },
      watch: async () => {},
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
    },
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  const order = (tier: string, ids: string[]): unknown =>
    f.ledger.writeTunable(`dispatch.order.${tier}`, { from: null, to: ids, override: true }, USER);
  const make = (fields: { loginId?: string; prefer?: { loginIds: string[]; reason: string } } = {}) => {
    const task = f.ledger.createTask({
      projectId: f.projectId, title: '任务', goal: '目标', acceptance: '测试通过', roleId: 'implement', ...fields,
    }, USER);
    f.ledger.queueTask(task.id, USER);
    return f.task(task.id);
  };
  return { f, dispatcher, launched, order, make };
}

// A reviewer that is not the author: codex, which a claude round's product may go to.
const REJECT = { status: 'done', summary: '不行', verdict: { result: 'reject', summary: '漏了', violations: [{ requirement: 'r', evidence: 'e', scope: 's' }] } };
// A read-only round's machine found the code as it was before the round.
const SAME = { codeCheck: { result: 'same' } } as const;
// The author's executor is neither of the reviewers': a product written by dsh can be
// reviewed by claude and by codex, which is what a second review needs.
const DSH: Account = { id: 'd', name: 'd', executor: 'dsh', tiers: { execute: dshTier('execute'), decide: dshTier('decide') } };

// A reviewed Task whose round was written by dsh, ready to bind reviews to.
async function reviewedByDsh(s: ReturnType<typeof setup>): Promise<{ task: string; run: string; registration: string }> {
  s.f.ledger.putAccount(DSH, USER, 'ref-d');
  const task = s.make({ loginId: DSH.id });
  await s.dispatcher.tick();
  const run = s.f.ledger.listRuns(task.id)[0]!;
  s.f.ledger.markRunRunning(run.id);
  s.f.ledger.settleRun(run.id, 0, DONE);
  return { task: task.id, run: run.id, registration: s.f.ledger.registerArtifacts(run.id, []) };
}

// A review of that product, bound as the host does it and waiting in the queue.
function queueReview(s: ReturnType<typeof setup>, reviewed: { task: string; run: string; registration: string }): string {
  const review = s.f.ledger.createTask({
    projectId: s.f.projectId, title: '审', goal: '审', acceptance: '结论', roleId: 'review',
    reviewOf: { taskId: reviewed.task, runId: reviewed.run, revision: s.f.task(reviewed.task).revision, registration: reviewed.registration },
  }, USER);
  s.f.ledger.queueTask(review.id, USER);
  return review.id;
}

const preferred = (f: ReturnType<typeof setup>['f'], id: string): string[] =>
  (JSON.parse(f.task(id).prefer_json!) as { login_ids: string[] }).login_ids;

test('the tier order decides, not the project list order', async (t) => {
  const { f, dispatcher, order, make } = setup(t);
  f.ledger.setProjectLogins(f.projectId, [A.id, B.id], USER);
  order('execute', [B.id, A.id]);
  const task = make();
  await dispatcher.tick();
  const [run] = f.ledger.listRuns(task.id);
  assert.equal(run!.login_id, B.id);
  assert.equal(f.ledger.placementOf(run!.id), 'order');
});

test('legacy Router preference does not override strict owner order', async (t) => {
  const { f, dispatcher, order, make } = setup(t);
  f.ledger.setProjectLogins(f.projectId, [A.id, B.id], USER);
  order('execute', [B.id, A.id]);
  const task = make({ prefer: { loginIds: [A.id], reason: '这类活更适合它' } });
  await dispatcher.tick();
  const [run] = f.ledger.listRuns(task.id);
  assert.equal(run!.login_id, B.id);
  assert.equal(f.ledger.placementOf(run!.id), 'order');
});

test('a preference whose login is used up falls back to the order instead of waiting', async (t) => {
  const { f, dispatcher, order, make } = setup(t);
  f.ledger.putAccount({ ...A, maxRuns: 0 }, USER, 'ref-a');
  order('execute', [A.id, B.id]);
  const task = make({ prefer: { loginIds: [A.id], reason: '先找它' } });
  await dispatcher.tick();
  const [run] = f.ledger.listRuns(task.id);
  assert.equal(run!.login_id, B.id, '优先名单的登录跑满时退回全局顺序');
  assert.equal(f.ledger.placementOf(run!.id), 'order');
});

test('a preference naming a login without the tier is ignored, not waited on', async (t) => {
  const { f, dispatcher, order, make } = setup(t);
  f.ledger.setProjectLogins(f.projectId, [A.id, B.id, C.id], USER);
  order('execute', [C.id, B.id, A.id]);
  const task = make({ prefer: { loginIds: [C.id], reason: '它只填了决策档' } });
  await dispatcher.tick();
  const [run] = f.ledger.listRuns(task.id);
  assert.equal(run!.login_id, B.id);
  assert.equal(f.ledger.placementOf(run!.id), 'order');
});

test('a pinned Task goes to its login whatever the preference says', async (t) => {
  const { f, dispatcher, order, make } = setup(t);
  f.ledger.setProjectLogins(f.projectId, [A.id, B.id], USER);
  order('execute', [B.id, A.id]);
  const task = make({ loginId: A.id, prefer: { loginIds: [B.id], reason: '偏好不该动钉住的任务' } });
  await dispatcher.tick();
  const [run] = f.ledger.listRuns(task.id);
  assert.equal(run!.login_id, A.id);
  assert.equal(f.ledger.placementOf(run!.id), 'pinned');
});

test('when no group has a login left the wait still names every candidate', async (t) => {
  const { f, dispatcher, make } = setup(t);
  f.ledger.setProjectLogins(f.projectId, [A.id, B.id], USER);
  f.ledger.putAccount({ ...A, maxRuns: 0 }, USER, 'ref-a');
  f.ledger.putAccount({ ...B, maxRuns: 0 }, USER, 'ref-b');
  const task = make({ prefer: { loginIds: [A.id], reason: '先找它' } });
  await dispatcher.tick();
  assert.equal(f.ledger.listRuns(task.id).length, 0, '一组都挑不出时不派');
  const wait = dispatcher.waitOf(f.task(task.id));
  assert.deepEqual(wait?.full, ['a', 'b']);
  assert.equal(wait?.rest, null);
});

test('a second review of one product goes to an executor that has not seen it, and is placed by the spread', async (t) => {
  const s = setup(t);
  const reviewed = await reviewedByDsh(s);
  const first = queueReview(s, reviewed);
  await s.dispatcher.tick();
  const firstRun = s.f.ledger.listRuns(first)[0]!;
  assert.equal(firstRun.login_id, A.id, '第一个审阅按全局顺序');
  assert.equal(s.f.ledger.placementOf(firstRun.id), 'order');
  const second = queueReview(s, reviewed);
  await s.dispatcher.tick();
  const secondRun = s.f.ledger.listRuns(second)[0]!;
  assert.equal(secondRun.login_id, B.id, 'claude 已经审过这一份产物：第二个审阅找 codex');
  assert.equal(s.f.ledger.placementOf(secondRun.id), 'spread');
});

test('a spread group at its ceiling falls back to the order instead of waiting', async (t) => {
  const s = setup(t);
  const reviewed = await reviewedByDsh(s);
  // Only these three, so that no other login of an executor that has not reviewed it is there.
  s.f.ledger.setProjectLogins(s.f.projectId, [A.id, B.id, DSH.id], USER);
  const first = queueReview(s, reviewed);
  await s.dispatcher.tick();
  const firstRun = s.f.ledger.listRuns(first)[0]!;
  assert.equal(firstRun.login_id, A.id);
  // Every login that has not seen the product is full: the review goes on to the order's
  // first login, which has reviewed it before, rather than wait for what cannot come.
  s.f.ledger.putAccount({ ...B, maxRuns: 0 }, USER, 'ref-b');
  const second = queueReview(s, reviewed);
  await s.dispatcher.tick();
  const secondRun = s.f.ledger.listRuns(second)[0]!;
  assert.equal(secondRun.login_id, A.id);
  assert.equal(s.f.ledger.placementOf(secondRun.id), 'order');
});

test('legacy preference metadata survives rework_task while placement keeps owner order', async (t) => {
  const { f, dispatcher, order, make } = setup(t);
  f.ledger.setProjectLogins(f.projectId, [A.id, B.id], USER);
  order('execute', [B.id, A.id]);
  const task = make({ prefer: { loginIds: [A.id], reason: '先找它' } });
  await dispatcher.tick();
  const run = f.ledger.listRuns(task.id)[0]!;
  assert.equal(run.login_id, B.id);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE);
  assert.equal(f.task(task.id).state, 'ready');
  f.ledger.reworkTask(task.id, '再改一遍', f.task(task.id).revision, USER);
  const reworked = f.task(task.id);
  assert.equal(reworked.state, 'queued');
  assert.deepEqual(preferred(f, task.id), [A.id], '退回重做保留历史偏好字段');
  await dispatcher.tick();
  const next = f.ledger.listRuns(task.id).at(-1)!;
  assert.equal(next.login_id, B.id);
  assert.equal(f.ledger.placementOf(next.id), 'order');
});

test('legacy preference metadata survives review rejection while placement follows owner order', async (t) => {
  const s = setup(t);
  const { f, dispatcher, order, make } = s;
  f.ledger.setProjectLogins(f.projectId, [A.id, B.id], USER);
  order('execute', [B.id, A.id]);
  order('decide', [B.id, A.id]);
  const task = make({ prefer: { loginIds: [A.id], reason: '先找它' } });
  await dispatcher.tick();
  const authorRun = f.ledger.listRuns(task.id)[0]!;
  assert.equal(authorRun.login_id, B.id);
  f.ledger.markRunRunning(authorRun.id);
  f.ledger.settleRun(authorRun.id, 0, DONE);
  // codex wrote this product, so the review prefers claude; rejecting it leaves the Task ready
  // for the Router/owner to decide next steps without auto-escalating or auto-requeuing.
  const registration = f.ledger.registerArtifacts(authorRun.id, []);
  const review = queueReview(s, { task: task.id, run: authorRun.id, registration });
  await dispatcher.tick();
  const reviewRun = f.ledger.listRuns(review)[0]!;
  assert.equal(reviewRun.login_id, A.id);
  f.ledger.markRunRunning(reviewRun.id);
  f.ledger.settleRun(reviewRun.id, 0, REJECT as never, SAME);
  const rejected = f.task(task.id);
  assert.equal(rejected.state, 'ready');
  assert.equal(rejected.tier, 'execute');
  assert.deepEqual(preferred(f, task.id), [A.id], '审阅打回保留历史偏好字段');
  // Reworking and moving the Task to the decide tier follows owner order.
  f.ledger.updateTask(task.id, { tierOverride: { tier: 'decide', reason: '升档返工' } }, USER);
  f.ledger.reworkTask(task.id, '按审阅意见修改', rejected.revision, USER);
  await dispatcher.tick();
  const next = f.ledger.listRuns(task.id).at(-1)!;
  assert.equal(next.login_id, B.id);
  assert.equal(f.ledger.placementOf(next.id), 'order');
});

test('the spread group knows which executors already reviewed this product', (t) => {
  const { f } = setup(t);
  const binding = JSON.stringify({ task_id: 'base', run_id: 'base-run', revision: 1, commits: [], files: [], writers: ['dsh'] });
  const prior = f.ledger.createTask({ projectId: f.projectId, title: '先审的', goal: '审', acceptance: '结论', roleId: 'implement' }, USER);
  f.force('UPDATE task SET review_of_json = ? WHERE id = ?', binding, prior.id);
  f.force(
    `INSERT INTO run (id, created_at, task_id, task_revision, host, state, marker, snapshot_json)
     VALUES ('prior', ?, ?, 1, 'h1', 'ended', 'm', ?)`,
    new Date().toISOString(), prior.id, JSON.stringify({ executor: 'claude' }),
  );
  const current = f.ledger.createTask({ projectId: f.projectId, title: '再审的', goal: '审', acceptance: '结论', roleId: 'implement' }, USER);
  f.force('UPDATE task SET review_of_json = ? WHERE id = ?', binding, current.id);
  assert.deepEqual(f.ledger.spreadExecutorsOf(f.ledger.getTask(current.id)), ['claude']);
  assert.deepEqual(f.ledger.spreadExecutorsOf(f.ledger.getTask(prior.id)), [], '自己的轮次不算“别人审过”');
});
