// Also guards a machine's own login staying on its machine, the project's machines narrowing it, and
// independent quotas for two logins on one machine.
// Guards against a used-up quota being handled as anything but what it is: something
// expected that ends by itself. A Run it ended settled as failed or lost; its Task
// stopped for the owner, counted towards the limit on losses, or told to WeCom; the
// account going straight back to work, or resting without end; the executor's own time
// ignored, or trusted again after a try that failed right at it; a rest that does not
// grow when tries keep failing, grows past the ceiling, grows once per Run that ran into
// the same used-up quota, or never starts short again after a Run went through; a rest
// with no Task move or a Task move with no rest when the process dies at the commit; a
// pinned Task wandering off or held instead of waiting; a Task that names no account
// stuck behind a resting one; a login failure treated the same way though it does not
// end by itself. And against the runtime state leaking into configuration: a resting
// account read as changed, so that Runs on it or on others cannot be created or started.
// And around it: a ceiling that is ignored, that holds a Task for the owner, that stays
// after it is cleared, or that keeps a Run out of contact from ever being judged; usage
// figures recorded on every line, kept past their window, or shown in a Run's own log; a
// figure said again keeping the moment it was first said, so the page shows a fresh read as
// an old one;
// and a continuation that resumes a session, or is not told to check the site.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner } from '../runner/runner.ts';
import type { Snapshot, Login } from '../runner/snapshot.ts';
import { loginConfig } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { InputError } from '../service/errors.ts';
import type { LedgerOptions, RunRow, TaskRow } from '../service/ledger.ts';
import { restingUntil, usageNow } from '../service/ledger.ts';
import { createNotify } from '../service/notify.ts';
import { fakeRemote, receiptOutput } from './fake-remote.ts';
import { claudeTier, DISPATCH_TUNED, DONE, fixture, LOGIN, machineLogin, memoryLogins, memoryMachines, RUNNER_TUNED, stripped, testCredentialRef, tune, tuned, USER, holdMachine, testMachine, uidsOf } from './helpers.ts';
import { SETTINGS } from '../service/settings.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const REST = 30 * MINUTE;
const MAX_REST = 6 * HOUR;
// How far a time the ledger wrote may be from one computed here.
const SLACK = 5000;

class Crash extends Error {}

const near = (actual: string | null | undefined, expected: number, what: string): void => {
  assert.ok(actual, `${what}：没有时刻`);
  assert.ok(Math.abs(Date.parse(actual) - expected) < SLACK, `${what}：${actual} 应在 ${new Date(expected).toISOString()} 附近`);
};

// What a Worker leaves when the account's quota runs out under it, in the shape of the
// coordinator's sample: the window line, then the failed result. `resetsAt` in epoch
// seconds, relative to now, since the ledger judges it against the real clock.
function quotaOutput(resetsAt?: number, used = 0.99): string {
  const windows = resetsAt === undefined ? [] : [{
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected', resetsAt, rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: used, resetsAt }, seven_day: { utilization: 0.51, resetsAt: resetsAt + 86_400 } },
    },
  }];
  const result = {
    type: 'result', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached',
    result: "You've hit your session limit · resets 6:40am (Asia/Shanghai)", session_id: 'quota-session',
  };
  return [...windows, result].map((line) => `${JSON.stringify(line)}\n`).join('');
}

const QUOTA = { kind: 'quota' as const, quota: { message: '额度没了' } };
// The two logins: each machine's own Claude Code login, one machine each.
let T1: string;
let T2: string;

// The ledger alone: a Run on h1's login that the quota ends, and h2's beside it.
function ledgerOnly(t: TestContext, options: LedgerOptions = {}) {
  const f = fixture(t, options);
  holdMachine(f.ledger, testMachine('h2'), USER);
  f.ledger.putMachineLogin({ ...LOGIN.login, machine: 'h2' }, USER);
  T1 = f.ledger.getMachineLogin('h1', 'claude')!.id;
  T2 = f.ledger.getMachineLogin('h2', 'claude')!.id;
  const held = (id: string): Login => stripped(f.ledger.listMachineLogins().find((login) => login.id === id)!);
  const rest = (name = T1) => f.ledger.loginState(held(name).id);
  // A Run created now, so after any rest that has begun: a try.
  const tryOn = (task: TaskRow, login = T1): RunRow => {
    const run = f.ledger.createRun(task.id, { ...f.login, login: held(login), machine: login === T1 ? f.login.machine : f.ledger.getMachine('h2')!, expectedRevision: f.task(task.id).revision }, USER);
    f.ledger.markRunRunning(run.id);
    return run;
  };
  const changes = (action: string) => f.peek<{ detail_json: string; task_id: string | null }>('SELECT * FROM change WHERE action = ? ORDER BY seq', action);
  return { f, rest, tryOn, changes, held };
}

test('a Run the quota ended settles as that: not failed, not lost, its Task back in the queue and nobody asked', (t) => {
  const { f, rest, changes } = ledgerOnly(t);
  const { task, run } = f.runningRun();
  const resetsAt = new Date(Date.now() + 2 * HOUR).toISOString();
  const result = f.ledger.settleRun(run.id, 1, null, { kind: 'quota', quota: { message: '额度没了', resetsAt }, sessionRef: 's-1' });
  assert.deepEqual(result, { late: false, task_state: 'queued' });
  const ended = f.run(run.id);
  assert.deepEqual([ended.state, ended.exit_kind, ended.exit_code], ['ended', 'quota', 1]);
  assert.deepEqual(JSON.parse(ended.error_json!), {
    quota: { login_id: T1, login_name: 'h1/claude', message: '额度没了', resets_at: resetsAt, rest_until: resetsAt },
    reason: '额度用完',
  });
  assert.deepEqual([f.task(task.id).state, f.task(task.id).reason], ['queued', null]);
  assert.equal(f.count('outbox'), 0, '不找主人');
  assert.equal(f.count('approval'), 0);
  // The record on the timeline: which round, on which account, and until when it rests.
  const [continued] = changes('task.continue');
  assert.deepEqual(JSON.parse(continued!.detail_json), {
    reason: '额度用完', basis: 'quota', run_id: run.id, host: 'h1', login_id: T1, rest_until: resetsAt,
  });
  assert.deepEqual(JSON.parse(changes('run.settle')[0]!.detail_json), {
    exit_code: 1, exit_kind: 'quota', task_state: 'queued', login_id: T1, rest_until: resetsAt,
  });
  const event = f.ledger.listMessages({ limit: 100 }).find((row) => row.external_id === `run:${run.id}`)!;
  assert.match(event.text, /机器 h1 上的 claude 登录 的额度用完而结束，已自动重新排队.*不需要处理/);
  assert.equal(rest().rest_until, resetsAt, '目标歇到执行器给的时刻');
  assert.equal(rest(T2).rest_until, null, '别的目标不受影响');
});

test('the executor names no time, or one already past: the account rests for the setting, read when it happens', (t) => {
  const { f, rest, tryOn } = ledgerOnly(t);
  tune(f.ledger, 'quota.restMs', REST);
  const first = f.runningRun();
  f.ledger.settleRun(first.run.id, 1, null, QUOTA);
  near(rest().rest_until, Date.now() + REST, '默认歇 30 分钟');
  assert.equal(rest().rest_reason, '额度没了');
  // A Run goes through: the count starts again. Then the setting changes.
  const done = tryOn(first.task);
  f.ledger.settleRun(done.id, 0, DONE);
  f.ledger.endRest(T1, USER);
  tune(f.ledger, 'quota.restMs', 5 * MINUTE);
  const second = f.runningRun();
  f.ledger.settleRun(second.run.id, 1, null, { kind: 'quota', quota: { message: 'm', resetsAt: new Date(Date.now() - HOUR).toISOString() } });
  near(rest().rest_until, Date.now() + 5 * MINUTE, '过去的时刻不算数，按设置');
});

test('a try that fails again doubles the rest up to the ceiling, and a Run that goes through starts it short again', (t) => {
  const { f, rest, tryOn } = ledgerOnly(t);
  const task = f.queuedTask();
  const expected = [REST, 2 * REST, 4 * REST, 8 * REST, MAX_REST, MAX_REST];
  for (const [index, wait] of expected.entries()) {
    const run = tryOn(task);
    f.ledger.settleRun(run.id, 1, null, QUOTA);
    assert.equal(rest().rest_streak, index + 1);
    near(rest().rest_until, Date.now() + wait, `第 ${index + 1} 次`);
    assert.equal(f.task(task.id).state, 'queued', '额度用完多少次都不停下来等主人');
    // The owner's "try now": the rest ends, the count of rests in a row stays.
    f.ledger.endRest(T1, USER);
    assert.equal(rest().rest_until, null);
  }
  const through = tryOn(task);
  f.ledger.settleRun(through.id, 0, DONE);
  assert.equal(rest().rest_streak, 0, '成功跑完一轮后归位');
  f.ledger.updateTask(task.id, { goal: '再来' }, USER);
  f.ledger.resumeTask(task.id, USER);
  f.ledger.settleRun(tryOn(task).id, 1, null, QUOTA);
  near(rest().rest_until, Date.now() + REST, '归位后又从 30 分钟起');
});

test('the executor is taken at its word once: after a try that failed at its time, the doubling wait is the least', (t) => {
  const { f, rest, tryOn } = ledgerOnly(t);
  const task = f.queuedTask();
  const soon = (): string => new Date(Date.now() + MINUTE).toISOString();
  const later = new Date(Date.now() + 9 * HOUR).toISOString();
  const first = soon();
  f.ledger.settleRun(tryOn(task).id, 1, null, { kind: 'quota', quota: { message: 'm', resetsAt: first } });
  assert.equal(rest().rest_until, first, '第一次按它说的，哪怕只有一分钟');
  f.ledger.endRest(T1, USER);
  f.ledger.settleRun(tryOn(task).id, 1, null, { kind: 'quota', quota: { message: 'm', resetsAt: soon() } });
  near(rest().rest_until, Date.now() + 2 * REST, '再失败就至少歇翻倍后的时长');
  f.ledger.endRest(T1, USER);
  f.ledger.settleRun(tryOn(task).id, 1, null, { kind: 'quota', quota: { message: 'm', resetsAt: later } });
  assert.equal(rest().rest_until, later, '它说的更晚就按它说的');
});

test('Runs that were already going when the rest began ran into the same used-up quota: one rest, not one each', (t) => {
  const { f, rest } = ledgerOnly(t);
  const runs = [f.runningRun(), f.runningRun(), f.runningRun()];
  f.ledger.settleRun(runs[0]!.run.id, 1, null, QUOTA);
  f.ledger.settleRun(runs[1]!.run.id, 1, null, QUOTA);
  assert.equal(rest().rest_streak, 1);
  near(rest().rest_until, Date.now() + REST, '没有翻倍');
  // One of them names a time: the account stays out at least until then.
  const stated = new Date(Date.now() + 3 * HOUR).toISOString();
  f.ledger.settleRun(runs[2]!.run.id, 1, null, { kind: 'quota', quota: { message: 'm', resetsAt: stated } });
  assert.deepEqual([rest().rest_streak, rest().rest_until], [1, stated]);
  for (const { task } of runs) assert.equal(f.task(task.id).state, 'queued');
});

test('a round the quota ended is no loss: it neither counts towards the limit on losses nor ends a row of them', (t) => {
  const { f, tryOn } = ledgerOnly(t);
  const task = f.queuedTask();
  const end = (opts: Parameters<typeof f.ledger.settleRun>[3]): string => {
    f.ledger.settleRun(tryOn(task).id, null, null, opts);
    return f.task(task.id).state;
  };
  for (let round = 0; round < SETTINGS['run.maxLostContinuations'].default + 3; round += 1) assert.equal(end(QUOTA), 'queued');
  assert.equal(f.ledger.lostLimitReached(task.id), false);
  // Losses with quota rounds between them are still losses in a row.
  for (let round = 1; round < SETTINGS['run.maxLostContinuations'].default; round += 1) {
    assert.equal(end({ kind: 'lost' }), 'queued');
    assert.equal(end(QUOTA), 'queued');
  }
  assert.equal(end({ kind: 'lost' }), 'held');
  assert.match(f.task(task.id).reason!, /连续 3 次执行都丢失/);
});

test('a stop asked for still ends the Run as interrupted, and the account rests all the same', (t) => {
  const { f, rest } = ledgerOnly(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunStopping(run.id, USER);
  f.ledger.settleRun(run.id, 1, null, { quota: { message: '额度没了' } });
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.deepEqual([f.task(task.id).state, f.task(task.id).reason], ['held', '已中断']);
  near(rest().rest_until, Date.now() + REST, '额度是账号的事，目标照样歇');
});

test('after a restore nobody has gone through, the Task is held like after a loss, and the account still rests', (t) => {
  const { f, rest, changes } = ledgerOnly(t);
  const { task, run } = f.runningRun();
  f.ledger.sealRestore('backup');
  f.ledger.settleRun(run.id, 1, null, QUOTA);
  assert.deepEqual([f.run(run.id).exit_kind, f.task(task.id).state, f.task(task.id).reason], ['quota', 'held', '恢复自备份，待确认']);
  assert.equal(changes('task.continue').length, 0);
  assert.ok(rest().rest_until);
});

for (const point of ['afterSettleRunWrite', 'beforeCommit'] as const) {
  test(`a crash before the commit (${point}) leaves neither the rest nor the Task's move`, (t) => {
    let armed = false;
    const crash = (): void => {
      if (armed) throw new Crash(point);
    };
    const { f } = ledgerOnly(t, { testHooks: { [point]: crash } });
    const { task, run } = f.runningRun();
    const before = f.dump();
    armed = true;
    assert.throws(() => f.ledger.settleRun(run.id, 1, null, QUOTA), Crash);
    armed = false;
    assert.deepEqual(f.dump(), before, '什么都没写下');
    assert.deepEqual([f.run(run.id).state, f.task(task.id).state], ['running', 'running']);
    assert.equal(f.count('login_state'), 0);
    // The watcher comes round again and the settlement happens whole.
    f.ledger.settleRun(run.id, 1, null, QUOTA);
    assert.deepEqual([f.run(run.id).exit_kind, f.task(task.id).state, f.count('login_state')], ['quota', 'queued', 1]);
  });
}

test('a crash right after the commit leaves both: the account rests and the Task is queued, with its record', (t) => {
  let armed = false;
  const { f } = ledgerOnly(t, {
    testHooks: {
      afterCommit(actions, retire) {
        if (!armed || !actions.includes('run.settle')) return;
        retire();
        throw new Crash('after');
      },
    },
  });
  const { task, run } = f.runningRun();
  armed = true;
  assert.throws(() => f.ledger.settleRun(run.id, 1, null, QUOTA), Crash);
  // Read the way the next start would: through another connection.
  const [state] = f.peek<{ rest_until: string | null; rest_streak: number }>('SELECT * FROM login_state WHERE id = ?', T1);
  assert.equal(state?.rest_streak, 1);
  near(state?.rest_until, Date.now() + REST, '歇着的状态已提交');
  assert.deepEqual([f.run(run.id).exit_kind, f.task(task.id).state], ['quota', 'queued']);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'task.continue' AND task_id = ?`, task.id).length, 1);
  assert.equal(f.peek(`SELECT 1 FROM message WHERE channel = 'internal' AND external_id = ?`, `run:${run.id}`).length, 1);
});

test('a rest is not configuration: the login reads as unchanged, and Runs on it and on others are created as before', (t) => {
  const { f, changes, held } = ledgerOnly(t);
  // Read before the rest, as a dispatcher does when it picks a machine.
  const read = { t1: f.ledger.getMachineLogin('h1', 'claude')!, t2: held(T2) };
  const config = JSON.stringify(loginConfig(read.t1));
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null, QUOTA);
  f.ledger.noteUsage(T1, [{ window: 'five_hour', used: 0.99, resetsAt: null }]);
  assert.ok(restingUntil(f.ledger.loginState(T1), Date.now()));
  const now = f.ledger.getMachineLogin('h1', 'claude')!;
  assert.equal(JSON.stringify(loginConfig(now)), config);
  assert.equal(now.updated_at, read.t1.updated_at);
  assert.equal(changes('machine_login.update').length, 0);
  assert.deepEqual(f.ledger.putMachineLogin(read.t1, USER), { created: false });
  assert.equal(changes('machine_login.update').length, 0, '原样保存不留记录：配置没有变');
  // The check createRun makes is about configuration, and passes with what was read before.
  const other = f.queuedTask();
  assert.equal(f.ledger.createRun(other.id, { ...f.login, login: read.t2, machine: f.ledger.getMachine('h2')! }, USER).login_id, read.t2.id);
  const same = f.queuedTask();
  const created = f.ledger.createRun(same.id, { ...f.login, login: stripped(read.t1) }, USER);
  assert.deepEqual(JSON.parse(created.snapshot_json).login, loginConfig(read.t1), '快照里记的是配置，没有歇着的状态');
});

test('usage carries when it was last said, leaves no change row, and stops counting when its window starts over', (t) => {
  const { f } = ledgerOnly(t);
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const soon = new Date(start + HOUR).toISOString();
  const past = new Date(start - HOUR).toISOString();
  const changes = f.count('change');
  f.ledger.noteUsage(T1, [{ window: 'five_hour', used: 0.82, resetsAt: soon }, { window: 'seven_day', used: 0.5, resetsAt: past }]);
  const first = f.ledger.loginState(T1).usage;
  assert.deepEqual(first.map(({ window, used, resets_at, at }) => [window, used, resets_at, at]), [['five_hour', 0.82, soon, new Date(start).toISOString()], ['seven_day', 0.5, past, new Date(start).toISOString()]]);
  const before = f.dump();
  f.ledger.noteUsage(T1, []);
  f.ledger.noteUsage('gone', [{ window: 'five_hour', used: 0.1, resetsAt: soon }]);
  assert.deepEqual(f.dump(), before, '空的、不存在的目标都不写');
  t.mock.timers.tick(10 * 60_000);
  f.ledger.noteUsage(T1, [{ window: 'five_hour', used: 0.82, resetsAt: soon }]);
  assert.deepEqual(f.ledger.loginState(T1).usage.map(({ window, at }) => [window, at]),
    [['five_hour', new Date(start + 10 * 60_000).toISOString()], ['seven_day', new Date(start).toISOString()]], '同样的数字再说一遍也是新读到的：时刻跟着更新，没说的窗口不动');
  f.ledger.noteUsage(T1, [{ window: 'five_hour', used: 0.9, resetsAt: soon }]);
  assert.deepEqual(f.ledger.loginState(T1).usage.map(({ used }) => used), [0.9, 0.5]);
  assert.equal(f.count('change'), changes, '用量是展示数据，不进审计');
  const state = f.ledger.loginState(T1);
  assert.deepEqual(usageNow(state, Date.now()).map(({ window }) => window), ['five_hour']);
  assert.deepEqual(usageNow(state, Date.now() + 2 * HOUR), []);
  assert.deepEqual(usageNow(undefined, Date.now()), []);
});

test('"try now" ends a rest and is recorded; on a account that is not resting it does nothing, on none it is refused', (t) => {
  const { f, rest, changes } = ledgerOnly(t);
  f.ledger.endRest(T1, USER);
  assert.equal(changes('login.rest_end').length, 0);
  f.ledger.settleRun(f.runningRun().run.id, 1, null, QUOTA);
  const until = rest().rest_until;
  f.ledger.endRest(T1, USER);
  assert.equal(restingUntil(rest(), Date.now()), undefined);
  assert.deepEqual(changes('login.rest_end').map((row) => JSON.parse(row.detail_json)), [{ login_id: T1, rest_until: until }]);
  assert.throws(() => f.ledger.endRest('gone', USER), InputError);
});

test('what was learned about a login goes with it when it is deleted', (t) => {
  const { f } = ledgerOnly(t);
  f.ledger.settleRun(f.runningRun().run.id, 1, null, QUOTA);
  f.ledger.deleteMachineLogin('h1', 'claude', USER);
  assert.equal(f.count('login_state'), 0);
  f.ledger.putMachineLogin(LOGIN.login, USER);
  assert.deepEqual(f.ledger.loginState(T1), { rest_until: null, rest_streak: 0, rest_reason: null, usage: [], credential_rejected_ref: null, auth_failed_at: null, models: [], models_at: null, identity: {} });
});

test('a pin can be put on, moved and taken off, and a Run is never created off the pin', (t) => {
  const { f, held } = ledgerOnly(t);
  const task = f.queuedTask();
  assert.equal(task.login_id, null);
  const otherLoginId = held(T2).id;
  assert.equal(f.ledger.updateTask(task.id, { loginId: otherLoginId }, USER).login_id, otherLoginId);
  assert.equal(f.ledger.updateTask(task.id, { priority: 3 }, USER).login_id, otherLoginId, '没提到就不动');
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), /指定了机器 h2 上的 claude 登录，不能派到 机器 h1 上的 claude 登录/);
  assert.equal(f.count('run'), 0);
  assert.equal(f.ledger.updateTask(task.id, { loginId: null }, USER).login_id, null);
  assert.equal(f.ledger.createRun(task.id, f.login, USER).login_id, T1);
});

// The ledger, fake machines, the real Runner and dispatcher, and a clock the test moves.
// Two logins a project allows in the order t1, t2: each machine's own Claude Code login,
// h1's and h2's. An account a test adds runs on either, its token handed to the round.
function world(t: TestContext, edit: (accounts: Record<string, Login>) => void = () => {}) {
  const f = fixture(t, {}, false);
  const remote = fakeRemote();
  let skew = 0;
  const now = (): number => Date.now() + skew;
  let lead = 1;
  const accounts: Record<string, Login> = {
    t1: machineLogin('h1', 'claude', { tiers: { execute: claudeTier('/tiers/execute.json'), decide: claudeTier('/tiers/decide.json') } }),
    t2: machineLogin('h2', 'claude', { tiers: { execute: claudeTier('/tiers/execute.json') } }),
  };
  edit(accounts);
  const machines = memoryMachines({h1:testMachine('h1'),h2:testMachine('h2')},f.ledger);
  const store = memoryLogins(accounts, f.ledger);
  T1 = accounts.t1?.id ?? '';
  T2 = accounts.t2?.id ?? '';
  f.ledger.setProjectLogins(f.projectId, Object.values(accounts).map(({ id }) => id), USER);
  const logs: string[] = [];
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: store, machines, connect: remote.connect, now, log: (line) => logs.push(line),
    credential: (id) => (store.get(id)?.machine === undefined ? { ref: testCredentialRef(id), value: 'token' } : undefined),
  });
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    ledger: f.ledger,
    runTimeoutMs: tuned('run.timeoutMs'),
    // No watcher: every look at a Run is one the test asked for.
    runner: { ...runner, watch: async () => {} },
    logins: store,
    machines,
    executors: { claude: claudeAdapter },
    frontLead: () => lead,
    now,
    log: (line) => logs.push(line),
  });
  t.after(() => dispatcher.stop());
  const runsOf = (task: TaskRow): RunRow[] => f.ledger.listRuns(task.id);
  const queued = (fields: { loginId?: string; roleId?: string; title?: string; tierOverride?: { tier: string; reason?: string } } = {}): TaskRow => {
    const task = f.ledger.createTask({ projectId: f.projectId, title: '任务', goal: '目标', acceptance: '测试通过', roleId: 'implement', ...fields }, USER);
    f.ledger.queueTask(task.id, USER);
    return f.task(task.id);
  };
  // One round of dispatch, and where the Task's latest Run is after it.
  const tick = async (task: TaskRow): Promise<RunRow | undefined> => {
    await dispatcher.tick();
    return runsOf(task).findLast((run) => run.state !== 'ended');
  };
  // The Worker's last act on the machine, then the look that finds it.
  const ends = async (run: RunRow, stdout: string, exit: number): Promise<RunRow> => {
    Object.assign(remote.runOf(run.id), { stdout, exit, pid_alive: false, marked: false });
    await runner.verify(f.run(run.id));
    return f.run(run.id);
  };
  return {
    f, remote, accounts, store, logs, runner, dispatcher, runsOf, queued, tick, ends,
    advance(ms: number): void {
      skew += ms;
    },
    setLead(value: number): void {
      lead = value;
    },
    usedUp: (run: RunRow, resetsAt?: number) => ends(run, quotaOutput(resetsAt), 1),
    done: (run: RunRow) => ends(run, receiptOutput(DONE), 0),
    wait: (task: TaskRow) => dispatcher.waitOf(f.task(task.id)),
    snapshotOf: (run: RunRow) => JSON.parse(run.snapshot_json) as Snapshot,
  };
}

test('the Runner reads a used-up quota off the output: the Run ends as that, the account rests until the time the executor gave', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = (await w.tick(task))!;
  assert.deepEqual([run.login_id, run.state], [T1, 'running']);
  const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
  const ended = await w.usedUp(run, resetsAt);
  assert.deepEqual([ended.exit_kind, ended.session_ref, ended.receipt_json], ['quota', 'quota-session', null]);
  assert.equal(w.f.task(task.id).state, 'queued');
  const state = w.f.ledger.loginState(T1);
  assert.equal(state.rest_until, new Date(resetsAt * 1000).toISOString());
  assert.equal(state.rest_reason, "You've hit your session limit · resets 6:40am (Asia/Shanghai)");
  // What the output said about the account's quota is the account's, and not in the Run's log.
  assert.deepEqual(state.usage.map(({ window, used }) => [window, used]), [['five_hour', 0.99], ['seven_day', 0.51]]);
  assert.deepEqual(w.runner.events(run.id).map(({ kind }) => kind), ['diagnostic', 'turn.end']);
  assert.equal(w.f.count('outbox'), 0);
});

test("a machine's own login refused by its executor is not a quota: the round ends as auth, the login takes no more work, nothing rests, and the owner is told once", async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = (await w.tick(task))!;
  const ended = await w.ends(run, `${JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, result: 'Please run /login' })}\n`, 1);
  assert.equal(ended.exit_kind, 'auth');
  assert.equal(w.f.task(task.id).state, 'queued', '回到队列，等这份登录好了或换一份登录');
  assert.equal(JSON.parse(ended.error_json!).reason, '机器上的登录失效了：到那台机器上重新登录这个执行器，机器报告已登录后接着做');
  const state = w.f.ledger.loginState(T1);
  assert.equal(state.rest_until, null, '不是额度，不歇');
  assert.ok(state.auth_failed_at !== null, '这份登录记下了被拒');
  assert.deepEqual(w.f.peek<{ kind: string }>('SELECT kind FROM outbox').map(({ kind }) => kind), ['machine_login_refused']);
});

test('a Task that names no account goes on by itself on the next account, told to check the site, in a new session', async (t) => {
  const w = world(t);
  const task = w.queued({ roleId: 'verify' });
  w.f.ledger.addInput(task.id, '顺便改下文档', USER);
  const first = (await w.tick(task))!;
  assert.equal(first.login_id, T1);
  await w.usedUp(first);
  const second = (await w.tick(task))!;
  assert.deepEqual([second.login_id, second.host, second.state], [T2, 'h2', 'running']);
  assert.equal(w.f.task(task.id).login_id, null, '任务自己不被改写：下一轮重新选');
  const snapshot = w.snapshotOf(second);
  assert.match(snapshot.brief, /## 现场提示\n\n上一轮因执行器额度用尽中断，本轮自动接续/);
  assert.equal(snapshot.session_ref, undefined, '换执行器是新会话');
  assert.deepEqual(snapshot.inputs, [], '绑定过的插话不重发');
  const [round] = snapshot.history as { exit_kind: string; unconfirmed_inputs: { text: string }[] }[];
  assert.deepEqual([round!.exit_kind, round!.unconfirmed_inputs.map(({ text }) => text)], ['quota', ['顺便改下文档']]);
  assert.equal((await w.done(second)).exit_kind, 'completed');
  assert.equal(w.f.task(task.id).state, 'ready');
  // The only thing said is the result the finished work is (project-sessions §2.1).
  assert.deepEqual(w.f.peek<{ kind: string }>('SELECT kind FROM outbox').map(({ kind }) => kind), ['work_ready'], '一路没有找主人');
});

test('a pinned Task waits in the queue for its account, is not held, and goes when the rest is over; "try now" lets it go at once', async (t) => {
  const w = world(t);
  const task = w.queued({ loginId: T1 });
  await w.usedUp((await w.tick(task))!);
  assert.equal(await w.tick(task), undefined);
  assert.equal(await w.tick(task), undefined);
  assert.deepEqual([w.f.task(task.id).state, w.runsOf(task).length], ['queued', 1]);
  const until = w.f.ledger.loginState(T1).rest_until!;
  assert.deepEqual(w.wait(task), { rest: { login: 'h1/claude', until }, full: [], no_machine: [] });
  // Tasks behind it that can go elsewhere still go.
  const other = w.queued({ title: '别的' });
  assert.equal((await w.tick(other))?.login_id, T2);
  w.advance(REST - MINUTE);
  assert.equal(await w.tick(task), undefined, '没到时刻');
  w.advance(2 * MINUTE);
  assert.equal(w.wait(task), null);
  const again = (await w.tick(task))!;
  assert.deepEqual([again.login_id, again.state], [T1, 'running']);
  assert.match(w.snapshotOf(again).brief, /先核对现场/);
  assert.equal(w.snapshotOf(again).session_ref, 'quota-session');
  // Used up again at once, and the owner says to try now.
  await w.usedUp(again);
  assert.equal(await w.tick(task), undefined);
  w.f.ledger.endRest(T1, USER);
  assert.equal((await w.tick(task))?.login_id, T1);
});

test('when every account of a Task rests, it waits for the one that comes back first', async (t) => {
  const w = world(t);
  const task = w.queued();
  const seconds = Math.floor(Date.now() / 1000);
  await w.usedUp((await w.tick(task))!, seconds + 4 * 3600);
  await w.usedUp((await w.tick(task))!, seconds + 3600);
  assert.equal(await w.tick(task), undefined);
  assert.deepEqual(w.wait(task), { rest: { login: 'h2/claude', until: new Date((seconds + 3600) * 1000).toISOString() }, full: [], no_machine: [] });
  assert.equal(w.f.task(task.id).state, 'queued');
  w.advance(HOUR + MINUTE);
  assert.equal((await w.tick(task))?.login_id, T2, '先恢复的那个先用');
});

test('a account at its ceiling takes no more: the Task waits, goes when a Run ends, and clearing the ceiling lifts it', async (t) => {
  const w = world(t, (accounts) => {
    accounts.t1!.maxRuns = 1;
  });
  const first = w.queued({ loginId: T1 });
  const second = w.queued({ loginId: T1 });
  const third = w.queued({ loginId: T1 });
  const run = (await w.tick(first))!;
  assert.equal(await w.tick(second), undefined);
  assert.deepEqual([w.f.task(second.id).state, w.f.task(second.id).reason], ['queued', null], '等着，不进“等你”');
  assert.deepEqual(w.wait(second), { rest: null, full: ['h1/claude'], no_machine: [] });
  // A Task that names no account does not wait for it.
  assert.equal((await w.tick(w.queued({ title: '不指定' })))?.login_id, T2);
  await w.done(run);
  assert.equal((await w.tick(second))?.login_id, T1, '空出来就派');
  assert.equal(await w.tick(third), undefined);
  delete w.accounts.t1!.maxRuns;
  assert.equal((await w.tick(third))?.login_id, T1, '清掉上限恢复不限');
  assert.equal(w.f.ledger.getMachineLogin('h1', 'claude')!.maxRuns, undefined);
});

test('Tasks that name no account follow the tier’s global order without letting the first account queue alone, by the setting', async (t) => {
  const w = world(t);
  const given: string[] = [];
  for (let n = 0; n < 4; n += 1) given.push((await w.tick(w.queued({ title: `任务 ${n}` })))!.login_id!);
  assert.deepEqual(given, [T1, T2, T1, T2]);
  w.setLead(1000);
  assert.equal((await w.tick(w.queued({ title: '严格按顺序' })))?.login_id, T1);
  assert.equal((await w.tick(w.queued({ title: '还是第一个' })))?.login_id, T1);
  // The order is the tier's global one; the project's list only says which logins are allowed.
  w.f.ledger.setProjectLogins(w.f.projectId, [T2, T1], USER);
  assert.equal((await w.tick(w.queued({ title: '项目清单的顺序不算' })))?.login_id, T1);
  tune(w.f.ledger, 'dispatch.order.execute', [T2, T1]);
  assert.equal((await w.tick(w.queued({ title: '按全局顺序' })))?.login_id, T2);
  // A writable role on the decide tier: a read-only one waits for a machine that reported its
  // read-only way (readonly-dispatch.test.ts).
  assert.equal((await w.tick(w.queued({ title: '只有 t1 有', tierOverride: { tier: 'decide', reason: '要先想清楚' } })))?.login_id, T1);
});

test('a account near the end of its quota goes last when quota.warnPercent is reached until the window starts over', async (t) => {
  const w = world(t);
  const resets = new Date(Date.now() + HOUR).toISOString();
  // Default quota.warnPercent is 100: at 93% usage, #1 is NOT silently bypassed.
  w.f.ledger.noteUsage(T1, [{ window: 'five_hour', used: 0.93, resetsAt: resets }, { window: 'seven_day', used: 0.2, resetsAt: resets }]);
  assert.equal((await w.tick(w.queued()))?.login_id, T1, '默认 100% 时 93% 仍走第一优先级');
  // Once usage reaches 100%, #1 goes last until the window starts over.
  w.f.ledger.noteUsage(T1, [{ window: 'five_hour', used: 1.0, resetsAt: resets }, { window: 'seven_day', used: 0.2, resetsAt: resets }]);
  assert.equal((await w.tick(w.queued()))?.login_id, T2);
  assert.equal((await w.tick(w.queued()))?.login_id, T2, '别的还能用就不给它，哪怕别的更忙');
  // Pinned to it, it is still used: the figure orders accounts, it does not close one.
  assert.equal((await w.tick(w.queued({ loginId: T1 })))?.login_id, T1);
  w.advance(HOUR + MINUTE);
  assert.equal((await w.tick(w.queued()))?.login_id, T1, '窗口重置后数字不再算数');
});

test('a Task no account of its project can ever take is held with the reason, and does not block the queue', async (t) => {
  // No account holds the decide tier: the Task can never be placed, and says so. A tier
  // name outside the two would never reach the queue at all (docs/design/roles-and-tiers.md §8).
  const w = world(t, (accounts) => { accounts.t1!.tiers = { execute: claudeTier('/tiers/execute.json') }; });
  const stuck = w.queued({ roleId: 'analyse' });
  const fine = w.queued();
  await w.dispatcher.tick();
  assert.deepEqual([w.f.task(stuck.id).state, w.f.task(stuck.id).reason], ['held', '派发失败：没有可用的登录：项目允许的登录里没有带档位 decide 的']);
  assert.equal((await w.tick(fine))?.login_id, T1);
});

test('a Run out of contact on a account with a ceiling of one is still judged: it does not count against its own continuation', async (t) => {
  const w = world(t, (accounts) => {
    accounts.t1!.maxRuns = 1;
    delete accounts.t2;
  });
  const task = w.queued();
  const run = (await w.tick(task))!;
  w.f.ledger.markRunUnknown(run.id);
  assert.equal(w.wait(task), null, '它自己占的那一轮不算');
  // A second Run on the account would: then the continuation has nowhere to go yet.
  const other = w.queued({ title: '别的' });
  w.f.ledger.markRunRunning(w.f.ledger.createRun(other.id, { ...w.f.login, machine: w.f.ledger.getMachine('h1')!, login: stripped(w.f.ledger.getMachineLogin('h1', 'claude')!) }, USER).id);
  assert.deepEqual(w.wait(task), { rest: null, full: ['h1/claude'], no_machine: [] });
});

test('a start already on its way goes out while its account rests, and so does one on another account', async (t) => {
  const w = world(t);
  const going = w.queued({ loginId: T1, title: '在跑的' });
  const run = (await w.tick(going))!;
  const early = w.queued({ loginId: T1, title: '歇之前建的' });
  // Created before the rest, started after it began: the upload is held meanwhile.
  const release = w.remote.hold('upload');
  const ticking = w.dispatcher.tick();
  const created = async (): Promise<RunRow> => {
    for (;;) {
      const found = w.runsOf(early)[0];
      if (found && w.remote.called('upload', found.id) > 0) return found;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  const launching = await created();
  await w.usedUp(run);
  assert.ok(restingUntil(w.f.ledger.loginState(T1), Date.now()));
  release();
  await ticking;
  assert.equal(w.remote.called('start.sh', launching.id), 1, '歇着不是配置变了：发启动前的校验照常通过');
  assert.equal(w.f.run(launching.id).state, 'running');
  const elsewhere = (await w.tick(w.queued({ title: '别的目标' })))!;
  assert.deepEqual([elsewhere.login_id, w.remote.called('start.sh', elsewhere.id)], [T2, 1]);
});

test('a quota round that continued by itself is ordinary progress: nothing goes to WeCom, whatever the Router says', async (t) => {
  const w = world(t);
  const notify = createNotify({ ledger: w.f.ledger, owner: () => 'zhang', direct: async () => {} });
  const task = w.queued();
  const run = (await w.tick(task))!;
  await w.usedUp(run);
  const event = w.f.ledger.listMessages({ limit: 100 }).find((row) => row.external_id === `run:${run.id}`)!;
  const reply = w.f.ledger.writeOutbound({ channel: event.channel, thread: event.thread, text: '额度用完了，需要你处理', final: true, replyTo: event.id });
  notify.finalReply(event, reply);
  assert.equal(w.f.count('outbox'), 0);
});

test('a Run the owner stops, whose output ends on a used-up quota, ends as interrupted, and the Runner still says so for the account', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = (await w.tick(task))!;
  // The quota ran out under it, and the stop arrives before anyone has looked.
  Object.assign(w.remote.runOf(run.id), { stdout: quotaOutput(), exit: 1 });
  assert.equal(await w.runner.interrupt(w.f.run(run.id), USER), 'ended');
  assert.equal(w.f.run(run.id).exit_kind, 'interrupted');
  assert.deepEqual([w.f.task(task.id).state, w.f.task(task.id).reason], ['held', '已中断']);
  near(w.f.ledger.loginState(T1).rest_until, Date.now() + REST, '目标照样歇');
});

// docs/design/accounts-machines-decoupled.md: a machine's own login goes nowhere but its own
// machine, whatever the project allows; the project's machines narrow it, they never widen it.
test("a machine's own login runs on its machine alone, and only while the project's machines hold it", async (t) => {
  const w = world(t);
  w.f.ledger.setProjectMachines(w.f.projectId, uidsOf(w.f.ledger, ['h2']), USER);
  const pinned = w.queued({ loginId: T1 });
  assert.equal(await w.tick(pinned), undefined, 'h1 的登录不会被派到 h2');
  assert.equal(w.f.task(pinned.id).state, 'queued');
  assert.deepEqual(w.wait(pinned)?.no_machine, ['h1/claude']);
  w.f.ledger.setProjectMachines(w.f.projectId, uidsOf(w.f.ledger, []), USER);
  const run = (await w.tick(pinned))!;
  assert.deepEqual([run.login_id, run.machine_id], [T1, 'h1']);
});

// An account and h1's own login, both on h1: two logins, each with its own ceiling, rest
// and usage.
test('two logins on one machine hold separate ceilings, quota rests and usage', async (t) => {
  const w = world(t, accounts => {
    accounts.t1!.maxRuns = 1;
    accounts.t2 = { id: 'acct', name: 'acct', executor: 'claude', maxRuns: 1, tiers: { execute: claudeTier('/tiers/execute.json') } };
  });
  const T2 = 'acct';
  w.f.ledger.setProjectMachines(w.f.projectId, uidsOf(w.f.ledger, ['h1']), USER);
  const first = w.queued({loginId:T1});
  const second = w.queued({loginId:T2});
  const one = (await w.tick(first))!;
  const two = (await w.tick(second))!;
  assert.deepEqual([one.machine_id,two.machine_id], ['h1','h1']);
  assert.deepEqual([one.login_id,two.login_id], [T1,T2]);
  w.f.ledger.noteUsage(T1,[{window:'five_hour',used:0.9,resetsAt:null}]);
  assert.equal(w.f.ledger.loginState(T2).usage.length,0);
  await w.usedUp(one);
  assert.ok(w.f.ledger.loginState(T1).rest_until);
  assert.equal(w.f.ledger.loginState(T2).rest_until,null);
  assert.equal(w.f.run(two.id).state,'running');
  await w.done(two);
  assert.equal(w.f.task(second.id).state,'ready');
});

test('a blocked project does not deny another project the same account on an allowed machine', async (t) => {
  // An account: its login goes with the round, so it may run on h1 or h2.
  const w = world(t, accounts => { accounts.t1 = { id: 'acct', name: 'acct', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } }; });
  const T1 = 'acct';
  w.f.ledger.setProjectMachines(w.f.projectId,uidsOf(w.f.ledger,['h1']),USER);
  w.remote.down.add('h1');
  const blocked = w.queued({loginId:T1});
  const other = w.f.ledger.createProject({name:'另一项目',logins:[T1],machines:uidsOf(w.f.ledger,['h2'])},USER);
  const task = w.f.ledger.createTask({ roleId: 'implement', projectId:other,title:'另一任务',goal:'目标',acceptance:'通过',loginId:T1},USER);
  w.f.ledger.queueTask(task.id,USER);
  await w.dispatcher.tick();
  assert.equal(w.f.task(blocked.id).state,'queued');
  assert.equal(w.f.ledger.listRuns(task.id)[0]?.machine_id,'h2');
  assert.deepEqual(w.wait(blocked)?.no_machine,[T1]);
});

test('refuseLogin on OAuth lease sets rest_seq to change watermark instead of NULL + 1', (t) => {
  const leaseFailures: { loginId: string; ref: string }[] = [];
  const f = fixture(t, {
    onOAuthLeaseAuthFailure: (loginId, ref) => { leaseFailures.push({ loginId, ref }); },
  });
  const account: Login = {
    id: 'oauth-codex-1',
    name: 'oauth-codex',
    executor: 'claude',
    tiers: LOGIN.login.tiers,
  };
  f.ledger.putAccount(account, USER, 'oauth-lease-1');
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, {
    login: account,
    machine: f.ledger.getMachine('h1')!,
    expectedRevision: f.task(task.id).revision,
    snapshot: { brief: 'b', timeout_ms: 60_000, credential_ref: 'oauth-lease-1' },
  }, USER);
  f.ledger.markRunRunning(run.id);

  // Settle as auth failure while login_state has no prior row (rest_seq starts as NULL)
  f.ledger.settleRun(run.id, 1, null, { kind: 'auth', reason: '401 unauthorized' });

  const stateRow = f.peek<{ rest_seq: number | null; rest_until: string | null; rest_reason: string | null }>(
    'SELECT rest_seq, rest_until, rest_reason FROM login_state WHERE id = ?',
    account.id,
  )[0];
  assert.ok(stateRow, 'login_state row exists');
  assert.equal(typeof stateRow.rest_seq, 'number', 'rest_seq must be a numeric change watermark, never NULL');
  assert.ok(stateRow.rest_seq! > 0, 'rest_seq must reflect actual change.seq watermark');
  assert.ok(stateRow.rest_until !== null);
  assert.match(stateRow.rest_reason ?? '', /核对并续期/);
});
