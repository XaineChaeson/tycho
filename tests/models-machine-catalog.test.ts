import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexAdapter } from '../adapters/codex.ts';
import type { ModelInfo } from '../adapters/types.ts';
import type { Account } from '../runner/snapshot.ts';
import { createModels, readModels } from '../service/models.ts';
import { createNotify } from '../service/notify.ts';
import { fixture, USER } from './helpers.ts';

const EXECUTORS = { codex: codexAdapter };
const T1 = Date.parse('2026-11-17T10:20:00.000Z');
const T2 = Date.parse('2026-11-26T05:30:00.000Z');
const AT1 = new Date(T1).toISOString();
const AT2 = new Date(T2).toISOString();

test('readModels for CLI-catalog executor (codex) falls back to error when no machine catalog is available', async () => {
  const res = await readModels({
    executor: 'codex',
    executors: EXECUTORS,
    timeoutMs: 5_000,
    now: () => T2,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /在机器上问/);
});

test('readModels and createModels sync centralized codex account from machine-reported model catalog', async (t) => {
  const f = fixture(t, {}, false);
  const accountId = 'acc-codex-central';
  const account: Account = {
    id: accountId,
    name: 'codex 账号',
    executor: 'codex',
    tiers: {
      execute: { kind: 'content', text: 'model = "gpt-6.2-sol"\n' },
    },
  };
  f.ledger.putAccount(account, USER, 'ref-codex-central');

  const oldModels: ModelInfo[] = [
    { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  ];
  f.ledger.noteModels(accountId, oldModels, AT1);

  const freshModels: ModelInfo[] = [
    { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'gpt-6.2-sol', name: 'gpt-6.2-sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    { id: 'gpt-6.2-astra', name: 'gpt-6.2-astra', efforts: ['medium', 'high', 'xhigh'], defaultEffort: 'high' },
  ];
  const notify = createNotify({ ledger: f.ledger, owner: () => 'user', direct: async () => {}, log: () => {} });
  const models = createModels({
    ledger: f.ledger,
    logins: () => f.ledger.listAccounts(),
    executors: EXECUTORS,
    notify,
    refreshMs: () => 3_600_000,
    timeoutMs: 5_000,
    now: () => T2,
    machineModels: (executor) => (executor === 'codex' ? { models: freshModels, at: AT2 } : null),
  });

  const refreshed = await models.refresh(account);
  assert.equal(refreshed.ok, true);
  if (refreshed.ok) {
    assert.deepEqual(refreshed.models.map((m) => m.id), ['gpt-5.6-sol', 'gpt-6.2-sol', 'gpt-6.2-astra']);
    assert.deepEqual(refreshed.added.map((m) => m.id), ['gpt-6.2-sol', 'gpt-6.2-astra']);
    assert.deepEqual(refreshed.gone, []);
  }

  const stored = f.ledger.loginState(accountId);
  assert.equal(stored.models_at, AT2);
  assert.deepEqual(stored.models.map((m) => m.id), ['gpt-5.6-sol', 'gpt-6.2-sol', 'gpt-6.2-astra']);
});
