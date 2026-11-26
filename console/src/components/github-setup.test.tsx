import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { holdClock, pass } from '@/test/harness';
import { GitHubSetup, type GitHubConnection, type GitHubStatus } from './github-setup';

interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
  signal?: AbortSignal | null;
}

const ALICE: GitHubConnection = {
  login: 'alice',
  name: 'Alice Lin',
  avatar_url: null,
  mode: 'pat',
  scopes: ['repo', 'read:org'],
  connected_at: '2026-11-21T08:00:00Z',
  checked_at: '2026-11-21T09:00:00Z',
};

const BOB: GitHubConnection = {
  login: 'bob',
  name: 'Bob Chen',
  avatar_url: null,
  mode: 'device',
  scopes: ['repo'],
  connected_at: '2026-11-21T10:00:00Z',
  checked_at: '2026-11-21T10:00:00Z',
};

afterEach(() => {
  vi.useRealTimers();
});

function setup(handle: (call: RecordedCall) => unknown | Promise<unknown>) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const call: RecordedCall = {
      path,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    try {
      const data = await handle(call);
      return { ok: true, status: 200, json: async () => data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 400, json: async () => ({ error: message }) };
    }
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <GitHubSetup />
    </QueryClientProvider>,
  );
  return {
    ...view,
    calls,
    user: userEvent.setup(),
    writes: () => calls.filter(({ method }) => method !== 'GET'),
  };
}

test('PAT flow connects @alice, verifies with check, and disconnects via confirm dialog', async () => {
  let status: GitHubStatus = { connected: false, connection: null, client_id: null };

  const app = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/github') return status;
    if (call.method === 'POST' && call.path === '/api/github/pat') {
      status = { connected: true, connection: ALICE, client_id: null };
      return { connection: ALICE };
    }
    if (call.method === 'POST' && call.path === '/api/github/check') {
      const checked = { ...ALICE, checked_at: '2026-11-21T11:30:00Z' };
      status = { connected: true, connection: checked, client_id: null };
      return { connection: checked };
    }
    if (call.method === 'DELETE' && call.path === '/api/github') {
      status = { connected: false, connection: null, client_id: null };
      return { disconnected: true };
    }
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  const createLink = await screen.findByRole('link', { name: /去 GitHub 创建 Fine-Grained Token/ });
  expect(createLink).toHaveAttribute('href', 'https://github.com/settings/personal-access-tokens/new?description=Tycho');
  expect(createLink).toHaveAttribute('target', '_blank');
  expect(createLink).toHaveAttribute('rel', 'noreferrer noopener');

  const tokenInput = screen.getByLabelText('GitHub Token');
  expect(tokenInput).toHaveAttribute('type', 'password');
  const connectBtn = screen.getByRole('button', { name: '验证并连接' });
  expect(connectBtn).toBeDisabled();

  await app.user.type(tokenInput, 'github_pat_secret_123');
  expect(connectBtn).toBeEnabled();
  await app.user.click(connectBtn);

  await screen.findByText('@alice');
  expect(screen.getByText('Alice Lin')).toBeInTheDocument();
  expect(screen.getByText('已连接')).toBeInTheDocument();
  expect(screen.getByText('PAT')).toBeInTheDocument();
  expect(screen.getByText('repo')).toBeInTheDocument();
  expect(screen.getByText('read:org')).toBeInTheDocument();
  expect(app.writes()[0]).toMatchObject({
    method: 'POST',
    path: '/api/github/pat',
    body: { token: 'github_pat_secret_123' },
  });

  // Test connection check
  await app.user.click(screen.getByRole('button', { name: '测试连接' }));
  await screen.findByRole('status');
  expect(screen.getByRole('status')).toHaveTextContent('连接有效');
  expect(app.writes()[1]).toMatchObject({
    method: 'POST',
    path: '/api/github/check',
    body: {},
  });

  // Disconnect via Confirm dialog
  await app.user.click(screen.getByRole('button', { name: '断开连接' }));
  const dialog = await screen.findByRole('alertdialog');
  await app.user.click(within(dialog).getByRole('button', { name: '确认断开' }));

  const backToInput = await screen.findByLabelText('GitHub Token');
  expect(backToInput).toHaveValue('');
  expect(app.writes()[2]).toMatchObject({
    method: 'DELETE',
    path: '/api/github',
  });
});

test('PAT connection failure surfaces alert error and preserves input', async () => {
  const app = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/github') {
      return { connected: false, connection: null, client_id: null };
    }
    if (call.method === 'POST' && call.path === '/api/github/pat') {
      throw new Error('GitHub Token 无效或已过期');
    }
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  const tokenInput = await screen.findByLabelText('GitHub Token');
  await app.user.type(tokenInput, 'ghp_invalid');
  await app.user.click(screen.getByRole('button', { name: '验证并连接' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('GitHub Token 无效或已过期');
  expect(tokenInput).toHaveValue('ghp_invalid');
});

test('Device Flow displays code and verification link, polls until connected, and refreshes status', async () => {
  holdClock();
  let status: GitHubStatus = { connected: false, connection: null, client_id: 'Ov23liPreset' };
  let polls = 0;

  const app = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/github') return status;
    if (call.method === 'POST' && call.path === '/api/github/device/start') {
      return {
        session_id: 'dev-session-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 3, // below 5s floor: UI must clamp to 5s
      };
    }
    if (call.method === 'POST' && call.path === '/api/github/device/poll') {
      polls += 1;
      if (polls === 1) return { state: 'pending' };
      status = { connected: true, connection: BOB, client_id: 'Ov23liPreset' };
      return { state: 'connected', connection: BOB };
    }
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  await screen.findByLabelText('GitHub Token');
  await app.user.click(screen.getByText('Device Flow（设备码）'));

  const clientInput = screen.getByLabelText('GitHub OAuth Client ID');
  expect(clientInput).toHaveValue('Ov23liPreset');
  await app.user.clear(clientInput);
  await app.user.type(clientInput, 'Ov23liCustom123');
  await app.user.click(screen.getByRole('button', { name: '获取设备码' }));

  expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /复制设备码：ABCD-1234/ })).toBeInTheDocument();
  const authLink = screen.getByRole('link', { name: /打开 GitHub 授权页/ });
  expect(authLink).toHaveAttribute('href', 'https://github.com/login/device');
  expect(authLink).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('status')).toHaveTextContent('等待浏览器授权确认…');
  expect(app.writes()[0]).toMatchObject({
    method: 'POST',
    path: '/api/github/device/start',
    body: { client_id: 'Ov23liCustom123' },
  });

  // Interval clamped to >= 5s: at 4s, no poll yet.
  await pass(4000);
  expect(polls).toBe(0);

  // At 5s: first poll returns pending.
  await pass(1000);
  await waitFor(() => expect(polls).toBe(1));
  expect(screen.getByText('ABCD-1234')).toBeInTheDocument();

  // At 10s: second poll returns connected -> stops polling and refreshes GET /api/github.
  await pass(5000);
  await screen.findByText('@bob');
  expect(screen.getByText('Bob Chen')).toBeInTheDocument();
  expect(screen.getByText('Device Flow')).toBeInTheDocument();
  expect(screen.queryByText('ABCD-1234')).toBeNull();

  const getCount = app.calls.filter((call) => call.method === 'GET' && call.path === '/api/github').length;
  expect(getCount).toBeGreaterThanOrEqual(2);

  // Advancing clock further must not poll again.
  await pass(15_000);
  expect(polls).toBe(2);
});

test('Device Flow cancel and unmount stop polling cleanly', async () => {
  holdClock();
  let polls = 0;

  const app = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/github') {
      return { connected: false, connection: null, client_id: 'Ov23liCancel' };
    }
    if (call.method === 'POST' && call.path === '/api/github/device/start') {
      return {
        session_id: 'dev-session-2',
        user_code: 'WXYZ-9876',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      };
    }
    if (call.method === 'POST' && call.path === '/api/github/device/poll') {
      polls += 1;
      return { state: 'pending' };
    }
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  await screen.findByLabelText('GitHub Token');
  await app.user.click(screen.getByText('Device Flow（设备码）'));
  await app.user.click(screen.getByRole('button', { name: '获取设备码' }));
  await screen.findByText('WXYZ-9876');

  await app.user.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByText('WXYZ-9876')).toBeNull();

  await pass(15_000);
  expect(polls).toBe(0);

  // Start again and unmount mid-wait: no poll fires after unmount.
  await app.user.click(screen.getByRole('button', { name: '获取设备码' }));
  await screen.findByText('WXYZ-9876');
  app.unmount();
  await pass(15_000);
  expect(polls).toBe(0);
});

test('connected GitHub card renders a local monogram badge instead of external avatar_url img', async () => {
  const withRemoteAvatar: GitHubConnection = {
    ...ALICE,
    avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
  };
  const { container } = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/github') {
      return { connected: true, connection: withRemoteAvatar, client_id: null };
    }
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  await screen.findByText('@alice');
  expect(container.querySelector('img')).toBeNull();
  const card = screen.getByLabelText('GitHub 连接状态');
  expect(card).toHaveTextContent('A');
});
