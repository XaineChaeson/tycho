// The chat front desk (docs/design/project-sessions.md §2): which project the owner's words go
// to, decided by fixed phrases and by what the ledger says about the objects named — never by
// reading the text for its meaning. What it cannot place is kept as waiting for a project and put
// to the owner; the owner's choice gives it the project, makes that the chat's current project
// and lets the Router take it, in one transaction.
import type { Ctx, Db } from './db.ts';
import { nowIso, writeChange } from './db.ts';
import { InputError } from './errors.ts';
import { ulid } from './ids.ts';
import { projectStoppedIn, type MessageRow } from './messages.ts';
import { ACTION_TEXT, ALL_PROJECTS_ARCHIVED_TEXT, PROJECT_ARCHIVED_TEXT, PROJECT_PAUSED_LABEL, PROJECT_PAUSED_TEXT } from '../shared/labels.ts';
import { NO_ROLE_REASON } from '../shared/roles.ts';
import { NEEDS_PASS_TEXT, REVIEW_IN_PROGRESS_TEXT, reviewHeldGateText, type VerdictRecord } from '../shared/review.ts';
import { parseReviewOf, productStale, roundCode, roundSourceOf, type CodeSource, type Product, type RoundArtifacts } from './review.ts';
import { readRecordedReport } from './run-report.ts';
import { createKnowledge, DEFAULT_KNOWLEDGE_LIMITS } from './knowledge.ts';

// What a choice or an answer is typed with: the end of the id, its random part.
const CODE_CHARS = 4;
export const shortCode = (id: string): string => id.slice(-CODE_CHARS).toUpperCase();

// Why a message waits: no current project, the project named and an object named disagree,
// objects of several projects, or a name more than one project has.
type CandidateReason = 'none' | 'conflict' | 'objects' | 'name';
export interface Candidates {
  reason: CandidateReason;
  projects: string[];
}

// What the owner typed, by the fixed phrases only; anything else is a message.
type Said =
  | { kind: 'enter'; name: string; spaced: boolean }
  | { kind: 'projects'; query?: string }
  | { kind: 'projectPicker' }
  | { kind: 'newTopic' }
  | { kind: 'choose'; code: string; pick: string; all: boolean }
  | { kind: 'answer'; code: string; text: string }
  | { kind: 'accept'; code: string; basis: string }
  | { kind: 'resume'; code: string }
  | { kind: 'knowledge'; decision: 'approve' | 'reject'; code: string; note: string }
  | { kind: 'message'; prefix?: string };

// Match complete requests, so discussing project switching still reaches the project.
const PICK_PROJECT = /^(?:(?:你好[，,\s]*)?(?:我想|我要|我能|可以|能不能|能否|可不可以|请|麻烦)?(?:帮我|给我)?(?:切换(?:一下)?(?:个|一个)?|换(?:个|一个)?|选择(?:个|一个)?|选(?:个|一个)?)项目(?:吧|吗|嘛)?|(?:请|帮我|给我)?(?:看看|看一下|列出|显示|打开)(?:一下)?(?:可选)?项目(?:列表)?|(?:现在|我)?(?:还有|都)?有哪些(?:可选)?项目(?:可以选|能选|可选|可切换)?)[。！!？?\s]*$/;
const CODE = '[0-9A-Za-z]{4,26}';
const OBJECT_ID = /(?<![0-9A-Za-z])[0-9A-HJKMNP-TV-Z]{26}(?![0-9A-Za-z])/gi;

function readSaid(text: string): Said {
  const line = text.trim();
  if (line === '项目') return { kind: 'projects' };
  const search = /^项目\s+(\S.*)$/.exec(line);
  if (search) return { kind: 'projects', query: search[1]!.trim() };
  if (PICK_PROJECT.test(line)) return { kind: 'projectPicker' };
  if (line === '新话题') return { kind: 'newTopic' };
  const enter = /^进入(\s*)(\S[^\n]*)$/.exec(line);
  if (enter) return { kind: 'enter', name: enter[2]!.trim(), spaced: enter[1]!.length > 0 };
  const choose = new RegExp(`^(全?)归\\s+(${CODE})\\s+(\\S[^\\n]*)$`).exec(line);
  if (choose) return { kind: 'choose', all: choose[1] === '全', code: choose[2]!, pick: choose[3]!.trim() };
  const answer = new RegExp(`^答\\s+(${CODE})\\s+(\\S[\\s\\S]*)$`).exec(line);
  if (answer) return { kind: 'answer', code: answer[1]!, text: answer[2]!.trim() };
  const accept = new RegExp(`^验\\s+(${CODE})(?:\\s+(\\S[\\s\\S]*))?$`).exec(line);
  if (accept) return { kind: 'accept', code: accept[1]!, basis: accept[2]?.trim() ?? '' };
  const resume = new RegExp(`^继\\s+(${CODE})$`).exec(line);
  if (resume) return { kind: 'resume', code: resume[1]! };
  const approveKnowledge = new RegExp(`^同意知识\\s+(${CODE})$`).exec(line);
  if (approveKnowledge) return { kind: 'knowledge', decision: 'approve', code: approveKnowledge[1]!, note: '' };
  const rejectKnowledge = new RegExp(`^驳回知识\\s+(${CODE})(?:\\s+(\\S[\\s\\S]*))?$`).exec(line);
  if (rejectKnowledge) return { kind: 'knowledge', decision: 'reject', code: rejectKnowledge[1]!, note: rejectKnowledge[2]?.trim() ?? '' };
  // The whole name before the colon, however long: a project's name has no limit of its own.
  const prefix = /^([^\n：:]+)[：:]/.exec(line);
  return prefix ? { kind: 'message', prefix: prefix[1]!.trim() } : { kind: 'message' };
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export type FrontChannel = 'wecom' | 'weixin';

interface FrontInput {
  channel?: FrontChannel;
  bot: string;
  externalId: string;
  actor: string;
  // The chat: a group's id, or the sender's own in a single chat.
  thread: string;
  text: string;
  // Forwarded or quoted: material, read for nothing (§2).
  material: boolean;
  // An adapter's explicit control choice; the original text remains the message.
  selection?: { projectId: string | null; fixed: boolean; messageId?: string };
  // Project file ids attached to this message.
  attachmentIds?: readonly string[];
  // External message id this message replies to / quotes (from IM channel).
  replyToExternalId?: string | null;
  // Explicit group-bound project id: skip unassigned guessing and route directly here.
  forcedProjectId?: string | null;
}

interface FrontReceived {
  id: string;
  state: MessageRow['state'];
  // Written now, not a redelivery of one already here.
  fresh: boolean;
  projectMenu?: { query: string };
  // Messages a choice made takeable: the Router's to be told about.
  released: string[];
}

interface Deps {
  enqueue(kind: string, payload: object, channel: FrontChannel): void;
  whitelisted(actor: string, channel: FrontChannel): boolean;
  newTopic(projectId: string, ctx: Ctx): void;
  answerApproval(id: string, answers: string[], actor: string, via: string, messageId?: string): { status: string };
  acceptTask?: (taskId: string, basis: string, ctx: Ctx) => void;
  resumeTask?: (taskId: string, ctx: Ctx) => void;
  decideProposal?: (proposalId: string, decision: { decision: 'approve' | 'reject'; digest: string; note?: string; via: string }, ctx: Ctx) => { state: string };
}

interface ProjectLine {
  id: string;
  name: string;
  paused_at: string | null;
  // Archived ones are out of the list and out of every way of choosing one. A message that
  // names an object in one still goes there.
  archived_at: string | null;
}

export function createFrontDesk(db: Db, write: <T>(fn: () => T) => T, deps: Deps) {
  const projects = (): ProjectLine[] => db.all<ProjectLine>('SELECT id, name, paused_at, archived_at FROM project ORDER BY rowid');
  // The ones the owner can see and switch to: archived is out of sight until restored.
  const openProjects = (): ProjectLine[] => projects().filter(({ id, archived_at }) => archived_at === null && db.mayWriteProject(id));
  // Why there is no project to show or enter is not always "there are none": every project
  // may be archived, which is a different thing for the owner to do about.
  const noOpenProjects = (): string => projects().length > 0 && projects().every(({ archived_at }) => archived_at !== null)
    ? ALL_PROJECTS_ARCHIVED_TEXT
    : '还没有项目：先到控制台新建一个';
  const stopped = (projectId: string): 'paused' | 'archived' | null => projectStoppedIn(db, projectId);
  const order = (ids: Iterable<string>): string[] => {
    const wanted = new Set(ids);
    return projects().map(({ id }) => id).filter((id) => wanted.has(id));
  };
  const nameOf = (projectId: string): string => db.get<{ name: string }>('SELECT name FROM project WHERE id = ?', projectId)?.name ?? projectId;

  function fixed(bot: string, chat: string): string | null {
    const id = db.get<{ project_id: string }>("SELECT project_id FROM front_desk WHERE bot = ? AND chat = ? AND sender = ?", bot, chat, '')?.project_id ?? null;
    return db.mayWriteProject(id) ? id : null;
  }

  function current(bot: string, chat: string, sender: string): string | null {
    const binding = fixed(bot, chat);
    if (binding) return stopped(binding) === 'archived' ? null : binding;
    const row = db.get<{ project_id: string | null }>(
      `SELECT f.project_id FROM front_desk f JOIN project p ON p.id = f.project_id WHERE f.bot = ? AND f.chat = ? AND f.sender = ? AND p.archived_at IS NULL`,
      bot, chat, sender,
    );
    const id = row?.project_id ?? null;
    return db.mayWriteProject(id) ? id : null;
  }

  function setCurrent(bot: string, chat: string, sender: string, projectId: string, ctx: Ctx): void {
    const from = current(bot, chat, sender);
    if (from === projectId) return;
    const at = nowIso();
    db.run(
      `INSERT INTO front_desk (id, created_at, updated_at, bot, chat, sender, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot, chat, sender) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at`,
      ulid(), at, at, bot, chat, sender, projectId,
    );
    writeChange(db, 'front.current', ctx, {}, { bot, chat, sender, project_id: projectId, from });
  }

  function bind(bot: string, thread: string, projectId: string | null, ctx: Ctx): void {
    const from = fixed(bot, thread);
    db.run('DELETE FROM front_desk WHERE bot = ? AND chat = ?', bot, thread);
    if (projectId) setCurrent(bot, thread, '', projectId, ctx);
    writeChange(db, 'front.bind', ctx, {}, { bot, chat: thread, from, project_id: projectId });
  }

  // The projects of the Tasks and Runs the text names, as the ledger has them.
  function objectProjects(text: string): string[] {
    const found = new Set<string>();
    for (const id of new Set((text.match(OBJECT_ID) ?? []).map((each) => each.toUpperCase()))) {
      const owner = db.get<{ project_id: string | null }>('SELECT project_id FROM task WHERE id = ?', id)
        ?? db.get<{ project_id: string | null }>('SELECT t.project_id FROM run r JOIN task t ON t.id = r.task_id WHERE r.id = ?', id);
      if (owner?.project_id && db.mayWriteProject(owner.project_id)) found.add(owner.project_id);
    }
    return order(found);
  }

  const target = (thread: string, actor: string) => ({ chatid: thread, chat_type: thread === actor ? 1 : 2 });

  function reply(id: string, input: { thread: string; actor: string; channel?: FrontChannel }, content: string, place: { projectId?: string | null; path?: string } = {}): void {
    deps.enqueue('markdown', {
      external_id: `front:${id}`,
      target: target(input.thread, input.actor),
      content,
      project_id: place.projectId ?? null,
      path: place.path ?? (place.projectId ? `/projects/${place.projectId}` : '/'),
    }, input.channel ?? 'wecom');
  }

  function committedText(messageId: string): string {
    const done = db.all<{ action: string }>('SELECT action FROM change WHERE message_id = ? ORDER BY seq', messageId)
      .map(({ action }) => ACTION_TEXT[action] ?? action);
    return done.length > 0 ? `已提交的操作：${done.join('、')}` : '没有已提交的操作';
  }

  interface DeskTaskRow {
    id: string;
    project_id: string | null;
    title: string;
    state: string;
    revision: number;
    role_id: string | null;
    source_json: string | null;
    review_of_json: string | null;
    verdict_json: string | null;
    reason: string | null;
  }

  interface DeskRunRow {
    id: string;
    task_id: string;
    snapshot_json: string;
    receipt_json: string | null;
    error_json: string | null;
    artifacts_json: string | null;
  }

  function taskProductOf(task: DeskTaskRow): Product {
    const run = db.get<DeskRunRow>(
      'SELECT id, task_id, snapshot_json, receipt_json, error_json, artifacts_json FROM run WHERE task_id = ? ORDER BY rowid DESC LIMIT 1',
      task.id,
    );
    const snapshot = run === undefined ? undefined : (JSON.parse(run.snapshot_json) as { role?: { needs_review?: boolean; deliverable?: string } });
    const isFinalReport = snapshot?.role?.deliverable === 'report' && (() => {
      try {
        const receipt = run?.receipt_json ? (JSON.parse(run.receipt_json) as { artifacts?: { kind?: unknown; ref?: unknown }[] }) : null;
        return Array.isArray(receipt?.artifacts) && receipt.artifacts.some((a) => a?.kind === 'report' && a?.ref === 'final_message');
      } catch {
        return false;
      }
    })();
    const report = run && isFinalReport ? readRecordedReport(db, run) : undefined;
    const files = run?.artifacts_json ? ((JSON.parse(run.artifacts_json) as RoundArtifacts).registration?.files ?? null) : null;
    let pinned: CodeSource | null = null;
    if (task.source_json) {
      try {
        const parsed = JSON.parse(task.source_json) as { pinned?: { kind?: string; url?: string; path?: string } | null };
        if (parsed.pinned?.kind === 'repo' && typeof parsed.pinned.url === 'string') {
          pinned = { source_kind: 'repo', url: parsed.pinned.url };
        } else if (parsed.pinned?.kind === 'folder' && typeof parsed.pinned.path === 'string') {
          pinned = { source_kind: 'folder', path: parsed.pinned.path };
        }
      } catch {
        pinned = null;
      }
    }
    return {
      runId: run?.id ?? null,
      revision: task.revision,
      files,
      needsReview: snapshot?.role?.needs_review === true,
      reviewed: run === undefined ? null : roundCode(run, roundSourceOf(run)),
      ...(run && isFinalReport
        ? { report: report ? { id: report.id, sha256: report.sha256, bytes: report.bytes, complete: report.complete } : null }
        : {}),
      pinned,
    };
  }

  function taskReviewCheck(task: DeskTaskRow): { blocked: string | null; sameExecutor?: string } {
    const product = taskProductOf(task);
    if (!product.needsReview) return { blocked: null };
    const reviews = db.all<DeskTaskRow>(
      `SELECT id, project_id, title, state, revision, role_id, source_json, review_of_json, verdict_json, reason
       FROM task WHERE json_extract(review_of_json, '$.task_id') = ? ORDER BY rowid`,
      task.id,
    );
    const passes: { binding: NonNullable<ReturnType<typeof parseReviewOf>>; verdict: VerdictRecord }[] = [];
    for (const review of reviews) {
      if (review.verdict_json === null) continue;
      const verdict = JSON.parse(review.verdict_json) as VerdictRecord;
      const binding = parseReviewOf(review.review_of_json);
      if (verdict.result === 'pass' && binding !== null) passes.push({ binding, verdict });
    }
    const validPasses = passes.filter(({ binding }) => productStale(binding, product) === null);
    if (validPasses.length > 0) {
      const executors = validPasses.map(({ verdict }) => verdict.same_executor);
      const sameExecutor = executors.every((ex) => ex !== undefined) ? executors[0] : undefined;
      return sameExecutor === undefined ? { blocked: null } : { blocked: null, sameExecutor };
    }
    const active = reviews.filter((review) => {
      if (review.state === 'done' || review.state === 'abandoned') return false;
      const binding = parseReviewOf(review.review_of_json);
      return binding !== null && productStale(binding, product) === null;
    }).at(-1);
    if (active) {
      const blocked = active.state === 'held' || active.state === 'waiting_person'
        ? reviewHeldGateText(active.reason)
        : REVIEW_IN_PROGRESS_TEXT;
      return { blocked };
    }
    const stale = passes.map(({ binding }) => productStale(binding, product)).filter((why): why is string => why !== null);
    return { blocked: stale.length > 0 ? `${NEEDS_PASS_TEXT}（有过的“通过”已经不算：${stale.at(-1)}）` : NEEDS_PASS_TEXT };
  }

  const knowledgeDesk = createKnowledge(db, (fn) => fn(), {
    limits: () => DEFAULT_KNOWLEDGE_LIMITS,
    enqueue: (ch, kind, payload) => deps.enqueue(kind, payload as object, ch === 'weixin' ? 'weixin' : 'wecom'),
    createTask: () => { throw new InputError('前台不支持创建知识任务'); },
    endTask: () => {},
    afterPublish: () => {},
  });

  // Inside a write. All of them or none: one already taken stays where it was taken.
  function choose(bot: string, messageId: string, projectId: string, all: boolean, ctx: Ctx, channel: FrontChannel): string[] {
    if (!openProjects().some(p => p.id === projectId)) throw new InputError('项目不存在或已归档');
    const chosen = db.get<MessageRow>(`SELECT * FROM message WHERE id = ? AND channel = ? AND direction = 'in'`, messageId, channel);
    if (!chosen) throw new InputError(`消息不存在：${messageId}`);
    const others = all
      ? db.all<MessageRow>(`SELECT * FROM message WHERE channel = ? AND direction = 'in' AND state = 'unassigned' AND thread IS ? AND actor IS ? AND id != ? ORDER BY rowid`, channel, chosen.thread, chosen.actor, chosen.id)
      : [];
    const rows = [chosen, ...others];
    const taken = rows.find((row) => row.state !== 'unassigned' && row.state !== 'received');
    if (taken) {
      const where = taken.project_id ? `【${nameOf(taken.project_id)}】` : '';
      throw new InputError(`这条消息已经被${where}的负责人取走，按原来的归属处理，不搬到别的项目重做。${committedText(taken.id)}`);
    }
    for (const row of rows) {
      db.run(`UPDATE message SET project_id = ?, basis = 'owner', state = 'received', segment_id = NULL WHERE id = ?`, projectId, row.id);
      writeChange(db, 'message.assign', ctx, {}, { message_id: row.id, project_id: projectId, from: row.project_id });
    }
    const binding = fixed(bot, chosen.thread ?? chosen.actor!);
    if (binding && binding !== projectId) throw new InputError('这个聊天已固定到其他项目，请先换绑');
    setCurrent(bot, chosen.thread ?? chosen.actor!, chosen.actor!, projectId, ctx);
    return rows.map(({ id }) => id);
  }

  return {
    frontCurrent: current,
    frontFixed: fixed,
    // Read-only mirror of frontReceive's project routing (including prefix, task/run object
    // references, fixed binding, and enter/command phrasing) so attachment persistence lands
    // in the exact same project that frontReceive will route the message to.
    frontResolveProject(input: { bot: string; thread: string; actor: string; text: string; material: boolean }): string | null {
      const resolveOrdinary = (prefix: string | undefined, material: boolean): string | null => {
        const fixedProject = fixed(input.bot, input.thread);
        if (fixedProject && stopped(fixedProject) === 'archived') return null;
        const here = current(input.bot, input.thread, input.actor);
        if (material) return here;
        const named = prefix === undefined ? [] : openProjects().filter((p) => sameName(p.name, prefix)).map((p) => p.id);
        const objects = objectProjects(input.text);
        if (fixedProject && (named.some((p) => p !== fixedProject) || objects.some((p) => p !== fixedProject))) return null;
        if (fixedProject) return fixedProject;
        if (named.length > 1) return null;
        if (named.length === 1) {
          const [explicit] = named as [string];
          if (objects.some((each) => each !== explicit)) return null;
          return explicit;
        }
        if (objects.length > 1) return null;
        if (objects.length === 1) return objects[0]!;
        return here;
      };
      if (input.material) return resolveOrdinary(undefined, true);
      const said = readSaid(input.text);
      if (said.kind === 'message') return resolveOrdinary(said.prefix, false);
      if (said.kind === 'enter') {
        const matched = openProjects().filter((p) => sameName(p.name, said.name) || p.id === said.name.toUpperCase());
        if (matched.length === 0 && !said.spaced) return resolveOrdinary(undefined, false);
      }
      return null;
    },
    frontSelect(fields: { bot: string; thread: string; actor: string; projectId: string; channel?: FrontChannel }): void {
      write(() => {
        if (!fields.actor || !fields.thread || !fields.bot || !deps.whitelisted(fields.actor, fields.channel ?? 'wecom')) throw new InputError('无权操作');
        if (!openProjects().some(p => p.id === fields.projectId)) throw new InputError('项目不存在或已归档');
        if (fixed(fields.bot, fields.thread)) throw new InputError('这个聊天已固定项目，请先换绑或解绑');
        setCurrent(fields.bot, fields.thread, fields.actor, fields.projectId, { actor: fields.actor });
      });
    },
    frontProjects: (bot: string, thread: string, actor: string) => {
      const recent = db.all<{ project_id: string }>(`SELECT project_id FROM front_desk WHERE bot = ? AND (sender = ? OR (chat = ? AND sender = '')) AND project_id IS NOT NULL ORDER BY updated_at DESC`, bot, actor, thread);
      const rank = new Map<string, number>();
      for (const row of recent) if (!rank.has(row.project_id)) rank.set(row.project_id, rank.size);
      return openProjects().sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    },
    frontBind(fields: { bot: string; thread: string; actor: string; projectId: string | null; channel?: FrontChannel }): void {
      write(() => {
        if (!fields.actor || !fields.thread || !fields.bot || !deps.whitelisted(fields.actor, fields.channel ?? 'wecom')) throw new InputError('无权操作');
        if (fields.projectId && !openProjects().some(p => p.id === fields.projectId)) throw new InputError('项目不存在或已归档');
        bind(fields.bot, fields.thread, fields.projectId, { actor: fields.actor });
      });
    },

    // A press on the card that put a message to the owner, or the console giving the chat's
    // waiting messages a project the same way.
    frontChoose(fields: { bot: string; messageId: string; projectId: string; actor: string; all?: boolean; channel?: FrontChannel }): { ids: string[]; projectId: string } {
      return write(() => ({ ids: choose(fields.bot, fields.messageId, fields.projectId, fields.all ?? false, { actor: fields.actor }, fields.channel ?? 'wecom'), projectId: fields.projectId }));
    },

    frontReceive(input: FrontInput): FrontReceived {
      const channel = input.channel ?? 'wecom';
      return write((): FrontReceived => {
        const known = db.get<MessageRow>(
          `SELECT * FROM message WHERE channel = ? AND external_id = ?`, channel, input.externalId,
        );
        if (known) {
          // A committed picker may have crashed before its transport saved the menu.
          // Rebuild only that read-only view, from the recorded command. A Router-owned
          // message has a segment and forwarded material is never a command.
          const said = !input.forcedProjectId && !input.material && known.state === 'processed' && known.segment_id === null
            && known.actor === input.actor && known.thread === input.thread && deps.whitelisted(input.actor, channel)
            ? readSaid(known.text) : undefined;
          return { id: known.id, state: known.state, fresh: false, released: [],
            ...(said?.kind === 'projectPicker' || said?.kind === 'projects' ? { projectMenu: { query: said.kind === 'projects' ? said.query ?? '' : '' } } : {}),
          };
        }
        const id = ulid();
        const at = nowIso();
        const record = (state: NonNullable<MessageRow['state']>, fields: { projectId?: string | null; basis?: string | null; candidates?: Candidates } = {}): FrontReceived => {
          const uniqueAttachments = fields.projectId && input.attachmentIds && input.attachmentIds.length > 0
            ? [...new Set(input.attachmentIds)]
            : null;
          db.run(
            `INSERT INTO message (id, created_at, channel, external_id, thread, direction, actor, text, state, at, project_id, basis, candidates_json, attachments_json, reply_to_external_id)
             VALUES (?, ?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, at, channel, input.externalId, input.thread, input.actor, input.text, state, at,
            fields.projectId ?? null, fields.basis ?? null, fields.candidates ? JSON.stringify(fields.candidates) : null,
            uniqueAttachments ? JSON.stringify(uniqueAttachments) : null,
            input.replyToExternalId ?? null,
          );
          if (fields.projectId && uniqueAttachments) {
            const marks = uniqueAttachments.map(() => '?').join(', ');
            db.run(
              `UPDATE project_file SET message_id = ? WHERE project_id = ? AND id IN (${marks}) AND message_id IS NULL`,
              id, fields.projectId, ...uniqueAttachments,
            );
          }
          writeChange(db, 'message.receive', { actor: input.actor }, {}, {
            message_id: id, channel, state,
            ...(fields.projectId ? { project_id: fields.projectId, basis: fields.basis } : {}),
          });
          return { id, state, fresh: true, released: [] };
        };
        // Into a project that is paused or archived the message is kept as any other, and the
        // owner is told at once why no answer comes (project-sessions §5): its Router takes
        // nothing until the restore.
        const deliver = (projectId: string, basis: 'current' | 'owner' | 'object') => {
          const received = record('received', { projectId, basis });
          const held = stopped(projectId);
          if (held !== null) {
            const why = held === 'archived' ? `${PROJECT_ARCHIVED_TEXT}：这条消息记下了，恢复后处理` : `${PROJECT_PAUSED_TEXT}：这条消息记下了，恢复后处理`;
            reply(id, input, why, { projectId, path: `/projects/${projectId}/settings` });
          }
          return received;
        };
        if (input.forcedProjectId) {
          const boundProject = db.get<ProjectLine>('SELECT id, name, paused_at, archived_at FROM project WHERE id = ?', input.forcedProjectId);
          if (!boundProject || !db.mayWriteProject(boundProject.id)) return record('ignored');
          return deliver(boundProject.id, 'current');
        }
        const ctx: Ctx = { actor: input.actor, messageId: id };
        if (!deps.whitelisted(input.actor, channel)) return record('ignored');

        if (input.selection && !input.material) {
          const done = record('processed');
          const selection = input.selection;
          try {
            const released = db.savepoint(() => {
              if (selection.projectId !== null && !openProjects().some(p => p.id === selection.projectId)) throw new InputError('项目不存在或已归档');
              if (selection.projectId !== null && !selection.fixed && fixed(input.bot, input.thread)) throw new InputError('这个聊天已固定项目，请先解绑后再切换');
              if (selection.messageId && !db.get('SELECT id FROM message WHERE id = ? AND channel = ? AND direction = ? AND thread IS ? AND actor IS ?', selection.messageId, channel, 'in', input.thread, input.actor)) {
                throw new InputError(`消息不存在：${selection.messageId}`);
              }
              if (selection.fixed || selection.projectId === null) bind(input.bot, input.thread, selection.projectId, ctx);
              if (selection.projectId === null) return [];
              if (selection.messageId) return choose(input.bot, selection.messageId, selection.projectId, false, ctx, channel);
              if (!selection.fixed) setCurrent(input.bot, input.thread, input.actor, selection.projectId, ctx);
              return [];
            });
            reply(id, input, selection.projectId === null ? '已解绑：可以重新选择项目' : selection.fixed ? '已固定到这个项目：之后在这里说的话都交给它' : '已切换到这个项目：之后在这里说的话都交给它', { projectId: selection.projectId });
            return { ...done, released };
          } catch (error) {
            if (!(error instanceof InputError)) throw error;
            reply(id, input, error.message);
            return done;
          }
        }

        const here = current(input.bot, input.thread, input.actor);
        const waitFor = (reason: CandidateReason, ids: string[]): FrontReceived => {
          const received = record('unassigned', { candidates: { reason, projects: order(ids) } });
          deps.enqueue('assign', { external_id: `assign:${id}`, message_id: id, target: target(input.thread, input.actor) }, channel);
          return received;
        };
        const ordinary = (prefix: string | undefined, material: boolean): FrontReceived => {
          const fixedProject = fixed(input.bot, input.thread);
          if (fixedProject && stopped(fixedProject) === 'archived') return waitFor('none', openProjects().map((p) => p.id));
          if (material) return here ? deliver(here, 'current') : waitFor('none', openProjects().map((p) => p.id));
          const named = prefix === undefined ? [] : openProjects().filter((p) => sameName(p.name, prefix)).map((p) => p.id);
          const objects = objectProjects(input.text);
          const binding = fixed(input.bot, input.thread);
          if (binding && (named.some(p => p !== binding) || objects.some(p => p !== binding))) {
            const done = record('processed');
            reply(id, input, '这个聊天已固定到其他项目，请先换绑后再发送');
            return done;
          }
          if (binding) return deliver(binding, 'current');
          if (named.length > 1) return waitFor('name', named);
          if (named.length === 1) {
            const [explicit] = named as [string];
            if (objects.some((each) => each !== explicit)) return waitFor('conflict', [explicit, ...objects]);
            const received = deliver(explicit, 'owner');
            setCurrent(input.bot, input.thread, input.actor, explicit, ctx);
            return received;
          }
          if (objects.length > 1) return waitFor('objects', objects);
          if (objects.length === 1) return deliver(objects[0]!, 'object');
          if (here) return deliver(here, 'current');
          return waitFor('none', openProjects().map((p) => p.id));
        };

        if (input.material) return ordinary(undefined, true);
        const said = readSaid(input.text);
        const command = (projectId: string | null = null): FrontReceived => record('processed', { projectId, basis: projectId ? 'object' : null });
        switch (said.kind) {
          case 'message':
            return ordinary(said.prefix, false);

          case 'enter': {
            const all = openProjects();
            const matched = all.filter((p) => sameName(p.name, said.name) || p.id === said.name.toUpperCase());
            // "进入下一步……" names no project: an ordinary message, not a phrase misread.
            if (matched.length === 0 && !said.spaced) return ordinary(undefined, false);
            const done = command();
            if (fixed(input.bot, input.thread)) {
              reply(id, input, '这个聊天已固定项目，请用项目卡片换绑');
            } else if (matched.length === 1) {
              const [project] = matched as [ProjectLine];
              setCurrent(input.bot, input.thread, input.actor, project.id, ctx);
              reply(id, input, `已进入：之后在这里说的话都交给这个项目的负责人。说“项目”看全部项目，说“进入 <项目名>”换一个`, { projectId: project.id });
            } else if (matched.length > 1) {
              reply(id, input, `有 ${matched.length} 个项目叫“${said.name}”，用编号进入：\n${matched.map((p) => `- 进入 ${p.id}`).join('\n')}`);
            } else {
              const names = all.map((p) => `- ${p.name}`).join('\n');
              reply(id, input, all.length > 0 ? `没有叫“${said.name}”的项目。现有的项目：\n${names}` : noOpenProjects(), { path: '/projects' });
            }
            return done;
          }

          case 'projectPicker':
            return { ...command(), projectMenu: { query: '' } };

          case 'projects': {
            const done = command();
            const lines = openProjects().filter(p => !said.query || p.name.toLowerCase().includes(said.query.toLowerCase())).map((p) => {
              const running = db.get<{ n: number }>(`SELECT count(*) AS n FROM task WHERE project_id = ? AND state IN ('running', 'stopping')`, p.id)!.n;
              const asked = db.get<{ n: number }>(`SELECT count(*) AS n FROM approval a JOIN task t ON t.id = a.task_id WHERE t.project_id = ? AND a.state = 'open'`, p.id)!.n;
              return `- ${p.name}${p.id === here ? '（当前）' : ''}${p.paused_at === null ? '' : `（${PROJECT_PAUSED_LABEL}）`}：在跑 ${running}，待答 ${asked}`;
            });
            reply(id, input, lines.length > 0 ? `全部项目：\n${lines.join('\n')}\n\n说“进入 <项目名>”换当前项目` : said.query && openProjects().length ? '没有匹配的项目' : noOpenProjects(), { path: '/projects' });
            return { ...done, projectMenu: { query: said.query ?? '' } };
          }

          case 'newTopic': {
            const done = command(here);
            if (here === null) {
              reply(id, input, '这个聊天还没有当前项目：先说“进入 <项目名>”');
            } else {
              deps.newTopic(here, ctx);
              reply(id, input, '已开新话题：之前的对话留作历史，接下来从账本里的任务和知识接着做', { projectId: here });
            }
            return done;
          }

          case 'choose': {
            const done = command();
            const code = said.code.toUpperCase();
            const asked = db.all<MessageRow>(
              `SELECT * FROM message WHERE channel = ? AND direction = 'in' AND candidates_json IS NOT NULL AND thread IS ? AND actor IS ? ORDER BY rowid`,
              channel, input.thread, input.actor,
            ).filter((row) => row.id.endsWith(code));
            if (asked.length !== 1) {
              reply(id, input, asked.length === 0 ? `找不到编号 ${code} 的待归属消息` : `编号 ${code} 对上不止一条消息：到控制台的“对话”页归属`);
              return done;
            }
            const [message] = asked as [MessageRow];
            const offered = (JSON.parse(message.candidates_json!) as Candidates).projects;
            let projectId: string | undefined;
            if (/^\d+$/.test(said.pick)) {
              projectId = offered[Number(said.pick) - 1];
              if (projectId === undefined) {
                reply(id, input, `没有第 ${said.pick} 个候选：这条消息的候选只有 ${offered.length} 个`);
                return done;
              }
            } else {
              const named = openProjects().filter((p) => sameName(p.name, said.pick));
              if (named.length !== 1) {
                reply(id, input, named.length === 0 ? `没有叫“${said.pick}”的项目` : `有几个项目叫“${said.pick}”：用候选的序号`);
                return done;
              }
              projectId = named[0]!.id;
            }
            try {
              const ids = db.savepoint(() => choose(input.bot, message.id, projectId, said.all, ctx, channel));
              reply(id, input, `已归到这个项目：${ids.length} 条消息交给它的负责人，之后在这里说的话也交给它`, { projectId });
              return { ...done, released: ids };
            } catch (err) {
              if (!(err instanceof InputError)) throw err;
              reply(id, input, err.message);
              return done;
            }
          }

          case 'answer': {
            const code = said.code.toUpperCase();
            const open = db.all<{ id: string; questions_json: string; project_id: string | null }>(
              `SELECT a.id, a.questions_json, t.project_id FROM approval a JOIN task t ON t.id = a.task_id WHERE a.state = 'open' ORDER BY a.rowid`,
            ).filter((row) => row.id.endsWith(code));
            if (open.length !== 1) {
              const done = command();
              reply(id, input, open.length === 0 ? `找不到编号 ${code} 的待答问题：它可能已经答过或关闭了` : `编号 ${code} 对上不止一个问题：到控制台回答`);
              return done;
            }
            const [approval] = open as [{ id: string; questions_json: string; project_id: string | null }];
            if (!db.mayWriteProject(approval.project_id)) {
              const done = command();
              reply(id, input, '这个问题所属的项目已不在本服务处理，请到项目当前的控制台回答');
              return done;
            }
            const done = command(approval.project_id);
            const questions = JSON.parse(approval.questions_json) as { options?: string[] }[];
            if (questions.length !== 1) {
              reply(id, input, `这个问题有 ${questions.length} 题，要一起答：到控制台回答`, { projectId: approval.project_id });
              return done;
            }
            const options = questions[0]!.options ?? [];
            const picked = /^\d+$/.test(said.text) ? options[Number(said.text) - 1] : undefined;
            try {
              const result = db.savepoint(() => deps.answerApproval(approval.id, [picked ?? said.text], input.actor, channel, id));
              if (result.status === 'closed') reply(id, input, '这个问题已经关闭了，不用再答', { projectId: approval.project_id });
            } catch (err) {
              if (!(err instanceof InputError)) throw err;
              reply(id, input, err.message, { projectId: approval.project_id });
            }
            return done;
          }

          case 'accept': {
            const code = said.code.toUpperCase();
            const ready = db.all<DeskTaskRow>(
              `SELECT id, project_id, title, state, revision, role_id, source_json, review_of_json, verdict_json, reason
               FROM task WHERE state = 'ready' ORDER BY rowid`,
            ).filter((row) => row.id.endsWith(code));
            if (ready.length !== 1) {
              const done = command();
              if (ready.length > 1) {
                reply(id, input, `编号 ${code} 对上不止一个待验收任务：请用更长的编号或到控制台验收`);
              } else {
                const any = db.all<{ id: string; state: string; title: string }>('SELECT id, state, title FROM task ORDER BY rowid')
                  .filter((row) => row.id.endsWith(code));
                if (any.length === 1) {
                  reply(id, input, `任务“${any[0]!.title}”（${shortCode(any[0]!.id)}）当前状态不是待验收（当前：${any[0]!.state}），不能验收`);
                } else {
                  reply(id, input, `找不到编号 ${code} 的待验收任务`);
                }
              }
              return done;
            }
            const [task] = ready as [DeskTaskRow];
            if (!db.mayWriteProject(task.project_id)) {
              const done = command();
              reply(id, input, '这个任务所属的项目已不在本服务处理，请到项目当前的控制台验收');
              return done;
            }
            const done = command(task.project_id);
            const effectiveBasis = said.basis || '主人验收通过';
            try {
              db.savepoint(() => {
                if (deps.acceptTask) {
                  deps.acceptTask(task.id, effectiveBasis, ctx);
                  return;
                }
                const { blocked, sameExecutor } = taskReviewCheck(task);
                if (blocked !== null) throw new InputError(blocked);
                const now = nowIso();
                db.run(`UPDATE approval SET state = 'closed', decided_at = ? WHERE task_id = ? AND state = 'open'`, now, task.id);
                db.run(`UPDATE task SET state = 'done', reason = NULL, wake_at = NULL, closed_at = ? WHERE id = ?`, now, task.id);
                writeChange(db, 'task.accept', ctx, { taskId: task.id }, {
                  basis: effectiveBasis,
                  ...(sameExecutor === undefined ? {} : { same_executor: sameExecutor }),
                });
              });
              reply(id, input, `已验收通过：${task.title}（${shortCode(task.id)}）`, { projectId: task.project_id, path: `/task/${task.id}` });
            } catch (err) {
              if (!(err instanceof InputError)) throw err;
              reply(id, input, err.message, { projectId: task.project_id, path: `/task/${task.id}` });
            }
            return done;
          }

          case 'resume': {
            const code = said.code.toUpperCase();
            const candidates = db.all<DeskTaskRow>(
              `SELECT id, project_id, title, state, revision, role_id, source_json, review_of_json, verdict_json, reason
               FROM task WHERE state IN ('held', 'waiting_person') ORDER BY rowid`,
            ).filter((row) => row.id.endsWith(code));
            if (candidates.length !== 1) {
              const done = command();
              if (candidates.length > 1) {
                reply(id, input, `编号 ${code} 对上不止一个停住的任务：请用更长的编号或到控制台继续`);
              } else {
                const any = db.all<{ id: string; state: string; title: string }>('SELECT id, state, title FROM task ORDER BY rowid')
                  .filter((row) => row.id.endsWith(code));
                if (any.length === 1) {
                  reply(id, input, `任务“${any[0]!.title}”（${shortCode(any[0]!.id)}）当前不在停住状态（当前：${any[0]!.state}），不需要继续`);
                } else {
                  reply(id, input, `找不到编号 ${code} 的停住任务`);
                }
              }
              return done;
            }
            const [task] = candidates as [DeskTaskRow];
            if (!db.mayWriteProject(task.project_id)) {
              const done = command();
              reply(id, input, '这个任务所属的项目已不在本服务处理，请到项目当前的控制台继续');
              return done;
            }
            const done = command(task.project_id);
            try {
              db.savepoint(() => {
                if (deps.resumeTask) {
                  deps.resumeTask(task.id, ctx);
                  return;
                }
                if (task.state === 'waiting_person' && db.get<{ id: string }>(`SELECT id FROM approval WHERE task_id = ? AND state = 'open'`, task.id)) {
                  throw new InputError(`任务 ${task.id} 在等你回答问题，回答后才能继续`);
                }
                if (!task.role_id || !db.get('SELECT 1 FROM role WHERE id = ?', task.role_id)) {
                  throw new InputError(NO_ROLE_REASON);
                }
                if (db.get(`SELECT id FROM run WHERE task_id = ? AND state != 'ended'`, task.id)) {
                  throw new InputError(`任务 ${task.id} 还有未结束的执行轮次，不能继续`);
                }
                db.run(`UPDATE task SET state = 'queued', reason = NULL, wake_at = NULL, closed_at = NULL WHERE id = ?`, task.id);
                writeChange(db, 'task.resume', ctx, { taskId: task.id }, { from: task.state });
              });
              reply(id, input, `已继续任务：${task.title}（${shortCode(task.id)}），已重新排队`, { projectId: task.project_id, path: `/task/${task.id}` });
            } catch (err) {
              if (!(err instanceof InputError)) throw err;
              reply(id, input, err.message, { projectId: task.project_id, path: `/task/${task.id}` });
            }
            return done;
          }

          case 'knowledge': {
            const code = said.code.toUpperCase();
            const waiting = db.all<{ id: string; digest: string; final_digest: string | null }>(
              `SELECT id, digest, final_digest FROM knowledge_proposal WHERE state = 'awaiting_owner' ORDER BY rowid`,
            ).filter((row) => row.id.endsWith(code));
            const done = command();
            if (waiting.length !== 1) {
              reply(
                id,
                input,
                waiting.length === 0
                  ? `找不到编号 ${code} 的待审批知识提议：它可能已经处理过了`
                  : `编号 ${code} 对上不止一条待审批知识提议：请用更长的编号或到控制台处理`,
                { path: '/knowledge' },
              );
              return done;
            }
            const [proposal] = waiting as [{ id: string; digest: string; final_digest: string | null }];
            const digest = proposal.final_digest ?? proposal.digest;
            try {
              const result = db.savepoint(() => {
                const payload = { decision: said.decision, digest, ...(said.note ? { note: said.note } : {}), via: channel };
                return deps.decideProposal
                  ? deps.decideProposal(proposal.id, payload, ctx)
                  : knowledgeDesk.decideProposal(proposal.id, payload, ctx);
              });
              const text = said.decision === 'approve'
                ? (result.state === 'published' ? `已同意并生效知识提议（${shortCode(proposal.id)}）` : `已处理知识提议（${shortCode(proposal.id)}），当前状态：${result.state}`)
                : `已驳回知识提议（${shortCode(proposal.id)}）${said.note ? `：${said.note}` : ''}`;
              reply(id, input, text, { path: `/knowledge/proposals/${proposal.id}` });
            } catch (err) {
              if (!(err instanceof InputError)) throw err;
              reply(id, input, err.message, { path: `/knowledge/proposals/${proposal.id}` });
            }
            return done;
          }
        }
      });
    },
  };
}
