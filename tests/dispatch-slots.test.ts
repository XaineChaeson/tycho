import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pickLogin, type Candidate } from '../service/pick.ts';
import { openLedger } from '../service/ledger.ts';
import { deriveEffectiveTierSlots, executionPermissionSummary, logicalAccountKey, slotForLogin } from '../shared/dispatch-slots.ts';

test('pickLogin performs Least-Active -> Quota-Aware load balancing inside P1 and strict failover to P2', () => {
  const opts = { now: 10_000, lead: 100, warnAt: 0.9 };

  // Both in P1, both idle -> Quota-Aware picks lower usage (higher remaining %)
  const idlePool: Candidate[] = [
    { id: 'codex', active: 0, usage: 0.41, slot: 1 },
    { id: 'gemini-kr', active: 0, usage: 0.14, slot: 1 },
    { id: 'dsh', active: 0, usage: 0, slot: 2 },
  ];
  assert.deepEqual(pickLogin(idlePool, opts), { pick: 'gemini-kr' });

  // Once gemini-kr is busy (active=1), Least-Active immediately balances to idle codex in P1, NOT P2 dsh
  const busyGemini: Candidate[] = [
    { id: 'codex', active: 0, usage: 0.41, slot: 1 },
    { id: 'gemini-kr', active: 1, usage: 0.14, slot: 1 },
    { id: 'dsh', active: 0, usage: 0, slot: 2 },
  ];
  assert.deepEqual(pickLogin(busyGemini, opts), { pick: 'codex' });

  // When all P1 candidates are near quota limit (>= warnAt) or full, strict failover to fresh P2
  const p1Exhausted: Candidate[] = [
    { id: 'codex', active: 2, maxRuns: 2, usage: 0.41, slot: 1 },
    { id: 'gemini-kr', active: 0, usage: 0.92, slot: 1 },
    { id: 'dsh', active: 0, usage: 0.1, slot: 2 },
  ];
  assert.deepEqual(pickLogin(p1Exhausted, opts), { pick: 'dsh' });

  // When P2 is also unavailable, falls back to near-limit open P1 rather than waiting
  const onlyNearLimitP1: Candidate[] = [
    { id: 'gemini-kr', active: 0, usage: 0.92, slot: 1 },
    { id: 'dsh', active: 0, restUntil: 60_000, slot: 2 },
  ];
  assert.deepEqual(pickLogin(onlyNearLimitP1, opts), { pick: 'gemini-kr' });
});

test('logicalAccountKey groups machine logins by executor and ledger persists priority slots atomically', () => {
  assert.equal(logicalAccountKey({ id: 'acc-1', executor: 'codex', machine: null }), 'acc-1');
  assert.equal(logicalAccountKey({ id: 'ml-kr', executor: 'gemini', machine: 'kr' }), 'executor:gemini');
  assert.equal(logicalAccountKey({ id: 'ml-win', executor: 'gemini', machine: 'DEV-WORKSTATION' }), 'executor:gemini');

  const slots = { p1: ['executor:gemini', 'acc-1'], p2: ['executor:dsh'], off: [] };
  assert.equal(slotForLogin({ id: 'ml-kr', executor: 'gemini', machine: 'kr' }, slots), 1);
  assert.equal(slotForLogin({ id: 'ml-new-host', executor: 'gemini', machine: 'ubuntu-4' }, slots), 1);
  assert.equal(slotForLogin({ id: 'ml-dsh', executor: 'dsh', machine: 'win' }, slots), 2);
  assert.equal(slotForLogin({ id: 'acc-new', executor: 'claude', machine: null }, slots), 2);

  const dir = mkdtempSync(join(tmpdir(), 'tycho-slots-'));
  try {
    const ledger = openLedger(join(dir, 'ledger.db'));
    assert.equal(ledger.dispatchSlots(), null);
    const saved = ledger.setTierDispatchSlots('decide', {
      p1: ['executor:gemini', 'acc-1'],
      p2: ['executor:dsh'],
      off: ['acc-cheap'],
    });
    assert.deepEqual(saved.slots.decide, {
      p1: ['executor:gemini', 'acc-1'],
      p2: ['executor:dsh'],
      off: ['acc-cheap'],
    });
    assert.deepEqual(ledger.dispatchSlots()?.decide, saved.slots.decide);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveEffectiveTierSlots and executionPermissionSummary return expected defaults', () => {
  const derived = deriveEffectiveTierSlots(['acc-1', 'executor:dsh', 'executor:gemini'], undefined, ['executor:gemini', 'acc-1']);
  assert.deepEqual(derived, { p1: ['executor:gemini'], p2: ['acc-1', 'executor:dsh'], off: [] });

  assert.equal(executionPermissionSummary('codex', null).mode, 'danger-full-access');
  assert.equal(executionPermissionSummary('codex', null).autoFullAccess, true);
  assert.equal(executionPermissionSummary('codex', 'inherit-machine').autoFullAccess, false);
  assert.equal(executionPermissionSummary('gemini', null).mode, 'dangerously-skip-permissions');
});
