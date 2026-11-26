// Guards the one-shot gate, early stop, supersession, worker exit evidence, and environment isolation (docs/design/nodes.md ?4.2).
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HANDOVER_ENV } from '../node/client.ts';
import { subtree } from '../node/hostprocess.ts';
import { readExit, readLeft, readWatchEvidence, requestStop } from '../node/runbox.ts';
import { workerEnv } from '../node/watch.ts';
import { parseWindowsTable } from '../service/procinfo.ts';
import { git } from './git-repo.ts';

import { run, machine } from './node-watch-fixture.ts';

test('一轮正常跑完：Worker 的退出码和它留下的东西都记在这一轮里', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r1);
  const code = await m.start('t1', run.r1, 1, { env: { TYCHO_FAKE_EXIT: '4' } });
  assert.equal(code, 0, '看管进程自己正常结束');
  assert.equal(readExit(box), 4, '记下的是 Worker 的退出码');
  assert.ok(['none', 'unverified'].includes(readLeft(box)!), `留下的进程记录成 ${readLeft(box)}`);
  const pid = readWatchEvidence(box).pid;
  assert.ok(Number.isInteger(pid) && pid! > 0, '看管进程登记了自己的 pid');
  assert.match(readFileSync(join(box.runDir, 'stdout.ndjson'), 'utf8'), /节点上这一轮跑完了/, 'Worker 的输出写在这一轮里');
  assert.ok(existsSync(join(box.taskDir, 'rounds', '1')), '轮次标记留下了');
});

// The process the round's own evidence is read from is this machine's, not the round's: a
// query of the table is a child of whoever asked, and counting it would make every round on
// Windows look as if it had left something running behind it (nodes.md §4.3).
test('查询进程自己不算这一轮的残留', () => {
  // The first line is the query's own pid (101), and it is a row of the table it printed.
  const table = parseWindowsTable('101\n100 1\n101 100\n');
  assert.deepEqual(subtree(table, 100), [100], '看管进程查自己的时候，那个查询进程不在下面');
  // Without that line the query is a row like any other, and this is the shape of the bug.
  assert.deepEqual(subtree(parseWindowsTable('100 1\n101 100\n'), 100), [100, 101]);
});

test('闸门只认第一次：同一个目录不会被启动第二次', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r2);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  const code = await m.start('t1', run.r2, 1);
  assert.equal(code, 3, '闸门已经被占，什么都没起');
  assert.equal(existsSync(join(box.runDir, 'exit')), false, '它没有写退出码：这一轮不是它的');
});

test('开始之前就有停止标记：什么都不起', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r3);
  mkdirSync(box.runDir, { recursive: true });
  requestStop(box);
  const code = await m.start('t1', run.r3, 1);
  assert.equal(code, 4);
  assert.equal(existsSync(join(box.runDir, 'stdout.ndjson')), false, 'Worker 没有被起来');
});

test('任务里已经有更后一轮：这一轮不启动，退出码 86', async (t) => {
  const m = machine(t);
  const box = m.box('t1', run.r4);
  mkdirSync(join(box.taskDir, 'rounds'), { recursive: true });
  writeFileSync(join(box.taskDir, 'rounds', '2'), '');
  const code = await m.start('t1', run.r4, 1);
  assert.equal(code, 6, '迟到的一轮不启动');
  assert.equal(readExit(box), 86, '这一轮的结束语是“被后一轮顶掉”');
});

test('Worker 的环境：带上轮次标记，不带看管进程手上的交接', () => {
  // What the client hands the watch in its environment, and what the Worker must not see.
  const inherited = { PATH: '/usr/bin', [HANDOVER_ENV]: '{"env":{"A":"1"},"credential":"秘密"}', KEEP: 'x' };
  const options = { env: { A: '1' }, credentialVariable: 'CLAUDE_CODE_OAUTH_TOKEN', credential: '秘密' };

  const withoutCredential = workerEnv(inherited, { env: { A: '1' }, credentialVariable: null }, 'r1');
  assert.equal(withoutCredential[HANDOVER_ENV], undefined, '看管进程手上的交接不进 Worker 的环境');
  assert.equal(withoutCredential.KEEP, 'x');
  assert.equal(withoutCredential.A, '1');
  assert.equal(withoutCredential.TYCHO_RUN, 'r1', '每个进程都带着这一轮的标记');
  assert.equal(withoutCredential.GIT_TERMINAL_PROMPT, '0', '没人看着这一轮：git 要不到凭据就失败，不等人');
  assert.equal(withoutCredential.GCM_INTERACTIVE, 'never');
  assert.equal(withoutCredential.SSH_ASKPASS_REQUIRE, 'never');
  assert.equal(workerEnv({}, { env: { GIT_TERMINAL_PROMPT: '1' }, credentialVariable: null }, 'r5').GIT_TERMINAL_PROMPT, '0', '主机下发的也盖不掉');

  const withCredential = workerEnv(inherited, options, 'r2');
  assert.equal(withCredential[HANDOVER_ENV], undefined);
  assert.equal(withCredential.CLAUDE_CODE_OAUTH_TOKEN, '秘密', '凭据是声明的那个变量的值');

  // An executor that reads its key from nowhere else gets it the same way; the handover still
  // does not reach it.
  const asValue = workerEnv(inherited, { env: { A: '1' }, credentialVariable: 'DSH_KEY', credential: '秘密' }, 'r3');
  assert.equal(asValue.DSH_KEY, '秘密');
  assert.equal(asValue[HANDOVER_ENV], undefined);
  // The host's own env cannot put something else in that variable's place.
  assert.equal(workerEnv(inherited, { env: { DSH_KEY: 'other' }, credentialVariable: 'DSH_KEY', credential: '秘密' }, 'r4').DSH_KEY, '秘密');
});
