// Guards how this machine starts an executor's command (node/launch.ts): the one place both
// the probe (node/executors.ts) and the watch process (node/watch.ts) learn what to run.
//
// What this file is here to catch:
//   - a Worker that the probe found but the watch cannot start: on Windows an npm install
//     leaves a `.cmd` wrapper, which `spawn('codex')` does not find (ENOENT) and which Node
//     refuses to start without a shell (EINVAL) — the 2026-11-09 round on the owner's
//     workstation ended "exit 137" this way,
//   - arguments rewritten on the way through cmd: spaces, quotes, `%VAR%`, `^`, `&`, `|`,
//     `<`, `>`, `!`, parentheses, a trailing backslash and an empty argument must reach
//     the executor exactly as the adapter wrote them (brief and tier-file paths are in them),
//   - a lookup that runs a `codex.cmd` planted in the Worker's working directory, or reads
//     only `PATH` when Windows spells it `Path`,
//   - POSIX starting anything other than the command as found, with its arguments as given,
//   - a Worker that could not start recorded as "exit 137" (which reads as killed) instead of
//     as a round that never started, with the executor's own words, and without the machine's
//     own evidence that it never ran (an exit code of 2 alone does not say so),
//   - a locally restored Tycho projection entering a fixed-knowledge round after dispatch,
//   - a credential handed as a variable's value lost on the way through cmd: a variable gets
//     through cmd, and dsh on Windows is exactly such a wrapper,
//   - a command found in a round's own directories (the Task's, its repo/, anywhere under
//     them, the working directory) because PATH names them, in whatever spelling,
//   - a PATH entry without a drive (`\dir`) checked in one place and run in another.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { delimiter, dirname } from 'node:path';
import { batToken, launchOf, roundDirs } from '../node/launch.ts';
import { boxOf, readExit, readLeft, readNotStarted, readWorkerEvidence, runState, writeExit, writeNotStarted } from '../node/runbox.ts';
import { selectProcesses } from '../node/hostprocess.ts';
import { HANDOVER_ENV } from '../node/client.ts';
import { shellRun } from '../node/executors.ts';
import { runId } from './helpers.ts';
import { ADAPTERS } from '../adapters/all.ts';

// A fake filesystem's paths are where they are: no disk is asked about them.
const same = (path: string): string => path;

const WATCH = join(import.meta.dirname, '..', 'node', 'watch.ts');
const onWindows = process.platform === 'win32' ? false : '只在 Windows 上有 .cmd 包装';

// Every character cmd treats as its own, in the places a Worker's arguments put them.
const NASTY = [
  'plain',
  'with space',
  'C:\\Users\\some one\\tycho data\\runs\\r1\\snapshot\\brief.md',
  '请先读 runs/r1/snapshot/brief.md，按其中要求完成任务。',
  '"quoted"',
  'a"b c',
  '100%',
  '%PATH%',
  '%%',
  '^caret^^',
  'a&b',
  'x|y',
  '<in>out',
  '(paren)',
  '!bang!',
  'semi;colon,comma=eq',
  'trailing\\',
  'C:\\dir with space\\',
  '',
  "it's",
  'model="gpt" & echo pwned',
];

function scratch(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

// A stand-in executor installed the way npm installs one: a directory with a space in it,
// holding only `<name>.cmd` (npm's own wrapper text), which runs a node script that writes
// the arguments it was handed.
// `withEnv`: it writes the variable a credential comes in as as well, beside its arguments.
function cmdOnlyExecutor(t: TestContext, name: string, withEnv = false): { bin: string; dump: string } {
  const root = scratch(t, 'tycho-launch-');
  const bin = join(root, 'npm global', 'bin dir');
  mkdirSync(join(bin, 'node_modules', 'fake'), { recursive: true });
  const what = withEnv ? '{ argv: process.argv.slice(2), credential: process.env.TYCHO_TEST_CRED ?? null }' : 'process.argv.slice(2)';
  writeFileSync(join(bin, 'node_modules', 'fake', 'dump.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.TYCHO_LAUNCH_DUMP, JSON.stringify(${what}));\n`);
  writeFileSync(join(bin, `${name}.cmd`), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    `SET "_prog=${process.execPath}"`, '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake\\dump.mjs" %*`, '',
  ].join('\r\n'));
  return { bin, dump: join(root, 'argv.json') };
}

// The wrapper npm's cmd-shim writes, word for word, for a package whose bin is `script`; the
// node it runs is the one on PATH, as on a machine where node was installed on its own.
const NPM_SHIM = (script: string): string => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, '',
].join('\r\n');

// What the stand-in writes: its arguments, and what reached it in the credential's variable.
const DUMP = [
  "import { writeFileSync } from 'node:fs';",
  'const credential = process.env.TYCHO_TEST_CRED ?? null;',
  'writeFileSync(process.env.TYCHO_LAUNCH_DUMP, JSON.stringify({ argv: process.argv.slice(2), credential }));',
  '',
].join('\n');

// A stand-in executor installed by npm: `<name>.cmd` as cmd-shim writes it, and the package.
function npmExecutor(t: TestContext, name: string): { bin: string; dump: string } {
  const root = scratch(t, 'tycho-launch-npm-');
  const bin = join(root, 'npm global', 'bin dir');
  mkdirSync(join(bin, 'node_modules', 'fake'), { recursive: true });
  writeFileSync(join(bin, 'node_modules', 'fake', 'dump.mjs'), DUMP);
  writeFileSync(join(bin, `${name}.cmd`), NPM_SHIM('node_modules\\fake\\dump.mjs'));
  return { bin, dump: join(root, 'argv.json') };
}

// Windows spells it `Path`; whichever spelling this process has is the one overridden, with
// this node's own directory on it (npm's wrapper finds node there).
function withPath(bin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((each) => each.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...process.env, [key]: `${bin};${dirname(process.execPath)};${process.env[key] ?? ''}`, ...extra };
}

test('POSIX：找到的命令连同参数原样交给 spawn，不经 shell', () => {
  const launch = launchOf(['codex', 'exec', 'a b', '%x%'], { PATH: 'relative:/usr/bin' }, 'linux', {
    isFile: (path) => path === '/usr/bin/codex' || path === 'relative/codex',
    realpath: same,
  });
  assert.deepEqual(launch, { command: '/usr/bin/codex', args: ['exec', 'a b', '%x%'], verbatim: false, found: '/usr/bin/codex' });
  assert.throws(() => launchOf(['codex'], { PATH: '/usr/bin' }, 'linux', { isFile: () => false, realpath: same }), /找不到 codex：查过 PATH/);
});

test('工作目录是 $HOME、根目录或用户目录祖先时：仍跳过该目录本身，但放行子目录下的用户级 CLI', () => {
  // Linux systemd --user launches with cwd === $HOME: `~/.local/bin/agy` must remain discoverable
  // while a binary planted directly at `$HOME/agy` is still rejected.
  const posixFiles = new Set(['/home/u/agy', '/home/u/.local/bin/agy']);
  const posixLaunch = launchOf(['agy', '--version'], { PATH: '/home/u:/usr/bin', HOME: '/home/u' }, 'linux', {
    cwd: '/home/u',
    isFile: (path) => posixFiles.has(path),
    realpath: same,
  });
  assert.equal(posixLaunch.command, '/home/u/.local/bin/agy');

  // Same for `/` as cwd on Linux.
  const rootLaunch = launchOf(['agy'], { PATH: '/:/home/u/.local/bin', HOME: '/home/u' }, 'linux', {
    cwd: '/',
    isFile: (path) => path === '/agy' || path === '/home/u/.local/bin/agy',
    realpath: same,
  });
  assert.equal(rootLaunch.command, '/home/u/.local/bin/agy');

  // Same on Windows when cwd === %USERPROFILE%: `%USERPROFILE%\.local\bin\claude.exe` works,
  // while `%USERPROFILE%\claude.exe` is skipped.
  const winFiles = new Set(['C:\\Users\\u\\claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe']);
  const winLaunch = launchOf(['claude'], { PATH: 'C:\\Users\\u', USERPROFILE: 'C:\\Users\\u' }, 'win32', {
    cwd: 'C:\\Users\\u',
    isFile: (path) => winFiles.has(path),
    realpath: same,
  });
  assert.equal(winLaunch.command, 'C:\\Users\\u\\.local\\bin\\claude.exe');

  // A normal project repo cwd under `$HOME` is NOT a broad root, so its subdirectories remain
  // recursively excluded (e.g. `repo/node_modules/.bin/codex`).
  const repoFiles = new Set(['/home/u/work/repo/node_modules/.bin/codex', '/home/u/.local/bin/codex']);
  const repoLaunch = launchOf(['codex'], { PATH: '/home/u/work/repo/node_modules/.bin:/home/u/.local/bin', HOME: '/home/u' }, 'linux', {
    cwd: '/home/u/work/repo',
    isFile: (path) => repoFiles.has(path),
    realpath: same,
  });
  assert.equal(repoLaunch.command, '/home/u/.local/bin/codex');
});

test('Windows 找命令：按 PATHEXT 找到 .cmd，Path 的大小写不论，不看工作目录', () => {
  const files = new Set(['C:\\work\\codex.cmd', 'C:\\npm\\codex', 'C:\\npm\\codex.cmd', 'C:\\npm\\codex.ps1']);
  const env = { Path: 'C:\\empty;"C:\\npm";relative\\dir', PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1', SystemRoot: 'C:\\Windows' };
  const launch = launchOf(['codex', '--version'], env, 'win32', { cwd: 'C:\\work', isFile: (path) => files.has(path), realpath: same });
  assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(launch.verbatim, true);
  assert.deepEqual(launch.args.slice(0, -1), ['/d', '/e:on', '/v:off', '/s', '/c']);
  assert.equal(launch.args.at(-1), '""C:\\npm\\codex.cmd" --version"', '找到的是 PATH 上的 .cmd，不是工作目录里的');
});

test('Windows 找命令：真正的 .exe 直接起，不经 cmd', () => {
  const files = new Set(['C:\\Program Files\\Codex\\codex.exe', 'C:\\npm\\codex.cmd']);
  const env = { PATH: 'C:\\Program Files\\Codex;C:\\npm' };
  const launch = launchOf(['codex', 'a b'], env, 'win32', { isFile: (path) => files.has(path), realpath: same });
  assert.deepEqual(launch, { command: 'C:\\Program Files\\Codex\\codex.exe', args: ['a b'], verbatim: false, found: 'C:\\Program Files\\Codex\\codex.exe' });
});

test('Windows 找命令：找不到就当场说，不交给 spawn 去报 ENOENT', () => {
  assert.throws(() => launchOf(['codex'], { PATH: 'C:\\nothing' }, 'win32', { isFile: () => false, realpath: same }), /找不到 codex：查过 PATH/);
});

test('cmd 转义：元字符都在引号里，% 不展开，双引号和结尾反斜杠按 C runtime 的规则', () => {
  assert.equal(batToken('plain'), 'plain');
  assert.equal(batToken('a&b'), '"a&b"');
  assert.equal(batToken(''), '""');
  assert.equal(batToken('a"b'), '"a""b"');
  assert.equal(batToken('dir\\'), '"dir\\\\"');
  assert.equal(batToken('%PATH%'), '"%%cd:~,%PATH%%cd:~,%"');
  assert.throws(() => batToken('two\nlines'), /换行.*two/);
});

test('Windows cmd 命令行长度上限：超过 8000 字符给出明确诊断错误', () => {
  const files = new Set(['C:\\npm\\codex.cmd']);
  const env = { PATH: 'C:\\npm', SystemRoot: 'C:\\Windows' };
  assert.throws(
    () => launchOf(['codex', 'x'.repeat(8001)], env, 'win32', { isFile: (path) => files.has(path), realpath: same, readFile: () => '' }),
    /命令行过长（\d+ 字符），超过 Windows cmd 限制/,
  );
});

test('Windows 真实 cmd：只有 .cmd 包装的执行器起得来，参数一个字不变', { skip: onWindows }, async (t) => {
  const fake = cmdOnlyExecutor(t, 'tycho-fake-codex');
  const env = withPath(fake.bin, { TYCHO_LAUNCH_DUMP: fake.dump });
  const launch = launchOf(['tycho-fake-codex', ...NASTY], env, 'win32');
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { env, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: launch.verbatim });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(fake.dump, 'utf8')), NASTY);
});

test('Windows 探针和 Worker 同一套找法：探针也找得到只有 .cmd 包装的执行器', { skip: onWindows }, async (t) => {
  const fake = cmdOnlyExecutor(t, 'tycho-fake-probe');
  const answer = await shellRun(['tycho-fake-probe', '--version', 'a b'], 10_000, 'win32', { env: withPath(fake.bin, { TYCHO_LAUNCH_DUMP: fake.dump }) });
  assert.equal(answer.code, 0, answer.failure ?? answer.stderr);
  assert.deepEqual(JSON.parse(readFileSync(fake.dump, 'utf8')), ['--version', 'a b']);
});

function startWatch(dataDir: string, run: string, argv: string[], env: NodeJS.ProcessEnv, credential?: string): Promise<number> {
  const cred = credential === undefined ? [] : ['--credential=TYCHO_TEST_CRED'];
  const child = spawn(process.execPath, [WATCH, `--data=${dataDir}`, `--run=tasks/t1/runs/${run}`, '--round=1', ...cred, '--', ...argv], {
    stdio: 'ignore', windowsHide: true, env: { ...env, [HANDOVER_ENV]: JSON.stringify(credential === undefined ? {} : { credential }) },
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

test('看管进程：Windows 上只有 .cmd 包装的 Worker 照常起来，参数一个字不变', { skip: onWindows }, async (t) => {
  const fake = cmdOnlyExecutor(t, 'tycho-fake-worker');
  const dataDir = scratch(t, 'tycho-launch-data-');
  const run = runId('launch-cmd');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  assert.equal(await startWatch(dataDir, run, ['tycho-fake-worker', ...NASTY], withPath(fake.bin, { TYCHO_LAUNCH_DUMP: fake.dump })), 0);
  assert.equal(readExit(box), 0, readFileSync(join(box.runDir, 'watch.log'), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(fake.dump, 'utf8')), NASTY);
});

test('看管进程：Worker 起不来就是这一轮没有开工，原话写进 stderr.log，不记成 137', async (t) => {
  const dataDir = scratch(t, 'tycho-launch-data-');
  const run = runId('launch-missing');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  const code = await startWatch(dataDir, run, ['tycho_launch_definitely_absent_5c1f', '--json'], process.env);
  assert.equal(code, 2, '看管进程给的是“什么都没起”的码');
  assert.equal(readExit(box), 2, '记下的是没开工，不是被杀的 137');
  assert.equal(readLeft(box), 'none');
  assert.match(readFileSync(join(box.runDir, 'stderr.log'), 'utf8'), /^Worker 没能启动：.*tycho_launch_definitely_absent_5c1f/m);
  const log = readFileSync(join(box.runDir, 'watch.log'), 'utf8');
  assert.doesNotMatch(log, /137|pid （没能启动）/);
  assert.match(log, /Worker 没能启动：/);
});

test('看管进程：外部全局知识投影与历史 fixed-knowledge.json 不再阻断 Worker 启动', async (t) => {
  const dataDir = scratch(t, 'tycho-launch-data-');
  const codexHome = join(dataDir, 'codex');
  const marker = join(dataDir, 'worker-started');
  const run = runId('launch-fixed-knowledge');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'fixed-knowledge.json'), JSON.stringify({ executor: 'codex', require_entry_absence: true, require_mcp_absence: true }));
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'AGENTS.md'), '<!-- tycho:generated -->\n旧版正文');
  const worker = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`;
  const code = await startWatch(dataDir, run, [process.execPath, '-e', worker], { ...process.env, CODEX_HOME: codexHome });
  assert.equal(code, 0);
  assert.equal(existsSync(marker), true);
});

// What the host makes of that round: the adapter reads stderr.log, and its words are the
// reason the Task is held — never "进程退出码 137".
test('主机读这一轮：任务停住的理由是 Worker 没能启动的原话', () => {
  const said = 'Worker 没能启动：PATH 里找不到 codex\n';
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    const message = adapter.result('', 2, said).error?.message ?? '';
    assert.match(message, /Worker 没能启动：PATH 里找不到 codex/, name);
    assert.doesNotMatch(message, /137/, name);
  }
});

test('npm 的标准包装：解析出背后的 node 和脚本，直接起，不经 cmd', () => {
  const files = new Set(['C:\\npm\\codex.cmd', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'C:\\Program Files\\nodejs\\node.exe']);
  const env = { PATH: 'C:\\npm;C:\\Program Files\\nodejs' };
  const launch = launchOf(['codex', 'exec', 'a&b'], env, 'win32', {
    isFile: (path) => files.has(path), realpath: same,
    readFile: () => NPM_SHIM('node_modules\\@openai\\codex\\bin\\codex.js'),
  });
  assert.deepEqual(launch, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'exec', 'a&b'],
    verbatim: false, found: 'C:\\npm\\codex.cmd',
  });
  const current = launchOf(['codex', 'exec', 'a&b'], env, 'win32', {
    isFile: (path) => files.has(path), realpath: same,
    readFile: () => NPM_SHIM('node_modules\\@openai\\codex\\bin\\codex.js')
      .replace('title %COMSPEC% & "%_prog%"', 'title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"'),
  });
  assert.deepEqual(current, launch, '当前 cmd-shim 的 PATHEXT 设置不妨碍直接启动');
  const modified = launchOf(['codex'], env, 'win32', {
    isFile: (path) => files.has(path), realpath: same,
    readFile: () => NPM_SHIM('node_modules\\@openai\\codex\\bin\\codex.js')
      .replace('title %COMSPEC% & "%_prog%"', 'title %COMSPEC% & set OTHER=value & "%_prog%"'),
  });
  assert.equal(modified.verbatim, true, '其他插入的命令仍交给 cmd');
  // A wrapper that is not npm's, word for word, goes through cmd and says which wrapper it is.
  const other = launchOf(['codex'], env, 'win32', { isFile: (path) => files.has(path), realpath: same, readFile: () => '@node "%~dp0\\x.js" %*\r\n' });
  assert.equal(other.found, 'C:\\npm\\codex.cmd');
  // npm's wrapper whose script is not there is not run as node either.
  const script = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  const gone = launchOf(['codex'], env, 'win32', {
    isFile: (path) => path !== script && files.has(path), realpath: same, readFile: () => NPM_SHIM('node_modules\\@openai\\codex\\bin\\codex.js'),
  });
  assert.equal(gone.found, 'C:\\npm\\codex.cmd');
});

test('找命令不进这一轮的目录：PATH 写明了任务目录、repo/、它们下面、工作目录也跳过，写法不论', () => {
  const files = new Set([
    'C:\\data\\tasks\\t1\\repo\\codex.cmd', 'C:\\data\\tasks\\t1\\codex.cmd', 'C:\\data\\tasks\\t2\\repo\\node_modules\\.bin\\codex.cmd',
    'C:\\work\\codex.cmd', 'C:\\LONGNA~1\\codex.cmd', 'C:\\npm\\codex.cmd',
  ]);
  const PATH = [
    'C:\\data\\tasks\\t1\\repo', 'c:\\DATA\\Tasks\\T1\\', 'C:\\data\\tasks\\t2\\repo\\node_modules\\.bin',
    'C:\\data\\tasks\\t1\\repo\\..\\..\\t1', 'C:\\work', 'C:\\LONGNA~1', 'C:\\npm',
  ].join(';');
  // The short name of the task's directory, as the disk would expand it.
  const realpath = (path: string): string => {
    if (path.toUpperCase() === 'C:\\LONGNA~1') return 'C:\\data\\tasks\\t1';
    if (path.toUpperCase() === 'C:\\LONGNA~1\\CODEX.CMD') return 'C:\\data\\tasks\\t1\\codex.cmd';
    return path;
  };
  const launch = launchOf(['codex'], { PATH }, 'win32', {
    cwd: 'C:\\work', exclude: roundDirs('C:\\data', 'C:\\data\\tasks\\t1'), isFile: (path) => files.has(path), realpath, readFile: () => '',
  });
  assert.equal(launch.found, 'C:\\npm\\codex.cmd', '只认任务目录以外的那份');
});

test('PATH 只认完全限定的路径：交给 spawn 的就是检查过的那个', () => {
  const files = new Set(['\\Program Files\\nodejs\\codex.exe', 'C:\\Program Files\\nodejs\\codex.exe', '\\\\server\\share\\bin\\codex.exe']);
  const isFile = (path: string): boolean => files.has(path);
  assert.throws(() => launchOf(['codex'], { PATH: '\\Program Files\\nodejs;relative' }, 'win32', { isFile, realpath: same }), /找不到 codex：查过 PATH/);
  assert.equal(launchOf(['codex'], { PATH: '\\Program Files\\nodejs;\\\\server\\share\\bin' }, 'win32', { isFile, realpath: same }).command, '\\\\server\\share\\bin\\codex.exe');
  assert.equal(launchOf(['codex'], { PATH: '\\Program Files\\nodejs;C:\\Program Files\\nodejs' }, 'win32', { isFile, realpath: same }).command, 'C:\\Program Files\\nodejs\\codex.exe');
  assert.throws(() => launchOf(['\\Program Files\\nodejs\\codex.exe'], {}, 'win32', { isFile, realpath: same }), /找不到 .*codex\.exe：查过 /, '没有盘符的命令路径也不认');
});

test('Windows 真实 npm 包装：Worker 在环境变量里收到凭据，参数一个字不变', { skip: onWindows }, async (t) => {
  const fake = npmExecutor(t, 'tycho-fake-npm');
  const dataDir = scratch(t, 'tycho-launch-data-');
  const run = runId('launch-npm-cred');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  const credential = 'not-a-secret-test-string';
  assert.equal(await startWatch(dataDir, run, ['tycho-fake-npm', ...NASTY], withPath(fake.bin, { TYCHO_LAUNCH_DUMP: fake.dump }), credential), 0);
  assert.equal(readExit(box), 0, readFileSync(join(box.runDir, 'watch.log'), 'utf8'));
  const dump = JSON.parse(readFileSync(fake.dump, 'utf8')) as { argv: string[]; credential: string };
  assert.deepEqual(dump.argv, NASTY);
  assert.equal(dump.credential, credential, '凭据作为变量的值到了 Worker 手上');
  assert.equal(readNotStarted(box), null, '起来了的一轮没有“没开工”的证据');
});

test('Windows 解析不了的 .cmd 包装：凭据经环境变量交付时照常起来，Worker 读到凭据', { skip: onWindows }, async (t) => {
  const fake = cmdOnlyExecutor(t, 'tycho-fake-envcred', true);
  const dataDir = scratch(t, 'tycho-launch-data-');
  const run = runId('launch-cmd-env');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  const credential = 'not-a-secret-env-string';
  assert.equal(await startWatch(dataDir, run, ['tycho-fake-envcred', 'a b'], withPath(fake.bin, { TYCHO_LAUNCH_DUMP: fake.dump }), credential), 0);
  assert.equal(readExit(box), 0, readFileSync(join(box.runDir, 'watch.log'), 'utf8'));
  const dump = JSON.parse(readFileSync(fake.dump, 'utf8')) as { argv: string[]; credential: string | null };
  assert.deepEqual(dump.argv, ['a b']);
  assert.equal(dump.credential, credential, '凭据作为变量的值到了 Worker 手上');
  assert.equal(readNotStarted(box), null);
});

test('Windows 真实查找：repo/ 里带进来的同名包装不会被当成执行器，即使 PATH 写明了它', { skip: onWindows }, async (t) => {
  const dataDir = scratch(t, 'tycho-launch-data-');
  const run = runId('launch-planted');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  const real = npmExecutor(t, 'tycho-fake-planted');
  const planted = join(box.taskDir, 'repo');
  mkdirSync(planted, { recursive: true });
  const marker = join(dataDir, 'planted-ran');
  writeFileSync(join(planted, 'tycho-fake-planted.cmd'), `@echo planted> "${marker}"\r\n`);
  const env = withPath(`${planted.toUpperCase()}\\;${box.taskDir};${real.bin}`, { TYCHO_LAUNCH_DUMP: real.dump });
  assert.equal(await startWatch(dataDir, run, ['tycho-fake-planted', 'ok'], env), 0);
  assert.deepEqual((JSON.parse(readFileSync(real.dump, 'utf8')) as { argv: string[] }).argv, ['ok'], '跑的是装好的那份');
  assert.throws(() => readFileSync(marker), 'repo/ 里那份一次都没跑');
  // The probe takes the same rule: it does not find it there either.
  const key = Object.keys(process.env).find((each) => each.toUpperCase() === 'PATH') ?? 'PATH';
  const probe = await shellRun(['tycho-fake-planted'], 10_000, 'win32', { env: { ...process.env, [key]: planted }, exclude: roundDirs(dataDir) });
  assert.match(probe.failure ?? '', /找不到 tycho-fake-planted：查过 PATH/);
});

test('“Worker 没起来”是机器自己的证据：节点状态把它报给主机', async (t) => {
  const dataDir = scratch(t, 'tycho-launch-data-');
  const run = runId('launch-evidence');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  assert.equal(await startWatch(dataDir, run, ['tycho_launch_definitely_absent_77aa'], process.env), 2);
  const state = await runState(box, selectProcesses());
  assert.equal(state.exit, 2);
  assert.match(state.not_started ?? '', /^Worker 没能启动：/);
});

test('找命令按磁盘上的真实位置比：指向 repo/ 的别名目录、指向它里面的文件、查不到真实位置的目录都不认', () => {
  const files = new Set(['C:\\path-bin\\codex.exe', 'C:\\ghost\\codex.exe', 'C:\\linked\\codex.exe', 'C:\\safe\\codex.exe']);
  const realpath = (path: string): string => {
    const upper = path.toUpperCase();
    if (upper === 'C:\\PATH-BIN') return 'C:\\data\\tasks\\t1\\repo';
    if (upper === 'C:\\PATH-BIN\\CODEX.EXE') return 'C:\\data\\tasks\\t1\\repo\\codex.exe';
    if (upper.startsWith('C:\\GHOST')) throw new Error('EACCES');
    if (upper === 'C:\\LINKED\\CODEX.EXE') return 'C:\\data\\tasks\\t2\\repo\\bin\\codex.exe';
    return path;
  };
  const launch = launchOf(['codex'], { PATH: 'C:\\path-bin;C:\\ghost;C:\\linked;C:\\safe' }, 'win32', {
    exclude: roundDirs('C:\\data', 'C:\\data\\tasks\\t1'), isFile: (path) => files.has(path), realpath,
  });
  assert.equal(launch.command, 'C:\\safe\\codex.exe');
});

test('Windows 真实 junction：指向 repo/ 的目录写在 PATH 里，里面带进来的同名包装也不会被当成执行器', { skip: onWindows }, async (t) => {
  const dataDir = scratch(t, 'tycho-launch-data-');
  const run = runId('launch-junction');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  const real = npmExecutor(t, 'tycho-fake-junction');
  const repo = join(box.taskDir, 'repo');
  mkdirSync(repo, { recursive: true });
  const marker = join(dataDir, 'junction-ran');
  writeFileSync(join(repo, 'tycho-fake-junction.cmd'), `@echo planted> "${marker}"\r\n`);
  const alias = join(scratch(t, 'tycho-launch-alias-'), 'path-bin');
  symlinkSync(repo, alias, 'junction');
  const env = withPath(`${alias};${real.bin}`, { TYCHO_LAUNCH_DUMP: real.dump });
  assert.equal(await startWatch(dataDir, run, ['tycho-fake-junction', 'ok'], env), 0);
  assert.deepEqual((JSON.parse(readFileSync(real.dump, 'utf8')) as { argv: string[] }).argv, ['ok'], '跑的是装好的那份');
  assert.throws(() => readFileSync(marker), 'junction 后面那份一次都没跑');
  const key = Object.keys(process.env).find((each) => each.toUpperCase() === 'PATH') ?? 'PATH';
  const probe = await shellRun(['tycho-fake-junction'], 10_000, 'win32', { env: { ...process.env, [key]: alias }, exclude: roundDirs(dataDir) });
  assert.match(probe.failure ?? '', /找不到 tycho-fake-junction：查过 PATH/, '探针按同一规则也不认');
});

test('跑起来的 Worker 写的“没开工”不算数：有 Worker 启动证据就照“启动过”报', async (t) => {
  const dataDir = scratch(t, 'tycho-launch-data-');
  const run = runId('launch-forged');
  const box = boxOf(dataDir, `tasks/t1/runs/${run}`);
  const fake = join(import.meta.dirname, 'fake-executor.mjs');
  assert.equal(await startWatch(dataDir, run, [process.execPath, fake], process.env), 0);
  assert.notEqual(readWorkerEvidence(box).pid, undefined, '看管进程记下了 Worker 的启动');
  writeNotStarted(box, 'forged by a Worker that did run');
  for (const exit of [0, 2]) {
    writeExit(box, exit);
    const state = await runState(box, selectProcesses());
    assert.deepEqual([state.started, state.exit, state.not_started], [true, exit, undefined], `退出码 ${exit}：伪造的证据不报给主机`);
  }
});
