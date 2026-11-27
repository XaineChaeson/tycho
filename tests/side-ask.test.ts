import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBrief } from '../runner/snapshot.ts';
import { setActiveLocale } from '../shared/i18n.ts';
import { enterPage } from '../service/auth.ts';
import { buildSideAskPrompt, type SideAskContext, type SideAskInput } from '../service/side-ask.ts';
import { consoleApp } from './console-helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

test('buildSideAskPrompt embeds read-only instructions, quote, history, and locale', () => {
  const ctx: SideAskContext = {
    projectName: 'gateway-bench',
    recentMessages: [
      { direction: 'in', text: 'What is local disk usage?' },
      { direction: 'out', text: 'ClickHouse metadata takes 183 GiB on node SSD.' },
    ],
    recentTasks: [
      { id: 't-1', title: 'Audit storage', state: 'done', summary: 'Checked both clusters.' },
    ],
  };

  const zh = buildSideAskPrompt(ctx, {
    question: 'MinIO 和本地盘什么区别？',
    quote: { source: '负责人', excerpt: '183 GiB on node SSD' },
    history: [{ role: 'user', text: '先问一个' }, { role: 'assistant', text: '简短答复' }],
    locale: 'zh-CN',
  });
  assert.match(zh, /临时追问/);
  assert.match(zh, /严禁执行命令/);
  assert.match(zh, /## Project: gateway-bench/);
  assert.match(zh, /### Quoted excerpt \(负责人\)/);
  assert.match(zh, /183 GiB on node SSD/);
  assert.match(zh, /### Prior side-ask turns/);
  assert.match(zh, /MinIO 和本地盘什么区别？/);

  const en = buildSideAskPrompt(ctx, {
    question: 'Why does metadata stay on local SSD?',
    locale: 'en',
  });
  assert.match(en, /read-only Side Ask/);
  assert.match(en, /Respond in English/);
  assert.match(en, /Why does metadata stay on local SSD\?/);
});

test('POST /api/projects/:id/side-ask passes read-only context and never mutates project messages', async (t) => {
  let received: { projectId: string; context: SideAskContext; input: SideAskInput } | null = null;
  const { f, send } = await consoleApp(t, {
    sideAsk: async (projectId, context, input) => {
      received = { projectId, context, input };
      return { answer: 'Metadata and temporary merges live on local SSD.', executor: 'gemini', duration_ms: 120 };
    },
  });

  // Seed one project message and one task so Side Ask receives real read-only context.
  f.ledger.receiveMessage({
    channel: 'console',
    externalId: 'ext-side-ask-1',
    actor: 'console',
    text: 'Check ClickHouse storage',
    projectId: f.projectId,
  });
  const task = f.newTask({});

  // Empty question -> 400
  const bad = await send('POST', `/api/projects/${encodeURIComponent(f.projectId)}/side-ask`, { question: '   ' });
  assert.equal(bad.status, 400);

  // Missing project -> 400 (InputError from ledger.getProject)
  const missing = await send('POST', '/api/projects/no-such-project/side-ask', { question: 'Hello?' });
  assert.equal(missing.status, 400);

  const beforeCount = f.peek<{ n: number }>('SELECT COUNT(*) AS n FROM message')[0]!.n;

  const ok = await send('POST', `/api/projects/${encodeURIComponent(f.projectId)}/side-ask`, {
    question: 'Does local SSD store table parts?',
    quote: { source: 'Router', excerpt: 'local disk for merges' },
    history: [{ role: 'user', text: 'Earlier' }, { role: 'assistant', text: 'Answer' }],
  });
  assert.equal(ok.status, 200);
  const body = await json(ok);
  assert.equal(body.answer, 'Metadata and temporary merges live on local SSD.');
  assert.equal(body.executor, 'gemini');

  assert.ok(received);
  const captured = received as { projectId: string; context: SideAskContext; input: SideAskInput };
  assert.equal(captured.projectId, f.projectId);
  assert.ok(captured.context.recentMessages.some((m) => m.text.includes('Check ClickHouse storage')));
  assert.ok(captured.context.recentTasks.some((item) => item.id === task.id));
  assert.equal(captured.input.quote?.excerpt, 'local disk for merges');
  assert.equal(captured.input.history?.length, 2);

  // Zero ledger pollution: message count is completely unchanged.
  const afterCount = f.peek<{ n: number }>('SELECT COUNT(*) AS n FROM message')[0]!.n;
  assert.equal(afterCount, beforeCount);
});

test('ui.locale setting switches /api/state locale, bilingual login HTML, and English brief directive', async (t) => {
  t.after(() => setActiveLocale('zh-CN'));
  const { get, send } = await consoleApp(t);

  const initial = await json(await get('/api/state'));
  assert.equal(initial.locale, 'zh-CN');

  const updated = await send('PUT', '/api/settings/ui.locale', { value: 'en' });
  assert.equal(updated.status, 200);

  const after = await json(await get('/api/state'));
  assert.equal(after.locale, 'en');

  const htmlEn = enterPage(false, { hasPassphrase: true });
  assert.match(htmlEn, /<html lang="en">/);
  assert.match(htmlEn, /Sign in to Tycho/);
  assert.match(htmlEn, /Sign in with passphrase/);

  const briefEn = renderBrief(
    {
      id: 't1',
      title: 'Check latency',
      goal: 'Measure p50 latency',
      acceptance: 'Report numbers',
      scope: null,
      revision: 1,
      role_id: 'analyze',
    } as any,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    '',
    undefined,
    false,
  );
  assert.match(briefEn, /## Language/);
  assert.match(briefEn, /Write prose, reports, and receipt summaries in English/);

  setActiveLocale('zh-CN');
  const htmlZh = enterPage(false, { hasPassphrase: true });
  assert.match(htmlZh, /<html lang="zh-CN">/);
  assert.match(htmlZh, /进入 Tycho/);
});
