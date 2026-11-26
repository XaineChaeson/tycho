import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { routerKnowledge, workaroundRevalidationHint } from '../service/knowledge-brief.ts';
import type { Entry } from '../service/knowledge.ts';
import { openLedger } from '../service/ledger.ts';

function makeEntry(over: Partial<Entry>): Entry {
  return {
    id: '01TESTENTRY000000000000001',
    kind: 'knowledge',
    revision: 1,
    state: 'active',
    title: '普通架构说明',
    when_to_use: '查看系统架构时',
    body: '生产目录没有 git 仓库。',
    project_ids: ['p1'],
    roles: [],
    loading: 'on_demand',
    published_at: '2026-11-25T08:25:00.000Z',
    reviewed_at: null,
    ...over,
  } as Entry;
}

test('workaroundRevalidationHint flags stale workaround entries after platform upgrade or 7 days, never normal domain knowledge', () => {
  const hostVersion = { current: '0.1.860', previous: '0.1.859', upgraded_at: '2026-11-25T17:00:00.000Z' };

  // Ordinary domain knowledge is never flagged
  const domain = makeEntry({});
  assert.equal(workaroundRevalidationHint(domain, { hostVersion }), null);

  // Workaround published before platform upgrade is flagged with self-retire hint
  const workaround = makeEntry({
    title: '规避 Windows cmd 换行导致 continue_task 启动失败',
    when_to_use: '跟进 DEV-WORKSTATION/dsh 任务时',
    body: '规避方式：先用 create_task，直至平台修复该问题。',
    published_at: '2026-11-25T08:25:00.000Z',
  });
  const hint = workaroundRevalidationHint(workaround, { hostVersion });
  assert.ok(hint);
  assert.match(hint, /待复核/);
  assert.match(hint, /0\.1\.860/);
  assert.match(hint, /propose_learning/);

  const rendered = routerKnowledge([domain, workaround], { hostVersion });
  assert.match(rendered.catalog, /\[待复核：tycho 已升级至 0\.1\.860/);
  assert.doesNotMatch(rendered.catalog, /普通架构说明.*待复核/);

  // Workaround published AFTER the upgrade is not flagged until 7 days pass
  const fresh = makeEntry({
    title: '临时规避某接口限流',
    body: '规避方式：先降频。',
    published_at: '2026-11-25T18:00:00.000Z',
  });
  assert.equal(workaroundRevalidationHint(fresh, { hostVersion, nowMs: Date.parse('2026-11-26T00:00:00.000Z') }), null);
  assert.match(
    workaroundRevalidationHint(fresh, { hostVersion, nowMs: Date.parse('2026-12-03T19:00:00.000Z') }) ?? '',
    /超过 7 天/,
  );
});

test('ledger.recordHostVersion persists into setting table and detects upgrades', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-hostver-'));
  try {
    const ledger = openLedger(join(dir, 'ledger.db'));
    assert.equal(ledger.hostVersionState(), null);
    const first = ledger.recordHostVersion('0.1.860');
    assert.equal(first.current, '0.1.860');
    assert.equal(first.previous, null);
    assert.equal(first.upgraded, false);

    const same = ledger.recordHostVersion('0.1.860');
    assert.equal(same.upgraded, false);
    assert.equal(same.upgraded_at, first.upgraded_at);

    const next = ledger.recordHostVersion('0.1.861');
    assert.equal(next.current, '0.1.861');
    assert.equal(next.previous, '0.1.860');
    assert.equal(next.upgraded, true);

    const persisted = ledger.hostVersionState();
    assert.equal(persisted?.current, '0.1.861');
    assert.equal(persisted?.previous, '0.1.860');
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
