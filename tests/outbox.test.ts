// Guards against: notifications sent before they are due, retries that hammer
// the channel or stop too early, slow failures stretching the one-hour limit,
// messages stuck forever, disabled channels accumulating history, closure notifications
// separated from their transition, and a message lost together with the state change
// that produced it, and backlog counts hiding items waiting for a later retry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import { fixture, retryAfter, USER } from './helpers.ts';

const SECOND = 1000;
const GIVE_UP = retryAfter(3600 * SECOND);

test('counts().pending includes future retries and excludes sent and given-up items without writing', (t) => {
  const f = fixture(t);
  const one = f.ledger.outbox.enqueue('wecom', 'note', {});
  const two = f.ledger.outbox.enqueue('wecom', 'note', {});
  const three = f.ledger.outbox.enqueue('wecom', 'note', {});
  f.ledger.outbox.markSent(one.id);
  f.ledger.outbox.markFailed(two.id, '断线', GIVE_UP, new Date('2099-01-01T00:00:00Z'));
  f.ledger.outbox.markFailed(three.id, '断线', GIVE_UP, new Date('2020-01-01T00:00:00Z'));
  f.ledger.outbox.markFailed(three.id, '放弃', GIVE_UP, new Date('2020-01-01T02:00:00Z'));
  const before = f.dump();
  assert.equal(f.ledger.outbox.counts().pending, 1);
  assert.deepEqual(f.dump(), before);
});

test('takeDue returns pending items that are due, oldest first', (t) => {
  const f = fixture(t);
  const first = f.ledger.outbox.enqueue('wecom', 'note', { n: 1 });
  const second = f.ledger.outbox.enqueue('wecom', 'note', { n: 2 });
  assert.deepEqual(f.ledger.outbox.takeDue().map((row) => row.id), [first.id, second.id]);
  assert.deepEqual(f.ledger.outbox.takeDue(new Date('2000-01-01T00:00:00Z')), []);
  f.ledger.outbox.markSent(first.id);
  assert.deepEqual(f.ledger.outbox.takeDue().map((row) => row.id), [second.id]);
});

test('backoff doubles from 2 seconds to 1 minute', (t) => {
  const f = fixture(t);
  const { id } = f.ledger.outbox.enqueue('wecom', 'note', {});
  const now = new Date('2030-01-01T00:00:00Z');
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    f.ledger.outbox.markFailed(id, 'boom', GIVE_UP, now);
    const [row] = f.peek<{ next_at: string; error: string }>('SELECT * FROM outbox WHERE id = ?', id);
    assert.equal(row!.error, 'boom');
    delays.push((new Date(row!.next_at).getTime() - now.getTime()) / SECOND);
  }
  assert.deepEqual(delays, [2, 4, 8, 16, 32, 60, 60, 60]);
});

test('a failed item waits out its delay', (t) => {
  const f = fixture(t);
  const { id } = f.ledger.outbox.enqueue('wecom', 'note', {});
  const now = new Date(Date.now() + 10 * SECOND);
  f.ledger.outbox.markFailed(id, 'boom', GIVE_UP, now);
  assert.deepEqual(f.ledger.outbox.takeDue(new Date(now.getTime() + SECOND)), []);
  assert.equal(f.ledger.outbox.takeDue(new Date(now.getTime() + 2 * SECOND)).length, 1);
});

test('gives up after an hour of consecutive failures, not before', (t) => {
  const f = fixture(t);
  const { id } = f.ledger.outbox.enqueue('wecom', 'note', {});
  let clock = new Date('2030-01-01T00:00:00Z').getTime();
  const start = clock;
  let state = 'pending';
  // Bounded so a regression that never gives up fails the assertion instead of looping forever.
  for (let failures = 0; state === 'pending' && failures < 200; failures++) {
    f.ledger.outbox.markFailed(id, 'boom', GIVE_UP, new Date(clock));
    const [row] = f.peek<{ state: string; next_at: string }>('SELECT * FROM outbox WHERE id = ?', id);
    state = row!.state;
    if (state === 'pending') clock = new Date(row!.next_at).getTime();
  }
  assert.equal(state, 'given_up');
  const elapsed = clock - start;
  assert.ok(elapsed >= 3600 * SECOND, `gave up after ${elapsed} ms`);
  assert.ok(elapsed < 3600 * SECOND + 60 * SECOND, `gave up after ${elapsed} ms`);
  assert.deepEqual(f.ledger.outbox.takeDue(new Date(clock + 3600 * SECOND)), []);
});

test('the hour is real time, however slowly each attempt fails', (t) => {
  const f = fixture(t);
  const { id } = f.ledger.outbox.enqueue('wecom', 'note', {});
  const start = new Date('2030-01-01T00:00:00Z').getTime();
  const stateAfter = (failure: number) => {
    f.ledger.outbox.markFailed(id, 'boom', GIVE_UP, new Date(start + (failure - 1) * 120 * SECOND));
    return f.peek<{ state: string; tries: number }>('SELECT * FROM outbox WHERE id = ?', id)[0]!;
  };
  for (let failure = 1; failure <= 30; failure++) assert.equal(stateAfter(failure).state, 'pending');
  const last = stateAfter(31);
  assert.equal(last.state, 'given_up');
  assert.equal(last.tries, 31);
});

test('the first failure time is kept across failures and cleared by success or retry', (t) => {
  const f = fixture(t);
  const firstFailedAt = (id: string) =>
    f.peek<{ first_failed_at: string | null }>('SELECT * FROM outbox WHERE id = ?', id)[0]!.first_failed_at;
  const start = new Date('2030-01-01T00:00:00Z');
  const later = new Date('2030-01-01T00:10:00Z');

  const sent = f.ledger.outbox.enqueue('wecom', 'note', {});
  assert.equal(firstFailedAt(sent.id), null);
  f.ledger.outbox.markFailed(sent.id, 'boom', GIVE_UP, start);
  f.ledger.outbox.markFailed(sent.id, 'boom', GIVE_UP, later);
  assert.equal(firstFailedAt(sent.id), start.toISOString());
  f.ledger.outbox.markSent(sent.id);
  assert.equal(firstFailedAt(sent.id), null);

  const retried = f.ledger.outbox.enqueue('wecom', 'note', {});
  f.ledger.outbox.markFailed(retried.id, 'boom', GIVE_UP, start);
  f.ledger.outbox.markFailed(retried.id, 'boom', GIVE_UP, new Date(start.getTime() + 3600 * SECOND));
  assert.equal(f.peek<{ state: string }>('SELECT * FROM outbox WHERE id = ?', retried.id)[0]!.state, 'given_up');
  f.ledger.outbox.retry(retried.id, USER);
  assert.equal(firstFailedAt(retried.id), null);
  // A retried item gets a full hour again.
  f.ledger.outbox.markFailed(retried.id, 'boom', GIVE_UP, new Date(start.getTime() + 2 * 3600 * SECOND));
  assert.equal(f.peek<{ state: string }>('SELECT * FROM outbox WHERE id = ?', retried.id)[0]!.state, 'pending');
});

test('manual retry revives a given-up item and restarts its backoff', (t) => {
  const f = fixture(t);
  const { id } = f.ledger.outbox.enqueue('wecom', 'note', {});
  f.force(`UPDATE outbox SET state = 'given_up', tries = 70, error = 'boom' WHERE id = ?`, id);
  f.ledger.outbox.retry(id, USER);
  const [row] = f.peek<{ state: string; tries: number; error: string | null }>('SELECT * FROM outbox WHERE id = ?', id);
  assert.equal(row!.state, 'pending');
  assert.equal(row!.tries, 0);
  assert.equal(row!.error, null);
  assert.equal(f.ledger.outbox.takeDue().length, 1);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'outbox.retry'`).length, 1);
});

test('a sent item stays sent', (t) => {
  const f = fixture(t);
  const { id } = f.ledger.outbox.enqueue('wecom', 'note', {});
  f.ledger.outbox.markSent(id);
  assert.throws(() => f.ledger.outbox.retry(id, USER), InputError);
  assert.throws(() => f.ledger.outbox.markFailed(id, 'boom', GIVE_UP), InputError);
  assert.throws(() => f.ledger.outbox.markSent(id), InputError);
});

test('a notification rolls back with the transition that produced it', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  assert.throws(
    () => f.ledger.openApproval(task.id, [{ question: '？' }], { actor: 'user', messageId: 'no-such-message' }),
    /FOREIGN KEY/,
  );
  assert.equal(f.count('outbox'), 0);
  assert.equal(f.count('approval'), 0);
  assert.equal(f.task(task.id).state, 'queued');
});


test('disabled notification channels neither queue new events nor replay their historical pending rows', (t) => {
  const f = fixture(t);
  const pending = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  const sent = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  f.ledger.outbox.markSent(sent.id);
  f.ledger.setChannels(['console']);
  assert.deepEqual(f.ledger.outbox.counts(), { pending: 0, given_up: 1 });
  assert.equal(f.ledger.outbox.listGivenUp()[0]!.id, pending.id);
  assert.equal(f.ledger.outbox.listGivenUp()[0]!.error, '通道未启用');
  f.ledger.openApproval(f.queuedTask().id, [{ question: '继续？' }], USER);
  assert.equal(f.count('outbox'), 2);
  f.ledger.setChannels(['console']);
  assert.equal(f.peek(`SELECT * FROM change WHERE action = 'outbox.disable_channels'`).length, 1);
  f.ledger.setChannels(['console', 'wecom']);
  f.ledger.openApproval(f.queuedTask().id, [{ question: '继续？' }], USER);
  assert.deepEqual(f.ledger.outbox.counts(), { pending: 1, given_up: 1 });
});

test('discard notes survive marking an Outbox row delivered', (t) => {
  const f = fixture(t);
  const row = f.ledger.outbox.enqueue('wecom', 'verify', {});
  f.ledger.outbox.markSent(row.id, '已失效');
  assert.equal(f.peek<{ error: string }>('SELECT * FROM outbox WHERE id = ?', row.id)[0]!.error, '已失效');
});

test('closing a question rolls back both its state and closure notification on failure', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const id = f.ledger.openApproval(task.id, [{ question: '继续？' }], USER);
  const before = f.dump();
  assert.throws(() => f.ledger.abandonTask(task.id, '不再做', { actor: 'console', messageId: 'absent' }), /FOREIGN KEY/);
  assert.deepEqual(f.dump(), before);
  f.ledger.abandonTask(task.id, '不再做', { actor: 'console' });
  const closed = f.peek<{ payload_json: string }>(`SELECT * FROM outbox WHERE kind = 'approval_closed'`);
  assert.equal(closed.length, 1);
  assert.equal(JSON.parse(closed[0]!.payload_json).approval_id, id);
});


test('a restart retires historical disabled notifications once and preserves that choice after enabling', (t) => {
  const f = fixture(t);
  const row = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  f.ledger.close();
  const restarted = f.open();
  restarted.setChannels(['console']);
  restarted.close();
  const again = f.open();
  again.setChannels(['console', 'wecom']);
  assert.equal(f.peek<{ state: string }>('SELECT state FROM outbox WHERE id = ?', row.id)[0]!.state, 'given_up');
  assert.equal(f.peek(`SELECT * FROM change WHERE action = 'outbox.disable_channels'`).length, 1);
});

test('giving up goes by the limit the caller states', (t) => {
  const f = fixture(t);
  const start = new Date('2030-01-01T00:00:00Z');
  const { id } = f.ledger.outbox.enqueue('wecom', 'note', {});
  f.ledger.outbox.markFailed(id, 'boom', retryAfter(10 * SECOND), start);
  f.ledger.outbox.markFailed(id, 'boom', retryAfter(10 * SECOND), new Date(start.getTime() + 9 * SECOND));
  assert.equal(f.ledger.outbox.counts().given_up, 0);
  f.ledger.outbox.markFailed(id, 'boom', retryAfter(10 * SECOND), new Date(start.getTime() + 10 * SECOND));
  assert.equal(f.ledger.outbox.counts().given_up, 1);
});

// What this catches: the retry waits being numbers of the outbox's own, so the owner could
// not make a notification retry sooner or later; and a cap set below the first wait making
// the first wait shorter than it was set to.
test('the waits between retries follow the settings as they stand at each failure', (t) => {
  const f = fixture(t);
  const start = new Date('2030-01-01T00:00:00Z').getTime();
  const { id } = f.ledger.outbox.enqueue('wecom', 'note', {});
  const waitAfter = (retry: { firstDelayMs: number; maxDelayMs: number }): number => {
    const failedAt = new Date(f.peek<{ next_at: string }>('SELECT next_at FROM outbox WHERE id = ?', id)[0]!.next_at);
    const at = Math.max(start, failedAt.getTime());
    f.ledger.outbox.markFailed(id, 'boom', { giveUpAfterMs: 3600 * SECOND, ...retry }, new Date(at));
    return Date.parse(f.peek<{ next_at: string }>('SELECT next_at FROM outbox WHERE id = ?', id)[0]!.next_at) - at;
  };
  const policy = { firstDelayMs: 5 * SECOND, maxDelayMs: 12 * SECOND };
  assert.deepEqual([waitAfter(policy), waitAfter(policy), waitAfter(policy), waitAfter(policy)], [5, 10, 12, 12].map((s) => s * SECOND));
  // Changed between two failures: the next wait goes by the new numbers.
  assert.equal(waitAfter({ firstDelayMs: SECOND, maxDelayMs: 3 * SECOND }), 3 * SECOND);
  assert.equal(waitAfter({ firstDelayMs: 30 * SECOND, maxDelayMs: 10 * SECOND }), 30 * SECOND, '封顶比第一次还短时按第一次');
});

test('forceResend revives a given-up item with an incremented force_resend_seq and rejects non-given-up rows', (t) => {
  const f = fixture(t);
  const row = f.ledger.outbox.enqueue('weixin', 'markdown', { external_id: 'wx-1', content: '通知内容' });
  assert.throws(() => f.ledger.outbox.forceResend(row.id, USER), InputError);

  f.ledger.outbox.markUncertain(row.id, '微信外发结果未确认');
  const seq1 = f.ledger.outbox.forceResend(row.id, USER);
  assert.equal(seq1, 1);
  const [after1] = f.peek<{ state: string; tries: number; error: string | null; first_failed_at: string | null; payload_json: string }>(
    'SELECT state, tries, error, first_failed_at, payload_json FROM outbox WHERE id = ?',
    row.id,
  );
  assert.equal(after1!.state, 'pending');
  assert.equal(after1!.tries, 0);
  assert.equal(after1!.error, null);
  assert.equal(after1!.first_failed_at, null);
  assert.deepEqual(JSON.parse(after1!.payload_json), { external_id: 'wx-1', content: '通知内容', force_resend_seq: 1 });

  // A second uncertain failure and second forceResend increments force_resend_seq to 2.
  f.ledger.outbox.markUncertain(row.id, '再次未确认');
  const seq2 = f.ledger.outbox.forceResend(row.id, USER);
  assert.equal(seq2, 2);
  const [after2] = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox WHERE id = ?', row.id);
  assert.equal(JSON.parse(after2!.payload_json).force_resend_seq, 2);

  // Sent items cannot be force-resent.
  f.ledger.outbox.markSent(row.id);
  assert.throws(() => f.ledger.outbox.forceResend(row.id, USER), InputError);

  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'outbox.force_resend'`).length, 2);
});
