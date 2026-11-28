import { reportAuditView } from './run-report.ts';
import type { Ctx, Db } from './db.ts';
import { nowIso, TASK_SELECT, writeChange } from './db.ts';
import { InputError } from './errors.ts';
import type { TierSource } from '../shared/roles.ts';
import type { TierId } from '../shared/tiers.ts';
import { fromOwner } from '../shared/triggers.ts';
import { ulid } from './ids.ts';
import type { RunRow, TaskRow, TaskState, Whitelist } from './ledger.ts';

// `unassigned`: a message of the owner's that belongs to no project yet. It is never taken;
// the owner gives it a project, which makes it `received` (docs/design/project-sessions.md §2).
type MessageState = 'received' | 'unassigned' | 'processing' | 'processed' | 'ignored' | 'unverified';

// Why a message belongs where it does (§1): the console page it was written on, the Task or Run
// it names (or an internal event is about), the WeCom chat's current project, the owner's choice
// or naming, the old global record (§6), or the trigger that delivered it (docs/design/triggers.md §3).
type MessageBasis = 'console' | 'object' | 'current' | 'owner' | 'legacy' | 'trigger';

export interface MessageRow {
  id: string;
  created_at: string;
  channel: string;
  external_id: string;
  thread: string | null;
  direction: 'in' | 'out';
  actor: string | null;
  text: string;
  state: MessageState | null;
  final: number;
  at: string;
  project_id: string | null;
  // Set when the message is taken: what is queued follows the project's current segment.
  segment_id: string | null;
  basis: MessageBasis | null;
  // What the WeCom front desk put to the owner when it could not place the message (§2): JSON of
  // front-desk.ts Candidates. Null for every other message.
  candidates_json: string | null;
  // The Task an internal message is about; null for every other message.
  task_id: string | null;
  // Project file ids attached to this message as a JSON string array; null when none.
  attachments_json: string | null;
  // External message id this message replies to / quotes (from IM channel); null when none.
  reply_to_external_id?: string | null;
}

// Among the messages a restart left processing, the first of each project's turn, in the order
// they were read (rowid): its audit rows are where the turn's committed operations hang, so a
// later message of the same turn lists them. A message of no project stands alone.
export function turnFirsts(messages: readonly Pick<MessageRow, 'id' | 'project_id'>[]): string[] {
  const first = new Map<string, string>();
  return messages.map(({ id, project_id }) => {
    if (project_id === null) return id;
    const held = first.get(project_id);
    if (held !== undefined) return held;
    first.set(project_id, id);
    return id;
  });
}

export interface ChangeRow {
  seq: number;
  at: string;
  actor: string;
  message_id: string | null;
  task_id: string | null;
  run_id: string | null;
  action: string;
  detail_json: string | null;
  tool_call_id?: string | null;
}

interface SegmentRow {
  id: string;
  created_at: string;
  project_id: string;
  seq: number;
  state: 'current' | 'closed';
  closed_at: string | null;
}

// One executor context (§1): the session a Router process is started or resumed as, under one
// login. No segment: the old global Router's, kept as the record (§6).
export interface ContextRow {
  id: string;
  created_at: string;
  segment_id: string | null;
  project_id: string | null;
  session_ref: string | null;
  pid: number | null;
  marker: string;
  state: 'open' | 'closed';
  // The account it runs as; null is this computer's own login.
  login_id: string | null;
  login_name: string | null;
  credential_ref: string | null;
  launch_json: string | null;
  live_at: string | null;
  last_turn_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  material_json: string | null;
  knowledge_json: string | null;
  // How large the context was at the last call its process reported; null before any.
  context_tokens: number | null;
}

export type LoginMode = 'all' | 'selected';

export interface ProjectRow {
  id: string;
  created_at: string;
  name: string;
  logins_json: string;
  machines_json: string;
  // Where this project's code comes from, in order, the first being the default; empty for a
  // project with no code (shared/sources.ts Source, docs/design/code-sources.md).
  sources_json: string;
  // 1 when the owner lets this project's tasks spawn machines (docs/design/nodes.md §1.3).
  spawn_machines: number;
  // Every login there is when dispatching, or only those `logins_json` lists (§1, §5).
  login_mode: LoginMode;
  // When the owner paused it (§5): nothing of it is dispatched and its Router takes no message.
  paused_at: string | null;
  // When the owner archived it: the same hold, until it is restored.
  archived_at: string | null;
  // What its Router may do without asking, as shared/grants.ts names it.
  grants_json: string;
  // Null account inherits the service default. Null tier uses the selected executor's default.
  router_account: string | null;
  router_tier: string | null;
  // Optional single-group category for organizing projects in the sidebar and projects directory.
  category: string | null;
  // 1 when pinned to the top of the project list.
  pinned: number;
}

// What a project's messages and Tasks are held back by while it is put away: one condition,
// joined into every query that hands out work, and asked by whatever else needs to know.
// `ARCHIVED_AT` is also the one reading of "archived" for what asks the owner: the daily brief
// and the missing-login notice leave an archived project out, and the reminder tick skips its
// waiting rows without closing them, so a restore resumes them. A paused project is only
// resting, so it still asks.
export const ARCHIVED_AT = 'archived_at IS NOT NULL';
export const IN_SIGHT = `NOT (${ARCHIVED_AT})`;
const STOPPED_PROJECTS = `SELECT id FROM project WHERE paused_at IS NOT NULL OR ${ARCHIVED_AT}`;
const RUNNING_PROJECT = (column: string): string => `(${column} IS NULL OR ${column} NOT IN (${STOPPED_PROJECTS}))`;
// Which of the two states holds a project back, for the places whose words differ (§5).
export const projectStoppedIn = (db: Pick<Db, 'get'>, projectId: string | null): 'paused' | 'archived' | null => {
  if (projectId === null) return null;
  const row = db.get<{ paused_at: string | null; archived_at: string | null }>('SELECT paused_at, archived_at FROM project WHERE id = ?', projectId);
  if (!row) return null;
  return row.archived_at !== null ? 'archived' : row.paused_at !== null ? 'paused' : null;
};

export interface InputRow {
  id: string;
  created_at: string;
  task_id: string;
  text: string;
  actor: string;
  message_id: string | null;
  state: 'queued' | 'attached' | 'void';
  run_id: string | null;
}

export interface ApprovalRow {
  id: string;
  created_at: string;
  task_id: string;
  run_id: string | null;
  task_revision: number;
  questions_json: string;
  state: 'open' | 'answered' | 'closed';
  answers_json: string | null;
  answered_by: string | null;
  answered_via: string | null;
  decided_at: string | null;
  review_task_id?: string | null;
}

export interface TaskSummary {
  id: string;
  // Null for a knowledge gate or curation Task, which belongs to no project.
  project_id: string | null;
  title: string;
  state: TaskState;
  // A Task has no column for this; its audit trail knows.
  updated_at: string;
  reason: string | null;
  // The source the Task is pinned to (shared/sources.ts TaskSource), for the page's list.
  source_json: string | null;
  role_id: string | null;
  tier: TierId | null;
  tier_override: TierId | null;
  tier_source: TierSource | null;
  login_id: string | null;
}

// `project_id`: the Task's, for a project's conversation to show its own questions.
export type ApprovalCard = ApprovalRow & { task_title: string; project_id: string | null };

const HOST: Ctx = { actor: 'session-host' };
const APPROVAL_STATES = ['open', 'answered', 'closed'];
// The most internal events one turn carries, the first one included: a burst of settlements is
// one turn for the Router, not a turn each.
const INTERNAL_PER_TURN_MAX = 10;

// A MessageRow with the rowid the queue is ordered by, read only to page the next ones.
type QueuedMessage = MessageRow & { rowid: number };

// `taken`: told of each message the Router takes, inside the transaction of the take.
export function createMessages(db: Db, write: <T>(fn: () => T) => T, options: { taken?: (message: MessageRow) => void } = {}) {
  function loadMessage(id: string): MessageRow {
    const message = db.get<MessageRow>('SELECT * FROM message WHERE id = ?', id);
    if (!message) throw new InputError(`消息不存在：${id}`);
    return message;
  }

  function contextProject(id: string): string {
    const context = db.get<{ project_id: string }>('SELECT project_id FROM router_context WHERE id = ?', id);
    if (!context) throw new InputError(`负责人上下文不存在：${id}`);
    return context.project_id;
  }

  function whitelist(): Whitelist {
    const row = db.get<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'whitelist'`);
    return row ? (JSON.parse(row.value_json) as Whitelist) : {};
  }

  function requireProject(id: string): string {
    const project = db.get<{ name: string }>('SELECT name FROM project WHERE id = ?', id);
    if (!project) throw new InputError(`项目不存在：${id}`);
    return project.name;
  }

  // The message's own lifecycle goes in the detail, not in change.message_id: that
  // column answers "what was committed because of this message", which is exactly
  // the list an unfinished request shows.
  const lifecycle = (action: string, ctx: Ctx, id: string, detail: object = {}): void =>
    writeChange(db, action, ctx, {}, { message_id: id, ...detail });

  const currentSegment = (projectId: string): SegmentRow | undefined =>
    db.get<SegmentRow>(`SELECT * FROM router_segment WHERE project_id = ? AND state = 'current'`, projectId);

  // Inside a write. A project's first segment is opened when it first needs one.
  function newSegment(projectId: string, ctx: Ctx): SegmentRow {
    const at = nowIso();
    const last = db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM router_segment WHERE project_id = ?', projectId)?.seq ?? 0;
    const id = ulid();
    db.run(`INSERT INTO router_segment (id, created_at, project_id, seq, state) VALUES (?, ?, ?, ?, 'current')`, id, at, projectId, last + 1);
    writeChange(db, 'router.segment', ctx, {}, { project_id: projectId, segment_id: id, seq: last + 1 });
    return db.get<SegmentRow>('SELECT * FROM router_segment WHERE id = ?', id)!;
  }

  function closeContextRow(id: string, reason: string, ctx: Ctx): void {
    const row = db.get<ContextRow>('SELECT * FROM router_context WHERE id = ?', id);
    if (!row || row.state === 'closed') return;
    db.run(`UPDATE router_context SET state = 'closed', closed_at = ?, closed_reason = ? WHERE id = ?`, nowIso(), reason, id);
    writeChange(db, 'router.close', ctx, {}, { router_context_id: id, project_id: row.project_id, reason });
  }

  // One turn for the Router: the first message waiting, and, when that is an internal event,
  // the internal events queued right behind it in the same project — the run stops at the first
  // message that is not one, so an owner's message is never passed over. All of them are taken
  // in this one transaction and are the same turn's input.
  function takeNextTurn(projectId: string, segmentId?: string): { message: MessageRow; attached: MessageRow[] } | undefined {
    return write(() => {
      if (!db.mayWriteProject(projectId)) return undefined;
      if (db.get(`SELECT 1 FROM message WHERE state = 'processing' AND project_id = ?`, projectId)) return undefined;
      const next = db.get<QueuedMessage>(`SELECT rowid, * FROM message WHERE state = 'received' AND project_id = ? AND ${RUNNING_PROJECT('project_id')} ORDER BY rowid LIMIT 1`, projectId);
      if (!next) return undefined;
      const segment = currentSegment(projectId) ?? newSegment(projectId, HOST);
      if (segmentId !== undefined && segment.id !== segmentId) return undefined;
      const take = (row: QueuedMessage, firstId?: string): MessageRow => {
        db.run(`UPDATE message SET state = 'processing', segment_id = ? WHERE id = ?`, segment.id, row.id);
        lifecycle('message.take', HOST, row.id, {
          project_id: projectId, segment_id: segment.id, ...(firstId ? { turn_message_id: firstId } : {}),
        });
        options.taken?.(row);
        const { rowid: _rowid, ...rest } = row;
        return { ...rest, state: 'processing', segment_id: segment.id };
      };
      const message = take(next);
      const attached: MessageRow[] = [];
      if (next.channel === 'internal') {
        const followers = db.all<QueuedMessage>(
          `SELECT rowid, * FROM message WHERE state = 'received' AND project_id = ? AND ${RUNNING_PROJECT('project_id')} AND rowid > ? ORDER BY rowid LIMIT ?`,
          projectId,
          next.rowid,
          INTERNAL_PER_TURN_MAX - 1,
        );
        for (const row of followers) {
          // The run is consecutive: whatever waits after another kind belongs to a later turn.
          if (row.channel !== 'internal') break;
          attached.push(take(row, message.id));
        }
      }
      return { message, attached };
    });
  }

  return {
    getMessage: loadMessage,

    // `projectId`: where the message was written (a project's page), or where the ledger says an
    // event belongs. Without one, a message the owner sent waits to be given a project and is
    // never taken until then (§2).
    receiveMessage(fields: { channel: string; externalId: string; actor: string; text: string; thread?: string; projectId?: string; attachmentIds?: readonly string[]; replyToExternalId?: string | null }) {
      return write(() => {
        const known = db.get<{ id: string; state: MessageState; fresh?: boolean }>(
          'SELECT id, state FROM message WHERE channel = ? AND external_id = ?',
          fields.channel,
          fields.externalId,
        );
        if (known) return known;
        if (fields.projectId !== undefined) requireProject(fields.projectId);
        const allowed = fields.channel === 'internal' || (whitelist()[fields.channel] ?? []).includes(fields.actor);
        const state: MessageState = !allowed ? 'ignored' : fields.projectId === undefined ? 'unassigned' : 'received';
        const basis: MessageBasis | null = !allowed || fields.projectId === undefined ? null : fields.channel === 'console' ? 'console' : 'object';
        const attachmentsJson = allowed && fields.attachmentIds && fields.attachmentIds.length > 0 ? JSON.stringify(fields.attachmentIds) : null;
        const id = ulid();
        const at = nowIso();
        db.run(
          `INSERT INTO message (id, created_at, channel, external_id, thread, direction, actor, text, state, at, project_id, basis, attachments_json, reply_to_external_id)
           VALUES (?, ?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          at,
          fields.channel,
          fields.externalId,
          fields.thread ?? null,
          fields.actor,
          fields.text,
          state,
          at,
          allowed ? fields.projectId ?? null : null,
          basis,
          attachmentsJson,
          fields.replyToExternalId ?? null,
        );
        lifecycle('message.receive', { actor: fields.actor }, id, { channel: fields.channel, state, ...(basis === null ? {} : { project_id: fields.projectId, basis }) });
        // `fresh`: written now, not a redelivery of one already here.
        return { id, state, fresh: true };
      });
    },

    // The owner gives messages a project: the ones waiting for one, or ones not taken yet that
    // were put somewhere else. All of them or none, in the transaction that makes them takeable;
    // one already taken stays where it was taken (§2).
    assignMessages(ids: string[], projectId: string, ctx: Ctx): MessageRow[] {
      return write(() => {
        requireProject(projectId);
        if (ids.length === 0) throw new InputError('没有要归属的消息');
        const rows = [...new Set(ids)].map(loadMessage);
        const taken = rows.filter((row) => row.direction !== 'in' || (row.state !== 'unassigned' && row.state !== 'received'));
        if (taken.length > 0) {
          throw new InputError(`这些消息已经被负责人取走或不是待处理的消息，不能再改归属：${taken.map(({ id }) => id).join('、')}`);
        }
        for (const row of rows) {
          db.run(`UPDATE message SET project_id = ?, basis = 'owner', state = 'received', segment_id = NULL WHERE id = ?`, projectId, row.id);
          lifecycle('message.assign', ctx, row.id, { project_id: projectId, from: row.project_id });
        }
        return rows.map(({ id }) => loadMessage(id));
      });
    },

    unassignedMessages: (): MessageRow[] => db.all<MessageRow>(`SELECT * FROM message WHERE state = 'unassigned' ORDER BY rowid`),

    // The projects with a message waiting to be taken, oldest waiting first.
    projectsWaiting: (): string[] =>
      db.all<{ project_id: string }>(
        `SELECT project_id FROM message WHERE state = 'received' AND project_id IS NOT NULL AND ${RUNNING_PROJECT('project_id')} GROUP BY project_id ORDER BY min(rowid)`,
      ).map(({ project_id }) => project_id).filter((projectId) => db.mayWriteProject(projectId)),

    // A message its Router may take now: none while the project is paused.
    hasReceivedMessage: (projectId: string): boolean =>
      db.mayWriteProject(projectId) && db.get(`SELECT 1 FROM message WHERE state = 'received' AND project_id = ? AND ${RUNNING_PROJECT('project_id')} LIMIT 1`, projectId) !== undefined,

    // Zero for a message that is not waiting. Only its own project's queue is ahead of it.
    queuedAhead(id: string): number {
      const row = db.get<{ n: number }>(
        `SELECT count(*) AS n FROM message AS ahead, message AS self
         WHERE self.id = ? AND self.state = 'received' AND ahead.state = 'received' AND ahead.project_id = self.project_id AND ahead.rowid < self.rowid`,
        id,
      );
      return row?.n ?? 0;
    },

    // One turn at a time per project, into the project's current segment as it is now: what
    // was queued before a new topic began goes into the new one (§3). `segmentId`: the segment of
    // the context the turn is for; when it is not the current one nothing is taken.
    takeNextTurn,

    finishMessage(id: string, state: 'processed' | 'unverified'): void {
      write(() => {
        const message = loadMessage(id);
        if (message.state !== 'processing') {
          throw new InputError(`消息 ${id} 状态为 ${message.state}，不能收尾`);
        }
        db.run('UPDATE message SET state = ? WHERE id = ?', state, id);
        lifecycle('message.finish', HOST, id, { state });
      });
    },

    // A taken message that provably never reached a model goes back to its project's queue, in
    // its place: only the Session Host says so, of a resume that failed by itself (§3).
    requeueMessage(id: string, reason: string): void {
      write(() => {
        const message = loadMessage(id);
        if (message.state !== 'processing') throw new InputError(`消息 ${id} 状态为 ${message.state}，不能放回队列`);
        db.run(`UPDATE message SET state = 'received', segment_id = NULL WHERE id = ?`, id);
        lifecycle('message.requeue', HOST, id, { reason });
      });
    },

    // One row per reply: drafts overwrite it and the final text ends it, so a
    // streamed answer does not leave a trail of fragments in the conversation.
    // Drafts are display data like touchRun and write no change. A reply belongs where the
    // message it answers does.
    writeOutbound(fields: { channel: string; thread?: string | null; text: string; final: boolean; replyTo?: string }): MessageRow {
      return write(() => {
        const id = ulid();
        const at = nowIso();
        const externalId = fields.replyTo ? `reply:${fields.replyTo}` : `out:${id}`;
        const answered = fields.replyTo ? db.get<Pick<MessageRow, 'project_id' | 'segment_id'>>('SELECT project_id, segment_id FROM message WHERE id = ?', fields.replyTo) : undefined;
        db.run(
          `INSERT INTO message (id, created_at, channel, external_id, thread, direction, actor, text, final, at, project_id, segment_id)
           VALUES (?, ?, ?, ?, ?, 'out', 'router', ?, ?, ?, ?, ?)
           ON CONFLICT (channel, external_id) DO UPDATE SET text = excluded.text, final = excluded.final, at = excluded.at
           WHERE message.final = 0`,
          id,
          at,
          fields.channel,
          externalId,
          fields.thread ?? null,
          fields.text,
          fields.final ? 1 : 0,
          at,
          answered?.project_id ?? null,
          answered?.segment_id ?? null,
        );
        const row = db.get<MessageRow>(
          'SELECT * FROM message WHERE channel = ? AND external_id = ?',
          fields.channel,
          externalId,
        )!;
        if (fields.final) {
          writeChange(db, 'message.reply', { actor: 'router', messageId: fields.replyTo }, {}, { reply_id: row.id });
        }
        return row;
      });
    },

    // Without `after` this is the newest page, still oldest first, for a fresh view. `segment`
    // narrows to one segment of a project; `legacy` to the old global record (§6), and with a
    // project to the part of it linked to that project.
    listMessages({ after, limit, segmentId, legacy, projectId }: { after?: string; limit: number; segmentId?: string; legacy?: boolean; projectId?: string }): MessageRow[] {
      const filters: string[] = [];
      const params: string[] = [];
      if (after) {
        filters.push('id > ?');
        params.push(after);
      }
      if (segmentId !== undefined) {
        // What is queued for the project belongs to its current segment until it is taken.
        filters.push(`(segment_id = ? OR (segment_id IS NULL AND basis IS NOT 'legacy' AND state IN ('received') AND project_id = (SELECT project_id FROM router_segment WHERE id = ? AND state = 'current')))`);
        params.push(segmentId, segmentId);
      }
      if (legacy) filters.push(`basis = 'legacy'`);
      if (projectId !== undefined) {
        filters.push('project_id = ?');
        params.push(projectId);
        // A project's own conversation, not the part of the old record linked to it.
        if (!legacy) filters.push(`basis IS NOT 'legacy'`);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      if (after) return db.all<MessageRow>(`SELECT * FROM message ${where} ORDER BY id LIMIT ?`, ...params, limit);
      return db.all<MessageRow>(`SELECT * FROM message ${where} ORDER BY id DESC LIMIT ?`, ...params, limit).reverse();
    },

    listChanges(filter: { messageId: string } | { taskId: string }): ChangeRow[] {
      const byMessage = 'messageId' in filter;
      return db.all<ChangeRow>(
        `SELECT seq, at, actor, message_id, task_id, run_id, action, detail_json, tool_call_id FROM change
         WHERE ${byMessage ? 'message_id' : 'task_id'} = ? ORDER BY seq`,
        byMessage ? filter.messageId : filter.taskId,
      ).map(reportAuditView);
    },

    // Like the lifecycle rows, this is not something the turn itself committed.
    noteInterrupt(id: string, ctx: Ctx): void {
      write(() => lifecycle('message.interrupt', ctx, id));
    },

    // A message being handled when its turn can no longer be: none of a project whose turn is
    // still under way (`busy`), which ends by itself (§3).
    markProcessingUnverified(busy: readonly string[] = []): string[] {
      return write(() => {
        const open = db.all<{ id: string; project_id: string | null }>(`SELECT id, project_id FROM message WHERE state = 'processing' ORDER BY rowid`)
          .filter(({ project_id }) => project_id === null || !busy.includes(project_id));
        for (const { id } of open) {
          db.run(`UPDATE message SET state = 'unverified' WHERE id = ?`, id);
          lifecycle('message.finish', { actor: 'service' }, id, { state: 'unverified', restart: true });
        }
        return open.map(({ id }) => id);
      });
    },

    // An old backup: nobody can say whether a received message was handled later on, nor where
    // one that was waiting for a project was put since.
    markOpenUnverified(): string[] {
      return write(() => {
        const open = db.all<{ id: string }>(`SELECT id FROM message WHERE state IN ('received', 'processing', 'unassigned') ORDER BY rowid`);
        for (const { id } of open) {
          db.run(`UPDATE message SET state = 'unverified' WHERE id = ?`, id);
          lifecycle('message.finish', { actor: 'service' }, id, { state: 'unverified', restore: true });
        }
        return open.map(({ id }) => id);
      });
    },

    // ---- Segments and executor contexts (docs/design/project-sessions.md §1, §3) ----

    currentSegment,

    // The project's current segment, opened if it has none yet.
    ensureSegment(projectId: string): SegmentRow {
      return currentSegment(projectId) ?? write(() => currentSegment(projectId) ?? newSegment(projectId, HOST));
    },

    // The owner's "new topic": the current segment becomes history and its executor context is
    // closed with it, in one transaction. A turn under way finishes in the old one; what is
    // queued goes to the new one (§3).
    newTopic(projectId: string, ctx: Ctx): SegmentRow {
      return write(() => {
        requireProject(projectId);
        const current = currentSegment(projectId);
        if (current) {
          db.run(`UPDATE router_segment SET state = 'closed', closed_at = ? WHERE id = ?`, nowIso(), current.id);
          const open = db.get<{ id: string }>(`SELECT id FROM router_context WHERE project_id = ? AND state = 'open'`, projectId);
          if (open) closeContextRow(open.id, '主人开了新话题', ctx);
        }
        return newSegment(projectId, ctx);
      });
    },

    listSegments: (projectId: string): SegmentRow[] =>
      db.all<SegmentRow>('SELECT * FROM router_segment WHERE project_id = ? ORDER BY seq', projectId),

    getSegment: (id: string): SegmentRow | undefined => db.get<SegmentRow>('SELECT * FROM router_segment WHERE id = ?', id),

    // What the context is opened under — the login, its login directory and the number of the
    // token — is recorded with it: the CLI keeps a conversation inside the login it was held in.
    // `loginId`: the login it runs as — an account, or this computer's own login (session-host's
    // hostLogin). The segment has to be the project's current one: a context of a segment a new
    // topic closed would take the new segment's messages into the old conversation.
    openContext(fields: {
      projectId: string; segmentId: string; marker: string;
      loginId?: string | null; loginName?: string; credentialRef?: string; launch: unknown; knowledge: unknown;
    }): ContextRow {
      return write(() => {
        const segment = db.get<SegmentRow>('SELECT * FROM router_segment WHERE id = ?', fields.segmentId);
        if (!segment || segment.project_id !== fields.projectId) throw new InputError(`项目没有这一段对话：${fields.segmentId}`);
        if (segment.state !== 'current') throw new InputError(`对话的第 ${segment.seq} 段已经结束，不能再为它开负责人上下文`);
        const open = db.get<{ id: string }>(`SELECT id FROM router_context WHERE project_id = ? AND state = 'open'`, fields.projectId);
        if (open) throw new InputError(`项目的负责人上下文 ${open.id} 还开着，不能再开一个`);
        const id = ulid();
        db.run(
          `INSERT INTO router_context (id, created_at, segment_id, project_id, marker, state, login_id, login_name, credential_ref, launch_json, knowledge_json)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
          id, nowIso(), fields.segmentId, fields.projectId, fields.marker,
          fields.loginId ?? null, fields.loginName ?? null, fields.credentialRef ?? null, JSON.stringify(fields.launch), JSON.stringify(fields.knowledge),
        );
        writeChange(db, 'router.open', HOST, {}, { router_context_id: id, project_id: fields.projectId, segment_id: fields.segmentId, login: fields.loginId ?? null });
        return db.get<ContextRow>('SELECT * FROM router_context WHERE id = ?', id)!;
      });
    },

    // What a new context was given to start from (§3), kept before it is sent: the Router's
    // actual input, as a Run's snapshot is a Worker's.
    recordMaterial(id: string, material: unknown): void {
      write(() => {
        const projectId = contextProject(id);
        db.run('UPDATE router_context SET material_json = ? WHERE id = ?', JSON.stringify(material), id);
        writeChange(db, 'router.material', HOST, {}, { router_context_id: id, project_id: projectId });
      });
    },

    closeContext(id: string, reason: string): void {
      write(() => closeContextRow(id, reason, HOST));
    },

    currentContext: (projectId: string): ContextRow | undefined =>
      db.get<ContextRow>(`SELECT * FROM router_context WHERE project_id = ? AND state = 'open'`, projectId),

    getContext: (id: string): ContextRow | undefined => db.get<ContextRow>('SELECT * FROM router_context WHERE id = ?', id),

    // Every context a process of which may still be running — one started and not seen gone, or
    // one still open, whatever was recorded of its start: the markers a start, a stop and a
    // release scan for (§3).
    liveContexts: (): ContextRow[] => db.all<ContextRow>(`SELECT * FROM router_context WHERE live_at IS NOT NULL OR state = 'open' ORDER BY rowid`),

    setContextRef(id: string, sessionRef: string): void {
      write(() => {
        const projectId = contextProject(id);
        db.run('UPDATE router_context SET session_ref = ? WHERE id = ?', sessionRef, id);
        writeChange(db, 'router.session_ref', HOST, {}, { router_context_id: id, session_ref: sessionRef, project_id: projectId });
      });
    },

    // A process was started for it: from now on its marker is one to scan for. The pid is
    // display data; the marker is what ownership rests on.
    setContextStarted(id: string, pid: number | null): void {
      write(() => db.run('UPDATE router_context SET pid = ?, live_at = ? WHERE id = ?', pid, nowIso(), id));
    },

    // A scan for its marker found nothing: no process of it runs.
    setContextCleared(id: string): void {
      write(() => db.run('UPDATE router_context SET pid = NULL, live_at = NULL WHERE id = ? AND (pid IS NOT NULL OR live_at IS NOT NULL)', id));
    },

    setContextPid(id: string, pid: number | null): void {
      write(() => db.run('UPDATE router_context SET pid = ? WHERE id = ? AND pid IS NOT ?', pid, id, pid));
    },

    // A turn's end; with the context's size when the turn reported one.
    touchContext(id: string, contextTokens?: number): void {
      write(() => contextTokens === undefined
        ? db.run('UPDATE router_context SET last_turn_at = ? WHERE id = ?', nowIso(), id)
        : db.run('UPDATE router_context SET last_turn_at = ?, context_tokens = ? WHERE id = ?', nowIso(), contextTokens, id));
    },

    // The contexts of a project, and the old global record's (`projectId` null), oldest first.
    listContexts: (projectId: string | null): ContextRow[] =>
      projectId === null
        ? db.all<ContextRow>('SELECT * FROM router_context WHERE segment_id IS NULL ORDER BY rowid')
        : db.all<ContextRow>('SELECT * FROM router_context WHERE project_id = ? ORDER BY rowid', projectId),

    // What the owner asked of a project that nothing has been done about yet (§3): every message of
    // theirs about it whose turn committed no operation, oldest first. Paged by message id.
    openRequests(projectId: string, { after, limit }: { after?: string; limit: number }): MessageRow[] {
      return db.all<MessageRow>(
        `SELECT m.* FROM message m WHERE m.project_id = ? AND m.direction = 'in' AND m.channel NOT IN ('internal', 'trigger')
           AND m.state IN ('processed', 'unverified') AND m.id > ?
           AND NOT EXISTS (SELECT 1 FROM change c WHERE c.message_id = m.id AND c.action NOT LIKE 'message.%' AND c.action NOT LIKE 'router.%')
         ORDER BY m.id LIMIT ?`,
        projectId, after ?? '', limit,
      );
    },

    // An operation commits work, not every constraint in the owner's request. Keep the
    // original messages reachable from their causal Task after a context is rebuilt.
    taskOwnerRequests(taskId: string): MessageRow[] {
      return db.all<MessageRow>(
        `SELECT m.* FROM message m JOIN task t ON t.id = ? AND t.project_id = m.project_id
         WHERE m.direction = 'in'
           AND EXISTS (SELECT 1 FROM change c WHERE c.task_id = t.id AND c.message_id = m.id)
         ORDER BY m.id`, taskId,
      ).filter(({ channel }) => fromOwner(channel));
    },

    // The requests of a project whose turn did not end as it should (§3): every one, oldest first,
    // paged by message id — straight from the ledger, never out of a window of recent history.
    unverifiedRequests(projectId: string, { after, limit }: { after?: string; limit: number }): MessageRow[] {
      return db.all<MessageRow>(
        `SELECT * FROM message WHERE project_id = ? AND direction = 'in' AND state = 'unverified' AND id > ? ORDER BY id LIMIT ?`,
        projectId, after ?? '', limit,
      );
    },

    // `openOnly`: only the Tasks that are not over yet (the Router's default view). `after` and
    // `limit` page that order by rowid: `after` is the last Task id of the page before.
    listTasks({ projectId, states, openOnly = false, after, limit }: { projectId?: string; states?: TaskState[]; openOnly?: boolean; after?: string; limit?: number } = {}): TaskRow[] {
      const filters: string[] = [];
      const params: (string | number)[] = [];
      if (projectId) {
        filters.push('task.project_id = ?');
        params.push(projectId);
      }
      if (states?.length) {
        filters.push(`task.state IN (${states.map(() => '?').join(', ')})`);
        params.push(...states);
      } else if (openOnly) {
        filters.push(`task.state NOT IN ('done', 'abandoned')`);
      }
      if (after !== undefined) {
        // The cursor is one of this project's Tasks: another project's id is not a place in
        // this project's order.
        filters.push(projectId
          ? 'task.rowid > (SELECT rowid FROM task WHERE id = ? AND project_id = ?)'
          : 'task.rowid > (SELECT rowid FROM task WHERE id = ?)');
        params.push(after);
        if (projectId) params.push(projectId);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const page = limit === undefined ? '' : ' LIMIT ?';
      if (limit !== undefined) params.push(limit);
      return db.all<TaskRow>(`${TASK_SELECT} ${where} ORDER BY task.rowid${page}`, ...params);
    },

    // Newest change first; `ids` picks Tasks whatever their depth.
    listTaskSummaries({ top, ids }: { top?: boolean; ids?: string[] } = {}): TaskSummary[] {
      const where = ids
        ? `t.id IN (${ids.map(() => '?').join(', ')})`
        : top
          ? 't.parent_id IS NULL'
          : '1 = 1';
      return db.all<TaskSummary>(
        `SELECT t.id, t.project_id, t.title, t.state, t.reason, t.source_json,
                t.role_id, t.tier_override, t.login_id,
                COALESCE(t.tier_override, json_extract(t.review_of_json, '$.tier'), r.default_tier) AS tier,
                CASE WHEN t.tier_override IS NOT NULL AND t.tier_escalated = 1 THEN 'escalated'
                     WHEN t.tier_override IS NOT NULL THEN 'override'
                     WHEN json_extract(t.review_of_json, '$.tier') IS NOT NULL THEN 'reviewed'
                     WHEN r.id IS NOT NULL THEN 'default' END AS tier_source,
                COALESCE(MAX(c.at), t.created_at) AS updated_at
         FROM task t
         LEFT JOIN role r ON r.id = t.role_id
         LEFT JOIN change c ON c.task_id = t.id
         WHERE ${where} GROUP BY t.id ORDER BY updated_at DESC, t.rowid DESC`,
        ...(ids ?? []),
      );
    },

    // In dispatch order. All of them: the first may be waiting for a machine. None of a paused
    // project's (§5): they stay queued and come back with the resume.
    queuedTasks(): TaskRow[] {
      return db.all<TaskRow>(`${TASK_SELECT} WHERE task.state = 'queued' AND ${RUNNING_PROJECT('task.project_id')} ORDER BY task.priority DESC, task.created_at, task.rowid`)
        .filter(({ project_id }) => db.mayWriteProject(project_id));
    },

    listRuns: (taskId: string): RunRow[] => db.all<RunRow>('SELECT * FROM run WHERE task_id = ? ORDER BY rowid', taskId),

    listInputs: (taskId: string): InputRow[] =>
      db.all<InputRow>('SELECT * FROM input WHERE task_id = ? ORDER BY rowid', taskId),

    listApprovals: (taskId: string): ApprovalRow[] =>
      db.all<ApprovalRow>('SELECT * FROM approval WHERE task_id = ? ORDER BY rowid', taskId),

    listApprovalCards({ state }: { state?: string } = {}): ApprovalCard[] {
      if (state !== undefined && !APPROVAL_STATES.includes(state)) throw new InputError(`问题状态不对：${state}`);
      return db.all<ApprovalCard>(
        `SELECT a.*, t.title AS task_title, t.project_id AS project_id FROM approval a JOIN task t ON t.id = a.task_id
         ${state ? 'WHERE a.state = ?' : ''} ORDER BY a.rowid`,
        ...(state ? [state] : []),
      );
    },

    getApprovalCard: (id: string): ApprovalCard | undefined =>
      db.get<ApprovalCard>(
        'SELECT a.*, t.title AS task_title, t.project_id AS project_id FROM approval a JOIN task t ON t.id = a.task_id WHERE a.id = ?',
        id,
      ),

    getProject(id: string): ProjectRow {
      const project = db.get<ProjectRow>('SELECT * FROM project WHERE id = ?', id);
      if (!project) throw new InputError(`项目不存在：${id}`);
      return project;
    },

    listProjects: (): ProjectRow[] => db.all<ProjectRow>('SELECT * FROM project ORDER BY rowid'),

    // Whether a project is held back (§5): paused, or archived. A Task of no project, a
    // knowledge one, never is.
    projectPaused: (projectId: string | null): boolean => projectStoppedIn(db, projectId) !== null,

    // Which hold it is, for the sentences that have to say why nothing starts.
    projectStopped: (projectId: string | null): 'paused' | 'archived' | null => projectStoppedIn(db, projectId),

    // The owner's switch, in effect at once (§5). What is running finishes; nothing new starts
    // until the resume. Setting it to what it already is changes and records nothing.
    setProjectPaused(id: string, paused: boolean, ctx: Ctx): ProjectRow {
      return write(() => {
        const project = db.get<ProjectRow>('SELECT * FROM project WHERE id = ?', id);
        if (!project) throw new InputError(`项目不存在：${id}`);
        if ((project.paused_at !== null) === paused) return project;
        const at = paused ? nowIso() : null;
        db.run('UPDATE project SET paused_at = ? WHERE id = ?', at, id);
        writeChange(db, paused ? 'project.pause' : 'project.resume', ctx, {}, { project_id: id });
        return { ...project, paused_at: at };
      });
    },

    // Putting a project away, and taking it out again (project-sessions, "项目的生命周期").
    // Nothing of it changes but this mark: its tasks, messages and records stay as they are,
    // and a pause it had before is still there after the restore.
    setProjectArchived(id: string, archived: boolean, ctx: Ctx): ProjectRow {
      return write(() => {
        const project = db.get<ProjectRow>('SELECT * FROM project WHERE id = ?', id);
        if (!project) throw new InputError(`项目不存在：${id}`);
        if ((project.archived_at !== null) === archived) return project;
        const at = archived ? nowIso() : null;
        db.run('UPDATE project SET archived_at = ? WHERE id = ?', at, id);
        writeChange(db, archived ? 'project.archive' : 'project.unarchive', ctx, {}, { project_id: id });
        return { ...project, archived_at: at };
      });
    },
  };
}
