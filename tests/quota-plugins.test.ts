import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readQuota } from '../node/executors.ts';
import { findQuotaPlugin, mergeQuotaWindows, parseQuotaPluginOutput, runQuotaPlugin } from '../node/quota-plugins.ts';

test('parseQuotaPluginOutput and mergeQuotaWindows handle merge, replace, and errors cleanly', () => {
  const merged = parseQuotaPluginOutput(JSON.stringify({
    windows: [{ window: 'gateway_budget:corp:$80.00/$100', used: 0.2, resets_at: null }],
  }));
  assert.ok(!('error' in merged));
  assert.equal(merged.mode, 'merge');
  assert.equal(merged.windows?.length, 1);

  const combined = mergeQuotaWindows(
    [{ window: 'balance:CNY:39.84', used: 0, resets_at: null }],
    merged.windows!,
    'merge',
  );
  assert.deepEqual(combined.map((w) => w.window), ['balance:CNY:39.84', 'gateway_budget:corp:$80.00/$100']);

  const replaced = mergeQuotaWindows(
    [{ window: 'balance:CNY:39.84', used: 0, resets_at: null }],
    merged.windows!,
    'replace',
  );
  assert.deepEqual(replaced.map((w) => w.window), ['gateway_budget:corp:$80.00/$100']);

  assert.ok('error' in parseQuotaPluginOutput('not json'));
});

test('local ~/.tycho/quota-probes/<executor>.mjs plugin merges custom windows into readQuota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-qplugin-'));
  try {
    const script = join(dir, 'dsh.mjs');
    writeFileSync(script, [
      "let raw = '';",
      "for await (const chunk of process.stdin) raw += chunk;",
      'const input = JSON.parse(raw);',
      'console.log(JSON.stringify({',
      "  mode: 'merge',",
      '  windows: [{ window: `gateway_budget:${input.executor}_corp:$50.00/$100`, used: 0.5, resets_at: null }],',
      '}));',
    ].join('\n'));

    const env = { ...process.env, TYCHO_QUOTA_PROBES_DIR: dir };
    assert.equal(findQuotaPlugin('dsh', env)?.path, script);
    assert.equal(findQuotaPlugin('codex', env), null);

    const direct = await runQuotaPlugin({ executor: 'dsh', builtin: null }, { timeoutMs: 5000, env });
    assert.ok(direct && !('error' in direct));
    assert.equal(direct.windows?.[0]?.window, 'gateway_budget:dsh_corp:$50.00/$100');

    const status = await readQuota(
      {
        kind: 'probe',
        read: async () => ({ windows: [{ window: 'balance:CNY:39.84', used: 0, resets_at: null }] }),
      },
      { executor: 'dsh', version: '0.2.2', timeoutMs: 5000, env },
    );
    assert.equal(status.error, undefined);
    assert.deepEqual(
      status.windows.map((w) => w.window),
      ['balance:CNY:39.84', 'gateway_budget:dsh_corp:$50.00/$100'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
