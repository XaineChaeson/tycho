// Guards against lost poll batches, another peer/account receiving owner authority,
// stale project-menu numbers changing a normal chat, and blind retries of uncertain sends.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createWeixin } from '../service/weixin.ts';
import { fixture, USER } from './helpers.ts';

const auth = { token: 'private-test-token', botId: 'bot-a', userId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' };
function setup(t: Parameters<typeof fixture>[0], send = async (..._args: unknown[]) => {}) {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'weixin']);
  f.ledger.setWhitelist({ weixin: ['owner'] }, USER);
  const kicked: string[] = [];
  const api = {
    qr: async () => ({ qrcode: 'private-qr', content: 'https://example.test/qr' }),
    qrStatus: async () => ({ status: 'confirmed', bot_token: auth.token, ilink_bot_id: auth.botId, ilink_user_id: auth.userId, baseurl: auth.baseUrl }),
    updates: async () => { throw new Error('not polling in this test'); }, send,
  };
  const file = join(f.dir, 'weixin-private');
  const make = () => createWeixin({ file, ledger: f.ledger, api, onMessage: id => kicked.push(id), onChanged() {}, poll: false });
  const wx = make();
  t.after(() => wx.stop());
  return { f, wx, make, kicked, file };
}
const message = (id: string, text: string, from = 'owner') => ({ message_id: id, from_user_id: from, message_type: 1, message_state: 2, context_token: `ctx-${id}`, item_list: [{ type: 1, text_item: { text } }] });

test('QR credentials stay private; owner conversation, menu selection and binding survive reload', async t => {
  const { f, wx, make, kicked } = setup(t);
  await wx.login();
  await wx.checkLogin();
  assert.equal(wx.status().state, 'connected');
  assert.equal(JSON.stringify(wx.status()).includes(auth.token), false);
  await wx.receive([message('1', '我想换个项目')], 'cursor-1');
  const current = make();
  t.after(() => current.stop());
  await current.receive([message('2', '1')], 'cursor-2');
  const target = current.ownerTarget()!;
  assert.equal(f.ledger.frontCurrent(`weixin:${auth.botId}`, target.chatid, 'owner'), f.projectId);
  await current.receive([message('3', '固定当前项目')], 'cursor-3');
  assert.equal(f.ledger.frontFixed(`weixin:${auth.botId}`, target.chatid), f.projectId);
  await current.receive([message('4', '你好')], 'cursor-4');
  assert.equal(kicked.length, 1);
  assert.equal(f.ledger.getMessage(kicked[0]!).text, '你好');
  await current.receive([message('4', '你好')], 'cursor-4');
  assert.equal(kicked.length, 1);
  await current.receive([message('5', '解绑')], 'cursor-5');
  assert.equal(f.ledger.frontFixed(`weixin:${auth.botId}`, target.chatid), null);
});

test('unknown peer never receives menu or enters a project', async t => {
  const { f, wx, kicked } = setup(t);
  await wx.login(); await wx.checkLogin();
  await wx.receive([message('s', '我想换个项目', 'stranger')], 's');
  assert.equal(kicked.length, 0);
  assert.equal(f.peek('SELECT * FROM message').length, 0);
  assert.equal(f.ledger.outbox.takeDue().length, 0);
});

test('uncertain external send is preserved over restart and never automatically duplicated', async t => {
  let attempts = 0;
  const { wx, make } = setup(t, async () => { attempts++; throw new Error('network timeout'); });
  await wx.login(); await wx.checkLogin();
  await wx.receive([message('1', '我想换个项目')], 'a');
  const target = wx.ownerTarget()!;
  await assert.rejects(wx.send(target.chatid, 'hello', 'outbox-one'), /未确认/);
  const again = make(); t.after(() => again.stop());
  await assert.rejects(again.send(target.chatid, 'hello', 'outbox-one'), /未确认/);
  assert.equal(attempts, 1);
  await assert.rejects(again.send('weixin:another:owner', 'hello', 'outbox-two'), /账号/);
  again.disconnect();
  await again.login(); await again.checkLogin();
  await again.receive([message('2', '重新连接')], 'b');
  await assert.rejects(again.send(target.chatid, 'hello', 'outbox-one'), /未确认/);
  assert.equal(attempts, 1, 'disconnect must retain the external-send outcome for this bot and owner');
});

test('a page change interrupted before outbox commit replays the same page and number mapping', async t => {
  const { f, wx, make, file } = setup(t);
  for (let i = 0; i < 17; i++) f.ledger.createProject({ name: `项目${i}`, loginMode: 'all' }, USER);
  await wx.login(); await wx.checkLogin();
  await wx.receive([message('1', '我想换个项目')], 'a');
  const enqueue = f.ledger.enqueueNotification;
  f.ledger.enqueueNotification = () => { throw new Error('simulated interruption'); };
  await assert.rejects(wx.receive([message('2', '下一页')], 'b'), /simulated/);
  f.ledger.enqueueNotification = enqueue;
  const before = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(before.menu.page, 1);
  const resumed = make(); t.after(() => resumed.stop());
  await resumed.receive([], 'b');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.menu.page, 1);
  assert.equal(after.controls['bot-a:owner:2'], before.controls['bot-a:owner:2']);
  await resumed.receive([message('3', '1')], 'c');
  assert.equal(f.ledger.frontCurrent('weixin:bot-a', resumed.ownerTarget()!.chatid, 'owner'), before.menu.ids[8]);
});

test('a normal conversation closes the numeric picker, and old-account assign cannot change it', async t => {
  const { f, wx, file } = setup(t);
  await wx.login(); await wx.checkLogin();
  const target = wx.ownerTarget()!;
  f.ledger.frontSelect({ channel: 'weixin', bot: 'weixin:bot-a', thread: target.chatid, actor: 'owner', projectId: f.projectId });
  await wx.receive([message('1', '我想换个项目')], 'a');
  const menu = JSON.parse(readFileSync(file, 'utf8')).menu;
  await assert.rejects(wx.sendOutgoing({ id: 'old', kind: 'assign', payload_json: JSON.stringify({ target: { chatid: 'weixin:old:owner' }, message_id: 'missing' }) } as never,
    { target: { chatid: 'weixin:old:owner' }, body: { msgtype: 'template_card' } }), /另一微信账号/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).menu, menu);
  await wx.receive([message('2', '继续聊天')], 'b');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).menu, undefined);
  await wx.receive([message('3', '1')], 'c');
  assert.equal(f.ledger.listMessages({ limit: 50, projectId: f.projectId }).at(-1)!.text, '1');
});
