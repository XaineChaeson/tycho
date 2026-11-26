// Guards against §11 group 3: a result applied twice, a result of an old revision moving
// the Task, a Task abandoned with its executor alive, and a late result reviving a closed
// Task. End to end: real ledger, fake CLI, fake instance, HTTP; a crash on each side of
// the commit.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { signIn, stage, until } from './stage.ts';

const options = { timeout: 90_000 };
const SENTENCE = '结果只应用一次，旧结果只留历史';
const FLOOR = '底线“原子单次结算”';
const DONE = { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] };

function settlements(service: Awaited<ReturnType<ReturnType<typeof stage>['start']>>, taskId: string) {
  const changes = service.ledger.listChanges({ taskId }).map(({ action }) => action);
  return {
    settled: changes.filter((action) => action === 'run.settle').length,
    late: changes.filter((action) => action === 'run.settle_late').length,
  };
}

test(`${SENTENCE}（结算提交前崩溃）`, options, async (t) => {
  const { remote, start, crashAt, wreck, queued, launched } = stage(t);
  const first = await start();
  const task = queued(first);
  const run = await launched(first, task);
  const crashed = crashAt('run.settle', 'before');
  remote.finish(run.id, DONE);
  await crashed;
  await wreck(first);

  const service = await start();
  assert.equal(service.ledger.getRun(run.id).exit_kind, 'completed', '§5.6：崩溃时没提交的结算，重启后要由核实补上');
  assert.equal(service.ledger.getTask(task.id).state, 'ready');
  assert.deepEqual(settlements(service, task.id), { settled: 1, late: 0 }, `${FLOOR}：结算不是恰好一次`);
});

test(`${SENTENCE}（结算提交后崩溃，再来一次结算）`, options, async (t) => {
  const { remote, start, crashAt, wreck, queued, launched } = stage(t);
  const first = await start();
  const task = queued(first);
  const run = await launched(first, task);
  const crashed = crashAt('run.settle', 'after');
  remote.finish(run.id, DONE);
  await crashed;
  await wreck(first);

  const service = await start();
  assert.deepEqual(settlements(service, task.id), { settled: 1, late: 0 }, `${FLOOR}：重启把结算过的 Run 又结算了`);
  assert.deepEqual(service.ledger.settleRun(run.id, 1, { status: 'failed', summary: '迟到的' }), { late: true, reason: 'run_ended' });
  assert.equal(service.ledger.getRun(run.id).exit_kind, 'completed', `${FLOOR}：重复结算改了结果`);
  assert.match(service.ledger.getRun(run.id).receipt_json ?? '', /完成/);
  assert.match(service.ledger.getRun(run.id).error_json ?? '', /迟到的/, '迟到的结果要留作历史');
  assert.equal(service.ledger.getTask(task.id).state, 'ready');
});

for (const when of ['before', 'after'] as const) {
  test(`${SENTENCE}（旧修订的结果，${when === 'before' ? '提交前' : '提交后'}崩溃）`, options, async (t) => {
    const { dataDir, remote, start, stop, crashAt, wreck, queued, launched } = stage(t);
    const first = await start();
    const task = queued(first);
    const run = await launched(first, task);
    await stop(first);
    // The public operations refuse this while a Run is active, which is why it takes a
    // restored ledger or a bug to get here; settlement must hold regardless.
    const conn = new DatabaseSync(join(dataDir, 'ledger.db'));
    conn.prepare('UPDATE task SET revision = 2 WHERE id = ?').run(task.id);
    conn.close();
    remote.finish(run.id, DONE);

    const crashed = crashAt('run.settle_late', when);
    const second = await start({ dispatchIntervalMs: 60_000 }).catch(() => undefined);
    await crashed;
    await wreck(second);

    const service = await start({ dispatchIntervalMs: 60_000 });
    const after = service.ledger.getTask(task.id);
    assert.equal(after.state, 'held', `底线“修订绑定”：旧修订的结果推进了 Task`);
    assert.equal(after.reason, '执行结果属于旧修订');
    assert.equal(after.revision, 2);
    assert.match(service.ledger.getRun(run.id).receipt_json ?? '', /完成/, '旧结果要留在 Run 上作历史');
    assert.deepEqual(settlements(service, task.id), { settled: 0, late: 1 });
  });

  test(`${SENTENCE}（放弃任务，${when === 'before' ? '提交前' : '提交后'}崩溃）`, options, async (t) => {
    const { remote, start, crashAt, wreck, queued, launched } = stage(t);
    const first = await start();
    const task = queued(first);
    const run = await launched(first, task);
    const client = await signIn(first);

    const refused = await client.post(`/api/tasks/${task.id}/abandon`, { reason: '不要了' });
    assert.equal(refused.status, 400, '§4：执行者没停就放弃了任务');
    assert.equal(remote.runOf(run.id).pid_alive, true);
    assert.equal((await client.post(`/api/tasks/${task.id}/interrupt`)).status, 200);
    await until(() => first.ledger.getRun(run.id).exit_kind === 'interrupted', '先停下');

    const crashed = crashAt('task.abandon', when);
    assert.equal((await client.post(`/api/tasks/${task.id}/abandon`, { reason: '不要了' })).status, 503);
    await crashed;
    await wreck(first);

    const service = await start();
    const expected = when === 'before' ? 'held' : 'abandoned';
    assert.equal(service.ledger.getTask(task.id).state, expected, '没确认的放弃只能是没发生或已发生，不能是半截');
    assert.deepEqual(service.ledger.settleRun(run.id, 0, DONE), { late: true, reason: 'run_ended' });
    assert.equal(service.ledger.getTask(task.id).state, expected, `${FLOOR}：迟到的结果救活了任务`);
    assert.deepEqual(settlements(service, task.id).settled, 1);
  });
}
