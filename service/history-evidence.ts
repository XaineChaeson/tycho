import { FINAL_MESSAGE_REF, reportInfo, type RunReport } from '../shared/report.ts';
import { createHash } from 'node:crypto';
import type { HistoricalCommit, HistoricalKnowledge, HistoryEvidence, HistoryEvidencePage } from '../shared/history-evidence.ts';
import type { Db } from './db.ts';
import { InputError } from './errors.ts';
import type { Entry, Revision } from './knowledge.ts';
import { routerTurnText } from './router-call-text.ts';
import { parseInstant } from './schedule.ts';
import { described, object, problem } from './tool-schema.ts';

const MAX_LIMIT = 50;
const SCAN_LIMIT = 128;
const COMMIT = /^[0-9a-f]{6,64}$/i;

export const historyEvidenceInputSchema = object({
  query: described('在轮次标题、结果摘要、正式报告正文、结算理由和可读知识标题中按关键词找，多个词都应出现'),
  role_id: described('轮次开始时的职能编号'),
  since: described('结束时间下限，含该时刻（带时区的 ISO 8601）'),
  as_of: described('截至这个时刻结束的轮次（带时区的 ISO 8601）'),
  commit: described('Git 提交号或至少 6 位的十六进制前缀'),
  after: described('上一页的 next_cursor，沿用原有检索条件'),
  limit: { type: 'integer', description: '每页条数，1 至 50，默认 20' },
});

interface Store {
  getEntry(id: string): Entry | undefined;
  readRevision(id: string, revision: number): Revision | undefined;
}

interface RunEvidenceRow {
  position: number;
  id: string;
  task_id: string;
  task_revision: number;
  ended_at: string;
  started_at: string | null;
  exit_kind: string | null;
  receipt_json: string | null;
  error_json: string | null;
  snapshot_json: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function held(text: string | null): Record<string, unknown> | undefined {
  try {
    return text === null ? undefined : record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function safeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? routerTurnText(value.trim(), (text) => text) : null;
}

function instant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const at = parseInstant(value);
  if (at === undefined) throw new InputError('时间要写成带时区的 ISO 8601 格式');
  return at;
}

function parseInput(input: unknown) {
  const supplied = record(input);
  if (!supplied) throw new InputError('历史证据检索条件应为对象');
  const args = Object.fromEntries(Object.entries(supplied).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
  if (typeof args.limit === 'string' && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  const limit = args.limit ?? 20;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) {
    throw new InputError(`每页条数应为 1 至 ${MAX_LIMIT} 的整数`);
  }
  const issue = problem(historyEvidenceInputSchema, args, '检索条件');
  if (issue) throw new InputError(issue);
  const fields = args as Partial<Record<'query' | 'role_id' | 'since' | 'as_of' | 'commit' | 'after', string>>;
  const since = instant(fields.since || undefined);
  const asOf = instant(fields.as_of || undefined);
  if (since !== undefined && asOf !== undefined && since > asOf) throw new InputError('起始时间应早于或等于截止时间');
  const commit = fields.commit?.toLowerCase() || undefined;
  if (commit !== undefined && !COMMIT.test(commit)) throw new InputError('提交号应为 6 至 64 位十六进制字符');
  const query = fields.query ?? '';
  if (query.length > 240) throw new InputError('关键词最多 240 个字符');
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].sort();
  return { words, roleId: fields.role_id || undefined, since, asOf, commit, after: fields.after || undefined, limit: limit as number };
}

function cursorOf(fingerprint: string, row: RunEvidenceRow): string {
  return Buffer.from(JSON.stringify([fingerprint, row.ended_at, row.position])).toString('base64url');
}

function cursorPosition(raw: string | undefined, fingerprint: string): [string, number] | null {
  if (raw === undefined) return null;
  try {
    if (!/^[\w-]{1,256}$/.test(raw)) throw new Error();
    const [scope, at, position] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as [string, string, number];
    if (scope === fingerprint && typeof at === 'string' && parseInstant(at) === at && Number.isSafeInteger(position) && position > 0) return [at, position];
  } catch {
    // A cursor can be copied by a caller and is never an authorization check.
  }
  throw new InputError('历史证据游标无效，或和当前检索条件不一致');
}

function recordedCommits(snapshot: Record<string, unknown> | undefined, receipt: Record<string, unknown> | undefined, settlement: Record<string, unknown> | undefined): HistoricalCommit[] {
  const issued: HistoricalCommit[] = [];
  function add(value: unknown, source: HistoricalCommit['source']) {
    if (typeof value !== 'string' || !COMMIT.test(value)) return;
    const commit = value.toLowerCase();
    if (!issued.some((entry) => entry.value === commit && entry.source === source)) issued.push({ value: commit, source });
  }
  if (Array.isArray(receipt?.artifacts)) {
    for (const artifact of receipt.artifacts as unknown[]) {
      const item = record(artifact);
      if (item?.kind === 'commit') add(item.ref, 'reported');
    }
  }
  const head = record(settlement?.source_head);
  add(head?.head, 'observed');
  add(head?.remote_head, 'remote');
  add(record(snapshot?.source)?.commit, 'pinned');
  return issued;
}

function evidenceExcerpt(text: string | null, words: string[], limit = 420): string | null {
  if (text === null || text.length <= limit) return text;
  const lower = text.toLowerCase();
  const match = words.find((word) => lower.includes(word));
  const from = match === undefined ? 0 : Math.max(0, lower.indexOf(match) - 80);
  return (from > 0 ? '…' : '') + text.slice(from, from + limit) + (from + limit < text.length ? '…' : '');
}

export function createHistoryEvidence(db: Pick<Db, 'all'>, knowledge: Store, readReport?: (runId: string) => RunReport | undefined) {
  return (projectId: string, input: unknown): HistoryEvidencePage => {
    const { words, roleId, since, asOf, commit, after, limit } = parseInput(input);
    const fingerprint = createHash('sha256').update(JSON.stringify([projectId, words, roleId, since, asOf, commit])).digest('base64url');
    const cursor = cursorPosition(after, fingerprint);
    const rows = db.all<RunEvidenceRow>(`
      SELECT run.rowid AS position, run.id, run.task_id, run.task_revision, run.ended_at,
        run.started_at, run.exit_kind, run.receipt_json, run.error_json, run.snapshot_json
      FROM run JOIN task ON task.id = run.task_id
      WHERE task.project_id = ? AND run.state = 'ended' AND run.ended_at IS NOT NULL
        AND (? IS NULL OR run.ended_at >= ?) AND (? IS NULL OR run.ended_at <= ?)
        AND (? IS NULL OR (run.ended_at, run.rowid) < (?, ?))
      ORDER BY run.ended_at DESC, run.rowid DESC LIMIT ?
    `, projectId, since ?? null, since ?? null, asOf ?? null, asOf ?? null,
    cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, SCAN_LIMIT + 1);

    const inScope = (entry: { project_ids: string[] | null } | undefined) => entry !== undefined
      && (entry.project_ids === null || entry.project_ids.includes(projectId));
    const permitted = new Map<string, boolean>();
    const historical = new Map<string, Revision | undefined>();
    function readKnowledge(value: unknown): HistoricalKnowledge | undefined {
      const entry = record(value);
      const id = entry?.id;
      const revision = entry?.revision;
      if (typeof id !== 'string' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined;
      if (!permitted.has(id)) permitted.set(id, inScope(knowledge.getEntry(id)));
      if (!permitted.get(id)) return undefined;
      const key = JSON.stringify([id, revision]);
      if (!historical.has(key)) historical.set(key, knowledge.readRevision(id, revision));
      const version = historical.get(key);
      if (version === undefined || !inScope(version)) return undefined;
      return { id, revision, title: evidenceExcerpt(safeText(version.title), [], 160) ?? '' };
    }

    const items: HistoryEvidence[] = [];
    let considered = 0;
    for (const row of rows) {
      if (items.length === limit || considered === SCAN_LIMIT) break;
      considered += 1;
      const snapshot = held(row.snapshot_json);
      const role = record(snapshot?.role);
      const recordedRole = typeof role?.id === 'string' ? role.id : null;
      if (roleId !== undefined && recordedRole !== roleId) continue;
      const receipt = held(row.receipt_json);
      const settlement = held(row.error_json);
      const commits = recordedCommits(snapshot, receipt, settlement);
      if (commit !== undefined && !commits.some(({ value }) => value.startsWith(commit))) continue;
      // The rest of the brief contains instructions, resident knowledge, and prior messages.
      // Only its historical title is part of the lexical lookup.
      const title = safeText(typeof snapshot?.brief === 'string' ? /^# ([^\r\n]+)/.exec(snapshot.brief)?.[1] : null);
      const summary = safeText(receipt?.summary);
      const reason = safeText(settlement?.reason);
      const report = readReport?.(row.id);
      const delivered = row.started_at !== null && Array.isArray(snapshot?.knowledge) ? snapshot.knowledge as unknown[] : null;
      const versions = delivered?.map(readKnowledge).filter((entry) => entry !== undefined) ?? null;
      const searchable = [title, summary, reason, report?.text, ...(versions?.map(({ title }) => title) ?? [])].join('\n').toLowerCase();
      if (!words.every((word) => searchable.includes(word))) continue;
      const excerpt = report && words.some(word => report.text.toLowerCase().includes(word))
        && !words.every(word => [title, summary, reason].join('\n').toLowerCase().includes(word)) ? report.text : reason !== null && (summary === null || (words.some((word) => reason.toLowerCase().includes(word))
        && !words.some((word) => summary.toLowerCase().includes(word)))) ? reason : summary;
      items.push({
        project_id: projectId,
        task_id: row.task_id,
        task_revision: row.task_revision,
        run_id: row.id,
        ended_at: row.ended_at,
        exit_kind: row.exit_kind,
        title: evidenceExcerpt(title, words, 160),
        role_id: recordedRole,
        role_name: evidenceExcerpt(safeText(role?.name), [], 100),
        excerpt: evidenceExcerpt(excerpt, words),
        excerpt_source: excerpt === null ? null : report && excerpt === report.text ? 'final_message' : excerpt === summary ? 'receipt' : 'settlement',
        ...(report ? { report: { ...reportInfo(report), ref: FINAL_MESSAGE_REF } } : {}),
        commits,
        knowledge: versions,
        knowledge_unavailable: versions !== null && versions.length !== delivered?.length,
      });
    }
    const last = rows[considered - 1];
    return { items, next_cursor: last && considered < rows.length ? cursorOf(fingerprint, last) : null };
  };
}
