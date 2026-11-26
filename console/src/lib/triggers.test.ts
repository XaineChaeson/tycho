// Guards the trigger form of the project page against: a time typed in the form sent without its
// zone, or read back in another zone than the one the browser shows; a cron rule sent without the
// zone it was given, or with the host's when the owner typed another; an empty deadline sent as a
// time; an edit that cannot read back what the service holds; and the next moment shown without
// its zone and UTC, or a trigger with none left shown as if one were coming.
import { describe, expect, test } from 'vitest';
import { buildScheduleTimeline, draftOf, emptyDraft, fireLine, formatCountdown, inputTime, nextLine, triggerBody, triggerClockMeta } from './triggers';
import type { Trigger } from './types';

const trigger = (over: Partial<Trigger> = {}): Trigger => ({
  id: 'tr1', project_id: 'p1', name: '早检', enabled: true, source: 'schedule',
  schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' }, schedule_text: 'cron 0 8 * * *（时区 Asia/Shanghai）',
  event: null, instruction: '检查构建', missed: 'latest', expires_at: null, push_final: false, revision: 1, created_by: 'console',
  created_at: '2030-01-01T00:00:00.000Z', updated_at: '2030-01-01T00:00:00.000Z', zone: 'Asia/Shanghai',
  next_at: '2030-01-02T00:00:00.000Z', next_local: '2030-01-02 08:00', ended: null, next_error: null, rejected: null, problem: null, ...over,
});

describe('the form', () => {
  test('a new trigger starts as a daily cron in the host zone, catching up the latest moment', () => {
    const draft = emptyDraft('Asia/Shanghai');
    expect(draft).toMatchObject({ kind: 'cron', cron: '0 8 * * *', zone: 'Asia/Shanghai', missed: 'latest', pushFinal: false, expires: '' });
  });

  test('what is sent carries the zone: an instant as UTC, a cron with the zone given', () => {
    const local = inputTime('2030-01-01T00:00:00.000Z');
    const once = triggerBody({ ...emptyDraft('UTC'), name: ' 一次 ', instruction: '看', kind: 'once', at: local, expires: '' });
    expect(once).toEqual({
      name: '一次', instruction: '看', source: 'schedule', schedule: { kind: 'once', at: '2030-01-01T00:00:00.000Z' },
      missed: 'latest', expires_at: null, push_final: false, broadcast_groups: false, broadcast_group_ids: [],
    });
    const cron = triggerBody({ ...emptyDraft('Asia/Shanghai'), name: 'c', instruction: '看', cron: ' 30  7 * * 1-5 ', zone: 'Europe/Berlin' });
    expect(cron.schedule).toEqual({ kind: 'cron', expr: '30 7 * * 1-5', zone: 'Europe/Berlin' });
    const every = triggerBody({ ...emptyDraft('UTC'), name: 'e', instruction: '看', kind: 'every', everyMinutes: '90', startAt: local, expires: local, pushFinal: true, broadcastGroups: true, broadcastGroupIds: ['g1'] });
    expect(every.schedule).toEqual({ kind: 'every', every_ms: 5_400_000, anchor: '2030-01-01T00:00:00.000Z' });
    expect([every.expires_at, every.push_final, every.broadcast_groups, every.broadcast_group_ids]).toEqual(['2030-01-01T00:00:00.000Z', true, true, ['g1']]);
  });

  test('an edit starts from what the service holds and sends it back unchanged when nothing moved', () => {
    const held = trigger({ schedule: { kind: 'every', every_ms: 600_000, anchor: '2030-01-01T00:00:00.000Z' }, expires_at: '2030-02-01T00:00:00.000Z', push_final: true, broadcast_groups: true, broadcast_group_ids: ['g2'], missed: 'skip' });
    const draft = draftOf(held);
    expect(draft).toMatchObject({ kind: 'every', everyMinutes: '10', missed: 'skip', pushFinal: true, broadcastGroups: true, broadcastGroupIds: ['g2'] });
    expect(triggerBody(draft)).toEqual({
      name: '早检', instruction: '检查构建', source: 'schedule', schedule: held.schedule, missed: 'skip', expires_at: '2030-02-01T00:00:00.000Z', push_final: true, broadcast_groups: true, broadcast_group_ids: ['g2'],
    });
    expect(triggerBody(draftOf(trigger())).schedule).toEqual({ kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' });
  });
});

describe('an internal-event trigger', () => {
  test('its draft and what a save sends: the event and the Task, no time rule', () => {
    const held = trigger({ source: 'event', schedule: null, event: { kind: 'merged', task_id: 't1' }, next_at: null, next_local: null, push_final: true });
    const draft = draftOf(held);
    expect(draft).toMatchObject({ source: 'event', eventKind: 'merged', eventTask: 't1', pushFinal: true });
    expect(triggerBody(draft)).toEqual({ name: '早检', instruction: '检查构建', source: 'event', event: { kind: 'merged', task_id: 't1' }, expires_at: null, push_final: true, broadcast_groups: false, broadcast_group_ids: [] });
    expect(triggerBody({ ...draft, eventTask: '  ' }).event).toEqual({ kind: 'merged', task_id: null });
  });

  test('it has no next moment: it fires when the event happens, until its deadline', () => {
    const held = trigger({ source: 'event', schedule: null, event: { kind: 'merged', task_id: null }, next_at: null, next_local: null });
    expect(nextLine(held)).toBe('订阅的事件发生时触发');
    expect(nextLine({ ...held, ended: 'expired' })).toBe('过了截止时间，不再触发');
    expect(nextLine({ ...held, enabled: false })).toBe('已停用，不会触发');
  });
});

describe('what the page says', () => {
  test('the next moment in its zone and in UTC; none when stopped, done or past the deadline', () => {
    expect(nextLine(trigger())).toBe('下一次：2030-01-02 08:00（Asia/Shanghai），UTC 2030-01-02 00:00');
    expect(nextLine(trigger({ enabled: false, next_at: null, next_local: null }))).toBe('已停用，不会触发');
    expect(nextLine(trigger({ ended: 'done', next_at: null, next_local: null }))).toBe('已经触发过，没有下一次');
    expect(nextLine(trigger({ ended: 'expired', next_at: null, next_local: null }))).toBe('过了截止时间，不再触发');
    // Review of step 3: a rule the service cannot work out still says so, not that nothing is coming.
    expect(nextLine(trigger({ next_at: null, next_local: null, next_error: 'Invalid time zone specified: Nowhere/Never' })))
      .toBe('下一次未知：规则算不出来（Invalid time zone specified: Nowhere/Never），改一下规则或停用它');
  });

  test('an occurrence says what became of it and of its turn', () => {
    const fire = { id: 'f', created_at: '2030-01-02T00:00:05.000Z', trigger_id: 'tr1', source_id: null, project_id: 'p1', trigger_name: '早检', event_id: 'e', scheduled_at: '2030-01-02T00:00:00.000Z', revision: 1, outcome: 'delivered' as const, merged_into: null, merged_count: 3, merged_capped: false, message_id: 'm', message_state: 'unverified', push_final: false, data: {} };
    expect(fireLine(fire)).toBe('已投递 · 合并了 3 个时刻 · 未确认完成');
    expect(fireLine({ ...fire, outcome: 'missed', merged_count: 1, message_id: null, message_state: null })).toBe('错过');
  });
});

// Review of step 1: a field shows minutes, so sending back what the field shows moved every
// instant the owner did not touch to the start of its minute.
describe('an edit sends back the instants it did not touch exactly as the service holds them', () => {
  test('changing only the name keeps the moment, the anchor and the deadline to the millisecond', () => {
    const once = trigger({ schedule: { kind: 'once', at: '2030-01-01T00:00:42.123Z' }, expires_at: '2030-02-01T00:00:59.999Z' });
    expect(triggerBody({ ...draftOf(once), name: '新名字' })).toMatchObject({
      name: '新名字', schedule: { kind: 'once', at: '2030-01-01T00:00:42.123Z' }, expires_at: '2030-02-01T00:00:59.999Z',
    });
    const every = trigger({ schedule: { kind: 'every', every_ms: 90_000, anchor: '2030-01-01T00:00:42.123Z' } });
    expect(triggerBody({ ...draftOf(every), name: '新名字' }).schedule).toEqual({ kind: 'every', every_ms: 90_000, anchor: '2030-01-01T00:00:42.123Z' });
  });

  test('a time the owner did change goes out as the instant typed', () => {
    const once = trigger({ schedule: { kind: 'once', at: '2030-01-01T00:00:42.123Z' } });
    const moved = inputTime('2030-01-02T00:00:00.000Z');
    expect(triggerBody({ ...draftOf(once), at: moved }).schedule).toEqual({ kind: 'once', at: '2030-01-02T00:00:00.000Z' });
  });
});

test('a count that reached its cap is read as at least that many', () => {
  const fire = { id: 'f', created_at: '2030-01-02T00:00:05.000Z', trigger_id: 'tr1', source_id: null, project_id: 'p1', trigger_name: '早检', event_id: 'e', scheduled_at: null, revision: 1, outcome: 'delivered' as const, merged_into: null, merged_count: 10_000, merged_capped: true, message_id: 'm', message_state: 'received', push_final: false, data: {} };
  expect(fireLine(fire)).toBe('已投递 · 合并了至少 10000 个时刻 · 排队中');
});

describe('24h schedule timeline and countdown helpers', () => {
  test('formatCountdown renders minutes, hours, and days cleanly', () => {
    const now = Date.parse('2026-11-26T01:25:00+08:00');
    expect(formatCountdown('2026-11-26T01:25:30+08:00', now)).toBe('即将触发');
    expect(formatCountdown('2026-11-26T02:00:00+08:00', now)).toBe('35m 后');
    expect(formatCountdown('2026-11-26T08:45:00+08:00', now)).toBe('7h 20m 后');
    expect(formatCountdown('2026-11-27T09:25:00+08:00', now)).toBe('1天 8h 后');
  });

  test('buildScheduleTimeline staggers close triggers across top/bottom rows and counts later schedules', () => {
    const now = Date.parse('2026-11-26T01:25:00+08:00');
    const items = [
      trigger({ id: 't4', name: '早盘巡检', next_at: '2026-11-26T00:20:00.000Z', next_local: '2026-11-26 08:20' }),
      trigger({ id: 't1', name: '开盘核对', next_at: '2026-11-26T00:45:00.000Z', next_local: '2026-11-26 08:45' }),
      trigger({ id: 't2', name: '盘后封日', next_at: '2026-11-26T08:15:00.000Z', next_local: '2026-11-26 16:15' }),
      trigger({ id: 't3', name: '盘后合入', next_at: '2026-11-26T10:10:00.000Z', next_local: '2026-11-26 18:10' }),
      trigger({ id: 'tNext', name: '明日检查', next_at: '2026-11-27T00:30:00.000Z', next_local: '2026-11-27 08:30' }),
      trigger({ id: 'tEvent', name: '验收播报', source: 'event', schedule: null, event: { kind: 'work_ready', task_id: null }, next_at: null, next_local: null }),
    ];
    const pastFire = {
      id: 'f0', created_at: '2026-11-25T16:30:00.000Z', trigger_id: 't4', source_id: null, project_id: 'p1',
      trigger_name: '凌晨检查', event_id: 'e0', scheduled_at: '2026-11-25T16:30:00.000Z', revision: 1,
      outcome: 'delivered' as const, merged_into: null, merged_count: 1, merged_capped: false, message_id: 'm0', message_state: 'done', push_final: false, data: {},
    };

    const timeline = buildScheduleTimeline(items, [pastFire], 'Asia/Shanghai', now);
    expect(timeline.visible).toBe(true);
    expect(timeline.dayKind).toBe('today');
    expect(timeline.nowLabel).toBe('01:25');
    expect(timeline.nodes.map((n) => [n.id, n.timeLabel, n.row])).toEqual([
      ['t4', '08:20', 'top'],
      ['t1', '08:45', 'bottom'],
      ['t2', '16:15', 'top'],
      ['t3', '18:10', 'bottom'],
    ]);
    expect(timeline.laterCount).toBe(1);
    expect(timeline.pastFires).toHaveLength(1);
    expect(timeline.pastFires[0]?.timeLabel).toBe('00:30');
    expect(timeline.nextTrigger).toMatchObject({ id: 't4', timeLabel: '08:20', countdown: '6h 55m 后' });
  });

  test('buildScheduleTimeline falls back to tomorrow when today has no remaining schedules and hides when none exist', () => {
    const late = Date.parse('2026-11-26T23:10:00+08:00');
    const tomorrowOnly = [
      trigger({ id: 'tm1', name: '明早巡检', next_at: '2026-11-27T00:20:00.000Z', next_local: '2026-11-27 08:20' }),
    ];
    const timeline = buildScheduleTimeline(tomorrowOnly, [], 'Asia/Shanghai', late);
    expect(timeline.visible).toBe(true);
    expect(timeline.dayKind).toBe('tomorrow');
    expect(timeline.nowPct).toBeNull();
    expect(timeline.nodes[0]?.timeLabel).toBe('08:20');

    const eventOnly = [
      trigger({ id: 'ev1', source: 'event', schedule: null, event: { kind: 'merged', task_id: null }, next_at: null, next_local: null }),
    ];
    expect(buildScheduleTimeline(eventOnly, [], 'Asia/Shanghai', late).visible).toBe(false);
  });

  test('triggerClockMeta formats schedule and event triggers cleanly', () => {
    const now = Date.parse('2026-11-26T07:30:00+08:00');
    const sched = triggerClockMeta(trigger({ next_at: '2026-11-26T00:45:00.000Z', next_local: '2026-11-26 08:45' }), 'Asia/Shanghai', now);
    expect(sched).toMatchObject({ clock: '08:45', dateTag: '今天', countdown: '1h 15m 后', urgent: true, isEvent: false });

    const ev = triggerClockMeta(trigger({ source: 'event', schedule: null, event: { kind: 'work_ready', task_id: null }, next_at: null, next_local: null }), 'Asia/Shanghai', now);
    expect(ev).toMatchObject({ clock: '事件', countdown: '实时监听', isEvent: true });
  });
});
