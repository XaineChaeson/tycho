// QR/PIN and connection changes belong to the signed-in owner, never to a Router,
// node bearer, another web origin, or a write attempted while the ledger is held.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DeliveryUncertainError } from '../service/outbox.ts';
import { createWeixin } from '../service/weixin.ts';
import { consoleApp, TOOL_TOKEN } from './console-helpers.ts';
import type { Weixin } from '../service/weixin.ts';

test('Weixin control routes require the normal owner cookie and same origin before acting', async t => {
  let logins = 0, pins = 0, disconnects = 0;
  const service = {
    status: () => ({ state: 'waiting', qr: 'private-qr-value' }),
    async login() { logins++; return { state: 'waiting', qr: 'private-qr-value' }; },
    pin() { pins++; return { state: 'waiting', qr: 'private-qr-value' }; },
    disconnect() { disconnects++; return { state: 'disconnected' }; },
  } as unknown as Weixin;
  const { get, send, cookie, url } = await consoleApp(t, { weixin: service });
  for (const [method, path, body] of [['GET', '/api/weixin', undefined], ['POST', '/api/weixin/login', {}], ['POST', '/api/weixin/pin', { pin: '123456' }], ['DELETE', '/api/weixin', undefined]] as const) {
    assert.equal((await send(method, path, body, { Origin: url })).status, 401);
    assert.equal((await send(method, path, body, { Origin: url, Authorization: `Bearer ${TOOL_TOKEN}` })).status, 401);
    if (method !== 'GET') assert.equal((await send(method, path, body, { Cookie: cookie, Origin: 'https://elsewhere.test' })).status, 403);
  }
  assert.deepEqual([logins, pins, disconnects], [0, 0, 0]);
  assert.equal((await get('/api/weixin')).status, 200);
  assert.equal((await send('POST', '/api/weixin/login', {})).status, 200);
  assert.equal((await send('POST', '/api/weixin/pin', { pin: '123456' })).status, 200);
  assert.equal((await send('DELETE', '/api/weixin')).status, 200);
  assert.deepEqual([logins, pins, disconnects], [1, 1, 1]);
});

test('owner confirms receipt without sending; anonymous and Router cannot confirm or hide failures', async t => {
  const { f, send, cookie, url } = await consoleApp(t);
  const row = f.ledger.outbox.enqueue('private', 'markdown', {});
  assert.throws(() => f.ledger.outbox.confirmReceived(row.id, { actor: 'console' }), /停止/);
  f.ledger.outbox.markUncertain(row.id, '发送结果未确认');
  const path = `/api/outbox/${row.id}/confirm`;
  assert.equal((await send('POST', path, {}, { Origin: url })).status, 401);
  assert.equal((await send('POST', path, {}, { Origin: url, Authorization: `Bearer ${TOOL_TOKEN}` })).status, 401);
  assert.equal((await send('POST', path, {}, { Cookie: cookie, Origin: 'https://elsewhere.test' })).status, 403);
  assert.equal(f.ledger.outbox.listGivenUp().length, 1);
  assert.equal((await send('POST', path, {})).status, 200);
  assert.equal(f.ledger.outbox.listGivenUp().length, 0);
  assert.equal((await send('POST', path, {})).status, 200, 'repeating the same owner confirmation is harmless');
});

test('POST /api/outbox/:id/force-resend delivers after an uncertain Weixin send while normal retry stays blocked', async t => {
  const { f, send, cookie, url } = await consoleApp(t);
  f.ledger.setChannels(['console', 'weixin']);
  let failSend = true;
  let attempts = 0;
  const sentClientIds: string[] = [];
  const api = {
    qr: async () => ({ qrcode: 'private-qr', content: 'synthetic-qr' }),
    qrStatus: async () => ({ status: 'confirmed', bot_token: 'private-token', ilink_bot_id: 'bot-a', ilink_user_id: 'owner', baseurl: 'https://ilinkai.weixin.qq.com' }),
    updates: async () => ({ msgs: [], cursor: '' }),
    send: async (_auth: unknown, _to: string, _text: string, _context: string, clientId: string) => {
      attempts++;
      sentClientIds.push(clientId);
      if (failSend) throw new Error('synthetic connection lost after submission');
    },
  };
  const wx = createWeixin({ file: join(f.dir, 'weixin-force-resend.json'), ledger: f.ledger, api, poll: false, onMessage() {}, onChanged() {} });
  t.after(() => wx.stop());
  await wx.login();
  await wx.checkLogin();
  await wx.receive([{ message_id: 'ctx-1', from_user_id: 'owner', message_type: 1, message_state: 2, context_token: 'ctx-tok-1', item_list: [{ type: 1, text_item: { text: '我想换个项目' } }] }], 'cur-1');

  const target = wx.ownerTarget()!;
  const row = f.ledger.outbox.enqueue('weixin', 'markdown', { target, content: '重要通知' });
  const outgoing = { target, body: { msgtype: 'markdown', markdown: { content: '重要通知' } } };

  // First attempt fails with uncertain outcome -> marked given_up.
  await assert.rejects(wx.sendOutgoing(row, outgoing), DeliveryUncertainError);
  f.ledger.outbox.markUncertain(row.id, '微信外发结果未确认');
  assert.equal(attempts, 1);

  // Normal POST /api/outbox/:id/retry MUST be refused for uncertain deliveries (closes both
  // Weixin and WeCom duplicate-send bypasses); only confirm or force-resend may proceed.
  const normalRetryRes = await send('POST', `/api/outbox/${row.id}/retry`, {});
  assert.equal(normalRetryRes.status, 400);
  assert.match(await normalRetryRes.text(), /未确认/);
  assert.equal(f.ledger.outbox.takeDue().find((r) => r.id === row.id), undefined);
  assert.equal(attempts, 1);
  failSend = false;

  // Force-resend requires owner cookie and same-origin CSRF.
  const forcePath = `/api/outbox/${row.id}/force-resend`;
  assert.equal((await send('POST', forcePath, {}, { Origin: url })).status, 401);
  assert.equal((await send('POST', forcePath, {}, { Origin: url, Authorization: `Bearer ${TOOL_TOKEN}` })).status, 401);
  assert.equal((await send('POST', forcePath, {}, { Cookie: cookie, Origin: 'https://elsewhere.test' })).status, 403);

  // Explicit owner force-resend advances force_resend_seq and delivers with a fresh idempotency key.
  const res = await send('POST', forcePath, {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { resent: true, force_resend_seq: 1 });

  const afterForceResend = f.ledger.outbox.takeDue().find((r) => r.id === row.id)!;
  assert.ok(afterForceResend);
  assert.equal(JSON.parse(afterForceResend.payload_json).force_resend_seq, 1);
  await wx.sendOutgoing(afterForceResend, outgoing);
  f.ledger.outbox.markSent(row.id);

  assert.equal(attempts, 2);
  assert.notEqual(sentClientIds[0], sentClientIds[1]);
  assert.equal(f.ledger.outbox.listGivenUp().length, 0);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'outbox.force_resend'`).length, 1);
});
