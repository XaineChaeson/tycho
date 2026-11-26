// Read-only Login x Tier competence & cost evidence aggregation over the existing ledger tables.
// Zero schema changes: correlates ended non-review runs with usage rows, review verdicts,
// rework send-backs, and tier escalations inside [from, to).
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  COMPETENCE_MIN_SAMPLE_SIZE,
  competenceAdvice,
  type CompetenceReport,
  type CompetenceRow,
} from '../shared/competence.ts';
import type { Db } from './db.ts';

export type CompetenceDb = Db | DatabaseSync;

export interface CompetenceQuery {
  // ISO-8601 instants; matches service/usage.ts half-open window [from, to).
  from: string;
  to: string;
}

interface RawWorkRun {
  run_id: string;
  task_id: string;
  login_id: string | null;
  login_name: string | null;
  executor: string | null;
  tier: string;
  exit_kind: string | null;
  duration_ms: number | null;
  total_tokens: number;
  list_cost_usd: number;
  usage_rows: number;
  priced_rows: number;
}

interface RawReviewBinding {
  review_task_id: string;
  target_run_id: string | null;
  verdict_result: string | null;
  verdict_current: number | boolean | null;
}

interface RawTaskChange {
  seq: number;
  at: string;
  task_id: string;
  run_id: string | null;
  action: 'task.rework' | 'task.escalate';
  review_task_id: string | null;
  detail_run_id: string | null;
}

interface RawTaskRunOrder {
  run_id: string;
  task_id: string;
  ended_at: string | null;
  row_ord: number;
  create_seq: number | null;
}

interface GroupAccumulator {
  login_id: string | null;
  login_name: string;
  executor: string;
  tier: string;
  rounds: number;
  completed_rounds: number;
  failed_rounds: number;
  reviewed_rounds: number;
  first_pass_count: number;
  rework_count: number;
  escalated_count: number;
  duration_sum_ms: number;
  duration_count: number;
  total_tokens: number;
  list_cost_usd: number;
  unpriced_rounds: number;
}

const CHUNK_SIZE = 500;
const FALLBACK_LOGIN_NAME = '默认登录';

function queryAll<T>(db: CompetenceDb, sql: string, ...params: SQLInputValue[]): T[] {
  if ('prepare' in db) return db.prepare(sql).all(...params) as T[];
  return db.all<T>(sql, ...params);
}

function chunked<T>(items: readonly T[], size: number = CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const roundUsd = (value: number): number => Math.round(value * 1e8) / 1e8;

const WORK_RUNS_SQL = `
  SELECT
    run.id AS run_id,
    run.task_id AS task_id,
    run.login_id AS login_id,
    run.login_name AS login_name,
    COALESCE(
      NULLIF(TRIM(json_extract(run.snapshot_json, '$.executor')), ''),
      NULLIF(TRIM(json_extract(run.snapshot_json, '$.login.executor')), '')
    ) AS executor,
    COALESCE(
      NULLIF(TRIM(json_extract(run.snapshot_json, '$.tier')), ''),
      'unspecified'
    ) AS tier,
    run.exit_kind AS exit_kind,
    CASE
      WHEN run.started_at IS NOT NULL
        AND run.ended_at IS NOT NULL
        AND julianday(run.ended_at) >= julianday(run.started_at)
      THEN CAST(ROUND((julianday(run.ended_at) - julianday(run.started_at)) * 86400000) AS INTEGER)
      ELSE NULL
    END AS duration_ms,
    COALESCE(u.total_tokens, 0) AS total_tokens,
    COALESCE(u.list_cost_usd, 0) AS list_cost_usd,
    COALESCE(u.usage_rows, 0) AS usage_rows,
    COALESCE(u.priced_rows, 0) AS priced_rows
  FROM run
  JOIN task ON task.id = run.task_id
  LEFT JOIN (
    SELECT
      usage.run_id AS run_id,
      SUM(
        COALESCE(usage.input_tokens, 0)
        + COALESCE(usage.output_tokens, 0)
        + COALESCE(usage.cache_read_tokens, 0)
        + COALESCE(usage.cache_write_tokens, 0)
      ) AS total_tokens,
      SUM(usage.list_cost_usd) AS list_cost_usd,
      COUNT(usage.input_tokens) AS usage_rows,
      COUNT(usage.list_cost_usd) AS priced_rows
    FROM usage
    WHERE usage.run_id IS NOT NULL
    GROUP BY usage.run_id
  ) AS u ON u.run_id = run.id
  WHERE run.state = 'ended'
    AND run.ended_at >= ?1
    AND run.ended_at < ?2
    AND task.review_of_json IS NULL
    AND COALESCE(json_extract(run.snapshot_json, '$.role.id'), task.role_id, '') != 'review'
    AND NOT (
      run.started_at IS NULL
      AND (
        (COALESCE(run.exit_kind, '') = 'lost' AND COALESCE(json_extract(run.error_json, '$.lost.basis'), '') = 'not_started')
        OR json_extract(run.error_json, '$.worker_not_started') IS NOT NULL
      )
    )
    AND (
      run.started_at IS NOT NULL
      OR COALESCE(run.exit_kind, '') IN ('completed', 'failed')
      OR COALESCE(u.usage_rows, 0) > 0
    )
`;

function loadLoginDirectory(db: CompetenceDb): { names: Map<string, string>; executors: Map<string, string> } {
  const names = new Map<string, string>();
  const executors = new Map<string, string>();
  for (const row of queryAll<{ id: string; name: string; executor: string }>(
    db,
    'SELECT id, name, executor FROM account',
  )) {
    names.set(row.id, row.name);
    executors.set(row.id, row.executor);
  }
  for (const row of queryAll<{ id: string; machine_id: string; executor: string }>(
    db,
    'SELECT id, machine_id, executor FROM machine_login',
  )) {
    names.set(row.id, `${row.machine_id}/${row.executor}`);
    executors.set(row.id, row.executor);
  }
  return { names, executors };
}

function resolveChangeRun(
  change: RawTaskChange,
  reviewToRun: ReadonlyMap<string, string>,
  taskRuns: ReadonlyMap<string, readonly RawTaskRunOrder[]>,
): string | undefined {
  if (change.run_id !== null) return change.run_id;
  if (change.detail_run_id !== null) return change.detail_run_id;
  if (change.review_task_id !== null) {
    const bound = reviewToRun.get(change.review_task_id);
    if (bound !== undefined) return bound;
  }
  const candidates = taskRuns.get(change.task_id);
  if (candidates === undefined || candidates.length === 0) return undefined;
  let bySeq: RawTaskRunOrder | undefined;
  for (const each of candidates) {
    if (each.create_seq !== null && each.create_seq < change.seq) {
      if (bySeq === undefined || each.create_seq > bySeq.create_seq!) bySeq = each;
    }
  }
  if (bySeq !== undefined) return bySeq.run_id;
  let byTime: RawTaskRunOrder | undefined;
  for (const each of candidates) {
    if (each.ended_at !== null && each.ended_at <= change.at) {
      if (
        byTime === undefined
        || each.ended_at > byTime.ended_at!
        || (each.ended_at === byTime.ended_at && each.row_ord > byTime.row_ord)
      ) {
        byTime = each;
      }
    }
  }
  return byTime?.run_id;
}

export function competenceReport(db: CompetenceDb, query: CompetenceQuery): CompetenceReport {
  const runs = queryAll<RawWorkRun>(db, WORK_RUNS_SQL, query.from, query.to);
  if (runs.length === 0) {
    return {
      from: query.from,
      to: query.to,
      min_sample_size: COMPETENCE_MIN_SAMPLE_SIZE,
      rows: [],
      summary: {
        total_rounds: 0,
        reviewed_rounds: 0,
        escalated_rounds: 0,
        total_list_cost_usd: 0,
      },
    };
  }

  const workRunIds = new Set(runs.map((run) => run.run_id));
  const workTaskIds = [...new Set(runs.map((run) => run.task_id))];

  const reviewToRun = new Map<string, string>();
  const passRuns = new Set<string>();
  const reworkRuns = new Set<string>();
  const escalatedRuns = new Set<string>();

  for (const batch of chunked(workTaskIds)) {
    const marks = batch.map(() => '?').join(', ');
    const reviews = queryAll<RawReviewBinding>(
      db,
      `SELECT
         review.id AS review_task_id,
         json_extract(review.review_of_json, '$.run_id') AS target_run_id,
         json_extract(review.verdict_json, '$.result') AS verdict_result,
         json_extract(review.verdict_json, '$.current') AS verdict_current
       FROM task AS review
       WHERE review.review_of_json IS NOT NULL
         AND json_extract(review.review_of_json, '$.task_id') IN (${marks})`,
      ...batch,
    );
    for (const review of reviews) {
      if (typeof review.target_run_id !== 'string' || review.target_run_id === '') continue;
      reviewToRun.set(review.review_task_id, review.target_run_id);
      if (!workRunIds.has(review.target_run_id)) continue;
      // Exclude stale verdicts recorded after the product moved on (`current: false` -> 0 in SQLite JSON).
      if (review.verdict_current === 0 || review.verdict_current === false) continue;
      if (review.verdict_result === 'pass') passRuns.add(review.target_run_id);
      else if (review.verdict_result === 'reject') reworkRuns.add(review.target_run_id);
    }
  }

  const taskChanges: RawTaskChange[] = [];
  const tasksNeedingRunOrder = new Set<string>();

  for (const batch of chunked(workTaskIds)) {
    const marks = batch.map(() => '?').join(', ');
    const changes = queryAll<RawTaskChange>(
      db,
      `SELECT
         change.seq AS seq,
         change.at AS at,
         change.task_id AS task_id,
         change.run_id AS run_id,
         change.action AS action,
         json_extract(change.detail_json, '$.review_task_id') AS review_task_id,
         json_extract(change.detail_json, '$.run_id') AS detail_run_id
       FROM change
       WHERE change.task_id IN (${marks})
         AND change.action IN ('task.rework', 'task.escalate')
       ORDER BY change.seq ASC`,
      ...batch,
    );
    for (const change of changes) {
      taskChanges.push(change);
      const hasDirectTarget = change.run_id !== null
        || change.detail_run_id !== null
        || (change.review_task_id !== null && reviewToRun.has(change.review_task_id));
      if (!hasDirectTarget) tasksNeedingRunOrder.add(change.task_id);
    }
  }

  const taskRuns = new Map<string, RawTaskRunOrder[]>();
  if (tasksNeedingRunOrder.size > 0) {
    for (const batch of chunked([...tasksNeedingRunOrder])) {
      const marks = batch.map(() => '?').join(', ');
      const ordered = queryAll<RawTaskRunOrder>(
        db,
        `SELECT
           run.id AS run_id,
           run.task_id AS task_id,
           run.ended_at AS ended_at,
           run.rowid AS row_ord,
           (
             SELECT MAX(c.seq)
             FROM change AS c
             WHERE c.run_id = run.id AND c.action = 'run.create'
           ) AS create_seq
         FROM run
         WHERE run.task_id IN (${marks})
           AND run.state = 'ended'
         ORDER BY run.task_id, COALESCE(create_seq, -1) ASC, run.ended_at ASC, run.rowid ASC`,
        ...batch,
      );
      for (const item of ordered) {
        const list = taskRuns.get(item.task_id);
        if (list) list.push(item);
        else taskRuns.set(item.task_id, [item]);
      }
    }
  }

  for (const change of taskChanges) {
    const targetRunId = resolveChangeRun(change, reviewToRun, taskRuns);
    if (targetRunId === undefined || !workRunIds.has(targetRunId)) continue;
    if (change.action === 'task.rework') reworkRuns.add(targetRunId);
    else if (change.action === 'task.escalate') escalatedRuns.add(targetRunId);
  }

  const directory = loadLoginDirectory(db);
  const groups = new Map<string, GroupAccumulator>();

  for (const run of runs) {
    const executor = run.executor ?? (run.login_id !== null ? directory.executors.get(run.login_id) : undefined) ?? 'unknown';
    const tier = run.tier;
    const rawLoginName = run.login_name !== null && run.login_name.trim() !== '' ? run.login_name.trim() : undefined;
    const loginName = (run.login_id !== null ? directory.names.get(run.login_id) : undefined)
      ?? rawLoginName
      ?? run.login_id
      ?? FALLBACK_LOGIN_NAME;

    const key = `${run.login_id === null ? '\0null' : run.login_id}\u0000${executor}\u0000${tier}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        login_id: run.login_id,
        login_name: loginName,
        executor,
        tier,
        rounds: 0,
        completed_rounds: 0,
        failed_rounds: 0,
        reviewed_rounds: 0,
        first_pass_count: 0,
        rework_count: 0,
        escalated_count: 0,
        duration_sum_ms: 0,
        duration_count: 0,
        total_tokens: 0,
        list_cost_usd: 0,
        unpriced_rounds: 0,
      };
      groups.set(key, group);
    }

    group.rounds += 1;
    if (run.exit_kind === 'completed') group.completed_rounds += 1;
    else if (run.exit_kind === 'failed') group.failed_rounds += 1;

    if (run.duration_ms !== null) {
      group.duration_sum_ms += run.duration_ms;
      group.duration_count += 1;
    }

    group.total_tokens += run.total_tokens;
    group.list_cost_usd += run.list_cost_usd;
    if (run.usage_rows === 0 || run.priced_rows < run.usage_rows) {
      group.unpriced_rounds += 1;
    }

    const escalated = escalatedRuns.has(run.run_id);
    const reworked = reworkRuns.has(run.run_id) || escalated;
    const passed = !reworked && passRuns.has(run.run_id);

    if (reworked) {
      group.reviewed_rounds += 1;
      group.rework_count += 1;
      if (escalated) group.escalated_count += 1;
    } else if (passed) {
      group.reviewed_rounds += 1;
      group.first_pass_count += 1;
    }
  }

  const rows: CompetenceRow[] = [...groups.values()].map((group) => {
    const firstPassRate = group.reviewed_rounds > 0 ? group.first_pass_count / group.reviewed_rounds : null;
    const failureRate = group.rounds > 0 ? group.failed_rounds / group.rounds : 0;
    const avgDurationMs = group.duration_count > 0 ? Math.round(group.duration_sum_ms / group.duration_count) : null;
    const listCostUsd = roundUsd(group.list_cost_usd);
    const advice = competenceAdvice({
      reviewed_rounds: group.reviewed_rounds,
      first_pass_rate: firstPassRate,
      escalated_count: group.escalated_count,
    });
    return {
      login_id: group.login_id,
      login_name: group.login_name,
      executor: group.executor,
      tier: group.tier,
      rounds: group.rounds,
      completed_rounds: group.completed_rounds,
      failed_rounds: group.failed_rounds,
      reviewed_rounds: group.reviewed_rounds,
      first_pass_count: group.first_pass_count,
      rework_count: group.rework_count,
      escalated_count: group.escalated_count,
      first_pass_rate: firstPassRate,
      failure_rate: failureRate,
      avg_duration_ms: avgDurationMs,
      total_tokens: group.total_tokens,
      list_cost_usd: listCostUsd,
      unpriced_rounds: group.unpriced_rounds,
      advice,
    };
  });

  rows.sort(
    (a, b) =>
      b.rounds - a.rounds
      || cmp(a.executor, b.executor)
      || cmp(a.tier, b.tier)
      || cmp(a.login_name, b.login_name)
      || cmp(a.login_id ?? '', b.login_id ?? ''),
  );

  return {
    from: query.from,
    to: query.to,
    min_sample_size: COMPETENCE_MIN_SAMPLE_SIZE,
    rows,
    summary: {
      total_rounds: rows.reduce((sum, row) => sum + row.rounds, 0),
      reviewed_rounds: rows.reduce((sum, row) => sum + row.reviewed_rounds, 0),
      escalated_rounds: rows.reduce((sum, row) => sum + row.escalated_count, 0),
      total_list_cost_usd: roundUsd(rows.reduce((sum, row) => sum + row.list_cost_usd, 0)),
    },
  };
}
