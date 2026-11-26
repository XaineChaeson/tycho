// Guards the two ends of an automatic release, on a real service of a real release of this
// repository: everything here starts this repository's own service/main.ts from a release
// unpacked into the prefix, and reaches it the way a browser and an upgrade command do (a
// real login, the real console page and its assets, the real core interfaces).
// - a candidate that comes up and answers is installed, checked, and kept: the service that
//   reads `current` is stopped before `current` changes, so nothing can start the new
//   version while the release is still reading the ledger it is about to hand over;
// - a candidate that crashes on its way up goes back to the version before it, and that
//   version comes up again. The candidate is known by the lock it left behind, not by its
//   start wait running out, so the failed release is reported at once and not waited out.
//
// The service manager is the one thing stood in for (see cli-release-live-fixture.ts).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../service/db.ts';
import { readReleaseResult } from '../service/releases.ts';
import { OLD, NEW, breakEntry, currentOf, installVersion, ledgerVersion, liveStage, manager, oldUp, ownUnit } from './cli-release-live-fixture.ts';

test('正常候选：服务先停下、current 才换，新版起来并通过健康检查', async (t) => {
  const live = liveStage(t, { healthWindowMs: 300 });
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  ownUnit(s, prefix);
  // The running service watches `current` at the moment it exits. What it saw is the
  // order of the two steps, and that order is the whole of "nothing can start the
  // candidate while the release is still reading the ledger it is about to hand over".
  const witness = join(prefix, 'current-at-exit');
  const entry = join(prefix, 'versions', OLD, 'service', 'main.ts');
  writeFileSync(entry, [
    readFileSync(entry, 'utf8'),
    // Its own fs, not whatever main.ts happens to import: the file is the release's, and
    // what it imports is free to change.
    `process.on('exit', () => { const fs = process.getBuiltinModule('node:fs'); try { fs.writeFileSync(${JSON.stringify(witness)}, fs.readFileSync(${JSON.stringify(join(prefix, 'current'))}, 'utf8')); } catch {} });`,
    '',
  ].join('\n'));
  await oldUp(t, prefix, s.dataDir);

  const m = manager(t, live);
  const upgrading = installVersion(live, NEW);
  assert.notEqual(await m.serve('请服务管理器启动新版'), null, `新版服务要起得来。${m.said()}`);
  assert.equal(await upgrading, 0, s.text());
  assert.equal(currentOf(prefix), NEW);
  assert.equal(readFileSync(witness, 'utf8').trim(), OLD, '服务停了以后才换 current');
  assert.equal(m.starts(), 1, '只有这一次启动请求');
  assert.equal(ledgerVersion(s.dataDir), SCHEMA_VERSION);
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual(
    { from: result.from, to: result.to, ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use },
    { from: OLD, to: NEW, ok: true, rolled_back: false, in_use: NEW },
  );
  assert.match(s.out.join('\n'), /新版 1\.1\.0 通过健康检查/);
  await m.stopAll();
});

test('启动即崩的候选：退回上一版，旧版服务重新起来', async (t) => {
  // The start wait is the product's own: a candidate that died is known by the lock it left,
  // not by the wait running out, and the old version coming back gets the full wait too.
  const live = liveStage(t);
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  ownUnit(s, prefix);
  await oldUp(t, prefix, s.dataDir);
  const m = manager(t, live);

  const upgrading = installVersion(live, NEW, { mutate: breakEntry });
  assert.equal(await m.serve('请服务管理器启动起不来的新版'), null, '这一版起不来');
  assert.notEqual(await m.serve('请服务管理器把旧版启动回来'), null, `回退后旧版要起来。${m.said()}`);
  assert.equal(await upgrading, 1, s.text());
  assert.equal(currentOf(prefix), OLD);
  assert.match(s.err.join('\n'), /已让服务用 1\.1\.0 启动，它起来过又退出了（进程 \d+）/);
  assert.doesNotMatch(s.err.join('\n'), /秒它还没起来/, '候选死了就不该等到时限');
  assert.match(s.err.join('\n'), /新版 1\.1\.0 没有通过健康检查：服务没有在运行/);
  assert.match(s.err.join('\n'), /已经退回 1\.0\.0，账本没有动/);
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual({ ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use }, { ok: false, rolled_back: true, in_use: OLD });
  await m.stopAll();
});
