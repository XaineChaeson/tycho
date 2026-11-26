import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexIdentityFromTokens } from '../adapters/codex-auth.ts';
import { parseGeminiAcpIdentity } from '../adapters/gemini.ts';
import { accountLabelOf, maskEmailIdentity } from '../shared/logins.ts';
import { fixture } from './helpers.ts';

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

test('maskEmailIdentity preserves handle while masking domain for privacy', () => {
  assert.equal(maskEmailIdentity('alice@example.com'), 'alice@e***.com');
  assert.equal(maskEmailIdentity('alice@example.org'), 'alice@e***.org');
  assert.equal(accountLabelOf('alice@e***.com'), 'alice@e***.com');
});

test('codexIdentityFromTokens extracts masked email, plan label, and stable quotaOwner', () => {
  const idToken = fakeJwt({
    email: 'dev.user@example.com',
    'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
  });
  const accessToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const identity = codexIdentityFromTokens({ id_token: idToken, access_token: accessToken });
  assert.equal(identity.accountLabel, 'dev.user@e***.com');
  assert.equal(identity.planLabel, 'Pro');
  assert.ok(identity.quotaOwner?.startsWith('v1:'));
});

test('parseGeminiAcpIdentity extracts Google AI Ultra tier from official agy acp authenticate response', () => {
  const line = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { _meta: { antigravity: { tier: { name: 'Google AI Ultra', id: 'g1-ultra-tier', upgradeUri: '' } } } },
  });
  assert.deepEqual(parseGeminiAcpIdentity(line), { planLabel: 'Google AI Ultra' });

  const withEmail = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { _meta: { antigravity: { email: 'alice@gmail.com', tier: { name: 'Google AI Pro' } } } },
  });
  const parsed = parseGeminiAcpIdentity(withEmail);
  assert.equal(parsed.accountLabel, 'alice@g***.com');
  assert.equal(parsed.planLabel, 'Google AI Pro');
  assert.ok(parsed.quotaOwner?.startsWith('v1:'));
});

test('ledger persists and clears universal login display aliases', (t) => {
  const f = fixture(t, {}, false);
  assert.deepEqual(f.ledger.loginAliases(), {});
  const saved = f.ledger.setLoginAlias('group:gemini', '工作 Gemini');
  assert.equal(saved['group:gemini'], '工作 Gemini');
  assert.equal(f.ledger.loginAliases()['group:gemini'], '工作 Gemini');
  const cleared = f.ledger.setLoginAlias('group:gemini', null);
  assert.equal(cleared['group:gemini'], undefined);
});
