// Guards against a self-check that reassures when it should not, or meddles when it should
// not: a broken install (launcher, `current` and version directories disagreeing, a
// launcher naming a Node that is gone) reported as fine, a data directory that cannot be
// written or is held by another process passed over, a port taken by something else, a
// stale autostart or a second copy elsewhere going unnoticed, a failing check not
// reflected in the exit code, and `--fix` touching anything the installer did not write.
// Also against "all is well" from a command that only looked at the installation: no
// Claude login, no account, or a ledger never made must show; what only a running service
// knows must be reported as not known when none runs, neither as fine nor as broken; and
// looking must not create or migrate a ledger. And against a Node that passes on its
// major version alone while the entry point needs a later release of it.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Check, Level } from '../cli/doctor.ts';
import { checkAutostart, checkDataDir, checkInstall, checkNode, checkOtherInstalls, checkPath, checkPort, doctor } from '../cli/doctor.ts';
import { ownerId } from '../cli/autostart.ts';
import { serviceSpec } from '../cli/install.ts';
import { launcherFiles, parseLauncher } from '../cli/launcher.ts';
import { runCli } from '../cli/main.ts';
import { requiredNode } from '../cli/paths.ts';
import { serviceChecks } from '../cli/service-checks.ts';
import { serviceState } from '../cli/service-client.ts';
import type { ClaudeInspection } from '../service/claude-cli.ts';
import { openLedger } from '../service/ledger.ts';
import { startService } from '../service/main.ts';
import { createTools } from '../service/tools.ts';
import { claudeTier, memoryLogins, noAccept, seed, testMachine } from './helpers.ts';
import type { Stage, StageOptions } from './cli-helpers.ts';
import { holdDataDir, REPO, stage, startStub, stubApp } from './cli-helpers.ts';

const NODE = process.execPath;

// A stage whose CLI runs from an installed copy, put there by the installer itself.
async function installed(t: TestContext, options: StageOptions = {}): Promise<{ s: Stage; prefix: string }> {
  const s = stage(t, options);
  const prefix = join(s.dir, 'prefix');
  s.cli.appRoot = stubApp(join(prefix, 'versions', '.staging'), '1.0.0');
  assert.equal(await runCli(['install-self', '--prefix', prefix, '--node', NODE], s.cli), 0, s.text());
  s.cli.appRoot = join(prefix, 'versions', '1.0.0');
  s.cli.system.env.PATH = join(prefix, 'bin');
  s.out.length = 0;
  s.calls.length = 0;
  return { s, prefix };
}

const levels = (checks: Check[]): Level[] => checks.map(({ level }) => level);

test('Node 版本：按发布包声明的最低版本比到修订号，不是只看主版本', (t) => {
  const s = stage(t);
  // The one place it is written, and no lower than what the entry point needs: a .ts
  // entry sees import.meta.main as false before 24.3.0.
  const required = requiredNode(REPO);
  assert.equal(required, '24.3.0');
  assert.equal(requiredNode(s.cli.appRoot), required, '假发布包带的是仓库声明的版本');
  for (const version of ['24.3.0', '24.19.0', '26.1.0']) assert.equal(checkNode({ ...s.cli.system, nodeVersion: version }, required).level, 'ok', version);
  for (const version of ['24.2.0', '24.0.0', '22.18.0']) {
    const old = checkNode({ ...s.cli.system, nodeVersion: version }, required);
    assert.equal(old.level, 'fail', version);
    assert.ok(old.detail.includes(version) && old.detail.includes(required));
    assert.ok(old.fix);
  }
});

test('安装：启动器、current、版本目录一致时正常；源码目录不算问题', async (t) => {
  const { s } = await installed(t);
  assert.deepEqual(levels(checkInstall(s.cli)), ['ok', 'ok']);
  const checkout = stage(t);
  const [only, ...rest] = checkInstall(checkout.cli);
  assert.equal(only!.level, 'ok');
  assert.match(only!.detail, /源码目录/);
  assert.deepEqual(rest, []);
});

test('安装：current 指向不存在的版本是问题，--fix 把它指回正在运行的这一份', async (t) => {
  const { s, prefix } = await installed(t);
  writeFileSync(join(prefix, 'current'), '9.9.9');
  const [version] = checkInstall(s.cli);
  assert.equal(version!.level, 'fail');
  assert.match(version!.detail, /9\.9\.9/);
  version!.repair!();
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.deepEqual(levels(checkInstall(s.cli)), ['ok', 'ok']);

  rmSync(join(prefix, 'current'));
  assert.equal(checkInstall(s.cli)[0]!.level, 'fail');
});

test('安装：直接运行了不是 current 的版本目录，提醒', async (t) => {
  const { s, prefix } = await installed(t);
  stubApp(join(prefix, 'versions', '0.9.0'), '0.9.0');
  s.cli.appRoot = join(prefix, 'versions', '0.9.0');
  const [version] = checkInstall(s.cli);
  assert.equal(version!.level, 'warn');
  assert.equal(version!.repair, undefined, '哪个版本在用是主人定的');
});

test('启动器：不在了、记的 Node 不在了都是问题；--fix 用现在这个 Node 重写', async (t) => {
  const { s, prefix } = await installed(t);
  const file = join(prefix, 'bin', 'tycho');

  rmSync(file);
  const missing = checkInstall(s.cli)[1]!;
  assert.equal(missing.level, 'fail');
  missing.repair!();
  assert.deepEqual(parseLauncher(readFileSync(file, 'utf8')), { node: NODE });

  const gone = join(s.dir, 'node-that-was-removed');
  writeFileSync(file, launcherFiles({ prefix, node: gone, platform: 'linux' }).tycho!);
  const stale = checkInstall(s.cli)[1]!;
  assert.equal(stale.level, 'fail');
  assert.ok(stale.detail.includes(gone));
  assert.match(stale.detail, /不在了/, '要说清是不在了，不是版本太低');
  stale.repair!();
  assert.deepEqual(parseLauncher(readFileSync(file, 'utf8')), { node: NODE });
  assert.equal(checkInstall(s.cli)[1]!.level, 'ok');
});

test('启动器：是别的版本写的（格式不同）时提醒，--fix 按原来那个 Node 重写', async (t) => {
  const { s, prefix } = await installed(t);
  const file = join(prefix, 'bin', 'tycho');
  writeFileSync(file, `${readFileSync(file, 'utf8')}# an older layout\n`);
  const old = checkInstall(s.cli)[1]!;
  assert.equal(old.level, 'warn');
  old.repair!();
  assert.equal(readFileSync(file, 'utf8'), launcherFiles({ prefix, node: NODE, platform: 'linux' }).tycho);
});

test('启动器：记的 Node 太旧是问题', async (t) => {
  let other = '';
  const { s, prefix } = await installed(t, { respond: (call) => (call.file === other ? { stdout: '20.11.0\n' } : undefined) });
  other = join(s.dir, 'another-node');
  writeFileSync(other, '');
  writeFileSync(join(prefix, 'bin', 'tycho'), launcherFiles({ prefix, node: other, platform: 'linux' }).tycho!);
  const launcher = checkInstall(s.cli)[1]!;
  assert.equal(launcher.level, 'fail');
  assert.ok(launcher.detail.includes(other));
});

test('数据目录：没有、可写、不是目录、被占、正在用，各有各的结论', async (t) => {
  const s = stage(t);
  assert.equal(checkDataDir(s.dataDir, await serviceState(s.dataDir)).level, 'ok');
  assert.match(checkDataDir(s.dataDir, await serviceState(s.dataDir)).detail, /第一次运行时创建/);

  mkdirSync(s.dataDir);
  assert.equal(checkDataDir(s.dataDir, await serviceState(s.dataDir)).level, 'ok');
  assert.deepEqual(readdirSync(s.dataDir), [], '探测用的文件不能留下');

  const file = join(s.dir, 'a-file');
  writeFileSync(file, '');
  assert.equal(checkDataDir(file, await serviceState(file)).level, 'fail');

  holdDataDir(s.dataDir);
  const held = checkDataDir(s.dataDir, await serviceState(s.dataDir));
  assert.equal(held.level, 'warn');
  assert.match(held.detail, new RegExp(`进程 ${process.pid}`));

  const running = stage(t);
  const child = await startStub(t, running.dataDir);
  const used = checkDataDir(running.dataDir, await serviceState(running.dataDir));
  assert.equal(used.level, 'ok');
  assert.match(used.detail, new RegExp(`进程 ${child.pid}`));
});

test('数据目录：写不进去是问题', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? '要一个只读目录：Windows 的只读属性不挡目录里的写入，root 不受权限限制' : false }, async (t) => {
  const s = stage(t);
  mkdirSync(s.dataDir, { mode: 0o500 });
  const check = checkDataDir(s.dataDir, await serviceState(s.dataDir));
  assert.equal(check.level, 'fail');
  assert.match(check.detail, /写不进去/);
});

const listen = (t: TestContext): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    t.after(() => server.close());
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

test('端口：服务在应答是正常；登记的端口连不上是问题；上次的端口被别人占了要提醒', async (t) => {
  const running = stage(t);
  await startStub(t, running.dataDir);
  assert.equal((await checkPort(await serviceState(running.dataDir))).level, 'ok');

  const dead = stage(t);
  holdDataDir(dead.dataDir);
  writeFileSync(join(dead.dataDir, 'service.json'), JSON.stringify({ pid: process.pid, port: 9, token: 'x' }));
  assert.equal((await checkPort(await serviceState(dead.dataDir))).level, 'fail');

  // Something listens on the registered port, but it is not this service: no "it answers".
  const squatted = stage(t);
  holdDataDir(squatted.dataDir);
  writeFileSync(join(squatted.dataDir, 'service.json'), JSON.stringify({ pid: process.pid, port: await listen(t), token: 'x' }));
  assert.equal((await checkPort(await serviceState(squatted.dataDir))).level, 'fail');

  const taken = await listen(t);
  const after = stage(t);
  mkdirSync(after.dataDir);
  writeFileSync(join(after.dataDir, 'service.json'), JSON.stringify({ pid: 0, port: taken, token: 'x' }));
  const occupied = await checkPort(await serviceState(after.dataDir));
  assert.equal(occupied.level, 'warn');
  assert.match(occupied.detail, new RegExp(String(taken)));

  writeFileSync(join(after.dataDir, 'service.json'), JSON.stringify({ pid: 0, port: 9, token: 'x' }));
  assert.equal((await checkPort(await serviceState(after.dataDir))).level, 'ok');
  assert.equal((await checkPort(await serviceState(stage(t).dataDir))).level, 'ok');
});

test('开机自启：没装不算问题；定义过期要提醒，--fix 只重写定义、不启动服务', (t) => {
  const s = stage(t, { respond: (call) => (call.file === 'loginctl' ? { stdout: 'Linger=yes\n' } : undefined) });
  const spec = serviceSpec(s.cli.system, s.cli.appRoot);
  assert.equal(checkAutostart(s.cli.system, spec).level, 'ok');
  assert.match(checkAutostart(s.cli.system, spec).detail, /没有安装/);

  const unit = join(s.home, '.config', 'systemd', 'user', 'tycho.service');
  mkdirSync(join(unit, '..'), { recursive: true });
  writeFileSync(unit, `# tycho-autostart owner:${ownerId(spec)}\nExecStart=/old/place/tycho run\n`);
  const stale = checkAutostart(s.cli.system, spec);
  assert.equal(stale.level, 'warn');
  stale.repair!();
  assert.match(readFileSync(unit, 'utf8'), /TYCHO_DATA=/);
  assert.equal(s.calls.some(({ args }) => args.includes('--now') || args.includes('start')), false);
  assert.equal(checkAutostart(s.cli.system, spec).level, 'ok');
});

test('开机自启：是另一份 tycho 装的要提醒，但 --fix 不碰它', async (t) => {
  const { s } = await installed(t, { respond: (call) => (call.file === 'loginctl' ? { stdout: 'Linger=yes\n' } : undefined) });
  const unit = join(s.home, '.config', 'systemd', 'user', 'tycho.service');
  const foreign = '# tycho-autostart owner:0123456789abcdef\nExecStart=/another/copy/bin/tycho run\n';
  mkdirSync(join(unit, '..'), { recursive: true });
  writeFileSync(unit, foreign);
  const check = checkAutostart(s.cli.system, serviceSpec(s.cli.system, s.cli.appRoot));
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /不是这一份/);
  assert.equal(check.repair, undefined);
  assert.equal(await runCli(['doctor', '--fix'], s.cli), 0);
  assert.equal(readFileSync(unit, 'utf8'), foreign);
  // Asking whether it is enabled is all that reaches systemd.
  assert.deepEqual(s.calls.filter(({ file, args }) => file === 'systemctl' && !args.includes('is-enabled')), []);
});

test('开机自启：没开 linger 要提醒，但不是 --fix 能代办的', (t) => {
  const s = stage(t, { respond: (call) => (call.file === 'loginctl' ? { stdout: 'Linger=no\n' } : undefined) });
  const spec = serviceSpec(s.cli.system, s.cli.appRoot);
  const unit = join(s.home, '.config', 'systemd', 'user', 'tycho.service');
  mkdirSync(join(unit, '..'), { recursive: true });
  writeFileSync(unit, `# tycho-autostart owner:${ownerId(spec)}\n`);
  checkAutostart(s.cli.system, spec).repair!();
  const check = checkAutostart(s.cli.system, spec);
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /enable-linger/);
  assert.equal(check.repair, undefined);
});

test('PATH：找得到自己正常；找不到、找到的是另一份都提醒', async (t) => {
  const { s, prefix } = await installed(t);
  assert.equal(checkPath(s.cli.system, prefix).level, 'ok');

  s.cli.system.env.PATH = '';
  assert.equal(checkPath(s.cli.system, prefix).level, 'warn');

  const elsewhere = join(s.dir, 'elsewhere', 'bin');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'tycho'), '');
  s.cli.system.env.PATH = [elsewhere, join(prefix, 'bin')].join(delimiter);
  const shadowed = checkPath(s.cli.system, prefix);
  assert.equal(shadowed.level, 'warn');
  assert.ok(shadowed.detail.includes(elsewhere));
});

test('多处安装：别的程序目录里也有一份要提醒；只有一份正常', async (t) => {
  const { s, prefix } = await installed(t);
  assert.equal(checkOtherInstalls(s.cli.system, prefix).level, 'ok');

  const other = join(s.home, '.tycho', 'app');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'current'), '0.5.0');
  const found = checkOtherInstalls(s.cli.system, prefix);
  assert.equal(found.level, 'warn');
  assert.ok(found.detail.includes(other));
  // From the other one's side, this one is the second copy.
  assert.equal(checkOtherInstalls({ ...s.cli.system, env: { TYCHO_PREFIX: prefix } }, other).level, 'warn');
});

test('tycho doctor：都正常退出 0；有一项问题退出 1，并说怎么办', async (t) => {
  const { s, prefix } = await installed(t);
  await startStub(t, s.dataDir);
  assert.equal(await runCli(['doctor'], s.cli), 0, s.text());
  assert.match(s.out.join('\n'), /都正常/);
  // The command's eight, and the one the running service answered.
  assert.equal(s.out.filter((line) => line.startsWith('[正常]')).length, 9);

  s.out.length = 0;
  rmSync(join(prefix, 'bin', 'tycho'));
  assert.equal(await runCli(['doctor'], s.cli), 1);
  assert.match(s.out.join('\n'), /\[有问题\] 启动器/);
  assert.match(s.out.join('\n'), /怎么办：/);
  assert.equal(existsSync(join(prefix, 'bin', 'tycho')), false, '不带 --fix 什么都不改');
});

test('tycho doctor --fix：只修安装器自己写的东西，别的原样', async (t) => {
  const { s, prefix } = await installed(t, { respond: (call) => (call.file === 'loginctl' ? { stdout: 'Linger=no\n' } : undefined) });
  const rc = readFileSync(join(s.home, '.bashrc'), 'utf8');
  const other = join(s.home, '.tycho', 'app');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'current'), '0.5.0');
  mkdirSync(s.dataDir);
  writeFileSync(join(s.dataDir, 'ledger.db'), '账本');
  const unit = join(s.home, '.config', 'systemd', 'user', 'tycho.service');
  mkdirSync(join(unit, '..'), { recursive: true });
  writeFileSync(unit, `# tycho-autostart owner:${ownerId(serviceSpec(s.cli.system, s.cli.appRoot))}\nstale\n`);
  rmSync(join(prefix, 'bin', 'tycho'));
  writeFileSync(join(prefix, 'current'), '9.9.9');

  assert.equal(await runCli(['doctor', '--fix'], s.cli), 0, s.text());
  assert.equal(s.out.filter((line) => line.startsWith('已修：')).length, 3);
  assert.ok(existsSync(join(prefix, 'bin', 'tycho')));
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.doesNotMatch(readFileSync(unit, 'utf8'), /stale/);
  // What it found but is not its to change: the other copy, linger, the shell file, the data.
  assert.match(s.out.join('\n'), /\[注意\] 多处安装/);
  assert.match(s.out.join('\n'), /\[注意\] 开机自启/);
  assert.equal(readFileSync(join(other, 'current'), 'utf8'), '0.5.0');
  assert.equal(readFileSync(join(s.home, '.bashrc'), 'utf8'), rc);
  assert.equal(readFileSync(join(s.dataDir, 'ledger.db'), 'utf8'), '账本');
  assert.equal(s.calls.some(({ args }) => args.includes('enable-linger') || args.includes('--now')), false);
});

test('tycho doctor --fix：没有可修的就说没有', async (t) => {
  const { s } = await installed(t);
  assert.equal(await runCli(['doctor', '--fix'], s.cli), 0);
  assert.match(s.out.join('\n'), /没有能自动修的/);
});

test('服务自己的检查接在同一份报告里，它的问题同样算进退出码', async (t) => {
  const { s } = await installed(t);
  const code = await doctor(s.cli, s.dataDir, { fix: false }, [
    (dataDir) => [{ title: 'Claude CLI', level: 'fail', detail: `在 ${dataDir} 的设置里没找到`, fix: '到控制台的设置里填上' }],
    () => {
      throw new Error('检查坏了');
    },
  ]);
  assert.equal(code, 1);
  assert.ok(s.out.join('\n').includes(`[有问题] Claude CLI：在 ${s.dataDir} 的设置里没找到`));
  assert.match(s.out.join('\n'), /检查坏了/);
});

test('Node 太旧时 doctor 仍能运行并说明，别的命令直接拒绝', async (t) => {
  // 24.2.0 is the one a check of the major version lets through.
  for (const nodeVersion of ['22.18.0', '24.2.0']) {
    const s = stage(t, { system: { nodeVersion } });
    assert.equal(await runCli(['doctor'], s.cli), 1);
    assert.match(s.out.join('\n'), /\[有问题\] Node 版本/);
    for (const command of ['run', 'status', 'stop', 'service', 'update', 'uninstall']) {
      const refused = stage(t, { system: { nodeVersion } });
      assert.equal(await runCli([command], refused.cli), 1, `${command} on ${nodeVersion}`);
      assert.match(refused.text(), /需要 Node 24\.3\.0 或更新的/);
      assert.equal(existsSync(refused.dataDir), false);
    }
  }
});

// ---- The service's own checks: asked of the service, or read from its ledger ----

const FAILING = JSON.stringify([
  { id: 'node', level: 'ok', title: 'Node 版本', text: 'the service says so too', fix: null },
  { id: 'data-dir', level: 'ok', title: '数据目录', text: 'the service says so too', fix: null },
  { id: 'claude-login', level: 'fail', title: '负责人的 Claude 登录', text: '没有登录。', fix: { label: '去设置', href: '#/settings/router.account' } },
  { id: 'router', level: 'ok', title: '负责人进程', text: '在运行', fix: null },
]);

test('服务在跑：自检问服务本人，它说有问题就是有问题，并指到控制台里去哪修', async (t) => {
  const { s } = await installed(t);
  await startStub(t, s.dataDir, { STUB_DOCTOR: FAILING });
  const { port } = JSON.parse(readFileSync(join(s.dataDir, 'service.json'), 'utf8')) as { port: number };
  assert.equal(await runCli(['doctor'], s.cli), 1, s.text());
  const out = s.out.join('\n');
  assert.match(out, /\[有问题\] 负责人的 Claude 登录：没有登录。/);
  assert.ok(out.includes(`http://127.0.0.1:${port}/#/settings/router.account`), out);
  assert.match(out, /\[正常\] 负责人进程：在运行/);
  assert.doesNotMatch(out, /都正常/);
  // What the command checked itself is not said twice.
  assert.doesNotMatch(out, /the service says so too/);
});

test('服务在跑：真实的服务用 service.json 里的令牌回答自检', { timeout: 60_000 }, async (t) => {
  const { s } = await installed(t);
  const previous = { ...process.env };
  const tools = createTools({ ledger: undefined as never, runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} }, logins: memoryLogins({}), machines: undefined as never, accept: noAccept });
  Object.assign(process.env, {
    FAKE_CLAUDE_LOG: join(s.dir, 'fake.log'),
    FAKE_CLAUDE_TOOLS: JSON.stringify(tools.names.map((name) => `mcp__tycho__${name}`)),
  });
  const service = await startService({ dataDir: s.dataDir, port: 0, claude: [process.execPath, join(REPO, 'tests', 'fake-claude.mjs')], stopWaitMs: 2000 });
  try {
    assert.equal(await runCli(['doctor'], s.cli), 1, s.text());
    const out = s.out.join('\n');
    // Facts only the running service has, and what it knows is missing.
    assert.match(out, /\] 负责人进程：/);
    assert.match(out, /\[有问题\] 账号：还没有能用的登录/);
    assert.ok(out.includes(`端口 ${service.port} 上的服务回答了它是谁`), out);
    assert.doesNotMatch(out, /不知道/);
  } finally {
    // Here, not in an after hook: the stage's own hook removes the directory first.
    await service.stop();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  }
});

const signedOut: ClaudeInspection = { path: '/opt/claude', command: ['/opt/claude'], problem: null, login: { loggedIn: false, detail: '' } };
const signedIn: ClaudeInspection = { path: '/opt/claude', command: ['/opt/claude'], problem: null, login: { loggedIn: true, detail: 'owner@example.com' } };
const LOGIN = { id: 'lab', name: 'lab', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };

test('服务没在跑、账本在：只读账本，查得出的照查，只有运行时才知道的显示为不知道', async (t) => {
  const s = stage(t);
  mkdirSync(s.dataDir);
  seed(s.dataDir, { machines: { 'gpu-1': testMachine('gpu-1') }, logins: { lab: LOGIN } });
  const before = readFileSync(join(s.dataDir, 'ledger.db'));
  const asked: string[] = [];
  const checks = await serviceChecks(s.dataDir, await serviceState(s.dataDir), async (cli) => {
    asked.push(cli);
    return signedOut;
  });
  assert.deepEqual(asked, [''], '问的是设置里那个 Claude Code');
  const by = Object.fromEntries(checks.map((check) => [check.title, check]));
  assert.equal(by['负责人的 Claude 登录']!.level, 'fail');
  assert.match(by['负责人的 Claude 登录']!.fix!, /启动服务后在控制台里处理/);
  assert.equal(by['登录']!.level, 'ok');
  for (const title of ['负责人进程', '账号 lab 的机器']) {
    assert.deepEqual([by[title]!.level, by[title]!.detail], ['unknown', '服务没在跑，不知道。'], title);
  }
  assert.equal(by['Node 版本'], undefined, '命令自己查过的不重复');
  assert.deepEqual(readFileSync(join(s.dataDir, 'ledger.db')), before, '自检不改账本');
});

test('服务没在跑、账本在：tycho doctor 不说都正常，不知道的不算进退出码', async (t) => {
  const { s } = await installed(t);
  mkdirSync(s.dataDir);
  seed(s.dataDir, { machines: { 'gpu-1': testMachine('gpu-1') }, logins: { lab: LOGIN }, settings: { 'backup.dir': s.dir } });
  const sources = [(dataDir: string, service: Awaited<ReturnType<typeof serviceState>>) => serviceChecks(dataDir, service, async () => signedIn)];
  assert.equal(await doctor(s.cli, s.dataDir, { fix: false }, sources), 0, s.text());
  const out = s.out.join('\n');
  assert.match(out, /\[不知道\] 负责人进程：服务没在跑，不知道。/);
  assert.match(out, /\[正常\] 负责人的 Claude 登录：已登录（owner@example\.com）/);
  assert.doesNotMatch(out, /都正常。/);
  assert.match(out, /2 项要服务在跑才知道/);
});

test('从没启动过：说还没有初始化，不创建任何东西，也不说都正常', async (t) => {
  const { s } = await installed(t);
  assert.equal(await runCli(['doctor'], s.cli), 0, s.text());
  const out = s.out.join('\n');
  assert.match(out, /\[注意\] 服务的配置：还没有初始化/);
  assert.match(out, /怎么办：运行 tycho run/);
  assert.doesNotMatch(out, /都正常/);
  assert.equal(existsSync(s.dataDir), false, '查一下不会把数据目录建出来');

  // A data directory that is there but holds no ledger is the same case, and stays empty.
  mkdirSync(s.dataDir);
  s.out.length = 0;
  assert.equal(await runCli(['doctor'], s.cli), 0);
  assert.match(s.out.join('\n'), /还没有初始化/);
  assert.deepEqual(readdirSync(s.dataDir), []);
});

test('账本比程序旧或新：如实说明，不升级它', async (t) => {
  for (const [version, said] of [['4', /比程序的 \d+ 旧/], ['999', /账本比程序新/]] as const) {
    const s = stage(t);
    mkdirSync(s.dataDir);
    const file = join(s.dataDir, 'ledger.db');
    openLedger(file).close();
    const conn = new DatabaseSync(file);
    conn.prepare("UPDATE setting SET value_json = ? WHERE key = 'schema_version'").run(version);
    conn.close();
    const before = readFileSync(file);
    const checks = await serviceChecks(s.dataDir, await serviceState(s.dataDir), async () => signedIn);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.level, 'warn');
    assert.match(checks[0]!.detail, said);
    assert.ok(checks[0]!.fix);
    assert.deepEqual(readFileSync(file), before, '只读打开不迁移');
  }
});

test('数据目录被占着（服务在启动或在恢复备份）：不读账本，显示为不知道', async (t) => {
  const s = stage(t);
  mkdirSync(s.dataDir);
  seed(s.dataDir, {});
  holdDataDir(s.dataDir);
  const checks = await serviceChecks(s.dataDir, await serviceState(s.dataDir), async () => {
    throw new Error('这时不该去问 Claude Code');
  });
  assert.deepEqual(checks.map(({ level }) => level), ['unknown']);
  assert.match(checks[0]!.detail, new RegExp(`进程 ${process.pid}`));
});
