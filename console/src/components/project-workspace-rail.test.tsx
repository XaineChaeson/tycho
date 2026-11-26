import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { ProjectWorkspaceRail, SNOOZED_STORAGE_KEY } from '@/components/project-workspace-rail';
import { serve, type Handler } from '@/test/harness';

const leaf = (dot: string) => ({ dot, text: '', counts: {}, leaf: true });

beforeEach(() => {
  window.localStorage.clear();
});

function renderRail(handler: Handler) {
  const service = serve(handler);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const onSelectThread = vi.fn();
  const onTabChange = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectWorkspaceRail
          projectId="p1"
          activeTab="threads"
          onTabChange={onTabChange}
          onSelectThread={onSelectThread}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...service, client, user, onSelectThread, ...view };
}

function railHandler(getTasks: () => object[]): Handler {
  return (call) => {
    if (call.path === '/api/tasks?top=1') return { tasks: getTasks(), children: [] };
    if (call.path === '/api/projects/p1/files') return { files: [] };
    if (call.path === '/api/knowledge') return { entries: [], entry_machines: {} };
    return undefined;
  };
}

test('renders crisp action-word pills and stable min-h-[48px] zero-jitter thread cards', async () => {
  const tasks = [
    { id: 't-wait', project_id: 'p1', title: '确认发布参数', state: 'waiting_person', updated_at: '2026-11-25T10:00:00Z', summary: leaf('waiting_person') },
    { id: 't-ready', project_id: 'p1', title: '接口改造待验', state: 'ready', updated_at: '2026-11-25T09:50:00Z', summary: leaf('ready') },
    { id: 't-review', project_id: 'p1', title: '安全审计中', state: 'ready', active_review: 'rev-1', updated_at: '2026-11-25T09:40:00Z', summary: leaf('running') },
    { id: 't-run', project_id: 'p1', title: '跑基准测试', state: 'running', updated_at: '2026-11-25T09:30:00Z', summary: leaf('running') },
    { id: 't-queue', project_id: 'p1', title: '等待队列任务', state: 'queued', updated_at: '2026-11-25T09:20:00Z', summary: leaf('queued') },
    { id: 't-done', project_id: 'p1', title: '历史已完结任务', state: 'done', resumable: true, updated_at: '2026-11-25T09:10:00Z', summary: leaf('done') },
    { id: 't-done-non-resumable', project_id: 'p1', title: '历史不可续任务', state: 'done', updated_at: '2026-11-25T09:05:00Z', summary: leaf('done') },
  ];
  const { user } = renderRail(railHandler(() => tasks));

  const waitBtn = await screen.findByRole('button', { name: /确认发布参数/ });
  expect(waitBtn).toHaveTextContent('待回复');
  expect(waitBtn.className).toContain('min-h-[48px]');

  expect(screen.getByRole('button', { name: /接口改造待验/ })).toHaveTextContent('待验收');
  expect(screen.getByRole('button', { name: /安全审计中/ })).toHaveTextContent('审阅中');
  expect(screen.getByRole('button', { name: /跑基准测试/ })).toHaveTextContent('执行中');
  expect(screen.getByRole('button', { name: /等待队列任务/ })).toHaveTextContent('排队中');
  // Recent completed threads are collapsed by default while active work exists; clicking expands them.
  expect(screen.queryByRole('button', { name: /历史已完结任务/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: /近期可续接/ }));
  expect(screen.getByRole('button', { name: /历史已完结任务/ })).toHaveTextContent('可续接');
  expect(screen.getByRole('button', { name: /历史不可续任务/ })).not.toHaveTextContent('可续接');
});

test('renders compact TaskIdentityStrip on ThreadCard when task.assignment is present', async () => {
  const tasks = [
    {
      id: 't-assigned',
      project_id: 'p1',
      title: '前端构建验证',
      state: 'running',
      updated_at: '2026-11-25T10:00:00Z',
      summary: leaf('running'),
      assignment: {
        role_id: 'implement',
        role_name: '实现者',
        tier: 'execute',
        tier_source: 'default',
        login_name: 'codex 账号',
        executor: 'codex',
        machine_name: 'kr',
        placed_by: 'pinned',
        is_live: true,
      },
    },
    {
      id: 't-prev',
      project_id: 'p1',
      title: '审阅历史报告',
      state: 'ready',
      updated_at: '2026-11-25T09:50:00Z',
      summary: leaf('ready'),
      assignment: {
        role_id: 'review',
        role_name: '审阅者',
        tier: 'decide',
        tier_source: 'default',
        login_name: 'DEV-WORKSTATION/gemini',
        executor: 'gemini',
        machine_name: 'DEV-WORKSTATION',
        placed_by: 'spread',
        is_live: false,
      },
    },
  ];
  renderRail(railHandler(() => tasks));

  const liveBtn = await screen.findByRole('button', { name: /前端构建验证/ });
  const liveStrip = liveBtn.querySelector('[data-slot="task-identity-strip"]')!;
  expect(liveStrip).not.toBeNull();
  expect(liveStrip).toHaveTextContent('实现者 · 执行档');
  expect(liveStrip).toHaveTextContent('codex 账号 @ kr');
  expect(liveStrip).toHaveTextContent('手工指定');
  expect(liveStrip).not.toHaveTextContent('上轮：');

  const prevBtn = screen.getByRole('button', { name: /审阅历史报告/ });
  const prevStrip = prevBtn.querySelector('[data-slot="task-identity-strip"]')!;
  expect(prevStrip).toHaveTextContent('上轮：');
  expect(prevStrip).toHaveTextContent('审阅者 · 决策档');
  expect(prevStrip).toHaveTextContent('gemini @ DEV-WORKSTATION');
  expect(prevStrip).toHaveTextContent('审阅分散');
});

test('snoozes a thread into localStorage and collapsible 已延后 section, and unsnoozes on click', async () => {
  const tasks = [
    { id: 't1', project_id: 'p1', title: '后台编译任务', state: 'running', updated_at: '2026-11-25T10:00:00Z', summary: leaf('running') },
  ];
  const { user } = renderRail(railHandler(() => tasks));

  await screen.findByRole('button', { name: /后台编译任务/ });
  const row = document.querySelector('[data-thread="t1"]') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: '延后' }));

  const stored = JSON.parse(window.localStorage.getItem(SNOOZED_STORAGE_KEY) ?? '{}');
  expect(stored.t1).toMatchObject({ state: 'running', at: expect.any(Number) });

  // Collapsed by default inside 已延后
  const snoozedToggle = screen.getByRole('button', { name: /已延后/ });
  expect(snoozedToggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: /后台编译任务/ })).toBeNull();

  await user.click(snoozedToggle);
  expect(snoozedToggle).toHaveAttribute('aria-expanded', 'true');
  const snoozedRow = document.querySelector('[data-thread="t1"]') as HTMLElement;
  await user.click(within(snoozedRow).getByRole('button', { name: '取消延后' }));

  expect(window.localStorage.getItem(SNOOZED_STORAGE_KEY)).toBeNull();
  expect(screen.queryByRole('button', { name: /已延后/ })).toBeNull();
  expect(screen.getByRole('button', { name: /后台编译任务/ })).toBeInTheDocument();
});

test('auto-unsnoozes a task when its state transitions to waiting_person or ready after being snoozed', async () => {
  window.localStorage.setItem(SNOOZED_STORAGE_KEY, JSON.stringify({
    t1: { at: Date.now() - 60_000, state: 'running' },
  }));

  let tasks = [
    { id: 't1', project_id: 'p1', title: '需要确认的编译', state: 'running', updated_at: '2026-11-25T10:00:00Z', summary: leaf('running') },
  ];
  const { client } = renderRail(railHandler(() => tasks));

  expect(await screen.findByRole('button', { name: /已延后/ })).toBeInTheDocument();

  // State transitions to waiting_person -> should auto-unsnooze immediately
  tasks = [
    { id: 't1', project_id: 'p1', title: '需要确认的编译', state: 'waiting_person', updated_at: '2026-11-25T10:05:00Z', summary: leaf('waiting_person') },
  ];
  await client.invalidateQueries({ queryKey: ['tasks'] });

  const restored = await screen.findByRole('button', { name: /需要确认的编译/ });
  expect(restored).toHaveTextContent('待回复');
  await waitFor(() => expect(screen.queryByRole('button', { name: /已延后/ })).toBeNull());
  expect(window.localStorage.getItem(SNOOZED_STORAGE_KEY)).toBeNull();
});
