import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { Account, Snapshot } from '../runner/snapshot.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import { createAcceptor } from '../service/accept.ts';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { createLandingTask, landableOf } from '../service/land.ts';
import { openLedger, type RunRow } from '../service/ledger.ts';
import { roundCode, productStale } from '../service/review.ts';
import { SETTINGS } from '../service/settings.ts';
import {
  claudeTier,
  codexTier,
  DISPATCH_TUNED,
  DONE,
  fixture,
  holdMachine,
  memoryLogins,
  testMachine,
  tune,
  USER,
} from './helpers.ts';

const CLAUDE_A: Account = {
  id: 'acc-a',
  name: 'claude-a',
  executor: 'claude',
  tiers: {
    operate: claudeTier('/tiers/op-a.json'),
    execute: claudeTier('/tiers/ex-a.json'),
    decide: claudeTier('/tiers/de-a.json'),
  },
};

const CODEX_B: Account = {
  id: 'acc-b',
  name: 'codex-b',
  executor: 'codex',
  tiers: {
    operate: codexTier('operate'),
    execute: codexTier('execute'),
    decide: codexTier('decide'),
  },
};

const CLAUDE_C: Account = {
  id: 'acc-c',
  name: 'claude-c',
  executor: 'claude',
  tiers: {
    execute: claudeTier('/tiers/ex-c.json'),
    decide: claudeTier('/tiers/de-c.json'),
  },
};

test('v46 -> v47 migration adds project.dispatch_order_json and verifies snapshot', (t) => {
  const f = fixture(t);
  const path = join(f.dir, 'v46.db');
  const db = new Db(path, false, {}, { log: () => {} });
  db.close();
  // Downgrade to v46 by dropping dispatch_order_json and resetting schema_version to 46.
  const raw = new DatabaseSync(path);
  raw.exec(`
    ALTER TABLE project DROP COLUMN dispatch_order_json;
    UPDATE setting SET value_json = '46' WHERE key = 'schema_version';
  `);
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.close();

  const v46Snap = join(f.dir, 'snap-v46.db');
  const c1 = new DatabaseSync(path);
  c1.prepare('VACUUM INTO ?').run(v46Snap);
  c1.close();
  assert.equal(verifySnapshot(v46Snap).get('schema_version'), '46');

  const upgraded = openLedger(path, { copyBeforeUpgrade: false });
  try {
    assert.equal(SCHEMA_VERSION, 48);
    const pid = upgraded.createProject({ name: '迁移项目' }, USER);
    assert.equal(upgraded.projectDispatchOrder(pid), null);
    upgraded.setProjectDispatchOrder(pid, { execute: ['x1', 'x1', 'x2'] }, USER);
    // Non-existent logins are filtered out on read.
    assert.equal(upgraded.projectDispatchOrder(pid), null);
  } finally {
    upgraded.close();
  }

  const v48Snap = join(f.dir, 'snap-v48.db');
  const c2 = new DatabaseSync(path);
  c2.prepare('VACUUM INTO ?').run(v48Snap);
  c2.close();
  assert.equal(verifySnapshot(v48Snap).get('schema_version'), '48');
});

test('per-project tier priority override falls back to global default and scrubs deleted logins', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(CLAUDE_A, USER, 'ref-a');
  f.ledger.putAccount(CODEX_B, USER, 'ref-b');
  f.ledger.putAccount(CLAUDE_C, USER, 'ref-c');
  f.ledger.setProjectLogins(f.projectId, [CLAUDE_A.id, CODEX_B.id, CLAUDE_C.id], USER, 'selected');
  tune(f.ledger, 'dispatch.order.execute', [CLAUDE_A.id, CODEX_B.id, CLAUDE_C.id]);

  // Without project override, falls back cleanly to global tier order.
  assert.equal(f.ledger.projectDispatchOrder(f.projectId), null);
  assert.deepEqual(f.ledger.loginOrder('execute', f.projectId).slice(0, 3), [CLAUDE_A.id, CODEX_B.id, CLAUDE_C.id]);

  // Validation rejects invalid tier keys and non-string arrays.
  assert.throws(() => f.ledger.setProjectDispatchOrder(f.projectId, { bogus: [CLAUDE_A.id] } as never, USER), /未知档位/);
  assert.throws(() => f.ledger.setProjectDispatchOrder(f.projectId, { execute: [123 as never] }, USER), /字符串数组/);

  // Set per-project override for execute only (with duplicates & empty decide array removed).
  f.ledger.setProjectDispatchOrder(
    f.projectId,
    { execute: [CODEX_B.id, CODEX_B.id], decide: [] },
    USER,
  );
  assert.deepEqual(f.ledger.projectDispatchOrder(f.projectId), { execute: [CODEX_B.id] });

  // Execute uses project override first, then global order, deduplicated.
  assert.deepEqual(f.ledger.loginOrder('execute', f.projectId).slice(0, 3), [CODEX_B.id, CLAUDE_A.id, CLAUDE_C.id]);
  // Decide has no project override, falls back to global order.
  assert.equal(f.ledger.loginOrder('decide', f.projectId)[0], CLAUDE_A.id);

  // effectiveProjectDispatchOrder intersects with project's allowed pool.
  f.ledger.setProjectLogins(f.projectId, [CODEX_B.id, CLAUDE_C.id], USER, 'selected');
  const eff = f.ledger.effectiveProjectDispatchOrder(f.projectId);
  assert.deepEqual(eff.execute, [CODEX_B.id, CLAUDE_C.id]);
  assert.ok(!eff.execute.includes(CLAUDE_A.id));

  // Deleting a login scrubs it from dispatch_order_json even in login_mode='all' projects.
  const pAll = f.ledger.createProject({ name: '全登录项目', loginMode: 'all' }, USER);
  f.ledger.setProjectDispatchOrder(pAll, { execute: [CODEX_B.id, CLAUDE_A.id] }, USER);
  f.ledger.deleteAccount(CODEX_B.id, USER, { confirmed: true });
  assert.equal(f.ledger.projectDispatchOrder(f.projectId), null);
  assert.deepEqual(f.ledger.projectDispatchOrder(pAll), { execute: [CLAUDE_A.id] });

  // Clearing back to null works cleanly.
  f.ledger.setProjectDispatchOrder(pAll, null, USER);
  assert.equal(f.ledger.projectDispatchOrder(pAll), null);
});

test('strict owner priority defaults and router-prompt task-title guidance', () => {
  assert.equal(SETTINGS['dispatch.frontLead'].default, 100);
  assert.equal(SETTINGS['quota.warnPercent'].default, 100);
  assert.equal(SETTINGS['router.contextTokens'].default, 0);
  const prompt = readFileSync(new URL('../service/router-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /标题/);
  assert.match(prompt, /26/);
});

test('plain-prose completion settles gracefully without receipt for ordinary tasks, but not reviews or knowledge gates', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  const reply = '# 分析结论\n\n已经排查完毕，核心原因是缓存键未包含租户 ID。\n\n详细步骤如下……';
  const spec = (JSON.parse(run.snapshot_json) as { output_capture: { source: string } }).output_capture;
  const captureResult = {
    source: spec.source,
    ref: { version: 1 as const, source: spec.source, state: 'ready' as const, size: 128, sha256: 'a'.repeat(64) },
    complete: true,
  };
  const res = f.ledger.settleRun(run.id, 0, null, { finalReply: reply, captureResult });
  assert.equal(res.late, false);
  if (!res.late) assert.equal(res.task_state, 'ready');
  const ended = f.run(run.id);
  assert.equal(ended.exit_kind, 'completed');
  const receipt = JSON.parse(ended.receipt_json!) as { status: string; summary: string };
  assert.equal(receipt.status, 'done');
  assert.equal(receipt.summary, '分析结论');
  assert.equal(f.ledger.runReport(run.id)?.text, reply);
  assert.equal(JSON.parse(ended.capture_result_json!).disposition, 'adopted');

  // Blank finalReply still fails as unparseable receipt.
  const blank = f.runningRun();
  const blankRes = f.ledger.settleRun(blank.run.id, 0, null, { finalReply: '   \n  ' });
  assert.equal(blankRes.late, false);
  if (!blankRes.late) assert.equal(blankRes.task_state, 'held');
  assert.equal(f.run(blank.run.id).exit_kind, 'failed');

  // Review task must NOT plain-prose settle without verdict receipt.
  const reg = f.ledger.registerArtifacts(run.id, []);
  const revTask = f.ledger.createTask(
    { projectId: f.projectId, title: '审阅', goal: '审阅', roleId: 'review', reviewOf: { taskId: task.id, runId: run.id, revision: task.revision, registration: reg } },
    USER,
  );
  f.ledger.queueTask(revTask.id, USER);
  const revRun = f.ledger.createRun(revTask.id, { ...f.login, expectedRevision: revTask.revision, snapshot: { timeout_ms: 60_000, brief: 'b' } }, USER);
  f.ledger.markRunRunning(revRun.id);
  const revRes = f.ledger.settleRun(revRun.id, 0, null, { finalReply: '看起来没问题' });
  assert.equal(revRes.late, false);
  if (!revRes.late) assert.equal(revRes.task_state, 'held');
  assert.equal(f.run(revRun.id).exit_kind, 'failed');
});

test('interrupt with queued follow-up auto-continues, continueTask wakes waiting_timer, and deleteInput reverts auto_continue', (t) => {
  const f = fixture(t);
  // 1. "立刻中断插话": running task gets queued input + interrupted settlement -> queued + task.auto_continue.
  const { task, run } = f.runningRun();
  const follow = f.ledger.continueTask(task.id, '改成先跑单元测试', undefined, USER);
  assert.equal(follow.active, true);
  f.ledger.markRunStopping(run.id, USER);
  const settled = f.ledger.settleRun(run.id, 1, null, { kind: 'interrupted', reason: '已中断' });
  assert.equal(settled.late, false);
  if (!settled.late) assert.equal(settled.task_state, 'queued');
  assert.equal(f.task(task.id).state, 'queued');
  const autoChange = f.ledger.listChanges({ taskId: task.id }).findLast((c) => c.action === 'task.auto_continue');
  assert.ok(autoChange, '应记录 task.auto_continue');

  // 2. deleteInput reverts queued task back to ready when 0 queued inputs remain and latest transition was task.auto_continue.
  f.ledger.deleteInput(task.id, follow.id, USER);
  assert.equal(f.task(task.id).state, 'ready');

  // 3. continueTask wakes waiting_timer immediately via sendBack.
  const timerTask = f.queuedTask();
  f.ledger.scheduleWake(timerTask.id, '2099-01-01T00:00:00Z', USER);
  assert.equal(f.task(timerTask.id).state, 'waiting_timer');
  const woke = f.ledger.continueTask(timerTask.id, '不等定时了，立刻执行', undefined, USER);
  assert.equal(woke.active, false);
  assert.equal(f.task(timerTask.id).state, 'queued');
  assert.equal(f.task(timerTask.id).wake_at, null);
});

test('resume failure and transient startup network EOF auto-requeue, clear/rest appropriately, and preserve unconfirmed_inputs', async (t) => {
  const f = fixture(t);
  f.ledger.putAccount(CLAUDE_A, USER, 'ref-a');
  f.ledger.putAccount(CODEX_B, USER, 'ref-b');
  f.ledger.setProjectLogins(f.projectId, [CLAUDE_A.id, CODEX_B.id], USER, 'selected');
  holdMachine(f.ledger, testMachine('h1'), USER);
  const launched: RunRow[] = [];
  const preferOrderCalls: boolean[] = [];

  const dispatcher = createDispatcher({
    ...DISPATCH_TUNED,
    runTimeoutMs: () => 60_000,
    ledger: f.ledger,
    logins: memoryLogins({ [CLAUDE_A.id]: CLAUDE_A, [CODEX_B.id]: CODEX_B }, f.ledger),
    machines: { get: (id) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() },
    executors: { claude: claudeAdapter, codex: codexAdapter },
    outputReady: () => true,
    runner: {
      findMachine: async (_login, available, _forCont, _tried, _timeout, preferOrder) => {
        if (preferOrder) preferOrderCalls.push(true);
        return available[0];
      },
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => { launched.push(run); },
      watch: async () => {},
    },
  });
  t.after(() => dispatcher.stop());

  // Part A: Resume failure clears session_ref, re-queues attached input, auto-requeues once, and next round starts fresh.
  const task = f.ledger.createTask({ projectId: f.projectId, title: '续接兜底', goal: '目标', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  await dispatcher.tick();
  const r1 = launched.at(-1)!;
  assert.equal(r1.login_id, CLAUDE_A.id);
  f.ledger.markRunRunning(r1.id);
  f.ledger.settleRun(r1.id, 0, DONE, { sessionRef: 'sess-bad' });

  f.ledger.continueTask(task.id, '补充指令一', undefined, USER);
  await dispatcher.tick();
  const r2 = launched.at(-1)!;
  assert.equal((JSON.parse(r2.snapshot_json) as Snapshot).session_ref, 'sess-bad');
  assert.ok(preferOrderCalls.length > 0, '续接亲和调用 findMachine 时传 preferOrder=true');
  f.ledger.markRunRunning(r2.id);
  f.ledger.settleRun(r2.id, 1, null, { reason: 'session not found' });

  assert.equal(f.run(r2.id).session_ref, null, '失败续接轮清空 session_ref');
  assert.equal(f.task(task.id).state, 'queued', '续接失败自动重新排队');
  assert.equal(f.ledger.listInputs(task.id).find((i) => i.text === '补充指令一')?.state, 'queued', '附带插话放回队列');

  await dispatcher.tick();
  const r3 = launched.at(-1)!;
  const snap3 = JSON.parse(r3.snapshot_json) as Snapshot;
  assert.equal(snap3.session_ref, undefined, '跳过失败的 sess-bad 改用全新会话');
  const histR2 = (snap3.history as { run_id: string; unconfirmed_inputs?: unknown[] }[]).find((h) => h.run_id === r2.id);
  assert.ok(Array.isArray(histR2?.unconfirmed_inputs), 'failed 且无回执的轮次保留 unconfirmed_inputs');

  // Part B: Transient startup network EOF auto-retries up to 2 times and switches to backup login.
  const netTask = f.ledger.createTask({ projectId: f.projectId, title: '网络抖动', goal: '目标', roleId: 'implement' }, USER);
  f.ledger.queueTask(netTask.id, USER);
  await dispatcher.tick();
  const nr1 = launched.at(-1)!;
  assert.equal(nr1.login_id, CLAUDE_A.id);
  f.ledger.markRunRunning(nr1.id);
  f.ledger.settleRun(nr1.id, 1, null, { reason: 'loadCodeAssist failed: EOF', toolCalls: 0 });
  assert.equal(f.task(netTask.id).state, 'queued', '启动网络 EOF 自动重排');
  // Dispatcher now switches to CODEX_B because CLAUDE_A rests briefly.
  await dispatcher.tick();
  const nr2 = launched.at(-1)!;
  assert.equal(nr2.login_id, CODEX_B.id, '启动网络错误短暂歇息原账号并切换下一个账号');
  f.ledger.markRunRunning(nr2.id);
  f.ledger.settleRun(nr2.id, 1, null, { reason: 'ECONNRESET during startup', toolCalls: 0 });
  assert.equal(f.task(netTask.id).state, 'queued', '第 2 次启动网络 EOF 仍自动重排');
  // End brief rests so 3rd attempt runs and hits the < 2 retry cap.
  f.ledger.endRest(CLAUDE_A.id, USER);
  f.ledger.endRest(CODEX_B.id, USER);
  await dispatcher.tick();
  const nr3 = launched.at(-1)!;
  f.ledger.markRunRunning(nr3.id);
  f.ledger.settleRun(nr3.id, 1, null, { reason: 'EOF again', toolCalls: 0 });
  assert.equal(f.task(netTask.id).state, 'held', '超过 2 次启动网络重试后停住');
});

test('continuation gives first-try affinity to previous round login and machine when usable', async (t) => {
  const f = fixture(t);
  f.ledger.putAccount(CLAUDE_A, USER, 'ref-a');
  f.ledger.putAccount(CODEX_B, USER, 'ref-b');
  f.ledger.setProjectLogins(f.projectId, [CLAUDE_A.id, CODEX_B.id], USER, 'selected');
  tune(f.ledger, 'dispatch.order.execute', [CLAUDE_A.id, CODEX_B.id]);
  holdMachine(f.ledger, testMachine('h1'), USER);
  holdMachine(f.ledger, testMachine('h2'), USER);
  const launched: RunRow[] = [];

  const dispatcher = createDispatcher({
    ...DISPATCH_TUNED,
    runTimeoutMs: () => 60_000,
    ledger: f.ledger,
    logins: memoryLogins({ [CLAUDE_A.id]: CLAUDE_A, [CODEX_B.id]: CODEX_B }, f.ledger),
    machines: { get: (id) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() },
    executors: { claude: claudeAdapter, codex: codexAdapter },
    outputReady: () => true,
    runner: {
      findMachine: async (_login, available) => available[0],
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => { launched.push(run); },
      watch: async () => {},
    },
  });
  t.after(() => dispatcher.stop());

  // Rest CLAUDE_A so Round 1 runs on CODEX_B.
  f.ledger.restRouterLogin(CLAUDE_A.id, { message: 'quota' });
  const task = f.ledger.createTask({ projectId: f.projectId, title: '续接亲和', goal: '目标', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  await dispatcher.tick();
  const r1 = launched.at(-1)!;
  assert.equal(r1.login_id, CODEX_B.id);
  f.ledger.markRunRunning(r1.id);
  f.ledger.settleRun(r1.id, 0, DONE, { sessionRef: 'codex-thread-99' });

  // CLAUDE_A recovers (#1 in global order), yet continuing the task prefers CODEX_B to preserve session!
  f.ledger.endRest(CLAUDE_A.id, USER);
  f.ledger.continueTask(task.id, '接着刚刚的改', undefined, USER);
  await dispatcher.tick();
  const r2 = launched.at(-1)!;
  assert.equal(r2.login_id, CODEX_B.id, '续接优先亲和上一轮账号以复用会话');
  assert.equal((JSON.parse(r2.snapshot_json) as Snapshot).session_ref, 'codex-thread-99');
});

test('destroyed_machines is applied ONLY on adopted receipts, never on interrupted or stale runs', (t) => {
  const f = fixture(t);
  f.ledger.setProjectSpawnMachines(f.projectId, true, USER);
  const { task, run } = f.runningRun();
  f.ledger.createInvite({ taskId: task.id, executors: null, ttlMs: 3600_000, maxMachines: 2 }, USER);
  const [material] = f.ledger.handInvite(task.id, run.id, 3600_000)!;
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const m1 = f.ledger.redeemInvite({
    materialHash: hash(material!),
    claimHash: hash('claim-1'),
    facts: { node_id: 'node-eph-1', name: 'eph-1', platform: 'linux', hostname: 'h-eph-1' },
    machineId: 'eph-1',
    tokenHash: hash('tok-1'),
  }, USER);
  assert.equal(m1.destroyedAt, undefined);

  // Interrupted run carrying destroyed_machines must NOT mark machine destroyed.
  f.ledger.markRunStopping(run.id, USER);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: 'stopped', destroyed_machines: ['eph-1'] });
  assert.equal(f.ledger.getMachine('eph-1')?.destroyedAt, undefined, '被中断的轮次不能应用 destroyed_machines');

  // Stale-revision run carrying destroyed_machines must NOT mark machine destroyed.
  f.ledger.resumeTask(task.id, USER);
  const run2 = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.task(task.id).revision, snapshot: { timeout_ms: 60_000, brief: 'b' } }, USER);
  f.ledger.markRunRunning(run2.id);
  f.force('UPDATE task SET revision = revision + 1 WHERE id = ?', task.id);
  f.ledger.settleRun(run2.id, 0, { status: 'done', summary: 'stale', destroyed_machines: ['eph-1'] });
  assert.equal(f.ledger.getMachine('eph-1')?.destroyedAt, undefined, '修订过期的轮次不能应用 destroyed_machines');

  // Adopted receipt DOES mark ephemeral machine destroyed.
  f.ledger.resumeTask(task.id, USER);
  const run3 = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.task(task.id).revision, snapshot: { timeout_ms: 60_000, brief: 'b' } }, USER);
  f.ledger.markRunRunning(run3.id);
  f.ledger.settleRun(run3.id, 0, { status: 'done', summary: 'cleaned', destroyed_machines: ['eph-1'] });
  assert.notEqual(f.ledger.getMachine('eph-1')?.destroyedAt, undefined, '被采用的回执正常应用 destroyed_machines');
});

test('unified roundCode prevents false stale repo reviews and accept.register refuses fabricated [] on fetch failure', async (t) => {
  const f = fixture(t);
  f.ledger.setProjectSources(f.projectId, [{ kind: 'repo', url: 'https://github.com/org/repo.git', branch: 'feat/x' }], USER);
  const [repo] = f.ledger.projectSources(f.projectId);
  assert.ok(repo && repo.kind === 'repo');
  const task = f.ledger.createTask({ projectId: f.projectId, title: '改仓库', goal: '实现功能', roleId: 'implement', sourceId: repo.id }, USER);
  f.ledger.queueTask(task.id, USER);
  const snapSource = snapshotSourceOf(repo);
  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: task.revision, snapshot: { timeout_ms: 60_000, brief: 'b', source: snapSource } }, USER);
  f.ledger.markRunRunning(run.id);
  // Receipt omits commit & branch; machine reports remote_head & branch via sourceHead.
  const remoteHead = '1234567890abcdef1234567890abcdef12345678';
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '已推送' }, {
    sourceHead: { kind: 'repo', branch: 'feat/x', start: null, head: remoteHead, remote_head: remoteHead },
  });

  // roundCode extracts remote_head & branch uniformly.
  const extracted = roundCode(f.run(run.id), snapSource);
  assert.deepEqual(extracted, { source_kind: 'repo', commit: remoteHead, branch: 'feat/x', url: repo.url });

  // accept.register fails cleanly when artifact fetch fails and no prior registration exists (never fabricates []).
  const failingAcceptor = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      fetchArtifacts: async () => ({ files: [], problem: '机器离线，无法取回产物' }),
    },
  });
  await assert.rejects(() => failingAcceptor.register(task.id), /机器离线/);
  assert.equal(f.ledger.artifactsOfRun(run.id)?.registration, null, '不能伪造空 [] 登记');

  // Once fetch succeeds, review binding matches productOf() with zero false staleness.
  const okAcceptor = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      fetchArtifacts: async () => ({ files: [], problem: null }),
    },
  });
  const registered = await okAcceptor.register(task.id);
  assert.deepEqual(registered.reviewed, extracted);
  const revTask = f.ledger.createTask(
    { projectId: f.projectId, title: '审阅', goal: '审阅', roleId: 'review', reviewOf: { taskId: task.id, ...registered } },
    USER,
  );
  const binding = JSON.parse(revTask.review_of_json!);
  assert.equal(productStale(binding, f.ledger.currentProduct(task.id)), null, '产物与审阅绑定完全一致，不误判过期');
});

test('land.ts scans ended runs newest-first for PR, falls back to sourceHead commit, and forwards parent sourceId', (t) => {
  const f = fixture(t);
  f.ledger.setProjectSources(
    f.projectId,
    [
      { kind: 'repo', url: 'https://github.com/org/primary.git' },
      { kind: 'repo', url: 'https://github.com/org/secondary.git' },
    ],
    USER,
  );
  const [, repo2] = f.ledger.projectSources(f.projectId);
  assert.ok(repo2 && repo2.kind === 'repo');

  // Task is pinned to secondary repo.
  const task = f.ledger.createTask({ projectId: f.projectId, title: '修次仓库', goal: '修复', roleId: 'verify', sourceId: repo2.id }, USER);
  f.ledger.queueTask(task.id, USER);

  // Round 1 opens PR.
  const r1 = f.ledger.createRun(task.id, { ...f.login, expectedRevision: task.revision, snapshot: { timeout_ms: 60_000, brief: 'b', source: snapshotSourceOf(repo2) } }, USER);
  f.ledger.markRunRunning(r1.id);
  const prUrl = 'https://github.com/org/secondary/pull/42';
  f.ledger.settleRun(r1.id, 0, {
    status: 'done',
    summary: '开了 PR',
    artifacts: [{ kind: 'pr', ref: prUrl }, { kind: 'commit', ref: '1111111111111111111111111111111111111111' }],
  });

  // Round 2 fixes a review comment and pushes a new commit WITHOUT repeating the PR URL or commit artifact (only sourceHead).
  f.ledger.reworkTask(task.id, '修一下边界情况', task.revision, USER);
  const r2 = f.ledger.createRun(task.id, { ...f.login, expectedRevision: task.revision, snapshot: { timeout_ms: 60_000, brief: 'b', source: snapshotSourceOf(repo2) } }, USER);
  f.ledger.markRunRunning(r2.id);
  const newCommit = '2222222222222222222222222222222222222222';
  f.ledger.settleRun(r2.id, 0, { status: 'done', summary: '已推修复提交' }, {
    sourceHead: { kind: 'repo', branch: 'fix/edge', start: null, head: newCommit, remote_head: newCommit },
  });

  f.ledger.acceptTask(task.id, '验收通过', USER);
  const info = landableOf(f.ledger, task.id);
  assert.equal(info.landable, true);
  assert.equal(info.pr, prUrl, '从较早的已结束轮次找回 PR');
  assert.equal(info.commit, newCommit, '从 sourceHead.remote_head 兜底取提交号');

  const landed = createLandingTask(f.ledger, task.id, USER);
  assert.equal(landed.made, true);
  assert.equal(landed.pr, prUrl);
  assert.equal(landed.commit, newCommit);
  assert.equal(f.ledger.taskSource(landed.child.id)?.source_id, repo2.id, '合入子任务继承父任务钉住的 sourceId');
});
