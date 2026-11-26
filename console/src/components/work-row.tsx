// A work as one row of a list, wherever works are listed: its dot, its title, the sentence
// the service makes of where it stands, and — when it has tasks under it — a strip with one
// segment per task, so how far along it is reads without opening it.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { taskLine } from '@shared/labels.ts';
import { StatusDot, toneOf, type Tone } from '@/components/bits';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';

const SEGMENTS: Record<Tone, string> = { running: 'bg-running', waiting: 'bg-waiting', failed: 'bg-failed', success: 'bg-success', ended: 'bg-ended' };

export const workPath = (id: string): string => `/work/${encodeURIComponent(id)}`;
export const taskPath = (id: string): string => `/task/${encodeURIComponent(id)}`;

export function Progress({ tasks, className }: { tasks: readonly Task[]; className?: string }) {
  if (!tasks.length) return null;
  return (
    <span
      role="img"
      aria-label={`子任务进度，${tasks.filter((child) => child.state === 'done').length}/${tasks.length} 已完成`}
      className={cn('flex h-1 w-16 flex-none gap-0.5', className)}
    >
      {tasks.map((child) => (
        <span key={child.id} data-tone={toneOf(child.state)} title={`${child.title}：${taskLine(child)}`} className={cn('min-w-0.5 flex-1 rounded-full', SEGMENTS[toneOf(child.state)])} />
      ))}
    </span>
  );
}

export function WorkRow({ task, children = [], to, onSelect, selected = false, project, meta, dense = false, className }: {
  task: Task;
  // The tasks under it, when the list knows them.
  children?: readonly Task[];
  to?: string;
  // When provided, renders a button that selects the task in-place instead of full-page navigation.
  onSelect?: (taskId: string) => void;
  selected?: boolean;
  // The project's name, on a list that mixes projects.
  project?: string | undefined;
  // What stands at the row's end: a time, most often.
  meta?: ReactNode;
  dense?: boolean;
  className?: string;
}) {
  const line = taskLine(task);
  const rowClassName = cn(
    'group/row flex items-start gap-2.5 px-3 text-sm no-underline transition-colors duration-100 hover:bg-muted focus-visible:-outline-offset-2',
    dense ? 'py-2' : 'py-2.5',
    selected && 'bg-brand-soft text-foreground hover:bg-brand-soft',
    className,
  );
  const content = (
    <>
      <StatusDot state={task.summary?.dot ?? task.state} className="mt-[3px]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate font-medium">{task.title}</span>
          {project ? <span className="hidden flex-none rounded-xs bg-muted px-1 text-2xs text-muted-foreground group-hover/row:bg-hover sm:inline">{project}</span> : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground" title={line}>{line}</span>
      </span>
      <span className="flex flex-none flex-col items-end gap-1.5 pt-0.5 text-xs text-faint">
        {meta}
        <Progress tasks={children} />
      </span>
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        onClick={() => onSelect(task.id)}
        className={cn('w-full cursor-pointer text-left', rowClassName)}
      >
        {content}
      </button>
    );
  }

  return (
    <Link to={to ?? workPath(task.id)} className={rowClassName}>
      {content}
    </Link>
  );
}
