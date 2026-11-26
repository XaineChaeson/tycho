// Guards the count of failed logins from outside: a source let through past its number, all
// sources together let through past theirs, a count that never forgets, and a change of the
// settings waiting for a restart (they are read at each use).
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoginLimit } from '../service/login-limit.ts';

function limitWith(start: { windowMs: number; perSource: number; total: number }) {
  const policy = { ...start };
  let at = 1_000_000;
  const limit = createLoginLimit({ windowMs: () => policy.windowMs, perSource: () => policy.perSource, total: () => policy.total }, () => at);
  return { limit, policy, pass: (ms: number) => { at += ms; } };
}

test('a source is shut out at its number, the others are not, and the window forgets', () => {
  const { limit, pass } = limitWith({ windowMs: 60_000, perSource: 2, total: 100 });
  limit.failed('a');
  assert.equal(limit.closed('a'), false);
  limit.failed('a');
  assert.equal(limit.closed('a'), true);
  assert.equal(limit.closed('b'), false);
  pass(60_001);
  assert.equal(limit.closed('a'), false);
});

test('all sources together are shut out at the total', () => {
  const { limit } = limitWith({ windowMs: 60_000, perSource: 100, total: 3 });
  for (const source of ['a', 'b', 'c']) limit.failed(source);
  assert.equal(limit.closed('d'), true);
});

test('a change of the settings holds at the next question', () => {
  const { limit, policy, pass } = limitWith({ windowMs: 60_000, perSource: 2, total: 100 });
  limit.failed('a');
  limit.failed('a');
  assert.equal(limit.closed('a'), true);
  policy.perSource = 5;
  assert.equal(limit.closed('a'), false, '调大次数马上放开');
  policy.total = 2;
  assert.equal(limit.closed('b'), true, '调小总数马上收紧');
  policy.total = 100;
  policy.perSource = 2;
  pass(20_000);
  policy.windowMs = 10_000;
  limit.failed('a');
  assert.equal(limit.closed('a'), false, '窗口改短，早于它的失败不再算');
});
