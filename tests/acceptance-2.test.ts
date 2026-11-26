// Guards against §11 group 2: a second Worker started before the first one was judged
// gone, a late start outrunning a stop, a success receipt overriding a stop; and, once
// a Run is judged gone, a Task that waits for the owner instead of continuing, a
// continuation started twice or not at all across a crash, and the old Run's result
// being taken after all.
// End to end: real ledger, fake CLI, fake instances, HTTP; a crash on each side of the commit.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import { signIn, stage, LOGIN, until } from './stage.ts';

const options = { timeout: 90_000 };
const SENTENCE = '判定不在之前不重派；判定之后自动接续，旧结果不被采用；停止意图不被成功回执覆盖';
const FLOOR = '底线“旧执行判定不在之前不重派”';
const NEVER = 24 * 60 * 60 * 1000;
// An account: any machine with its executor may take its rounds, here two of them.
const ACCOUNT = { t1: { id: 't1', name: 't1', executor: 'claude', tiers: LOGIN.tiers } };
const TWO_MACHINES = ['h1', 'h2'];

// What a killed service left in the file, read the way the next start will.
function committed(dataDir: string, task: TaskRow): { task: TaskRow; runs: RunRow[] } {
  const db = new DatabaseSync(join(dataDir, 'ledger.db'), { readOnly: true });
  try {
    return {
      task: db.prepare('SELECT * FROM task WHERE id = ?').get(task.id) as unknown as TaskRow,
      runs: db.prepare('SELECT * FROM run WHERE task_id = ? ORDER BY rowid').all(task.id) as unknown as RunRow[],
    };
  } finally {
    db.close();
  }
}

for (const when of ['before', 'after'] as const) {
  const point = when === 'before' ? '提交前' : '提交后';

  test(`${SENTENCE}（启动确认丢失，${point}崩溃）`, options, async (t) => {
    const { remote, start, crashAt, wreck, queued, runsOf } = stage(t);
    const first = await start();
    const crashed = crashAt('run.running', when);
    const task = queued(first);
    await crashed;
    await wreck(first);

    const service = await start();
    const [only, ...others] = runsOf(service, task);
    assert.equal(others.length, 0, `${FLOOR}：启动确认丢失后多了一个 Run`);
    await until(() => service.ledger.getRun(only!.id).state === 'running', '核实到执行者');
    await sleep(150);
    assert.equal(remote.called('start.sh'), 1, `${FLOOR}：启动命令发了第二次`);
    assert.equal(service.ledger.getTask(task.id).state, 'running');
  });

  test(`${SENTENCE}（发启动之前的崩溃，run.create ${point}）`, options, async (t) => {
    const { remote, start, crashAt, wreck, queued, runsOf } = stage(t);
    const first = await start();
    const crashed = crashAt('run.create', when);
    const task = queued(first);
    await crashed;
    await wreck(first);
    assert.equal(remote.called('start.sh'), 0);

    // The first service's start never went out, and nothing here can tell that apart
    // from a start still on its way: §4's first row.
    let grace = NEVER;
    const service = await start({ dispatchIntervalMs: 20, lostGraceMs: () => grace });
    if (when === 'before') {
      await until(() => remote.called('start.sh') === 1, '没落库的 Run 重新派发');
      return;
    }
    const run = runsOf(service, task)[0]!;
    assert.equal(service.ledger.getRun(run.id).state, 'unknown');
    assert.equal(service.ledger.getTask(task.id).state, 'needs_verification');
    await sleep(150);
    assert.equal(remote.called('start.sh'), 0, `${FLOOR}：启动结果未确认、宽限期没到就重发了启动`);
    assert.equal(runsOf(service, task).length, 1, `${FLOOR}：宽限期没到就派了新 Run`);

    const client = await signIn(service);
    const refused = await client.post(`/api/tasks/${task.id}/resume`);
    assert.equal(refused.status, 400, '失联的任务没有“继续”：它自己会接续');

    // The grace period is over: the start is revoked, then the Task goes on by itself.
    grace = 0;
    const next = await until(() => runsOf(service, task)[1], '宽限期到了自动接续');
    assert.equal(remote.runOf(run.id).revoked, true, `${FLOOR}：没有先撤销迟到的启动`);
    assert.equal(service.ledger.getRun(run.id).exit_kind, 'lost');
    await until(() => service.ledger.getRun(next.id).state === 'running', '接续的一轮启动');
    assert.equal(remote.called('start.sh', run.id), 0, '旧的一轮从头到尾没有启动过');
    assert.equal(remote.called('start.sh', next.id), 1);
    assert.equal(remote.runOf(next.id).round, 2);
  });

  test(`${SENTENCE}（停止中重启，run.stopping ${point}崩溃）`, options, async (t) => {
    const { remote, start, crashAt, wreck, queued, launched } = stage(t);
    const first = await start();
    const task = queued(first);
    const run = await launched(first, task);
    const client = await signIn(first);
    const crashed = crashAt('run.stopping', when);
    const response = await client.post(`/api/tasks/${task.id}/interrupt`);
    await crashed;
    assert.equal(response.status, 503);
    assert.equal(remote.called('stop.sh'), 0, '底线“写库失败停止副作用”：停止意图没落库就发了信号');
    await wreck(first);
    remote.finish(run.id, { status: 'done', summary: '抢在停止前写完', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
    Object.assign(remote.runOf(run.id), { pid_alive: true, marked: true });

    const service = await start({ dispatchIntervalMs: 60_000, watchIntervalMs: 60_000 });
    const settled = service.ledger.getRun(run.id);
    if (when === 'before') {
      // The stop was never recorded and the answer said so; the Worker's result stands.
      assert.equal(settled.exit_kind, 'completed');
      assert.equal(service.ledger.getTask(task.id).state, 'ready');
      return;
    }
    assert.equal(settled.exit_kind, 'interrupted', '§11 第二组：成功回执覆盖了停止意图');
    assert.equal(service.ledger.getTask(task.id).state, 'held');
    assert.ok(remote.called('stop.sh', run.id) >= 1, '§5.6：重启后没有先完成停止');
    assert.match(settled.receipt_json ?? '', /抢在停止前写完/, '回执要留作历史');
  });

  test(`${SENTENCE}（机器失联超过宽限期，结算旧 Run ${point}崩溃）`, options, async (t) => {
    const { dataDir, remote, start, crashAt, wreck, queued, launched, runsOf } = stage(t, ACCOUNT, TWO_MACHINES);
    let grace = NEVER;
    const first = await start({ lostGraceMs: () => grace });
    const task = queued(first);
    const old = await launched(first, task);
    assert.equal(old.host, 'h1');
    remote.down.add('h1');
    await until(() => first.ledger.getRun(old.id).state === 'unknown', '发现连不上');
    await sleep(100);
    assert.equal(runsOf(first, task).length, 1, `${FLOOR}：宽限期内派了新 Run`);

    const crashed = crashAt('task.continue', when);
    grace = 0;
    await crashed;
    await wreck(first);

    // Ending the old Run and queueing its Task are one commit: both or neither.
    const left = committed(dataDir, task);
    assert.equal(left.runs.length, 1, '崩在这里不该已经有接续的 Run');
    assert.deepEqual(
      [left.runs[0]!.state, left.runs[0]!.exit_kind, left.task.state],
      when === 'before' ? ['unknown', null, 'needs_verification'] : ['ended', 'lost', 'queued'],
      '结算旧 Run 与任务回队列不在同一事务',
    );

    const service = await start({ lostGraceMs: () => 0 });
    const next = await until(() => runsOf(service, task)[1], '重启后接续');
    await until(() => service.ledger.getRun(next.id).state === 'running', '接续的一轮启动');
    assert.equal(next.host, 'h2');
    assert.equal(service.ledger.getRun(old.id).exit_kind, 'lost');
    assert.match(JSON.parse(next.snapshot_json).brief, /上一轮机器失联或进程中断，本轮自动接续/);

    // The old machine comes back and the old Worker had finished after all.
    remote.down.delete('h1');
    remote.finish(old.id, { status: 'done', summary: '其实做完了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
    await sleep(150);
    assert.equal(runsOf(service, task).length, 2, '接续只发一次');
    assert.equal(remote.called('start.sh', next.id), 1);
    assert.equal(remote.called('start.sh', old.id), 1, `${FLOOR}：旧的一轮被重发了启动`);
    const settled = service.ledger.getRun(old.id);
    assert.deepEqual([settled.exit_kind, settled.receipt_json], ['lost', null], '§11 第二组：旧结果被采用了');
    assert.equal(service.ledger.getTask(task.id).state, 'running');
  });

  test(`${SENTENCE}（创建接续的 Run ${point}崩溃）`, options, async (t) => {
    const { dataDir, remote, start, crashAt, wreck, queued, launched, runsOf } = stage(t, ACCOUNT, TWO_MACHINES);
    let grace = NEVER;
    const first = await start({ lostGraceMs: () => grace });
    const task = queued(first);
    const old = await launched(first, task);
    remote.down.add('h1');
    await until(() => first.ledger.getRun(old.id).state === 'unknown', '发现连不上');

    const crashed = crashAt('run.create', when);
    grace = 0;
    await crashed;
    await wreck(first);
    const left = committed(dataDir, task);
    assert.equal(left.runs[0]!.exit_kind, 'lost', '旧 Run 的结算在创建接续之前就已落库');
    assert.equal(left.runs.length, when === 'before' ? 1 : 2);
    assert.equal(left.task.state, when === 'before' ? 'queued' : 'running');
    assert.equal(remote.called('start.sh'), 1, '崩在发启动之前');

    const service = await start({ lostGraceMs: () => 0 });
    // Before the commit the continuation was never created and is simply dispatched.
    // After it, the continuation exists and nobody knows whether its start went out: it
    // gets the same treatment as any Run, revoked and continued in its turn.
    const expected = when === 'before' ? 2 : 3;
    const last = await until(() => {
      const runs = runsOf(service, task);
      const final = runs.at(-1)!;
      return runs.length === expected && service.ledger.getRun(final.id).state === 'running' && final;
    }, '重启后接续到一个在跑的 Run');
    await sleep(150);
    const runs = runsOf(service, task);
    assert.equal(runs.length, expected, '接续发多了');
    assert.deepEqual(runs.slice(0, -1).map(({ exit_kind }) => exit_kind), Array(expected - 1).fill('lost'));
    for (const run of runs) {
      assert.ok(remote.called('start.sh', run.id) <= 1, `${FLOOR}：同一个 Run 的启动发了两次`);
    }
    // The old Worker sits on a machine nobody reaches, beside the continuation, until
    // its own watch has looked at the rounds: the overlap the round markers allow.
    const alive = (): string[] => runs.filter((run) => remote.runOf(run.id).pid_alive).map(({ id }) => id);
    assert.deepEqual(alive(), [old.id, last.id], '接续之后只该多出最后那一轮');
    assert.deepEqual(remote.watchLooks(), [old.id]);
    assert.deepEqual(alive(), [last.id], '看门循环看过之后，同一个任务不该有两个执行者在跑');
    assert.equal(service.ledger.getTask(task.id).state, 'running');
  });
}

test(`${SENTENCE}（延迟的 SSH：停止之后才到的启动）`, options, async (t) => {
  const { remote, start, queued, runsOf } = stage(t);
  const service = await start();
  const release = remote.hold('start.sh');
  const task = queued(service);
  await until(() => remote.called('start.sh') === 1, '启动在路上');
  const client = await signIn(service);
  const run = runsOf(service, task)[0]!;
  await client.post(`/api/tasks/${task.id}/interrupt`);
  release();
  await until(() => service.ledger.getRun(run.id).state === 'ended', '结算');
  assert.equal(service.ledger.getRun(run.id).exit_kind, 'interrupted', '§11 第二组：迟到的启动盖过了停止');
  assert.equal(remote.runOf(run.id).pid_alive, false, '撤销之后不该有 Worker 起来');
  assert.equal(service.ledger.getTask(task.id).state, 'held');
});

test(`${SENTENCE}（主机不可达：宽限期内不重派，回来后旧执行还在）`, options, async (t) => {
  const { remote, start, stop, queued, launched, runsOf } = stage(t);
  const first = await start();
  const task = queued(first);
  const run = await launched(first, task);
  await stop(first);
  remote.reachable = false;

  const service = await start();
  assert.equal(service.ledger.getRun(run.id).state, 'unknown');
  const client = await signIn(service);
  assert.equal((await client.post(`/api/tasks/${task.id}/resume`)).status, 400);
  await sleep(100);
  assert.equal(runsOf(service, task).length, 1, `${FLOOR}：主机不可达、宽限期没到就派了新 Run`);

  remote.reachable = true;
  await until(() => service.ledger.getRun(run.id).state === 'running', '主机回来后核实到执行者');
  assert.equal(service.ledger.getTask(task.id).state, 'running');
  assert.equal(remote.called('start.sh'), 1);
});

test(`${SENTENCE}（所有机器都连不上：过了宽限期也不判定，网络回来后什么都没丢）`, options, async (t) => {
  const { remote, start, queued, launched, runsOf } = stage(t, ACCOUNT, TWO_MACHINES);
  const service = await start({ lostGraceMs: () => 0 });
  const task = queued(service);
  const run = await launched(service, task);
  // This workstation lost its own network: every machine looks gone at once.
  remote.reachable = false;
  await until(() => service.ledger.getRun(run.id).state === 'unknown', '发现连不上');
  await sleep(200);
  assert.equal(service.ledger.getRun(run.id).state, 'unknown', `${FLOOR}：没有连得上的机器却判定了`);
  assert.equal(runsOf(service, task).length, 1);

  remote.reachable = true;
  await until(() => service.ledger.getRun(run.id).state === 'running', '网络回来后看到旧执行还在');
  assert.equal(runsOf(service, task).length, 1);
  assert.equal(remote.called('start.sh'), 1);
});

test(`${SENTENCE}（放弃和中断不被失联卡住）`, options, async (t) => {
  const { remote, start, queued, launched } = stage(t, ACCOUNT, TWO_MACHINES);
  let grace = NEVER;
  let skew = 0;
  const service = await start({ lostGraceMs: () => grace, now: () => Date.now() + skew, monotonic: () => performance.now() + skew });
  const client = await signIn(service);
  const abandoned = queued(service, '要放弃的');
  const abandonedRun = await launched(service, abandoned);
  const interrupted = queued(service, '要中断的');
  const interruptedRun = await launched(service, interrupted);
  remote.reachable = false;
  await until(() => service.ledger.listActiveRuns().every((run) => run.state === 'unknown'), '都连不上');

  const gaveUp = await client.post(`/api/tasks/${abandoned.id}/abandon`, { reason: '不做了' });
  assert.equal(gaveUp.status, 200);
  assert.equal(service.ledger.getTask(abandoned.id).state, 'abandoned', '放弃被失联卡住了');
  assert.equal(service.ledger.getRun(abandonedRun.id).exit_kind, 'lost');

  assert.equal((await client.post(`/api/tasks/${interrupted.id}/interrupt`)).status, 200);
  await sleep(100);
  assert.equal(service.ledger.getRun(interruptedRun.id).state, 'unknown', '宽限期内不结算');
  grace = 0;
  await until(() => service.ledger.getRun(interruptedRun.id).state === 'ended', '宽限期到了按已中断结算');
  assert.equal(service.ledger.getRun(interruptedRun.id).exit_kind, 'interrupted');
  const held = service.ledger.getTask(interrupted.id);
  assert.deepEqual([held.state, held.reason], ['held', '已中断（机器失联）']);

  // The machines come back with both Workers still alive, and no Run or Task is left
  // to give anyone a reason to ask them: the sweep asks by itself, a minute later.
  assert.ok(remote.runOf(abandonedRun.id).pid_alive && remote.runOf(interruptedRun.id).pid_alive);
  remote.reachable = true;
  skew += 61_000;
  await until(() => !remote.runOf(abandonedRun.id).pid_alive && !remote.runOf(interruptedRun.id).pid_alive, '重连即清');
});
