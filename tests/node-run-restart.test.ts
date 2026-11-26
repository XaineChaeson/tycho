// Guards docs/design/nodes.md §4.2 and §7: a client that goes away in the middle of a round
// loses nothing. The watch process owns the round from the gate on, and what proves it is
// the evidence written under the machine's own data directory — the pid and the moment it
// began, never a pid beside the round's shared material.
//
// What this file is here to catch:
//   - a round that stops when the client that started it is replaced: it must go on, because
//     the watch process and the Worker are not that client's children any more,
//   - a replacement client that starts the round again instead of reading the one that is
//     there (the gate was taken once, and the evidence says whose the round is),
//   - a machine's own record of the round's processes going missing or being written where
//     the host could read it,
//   - and a round read to its end by the new client: the same round, settled once.
//
// A client replaced inside this test: its polling stops and a new client is made on the same
// data directory. That is what a restart looks like from the round's side. Killing the
// client's own OS process is the real-machine acceptance of nodes.md §11, and is not
// claimed here.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { boxOf, readWatchEvidence } from '../node/runbox.ts';
import { isAlive } from '../service/lock.ts';
import { MACHINE_TABLE_MS, bench, options, tableReadable, until } from './node-run-fixture.ts';

// The look this case waits on is a whole process-table read (node/hostprocess.ts).
void tableReadable();

test('换一个客户端：正在跑的一轮不停，新的客户端清点后接着读', options, async (t) => {
  if (!(await tableReadable())) {
    t.skip('这一条要读回一轮的结束，属于读不到进程表的机器上做不到的那种核实');
    return;
  }
  const release = join(tmpdir(), `tycho-release-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(release, { force: true }));
  const b = await bench(t, { waitFile: release });
  const run = await until(() => b.host.ledger.listRuns(b.taskId).find((each) => each.state === 'running'), '这一轮跑起来');

  // The client goes away, as an upgrade or a crash looks from here. The watch process and
  // the Worker are not its children any more.
  await b.stopClients();
  const box = boxOf(b.nodeDir, `.tycho/tasks/${b.taskId}/runs/${run.id}`);
  // The keeper of this round is the watch process, and what proves it is the evidence the
  // watch wrote for this machine under its own data directory — pid and start moment, never
  // a pid beside the round's shared material (nodes.md §7). It is written before the Worker
  // starts, so a round the host has seen as running has it.
  const watch = readWatchEvidence(box);
  assert.ok(Number.isInteger(watch.pid) && watch.pid! > 0, '看管进程的 pid 还在文件里');
  assert.ok(watch.at, '看管进程的启动时刻也在，pid 被重用也认得出来');
  assert.equal(isAlive(watch.pid!), true, '看管进程自己还在跑，不是只留下一个文件');

  // The next client reads the same round and goes on reading it; it starts nothing.
  const again = b.restarted();
  const state = (await again.execute({ id: 'x', kind: 'state', run_dir: `tasks/${b.taskId}/runs/${run.id}` })) as {
    pid_alive: boolean; exit: number | null; unknown: string | null;
  };
  assert.equal(state.pid_alive, true, '清点看到这一轮还在跑');
  assert.equal(state.exit, null);
  assert.equal(state.unknown, null);

  writeFileSync(release, '');
  const ended = await until(() => b.host.ledger.listRuns(b.taskId).find((each) => each.state === 'ended'), '这一轮被读到底', MACHINE_TABLE_MS);
  assert.equal(ended.id, run.id, '还是同一轮，没有新起一轮');
  assert.equal(ended.exit_code, 0);
});
