// A work as one row of a list, wherever works are listed: its dot, its title, the sentence
// the service makes of where it stands, and — when it has tasks under it — a strip with one
// segment per task, so how far along it is reads without opening it.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { taskLine } from '@shared/labels.ts';
import { StatusDot, toneOf, type Tone } from '@/components/bits';
import { useI18n } from '@/lib/i18n';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';

const SEGMENTS: Record<Tone, string> = { running: 'bg-running', waiting: 'bg-waiting', failed: 'bg-failed', success: 'bg-success', ended: 'bg-ended' };

export const workPath = (id: string): string => `/work/${encodeURIComponent(id)}`;
export const taskPath = (id: string): string => `/task/${encodeURIComponent(id)}`;

const MAX_INDIVIDUAL_SEGMENTS = 16;
const TONE_ORDER: readonly Tone[] = ['success', 'running', 'waiting', 'failed', 'ended'];

export function Progress({ tasks, className }: { tasks: readonly Task[]; className?: string }) {
  const { t } = useI18n();
  if (!tasks.length) return null;
  const label = t('tsk.workRow.progress', { done: tasks.filter((child) => child.state === 'done').length, total: tasks.length });

  if (tasks.length > MAX_INDIVIDUAL_SEGMENTS) {
    const counts = new Map<Tone, number>();
    for (const child of tasks) {
      const tone = toneOf(child.state);
      counts.set(tone, (counts.get(tone) ?? 0) + 1);
    }
    return (
      <span
        role="img"
        aria-label={label}
        className={cn('flex h-1 w-16 flex-none overflow-hidden rounded-full bg-muted', className)}
      >
        {TONE_ORDER.map((tone) => {
          const count = counts.get(tone) ?? 0;
          if (count === 0) return null;
          return (
            <span
              key={tone}
              data-tone={tone}
              style={{ flexGrow: count }}
              className={cn('h-full min-w-0', SEGMENTS[tone])}
            />
          );
        })}
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={label}
      className={cn('flex h-1 w-16 flex-none gap-0.5 overflow-hidden', className)}
    >
      {tasks.map((child) => (
        <span key={child.id} data-tone={toneOf(child.state)} title={t('tsk.workRow.childTitle', { title: child.title, line: taskLine(child) })} className={cn('min-w-0 flex-1 rounded-full', SEGMENTS[toneOf(child.state)])} />
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
  useI18n();
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
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
          {project ? <span title={project} className="hidden max-w-[14ch] flex-none truncate rounded-xs bg-muted px-1 text-2xs text-muted-foreground group-hover/row:bg-hover sm:inline">{project}</span> : null}
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
