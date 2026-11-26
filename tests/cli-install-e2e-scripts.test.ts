// Guards bootstrap refusals, script syntax and download defaults.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { RELEASE_URL } from '../cli/install.ts';
import { tempDir } from './cli-helpers.ts';
import { WINDOWS, SH, PS1, TAR, POWERSHELL, VERSION, run, launch, sandbox, variant, sharedArchive, pathWithoutNode } from './cli-install-e2e-fixture.ts';
import type { Ran } from './cli-install-e2e-fixture.ts';

for (const mark of ['NODE_TEST_CONTEXT', 'TYCHO_TEST_GUARD'] as const) {
  test('安装脚本：' + mark + ' 下没给 TYCHO_PREFIX 就在任何安装动作前拒绝', async (t) => {
    const s = sandbox(t);
    delete s.env.TYCHO_PREFIX;
    delete s.env.NODE_TEST_CONTEXT;
    s.env.PATH = pathWithoutNode(s.dir);
    s.env[mark] = 'child';
    let ran: Ran;
    if (mark === 'TYCHO_TEST_GUARD') ran = await s.install();
    else if (WINDOWS) {
      ran = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        '$env:TYCHO_TEST_GUARD=""; & $env:TYCHO_PS1'], { ...s.env, TYCHO_PS1: PS1 });
    } else {
      ran = await run('bash', ['-c', 'unset TYCHO_TEST_GUARD; exec bash "$1"', 'bootstrap-test', SH], s.env);
    }
    assert.notEqual(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout + ran.stderr, /TYCHO_PREFIX/);
    assert.equal(existsSync(join(s.env.HOME!, '.tycho')), false, '不能创建默认程序目录');
    assert.equal(existsSync(s.prefix), false, '没有进行安装');
  });
}

test('不带 --from 时去发布地址下载；下载不到就停下，什么都不留', async (t) => {
  const s = sandbox(t);
  const ran = await s.install();
  assert.notEqual(ran.code, 0);
  assert.equal(existsSync(join(s.prefix, 'current')), false);
  assert.deepEqual(s.versions(), []);
});

test('不是发布包的东西装不进去', async (t) => {
  const s = sandbox(t);
  const junk = join(s.dir, 'junk');
  mkdirSync(junk);
  writeFileSync(join(junk, 'package.json'), '{}');
  const ran = await s.install(junk);
  assert.notEqual(ran.code, 0);
  // Said by the script itself, before anything in the directory is run.
  assert.match(ran.stdout + ran.stderr, WINDOWS ? /is not a tycho release/ : /不是 tycho 的发布包/);
  assert.equal(existsSync(join(s.prefix, 'current')), false);
  assert.deepEqual(s.versions(), []);
});

// ---- The script this machine cannot run ----

const has = (program: string): boolean => spawnSync(program, ['--version'], { encoding: 'utf8' }).status === 0;

test('install.sh：语法能过 bash 的检查，换行是 LF', { skip: has('bash') ? false : '这台机器上没有 bash' }, () => {
  const checked = spawnSync('bash', ['-n', SH], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  assert.doesNotMatch(readFileSync(SH, 'utf8'), /\r/, 'bash 读不了 CRLF');
});

test('install.ps1：语法能过 PowerShell 的解析，只含 ASCII', { skip: WINDOWS || has('pwsh') ? false : '这台机器上没有 PowerShell' }, (t) => {
  const script = `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:TYCHO_PS1, [ref]$null, [ref]$errors); $errors | ForEach-Object { Write-Output $_.Message }; exit $errors.Count`;
  const checked = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, TYCHO_PS1: PS1 } });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test('install.ps1 只含 ASCII：它可能被按别的编码读', () => {
  assert.match(readFileSync(PS1, 'utf8'), /^[\x09\x0a\x0d\x20-\x7e]*$/);
});

test('三处默认下载地址是同一个', () => {
  assert.ok(readFileSync(SH, 'utf8').includes(`TYCHO_RELEASE_URL:-${RELEASE_URL}}`));
  assert.ok(readFileSync(PS1, 'utf8').includes(`else { '${RELEASE_URL}' }`));
});

// For the script this machine cannot run, what the tests above establish by running.
test('两个脚本：最低 Node 版本不写在脚本里；校验文件默认取自 nodejs.org，不跟着镜像走', () => {
  const sh = readFileSync(SH, 'utf8');
  const ps1 = readFileSync(PS1, 'utf8');
  const OFFICIAL = 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt';
  assert.ok(sh.includes(`TYCHO_NODE_SUMS_URL:-${OFFICIAL}}`));
  assert.ok(ps1.includes(`else { '${OFFICIAL}' }`));
  for (const script of [sh, ps1]) {
    assert.doesNotMatch(script, /(NODE_DIST_URL|NodeDistUrl)[^\n]*SHASUMS256/, '校验文件不该从镜像的地址拼出来');
    assert.doesNotMatch(script, /MIN_NODE(_MAJOR)?=["']?\d|\$MinNode(Major)?\s*=\s*['"]?\d/, '最低版本只在 package.json 里声明');
    assert.match(script, /engines\.node/);
  }
});
