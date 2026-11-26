// Guards credential delivery and rejection of incomplete or invalid handovers (docs/design/nodes.md §4.2).
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HANDOVER_ENV } from '../node/client.ts';
import { readExit } from '../node/runbox.ts';
import { parseWatchArgs } from '../node/watch.ts';

import { run, machine, everyFile } from './node-watch-fixture.ts';

test('凭据经环境变量交付：Worker 在自己的环境变量里读到它，命令行、输出和这一轮的文件里都没有', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r15);
  // Where the Worker writes what reached it: outside the round's directory, which is checked whole.
  const outside = mkdtempSync(join(tmpdir(), 'tycho-watch-env-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const envFile = join(outside, 'env.json');
  const secret = 'env-credential-not-a-real-key-7f3a';
  const args = ['--credential=TYCHO_TEST_KEY'];
  const code = await m.start('t1', run.r15, 1, { env: { TYCHO_FAKE_ENV_FILE: envFile }, args, handover: { credential: secret } });
  assert.equal(code, 0);
  assert.equal(readExit(box), 0, readFileSync(join(box.runDir, 'watch.log'), 'utf8'));
  const seen = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
  assert.equal(seen.TYCHO_TEST_KEY, secret, '凭据是那个变量的值');
  assert.equal(seen[HANDOVER_ENV], undefined, '交接变量不进 Worker 的环境');
  assert.equal(args.join(' ').includes(secret), false, '看管进程的命令行上没有凭据');
  for (const name of ['stdout.ndjson', 'stderr.log']) {
    assert.equal(readFileSync(join(box.runDir, name), 'utf8').includes(secret), false, `${name} 里没有凭据`);
  }
  assert.equal(everyFile(box.taskDir).includes(secret), false, '这一轮目录的任何文件里都没有凭据');
});

test('主机给的变量名不能用：这一轮没有开工，看管进程不崩', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r16);
  const code = await m.start('t1', run.r16, 1, { args: ['--credential=BAD NAME;rm'], handover: { credential: 'x' } });
  assert.equal(code, 2, '“什么都没起”的退出码');
  assert.equal(readExit(box), 2);
  assert.match(readFileSync(join(box.runDir, 'stderr.log'), 'utf8'), /Worker 没能启动：主机给的凭据变量名不能用/);
  assert.equal(existsSync(join(box.runDir, 'stdout.ndjson')), false, 'Worker 没有被起来');
});

test('给了变量名却没拿到令牌：这一轮没有开工', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r17);
  const code = await m.start('t1', run.r17, 1, { args: ['--credential=TYCHO_TEST_KEY'] });
  assert.equal(code, 2, '“什么都没起”的退出码');
  assert.equal(readExit(box), 2);
  assert.match(readFileSync(join(box.runDir, 'stderr.log'), 'utf8'), /看管进程却没有拿到它：不开工/);
  assert.equal(existsSync(join(box.runDir, 'stdout.ndjson')), false, 'Worker 没有被起来');
});

test('拿到了令牌却不知道放进哪个变量：这一轮没有开工', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r18);
  const code = await m.start('t1', run.r18, 1, { handover: { credential: 'x' } });
  assert.equal(code, 2, '“什么都没起”的退出码');
  assert.equal(readExit(box), 2);
  assert.match(readFileSync(join(box.runDir, 'stderr.log'), 'utf8'), /看管进程拿到了令牌，却不知道放进哪个变量：不开工/);
  assert.equal(existsSync(join(box.runDir, 'stdout.ndjson')), false, 'Worker 没有被起来');
});

test('看管进程的参数：认得的照收，认不得的当场拒绝', () => {
  const parsed = parseWatchArgs(['--data=/tmp/x', '--run=tasks/a/runs/b', '--round=3', '--timeout-ms=5000', '--', 'node', 'worker.mjs']);
  assert.equal(parsed.dataDir, '/tmp/x');
  assert.equal(parsed.runDir, 'tasks/a/runs/b');
  assert.equal(parsed.round, 3);
  assert.equal(parsed.timeoutMs, 5000);
  assert.deepEqual(parsed.argv, ['node', 'worker.mjs']);
  assert.equal(parsed.credentialVariable, null);
  assert.equal(parseWatchArgs(['--data=/x', '--run=r', '--round=1', '--credential=DSH_KEY']).credentialVariable, 'DSH_KEY');
  assert.throws(() => parseWatchArgs(['--data=/x', '--run=r', '--round=1', '--credential-fd=A_FD']), /不认识的参数|credential-fd/, '旧开关不再收');
  assert.throws(() => parseWatchArgs(['--data=/tmp/x', '--run=tasks/a/runs/b']), /round/);
  assert.throws(() => parseWatchArgs(['--data=/tmp/x', '--run=tasks/a/runs/b', '--round=0']), /正整数/);
  assert.throws(() => parseWatchArgs(['--data=/tmp/x', '--run=tasks/a/runs/b', '--round=1', 'oops']), /不认识的参数/);
});

// The local limit is what ends a round whose host cannot be reached. The host has the same
// limit; this one is the backstop (nodes.md §4.4).
