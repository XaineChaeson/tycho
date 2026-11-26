import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverLocalDshRoutesAndModels,
  dshTierOverlayText,
  extractDesktopProvidersPatch,
} from '../adapters/dsh-routes.ts';
import { PATCH_LIST } from '../shared/tier-form.ts';

test('PATCH_LIST unquotes YAML scalar provider/model/effort and cleans redundant quotes on render', () => {
  const quoted = [
    '- id: agent-default-model',
    '  config:',
    '    provider: "customgw"',
    "    model: 'deepseek-v4.1-flash'",
    '    reasoningEffort: "high"',
    '',
  ].join('\n');
  const parsed = PATCH_LIST.parse(quoted);
  assert.deepEqual(parsed, { provider: 'customgw', model: 'deepseek-v4.1-flash', effort: 'high' });

  const rendered = PATCH_LIST.render({ provider: '"customgw"', model: 'deepseek-v4.1-flash', effort: 'high' }, quoted);
  assert.ok(rendered.includes('provider: customgw'), `expected unquoted provider, got:\n${rendered}`);
  assert.ok(!rendered.includes('"customgw"'));
});

test('discoverLocalDshRoutesAndModels unifies headless dump, desktop providers/models, and shared credentials', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'tycho-dsh-unified-'));
  try {
    const dshHome = join(fakeHome, '.dsh');
    mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true });
    writeFileSync(
      join(dshHome, '.credentials.yaml'),
      [
        'records:',
        '  deepseek-account-platform/default:',
        '    token: test-token-never-returned',
        '    issuer: https://platform.deepseek.com',
        'refs:',
        '  DEEPSEEK_API_KEY: sk-test-never-returned',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
      [
        '- id: ui-chat',
        '  config:',
        '    transcriptView: standard',
        '- id: llm-pi-ai',
        '  name: "@deepseek-ai/dsh-llm-pi-ai"',
        '  config:',
        '    providers:',
        '      customgw:',
        '        displayName: custom_gw',
        '        api: openai-completions',
        '        baseURL: http://127.0.0.1:53000/v1',
        '        models:',
        '          - id: deepseek-v4.1-flash',
        '            name: deepseek-v4.1-flash',
        '          - id: qwen3.8-27b-gguf',
        '            name: qwen3.8-27b-gguf',
        '- id: agent-default-model',
        '  config:',
        '    provider: customgw',
        '    model: deepseek-v4.1-flash',
      ].join('\n'),
      'utf8',
    );

    const headlessDump = [
      '- id: agent-default-model',
      '  config:',
      '    provider: customgw',
      '    model: deepseek-v4.1-flash',
      '- id: llm-deepseek',
      '  disabled: true',
      '- id: llm-deepseek-account',
      '  disabled: true',
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      customgw:',
      '        displayName: custom_gw',
      '        models:',
      '          - id: deepseek-v4.1-flash',
    ].join('\n');

    const discovered = discoverLocalDshRoutesAndModels(headlessDump, { env: {}, homeDir: fakeHome });
    assert.equal(discovered.defaultRoute, 'customgw');
    assert.deepEqual(
      discovered.routes.map((r) => ({ id: r.id, label: r.label, source: r.source })),
      [
        { id: 'deepseek-account', label: 'DeepSeek 账号', source: 'account' },
        { id: 'deepseek-official', label: 'DeepSeek (API Key)', source: 'api-key' },
        { id: 'customgw', label: 'custom_gw', source: 'custom' },
      ],
    );
    const modelIds = discovered.models.map((m) => m.id);
    assert.ok(modelIds.includes('deepseek-v4.1-flash'));
    assert.ok(modelIds.includes('deepseek-v4-pro'));
    assert.ok(modelIds.includes('qwen3.8-27b-gguf'));
    // Ensure zero secrets ever appear in discovery output
    const serialized = JSON.stringify(discovered);
    assert.ok(!serialized.includes('test-token-never-returned'));
    assert.ok(!serialized.includes('sk-test-never-returned'));

    // extractDesktopProvidersPatch extracts ONLY llm-pi-ai, excluding ui-chat and agent-default-model
    const extracted = extractDesktopProvidersPatch({ env: {}, homeDir: fakeHome });
    assert.ok(extracted);
    assert.ok(extracted.includes('- id: llm-pi-ai'));
    assert.ok(extracted.includes('qwen3.8-27b-gguf'));
    assert.ok(!extracted.includes('ui-chat'));
    assert.ok(!extracted.includes('agent-default-model'));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('dshTierOverlayText activates selected provider in headless for machine-local logins only', () => {
  const accountTier = '- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-v4-pro\n';
  const augmentedAccount = dshTierOverlayText(accountTier, false);
  assert.ok(augmentedAccount.includes('- id: credentials\n  disabled: false'));
  assert.ok(augmentedAccount.includes('- id: deepseek-account\n  disabled: false'));
  assert.ok(augmentedAccount.includes('- id: llm-deepseek-account\n  disabled: false'));

  const officialTier = '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4.1-flash\n';
  const augmentedOfficial = dshTierOverlayText(officialTier, false);
  assert.ok(augmentedOfficial.includes('- id: credentials\n  disabled: false'));
  assert.ok(augmentedOfficial.includes('- id: llm-deepseek\n  disabled: false'));
  assert.ok(!augmentedOfficial.includes('llm-deepseek-account'));

  // Managed API-key accounts must remain untouched (their own line.patch.yml owns credential isolation)
  assert.equal(dshTierOverlayText(officialTier, true), officialTier);
});
