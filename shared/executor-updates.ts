// Shared types and helpers for Multi-Machine CLI Fleet Updates (version matrix,
// idle-safe remote executor CLI upgrades, and optional scheduled auto-update policy).
import { compareVersions, versionOf } from '../adapters/version.ts';
export { compareVersions, versionOf };

export const EXECUTOR_AUTO_UPDATE_SETTING_KEY = 'executor_auto_update_policy';
export const EXECUTOR_UPDATE_HISTORY_MAX = 30;
export const EXECUTOR_UPDATE_OUTPUT_MAX_CHARS = 3072;

export interface ExecutorAutoUpdatePolicy {
  // Master switch for scheduled automatic updates (off by default).
  enabled: boolean;
  // How often to check upstream versions & run idle auto-updates (hours, clamped 1..168).
  intervalHours: number;
  // Optional daily maintenance window in host local hours (0..23).
  // When windowStartHour === windowEndHour, updates may run at any idle hour.
  windowStartHour: number;
  windowEndHour: number;
  // Per-executor opt-in map (e.g. { codex: true, claude: true, gemini: false, dsh: false }).
  executors: Record<string, boolean>;
}

export const DEFAULT_EXECUTOR_AUTO_UPDATE_POLICY: ExecutorAutoUpdatePolicy = {
  enabled: false,
  intervalHours: 24,
  windowStartHour: 2,
  windowEndHour: 6,
  executors: {},
};

export function normalizeExecutorAutoUpdatePolicy(raw: unknown): ExecutorAutoUpdatePolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_EXECUTOR_AUTO_UPDATE_POLICY, executors: {} };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled === true;
  const rawHours = typeof obj.intervalHours === 'number' && Number.isFinite(obj.intervalHours) ? Math.round(obj.intervalHours) : 24;
  const intervalHours = Math.max(1, Math.min(168, rawHours));
  const clampHour = (value: unknown, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const rounded = Math.floor(value);
    return ((rounded % 24) + 24) % 24;
  };
  const windowStartHour = clampHour(obj.windowStartHour, 2);
  const windowEndHour = clampHour(obj.windowEndHour, 6);
  const executors: Record<string, boolean> = {};
  if (obj.executors && typeof obj.executors === 'object' && !Array.isArray(obj.executors)) {
    for (const [key, value] of Object.entries(obj.executors as Record<string, unknown>)) {
      const k = key.trim();
      if (k !== '' && typeof value === 'boolean') executors[k] = value;
    }
  }
  return { enabled, intervalHours, windowStartHour, windowEndHour, executors };
}

export function parseExecutorAutoUpdatePolicy(raw: string | undefined | null): ExecutorAutoUpdatePolicy {
  if (!raw) return { ...DEFAULT_EXECUTOR_AUTO_UPDATE_POLICY, executors: {} };
  try {
    return normalizeExecutorAutoUpdatePolicy(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_EXECUTOR_AUTO_UPDATE_POLICY, executors: {} };
  }
}

export function inMaintenanceWindow(policy: Pick<ExecutorAutoUpdatePolicy, 'windowStartHour' | 'windowEndHour'>, date: Date = new Date()): boolean {
  const start = ((Math.floor(policy.windowStartHour) % 24) + 24) % 24;
  const end = ((Math.floor(policy.windowEndHour) % 24) + 24) % 24;
  if (start === end) return true;
  const hour = date.getHours();
  if (start < end) return hour >= start && hour < end;
  // Wraps across midnight, e.g. 23 -> 5
  return hour >= start || hour < end;
}

export type ExecutorUpdateState = 'waiting_idle' | 'updating' | 'succeeded' | 'failed';
export type ExecutorUpdateTrigger = 'manual' | 'auto';

export interface ExecutorUpdateJobView {
  id: string;
  machine_id: string;
  executor: string;
  trigger: ExecutorUpdateTrigger;
  state: ExecutorUpdateState;
  method: string | null;
  before_version: string | null;
  after_version: string | null;
  updated: boolean;
  error: string | null;
  output: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface UpstreamVersionInfo {
  executor: string;
  latest: string | null;
  source: string | null;
  checked_at: string;
  error: string | null;
}

export interface ExecutorFleetStatus {
  policy: ExecutorAutoUpdatePolicy;
  upstream: Record<string, UpstreamVersionInfo>;
  jobs: ExecutorUpdateJobView[];
  active_by_key: Record<string, ExecutorUpdateJobView>;
}

// Compare an installed CLI version string against a reference version (fleet max or upstream latest).
// Returns true only when both contain valid semver and installed < reference.
export function isVersionBehind(installed: string | null | undefined, reference: string | null | undefined): boolean {
  if (!installed || !reference) return false;
  const a = versionOf(installed);
  const b = versionOf(reference);
  if (!a || !b) return false;
  return compareVersions(a, b) < 0;
}

// Pick the highest semantic version string from a list of reported CLI version strings.
export function highestSemver(versions: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const raw of versions) {
    if (!raw) continue;
    const v = versionOf(raw);
    if (!v) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

export function jobKey(machineId: string, executor: string): string {
  return `${machineId}/${executor}`;
}
