// A conversation with a Router as the rows it is drawn from (lib/conversation.ts): the
// owner's messages on the right, the Router's replies as written text on the left, what
// happened in between as one gray line, the tasks a turn made, and the questions asked.
import { AppWindow, Download, Paperclip, Sparkles, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ACTION_TEXT, taskLine } from '@shared/labels.ts';
import { formatTime, fullTime } from '@shared/time.ts';
import { ApprovalCard } from '@/components/approval-card';
import { ArtifactFrame, ImageLightbox } from '@/components/artifact-preview';
import { Callout, Chevron, Rows, StateBadge, StatusDot, Time } from '@/components/bits';
import { Markdown } from '@/components/markdown';
import { formatFileSize } from '@/components/project-files';
import { RouterTrajectory } from '@/components/router-trajectory';
import { TaskIdentityStrip } from '@/components/task-identity-strip';
import { Sheet, SheetContent } from '@/components/ui/dialog';
import { taskPath } from '@/components/work-row';
import { projectFileRawUrl } from '@/lib/api';
import type { Item } from '@/lib/conversation';
import type { ProjectFileSummary, Task } from '@/lib/types';
import { cn } from '@/lib/utils';

// When something was said. It is there for anyone who hovers, focuses or presses it, and
// out of the way otherwise: a wall of clock times makes a conversation harder to read.
function Stamp({ at, className }: { at?: string | undefined; className?: string }) {
  const [shown, setShown] = useState(false);
  if (!at) return null;
  return (
    <button
      type="button"
      aria-label={`时间：${fullTime(at)}`}
      aria-pressed={shown}
      onClick={() => setShown((visible) => !visible)}
      className={cn(
        'rounded-xs px-1 text-2xs text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100',
        shown && 'opacity-100',
        className,
      )}
    >
      <time dateTime={at} title={fullTime(at)}>{formatTime(at)}</time>
    </button>
  );
}

function DateLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 py-1 text-2xs text-faint" role="separator">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      {text}
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

// The Router's side is marked with a small sign and its name, so a long conversation is
// told apart at a glance; the owner's side is the block on the right.
function Speaker() {
  return (
    <span aria-hidden="true" className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-md bg-primary text-primary-foreground">
      <Sparkles className="size-3.5" strokeWidth={2} />
    </span>
  );
}

const TYCHO_FILE_REF = /tycho-file:\/\/([A-Za-z0-9_-]{1,64})/g;
const PROJECT_FILE_RAW_REF = /\/api\/projects\/[^/]+\/files\/([A-Za-z0-9_-]{1,64})\/raw/g;

function citedFileIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(TYCHO_FILE_REF)) {
    if (match[1]) ids.add(match[1]);
  }
  for (const match of text.matchAll(PROJECT_FILE_RAW_REF)) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

function isArtifactAttachment(file: ProjectFileSummary): boolean {
  return file.previewable && (!file.is_image || /svg/i.test(file.mime));
}

function ImageAttachmentThumb({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFileSummary;
}) {
  const [open, setOpen] = useState(false);
  const src = projectFileRawUrl(projectId, file.id);

  return (
    <>
      <button
        type="button"
        aria-label={`查看图片：${file.name}`}
        onClick={() => setOpen(true)}
        className="inline-block cursor-zoom-in overflow-hidden rounded-lg border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <img
          src={src}
          alt={file.name}
          className="h-28 max-w-[220px] rounded-lg border border-border/60 object-cover"
        />
      </button>
      <ImageLightbox src={src} alt={file.name} open={open} onOpenChange={setOpen} />
    </>
  );
}

function FileAttachmentChip({
  projectId,
  file,
  onPreviewArtifact,
}: {
  projectId: string;
  file: ProjectFileSummary;
  onPreviewArtifact?: (file: ProjectFileSummary) => void;
}) {
  const downloadUrl = projectFileRawUrl(projectId, file.id, true);
  const previewable = isArtifactAttachment(file);
  const Icon = previewable ? AppWindow : Paperclip;

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1 text-xs text-foreground">
      {previewable && onPreviewArtifact ? (
        <button
          type="button"
          onClick={() => onPreviewArtifact(file)}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-foreground hover:text-brand-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Icon className="size-3.5 flex-none text-brand-foreground" aria-hidden="true" />
          <span className="max-w-[180px] truncate font-medium">{file.name}</span>
          <span className="flex-none text-2xs text-muted-foreground tabular-nums">{formatFileSize(file.size)}</span>
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Icon className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
          <span className="max-w-[180px] truncate font-medium">{file.name}</span>
          <span className="flex-none text-2xs text-muted-foreground tabular-nums">{formatFileSize(file.size)}</span>
        </span>
      )}
      <a
        href={downloadUrl}
        download={file.name}
        aria-label={`下载 ${file.name}`}
        className="inline-flex size-5 flex-none items-center justify-center rounded-xs text-muted-foreground no-underline hover:bg-hover hover:text-foreground"
      >
        <Download className="size-3" aria-hidden="true" />
      </a>
    </span>
  );
}

function MineAttachments({
  attachments,
  projectId,
}: {
  attachments: readonly ProjectFileSummary[];
  projectId?: string;
}) {
  const [artifactFile, setArtifactFile] = useState<ProjectFileSummary | null>(null);
  const images = attachments.filter((file) => file.is_image && !isArtifactAttachment(file));
  const files = attachments.filter((file) => !file.is_image || isArtifactAttachment(file));

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        {images.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((file) => (
              <ImageAttachmentThumb
                key={file.id}
                projectId={projectId ?? file.project_id}
                file={file}
              />
            ))}
          </div>
        ) : null}
        {files.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {files.map((file) => (
              <FileAttachmentChip
                key={file.id}
                projectId={projectId ?? file.project_id}
                file={file}
                onPreviewArtifact={setArtifactFile}
              />
            ))}
          </div>
        ) : null}
      </div>

      <Sheet open={artifactFile !== null} onOpenChange={(next) => { if (!next) setArtifactFile(null); }}>
        {artifactFile ? (
          <SheetContent
            title={artifactFile.name}
            className="w-[min(960px,95vw)] max-w-none"
            bodyClassName="flex flex-col p-0"
          >
            <ArtifactFrame
              projectId={projectId ?? artifactFile.project_id}
              fileId={artifactFile.id}
              title={artifactFile.name}
              mime={artifactFile.mime}
              mode="sheet"
            />
          </SheetContent>
        ) : null}
      </Sheet>
    </>
  );
}

function ReplyAttachments({
  attachments,
  text,
  projectId,
}: {
  attachments: readonly ProjectFileSummary[];
  text: string;
  projectId?: string;
}) {
  const cited = citedFileIds(text);
  const remaining = attachments.filter((file) => !cited.has(file.id));
  if (remaining.length === 0) return null;

  const artifacts = remaining.filter(isArtifactAttachment);
  const images = remaining.filter((file) => file.is_image && !isArtifactAttachment(file));
  const others = remaining.filter((file) => !file.is_image && !isArtifactAttachment(file));

  return (
    <div className="mt-2 flex flex-col gap-2">
      {artifacts.map((file) => (
        <ArtifactFrame
          key={file.id}
          projectId={projectId ?? file.project_id}
          fileId={file.id}
          title={file.name}
          mime={file.mime}
          mode="inline"
        />
      ))}
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {images.map((file) => (
            <ImageAttachmentThumb
              key={file.id}
              projectId={projectId ?? file.project_id}
              file={file}
            />
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {others.map((file) => (
            <FileAttachmentChip
              key={file.id}
              projectId={projectId ?? file.project_id}
              file={file}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function isTaskResumable(task: Task): boolean {
  return task.resumable === true;
}

export function ItemView({ item, empty, projectId, onSelectTask, liveTasks }: {
  item: Item;
  empty?: ReactNode;
  projectId?: string;
  onSelectTask?: (taskId: string) => void;
  liveTasks?: ReadonlyMap<string, Task>;
}) {
  switch (item.kind) {
    case 'date':
      return <DateLine text={item.text} />;
    case 'mine':
      return (
        <div className="group flex flex-col items-end gap-0.5">
          {item.attachments?.length ? (
            <div className="flex max-w-[82%] flex-col items-end gap-1.5">
              <MineAttachments attachments={item.attachments} projectId={projectId} />
              {item.text ? (
                <div className="rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 wrap-anywhere whitespace-pre-wrap">{item.text}</div>
              ) : null}
            </div>
          ) : (
            <div className="max-w-[82%] rounded-2xl rounded-br-md bg-bubble px-3.5 py-2 wrap-anywhere whitespace-pre-wrap">{item.text}</div>
          )}
          <div className="flex items-center gap-2"><Stamp at={item.at} />{item.messageId ? <RouterTrajectory messageId={item.messageId} /> : null}</div>
        </div>
      );
    case 'note':
      return (
        <div className="group flex items-start gap-2 pl-0.5 text-xs text-muted-foreground wrap-anywhere">
          <Zap className="mt-[3px] size-3 flex-none text-faint" aria-hidden="true" />
          <span className="min-w-0">{item.text}</span>
          {item.messageId ? <RouterTrajectory messageId={item.messageId} /> : null}
          <Stamp at={item.at} className="flex-none" />
        </div>
      );
    case 'reply':
      return (
        <div id={`reply-${item.id}`} className="group flex gap-3">
          <Speaker />
          <div className="min-w-0 flex-1">
            <p className="flex min-h-7 items-center gap-1 text-xs font-medium text-muted-foreground">负责人<Stamp at={item.at} className="font-normal" /></p>
            <Markdown text={item.text} projectId={projectId} files={item.attachments} />
            {item.attachments?.length ? (
              <ReplyAttachments attachments={item.attachments} text={item.text} projectId={projectId} />
            ) : null}
            {item.incomplete ? <p className="mt-1 text-sm text-muted-foreground">回复没有写完</p> : null}
          </div>
        </div>
      );
    case 'unverified':
      return (
        <Callout tone="plain" title="该请求未完成，已提交的操作如下" className="group" action={<Stamp at={item.at} />}>
          {item.changes === null ? (
            <p className="mt-1 text-muted-foreground">已提交的操作没有读到，不知道有没有</p>
          ) : item.changes.length ? (
            <ul className="mt-1 list-disc pl-[18px] text-muted-foreground">
              {item.changes.map((change, index) => <li key={index}><Time at={change.at} />{` ${ACTION_TEXT[change.action] ?? change.action}`}</li>)}
            </ul>
          ) : <p className="mt-1 text-muted-foreground">没有已提交的操作</p>}
        </Callout>
      );
    case 'capsules':
      return (
        <Rows className="ml-9">
          {item.tasks.map((task) => {
            const live = liveTasks?.get(task.id);
            const state = live?.state ?? task.state;
            const dotState = live?.summary?.dot ?? state;
            const title = live?.title || task.title;
            const line = live ? taskLine(live) : '';
            const resumable = live?.state === 'done' && isTaskResumable(live);
            const toneBorder = dotState === 'held' || dotState === 'failed'
              ? 'border-l-failed'
              : dotState === 'waiting_person' || dotState === 'ready'
                ? 'border-l-waiting'
                : dotState === 'running' || dotState === 'stopping'
                  ? 'border-l-running'
                  : dotState === 'done'
                    ? 'border-l-success'
                    : 'border-l-border-strong';
            const cardClassName = cn(
              'group/card flex w-full flex-col gap-0.5 border-l-2 px-3 py-2 text-left text-sm no-underline transition-colors duration-100 hover:bg-muted focus-visible:-outline-offset-2',
              toneBorder,
            );
            const content = (
              <>
                <span className="flex min-h-6 w-full items-center gap-2.5">
                  <StatusDot state={dotState} />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
                  <StateBadge state={state} />
                  {resumable ? (
                    <span className="inline-flex flex-none items-center rounded-full border border-brand-border bg-brand-soft px-1.5 py-px text-2xs leading-4 font-medium text-brand-foreground">
                      可续接
                    </span>
                  ) : null}
                  <Chevron className="transition-transform duration-100 group-hover/card:translate-x-0.5" />
                </span>
                {live?.assignment ? (
                  <TaskIdentityStrip
                    assignment={live.assignment}
                    compact
                    showLiveLabel
                    className="pl-[26px]"
                  />
                ) : null}
                {line ? (
                  <span className="block truncate pl-[26px] text-xs text-muted-foreground" title={line}>
                    {line}
                  </span>
                ) : null}
              </>
            );
            if (onSelectTask) {
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onSelectTask(task.id)}
                  className={cn(cardClassName, 'cursor-pointer')}
                >
                  {content}
                </button>
              );
            }
            return (
              <Link key={task.id} to={taskPath(task.id)} className={cardClassName}>
                {content}
              </Link>
            );
          })}
        </Rows>
      );
    case 'card':
      return (
        <div className="group ml-9">
          <ApprovalCard card={item.card} />
          <Stamp at={item.at} />
        </div>
      );
    case 'empty':
      return <>{empty}</>;
  }
}
