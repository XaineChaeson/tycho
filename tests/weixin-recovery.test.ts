import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WeixinMessage } from '../channels/weixin-api.ts';
import { createWeixin } from '../service/weixin.ts';
import { DeliveryUncertainError } from '../service/outbox.ts';
import { fixture, USER } from './helpers.ts';

function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t), file = join(f.dir, 'weixin-recovery-private');
  f.ledger.setChannels(['console', 'weixin']);
  let botId = 'bot-a';
  const kicked: string[] = [];
  const api = {
    qr: async () => ({ qrcode: 'private-test-qr', content: 'synthetic-qr-display' }),
    qrStatus: async () => ({ status: 'confirmed', bot_token: 'private-test-token', ilink_bot_id: botId, ilink_user_id: 'owner', baseurl: 'https://ilinkai.weixin.qq.com' }),
    updates: async () => ({ msgs: [], cursor: '' }), send: async () => {},
  };
  const make = () => {
    const wx = createWeixin({ file, ledger: f.ledger, api, poll: false, onMessage(id) { kicked.push(id); }, onChanged() {} });
    t.after(() => wx.stop());
    return wx;
  };
  const wx = make();
  const connect = async () => { await wx.login(); await wx.checkLogin(); };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  const target = () => wx.ownerTarget()!.chatid;
  return { f, wx, make, connect, saved, file, target, kicked, api, differentBot: () => { botId = 'bot-b'; } };
}
const msg = (id: string, text: string): WeixinMessage => ({ message_id: id, from_user_id: 'owner', message_type: 1, message_state: 2,
  context_token: 'private-context-' + id, item_list: [{ type: 1, text_item: { text } }] });

test('deleted menu projects keep their old number and paging cannot trap pending messages', async (t) => {
  const env = setup(t);
  for (let i = 0; i < 17; i++) env.f.ledger.createProject({ name: '菜单项目' + i, loginMode: 'all' }, USER);
  await env.connect();
  await env.wx.receive([msg('menu', '我想换个项目')], 'cursor-menu');
  const before = env.saved().menu;
  const removed = env.f.ledger.getProject(before.ids[8]);
  env.f.ledger.deleteProject(removed.id, removed.name, USER);
  await assert.doesNotReject(env.wx.receive([msg('page', '下一页')], 'cursor-page'));
  const after = env.saved();
  assert.deepEqual(after.menu.ids, before.ids);
  assert.equal(after.menu.page, 1);
  assert.equal(after.pending.length, 0);
  assert.match(after.controls['bot-a:owner:page'], /1\..*(不可用|失效)/);
  assert.match(after.controls['bot-a:owner:page'], /重新|换个项目/);
});

test('a stale numeric selection does not close the picker or select a shifted replacement', async (t) => {
  const env = setup(t);
  for (let i = 0; i < 3; i++) env.f.ledger.createProject({ name: '编号项目' + i, loginMode: 'all' }, USER);
  await env.connect();
  await env.wx.receive([msg('menu', '我想换个项目')], 'cursor-menu');
  const before = env.saved().menu;
  const removed = env.f.ledger.getProject(before.ids[1]);
  env.f.ledger.deleteProject(removed.id, removed.name, USER);
  await env.wx.receive([msg('pick', '2')], 'cursor-pick');
  assert.deepEqual(env.saved().menu, before);
  assert.equal(env.f.ledger.frontCurrent('weixin:bot-a', env.target(), 'owner'), null);
  assert.equal(env.kicked.length, 0);
  assert.ok(env.f.ledger.outbox.takeDue().some(row => /重新|失效/.test(JSON.parse(row.payload_json).content ?? '')));
  const resumed = env.make();
  await resumed.receive([msg('pick-again', '2')], 'cursor-pick-again');
  assert.deepEqual(env.saved().menu.ids, before.ids);
  assert.equal(env.f.ledger.frontCurrent('weixin:bot-a', env.target(), 'owner'), null);
});

test('a front-desk refusal from a fixed chat keeps its numeric picker open', async (t) => {
  const env = setup(t);
  env.f.ledger.createProject({ name: '另一项目', loginMode: 'all' }, USER);
  await env.connect();
  env.f.ledger.frontBind({ channel: 'weixin', bot: 'weixin:bot-a', thread: env.target(), actor: 'owner', projectId: env.f.projectId });
  await env.wx.receive([msg('menu', '我想换个项目')], 'a');
  const before = env.saved().menu;
  assert.equal(before.ids[0], env.f.projectId);
  await env.wx.receive([msg('pick', '2')], 'b');
  assert.deepEqual(env.saved().menu, before);
  assert.equal(env.f.ledger.frontFixed('weixin:bot-a', env.target()), env.f.projectId);
});

test('missing message ids are retained with reasons, bounded, warned about and never block a later valid request', async (t) => {
  const env = setup(t);
  await env.connect();
  env.f.ledger.frontSelect({ channel: 'weixin', bot: 'weixin:bot-a', thread: env.target(), actor: 'owner', projectId: env.f.projectId });
  const rejected = Array.from({ length: 23 }, (_, i) => {
    const message = msg('bad-' + i, '原始异常文字-' + i);
    delete message.message_id;
    return message;
  });
  await assert.doesNotReject(env.wx.receive([...rejected, msg('valid', '继续验证')], 'batch-end'));
  const stored = env.saved();
  assert.equal(stored.pending.length, 0);
  assert.equal(stored.cursor, 'batch-end');
  assert.equal(stored.rejected.length, 20);
  assert.deepEqual(stored.rejected.at(-1).message, rejected.at(-1));
  assert.ok(stored.rejected.every((item: { reason: string }) => /编号/.test(item.reason)));
  assert.equal(env.kicked.length, 1);
  assert.equal(env.f.ledger.getMessage(env.kicked[0]!).text, '继续验证');
  assert.equal(env.f.peek("SELECT id FROM message WHERE channel='weixin' AND direction='in'").length, 1);
  assert.ok(env.f.ledger.outbox.takeDue().some(row => /重新发送.*文字/.test(JSON.parse(row.payload_json).content ?? '')));
  env.wx.disconnect();
  assert.equal(env.saved().rejected.length, 20, 'quarantined originals remain diagnostic history after disconnect');
});

test('disconnect refuses pending originals without changing cursor, auth or journal bytes', async (t) => {
  const env = setup(t);
  await env.connect();
  const enqueue = env.f.ledger.enqueueNotification;
  env.f.ledger.enqueueNotification = () => { throw new Error('synthetic interrupted outbox'); };
  await assert.rejects(env.wx.receive([msg('pending', '我想换个项目')], 'pending-cursor'), /interrupted/);
  env.f.ledger.enqueueNotification = enqueue;
  const before = readFileSync(env.file, 'utf8');
  assert.throws(() => env.wx.disconnect(), /未入账.*断开|断开.*未入账/);
  assert.equal(readFileSync(env.file, 'utf8'), before);
  assert.equal(env.wx.status().state, 'connected');
  await env.wx.receive([], 'pending-cursor');
  assert.equal(env.saved().pending.length, 0);
  assert.equal(env.wx.disconnect().state, 'disconnected');
});

test('an account-switch refusal shows its real pending-message reason instead of a network diagnosis', async (t) => {
  const env = setup(t);
  await env.connect();
  const enqueue = env.f.ledger.enqueueNotification;
  env.f.ledger.enqueueNotification = () => { throw new Error('synthetic interrupted outbox'); };
  await assert.rejects(env.wx.receive([msg('pending', '我想换个项目')], 'pending-cursor'));
  env.f.ledger.enqueueNotification = enqueue;
  env.differentBot();
  await env.wx.login();
  await env.wx.checkLogin();
  assert.match(env.wx.status().error ?? '', /旧微信账号.*未入账.*换账号/);
  assert.doesNotMatch(env.wx.status().error ?? '', /private-test-token|private-test-qr/);
  assert.equal(env.saved().auth.botId, 'bot-a');
  assert.equal(env.saved().pending.length, 1);
});

test('a deleted-project page response and original number snapshot replay together after interrupted enqueue', async (t) => {
  const env = setup(t);
  for (let i = 0; i < 12; i++) env.f.ledger.createProject({ name: '重放项目' + i, loginMode: 'all' }, USER);
  await env.connect();
  await env.wx.receive([msg('menu', '我想换个项目')], 'a');
  const ids = env.saved().menu.ids;
  const removed = env.f.ledger.getProject(ids[8]);
  env.f.ledger.deleteProject(removed.id, removed.name, USER);
  const enqueue = env.f.ledger.enqueueNotification;
  env.f.ledger.enqueueNotification = () => { throw new Error('synthetic interrupted enqueue'); };
  await assert.rejects(env.wx.receive([msg('page', '下一页')], 'b'), /interrupted enqueue/);
  const interrupted = env.saved();
  assert.equal(interrupted.menu.page, 1);
  assert.match(interrupted.controls['bot-a:owner:page'], /不可用/);
  env.f.ledger.enqueueNotification = enqueue;
  env.f.ledger.createProject({ name: '后来新增项目', loginMode: 'all' }, USER);
  env.wx.stop();
  const resumed = env.make();
  await resumed.receive([], 'b');
  assert.deepEqual(env.saved().menu, interrupted.menu);
  assert.equal(env.saved().controls['bot-a:owner:page'], interrupted.controls['bot-a:owner:page']);
  assert.equal(env.saved().pending.length, 0);
});

test('a rejected raw message stays pending until its notice is committed and resumes without duplicate quarantine', async (t) => {
  const env = setup(t);
  await env.connect();
  env.f.ledger.frontSelect({ channel: 'weixin', bot: 'weixin:bot-a', thread: env.target(), actor: 'owner', projectId: env.f.projectId });
  const rejected = msg('bad', '原始异常要求');
  delete rejected.message_id;
  const enqueue = env.f.ledger.enqueueNotification;
  env.f.ledger.enqueueNotification = () => { throw new Error('synthetic rejected notice interruption'); };
  await assert.rejects(env.wx.receive([rejected, msg('valid', '正常要求')], 'batch-end'), /notice interruption/);
  assert.equal(env.saved().pending.length, 2);
  assert.equal(env.saved().rejected.length, 1);
  assert.deepEqual(env.saved().pending[0], rejected);
  env.f.ledger.enqueueNotification = enqueue;
  env.wx.stop();
  const resumed = env.make();
  await resumed.receive([], 'batch-end');
  assert.equal(env.saved().pending.length, 0);
  assert.equal(env.saved().rejected.length, 1);
  assert.equal(env.kicked.length, 1);
  assert.equal(env.f.ledger.outbox.takeDue().filter(row => String(JSON.parse(row.payload_json).external_id ?? '').startsWith('weixin-rejected:')).length, 1);
});

test('a genuinely unknown send reports terminal uncertainty on first attempt and its journal replay', async (t) => {
  const env = setup(t);
  let attempts = 0;
  env.api.send = async () => { attempts++; throw new Error('synthetic connection lost after submission'); };
  await env.connect();
  await env.wx.receive([msg('context', '我想换个项目')], 'a');
  await assert.rejects(env.wx.send(env.target(), '通知', 'outbox'), DeliveryUncertainError);
  await assert.rejects(env.wx.send(env.target(), '通知', 'outbox'), DeliveryUncertainError);
  assert.equal(attempts, 1);
});
