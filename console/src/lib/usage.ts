// The usage page's reading of the service's report (docs/design/usage.md §4): which range to
// ask for, and how the cells add up under the dimension the owner picked. Everything here is
// a sum of what the service sent; nothing is estimated, and what has no figure is counted as
// such rather than as zero.
import { tierLabel } from '@shared/tiers.ts';
import { USAGE_SOURCE_TEXT, type UnitCell, type UsageCell, type UsageFigures, type UsageNames, type UsageReport } from '@shared/usage.ts';

export type Dimension = 'project' | 'account' | 'model' | 'role' | 'tier' | 'login';
export type Metric = 'tokens' | 'cost';

export const DIMENSIONS: readonly { value: Dimension; label: string }[] = [
  { value: 'project', label: '项目' },
  { value: 'account', label: '账号' },
  { value: 'model', label: '模型' },
  { value: 'role', label: '职能' },
  { value: 'tier', label: '档位' },
  { value: 'login', label: '登录' },
];

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

// The last `days` days of the reader's calendar, today included, as the service is asked for
// them, and every day in it, so that a day with nothing shows as nothing.
export function rangeOf(days: Range, now: Date = new Date()): { from: string; to: string; tz: number; days: string[] } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days);
  const list: string[] = [];
  for (let at = new Date(start); at < end; at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1)) {
    list.push(`${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`);
  }
  return { from: start.toISOString(), to: end.toISOString(), tz: -now.getTimezoneOffset(), days: list };
}

export const usagePath = ({ from, to, tz }: { from: string; to: string; tz: number }): string =>
  `/api/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tz=${tz}`;

const ZERO: UsageFigures = { input: 0, output: 0, cache_read: 0, cache_write: 0, list_cost_usd: 0, unpriced: 0 };

export const tokensOf = (figures: UsageFigures): number => figures.input + figures.output + figures.cache_read + figures.cache_write;
export const metricOf = (figures: UsageFigures, metric: Metric): number => (metric === 'tokens' ? tokensOf(figures) : figures.list_cost_usd);

function add(into: UsageFigures, more: UsageFigures): UsageFigures {
  return {
    input: into.input + more.input,
    output: into.output + more.output,
    cache_read: into.cache_read + more.cache_read,
    cache_write: into.cache_write + more.cache_write,
    list_cost_usd: into.list_cost_usd + more.list_cost_usd,
    unpriced: into.unpriced + more.unpriced,
  };
}

// The key a cell is filed under for a dimension. What belongs to no project or role of its
// own (a Router turn, a quota read) has a key of its own, so it is never mixed into another;
// a use whose project was deleted is its own class, not a use of no project.
type Cell = Pick<UnitCell, 'source' | 'project_id' | 'project_dropped' | 'role_id' | 'tier' | 'login_id' | 'executor'> & { model?: string | null; model_basis?: UsageCell['model_basis'] };

const EXECUTOR_ACCOUNT_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  dsh: 'DSH',
  codex: 'Codex',
  claude: 'Claude',
};

function accountKeyOf(cell: Cell, names?: UsageNames): string {
  const id = cell.login_id;
  if (!id) return '@host';
  const rawName = names?.logins[id];
  // Machine logins are named `<machine>/<executor>`: group them into one logical account per executor.
  if (rawName && rawName.includes('/')) {
    const exec = rawName.slice(rawName.lastIndexOf('/') + 1).toLowerCase();
    return `@exec:${exec}`;
  }
  return id;
}

export function keyOf(cell: Cell, dimension: Dimension, names?: UsageNames): string {
  switch (dimension) {
    case 'project':
      return cell.source === 'quota' ? '@quota' : cell.project_dropped ? '@deleted' : cell.project_id ?? '@none';
    case 'account':
      return accountKeyOf(cell, names);
    case 'role':
      return cell.source === 'run' ? cell.role_id ?? '@none' : `@${cell.source}`;
    case 'tier':
      return cell.source === 'run' ? cell.tier ?? '@none' : `@${cell.source}`;
    case 'login':
      return cell.login_id ?? '@host';
    case 'model':
      return `${cell.model_basis === 'tier' ? 'tier' : 'said'}:${cell.model ?? '@unknown'}`;
  }
}

export function labelOf(key: string, dimension: Dimension, names: UsageNames): string {
  if (key === '@quota') return USAGE_SOURCE_TEXT.quota;
  if (key === '@router') return USAGE_SOURCE_TEXT.router;
  if (key === '@deleted') return '已删除的项目';
  if (key === '@other') return '其他';
  switch (dimension) {
    case 'project':
      return key === '@none' ? '不属于项目' : names.projects[key] ?? '已删除的项目';
    case 'account': {
      if (key === '@host') return '主机本机的登录';
      if (key.startsWith('@exec:')) {
        const exec = key.slice('@exec:'.length);
        return `${EXECUTOR_ACCOUNT_NAMES[exec] ?? exec}（单机聚合）`;
      }
      return names.logins[key] ?? '已删除的账号';
    }
    case 'role':
      return key === '@none' ? '没有记职能' : names.roles[key] ?? key;
    case 'tier':
      return key === '@none' ? '没有记档位' : tierLabel(key);
    case 'login':
      return key === '@host' ? '主机本机的登录' : names.logins[key] ?? '已删除的登录';
    case 'model': {
      const [basis, model] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (model === '@unknown') return '执行器没说是哪个模型';
      return basis === 'tier' ? `${model}（按档位）` : model;
    }
  }
}

export interface Group extends UsageFigures {
  key: string;
  label: string;
  // Rounds and Router turns (and quota reads) that used it.
  units: number;
  // Rounds that reported nothing at all; under a model there are none to count.
  without_usage: number;
  // How long its rounds took; null under a model, where a round's time is not one model's.
  duration_ms: number | null;
}

export interface Summary {
  totals: UsageFigures & { units: number; without_usage: number; duration_ms: number; rounds: number; turns: number };
  // Most used first, by the metric asked for.
  groups: Group[];
}

export function summarize(report: UsageReport, dimension: Dimension, metric: Metric): Summary {
  const groups = new Map<string, Group>();
  const groupOf = (key: string): Group => {
    let held = groups.get(key);
    if (!held) {
      held = { key, label: labelOf(key, dimension, report.names), ...ZERO, units: 0, without_usage: 0, duration_ms: dimension === 'model' ? null : 0 };
      groups.set(key, held);
    }
    return held;
  };
  for (const cell of report.usage) {
    const group = groupOf(keyOf(cell, dimension, report.names));
    Object.assign(group, add(group, cell));
    if (dimension === 'model') group.units += cell.units;
  }
  if (dimension !== 'model') {
    for (const cell of report.units) {
      const group = groupOf(keyOf(cell, dimension, report.names));
      group.units += cell.units;
      group.without_usage += cell.without_usage;
      group.duration_ms = (group.duration_ms ?? 0) + cell.duration_ms;
    }
  }
  const totals = {
    ...report.usage.reduce(add, ZERO),
    units: report.units.reduce((sum, cell) => sum + cell.units, 0),
    without_usage: report.units.reduce((sum, cell) => sum + cell.without_usage, 0),
    duration_ms: report.units.reduce((sum, cell) => sum + cell.duration_ms, 0),
    rounds: report.units.filter((cell) => cell.source === 'run').reduce((sum, cell) => sum + cell.units, 0),
    turns: report.units.filter((cell) => cell.source === 'router').reduce((sum, cell) => sum + cell.units, 0),
  };
  const sorted = [...groups.values()].sort((a, b) => metricOf(b, metric) - metricOf(a, metric) || tokensOf(b) - tokensOf(a) || b.units - a.units);
  return { totals, groups: sorted };
}

// The days of the chart: each day's figure under each of the groups drawn, the rest as one.
// The groups drawn are the most used ones, so a group keeps its color for as long as the
// range and the dimension stay the same.
export const DRAWN = 5;

export interface Day {
  day: string;
  values: { key: string; value: number }[];
  total: number;
}

export function daysOf(report: UsageReport, days: readonly string[], dimension: Dimension, metric: Metric, drawn: readonly string[]): Day[] {
  const shown = new Set(drawn);
  const byDay = new Map<string, Map<string, number>>(days.map((day) => [day, new Map()]));
  for (const cell of report.usage) {
    const held = byDay.get(cell.day);
    if (!held) continue;
    const key = keyOf(cell, dimension, report.names);
    const into = shown.has(key) ? key : '@other';
    held.set(into, (held.get(into) ?? 0) + metricOf(cell, metric));
  }
  return days.map((day) => {
    const held = byDay.get(day)!;
    const values = [...drawn, '@other'].flatMap((key) => (held.get(key) ? [{ key, value: held.get(key)! }] : []));
    return { day, values, total: values.reduce((sum, each) => sum + each.value, 0) };
  });
}

// A round upper end for the axis and the steps to it: 1, 2 or 5 times a power of ten.
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

const COMPACT = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat('zh-CN');

export const formatTokens = (value: number): string => (value < 10_000 ? PLAIN.format(value) : COMPACT.format(value));

export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return `$${value >= 1000 ? PLAIN.format(Math.round(value)) : value.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms > 0 ? '不到 1 分钟' : '0';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分`;
}

// A day as the tooltip says it, and shorter under the axis, where a phone has little room.
export const dayLabel = (day: string): string => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
export const axisLabel = (day: string): string => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
