// Guards real installation, upgrade, launcher, rollback and uninstall behavior.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { RELEASE_URL } from '../cli/install.ts';
import { tempDir } from './cli-helpers.ts';
import { WINDOWS, SH, PS1, TAR, POWERSHELL, VERSION, run, launch, sandbox, variant, sharedArchive, pathWithoutNode } from './cli-install-e2e-fixture.ts';
import type { Ran } from './cli-install-e2e-fixture.ts';

test('安装、重复安装、升级、升级失败、自检、卸载', async (t) => {
  const s = sandbox(t);
  const archive = sharedArchive(t);

  const first = await s.install(archive);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(readFileSync(join(s.prefix, 'current'), 'utf8'), VERSION);
  assert.deepEqual(s.versions(), [VERSION]);
  assert.equal(existsSync(join(s.prefix, 'node')), false, 'PATH 里有合格的 Node 时不另带一份');

  const version = await s.tycho('version');
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), `tycho ${VERSION}`);
  const bogus = await s.tycho('bogus');
  assert.equal(bogus.code, 2, '启动器要把退出码传出来');
  assert.match(bogus.stderr, /tycho help/);

  const status = await s.tycho('status');
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /没有在运行/);
  assert.ok(status.stdout.includes(s.dataDir), status.stdout);
  assert.ok(status.stdout.includes(s.prefix), status.stdout);

  const again = await s.install(archive);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.deepEqual(s.versions(), [VERSION]);
  assert.equal((await s.tycho('version')).stdout.trim(), `tycho ${VERSION}`);

  // From an unpacked directory, then from a file.
  const second = await s.tycho('update', '--from', variant(s.dir, archive, '90.0.1'));
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /升级到 90\.0\.1/);
  assert.equal((await s.tycho('version')).stdout.trim(), 'tycho 90.0.1');
  assert.deepEqual(s.versions(), [VERSION, '90.0.1'].sort());

  const next = variant(s.dir, archive, '90.0.2');
  const nextArchive = join(s.dir, 'tycho-90.0.2.tar.gz');
  assert.equal(spawnSync(TAR, ['-czf', join('..', 'tycho-90.0.2.tar.gz'), '.'], { cwd: next }).status, 0);
  const third = await s.tycho('update', '--from', nextArchive);
  assert.equal(third.code, 0, third.stdout + third.stderr);
  assert.equal((await s.tycho('version')).stdout.trim(), 'tycho 90.0.2');
  assert.deepEqual(s.versions(), ['90.0.1', '90.0.2'], '留上一个版本，更早的删掉');

  const broken = join(s.dir, 'not-a-release');
  mkdirSync(broken);
  writeFileSync(join(broken, 'readme'), '');
  const failed = await s.tycho('update', '--from', broken);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /仍在用 90\.0\.2/);
  assert.equal((await s.tycho('version')).stdout.trim(), 'tycho 90.0.2');
  assert.deepEqual(s.versions(), ['90.0.1', '90.0.2']);

  const doctor = await launch(join(s.prefix, 'bin', WINDOWS ? 'tycho.cmd' : 'tycho'), ['doctor'], { ...s.env, PATH: `${join(s.prefix, 'bin')}${delimiter}${process.env.PATH}` });
  assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
  for (const title of ['Node 版本', '安装的版本', '启动器', '数据目录', 'PATH 里的 tycho']) {
    assert.match(doctor.stdout, new RegExp(`\\[正常\\] ${title}`), doctor.stdout);
  }

  mkdirSync(s.dataDir, { recursive: true });
  writeFileSync(join(s.dataDir, 'ledger.db'), '账本');
  const removed = await s.tycho('uninstall');
  assert.equal(removed.code, 0, removed.stdout + removed.stderr);
  assert.ok(removed.stdout.includes(s.dataDir), '要告诉主人数据在哪');
  // cmd must not come back looking for the launcher it was running.
  // Supported Node versions may diagnose their built-in SQLite module on stderr.
  t.diagnostic(`uninstall stderr: ${JSON.stringify(removed.stderr)}`);
  assert.match(removed.stderr.trim(), /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\))?$/, removed.stderr);
  for (const name of ['versions', 'bin', 'current']) assert.equal(existsSync(join(s.prefix, name)), false, name);
  assert.equal(readFileSync(join(s.dataDir, 'ledger.db'), 'utf8'), '账本');
});
