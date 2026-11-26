import {createOutputPool} from '../node/output-pool.ts';
import {existingIdentity} from '../node/client.ts';
import {machineScope} from '../node/runbox.ts';
import {readWatchEvidence,readWorkerEvidence} from '../node/runbox.ts';
// Guards stopping a lost old round after continuation, without duplicate logs.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readExit } from '../node/runbox.ts';
import { isAlive } from '../service/lock.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunBox } from '../node/runbox.ts';
import { options, until, bench, connected, releaseFile, watchOf, workerOf } from './node-judgment-fixture.ts';

test('客户端不在时开新轮次：旧轮次被叫停，新轮次在另一台机器上，日志各写各的', options, async (t) => {
  const release = releaseFile(t);
  const b = await bench(t, { waitFile: release });
  // Only the first machine is here: the round has nowhere else to go.
  b.startClient(0);
  await until(() => connected(b, 0), '第一台机器连回来');
  const first = await until(() => b.runs().find((each) => each.state === 'running'), '第一轮跑起来');
  assert.equal(first.machine_id, b.machines[0]!.id, '第一轮落在第一台机器上');
  const old = b.box(0, first.id);
  const watch = await watchOf(old);
  const worker = await workerOf(old);
  const originalEvidence={watch:readWatchEvidence(old),worker:readWorkerEvidence(old)};
  async function capture(at:number,run:typeof first){
    const box=b.box(at,run.id),spec=JSON.parse(run.snapshot_json).output_capture;
    const pool=createOutputPool({root:join(machineScope(b.machines[at]!.nodeDir),'output'),nodeId:existingIdentity(b.machines[at]!.nodeDir)!.id});
    const page=await until(async()=>{const value=await pool.readCapture({source:spec.source,run_dir:box.relative,stream:'stdout',offset:0,bytes:262144});if(value.state!=='range')throw Error(value.reason);return value.committed_end>0?value:undefined;},'当前source原始INIT提交');
    assert.equal(page.source,spec.source);assert.equal(page.base,0);assert.equal(page.start,0);assert.equal(page.gap,undefined);
    const raw=Buffer.from(page.base64,'base64').toString('utf8');assert.equal(raw.split('\n').filter(line=>line.includes('"subtype":"init"')).length,1,'活跃未释放source只有一份原始INIT');
    return {pool,spec,box,page};
  }
  const firstCapture=await capture(0,first);
  await b.host.runner.tail(first);const beforeHistory=await b.host.runner.eventSnapshot(first);assert.ok(beforeHistory.events.length>0,'Host已保留实际诊断历史');

  // The second machine arrives, and the first one's client is killed: the round it was
  // watching goes out of contact, is judged lost after the grace period, and is continued
  // where there is a machine that answers.
  b.startClient(1);
  await until(() => connected(b, 1), '第二台机器连回来');
  // SIGKILL, as above: a killed client, not one asked to stop.
  b.clientOf(0)!.kill('SIGKILL');
  await until(() => !connected(b, 0), '第一台机器不再连着');
  const lost = await until(() => b.runs().find((each) => each.state === 'ended'), '这一轮被判丢失');
  assert.equal(lost.id, first.id);
  assert.equal(lost.exit_kind, 'lost');
  const second = await until(() => b.runs().find((each) => each.id !== first.id && each.machine_id === b.machines[1]!.id), '接续出来的第二轮');
  assert.notEqual(second.id, first.id, '接续是另一轮');
  await until(()=>b.host.ledger.getRun(second.id).state==='running','接续Worker跑起来');
  const secondCapture=await capture(1,b.host.ledger.getRun(second.id));assert.notEqual(firstCapture.spec.source,secondCapture.spec.source,'新旧轮次有独立source');
  assert.equal((await secondCapture.pool.readCapture({source:firstCapture.spec.source,run_dir:secondCapture.box.relative,stream:'stdout',offset:0,bytes:262144})).state,'unavailable','新轮不能混读旧source');
  assert.equal(second.task_id, first.task_id, '还是同一个任务');
  assert.equal(isAlive(watch.pid!), true, '第一台机器上的看管进程还活着：它自己不知道这一轮已经被判丢了');

  // The first machine comes back. What the ledger ended while it was away is cleared on it:
  // the old round is told to stop, and its watcher ends the round by itself.
  b.startClient(0);
  await until(() => connected(b, 0), '第一台机器重新连回来');
  await until(() => existsSync(join(old.procDir, 'stop')), '旧轮次收到停止标记');
  await until(() => !isAlive(watch.pid!) || readExit(old) !== null, '旧轮次退出');
  // Two watchers on one run would show up as the Worker's own first line twice: the gate is
  // taken once, and the continuation writes in a directory of its own anyway.
  const sameProcesses = (box: RunBox): boolean =>
    JSON.stringify(readWatchEvidence(box))===JSON.stringify(originalEvidence.watch)&&JSON.stringify(readWorkerEvidence(box))===JSON.stringify(originalEvidence.worker);
  assert.equal(sameProcesses(old),true,'旧轮次仍是原来的watch和Worker，没有被第二次启动');
  assert.notEqual(old.runDir, b.box(1, second.id).runDir, '两台机器上的轮次各写各的目录');

  // Let the Worker this machine could not end finish by itself, so nothing is left behind.
  writeFileSync(release, '');
  await until(() => !isAlive(worker.pid!), 'Worker 自己退出');
  assert.equal(sameProcesses(old),true,'旧轮次退出前没有另起watch或Worker，pid和启动时刻都未变');
  const oldHistory=await b.host.runner.eventSnapshot(b.host.ledger.getRun(first.id));for(const event of beforeHistory.events)assert.ok(oldHistory.events.some(kept=>JSON.stringify(kept)===JSON.stringify(event)),'旧source授权释放后仍保留Host已收到的诊断历史');
  assert.match(oldHistory.reason??'',/失联|释放|缺口|原始|已收到/,'不假装已释放旧raw仍然完整可读');

  // The Task goes on where it can: the second round is still the one to follow.
  assert.equal(b.run()!.id, second.id);
});
