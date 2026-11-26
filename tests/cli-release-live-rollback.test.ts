// Guards what becomes of a candidate that comes up and answers, but cannot answer for
// itself: it goes back to the version before it, that version comes up again, and the
// failing step is named in the words the command prints. Both kinds of answer are here:
// - a service that cannot read its ledger: the health check is answered by the candidate
//   itself, so a version whose ledger reads fail is not called healthy;
// - the console's own build gone: the check signs in and fetches the page and the assets it
//   names, so a missing file fails where a browser would fail and not on the sign-in. After
//   a release went back nothing is tidied — the version that failed is the one to look at.
//
// The services are this repository's own, from a real release unpacked into the prefix, and
// the service manager is the one thing stood in for (see cli-release-live-fixture.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readReleaseResult } from '../service/releases.ts';
import { OLD, NEW, breakLedgerRead, currentOf, installVersion, liveStage, loseConsoleAssets, manager, oldUp, ownUnit, versionsIn } from './cli-release-live-fixture.ts';

test('起来但账本读不了的候选：退回上一版', async (t) => {
  const live = liveStage(t);
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  ownUnit(s, prefix);
  await oldUp(t, prefix, s.dataDir);
  const m = manager(t, live);

  const upgrading = installVersion(live, NEW, { mutate: breakLedgerRead });
  assert.notEqual(await m.serve('请服务管理器启动新版'), null, `这一版起得来。${m.said()}`);
  assert.notEqual(await m.serve('请服务管理器把旧版启动回来'), null, m.said());
  assert.equal(await upgrading, 1, s.text());
  assert.equal(currentOf(prefix), OLD);
  assert.match(s.err.join('\n'), /新版 1\.1\.0 没有通过健康检查：账本读不了：database is locked/);
  assert.match(s.err.join('\n'), /已经退回 1\.0\.0，账本没有动/);
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual({ ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use }, { ok: false, rolled_back: true, in_use: OLD });
  await m.stopAll();
});

test('控制台资源缺失的候选：退回上一版', async (t) => {
  const live = liveStage(t);
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  ownUnit(s, prefix);
  await oldUp(t, prefix, s.dataDir);
  const m = manager(t, live);

  const upgrading = installVersion(live, NEW, { mutate: loseConsoleAssets });
  assert.notEqual(await m.serve('请服务管理器启动新版'), null, m.said());
  assert.notEqual(await m.serve('请服务管理器把旧版启动回来'), null, m.said());
  assert.equal(await upgrading, 1, s.text());
  assert.equal(currentOf(prefix), OLD);
  // The health check signs in the way a browser does: without that it would have failed
  // on the redirect an anonymous page gets, not on the file that is missing.
  assert.match(s.out.join('\n'), /登录换到了控制台会话/);
  assert.match(s.err.join('\n'), /控制台资源 .* 取不到（404）/);
  assert.match(s.err.join('\n'), /已经退回 1\.0\.0，账本没有动/);
  // Nothing is tidied after a release went back: the version that failed is the one to
  // look at, and the one in use is the way back.
  assert.deepEqual(versionsIn(prefix), [OLD, NEW]);
  assert.match(s.out.join('\n'), /旧版本的目录这次没有清理/);
  await m.stopAll();
});
