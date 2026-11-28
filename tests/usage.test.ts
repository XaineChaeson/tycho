// Guards against: a round's use lost at its settlement or counted twice when it settles again;
// a model the executor did not name passed off as its word instead of the tier's; a Router turn
// or a quota read left out of a project's or a login's total; a round with no figure dropped
// from the count instead of said; a day cut at UTC midnight instead of the reader's; summing
// the rounds of several models as if each were another round; and the report naming a login,
// role or project by a name it never had; a round settled before it was seen running, or a late
// result after a lost round, whose use is spent but not shown; and a deleted project losing a
// round it counted or the time that round took, or inventing a figure for a round that reported
// none.
import './guard.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DONE, fixture, USER } from './helpers.ts';

const DAY = { from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z', tzOffsetMinutes: 0 };
const figures = (model: string | undefined, input: number, cost?: number) => ({
  ...(model === undefined ? {} : { model }), inputTokens: input, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, ...(cost === undefined ? {} : { listCostUsd: cost }),
});

test('a round records what it used once, with the model the executor named or else the one its tier asked for', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE, { usage: [figures('big', 10, 0.5), figures(undefined, 1)] });
  f.ledger.settleRun(run.id, 0, DONE, { usage: [figures('big', 999)] });
  const rows = f.peek<{ model: string; model_basis: string; input_tokens: number; list_cost_usd: number | null }>('SELECT model, model_basis, input_tokens, list_cost_usd FROM usage ORDER BY input_tokens DESC');
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { model: 'big', model_basis: 'reported', input_tokens: 10, list_cost_usd: 0.5 },
    { model: '/tiers/execute.json', model_basis: 'tier', input_tokens: 1, list_cost_usd: null },
  ]);
  const report = f.ledger.usageReport(DAY);
  assert.equal(report.units.length, 1);
  assert.equal(report.units[0]!.units, 1, '两个模型仍是一轮');
  assert.equal(report.units[0]!.without_usage, 0);
  assert.equal(report.units[0]!.project_id, f.projectId);
  assert.equal(report.units[0]!.role_id, 'implement');
  assert.equal(report.units[0]!.tier, 'execute');
  assert.equal(report.units[0]!.executor, 'claude');
  assert.equal(report.usage.length, 2);
  assert.deepEqual({ ...report.usage.find((cell) => cell.model === 'big') }, {
    ...report.usage.find((cell) => cell.model === 'big'), units: 1, input: 10, output: 2, cache_read: 3, cache_write: 4, list_cost_usd: 0.5, unpriced: 0,
  });
  assert.equal(report.usage.find((cell) => cell.model_basis === 'tier')!.unpriced, 1);
  assert.equal(report.top_tasks.length, 1);
  assert.equal(report.top_tasks[0]!.input, 11);
  assert.equal(report.top_tasks[0]!.rounds, 1);
  assert.equal(report.names.projects[f.projectId], '试跑');
  assert.equal(report.names.logins[run.login_id!], 'h1/claude');
  assert.ok(report.names.roles.implement);
});

test('a round that reported nothing is counted, and said to have no figure', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null, {});
  const report = f.ledger.usageReport(DAY);
  assert.equal(report.units[0]!.units, 1);
  assert.equal(report.units[0]!.without_usage, 1);
  assert.deepEqual(report.usage, []);
  assert.equal(report.top_tasks[0]!.rounds, 1);
  assert.equal(report.top_tasks[0]!.input, 0);
});

test("Router turns count for the context's project and login, quota reads for the login; each result line is a turn", (t) => {
  const f = fixture(t);
  const context = f.ledger.openContext({ projectId: f.projectId, segmentId: f.ledger.ensureSegment(f.projectId).id, marker: 'm', launch: {}, knowledge: [] });
  f.ledger.recordUsage({ context_id: context.id }, [figures('big', 5), figures('small', 1)]);
  f.ledger.recordUsage({ login_id: 'acct' }, [figures('big', 1, 0.01)]);
  f.ledger.recordUsage({ context_id: context.id }, []);
  const report = f.ledger.usageReport(DAY);
  const router = report.units.find((cell) => cell.source === 'router')!;
  assert.equal(router.units, 1);
  assert.equal(router.project_id, f.projectId);
  assert.equal(router.role_id, null);
  const quota = report.units.find((cell) => cell.source === 'quota')!;
  assert.deepEqual([quota.units, quota.login_id, quota.project_id], [1, 'acct', null]);
  assert.equal(report.usage.filter((cell) => cell.source === 'router').reduce((sum, cell) => sum + cell.input, 0), 6);
  assert.equal(f.count('usage'), 3);
});

test("the range and the days are the reader's", (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE, { usage: [figures('big', 1)] });
  // Put the round's end at 23:30 UTC: the next day eight hours east.
  f.force(`UPDATE run SET ended_at = '2026-11-10T23:30:00.000Z' WHERE id = ?`, run.id);
  f.force(`UPDATE usage SET at = '2026-11-10T23:30:00.000Z'`);
  const day = (offset: number) => f.ledger.usageReport({ from: '2026-11-10T00:00:00.000Z', to: '2026-11-12T00:00:00.000Z', tzOffsetMinutes: offset }).units[0]!.day;
  assert.equal(day(0), '2026-11-10');
  assert.equal(day(480), '2026-11-11');
  assert.equal(day(-300), '2026-11-10');
  assert.deepEqual(f.ledger.usageReport({ from: '2026-11-11T00:00:00.000Z', to: '2026-11-12T00:00:00.000Z', tzOffsetMinutes: 0 }).units, []);
});

test('a round settled before it was seen running still counts its use', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, { actor: 'test' });
  f.ledger.settleRun(run.id, 0, DONE, { usage: [figures('big', 7)] });
  const report = f.ledger.usageReport(DAY);
  assert.equal(report.units[0]!.units, 1);
  assert.equal(report.units[0]!.without_usage, 0);
  assert.equal(report.usage[0]!.input, 7);
});

test('a result that comes after the round was settled without use is the only report of it, and is kept once', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  f.ledger.settleRun(run.id, 0, DONE, { usage: [figures('big', 9)] });
  f.ledger.settleRun(run.id, 0, DONE, { usage: [figures('big', 9)] });
  const rows = f.peek<{ input_tokens: number; at: string }>('SELECT input_tokens, at FROM usage');
  assert.deepEqual(rows.map((row) => row.input_tokens), [9]);
  assert.equal(rows[0]!.at, f.run(run.id).ended_at);
});

test("a round's use survives its project's deletion as a unit of its own, not as a read of the login", (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE, { usage: [figures('big', 7, 0.25)] });
  f.ledger.setProjectArchived(f.projectId, true, USER);
  f.ledger.deleteProject(f.projectId, '试跑', USER);
  const report = f.ledger.usageReport(DAY);
  // The row is still one unit of use, and says what it was: what the project's deletion took is
  // the link, not the figure or the count.
  assert.deepEqual(report.units.map(({ source, project_dropped, project_id, units, without_usage }) => ({ source, project_dropped, project_id, units, without_usage })), [
    { source: 'run', project_dropped: true, project_id: null, units: 1, without_usage: 0 },
  ]);
  assert.deepEqual(report.usage.map(({ model, input, units, list_cost_usd, project_dropped }) => ({ model, input, units, list_cost_usd, project_dropped })), [
    { model: 'big', input: 7, units: 1, list_cost_usd: 0.25, project_dropped: true },
  ]);
  assert.deepEqual(report.units.filter(({ source }) => source === 'quota'), [], '不是一次额度查询');
  assert.equal(f.peek('SELECT 1 FROM usage WHERE run_id IS NOT NULL').length, 0);
});

test('a deleted project keeps the rounds it counted and the time they took, including one that reported nothing', (t) => {
  const f = fixture(t);
  // Two rounds that started. One reported use; the other never did, and its count and its
  // duration would otherwise go with the round: a deletion must not turn two rounds into one,
  // nor a round that took a minute into one that took none.
  const used = f.runningRun();
  const silent = f.runningRun();
  f.ledger.settleRun(used.run.id, 0, DONE, { usage: [figures('big', 7)] });
  f.ledger.settleRun(silent.run.id, 0, DONE, {});
  // Known ends, so the time compared is a number and not a stopwatch reading.
  f.force(`UPDATE run SET started_at = '2026-11-10T01:00:00.000Z', ended_at = '2026-11-10T01:00:30.000Z' WHERE id = ?`, used.run.id);
  f.force(`UPDATE run SET started_at = '2026-11-10T02:00:00.000Z', ended_at = '2026-11-10T02:01:00.000Z' WHERE id = ?`, silent.run.id);
  f.force(`UPDATE usage SET at = '2026-11-10T01:00:30.000Z'`);
  const before = f.ledger.usageReport(DAY);
  assert.deepEqual(before.units.map(({ units, without_usage, duration_ms }) => ({ units, without_usage, duration_ms })), [
    { units: 2, without_usage: 1, duration_ms: 90_000 },
  ]);
  assert.deepEqual(before.usage.map(({ model, input, unpriced }) => ({ model, input, unpriced })), [{ model: 'big', input: 7, unpriced: 1 }]);

  f.ledger.setProjectArchived(f.projectId, true, USER);
  f.ledger.deleteProject(f.projectId, '试跑', USER);

  const after = f.ledger.usageReport(DAY);
  assert.deepEqual(after.units.map(({ source, project_dropped, units, without_usage, duration_ms }) => ({ source, project_dropped, units, without_usage, duration_ms })), [
    { source: 'run', project_dropped: true, units: 2, without_usage: 1, duration_ms: 90_000 },
  ]);
  // What the page draws per model is unchanged: the round that reported nothing is still counted
  // as a round, is not passed off as a use of some model, and does not turn up as an unpriced
  // use of one either.
  assert.deepEqual(after.usage.map(({ model, input, units, unpriced, project_dropped }) => ({ model, input, units, unpriced, project_dropped })), [
    { model: 'big', input: 7, units: 1, unpriced: 1, project_dropped: true },
  ]);
  // The round that said nothing left a row with no figure and no model — absent, not zero, and
  // its duration kept. Nothing is invented about what it used.
  const row = f.peek<{ input_tokens: number | null; output_tokens: number | null; model: string | null; dropped_source: string; dropped_unit: string; duration_ms: number | null; login_id: string | null }>(
    'SELECT input_tokens, output_tokens, model, dropped_source, dropped_unit, duration_ms, login_id FROM usage WHERE dropped_unit = ?', `run:${silent.run.id}`,
  )[0]!;
  assert.deepEqual({ ...row }, {
    input_tokens: null, output_tokens: null, model: null, dropped_source: 'run', dropped_unit: `run:${silent.run.id}`, duration_ms: 60_000, login_id: silent.run.login_id,
  });
  assert.equal(f.peek('SELECT 1 FROM usage WHERE run_id IS NOT NULL').length, 0);
});

test('resumed Codex rounds record per-round deltas from session-cumulative totals and fail open on non-cumulative reports', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const codexLogin = { ...f.login, executor: 'codex' };
  const makeSnap = (sessionRef?: string) => JSON.stringify({
    brief: 'b',
    executor: 'codex',
    tier: 'decide',
    tier_value: { kind: 'content', text: 'model=gpt-6.2-astra\n' },
    timeout_ms: 60_000,
    ...(sessionRef ? { session_ref: sessionRef } : {}),
  });

  // Round 1: cold start
  const r1 = f.ledger.createRun(task.id, codexLogin, { actor: 'test' });
  f.force('UPDATE run SET snapshot_json = ? WHERE id = ?', makeSnap(), r1.id);
  f.ledger.settleRun(r1.id, 0, DONE, {
    sessionRef: 'codex-thread-1',
    usage: [{ inputTokens: 350_000, outputTokens: 38_000, cacheReadTokens: 19_000_000, cacheWriteTokens: 0 }],
  });

  // Round 2: resumed, Codex CLI reports cumulative totals (R1 + small delta)
  f.ledger.continueTask(task.id, 'round 2', undefined, USER);
  const r2 = f.ledger.createRun(task.id, codexLogin, { actor: 'test' });
  f.force('UPDATE run SET snapshot_json = ? WHERE id = ?', makeSnap('codex-thread-1'), r2.id);
  f.ledger.settleRun(r2.id, 0, DONE, {
    sessionRef: 'codex-thread-1',
    usage: [{ inputTokens: 410_000, outputTokens: 39_100, cacheReadTokens: 19_300_000, cacheWriteTokens: 0 }],
  });

  // Round 3: resumed again, Codex CLI reports cumulative totals (R1 + R2 + R3)
  f.ledger.continueTask(task.id, 'round 3', undefined, USER);
  const r3 = f.ledger.createRun(task.id, codexLogin, { actor: 'test' });
  f.force('UPDATE run SET snapshot_json = ? WHERE id = ?', makeSnap('codex-thread-1'), r3.id);
  f.ledger.settleRun(r3.id, 0, DONE, {
    sessionRef: 'codex-thread-1',
    usage: [{ inputTokens: 450_000, outputTokens: 48_100, cacheReadTokens: 23_300_000, cacheWriteTokens: 0 }],
  });

  // Round 4: future CLI reports true per-round delta (smaller than prior cumulative sum) -> kept as-is, never clamped to 0
  f.ledger.continueTask(task.id, 'round 4', undefined, USER);
  const r4 = f.ledger.createRun(task.id, codexLogin, { actor: 'test' });
  f.force('UPDATE run SET snapshot_json = ? WHERE id = ?', makeSnap('codex-thread-1'), r4.id);
  f.ledger.settleRun(r4.id, 0, DONE, {
    sessionRef: 'codex-thread-1',
    usage: [{ inputTokens: 12_000, outputTokens: 2_500, cacheReadTokens: 500_000, cacheWriteTokens: 0 }],
  });

  const rows = f.peek<{ run_id: string; input_tokens: number; output_tokens: number; cache_read_tokens: number }>(
    'SELECT run_id, input_tokens, output_tokens, cache_read_tokens FROM usage ORDER BY rowid ASC',
  );
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { run_id: r1.id, input_tokens: 350_000, output_tokens: 38_000, cache_read_tokens: 19_000_000 },
    { run_id: r2.id, input_tokens: 60_000, output_tokens: 1_100, cache_read_tokens: 300_000 },
    { run_id: r3.id, input_tokens: 40_000, output_tokens: 9_000, cache_read_tokens: 4_000_000 },
    { run_id: r4.id, input_tokens: 12_000, output_tokens: 2_500, cache_read_tokens: 500_000 },
  ]);

  // Router usage attributes executor from launch_json instead of hardcoding claude.
  const ctx = f.ledger.openContext({
    projectId: f.projectId,
    segmentId: f.ledger.ensureSegment(f.projectId).id,
    marker: 'm-gemini',
    launch: { executor: 'gemini' },
    knowledge: [],
  });
  f.ledger.recordUsage({ context_id: ctx.id }, [figures('gemini-4-neon', 50)]);
  const report = f.ledger.usageReport(DAY);
  const routerUnit = report.units.find((cell) => cell.source === 'router');
  assert.equal(routerUnit?.executor, 'gemini');
  const routerUsage = report.usage.find((cell) => cell.source === 'router');
  assert.equal(routerUsage?.executor, 'gemini');
});
