import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWeixinApi, WeixinApiError } from '../channels/weixin-api.ts';
import type { WeixinAuth } from '../channels/weixin-api.ts';

const AUTH: WeixinAuth = { token: 'bot-token-private', botId: 'bot-id', userId: 'owner-id', baseUrl: 'https://ilinkai.weixin.qq.com' };
function fake(body: unknown, status = 200) {
  const requests: { url: URL; init: RequestInit; headers: Headers; body: any }[] = [];
  const fetcher = (async (url, init) => {
    requests.push({ url: new URL(String(url)), init: init!, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, requests };
}

test('official QR self-bind fixture uses fixed bot_type=3, token list and unauthenticated common headers', async () => {
  const f = fake({ qrcode: 'private-qr', qrcode_img_content: 'https://example.test/display-only' });
  const api = createWeixinApi({ fetch: f.fetcher, version: '3.0.1/tycho-test' });
  assert.deepEqual(await api.qr(['recent-token']), { qrcode: 'private-qr', content: 'https://example.test/display-only' });
  const r = f.requests[0]!;
  assert.equal(r.url.href, 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.redirect, 'manual');
  assert.deepEqual(r.body, { local_token_list: ['recent-token'] });
  assert.equal(r.headers.get('AuthorizationType'), 'ilink_bot_token');
  assert.equal(r.headers.get('Authorization'), null);
  assert.equal(r.headers.get('iLink-App-Id'), 'bot');
  assert.equal(r.headers.get('iLink-App-ClientVersion'), '196609');
  const uin = Buffer.from(r.headers.get('X-WECHAT-UIN')!, 'base64').toString();
  assert.match(uin, /^\d+$/);
  assert.ok(Number(uin) <= 0xffffffff);
  assert.ok(r.init.signal);
});

test('QR status GET preserves official states and supports official redirect host plus encoded PIN', async () => {
  const response = { status: 'confirmed_but_need_verifycode', bot_token: 'new-private-token', ilink_bot_id: 'bot', ilink_user_id: 'owner', baseurl: 'https://route.weixin.qq.com', redirect_host: 'next.weixin.qq.com' };
  const f = fake(response), api = createWeixinApi({ fetch: f.fetcher });
  assert.deepEqual(await api.qrStatus('private/qr +', { host: 'route.weixin.qq.com', pin: '123456' }), response);
  const r = f.requests[0]!;
  assert.equal(r.init.method, 'GET');
  assert.equal(r.url.origin, 'https://route.weixin.qq.com');
  assert.equal(r.url.pathname, '/ilink/bot/get_qrcode_status');
  assert.equal(r.url.searchParams.get('qrcode'), 'private/qr +');
  assert.equal(r.url.searchParams.get('verify_code'), '123456');
  for (const key of ['Authorization', 'AuthorizationType', 'X-WECHAT-UIN']) assert.equal(r.headers.get(key), null);
  assert.equal(r.headers.get('iLink-App-Id'), 'bot');
});

test('getupdates and text send follow official fixtures with Tycho metadata and lossless uint64 message ids', async () => {
  const requests: { url: string; init: RequestInit; body: any }[] = [];
  const fetcher = (async (url, init) => {
    requests.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
    return new Response(String(url).includes('getupdates')
      ? '{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"owner","to_user_id":"bot","message_type":1,"message_state":2,"context_token":"private-context","item_list":[{"type":1,"text_item":{"text":"你好"}}]}],"get_updates_buf":"next-cursor","longpolling_timeout_ms":35000}'
      : '{"ret":0}', { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const api = createWeixinApi({ fetch: fetcher, version: '3.0.1/tycho-test' });
  const updates = await api.updates(AUTH, 'old-cursor');
  assert.equal(updates.cursor, 'next-cursor');
  assert.equal(updates.timeoutMs, 35000);
  assert.equal(updates.msgs[0]!.message_id, '18446744073709551615');
  assert.deepEqual(updates.msgs[0]!.item_list, [{ type: 1, text_item: { text: '你好' } }]);
  await api.send(AUTH, 'target', '你好', 'private-context', 'tycho-client-id');
  const base = { channel_version: '3.0.1/tycho-test', bot_agent: 'Tycho/1.0.0' };
  assert.deepEqual(requests[0]!.body, { get_updates_buf: 'old-cursor', base_info: base });
  assert.deepEqual(requests[1]!.body, { msg: { from_user_id: '', to_user_id: 'target', client_id: 'tycho-client-id', message_type: 2, message_state: 2,
    context_token: 'private-context', item_list: [{ type: 1, text_item: { text: '你好' } }] }, base_info: base });
  for (const r of requests) assert.equal(new Headers(r.init.headers).get('Authorization'), 'Bearer ' + AUTH.token);
});

test('business error -14 is typed and diagnostics never contain backend bodies or secrets', async () => {
  for (const body of [{ ret: -14, errmsg: 'bot-token-private private-context private-qr' }, { ret: 0, errcode: -14 }]) {
    const api = createWeixinApi({ fetch: fake(body).fetcher });
    await assert.rejects(api.updates(AUTH, ''), (error: unknown) => {
      assert.ok(error instanceof WeixinApiError);
      assert.equal(error.code, -14);
      assert.equal(error.kind, 'business');
      assert.equal(error.uncertain, false);
      assert.doesNotMatch(String(error), /bot-token-private|private-context|private-qr/);
      return true;
    });
  }
  const api = createWeixinApi({ fetch: fake({ ret: 5, errmsg: 'bot-token-private' }).fetcher });
  await assert.rejects(api.send(AUTH, 'target', 'hello', 'private-context', 'client'), /5/);
});

test('official HTTPS origin checks apply even with injected fetch and unsafe server hosts are rejected', async () => {
  const f = fake({ ret: 0 }), api = createWeixinApi({ fetch: f.fetcher });
  for (const baseUrl of ['http://ilinkai.weixin.qq.com', 'https://evil.test', 'https://weixin.qq.com.evil.test', 'https://evilweixin.qq.com',
    'https://user:pass@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:444', 'https://ilinkai.weixin.qq.com/a', 'https://ilinkai.weixin.qq.com?x=1', 'https://ilinkai.weixin.qq.com#x']) {
    await assert.rejects(api.updates({ ...AUTH, baseUrl }, ''), /官方|地址/);
    await assert.rejects(api.qrStatus('private-qr', { host: baseUrl }), /官方|地址/);
  }
  assert.equal(f.requests.length, 0);
  for (const response of [{ status: 'confirmed', baseurl: 'https://evil.test' }, { status: 'scaned_but_redirect', redirect_host: 'evil.test' }]) {
    await assert.rejects(createWeixinApi({ fetch: fake(response).fetcher }).qrStatus('private-qr'), /官方|地址/);
  }
});

test('transport rejects HTTP redirects, non-JSON, oversized and malformed responses without exposing credentials', async () => {
  const fetchers: typeof fetch[] = [
    fake({ error: AUTH.token }, 302).fetcher,
    fake({ error: AUTH.token }, 503).fetcher,
    (async () => new Response('not JSON ' + AUTH.token)) as typeof fetch,
    (async () => { throw new Error('network URL?token=' + AUTH.token); }) as typeof fetch,
    (async () => new Response('x', { headers: { 'Content-Length': String(2 * 1024 * 1024) } })) as typeof fetch,
    (async () => new Response('x'.repeat(2 * 1024 * 1024))) as typeof fetch,
    fake({ msgs: [null] }).fetcher,
  ];
  for (const fetcher of fetchers) await assert.rejects(createWeixinApi({ fetch: fetcher }).updates(AUTH, ''), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /bot-token-private/);
    return true;
  });
});

test('empty returned cursor preserves prior cursor and external abort cancels in-flight request safely', async () => {
  assert.deepEqual(await createWeixinApi({ fetch: fake({ ret: 0, msgs: [], get_updates_buf: '' }).fetcher }).updates(AUTH, 'prior'), { msgs: [], cursor: 'prior' });
  const aborter = new AbortController();
  let captured: AbortSignal | undefined;
  const api = createWeixinApi({ fetch: (async (_url, init) => {
    captured = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('secret private-context private-qr')), { once: true }));
  }) as typeof fetch });
  const request = api.updates(AUTH, '', aborter.signal);
  aborter.abort();
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /private-context|private-qr/);
    return true;
  });
  assert.equal(captured?.aborted, true);
});

test('every HTTP operation has a bounded internal timeout even when fetch ignores abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = createWeixinApi({ fetch: (() => new Promise(() => {})) as typeof fetch });
  for (const [start, timeout] of [
    [() => api.qr(), 15000],
    [() => api.qrStatus('private-qr'), 35000],
    [() => api.updates(AUTH, ''), 40000],
    [() => api.send(AUTH, 'target', 'hello', 'context', 'client'), 15000],
  ] as const) {
    const pending = start();
    t.mock.timers.tick(timeout);
    await assert.rejects(pending, /超时/);
  }
});

test('external cancellation also bounds a stalled response body and releases its reader', async () => {
  const aborter = new AbortController();
  let canceled = false;
  const body = new ReadableStream({ cancel() { canceled = true; } });
  const api = createWeixinApi({ fetch: (async () => new Response(body)) as typeof fetch });
  const pending = api.updates(AUTH, '', aborter.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  aborter.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(canceled, true);
});

test('a synchronous abort during fetch never leaves a credential-bearing rejection unhandled', async () => {
  const aborter = new AbortController();
  const api = createWeixinApi({ fetch: (() => {
    aborter.abort();
    return Promise.reject(new Error('private-transport-credential'));
  }) as typeof fetch });
  await assert.rejects(api.updates(AUTH, '', aborter.signal), /取消/);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('send uncertainty separates explicit business refusal from post-submission transport or protocol failure', async () => {
  for (const fetcher of [fake({ ret: 0 }, 503).fetcher, fake({ ret: 0 }, 401).fetcher,
    (async () => { throw new Error('private-context'); }) as typeof fetch,
    (async () => new Response('not json private-context')) as typeof fetch,
    (async () => new Response('')) as typeof fetch]) {
    await assert.rejects(createWeixinApi({ fetch: fetcher }).send(AUTH, 'target', 'text', 'context', 'client'), (error: unknown) => {
      assert.ok(error instanceof WeixinApiError);
      assert.equal(error.uncertain, true);
      assert.ok(error.kind === 'transport' || error.kind === 'protocol');
      assert.doesNotMatch(error.message, /private-context/);
      return true;
    });
  }
  await assert.rejects(createWeixinApi({ fetch: fake({ ret: 7 }).fetcher }).send(AUTH, 'target', 'text', 'context', 'client'), (error: unknown) => {
    assert.ok(error instanceof WeixinApiError);
    assert.equal(error.uncertain, false);
    assert.equal(error.kind, 'business');
    assert.equal(error.code, 7);
    return true;
  });
  const f = fake({ ret: 0 }), api = createWeixinApi({ fetch: f.fetcher });
  for (const auth of [{ ...AUTH, token: '' }, { ...AUTH, baseUrl: 'https://evil.test' }]) {
    await assert.rejects(api.send(auth, 'target', 'text', 'context', 'client'), (error: unknown) => {
      assert.ok(error instanceof WeixinApiError);
      assert.equal(error.uncertain, false);
      return true;
    });
  }
  assert.equal(f.requests.length, 0);
});

test('official send acceptance permits message_id-only and omitted ret without inventing a read receipt', async () => {
  // The live server returned HTTP 200 with only message_id (34 bytes). The
  // official main and v2.4.10 sendMessage also accept a valid object with no ret.
  for (const body of ['{"message_id":18446744073709551615}', '{}', '{"ret":0}']) {
    const api = createWeixinApi({ fetch: (async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch });
    await assert.doesNotReject(api.send(AUTH, 'target', 'text', 'context', 'client'));
  }
  for (const body of [{ message_id: '123', ret: -14 }, { message_id: '123', ret: -2 }, { message_id: '123', ret: 0, errcode: 7 }]) {
    const api = createWeixinApi({ fetch: fake(body).fetcher });
    await assert.rejects(api.send(AUTH, 'target', 'text', 'context', 'client'), (error: unknown) => {
      assert.ok(error instanceof WeixinApiError);
      assert.equal(error.kind, 'business');
      assert.equal(error.uncertain, false);
      assert.equal(error.code, body.errcode ?? body.ret);
      if (body.ret === -2) assert.match(error.message, /回复窗口已过期.*-2/);
      return true;
    });
  }
});
