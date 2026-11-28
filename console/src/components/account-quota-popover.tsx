// Compact multi-account quota chip for the Shell footer, with an upward popover showing
// per-account status, 5h/7d remaining bars, reset countdowns, and 1-click refresh.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { t as translate } from '@shared/i18n.ts';
import { quotaUsedUp, remainingPercent, type LoginStatus } from '@shared/labels.ts';
import { loginName } from '@shared/logins.ts';
import { formatTime } from '@shared/time.ts';
import { latestQuota } from '@shared/usage.ts';
import { Dot, Mono } from '@/components/bits';
import { coveredMachineLoginsByAccount } from '@/components/dispatch-slots-panel';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/menu';
import { messageOf, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
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
  for (const [prefix, labelKey] of [
    ['balance:', 'acct.quota.officialBalance'],
    ['bonus_balance:', 'acct.quota.officialBonus'],
    ['api_balance:', 'acct.quota.apiBalance'],
  ] as const) {
    if (windowName.startsWith(prefix)) {
      const parts = windowName.split(':');
      const currency = parts[1] ?? 'CNY';
      const amount = parts.slice(2).join(':');
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
      return { label: translate(labelKey), value: amount ? `${symbol}${amount}` : translate('acct.status.available'), isUnlimited: true };
    }
  }
  if (windowName.startsWith('gateway_budget:')) {
    const rest = windowName.slice('gateway_budget:'.length);
    const sep = rest.indexOf(':');
    if (sep > 0 && !rest.startsWith('$')) {
      return { label: translate('acct.quota.gatewayNamed', { name: rest.slice(0, sep) }), value: rest.slice(sep + 1) };
    }
    return { label: translate('acct.quota.gatewayBudget'), value: rest };
  }
  if (windowName.startsWith('gateway_unlimited:')) {
    const rest = windowName.slice('gateway_unlimited:'.length);
    const sep = rest.indexOf(':');
    if (sep > 0) {
      return {
        label: translate('acct.quota.gatewayNamed', { name: rest.slice(0, sep) }),
        value: translate('acct.quota.gatewayUnlimited30d', { spent: rest.slice(sep + 1) }),
        isUnlimited: true,
      };
    }
    return {
      label: translate('acct.quota.gatewayUsed'),
      value: translate('acct.quota.gatewayUnlimitedValue', { spent: rest }),
      isUnlimited: true,
    };
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

export const remainingPct = remainingPercent;

export function formatResetCountdown(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  const diff = target - now;
  if (diff <= 0) return translate('acct.quota.resettingSoon');
  const totalMinutes = Math.max(1, Math.ceil(diff / 60_000));
  if (totalMinutes < 60) return translate('acct.quota.inMinutes', { minutes: totalMinutes });
  const totalHours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes % 60;
  if (totalHours < 24) {
    return remMinutes > 0
      ? translate('acct.quota.inHoursMinutes', { hours: totalHours, minutes: remMinutes })
      : translate('acct.quota.inHours', { hours: totalHours });
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0
    ? translate('acct.quota.inDaysHours', { days, hours: remHours })
    : translate('acct.quota.inDays', { days });
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
      name: translate('acct.group.machinesTitle', { provider: formatProviderName(executor), count: list.length }),
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

export function standingBadgeOf(item: QuotaLoginItem): { label: string; tone: BadgeTone } {
  if (item.needsRelogin) return { label: translate('acct.quota.badgeRelogin'), tone: 'failed' };
  if (item.resting) return { label: translate('acct.quota.badgeResting'), tone: 'waiting' };
  return { label: translate('acct.status.available'), tone: 'success' };
}

function barColorClass(remaining: number): string {
  if (remaining <= 10) return 'bg-failed';
  if (remaining <= 20) return 'bg-waiting';
  return 'bg-success';
}

function WindowBar({ label, figure }: { label: string; figure: UsageFigure }) {
  const { t } = useI18n();
  const rem = remainingPct(figure.used);
  const countdown = formatResetCountdown(figure.resets_at);
  const exactReset = figure.resets_at ? t('acct.quota.resetsAt', { time: formatTime(figure.resets_at) }) : undefined;
  return (
    <div className="grid gap-0.5">
      <div className="flex items-center justify-between gap-2 text-2xs leading-4">
        <span className="font-mono text-muted-foreground">{label}</span>
        <span className="flex items-center gap-1.5 tabular-nums">
          <span className={cn('font-medium', rem <= 10 ? 'text-destructive' : rem <= 20 ? 'text-waiting-foreground' : 'text-foreground')}>
            {t('acct.quota.remainingPct', { pct: rem })}
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
  const { t } = useI18n();
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
    const tel = item.telemetry;
    if (!tel) return null;
    const week = tel.week_tokens ?? tel.day_tokens;
    const total = tel.total_tokens ?? week;
    if (tel.day_tokens > 0 || tel.day_runs > 0) {
      const base = t('acct.quota.tel5h24h', {
        tokens5h: formatCompactTokens(tel.five_hour_tokens),
        runs5h: tel.five_hour_runs,
        tokens24h: formatCompactTokens(tel.day_tokens),
      });
      return week > tel.day_tokens ? t('acct.quota.telWith7d', { base, tokens7d: formatCompactTokens(week) }) : base;
    }
    if (week > 0) return t('acct.quota.tel7d', { tokens: formatCompactTokens(week), runs: tel.week_runs ?? 0 });
    if (total > 0) return t('acct.quota.telTotal', { tokens: formatCompactTokens(total), runs: tel.total_runs ?? 0 });
    return null;
  })();

  if (windows.length === 0 && special.length === 0) {
    const restCountdown = item.restUntil ? formatResetCountdown(item.restUntil) : null;
    return (
      <div className="grid gap-0.5">
        {item.restUntil ? (
          <p className="text-2xs text-waiting-foreground tabular-nums">
            {t('acct.quota.restingUntil', { time: formatTime(item.restUntil) })}
            {restCountdown ? t('acct.paren', { text: restCountdown }) : ''}
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
          <p className="text-2xs text-faint">{t('acct.quota.noTelemetry')}</p>
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
  const { t, locale } = useI18n();
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

  const logins = useMemo(() => collectQuotaLogins(data), [data, locale]);

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
      : t('acct.quota.accountsCount', { count: logins.length });

    return { text, hasCritical, hasLow };
  }, [logins, t]);

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
          aria-label={t('acct.quota.triggerAria', { summary: summary.text })}
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
        aria-label={t('acct.quota.popoverTitle')}
        className="w-[310px] overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold text-foreground">{t('acct.quota.popoverTitle')}</span>
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
                    aria-label={t('acct.quota.refreshAria', { name: item.name })}
                    title={t('acct.quota.refreshTitle')}
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
                    {t('acct.quota.restingUntil', { time: formatTime(item.restUntil) })}
                    {restCountdown ? t('acct.paren', { text: restCountdown }) : ''}
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
            {t('acct.quota.manageAll')}
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
