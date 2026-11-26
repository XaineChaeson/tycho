// The trigger form of the project page and the lines it shows (docs/design/triggers.md §2.1–§2.3, §7).
// All pure. Times typed in the form are the browser's wall clock and go out as instants; a cron
// rule goes out with the zone it runs in.
import { FIRE_MESSAGE_LABELS, MISSED_LABELS, OUTCOME_LABELS, SCHEDULE_LABELS, type MissedPolicy, type ScheduleKind, type TriggerSource } from '@shared/triggers.ts';
import { INTERNAL_EVENT_LABELS, type InternalEventKind } from '@shared/internal-events.ts';
import type { Trigger, TriggerFire } from './types.ts';

const MINUTE_MS = 60_000;

export type { TriggerSource };

export interface TriggerDraft {
  name: string;
  instruction: string;
  // Fixed once the trigger is made.
  source: TriggerSource;
  // An internal-event trigger: the kind, and the one Task it watches ('' for all of the project's).
  eventKind: InternalEventKind;
  eventTask: string;
  kind: ScheduleKind;
  // A datetime-local value: the browser's wall clock.
  at: string;
  everyMinutes: string;
  startAt: string;
  cron: string;
  zone: string;
  missed: MissedPolicy;
  expires: string;
  pushFinal: boolean;
  broadcastGroups: boolean;
  broadcastGroupIds: string[];
  // The rule's times as the service holds them, for an edit: a field shows minutes, so a field the
  // owner left as it was goes back as this instant, not as the start of its minute.
  held: { at?: string; anchor?: string; everyMs?: number; expires?: string };
}

const pad = (value: number): string => String(value).padStart(2, '0');

// An instant as a datetime-local field shows it, in the browser's zone.
export function inputTime(iso: string): string {
  const at = new Date(iso);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// A datetime-local value as the instant it is in the browser's zone.
const instant = (local: string): string => new Date(local).toISOString();

export const emptyDraft = (zone: string): TriggerDraft => ({
  name: '',
  instruction: '',
  source: 'schedule',
  eventKind: 'work_ready',
  eventTask: '',
  kind: 'cron',
  at: '',
  everyMinutes: '60',
  startAt: '',
  cron: '0 8 * * *',
  zone,
  missed: 'latest',
  expires: '',
  pushFinal: false,
  broadcastGroups: false,
  broadcastGroupIds: [],
  held: {},
});

// The instant a field stands for: the one held when the field still shows it, else what was typed.
const timeOf = (local: string, held: string | undefined): string => (held !== undefined && local === inputTime(held) ? held : instant(local));

export function draftOf(trigger: Trigger): TriggerDraft {
  const { schedule, event } = trigger;
  if (schedule === null) {
    return {
      ...emptyDraft(trigger.zone),
      name: trigger.name,
      instruction: trigger.instruction,
      source: 'event',
      eventKind: event?.kind ?? 'work_ready',
      eventTask: event?.task_id ?? '',
      expires: trigger.expires_at === null ? '' : inputTime(trigger.expires_at),
      pushFinal: trigger.push_final,
      broadcastGroups: trigger.broadcast_groups ?? false,
      broadcastGroupIds: [...(trigger.broadcast_group_ids ?? [])],
      held: trigger.expires_at === null ? {} : { expires: trigger.expires_at },
    };
  }
  return {
    ...emptyDraft(trigger.zone),
    name: trigger.name,
    instruction: trigger.instruction,
    kind: schedule.kind,
    at: schedule.kind === 'once' ? inputTime(schedule.at) : '',
    everyMinutes: schedule.kind === 'every' ? String(schedule.every_ms / MINUTE_MS) : '60',
    startAt: schedule.kind === 'every' ? inputTime(schedule.anchor) : '',
    cron: schedule.kind === 'cron' ? schedule.expr : '0 8 * * *',
    zone: schedule.kind === 'cron' ? schedule.zone : trigger.zone,
    missed: trigger.missed,
    expires: trigger.expires_at === null ? '' : inputTime(trigger.expires_at),
    pushFinal: trigger.push_final,
    broadcastGroups: trigger.broadcast_groups ?? false,
    broadcastGroupIds: [...(trigger.broadcast_group_ids ?? [])],
    held: {
      ...(schedule.kind === 'once' ? { at: schedule.at } : {}),
      ...(schedule.kind === 'every' ? { anchor: schedule.anchor, everyMs: schedule.every_ms } : {}),
      ...(trigger.expires_at === null ? {} : { expires: trigger.expires_at }),
    },
  };
}

function scheduleOf(draft: TriggerDraft): Record<string, unknown> {
  switch (draft.kind) {
    case 'once':
      return { kind: 'once', at: draft.at === '' ? '' : timeOf(draft.at, draft.held.at) };
    case 'every': {
      const { everyMs } = draft.held;
      return {
        kind: 'every',
        every_ms: everyMs !== undefined && draft.everyMinutes === String(everyMs / MINUTE_MS) ? everyMs : Math.round(Number(draft.everyMinutes) * MINUTE_MS),
        anchor: draft.startAt === '' ? new Date().toISOString() : timeOf(draft.startAt, draft.held.anchor),
      };
    }
    case 'cron':
      return { kind: 'cron', expr: draft.cron.trim().split(/\s+/).join(' '), zone: draft.zone.trim() };
  }
}

// What a save sends: the whole definition; the service judges whether the rule changed. A time
// rule or a subscription, by source.
interface TriggerBody {
  name: string;
  instruction: string;
  source: TriggerSource;
  schedule?: Record<string, unknown>;
  missed?: MissedPolicy;
  event?: { kind: InternalEventKind; task_id: string | null };
  expires_at: string | null;
  push_final: boolean;
  broadcast_groups: boolean;
  broadcast_group_ids: string[];
}

export const triggerBody = (draft: TriggerDraft): TriggerBody => ({
  name: draft.name.trim(),
  instruction: draft.instruction.trim(),
  source: draft.source,
  ...(draft.source === 'event'
    ? { event: { kind: draft.eventKind, task_id: draft.eventTask.trim() === '' ? null : draft.eventTask.trim() } }
    : { schedule: scheduleOf(draft), missed: draft.missed }),
  expires_at: draft.expires === '' ? null : timeOf(draft.expires, draft.held.expires),
  push_final: draft.pushFinal,
  broadcast_groups: draft.broadcastGroups,
  broadcast_group_ids: draft.broadcastGroups ? draft.broadcastGroupIds : [],
});

const utc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

export function nextLine(trigger: Trigger): string {
  if (!trigger.enabled) return '已停用，不会触发';
  if (trigger.source === 'event') return trigger.ended === 'expired' ? '过了截止时间，不再触发' : '订阅的事件发生时触发';
  if (trigger.next_error) return `下一次未知：规则算不出来（${trigger.next_error}），改一下规则或停用它`;
  if (trigger.ended === 'done') return '已经触发过，没有下一次';
  if (trigger.ended === 'expired') return '过了截止时间，不再触发';
  if (trigger.next_at === null || trigger.next_local === null) return '没有下一次';
  return `下一次：${trigger.next_local}（${trigger.zone}），UTC ${utc(trigger.next_at)}`;
}

export function isTriggerEnded(trigger: Trigger): boolean {
  return trigger.ended !== null;
}

export function isTriggerActive(trigger: Trigger): boolean {
  return trigger.enabled && trigger.ended === null;
}

// Clone a trigger's instruction and settings into a brand-new draft with fresh time fields,
// ideal for re-scheduling a completed one-shot trigger.
export function cloneDraftOf(trigger: Trigger, zone: string): TriggerDraft {
  const base = draftOf(trigger);
  return {
    ...base,
    zone: base.zone || zone,
    at: '',
    startAt: '',
    expires: '',
    held: {},
  };
}

export function fireLine(fire: TriggerFire): string {
  return [
    OUTCOME_LABELS[fire.outcome],
    ...(fire.merged_count > 1 ? [`合并了${fire.merged_capped ? '至少 ' : ' '}${fire.merged_count} 个时刻`] : []),
    ...(fire.message_state && fire.outcome !== 'replaced' ? [FIRE_MESSAGE_LABELS[fire.message_state] ?? fire.message_state] : []),
  ].join(' · ');
}

interface ZonedParts {
  dateStr: string;
  monthDay: string;
  hour: number;
  minute: number;
  minutesOfDay: number;
  clock: string;
}

function zonedPartsOf(ms: number, zone: string): ZonedParts {
  const date = new Date(ms);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
  }
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const rawHour = Number(map.hour ?? '0');
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(map.minute ?? '0');
  const year = map.year ?? '1970';
  const month = map.month ?? '01';
  const day = map.day ?? '01';
  return {
    dateStr: `${year}-${month}-${day}`,
    monthDay: `${month}-${day}`,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
    clock: `${pad(hour)}:${pad(minute)}`,
  };
}

function addDaysDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function formatCountdown(targetIso: string, nowMs: number = Date.now()): string {
  const targetMs = Date.parse(targetIso);
  if (!Number.isFinite(targetMs)) return '';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 60_000) return '即将触发';
  const totalMin = Math.round(diffMs / 60_000);
  if (totalMin < 60) return `${totalMin}m 后`;
  const totalHours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHours < 24) return remMin > 0 ? `${totalHours}h ${remMin}m 后` : `${totalHours}h 后`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}天 ${remHours}h 后` : `${days}天 后`;
}

export interface TriggerClockMeta {
  clock: string;
  dateTag: string;
  countdown: string;
  cadenceTag: string;
  urgent: boolean;
  isEvent: boolean;
  utcText: string | null;
}

export function triggerClockMeta(trigger: Trigger, zone: string, nowMs: number = Date.now()): TriggerClockMeta {
  if (trigger.source === 'event') {
    const kindLabel = trigger.event ? (INTERNAL_EVENT_LABELS[trigger.event.kind] ?? trigger.event.kind) : '内部事件';
    const scope = trigger.event?.task_id ? `限定 ${trigger.event.task_id.slice(0, 8)}` : '全部任务';
    const countdown = !trigger.enabled
      ? '已停用'
      : trigger.ended === 'expired'
        ? '已截止'
        : '实时监听';
    return {
      clock: '事件',
      dateTag: kindLabel,
      countdown,
      cadenceTag: `${kindLabel} · ${scope}`,
      urgent: false,
      isEvent: true,
      utcText: null,
    };
  }

  const cadenceTag = trigger.schedule === null
    ? trigger.schedule_text
    : trigger.schedule.kind === 'once'
      ? SCHEDULE_LABELS.once
      : trigger.schedule.kind === 'cron'
        ? `cron · ${trigger.schedule.expr}`
        : `每 ${Math.round(trigger.schedule.every_ms / MINUTE_MS)} 分钟`;

  const utcText = trigger.next_at ? `UTC ${utc(trigger.next_at)}` : null;

  if (!trigger.enabled) {
    return {
      clock: trigger.schedule?.kind === 'every' ? `每${Math.round(trigger.schedule.every_ms / MINUTE_MS)}m` : '--:--',
      dateTag: '已停用',
      countdown: '已停用',
      cadenceTag,
      urgent: false,
      isEvent: false,
      utcText: null,
    };
  }

  if (trigger.next_error) {
    return {
      clock: '异常',
      dateTag: '规则错误',
      countdown: '需修正规则',
      cadenceTag,
      urgent: true,
      isEvent: false,
      utcText: null,
    };
  }

  if (trigger.ended === 'done' || trigger.ended === 'expired' || !trigger.next_at || !trigger.next_local) {
    return {
      clock: trigger.ended === 'done' ? '已发' : '结束',
      dateTag: trigger.ended === 'done' ? '已完成' : '已截止',
      countdown: trigger.ended === 'done' ? '已触发' : '不再触发',
      cadenceTag,
      urgent: false,
      isEvent: false,
      utcText: null,
    };
  }

  const nowParts = zonedPartsOf(nowMs, zone);
  const tomorrowStr = addDaysDateStr(nowParts.dateStr, 1);
  const nextMs = Date.parse(trigger.next_at);
  const nextParts = Number.isFinite(nextMs) ? zonedPartsOf(nextMs, trigger.zone || zone) : null;
  const localClock = trigger.next_local.slice(11, 16) || nextParts?.clock || '--:--';
  const localDate = trigger.next_local.slice(0, 10);
  const dateTag = localDate === nowParts.dateStr
    ? '今天'
    : localDate === tomorrowStr
      ? '明天'
      : localDate.slice(5);
  const diffMs = Number.isFinite(nextMs) ? nextMs - nowMs : Infinity;
  return {
    clock: localClock,
    dateTag,
    countdown: formatCountdown(trigger.next_at, nowMs),
    cadenceTag,
    urgent: diffMs > 0 && diffMs <= 2 * 60 * 60_000,
    isEvent: false,
    utcText,
  };
}

export interface TimelineNode {
  id: string;
  name: string;
  timeLabel: string;
  minutes: number;
  pct: number;
  enabled: boolean;
  row: 'top' | 'bottom';
  countdown: string;
  kind: ScheduleKind | 'unknown';
}

export interface TimelinePastDot {
  id: string;
  triggerId: string | null;
  name: string;
  timeLabel: string;
  minutes: number;
  pct: number;
  outcome: TriggerFire['outcome'];
}

export interface ScheduleTimeline {
  visible: boolean;
  dayKind: 'today' | 'tomorrow';
  dateLabel: string;
  zone: string;
  nowMinutes: number | null;
  nowLabel: string | null;
  nowPct: number | null;
  nodes: TimelineNode[];
  pastFires: TimelinePastDot[];
  laterCount: number;
  nextTrigger: { id: string; name: string; timeLabel: string; dateTag: string; countdown: string } | null;
}

// Minimum horizontal separation (in minutes of a 24h axis) before alternating label rows.
const TIMELINE_COLLISION_GAP_MIN = 130;

export function buildScheduleTimeline(
  triggers: readonly Trigger[],
  recent: readonly TriggerFire[],
  zone: string,
  nowMs: number = Date.now(),
): ScheduleTimeline {
  const nowParts = zonedPartsOf(nowMs, zone);
  const todayStr = nowParts.dateStr;
  const tomorrowStr = addDaysDateStr(todayStr, 1);

  const scheduled = triggers
    .filter((t) => t.enabled && t.source === 'schedule' && t.next_at !== null && !t.ended && !t.next_error)
    .map((t) => {
      const nextMs = Date.parse(t.next_at!);
      return { trigger: t, nextMs, parts: zonedPartsOf(nextMs, zone) };
    })
    .filter((item) => Number.isFinite(item.nextMs))
    .sort((a, b) => a.nextMs - b.nextMs);

  const earliest = scheduled[0];
  const nextTrigger = earliest ? {
    id: earliest.trigger.id,
    name: earliest.trigger.name,
    timeLabel: earliest.parts.clock,
    dateTag: earliest.parts.dateStr === todayStr ? '今天' : earliest.parts.dateStr === tomorrowStr ? '明天' : earliest.parts.monthDay,
    countdown: formatCountdown(earliest.trigger.next_at!, nowMs),
  } : null;

  const todayItems = scheduled.filter((item) => item.parts.dateStr === todayStr);
  const tomorrowItems = scheduled.filter((item) => item.parts.dateStr === tomorrowStr);

  const useToday = todayItems.length > 0;
  const dayItems = useToday ? todayItems : tomorrowItems;
  const targetDateStr = useToday ? todayStr : tomorrowStr;

  if (dayItems.length === 0) {
    return {
      visible: false,
      dayKind: 'today',
      dateLabel: `今天 ${nowParts.monthDay}`,
      zone,
      nowMinutes: nowParts.minutesOfDay,
      nowLabel: nowParts.clock,
      nowPct: (nowParts.minutesOfDay / 1440) * 100,
      nodes: [],
      pastFires: [],
      laterCount: scheduled.length,
      nextTrigger,
    };
  }

  let lastTop = -Infinity;
  let lastBottom = -Infinity;
  const nodes: TimelineNode[] = dayItems
    .sort((a, b) => a.parts.minutesOfDay - b.parts.minutesOfDay)
    .map(({ trigger, parts }) => {
      let row: 'top' | 'bottom';
      if (parts.minutesOfDay - lastTop >= TIMELINE_COLLISION_GAP_MIN) {
        row = 'top';
        lastTop = parts.minutesOfDay;
      } else if (parts.minutesOfDay - lastBottom >= TIMELINE_COLLISION_GAP_MIN) {
        row = 'bottom';
        lastBottom = parts.minutesOfDay;
      } else if (parts.minutesOfDay - lastTop >= parts.minutesOfDay - lastBottom) {
        row = 'top';
        lastTop = parts.minutesOfDay;
      } else {
        row = 'bottom';
        lastBottom = parts.minutesOfDay;
      }
      return {
        id: trigger.id,
        name: trigger.name,
        timeLabel: parts.clock,
        minutes: parts.minutesOfDay,
        pct: Math.max(2, Math.min(98, (parts.minutesOfDay / 1440) * 100)),
        enabled: trigger.enabled,
        row,
        countdown: formatCountdown(trigger.next_at!, nowMs),
        kind: trigger.schedule?.kind ?? 'unknown',
      };
    });

  const pastFires: TimelinePastDot[] = useToday
    ? recent
      .map((fire) => {
        const at = fire.scheduled_at ?? fire.created_at;
        const ms = Date.parse(at);
        if (!Number.isFinite(ms)) return null;
        const parts = zonedPartsOf(ms, zone);
        if (parts.dateStr !== todayStr || parts.minutesOfDay > nowParts.minutesOfDay) return null;
        return {
          id: fire.id,
          triggerId: fire.trigger_id,
          name: fire.trigger_name,
          timeLabel: parts.clock,
          minutes: parts.minutesOfDay,
          pct: Math.max(1, Math.min(99, (parts.minutesOfDay / 1440) * 100)),
          outcome: fire.outcome,
        };
      })
      .filter((item): item is TimelinePastDot => item !== null)
    : [];

  const laterCount = scheduled.filter((item) => item.parts.dateStr > targetDateStr).length;

  return {
    visible: true,
    dayKind: useToday ? 'today' : 'tomorrow',
    dateLabel: useToday ? `今天 ${nowParts.monthDay}` : `明天 ${tomorrowStr.slice(5)}`,
    zone,
    nowMinutes: useToday ? nowParts.minutesOfDay : null,
    nowLabel: useToday ? nowParts.clock : null,
    nowPct: useToday ? (nowParts.minutesOfDay / 1440) * 100 : null,
    nodes,
    pastFires,
    laterCount,
    nextTrigger,
  };
}
