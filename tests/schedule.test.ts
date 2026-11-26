// Guards the one time module triggers and schedule_wake share (docs/design/triggers.md §2.1, §5)
// against: an instant without a zone taken as the host's local time; a cron expression with a
// field out of range, a reversed range, a zero step or a count of fields other than five taken
// as something else; a cron without an IANA zone, or with a zone the runtime does not know;
// day-of-month and day-of-week combined the wrong way; a moment that does not exist on a
// spring-forward day fired at a shifted time, and one that happens twice on a fall-back day
// fired twice; a "next" moment equal to the one asked after; a fixed interval drifting off its
// anchor; the count and the last of the moments missed while the service was down being wrong
// or unbounded; a rule that can never fire, or fires more often than the minimum interval,
// accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSchedule, hostZone, lastMoment, minGap, momentsBetween, nextMoment, parseCron, parseInstant, parseSchedule } from '../service/schedule.ts';
import { InputError } from '../service/errors.ts';

const at = (iso: string): Date => new Date(iso);
const iso = (date: Date | undefined): string | undefined => date?.toISOString();

test('an instant has to carry its zone; a Date is taken as it is', () => {
  assert.equal(parseInstant('2030-01-01T08:00:00+08:00'), '2030-01-01T00:00:00.000Z');
  assert.equal(parseInstant('2030-01-01T00:00:00Z'), '2030-01-01T00:00:00.000Z');
  assert.equal(parseInstant('2030-01-01T08:00:00'), undefined, '没带时区的不能按主机时间猜');
  assert.equal(parseInstant('明天早上'), undefined);
  assert.equal(parseInstant(at('2030-01-01T00:00:00Z')), '2030-01-01T00:00:00.000Z');
});

test('a cron expression is five fields, each in range, and says what it refuses', () => {
  assert.doesNotThrow(() => parseCron('0 8 * * 1-5'));
  assert.doesNotThrow(() => parseCron('*/15 9-17 * JAN-MAR mon,wed,FRI'));
  assert.doesNotThrow(() => parseCron('0 0 1,15 * 7'), '7 也是星期天');
  for (const bad of ['0 8 * *', '0 8 * * * *', '60 8 * * *', '0 24 * * *', '0 8 0 * *', '0 8 * 13 *', '0 8 * * 8', '0 10-8 * * *', '*/0 * * * *', '0 8 * * MOO', '', 'a b c d e']) {
    assert.throws(() => parseCron(bad), InputError, bad);
  }
});

test('a cron rule needs a known IANA zone, and the host zone is one', () => {
  assert.throws(() => parseSchedule({ kind: 'cron', expr: '0 8 * * *', zone: 'Mars/Olympus' }), InputError);
  assert.throws(() => parseSchedule({ kind: 'cron', expr: '0 8 * * *', zone: '' }), InputError);
  assert.throws(() => parseSchedule({ kind: 'cron', expr: '0 8 * * *', zone: '+08:00' }), InputError);
  assert.equal(parseSchedule({ kind: 'cron', expr: ' 0  8 * * * ', zone: 'Asia/Shanghai' }).kind, 'cron');
  assert.doesNotThrow(() => parseSchedule({ kind: 'cron', expr: '0 8 * * *', zone: hostZone() }));
});

test('cron moments are the zone\'s wall clock and strictly after the instant asked after', () => {
  const rule = parseSchedule({ kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' });
  assert.equal(iso(nextMoment(rule, at('2030-01-01T00:00:00Z'))), '2030-01-02T00:00:00.000Z', '正好在 8 点不算下一次');
  assert.equal(iso(nextMoment(rule, at('2029-12-31T23:59:59Z'))), '2030-01-01T00:00:00.000Z');
  const weekdays = parseSchedule({ kind: 'cron', expr: '30 9 * * 1-5', zone: 'UTC' });
  // 2030-01-04 is a Friday.
  assert.equal(iso(nextMoment(weekdays, at('2030-01-04T10:00:00Z'))), '2030-01-07T09:30:00.000Z');
});

test('day of month and day of week, both given, fire on either; one of them a star, on the other', () => {
  // 2030-01-01 is a Tuesday.
  const either = parseSchedule({ kind: 'cron', expr: '0 0 13 * 5', zone: 'UTC' });
  assert.equal(iso(nextMoment(either, at('2030-01-01T00:00:00Z'))), '2030-01-04T00:00:00.000Z', '星期五先到');
  assert.equal(iso(nextMoment(either, at('2030-01-11T00:00:00Z'))), '2030-01-13T00:00:00.000Z', '13 号也算');
  const onlyDay = parseSchedule({ kind: 'cron', expr: '0 0 13 * *', zone: 'UTC' });
  assert.equal(iso(nextMoment(onlyDay, at('2030-01-01T00:00:00Z'))), '2030-01-13T00:00:00.000Z');
});

test('a wall time that does not exist on a spring-forward day is skipped, not moved', () => {
  // New York springs forward at 02:00 on 2026-03-08: 02:30 never happens that day.
  const rule = parseSchedule({ kind: 'cron', expr: '30 2 * * *', zone: 'America/New_York' });
  const moments = momentsBetween(rule, at('2026-03-06T12:00:00Z'), at('2026-03-10T00:00:00Z'), 10).moments.map((each) => each.toISOString());
  assert.deepEqual(moments, ['2026-03-07T07:30:00.000Z', '2026-03-09T06:30:00.000Z']);
});

test('a wall time that happens twice on a fall-back day fires only the first time', () => {
  // New York falls back at 02:00 on 2026-11-01: 01:30 happens at 05:30Z and again at 06:30Z.
  const rule = parseSchedule({ kind: 'cron', expr: '30 1 * * *', zone: 'America/New_York' });
  const moments = momentsBetween(rule, at('2026-10-31T00:00:00Z'), at('2026-11-02T12:00:00Z'), 10).moments.map((each) => each.toISOString());
  assert.deepEqual(moments, ['2026-10-31T05:30:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  assert.equal(iso(nextMoment(rule, at('2026-11-01T05:30:00Z'))), '2026-11-02T06:30:00.000Z', '重复的那一次不再触发');
  // Asked from inside the repeated hour, the next minute of it is not a new moment either.
  const everyMinute = parseSchedule({ kind: 'cron', expr: '* 1 * * *', zone: 'America/New_York' });
  assert.equal(iso(nextMoment(everyMinute, at('2026-11-01T06:10:00Z'))), '2026-11-02T06:00:00.000Z');
});

test('a fixed interval counts from its anchor; a one-time rule fires once', () => {
  const every = parseSchedule({ kind: 'every', every_ms: 3_600_000, anchor: '2030-01-01T00:20:00Z' });
  assert.equal(iso(nextMoment(every, at('2030-01-01T05:00:00Z'))), '2030-01-01T05:20:00.000Z');
  assert.equal(iso(nextMoment(every, at('2030-01-01T05:20:00Z'))), '2030-01-01T06:20:00.000Z');
  assert.equal(iso(nextMoment(every, at('2029-12-01T00:00:00Z'))), '2030-01-01T00:20:00.000Z', '锚点之前的第一次是锚点本身');
  const once = parseSchedule({ kind: 'once', at: '2030-01-01T00:00:00+08:00' });
  assert.equal(iso(nextMoment(once, at('2029-12-31T00:00:00Z'))), '2029-12-31T16:00:00.000Z');
  assert.equal(nextMoment(once, at('2029-12-31T16:00:00Z')), undefined);
});

test('the moments missed over a long stop are counted to a cap and the last one is still found', () => {
  const every = parseSchedule({ kind: 'every', every_ms: 60_000, anchor: '2030-01-01T00:00:00Z' });
  const window = momentsBetween(every, at('2030-01-01T00:00:00Z'), at('2030-01-31T00:00:00Z'), 100);
  assert.equal(window.count, 100);
  assert.equal(window.capped, true);
  assert.equal(iso(lastMoment(every, at('2030-01-01T00:00:00Z'), at('2030-01-31T00:00:30Z'))), '2030-01-31T00:00:00.000Z');
  const cron = parseSchedule({ kind: 'cron', expr: '*/5 * * * *', zone: 'UTC' });
  const many = momentsBetween(cron, at('2030-01-01T00:00:00Z'), at('2030-03-01T00:00:00Z'), 50);
  assert.deepEqual([many.count, many.capped], [50, true]);
  assert.equal(iso(lastMoment(cron, at('2030-01-01T00:00:00Z'), at('2030-03-01T00:02:00Z'))), '2030-03-01T00:00:00.000Z');
  const weekly = parseSchedule({ kind: 'cron', expr: '0 8 * * 1', zone: 'UTC' });
  assert.equal(iso(lastMoment(weekly, at('2029-12-01T00:00:00Z'), at('2030-01-05T00:00:00Z'))), '2029-12-31T08:00:00.000Z');
  assert.equal(lastMoment(weekly, at('2029-12-31T08:00:00Z'), at('2030-01-05T00:00:00Z')), undefined);
});

test('a rule that never fires, and how close two of its moments come, are told before it is kept', () => {
  assert.throws(() => parseSchedule({ kind: 'cron', expr: '0 0 31 2 *', zone: 'UTC' }), /不会触发/);
  assert.doesNotThrow(() => parseSchedule({ kind: 'cron', expr: '0 0 29 2 *', zone: 'UTC' }), '闰年的 2 月 29 日会到');
  const from = at('2030-01-01T00:00:00Z');
  assert.equal(minGap(parseSchedule({ kind: 'cron', expr: '0,1 9 * * *', zone: 'UTC' }), from), 60_000);
  assert.equal(minGap(parseSchedule({ kind: 'cron', expr: '0 9 * * *', zone: 'UTC' }), from), 86_400_000);
  assert.equal(minGap(parseSchedule({ kind: 'every', every_ms: 600_000, anchor: '2030-01-01T00:00:00Z' }), from), 600_000);
  assert.equal(minGap(parseSchedule({ kind: 'once', at: '2030-01-02T00:00:00Z' }), from), undefined);
});

test('a rule is described in plain words for pages and tools', () => {
  assert.match(describeSchedule(parseSchedule({ kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' })), /cron 0 8 \* \* \*.*Asia\/Shanghai/);
  assert.match(describeSchedule(parseSchedule({ kind: 'every', every_ms: 5_400_000, anchor: '2030-01-01T00:00:00Z' })), /每 90 分钟/);
  assert.match(describeSchedule(parseSchedule({ kind: 'once', at: '2030-01-01T00:00:00Z' })), /一次/);
});

// Review of step 1: a step in the day-of-month or day-of-week field was dropped, firing every day.
test('a step in the day fields is kept: one restricted field with a star step narrows, both restricted fire on either', () => {
  // 2030-01-01 is a Tuesday.
  const odd = parseSchedule({ kind: 'cron', expr: '0 0 */2 * *', zone: 'UTC' });
  assert.equal(iso(nextMoment(odd, at('2030-01-01T00:00:00Z'))), '2030-01-03T00:00:00.000Z');
  const everyOtherWeekday = parseSchedule({ kind: 'cron', expr: '0 0 * * */2', zone: 'UTC' });
  // Sunday, Tuesday, Thursday, Saturday.
  assert.equal(iso(nextMoment(everyOtherWeekday, at('2030-01-01T00:00:00Z'))), '2030-01-03T00:00:00.000Z');
  // A star step on one side and a list on the other: both have to hold (Vixie cron).
  const both = parseSchedule({ kind: 'cron', expr: '0 0 */2 * 5', zone: 'UTC' });
  assert.equal(iso(nextMoment(both, at('2030-01-01T00:00:00Z'))), '2030-01-11T00:00:00.000Z', '1 月 11 日是单数日的星期五');
  assert.equal(minGap(odd, at('2030-01-01T00:00:00Z')), 86_400_000, '月底 31 日到 1 日是相邻两天');
});

// Review of step 1: the closest two moments were sampled from the first 200, missing the next
// spring-forward when it came later than that.
test('the closest two moments are found across the zone\'s changes, however far ahead the next one is', () => {
  const daily = parseSchedule({ kind: 'cron', expr: '0 8 * * *', zone: 'America/New_York' });
  // From July the fall-back comes first (25 h) and the spring-forward of March 2027 only after
  // more than 200 moments: there, 2027-03-13 13:00Z to 2027-03-14 12:00Z is 23 h.
  assert.equal(minGap(daily, at('2026-07-01T00:00:00Z')), 23 * 3_600_000);
  // A gap the spring-forward makes no shorter than the rule's own: every five minutes stays five.
  const dense = parseSchedule({ kind: 'cron', expr: '*/5 * * * *', zone: 'America/New_York' });
  assert.equal(minGap(dense, at('2026-07-01T00:00:00Z')), 5 * 60_000);
  // A rule of its own zone's fixed offset: what the fields say.
  assert.equal(minGap(parseSchedule({ kind: 'cron', expr: '0 8 * * 1', zone: 'Asia/Shanghai' }), at('2026-07-01T00:00:00Z')), 7 * 86_400_000);
  // Two moments a year apart in the fields, a day apart at the turn of the year.
  assert.equal(minGap(parseSchedule({ kind: 'cron', expr: '0 0 31 12 *', zone: 'UTC' }), at('2026-07-01T00:00:00Z')), 365 * 86_400_000);
  assert.equal(minGap(parseSchedule({ kind: 'cron', expr: '0 0 1,31 1,12 *', zone: 'UTC' }), at('2026-07-01T00:00:00Z')), 86_400_000);
});
