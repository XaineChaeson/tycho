// Time as the ledger schedules it: the one parse of an instant, and the moments of a rule — once,
// at a fixed interval, or a five-field cron in an IANA zone (docs/design/triggers.md §2.1, §5).
// schedule_wake and the triggers share it; nothing here reads the clock but parseSchedule's
// "can it ever fire" check.
import { InputError } from './errors.ts';

export type Schedule =
  | { kind: 'once'; at: string }
  | { kind: 'every'; every_ms: number; anchor: string }
  | { kind: 'cron'; expr: string; zone: string };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// How far ahead a cron rule is searched: past this, it is one that does not fire.
const SEARCH_DAYS = 5 * 366 + 1;
// Gregorian calendar days and weekdays repeat after this many days.
const GREGORIAN_CYCLE_DAYS = 146_097;
// The farthest back the moment before a change of offset is looked for: a yearly rule's gap.
const LONGEST_GAP_MS = 367 * DAY_MS;
// The windows lastMoment searches back through, shortest first.
const BACK_WINDOWS_MS = [DAY_MS, 8 * DAY_MS, 32 * DAY_MS, 367 * DAY_MS, SEARCH_DAYS * DAY_MS];

export function parseInstant(value: string | Date): string | undefined {
  if (typeof value === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) return undefined;
  const date = new Date(typeof value === 'string' ? value.trim() : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// ---- Zones ----

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(zone, found);
  }
  return found;
}

interface Local { y: number; m: number; d: number; h: number; min: number; s: number }

function localOf(zone: string, instant: number): Local {
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter(zone).formatToParts(new Date(instant))) if (type !== 'literal') parts[type] = Number(value);
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour! % 24, min: parts.minute!, s: parts.second! };
}

// Local wall time minus UTC, in milliseconds, at this instant.
function offsetAt(zone: string, instant: number): number {
  const { y, m, d, h, min, s } = localOf(zone, instant);
  return Date.UTC(y, m - 1, d, h, min, s) - Math.floor(instant / 1000) * 1000;
}

// The first instant the zone's clocks read this wall time, or undefined when they never do
// (a spring-forward gap). A wall time read twice (a fall-back overlap) is its first reading.
function firstInstant(zone: string, y: number, m: number, d: number, h: number, min: number): number | undefined {
  const wall = Date.UTC(y, m - 1, d, h, min);
  const offsets = new Set([offsetAt(zone, wall - 1.5 * DAY_MS), offsetAt(zone, wall), offsetAt(zone, wall + 1.5 * DAY_MS)]);
  let first: number | undefined;
  for (const offset of offsets) {
    const instant = wall - offset;
    if (offsetAt(zone, instant) === offset && (first === undefined || instant < first)) first = instant;
  }
  return first;
}

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
function requireZone(zone: unknown): string {
  if (typeof zone !== 'string' || !ZONE_SHAPE.test(zone)) throw new InputError(`时区要写 IANA 名字（例如 Asia/Shanghai）：${String(zone)}`);
  try {
    formatter(zone);
  } catch {
    throw new InputError(`不认识这个时区：${zone}`);
  }
  return zone;
}

const pad = (value: number): string => String(value).padStart(2, '0');

// "2030-01-01 08:00" as the zone's clocks read it.
export function localTime(instant: Date | string, zone: string): string {
  const { y, m, d, h, min } = localOf(zone, new Date(instant).getTime());
  return `${y}-${pad(m)}-${pad(d)} ${pad(h)}:${pad(min)}`;
}

// ---- Cron ----

interface Cron {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  // Vixie cron's rule: when either day field is written from '*' (a step like */2 included), a day
  // has to be in both sets; only when both are written otherwise does either one do.
  dayStar: boolean;
  weekStar: boolean;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const FIELDS: { name: string; min: number; max: number; names?: string[]; base?: number }[] = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12, names: MONTH_NAMES, base: 1 },
  { name: '星期', min: 0, max: 7, names: DAY_NAMES, base: 0 },
];

function fieldValues(text: string, field: (typeof FIELDS)[number]): number[] {
  const value = (word: string): number => {
    const named = field.names?.indexOf(word.toUpperCase()) ?? -1;
    if (named >= 0) return named + field.base!;
    if (!/^\d+$/.test(word)) throw new InputError(`cron 的${field.name}字段写错了：${text}`);
    const number = Number(word);
    if (number < field.min || number > field.max) throw new InputError(`cron 的${field.name}字段超出范围（${field.min}–${field.max}）：${text}`);
    return number;
  };
  const found = new Set<number>();
  for (const item of text.split(',')) {
    const [range, stepText, extra] = item.split('/');
    if (extra !== undefined || range === undefined || range === '') throw new InputError(`cron 的${field.name}字段写错了：${text}`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw new InputError(`cron 的${field.name}字段的步长要是正整数：${text}`);
      step = Number(stepText);
    }
    let low: number;
    let high: number;
    if (range === '*') [low, high] = [field.min, field.max];
    else if (range.includes('-')) {
      const [from, to, more] = range.split('-');
      if (more !== undefined || from === undefined || to === undefined) throw new InputError(`cron 的${field.name}字段写错了：${text}`);
      [low, high] = [value(from), value(to)];
      if (low > high) throw new InputError(`cron 的${field.name}字段的范围倒过来了：${text}`);
    } else {
      low = value(range);
      high = stepText === undefined ? low : field.max;
    }
    for (let each = low; each <= high; each += step) found.add(each);
  }
  return [...found].sort((a, b) => a - b);
}

const crons = new Map<string, Cron>();
export function parseCron(expr: string): Cron {
  const known = crons.get(expr);
  if (known) return known;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === '') throw new InputError(`cron 要写五个字段（分 时 日 月 星期）：${expr}`);
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => fieldValues(part, FIELDS[index]!));
  const cron: Cron = {
    minutes: minutes!,
    hours: hours!,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays!.map((day) => day % 7)),
    dayStar: parts[2]!.startsWith('*'),
    weekStar: parts[4]!.startsWith('*'),
  };
  crons.set(expr, cron);
  return cron;
}

function dayMatches(cron: Cron, y: number, m: number, d: number): boolean {
  if (!cron.months.has(m)) return false;
  const dom = cron.days.has(d);
  const dow = cron.weekdays.has(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  return cron.dayStar || cron.weekStar ? dom && dow : dom || dow;
}

function nextCron(cron: Cron, zone: string, after: number): number | undefined {
  const start = localOf(zone, after);
  let { y, m, d } = start;
  for (let day = 0; day < SEARCH_DAYS; day += 1) {
    if (dayMatches(cron, y, m, d)) {
      for (const h of cron.hours) {
        if (day === 0 && h < start.h) continue;
        for (const min of cron.minutes) {
          if (day === 0 && h === start.h && min < start.min) continue;
          const instant = firstInstant(zone, y, m, d, h, min);
          if (instant !== undefined && instant > after) return instant;
        }
      }
    }
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    [y, m, d] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
  }
  return undefined;
}

// ---- Rules ----

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// The one entrance a rule comes in by: what passes is in its normal form.
export function parseSchedule(raw: unknown): Schedule {
  if (!isRecord(raw)) throw new InputError('时间规则要是一个对象：once、every 或 cron');
  switch (raw.kind) {
    case 'once': {
      const at = typeof raw.at === 'string' || raw.at instanceof Date ? parseInstant(raw.at) : undefined;
      if (!at) throw new InputError(`一次性的时刻要写带时区的时间（ISO 8601）：${String(raw.at)}`);
      return { kind: 'once', at };
    }
    case 'every': {
      const anchor = typeof raw.anchor === 'string' ? parseInstant(raw.anchor) : undefined;
      if (!anchor) throw new InputError(`固定间隔的起点要写带时区的时间（ISO 8601）：${String(raw.anchor)}`);
      if (!Number.isInteger(raw.every_ms) || (raw.every_ms as number) < MINUTE_MS) throw new InputError('固定间隔至少 1 分钟');
      return { kind: 'every', every_ms: raw.every_ms as number, anchor };
    }
    case 'cron': {
      if (typeof raw.expr !== 'string') throw new InputError('cron 要写表达式');
      const expr = raw.expr.trim().split(/\s+/).join(' ');
      parseCron(expr);
      const rule: Schedule = { kind: 'cron', expr, zone: requireZone(raw.zone) };
      if (nextMoment(rule, new Date()) === undefined) throw new InputError(`这条 cron 在五年内不会触发：${expr}`);
      return rule;
    }
    default:
      throw new InputError(`时间规则只有三种：once（一次）、every（固定间隔）、cron：${String(raw.kind)}`);
  }
}

// The first moment strictly after `after`.
export function nextMoment(rule: Schedule, after: Date): Date | undefined {
  const t = after.getTime();
  switch (rule.kind) {
    case 'once': {
      const at = Date.parse(rule.at);
      return at > t ? new Date(at) : undefined;
    }
    case 'every': {
      const anchor = Date.parse(rule.anchor);
      if (t < anchor) return new Date(anchor);
      return new Date(anchor + (Math.floor((t - anchor) / rule.every_ms) + 1) * rule.every_ms);
    }
    case 'cron': {
      const next = nextCron(parseCron(rule.expr), rule.zone, t);
      return next === undefined ? undefined : new Date(next);
    }
  }
}

// The moments in (after, until], the first `cap` of them; `count` stops at the cap.
export function momentsBetween(rule: Schedule, after: Date, until: Date, cap: number): { moments: Date[]; count: number; capped: boolean } {
  const moments: Date[] = [];
  let cursor = after;
  for (;;) {
    const next = nextMoment(rule, cursor);
    if (!next || next > until) return { moments, count: moments.length, capped: false };
    if (moments.length === cap) return { moments, count: cap, capped: true };
    moments.push(next);
    cursor = next;
  }
}

// The last moment in (after, until].
export function lastMoment(rule: Schedule, after: Date, until: Date): Date | undefined {
  if (until <= after) return undefined;
  switch (rule.kind) {
    case 'once': {
      const at = new Date(rule.at);
      return at > after && at <= until ? at : undefined;
    }
    case 'every': {
      const anchor = Date.parse(rule.anchor);
      if (until.getTime() < anchor) return undefined;
      const last = new Date(anchor + Math.floor((until.getTime() - anchor) / rule.every_ms) * rule.every_ms);
      return last > after ? last : undefined;
    }
    case 'cron': {
      // Searched back by windows: walking forward from a long-ago `after` is unbounded.
      for (const span of BACK_WINDOWS_MS) {
        const start = new Date(Math.max(after.getTime(), until.getTime() - span));
        let last: Date | undefined;
        for (let next = nextMoment(rule, start); next && next <= until; next = nextMoment(rule, next)) last = next;
        if (last || start.getTime() === after.getTime()) return last;
      }
      return undefined;
    }
  }
}

// The closest two moments of a cron rule on the wall clock, in minutes: two times of one day, or
// the last time of a day and the first of the next day that matches. Days match in a pattern that
// repeats every 400 years (146097 days, a whole number of weeks), so one cycle is all of it.
function wallGap(cron: Cron, from: Date): number | undefined {
  const times = cron.hours.flatMap((h) => cron.minutes.map((min) => h * 60 + min));
  let gap: number | undefined;
  for (let i = 1; i < times.length; i += 1) gap = Math.min(gap ?? Infinity, times[i]! - times[i - 1]!);
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let last: number | undefined;
  let days: number | undefined;
  for (let n = 0; n < GREGORIAN_CYCLE_DAYS + 1 && days !== 1; n += 1, day.setUTCDate(day.getUTCDate() + 1)) {
    if (!dayMatches(cron, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) continue;
    if (last !== undefined) days = Math.min(days ?? Infinity, n - last);
    last = n;
  }
  if (days !== undefined) gap = Math.min(gap ?? Infinity, days * 1440 - times.at(-1)! + times[0]!);
  return gap;
}

// The instants within the search horizon at which the zone's clocks change their offset.
function offsetChanges(zone: string, from: Date): number[] {
  const changes: number[] = [];
  let before = from.getTime();
  let offset = offsetAt(zone, before);
  for (let n = 1; n <= SEARCH_DAYS; n += 1) {
    const at = from.getTime() + n * DAY_MS;
    const now = offsetAt(zone, at);
    if (now !== offset) {
      let [low, high] = [before, at];
      while (high - low > MINUTE_MS) {
        const middle = low + Math.floor((high - low) / 2);
        if (offsetAt(zone, middle) === offset) low = middle;
        else high = middle;
      }
      changes.push(high);
      offset = now;
    }
    before = at;
  }
  return changes;
}

// How close two moments of the rule come, from `from` on; undefined for a rule of one moment.
// Real time and wall time differ only across a change of the zone's offset, and only one pair of
// consecutive moments spans each change: the wall-clock gap and those pairs are all of it.
export function minGap(rule: Schedule, from: Date): number | undefined {
  if (rule.kind === 'once') return undefined;
  if (rule.kind === 'every') return rule.every_ms;
  const wall = wallGap(parseCron(rule.expr), from);
  let gap = wall === undefined ? undefined : wall * MINUTE_MS;
  for (const change of offsetChanges(rule.zone, from)) {
    const before = lastMoment(rule, new Date(change - LONGEST_GAP_MS), new Date(change));
    const after = nextMoment(rule, new Date(change));
    if (before && after) gap = Math.min(gap ?? Infinity, after.getTime() - before.getTime());
  }
  return gap;
}

function spanText(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} 天`;
  if (ms % 3_600_000 === 0 && ms >= 3_600_000 * 2) return `${ms / 3_600_000} 小时`;
  return `${Math.round(ms / MINUTE_MS)} 分钟`;
}

export function describeSchedule(rule: Schedule): string {
  switch (rule.kind) {
    case 'once':
      return `一次：${rule.at}`;
    case 'every':
      return `每 ${spanText(rule.every_ms)}（从 ${rule.anchor} 起算）`;
    case 'cron':
      return `cron ${rule.expr}（时区 ${rule.zone}）`;
  }
}
