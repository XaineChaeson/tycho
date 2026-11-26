// Right-hand Claude-Projects-style workspace rail for a project: segmented tabs for
// execution threads (waiting / running / recent resumable + snoozed), compact project files,
// and active project knowledge & skills.
import { useQuery } from '@tanstack/react-query';
import { BellOff, BellRing, BookOpen, ChevronDown, CornerDownRight, FolderOpen, Layers } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { GLOBAL_LABEL, KIND_LABELS } from '@shared/knowledge.ts';
import { taskLine, WORK_GROUPS, workGroup } from '@shared/labels.ts';
import { Dot, Note, Problem, StatusDot, Time, type Tone } from '@/components/bits';
import { isProjectLibraryFile, ProjectFilesPanel } from '@/components/project-files';
import { TaskIdentityStrip } from '@/components/task-identity-strip';
import { Progress } from '@/components/work-row';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { knowledgeQuery, projectFilesQuery, tasksQuery } from '@/lib/queries';
import type { KnowledgeEntry, ProjectFileSummary, Task } from '@/lib/types';
import { cn } from '@/lib/utils';

export type RailTab = 'threads' | 'files' | 'knowledge';

export interface ProjectWorkspaceRailProps {
  projectId: string;
  activeTab: RailTab;
  onTabChange: (tab: RailTab) => void;
  selectedThreadId?: string | null;
  onSelectThread: (taskId: string) => void;
  onAttachToComposer?: (file: ProjectFileSummary) => void;
}

const RAIL_TABS: readonly { id: RailTab; label: string; icon: typeof Layers }[] = [
  { id: 'threads', label: '线程', icon: Layers },
  { id: 'files', label: '文件', icon: FolderOpen },
  { id: 'knowledge', label: '知识', icon: BookOpen },
];

const MAX_RECENT_RESUMABLE = 10;
const KNOWLEDGE_PREVIEW_LIMIT = 420;
export const SNOOZED_STORAGE_KEY = 'tycho.snoozedTasks';

export interface SnoozeEntry {
  at: number;
  state: string;
}

export type SnoozeMap = Record<string, SnoozeEntry>;

type ResumableTask = Task & { resumable?: boolean };
type MachineScopedEntry = KnowledgeEntry & { machine_ids?: string[] | null };

function readSnoozed(): SnoozeMap {
  try {
    const raw = window.localStorage.getItem(SNOOZED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: SnoozeMap = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        entry
        && typeof entry === 'object'
        && typeof (entry as SnoozeEntry).at === 'number'
        && typeof (entry as SnoozeEntry).state === 'string'
      ) {
        clean[id] = { at: (entry as SnoozeEntry).at, state: (entry as SnoozeEntry).state };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function writeSnoozed(map: SnoozeMap): void {
  try {
    if (Object.keys(map).length === 0) window.localStorage.removeItem(SNOOZED_STORAGE_KEY);
    else window.localStorage.setItem(SNOOZED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage write failures (private mode / quota).
  }
}

function shouldAutoUnsnooze(task: Task, entry: SnoozeEntry): boolean {
  return (task.state === 'waiting_person' || task.state === 'ready') && task.state !== entry.state;
}

const isInReview = (task: Task): boolean =>
  task.state === 'ready' && (
    task.review_gate?.kind === 'in_review'
    || Boolean(task.active_review)
    || task.summary?.dot === 'running'
  );

type ActionPillTone = 'waiting' | 'running' | 'failed' | 'brand' | 'ended';

interface ActionPill {
  label: string;
  tone: ActionPillTone;
  resumable?: boolean;
}

const PILL_STYLES: Record<ActionPillTone, string> = {
  waiting: 'border-waiting-border/85 bg-waiting-soft/85 text-waiting-foreground',
  running: 'border-running-border/80 bg-running-soft/75 text-running-foreground',
  failed: 'border-failed-border/85 bg-failed-soft/85 text-failed-foreground',
  brand: 'border-brand-border/80 bg-brand-soft/75 text-brand-foreground',
  ended: 'border-border bg-muted text-muted-foreground',
};

function actionPillOf(task: ResumableTask, showResumablePill: boolean): ActionPill | null {
  if (task.state === 'waiting_person' || task.summary?.dot === 'waiting_person') {
    return { label: '待回复', tone: 'waiting' };
  }
  if (task.state === 'held') {
    return { label: '已停住', tone: 'failed' };
  }
  if (isInReview(task)) {
    return { label: '审阅中', tone: 'running' };
  }
  if (task.state === 'ready') {
    return { label: '待验收', tone: 'waiting' };
  }
  if (task.state === 'running' || task.state === 'stopping') {
    return { label: '执行中', tone: 'running' };
  }
  if (task.state === 'queued' || task.state === 'waiting_timer' || task.state === 'needs_verification') {
    return { label: '排队中', tone: 'ended' };
  }
  if (task.state === 'done' && showResumablePill && task.resumable === true) {
    return { label: '可续接', tone: 'brand', resumable: true };
  }
  return null;
}

function taskTimestamp(task: Task): string | null | undefined {
  return task.finished_at ?? task.updated_at ?? task.created_at;
}

function taskSortMs(task: Task): number {
  const raw = taskTimestamp(task);
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

function formatMachineBadge(machineIds: readonly string[]): { label: string; title: string } {
  const full = machineIds.join(', ');
  const short = machineIds.length <= 2
    ? full
    : `${machineIds.slice(0, 2).join(', ')} +${machineIds.length - 2}`;
  return { label: `机器: ${short}`, title: `机器: ${full}` };
}

function GroupHeader({
  tone,
  pulse = false,
  title,
  count,
}: {
  tone: Tone;
  pulse?: boolean;
  title: string;
  count: number;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-1">
      <Dot tone={tone} pulse={pulse} />
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      <span className="rounded-full bg-hover px-1.5 text-2xs leading-4 font-medium text-muted-foreground tabular-nums">
        {count}
      </span>
    </div>
  );
}

function ThreadCard({
  task,
  children,
  selected,
  showResumablePill,
  snoozed,
  onSelect,
  onToggleSnooze,
}: {
  task: ResumableTask;
  children: readonly Task[];
  selected: boolean;
  showResumablePill: boolean;
  snoozed: boolean;
  onSelect: (taskId: string) => void;
  onToggleSnooze: (task: ResumableTask) => void;
}) {
  const line = taskLine(task);
  const timestamp = taskTimestamp(task);
  const pill = actionPillOf(task, showResumablePill);

  return (
    <div className="group/thread relative" data-thread={task.id}>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(task.id)}
        className={cn(
          'flex min-h-[48px] w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors duration-100',
          selected
            ? 'border-brand-border bg-brand-soft/45 ring-1 ring-primary/30'
            : 'border-transparent bg-transparent hover:border-border hover:bg-muted/80',
          snoozed && !selected && 'opacity-75 hover:opacity-100',
        )}
      >
        <StatusDot state={task.summary?.dot ?? task.state} className="mt-0.5 size-3.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={task.title}>
              {task.title}
            </span>
            {pill ? (
              <span
                className={cn(
                  'inline-flex flex-none items-center gap-0.5 rounded-full border px-1.5 py-px text-2xs leading-3.5 font-medium whitespace-nowrap',
                  PILL_STYLES[pill.tone],
                )}
              >
                {pill.resumable ? <CornerDownRight className="size-2.5" aria-hidden="true" /> : null}
                {pill.label}
              </span>
            ) : null}
          </span>
          {task.assignment ? (
            <TaskIdentityStrip
              assignment={task.assignment}
              compact
              showLiveLabel
              className="mt-1"
            />
          ) : null}
          <span className="mt-0.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={line}>
              {line}
            </span>
            <span className="flex h-4 flex-none items-center gap-1.5">
              <Progress tasks={children} />
              <span className="inline-flex min-w-[44px] justify-end transition-opacity duration-100 group-hover/thread:opacity-0 group-focus-within/thread:opacity-0">
                {timestamp ? <Time at={timestamp} className="text-2xs text-faint" /> : null}
              </span>
            </span>
          </span>
        </span>
      </button>

      <button
        type="button"
        aria-label={snoozed ? '取消延后' : '延后'}
        title={snoozed ? '取消延后，恢复到列表' : '稍后提醒（延后）'}
        onClick={(event) => {
          event.stopPropagation();
          onToggleSnooze(task);
        }}
        className={cn(
          'absolute right-2 bottom-1.5 inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-raised px-1.5 text-2xs font-medium text-muted-foreground shadow-xs transition-opacity duration-100',
          'opacity-0 group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 focus-visible:opacity-100',
          'hover:border-border-strong hover:bg-hover hover:text-foreground',
        )}
      >
        {snoozed ? (
          <>
            <BellRing className="size-2.5" aria-hidden="true" />
            <span>取消延后</span>
          </>
        ) : (
          <>
            <BellOff className="size-2.5" aria-hidden="true" />
            <span>延后</span>
          </>
        )}
      </button>
    </div>
  );
}

function ThreadsPane({
  projectId,
  waitingThreads,
  runningThreads,
  recentDoneThreads,
  snoozedThreads,
  childrenByParent,
  selectedThreadId,
  loading,
  error,
  onSelectThread,
  onToggleSnooze,
}: {
  projectId: string;
  waitingThreads: readonly ResumableTask[];
  runningThreads: readonly ResumableTask[];
  recentDoneThreads: readonly ResumableTask[];
  snoozedThreads: readonly ResumableTask[];
  childrenByParent: ReadonlyMap<string, Task[]>;
  selectedThreadId?: string | null;
  loading: boolean;
  error: string | undefined;
  onSelectThread: (taskId: string) => void;
  onToggleSnooze: (task: ResumableTask) => void;
}) {
  const [doneOpen, setDoneOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const hasActive = waitingThreads.length > 0 || runningThreads.length > 0;
  const showDoneList = !hasActive || doneOpen || recentDoneThreads.some((t) => t.id === selectedThreadId);
  const hasAny = hasActive
    || recentDoneThreads.length > 0
    || snoozedThreads.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        {error ? <Problem role="alert" className="mb-2 px-1 text-xs">{error}</Problem> : null}
        {loading ? (
          <div className="flex flex-col gap-2 px-1" aria-hidden="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : hasAny ? (
          <div className="flex flex-col gap-4">
            {waitingThreads.length > 0 ? (
              <section aria-label="待你处理">
                <GroupHeader tone="waiting" title="待你处理" count={waitingThreads.length} />
                <div className="flex flex-col gap-1">
                  {waitingThreads.map((task) => (
                    <ThreadCard
                      key={task.id}
                      task={task}
                      children={childrenByParent.get(task.id) ?? []}
                      selected={selectedThreadId === task.id}
                      showResumablePill={false}
                      snoozed={false}
                      onSelect={onSelectThread}
                      onToggleSnooze={onToggleSnooze}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {runningThreads.length > 0 ? (
              <section aria-label="进行中">
                <GroupHeader tone="running" pulse title="进行中" count={runningThreads.length} />
                <div className="flex flex-col gap-1">
                  {runningThreads.map((task) => (
                    <ThreadCard
                      key={task.id}
                      task={task}
                      children={childrenByParent.get(task.id) ?? []}
                      selected={selectedThreadId === task.id}
                      showResumablePill={false}
                      snoozed={false}
                      onSelect={onSelectThread}
                      onToggleSnooze={onToggleSnooze}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {recentDoneThreads.length > 0 ? (
              <section aria-label="近期可续接" className={cn(hasActive && 'border-t border-border/70 pt-2')}>
                {hasActive ? (
                  <button
                    type="button"
                    aria-expanded={showDoneList}
                    onClick={() => setDoneOpen((prev) => !prev)}
                    className="flex w-full items-center gap-1.5 rounded-sm px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                  >
                    <Dot tone="success" pulse={false} />
                    <span className="font-medium">近期可续接</span>
                    <span className="rounded-xs bg-hover px-1.5 font-mono text-2xs leading-4 text-muted-foreground tabular-nums">
                      {recentDoneThreads.length}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        'ml-auto size-3.5 flex-none text-faint transition-transform duration-150',
                        showDoneList && 'rotate-180',
                      )}
                    />
                  </button>
                ) : (
                  <GroupHeader tone="success" title="近期可续接" count={recentDoneThreads.length} />
                )}
                {showDoneList ? (
                  <div className="mt-1 flex flex-col gap-1">
                    {recentDoneThreads.map((task) => (
                      <ThreadCard
                        key={task.id}
                        task={task}
                        children={childrenByParent.get(task.id) ?? []}
                        selected={selectedThreadId === task.id}
                        showResumablePill={true}
                        snoozed={false}
                        onSelect={onSelectThread}
                        onToggleSnooze={onToggleSnooze}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}

            {snoozedThreads.length > 0 ? (
              <section aria-label="已延后" className="border-t border-border/70 pt-2">
                <button
                  type="button"
                  aria-expanded={snoozedOpen}
                  onClick={() => setSnoozedOpen((prev) => !prev)}
                  className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                >
                  <BellOff className="size-3 flex-none text-faint" aria-hidden="true" />
                  <span className="font-medium">已延后</span>
                  <span className="rounded-full bg-hover px-1.5 text-2xs leading-4 text-muted-foreground tabular-nums">
                    {snoozedThreads.length}
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      'ml-auto size-3.5 flex-none text-faint transition-transform duration-150',
                      snoozedOpen && 'rotate-180',
                    )}
                  />
                </button>
                {snoozedOpen ? (
                  <div className="mt-1 flex flex-col gap-1">
                    {snoozedThreads.map((task) => (
                      <ThreadCard
                        key={task.id}
                        task={task}
                        children={childrenByParent.get(task.id) ?? []}
                        selected={selectedThreadId === task.id}
                        showResumablePill={task.state === 'done'}
                        snoozed={true}
                        onSelect={onSelectThread}
                        onToggleSnooze={onToggleSnooze}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border-strong bg-muted/35 px-3 py-5 text-center">
            <Note className="text-xs leading-relaxed">
              暂无线程。给负责人发消息，建好的执行线程会显示在这里。
            </Note>
          </div>
        )}
      </div>

      <footer className="flex flex-none items-center justify-between border-t border-border bg-background/80 px-3 py-2 text-xs">
        <Link
          to={`/projects/${encodeURIComponent(projectId)}/work`}
          className="text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          全部工作 →
        </Link>
      </footer>
    </div>
  );
}

function KnowledgeEntryCard({
  entry,
  machineIds,
  expanded,
  onToggle,
}: {
  entry: KnowledgeEntry;
  machineIds: readonly string[] | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isGlobal = entry.project_ids === null;
  const machineBadge = machineIds && machineIds.length > 0 ? formatMachineBadge(machineIds) : null;
  const trimmedBody = entry.body.trim();
  const bodyPreview = trimmedBody.length > KNOWLEDGE_PREVIEW_LIMIT
    ? `${trimmedBody.slice(0, KNOWLEDGE_PREVIEW_LIMIT).trimEnd()}…`
    : trimmedBody;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-raised">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/70 focus-visible:-outline-offset-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-foreground wrap-anywhere">
            {entry.title}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <Badge
              tone={isGlobal ? 'plain' : 'running'}
              className="min-h-4 px-1.5 py-0 text-2xs leading-3.5"
            >
              {isGlobal ? GLOBAL_LABEL : '本项目'}
            </Badge>
            {entry.kind === 'skill' ? (
              <Badge tone="waiting" className="min-h-4 px-1.5 py-0 text-2xs leading-3.5">
                {KIND_LABELS.skill}
              </Badge>
            ) : null}
            {machineBadge ? (
              <Badge
                tone="plain"
                title={machineBadge.title}
                className="min-h-4 px-1.5 py-0 text-2xs leading-3.5"
              >
                {machineBadge.label}
              </Badge>
            ) : null}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-3.5 flex-none text-faint transition-transform duration-150',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded ? (
        <div className="grid gap-2 border-t border-border/80 bg-muted/35 px-2.5 py-2 text-xs">
          {entry.when_to_use.trim() ? (
            <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
              <span className="block text-2xs font-medium text-faint">触发场景</span>
              <p className="mt-0.5 text-xs leading-relaxed text-foreground wrap-anywhere">
                {entry.when_to_use.trim()}
              </p>
            </div>
          ) : null}

          {bodyPreview ? (
            <p className="max-h-48 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground wrap-anywhere">
              {bodyPreview}
            </p>
          ) : null}

          <div className="flex justify-end pt-0.5">
            <Link
              to={`/knowledge/entries/${encodeURIComponent(entry.id)}`}
              className="text-2xs font-medium text-link no-underline hover:underline"
            >
              在知识库编辑 →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KnowledgePane({
  projectId,
  residentEntries,
  onDemandEntries,
  entryMachines,
  loading,
  error,
}: {
  projectId: string;
  residentEntries: readonly MachineScopedEntry[];
  onDemandEntries: readonly MachineScopedEntry[];
  entryMachines: Readonly<Record<string, string[] | null>> | undefined;
  loading: boolean;
  error: string | undefined;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleEntry = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasAny = residentEntries.length > 0 || onDemandEntries.length > 0;
  const resolveMachines = (entry: MachineScopedEntry): readonly string[] | null =>
    entry.machine_ids ?? entryMachines?.[entry.id] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        {error ? <Problem role="alert" className="mb-2 px-1 text-xs">{error}</Problem> : null}
        {loading ? (
          <div className="flex flex-col gap-2 px-1" aria-hidden="true">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : hasAny ? (
          <div className="flex flex-col gap-4">
            {residentEntries.length > 0 ? (
              <section aria-label="常驻规则与记忆">
                <GroupHeader tone="running" pulse={false} title="常驻规则与记忆" count={residentEntries.length} />
                <div className="flex flex-col gap-1.5">
                  {residentEntries.map((entry) => (
                    <KnowledgeEntryCard
                      key={entry.id}
                      entry={entry}
                      machineIds={resolveMachines(entry)}
                      expanded={expandedIds.has(entry.id)}
                      onToggle={() => toggleEntry(entry.id)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {onDemandEntries.length > 0 ? (
              <section aria-label="按需知识与技能">
                <GroupHeader tone="ended" title="按需知识与技能" count={onDemandEntries.length} />
                <div className="flex flex-col gap-1.5">
                  {onDemandEntries.map((entry) => (
                    <KnowledgeEntryCard
                      key={entry.id}
                      entry={entry}
                      machineIds={resolveMachines(entry)}
                      expanded={expandedIds.has(entry.id)}
                      onToggle={() => toggleEntry(entry.id)}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border-strong bg-muted/35 px-3 py-5 text-center">
            <Note className="text-xs leading-relaxed">
              暂无适用于本项目的生效知识条目。
            </Note>
          </div>
        )}
      </div>

      <footer className="flex flex-none flex-wrap items-center justify-between gap-2 border-t border-border bg-background/80 px-3 py-2 text-xs">
        <Link
          to="/knowledge"
          className="text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          管理全部知识 →
        </Link>
        <Link
          to={`/projects/${encodeURIComponent(projectId)}/settings`}
          className="text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          项目常驻规则 →
        </Link>
      </footer>
    </div>
  );
}

export function ProjectWorkspaceRail({
  projectId,
  activeTab,
  onTabChange,
  selectedThreadId = null,
  onSelectThread,
  onAttachToComposer,
}: ProjectWorkspaceRailProps) {
  const idPrefix = useId();
  const tasksRes = useQuery(tasksQuery);
  const filesRes = useQuery(projectFilesQuery(projectId));
  const knowledgeRes = useQuery(knowledgeQuery);
  const [snoozed, setSnoozed] = useState<SnoozeMap>(readSnoozed);

  // Auto-unsnooze any task whose state transitioned to waiting_person or ready after it was snoozed.
  useEffect(() => {
    const tasks = tasksRes.data?.tasks;
    if (!tasks || tasks.length === 0) return;
    setSnoozed((prev) => {
      let changed = false;
      const next: SnoozeMap = { ...prev };
      for (const task of tasks) {
        const entry = prev[task.id];
        if (entry && shouldAutoUnsnooze(task, entry)) {
          delete next[task.id];
          changed = true;
        }
      }
      if (!changed) return prev;
      writeSnoozed(next);
      return next;
    });
  }, [tasksRes.data?.tasks]);

  function toggleSnooze(task: ResumableTask): void {
    setSnoozed((prev) => {
      const next: SnoozeMap = { ...prev };
      if (next[task.id]) {
        delete next[task.id];
      } else {
        next[task.id] = { at: Date.now(), state: task.state };
      }
      writeSnoozed(next);
      return next;
    });
  }

  const { waitingThreads, runningThreads, recentDoneThreads, snoozedThreads, childrenByParent } = useMemo(() => {
    const projectTasks = (tasksRes.data?.tasks ?? []).filter(
      (task) => task.project_id === projectId && task.state !== 'abandoned',
    ) as ResumableTask[];

    const waiting: ResumableTask[] = [];
    const running: ResumableTask[] = [];
    const done: ResumableTask[] = [];
    const deferred: ResumableTask[] = [];

    for (const task of projectTasks) {
      const snoozeEntry = snoozed[task.id];
      if (snoozeEntry && !shouldAutoUnsnooze(task, snoozeEntry)) {
        deferred.push(task);
        continue;
      }
      const group = workGroup(task);
      if (group === WORK_GROUPS.waiting || group === WORK_GROUPS.ready) {
        waiting.push(task);
      } else if (group === WORK_GROUPS.moving) {
        running.push(task);
      } else if (group === WORK_GROUPS.ended && task.state === 'done') {
        done.push(task);
      }
    }

    waiting.sort((a, b) => taskSortMs(b) - taskSortMs(a));
    running.sort((a, b) => taskSortMs(b) - taskSortMs(a));
    done.sort((a, b) => taskSortMs(b) - taskSortMs(a));
    deferred.sort((a, b) => (snoozed[b.id]?.at ?? 0) - (snoozed[a.id]?.at ?? 0));

    const childMap = new Map<string, Task[]>();
    for (const child of tasksRes.data?.children ?? []) {
      if (!child.parent_id) continue;
      const list = childMap.get(child.parent_id);
      if (list) list.push(child);
      else childMap.set(child.parent_id, [child]);
    }

    return {
      waitingThreads: waiting,
      runningThreads: running,
      recentDoneThreads: done.slice(0, MAX_RECENT_RESUMABLE),
      snoozedThreads: deferred,
      childrenByParent: childMap,
    };
  }, [tasksRes.data, projectId, snoozed]);

  const { residentEntries, onDemandEntries, knowledgeCount } = useMemo(() => {
    const active = (knowledgeRes.data?.entries ?? []).filter(
      (entry) => entry.state === 'active' && (entry.project_ids === null || entry.project_ids.includes(projectId)),
    ) as MachineScopedEntry[];

    const resident: MachineScopedEntry[] = [];
    const onDemand: MachineScopedEntry[] = [];
    for (const entry of active) {
      if (entry.loading === 'resident') resident.push(entry);
      else onDemand.push(entry);
    }

    return {
      residentEntries: resident,
      onDemandEntries: onDemand,
      knowledgeCount: active.length,
    };
  }, [knowledgeRes.data, projectId]);

  const openThreadCount = waitingThreads.length + runningThreads.length;
  const fileCount = (filesRes.data?.files ?? []).filter(isProjectLibraryFile).length;

  const counts: Record<RailTab, number> = {
    threads: openThreadCount,
    files: fileCount,
    knowledge: knowledgeCount,
  };

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = RAIL_TABS[(index + delta + RAIL_TABS.length) % RAIL_TABS.length]!;
    onTabChange(next.id);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Top segmented tab bar */}
      <div className="flex-none border-b border-border px-2.5 py-2">
        <div
          role="tablist"
          aria-label="项目工作台"
          className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
        >
          {RAIL_TABS.map((tab, index) => {
            const selected = activeTab === tab.id;
            const Icon = tab.icon;
            const count = counts[tab.id];
            return (
              <button
                key={tab.id}
                id={`${idPrefix}-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${idPrefix}-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  'inline-flex min-h-7 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors duration-100',
                  selected
                    ? 'bg-raised text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-3.5 flex-none opacity-80" aria-hidden="true" />
                <span>{tab.label}</span>
                {count > 0 ? (
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-2xs leading-4 tabular-nums',
                      tab.id === 'threads' && waitingThreads.length > 0
                        ? 'bg-waiting-soft text-waiting-foreground'
                        : selected
                          ? 'bg-brand-soft text-brand-foreground'
                          : 'bg-hover text-muted-foreground',
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active tab panel */}
      <div
        id={`${idPrefix}-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-tab-${activeTab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {activeTab === 'threads' ? (
          <ThreadsPane
            projectId={projectId}
            waitingThreads={waitingThreads}
            runningThreads={runningThreads}
            recentDoneThreads={recentDoneThreads}
            snoozedThreads={snoozedThreads}
            childrenByParent={childrenByParent}
            selectedThreadId={selectedThreadId}
            loading={tasksRes.isPending}
            error={tasksRes.error?.message}
            onSelectThread={onSelectThread}
            onToggleSnooze={toggleSnooze}
          />
        ) : activeTab === 'files' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
            <ProjectFilesPanel
              projectId={projectId}
              onAttachToComposer={onAttachToComposer}
              compact
            />
          </div>
        ) : (
          <KnowledgePane
            projectId={projectId}
            residentEntries={residentEntries}
            onDemandEntries={onDemandEntries}
            entryMachines={knowledgeRes.data?.entry_machines}
            loading={knowledgeRes.isPending}
            error={knowledgeRes.error?.message}
          />
        )}
      </div>
    </div>
  );
}
