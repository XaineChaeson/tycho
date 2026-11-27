// Logical-account priority slots per tier (P1 primary load-balanced, P2 fallback, off excluded).
// Centralized accounts keep their opaque account id; machine-authorized logins of the same
// executor and effective channel/route share one logical key (`executor:<executor>` or
// `executor:<executor>:<route>`) so identical multi-machine logins stay collapsed into one row
// while distinct routes/providers (e.g. office LAN `lan-gw` vs paid `deepseek-official`)
// naturally split into independent priority slots.
import { t } from './i18n.ts';
import { TIER_IDS, type TierId } from './tiers.ts';

export type DispatchSlotName = 'p1' | 'p2' | 'off';

export interface TierDispatchSlots {
  p1: string[];
  p2: string[];
  off: string[];
}

export type DispatchSlotsConfig = Partial<Record<TierId, TierDispatchSlots>>;

export const DISPATCH_SLOTS_SETTING_KEY = 'dispatch_slots_v1';

const TIER_PROVIDER_LINE = /^\s*["']?provider["']?\s*[:=]\s*["']?([A-Za-z0-9._:/-]+)["']?\s*,?\s*(?:#.*)?$/gm;

export interface SlotLoginLike {
  id: string;
  executor: string;
  machine?: string | null;
  route?: string | null;
  routeLabel?: string | null;
  route_label?: string | null;
  tiers?: Record<string, { text?: string } | undefined> | null;
}

export function normalizeRouteKey(route: string | null | undefined): string | null {
  if (typeof route !== 'string') return null;
  const trimmed = route.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function providersInTierText(text: string | undefined): string[] {
  if (typeof text !== 'string' || !text.includes('provider')) return [];
  const providers: string[] = [];
  TIER_PROVIDER_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIER_PROVIDER_LINE.exec(text)) !== null) {
    const value = match[1]?.trim();
    if (value && !providers.includes(value)) providers.push(value);
  }
  return providers;
}

// Extract the effective route/provider of a login: when `tier` is given, that tier's explicit
// `provider` takes priority so multi-provider tiers route independently; otherwise a single
// consistent tier `provider` wins over the machine-reported default `routeLabel`.
export function effectiveRouteOfLogin(
  login: {
    route?: string | null;
    routeLabel?: string | null;
    route_label?: string | null;
    tiers?: Record<string, { text?: string } | undefined> | null;
  },
  tier?: TierId | null,
): string | null {
  if (typeof login.route === 'string') {
    const trimmed = login.route.trim();
    if (trimmed) return trimmed;
  }
  if (tier && login.tiers && typeof login.tiers === 'object') {
    const tierProviders = providersInTierText(login.tiers[tier]?.text);
    if (tierProviders.length === 1) return tierProviders[0]!;
  }
  const providers: string[] = [];
  if (login.tiers && typeof login.tiers === 'object') {
    for (const entry of Object.values(login.tiers)) {
      for (const value of providersInTierText(entry?.text)) {
        if (!providers.includes(value)) providers.push(value);
      }
    }
  }
  if (providers.length === 1) return providers[0]!;
  const reported = (login.routeLabel ?? login.route_label)?.trim();
  return reported || null;
}

export function logicalAccountKey(login: SlotLoginLike, tier?: TierId | null): string {
  if (!login.machine) return login.id;
  const route = normalizeRouteKey(login.route !== undefined ? login.route : effectiveRouteOfLogin(login, tier));
  return route ? `executor:${login.executor}:${route}` : `executor:${login.executor}`;
}

export function parseExecutorSlotKey(key: string): { executor: string; route: string | null } | null {
  if (!key.startsWith('executor:')) return null;
  const rest = key.slice('executor:'.length);
  if (!rest) return null;
  const sep = rest.indexOf(':');
  if (sep < 0) return { executor: rest, route: null };
  const executor = rest.slice(0, sep);
  const route = normalizeRouteKey(rest.slice(sep + 1));
  return executor ? { executor, route } : null;
}

export function isExecutorSlotKey(key: string): boolean {
  return parseExecutorSlotKey(key) !== null;
}

export function executorOfSlotKey(key: string): string | null {
  return parseExecutorSlotKey(key)?.executor ?? null;
}

function dedupeStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// Normalize a single tier's slots so every key appears in at most one slot (p1 > p2 > off).
export function normalizeTierSlots(raw: unknown): TierDispatchSlots | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.p1 === undefined && obj.p2 === undefined && obj.off === undefined) return null;
  const seen = new Set<string>();
  const take = (list: unknown): string[] => {
    const out: string[] = [];
    for (const key of dedupeStrings(list)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  };
  return {
    p1: take(obj.p1),
    p2: take(obj.p2),
    off: take(obj.off),
  };
}

export function normalizeDispatchSlotsConfig(raw: unknown): DispatchSlotsConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out: DispatchSlotsConfig = {};
  for (const tier of TIER_IDS) {
    const normalized = normalizeTierSlots(obj[tier]);
    if (normalized) out[tier] = normalized;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parseDispatchSlots(raw: string | null | undefined): DispatchSlotsConfig | null {
  if (!raw) return null;
  try {
    return normalizeDispatchSlotsConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Parse project `dispatch_order_json`, supporting both new priority-slot configs (per-tier
// `{ p1, p2, off }` objects) and legacy linear login-id arrays (`string[]`) seamlessly without
// a database migration.
export function parseProjectDispatchConfig(raw: string | null | undefined): {
  slots: DispatchSlotsConfig | null;
  order: Partial<Record<TierId, string[]>> | null;
} {
  if (!raw) return { slots: null, order: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { slots: null, order: null };
    const obj = parsed as Record<string, unknown>;
    const slots: DispatchSlotsConfig = {};
    const order: Partial<Record<TierId, string[]>> = {};
    for (const tier of TIER_IDS) {
      const value = obj[tier];
      if (Array.isArray(value)) {
        const unique = dedupeStrings(value);
        if (unique.length > 0) order[tier] = unique;
      } else {
        const normalized = normalizeTierSlots(value);
        if (normalized) slots[tier] = normalized;
      }
    }
    return {
      slots: Object.keys(slots).length > 0 ? slots : null,
      order: Object.keys(order).length > 0 ? order : null,
    };
  } catch {
    return { slots: null, order: null };
  }
}

// Resolve a login's slot within a tier's configured slots, matching from most specific to broadest:
//   1. Exact login.id
//   2. Route-qualified logical key (`executor:<executor>:<route>`)
//   3. Legacy executor-wide logical key (`executor:<executor>`)
// Unmentioned logical keys default to slot 2 (safe fallback) so newly added accounts work
// immediately without unexpectedly hijacking P1.
export function slotForLogin(
  login: SlotLoginLike,
  tierSlots: TierDispatchSlots | undefined,
  extraKeys: readonly string[] = [],
  tier?: TierId | null,
): 1 | 2 | 'off' | undefined {
  if (!tierSlots) return undefined;
  const candidates: string[] = [login.id];
  for (const key of extraKeys) {
    if (key && !candidates.includes(key)) candidates.push(key);
  }
  const specific = logicalAccountKey(login, tier);
  if (!candidates.includes(specific)) candidates.push(specific);
  if (login.machine) {
    const broad = `executor:${login.executor}`;
    if (!candidates.includes(broad)) candidates.push(broad);
  }
  for (const key of candidates) {
    if (tierSlots.off.includes(key)) return 'off';
    if (tierSlots.p1.includes(key)) return 1;
    if (tierSlots.p2.includes(key)) return 2;
  }
  return 2;
}

// Derive a clean default P1/P2 slot view from configured slots (with smooth inheritance from
// legacy broad `executor:<exec>` keys to route-split keys `executor:<exec>:<route>`) or from
// legacy linear dispatch_order when explicit slots have not yet been saved.
export function deriveEffectiveTierSlots(
  logicalKeys: readonly string[],
  configured: TierDispatchSlots | undefined,
  legacyOrder: readonly string[] = [],
): TierDispatchSlots {
  const known = new Set(logicalKeys);
  if (configured) {
    const p1 = configured.p1.filter((k) => known.has(k));
    const p2 = configured.p2.filter((k) => known.has(k));
    const off = configured.off.filter((k) => known.has(k));
    const placed = new Set([...p1, ...p2, ...off]);
    for (const key of logicalKeys) {
      if (placed.has(key)) continue;
      const parsed = parseExecutorSlotKey(key);
      if (parsed?.route) {
        const broad = `executor:${parsed.executor}`;
        if (configured.off.includes(broad)) {
          off.push(key);
          continue;
        }
        if (configured.p1.includes(broad)) {
          p1.push(key);
          continue;
        }
        if (configured.p2.includes(broad)) {
          p2.push(key);
          continue;
        }
      }
      p2.push(key);
    }
    return { p1, p2, off };
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of [...legacyOrder, ...logicalKeys]) {
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  if (ordered.length === 0) return { p1: [], p2: [], off: [] };
  return {
    p1: [ordered[0]!],
    p2: ordered.slice(1),
    off: [],
  };
}

export function sameTierSlots(a: TierDispatchSlots | undefined, b: TierDispatchSlots | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const sameList = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  return sameList(a.p1, b.p1) && sameList(a.p2, b.p2) && sameList(a.off, b.off);
}

export function sameDispatchSlotsConfig(a: DispatchSlotsConfig | null | undefined, b: DispatchSlotsConfig | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return TIER_IDS.every((tier) => sameTierSlots(a[tier], b[tier]));
}

// Human-readable execution permission descriptions across all four executors.
export function executionPermissionSummary(executor: string, permissionMode: string | null | undefined): {
  mode: string;
  label: string;
  autoFullAccess: boolean;
} {
  const raw = permissionMode?.trim() || null;
  if (executor === 'claude') {
    const mode = raw ?? 'bypassPermissions';
    if (mode === 'bypassPermissions') return { mode, label: t('sh.dispatchSlots.perm.fullAuto'), autoFullAccess: true };
    if (mode === 'acceptEdits') return { mode, label: t('sh.dispatchSlots.perm.claudeAcceptEdits'), autoFullAccess: false };
    if (mode === 'plan') return { mode, label: t('sh.dispatchSlots.perm.planReadOnly'), autoFullAccess: false };
    return { mode, label: t('sh.dispatchSlots.perm.custom', { mode }), autoFullAccess: false };
  }
  if (executor === 'gemini') {
    const mode = raw ?? 'dangerously-skip-permissions';
    if (mode === 'dangerously-skip-permissions') return { mode, label: t('sh.dispatchSlots.perm.geminiFullAuto'), autoFullAccess: true };
    if (mode === 'accept-edits') return { mode, label: t('sh.dispatchSlots.perm.geminiAcceptEdits'), autoFullAccess: false };
    if (mode === 'plan') return { mode, label: t('sh.dispatchSlots.perm.planReadOnly'), autoFullAccess: false };
    return { mode, label: t('sh.dispatchSlots.perm.geminiNative', { mode }), autoFullAccess: false };
  }
  if (executor === 'dsh') {
    const mode = raw ?? 'danger-full-access';
    if (mode === 'danger-full-access') return { mode, label: t('sh.dispatchSlots.perm.fullAuto'), autoFullAccess: true };
    if (mode === 'workspace-write') return { mode, label: t('sh.dispatchSlots.perm.workspaceWrite'), autoFullAccess: false };
    if (mode === 'read-only') return { mode, label: t('sh.dispatchSlots.perm.readOnly'), autoFullAccess: false };
    return { mode, label: t('sh.dispatchSlots.perm.custom', { mode }), autoFullAccess: false };
  }
  if (executor === 'codex') {
    const mode = raw ?? 'danger-full-access';
    if (mode === 'danger-full-access') return { mode, label: t('sh.dispatchSlots.perm.codexFullAuto'), autoFullAccess: true };
    if (mode === 'inherit-machine') return { mode, label: t('sh.dispatchSlots.perm.codexInherit'), autoFullAccess: false };
    if (mode === 'workspace-write') return { mode, label: t('sh.dispatchSlots.perm.workspaceWrite'), autoFullAccess: false };
    if (mode === 'read-only') return { mode, label: t('sh.dispatchSlots.perm.readOnly'), autoFullAccess: false };
    return { mode, label: t('sh.dispatchSlots.perm.custom', { mode }), autoFullAccess: false };
  }
  return { mode: raw ?? 'default', label: raw ?? t('sh.dispatchSlots.perm.executorDefault'), autoFullAccess: true };
}
