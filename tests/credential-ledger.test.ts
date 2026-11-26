// Guards against token rejection being counted as a Task failure or loss, redispatched
// before replacement, notified more than once, or committed apart from its Task and
// notification; against a late result from a replaced or cleared token marking the
// account again; and against credentials or learned state entering account audit data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { credentialRejected } from '../service/ledger.ts';
import { LOGIN, DONE, fixture, USER, DISPATCH_TUNED, RUN_LIMIT_MS } from './helpers.ts';
import type { Account } from '../runner/snapshot.ts';
import { SETTINGS } from '../service/settings.ts';

class Crash extends Error {}
const AUTH = { kind: 'auth' as const, sessionRef: 'auth-session' };
const REF_A = 'ref-0000-0000-0000-00000000000a';
const REF_B = 'ref-0000-0000-0000-00000000000b';
// The account the Runs here are made on, on the fixture's machine.
const T1: Account = { id: 't1', name: 't1', executor: 'claude', tiers: LOGIN.login.tiers };
// The account the Run is made on uses this number, the way the console would have set it.
const withRef = (f: ReturnType<typeof fixture>, ref: string): void => {
  if (f.ledger.getAccount('t1')) f.ledger.recordAccountCredential('t1', ref, USER);
  else f.ledger.putAccount(T1, USER, ref);
};
const start = (f: ReturnType<typeof fixture>, taskId: string) => {
  const run = f.ledger.createRun(taskId, { ...f.login, login: T1, snapshot: { ...f.login.snapshot, executor: 'claude' }, expectedRevision: f.task(taskId).revision }, USER);
  f.ledger.markRunRunning(run.id);
  return run;
};

test('token rejection queues the Task, marks only its account, and notifies once per token', (t) => {
  const f = fixture(t);
  withRef(f, REF_A);
  f.ledger.putAccount({ ...T1, id: 'other', name: 'other' }, USER, 'ref-other');
  const task = f.queuedTask();
  const run = start(f, task.id);
  assert.equal(JSON.parse(run.snapshot_json).credential_ref, REF_A);
  assert.deepEqual(f.ledger.settleRun(run.id, 1, null, AUTH), { late: false, task_state: 'queued' });
  assert.equal(f.run(run.id).exit_kind, 'auth');
  assert.equal(f.run(run.id).session_ref, 'auth-session');
  assert.equal(f.task(task.id).reason, null);
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, REF_A);
  assert.equal(f.ledger.loginState('other').credential_rejected_ref, null);
  assert.equal(f.ledger.loginState('t1').rest_until, null);
  assert.equal(f.count('outbox'), 1);
  const notice = f.peek<{ kind: string; payload_json: string }>('SELECT * FROM outbox')[0]!;
  assert.equal(notice.kind, 'account_credential_rejected');
  assert.equal(JSON.parse(notice.payload_json).account_id, 't1');
  assert.equal(JSON.parse(notice.payload_json).external_id, `account-credential:${REF_A}`);
  f.ledger.settleRun(run.id, 1, null, AUTH);
  const otherTask = f.queuedTask();
  f.ledger.settleRun(start(f, otherTask.id).id, 1, null, AUTH);
  assert.equal(f.count('outbox'), 1, 'concurrent rounds and repeated settlement share one rejection');
  assert.equal(f.ledger.lostLimitReached(task.id), false);
});

test('a token the Router itself was refused for marks the same account, from the number that process held', (t) => {
  const f = fixture(t);
  withRef(f, REF_A);
  f.ledger.rejectCredential('t1', REF_A);
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, REF_A);
  assert.equal(credentialRejected(f.ledger.loginState('t1'), REF_A), true, 'Worker 那边也把这个令牌当作不能用');
  assert.equal(f.count('outbox'), 1);
  const notice = f.peek<{ kind: string; payload_json: string }>('SELECT * FROM outbox')[0]!;
  assert.equal(notice.kind, 'account_credential_rejected');
  assert.equal(JSON.parse(notice.payload_json).external_id, `account-credential:${REF_A}`);
  f.ledger.rejectCredential('t1', REF_A);
  assert.equal(f.count('outbox'), 1, '同一个令牌被拒一次只说一次');
  // A token filled in since: the process's failure speaks for the number it held, and
  // the new one is not blocked by it.
  withRef(f, REF_B);
  f.ledger.rejectCredential('t1', REF_A);
  assert.equal(credentialRejected(f.ledger.loginState('t1'), REF_B), false, '旧进程的失败不封新令牌');
  assert.equal(f.count('outbox'), 1);
  f.ledger.rejectCredential('t1', REF_B);
  assert.equal(credentialRejected(f.ledger.loginState('t1'), REF_B), true, '新令牌被拒是另一次失效');
  assert.equal(f.count('outbox'), 2);
  // An account the ledger does not hold, and one whose number it no longer names.
  f.ledger.rejectCredential('gone', REF_B);
  assert.equal(f.count('outbox'), 2, '没有这个账号就没有可归属的失效');
});

test('a late result from a replaced or cleared token neither marks nor tells anyone', (t) => {
  const f = fixture(t);
  withRef(f, REF_A);
  // Three rounds started while the failed token was the account's; the later ones
  // finish only after the token has been replaced or cleared. One active Run per Task,
  // so each gets its own.
  const first = start(f, f.queuedTask().id);
  const second = start(f, f.queuedTask().id);
  const third = start(f, f.queuedTask().id);
  assert.equal(f.ledger.settleRun(first.id, 1, null, AUTH).late, false);
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, REF_A);
  assert.equal(f.count('outbox'), 1);
  // The owner replaces it with a working one. The mark names the old number and means
  // nothing any more.
  withRef(f, REF_B);
  assert.equal(credentialRejected(f.ledger.loginState('t1'), REF_B), false);
  assert.equal(f.ledger.settleRun(second.id, 1, null, AUTH).late, false);
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, REF_A, '旧编号晚到的结果不改账号');
  assert.equal(credentialRejected(f.ledger.loginState('t1'), REF_B), false);
  assert.equal(f.count('outbox'), 1, '旧编号晚到的结果不发通知');
  // And the same after the owner replaces it once more.
  withRef(f, 'ref-0000-0000-0000-00000000000c');
  f.ledger.settleRun(third.id, 1, null, AUTH);
  assert.equal(credentialRejected(f.ledger.loginState('t1'), 'ref-0000-0000-0000-00000000000c'), false);
  assert.equal(f.count('outbox'), 1);
});

test('replacing a token writes only the action and account id, a new token can be refused afresh, and none is ever cleared', (t) => {
  const f = fixture(t);
  withRef(f, REF_A);
  const first = start(f, f.queuedTask().id);
  f.ledger.settleRun(first.id, 1, null, AUTH);
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, REF_A);
  f.ledger.recordAccountCredential('t1', REF_B, USER);
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, REF_A, '换新令牌不清旧标记，标记自己失效');
  assert.equal(credentialRejected(f.ledger.loginState('t1'), REF_B), false);
  const second = start(f, f.queuedTask().id);
  assert.equal(JSON.parse(second.snapshot_json).credential_ref, REF_B);
  f.ledger.settleRun(second.id, 1, null, AUTH);
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, REF_B);
  assert.equal(f.count('outbox'), 2, '新令牌失效是另一次失效');
  assert.equal(credentialRejected(f.ledger.loginState('t1'), null), false);
  // Made with REF_A, then replaced with REF_B: one row for the replacement, its creation is
  // the account's own row.
  assert.deepEqual(f.peek<{ detail_json: string }>("SELECT * FROM change WHERE action LIKE 'account.credential%' ORDER BY seq").map(row => JSON.parse(row.detail_json)),
    [{ account_id: 't1' }]);
  assert.equal(f.peek("SELECT 1 FROM change WHERE action = 'account.credential_clear'").length, 0);
  assert.throws(() => f.ledger.recordAccountCredential('gone', REF_A, USER), /账号不存在/);
});

test('auth rounds do not count as losses and do not erase losses around them', (t) => {
  const f = fixture(t);
  withRef(f, REF_A);
  const task = f.queuedTask();
  for (let n = 0; n < SETTINGS['run.maxLostContinuations'].default + 2; n++) {
    f.ledger.settleRun(start(f, task.id).id, 1, null, AUTH);
    assert.equal(f.task(task.id).state, 'queued');
  }
  for (let n = 1; n < SETTINGS['run.maxLostContinuations'].default; n++) {
    f.ledger.settleRun(start(f, task.id).id, 1, null, { kind: 'lost' });
    f.ledger.settleRun(start(f, task.id).id, 1, null, AUTH);
  }
  f.ledger.settleRun(start(f, task.id).id, 1, null, { kind: 'lost' });
  assert.equal(f.task(task.id).state, 'held');
  assert.match(f.task(task.id).reason!, /连续 3 次执行都丢失/);
});

for (const point of ['afterSettleRunWrite', 'beforeCommit', 'afterCommit'] as const) {
  test('auth settlement remains atomic at '+point, (t) => {
    let armed = false;
    const f = fixture(t, { testHooks: {
      ...(point === 'afterCommit'
        ? { afterCommit(actions: string[], retire: () => void) { if (armed && actions.includes('run.settle')) { retire(); throw new Crash(); } } }
        : { [point]() { if (armed) throw new Crash(); } }),
    } });
    withRef(f, REF_A);
    const task = f.queuedTask();
    const run = start(f, task.id);
    const before = f.dump();
    armed = true;
    assert.throws(() => f.ledger.settleRun(run.id, 1, null, AUTH), Crash);
    armed = false;
    if (point !== 'afterCommit') {
      assert.deepEqual(f.dump(), before);
      f.ledger.settleRun(run.id, 1, null, AUTH);
    }
    const reopened = f.open();
    assert.equal(reopened.getRun(run.id).exit_kind, 'auth');
    assert.equal(reopened.getTask(task.id).state, 'queued');
    assert.equal(reopened.loginState('t1').credential_rejected_ref, REF_A);
    assert.equal(f.count('outbox'), 1);
  });
}

test('dispatcher skips rejected accounts, waits without a clock, then resumes Claude after replacement', async (t) => {
  const f = fixture(t);
  withRef(f, REF_A);
  const task = f.queuedTask();
  f.ledger.setProjectLogins(f.projectId, ['t1'], USER);
  const first = start(f, task.id);
  f.ledger.settleRun(first.id, 1, null, AUTH);
  const launches: string[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    ledger: f.ledger,
    logins: { get: (id: string) => f.ledger.getAccount(id), list: () => f.ledger.listAccounts() },
    executors: { claude: claudeAdapter },
    machines: { get: id => f.ledger.getMachine(id), list: () => f.ledger.listMachines() },
    runner: {
      findMachine: async (_account, machines) => machines[0], lostCandidates: () => [],
      presume: async () => 'unknown', sweep: async () => {}, watch: async () => {},
      launch: async run => { launches.push(run.id); },
    },
    runTimeoutMs: () => 60_000, now: () => Date.now() + 10 ** 12,
  });
  t.after(() => dispatcher.stop());
  assert.deepEqual(dispatcher.waitOf(f.task(task.id)), { rest: null, full: [], no_machine: [], rejected: ['t1'] });
  await dispatcher.tick();
  assert.deepEqual(launches, []);
  f.ledger.recordAccountCredential('t1', REF_B, USER);
  await dispatcher.tick();
  assert.equal(launches.length, 1);
  const snapshot = JSON.parse(f.ledger.getRun(launches[0]!).snapshot_json);
  assert.equal(snapshot.session_ref, 'auth-session');
  assert.equal(snapshot.credential_ref, REF_B);
  assert.match(snapshot.brief, /先核对现场/);
  assert.equal(snapshot.history[0].exit_kind, 'auth');
  f.ledger.settleRun(launches[0]!, 0, DONE);
});

test('a rejected account sends an unpinned Task to its next account without replaying attached inputs', async (t) => {
  const f = fixture(t);
  withRef(f, REF_A);
  f.ledger.putAccount({ ...T1, id: 't2', name: 't2' }, USER, 'ref-t2');
  f.ledger.setProjectLogins(f.projectId, ['t1', 't2'], USER);
  const task = f.ledger.createTask({ projectId: f.projectId, title: '换账号', goal: '目标', acceptance: '通过', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  f.ledger.addInput(task.id, '上一轮的输入', USER);
  const first = start(f, task.id);
  f.ledger.settleRun(first.id, 1, null, AUTH);
  const launched: string[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    ledger: f.ledger,
    logins: { get: (id: string) => f.ledger.getAccount(id), list: () => f.ledger.listAccounts() },
    executors: { claude: claudeAdapter },
    machines: { get: id => f.ledger.getMachine(id), list: () => f.ledger.listMachines() },
    runner: {
      findMachine: async (_account, machines) => machines[0], lostCandidates: () => [],
      presume: async () => 'unknown', sweep: async () => {}, watch: async () => {},
      launch: async run => { launched.push(run.id); },
    },
    runTimeoutMs: () => 60_000,
  });
  t.after(() => dispatcher.stop());
  await dispatcher.tick();
  assert.equal(launched.length, 1);
  const next = f.ledger.getRun(launched[0]!);
  assert.equal(next.login_id, 't2');
  const snapshot = JSON.parse(next.snapshot_json);
  assert.equal(snapshot.session_ref, undefined);
  assert.equal(snapshot.credential_ref, 'ref-t2', '换到 t2，快照里是 t2 自己的令牌编号');
  assert.deepEqual(snapshot.inputs, []);
  assert.deepEqual(snapshot.history[0].unconfirmed_inputs.map((input: { text: string }) => input.text), ['上一轮的输入']);
  assert.match(snapshot.brief, /先核对现场/);
});

test('rejection replaces a previously observed no-machine wait', async t => {
  const f = fixture(t);
  withRef(f, REF_A);
  const task = f.queuedTask();
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED, ledger: f.ledger,
    logins: { get: (id: string) => f.ledger.getAccount(id), list: () => f.ledger.listAccounts() },
    executors: { claude: claudeAdapter },
    machines: { get: id => f.ledger.getMachine(id), list: () => f.ledger.listMachines() },
    runner: { findMachine: async () => undefined, lostCandidates: () => [], presume: async () => 'unknown',
      sweep: async () => {}, watch: async () => {}, launch: async () => {} },
    runTimeoutMs: () => 60_000,
  });
  t.after(() => dispatcher.stop());
  // Pin the task so it has the same candidate even without a project preference.
  f.ledger.updateTask(task.id, { loginId: 't1' }, USER);
  await dispatcher.tick();
  assert.equal(dispatcher.waitingLogins().length, 1);
  const run = start(f, task.id);
  f.ledger.settleRun(run.id, 1, null, AUTH);
  await dispatcher.tick();
  assert.equal(dispatcher.waitingLogins().length, 0);
  assert.deepEqual(dispatcher.waitOf(f.task(task.id)), { rest: null, full: [], no_machine: [], rejected: ['t1'] });
});

// A paused project's Task waits for the resume, not for a login: the login's state is no reason
// to show for it, and no round starts for it (project-sessions, "按项目暂停").
test('a paused project\'s queued Task shows no login wait and gets no round until the resume', async (t) => {
  const f = fixture(t);
  withRef(f, REF_A);
  const task = f.queuedTask();
  f.ledger.setProjectLogins(f.projectId, ['t1'], USER);
  const first = start(f, task.id);
  f.ledger.settleRun(first.id, 1, null, AUTH);
  const launches: string[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    ledger: f.ledger,
    logins: { get: (id: string) => f.ledger.getAccount(id), list: () => f.ledger.listAccounts() },
    executors: { claude: claudeAdapter },
    machines: { get: id => f.ledger.getMachine(id), list: () => f.ledger.listMachines() },
    runner: {
      findMachine: async (_account, machines) => machines[0], lostCandidates: () => [],
      presume: async () => 'unknown', sweep: async () => {}, watch: async () => {},
      launch: async run => { launches.push(run.id); },
    },
    runTimeoutMs: () => 60_000, now: () => Date.now() + 10 ** 12,
  });
  t.after(() => dispatcher.stop());
  f.ledger.setProjectPaused(f.projectId, true, USER);
  assert.equal(dispatcher.waitOf(f.task(task.id)), null);
  await dispatcher.tick();
  assert.deepEqual(launches, []);
  f.ledger.setProjectPaused(f.projectId, false, USER);
  assert.deepEqual(dispatcher.waitOf(f.task(task.id)), { rest: null, full: [], no_machine: [], rejected: ['t1'] });
});
