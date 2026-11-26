// Guards against: stale, double or unauthorized answers being accepted, an
// incomplete answer sheet consuming a question, and an answer that is recorded
// but never reaches the next Run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import { fixture, LOGIN, USER } from './helpers.ts';

function ask(f: ReturnType<typeof fixture>) {
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, { status: 'waiting', ask: [{ question: '用哪个库？' }, { question: '发布吗？' }] });
  const [approval] = f.peek<{ id: string }>('SELECT id FROM approval WHERE task_id = ?', task.id);
  return { task, approvalId: approval!.id };
}

test('answer records the sheet, writes an input and requeues the Task', (t) => {
  const f = fixture(t);
  const { task, approvalId } = ask(f);
  const result = f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'wecom');
  assert.equal(result.status, 'accepted');
  assert.equal(f.task(task.id).state, 'queued');
  const [row] = f.peek<{ state: string; answered_by: string; answered_via: string; answers_json: string }>(
    'SELECT * FROM approval WHERE id = ?',
    approvalId,
  );
  assert.equal(row!.state, 'answered');
  assert.equal(row!.answered_by, 'user');
  assert.equal(row!.answered_via, 'wecom');
  assert.deepEqual(JSON.parse(row!.answers_json), ['甲', '发']);
  const [input] = f.peek<{ state: string; text: string }>('SELECT * FROM input WHERE task_id = ?', task.id);
  assert.equal(input!.state, 'queued');
  assert.match(input!.text, /用哪个库？/);
  assert.equal(f.peek(`SELECT 1 FROM outbox WHERE kind = 'approval_answered'`).length, 1);
});

test('of two answers only the first is accepted', (t) => {
  const f = fixture(t);
  const { task, approvalId } = ask(f);
  assert.equal(f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'wecom').status, 'accepted');
  assert.deepEqual(f.ledger.answerApproval(approvalId, ['乙', '不发'], 'user', 'console'), { status: 'closed' });
  const [row] = f.peek<{ answers_json: string; answered_via: string }>('SELECT * FROM approval WHERE id = ?', approvalId);
  assert.deepEqual(JSON.parse(row!.answers_json), ['甲', '发']);
  assert.equal(row!.answered_via, 'wecom');
  assert.equal(f.count('input'), 1);
  assert.equal(f.task(task.id).state, 'queued');
});

test('an old question answers closed', (t) => {
  const f = fixture(t);
  const { task, approvalId } = ask(f);
  f.ledger.holdTask(task.id, '不等了', USER);
  assert.deepEqual(f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'wecom'), { status: 'closed' });
  assert.equal(f.task(task.id).state, 'held');
  assert.equal(f.count('input'), 0);
});

test('a question bound to an old revision answers closed', (t) => {
  const f = fixture(t);
  const { task, approvalId } = ask(f);
  // Reaches the revision check itself: updateTask would already have closed it.
  f.force(`UPDATE task SET revision = 2 WHERE id = ?`, task.id);
  assert.deepEqual(f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'wecom'), { status: 'closed' });
  assert.equal(f.count('input'), 0);
});

test('an incomplete sheet is refused and leaves the question open', (t) => {
  const f = fixture(t);
  const { approvalId } = ask(f);
  assert.throws(() => f.ledger.answerApproval(approvalId, ['甲'], 'user', 'wecom'), InputError);
  assert.throws(() => f.ledger.answerApproval(approvalId, ['甲', ' '], 'user', 'wecom'), InputError);
  assert.equal(f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'wecom').status, 'accepted');
});

test('the answer reaches the next Run', (t) => {
  const f = fixture(t);
  const { task, approvalId } = ask(f);
  const { input_id } = f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'wecom') as { input_id: string };
  const run = f.ledger.createRun(task.id, f.login, USER);
  assert.equal(JSON.parse(run.snapshot_json).inputs[0].id, input_id);
});

test('an unauthorized answer changes nothing at all', (t) => {
  const f = fixture(t);
  const { approvalId } = ask(f);
  const before = f.dump();
  assert.throws(() => f.ledger.answerApproval(approvalId, ['甲', '发'], 'stranger', 'wecom'), InputError);
  assert.deepEqual(f.dump(), before);
});

test('being allowed on one channel does not allow another', (t) => {
  const f = fixture(t);
  const { approvalId } = ask(f);
  f.ledger.setWhitelist({ wecom: ['user'], console: ['admin'] }, USER);
  const before = f.dump();
  assert.throws(() => f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'console'), InputError);
  assert.throws(() => f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'constructor'), InputError);
  assert.deepEqual(f.dump(), before);
  assert.equal(f.ledger.answerApproval(approvalId, ['甲', '发'], 'admin', 'console').status, 'accepted');
});

test('with no whitelist nobody can answer', (t) => {
  const f = fixture(t);
  const { approvalId } = ask(f);
  f.force(`DELETE FROM setting WHERE key = 'whitelist'`);
  assert.throws(() => f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'wecom'), InputError);
});

test('identity is checked before the question state', (t) => {
  const f = fixture(t);
  const { task, approvalId } = ask(f);
  f.ledger.holdTask(task.id, '不等了', USER);
  assert.throws(() => f.ledger.answerApproval(approvalId, ['甲', '发'], 'stranger', 'wecom'), InputError);
});

test('setWhitelist is audited, survives reopen and refuses a malformed value', (t) => {
  const f = fixture(t);
  const { approvalId } = ask(f);
  f.ledger.setWhitelist({ wecom: ['boss'] }, USER);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'whitelist.set'`).length, 2);
  const malformed = [null, [], { wecom: 'boss' }, { wecom: [1] }];
  for (const value of malformed) {
    assert.throws(() => f.ledger.setWhitelist(value as unknown as Record<string, string[]>, USER), InputError);
  }
  const reopened = f.open();
  assert.equal(reopened.answerApproval(approvalId, ['甲', '发'], 'boss', 'wecom').status, 'accepted');
});

test('openApproval requires a Task able to wait', (t) => {
  const f = fixture(t);
  const { task } = f.runningRun();
  assert.throws(() => f.ledger.openApproval(task.id, [{ question: '？' }], USER), InputError);
  const queued = f.queuedTask();
  assert.throws(() => f.ledger.openApproval(queued.id, [], USER), InputError);
});


test('simultaneous complete answers from both channels accept one sheet, one Input and one notification', async (t) => {
  const f = fixture(t);
  const { approvalId } = ask(f);
  const results = await Promise.all([
    Promise.resolve().then(() => f.ledger.answerApproval(approvalId, ['甲', '发'], 'user', 'wecom')),
    Promise.resolve().then(() => f.ledger.answerApproval(approvalId, ['乙', '不发'], 'user', 'console')),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['accepted', 'closed']);
  assert.equal(f.count('input'), 1);
  assert.equal(f.peek(`SELECT * FROM outbox WHERE kind = 'approval_answered'`).length, 1);
  assert.equal(f.peek(`SELECT * FROM change WHERE action = 'approval.answer'`).length, 1);
});
