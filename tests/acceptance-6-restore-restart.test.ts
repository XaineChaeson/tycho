// Guards §11 group 6 for a restore that outlives the moment it was made: a service
// restarted on top of it still finds the ledger paused and held and still asks the owner to
// confirm, so a restart is never a way past the count.
// End to end: real ledger, fake CLI, fake instance, HTTP, a real backup file.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { restoreBackup } from '../service/restore.ts';
import { SENTENCE, options, pastTheBackup } from './acceptance-6-fixture.ts';

test(`${SENTENCE}（恢复之后又重启：仍然暂停、仍然要确认）`, options, async (t) => {
  const { dataDir, remote, start, stop, backups, parked } = await pastTheBackup(t);
  restoreBackup(dataDir, backups);
  await stop(await start());
  const starts = remote.called('start.sh');
  const service = await start();
  await sleep(100);
  assert.equal(service.ledger.dispatchConditions().paused, true);
  assert.equal(service.ledger.getTask(parked.id).state, 'held');
  assert.equal(remote.called('start.sh'), starts);
  assert.ok(service.ledger.getRestore());
});
