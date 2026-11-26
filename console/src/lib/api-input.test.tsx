// A successful HTTP status with HTML or a broken JSON body is not an empty API
// object: keeping it as data crashes Home and hides the actual failed read.
import { act, render, screen } from '@testing-library/react';
import { Component, StrictMode, type ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { App } from '@/app';
import { api, ApiError, session } from '@/lib/api';
import { serve, sources } from '@/test/harness';

class RenderFailure extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <p>{`ROOT_RENDER_ERROR: ${this.state.error}`}</p> : this.props.children; }
}

test('a malformed successful response rejects at the API entrance instead of becoming cached page data', async () => {
  for (const body of ['<!doctype html><title>proxy page</title>', '{"counts":', '']) {
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }));
    await expect(api('/api/overview')).rejects.toMatchObject({ name: 'Error', status: 200, message: expect.stringMatching(/服务返回的数据无法读取/) });
  }
});

test('a malformed overview response stays a visible read error inside the console, never a root render failure', async () => {
  window.location.hash = '#/';
  serve();
  const normal = globalThis.fetch;
  let broken = true;
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => broken && path === '/api/overview'
    ? Promise.resolve(new Response('<!doctype html><title>proxy page</title>', { status: 200 }))
    : normal(path, init));
  render(<StrictMode><RenderFailure><App /></RenderFailure></StrictMode>);
  expect(await screen.findByText(/服务返回的数据无法读取/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: '总览' })).toBeInTheDocument();
  expect(screen.queryByText(/ROOT_RENDER_ERROR/)).toBeNull();
  const header = screen.getByRole('heading', { level: 1, name: '总览' });
  broken = false;
  await act(async () => { for (const source of sources) source.emit('changed', {}); });
  expect(await screen.findByRole('article')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: '总览' })).toBe(header);
  expect(screen.queryByText(/服务返回的数据无法读取|ROOT_RENDER_ERROR/)).toBeNull();
});

test('an HTTP refusal still reports the server reason, and non-JSON errors keep their HTTP status', async () => {
  vi.stubGlobal('fetch', async () => new Response('{"error":"账本不可用"}', { status: 503 }));
  await expect(api('/api/overview')).rejects.toMatchObject({ status: 503, message: '账本不可用' });
  vi.stubGlobal('fetch', async () => new Response('<html>private proxy details</html>', { status: 502 }));
  await expect(api('/api/overview')).rejects.toBeInstanceOf(ApiError);
  await expect(api('/api/overview')).rejects.toMatchObject({ status: 502, message: '请求失败（502）' });
});


test('a legal empty 204 command acknowledgement keeps its existing empty-object result', async () => {
  vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
  await expect(api('/api/command', { method: 'POST' })).resolves.toEqual({});
});

test('valid null JSON remains null rather than being mistaken for a parse failure', async () => {
  vi.stubGlobal('fetch', async () => new Response('null', { status: 200 }));
  await expect(api('/api/value')).resolves.toBeNull();
});

test('401 still redirects once without trying to parse its possibly non-JSON response', async () => {
  vi.stubGlobal('fetch', async () => new Response('<html>private login page</html>', { status: 401 }));
  await expect(api('/api/overview')).rejects.toMatchObject({ status: 401, message: '需要登录' });
  expect(session.toLogin).toHaveBeenCalledTimes(1);
});

test('an error with null JSON uses its HTTP status rather than throwing while reading error.message', async () => {
  vi.stubGlobal('fetch', async () => new Response('null', { status: 502 }));
  await expect(api('/api/overview')).rejects.toMatchObject({ status: 502, message: '请求失败（502）', body: {} });
});
