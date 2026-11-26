// Guards against an install, upgrade or uninstall that leaves the machine worse off: a
// launcher that breaks on a path with a quote, a space or non-ASCII characters (a .cmd is
// read in the console's code page); old versions piling up or the previous one (the way
// back) deleted; the user's PATH gaining an entry per install; an autostart left pointing
// at stale paths after an upgrade; the machine client's own definition restarted, stopped
// or left behind by one — restarting it takes the watch process of a running round with it
// (docs/design/nodes.md §1.4, §7, §11 step 3); the running service left on the old version
// without a word. And against the ways it can destroy or misreport:
// - recovery that never finishes reported as healthy, an external inventory timeout
//   causing rollback, or degraded mode during that wait being kept as merely incomplete;
// - a candidate that took the data directory and had not answered yet being judged failed and
//   taken back while it was still starting, and a candidate that cannot be confirmed stopped
//   being switched away from: the wait is the command's own budget, and the manager's answer
//   is not the confirmation that the candidate is gone;
// - a rollback that puts `current` and the install record back and leaves the machine's
//   autostart definition saying what the version just taken back meant;
// - deleting the data directory, or anything that is not the installer's, because it sat
//   under a directory with the right name; saying "your data was not touched" after that;
// - another program under a version already installed (two branches packed at the same
//   commit count) taken for a reinstall of the same one: the copy in place set aside and
//   later deleted while the version number on every page stays the same;
// - an install that fails before it switches versions leaving anything changed (a
//   reinstall of the same version above all: the old copy has to be back), and one that
//   fails after the switch being rolled back or reported as if nothing had happened;
// - deleting a version directory a service is still running from, or cleaning up while
//   it cannot be told who is running;
// - two installers at work in one prefix, one deleting what the other is unpacking;
// - stopping a service that belongs to another installation, or moving an autostart to
//   another data directory or another PATH because the terminal that upgrades has other
//   variables;
// - an ordinary update changing global command routing after an opt-out installation;
// - an uninstall that undoes changes to PATH the installer never made;
// - a Windows helper that deletes after the command ends being handed its paths through
//   cmd, promised when it never started, or deleting what is no longer in the prefix.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { autostartFor, ownerId, systemdUnit } from '../cli/autostart.ts';
import { autostartManages, deferredRemoval, serviceSpec, stopCandidate } from '../cli/install.ts';
import { launcherFiles, parseLauncher } from '../cli/launcher.ts';
import { runCli } from '../cli/main.ts';
import { readRecord, writeRecord } from '../cli/record.ts';
import { MANIFEST, writeManifest } from '../cli/manifest.ts';
import { CLIENT_LOCK } from '../node/cli.ts';
import { identityOf, writeToken } from '../node/client.ts';
import { encodedCommand, tool } from '../cli/system.ts';
import { rcLine } from '../cli/user-path.ts';
import { processStart } from '../service/lock.ts';
import { peekLedger } from '../service/ledger-peek.ts';
import { openLedger } from '../service/ledger.ts';
import { readReleaseResult } from '../service/releases.ts';
import type { Stage, StageOptions } from './cli-helpers.ts';
import { alive, exited, holdDataDir, installedStub, stage, startStub, stubApp, tempDir, until } from './cli-helpers.ts';
import { LOGIN, MACHINE, USER } from './helpers.ts';

const ONLY_WINDOWS = process.platform !== 'win32' && '要真实的 Windows：正在运行的程序删不掉、powershell.exe';

// Every row of every table of a ledger file, as a restart would find them: what proves
// that going back to the previous version left the ledger alone.
function ledgerRows(file: string): Record<string, unknown[]> {
  const conn = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name, conn.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  } finally {
    conn.close();
  }
}

// ---- The launcher ----

test('sh 启动器：读 current，用记下的 Node 运行那个版本；路径里的单引号不截断', () => {
  const { tycho } = launcherFiles({ prefix: "/home/张 三/it's/app", node: "/opt/node 24/it's/node", platform: 'linux' });
  assert.ok(tycho!.startsWith('#!/bin/sh\n'));
  assert.ok(tycho!.includes(`prefix='/home/张 三/it'\\''s/app'`), tycho);
  assert.ok(tycho!.includes('version=$(cat "$prefix/current" 2>/dev/null)'));
  assert.ok(tycho!.includes(`exec '/opt/node 24/it'\\''s/node' "$entry" "$@"`), tycho);
  assert.deepEqual(parseLauncher(tycho!), { node: "/opt/node 24/it's/node" });
});

test('cmd 启动器：只含英文字符，自己的位置取自 %~dp0，Node 用绝对路径', () => {
  const files = launcherFiles({ prefix: 'C:\\Users\\张 三\\.tycho\\app', node: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32' });
  const cmd = files['tycho.cmd']!;
  assert.match(cmd, /^[\x20-\x7e\r\n]*$/, 'cmd 按控制台代码页读这个文件');
  assert.ok(cmd.includes('|| "C:\\Program Files\\nodejs\\node.exe" "%~dp0..\\versions\\%TYCHO_VERSION%\\cli\\main.ts" %*\r\n'), cmd);
  assert.ok(cmd.includes('set /p TYCHO_VERSION=<"%~dp0..\\current"'));
  assert.doesNotMatch(cmd, /张/);
  // Git Bash gets one too, with the slashes it expects.
  assert.ok(files.tycho!.includes(`exec 'C:/Program Files/nodejs/node.exe' "$entry" "$@"`), files.tycho);
});

test('cmd 启动器：Node 路径里有非英文字符时改写成相对启动器的路径；绕不开就拒绝', () => {
  const prefix = 'C:\\Users\\张三\\.tycho\\app';
  const node = 'C:\\Users\\张三\\AppData\\Roaming\\fnm\\v24\\node.exe';
  const cmd = launcherFiles({ prefix, node, platform: 'win32' })['tycho.cmd']!;
  assert.match(cmd, /^[\x20-\x7e\r\n]*$/);
  assert.ok(cmd.includes('"%~dp0..\\..\\..\\AppData\\Roaming\\fnm\\v24\\node.exe" "%~dp0..\\versions'), cmd);
  // What it was written with is still readable, exactly.
  assert.deepEqual(parseLauncher(cmd), { node });

  assert.throws(() => launcherFiles({ prefix, node: 'D:\\工具\\node.exe', platform: 'win32' }), /英文字符/);
  assert.throws(() => launcherFiles({ prefix: 'C:\\app', node: 'C:\\工具\\node.exe', platform: 'win32' }), /英文字符/);
});

test('cmd 启动器：路径里的 % 不被 cmd 当成变量', () => {
  const node = 'C:\\100%\\node.exe';
  const cmd = launcherFiles({ prefix: 'C:\\app', node, platform: 'win32' })['tycho.cmd']!;
  assert.ok(cmd.includes('"C:\\100%%\\node.exe" '), cmd);
  // The record line is a rem, where cmd still expands "%": none may appear in it.
  assert.doesNotMatch(cmd.split('\r\n')[1]!, /%/);
  assert.deepEqual(parseLauncher(cmd), { node });
});

// ---- install-self ----

const NODE = process.execPath;

// A release unpacked where the install scripts put it: in a staging directory that
// carries the installer's process id.
function unpacked(s: Stage, version: string, prefix = join(s.dir, 'prefix')): string {
  s.cli.appRoot = stubApp(join(prefix, 'versions', `.staging-${process.pid}-${version}`), version);
  return prefix;
}

async function install(s: Stage, version: string, prefix?: string, node = NODE): Promise<{ prefix: string; code: number }> {
  const at = unpacked(s, version, prefix);
  return { prefix: at, code: await runCli(['install-self', '--prefix', at, '--node', node], s.cli) };
}

// The command as the installed copy of this version.
const as = (s: Stage, prefix: string, version: string): Stage => {
  s.cli.appRoot = join(prefix, 'versions', version);
  return s;
};

const versionsIn = (prefix: string): string[] => readdirSync(join(prefix, 'versions')).sort();
const rc = (s: Stage): string => join(s.home, '.bashrc');
const bashLine = (s: Stage, prefix: string): string => rcLine(s.cli.system, join(prefix, 'bin'));

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'close');
  return child.pid!;
}

test('首次安装：版本目录、current、启动器、PATH 都就位，记下装了什么，并说下一步', async (t) => {
  const s = stage(t);
  const { prefix, code } = await install(s, '1.0.0');
  assert.equal(code, 0, s.text());
  assert.deepEqual(readdirSync(prefix).sort(), ['bin', 'current', 'install.json', 'versions']);
  assert.deepEqual(versionsIn(prefix), ['1.0.0']);
  assert.ok(existsSync(join(prefix, 'versions', '1.0.0', 'cli', 'main.ts')));
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.deepEqual(parseLauncher(readFileSync(join(prefix, 'bin', 'tycho'), 'utf8')), { node: NODE });
  assert.equal(readFileSync(rc(s), 'utf8'), `${bashLine(s, prefix)}\n`);
  // What an uninstall will undo, and nothing more.
  const record = readRecord(prefix)!;
  assert.deepEqual(record.files.sort(), ['bin/tycho', 'current', 'versions/1.0.0']);
  assert.deepEqual(record.paths, [{ kind: 'rc', file: rc(s), line: bashLine(s, prefix), created: true }]);
  assert.match(s.text(), /新开一个终端/);
  assert.match(s.text(), /tycho run --open/);
  assert.match(s.text(), /tycho service install/);
});

test('Windows：两个启动器；用户 PATH 只加一次，加过的那一条记下来', async (t) => {
  let onPath = false;
  const edits: Record<string, string>[] = [];
  const s = stage(t, {
    platform: 'win32',
    respond(call) {
      if (call.env.TYCHO_TASK) return { stdout: 'absent\r\n' };
      if (call.env.TYCHO_OP !== 'add') return { code: 1 };
      edits.push(call.env);
      const was = onPath;
      onPath = true;
      return { stdout: was ? 'unchanged\r\n' : 'changed\r\n' };
    },
  });
  const { prefix, code } = await install(s, '1.0.0');
  assert.equal(code, 0, s.text());
  const bin = join(prefix, 'bin');
  assert.deepEqual(readdirSync(bin).sort(), ['tycho', 'tycho.cmd']);
  assert.deepEqual(edits, [{ TYCHO_VAR: 'Path', TYCHO_ENTRY: bin, TYCHO_OP: 'add' }]);
  assert.deepEqual(readRecord(prefix)!.paths, [{ kind: 'windows', entry: bin }]);
  assert.deepEqual(readRecord(prefix)!.files.sort(), ['bin/tycho', 'bin/tycho.cmd', 'current', 'versions/1.0.0']);

  const again = await install(s, '1.0.0', prefix);
  assert.equal(again.code, 0);
  assert.equal(readRecord(prefix)!.paths.length, 1, '已经在 PATH 里就不再记一条');
});

test('同版本重装：覆盖原来那份，不留下换下来的', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  writeFileSync(join(prefix, 'versions', '1.0.0', 'left-over'), '');
  const again = await install(s, '1.0.0', prefix);
  assert.equal(again.code, 0, s.text());
  assert.deepEqual(versionsIn(prefix), ['1.0.0']);
  assert.equal(existsSync(join(prefix, 'versions', '1.0.0', 'left-over')), false);
  assert.match(s.text(), /重新装好/);
  // One line, and one entry in the record, however many installs.
  assert.equal(readFileSync(rc(s), 'utf8').split('\n').filter((line) => line.includes('# tycho')).length, 1);
  assert.deepEqual(readRecord(prefix)!.files.sort(), ['bin/tycho', 'current', 'versions/1.0.0']);
});

test('升级：current 换到新版本，留上一个版本，更早的删掉', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  await install(s, '1.1.0', prefix);
  assert.deepEqual(versionsIn(prefix), ['1.0.0', '1.1.0']);
  const third = await install(s, '1.2.0', prefix);
  assert.equal(third.code, 0, s.text());
  assert.deepEqual(versionsIn(prefix), ['1.1.0', '1.2.0']);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.2.0');
  assert.match(s.text(), /从 1\.1\.0 升级到 1\.2\.0/);
  assert.deepEqual(readRecord(prefix)!.files.sort(), ['bin/tycho', 'current', 'versions/1.1.0', 'versions/1.2.0']);
});

test('版本清理只删安装器放的版本目录：名字像版本号、里面却不是这个程序的发布包的，不动', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const versions = join(prefix, 'versions');
  mkdirSync(join(versions, '0.5.0'));
  writeFileSync(join(versions, '0.5.0', 'mine.txt'), '主人自己放的');
  mkdirSync(join(versions, '0.6.0'));
  writeFileSync(join(versions, '0.6.0', 'package.json'), JSON.stringify({ name: 'something-else', version: '0.6.0' }));
  // A release of this program, but not the one its directory is named for.
  stubApp(join(versions, '0.7.0'), '9.9.9');
  mkdirSync(join(versions, 'notes'));
  writeFileSync(join(versions, 'readme.txt'), '');
  await install(s, '1.1.0', prefix);
  assert.equal((await install(s, '1.2.0', prefix)).code, 0, s.text());
  assert.deepEqual(versionsIn(prefix), ['0.5.0', '0.6.0', '0.7.0', '1.1.0', '1.2.0', 'notes', 'readme.txt']);
});

test('不是 tycho 的发布包、或版本号不能当目录名用的，被拒绝，什么都不动', async (t) => {
  const bad = stage(t);
  const prefix = unpacked(bad, '../../escape');
  assert.equal(await runCli(['install-self', '--prefix', prefix, '--node', NODE], bad.cli), 1);
  assert.match(bad.text(), /版本号/);
  assert.equal(existsSync(join(prefix, 'current')), false);
  assert.equal(existsSync(join(prefix, 'bin')), false);

  const other = stage(t);
  const at = unpacked(other, '1.0.0');
  const manifest = join(other.cli.appRoot, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...(JSON.parse(readFileSync(manifest, 'utf8')) as object), name: 'something-else' }));
  assert.equal(await runCli(['install-self', '--prefix', at, '--node', NODE], other.cli), 1);
  assert.match(other.text(), /不是 tycho 的发布包/);
  assert.equal(existsSync(join(at, 'current')), false);
});

test('TYCHO_NO_MODIFY_PATH：不碰 PATH，并说命令在哪', async (t) => {
  const s = stage(t, { env: { TYCHO_NO_MODIFY_PATH: '1' } });
  const { prefix, code } = await install(s, '1.0.0');
  assert.equal(code, 0);
  assert.equal(existsSync(rc(s)), false);
  assert.deepEqual(readRecord(prefix)!.paths, []);
  assert.ok(s.text().includes(join(prefix, 'bin', 'tycho')));
});

// ---- The commit point: before it everything is put back, after it nothing is ----

test('切换版本之前失败：current、原来的版本、启动器都和安装前一样', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const launcher = readFileSync(join(prefix, 'bin', 'tycho'), 'utf8');
  // `current` cannot be written: where it goes is now a directory. By then the new
  // version is in place and the launcher rewritten for another Node.
  const other = join(s.dir, 'another-node');
  writeFileSync(other, '');
  const current = join(prefix, 'current');
  s.out.length = 0;
  const failed = await (async () => {
    rmSync(current);
    mkdirSync(current);
    return install(s, '2.0.0', prefix, other);
  })();
  assert.equal(failed.code, 1);
  assert.deepEqual(versionsIn(prefix), ['.staging-' + process.pid + '-2.0.0', '1.0.0'], '新版本回到它解开的地方，由解开它的人收走');
  assert.equal(readFileSync(join(prefix, 'bin', 'tycho'), 'utf8'), launcher, '启动器不动');
  assert.match(s.err.join('\n'), /没有装上 2\.0\.0/);
  assert.doesNotMatch(s.out.join('\n'), /升级到 2\.0\.0/);
  assert.equal(existsSync(join(prefix, 'install.lock')), false, '失败了也要放开锁');
});

test('切换版本之前失败：升级没有完成，仍在用原来的版本，并这么说', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  // The launcher cannot be written: where it goes is now a directory.
  rmSync(join(prefix, 'bin', 'tycho'));
  mkdirSync(join(prefix, 'bin', 'tycho'));
  const failed = await install(s, '2.0.0', prefix);
  assert.equal(failed.code, 1);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.ok(existsSync(join(prefix, 'versions', '1.0.0', 'cli', 'main.ts')));
  assert.equal(existsSync(join(prefix, 'versions', '2.0.0')), false);
  assert.match(s.err.join('\n'), /仍在用 1\.0\.0，和安装前一样/);
  assert.doesNotMatch(s.out.join('\n'), /升级到 2\.0\.0/);
});

test('同一个版本号下是另一份程序：拒绝，不当重装，什么都不换', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const installedCli = readFileSync(join(prefix, 'versions', '1.0.0', 'cli', 'main.ts'), 'utf8');
  // Packed from another branch at the same commit count: same number, other code.
  unpacked(s, '1.0.0', prefix);
  writeFileSync(join(s.cli.appRoot, 'cli', 'main.ts'), `console.log('another branch');\n`);
  writeManifest(s.cli.appRoot);
  const other = await runCli(['install-self', '--prefix', prefix, '--node', NODE], s.cli);
  assert.equal(other, 1, s.text());
  assert.match(s.err.join('\n'), /版本 1\.0\.0 下已经装着另一份程序（多半是从另一条分支打的包），这次不换；要装请先从同一条主线打包/);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.equal(readFileSync(join(prefix, 'versions', '1.0.0', 'cli', 'main.ts'), 'utf8'), installedCli, '装着的那一份原样');
  assert.deepEqual(versionsIn(prefix).filter((name) => name.startsWith('.replaced-')), []);
});

test('同一个版本号下装着的那一份没有发布清单：确认不了是同一份，同样拒绝', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  rmSync(join(prefix, 'versions', '1.0.0', MANIFEST));
  const again = await install(s, '1.0.0', prefix);
  assert.equal(again.code, 1, s.text());
  assert.match(s.err.join('\n'), /版本 1\.0\.0 下已经装着另一份程序/);
  assert.equal(existsSync(join(prefix, 'versions', '1.0.0', 'cli', 'main.ts')), true);
});

test('同版本重装在切换之前失败：原来那一份的内容还在原处', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  writeFileSync(join(prefix, 'versions', '1.0.0', 'the-old-copy'), '');
  rmSync(join(prefix, 'bin', 'tycho'));
  mkdirSync(join(prefix, 'bin', 'tycho'));
  const failed = await install(s, '1.0.0', prefix);
  assert.equal(failed.code, 1);
  // `current` says 1.0.0 before and after: what matters is which copy that is.
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.ok(existsSync(join(prefix, 'versions', '1.0.0', 'the-old-copy')), '被换下来的那一份要移回原名');
  assert.deepEqual(versionsIn(prefix).filter((name) => name.startsWith('.replaced-')), []);
  assert.match(s.err.join('\n'), /仍在用 1\.0\.0，和安装前一样/);
});

// ---- An installed autostart follows the upgrade ----

// An autostart this installation owns, written by some earlier version.
const staleOwn = (s: Stage, prefix: string): string =>
  `# tycho-autostart owner:${ownerId(serviceSpec(s.cli.system, join(prefix, 'versions', '1.0.0')))}\nan older format\n`;

function systemdInstalled(s: Stage, content: string): string {
  const file = join(s.home, '.config', 'systemd', 'user', 'tycho.service');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  return file;
}

// The machine client's own definition, beside the host's: its own file, its own mark.
function nodeUnitInstalled(s: Stage, content: string): string {
  const file = join(s.home, '.config', 'systemd', 'user', 'tycho-node.service');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const askedToStart = (s: Stage): boolean => s.calls.some(({ file, args }) => file === 'systemctl' && (args.includes('--now') || args.includes('start')));

test('升级时已装的开机自启：定义同步，服务停掉后用新版本重新启动', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const unit = systemdInstalled(s, staleOwn(s, prefix));
  const old = await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  const upgrading = install(s, '1.1.0', prefix);
  // The manager accepting the request is one thing, the service coming up another: the
  // fake only records the request, and this test is what brings the service up.
  await until('请 systemd 启动服务', () => askedToStart(s));
  assert.equal(alive(old), false, '原来的服务要先停');
  const fresh = await startStub(t, s.dataDir, {}, installedStub(prefix, '1.1.0'));
  assert.equal((await upgrading).code, 0, s.text());
  assert.equal(readFileSync(unit, 'utf8'), systemdUnit(serviceSpec(s.cli.system, join(prefix, 'versions', '1.1.0'))));
  // Through the launcher, which the next upgrade leaves in place.
  assert.ok(readFileSync(unit, 'utf8').includes(join(prefix, 'bin', 'tycho').replaceAll('\\', '\\\\')));
  assert.match(s.text(), /已让服务用这个版本启动/);
  assert.equal(alive(fresh), true);
  // The new version ran and was checked: that, and not merely "the files are in place", is
  // what the record says happened.
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual(
    { from: result.from, to: result.to, verified: result.verified, ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use },
    { from: '1.0.0', to: '1.1.0', verified: true, ok: true, rolled_back: false, in_use: '1.1.0' },
  );
});

test('新版恢复清点超时：保留运行中的版本，记录未验证和待核对步骤，命令不报成功', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  systemdInstalled(s, staleOwn(s, prefix));
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  // The first install rightly says it is unverified; only the upgrade's own output counts here.
  const before = { out: s.out.length, err: s.err.length };
  const upgrading = install(s, '1.1.0', prefix);
  await until('请 systemd 启动新版', () => askedToStart(s));
  const fresh = await startStub(t, s.dataDir, { STUB_RECOVERING: '1', STUB_RECOVERY_WAIT_MS: '10' }, installedStub(prefix, '1.1.0'));
  assert.equal((await upgrading).code, 1, s.text());
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.1.0');
  assert.equal(alive(fresh), true);
  assert.equal(startRequests(s), 1, '不能因为外部机器还没完成清点就回退');
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual({ verified: result.verified, ok: result.ok, rolled_back: result.rolled_back }, { verified: false, ok: false, rolled_back: false });
  assert.deepEqual(result.pending, ['恢复清点尚未完成']);
  // Not rolled back, so the record is not put back either: the copy kept for a rollback
  // goes the moment the upgrade has settled, verified or not.
  assert.equal(existsSync(join(prefix, 'install.json.before-upgrade')), false, '没有回退就不放回副本，副本随升级落定删掉');
  const upgrade = [...s.out.slice(before.out), ...s.err.slice(before.err)].join('\n');
  assert.match(upgrade, /版本已在跑、核对没做完.*恢复清点尚未完成/);
  assert.doesNotMatch(upgrade, /新版 1\.1\.0 通过健康检查|下次启动才生效/);
});

test('新版等待清点时进入降级：判失败并回退，不能保留为清点超时', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  systemdInstalled(s, staleOwn(s, prefix));
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  const upgrading = install(s, '1.1.0', prefix);
  await until('请 systemd 启动新版', () => askedToStart(s));
  const candidate = await startStub(t, s.dataDir, {
    STUB_RECOVERY_WAIT_MS: '10',
    STUB_FACTS_SEQUENCE: JSON.stringify([{ recovering: true }, { degraded: true, recovering: false }]),
  }, installedStub(prefix, '1.1.0'));
  await until('请 systemd 重启旧版', () => startRequests(s) === 2);
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  assert.equal((await upgrading).code, 1, s.text());
  assert.equal(alive(candidate), false);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual({ verified: result.verified, ok: result.ok, rolled_back: result.rolled_back }, { verified: true, ok: false, rolled_back: true });
  assert.equal(result.pending, undefined);
  assert.match(result.lines.join('\n'), /账本写不进去，服务在降级模式/);
});

// The failure the real acceptance found: a service run in the foreground is not this
// installation's autostart's to stop, so nothing was started on the new version, no health
// check happened — and the record said ok: true all the same, with `current` already
// pointing at a version nobody had run.
test('服务不归开机自启管：在跑的服务不动，记录写成未验证，命令说清下次启动才生效', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const running = await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  s.out.length = 0;

  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.1.0');
  assert.match(s.out.join('\n'), /装上了 tycho 1\.1\.0，但这一版还没有验证/);
  assert.match(s.out.join('\n'), /下次启动才生效/);
  assert.match(s.out.join('\n'), /在跑的服务还是原来那一版/);
  assert.equal(alive(running), true, '不是这一份管的服务，不替它重启');
  assert.equal(askedToStart(s), false, '没有谁被请求启动新版');

  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual(
    { from: result.from, to: result.to, verified: result.verified, ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use },
    { from: '1.0.0', to: '1.1.0', verified: false, ok: false, rolled_back: false, in_use: '1.1.0' },
  );
  assert.ok(result.lines.some((line) => line.includes('这一版还没有验证')), result.lines.join('\n'));
});

// Nothing running at all: the same answer, with the way to use the version in the owner's
// hands and no claim that anything was checked.
test('没有服务在跑：记录同样写成未验证，并说下次启动才用上它', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  // A data directory the owner has run a service on, with nothing running in it now.
  mkdirSync(s.dataDir, { recursive: true });
  s.out.length = 0;
  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.match(s.out.join('\n'), /下次启动才生效/);
  assert.doesNotMatch(s.out.join('\n'), /在跑的服务还是原来那一版/);
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual({ verified: result.verified, ok: result.ok, in_use: result.in_use }, { verified: false, ok: false, in_use: '1.1.0' });
});

test('升级时已装的开机自启：服务没在跑就只同步定义，不替主人启动', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const unit = systemdInstalled(s, staleOwn(s, prefix));
  assert.equal((await install(s, '1.1.0', prefix)).code, 0);
  assert.doesNotMatch(readFileSync(unit, 'utf8'), /an older format/);
  assert.equal(askedToStart(s), false);
});

// One program, two roles: the machine client's definition follows the upgrade, and its
// program does not (docs/design/nodes.md §1.4, §7, §11 step 3). The file is rewritten so
// that the next login starts the client this version's shape says, and systemd is never
// asked to stop, restart or start it: the client running now, and the watch process of
// every round it started, are not this command's to end. What this catches: an upgrade
// that restarts the client through systemd to "put it on the new version" (a running
// round's watch process dies with it), one that leaves the definition as the version it
// replaced wrote it, and one that drops the role's slot from the install record.
test('升级：机器客户端的自启定义按新版重写，systemd 那边只问不改', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  // The definition as an earlier version left it, plus a line only that older format has:
  // both versions start the same launcher, so the shapes are alike and that line is what
  // tells a rewrite from a file nobody touched.
  const nodeUnit = nodeUnitInstalled(
    s,
    `${systemdUnit(serviceSpec(s.cli.system, join(prefix, 'versions', '1.0.0'), s.dataDir, undefined, 'node'))}# 上一版留下的行\n`,
  );
  writeRecord(prefix, { ...readRecord(prefix)!, autostart: { node: { dataDir: s.dataDir } } });
  s.calls.length = 0;
  s.out.length = 0;

  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.equal(
    readFileSync(nodeUnit, 'utf8'),
    systemdUnit(serviceSpec(s.cli.system, join(prefix, 'versions', '1.1.0'), s.dataDir, undefined, 'node')),
    '客户端那一份定义按新版本重写',
  );
  assert.match(s.out.join('\n'), /机器客户端的开机自启定义已同步/);
  // Everything systemd was asked about that unit: whether it is enabled, and (without
  // --now) to enable the definition just written. No stop, no restart, no start.
  const about = s.calls.filter(({ file, args }) => file === 'systemctl' && args.includes('tycho-node.service'));
  assert.deepEqual(about.filter(({ args }) => args.some((arg) => ['stop', 'restart', 'start', '--now'].includes(arg))), []);
  assert.deepEqual(
    [...new Set(about.flatMap(({ args }) => args.filter((arg) => arg !== '--user' && arg !== 'tycho-node.service')))].sort(),
    ['enable', 'is-enabled'],
  );
  // The role keeps its slot: the next command of this installation still knows which data
  // directory the client's autostart runs on.
  assert.deepEqual(readRecord(prefix)!.autostart, { node: { dataDir: s.dataDir } });
});

// The other half of the same rule: another copy of tycho on this computer has its own client
// autostart, and an upgrade of this one is not the command that should point it at another
// program (or at another data directory).
test('升级：另一份 tycho 的客户端自启不被改写', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const nodeUnit = nodeUnitInstalled(s, '# tycho-autostart owner:0123456789abcdef\nstarts another copy\n');
  writeRecord(prefix, { ...readRecord(prefix)!, autostart: { node: { dataDir: s.dataDir } } });
  s.calls.length = 0;
  s.out.length = 0;

  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.equal(readFileSync(nodeUnit, 'utf8'), '# tycho-autostart owner:0123456789abcdef\nstarts another copy\n');
  assert.doesNotMatch(s.out.join('\n'), /机器客户端的开机自启定义已同步/);
  assert.deepEqual(
    s.calls.filter(({ file, args }) => file === 'systemctl' && args.includes('tycho-node.service') && args.some((arg) => ['stop', 'restart', 'start', '--now', 'enable'].includes(arg))),
    [],
    '另一份的定义一个动词都不该被问到',
  );
});

test('升级时先让负责人收尾手头这一回合，再停服务：服务停了以后才切 current', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 5000;
  const { prefix } = await install(s, '1.0.0');
  systemdInstalled(s, staleOwn(s, prefix));
  const trace = join(s.dir, 'trace');
  await startStub(t, s.dataDir, { STUB_TRACE: trace, STUB_DRAIN_MS: '1500' }, installedStub(prefix, '1.0.0'));
  const upgrading = install(s, '1.1.0', prefix);
  await until('请 systemd 启动新版', () => askedToStart(s));
  // The stop is the upgrade's own doing, and it comes before the version is switched: what
  // the launcher reads has to be the old version for as long as anything can read it.
  assert.equal(readFileSync(trace, 'utf8'), 'drain\nshutdown\n', '等回合结束的请求要在停服务之前');
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.1.0'));
  assert.equal((await upgrading).code, 0, s.text());
  assert.match(s.out.join('\n'), /等负责人把手头这一回合做完（2 秒），现在停服务/);
});

test('升级时服务不问等待回合（旧版服务）：照常停它，不因此停下升级', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 5000;
  const { prefix } = await install(s, '1.0.0');
  systemdInstalled(s, staleOwn(s, prefix));
  // STUB_DRAIN_MS 之外的另一个办法：让等待那个接口答 404，像一版还不认识它的服务。
  await startStub(t, s.dataDir, { STUB_NO_DRAIN: '1' }, installedStub(prefix, '1.0.0'));
  const upgrading = install(s, '1.1.0', prefix);
  await until('请 systemd 启动新版', () => askedToStart(s));
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.1.0'));
  assert.equal((await upgrading).code, 0, s.text());
  assert.match(s.out.join('\n'), /没能让服务先收尾手头的回合/);
});

// The service manager being asked to start the service: what an upgrade and a rollback
// both do, so their number tells which of the two happened.
const startRequests = (s: Stage): number =>
  s.calls.filter(({ file, args }) => file === 'systemctl' && args.includes('start')).length;

test('原来的服务停不下来：什么都不换，如实报告', async (t) => {
  const s = stage(t);
  s.cli.timing.stopWaitMs = 200;
  const { prefix } = await install(s, '1.0.0');
  const unit = systemdInstalled(s, staleOwn(s, prefix));
  const stuck = await startStub(t, s.dataDir, { STUB_STOP_DELAY_MS: '60000' }, installedStub(prefix, '1.0.0'));
  assert.equal((await install(s, '1.1.0', prefix)).code, 1);
  assert.match(s.err.join('\n'), /原来的服务（进程 \d+）没有停下来/);
  assert.match(s.err.join('\n'), /这次什么都没有换：还是在 1\.0\.0/);
  // The switch never happened, so nothing is left half done: no new version directory, the
  // definition untouched, no start asked for, and the service still running.
  assert.equal(versionsIn(prefix).includes('1.1.0'), false, '没有装上的版本不留目录');
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.match(readFileSync(unit, 'utf8'), /an older format/);
  assert.equal(askedToStart(s), false);
  assert.equal(alive(stuck), true);
  const result = JSON.parse(readFileSync(join(s.dataDir, 'release.json'), 'utf8')) as { from: string; to: string; ok: boolean; rolled_back: boolean; in_use: string };
  assert.deepEqual(
    { from: result.from, to: result.to, ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use },
    { from: '1.0.0', to: '1.1.0', ok: false, rolled_back: false, in_use: '1.0.0' },
  );
});

// ---- Whose service it is ----

test('另一份 tycho 装的开机自启、另一份 tycho 的服务：升级和卸载这一份时都不动它们', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const foreign = '# tycho-autostart owner:0123456789abcdef\nExecStart=/another/copy/bin/tycho run\n';
  const unit = systemdInstalled(s, foreign);
  // On the same data directory, from somewhere outside this prefix.
  const running = await startStub(t, s.dataDir);
  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.equal(readFileSync(unit, 'utf8'), foreign);
  assert.equal(alive(running), true, '不是这一份管的服务，不替它重启');
  assert.match(s.text(), /另一份 tycho/);
  // Asking whether it is enabled is all that reaches systemd.
  assert.deepEqual(s.calls.filter(({ file, args }) => file === 'systemctl' && !args.includes('is-enabled')), []);

  s.out.length = 0;
  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.1.0').cli), 0, s.text());
  assert.equal(readFileSync(unit, 'utf8'), foreign);
  assert.equal(alive(running), true, '卸载这一份，不能停掉另一份正在工作的服务');
  assert.match(s.out.join('\n'), /没有停它/);
  assert.match(s.out.join('\n'), /不是这一份可管理的定义；没有动它/);
});

test('开机自启是这一份的，但数据目录上跑着另一份：定义同步，不停它', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const unit = systemdInstalled(s, staleOwn(s, prefix));
  const running = await startStub(t, s.dataDir);
  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.equal(alive(running), true);
  assert.doesNotMatch(readFileSync(unit, 'utf8'), /an older format/);
  assert.equal(askedToStart(s), false);
});

// The fact the console's release rests on, asked before it starts anything: only a service
// this installation's autostart runs can be stopped by the upgrade and started again on the
// version just put in place. Everything else would move `current` under a service that goes
// on running the old program, with nothing having run the new one.
test('谁在管这个服务：这份安装的自启、而且记的是这个数据目录，才算', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const appRoot = join(prefix, 'versions', '1.0.0');

  const none = autostartManages(s.cli.system, appRoot, s.dataDir);
  assert.equal(none.managed, false);
  assert.match(none.why, /没有装这个安装的开机自启/);

  systemdInstalled(s, staleOwn(s, prefix));
  assert.deepEqual(autostartManages(s.cli.system, appRoot, s.dataDir), { managed: true, why: '' });

  // Another copy of tycho installed the autostart this machine has.
  systemdInstalled(s, '# tycho-autostart owner:0123456789abcdef\nExecStart=/another/copy/bin/tycho run\n');
  const foreign = autostartManages(s.cli.system, appRoot, s.dataDir);
  assert.equal(foreign.managed, false);
  assert.match(foreign.why, /启动的是另一份 tycho/);

  // This installation's autostart, installed for another data directory: the service that
  // is running here was started by something else.
  systemdInstalled(s, staleOwn(s, prefix));
  const elsewhere = join(s.dir, 'another-data');
  writeRecord(prefix, { ...readRecord(prefix)!, autostart: { host: { dataDir: elsewhere } } });
  const other = autostartManages(s.cli.system, appRoot, s.dataDir);
  assert.equal(other.managed, false);
  assert.ok(other.why.includes(elsewhere), other.why);

  // A checkout has no version to switch to at all.
  assert.equal(autostartManages(s.cli.system, join(s.dir, 'checkout'), s.dataDir).managed, false);
});

test('开机自启装的时候用的数据目录，换一个没设 TYCHO_DATA 的终端升级，也不被改掉', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 50;
  const { prefix } = await install(s, '1.0.0');
  // Installed for the data directory of that terminal; the service never comes up here.
  await runCli(['service', 'install'], as(s, prefix, '1.0.0').cli);
  const unit = join(s.home, '.config', 'systemd', 'user', `tycho-${ownerId(serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir))}.service`);
  assert.ok(readFileSync(unit, 'utf8').includes(`TYCHO_DATA=${s.dataDir}`.replaceAll('\\', '\\\\')));
  assert.deepEqual(readRecord(prefix)!.autostart, { host: { dataDir: s.dataDir } });

  s.cli.system.env.TYCHO_DATA = join(s.dir, 'another terminal');
  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.ok(readFileSync(unit, 'utf8').includes(`TYCHO_DATA=${s.dataDir}`.replaceAll('\\', '\\\\')), '升级不把自启动挪到别的数据目录');
  assert.doesNotMatch(readFileSync(unit, 'utf8'), /another terminal/);
  // And the self-check from that terminal does not call it stale, which --fix would then "repair".
  s.out.length = 0;
  await runCli(['service', 'status'], as(s, prefix, '1.1.0').cli);
  assert.doesNotMatch(s.out.join('\n'), /过期/);

  await runCli(['service', 'uninstall'], s.cli);
  assert.equal(readRecord(prefix)!.autostart, undefined);
});

// ---- A version directory in use is not cleaned up ----

test('手动运行的服务还在用的版本目录不清理；它停了以后，下次升级时清掉', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const running = await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  assert.equal((await install(s, '1.1.0', prefix)).code, 0);
  assert.equal(alive(running), true, '手动运行的服务由主人自己重启');
  assert.match(s.text(), /原来那个版本/);
  assert.equal((await install(s, '1.2.0', prefix)).code, 0, s.text());
  assert.deepEqual(versionsIn(prefix), ['1.0.0', '1.1.0', '1.2.0'], '1.0.0 还有服务在用');

  assert.equal(await runCli(['stop'], as(s, prefix, '1.2.0').cli), 0);
  assert.equal((await install(s, '1.3.0', prefix)).code, 0, s.text());
  assert.deepEqual(versionsIn(prefix), ['1.2.0', '1.3.0']);
});

test('同版本重装时手动运行的服务还在跑：换下来的那一份留着并说明，服务停了以后清掉', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  writeFileSync(join(prefix, 'versions', '1.0.0', 'the-old-copy'), '');
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  assert.equal((await install(s, '1.0.0', prefix)).code, 0, s.text());
  const [aside] = versionsIn(prefix).filter((name) => name.startsWith('.replaced-'));
  assert.ok(aside && existsSync(join(prefix, 'versions', aside, 'the-old-copy')), '服务还在用换下来的那一份');
  assert.match(s.out.join('\n'), /还有服务在用它/);

  assert.equal(await runCli(['stop'], as(s, prefix, '1.0.0').cli), 0);
  assert.equal((await install(s, '1.0.0', prefix)).code, 0, s.text());
  assert.deepEqual(versionsIn(prefix), ['1.0.0']);
});

test('开机自启装的时候的 PATH 记在安装记录里：换个终端看不算过期，升级和 --fix 沿用它，再装一次才换', async (t) => {
  const s = stage(t, { env: { PATH: '/first/terminal' } });
  s.cli.timing.startWaitMs = 50;
  const { prefix } = await install(s, '1.0.0');
  await runCli(['service', 'install'], as(s, prefix, '1.0.0').cli);
  const unit = join(s.home, '.config', 'systemd', 'user', `tycho-${ownerId(serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir))}.service`);
  assert.ok(readFileSync(unit, 'utf8').includes('Environment="PATH=/first/terminal"'));
  assert.deepEqual(readRecord(prefix)!.autostart, { host: { dataDir: s.dataDir, path: '/first/terminal' } });

  s.cli.system.env.PATH = '/another/terminal';
  s.out.length = 0;
  await runCli(['service', 'status'], s.cli);
  assert.doesNotMatch(s.out.join('\n'), /过期/);
  s.out.length = 0;
  await runCli(['doctor'], s.cli);
  assert.doesNotMatch(s.out.join('\n'), /过期/, s.text());

  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.ok(readFileSync(unit, 'utf8').includes('Environment="PATH=/first/terminal"'), '升级不换 PATH');
  assert.equal(readRecord(prefix)!.autostart!.host!.path, '/first/terminal', '升级不丢记录');

  // A definition gone stale otherwise is rewritten with what was kept.
  writeFileSync(unit, staleOwn(s, prefix));
  await runCli(['doctor', '--fix'], as(s, prefix, '1.1.0').cli);
  assert.ok(readFileSync(unit, 'utf8').includes('Environment="PATH=/first/terminal"'), '--fix 不换 PATH');

  await runCli(['service', 'install'], s.cli);
  assert.ok(readFileSync(unit, 'utf8').includes('Environment="PATH=/another/terminal"'), '再运行一次 service install 就按当时的 PATH');
  assert.equal(readRecord(prefix)!.autostart!.host!.path, '/another/terminal');
});

test('记录里没有 PATH 的开机自启（这一版之前装的）：升级不从升级的终端里拿一份', async (t) => {
  const s = stage(t, { env: { PATH: '/upgrading/terminal' } });
  const { prefix } = await install(s, '1.0.0');
  const unit = systemdInstalled(s, staleOwn(s, prefix));
  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.doesNotMatch(readFileSync(unit, 'utf8'), /an older format/);
  assert.doesNotMatch(readFileSync(unit, 'utf8'), /PATH=/);
});

test('数据目录被占着、没人回答是哪个版本在用：什么都不清理，并报告', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  await install(s, '1.1.0', prefix);
  holdDataDir(s.dataDir);
  assert.equal((await install(s, '1.2.0', prefix)).code, 1);
  assert.deepEqual(versionsIn(prefix), ['1.0.0', '1.1.0', '1.2.0']);
  assert.match(s.err.join('\n'), new RegExp(`被进程 ${process.pid} 占着`));
  assert.match(s.out.join('\n'), /旧版本的目录这次没有清理/);
});

// ---- The data directory is never under something that is deleted ----

test('数据目录在旧版本目录里：升级不清那个目录，账本还在，并报告', async (t) => {
  const s = stage(t);
  const prefix = join(s.dir, 'prefix');
  const dataDir = join(prefix, 'versions', '1.0.0', 'data');
  s.cli.system.env.TYCHO_DATA = dataDir;
  await install(s, '1.0.0', prefix);
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'ledger.db'), '账本');
  await install(s, '1.1.0', prefix);
  assert.equal((await install(s, '1.2.0', prefix)).code, 1);
  assert.equal(readFileSync(join(dataDir, 'ledger.db'), 'utf8'), '账本');
  assert.ok(s.err.join('\n').includes(`数据目录 ${dataDir} 在它里面`), s.text());

  // Reinstalling 1.0.0 would set that very directory aside: refused before anything moves.
  s.err.length = 0;
  assert.equal((await install(s, '1.0.0', prefix)).code, 1);
  assert.match(s.err.join('\n'), /没有装上 1\.0\.0/);
  assert.equal(readFileSync(join(dataDir, 'ledger.db'), 'utf8'), '账本');
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.2.0');
});

// ---- One installer at a time ----

test('另一个安装正在这个程序目录里进行：拒绝并说明，什么都不动', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const lock = join(prefix, 'install.lock');
  // Held by a live process: this one, as the lock itself would record it.
  const held = JSON.stringify({ pid: process.pid, process_start: processStart(process.pid) });
  writeFileSync(lock, held);

  assert.equal((await install(s, '1.1.0', prefix)).code, 1);
  assert.match(s.err.join('\n'), new RegExp(`另一个安装、升级或卸载（进程 ${process.pid}）正在这个程序目录里进行`));
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.equal(existsSync(join(prefix, 'versions', '1.1.0')), false);

  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.0.0').cli), 1);
  assert.ok(existsSync(join(prefix, 'bin', 'tycho')));
  assert.equal(readFileSync(lock, 'utf8'), held, '别人的锁不能动');
});

test('锁的持有者已经不在：接管，做完放开', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const lock = join(prefix, 'install.lock');
  writeFileSync(lock, JSON.stringify({ pid: await deadPid(), process_start: 'x' }));
  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.equal(existsSync(lock), false);

  // The same pid again after a crash is not the installer that took the lock.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, process_start: 'the installer that crashed' }));
  assert.equal((await install(s, '1.2.0', prefix)).code, 0, s.text());
  assert.equal(existsSync(lock), false);
});

// A machine that has joined a host and has a client running, as `tycho node service install`
// requires: the identity with a token, and the lock a resident client holds (this process
// stands in for it, so the install does not wait for a client to come up).
function joinedMachine(dataDir: string): void {
  const identity = identityOf(dataDir);
  writeToken(identity, 'f'.repeat(64));
  writeFileSync(join(identity.dir, CLIENT_LOCK), JSON.stringify({ pid: process.pid, process_start: processStart(process.pid) }));
}

// The two roles' autostart commands read the whole install record and write it back, as an
// upgrade does: without the prefix lock, whichever wrote last erased the other's slot, and a
// definition stood without the record of its data directory. What this catches: an autostart
// command that does not take the lock, or takes it for less than the whole of its work.
test('装自启的命令也拿安装锁：另一个安装在进行时拒绝，定义和记录一个字不动', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  joinedMachine(s.dataDir);
  const before = readFileSync(join(prefix, 'install.json'), 'utf8');
  const lock = join(prefix, 'install.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, process_start: processStart(process.pid) }));

  for (const command of [['service', 'install'], ['service', 'uninstall'], ['node', 'service', 'install'], ['node', 'service', 'uninstall']]) {
    s.err.length = 0;
    s.calls.length = 0;
    assert.equal(await runCli(command, as(s, prefix, '1.0.0').cli), 1, command.join(' '));
    assert.match(s.err.join('\n'), new RegExp(`另一个安装、升级或卸载（进程 ${process.pid}）正在这个程序目录里进行`), command.join(' '));
    assert.deepEqual(s.calls.filter(({ file }) => file === 'systemctl'), [], `${command.join(' ')}：没有碰定义`);
  }
  assert.equal(readFileSync(join(prefix, 'install.json'), 'utf8'), before, '记录没有动');
  assert.equal(existsSync(lock), true, '别人的锁还在');

  // Only asking takes no lock.
  s.err.length = 0;
  assert.equal(await runCli(['service', 'status'], s.cli), 0, s.text());
  assert.equal(await runCli(['node', 'service', 'status'], s.cli), 0, s.text());
});

test('两个角色的自启交错安装：后一个在前一个做完之前被拒，做完后再装，记录里两格都在', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 30_000;
  const { prefix } = await install(s, '1.0.0');
  joinedMachine(s.dataDir);
  as(s, prefix, '1.0.0');

  // The host's install holds the lock while it waits for the service to come up: that is
  // the window in which the client's install used to read the record and write it back.
  const hostInstall = runCli(['service', 'install'], s.cli);
  await until('主机的自启请服务管理器启动服务', () => askedToStart(s));
  s.err.length = 0;
  assert.equal(await runCli(['node', 'service', 'install'], s.cli), 1, '前一个还没做完，后一个要等');
  assert.match(s.err.join('\n'), /另一个安装、升级或卸载（进程 \d+）正在这个程序目录里进行/);
  assert.equal(readRecord(prefix)!.autostart?.node, undefined, '被拒的那个什么都没写');

  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  assert.equal(await hostInstall, 0, s.text());
  assert.equal(existsSync(join(prefix, 'install.lock')), false, '做完放开');
  assert.equal(await runCli(['node', 'service', 'install'], s.cli), 0, s.text());
  assert.deepEqual(readRecord(prefix)!.autostart, { host: { dataDir: s.dataDir }, node: { dataDir: s.dataDir } }, '两格都在，谁也没把谁抹掉');
});

// ---- A rollback puts the record back too ----

// The failure this guards: the upgrade rewrote the record (its files, its slots) and saved it
// before the new version was verified; the rollback put the program and `current` back and
// left the record as the new version wrote it, so the old program read the new version's
// files and slots as its own — and then managed the wrong service. The old program reads the
// record it wrote, byte for byte.
test('回退时安装记录也放回升级前的那一份：旧程序照旧读到自启的数据目录和 PATH', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 30_000;
  const { prefix } = await install(s, '1.0.0');
  // The host's autostart on a data directory of its own, with the PATH of the terminal that
  // installed it.
  const dataDir = join(s.dir, 'autostart data');
  const legacy = `${JSON.stringify({ ...readRecord(prefix)!, autostart: { host: { dataDir, path: '/first/terminal' } } }, null, 2)}\n`;
  writeFileSync(join(prefix, 'install.json'), legacy);
  systemdInstalled(s, staleOwn(s, prefix));
  await startStub(t, dataDir, {}, installedStub(prefix, '1.0.0'));

  const upgrading = install(s, '1.1.0', prefix);
  await until('请服务管理器启动候选', () => startRequests(s) >= 1);
  // What the manager brings up is the old program again: the candidate reports the wrong
  // version and fails the check, and the release goes back.
  await startStub(t, dataDir, {}, installedStub(prefix, '1.0.0'));
  await until('候选停了、请服务管理器把旧版启动回来', () => startRequests(s) >= 2, 30_000);
  await startStub(t, dataDir, {}, installedStub(prefix, '1.0.0'));
  assert.equal((await upgrading).code, 1, s.text());
  assert.match(s.err.join('\n'), /已经退回 1\.0\.0/);
  assert.match(s.out.join('\n'), /安装记录也放回了升级前的那一份/);

  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.equal(readFileSync(join(prefix, 'install.json'), 'utf8'), legacy, '记录和升级前一个字节不差');
  assert.equal(existsSync(join(prefix, 'install.json.before-upgrade')), false, '副本用完就没了');
  assert.deepEqual(readRecord(prefix)!.autostart, { host: { dataDir, path: '/first/terminal' } }, '读回自启的数据目录和 PATH');
});

// The record goes back, and so must the definition: the task or unit in the system was written
// by the new version's own run of the upgrade, and the program now in use would be left
// managing a definition it did not write. What this catches: a rollback that puts `current` and
// the record back and leaves the machine saying what the version just taken back meant.
test('回退之后：自启定义按放回去的那份记录重写一遍', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const unit = systemdInstalled(s, staleOwn(s, prefix));
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  s.out.length = 0;

  const upgrading = install(s, '1.1.0', prefix);
  await until('请服务管理器启动候选', () => startRequests(s) >= 1);
  // Whatever is in the system when the rollback runs has to end up as the old version would
  // have written it; nothing else proves the write happened, since both versions write the
  // same launcher.
  const overwritten = `${staleOwn(s, prefix)}# 新版写完之后被换掉的定义\n`;
  writeFileSync(unit, overwritten);
  // The manager brings up the old program again: the candidate reports the wrong version and
  // fails the check, and the release goes back.
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  await until('候选停了、请服务管理器把旧版启动回来', () => startRequests(s) >= 2, 30_000);
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  assert.equal((await upgrading).code, 1, s.text());
  assert.match(s.out.join('\n'), /1\.0\.0 的开机自启定义也写回了它自己的那一份/);
  assert.equal(
    s.calls.filter(({ file, args }) => file === 'systemctl' && args.includes('enable')).length,
    2,
    '新版的定义写了一次，回退后旧版的又一次',
  );
  assert.notEqual(readFileSync(unit, 'utf8'), overwritten, '被换掉的那份要重写');
  assert.equal(readFileSync(unit, 'utf8'), systemdUnit(serviceSpec(s.cli.system, join(prefix, 'versions', '1.0.0'), s.dataDir)));
});

// The wait is the command's patience, not a verdict on the program: a candidate that holds the
// data directory and has not answered yet is still starting, and taking the version back would
// be taking back one that may work. The failure this guards: 2026-11-12's upgrade read such a
// candidate as failed and could not stop it afterwards.
test('新版比等待预算慢、可它一直活着：记成还在启动、不回退，release.json 如实', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 4000;
  const { prefix } = await install(s, '1.0.0');
  systemdInstalled(s, staleOwn(s, prefix));
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  const before = { out: s.out.length, err: s.err.length };

  const upgrading = install(s, '1.1.0', prefix);
  await until('请 systemd 启动新版', () => startRequests(s) >= 1);
  // A candidate that holds the data directory and does not answer who it is: what a service
  // slow to come up looks like from outside, for as long as the command waits.
  const candidate = await startStub(t, s.dataDir, { STUB_NO_IDENTITY: '1' }, installedStub(prefix, '1.1.0'));
  assert.equal((await upgrading).code, 1, s.text());
  assert.equal(alive(candidate), true, '还在启动的候选不能被停掉');
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.1.0');
  assert.equal(startRequests(s), 1, '没有回退，也就没有第二次启动');

  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual(
    { verified: result.verified, ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use },
    { verified: false, ok: false, rolled_back: false, in_use: '1.1.0' },
  );
  assert.deepEqual(result.pending, [`新版本还在启动（进程 ${candidate.pid}），还没有回答`]);
  const upgrade = [...s.out.slice(before.out), ...s.err.slice(before.err)].join('\n');
  assert.match(upgrade, /新版本还在启动，还没核对完/);
  assert.match(upgrade, new RegExp(`新版本还在启动（进程 ${candidate.pid}）`));
  assert.match(upgrade, /没有回退，也没有判它坏：用 tycho status 看它现在怎么样/);
  assert.doesNotMatch(upgrade, /已经退回|没有回退：|它还没起来|没有通过健康检查/);
});

// The other end of the same wait: a program that took the data directory's lock and is gone
// before it announced itself is known by the lock it left, is judged failed at once rather than
// waited out, and the version before it comes back.
test('候选在等待里退出：判它没起来，回退到上一版', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 30_000;
  const { prefix } = await install(s, '1.0.0');
  systemdInstalled(s, staleOwn(s, prefix));
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));

  const upgrading = install(s, '1.1.0', prefix);
  await until('请服务管理器启动候选', () => startRequests(s) >= 1);
  const dying = spawn(process.execPath, [installedStub(prefix, '1.1.0')], { env: { ...process.env, TYCHO_DATA: s.dataDir, STUB_DIE_AFTER_LOCK: '1' }, stdio: 'ignore' });
  t.after(() => void dying.kill());
  await until('候选停了、请服务管理器把旧版启动回来', () => startRequests(s) >= 2, 30_000);
  // The lock the dead candidate left behind is taken over, as the real program does.
  await startStub(t, s.dataDir, { STUB_TAKE_OVER: '1' }, installedStub(prefix, '1.0.0'));
  assert.equal((await upgrading).code, 1, s.text());
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.match(s.err.join('\n'), /已让服务用 1\.1\.0 启动，它起来过又退出了（进程 \d+）/);
  assert.doesNotMatch(s.err.join('\n'), /过了 30 秒它还没起来/, '死了就不该等到时限');
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual(
    { verified: result.verified, ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use },
    { verified: true, ok: false, rolled_back: true, in_use: '1.0.0' },
  );
});

// The old version gets the same reading as the new one did: one that is alive and has not
// answered yet is still starting, not a rollback that failed. What this guards: a slow old
// version being told it never came up after the version had already been switched back.
test('回退后旧版也慢：说它还在启动，不当成回退失败', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 4000;
  const { prefix } = await install(s, '1.0.0');
  systemdInstalled(s, staleOwn(s, prefix));
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));

  const upgrading = install(s, '1.1.0', prefix);
  await until('请服务管理器启动候选', () => startRequests(s) >= 1);
  // It reports the wrong version, so the release goes back...
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  await until('请服务管理器把旧版启动回来', () => startRequests(s) >= 2, 30_000);
  // ...and what the manager brings up for the old version holds the data directory without
  // answering who it is, for longer than the wait.
  const back = await startStub(t, s.dataDir, { STUB_NO_IDENTITY: '1' }, installedStub(prefix, '1.0.0'));
  assert.equal((await upgrading).code, 1, s.text());
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.equal(alive(back), true, '还在启动的旧版不能被停掉');
  assert.match(s.text(), new RegExp(`1\\.0\\.0 已经切回来，它还在启动（进程 ${back.pid}）、还没有回答`));
  assert.doesNotMatch(s.err.join('\n'), /已经切回来，但过了 \d+ 秒它还没起来|起来过又退出了/);
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual(
    { verified: result.verified, ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use },
    { verified: true, ok: false, rolled_back: true, in_use: '1.0.0' },
  );
  assert.match(result.lines.join('\n'), /已经退回 1\.0\.0（1\.0\.0 已经切回来，它还在启动/);
});

// A candidate that is confirmed stopped is what makes a rollback possible; one that is not is
// never reported as stopped, and the manager's answer is not that confirmation. What this
// guards: switching `current` back while the candidate still holds the ledger.
test('候选停不下来（服务管理器说停过了也不算）：不回退，如实说是谁没停下来', async (t) => {
  const s = stage(t);
  s.cli.timing.stopWaitMs = 300;
  const { prefix } = await install(s, '1.0.0');
  systemdInstalled(s, staleOwn(s, prefix));
  await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));

  const upgrading = install(s, '1.1.0', prefix);
  await until('请服务管理器启动候选', () => startRequests(s) >= 1);
  // It reports the wrong version, fails the check, answers the shutdown request — and then
  // stays for a minute, which is what the manager's own "stopped" does not settle.
  const candidate = await startStub(t, s.dataDir, { STUB_STOP_DELAY_MS: '60000' }, installedStub(prefix, '1.0.0'));
  await until('候选停不下来、命令说没有回退', () => s.err.some((line) => line.includes('没有回退')), 30_000);
  assert.equal((await upgrading).code, 1, s.text());
  assert.equal(alive(candidate), true);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.1.0', '没确认停就不切回');
  assert.match(s.err.join('\n'), new RegExp(`没有回退：候选服务（进程 ${candidate.pid}）没有停下来：它的服务管理器也停过它了，它还在`));
  assert.equal(startRequests(s), 1, '没有启动旧版');
  const result = readReleaseResult(s.dataDir)!;
  assert.deepEqual(
    { verified: result.verified, ok: result.ok, rolled_back: result.rolled_back, in_use: result.in_use },
    { verified: true, ok: false, rolled_back: false, in_use: '1.1.0' },
  );
});

// ---- Starting a candidate that is not answering yet ----

// The stop has to follow the candidate as it changes: one that starts answering while the stop
// waits was never asked over HTTP, and the manager alone is not enough to make it leave. What
// this guards: the candidate that was merely slow to come up keeping the ledger while the old
// program is started on it.
test('停候选：一开始持锁没回答、之后能回答的候选，会补发 HTTP 优雅停止', async (t) => {
  // What was asked of whom, in the order it happened: the manager has to be out of the way
  // before the candidate is confirmed gone, and the candidate that begins to answer gets the
  // graceful stop the manager alone never gives it.
  const order: string[] = [];
  const s = stage(t, {
    respond: (call) => {
      if (call.file === 'systemctl' && call.args.includes('stop')) order.push('manager');
      return undefined;
    },
  });
  const dataDir = s.dataDir;
  // A legacy definition owned by this candidate, so its manager can be stopped.
  const unit = join(s.home, '.config', 'systemd', 'user', 'tycho.service');
  mkdirSync(join(unit, '..'), { recursive: true });
  const candidateSpec = { program: ['/somewhere/tycho'], dataDir, logFile: join(s.dir, 'service.log') };
  writeFileSync(unit, systemdUnit(candidateSpec));
  // Held by a live process that has not answered: a candidate on its way up, seen by a release
  // that is already about to take the version back.
  holdDataDir(dataDir);
  const TOKEN = 'candidate-token';
  const asked: string[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    const port = (server.address() as { port: number }).port;
    if (request.url === '/api/instance') {
      // The first time it is asked who it is, nothing answers; a moment later it does.
      if (asked.includes('asked')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ pid: process.pid, port, version: '1.1.0', program_dir: '/somewhere', data_dir: dataDir, started_at: '2026-01-01T00:00:00Z' }));
      } else {
        asked.push('asked');
        response.writeHead(404).end();
      }
      return;
    }
    if (request.url === '/api/shutdown') {
      asked.push('shutdown');
      order.push('shutdown');
      // It answers and leaves: what the graceful stop is for.
      rmSync(join(dataDir, 'lock'), { force: true });
      rmSync(join(dataDir, 'service.json'), { force: true });
      response.writeHead(202, { 'content-type': 'application/json' }).end('{"stopping":true}');
      return;
    }
    response.writeHead(404).end();
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(dataDir, 'service.json'), JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port, token: TOKEN }));

  const stopping = stopCandidate(s.cli, candidateSpec, dataDir);
  assert.deepEqual(await stopping, { running: false, pid: null, why: '' });
  assert.deepEqual(asked, ['asked', 'shutdown'], '能回答了就要补发优雅停止');
  assert.deepEqual(order, ['manager', 'shutdown'], '先把服务管理器叫停，再让候选优雅停止');
});

test('升级成功：升级前那份记录的副本不留下；卸载也把残留的副本收走', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.equal(existsSync(join(prefix, 'install.json.before-upgrade')), false);
  writeFileSync(join(prefix, 'install.json.before-upgrade'), '{}');
  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.1.0').cli), 0, s.text());
  assert.equal(existsSync(prefix), false, '程序目录里没有别的东西，连目录一起拿掉');
});

test('清理时不碰另一个还活着的安装器的暂存区；已经不在的安装器留下的才收走', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const versions = join(prefix, 'versions');
  const live = `.staging-${process.pid}-another-run`;
  const dead = `.staging-${await deadPid()}-crashed`;
  for (const name of [live, dead]) {
    stubApp(join(versions, name), '5.0.0');
    writeFileSync(join(versions, `${name}.tar.gz`), '');
  }
  // Not an installer's by its name: left alone.
  mkdirSync(join(versions, '.staging-of-my-own'));
  assert.equal((await install(s, '1.1.0', prefix)).code, 0, s.text());
  assert.deepEqual(versionsIn(prefix), [live, `${live}.tar.gz`, '.staging-of-my-own', '1.0.0', '1.1.0']);
});

// ---- update ----

async function installed(t: TestContext, options: StageOptions = {}): Promise<{ s: Stage; prefix: string }> {
  const s = stage(t, options);
  const { prefix } = await install(s, '1.0.0');
  as(s, prefix, '1.0.0');
  s.calls.length = 0;
  s.out.length = 0;
  return { s, prefix };
}

const unpack = (s: Stage) => s.calls.find(({ file, args }) => /tar/.test(file) && args[0] === '-xzf');

for (const platform of ['linux', 'win32'] as const) {
  test(`update 不改命令路由：${platform} 的 opt-out 安装在普通升级后仍不写 PATH，明确重装可修复入口`, async (t) => {
    const routeFile = join(tempDir(t), 'user-path.json');
    const initialRoute = JSON.stringify(['owner-bin']);
    writeFileSync(routeFile, initialRoute);
    const s = stage(t, {
      platform, env: { TYCHO_NO_MODIFY_PATH: '1' },
      respond(call) {
        if (call.env.TYCHO_TASK) return { stdout: 'absent\n' };
        if (call.env.TYCHO_OP !== 'add') return undefined;
        const entries = JSON.parse(readFileSync(routeFile, 'utf8')) as string[];
        if (entries.includes(call.env.TYCHO_ENTRY!)) return { stdout: 'unchanged\n' };
        entries.push(call.env.TYCHO_ENTRY!);
        writeFileSync(routeFile, JSON.stringify(entries));
        return { stdout: 'changed\n' };
      },
    });
    writeFileSync(rc(s), 'export OWNER_VALUE=kept\n');
    const pathBefore = platform === 'win32' ? initialRoute : readFileSync(rc(s), 'utf8');
    const route = () => readFileSync(platform === 'win32' ? routeFile : rc(s), 'utf8');
    const { prefix, code } = await install(s, '1.0.0');
    assert.equal(code, 0, s.text());
    assert.equal(route(), pathBefore, '首次 opt-out 不写命令路由');
    delete s.cli.system.env.TYCHO_NO_MODIFY_PATH;
    as(s, prefix, '1.0.0');

    const release = stubApp(join(s.dir, 'candidate'), '2.0.0');
    const config = join(s.dir, 'candidate-system.json');
    writeFileSync(config, JSON.stringify({ system: s.cli.system, timing: s.cli.timing, routeFile }));
    // Execute the candidate's public CLI with an isolated system adapter, never registry/profile tools.
    writeFileSync(join(release, 'cli', 'main.ts'), [
      `import { runCli } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'cli', 'main.ts')).href)};`,
      `import { readFileSync, writeFileSync } from 'node:fs';`,
      `import { dirname } from 'node:path';`,
      `const config = JSON.parse(readFileSync(process.env.TEST_INSTALL_SYSTEM, 'utf8'));`,
      `const system = { ...config.system, env: process.env, exec(_file, _args, options = {}) {`,
      `  const env = options.env ?? {};`,
      `  if (env.TYCHO_TASK) return { code: 0, stdout: 'absent\\n', stderr: '' };`,
      `  if (env.TYCHO_OP === 'add') {`,
      `    const entries = JSON.parse(readFileSync(config.routeFile, 'utf8'));`,
      `    if (entries.includes(env.TYCHO_ENTRY)) return { code: 0, stdout: 'unchanged\\n', stderr: '' };`,
      `    entries.push(env.TYCHO_ENTRY); writeFileSync(config.routeFile, JSON.stringify(entries));`,
      `    return { code: 0, stdout: 'changed\\n', stderr: '' };`,
      `  }`,
      `  return { code: 0, stdout: '', stderr: '' };`,
      `}, launch() { return null; } };`,
      `const cli = { system, appRoot: dirname(import.meta.dirname), timing: config.timing, out: console.log, err: console.error };`,
      `process.exitCode = await runCli(process.argv.slice(2), cli);`,
      '',
    ].join('\n'));
    writeManifest(release);
    const parentExec = s.cli.system.exec;
    s.cli.system.exec = (file, args, options = {}) => {
      if (args[1] !== 'install-self') return parentExec(file, args, options);
      const child = spawnSync(file, args, {
        encoding: 'utf8', windowsHide: true,
        env: { ...s.cli.system.env, ...options.env, HOME: s.home, USERPROFILE: s.home, TEST_INSTALL_SYSTEM: config },
      });
      return { code: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.stderr || child.error?.message || '' };
    };
    assert.equal(await runCli(['update', '--from', release], s.cli), 0, s.text());
    assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '2.0.0', '确实装上候选版本');
    assert.equal(route(), pathBefore, '普通 update 不得替 opt-out 安装增加全局命令入口');
    assert.deepEqual(readRecord(prefix)!.paths, [], '没有新增 PATH 归属记录');

    s.cli.appRoot = release;
    assert.equal(await runCli(['install-self', '--prefix', prefix, '--node', NODE], s.cli), 0, s.text());
    if (platform === 'win32') assert.deepEqual(JSON.parse(route()), ['owner-bin', join(prefix, 'bin')]);
    else assert.equal(route(), pathBefore + bashLine(s, prefix) + '\n');
    assert.equal(readRecord(prefix)!.paths.length, 1, '明确重装仍可按安装器规则修复入口');
  });
}
test('update --from 目录：整份拷进暂存处，交给新版本自己安装', async (t) => {
  const seen: { entry: boolean; version: string }[] = [];
  const { s, prefix } = await installed(t, {
    respond(call) {
      if (call.args[1] !== 'install-self') return undefined;
      seen.push({
        entry: new RegExp(`[\\\\/]versions[\\\\/]\\.staging-${process.pid}-[^\\\\/]+[\\\\/]cli[\\\\/]main\\.ts$`).test(call.args[0]!),
        version: (JSON.parse(readFileSync(join(call.args[0]!, '..', '..', 'package.json'), 'utf8')) as { version: string }).version,
      });
      return { stdout: 'tycho 已从 1.0.0 升级到 2.0.0。\n' };
    },
  });
  const release = stubApp(join(s.dir, 'release'), '2.0.0');
  assert.equal(await runCli(['update', '--from', release], s.cli), 0, s.text());
  assert.deepEqual(seen, [{ entry: true, version: '2.0.0' }], '暂存处的名字里带着这个进程的进程号');
  const handed = s.calls.find(({ args }) => args[1] === 'install-self')!;
  assert.equal(handed.file, NODE);
  assert.deepEqual(handed.args.slice(1), ['install-self', '--prefix', prefix, '--node', NODE]);
  assert.match(s.out.join('\n'), /升级到 2\.0\.0/);
  assert.deepEqual(versionsIn(prefix), ['1.0.0'], '暂存处用完要清掉');
});

test('update --from 文件：先查包里有什么，再用 tar 解开；不是发布包就停下，current 不变，暂存处清掉', async (t) => {
  const { s, prefix } = await installed(t);
  const archive = join(s.dir, 'not-a-release.tar.gz');
  writeFileSync(archive, 'x');
  assert.equal(await runCli(['update', '--from', archive], s.cli), 1);
  // Names relative to the versions directory, never the caller's path: Windows' tar
  // reads its arguments in the system code page.
  assert.match(unpack(s)!.args.join(' '), /^-xzf \.staging-\d+-\w+\.tar\.gz -C \.staging-\d+-\w+$/);
  assert.equal(unpack(s)!.cwd, join(prefix, 'versions'));
  const listed = s.calls.findIndex(({ file, args }) => /tar/.test(file) && args[0] === '-tzf');
  assert.ok(listed !== -1 && listed < s.calls.indexOf(unpack(s)!), '解包之前先看成员');
  assert.match(s.text(), /不是 tycho 的发布包/);
  assert.match(s.text(), /仍在用 1\.0\.0/);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.deepEqual(versionsIn(prefix), ['1.0.0']);
  assert.equal(s.calls.some(({ args }) => args[1] === 'install-self'), false);

  assert.equal(await runCli(['update', '--from', join(s.dir, 'missing.tar.gz')], s.cli), 1);
  assert.match(s.text(), /找不到/);
});

test('update --from 文件：包里有会落到解包目录之外的成员时，什么都不解', async (t) => {
  const { s, prefix } = await installed(t, { respond: (call) => (call.args[0] === '-tzf' ? { stdout: 'package.json\n../../outside\n' } : undefined) });
  const archive = join(s.dir, 'hostile.tar.gz');
  writeFileSync(archive, 'x');
  assert.equal(await runCli(['update', '--from', archive], s.cli), 1);
  assert.equal(unpack(s), undefined);
  assert.match(s.err.join('\n'), /会落到解包目录之外的成员：\.\.\/\.\.\/outside/);
  assert.match(s.err.join('\n'), /仍在用 1\.0\.0/);
  assert.deepEqual(versionsIn(prefix), ['1.0.0']);
});

test('update 自定义 TYCHO_RELEASE_URL 保留原 curl 路径，不调用 GitHub CLI', async (t) => {
  const { s, prefix } = await installed(t, { env: { TYCHO_RELEASE_URL: 'http://127.0.0.1:1/t.tar.gz' }, respond: (call) => (/curl/.test(call.file) ? { code: 7 } : undefined) });
  assert.equal(await runCli(['update'], s.cli), 1);
  assert.equal(s.calls.find(({ file }) => /curl/.test(file))!.args.at(-1), 'http://127.0.0.1:1/t.tar.gz');
  assert.equal(s.calls.some(({ file }) => file === 'gh'), false);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
});

test('update：新版本自己装的结果由它自己说，升级命令照转，不替它下结论', async (t) => {
  // After the switch a failure leaves the new version in use: "still on the old one"
  // from the command that only launched the installer would be a guess.
  const after = '已经切到 2.0.0，但下面的事没有做成：\n  已让服务用这个版本重新启动，但过了 30 秒还没起来。\n';
  const { s } = await installed(t, { respond: (call) => (call.args[1] === 'install-self' ? { code: 1, stderr: after } : undefined) });
  assert.equal(await runCli(['update', '--from', stubApp(join(s.dir, 'release'), '2.0.0')], s.cli), 1);
  assert.match(s.err.join('\n'), /已经切到 2\.0\.0/);
  assert.match(s.err.join('\n'), /还没起来/);
  assert.doesNotMatch(s.err.join('\n'), /仍在用/);
});

test('update：确认过的摘要、版本和控制台那条标记都传给新版本自己', async (t) => {
  const handed: string[][] = [];
  const { s } = await installed(t, {
    respond(call) {
      if (call.args[1] !== 'install-self') return undefined;
      handed.push(call.args);
      return { stdout: 'tycho 已从 1.0.0 升级到 2.0.0。\n' };
    },
  });
  const release = stubApp(join(s.dir, 'release'), '2.0.0');
  assert.equal(await runCli(['update', '--from', release, '--expect-version', '2.0.0', '--expect-sha256', 'a'.repeat(64), '--automatic'], s.cli), 0, s.text());
  assert.deepEqual(handed, [[
    s.calls.find(({ args }) => args[1] === 'install-self')!.args[0]!,
    'install-self', '--prefix', join(s.dir, 'prefix'), '--node', NODE,
    '--expect-version', '2.0.0', '--automatic',
  ]]);
});

test('update：包的内容和确认时的不一样，什么都没有解开', async (t) => {
  const { s, prefix } = await installed(t);
  const archive = join(s.dir, 'release.tar.gz');
  writeFileSync(archive, 'the bytes the owner confirmed');
  const good = createHash('sha256').update('the bytes the owner confirmed').digest('hex');
  // The same file, replaced after the click.
  writeFileSync(archive, 'something else');
  assert.equal(await runCli(['update', '--from', archive, '--expect-sha256', good], s.cli), 1);
  assert.match(s.err.join('\n'), /这个包的内容和确认时的不一样/);
  assert.equal(s.calls.some(({ args }) => args[0] === '-tzf' || args[0] === '-xzf'), false, '没有解开任何东西');
  assert.equal(s.calls.some(({ args }) => args[1] === 'install-self'), false);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.deepEqual(versionsIn(prefix), ['1.0.0']);
});

test('update 和 uninstall：源码目录里没有可升级、可卸的安装', async (t) => {
  for (const command of ['update', 'uninstall']) {
    const s = stage(t);
    assert.equal(await runCli([command], s.cli), 1);
    assert.match(s.text(), /源码目录/);
    assert.deepEqual(s.calls, []);
  }
});

// ---- uninstall ----

test('uninstall：卸掉自启、PATH 里的那一行和装下的程序；数据和别人的东西不动', async (t) => {
  const s = stage(t);
  writeFileSync(rc(s), 'export FOO=1\n');
  const { prefix } = await install(s, '1.0.0');
  mkdirSync(join(prefix, 'node'));
  writeFileSync(join(prefix, 'notes.txt'), '主人自己放的');
  writeFileSync(join(prefix, 'bin', 'my-tool'), '主人自己放的');
  mkdirSync(s.dataDir);
  writeFileSync(join(s.dataDir, 'ledger.db'), '账本');
  const unit = systemdInstalled(s, staleOwn(s, prefix));

  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.0.0').cli), 0, s.text());
  assert.deepEqual(readdirSync(prefix).sort(), ['bin', 'notes.txt']);
  assert.deepEqual(readdirSync(join(prefix, 'bin')), ['my-tool']);
  assert.equal(readFileSync(rc(s), 'utf8'), 'export FOO=1\n');
  assert.equal(existsSync(unit), false);
  assert.equal(readFileSync(join(s.dataDir, 'ledger.db'), 'utf8'), '账本');
  assert.ok(s.text().includes(`你的数据没有动，还在 ${s.dataDir}`), '要告诉主人数据在哪');
});

// One program, two roles: an uninstall takes out both definitions — a client's autostart
// left behind would start a program that is no longer there at every login — and neither
// role's data directory is touched (docs/design/nodes.md §1.4, §7, §11 step 3). What this
// catches: an uninstall that stops after the host's definition, one that deletes the
// rounds' evidence or the machine's identity along with the program, and one that says
// "your data was not touched" after doing it.
test('uninstall：两个角色的自启都卸掉，任务的证据和机器的身份一个字不动', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const appRoot = join(prefix, 'versions', '1.0.0');
  const hostUnit = systemdInstalled(s, systemdUnit(serviceSpec(s.cli.system, appRoot, s.dataDir, undefined, 'host')));
  const nodeUnit = nodeUnitInstalled(s, systemdUnit(serviceSpec(s.cli.system, appRoot, s.dataDir, undefined, 'node')));
  writeRecord(prefix, { ...readRecord(prefix)!, autostart: { host: { dataDir: s.dataDir }, node: { dataDir: s.dataDir } } });

  // What the data directory holds: a finished round's own material, and the identity the
  // client keeps under nodes/. Neither is the installer's to remove.
  const evidence = join(s.dataDir, 'tasks', 't1', 'runs', 'r1', 'exit');
  mkdirSync(join(evidence, '..'), { recursive: true });
  writeFileSync(evidence, '0\n');
  const token = join(s.dataDir, 'nodes', 'this-pc', 'a1b2c3d4e5f60718a1b2c3d4e5f60718', 'token');
  mkdirSync(join(token, '..'), { recursive: true });
  writeFileSync(token, `${'f'.repeat(64)}\n`);

  s.out.length = 0;
  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.0.0').cli), 0, s.text());
  assert.equal(existsSync(hostUnit), false, '主机那一份自启卸了');
  assert.equal(existsSync(nodeUnit), false, '机器客户端那一份自启也卸了');
  assert.equal(existsSync(join(prefix, 'versions')), false, '程序文件卸了');
  assert.equal(existsSync(join(prefix, 'bin', 'tycho')), false);
  assert.equal(readFileSync(evidence, 'utf8'), '0\n', '这一轮的证据还在，内容没变');
  assert.equal(readFileSync(token, 'utf8'), `${'f'.repeat(64)}\n`, '机器的身份还在，内容没变');
  assert.ok(s.out.join('\n').includes(`你的数据没有动，还在 ${s.dataDir}`), '要告诉主人数据在哪');
});

test('uninstall：主人原来就有的 PATH 那一行不是安装器加的，卸载不删它', async (t) => {
  const s = stage(t);
  const prefix = join(s.dir, 'prefix');
  const mine = `${bashLine(s, prefix)}\nexport FOO=1\n`;
  writeFileSync(rc(s), mine);
  await install(s, '1.0.0', prefix);
  assert.deepEqual(readRecord(prefix)!.paths, [], '没加过就不记');
  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.0.0').cli), 0, s.text());
  assert.equal(readFileSync(rc(s), 'utf8'), mine);
});

test('uninstall：没有安装记录就分不清哪些是安装器放的，什么都不删', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const before = readFileSync(rc(s), 'utf8');
  rmSync(join(prefix, 'install.json'));
  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.0.0').cli), 1);
  assert.match(s.err.join('\n'), /没有安装记录/);
  assert.deepEqual(readdirSync(prefix).sort(), ['bin', 'current', 'versions']);
  assert.equal(readFileSync(rc(s), 'utf8'), before, '没有记录就不动主人的环境');
  assert.doesNotMatch(s.text(), /你的数据没有动/);
});

test('uninstall：记录里的东西已经不是安装器放的那个了，不删并报告', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  // Something else now sits where the installer's version and launcher were.
  writeFileSync(join(prefix, 'versions', '1.0.0', 'package.json'), JSON.stringify({ name: 'something-else', version: '1.0.0' }));
  writeFileSync(join(prefix, 'bin', 'tycho'), '#!/bin/sh\necho mine\n');
  // The command still has to run: its own entry is elsewhere in this test.
  s.cli.appRoot = stubApp(join(prefix, 'versions', '2.0.0'), '2.0.0');
  assert.equal(await runCli(['uninstall'], s.cli), 1, s.text());
  assert.ok(existsSync(join(prefix, 'versions', '1.0.0', 'package.json')));
  assert.equal(readFileSync(join(prefix, 'bin', 'tycho'), 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(existsSync(join(prefix, 'current')), false, '确实是安装器放的照删');
  assert.equal(s.err.filter((line) => line.includes('已经不是安装器放的那个了')).length, 2);
});

test('uninstall：程序目录里没有别的东西时，连目录一起拿掉；数据目录在程序目录里也不动', async (t) => {
  const empty = stage(t);
  const first = await install(empty, '1.0.0');
  assert.equal(await runCli(['uninstall'], as(empty, first.prefix, '1.0.0').cli), 0);
  assert.equal(existsSync(first.prefix), false);

  // Beside what the installer put there, and under a directory the old uninstall deleted whole.
  for (const where of ['data', join('bin', 'data'), join('node', 'data')]) {
    const inside = stage(t);
    const prefix = join(inside.dir, 'prefix');
    const dataDir = join(prefix, where);
    inside.cli.system.env.TYCHO_DATA = dataDir;
    await install(inside, '1.0.0', prefix);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'ledger.db'), '账本');
    assert.equal(await runCli(['uninstall'], as(inside, prefix, '1.0.0').cli), 0, inside.text());
    assert.equal(readFileSync(join(dataDir, 'ledger.db'), 'utf8'), '账本', where);
    assert.equal(existsSync(join(prefix, 'versions')), false, where);
  }
});

test('uninstall：数据目录在要删的版本目录里时拒绝，什么都不删，也不说数据没动', async (t) => {
  const s = stage(t);
  const prefix = join(s.dir, 'prefix');
  const dataDir = join(prefix, 'versions', '1.0.0', 'data');
  s.cli.system.env.TYCHO_DATA = dataDir;
  await install(s, '1.0.0', prefix);
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'ledger.db'), '账本');
  const before = readFileSync(rc(s), 'utf8');
  s.out.length = 0;
  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.0.0').cli), 1);
  assert.ok(s.err.join('\n').includes(`数据目录 ${dataDir} 在要删的 ${join(prefix, 'versions', '1.0.0')} 里面，所以什么都没有删`), s.text());
  assert.equal(readFileSync(join(dataDir, 'ledger.db'), 'utf8'), '账本');
  assert.deepEqual(readdirSync(prefix).sort(), ['bin', 'current', 'install.json', 'versions']);
  assert.equal(readFileSync(rc(s), 'utf8'), before);
  assert.doesNotMatch(s.text(), /你的数据没有动/);
});

test('uninstall：这一份的服务在跑就先优雅停止；数据目录被占时什么都不卸', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  const trace = join(s.dir, 'trace');
  const running = await startStub(t, s.dataDir, { STUB_TRACE: trace }, installedStub(prefix, '1.0.0'));
  assert.equal(await runCli(['uninstall'], as(s, prefix, '1.0.0').cli), 0, s.text());
  assert.equal(await exited(running), 0);
  assert.equal(readFileSync(trace, 'utf8'), 'shutdown\n');
  assert.ok(existsSync(s.dataDir));

  const held = stage(t);
  const other = await install(held, '1.0.0');
  holdDataDir(held.dataDir);
  assert.equal(await runCli(['uninstall'], as(held, other.prefix, '1.0.0').cli), 1);
  assert.ok(existsSync(join(other.prefix, 'current')));
  assert.ok(existsSync(rc(held)));
});

test('uninstall：开机自启装在另一个数据目录上时，停的是那个目录上这一份的服务', async (t) => {
  const s = stage(t);
  s.cli.timing.startWaitMs = 50;
  const { prefix } = await install(s, '1.0.0');
  await runCli(['service', 'install'], as(s, prefix, '1.0.0').cli);
  const running = await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
  // A terminal without that TYCHO_DATA.
  s.cli.system.env.TYCHO_DATA = join(s.dir, 'another terminal');
  assert.equal(await runCli(['uninstall'], s.cli), 0, s.text());
  assert.equal(await exited(running), 0, '卸掉了程序，它的服务不能留着跑');
});

// ---- Windows: what is still in use is deleted after the command ends ----

// A private Node inside the prefix, running: Windows will not delete it. `release` ends
// it, which has to happen before the stage's own cleanup can remove the directory.
async function busyNode(t: TestContext, options: StageOptions = {}): Promise<{ s: Stage; prefix: string; node: string; release(): Promise<void> }> {
  const s = stage(t, {
    platform: 'win32',
    respond: (call) => (call.env.TYCHO_TASK ? { stdout: 'absent\r\n' } : call.env.TYCHO_OP ? { stdout: 'changed\r\n' } : undefined),
    ...options,
  });
  const prefix = join(s.dir, "pre %TEMP% it's fix");
  const node = join(prefix, 'node', 'node.exe');
  mkdirSync(join(prefix, 'node'), { recursive: true });
  copyFileSync(process.execPath, node);
  const child = spawn(node, ['-e', 'console.log(1); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const release = async (): Promise<void> => {
    child.kill();
    await exited(child);
  };
  await once(child.stdout, 'data');
  assert.equal((await install(s, '1.0.0', prefix, node)).code, 0, s.text());
  assert.ok(readRecord(prefix)!.files.includes('node/node.exe'), '安装脚本带来的 Node 也记在安装器名下');
  as(s, prefix, '1.0.0');
  s.out.length = 0;
  return { s, prefix, node, release };
}

test('Windows：还在用的文件交给后台助手，脚本作为编码后的数据传，不经过 cmd 的文本', { skip: ONLY_WINDOWS }, async (t) => {
  const { s, prefix, node, release } = await busyNode(t);
  try {
    assert.equal(await runCli(['uninstall'], s.cli), 0, s.text());
    assert.equal(s.launched.length, 1);
    const { file, args } = s.launched[0]!;
    assert.match(file, /powershell/i);
    assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
    // Nothing of the path is in the words cmd would read, "%TEMP%" least of all.
    assert.match(args[5]!, /^[A-Za-z0-9+/=]+$/);
    const script = Buffer.from(args[5]!, 'base64').toString('utf16le');
    assert.equal(script, deferredRemoval(prefix, [node, join(prefix, 'install.json'), join(prefix, 'install.lock')], process.pid));
    assert.ok(script.includes("pre %TEMP% it''s fix"), script);
    assert.match(s.out.join('\n'), /后台助手/);
    assert.ok(existsSync(node), '助手要等这条命令结束才动手');
    assert.ok(existsSync(join(prefix, 'install.json')), '记录和它们一起走：在那之前它还说得清什么是安装器的');
    assert.equal(existsSync(join(prefix, 'versions')), false);
  } finally {
    await release();
  }
});

test('Windows：后台助手没启动成，不承诺稍后删除，退出码 1', { skip: ONLY_WINDOWS }, async (t) => {
  const { s, node, release } = await busyNode(t, { refuseLaunch: () => 'cmd 的 start 退出码 1' });
  try {
    assert.equal(await runCli(['uninstall'], s.cli), 1);
    assert.doesNotMatch(s.text(), /后台助手/);
    assert.ok(s.err.join('\n').includes(`没删掉（cmd 的 start 退出码 1）。这条命令结束后请自己删：${node}`), s.text());
  } finally {
    await release();
  }
});

test('Windows：后台助手真跑：只删还在程序目录里的目标，路径里的 %NAME% 和引号原样', { skip: ONLY_WINDOWS }, async (t) => {
  const dir = tempDir(t);
  const prefix = join(dir, "pre %TEMP% it's fix");
  const outside = join(dir, 'outside');
  mkdirSync(join(prefix, 'node'), { recursive: true });
  mkdirSync(outside);
  for (const file of [join(prefix, 'node', 'node.exe'), join(prefix, 'install.json'), join(outside, 'keep.txt'), join(dir, 'beside.txt')]) writeFileSync(file, 'x');
  // What is in the prefix but leads out of it.
  symlinkSync(outside, join(prefix, 'link'), 'junction');
  const targets = [join(prefix, 'node', 'node.exe'), join(prefix, 'install.json'), join(prefix, 'link'), join(prefix, '..', 'beside.txt'), join(outside, 'keep.txt')];
  const ran = spawnSync(tool({ platform: 'win32', env: process.env }, 'powershell'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(deferredRemoval(prefix, targets, await deadPid())),
  ], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(readdirSync(prefix), ['link'], '目标删掉，空了的目录也拿走；指到外面的链接不碰');
  assert.ok(existsSync(join(outside, 'keep.txt')));
  assert.ok(existsSync(join(dir, 'beside.txt')), '写成 prefix\\..\\x 的路径不在程序目录里');

  // rmdir, not rm: Node 24.3 takes a junction for a directory and refuses.
  rmdirSync(join(prefix, 'link'));
  writeFileSync(join(prefix, 'last'), 'x');
  spawnSync(tool({ platform: 'win32', env: process.env }, 'powershell'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(deferredRemoval(prefix, [join(prefix, 'last')], await deadPid())),
  ]);
  assert.equal(existsSync(prefix), false, '全空了连程序目录一起拿走');
  assert.ok(existsSync(dir), '但不往上走');
});

test('显示的版本：装在 <程序目录>/versions/<版本> 下的照原样；别处跑的同一份是“开发版”', async (t) => {
  const s = stage(t);
  const { prefix } = await install(s, '1.0.0');
  s.out.length = 0;
  assert.equal(await runCli(['version'], as(s, prefix, '1.0.0').cli), 0);
  assert.deepEqual(s.out, ['tycho 1.0.0']);
  // The same files anywhere else: a checkout, or a release unpacked by hand.
  const loose = stage(t);
  assert.equal(await runCli(['version'], loose.cli), 0);
  assert.deepEqual(loose.out, ['tycho 1.0.0 开发版']);
});


for (const legacy of [false, true]) {
  test(`diagnostics: failed upgrade reports the ${legacy ? 'owned legacy' : 'fresh suffix'} journal`, async t => {
    const s = stage(t, { platform: 'linux' });
    s.cli.timing.startWaitMs = 10;
    const { prefix } = await install(s, '1.0.0');
    as(s, prefix, '1.0.0');
    const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir);
    if (legacy) systemdInstalled(s, systemdUnit(spec));
    else autostartFor(s.cli.system).install(spec, { start: false });
    await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
    assert.equal((await install(s, '1.1.0', prefix)).code, 1, s.text());
    assert.match(s.err.join('\n'), /服务的输出|输出用/);
    const name = legacy ? 'tycho' : `tycho-${ownerId(spec)}`;
    assert.ok(s.err.join('\n').includes(`journalctl --user -u ${name}`), s.text());
  });
}
