// Guards what a round's ending is settled on: the machine's own evidence about it, read
// where the machine wrote it (docs/design/nodes.md §4.3). A Worker's exit code is the
// Worker's, and a machine that cannot read its own process table says so about what the
// round left behind rather than claiming nothing was left.
//
// What this file is here to catch:
//   - a Worker that ends with a non-zero code being settled with that code, not rewritten
//     into a success and not read off anything but the machine,
//   - a round on a machine that cannot read its process table recording `unverified` for
//     what survived it, rather than `none` — which would claim something the machine cannot
//     know,
//   - the state question answering the exit code it did read and saying plainly that the
//     residue could not be checked,
//   - and the host leaving such a round unknown instead of settling it as finished.
//
// The two cases are the two answers this machine can give: they are skipped where the
// machine's process table is the other one, and either way the file carries one round.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxOf, readExit, readLeft } from '../node/runbox.ts';
import { MACHINE_TABLE_MS, bench, options, tableReadable, until } from './node-run-fixture.ts';

// The look both cases turn on is a whole process-table read (node/hostprocess.ts). Started
// here, where it runs beside the case that is about the machine not managing it at all.
void tableReadable();

test('Worker 以非零退出：这一轮按它的退出码结算，回执照读', options, async (t) => {
  if (!(await tableReadable())) {
    t.skip('这一条要读回一轮的结束，属于读不到进程表的机器上做不到的那种核实');
    return;
  }
  const b = await bench(t, { exit: 3 });
  const run = await until(() => b.host.ledger.listRuns(b.taskId).find((each) => each.state === 'ended'), '这一轮结算', MACHINE_TABLE_MS);
  assert.equal(run.exit_code, 3, '退出码是机器上那个，没有被改写');
  assert.equal(run.exit_kind, 'failed');
  const box = boxOf(b.nodeDir, `.tycho/tasks/${b.taskId}/runs/${run.id}`);
  assert.equal(readExit(box), 3);
});

test('读不到进程表的机器：一轮跑完也不按成功结算，如实报未知', options, async (t) => {
  if (await tableReadable()) {
    t.skip('这台机器读得到进程表：这一条走的是读不到的那条路');
    return;
  }
  const b = await bench(t, {});
  // The Worker answered and left, and the watch wrote the code. Whether anything survived it
  // could not be read, so what this machine says about the round's processes is "unknown" —
  // and a success is not settled on the strength of the exit code (nodes.md §4.3).
  const box = await until(() => {
    const run = b.host.ledger.listRuns(b.taskId).at(-1);
    if (!run) return undefined;
    const held = boxOf(b.nodeDir, `.tycho/tasks/${b.taskId}/runs/${run.id}`);
    return readExit(held) === 0 ? held : undefined;
  }, '看管进程写下了退出码', MACHINE_TABLE_MS);
  assert.equal(readLeft(box), 'unverified', '残留核实不了，就记成核实不了');

  const state = (await b.client.execute({ id: 'c1', kind: 'state', run_dir: `tasks/${b.taskId}/runs/${box.runId}` })) as {
    exit: number | null; unknown: string | null;
  };
  assert.equal(state.exit, 0, '退出码是读得到的');
  assert.match(String(state.unknown), /读不到进程表/, '残留没核实就说没核实');

  const settled = b.host.ledger.listRuns(b.taskId).find((each) => each.state === 'ended');
  assert.equal(settled, undefined, '没有核实的成功不是成功：这一轮还悬着，页面显示未知');
});
