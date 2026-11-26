// Guards docs/design/nodes.md §11 step 1 end to end: one real round of a Task runs on a
// machine that came back by itself, over the node channel, with no SSH anywhere.
//
// What this file is here to catch:
//   - a round that starts, writes its output and settles with nothing asked for twice (the
//     gate is a one-shot, and a start is never sent a second time),
//   - the snapshot actually landing on the machine, and the round's evidence being written
//     where the machine's own data directory says,
//   - and the receipt the Worker wrote being read back off the machine and settled onto
//     the Task, which then waits for the owner.
//
// The host is a real service (real ledger, real HTTP, real dispatcher); the machine is a
// real client in this process talking to that service over HTTP; the Worker is a real
// child process (tests/fake-executor.mjs). The only thing stood in is the executor's own
// command line, which no test may run for real. The case that needs a round to *settle* is
// skipped where the process table cannot be read: the real-machine acceptance of §11 (one
// Windows workstation, one Linux instance) is where that is proved, and it is still owed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boxOf, readExit, readLeft } from '../node/runbox.ts';
import { MACHINE_TABLE_MS, bench, options, tableReadable, until, workerAdapter } from './node-run-fixture.ts';

// A node bench must never start the owner's Claude Code or route with the fake Worker's token.
test('节点夹具使用未登录的假负责人，Worker 不能当负责人', options, async (t) => {
  assert.equal(workerAdapter({}).canRoute, false);
  const b = await bench(t, {}, {}, { hold: true });
  const error = await until(() => b.host.session.status().error, '假负责人报告未登录');
  assert.match(error, /负责人用的 Claude 没有登录/);
  assert.equal(b.host.session.status().alive, false);
});

// The look this file's cases wait on is a whole process-table read (node/hostprocess.ts).
// Started here, where it runs beside the case that does not need it, rather than in the
// first case that does.
void tableReadable();

test('一轮在节点通道上跑完：快照落地、看管进程起 Worker、回执结算', options, async (t) => {
  if (!(await tableReadable())) {
    t.skip('这台机器读不到进程表：残留没法核实，这一轮按未知处理，不能按完成结算（见下一条测试）');
    return;
  }
  const b = await bench(t);
  const run = await until(() => b.host.ledger.listRuns(b.taskId).find((each) => each.state === 'ended'), '这一轮结算', MACHINE_TABLE_MS);
  assert.equal(run.exit_code, 0, `退出码应是 0，实际 ${run.exit_code}（${run.error_json ?? ''}）`);
  assert.equal(run.exit_kind, 'completed');
  const receipt = JSON.parse(run.receipt_json!) as { summary: string };
  assert.equal(receipt.summary, '节点上这一轮跑完了', '回执从机器上读了回来');

  // The snapshot is on the machine, and the round's evidence is under its own data
  // directory — the host never learned where that is.
  const box = boxOf(b.nodeDir, `.tycho/tasks/${b.taskId}/runs/${run.id}`);
  assert.match(readFileSync(join(box.runDir, 'snapshot', 'brief.md'), 'utf8'), /节点跑一轮/, '这一轮的 brief 写在机器的数据目录里');
  assert.equal(readExit(box), 0, '看管进程把 Worker 的退出码写了下来');
  // Whether anything survived the round is recorded with it. A machine that can read its
  // process table (or its own process group) says `none`; one that cannot says
  // `unverified`, which is not "nothing was left" — and never `some` here.
  assert.notEqual(readLeft(box), 'some', '这一轮没有留下进程');
  assert.equal(existsSync(join(box.runDir, 'stdout.ndjson')),false,'captured output does not create an unbounded raw spool');
  assert.equal(JSON.parse(b.host.ledger.getRun(run.id).capture_result_json!).disposition,'adopted','formal receipt and result custody commit before release');
  assert.ok(box.runDir.startsWith(b.nodeDir));

  // Nothing of it ran twice: one round, one start, one watch.
  assert.equal(b.host.ledger.listRuns(b.taskId).length, 1);
  const task = b.host.ledger.getTask(b.taskId);
  assert.equal(task.state, 'ready', `任务应当等主人验收，实际 ${task.state}：${task.reason ?? ''}`);
});
