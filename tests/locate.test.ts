// Guards where an executor's command is found (node/locate.ts): the one lookup a machine's
// probe, its watch process, the Router and the self-check share (nodes.md §1.2), and the one
// environment a machine finds commands in (node/lookup-env.ts).
//
// What this file is here to catch:
//   - an executor reported "not installed" because it is not on PATH, when its adapter
//     declares where it is: Claude Code from the native installer (~/.local/bin) or the
//     Windows desktop app (%LOCALAPPDATA%\Claude-Data), dsh from its uninstall entry — the
//     2026-11-10 report on the owner's workstation said "no claude, no dsh" this way,
//   - a declared place taken before PATH, or an older desktop-app version before a newer one
//     (versions compared as numbers: 10.0.0 is newer than 2.1.317), or a directory that only
//     contains a version in its name (`backup-99.0.0-disabled`) taken for the newest,
//   - "not found" that does not say where it looked, or says a variable is unset when it is
//     set to something that is not an absolute path,
//   - a registry that cannot be read, or has no entry, treated as an error,
//   - an uninstall entry matched by some other value than its display name,
//   - a declared place outside the closed set this program ships, or one taken from a
//     directory a round excludes,
//   - the probe and the Worker finding different commands: the probe in a login shell's PATH,
//     the Worker in the PATH the watch process inherited from a scheduler,
//   - the environment a host sends with a round (PATH, HOME, USERPROFILE, LOCALAPPDATA)
//     moving where the Worker's command is found — LOCALAPPDATA on its own too, which only
//     the desktop app's place reads,
//   - a login shell that never answers left running, or its fallback not saying so,
//   - rule tests that only hold on the system they were written on: the path rules are
//     tested with Windows- and POSIX-shaped paths on a fake disk, whatever the host is,
//   - a test that reads the owner's real LOCALAPPDATA or registry.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { HANDOVER_ENV } from '../node/client.ts';
import { probeExecutors, shellRun } from '../node/executors.ts';
import { launchOf } from '../node/launch.ts';
import { CommandMissing, installLocations, locate, missingText, placesOf } from '../node/locate.ts';
import type { RegistryQuery } from '../node/locate.ts';
import { parseLookupEnv, readLookupEnv } from '../node/lookup-env.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { boxOf, readExit } from '../node/runbox.ts';
import { runId } from './helpers.ts';

const same = (path: string): string => path;

// A disk of these files and nothing else, in the shape of one system's paths.
function disk(files: string[], path: typeof win32 | typeof posix = win32) {
  const held = new Set(files);
  const isFile = (file: string): boolean => held.has(file);
  const listDirs = (dir: string): string[] => {
    const names = new Set<string>();
    for (const file of held) {
      const rest = path.relative(dir, file);
      if (rest === '' || rest.startsWith('..') || path.isAbsolute(rest)) continue;
      const parts = rest.split(path.sep);
      if (parts.length > 1) names.add(parts[0]!);
    }
    return [...names];
  };
  return { isFile, listDirs, realpath: same };
}

// A `reg` that knows uninstall entries under HKCU, the way `reg query` prints them.
function registryWith(entries: { key: string; name: string; location?: string; kind?: string }[]): { registry: RegistryQuery; asked: string[][] } {
  const asked: string[][] = [];
  const registry: RegistryQuery = (args) => {
    asked.push(args);
    const [, key, ...rest] = args;
    if (rest[0] === '/s') {
      if (!key!.startsWith('HKCU\\')) return undefined;
      const hits = entries.filter((each) => each.key.startsWith(`HKEY_CURRENT_USER\\${key!.slice('HKCU\\'.length)}`));
      if (hits.length === 0) return undefined;
      return `\r\n${hits.map((each) => `${each.key}\r\n    ${each.name}    REG_SZ    ${rest[2]}\r\n`).join('\r\n')}\r\n搜索结束: 找到 ${hits.length} 匹配。\r\n`;
    }
    const hit = entries.find((each) => each.key === key);
    if (hit?.location === undefined) return undefined;
    return `\r\n${hit.key}\r\n    InstallLocation    ${hit.kind ?? 'REG_SZ'}    ${hit.location}\r\n\r\n`;
  };
  return { registry, asked };
}

const UNINSTALL = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const DESKTOP = (version: string, hash: string, install = 'claude_a'): string => `C:\\app\\Claude-Data\\${install}\\claude-code\\${version}\\${hash}\\claude.exe`;

// --- the rules, on a fake disk ---

test('PATH 优先：PATH 上有就不看声明的位置', () => {
  const fake = disk(['C:\\bin\\claude.exe', 'C:\\home\\.local\\bin\\claude.exe', DESKTOP('2.1.317', 'h')]);
  const env = { PATH: 'C:\\bin', USERPROFILE: 'C:\\home', LOCALAPPDATA: 'C:\\app' };
  assert.deepEqual(locate('claude', { env, platform: 'win32', ...fake }), { path: 'C:\\bin\\claude.exe', searched: ['PATH'] });
});

test('Claude：原生安装器的位置，然后桌面应用里最新的版本', () => {
  const files = [DESKTOP('2.1.309', 'h1'), DESKTOP('2.1.317', 'h2'), DESKTOP('nightly', 'h3')];
  const env = { PATH: 'C:\\empty', USERPROFILE: 'C:\\home', LOCALAPPDATA: 'C:\\app' };
  assert.equal(locate('claude', { env, platform: 'win32', ...disk(files) }).path, DESKTOP('2.1.317', 'h2'), '桌面应用取最新版本');
  // A version directory with no executable in it is not one to start.
  assert.equal(locate('claude', { env, platform: 'win32', ...disk(files), listDirs: (dir) => [...disk(files).listDirs(dir), ...(dir.endsWith('claude-code') ? ['99.0.0'] : [])] }).path, DESKTOP('2.1.317', 'h2'));
  const other = DESKTOP('10.0.0', 'h5', 'claude_b');
  assert.equal(locate('claude', { env, platform: 'win32', ...disk([...files, other]) }).path, other, '版本按数字比：10.0.0 比 2.1.317 新，跨安装目录');
  const native = 'C:\\home\\.local\\bin\\claude.exe';
  assert.equal(locate('claude', { env, platform: 'win32', ...disk([...files, other, native]) }).path, native, '原生安装器的位置排在桌面应用前面');
  // The variable's spelling does not matter on Windows.
  assert.equal(locate('claude', { env: { Path: '', UserProfile: 'C:\\home' }, platform: 'win32', ...disk([native]) }).path, native);
});

test('版本目录要整个名字就是版本号：前缀、后缀、备份标记都不算', () => {
  const env = { PATH: '', LOCALAPPDATA: 'C:\\app' };
  const real = DESKTOP('2.1.317', 'h');
  for (const name of ['backup-99.0.0-disabled', 'v99.0.0', '99.0.0.bak', '99.0.0 (old)', 'old-99.0.0']) {
    const lookup = locate('claude', { env, platform: 'win32', ...disk([real, DESKTOP(name, 'h')]) });
    assert.equal(lookup.path, real, name);
  }
  // A pre-release is a version all the same.
  assert.equal(locate('claude', { env, platform: 'win32', ...disk([real, DESKTOP('2.1.400-beta.1', 'h')]) }).path, DESKTOP('2.1.400-beta.1', 'h'));
});

test('Linux/macOS：PATH 之后按 HOME 下的原生安装位置；Windows 的位置不参与', () => {
  const fake = disk(['/home/o/.local/bin/claude'], posix);
  const found = locate('claude', { env: { PATH: '/usr/bin', HOME: '/home/o', LOCALAPPDATA: '/app' }, platform: 'linux', ...fake });
  assert.deepEqual(found, { path: '/home/o/.local/bin/claude', searched: ['PATH', '/home/o/.local/bin/claude'] });
  const onPath = locate('claude', { env: { PATH: 'relative:/usr/bin', HOME: '/home/o' }, platform: 'linux', ...disk(['/usr/bin/claude', 'relative/claude', '/home/o/.local/bin/claude'], posix) });
  assert.equal(onPath.path, '/usr/bin/claude', 'PATH 优先，相对的 PATH 项不认');
  const none = locate('claude', { env: { PATH: '/usr/bin' }, platform: 'darwin', ...fake });
  assert.deepEqual(none, { path: undefined, searched: ['PATH', '$HOME/.local/bin/claude（没有设置 HOME）'] });
  // dsh's place is an uninstall entry, which only Windows has.
  assert.deepEqual(locate('dsh', { env: { PATH: '/usr/bin' }, platform: 'linux', ...fake, registry: () => { throw new Error('不该问注册表'); } }), { path: undefined, searched: ['PATH'] });
});

test('dsh：Windows 卸载登记里记下的安装位置下面的命令行', () => {
  const cmd = 'D:\\software\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd';
  const fake = disk([cmd]);
  const key = `${UNINSTALL}\\1bf39983-50d0-5fe0-9ef4-cece76f67c5e`;
  const { registry, asked } = registryWith([{ key, name: 'DisplayName', location: 'D:\\software\\dsh' }]);
  assert.deepEqual(locate('dsh', { env: { PATH: '' }, platform: 'win32', ...fake, registry }), { path: cmd, searched: ['PATH', cmd] });
  assert.deepEqual(asked[0], ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'DeepSeek Harness', '/d', '/e']);
  assert.deepEqual(asked[1], ['query', key, '/v', 'InstallLocation']);
  // The launch a probe and a Worker get from it: a wrapper that is not npm's, through cmd.
  const launch = launchOf(['dsh', '--version'], { PATH: '', SystemRoot: 'C:\\Windows' }, 'win32', { ...fake, registry, readFile: () => '@echo off\r\n' });
  assert.deepEqual([launch.found, launch.command], [cmd, 'C:\\Windows\\System32\\cmd.exe']);
});

test('卸载登记：只认显示名本身是这个的条目，可展开的值按环境填上，读不到就是没有', () => {
  const a = `${UNINSTALL}\\a`;
  const b = `${UNINSTALL}\\b`;
  // `/f` matches the text in any value: an entry whose Publisher is "DeepSeek Harness" is not it.
  const { registry } = registryWith([{ key: a, name: 'Publisher', location: 'D:\\wrong' }, { key: b, name: 'DisplayName', location: '%ROOT%\\dsh', kind: 'REG_EXPAND_SZ' }]);
  assert.deepEqual(installLocations('DeepSeek Harness', registry, { ROOT: 'D:\\apps' }), ['D:\\apps\\dsh']);
  assert.deepEqual(installLocations('DeepSeek Harness', () => undefined, {}), [], '注册表读不到不是错误');
  const missing = locate('dsh', { env: { PATH: '' }, platform: 'win32', ...disk([]), registry: () => undefined });
  assert.deepEqual(missing, { path: undefined, searched: ['PATH', 'Windows 卸载登记里的 DeepSeek Harness（没有登记）'] });
  // Registered, but the command line is not where it should be: that path is said.
  const gone = locate('dsh', { env: { PATH: '' }, platform: 'win32', ...disk([]), registry: registryWith([{ key: b, name: 'DisplayName', location: 'D:\\gone' }]).registry });
  assert.deepEqual(gone.searched, ['PATH', 'D:\\gone\\resources\\runtime\\cli\\bin\\dsh.cmd']);
});

test('找不到时说清楚查过哪些地方：没设置和不是绝对路径分开说', () => {
  const env = { PATH: 'C:\\empty', USERPROFILE: 'C:\\home', LOCALAPPDATA: 'relative\\app' };
  const lookup = locate('claude', { env, platform: 'win32', ...disk([]) });
  assert.deepEqual(lookup, {
    path: undefined,
    searched: ['PATH', 'C:\\home\\.local\\bin\\claude.exe', '%LOCALAPPDATA%\\Claude-Data\\*\\claude-code\\<版本>\\*\\claude.exe（LOCALAPPDATA 不是绝对路径：relative\\app）'],
  });
  const unset = locate('claude', { env: { PATH: '' }, platform: 'win32', ...disk([]) });
  assert.equal(unset.searched.at(-1), '%LOCALAPPDATA%\\Claude-Data\\*\\claude-code\\<版本>\\*\\claude.exe（没有设置 LOCALAPPDATA）');
  assert.equal(missingText('codex', ['PATH']), '找不到 codex：查过 PATH');
  assert.throws(() => launchOf(['claude'], env, 'win32', disk([])), (error: unknown) =>
    error instanceof CommandMissing && error.searched.length === 3 && error.message === missingText('claude', lookup.searched));
});

test('机器上报的执行器状态里写着在哪里找到的；找不到时是同一句说明', async () => {
  const run = async (argv: string[]) => ({ stdout: argv[0] === 'claude' ? '2.1.317 (Claude Code)\n' : '', stderr: '', code: 0, path: 'C:\\app\\claude.exe' });
  const report = await probeExecutors({ questions: [{ executor: 'claude', command: 'claude', version: ['--version'] }], run });
  assert.deepEqual(report.executors[0], { executor: 'claude', installed: true, version: '2.1.317 (Claude Code)', logged_in: null, path: 'C:\\app\\claude.exe' });
  const missing = await shellRun(['tycho_probe_definitely_absent_917a6e', '--version'], 1000, process.platform, { env: { PATH: '' } });
  assert.equal(missing.failure, missingText('tycho_probe_definitely_absent_917a6e', ['PATH']));
});

test('声明是本程序自带的封闭集合：只按命令名从自带的适配器里取', () => {
  assert.deepEqual(placesOf('claude'), ADAPTERS['claude']!.installs);
  assert.deepEqual(placesOf('dsh'), ADAPTERS['dsh']!.installs);
  assert.deepEqual(placesOf('agy'), ADAPTERS['gemini']!.installs);
  assert.deepEqual(placesOf('codex'), ADAPTERS['codex']!.installs);
  assert.deepEqual(placesOf('C:\\evil\\claude'), [], '路径不是命令名，没有声明的位置');
  assert.deepEqual(placesOf('something-else'), []);
});

test('Windows：Codex 与 Gemini 在 PATH 缺失时也能命中常见用户安装位置', () => {
  const codexCmd = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd';
  const agyOfficial = 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe';
  const agyHome = 'C:\\Users\\u\\.agy\\bin\\agy.exe';
  const agyExe = 'C:\\Users\\u\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.exe';
  const env = { PATH: '', USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  assert.equal(locate('codex', { env, platform: 'win32', ...disk([codexCmd]) }).path, codexCmd);
  assert.equal(locate('agy', { env, platform: 'win32', ...disk([agyOfficial]) }).path, agyOfficial);
  assert.equal(locate('agy', { env, platform: 'win32', ...disk([agyHome]) }).path, agyHome);
  assert.equal(locate('agy', { env, platform: 'win32', ...disk([agyExe]) }).path, agyExe);
});

test('Tycho 托管用户级 CLI 目录（~/.tycho/cli）存在时优先于系统只读 PATH', () => {
  const posixManaged = '/home/o/.tycho/cli/bin/codex';
  const posixSystem = '/usr/local/bin/codex';
  assert.deepEqual(
    locate('codex', { env: { PATH: '/usr/local/bin', HOME: '/home/o' }, platform: 'linux', ...disk([posixManaged, posixSystem], posix) }),
    { path: posixManaged, searched: [posixManaged] },
  );
  // Absent managed binary falls through to PATH cleanly without polluting `searched`.
  assert.deepEqual(
    locate('codex', { env: { PATH: '/usr/local/bin', HOME: '/home/o' }, platform: 'linux', ...disk([posixSystem], posix) }),
    { path: posixSystem, searched: ['PATH'] },
  );
  // Windows managed binary also respects `exclude`.
  const winManaged = 'C:\\Users\\u\\.tycho\\cli\\codex.cmd';
  const winSys = 'C:\\Program Files\\nodejs\\codex.cmd';
  assert.equal(
    locate('codex', { env: { PATH: 'C:\\Program Files\\nodejs', USERPROFILE: 'C:\\Users\\u' }, platform: 'win32', ...disk([winManaged, winSys]) }).path,
    winManaged,
  );
});

test('声明的位置同样不进这一轮的目录', () => {
  const home = 'C:\\data\\tasks\\t1\\repo';
  const lookup = locate('claude', { env: { PATH: '', USERPROFILE: home }, platform: 'win32', exclude: ['C:\\data\\tasks'], ...disk([`${home}\\.local\\bin\\claude.exe`]) });
  assert.equal(lookup.path, undefined);

  // POSIX PATH and symlink canonicalization also refuse executables inside excluded task directories.
  const posixFiles = ['/data/tasks/t1/repo/bin/claude', '/usr/local/bin/claude', '/opt/link/claude'];
  const posixFake = disk(posixFiles, posix);
  const directExcluded = locate('claude', {
    env: { PATH: '/data/tasks/t1/repo/bin:/usr/local/bin', HOME: '/home/o' },
    platform: 'linux',
    exclude: ['/data/tasks'],
    ...posixFake,
  });
  assert.equal(directExcluded.path, '/usr/local/bin/claude');
  const symlinkExcluded = locate('claude', {
    env: { PATH: '/opt/link:/usr/local/bin', HOME: '/home/o' },
    platform: 'linux',
    exclude: ['/data/tasks'],
    ...posixFake,
    realpath: (p) => (p === '/opt/link/claude' ? '/data/tasks/t1/repo/bin/claude' : p),
  });
  assert.equal(symlinkExcluded.path, '/usr/local/bin/claude');
});

test('查找用的环境：Windows 会合并注册表系统/用户 PATH；登录 shell 打印的东西只认标记之后的那份', async () => {
  const own = { Path: 'C:\\bin', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  assert.equal((await readLookupEnv({ platform: 'win32', inherited: own, registry: () => undefined })).env, own);
  const reg: RegistryQuery = (args) => {
    if (args[1]?.startsWith('HKLM\\')) return '\r\nHKEY_LOCAL_MACHINE\\...\r\n    Path    REG_EXPAND_SZ    C:\\bin\\;C:\\Program Files\\nodejs\r\n';
    if (args[1]?.startsWith('HKCU\\')) return '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %APPDATA%\\npm;C:\\Program Files\\nodejs\r\n';
    return undefined;
  };
  const merged = await readLookupEnv({ platform: 'win32', inherited: own, registry: reg });
  assert.equal(merged.problem, undefined);
  assert.equal(merged.env['Path'], 'C:\\bin;C:\\Program Files\\nodejs;C:\\Users\\u\\AppData\\Roaming\\npm');
  const printed = `profile says hi\n\u0000TYCHO_LOOKUP_ENV\u0000${JSON.stringify({ PATH: '/opt/tools/bin:/usr/bin', N: 3 })}`;
  assert.deepEqual(parseLookupEnv(printed), { PATH: '/opt/tools/bin:/usr/bin' });
  assert.equal(parseLookupEnv('no marker at all'), undefined);
  // A login shell that cannot be started falls back to the client's own, and says so.
  const failed = await readLookupEnv({ platform: 'linux', inherited: own, spawn: (() => { throw new Error('没有 bash'); }) as unknown as typeof spawn });
  assert.equal(failed.env, own);
  assert.match(failed.problem!, /读不到登录 shell 的环境（没有 bash）/);
});

// A login shell whose profile hangs, stood in for by a Node that never exits, in a group of
// its own the way readLookupEnv starts it. `confirm` is what this machine's process look says
// afterwards: the real stop ends it either way, and only the words differ.
function hangingShell(t: TestContext, confirm: boolean) {
  let child: ReturnType<typeof spawn> | undefined;
  t.after(() => {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const start = ((_command: string, _args: string[], options: Parameters<typeof spawn>[2]) => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    return child;
  }) as unknown as typeof spawn;
  const processes = {
    async endGroup(root: number) {
      const ended = new Promise((resolve) => child!.once('exit', resolve));
      process.kill(root, 'SIGKILL');
      await ended;
    },
    groupAlive: () => (confirm ? false : undefined),
  } as unknown as HostProcesses;
  return { start, processes, pid: () => child?.pid };
}

const gone = (pid: number | undefined): boolean => {
  try {
    process.kill(pid!, 0);
    return false;
  } catch {
    return true;
  }
};

test('查找用的环境：登录 shell 卡住就按时结束它，退回客户端自己的环境并说明原因', async (t) => {
  const own = { PATH: '/usr/bin' };
  const shell = hangingShell(t, true);
  const read = await readLookupEnv({ platform: 'linux', inherited: own, spawn: shell.start, processes: shell.processes, timeoutMs: 300 });
  assert.equal(read.env, own, '退回客户端自己的环境');
  assert.match(read.problem!, /读不到登录 shell 的环境（300 毫秒没有回答）/);
  assert.doesNotMatch(read.problem!, /无法确认/);
  assert.ok(gone(shell.pid()), '卡住的登录 shell 已经结束，没有留下');
});

test('查找用的环境：结束不了或确认不了登录 shell 时，原因里照实写上', async (t) => {
  const own = { PATH: '/usr/bin' };
  const shell = hangingShell(t, false);
  const read = await readLookupEnv({ platform: 'linux', inherited: own, spawn: shell.start, processes: shell.processes, timeoutMs: 300 });
  assert.equal(read.env, own);
  assert.match(read.problem!, /300 毫秒没有回答；无法确认登录 shell 的进程已经结束/);
});

test('查找用的环境：真的登录 shell 读得出来，带着它自己的 PATH', { skip: process.platform === 'win32' ? '只在有登录 shell 的系统上' : false }, async () => {
  const read = await readLookupEnv({ inherited: { ...process.env, TYCHO_LOOKUP_PROBE: 'kept' } });
  assert.equal(read.problem, undefined);
  assert.equal(read.env['TYCHO_LOOKUP_PROBE'], 'kept');
  assert.ok((read.env['PATH'] ?? '').length > 0);
});

// --- one environment, from the probe to the Worker, on this computer ---

function dir(t: TestContext): string {
  const made = mkdtempSync(join(tmpdir(), 'tycho-locate-'));
  t.after(async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        rmSync(made, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200);
      }
    }
  });
  return made;
}

// A `claude` that says where it is when it runs: this Node under that name on Windows (it
// runs the printer below), a shell script elsewhere (a link to Node would report Node's own
// path, resolved).
function fakeClaude(file: string): string {
  mkdirSync(join(file, '..'), { recursive: true });
  if (process.platform === 'win32') {
    try {
      linkSync(process.execPath, file);
    } catch {
      copyFileSync(process.execPath, file);
    }
  } else {
    writeFileSync(file, `#!/bin/sh\nprintf '{"ran":"%s"}\\n' "$0"\n`);
    chmodSync(file, 0o755);
  }
  return file;
}

const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude';
const HOME_VARS = process.platform === 'win32' ? ['USERPROFILE', 'LOCALAPPDATA'] : ['HOME'];
const homeOf = (home: string): Record<string, string> => Object.fromEntries(HOME_VARS.map((name) => [name, home]));
const PATH_KEY = Object.keys(process.env).find((each) => each.toUpperCase() === 'PATH') ?? 'PATH';

// Prints which program ran it. Run by the fake claude, which is Node.
function printer(root: string): string {
  const file = join(root, 'print.mjs');
  writeFileSync(file, 'process.stdout.write(JSON.stringify({ ran: process.execPath }) + "\\n");\n');
  chmodSync(file, 0o644);
  return file;
}

// A watch process the way the client starts one, with the environment it inherits (a
// scheduler's) and the handover: the host's env for the Worker and the machine's lookup env.
async function watchRound(t: TestContext, inherited: NodeJS.ProcessEnv, handover: Record<string, unknown>, argv: string[]): Promise<string> {
  const dataDir = dir(t);
  const run = runId('locate-watch');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'node', 'watch.ts'), `--data=${dataDir}`, `--run=tasks/t1/runs/${run}`, '--round=1', '--', ...argv], {
    stdio: 'ignore', windowsHide: true, env: { ...inherited, [HANDOVER_ENV]: JSON.stringify(handover) },
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  assert.equal(readExit(box), 0, readFileSync(join(box.runDir, 'stderr.log'), 'utf8'));
  return (JSON.parse(readFileSync(join(box.runDir, 'stdout.ndjson'), 'utf8').trim()) as { ran: string }).ran;
}

test('登录 PATH 和自启 PATH 各有一份：探测报告的和 Worker 实际启动的是同一个', async (t) => {
  const root = dir(t);
  const print = printer(root);
  const login = fakeClaude(join(root, 'login-bin', CLAUDE));
  fakeClaude(join(root, 'autostart-bin', CLAUDE));
  const nowhere = join(root, 'nowhere');
  const lookup = { ...process.env, [PATH_KEY]: join(root, 'login-bin'), ...homeOf(nowhere) };
  const scheduler = { ...process.env, [PATH_KEY]: join(root, 'autostart-bin'), ...homeOf(nowhere) };
  const probed = await shellRun(['claude', print], 20_000, process.platform, { env: lookup });
  assert.equal(probed.code, 0, probed.failure ?? probed.stderr);
  assert.equal(probed.path, login, '探测按查找用的环境找到登录 PATH 上的那份');
  assert.equal((JSON.parse(probed.stdout.trim()) as { ran: string }).ran, login);
  const ran = await watchRound(t, scheduler, { env: {}, lookup }, ['claude', print]);
  assert.equal(ran, probed.path, 'Worker 起的就是探测报告的那份，不是自启 PATH 上的');
});

test('主机下发的 PATH、HOME、USERPROFILE、LOCALAPPDATA 改变不了 Worker 的命令找到哪一份', async (t) => {
  const root = dir(t);
  const print = printer(root);
  const machineHome = join(root, 'machine-home');
  const own = fakeClaude(join(machineHome, '.local', 'bin', CLAUDE));
  const hostHome = join(root, 'host-home');
  fakeClaude(join(hostHome, '.local', 'bin', CLAUDE));
  fakeClaude(join(root, 'host-bin', CLAUDE));
  const machine = { ...process.env, [PATH_KEY]: join(root, 'empty'), ...homeOf(machineHome) };
  const hostEnv = { [PATH_KEY]: join(root, 'host-bin'), HOME: hostHome, USERPROFILE: hostHome, LOCALAPPDATA: hostHome };
  // Once from the lookup env handed over, once from the watch's own inherited one.
  assert.equal(await watchRound(t, machine, { env: hostEnv, lookup: machine }, ['claude', print]), own);
  assert.equal(await watchRound(t, machine, { env: hostEnv }, ['claude', print]), own);
});

test('只有桌面版能找到时，LOCALAPPDATA 也按机器自己的那份找，不按主机下发的', { skip: process.platform === 'win32' ? false : '桌面版的安装位置只在 Windows 上声明' }, async (t) => {
  const root = dir(t);
  const print = printer(root);
  const desktop = (local: string, version: string): string => join(local, 'Claude-Data', 'claude_a', 'claude-code', version, 'h', 'claude.exe');
  const machineLocal = join(root, 'machine-local');
  const own = fakeClaude(desktop(machineLocal, '2.1.300'));
  // The host's is newer: merged in by mistake, it would win the newest-version pick.
  const hostLocal = join(root, 'host-local');
  fakeClaude(desktop(hostLocal, '9.0.0'));
  // Neither PATH nor the native installer's place has one, on either side.
  const nowhere = join(root, 'nowhere');
  const machine = { ...process.env, [PATH_KEY]: join(root, 'empty'), USERPROFILE: nowhere, LOCALAPPDATA: machineLocal };
  const hostEnv = { [PATH_KEY]: join(root, 'empty'), USERPROFILE: nowhere, LOCALAPPDATA: hostLocal };
  assert.equal(await watchRound(t, machine, { env: hostEnv, lookup: machine }, ['claude', print]), own);
  assert.equal(await watchRound(t, machine, { env: hostEnv }, ['claude', print]), own);
});
