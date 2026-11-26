import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { HashRouter } from 'react-router';
import type { TaskFeedback } from '@shared/task-feedback.ts';
import { deferred, open } from '@/test/harness';
import { TaskFeedbackPanel } from './task-feedback';

const saved: TaskFeedback = { id: 'feedback-1', actor: 'console', created_at: '2026-11-14T08:00:00Z', task_id: 'task', task_revision: 3, run_id: 'round-one', run_revision: 1, kind: 'slow', note: '报告等了太久' };
function panel(handle: (method: string, body: unknown) => unknown) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    try { const result = await handle(method, body); return { ok: true, status: 200, json: async () => result }; }
    catch (error) { return { ok: false, status: 400, json: async () => ({ error: (error as Error).message }) }; }
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><HashRouter><TaskFeedbackPanel taskId="task" runs={[{ id: 'round-one', task_revision: 1 }]} selectedRun={null} /></HashRouter></QueryClientProvider>);
  return { ...view, user: userEvent.setup(), calls };
}

test('feedback waits for one explicit save, binds the selected round, and records its saved provenance without accepting or starting work', async () => {
  const response = deferred();
  let recorded = false;
  const app = panel((method, body) => {
    if (method === 'GET') return { feedback: recorded ? [saved] : [] };
    expect(body).toEqual({ kind: 'slow', note: '报告等了太久', run_id: 'round-one' });
    return response.promise.then(() => { recorded = true; return { feedback: saved }; });
  });
  await screen.findByText('还没有反馈。');
  expect(app.calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  await app.user.click(screen.getByRole('button', { name: '哪里等太久' }));
  await app.user.type(screen.getByRole('textbox', { name: '反馈说明（可选）' }), '报告等了太久');
  await app.user.selectOptions(screen.getByRole('combobox', { name: '反馈所指' }), 'round-one');
  const save = screen.getByRole('button', { name: '保存反馈' });
  act(() => { fireEvent.click(save); fireEvent.click(save); });
  await waitFor(() => expect(save).toBeDisabled());
  expect(screen.getByRole('button', { name: '值得复用' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: '反馈所指' })).toBeDisabled();
  await act(async () => { response.resolve({}); });
  await screen.findByText('报告等了太久');
  expect(screen.getByText('任务修订 3 · 轮次修订 1')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看来源轮次' })).toHaveAttribute('href', '#/task/task?run=round-one');
  expect(screen.getByRole('textbox', { name: '反馈说明（可选）' })).toHaveValue('');
  expect(app.calls.filter(({ method }) => method !== 'GET')).toEqual([{ method: 'POST', path: '/api/tasks/task/feedback', body: { kind: 'slow', note: '报告等了太久', run_id: 'round-one' } }]);
});

test('a refused save keeps the draft and selection, shows its reason, and releases the form', async () => {
  const app = panel((method) => { if (method === 'POST') throw new Error('项目已冻结'); return { feedback: [] }; });
  await screen.findByText('还没有反馈。');
  await app.user.click(screen.getByRole('button', { name: '结论有误' }));
  await app.user.type(screen.getByRole('textbox', { name: '反馈说明（可选）' }), '没有核对退出码');
  await app.user.click(screen.getByRole('button', { name: '保存反馈' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('项目已冻结');
  expect(screen.getByRole('textbox', { name: '反馈说明（可选）' })).toHaveValue('没有核对退出码');
  expect(screen.getByRole('button', { name: '结论有误' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '保存反馈' })).toBeEnabled();
  expect(app.calls.filter(({ method }) => method === 'POST')).toHaveLength(1);
});

test('a failed history read is explicit and can be retried without saving feedback', async () => {
  let failed = true;
  const app = panel(() => { if (failed) throw new Error('历史读取失败'); return { feedback: [saved] }; });
  expect(await screen.findByRole('alert')).toHaveTextContent('历史读取失败');
  failed = false;
  await app.user.click(screen.getByRole('button', { name: '重试读取反馈' }));
  await screen.findByText('报告等了太久');
  expect(app.calls.every(({ method }) => method === 'GET')).toBe(true);
});

test('the real task page exposes feedback also after a task is closed, separate from task execution', async () => {
  const task = { id: 'task', title: '已经完成的任务', project_id: null, state: 'done', revision: 3, goal: '目标', acceptance: '报告', created_at: saved.created_at };
  const app = open('#/task/task', (call) => {
    if (call.path === '/api/tasks/task/feedback') return { feedback: [saved] };
    if (call.path === '/api/tasks/task') return { task, work: task, children: [], runs: [], inputs: [], approvals: [], role: null,
      releases: { version: '1', last: null, intent: null, attempting: false, fetch: null, packages: [] } };
    if (call.path === '/api/roles') return { roles: [] };
    return undefined;
  });
  await screen.findByRole('heading', { name: '已经完成的任务' });
  await app.user.click(screen.getByText('任务反馈'));
  await screen.findByText('报告等了太久');
  expect(screen.getByText('只记录反馈，不会启动任务或直接发布知识。')).toBeInTheDocument();
  expect(app.calls).toEqual([]);
  expect(screen.getByRole('button', { name: '保存反馈' })).toBeEnabled();
});
