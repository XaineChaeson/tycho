import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import {
  codexAccessExpiryMs,
  codexIdentityFromTokens,
  codexSecretStrings,
  decodeCodexOAuth,
  decodeCodexOAuthLease,
  encodeCodexOAuth,
  encodeCodexOAuthLease,
  formatCodexAuthFile,
  normalizedConfigToml,
  parseCodexAuthFile,
} from '../adapters/codex-auth.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { workerEnv } from '../node/watch.ts';
import { hider } from '../runner/redact.ts';
import { createAccounts } from '../service/accounts.ts';
import { createCodexAuthBroker } from '../service/codex-auth.ts';
import { createQuotaReads } from '../service/quota-read.ts';
import { fixture, USER } from './helpers.ts';

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig_test_123456`;
}

function makeBundle(options: { email?: string; expSec: number; refreshToken?: string; tag?: string }) {
  const tag = options.tag ?? 'v1';
  return {
    id_token: fakeJwt({ email: options.email ?? 'dev.owner@example.com', sub: `user_${tag}`, exp: options.expSec }),
    access_token: fakeJwt({ sub: `user_${tag}`, exp: options.expSec, jti: `acc_${tag}` }),
    refresh_token: options.refreshToken ?? `rt_secret_${tag}_99887766`,
    account_id: 'acct_chatgpt_001',
    last_refresh: new Date(options.expSec * 1000 - 3600_000).toISOString(),
  };
}

test('codex-oauth-v1 codec strips refresh_token on lease, extracts identity & exp, and expands secrets for redaction', () => {
  const expSec = 1_800_000_000;
  const bundle = makeBundle({ email: 'Alice.Dev@Example.COM', expSec });
  const stored = encodeCodexOAuth(bundle);
  assert.match(stored, /^codex-oauth-v1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCodexOAuth(stored), bundle);

  const leaseStr = encodeCodexOAuthLease(bundle);
  assert.match(leaseStr, /^codex-oauth-lease-v1:[A-Za-z0-9_-]+$/);
  assert.ok(!Buffer.from(leaseStr.split(':')[1]!, 'base64url').toString('utf8').includes(bundle.refresh_token));

  const decodedLease = decodeCodexOAuthLease(leaseStr)!;
  assert.equal(decodedLease.access_token, bundle.access_token);
  assert.equal('refresh_token' in decodedLease, false);

  const authJson = JSON.parse(formatCodexAuthFile(decodedLease, false)) as {
    auth_mode: string;
    tokens: { refresh_token: string; access_token: string };
  };
  assert.equal(authJson.auth_mode, 'chatgpt');
  assert.equal(authJson.tokens.refresh_token, '');
  assert.equal(authJson.tokens.access_token, bundle.access_token);

  assert.equal(codexAccessExpiryMs(bundle.access_token), expSec * 1000);
  const identity = codexIdentityFromTokens(bundle);
  assert.equal(identity.accountLabel, 'Alice.Dev@e***.com');
  assert.match(identity.quotaOwner!, /^v1:[0-9a-f]{64}$/);
  // Matches codexAdapter.identityTalk quotaOwner normalization of the same email (case-insensitive).
  const talkIdentity = codexAdapter.identityTalk!.parse(JSON.stringify({
    id: 2,
    result: { account: { type: 'chatgpt', email: 'alice.dev@example.com' } },
  }));
  assert.equal(identity.quotaOwner, talkIdentity.quotaOwner);

  const redact = hider(codexSecretStrings(stored));
  const leaked = `err: ${bundle.access_token} / ${bundle.id_token} / ${bundle.refresh_token} / ${leaseStr}`;
  const cleaned = redact(leaked);
  assert.ok(!cleaned.includes(bundle.access_token));
  assert.ok(!cleaned.includes(bundle.id_token));
  assert.ok(!cleaned.includes(bundle.refresh_token));
  assert.ok(!cleaned.includes(leaseStr));
});

test('single-flight Host refresher rotates token in place keeping credential_ref unchanged across concurrent callers', async (t) => {
  const f = fixture(t);
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: ['claude', 'codex', 'dsh', 'gemini'],
    routingExecutors: ['claude', 'codex'],
    dataDir: f.dir,
    log: () => {},
  });

  const nowMs = 1_800_000_000_000;
  // Access token expires in 10 minutes (< 25 min renewal threshold).
  const initial = makeBundle({ expSec: Math.floor(nowMs / 1000) + 600, tag: 'initial' });
  const { account } = accounts.put({
    executor: 'codex',
    credential: encodeCodexOAuth(initial),
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } },
  }, USER);
  assert.equal(account.signedIn, true);
  const initialRef = f.ledger.accountCredentialRef(account.id)!;
  assert.match(initialRef, /^oauth-/);

  let refreshCalls = 0;
  const rotated = makeBundle({ expSec: Math.floor(nowMs / 1000) + 3600, tag: 'rotated' });

  const broker = createCodexAuthBroker({
    dataDir: f.dir,
    ledger: f.ledger,
    accounts,
    now: () => nowMs,
    log: () => {},
    talk: async (_argv, _steps, _timeout, env) => {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 40));
      const home = env.CODEX_HOME!;
      // Verify the isolated refresh home got the full refresh_token, then write rotated auth.json.
      const before = parseCodexAuthFile(readFileSync(join(home, 'auth.json'), 'utf8'));
      assert.equal(before?.refresh_token, initial.refresh_token);
      writeFileSync(join(home, 'auth.json'), formatCodexAuthFile(rotated, true));
      return {
        answer: JSON.stringify({ id: 2, result: { account: { type: 'chatgpt', email: 'dev.owner@example.com' } } }),
      };
    },
  });
  t.after(() => broker.stop());

  // 5 concurrent Worker credential requests hit the broker at the exact same moment.
  const results = await Promise.all(Array.from({ length: 5 }, () => broker.lease(account.id)));
  assert.equal(refreshCalls, 1, 'concurrent callers must coalesce into one single refresh');

  for (const leased of results) {
    assert.ok(leased);
    assert.equal(leased.ref, initialRef, 'in-place refresh must preserve credential_ref for active Runs');
    assert.ok(leased.value.startsWith('codex-oauth-lease-v1:'));
    const parsed = decodeCodexOAuthLease(leased.value)!;
    assert.equal(parsed.access_token, rotated.access_token);
    assert.equal('refresh_token' in parsed, false);
  }

  // Subsequent call while fresh (> 25 min remaining) performs zero refresh calls.
  const cached = await broker.lease(account.id);
  assert.equal(refreshCalls, 1);
  assert.equal(decodeCodexOAuthLease(cached!.value)?.access_token, rotated.access_token);
  assert.equal(f.ledger.accountCredentialRef(account.id), initialRef);
  assert.equal(decodeCodexOAuth(accounts.credentialOf(account.id)!.value)?.refresh_token, rotated.refresh_token);
});

test('transient failure degrades gracefully while access_token is unexpired; permanent rejection marks credential rejected once expired', async (t) => {
  const f = fixture(t);
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: ['codex'],
    dataDir: f.dir,
    log: () => {},
  });

  let clock = 1_800_000_000_000;
  // 10 minutes left: inside 25-min renewal window, but still usable (> 30s left).
  const bundle = makeBundle({ expSec: Math.floor(clock / 1000) + 600, tag: 'grace' });
  const { account } = accounts.put({
    executor: 'codex',
    credential: encodeCodexOAuth(bundle),
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } },
  }, USER);
  const ref = f.ledger.accountCredentialRef(account.id)!;

  let mode: 'transient' | 'permanent' = 'transient';
  const broker = createCodexAuthBroker({
    dataDir: f.dir,
    ledger: f.ledger,
    accounts,
    now: () => clock,
    log: () => {},
    talk: async (_argv, _steps, _timeout, env) => {
      if (mode === 'transient') return { answer: null, failure: 'network timeout' };
      // Simulate codex clearing auth.json on 401 invalid_grant.
      writeFileSync(join(env.CODEX_HOME!, 'auth.json'), '{}');
      return {
        answer: JSON.stringify({ id: 2, error: { code: -32603, message: 'Your access token could not be refreshed. Please log out and sign in again.' } }),
      };
    },
  });
  t.after(() => broker.stop());

  const degraded = await broker.lease(account.id);
  assert.ok(degraded, 'unexpired token still leases during transient refresh outage');
  assert.equal(decodeCodexOAuthLease(degraded.value)?.access_token, bundle.access_token);
  assert.equal(accounts.get(account.id)?.credential, 'set');

  // Advance clock past access_token expiry and simulate permanent refresh_token rejection.
  clock += 700_000;
  mode = 'permanent';
  const dead = await broker.lease(account.id);
  assert.equal(dead, undefined);
  assert.equal(accounts.get(account.id)?.credential, 'rejected');
  assert.equal(f.ledger.loginState(account.id).credential_rejected_ref, ref);
});

test('Host quotaReader reads 5h and 7d windows for Codex OAuth accounts using stripped lease, while skipping API-key accounts', async (t) => {
  const f = fixture(t);
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: ['codex'],
    dataDir: f.dir,
    log: () => {},
  });
  const nowMs = 1_800_000_000_000;
  const bundle = makeBundle({ expSec: Math.floor(nowMs / 1000) + 3600, tag: 'quota' });
  const { account: oauthAcc } = accounts.put({
    executor: 'codex',
    credential: encodeCodexOAuth(bundle),
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } },
  }, USER);
  const { account: keyAcc } = accounts.put({
    executor: 'codex',
    credential: 'sk-openai-plain-key-123456',
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } },
  }, USER);
  assert.equal(keyAcc.signedIn, false);

  const broker = createCodexAuthBroker({
    dataDir: f.dir,
    ledger: f.ledger,
    accounts,
    now: () => nowMs,
    log: () => {},
    talk: async (_argv, _steps, _timeout, env) => {
      const auth = JSON.parse(readFileSync(join(env.CODEX_HOME!, 'auth.json'), 'utf8')) as { tokens: { refresh_token: string } };
      assert.equal(auth.tokens.refresh_token, '', 'quota read must run with refresh_token stripped');
      return {
        answer: JSON.stringify({
          id: 2,
          result: {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_010_000 },
              secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
            },
          },
        }),
      };
    },
  });
  t.after(() => broker.stop());

  const quota = createQuotaReads({
    ledger: f.ledger,
    adapters: ADAPTERS,
    token: (id) => accounts.credentialOf(id)?.value,
    customRead: broker.quotaReader,
    timeoutMs: () => 5_000,
    staleMs: () => 60_000,
    now: () => nowMs,
    log: () => {},
  });
  t.after(() => quota.stop());

  assert.equal(quota.refusal(oauthAcc), undefined);
  assert.equal(quota.refusal(keyAcc), '这个执行器不报额度');

  const res = await quota.read(oauthAcc);
  assert.deepEqual(res, { ok: true });
  const windows = f.ledger.loginState(oauthAcc.id).usage;
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map((w) => ({ window: w.window, used: w.used })),
    [{ window: 'five_hour', used: 0.25 }, { window: 'seven_day', used: 0.6 }],
  );
});

test('Worker prepareCredential materializes isolated CODEX_HOME, forwards machine config without OS keyring override, and unsets CODEX_API_KEY', (t) => {
  const f = fixture(t);
  const baseHome = join(f.dir, 'machine-codex-home');
  mkdirSync(join(baseHome, 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(join(baseHome, 'config.toml'), 'cli_auth_credentials_store = "keyring"\nmodel_verbosity = "medium"\n');
  writeFileSync(join(baseHome, 'AGENTS.md'), '# Machine Rules\n');
  writeFileSync(join(baseHome, 'auth.json'), '{"tokens":{"refresh_token":"machine_secret_do_not_copy"}}');
  writeFileSync(join(baseHome, 'skills', 'demo-skill', 'SKILL.md'), 'skill content');

  const bundle = makeBundle({ expSec: 1_800_003_600, tag: 'worker' });
  const lease = encodeCodexOAuthLease(bundle);
  const scratchDir = join(f.dir, 'run-scratch');

  const prepared = codexAdapter.prepareCredential!({
    variable: 'CODEX_API_KEY',
    credential: lease,
    scratchDir,
    baseExecutorDir: baseHome,
  });
  const env = workerEnv(
    { PATH: '/usr/bin', CODEX_API_KEY: 'stale', OPENAI_API_KEY: 'stale-openai' },
    { env: {}, credentialVariable: 'CODEX_API_KEY', credential: lease },
    'run-001',
    prepared,
  );

  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, join(scratchDir, 'codex-home'));

  const writtenAuth = JSON.parse(readFileSync(join(env.CODEX_HOME!, 'auth.json'), 'utf8')) as { tokens: { access_token: string; refresh_token: string } };
  assert.equal(writtenAuth.tokens.access_token, bundle.access_token);
  assert.equal(writtenAuth.tokens.refresh_token, '');
  assert.ok(!JSON.stringify(writtenAuth).includes('machine_secret_do_not_copy'));

  const writtenConfig = readFileSync(join(env.CODEX_HOME!, 'config.toml'), 'utf8');
  assert.match(writtenConfig, /cli_auth_credentials_store = "file"/);
  assert.match(writtenConfig, /model_verbosity = "medium"/);
  assert.equal(readFileSync(join(env.CODEX_HOME!, 'AGENTS.md'), 'utf8'), '# Machine Rules\n');
  assert.ok(existsSync(join(env.CODEX_HOME!, 'skills', 'demo-skill', 'SKILL.md')));

  // Plain API key still passes through CODEX_API_KEY untouched.
  const plainPrepared = codexAdapter.prepareCredential!({
    variable: 'CODEX_API_KEY',
    credential: 'sk-plain-123',
    scratchDir: join(f.dir, 'plain-scratch'),
  });
  assert.deepEqual(plainPrepared, { CODEX_API_KEY: 'sk-plain-123' });
});

test('10-day access_token renews 24h ahead of expiry, and downstream lease 401 verifies refresh_token instead of falsely poisoning account', async (t) => {
  const f = fixture(t);
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: ['claude', 'codex', 'dsh', 'gemini'],
    routingExecutors: ['claude', 'codex'],
    dataDir: f.dir,
    log: () => {},
  });

  const nowMs = 1_800_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  // 10-day token (240h lifetime) with 20h left (< 24h renewal window).
  const initial10d = {
    id_token: fakeJwt({ email: 'long@example.com', sub: 'u1', iat: nowSec - 220 * 3600, exp: nowSec + 20 * 3600 }),
    access_token: fakeJwt({ sub: 'u1', iat: nowSec - 220 * 3600, exp: nowSec + 20 * 3600 }),
    refresh_token: 'rt_10d_initial',
    account_id: 'acct_001',
    last_refresh: new Date((nowSec - 220 * 3600) * 1000).toISOString(),
  };
  const { account } = accounts.put({
    executor: 'codex',
    credential: encodeCodexOAuth(initial10d),
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } },
  }, USER);
  const ref = f.ledger.accountCredentialRef(account.id)!;

  let refreshMode: 'rotate' | 'revoke' = 'rotate';
  let refreshCount = 0;
  const fresh10d = {
    id_token: fakeJwt({ email: 'long@example.com', sub: 'u1', iat: nowSec, exp: nowSec + 240 * 3600 }),
    access_token: fakeJwt({ sub: 'u1', iat: nowSec, exp: nowSec + 240 * 3600 }),
    refresh_token: 'rt_10d_fresh',
    account_id: 'acct_001',
    last_refresh: new Date(nowMs).toISOString(),
  };

  const broker = createCodexAuthBroker({
    dataDir: f.dir,
    ledger: f.ledger,
    accounts,
    now: () => nowMs,
    log: () => {},
    talk: async (_argv, _steps, _timeout, env) => {
      refreshCount += 1;
      if (refreshMode === 'revoke') {
        return { answer: JSON.stringify({ id: 2, error: { code: -32000, message: 'invalid_grant: token revoked' } }) };
      }
      writeFileSync(join(env.CODEX_HOME!, 'auth.json'), formatCodexAuthFile(fresh10d, true));
      return { answer: JSON.stringify({ id: 2, result: { account: { type: 'chatgpt', email: 'long@example.com' } } }) };
    },
  });
  t.after(() => broker.stop());

  // 20h remaining on a 240h token triggers proactive renewal so long-running Workers get full 240h.
  const leased = await broker.lease(account.id);
  assert.ok(leased);
  assert.equal(refreshCount, 1);
  assert.equal(codexAccessExpiryMs(decodeCodexOAuthLease(leased.value)!.access_token), (nowSec + 240 * 3600) * 1000);

  // Subsequent lease with 240h remaining does not call talk again.
  await broker.lease(account.id);
  assert.equal(refreshCount, 1);

  // Downstream Worker/Router hits 401 on an old stripped lease while refresh_token is still healthy:
  // verifyCredential forces a refresh check and returns 'valid' WITHOUT marking credential_rejected_ref!
  const verdictHealthy = await broker.verifyCredential(account.id, ref);
  assert.equal(verdictHealthy, 'valid');
  assert.equal(refreshCount, 2);
  assert.equal(f.ledger.loginState(account.id).credential_rejected_ref, null);

  // Once refresh_token is genuinely revoked upstream, verifyCredential marks the account rejected.
  refreshMode = 'revoke';
  const verdictRevoked = await broker.verifyCredential(account.id, ref);
  assert.equal(verdictRevoked, 'rejected');
  assert.equal(f.ledger.loginState(account.id).credential_rejected_ref, ref);
});

test('Worker prepareCredential strips Tycho global knowledge projection from isolated CODEX_HOME while preserving user rules', (t) => {
  const f = fixture(t);
  const lease = encodeCodexOAuthLease(makeBundle({ expSec: 1_800_003_600, tag: 'isolated' }));

  // Pure Tycho-generated AGENTS.md is omitted from the isolated worker CODEX_HOME.
  const baseGenerated = join(f.dir, 'base-generated');
  mkdirSync(baseGenerated, { recursive: true });
  writeFileSync(join(baseGenerated, 'AGENTS.md'), '<!-- tycho:generated:v2 publisher:pub-1 -->\n<!-- meta -->\n\nProjected global knowledge\n');
  const scratchGenerated = join(f.dir, 'scratch-generated');
  codexAdapter.prepareCredential!({ variable: 'CODEX_API_KEY', credential: lease, scratchDir: scratchGenerated, baseExecutorDir: baseGenerated });
  assert.equal(existsSync(join(scratchGenerated, 'codex-home', 'AGENTS.md')), false);

  // Coexisting user AGENTS.md preserves user rules and strips only the Tycho managed section.
  const baseCoexist = join(f.dir, 'base-coexist');
  mkdirSync(baseCoexist, { recursive: true });
  writeFileSync(
    join(baseCoexist, 'AGENTS.md'),
    '# My Personal Rule\n\n<!-- tycho:managed:v2:start publisher:pub-1 -->\n<!-- meta -->\n\nProjected global knowledge\n<!-- tycho:managed:v2:end publisher:pub-1 -->\n',
  );
  const scratchCoexist = join(f.dir, 'scratch-coexist');
  codexAdapter.prepareCredential!({ variable: 'CODEX_API_KEY', credential: lease, scratchDir: scratchCoexist, baseExecutorDir: baseCoexist });
  assert.equal(readFileSync(join(scratchCoexist, 'codex-home', 'AGENTS.md'), 'utf8'), '# My Personal Rule\n');
});

test('normalizedConfigToml and prepareCredential strip top-level desktop service_tier while keeping keyring rewrite and sections', (t) => {
  const f = fixture(t);
  const raw = [
    'model = "gpt-6.2-astra"',
    'model_reasoning_effort = "max"',
    'service_tier = "ultrafast"',
    'cli_auth_credentials_store = "keyring"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[desktop]',
    'service_tier = "keep-nested"',
    'followUpQueueMode = "steer"',
    '',
    '[plugins."browser@openai-bundled"]',
    'enabled = true',
  ].join('\r\n');
  const cleaned = normalizedConfigToml(raw);
  assert.doesNotMatch(cleaned, /^service_tier\s*=\s*"ultrafast"/m);
  assert.match(cleaned, /^cli_auth_credentials_store = "file"$/m);
  assert.match(cleaned, /\[desktop\]\nservice_tier = "keep-nested"/);
  assert.match(cleaned, /\[plugins\."browser@openai-bundled"\]\nenabled = true/);

  const baseDir = join(f.dir, 'base-service-tier');
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, 'config.toml'), raw, 'utf8');
  const scratchDir = join(f.dir, 'scratch-service-tier');
  const lease = encodeCodexOAuthLease(makeBundle({ expSec: 1_800_003_600, tag: 'st' }));
  codexAdapter.prepareCredential!({ variable: 'CODEX_API_KEY', credential: lease, scratchDir, baseExecutorDir: baseDir });
  const written = readFileSync(join(scratchDir, 'codex-home', 'config.toml'), 'utf8');
  assert.doesNotMatch(written, /ultrafast/);
  assert.match(written, /cli_auth_credentials_store = "file"/);
  assert.match(written, /\[plugins\."browser@openai-bundled"\]/);
});
