import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { open, shellStream } from '@/test/harness';

const leaf = (dot: string) => ({ dot, text: '', counts: {}, leaf: true });

test('Ctrl+K palette indexes child sub-tasks and review tasks and navigates to /task/:id', async () => {
  const { user } = open('#/', (call) => {
    if (call.path === '/api/tasks?top=1') {
      return {
        tasks: [
          { id: 'w1', title: '支付模块重构', state: 'running', reason: null, summary: leaf('running') },
        ],
        children: [
          { id: 'c1', parent_id: 'w1', title: '独立审阅：支付回调验签', state: 'ready', reason: null, summary: leaf('ready') },
          { id: 'c2', parent_id: 'w1', title: '补充单元测试', state: 'queued', reason: null, summary: leaf('queued') },
        ],
      };
    }
    return undefined;
  });

  await screen.findByRole('heading', { level: 1, name: '总览' });
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const palette = await screen.findByRole('dialog', { name: '搜索或跳转' });

  const search = within(palette).getByRole('combobox', { name: '搜索或跳转' });
  await user.type(search, '验签');
  const option = await within(palette).findByRole('option', { name: /独立审阅：支付回调验签/ });
  expect(option).toHaveTextContent('支付模块重构');
  await user.click(option);
  await waitFor(() => expect(window.location.hash).toBe('#/task/c1'));
});

test('priority-sorts tasks on open, freezes order across SSE updates while open, and supports Alt+1..6 quick jump', async () => {
  let tasks = [
    { id: 'w-done', title: '可续接任务', state: 'done', updated_at: '2026-11-25T10:00:00Z', summary: leaf('done') },
    { id: 'w-run', title: '进行中任务', state: 'running', updated_at: '2026-11-25T10:01:00Z', summary: leaf('running') },
    { id: 'w-ready', title: '待验收任务', state: 'ready', updated_at: '2026-11-25T10:02:00Z', summary: leaf('ready') },
    { id: 'w-wait', title: '待处理任务', state: 'waiting_person', updated_at: '2026-11-25T10:03:00Z', summary: leaf('waiting_person') },
  ];

  const { user } = open('#/', (call) => {
    if (call.path === '/api/tasks?top=1') return { tasks, children: [] };
    return undefined;
  });

  await screen.findByRole('heading', { level: 1, name: '总览' });
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const palette = await screen.findByRole('dialog', { name: '搜索或跳转' });

  const workTitles = () => within(palette)
    .getAllByRole('option')
    .map((el) => el.textContent ?? '')
    .filter((text) => text.includes('任务'));

  await waitFor(() => {
    expect(workTitles().map((t) => t.slice(0, 5))).toEqual([
      '待处理任务',
      '待验收任务',
      '进行中任务',
      '可续接任务',
    ]);
  });

  // Top tasks show 1..4 index hints when search is empty
  expect(within(palette).getByRole('option', { name: /待处理任务/ })).toHaveTextContent('1');
  expect(within(palette).getByRole('option', { name: /待验收任务/ })).toHaveTextContent('2');

  // SSE update changes w-done into waiting_person while palette is open: order must stay frozen!
  tasks = [
    { id: 'w-done', title: '可续接任务', state: 'waiting_person', updated_at: '2026-11-25T10:10:00Z', summary: leaf('waiting_person') },
    { id: 'w-run', title: '进行中任务', state: 'running', updated_at: '2026-11-25T10:01:00Z', summary: leaf('running') },
    { id: 'w-ready', title: '待验收任务', state: 'ready', updated_at: '2026-11-25T10:02:00Z', summary: leaf('ready') },
    { id: 'w-wait', title: '待处理任务', state: 'done', updated_at: '2026-11-25T10:03:00Z', summary: leaf('done') },
  ];
  await act(async () => { shellStream().emit('changed', {}); });
  await waitFor(() => {
    expect(within(palette).getByRole('option', { name: /待处理任务/ })).toHaveTextContent('已完成');
  });
  expect(workTitles().map((t) => t.slice(0, 5))).toEqual([
    '待处理任务',
    '待验收任务',
    '进行中任务',
    '可续接任务',
  ]);

  // Alt+2 jumps directly to the 2nd task (w-ready) when search is empty
  fireEvent.keyDown(window, { key: '2', code: 'Digit2', altKey: true });
  await waitFor(() => expect(window.location.hash).toBe('#/work/w-ready'));

  // Contextual quick action: 查看账号与额度
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const reopened = await screen.findByRole('dialog', { name: '搜索或跳转' });
  await user.click(within(reopened).getByRole('option', { name: '查看账号与额度' }));
  await waitFor(() => expect(window.location.hash).toBe('#/accounts'));
});
