// Compact multi-account quota chip for the Shell footer, with an upward popover showing
// per-account status, 5h/7d remaining bars, reset countdowns, and 1-click refresh.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { quotaUsedUp, type LoginStatus } from '@shared/labels.ts';
import { loginName } from '@shared/logins.ts';
import { formatTime } from '@shared/time.ts';
import { latestQuota } from '@shared/usage.ts';
import { Dot, Mono } from '@/components/bits';
import { coveredMachineLoginsByAccount } from '@/components/dispatch-slots-panel';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { messageOf, post } from '@/lib/api';
import { accountsQuery } from '@/lib/queries';
import type { Account, AccountsAndMachines, LoginTelemetry, MachineLogin } from '@/lib/types';
import { cn } from '@/lib/utils';

type UsageFigure = LoginStatus['usage'][number];

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

export function formatSpecialQuotaLabel(windowName: string): { label: string; value: string; isUnlimited?: boolean } | null {
  for (const [prefix, label] of [
    ['balance:', '官网余额'],
    ['bonus_balance:', '官网赠金'],
    ['api_balance:', 'API 余额'],
  ] as const) {
    if (windowName.startsWith(prefix)) {
      const parts = windowName.split(':');
      const currency = parts[1] ?? 'CNY';
      const amount = parts.slice(2).join(':');
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
      return { label, value: amount ? `${symbol}${amount}` : '可用', isUnlimited: true };
    }
  }
  if (windowName.startsWith('gateway_budget:')) {
    const rest = windowName.slice('gateway_budget:'.length);
    const sep = rest.indexOf(':');
    if (sep > 0 && !rest.startsWith('$')) {
      return { label: `网关 ${rest.slice(0, sep)}`, value: rest.slice(sep + 1) };
    }
    return { label: '网关额度', value: rest };
  }
  if (windowName.startsWith('gateway_unlimited:')) {
    const rest = windowName.slice('gateway_unlimited:'.length);
    const sep = rest.indexOf(':');
    if (sep > 0) {
      return { label: `网关 ${rest.slice(0, sep)}`, value: `30天 ${rest.slice(sep + 1)} · 不限额`, isUnlimited: true };
    }
    return { label: '网关已用', value: `${rest} · 不限额`, isUnlimited: true };
  }
  return null;
}

export interface QuotaLoginItem {
  id: string;
  key: string;
  kind: 'account' | 'machine' | 'group';
  name: string;
  executor: string;
  providerLabel: string;
  machine: string | null;
  machines?: readonly string[];
  canRoute: boolean;
  status: LoginStatus | undefined;
  usage: readonly UsageFigure[];
  telemetry: LoginTelemetry | null;
  needsRelogin: boolean;
  resting: boolean;
  restUntil: string | null;
  tightestRemaining: number | null;
  fiveHour: UsageFigure | null;
  sevenDay: UsageFigure | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  dsh: 'DSH',
};

export function formatProviderName(executor: string): string {
  const key = executor.toLowerCase();
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key]!;
  return executor.length > 0 ? `${executor[0]!.toUpperCase()}${executor.slice(1)}` : executor;
}

export function remainingPct(used: number): number {
  if (!Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - used) * 100)));
}

export function formatResetCountdown(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  const diff = target - now;
  if (diff <= 0) return '即将重置';
  const totalMinutes = Math.max(1, Math.ceil(diff / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m 后`;
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) return remMinutes > 0 ? `${totalHours}h ${remMinutes}m 后` : `${totalHours}h 后`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d ${remHours}h 后` : `${days}d 后`;
}

function resolveGroupedUsage(data: AccountsAndMachines): Map<string, readonly UsageFigure[]> {
  const map = new Map<string, readonly UsageFigure[]>();
  const groups = data.login_groups ?? [];
  if (groups.length === 0) return map;

  type Member = { id: string; kind: 'account' | 'machine'; usage: UsageFigure[] };
  const members: Member[] = [
    ...(data.accounts ?? []).map((account) => ({
      id: account.id,
      kind: 'account' as const,
      usage: account.status?.usage ?? [],
    })),
    ...(data.machines ?? []).flatMap((machine) =>
      (machine.logins ?? [])
        .filter((login) => login.configured && login.id !== null)
        .map((login) => ({
          id: login.id!,
          kind: 'machine' as const,
          usage: login.status?.usage ?? [],
        })),
    ),
  ];

  for (const ids of groups) {
    const matched = members.filter((member) => ids.includes(member.id));
    if (matched.length < 2) continue;
    const freshest = latestQuota(matched, (member) => member.usage).usage;
    for (const member of matched) {
      if (member.kind === 'account') map.set(member.id, freshest);
    }
  }
  return map;
}

function isNonPercentBalanceWindow(windowName: string): boolean {
  return windowName.startsWith('balance:')
    || windowName.startsWith('bonus_balance:')
    || windowName.startsWith('api_balance:')
    || windowName.startsWith('gateway_unlimited:');
}

function summarizeWindows(usage: readonly UsageFigure[]): {
  fiveHour: UsageFigure | null;
  sevenDay: UsageFigure | null;
  tightestRemaining: number | null;
} {
  const fiveHour = usage.find((figure) => figure.window === 'five_hour') ?? null;
  const sevenDay = usage.find((figure) => figure.window === 'seven_day')
    ?? usage.find((figure) => figure.window.startsWith('seven_day_'))
    ?? null;

  const general = usage.filter((figure) => figure.window === 'five_hour' || figure.window === 'seven_day');
  const pool = general.length > 0 ? general : usage.filter((figure) => !isNonPercentBalanceWindow(figure.window));
  if (pool.length === 0) return { fiveHour, sevenDay, tightestRemaining: null };

  let tightest = 100;
  for (const figure of pool) {
    const rem = remainingPct(figure.used);
    if (rem < tightest) tightest = rem;
  }
  return { fiveHour, sevenDay, tightestRemaining: tightest };
}

function buildAccountItem(
  account: Account,
  groupedUsage: ReadonlyMap<string, readonly UsageFigure[]>,
  telemetryMap: Readonly<Record<string, LoginTelemetry>> | undefined,
): QuotaLoginItem {
  const status = account.status;
  const usage = groupedUsage.get(account.id) ?? status?.usage ?? [];
  const { fiveHour, sevenDay, tightestRemaining } = summarizeWindows(usage);
  const needsRelogin = account.credential === 'missing'
    || account.credential === 'rejected'
    || status?.rejected === true;
  const resting = !needsRelogin && (Boolean(status?.rest) || quotaUsedUp(usage));
  return {
    id: account.id,
    key: account.id,
    kind: 'account',
    name: account.name,
    executor: account.executor,
    providerLabel: formatProviderName(account.executor),
    machine: null,
    canRoute: Boolean(account.can_route),
    status,
    usage,
    telemetry: telemetryMap?.[account.id] ?? null,
    needsRelogin,
    resting,
    restUntil: status?.rest?.until ?? null,
    tightestRemaining: resting && tightestRemaining === null ? 0 : tightestRemaining,
    fiveHour,
    sevenDay,
  };
}

function buildMachineLoginItem(
  machineId: string,
  login: MachineLogin,
  telemetryMap: Readonly<Record<string, LoginTelemetry>> | undefined,
): QuotaLoginItem {
  const status = login.status;
  const usage = status?.usage ?? [];
  const { fiveHour, sevenDay, tightestRemaining } = summarizeWindows(usage);
  const needsRelogin = Boolean(login.refused)
    || status?.rejected === true
    || login.signed_in === false;
  const resting = !needsRelogin && (Boolean(status?.rest) || quotaUsedUp(usage));
  return {
    id: login.id!,
    key: `machine:${machineId}:${login.executor}`,
    kind: 'machine',
    name: login.account_label ?? loginName(login.name),
    executor: login.executor,
    providerLabel: formatProviderName(login.executor),
    machine: machineId,
    canRoute: Boolean(login.can_route),
    status,
    usage,
    telemetry: login.id ? (telemetryMap?.[login.id] ?? null) : null,
    needsRelogin,
    resting,
    restUntil: status?.rest?.until ?? null,
    tightestRemaining: resting && tightestRemaining === null ? 0 : tightestRemaining,
    fiveHour,
    sevenDay,
  };
}

function mergeTelemetry(items: readonly QuotaLoginItem[]): LoginTelemetry | null {
  let fiveHourTokens = 0;
  let fiveHourRuns = 0;
  let dayTokens = 0;
  let dayRuns = 0;
  let weekTokens = 0;
  let weekRuns = 0;
  let totalTokens = 0;
  let totalRuns = 0;
  let lastAt: string | null = null;
  let any = false;
  for (const item of items) {
    if (!item.telemetry) continue;
    any = true;
    fiveHourTokens += item.telemetry.five_hour_tokens;
    fiveHourRuns += item.telemetry.five_hour_runs;
    dayTokens += item.telemetry.day_tokens;
    dayRuns += item.telemetry.day_runs;
    weekTokens += item.telemetry.week_tokens ?? item.telemetry.day_tokens;
    weekRuns += item.telemetry.week_runs ?? item.telemetry.day_runs;
    totalTokens += item.telemetry.total_tokens ?? item.telemetry.week_tokens ?? item.telemetry.day_tokens;
    totalRuns += item.telemetry.total_runs ?? item.telemetry.week_runs ?? item.telemetry.day_runs;
    if (item.telemetry.last_at && (!lastAt || item.telemetry.last_at > lastAt)) {
      lastAt = item.telemetry.last_at;
    }
  }
  return any
    ? {
        five_hour_tokens: fiveHourTokens,
        five_hour_runs: fiveHourRuns,
        day_tokens: dayTokens,
        day_runs: dayRuns,
        week_tokens: weekTokens,
        week_runs: weekRuns,
        total_tokens: totalTokens,
        total_runs: totalRuns,
        last_at: lastAt,
      }
    : null;
}

export function collectIndividualQuotaLogins(data: AccountsAndMachines | undefined): QuotaLoginItem[] {
  if (!data) return [];
  const groupedUsage = resolveGroupedUsage(data);
  const telemetryMap = data.login_telemetry;
  const items: QuotaLoginItem[] = [];
  for (const account of data.accounts ?? []) {
    items.push(buildAccountItem(account, groupedUsage, telemetryMap));
  }
  for (const machine of data.machines ?? []) {
    for (const login of machine.logins ?? []) {
      if (!login.configured || login.id === null) continue;
      items.push(buildMachineLoginItem(machine.id, login, telemetryMap));
    }
  }
  return items;
}

export function collectQuotaLogins(data: AccountsAndMachines | undefined): QuotaLoginItem[] {
  if (!data) return [];
  const groupedUsage = resolveGroupedUsage(data);
  const telemetryMap = data.login_telemetry;
  const items: QuotaLoginItem[] = [];
  for (const account of data.accounts ?? []) {
    items.push(buildAccountItem(account, groupedUsage, telemetryMap));
  }
  const covered = coveredMachineLoginsByAccount(data);
  const machineItems: QuotaLoginItem[] = [];
  for (const machine of data.machines ?? []) {
    for (const login of machine.logins ?? []) {
      if (!login.configured || login.id === null) continue;
      if (covered.has(login.id)) continue;
      machineItems.push(buildMachineLoginItem(machine.id, login, telemetryMap));
    }
  }
  // Collapse multi-machine local authorizations of the same executor into one unified logical
  // entry inside the quota popover so 3 Gemini machines read as one logical account pool.
  const byExecutor = new Map<string, QuotaLoginItem[]>();
  for (const item of machineItems) {
    const list = byExecutor.get(item.executor);
    if (list) list.push(item);
    else byExecutor.set(item.executor, [item]);
  }
  for (const [executor, list] of byExecutor) {
    if (list.length < 2) {
      items.push(list[0]!);
      continue;
    }
    const machines = list.map((m) => m.machine!).filter(Boolean);
    const allUsage = latestQuota(list, (m) => [...m.usage]).usage;
    const { fiveHour, sevenDay, tightestRemaining } = summarizeWindows(allUsage);
    const needsRelogin = list.every((m) => m.needsRelogin);
    const resting = !needsRelogin && list.every((m) => m.resting);
    const restUntil = resting ? (list.map((m) => m.restUntil).filter(Boolean).sort()[0] ?? null) : null;
    items.push({
      id: list[0]!.id,
      key: `group:${executor}`,
      kind: 'group',
      name: `${formatProviderName(executor)}（${list.length} 台机器）`,
      executor,
      providerLabel: formatProviderName(executor),
      machine: null,
      machines,
      canRoute: list.some((m) => m.canRoute),
      status: list[0]!.status,
      usage: allUsage,
      telemetry: mergeTelemetry(list),
      needsRelogin,
      resting,
      restUntil,
      tightestRemaining,
      fiveHour,
      sevenDay,
    });
  }
  return items;
}

export function standingBadgeOf(item: QuotaLoginItem): { label: '可用' | '限额休眠' | '需重登'; tone: BadgeTone } {
  if (item.needsRelogin) return { label: '需重登', tone: 'failed' };
  if (item.resting) return { label: '限额休眠', tone: 'waiting' };
  return { label: '可用', tone: 'success' };
}

function barColorClass(remaining: number): string {
  if (remaining <= 10) return 'bg-failed';
  if (remaining <= 20) return 'bg-waiting';
  return 'bg-success';
}

function WindowBar({ label, figure }: { label: string; figure: UsageFigure }) {
  const rem = remainingPct(figure.used);
  const countdown = formatResetCountdown(figure.resets_at);
  const exactReset = figure.resets_at ? `${formatTime(figure.resets_at)} 重置` : undefined;
  return (
    <div className="grid gap-0.5">
      <div className="flex items-center justify-between gap-2 text-2xs leading-4">
        <span className="font-mono text-muted-foreground">{label}</span>
        <span className="flex items-center gap-1.5 tabular-nums">
          <span className={cn('font-medium', rem <= 10 ? 'text-destructive' : rem <= 20 ? 'text-waiting-foreground' : 'text-foreground')}>
            剩 {rem}%
          </span>
          {countdown ? (
            <span className="text-faint" title={exactReset}>
              · {countdown}
            </span>
          ) : null}
        </span>
      </div>
      <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn('block h-full rounded-full transition-[width] duration-200', barColorClass(rem))}
          style={{ width: `${rem}%` }}
        />
      </span>
    </div>
  );
}

export function QuotaMiniBars({ item, compact = false }: { item: QuotaLoginItem; compact?: boolean }) {
  const windows: { label: string; figure: UsageFigure }[] = [];
  const special = item.usage
    .map((figure) => ({ figure, parsed: formatSpecialQuotaLabel(figure.window) }))
    .filter((entry): entry is { figure: UsageFigure; parsed: NonNullable<ReturnType<typeof formatSpecialQuotaLabel>> } => entry.parsed !== null);

  if (item.fiveHour) windows.push({ label: '5h', figure: item.fiveHour });
  if (item.sevenDay) windows.push({ label: '7d', figure: item.sevenDay });
  if (windows.length === 0 && special.length === 0 && item.usage.length > 0) {
    windows.push({ label: item.usage[0]!.window, figure: item.usage[0]! });
  }

  const telemetryLine = (() => {
    const t = item.telemetry;
    if (!t) return null;
    const week = t.week_tokens ?? t.day_tokens;
    const total = t.total_tokens ?? week;
    if (t.day_tokens > 0 || t.day_runs > 0) {
      const base = `近 5h ${formatCompactTokens(t.five_hour_tokens)} (${t.five_hour_runs} 轮) · 24h ${formatCompactTokens(t.day_tokens)}`;
      return week > t.day_tokens ? `${base} · 7d ${formatCompactTokens(week)}` : base;
    }
    if (week > 0) return `近 7 天 ${formatCompactTokens(week)} (${t.week_runs ?? 0} 轮)`;
    if (total > 0) return `累计 ${formatCompactTokens(total)} (${t.total_runs ?? 0} 轮)`;
    return null;
  })();

  if (windows.length === 0 && special.length === 0) {
    return (
      <div className="grid gap-0.5">
        {item.restUntil ? (
          <p className="text-2xs text-waiting-foreground tabular-nums">
            休眠至 {formatTime(item.restUntil)}{formatResetCountdown(item.restUntil) ? `（${formatResetCountdown(item.restUntil)}）` : ''}
          </p>
        ) : null}
        {item.machines && item.machines.length > 0 ? (
          <p className="truncate font-mono text-2xs text-faint" title={item.machines.join(' · ')}>
            {item.machines.join(' · ')}
          </p>
        ) : null}
        {telemetryLine ? (
          <p className="font-mono text-2xs text-muted-foreground tabular-nums">{telemetryLine}</p>
        ) : (
          <p className="text-2xs text-faint">账本遥测 · 暂无消耗记录</p>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      {special.map(({ figure, parsed }) => (
        <div key={figure.window} className="grid gap-0.5">
          <div className="flex items-center justify-between gap-2 text-2xs leading-4">
            <span className="font-mono text-muted-foreground">{parsed.label}</span>
            <span className="font-mono font-medium text-foreground tabular-nums">{parsed.value}</span>
          </div>
          {!parsed.isUnlimited ? (
            <span aria-hidden="true" className="block h-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('block h-full rounded-full transition-[width] duration-200', barColorClass(remainingPct(figure.used)))}
                style={{ width: `${remainingPct(figure.used)}%` }}
              />
            </span>
          ) : null}
        </div>
      ))}
      {windows.length > 0 ? (
        <div className={cn('grid gap-1.5', compact && windows.length > 1 && 'grid-cols-2 gap-2.5')}>
          {windows.map(({ label, figure }) => (
            <WindowBar key={figure.window} label={label} figure={figure} />
          ))}
        </div>
      ) : null}
      {telemetryLine ? (
        <p className="font-mono text-2xs text-faint tabular-nums">{telemetryLine}</p>
      ) : null}
    </div>
  );
}

export function AccountQuotaPopover({ className }: { className?: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const hasCached = client.getQueryData<AccountsAndMachines>(accountsQuery.queryKey) !== undefined;
  const { data, isError } = useQuery({
    ...accountsQuery,
    retry: false,
    refetchInterval: open ? accountsQuery.refetchInterval : false,
    enabled: open || !hasCached,
  });
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inflightRef = useRef(new Set<string>());

  const logins = useMemo(() => collectQuotaLogins(data), [data]);

  const summary = useMemo(() => {
    const byProvider = new Map<string, { label: string; remaining: number }>();
    let hasCritical = false;
    let hasLow = false;

    for (const item of logins) {
      if (item.needsRelogin || item.resting || item.tightestRemaining === 0) {
        hasCritical = true;
      } else if (item.tightestRemaining !== null && item.tightestRemaining <= 20) {
        hasLow = true;
      }

      if (item.tightestRemaining !== null) {
        const key = item.executor.toLowerCase();
        const prev = byProvider.get(key);
        if (!prev || item.tightestRemaining < prev.remaining) {
          byProvider.set(key, { label: item.providerLabel, remaining: item.tightestRemaining });
        }
      }
    }

    const providers = [...byProvider.values()];
    const text = providers.length > 0
      ? providers.slice(0, 2).map((p) => `${p.label} ${p.remaining}%`).join(' · ')
        + (providers.length > 2 ? ` +${providers.length - 2}` : '')
      : `账号 ${logins.length}`;

    return { text, hasCritical, hasLow };
  }, [logins]);

  if (isError || !data || logins.length === 0) return null;

  async function refreshAccount(item: QuotaLoginItem): Promise<void> {
    if (inflightRef.current.has(item.key)) return;
    inflightRef.current.add(item.key);
    setRefreshing((prev) => ({ ...prev, [item.key]: true }));
    setErrors(({ [item.key]: _gone, ...rest }) => rest);
    try {
      if (item.kind === 'account') {
        await post(`/api/accounts/${encodeURIComponent(item.id)}/check`);
      } else if (item.kind === 'machine' || item.kind === 'group') {
        await post('/api/quota/refresh', { login_id: item.id });
      }
      await client.invalidateQueries({ queryKey: accountsQuery.queryKey });
    } catch (failure) {
      setErrors((prev) => ({ ...prev, [item.key]: messageOf(failure) }));
    } finally {
      inflightRef.current.delete(item.key);
      setRefreshing(({ [item.key]: _done, ...rest }) => rest);
    }
  }

  const dotTone = summary.hasCritical ? 'failed' : summary.hasLow ? 'waiting' : 'success';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="account-quota-trigger"
          aria-label={`账号额度：${summary.text}`}
          className={cn(
            'flex min-h-7 w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-xs transition-colors duration-100 focus-visible:-outline-offset-2',
            summary.hasCritical
              ? 'border-failed-border/80 bg-failed-soft/65 text-foreground hover:bg-failed-soft'
              : summary.hasLow
                ? 'border-waiting-border bg-waiting-soft/75 text-waiting-foreground hover:bg-waiting-soft'
                : 'border-border/80 bg-raised/75 text-muted-foreground hover:bg-hover hover:text-foreground',
            className,
          )}
        >
          <Dot tone={dotTone} pulse={false} className="size-1.5" />
          <span className="min-w-0 flex-1 truncate font-medium tabular-nums">{summary.text}</span>
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
        aria-label="账号与额度"
        className="w-[310px] overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold text-foreground">账号与额度</span>
          <span className="rounded-full bg-hover px-1.5 text-2xs leading-4 text-muted-foreground tabular-nums">
            {logins.length}
          </span>
        </div>

        <div className="max-h-[320px] divide-y divide-border/70 overflow-y-auto">
          {logins.map((item) => {
            const standing = standingBadgeOf(item);
            const busy = Boolean(refreshing[item.key]);
            const rowError = errors[item.key];
            const restCountdown = formatResetCountdown(item.restUntil);
            return (
              <div key={item.key} className="grid gap-1.5 px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={item.name}>
                    {item.name}
                  </span>
                  <Mono className="flex-none rounded bg-hover px-1 py-px text-2xs text-muted-foreground">
                    {item.providerLabel}
                  </Mono>
                  <Badge tone={standing.tone} className="min-h-4 flex-none px-1.5 py-0 text-2xs leading-4">
                    {standing.label}
                  </Badge>
                  <button
                    type="button"
                    aria-label={`刷新 ${item.name} 额度`}
                    title="检查账号并刷新额度"
                    disabled={busy}
                    onClick={() => void refreshAccount(item)}
                    className="inline-flex size-6 flex-none items-center justify-center rounded-sm text-faint transition-colors hover:bg-hover hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className={cn('size-3', busy && 'animate-spin motion-reduce:animate-none')}
                    />
                  </button>
                </div>

                {item.resting && item.restUntil && (item.fiveHour || item.sevenDay) ? (
                  <p className="text-2xs text-waiting-foreground tabular-nums">
                    休眠至 {formatTime(item.restUntil)}{restCountdown ? `（${restCountdown}）` : ''}
                  </p>
                ) : null}

                <QuotaMiniBars item={item} />

                {rowError ? (
                  <p role="alert" className="text-2xs text-destructive wrap-anywhere">
                    {rowError}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end border-t border-border bg-muted/40 px-3 py-2">
          <Link
            to="/accounts"
            onClick={() => setOpen(false)}
            className="text-xs font-medium text-link no-underline hover:underline"
          >
            管理全部账号 →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
