// What the executors used, as they reported it (docs/design/usage.md): written once, where the
// use is known — a round's settlement, a Router turn's result, a quota read — and only summed
// here when the page asks. Nothing in this file estimates: a figure the executor did not give
// stays absent, and the report says how many rounds came without one.
import type { Usage } from '../adapters/types.ts';
import type { Db } from './db.ts';
import { ulid } from './ids.ts';
import type { LoginTelemetry, TaskUsage, UnitCell, UsageCell, UsageNames, UsageReport } from '../shared/usage.ts';

export type { LoginTelemetry, UsageReport };

// Whose use it was: a Worker round, a Router context's turn, or a login read directly.
export type UsageOwner = { run_id: string } | { context_id: string } | { login_id: string };

// `codex exec resume` reports session-cumulative totals on `turn.completed.usage` rather than
// per-round deltas. Subtract the sum of previously recorded rounds on the same `(task_id,
// session_ref, model)` when every reported counter is at or above that cumulative baseline.
// If a newer CLI starts reporting true per-round deltas smaller than the prior sum, the check
// fails open and keeps the reported figure intact without clamping to zero.
export function normalizeRunUsage(
  db: Db,
  run: { id: string; task_id: string; created_at: string; snapshot_json: string },
  usage: readonly Usage[],
  tierModel?: string,
): Usage[] {
  if (usage.length === 0) return [];
  let executor: string | undefined;
  let resumedSessionRef: string | undefined;
  try {
    const snap = JSON.parse(run.snapshot_json) as {
      executor?: unknown;
      login?: { executor?: unknown };
      session_ref?: unknown;
    };
    const rawExec = typeof snap.executor === 'string' ? snap.executor : typeof snap.login?.executor === 'string' ? snap.login.executor : undefined;
    executor = rawExec?.trim() || undefined;
    if (typeof snap.session_ref === 'string' && snap.session_ref.trim() !== '') {
      resumedSessionRef = snap.session_ref.trim();
    }
  } catch {
    return [...usage];
  }
  if (executor !== 'codex' || resumedSessionRef === undefined) return [...usage];

  return usage.map((each) => {
    const targetModel = each.model ?? tierModel ?? null;
    const prior = db.get<{
      cnt: number;
      inp: number;
      outp: number;
      cache_r: number;
      cache_w: number;
      cost: number;
      cost_cnt: number;
    }>(
      `SELECT COUNT(*) AS cnt,
              COALESCE(SUM(u.input_tokens), 0) AS inp,
              COALESCE(SUM(u.output_tokens), 0) AS outp,
              COALESCE(SUM(u.cache_read_tokens), 0) AS cache_r,
              COALESCE(SUM(u.cache_write_tokens), 0) AS cache_w,
              COALESCE(SUM(u.list_cost_usd), 0) AS cost,
              COUNT(u.list_cost_usd) AS cost_cnt
         FROM usage u
         JOIN run r ON r.id = u.run_id
        WHERE r.task_id = ?
          AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))
          AND (r.session_ref = ? OR json_extract(r.snapshot_json, '$.session_ref') = ?)
          AND COALESCE(u.model, '') = COALESCE(?, '')
          AND u.input_tokens IS NOT NULL`,
      run.task_id,
      run.created_at,
      run.created_at,
      run.id,
      resumedSessionRef,
      resumedSessionRef,
      targetModel,
    );
    if (!prior || prior.cnt === 0) return each;
    const isCumulative =
      each.inputTokens >= prior.inp &&
      each.outputTokens >= prior.outp &&
      each.cacheReadTokens >= prior.cache_r &&
      each.cacheWriteTokens >= prior.cache_w;
    if (!isCumulative) return each;
    const nextCost =
      each.listCostUsd !== undefined && prior.cost_cnt > 0 && each.listCostUsd >= prior.cost
        ? each.listCostUsd - prior.cost
        : each.listCostUsd;
    return {
      ...each,
      inputTokens: each.inputTokens - prior.inp,
      outputTokens: each.outputTokens - prior.outp,
      cacheReadTokens: each.cacheReadTokens - prior.cache_r,
      cacheWriteTokens: each.cacheWriteTokens - prior.cache_w,
      ...(nextCost === undefined ? {} : { listCostUsd: nextCost }),
    };
  });
}

// One row per model. A model the executor did not name is the one the round's tier asked for,
// when there is one; recorded as such, never as the executor's word.
export function insertUsage(db: Db, owner: UsageOwner, at: string, usage: readonly Usage[], tierModel?: string): void {
  if (usage.length > 0) db.noteNews();
  for (const each of usage) {
    const model = each.model ?? tierModel ?? null;
    const basis = each.model !== undefined ? 'reported' : model === null ? null : 'tier';
    db.run(
      `INSERT INTO usage (id, at, run_id, context_id, login_id, model, model_basis, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, list_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ulid(), at,
      'run_id' in owner ? owner.run_id : null,
      'context_id' in owner ? owner.context_id : null,
      'login_id' in owner ? owner.login_id : null,
      model, basis,
      each.inputTokens, each.outputTokens, each.cacheReadTokens, each.cacheWriteTokens,
      each.listCostUsd ?? null,
    );
  }
}

export interface UsageQuery {
  // An ISO instant each; `to` is not included.
  from: string;
  to: string;
  // The reader's offset from UTC, in minutes east, so that a day is the reader's day.
  tzOffsetMinutes: number;
}

// How long a round lasted, as both the live report and a deletion read it from the round's own
// start and end. One expression, with its columns qualified by where it is used, so a round's
// duration cannot come out different on the two paths. A round with no start reads as null,
// which every reader sums as nothing.
const durationMs = (prefix: string): string =>
  `CAST(ROUND((julianday(${prefix}ended_at) - julianday(${prefix}started_at)) * 86400000) AS INTEGER)`;

// What a deleted project's rounds leave behind, run in its deletion's transaction. The link to
// the round goes; the unit it stood for, its duration and whether it ever reported a figure stay
// (docs/design/usage.md §4). A round that reported nothing had no row of use to keep, so one is
// written for it: the unit and the duration, with the four counts null — absent, not zero, since
// the executor said nothing and nothing is invented for it.
export function keepDroppedRuns(db: Db, runIds: readonly string[]): void {
  if (runIds.length === 0) return;
  const marks = runIds.map(() => '?').join(', ');
  // Read before the rows are unlinked: which rounds had a row of use, and how long each lasted.
  const rounds = db.all<{ id: string; login_id: string | null; ended_at: string; duration_ms: number | null; rows: number }>(
    `SELECT run.id, run.login_id, run.ended_at, ${durationMs('run.')} AS duration_ms,
            (SELECT COUNT(*) FROM usage WHERE usage.run_id = run.id) AS rows
       FROM run WHERE run.id IN (${marks}) AND run.state = 'ended' AND run.started_at IS NOT NULL`,
    ...runIds,
  );
  db.run(
    `UPDATE usage SET run_id = NULL, dropped_source = 'run', dropped_unit = 'run:' || run_id,
        login_id = (SELECT login_id FROM run WHERE run.id = usage.run_id),
        duration_ms = (SELECT ${durationMs('')} FROM run WHERE run.id = usage.run_id)
      WHERE run_id IN (${marks})`,
    ...runIds,
  );
  for (const round of rounds) {
    if (round.rows > 0) continue;
    db.run(
      `INSERT INTO usage (id, at, run_id, context_id, login_id, model, model_basis, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, list_cost_usd, duration_ms, dropped_source, dropped_unit)
       VALUES (?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 'run', ?)`,
      ulid(), round.ended_at, round.login_id, round.duration_ms, `run:${round.id}`,
    );
  }
}

const TOP_TASKS = 10;

// What a round is filed under, read from its snapshot: one definition for counting the rounds
// and for summing their use.
const RUN_ROLE = `json_extract(run.snapshot_json, '$.role.id')`;
const RUN_TIER = `json_extract(run.snapshot_json, '$.tier')`;
const RUN_EXECUTOR = `COALESCE(json_extract(run.snapshot_json, '$.executor'), json_extract(run.snapshot_json, '$.login.executor'))`;

// Every round, Router turn and quota read in the range, once each, with what it is filed under:
// a round with no row of use is still there, and counts as one that reported nothing. A round
// counts once it ran or reported use; one that never started and reported nothing is not a
// round of work. A row whose project's deletion took the round or context it pointed at is a
// unit of its own, kept with the source and the login it ran as (`project_dropped`), so its
// figures, its count, its duration and whether it ever reported a figure all stay.
const UNITS = `
  SELECT 'run' AS source, run.id AS unit, run.ended_at AS at, task.project_id AS project_id, task.id AS task_id,
         ${RUN_ROLE} AS role_id, json_extract(run.snapshot_json, '$.role.name') AS role_name, ${RUN_TIER} AS tier,
         run.login_id AS login_id, run.login_name AS login_name, ${RUN_EXECUTOR} AS executor,
         ${durationMs('run.')} AS duration_ms,
         CASE WHEN EXISTS (SELECT 1 FROM usage WHERE usage.run_id = run.id AND usage.input_tokens IS NOT NULL) THEN 0 ELSE 1 END AS without_usage,
         0 AS project_dropped
    FROM run JOIN task ON task.id = run.task_id
   WHERE run.state = 'ended' AND run.ended_at >= ?1 AND run.ended_at < ?2
     AND (run.started_at IS NOT NULL OR EXISTS (SELECT 1 FROM usage WHERE usage.run_id = run.id))
  UNION ALL
  SELECT 'router', usage.context_id || '@' || usage.at, usage.at, router_context.project_id, NULL, NULL, NULL, NULL,
         router_context.login_id, router_context.login_name, COALESCE(json_extract(router_context.launch_json, '$.executor'), 'claude'), 0, 0, 0
    FROM usage JOIN router_context ON router_context.id = usage.context_id
   WHERE usage.at >= ?1 AND usage.at < ?2
   GROUP BY usage.context_id, usage.at
  UNION ALL
  SELECT 'quota', usage.login_id || '@' || usage.at, usage.at, NULL, NULL, NULL, NULL, NULL, usage.login_id, NULL, NULL, 0, 0, 0
    FROM usage WHERE usage.login_id IS NOT NULL AND usage.dropped_unit IS NULL AND usage.at >= ?1 AND usage.at < ?2
   GROUP BY usage.login_id, usage.at
  UNION ALL
  SELECT usage.dropped_source, usage.dropped_unit, usage.at, NULL, NULL, NULL, NULL, NULL, usage.login_id, NULL, NULL,
         MAX(usage.duration_ms), CASE WHEN SUM(usage.input_tokens IS NOT NULL) = 0 THEN 1 ELSE 0 END, 1
    FROM usage WHERE usage.dropped_unit IS NOT NULL AND usage.at >= ?1 AND usage.at < ?2
   GROUP BY usage.dropped_unit`;

// A unit's rows of use: a round's by its id, a turn's and a quota read's by owner and moment, a
// deleted project's by the unit the ledger kept on the row.
const UNIT_OF_USAGE = `CASE
    WHEN usage.dropped_unit IS NOT NULL THEN usage.dropped_unit
    WHEN usage.run_id IS NOT NULL THEN usage.run_id
    WHEN usage.context_id IS NOT NULL THEN usage.context_id || '@' || usage.at
    ELSE usage.login_id || '@' || usage.at END`;

const FIGURES = `
  COALESCE(SUM(usage.input_tokens), 0) AS input, COALESCE(SUM(usage.output_tokens), 0) AS output,
  COALESCE(SUM(usage.cache_read_tokens), 0) AS cache_read, COALESCE(SUM(usage.cache_write_tokens), 0) AS cache_write,
  COALESCE(SUM(usage.list_cost_usd), 0) AS list_cost_usd, COUNT(usage.input_tokens) - COUNT(usage.list_cost_usd) AS unpriced`;

// SQLite hands a boolean expression back as 0 or 1; the report carries a real boolean.
type RawUnitCell = Omit<UnitCell, 'project_dropped'> & { project_dropped: number };
type RawUsageCell = Omit<UsageCell, 'project_dropped'> & { project_dropped: number };
const withBoolean = <T extends { project_dropped: number }>(row: T): Omit<T, 'project_dropped'> & { project_dropped: boolean } =>
  ({ ...row, project_dropped: row.project_dropped !== 0 });

export function usageReport(db: Db, query: UsageQuery): UsageReport {
  // ?1 and ?2 are the range, ?3 the reader's offset as SQLite's date() takes it.
  const params = [query.from, query.to, `${query.tzOffsetMinutes >= 0 ? '+' : ''}${Math.trunc(query.tzOffsetMinutes)} minutes`];
  const DAY = `date(units.at, ?3)`;
  const DIMENSIONS = `${DAY} AS day, units.source, units.project_id, units.project_dropped, units.role_id, units.tier, units.login_id, units.executor`;
  const GROUPING = `day, units.source, units.project_id, units.project_dropped, units.role_id, units.tier, units.login_id, units.executor`;
  const units = db.all<RawUnitCell>(
    `WITH units AS (${UNITS})
     SELECT ${DIMENSIONS}, COUNT(*) AS units, SUM(units.without_usage) AS without_usage,
            COALESCE(SUM(units.duration_ms), 0) AS duration_ms
       FROM units GROUP BY ${GROUPING}`,
    ...params,
  ).map(withBoolean);
  // From the use itself, each row's owner looked up by its key: a round's row is in the range
  // exactly when its round is (it carries the round's end), a turn's and a read's are their own.
  // A row with no figure at all is not here: it exists so that a deleted round keeps its count
  // and its duration, and it belongs to the units list, not to a list of what models were used.
  const usage = db.all<RawUsageCell>(
    `SELECT date(usage.at, ?3) AS day,
            CASE WHEN usage.dropped_source IS NOT NULL THEN usage.dropped_source
                 WHEN usage.run_id IS NOT NULL THEN 'run' WHEN usage.context_id IS NOT NULL THEN 'router' ELSE 'quota' END AS source,
            CASE WHEN usage.dropped_source IS NOT NULL THEN 1 ELSE 0 END AS project_dropped,
            COALESCE(task.project_id, router_context.project_id) AS project_id,
            ${RUN_ROLE} AS role_id, ${RUN_TIER} AS tier,
            COALESCE(run.login_id, router_context.login_id, usage.login_id) AS login_id,
            CASE WHEN usage.run_id IS NOT NULL THEN ${RUN_EXECUTOR} WHEN usage.context_id IS NOT NULL THEN COALESCE(json_extract(router_context.launch_json, '$.executor'), 'claude') END AS executor,
            usage.model, usage.model_basis, COUNT(DISTINCT ${UNIT_OF_USAGE}) AS units, ${FIGURES}
       FROM usage
       LEFT JOIN run ON run.id = usage.run_id
       LEFT JOIN task ON task.id = run.task_id
       LEFT JOIN router_context ON router_context.id = usage.context_id
      WHERE usage.at >= ?1 AND usage.at < ?2 AND usage.input_tokens IS NOT NULL
      -- By position: the names are also columns of the joined tables.
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10`,
    ...params,
  ).map(withBoolean);
  const topTasks = db.all<TaskUsage>(
    `WITH units AS (${UNITS})
     SELECT units.task_id, task.title, units.project_id, COUNT(DISTINCT units.unit) AS rounds, ${FIGURES}
       FROM units JOIN task ON task.id = units.task_id LEFT JOIN usage ON usage.run_id = units.unit
      WHERE units.source = 'run'
      GROUP BY units.task_id
      ORDER BY input + output + cache_read + cache_write DESC, rounds DESC
      LIMIT ${TOP_TASKS}`,
    query.from, query.to,
  );
  return { from: query.from, to: query.to, tz_offset_minutes: query.tzOffsetMinutes, units, usage, top_tasks: topTasks, names: namesOf(db, query) };
}

function namesOf(db: Db, { from, to }: UsageQuery): UsageNames {
  const projects = Object.fromEntries(db.all<{ id: string; name: string }>('SELECT id, name FROM project').map(({ id, name }) => [id, name]));
  const roles = Object.fromEntries(db.all<{ id: string; name: string }>('SELECT id, name FROM role').map(({ id, name }) => [id, name]));
  // A role since removed or renamed keeps the name the round ran it under.
  for (const { role_id: id, role_name: name } of db.all<{ role_id: string; role_name: string }>(
    `SELECT DISTINCT json_extract(snapshot_json, '$.role.id') AS role_id, json_extract(snapshot_json, '$.role.name') AS role_name
       FROM run WHERE ended_at >= ?1 AND ended_at < ?2 AND json_extract(snapshot_json, '$.role.id') IS NOT NULL`,
    from, to,
  )) roles[id] ??= name;
  const logins: Record<string, string> = {};
  for (const { id, name } of db.all<{ id: string; name: string }>('SELECT id, name FROM account')) logins[id] = name;
  for (const { id, machine_id: machine, executor } of db.all<{ id: string; machine_id: string; executor: string }>('SELECT id, machine_id, executor FROM machine_login')) {
    logins[id] = `${machine}/${executor}`;
  }
  for (const { login_id: id, login_name: name } of db.all<{ login_id: string; login_name: string }>(
    `SELECT DISTINCT login_id, login_name FROM run WHERE login_id IS NOT NULL AND login_name IS NOT NULL AND ended_at >= ?1 AND ended_at < ?2
     UNION SELECT DISTINCT login_id, login_name FROM router_context WHERE login_id IS NOT NULL AND login_name IS NOT NULL`,
    from, to,
  )) logins[id] ??= name;
  return { projects, roles, logins };
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

// Compact per-login ledger consumption telemetry over 5h, 24h, 7d, and all-time so every
// account (including executors without an upstream remaining-quota API such as agy) surfaces
// live, account-level consumption across the Quota popover, Accounts page, and Usage page.
export function recentLoginTelemetry(db: Db, nowMs: number = Date.now()): Record<string, LoginTelemetry> {
  const weekCutoff = new Date(nowMs - SEVEN_DAYS_MS).toISOString();
  const dayCutoff = new Date(nowMs - ONE_DAY_MS).toISOString();
  const fiveHourCutoff = new Date(nowMs - FIVE_HOURS_MS).toISOString();
  const tokenSum = `COALESCE(usage.input_tokens, 0) + COALESCE(usage.output_tokens, 0) + COALESCE(usage.cache_read_tokens, 0) + COALESCE(usage.cache_write_tokens, 0)`;
  const rows = db.all<{
    login_id: string;
    five_hour_tokens: number;
    five_hour_runs: number;
    day_tokens: number;
    day_runs: number;
    week_tokens: number;
    week_runs: number;
    total_tokens: number;
    total_runs: number;
    last_at: string | null;
  }>(
    `SELECT COALESCE(run.login_id, router_context.login_id, usage.login_id) AS login_id,
            COALESCE(SUM(CASE WHEN usage.at >= ?3 THEN ${tokenSum} ELSE 0 END), 0) AS five_hour_tokens,
            COUNT(DISTINCT CASE WHEN usage.at >= ?3 THEN ${UNIT_OF_USAGE} ELSE NULL END) AS five_hour_runs,
            COALESCE(SUM(CASE WHEN usage.at >= ?2 THEN ${tokenSum} ELSE 0 END), 0) AS day_tokens,
            COUNT(DISTINCT CASE WHEN usage.at >= ?2 THEN ${UNIT_OF_USAGE} ELSE NULL END) AS day_runs,
            COALESCE(SUM(CASE WHEN usage.at >= ?1 THEN ${tokenSum} ELSE 0 END), 0) AS week_tokens,
            COUNT(DISTINCT CASE WHEN usage.at >= ?1 THEN ${UNIT_OF_USAGE} ELSE NULL END) AS week_runs,
            COALESCE(SUM(${tokenSum}), 0) AS total_tokens,
            COUNT(DISTINCT ${UNIT_OF_USAGE}) AS total_runs,
            MAX(usage.at) AS last_at
       FROM usage
       LEFT JOIN run ON run.id = usage.run_id
       LEFT JOIN router_context ON router_context.id = usage.context_id
      WHERE usage.input_tokens IS NOT NULL
        AND COALESCE(run.login_id, router_context.login_id, usage.login_id) IS NOT NULL
      GROUP BY 1`,
    weekCutoff,
    dayCutoff,
    fiveHourCutoff,
  );
  const result: Record<string, LoginTelemetry> = {};
  for (const row of rows) {
    result[row.login_id] = {
      five_hour_tokens: Number(row.five_hour_tokens) || 0,
      five_hour_runs: Number(row.five_hour_runs) || 0,
      day_tokens: Number(row.day_tokens) || 0,
      day_runs: Number(row.day_runs) || 0,
      week_tokens: Number(row.week_tokens) || 0,
      week_runs: Number(row.week_runs) || 0,
      total_tokens: Number(row.total_tokens) || 0,
      total_runs: Number(row.total_runs) || 0,
      last_at: row.last_at ?? null,
    };
  }
  return result;
}
