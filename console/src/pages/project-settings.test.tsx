import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { open, type Call } from '@/test/harness';

const PROJECT = {
  id: 'p1',
  name: '试跑',
  sources: [],
  login_mode: 'all',
  logins: [],
  machines: [],
  spawn_machines: false,
  grants: ['accept'],
  moving: 0,
  waiting: 0,
  pool: [],
};

test('project settings marks modified switches inline as 未保存 and names dirty tabs in the sticky bar', async () => {
  const calls: Call[] = [];
  let current = { ...PROJECT };
  const { user } = open('#/projects/p1/settings', (call) => {
    if (call.method === 'GET' && call.path === '/api/projects') return { projects: [current] };
    if (call.method === 'GET' && call.path === '/api/accounts') return { accounts: [], executors: [], permission_modes: {} };
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [], invites: [] };
    if (call.method === 'PUT' && call.path === '/api/projects/p1') {
      calls.push(call);
      current = { ...current, ...(call.body as Partial<typeof PROJECT>) };
      return { project: current };
    }
    return undefined;
  });

  const article = await screen.findByRole('article', { name: '项目 试跑' });

  // Flip a grant switch on 负责人与权限.
  await user.click(within(article).getByRole('tab', { name: '负责人与权限' }));
  const grantsRegion = within(article).getByRole('region', { name: '试跑 负责人可以自己做' });
  expect(within(grantsRegion).queryByText('未保存')).toBeNull();
  await user.click(within(grantsRegion).getByRole('switch', { name: '上线' }));
  expect(within(grantsRegion).getByText('未保存')).toBeInTheDocument();
  expect(article).toHaveTextContent('（负责人与权限）');

  // Flip spawn_machines on 登录与机器.
  await user.click(within(article).getByRole('tab', { name: '登录与机器' }));
  const spawnRegion = within(article).getByRole('region', { name: '试跑 允许派生机器' });
  await user.click(within(spawnRegion).getByRole('switch', { name: '允许派生机器' }));
  expect(within(spawnRegion).getByText('未保存')).toBeInTheDocument();
  expect(article).toHaveTextContent('（负责人与权限、登录与机器）');

  // Save clears all inline 未保存 badges and the sticky bar.
  await user.click(within(article).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls).toEqual([
    { path: '/api/projects/p1', method: 'PUT', body: { grants: ['accept', 'release'], spawn_machines: true } },
  ]));
  await waitFor(() => expect(within(article).queryByText('有改动还没保存')).toBeNull());
  expect(within(spawnRegion).queryByText('未保存')).toBeNull();
});

test('project settings enriches selected login rows and edits per-project dispatch_order with reset to global default', async () => {
  const calls: Call[] = [];
  let current: Record<string, unknown> = {
    ...PROJECT,
    login_mode: 'selected',
    logins: ['a1', 'a2'],
    pool: ['a1', 'a2'],
    dispatch_order: null,
    effective_dispatch_order: {
      operate: ['a1', 'a2'],
      execute: ['a1', 'a2'],
      decide: ['a1'],
    },
  };
  const accounts = [
    {
      id: 'a1',
      name: '主力 Claude',
      executor: 'claude',
      credential: 'set',
      tiers: {
        execute: { kind: 'content', text: '{"model":"sonnet"}' },
        decide: { kind: 'content', text: '{"model":"opus"}' },
      },
      permission_mode: null,
      timeout_ms: null,
      max_runs: null,
      queued_tasks: 0,
    },
    {
      id: 'a2',
      name: '主力 Codex',
      executor: 'codex',
      credential: 'set',
      tiers: {
        operate: { kind: 'content', text: 'model="mini"' },
        execute: { kind: 'content', text: 'model="codex"' },
      },
      permission_mode: null,
      timeout_ms: null,
      max_runs: null,
      queued_tasks: 0,
    },
    {
      id: 'a3',
      name: '未选 Gemini',
      executor: 'gemini',
      credential: 'set',
      tiers: {
        execute: { kind: 'content', text: 'model="pro"' },
      },
      permission_mode: null,
      timeout_ms: null,
      max_runs: null,
      queued_tasks: 0,
    },
  ];

  const { user } = open('#/projects/p1/settings', (call) => {
    if (call.method === 'GET' && call.path === '/api/projects') return { projects: [current] };
    if (call.method === 'GET' && call.path === '/api/accounts') {
      return {
        accounts,
        executors: ['claude', 'codex', 'gemini'],
        permission_modes: {},
        dispatch_order: { operate: ['a1', 'a2'], execute: ['a1', 'a2', 'a3'], decide: ['a1'] },
      };
    }
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [], invites: [] };
    if (call.method === 'PUT' && call.path === '/api/projects/p1') {
      calls.push(call);
      const body = call.body as { dispatch_order?: Record<string, string[]> | null };
      current = {
        ...current,
        ...body,
        effective_dispatch_order: body.dispatch_order ?? {
          operate: ['a1', 'a2'],
          execute: ['a1', 'a2'],
          decide: ['a1'],
        },
      };
      return { project: current };
    }
    return undefined;
  });

  const article = await screen.findByRole('article', { name: '项目 试跑' });
  await user.click(within(article).getByRole('tab', { name: '登录与机器' }));

  // Enriched login rows under 只用所选 display executor badge + configured tier tags.
  const loginsList = await within(article).findByRole('list', { name: '允许的登录' });
  const claudeRow = within(loginsList).getByRole('checkbox', { name: '账号 主力 Claude' }).closest('li')!;
  expect(claudeRow).toHaveTextContent('claude');
  expect(claudeRow).toHaveTextContent('执行档');
  expect(claudeRow).toHaveTextContent('决策档');

  // Default mode: 沿用全局默认顺序 with read-only preview from effective_dispatch_order.
  const orderSection = within(article).getByRole('region', { name: '试跑 本项目派发顺位' });
  expect(within(orderSection).getByRole('radio', { name: '沿用全局默认顺序' })).toBeChecked();
  expect(orderSection).toHaveTextContent('账号 主力 Claude → 账号 主力 Codex');

  // Switch to 自定义本项目顺位: 3 columns filtered to project's allowed logins (a3 excluded).
  await user.click(within(orderSection).getByRole('radio', { name: '自定义本项目顺位' }));
  const execList = within(orderSection).getByRole('list', { name: '执行档本项目派发顺位' });
  expect(execList).toHaveTextContent('账号 主力 Claude');
  expect(execList).toHaveTextContent('账号 主力 Codex');
  expect(execList).not.toHaveTextContent('未选 Gemini');

  // Reorder execute tier and save atomically via PUT /api/projects/p1.
  await user.click(within(execList).getByRole('button', { name: '把 账号 主力 Claude 在执行档往后挪' }));
  await user.click(within(article).getByRole('button', { name: '保存' }));

  await waitFor(() => expect(calls).toEqual([
    {
      path: '/api/projects/p1',
      method: 'PUT',
      body: {
        dispatch_order: {
          operate: ['a1', 'a2'],
          execute: ['a2', 'a1'],
          decide: ['a1'],
        },
      },
    },
  ]));
  await waitFor(() => expect(within(article).queryByText('有改动还没保存')).toBeNull());

  // Reset back to global default via 恢复全局 and save { dispatch_order: null }.
  await user.click(within(orderSection).getByRole('button', { name: '恢复全局' }));
  expect(within(orderSection).getByRole('radio', { name: '沿用全局默认顺序' })).toBeChecked();
  await user.click(within(article).getByRole('button', { name: '保存' }));

  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toEqual({
    path: '/api/projects/p1',
    method: 'PUT',
    body: { dispatch_order: null },
  });
});
