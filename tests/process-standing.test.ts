// Guards against treating an unverifiable process as exited or confusing another process for ours.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { processStartLater } from '../service/lock.ts';
import { gone, standing } from './process-standing.ts';

test('回收核验：启动时刻未知不是已退出；同一个进程、另一个进程和已退出分别报告', async (t) => {
  assert.equal(await standing(process.pid, undefined), 'unverifiable');
  assert.equal(gone('unverifiable'), false);
  const start = await processStartLater(process.pid);
  if (!start) {
    t.skip('此环境无法读取本进程的启动时刻');
    return;
  }
  assert.equal(await standing(process.pid, start), 'ours');
  assert.equal(await standing(process.pid, 'a-different-start'), 'other');
  assert.equal(gone('other'), true);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, 'spawn');
  const exited = once(child, 'close');
  child.kill();
  await exited;
  assert.equal(await standing(child.pid!, undefined), 'exited');
  assert.equal(gone('exited'), true);
});
