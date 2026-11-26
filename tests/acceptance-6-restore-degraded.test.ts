// Guards §11 group 6 while the restore mark is still there and the service is degraded:
// the count that only runs with the mark on the machine is not an owner's step, so an
// owner's confirms and pauses are refused in one voice until it finishes, the mark stays,
// and the count itself still finds what the instances have and the ledger does not.
// End to end: real ledger, fake CLI, fake instance, HTTP, a held machine listing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreBackup } from '../service/restore.ts';
import { signIn, until } from './stage.ts';
import { SENTENCE, options, pastTheBackup, restoreOf } from './acceptance-6-fixture.ts';

test(`${SENTENCE}（恢复标记还在时降级恢复：清点期间不能确认、不能动暂停，清点照常做完）`, options, async (t) => {
  const { dataDir, remote, start, backups, parked, timer, later, runsOf } = await pastTheBackup(t);
  restoreBackup(dataDir, backups);
  let failing = false;
  const service = await start({
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  const { ledger } = service;
  const client = await signIn(service);
  // Nothing left for the owner to go through: only the barrier can refuse the confirmation.
  assert.equal((await client.post(`/api/tasks/${timer.id}/abandon`, { reason: '备份后已处理' })).status, 200);
  assert.equal((await client.post(`/api/tasks/${parked.id}/resume`)).status, 200);

  failing = true;
  assert.equal((await client.post('/api/messages', { text: '写不进去的' })).status, 503);
  assert.equal(ledger.dispatchConditions().degraded, true);
  // The orphan count, which only runs while the mark is there, held on the machine.
  const inventory = remote.hold('list-runs.sh');
  const counted = remote.called('list-runs.sh');
  failing = false;
  await until(() => ledger.dispatchConditions().recovering && remote.called('list-runs.sh') > counted, '清点挂在远端');

  const attempts: [string, unknown][] = [['/api/restore/confirm', {}], ['/api/pause', { paused: false }], ['/api/pause', { paused: true }]];
  for (const [path, body] of attempts) {
    const refused = await client.post(path, body);
    assert.equal(refused.status, 503, `§2：清点还在跑，${path} 就被接受了`);
    assert.equal(((await refused.json()) as { error: string }).error, '正在清点，稍后再试');
  }
  assert.ok(ledger.getRestore(), '§2：清点期间恢复标记被删');
  inventory();
  await until(() => !ledger.dispatchConditions().recovering, '清点结束');
  assert.ok(remote.called('list-runs.sh') > counted, '§2：这一轮没有清点远端多出来的 Run');
  assert.deepEqual((await restoreOf(client)).orphan_runs[0]?.runs, [{ task_id: parked.id, run_id: later.id, alive: true }]);

  assert.equal((await client.post('/api/pause', { paused: false })).status, 400, '清点做完了，标记还在：仍然先确认');
  assert.equal((await client.post('/api/restore/confirm')).status, 200);
  assert.equal((await client.post('/api/pause', { paused: false })).status, 200);
  await until(() => runsOf(service, parked).length === 1, '人工流程走完之后才派发');
});
