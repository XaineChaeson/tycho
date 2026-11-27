// Logical-account Routing Matrix (P1 primary load-balanced, P2 fallback, off excluded) shared by
// AccountsPage (global defaults + Dispatch Simulator) and ProjectSettings (per-project overrides).
import { ArrowDown, ChevronDown, Layers, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { tierDisplayLabel } from '@shared/labels.ts';
import { TIERS, tierValueFrom, type TierId } from '@shared/tiers.ts';
import {
  deriveEffectiveTierSlots,
  effectiveRouteOfLogin,
  logicalAccountKey,
  type DispatchSlotName,
  type DispatchSlotsConfig,
  type TierDispatchSlots,
} from '@shared/dispatch-slots.ts';
import { latestQuota } from '@shared/usage.ts';
import { formatProviderName, formatSpecialQuotaLabel } from '@/components/account-quota-popover';
import { Dot, Problem } from '@/components/bits';
import { useI18n } from '@/lib/i18n';
import type { Account, AccountsAndMachines, Machine, MachineLogin } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface LogicalAccountEntry {
  key: string;
  name: string;
  identityHint: string | null;
  executor: string;
  route: string | null;
  scopeShort: string;
  quotaLabel: string;
  /** Remaining share 0..100 for simulator tie-break (higher is fresher; 100 for unlimited/unknown). */
  quotaRemain: number;
  maxRuns: number | null;
  availableMachines: string[];
  allMachines: boolean;
  /** Underlying login IDs belonging to this logical account (for legacy dispatch_order derivation). */
  loginIds: string[];
  /** Per-tier support map derived from underlying logins' configured tiers (true for all if none declared). */
  supportedTiers: Record<TierId, boolean>;
}

function usageSummaryOf(usage: NonNullable<Account['status']>['usage']): { label: string; remain: number } {
  if (usage.length === 0) return { label: '按量/无窗', remain: 100 };
  for (const item of usage) {
    const special = formatSpecialQuotaLabel(item.window);
    if (special) return { label: `${special.label} ${special.value}`, remain: 100 };
  }
  let peak = usage[0]!;
  for (const item of usage) {
    if (item.used > peak.used) peak = item;
  }
  const remain = Math.max(0, Math.min(100, Math.round((1 - peak.used) * 100)));
  const prefix = peak.window === 'five_hour' ? '5h' : peak.window === 'seven_day' ? '7d' : '窗口';
  return { label: `${prefix} 剩 ${remain}%`, remain };
}

function supportedTiersOf(tiersList: readonly (Record<string, { kind: string; text: string } | undefined> | undefined)[]): Record<TierId, boolean> {
  const hasAny = tiersList.some((raw) => raw && Object.keys(raw).length > 0);
  if (!hasAny) return { operate: true, execute: true, decide: true };
  const supports = (tierId: TierId): boolean =>
    tiersList.some((raw) => {
      if (!raw) return false;
      return tierValueFrom(raw, tierId) !== undefined || Boolean(raw[tierId]);
    });
  return {
    operate: supports('operate'),
    execute: supports('execute'),
    decide: supports('decide'),
  };
}

// Map machine-local login IDs that are provably the exact same subscription account as a
// centralized `全机分发` account (via confirmed `login_groups` or identical non-empty
// `(executor, account_label)` without a distinct route) -> that centralized account's id.
export function coveredMachineLoginsByAccount(page: AccountsAndMachines): Map<string, string> {
  const map = new Map<string, string>();
  const accountById = new Map(page.accounts.map((a) => [a.id, a]));
  for (const group of page.login_groups ?? []) {
    const central = group.find((id) => accountById.has(id));
    if (!central) continue;
    for (const id of group) {
      if (id !== central && !accountById.has(id)) map.set(id, central);
    }
  }
  for (const machine of page.machines) {
    for (const login of machine.logins ?? []) {
      if (!login.configured || !login.id || map.has(login.id)) continue;
      const label = login.account_label?.trim().toLowerCase();
      if (!label) continue;
      const route = effectiveRouteOfLogin({ routeLabel: login.route_label, tiers: login.tiers });
      if (route) continue;
      const matched = page.accounts.find((a) =>
        a.executor === login.executor
        && a.account_label?.trim().toLowerCase() === label
        && !a.provider?.line,
      );
      if (matched) map.set(login.id, matched.id);
    }
  }
  return map;
}

export function buildLogicalAccountEntries(
  page: AccountsAndMachines,
  usageByAccount?: ReadonlyMap<string, NonNullable<Account['status']>['usage']>,
  options?: { allowedLoginIds?: ReadonlySet<string> | null },
): LogicalAccountEntry[] {
  const allowed = options?.allowedLoginIds ?? null;
  const entries: LogicalAccountEntry[] = [];
  const onlineMachines = (page.machines ?? []).filter((m) => Boolean(m.node?.connected)).map((m) => m.id);
  const covered = coveredMachineLoginsByAccount(page);
  const entryByAccountId = new Map<string, LogicalAccountEntry>();

  for (const account of page.accounts) {
    if (allowed !== null && !allowed.has(account.id)) continue;
    const usage = usageByAccount?.get(account.id) ?? account.status?.usage ?? [];
    const q = usageSummaryOf(usage);
    const identityHint = [account.account_label, account.plan_label].filter(Boolean).join(' · ') || null;
    const entry: LogicalAccountEntry = {
      key: logicalAccountKey({ id: account.id, executor: account.executor, machine: null }),
      name: account.name,
      identityHint,
      executor: account.executor,
      route: account.provider?.line ?? null,
      scopeShort: '全机分发',
      quotaLabel: q.label,
      quotaRemain: q.remain,
      maxRuns: account.max_runs ?? null,
      availableMachines: onlineMachines,
      allMachines: true,
      loginIds: [account.id],
      supportedTiers: supportedTiersOf([account.tiers]),
    };
    entries.push(entry);
    entryByAccountId.set(account.id, entry);
  }

  const aliases = page.login_aliases ?? {};
  // Group machine-authorized logins by (executor, effective route/provider) so identical
  // multi-machine logins stay collapsed into 1 row while distinct routes/providers (e.g. office
  // LAN `lan-gw` vs paid `deepseek-official`) naturally split into independent priority rows.
  const byLogicalKey = new Map<string, { executor: string; route: string | null; members: { machine: Machine; login: MachineLogin }[] }>();
  for (const machine of page.machines) {
    for (const login of machine.logins ?? []) {
      if (!login.configured || !login.id) continue;
      if (allowed !== null && !allowed.has(login.id)) continue;
      const parentAccountId = covered.get(login.id);
      if (parentAccountId) {
        const parentEntry = entryByAccountId.get(parentAccountId);
        if (parentEntry) {
          if (!parentEntry.loginIds.includes(login.id)) parentEntry.loginIds.push(login.id);
          continue;
        }
      }
      const route = effectiveRouteOfLogin({ routeLabel: login.route_label, tiers: login.tiers });
      const key = logicalAccountKey({ id: login.id, executor: login.executor, machine: machine.id, route });
      const existing = byLogicalKey.get(key);
      if (existing) {
        existing.members.push({ machine, login });
        if (!existing.route && route) existing.route = route;
      } else {
        byLogicalKey.set(key, { executor: login.executor, route, members: [{ machine, login }] });
      }
    }
  }

  for (const [key, bucket] of byLogicalKey) {
    const { executor, route, members } = bucket;
    const provider = formatProviderName(executor);
    const first = members[0]!;
    const routes = [...new Set(members.map((m) => effectiveRouteOfLogin({ routeLabel: m.login.route_label, tiers: m.login.tiers })).filter((r): r is string => Boolean(r)))];
    const accounts = [...new Set(members.map((m) => m.login.account_label).filter((a): a is string => Boolean(a)))];
    const plans = [...new Set(members.map((m) => m.login.plan_label).filter((p): p is string => Boolean(p)))];
    const idNorm = accounts.length === 1 ? accounts[0]!.trim().toLowerCase() : '';
    const routeNorm = route ? route.toLowerCase() : '';
    const groupSuffix = [idNorm, routeNorm].filter(Boolean).join(':');
    const canonicalGroupKey = groupSuffix ? `/group/${executor}:${groupSuffix}` : `/group/${executor}`;
    const routeOnlyGroupKey = routeNorm ? `/group/${executor}:${routeNorm}` : `/group/${executor}`;
    const groupAlias = aliases[canonicalGroupKey]
      ?? aliases[routeOnlyGroupKey]
      ?? (routeNorm ? aliases[`group:${executor}:${routeNorm}`] : undefined)
      ?? (routes.length === 0 ? (aliases[`/group/${executor}`] ?? aliases[`group:${executor}`]) : undefined);
    const singleAlias = members.length === 1 ? (first.login.display_name || (first.login.id ? aliases[first.login.id] : undefined)) : undefined;
    const label = singleAlias
      ?? groupAlias
      ?? (members.length === 1 && first.login.account_label
        ? first.login.account_label
        : route
          ? `${provider} · ${route}`
          : routes.length === 1
            ? `${provider} · ${routes[0]}`
            : provider);
    const machineNames = members.map((m) => m.machine.id);
    const identityHint = [
      ...(accounts.length === 1 && accounts[0] !== label ? [accounts[0]] : []),
      ...(plans.length === 1 ? [plans[0]] : []),
      ...(route && !label.includes(route) ? [`线路 ${route}`] : []),
      ...(members.length === 1 && route ? [machineNames[0]] : []),
    ].join(' · ') || null;
    const online = members.filter((m) => Boolean(m.machine.node?.connected)).map((m) => m.machine.id);
    const freshest = latestQuota(members, (m) => m.login.status?.usage ?? []).login.status?.usage ?? [];
    const q = usageSummaryOf(freshest);
    const maxRuns = members.map((m) => m.login.max_runs).find((v): v is number => typeof v === 'number' && v > 0) ?? null;
    entries.push({
      key,
      name: label,
      identityHint,
      executor,
      route,
      scopeShort: `${online.length}/${members.length} 台`,
      quotaLabel: q.label,
      quotaRemain: q.remain,
      maxRuns,
      availableMachines: online,
      allMachines: false,
      loginIds: members.map((m) => m.login.id!).filter(Boolean),
      supportedTiers: supportedTiersOf(members.map((m) => m.login.tiers)),
    });
  }

  return entries;
}

export function effectiveSlotsByTier(
  page: AccountsAndMachines,
  entries: readonly LogicalAccountEntry[],
  overrideSlots?: DispatchSlotsConfig | null,
  overrideLegacyOrder?: Partial<Record<TierId, string[]>> | null,
): Record<TierId, TierDispatchSlots> {
  const keys = entries.map((e) => e.key);
  const idToKey = new Map<string, string>();
  for (const entry of entries) {
    idToKey.set(entry.key, entry.key);
    for (const id of entry.loginIds) idToKey.set(id, entry.key);
  }
  const out = {} as Record<TierId, TierDispatchSlots>;
  for (const tier of TIERS) {
    const rawLegacy = overrideLegacyOrder?.[tier.id] ?? page.dispatch_order?.[tier.id] ?? [];
    const legacyKeys: string[] = [];
    const seen = new Set<string>();
    for (const id of rawLegacy) {
      const k = idToKey.get(id);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      legacyKeys.push(k);
    }
    const configured = overrideSlots?.[tier.id] ?? (overrideLegacyOrder?.[tier.id] ? undefined : page.dispatch_slots?.[tier.id]);
    out[tier.id] = deriveEffectiveTierSlots(keys, configured, legacyKeys);
  }
  return out;
}

export function DispatchSlotsPanel({
  page,
  entries,
  slotsByTier,
  busy,
  error,
  onSaveTier,
  compact = false,
  hideSimulator = false,
  showTierSupport = false,
  ariaLabel = '各档位全局默认派发策略',
  hint,
}: {
  page: AccountsAndMachines;
  entries: readonly LogicalAccountEntry[];
  slotsByTier: Record<TierId, TierDispatchSlots>;
  busy: boolean;
  error?: string | null;
  onSaveTier: (tier: TierId, next: TierDispatchSlots) => void;
  compact?: boolean;
  hideSimulator?: boolean;
  showTierSupport?: boolean;
  ariaLabel?: string;
  hint?: ReactNode;
}) {
  const { locale, t, bi } = useI18n();
  const [simOpen, setSimOpen] = useState(false);
  const [simTier, setSimTier] = useState<TierId>('decide');
  const [simMachine, setSimMachine] = useState<string>('any');
  const [simBusy, setSimBusy] = useState<Record<string, number>>({});

  const entryMap = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const machineOptions = useMemo(() => (page.machines ?? []).map((m) => ({ id: m.id, online: Boolean(m.node?.connected) })), [page.machines]);

  function slotOf(tier: TierId, key: string): DispatchSlotName {
    const s = slotsByTier[tier];
    if (s.p1.includes(key)) return 'p1';
    if (s.off.includes(key)) return 'off';
    return 'p2';
  }

  function moveKey(tier: TierId, accountKey: string, target: DispatchSlotName): void {
    const current = slotsByTier[tier];
    const next: TierDispatchSlots = {
      p1: current.p1.filter((k) => k !== accountKey),
      p2: current.p2.filter((k) => k !== accountKey),
      off: current.off.filter((k) => k !== accountKey),
    };
    next[target].push(accountKey);
    onSaveTier(tier, next);
  }

  const simulation = useMemo(() => {
    const tierSlots = slotsByTier[simTier];
    const eligible = (entry: LogicalAccountEntry): boolean => {
      if (simMachine === 'any') return entry.allMachines ? entry.availableMachines.length > 0 || page.machines.length === 0 : entry.availableMachines.length > 0;
      return entry.allMachines || entry.availableMachines.includes(simMachine);
    };

    for (const [slotName, keys] of [['P1', tierSlots.p1], ['P2', tierSlots.p2]] as const) {
      const candidates = keys
        .map((k) => entryMap.get(k))
        .filter((e): e is LogicalAccountEntry => e !== undefined && eligible(e))
        .filter((e) => e.maxRuns === null || (simBusy[e.key] ?? 0) < e.maxRuns);
      if (candidates.length > 0) {
        const sorted = [...candidates].sort((a, b) => {
          const activeDiff = (simBusy[a.key] ?? 0) - (simBusy[b.key] ?? 0);
          if (activeDiff !== 0) return activeDiff;
          return b.quotaRemain - a.quotaRemain;
        });
        const winner = sorted[0]!;
        const host = simMachine === 'any'
          ? (winner.availableMachines[0] ?? '任一在线机器')
          : simMachine;
        return {
          ok: true as const,
          slot: slotName,
          winner,
          host,
          reason: candidates.length > 1
            ? `同属 ${slotName} 槽并行均衡：活跃最少（${simBusy[winner.key] ?? 0} 轮）且剩额更优（${winner.quotaLabel}）`
            : slotName === 'P2'
              ? 'P1 槽无可用或已满载，自动降级至 P2'
              : '命中 P1 主力槽',
        };
      }
    }
    return {
      ok: false as const,
      reason: '当前条件下 P1 / P2 槽均无可用候选，任务将等待容量释放。',
    };
  }, [slotsByTier, simTier, simMachine, simBusy, entryMap, page.machines.length]);

  const showSim = !hideSimulator && entries.length > 0;

  return (
    <section aria-label={ariaLabel} className={cn('space-y-3', !compact && 'max-w-[960px]')}>
      {/* Compact single-line principle hint */}
      {hint !== null ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <SlidersHorizontal className="size-3.5 text-primary" aria-hidden="true" />
          <span>
            {hint ?? (
              <>
                <strong className="font-medium text-foreground">P1 主力槽</strong>内按「最少活跃并发 → 剩余额度优先」自动均衡；全满或冷却时降级至 <strong className="font-medium text-foreground">P2 备选槽</strong>；同执行器不同线路（如内网与官网）会自动拆行独立设槽。
              </>
            )}
          </span>
        </p>
      ) : null}

      {error ? <Problem role="alert">{error}</Problem> : null}

      {/* Flat, border-light Routing Matrix */}
      <div className={cn('overflow-hidden rounded-xl border border-border bg-raised', !compact && 'shadow-card')}>
        {/* Matrix Header (desktop) */}
        <div className={cn(
          'hidden items-center gap-2 border-b border-border bg-muted/55 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid',
          compact ? 'grid-cols-[minmax(0,1fr)_112px_112px_112px]' : 'grid-cols-[minmax(0,1fr)_128px_128px_128px]',
        )}>
          <span>{t('slots.headerAccount')}</span>
          {TIERS.map((tier) => (
            <span key={tier.id} className="text-center">{tierDisplayLabel(tier.id, locale)}</span>
          ))}
        </div>

        {/* Account Rows */}
        {entries.length > 0 ? (
          <div className="divide-y divide-border/70">
            {entries.map((entry) => (
              <div
                key={entry.key}
                className={cn(
                  'grid grid-cols-1 items-center gap-2.5 px-4 transition-colors hover:bg-hover/35 sm:gap-2',
                  compact ? 'py-2.5 sm:grid-cols-[minmax(0,1fr)_112px_112px_112px]' : 'py-3 sm:grid-cols-[minmax(0,1fr)_128px_128px_128px]',
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Dot tone={entry.availableMachines.length > 0 || page.machines.length === 0 ? 'success' : 'waiting'} />
                    <span className="truncate text-sm font-semibold text-foreground">{entry.name}</span>
                    <span className="flex-none rounded bg-hover/80 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                      {entry.executor}
                    </span>
                    <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                      {entry.scopeShort}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate pl-4 text-xs text-muted-foreground tabular-nums">
                    {[entry.identityHint, entry.quotaLabel].filter(Boolean).join(' · ')}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 sm:contents">
                  {TIERS.map((tier) => {
                    const supported = !showTierSupport || entry.supportedTiers[tier.id];
                    const current = slotOf(tier.id, entry.key);
                    return (
                      <div key={tier.id} className="flex flex-col items-center gap-1 sm:justify-center">
                        <span className="text-2xs text-muted-foreground sm:hidden">{tier.label}</span>
                        {!supported ? (
                          <span className="text-2xs text-faint">未配档位</span>
                        ) : (
                          <div
                            role="group"
                            aria-label={`${tier.label} ${entry.name} 槽位`}
                            className="inline-flex items-center rounded-md border border-border bg-muted/70 p-0.5 text-2xs"
                          >
                            {([
                              ['p1', 'P1'],
                              ['p2', 'P2'],
                              ['off', '停'],
                            ] as const).map(([slotKey, label]) => {
                              const active = current === slotKey;
                              return (
                                <button
                                  key={slotKey}
                                  type="button"
                                  disabled={busy}
                                  aria-pressed={active}
                                  aria-label={`把 ${entry.name} 设为 ${label}`}
                                  onClick={() => { if (!active) moveKey(tier.id, entry.key, slotKey); }}
                                  className={cn(
                                    'cursor-pointer rounded px-2 py-0.5 font-mono transition-colors disabled:opacity-50',
                                    active
                                      ? slotKey === 'p1'
                                        ? 'bg-primary font-semibold text-primary-foreground'
                                        : slotKey === 'p2'
                                          ? 'bg-waiting-soft font-semibold text-waiting-foreground'
                                          : 'bg-raised font-semibold text-foreground shadow-xs'
                                      : 'text-muted-foreground hover:text-foreground',
                                  )}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-4 py-4 text-xs text-muted-foreground">暂无可用的登录或渠道。</p>
        )}

        {/* Built-in Live Effective Topology Footer — 3-column tier-aligned cards */}
        <div className="space-y-3 border-t border-border bg-muted/35 px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-muted-foreground">{t('slots.effectiveTitle')}</span>
            {showSim ? (
              <button
                type="button"
                aria-expanded={simOpen}
                onClick={() => setSimOpen((prev) => !prev)}
                className="inline-flex flex-none cursor-pointer items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                {simOpen ? t('slots.simClose') : t('slots.simOpen')}
                <ChevronDown aria-hidden="true" className={cn('size-3.5 transition-transform duration-150', simOpen && 'rotate-180')} />
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
            {TIERS.map((tier) => {
              const s = slotsByTier[tier.id];
              const p1 = s.p1
                .map((k) => entryMap.get(k))
                .filter((e): e is LogicalAccountEntry => e !== undefined && (!showTierSupport || e.supportedTiers[tier.id]))
                .map((e) => e.name);
              const p2 = s.p2
                .map((k) => entryMap.get(k))
                .filter((e): e is LogicalAccountEntry => e !== undefined && (!showTierSupport || e.supportedTiers[tier.id]))
                .map((e) => e.name);
              const tierTitle = tierDisplayLabel(tier.id, locale);
              const modeLabel = p1.length >= 2
                ? t('slots.modeBalanced', { count: p1.length })
                : p1.length === 1
                  ? t('slots.modeSingle')
                  : t('slots.modeEmpty');
              return (
                <div
                  key={tier.id}
                  role="region"
                  aria-label={bi(`${tier.label}派发槽位`, `${tierTitle} dispatch slots`)}
                  className="flex flex-col gap-2 rounded-lg border border-border/80 bg-raised/90 p-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{tierTitle}</span>
                    <span className={cn(
                      'rounded-full px-1.5 py-0.5 text-2xs font-medium',
                      p1.length >= 2
                        ? 'bg-brand-soft text-brand-foreground'
                        : 'bg-muted text-muted-foreground',
                    )}>
                      {modeLabel}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="mr-0.5 flex-none font-mono text-2xs font-semibold text-primary">P1</span>
                      {p1.length > 0 ? (
                        p1.map((name) => (
                          <span
                            key={name}
                            className="max-w-full truncate rounded border border-brand-border bg-brand-soft px-1.5 py-0.5 font-medium text-brand-foreground"
                            title={name}
                          >
                            {name}
                          </span>
                        ))
                      ) : (
                        <span className="text-2xs text-faint">{t('slots.noPrimary')}</span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1 border-t border-border/50 pt-1.5">
                      <span className="mr-0.5 inline-flex flex-none items-center gap-0.5 font-mono text-2xs text-muted-foreground">
                        <ArrowDown className="size-2.5 text-faint" aria-hidden="true" />
                        P2
                      </span>
                      {p2.length > 0 ? (
                        p2.map((name) => (
                          <span
                            key={name}
                            className="max-w-full truncate rounded border border-waiting-border bg-waiting-soft px-1.5 py-0.5 text-waiting-foreground"
                            title={name}
                          >
                            {name}
                          </span>
                        ))
                      ) : (
                        <span className="text-2xs text-faint">{t('slots.noFallback')}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Collapsible Compact Simulator Drawer */}
      {showSim && simOpen ? (
        <div className="space-y-2.5 rounded-xl border border-border bg-raised px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-muted-foreground">
                目标机器
                <select
                  aria-label="模拟目标机器"
                  value={simMachine}
                  onChange={(e) => setSimMachine(e.target.value)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                >
                  <option value="any">不限机器（自动负载均衡）</option>
                  {machineOptions.map((m) => (
                    <option key={m.id} value={m.id}>{`限定 ${m.id}${m.online ? '' : '（离线）'}`}</option>
                  ))}
                </select>
              </label>
              <label className="inline-flex items-center gap-1.5 text-muted-foreground">
                档位
                <select
                  aria-label="模拟任务档位"
                  value={simTier}
                  onChange={(e) => setSimTier(e.target.value as TierId)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                >
                  {TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">模拟并发：</span>
              {entries.map((entry) => {
                const cur = simBusy[entry.key] ?? 0;
                const cap = entry.maxRuns ?? 3;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => setSimBusy((prev) => ({ ...prev, [entry.key]: ((prev[entry.key] ?? 0) + 1) % (cap + 1) }))}
                    className="cursor-pointer rounded border border-border bg-background px-2 py-0.5 text-2xs tabular-nums transition-colors hover:border-primary"
                  >
                    {entry.name} <strong className="font-mono">{cur}</strong>
                  </button>
                );
              })}
              {Object.values(simBusy).some((v) => v > 0) ? (
                <button
                  type="button"
                  onClick={() => setSimBusy({})}
                  className="cursor-pointer text-2xs text-muted-foreground underline hover:text-foreground"
                >
                  归零
                </button>
              ) : null}
            </div>
          </div>

          <div
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
              simulation.ok
                ? 'border-success-border bg-success-soft text-success-foreground'
                : 'border-waiting-border bg-waiting-soft text-waiting-foreground',
            )}
          >
            <Layers className="size-3.5 flex-none" />
            <span>
              {simulation.ok
                ? <><strong>{`命中 → ${simulation.winner.name} @ ${simulation.host}（${simulation.slot} 槽）`}</strong> · {simulation.reason}</>
                : <><strong>等待容量 → </strong>{simulation.reason}</>}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
