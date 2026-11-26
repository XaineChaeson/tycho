import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, CheckCircle2, Clock, RefreshCw, ShieldCheck, SlidersHorizontal, Terminal, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { accountsQuery, executorUpdatesQuery } from '@/lib/queries';
import type { Machine } from '@/lib/types';
import { cn } from '@/lib/utils';

const EXECUTOR_ORDER = ['codex', 'claude', 'gemini', 'dsh'];
const INTERVAL_OPTIONS = [6, 12, 24, 48, 72, 168];

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

function stateBadge(job: ExecutorUpdateJobView) {
  switch (job.state) {
    case 'waiting_idle':
      return <Badge tone="waiting" className="text-[11px]"><Clock className="mr-1 size-3" />等空闲</Badge>;
    case 'updating':
      return <Badge tone="plain" className="text-[11px]"><RefreshCw className="mr-1 size-3 animate-spin" />更新中</Badge>;
    case 'succeeded':
      return (
        <Badge tone="success" className="text-[11px]">
          <CheckCircle2 className="mr-1 size-3" />
          {job.updated ? `已升 ${shortVer(job.after_version)}` : '已是最新'}
        </Badge>
      );
    case 'unsupported':
      return <Badge tone="plain" className="text-[11px] text-muted-foreground">{job.method === 'disabled' ? '已禁用' : '需手动更新'}</Badge>;
    case 'failed':
      return <Badge tone="failed" className="text-[11px]"><TriangleAlert className="mr-1 size-3" />失败</Badge>;
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
  const queryClient = useQueryClient();
  const { data: fleet, isPending, error } = useQuery(executorUpdatesQuery);
  const [checking, setChecking] = useState(false);
  const [triggeringKey, setTriggeringKey] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const executors = useMemo(() => {
    const found = new Set<string>();
    for (const m of machines) {
      for (const e of m.node.executors?.executors ?? []) {
        if (e.installed) found.add(e.executor);
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
              <h2 className="text-sm font-semibold">CLI 版本矩阵</h2>
              <Badge tone="plain" className="text-[11px]">
                <ShieldCheck className="mr-1 size-3 text-success" />
                空闲防打断 · 临时缓存自动清理
              </Badge>
              {activeCount > 0 ? (
                <Badge tone="waiting" className="text-[11px]">{activeCount} 项进行中</Badge>
              ) : null}
            </div>
            <Note className="mt-0.5 text-xs">
              各机器 CLI 版本漂移一目了然；更新时若机器有任务运行会自动排队等空闲，完成后立即重探并同步最新模型列表。
            </Note>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" disabled={checking} onClick={() => void handleCheckUpstream()}>
              <RefreshCw className={cn('size-3.5', checking && 'animate-spin')} />
              {checking ? '检查中' : '检查上游最新版'}
            </Button>
            <Button size="sm" variant={policyOpen ? 'primary' : 'ghost'} onClick={() => setPolicyOpen((v) => !v)}>
              <SlidersHorizontal className="size-3.5" />
              定时自动更新：{policy.enabled ? `开（${enabledExecs.length} 项）` : '关'}
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
                启用空闲自动更新（默认关闭；仅更新在线且当前无运行任务的落后机器）
              </label>
              <span className="text-faint">
                自定义源/内网包可在本机 <Mono>~/.tycho/executor-updaters.json</Mono> 覆写
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <label className="flex items-center gap-1.5 text-muted-foreground">
                <span>检查间隔</span>
                <select
                  aria-label="自动更新检查间隔"
                  className="h-7 rounded-md border border-border bg-raised px-2 text-xs text-foreground"
                  value={policy.intervalHours}
                  disabled={savingPolicy}
                  onChange={(e) => void handleSavePolicy({ intervalHours: Number(e.target.value) })}
                >
                  {INTERVAL_OPTIONS.map((h) => (
                    <option key={h} value={h}>每 {h} 小时{h === 24 ? '（每天）' : h === 168 ? '（每周）' : ''}</option>
                  ))}
                </select>
              </label>

              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span>维护时段</span>
                <select
                  aria-label="维护时段开始小时"
                  className="h-7 rounded-md border border-border bg-raised px-2 text-xs text-foreground"
                  value={policy.windowStartHour}
                  disabled={savingPolicy}
                  onChange={(e) => void handleSavePolicy({ windowStartHour: Number(e.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
                <span>至</span>
                <select
                  aria-label="维护时段结束小时"
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
                  <span className="text-faint">（起止相同 = 全天空闲即可）</span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">参与自动更新的执行器：</span>
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
          <Note>正在读取执行器版本矩阵…</Note>
        ) : executors.length === 0 ? (
          <Note>当前没有机器上报已安装的执行器。</Note>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border/80">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-surface/70">
                  <th className="w-48 px-3 py-2 font-semibold text-muted-foreground">机器</th>
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
                                  {info.source === 'upstream' ? `最新 ${info.ref}` : `机群最高 ${info.ref}`}
                                </span>
                              ) : null}
                            </div>
                            {upstream?.error ? (
                              <p className="mt-0.5 text-[10px] font-normal text-faint" title={upstream.error}>上游未连上（按机群比对）</p>
                            ) : null}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 flex-none whitespace-nowrap px-2 text-[11px]"
                            disabled={onlineUpdatableCount === 0 || busyAll}
                            title={onlineUpdatableCount === 0 ? `${exec} 当前没有支持自动批量更新的在线机器` : `更新所有在线机器上的 ${exec}`}
                            onClick={() => void handleRunUpdate(exec)}
                          >
                            <ArrowUpCircle className="size-3" />
                            {busyAll ? '排队中' : '全机更新'}
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
                            {shortPlatform(machine.node.platform)}{machine.node.connected ? '' : ' · 离线'}
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
                            <span className="text-faint">未安装</span>
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
                                  <Badge tone="waiting" className="text-[10px]">落后</Badge>
                                ) : null}
                                {!job && isLikelyManualUpdate(exec, status.path) ? (
                                  <Badge tone="plain" className="text-[10px] text-faint" title="该执行器由桌面安装包管理，需通过对应桌面端或本机配置更新">需手动更新</Badge>
                                ) : null}
                                {job ? (
                                  <button
                                    type="button"
                                    className="cursor-pointer"
                                    title={job.error ?? job.output ?? '查看详情'}
                                    onClick={() => setExpandedJobId((cur) => (cur === job.id ? null : job.id))}
                                  >
                                    {stateBadge(job)}
                                  </button>
                                ) : null}
                              </div>
                              {machine.node.connected ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                                  disabled={busyCell}
                                  title={`更新 ${machine.id} 上的 ${exec}`}
                                  onClick={() => void handleRunUpdate(exec, [machine.id])}
                                >
                                  更新
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
              最近更新记录（最多保留 30 条，内存循环缓存，不落盘堆积）
            </h3>
          </div>
          <ul className="divide-y divide-border/60 text-xs">
            {recentJobs.slice(0, 10).map((job) => {
              const open = expandedJobId === job.id;
              return (
                <li key={job.id} className="grid gap-1 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {stateBadge(job)}
                      <span className="font-medium text-foreground">{job.machine_id}</span>
                      <Mono>{job.executor}</Mono>
                      {job.method ? <span className="text-[11px] text-faint">via {job.method}</span> : null}
                      {job.before_version || job.after_version ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {shortVer(job.before_version)} → {shortVer(job.after_version ?? job.before_version)}
                        </span>
                      ) : null}
                      {job.trigger === 'auto' ? <Badge tone="plain" className="text-[10px]">自动</Badge> : null}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-faint">
                      <span>{formatTime(job.finished_at ?? job.started_at)}</span>
                      {job.error || job.output ? (
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => setExpandedJobId(open ? null : job.id)}
                        >
                          {open ? '收起日志' : '看详情'}
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
