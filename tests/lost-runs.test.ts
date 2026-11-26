// Guards against the two ways a lost machine can go wrong. Too eager: a Run judged
// gone while it may be alive (inside the grace period, on the strength of time this
// service was down, when no machine is there to continue on, or when the machine
// answers and the executor is still there), so that a second executor runs beside the
// first. Too timid: a Task that waits for the owner over something the rules can
// decide (a process seen gone, a removed machine, a machine out of contact past the
// grace period, an abandon or an interrupt it cannot deliver). And around them: a
// continuation that is not told to check the site, re-sent inputs, a late result of
// the old Run moving the Task, a loop of losses that never reaches the owner, a
// machine picked while it is out of contact, an upload failure leaving an unknown Run,
// a start retried on another machine, a account without machines holding the queue or
// telling the owner on every round, an old round starting over a new one, and
// processes of an ended Run left on a machine that came back.
// A return arriving during a sweep must survive it, so rounds that ended after its
// listing passed them are cleared by the next sweep without waiting for the interval.
//
// And against what a review of the first version found. A Run whose machine answers
// again with its launcher still at work staying unknown for good, without the wall
// clock, at the head of the candidates. One time standing for two waits, so that a
// machine which answered and then failed again was judged on the old stretch. A wall
// clock set forward judging early, or set back never judging. A round no machine took
// counted as a lost execution, its inputs written off, and the limit on losses not
// starting again when the owner resumes, or not applied to a Task the old rules left
// behind. A account that answers probes and takes no upload never reported. A pause or a
// stop arriving while a machine is being asked still ending the old Run or starting a
// new one. The fake machines ending an old round the moment a new one starts, which hid
// everything that happens while both are alive. And a grace period or a limit the owner
// set reaching only some of the three places that go by it. A round whose Worker never ran
// still counted as started and as the product's author; and the other way round, a Worker
// that ran getting itself counted as never started by writing the watch's file.
//
// One assertion here no longer holds as it was written, and is kept as it stands because
// what it guards is still owed: 'a sweep that fails is logged and tried again' expects a
// listing that failed to be logged. The sweep did that when the machine answered with a
// non-zero exit code and the Runner read that code itself (a plain Error, logged). Under
// the closed set a listing that fails arrives as the transport's Unreachable — the same
// answer as a machine that is not there — and the sweep treats Unreachable as the
// expected case and says nothing (runner/runner.ts, `sweep`). The fix belongs in the
// source: either the listing's own failure has to be told apart from a machine out of
// contact (runner/ssh.ts's `list`), or the sweep has to log it. Nothing was loosened
// here to make it pass.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { Adapter } from '../adapters/types.ts';
import { createRunner } from '../runner/runner.ts';
import { roundTurn } from '../runner/snapshot.ts';
import type { Snapshot, Login } from '../runner/snapshot.ts';
import { claudeTier, codexTier, DISPATCH_TUNED, memoryLogins, RUN_LIMIT_MS, RUNNER_TUNED, tune, holdMachine, testMachine, signedInEverywhere, uidsOf } from './helpers.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { InputError } from '../service/errors.ts';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import type { NodeExecutorStatus } from '../shared/node-protocol.ts';
import { SETTINGS } from '../service/settings.ts';
import { unconfirmedSince, unknownFrom, unreachableSince } from '../service/ledger.ts';
import { fakeRemote } from './fake-remote.ts';
import { writersOf } from '../service/review.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { selectProcesses } from '../node/hostprocess.ts';
import { boxOf, runState, takeGate, writeExit, writeLeft, writeNotStarted, writeWatchEvidence, writeWorkerEvidence } from '../node/runbox.ts';
import { DONE, fixture, LOGIN, machineLogin, testCredentialRef, tuned, USER } from './helpers.ts';
import { signIn, stage, LOGIN as STAGE_ACCOUNT, until } from './stage.ts';

const GRACE = SETTINGS['run.lostGraceMs'].default;
const MINUTE = 60_000;

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let n = 0; n < 5000; n += 1) {
    if (check()) return;
    await sleep(1);
  }
  assert.fail(`等不到：${what}`);
}

// One ledger, a set of fake machines and two clocks the test moves: the wall clock,
// which can also jump by itself, and the one that only ever counts time passing.
// `service()` is a process on them: a second call is a restart, which knows nothing the
// first learned. `executors` and `reported` are for a test about another executor, or about
// what two machines said of theirs; every other test runs Claude, as every machine has it.
function world(t: TestContext, hosts = ['h1', 'h2'], { lostLimit, executors = { claude: claudeAdapter }, reported }: {
  lostLimit?: number;
  executors?: Record<string, Adapter>;
  reported?: (machine: string, executor: string) => NodeExecutorStatus;
} = {}) {
  const f = fixture(t);
  if (lostLimit !== undefined) tune(f.ledger, 'run.maxLostContinuations', lostLimit);
  const remote = fakeRemote();
  let skew = 0;
  let passed = 0;
  let grace = GRACE;
  const now = (): number => Date.now() + skew;
  const monotonic = (): number => performance.now() + passed;
  // What a machine said of an executor: the test's own, or every executor installed and
  // signed in as a stand-in client would say.
  const reportOf = reported ?? ((_machine: string, executor: string): NodeExecutorStatus => signedInEverywhere([executor])().executors[0]!);
  // An account: it runs on any of the machines there are, its token handed to each round.
  const accounts: Record<string, Login> = {
    t1: { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } },
  };
  for (const id of new Set(hosts)) holdMachine(f.ledger, testMachine(id), USER);
  const machines = { get: f.ledger.getMachine, list: f.ledger.listMachines };
  const store = memoryLogins(accounts, f.ledger);
  const logs: string[] = [];
  const told: { account: string; since: string }[] = [];
  // Machines whose client is refusing to speak to this host (nodes.md §5.3): a test adds one
  // and the Runner has to treat its silence as a version mismatch, not as a lost execution.
  const refused = new Set<string>();

  function service() {
    const runner = createRunner({ ...RUNNER_TUNED,
      ledger: f.ledger, adapters: executors, logins: store, machines, connect: remote.connect,
      credential: (id) => (store.get(id)?.machine === undefined ? { ref: testCredentialRef(id), value: 'token' } : undefined),
      lostGraceMs: () => grace, now, monotonic, log: (line) => logs.push(line),
      refusesProtocol: (machineId) => refused.has(machineId),
      reported: reportOf,
    });
    const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
      ledger: f.ledger,
      runTimeoutMs: tuned('run.timeoutMs'),
      // No watcher: every look at a Run is one the test asked for.
      runner: { ...runner, watch: async () => {} },
      logins: store, machines,
      executors,
      // Every machine has said its executor is signed in: a machine's own login waits for that.
      reported: reportOf,
      lostGraceMs: () => grace,
      now,
      onNoMachine: (account, since) => told.push({ account, since }),
      log: (line) => logs.push(line),
    });
    t.after(() => dispatcher.stop());
    return { runner, dispatcher };
  }

  const first = service();
  const runsOf = (task: TaskRow): RunRow[] => f.ledger.listRuns(task.id);
  return {
    f, remote, accounts, store, logs, told, service, runsOf, refused, ...first,
    // Time passes: both clocks move.
    advance(ms: number): void {
      skew += ms;
      passed += ms;
    },
    // Someone sets the wall clock: no time has passed.
    jump(ms: number): void {
      skew += ms;
    },
    setGrace(ms: number): void {
      grace = ms;
    },
    // A Run whose start went out and was never heard of again, on a machine that shows
    // no trace of it: §4's first row.
    async unconfirmed(task: TaskRow, dispatcher = first.dispatcher): Promise<RunRow> {
      remote.startLost = true;
      await dispatcher.tick();
      remote.startLost = false;
      const run = runsOf(task).at(-1);
      assert.equal(run?.state, 'launching');
      return run!;
    },
    // Always: for the judgments a test asks for itself.
    sending: (): boolean => true,
    unreachableSince: (run: RunRow): string | undefined => unreachableSince(f.run(run.id)),
    unconfirmedSince: (run: RunRow): string | undefined => unconfirmedSince(f.run(run.id)),
    queued(title = '任务'): TaskRow {
      const task = f.ledger.createTask(
        { projectId: f.projectId, title, goal: '目标', acceptance: '测试通过', loginId: 't1', roleId: 'implement' },
        USER,
      );
      f.ledger.queueTask(task.id, USER);
      return f.task(task.id);
    },
    // A round of dispatch, and the Run it started for the Task.
    async started(task: TaskRow, dispatcher = first.dispatcher): Promise<RunRow> {
      await dispatcher.tick();
      const run = runsOf(task).at(-1);
      assert.equal(run?.state, 'running', '这一轮应该把任务派出去');
      return run!;
    },
    // The process is gone and left no exit file: §4's "lost" row.
    vanish(run: RunRow): void {
      Object.assign(remote.runOf(run.id), { pid_alive: false, marked: false, launcher_alive: false });
    },
    snapshotOf: (run: RunRow): Snapshot => JSON.parse(run.snapshot_json) as Snapshot,
    lostOf: (run: RunRow) => (JSON.parse(f.run(run.id).error_json ?? '{}') as { lost?: { basis: string; since?: string; until?: string } }).lost,
    changes: (action: string): { task_id: string; run_id: string | null; detail_json: string }[] =>
      f.peek(`SELECT task_id, run_id, detail_json FROM change WHERE action = ? ORDER BY seq`, action),
  };
}

test('inside the grace period a Run out of contact is neither settled nor continued, and one found alive loses nothing', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  assert.equal(run.host, 'h1');

  w.remote.down.add('h1');
  assert.equal(await w.runner.verify(run), 'unknown');
  const since = w.unreachableSince(run);
  assert.ok(since, '第一次连不上的时刻要记在 Run 上');
  assert.equal(w.f.task(task.id).state, 'needs_verification');

  w.advance(GRACE - MINUTE);
  assert.equal(await w.runner.verify(run), 'unknown');
  assert.equal(w.unreachableSince(run), since, '之后每次连不上都不重置起点');
  assert.deepEqual(w.runner.lostCandidates(), []);
  assert.equal(await w.runner.presume(run, w.sending), 'unknown', '宽限期没到，接续前的核实也不判定');
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'unknown');
  assert.equal(w.runsOf(task).length, 1, '宽限期内派了新 Run');
  assert.equal(w.f.count('outbox'), 0, '失联不推企微');

  w.remote.down.delete('h1');
  assert.equal(await w.runner.verify(run), 'running');
  assert.equal(w.f.run(run.id).error_json, null, '回到可达即清除失联记录');
  assert.equal(w.f.task(task.id).state, 'running');
});

// §5.3: a client of another protocol version refuses to talk, and that is not a machine that
// has gone. Reading it as "out of contact past the grace period" would settle the Run as lost
// and continue it elsewhere while the first one may be running perfectly well.
test('版本不符的机器：宽限期过了也不判丢失，不接续，只说未知', async (t) => {
  const w = world(t);
  const task = w.queued();
  const old = await w.started(task);

  w.remote.down.add('h1');
  w.refused.add('h1');
  assert.equal(await w.runner.verify(old), 'unknown');
  w.advance(GRACE * 2);
  assert.equal(await w.runner.verify(w.f.run(old.id)), 'unknown', '等了多久也还是未知');
  assert.deepEqual(w.runner.lostCandidates(), [], '版本不符不排进接续候选');
  assert.equal(await w.runner.presume(w.f.run(old.id), w.sending), 'unknown', '发接续之前的核实同样不判');
  await w.dispatcher.tick();
  assert.equal(w.f.run(old.id).state, 'unknown');
  assert.equal(w.runsOf(task).length, 1, '没有第二个 Run：旧的可能还在跑');
  assert.equal(w.f.task(task.id).state, 'needs_verification');
  assert.equal(JSON.parse(w.f.run(old.id).error_json ?? '{}').lost, undefined, '没有写丢失依据');

  // The client is upgraded and comes back: the ordinary rules apply again.
  w.refused.delete('h1');
  w.remote.down.delete('h1');
  assert.equal(await w.runner.verify(w.f.run(old.id)), 'running');
  assert.equal(w.f.task(task.id).state, 'running');
});

test('past the grace period, with another machine answering, the last probe still fails: the Run is lost and its Task continues there', async (t) => {
  const w = world(t);
  const task = w.queued();
  w.f.ledger.addInput(task.id, '顺便改一下文档', USER);
  const old = await w.started(task);
  assert.equal(w.remote.runOf(old.id).round, 1);

  w.remote.down.add('h1');
  await w.runner.verify(old);
  const since = w.unreachableSince(old);
  w.advance(GRACE);
  assert.deepEqual(w.runner.lostCandidates().map(({ id }) => id), [old.id]);
  const probes = w.remote.called('state.sh', old.id);
  await w.dispatcher.tick();

  assert.equal(w.remote.called('state.sh', old.id), probes + 1, '发接续之前要对旧主机再探测一次');
  const settled = w.f.run(old.id);
  assert.deepEqual([settled.state, settled.exit_kind], ['ended', 'lost']);
  const lost = w.lostOf(old);
  assert.deepEqual([lost?.basis, lost?.since], ['presumed', since]);
  assert.ok(lost?.until && lost.until > since!, '记下失联的起止时间');

  const [, next] = w.runsOf(task);
  assert.deepEqual([next?.state, next?.host], ['running', 'h2'], '接续的 Run 发到连得上的那台');
  assert.equal(w.remote.runOf(next!.id).round, 2, '轮次标记递增');
  assert.equal(w.f.task(task.id).state, 'running');

  const snapshot = w.snapshotOf(next!);
  assert.match(snapshot.brief, /## 现场提示/);
  assert.match(snapshot.brief, /上一轮机器失联或进程中断，本轮自动接续/);
  assert.match(snapshot.brief, /请先核对现场与 `context\.json` 的 `history`（含 `unconfirmed_inputs`）再继续/);
  assert.doesNotMatch(snapshot.brief, /人工放行/);
  assert.deepEqual(snapshot.inputs, [], '上一轮已绑定的插话不重送');
  const [history] = snapshot.history as { exit_kind: string; unconfirmed_inputs: { text: string }[] }[];
  assert.equal(history?.exit_kind, 'lost');
  assert.deepEqual(history?.unconfirmed_inputs.map(({ text }) => text), ['顺便改一下文档'], 'history 如实列出是否执行未确认的插话');
  assert.equal(snapshot.session_ref, undefined, '换了机器就新开会话');

  const [continued] = w.changes('task.continue');
  assert.equal(continued?.task_id, task.id);
  assert.deepEqual(JSON.parse(continued!.detail_json), { reason: '失联超过宽限期', basis: 'presumed', run_id: old.id, host: 'h1' });
  const [event] = w.f.peek<{ text: string }>(`SELECT text FROM message WHERE channel = 'internal' AND external_id = ?`, `run:${old.id}`);
  assert.match(event!.text, /一轮执行丢失（失联超过宽限期），已自动重新排队接续/);
  assert.equal(w.f.count('outbox'), 0, '丢失后自动接续不推企微');
});

test('past the grace period, the last probe reaches the machine and the executor is still there: no continuation, the Run is running again', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.advance(GRACE);
  // The machine is back before anyone asks again.
  w.remote.down.delete('h1');
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'running');
  assert.equal(w.f.run(run.id).error_json, null);
  assert.equal(w.f.task(task.id).state, 'running');
  assert.equal(w.runsOf(task).length, 1, '旧执行还在却派了新 Run');
  assert.equal(w.changes('task.continue').length, 0);
});

test('past the grace period with no machine answering, nothing is judged; when the network is back the executor is found and nothing was lost', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  // This machine lost its network: every instance looks gone at once.
  w.remote.reachable = false;
  await w.runner.verify(run);
  w.advance(GRACE);
  assert.equal(await w.runner.verify(run), 'unknown', '宽限期满了，平常的轮询也不判定：判定只在要发接续的那一刻');
  assert.equal(w.f.run(run.id).state, 'unknown');
  const probes = w.remote.called('state.sh', run.id);
  await w.dispatcher.tick();
  w.advance(2 * MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.remote.called('state.sh', run.id), probes, '没有连得上的机器，就不到判定那一步');
  assert.equal(w.f.run(run.id).state, 'unknown');
  assert.equal(w.f.task(task.id).state, 'needs_verification');
  assert.equal(w.runsOf(task).length, 1);

  w.remote.reachable = true;
  w.advance(2 * MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'running', '网络回来后先看到旧执行还在');
  assert.equal(w.f.task(task.id).state, 'running');
  assert.equal(w.runsOf(task).length, 1);
  assert.equal(w.changes('task.continue').length, 0);
});

for (const machine of ['一直好好的', '确实没了'] as const) {
  test(`a restart across the grace period judges nothing on the time it was away: it probes first (机器${machine})`, async (t) => {
    const w = world(t);
    const task = w.queued();
    const run = await w.started(task);
    w.remote.down.add('h1');
    await w.runner.verify(run);
    const since = w.unreachableSince(run);

    // The service is down for longer than the grace period, then starts again.
    w.advance(3 * GRACE);
    if (machine === '一直好好的') w.remote.down.delete('h1');
    const again = w.service();
    assert.equal(w.unreachableSince(run), since, '重启不重置起点');
    assert.equal(w.f.run(run.id).state, 'unknown', '没探测之前什么都不判');
    const probes = w.remote.called('state.sh', run.id);
    await again.dispatcher.tick();
    assert.ok(w.remote.called('state.sh', run.id) > probes, '重启后至少再探测一次才能判定');

    if (machine === '一直好好的') {
      assert.equal(w.f.run(run.id).state, 'running');
      assert.equal(w.runsOf(task).length, 1);
      return;
    }
    assert.equal(w.f.run(run.id).exit_kind, 'lost');
    assert.equal(w.lostOf(run)?.basis, 'presumed');
    assert.deepEqual(w.runsOf(task).map(({ host }) => host), ['h1', 'h2']);
  });
}

test('a machine taken out of its project is gone by the owner\'s word: lost at once, continued on the rest', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.f.ledger.setProjectMachines(w.f.projectId, uidsOf(w.f.ledger, ['h2']), USER);
  const calls = w.remote.calls.length;
  assert.equal(await w.runner.verify(run), 'lost');
  assert.equal(w.remote.calls.length, calls, '不用再去连那台机器');
  assert.equal(w.f.run(run.id).exit_kind, 'lost');
  assert.equal(w.lostOf(run)?.basis, 'removed');
  assert.equal(w.f.task(task.id).state, 'queued');
  assert.equal(JSON.parse(w.changes('task.continue')[0]!.detail_json).reason, '机器被移除');

  const next = await w.started(task);
  assert.equal(next.host, 'h2');
  assert.match(w.snapshotOf(next).brief, /上一轮机器失联或进程中断，本轮自动接续/);
});

test('a account deleted from the config loses its Runs the same way; with nowhere to continue the Task is held with the reason', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  delete w.accounts.t1;
  assert.equal(await w.runner.verify(run), 'lost');
  assert.equal(w.lostOf(run)?.basis, 'removed');
  await w.dispatcher.tick();
  assert.equal(w.f.task(task.id).state, 'held');
  assert.match(w.f.task(task.id).reason!, /没有可用的登录/);
});

test('a process seen gone is lost and continues by itself, never waiting for the owner', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  w.vanish(run);
  assert.equal(await w.runner.verify(run), 'lost');
  assert.equal(w.lostOf(run)?.basis, 'seen');
  assert.equal(w.f.task(task.id).state, 'queued', '看到进程不在也要自动接续');
  assert.equal(JSON.parse(w.changes('task.continue')[0]!.detail_json).reason, '看到进程不在');

  const next = await w.started(task);
  assert.equal(next.host, 'h1', '机器本身没问题，接着用');
  assert.match(w.snapshotOf(next).brief, /上一轮机器失联或进程中断，本轮自动接续/);
  assert.equal(w.remote.runOf(next.id).round, 2);
});

test('losing every round in a row stops at the limit: the Task is held with the count, and nothing continues it', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  for (let round = 1; round <= SETTINGS['run.maxLostContinuations'].default; round += 1) {
    const run = await w.started(task);
    w.vanish(run);
    assert.equal(await w.runner.verify(run), 'lost');
    const expected = round < SETTINGS['run.maxLostContinuations'].default ? 'queued' : 'held';
    assert.equal(w.f.task(task.id).state, expected, `第 ${round} 次丢失之后`);
  }
  assert.equal(w.f.task(task.id).reason, '连续 3 次执行都丢失');
  assert.equal(w.changes('task.continue').length, SETTINGS['run.maxLostContinuations'].default - 1);
  await w.dispatcher.tick();
  assert.equal(w.runsOf(task).length, SETTINGS['run.maxLostContinuations'].default, '到了上限还在自动接续');
});

test('a round that did not end lost starts the count again, and the limit is read when it is used', (t) => {
  const f = fixture(t);
  const limit = (n: number): void => tune(f.ledger, 'run.maxLostContinuations', n);
  limit(3);
  const task = f.queuedTask();
  const round = (settle: (runId: string) => void): string => {
    const run = f.ledger.createRun(task.id, f.login, USER);
    f.ledger.markRunRunning(run.id);
    settle(run.id);
    return f.task(task.id).state;
  };
  const lost = (runId: string): unknown => f.ledger.settleRun(runId, null, null, { kind: 'lost' });
  assert.equal(round(lost), 'queued');
  assert.equal(round(lost), 'queued');
  assert.equal(round((runId) => f.ledger.settleRun(runId, 1, null)), 'held');
  f.ledger.resumeTask(task.id, USER);
  assert.equal(round(lost), 'queued', '中间有一次不是丢失，重新计数');
  assert.equal(round(lost), 'queued');
  limit(5);
  assert.equal(round(lost), 'queued', '上限是用到时取的值');
  limit(3);
  assert.equal(round(lost), 'held');
  assert.equal(f.task(task.id).reason, '连续 4 次执行都丢失');
});

test('the old Run\'s real result arriving after it was presumed lost is history only', async (t) => {
  const w = world(t);
  const task = w.queued();
  const old = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(old);
  w.advance(GRACE);
  await w.dispatcher.tick();
  const [, next] = w.runsOf(task);
  assert.equal(next?.state, 'running');

  // The machine comes back and the old executor had finished its work after all.
  w.remote.down.delete('h1');
  w.remote.finish(old.id, DONE);
  assert.equal(await w.runner.verify(old), 'ended');
  assert.deepEqual(w.f.ledger.settleRun(old.id, 0, DONE), { late: true, reason: 'run_ended' });
  const after = w.f.run(old.id);
  assert.deepEqual([after.exit_kind, after.receipt_json], ['lost', null], '第一次结算不变');
  assert.equal((JSON.parse(after.error_json!) as { late_results: unknown[] }).late_results.length, 1, '迟到的结果留作历史');
  assert.equal(w.f.task(task.id).state, 'running', '迟到的结果改了任务状态');
  assert.equal(w.f.run(next!.id).state, 'running');
  assert.equal(w.runsOf(task).length, 2);
});

test('abandoning a Task whose machine does not answer takes effect at once: the Run ends lost, the question and the wake are gone', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  const since = w.unreachableSince(run);

  await assert.rejects(w.runner.abandon(task.id, ' ', USER), InputError);
  assert.equal(w.remote.called('stop.sh', run.id), 0, '被拒绝的放弃不该发出停止');

  await w.runner.abandon(task.id, '不做了', USER);
  assert.equal(w.remote.called('stop.sh', run.id), 1, '连得上就先停，所以先试一次');
  const task2 = w.f.task(task.id);
  assert.deepEqual([task2.state, task2.reason, task2.wake_at], ['abandoned', '不做了', null]);
  assert.ok(task2.closed_at);
  const settled = w.f.run(run.id);
  assert.deepEqual([settled.state, settled.exit_kind], ['ended', 'lost']);
  assert.deepEqual([w.lostOf(run)?.basis, w.lostOf(run)?.since], ['abandoned', since]);
  assert.equal(w.changes('task.continue').length, 0, '放弃的任务不接续');
  await w.dispatcher.tick();
  assert.equal(w.runsOf(task).length, 1);
});

test('abandoning a Task whose machine answers again stops the executor first', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.remote.down.delete('h1');
  await w.runner.abandon(task.id, '不做了', USER);
  assert.equal(w.remote.runOf(run.id).pid_alive, false, '连得上却没有先停');
  assert.equal(w.f.run(run.id).exit_kind, 'interrupted');
  assert.equal(w.f.task(task.id).state, 'abandoned');
});

test('abandon still refuses a Run that is running and reachable, and one that cannot be stopped', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  await assert.rejects(w.runner.abandon(task.id, '不做了', USER), /未结束的 Run/);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.remote.down.delete('h1');
  w.remote.unkillable = true;
  await assert.rejects(w.runner.abandon(task.id, '不做了', USER), /未结束的 Run/);
  assert.notEqual(w.f.task(task.id).state, 'abandoned');
});

test('an interrupt that cannot reach the machine ends as interrupted once the grace period is over, without waiting for a continuation', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  assert.equal(await w.runner.interrupt(run, USER), 'unknown');
  const stopping = w.f.run(run.id);
  assert.deepEqual([stopping.state, unknownFrom(stopping)], ['unknown', 'stopping']);
  w.advance(GRACE - MINUTE);
  assert.equal(await w.runner.verify(run), 'unknown', '宽限期内不结算');

  w.advance(MINUTE);
  assert.equal(await w.runner.verify(run), 'ended');
  const settled = w.f.run(run.id);
  assert.deepEqual([settled.state, settled.exit_kind], ['ended', 'interrupted'], '停止意图优先：不是 lost');
  assert.equal(w.lostOf(run)?.basis, 'presumed');
  const held = w.f.task(task.id);
  assert.deepEqual([held.state, held.reason], ['held', '已中断（机器失联）']);
  assert.equal(w.changes('task.continue').length, 0);
});

test('an interrupt asked while already out of contact does not start the grace period over', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  const since = w.unreachableSince(run);
  w.advance(GRACE - MINUTE);
  assert.equal(await w.runner.interrupt(run, USER), 'unknown');
  assert.equal(w.unreachableSince(run), since);
  assert.equal(w.f.task(task.id).state, 'needs_verification');
  w.advance(MINUTE);
  assert.equal(await w.runner.verify(run), 'ended');
  assert.equal(w.f.run(run.id).exit_kind, 'interrupted');
  assert.equal(w.f.task(task.id).state, 'held');
});

test('an interrupt of a Run out of contact that reaches the machine after all stops it the ordinary way', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.remote.down.delete('h1');
  assert.equal(await w.runner.interrupt(run, USER), 'ended');
  assert.equal(w.f.run(run.id).exit_kind, 'interrupted');
  assert.deepEqual([w.f.task(task.id).state, w.f.task(task.id).reason], ['held', '已中断']);
  assert.equal(w.lostOf(run), undefined);
});

test('machines are picked by fewest active Runs, then by their order in the account', async (t) => {
  const w = world(t, ['h1', 'h2', 'h3']);
  const hosts: string[] = [];
  for (let n = 0; n < 4; n += 1) hosts.push((await w.started(w.queued(`任务 ${n}`))).host);
  assert.deepEqual(hosts, ['h1', 'h2', 'h3', 'h1']);
});

test('a machine holding a Run out of contact, or one that failed to answer under a minute ago, is not offered work', async (t) => {
  const w = world(t, ['h1', 'h2']);
  const stuck = await w.started(w.queued('甲'));
  assert.equal(stuck.host, 'h1');
  w.remote.down.add('h1');
  await w.runner.verify(stuck);
  w.remote.down.delete('h1');
  w.advance(2 * MINUTE);
  // h1 answers again, but its Run has not been looked at since: still in the record.
  assert.equal((await w.started(w.queued('乙'))).host, 'h2');
  assert.equal((await w.started(w.queued('丙'))).host, 'h2', '有失联记录的机器被选中了');

  await w.runner.verify(stuck);
  assert.equal((await w.started(w.queued('丁'))).host, 'h1', '记录清除后又可以选它');

  // Past the moment an answer still stands for a probe.
  w.advance(MINUTE);
  w.remote.down.add('h1');
  const account = w.accounts.t1!;
  assert.equal((await w.runner.findMachine(account, w.f.ledger.listMachines()))?.id, 'h2');
  const probes = w.remote.called('read', undefined, 'h1');
  w.remote.down.delete('h1');
  assert.equal((await w.runner.findMachine(account, w.f.ledger.listMachines()))?.id, 'h2', '刚连不上的机器一分钟内不选');
  assert.equal(w.remote.called('read', undefined, 'h1'), probes);
});

test('a machine that does not take the upload has started nothing: the Run moves to the next one and no unknown Run is left', async (t) => {
  const w = world(t, ['h1', 'h2']);
  w.remote.uploadFails.add('h1');
  const task = w.queued();
  const run = await w.started(task);
  assert.equal(run.host, 'h2', 'run.host 固定这一轮实际用的那台');
  assert.equal(w.runsOf(task).length, 1, '换机器不该多出一个 Run');
  assert.equal(w.remote.called('start.sh', run.id, 'h1'), 0);
  assert.equal(w.remote.called('start.sh', run.id, 'h2'), 1);
  assert.deepEqual(w.changes('run.rehost').map(({ detail_json }) => JSON.parse(detail_json)), [{ from: 'h1', to: 'h2', machine_id: 'h2' }]);
  assert.equal(w.f.peek(`SELECT 1 FROM change WHERE action = 'run.unknown'`).length, 0);
});

// What a round may read is settled when it is prepared, for the machine it was meant for; one
// moved before it started is recorded and started by what the machine it goes to reported
// (runner/runner.ts rehost, runner/snapshot.ts machineInputsHere). A round that kept the first
// machine's report would be started with a switch for a server the second machine does not have.
test('a Run moved to another machine records that machine\'s MCP list: its knowledge MCP is absent there', async (t) => {
  const w = world(t, ['h1', 'h2'], {
    executors: { codex: codexAdapter },
    reported: (machine, executor) => ({
      executor, installed: true, version: 'codex-cli 0.167.1', logged_in: true,
      config: [{ kind: 'mcp', names: machine === 'h1' ? ['github', 'tycho-knowledge'] : ['github'] }],
    }),
  });
  w.accounts.t2 = { id: 't2', name: 't2', executor: 'codex', tiers: { execute: codexTier('m') } };
  w.store.list();
  const task = w.f.ledger.createTask(
    { projectId: w.f.projectId, title: '换机器', goal: '目标', acceptance: '测试通过', loginId: 't2', roleId: 'implement' },
    USER,
  );
  w.f.ledger.queueTask(task.id, USER);
  w.remote.uploadFails.add('h1');
  const run = await w.started(w.f.task(task.id));
  assert.equal(run.host, 'h2', 'h1 上传没成功，换到下一台');
  const snapshot = w.snapshotOf(w.f.run(run.id));
  assert.deepEqual(snapshot.machine_inputs!.config!.kinds.find(({ kind }) => kind === 'mcp'), { kind: 'mcp', names: ['github'] }, '快照照实记录目标机器的 MCP 清单');
  assert.deepEqual(snapshot.machine_inputs!.knowledge_mcp, { may_use: '按执行器原生配置运行' });
  assert.equal(roundTurn(snapshot, run.id).mcpOff, undefined, '启动参数里也不带关它的那一段');
});

test('when no machine takes the upload the Run ends as never started and the Task is queued again', async (t) => {
  const w = world(t, ['h1', 'h2']);
  w.remote.uploadFails.add('h1').add('h2');
  const task = w.queued();
  await w.dispatcher.tick();
  const [run] = w.runsOf(task);
  assert.deepEqual([w.remote.called('upload', run!.id, 'h1'), w.remote.called('upload', run!.id, 'h2')], [1, 1], '每台机器只试一次');
  assert.deepEqual([run?.state, run?.exit_kind], ['ended', 'lost']);
  assert.equal(w.lostOf(run!)?.basis, 'not_started');
  assert.equal(w.remote.called('start.sh'), 0);
  assert.equal(w.f.task(task.id).state, 'queued');
  assert.equal(w.f.peek(`SELECT 1 FROM change WHERE action = 'run.unknown'`).length, 0);
});

test('a failure once start.sh was sent does not move the Run to another machine', async (t) => {
  const w = world(t, ['h1', 'h2']);
  w.remote.startReplyLost = true;
  const task = w.queued();
  await w.dispatcher.tick();
  const [run] = w.runsOf(task);
  assert.deepEqual([run?.state, run?.host], ['launching', 'h1']);
  assert.equal(w.remote.called('start.sh'), 1, '启动可能已经执行，不能在别的机器再发');
  assert.equal(w.remote.called('upload', undefined, 'h2'), 0);
  assert.equal(await w.runner.verify(run!), 'running', '照旧按判定表走');
});

test('a account with no machine answering keeps its Tasks queued, lets other accounts go, and tells the owner once per stretch', async (t) => {
  const w = world(t, ['h1', 'h2']);
  holdMachine(w.f.ledger, testMachine('g1'), USER);
  // g1's own login, in a project of its own: it runs there and nowhere else, and this
  // project's work stays on h1 and h2.
  w.accounts.t2 = machineLogin('g1', 'claude', { tiers: w.accounts.t1!.tiers });
  w.f.ledger.setProjectMachines(w.f.projectId, uidsOf(w.f.ledger, ['h1', 'h2']), USER);
  w.store.list();
  const elsewhere = w.f.ledger.createProject({ name: '别处', logins: [w.accounts.t2.id] }, USER);
  w.remote.down.add('h1').add('h2');
  const waiting = w.queued('等机器');
  const other = w.f.ledger.createTask(
    { projectId: elsewhere, title: '别的目标', goal: '目标', acceptance: '测试通过', loginId: w.accounts.t2.id, roleId: 'implement' },
    USER,
  );
  w.f.ledger.queueTask(other.id, USER);

  await w.dispatcher.tick();
  assert.equal(w.f.task(waiting.id).state, 'queued', '没有机器是等容量，不进已停住');
  assert.equal(w.runsOf(waiting).length, 0, '不该留下 Run');
  assert.equal(w.runsOf(other)[0]?.host, 'g1', '排在后面的别的目标照常派发');
  assert.deepEqual(w.dispatcher.waitingLogins().map(({ login_id, overdue }) => [login_id, overdue]), [['t1', false]]);
  assert.equal(w.told.length, 0, '刚没有机器不通知：这只是在等容量');

  const probes = w.remote.called('read');
  await w.dispatcher.tick();
  assert.equal(w.remote.called('read'), probes, '刚连不上的机器不到一分钟又探测了');

  w.advance(GRACE);
  await w.dispatcher.tick();
  assert.ok(w.remote.called('read') > probes, '之后的轮次自然会再试');
  assert.deepEqual(w.told.map(({ account }) => account), ['t1'], '连续一个宽限期没有机器才通知');
  assert.equal(w.dispatcher.waitingLogins()[0]?.overdue, true);
  w.advance(2 * MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.told.length, 1, '同一次不可用只通知一次');
  assert.equal(w.f.task(waiting.id).state, 'queued');

  w.remote.down.clear();
  w.advance(2 * MINUTE);
  const run = await w.started(waiting);
  assert.equal(run.host, 'h1');
  assert.deepEqual(w.dispatcher.waitingLogins(), []);

  // Gone again: a new stretch, told again with its own beginning.
  w.remote.down.add('h1').add('h2');
  w.advance(2 * MINUTE);
  w.queued('又等机器');
  await w.dispatcher.tick();
  w.advance(GRACE);
  await w.dispatcher.tick();
  assert.equal(w.told.length, 2);
  assert.notEqual(w.told[1]?.since, w.told[0]?.since, '幂等键里的起始时刻属于这一次不可用');
});

test('a account nobody waits on any more is no longer reported as short of machines', async (t) => {
  const w = world(t, ['h1']);
  w.remote.down.add('h1');
  const task = w.queued();
  await w.dispatcher.tick();
  assert.equal(w.dispatcher.waitingLogins().length, 1);
  w.f.ledger.abandonTask(task.id, '不做了', USER);
  await w.dispatcher.tick();
  assert.deepEqual(w.dispatcher.waitingLogins(), []);
});

test('nothing is judged while dispatch is paused: no continuation is about to be sent', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.advance(GRACE);
  w.f.ledger.setPause(true, USER);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'unknown');
  w.f.ledger.setPause(false, USER);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).exit_kind, 'lost');
});

test('a start that was never confirmed gets the same grace period, then is revoked so that it cannot arrive late', async (t) => {
  const w = world(t, ['h1']);
  w.remote.startLost = true;
  const task = w.queued();
  await w.dispatcher.tick();
  const [old] = w.runsOf(task);
  assert.equal(old?.state, 'launching');
  w.remote.startLost = false;
  // The machine answers and shows no trace of the start: §4's first row.
  assert.equal(await w.runner.verify(old!), 'unknown');
  assert.equal(unknownFrom(w.f.run(old!.id)), 'launching');

  w.advance(GRACE - MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.f.run(old!.id).state, 'unknown', '宽限期内不动：启动可能还在路上');
  assert.equal(w.remote.called('stop.sh', old!.id), 0);

  w.advance(MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.remote.runOf(old!.id).revoked, true, '判定之前先撤销，迟到的启动起不来');
  assert.equal(w.f.run(old!.id).exit_kind, 'lost');
  assert.equal(w.lostOf(old!)?.basis, 'seen');
  const next = w.runsOf(task).at(-1)!;
  assert.deepEqual([next.id !== old!.id, next.state, next.host], [true, 'running', 'h1']);
  assert.equal(w.remote.runOf(next.id).round, 2);
});

test('a round the instance has already moved past does not start, ends as superseded and continues nothing', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  // The instance holds later rounds than this ledger knows of, as after a restored backup.
  w.remote.rounds.set(task.id, 5);
  await w.dispatcher.tick();
  const [run] = w.runsOf(task);
  assert.equal(w.remote.runOf(run!.id).pid_alive, false, '被取代的一轮不该起来');
  const settled = w.f.run(run!.id);
  assert.deepEqual([settled.state, settled.exit_kind, settled.exit_code], ['ended', 'lost', 86]);
  assert.equal(w.lostOf(run!)?.basis, 'superseded');
  const held = w.f.task(task.id);
  assert.deepEqual([held.state, held.reason], ['held', '这一轮已被更新的一轮取代']);
  assert.equal(w.changes('task.continue').length, 0, '被取代不产生新的接续');
});

test('a machine that answers again is cleared of what the ledger ended while it did not, and of nothing else', async (t) => {
  const w = world(t, ['h1']);
  const gone = w.queued('放弃的');
  const kept = w.queued('还在跑的');
  const goneRun = await w.started(gone);
  const keptRun = await w.started(kept);
  // A Run directory of some other ledger, with a live process.
  await w.remote.connect().place('.tycho/tasks/other-task/runs/stranger', 'x');
  Object.assign(w.remote.runOf('stranger'), { pid_alive: true, marked: true, host: 'h1' });

  w.remote.down.add('h1');
  await w.runner.verify(goneRun);
  await w.runner.abandon(gone.id, '不做了', USER);
  assert.equal(w.remote.runOf(goneRun.id).pid_alive, true, '连不上的时候什么都没杀');
  // The rounds above swept once already, when the machine first answered.
  const before = w.remote.called('list-runs.sh');
  await w.runner.sweep();
  assert.equal(w.remote.called('list-runs.sh'), before, '连不上的机器不清');

  w.remote.down.delete('h1');
  await w.runner.verify(keptRun);
  await w.runner.sweep();
  assert.equal(w.remote.called('list-runs.sh'), before + 1, '从连不上变回连得上就清，不等十分钟');
  assert.equal(w.remote.runOf(goneRun.id).pid_alive, false, '重连后账本里已结束的 Run 还活着');
  assert.equal(w.remote.called('stop.sh', keptRun.id), 0, '还在跑的 Run 不能碰');
  assert.equal(w.remote.called('stop.sh', 'stranger'), 0, '账本不认识的 Run 不能碰');
  assert.equal(w.remote.runOf('stranger').pid_alive, true);

  const listed = w.remote.called('list-runs.sh');
  await w.runner.sweep();
  assert.equal(w.remote.called('list-runs.sh'), listed, '十分钟内不重复清');
  w.advance(11 * MINUTE);
  await w.runner.sweep();
  assert.equal(w.remote.called('list-runs.sh'), listed + 1, '每十分钟再清一次');
});

test('a sweep that fails is logged and tried again, and never gets in the way', async (t) => {
  const w = world(t, ['h1']);
  await w.started(w.queued());
  w.remote.listFails = true;
  w.advance(11 * MINUTE);
  await w.runner.sweep();
  assert.match(w.logs.join('\n'), /清理 h1 上已结束的 Run 失败，下次再清.*list-runs\.sh 退出码 1/);
  w.remote.listFails = false;
  const listed = w.remote.called('list-runs.sh');
  w.advance(11 * MINUTE);
  await w.runner.sweep();
  assert.equal(w.remote.called('list-runs.sh'), listed + 1);
});

test('a machine nobody else has a reason to ask is asked by the sweep itself, every minute while it does not answer', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  // Given up while out of contact: no Run is left to watch, no Task left to dispatch.
  await w.runner.abandon(task.id, '不做了', USER);
  assert.equal(w.remote.runOf(run.id).pid_alive, true);
  const logged = w.logs.length;
  const listed = w.remote.called('list-runs.sh');
  await w.runner.sweep();
  assert.equal(w.remote.called('list-runs.sh'), listed, '不到一分钟不重复去连');
  w.advance(MINUTE);
  await w.runner.sweep();
  assert.equal(w.remote.called('list-runs.sh'), listed + 1);
  assert.equal(w.logs.length, logged, '还是连不上是预期内的事，不记成清理失败');

  w.remote.down.delete('h1');
  w.advance(MINUTE);
  await w.runner.sweep();
  assert.equal(w.remote.runOf(run.id).pid_alive, false, '机器回来后没人清掉已放弃任务的进程');
});

test('a sweep that could not reach a machine that came back leaves its clearing owed, not out of reach until the cooldown', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  // The ledger ended the round while the machine was away, and the machine still has it.
  w.f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  assert.equal(w.remote.runOf(run.id).pid_alive, true);

  // The client comes back with what it has running; the sweep that follows cannot reach
  // it (a command it never answers), so nothing is cleared.
  w.runner.machineBack('h1');
  w.remote.down.add('h1');
  await w.runner.sweep();
  assert.equal(w.remote.runOf(run.id).pid_alive, true, '没问到机器就清不掉');

  // It answers now. What it asked for when it came back is still owed, so the clearing is
  // due on the next sweep — not a cooldown (machine.cooldownMs) later, which is what a
  // machine that came back must not wait out for the rounds it is still holding.
  w.remote.down.delete('h1');
  await w.runner.sweep();
  assert.equal(w.remote.runOf(run.id).pid_alive, false, '机器答话后的一遍清扫就清掉');
});

test('a machine that comes back during a sweep is asked again by the next sweep without waiting', async (t) => {
  const w = world(t, ['h1']);
  // The listing visits the live round first, then waits for the ended round's stop.
  const live = await w.started(w.queued('还在跑的'));
  const ended = await w.started(w.queued('已结束的'));
  w.f.ledger.settleRun(ended.id, null, null, { kind: 'lost' });
  w.runner.machineBack('h1');
  const release = w.remote.hold('stop.sh');
  const sweeping = w.runner.sweep();
  try {
    await eventually(() => w.remote.called('stop.sh', ended.id) === 1, '清扫等着停止已结束的一轮');
    assert.equal(w.remote.called('stop.sh', live.id), 0, '清扫已经跳过还在跑的一轮');
    w.f.ledger.settleRun(live.id, null, null, { kind: 'lost' });
    w.runner.machineBack('h1');
  } finally {
    release();
    await sweeping;
  }
  assert.equal(w.remote.runOf(live.id).pid_alive, true, '本遍清扫没有回头清理刚结束的一轮');

  // No clock advance: the notification received during the sweep is still owed.
  const listed = w.remote.called('list-runs.sh');
  await w.runner.sweep();
  assert.equal(w.remote.called('list-runs.sh'), listed + 1, '清扫期间的重连通知不能被旧清扫吞掉');
  assert.equal(w.remote.runOf(live.id).pid_alive, false, '下一遍清扫就清掉刚结束的一轮');
});

test('a lost Run in a ledger restored from a backup does not continue by itself: the owner goes through it first', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  w.f.ledger.sealRestore('backup.db');
  w.vanish(run);
  assert.equal(await w.runner.verify(run), 'lost');
  const held = w.f.task(task.id);
  assert.deepEqual([held.state, held.reason], ['held', '恢复自备份，待确认']);
});

test('a Task left waiting for the owner by the old rules goes on at the next start', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  w.vanish(run);
  await w.runner.verify(run);
  // What the old rules left behind: the Run settled as lost, the Task waiting for "继续".
  w.f.force(`UPDATE task SET state = 'needs_verification', reason = '执行者状态未知' WHERE id = ?`, task.id);
  await w.runner.recover();
  assert.equal(w.f.task(task.id).state, 'queued');
  assert.equal(w.changes('task.continue').length, 2, '审计里要有这次接续');
  // One with its Run still out there is left to the rules above.
  const active = await w.started(task);
  const other = task;
  w.remote.down.add('h1');
  await w.runner.recover();
  assert.equal(w.f.task(other.id).state, 'needs_verification');
  assert.equal(w.f.run(active.id).state, 'unknown');
});

test('an unknown Run from before the grace period existed gets its start at the first look', async (t) => {
  const w = world(t, ['h1']);
  const run = await w.started(w.queued());
  w.f.ledger.markRunUnknown(run.id);
  w.f.force(`UPDATE run SET error_json = '{"unknown_from":"stopping"}' WHERE id = ?`, run.id);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  const stamped = w.f.run(run.id);
  assert.ok(unreachableSince(stamped));
  assert.equal(unknownFrom(stamped), 'stopping', '停止意图不能在补记时丢掉');
});

test('the ledger gives up a Task over an unknown Run only when told that Run could not be reached', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  assert.throws(() => f.ledger.abandonTask(task.id, '算了', USER, { runId: run.id }), InputError, '还在跑的 Run 不能这样放弃');
  f.ledger.markRunUnknown(run.id);
  assert.throws(() => f.ledger.abandonTask(task.id, '算了', USER), InputError);
  assert.throws(() => f.ledger.abandonTask(task.id, '算了', USER, { runId: 'someone-else' }), InputError);
  const approvals = f.count('approval');
  f.ledger.abandonTask(task.id, '算了', USER, { runId: run.id });
  assert.equal(f.task(task.id).state, 'abandoned');
  assert.equal(f.run(run.id).exit_kind, 'lost');
  assert.equal(f.count('approval'), approvals);
});

test('a Run can change machine only before it starts, and leaves the old machine\'s session behind', (t) => {
  const f = fixture(t);
  // An account: any machine there is may take its round.
  const account: Login = { id: 't1', name: 't1', executor: 'claude', tiers: LOGIN.login.tiers };
  for (const id of ['h2', 'h3']) holdMachine(f.ledger, testMachine(id), USER);
  f.ledger.putAccount(account, USER, 'ref-t1');
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, { ...f.login, login: account, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', session_ref: 's-on-h1' } }, USER);
  // Only to a machine the ledger holds and the project allows, as the login was when the Run
  // was created.
  assert.throws(() => f.ledger.rehostRun(run.id, testMachine('elsewhere')), /不能换到 elsewhere/);
  const moved = f.ledger.rehostRun(run.id, f.ledger.getMachine('h2')!);
  assert.equal(moved.host, 'h2');
  const snapshot = JSON.parse(moved.snapshot_json) as Snapshot;
  assert.equal(snapshot.session_ref, undefined);
  assert.equal(snapshot.brief, 'b');
  f.ledger.putAccount({ ...account, tiers: { execute: claudeTier('/tiers/other.json') } }, USER);
  assert.throws(() => f.ledger.rehostRun(run.id, f.ledger.getMachine('h3')!), /已改或已删/, '目标改过以后，它的机器不再是这一轮的');
  f.ledger.putAccount(account, USER);
  f.ledger.markRunRunning(run.id);
  assert.throws(() => f.ledger.rehostRun(run.id, f.ledger.getMachine('h3')!), InputError);
});

test('a Task resumed by the owner after losing every round still gets the brief about the lost round', async (t) => {
  const w = world(t, ['h1'], { lostLimit: 1 });
  const task = w.queued();
  const run = await w.started(task);
  w.vanish(run);
  await w.runner.verify(run);
  assert.equal(w.f.task(task.id).state, 'held');
  w.f.ledger.resumeTask(task.id, USER);
  const brief = w.snapshotOf(await w.started(task)).brief;
  assert.match(brief, /上一轮机器失联或进程中断，本轮自动接续/);
  assert.doesNotMatch(brief, /人工放行/);
});

// --- A Run whose machine answers again while it is still starting ---

test('a Run out of contact whose machine answers with the launcher still at work is launching again, no candidate, and under the wall clock', async (t) => {
  const w = world(t);
  const task = w.queued();
  w.remote.startReplyLost = true;
  await w.dispatcher.tick();
  w.remote.startReplyLost = false;
  const run = w.runsOf(task)[0]!;
  assert.equal(run.state, 'launching');
  // Past the gate and not yet at its Worker: §4's "starting, wait" row.
  Object.assign(w.remote.runOf(run.id), { started: true, launcher_alive: true, pid_alive: false, marked: false });
  w.remote.down.add('h1');
  assert.equal(await w.runner.verify(run), 'unknown');
  assert.equal(w.f.task(task.id).state, 'needs_verification');

  w.remote.down.delete('h1');
  assert.equal(await w.runner.verify(run), 'waiting');
  const back = w.f.run(run.id);
  assert.deepEqual([back.state, back.error_json], ['launching', null], '机器回答了、launcher 还在：回到启动中，失联记录清掉');
  assert.equal(w.f.task(task.id).state, 'running');
  w.advance(GRACE);
  assert.deepEqual(w.runner.lostCandidates(), [], '启动中的 Run 不是失联待接续的候选');
  assert.equal(await w.runner.presume(run, w.sending), 'waiting');
  assert.equal(w.f.run(run.id).state, 'launching');

  // The launcher never gets further. The wall clock, counted from created_at, ends the wait.
  w.f.force('UPDATE run SET created_at = ? WHERE id = ?', new Date(Date.now() - 4 * 60 * MINUTE).toISOString(), run.id);
  await w.runner.tail(run);
  const ended = w.f.run(run.id);
  assert.deepEqual([ended.state, ended.exit_kind], ['ended', 'interrupted'], '墙钟照旧从 created_at 起算并对它生效');
  assert.deepEqual([w.f.task(task.id).state, w.f.task(task.id).reason], ['held', '超时']);
});

test('a stop asked for while out of contact is kept when the machine answers with the launcher still at work', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, USER);
  assert.throws(() => f.ledger.markRunLaunching(run.id), InputError, '只有未知的 Run 才谈得上回到启动中');
  f.ledger.markRunUnknown(run.id);
  f.ledger.markRunStopping(run.id, USER);
  f.ledger.markRunLaunching(run.id);
  assert.deepEqual([f.run(run.id).state, f.task(task.id).state], ['stopping', 'stopping']);
});

// --- Two waits, two beginnings ---

test('any contact ends the stretch out of contact: a machine that answers, shows no start and fails again begins a new grace period', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.unconfirmed(task);
  w.remote.down.add('h1');
  assert.equal(await w.runner.verify(run), 'unknown');
  assert.ok(w.unreachableSince(run));
  assert.equal(w.unconfirmedSince(run), undefined, '还没连上过，谈不上“看不到启动痕迹”');

  w.advance(GRACE);
  w.remote.down.delete('h1');
  assert.equal(await w.runner.verify(run), 'unknown');
  assert.equal(w.unreachableSince(run), undefined, '连上了，不管看到什么，失联区间就结束');
  const waitingSince = w.unconfirmedSince(run);
  assert.ok(waitingSince, '启动未确认的等待从第一次在可达的机器上看不到启动痕迹算起');

  // Gone again at once. The old stretch was over; this one has only just begun.
  w.advance(MINUTE);
  w.remote.down.add('h1');
  assert.equal(await w.runner.verify(run), 'unknown');
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'unknown', '再次连不上是新的区间，不能沿用旧起点立刻判定');
  assert.equal(w.runsOf(task).length, 1);
  const secondStretch = w.unreachableSince(run);
  assert.ok(secondStretch);
  assert.equal(w.unconfirmedSince(run), waitingSince, '启动未确认的起点不随失联重置');

  w.advance(GRACE - MINUTE);
  await w.runner.verify(run);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'unknown', '新的区间也要满一个宽限期');
  w.advance(MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).exit_kind, 'lost');
  assert.deepEqual([w.lostOf(run)?.basis, w.lostOf(run)?.since], ['presumed', secondStretch]);
  assert.equal(w.runsOf(task).at(-1)?.host, 'h2');
});

test('a start nobody confirmed waits its own grace period, from the first answer that shows no trace of it, not from when contact was lost', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.unconfirmed(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.advance(GRACE - MINUTE);
  w.remote.down.delete('h1');
  assert.equal(await w.runner.verify(run), 'unknown');

  w.advance(MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.remote.called('stop.sh', run.id), 0, '看不到启动痕迹才一分钟，不能按失联的起点撤销');
  assert.equal(w.f.run(run.id).state, 'unknown');

  w.advance(GRACE - MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.remote.runOf(run.id).revoked, true, '到期后的撤销路径不变：先占住门闩');
  assert.deepEqual([w.f.run(run.id).exit_kind, w.lostOf(run)?.basis], ['lost', 'seen']);
  assert.equal(w.runsOf(task).length, 2);
});

// A machine that answers "I cannot read this round's record" has not seen the round gone.
// It is not a start nobody confirmed either: no grace period runs out on it and nothing is
// revoked. Settling it as seen gone would continue a round whose Worker may have finished
// with a result nobody could read; only an answer the machine can give ends the wait.
test('a machine that cannot read the round\'s record is never taken as having seen it gone, however long it says so', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  Object.assign(w.remote.runOf(run.id), { pid_alive: false, marked: false, launcher_alive: false, unknown: '读不出 exit：EACCES' });
  assert.equal(await w.runner.verify(run), 'unknown');
  w.advance(GRACE * 2);
  await w.dispatcher.tick();
  assert.equal(w.remote.runOf(run.id).revoked, false, '查不清不是启动未确认：不撤销');
  assert.equal(w.f.run(run.id).state, 'unknown', '仍是未知，不判看到不在');
  assert.equal(w.runsOf(task).length, 1, '不接续');
  // The machine can say again: the Run is judged on that answer.
  Object.assign(w.remote.runOf(run.id), { unknown: null, pid_alive: true });
  assert.equal(await w.runner.verify(w.f.run(run.id)), 'running');
});

// The revoke is the last look at a start nobody confirmed, and what that look finds is
// judged like any other answer: a round that finished is settled with its exit code and its
// result, not as lost.
test('a start nobody confirmed that the revoke finds finished is settled with its exit code, not as lost', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.unconfirmed(task);
  assert.equal(await w.runner.verify(run), 'unknown');
  // The round ran after all; its answer only shows once the revoke has taken the gate.
  w.remote.finish(run.id, { status: 'done', summary: '做完了' }, 0);
  w.advance(GRACE);
  await w.dispatcher.tick();
  const settled = w.f.run(run.id);
  assert.equal(w.remote.runOf(run.id).revoked, true, '到期照常撤销');
  assert.deepEqual([settled.state, settled.exit_kind, settled.exit_code], ['ended', 'completed', 0], '撤销后读到的退出码照常结算');
  assert.equal(w.lostOf(run), undefined, '不算丢失');
});

test('the ledger keeps the two waits apart: an answer ends the stretch out of contact, and the wait for the start begins at that answer', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, USER);
  const marks = (): { unknown_from?: string; unreachable_since?: string; unconfirmed_since?: string } =>
    JSON.parse(f.run(run.id).error_json ?? '{}');
  // Out of contact since long ago, as far as the ledger's own clock goes.
  const LONG_AGO = '2026-11-05T01:00:00.000Z';
  const backdate = (field: string): void =>
    f.force(`UPDATE run SET error_json = json_set(error_json, '$.${field}', '${LONG_AGO}') WHERE id = ?`, run.id);
  f.ledger.markRunUnknown(run.id, 'unreachable');
  backdate('unreachable_since');
  const changes = f.count('change');
  f.ledger.markRunUnknown(run.id, 'unreachable');
  assert.equal(marks().unreachable_since, LONG_AGO, '之后每次连不上都不重置起点');
  assert.equal(f.count('change'), changes, '没有变化就什么都不写');

  f.ledger.markRunUnknown(run.id, 'unconfirmed');
  const first = marks();
  assert.equal(first.unreachable_since, undefined, '连上了，失联区间结束');
  assert.ok(first.unconfirmed_since && first.unconfirmed_since !== LONG_AGO, '启动未确认从这次回答算起，不沿用失联的起点');
  assert.equal(first.unknown_from, 'launching');
  backdate('unconfirmed_since');
  f.ledger.markRunUnknown(run.id, 'unconfirmed');
  assert.equal(marks().unconfirmed_since, LONG_AGO, '之后每次看不到启动痕迹都不重置这个起点');

  f.ledger.markRunUnknown(run.id, 'unreachable');
  const again = marks();
  assert.ok(again.unreachable_since && again.unreachable_since !== LONG_AGO, '再连不上是新的区间');
  assert.equal(again.unconfirmed_since, LONG_AGO, '启动未确认的起点还在');
  assert.equal(f.task(task.id).state, 'needs_verification');
});

test('a machine that failed to answer is asked again a minute later, whatever the wall clock was set to meanwhile', async (t) => {
  const w = world(t, ['h1']);
  const account = w.accounts.t1!;
  w.remote.down.add('h1');
  assert.equal((await w.runner.findMachine(account, w.f.ledger.listMachines()))?.id, undefined);
  w.remote.down.delete('h1');
  w.jump(-3 * GRACE);
  w.advance(MINUTE - 1000);
  assert.equal((await w.runner.findMachine(account, w.f.ledger.listMachines()))?.id, undefined, '刚连不上的机器一分钟内不选');
  w.advance(1000);
  assert.equal((await w.runner.findMachine(account, w.f.ledger.listMachines()))?.id, 'h1', '墙钟往回拨了，机器不能因此一直不被选');
});

test('with a grace period of one minute a stretch out of contact still counts from its own beginning', async (t) => {
  const w = world(t);
  w.setGrace(MINUTE);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.advance(MINUTE - 1000);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'unknown', '差一秒不到宽限期');

  // It answers once, with the executor there, and is gone again.
  w.remote.down.delete('h1');
  assert.equal(await w.runner.verify(run), 'running');
  w.remote.down.add('h1');
  assert.equal(await w.runner.verify(run), 'unknown');
  w.advance(MINUTE - 1000);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'unknown', '两段失联加起来过了一分钟，但哪一段都没满');
  assert.equal(w.runsOf(task).length, 1);

  w.advance(1000);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).exit_kind, 'lost');
  assert.equal(w.runsOf(task).at(-1)?.host, 'h2');
});

// --- Clocks ---

test('the wall clock set forward judges nothing early: a stretch this process saw begin is timed by the clock that cannot be set', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.jump(3 * GRACE);
  assert.deepEqual(w.runner.lostCandidates(), []);
  await w.dispatcher.tick();
  assert.equal(await w.runner.presume(run, w.sending), 'unknown');
  assert.equal(w.f.run(run.id).state, 'unknown', '墙钟向前跳了，实际只失联了一会儿');
  assert.equal(w.runsOf(task).length, 1);

  w.advance(GRACE);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).exit_kind, 'lost');
  assert.equal(w.runsOf(task).length, 2);
});

test('the wall clock set back does not put the judgment off: the grace period still runs out', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.jump(-3 * GRACE);
  w.advance(GRACE - MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).state, 'unknown');
  w.advance(MINUTE);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).exit_kind, 'lost', '墙钟向后跳了，失联的时间照样在过');
  assert.equal(w.lostOf(run)?.basis, 'presumed');
  assert.equal(w.runsOf(task).at(-1)?.host, 'h2');
});

test('a start nobody confirmed is not revoked early by a wall clock set forward either', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.unconfirmed(task);
  assert.equal(await w.runner.verify(run), 'unknown');
  w.jump(3 * GRACE);
  await w.dispatcher.tick();
  assert.equal(w.remote.called('stop.sh', run.id), 0);
  w.advance(GRACE);
  await w.dispatcher.tick();
  assert.equal(w.remote.runOf(run.id).revoked, true);
});

// --- The limit on losses ---

function rounds(t: TestContext, limit: number) {
  const f = fixture(t);
  tune(f.ledger, 'run.maxLostContinuations', limit);
  const task = f.queuedTask();
  const round = (settle: (runId: string) => void, started = true): string => {
    const run = f.ledger.createRun(task.id, f.login, USER);
    if (started) f.ledger.markRunRunning(run.id);
    settle(run.id);
    return f.task(task.id).state;
  };
  return {
    f,
    task,
    lost: (): string => round((runId) => f.ledger.settleRun(runId, null, null, { kind: 'lost' })),
    // No machine took the upload: nothing of the round ever ran.
    notStarted: (): string => round((runId) => f.ledger.settleRun(runId, null, null, { kind: 'lost', lost: { basis: 'not_started' } }), false),
  };
}

test('the count of lost rounds starts again from zero when the owner lets the Task go on', (t) => {
  const { f, task, lost } = rounds(t, 2);
  assert.equal(lost(), 'queued');
  assert.equal(lost(), 'held');
  assert.equal(f.task(task.id).reason, '连续 2 次执行都丢失');
  f.ledger.resumeTask(task.id, USER);
  assert.equal(lost(), 'queued', '主人点了继续，之前的丢失不再算');
  assert.equal(lost(), 'held');
  assert.equal(f.task(task.id).reason, '连续 2 次执行都丢失');
});

test('a round no machine took is not a lost execution: it neither counts nor starts the count again', (t) => {
  const { f, task, lost, notStarted } = rounds(t, 2);
  assert.equal(notStarted(), 'queued');
  assert.equal(notStarted(), 'queued');
  assert.equal(notStarted(), 'queued', '没启动过的轮次不消耗丢失次数');
  assert.equal(lost(), 'queued');
  assert.equal(notStarted(), 'queued');
  assert.equal(lost(), 'held', '没启动过的轮次也不打断计数');
  assert.equal(f.task(task.id).reason, '连续 2 次执行都丢失');
  f.ledger.resumeTask(task.id, USER);
  assert.equal(notStarted(), 'queued', '到了上限、继续之后，没启动过的轮次照样只是回队列');
});

test('with a limit of one, a round no machine took still leaves its Task queued', (t) => {
  const { f, task, notStarted } = rounds(t, 1);
  assert.equal(notStarted(), 'queued');
  const [event] = f.peek<{ text: string }>(`SELECT text FROM message WHERE channel = 'internal' ORDER BY rowid DESC LIMIT 1`);
  assert.match(event!.text, /没有启动，已回到队列等可用的机器/);
  assert.doesNotMatch(event!.text, /执行丢失/);
  assert.equal(f.task(task.id).reason, null);
});

test('a Task the old rules left waiting is continued under the same limit as any other', async (t) => {
  const w = world(t, ['h1'], { lostLimit: 1 });
  const task = w.queued();
  const run = await w.started(task);
  w.vanish(run);
  await w.runner.verify(run);
  assert.equal(w.f.task(task.id).state, 'held');
  // What the old rules left behind: the Run settled as lost, the Task waiting for "继续".
  w.f.force(`UPDATE task SET state = 'needs_verification', reason = '执行者状态未知' WHERE id = ?`, task.id);
  await w.runner.recover();
  const after = w.f.task(task.id);
  assert.deepEqual([after.state, after.reason], ['held', '连续 1 次执行都丢失'], '旧状态修复绕过了上限');
  assert.equal(w.changes('task.continue').length, 0);
});

test('inputs bound to a round no machine took were never delivered: the next round takes them, and the history says that round did not start', async (t) => {
  const w = world(t, ['h1', 'h2'], { lostLimit: 1 });
  w.remote.uploadFails.add('h1').add('h2');
  const task = w.queued();
  w.f.ledger.addInput(task.id, '顺便改一下文档', USER);
  await w.dispatcher.tick();
  const [dud] = w.runsOf(task);
  assert.equal(w.lostOf(dud!)?.basis, 'not_started');
  assert.equal(w.f.task(task.id).state, 'queued', '上限是 1 也不停住：这不是执行丢失');
  const bound = w.f.peek<{ state: string; run_id: string | null }>('SELECT state, run_id FROM input WHERE task_id = ?', task.id);
  assert.deepEqual(bound.map(({ state, run_id }) => [state, run_id]), [['queued', null]], '没送达过的插话回到待送达');
  assert.deepEqual(w.dispatcher.waitingLogins().map(({ login_id }) => login_id), ['t1'], '按没有可用的机器处理');

  w.remote.uploadFails.clear();
  w.advance(2 * MINUTE);
  const run = await w.started(task);
  const snapshot = w.snapshotOf(run);
  assert.deepEqual(snapshot.inputs?.map(({ text }) => text), ['顺便改一下文档'], '下一轮照常重新绑定');
  const [history] = snapshot.history as { exit_kind: string; not_started?: boolean; undelivered_inputs?: { text: string }[]; unconfirmed_inputs?: unknown }[];
  assert.deepEqual([history?.exit_kind, history?.not_started], ['lost', true]);
  assert.deepEqual(history?.undelivered_inputs?.map(({ text }) => text), ['顺便改一下文档']);
  assert.equal(history?.unconfirmed_inputs, undefined, '确定没有执行，不是“是否执行未确认”');
  assert.match(snapshot.brief, /`history` 中带 `not_started` 的轮次未启动，其 `undelivered_inputs` 已重新并入 `pending_inputs`/);
  assert.doesNotMatch(snapshot.brief, /上一轮机器失联或进程中断/, '上一轮没有启动过，没有现场可核对');
  assert.equal(w.remote.runOf(run.id).round, 2, '轮次序号照旧按 Run 数');
  assert.deepEqual(w.dispatcher.waitingLogins(), [], '有一台接下了上传，才算有机器');
});

test('a round no machine took between a lost round and its continuation changes nothing about what the continuation is told', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  w.vanish(run);
  await w.runner.verify(run);
  w.remote.uploadFails.add('h1');
  await w.dispatcher.tick();
  assert.equal(w.lostOf(w.runsOf(task)[1]!)?.basis, 'not_started');
  w.remote.uploadFails.clear();
  w.advance(2 * MINUTE);
  const next = await w.started(task);
  assert.match(w.snapshotOf(next).brief, /上一轮机器失联或进程中断，本轮自动接续/, '上一轮真正跑过的那一轮是丢失的');
});

test('a account whose machines answer the probe and take no upload is short of machines: the Task waits and the owner is told once', async (t) => {
  const w = world(t, ['h1'], { lostLimit: 1 });
  w.remote.uploadFails.add('h1');
  const task = w.queued();
  await w.dispatcher.tick();
  const [first] = w.dispatcher.waitingLogins();
  assert.equal(first?.login_id, 't1');
  for (let minute = 0; minute < 14; minute += 2) {
    w.advance(2 * MINUTE);
    await w.dispatcher.tick();
  }
  assert.deepEqual(w.told, [{ account: 't1', since: first!.since }], '探测成功不算有机器：计时不能每次重来');
  assert.equal(w.f.task(task.id).state, 'queued');
  assert.ok(w.runsOf(task).length > 1 && w.runsOf(task).every((run) => w.lostOf(run)?.basis === 'not_started'));
});

// --- A pause or a stop while a machine is being asked ---

test('a pause that arrives while the last probe is out judges nothing: no continuation is about to be sent', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.advance(GRACE);
  const probes = w.remote.called('state.sh', run.id);
  const release = w.remote.hold('state.sh');
  const ticking = w.dispatcher.tick();
  await eventually(() => w.remote.called('state.sh', run.id) === probes + 1, '接续前的最后一次探测发出');
  w.f.ledger.setPause(true, USER);
  release();
  await ticking;
  assert.equal(w.f.run(run.id).state, 'unknown', '暂停期间不作废旧 Run');
  assert.equal(w.runsOf(task).length, 1);

  w.f.ledger.setPause(false, USER);
  await w.dispatcher.tick();
  assert.equal(w.f.run(run.id).exit_kind, 'lost');
});

test('a stop that arrives while the last probe is out judges nothing and starts nothing', async (t) => {
  const w = world(t);
  const task = w.queued();
  const run = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(run);
  w.advance(GRACE);
  const probes = w.remote.called('state.sh', run.id);
  const release = w.remote.hold('state.sh');
  const ticking = w.dispatcher.tick();
  await eventually(() => w.remote.called('state.sh', run.id) === probes + 1, '接续前的最后一次探测发出');
  const stopped = w.dispatcher.stop();
  release();
  await ticking;
  await stopped;
  assert.equal(w.f.run(run.id).state, 'unknown', '停服之后不再判定旧 Run');
  assert.equal(w.runsOf(task).length, 1);
});

test('a start nobody confirmed is not revoked once dispatch is paused', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.unconfirmed(task);
  await w.runner.verify(run);
  w.advance(GRACE);
  const probes = w.remote.called('state.sh', run.id);
  const release = w.remote.hold('state.sh');
  const ticking = w.dispatcher.tick();
  await eventually(() => w.remote.called('state.sh', run.id) === probes + 1, '接续前的核实发出');
  w.f.ledger.setPause(true, USER);
  release();
  await ticking;
  assert.equal(w.remote.called('stop.sh', run.id), 0, '暂停了就不撤销：没有接续要发出');
  assert.equal(w.f.run(run.id).state, 'unknown');
});

test('a stop that arrives while a machine is being picked starts nothing', async (t) => {
  const w = world(t);
  const task = w.queued();
  const release = w.remote.hold('read');
  const ticking = w.dispatcher.tick();
  await eventually(() => w.remote.called('read') > 0, '选机器的探测发出');
  const stopped = w.dispatcher.stop();
  release();
  await ticking;
  await stopped;
  assert.equal(w.runsOf(task).length, 0, '停服之后还创建了 Run');
  assert.equal(w.remote.called('start.sh'), 0);
  assert.equal(w.f.task(task.id).state, 'queued');
});

// --- While the old round and its continuation are both alive ---

test('an old round still alive beside its continuation changes nothing until its own watch ends it, and what it leaves is history', async (t) => {
  const w = world(t);
  const task = w.queued();
  const old = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(old);
  w.advance(GRACE);
  await w.dispatcher.tick();
  const next = w.runsOf(task)[1]!;
  assert.equal(next.state, 'running');
  assert.deepEqual([w.remote.runOf(old.id).pid_alive, w.remote.runOf(next.id).pid_alive], [true, true], '新的一轮启动并不替脚本消灭旧的一轮');

  // The old machine is back while both are alive. The old Run is over for the ledger.
  w.remote.down.delete('h1');
  assert.equal(await w.runner.verify(old), 'ended');
  assert.equal(w.remote.called('stop.sh', next.id), 0);
  assert.deepEqual([w.f.task(task.id).state, w.f.run(next.id).state], ['running', 'running']);

  // Its watch looks at the rounds and finds a later one.
  assert.deepEqual(w.remote.watchLooks(), [old.id]);
  assert.deepEqual([w.remote.runOf(old.id).pid_alive, w.remote.runOf(old.id).exit], [false, 86]);
  assert.equal(w.remote.runOf(next.id).pid_alive, true, '看门循环只停被取代的那一轮');
  assert.equal(await w.runner.verify(next), 'running');
  const settled = w.f.run(old.id);
  assert.deepEqual([settled.exit_kind, settled.exit_code, w.lostOf(old)?.basis], ['lost', null, 'presumed'], '第一次结算不变');
  assert.equal(w.f.task(task.id).state, 'running');
  assert.equal(w.runsOf(task).length, 2);
});

test('an old round still alive when its machine answers again is cleared by the sweep, before its watch has looked', async (t) => {
  const w = world(t);
  const task = w.queued();
  const old = await w.started(task);
  w.remote.down.add('h1');
  await w.runner.verify(old);
  w.advance(GRACE);
  await w.dispatcher.tick();
  const next = w.runsOf(task)[1]!;
  assert.equal(w.remote.runOf(old.id).pid_alive, true);

  w.remote.down.delete('h1');
  w.advance(2 * MINUTE);
  await w.runner.sweep();
  assert.equal(w.remote.runOf(old.id).pid_alive, false, '重连即清');
  assert.equal(w.remote.called('stop.sh', next.id), 0);
  assert.equal(w.remote.runOf(next.id).pid_alive, true);
  assert.deepEqual(w.remote.watchLooks(), [], '已经清掉的不用再等看门循环');
});

test('a Run the ledger still follows whose watch found a later round ends as superseded and continues nothing', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  // A later round appeared that this ledger knows nothing of, as after a restored backup.
  w.remote.rounds.set(task.id, 2);
  assert.equal(await w.runner.verify(run), 'running', '看门循环还没看之前，它照常在跑');
  assert.deepEqual(w.remote.watchLooks(), [run.id]);
  assert.equal(await w.runner.verify(run), 'ended');
  const settled = w.f.run(run.id);
  assert.deepEqual([settled.exit_kind, settled.exit_code, w.lostOf(run)?.basis], ['lost', 86, 'superseded']);
  assert.deepEqual([w.f.task(task.id).state, w.f.task(task.id).reason], ['held', '这一轮已被更新的一轮取代']);
});

// --- The owner's settings, through one whole service ---

test('what the owner sets on the settings page is what the Runner judges by, what the pages show, and where the ledger stops', { timeout: 90_000 }, async (t) => {
  const { remote, start, queued, launched, runsOf } = stage(t, { t1: { id: 't1', name: 't1', executor: 'claude', tiers: STAGE_ACCOUNT.tiers } }, ['h1', 'h2']);
  let passed = 0;
  const service = await start({ now: () => Date.now() + passed, monotonic: () => performance.now() + passed }, { credentials: { t1: 'token-t1' } });
  const client = await signIn(service);
  const set = (key: string, value: number): Promise<Response> =>
    fetch(`${client.base}/api/settings/${key}`, {
      method: 'PUT',
      headers: { Cookie: client.cookie, Origin: client.base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  // Neither is the default: ten minutes, three rounds.
  assert.equal((await set('run.lostGraceMs', 2 * MINUTE)).status, 200);
  assert.equal((await set('run.maxLostContinuations', 1)).status, 200);

  const task = queued(service);
  const run = await launched(service, task);
  remote.down.add('h1');
  await until(() => service.ledger.getRun(run.id).state === 'unknown', '发现连不上');
  const since = unreachableSince(service.ledger.getRun(run.id))!;
  const { lost } = (await (await client.get(`/api/tasks/${task.id}`)).json() as { task: { lost: { eligible_at: string; blocked: string } } }).task;
  assert.equal(lost.eligible_at, new Date(Date.parse(since) + 2 * MINUTE).toISOString(), '页面上的时刻要按设置的宽限期');
  assert.equal(lost.blocked, 'limit', '页面按设置的上限说明：这一轮丢了就不再接续');

  passed += 2 * MINUTE - 10_000;
  await sleep(200);
  assert.equal(service.ledger.getRun(run.id).state, 'unknown', '设置的两分钟还没到');
  passed += 10_000;
  await until(() => service.ledger.getRun(run.id).state === 'ended', 'Runner 按设置的两分钟判定，而不是默认的十分钟');
  assert.equal(service.ledger.getRun(run.id).exit_kind, 'lost');
  const held = service.ledger.getTask(task.id);
  assert.deepEqual([held.state, held.reason], ['held', '连续 1 次执行都丢失'], '账本按设置的上限停住，而不是默认的三次');
  assert.equal(runsOf(service, task).length, 1);
});

// Against an executor that wrote on a machine slipping out of a review's exclusion: its
// start was never answered, and its process vanished without an exit. What the machine
// showed of the start is kept, and the round judged lost still says it started.
test('a round whose start answer was lost and whose machine shows the start keeps that it started, judged lost or not', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  w.remote.startReplyLost = true;
  await w.dispatcher.tick();
  w.remote.startReplyLost = false;
  const run = w.runsOf(task)[0]!;
  assert.deepEqual([run.state, run.started_at], ['launching', null]);
  w.vanish(run);
  assert.equal(await w.runner.verify(run), 'lost');
  const ended = w.f.run(run.id);
  assert.equal(ended.state, 'ended');
  assert.notEqual(ended.started_at, null, '机器上看得到它启动过：记下来，丢失的结算也不抹掉');
  assert.equal(w.changes('run.started_seen').length, 1);
});

// Against a round whose Worker never ran (nothing to run it with on the machine) being
// counted as one that started: settled as an ordinary failure, its executor would count as
// the product's author and be kept from reviewing it, and its inputs would count as handed
// over. Only the machine's evidence says so — an exit code of 2 alone does not.
test('a round whose machine confirms its Worker never ran did not start: no start kept, no author, its inputs go back', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  w.f.ledger.addInput(task.id, '顺便改一下文档', USER);
  const run = await w.started(task);
  assert.notEqual(w.f.run(run.id).started_at, null, '启动确认时先记下了启动');
  const said = 'Worker 没能启动：PATH 里找不到 claude';
  Object.assign(w.remote.runOf(run.id), { pid_alive: false, marked: false, launcher_alive: false, exit: 2, stderr: `${said}\n`, not_started: said });
  assert.equal(await w.runner.verify(run), 'ended');
  const ended = w.f.run(run.id);
  assert.deepEqual([ended.state, ended.exit_kind, ended.started_at], ['ended', 'failed', null], '机器说 Worker 没起来：启动记录撤掉');
  assert.equal((JSON.parse(ended.error_json ?? '{}') as { worker_not_started?: string }).worker_not_started, said);
  assert.deepEqual([w.f.task(task.id).state, w.f.task(task.id).reason], ['held', said], '理由是原话，不是退出码');
  assert.deepEqual(writersOf([ended]), [], '没起来的执行器没写过产物');
  const [input] = w.f.peek<{ state: string; run_id: string | null }>(`SELECT state, run_id FROM input WHERE task_id = ?`, task.id);
  assert.deepEqual([input?.state, input?.run_id], ['queued', null], '绑定的插话没送到，下一轮重新带上');
  assert.equal(w.changes('run.started_seen').length, 0);
});

test('a Worker that exits 2 by itself still ran: without the machine\'s evidence the round keeps its start and its author', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  Object.assign(w.remote.runOf(run.id), { pid_alive: false, marked: false, launcher_alive: false, exit: 2, stderr: 'usage error\n' });
  assert.equal(await w.runner.verify(run), 'ended');
  const ended = w.f.run(run.id);
  assert.notEqual(ended.started_at, null);
  assert.deepEqual(writersOf([ended]), ['claude']);
});

// Against a Worker that ran, wrote, and then wrote the watch's "nothing ran" file itself:
// the machine's answer is built from the real files (node/runbox.ts) and goes through the
// Runner to the ledger, which keeps the start and the author.
test('a "nothing ran" file beside a Worker the watch did start is not believed: the start and the author stay', async (t) => {
  const w = world(t, ['h1']);
  const task = w.queued();
  const run = await w.started(task);
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-forged-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const box = boxOf(dataDir, `tasks/${task.id}/runs/${run.id}`);
  assert.equal(takeGate(box), true);
  writeWatchEvidence(box, 999_999, 'then');
  writeWorkerEvidence(box, 999_998, 'then');
  writeNotStarted(box, 'Worker 没能启动：forged');
  writeLeft(box, 'none');
  writeExit(box, 2);
  const state = await runState(box, selectProcesses());
  Object.assign(w.remote.runOf(run.id), state, { stderr: 'Worker 没能启动：forged\n' });
  assert.equal(await w.runner.verify(run), 'ended');
  const ended = w.f.run(run.id);
  assert.notEqual(ended.started_at, null, '启动记录不被撤掉');
  assert.equal((JSON.parse(ended.error_json ?? '{}') as { worker_not_started?: string }).worker_not_started, undefined);
  assert.deepEqual(writersOf([ended]), ['claude'], '仍算写过产物');
});
