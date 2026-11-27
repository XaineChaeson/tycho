// A project is one place with four sides (docs/design/project-sessions.md §1): the
// conversation with its Router, the work that came of it, what sets it off by itself, and
// how it is set up. Each side is an address of its own under the project's.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AppWindow, ArrowUp, Cpu, Ellipsis, FolderOpen, History, List, Loader2, MessageSquarePlus, Paperclip, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { PROJECT_ARCHIVED_LABEL, PROJECT_ARCHIVED_NOTE, PROJECT_ARCHIVED_TEXT, PROJECT_PAUSED_NOTE, PROJECT_PAUSED_TEXT, WORK_GROUP_ORDER, WORK_GROUPS, workGroup } from '@shared/labels.ts';
import { Callout, Chevron, Details, Dot, Empty, Note, Problem, Rows, SectionTitle, Time } from '@/components/bits';
import { ComposerTargetChip } from '@/components/composer-target-chip';
import { ComposerTriggerMenu, LARGE_PASTE_THRESHOLD, createPastedLogFile, type ComposerTriggerController } from '@/components/composer-triggers';
import { ItemView } from '@/components/conversation';
import { DeleteProjectDialog } from '@/components/delete-project-dialog';
import { HistoryEvidence } from '@/components/history-evidence';
import { PageBar, PageBody, PageTabs } from '@/components/page';
import { PageScroll } from '@/components/page-scroll';
import { ProjectDispatchGraph } from '@/components/project-dispatch-graph';
import { formatFileSize, isProjectLibraryFile, ProjectFilesSheet } from '@/components/project-files';
import { ProjectTriggers } from '@/components/project-triggers';
import { ProjectWorkspaceRail, type RailTab } from '@/components/project-workspace-rail';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from '@/components/ui/menu';
import { Option, Select } from '@/components/ui/select';
import { WorkRow } from '@/components/work-row';
import { useProjectFlag } from '@/hooks/use-project-flag';
import { api, messageOf, post, projectFileRawUrl, uploadProjectFile } from '@/lib/api';
import { conversationItems, hasTurn } from '@/lib/conversation';
import { EXAMPLE_ASKS, useAsk } from '@/lib/examples';
import { useLive, useLiveState } from '@/lib/live-context';
import { approvalsQuery, PAGE, projectFilesQuery, projectsQuery, stateQuery, tasksQuery } from '@/lib/queries';
import type { Conversation, Message, Project, ProjectFileSummary, Segment, Task, TurnChanges } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ProjectSettings } from '@/pages/project-settings';
import { TaskThreadPane } from '@/pages/task';

const WIDE = '(min-width: 1180px)';
const THREAD_PANE_WIDTH_KEY = 'tycho.threadPaneWidth';
const DEFAULT_THREAD_PANE_WIDTH = 540;
const MIN_THREAD_PANE_WIDTH = 420;
const MAX_THREAD_PANE_WIDTH = 820;

function clampThreadPaneWidth(width: number): number {
  return Math.min(MAX_THREAD_PANE_WIDTH, Math.max(MIN_THREAD_PANE_WIDTH, Math.round(width)));
}

function loadThreadPaneWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_THREAD_PANE_WIDTH;
    const raw = localStorage.getItem(THREAD_PANE_WIDTH_KEY);
    if (!raw) return DEFAULT_THREAD_PANE_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_THREAD_PANE_WIDTH;
    return clampThreadPaneWidth(parsed);
  } catch {
    return DEFAULT_THREAD_PANE_WIDTH;
  }
}

function saveThreadPaneWidth(width: number): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(THREAD_PANE_WIDTH_KEY, String(clampThreadPaneWidth(width)));
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

function useWide(): boolean {
  const [wide, setWide] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(WIDE).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(WIDE);
    setWide(media.matches);
    const update = (): void => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}

const projectPath = (id: string, tab = ''): string => `/projects/${encodeURIComponent(id)}${tab && `/${tab}`}`;

// Said on every side of a paused project, under its bar, with the one press that ends it: the
// shell's banner across the top is for the service's own trouble, not the owner's choice.
function PausedNotice({ project }: { project: Pick<Project, 'id' | 'paused_at'> }) {
  const pause = useProjectFlag(project, 'paused');
  if (!pause.on) return null;
  return (
    <div className="px-4 pt-3 shell:px-6">
      <Callout tone="waiting" role="status" aria-label={PROJECT_PAUSED_TEXT} action={<Button size="sm" disabled={pause.busy} onClick={() => void pause.set(false)}>恢复</Button>}>
        {PROJECT_PAUSED_NOTE}
        {pause.error ? <Problem role="alert" className="mt-1.5">{pause.error}</Problem> : null}
      </Callout>
    </div>
  );
}

// The bar every side of a project stands under: its name, its four sides, and whatever the
// side in view can do; under it, a paused project says so. An archived project carries its
// mark beside the name, and says the rest in the conversation.
function ProjectBar({ id, project, actions }: { id: string; project: Pick<Project, 'name'> & Partial<Pick<Project, 'waiting' | 'paused_at' | 'archived_at'>> | undefined; actions?: ReactNode }) {
  const waiting = project?.waiting ?? 0;
  const archived = project?.archived_at != null;
  return (
    <>
    <PageBar
      title={project?.name ?? '项目'}
      crumbs={[{ label: '项目', to: '/projects' }]}
      actions={actions}
      badge={archived ? <Badge tone="ended">{PROJECT_ARCHIVED_LABEL}</Badge> : undefined}
    >
      <PageTabs
        label="项目的页面"
        tabs={[
          { to: projectPath(id), label: '对话' },
          { to: projectPath(id, 'work'), label: '工作', count: waiting || undefined },
          { to: projectPath(id, 'triggers'), label: '触发器' },
          { to: projectPath(id, 'settings'), label: '设置' },
        ]}
      />
    </PageBar>
    {archived ? null : project?.paused_at ? <PausedNotice project={{ id, paused_at: project.paused_at }} /> : null}
    </>
  );
}

function EmptyTalk({ id }: { id: string }) {
  const ask = useAsk(id);
  return (
    <div className="mx-auto mt-[10vh] max-w-[480px] text-center">
      <h2 className="text-lg font-semibold">还没有对话</h2>
      <p className="mt-2 text-sm text-muted-foreground">对负责人说人话就行：它会把事情拆成任务、派给账号去做，再把结果带回来。</p>
      <p className="mt-1 text-sm text-muted-foreground">它自己不动手，也不替你拿主意；遇到要你定的事，它会在这里问你。怕做错就说清楚验收标准。</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {EXAMPLE_ASKS.map((text) => <Button key={text} size="sm" onClick={() => ask(text)}>{text}</Button>)}
      </div>
    </div>
  );
}

const MAX_COMPOSER_ATTACHMENTS = 8;

function normalizeUploadFile(file: File): File {
  if (file.name && file.name.trim() !== '') return file;
  const ext = file.type.split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return new File([file], `attachment-${Date.now()}.${ext}`, { type: file.type || 'application/octet-stream' });
}

// The box holds what the console keeps as the draft, not a text of its own: the owner
// can go and look something up on another page and find it as they left it, and a text
// the service refused while they were away is back in it, with the reason.
function Composer({ busy, project, dimmed = false, routerError = null }: { busy: boolean; project: string; dimmed?: boolean; routerError?: string | null }) {
  const live = useLive();
  const client = useQueryClient();
  const { sending, draft, attachments, refused } = useLiveState();
  const location = useLocation();
  // "在对话里谈这项工作" arrives here with the sentence begun, and the caret goes into it.
  const begun = (location.state as { compose?: boolean } | null)?.compose === true;
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const triggerController = useRef<ComposerTriggerController>({ open: false, handleKeyDown: () => false });
  const [caret, setCaret] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (begun) input.current?.focus();
  }, [begun]);

  useEffect(() => {
    if (!pasteNotice) return undefined;
    const timer = window.setTimeout(() => setPasteNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [pasteNotice]);

  async function handleUploadFiles(files: File[], convertedPaste = false): Promise<void> {
    if (files.length === 0 || sending !== null || uploading) return;
    const remaining = MAX_COMPOSER_ATTACHMENTS - live.getState().attachments.length;
    if (remaining <= 0) {
      setUploadError(`单条消息最多附带 ${MAX_COMPOSER_ATTACHMENTS} 个文件`);
      return;
    }
    const batch = files.slice(0, remaining);
    setUploading(true);
    setUploadError(null);
    let uploadedAny = false;
    const errors: string[] = [];
    try {
      for (const rawFile of batch) {
        const file = normalizeUploadFile(rawFile);
        try {
          const { file: uploaded } = await uploadProjectFile(project, file, { kind: 'upload' });
          live.addAttachment(uploaded);
          uploadedAny = true;
        } catch (error) {
          errors.push(`${file.name}：${messageOf(error)}`);
        }
      }
      if (uploadedAny) {
        await client.invalidateQueries({ queryKey: projectFilesQuery(project).queryKey });
        if (convertedPaste) setPasteNotice('已将长文本转为附件');
      }
      if (errors.length > 0) {
        setUploadError(errors.join('；'));
      } else if (files.length > remaining) {
        setUploadError(`单条消息最多附带 ${MAX_COMPOSER_ATTACHMENTS} 个文件，已忽略超出部分`);
      }
    } finally {
      setUploading(false);
    }
  }

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    void handleUploadFiles(selected);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files: File[] = [];
    const items = event.clipboardData?.items;
    if (items) {
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    if (files.length === 0 && event.clipboardData?.files?.length) {
      files.push(...Array.from(event.clipboardData.files));
    }
    const plainText = event.clipboardData?.getData('text/plain') ?? '';
    if (files.length > 0) {
      if (!plainText) event.preventDefault();
      void handleUploadFiles(files);
      return;
    }
    if (plainText && new Blob([plainText]).size > LARGE_PASTE_THRESHOLD) {
      event.preventDefault();
      setPasteNotice('已将长文本转为附件');
      void handleUploadFiles([createPastedLogFile(plainText)], true);
    }
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const dropped = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
    void handleUploadFiles(dropped);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (triggerController.current.handleKeyDown(event)) return;
    // Enter that confirms an IME candidate is not a send.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!uploading) void live.send();
  }

  function syncCaretFromEl(el: HTMLTextAreaElement | null): void {
    if (!el) return;
    setCaret(el.selectionStart ?? el.value.length);
  }

  function handleApplyTrigger(nextValue: string, nextCaret: number): void {
    live.type(nextValue);
    setCaret(nextCaret);
    queueMicrotask(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  }

  const canSend = (draft.trim() !== '' || attachments.length > 0) && !uploading && sending === null;

  return (
    <form
      className={cn(
        'flex-none px-4 pt-1 pb-[max(14px,env(safe-area-inset-bottom))] transition-opacity duration-150',
        dimmed && 'opacity-75 hover:opacity-100 focus-within:opacity-100',
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (!uploading) void live.send();
      }}
    >
      <div className="relative mx-auto w-full max-w-[760px]">
        {refused ? <Problem role="alert" className="mb-1.5">{`没有发出去：${refused}`}</Problem> : null}
        {uploadError ? <Problem role="alert" className="mb-1.5">{`上传失败：${uploadError}`}</Problem> : null}
        {pasteNotice ? <p className="mb-1.5 text-xs text-muted-foreground">{pasteNotice}</p> : null}
        {busy ? (
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Dot tone="running" />负责人在处理</span>
            <Button size="sm" onClick={() => { post('/api/interrupt', { project_id: project }).catch((error: unknown) => live.showError(messageOf(error))); }}><Square className="size-3 fill-current" />打断</Button>
          </div>
        ) : null}
        <ComposerTriggerMenu
          projectId={project}
          value={draft}
          caret={caret}
          disabled={sending !== null}
          controllerRef={triggerController}
          onApply={handleApplyTrigger}
        />
        {/* One box: attachments, text, and the buttons to attach/send. The ring is the box's, so it reads as one control. */}
        <div
          data-slot="composer-box"
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            'flex flex-col rounded-xl border border-input bg-background shadow-sm transition-[border-color,background-color,box-shadow] duration-100 focus-within:border-ring focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring/35',
            dragging && 'border-dashed border-primary bg-brand-soft/25',
          )}
        >
          {attachments.length > 0 || uploading ? (
            <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 pt-2.5 pb-2">
              {attachments.map((file) => (
                <div
                  key={file.id}
                  className="inline-flex max-w-[240px] items-center gap-2 rounded-lg border border-border bg-muted/60 py-1 pr-1 pl-1.5 text-xs"
                >
                  {file.is_image ? (
                    <img
                      src={projectFileRawUrl(project, file.id)}
                      alt={file.name}
                      className="size-10 flex-none rounded-md border border-border/60 object-cover"
                    />
                  ) : (
                    <span className="flex size-7 flex-none items-center justify-center rounded-md bg-background text-muted-foreground" aria-hidden="true">
                      {file.previewable ? <AppWindow className="size-3.5 text-brand-foreground" /> : <Paperclip className="size-3.5" />}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground" title={file.name}>{file.name}</div>
                    <div className="text-2xs text-muted-foreground tabular-nums">{formatFileSize(file.size)}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`移除附件 ${file.name}`}
                    className="size-6 flex-none rounded-md"
                    disabled={sending !== null}
                    onClick={() => live.removeAttachment(file.id)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
              {uploading ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  正在上传…
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-end gap-1.5 py-1.5 pr-1.5 pl-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              aria-label="选择附件"
              onChange={onFileInputChange}
            />
            <Tooltip text="添加附件（支持粘贴图片或拖拽文件）">
              <Button
                variant="ghost"
                size="icon"
                aria-label="添加附件"
                className="rounded-lg"
                disabled={sending !== null || uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
              </Button>
            </Tooltip>
            <Textarea
              ref={input}
              rows={1}
              placeholder="给负责人发消息"
              aria-label="给负责人发消息"
              className="max-h-[40vh] min-h-8 flex-1 overflow-y-auto border-0 bg-transparent px-1 py-1.5 text-base shadow-none focus:outline-0 read-only:bg-transparent"
              value={draft}
              readOnly={sending !== null}
              onChange={(event) => {
                live.type(event.target.value);
                syncCaretFromEl(event.target);
              }}
              onSelect={(event) => syncCaretFromEl(event.currentTarget)}
              onClick={(event) => syncCaretFromEl(event.currentTarget)}
              onKeyUp={(event) => syncCaretFromEl(event.currentTarget)}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
            />
            <Tooltip text="发送（Enter）">
              <Button
                variant="primary"
                size="icon"
                type="submit"
                aria-label="发送"
                data-ready={canSend ? 'true' : 'false'}
                className="rounded-lg"
                disabled={sending !== null || uploading}
              >
                <ArrowUp strokeWidth={2.25} />
              </Button>
            </Tooltip>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 px-3 py-1 text-2xs text-faint">
            <span>发给项目负责人</span>
            <ComposerTargetChip mode="project" projectId={project} routerError={routerError} compact />
          </div>
        </div>
        {/* A phone sends with its keyboard's own key: the line would only take space there. */}
        <p className="mt-1.5 hidden text-center text-2xs text-faint shell:block">Enter 发送，Shift+Enter 换行，输入 $/@// 快捷引用，支持粘贴或拖拽上传</p>
      </div>
    </form>
  );
}

// What of the conversation in view belongs here: the read was of this segment, but the stream
// pushes every project's messages. A row that names another project or segment is someone
// else's; what is queued for the project has no segment yet and goes with the current one.
function inView(rows: Iterable<Message>, project: string, segment: string | null, writable: boolean): Message[] {
  const all = [...rows];
  const mine = (row: Message): boolean => {
    if (row.project_id != null && row.project_id !== project) return false;
    if (row.basis === 'legacy') return false;
    if (row.segment_id == null) return writable || row.project_id == null;
    return row.segment_id === segment;
  };
  const inbound = new Set(all.filter((row) => row.direction === 'in' && mine(row)).map(({ id }) => id));
  return all.filter((row) => (row.direction === 'in' ? inbound.has(row.id)
    : row.external_id.startsWith('reply:') ? inbound.has(row.external_id.slice('reply:'.length)) || (row.segment_id != null && mine(row))
      : mine(row)));
}

const segmentLabel = ({ seq, state }: Segment): string => `第 ${seq} 段${state === 'current' ? '（当前）' : ''}`;

const worksOf = (tasks: readonly Task[] | undefined, project: string): Task[] => (tasks ?? []).filter((task) => task.project_id === project);

// Compact collapsible work-status bar shown above the chat below 1180px so active,
// waiting and ready tasks remain visible even when the side workspace rail is hidden.
function CompactWorkBar({ id, selectedThreadId, onSelectThread }: {
  id: string;
  selectedThreadId?: string | null;
  onSelectThread: (taskId: string) => void;
}) {
  const { data: listing } = useQuery(tasksQuery);
  const [open, setOpen] = useState(false);
  const works = worksOf(listing?.tasks, id).filter((task) => workGroup(task) !== WORK_GROUPS.ended);
  const children = listing?.children ?? [];
  if (works.length === 0) return null;
  const waitingCount = works.filter((task) => {
    const group = workGroup(task);
    return group === WORK_GROUPS.waiting || group === WORK_GROUPS.ready;
  }).length;
  const movingCount = works.length - waitingCount;
  const summaryParts = [
    waitingCount > 0 ? `${waitingCount} 件待处理` : null,
    movingCount > 0 ? `${movingCount} 项进行中` : null,
  ].filter(Boolean).join(' · ');
  return (
    <section aria-label="在办工作状态" className="flex-none border-b border-border bg-muted/40 px-4 py-1.5 wide:hidden">
      <div className="mx-auto flex w-full max-w-[760px] items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-xs text-foreground hover:bg-hover"
        >
          <Dot tone={waitingCount > 0 ? 'waiting' : 'running'} />
          <span className="font-medium">{`在办的工作（${works.length}）`}</span>
          {summaryParts ? <span className="min-w-0 truncate text-muted-foreground">{summaryParts}</span> : null}
          <Chevron className={cn('ml-auto transition-transform duration-100', open && 'rotate-90')} />
        </button>
        <Link to={projectPath(id, 'work')} className="flex-none text-xs text-muted-foreground">全部</Link>
      </div>
      {open ? (
        <div className="mx-auto mt-1.5 max-h-56 w-full max-w-[760px] overflow-y-auto rounded-lg border border-border bg-raised">
          <div className="grid grid-cols-[minmax(0,1fr)] divide-y divide-border">
            {works.map((task) => (
              <WorkRow
                key={task.id}
                task={task}
                dense
                selected={selectedThreadId === task.id}
                onSelect={(taskId) => {
                  setOpen(false);
                  onSelectThread(taskId);
                }}
                className="px-2.5"
                children={children.filter((child) => child.parent_id === task.id)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TalkSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-5">
      <Skeleton className="ml-auto h-10 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="ml-auto h-10 w-1/2" />
    </div>
  );
}

// A project's Router conversation: the current segment is written to, an earlier one is read
// only, and "新话题" starts the next one.
function ConversationTab({ id, project }: { id: string; project: Project | undefined }) {
  const live = useLive();
  const client = useQueryClient();
  const [asked, setAsked] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const meta = useQuery({
    queryKey: [PAGE, 'conversation', id, asked],
    queryFn: () => api<Conversation>(`/api/projects/${encodeURIComponent(id)}/conversation${asked ? `?segment=${encodeURIComponent(asked)}` : ''}`),
  });
  const shown = meta.data?.segment ?? null;
  const writable = meta.data?.writable ?? false;
  const home = meta.data?.home;
  const ownerNotice = home?.phase === 'frozen' ? '该项目正在移交，此服务保留历史记录。'
    : home?.phase === 'incoming' ? '此服务已准备接管。接管确认后才能继续。'
    : home?.phase === 'unknown' ? '项目归属待核实，当前只读。' : null;
  // Archived is out of sight everywhere else; its conversation still opens, read only until
  // it is restored. The list is the fresher answer once it has one; before that, the
  // conversation's own read says it.
  const archived = project !== undefined ? project.archived_at != null : meta.data?.project.archived_at != null;
  const archive = useProjectFlag({ id, archived_at: project?.archived_at ?? null }, 'archived');
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesQuery = useQuery(projectFilesQuery(id));
  const fileCount = (filesQuery.data?.files ?? []).filter(isProjectLibraryFile).length;
  useEffect(() => {
    if (meta.data) live.focusOn({ project: id, segment: shown });
  }, [live, id, meta.data, shown]);
  useEffect(() => () => live.focusOn(null), [live]);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedThreadId = searchParams.get('thread');
  const [railTab, setRailTab] = useState<RailTab>('threads');
  const wide = useWide();
  const [threadPaneWidth, setThreadPaneWidth] = useState<number>(() => loadThreadPaneWidth());
  const [threadFocused, setThreadFocused] = useState(false);
  const [activePane, setActivePane] = useState<'chat' | 'thread'>('chat');
  const resizeCleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    resizeCleanup.current?.();
  }, []);

  useEffect(() => {
    if (!selectedThreadId || !wide) setThreadFocused(false);
  }, [selectedThreadId, wide]);

  const updateThreadWidth = useCallback((nextWidth: number) => {
    const clamped = clampThreadPaneWidth(nextWidth);
    setThreadPaneWidth(clamped);
    saveThreadPaneWidth(clamped);
  }, []);

  const startResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanup.current?.();
    const startX = event.clientX;
    const startWidth = threadPaneWidth;
    let latestWidth = startWidth;

    const onMouseMove = (moveEvent: MouseEvent): void => {
      latestWidth = clampThreadPaneWidth(startWidth + (startX - moveEvent.clientX));
      setThreadPaneWidth(latestWidth);
    };
    const onMouseUp = (): void => {
      saveThreadPaneWidth(latestWidth);
      cleanup();
    };
    const cleanup = (): void => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      resizeCleanup.current = null;
    };
    resizeCleanup.current = cleanup;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [threadPaneWidth]);

  const openThread = useCallback((taskId: string) => {
    setActivePane('thread');
    setSearchParams((prev) => {
      if (prev.get('thread') === taskId) return prev;
      const next = new URLSearchParams(prev);
      next.set('thread', taskId);
      return next;
    });
  }, [setSearchParams]);

  const closeThread = useCallback(() => {
    setThreadFocused(false);
    setActivePane('chat');
    setSearchParams((prev) => {
      if (!prev.has('thread')) return prev;
      const next = new URLSearchParams(prev);
      next.delete('thread');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (!selectedThreadId || !wide) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
        if (target.closest('[role="dialog"], [role="alertdialog"], [data-slot="dialog"], [data-slot="sheet"], [data-slot="confirm"]')) return;
      }
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      closeThread();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedThreadId, wide, closeThread]);

  const { data: listing } = useQuery(tasksQuery);
  const liveTasks = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of listing?.tasks ?? []) map.set(task.id, task);
    for (const child of listing?.children ?? []) map.set(child.id, child);
    return map;
  }, [listing]);
  const selectedThreadTitle = selectedThreadId ? liveTasks.get(selectedThreadId)?.title : undefined;
  const attachToComposer = writable && !archived
    ? (file: ProjectFileSummary) => { live.addAttachment(file); }
    : undefined;

  const { messages, changes, sending, sendingAttachments, summary, loaded, focus } = useLiveState();
  // Read for this very conversation, not for the one in view a moment ago.
  const ready = loaded && meta.data !== undefined && focus?.project === id && focus.segment === shown;
  const { data: approvals } = useQuery(approvalsQuery);
  const rows = useMemo(() => inView(messages.values(), id, shown, writable), [messages, id, shown, writable]);
  const items = useMemo(
    () => conversationItems({
      messages: rows, changes,
      approvals: writable ? (approvals ?? []).filter((card) => card.project_id == null || card.project_id === id) : [],
      sending: writable ? sending : null,
      sendingAttachments: writable ? sendingAttachments : [],
    }),
    [rows, changes, approvals, sending, sendingAttachments, writable, id],
  );
  // Waiting for the turn under way is the same question the composer asks.
  const busy = useMemo(() => rows.some((row) => row.state === 'processing'), [rows]);
  const canStartNewTopic = Boolean(meta.data) && writable && !archived && !busy && rows.length > 0;

  const { data: serviceState } = useQuery(stateQuery);
  const [restartingRouter, setRestartingRouter] = useState(false);
  const [restartProblem, setRestartProblem] = useState<string | null>(null);
  const projectRouter = serviceState?.router.projects?.find((each) => each.project_id === id);
  const routerError = serviceState
    ? (serviceState.router.host_error
      ?? projectRouter?.error
      ?? ((project?.router?.account ?? null) === null ? serviceState.router.error : null))
    : (meta.data?.router_error ?? null);

  async function restartRouter(): Promise<void> {
    if (restartingRouter) return;
    setRestartingRouter(true);
    setRestartProblem(null);
    try {
      await post('/api/router/restart');
      await Promise.all([
        client.invalidateQueries({ queryKey: stateQuery.queryKey }),
        client.invalidateQueries({ queryKey: [PAGE, 'conversation', id] }),
      ]);
    } catch (error) {
      setRestartProblem(messageOf(error));
    } finally {
      setRestartingRouter(false);
    }
  }

  async function newTopic(): Promise<void> {
    if (!canStartNewTopic) return;
    if (!window.confirm('开启新话题会将当前对话归档为只读，确定吗？')) return;
    setProblem(null);
    try {
      await post(`/api/projects/${encodeURIComponent(id)}/new-topic`);
      setAsked(null);
      await client.invalidateQueries({ queryKey: [PAGE, 'conversation', id] });
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  return (
    <>
      <ProjectBar
        id={id}
        project={project ?? meta.data?.project}
        actions={(
          <>
            {meta.data && meta.data.segments.length > 1 ? (
              <Select aria-label="哪一段对话" value={shown ?? ''} onChange={(event) => setAsked(event.target.value || null)}>
                {meta.data.segments.map((segment) => <Option key={segment.id} value={segment.id}>{segmentLabel(segment)}</Option>)}
              </Select>
            ) : null}
            <Tooltip text="查看项目文件与交互产物">
              <Button variant="ghost" onClick={() => setFilesOpen(true)}>
                <FolderOpen />
                项目文件
                {fileCount > 0 ? (
                  <span className="rounded-full bg-hover px-1.5 text-xs leading-[18px] font-medium text-muted-foreground tabular-nums">
                    {fileCount}
                  </span>
                ) : null}
              </Button>
            </Tooltip>
            <Tooltip text={rows.length === 0 ? '当前对话还没有消息' : busy ? '负责人处理完当前消息后再开新话题' : '结束这一段，开一段新的对话'}>
              <Button variant="ghost" disabled={!canStartNewTopic} onClick={() => void newTopic()}><MessageSquarePlus />新话题</Button>
            </Tooltip>
            <Menu>
              <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多"><Ellipsis /></Button></MenuTrigger>
              <MenuContent>
                <MenuItem asChild>
                  <Link to={`/legacy?project=${encodeURIComponent(id)}`} className="no-underline">
                    <History />
                    {meta.data && meta.data.legacy > 0 ? `旧全局记录里有 ${meta.data.legacy} 条和它有关` : '旧全局记录'}
                  </Link>
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        )}
      />
      <div className="flex min-h-0 flex-1">
        <div
          data-pane="chat"
          onFocusCapture={() => setActivePane('chat')}
          onPointerDownCapture={() => setActivePane('chat')}
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            selectedThreadId !== null && wide && threadFocused && 'hidden',
          )}
        >
          <CompactWorkBar id={id} selectedThreadId={selectedThreadId} onSelectThread={openThread} />
          <PageScroll follow opens="latest">
            <div className="mx-auto w-full max-w-[760px] px-4">
              {problem ? <Problem role="alert" className="mt-3">{problem}</Problem> : null}
              {meta.error ? <Problem role="alert" className="mt-3">{meta.error.message}</Problem> : null}
              {!writable && meta.data ? <Note className="mt-4 rounded-lg bg-muted px-3 py-2">{ownerNotice ?? '这是之前的一段对话，只能看；新消息发在当前这一段。'}</Note> : null}
              <div role="log" aria-label="对话" className="flex flex-col gap-5 pt-6 pb-8 text-base">
                {writable && summary ? <p className="text-center text-xs text-faint">{summary}</p> : null}
                {/* Never another conversation's rows under this one's name: until this one has
                    been read once, the shape of what is coming. */}
                {ready ? items.map((item) => (
                  <ItemView
                    key={item.key}
                    item={item}
                    projectId={id}
                    onSelectTask={openThread}
                    liveTasks={liveTasks}
                    empty={<EmptyTalk id={id} />}
                  />
                )) : <TalkSkeleton />}
              </div>
            </div>
          </PageScroll>
          {archived ? (
            <div className="flex-none px-4 pt-1 pb-[max(14px,env(safe-area-inset-bottom))]">
              <Callout
                tone="plain"
                role="status"
                aria-label={PROJECT_ARCHIVED_TEXT}
                title={PROJECT_ARCHIVED_TEXT}
                action={(
                  <div className="flex items-center gap-2">
                    <Button size="sm" disabled={archive.busy} onClick={() => void archive.set(false)}>恢复</Button>
                    {project && project.deletable?.allowed !== false ? (
                      <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>删除项目</Button>
                    ) : null}
                  </div>
                )}
                className="mx-auto w-full max-w-[760px]"
              >
                {PROJECT_ARCHIVED_NOTE}
                {archive.error ? <Problem role="alert" className="mt-1.5">{archive.error}</Problem> : null}
              </Callout>
              {project ? (
                <DeleteProjectDialog
                  project={project}
                  open={confirmDelete}
                  onOpenChange={setConfirmDelete}
                  onDeleted={() => { void navigate('/projects'); }}
                />
              ) : null}
            </div>
          ) : writable ? (
            <>
              {routerError ? (
                <div className="flex-none px-4 pt-2">
                  <Callout
                    tone="failed"
                    role="alert"
                    title="项目负责人已停摆"
                    className="mx-auto w-full max-w-[760px]"
                    action={(
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={restartingRouter || Boolean(serviceState?.router.restarting)}
                          onClick={() => void restartRouter()}
                        >
                          {restartingRouter || serviceState?.router.restarting ? '重启中…' : '重启负责人'}
                        </Button>
                        <Link
                          to={projectPath(id, 'settings')}
                          className="text-xs font-medium text-link no-underline hover:underline"
                        >
                          项目设置
                        </Link>
                      </div>
                    )}
                  >
                    <p className="wrap-anywhere">{routerError}</p>
                    {restartProblem ? <Problem role="alert" className="mt-1.5">{restartProblem}</Problem> : null}
                  </Callout>
                </div>
              ) : null}
              <Composer
                busy={busy}
                project={id}
                routerError={routerError}
                dimmed={Boolean(selectedThreadId && wide && !threadFocused && activePane === 'thread')}
              />
            </>
          ) : null}
        </div>
        {selectedThreadId === null ? (
          <aside aria-label="项目工作台" className="hidden w-[340px] flex-none flex-col overflow-hidden border-l border-border wide:flex">
            <ProjectWorkspaceRail
              projectId={id}
              activeTab={railTab}
              onTabChange={setRailTab}
              selectedThreadId={selectedThreadId}
              onSelectThread={openThread}
              onAttachToComposer={attachToComposer}
            />
          </aside>
        ) : wide ? (
          <>
            {!threadFocused ? (
              <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="调整线程面板宽度"
                aria-valuemin={MIN_THREAD_PANE_WIDTH}
                aria-valuemax={MAX_THREAD_PANE_WIDTH}
                aria-valuenow={threadPaneWidth}
                title="拖动调整宽度，双击恢复默认"
                onMouseDown={startResize}
                onDoubleClick={() => updateThreadWidth(DEFAULT_THREAD_PANE_WIDTH)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    updateThreadWidth(threadPaneWidth + 24);
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    updateThreadWidth(threadPaneWidth - 24);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    updateThreadWidth(DEFAULT_THREAD_PANE_WIDTH);
                  }
                }}
                className="hidden w-1.5 flex-none cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-border-strong/70 focus-visible:bg-ring/40 focus-visible:outline-0 wide:flex"
              >
                <span aria-hidden="true" className="h-8 w-0.5 rounded-full bg-border-strong/60" />
              </div>
            ) : null}
            <aside
              aria-label="执行线程"
              data-pane="thread"
              onFocusCapture={() => setActivePane('thread')}
              onPointerDownCapture={() => setActivePane('thread')}
              style={threadFocused ? undefined : { width: `${threadPaneWidth}px` }}
              className={cn(
                'hidden min-w-0 flex-col overflow-hidden border-l border-border bg-background wide:flex',
                threadFocused ? 'flex-1 border-l-0' : 'flex-none min-w-[420px] max-w-[820px]',
              )}
            >
              <TaskThreadPane
                id={selectedThreadId}
                onClose={closeThread}
                onBackToRail={closeThread}
                focused={threadFocused}
                onToggleFocus={() => setThreadFocused((value) => !value)}
                dimmed={!threadFocused && activePane === 'chat'}
              />
            </aside>
          </>
        ) : null}
      </div>
      <Sheet open={selectedThreadId !== null && !wide} onOpenChange={(next) => { if (!next) closeThread(); }}>
        {selectedThreadId && !wide ? (
          <SheetContent
            title={selectedThreadTitle ?? '执行线程'}
            className="w-[min(640px,96vw)] max-w-none"
            bodyClassName="flex min-h-0 flex-col overflow-hidden p-0"
          >
            <TaskThreadPane id={selectedThreadId} onClose={closeThread} hideHeaderChrome />
          </SheetContent>
        ) : null}
      </Sheet>
      <ProjectFilesSheet
        projectId={id}
        open={filesOpen}
        onOpenChange={setFilesOpen}
        onAttachToComposer={writable && !archived ? (file) => {
          live.addAttachment(file);
          setFilesOpen(false);
        } : undefined}
      />
    </>
  );
}

type WorkViewMode = 'list' | 'hud' | 'trace';
const WORK_VIEW_KEY = 'tycho.projectWorkView';

function loadWorkViewMode(): WorkViewMode {
  try {
    if (typeof localStorage === 'undefined') return 'list';
    const raw = localStorage.getItem(WORK_VIEW_KEY);
    if (raw === 'hud' || raw === 'trace' || raw === 'list') return raw;
    return 'list';
  } catch {
    return 'list';
  }
}

function saveWorkViewMode(mode: WorkViewMode): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(WORK_VIEW_KEY, mode);
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

const WORK_VIEW_OPTIONS: { id: WorkViewMode; label: string; icon: typeof List }[] = [
  { id: 'list', label: '列表', icon: List },
  { id: 'hud', label: '蓝图', icon: Cpu },
  { id: 'trace', label: '泳道', icon: Activity },
];

// Every work of the project that the side column's list holds, by where it stands; the ones
// that ended longer ago are a page away.
function WorkTab({ id, project }: { id: string; project: Project | undefined }) {
  const navigate = useNavigate();
  const { data: listing, isPending, error } = useQuery(tasksQuery);
  const [viewMode, setViewMode] = useState<WorkViewMode>(loadWorkViewMode);
  const works = worksOf(listing?.tasks, id);
  const children = listing?.children ?? [];
  const childCount = useMemo(() => {
    const workIds = new Set(works.map((w) => w.id));
    let count = 0;
    let changed = true;
    const seen = new Set(workIds);
    while (changed) {
      changed = false;
      for (const child of children) {
        if (child.parent_id && seen.has(child.parent_id) && !seen.has(child.id)) {
          seen.add(child.id);
          count += 1;
          changed = true;
        }
      }
    }
    return count;
  }, [works, children]);

  const selectViewMode = (next: WorkViewMode): void => {
    setViewMode(next);
    saveWorkViewMode(next);
  };

  return (
    <>
      <ProjectBar id={id} project={project} />
      <PageBody width={viewMode === 'list' ? 'default' : 'wide'} loading={isPending} failure={error?.message}>
        {works.length ? (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {works.length} 项工作{childCount > 0 ? ` · ${childCount} 个派生子任务` : ''}
              </span>
              <div
                role="tablist"
                aria-label="工作视图"
                className="inline-flex items-center rounded-lg border border-border bg-muted p-0.5 text-xs"
              >
                {WORK_VIEW_OPTIONS.map(({ id: optionId, label, icon: Icon }) => {
                  const active = viewMode === optionId;
                  return (
                    <button
                      key={optionId}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => selectViewMode(optionId)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors',
                        active
                          ? 'bg-raised text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden="true" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {viewMode === 'list' ? (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-7">
                {WORK_GROUP_ORDER.map((group) => {
                  const members = works.filter((task) => workGroup(task) === group);
                  if (!members.length) return null;
                  return (
                    <section key={group} aria-label={group}>
                      <SectionTitle count={members.length}>{group}</SectionTitle>
                      <Rows>
                        {members.map((task) => (
                          <WorkRow
                            key={task.id}
                            task={task}
                            children={children.filter((child) => child.parent_id === task.id)}
                            meta={<Time at={task.finished_at ?? task.updated_at ?? task.created_at} />}
                          />
                        ))}
                      </Rows>
                    </section>
                  );
                })}
              </div>
            ) : (
              <ProjectDispatchGraph
                project={project}
                works={works}
                children={children}
                mode={viewMode}
                onSelectTask={(taskId) => navigate(`${projectPath(id)}?thread=${encodeURIComponent(taskId)}`)}
                onOpenConversation={() => navigate(projectPath(id))}
              />
            )}
          </>
        ) : <Empty title="这个项目还没有工作">在对话里告诉负责人要做什么，它建的工作会列在这里。</Empty>}
        <p className="mt-6 text-sm text-muted-foreground"><Link to={`/work?show=ended&project=${encodeURIComponent(id)}`}>这个项目全部已结束的工作</Link></p>
        {project ? (
          <Details id={`history-evidence:${id}`} title="按关键词、提交号或知识版本查历史证据" lazy className="mt-4">
            <div className="mt-2"><HistoryEvidence key={id} projectId={id} /></div>
          </Details>
        ) : null}
      </PageBody>
    </>
  );
}

function TriggersTab({ id, project }: { id: string; project: Project | undefined }) {
  return (
    <>
      <ProjectBar id={id} project={project} />
      <PageBody width="wide">
        <ProjectTriggers projectId={id} projectName={project?.name ?? '项目'} />
      </PageBody>
    </>
  );
}

function SettingsTab({ id, project, loading, failure }: { id: string; project: Project | undefined; loading: boolean; failure: string | undefined }) {
  return (
    <>
      <ProjectBar id={id} project={project} />
      <PageBody width="default" loading={loading} failure={failure}>
        {project ? <ProjectSettings key={project.id} project={project} /> : loading ? null : <Empty title="没有这个项目">它可能已经被删掉了。<Link to="/projects" className="ml-1">看全部项目</Link></Empty>}
      </PageBody>
    </>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const { tab } = useParams();
  const { data: projects, isPending, error } = useQuery(projectsQuery);
  const project = projects?.find((each) => each.id === id);
  if (tab === 'work') return <WorkTab id={id} project={project} />;
  if (tab === 'triggers') return <TriggersTab id={id} project={project} />;
  if (tab === 'settings') return <SettingsTab id={id} project={project} loading={isPending} failure={error?.message} />;
  return <ConversationTab id={id} project={project} />;
}

// The old global Router's conversation (docs/design/project-sessions.md §6), read only; with a
// project, the part of it the ledger can tie to that project.
export function LegacyPage() {
  const [params] = useSearchParams();
  const project = params.get('project');
  // The messages and what each request's turn committed, in one read as for any conversation.
  const read = useQuery({
    queryKey: [PAGE, 'legacy', project],
    queryFn: () => api<{ messages: Message[]; changes?: Record<string, TurnChanges> }>(`/api/messages?legacy=1&limit=200${project ? `&project=${encodeURIComponent(project)}` : ''}`),
  });
  const items = useMemo(() => {
    const messages = read.data?.messages ?? [];
    const committed = read.data?.changes ?? {};
    const changes = new Map<string, TurnChanges>(messages.filter(hasTurn).map(({ id }) => [id, committed[id] ?? { changes: [], tasks: [] }]));
    return conversationItems({ messages, changes, approvals: [], sending: null });
  }, [read.data]);
  return (
    <>
      <PageBar title="旧全局记录" crumbs={project ? [{ label: '项目', to: '/projects' }, { label: '这个项目', to: projectPath(project) }] : [{ label: '项目', to: '/projects' }]} />
      <PageBody width="narrow" failure={read.error?.message}>
        <Note className="rounded-lg bg-muted px-3 py-2">
          {project ? '旧全局记录里能从账本确定属于这个项目的部分。' : '旧全局记录：所有项目共用一个负责人时的对话。'}只能看，不会再续接；确定不了属于哪个项目的留在这里。
        </Note>
        <div role="log" aria-label="旧全局记录" className="flex flex-col gap-5 pt-6 pb-6 text-base">
          {items.filter((item) => item.kind !== 'empty').map((item) => <ItemView key={item.key} item={item} projectId={project ?? undefined} />)}
        </div>
      </PageBody>
    </>
  );
}
