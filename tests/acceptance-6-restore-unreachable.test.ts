// Guards §11 group 6 when the instances cannot be reached while the restore mark is up:
// the count that did not happen is shown as "not counted", never as "nothing there", so an
// unanswered machine is never taken for an empty one.
// End to end: real ledger, fake CLI, fake instance, HTTP, a real backup file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreBackup } from '../service/restore.ts';
import { signIn } from './stage.ts';
import { SENTENCE, options, pastTheBackup, restoreOf } from './acceptance-6-fixture.ts';

test(`${SENTENCE}（恢复时主机不可达：如实显示未能清点）`, options, async (t) => {
  const { dataDir, remote, start, backups } = await pastTheBackup(t);
  restoreBackup(dataDir, backups);
  remote.reachable = false;
  const service = await start();
  const view = await restoreOf(await signIn(service));
  assert.equal(view.orphan_runs[0]?.runs, null, '§2：没清点到不能显示成没有');
});
