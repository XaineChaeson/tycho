import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';
import { ItemView } from '@/components/conversation';
import { TaskIdentityStrip } from '@/components/task-identity-strip';
import type { Task, TaskAssignment } from '@/lib/types';
import { open } from '@/test/harness';

const BASE_ASSIGNMENT: TaskAssignment = {
  role_id: 'coordinator',
  role_name: '协调者',
  tier: 'decide',
  tier_source: 'default',
  login_name: 'DEV-WORKSTATION/gemini',
  executor: 'gemini',
  machine_name: 'DEV-WORKSTATION',
  placed_by: 'order',
  is_live: true,
};

test('TaskIdentityStrip formats role · tier, login @ machine, 待派发, notable placements, and 上轮： prefix', () => {
  const { rerender, container } = render(<TaskIdentityStrip assignment={BASE_ASSIGNMENT} showLiveLabel />);
  const strip = () => container.querySelector('[data-slot="task-identity-strip"]')!;
  expect(strip()).toHaveTextContent('协调者 · 决策档');
  expect(strip()).toHaveTextContent('gemini @ DEV-WORKSTATION');
  expect(strip()).not.toHaveTextContent('上轮：');
  expect(strip()).not.toHaveTextContent('手工指定');

  rerender(
    <TaskIdentityStrip
      assignment={{
        ...BASE_ASSIGNMENT,
        role_name: '实现者',
        tier: 'execute',
        login_name: 'codex 账号',
        machine_name: 'kr',
        placed_by: 'pinned',
        is_live: false,
      }}
      showLiveLabel
    />,
  );
  expect(strip()).toHaveTextContent('上轮：');
  expect(strip()).toHaveTextContent('实现者 · 执行档');
  expect(strip()).toHaveTextContent('codex 账号 @ kr');
  expect(strip()).toHaveTextContent('手工指定');

  rerender(
    <TaskIdentityStrip
      assignment={{
        ...BASE_ASSIGNMENT,
        login_name: null,
        machine_name: null,
        placed_by: 'prefer',
        is_live: true,
      }}
      showLiveLabel
    />,
  );
  expect(strip()).toHaveTextContent('待派发');
  expect(strip()).toHaveTextContent('负责人优先');
});

test('chat inline task capsules render TaskIdentityStrip and require resumable === true for 可续接', () => {
  const noSource = { source: null, source_state: null, source_label: null } as const;
  const liveTasks = new Map<string, Task>([
    [
      't1',
      {
        ...noSource,
        id: 't1',
        title: '修复部署脚本',
        state: 'running',
        assignment: {
          ...BASE_ASSIGNMENT,
          role_name: '实现者',
          tier: 'execute',
          login_name: 'codex 账号',
          machine_name: 'kr',
          is_live: true,
        },
      },
    ],
    [
      't2',
      {
        ...noSource,
        id: 't2',
        title: '历史归档任务',
        state: 'done',
      },
    ],
    [
      't3',
      {
        ...noSource,
        id: 't3',
        title: '已交付会话任务',
        state: 'done',
        resumable: true,
      },
    ],
  ]);

  render(
    <MemoryRouter>
      <ItemView
        item={{
          key: 'capsules-1',
          kind: 'capsules',
          tasks: [
            { id: 't1', title: '修复部署脚本', state: 'running' },
            { id: 't2', title: '历史归档任务', state: 'done' },
            { id: 't3', title: '已交付会话任务', state: 'done' },
          ],
        }}
        liveTasks={liveTasks}
        onSelectTask={vi.fn()}
      />
    </MemoryRouter>,
  );

  const runningBtn = screen.getByRole('button', { name: /修复部署脚本/ });
  const strip = runningBtn.querySelector('[data-slot="task-identity-strip"]')!;
  expect(strip).not.toBeNull();
  expect(strip).toHaveTextContent('实现者 · 执行档');
  expect(strip).toHaveTextContent('codex 账号 @ kr');

  expect(screen.getByRole('button', { name: /历史归档任务/ })).not.toHaveTextContent('可续接');
  expect(screen.getByRole('button', { name: /已交付会话任务/ })).toHaveTextContent('可续接');
});

test('TaskPage header renders synthesized TaskIdentityStrip without expanding details, and draft composer submits to /continue', async () => {
  const { user, calls } = open('#/task/t-draft', (call) => {
    if (call.path === '/api/tasks/t-draft') {
      return {
        task: {
          id: 't-draft',
          title: '草稿规划任务',
          state: 'draft',
          project_id: 'p1',
          goal: '先拟定架构方案',
          acceptance: '给出评审清单',
          revision: 1,
          role_id: 'plan',
          tier: 'decide',
          tier_source: 'default',
          created_at: '2026-11-25T08:00:00Z',
        },
        work: { id: 't-draft', title: '草稿规划任务', state: 'draft', project_id: 'p1' },
        role: { id: 'plan', name: '规划者', default_tier: 'decide', read_only: true, description: '', prompt: '', created_at: '2026-11-25T08:00:00Z', updated_at: '2026-11-25T08:00:00Z' },
        children: [],
        runs: [
          {
            id: 'r1',
            task_id: 't-draft',
            task_revision: 1,
            login_id: 'l1',
            login_name: 'codex 账号',
            machine_id: 'kr',
            host: 'kr',
            session_ref: 'sess-1',
            state: 'ended',
            exit_kind: 'completed',
            executor: 'codex',
            placed_by: 'spread',
            receipt: null,
            error: null,
            created_at: '2026-11-25T08:01:00Z',
            started_at: '2026-11-25T08:01:00Z',
            ended_at: '2026-11-25T08:05:00Z',
          },
        ],
        inputs: [],
        approvals: [],
        releases: { version: '0.1.850', last: null, intent: null, attempting: false, fetch: null, packages: [] },
      };
    }
    if (call.path === '/api/tasks/t-draft/continue' && call.method === 'POST') return { ok: true };
    if (call.path === '/api/runs/r1/events') return { events: [], first_index: 0, loaded: true };
    if (call.path === '/api/runs/r1/snapshot') return { snapshot: { brief: 'test' } };
    return undefined;
  });

  const heading = await screen.findByRole('heading', { level: 1, name: '草稿规划任务' });
  const header = heading.closest('header')!;
  const strip = header.querySelector('[data-slot="task-identity-strip"]')!;
  expect(strip).not.toBeNull();
  expect(strip).toHaveTextContent('上轮：');
  expect(strip).toHaveTextContent('规划者 · 决策档');
  expect(strip).toHaveTextContent('codex 账号 @ kr');
  expect(strip).toHaveTextContent('审阅分散');

  const composer = screen.getByRole('textbox', { name: '继续发送指令' });
  await user.type(composer, '请开始执行{Enter}');
  await waitFor(() => expect(calls).toContainEqual({
    path: '/api/tasks/t-draft/continue',
    method: 'POST',
    body: { note: '请开始执行' },
  }));
});

test('TaskThreadPane header inside ProjectPage displays TaskIdentityStrip at first glance', async () => {
  open('#/projects/p1?thread=t-pane', (call) => {
    if (call.path === '/api/tasks/t-pane') {
      return {
        task: {
          id: 't-pane',
          title: '嵌入式线程标题',
          state: 'running',
          project_id: 'p1',
          goal: '完成实现',
          revision: 1,
          created_at: '2026-11-25T08:00:00Z',
          assignment: BASE_ASSIGNMENT,
        },
        work: { id: 't-pane', title: '嵌入式线程标题', state: 'running', project_id: 'p1' },
        children: [],
        runs: [],
        inputs: [],
        approvals: [],
        releases: { version: '0.1.850', last: null, intent: null, attempting: false, fetch: null, packages: [] },
      };
    }
    return undefined;
  });

  const pane = await screen.findByRole('region', { name: '任务线程' });
  await waitFor(() => {
    const strip = pane.querySelector('[data-slot="task-identity-strip"]');
    expect(strip).not.toBeNull();
    expect(strip).toHaveTextContent('协调者 · 决策档');
    expect(strip).toHaveTextContent('gemini @ DEV-WORKSTATION');
  });
  expect(within(pane).getByText('gemini @ DEV-WORKSTATION')).toBeVisible();
});
