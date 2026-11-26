import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWeixinApi, WeixinApiError } from '../channels/weixin-api.ts';
import { createWeixin } from '../service/weixin.ts';
import { fixture, USER } from './helpers.ts';

const message = (id: string, from = 'owner') => ({ message_id: id, from_user_id: from, message_type: 1, message_state: 2,
  context_token: 'synthetic-context', item_list: [{ type: 1, text_item: { text: '我想换个项目' } }] });

function setup(t: Parameters<typeof fixture>[0], send: ReturnType<typeof createWeixinApi>['send'], polling = false) {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'weixin']);
  f.ledger.setWhitelist({ weixin: ['owner'] }, USER);
  let user = 'owner';
  let deliver: ((result: { msgs: ReturnType<typeof message>[]; cursor: string }) => void) | undefined;
  let onReceived: (id: string) => void = () => {};
  const api = {
    qr: async () => ({ qrcode: 'synthetic-qr', content: 'synthetic-display-content' }),
    qrStatus: async () => ({ status: 'confirmed', bot_token: 'synthetic-private-token', ilink_bot_id: 'bot', ilink_user_id: user, baseurl: 'https://ilinkai.weixin.qq.com' }),
    updates: async () => new Promise<{ msgs: ReturnType<typeof message>[]; cursor: string }>((resolve) => { deliver = resolve; }),
    send,
  };
  const file = join(f.dir, 'weixin-race-journal');
  const wx = createWeixin({ file, ledger: f.ledger, api, poll: polling, onMessage(id) { onReceived(id); }, onChanged() {} });
  t.after(() => wx.stop());
  async function connect(id: string, newOwner = user) {
    user = newOwner;
    await wx.login(); await wx.checkLogin();
    await wx.receive([message(id, user)], 'cursor-' + id);
    return wx.ownerTarget()!.chatid;
  }
  return { f, wx, file, connect, deliver: (result: { msgs: ReturnType<typeof message>[]; cursor: string }) => { assert.ok(deliver); deliver(result); },
    hasPoll: () => Boolean(deliver), onReceived: (handler: (id: string) => void) => { onReceived = handler; } };
}

test('uncertain send cannot be retried by disconnecting and reconnecting the same bot and owner', async (t) => {
  let attempts = 0;
  const { wx, connect } = setup(t, async () => { if (++attempts === 1) throw new WeixinApiError(0, 'network', { kind: 'transport', uncertain: true }); });
  const target = await connect('first');
  await assert.rejects(wx.send(target, 'synthetic notification', 'same-outbox'), /未确认/);
  wx.disconnect();
  await connect('reconnected');
  await assert.rejects(wx.send(target, 'synthetic notification', 'same-outbox'), /未确认/);
  assert.equal(attempts, 1);
});

test('changing owner does not erase prior uncertainty and does not block the other owner same logical key', async (t) => {
  let attempts = 0;
  const { wx, connect } = setup(t, async () => { if (++attempts === 1) throw new WeixinApiError(0, 'network', { kind: 'transport', uncertain: true }); });
  const firstTarget = await connect('first');
  await assert.rejects(wx.send(firstTarget, 'synthetic notification', 'same-outbox'), /未确认/);
  wx.disconnect();
  const secondTarget = await connect('second', 'other-owner');
  await wx.send(secondTarget, 'synthetic notification', 'same-outbox');
  wx.disconnect();
  await connect('back', 'owner');
  await assert.rejects(wx.send(firstTarget, 'synthetic notification', 'same-outbox'), /未确认/);
  assert.equal(attempts, 2);
});

test('an earlier successful poll cannot change a send-expired session back to connected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { wx, file, connect, hasPoll, deliver } = setup(t, async () => { throw new WeixinApiError(-14, 'expired'); }, true);
  const target = await connect('first');
  t.mock.timers.tick(0);
  assert.equal(hasPoll(), true);
  await assert.rejects(wx.send(target, 'synthetic notification', 'expiry-race'));
  assert.equal(wx.status().state, 'expired');
  deliver({ msgs: [], cursor: 'earlier-success' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(wx.status().state, 'expired');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).expired, true);
});

test('a send rejection while a polled message is being dispatched cannot be overwritten after receive yields', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = setup(t, async () => { throw new WeixinApiError(-14, 'expired'); }, true);
  const target = await env.connect('first');
  env.f.ledger.frontSelect({ channel: 'weixin', bot: 'weixin:bot', thread: target, actor: 'owner', projectId: env.f.projectId });
  env.onReceived(() => { void env.wx.send(target, 'synthetic acknowledgement', 'during-dispatch').catch(() => {}); });
  t.mock.timers.tick(0);
  assert.equal(env.hasPoll(), true);
  const incoming = message('dispatch-message');
  incoming.item_list[0]!.text_item.text = '普通请求';
  env.deliver({ msgs: [incoming], cursor: 'dispatch-cursor' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(env.wx.status().state, 'expired');
  assert.equal(JSON.parse(readFileSync(env.file, 'utf8')).expired, true);
});
