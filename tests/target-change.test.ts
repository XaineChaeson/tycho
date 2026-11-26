// Guards against a login, or the machines a project allows, that the owner changes while
// the service is in the middle of using it. Accounts are read at each use, which made every wait on a machine a window:
// a probe that answered was taken as a licence, so a Run was created and started on a
// machine the owner had just taken out, or under a configuration just replaced; an
// upload that arrived was followed by a start whatever had changed meanwhile; and a Run
// was wherever its account pointed at the moment of each call, so another client joining
// under its machine's name got its start, its stop and the reads of its output, where
// nothing of it was. Each window is stood in here, on machines that
// share no files.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner, HistoryLoadError } from '../runner/runner.ts';
import type { Snapshot, Account, Machine } from '../runner/snapshot.ts';
import { prepareSnapshot } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { InputError } from '../service/errors.ts';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import type { FakeRemote } from './fake-remote.ts';
import { fakeSites } from './fake-remote.ts';
import { claudeTier, DISPATCH_TUNED, DONE, fixture, holdMachine, RUN_LIMIT_MS, RUNNER_TUNED, testCredentialRef, testMachine, tuned, uidsOf } from './helpers.ts';

const OWNER = { actor: 'console' };
// Two clients that join under the same names: the names are different machines under each.
const A = 'client-a';
const B = 'client-b';
const under = (identity: string, id: string): Machine => testMachine(id, id, `${identity}#${id}`);

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 5000; n += 1) {
    if (check()) return;
    await sleep(1);
  }
  assert.fail(`等不到：${what}`);
}

// The service's own arrangement: one ledger that holds the accounts, a Runner and a
// dispatcher that ask it at each use, and the owner changing the ledger between two
// of their steps.
function world(t: TestContext, hosts = ['h1']) {
  const f = fixture(t, {}, false);
  const { sites, connect } = fakeSites(A, B);
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  // An account: it may run on any machine the project allows, which the owner narrows on
  // the project (docs/design/accounts-machines-decoupled.md).
  const account = (fields: Partial<Account> = {}): Account => ({
    id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') }, ...fields,
  });
  const owner = {
    sets: ({ machines: allowed, ...fields }: Partial<Account> & { machines?: string[] }): void => {
      if (allowed !== undefined) f.ledger.setProjectMachines(f.projectId, uidsOf(f.ledger, allowed), OWNER);
      if (Object.keys(fields).length > 0 || !f.ledger.getAccount('t1')) f.ledger.putAccount(account(fields), OWNER, f.ledger.getAccount('t1') ? undefined : testCredentialRef('t1'));
    },
    // Every machine is deleted and another client joins under its name; the owner lets the
    // new ones into the project as the old ones were (a new machine inherits no permission).
    rejoins: (identity: string): void => {
      const allowed = f.ledger.projectMachines(f.projectId).machines.map(({ name }) => name);
      for (const held of f.ledger.listMachines()) holdMachine(f.ledger, under(identity, held.id));
      f.ledger.setProjectMachines(f.projectId, uidsOf(f.ledger, allowed), OWNER);
    },
    deletes: (): void => { f.ledger.deleteAccount('t1', OWNER, { confirmed: true }); },
  };
  for (const id of new Set([...hosts, 'h2'])) holdMachine(f.ledger, under(A, id));
  owner.sets({ machines: hosts });
  const accounts = { get: f.ledger.getAccount, list: f.ledger.listAccounts };
  const machines = { get: f.ledger.getMachine, list: f.ledger.listMachines };
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: accounts, machines, connect, log,
    credential: (id) => { const ref = f.ledger.accountCredentialRef(id); return ref === null ? undefined : { ref, value: 'token' }; },
  });
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    ledger: f.ledger,
    runTimeoutMs: tuned('run.timeoutMs'),
    // No watcher: every look at a Run is one the test asked for.
    runner: { ...runner, watch: async () => {} },
    logins: accounts, machines,
    executors: { claude: claudeAdapter },
    log,
  });
  t.after(() => dispatcher.stop());
  const runsOf = (task: TaskRow): RunRow[] => f.ledger.listRuns(task.id);
  return {
    f, a: sites[A], b: sites[B], logs, owner, runner, dispatcher, runsOf,
    queued(): TaskRow {
      const task = f.ledger.createTask(
        { projectId: f.projectId, title: '任务', goal: '目标', acceptance: '测试通过', loginId: 't1', roleId: 'implement' },
        OWNER,
      );
      f.ledger.queueTask(task.id, OWNER);
      return f.task(task.id);
    },
    // A round of dispatch, and the Run it started for the Task.
    async started(task: TaskRow): Promise<RunRow> {
      await dispatcher.tick();
      const run = runsOf(task).at(-1);
      assert.equal(run?.state, 'running');
      return run!;
    },
    // The owner acts while `work` waits on one call to a machine: the call has gone out
    // and has not been answered.
    async midway(site: FakeRemote, call: string, change: () => void, work: () => Promise<unknown>): Promise<void> {
      const before = site.called(call);
      const release = site.hold(call);
      const working = work();
      await eventually(() => site.called(call) > before, `${call} 发出`);
      change();
      release();
      await working;
    },
    lostBasis: (run: RunRow): unknown => (JSON.parse(f.run(run.id).error_json ?? '{}') as { lost?: { basis?: string } }).lost?.basis,
    snapshotOf: (run: RunRow): Snapshot => JSON.parse(f.run(run.id).snapshot_json) as Snapshot,
  };
}

// --- a probe that answered is a candidate, not a licence (review finding 1) ---

test('a machine taken out of the project while it is being probed gets no Run: the Task stays queued and the next round picks from the account as it is', async (t) => {
  const w = world(t);
  const task = w.queued();
  await w.midway(w.a, 'read', () => w.owner.sets({ machines: ['h2'] }), () => w.dispatcher.tick());
  assert.deepEqual(w.runsOf(task), [], '探测到的 h1 已经不在目标里，不能为它建 Run');
  assert.equal(w.f.task(task.id).state, 'queued');
  assert.equal(w.a.called('upload') + w.a.called('start.sh'), 0, '什么都不能发到被移除的机器上');
  assert.ok(w.logs.some((line) => line.includes('本轮未派发') && line.includes('允许范围')), w.logs.join('\n'));
  const run = await w.started(task);
  assert.equal(run.host, 'h2');
  assert.equal(w.a.called('start.sh', run.id, 'h2'), 1);
  assert.equal(w.a.called('start.sh', undefined, 'h1'), 0);
});

test('a account whose settings change while a machine is being probed is not dispatched under the old ones', async (t) => {
  const w = world(t);
  const task = w.queued();
  await w.midway(w.a, 'read', () => w.owner.sets({ tiers: { execute: claudeTier('/tiers/new.json') } }), () => w.dispatcher.tick());
  assert.deepEqual(w.runsOf(task), [], '快照是按旧的档位文件准备的');
  assert.equal(w.f.task(task.id).state, 'queued');
  const run = await w.started(task);
  assert.deepEqual(w.snapshotOf(run).tier_value, claudeTier('/tiers/new.json'));
});

test('a account deleted while a machine is being probed gets no Run, and the Task then stops for want of a account', async (t) => {
  const w = world(t);
  const task = w.queued();
  await w.midway(w.a, 'read', () => w.owner.deletes(), () => w.dispatcher.tick());
  assert.deepEqual(w.runsOf(task), []);
  assert.equal(w.f.task(task.id).state, 'queued', '这一轮只是没派出去');
  assert.equal(w.a.called('upload') + w.a.called('start.sh'), 0);
  await w.dispatcher.tick();
  assert.equal(w.f.task(task.id).state, 'held');
  assert.match(w.f.task(task.id).reason!, /没有可用的登录：指定的登录已删除，请重新选择/);
});

test('the ledger creates a Run only from current account and machine configurations, and snapshots both', (t) => {
  const w = world(t, ['h1', 'h2']);
  const account = w.f.ledger.getAccount('t1')!;
  const machine = w.f.ledger.getMachine('h1')!;
  const fields = { login: account, machine, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: 1 };
  const refused = (given: Partial<{ login: Account; machine: Machine }>, why: RegExp): void => {
    const task = w.queued();
    const before = w.f.dump();
    assert.throws(() => w.f.ledger.createRun(task.id, { ...fields, ...given }, OWNER),
      (err: Error) => err instanceof InputError && why.test(err.message));
    assert.deepEqual(w.f.dump(), before, '被拒的派发什么都不写');
  };
  holdMachine(w.f.ledger, under(A, 'h9'));
  refused({ machine: w.f.ledger.getMachine('h9')! }, /机器 h9 不在这份登录或项目的允许范围内/);
  refused({ login: { ...account, timeoutMs: 5 } }, /改过/);
  refused({ machine: { ...machine, nodeId: `${B}#h1` } }, /改过/);
  refused({ login: { ...account, id: 'gone', name: 'gone' } }, /账号 gone 已经不在了/);
  // A machine's own login of another machine is not this one's.
  w.f.ledger.putMachineLogin({ executor: 'claude', machine: 'h2', tiers: account.tiers }, OWNER);
  refused({ login: w.f.ledger.getMachineLogin('h2', 'claude')! }, /机器 h1 不在这份登录或项目的允许范围内/);
  const run = w.f.ledger.createRun(w.queued().id, fields, OWNER);
  assert.deepEqual(w.snapshotOf(run).login, {
    executor: 'claude', machine: null, tiers: { execute: claudeTier('/tiers/execute.json') },
    permission_mode: null, timeout_ms: null, max_runs: null,
  });
  assert.deepEqual(w.snapshotOf(run).machine, { host: 'h1', node_id: `${A}#h1` });
  const afterDeletion = w.queued();
  w.owner.deletes();
  const before = w.f.dump();
  assert.throws(() => w.f.ledger.createRun(afterDeletion.id, fields, OWNER), /账号 t1 已经不在了/);
  assert.deepEqual(w.f.dump(), before);
  // The snapshot records the account's token number, never the token.
  assert.equal(w.snapshotOf(run).credential_ref, testCredentialRef('t1'));
});

// --- asked again before the start goes out ---

test('a machine taken out of the account during the upload is sent no start: the Run ends as one on a removed machine and the Task goes on elsewhere', async (t) => {
  const w = world(t, ['h1', 'h2']);
  const task = w.queued();
  await w.midway(w.a, 'upload', () => w.owner.sets({ machines: ['h2'] }), () => w.dispatcher.tick());
  const [run] = w.runsOf(task);
  assert.equal(run!.host, 'h1');
  assert.equal(w.a.called('start.sh'), 0, '上传到了，启动不能发');
  assert.equal(w.f.run(run!.id).exit_kind, 'lost');
  assert.equal(w.lostBasis(run!), 'removed');
  assert.equal(w.f.task(task.id).state, 'queued');
  const next = await w.started(task);
  assert.equal(next.host, 'h2');
  assert.equal(w.a.called('start.sh', undefined, 'h1'), 0);
});

test('settings changed during the upload withhold the start too: the Run was prepared under what the owner has replaced', async (t) => {
  const w = world(t);
  const task = w.queued();
  await w.midway(w.a, 'upload', () => w.owner.sets({ tiers: { execute: claudeTier('/tiers/new.json') } }), () => w.dispatcher.tick());
  const [run] = w.runsOf(task);
  assert.equal(w.a.called('start.sh'), 0);
  assert.equal(w.lostBasis(run!), 'removed');
  const next = await w.started(task);
  assert.deepEqual(w.snapshotOf(next).tier_value, claudeTier('/tiers/new.json'));
});

test('a account deleted during the upload is sent no start', async (t) => {
  const w = world(t);
  const task = w.queued();
  await w.midway(w.a, 'upload', () => w.owner.deletes(), () => w.dispatcher.tick());
  const [run] = w.runsOf(task);
  assert.equal(w.a.called('start.sh'), 0);
  assert.equal(w.lostBasis(run!), 'removed');
});

test('a Run whose first machine takes no upload is not moved to a machine of a account that has changed since', async (t) => {
  const w = world(t, ['h1', 'h2']);
  w.a.uploadFails.add('h1');
  const task = w.queued();
  // The upload that h1 is about to fail is on its way when the owner changes the account.
  await w.midway(w.a, 'upload', () => w.owner.sets({ tiers: { execute: claudeTier('/tiers/new.json') } }), () => w.dispatcher.tick());
  const [run] = w.runsOf(task);
  assert.equal(w.a.called('upload', run!.id, 'h2'), 0, '找到的 h2 属于改过以后的目标');
  assert.equal(w.a.called('start.sh'), 0);
  assert.equal(w.f.run(run!.id).host, 'h1');
  assert.equal(w.lostBasis(run!), 'removed');
  assert.equal(w.f.task(task.id).state, 'queued');
});

// --- one Run, one remote (review finding 2) ---

test('another client joining under the machine\'s name during the upload does not send the start to the machine the name now means, nor anywhere', async (t) => {
  const w = world(t);
  const task = w.queued();
  await w.midway(w.a, 'upload', () => w.owner.rejoins(B), () => w.dispatcher.tick());
  const [run] = w.runsOf(task);
  assert.equal(w.a.called('upload', run!.id), 1, '快照在 A 上');
  assert.deepEqual(w.b.calls, [], '另一台同名的机器上什么都没有，也什么都不能收到');
  assert.equal(w.a.called('start.sh'), 0);
  assert.equal(w.f.run(run!.id).exit_kind, 'lost');
  assert.equal(w.lostBasis(run!), 'removed');
  // The next round is a new Run, whole, on the machine the name means now.
  const next = await w.started(task);
  assert.equal(w.snapshotOf(next).machine?.node_id, `${B}#h1`);
  assert.equal(w.b.called('upload', next.id), 1);
  assert.equal(w.b.called('start.sh', next.id), 1);
  assert.equal(w.a.called('start.sh'), 0);
});

test('a running Run whose machine\'s name now means another client is judged removed: nothing of it is asked of, stopped on or read from the other machine', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  assert.equal(w.snapshotOf(run).machine?.node_id, `${A}#h1`);
  const asked = w.a.calls.length;
  w.owner.rejoins(B);
  assert.equal(await w.runner.verify(run), 'lost');
  await w.runner.tail(run);
  assert.equal(w.lostBasis(run), 'removed');
  assert.deepEqual(w.b.calls, [], '核实不能换到另一台机器上去做');
  assert.equal(w.a.calls.length, asked, '机器被移除是不看就能下的判定');
  assert.equal(w.f.task(task.id).state, 'queued');
  // Its continuation is told to check the site, like any round after a lost one.
  const next = await w.started(task);
  assert.match(w.snapshotOf(next).brief, /先核对现场/);
  assert.equal(w.b.called('start.sh', next.id), 1);
});

test('a stop asked of a Run whose machine\'s name now means another client ends it as stopped without a signal to either machine', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.owner.rejoins(B);
  assert.equal(await w.runner.interrupt(run, OWNER), 'ended');
  assert.equal(w.f.run(run.id).exit_kind, 'interrupted');
  assert.match(JSON.parse(w.f.run(run.id).error_json!).reason, /机器被移除/);
  assert.equal(w.a.called('stop.sh') + w.b.called('stop.sh'), 0);
  assert.equal(w.f.task(task.id).state, 'held');
});

// The old client's token died with the deletion: the round's output can be read from nowhere
// now, and nothing of it is asked of the machine the name means. The next look settles it as
// a round on a removed machine.
test('a verification under way when another client joins under the name reads nothing from the new one, and the round ends as removed', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.a.finish(run.id, DONE);
  await w.midway(w.a, 'state.sh', () => w.owner.rejoins(B), () => w.runner.verify(run));
  assert.deepEqual(w.b.calls, [], '读输出不能换到另一台机器上：那里没有这一轮的文件');
  assert.equal(await w.runner.verify(w.f.run(run.id)), 'lost');
  assert.equal(w.lostBasis(run), 'removed');
  assert.deepEqual(w.b.calls, []);
});

test('the output of an ended Run is read only where it ran: once another client has the name it is reported unreadable, not read from the other machine', async (t) => {
  const w = world(t);
  const run = await w.started(w.queued());
  w.a.finish(run.id, DONE);
  assert.equal(await w.runner.verify(run), 'ended');
  assert.ok((await w.runner.loadEvents(w.f.run(run.id))).length > 0);
  w.owner.rejoins(B);
  await assert.rejects(w.runner.loadEvents(w.f.run(run.id)), (err: Error) => err instanceof HistoryLoadError && /已经换成了另一台/.test(err.message));
  assert.deepEqual(w.b.calls, []);
});

test('account settings that say nothing about where a Run is leave it alone while it runs', async (t) => {
  const w = world(t, ['h1', 'h2']);
  const run = await w.started(w.queued());
  w.owner.sets({ tiers: { execute: claudeTier('/tiers/new.json') }, machines: ['h2', 'h1'], timeoutMs: 60_000 });
  assert.equal(await w.runner.verify(run), 'running');
  assert.equal(w.f.run(run.id).state, 'running');
  assert.equal(w.a.called('state.sh', run.id, 'h1'), 1);
});

test('a machine counts the Runs created on its own client, whatever the account says now', async (t) => {
  const w = world(t, ['h1', 'h2']);
  const first = await w.started(w.queued());
  assert.equal(first.host, 'h1');
  assert.equal((await w.runner.findMachine(w.f.ledger.getAccount('t1')!, w.f.ledger.listMachines()))?.id, 'h2', '同一个客户端，h1 已经有一轮在跑');
  // Under B the names are other machines: the Run on A's h1 is not on B's h1, also
  // before anyone has looked at that Run again.
  w.owner.rejoins(B);
  assert.equal((await w.runner.findMachine(w.f.ledger.getAccount('t1')!, w.f.ledger.listMachines()))?.id, 'h1');
});

// Guards against treating a deleted or rejoined machine, or a project restriction,
// as a merely unreachable machine and waiting through the loss grace period.
for (const change of ['delete', 'rejoin', 'project'] as const) {
  test(`a running Run is removed immediately after its machine changes: ${change}`, async (t) => {
    const w = world(t);
    const run = await w.started(w.queued());
    const calls = w.a.calls.length;
    if (change === 'delete') w.f.ledger.deleteMachine('h1', OWNER, { confirmed: true });
    if (change === 'rejoin') holdMachine(w.f.ledger, under(B, 'h1'));
    if (change === 'project') w.f.ledger.setProjectMachines(w.f.projectId, uidsOf(w.f.ledger, ['h2']), OWNER);
    assert.equal(await w.runner.verify(run), 'lost');
    assert.equal(w.lostBasis(run), 'removed');
    assert.equal(w.a.calls.length, calls, '不能向被移除的连接发任何查询或信号');
    assert.equal(w.f.task(run.task_id).state, 'queued');
  });
}


test('a launching snapshot that records no login is not started, and its Task is placed again', async (t) => {
  const w = world(t);
  const task = w.queued();
  const account = w.f.ledger.getAccount('t1')!;
  const machine = w.f.ledger.getMachine('h1')!;
  const run = w.f.ledger.createRun(task.id, { login: account, machine, snapshot: prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS }), expectedRevision: task.revision }, OWNER);
  const snapshot = w.snapshotOf(run);
  delete snapshot.login;
  delete snapshot.machine;
  w.f.force('UPDATE run SET snapshot_json = ? WHERE id = ?', JSON.stringify(snapshot), run.id);
  await w.runner.launch(w.f.run(run.id));
  assert.equal(w.a.called('start.sh', run.id), 0, '没记登录的快照不启动');
  assert.equal(w.f.run(run.id).state, 'ended');
  assert.equal(w.f.task(task.id).state, 'queued');
  assert.deepEqual(w.b.calls, []);
});
