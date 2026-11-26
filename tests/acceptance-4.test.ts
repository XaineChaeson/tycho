// Guards against §11 group 4: two channels both answering one question, an answer landing
// on a question no longer asked, a half-filled answer sheet being taken, and an Input whose
// execution is unknown being sent again. End to end: real ledger, fake CLI, fake instance,
// HTTP; a crash on each side of the commit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signIn, stage, until } from './stage.ts';
import type { Service } from './stage.ts';

const options = { timeout: 90_000 };
const SENTENCE = '只接受当前问题的第一份完整答卷；不自动重送已绑定输入';
const ANSWER_FLOOR = '底线“答复校验”';
const INPUT_FLOOR = '底线“实际输入快照”';
const USER = { actor: 'test' };

async function asking(s: ReturnType<typeof stage>, service: Service) {
  service.ledger.setWhitelist({ ...service.ledger.getWhitelist(), wecom: ['zhang'] }, USER);
  const task = s.queued(service);
  const run = await s.launched(service, task);
  s.remote.finish(run.id, { status: 'waiting', ask: [{ question: '选哪个？', options: ['甲', '乙'] }] });
  await until(() => service.ledger.getTask(task.id).state === 'waiting_person', '等人答复');
  const approval = service.ledger.listApprovals(task.id)[0]!;
  return { task, run, approval };
}

test(`${SENTENCE}（双通道同时答复）`, options, async (t) => {
  const s = stage(t);
  const service = await s.start({ dispatchIntervalMs: 200 });
  const { task, approval } = await asking(s, service);
  const client = await signIn(service);
  const wecom = service.ledger.answerApproval(approval.id, ['甲'], 'zhang', 'wecom');
  const late = await client.post(`/api/approvals/${approval.id}/answer`, { answers: ['乙'] });
  assert.equal(wecom.status, 'accepted');
  assert.equal(late.status, 409, `${ANSWER_FLOOR}：第二份答卷也被接受了`);
  assert.deepEqual(JSON.parse(service.ledger.listApprovals(task.id)[0]!.answers_json!), ['甲']);
  assert.equal(service.ledger.listInputs(task.id).length, 1);
});

test(`${SENTENCE}（答复提交前崩溃）`, options, async (t) => {
  const s = stage(t);
  const first = await s.start();
  const { task, approval } = await asking(s, first);
  const client = await signIn(first);
  const crashed = s.crashAt('approval.answer', 'before');
  assert.equal((await client.post(`/api/approvals/${approval.id}/answer`, { answers: ['乙'] })).status, 503);
  await crashed;
  await s.wreck(first);

  const service = await s.start();
  assert.equal(service.ledger.listApprovals(task.id)[0]!.state, 'open', '没确认的答卷不能算数');
  assert.equal(service.ledger.getTask(task.id).state, 'waiting_person');
  assert.equal(service.ledger.answerApproval(approval.id, ['甲'], 'zhang', 'wecom').status, 'accepted');
});

test(`${SENTENCE}（答复提交后崩溃）`, options, async (t) => {
  const s = stage(t);
  const first = await s.start();
  const { task, approval } = await asking(s, first);
  const client = await signIn(first);
  const crashed = s.crashAt('approval.answer', 'after');
  await client.post(`/api/approvals/${approval.id}/answer`, { answers: ['乙'] });
  await crashed;
  await s.wreck(first);

  const service = await s.start();
  assert.deepEqual(service.ledger.answerApproval(approval.id, ['甲'], 'zhang', 'wecom'), { status: 'closed' }, `${ANSWER_FLOOR}：崩溃后第二份答卷被接受`);
  assert.deepEqual(JSON.parse(service.ledger.listApprovals(task.id)[0]!.answers_json!), ['乙']);
  const next = await until(() => s.runsOf(service, task)[1], '答案绑定到下一次 Run');
  assert.deepEqual(s.snapshotOf(next).inputs?.map(({ text }) => JSON.parse(text)[0].answer), ['乙'], `${INPUT_FLOOR}：答案没进下一次 Run 的快照`);
});

test(`${SENTENCE}（旧问题和不完整的答卷）`, options, async (t) => {
  const s = stage(t);
  const service = await s.start();
  const { task, approval } = await asking(s, service);
  const client = await signIn(service);
  assert.equal((await client.post(`/api/approvals/${approval.id}/answer`, { answers: ['  '] })).status, 400, `${ANSWER_FLOOR}：不完整的答卷被接受`);
  assert.equal(service.ledger.listApprovals(task.id)[0]!.state, 'open');

  service.ledger.updateTask(task.id, { goal: '换个目标' }, USER);
  assert.equal(service.ledger.getTask(task.id).state, 'held');
  assert.equal((await client.post(`/api/approvals/${approval.id}/answer`, { answers: ['甲'] })).status, 409, `${ANSWER_FLOOR}：旧问题被答复`);
  assert.deepEqual(service.ledger.answerApproval(approval.id, ['甲'], 'zhang', 'wecom'), { status: 'closed' });
  assert.equal(service.ledger.listInputs(task.id).length, 0, '旧问题的答复不能变成 Input');
});

test(`${SENTENCE}（绑定 Input 提交前崩溃）`, options, async (t) => {
  const s = stage(t);
  const first = await s.start({ dispatchIntervalMs: 60_000 });
  const task = s.queued(first);
  const input = first.ledger.addInput(task.id, '补充要求', USER);
  await s.stop(first);

  const crashed = s.crashAt('run.create', 'before');
  const second = await s.start();
  await crashed;
  await s.wreck(second);

  const service = await s.start();
  const run = await until(() => s.runsOf(service, task)[0], '重新派发');
  assert.deepEqual(s.snapshotOf(run).inputs?.map(({ id }) => id), [input]);
  assert.equal(service.ledger.listInputs(task.id)[0]!.run_id, run.id);
});

test(`${SENTENCE}（绑定 Input 提交后崩溃：执行不明）`, options, async (t) => {
  const s = stage(t);
  const first = await s.start({ dispatchIntervalMs: 60_000 });
  const task = s.queued(first);
  const input = first.ledger.addInput(task.id, '补充要求', USER);
  await s.stop(first);

  const crashed = s.crashAt('run.create', 'after');
  const second = await s.start();
  await crashed;
  await s.wreck(second);

  const service = await s.start();
  const client = await signIn(service);
  const old = s.runsOf(service, task)[0]!;
  assert.equal(service.ledger.getRun(old.id).state, 'unknown');
  assert.equal((await client.post(`/api/tasks/${task.id}/interrupt`)).status, 200);
  assert.equal((await client.post(`/api/tasks/${task.id}/resume`)).status, 200);
  const next = await until(() => s.runsOf(service, task)[1], '人决定继续后的新 Run');
  assert.deepEqual(s.snapshotOf(next).inputs, [], `${INPUT_FLOOR}：执行不明的 Input 被自动重送`);
  const [row] = service.ledger.listInputs(task.id);
  assert.equal(row!.id, input);
  assert.equal(row!.state, 'attached');
  assert.equal(row!.run_id, old.id, '绑定不能改到新 Run 上');
  const page = (await (await client.get(`/api/tasks/${task.id}`)).json()) as { inputs: { state: string; run_id: string }[] };
  assert.deepEqual(page.inputs.map(({ state, run_id }) => [state, run_id]), [['attached', old.id]]);
});
