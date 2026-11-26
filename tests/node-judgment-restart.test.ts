// Guards inventory and reclaim of a running round after host restart.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readExit } from '../node/runbox.ts';
import { isAlive } from '../service/lock.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { options, until, bench, connected, releaseFile, watchOf } from './node-judgment-fixture.ts';

test('主机停掉再起来：客户端自己重连，清点把这一轮找回来，不判丢失、不接续', options, async (t) => {
  const release = releaseFile(t);
  const b = await bench(t, { waitFile: release }, {}, { wire: true });
  b.startClient(0);
  await until(() => connected(b, 0), '机器连回来');
  const run = await until(() => b.runs().find((each) => each.state === 'running'), '这一轮跑起来');
  const box = b.box(0, run.id);
  const watch = await watchOf(box);
  const client = b.clientOf(0)!;
  assert.equal(isAlive(client.pid!), true);

  await b.stopHost();
  assert.equal(isAlive(watch.pid!), true, '主机不在，这一轮照跑（看管进程不依赖通道）');
  assert.equal(isAlive(client.pid!), true, '客户端也活着，在退避重连');

  const host = await b.restartHost();
  await until(() => connected(b, 0), '客户端回到新起来的主机');
  assert.equal(readFileSync(join(b.machines[0]!.identityDir, 'host'), 'utf8').trim(), b.origin, '机器一直用同一个地址');
  const found = await until(() => b.runs().find((each) => each.state === 'running'), '清点把这一轮找回来');
  assert.equal(found.id, run.id, '还是同一轮，没有被当成丢失');
  assert.equal(found.exit_kind, null);
  assert.deepEqual(b.runs().map((each) => each.id), [run.id], '没有接续出第二轮');
  assert.equal(host.nodes.status().connected.length, 1);

  writeFileSync(release, '');
  await until(() => readExit(box) !== null, '这一轮跑完');
});
