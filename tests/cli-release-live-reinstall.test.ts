// Guards the one release that is not a different version: a reinstall of the version already
// in use. `place()` sets the copy that is running aside and puts the new one in its place;
// when the reinstall fails its health check, the copy that was set aside has to come back
// under its own name — nothing left under a `.replaced-` name, and the service that comes
// back up is the one that was running.
//
// The service is this repository's own, from a real release unpacked into the prefix, and
// the service manager is the one thing stood in for (see cli-release-live-fixture.ts).
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OLD, currentOf, installVersion, liveStage, loseConsoleAssets, manager, oldUp, ownUnit, versionsIn } from './cli-release-live-fixture.ts';

test('同版本重装的候选没通过健康检查：换下来的那一份放回原名，旧版服务起来', async (t) => {
  const live = liveStage(t);
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  ownUnit(s, prefix);
  // Something of the copy that is running: it has to be back, under its own name, when the
  // reinstall is taken back.
  writeFileSync(join(prefix, 'versions', OLD, 'the-old-copy'), '');
  await oldUp(t, prefix, s.dataDir);
  const m = manager(t, live);

  const again = installVersion(live, OLD, { mutate: loseConsoleAssets });
  assert.notEqual(await m.serve('请服务管理器启动重装的那一份'), null, m.said());
  assert.notEqual(await m.serve('请服务管理器把原来那一份启动回来'), null, m.said());
  assert.equal(await again, 1, s.text());
  assert.equal(currentOf(prefix), OLD);
  assert.ok(existsSync(join(prefix, 'versions', OLD, 'the-old-copy')), '换下来的那一份要放回原名');
  assert.deepEqual(versionsIn(prefix).filter((name) => name.startsWith('.replaced-')), []);
  assert.match(s.err.join('\n'), /已经退回 1\.0\.0，账本没有动/);
  await m.stopAll();
});
