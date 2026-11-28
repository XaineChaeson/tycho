import { readRecordedReport } from './run-report.ts';
// Knowledge in the ledger (docs/design/knowledge-and-skills.md §1–§3, §5.2): entries with
// immutable revisions, and the one way in — a proposal with evidence. A proposal is one change:
// the existing entries it touches, each pinned to its revision and whether it was in force,
// with where each goes, and the entries it puts out. It is frozen once sent. An independent
// gate task passes or refuses it; what it passes takes effect at once, unreviewed, unless it is
// of the two kinds that wait for the owner's say (§3). What a round or the Router is handed is
// selected from here (service/knowledge-brief.ts renders it); nothing else holds a copy.
import { createHash, randomBytes } from 'node:crypto';
import type { Ctx, Db } from './db.ts';
import { nowIso, writeChange } from './db.ts';
import { InputError } from './errors.ts';
import { SETTINGS } from './settings.ts';
import { ulid } from './ids.ts';
import {
  citation, DISPOSITIONS, EVIDENCE_SOURCES, GRANTS, KNOWLEDGE_KINDS, LOADINGS,
  MAX_SEARCH_PHRASE_CHARS, MAX_SEARCH_PHRASES, PROPOSAL_STATE_LABELS,
  type Disposition, type EntryState, type EvidenceSource, type Grant, type KnowledgeKind, type Loading,
  type OwnerReason, type ProposalSource, type ProposalState,
} from '../shared/knowledge.ts';
import { FtsIndex, jaccardSimilarity, tokenizeForSearch } from './search-index.ts';

export interface KnowledgeLimits {
  // UTF-8 bytes, all four (§4.1).
  briefBytes: number;
  snapshotBytes: number;
  entryBytes: number;
  evidenceBytes: number;
}

const KIB = 1024;
type LimitKey = 'knowledge.briefLimitKb' | 'knowledge.snapshotLimitKb' | 'knowledge.entryLimitKb' | 'knowledge.evidenceLimitKb';
// The four limits as bytes, from the settings as they are at the moment of use.
export const knowledgeLimitsOf = (get: (key: LimitKey) => number): KnowledgeLimits => ({
  briefBytes: get('knowledge.briefLimitKb') * KIB,
  snapshotBytes: get('knowledge.snapshotLimitKb') * KIB,
  entryBytes: get('knowledge.entryLimitKb') * KIB,
  evidenceBytes: get('knowledge.evidenceLimitKb') * KIB,
});
// What the registry declares, for a ledger opened without the settings (a restore, a test).
export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeLimits = knowledgeLimitsOf((key) => SETTINGS[key].default);

const MAX_TITLE_CHARS = 200;
const SCOPE_TEXT = 'project_ids 要是一组项目编号，或者 null 表示全局';
const MAX_LINE_CHARS = 4000;
const MAX_EVIDENCE_ITEMS = 50;
const MAX_REQUEST_ID_CHARS = 200;
const MAX_LEARNED = 5;
const MAX_CHANGE_ITEMS = 20;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;

export const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

// ---- What comes in ----

interface EvidenceInput {
  source?: unknown;
  ref?: unknown;
  location?: unknown;
  excerpt?: unknown;
  captured_at?: unknown;
}

interface WhyInput {
  when?: unknown;
  changes?: unknown;
  generalizes?: unknown;
}

// A change as any entrance hands it: the tools, the MCP, the console, a receipt, a gate's
// verdict. `inputs` are existing entries, each at the revision the proposer read; `outputs` are
// what it puts out, each either a revision of one of the inputs (`revises`) or a new entry. An
// output's scope (`project_ids`, null for "全局") and loading are stated, never inferred.
interface ChangeInputRaw {
  knowledge_id?: unknown;
  revision?: unknown;
  disposition?: unknown;
  replaced_by?: unknown;
  note?: unknown;
}

interface ChangeOutputRaw {
  key?: unknown;
  revises?: unknown;
  title?: unknown;
  when_to_use?: unknown;
  body?: unknown;
  project_ids?: unknown;
  loading?: unknown;
  roles?: unknown;
  search_phrases?: unknown;
}

interface ChangeRaw {
  kind?: unknown;
  inputs?: unknown;
  outputs?: unknown;
}

export interface ProposalInput extends ChangeRaw {
  why?: WhyInput;
  evidence?: unknown;
  request_id?: unknown;
}

// Who sent it, as the entrance knows it: never what the request says about itself.
export interface Proposer {
  source: ProposalSource;
  // Shown as the proposer: 'router', a run id, an MCP client's name, 'console'.
  by: string;
  // What a request id is unique within: the MCP client's id, 'router', 'run:<id>', 'console'.
  client: string;
  // The executors that wrote it, which its gate may not run on (§3). Empty: the owner, or none
  // known.
  writers: string[];
  // The Task and round it was made in, if any: its project is where the proposal came from.
  taskId?: string;
  runId?: string;
  // Router's trusted entrance scope; never copied from proposal arguments.
  projectId?: string;
}

// ---- The normal form ----

interface Evidence {
  source: EvidenceSource;
  ref: string | null;
  location: string;
  excerpt: string;
  // Null when the submitter did not say: the proposal's own time is recorded then, and a retry
  // of the same request is still the same candidate.
  captured_at: string | null;
}

export interface ChangeInput {
  knowledge_id: string;
  // Pinned when the change was made: what it was based on, checked again at publication.
  revision: number;
  active: boolean;
  disposition: Disposition;
  // For `replaced`: an output's key, or an existing entry's id.
  replaced_by: string | null;
  note: string;
}

export interface ChangeOutput {
  key: string;
  revises: string | null;
  title: string;
  when_to_use: string;
  body: string;
  // Null is global; otherwise the projects, sorted, each once.
  project_ids: string[] | null;
  loading: Loading;
  roles: string[];
  // Optional up to 3 alternate retrieval phrases indexed in FTS5 only (never overrides canonical body).
  search_phrases?: string[];
  // Set once the change is published: the entry this output became.
  knowledge_id?: string;
}

export interface Change {
  kind: KnowledgeKind;
  inputs: ChangeInput[];
  outputs: ChangeOutput[];
}

// ---- Rows and views ----

interface ProposalRow {
  id: string;
  created_at: string;
  kind: KnowledgeKind;
  change_json: string;
  final_json: string | null;
  why_json: string;
  source: ProposalSource;
  proposed_by: string;
  client_id: string;
  request_id: string | null;
  task_id: string | null;
  run_id: string | null;
  amended_from: string | null;
  next_id: string | null;
  digest: string;
  content_digest: string;
  final_digest: string | null;
  prior_rejection_id: string | null;
  gate_task_id: string | null;
  gate_json: string | null;
  owner_reasons_json: string | null;
  state: ProposalState;
  state_reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decided_via: string | null;
  decision_note: string | null;
  published_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

interface EvidenceRow extends Omit<Evidence, 'captured_at'> {
  id: string;
  proposal_id: string;
  seq: number;
  captured_at: string;
  sha256: string;
  submitted_by: string;
  verified: number;
}

interface EntryRow {
  id: string;
  created_at: string;
  kind: KnowledgeKind;
  revision: number;
  state: EntryState;
  retired_at: string | null;
  retired_by: string | null;
  retired_reason: string | null;
  replaced_by: string | null;
  retired_proposal_id: string | null;
}

interface RevisionRow {
  knowledge_id: string;
  revision: number;
  created_at: string;
  title: string;
  when_to_use: string;
  body: string;
  projects_json: string | null;
  loading: Loading;
  roles_json: string;
  search_phrases_json?: string | null;
  proposal_id: string;
  published_by: string;
  reviewed_at: string | null;
}

// One revision as every reader gets it. `reviewed_at` is its change's: set when the owner wrote
// it, nodded it through, or marked it reviewed afterwards; null while it is in force unreviewed.
export interface Revision {
  id: string;
  revision: number;
  kind: KnowledgeKind;
  title: string;
  when_to_use: string;
  body: string;
  project_ids: string[] | null;
  loading: Loading;
  roles: string[];
  search_phrases?: string[];
  proposal_id: string;
  published_by: string;
  published_at: string;
  reviewed_at: string | null;
}

// An entry with the revision in force.
export interface Entry extends Revision {
  created_at: string;
  state: EntryState;
  retired_at: string | null;
  retired_by: string | null;
  retired_reason: string | null;
  replaced_by: string | null;
}

export interface Evidenced extends Omit<EvidenceRow, 'verified'> {
  verified: boolean;
}

// What a gate or curation task handed back (§3, §5.3).
interface GateVerdict {
  result: 'pass' | 'reject';
  reason: string;
  // Whether the gate changed the change it was given: what it passed is `final`.
  modified: boolean;
  task_id: string;
  run_id: string;
}

export interface Proposal {
  id: string;
  created_at: string;
  kind: KnowledgeKind;
  // As sent, and as it was passed (by the gate, or the owner's own): what takes effect is `final`.
  change: Change;
  final: Change | null;
  why: { when: string; changes: string; generalizes: string };
  source: ProposalSource;
  proposed_by: string;
  request_id: string | null;
  task_id: string | null;
  run_id: string | null;
  amended_from: string | null;
  next_id: string | null;
  digest: string;
  final_digest: string | null;
  prior_rejection: { id: string; reason: string | null; rejected_at: string | null } | null;
  gate_task_id: string | null;
  gate: GateVerdict | null;
  owner_reasons: OwnerReason[];
  state: ProposalState;
  state_reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decided_via: string | null;
  decision_note: string | null;
  published_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  evidence: Evidenced[];
}

export interface KnowledgeClient {
  id: string;
  created_at: string;
  name: string;
  executor: string;
  grants: Grant[];
  revoked_at: string | null;
  last_used_at: string | null;
  request_count: number;
}

// What a Task that gates or curates knowledge carries (§3, §5.3).
export type KnowledgeTask =
  | { kind: 'gate'; proposal_id: string; writers: string[] }
  | { kind: 'curation'; entries: string[]; reasons: string[] };

// A no-project knowledge Task a project's deletion leaves pointless, with what it has left to
// work on: a gate has nothing (`entries` and `reasons` are null), a curation keeps the entries
// that did not go. `running` says whether a round of it is under way now, and `ended` whether it
// is already over — an ended Task is not given up by the deletion, only its record loses what
// points at the rows that go, and a deletion says the two apart.
export interface SweptKnowledgeTask {
  task_id: string;
  running: boolean;
  ended: boolean;
  entries: string[] | null;
  reasons: string[] | null;
}

export const parseKnowledgeTask = (json: string | null | undefined): KnowledgeTask | null =>
  json === null || json === undefined ? null : (JSON.parse(json) as KnowledgeTask);

export interface Page<T> {
  items: T[];
  // Where the next page starts, or null when this was the last.
  next: string | null;
  total: number;
}

const SECRET_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: '私钥' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, what: 'Bearer 令牌' },
  { pattern: /\b(?:sk|ghp|gho|glpat)[-_][A-Za-z0-9_-]{20,}/, what: '访问令牌' },
  // This system's own: its environment variables and request headers carry tokens bare.
  { pattern: /\bTYCHO_[A-Z0-9_]*(?:TOKEN|SECRET|KEY|MATERIALS)\b\s*[=:]/, what: '环境变量里的 tycho 令牌' },
  { pattern: /\bX-Tycho-[A-Za-z-]*(?:Token|Secret)\s*:/i, what: '请求头里的 tycho 令牌' },
];

// A token this system issued, wherever it sits in an excerpt: its tokens are 64 hex digits,
// and the ledger keeps the hash of each.
const TOKEN_LIKE = /\b[0-9a-f]{64}\b/g;

const text = (value: unknown, what: string, max = MAX_LINE_CHARS): string => {
  if (isBlank(value)) throw new InputError(`${what}不能为空`);
  const trimmed = (value as string).trim();
  if (trimmed.length > max) throw new InputError(`${what}太长：最多 ${max} 个字`);
  return trimmed;
};

const kib = (n: number): string => `${(n / KIB).toFixed(1)} KiB`;

function instant(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new InputError(`${what}要是带时区的时间`);
  return new Date(value).toISOString();
}

function textsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const each of value) textsOf(each, into);
  else if (value !== null && typeof value === 'object') for (const each of Object.values(value)) textsOf(each, into);
  return into;
}

// What a change says, without what it was pinned to: two proposals of the same content are the
// same thing proposed again, whatever revision each read (§3, a rejection shown again).
function contentOf(change: Change): string {
  return JSON.stringify([
    change.kind,
    change.inputs.map(({ knowledge_id, disposition, replaced_by, note }) => [knowledge_id, disposition, replaced_by, note]),
    change.outputs.map(({ key, revises, title, when_to_use, body, project_ids, loading, roles }) => [key, revises, title, when_to_use, body, project_ids, loading, roles]),
  ]);
}

// The frozen change in one canonical text (§2): every input's pinned revision, every output, the
// three answers and the evidence. Any of them changed makes another candidate. Whether an input was in force is
// pinned with it and checked at publication, but it is what the ledger said, not what the
// request said: a retry of the same request compares equal whatever the ledger has become.
function canonical(
  change: Pick<Change, 'kind' | 'outputs'> & { inputs: readonly (Omit<ChangeInput, 'active' | 'revision'> & { revision: number | null })[] },
  why: Proposal['why'],
  evidence: readonly Pick<Evidence, 'source' | 'ref' | 'location' | 'excerpt' | 'captured_at'>[],
): string {
  return JSON.stringify([
    contentOf(change as Change),
    change.inputs.map(({ knowledge_id, revision }) => [knowledge_id, revision]),
    [why.when, why.changes, why.generalizes],
    evidence.map(({ source, ref, location, excerpt, captured_at }) => [source, ref, location, excerpt, captured_at]),
  ]);
}

// Character pairs of a text, for a rough "these say similar things" (§3: related entries are
// picked by scope and similarity). Enough to put the likely duplicates in front of the gate.
function pairs(value: string): Set<string> {
  const plain = value.toLowerCase().replace(/\s+/g, '');
  const found = new Set<string>();
  for (let at = 0; at < plain.length - 1; at += 1) found.add(plain.slice(at, at + 2));
  return found;
}
const similarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const each of a) if (b.has(each)) shared += 1;
  return shared / (a.size + b.size - shared);
};

interface KnowledgeOptions {
  limits: () => KnowledgeLimits;
  // The Outbox, by the ledger's own gate on which channels are on.
  enqueue: (channel: string, kind: string, payload: unknown) => void;
  // Make a gate or curation Task (an analysis Task: the ledger's own creation, with its checks)
  // and return its id. In the caller's transaction.
  createTask: (fields: { title: string; goal: string; acceptance: string; knowledge: KnowledgeTask }, ctx: Ctx) => string;
  // After a change took effect, in its transaction: where the curation threshold is checked.
  afterPublish: (ctx: Ctx) => void;
  // End a gate Task whose proposal no longer waits for it, unless a round of it is already out
  // (its verdict is then refused where it settles). In the caller's transaction.
  endTask: (taskId: string, reason: string, ctx: Ctx) => void;
}

// What a gate's or curation's round is handed (§3, §5.3), with the projects whose content that
// carries: the material and the machines it may go to are made from this one answer.
export type KnowledgeMaterial =
  | { kind: 'gate'; proposal: Proposal; prior: Proposal | null; related: Entry[]; source: string | null; projects: string[] }
  | { kind: 'curation'; entries: { entry: Entry; evidence: Evidenced[] }[]; reasons: string[]; source: null; projects: string[] };

export function createKnowledge(db: Db, write: <T>(fn: () => T) => T, options: KnowledgeOptions) {
  const limits = (): KnowledgeLimits => options.limits();

  const parseList = (json: string | null): string[] | null => (json === null ? null : (JSON.parse(json) as string[]));

  const REVISION_SELECT = `SELECT knowledge_revision.*, knowledge_proposal.reviewed_at AS reviewed_at, knowledge_proposal.published_at AS published_at
    FROM knowledge_revision JOIN knowledge_proposal ON knowledge_proposal.id = knowledge_revision.proposal_id`;

  function revisionOf(row: RevisionRow & { published_at: string | null }, kind: KnowledgeKind): Revision {
    const phrases = row.search_phrases_json ? (JSON.parse(row.search_phrases_json) as string[]) : [];
    return {
      id: row.knowledge_id, revision: row.revision, kind, title: row.title, when_to_use: row.when_to_use, body: row.body,
      project_ids: parseList(row.projects_json), loading: row.loading, roles: JSON.parse(row.roles_json) as string[],
      ...(phrases.length > 0 ? { search_phrases: phrases } : {}),
      proposal_id: row.proposal_id,
      published_by: row.published_by, published_at: row.published_at ?? row.created_at, reviewed_at: row.reviewed_at,
    };
  }

  const ENTRY_SELECT = `SELECT knowledge.*, knowledge_revision.title, knowledge_revision.when_to_use, knowledge_revision.body,
      knowledge_revision.projects_json, knowledge_revision.loading, knowledge_revision.roles_json, knowledge_revision.search_phrases_json, knowledge_revision.proposal_id,
      knowledge_revision.published_by, knowledge_revision.created_at AS revision_at, knowledge_proposal.reviewed_at, knowledge_proposal.published_at
    FROM knowledge JOIN knowledge_revision ON knowledge_revision.knowledge_id = knowledge.id AND knowledge_revision.revision = knowledge.revision
    JOIN knowledge_proposal ON knowledge_proposal.id = knowledge_revision.proposal_id`;
  type Joined = EntryRow & Omit<RevisionRow, 'knowledge_id' | 'revision' | 'created_at'> & { revision_at: string; published_at: string | null };
  const joinedEntry = (row: Joined): Entry => ({
    ...revisionOf({ ...row, knowledge_id: row.id, created_at: row.revision_at }, row.kind),
    created_at: row.created_at, state: row.state, retired_at: row.retired_at, retired_by: row.retired_by,
    retired_reason: row.retired_reason, replaced_by: row.replaced_by,
  });

  function loadEntry(id: string): Entry | undefined {
    const row = db.get<Joined>(`${ENTRY_SELECT} WHERE knowledge.id = ?`, id);
    return row && joinedEntry(row);
  }

  function requireEntry(id: unknown, what = '条目'): Entry {
    if (typeof id !== 'string' || id === '') throw new InputError(`要写${what}编号`);
    const entry = loadEntry(id);
    if (!entry) throw new InputError(`${what}不存在：${id}`);
    return entry;
  }

  function readRevision(id: string, revision?: number): Revision | undefined {
    const entry = db.get<EntryRow>('SELECT * FROM knowledge WHERE id = ?', id);
    if (!entry) return undefined;
    const row = db.get<RevisionRow & { published_at: string | null }>(`${REVISION_SELECT} WHERE knowledge_id = ? AND revision = ?`, id, revision ?? entry.revision);
    return row && revisionOf(row, entry.kind);
  }

  function evidenceOf(proposalId: string): Evidenced[] {
    return db.all<EvidenceRow>('SELECT * FROM knowledge_evidence WHERE proposal_id = ? ORDER BY seq', proposalId)
      .map(({ verified, ...row }) => ({ ...row, verified: verified === 1 }));
  }

  function proposalOf(row: ProposalRow): Proposal {
    const prior = row.prior_rejection_id === null ? undefined : db.get<{ id: string; state_reason: string | null; decided_at: string | null }>(
      'SELECT id, state_reason, decided_at FROM knowledge_proposal WHERE id = ?', row.prior_rejection_id);
    return {
      id: row.id, created_at: row.created_at, kind: row.kind,
      change: JSON.parse(row.change_json) as Change, final: row.final_json === null ? null : (JSON.parse(row.final_json) as Change),
      why: JSON.parse(row.why_json) as Proposal['why'], source: row.source, proposed_by: row.proposed_by, request_id: row.request_id,
      task_id: row.task_id, run_id: row.run_id, amended_from: row.amended_from, next_id: row.next_id, digest: row.digest,
      final_digest: row.final_digest,
      prior_rejection: prior ? { id: prior.id, reason: prior.state_reason, rejected_at: prior.decided_at } : null,
      gate_task_id: row.gate_task_id, gate: row.gate_json === null ? null : (JSON.parse(row.gate_json) as GateVerdict),
      owner_reasons: row.owner_reasons_json === null ? [] : (JSON.parse(row.owner_reasons_json) as OwnerReason[]),
      state: row.state, state_reason: row.state_reason, decided_at: row.decided_at, decided_by: row.decided_by,
      decided_via: row.decided_via, decision_note: row.decision_note, published_at: row.published_at,
      reviewed_at: row.reviewed_at, reviewed_by: row.reviewed_by, evidence: evidenceOf(row.id),
    };
  }

  function loadProposal(id: string): ProposalRow {
    const row = db.get<ProposalRow>('SELECT * FROM knowledge_proposal WHERE id = ?', id);
    if (!row) throw new InputError(`提议不存在：${id}`);
    return row;
  }

  // ---- The entrance: one parse for every way in ----

  function defaultProjectIdsOf(proposer?: Proposer): string[] | null {
    if (proposer?.projectId) return [proposer.projectId];
    if (proposer?.taskId) {
      const pid = db.get<{ project_id: string | null }>('SELECT project_id FROM task WHERE id = ?', proposer.taskId)?.project_id ?? null;
      if (pid !== null) return [pid];
    }
    return null;
  }

  function requireProjects(value: unknown, at: string, defaultProjectIds: string[] | null = null): string[] | null {
    if (value === undefined) return defaultProjectIds;
    if (value === null) return null;
    if (!Array.isArray(value) || value.some((each) => typeof each !== 'string' || each === '')) throw new InputError(`${at}：${SCOPE_TEXT}`);
    if (value.length === 0) return defaultProjectIds;
    const projects = [...new Set(value as string[])].sort();
    for (const project of projects) if (!db.get('SELECT 1 FROM project WHERE id = ?', project)) throw new InputError(`项目不存在：${project}`);
    return projects;
  }

  // Defaults to on_demand when omitted; skills are always on_demand without throwing.
  function requireLoading(value: unknown, at: string, kind: KnowledgeKind): Loading {
    if (kind === 'skill') return 'on_demand';
    if (value === undefined || value === null || value === '') return 'on_demand';
    if (!(LOADINGS as readonly unknown[]).includes(value)) throw new InputError(`${at}：加载方式只能是 ${LOADINGS.join('、')}`);
    return value as Loading;
  }

  function requireRoles(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((each) => typeof each !== 'string')) throw new InputError('roles 要是职能编号的列表');
    const roles = [...new Set(value as string[])].sort();
    for (const role of roles) if (!db.get('SELECT 1 FROM role WHERE id = ?', role)) throw new InputError(`职能不存在：${role}`);
    return roles;
  }

  // Best-effort check of whether a local tycho object holds the excerpt; never throws.
  function verified(source: EvidenceSource, ref: string | null, excerpt: string): boolean {
    if (ref === null || excerpt === '') return false;
    const holds = (texts: (string | null | undefined)[]): boolean => texts.some((each) => typeof each === 'string' && each.includes(excerpt));
    switch (source) {
      case 'run': {
        const run = db.get<{ id: string; task_id: string; receipt_json: string | null; error_json: string | null }>('SELECT id, task_id, receipt_json, error_json FROM run WHERE id = ?', ref);
        return run !== undefined && holds([...textsOf([run.receipt_json && JSON.parse(run.receipt_json), run.error_json && JSON.parse(run.error_json)]), readRecordedReport(db, run)?.text]);
      }
      case 'task': {
        const task = db.get<{ title: string; goal: string; acceptance: string | null; scope: string | null }>('SELECT title, goal, acceptance, scope FROM task WHERE id = ?', ref);
        const inputs = db.all<{ text: string }>('SELECT text FROM input WHERE task_id = ?', ref).map(({ text: each }) => each);
        return task !== undefined && holds([task.title, task.goal, task.acceptance, task.scope, ...inputs]);
      }
      case 'record': {
        // The old ruling as the step to ledger 20 kept it, until it is carried over.
        const kept = db.get<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'legacy_decisions'`);
        const items = kept ? (JSON.parse(kept.value_json) as { id: string; text: string }[]) : [];
        return items.some((item) => item.id === ref && holds([item.text]));
      }
      case 'owner': {
        const message = db.get<{ text: string }>(`SELECT text FROM message WHERE id = ? AND direction = 'in' AND channel NOT IN ('internal', 'trigger')`, ref);
        return message !== undefined && holds([message.text]);
      }
      default:
        return false;
    }
  }

  // Whether text holds a token this system issued — a knowledge MCP client's or a machine's,
  // revoked or not — recognized by the hash the ledger keeps of each.
  function issuedToken(value: string): boolean {
    for (const [candidate] of value.matchAll(TOKEN_LIKE)) {
      const hash = sha256(candidate);
      if (db.get('SELECT 1 FROM knowledge_client WHERE token_hash = ?', hash) || db.get('SELECT 1 FROM machine WHERE token_hash = ?', hash)) return true;
    }
    return false;
  }

  // Secret scrubbing preserved on ALL saved text (outputs, inputs, why, evidence).
  function assertNoSecrets(value: unknown, where: string): void {
    for (const str of textsOf(value)) {
      for (const { pattern, what } of SECRET_PATTERNS) {
        if (pattern.test(str)) throw new InputError(`${where}里像是有${what}：凭据不能保存，删掉它再交`);
      }
      if (issuedToken(str)) throw new InputError(`${where}里有一个 tycho 签发的令牌：凭据不能保存，删掉它再交`);
    }
  }

  const optionalText = (value: unknown, what: string, max = MAX_LINE_CHARS): string => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new InputError(`${what}要是文字`);
    const trimmed = value.trim();
    if (trimmed.length > max) throw new InputError(`${what}太长：最多 ${max} 个字`);
    return trimmed;
  };

  // Evidence is optional: omitted or empty returns []. When supplied, secret scrubbing and
  // byte bounds are still enforced.
  function parseEvidence(value: unknown, allowRecord = false): Evidence[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new InputError('evidence 要是列表');
    if (value.length === 0) return [];
    if (value.length > MAX_EVIDENCE_ITEMS) throw new InputError(`证据最多 ${MAX_EVIDENCE_ITEMS} 条：只留支撑结论的`);
    const items = value.map((raw, index): Evidence => {
      const each = (raw ?? {}) as EvidenceInput;
      const at = `第 ${index + 1} 条证据`;
      const source = each.source === undefined || each.source === null || each.source === '' ? 'conversation' : each.source;
      if (!(EVIDENCE_SOURCES as readonly unknown[]).includes(source) && !(allowRecord && source === 'record')) {
        throw new InputError(`${at}的来源只能是 ${EVIDENCE_SOURCES.join('、')}`);
      }
      const excerpt = optionalText(each.excerpt, `${at}的摘录`, Number.MAX_SAFE_INTEGER);
      const location = optionalText(each.location, `${at}的位置`, MAX_LINE_CHARS);
      const ref = each.ref === undefined || each.ref === null || each.ref === '' ? null : text(each.ref, `${at}的来源编号`, MAX_TITLE_CHARS);
      assertNoSecrets([excerpt, location, ref], at);
      return {
        source: source as EvidenceSource,
        ref,
        location,
        excerpt,
        captured_at: instant(each.captured_at, `${at}的采集时间`),
      };
    });
    const total = items.reduce((sum, { excerpt }) => sum + bytes(excerpt), 0);
    const limit = limits().evidenceBytes;
    if (total > limit) throw new InputError(`证据摘录合计 ${kib(total)}，超过了单份提议的上限 ${kib(limit)}：只摘和结论相关的那几段`);
    return items;
  }

  // `why` is completely optional; omitted/partial fields default to empty strings.
  function parseWhy(value: WhyInput | undefined): Proposal['why'] {
    const why = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as WhyInput;
    const parsed = {
      when: optionalText(why.when, 'why.when'),
      changes: optionalText(why.changes, 'why.changes'),
      generalizes: optionalText(why.generalizes, 'why.generalizes'),
    };
    assertNoSecrets(parsed, 'why');
    return parsed;
  }

  type NormalizedInput = Omit<ChangeInput, 'active' | 'revision'> & { revision: number | null };

  // A change in its normal form, from its shape alone. Defaults project_ids to caller's project
  // (or null if none) and loading to on_demand; makes revision, disposition, and when_to_use optional.
  function normalizeChange(raw: ChangeRaw, defaultProjectIds: string[] | null = null): { kind: KnowledgeKind; inputs: NormalizedInput[]; outputs: ChangeOutput[] } {
    const kind = (raw.kind ?? 'knowledge') as KnowledgeKind;
    if (!(KNOWLEDGE_KINDS as readonly unknown[]).includes(kind)) throw new InputError(`类型只能是 knowledge（知识）或 skill（技能）：${String(raw.kind)}`);
    const rawInputs = raw.inputs ?? [];
    const rawOutputs = raw.outputs ?? [];
    if (!Array.isArray(rawInputs) || !Array.isArray(rawOutputs)) throw new InputError('inputs 和 outputs 要是列表');
    if (rawInputs.length + rawOutputs.length > MAX_CHANGE_ITEMS) throw new InputError(`一份提议最多涉及 ${MAX_CHANGE_ITEMS} 条：不相干的整理分开提`);
    const outputs: ChangeOutput[] = rawOutputs.map((value, index) => {
      const each = (value ?? {}) as ChangeOutputRaw;
      const at = `第 ${index + 1} 份输出`;
      const body = text(each.body, `${at}的正文`, Number.MAX_SAFE_INTEGER);
      const limit = limits().entryBytes;
      if (bytes(body) > limit) throw new InputError(`${at}的正文 ${kib(bytes(body))}，超过了单条上限 ${kib(limit)}：拆成几条，或者只留结论、依据和边界`);
      let projectIds: string[] | null;
      if (each.project_ids === undefined) {
        projectIds = defaultProjectIds;
      } else if (each.project_ids === null) {
        projectIds = null;
      } else if (Array.isArray(each.project_ids) && each.project_ids.every((one) => typeof one === 'string' && one !== '')) {
        projectIds = each.project_ids.length === 0 ? defaultProjectIds : [...new Set(each.project_ids as string[])].sort();
      } else {
        throw new InputError(`${at}：${SCOPE_TEXT}`);
      }
      const roles = each.roles === undefined || each.roles === null ? [] : each.roles;
      if (!Array.isArray(roles) || roles.some((one) => typeof one !== 'string')) throw new InputError('roles 要是职能编号的列表');
      const rawPhrases = each.search_phrases === undefined || each.search_phrases === null ? [] : each.search_phrases;
      if (!Array.isArray(rawPhrases) || rawPhrases.some((one) => typeof one !== 'string')) {
        throw new InputError('search_phrases 要是检索短语字符串列表');
      }
      const searchPhrases = [...new Set(rawPhrases.map((p) => (p as string).trim()).filter(Boolean))].slice(0, MAX_SEARCH_PHRASES);
      for (const phrase of searchPhrases) {
        if (phrase.length > MAX_SEARCH_PHRASE_CHARS) {
          throw new InputError(`检索短语太长：每条最多 ${MAX_SEARCH_PHRASE_CHARS} 个字`);
        }
      }
      const title = text(each.title, `${at}的标题`, MAX_TITLE_CHARS);
      const whenToUse = optionalText(each.when_to_use, `${at}的“什么时候用”`);
      assertNoSecrets([title, whenToUse, body, ...searchPhrases], at);
      return {
        key: each.key === undefined || each.key === null || each.key === '' ? `o${index + 1}` : text(each.key, `${at}的 key`, 40),
        revises: each.revises === undefined || each.revises === null || each.revises === '' ? null : text(each.revises, `${at}的 revises`, 40),
        title,
        when_to_use: whenToUse,
        body,
        project_ids: projectIds,
        loading: requireLoading(each.loading, at, kind),
        roles: [...new Set(roles as string[])].sort(),
        ...(searchPhrases.length > 0 ? { search_phrases: searchPhrases } : {}),
      };
    });
    const revisedIds = new Set(outputs.map(({ revises }) => revises).filter((id): id is string => id !== null));
    const inputs: NormalizedInput[] = rawInputs.map((value, index) => {
      const each = (value ?? {}) as ChangeInputRaw;
      const at = `第 ${index + 1} 条输入`;
      if (typeof each.knowledge_id !== 'string' || each.knowledge_id === '') throw new InputError(`要写${at}的条目编号`);
      let revision: number | null = null;
      if (each.revision !== undefined && each.revision !== null) {
        if (!Number.isInteger(each.revision)) throw new InputError(`${at}的 revision 要是整数`);
        revision = each.revision as number;
      }
      let disposition: Disposition;
      if (each.disposition === undefined || each.disposition === null || each.disposition === '') {
        disposition = revisedIds.has(each.knowledge_id) ? 'revise' : outputs.length === 0 ? 'retire' : 'keep';
      } else {
        if (!(DISPOSITIONS as readonly unknown[]).includes(each.disposition)) throw new InputError(`${at}的去向只能是 ${DISPOSITIONS.join('、')}`);
        disposition = each.disposition as Disposition;
      }
      const replacedBy = disposition === 'replaced' && typeof each.replaced_by === 'string' && each.replaced_by.trim() !== ''
        ? text(each.replaced_by, `${at}被谁取代（replaced_by）`, 40)
        : null;
      const note = optionalText(each.note, `${at}的备注`);
      assertNoSecrets(note, at);
      return {
        knowledge_id: each.knowledge_id,
        revision,
        disposition,
        replaced_by: replacedBy,
        note,
      };
    });
    return { kind, inputs, outputs };
  }

  // Simplified change validation: supports direct create/update/retire without manual inputs DAG
  // boilerplate, without replaced_by double-listing, without retire note requirement, without
  // forbidding kind changes, and with optional revision pins.
  function parseChange(raw: ChangeRaw, defaultProjectIds: string[] | null = null): Change {
    const { kind, inputs: shaped, outputs } = normalizeChange(raw, defaultProjectIds);
    for (const output of outputs) {
      const at = `输出 ${output.key}`;
      if (output.project_ids !== null) requireProjects(output.project_ids, at, defaultProjectIds);
      requireRoles(output.roles);
    }
    const keys = new Set<string>();
    for (const { key } of outputs) {
      if (keys.has(key)) throw new InputError(`输出的 key 重复了：${key}`);
      keys.add(key);
    }
    const inputs: ChangeInput[] = shaped.map((input, index) => {
      const at = `第 ${index + 1} 条输入`;
      const entry = requireEntry(input.knowledge_id, `${at}的条目`);
      if (input.revision !== null && input.revision !== entry.revision) {
        throw new InputError(`条目 ${entry.id} 现在是修订 ${entry.revision}，不是 ${input.revision}：先读一遍现在的修订，再按它提`);
      }
      if (input.disposition !== 'keep' && entry.state !== 'active') {
        throw new InputError(`条目 ${entry.id} 已经退役，不能再${input.disposition === 'revise' ? '修订' : '退役或取代'}`);
      }
      return { ...input, revision: entry.revision, active: entry.state === 'active' };
    });
    const ids = new Set<string>();
    for (const { knowledge_id: id } of inputs) {
      if (ids.has(id)) throw new InputError(`条目 ${id} 在输入里出现了两次`);
      ids.add(id);
    }
    // Auto-synthesize or align inputs for any output that revises an existing entry.
    const revisedSeen = new Set<string>();
    for (const output of outputs) {
      if (output.revises === null) continue;
      if (revisedSeen.has(output.revises)) throw new InputError(`条目 ${output.revises} 不能被多份输出同时修订`);
      revisedSeen.add(output.revises);
      const existing = inputs.find(({ knowledge_id: id }) => id === output.revises);
      if (existing) {
        if (existing.disposition === 'keep') {
          if (!existing.active) throw new InputError(`条目 ${existing.knowledge_id} 已经退役，不能再修订`);
          existing.disposition = 'revise';
        } else if (existing.disposition !== 'revise') {
          throw new InputError(`输出 ${output.key} 修订的 ${output.revises} 在输入里的去向不是 revise`);
        }
      } else {
        const entry = requireEntry(output.revises, `输出 ${output.key} 修订的条目`);
        if (entry.state !== 'active') throw new InputError(`条目 ${entry.id} 已经退役，不能再修订`);
        inputs.push({ knowledge_id: entry.id, revision: entry.revision, active: true, disposition: 'revise', replaced_by: null, note: '' });
        ids.add(entry.id);
      }
    }
    const firstNewOutputKey = outputs.find(({ revises }) => revises === null)?.key ?? null;
    for (const input of inputs) {
      if (input.disposition === 'revise' && outputs.filter(({ revises }) => revises === input.knowledge_id).length !== 1) {
        throw new InputError(`条目 ${input.knowledge_id} 的去向是修订：要有且只有一份输出 revises 它`);
      }
      if (input.disposition !== 'replaced') continue;
      if (input.replaced_by === null && firstNewOutputKey !== null) {
        input.replaced_by = firstNewOutputKey;
      }
      const by = input.replaced_by;
      if (by === null) continue;
      if (outputs.some(({ key, revises }) => key === by && revises === null)) continue;
      if (by === input.knowledge_id) throw new InputError('一条不能被它自己取代');
      const target = loadEntry(by);
      if (!target || target.state !== 'active') throw new InputError(`条目 ${input.knowledge_id} 被取代：replaced_by 要是一份新条目输出的 key，或者一条可用的现有条目`);
    }
    if (outputs.length === 0 && inputs.every(({ disposition }) => disposition === 'keep')) {
      throw new InputError('这份提议什么都不改：至少有一份输出，或者一条输入要修订、被取代或退役');
    }
    return { kind, inputs, outputs };
  }

  function requestIdOf(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    return text(value, '请求编号', MAX_REQUEST_ID_CHARS);
  }

  // Owner confirmation is required ONLY when an output is global + resident.
  function ownerReasons(change: Change): OwnerReason[] {
    return change.outputs.some(({ project_ids, loading }) => project_ids === null && loading === 'resident')
      ? ['global_resident']
      : [];
  }

  // Retired bigram matching gate removed; retained as empty-returning helper for API compatibility.
  function retiredMatches(_change: Pick<Change, 'outputs'>, _evidence: readonly Pick<Evidenced, 'sha256'>[]): Entry[] {
    return [];
  }

  // The pins of a change against what is in force now (§3): any input whose revision or state
  // moved means the change is about something that is no longer there.
  function moved(change: Change): string | undefined {
    for (const input of change.inputs) {
      const entry = loadEntry(input.knowledge_id);
      if (!entry) return `条目 ${input.knowledge_id} 不在了`;
      if (entry.revision !== input.revision) return `条目 ${input.knowledge_id} 已经是修订 ${entry.revision}，这份提议依据的是修订 ${input.revision}`;
      if ((entry.state === 'active') !== input.active) return `条目 ${input.knowledge_id} ${entry.state === 'active' ? '又生效了' : '已经退役'}`;
    }
    return undefined;
  }

  const effectiveChange = (row: ProposalRow): Change => JSON.parse(row.final_json ?? row.change_json) as Change;

  // Proposals still waiting whose change pinned one of these entries: their difference has to be
  // worked out again (§3). Their gate, if it is still to run, finds the proposal no longer gating.
  function staleOthers(touched: ReadonlySet<string>, except: string, ctx: Ctx): void {
    const waiting = db.all<ProposalRow>(`SELECT * FROM knowledge_proposal WHERE state IN ('gating', 'awaiting_owner') AND id != ?`, except);
    for (const row of waiting) {
      const hit = effectiveChange(row).inputs.find(({ knowledge_id: id }) => touched.has(id));
      if (!hit) continue;
      const reason = `条目 ${hit.knowledge_id} 在这份提议等待期间变了：先发布的已经生效，这一份要按现在的修订重新处理差异`;
      db.run(`UPDATE knowledge_proposal SET state = 'stale', state_reason = ? WHERE id = ?`, reason, row.id);
      writeChange(db, 'knowledge.stale', ctx, {}, { proposal_id: row.id, knowledge_id: hit.knowledge_id });
      if (row.state === 'gating') endGate(row, 'stale', ctx);
    }
  }

  // A proposal that stopped waiting for its gate by anything but the gate's own verdict: the gate
  // ends here, before anything of it is prepared, so that nothing it would carry goes out.
  function endGate(row: Pick<ProposalRow, 'gate_task_id'>, now: ProposalState, ctx: Ctx): void {
    if (row.gate_task_id !== null) options.endTask(row.gate_task_id, `提议已经不在把关中：${PROPOSAL_STATE_LABELS[now]}`, ctx);
  }

  // A waiting proposal whose change pinned one of these entries: what it would have changed is no
  // longer there, so it is stale by the same rule staleOthers applies when a pin moves (§3).
  // `except` are the proposals this deletion takes altogether: they need no staling.
  function danglingProposals(entryIds: ReadonlySet<string>, except: ReadonlySet<string>): ProposalRow[] {
    return db.all<ProposalRow>(`SELECT * FROM knowledge_proposal WHERE state IN ('gating', 'awaiting_owner')`).filter((row) => {
      if (except.has(row.id)) return false;
      const change = effectiveChange(row);
      return change.inputs.some(({ knowledge_id: id }) => entryIds.has(id))
        || change.outputs.some(({ revises }) => revises !== null && entryIds.has(revises));
    });
  }

  // The no-project tasks a project's deletion leaves pointless, with what each has left to work
  // on: the gate of every proposal it takes and of every waiting one left pinning a gone entry,
  // and the curations left naming one. One derivation for whether the project may be deleted (a
  // round of one still running is waited for) and for the deletion itself (§3).
  function sweptTasks(entryIds: ReadonlySet<string>, proposalIds: ReadonlySet<string>): SweptKnowledgeTask[] {
    const running = (taskId: string): boolean => db.get(`SELECT 1 FROM run WHERE task_id = ? AND state != 'ended'`, taskId) !== undefined;
    const ended = (taskId: string): boolean => {
      const row = db.get<{ state: string }>('SELECT state FROM task WHERE id = ?', taskId);
      return row !== undefined && (row.state === 'done' || row.state === 'abandoned');
    };
    const tasks = new Map<string, SweptKnowledgeTask>();
    const addGate = (gateTaskId: string | null): void => {
      if (gateTaskId === null || tasks.has(gateTaskId)) return;
      const row = db.get<{ project_id: string | null }>('SELECT project_id FROM task WHERE id = ?', gateTaskId);
      if (row === undefined || row.project_id !== null) return;
      tasks.set(gateTaskId, { task_id: gateTaskId, running: running(gateTaskId), ended: ended(gateTaskId), entries: null, reasons: null });
    };
    for (const id of proposalIds) {
      addGate(db.get<{ gate_task_id: string | null }>('SELECT gate_task_id FROM knowledge_proposal WHERE id = ?', id)?.gate_task_id ?? null);
    }
    for (const row of danglingProposals(entryIds, proposalIds)) addGate(row.gate_task_id);
    for (const row of db.all<{ id: string; knowledge_json: string | null }>(
      `SELECT id, knowledge_json FROM task WHERE project_id IS NULL AND json_extract(knowledge_json, '$.kind') = 'curation'`,
    )) {
      if (tasks.has(row.id)) continue;
      const job = parseKnowledgeTask(row.knowledge_json);
      if (job === null || job.kind !== 'curation') continue;
      const left = job.entries.filter((id) => !entryIds.has(id));
      if (left.length === job.entries.length) continue;
      tasks.set(row.id, { task_id: row.id, running: running(row.id), ended: ended(row.id), entries: left, reasons: job.reasons });
    }
    return [...tasks.values()];
  }

  // `proposalId` is the change that retired it; null when the owner retired it directly. `at` is
  // that change's own instant, so that history can be read back by it (proposalImpact).
  function retireIn(id: string, reason: string, replacedBy: string | null, ctx: Ctx, proposalId: string | null, at: string): void {
    db.run(`UPDATE knowledge SET state = 'retired', retired_at = ?, retired_by = ?, retired_reason = ?, replaced_by = ?, retired_proposal_id = ? WHERE id = ?`,
      at, ctx.actor, reason, replacedBy, proposalId, id);
  }

  // A change takes effect (§3), in the caller's transaction: its pins checked against what is in
  // force, its outputs written as revisions or new entries, its inputs retired or replaced, the
  // proposals that pinned what moved marked stale, and the curation threshold looked at. A moved
  // pin publishes nothing: the proposal is stale, with why. `reviewer` is the owner when the
  // owner wrote it or said yes to it.
  function publish(row: ProposalRow, change: Change, ctx: Ctx, reviewer: string | null): { state: ProposalState; reason?: string; entries: Record<string, string> } {
    const reason = moved(change);
    if (reason !== undefined) {
      db.run(`UPDATE knowledge_proposal SET state = 'stale', state_reason = ?, final_json = COALESCE(final_json, ?) WHERE id = ?`, reason, JSON.stringify(change), row.id);
      writeChange(db, 'knowledge.stale', ctx, {}, { proposal_id: row.id, reason });
      return { state: 'stale', reason, entries: {} };
    }
    const at = nowIso();
    const ids: Record<string, string> = {};
    const touched = new Set<string>();
    for (const output of change.outputs) {
      let id: string;
      let revision: number;
      if (output.revises !== null) {
        id = output.revises;
        revision = loadEntry(id)!.revision + 1;
        db.run('UPDATE knowledge SET revision = ?, kind = ? WHERE id = ?', revision, change.kind, id);
        touched.add(id);
      } else {
        id = ulid();
        revision = 1;
        db.run(`INSERT INTO knowledge (id, created_at, kind, revision, state) VALUES (?, ?, ?, 1, 'active')`, id, at, change.kind);
      }
      ids[output.key] = id;
      db.run(
        `INSERT INTO knowledge_revision (knowledge_id, revision, created_at, title, when_to_use, body, projects_json, loading, roles_json, search_phrases_json, proposal_id, published_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, revision, at, output.title, output.when_to_use, output.body,
        output.project_ids === null ? null : JSON.stringify(output.project_ids), output.loading, JSON.stringify(output.roles),
        JSON.stringify(output.search_phrases ?? []), row.id, ctx.actor,
      );
    }
    const retired: string[] = [];
    for (const input of change.inputs) {
      if (input.disposition === 'replaced') {
        const by = input.replaced_by === null ? null : (ids[input.replaced_by] ?? input.replaced_by);
        retireIn(input.knowledge_id, input.note || (by ? `被 ${by} 取代` : '已取代'), by, ctx, row.id, at);
      } else if (input.disposition === 'retire') {
        retireIn(input.knowledge_id, input.note || '已退役', null, ctx, row.id, at);
      } else {
        continue;
      }
      touched.add(input.knowledge_id);
      retired.push(input.knowledge_id);
    }
    db.run(
      `UPDATE knowledge_proposal SET state = 'published', state_reason = NULL, final_json = ?, published_at = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
      JSON.stringify({ ...change, outputs: change.outputs.map((output) => ({ ...output, knowledge_id: ids[output.key] })) }), at, reviewer === null ? null : at, reviewer, row.id,
    );
    staleOthers(touched, row.id, ctx);
    writeChange(db, 'knowledge.publish', ctx, {}, { proposal_id: row.id, entries: ids, retired, reviewed: reviewer !== null });
    options.afterPublish(ctx);
    return { state: 'published', entries: ids };
  }

  // The project a proposal came from: that of the round or Task it was made in, if any. A gate
  // or curation Task belongs to no project (§3); this is only where its material came from.
  function sourceOf(row: Pick<ProposalRow, 'task_id'>): string | null {
    return row.task_id === null ? null : db.get<{ project_id: string | null }>('SELECT project_id FROM task WHERE id = ?', row.task_id)?.project_id ?? null;
  }

  // The project of the round or Task a piece of evidence cites, when it cites one that is here.
  function evidenceProject({ source, ref }: Pick<Evidence, 'source' | 'ref'>): string | null {
    if (ref === null || ref === undefined) return null;
    const taskId = source === 'run' ? db.get<{ task_id: string }>('SELECT task_id FROM run WHERE id = ?', ref)?.task_id : source === 'task' ? ref : undefined;
    return taskId === undefined ? null : db.get<{ project_id: string | null }>('SELECT project_id FROM task WHERE id = ?', taskId)?.project_id ?? null;
  }

  // What a gate's or curation's round is handed, and the projects whose content that carries
  // (§3), in the order the projects were made. A gate's: the proposal (its change, whose inputs
  // are pinned revisions, its answers and evidence), the rejected earlier shape of the same
  // content, and the entries it touches or resembles. A curation's: its entries, each with the
  // evidence of the proposal behind it. The projects are everything any of that names — outputs,
  // inputs at the pinned and at the current revision, the project a proposal came from, and those
  // of the rounds and Tasks its evidence cites — and look-alikes are taken only from global
  // entries and those projects. Its rounds go only where every one of them allows.
  function knowledgeMaterial(job: KnowledgeTask): KnowledgeMaterial {
    const named = new Set<string>();
    const add = (ids: readonly (string | null)[] | null | undefined): void => { for (const id of ids ?? []) if (id !== null) named.add(id); };
    const fromChange = (change: Change): void => {
      for (const { project_ids } of change.outputs) add(project_ids);
      for (const { knowledge_id: id, revision } of change.inputs) {
        add(readRevision(id, revision)?.project_ids);
        add(loadEntry(id)?.project_ids);
      }
    };
    const fromProposal = (proposal: Proposal, row: Pick<ProposalRow, 'task_id'>): void => {
      add([sourceOf(row), ...proposal.evidence.map(evidenceProject)]);
    };
    const ordered = (): string[] => db.all<{ id: string }>('SELECT id FROM project ORDER BY rowid').map(({ id }) => id).filter((id) => named.has(id));
    if (job.kind === 'gate') {
      const row = loadProposal(job.proposal_id);
      const proposal = proposalOf(row);
      const prior = proposal.prior_rejection === null ? null : proposalOf(loadProposal(proposal.prior_rejection.id));
      fromChange(proposal.change);
      fromProposal(proposal, row);
      if (prior !== null) fromChange(prior.final ?? prior.change);
      const projects = ordered();
      return { kind: 'gate', proposal, prior, related: relatedTo(proposal.change, proposal.evidence, projects), source: sourceOf(row), projects };
    }
    const entries = job.entries.flatMap((id) => {
      const entry = loadEntry(id);
      if (entry === undefined) return [];
      const row = loadProposal(entry.proposal_id);
      const proposal = proposalOf(row);
      add(entry.project_ids);
      fromProposal(proposal, row);
      return [{ entry, evidence: proposal.evidence }];
    });
    return { kind: 'curation', entries, reasons: job.reasons, source: null, projects: ordered() };
  }

  // The entries a gate is shown beside a change (§3): those it touches, and a few active ones
  // of those whose scope meets its own, best first. `within`: the projects the material may
  // carry; an entry of another project is not handed over however much it resembles the change.
  function relatedTo(change: Change, evidence: readonly Pick<Evidenced, 'sha256'>[], within: readonly string[], limit = 5): Entry[] {
    const touched = change.inputs.map(({ knowledge_id: id }) => loadEntry(id)).filter((entry): entry is Entry => entry !== undefined);
    const scopes = change.outputs.map(({ project_ids }) => project_ids);
    const visible = (entry: Entry): boolean => entry.project_ids === null || entry.project_ids.some((id) => within.includes(id));
    const meets = (entry: Entry): boolean => visible(entry) && scopes.some((scope) => scope === null || entry.project_ids === null || scope.some((id) => entry.project_ids!.includes(id)));
    const words = pairs(change.outputs.map(({ title, when_to_use, body }) => `${title}${when_to_use}${body}`).join(''));
    const others = db.all<Joined>(`${ENTRY_SELECT} WHERE knowledge.state = 'active' ORDER BY knowledge.rowid`).map(joinedEntry)
      .filter((entry) => !touched.some(({ id }) => id === entry.id) && meets(entry))
      .map((entry) => ({ entry, score: similarity(words, pairs(`${entry.title}${entry.when_to_use}${entry.body}`)) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
    return [...touched, ...others, ...retiredMatches(change, evidence).filter(({ id }) => visible(loadEntry(id)!) && !touched.some((each) => each.id === id))];
  }

  function insertProposal(
    change: Change,
    why: Proposal['why'],
    evidence: readonly Evidence[],
    proposer: Proposer,
    requestId: string | null,
    ctx: Ctx,
    extra: { amendedFrom?: string; kept?: Evidenced[]; digest?: string } = {},
  ): ProposalRow {
    const id = ulid();
    const at = nowIso();
    const content = sha256(contentOf(change));
    const prior = db.get<{ id: string }>(`SELECT id FROM knowledge_proposal WHERE content_digest = ? AND state = 'rejected' ORDER BY rowid DESC LIMIT 1`, content);
    db.run(
      `INSERT INTO knowledge_proposal (id, created_at, kind, change_json, why_json, source, proposed_by, client_id, request_id, task_id, run_id,
         amended_from, digest, content_digest, prior_rejection_id, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gating')`,
      id, at, change.kind, JSON.stringify(change), JSON.stringify(why), proposer.source, proposer.by, proposer.client, requestId,
      proposer.taskId ?? null, proposer.runId ?? null, extra.amendedFrom ?? null, extra.digest ?? sha256(canonical(change, why, evidence)), content, prior?.id ?? null,
    );
    evidence.forEach((each, seq) => {
      const kept = extra.kept?.[seq];
      db.run(
        `INSERT INTO knowledge_evidence (id, created_at, proposal_id, seq, source, ref, location, excerpt, captured_at, sha256, submitted_by, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ulid(), at, id, seq, each.source, each.ref, each.location, each.excerpt, each.captured_at ?? at, sha256(each.excerpt),
        kept?.submitted_by ?? proposer.by, (kept ? kept.verified : verified(each.source, each.ref, each.excerpt)) ? 1 : 0,
      );
    });
    writeChange(db, 'knowledge.propose', ctx, { ...(proposer.taskId ? { taskId: proposer.taskId } : {}), ...(proposer.runId ? { runId: proposer.runId } : {}) }, {
      proposal_id: id, source: proposer.source, proposed_by: proposer.by, inputs: change.inputs.length, outputs: change.outputs.length,
      ...(extra.amendedFrom ? { amended_from: extra.amendedFrom } : {}), ...(prior ? { prior_rejection_id: prior.id } : {}),
    });
    return loadProposal(id);
  }

  // The one way in (§2, §3). The owner's own change takes effect at once, reviewed: the owner is
  // its gate. Any other gets its own gate task now, never batched, on an executor other than the
  // one that wrote it. A request id already used by this client gives back what it made the first
  // time; the same id with other content is refused.
  // Everything the entrance checks, and nothing written: what propose takes, and what a preview
  // asks so that it refuses the same way and for the same reason (§6, the skill import). A
  // request already taken is compared as it was frozen and answered as it was the first time;
  // only a first submission is checked against what is in force now.
  // Verify local evidence only within the caller's existing read authority. Output
  // publication scope never grants permission to inspect its proposed evidence.
  function requireEvidenceScope(evidence: readonly Evidence[], proposer: Proposer): void {
    if (proposer.source !== 'router' && proposer.source !== 'worker') return;
    let projects: string[];
    if (proposer.source === 'router') projects = proposer.projectId === undefined ? [] : [proposer.projectId];
    else {
      const task = proposer.taskId === undefined ? undefined : db.get<{project_id:string|null; knowledge_json:string|null}>('SELECT project_id, knowledge_json FROM task WHERE id=?', proposer.taskId);
      const job = parseKnowledgeTask(task?.knowledge_json);
      projects = task?.project_id != null ? [task.project_id] : job ? knowledgeMaterial(job).projects : [];
    }
    for (const item of evidence) {
      if (item.ref === null || !['run','task','owner'].includes(item.source)) continue;
      let project: string | null | undefined;
      if (item.source === 'run') {
        const row = db.get<{task_id:string;project_id:string|null}>('SELECT run.task_id, task.project_id FROM run JOIN task ON task.id=run.task_id WHERE run.id=?', item.ref);
        if (row && proposer.source === 'worker' && item.ref === proposer.runId && row.task_id === proposer.taskId) continue;
        project = row?.project_id;
      } else if (item.source === 'task') {
        const row = db.get<{project_id:string|null}>('SELECT project_id FROM task WHERE id=?',item.ref);
        if (row && proposer.source === 'worker' && item.ref === proposer.taskId) continue;
        project = row?.project_id;
      } else project = db.get<{project_id:string|null}>('SELECT project_id FROM message WHERE id=?',item.ref)?.project_id;
      if (project == null || !projects.includes(project)) {
        const label = item.source === 'run' ? 'Run' : item.source === 'task' ? '任务' : '消息';
        throw new InputError(`${label} 不存在（只看得到获授权项目的证据）`);
      }
    }
  }

  function admit(input: ProposalInput, proposer: Proposer):
    | { known: { id: string; state: ProposalState } }
    | { known?: undefined; requestId: string | null; why: Proposal['why']; evidence: Evidence[]; change: Change; digest: string } {
    const requestId = requestIdOf(input.request_id);
    const why = parseWhy(input.why);
    const evidence = parseEvidence(input.evidence, proposer.source === 'migration');
    requireEvidenceScope(evidence, proposer);
    const defaultProjectIds = defaultProjectIdsOf(proposer);
    const normalized = normalizeChange(input, defaultProjectIds);
    const digest = sha256(canonical(normalized, why, evidence));
    if (requestId !== null) {
      const known = db.get<{ id: string; digest: string; state: ProposalState }>('SELECT id, digest, state FROM knowledge_proposal WHERE client_id = ? AND request_id = ?', proposer.client, requestId);
      if (known) {
        if (known.digest !== digest) throw new InputError(`请求编号 ${requestId} 已经交过一份内容不同的提议（${known.id}）：换一个编号，或者用原来的内容重试`);
        return { known: { id: known.id, state: known.state } };
      }
    }
    return { requestId, why, evidence, change: parseChange(input, defaultProjectIds), digest };
  }

  const RUNTIME_ERROR_EXIT_KINDS = new Set(['failed', 'lost', 'timeout', 'quota', 'auth']);
  const IDENTIFIER_NUM_RE = /[a-z0-9]+(?:[._-][a-z0-9]+)*/gi;

  function numericSignature(text: string): string {
    const nums = (text.match(/\d+/g) ?? []).join(',');
    const ids = [...new Set((text.toLowerCase().match(IDENTIFIER_NUM_RE) ?? []).filter((t) => /\d/.test(t)))].sort().join(',');
    return `${nums}|${ids}`;
  }

  // Rule-first zero-token pre-filter (adapted from Octop Memory ADR-004 & ADR-041):
  // 1. Refuse Worker/Router proposals whose evidence is exclusively synthetic runtime/infra failures
  //    (skipped for MCP callers so write-only tokens never get a Run-status oracle).
  // 2. Detect exact/near-identical duplicates of active entries in identical `(kind, scope, roles)`
  //    for pure-new outputs so `propose()` merges cleanly (attaching evidence without spawning
  //    duplicate `knowledge` cards, while staying 100% zero-oracle for write-only MCP clients).
  function findRuleFirstDuplicate(change: Change, proposer: Proposer): Entry | null {
    if (proposer.source === 'console' || proposer.source === 'migration' || proposer.source === 'import' || proposer.source === 'curation') {
      return null;
    }
    if (change.inputs.length !== 0 || change.outputs.length !== 1 || change.outputs[0]!.revises !== null) {
      return null;
    }
    const output = change.outputs[0]!;
    const outScope = JSON.stringify(output.project_ids);
    const outRoles = JSON.stringify(output.roles);
    const outNormTitle = output.title.trim().toLowerCase().replace(/\s+/g, ' ');
    const outNormBody = output.body.trim().toLowerCase().replace(/\s+/g, ' ');
    const outTitleSig = numericSignature(output.title);
    const outTitleTokens = tokenizeForSearch(output.title);
    const outBodyTokens = tokenizeForSearch(output.body);
    const active = db.all<Joined>(`${ENTRY_SELECT} WHERE knowledge.state = 'active'`).map(joinedEntry);

    for (const existing of active) {
      if (existing.kind !== change.kind) continue;
      if (JSON.stringify(existing.project_ids) !== outScope) continue;
      if (JSON.stringify(existing.roles) !== outRoles) continue;
      const exNormTitle = existing.title.trim().toLowerCase().replace(/\s+/g, ' ');
      const exNormBody = existing.body.trim().toLowerCase().replace(/\s+/g, ' ');
      if (exNormTitle === outNormTitle && exNormBody === outNormBody) return existing;
      if (outNormBody.length >= 48 && exNormBody.length >= 48 && outTitleSig === numericSignature(existing.title)) {
        const bodySim = jaccardSimilarity(outBodyTokens, tokenizeForSearch(existing.body));
        const titleSim = jaccardSimilarity(outTitleTokens, tokenizeForSearch(existing.title));
        if (bodySim >= 0.92 && titleSim >= 0.85) return existing;
      }
    }
    return null;
  }

  function assertNoPureRuntimeErrorEvidence(evidence: readonly Evidence[], proposer: Proposer): void {
    if (proposer.source !== 'worker' && proposer.source !== 'router') return;
    if (evidence.length === 0 || !evidence.every((item) => item.source === 'run' && item.ref !== null)) return;
    for (const item of evidence) {
      const run = db.get<{ exit_kind: string | null; receipt_json: string | null }>(
        'SELECT exit_kind, receipt_json FROM run WHERE id = ?',
        item.ref!,
      );
      if (!run || !run.exit_kind || !RUNTIME_ERROR_EXIT_KINDS.has(run.exit_kind) || run.receipt_json !== null) {
        return;
      }
    }
    throw new InputError('纯运行报错/中断且无有效回执的轮次不能直接沉淀为长期知识；请基于已核实的根因和有效结论提交');
  }

  // Direct publication without spawning gate tasks: console proposals publish as reviewed;
  // non-console proposals pass rule-first pre-filter (blocking pure runtime errors & merging
  // exact/near-identical active duplicates instead of sprawling cards), then publish as
  // unreviewed unless an output is global + resident (which waits for owner confirmation).
  function propose(input: ProposalInput, proposer: Proposer, ctx: Ctx): { id: string; duplicate: boolean; state: ProposalState; merged_into?: string } {
    const admitted = admit(input, proposer);
    if (admitted.known) return { id: admitted.known.id, duplicate: true, state: admitted.known.state };
    const { requestId, why, evidence, change, digest } = admitted;
    assertNoPureRuntimeErrorEvidence(evidence, proposer);
    const dupTarget = findRuleFirstDuplicate(change, proposer);
    const row = insertProposal(change, why, evidence, proposer, requestId, ctx, { digest });
    if (proposer.source === 'console') {
      db.run(`UPDATE knowledge_proposal SET decided_at = ?, decided_by = ?, decided_via = 'console' WHERE id = ?`, nowIso(), ctx.actor, row.id);
      return { id: row.id, duplicate: false, state: publish(loadProposal(row.id), change, ctx, ctx.actor).state };
    }
    if (dupTarget !== null && ownerReasons(change).length === 0) {
      const at = nowIso();
      const mergedChange: Change = {
        ...change,
        outputs: change.outputs.map((output) => ({ ...output, knowledge_id: dupTarget.id })),
      };
      db.run(
        `UPDATE knowledge_proposal SET state = 'published', state_reason = ?, final_json = ?, final_digest = ?, published_at = ? WHERE id = ?`,
        `规则预筛合并至现有条目 ${citation(dupTarget.id, dupTarget.revision)}（保留新证据，避免重复建卡）`,
        JSON.stringify(mergedChange),
        sha256(canonical(mergedChange, why, evidence)),
        at,
        row.id,
      );
      writeChange(db, 'knowledge.merge_duplicate', ctx, {}, {
        proposal_id: row.id, merged_into: dupTarget.id, revision: dupTarget.revision,
      });
      return { id: row.id, duplicate: false, state: 'published', merged_into: dupTarget.id };
    }
    const state = afterPass(loadProposal(row.id), change, ctx);
    return { id: row.id, duplicate: false, state };
  }

  // Publishes immediately (unreviewed) unless an output is global + resident, in which case
  // it waits for owner confirmation.
  function afterPass(row: ProposalRow, change: Change, ctx: Ctx): ProposalState {
    const reasons = ownerReasons(change);
    db.run('UPDATE knowledge_proposal SET final_json = ?, final_digest = ?, owner_reasons_json = ? WHERE id = ?',
      JSON.stringify(change), sha256(canonical(change, JSON.parse(row.why_json) as Proposal['why'], evidenceOf(row.id))), JSON.stringify(reasons), row.id);
    if (reasons.length === 0 || moved(change) !== undefined) return publish(loadProposal(row.id), change, ctx, null).state;
    db.run(`UPDATE knowledge_proposal SET state = 'awaiting_owner' WHERE id = ?`, row.id);
    writeChange(db, 'knowledge.awaiting_owner', ctx, {}, { proposal_id: row.id, reasons });
    options.enqueue('wecom', 'knowledge_proposal', { proposal_id: row.id });
    return 'awaiting_owner';
  }

  // What a gate or curation round handed back (§3, §5.3), in its settlement's transaction.
  // Returns why it cannot be taken — a short delivery — or null when it was applied. A round
  // whose proposal is no longer being gated is recorded and changes nothing.
  function settleKnowledgeTask(task: { id: string; knowledge_json: string | null }, runId: string, value: unknown, ctx: Ctx): string | null {
    const job = parseKnowledgeTask(task.knowledge_json);
    if (job === null) return null;
    const verdict = (value ?? {}) as { result?: unknown; reason?: unknown; change?: unknown };
    if (verdict.result !== 'pass' && verdict.result !== 'reject') return '回执里没有 knowledge_verdict，或者它的 result 不是 pass、reject';
    if (isBlank(verdict.reason)) return 'knowledge_verdict 要写理由（reason）';
    const reason = (verdict.reason as string).trim();
    try {
      if (job.kind === 'gate') {
        const row = loadProposal(job.proposal_id);
        if (row.state !== 'gating' || row.gate_task_id !== task.id) {
          writeChange(db, 'knowledge.gate_ignored', ctx, { taskId: task.id, runId }, { proposal_id: row.id, state: row.state });
          return null;
        }
        const modified = verdict.result === 'pass' && verdict.change !== undefined && verdict.change !== null;
        const change = modified ? parseChange({ kind: row.kind, ...(verdict.change as object) }) : (JSON.parse(row.change_json) as Change);
        const gate: GateVerdict = { result: verdict.result, reason, modified, task_id: task.id, run_id: runId };
        db.run('UPDATE knowledge_proposal SET gate_json = ? WHERE id = ?', JSON.stringify(gate), row.id);
        writeChange(db, `knowledge.gate_${verdict.result}`, ctx, { taskId: task.id, runId }, { proposal_id: row.id, modified });
        if (verdict.result === 'reject') {
          db.run(`UPDATE knowledge_proposal SET state = 'rejected', state_reason = ?, decided_at = ?, decided_by = ?, decided_via = 'gate' WHERE id = ?`, reason, nowIso(), task.id, row.id);
          return null;
        }
        afterPass(loadProposal(row.id), change, ctx);
        return null;
      }
      // A curation round is its own independent gate (§5.3): what it hands back is published by
      // the same rules, with no gate of its own.
      if (verdict.result === 'reject') {
        writeChange(db, 'knowledge.curation_nothing', ctx, { taskId: task.id, runId }, { reason });
        return null;
      }
      if (verdict.change === undefined || verdict.change === null) return '整理通过要交出变更（knowledge_verdict.change）；没有值得改的就写 reject';
      const raw = verdict.change as ProposalInput;
      const change = parseChange(raw);
      const evidence = parseEvidence(raw.evidence);
      const row = insertProposal(change, parseWhy(raw.why), evidence, { source: 'curation', by: task.id, client: `task:${task.id}`, writers: [], taskId: task.id, runId }, null, ctx);
      db.run('UPDATE knowledge_proposal SET gate_json = ? WHERE id = ?', JSON.stringify({ result: 'pass', reason, modified: false, task_id: task.id, run_id: runId } satisfies GateVerdict), row.id);
      afterPass(loadProposal(row.id), change, ctx);
      return null;
    } catch (err) {
      if (err instanceof InputError) return `knowledge_verdict 里的变更不成立：${err.message}`;
      throw err;
    }
  }

  // Ephemeral SQLite FTS5 index kept automatically synchronized with the canonical knowledge table
  // using a fast ledger watermark (handles normal mutations and external/test SQL updates alike).
  let ftsIndex: FtsIndex | null = null;
  let ftsWatermark = '';
  let ftsEntries = new Map<string, Entry>();

  function syncFtsIndex(): { index: FtsIndex; entries: Map<string, Entry> } {
    const stats = db.get<{ cnt: number; rev_sum: number; retired_cnt: number; max_rev_rowid: number }>(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(revision), 0) AS rev_sum,
              COALESCE(SUM(CASE WHEN state = 'retired' THEN 1 ELSE 0 END), 0) AS retired_cnt,
              COALESCE((SELECT MAX(rowid) FROM knowledge_revision), 0) AS max_rev_rowid
         FROM knowledge`,
    );
    const mark = `${stats?.cnt ?? 0}:${stats?.rev_sum ?? 0}:${stats?.retired_cnt ?? 0}:${stats?.max_rev_rowid ?? 0}`;
    if (ftsIndex !== null && ftsWatermark === mark) {
      return { index: ftsIndex, entries: ftsEntries };
    }
    const all = db.all<Joined>(`${ENTRY_SELECT} ORDER BY knowledge.rowid`).map(joinedEntry);
    if (ftsIndex === null) ftsIndex = new FtsIndex();
    ftsIndex.rebuild(
      all.map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: entry.when_to_use,
        body: entry.body,
        phrases: entry.search_phrases ?? [],
      })),
    );
    ftsEntries = new Map(all.map((entry) => [entry.id, entry]));
    ftsWatermark = mark;
    return { index: ftsIndex, entries: ftsEntries };
  }

  return {
    propose(input: ProposalInput, proposer: Proposer, ctx: Ctx): { id: string; duplicate: boolean; state: ProposalState; merged_into?: string } {
      return write(() => propose(input, proposer, ctx));
    },

    // Whether propose would take this, by the same checks, writing nothing: the proposal a
    // request already made, or nothing for a new one. Throws the refusal propose would.
    checkProposal(input: ProposalInput, proposer: Proposer): { id: string; state: ProposalState } | undefined {
      return admit(input, proposer).known;
    },

    // A receipt's optional `learned` (§2): proposals from the round that wrote them, and only
    // that. Inside the settlement's transaction, and never its undoing: what does not parse is
    // recorded as such and the round settles as it would have without it. Each item is a change
    // of the same shape every entrance takes.
    proposeFromReceipt(run: { id: string; task_id: string }, writer: string | undefined, learned: unknown): void {
      if (learned === undefined || learned === null) return;
      const items = Array.isArray(learned) ? learned : [learned];
      const ctx: Ctx = { actor: 'runner' };
      items.forEach((raw, index) => {
        try {
          if (index >= MAX_LEARNED) throw new InputError(`一轮最多交 ${MAX_LEARNED} 条经验`);
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('learned 的每一项要是一个对象');
          // All of it or none of it: a refusal after its first write undoes what it wrote.
          db.savepoint(() => propose({ ...(raw as ProposalInput), request_id: `learned:${index}` }, {
            source: 'worker', by: run.id, client: `run:${run.id}`, writers: writer === undefined ? [] : [writer], taskId: run.task_id, runId: run.id,
          }, ctx));
        } catch (err) {
          if (!(err instanceof InputError)) throw err;
          writeChange(db, 'knowledge.learned_refused', ctx, { taskId: run.task_id, runId: run.id }, { index, reason: err.message });
        }
      });
    },

    settleKnowledgeTask,

    // The owner's say on a pending proposal (`gating` or `awaiting_owner`). `digest` pin is optional.
    decideProposal(proposalId: string, decision: { decision: 'approve' | 'reject'; digest?: string; note?: string; via: string }, ctx: Ctx): { state: ProposalState; entries: Record<string, string> } {
      return write(() => {
        const row = loadProposal(proposalId);
        if (row.state !== 'awaiting_owner' && row.state !== 'gating') throw new InputError(`这份提议${PROPOSAL_STATE_LABELS[row.state]}，不能再处理${row.next_id ? `：新的候选是 ${row.next_id}` : ''}`);
        const expectedDigest = row.final_digest ?? row.digest;
        if (decision.digest !== undefined && decision.digest !== '' && decision.digest !== expectedDigest) {
          throw new InputError('你看到的不是这份变更现在的内容：重新打开它，看过全文、差异和证据再处理');
        }
        if (decision.decision !== 'approve' && decision.decision !== 'reject') throw new InputError('只能同意或驳回');
        const wasGating = row.state === 'gating';
        const note = decision.note?.trim() || null;
        if (note !== null) assertNoSecrets(note, '审批备注');
        db.run('UPDATE knowledge_proposal SET decided_at = ?, decided_by = ?, decided_via = ?, decision_note = ? WHERE id = ?', nowIso(), ctx.actor, decision.via, note, row.id);
        if (decision.decision === 'reject') {
          db.run(`UPDATE knowledge_proposal SET state = 'rejected', state_reason = ? WHERE id = ?`, note ?? '主人没有同意', row.id);
          writeChange(db, 'knowledge.reject', ctx, {}, { proposal_id: row.id, via: decision.via });
          if (wasGating) endGate(row, 'rejected', ctx);
          return { state: 'rejected' as const, entries: {} };
        }
        const result = publish(loadProposal(row.id), effectiveChange(row), ctx, ctx.actor);
        if (wasGating) endGate(row, result.state, ctx);
        return { state: result.state, entries: result.entries };
      });
    },

    // Abandoning a gate task directly settles its waiting proposal as rejected in the same
    // transaction so no zombie `gating` proposal is left behind.
    abandonGateTask(taskId: string, reason: string, ctx: Ctx): void {
      const row = db.get<ProposalRow>(`SELECT * FROM knowledge_proposal WHERE gate_task_id = ? AND state = 'gating'`, taskId);
      if (!row) return;
      const note = reason.trim() || '主人放弃把关任务';
      db.run(
        `UPDATE knowledge_proposal SET state = 'rejected', state_reason = ?, decided_at = ?, decided_by = ?, decided_via = 'task_abandon', decision_note = ? WHERE id = ?`,
        note, nowIso(), ctx.actor, note, row.id,
      );
      writeChange(db, 'knowledge.reject', ctx, { taskId }, { proposal_id: row.id, via: 'task_abandon', reason: note });
    },

    // The owner changes a proposal that is still waiting: the owner's own change, which takes
    // effect at once, reviewed (§3); the one it came from is superseded.
    amendProposal(proposalId: string, raw: ChangeRaw, ctx: Ctx): string {
      return write(() => {
        const row = loadProposal(proposalId);
        if (row.state !== 'gating' && row.state !== 'awaiting_owner') throw new InputError(`这份提议${PROPOSAL_STATE_LABELS[row.state]}，不能再改`);
        const change = parseChange({ kind: row.kind, inputs: raw.inputs, outputs: raw.outputs });
        const was = proposalOf(row);
        const next = insertProposal(change, was.why, was.evidence, { source: 'console', by: row.proposed_by, client: 'console', writers: [] }, null, ctx, { amendedFrom: row.id, kept: was.evidence });
        const at = nowIso();
        db.run(`UPDATE knowledge_proposal SET state = 'superseded', next_id = ?, decided_at = ?, decided_by = ?, decided_via = 'console' WHERE id = ?`, next.id, at, ctx.actor, row.id);
        if (row.state === 'gating') endGate(row, 'superseded', ctx);
        db.run(`UPDATE knowledge_proposal SET decided_at = ?, decided_by = ?, decided_via = 'console' WHERE id = ?`, at, ctx.actor, next.id);
        publish(loadProposal(next.id), change, ctx, ctx.actor);
        return next.id;
      });
    },

    // After the fact (§3): the owner has looked at a change that took effect unreviewed.
    markReviewed(proposalId: string, ctx: Ctx): void {
      write(() => {
        const row = loadProposal(proposalId);
        if (row.state !== 'published') throw new InputError(`这份提议${PROPOSAL_STATE_LABELS[row.state]}，没有生效的内容可审`);
        if (row.reviewed_at !== null) return;
        db.run('UPDATE knowledge_proposal SET reviewed_at = ?, reviewed_by = ? WHERE id = ?', nowIso(), ctx.actor, row.id);
        writeChange(db, 'knowledge.review', ctx, {}, { proposal_id: row.id });
      });
    },

    // Batch-mark every published, unreviewed proposal as reviewed in one transaction.
    markAllReviewed(actorOrCtx: string | Ctx): { count: number } {
      const ctx: Ctx = typeof actorOrCtx === 'string' ? { actor: actorOrCtx } : actorOrCtx;
      return write(() => {
        const rows = db.all<{ id: string }>(
          `SELECT id FROM knowledge_proposal WHERE state = 'published' AND reviewed_at IS NULL ORDER BY rowid`,
        );
        if (rows.length === 0) return { count: 0 };
        const at = nowIso();
        db.run(
          `UPDATE knowledge_proposal SET reviewed_at = ?, reviewed_by = ? WHERE state = 'published' AND reviewed_at IS NULL`,
          at, ctx.actor,
        );
        writeChange(db, 'knowledge.review_all', ctx, {}, { count: rows.length, proposal_ids: rows.map(({ id }) => id) });
        return { count: rows.length };
      });
    },

    // Retiring an active entry; `reason` and `revision` pin are optional for all actors.
    retireEntry(id: string, fields: { reason?: unknown; replacedBy?: unknown; revision?: unknown }, ctx: Ctx): void {
      write(() => {
        const entry = requireEntry(id);
        if (entry.state !== 'active') throw new InputError(`条目 ${id} 已经退役`);
        if (fields.revision !== undefined && fields.revision !== null && fields.revision !== entry.revision) {
          throw new InputError(`条目 ${id} 现在是修订 ${entry.revision}：看一遍现在的再退役`);
        }
        if (fields.reason !== undefined && fields.reason !== null && typeof fields.reason !== 'string') {
          throw new InputError('退役理由要是字符串');
        }
        const trimmedReason = typeof fields.reason === 'string' ? fields.reason.trim() : '';
        if (trimmedReason !== '') assertNoSecrets(trimmedReason, '退役理由');
        const reason = trimmedReason !== '' ? trimmedReason : (ctx.actor === 'console' ? '主人退役' : '已退役');
        const replaced = fields.replacedBy === undefined || fields.replacedBy === null || fields.replacedBy === '' ? null : requireEntry(fields.replacedBy, '替代条目').id;
        if (replaced === id) throw new InputError('一条不能被它自己替代');
        retireIn(id, reason, replaced, ctx, null, nowIso());
        staleOthers(new Set([id]), '', ctx);
        writeChange(db, 'knowledge.retire', ctx, {}, { knowledge_id: id, revision: entry.revision, reason, replaced_by: replaced });
        options.afterPublish(ctx);
      });
    },

    // A gate or curation Task as the pages and the dispatcher see it: what it works on, the
    // project it came from, and the projects its material carries.
    knowledgeMaterial,

    // §3: what a project's deletion leaves pointless among the no-project knowledge tasks, with
    // whether a round of each runs now. The delete decision waits for those rounds; the deletion
    // ends the tasks. Read-only, so the console's project list can ask it.
    knowledgeTasksSweptBy(entryIds: readonly string[], proposalIds: readonly string[]): SweptKnowledgeTask[] {
      return sweptTasks(new Set(entryIds), new Set(proposalIds));
    },

    // Ends them, in the deletion's transaction. A waiting proposal left pinning a gone entry is
    // stale, and its gate ends with it — the same path a pin that moves takes; a curation loses
    // the gone entries and is given up when it has nothing left. What pointed at the gone rows is
    // dropped, never left naming them, so no page reads a dead id out of `knowledge_json`.
    sweepKnowledgeTasks(entryIds: readonly string[], proposalIds: readonly string[], reason: string, ctx: Ctx): void {
      const gone = new Set(entryIds);
      const taken = new Set(proposalIds);
      // Read before anything is staled: what a gate task is given up for is a proposal that still
      // waits, and staling it below takes it out of that set.
      const swept = sweptTasks(gone, taken);
      for (const row of danglingProposals(gone, taken)) {
        db.run(`UPDATE knowledge_proposal SET state = 'stale', state_reason = ? WHERE id = ?`, reason, row.id);
        writeChange(db, 'knowledge.stale', ctx, {}, { proposal_id: row.id, reason });
        if (row.state === 'gating') endGate(row, 'stale', ctx);
      }
      for (const each of swept) {
        if (each.entries === null || each.entries.length === 0) {
          // A gate whose proposal goes, or a curation left with nothing: given up, and its
          // `knowledge_json` dropped so no page reads a dead id out of it.
          options.endTask(each.task_id, reason, ctx);
          db.run('UPDATE task SET knowledge_json = NULL WHERE id = ?', each.task_id);
        } else {
          db.run('UPDATE task SET knowledge_json = ? WHERE id = ?',
            JSON.stringify({ kind: 'curation', entries: each.entries, reasons: each.reasons ?? [] } satisfies KnowledgeTask), each.task_id);
        }
      }
    },

    describeKnowledgeTask(job: KnowledgeTask) {
      const { source, projects } = knowledgeMaterial(job);
      return job.kind === 'gate'
        ? { kind: job.kind, proposal_id: job.proposal_id, source_project_id: source, projects }
        : { kind: job.kind, entries: job.entries, source_project_id: source, projects };
    },

    getProposal(id: string): Proposal {
      return proposalOf(loadProposal(id));
    },

    listProposals(filter: { state?: ProposalState } = {}): Proposal[] {
      const rows = filter.state === undefined
        ? db.all<ProposalRow>('SELECT * FROM knowledge_proposal ORDER BY rowid DESC')
        : db.all<ProposalRow>('SELECT * FROM knowledge_proposal WHERE state = ? ORDER BY rowid DESC', filter.state);
      return rows.map(proposalOf);
    },

    // What took effect without the owner having seen it, oldest first: the owner's list (§3).
    reviewQueue(): Proposal[] {
      return db.all<ProposalRow>(`SELECT * FROM knowledge_proposal WHERE state = 'published' AND reviewed_at IS NULL ORDER BY rowid`).map(proposalOf);
    },

    getEntry: loadEntry,

    retiredMatches,

    // The entries in force at an instant, as the revisions and retirements recorded then make
    // them: `inclusive` takes in what happened at that very instant. How a published change's
    // before and after are read back (§5.2), rather than simulated again on today's entries.
    entriesAt(at: string, inclusive: boolean): Entry[] {
      const before = (when: string | null): boolean => when !== null && (inclusive ? when <= at : when < at);
      return db.all<EntryRow>('SELECT * FROM knowledge ORDER BY rowid').flatMap((entry) => {
        if (before(entry.retired_at)) return [];
        const rows = db.all<RevisionRow & { published_at: string | null }>(`${REVISION_SELECT} WHERE knowledge_id = ? ORDER BY revision`, entry.id).filter(({ created_at }) => before(created_at));
        const row = rows.at(-1);
        if (!row) return [];
        return [{ ...revisionOf(row, entry.kind), created_at: entry.created_at, state: 'active' as const, retired_at: null, retired_by: null, retired_reason: null, replaced_by: null }];
      });
    },

    listEntries(filter: { includeRetired?: boolean } = {}): Entry[] {
      return db.all<Joined>(`${ENTRY_SELECT}${filter.includeRetired ? '' : ` WHERE knowledge.state = 'active'`} ORDER BY knowledge.rowid`).map(joinedEntry);
    },

    // Every revision an entry has had, the one in force last.
    revisionsOf(id: string): Revision[] {
      const entry = db.get<EntryRow>('SELECT * FROM knowledge WHERE id = ?', id);
      if (!entry) return [];
      return db.all<RevisionRow & { published_at: string | null }>(`${REVISION_SELECT} WHERE knowledge_id = ? ORDER BY revision`, id).map((row) => revisionOf(row, entry.kind));
    },

    readRevision,

    // What a change would leave in force: the active entries with its outputs applied and its
    // retirements taken out. For showing what it costs before it is decided (§5.2).
    entriesAfter(change: Change): Entry[] {
      const active = db.all<Joined>(`${ENTRY_SELECT} WHERE knowledge.state = 'active' ORDER BY knowledge.rowid`).map(joinedEntry);
      const leaving = new Set(change.inputs.filter(({ disposition }) => disposition === 'retire' || disposition === 'replaced').map(({ knowledge_id: id }) => id));
      const revised = new Map(change.outputs.filter(({ revises }) => revises !== null).map((output) => [output.revises!, output]));
      const as = (base: Entry, output: ChangeOutput): Entry => ({ ...base, revision: base.revision + 1, title: output.title, when_to_use: output.when_to_use, body: output.body, project_ids: output.project_ids, loading: output.loading, roles: output.roles });
      const kept = active.filter(({ id }) => !leaving.has(id)).map((entry) => (revised.has(entry.id) ? as(entry, revised.get(entry.id)!) : entry));
      const added = change.outputs.filter(({ revises }) => revises === null).map((output): Entry => ({
        id: `(${output.key})`, revision: 1, kind: change.kind, title: output.title, when_to_use: output.when_to_use, body: output.body,
        project_ids: output.project_ids, loading: output.loading, roles: output.roles, proposal_id: '', published_by: '', published_at: '',
        reviewed_at: null, created_at: '', state: 'active', retired_at: null, retired_by: null, retired_reason: null, replaced_by: null,
      }));
      return [...kept, ...added];
    },

    // What applies to a round of this project and role, in the order the brief lists it (§4.1):
    // knowledge before skills; in each, global before project, and in each group the entries for
    // any role before the ones narrowed to this role. Entries of other projects, or narrowed to
    // other roles, are not here. `from` is the entries to choose among: those in force, unless a
    // change is being weighed. The set a round is given, skills and all: one comparable set.
    applicable(projectId: string | null, roleId: string | null, from?: readonly Entry[]): Entry[] {
      const rows = from ?? db.all<Joined>(`${ENTRY_SELECT} WHERE knowledge.state = 'active' ORDER BY knowledge.rowid`).map(joinedEntry);
      const fits = rows.filter(({ state, project_ids: projects, roles }) => state === 'active' && (projects === null || (projectId !== null && projects.includes(projectId)))
        && (roles.length === 0 || (roleId !== null && roles.includes(roleId))));
      const rank = ({ kind, project_ids: projects, roles }: Entry): number => (kind === 'skill' ? 4 : 0) + (projects === null ? 0 : 2) + (roles.length === 0 ? 0 : 1);
      return fits.map((entry, at) => ({ entry, at })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.at - b.at).map(({ entry }) => entry);
    },

    // A search in a range the caller names (§4.3): the global entries, or one project's — never
    // "everything" by leaving it out. Native SQLite FTS5 + CJK/Latin hybrid tokenization +
    // search_phrases + coverage floor + optional snapshot-bound deduplication (`excludeIds`).
    searchLibrary(fields: { query: string; scope: 'global' | { projectId: string }; roleId?: string | null; kind?: KnowledgeKind | null; includeRetired?: boolean; cursor?: string | null; limit?: number; minCoverage?: number; excludeIds?: readonly string[] }): Page<Entry> {
      const query = fields.query.trim();
      if (query === '') throw new InputError('要写查什么');
      const limit = Math.min(Math.max(fields.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
      const offset = fields.cursor === undefined || fields.cursor === null || fields.cursor === '' ? 0 : Number(fields.cursor);
      if (!Number.isInteger(offset) || offset < 0) throw new InputError(`翻页位置不对：${String(fields.cursor)}`);
      const scope = fields.scope;
      if (scope !== 'global' && !db.get('SELECT 1 FROM project WHERE id = ?', scope.projectId)) throw new InputError(`项目不存在：${scope.projectId}`);
      const excluded = new Set(fields.excludeIds ?? []);
      const { index, entries } = syncFtsIndex();
      const allowedIds = new Set<string>();
      for (const entry of entries.values()) {
        if (!fields.includeRetired && entry.state !== 'active') continue;
        if (excluded.has(entry.id)) continue;
        if (scope === 'global' ? entry.project_ids !== null : entry.project_ids?.includes(scope.projectId) !== true) continue;
        if (fields.roleId && entry.roles.length > 0 && !entry.roles.includes(fields.roleId)) continue;
        if (fields.kind && entry.kind !== fields.kind) continue;
        allowedIds.add(entry.id);
      }
      if (allowedIds.size === 0) return { items: [], next: null, total: 0 };
      const ranked = index.search(query, {
        limit: allowedIds.size,
        allowedIds,
        ...(fields.minCoverage === undefined ? {} : { minCoverage: fields.minCoverage }),
      });
      const all = ranked.map((hit) => entries.get(hit.id)!).filter(Boolean);
      const items = all.slice(offset, offset + limit);
      return { items, next: offset + limit < all.length ? String(offset + limit) : null, total: all.length };
    },

    // A curation task for these entries (§5.3), or the one already open for any of them, which
    // takes them in while it has not started. Returns the Task. In the caller's transaction. Like
    // a gate, it belongs to no project.
    curate(fields: { entries: readonly string[]; reason: string }, ctx: Ctx): string {
      return write(() => {
        if (fields.entries.length === 0) throw new InputError('要整理哪些条目：至少一条');
        if (isBlank(fields.reason)) throw new InputError('要写为什么整理');
        const entries = fields.entries.map((id) => requireEntry(id));
        const entryIds = [...new Set(entries.map(({ id }) => id))];
        const reason = fields.reason.trim();
        const open = db.all<{ id: string; state: string; knowledge_json: string }>(
          `SELECT id, state, knowledge_json FROM task WHERE json_extract(knowledge_json, '$.kind') = 'curation' AND state NOT IN ('done', 'abandoned') ORDER BY rowid`);
        for (const task of open) {
          const job = parseKnowledgeTask(task.knowledge_json) as Extract<KnowledgeTask, { kind: 'curation' }>;
          if (!job.entries.some((id) => entryIds.includes(id))) continue;
          // One already under way works on what its snapshot carried: reuse it only when it
          // already covers every requested entry and reason; otherwise continue to a waiting
          // follow-up task or create one so nothing is silently dropped.
          if (['running', 'stopping', 'needs_verification', 'ready'].includes(task.state)) {
            if (entryIds.every((id) => job.entries.includes(id)) && job.reasons.includes(reason)) return task.id;
            continue;
          }
          const merged = { kind: 'curation' as const, entries: [...new Set([...job.entries, ...entryIds])], reasons: [...new Set([...job.reasons, reason])] };
          if (merged.entries.length === job.entries.length && merged.reasons.length === job.reasons.length) return task.id;
          db.run('UPDATE task SET knowledge_json = ? WHERE id = ?', JSON.stringify(merged), task.id);
          writeChange(db, 'knowledge.curation_merge', ctx, { taskId: task.id }, { entries: entryIds, reason });
          return task.id;
        }
        return options.createTask({
          title: `整理知识：${reason}`,
          goal: '整理一组知识或技能条目：去掉重复、收窄写过头的、放错作用域或加载方式的改过来，必要时合并、拆分或退役。材料在这一轮的快照里。',
          acceptance: '回执里交出结论：一份变更（通过），或者没有值得改的（驳回并说明）。',
          knowledge: { kind: 'curation', entries: entryIds, reasons: [reason] },
        }, ctx);
      });
    },

    // ---- Knowledge MCP clients (§4.3). The ledger keeps who they are and a hash; the token
    // itself is a Secret, kept beside the ledger and shown to the owner only. The executor the
    // session runs on is what its proposals' gates may not run on.
    addClient(fields: { name: unknown; executor: unknown; grants: unknown }, executors: readonly string[], ctx: Ctx): { id: string; token: string } {
      const name = text(fields.name, '名字', MAX_TITLE_CHARS);
      if (typeof fields.executor !== 'string' || !executors.includes(fields.executor)) throw new InputError(`执行器要写明是哪一个：${executors.join('、')}`);
      const grants = Array.isArray(fields.grants) ? [...new Set(fields.grants)] : [];
      if (grants.length === 0 || grants.some((each) => !(GRANTS as readonly unknown[]).includes(each))) throw new InputError(`授权要从 ${GRANTS.join('、')} 里选，至少一项`);
      const id = ulid();
      const token = randomBytes(32).toString('hex');
      write(() => {
        db.run('INSERT INTO knowledge_client (id, created_at, name, executor, grants_json, token_hash) VALUES (?, ?, ?, ?, ?, ?)', id, nowIso(), name, fields.executor as string, JSON.stringify(grants), sha256(token));
        writeChange(db, 'knowledge.client_add', ctx, {}, { client_id: id, name, executor: fields.executor, grants });
      });
      return { id, token };
    },

    revokeClient(id: string, ctx: Ctx): void {
      write(() => {
        const row = db.get<{ revoked_at: string | null }>('SELECT revoked_at FROM knowledge_client WHERE id = ?', id);
        if (!row) throw new InputError(`没有这个客户端：${id}`);
        if (row.revoked_at !== null) return;
        db.run('UPDATE knowledge_client SET revoked_at = ? WHERE id = ?', nowIso(), id);
        writeChange(db, 'knowledge.client_revoke', ctx, {}, { client_id: id });
      });
    },

    rotateClient(id: string, ctx: Ctx): { id: string; token: string } {
      const token = randomBytes(32).toString('hex');
      write(() => {
        const row = db.get<{ revoked_at: string | null; name: string }>('SELECT revoked_at, name FROM knowledge_client WHERE id = ?', id);
        if (!row) throw new InputError(`没有这个客户端：${id}`);
        if (row.revoked_at !== null) throw new InputError(`客户端 ${row.name} 已吊销，无法轮换令牌`);
        db.run('UPDATE knowledge_client SET token_hash = ? WHERE id = ?', sha256(token), id);
        writeChange(db, 'knowledge.client_rotate', ctx, {}, { client_id: id, name: row.name });
      });
      return { id, token };
    },

    touchClient(id: string): void {
      try {
        db.run('UPDATE knowledge_client SET last_used_at = ?, request_count = request_count + 1 WHERE id = ? AND revoked_at IS NULL', nowIso(), id);
      } catch {
        // Telemetry write is best-effort and never blocks an MCP call.
      }
    },

    listClients(): KnowledgeClient[] {
      return db.all<{ id: string; created_at: string; name: string; executor: string; grants_json: string; revoked_at: string | null; last_used_at: string | null; request_count: number }>('SELECT * FROM knowledge_client ORDER BY rowid')
        .map(({ grants_json, ...row }) => ({ ...row, grants: JSON.parse(grants_json) as Grant[] }));
    },

    // The client a token belongs to, while it is not revoked.
    clientByToken(token: string): KnowledgeClient | undefined {
      if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
      const row = db.get<{ id: string; created_at: string; name: string; executor: string; grants_json: string; revoked_at: string | null; last_used_at: string | null; request_count: number }>(
        'SELECT * FROM knowledge_client WHERE token_hash = ? AND revoked_at IS NULL', sha256(token));
      return row && { id: row.id, created_at: row.created_at, name: row.name, executor: row.executor, grants: JSON.parse(row.grants_json) as Grant[], revoked_at: null, last_used_at: row.last_used_at, request_count: row.request_count };
    },

    closeSearchIndex(): void {
      ftsIndex?.close();
      ftsIndex = null;
      ftsWatermark = '';
    },
  };
}

export type Knowledge = ReturnType<typeof createKnowledge>;

// The set of revisions a round was given, as one comparable text: a round whose set differs
// from the previous one's starts its executor afresh (§4.1).
export const revisionSet = (entries: readonly { id: string; revision: number }[]): string => entries.map(({ id, revision }) => citation(id, revision)).join(',');
