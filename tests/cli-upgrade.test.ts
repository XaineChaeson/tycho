// Guards how the upgrade command is started, which is what keeps it alive while the
// service it is replacing goes away:
// - a program started as a child of that service dies with it, and on Linux systemd
//   collects everything left in the unit's cgroup when the unit stops. So the command goes
//   into a transient unit of its own, and a machine without a user manager is told that
//   the detached process it gets instead may not survive a service systemd manages;
// - on Windows the service's own task instance ends as soon as the service exits cleanly,
//   and Task Scheduler takes what that instance started with it. The upgrade gets a task of
//   its own — one with no trigger at all, so nothing can start it but the run that follows;
//   it names the console host with `--headless`, as the service's own task does, so that
//   neither of them puts a terminal window on the owner's desktop;
// - the command carries what the owner confirmed: the version, the digest it was confirmed
//   by, and that this is the console's path, so the release can check both before it
//   installs anything;
// - an upgrade already at work in the program directory is recognised by the lock the
//   installer holds for the whole attempt, and a lock from another machine counts as held.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UPGRADE_TASK, upgradeArgs, upgradeRunning, upgradeStarter, upgradeTaskXml } from '../cli/upgrade.ts';
import { processStart } from '../service/lock.ts';
import type { Stage } from './cli-helpers.ts';
import { stage, tempDir } from './cli-helpers.ts';

const PLAN = {
  launcher: '/home/owner/.tycho/app/bin/tycho',
  packageFile: '/home/owner/.tycho/host/releases/run-1/tycho-1.2.0.tar.gz',
  version: '1.2.0',
  sha256: 'a'.repeat(64),
  dataDir: '/home/owner/.tycho/host',
};

const said = (s: Stage): string => s.out.join('\n');

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CONHOST = 'C:\\Windows\\System32\\conhost.exe';

test('升级命令带着确认过的版本和摘要，并说明这是控制台的一条', () => {
  assert.deepEqual(upgradeArgs(PLAN), [
    'update', '--from', PLAN.packageFile,
    '--expect-version', '1.2.0',
    '--expect-sha256', 'a'.repeat(64),
    '--automatic',
  ]);
});

test('Linux：升级命令进自己的临时单元，脱离服务的 cgroup', async (t) => {
  const s = stage(t);
  const start = upgradeStarter(s.cli.system, (line) => s.out.push(line));
  assert.equal(start(PLAN), null);
  const ran = s.calls.find(({ file }) => file === 'systemd-run')!;
  assert.deepEqual(ran.args, [
    '--user', '--collect', `--unit=${UPGRADE_TASK}`, '--description=tycho: 上线新版本',
    PLAN.launcher, ...upgradeArgs(PLAN),
  ]);
  assert.equal(ran.env.TYCHO_DATA, PLAN.dataDir);
  assert.deepEqual(s.launched, [], 'systemd 起得来就不用自己 spawn');
  assert.match(said(s), /已用 systemd 的临时单元 tycho-upgrade 启动升级命令，它不在服务的 cgroup 里/);
});

test('Linux：systemd-run 用不了就退回独立会话，并说清这个服务由 systemd 管着时可能被一起停掉', async (t) => {
  const s = stage(t, { respond: (call) => (call.file === 'systemd-run' ? { code: 1, stderr: 'Failed to connect to bus' } : undefined) });
  const start = upgradeStarter(s.cli.system, (line) => s.out.push(line));
  assert.equal(start(PLAN), null);
  assert.deepEqual(s.launched.map(({ file, args }) => [file, args]), [[PLAN.launcher, upgradeArgs(PLAN)]]);
  assert.equal(s.launched[0]!.env.TYCHO_DATA, PLAN.dataDir);
  assert.match(said(s), /用 systemd-run 起升级命令没成功（Failed to connect to bus/);
  assert.match(said(s), /systemd 停它时可能把这个进程一起停掉/);
});

test('Linux：systemd-run 和独立会话都起不来时如实报告', async (t) => {
  const s = stage(t, { respond: (call) => (call.file === 'systemd-run' ? { code: 1 } : undefined), refuseLaunch: () => '找不到 /home/owner/.tycho/app/bin/tycho' });
  const start = upgradeStarter(s.cli.system, (line) => s.out.push(line));
  assert.equal(start(PLAN), '找不到 /home/owner/.tycho/app/bin/tycho');
});

test('Windows：升级命令用一个没有触发器的计划任务，建好就运行；建不起来就如实报告', async (t) => {
  const s = stage(t, { platform: 'win32' });
  const start = upgradeStarter(s.cli.system, (line) => s.out.push(line));
  assert.equal(start(PLAN), null);
  const created = s.calls.find(({ args }) => args.includes('/Create'))!;
  assert.deepEqual(created.args.slice(0, 5), ['/Create', '/TN', UPGRADE_TASK, '/XML', created.args[4]!]);
  assert.equal(created.args.at(-1), '/F');
  assert.equal(existsSync(created.args[4]!), false, '临时文件用完就收走');
  assert.deepEqual(s.calls.find(({ args }) => args.includes('/Run'))!.args, ['/Run', '/TN', UPGRADE_TASK]);
  assert.match(said(s), /已用独立的计划任务 tycho-upgrade 启动升级命令，它不在服务那个任务实例里/);

  const refused = stage(t, { platform: 'win32', respond: (call) => (call.args.includes('/Create') ? { code: 1, stderr: '拒绝访问' } : undefined) });
  assert.match(upgradeStarter(refused.cli.system, () => {})!(PLAN)!, /建升级用的计划任务没成功/);
  assert.equal(refused.calls.some(({ args }) => args.includes('/Run')), false, '没建成就不要去运行它');
});

test('计划任务的 XML：没有触发器、跑的是确认过的那个包、数据目录写在里面', () => {
  const xml = upgradeTaskXml({ plan: PLAN, user: 'PC\\owner', powershell: POWERSHELL, conhost: CONHOST });
  assert.match(xml, /<Triggers \/>/, '没有触发器：只有 /Run 能启动它');
  assert.match(xml, /<UserId>PC\\owner<\/UserId>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  // The words the task runs go as base64 of UTF-16, so no shell on the way reads them.
  const encoded = /<Arguments>.*-EncodedCommand ([A-Za-z0-9+/=]+)<\/Arguments>/.exec(xml)![1]!;
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(script.includes(`'${PLAN.launcher}' 'update' '--from' '${PLAN.packageFile}' '--expect-version' '1.2.0'`), script);
  assert.ok(script.includes(`$env:TYCHO_DATA='${PLAN.dataDir}'`), script);
});

// The program a task's action names, and the command line it hands it: the console host
// with `--headless` where there is one, PowerShell itself where there is not.
const action = (xml: string): { command: string; args: string } => ({
  command: /<Command>([\s\S]*?)<\/Command>/.exec(xml)![1]!,
  args: /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)![1]!,
});

test('升级任务也经 conhost --headless 起 PowerShell：升级时桌面上不留窗口', () => {
  const heads = action(upgradeTaskXml({ plan: PLAN, user: 'PC\\owner', powershell: POWERSHELL, conhost: CONHOST }));
  assert.equal(heads.command, CONHOST);
  assert.ok(heads.args.startsWith(`--headless ${POWERSHELL} -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand `), heads.args);
  // Still one PowerShell reading the plan, and still as data no shell on the way rewrites.
  assert.ok(Buffer.from(heads.args.slice(heads.args.lastIndexOf(' ') + 1), 'base64').toString('utf16le').includes(`'update' '--from' '${PLAN.packageFile}'`));

  const bare = action(upgradeTaskXml({ plan: PLAN, user: 'PC\\owner', powershell: POWERSHELL, conhost: null }));
  assert.equal(bare.command, POWERSHELL, '没有 conhost 的老系统照旧直接起 PowerShell');
  assert.doesNotMatch(bare.args, /--headless/);
});

test('macOS 和别处：独立会话就是脱离的办法', async (t) => {
  for (const platform of ['darwin', 'freebsd'] as const) {
    const s = stage(t, { platform });
    assert.equal(upgradeStarter(s.cli.system, (line) => s.out.push(line))(PLAN), null);
    assert.deepEqual(s.launched.map(({ file }) => file), [PLAN.launcher]);
    assert.match(said(s), /已用独立会话启动升级命令/);
  }
});

test('程序目录里有没有升级在进行：看安装器那把锁，另一台机器的锁算有人在用', async (t) => {
  const dir = tempDir(t);
  const prefix = join(dir, 'prefix');
  const lock = join(prefix, 'install.lock');
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  mkdirSync(prefix, { recursive: true });
  assert.equal(upgradeRunning(prefix), false, '没有锁就是没有');

  writeFileSync(lock, JSON.stringify({ pid: process.pid, process_start: processStart(process.pid) }));
  assert.equal(upgradeRunning(prefix), true, '这把锁是活着的安装器的');

  // Whether a pid is still the process that took the lock is a question for the operating
  // system; where it cannot answer, the pid decides and this says nothing.
  if (processStart(process.pid) !== undefined) {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, process_start: 'another process of the same pid' }));
    assert.equal(upgradeRunning(prefix), false, '进程号被别的进程用了');
  }

  writeFileSync(lock, JSON.stringify({ pid: 999_999_999, process_start: 'x' }));
  assert.equal(upgradeRunning(prefix), false);

  // Another machine's lock: this one can neither see that process nor wait it out, so it
  // is not treated as gone (the shared-home case).
  writeFileSync(lock, JSON.stringify({ pid: 999_999_999, machine: 'another-machine', hostname: hostname() }));
  assert.equal(upgradeRunning(prefix), true);
  rmSync(lock);
  assert.equal(upgradeRunning(prefix), false);
});
