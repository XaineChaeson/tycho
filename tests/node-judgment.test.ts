// Guards client death and reclaim of the same running round.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readExit } from '../node/runbox.ts';
import { isAlive } from '../service/lock.ts';
import { writeFileSync } from 'node:fs';
import { NodeAway } from '../service/nodes.ts';
import { options, until, bench, connected, releaseFile, watchOf } from './node-judgment-fixture.ts';

test('杀掉客户端：主机当场不再当它连着，这一轮记为未知；客户端回来时重新认领，同一轮接着跑', options, async (t) => {
  const release = releaseFile(t);
  const b = await bench(t, { waitFile: release });
  b.startClient(0);
  await until(() => connected(b, 0), '机器连回来');
  // A machine that joins a moment after the host starts is offered work at once: a host
  // that had already written it off would keep the round from it for a cooldown.
  const run = await until(() => b.runs().find((each) => each.state === 'running' || each.state === 'unknown'), '这一轮跑起来', 20_000);
  const box = b.box(0, run.id);
  const watch = await watchOf(box);
  assert.equal(isAlive(watch.pid!), true, '看管进程真的在跑，不是只留下一个文件');

  // The client is killed outright. Killed inside a poll, the connection that was the whole
  // proof it was here is gone at once; killed between two polls, it is gone when the next
  // one fails to arrive within the moment one takes (service/nodes.ts). Either way a machine
  // that is not here is answered at once afterwards — not held for a command timeout, which
  // is what the dispatch around it waits on.
  // SIGKILL: the default SIGTERM is an ordinary stop to the client, not the death this
  // test is about.
  b.clientOf(0)!.kill('SIGKILL');
  await until(() => !connected(b, 0), '主机不再当它连着', 15_000);
  const asked = Date.now();
  await assert.rejects(
    () => b.host.nodes.send(b.machines[0]!.id, { kind: 'state', run_dir: `tasks/${b.taskId}/runs/${run.id}` }),
    (err: unknown) => err instanceof NodeAway,
  );
  assert.ok(Date.now() - asked < 2000, '不在的机器当场答复，不是等满了命令时限');
  // What is already in flight is the design's own backstop: a command the machine never
  // named waits for the next connection, and the caller's own limit is what answers it.
  const unknown = await until(() => b.runs().find((each) => each.state === 'unknown'), '这一轮被记为未知', 20_000);
  assert.equal(unknown.id, run.id, '还是同一轮');
  assert.equal(b.runs().length, 1, '没有因为客户端不在就另起一轮');
  assert.equal(isAlive(watch.pid!), true, '看管进程不归客户端管：客户端死了，这一轮照跑');

  // The client comes back on the same identity. What it says it has running is asked about
  // again, and the round goes back to running — nothing was lost and nothing was started.
  b.startClient(0);
  await until(() => connected(b, 0), '客户端重新连回来');
  const again = await until(() => b.runs().find((each) => each.state === 'running'), '这一轮被认领回来');
  assert.equal(again.id, run.id, '认领的是同一轮');
  assert.equal(readExit(box), null, '这一轮还没有结束');

  writeFileSync(release, '');
  await until(() => readExit(box) !== null, '这一轮跑完');
});
