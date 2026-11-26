// Offline self-explaining Run diagnostics bundle builder.
// Pure aggregation over ledger rows, trace, normalized display events and stderr slices:
// never mutates state, never leaks secrets, and honestly reports incomplete coverage.
import { ADAPTERS } from '../adapters/all.ts';
import type { NormalizedEvent, Tier } from '../adapters/types.ts';
import { HIDDEN_TEXT } from '../runner/redact.ts';
import { redactWorkerDiagnosticText } from './router-call-text.ts';
import type { Loading } from '../shared/knowledge.ts';
import { isConfigKind, type MachineInputs } from '../shared/machine-inputs.ts';
import {
  codeCheckText,
  isDeliverableId,
  isPermissionId,
  isReadOnlyLayer,
  type CodeCheck,
  type RoleConfig,
  type RunAccess,
  type TierSource,
} from '../shared/roles.ts';
import type {
  DiagnosticCoverage,
  DiagnosticFirstError,
  FailedTool,
  ModelEvidence,
  RunDiagnosticsBundle,
  RunTrace,
  SafeKnowledgeProjection,
  SafeLoginProjection,
  SafeSnapshotProjection,
  ToolSummary,
  UnfinishedTool,
} from '../shared/run-diagnostics.ts';
import type { SnapshotSource } from '../shared/sources.ts';
import { isTierId } from '../shared/tiers.ts';
import type { RunRow, TaskRow } from './ledger.ts';
import type { traceRun } from './trace.ts';

const MAX_ERROR_CHARS = 600;
const MAX_STDERR_HEAD_LINES = 8;
const MAX_STDERR_TAIL_LINES = 20;
const MAX_STDERR_LINE_CHARS = 400;
const MAX_TOOL_NAME_CHARS = 120;
const MAX_TOOL_TITLE_CHARS = 240;
const MAX_TOOL_REASON_CHARS = 400;
const MAX_FAILED_TOOLS = 25;
const MAX_UNFINISHED_TOOLS = 50;

const TIER_SOURCES = new Set<TierSource>(['default', 'override', 'escalated', 'reviewed']);

// Generic transient retry/reconnect chatter that must not wash out the first real error.
const TRANSIENT_CHATTER = /^(?:reconnecting|retrying|retry(?:ing)?\s+in\b|attempt\s+\d+(?:\s*\/\s*\d+)?|trying\s+again|backing\s+off|waiting\s+to\s+retry|正在重连|正在重试|重试中)/i;

const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${HIDDEN_TEXT}`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, HIDDEN_TEXT],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g, HIDDEN_TEXT],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, HIDDEN_TEXT],
  [/\bglpat-[A-Za-z0-9_-]{8,}/g, HIDDEN_TEXT],
  [/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN_TEXT],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, HIDDEN_TEXT],
  [/(\bhttps?:\/\/)([^:@/\s]+:[^@/\s]+)(@)/gi, `$1${HIDDEN_TEXT}$3`],
  [
    /["']?((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|cookie|secret|token)["']?\s*[:=]\s*["']?)([^\s"',;}{\\]{6,})(["']?)/gi,
    `$1${HIDDEN_TEXT}$3`,
  ],
];

export interface BuildRunDiagnosticsInput {
  run: RunRow;
  task?: TaskRow | null;
  trace?: ReturnType<typeof traceRun> | RunTrace | null;
  events: readonly NormalizedEvent[];
  firstIndex?: number;
  loaded?: boolean;
  reason?: string | null;
  stderrHead?: readonly string[] | string | null;
  stderrTail?: readonly string[] | string | null;
  stderrLoaded?: boolean;
  stderrReason?: string | null;
  platformVersion?: string | null;
  generatedAt?: string;
}

export function scrubSecrets(text: string): string {
  let out = redactWorkerDiagnosticText(text, (s) => s);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return maxChars <= 1 ? text.slice(0, maxChars) : `${text.slice(0, maxChars - 1)}…`;
}

function cleanText(text: string, maxChars: number): string {
  return truncate(scrubSecrets(text.trim()), maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function safeParseObject(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStderrLines(input: readonly string[] | string | null | undefined): string[] {
  if (!input) return [];
  const rawLines = typeof input === 'string'
    ? input.split(/\r?\n/)
    : input.flatMap((line) => (typeof line === 'string' ? line.split(/\r?\n/) : []));
  const out: string[] = [];
  for (const line of rawLines) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (trimmed === '') continue;
    out.push(truncate(scrubSecrets(trimmed), MAX_STDERR_LINE_CHARS));
  }
  return out;
}

function extractRunError(run: RunRow): string | null {
  if (!run.error_json) return null;
  const raw = run.error_json.trim();
  if (raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cleanText(raw, MAX_ERROR_CHARS);
  }
  if (typeof parsed === 'string') {
    const text = nonEmptyString(parsed);
    return text ? cleanText(text, MAX_ERROR_CHARS) : null;
  }
  if (!isRecord(parsed)) return null;
  const direct = nonEmptyString(parsed.message)
    ?? nonEmptyString(parsed.reason)
    ?? nonEmptyString(parsed.worker_not_started);
  if (direct) return cleanText(direct, MAX_ERROR_CHARS);
  if (isRecord(parsed.code_check) && typeof parsed.code_check.result === 'string') {
    const check = parsed.code_check as unknown as CodeCheck;
    if (check.result === 'changed' || check.result === 'unverifiable') {
      return cleanText(codeCheckText(check), MAX_ERROR_CHARS);
    }
  }
  if (isRecord(parsed.lost)) {
    const lostMsg = nonEmptyString(parsed.lost.reason) ?? nonEmptyString(parsed.lost.basis);
    if (lostMsg) return cleanText(lostMsg, MAX_ERROR_CHARS);
  }
  return null;
}

function durationMsOf(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function projectRole(value: unknown): RoleConfig | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  const description = typeof value.description === 'string' ? scrubSecrets(value.description) : '';
  const defaultTier = typeof value.default_tier === 'string' && isTierId(value.default_tier)
    ? value.default_tier
    : undefined;
  const permission = isPermissionId(value.permission) ? value.permission : undefined;
  const deliverable = isDeliverableId(value.deliverable) ? value.deliverable : undefined;
  const needsReview = typeof value.needs_review === 'boolean' ? value.needs_review : undefined;
  if (!id || !name || !defaultTier || !permission || !deliverable || needsReview === undefined) {
    return undefined;
  }
  return {
    id,
    name: scrubSecrets(name),
    description,
    default_tier: defaultTier,
    permission,
    deliverable,
    needs_review: needsReview,
  };
}

function projectLogin(value: unknown): SafeLoginProjection | string | undefined {
  if (typeof value === 'string') {
    const trimmed = nonEmptyString(value);
    return trimmed ? scrubSecrets(trimmed) : undefined;
  }
  if (!isRecord(value)) return undefined;
  const out: SafeLoginProjection = {};
  if (typeof value.id === 'string') out.id = value.id;
  if (typeof value.name === 'string') out.name = scrubSecrets(value.name);
  if (typeof value.executor === 'string') out.executor = value.executor;
  if (typeof value.machine === 'string' || value.machine === null) out.machine = value.machine;
  if (typeof value.permission_mode === 'string' || value.permission_mode === null) {
    out.permission_mode = value.permission_mode;
  }
  if (typeof value.timeout_ms === 'number' || value.timeout_ms === null) out.timeout_ms = value.timeout_ms;
  if (typeof value.max_runs === 'number' || value.max_runs === null) out.max_runs = value.max_runs;
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectSource(value: unknown): SnapshotSource | undefined {
  if (!isRecord(value) || typeof value.binding_key !== 'string') return undefined;
  if (value.kind === 'repo' && typeof value.url === 'string') {
    return {
      kind: 'repo',
      url: scrubSecrets(value.url),
      binding_key: value.binding_key,
      ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
      ...(typeof value.commit === 'string' ? { commit: value.commit } : {}),
    };
  }
  if (value.kind === 'folder' && typeof value.path === 'string') {
    return {
      kind: 'folder',
      path: scrubSecrets(value.path),
      binding_key: value.binding_key,
    };
  }
  return undefined;
}

function projectAccess(value: unknown): RunAccess | undefined {
  if (!isRecord(value)) return undefined;
  if (value.permission === 'write') return { permission: 'write' };
  if (value.permission === 'read' && isReadOnlyLayer(value.layer) && Array.isArray(value.args)) {
    return {
      permission: 'read',
      layer: value.layer,
      args: value.args.filter((arg): arg is string => typeof arg === 'string').map(scrubSecrets),
    };
  }
  return undefined;
}

function projectStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      out[key] = item.filter((each): each is string => typeof each === 'string').map(scrubSecrets);
    }
  }
  return out;
}

function projectMachineInputs(value: unknown): MachineInputs | undefined {
  if (!isRecord(value) || !isRecord(value.instructions) || !isRecord(value.memory)) return undefined;

  let instructions: MachineInputs['instructions'];
  if (typeof value.instructions.off === 'string') {
    instructions = {
      off: scrubSecrets(value.instructions.off),
      settings: projectStringArrayRecord(value.instructions.settings),
    };
  } else if (typeof value.instructions.may_read === 'string') {
    instructions = {
      may_read: scrubSecrets(value.instructions.may_read),
      settings: projectStringArrayRecord(value.instructions.settings),
    };
  } else if (typeof value.instructions.reads === 'string') {
    instructions = { reads: scrubSecrets(value.instructions.reads) };
  } else {
    return undefined;
  }

  let memory: MachineInputs['memory'];
  if (typeof value.memory.off === 'string') {
    memory = { off: scrubSecrets(value.memory.off) };
  } else if (typeof value.memory.may_read === 'string') {
    memory = { may_read: scrubSecrets(value.memory.may_read) };
  } else if (
    value.memory.scope === 'none'
    || value.memory.scope === 'task'
    || value.memory.scope === 'shared'
    || value.memory.scope === 'unknown'
  ) {
    memory = {
      scope: value.memory.scope,
      ...(typeof value.memory.why === 'string' ? { why: scrubSecrets(value.memory.why) } : {}),
    };
  } else {
    return undefined;
  }

  const out: MachineInputs = { instructions, memory };

  if (isRecord(value.knowledge_mcp)) {
    if (typeof value.knowledge_mcp.off === 'string') {
      out.knowledge_mcp = { off: scrubSecrets(value.knowledge_mcp.off) };
    } else if (typeof value.knowledge_mcp.absent === 'string') {
      out.knowledge_mcp = { absent: scrubSecrets(value.knowledge_mcp.absent) };
    } else if (typeof value.knowledge_mcp.may_use === 'string') {
      out.knowledge_mcp = { may_use: scrubSecrets(value.knowledge_mcp.may_use) };
    }
  }

  if (isRecord(value.fixed_knowledge) && typeof value.fixed_knowledge.require_absence === 'boolean') {
    out.fixed_knowledge = { require_absence: value.fixed_knowledge.require_absence };
  }

  if (isRecord(value.external_entry)) {
    const entry = value.external_entry;
    const base = {
      ...(typeof entry.reported_at === 'string' ? { reported_at: entry.reported_at } : {}),
      ...(typeof entry.conflicting === 'boolean' ? { conflicting: entry.conflicting } : {}),
    };
    if (entry.state === 'absent') {
      out.external_entry = { state: 'absent', ...base };
    } else if (entry.state === 'present' && Array.isArray(entry.revisions)) {
      out.external_entry = {
        state: 'present',
        revisions: entry.revisions.filter((r): r is string => typeof r === 'string'),
        ...(typeof entry.digest === 'string' ? { digest: entry.digest } : {}),
        ...(typeof entry.publication_set === 'string' ? { publication_set: entry.publication_set } : {}),
        ...base,
      };
    } else if (entry.state === 'unknown' && typeof entry.why === 'string') {
      out.external_entry = { state: 'unknown', why: scrubSecrets(entry.why), ...base };
    }
  }

  if (isRecord(value.config) && Array.isArray(value.config.kinds)) {
    const kinds: NonNullable<MachineInputs['config']>['kinds'] = [];
    for (const item of value.config.kinds) {
      if (!isRecord(item) || !isConfigKind(item.kind)) continue;
      if (Array.isArray(item.names)) {
        kinds.push({
          kind: item.kind,
          names: item.names.filter((name): name is string => typeof name === 'string').map(scrubSecrets),
        });
      } else if (typeof item.unknown === 'string') {
        kinds.push({ kind: item.kind, unknown: scrubSecrets(item.unknown) });
      }
    }
    out.config = {
      ...(typeof value.config.asked_at === 'string' ? { asked_at: value.config.asked_at } : {}),
      kinds,
    };
  }

  return out;
}

function projectKnowledge(value: unknown): SafeKnowledgeProjection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SafeKnowledgeProjection[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = nonEmptyString(item.id);
    const title = nonEmptyString(item.title);
    const revision = typeof item.revision === 'number' && Number.isFinite(item.revision) ? item.revision : undefined;
    const loading: Loading | undefined = item.loading === 'resident' || item.loading === 'on_demand'
      ? item.loading
      : undefined;
    const scope = item.scope === 'global' || item.scope === 'project' ? item.scope : undefined;
    if (!id || !title || revision === undefined || !loading || !scope) continue;
    const roles = Array.isArray(item.roles)
      ? item.roles.filter((role): role is string => typeof role === 'string')
      : [];
    out.push({
      id,
      revision,
      title: scrubSecrets(title),
      loading,
      scope,
      roles,
      ...(item.kind === 'skill' ? { kind: 'skill' as const } : {}),
      ...(item.named === true ? { named: true as const } : {}),
      ...(typeof item.path === 'string' ? { path: scrubSecrets(item.path) } : {}),
    });
  }
  return out;
}

function projectSnapshot(
  raw: Record<string, unknown> | null,
  task: TaskRow | null | undefined,
): SafeSnapshotProjection | null {
  if (raw === null) return null;
  const projection: SafeSnapshotProjection = {};

  const goal = typeof raw.goal === 'string'
    ? raw.goal
    : (typeof task?.goal === 'string' ? task.goal : undefined);
  if (goal !== undefined) projection.goal = scrubSecrets(goal);

  const acceptance = typeof raw.acceptance === 'string'
    ? raw.acceptance
    : (typeof task?.acceptance === 'string' ? task.acceptance : undefined);
  if (acceptance !== undefined) projection.acceptance = scrubSecrets(acceptance);

  const role = projectRole(raw.role);
  if (role !== undefined) projection.role = role;

  if (typeof raw.tier === 'string') projection.tier = raw.tier;
  if (typeof raw.tier_from === 'string' && isTierId(raw.tier_from)) projection.tier_from = raw.tier_from;
  if (typeof raw.tier_source === 'string' && TIER_SOURCES.has(raw.tier_source as TierSource)) {
    projection.tier_source = raw.tier_source as TierSource;
  }

  const executor = executorOfSnapshot(raw);
  if (executor !== undefined) projection.executor = executor;

  const login = projectLogin(raw.login);
  if (login !== undefined) projection.login = login;

  const source = projectSource(raw.source);
  if (source !== undefined) projection.source = source;

  const access = projectAccess(raw.access);
  if (access !== undefined) projection.access = access;

  const machineInputs = projectMachineInputs(raw.machine_inputs);
  if (machineInputs !== undefined) projection.machine_inputs = machineInputs;

  const knowledge = projectKnowledge(raw.knowledge);
  if (knowledge !== undefined) projection.knowledge = knowledge;

  return projection;
}

function executorOfSnapshot(raw: Record<string, unknown> | null): string | undefined {
  if (raw === null) return undefined;
  const direct = nonEmptyString(raw.executor);
  if (direct) return direct;
  if (isRecord(raw.login)) {
    return nonEmptyString(raw.login.executor);
  }
  return undefined;
}

function tierModelOfSnapshot(raw: Record<string, unknown> | null, executor: string | undefined): string | null {
  if (raw === null) return null;
  const explicit = nonEmptyString(raw.tier_model);
  if (explicit) return explicit;
  const tierValue = raw.tier_value as Tier | undefined;
  if (!executor || !tierValue || tierValue.kind !== 'content' || typeof tierValue.text !== 'string') {
    return null;
  }
  const parsed = ADAPTERS[executor]?.tierForm?.parse(tierValue.text);
  const model = nonEmptyString(parsed?.model);
  return model ?? null;
}

function isTransientChatter(message: string): boolean {
  const trimmed = message.trim();
  return trimmed === '' || TRANSIENT_CHATTER.test(trimmed);
}

function sanitizeTrace(trace: ReturnType<typeof traceRun> | RunTrace | null): RunTrace | null {
  if (!trace) return null;
  const raw = trace as unknown as Record<string, unknown>;
  const safeChange = (item: unknown) => {
    if (!item || typeof item !== 'object') return null;
    const c = item as Record<string, unknown>;
    return {
      seq: typeof c.seq === 'number' ? c.seq : 0,
      at: typeof c.at === 'string' ? c.at : '',
      actor: typeof c.actor === 'string' ? scrubSecrets(c.actor) : '',
      action: typeof c.action === 'string' ? c.action : '',
      task_id: typeof c.task_id === 'string' ? c.task_id : null,
      run_id: typeof c.run_id === 'string' ? c.run_id : null,
      message_id: typeof c.message_id === 'string' ? c.message_id : null,
      tool_call_id: typeof c.tool_call_id === 'string' ? c.tool_call_id : null,
      detail_json: typeof c.detail_json === 'string' ? cleanText(c.detail_json, 800) : null,
    };
  };
  const safeMessage = (item: unknown) => {
    if (!item || typeof item !== 'object') return null;
    const m = item as Record<string, unknown>;
    return {
      id: typeof m.id === 'string' ? m.id : '',
      at: typeof m.at === 'string' ? m.at : '',
      channel: typeof m.channel === 'string' ? m.channel : '',
      actor: typeof m.actor === 'string' ? scrubSecrets(m.actor) : '',
      text: typeof m.text === 'string' ? cleanText(m.text, MAX_ERROR_CHARS) : '',
    };
  };
  const validResultState = new Set(['returned', 'refused', 'interrupted', 'failed']);
  const safeToolCall = (item: unknown): RunTrace['origin_call'] => {
    if (!item || typeof item !== 'object') return null;
    const tc = item as Record<string, unknown>;
    const rawCommitted = Array.isArray(tc.committed) ? tc.committed : [];
    return {
      id: typeof tc.id === 'string' ? tc.id : '',
      name: typeof tc.name === 'string' ? tc.name : '',
      message_ids: Array.isArray(tc.message_ids) ? tc.message_ids.filter((x): x is string => typeof x === 'string') : [],
      started_at: typeof tc.started_at === 'string' ? tc.started_at : '',
      request: typeof tc.request === 'string' ? cleanText(tc.request, MAX_ERROR_CHARS) : null,
      result: typeof tc.result === 'string' ? cleanText(tc.result, MAX_ERROR_CHARS) : null,
      result_state: (typeof tc.result_state === 'string' && validResultState.has(tc.result_state)
        ? tc.result_state
        : null) as NonNullable<RunTrace['origin_call']>['result_state'],
      finished_at: typeof tc.finished_at === 'string' ? tc.finished_at : null,
      receipt_confirmed: Boolean(tc.receipt_confirmed),
      committed: rawCommitted
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({
          action: typeof entry.action === 'string' ? entry.action : '',
          task_id: typeof entry.task_id === 'string' ? entry.task_id : null,
          run_id: typeof entry.run_id === 'string' ? entry.run_id : null,
          at: typeof entry.at === 'string' ? entry.at : '',
        })),
    };
  };
  const rawTrigger = (raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : {}) as Record<string, unknown>;
  const rawInputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  const rawChanges = Array.isArray(raw.changes) ? raw.changes : [];
  const rawSettlement = raw.settlement && typeof raw.settlement === 'object'
    ? (raw.settlement as Record<string, unknown>)
    : null;
  const rawPolicy = rawSettlement?.policy && typeof rawSettlement.policy === 'object'
    ? (rawSettlement.policy as Record<string, unknown>)
    : null;
  const validDelivery = new Set(['held', 'pending', 'sent', 'given_up', 'unknown']);

  return {
    run_id: typeof raw.run_id === 'string' ? raw.run_id : '',
    task_id: typeof raw.task_id === 'string' ? raw.task_id : '',
    trigger: {
      kind: (typeof rawTrigger.kind === 'string' ? rawTrigger.kind : 'unknown') as RunTrace['trigger']['kind'],
      label: typeof rawTrigger.label === 'string' ? scrubSecrets(rawTrigger.label) : '',
      change: safeChange(rawTrigger.change),
      message: safeMessage(rawTrigger.message),
      tool_call: safeToolCall(rawTrigger.tool_call),
    },
    origin_call: safeToolCall(raw.origin_call),
    inputs: rawInputs
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        created_at: typeof entry.created_at === 'string' ? entry.created_at : (typeof entry.at === 'string' ? entry.at : ''),
        task_id: typeof entry.task_id === 'string' ? entry.task_id : (typeof raw.task_id === 'string' ? raw.task_id : ''),
        actor: typeof entry.actor === 'string' ? scrubSecrets(entry.actor) : '',
        text: typeof entry.text === 'string' ? cleanText(entry.text, MAX_ERROR_CHARS) : '',
        message_id: typeof entry.message_id === 'string' ? entry.message_id : null,
        state: (entry.state === 'queued' || entry.state === 'attached' || entry.state === 'void' ? entry.state : 'attached'),
        run_id: typeof entry.run_id === 'string' ? entry.run_id : null,
      })),
    session_ref: typeof raw.session_ref === 'string' ? raw.session_ref : null,
    task_revision: typeof raw.task_revision === 'number' ? raw.task_revision : 0,
    dispatchConditions: raw.dispatchConditions ?? null,
    changes: rawChanges.map(safeChange).filter((entry): entry is NonNullable<ReturnType<typeof safeChange>> => entry !== null),
    settlement: rawSettlement
      ? {
          at: typeof rawSettlement.at === 'string' ? rawSettlement.at : '',
          task_state: typeof rawSettlement.task_state === 'string' ? rawSettlement.task_state : null,
          exit_kind: typeof rawSettlement.exit_kind === 'string' ? rawSettlement.exit_kind : null,
          policy: rawPolicy
            ? {
                rule: typeof rawPolicy.rule === 'string' ? rawPolicy.rule : '',
                reason: typeof rawPolicy.reason === 'string' ? cleanText(rawPolicy.reason, MAX_ERROR_CHARS) : '',
              }
            : null,
          delivery: (typeof rawSettlement.delivery === 'string' && validDelivery.has(rawSettlement.delivery)
            ? rawSettlement.delivery
            : 'unknown') as NonNullable<RunTrace['settlement']>['delivery'],
        }
      : null,
  };
}

function summarizeEvents(
  events: readonly NormalizedEvent[],
  baseIndex: number,
  tierModel: string | null,
): { firstErrorDiagnostic: DiagnosticFirstError; firstWarningDiagnostic: DiagnosticFirstError; tools: ToolSummary; models: ModelEvidence } {
  let firstErrorDiagnostic: DiagnosticFirstError = null;
  let firstWarningDiagnostic: DiagnosticFirstError = null;
  const openTools = new Map<string, UnfinishedTool>();
  const failedTools: FailedTool[] = [];
  const byCategory: Record<string, number> = {};
  const reportedModels = new Set<string>();
  let total = 0;
  let errorCount = 0;
  let syntheticSeq = 0;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    const eventIndex = baseIndex + i;

    if (event.kind === 'diagnostic') {
      if (!isTransientChatter(event.message) && event.level !== 'recovering') {
        const timestamp = nonEmptyString((event as { timestamp?: unknown }).timestamp);
        const item: NonNullable<DiagnosticFirstError> = {
          source: 'diagnostic',
          message: cleanText(event.message, MAX_ERROR_CHARS),
          event_index: eventIndex,
          ...(timestamp ? { timestamp } : {}),
        };
        if (event.level === 'warning') {
          if (firstWarningDiagnostic === null) firstWarningDiagnostic = item;
        } else if (firstErrorDiagnostic === null) {
          firstErrorDiagnostic = item;
        }
      }
      continue;
    }

    if (event.kind === 'tool.start') {
      const id = nonEmptyString(event.id) ?? `__tool_${++syntheticSeq}`;
      const category = nonEmptyString(event.category) ?? 'other';
      const name = cleanText(nonEmptyString(event.name) ?? 'unknown', MAX_TOOL_NAME_CHARS);
      const title = nonEmptyString(event.title)
        ? cleanText(event.title, MAX_TOOL_TITLE_CHARS)
        : undefined;
      const startedAt = nonEmptyString((event as { timestamp?: unknown }).timestamp);

      total += 1;
      byCategory[category] = (byCategory[category] ?? 0) + 1;
      openTools.set(id, {
        id,
        name,
        category,
        ...(title !== undefined ? { title } : {}),
        ...(startedAt !== undefined ? { started_at: startedAt } : {}),
        event_index: eventIndex,
      });
      continue;
    }

    if (event.kind === 'tool.end') {
      const id = nonEmptyString(event.id);
      const started = id !== undefined ? openTools.get(id) : undefined;
      if (started !== undefined && id !== undefined) {
        openTools.delete(id);
      } else {
        total += 1;
        const category = nonEmptyString(event.call?.category) ?? 'other';
        byCategory[category] = (byCategory[category] ?? 0) + 1;
      }

      const failed = event.isError === true || (typeof event.exitCode === 'number' && event.exitCode !== 0);
      if (failed) {
        errorCount += 1;
        if (failedTools.length < MAX_FAILED_TOOLS) {
          const name = cleanText(
            nonEmptyString(event.call?.name) ?? started?.name ?? 'unknown',
            MAX_TOOL_NAME_CHARS,
          );
          const category = nonEmptyString(event.call?.category) ?? started?.category;
          const rawTitle = nonEmptyString(event.call?.title) ?? started?.title;
          const title = rawTitle ? cleanText(rawTitle, MAX_TOOL_TITLE_CHARS) : undefined;
          const rawReason = nonEmptyString(event.reason) ?? nonEmptyString(event.output?.text);
          const reason = rawReason ? cleanText(rawReason, MAX_TOOL_REASON_CHARS) : undefined;
          failedTools.push({
            ...(id !== undefined ? { id } : {}),
            name,
            ...(category !== undefined ? { category } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(typeof event.exitCode === 'number' ? { exit_code: event.exitCode } : {}),
            ...(reason !== undefined ? { reason } : {}),
            event_index: eventIndex,
          });
        }
      }
      continue;
    }

    if (event.kind === 'usage') {
      for (const entry of event.usage) {
        const model = nonEmptyString(entry.model);
        if (model) reportedModels.add(model);
      }
    }
  }

  const unfinishedAll = [...openTools.values()];
  return {
    firstErrorDiagnostic,
    firstWarningDiagnostic,
    tools: {
      total,
      error_count: errorCount,
      unfinished_count: unfinishedAll.length,
      by_category: byCategory,
      failed_tools: failedTools,
      unfinished_tools: unfinishedAll.slice(0, MAX_UNFINISHED_TOOLS),
    },
    models: {
      tier_model: tierModel,
      reported_models: [...reportedModels],
    },
  };
}

export function buildRunDiagnostics(input: BuildRunDiagnosticsInput): RunDiagnosticsBundle {
  const { run, task = null, trace = null, events } = input;
  const rawSnapshot = safeParseObject(run.snapshot_json);
  const executor = executorOfSnapshot(rawSnapshot);
  const tier = typeof rawSnapshot?.tier === 'string' ? rawSnapshot.tier : null;
  const tierModel = tierModelOfSnapshot(rawSnapshot, executor);
  const droppedBeforeIndex = Math.max(
    0,
    typeof input.firstIndex === 'number' && Number.isFinite(input.firstIndex)
      ? Math.trunc(input.firstIndex)
      : 0,
  );

  const stderrHead = normalizeStderrLines(input.stderrHead).slice(0, MAX_STDERR_HEAD_LINES);
  const stderrTail = normalizeStderrLines(input.stderrTail).slice(-MAX_STDERR_TAIL_LINES);
  const runError = extractRunError(run);

  const { firstErrorDiagnostic, firstWarningDiagnostic, tools, models } = summarizeEvents(events, droppedBeforeIndex, tierModel);

  let firstError: DiagnosticFirstError = firstErrorDiagnostic;
  if (firstError === null && runError !== null) {
    firstError = {
      source: 'run_error',
      message: runError,
      ...(run.ended_at ? { timestamp: run.ended_at } : {}),
    };
  }
  if (firstError === null && firstWarningDiagnostic !== null) {
    firstError = firstWarningDiagnostic;
  }
  if (firstError === null && stderrHead.length > 0) {
    firstError = {
      source: 'stderr',
      message: truncate(stderrHead[0]!, MAX_ERROR_CHARS),
    };
  }

  const incompleteReasons = [
    nonEmptyString(input.reason) ? cleanText(input.reason!, MAX_ERROR_CHARS) : null,
    nonEmptyString(input.stderrReason) ? cleanText(input.stderrReason!, MAX_ERROR_CHARS) : null,
  ].filter((part): part is string => part !== null);

  const coverage: DiagnosticCoverage = {
    events_loaded: input.loaded ?? true,
    events_count: events.length,
    dropped_before_index: droppedBeforeIndex,
    incomplete_reason: incompleteReasons.length > 0 ? incompleteReasons.join('；') : null,
    stderr_loaded: input.stderrLoaded ?? (stderrHead.length > 0 || stderrTail.length > 0),
  };

  return {
    schema_version: 1,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    platform_version: input.platformVersion ?? null,
    run: {
      id: run.id,
      task_id: run.task_id,
      status: run.state,
      exit_kind: run.exit_kind,
      exit_code: run.exit_code,
      executor: executor ?? 'unknown',
      tier,
      login_id: run.login_id,
      login_name: run.login_name,
      machine_id: run.machine_id,
      node_id: run.node_id,
      started_at: run.started_at,
      finished_at: run.ended_at,
      duration_ms: durationMsOf(run.started_at, run.ended_at),
      error: runError,
    },
    task: task
      ? {
          id: task.id,
          title: scrubSecrets(task.title),
          status: task.state,
          project_id: task.project_id,
        }
      : null,
    snapshot: projectSnapshot(rawSnapshot, task),
    first_error: firstError,
    stderr: {
      head: stderrHead,
      tail: stderrTail,
    },
    tools,
    models,
    coverage,
    trace: sanitizeTrace(trace),
  };
}
