import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { CALLBACK_PATH, type CallbackPolicy } from '../integrations/feishu/callback.ts';
import { createClients, RemoteError, type Clients } from '../integrations/feishu/clients.ts';
import { openFeishuQueue } from '../integrations/feishu/queue.ts';
import { createFeishuServer } from '../integrations/feishu/server.ts';
import { consoleApp } from './console-helpers.ts';

const APP_ID = 'cli_example';
const TENANT = 'tenant-example';
const BOT = 'ou_bot';
const CHAT = 'oc_test';
const NOW = 1794630100000;
const TOKEN = 'verification-value';
const ENCRYPT = 'feishu-encrypt-value';
const RECEIPT = '01J00000000000000000000000';
const OPTS = { appId: APP_ID, tenantKey: TENANT, encryptKey: ENCRYPT, verificationToken: TOKEN, botOpenId: BOT };

function event(messageId: string, text: string, options: { group?: string; mention?: string; app?: string; tenant?: string; sender?: string; eventId?: string } = {}) {
  return {
    schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: options.eventId ?? 'event-1', app_id: options.app ?? APP_ID, tenant_key: options.tenant ?? TENANT, token: TOKEN },
    event: {
      sender: { sender_type: options.sender ?? 'user' },
      message: { message_id: messageId, chat_id: options.group ?? CHAT, chat_type: 'group', message_type: 'text',
        thread_id: 'omt_original', content: JSON.stringify({ text }), mentions: [{ key: '@_user_1', id: { open_id: options.mention ?? BOT } }] },
    },
  };
}

function encode(data: object, now: number, signature = true) {
  const iv = randomBytes(16);
  const key = createHash('sha256').update(ENCRYPT).digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const body = JSON.stringify({ encrypt: encrypted.toString('base64') });
  const timestamp = String(Math.floor(now / 1000));
  const nonce = 'testing-nonce';
  const headers = signature ? {
    'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256').update(timestamp + nonce + ENCRYPT).update(body).digest('hex'),
  } : undefined;
  return { method: 'POST', headers, body };
}

async function listening(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  return 'http://127.0.0.1:' + address.port;
}

test('加密飞书群聊回调走真实 Tycho 签名入口并回复原消息，速答直接走原线程', async (t) => {
  const app = await consoleApp(t);
  const { f } = app;
  const source = (await (await app.post('/api/inbound', {
    name: '飞书台账', kind: 'tycho-v1', project_ids: [f.projectId], result_reply: true,
  })).json() as { source: { id: string } }).source;
  const { secret } = (await (await app.post('/api/inbound/' + source.id + '/key', {})).json()) as { secret: string };
  const auth: { app_id?: string; app_secret?: string }[] = [];
  const replies: { url: string; body: { uuid: string; reply_in_thread: boolean; msg_type: string; content: string } }[] = [];
  const remote = await listening(t, createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      auth.push(data);
      response.end(JSON.stringify({ code: 0, tenant_access_token: 'synthetic-tenant', expire: 7200 }));
    } else {
      assert.equal(request.headers.authorization, 'Bearer synthetic-tenant');
      replies.push({ url: request.url!, body: data });
      response.end(JSON.stringify({ code: 0, data: { message_id: 'om_replied' + replies.length } }));
    }
  }));

  let loseReceipt = true;
  let clock = Date.now();
  const deps = {
    clients: createClients({ appId: APP_ID, appSecret: 'app-secret', tychoOrigin: app.url, tychoSource: source.id, tychoSecret: secret }, {
      feishuOrigin: remote, now: () => clock,
      async fetch(input, init) {
        const response = await fetch(input, init);
        if (loseReceipt && String(input) === app.url + '/inbound/' + source.id) {
          assert.equal(response.status, 200);
          await response.body?.cancel();
          loseReceipt = false;
          throw new Error('模拟 Tycho 已受理但凭证响应丢失');
        }
        return response;
      },
    }),
    now: () => clock, start: false,
  };
  const dir = mkdtempSync(join(tmpdir(), 'tycho-feishu-'));
  const path = join(dir, 'feishu.db');
  let queue = openFeishuQueue(path, deps);
  t.after(async () => { await queue.stop(); rmSync(dir, { recursive: true, force: true }); });
  const policy: CallbackPolicy = { ...OPTS, projectsByChat: new Map([[CHAT, f.projectId]]), quickAnswers: new Map([['工作时间', '周一到周五']]) };
  const bridge = await listening(t, createFeishuServer(policy, { record: (message) => queue.record(message) }, () => NOW));
  const callback = (msg: object, now = NOW) => fetch(bridge + CALLBACK_PATH, encode(msg, now));
  const challenge = await fetch(bridge + CALLBACK_PATH, encode({ type: 'url_verification', challenge: 'proof', token: TOKEN }, NOW, false));
  assert.deepEqual(await challenge.json(), { challenge: 'proof' });
  assert.equal((await callback(event('om_wrong_tenant', '@_user_1 运行', { tenant: 'another' }))).status, 401);
  assert.equal((await callback(event('om_bad_time', '@_user_1 运行'), NOW - 600_000)).status, 401);
  const forged = encode(event('om_bad_sig', '@_user_1 运行'), NOW);
  forged.body += ' ';
  assert.equal((await fetch(bridge + CALLBACK_PATH, forged)).status, 401);
  assert.equal((await fetch(bridge + CALLBACK_PATH, { method: 'POST', body: 'a'.repeat(300 * 1024) })).status, 413);
  for (const msg of [
    event('om_idle', '聊天'),
    event('om_other', '@_user_1 运行', { mention: 'ou_other' }),
    event('om_group', '@_user_1 运行', { group: 'oc_other' }),
    event('om_bot', '@_user_1 运行', { sender: 'app' }),
    event('om_fake', '@_user_10 工作时间'),
  ]) assert.equal((await callback(msg)).status, 200);
  assert.equal(queue.status().length, 0);

  assert.equal((await callback(event('om_quick', '@_user_1 工作时间'))).status, 200);
  assert.equal((await callback(event('om_slow', '@_user_1 跑 Windows 回归'))).status, 200);
  assert.equal((await callback(event('om_slow', '@_user_1 跑 Linux 回归', { eventId: 'retry' }))).status, 200);
  assert.equal(replies.length, 0, '回调确认不等待下游');
  await queue.tick();
  assert.deepEqual(auth, [{ app_id: APP_ID, app_secret: 'app-secret' }]);
  assert.equal(replies[0]?.url, '/open-apis/im/v1/messages/om_quick/reply');
  assert.deepEqual(JSON.parse(replies[0]!.body.content), { zh_cn: { content: [[{ tag: 'text', text: '周一到周五' }]] } });
  assert.equal(queue.status().filter(({ state }) => state === 'submit').length, 1);
  clock += 1000;
  await queue.tick();
  const fire = f.ledger.listTriggerFires({ sourceId: source.id, limit: 10 });
  assert.equal(fire.length, 1);
  const turn = f.ledger.takeNextTurn(f.projectId)!;
  assert.match(turn.message.text, /跑 Windows 回归/);
  assert.doesNotMatch(turn.message.text, /跑 Linux 回归/);
  assert.doesNotMatch(turn.message.text, /verification-value|feishu-encrypt-value|oc_test/);
  const publicText = '已完成验证。字面示例 <at user_id="all">所有人</at> [链接](https://example.com)';
  f.ledger.publishInboundReply(f.projectId, turn.message.id, publicText, { actor: 'router', messageId: turn.message.id });
  f.ledger.finishMessage(turn.message.id, 'processed');

  await queue.stop();
  queue = openFeishuQueue(path, deps);
  await queue.tick();
  await queue.tick();
  assert.equal(replies[1]?.url, '/open-apis/im/v1/messages/om_slow/reply');
  assert.deepEqual(JSON.parse(replies[1]!.body.content), { zh_cn: { content: [[{ tag: 'text', text: publicText }]] } });
  assert.ok(replies.every(({ body }) => body.reply_in_thread && body.msg_type === 'post' && body.uuid.length <= 50));
  assert.notEqual(replies[0]?.body.uuid, replies[1]?.body.uuid);
  assert.equal(queue.status().filter(({ state }) => state === 'delivered').length, 2);

  assert.equal((await callback(event('om_silent', '@_user_1 不宜向本群公开'))).status, 200);
  await queue.tick();
  const silent = f.ledger.takeNextTurn(f.projectId)!;
  f.ledger.writeOutbound({ channel: 'trigger', text: '负责人内部回复，只留项目', final: true, replyTo: silent.message.id });
  f.ledger.finishMessage(silent.message.id, 'processed');
  await queue.tick();
  assert.equal(replies.length, 2);
  assert.ok(queue.status().some(({ state }) => state === 'no_reply'));
});

test('飞书回程不确定时重启复用原 uuid，超去重窗口停在待核实', async (t) => {
  const app = await consoleApp(t);
  const called: [string, string, string][] = [];
  let clock = NOW;
  let timeOut = true;
  const clients: Clients = {
    submit: async () => RECEIPT,
    result: async () => ({ fire_id: RECEIPT, project_id: app.f.projectId, outcome: 'delivered', state: 'processed', reply: '公开回复' }),
    reply: async (...args) => {
      called.push(args);
      if (timeOut) throw new RemoteError('feishu-reply-timeout', true);
      return 'om_replied';
    },
  };
  const deps = { clients, now: () => clock, start: false, log() {} };
  const dir = mkdtempSync(join(tmpdir(), 'tycho-feishu-'));
  const path = join(dir, 'feishu.db');
  let queue = openFeishuQueue(path, deps);
  t.after(async () => { await queue.stop(); rmSync(dir, { recursive: true, force: true }); });
  const request = { eventId: 'retry', messageId: 'om_reply', chatId: CHAT, threadId: 'omt_root', projectId: app.f.projectId, text: '原请求', quickReply: '固定答案' };
  queue.record(request);
  await queue.tick();
  await queue.stop();
  queue = openFeishuQueue(path, deps);
  queue.record({ ...request, quickReply: '改过配置的答案' });
  clock += 1_000;
  timeOut = false;
  await queue.tick();
  assert.deepEqual(called[0], called[1]);
  assert.deepEqual(called[0]?.slice(0, 2), ['om_reply', '固定答案']);
  assert.equal(queue.status()[0]?.state, 'delivered');

  timeOut = true;
  queue.record({ ...request, eventId: 'ambiguous', messageId: 'om_ambiguous' });
  await queue.tick();
  clock += 3_600_000;
  await queue.tick();
  assert.equal(called.length, 3, '超过飞书去重窗口的中断需人工核查，避免发重');
  assert.equal(queue.status().find(({ event_id }) => event_id === 'ambiguous')?.state, 'uncertain');
});

test('桥接暂停超过重试窗口后，未投递请求可首次投递，可能已投递的请求停在待核实', async (t) => {
  const app = await consoleApp(t);
  const calls: string[] = [];
  let clock = NOW;
  let timeOut = true;
  const clients: Clients = {
    submit: async (_project, event) => {
      calls.push(event);
      if (timeOut) throw new RemoteError('tycho-submission-timeout', true);
      return RECEIPT;
    },
    result: async () => ({ fire_id: RECEIPT, project_id: app.f.projectId, outcome: 'delivered', state: 'processed' }),
    reply: async () => 'om_replied',
  };
  const deps = { clients, now: () => clock, start: false, log() {} };
  const dir = mkdtempSync(join(tmpdir(), 'tycho-feishu-'));
  const path = join(dir, 'feishu.db');
  let queue = openFeishuQueue(path, deps);
  t.after(async () => { await queue.stop(); rmSync(dir, { recursive: true, force: true }); });
  const request = { eventId: 'attempted', messageId: 'om_attempted', chatId: CHAT, threadId: null, projectId: app.f.projectId, text: '原请求', quickReply: null };
  queue.record(request);
  await queue.tick();
  queue.record({ ...request, eventId: 'unsent', messageId: 'om_unsent' });
  await queue.stop();
  clock += 46 * 60 * 1000;
  timeOut = false;
  queue = openFeishuQueue(path, deps);
  await queue.tick();
  assert.deepEqual(calls, ['attempted', 'unsent']);
  assert.equal(queue.status().find(({ event_id }) => event_id === 'attempted')?.state, 'uncertain');
  assert.equal(queue.status().find(({ event_id }) => event_id === 'unsent')?.state, 'result');
});

test('单条飞书回程的异常或写入失败不挡住之后的消息', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-feishu-'));
  const path = join(dir, 'feishu.db');
  let clock = NOW;
  const called: string[] = [];
  const log: string[] = [];
  const queue = openFeishuQueue(path, {
    start: false, now: () => clock, log: (line) => log.push(line),
    clients: {
      submit: async () => RECEIPT,
      result: async (_project, id) => ({ fire_id: id, project_id: RECEIPT, outcome: 'delivered', state: 'processed' }),
      reply: async (messageId) => {
        called.push(messageId);
        if (messageId === 'om_bad') throw new Error('依赖程序异常，详细信息不进日志');
        return 'om_sent';
      },
    },
  });
  t.after(async () => { await queue.stop(); rmSync(dir, { recursive: true, force: true }); });
  using probe = new DatabaseSync(path);
  probe.exec(`CREATE TRIGGER fail_one BEFORE UPDATE ON delivery WHEN old.event_id = 'storage' BEGIN
     SELECT RAISE(ABORT, '这条消息暂不可写');
  END`);
  const record = (id: string, messageId: string) => queue.record({
    eventId: id, messageId, chatId: CHAT, threadId: null, projectId: RECEIPT, text: '问题', quickReply: '回答',
  });
  record('storage', 'om_storage');
  record('unexpected', 'om_bad');
  record('ok', 'om_ok');
  await queue.tick();
  assert.deepEqual(called, ['om_bad', 'om_ok']);
  assert.equal(queue.status().find(({ event_id }) => event_id === 'ok')?.state, 'delivered');
  assert.equal(queue.status().find(({ event_id }) => event_id === 'unexpected')?.detail, 'feishu-queue-operation-failed');
  assert.ok(log.every((line) => !line.includes('详细信息')));
  await queue.tick();
  assert.equal(log.length, 2, '坏行退避，不在每个 tick 抢占头部');
  probe.exec('DROP TRIGGER fail_one');
  clock += 60_000;
  await queue.tick();
  assert.ok(called.includes('om_storage'), '写入恢复后可以再处理原消息');
});
