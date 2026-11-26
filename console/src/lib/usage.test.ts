// Guards against: a range that drops today or a day at its start, or asks the service for UTC
// days instead of the reader's; an axis whose top is below the tallest bar; and a price under a
// cent shown as nothing spent.
import { expect, test } from 'vitest';
import { formatUsd, niceMax, rangeOf } from './usage';

test('a range is the last days of the reader, today included, every one of them', () => {
  const now = new Date(2026, 10, 11, 0, 30);
  const range = rangeOf(7, now);
  expect(range.days).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']);
  expect(new Date(range.from).getTime()).toBe(new Date(2026, 10, 5).getTime());
  expect(new Date(range.to).getTime()).toBe(new Date(2026, 10, 12).getTime());
  expect(range.tz).toBe(-now.getTimezoneOffset());
});

test('the axis tops every bar with a round number, and small prices still show', () => {
  for (const value of [0.3, 7, 12, 99, 101, 2_340_000]) expect(niceMax(value)).toBeGreaterThanOrEqual(value);
  expect(niceMax(12)).toBe(20);
  expect(formatUsd(0.004)).toBe('<$0.01');
  expect(formatUsd(0)).toBe('$0');
  expect(formatUsd(12.345)).toBe('$12.35');
});
