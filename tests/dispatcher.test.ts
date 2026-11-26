// Guards against dispatch doing what §5.2, §5.6 and §8 forbid: starting while paused
// or degraded, several Runs in one round, a Task with no way to run jamming the queue,
// resuming a session that belongs to another host or a failed Run, a stale snapshot,
// a restart losing track of a Run it should keep following, a Codex session resumed, a
// account's clock not reaching the Run, what a wake is for not reaching the Run it starts,
// a resumed Task's brief assuming nothing moved, and an inventory being overtaken.
// And against the ways a account with several machines can go wrong: a machine fixed
// before the dispatch that needs it, a Task held or the queue blocked because no
// machine answers, a Run out of contact judged with nowhere to continue, the owner told
// about a account short of machines too early, twice or never, and a sweep holding up
// a round or piling up. And: one Run that stays unknown, or whose judgment throws,
// keeping every other candidate and the queue waiting; a account's count of time without
// machines dropped because a round dispatched something else first; and a stop or a
// pause that arrives while a machine is being asked still creating a Run or judging one.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { Runner } from '../runner/runner.ts';
import type { Snapshot, Account, Login, Machine } from '../runner/snapshot.ts';
import { claudeTier, codexTier, DISPATCH_TUNED, memoryLogins, memoryMachines, holdMachine, testMachine, uidsOf } from './helpers.ts';
import type { DispatcherOptions } from '../service/dispatcher.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import type { LedgerOptions, RunRow, TaskRow } from '../service/ledger.ts';
import { DONE, fixture, LOGIN as HELD, tuned, USER } from './helpers.ts';

const atMachine = (id: string | undefined): Machine | undefined => id ? testMachine(id) : undefined;

const LOGIN: Account = {
  id: 't1', name: 't1',
  executor: 'claude',
  tiers: { execute: claudeTier('/tiers/execute.json') },
};

type FakeRunner = Pick<Runner, 'launch' | 'watch' | 'findMachine' | 'lostCandidates' | 'presume' | 'sweep'>;

function setup(
  t: TestContext,
  accounts: Record<string, Account> = { t1: LOGIN },
  overrides: Partial<FakeRunner> = {},
  ledgerOptions: LedgerOptions = {},
  dispatching: Partial<Pick<DispatcherOptions, 'lostGraceMs' | 'now' | 'onNoMachine' | 'outputReady'>> = {},
  // The machines there are: an account may run on any of them.
  machineIds: string[] = ['h1'],
) {
  const f = fixture(t, ledgerOptions);
  const launched: RunRow[] = [];
  const watched: { run: RunRow; intervalMs: number | undefined; signal: AbortSignal | undefined }[] = [];
  const logs: string[] = [];
  const machines = memoryMachines(Object.fromEntries(machineIds.map(id => [id, testMachine(id)])), f.ledger);
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    ...dispatching,
    runner: {
      // Every machine answers, nothing is out of contact, nothing to clear.
      findMachine: async (_account, machines) => machines[0],
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => {
        launched.push(run);
      },
      watch: async (run, watching = {}) => {
        watched.push({ run, intervalMs: watching.intervalMs, signal: watching.signal });
        await new Promise<void>((resolve) => {
          if (watching.signal?.aborted) resolve();
          watching.signal?.addEventListener('abort', () => resolve());
        });
      },
      ...overrides,
      ...(overrides.findMachine ? { findMachine: async (...args) => {
        const found = await overrides.findMachine!(...args);
        return found ? f.ledger.getMachine(found.id) : undefined;
      } } : {}),
    },
    // The fixture's own login stays too: f.runningRun() makes its Runs on it.
    logins: memoryLogins(Object.assign(accounts, { [HELD.login.id]: HELD.login }), f.ledger),
    machines: {get:id=>f.ledger.getMachine(id),list:()=>f.ledger.listMachines()},
    // What the adapters declare: the same ones the service registers.
    executors: { claude: claudeAdapter, codex: codexAdapter },
    intervalMs: 10,
    watchIntervalMs: 7,
    log: (line) => logs.push(line),
  });
  t.after(() => dispatcher.stop());
  const queued = (fields: { loginId?: string; roleId?: string; priority?: number; tierOverride?: { tier: string; reason?: string } } = {}): TaskRow => {
    const task = f.ledger.createTask(
      { projectId: f.projectId, title: '任务', goal: '目标', acceptance: '测试通过', loginId: 't1', roleId: 'implement', ...fields },
      USER,
    );
    f.ledger.queueTask(task.id, USER);
    return f.task(task.id);
  };
  const snapshotOf = (run: RunRow) => JSON.parse(run.snapshot_json) as Snapshot;
  // Ends the Run the tick just started, then queues its Task again.
  const finish = (run: RunRow, exitCode: number, options: { sessionRef?: string; kind?: 'interrupted' | 'lost' } = {}) => {
    f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id, exitCode, exitCode === 0 ? DONE : null, options);
    if (f.task(run.task_id).state === 'ready') f.ledger.updateTask(run.task_id, { goal: `目标 ${run.id}` }, USER);
    if (f.task(run.task_id).state !== 'queued') f.ledger.resumeTask(run.task_id, USER);
  };
  return { f, dispatcher, launched, watched, logs, queued, snapshotOf, finish };
}

test('one round dispatches one Task, and the next round the next', async (t) => {
  const { dispatcher, launched, watched, queued, f } = setup(t);
  const first = queued();
  const second = queued();
  await dispatcher.tick();
  assert.deepEqual(launched.map((run) => run.task_id), [first.id]);
  assert.equal(f.task(first.id).state, 'running');
  assert.equal(f.task(second.id).state, 'queued');
  assert.deepEqual(watched.map(({ run }) => run.id), [launched[0]?.id]);
  await dispatcher.tick();
  assert.deepEqual(launched.map((run) => run.task_id), [first.id, second.id]);
});

test('priority beats age', async (t) => {
  const { dispatcher, launched, queued } = setup(t);
  queued();
  const urgent = queued({ priority: 5 });
  await dispatcher.tick();
  assert.equal(launched[0]?.task_id, urgent.id);
});

test('nothing starts while paused, but a due wake still fires and a Run is still followed', async (t) => {
  const { dispatcher, f, launched, watched, queued } = setup(t);
  const running = f.runningRun();
  const task = queued();
  f.ledger.scheduleWake(task.id, new Date(Date.now() - 1000), USER);
  f.ledger.setPause(true, USER);
  await dispatcher.tick();
  assert.equal(launched.length, 0);
  assert.equal(f.task(task.id).state, 'queued');
  assert.deepEqual(watched.map(({ run }) => run.id), [running.run.id]);
});

test('a Run is launched from what the ledger says about the Task and its account', async (t) => {
  const { dispatcher, launched, queued, snapshotOf } = setup(t);
  await dispatcher.tick();
  assert.equal(launched.length, 0);
  queued();
  await dispatcher.tick();
  const run = launched[0]!;
  assert.deepEqual([run.login_id, run.host], ['t1', 'h1']);
  const snapshot = snapshotOf(run);
  assert.deepEqual(snapshot.tier_value, claudeTier('/tiers/execute.json'));
  assert.deepEqual(snapshot.history, []);
  assert.equal(snapshot.session_ref, undefined);
});

// A login with no operate content is still a candidate for an operate Task: its execute
// content stands in, and the Run says so (roles-and-tiers.md §10.3). Never the other way:
// an execute Task on a login with only operate content waits.
test('a verify Task runs on a login that filled in only the execute tier, and its snapshot records the substitute', async (t) => {
  const { dispatcher, launched, queued, snapshotOf } = setup(t);
  const task = queued({ roleId: 'verify' });
  await dispatcher.tick();
  const run = launched[0]!;
  assert.equal(run.task_id, task.id);
  assert.equal(run.login_id, 't1');
  const snapshot = snapshotOf(run);
  assert.deepEqual([snapshot.tier, snapshot.tier_from, snapshot.tier_value], ['operate', 'execute', claudeTier('/tiers/execute.json')]);
});

test('history lists every earlier Run; a skill file in the data directory is not handed over', async (t) => {
  const { dispatcher, f, launched, queued, snapshotOf, finish } = setup(t);
  const project = f.ledger.listProjects()[0]!.name;
  const skills = join(f.dir, 'skills', project);
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, 'b.md'), '乙');
  writeFileSync(join(skills, 'a.md'), '甲');
  writeFileSync(join(skills, 'notes.txt'), '不是技能');
  queued();
  await dispatcher.tick();
  finish(launched[0]!, 0, { sessionRef: 's1' });
  await dispatcher.tick();
  const first = f.run(launched[0]!.id);
  const snapshot = snapshotOf(launched[1]!);
  assert.deepEqual(snapshot.history, [
    { run_id: first.id, exit_kind: 'completed', receipt: DONE, ended_at: first.ended_at },
  ]);
  assert.equal(snapshot.skills, undefined);
  assert.equal(snapshot.brief.includes('甲'), false);
});

test('a completed or interrupted Run is continued; a failed resume automatically falls back to a fresh session', async (t) => {
  const { dispatcher, f, launched, queued, snapshotOf, finish } = setup(t);
  queued();
  await dispatcher.tick();
  finish(launched[0]!, 0, { sessionRef: 'completed-session' });
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[1]!).session_ref, 'completed-session');
  finish(launched[1]!, 1, { kind: 'interrupted', sessionRef: 'interrupted-session' });
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[2]!).session_ref, 'interrupted-session');
  // Resuming 'interrupted-session' fails immediately -> clears session_ref, auto-requeues, and starts fresh.
  finish(launched[2]!, 1, { sessionRef: 'failed-session' });
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[3]!).session_ref, undefined);
  assert.equal(f.task(launched[3]!.task_id).state, 'running');
});

test('a Run on another account or host does not lend its session', async (t) => {
  const accounts = {
    t1: LOGIN,
    t2: { ...LOGIN, id: 't2', name: 't2', host: 'h2' },
    moved: { ...LOGIN, id: 'moved', name: 'moved' },
  };
  const { dispatcher, f, launched, queued, snapshotOf, finish } = setup(t, accounts);
  const task = queued();
  await dispatcher.tick();
  finish(launched[0]!, 0, { sessionRef: 'on-h1' });
  f.ledger.updateTask(task.id, { loginId: 't2' }, USER);
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[1]!).session_ref, undefined);
});

test('the host moving under the same account also starts fresh', async (t) => {
  const accounts = { t1: { ...LOGIN } };
  const { dispatcher, f, launched, queued, snapshotOf, finish } = setup(t, accounts);
  queued();
  await dispatcher.tick();
  finish(launched[0]!, 0, { sessionRef: 'on-h1' });
  // The project's work may now run only on h9.
  holdMachine(f.ledger, testMachine('h9'),USER);
  f.ledger.setProjectMachines(f.projectId, uidsOf(f.ledger, ['h9']), USER);
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[1]!).session_ref, undefined);
  assert.equal(launched[1]?.host, 'h9');
});

test('only adapters declaring resumable=true resume sessions', async (t) => {
  const { dispatcher, launched, queued, snapshotOf, finish } = setup(t, { t1: { ...LOGIN, executor: 'codex', tiers: { execute: codexTier('execute') } } });
  queued();
  await dispatcher.tick();
  finish(launched[0]!, 0, { sessionRef: 's1' });
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[1]!).session_ref, codexAdapter.resumable ? 's1' : undefined);
});

test('a Task that cannot be prepared is held with the reason, and the queue moves on', async (t) => {
  const accounts: Record<string, Account> = { t1: LOGIN, gone: { ...LOGIN, id: 'gone', name: 'gone' } };
  const { dispatcher, f, launched, queued } = setup(t, accounts);
  const noAccount = queued({ loginId: 'gone' });
  f.ledger.deleteAccount('gone', USER, { confirmed: true });
  delete accounts.gone;
  // A name outside the two would never reach the queue at all, so what cannot be prepared
  // here is one of the two that this account does not hold (docs/design/roles-and-tiers.md §8).
  // A writable role on the decide tier: a read-only one would stop earlier, for want of a
  // machine that reported its read-only way (readonly-dispatch.test.ts).
  const noTier = queued({ tierOverride: { tier: 'decide', reason: '要先想清楚' } });
  const good = queued();
  await dispatcher.tick();
  await dispatcher.tick();
  await dispatcher.tick();
  assert.equal(f.task(noAccount.id).state, 'held');
  assert.match(f.task(noAccount.id).reason!, /没有可用的登录.*指定的登录已删除，请重新选择/);
  assert.equal(f.task(noTier.id).state, 'held');
  assert.match(f.task(noTier.id).reason!, /档位 decide/);
  assert.deepEqual(launched.map((run) => run.task_id), [good.id]);
});

test('a launch that throws still leaves the Run followed', async (t) => {
  const { dispatcher, watched, logs, queued } = setup(t, undefined, {
    launch: async () => {
      throw new Error('炸了');
    },
  });
  queued();
  await dispatcher.tick();
  assert.equal(watched.length, 1);
  assert.match(logs[0]!, /炸了/);
});

test('a Run is followed once, however many rounds pass', async (t) => {
  const { dispatcher, watched, queued } = setup(t);
  queued();
  await dispatcher.tick();
  await dispatcher.tick();
  await dispatcher.tick();
  assert.equal(watched.length, 1);
  assert.equal(watched[0]?.intervalMs, 7);
});

test('startup follows every Run still active, and a dead watcher is replaced', async (t) => {
  let fail = true;
  const seen: string[] = [];
  const { dispatcher, f, logs } = setup(t, undefined, {
    watch: async (run) => {
      seen.push(run.id);
      if (fail) throw new Error('写库失败');
    },
  });
  const { run } = f.runningRun();
  dispatcher.watchActive();
  assert.deepEqual(seen, [run.id]);
  await sleep(5);
  assert.match(logs[0]!, /写库失败/);
  fail = false;
  await dispatcher.tick();
  assert.deepEqual(seen, [run.id, run.id]);
});

test('stop aborts the watchers and ends the loop', async (t) => {
  const { dispatcher, watched, queued } = setup(t);
  queued();
  dispatcher.start();
  while (watched.length === 0) await sleep(5);
  await dispatcher.stop();
  assert.equal(watched[0]?.signal?.aborted, true);
});

test('a account that became Claude does not take a Codex thread for a Claude session', async (t) => {
  const accounts = { t1: { ...LOGIN, executor: 'codex', tiers: { execute: codexTier('execute') } } };
  const { dispatcher, launched, queued, snapshotOf, finish } = setup(t, accounts);
  queued();
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[0]!).executor, 'codex');
  finish(launched[0]!, 0, { sessionRef: 'thread-1' });
  accounts.t1 = LOGIN as typeof accounts.t1;
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[1]!).executor, 'claude');
  assert.equal(snapshotOf(launched[1]!).session_ref, undefined);
});

test('a Codex account follows codexAdapter.resumable and keeps history on continuation', async (t) => {
  const { dispatcher, launched, queued, snapshotOf, finish } = setup(t, { t1: { ...LOGIN, executor: 'codex', tiers: { execute: codexTier('execute') } } });
  queued();
  await dispatcher.tick();
  finish(launched[0]!, 0, { sessionRef: 'thread-1' });
  await dispatcher.tick();
  const snapshot = snapshotOf(launched[1]!);
  assert.equal(snapshot.session_ref, codexAdapter.resumable ? 'thread-1' : undefined);
  assert.equal((snapshot.history as { receipt: unknown }[])[0]?.receipt !== null, true);
});

test('a account\'s timeoutMs goes into the snapshot; without one the setting\'s value does', async (t) => {
  const clocked = setup(t, { t1: { ...LOGIN, timeoutMs: 1234 } });
  clocked.queued();
  await clocked.dispatcher.tick();
  assert.equal(clocked.snapshotOf(clocked.launched[0]!).timeout_ms, 1234);
  const plain = setup(t);
  plain.queued();
  await plain.dispatcher.tick();
  assert.equal(plain.snapshotOf(plain.launched[0]!).timeout_ms, tuned('run.timeoutMs')());
});

test('a later receipt parks the Task, the wake queues it, and the next Run knows what for', async (t) => {
  const { dispatcher, f, launched, queued, snapshotOf } = setup(t);
  const task = queued();
  await dispatcher.tick();
  const run = launched[0]!;
  f.ledger.markRunRunning(run.id);
  const at = new Date(Date.now() + 60_000).toISOString();
  f.ledger.settleRun(run.id, 0, { status: 'waiting', later: { at, about: '查构建结果' } });
  assert.deepEqual([f.task(task.id).state, f.task(task.id).wake_at], ['waiting_timer', at]);
  await dispatcher.tick();
  assert.equal(launched.length, 1, '没到点不派发');

  f.force(`UPDATE task SET wake_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, task.id);
  await dispatcher.tick();
  assert.equal(launched.length, 2);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'task.wake'`).length, 1);
  const [earlier] = snapshotOf(launched[1]!).history as { receipt: { later: { about: string } } }[];
  assert.equal(earlier?.receipt.later.about, '查构建结果');
});

test('a Task resumed after a Run gets a brief that says to check the site first', async (t) => {
  const { dispatcher, f, launched, queued, snapshotOf } = setup(t);
  const task = queued();
  await dispatcher.tick();
  assert.doesNotMatch(snapshotOf(launched[0]!).brief, /先核对现场/, '第一轮没有现场可核对');
  f.ledger.markRunRunning(launched[0]!.id);
  f.ledger.settleRun(launched[0]!.id, 1, null);
  f.ledger.resumeTask(task.id, USER);
  await dispatcher.tick();
  assert.match(snapshotOf(launched[1]!).brief, /先核对现场/);
  assert.match(snapshotOf(launched[1]!).brief, /目标/);

  // A wake is not a resume: nobody has been at the site on the Task's behalf.
  f.ledger.markRunRunning(launched[1]!.id);
  f.ledger.settleRun(launched[1]!.id, 0, { status: 'waiting', later: { at: '2020-01-01T00:00:00Z', about: '再看' } });
  await dispatcher.tick();
  assert.doesNotMatch(snapshotOf(launched[2]!).brief, /先核对现场/);
});

test('an inventory stops a round before its first step and its end lets the next one run', async (t) => {
  let recovering = true;
  const { dispatcher, f, launched, queued } = setup(t, undefined, {}, { recovery: { recovering: () => recovering } });
  const task = queued();
  f.ledger.scheduleWake(queued().id, '2020-01-01T00:00:00Z', USER);
  await dispatcher.tick();
  assert.equal(launched.length, 0);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'task.wake'`).length, 0);
  recovering = false;
  await dispatcher.tick();
  assert.equal(launched[0]?.task_id, task.id);
});

test('a Run whose account left the config is still followed: its watcher is what settles it as lost', async (t) => {
  const { dispatcher, f, watched, logs } = setup(t);
  const { run } = f.runningRun();
  f.force(`UPDATE run SET login_id = 'gone' WHERE id = ?`, run.id);
  dispatcher.watchActive();
  await sleep(5);
  assert.deepEqual([watched.map((each) => each.run.id), logs.length], [[run.id], 0]);
});

test('the machine is asked for at each dispatch, and the Run keeps the one it was given', async (t) => {
  const asked: string[][] = [];
  const answers = ['h2', 'h1'];
  const { dispatcher, launched, queued } = setup(t, { t1: LOGIN }, {
    findMachine: async (_login, offered) => {
      asked.push(offered.map(({ id }) => id));
      return atMachine(answers.shift());
    },
  }, {}, {}, ['h1', 'h2']);
  queued();
  queued();
  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual(launched.map((run) => run.host), ['h2', 'h1']);
  assert.deepEqual(asked, [['h1', 'h2'], ['h1', 'h2']]);
});

test('a session is continued only on the machine it ran on', async (t) => {
  const hosts = ['h1', 'h2', 'h2'];
  const { dispatcher, launched, queued, snapshotOf, finish } = setup(t, { t1: LOGIN }, {
    findMachine: async () => atMachine(hosts.shift()),
  }, {}, {}, ['h1', 'h2']);
  queued();
  await dispatcher.tick();
  finish(launched[0]!, 0, { sessionRef: 'on-h1' });
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[1]!).session_ref, undefined, '换了机器就新开会话');
  finish(launched[1]!, 0, { sessionRef: 'on-h2' });
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[2]!).session_ref, 'on-h2');
});

test('a account with no machine keeps its Task queued and does not hold the queue for other accounts', async (t) => {
  const accounts = { t1: LOGIN, t2: { ...LOGIN, id: 't2', name: 't2' } };
  const { dispatcher, f, launched, queued } = setup(t, accounts, {
    findMachine: async (login) => (login.id === 't1' ? undefined : atMachine('g1')),
  }, {}, {}, ['h1', 'g1']);
  const starved = queued({ priority: 5 });
  const other = queued({ loginId: 't2' });
  await dispatcher.tick();
  assert.equal(f.task(starved.id).state, 'queued', '没有机器不是出错，不进已停住');
  assert.equal(f.count('run'), 1);
  assert.deepEqual(launched.map((run) => [run.task_id, run.host]), [[other.id, 'g1']]);
  assert.deepEqual(dispatcher.waitingLogins().map(({ login_id }) => login_id), ['t1']);
});

test('a Run out of contact past the grace period is judged only once a machine answers, one a round, before anything is dispatched', async (t) => {
  const order: string[] = [];
  let machine: string | undefined;
  const lost: RunRow[] = [];
  const { dispatcher, f, launched, queued } = setup(t, undefined, {
    lostCandidates: () => lost.filter((run) => f.run(run.id).state !== 'ended'),
    findMachine: async (_account, _machines, forContinuation) => {
      order.push(forContinuation ? 'ask:continuation' : 'ask:dispatch');
      return atMachine(machine);
    },
    presume: async (run) => {
      order.push(`presume:${run.id}`);
      f.ledger.settleRun(run.id, null, null, { kind: 'lost', lost: { basis: 'presumed' } });
      return 'lost';
    },
  });
  const first = f.runningRun();
  const second = f.runningRun();
  for (const { task, run } of [first, second]) {
    f.force(`UPDATE task SET login_id = 't1' WHERE id = ?`, task.id);
    f.ledger.markRunUnknown(run.id);
    lost.push(run);
  }
  queued();

  await dispatcher.tick();
  assert.deepEqual(order, ['ask:continuation', 'ask:continuation', 'ask:dispatch'], '没有连得上的机器，就不到判定那一步');
  assert.equal(f.run(first.run.id).state, 'unknown');
  assert.equal(launched.length, 0);

  machine = 'h1';
  order.length = 0;
  await dispatcher.tick();
  assert.deepEqual(order.slice(0, 2), ['ask:continuation', `presume:${first.run.id}`]);
  assert.equal(order.filter((step) => step.startsWith('presume')).length, 1, '一轮只判定一个');
  assert.equal(f.run(second.run.id).state, 'unknown');
  assert.equal(launched.length, 1, '判定之后这一轮照常派发');
});

test('a account without machines for a whole grace period is told once, and again only for a new stretch', async (t) => {
  let clock = 1_000_000;
  let machine: string | undefined;
  const told: string[] = [];
  const { dispatcher, queued } = setup(t, undefined, { findMachine: async () => atMachine(machine) }, {}, {
    lostGraceMs: () => 600,
    now: () => clock,
    onNoMachine: (account, since) => told.push(`${account}@${since}`),
  });
  queued();
  queued();
  await dispatcher.tick();
  clock += 599;
  await dispatcher.tick();
  assert.equal(told.length, 0, '不到一个宽限期只是在等容量');
  clock += 1;
  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual(told, [`t1@${new Date(1_000_000).toISOString()}`]);
  assert.equal(dispatcher.waitingLogins()[0]?.overdue, true);

  machine = 'h1';
  await dispatcher.tick();
  assert.deepEqual(dispatcher.waitingLogins(), []);
  machine = undefined;
  clock += 5000;
  await dispatcher.tick();
  clock += 600;
  await dispatcher.tick();
  assert.deepEqual(told.map((line) => line.split('@')[0]), ['t1', 't1']);
  assert.equal(new Set(told).size, 2, '新一次不可用有自己的起始时刻');
});

test('a notification that fails to queue is tried again the next round', async (t) => {
  let fail = true;
  const told: string[] = [];
  const { dispatcher, logs, queued } = setup(t, undefined, { findMachine: async () => undefined }, {}, {
    lostGraceMs: () => 0,
    onNoMachine: (account) => {
      if (fail) throw new Error('写不进去');
      told.push(account);
    },
  });
  queued();
  dispatcher.start();
  while (logs.length === 0) await sleep(5);
  assert.match(logs[0]!, /写不进去/);
  fail = false;
  while (told.length === 0) await sleep(5);
  assert.deepEqual(told, ['t1']);
});

test('each round sweeps without waiting for it, and a failing sweep is only logged', async (t) => {
  let sweeps = 0;
  const release = Promise.withResolvers<void>();
  const { dispatcher, launched, logs, queued } = setup(t, undefined, {
    sweep: async () => {
      sweeps += 1;
      await release.promise;
      throw new Error('清不掉');
    },
  });
  queued();
  await dispatcher.tick();
  assert.equal(launched.length, 1, '派发不等清理');
  await dispatcher.tick();
  assert.equal(sweeps, 1, '上一次清理没完，不叠第二次');
  release.resolve();
  await sleep(5);
  assert.match(logs.join('\n'), /重连清理出错.*清不掉/);
  await dispatcher.tick();
  assert.equal(sweeps, 2);
});

// An unknown Run on t1, as the Runner would report it once its grace period is over.
function outOfContact(f: ReturnType<typeof setup>['f']): RunRow {
  const { task, run } = f.runningRun();
  f.force(`UPDATE task SET login_id = 't1' WHERE id = ?`, task.id);
  f.ledger.markRunUnknown(run.id);
  return run;
}

test('a candidate that is still unknown after its turn goes behind the others, and one whose judgment fails holds nothing up', async (t) => {
  const order: string[] = [];
  const lost: RunRow[] = [];
  const { dispatcher, f, launched, logs, queued } = setup(t, undefined, {
    lostCandidates: () => lost.filter((run) => f.run(run.id).state === 'unknown'),
    presume: async (run) => {
      order.push(run.id);
      if (run.id === lost[1]!.id) throw new Error('读不了这个 Run');
      // The first comes away as it went in; the third is found gone.
      if (run.id === lost[2]!.id) f.ledger.settleRun(run.id, null, null, { kind: 'interrupted' });
      return 'unknown';
    },
  });
  lost.push(outOfContact(f), outOfContact(f), outOfContact(f));
  const [stuck, broken, gone] = lost.map((run) => run.id);
  queued();

  await dispatcher.tick();
  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual(order, [stuck, broken, gone], '没有进展的候选不能一直占着队首');
  assert.match(logs.join('\n'), /接续前的核实出错.*读不了这个 Run/);
  assert.equal(launched.length, 1, '判定出错的那一轮照常派发');

  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual(order.slice(3), [stuck, broken], '轮过一遍之后按上次轮到的先后再来');
});

test('dispatching another account first does not lose the count of a account still short of machines', async (t) => {
  let clock = 1_000_000;
  const told: string[] = [];
  const accounts = { t1: LOGIN, t2: { ...LOGIN, id: 't2', name: 't2' } };
  const { dispatcher, launched, queued } = setup(t, accounts, {
    findMachine: async (login) => (login.id === 't1' ? undefined : atMachine('g1')),
  }, {}, {
    lostGraceMs: () => 600,
    now: () => clock,
    onNoMachine: (account, since) => told.push(`${account}@${since}`),
  }, ['h1', 'g1']);
  queued();
  await dispatcher.tick();
  assert.deepEqual(dispatcher.waitingLogins().map(({ login_id }) => login_id), ['t1']);

  // Work for another account comes in ahead of it: the round dispatches that and stops,
  // without getting as far as asking about t1.
  for (let round = 0; round < 3; round += 1) {
    queued({ loginId: 't2', priority: 9 });
    clock += 150;
    await dispatcher.tick();
    assert.deepEqual(dispatcher.waitingLogins().map(({ login_id }) => login_id), ['t1'], '这一轮没问到它，不等于它没有任务在等');
  }
  assert.equal(launched.length, 3);
  assert.equal(told.length, 0);

  clock += 150;
  await dispatcher.tick();
  assert.deepEqual(told, [`t1@${new Date(1_000_000).toISOString()}`], '计时从第一次发现没有机器算起，没有被别的目标的派发清掉');
});

test('a account stays short of machines for as long as a Run waits there to be continued, and no longer', async (t) => {
  const lost: RunRow[] = [];
  const { dispatcher, f } = setup(t, undefined, {
    lostCandidates: () => lost.filter((run) => f.run(run.id).state === 'unknown'),
    findMachine: async () => undefined,
  });
  lost.push(outOfContact(f));
  await dispatcher.tick();
  const [first] = dispatcher.waitingLogins();
  assert.equal(first?.login_id, 't1');
  await dispatcher.tick();
  assert.deepEqual(dispatcher.waitingLogins(), [first], '没有排队任务，但失联待接续的任务还在等机器');

  f.ledger.settleRun(lost[0]!.id, null, null, { kind: 'interrupted' });
  await dispatcher.tick();
  assert.deepEqual(dispatcher.waitingLogins(), [], '没有任务在等了，记录才移除');
});

test('a stop that arrives while a machine is being picked creates no Run', async (t) => {
  const asked = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<string>();
  const { dispatcher, f, launched, queued } = setup(t, undefined, {
    findMachine: async () => {
      asked.resolve();
      return answer.promise.then(atMachine);
    },
  });
  const task = queued();
  const ticking = dispatcher.tick();
  await asked.promise;
  const stopped = dispatcher.stop();
  answer.resolve('h1');
  await ticking;
  await stopped;
  assert.equal(f.count('run'), 0, '停服之后还创建了 Run');
  assert.equal(launched.length, 0);
  assert.equal(f.task(task.id).state, 'queued');
});

for (const [what, interfere] of [
  ['a pause', (f: ReturnType<typeof setup>['f'], _stop: () => void): void => f.ledger.setPause(true, USER)],
  ['a stop', (_f: ReturnType<typeof setup>['f'], stop: () => void): void => stop()],
] as const) {
  test(`${what} that arrives while a machine is being asked for a continuation leaves the old Run unjudged`, async (t) => {
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<string>();
    const lost: RunRow[] = [];
    let presumed = 0;
    const { dispatcher, f } = setup(t, undefined, {
      lostCandidates: () => lost,
      findMachine: async () => {
        asked.resolve();
        return answer.promise.then(atMachine);
      },
      presume: async () => {
        presumed += 1;
        return 'lost';
      },
    });
    lost.push(outOfContact(f));
    const ticking = dispatcher.tick();
    await asked.promise;
    interfere(f, () => void dispatcher.stop());
    answer.resolve('h1');
    await ticking;
    assert.equal(presumed, 0, '没有接续要发出，就不该去判定旧 Run');
  });
}

test('the judgment is handed the question whether a continuation is still going out, and the answer follows a pause and a stop', async (t) => {
  const lost: RunRow[] = [];
  const answers: boolean[] = [];
  const { dispatcher, f } = setup(t, undefined, {
    lostCandidates: () => lost,
    presume: async (_run, sending) => {
      answers.push(sending());
      f.ledger.setPause(true, USER);
      answers.push(sending());
      f.ledger.setPause(false, USER);
      answers.push(sending());
      void dispatcher.stop();
      answers.push(sending());
      return 'unknown';
    },
  });
  lost.push(outOfContact(f));
  await dispatcher.tick();
  assert.deepEqual(answers, [true, false, true, false]);
});

test('another client joined under the same name starts a fresh session: a session is kept on the machine it ran on', async (t) => {
  const {dispatcher,f,queued,launched,snapshotOf,finish} = setup(t);
  queued();
  await dispatcher.tick();
  finish(launched[0]!,0,{sessionRef:'old-site'});
  holdMachine(f.ledger, testMachine('h1', 'h1', 'another-client'),USER);
  await dispatcher.tick();
  assert.equal(launched.length,2);
  assert.equal(snapshotOf(launched[1]!).session_ref,undefined);
});

test('new work waits for bounded-output capability and capacity, then starts captured once available',async t=>{
 let ready=false;const {dispatcher,queued,launched,f}=setup(t,undefined,{}, {},{outputReady:()=>ready});const task=queued();
 await dispatcher.tick();assert.equal(launched.length,0);assert.equal(f.task(task.id).state,'queued');assert.deepEqual(dispatcher.waitOf(f.task(task.id))?.output_waiting,['h1']);
 ready=true;await dispatcher.tick();assert.equal(launched.length,1);assert.equal(JSON.parse(launched[0]!.snapshot_json).output_capture.version,1);
});
