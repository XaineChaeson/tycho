import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { PassphraseSetup, type PassphraseStatus } from './passphrase-setup';

interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
}

function setup(handle: (call: RecordedCall) => unknown | Promise<unknown>) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const call: RecordedCall = {
      path,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
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
      <PassphraseSetup />
    </QueryClientProvider>,
  );
  return {
    ...view,
    calls,
    user: userEvent.setup(),
    writes: () => calls.filter(({ method }) => method !== 'GET'),
  };
}

test('enabling passphrase validates length and mismatch locally before sending PUT, then clears inputs and shows success', async () => {
  let status: PassphraseStatus = { enabled: false };

  const app = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/auth/passphrase') return status;
    if (call.method === 'PUT' && call.path === '/api/auth/passphrase') {
      status = { enabled: true };
      return status;
    }
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  const input = await screen.findByLabelText('主人口令');
  const confirm = screen.getByLabelText('确认口令');
  const submit = screen.getByRole('button', { name: '开启口令登录' });

  expect(screen.getByText('主人口令直登')).toBeInTheDocument();
  expect(screen.getByText('未开启')).toBeInTheDocument();
  expect(input).toHaveAttribute('type', 'password');
  expect(confirm).toHaveAttribute('type', 'password');

  // Too short (< 8 chars): blocked locally, no PUT sent.
  await app.user.type(input, '1234567');
  await app.user.type(confirm, '1234567');
  await app.user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent(/至少需要 8 位/);
  expect(app.writes()).toEqual([]);

  // Mismatch: blocked locally, no PUT sent.
  await app.user.clear(input);
  await app.user.clear(confirm);
  await app.user.type(input, '我的 主人口令 2026');
  await app.user.type(confirm, '我的 主人口令 2025');
  await app.user.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent(/两次输入的口令不一致/);
  expect(app.writes()).toEqual([]);

  // Valid passphrase with spaces and Chinese: sent verbatim without trimming.
  await app.user.clear(confirm);
  await app.user.type(confirm, '我的 主人口令 2026');
  await app.user.click(submit);

  await screen.findByText('已开启');
  expect(screen.getByRole('status')).toHaveTextContent('主人口令已保存');
  expect(app.writes()).toEqual([
    {
      method: 'PUT',
      path: '/api/auth/passphrase',
      body: { passphrase: '我的 主人口令 2026' },
    },
  ]);
  expect(document.body.innerHTML).not.toContain('我的 主人口令 2026');
});

test('changing passphrase validates inline, supports cancel, and saves new passphrase', async () => {
  const status: PassphraseStatus = { enabled: true };

  const app = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/auth/passphrase') return status;
    if (call.method === 'PUT' && call.path === '/api/auth/passphrase') return { enabled: true };
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  await screen.findByText('已开启');
  expect(screen.queryByLabelText('新口令')).toBeNull();

  // Open change form and cancel.
  await app.user.click(screen.getByRole('button', { name: '更换口令' }));
  expect(screen.getByLabelText('新口令')).toBeInTheDocument();
  expect(screen.getByLabelText('确认新口令')).toBeInTheDocument();
  await app.user.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByLabelText('新口令')).toBeNull();
  expect(app.writes()).toEqual([]);

  // Re-open, trigger mismatch error, then submit valid passphrase.
  await app.user.click(screen.getByRole('button', { name: '更换口令' }));
  const nextInput = screen.getByLabelText('新口令');
  const nextConfirm = screen.getByLabelText('确认新口令');
  await app.user.type(nextInput, 'new-passphrase-1');
  await app.user.type(nextConfirm, 'new-passphrase-2');
  await app.user.click(screen.getByRole('button', { name: '保存新口令' }));
  expect(screen.getByRole('alert')).toHaveTextContent(/两次输入的口令不一致/);
  expect(app.writes()).toEqual([]);

  await app.user.clear(nextConfirm);
  await app.user.type(nextConfirm, 'new-passphrase-1');
  await app.user.click(screen.getByRole('button', { name: '保存新口令' }));

  await waitFor(() => expect(screen.queryByLabelText('新口令')).toBeNull());
  expect(screen.getByRole('status')).toHaveTextContent('主人口令已保存');
  expect(app.writes()).toEqual([
    {
      method: 'PUT',
      path: '/api/auth/passphrase',
      body: { passphrase: 'new-passphrase-1' },
    },
  ]);
  expect(document.body.innerHTML).not.toContain('new-passphrase-1');
});

test('disabling passphrase requires confirmation dialog and calls DELETE', async () => {
  let status: PassphraseStatus = { enabled: true };

  const app = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/auth/passphrase') return status;
    if (call.method === 'DELETE' && call.path === '/api/auth/passphrase') {
      status = { enabled: false };
      return status;
    }
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  await screen.findByText('已开启');

  // Open Confirm dialog and cancel first.
  await app.user.click(screen.getByRole('button', { name: '关闭口令登录' }));
  const firstDialog = await screen.findByRole('alertdialog');
  await app.user.click(within(firstDialog).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(app.writes()).toEqual([]);

  // Open again and confirm disable.
  await app.user.click(screen.getByRole('button', { name: '关闭口令登录' }));
  const dialog = await screen.findByRole('alertdialog');
  await app.user.click(within(dialog).getByRole('button', { name: '确认关闭' }));

  await screen.findByText('未开启');
  expect(screen.getByRole('status')).toHaveTextContent('已关闭口令登录');
  expect(screen.getByLabelText('主人口令')).toHaveValue('');
  expect(screen.getByLabelText('确认口令')).toHaveValue('');
  expect(app.writes()).toEqual([
    {
      method: 'DELETE',
      path: '/api/auth/passphrase',
      body: undefined,
    },
  ]);
});

test('server failure on PUT shows alert and clears password inputs immediately', async () => {
  const app = setup((call) => {
    if (call.method === 'GET' && call.path === '/api/auth/passphrase') return { enabled: false };
    if (call.method === 'PUT' && call.path === '/api/auth/passphrase') {
      throw new Error('写入主人口令失败');
    }
    throw new Error(`未处理请求：${call.method} ${call.path}`);
  });

  const input = await screen.findByLabelText('主人口令');
  const confirm = screen.getByLabelText('确认口令');
  await app.user.type(input, 'secret-passphrase-99');
  await app.user.type(confirm, 'secret-passphrase-99');
  await app.user.click(screen.getByRole('button', { name: '开启口令登录' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('写入主人口令失败');
  expect(input).toHaveValue('');
  expect(confirm).toHaveValue('');
  expect(document.body.innerHTML).not.toContain('secret-passphrase-99');
});
