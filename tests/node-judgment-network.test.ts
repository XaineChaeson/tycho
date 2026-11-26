// Guards reclaim of a running round after a network cut.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readExit } from '../node/runbox.ts';
import { isAlive } from '../service/lock.ts';
import { options, until, bench, connected, releaseFile, watchOf } from './node-judgment-fixture.ts';

test('断网：主机还在，机器连不上；接回来就问现场，不重发也不另起', options, async (t) => {
  const release = releaseFile(t);
  const b = await bench(t, { waitFile: release }, {}, { wire: true });
  b.startClient(0);
  await until(() => connected(b, 0), '机器连回来');
  const run = await until(() => b.runs().find((each) => each.state === 'running' || each.state === 'unknown'), '这一轮跑起来');
  const box = b.box(0, run.id);
  const watch = await watchOf(box);

  b.wire!.cut();
  await until(() => !connected(b, 0), '主机不再当它连着');
  await until(() => b.runs().find((each) => each.state === 'unknown'), '这一轮被记为未知', 15_000);
  assert.equal(isAlive(watch.pid!), true, '断网期间这一轮照跑（到本轮时限或本地停止条件为止）');
  await until(() => /连不上主机/.test(b.logOf(0)), '客户端在退避重连');

  b.wire!.mend();
  await until(() => connected(b, 0), '机器重新连回来');
  const again = await until(() => b.runs().find((each) => each.state === 'running'), '同一轮被认领回来');
  assert.equal(again.id, run.id);
  assert.equal(b.runs().length, 1, '同一台机器上只有过这一轮');
  assert.equal(readExit(box), null, '这一轮还在跑');
  assert.equal(isAlive(watch.pid!), true, '看管进程一直在，断网没有把它当成结束');
});
