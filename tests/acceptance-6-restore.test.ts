// Guards §11 group 6 for a backup that replaced the ledger: dispatch does not resume on a
// ledger nobody has compared with the instances. The old backup is put in place stopped;
// every count it cannot answer for is held or marked for the owner, item by item, and
// neither confirming the count nor resuming a Task releases anything by itself — only the
// owner's own "resume dispatch" does, once the count is confirmed.
// End to end: real ledger, fake CLI, fake instance, HTTP, a real backup file.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { restoreBackup } from '../service/restore.ts';
import { signIn, until } from './stage.ts';
import { SENTENCE, options, pastTheBackup, restoreOf } from './acceptance-6-fixture.ts';

test(`${SENTENCE}（恢复旧备份后先清点，逐项确认，再由人恢复派发）`, options, async (t) => {
  const { dataDir, remote, start, backups, task, run, parked, timer, notice, message, queuedMessage, later, turnsSeen, runsOf } = await pastTheBackup(t);
  const starts = remote.called('start.sh');

  const summary = restoreBackup(dataDir, backups);
  assert.deepEqual(
    [summary.active_runs, summary.held_tasks, summary.unverified_messages, summary.given_up_notifications],
    [1, 2, 2, 1],
    '§2：清点摘要不对',
  );

  const verified = remote.called('state.sh', run.id);
  const release = remote.hold('state.sh');
  const restoring = start();
  await until(() => remote.called('state.sh', run.id) > verified, '开始清点');
  await sleep(150);
  assert.equal(remote.called('start.sh'), starts, '§2：旧备份恢复后没清点完就派发了');
  release();
  const service = await restoring;
  const { ledger } = service;

  assert.equal(ledger.dispatchConditions().paused, true, '§2：恢复后必须持久暂停');
  const again = ledger.getRun(run.id);
  assert.equal(again.state, 'ended', '§11 第六组：备份里非终态的 Run 没有核实');
  assert.equal(again.exit_kind, 'completed');
  assert.equal(ledger.getTask(task.id).state, 'ready', '备份之后的验收不在库里，只能按远端结果回到待验收');

  await sleep(150);
  assert.equal(runsOf(service, parked).length, 0, '§2：旧排队任务被重新派发，它在备份之后可能已经跑过');
  assert.equal(remote.called('start.sh'), starts);
  for (const held of [parked, timer]) {
    assert.deepEqual([ledger.getTask(held.id).state, ledger.getTask(held.id).reason], ['held', '恢复自备份，待确认']);
  }
  assert.equal(ledger.getMessage(message).state, 'unverified', '§11 第六组：processing 的消息没有置为待核实');
  assert.equal(ledger.getMessage(queuedMessage).state, 'unverified', '§2：received 的消息也不能假定没处理过');
  assert.equal(turnsSeen().filter((text) => text === '长回合').length, 1, '§5.1：旧备份里的消息被重投');
  assert.equal(turnsSeen().filter((text) => text === '排在后面的').length, 1, '§2：旧 received 消息被负责人消费');
  const [givenUp] = ledger.outbox.listGivenUp();
  assert.deepEqual([givenUp?.id, givenUp?.error], [notice.id, '恢复自备份'], '§2：旧通知还在重试');

  const client = await signIn(service);
  const state = (await (await client.get('/api/state')).json()) as { restore: { backup_at: string } };
  assert.ok(state.restore.backup_at, '§2：Console 要知道这是恢复来的');
  const view = await restoreOf(client);
  assert.deepEqual(view.held_tasks.map(({ id }) => id), [parked.id, timer.id]);
  assert.deepEqual(view.unverified_messages.map(({ id }) => id), [message, queuedMessage]);
  assert.deepEqual(view.runs.map(({ id, state: runState, exit_kind: kind }) => [id, runState, kind]), [[run.id, 'ended', 'completed']]);
  assert.deepEqual(view.orphan_runs[0]?.runs, [{ task_id: parked.id, run_id: later.id, alive: true }], '§2：远端有、账本没有的 Run 看不到');

  // Item by item; neither step alone lets anything run.
  const blocked = await client.post('/api/restore/confirm');
  assert.equal(blocked.status, 400, '还有没确认的任务就不能确认清点完成');
  assert.equal((await client.post(`/api/tasks/${timer.id}/abandon`, { reason: '备份后已处理' })).status, 200);
  assert.equal((await client.post(`/api/tasks/${parked.id}/resume`)).status, 200);
  await sleep(100);
  assert.equal(runsOf(service, parked).length, 0, '§2：继续不等于恢复派发');
  const early = await client.post('/api/pause', { paused: false });
  assert.equal(early.status, 400, '§2：清点没确认就能恢复派发');
  assert.equal(((await early.json()) as { error: string }).error, '先确认清点完成，再恢复派发');
  await sleep(100);
  assert.equal(runsOf(service, parked).length, 0, '§2：清点没确认，已继续的任务就被派发了');
  assert.equal((await client.post('/api/restore/confirm')).status, 200);
  await sleep(100);
  assert.equal(runsOf(service, parked).length, 0, '§2：确认清点不等于恢复派发');
  assert.equal(ledger.getRestore(), null);
  assert.equal((await client.post('/api/pause', { paused: false })).status, 200);
  await until(() => runsOf(service, parked).length === 1, '恢复派发之后才派发');
  assert.deepEqual(ledger.outbox.listGivenUp().map(({ id }) => id), [notice.id], '恢复派发也不重发旧通知');
});
