// First-glance "who is doing this" identity strip for a Task: shows role · tier,
// executing login @ machine (or 待派发), and notable placement badges without expanding details.
import { parseLoginName } from '@shared/logins.ts';
import { tierLabel } from '@shared/tiers.ts';
import type { TaskAssignment, TaskPage } from '@/lib/types';
import { cn } from '@/lib/utils';

const NOTABLE_PLACEMENT: Record<string, string> = {
  pinned: '手工指定',
  spread: '审阅分散',
  prefer: '负责人优先',
};

function formatActor(assignment: TaskAssignment): { text: string; pending: boolean } {
  const rawLogin = assignment.login_name?.trim() || null;
  const rawMachine = assignment.machine_name?.trim() || null;

  if (rawLogin) {
    const parsed = parseLoginName(rawLogin);
    if (parsed.kind === 'machine') {
      const machine = rawMachine ?? parsed.machine;
      return { text: machine ? `${parsed.executor} @ ${machine}` : parsed.executor, pending: false };
    }
    return { text: rawMachine ? `${parsed.account} @ ${rawMachine}` : parsed.account, pending: false };
  }

  if (rawMachine) {
    return { text: `@ ${rawMachine}`, pending: false };
  }

  return { text: '待派发', pending: true };
}

function formatRoleTier(assignment: TaskAssignment): string | null {
  const parts = [
    assignment.role_name?.trim() || null,
    assignment.tier ? tierLabel(assignment.tier) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatAssignmentSummary(
  assignment: TaskAssignment | null | undefined,
  options?: { showLiveLabel?: boolean },
): string | null {
  if (!assignment) return null;
  const roleTier = formatRoleTier(assignment);
  const actor = formatActor(assignment);
  const placement = assignment.placed_by ? NOTABLE_PLACEMENT[assignment.placed_by] ?? null : null;

  if (!roleTier && actor.pending && !placement) return null;

  const prefix = options?.showLiveLabel && !assignment.is_live ? '上轮：' : '';
  const parts = [roleTier, actor.text, placement].filter((part): part is string => Boolean(part));
  return `${prefix}${parts.join(' · ')}`;
}

export function synthesizeTaskAssignment(data: TaskPage): TaskAssignment | null {
  if (data.task.assignment) return data.task.assignment;
  const latestRun = data.runs.at(-1);
  const roleName = data.role?.name ?? null;
  const tier = data.task.tier ?? null;
  const loginName = data.dispatch_info?.latest_login ?? latestRun?.login_name ?? data.task.login_name ?? null;
  const machineName = data.dispatch_info?.latest_machine ?? latestRun?.machine_id ?? latestRun?.host ?? null;

  if (!roleName && !tier && !loginName && !machineName) return null;

  const isLive = latestRun
    ? latestRun.state !== 'ended'
    : data.task.state === 'running' || data.task.state === 'stopping' || data.task.state === 'queued';

  return {
    role_id: data.task.role_id ?? null,
    role_name: roleName,
    tier,
    tier_source: data.task.tier_source ?? null,
    login_name: loginName,
    executor: latestRun?.executor ?? null,
    machine_name: machineName,
    placed_by: latestRun?.placed_by ?? null,
    is_live: isLive,
  };
}

export function TaskIdentityStrip({
  assignment,
  compact = false,
  showLiveLabel = false,
  className,
}: {
  assignment: TaskAssignment | null | undefined;
  compact?: boolean;
  showLiveLabel?: boolean;
  className?: string;
}) {
  if (!assignment) return null;
  const roleTier = formatRoleTier(assignment);
  const actor = formatActor(assignment);
  const placement = assignment.placed_by ? NOTABLE_PLACEMENT[assignment.placed_by] ?? null : null;

  if (!roleTier && actor.pending && !placement) return null;

  const summary = formatAssignmentSummary(assignment, { showLiveLabel }) ?? undefined;

  return (
    <span
      data-slot="task-identity-strip"
      title={summary}
      className={cn(
        'flex min-w-0 max-w-full flex-wrap items-center gap-1 text-2xs leading-4 text-muted-foreground',
        compact && 'flex-nowrap overflow-hidden',
        className,
      )}
    >
      {showLiveLabel && !assignment.is_live ? (
        <span className="flex-none text-faint">上轮：</span>
      ) : null}
      {roleTier ? (
        <span
          className={cn(
            'inline-flex flex-none items-center rounded-sm border border-border/80 bg-muted/75 px-1.5 py-px font-medium text-foreground/85 whitespace-nowrap',
            compact && 'px-1',
          )}
        >
          {roleTier}
        </span>
      ) : null}
      <span
        className={cn(
          'inline-flex min-w-0 items-center rounded-sm border px-1.5 py-px font-mono whitespace-nowrap',
          compact && 'px-1',
          actor.pending
            ? 'border-dashed border-border text-faint'
            : 'border-border/70 bg-background/80 text-muted-foreground',
        )}
      >
        <span className="min-w-0 truncate">{actor.text}</span>
      </span>
      {placement ? (
        <span
          className={cn(
            'inline-flex flex-none items-center rounded-sm border border-brand-border/70 bg-brand-soft/60 px-1.5 py-px font-medium text-brand-foreground whitespace-nowrap',
            compact && 'px-1',
          )}
        >
          {placement}
        </span>
      ) : null}
    </span>
  );
}
