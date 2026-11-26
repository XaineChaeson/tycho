// Guards the Router's turn count (project-sessions §2, §3): a round that already put its Task
// back in the queue by itself waking the Router for nothing, an insertion receipt waking it at
// all, an owner's notification lost with those rows, and internal events queued together being
// handed over one turn each instead of one.
//
// What this file is here to catch:
//   - a quota, lost (including one no machine took) or read-only-refused settlement whose Task is
//     back in the queue leaving a message the Router takes, instead of a record only;
//   - a refused login's settlement being silenced the same way, or the owner's push of a settled
//     work disappearing with the record;
//   - an insertion receipt left in the Router's queue;
//   - events queued together taken one at a time, a message of the owner's spilled into a turn
//     of internal events, a trigger message swallowed the same way, events after either message
//     attached, or more than ten in one turn;
//   - a trigger source sitting on the second event of a merged turn not reaching the work that
//     turn starts, so the cycle it should cut off is set off again;
//   - the messages of one turn left by a restart not grouped to its first one, so a later
//     message's unverified push lists no committed operation of the turn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunRow } from '../service/ledger.ts';
import { turnFirsts } from '../service/messages.ts';
import { claudeTier, DONE, fixture, RUN_LIMIT_MS, stripped, USER } from './helpers.ts';
import type { Fixture } from './helpers.ts';

const internal = (f: Fixture, tag: string): string =>
  f.ledger.receiveMessage({ channel: 'internal', externalId: `event-${tag}`, actor: 'runner', text: `事件 ${tag}`, projectId: f.projectId }).id;
const stateOf = (f: Fixture, runId: string): string | null | undefined =>
  f.peek<{ state: string | null }>('SELECT state FROM message WHERE external_id = ?', `run:${runId}`)[0]?.state;
const readyRun = (f: Fixture, taskId: string): string => {
  f.ledger.queueTask(taskId, USER);
  const run = f.ledger.createRun(taskId, f.login, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE);
  return run.id;
};

test('结算把任务自动放回队列的几种情况只记账，不叫醒负责人', (t) => {
  const cases: { what: string; settle: (f: Fixture, run: RunRow) => void }[] = [
    { what: '额度用完', settle: (f, run) => f.ledger.settleRun(run.id, 1, null, { kind: 'quota', quota: { message: '额度没了' } }) },
    { what: '执行丢失', settle: (f, run) => f.ledger.settleRun(run.id, null, null, { kind: 'lost' }) },
    { what: '没有机器接下', settle: (f, run) => f.ledger.settleRun(run.id, null, null, { kind: 'lost', lost: { basis: 'not_started' } }) },
  ];
  for (const { what, settle } of cases) {
    const f = fixture(t);
    const { task, run } = f.runningRun();
    settle(f, run);
    assert.equal(f.task(task.id).state, 'queued', what);
    assert.equal(stateOf(f, run.id), 'ignored', what);
    assert.equal(f.ledger.takeNextTurn(f.projectId), undefined, what);
  }
});

test('只读一轮的 code_check 仅作参考元数据，不丢弃回执也不静默重派', (t) => {
  const f = fixture(t);
  const login = f.ledger.getMachineLogin(f.login.login.machine, f.login.login.executor);
  const task = f.ledger.createTask({ roleId: 'analyse', projectId: f.projectId, title: '看一看', goal: '查原因', acceptance: '交报告' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, {
    ...f.login,
    login: login ? stripped(login) : f.login.login,
    snapshot: { brief: 'b', tier_value: claudeTier('/tiers/execute.json'), timeout_ms: RUN_LIMIT_MS, repo: { dir: '/host/repo', branch: 'main', commit: 'c0ffee' } },
  }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '查清了', artifacts: [{ kind: 'report', ref: '最后一条消息' }] } as never, {
    codeCheck: { result: 'changed', changes: ['新增 out.txt'] },
  });
  assert.equal(f.task(task.id).state, 'ready', '保留回执并结算到 ready');
  assert.deepEqual(JSON.parse(f.run(run.id).error_json!).code_check, { result: 'changed', changes: ['新增 out.txt'] });
  assert.equal(stateOf(f, run.id), 'received');
});

test('登录失效的结算照旧叫醒负责人，主人该收的通知也照旧入队', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null, { kind: 'auth' });
  assert.equal(stateOf(f, run.id), 'received');
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.external_id, `run:${run.id}`);

  // A settled work that needs no review still tells the owner through the same push it always did.
  const done = fixture(t);
  const task = done.newTask({ roleId: 'verify', tierOverride: { tier: 'execute', reason: '测试通知' } });
  readyRun(done, task.id);
  assert.equal(done.peek(`SELECT 1 FROM push WHERE level = 'result'`).length, 1);
});

test('同一项目连续的内部事件一次取走，遇到别的消息就停', (t) => {
  const f = fixture(t);
  const first = internal(f, 'a');
  const second = internal(f, 'b');
  const third = internal(f, 'c');
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(taken.message.id, first);
  assert.deepEqual(taken.attached.map(({ id }) => id), [second, third]);
  assert.deepEqual([first, second, third].map((id) => f.ledger.getMessage(id).state), ['processing', 'processing', 'processing']);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'message.take'`).length, 3, '每条各记一次取走');
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined, '一个项目一次只有一个回合');

  const mid = fixture(t);
  const a = internal(mid, 'a');
  const b = internal(mid, 'b');
  const owner = mid.ledger.receiveMessage({ channel: 'console', externalId: 'owner', actor: 'user', text: '主人的话', projectId: mid.projectId }).id;
  const after = internal(mid, 'c');
  const stopped = mid.ledger.takeNextTurn(mid.projectId)!;
  assert.deepEqual([stopped.message.id, ...stopped.attached.map(({ id }) => id)], [a, b], '只取到主人那条之前');
  assert.equal(mid.ledger.getMessage(owner).state, 'received');
  assert.equal(mid.ledger.getMessage(after).state, 'received');
});

test('主人消息不合并，后面紧跟的内部事件留给下一回合', (t) => {
  const f = fixture(t);
  const owner = f.ledger.receiveMessage({ channel: 'console', externalId: 'owner', actor: 'user', text: '主人的话', projectId: f.projectId }).id;
  const event = internal(f, 'a');
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  assert.deepEqual([taken.message.id, taken.attached], [owner, []]);
  assert.equal(f.ledger.getMessage(event).state, 'received');
});

test('合并遇到触发器消息就停，触发器消息自己一个回合', (t) => {
  const f = fixture(t);
  const a = internal(f, 'a');
  const b = internal(f, 'b');
  const when = '2099-01-01T00:00:00Z';
  f.ledger.createTrigger(f.projectId, { name: '到点', instruction: '做一件', schedule: { kind: 'once', at: when } }, USER);
  f.ledger.fireDue(new Date(when));
  const c = internal(f, 'c');
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  assert.deepEqual([taken.message.id, ...taken.attached.map(({ id }) => id)], [a, b], '触发器消息之前的两条合并');
  for (const id of [a, b]) f.ledger.finishMessage(id, 'processed');
  const triggered = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(triggered.message.channel, 'trigger');
  assert.deepEqual(triggered.attached, [], '触发器消息不把后面的内部事件带进来');
  assert.equal(f.ledger.getMessage(c).state, 'received');
  f.ledger.finishMessage(triggered.message.id, 'processed');
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, c);
});

test('重启留下的一个合并回合按第一条分组，项目外的消息各自独立', (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 3 }, (_, index) => internal(f, `restart-${index}`));
  f.ledger.takeNextTurn(f.projectId);
  const unfinished = f.ledger.markProcessingUnverified();
  assert.deepEqual(unfinished, ids);
  assert.deepEqual(turnFirsts(unfinished.map((id) => f.ledger.getMessage(id))), [ids[0], ids[0], ids[0]]);
  // A message of no project belongs to no turn but its own, whatever came before it.
  assert.deepEqual(
    turnFirsts([{ id: 'p1', project_id: 'one' }, { id: 'p2', project_id: 'one' }, { id: 'x', project_id: null }, { id: 'y', project_id: null }, { id: 'p3', project_id: 'one' }]),
    ['p1', 'p1', 'x', 'y', 'p1'],
  );
});

test('一次最多取 10 条内部事件，其余的留给下一回合', (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 12 }, (_, index) => internal(f, String(index + 1)));
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  assert.deepEqual([taken.message.id, ...taken.attached.map(({ id }) => id)], ids.slice(0, 10));
  assert.deepEqual(ids.slice(10).map((id) => f.ledger.getMessage(id).state), ['received', 'received']);
  for (const id of ids.slice(0, 10)) f.ledger.finishMessage(id, 'processed');
  const next = f.ledger.takeNextTurn(f.projectId)!;
  assert.deepEqual([next.message.id, ...next.attached.map(({ id }) => id)], ids.slice(10));
});

test('合并回合里第二条结算的触发来源，被这一回合新建的任务拿到', (t) => {
  const f = fixture(t);
  const when = '2099-01-01T00:00:00Z';
  const trigger = f.ledger.createTrigger(f.projectId, { name: '到点', instruction: '做一件', schedule: { kind: 'once', at: when } }, USER);
  f.ledger.fireDue(new Date(when));
  const { message: triggerMessage } = f.ledger.takeNextTurn(f.projectId)!;
  // A was started by that trigger turn: its settlement's message carries the source about it.
  const a = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: 'A', goal: '做', acceptance: '好' }, { actor: 'router', messageId: triggerMessage.id });
  const fire = f.ledger.listTriggerFires({ triggerId: trigger.id, limit: 10 })[0]!;
  assert.equal(a.trigger_fire_id, fire.id);
  f.ledger.finishMessage(triggerMessage.id, 'processed');
  // B settles first, so A's settlement is the event attached behind it.
  const b = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: 'B', goal: '做', acceptance: '好' }, USER);
  const runB = readyRun(f, b.id);
  const runA = readyRun(f, a.id);
  const eventOf = (runId: string) => f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${runId}`)!.id;
  const [first, second] = [eventOf(runB), eventOf(runA)];
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  assert.deepEqual([taken.message.id, ...taken.attached.map(({ id }) => id)], [first, second]);

  const made = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: 'C', goal: '接着做', acceptance: '好' }, {
    actor: 'router',
    messageId: first,
    messageIds: [first, second],
  });
  assert.equal(made.trigger_fire_id, fire.id, '来源在第二条上也要被看到');
});
