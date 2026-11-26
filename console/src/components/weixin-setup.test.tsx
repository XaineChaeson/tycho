// Guards manual-only login, local QR encoding, serialized polling, PIN submission,
// stale responses, and a disconnected account that keeps neither its QR nor identity.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { deferred, holdClock, pass } from '@/test/harness';
import { WeixinSetup } from './weixin-setup';

const encode = vi.hoisted(() => { vi.resetModules(); return vi.fn(); });
vi.mock('qrcode', () => ({ default: { toDataURL: encode } }));

type Status = { state: 'disconnected' | 'waiting' | 'scanned' | 'pin_required' | 'connected' | 'expired' | 'error'; qr?: string; bot_id?: string; user_id?: string; error?: string };
type Call = { path: string; method: string; body: unknown; signal?: AbortSignal | null };
const PNG = 'data:image/png;base64,UE5H';

beforeEach(() => { encode.mockReset().mockResolvedValue(PNG); });

function setup(handle: (call: Call) => Status | Promise<Status>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const call = { path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal };
    calls.push(call);
    try {
      const body = await handle(call);
      return { ok: true, status: 200, json: async () => body };
    } catch (error) {
      return { ok: false, status: 500, json: async () => ({ error: (error as Error).message }) };
    }
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><WeixinSetup /></QueryClientProvider>);
  return { ...view, calls, user: userEvent.setup(), writes: () => calls.filter(({ method }) => method !== 'GET') };
}

test('login is explicit and duplicate clicks create one request; raw QR links are locally encoded', async () => {
  const answer = deferred<Status>();
  const app = setup(({ method }) => method === 'GET' ? { state: 'disconnected' } : answer.promise);
  await screen.findByText('未连接微信');
  expect(app.writes()).toEqual([]);
  const button = screen.getByRole('button', { name: '连接微信' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  await waitFor(() => expect(button).toBeDisabled());
  expect(app.writes()).toHaveLength(1);
  expect(app.writes()[0]).toMatchObject({ path: '/api/weixin/login', method: 'POST' });
  await act(async () => { answer.resolve({ state: 'waiting', qr: 'https://official.example/qr-raw-link' }); });
  const image = await screen.findByRole('img', { name: '微信登录二维码' });
  expect(encode).toHaveBeenCalledWith('https://official.example/qr-raw-link', expect.any(Object));
  expect(image).toHaveAttribute('src', PNG);
  expect(image).not.toHaveAttribute('src', 'https://official.example/qr-raw-link');
});

test('polls every two seconds without overlapping a pending read; unmount aborts it and stops polling', async () => {
  holdClock();
  const answer = deferred<Status>();
  let reads = 0;
  const app = setup(() => ++reads === 1 ? { state: 'waiting', qr: 'synthetic-qr' } : answer.promise);
  await screen.findByRole('img', { name: '微信登录二维码' });
  await pass(2000);
  expect(reads).toBe(2);
  await pass(6000);
  expect(reads).toBe(2);
  expect(app.writes()).toEqual([]);
  const pending = app.calls[1]!;
  app.unmount();
  expect(pending.signal?.aborted).toBe(true);
  await act(async () => { answer.resolve({ state: 'waiting', qr: 'late-qr' }); });
  await pass(6000);
  expect(reads).toBe(2);
  expect(encode).not.toHaveBeenCalledWith('late-qr', expect.anything());
});

test('a local QR encoding failure gives a recovery action without loading a remote image', async () => {
  encode.mockRejectedValueOnce(new Error('unsupported content'));
  const app = setup(() => ({ state: 'waiting', qr: 'https://official.example/raw' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('二维码生成失败，请重新获取二维码。');
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByRole('button', { name: '重新获取二维码' })).toBeEnabled();
  expect(app.writes()).toEqual([]);
});

test('PIN confirmation preserves leading zeroes and hides the QR and PIN after connecting', async () => {
  const app = setup(({ method, path, body }) => {
    if (method === 'GET') return { state: 'pin_required', qr: 'pin-qr' };
    expect(path).toBe('/api/weixin/pin');
    expect(body).toEqual({ pin: '0123' });
    return { state: 'connected', bot_id: 'bot-own', user_id: 'wechat-owner', qr: 'must-not-display' };
  });
  const pin = await screen.findByRole('textbox', { name: '手机微信显示的数字' });
  await app.user.type(pin, '0123');
  await app.user.click(screen.getByRole('button', { name: '确认数字' }));
  await screen.findByText('微信已连接');
  expect(screen.getByText('bot-own')).toBeInTheDocument();
  expect(screen.getByText('wechat-owner')).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(encode).not.toHaveBeenCalledWith('must-not-display', expect.anything());
});

test('scanned and expired states explain the next step; expiry hides a stale QR without automatic login', async () => {
  holdClock();
  let reads = 0;
  const app = setup(() => ++reads === 1 ? { state: 'scanned', qr: 'scanned-qr' } : { state: 'expired', qr: 'expired-qr' });
  await screen.findByText('已扫码，请在手机微信确认连接');
  await pass(2000);
  await screen.findByText('二维码已过期，请重新获取');
  expect(screen.queryByRole('img')).toBeNull();
  await pass(6000);
  expect(app.writes()).toEqual([]);
  expect(reads).toBe(2);
});

test('late QR generation cannot redisplay a QR after the account connects', async () => {
  holdClock();
  const encoded = deferred<string>();
  encode.mockReturnValue(encoded.promise);
  let reads = 0;
  setup(() => ++reads === 1 ? { state: 'waiting', qr: 'old-qr' } : { state: 'connected', bot_id: 'connected-bot' });
  await screen.findByText('请用手机微信扫描二维码');
  await pass(2000);
  await screen.findByText('微信已连接');
  await act(async () => { encoded.resolve(PNG); });
  expect(screen.queryByRole('img')).toBeNull();
});

test('a new login cancels a pending poll and its late answer cannot replace the new QR', async () => {
  holdClock();
  const old = deferred<Status>();
  let reads = 0;
  const app = setup(({ method }) => method === 'POST' ? { state: 'waiting', qr: 'new-qr' }
    : ++reads === 1 ? { state: 'waiting', qr: 'old-qr' } : old.promise);
  await screen.findByRole('img', { name: '微信登录二维码' });
  await pass(2000);
  expect(reads).toBe(2);
  fireEvent.click(screen.getByRole('button', { name: '重新获取二维码' }));
  await waitFor(() => expect(encode).toHaveBeenCalledWith('new-qr', expect.anything()));
  expect(app.calls[1]!.signal?.aborted).toBe(true);
  await act(async () => { old.resolve({ state: 'connected', bot_id: 'stale-account' }); });
  await pass();
  expect(screen.getByText('请用手机微信扫描二维码')).toBeInTheDocument();
  expect(screen.queryByText('stale-account')).toBeNull();
  expect(app.writes()).toHaveLength(1);
});

test('API read and write failures remain actionable and never retry login automatically', async () => {
  holdClock();
  let brokenRead = true;
  const app = setup(({ method }) => {
    if (method === 'GET') {
      if (brokenRead) throw new Error('暂时读不到微信状态');
      return { state: 'disconnected' };
    }
    throw new Error('获取连接码失败');
  });
  await screen.findByText('暂时读不到微信状态');
  brokenRead = false;
  fireEvent.click(screen.getByRole('button', { name: '重试读取' }));
  await screen.findByText('未连接微信');
  fireEvent.click(screen.getByRole('button', { name: '连接微信' }));
  await screen.findByText('获取连接码失败');
  await pass(6000);
  expect(app.writes()).toHaveLength(1);
});

test('connected account can reconnect or disconnect; disconnect clears identities and old QR', async () => {
  const app = setup(({ method }) => method === 'GET'
    ? { state: 'connected', bot_id: 'old-bot', user_id: 'old-user' }
    : method === 'POST' ? { state: 'waiting', qr: 'replacement-qr' }
      : { state: 'disconnected', qr: 'must-not-display' });
  await screen.findByText('old-bot');
  expect(screen.getByRole('button', { name: '断开连接' })).toBeInTheDocument();
  await app.user.click(screen.getByRole('button', { name: '重新登录' }));
  await screen.findByRole('img', { name: '微信登录二维码' });
  await app.user.click(screen.getByRole('button', { name: '取消连接' }));
  await screen.findByText('未连接微信');
  expect(screen.queryByText('old-bot')).toBeNull();
  expect(screen.queryByText('old-user')).toBeNull();
  expect(screen.queryByRole('img')).toBeNull();
  expect(app.writes().map(({ method, path }) => [method, path])).toEqual([
    ['POST', '/api/weixin/login'], ['DELETE', '/api/weixin'],
  ]);
});
