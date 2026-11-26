// Guards §11 group 6 before the replacement itself: a restore that crashes on the way in
// leaves the ledger that was there, with no trace of a restore and the Run the timeline
// went on with still running — nothing half in place, nothing to confirm.
// End to end: real ledger, fake CLI, fake instance, a real backup file, a crash before the rename.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreBackup } from '../service/restore.ts';
import { SENTENCE, options, pastTheBackup } from './acceptance-6-fixture.ts';

test(`${SENTENCE}（restore 替换前崩溃：下次启动是原来的账本，没有恢复痕迹）`, options, async (t) => {
  const { dataDir, start, backups, later } = await pastTheBackup(t);
  assert.throws(() => restoreBackup(dataDir, backups, { beforeReplace() { throw new Error('崩溃'); } }), /崩溃/);
  const service = await start();
  assert.equal(service.ledger.getRestore(), null);
  assert.equal(service.ledger.getRun(later.id).state, 'running', '替换前崩溃，账本还是备份之后的那一份');
});
