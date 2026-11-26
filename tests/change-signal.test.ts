// Guards the one word that what a console page shows may be out of date (docs/design/console.md,
// 数据怎么保持新): a change the ledger committed that no page hears of until a clock comes
// round, a word sent for a transaction that was rolled back, learned state written on every
// machine poll waking every open console, learned state a page does show (a login's quota
// figures, its use) never told of, a quota read that ends without the page hearing of it, and
// a conversation that has to be read again one request per turn. And the same quota figures,
// reported on every answer, waking every open console each time.
import './guard.ts';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { consoleApp } from './console-helpers.ts';
import { fixture, USER } from './helpers.ts';

test('a committed change is told once per transaction; a rolled back one and a write of learned state are not', (t) => {
  const f = fixture(t);
  let told = 0;
  const stop = f.ledger.onChange(() => { told += 1; });
  f.newTask();
  assert.equal(told, 1);
  assert.throws(() => f.ledger.transaction(() => {
    f.newTask();
    throw new Error('中途失败');
  }));
  assert.equal(told, 1);
  // When a machine was last heard from is written on its polls, and is on no page as news.
  f.ledger.noteMachineSeen('nobody', '2026-11-11T00:00:00.000Z');
  assert.equal(told, 1);
  // A login's quota figures are learned too, and the usage and accounts pages show them.
  const login = f.login.login.id;
  f.ledger.noteUsage(login, [{ window: 'week', used: 0.5, resetsAt: null }]);
  assert.equal(told, 2);
  // Claude reports them on every answer: the same figures again are no news.
  f.ledger.noteUsage(login, [{ window: 'week', used: 0.5, resetsAt: null }]);
  assert.equal(told, 2);
  stop();
  f.newTask();
  assert.equal(told, 2);
});

test('the stream says `changed`, with nothing of the change in it, when the ledger commits one', async (t) => {
  const { f, url, cookie, stream } = await consoleApp(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${url}/api/stream`, { signal: abort.signal, headers: { Cookie: cookie } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (stream.size === 0) await sleep(5);
  f.newTask();
  while (!/event: changed/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`流已结束：${text}`);
    text += decoder.decode(value, { stream: true });
  }
  assert.match(text, /event: changed\ndata: \{\}\n\n/);
});

test('a conversation is read with what each request committed, in one answer', async (t) => {
  const { f, get } = await consoleApp(t);
  const { projectId } = f;
  const asked = f.ledger.receiveMessage({ channel: 'console', externalId: 'x1', actor: 'console', text: '建个任务', projectId });
  const quiet = f.ledger.receiveMessage({ channel: 'console', externalId: 'x2', actor: 'console', text: '只是问问', projectId });
  const task = f.ledger.createTask({ roleId: 'implement', projectId, title: '探针', goal: '目标', acceptance: '测试通过' }, { ...USER, messageId: asked.id });
  const body = await (await get(`/api/messages?project=${projectId}&limit=50`)).json() as { messages: { id: string }[]; changes: Record<string, { changes: { action: string }[]; tasks: { id: string }[] }> };
  assert.deepEqual(body.messages.map(({ id }) => id).sort(), [asked.id, quiet.id].sort());
  assert.deepEqual(body.changes[asked.id]!.tasks.map(({ id }) => id), [task.id]);
  assert.ok(body.changes[asked.id]!.changes.some(({ action }) => action === 'task.create'));
  // A request whose turn committed nothing is absent: the page reads it as nothing.
  assert.equal(body.changes[quiet.id], undefined);
});
