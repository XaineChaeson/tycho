// Pure deterministic extractor of execution facts ("执行病历") from a Task's existing ledger
// rows and normalized run events. Zero LLM calls, zero schema changes, zero external dependencies.
import type { NormalizedEvent } from '../adapters/types.ts';
import type {
  ErrorFact,
  KnowledgeProposalDraft,
  KnowledgeProposalDraftEvidence,
  PingPongFact,
  TaskRunFacts,
  TaskRunFactsCoverage,
  ToolRepeatFact,
} from '../shared/run-facts.ts';
import { isTierId, tierLabel } from '../shared/tiers.ts';

export interface FactTaskInput {
  id: string;
  project_id: string | null;
  title: string;
  goal?: string | null;
  role_id?: string | null;
  state?: string;
  reason?: string | null;
}

export interface FactRunInput {
  id: string;
  created_at: string;
  task_id?: string;
  state?: string;
  exit_code?: number | null;
  exit_kind?: string | null;
  receipt_json?: string | null;
  error_json?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
}

export interface FactChangeInput {
  seq?: number;
  at: string;
  actor?: string;
  task_id?: string | null;
  run_id?: string | null;
  action: string;
  detail_json?: string | null;
}

export interface RunEventCoverageInput {
  loaded: boolean;
  firstIndex?: number;
  reason?: string | null;
}

export interface ExtractTaskFactsInput {
  task: FactTaskInput;
  runs: readonly FactRunInput[];
  changes: readonly FactChangeInput[];
  eventsByRun: ReadonlyMap<string, readonly NormalizedEvent[]> | Readonly<Record<string, readonly NormalizedEvent[]>>;
  coverageByRun?: ReadonlyMap<string, RunEventCoverageInput> | Readonly<Record<string, RunEventCoverageInput>>;
}

const MAX_NORMALIZED_TITLE_CHARS = 160;
const MAX_ERROR_SAMPLE_CHARS = 300;
const MAX_SIGNATURE_CHARS = 160;
const MAX_EVIDENCE_EXCERPT_CHARS = 400;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_TITLE_CHARS = 120;

const TOOL_REPEAT_MIN_COUNT = 3;
const TOOL_CONSECUTIVE_ERROR_MIN = 2;

// Matches transient reconnection / retry chatter that is not a substantive error fact.
const CHATTER_PATTERNS: readonly RegExp[] = [
  /^\s*(?:reconnecting|retrying|retry\s+#?\d+|attempt\s+#?\d+|waiting\s+to\s+retry|connection\s+lost[,\s]+retrying)\b/i,
  /\b(?:reconnecting\.{2,3}|retrying(?:\s+in\b|\s+\d|\.{2,3}|$))/i,
  /(?:正在重连|重试中|即将重试)/,
];

// Scrubs credentials and tokens — covers private keys, Tycho headers/env, Authorization schemes,
// provider tokens, JWTs, URL credentials, JSON-quoted and key=value secrets, and 64-hex tokens,
// while preserving surrounding command structure (e.g. trailing URLs in curl tool titles).
export function scrubSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bX-Tycho-[A-Za-z-]*(?:Token|Secret)["']?\s*:\s*["']?[^\s"',;}]*/gi, '[REDACTED_TYCHO_HEADER]')
    .replace(/\bTYCHO_[A-Z0-9_]*(?:TOKEN|SECRET|KEY|MATERIALS)\b["']?\s*[=:]\s*["']?[^\s"',;}]*/g, '[REDACTED_TYCHO_ENV]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|glpat)[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, '$1[REDACTED]@')
    .replace(/(["']?\b(?:[\w-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token)|secret|password|passwd|private[_-]?key|client[_-]?secret|cookie|credentials?)\b["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;}\]]+)/gi, '$1[REDACTED]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[REDACTED_HEX64]');
}

function normalizeDynamicTokens(input: string): string {
  return input
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,63}\b/gi, '<hex>')
    .replace(/(:\d+)(:\d+)?\b/g, ':<n>')
    .replace(/\bline\s+\d+\b/gi, 'line <n>')
    .replace(/\bL\d+\b/g, 'L<n>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeToolTitle(title: string): string {
  const normalized = normalizeDynamicTokens(scrubSecrets(title));
  return normalized.length > MAX_NORMALIZED_TITLE_CHARS
    ? `${normalized.slice(0, MAX_NORMALIZED_TITLE_CHARS - 1)}…`
    : normalized;
}

function errorSignatureOf(message: string): string {
  const firstLine = scrubSecrets(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? '';
  const normalized = normalizeDynamicTokens(firstLine).toLowerCase();
  return normalized.length > MAX_SIGNATURE_CHARS ? normalized.slice(0, MAX_SIGNATURE_CHARS) : normalized;
}

function isChatter(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 4) return true;
  return CHATTER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function eventsForRun(
  eventsByRun: ExtractTaskFactsInput['eventsByRun'],
  runId: string,
): readonly NormalizedEvent[] {
  if (eventsByRun instanceof Map) return eventsByRun.get(runId) ?? [];
  const record = eventsByRun as Readonly<Record<string, readonly NormalizedEvent[]>>;
  return Object.hasOwn(record, runId) ? (record[runId] ?? []) : [];
}

function formatTier(raw: string | null): string {
  if (!raw) return '未知档位';
  return isTierId(raw) ? tierLabel(raw) : raw;
}

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
}

function extractPingPong(changes: readonly FactChangeInput[]): { ping_pong: PingPongFact[]; escalations: number } {
  const ping_pong: PingPongFact[] = [];
  let escalations = 0;
  // Deduplicate review rejections that appear on both the review task (`review.verdict`) and the
  // work task (`task.rework` / `approval.open` carrying `review_task_id`).
  const seenReviewRejects = new Set<string>();

  const ordered = [...changes].sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq;
    return a.at.localeCompare(b.at);
  });

  for (const change of ordered) {
    const detail = parseJsonObject(change.detail_json);
    const runRef = change.run_id ? { run_id: change.run_id } : {};

    if (change.action === 'review.verdict') {
      const result = stringField(detail, 'result');
      const current = detail?.current;
      if (result === 'reject' && current !== false && current !== 0) {
        const reviewId = change.task_id ?? null;
        if (reviewId && seenReviewRejects.has(reviewId)) continue;
        if (reviewId) seenReviewRejects.add(reviewId);
        const reviewedId = stringField(detail, 'reviewed_task_id');
        const reason = stringField(detail, 'reason');
        const parts = ['审阅打回'];
        if (reviewedId) parts.push(`被审任务 ${reviewedId}`);
        if (reason) parts.push(scrubSecrets(reason));
        ping_pong.push({
          kind: 'rejection',
          timestamp: change.at,
          ...runRef,
          summary: clip(parts.join('：'), 200),
        });
      }
      continue;
    }

    if (change.action === 'approval.open') {
      const reviewTaskId = stringField(detail, 'review_task_id');
      if (reviewTaskId) {
        if (seenReviewRejects.has(reviewTaskId)) continue;
        seenReviewRejects.add(reviewTaskId);
        ping_pong.push({
          kind: 'rejection',
          timestamp: change.at,
          ...runRef,
          summary: `决策档审阅打回，等待主人决定（审阅任务 ${reviewTaskId}）`,
        });
      }
      continue;
    }

    if (change.action === 'task.rework') {
      const reviewTaskId = stringField(detail, 'review_task_id');
      if (reviewTaskId) {
        if (seenReviewRejects.has(reviewTaskId)) continue;
        seenReviewRejects.add(reviewTaskId);
      }
      const revision = typeof detail?.revision === 'number' ? detail.revision : null;
      const summary = reviewTaskId
        ? `审阅打回并退回返工（审阅任务 ${reviewTaskId}）`
        : `退回返工（${revision !== null ? `修订 ${revision}，` : ''}操作者 ${change.actor ?? '未知'}）`;
      ping_pong.push({
        kind: 'rework',
        timestamp: change.at,
        ...runRef,
        summary,
      });
      continue;
    }

    if (change.action === 'task.escalate') {
      escalations += 1;
      const from = formatTier(stringField(detail, 'from'));
      const to = formatTier(stringField(detail, 'to'));
      const reason = stringField(detail, 'reason');
      const summary = reason
        ? `档位升档：${from} → ${to}（${scrubSecrets(reason)}）`
        : `档位升档：${from} → ${to}`;
      ping_pong.push({
        kind: 'escalation',
        timestamp: change.at,
        ...runRef,
        summary: clip(summary, 200),
      });
    }
  }

  return { ping_pong, escalations };
}

interface ToolGroupStat {
  name: string;
  normalizedTitle: string;
  count: number;
  errorCount: number;
  currentConsecutiveErrors: number;
  maxConsecutiveErrors: number;
}

interface ToolNameStat {
  count: number;
  errorCount: number;
  currentConsecutiveErrors: number;
  maxConsecutiveErrors: number;
  lastErrorTitle: string;
}

function extractRunToolRepeats(runId: string, events: readonly NormalizedEvent[]): ToolRepeatFact[] {
  const started = new Map<string, { name: string; normalizedTitle: string; key: string }>();
  const groups = new Map<string, ToolGroupStat>();
  const byName = new Map<string, ToolNameStat>();

  const ensureGroup = (name: string, normalizedTitle: string): { key: string; group: ToolGroupStat } => {
    const key = `${name}\0${normalizedTitle}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        name,
        normalizedTitle,
        count: 0,
        errorCount: 0,
        currentConsecutiveErrors: 0,
        maxConsecutiveErrors: 0,
      };
      groups.set(key, group);
    }
    return { key, group };
  };

  const ensureName = (name: string): ToolNameStat => {
    let stat = byName.get(name);
    if (!stat) {
      stat = { count: 0, errorCount: 0, currentConsecutiveErrors: 0, maxConsecutiveErrors: 0, lastErrorTitle: '' };
      byName.set(name, stat);
    }
    return stat;
  };

  const recordOutcome = (group: ToolGroupStat, nameStat: ToolNameStat, isError: boolean): void => {
    if (isError) {
      group.errorCount += 1;
      group.currentConsecutiveErrors += 1;
      if (group.currentConsecutiveErrors > group.maxConsecutiveErrors) {
        group.maxConsecutiveErrors = group.currentConsecutiveErrors;
      }
      nameStat.errorCount += 1;
      nameStat.currentConsecutiveErrors += 1;
      nameStat.lastErrorTitle = group.normalizedTitle;
      if (nameStat.currentConsecutiveErrors > nameStat.maxConsecutiveErrors) {
        nameStat.maxConsecutiveErrors = nameStat.currentConsecutiveErrors;
      }
    } else {
      group.currentConsecutiveErrors = 0;
      nameStat.currentConsecutiveErrors = 0;
    }
  };

  for (const event of events) {
    if (event.kind === 'tool.start') {
      const normalizedTitle = normalizeToolTitle(event.title || event.name);
      const { key, group } = ensureGroup(event.name, normalizedTitle);
      group.count += 1;
      ensureName(event.name).count += 1;
      started.set(event.id, { name: event.name, normalizedTitle, key });
      continue;
    }
    if (event.kind === 'tool.end') {
      const existing = started.get(event.id);
      if (existing) {
        started.delete(event.id);
        const group = groups.get(existing.key)!;
        const nameStat = ensureName(existing.name);
        recordOutcome(group, nameStat, event.isError);
      } else if (event.call) {
        const normalizedTitle = normalizeToolTitle(event.call.title || event.call.name);
        const { group } = ensureGroup(event.call.name, normalizedTitle);
        group.count += 1;
        const nameStat = ensureName(event.call.name);
        nameStat.count += 1;
        recordOutcome(group, nameStat, event.isError);
      }
    }
  }

  const flagged: ToolRepeatFact[] = [];
  const namesWithConsecutiveError = new Set<string>();

  for (const group of groups.values()) {
    if (group.count >= TOOL_REPEAT_MIN_COUNT || group.maxConsecutiveErrors >= TOOL_CONSECUTIVE_ERROR_MIN) {
      if (group.maxConsecutiveErrors >= TOOL_CONSECUTIVE_ERROR_MIN) {
        namesWithConsecutiveError.add(group.name);
      }
      flagged.push({
        run_id: runId,
        name: group.name,
        normalized_title: group.normalizedTitle,
        count: group.count,
        error_count: group.errorCount,
        consecutive_errors: group.maxConsecutiveErrors,
      });
    }
  }

  // Catch tools that failed >= 2 times consecutively across varying normalized titles.
  for (const [name, stat] of byName.entries()) {
    if (stat.maxConsecutiveErrors >= TOOL_CONSECUTIVE_ERROR_MIN && !namesWithConsecutiveError.has(name)) {
      flagged.push({
        run_id: runId,
        name,
        normalized_title: stat.lastErrorTitle || '(不同参数)',
        count: stat.count,
        error_count: stat.errorCount,
        consecutive_errors: stat.maxConsecutiveErrors,
      });
    }
  }

  return flagged;
}

interface RawRunEvidence {
  runId: string;
  location: string;
  excerpt: string;
}

function buildProposalDraft(
  task: FactTaskInput,
  runs: readonly FactRunInput[],
  noteworthyReasons: readonly string[],
  pingPong: readonly PingPongFact[],
  escalations: number,
  toolRepeats: readonly ToolRepeatFact[],
  errorFacts: readonly ErrorFact[],
  failedRounds: number,
  runEvidences: readonly RawRunEvidence[],
): KnowledgeProposalDraft {
  const shortTaskTitle = clip(scrubSecrets(task.title), 48) || task.id;
  const topTool = toolRepeats[0];
  const topError = errorFacts[0];

  let title: string;
  let whenToUse: string;
  let whyWhen: string;
  let whyChanges: string;

  if (topTool && topTool.consecutive_errors >= TOOL_CONSECUTIVE_ERROR_MIN) {
    title = clip(`避免工具「${topTool.name}」连续失败（${shortTaskTitle}）`, MAX_TITLE_CHARS);
    whenToUse = `在执行类似「${shortTaskTitle}」任务、调用工具「${topTool.name}」（${topTool.normalized_title}）出现失败时。`;
    whyWhen = `执行者调用工具「${topTool.name}」执行类似操作并遇到报错时。`;
    whyChanges = `避免在同一失败路径上连续重试，先核对报错与前置条件再调整命令或参数。`;
  } else if (topTool) {
    title = clip(`收敛工具「${topTool.name}」重复调用（${shortTaskTitle}）`, MAX_TITLE_CHARS);
    whenToUse = `在执行类似「${shortTaskTitle}」任务、需要反复使用工具「${topTool.name}」（${topTool.normalized_title}）时。`;
    whyWhen = `执行者在同一轮内重复调用「${topTool.name}」超过预期次数时。`;
    whyChanges = `先明确查询或验证范围，合并冗余调用，减少无效往返。`;
  } else if (escalations >= 1 || pingPong.length >= 2) {
    title = clip(`减少「${shortTaskTitle}」类任务的审阅打回与返工`, MAX_TITLE_CHARS);
    whenToUse = `在派发或执行与「${shortTaskTitle}」同类任务、提交验收前进行自检时。`;
    whyWhen = `同类任务准备交付或进入审阅前。`;
    whyChanges = `在交付前按核对清单补齐关键检查，避免反复打回或被迫升档。`;
  } else if (topError) {
    title = clip(`排查并规避重复报错（${shortTaskTitle}）`, MAX_TITLE_CHARS);
    whenToUse = `在同类任务运行中再次遇到类似报错「${clip(topError.sample, 80)}」时。`;
    whyWhen = `任务执行过程中出现相同或相近的报错特征时。`;
    whyChanges = `第一时间定位该报错的前置依赖与边界，避免多轮重复失败。`;
  } else {
    title = clip(`任务「${shortTaskTitle}」执行复盘要点`, MAX_TITLE_CHARS);
    whenToUse = `执行与「${shortTaskTitle}」类似的任务时。`;
    whyWhen = `后续处理同类任务、制定执行与自检步骤时。`;
    whyChanges = `提前规避本次任务暴露的失败与返工模式。`;
  }

  const bodyLines: string[] = [
    `## 执行病历摘要`,
    `- 来源任务：${shortTaskTitle}（${task.id}），共分析 ${runs.length} 轮执行，失败 ${failedRounds} 轮。`,
    `- 触发原因：${noteworthyReasons.join('；')}。`,
  ];

  if (pingPong.length > 0) {
    bodyLines.push('', '## 打回 / 返工 / 升档记录');
    for (const item of pingPong.slice(0, 5)) {
      bodyLines.push(`- [${item.timestamp}] ${item.summary}`);
    }
  }

  if (toolRepeats.length > 0) {
    bodyLines.push('', '## 工具重复与连续失败');
    for (const item of toolRepeats.slice(0, 5)) {
      bodyLines.push(
        `- 轮次 ${item.run_id}：工具「${item.name}」（${item.normalized_title}）共执行 ${item.count} 次，失败 ${item.error_count} 次，连续失败 ${item.consecutive_errors} 次`,
      );
    }
  }

  if (errorFacts.length > 0) {
    bodyLines.push('', '## 高频报错（已去重与脱敏）');
    for (const item of errorFacts.slice(0, 5)) {
      bodyLines.push(`- 出现 ${item.count} 次（首次见于轮次 ${item.first_run_id}）：${item.sample}`);
    }
  }

  bodyLines.push(
    '',
    '## 改进结论与边界（提交前请补充核实）',
    '- 在同类场景下，先核对上述报错或返工原因对应的前置条件，再开始改动与提交。',
    '- 边界：当前结论仅来自单任务的执行病历，适用范围默认限定在当前项目，待更多案例验证后再考虑扩大。',
  );

  const evidence: KnowledgeProposalDraftEvidence[] = [];
  const seenEvidence = new Set<string>();
  const pushEvidence = (item: KnowledgeProposalDraftEvidence): void => {
    if (evidence.length >= MAX_EVIDENCE_ITEMS) return;
    const excerpt = clip(scrubSecrets(item.excerpt), MAX_EVIDENCE_EXCERPT_CHARS);
    if (excerpt === '') return;
    const dedupKey = `${item.source}\0${item.ref ?? ''}\0${excerpt}`;
    if (seenEvidence.has(dedupKey)) return;
    seenEvidence.add(dedupKey);
    evidence.push({ ...item, excerpt });
  };

  // 1. Prefer verbatim run error / receipt excerpts (verifiable directly by `service/knowledge.ts`).
  for (const item of runEvidences) {
    pushEvidence({
      source: 'run',
      ref: item.runId,
      location: item.location,
      excerpt: item.excerpt,
    });
  }

  // 2. Add deduplicated error facts referencing their first run.
  for (const item of errorFacts) {
    pushEvidence({
      source: 'run',
      ref: item.first_run_id,
      location: '执行诊断/错误记录',
      excerpt: item.sample,
    });
  }

  // 3. Add tool repeat facts referencing their run.
  for (const item of toolRepeats) {
    pushEvidence({
      source: 'run',
      ref: item.run_id,
      location: `工具调用（${item.name}）`,
      excerpt: `工具 ${item.name}（${item.normalized_title}）执行 ${item.count} 次，失败 ${item.error_count} 次，连续失败 ${item.consecutive_errors} 次`,
    });
  }

  // 4. Add ping-pong / escalation records.
  for (const item of pingPong) {
    pushEvidence({
      source: item.run_id ? 'run' : 'task',
      ref: item.run_id ?? task.id,
      location: '任务变更时间线',
      excerpt: item.summary,
    });
  }

  // 5. Guaranteed non-empty fallback citing the real run or task.
  if (evidence.length === 0) {
    const fallbackRun = runs.at(-1);
    if (fallbackRun) {
      pushEvidence({
        source: 'run',
        ref: fallbackRun.id,
        location: '执行病历摘要',
        excerpt: noteworthyReasons.join('；'),
      });
    } else {
      pushEvidence({
        source: 'task',
        ref: task.id,
        location: '任务标题',
        excerpt: scrubSecrets(task.title).trim() || task.id,
      });
    }
  }

  const scopeNote = task.project_id ? `当前限定于项目 ${task.project_id}` : '当前不归属特定项目（全局）';
  const whyGeneralizes = `来自任务 ${task.id}（共 ${runs.length} 轮执行）的真实记录：${noteworthyReasons.join('；')}。边界：${scopeNote}，仅针对同类操作或报错场景。`;

  return {
    kind: 'knowledge',
    inputs: [],
    outputs: [
      {
        title,
        when_to_use: whenToUse,
        body: bodyLines.join('\n'),
        project_ids: task.project_id ? [task.project_id] : null,
        loading: 'on_demand',
        roles: [],
      },
    ],
    why: {
      when: whyWhen,
      changes: whyChanges,
      generalizes: whyGeneralizes,
    },
    evidence,
  };
}

export function extractTaskFacts(input: ExtractTaskFactsInput): TaskRunFacts {
  const { task, runs, changes, eventsByRun } = input;
  const orderedRuns = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const { ping_pong, escalations } = extractPingPong(changes);
  const tool_repeats: ToolRepeatFact[] = [];
  const errorMap = new Map<string, ErrorFact>();
  const runEvidences: RawRunEvidence[] = [];
  let failed_rounds = 0;

  const recordError = (rawMessage: string, runId: string, at: string): void => {
    if (isChatter(rawMessage)) return;
    const signature = errorSignatureOf(rawMessage);
    if (signature === '') return;
    const existing = errorMap.get(signature);
    if (existing) {
      existing.count += 1;
      return;
    }
    errorMap.set(signature, {
      signature,
      sample: clip(scrubSecrets(rawMessage), MAX_ERROR_SAMPLE_CHARS),
      count: 1,
      first_run_id: runId,
      first_at: at,
    });
  };

  for (const run of orderedRuns) {
    const receipt = parseJsonObject(run.receipt_json);
    const errorObj = parseJsonObject(run.error_json);
    const receiptStatus = stringField(receipt, 'status');
    const isFailedRound = run.exit_kind === 'failed' || receiptStatus === 'failed';
    if (isFailedRound) failed_rounds += 1;

    const at = run.ended_at ?? run.created_at;

    // Collect run-level errors (skip expected quota rests).
    if (run.exit_kind !== 'quota') {
      const errorText = stringField(errorObj, 'reason') ?? stringField(errorObj, 'message');
      if (errorText) {
        recordError(errorText, run.id, at);
        runEvidences.push({ runId: run.id, location: '执行轮次错误记录', excerpt: errorText });
      }
      if (receiptStatus === 'failed') {
        const summary = stringField(receipt, 'summary');
        if (summary && summary !== errorText) {
          recordError(summary, run.id, at);
          runEvidences.push({ runId: run.id, location: '执行轮次回执', excerpt: summary });
        }
      }
    }

    const events = eventsForRun(eventsByRun, run.id);
    if (events.length > 0) {
      tool_repeats.push(...extractRunToolRepeats(run.id, events));
      for (const event of events) {
        if (event.kind !== 'diagnostic') continue;
        if (event.level === 'recovering') continue;
        recordError(event.message, run.id, at);
      }
    }
  }

  // Sort tool repeats by severity: consecutive errors desc, then total count desc.
  tool_repeats.sort(
    (a, b) =>
      b.consecutive_errors - a.consecutive_errors
      || b.error_count - a.error_count
      || b.count - a.count
      || a.name.localeCompare(b.name),
  );

  // Sort deduplicated errors by count desc, then earliest timestamp asc.
  const error_facts = [...errorMap.values()].sort(
    (a, b) => b.count - a.count || a.first_at.localeCompare(b.first_at),
  );

  // Count actual rejections / reworks separately from tier escalations so one rejection + escalation
  // never reports as "2 rejections/reworks".
  const reworkRejectCount = ping_pong.filter((item) => item.kind !== 'escalation').length;

  const noteworthy =
    reworkRejectCount >= 2
    || escalations >= 1
    || tool_repeats.length >= 1
    || failed_rounds >= 2;

  const noteworthy_reasons: string[] = [];
  if (reworkRejectCount >= 2) {
    noteworthy_reasons.push(`发生 ${reworkRejectCount} 次打回/返工`);
  } else if (reworkRejectCount === 1 && escalations >= 1) {
    noteworthy_reasons.push('发生 1 次打回/返工');
  }
  if (escalations >= 1) {
    noteworthy_reasons.push(`触发 ${escalations} 次升档`);
  }
  if (tool_repeats.length >= 1) {
    for (const item of tool_repeats.slice(0, 2)) {
      if (item.consecutive_errors >= TOOL_CONSECUTIVE_ERROR_MIN && item.count < TOOL_REPEAT_MIN_COUNT) {
        noteworthy_reasons.push(`工具「${item.name}」连续失败 ${item.consecutive_errors} 次`);
      } else if (item.consecutive_errors >= TOOL_CONSECUTIVE_ERROR_MIN) {
        noteworthy_reasons.push(`工具「${item.name}」重复执行 ${item.count} 次（连续失败 ${item.consecutive_errors} 次）`);
      } else {
        noteworthy_reasons.push(`工具「${item.name}」重复执行 ${item.count} 次`);
      }
    }
    if (tool_repeats.length > 2) {
      noteworthy_reasons.push(`另有 ${tool_repeats.length - 2} 项工具重复或连续失败`);
    }
  }
  if (failed_rounds >= 2) {
    noteworthy_reasons.push(`累计 ${failed_rounds} 轮执行失败`);
  }

  const coverage = summarizeCoverage(orderedRuns, input.coverageByRun);

  const proposal_draft = noteworthy
    ? buildProposalDraft(
        task,
        orderedRuns,
        noteworthy_reasons,
        ping_pong,
        escalations,
        tool_repeats,
        error_facts,
        failed_rounds,
        runEvidences,
      )
    : null;

  return {
    task_id: task.id,
    project_id: task.project_id,
    analyzed_runs: coverage.loaded_runs,
    failed_rounds,
    escalations,
    noteworthy,
    noteworthy_reasons,
    ping_pong,
    tool_repeats,
    error_facts,
    proposal_draft,
    coverage,
  };
}

function summarizeCoverage(
  orderedRuns: readonly FactRunInput[],
  coverageByRun?: ExtractTaskFactsInput['coverageByRun'],
): TaskRunFactsCoverage {
  if (!coverageByRun) {
    return { loaded_runs: orderedRuns.length, incomplete_runs: 0, reasons: [] };
  }
  let loaded_runs = 0;
  let incomplete_runs = 0;
  const reasonSet = new Set<string>();
  for (const run of orderedRuns) {
    const entry = coverageByRun instanceof Map
      ? coverageByRun.get(run.id)
      : (Object.hasOwn(coverageByRun, run.id) ? (coverageByRun as Record<string, RunEventCoverageInput>)[run.id] : undefined);
    if (!entry) {
      loaded_runs += 1;
      continue;
    }
    const truncated = typeof entry.firstIndex === 'number' && entry.firstIndex > 0;
    if (entry.loaded && !truncated && !entry.reason) {
      loaded_runs += 1;
    } else {
      if (entry.loaded) loaded_runs += 1;
      incomplete_runs += 1;
      if (entry.reason) reasonSet.add(scrubSecrets(entry.reason));
      else if (truncated) reasonSet.add('部分轮次的早期事件已按保留上限截断');
      else if (!entry.loaded) reasonSet.add('部分轮次的执行事件未能读取');
    }
  }
  return { loaded_runs, incomplete_runs, reasons: [...reasonSet] };
}
