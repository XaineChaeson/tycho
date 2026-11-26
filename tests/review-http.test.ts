// Guards review on the console's side (docs/design/roles-and-tiers.md §4, §6). Against: the
// page's "验收通过" going past the review gate; the owner's "不经审阅验收" not reaching the
// ledger as such, or leaving no line on the timeline; the task page not saying why a Task
// cannot be accepted yet, what a review is bound to and what it concluded, or when a
// rejection moved a Task up a tier.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEEDS_PASS_TEXT } from '../shared/review.ts';
import { consoleApp } from './console-helpers.ts';
import { claudeTier, content, DONE, LOGIN, RUN_LIMIT_MS, USER } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();
const REJECT = { status: 'done', summary: '不行', verdict: { result: 'reject', summary: '漏了一条', violations: [{ requirement: '测试通过', evidence: '两条失败', scope: 'a.ts' }] } };

test('the page cannot accept past the gate; the owner accepts without review, on the record', async (t) => {
  const { f, get, post } = await consoleApp(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const page = await json(await get(`/api/tasks/${task.id}`));
  assert.deepEqual([page.review.needs_review, page.review.blocked], [true, NEEDS_PASS_TEXT]);
  const refused = await post(`/api/tasks/${task.id}/accept`, { basis: '看过了' });
  assert.equal(refused.status, 400);
  assert.match((await json(refused)).error, /要独立审阅/);
  assert.equal(f.task(task.id).state, 'ready');
  assert.equal((await post(`/api/tasks/${task.id}/accept`, { basis: '看过了', without_review: 'yes' })).status, 400);
  assert.equal((await post(`/api/tasks/${task.id}/accept`, { basis: '只有一个执行器，我看过了', without_review: true })).status, 200);
  assert.equal(f.task(task.id).state, 'done');
  const accepted = f.peek<{ actor: string; detail_json: string }>(`SELECT actor, detail_json FROM change WHERE action = 'task.accept'`);
  assert.deepEqual(accepted.map(({ actor, detail_json }) => [actor, JSON.parse(detail_json).without_review]), [['console', true]]);
});

test('the task pages show what a review is bound to and its verdict without auto-escalating', async (t) => {
  const { f, get } = await consoleApp(t);
  f.ledger.putAccount({ id: 't2', name: 't2', executor: 'codex', tiers: { execute: content('model=x'), decide: content('model=y') } }, USER, 'ref-t2');
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const registration = f.ledger.registerArtifacts(run.id, []);
  const review = f.ledger.createTask({ projectId: f.projectId, title: '审', goal: '审', acceptance: '结论', roleId: 'review', reviewOf: { taskId: task.id, runId: run.id, revision: 1, registration } }, USER);
  f.ledger.queueTask(review.id, USER);
  const round = f.ledger.createRun(review.id, {
    login: f.ledger.getAccount('t2')!, machine: f.ledger.getMachine(LOGIN.machine.id)!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', tier: 'execute', tier_value: claudeTier('/d') }, expectedRevision: 1,
  }, USER);
  f.ledger.markRunRunning(round.id);
  f.ledger.settleRun(round.id, 0, REJECT as never, { codeCheck: { result: 'same' } });
  const reviewPage = await json(await get(`/api/tasks/${review.id}`));
  assert.deepEqual(
    [reviewPage.review.of.task_id, reviewPage.review.of.run_id, reviewPage.review.of.writers, reviewPage.review.of.reviewed_title, reviewPage.review.verdict.result, reviewPage.review.verdict.current],
    [task.id, run.id, ['claude'], task.title, 'reject', true],
  );
  const taskPage = await json(await get(`/api/tasks/${task.id}`));
  assert.deepEqual(taskPage.review.reviews.map(({ id, verdict }: { id: string; verdict: { result: string } }) => [id, verdict.result]), [[review.id, 'reject']]);
  assert.deepEqual(taskPage.review.escalations, []);
  assert.deepEqual([taskPage.task.tier, taskPage.task.tier_source], ['execute', 'default']);
});

test('console review request registers and binds one review for concurrent clicks', async (t) => {
  const { f, get, post } = await consoleApp(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const listing = await json(await get('/api/tasks?top=1'));
  assert.equal(listing.tasks.find((row: { id: string }) => row.id === task.id).accept_blocked, NEEDS_PASS_TEXT);
  const responses = await Promise.all([post(`/api/tasks/${task.id}/review`, {}), post(`/api/tasks/${task.id}/review`, {})]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const [first, second] = await Promise.all(responses.map(json));
  assert.equal(first.task_id, second.task_id);
  const page = await json(await get(`/api/tasks/${task.id}`));
  assert.equal(page.task.active_review, first.task_id);
  assert.equal(page.review.reviews.length, 1);
});
