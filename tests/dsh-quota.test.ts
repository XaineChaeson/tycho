import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDshMachineQuota } from '../adapters/dsh-machine-quota.ts';
import { combineQuotaReaders, createDshQuotaReader } from '../service/dsh-quota.ts';
import type { Account } from '../runner/snapshot.ts';

const baseAccount = (provider: Account['provider']): Account => ({
  id: 'acc-dsh',
  name: 'DSH 网关',
  executor: 'dsh',
  tiers: {},
  provider,
});

test('dsh quota reader parses DeepSeek official /user/balance and New-API /v1/dashboard/billing/*', async () => {
  const noted: { loginId: string | null; windows: readonly { window: string; used: number }[] }[] = [];
  const rejected: string[] = [];
  const ledger = {
    noteUsage(loginId: string | null, windows: readonly { window: string; used: number; resetsAt: string | null }[]) {
      noted.push({ loginId, windows });
    },
    rejectCredential(id: string) {
      rejected.push(id);
    },
    accountCredentialRef: () => 'ref-1',
  };

  // 1) DeepSeek official balance
  const officialReader = createDshQuotaReader({
    token: () => 'sk-ds-test',
    ledger,
    timeoutMs: () => 5000,
    fetch: (async (url: string | URL) => {
      assert.equal(String(url), 'https://api.deepseek.com/user/balance');
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '128.50' }],
      }), { status: 200 });
    }) as typeof fetch,
  });

  const accOfficial = baseAccount({ line: 'official' });
  assert.equal(officialReader.canRead(accOfficial), true);
  const res1 = await officialReader.read(accOfficial, 'ref-1', new AbortController().signal);
  assert.equal(res1.ok, true);
  assert.equal(noted[0]!.windows[0]!.window, 'balance:CNY:128.50');
  assert.equal(noted[0]!.windows[0]!.used, 0);

  // 2) New-API / One-API custom gateway budget
  const gatewayReader = createDshQuotaReader({
    token: () => 'sk-gateway-test',
    ledger,
    timeoutMs: () => 5000,
    fetch: (async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith('/v1/dashboard/billing/subscription')) {
        return new Response(JSON.stringify({ hard_limit_usd: 100 }), { status: 200 });
      }
      if (text.includes('/v1/dashboard/billing/usage')) {
        return new Response(JSON.stringify({ total_usage: 2500 }), { status: 200 }); // $25.00 in cents
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  });

  const accCustom = baseAccount({ line: 'custom', api: 'openai-completions', baseURL: 'https://gateway.example.com/v1', models: [{ id: 'deepseek-chat' }] });
  const combined = combineQuotaReaders(gatewayReader);
  assert.equal(combined.canRead(accCustom), true);
  const res2 = await combined.read(accCustom, 'ref-1', new AbortController().signal);
  assert.equal(res2.ok, true);
  assert.equal(noted[1]!.windows[0]!.window, 'gateway_budget:$75.00/$100');
  assert.equal(noted[1]!.windows[0]!.used, 0.25);

  // 3) 401 rejects credential cleanly
  const unauthReader = createDshQuotaReader({
    token: () => 'sk-bad',
    ledger,
    timeoutMs: () => 5000,
    fetch: (async () => new Response('unauthorized', { status: 401 })) as typeof fetch,
  });
  const res3 = await unauthReader.read(accCustom, 'ref-1', new AbortController().signal);
  assert.equal(res3.ok, false);
  assert.deepEqual(rejected, ['acc-dsh']);
});

test('dsh machine quota probe reads ~/.dsh profile gateway (unlimited & budgeted) and DeepSeek official balance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-dsh-probe-'));
  try {
    mkdirSync(join(dir, 'profiles', 'headless'), { recursive: true });
    writeFileSync(join(dir, '.credentials.yaml'), [
      'version: 1',
      'records:',
      '  deepseek-account-platform/default:',
      '    kind: secret',
      '    payload:',
      '      version: 1',
      '      token: dsh-platform-grant-test',
      '      issuer: https://platform.deepseek.com',
      'refs:',
      '  DEEPSEEK_API_KEY: sk-official-expired',
      '  CUSTOMGW_API_KEY: sk-gateway-live',
    ].join('\n'));
    writeFileSync(join(dir, 'profiles', 'headless', 'cordis.patch.yml'), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      customgw:',
      '        displayName: custom_gw',
      '        apiKeyEnv: CUSTOMGW_API_KEY',
      '        baseURL: https://gateway.example.com/v1',
      '- id: agent-default-model',
      '  config:',
      '    provider: customgw',
      '- id: llm-deepseek',
      '  disabled: true',
    ].join('\n'));

    const reading = await readDshMachineQuota({
      env: { DSH_HOME: dir },
      timeoutMs: 5000,
      fetch: (async (url: string | URL, init?: RequestInit) => {
        const text = String(url);
        if (text === 'https://platform.deepseek.com/api/v0/users/get_user_summary') {
          const headers = init?.headers as Record<string, string>;
          assert.equal(headers['x-dsh-auth-token'], 'dsh-platform-grant-test');
          return new Response(JSON.stringify({
            code: 0,
            data: {
              biz_code: 0,
              biz_data: {
                normal_wallets: [{ currency: 'CNY', balance: '39.8439' }],
                bonus_wallets: [{ currency: 'CNY', balance: '5.5' }],
              },
            },
          }), { status: 200 });
        }
        if (text === 'https://gateway.example.com/v1/dashboard/billing/subscription') {
          return new Response(JSON.stringify({ hard_limit_usd: 100000000 }), { status: 200 });
        }
        if (text.startsWith('https://gateway.example.com/v1/dashboard/billing/usage')) {
          return new Response(JSON.stringify({ total_usage: 41207.962 }), { status: 200 });
        }
        if (text === 'https://api.deepseek.com/user/balance') {
          return new Response(JSON.stringify({ error: { message: 'invalid' } }), { status: 401 });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    });
    assert.ok('windows' in reading);
    assert.deepEqual(reading.windows, [
      { window: 'balance:CNY:39.84', used: 0, resets_at: null },
      { window: 'bonus_balance:CNY:5.50', used: 0, resets_at: null },
      { window: 'gateway_unlimited:custom_gw:$412.08', used: 0, resets_at: null },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
