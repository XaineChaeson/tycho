// Guards against startup disabling pending Weixin outbox rows before its saved
// identity is loaded, which would lose a real reply across an ordinary restart.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openLedger } from '../service/ledger.ts';
import { startService } from '../service/main.ts';
import { writeOwnerOnly } from '../service/secrets.ts';
import { CONSOLE_DIST } from './helpers.ts';

test('ordinary service restart retains a pending private reply while loading the saved Weixin identity', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-weixin-start-'));
  const file = join(root, 'secrets', 'weixin.json');
  mkdirSync(join(root, 'secrets'));
  writeOwnerOnly(file, JSON.stringify({ version: 1, auth: { token: 'synthetic-private-token', botId: 'bot', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' }, cursor: '', context: '', pending: [], sends: {}, seen: [], controls: {} }));
  const seed = openLedger(join(root, 'ledger.db'));
  seed.setChannels(['console', 'weixin']);
  const row = seed.outbox.enqueue('weixin', 'markdown', { external_id: 'front:pending-reply', target: { chatid: 'weixin:bot:owner', chat_type: 1 }, content: 'pending owner reply' });
  seed.close();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error('cancelled'));
      else init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  });
  const running = await startService({ dataDir: root, port: 0, claude: [process.execPath, join(import.meta.dirname, 'fake-claude.mjs')], stopWaitMs: 2000, consoleDir: CONSOLE_DIST,
    globalEntry: { home: join(root, 'entry'), env: { HOME: join(root, 'entry'), USERPROFILE: join(root, 'entry'), CODEX_HOME: join(root, 'entry', '.codex') } } });
  t.after(async () => { await running.stop(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(running.ledger.outbox.takeDue(new Date('2999-01-01')).find(p => p.id === row.id)?.state, 'pending');
  assert.equal(running.ledger.outbox.listGivenUp().some(p => p.id === row.id), false);
});
