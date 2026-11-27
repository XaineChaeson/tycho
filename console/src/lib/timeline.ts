import { t } from '@shared/i18n.ts';
import type { DiagnosticLevel, FileChange, NormalizedEvent, ToolCall, ToolOutput } from './types.ts';

const MAX_BUFFERED = 2000;
const MAX_RETAINED_EVENTS = 2500;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export type ToolStatus = 'running' | 'completed' | 'failed' | 'incomplete';

export interface ToolRow {
  kind: 'tool';
  id: string;
  call: ToolCall;
  status: ToolStatus;
  output?: ToolOutput;
  exitCode?: number;
  reason?: string;
  changes?: FileChange[];
}

// One thing the executor said about itself, as often as it said it in this round.
export interface Diagnostic {
  level: DiagnosticLevel;
  message: string;
  count: number;
}

type TimelineRow =
  | { kind: 'text'; text: string }
  // `live` while it is the last thing a running round did: it is still thinking.
  | { kind: 'thinking'; text: string; live: boolean }
  | ToolRow
  // Neighbouring reads and searches that did not fail, two or more of them.
  | { kind: 'group'; tools: ToolRow[] }
  | ({ kind: 'fatal' } & Diagnostic)
  | { kind: 'truncated'; dropped: number }
  | { kind: 'interrupted' };

// One round's site, as the task page reads it. Process and Run states remain the ledger's.
export interface Site {
  rows: TimelineRow[];
  // Warnings and retries, apart from the rows, each said once with how often.
  diagnostics: Diagnostic[];
  // The retry the round is in now, while it runs.
  retrying?: { attempt?: number; maxRetries?: number };
  // Files completed calls report they changed: what an edit names, as the executor said it.
  changes: FileChange[];
  calls: number;
  failures: number;
}

type Schedule = (fn: () => void, delay: number) => unknown;
type Cancel = (timer: unknown) => void;
const later: Schedule = (fn, delay) => setTimeout(fn, delay);
const forget: Cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>);

function endTool(row: ToolRow, event: Extract<NormalizedEvent, { kind: 'tool.end' }>): void {
  row.status = event.isError ? 'failed' : 'completed';
  if (event.output) row.output = event.output;
  if (event.exitCode !== undefined) row.exitCode = event.exitCode;
  if (event.reason !== undefined) row.reason = event.reason;
  if (event.changes) row.changes = event.changes;
}

// Consecutive non-failed tool calls of any kind fold into one compact progress capsule so
// multi-step tool chains never bury Worker prose; failed calls stay outside with their reason.
function group(rows: TimelineRow[]): TimelineRow[] {
  const result: TimelineRow[] = [];
  let run: ToolRow[] = [];
  const flush = (): void => {
    if (run.length > 1) result.push({ kind: 'group', tools: run });
    else result.push(...run);
    run = [];
  };
  for (const row of rows) {
    if (row.kind === 'tool' && row.status !== 'failed') run.push(row);
    else { flush(); result.push(row); }
  }
  flush();
  return result;
}

// What completed edits report, one entry per file: an add stays an add, patches add up.
function changesOf(tools: ToolRow[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const row of tools) {
    if (row.status !== 'completed' || row.call.category !== 'edit') continue;
    const reported: FileChange[] = row.changes ?? (row.call.paths ?? []).map((path) => ({ path }));
    for (const change of reported) {
      const before = byPath.get(change.path);
      const op = before?.op === 'add' && change.op !== 'delete' ? 'add' : change.op ?? before?.op;
      const patch = [before?.patch, change.patch].filter(Boolean).join('\n') || undefined;
      byPath.delete(change.path);
      byPath.set(change.path, { path: change.path, ...(op ? { op } : {}), ...(patch ? { patch } : {}) });
    }
  }
  return [...byPath.values()];
}

// A projection of display events. A call with no start and no description of itself has
// nothing to show and is left out; none is made up.
export function projectSite(events: readonly NormalizedEvent[], ended = false): Site {
  const rows: TimelineRow[] = [];
  const tools = new Map<string, ToolRow>();
  const said = new Map<string, Diagnostic>();
  const fatal = new Map<string, Extract<TimelineRow, { kind: 'fatal' }>>();
  // The last event the page shows something for: what the round is doing now (still
  // thinking, or in a retry) is read off it alone, so the two never stand at once.
  let latest: NormalizedEvent | undefined;
  let previousKind: string | undefined;
  for (const event of events) {
    const consecutive = previousKind === event.kind;
    previousKind = event.kind;
    if (event.kind === 'usage' || event.kind === 'quota') continue;
    latest = event;
    if (event.kind === 'diagnostic') {
      if (event.level === 'fatal') {
        const known = fatal.get(event.message);
        if (known) known.count += 1;
        else {
          const row = { kind: 'fatal' as const, level: event.level, message: event.message, count: 1 };
          fatal.set(event.message, row);
          rows.push(row);
        }
        continue;
      }
      const key = `${event.level}\n${event.message}`;
      const known = said.get(key);
      if (known) known.count += 1;
      else said.set(key, { level: event.level, message: event.message, count: 1 });
      continue;
    }
    if (event.kind === 'turn.end') continue;
    if (event.kind === 'tool.end') {
      let row = tools.get(event.id);
      if (!row && event.call) {
        row = { kind: 'tool', id: event.id, call: event.call, status: 'completed' };
        tools.set(event.id, row);
        rows.push(row);
      }
      if (row) endTool(row, event);
      continue;
    }
    const previous = rows.at(-1);
    if ((event.kind === 'text' || event.kind === 'thinking') && consecutive && previous?.kind === event.kind) {
      previous.text += event.text;
      continue;
    }
    if (event.kind === 'tool.start') {
      const { kind: _kind, id, ...call } = event;
      const row: ToolRow = { kind: 'tool', id, call, status: ended ? 'incomplete' : 'running' };
      rows.push(row);
      tools.set(id, row);
    } else if (event.kind === 'thinking') rows.push({ kind: 'thinking', text: event.text, live: false });
    else rows.push({ ...event });
  }
  const last = rows.at(-1);
  if (!ended && latest?.kind === 'thinking' && last?.kind === 'thinking') last.live = true;
  const retrying = !ended && latest?.kind === 'diagnostic' && latest.level === 'recovering'
    ? { attempt: latest.attempt, maxRetries: latest.maxRetries }
    : undefined;
  const calls = [...tools.values()];
  return {
    rows: group(rows),
    diagnostics: [...said.values()],
    ...(retrying ? { retrying } : {}),
    changes: changesOf(calls),
    calls: calls.length,
    failures: calls.filter((row) => row.status === 'failed').length,
  };
}

// What a group of routine tool calls comes to: calls apart from files, since one file
// read or edited twice is two calls on one file.
export function groupSummary(tools: readonly ToolRow[]): string {
  const reads = tools.filter((row) => row.call.category === 'read');
  const files = new Set(reads.flatMap((row) => row.call.paths ?? [])).size;
  const searches = tools.filter((row) => row.call.category === 'search').length;
  const edits = tools.filter((row) => row.call.category === 'edit');
  const editFiles = new Set(edits.flatMap((row) => row.call.paths ?? [])).size;
  const runs = tools.filter((row) => row.call.category === 'run').length;
  const others = tools.length - reads.length - searches - edits.length - runs;
  const parts: string[] = [];
  if (reads.length) {
    parts.push(
      files === reads.length
        ? t('tsk.timeline.readFiles', { files })
        : files
          ? t('tsk.timeline.readCallsAndFiles', { calls: reads.length, files })
          : t('tsk.timeline.readCalls', { calls: reads.length }),
    );
  }
  if (searches) parts.push(t('tsk.timeline.searchCalls', { count: searches }));
  if (edits.length) {
    parts.push(
      editFiles === edits.length
        ? t('tsk.timeline.editFiles', { files: editFiles })
        : editFiles
          ? t('tsk.timeline.editCallsAndFiles', { calls: edits.length, files: editFiles })
          : t('tsk.timeline.editCalls', { calls: edits.length }),
    );
  }
  if (runs) parts.push(t('tsk.timeline.runCalls', { count: runs }));
  if (others) parts.push(t('tsk.timeline.otherCalls', { count: others }));
  return parts.join(t('tsk.timeline.listSep'));
}

// On an ended round that already has a structured receipt card below, the very last text
// row is typically the raw final message containing the receipt fence. Keep it tucked away
// while preserving every earlier progress narrative on the main timeline.
export function trailingReceiptTextIndex(rows: readonly TimelineRow[], hasReceipt: boolean): number {
  if (!hasReceipt || rows.length === 0) return -1;
  return rows.at(-1)?.kind === 'text' ? rows.length - 1 : -1;
}

export function hasVisibleNarrative(rows: readonly TimelineRow[], hasReceipt: boolean): boolean {
  const trailing = trailingReceiptTextIndex(rows, hasReceipt);
  return rows.some((row, index) => row.kind === 'text' && index !== trailing);
}

// The one line the warnings and retries of a round fold into.
export function diagnosticsSummary(diagnostics: readonly Diagnostic[]): string {
  const warnings = diagnostics.filter((each) => each.level === 'warning').length;
  const retries = diagnostics.filter((each) => each.level === 'recovering').reduce((total, each) => total + each.count, 0);
  return [
    warnings ? t('tsk.timeline.warningsCount', { count: warnings }) : '',
    retries ? t('tsk.timeline.retriesCount', { count: retries }) : '',
  ].filter(Boolean).join(t('tsk.timeline.listSep'));
}

// The snapshot is authoritative after a reconnect; events during a failed read can be discarded.
export function createTimelineReader<T, E>({ load, onLoad, onEvent, onStatus, schedule = later, cancel = forget }: {
  load: () => Promise<T>;
  onLoad: (value: T) => void;
  onEvent: (event: E) => void;
  onStatus: (text: string) => void;
  schedule?: Schedule;
  cancel?: Cancel;
}) {
  let state: 'idle' | 'reading' | 'ready' | 'retrying' | 'closed' = 'idle';
  let buffered: E[] = [];
  let omitted = false;
  let reread = false;
  let backoff = FIRST_RETRY_MS;
  let timer: unknown;
  const closed = (): boolean => state === 'closed';
  async function read(): Promise<void> {
    if (state === 'closed') return;
    if (state === 'reading') {
      // A terminal transition or reconnect arrived mid-read: queue one trailing read so
      // final events committed after the in-flight snapshot started are never lost.
      reread = true;
      return;
    }
    if (timer !== undefined) { cancel(timer); timer = undefined; }
    state = 'reading'; buffered = []; reread = false;
    try {
      const result = await load();
      if (closed()) return;
      onLoad(result);
      for (const event of buffered) onEvent(event);
      buffered = []; state = 'ready'; backoff = FIRST_RETRY_MS;
      onStatus(omitted ? t('tsk.timeline.earlierOmitted') : '');
      if (reread) {
        reread = false;
        void read();
      }
    } catch {
      if (closed()) return;
      buffered = []; state = 'retrying'; reread = false;
      onStatus(omitted ? t('tsk.timeline.readFailedRetryingOmitted') : t('tsk.timeline.readFailedRetrying'));
      timer = schedule(() => { timer = undefined; void read(); }, backoff);
      backoff = Math.min(backoff * 2, MAX_RETRY_MS);
    }
  }
  return {
    read,
    push(event: E): void {
      if (state === 'reading') {
        buffered.push(event);
        if (buffered.length > MAX_BUFFERED) { buffered.shift(); omitted = true; }
      } else if (state === 'ready') onEvent(event);
    },
    bufferedCount: (): number => buffered.length,
    isRetrying: (): boolean => state === 'retrying',
    close(): void { state = 'closed'; buffered = []; reread = false; if (timer !== undefined) cancel(timer); },
  };
}

interface EventsSnapshot<E> {
  events: E[];
  first_index?: number;
}

// One Run's events: a snapshot, plus the numbered live events after it. A live event past
// a hole waits for a fresh snapshot, and a read that still leaves a hole schedules the
// next one: the Worker may have gone quiet, so no later event is coming to prompt it.
export function createRunEvents<E>({ load, onChange, onStatus, schedule = later, cancel = forget }: {
  load: () => Promise<EventsSnapshot<E>>;
  onChange: () => void;
  onStatus: (text: string) => void;
  schedule?: Schedule;
  cancel?: Cancel;
}) {
  let events: E[] = [];
  let base = 0;
  const waiting = new Map<number, E>();
  let reading = false;
  let closed = false;
  let timer: unknown;
  let backoff = FIRST_RETRY_MS;
  let failed = false;
  let omitted = false;
  let status = '';
  const end = (): number => base + events.length;
  function report(): void {
    const next = failed ? t('tsk.timeline.readFailedRetrying') : omitted ? t('tsk.timeline.earlierOmitted') : '';
    if (next !== status) { status = next; onStatus(next); }
  }
  function accept(index: number, event: E): void {
    if (index >= end()) waiting.set(index, event);
    if (waiting.size > MAX_BUFFERED) { waiting.delete(waiting.keys().next().value!); omitted = true; }
    let appended: E[] | null = null;
    while (waiting.has(end() + (appended?.length ?? 0))) {
      const next = end() + (appended?.length ?? 0);
      if (!appended) appended = [];
      appended.push(waiting.get(next)!);
      waiting.delete(next);
    }
    if (appended) {
      const combined = [...events, ...appended];
      if (combined.length > MAX_RETAINED_EVENTS) {
        const drop = combined.length - MAX_RETAINED_EVENTS;
        events = combined.slice(drop);
        base += drop;
        omitted = true;
      } else {
        events = combined;
      }
    }
  }
  function adopt(snapshot: EventsSnapshot<E>): void { events = snapshot.events; base = snapshot.first_index ?? 0; }
  async function catchUp(): Promise<void> {
    if (reading || closed || timer !== undefined || !waiting.size) return;
    reading = true;
    try {
      const snapshot = await load();
      if (closed) return;
      if ((snapshot.first_index ?? 0) + snapshot.events.length >= end()) adopt(snapshot);
      const queued = [...waiting].sort(([a], [b]) => a - b);
      waiting.clear();
      for (const [index, event] of queued) accept(index, event);
      failed = false;
    } catch {
      if (closed) return;
      failed = true;
    }
    reading = false;
    if (waiting.size) {
      timer = schedule(() => { timer = undefined; void catchUp(); }, backoff);
      backoff = Math.min(backoff * 2, MAX_RETRY_MS);
    } else {
      backoff = FIRST_RETRY_MS; omitted = false;
    }
    report();
    onChange();
  }
  return {
    events: (): E[] => events,
    gap: (): boolean => waiting.size > 0,
    // From the whole page's read, which supersedes anything still waiting.
    reset(snapshot: EventsSnapshot<E>): void {
      if (timer !== undefined) { cancel(timer); timer = undefined; }
      waiting.clear(); backoff = FIRST_RETRY_MS; failed = false; omitted = false;
      adopt(snapshot);
      report();
    },
    push({ index, event }: { index: number; event: E }): void {
      accept(index, event);
      report();
      void catchUp();
    },
    close(): void { closed = true; waiting.clear(); if (timer !== undefined) cancel(timer); },
  };
}

const BRIEF_GOAL_HEADINGS = ['目标', '被审目标', 'Goal', 'Reviewed Goal'] as const; // i18n-ignore
const BRIEF_ACCEPTANCE_HEADINGS = ['验收标准', 'Acceptance Criteria', 'Acceptance'] as const; // i18n-ignore

export function dispatchSummary(
  task: { revision?: number; goal?: string; acceptance?: string | null },
  run: { task_revision: number },
  snapshot?: { brief?: string },
): { goal: string; acceptance: string; brief: string } {
  const brief = snapshot?.brief;
  const section = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const match = brief?.match(new RegExp(`## ${name}\\n\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1]?.trim();
      if (match) return match;
    }
    return undefined;
  };
  const sameRevision = run.task_revision === task.revision;
  return {
    goal: section(BRIEF_GOAL_HEADINGS) || (sameRevision ? task.goal : null) || t('tsk.timeline.noGoalSummary'),
    acceptance: section(BRIEF_ACCEPTANCE_HEADINGS) || (sameRevision ? task.acceptance : null) || t('tsk.timeline.noAcceptanceSummary'),
    brief: brief ?? t('tsk.timeline.noBrief'),
  };
}

// Plain single-line preview of a frozen dispatch goal for the collapsed disclosure row.
export function goalPreview(markdown: string, maxChars = 120): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxChars) return plain;
  return `${plain.slice(0, maxChars - 1).trimEnd()}…`;
}
