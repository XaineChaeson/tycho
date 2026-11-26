import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pickLogin, type Candidate } from '../service/pick.ts';
import { openLedger } from '../service/ledger.ts';
import {
  deriveEffectiveTierSlots,
  effectiveRouteOfLogin,
  executionPermissionSummary,
  logicalAccountKey,
  parseProjectDispatchConfig,
  slotForLogin,
} from '../shared/dispatch-slots.ts';

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
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

test('route-qualified logical keys split distinct channels (lan-gw vs deepseek-official) while preserving broad fallback and project slot overrides', () => {
  const lanTier = { execute: { kind: 'content' as const, text: '- id: agent-default-model\n  config:\n    provider: "lan-gw"\n    model: deepseek-flash\n' } };
  const officialTier = { execute: { kind: 'content' as const, text: '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n' } };
  const multiRouteTiers = {
    execute: { kind: 'content' as const, text: '- id: agent-default-model\n  config:\n    provider: lan-gw\n' },
    decide: { kind: 'content' as const, text: '- id: agent-default-model\n  config:\n    provider: deepseek-official\n' },
  };

  assert.equal(effectiveRouteOfLogin({ routeLabel: 'deepseek-official', tiers: lanTier }), 'lan-gw');
  assert.equal(effectiveRouteOfLogin({ routeLabel: 'deepseek-official', tiers: multiRouteTiers }, 'execute'), 'lan-gw');
  assert.equal(effectiveRouteOfLogin({ routeLabel: 'deepseek-official', tiers: multiRouteTiers }, 'decide'), 'deepseek-official');
  assert.equal(effectiveRouteOfLogin({ routeLabel: 'deepseek-official', tiers: {} }), 'deepseek-official');
  assert.equal(effectiveRouteOfLogin({ routeLabel: null, tiers: {} }), null);

  const officeDsh = { id: 'ml-office-dsh', executor: 'dsh', machine: 'workstation-01', tiers: lanTier };
  const homeDsh = { id: 'ml-home-dsh', executor: 'dsh', machine: 'home-desktop', tiers: officialTier };
  const gemKr = { id: 'ml-kr-gem', executor: 'gemini', machine: 'kr', tiers: {} };
  const gemWin = { id: 'ml-win-gem', executor: 'gemini', machine: 'workstation-01', tiers: {} };

  // Distinct dsh channels get distinct logical keys; identical multi-machine gemini collapses into one
  assert.equal(logicalAccountKey(officeDsh), 'executor:dsh:lan-gw');
  assert.equal(logicalAccountKey(homeDsh), 'executor:dsh:deepseek-official');
  assert.equal(logicalAccountKey(gemKr), 'executor:gemini');
  assert.equal(logicalAccountKey(gemWin), 'executor:gemini');

  // Legacy broad executor:dsh key still applies smoothly until split
  const legacyBroad = { p1: ['executor:dsh'], p2: ['executor:gemini'], off: [] };
  assert.equal(slotForLogin(officeDsh, legacyBroad), 1);
  assert.equal(slotForLogin(homeDsh, legacyBroad), 1);
  const derivedFromBroad = deriveEffectiveTierSlots(
    ['executor:dsh:lan-gw', 'executor:dsh:deepseek-official', 'executor:gemini'],
    legacyBroad,
  );
  assert.deepEqual(derivedFromBroad, {
    p1: ['executor:dsh:lan-gw', 'executor:dsh:deepseek-official'],
    p2: ['executor:gemini'],
    off: [],
  });

  // Specific route slot overrides broad key cleanly; covering account off-slot applies to covered machine login
  const splitSlots = {
    p1: ['executor:dsh:lan-gw', 'acc-codex'],
    p2: ['executor:gemini'],
    off: ['executor:dsh:deepseek-official', 'acc-off'],
  };
  assert.equal(slotForLogin(officeDsh, splitSlots), 1);
  assert.equal(slotForLogin(homeDsh, splitSlots), 'off');
  assert.equal(slotForLogin(gemKr, splitSlots), 2);
  assert.equal(slotForLogin({ id: 'ml-covered', executor: 'codex', machine: 'home-desktop' }, splitSlots, ['acc-off']), 'off');

  // Project-level dispatch slots persist in dispatch_order_json without breaking legacy array parsing
  const parsedNew = parseProjectDispatchConfig(JSON.stringify({ execute: splitSlots }));
  assert.deepEqual(parsedNew.slots?.execute, splitSlots);
  assert.equal(parsedNew.order, null);
  const parsedLegacy = parseProjectDispatchConfig(JSON.stringify({ execute: ['acc-1', 'acc-2'] }));
  assert.equal(parsedLegacy.slots, null);
  assert.deepEqual(parsedLegacy.order, { execute: ['acc-1', 'acc-2'] });

  const dir = mkdtempSync(join(tmpdir(), 'tycho-proj-slots-'));
  try {
    const ledger = openLedger(join(dir, 'ledger.db'));
    const projectId = ledger.createProject({ name: 'slot-proj', loginMode: 'all' }, { actor: 'test' });
    assert.equal(ledger.projectDispatchSlots(projectId), null);
    ledger.setProjectDispatchSlots(projectId, { execute: splitSlots }, { actor: 'test' });
    assert.deepEqual(ledger.projectDispatchSlots(projectId), { execute: splitSlots });
    assert.equal(ledger.projectDispatchOrder(projectId), null);
    ledger.setProjectDispatchSlots(projectId, null, { actor: 'test' });
    assert.equal(ledger.projectDispatchSlots(projectId), null);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('adoptMachineLogin skips redundant machine login when a centralized account covers the same identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-adopt-dedup-'));
  const ledger = openLedger(join(dir, 'ledger.db'));
  try {
    const ctx = { actor: 'test' };
    ledger.joinMachine({ id: 'm1', host: 'm1', nodeId: 'n1', tokenHash: 'h1', platform: 'win32', source: null, ephemeral: false }, ctx);
    ledger.putAccount({ id: 'acc-codex', name: 'codex 账号', executor: 'codex', tiers: {} }, ctx, 'cred-ref-1');
    ledger.noteIdentity('acc-codex', { quotaOwner: 'v1:same-owner', accountLabel: 'me@g***.com' });

    // Same quotaOwner -> skipped
    assert.deepEqual(
      ledger.adoptMachineLogin('m1', 'codex', {}, ctx, { quotaOwner: 'v1:same-owner' }),
      { created: false },
    );
    assert.equal(ledger.getMachineLogin('m1', 'codex'), undefined);

    // Same accountLabel (case-insensitive) -> skipped
    assert.deepEqual(
      ledger.adoptMachineLogin('m1', 'codex', {}, ctx, { accountLabel: 'ME@g***.com' }),
      { created: false },
    );
    assert.equal(ledger.getMachineLogin('m1', 'codex'), undefined);

    // Different identity -> adopted normally
    assert.deepEqual(
      ledger.adoptMachineLogin('m1', 'codex', {}, ctx, { quotaOwner: 'v1:other-owner', accountLabel: 'other@g***.com' }),
      { created: true },
    );
    assert.ok(ledger.getMachineLogin('m1', 'codex'));

    // Different executor with same email -> adopted normally
    assert.deepEqual(
      ledger.adoptMachineLogin('m1', 'claude', {}, ctx, { quotaOwner: 'v1:same-owner', accountLabel: 'me@g***.com' }),
      { created: true },
    );
    assert.ok(ledger.getMachineLogin('m1', 'claude'));
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
