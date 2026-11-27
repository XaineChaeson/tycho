// What the usage page is told (docs/design/usage.md): the service's report of what the executors
// used, and its answer about each login's quota. Pure data, read by the service that writes it
// and the console that shows it.
import { localeMap } from './i18n.ts';
import type { LoginStatus } from './labels.ts';

// Whose use a row is: a Worker round, a Router turn, or a read of an account's quota.
export type UsageSource = 'run' | 'router' | 'quota';

// The four counts, the list price where every row had one, and how many rows had none.
export interface UsageFigures {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  list_cost_usd: number;
  unpriced: number;
}

// What one use is filed under. `role_id` and `tier` are a round's role and tier as its snapshot
// recorded them; a Router turn and a quota read have neither. `login_id` is null for the host's
// own sign-in the Router may run as. `day` is the reader's day. `project_dropped` says the use
// belonged to a project that was deleted: its project is gone, so the page shows it as a class
// of its own rather than as a use of no project (docs/design/usage.md §4).
export interface UsageDimensions {
  day: string;
  source: UsageSource;
  project_id: string | null;
  project_dropped: boolean;
  role_id: string | null;
  tier: string | null;
  login_id: string | null;
  executor: string | null;
}

// Rounds and turns, counted once whatever models they used: how many there were, how many
// came with no figure at all, and how long the rounds took from start to end.
export interface UnitCell extends UsageDimensions {
  units: number;
  without_usage: number;
  duration_ms: number;
}

// The use of one model in one cell. `units` is how many rounds or turns used it, so cells of
// the same model add up, and cells of different models do not.
export interface UsageCell extends UsageDimensions, UsageFigures {
  model: string | null;
  model_basis: 'reported' | 'tier' | null;
  units: number;
}

export interface TaskUsage extends UsageFigures {
  task_id: string;
  title: string;
  project_id: string | null;
  rounds: number;
}

// Names as the page shows them now; a login or role no longer there keeps the name it was
// used under.
export interface UsageNames {
  projects: Record<string, string>;
  roles: Record<string, string>;
  logins: Record<string, string>;
}

export interface UsageReport {
  from: string;
  to: string;
  tz_offset_minutes: number;
  units: UnitCell[];
  usage: UsageCell[];
  top_tasks: TaskUsage[];
  names: UsageNames;
}

// A login's quota as the page shows it: the figures the ledger holds (the same the accounts
// page and the pick read), and whether the host can ask for them again. A machine's own login
// is asked on its own machine (docs/design/usage.md §3): `available` then says whether that
// machine offers a reading and is here now, and the failure is the one its report named.
export interface LoginTelemetry {
  five_hour_tokens: number;
  five_hour_runs: number;
  day_tokens: number;
  day_runs: number;
  week_tokens?: number;
  week_runs?: number;
  total_tokens?: number;
  total_runs?: number;
  last_at: string | null;
}

export interface QuotaLogin {
  login_id: string;
  name: string;
  // The machine of a machine's own login; null for an account.
  machine: string | null;
  executor: string;
  status: LoginStatus;
  read: {
    available: boolean;
    why?: string;
    reading: boolean;
    tried_at: string | null;
    /** A genuine command, protocol or transport failure: shown as a problem. */
    failure: string | null;
    /** A neutral "limited, try later" from a 429 with no windows: not a failure. */
    limited?: string | null;
    /** When that suppression ends. */
    retry_at?: string | null;
  };
  // Per-login ledger token & run telemetry (5h / 24h / 7d / total), summed across merged aliases.
  telemetry?: LoginTelemetry | null;
  // Other logins positively matched to this row's subscription, read from the same organization
  // id under the same executor (a machine's own login beside the account tycho holds). The row
  // keeps the stored account's name; each alias still has its own controls on its own page.
  aliases?: QuotaAlias[];
}

// One positively matched login of a grouped row, for the page to name. Never used to hide a
// credential's own controls: the account and the machine's login remain separate there.
export interface QuotaAlias {
  login_id: string;
  name: string;
  machine: string | null;
  executor: string;
}

export interface QuotaPage {
  stale_ms: number;
  logins: QuotaLogin[];
}

// The words for what is not a project's or a role's own use.
export const USAGE_SOURCE_TEXT: Readonly<Record<Exclude<UsageSource, 'run'>, string>> = localeMap({
  router: 'sh.usage.source.router',
  quota: 'sh.usage.source.quota',
});

// Keep the whole most recently reported set, rather than mixing windows from different reads.
export function latestQuota<T>(rows: readonly T[], usage: (row: T) => LoginStatus['usage']): T {
  const at = (row: T) => Math.max(0, ...usage(row).map((figure) => Date.parse(figure.at) || 0));
  return rows.slice(1).reduce((best, row) => at(row) > at(best) ? row : best, rows[0]!);
}
