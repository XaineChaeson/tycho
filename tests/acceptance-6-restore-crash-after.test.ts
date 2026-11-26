// Guards §11 group 6 after the replacement itself: a restore that crashed once the sealed
// copy was in place is still a restore the next start finds — paused, held, its messages
// and notifications not run again — because what was sealed is the checkpoint, not the
// process that sealed it.
// End to end: real ledger, fake CLI, fake instance, a real backup file, a crash after the rename.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { restoreBackup } from '../service/restore.ts';
import { SENTENCE, options, pastTheBackup } from './acceptance-6-fixture.ts';

test(`${SENTENCE}（restore 替换后崩溃：下次启动已经暂停且封存）`, options, async (t) => {
  const { dataDir, remote, start, backups, parked, queuedMessage, runsOf, turnsSeen } = await pastTheBackup(t);
  const starts = remote.called('start.sh');
  assert.throws(() => restoreBackup(dataDir, backups, { afterReplace() { throw new Error('崩溃'); } }), /崩溃/);
  const service = await start();
  await sleep(150);
  assert.equal(service.ledger.dispatchConditions().paused, true);
  assert.equal(runsOf(service, parked).length, 0);
  assert.equal(remote.called('start.sh'), starts);
  assert.equal(service.ledger.getMessage(queuedMessage).state, 'unverified');
  assert.equal(turnsSeen().filter((text) => text === '排在后面的').length, 1);
  assert.ok(service.ledger.getRestore());
});
