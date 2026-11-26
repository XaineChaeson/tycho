// Guards against a stranger's message reaching the Router, a redelivered message
// being handled twice, two messages in flight at once, an unfinished request being
// retried or forgotten, and its list of committed operations being buried in the
// message's own bookkeeping. Also: a reply stream leaving a trail of rows.
// The queue is per project (docs/design/project-sessions.md §2, §3): one message at a time in
// each project, never one of another project's, never one that waits for a project.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import { fixture, USER } from './helpers.ts';

let project = '';
const message = (externalId: string, actor = 'user', channel = 'console') => ({
  channel,
  externalId,
  actor,
  text: `消息 ${externalId}`,
  projectId: project,
});
const fixtureOf = (t: Parameters<typeof fixture>[0]) => {
  const f = fixture(t);
  project = f.projectId;
  return f;
};

test('a sender outside the whitelist is recorded but never reaches the Router', (t) => {
  const f = fixtureOf(t);
  assert.equal(f.ledger.receiveMessage(message('m1', 'stranger')).state, 'ignored');
  assert.equal(f.ledger.receiveMessage(message('m2', 'user', 'unknown-channel')).state, 'ignored');
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
});

test('the internal channel skips the whitelist', (t) => {
  const f = fixtureOf(t);
  assert.equal(f.ledger.receiveMessage(message('m1', 'runner', 'internal')).state, 'received');
});

test('a repeated (channel, external_id) returns the original and writes nothing', (t) => {
  const f = fixtureOf(t);
  const first = f.ledger.receiveMessage(message('m1'));
  f.ledger.takeNextTurn(f.projectId);
  f.ledger.finishMessage(first.id, 'processed');
  const before = f.dump();
  assert.deepEqual({ ...f.ledger.receiveMessage(message('m1')) }, { id: first.id, state: 'processed' });
  assert.deepEqual(f.dump(), before);
  assert.notEqual(f.ledger.receiveMessage(message('m1', 'user', 'wecom')).id, first.id);
});

test('one message at a time, oldest first', (t) => {
  const f = fixtureOf(t);
  const first = f.ledger.receiveMessage(message('m1'));
  const second = f.ledger.receiveMessage(message('m2'));
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, first.id);
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
  f.ledger.finishMessage(first.id, 'processed');
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, second.id);
});

test('only a message in processing can be finished, and only once', (t) => {
  const f = fixtureOf(t);
  const { id } = f.ledger.receiveMessage(message('m1'));
  assert.throws(() => f.ledger.finishMessage(id, 'processed'), InputError);
  f.ledger.takeNextTurn(f.projectId);
  f.ledger.finishMessage(id, 'unverified');
  assert.throws(() => f.ledger.finishMessage(id, 'processed'), InputError);
  assert.equal(f.ledger.getMessage(id).state, 'unverified');
});

test('the queue position counts the messages still waiting ahead, and only for one that waits', (t) => {
  const f = fixtureOf(t);
  const receive = (externalId: string, actor = 'user') =>
    f.ledger.receiveMessage({ channel: 'console', externalId, actor, text: '一条', projectId: f.projectId }).id;
  const first = receive('a');
  const second = receive('b');
  const third = receive('c');
  assert.equal(f.ledger.queuedAhead(third), 2);
  f.ledger.takeNextTurn(f.projectId);
  assert.equal(f.ledger.queuedAhead(third), 1);
  assert.equal(f.ledger.queuedAhead(second), 0);
  assert.equal(f.ledger.queuedAhead(first), 0);
});

test('a restart marks processing as unverified, is not redelivered, and frees the queue', (t) => {
  const f = fixtureOf(t);
  const { id } = f.ledger.receiveMessage(message('m1'));
  const next = f.ledger.receiveMessage(message('m2'));
  f.ledger.takeNextTurn(f.projectId);
  assert.deepEqual(f.ledger.markProcessingUnverified(), [id]);
  assert.equal(f.ledger.getMessage(id).state, 'unverified');
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, next.id);
  assert.deepEqual(f.ledger.markProcessingUnverified(), [next.id]);
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
});

test('listChanges shows what the message committed, not its own lifecycle', (t) => {
  const f = fixtureOf(t);
  const { id } = f.ledger.receiveMessage(message('m1'));
  f.ledger.takeNextTurn(f.projectId);
  const task = f.ledger.createTask(
    { roleId: 'implement', projectId: f.projectId, title: '任务', goal: '目标', acceptance: '测试通过' },
    { actor: 'router', messageId: id },
  );
  f.ledger.queueTask(task.id, { actor: 'router', messageId: id });
  f.ledger.finishMessage(id, 'unverified');
  assert.deepEqual(
    f.ledger.listChanges({ messageId: id }).map((change) => change.action),
    ['task.create', 'task.queue'],
  );
});

test('drafts of a reply share one row, and the final text replaces and ends it', (t) => {
  const f = fixtureOf(t);
  const { id } = f.ledger.receiveMessage(message('m1'));
  const reply = { channel: 'console', replyTo: id };
  const draft = f.ledger.writeOutbound({ ...reply, text: '开', final: false });
  assert.equal(f.ledger.writeOutbound({ ...reply, text: '开始', final: false }).id, draft.id);
  const final = f.ledger.writeOutbound({ ...reply, text: '完整回复', final: true });
  assert.equal(final.id, draft.id);
  assert.equal(final.final, 1);
  assert.equal(final.direction, 'out');
  assert.equal(f.ledger.writeOutbound({ ...reply, text: '迟到的中间稿', final: false }).text, '完整回复');
  assert.equal(f.peek(`SELECT id FROM message WHERE direction = 'out'`).length, 1);
  assert.equal(f.ledger.listChanges({ messageId: id }).filter((c) => c.action === 'message.reply').length, 1);
});

test('messages page forward from a cursor, and the newest page without one', (t) => {
  const f = fixtureOf(t);
  const ids = ['m1', 'm2', 'm3'].map((each) => f.ledger.receiveMessage(message(each)).id);
  assert.deepEqual(f.ledger.listMessages({ limit: 2 }).map(({ id }) => id), ids.slice(1));
  assert.deepEqual(f.ledger.listMessages({ after: ids[0]!, limit: 1 }).map(({ id }) => id), [ids[1]]);
});

test('the next queued task is the highest priority, then the oldest', (t) => {
  const f = fixtureOf(t);
  const older = f.queuedTask();
  f.queuedTask();
  assert.equal(f.ledger.queuedTasks()[0]?.id, older.id);
  const urgent = f.queuedTask();
  f.ledger.updateTask(urgent.id, { priority: 5 }, USER);
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id).slice(0, 2), [urgent.id, older.id]);
});

test('tasks filter by project and state', (t) => {
  const f = fixtureOf(t);
  const queued = f.queuedTask();
  f.newTask();
  assert.deepEqual(f.ledger.listTasks({ states: ['queued'] }).map(({ id }) => id), [queued.id]);
  assert.equal(f.ledger.listTasks({ projectId: f.projectId }).length, 2);
  assert.equal(f.ledger.listTasks({ projectId: 'none' }).length, 0);
});
