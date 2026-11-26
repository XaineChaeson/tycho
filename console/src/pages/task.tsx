// A Task's own page. What needs the owner comes first — a round to accept, a question, a
// stop to lift. Under it the site: each round's dispatch note and what the Worker did, its
// report, what the owner put in between. Beside it the facts: what the Task is, where it
// runs, how it was reviewed, the rounds one by one, what it produced.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TaskFeedbackPanel } from '@/components/task-feedback';
import { RunDiagnosticsButton } from '@/components/run-diagnostics';
import { RunFactsCard } from '@/components/run-facts-card';
import { ArrowDownToLine, Check, Code2, CornerDownLeft, Download, ExternalLink, FileText, GitMerge, Image as ImageIcon, Maximize2, MessageSquare, Minimize2, Minus, Pencil, RefreshCw, Rocket, Send, Square, Trash2, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ANY_LOGIN_TEXT, artifactsDroppedText, RECEIPT_STATUS_LABELS, exitKindLabels as EXIT_TEXT, taskLine, taskStateLabels, placedByLabels, quotaEndLine, runStateLabels, loginLine, incompleteReleaseLine } from '@shared/labels.ts';
import { loginName } from '@shared/logins.ts';
import { type ReviewedCommit, type SnapshotSource, type SourceView, type TaskSource, type TaskSourceState } from '@shared/sources.ts';
import { pullRequestReading, type PullRequestReading } from '@shared/pull-request.ts';
import { accessText, codeCheckText, OLD_NO_ROLE_TEXT, TIER_SOURCE_TEXT, type TierSource } from '@shared/roles.ts';
import { machineInputsText } from '@shared/machine-inputs.ts';
import { ROUTER_CALL_RESULT_TEXT } from '@shared/trajectory.ts';
import { TIERS, tierLabel, tierSubstituteText } from '@shared/tiers.ts';
import { knowledgeTaskPlaceText } from '@shared/knowledge.ts';
import { isDirectorySkillId } from '@shared/skill-catalog.ts';
import { listText, SAME_EXECUTOR_LABEL, VERDICT_LABELS, type VerdictRecord } from '@shared/review.ts';
import { ApprovalCard } from '@/components/approval-card';
import { ArtifactFrame, ImageLightbox } from '@/components/artifact-preview';
import { Callout, Copyable, Details, Mono, Note, PRE, Problem, StateBadge, StatusDot, Time } from '@/components/bits';
import { ComposerTargetChip } from '@/components/composer-target-chip';
import { LARGE_PASTE_THRESHOLD, PastedSnippetChips, createPastedSnippet, formatTextWithSnippets, type PastedSnippet } from '@/components/composer-triggers';
import { formatFileSize } from '@/components/project-files';
import { FileChanges, SiteRows, processTitle } from '@/components/run-site';
import { TaskDiffPanel, type CheckpointCommit } from '@/components/task-diff-panel';
import { PageBar, PageTitle, type Crumb } from '@/components/page';
import { PageScroll } from '@/components/page-scroll';
import { TaskActions, TaskStatus, useTaskAct, type TaskAct } from '@/components/task-actions';
import { TaskIdentityStrip, synthesizeTaskAssignment } from '@/components/task-identity-strip';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { Skeleton, SkeletonPage } from '@/components/ui/skeleton';
import { useMounted } from '@/hooks/use-mounted';
import { useRunStreams, type RunStreams } from '@/hooks/use-run-streams';
import { api, del, messageOf, post, projectFileRawUrl, put } from '@/lib/api';
import { useLive } from '@/lib/live-context';
import { Markdown } from '@/components/markdown';
import { ReportArtifact } from '@/components/report-artifact';
import { TrajectoryReplay } from '@/components/trajectory-replay';
import { PAGE, projectFilesQuery, projectsQuery, rolesQuery, taskQuery, tasksQuery } from '@/lib/queries';
import { dispatchSummary, projectSite } from '@/lib/timeline';
import type { Artifact, DroppedRelease, KnowledgeTaskView, LandableInfo, ProjectFileSummary, Receipt, ReleaseResult, ReportDescriptor, Run, RunSnapshot, TaskAutomation, TaskInput, TaskPage as TaskPageData, TaskReleases, TaskReview, Trace } from '@/lib/types';
import { cn } from '@/lib/utils';

const STATUS_TEXT: Record<string, string> = RECEIPT_STATUS_LABELS;
const WIDE = '(min-width: 1180px)';
// The small gray word over a fact in the side column.
const LABEL = 'mt-4 mb-1 text-xs text-faint first:mt-0';
const H = 'text-sm font-semibold';
// Past this much 现场 (or whenever multiple rounds exist), the page offers to jump to the end or to show only the reports.
const LONG_EVENTS = 15;

// The side column stands open beside the site where there is room for it.
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const media = window.matchMedia(WIDE);
    const update = (): void => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}

// One artifact as it is shown: the artifact, and what shared/pull-request.ts reads of the
// receipt that named it. A receipt names at most one usable pull request; the reading is the
// only thing that decides whether an address is a link, so the page never judges one itself.
interface ShownArtifact {
  artifact: Artifact;
  reading: PullRequestReading;
  runId: string;
  report?: ReportDescriptor;
}

function Artifacts({ items, projectId }: { items: readonly ShownArtifact[]; projectId?: string }) {
  if (!items.length) return <Note>暂无产物</Note>;
  // The same reading can cover both an address and artifacts that are not it; a problem is
  // its reason once, wherever it was named.
  const problems = [...new Set(items.map(({ reading }) => (reading !== null && 'problem' in reading ? reading.problem : null)).filter((each): each is string => each !== null))];
  return (
    <>
      <ul className="grid gap-1 text-sm wrap-anywhere">
        {items.map(({ artifact, reading, runId, report }, index) => {
          const link = artifact.kind === 'pr' && reading !== null && 'url' in reading ? reading.url : null;
          return (
            <li key={index} className="flex items-baseline gap-2">
              <Badge tone="plain">{artifact.kind}</Badge>
              {link ? <a className="min-w-0" href={link} target="_blank" rel="noopener noreferrer">{link}</a>
                : report ? <ReportArtifact key={`${runId}:${report.ref}`} runId={runId} report={report} projectId={projectId} />
                  : <Mono className="min-w-0">{String(artifact.ref ?? '')}</Mono>}
            </li>
          );
        })}
      </ul>
      {problems.map((problem) => <Note key={problem} className="mt-1.5 text-xs">{problem}</Note>)}
    </>
  );
}

// The final response is available independently of a receipt's file artifacts. Both use
// the existing report panel; the service alone knows where either body is kept.
const shownArtifacts = (run: Run): ShownArtifact[] => {
  const reading = pullRequestReading(run.receipt);
  const artifacts = [...(run.receipt?.artifacts ?? [])];
  for (const report of run.report_files ?? []) {
    if (!artifacts.some((artifact) => artifact.kind === 'report' && (typeof artifact.ref === 'string' ? artifact.ref : '') === report.ref)) {
      artifacts.push({ kind: 'report', ref: report.ref });
    }
  }
  return artifacts.map((artifact) => ({
    artifact, reading, runId: run.id,
    report: artifact.kind === 'report' ? run.report_files?.find(({ ref }) => ref === (typeof artifact.ref === 'string' ? artifact.ref : '')) : undefined,
  }));
};

const exitTone = (run: Run): BadgeTone => (run.exit_kind === 'completed' ? 'success' : run.exit_kind === 'failed' || run.exit_kind === 'lost' || run.exit_kind === 'auth' ? 'failed' : run.state !== 'ended' ? 'running' : 'ended');
const exitText = (run: Run): string => EXIT_TEXT[run.exit_kind ?? ''] ?? runStateLabels[run.state] ?? run.state;

// One round: what it was sent out with, then what it did, in the order it did it — folded
// once the round has ended, when its report is what to read — and the files it reports it
// changed. With `reportsOnly` the events are left out and only what the round was told
// and what it reported stays.
function RunSite({ data, run, streams, reportsOnly, sameAsFirst = false }: {
  data: TaskPageData;
  run: Run;
  streams: RunStreams;
  reportsOnly: boolean;
  sameAsFirst?: boolean;
}) {
  const snapshot = streams.snapshot(run.id);
  const summary = dispatchSummary(data.task, run, snapshot);
  const projectId = data.task.project_id ?? data.work.project_id ?? undefined;
  const ended = run.state === 'ended';
  const site = projectSite(streams.events(run.id), ended);
  const steps = site.rows.length + site.diagnostics.length;
  const process = <div className="flex min-w-0 flex-col gap-0.5"><SiteRows site={site} id={run.id} /></div>;
  const history = streams.history(run.id);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-6 flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 className={H}>{`派发说明 · 第 ${data.runs.indexOf(run) + 1} 轮`}</h2>
        <Note className="text-xs"><Time at={run.created_at} suffix={` · ${runStateLabels[run.state]}`} /></Note>
      </div>
      <div className="rounded-xl bg-muted px-4 py-3.5">
        {snapshot ? (
          sameAsFirst ? (
            <>
              <Note className="text-xs">目标与验收标准同第 1 轮</Note>
              <Details id={`brief:${run.id}`} title="查看完整派发说明" className="mt-1" summaryClassName="text-xs"><pre className={cn(PRE, 'bg-background')}>{summary.brief}</pre></Details>
            </>
          ) : (
            <>
              <Markdown text={summary.goal} projectId={projectId} />
              <p className="mt-3 mb-1 text-xs text-faint">验收标准</p>
              <Markdown text={summary.acceptance} projectId={projectId} />
              <Details id={`brief:${run.id}`} title="查看完整派发说明" className="mt-1" summaryClassName="text-xs"><pre className={cn(PRE, 'bg-background')}>{summary.brief}</pre></Details>
            </>
          )
        ) : (
          <>
            {/* About the height of what comes: the page does not move when it arrives. */}
            <div role="status" aria-label="正在读取快照" className="flex flex-col gap-2 py-0.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-3 h-3 w-16" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <Details id={`brief:${run.id}`} title="查看完整派发说明" className="mt-1" summaryClassName="text-xs"><p className="text-sm">快照尚未加载</p></Details>
          </>
        )}
      </div>
      {snapshot?.same_executor ? <Note className="text-xs text-waiting-foreground wrap-anywhere">{snapshot.same_executor.reason}</Note> : null}
      {history ? <Problem>{history}</Problem> : null}
      {reportsOnly
        ? (steps ? <Note>过程已收起（{steps} 条），关掉“只看汇报”就能看到。</Note> : null)
        : ended && steps
          ? <Details id={`process:${run.id}`} title={processTitle(site)}><div className="pt-1 pl-[22px]">{process}</div></Details>
          : process}
      <FileChanges changes={site.changes} id={run.id} />
    </section>
  );
}

function Report({ run, fallback, projectId }: { run: Run; fallback: string | null | undefined; projectId?: string }) {
  const { receipt, error } = run;
  const artifacts = shownArtifacts(run);
  return (
    <section className="overflow-hidden rounded-xl bg-raised shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2">
        <h2 className={H}>汇报</h2>
        <Badge tone={exitTone(run)}>{EXIT_TEXT[run.exit_kind ?? ''] ?? run.exit_kind ?? '已结束'}</Badge>
        <Time at={run.ended_at} className="ml-auto text-xs text-faint" />
      </div>
      <div className="grid gap-2.5 px-3.5 py-3">
        {receipt ? (
          <>
            <p className="text-xs text-muted-foreground">{STATUS_TEXT[receipt.status] ?? receipt.status}</p>
            <Markdown text={receipt.summary} projectId={projectId} />
            {Array.isArray(receipt.ask) ? receipt.ask.map((question, index) => <p key={index} className="text-sm">{`待决定：${question.question}`}</p>) : null}
            {receipt.later ? <p className="text-sm"><Time at={receipt.later.at} prefix="后续预约：" suffix={` · ${receipt.later.about ?? ''}`} /></p> : null}
          </>
        ) : run.exit_kind === 'quota' ? (
          // Nothing failed and nothing is asked: the line says where the Task goes from here.
          <p className="wrap-anywhere">{quotaEndLine(error?.quota)}</p>
        ) : <p className="wrap-anywhere">{error?.reason ?? error?.message ?? fallback ?? '本轮没有可用回执，保留现场供核对。'}</p>}
        {receipt || artifacts.length ? <Artifacts items={artifacts} projectId={projectId} /> : null}
      </div>
    </section>
  );
}

function InputEntry({ input, runs }: { input: TaskInput; runs: readonly Run[] }) {
  const run = runs.find((item) => item.id === input.run_id);
  // A round that was lost, or that the quota ended halfway, may or may not have acted on it.
  const unknown = run?.state === 'unknown' || run?.exit_kind === 'lost' || run?.exit_kind === 'quota';
  const label = input.state === 'void' ? '插话已作废' : input.state === 'queued' ? '等待下一次 Run' : unknown ? '是否执行未确认，不会自动重发' : `已绑定到第 ${runs.findIndex((item) => item.id === input.run_id) + 1} 轮`;
  return (
    <div className="flex flex-col items-end gap-1 self-stretch">
      <div className="max-w-[82%] rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 wrap-anywhere whitespace-pre-wrap">{input.text}</div>
      <Note className="max-w-[90%] text-right text-2xs"><Time at={input.created_at} suffix={` · ${label}`} /></Note>
    </div>
  );
}

// T3-style editable queued input card: lets the owner edit, withdraw, or immediately
// interrupt the running round so this queued instruction takes over on the next auto-continue.
function QueuedInputCard({
  taskId,
  input,
  active,
  control,
}: {
  taskId: string;
  input: TaskInput;
  active: boolean;
  control: TaskAct;
}) {
  const client = useQueryClient();
  const mounted = useMounted();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(input.text);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(input.text);
  }, [input.text, editing]);

  async function saveEdit(): Promise<void> {
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy('save');
    setError(null);
    try {
      await api(`/api/tasks/${encodeURIComponent(taskId)}/inputs/${encodeURIComponent(input.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      await client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey });
      if (mounted()) setEditing(false);
    } catch (caught) {
      if (mounted()) setError(messageOf(caught));
    } finally {
      if (mounted()) setBusy(null);
    }
  }

  async function withdraw(): Promise<void> {
    if (busy) return;
    setBusy('delete');
    setError(null);
    try {
      await del(`/api/tasks/${encodeURIComponent(taskId)}/inputs/${encodeURIComponent(input.id)}`);
      await client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey });
    } catch (caught) {
      if (mounted()) setError(messageOf(caught));
    } finally {
      if (mounted()) setBusy(null);
    }
  }

  return (
    <div className="grid gap-2 rounded-xl border border-dashed border-border-strong bg-background/85 px-3.5 py-2.5 text-sm">
      {editing ? (
        <div className="grid gap-2">
          <Textarea
            rows={2}
            aria-label="编辑排队指令"
            value={draft}
            disabled={busy !== null}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setEditing(false);
                setDraft(input.text);
                setError(null);
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null || !draft.trim()}
              onClick={() => void saveEdit()}
            >
              {busy === 'save' ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      ) : (
        <p className="wrap-anywhere whitespace-pre-wrap text-foreground">{input.text}</p>
      )}
      {error ? <Problem role="alert" className="text-xs">{error}</Problem> : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <Note className="text-2xs"><Time at={input.created_at} suffix=" · 等待下一次 Run" /></Note>
        {!editing ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={() => setEditing(true)}>
              <Pencil className="size-3" aria-hidden="true" />
              编辑
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={() => void withdraw()}>
              <Trash2 className="size-3" aria-hidden="true" />
              {busy === 'delete' ? '撤回中…' : '撤回'}
            </Button>
            {active ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-xs"
                disabled={busy !== null || control.pending}
                onClick={() => void control.act('interrupt')}
              >
                <Zap className="size-3" aria-hidden="true" />
                立刻中断插话
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// What the owner picks for a Task that is not over: its role, and whether its tier is the
// role's default or one named here. Only what was moved is sent, so a change of role keeps
// an override the owner did not touch, and the next round is the first to run on it.
// `followed` is a review's tier from the round it reviews (§11.5): with no override that,
// not the role's default, is what the next round would run on.
function RoleForm({ task, role, followed }: { task: TaskPageData['task']; role: TaskPageData['role']; followed: string | null }) {
  const client = useQueryClient();
  const mounted = useMounted();
  const { data: roles } = useQuery(rolesQuery);
  const [draft, setDraft] = useState<{ role: string; tier: string; reason: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? { role: task.role_id ?? '', tier: task.tier_override ?? '', reason: task.tier_reason ?? '' };
  const roleMoved = shown.role !== (task.role_id ?? '');
  const tierMoved = shown.tier !== (task.tier_override ?? '') || (shown.tier !== '' && shown.reason.trim() !== (task.tier_reason ?? ''));
  const picked = roles?.find((each) => each.id === shown.role) ?? (shown.role === task.role_id ? role ?? undefined : undefined);

  async function save(): Promise<void> {
    if (saving || shown.role === '' || (!roleMoved && !tierMoved)) return;
    setSaving(true);
    setError(null);
    try {
      await put(`/api/tasks/${encodeURIComponent(task.id)}/role`, {
        ...(roleMoved ? { role_id: shown.role } : {}),
        ...(tierMoved ? { tier: shown.tier === '' ? null : shown.tier, ...(shown.tier !== '' && shown.reason.trim() ? { reason: shown.reason.trim() } : {}) } : {}),
      });
      await client.invalidateQueries({ queryKey: taskQuery(task.id).queryKey });
      if (mounted()) setDraft(null);
    } catch (refused) {
      if (mounted()) setError(messageOf(refused));
    } finally {
      if (mounted()) setSaving(false);
    }
  }

  const edit = (patch: Partial<typeof shown>): void => setDraft({ ...shown, ...patch });
  const moved = roleMoved || tierMoved;
  return (
    <section aria-label="职能与档位" className="grid gap-2 pt-1 pb-2">
      <Select aria-label="职能" wrapperClassName="flex" value={shown.role} disabled={saving} onChange={(event) => edit({ role: event.target.value })}>
        {shown.role === '' ? <Option value="">选一个职能</Option> : null}
        {/* A role the list no longer has is still the one this Task names. */}
        {shown.role !== '' && !roles?.some((each) => each.id === shown.role) ? <Option value={shown.role}>{picked?.name ?? shown.role}</Option> : null}
        {(roles ?? []).map((each) => <Option key={each.id} value={each.id}>{each.name}</Option>)}
      </Select>
      <Select aria-label="档位" wrapperClassName="flex" value={shown.tier} disabled={saving} onChange={(event) => edit({ tier: event.target.value })}>
        <Option value="">
          {followed !== null
            ? `跟被审那一轮（${tierLabel(followed)}）`
            : picked ? `跟职能默认（${tierLabel(picked.default_tier)}）` : '跟职能默认'}
        </Option>
        {TIERS.map((tier) => <Option key={tier.id} value={tier.id}>{tier.label}</Option>)}
      </Select>
      {shown.tier === '' ? null : (
        <Input aria-label="理由" placeholder={followed !== null ? '为什么不用被审那一轮的档位（可以不写）' : '为什么不用职能默认的档位（可以不写）'} value={shown.reason} disabled={saving} onChange={(event) => edit({ reason: event.target.value })} />
      )}
      {(
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={moved ? 'primary' : 'secondary'} disabled={saving || shown.role === '' || !moved} onClick={() => void save()}>{saving ? '保存中' : '保存'}</Button>
          {draft ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setDraft(null); setError(null); }}>取消</Button> : null}
        </div>
      )}
      <Note className="text-xs">改了只影响以后的轮次。</Note>
      {error ? <Problem role="alert">{error}</Problem> : null}
    </section>
  );
}

// A word to the Worker: for done/ready/held tasks it sends a follow-up instruction via
// /continue (resuming the original session when available); for active/queued/waiting tasks
// it queues an input via /inputs. While it is being sent the box cannot be changed;
// refused, it keeps what was typed.
function TaskComposer({
  taskId,
  projectId = null,
  active,
  state,
  hasSession = false,
  currentLogin = null,
  currentMachine = null,
  dimmed = false,
  control,
  className,
}: {
  taskId: string;
  projectId?: string | null;
  active: boolean;
  state: string;
  hasSession?: boolean;
  currentLogin?: string | null;
  currentMachine?: string | null;
  dimmed?: boolean;
  control: TaskAct;
  className?: string;
}) {
  const client = useQueryClient();
  const live = useLive();
  const mounted = useMounted();
  const [draft, setDraft] = useState(() => live.getTaskDraft(taskId));
  const [snippets, setSnippets] = useState<PastedSnippet[]>([]);
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const isContinue = state === 'done' || state === 'ready' || state === 'held' || state === 'draft';

  useEffect(() => {
    setDraft(live.getTaskDraft(taskId));
    setSnippets([]);
  }, [live, taskId]);

  function updateDraft(next: string): void {
    setDraft(next);
    live.setTaskDraft(taskId, next);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    if (new Blob([text]).size <= LARGE_PASTE_THRESHOLD) return;
    event.preventDefault();
    setSnippets((prev) => [...prev, createPastedSnippet(text)]);
  }

  async function submit(): Promise<void> {
    const payload = formatTextWithSnippets(draft, snippets);
    if (!payload.trim() || lock.current) return;
    lock.current = true;
    setSending(true);
    try {
      if (isContinue) {
        await post(`/api/tasks/${encodeURIComponent(taskId)}/continue`, { note: payload.trim() });
        await Promise.all([
          client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey }),
          client.invalidateQueries({ queryKey: tasksQuery.queryKey }),
          client.invalidateQueries({ queryKey: [PAGE] }),
        ]);
      } else {
        await post(`/api/tasks/${encodeURIComponent(taskId)}/inputs`, { text: payload });
        await client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey });
      }
      live.clearTaskDraft(taskId);
      if (mounted()) {
        setDraft('');
        setSnippets([]);
      }
    } catch (error) {
      if (mounted()) live.showError(messageOf(error));
    } finally {
      lock.current = false;
      if (mounted()) setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter that confirms an IME candidate is not a send.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  }

  const placeholder = isContinue
    ? (hasSession ? '发送后续指令，续接原会话继续执行' : '发送后续指令，继续执行这个任务')
    : state === 'running' || state === 'queued'
      ? '追加后续指令（本轮结束后自动续接原会话执行）'
      : '插话，下次执行时送达';

  const recipientLabel = isContinue ? '发给本线程 · 续跑' : '发给本线程 · 排入下一轮';

  return (
    <form
      className={cn(
        className ?? 'sticky bottom-0 z-10 -mx-1 flex flex-col gap-1.5 bg-background px-1 pt-2 pb-[max(14px,env(safe-area-inset-bottom))]',
        dimmed && 'opacity-75 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100',
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {active && control.error ? <Problem role="alert">{control.error}</Problem> : null}
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-input bg-background shadow-sm transition-[border-color] duration-100 focus-within:border-ring focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring/35">
          <PastedSnippetChips
            snippets={snippets}
            disabled={sending}
            onRemove={(id) => setSnippets((prev) => prev.filter((item) => item.id !== id))}
          />
          <div className="flex items-end gap-2 py-1.5 pr-1.5 pl-3.5">
            <Textarea
              rows={1}
              className="max-h-[40vh] min-h-8 flex-1 overflow-y-auto border-0 bg-transparent px-0 py-1.5 shadow-none focus:outline-0 read-only:bg-transparent"
              placeholder={placeholder}
              aria-label={isContinue ? '继续发送指令' : '插话'}
              value={draft}
              readOnly={sending}
              onChange={(event) => { if (!lock.current) updateDraft(event.target.value); }}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
            />
            <Button
              variant="primary"
              type="submit"
              disabled={sending}
              aria-label={isContinue ? (sending ? '发送中' : '继续发送指令') : undefined}
              className="rounded-lg"
            >
              <CornerDownLeft />
              {sending ? '发送中' : isContinue ? '继续' : '插话'}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 px-3 py-1 text-2xs text-faint">
            <span>{recipientLabel}</span>
            <ComposerTargetChip
              mode="task"
              projectId={projectId}
              currentLogin={currentLogin}
              currentMachine={currentMachine}
              compact
            />
          </div>
        </div>
        {active ? <Button disabled={control.pending} className="mb-1.5" onClick={() => void control.act('interrupt')}><Square className="size-3 fill-current" />中断</Button> : null}
      </div>
    </form>
  );
}

// What became of the last attempt, in the terms the record supports: an attempt that did
// not succeed can leave either version in place, and `in_use` is what says which one. A
// `current` that cannot be read is not the same as one that did not change, and a version
// that went in without a health check is not one that works — it is waiting for the next
// start, and says so.
function outcomeLine(last: ReleaseResult, running: string): string {
  const from = last.from ?? running;
  if (last.ok && !last.rolled_back) return `已升到 tycho ${last.to}`;
  if (last.rolled_back) return `从 tycho ${last.to} 退回了 tycho ${from}`;
  if (last.in_use === null) return `读不出 current，不确定现在在跑的是 tycho ${from} 还是 tycho ${last.to}`;
  if (last.in_use === last.from) return `没有换成 tycho ${last.to}，还在 tycho ${from}（这次没有切换）`;
  if (last.in_use === last.to) {
    if (!last.verified && last.pending?.length) return incompleteReleaseLine(last.to, last.pending);
    return last.verified
      ? `装上了 tycho ${last.to}，但没通过检查、也没有退回`
      : `装上了 tycho ${last.to}，但这一版还没有验证：下次启动才生效`;
  }
  return `现在在跑的是 tycho ${last.in_use}，不是这次要升的 tycho ${last.to}，也不是原来的 tycho ${from}`;
}

// When the card has anything to say: a package to put in place, what the last attempt
// ended as, a request with no answer yet, or artifacts that did not come back.
function hasRelease({ packages, last, intent, attempting, fetch: fetched }: TaskReleases): boolean {
  return packages.length > 0 || last !== null || intent !== null || attempting || (fetched !== null && fetched.failed !== null);
}

// Rounds whose registered copies the retention rule cleared (service/retention.ts): said as
// cleaned, with nothing to press — their packages are gone from what the service offers, so
// the release card does not come up for them.
function DroppedCopies({ dropped }: { dropped: DroppedRelease[] }) {
  return (
    <section className="grid gap-1 rounded-xl bg-raised px-3.5 py-2.5 text-sm shadow-card" aria-label="已清理的产物">
      {dropped.map((each) => <Note key={each.run_id}>{artifactsDroppedText(each)}</Note>)}
    </section>
  );
}

// Whether the latest ended Run's receipt names non-pr/non-report file artifacts
// (e.g. images, HTML, SVG, PDFs) that can be pulled from the execution machine.
function hasReceiptDeliverableHint(runs: readonly Run[]): boolean {
  const latest = runs.at(-1);
  if (latest?.state !== 'ended' || !latest.receipt?.artifacts?.length) return false;
  return latest.receipt.artifacts.some(
    (artifact) => artifact.kind !== 'pr' && artifact.kind !== 'report' && artifact.kind !== 'commit' && artifact.kind !== 'branch',
  );
}

// Visual & document deliverables pulled from Worker artifacts/ into project files,
// available immediately for inspection before the owner clicks Accept.
function DeliverablesSection({
  taskId,
  projectId,
  deliverables,
  autoSync = false,
}: {
  taskId: string;
  projectId: string;
  deliverables: readonly ProjectFileSummary[];
  autoSync?: boolean;
}) {
  const client = useQueryClient();
  const live = useLive();
  const mounted = useMounted();
  const [syncing, setSyncing] = useState(false);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lightboxFile, setLightboxFile] = useState<ProjectFileSummary | null>(null);
  const autoSyncedTaskRef = useRef<string | null>(null);
  const syncingRef = useRef(false);

  const images = deliverables.filter((file) => file.is_image && !file.previewable);
  const previews = deliverables.filter((file) => file.previewable);
  const others = deliverables.filter((file) => !file.is_image && !file.previewable);

  async function sync(automatic = false): Promise<void> {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    if (automatic) setAutoSyncing(true);
    setProblem(null);
    try {
      const result = await post<{ files: ProjectFileSummary[]; problem: string | null }>(
        `/api/tasks/${encodeURIComponent(taskId)}/deliverables`,
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey }),
        client.invalidateQueries({ queryKey: projectFilesQuery(projectId).queryKey }),
      ]);
      if (mounted()) setProblem(result.problem);
    } catch (error) {
      if (mounted()) {
        if (automatic) setProblem(messageOf(error));
        else live.showError(messageOf(error));
      }
    } finally {
      syncingRef.current = false;
      if (mounted()) {
        setSyncing(false);
        setAutoSyncing(false);
      }
    }
  }

  useEffect(() => {
    if (!autoSync || deliverables.length > 0) return;
    if (autoSyncedTaskRef.current === taskId) return;
    autoSyncedTaskRef.current = taskId;
    void sync(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSync, deliverables.length, taskId]);

  return (
    <section
      aria-label="交付产物预览"
      className="overflow-hidden rounded-xl bg-raised shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2">
        <ImageIcon className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
        <h2 className={H}>交付产物预览</h2>
        <Badge tone="plain">{deliverables.length}</Badge>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={syncing}
          onClick={() => void sync(false)}
        >
          <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} aria-hidden="true" />
          {syncing ? '同步中…' : '从执行机器同步产物'}
        </Button>
      </div>
      <div className="grid gap-4 px-3.5 py-3">
        {problem ? <Problem>{problem}</Problem> : null}
        {deliverables.length === 0 ? (
          <Note>
            {autoSyncing
              ? '正在自动同步产物…'
              : '尚未从执行机器同步到可预览产物，可点击右上角“从执行机器同步产物”拉取。'}
          </Note>
        ) : null}
        {images.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 wide:grid-cols-3">
            {images.map((file) => {
              const rawUrl = projectFileRawUrl(projectId, file.id);
              const downloadUrl = projectFileRawUrl(projectId, file.id, true);
              return (
                <div
                  key={file.id}
                  className="flex flex-col overflow-hidden rounded-lg border border-border bg-background"
                >
                  <button
                    type="button"
                    aria-label={`放大预览：${file.name}`}
                    onClick={() => setLightboxFile(file)}
                    className="block aspect-4/3 w-full cursor-zoom-in overflow-hidden bg-muted/60 p-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <img
                      src={rawUrl}
                      alt={file.name}
                      className="size-full object-contain"
                      loading="lazy"
                    />
                  </button>
                  <div className="flex items-center justify-between gap-2 border-t border-border/70 px-2.5 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground" title={file.name}>
                        {file.name}
                      </p>
                      <p className="text-faint">{formatFileSize(file.size)}</p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 min-h-0 flex-none px-2 text-xs" asChild>
                      <a href={downloadUrl} download aria-label={`下载 ${file.name}`}>
                        <Download className="size-3.5" aria-hidden="true" />
                        下载
                      </a>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {previews.length > 0 ? (
          <div className="grid gap-3">
            {previews.map((file) => (
              <ArtifactFrame
                key={file.id}
                projectId={projectId}
                fileId={file.id}
                title={file.name}
                mime={file.mime}
                mode="inline"
              />
            ))}
          </div>
        ) : null}
        {others.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
            {others.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
                  <span className="truncate font-medium" title={file.name}>{file.name}</span>
                  <span className="flex-none text-xs text-faint">{formatFileSize(file.size)}</span>
                </div>
                <Button variant="ghost" size="sm" className="flex-none" asChild>
                  <a href={projectFileRawUrl(projectId, file.id, true)} download>
                    <Download className="size-3.5" aria-hidden="true" />
                    下载
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {lightboxFile ? (
        <ImageLightbox
          src={projectFileRawUrl(projectId, lightboxFile.id)}
          alt={lightboxFile.name}
          open
          onOpenChange={(open) => { if (!open) setLightboxFile(null); }}
        />
      ) : null}
    </section>
  );
}

// A thing that can be done with what the Task produced: its name and where things stand on
// one line, then what there is to say and to press.
function ActionCard({ label, icon, title, aside, children }: { label: string; icon: ReactNode; title: string; aside: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl bg-raised shadow-card" aria-label={label}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3.5 py-2">
        <span className="flex-none text-muted-foreground [&_svg]:size-4" aria-hidden="true">{icon}</span>
        <h2 className={H}>{title}</h2>
        <Note className="ml-auto text-xs">{aside}</Note>
      </div>
      <div className="grid gap-2.5 px-3.5 py-3 text-sm">{children}</div>
    </section>
  );
}

// Putting a release this Task produced in place: the one action here that ends this
// service, so it asks once more and says which version and which digest it is about to
// hand over. What came of it shows from the service's own record once the page has
// reconnected — told apart by the version that record says is running now.
function ReleaseCard({ taskId, releases }: { taskId: string; releases: TaskReleases }) {
  const client = useQueryClient();
  const live = useLive();
  const mounted = useMounted();
  const [confirming, setConfirming] = useState(false);
  // A click is only a request; the service's record is what says a release is under way.
  // This covers the moment before the page has read that record again.
  const [asked, setAsked] = useState(false);
  const [fetching, setFetching] = useState(false);
  const lock = useRef(false);
  const latest = releases.packages[0];
  const intent = releases.intent;
  const fetched = releases.fetch;
  const busy = releases.attempting || asked;
  // Asked for with no command at work any more: the request never finished, and no result
  // answers it. The service is what says so, so the local click cannot hide it.
  const stalled = busy ? null : intent;
  const next = intent?.version ?? latest?.version ?? null;
  const answeredAt = intent?.at ?? releases.last?.at ?? null;

  // The service went away and came back, or its own record changed: that record is the
  // answer to the click, and the card is its own to offer again.
  useEffect(() => {
    setAsked(false);
    setConfirming(false);
  }, [answeredAt]);

  async function launch(): Promise<void> {
    if (!latest || lock.current) return;
    lock.current = true;
    try {
      // The name, digest and size the owner confirmed: the service checks them against
      // the package it received, so this click can put nothing else in place.
      await post(`/api/releases/${encodeURIComponent(latest.run_id)}/launch?confirm=1`, { name: latest.file, sha256: latest.sha256, bytes: latest.bytes });
      if (mounted()) setAsked(true);
      await client.invalidateQueries({ queryKey: [PAGE] });
    } catch (error) {
      if (mounted()) live.showError(messageOf(error));
    } finally {
      lock.current = false;
    }
  }

  // Asking the machine again for what this Task's last Run left: the way out of artifacts
  // that did not come back the one time the acceptance tried.
  async function refetch(): Promise<void> {
    if (fetching) return;
    setFetching(true);
    try {
      await post(`/api/tasks/${encodeURIComponent(taskId)}/artifacts`);
      await client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey });
    } catch (error) {
      if (mounted()) live.showError(messageOf(error));
    } finally {
      if (mounted()) setFetching(false);
    }
  }

  const last = releases.last;
  return (
    <ActionCard label="上线" icon={<Rocket />} title="上线" aside={`现在在跑的是 tycho ${releases.version}`}>
      {busy ? (
        <Note>{next === null
          ? '正在上线一个新版本的 tycho：服务会按这个版本的流程停、换、再起来，这一页会自己连回来'
          : `正在上线 tycho ${next}：服务会按这个版本的流程停、换、再起来，这一页会自己连回来`}</Note>
      ) : null}
      {stalled !== null ? (
        <Note>{`上一次要求上线 tycho ${stalled.version} 没有下文（升级命令已经不在了），上线的记录里没有它的结果。`}</Note>
      ) : null}
      {fetched !== null && fetched.failed !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Problem className="min-w-0 flex-1">{fetched.registered === null
            ? `这一轮的产物没取回来：${fetched.failed.problem}`
            : `最近一次重新取产物没成功：${fetched.failed.problem}。现在用的还是之前取回的那一份。`}</Problem>
          <Button size="sm" disabled={fetching} onClick={() => void refetch()}>重新取产物</Button>
        </div>
      ) : null}
      {fetching ? <Note>正在重新取这一轮的产物…</Note> : null}
      {latest ? (
        confirming && !busy ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-muted-foreground">{`要上线 tycho ${latest.version} 吗？（sha256 ${latest.sha256.slice(0, 12)}…）服务会先让负责人把手头这一回合做完再停；起不来会自己退回上一版。`}</span>
            <Button variant="primary" onClick={() => void launch()}>确认上线</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>先不上</Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Note className="min-w-0 flex-1 text-foreground">{`这一轮带回了 tycho ${latest.version} 的发布包（${latest.file}）`}</Note>
            <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)}>{busy ? '已经在做' : stalled !== null ? '再上线一次' : '上线'}</Button>
          </div>
        )
      ) : null}
      {last ? (
        <div>
          <Note><Time at={last.at} suffix={` · ${outcomeLine(last, releases.version)}`} /></Note>
          {last.lines.length ? <Details id={`release:${last.at}`} title="这次上线的记录" summaryClassName="text-xs"><pre className={PRE}>{last.lines.join('\n')}</pre></Details> : null}
        </div>
      ) : null}
    </ActionCard>
  );
}

// Merging a delivered PR/branch into main without hunting for a command.
function LandCard({ taskId, landable }: { taskId: string; landable: LandableInfo }) {
  const client = useQueryClient();
  const mounted = useMounted();
  const [integrating, setIntegrating] = useState(false);
  const [startedTaskId, setStartedTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeLandingId = landable.active_landing_task_id ?? startedTaskId;
  const shouldShow = landable.landable || Boolean(activeLandingId) || landable.already_integrated;
  if (!shouldShow) return null;

  async function integrate(): Promise<void> {
    if (integrating) return;
    setIntegrating(true);
    setError(null);
    try {
      const result = await post<Record<string, unknown> | undefined>(`/api/tasks/${encodeURIComponent(taskId)}/integrate`, {});
      const createdId = typeof result?.task_id === 'string'
        ? result.task_id
        : typeof result?.landing_task_id === 'string'
          ? result.landing_task_id
          : null;
      if (mounted() && createdId) setStartedTaskId(createdId);
      await Promise.all([
        client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey }),
        client.invalidateQueries({ queryKey: tasksQuery.queryKey }),
        client.invalidateQueries({ queryKey: [PAGE] }),
      ]);
    } catch (caught) {
      if (mounted()) setError(messageOf(caught));
    } finally {
      if (mounted()) setIntegrating(false);
    }
  }

  const aside = landable.commit
    ? landable.commit.slice(0, 12)
    : landable.already_integrated
      ? '已合入'
      : activeLandingId
        ? '合入中'
        : '可合入';

  return (
    <ActionCard
      label="并入主线"
      icon={<GitMerge />}
      title="并入主线"
      aside={aside}
    >
      {landable.pr ? (
        <p className="wrap-anywhere">
          <a href={landable.pr} target="_blank" rel="noopener noreferrer">{landable.pr}</a>
        </p>
      ) : null}
      {landable.reason ? <Note className="text-xs">{landable.reason}</Note> : null}
      {landable.already_integrated ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot state="done" className="size-3.5" />
          <span className="font-medium text-success-foreground">已并入主线 ✓</span>
          {landable.commit ? <Mono className="text-xs text-muted-foreground">{landable.commit.slice(0, 12)}</Mono> : null}
        </div>
      ) : activeLandingId ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot state={landable.active_landing_task_state ?? 'running'} className="size-3.5" />
          <span className="text-muted-foreground">正在并入主线</span>
          {landable.active_landing_task_state ? (
            <StateBadge state={landable.active_landing_task_state} className="text-2xs" />
          ) : null}
          {landable.active_landing_task_title ? (
            <span className="truncate text-xs text-faint">{landable.active_landing_task_title}</span>
          ) : null}
          <Link to={`/task/${encodeURIComponent(activeLandingId)}`}>查看并入任务</Link>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={integrating} onClick={() => void integrate()}>
            {integrating ? '发起中…' : '并入主线'}
          </Button>
        </div>
      )}
      {error ? <Problem role="alert">{error}</Problem> : null}
    </ActionCard>
  );
}

// Live background automation status (Router quota rest or active handoff).
function AutomationNotice({ task, automation }: { task: TaskPageData['task']; automation?: TaskAutomation | null }) {
  if (!automation) return null;
  const resting = automation.resting_until && Date.parse(automation.resting_until) > Date.now()
    ? automation.resting_until
    : null;
  const processingNext = automation.router_busy
    && task.state === 'ready'
    && !task.active_review
    && !automation.active_review_id;
  if (!resting && !processingNext) return null;
  return (
    <div role="status" className="grid gap-1 rounded-lg border border-border bg-muted/60 px-3.5 py-2.5 text-xs text-muted-foreground">
      {resting ? (
        <p className="flex items-center gap-1.5">
          <StatusDot state="waiting_timer" className="size-3.5" />
          <span><Time at={resting} prefix="负责人额度歇息中，约 " suffix=" 恢复后会自动继续处理" /></span>
        </p>
      ) : null}
      {processingNext ? (
        <p className="flex items-center gap-1.5">
          <StatusDot state="running" className="size-3.5" />
          <span>负责人正在自动处理下一步…</span>
        </p>
      ) : null}
    </div>
  );
}

// What a round ran as: its own snapshot when it has been read, the Task as it stands
// otherwise. A snapshot is taken whole, so one round's tier never sits beside the Task's
// current source; a snapshot without a role is a round from before roles. `from` is the tier
// whose content a substitute round ran on (roles-and-tiers.md §10.3): an operate round on a
// login with no operate content.
function ranAs(data: TaskPageData, snapshot: RunSnapshot | undefined): { role: string; tier: string | null; source: TierSource | null; reason: string | null; from: string | null } {
  const { task } = data;
  if (snapshot?.tier !== undefined) {
    const source = snapshot.tier_source ?? null;
    const reason = source === 'override' || source === 'escalated' ? snapshot.tier_reason ?? null : null;
    return { role: snapshot.role?.name ?? OLD_NO_ROLE_TEXT, tier: snapshot.tier, source, reason, from: snapshot.tier_from ?? null };
  }
  const source = task.tier_source ?? null;
  return {
    role: task.role_id ? data.role?.name ?? task.role_id : OLD_NO_ROLE_TEXT,
    tier: task.tier ?? null,
    source,
    reason: source === 'override' || source === 'escalated' ? task.tier_reason ?? null : null,
    from: null,
  };
}

const verdictLine = (verdict: VerdictRecord): string =>
  `${VERDICT_LABELS[verdict.result]}${verdict.same_executor ? `（${SAME_EXECUTOR_LABEL}：${verdict.same_executor} 审的）` : ''} · ${verdict.summary}`;

function VerdictFacts({ verdict }: { verdict: VerdictRecord }) {
  return (
    <>
      <p className="mt-1.5 wrap-anywhere">{`结论：${verdictLine(verdict)}`}</p>
      {(verdict.violations ?? []).map((each, index) => (
        <Note key={index} className="mt-1 text-xs">{`违反的要求：${each.requirement}；证据：${each.evidence}；要改的范围：${each.scope}`}</Note>
      ))}
      {verdict.missing ? <Note className="mt-1 text-xs">{`缺的：${verdict.missing}`}</Note> : null}
      {verdict.current ? null : <Note className="mt-1 text-xs">这份结论出来时，被审任务的产物已经变了（或已经被退回过），只留作记录，不算数。</Note>}
    </>
  );
}

// The commit a review is bound to when the reviewed round had a code source (shared/sources.ts
// ReviewedCommit): the commit itself, and where it lives — a repository and the branch it was
// pushed to, or the folder on the machine it was read from. A binding from before code sources
// has no reviewed commit, and the page shows the binding without one.
function reviewedText(reviewed: ReviewedCommit): string {
  if (reviewed.source_kind === 'folder') return '审的是机器上那个文件夹里的提交';
  const where = reviewed.url ? `仓库 ${reviewed.url}` : '仓库';
  return reviewed.branch ? `审的是${where} ${reviewed.branch} 分支上的提交` : `审的是${where}上的提交`;
}

// What a review is bound to and what it concluded; for a reviewed Task, its reviews and the
// times a rejection moved it up a tier (docs/design/roles-and-tiers.md §4, §6).
function ReviewFacts({ review }: { review: TaskReview }) {
  const { of, verdict, reviews, escalations } = review;
  if (of === null && reviews.length === 0 && escalations.length === 0) return null;
  return (
    <section aria-label="审阅">
      {of ? (
        <>
          <p className={LABEL}>审阅对象</p>
          <p className="wrap-anywhere">
            <Link to={`/task/${encodeURIComponent(of.task_id)}`}>{of.reviewed_title}</Link>
            {` 修订 ${of.revision} 的那一轮产物`}
          </p>
          {of.reviewed ? (
            <div className="mt-1">
              <Note className="text-xs">{reviewedText(of.reviewed)}</Note>
              <p><Copyable value={of.reviewed.commit} /></p>
            </div>
          ) : null}
          {of.files.map((file) => <Note key={file.name} className="mt-1 text-xs">{`${file.name} · ${file.bytes} 字节 · sha256 ${file.sha256.slice(0, 12)}…`}</Note>)}
          <Note className="mt-1.5 text-xs">{`写过它的执行器：${listText(of.writers)}。有别的执行器能审时，写过的不能来审`}</Note>
          {verdict ? <VerdictFacts verdict={verdict} /> : <Note className="mt-1.5">还没有结论。</Note>}
        </>
      ) : null}
      {reviews.length ? (
        <>
          <p className={LABEL}>审阅</p>
          {reviews.map((each) => (
            <p key={each.id} className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 wrap-anywhere first-of-type:mt-0">
              <Link to={`/task/${encodeURIComponent(each.id)}`}>{each.title}</Link>
              {each.verdict ? (
                <span className="text-muted-foreground">{`　${verdictLine(each.verdict)}${each.verdict.current ? '' : '（已不算数）'}`}</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <StatusDot state={each.state} className="size-3.5" />
                  <span>{`${taskStateLabels[each.state] ?? each.state}${each.reason ? `：${each.reason}` : ''}`}</span>
                </span>
              )}
            </p>
          ))}
        </>
      ) : null}
      {escalations.map((each) => (
        <Note key={`${each.at}:${each.review_task_id}`} className="mt-1.5 text-xs">
          <Time at={each.at} suffix={` · 审阅打回，从${tierLabel(each.from)}升到${tierLabel(each.to)}`} />
        </Note>
      ))}
    </section>
  );
}

// A gate or curation Task belongs to no project (knowledge §3): what it works on, where it came
// from, and the projects whose content its material carries, which decide where it may run.
function KnowledgeFacts({ knowledge }: { knowledge: KnowledgeTaskView }) {
  const { data: projects } = useQuery(projectsQuery);
  const name = (id: string): string => projects?.find((each) => each.id === id)?.name ?? id;
  return (
    <>
      <p className={LABEL}>知识任务</p>
      <p className="wrap-anywhere">
        {knowledge.kind === 'gate' && knowledge.proposal_id
          ? <Link to={`/knowledge/proposals/${encodeURIComponent(knowledge.proposal_id)}`}>把关一份知识提议</Link>
          : `整理 ${knowledge.entries?.length ?? 0} 条知识`}
      </p>
      <p className="mt-1 text-muted-foreground wrap-anywhere">{knowledgeTaskPlaceText(knowledge.source_project_id === null ? null : name(knowledge.source_project_id), knowledge.projects.map(name))}</p>
    </>
  );
}

// The skills the Task names (knowledge §4.1): its rounds are given them in full. One retired
// since stops its next round, so it is said here.
function NamedSkills({ skills }: { skills: NonNullable<TaskPageData['skills']> }) {
  return (
    <>
      <p className={LABEL}>点名的技能</p>
      <ul className="grid gap-1">
        {skills.map((skill) => (
          <li key={skill.id} className="wrap-anywhere">
            <Link to={isDirectorySkillId(skill.id) ? `/knowledge?view=entries&select=${encodeURIComponent(skill.id)}` : `/knowledge/entries/${encodeURIComponent(skill.id)}`}>{skill.title ?? skill.id}</Link>
            {skill.state === 'retired' ? <span className="text-waiting-foreground">（已退役：下一轮不会开，要改掉这个点名）</span> : null}
            {skill.state === null ? <span className="text-waiting-foreground">（这个技能不在了）</span> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

// How one round's own snapshot names where it got its code (shared/sources.ts SnapshotSource):
// a repository its machine cloned, on the branch it worked on when the host knew it, or the
// folder on that machine. The machine a folder round ran on is the round's own, shown beside
// its login.
function roundSourceText(source: SnapshotSource, run: Run | undefined): string {
  if (source.kind === 'repo') return source.branch ? `仓库 ${source.url}（分支 ${source.branch}）` : `仓库 ${source.url}`;
  const machine = run?.machine_id ?? run?.host;
  return machine ? `${machine} 上的 ${source.path}` : `机器上的文件夹 ${source.path}`;
}

// Where this Task's code comes from (docs/design/code-sources.md §1, §4): the source it is
// pinned to, as the service reads it (shared/sources.ts TaskSourceView; `label` is its
// source_label), and — when the project's list has changed or lost the item since — what stands
// there now or why the pin stops the work. The label is the service's: the page does not work a
// source out again from the list it happens to have read.
function SourceFacts({ source, state, label, now }: { source: TaskSource; state: TaskSourceState; label: string | null; now: SourceView[] }) {
  const here = now.find((item) => item.id === source.source_id);
  return (
    <section aria-label="这件活选定的来源">
      <p className={LABEL}>这件活选定的来源</p>
      <p className="wrap-anywhere">{label}</p>
      {state === 'current' ? null : state === 'changed' ? (
        <Note className="mt-1 text-xs">{`这一项在项目里改过了：现在是${here ? ` ${here.label}` : '别的样子'}，下一轮仍使用这件活选定时的来源；要使用现在的配置，需要改派这件活。`}</Note>
      ) : (
        <Note className="mt-1 text-xs text-waiting-foreground">来源已删除：这件活在改到别的来源之前不会开工。</Note>
      )}
    </section>
  );
}

// Where the round shown got its code, as that round's own snapshot recorded it — never the
// source the Task is pinned to now, which a later update_task may have moved (code-sources §1).
// A snapshot without a source is a round whose project names none: it worked in an empty task
// directory. A round from before code sources kept `repo` instead and is said as such.
function RoundSourceFacts({ run, snapshot }: { run: Run | undefined; snapshot: RunSnapshot | undefined }) {
  if (!snapshot) return null;
  const { source } = snapshot;
  return (
    <section aria-label="这一轮用的来源">
      <p className={LABEL}>这一轮用的来源</p>
      {source !== undefined ? (
        <p className="wrap-anywhere">{roundSourceText(source, run)}</p>
      ) : snapshot.repo !== undefined ? (
        <Note className="text-xs">这一轮的快照里没有记来源，只有代码包：它是代码来源之前的一轮。</Note>
      ) : (
        <p className="wrap-anywhere">这一轮在空的任务目录里干活。</p>
      )}
    </section>
  );
}

function TaskDetails({ data, run, wide, embedded = false, selected, snapshot, sources, editable, onSelect }: {
  data: TaskPageData;
  run: Run | undefined;
  wide: boolean;
  embedded?: boolean;
  selected: string | null;
  snapshot: RunSnapshot | undefined;
  sources: SourceView[];
  editable: boolean;
  onSelect: (runId: string | null) => void;
}) {
  const { task, work, runs } = data;
  const shown = ranAs(data, snapshot);
  const artifacts = runs.flatMap(shownArtifacts);
  const active = runs.some((item) => item.state !== 'ended');
  const sameSource = Boolean(
    task.source
    && (task.source_state ?? 'current') === 'current'
    && run
    && snapshot?.source !== undefined
    && task.source_label === roundSourceText(snapshot.source, run),
  );
  return (
    // Beside the site it has no heading to fold under; on a narrow page or embedded thread pane it opens on request.
    <Details
      id={embedded ? `task-pane-details:${task.id}` : `task-details:${task.id}`}
      title={embedded ? '任务详情与配置' : '任务详情'}
      {...(!embedded && wide ? { open: true } : {})}
      className="text-sm"
      summaryClassName={embedded ? undefined : 'wide:hidden'}
    >
      <div className={embedded ? 'pt-2 pb-2' : 'pt-1 pb-3 wide:pt-0'}>
        {task.id === work.id ? null : (
          <>
            <p className={LABEL}>所属工作</p>
            <Link to={`/work/${encodeURIComponent(work.id)}`} className="wrap-anywhere">{work.title}</Link>
          </>
        )}
        {data.knowledge ? <KnowledgeFacts knowledge={data.knowledge} /> : null}
        {data.skills?.length ? <NamedSkills skills={data.skills} /> : null}

        {/* (1) 审阅状态 */}
        {data.review ? <ReviewFacts review={data.review} /> : null}

        {/* (2) 产物 */}
        <section className="mt-5 border-t border-border pt-4 first:mt-0 first:border-t-0 first:pt-0">
          <h2 className={cn(H, 'mb-2')}>产物</h2>
          <Artifacts items={artifacts} projectId={task.project_id ?? work.project_id ?? undefined} />
        </section>

        {/* (3) 执行记录 */}
        <section className="mt-5 border-t border-border pt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className={H}>执行记录</h2>
            <Button size="sm" variant="ghost" aria-pressed={selected === null} onClick={() => onSelect(null)}>全部现场</Button>
          </div>
          <div className="flex flex-col gap-1">
            {runs.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-current={item.id === selected ? 'true' : 'false'}
                className="flex flex-col gap-0.5 rounded-md border border-transparent px-2.5 py-1.5 text-left text-xs transition-colors duration-100 hover:bg-muted aria-[current=true]:border-border-strong aria-[current=true]:bg-muted"
                onClick={() => onSelect(item.id)}
              >
                {/* Where each round ran: a Task that names no target may move between rounds. */}
                <span className="text-sm">{`第 ${index + 1} 轮 · ${EXIT_TEXT[item.exit_kind ?? ''] ?? runStateLabels[item.state]} · ${item.login_name ? loginName(item.login_name) : '未知登录'}`}</span>
                <small className="text-xs text-faint"><Time at={item.started_at ?? item.created_at} prefix="开始 " /></small>
                {item.placed_by ? <small className="text-xs text-faint">{`挑法：${placedByLabels[item.placed_by] ?? item.placed_by}`}</small> : null}
                <small className="text-xs text-faint"><Time at={item.ended_at} prefix="结束 " /></small>
              </button>
            ))}
            {runs.length ? null : <Note className="text-xs">还没有执行过。</Note>}
          </div>
          {/* The drawer's trigger: when the drawer shuts, the focus comes back here. */}
          {run ? (
            <div className="flex flex-wrap items-center gap-2">
              <SheetTrigger asChild><Button size="sm" className="mt-2">为什么开始这一轮</Button></SheetTrigger>
              <RunDiagnosticsButton runId={run.id} round={runs.findIndex((item) => item.id === run.id) + 1} />
            </div>
          ) : null}
        </section>

        {/* (4) 紧凑配置摘要 */}
        <section className="mt-5 border-t border-border pt-4">
          <p className={LABEL}>职能</p>
          <p className="wrap-anywhere">{shown.role}</p>
          <p className={LABEL}>登录与档位</p>
          {/* The tier is named the way every page names it; a Run's own snapshot decides which
              one that round ran on (docs/design/roles-and-tiers.md §2). */}
          <p className="wrap-anywhere">{loginLine([
            (run?.login_name ?? task.login_name) ? loginName((run?.login_name ?? task.login_name)!) : ANY_LOGIN_TEXT,
            run?.machine_id ?? run?.host ?? task.machine_id,
            shown.tier ? `${tierLabel(shown.tier)}${shown.from ? `（${tierSubstituteText(shown.from)}）` : shown.source ? `（${TIER_SOURCE_TEXT[shown.source]}）` : ''}` : null,
          ])}</p>
          {shown.reason ? <Note className="mt-1 text-xs">{`理由：${shown.reason}`}</Note> : null}
          {/* The Router's preference for this Task, if it wrote one (roles-and-tiers.md §11):
              names, in its order, and why. A fallback to the tier's order, never a pin. */}
          {task.prefer ? (
            <>
              <p className={LABEL}>优先名单</p>
              <p className="wrap-anywhere">{task.prefer.login_ids.join('、') || '（空的，按派发顺序）'}</p>
              <Note className="mt-1 text-xs">{`理由：${task.prefer.reason}`}</Note>
            </>
          ) : null}
          {/* How the round shown actually ran, as its snapshot recorded it: read-only and to which
              layer, or writable. Nothing is said for a Task that has not run yet. */}
          {/* A read-only round's code check, as its settlement judged it (roles-and-tiers.md §5). */}
          {snapshot ? <p className="mt-1.5 wrap-anywhere">{`权限：${accessText(snapshot.access)}${run?.error?.code_check ? `，${codeCheckText(run.error.code_check)}` : ''}`}</p> : null}
          {/* What the round may still read on its machine beyond its snapshot (knowledge §4.1, §1.3). */}
          {snapshot?.machine_inputs ? machineInputsText(snapshot.machine_inputs).map((line) => <p key={line} className="mt-1.5 text-xs text-muted-foreground wrap-anywhere">{line}</p>) : null}
          {task.source ? (
            <SourceFacts source={task.source} state={task.source_state ?? 'current'} label={task.source_label} now={sources} />
          ) : task.project_id ? (
            <section aria-label="这件活选定的来源">
              <p className={LABEL}>这件活选定的来源</p>
              <p className="wrap-anywhere">{task.machine_id ? '使用目标机器默认任务目录（未绑定项目代码来源）。' : '没有配代码来源。'}</p>
            </section>
          ) : null}
          {/* What the round shown was told, apart from what the work is pinned to now — merged when identical. */}
          {run && !sameSource ? <RoundSourceFacts run={run} snapshot={snapshot} /> : null}
        </section>

        {/* (5) 折叠的调整职能与档位 */}
        {editable ? (
          <Details
            id={`role-form:${task.id}`}
            title="调整职能与档位"
            {...(task.role_id === null ? { open: true } : {})}
            className="mt-4 border-t border-border pt-2"
          >
            <RoleForm key={`${task.role_id}:${task.tier_override}:${task.tier_reason}`} task={task} role={data.role} followed={data.review?.of?.tier ?? null} />
          </Details>
        ) : null}

        {runs.length ? (
          // Each round shows what it was sent out with; this is the Task as it stands now, which a
          // revision since the last round has changed.
          <Details id={`goal:${task.id}`} title="现在的目标与验收标准" className="mt-4 border-t border-border pt-2">
            <div className="pb-2">
              <Markdown text={task.goal} projectId={task.project_id ?? work.project_id ?? undefined} />
              {task.acceptance ? <><p className={LABEL}>验收标准</p><Markdown text={task.acceptance} projectId={task.project_id ?? work.project_id ?? undefined} /></> : null}
            </div>
          </Details>
        ) : null}

        {/* (6) 技术细节 */}
        <Details id={`tech:${task.id}`} title="技术细节" className="mt-4 border-t border-border pt-2">
          <div className="pb-2">
            <p className={LABEL}>任务编号</p>
            <p><Copyable value={task.id} /></p>
            <p className={LABEL}>当前修订</p>
            <p><Copyable value={String(task.revision)} /></p>
            {run ? (
              <>
                <p className={LABEL}>这一轮的修订</p>
                <p><Copyable value={String(run.task_revision)} /></p>
              </>
            ) : null}
            {runs.map((item, index) => (
              <div key={item.id}>
                <p className={LABEL}>{`第 ${index + 1} 轮的 Run id`}</p>
                <p><Copyable value={item.id} /></p>
                {item.session_ref ? (
                  <>
                    <p className={LABEL}>{`第 ${index + 1} 轮执行器里的会话`}</p>
                    <p><Copyable value={item.session_ref} /></p>
                    <Note className="mt-1 text-xs">{task.state === 'held' && !active
                      ? (() => {
                          const cmd = item.executor === 'claude' ? `claude --resume ${item.session_ref}`
                            : item.executor === 'codex' ? `codex exec resume ${item.session_ref}`
                            : item.executor === 'gemini' ? `agy --conversation ${item.session_ref}`
                            : item.executor === 'dsh' ? `dsh --profile headless --session-id ${item.session_ref}`
                            : null;
                          return cmd
                            ? `在实例上 ${cmd} 查看。人工操作后，请通过插话说明现场变化。`
                            : '可在实例上查阅原生记录。此账号的续接方式未提供。';
                        })()
                      : '执行期间请在这里查看现场。'}</Note>
                  </>
                ) : null}
              </div>
            ))}
            {runs.length ? (
              <Details id={`replay:${task.id}`} title="回放与隔离重跑" lazy className="mt-3 border-t border-border pt-2">
                <TrajectoryReplay runs={runs} />
              </Details>
            ) : null}
          </div>
        </Details>
      </div>
    </Details>
  );
}

// The drawer is one Run's: the Run it was opened for, among the Runs the task had then.
interface TraceView {
  runId: string;
  round: number;
  runs: string;
  loading: boolean;
  failure: string | null;
  trace: Trace | null;
}

function TraceDrawer({ view, projectId }: { view: TraceView; projectId?: string }) {
  const { trace } = view;
  const heading = 'mt-5 mb-1.5 text-sm font-semibold first:mt-0';
  return (
    <SheetContent title={`第 ${view.round} 轮为什么开始`}>
      {view.loading ? <Note>正在读取…</Note> : view.failure ? <Problem>{view.failure}</Problem> : trace ? (
        <div>
          <h3 className={heading}>触发</h3>
          <p>{trace.trigger.label}</p>
          {trace.trigger.message ? <Markdown text={trace.trigger.message.text} className="mt-1.5" projectId={projectId} /> : null}
          {trace.trigger.change
            ? <Note className="mt-1.5"><Time at={trace.trigger.change.at} suffix={` · ${trace.trigger.change.actor} · ${trace.trigger.change.action}`} /></Note>
            : <Note className="mt-1.5">账本里未找到可核实的触发记录</Note>}
          {trace.trigger.tool_call || trace.origin_call ? (
            [trace.trigger.tool_call, trace.origin_call].map((call, index) => call && (
              <section key={call.id}>
                <h3 className={heading}>{index === 0 ? '本轮的负责人调用' : '建任务时的负责人调用'}</h3>
                <p className="wrap-anywhere"><Mono>{call.name}</Mono></p>
                <Note><Time at={call.started_at} /></Note>
                {call.committed.length > 0 ? <p>账本已提交操作。</p> : <Note>本次调用没有关联的账本操作。</Note>}
                <Note>{call.result_state ? ROUTER_CALL_RESULT_TEXT[call.result_state] : '调用的返回未确认。'}</Note>
                {call.receipt_confirmed ? null : <Note>负责人是否收到结果未知。</Note>}
                <Details id={`tool-io:${call.id}`} title="查看工具输入与结果" className="mt-2">
                  <p className={LABEL}>收到的参数</p>
                  {call.request === null ? <Note>参数未记录。</Note> : <pre className={PRE}>{call.request}</pre>}
                  <p className={LABEL}>服务生成的结果</p>
                  {call.result === null ? <Note>结果正文未记录。</Note> : <pre className={PRE}>{call.result}</pre>}
                </Details>
              </section>
            ))
          ) : trace.trigger.message ? <Note className="mt-1.5">没有这次派发对应的负责人工具记录。</Note> : null}
          <h3 className={heading}>绑定的插话</h3>
          {trace.inputs.length
            ? <div className="grid gap-1.5">{trace.inputs.map((input, index) => <p key={index} className="wrap-anywhere">{input.text}</p>)}</div>
            : <Note>没有绑定的插话</Note>}
          <h3 className={heading}>沿用的执行器会话</h3>
          <p className="wrap-anywhere">{trace.session_ref ?? '本轮新开'}</p>
          <p className="mt-1">{`快照修订 ${trace.task_revision}`}</p>
          <h3 className={heading}>派发时的条件</h3>
          {trace.dispatchConditions
            ? <pre className={PRE}>{JSON.stringify(trace.dispatchConditions, null, 2)}</pre>
            : <Note>这轮没有记录派发条件，无法还原</Note>}
          {trace.settlement ? (
            <>
              <h3 className={heading}>结算与通知</h3>
              <p>{trace.settlement.task_state ? taskStateLabels[trace.settlement.task_state as keyof typeof taskStateLabels] ?? trace.settlement.task_state : '未记录结算时的任务状态'}</p>
              <Note><Time at={trace.settlement.at} /></Note>
              {trace.settlement.policy?.reason === 'owner_acceptance_requested' ? <Note>按这次任务的要求，服务直接通知你验收。</Note> : null}
              <Note>{{
                held: '结果通知等待合并。',
                pending: '结果通知已入出站队列。',
                sent: '出站记录为已发送。',
                given_up: '结果通知已停止重试。',
                unknown: '没有可核实的结果通知记录。',
              }[trace.settlement.delivery]}</Note>
            </>
          ) : null}
          <Details id={`changes:${view.runId}`} title="相关状态变更" className="mt-3">
            {trace.changes.map((change, index) => <Note key={index} className="mb-1 pl-5"><Time at={change.at} suffix={` · ${change.action} · ${change.actor}`} /></Note>)}
          </Details>
        </div>
      ) : null}
    </SheetContent>
  );
}

// Shared data, real-time run streams, trace drawer state, and derived flags for both the
// standalone TaskPage and the embedded TaskThreadPane inside ProjectPage.
function useTaskWorkspace(
  id: string,
  requestedRun: string | null,
  setRequestedRun: (runId: string | null) => void,
) {
  const { data, isPending, error } = useQuery(taskQuery(id));
  const { data: projects } = useQuery(projectsQuery);
  const selected = data?.runs.some((run) => run.id === requestedRun) ? requestedRun : null;
  const [reportsOnly, setReportsOnly] = useState(false);
  const streams = useRunStreams(data?.runs, selected);
  const control = useTaskAct(id);
  const [traceView, setTraceView] = useState<TraceView | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTraceView(null);
    setReportsOnly(false);
  }, [id]);

  const runIds = (data?.runs ?? []).map((run) => run.id).join(',');
  // A round that appears by itself shuts the drawer: left open, it would go on saying
  // "this round" of the one before.
  const trace = traceView?.runs === runIds ? traceView : null;
  const totalEvents = (data?.runs ?? []).reduce((total, run) => total + streams.events(run.id).length, 0);
  const long = (data?.runs.length ?? 0) > 1 || totalEvents > LONG_EVENTS;
  const failure = error?.message ?? streams.status;

  function select(runId: string | null): void {
    setTraceView(null);
    setRequestedRun(runId);
  }

  async function openTrace(): Promise<void> {
    const runId = selected ?? data?.runs.at(-1)?.id;
    if (!data || !runId) return;
    const asked: TraceView = { runId, round: data.runs.findIndex((run) => run.id === runId) + 1, runs: runIds, loading: true, failure: null, trace: null };
    setTraceView(asked);
    // The answer is for the drawer that asked. One shut since, or opened again for
    // another Run, is not that drawer: the answer is dropped.
    const answer = (result: Pick<TraceView, 'failure' | 'trace'>): void => setTraceView((view) => (view === asked ? { ...asked, loading: false, ...result } : view));
    try {
      answer({ failure: null, trace: await api<Trace>(`/api/runs/${encodeURIComponent(runId)}/trace`) });
    } catch (refused) {
      answer({ failure: messageOf(refused), trace: null });
    }
  }

  const projectId = data ? data.task.project_id ?? data.work.project_id ?? null : null;
  const project = projects?.find((each) => each.id === projectId);
  const runs = data?.runs ?? [];
  const shown = selected ? runs.filter((run) => run.id === selected) : runs;
  const current = shown.at(-1);
  const active = runs.some((run) => run.state !== 'ended');
  const over = data ? ['done', 'abandoned'].includes(data.task.state) : false;
  const isSystemTask = data ? Boolean(data.knowledge) || Boolean(data.review?.of) || data.task.project_id === null : false;
  const hideComposer = !data
    || data.task.state === 'abandoned'
    || data.task.state === 'waiting_person'
    || (over && isSystemTask);
  const hasSession = runs.some((run) => Boolean(run.session_ref));

  return {
    data,
    isPending,
    failure,
    projectId,
    project,
    selected,
    select,
    reportsOnly,
    setReportsOnly,
    streams,
    control,
    trace,
    setTraceView,
    openTrace,
    end,
    long,
    shown,
    current,
    active,
    over,
    hideComposer,
    hasSession,
  };
}

function TaskSiteBody({
  data,
  projectId,
  selected,
  shown,
  active,
  long,
  reportsOnly,
  setReportsOnly,
  streams,
  control,
  end,
  onSelect,
  className = 'flex flex-col gap-5 pt-4 pb-6 wide:pt-0',
}: {
  data: TaskPageData;
  projectId: string | null;
  selected: string | null;
  shown: readonly Run[];
  active: boolean;
  long: boolean;
  reportsOnly: boolean;
  setReportsOnly: (updater: (only: boolean) => boolean) => void;
  streams: RunStreams;
  control: TaskAct;
  end: RefObject<HTMLDivElement | null>;
  onSelect: (runId: string | null) => void;
  className?: string;
}) {
  const { task, runs } = data;
  const inputs = data.inputs.filter((input) => !selected || !input.run_id || input.run_id === selected);
  const queuedInputs = inputs.filter((input) => input.state === 'queued');
  const historyInputs = inputs.filter((input) => input.state !== 'queued');
  const questions = data.approvals.filter((approval) => approval.state === 'open');

  const firstRun = runs[0];
  const firstSnapshot = firstRun ? streams.snapshot(firstRun.id) : undefined;
  const firstSummary = firstRun && firstSnapshot ? dispatchSummary(task, firstRun, firstSnapshot) : null;
  const isSameGoalAsFirst = (run: Run): boolean => {
    if (selected !== null || !firstRun || run.id === firstRun.id || !firstSummary) return false;
    const snap = streams.snapshot(run.id);
    if (!snap) return false;
    const summary = dispatchSummary(task, run, snap);
    return summary.goal === firstSummary.goal && summary.acceptance === firstSummary.acceptance;
  };

  const buildTimelineEntries = (targetRuns: readonly Run[], targetInputs: readonly TaskInput[]) => [
    ...targetRuns.map((run) => ({
      at: run.created_at,
      key: `run:${run.id}`,
      mark: <Send />,
      tone: 'text-running',
      node: <RunSite data={data} run={run} streams={streams} reportsOnly={reportsOnly} sameAsFirst={isSameGoalAsFirst(run)} />,
    })),
    ...targetRuns.filter((run) => run.state === 'ended').map((run) => ({
      at: run.ended_at ?? run.created_at,
      key: `report:${run.id}`,
      mark: run.exit_kind === 'completed' ? <Check /> : run.exit_kind === 'failed' || run.exit_kind === 'lost' || run.exit_kind === 'auth' ? <X /> : <Minus />,
      tone: run.exit_kind === 'completed' ? 'text-success' : run.exit_kind === 'failed' || run.exit_kind === 'lost' || run.exit_kind === 'auth' ? 'text-failed' : 'text-ended',
      node: <Report run={run} fallback={run.id === runs.at(-1)?.id ? task.reason : null} projectId={projectId ?? undefined} />,
    })),
    ...targetInputs.map((input) => ({
      at: input.created_at,
      key: `input:${input.id}`,
      mark: null,
      tone: '',
      node: <InputEntry input={input} runs={runs} />,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const [viewTab, setViewTab] = useState<'process' | 'diff'>('process');
  useEffect(() => {
    setViewTab('process');
  }, [task.id]);

  const collapseOlder = selected === null && runs.length > 1;
  const olderRuns = collapseOlder ? runs.slice(0, -1) : [];
  const expandedRuns = collapseOlder ? runs.slice(-1) : shown;
  const olderRunIds = new Set(olderRuns.map((run) => run.id));
  const expandedInputs = historyInputs.filter((input) => !input.run_id || !olderRunIds.has(input.run_id));
  const entries = buildTimelineEntries(expandedRuns, expandedInputs);
  const shownEventsCount = shown.reduce((total, run) => total + streams.events(run.id).length, 0);

  const fallbackChanges = useMemo(
    () => shown.flatMap((run) => projectSite(streams.events(run.id), run.state === 'ended').changes),
    [shown, streams],
  );
  const checkpointCommits = useMemo<CheckpointCommit[]>(() => {
    const items: CheckpointCommit[] = [];
    const seen = new Set<string>();
    runs.forEach((run, index) => {
      for (const artifact of run.receipt?.artifacts ?? []) {
        if (artifact.kind === 'commit' && typeof artifact.ref === 'string' && artifact.ref.trim()) {
          const sha = artifact.ref.trim();
          if (!seen.has(sha)) {
            seen.add(sha);
            items.push({ commit: sha, label: `第 ${index + 1} 轮` });
          }
        }
      }
    });
    if (data.landable?.commit && !seen.has(data.landable.commit)) {
      items.push({ commit: data.landable.commit, label: '当前交付' });
    }
    return items;
  }, [runs, data.landable?.commit]);

  const canShowDiffTab = runs.length > 0 || fallbackChanges.length > 0 || Boolean(task.source);

  return (
    <div className={className}>
      {data.dispatch_info?.failover_note ? (
        <Callout tone="plain" role="status" aria-label="自动切换账号说明" className="py-2 text-xs text-muted-foreground">
          {data.dispatch_info.failover_note}
        </Callout>
      ) : null}
      {/* What waits for the owner stands before the record of how it got there. */}
      {questions.map((approval) => <ApprovalCard key={approval.id} card={{ ...approval, task_title: task.title }} />)}
      {active && task.state !== 'needs_verification' ? null : (
        <TaskActions
          task={task}
          active={active}
          interrupt={false}
          question={questions.length > 0}
          blocked={data.review?.blocked ?? null}
          gate={data.review?.gate ?? task.review_gate ?? null}
          control={control}
        />
      )}
      <AutomationNotice task={task} automation={data.automation} />
      {data.landable ? <LandCard taskId={task.id} landable={data.landable} /> : null}
      {hasRelease(data.releases) ? <ReleaseCard taskId={task.id} releases={data.releases} /> : null}
      {data.releases.dropped?.length ? <DroppedCopies dropped={data.releases.dropped} /> : null}
      {(() => {
        const deliverables = data.deliverables ?? [];
        const deliverablesProjectId = task.project_id ?? deliverables[0]?.project_id ?? null;
        if (!deliverablesProjectId) return null;
        const autoHint = hasReceiptDeliverableHint(runs);
        if (deliverables.length === 0 && !autoHint) return null;
        return (
          <DeliverablesSection
            taskId={task.id}
            projectId={deliverablesProjectId}
            deliverables={deliverables}
            autoSync={autoHint}
          />
        );
      })()}
      {selected !== null ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3.5 py-2 text-sm">
          <span>{`当前仅看第 ${runs.findIndex((run) => run.id === selected) + 1} 轮`}</span>
          <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>显示全部</Button>
        </div>
      ) : null}
      {canShowDiffTab ? (
        <div
          role="tablist"
          aria-label="任务视图切换"
          className="inline-flex w-fit items-center gap-1 rounded-lg border border-border bg-muted/50 p-0.5 text-xs"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewTab === 'process'}
            onClick={() => setViewTab('process')}
            className={cn(
              'rounded-md px-3 py-1 font-medium transition-colors',
              viewTab === 'process'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            过程
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewTab === 'diff'}
            onClick={() => setViewTab('diff')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-3 py-1 font-medium transition-colors',
              viewTab === 'diff'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Code2 className="size-3.5" aria-hidden="true" />
            代码变更
          </button>
        </div>
      ) : null}
      {viewTab === 'diff' ? (
        <TaskDiffPanel
          taskId={task.id}
          taskState={task.state}
          selectedRunId={selected}
          fallbackChanges={fallbackChanges}
          checkpointCommits={checkpointCommits}
          onSubmitted={() => setViewTab('process')}
        />
      ) : (
        <>
          {long ? (
            <div className="sticky top-0 z-10 -my-1 flex flex-wrap items-center gap-2 bg-background py-2">
              <Button size="sm" onClick={() => end.current?.scrollIntoView({ block: 'end' })}><ArrowDownToLine />跳到最新</Button>
              <Button size="sm" aria-pressed={reportsOnly} onClick={() => setReportsOnly((only) => !only)}>只看汇报</Button>
              <Note className="text-xs">{`这段现场有 ${shownEventsCount} 条过程记录`}</Note>
            </div>
          ) : null}
          {olderRuns.length > 0 ? (
            <div className="grid gap-2">
              {olderRuns.map((run, index) => {
                const roundInputs = historyInputs.filter((input) => input.run_id === run.id);
                const roundEntries = buildTimelineEntries([run], roundInputs);
                const snippet = run.receipt?.summary ?? run.error?.reason ?? run.error?.message ?? '';
                return (
                  <Details
                    key={run.id}
                    id={`round:${run.id}`}
                    className="rounded-xl border border-border bg-raised/60 px-3 py-1"
                    summaryClassName="min-h-9 gap-2 text-foreground"
                    title={(
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                        <span className="font-medium">{`第 ${index + 1} 轮`}</span>
                        <Badge tone={exitTone(run)}>{exitText(run)}</Badge>
                        {snippet ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{snippet}</span> : null}
                        <Time at={run.ended_at ?? run.created_at} className="ml-auto text-xs text-faint" />
                      </span>
                    )}
                  >
                    <div className="relative mt-2 mb-3 flex flex-col gap-5 before:absolute before:top-3 before:bottom-3 before:left-[11.5px] before:w-px before:bg-border">
                      {roundEntries.map((entry) => (
                        <div key={entry.key} className="relative pl-10">
                          {entry.mark ? <span aria-hidden="true" className={cn('absolute top-0 left-0 flex size-6 items-center justify-center rounded-full bg-raised shadow-card [&_svg]:size-3.5', entry.tone)}>{entry.mark}</span> : null}
                          {entry.node}
                        </div>
                      ))}
                    </div>
                  </Details>
                );
              })}
            </div>
          ) : null}
          {entries.length ? (
            // The site as a line of time: what was sent out, what came back, what was said in between.
            <div className="relative flex flex-col gap-6 before:absolute before:top-3 before:bottom-3 before:left-[11.5px] before:w-px before:bg-border">
              {entries.map((entry) => (
                <div key={entry.key} className="relative pl-10">
                  {entry.mark ? <span aria-hidden="true" className={cn('absolute top-0 left-0 flex size-6 items-center justify-center rounded-full bg-raised shadow-card [&_svg]:size-3.5', entry.tone)}>{entry.mark}</span> : null}
                  {entry.node}
                </div>
              ))}
            </div>
          ) : null}
          {queuedInputs.length > 0 ? (
            <section aria-label="待下一轮接收" className="grid gap-2 rounded-xl border border-dashed border-border-strong bg-muted/40 p-3.5">
              <p className="text-xs font-medium text-muted-foreground">待下一轮接收</p>
              <div className="flex flex-col gap-2">
                {queuedInputs.map((input) => (
                  <QueuedInputCard
                    key={input.id}
                    taskId={task.id}
                    input={input}
                    active={active}
                    control={control}
                  />
                ))}
              </div>
            </section>
          ) : null}
          <div ref={end} aria-hidden="true" />
          {runs.length ? null : (
            // Not run yet: no dispatch note says what it is for, so the Task says it itself.
            <section aria-label="任务目标" className="grid gap-3">
              <div className="rounded-xl bg-muted px-4 py-3.5">
                <Markdown text={task.goal} projectId={projectId ?? undefined} />
                {task.acceptance ? <><p className="mt-3 mb-1 text-xs text-faint">验收标准</p><Markdown text={task.acceptance} projectId={projectId ?? undefined} /></> : null}
              </div>
              <Note>还没有执行记录，插话会在下一次执行时送达。</Note>
            </section>
          )}
          <RunFactsCard taskId={task.id} projectId={task.project_id ?? null} />
          <Details id={`feedback:${task.id}`} title="任务反馈" lazy>
            <TaskFeedbackPanel key={`${task.id}:${selected ?? ''}`} taskId={task.id} runs={runs} selectedRun={selected} />
          </Details>
        </>
      )}
    </div>
  );
}

export interface TaskThreadPaneProps {
  id: string;
  onClose: () => void;
  onBackToRail?: () => void;
  hideHeaderChrome?: boolean;
  focused?: boolean;
  onToggleFocus?: () => void;
  dimmed?: boolean;
}

// Embedded right-hand split-pane inside the Project Workspace: shares 100% of the live stream,
// approvals, actions, deliverables, timeline, follow-up composer, and trace drawer with TaskPage.
export function TaskThreadPane({
  id,
  onClose,
  onBackToRail,
  hideHeaderChrome = false,
  focused = false,
  onToggleFocus,
  dimmed = false,
}: TaskThreadPaneProps) {
  const [requestedRun, setRequestedRun] = useState<string | null>(null);
  useEffect(() => {
    setRequestedRun(null);
  }, [id]);

  const {
    data,
    isPending,
    failure,
    projectId,
    project,
    selected,
    select,
    reportsOnly,
    setReportsOnly,
    streams,
    control,
    trace,
    setTraceView,
    openTrace,
    end,
    long,
    shown,
    current,
    active,
    over,
    hideComposer,
    hasSession,
  } = useTaskWorkspace(id, requestedRun, setRequestedRun);

  const currentLogin = data
    ? data.dispatch_info?.latest_login ?? (current?.login_name ? loginName(current.login_name) : (data.task.login_name ? loginName(data.task.login_name) : null))
    : null;
  const currentMachine = data
    ? data.dispatch_info?.latest_machine ?? current?.machine_id ?? current?.host ?? null
    : null;
  const assignment = data ? synthesizeTaskAssignment(data) : null;

  return (
    <Sheet open={trace !== null} onOpenChange={(open) => { if (open) void openTrace(); else setTraceView(null); }}>
      <section aria-label="任务线程" className="flex h-full min-h-0 flex-col bg-background">
        {hideHeaderChrome ? (
          <div className="flex flex-none flex-col gap-1 border-b border-border bg-muted/30 px-4 py-2">
            <div className="flex flex-wrap items-center gap-2">
              {data ? (
                <>
                  <StatusDot state={data.task.summary?.dot ?? data.task.state} />
                  <StateBadge state={data.task.state} className="flex-none" />
                  {hasSession && data.task.state !== 'abandoned' ? (
                    <Badge tone="plain" className="flex-none text-2xs">可续接</Badge>
                  ) : null}
                </>
              ) : isPending ? (
                <Skeleton className="h-4 w-28" />
              ) : null}
              <div className="ml-auto flex flex-none items-center gap-1">
                {onToggleFocus ? (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onToggleFocus}>
                    {focused ? <Minimize2 className="size-3.5" aria-hidden="true" /> : <Maximize2 className="size-3.5" aria-hidden="true" />}
                    {focused ? '恢复分屏' : '专注此线程'}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                  <Link to={`/task/${encodeURIComponent(id)}`} aria-label="在独立页面打开" title="在独立页面打开">
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                    独立页面
                  </Link>
                </Button>
              </div>
            </div>
            {assignment ? <TaskIdentityStrip assignment={assignment} showLiveLabel /> : null}
            {data ? (
              <p className="truncate text-xs text-muted-foreground" title={taskLine(data.task)}>
                {taskLine(data.task)}
                {data.task.lost?.waiting?.no_candidate ? (
                  <>
                    {' · '}
                    <Link to={data.task.project_id ? `/projects/${encodeURIComponent(data.task.project_id)}/settings` : '/accounts'}>检查项目登录</Link>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : (
          <header className="flex-none border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              {onBackToRail ? (
                <Button variant="ghost" size="sm" onClick={onBackToRail} className="-ml-1.5 flex-none">
                  ← 概览
                </Button>
              ) : null}
              {data ? (
                <>
                  <StatusDot state={data.task.summary?.dot ?? data.task.state} />
                  <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={data.task.title}>
                    {data.task.title}
                  </h2>
                  <StateBadge state={data.task.state} className="flex-none" />
                  {hasSession && data.task.state !== 'abandoned' ? (
                    <Badge tone="plain" className="flex-none text-2xs">可续接</Badge>
                  ) : null}
                </>
              ) : (
                <div className="min-w-0 flex-1">
                  {isPending ? <Skeleton className="h-4 w-36" /> : <span className="text-sm font-semibold text-muted-foreground">任务线程</span>}
                </div>
              )}
              <div className="ml-auto flex flex-none items-center gap-1">
                {onToggleFocus ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    aria-label={focused ? '恢复分屏' : '专注此线程'}
                    title={focused ? '恢复分屏' : '专注此线程'}
                    onClick={onToggleFocus}
                  >
                    {focused ? <Minimize2 className="size-3.5" aria-hidden="true" /> : <Maximize2 className="size-3.5" aria-hidden="true" />}
                    {focused ? '恢复分屏' : '专注此线程'}
                  </Button>
                ) : null}
                <Button variant="ghost" size="icon-sm" asChild>
                  <Link to={`/task/${encodeURIComponent(id)}`} aria-label="在独立页面打开" title="在独立页面打开">
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </Link>
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="关闭线程面板" title="关闭线程面板" onClick={onClose}>
                  <X className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
            {assignment ? <TaskIdentityStrip assignment={assignment} showLiveLabel className="mt-1.5" /> : null}
            {data ? (
              <p className="mt-1 truncate text-xs text-muted-foreground" title={taskLine(data.task)}>
                {taskLine(data.task)}
                {data.task.lost?.waiting?.no_candidate ? (
                  <>
                    {' · '}
                    <Link to={data.task.project_id ? `/projects/${encodeURIComponent(data.task.project_id)}/settings` : '/accounts'}>检查项目登录</Link>
                  </>
                ) : null}
              </p>
            ) : null}
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4 wrap-anywhere">
          {failure ? <Problem role="alert" className="mb-3">{failure}</Problem> : null}
          {isPending ? <SkeletonPage /> : data ? (
            <>
              <div className="mb-4 border-b border-border pb-2">
                <TaskDetails
                  data={data}
                  run={current}
                  wide={false}
                  embedded
                  selected={selected}
                  snapshot={streams.snapshot(current?.id)}
                  sources={project?.sources ?? []}
                  editable={!over}
                  onSelect={select}
                />
              </div>
              <TaskSiteBody
                data={data}
                projectId={projectId}
                selected={selected}
                shown={shown}
                active={active}
                long={long}
                reportsOnly={reportsOnly}
                setReportsOnly={setReportsOnly}
                streams={streams}
                control={control}
                end={end}
                onSelect={select}
                className="flex flex-col gap-5 pb-2"
              />
            </>
          ) : null}
        </div>
        {data && !hideComposer ? (
          <TaskComposer
            key={data.task.id}
            taskId={data.task.id}
            projectId={projectId}
            active={active}
            state={data.task.state}
            hasSession={hasSession}
            currentLogin={currentLogin}
            currentMachine={currentMachine}
            dimmed={dimmed}
            control={control}
            className="flex flex-none flex-col gap-1.5 border-t border-border bg-background px-4 py-2.5"
          />
        ) : null}
        {trace ? <TraceDrawer view={trace} projectId={projectId ?? undefined} /> : null}
      </section>
    </Sheet>
  );
}

// A Task's site: each round's dispatch note and what the Worker did, its report, what
// the owner put in, and what can be done about it now.
export function TaskPage({ id }: { id: string }) {
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const navigate = useNavigate();
  const live = useLive();

  const {
    data,
    isPending,
    failure,
    projectId,
    project,
    selected,
    select,
    reportsOnly,
    setReportsOnly,
    streams,
    control,
    trace,
    setTraceView,
    openTrace,
    end,
    long,
    shown,
    current,
    active,
    over,
    hideComposer,
    hasSession,
  } = useTaskWorkspace(id, params.get('run'), (runId) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (runId === null) next.delete('run');
      else next.set('run', runId);
      return next;
    }, { replace: true });
  });

  // A knowledge Task belongs to no project: it sits under the knowledge page.
  const home: Crumb = data?.knowledge ? { label: '知识', to: '/knowledge' }
    : { label: project?.name ?? '项目', to: projectId ? `/projects/${encodeURIComponent(projectId)}/work` : '/projects' };
  const crumbs: Crumb[] = data
    ? [home, ...(data.work.id === data.task.id ? [] : [{ label: data.work.title, to: `/work/${encodeURIComponent(data.work.id)}` }]), { label: data.task.title }]
    : [];

  function body() {
    if (!data) return null;
    const { task } = data;
    const currentLogin = data.dispatch_info?.latest_login
      ?? (current?.login_name ? loginName(current.login_name) : (task.login_name ? loginName(task.login_name) : null));
    const currentMachine = data.dispatch_info?.latest_machine ?? current?.machine_id ?? current?.host ?? null;
    const assignment = synthesizeTaskAssignment(data);
    return (
      <Sheet open={trace !== null} onOpenChange={(open) => { if (open) void openTrace(); else setTraceView(null); }}>
        <article className="grid grid-cols-[minmax(0,1fr)] gap-x-10 wide:grid-cols-[minmax(0,1fr)_288px] wide:grid-rows-[auto_minmax(0,1fr)]">
          <header className="col-start-1 pb-4">
            <PageTitle>{task.title}</PageTitle>
            <TaskStatus task={task} className="mt-2" />
            {assignment ? <TaskIdentityStrip assignment={assignment} showLiveLabel className="mt-2" /> : null}
            {task.wake_at ? <p className="mt-1 text-sm text-muted-foreground"><Time at={task.wake_at} prefix="预约在 " suffix=" 重新开始" /></p> : null}
            <p className="mt-1 text-xs text-faint"><Time at={task.created_at} prefix="创建于 " /></p>
          </header>
          <aside aria-label="任务详情" className="min-w-0 border-b border-border wide:col-start-2 wide:row-span-2 wide:row-start-1 wide:border-b-0 wide:pb-10">
            <TaskDetails
              data={data}
              run={current}
              wide={wide}
              selected={selected}
              snapshot={streams.snapshot(current?.id)}
              sources={project?.sources ?? []}
              editable={!over}
              onSelect={select}
            />
          </aside>
          <div className="min-w-0 wide:col-start-1">
            <TaskSiteBody
              data={data}
              projectId={projectId}
              selected={selected}
              shown={shown}
              active={active}
              long={long}
              reportsOnly={reportsOnly}
              setReportsOnly={setReportsOnly}
              streams={streams}
              control={control}
              end={end}
              onSelect={select}
            />
            {hideComposer ? null : (
              <TaskComposer
                key={task.id}
                taskId={task.id}
                projectId={projectId}
                active={active}
                state={task.state}
                hasSession={hasSession}
                currentLogin={currentLogin}
                currentMachine={currentMachine}
                control={control}
              />
            )}
          </div>
          {trace ? <TraceDrawer view={trace} projectId={projectId ?? undefined} /> : null}
        </article>
      </Sheet>
    );
  }

  return (
    <>
      <PageBar
        crumbs={crumbs}
        // A Task of no project (a knowledge gate) has no Router to talk to about it.
        actions={data && projectId !== null ? (
          <Button
            variant="ghost"
            onClick={() => {
              // In the conversation of the task's own project (docs/design/project-sessions.md §1).
              live.typeFor(projectId, `关于任务 ${data.task.title}（${data.task.id}）：`);
              void navigate(`/projects/${encodeURIComponent(projectId)}`, { state: { compose: true } });
            }}
          >
            <MessageSquare />
            <span className="max-sm:sr-only">在对话里谈这个任务</span>
          </Button>
        ) : null}
      />
      <PageScroll follow>
        <div className="mx-auto max-w-[1180px] px-4 pt-5 wrap-anywhere shell:px-6 shell:pt-6">
          {failure ? <Problem role="alert" className="mb-3">{failure}</Problem> : null}
          {isPending ? <SkeletonPage /> : body()}
        </div>
      </PageScroll>
    </>
  );
}
