// Guards against the Outbox loop losing or repeating a notification: a row marked sent
// when the send failed, a failure that retries at once, a channel that is not running
// swallowing its rows, the same event queued twice, sends carrying on after the ledger
// stopped taking writes, overlapping rounds, a stop that leaves a send behind, and a
// send during the inventory that follows a failure.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { LedgerOptions } from '../service/ledger.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { DeliveryUncertainError } from '../service/outbox.ts';
import type { OutboxSenderOptions } from '../service/outbox-sender.ts';
import { createOutboxSender } from '../service/outbox-sender.ts';
import { DegradedError } from '../service/errors.ts';
import { fixture, retryAfter, tuned } from './helpers.ts';

const HOUR = 3_600_000;

function setup(t: TestContext, channels: OutboxSenderOptions['channels'], extra: Partial<OutboxSenderOptions> = {}, ledgerOptions: LedgerOptions = {}) {
  const f = fixture(t, ledgerOptions);
  const logs: string[] = [];
  const sender = createOutboxSender({
    outbox: f.ledger.outbox,
    channels,
    giveUpAfterMs: () => HOUR,
    retryFirstMs: tuned('outbox.retryFirstMs'),
    retryMaxMs: tuned('outbox.retryMaxMs'),
    intervalMs: 5,
    log: (line) => logs.push(line),
    ...extra,
  });
  t.after(() => sender.stop());
  const stateOf = (id: string) => f.peek<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id)[0]!;
  return { f, sender, logs, stateOf };
}

async function until(read: () => unknown, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!read()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(2);
  }
}

test('each row goes to its channel and is marked sent', async (t) => {
  const seen: unknown[] = [];
  const { f, sender, stateOf } = setup(t, {
    wecom: async (row) => {
      seen.push(JSON.parse(row.payload_json));
    },
  });
  const row = f.ledger.outbox.enqueue('wecom', 'markdown', { n: 1 });
  sender.start();
  await until(() => stateOf(row.id).state === 'sent', '发送');
  assert.deepEqual(seen, [{ n: 1 }]);
});

test('uncertain delivery stops automatically and is visible for owner reconciliation without another send', async t => {
  let calls = 0;
  const { f, sender, stateOf } = setup(t, { private: async () => { calls++; throw new DeliveryUncertainError('发送结果未确认，请在原聊天核对'); } });
  const row = f.ledger.outbox.enqueue('private', 'markdown', {});
  sender.start();
  await until(() => stateOf(row.id).state === 'given_up', '停止自动重试');
  assert.equal(calls, 1);
  assert.equal(f.ledger.outbox.listGivenUp()[0]!.id, row.id);
  f.ledger.outbox.confirmReceived(row.id, { actor: 'console' });
  assert.equal(stateOf(row.id).state, 'sent');
  assert.equal(calls, 1);
  assert.equal(f.peek<{ actor: string }>("SELECT actor FROM change WHERE action = 'outbox.confirm_received'")[0]!.actor, 'console');
});

test('nothing goes out during an inventory, and what waited goes out after it', async (t) => {
  let recovering = true;
  const seen: unknown[] = [];
  const { f, sender, stateOf } = setup(t, { wecom: async (row) => void seen.push(row.id) }, { recovering: () => recovering });
  const row = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  sender.start();
  await sleep(30);
  assert.deepEqual([seen, stateOf(row.id).state], [[], 'pending']);
  recovering = false;
  await until(() => stateOf(row.id).state === 'sent', '清点结束后发送');
});

test('Console rows need no sending: being in the ledger is delivery', async (t) => {
  const { f, sender, stateOf } = setup(t, {});
  const row = f.ledger.outbox.enqueue('console', 'markdown', {});
  sender.start();
  await until(() => stateOf(row.id).state === 'sent', '标记');
});

test('a channel that is not running leaves its rows for one that is', async (t) => {
  const { f, sender, stateOf } = setup(t, {});
  const row = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  sender.start();
  await sleep(30);
  assert.equal(stateOf(row.id).state, 'pending');
  assert.equal(stateOf(row.id).tries, 0);
});

test('a failed send stays pending with its error and waits out the backoff', async (t) => {
  let calls = 0;
  const { f, sender, stateOf } = setup(t, {
    wecom: async () => {
      calls += 1;
      throw new Error('企微未连接');
    },
  });
  const row = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  sender.start();
  await until(() => stateOf(row.id).tries === 1, '失败');
  await sleep(50);
  assert.equal(calls, 1);
  const after = stateOf(row.id);
  assert.equal(after.state, 'pending');
  assert.equal(after.error, '企微未连接');
  assert.ok(after.next_at > row.next_at);
});

test('one failing row does not hold up the next', async (t) => {
  const { f, sender, stateOf } = setup(t, {
    wecom: async (row) => {
      if (JSON.parse(row.payload_json).bad) throw new Error('不行');
    },
  });
  const bad = f.ledger.outbox.enqueue('wecom', 'markdown', { bad: true });
  const good = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  sender.start();
  await until(() => stateOf(good.id).state === 'sent', '发送');
  assert.equal(stateOf(bad.id).state, 'pending');
});

test('rows given up on are counted; pending and sent are told apart', async (t) => {
  const { f } = setup(t, {});
  const { outbox } = f.ledger;
  const failed = outbox.enqueue('wecom', 'markdown', {});
  const sent = outbox.enqueue('wecom', 'markdown', {});
  outbox.enqueue('wecom', 'markdown', {});
  const first = new Date('2030-01-01T00:00:00Z');
  outbox.markFailed(failed.id, 'boom', retryAfter(HOUR), first);
  outbox.markFailed(failed.id, 'boom', retryAfter(HOUR), new Date(first.getTime() + HOUR));
  outbox.markSent(sent.id);
  assert.deepEqual(outbox.counts(), { pending: 1, given_up: 1 });
});

test('the same key queues once, whatever became of the first copy', async (t) => {
  const { f } = setup(t, {});
  const { outbox } = f.ledger;
  const first = outbox.enqueue('wecom', 'markdown', { external_id: 'run:1' });
  assert.equal(outbox.enqueue('wecom', 'markdown', { external_id: 'run:1', text: '再来' }).id, first.id);
  outbox.markSent(first.id);
  assert.equal(outbox.enqueue('wecom', 'markdown', { external_id: 'run:1' }).id, first.id);
  assert.notEqual(outbox.enqueue('console', 'markdown', { external_id: 'run:1' }).id, first.id);
  assert.notEqual(outbox.enqueue('wecom', 'markdown', { external_id: 'run:2' }).id, first.id);
  assert.notEqual(outbox.enqueue('wecom', 'markdown', {}).id, outbox.enqueue('wecom', 'markdown', {}).id);
  assert.equal(f.count('outbox'), 5);
});

test('a question and its answer each queue once from the ledger itself', async (t) => {
  const { f } = setup(t, {});
  const id = f.ledger.openApproval(f.queuedTask().id, [{ question: '？' }], { actor: 'user' });
  const key = (kind: string) => f.peek<{ payload_json: string }>('SELECT * FROM outbox WHERE kind = ?', kind);
  assert.equal(JSON.parse(key('approval')[0]!.payload_json).external_id, `approval:${id}`);
  assert.equal(key('approval').length, 1);
});

test('when a real SQLite write fails, later rounds send nothing more', async (t) => {
  let calls = 0;
  const { f, sender, logs, stateOf } = setup(t, {
    wecom: async () => { calls += 1; },
  }, {}, {
    testHooks: { beforeOutboxMarkSent: (db) => db.run('PRAGMA query_only = ON') },
  });
  const first = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  f.ledger.outbox.enqueue('wecom', 'markdown', {});
  sender.start();
  await until(() => logs.length > 0, '暂停');
  await sleep(30);
  assert.equal(f.ledger.dispatchConditions().degraded, true);
  assert.equal(stateOf(first.id).state, 'pending');
  assert.equal(calls, 1);
});

test('a degraded ledger stops the round before any send', async (t) => {
  let calls = 0;
  const { f, sender, logs } = setup(t, {
    wecom: async () => {
      calls += 1;
    },
  });
  f.ledger.outbox.enqueue('wecom', 'markdown', {});
  f.ledger.outbox.takeDue = () => {
    throw new DegradedError('降级');
  };
  sender.start();
  await until(() => logs.length > 0, '暂停');
  assert.equal(calls, 0);
});

test('a slow send does not start a second round', async (t) => {
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const { f, sender, stateOf } = setup(t, {
    wecom: async () => {
      calls += 1;
      await release.promise;
    },
  });
  const row = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  sender.start();
  await sleep(40);
  assert.equal(calls, 1);
  release.resolve();
  await until(() => stateOf(row.id).state === 'sent', '发送');
  assert.equal(calls, 1);
});

test('stop waits for the send in hand and takes no further row', async (t) => {
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const { f, sender, stateOf } = setup(t, {
    wecom: async () => {
      calls += 1;
      await release.promise;
    },
  });
  const first = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  const second = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  sender.start();
  await until(() => calls === 1, '开始发送');
  const stopped = sender.stop();
  release.resolve();
  await stopped;
  assert.equal(stateOf(first.id).state, 'sent');
  assert.equal(stateOf(second.id).state, 'pending');
  assert.equal(calls, 1);
});

test('the round hook runs even when the ledger refuses the round', async (t) => {
  let hooks = 0;
  const { f, sender } = setup(t, {}, { beforeRound: () => (hooks += 1) });
  f.ledger.outbox.takeDue = () => {
    throw new DegradedError('降级');
  };
  sender.start();
  await until(() => hooks >= 2, '每轮都运行');
});


test('a skipped send is marked sent with its reason and never retried', async (t) => {
  let calls = 0;
  const { f, sender, stateOf } = setup(t, { wecom: async () => { calls += 1; return '已失效'; } });
  const row = f.ledger.outbox.enqueue('wecom', 'verify', {});
  sender.start();
  await until(() => stateOf(row.id).state === 'sent', '失效备注');
  await sleep(20);
  assert.equal(stateOf(row.id).error, '已失效');
  assert.equal(calls, 1);
});

test('the limit for giving up is read at each failure, so a change reaches rows already failing', async (t) => {
  let limit = HOUR;
  const { f, sender, stateOf } = setup(t, { wecom: async () => { throw new Error('断线'); } }, { giveUpAfterMs: () => limit });
  const row = f.ledger.outbox.enqueue('wecom', 'markdown', {});
  sender.start();
  await until(() => stateOf(row.id).tries === 1, '第一次失败');
  assert.equal(stateOf(row.id).state, 'pending');
  limit = 0;
  f.force(`UPDATE outbox SET next_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, row.id);
  await until(() => stateOf(row.id).state === 'given_up', '按新时限放弃');
});
