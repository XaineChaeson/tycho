import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, CheckCircle2, Clock, RefreshCw, ShieldCheck, SlidersHorizontal, Terminal, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_EXECUTOR_AUTO_UPDATE_POLICY,
  highestSemver,
  isLikelyManualUpdate,
  isVersionBehind,
  jobKey,
  versionOf,
  type ExecutorAutoUpdatePolicy,
  type ExecutorFleetStatus,
  type ExecutorUpdateJobView,
} from '@shared/executor-updates.ts';
import { formatTime } from '@shared/time.ts';
import { Callout, Card, Dot, Mono, Note, Problem } from '@/components/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { messageOf, post, put } from '@/lib/api';
import { useI18n, type I18nContextValue } from '@/lib/i18n';
import { accountsQuery, executorUpdatesQuery } from '@/lib/queries';
import type { Machine } from '@/lib/types';
import { cn } from '@/lib/utils';

const EXECUTOR_ORDER = ['codex', 'claude', 'gemini', 'dsh'];
const REMOTE_INSTALLABLE = new Set(['codex', 'claude', 'gemini']);
const INTERVAL_OPTIONS = [6, 12, 24, 48, 72, 168];

function renderWithMono(template: string, value: string): ReactNode {
  const idx = template.indexOf('\u0000');
  if (idx === -1) return template;
  return <>{template.slice(0, idx)}<Mono>{value}</Mono>{template.slice(idx + 1)}</>;
}

function canRemoteInstall(exec: string): boolean {
  return REMOTE_INSTALLABLE.has(exec);
}

function shortVer(raw: string | null | undefined): string {
  if (!raw) return '—';
  return versionOf(raw) ?? raw;
}

function shortPlatform(platform: string | null | undefined): string {
  if (!platform) return '';
  const first = platform.trim().split(/\s+/)[0] ?? platform;
  if (first === 'win32') return 'Win';
  if (first === 'darwin') return 'macOS';
  if (first === 'linux') return 'Linux';
  return first;
}

function stateBadge(job: ExecutorUpdateJobView, t: I18nContextValue['t']) {
  const installing = !job.before_version;
  switch (job.state) {
    case 'waiting_idle':
      return <Badge tone="waiting" className="text-[11px]"><Clock className="mr-1 size-3" />{t('mach.cli.stateWaitingIdle')}</Badge>;
    case 'updating':
      return <Badge tone="plain" className="text-[11px]"><RefreshCw className="mr-1 size-3 animate-spin" />{installing ? t('mach.cli.stateInstalling') : t('mach.cli.stateUpdating')}</Badge>;
    case 'succeeded':
      return (
        <Badge tone="success" className="text-[11px]">
          <CheckCircle2 className="mr-1 size-3" />
          {installing && job.after_version
            ? t('mach.cli.stateInstalled', { ver: shortVer(job.after_version) })
            : job.updated
              ? t('mach.cli.stateUpgraded', { ver: shortVer(job.after_version) })
              : t('mach.cli.stateUpToDate')}
        </Badge>
      );
    case 'unsupported':
      return <Badge tone="plain" className="text-[11px] text-muted-foreground">{job.method === 'disabled' ? t('mach.cli.stateDisabled') : t('cli.manualUpdate')}</Badge>;
    case 'failed':
      return <Badge tone="failed" className="text-[11px]"><TriangleAlert className="mr-1 size-3" />{t('mach.cli.stateFailed')}</Badge>;
  }
}

export function countOutdatedCliCells(machines: Machine[], fleet: ExecutorFleetStatus | undefined): number {
  const executors = new Set<string>();
  for (const m of machines) {
    for (const e of m.node.executors?.executors ?? []) {
      if (e.installed) executors.add(e.executor);
    }
  }
  let count = 0;
  for (const exec of executors) {
    const installedVersions = machines
      .map((m) => m.node.executors?.executors.find((e) => e.executor === exec))
      .filter((s) => s?.installed)
      .map((s) => s?.version);
    const ref = fleet?.upstream[exec]?.latest ?? highestSemver(installedVersions);
    if (!ref) continue;
    for (const m of machines) {
      if (!m.node.connected) continue;
      const status = m.node.executors?.executors.find((e) => e.executor === exec);
      if (status?.installed && isVersionBehind(status.version, ref)) count += 1;
    }
  }
  return count;
}

export function ExecutorFleetPanel({ machines }: { machines: Machine[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: fleet, isPending, error } = useQuery(executorUpdatesQuery);
  const [checking, setChecking] = useState(false);
  const [triggeringKey, setTriggeringKey] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const prevSucceededRef = useRef<string | null>(null);

  // Refresh machines/accounts automatically when a background install or upgrade job succeeds
  // so newly installed CLIs and updated version badges appear without manual reload.
  useEffect(() => {
    if (!fleet) return;
    const key = fleet.jobs
      .filter((j) => j.state === 'succeeded')
      .map((j) => j.id)
      .join(',');
    if (prevSucceededRef.current !== null && key !== prevSucceededRef.current) {
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
    }
    prevSucceededRef.current = key;
  }, [fleet, queryClient]);

  const executors = useMemo(() => {
    const found = new Set<string>();
    for (const m of machines) {
      for (const e of m.node.executors?.executors ?? []) {
        if (e.installed || canRemoteInstall(e.executor)) found.add(e.executor);
      }
    }
    const list = [...found];
    list.sort((a, b) => {
      const ia = EXECUTOR_ORDER.indexOf(a);
      const ib = EXECUTOR_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    return list;
  }, [machines]);

  const refByExecutor = useMemo(() => {
    const map: Record<string, { ref: string | null; source: 'upstream' | 'fleet' | null }> = {};
    for (const exec of executors) {
      const upstreamLatest = fleet?.upstream[exec]?.latest ?? null;
      const fleetMax = highestSemver(
        machines
          .map((m) => m.node.executors?.executors.find((e) => e.executor === exec))
          .filter((s) => s?.installed)
          .map((s) => s?.version),
      );
      if (upstreamLatest && (!fleetMax || isVersionBehind(fleetMax, upstreamLatest) || versionOf(fleetMax) === versionOf(upstreamLatest))) {
        map[exec] = { ref: upstreamLatest, source: 'upstream' };
      } else if (fleetMax) {
        map[exec] = { ref: fleetMax, source: 'fleet' };
      } else {
        map[exec] = { ref: null, source: null };
      }
    }
    return map;
  }, [executors, fleet, machines]);

  const policy: ExecutorAutoUpdatePolicy = fleet?.policy ?? DEFAULT_EXECUTOR_AUTO_UPDATE_POLICY;

  async function handleCheckUpstream() {
    setChecking(true);
    setActionError(null);
    try {
      const next = await post<ExecutorFleetStatus>('/api/executors/updates/check');
      queryClient.setQueryData(executorUpdatesQuery.queryKey, next);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setChecking(false);
    }
  }

  async function handleRunUpdate(executor: string, machineIds?: string[]) {
    const key = machineIds && machineIds.length === 1 ? jobKey(machineIds[0]!, executor) : `all/${executor}`;
    setTriggeringKey(key);
    setActionError(null);
    try {
      const res = await post<{ queued: ExecutorUpdateJobView[]; status: ExecutorFleetStatus }>(
        '/api/executors/updates/run',
        { executor, ...(machineIds ? { machine_ids: machineIds } : {}) },
      );
      queryClient.setQueryData(executorUpdatesQuery.queryKey, res.status);
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setTriggeringKey(null);
    }
  }

  async function handleSavePolicy(patch: Partial<ExecutorAutoUpdatePolicy>) {
    setSavingPolicy(true);
    setActionError(null);
    const nextPolicy: ExecutorAutoUpdatePolicy = {
      ...policy,
      ...patch,
      executors: patch.executors ?? policy.executors,
    };
    try {
      const res = await put<{ policy: ExecutorAutoUpdatePolicy; status: ExecutorFleetStatus }>(
        '/api/executors/updates/policy',
        nextPolicy,
      );
      queryClient.setQueryData(executorUpdatesQuery.queryKey, res.status);
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setSavingPolicy(false);
    }
  }

  const recentJobs = fleet?.jobs ?? [];
  const activeCount = Object.values(fleet?.active_by_key ?? {}).filter(
    (j) => j.state === 'waiting_idle' || j.state === 'updating',
  ).length;
  const enabledExecs = Object.entries(policy.executors).filter(([, on]) => on).map(([k]) => k);

  return (
    <div className="grid gap-4">
      <Card className="grid gap-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">{t('cli.matrixTitle')}</h2>
              <Badge tone="plain" className="text-[11px]">
                <ShieldCheck className="mr-1 size-3 text-success" />
                {t('cli.matrixBadge')}
              </Badge>
              {activeCount > 0 ? (
                <Badge tone="waiting" className="text-[11px]">{t('mach.cli.activeRunning', { count: activeCount })}</Badge>
              ) : null}
            </div>
            <Note className="mt-0.5 text-xs">
              {t('cli.matrixDesc')}
            </Note>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" disabled={checking} onClick={() => void handleCheckUpstream()}>
              <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
              {checking ? t('cli.checking') : t('cli.checkUpstream')}
            </Button>
            <Button size="sm" variant={policyOpen ? 'primary' : 'ghost'} onClick={() => setPolicyOpen((v) => !v)}>
              <SlidersHorizontal className="size-3.5" />
              {t('cli.autoUpdate', { state: policy.enabled ? t('cli.autoUpdateOn', { count: enabledExecs.length }) : t('cli.autoUpdateOff') })}
            </Button>
          </div>
        </div>

        {error ? <Problem role="alert">{messageOf(error)}</Problem> : null}
        {actionError ? <Problem role="alert">{actionError}</Problem> : null}

        {policyOpen ? (
          <div className="grid gap-3 rounded-lg border border-border/80 bg-surface/60 p-3.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 font-medium text-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={policy.enabled}
                  disabled={savingPolicy}
                  onChange={(e) => void handleSavePolicy({ enabled: e.target.checked })}
                />
                {t('mach.cli.autoUpdateEnable')}
              </label>
              <span className="text-faint">
                {renderWithMono(t('mach.cli.customUpdaterHint', { path: '\u0000' }), '~/.tycho/executor-updaters.json')}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <label className="flex items-center gap-1.5 text-muted-foreground">
                <span>{t('mach.cli.checkInterval')}</span>
                <select
                  aria-label={t('mach.cli.checkIntervalAria')}
                  className="h-7 rounded-md border border-border bg-raised px-2 text-xs text-foreground"
                  value={policy.intervalHours}
                  disabled={savingPolicy}
                  onChange={(e) => void handleSavePolicy({ intervalHours: Number(e.target.value) })}
                >
                  {INTERVAL_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {h === 24
                        ? t('mach.cli.intervalDaily', { hours: h })
                        : h === 168
                          ? t('mach.cli.intervalWeekly', { hours: h })
                          : t('mach.cli.intervalHours', { hours: h })}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span>{t('mach.cli.maintWindow')}</span>
                <select
                  aria-label={t('mach.cli.maintStartAria')}
                  className="h-7 rounded-md border border-border bg-raised px-2 text-xs text-foreground"
                  value={policy.windowStartHour}
                  disabled={savingPolicy}
                  onChange={(e) => void handleSavePolicy({ windowStartHour: Number(e.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
                <span>{t('mach.cli.windowTo')}</span>
                <select
                  aria-label={t('mach.cli.maintEndAria')}
                  className="h-7 rounded-md border border-border bg-raised px-2 text-xs text-foreground"
                  value={policy.windowEndHour}
                  disabled={savingPolicy}
                  onChange={(e) => void handleSavePolicy({ windowEndHour: Number(e.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
                {policy.windowStartHour === policy.windowEndHour ? (
                  <span className="text-faint">{t('mach.cli.windowAllDay')}</span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t('mach.cli.autoUpdateExecutors')}</span>
              {(executors.length > 0 ? executors : EXECUTOR_ORDER).map((exec) => {
                const on = policy.executors[exec] === true;
                return (
                  <button
                    key={exec}
                    type="button"
                    disabled={savingPolicy}
                    onClick={() => void handleSavePolicy({ executors: { ...policy.executors, [exec]: !on } })}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                      on
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border bg-raised text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span className={cn('size-1.5 rounded-full', on ? 'bg-primary' : 'bg-faint')} />
                    {exec}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {isPending && !fleet ? (
          <Note>{t('mach.cli.loadingMatrix')}</Note>
        ) : executors.length === 0 ? (
          <Note>{t('mach.cli.noReportedExecutors')}</Note>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border/80">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-surface/70">
                  <th className="w-48 px-3 py-2 font-semibold text-muted-foreground">{t('machines.title')}</th>
                  {executors.map((exec) => {
                    const info = refByExecutor[exec];
                    const upstream = fleet?.upstream[exec];
                    const onlineUpdatableCount = machines.filter((m) => {
                      if (!m.node.connected) return false;
                      const st = m.node.executors?.executors.find((e) => e.executor === exec);
                      if (!st?.installed) return false;
                      const activeJob = fleet?.active_by_key[jobKey(m.id, exec)];
                      if (activeJob?.state === 'unsupported') return false;
                      if (!activeJob && isLikelyManualUpdate(exec, st.path)) return false;
                      return true;
                    }).length;
                    const busyAll = triggeringKey === `all/${exec}`;
                    return (
                      <th key={exec} className="min-w-[190px] px-3 py-2 align-top">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="whitespace-nowrap font-mono text-xs font-semibold text-foreground">{exec}</span>
                              {info?.ref ? (
                                <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted-foreground">
                                  {info.source === 'upstream' ? t('cli.latest', { ver: info.ref }) : t('cli.fleetMax', { ver: info.ref })}
                                </span>
                              ) : null}
                            </div>
                            {upstream?.error ? (
                              <p className="mt-0.5 text-[10px] font-normal text-faint" title={upstream.error}>{t('mach.cli.upstreamUnreachable')}</p>
                            ) : null}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 flex-none whitespace-nowrap px-2 text-[11px]"
                            disabled={onlineUpdatableCount === 0 || busyAll}
                            title={onlineUpdatableCount === 0 ? t('mach.cli.noBatchMachines', { executor: exec }) : t('mach.cli.updateAllTitle', { executor: exec })}
                            onClick={() => void handleRunUpdate(exec)}
                          >
                            <ArrowUpCircle className="size-3" />
                            {busyAll ? t('cli.queuing') : t('cli.updateAll')}
                          </Button>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {machines.map((machine) => (
                  <tr key={machine.uid} className="hover:bg-surface/40">
                    <td className="px-3 py-2 align-middle">
                      <div className="flex items-center gap-2">
                        <Dot tone={machine.node.connected ? 'success' : 'waiting'} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">{machine.id}</div>
                          <div className="text-[11px] text-faint">
                            {shortPlatform(machine.node.platform)}{machine.node.connected ? '' : ` · ${t('common.offline')}`}
                          </div>
                        </div>
                      </div>
                    </td>
                    {executors.map((exec) => {
                      const status = machine.node.executors?.executors.find((e) => e.executor === exec);
                      const installed = status?.installed === true;
                      const ref = refByExecutor[exec]?.ref ?? null;
                      const behind = installed && isVersionBehind(status?.version, ref);
                      const job = fleet?.active_by_key[jobKey(machine.id, exec)];
                      const busyCell = triggeringKey === jobKey(machine.id, exec)
                        || job?.state === 'waiting_idle'
                        || job?.state === 'updating';

                      return (
                        <td key={exec} className="px-3 py-2 align-middle">
                          {!installed ? (
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className="text-faint"
                                  title={
                                    exec === 'gemini'
                                      ? t('mach.cli.geminiNotBundled')
                                      : undefined
                                  }
                                >
                                  {t('cli.notInstalled')}
                                </span>
                                {job ? (
                                  <button
                                    type="button"
                                    className="cursor-pointer"
                                    title={job.error ?? job.output ?? t('mach.cli.viewDetails')}
                                    onClick={() => setExpandedJobId((cur) => (cur === job.id ? null : job.id))}
                                  >
                                    {stateBadge(job, t)}
                                  </button>
                                ) : null}
                              </div>
                              {machine.node.connected && canRemoteInstall(exec) ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-1.5 text-[11px] text-primary hover:text-primary"
                                  disabled={busyCell}
                                  title={
                                    exec === 'gemini'
                                      ? t('mach.cli.installGeminiTitle', { machine: machine.id })
                                      : t('mach.cli.installTitle', { machine: machine.id, executor: exec })
                                  }
                                  onClick={() => void handleRunUpdate(exec, [machine.id])}
                                >
                                  {t('cli.install')}
                                </Button>
                              ) : null}
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className={cn(
                                    'font-mono text-xs',
                                    behind ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-foreground',
                                  )}
                                  title={status.version ?? undefined}
                                >
                                  {shortVer(status.version)}
                                </span>
                                {behind && !job ? (
                                  <Badge tone="waiting" className="text-[10px]">{t('cli.behind')}</Badge>
                                ) : null}
                                {!job && isLikelyManualUpdate(exec, status.path) ? (
                                  <Badge tone="plain" className="text-[10px] text-faint" title={t('mach.cli.manualUpdateTitle')}>{t('cli.manualUpdate')}</Badge>
                                ) : null}
                                {job ? (
                                  <button
                                    type="button"
                                    className="cursor-pointer"
                                    title={job.error ?? job.output ?? t('mach.cli.viewDetails')}
                                    onClick={() => setExpandedJobId((cur) => (cur === job.id ? null : job.id))}
                                  >
                                    {stateBadge(job, t)}
                                  </button>
                                ) : null}
                              </div>
                              {machine.node.connected ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                                  disabled={busyCell}
                                  title={t('mach.cli.updateMachineTitle', { machine: machine.id, executor: exec })}
                                  onClick={() => void handleRunUpdate(exec, [machine.id])}
                                >
                                  {t('cli.update')}
                                </Button>
                              ) : null}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {recentJobs.length > 0 ? (
        <Card className="grid gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Terminal className="size-3.5" />
              {t('cli.recentJobs')}
            </h3>
          </div>
          <ul className="divide-y divide-border/60 text-xs">
            {recentJobs.slice(0, 10).map((job) => {
              const open = expandedJobId === job.id;
              return (
                <li key={job.id} className="grid gap-1 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {stateBadge(job, t)}
                      <span className="font-medium text-foreground">{job.machine_id}</span>
                      <Mono>{job.executor}</Mono>
                      {job.method ? <span className="text-[11px] text-faint">via {job.method}</span> : null}
                      {job.before_version || job.after_version ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {job.before_version ? shortVer(job.before_version) : t('cli.notInstalled')} → {shortVer(job.after_version ?? job.before_version)}
                        </span>
                      ) : null}
                      {job.trigger === 'auto' ? <Badge tone="plain" className="text-[10px]">{t('mach.cli.triggerAuto')}</Badge> : null}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-faint">
                      <span>{formatTime(job.finished_at ?? job.started_at)}</span>
                      {job.error || job.output ? (
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => setExpandedJobId(open ? null : job.id)}
                        >
                          {open ? t('mach.cli.hideLogs') : t('mach.cli.showDetails')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {job.error && !open ? (
                    <p className={cn('text-[11px] wrap-anywhere', job.state === 'unsupported' ? 'text-muted-foreground' : 'text-danger')}>{job.error}</p>
                  ) : null}
                  {open ? (
                    <div className="mt-1 grid gap-1.5 rounded-md border border-border/70 bg-surface p-2.5">
                      {job.error ? <Callout tone={job.state === 'unsupported' ? 'plain' : 'failed'} className="text-xs">{job.error}</Callout> : null}
                      {job.output ? (
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                          {job.output}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
