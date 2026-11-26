// A child with a deliberately minimal environment must not leave PowerShell's cache in cwd.
import './guard.ts';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';

test('子进程缺少 LOCALAPPDATA 时使用本次测试的临时目录，明确指定的值不变', () => {
  const read = (env: NodeJS.ProcessEnv) => {
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.LOCALAPPDATA || "")'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const supplied = join(process.env.TYCHO_TEST_EXECUTOR_HOMES!, 'explicit');
  assert.equal(read({ LOCALAPPDATA: supplied }), supplied);
  const missing = read({});
  if (process.platform === 'win32') assert.equal(missing, join(process.env.TYCHO_TEST_EXECUTOR_HOMES!, 'localappdata'));
  else assert.equal(missing, '');
});

// Windows PowerShell builds its module analysis cache path out of the local app data folder
// the shell answers for, and the answer is empty while <home>\AppData\Local is missing: the
// path is relative then, and the cache is written into the process's working directory —
// under `npm test`, the repository. A test points a child's home away from the owner's, and
// often at one that was never made; the guard makes the directory it needs.
test('Windows：子进程的主目录少了 AppData\\Local 就补上，PowerShell 的缓存才不会写进工作目录', { skip: process.platform !== 'win32' && '只有 Windows 的 PowerShell 按本机的 LocalApplicationData 放模块缓存' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-guard-home-'));
  try {
    const home = join(root, 'no-home');
    const cwd = join(root, 'cwd');
    mkdirSync(cwd);
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const answer = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('LocalApplicationData')"], {
      cwd,
      env: { ...process.env, USERPROFILE: home },
      encoding: 'utf8',
    });
    assert.equal(answer.status, 0, answer.stderr);
    assert.ok(isAbsolute(answer.stdout.trim()), `PowerShell 的缓存目录还是相对的，会写进工作目录：${JSON.stringify(answer.stdout)}`);
    assert.equal(existsSync(join(cwd, 'Microsoft')), false, '工作目录里不留 PowerShell 的模块缓存');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
