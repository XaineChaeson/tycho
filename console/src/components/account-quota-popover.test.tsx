import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, test } from 'vitest';
import { AccountQuotaPopover } from '@/components/account-quota-popover';
import { refusal, serve, type Handler } from '@/test/harness';

function renderPopover(handler: Handler) {
  const service = serve(handler);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AccountQuotaPopover />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...service, client, user, ...view };
}

const FUTURE_2H = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const FUTURE_3D = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

function makeAccountsResponse(accounts: object[], machines: object[] = []): Handler {
  return (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') {
      return { accounts, executors: ['codex', 'claude'], permission_modes: {}, tier_forms: {}, credential_executors: [] };
    }
    if (call.method === 'GET' && call.path === '/api/machines') {
      return { machines, invites: [] };
    }
    return undefined;
  };
}

test('degrades cleanly (renders nothing and no alert) when /api/accounts fails or returns empty', async () => {
  const { container } = renderPopover((call) => {
    if (call.path === '/api/accounts') throw refusal('未实现', 404);
    return undefined;
  });
  await waitFor(() => expect(container.innerHTML).toBe(''));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('renders compact provider remaining summary, opens upward popover with 5h/7d bars, and refreshes on 1-click check', async () => {
  let codexUsed = 0.28;
  const baseHandler = makeAccountsResponse([
    {
      id: 'acc-codex',
      name: 'Codex 主力',
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
        rest: null,
        usage: [
          { window: 'five_hour', used: codexUsed, resets_at: FUTURE_2H, at: new Date().toISOString() },
          { window: 'seven_day', used: 0.15, resets_at: FUTURE_3D, at: new Date().toISOString() },
        ],
      },
    },
    {
      id: 'acc-claude',
      name: 'Claude 备用',
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
        usage: [
          { window: 'five_hour', used: 0.14, resets_at: FUTURE_2H, at: new Date().toISOString() },
        ],
      },
    },
  ]);

  const { user, calls } = renderPopover((call) => {
    if (call.method === 'POST' && call.path === '/api/accounts/acc-codex/check') {
      codexUsed = 0.4;
      return { machine: null };
    }
    if (call.method === 'GET' && call.path === '/api/accounts') {
      const base = baseHandler(call) as { accounts: { id: string; status: { usage: { window: string; used: number }[] } }[] };
      base.accounts[0]!.status.usage[0]!.used = codexUsed;
      return base;
    }
    return baseHandler(call);
  });

  const trigger = await screen.findByRole('button', { name: /账号额度：Codex 72% · Claude 86%/ });
  expect(trigger).toHaveTextContent('Codex 72% · Claude 86%');

  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: '账号与额度' });
  expect(within(dialog).getByText('Codex 主力')).toBeInTheDocument();
  expect(within(dialog).getByText('Claude 备用')).toBeInTheDocument();
  expect(within(dialog).getAllByText('可用')).toHaveLength(2);
  expect(within(dialog).getByText('剩 72%')).toBeInTheDocument();
  expect(within(dialog).getByText('剩 85%')).toBeInTheDocument();
  expect(within(dialog).getByRole('link', { name: '管理全部账号 →' })).toHaveAttribute('href', '/accounts');

  await user.click(within(dialog).getByRole('button', { name: '刷新 Codex 主力 额度' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/accounts/acc-codex/check', method: 'POST', body: {} }]));
  await waitFor(() => expect(within(dialog).getByText('剩 60%')).toBeInTheDocument());

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '账号与额度' })).toBeNull());
});

test('applies amber tint when remaining <= 20% and red dot with badges when resting or needing relogin', async () => {
  const { user } = renderPopover(makeAccountsResponse([
    {
      id: 'acc-low',
      name: '低额度号',
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
        rest: null,
        usage: [{ window: 'five_hour', used: 0.85, resets_at: FUTURE_2H, at: new Date().toISOString() }],
      },
    },
  ]));

  const lowTrigger = await screen.findByRole('button', { name: /Codex 15%/ });
  expect(lowTrigger.querySelector('[data-tone="waiting"]')).not.toBeNull();
  expect(lowTrigger.className).toContain('bg-waiting-soft');

  await user.click(lowTrigger);
  expect(await screen.findByText('剩 15%')).toBeInTheDocument();
});

test('shows red dot and 限额休眠 / 需重登 badges when accounts are resting or rejected', async () => {
  const { user } = renderPopover(makeAccountsResponse([
    {
      id: 'acc-rest',
      name: '休眠号',
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
        rest: { until: FUTURE_2H, reason: 'rate limit' },
        usage: [{ window: 'five_hour', used: 1, resets_at: FUTURE_2H, at: new Date().toISOString() }],
      },
    },
    {
      id: 'acc-bad',
      name: '失效号',
      executor: 'claude',
      credential: 'rejected',
      can_route: true,
      tiers: {},
      permission_mode: null,
      timeout_ms: null,
      max_runs: null,
      queued_tasks: 0,
      status: { active_runs: 0, max_runs: 2, rest: null, usage: [], rejected: true },
    },
  ]));

  const trigger = await screen.findByRole('button', { name: /Codex 0%/ });
  expect(trigger.querySelector('[data-tone="failed"]')).not.toBeNull();

  await user.click(trigger);
  const popover = await screen.findByRole('dialog', { name: '账号与额度' });
  expect(within(popover).getByText('限额休眠')).toBeInTheDocument();
  expect(within(popover).getByText('需重登')).toBeInTheDocument();
});

test('aggregates multi-machine local authorizations into one logical entry and renders ledger telemetry & gateway budgets', async () => {
  const { user } = renderPopover((call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') {
      return {
        accounts: [
          {
            id: 'acc-dsh',
            name: '天眼网关 DSH',
            executor: 'dsh',
            credential: 'set',
            can_route: false,
            tiers: {},
            permission_mode: null,
            timeout_ms: null,
            max_runs: null,
            queued_tasks: 0,
            status: {
              active_runs: 0,
              max_runs: 2,
              rest: null,
              usage: [{ window: 'gateway_budget:$75.00/$100', used: 0.25, resets_at: null, at: new Date().toISOString() }],
            },
          },
        ],
        login_telemetry: {
          'ml-kr-gem': { five_hour_tokens: 45_000, five_hour_runs: 2, day_tokens: 120_000, day_runs: 5, last_at: new Date().toISOString() },
          'ml-win-gem': { five_hour_tokens: 15_000, five_hour_runs: 1, day_tokens: 30_000, day_runs: 2, last_at: new Date().toISOString() },
        },
        executors: ['dsh', 'gemini'],
        permission_modes: {},
        tier_forms: {},
        credential_executors: [],
      };
    }
    if (call.method === 'GET' && call.path === '/api/machines') {
      return {
        machines: [
          {
            id: 'kr',
            uid: 'u-kr',
            host: 'kr',
            note: null,
            node: { connected: true, node_id: 'n-kr', platform: 'linux', joined_at: null, last_seen_at: null, reported_runs: 0, reported_unknown: 0, source: null, ephemeral: false, scope: null, ends: null, executors: null, release: null },
            logins: [{ id: 'ml-kr-gem', name: 'kr/gemini', kind: 'machine', machine: 'kr', executor: 'gemini', configured: true, signed_in: true, can_route: true, router_reason: null, tiers: {}, permission_mode: null, timeout_ms: null, max_runs: null, status: { active_runs: 0, max_runs: 2, rest: null, usage: [] }, queued_tasks: 0, refused: false, usable_here: true }],
          },
          {
            id: 'DP-DM',
            uid: 'u-win',
            host: 'DP-DM',
            note: null,
            node: { connected: true, node_id: 'n-win', platform: 'win32', joined_at: null, last_seen_at: null, reported_runs: 0, reported_unknown: 0, source: null, ephemeral: false, scope: null, ends: null, executors: null, release: null },
            logins: [{ id: 'ml-win-gem', name: 'DP-DM/gemini', kind: 'machine', machine: 'DP-DM', executor: 'gemini', configured: true, signed_in: true, can_route: true, router_reason: null, tiers: {}, permission_mode: null, timeout_ms: null, max_runs: null, status: { active_runs: 0, max_runs: 2, rest: null, usage: [] }, queued_tasks: 0, refused: false, usable_here: true }],
          },
        ],
        invites: [],
      };
    }
    return undefined;
  });

  const trigger = await screen.findByRole('button', { name: /DSH 75%/ });
  await user.click(trigger);
  const popover = await screen.findByRole('dialog', { name: '账号与额度' });
  expect(within(popover).getByText('网关额度')).toBeInTheDocument();
  expect(within(popover).getByText('$75.00/$100')).toBeInTheDocument();
  expect(within(popover).getByText('Gemini（2 台机器）')).toBeInTheDocument();
  expect(within(popover).getByText(/近 5h 60\.0k \(3 轮\) · 24h 150\.0k/)).toBeInTheDocument();
});
