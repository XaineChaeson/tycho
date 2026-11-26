// What reaches the owner on WeCom, and how, decided by the kind of ledger event and nothing else
// (docs/design/project-sessions.md §2.1). Waiting items go out at once and are reminded while
// they still wait; results go out at once, and what follows within the project's window goes out
// as one; progress is never pushed. The Router writes a result's sentence, never its level.
import type { Db } from './db.ts';
import { nowIso } from './db.ts';
import { ulid } from './ids.ts';
import { ARCHIVED_AT, IN_SIGHT } from './messages.ts';
import { SETTINGS } from './settings.ts';
import { workSummaries } from './work-summary.ts';

type PushLevel = 'wait' | 'result';

// The one table. A kind not here is not an event the owner is pushed about: replies, the
// follow-ups of an item already pushed, and what the service says about itself.
export const PUSH_LEVELS: Readonly<Record<string, PushLevel>> = {
  // A question, a Task the rules stopped, a refused login, no machine for a login, residue only
  // the owner can clear, a knowledge change waiting for the owner's nod.
  approval: 'wait',
  held: 'wait',
  account_credential_rejected: 'wait',
  machine_login_refused: 'wait',
  no_machine: 'wait',
  verify: 'wait',
  knowledge_proposal: 'wait',
  // A trigger that keeps failing by itself (docs/design/triggers.md §8).
  trigger_problem: 'wait',
  // A login's token expected to run out soon, or already (docs/design/native-login.md §2).
  account_expiry: 'wait',
  // A piece of work done and waiting for acceptance; merged; integrated; released.
  work_ready: 'result',
  merged: 'result',
  integrated: 'result',
  released: 'result',
};

export interface PushPolicy {
  remindMs: number;
  // Zero: none.
  remindMax: number;
  // Zero: every result alone.
  resultWindowMs: number;
}

// For a ledger opened without the service's settings: what the settings declare, not a copy.
export const DEFAULT_PUSH_POLICY: PushPolicy = {
  remindMs: SETTINGS['push.remindMs'].default,
  remindMax: SETTINGS['push.remindMax'].default,
  resultWindowMs: SETTINGS['push.resultWindowMs'].default,
};

interface PushRow {
  id: string;
  created_at: string;
  key: string;
  level: PushLevel;
  kind: string;
  project_id: string | null;
  payload_json: string;
  state: 'open' | 'sent' | 'closed';
  reminded: number;
  last_at: string | null;
}

// `external_id`: what makes it once. A row without one is its own.
type Payload = { external_id?: string } & Record<string, unknown>;

// What the brief counts for a project: what waits for the owner, what runs, what is stuck.
interface BriefState {
  waiting: string[];
  running: string[];
  held: string[];
}

interface BriefMark {
  // The scheduled moment it covered, and when it was taken: the start of "done since".
  due: string;
  taken: string;
  projects: Record<string, BriefState>;
}

const BRIEF_KEY = 'daily_brief';
const BRIEF_TITLES = 3;

// `triggerProblem`: whether a trigger's problem is still there, the triggers' own judgement.
// `stillExpiring`: whether the account still holds the token the notice was about and it is
// still inside the reminder window, the ledger's own judgement (native-login.md §2).
export function createPushes(db: Db, deps: { enqueue(kind: string, payload: object): void; policy(): PushPolicy; triggerProblem?: (payload: Record<string, any>) => boolean; stillExpiring?: (payload: Record<string, any>) => boolean }) {
  function projectOf(payload: Record<string, unknown>): string | null {
    if (typeof payload.project_id === 'string') return payload.project_id;
    const taskId = typeof payload.task_id === 'string' ? payload.task_id
      : typeof payload.run_id === 'string' ? db.get<{ task_id: string }>('SELECT task_id FROM run WHERE id = ?', payload.run_id)?.task_id
        : undefined;
    return taskId === undefined ? null : db.get<{ project_id: string | null }>('SELECT project_id FROM task WHERE id = ?', taskId)?.project_id ?? null;
  }

  // Is the thing a waiting item is about still waiting for the owner, as the ledger has it now.
  // What the ledger cannot answer (a machine for a login) is not reminded. Whether its project is
  // archived is not the item's answer: tick skips an archived project's rows, so they survive to
  // be reminded again after the restore.
  function stillWaiting(kind: string, payload: Record<string, any>): boolean {
    switch (kind) {
      case 'approval':
        return db.get<{ state: string }>('SELECT state FROM approval WHERE id = ?', payload.approval_id)?.state === 'open';
      case 'held': {
        const task = db.get<{ state: string; reason: string | null }>('SELECT state, reason FROM task WHERE id = ?', payload.task_id);
        return task?.state === 'held' && task.reason === payload.reason;
      }
      case 'knowledge_proposal':
        return db.get<{ state: string }>('SELECT state FROM knowledge_proposal WHERE id = ?', payload.proposal_id)?.state === 'awaiting_owner';
      case 'account_credential_rejected':
        return payload.ref !== undefined
          && db.get<{ credential_rejected_ref: string | null }>('SELECT credential_rejected_ref FROM login_state WHERE id = ?', payload.account_id)?.credential_rejected_ref === payload.ref;
      case 'machine_login_refused':
        return payload.at !== undefined
          && db.get<{ auth_failed_at: string | null }>('SELECT auth_failed_at FROM login_state WHERE id = ?', payload.login_id)?.auth_failed_at === payload.at;
      case 'account_expiry':
        return deps.stillExpiring?.(payload) ?? false;
      case 'trigger_problem':
        return deps.triggerProblem?.(payload) ?? false;
      case 'verify':
        return payload.finding === 'residue' && db.get<{ state: string }>('SELECT state FROM run WHERE id = ?', payload.run_id)?.state !== 'ended';
      default:
        return false;
    }
  }

  function lastResultAt(projectId: string | null): number | undefined {
    const row = db.get<{ at: string | null }>(`SELECT max(last_at) AS at FROM push WHERE level = 'result' AND state = 'sent' AND project_id IS ?`, projectId);
    return row?.at ? Date.parse(row.at) : undefined;
  }

  function insert(level: PushLevel, kind: string, payload: Payload, state: PushRow['state'], lastAt: string | null): void {
    db.run(
      `INSERT INTO push (id, created_at, key, level, kind, project_id, payload_json, state, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
      ulid(), nowIso(), payload.external_id ?? `${kind}:${ulid()}`, level, kind, projectOf(payload), JSON.stringify(payload), state, lastAt,
    );
  }

  function flush(projectId: string | null, rows: PushRow[], at: string): void {
    if (rows.length === 1) {
      deps.enqueue(rows[0]!.kind, JSON.parse(rows[0]!.payload_json) as object);
    } else {
      deps.enqueue('results', {
        external_id: `results:${rows[0]!.id}`,
        project_id: projectId,
        items: rows.map((row) => ({ kind: row.kind, payload: JSON.parse(row.payload_json) as unknown })),
      });
    }
    for (const row of rows) db.run(`UPDATE push SET state = 'sent', last_at = ? WHERE id = ?`, at, row.id);
  }

  function briefState(projectId: string): BriefState {
    const tasks = db.all<{ id: string; parent_id: string | null; state: string; closed_at: string | null; review_of_json: string | null; verdict_json: string | null }>(
      `SELECT id, parent_id, state, closed_at, review_of_json, verdict_json FROM task WHERE project_id = ? ORDER BY rowid`,
      projectId,
    );
    const approvals = db.all<{ task_id: string; state: string }>(
      `SELECT a.task_id, a.state FROM approval a JOIN task t ON t.id = a.task_id WHERE t.project_id = ? AND a.state = 'open'`,
      projectId,
    );
    const summarize = workSummaries(tasks, approvals);
    const waiting: string[] = [];
    const running: string[] = [];
    const held: string[] = [];
    for (const task of tasks) {
      if (task.parent_id !== null || task.review_of_json !== null) continue;
      const summary = summarize(task.id);
      if (summary.dot === 'waiting_person' || summary.dot === 'ready') waiting.push(task.id);
      else if (summary.dot === 'running' || summary.dot === 'needs_verification') running.push(task.id);
      else if (summary.dot === 'held') held.push(task.id);
    }
    return { waiting, running, held };
  }

  function titled(label: string, ids: string[]): string | undefined {
    if (ids.length === 0) return undefined;
    const titles = ids.slice(0, BRIEF_TITLES).map((id) => db.get<{ title: string }>('SELECT title FROM task WHERE id = ?', id)?.title ?? id);
    return `${label} ${ids.length}：${titles.join('、')}${ids.length > BRIEF_TITLES ? ' 等' : ''}`;
  }

  return {
    stillWaiting,

    resultDelivery(key: string): 'held' | 'pending' | 'sent' | 'given_up' | 'unknown' {
      const push = db.get<Pick<PushRow, 'state'>>("SELECT state FROM push WHERE key = ? AND level = 'result'", key);
      if (push?.state === 'open') return 'held';
      const outbox = db.get<{ state: 'pending' | 'sent' | 'given_up' }>(`
        SELECT state FROM outbox
        WHERE json_extract(payload_json, '$.external_id') = ?
           OR (kind = 'results' AND EXISTS (
             SELECT 1 FROM json_each(payload_json, '$.items')
             WHERE json_extract(value, '$.payload.external_id') = ?
           ))
        ORDER BY rowid DESC LIMIT 1`, key, key);
      return outbox?.state ?? 'unknown';
    },

    // The Router's sentence for a result (§2.1): it takes the place of the service's words while
    // the result has not gone out — held for its window, or still in the Outbox — and does nothing
    // once it has, or when there is no such result. It never makes one. Inside a write.
    supplement(key: string, summary: string): void {
      const held = db.get<PushRow>(`SELECT * FROM push WHERE key = ? AND level = 'result'`, key);
      if (!held) return;
      if (held.state === 'open') {
        db.run('UPDATE push SET payload_json = ? WHERE id = ?', JSON.stringify({ ...(JSON.parse(held.payload_json) as object), summary }), held.id);
        return;
      }
      const queued = db.get<{ id: string; payload_json: string }>(
        `SELECT id, payload_json FROM outbox WHERE state = 'pending' AND tries = 0 AND json_extract(payload_json, '$.external_id') = ?`, key,
      );
      if (queued) db.run('UPDATE outbox SET payload_json = ? WHERE id = ?', JSON.stringify({ ...(JSON.parse(queued.payload_json) as object), summary }), queued.id);
    },

    // In the transaction of the event, after its outbox row: kept while it may be reminded.
    waiting(kind: string, payload: Payload): void {
      insert('wait', kind, payload, 'open', nowIso());
    },

    // In the transaction of the event: out at once, unless its project had one within the window.
    result(kind: string, payload: Payload): void {
      if (payload.external_id !== undefined && db.get('SELECT 1 FROM push WHERE key = ?', payload.external_id)) return;
      const projectId = projectOf(payload);
      const now = Date.now();
      const last = lastResultAt(projectId);
      const holding = db.get(`SELECT 1 FROM push WHERE level = 'result' AND state = 'open' AND project_id IS ?`, projectId) !== undefined;
      if (!holding && (last === undefined || now - last >= deps.policy().resultWindowMs)) {
        deps.enqueue(kind, payload);
        insert('result', kind, payload, 'sent', new Date(now).toISOString());
        return;
      }
      insert('result', kind, payload, 'open', null);
    },

    // Reminders that are due, and results whose window has passed. Inside a write.
    tick(now: Date): void {
      const policy = deps.policy();
      const at = now.toISOString();
      // An archived project is put away, not dealt with: its waiting rows are skipped here, the
      // one place that decides it, so nothing is reminded, no reminder is counted and no row is
      // closed. A restore brings them back into this loop on the next tick.
      for (const row of db.all<PushRow>(
        `SELECT * FROM push WHERE level = 'wait' AND state = 'open'
           AND NOT EXISTS (SELECT 1 FROM project WHERE project.id = push.project_id AND ${ARCHIVED_AT})
         ORDER BY rowid`,
      )) {
        const payload = JSON.parse(row.payload_json) as Payload;
        if (!stillWaiting(row.kind, payload) || row.reminded >= policy.remindMax) {
          db.run(`UPDATE push SET state = 'closed' WHERE id = ?`, row.id);
          continue;
        }
        if (now.getTime() - Date.parse(row.last_at ?? row.created_at) < policy.remindMs) continue;
        const n = row.reminded + 1;
        deps.enqueue('remind', { external_id: `${row.key}:remind:${n}`, kind: row.kind, payload, n, of: policy.remindMax, project_id: row.project_id });
        db.run(`UPDATE push SET reminded = ?, last_at = ?, state = ? WHERE id = ?`, n, at, n >= policy.remindMax ? 'closed' : 'open', row.id);
      }
      const held = db.all<PushRow>(`SELECT * FROM push WHERE level = 'result' AND state = 'open' ORDER BY rowid`);
      for (const projectId of new Set(held.map((row) => row.project_id))) {
        const last = lastResultAt(projectId);
        if (last !== undefined && now.getTime() - last < policy.resultWindowMs) continue;
        flush(projectId, held.filter((row) => row.project_id === projectId), at);
      }
    },

    // §2.1: once a day, per project, what waits, what was done, what runs, what is stuck — the
    // projects where any of that changed since the last one, and nothing when none did. The first
    // one is the point changes are counted from. `due` is the latest scheduled moment up to now.
    // Inside a write. True when one was composed.
    dailyBrief(now: Date, due: Date, mark: { read(): BriefMark | null; write(value: BriefMark): void }): boolean {
      const before = mark.read();
      if (before !== null && Date.parse(before.due) >= due.getTime()) return false;
      const projects = db.all<{ id: string; name: string }>(`SELECT id, name FROM project WHERE ${IN_SIGHT} ORDER BY rowid`);
      const states = Object.fromEntries(projects.map(({ id }) => [id, briefState(id)]));
      mark.write({ due: due.toISOString(), taken: nowIso(), projects: states });
      if (before === null) return false;
      const lines: string[] = [];
      for (const { id, name } of projects) {
        const state = states[id]!;
        const done = db.all<{ id: string }>(`SELECT id FROM task WHERE project_id = ? AND state = 'done' AND closed_at > ? ORDER BY rowid`, id, before.taken).map((row) => row.id);
        if (done.length === 0 && JSON.stringify(state) === JSON.stringify(before.projects[id] ?? null)) continue;
        const parts = [titled('等你', state.waiting), titled('完成', done), titled('在跑', state.running), titled('卡住', state.held)].filter(Boolean);
        lines.push(`【${name}】${parts.length > 0 ? parts.join('；') : '都结束了'}`);
      }
      if (lines.length === 0) return false;
      deps.enqueue('brief', { external_id: `brief:${due.toISOString()}`, lines });
      return true;
    },
  };
}

export const DAILY_BRIEF_KEY = BRIEF_KEY;
export type { BriefMark };

// The latest moment at `clock` (local "HH:MM") up to `now`: by calendar, so daylight saving
// cannot move it.
export function latestMoment(now: Date, clock: string): Date {
  const [hour, minute] = clock.split(':').map(Number) as [number, number];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  return today.getTime() <= now.getTime() ? today : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute);
}
