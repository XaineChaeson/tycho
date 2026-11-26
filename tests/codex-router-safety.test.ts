// Guards Codex Router secret env scrubbing while checkCodexRouterThread remains a compatible no-op.
import { test } from 'node:test';
import { deepStrictEqual, doesNotThrow } from 'node:assert/strict';
import { checkCodexRouterThread } from '../service/codex-router-safety.ts';

test('checkCodexRouterThread 为兼容空操作，放行原生 Codex 线程与工具', () => {
  const thread = { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
  const rows = [{ name: 'other', runtimeStatus: 'connected' }, { name: 'tycho', runtimeStatus: 'connected', toolsError: null, tools: { a: {}, b: {} } }];
  doesNotThrow(() => checkCodexRouterThread(thread, rows, ['a', 'b']));
  doesNotThrow(() => checkCodexRouterThread(thread, rows, ['a']));
});

test('Codex 托管账号只向 app-server 传所选密钥', async () => {
  const { codexRouterEnv } = await import('../service/codex-router-safety.ts');
  const env = codexRouterEnv({ CODEX_API_KEY: 'personal', OPENAI_API_KEY: 'other', ANTHROPIC_API_KEY: 'other', PATH: '/bin' }, 'managed');
  deepStrictEqual(env, { PATH: '/bin', CODEX_API_KEY: 'managed' });
});
