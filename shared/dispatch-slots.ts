// Logical-account priority slots per tier (P1 primary load-balanced, P2 fallback, off excluded).
// Centralized accounts keep their opaque account id; machine-authorized logins of the same
// executor share one logical key (`executor:<executor>`) so machines are never split or sorted
// separately across tiers.
import { TIER_IDS, type TierId } from './tiers.ts';

export type DispatchSlotName = 'p1' | 'p2' | 'off';

export interface TierDispatchSlots {
  p1: string[];
  p2: string[];
  off: string[];
}

export type DispatchSlotsConfig = Partial<Record<TierId, TierDispatchSlots>>;

export const DISPATCH_SLOTS_SETTING_KEY = 'dispatch_slots_v1';

export function logicalAccountKey(login: { id: string; executor: string; machine?: string | null }): string {
  return login.machine ? `executor:${login.executor}` : login.id;
}

export function isExecutorSlotKey(key: string): boolean {
  return key.startsWith('executor:') && key.length > 'executor:'.length;
}

export function executorOfSlotKey(key: string): string | null {
  return isExecutorSlotKey(key) ? key.slice('executor:'.length) : null;
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
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
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

export function parseDispatchSlots(raw: string | null | undefined): DispatchSlotsConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const out: DispatchSlotsConfig = {};
    for (const tier of TIER_IDS) {
      const normalized = normalizeTierSlots(parsed[tier]);
      if (normalized) out[tier] = normalized;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

// Resolve a login's slot within a tier's configured slots.
// Unmentioned logical keys default to slot 2 (safe fallback) so newly added accounts work
// immediately without unexpectedly hijacking P1.
export function slotForLogin(
  login: { id: string; executor: string; machine?: string | null },
  tierSlots: TierDispatchSlots | undefined,
): 1 | 2 | 'off' | undefined {
  if (!tierSlots) return undefined;
  const key = logicalAccountKey(login);
  if (tierSlots.off.includes(key) || tierSlots.off.includes(login.id)) return 'off';
  if (tierSlots.p1.includes(key) || tierSlots.p1.includes(login.id)) return 1;
  if (tierSlots.p2.includes(key) || tierSlots.p2.includes(login.id)) return 2;
  return 2;
}

// Derive a clean default P1/P2 slot view from legacy linear dispatch_order when explicit slots
// have not yet been saved: the first logical account becomes P1, remaining logical accounts P2.
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
      if (!placed.has(key)) p2.push(key);
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

// Human-readable execution permission descriptions across all four executors.
export function executionPermissionSummary(executor: string, permissionMode: string | null | undefined): {
  mode: string;
  label: string;
  autoFullAccess: boolean;
} {
  const raw = permissionMode?.trim() || null;
  if (executor === 'claude') {
    const mode = raw ?? 'bypassPermissions';
    if (mode === 'bypassPermissions') return { mode, label: '完全授权（免审批 · 自动）', autoFullAccess: true };
    if (mode === 'acceptEdits') return { mode, label: '自动接受编辑（命令需受控）', autoFullAccess: false };
    if (mode === 'plan') return { mode, label: '仅规划模式（只读）', autoFullAccess: false };
    return { mode, label: `自定义模式（${mode}）`, autoFullAccess: false };
  }
  if (executor === 'gemini') {
    const mode = raw ?? 'dangerously-skip-permissions';
    if (mode === 'dangerously-skip-permissions') return { mode, label: '完全授权（跳过全部确认 · 自动）', autoFullAccess: true };
    if (mode === 'accept-edits') return { mode, label: '自动接受编辑', autoFullAccess: false };
    if (mode === 'plan') return { mode, label: '仅规划模式（只读）', autoFullAccess: false };
    return { mode, label: `原生模式（${mode}）`, autoFullAccess: false };
  }
  if (executor === 'dsh') {
    const mode = raw ?? 'danger-full-access';
    if (mode === 'danger-full-access') return { mode, label: '完全授权（免审批 · 自动）', autoFullAccess: true };
    if (mode === 'workspace-write') return { mode, label: '工作区可写（沙箱）', autoFullAccess: false };
    if (mode === 'read-only') return { mode, label: '只读模式', autoFullAccess: false };
    return { mode, label: `自定义模式（${mode}）`, autoFullAccess: false };
  }
  if (executor === 'codex') {
    const mode = raw ?? 'danger-full-access';
    if (mode === 'danger-full-access') return { mode, label: '完全授权（免审批 · 跨机一致）', autoFullAccess: true };
    if (mode === 'inherit-machine') return { mode, label: '跟随各机 ~/.codex/config.toml', autoFullAccess: false };
    if (mode === 'workspace-write') return { mode, label: '工作区可写（沙箱）', autoFullAccess: false };
    if (mode === 'read-only') return { mode, label: '只读模式', autoFullAccess: false };
    return { mode, label: `自定义模式（${mode}）`, autoFullAccess: false };
  }
  return { mode: raw ?? 'default', label: raw ?? '执行器默认权限', autoFullAccess: true };
}
