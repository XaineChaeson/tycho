// Guards the local deadline ending a real Worker and recording its exit (docs/design/nodes.md §4.2).
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HANDOVER_ENV } from '../node/client.ts';
import { readExit, readLeft } from '../node/runbox.ts';

import { FAKE, WATCH, run, until, machine } from './node-watch-fixture.ts';

test('到本地时限：Worker 被结束，退出码照记', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r5);
  // A Worker that would outlive the test: the watch's own limit has to end it.
  const child = spawn(process.execPath, [
    WATCH, `--data=${m.dataDir}`, `--run=tasks/t1/runs/${run.r5}`, '--round=1', '--timeout-ms=1500', '--',
    process.execPath, FAKE,
  ], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, TYCHO_FAKE_WAIT_FILE: join(tmpdir(), 'never-appears-tycho'), [HANDOVER_ENV]: '{}' },
  });
  const code = await new Promise<number>((resolve) => child.once('exit', (value) => resolve(value ?? -1)));
  assert.equal(code, 0);
  await until(() => existsSync(join(box.runDir, 'exit')), '这一轮写下退出码');
  assert.notEqual(readExit(box), 0, '被时限结束的一轮不是正常结束');
  assert.ok(['none', 'unverified'].includes(readLeft(box)!));
});
