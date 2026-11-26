// Guards the internal-event source of triggers (docs/design/triggers.md §2.3) against:
// - an event set off by something other than its transition: a round that settles without making
//   its work ready, a work that was ready already; a work of several Tasks said to be done while one
//   of them failed, waits for its time or is still a draft (the page's summary shows "ready" over
//   those, and is not the fact); a return to ready after rework taken as the same event (it is a
//   new one), or an acceptance, merge or release not reaching a subscription;
// - a subscription to one Task matching another Task's event, or missing one of a Task under it;
//   a rule of another kind or another project matching; a disabled or deleted one matching;
// - the event's trigger record and message committed apart from the business transition: a crash
//   before the commit leaving one without the other, or a crash after it leaving the event to be
//   offered twice;
// - an overloaded trigger undoing or blocking the transition, the Router's settlement message or
//   the owner's push, or being retried later; a refusal not counted on its rule;
// - an event that already goes to the Router (a settlement) sent a second time as a trigger
//   message, or every subscription making a turn of its own; independent events not queued
//   through the bounded trigger queue;
// - work a trigger brought about setting off a trigger again: the Task a trigger turn made, and the
//   Task made in the turn of a settlement message a subscription rode on;
// - the owner's push and the trigger reading the event apart: the push key is the event's id;
// - a subscription defined against what the ledger can tell: an unknown kind, another project's
//   Task, a change of source; and push_final ignored for a subscription that rode on a message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createNotify } from '../service/notify.ts';
import type { OutboxRow } from '../service/outbox.ts';
import type { MessageRow } from '../service/messages.ts';
import type { LedgerOptions } from '../service/ledger.ts';
import { DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from '../service/triggers.ts';
import { InputError } from '../service/errors.ts';
import { DONE, fixture, LOGIN, USER, type Fixture } from './helpers.ts';

class Crash extends Error {}

function setup(t: TestContext, policy: Partial<TriggerPolicy> = {}, options: LedgerOptions = {}) {
  const held: TriggerPolicy = { ...DEFAULT_TRIGGER_POLICY, ...policy };
  const f = fixture(t, { triggerPolicy: () => held, ...options });
  const subscribe = (event: Record<string, unknown>, fields: Record<string, unknown> = {}, projectId = f.projectId) =>
    f.ledger.createTrigger(projectId, { name: `订阅-${String(event.kind)}`, instruction: '接着处理 {{task_id}}', source: 'event', event, ...fields }, USER);
  const fires = (triggerId: string) => f.ledger.listTriggerFires({ triggerId, limit: 100 }).reverse();
  const triggerMessages = (): MessageRow[] => f.peek<MessageRow>(`SELECT * FROM message WHERE channel = 'trigger' ORDER BY rowid`);
  const settlement = (runId: string): MessageRow => f.peek<MessageRow>(`SELECT * FROM message WHERE channel = 'internal' AND external_id = ?`, `run:${runId}`)[0]!;
  // What the owner is pushed about, by its key: sent at once or held for its project's window.
  const pushes = (kind: string): string[] => f.peek<{ key: string }>('SELECT key FROM push WHERE kind = ? ORDER BY rowid', kind).map(({ key }) => key);
  return { f, held, subscribe, fires, triggerMessages, settlement, pushes };
}

// A Task of the project, under `parentId` when given.
const makeTask = (f: Fixture, fields: { title: string; parentId?: string }) =>
  f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, goal: '目标', acceptance: '通过', ...fields }, USER);

// A Task that is all its work, one round settled with `receipt`. `ctx` makes the Task.
function round(f: Fixture, receipt: unknown = DONE, taskId?: string, ctx = USER) {
  const id = taskId ?? f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '交付', goal: '目标', acceptance: '通过' }, ctx).id;
  if (taskId === undefined) f.ledger.queueTask(id, USER);
  const run = f.ledger.createRun(id, { ...f.login, snapshot: { ...f.login.snapshot, tier: f.task(id).tier ?? 'execute' } }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, receipt === DONE ? 0 : receipt === null ? 1 : 0, receipt as never);
  return { taskId: id, runId: run.id };
}

const LATER = { status: 'waiting', later: { at: '2099-01-01T00:00:00Z', about: '过会儿再看' } };

// A work of a draft parent and two queued Tasks under it.
function composite(f: Fixture) {
  const parent = makeTask(f, { title: '整项' });
  const a = makeTask(f, { title: '甲', parentId: parent.id });
  const b = makeTask(f, { title: '乙', parentId: parent.id });
  f.ledger.queueTask(a.id, USER);
  f.ledger.queueTask(b.id, USER);
  return { parent, a, b };
}

test('a work of several Tasks is done only when every one of them is: not while one failed or waits for its time', (t) => {
  const { f, subscribe, fires, pushes } = setup(t);
  const ready = subscribe({ kind: 'work_ready' });
  const { parent, a, b } = composite(f);

  round(f, DONE, a.id);
  assert.equal(fires(ready.id).length, 0, '乙还在排队');
  round(f, null, b.id);
  assert.equal(f.task(b.id).state, 'held');
  assert.equal(fires(ready.id).length, 0, '乙失败了，整项没完成');
  assert.deepEqual(pushes('work_ready'), [], '也不提前推给主人');

  f.ledger.resumeTask(b.id, USER);
  round(f, LATER, b.id);
  assert.equal(f.task(b.id).state, 'waiting_timer');
  assert.equal(fires(ready.id).length, 0, '乙在等预约，整项没完成');

  const other = composite(f);
  round(f, DONE, other.a.id);
  makeTask(f, { title: '丙', parentId: other.parent.id });
  round(f, DONE, other.b.id);
  assert.equal(fires(ready.id).length, 0, '还有一个草稿，整项没完成');

  // Every Task done: the first time it is ready, said once, about the top-level Task.
  f.ledger.fireDue(new Date('2099-01-02T00:00:00Z'));
  assert.equal(f.task(b.id).state, 'queued');
  const last = round(f, DONE, b.id);
  assert.deepEqual(fires(ready.id).map((fire) => [fire.event_id, fire.data.task_id]), [[`work-ready:${last.runId}`, parent.id]]);
  assert.deepEqual(pushes('work_ready'), [`work-ready:${last.runId}`]);

  // Sent back and ready again: a new time.
  f.ledger.reworkTask(a.id, '再改改', f.task(a.id).revision, USER);
  const again = round(f, DONE, a.id);
  assert.deepEqual(fires(ready.id).map((fire) => fire.event_id), [`work-ready:${last.runId}`, `work-ready:${again.runId}`]);
});

test('a work ready, ready again after rework, accepted, merged and released each reach their subscription once', (t) => {
  const { f, subscribe, fires } = setup(t);
  const ready = subscribe({ kind: 'work_ready' });
  const accepted = subscribe({ kind: 'accepted' });
  const merged = subscribe({ kind: 'merged' });
  const released = subscribe({ kind: 'released' });

  const failed = round(f, null);
  assert.equal(f.task(failed.taskId).state, 'held');
  assert.equal(fires(ready.id).length, 0, '没就绪的结算不是这件事');

  const first = round(f);
  assert.equal(f.task(first.taskId).state, 'ready');
  f.ledger.reworkTask(first.taskId, '再改改', f.task(first.taskId).revision, USER);
  const again = round(f, DONE, first.taskId);
  assert.deepEqual(fires(ready.id).map((fire) => fire.event_id), [`work-ready:${first.runId}`, `work-ready:${again.runId}`],
    '返工后再次就绪是新的一次');
  assert.deepEqual(fires(ready.id).map((fire) => fire.data.task_id), [first.taskId, first.taskId]);

  f.ledger.acceptTask(first.taskId, '看过了', USER, { withoutReview: true });
  assert.deepEqual(fires(accepted.id).map((fire) => [fire.event_id, fire.data.basis]), [[`accepted:${first.taskId}:1`, '看过了']]);

  f.ledger.noteAction('task.integrate', USER, { taskId: first.taskId }, { branch: 'main', commit: 'c0ffee' });
  assert.deepEqual(
    fires(merged.id).map((fire) => [fire.event_id, fire.data.branch, fire.data.commit]),
    [[`task.integrate:${first.taskId}:c0ffee`, 'main', 'c0ffee']],
    '并入主线是“已合入”：一次入主线一次事件',
  );

  f.ledger.noteReleased('2030-01-01T00:00:00Z', { runId: again.runId, version: '0.2.7' });
  f.ledger.noteReleased('2030-01-02T00:00:00Z', { runId: null, version: '0.2.8' });
  assert.deepEqual(fires(released.id).map((fire) => [fire.event_id, fire.data.version]), [['released:2030-01-01T00:00:00Z', '0.2.7']], '没有任务的上线没有项目');

  for (const rule of [ready, accepted, merged, released]) assert.equal(f.ledger.getTrigger(rule.id)!.rejected, null);
});

test('the push and the trigger read one event: the push goes out under the event id', (t) => {
  const { f, subscribe, fires, pushes } = setup(t);
  const ready = subscribe({ kind: 'work_ready' });
  const merged = subscribe({ kind: 'merged' });
  const accepted = subscribe({ kind: 'accepted' });
  const { taskId } = round(f);
  f.ledger.noteAction('task.integrate', USER, { taskId }, { branch: 'main', commit: 'abc' });
  f.ledger.acceptTask(taskId, '好', USER, { withoutReview: true });
  assert.deepEqual(pushes('work_ready'), [fires(ready.id)[0]!.event_id]);
  assert.deepEqual(pushes('integrated'), [fires(merged.id)[0]!.event_id]);
  assert.equal(fires(accepted.id).length, 1);
  assert.equal(pushes('accepted').length + f.peek(`SELECT 1 FROM outbox WHERE kind = 'accepted'`).length, 0, '验收不推给主人：推送表里没有它');
});

test('a subscription to one Task matches it and the Tasks under it, nothing else', (t) => {
  const { f, subscribe, fires } = setup(t);
  const other = f.ledger.createProject({ name: '别的', loginMode: 'all' }, USER);
  const parent = makeTask(f, { title: '父' });
  const child = makeTask(f, { title: '子', parentId: parent.id });
  const elsewhere = makeTask(f, { title: '旁' });
  const one = subscribe({ kind: 'merged', task_id: parent.id });
  const all = subscribe({ kind: 'merged' });
  const accepts = subscribe({ kind: 'accepted', task_id: parent.id });
  const foreign = subscribe({ kind: 'merged' }, {}, other);
  const off = subscribe({ kind: 'merged' });
  f.ledger.setTriggerEnabled(off.id, false, USER);
  const gone = subscribe({ kind: 'merged' });
  f.ledger.deleteTrigger(gone.id, USER);

  for (const task of [parent, child, elsewhere]) f.ledger.noteAction('task.integrate', USER, { taskId: task.id }, { branch: 'main', commit: task.id });
  assert.deepEqual(fires(one.id).map((fire) => fire.data.task_id), [parent.id, child.id]);
  assert.deepEqual(fires(all.id).map((fire) => fire.data.task_id), [parent.id, child.id, elsewhere.id]);
  assert.deepEqual([fires(accepts.id).length, fires(foreign.id).length, fires(off.id).length, fires(gone.id).length], [0, 0, 0, 0]);
  assert.equal(f.ledger.getTrigger(off.id)!.rejected, null, '停用的不订阅，不算拒收');
});

test('the record and message commit with the transition: none before the commit, once after it', (t) => {
  let crash: 'before' | 'after' | undefined = 'before';
  const options: LedgerOptions = {
    testHooks: {
      beforeCommit(actions) { if (crash === 'before' && actions.includes('trigger.fire')) throw new Crash(); },
      afterCommit(actions) { if (crash === 'after' && actions.includes('trigger.fire')) { crash = undefined; throw new Crash(); } },
    },
  };
  const { f, subscribe, fires, triggerMessages } = setup(t, {}, options);
  const rule = subscribe({ kind: 'accepted' });
  const task = f.newTask();
  f.force(`UPDATE task SET state = 'ready' WHERE id = ?`, task.id);

  assert.throws(() => f.ledger.acceptTask(task.id, '好', USER, { withoutReview: true }), Crash);
  assert.equal(f.task(task.id).state, 'ready', '业务转换和触发记录一起没提交');
  assert.deepEqual([fires(rule.id).length, triggerMessages().length, f.peek(`SELECT 1 FROM change WHERE action = 'task.accept'`).length], [0, 0, 0]);

  crash = 'after';
  assert.throws(() => f.ledger.acceptTask(task.id, '好', USER, { withoutReview: true }), Crash);
  assert.equal(f.task(task.id).state, 'done');
  assert.deepEqual([fires(rule.id).length, triggerMessages().length], [1, 1]);
  assert.throws(() => f.ledger.acceptTask(task.id, '好', USER, { withoutReview: true }), InputError, '转换已经做过，不会再来一次');
  assert.deepEqual([fires(rule.id).length, triggerMessages().length], [1, 1]);
});

test('an overloaded trigger is counted and nothing else: the transition, the settlement message and the push stand', (t) => {
  const { f, held, subscribe, fires, triggerMessages, settlement, pushes } = setup(t, { perTriggerPerMinute: 0 });
  const ready = subscribe({ kind: 'work_ready' });
  const { taskId, runId } = round(f);
  assert.equal(f.task(taskId).state, 'ready');
  assert.equal(fires(ready.id).length, 0);
  assert.doesNotMatch(settlement(runId).text, /触发器/);
  assert.equal(pushes('work_ready').length, 1);
  assert.equal(f.ledger.getTrigger(ready.id)!.rejected?.reason, 'rate_trigger');

  // Independent events wait in the bounded trigger queue; full, the merge is recorded all the same.
  held.perTriggerPerMinute = 100;
  held.queueMax = 1;
  const merged = subscribe({ kind: 'merged' });
  f.ledger.noteAction('task.integrate', USER, { taskId }, { branch: 'main', commit: 'a' });
  f.ledger.noteAction('task.integrate', USER, { taskId }, { branch: 'main', commit: 'b' });
  assert.deepEqual(fires(merged.id).map((fire) => fire.data.commit), ['a']);
  assert.equal(triggerMessages().length, 1);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'task.integrate'`).length, 2);
  assert.deepEqual([f.ledger.getTrigger(merged.id)!.rejected?.reason, f.ledger.getTrigger(merged.id)!.rejected?.count], ['queue_full', 1]);
  assert.equal(pushes('integrated').length, 2, '两次合入照样告诉主人');

  // Nothing is replayed once the trigger has room again.
  held.queueMax = 100;
  f.ledger.fireDue(new Date(Date.now() + 120_000));
  assert.equal(fires(merged.id).length, 1);
});

test('an event the Router is told of already carries every subscription on that one message', (t) => {
  const { f, subscribe, fires, triggerMessages, settlement } = setup(t);
  const first = subscribe({ kind: 'work_ready' }, { name: '甲', instruction: '甲指令 {{task_id}}' });
  const second = subscribe({ kind: 'work_ready' }, { name: '乙', instruction: '乙指令' });
  const { taskId, runId } = round(f);
  const message = settlement(runId);
  assert.deepEqual([fires(first.id)[0]!.message_id, fires(second.id)[0]!.message_id], [message.id, message.id]);
  assert.deepEqual([fires(first.id)[0]!.outcome, fires(second.id)[0]!.outcome], ['delivered', 'delivered']);
  assert.equal(triggerMessages().length, 0, '不另起一条');
  assert.match(message.text, /^任务“交付”的 Run 已结算/);
  assert.match(message.text, new RegExp(`甲指令 ${taskId}`));
  assert.match(message.text, /乙指令/);
  assert.match(message.text, /不是主人说的话/);

  const taken = f.ledger.takeNextTurn(f.projectId);
  assert.equal(taken?.message.id, message.id);
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined, '负责人为这件事只处理一个回合');
});

test('work a trigger brought about sets off no trigger: neither its own events nor those of work made on them', (t) => {
  const { f, subscribe, fires, settlement } = setup(t);
  const ready = subscribe({ kind: 'work_ready' });
  const merged = subscribe({ kind: 'merged' });

  // A Task made in the turn of a settlement message a subscription rode on carries that occurrence.
  const { runId } = round(f);
  const fire = fires(ready.id)[0]!;
  const { message } = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(message.id, settlement(runId).id);
  const followUp = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '接着做', goal: '目标', acceptance: '通过' }, { actor: 'router', messageId: message.id });
  assert.equal(followUp.trigger_fire_id, fire.id);
  f.ledger.finishMessage(message.id, 'processed');

  f.ledger.queueTask(followUp.id, USER);
  round(f, DONE, followUp.id);
  f.ledger.noteAction('task.integrate', USER, { taskId: followUp.id }, { branch: 'main', commit: 'x' });
  const child = makeTask(f, { title: '子', parentId: followUp.id });
  f.ledger.noteAction('task.integrate', USER, { taskId: child.id }, { branch: 'main', commit: 'y' });
  assert.deepEqual([fires(ready.id).length, fires(merged.id).length], [1, 0]);
  assert.deepEqual([f.ledger.getTrigger(ready.id)!.rejected, f.ledger.getTrigger(merged.id)!.rejected], [null, null], '截断不是拒收');
});

test('a subscription is defined against what the ledger holds, and keeps its source', (t) => {
  const { f, subscribe } = setup(t);
  const other = f.ledger.createProject({ name: '别的', loginMode: 'all' }, USER);
  const theirs = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '他们的', goal: '目标', acceptance: '通过' }, USER);
  assert.throws(() => subscribe({ kind: 'stopped' }), /事件种类/);
  assert.throws(() => subscribe({ kind: 'merged', task_id: theirs.id }), /只能看本项目/);
  assert.throws(() => f.ledger.createTrigger(f.projectId, { name: 'x', instruction: 'y', source: 'email' }, USER), /来源/);
  const made = subscribe({ kind: 'merged' }, { expires_at: '2099-01-01T00:00:00Z' });
  assert.deepEqual([made.source, made.schedule, made.event, made.next_at, made.ended], ['event', null, { kind: 'merged', task_id: null }, null, null]);
  assert.match(made.schedule_text, /已合入/);
  assert.equal(f.peek('SELECT 1 FROM trigger_cursor WHERE trigger_id = ?', made.id).length, 0, '没有时刻，没有游标');
  assert.throws(() => f.ledger.updateTrigger(made.id, { source: 'schedule' }, USER), /来源建好后不能改/);
  const task = f.newTask();
  const changed = f.ledger.updateTrigger(made.id, { event: { kind: 'accepted', task_id: task.id }, schedule: { kind: 'once', at: 'nonsense' } }, USER);
  assert.deepEqual([changed.event, changed.revision], [{ kind: 'accepted', task_id: task.id }, 2]);
  assert.equal(f.ledger.updateTrigger(made.id, { name: changed.name, event: changed.event }, USER).revision, 2, '原样发回不是新修订');
});

test('a subscription that rode on a settlement message pushes the final reply when it asked to', (t) => {
  const { f, subscribe } = setup(t);
  f.ledger.setWhitelist({ wecom: ['zhang'], console: ['console'] }, USER);
  const notify = createNotify({ ledger: f.ledger, owner: () => 'zhang', publicUrl: () => 'https://tycho.example', direct: async () => {} });
  subscribe({ kind: 'work_ready' }, { name: '日报', push_final: true });
  round(f);
  const { message } = f.ledger.takeNextTurn(f.projectId)!;
  const reply = f.ledger.writeOutbound({ channel: message.channel, thread: message.thread, text: '做完了，下一步已派出', final: true, replyTo: message.id });
  notify.finalReply(message, f.peek<MessageRow>('SELECT * FROM message WHERE id = ?', reply.id)[0]);
  const finals = f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid').filter((row) => (JSON.parse(row.payload_json) as { external_id?: string }).external_id === `trigger-final:${message.id}`);
  assert.equal(finals.length, 1);
});

// Review of step 2: the service reads the same release result on every round. Handling it is one
// mark in the ledger, written with its push and its subscriptions: what was refused, unsubscribed or
// disabled then is not matched again later, whatever the retention of an identity says.
test('a release result is handled once: a later round of the same result matches nothing again', (t) => {
  const { f, held, subscribe, fires, triggerMessages, pushes } = setup(t, { queueMax: 0, dedupeKeepMs: 0 });
  const { taskId, runId } = round(f);
  const refused = subscribe({ kind: 'released' });
  const off = subscribe({ kind: 'released' });
  f.ledger.setTriggerEnabled(off.id, false, USER);
  const KEY = '2030-01-01T00:00:00Z';
  f.ledger.noteReleased(KEY, { runId, version: '0.2.7' });
  assert.equal(f.ledger.getTrigger(refused.id)!.rejected?.reason, 'queue_full');
  assert.deepEqual(pushes('released'), [`released:${KEY}`]);

  held.queueMax = 100;
  f.ledger.setTriggerEnabled(off.id, true, USER);
  const late = subscribe({ kind: 'released', task_id: taskId });
  for (let round = 0; round < 3; round += 1) f.ledger.noteReleased(KEY, { runId, version: '0.2.7' });
  assert.deepEqual([fires(refused.id).length, fires(off.id).length, fires(late.id).length, triggerMessages().length], [0, 0, 0, 0], '拒收后不重放，后建、重新启用的不补');
  assert.equal(f.ledger.getTrigger(refused.id)!.rejected?.count, 1, '也不再计拒收');
  assert.deepEqual(pushes('released'), [`released:${KEY}`]);

  // A new release result is a new event.
  f.ledger.noteReleased('2030-01-02T00:00:00Z', { runId, version: '0.2.8' });
  assert.deepEqual(fires(late.id).map((fire) => fire.data.version), ['0.2.8']);
  f.ledger.noteReleased('2030-01-02T00:00:00Z', { runId, version: '0.2.8' });
  assert.equal(fires(late.id).length, 1, '保留期为零也不再匹配');
});

test('the mark that a release result was handled commits with its push and its records: none before, once after', (t) => {
  let crash: 'before' | 'after' | undefined = 'before';
  const options: LedgerOptions = {
    testHooks: {
      beforeCommit(actions) { if (crash === 'before' && actions.includes('release.noted')) throw new Crash(); },
      afterCommit(actions) { if (crash === 'after' && actions.includes('release.noted')) { crash = undefined; throw new Crash(); } },
    },
  };
  const { f, subscribe, fires, pushes } = setup(t, {}, options);
  const { runId } = round(f);
  const rule = subscribe({ kind: 'released' });
  assert.throws(() => f.ledger.noteReleased('k', { runId, version: '1' }), Crash);
  assert.deepEqual([fires(rule.id).length, pushes('released').length], [0, 0]);
  crash = 'after';
  assert.throws(() => f.ledger.noteReleased('k', { runId, version: '1' }), Crash);
  assert.deepEqual([fires(rule.id).length, pushes('released').length], [1, 1]);
  f.ledger.noteReleased('k', { runId, version: '1' });
  assert.deepEqual([fires(rule.id).length, pushes('released').length], [1, 1]);
});

test('multiple trigger subscriptions on one internal event fulfill owner push and all distinct group broadcasts with dedup', (t) => {
  const { f, subscribe } = setup(t);
  f.ledger.setChannels(['console', 'wecom']);
  f.ledger.setWhitelist({ wecom: ['zhang'], console: ['console'] }, USER);
  const g1 = f.ledger.createImGroupBinding({ channel: 'wecom', chat_id: 'wr-group-1', chat_name: '研发一群', project_id: f.projectId, notify_events: true }, USER);
  const g2 = f.ledger.createImGroupBinding({ channel: 'wecom', chat_id: 'wr-group-2', chat_name: '研发二群', project_id: f.projectId, notify_events: true }, USER);
  const notify = createNotify({ ledger: f.ledger, owner: () => 'zhang', publicUrl: () => 'https://tycho.example', direct: async () => {} });

  // Subscription A: pushes to owner + broadcasts to group 1
  subscribe({ kind: 'work_ready' }, { name: '订阅甲', push_final: true, broadcast_groups: true, broadcast_group_ids: [g1.id] });
  // Subscription B: no owner push, broadcasts to group 1 (duplicate) + group 2 (distinct)
  subscribe({ kind: 'work_ready' }, { name: '订阅乙', push_final: false, broadcast_groups: true, broadcast_group_ids: [g1.id, g2.id] });

  round(f);
  const { message } = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(f.ledger.triggerFiresOfMessage(message.id).length, 2);
  const reply = f.ledger.writeOutbound({ channel: message.channel, thread: message.thread, text: '全部验收就绪', final: true, replyTo: message.id });
  notify.finalReply(message, f.peek<MessageRow>('SELECT * FROM message WHERE id = ?', reply.id)[0]);

  const rows = f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid');
  const keys = rows.map((row) => (JSON.parse(row.payload_json) as { external_id?: string }).external_id);
  assert.ok(keys.includes(`trigger-final:${message.id}`), 'owner receives push_final');
  assert.equal(keys.filter((k) => k === `trigger-final:${message.id}`).length, 1, 'owner push is deduplicated');
  assert.equal(keys.filter((k) => k === `trigger-group:${message.id}:wecom:wr-group-1`).length, 1, 'group 1 broadcast is deduplicated');
  assert.equal(keys.filter((k) => k === `trigger-group:${message.id}:wecom:wr-group-2`).length, 1, 'group 2 broadcast from second subscription is delivered');
  const g2Row = rows.find((row) => (JSON.parse(row.payload_json) as { external_id?: string }).external_id === `trigger-group:${message.id}:wecom:wr-group-2`)!;
  assert.match((JSON.parse(g2Row.payload_json) as { content: string }).content, /订阅乙/);
});
