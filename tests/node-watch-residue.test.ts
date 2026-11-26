// Guards the deadline cleaning descendants and the watch retaining control until residue is recorded (docs/design/nodes.md §4.2).
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAlive } from '../service/lock.ts';
import { HANDOVER_ENV } from '../node/client.ts';
import { readExit, readLeft } from '../node/runbox.ts';
import { workerOwnGroup } from '../node/watch.ts';

import { FAKE, WATCH, RESIDUE_CHILD, run, until, canReadProcessTable, machine } from './node-watch-fixture.ts';

test('本地时限结束的一轮：Worker 留下的进程一起结束，不留给下一轮', async (t) => {
  if (!(await canReadProcessTable())) {
    t.skip('这台机器读不到进程表：找不到 Worker 留下的进程，这一轮如实记成“没核实”（不能记成清干净了）');
    return;
  }
  const m = machine(t);
  const box = m.box('t1', run.r6);
  const leak = join(m.dataDir, 'leak.log');
  const child = spawn(process.execPath, [
    WATCH, `--data=${m.dataDir}`, `--run=tasks/t1/runs/${run.r6}`, '--round=1', '--timeout-ms=3000', '--',
    process.execPath, FAKE,
  ], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, TYCHO_FAKE_LEAK: leak, TYCHO_FAKE_WAIT_FILE: join(tmpdir(), 'never-appears-tycho'), [HANDOVER_ENV]: '{}' },
  });
  const code = await new Promise<number>((resolve) => child.once('exit', (value) => resolve(value ?? -1)));
  assert.equal(code, 0);
  const leaked = Number(readFileSync(`${leak}.pid`, 'utf8').trim());
  assert.ok(leaked > 0, 'Worker 起了那个会一直写下去的进程');
  await until(() => !isAlive(leaked), '留下的进程被结束');
  assert.equal(readLeft(box), 'none', '核实之后记的是“什么都没留下”');
});

// The Worker has exited and what it left takes a second look to be gone: the wait before
// that look is all that holds the watch process then. It finishes the look and writes the
// record and the code; a wait that lets the process end leaves a round with neither, and
// the host reads a Worker that exited 0 as a round that was lost.
test('Worker 退出后还要等残留核实：看管进程等完再走，退出码一定写下', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r14);
  const child = spawn(process.execPath, [RESIDUE_CHILD, m.dataDir, `tasks/t1/runs/${run.r14}`, FAKE], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, [HANDOVER_ENV]: '{}' },
  });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  assert.equal(readExit(box), 0, readFileSync(join(box.runDir, 'watch.log'), 'utf8'));
  assert.equal(readLeft(box), 'none', '第三次核实看到清干净了，记的是 none');
});

// Where the system has process groups, the Worker leads one of its own: that is what makes a
// stop reach what a Worker started after the watch process is gone (nodes.md §4.3, §4.4).
test('Worker 有自己的进程组：这一轮结束得掉整组', () => {
  assert.equal(workerOwnGroup('linux'), true);
  assert.equal(workerOwnGroup('darwin'), true);
  assert.equal(workerOwnGroup('win32'), false, 'Windows 上没有进程组，靠父链接和 taskkill /T');
});
