// Guards §11 group 6 where no backup is involved: success reported for what was never
// stored. A write that cannot reach the ledger is answered as a failure, not as a success
// the page then contradicts, and no side effect leaves the service while it is degraded;
// a message that was never written is not rediscovered after the write works again; an
// interruption that crashed on either side of the commit is either there and unconfirmed
// or not there at all, never lost silently.
// End to end: real ledger, fake CLI, fake instance, HTTP; a crash on each side of the commit.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { signIn, stage, until } from './stage.ts';
import { FLOOR, SENTENCE, options } from './acceptance-6-fixture.ts';

test(`${SENTENCE}（写入失败）`, options, async (t) => {
  const { remote, start, queued, launched, runsOf } = stage(t);
  let failing = false;
  const service = await start({
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  const task = queued(service);
  await launched(service, task);
  const client = await signIn(service);
  const messages = service.ledger.listMessages({ limit: 200 }).length;

  failing = true;
  const refused = await client.post('/api/messages', { text: '写不进去的' });
  assert.equal(refused.status, 503, `${FLOOR}：没落库的消息被确认`);
  assert.equal(service.ledger.dispatchConditions().degraded, true);
  const state = (await (await client.get('/api/state')).json()) as { dispatch: { degraded: boolean; canDispatch: boolean } };
  assert.deepEqual([state.dispatch.degraded, state.dispatch.canDispatch], [true, false], '降级要在页面上看得到');
  assert.equal((await client.post('/api/pause', { paused: true })).status, 503, `${FLOOR}：控制操作没落库却回答成功`);
  assert.equal((await client.post(`/api/tasks/${task.id}/inputs`, { text: '写不进去' })).status, 503);
  const starts = remote.called('start.sh');
  await sleep(100);
  assert.equal(remote.called('start.sh'), starts, `${FLOOR}：降级时还在启动 Worker`);

  failing = false;
  await until(() => !service.ledger.dispatchConditions().degraded, '写入恢复后解除降级');
  assert.equal(service.ledger.listMessages({ limit: 200 }).length, messages, '被拒绝的写入不能事后出现');
  assert.equal(service.ledger.dispatchConditions().paused, false);
  assert.equal(service.ledger.listInputs(task.id).length, 0);
  assert.equal((await client.post('/api/messages', { text: '恢复后的' })).status, 201);
  assert.equal(runsOf(service, task).length, 1);
});

test(`${SENTENCE}（插话提交前崩溃）`, options, async (t) => {
  const { start, crashAt, wreck, queued, launched } = stage(t);
  const first = await start();
  const task = queued(first);
  await launched(first, task);
  const client = await signIn(first);
  const crashed = crashAt('input.add', 'before');
  assert.equal((await client.post(`/api/tasks/${task.id}/inputs`, { text: '插话' })).status, 503, `${FLOOR}：没落库的插话被确认`);
  await crashed;
  await wreck(first);

  const service = await start();
  assert.equal(service.ledger.listInputs(task.id).length, 0);
});

test(`${SENTENCE}（插话提交后崩溃）`, options, async (t) => {
  const { start, crashAt, wreck, queued, launched } = stage(t);
  const first = await start();
  const task = queued(first);
  await launched(first, task);
  const client = await signIn(first);
  const crashed = crashAt('input.add', 'after');
  const response = await client.post(`/api/tasks/${task.id}/inputs`, { text: '插话' });
  await crashed;
  // Not confirmed, and still there: at most the owner sends it twice, it is never lost
  // silently, and the ledger stays what the page shows.
  assert.equal(response.status, 503);
  await wreck(first);

  const service = await start();
  assert.deepEqual(service.ledger.listInputs(task.id).map(({ text }) => text), ['插话']);
  assert.equal(service.ledger.listMessages({ limit: 200 }).filter(({ external_id }) => external_id.startsWith('input:')).length, 1);
});
