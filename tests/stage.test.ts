// Guards against the crash facility itself: an injection that lands during a start, before
// startService has returned anything to close, leaving the connection open, so that the
// "crash" keeps writing and every acceptance case built on it tests a kinder failure than
// a killed process.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Crash, stage, until } from './stage.ts';

const options = { timeout: 60_000 };
const USER = { actor: 'test' };

function lastChange(dataDir: string): { seq: number; action: string } {
  const conn = new DatabaseSync(join(dataDir, 'ledger.db'));
  try {
    return conn.prepare('SELECT seq, action FROM change ORDER BY seq DESC LIMIT 1').get() as { seq: number; action: string };
  } finally {
    conn.close();
  }
}

test('提交后崩溃打在启动中途的清点上：连接立刻废弃，收尾写不进任何东西', options, async (t) => {
  const { dataDir, remote, start, stop, crashAt, wreck, queued, launched } = stage(t);
  const first = await start();
  const run = await launched(first, queued(first));
  await stop(first);

  remote.finish(run.id, { status: 'done', summary: '好了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  const crashed = crashAt('run.settle', 'after');
  await assert.rejects(start(), Crash);
  await crashed;
  const { action } = lastChange(dataDir);
  assert.equal(action, 'run.settle', '崩溃之后不能再有 change 落库');
  await wreck();
});

test('提交后崩溃打在启动返回前的首轮派发上：其后的写入必定失败，不新增 change', options, async (t) => {
  const { dataDir, start, stop, crashAt, wreck, queued } = stage(t);
  const first = await start({ dispatchIntervalMs: 60_000 });
  await stop(first);
  const parked = await start({ dispatchIntervalMs: 60_000 });
  const task = queued(parked, '排队的');
  await stop(parked);

  const crashed = crashAt('run.create', 'after');
  // dispatcher.start() runs the first round before it returns, and startService after it.
  const service = await start({ dispatchIntervalMs: 60_000 });
  await crashed;
  const before = lastChange(dataDir);
  assert.equal(before.action, 'run.create');
  assert.equal(service.ledger.dispatchConditions().paused, null, '连接要真的废弃，不只是写不进去');
  assert.throws(() => service.ledger.setPause(true, USER));
  assert.throws(() => service.ledger.holdTask(task.id, '不该写进去', USER));
  service.session.kick();
  await until(() => service.session.status().turn === null, '负责人空闲');
  assert.deepEqual(lastChange(dataDir), before, '废弃的连接还写进了 change');
  await wreck(service);
  assert.deepEqual(lastChange(dataDir), before, '崩溃之后的收尾还写进了 change');
});

test('降级恢复也不能让崩溃后的服务重新写进去', options, async (t) => {
  const { dataDir, start, crashAt, wreck, queued, launched } = stage(t);
  const first = await start();
  const task = queued(first);
  await launched(first, task);
  const crashed = crashAt('input.add', 'before');
  assert.throws(() => first.ledger.addInput(task.id, '崩溃点', USER));
  await crashed;
  const before = lastChange(dataDir);
  // Longer than the service's recovery interval, which reopens the connection.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(first.ledger.dispatchConditions().degraded, true);
  await wreck(first);
  assert.deepEqual(lastChange(dataDir), before);
});

// fake-claude.mjs commits each record with a newline. Both readers share that boundary.
test('fake log readers wait for the newline of a partial trailing record', t => {
  const scene = stage(t), path = join(scene.dataDir, 'fake.log');
  const first = JSON.stringify({ argv: ['qa'], user: '已提交的消息' });
  const next = JSON.stringify({ argv: ['next'], user: '尚未提交的消息' });
  const prefix = next.slice(0, -3);
  writeFileSync(path, first + '\n' + prefix);
  t.diagnostic(JSON.stringify({ committedBytes: Buffer.byteLength(first + '\n'), tailBytes: Buffer.byteLength(prefix), tailEndsWithNewline: false }));
  assert.deepEqual(scene.turnsSeen(), ['已提交的消息']);
  assert.equal(scene.routerStarts(), 1);
  appendFileSync(path, next.slice(prefix.length));
  assert.deepEqual(scene.turnsSeen(), ['已提交的消息'], 'a complete JSON value is still uncommitted without its newline');
  assert.equal(scene.routerStarts(), 1);
  appendFileSync(path, '\n');
  assert.deepEqual(scene.turnsSeen(), ['已提交的消息', '尚未提交的消息']);
  assert.equal(scene.routerStarts(), 2);
});

test('an empty fake log has no committed records and malformed complete records still fail', t => {
  const scene = stage(t), path = join(scene.dataDir, 'fake.log');
  writeFileSync(path, '');
  assert.deepEqual(scene.turnsSeen(), []);
  assert.equal(scene.routerStarts(), 0);
  writeFileSync(path, '{"user":}\n');
  assert.throws(scene.turnsSeen, SyntaxError);
  assert.throws(scene.routerStarts, SyntaxError);
});
