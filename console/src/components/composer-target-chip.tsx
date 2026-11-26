// Quiet pill chip for project/task composers showing the active Router account or
// Worker login pool, with an upward popover for live quota visibility & 1-click Router switching.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronUp, Cpu, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { formatTime } from '@shared/time.ts';
import {
  collectIndividualQuotaLogins,
  formatResetCountdown,
  QuotaMiniBars,
  standingBadgeOf,
  type QuotaLoginItem,
} from '@/components/account-quota-popover';
import { Dot, Mono } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { messageOf, put } from '@/lib/api';
import { withProject } from '@/lib/projects';
import { accountsQuery, PAGE, projectsQuery } from '@/lib/queries';
import type { Project } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface ComposerTargetChipProps {
  mode: 'project' | 'task';
  projectId?: string | null;
  currentLogin?: string | null;
  currentMachine?: string | null;
  compact?: boolean;
}

function chipToneOf(item: QuotaLoginItem | null, fallbackAvailable = true): 'success' | 'waiting' | 'failed' | 'ended' {
  if (!item) return fallbackAvailable ? 'success' : 'waiting';
  if (item.needsRelogin || item.resting || item.tightestRemaining === 0) return 'failed';
  if (item.tightestRemaining !== null && item.tightestRemaining <= 20) return 'waiting';
  return 'success';
}

export function ComposerTargetChip({
  mode,
  projectId,
  currentLogin,
  currentMachine,
  compact = false,
}: ComposerTargetChipProps) {
  const client = useQueryClient();
  const { data: accountsData, isError: accountsError } = useQuery({ ...accountsQuery, retry: false });
  const { data: projects } = useQuery({ ...projectsQuery, retry: false });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allLogins = useMemo(() => collectIndividualQuotaLogins(accountsData), [accountsData]);

  const project = useMemo(
    () => (projectId ? (projects ?? []).find((item) => item.id === projectId) ?? null : null),
    [projects, projectId],
  );

  const controllerLogins = useMemo(
    () => allLogins.filter((item) => item.canRoute),
    [allLogins],
  );

  const eligibleWorkerLogins = useMemo(() => {
    if (!project || project.login_mode !== 'selected') return allLogins;
    const allowed = new Set(project.logins);
    return allLogins.filter((item) => allowed.has(item.id));
  }, [allLogins, project]);

  if (accountsError || !accountsData || allLogins.length === 0) return null;

  if (mode === 'project') {
    const activeRouterId = project ? (project.router?.account ?? null) : (currentLogin ?? null);
    const activeLogin = activeRouterId
      ? controllerLogins.find((item) => item.id === activeRouterId)
        ?? allLogins.find((item) => item.id === activeRouterId || item.name === activeRouterId)
        ?? null
      : null;

    const remainingSuffix = activeLogin && activeLogin.tightestRemaining !== null
      ? ` · 剩 ${activeLogin.tightestRemaining}%`
      : '';
    const chipLabel = activeRouterId === null
      ? '负责人 · 服务默认'
      : `负责人 · ${activeLogin?.name ?? activeRouterId}${remainingSuffix}`;
    const dotTone = activeLogin ? chipToneOf(activeLogin) : 'ended';
    const canSwitch = Boolean(project);

    async function switchRouter(nextAccountId: string | null): Promise<void> {
      if (!project || saving) return;
      if (nextAccountId === (project.router?.account ?? null)) {
        setOpen(false);
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const answer = await put<{ project: Project }>(
          `/api/projects/${encodeURIComponent(project.id)}`,
          { router: { account: nextAccountId, tier: null } },
        );
        if (answer?.project) {
          client.setQueryData<Project[]>(projectsQuery.queryKey, (prev) =>
            prev ? withProject(prev, answer.project) : [answer.project],
          );
        }
        await Promise.all([
          client.invalidateQueries({ queryKey: projectsQuery.queryKey }),
          client.invalidateQueries({ queryKey: [PAGE] }),
        ]);
        setOpen(false);
      } catch (failure) {
        setError(messageOf(failure));
      } finally {
        setSaving(false);
      }
    }

    return (
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setError(null); }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-slot="composer-target-chip"
            data-mode="project"
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-full border transition-colors duration-100',
              compact ? 'min-h-6 px-2 py-0.5 text-2xs' : 'min-h-7 px-2.5 py-1 text-xs',
              dotTone === 'failed'
                ? 'border-failed-border bg-failed-soft/60 text-foreground hover:bg-failed-soft'
                : dotTone === 'waiting'
                  ? 'border-waiting-border bg-waiting-soft/75 text-waiting-foreground hover:bg-waiting-soft'
                  : 'border-border bg-muted/70 text-muted-foreground hover:bg-hover hover:text-foreground',
            )}
          >
            <Dot tone={dotTone} pulse={false} className="size-1.5" />
            <span className="truncate font-medium tabular-nums">{chipLabel}</span>
            <ChevronUp
              aria-hidden="true"
              className={cn('size-3 flex-none text-faint transition-transform duration-150', open && 'rotate-180')}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          aria-label="选择项目负责人账号"
          className="w-[310px] overflow-hidden p-0"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
              项目负责人账号
            </span>
            <span className="text-2xs text-faint">下一条消息生效</span>
          </div>

          <div className="max-h-[300px] divide-y divide-border/70 overflow-y-auto p-1">
            <button
              type="button"
              disabled={!canSwitch || saving}
              aria-pressed={activeRouterId === null}
              onClick={() => void switchRouter(null)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                activeRouterId === null
                  ? 'bg-brand-soft/60 font-medium text-foreground'
                  : 'text-foreground hover:bg-hover',
                (!canSwitch || saving) && 'opacity-60',
              )}
            >
              <span className="grid gap-0.5">
                <span>沿用服务默认</span>
                <span className="text-2xs font-normal text-muted-foreground">由全局负责人设置决定</span>
              </span>
              {activeRouterId === null ? <Check className="size-3.5 flex-none text-primary" aria-hidden="true" /> : null}
            </button>

            {controllerLogins.map((item) => {
              const selected = activeRouterId === item.id;
              const standing = standingBadgeOf(item);
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={!canSwitch || saving}
                  aria-pressed={selected}
                  onClick={() => void switchRouter(item.id)}
                  className={cn(
                    'grid w-full gap-1.5 rounded-md px-2.5 py-2 text-left text-xs transition-colors',
                    selected
                      ? 'bg-brand-soft/60 text-foreground'
                      : 'text-foreground hover:bg-hover',
                    (!canSwitch || saving) && 'opacity-60',
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                    <Mono className="flex-none rounded bg-hover px-1 py-px text-2xs text-muted-foreground">
                      {item.providerLabel}
                    </Mono>
                    <Badge tone={standing.tone} className="min-h-4 flex-none px-1.5 py-0 text-2xs leading-4">
                      {standing.label}
                    </Badge>
                    {selected ? <Check className="size-3.5 flex-none text-primary" aria-hidden="true" /> : null}
                  </span>
                  <QuotaMiniBars item={item} compact />
                </button>
              );
            })}
          </div>

          {error ? (
            <p role="alert" className="border-t border-failed-border bg-failed-soft/70 px-3 py-1.5 text-2xs text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between border-t border-border bg-muted/40 px-3 py-2 text-2xs">
            <span className="text-faint">{saving ? '切换中…' : `${controllerLogins.length} 个可用负责人`}</span>
            <Link
              to={projectId ? `/projects/${encodeURIComponent(projectId)}/settings` : '/accounts'}
              onClick={() => setOpen(false)}
              className="font-medium text-link no-underline hover:underline"
            >
              {projectId ? '更多项目设置 →' : '管理全部账号 →'}
            </Link>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // mode === 'task'
  const matchedLogin = currentLogin
    ? eligibleWorkerLogins.find((item) => item.id === currentLogin || item.name === currentLogin)
      ?? allLogins.find((item) => item.id === currentLogin || item.name === currentLogin)
      ?? null
    : null;
  const availableLogins = eligibleWorkerLogins.filter((item) => !item.needsRelogin && !item.resting);
  const availableCount = availableLogins.length;

  const taskChipParts: string[] = [];
  if (currentLogin) {
    taskChipParts.push(matchedLogin?.name ?? currentLogin);
    if (currentMachine) taskChipParts.push(currentMachine);
    if (matchedLogin && matchedLogin.tightestRemaining !== null) {
      taskChipParts.push(`剩 ${matchedLogin.tightestRemaining}%`);
    }
  } else {
    taskChipParts.push(`自动选号 · ${availableCount} 个可用`);
  }
  const taskChipLabel = taskChipParts.join(' · ');
  const taskDotTone = currentLogin
    ? chipToneOf(matchedLogin, availableCount > 0)
    : availableCount > 0
      ? 'success'
      : 'failed';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="composer-target-chip"
          data-mode="task"
          className={cn(
            'inline-flex max-w-full items-center gap-1.5 rounded-full border transition-colors duration-100',
            compact ? 'min-h-6 px-2 py-0.5 text-2xs' : 'min-h-7 px-2.5 py-1 text-xs',
            taskDotTone === 'failed'
              ? 'border-failed-border bg-failed-soft/60 text-foreground hover:bg-failed-soft'
              : taskDotTone === 'waiting'
                ? 'border-waiting-border bg-waiting-soft/75 text-waiting-foreground hover:bg-waiting-soft'
                : 'border-border bg-muted/70 text-muted-foreground hover:bg-hover hover:text-foreground',
          )}
        >
          <Dot tone={taskDotTone} pulse={false} className="size-1.5" />
          <span className="truncate font-medium tabular-nums">{taskChipLabel}</span>
          <ChevronUp
            aria-hidden="true"
            className={cn('size-3 flex-none text-faint transition-transform duration-150', open && 'rotate-180')}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        aria-label="项目执行登录池"
        className="w-[310px] overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Cpu className="size-3.5 text-primary" aria-hidden="true" />
            可用执行登录
          </span>
          <span className="text-2xs text-faint tabular-nums">
            {availableCount}/{eligibleWorkerLogins.length} 可用
          </span>
        </div>

        <div className="max-h-[300px] divide-y divide-border/70 overflow-y-auto">
          {eligibleWorkerLogins.length > 0 ? eligibleWorkerLogins.map((item) => {
            const standing = standingBadgeOf(item);
            const isCurrent = Boolean(currentLogin && (item.id === currentLogin || item.name === currentLogin));
            const restCountdown = formatResetCountdown(item.restUntil);
            return (
              <div
                key={item.key}
                className={cn('grid gap-1.5 px-3 py-2.5', isCurrent && 'bg-brand-soft/35')}
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={item.name}>
                    {item.name}
                  </span>
                  {isCurrent ? (
                    <Badge tone="running" className="min-h-4 flex-none px-1.5 py-0 text-2xs leading-4">
                      当前
                    </Badge>
                  ) : null}
                  <Mono className="flex-none rounded bg-hover px-1 py-px text-2xs text-muted-foreground">
                    {item.providerLabel}
                  </Mono>
                  <Badge tone={standing.tone} className="min-h-4 flex-none px-1.5 py-0 text-2xs leading-4">
                    {standing.label}
                  </Badge>
                </div>

                {item.resting && item.restUntil && (item.fiveHour || item.sevenDay) ? (
                  <p className="text-2xs text-waiting-foreground tabular-nums">
                    休眠至 {formatTime(item.restUntil)}{restCountdown ? `（${restCountdown}）` : ''}
                  </p>
                ) : null}

                <QuotaMiniBars item={item} compact />
              </div>
            );
          }) : (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              当前项目未选择可用登录。
            </p>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-border bg-muted/40 px-3 py-2">
          <Link
            to={projectId ? `/projects/${encodeURIComponent(projectId)}/settings` : '/accounts'}
            onClick={() => setOpen(false)}
            className="text-xs font-medium text-link no-underline hover:underline"
          >
            {projectId ? '调整项目登录池 →' : '管理全部账号 →'}
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
