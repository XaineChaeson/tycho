import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, test } from 'vitest';
import { ComposerTargetChip, type ComposerTargetChipProps } from '@/components/composer-target-chip';
import { refusal, serve, type Handler } from '@/test/harness';

function renderChip(props: ComposerTargetChipProps, handler: Handler) {
  const service = serve(handler);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ComposerTargetChip {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...service, client, user, ...view };
}

const FUTURE_1H = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const ACCOUNTS = [
  {
    id: 'acc-1',
    name: 'Claude-Alpha',
    executor: 'claude',
    credential: 'set',
    can_route: true,
    tiers: {},
    permission_mode: null,
    timeout_ms: null,
    max_runs: null,
    queued_tasks: 0,
    status: {
      active_runs: 0,
      max_runs: 2,
      rest: null,
      usage: [{ window: 'five_hour', used: 0.19, resets_at: FUTURE_1H, at: new Date().toISOString() }],
    },
  },
  {
    id: 'acc-2',
    name: 'Codex-Beta',
    executor: 'codex',
    credential: 'set',
    can_route: true,
    tiers: {},
    permission_mode: null,
    timeout_ms: null,
    max_runs: null,
    queued_tasks: 0,
    status: {
      active_runs: 0,
      max_runs: 2,
      rest: { until: FUTURE_1H, reason: 'quota' },
      usage: [{ window: 'five_hour', used: 1, resets_at: FUTURE_1H, at: new Date().toISOString() }],
    },
  },
];

const PROJECT_BASE = {
  id: 'p1',
  name: '核心服务',
  sources: [],
  logins: ['acc-1'],
  login_mode: 'selected' as const,
  machines: [],
  spawn_machines: false,
  router: { account: 'acc-1' as string | null, tier: null as string | null },
  moving: 0,
  waiting: 0,
};

test('degrades cleanly when accounts API is unavailable', async () => {
  const { container } = renderChip({ mode: 'project', projectId: 'p1' }, (call) => {
    if (call.path === '/api/accounts') throw refusal('not found', 404);
    return undefined;
  });
  await waitFor(() => expect(container.innerHTML).toBe(''));
});

test('mode="project" displays configured router account quota and switches via PUT /api/projects/:id', async () => {
  let currentProject = { ...PROJECT_BASE };
  const { user, calls } = renderChip({ mode: 'project', projectId: 'p1' }, (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') {
      return { accounts: ACCOUNTS, executors: ['claude', 'codex'], permission_modes: {}, tier_forms: {}, credential_executors: [] };
    }
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [], invites: [] };
    if (call.method === 'GET' && call.path === '/api/projects') return { projects: [currentProject] };
    if (call.method === 'PUT' && call.path === '/api/projects/p1') {
      const body = call.body as { router: { account: string | null; tier: string | null } };
      currentProject = { ...currentProject, router: body.router };
      return { project: currentProject };
    }
    return undefined;
  });

  const chip = await screen.findByRole('button', { name: /负责人 · Claude-Alpha · 剩 81%/ });
  await user.click(chip);

  const popover = await screen.findByRole('dialog', { name: '选择项目负责人账号' });
  expect(within(popover).getByText('沿用服务默认')).toBeInTheDocument();
  expect(within(popover).getByText('Codex-Beta')).toBeInTheDocument();

  await user.click(within(popover).getByRole('button', { name: /沿用服务默认/ }));
  await waitFor(() => expect(calls).toEqual([
    { path: '/api/projects/p1', method: 'PUT', body: { router: { account: null, tier: null } } },
  ]));
  await waitFor(() => expect(screen.getByRole('button', { name: /负责人 · 服务默认/ })).toBeInTheDocument());
});

test('mode="task" filters worker pool by project login_mode and shows currentLogin / settings link', async () => {
  const handler: Handler = (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') {
      return { accounts: ACCOUNTS, executors: ['claude', 'codex'], permission_modes: {}, tier_forms: {}, credential_executors: [] };
    }
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [], invites: [] };
    if (call.method === 'GET' && call.path === '/api/projects') return { projects: [PROJECT_BASE] };
    return undefined;
  };

  const { user, unmount } = renderChip({ mode: 'task', projectId: 'p1' }, handler);
  const autoChip = await screen.findByRole('button', { name: /自动选号 · 1 个可用/ });
  await user.click(autoChip);

  const popover = await screen.findByRole('dialog', { name: '项目执行登录池' });
  expect(within(popover).getByText('Claude-Alpha')).toBeInTheDocument();
  expect(within(popover).queryByText('Codex-Beta')).toBeNull();
  expect(within(popover).getByRole('link', { name: '调整项目登录池 →' })).toHaveAttribute('href', '/projects/p1/settings');
  unmount();

  renderChip({ mode: 'task', projectId: 'p1', currentLogin: 'acc-1', currentMachine: 'gpu-01' }, handler);
  expect(await screen.findByRole('button', { name: /Claude-Alpha · gpu-01 · 剩 81%/ })).toBeInTheDocument();
});

test('mode="project" resolves multi-machine router login id to human name and remaining pct instead of raw ULID', async () => {
  const proj = { ...PROJECT_BASE, router: { account: 'ml-kr', tier: 'decide' } };
  renderChip({ mode: 'project', projectId: 'p1' }, (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') {
      return { accounts: ACCOUNTS, executors: ['claude', 'codex', 'gemini'], permission_modes: {}, tier_forms: {}, credential_executors: [] };
    }
    if (call.method === 'GET' && call.path === '/api/machines') {
      return {
        machines: [
          {
            id: 'win',
            node: { connected: true },
            logins: [{ id: 'ml-win', name: 'win/gemini', executor: 'gemini', configured: true, can_route: true, status: { active_runs: 0, max_runs: null, rest: null, usage: [] } }],
          },
          {
            id: 'kr',
            node: { connected: true },
            logins: [{ id: 'ml-kr', name: 'kr/gemini', executor: 'gemini', configured: true, can_route: true, status: { active_runs: 0, max_runs: null, rest: null, usage: [{ window: 'seven_day', used: 0.13, resets_at: FUTURE_1H, at: new Date().toISOString() }] } }],
          },
        ],
        invites: [],
      };
    }
    if (call.method === 'GET' && call.path === '/api/projects') return { projects: [proj] };
    return undefined;
  });

  const chip = await screen.findByRole('button', { name: /负责人 · 机器 kr 上的 gemini 登录 · 剩 87%/ });
  expect(chip).toBeInTheDocument();
});
