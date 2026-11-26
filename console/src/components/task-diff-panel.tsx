import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileDiff, GitBranch, GitCommitHorizontal, MessageSquarePlus, RotateCcw, Send, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Callout, Mono, Note, Problem } from '@/components/bits';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Option, Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useMounted } from '@/hooks/use-mounted';
import { api, messageOf, post } from '@/lib/api';
import { PAGE, taskQuery, tasksQuery } from '@/lib/queries';
import type { FileChange, TaskDiffFile, TaskDiffResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface LineAnnotation {
  id: string;
  path: string;
  line: number;
  code: string;
  comment: string;
  commit: string | null;
}

export interface CheckpointCommit {
  commit: string;
  label?: string;
}

export interface TaskDiffPanelProps {
  taskId: string;
  taskState: string;
  selectedRunId?: string | null;
  fallbackChanges?: readonly FileChange[];
  checkpointCommits?: readonly CheckpointCommit[];
  onSubmitted?: () => void;
  className?: string;
}

interface ParsedDiffLine {
  key: string;
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'context';
  oldLine: number | null;
  newLine: number | null;
  prefix: string;
  content: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedPatch(patch: string): ParsedDiffLine[] {
  if (!patch) return [];
  const rawLines = patch.replace(/\r\n/g, '\n').split('\n');
  // Drop trailing empty line caused by final newline in patch text.
  if (rawLines.length > 1 && rawLines.at(-1) === '') rawLines.pop();
  const result: ParsedDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let seenHunk = false;

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]!;
    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      seenHunk = true;
      result.push({ key: `h-${index}`, kind: 'hunk', oldLine: null, newLine: null, prefix: '', content: raw });
      continue;
    }
    if (
      !seenHunk && (
        raw.startsWith('diff --git ')
        || raw.startsWith('index ')
        || raw.startsWith('--- ')
        || raw.startsWith('+++ ')
        || raw.startsWith('new file mode ')
        || raw.startsWith('deleted file mode ')
        || raw.startsWith('rename from ')
        || raw.startsWith('rename to ')
      )
    ) {
      result.push({ key: `m-${index}`, kind: 'meta', oldLine: null, newLine: null, prefix: '', content: raw });
      continue;
    }
    if (raw.startsWith('\\')) {
      result.push({ key: `m-${index}`, kind: 'meta', oldLine: null, newLine: null, prefix: '', content: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      result.push({
        key: `a-${index}-${newLine}`,
        kind: 'add',
        oldLine: null,
        newLine,
        prefix: '+',
        content: raw.slice(1),
      });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      result.push({
        key: `d-${index}-${oldLine}`,
        kind: 'del',
        oldLine,
        newLine: null,
        prefix: '-',
        content: raw.slice(1),
      });
      oldLine += 1;
      continue;
    }
    const content = raw.startsWith(' ') ? raw.slice(1) : raw;
    result.push({
      key: `c-${index}-${newLine}`,
      kind: 'context',
      oldLine,
      newLine,
      prefix: ' ',
      content,
    });
    oldLine += 1;
    newLine += 1;
  }

  return result;
}

export function formatAnnotationsMarkdown(
  annotations: readonly LineAnnotation[],
  commit: string | null,
): string {
  const header = commit
    ? `请根据以下行级代码批注进行修改（参考提交 \`${commit.slice(0, 10)}\`）：`
    : '请根据以下行级代码批注进行修改：';
  const items = annotations.map((ann, idx) => {
    const codeSnippet = ann.code.trimEnd();
    const quoted = codeSnippet
      ? `\n   \`\`\`\n   ${codeSnippet}\n   \`\`\``
      : '';
    const commentLines = ann.comment
      .trim()
      .split('\n')
      .map((line) => `   > ${line}`)
      .join('\n');
    return `${idx + 1}. \`${ann.path}:L${ann.line}\`${quoted}\n${commentLines}`;
  });
  return `${header}\n\n${items.join('\n\n')}`;
}

const FILE_STATUS_LABEL: Record<TaskDiffFile['status'], { short: string; tone: BadgeTone }> = {
  added: { short: 'A', tone: 'success' },
  modified: { short: 'M', tone: 'running' },
  deleted: { short: 'D', tone: 'failed' },
  renamed: { short: 'R', tone: 'waiting' },
};

const CHANGE_OP_LABEL: Record<NonNullable<FileChange['op']>, string> = {
  add: '新增',
  update: '修改',
  delete: '删除',
};

export function TaskDiffPanel({
  taskId,
  taskState,
  selectedRunId = null,
  fallbackChanges,
  checkpointCommits,
  onSubmitted,
  className,
}: TaskDiffPanelProps) {
  const client = useQueryClient();
  const mounted = useMounted();
  const diffQueryKey = useMemo(
    () => [PAGE, 'task-diff', taskId, selectedRunId ?? null] as const,
    [taskId, selectedRunId],
  );

  const { data, isPending, isError } = useQuery({
    queryKey: diffQueryKey,
    queryFn: () => api<TaskDiffResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/diff${selectedRunId ? `?run=${encodeURIComponent(selectedRunId)}` : ''}`,
    ),
    retry: false,
  });

  const files = data?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<LineAnnotation[]>([]);
  const [editing, setEditing] = useState<{ path: string; line: number; code: string } | null>(null);
  const [draftComment, setDraftComment] = useState('');
  const [staleConfirmed, setStaleConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Checkpoint rollback state (Wave C2)
  const distinctCheckpoints = useMemo(() => {
    const seen = new Set<string>();
    const list: CheckpointCommit[] = [];
    for (const item of checkpointCommits ?? []) {
      const sha = item.commit.trim();
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      list.push({ commit: sha, label: item.label });
    }
    return list;
  }, [checkpointCommits]);
  const [rollbackTarget, setRollbackTarget] = useState<string>('');
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  useEffect(() => {
    if (distinctCheckpoints.length >= 2 && !distinctCheckpoints.some((c) => c.commit === rollbackTarget)) {
      const fallback = distinctCheckpoints.find((c) => c.commit !== data?.commit) ?? distinctCheckpoints[0]!;
      setRollbackTarget(fallback.commit);
    }
  }, [distinctCheckpoints, rollbackTarget, data?.commit]);

  // Reset per-task local UI state when switching tasks.
  useEffect(() => {
    setSelectedPath(null);
    setAnnotations([]);
    setEditing(null);
    setDraftComment('');
    setStaleConfirmed(false);
    setSubmitError(null);
    setConfirmRollback(false);
    setRollbackError(null);
  }, [taskId]);

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  const activeFile = useMemo(() => {
    if (files.length === 0) return null;
    return files.find((file) => file.path === selectedPath) ?? files[0]!;
  }, [files, selectedPath]);

  const parsedLines = useMemo(
    () => (activeFile ? parseUnifiedPatch(activeFile.patch) : []),
    [activeFile],
  );

  const totals = useMemo(
    () => files.reduce((acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }), { additions: 0, deletions: 0 }),
    [files],
  );

  const currentCommit = data?.commit ?? null;
  const staleAnnotation = useMemo(
    () => annotations.find((ann) => ann.commit !== null && currentCommit !== null && ann.commit !== currentCommit) ?? null,
    [annotations, currentCommit],
  );
  const isStale = staleAnnotation !== null;

  useEffect(() => {
    if (!isStale) setStaleConfirmed(false);
  }, [isStale, currentCommit]);

  function openEditor(path: string, line: number, code: string): void {
    setEditing({ path, line, code });
    setDraftComment('');
  }

  function saveAnnotation(): void {
    if (!editing) return;
    const trimmed = draftComment.trim();
    if (!trimmed) return;
    const next: LineAnnotation = {
      id: `${editing.path}:${editing.line}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
      path: editing.path,
      line: editing.line,
      code: editing.code,
      comment: trimmed,
      commit: currentCommit,
    };
    setAnnotations((prev) => [...prev, next]);
    setEditing(null);
    setDraftComment('');
  }

  function removeAnnotation(id: string): void {
    setAnnotations((prev) => prev.filter((item) => item.id !== id));
  }

  function rebaseAnnotationsToCurrent(): void {
    setAnnotations((prev) => prev.map((item) => ({ ...item, commit: currentCommit })));
    setStaleConfirmed(false);
  }

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(null);
      setDraftComment('');
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      saveAnnotation();
    }
  }

  async function submitAnnotations(): Promise<void> {
    if (annotations.length === 0 || submitting) return;
    if (isStale && !staleConfirmed) return;
    setSubmitting(true);
    setSubmitError(null);
    const payload = formatAnnotationsMarkdown(annotations, currentCommit);
    const isContinue = taskState === 'done' || taskState === 'ready' || taskState === 'held';
    try {
      if (isContinue) {
        await post(`/api/tasks/${encodeURIComponent(taskId)}/continue`, { note: payload });
      } else {
        await post(`/api/tasks/${encodeURIComponent(taskId)}/inputs`, { text: payload });
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey }),
        client.invalidateQueries({ queryKey: tasksQuery.queryKey }),
        client.invalidateQueries({ queryKey: [PAGE] }),
      ]);
      if (mounted()) {
        setAnnotations([]);
        setStaleConfirmed(false);
        onSubmitted?.();
      }
    } catch (error) {
      if (mounted()) setSubmitError(messageOf(error));
    } finally {
      if (mounted()) setSubmitting(false);
    }
  }

  async function runRollback(): Promise<void> {
    if (!rollbackTarget || rollingBack) return;
    setRollingBack(true);
    setRollbackError(null);
    try {
      await post(`/api/tasks/${encodeURIComponent(taskId)}/rollback`, { commit: rollbackTarget });
      await Promise.all([
        client.invalidateQueries({ queryKey: taskQuery(taskId).queryKey }),
        client.invalidateQueries({ queryKey: diffQueryKey }),
      ]);
      if (mounted()) setConfirmRollback(false);
    } catch (error) {
      if (mounted()) setRollbackError(messageOf(error));
    } finally {
      if (mounted()) setRollingBack(false);
    }
  }

  if (isPending) {
    return (
      <div role="status" aria-label="正在加载代码变更" className={cn('grid gap-3 py-2', className)}>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  const hasDiffFiles = !isError && data !== undefined && data.source !== 'none' && files.length > 0;

  if (!hasDiffFiles) {
    const fallback = fallbackChanges ?? [];
    if (fallback.length > 0) {
      return (
        <section aria-label="代码变更" className={cn('grid gap-3', className)}>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
            <Badge tone="plain">执行器报告</Badge>
            <span className="text-muted-foreground">{`共 ${fallback.length} 个文件（暂无权威 Git Diff，展示执行器上报的变更摘要）`}</span>
          </div>
          <ul className="grid gap-2">
            {fallback.map((change, idx) => (
              <li key={`${change.path}:${idx}`} className="overflow-hidden rounded-lg border border-border bg-raised">
                <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs">
                  <Badge tone={change.op === 'add' ? 'success' : change.op === 'delete' ? 'failed' : 'plain'}>
                    {change.op ? CHANGE_OP_LABEL[change.op] : '变更'}
                  </Badge>
                  <Mono className="min-w-0 flex-1 truncate">{change.path}</Mono>
                </div>
                {change.patch ? (
                  <pre className="max-h-72 overflow-x-auto bg-code p-2.5 font-mono text-xs leading-5 whitespace-pre">
                    {change.patch}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      );
    }
    return (
      <section aria-label="代码变更" className={cn('rounded-xl border border-dashed border-border-strong px-4 py-8 text-center', className)}>
        <FileDiff className="mx-auto mb-2 size-6 text-faint" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">暂无代码变更</p>
        <Note className="mt-1 text-xs">
          {!isError && data?.reason ? data.reason : '这一轮没有可展示的 Git 差异或文件变更记录。'}
        </Note>
      </section>
    );
  }

  const annotationsForLine = (path: string, line: number): LineAnnotation[] =>
    annotations.filter((ann) => ann.path === path && ann.line === line);

  return (
    <section aria-label="代码变更" className={cn('flex flex-col gap-3', className)}>
      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-xl border border-border bg-muted/50 px-3 py-2 text-xs">
        <Badge tone={data.source === 'git' ? 'running' : 'plain'}>
          {data.source === 'git' ? '权威 Git Diff' : '执行器报告'}
        </Badge>
        {data.branch ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <GitBranch className="size-3.5 flex-none" aria-hidden="true" />
            <Mono>{data.branch}</Mono>
          </span>
        ) : null}
        {data.commit ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground" title={data.commit}>
            <GitCommitHorizontal className="size-3.5 flex-none" aria-hidden="true" />
            <Mono>{data.commit.slice(0, 10)}</Mono>
          </span>
        ) : null}
        <span className="text-muted-foreground tabular-nums">{`${files.length} 个文件`}</span>
        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
          <span className="text-success-foreground">{`+${totals.additions}`}</span>
          <span className="text-failed-foreground">{`-${totals.deletions}`}</span>
        </span>
        {data.truncated ? (
          <Badge tone="waiting" className="text-2xs">内容已截断</Badge>
        ) : null}

        {distinctCheckpoints.length >= 2 ? (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {confirmRollback ? (
              <>
                <span className="text-muted-foreground">{`确认回退到 ${rollbackTarget.slice(0, 10)}？`}</span>
                <Button size="sm" variant="danger-solid" disabled={rollingBack} onClick={() => void runRollback()}>
                  {rollingBack ? '回退中…' : '确认回退'}
                </Button>
                <Button size="sm" variant="ghost" disabled={rollingBack} onClick={() => setConfirmRollback(false)}>
                  取消
                </Button>
              </>
            ) : (
              <>
                <Select
                  aria-label="选择回退检查点"
                  value={rollbackTarget}
                  onChange={(event) => setRollbackTarget(event.target.value)}
                  className="h-7 text-xs"
                >
                  {distinctCheckpoints.map((item) => (
                    <Option key={item.commit} value={item.commit}>
                      {item.label ? `${item.label} (${item.commit.slice(0, 8)})` : item.commit.slice(0, 10)}
                    </Option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!rollbackTarget || rollingBack}
                  onClick={() => setConfirmRollback(true)}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  回退检查点
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>

      {rollbackError ? <Problem role="alert">{rollbackError}</Problem> : null}

      {/* File switcher */}
      <div role="tablist" aria-label="变更文件列表" className="flex flex-wrap gap-1.5">
        {files.map((file) => {
          const active = activeFile?.path === file.path;
          const badge = FILE_STATUS_LABEL[file.status];
          const count = annotations.filter((ann) => ann.path === file.path).length;
          return (
            <button
              key={file.path}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelectedPath(file.path)}
              className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors duration-100',
                active
                  ? 'border-border-strong bg-raised font-medium text-foreground shadow-xs'
                  : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              title={file.path}
            >
              <Badge tone={badge.tone} className="px-1 py-0 text-2xs">{badge.short}</Badge>
              <span className="max-w-[220px] truncate font-mono">{file.path}</span>
              <span className="font-mono text-2xs tabular-nums text-success-foreground">{`+${file.additions}`}</span>
              <span className="font-mono text-2xs tabular-nums text-failed-foreground">{`-${file.deletions}`}</span>
              {count > 0 ? (
                <span className="rounded-full bg-brand-soft px-1.5 text-2xs font-medium text-brand-foreground tabular-nums">
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Unified diff code view */}
      {activeFile ? (
        <div className="overflow-hidden rounded-xl border border-border bg-raised">
          <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
            <Mono className="min-w-0 flex-1 truncate font-medium text-foreground">{activeFile.path}</Mono>
            <span className="flex-none font-mono tabular-nums text-muted-foreground">
              {`+${activeFile.additions} / -${activeFile.deletions}`}
            </span>
          </div>
          {parsedLines.length === 0 ? (
            <Note className="px-3 py-4 text-xs">此文件无文本补丁内容（可能是二进制文件或仅权限变更）。</Note>
          ) : (
            <div className="overflow-x-auto font-mono text-xs leading-5">
              {parsedLines.map((line) => {
                const canAnnotate = (line.kind === 'add' || line.kind === 'context') && line.newLine !== null;
                const lineNumber = line.newLine;
                const isEditingThis = Boolean(
                  canAnnotate && editing && editing.path === activeFile.path && editing.line === lineNumber,
                );
                const existing = canAnnotate && lineNumber !== null ? annotationsForLine(activeFile.path, lineNumber) : [];
                return (
                  <div key={line.key}>
                    <div
                      className={cn(
                        'group/diffline flex items-stretch border-b border-border/30 last:border-b-0',
                        line.kind === 'add' && 'bg-success-soft/50',
                        line.kind === 'del' && 'bg-failed-soft/50',
                        line.kind === 'hunk' && 'bg-muted/70 text-muted-foreground',
                        line.kind === 'meta' && 'bg-muted/40 text-faint',
                      )}
                    >
                      <span className="w-10 flex-none select-none border-r border-border/40 px-1.5 py-0.5 text-right text-2xs text-faint tabular-nums">
                        {line.oldLine ?? ''}
                      </span>
                      <span className="w-10 flex-none select-none border-r border-border/40 px-1.5 py-0.5 text-right text-2xs text-faint tabular-nums">
                        {line.newLine ?? ''}
                      </span>
                      <span className="w-4 flex-none select-none py-0.5 text-center text-muted-foreground">
                        {line.prefix}
                      </span>
                      <span className="min-w-0 flex-1 py-0.5 pr-2 whitespace-pre">
                        {line.content}
                      </span>
                      {canAnnotate && lineNumber !== null ? (
                        <button
                          type="button"
                          aria-label={`在第 ${lineNumber} 行添加批注`}
                          onClick={() => openEditor(activeFile.path, lineNumber, line.content)}
                          className="mr-1.5 my-0.5 inline-flex flex-none items-center gap-0.5 rounded px-1.5 py-0 text-2xs font-sans text-muted-foreground opacity-0 transition-opacity hover:bg-hover hover:text-foreground focus-visible:opacity-100 group-hover/diffline:opacity-100"
                        >
                          <MessageSquarePlus className="size-3" aria-hidden="true" />
                          + 批注
                        </button>
                      ) : null}
                    </div>

                    {/* Existing saved annotations on this line */}
                    {existing.map((ann) => (
                      <div
                        key={ann.id}
                        className="flex items-start gap-2 border-y border-border bg-brand-soft/20 px-3 py-2 font-sans text-xs"
                      >
                        <span className="flex-none font-mono text-2xs text-brand-foreground">{`L${ann.line}`}</span>
                        <p className="min-w-0 flex-1 whitespace-pre-wrap text-foreground">{ann.comment}</p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`删除 ${ann.path} 第 ${ann.line} 行批注`}
                          className="size-6 flex-none"
                          onClick={() => removeAnnotation(ann.id)}
                        >
                          <X className="size-3" />
                        </Button>
                      </div>
                    ))}

                    {/* Inline annotation editor right below the selected line */}
                    {isEditingThis && lineNumber !== null ? (
                      <div className="border-y border-border bg-muted/50 px-3 py-2.5 font-sans">
                        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                          <span>{`批注 ${activeFile.path}:L${lineNumber}`}</span>
                          <span className="text-2xs text-faint">Cmd/Ctrl+Enter 保存 · Esc 取消</span>
                        </div>
                        <Textarea
                          ref={editorRef}
                          rows={2}
                          aria-label={`第 ${lineNumber} 行批注内容`}
                          placeholder="写下这段代码需要修改的问题或建议…"
                          value={draftComment}
                          onChange={(event) => setDraftComment(event.target.value)}
                          onKeyDown={onEditorKeyDown}
                          className="bg-background text-sm"
                        />
                        <div className="mt-2 flex items-center justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditing(null);
                              setDraftComment('');
                            }}
                          >
                            取消
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            disabled={!draftComment.trim()}
                            onClick={saveAnnotation}
                          >
                            保存批注
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* Sticky bottom draft tray */}
      {annotations.length > 0 ? (
        <div
          role="region"
          aria-label="批注草稿箱"
          className="sticky bottom-0 z-10 grid gap-2.5 rounded-xl border border-border-strong bg-raised p-3 shadow-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              {`已暂存 ${annotations.length} 条行级批注`}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setAnnotations([])}
            >
              清空全部
            </Button>
          </div>

          {isStale ? (
            <Callout tone="waiting" role="alert" className="grid gap-2 py-2 text-xs">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 flex-none text-waiting-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">代码提交已变化，批注可能已过期</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {`批注写于 ${staleAnnotation.commit?.slice(0, 10) ?? ''}，当前提交为 ${currentCommit?.slice(0, 10) ?? ''}。请先刷新基线或确认仍按当前内容发送。`}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 pl-6">
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-foreground">
                  <input
                    type="checkbox"
                    checked={staleConfirmed}
                    onChange={(event) => setStaleConfirmed(event.target.checked)}
                  />
                  确认内容仍适用并发送
                </label>
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={rebaseAnnotationsToCurrent}>
                  更新为当前提交基线
                </Button>
              </div>
            </Callout>
          ) : null}

          <ul className="grid max-h-36 gap-1.5 overflow-y-auto text-xs">
            {annotations.map((ann) => (
              <li
                key={ann.id}
                className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <Mono className="text-2xs text-muted-foreground">{`${ann.path}:L${ann.line}`}</Mono>
                  <p className="mt-0.5 truncate text-foreground" title={ann.comment}>{ann.comment}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`移除批注 ${ann.path}:L${ann.line}`}
                  className="size-6 flex-none"
                  onClick={() => removeAnnotation(ann.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </li>
            ))}
          </ul>

          {submitError ? <Problem role="alert">{submitError}</Problem> : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={submitting || (isStale && !staleConfirmed)}
              onClick={() => void submitAnnotations()}
            >
              <Send className="size-3.5" aria-hidden="true" />
              {submitting ? '发送中…' : '打包发送给当前线程返工'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
