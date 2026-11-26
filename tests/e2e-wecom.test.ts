// Guards against the parts of step 4 working only alone: WeCom text not reaching the
// Router or the final reply not coming back to WeCom, a card that goes out but whose
// button does not land in the ledger, the Router's reply to an internal event reaching
// no one when it requires attention, a turn cut short leaving the WeCom user waiting, the state the page reads not
// reflecting the channel, and a service without WeCom configured being any different.
// Streaming: the bubble not growing from placeholder through tool lines to the final on
// one stream.id, a final lost or doubled when the stream has expired, a final that waits
// for a stream a restart took away, a turn cut short or left without a reply leaving
// the bubble spinning, and an internal event's reply going out as a stream.
// Fake gateway; most cases use a fake CLI and real startService. The internal
// notification case uses an in-process stand-in and runs on Linux too.
// The front desk (docs/design/project-sessions.md §2, §8): a project entered in the chat getting
// the owner's words and its replies marked with its name and a link to its page; forwarded
// material switching nothing; a message naming objects of two projects going to neither until the
// owner picks one; a waiting message and its question surviving a restart.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { createWecom } from '../channels/wecom.ts';
import { createNotify } from '../service/notify.ts';
import { createOutboxSender } from '../service/outbox-sender.ts';
import { claudeTier, fixture, RUN_LIMIT_MS, tuned, holdMachine, testMachine } from './helpers.ts';
import { openLedger } from '../service/ledger.ts';
import { startService } from '../service/main.ts';
import { wecomSecretFile } from '../service/secrets.ts';
import { writeReleaseIntent, writeReleaseResult } from '../service/releases.ts';
import { createTools } from '../service/tools.ts';
import type { Gateway } from './wecom-gateway.mjs';
import { startGateway } from './wecom-gateway.mjs';
import { memoryLogins, noAccept, seed } from './helpers.ts';
import { signIn } from './stage.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const OWNER = 'zhang';
const SECRET = 'file-secret';
const options = { timeout: 60_000 };
const USER = { actor: 'test' };

type Service = Awaited<ReturnType<typeof startService>>;

async function setup(t: TestContext, wecom = true, prepare: (dataDir: string) => void = () => {}, unassigned = false) {
  const gateway = await startGateway();
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-wecom-'));
  const previous = { ...process.env };
  const tools = createTools({
    ledger: undefined as never,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({}),
    machines: undefined as never,
    accept: noAccept,
  });
  Object.assign(process.env, {
    FAKE_CLAUDE_LOG: join(dataDir, 'fake.log'),
    FAKE_CLAUDE_TOOLS: JSON.stringify(tools.names.map((name) => `mcp__tycho__${name}`)),
  });
  prepare(dataDir);
  seed(dataDir, {
    settings: { 'http.publicUrl': 'http://10.0.0.2:8787' },
    ...(wecom ? { wecom: { botId: 'bot', secret: SECRET, owner: OWNER, url: gateway.url } } : {}),
  });
  const service = await startService({
    dataDir, port: 0, claude: [process.execPath, FAKE], outboxIntervalMs: 20, pushIntervalMs: 20, wecomStreamTiming: { bodyMs: 20, statusMs: 20, timerMs: 20 },
  });
  t.after(async () => {
    await service.stop();
    await gateway.close();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    rmSync(dataDir, { recursive: true, force: true });
  });
  // The owner has entered a project in this chat, so what they write goes there; `unassigned`
  // leaves the chat with none.
  if (wecom && !unassigned) {
    const projectId = service.ledger.listProjects()[0]?.id ?? service.ledger.createProject({ name: '试跑' }, USER);
    service.ledger.frontReceive({ bot: 'bot', externalId: 'entered', actor: OWNER, thread: OWNER, text: '进入 试跑', material: false });
    void projectId;
    await gateway.until(() => sentText(gateway).some((text) => text.startsWith(ENTERED)), '进入项目的回复');
  }
  return { gateway, service, dataDir };
}

const ENTERED = '已进入';
// Every WeCom message carries its project's mark (or 【系统】) and the way to the page: the
// cases below compare what is said, the mark and the link are checked where they are the point.
const said = (content: string): string =>
  content.replace(/^【[^】]*】/, '').replace(/\n\n(?:\[在控制台打开\]\([^)]*\)|控制台：还没有配置对外地址，手机上打不开)$/, '');

const say = (gateway: Gateway, msgid: string, content: string): string =>
  gateway.message({ msgid, from: { userid: OWNER }, chattype: 'single', msgtype: 'text', text: { content } });

const rawText = (gateway: Gateway): string[] =>
  gateway.sent('aibot_send_msg').flatMap(({ body }) => (body.msgtype === 'markdown' ? [body.markdown.content as string] : []));
const sentText = (gateway: Gateway): string[] => rawText(gateway).map(said);

// What ended a stream, the tool lines aside.
const streamed = (gateway: Gateway): string[] =>
  gateway.streams().flatMap(({ finish, content }) => (finish ? [said(content.replace(/^<think>.*<\/think>\n\n/s, ''))] : []));

const sentCards = (gateway: Gateway) =>
  gateway.sent('aibot_send_msg').flatMap(({ body }) => (body.msgtype === 'template_card' && body.template_card.task_id !== 'tycho_project_menu' ? [body.template_card] : []));

function openQuestion(service: Service, questions: { question: string; options?: string[] }[]): string {
  const { ledger } = service;
  const projectId = ledger.createProject({ name: '试跑' }, USER);
  const task = ledger.createTask({ roleId: 'implement', projectId, title: '选库', goal: '目标', acceptance: '测试通过' }, USER);
  ledger.queueTask(task.id, USER);
  return ledger.openApproval(task.id, questions, USER);
}

async function signedIn(service: Service, path: string): Promise<any> {
  const url = `http://127.0.0.1:${service.port}`;
  const credential = service.auth.createLink().credential;
  const login = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { Origin: url, Host: `127.0.0.1:${service.port}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential }),
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return (await fetch(`${url}${path}`, { headers: { Cookie: cookie } })).json();
}

test('WeCom text goes through the Router and the final reply comes back to WeCom', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 1, '订阅');
  assert.equal(gateway.sent('aibot_subscribe')[0]!.body.secret, SECRET);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动通知');

  const reqId = say(gateway, 'm1', '你好');
  await gateway.until(() => streamed(gateway).includes('回复：你好'), '终稿');
  assert.ok(gateway.streams().every((frame) => frame.reqId === reqId));

  const messages = service.ledger.listMessages({ limit: 10 });
  const inbound = messages.find(({ external_id }) => external_id === 'm1')!;
  assert.equal(inbound.channel, 'wecom');
  await gateway.until(() => service.ledger.getMessage(inbound.id).state === 'processed', '处理完');
  assert.equal(service.ledger.getMessage(`${messages.find(({ direction }) => direction === 'out')!.id}`).final, 1);
  await gateway.until(() => service.ledger.outbox.counts().pending === 0, '记账');
  assert.deepEqual(sentText(gateway).filter((text) => !text.startsWith(ENTERED)), ['服务已启动']);
});

test('the reply grows in one bubble: placeholder, tool lines, text, final', options, async (t) => {
  const { gateway } = await setup(t);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  const reqId = say(gateway, 'tools', '调工具吧');
  await gateway.until(() => streamed(gateway).includes('最后这句'), '终稿');
  const frames = gateway.streams();
  assert.equal(frames[0]!.content, '<think></think>');
  assert.equal(frames[0]!.finish, false);
  assert.equal(new Set(frames.map(({ id }) => id)).size, 1);
  assert.ok(frames.every((frame) => frame.reqId === reqId));
  assert.equal(frames.filter(({ finish }) => finish).length, 1);
  assert.equal(frames.at(-1)!.finish, true);
  assert.equal(frames.at(-1)!.content.replace(/\n\n\[在控制台打开\]\([^)]*\)$/, ''), '<think>调用 list_tasks…完成\n调用 create_task…失败</think>\n\n【试跑】最后这句');

  const order = ['调用 list_tasks…<', '调用 list_tasks…完成', '我查一下，查到了', '调用 create_task…<', '调用 create_task…失败'];
  const seen = order.map((text) => frames.findIndex(({ content }) => content.includes(text)));
  assert.ok(seen.every((index) => index > 0), `缺帧：${seen.join(',')}`);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(gateway.sent('aibot_send_msg').filter(({ body }) => body.markdown?.content === '最后这句').length, 0);
});

test('a stream that has expired hands the final to a push, and it arrives once', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  gateway.onStream = ({ finish }) => (finish ? { errcode: 846608, errmsg: 'stream message update expired (>6 minutes)' } : undefined);
  say(gateway, 'late', '你好');
  await gateway.until(() => sentText(gateway).includes('回复：你好'), '主动推送');
  await gateway.until(() => service.ledger.outbox.counts().pending === 0, '记账');
  assert.equal(sentText(gateway).filter((text) => text === '回复：你好').length, 1);
  assert.equal(gateway.streams().filter(({ finish }) => finish).length, 1);
});

test('a final the stream cannot take is pushed even when the stream looks alive', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  gateway.onStream = (_frame, index) => (index === 1 ? { errcode: 846604, errmsg: 'cannot update' } : undefined);
  say(gateway, 'gone', '调工具吧');
  await gateway.until(() => sentText(gateway).includes('最后这句'), '主动推送');
  await gateway.until(() => service.ledger.outbox.counts().pending === 0, '记账');
  assert.equal(gateway.streams().filter(({ finish }) => finish).length, 0);
  assert.equal(sentText(gateway).filter((text) => text === '最后这句').length, 1);
});

test('after a restart there is no stream, and a final still waiting goes out as a push', options, async (t) => {
  const { gateway } = await setup(t, true, (dataDir) => {
    const ledger = openLedger(join(dataDir, 'ledger.db'));
    ledger.enqueueNotification('wecom', 'markdown', {
      external_id: 'reply:m-before-restart',
      target: { chatid: OWNER, chat_type: 1 },
      content: '重启前的终稿',
    });
    ledger.close();
  });
  await gateway.until(() => sentText(gateway).includes('重启前的终稿'), '主动推送');
  assert.deepEqual(gateway.streams(), []);
});

test('a turn that ends with nothing to say still ends the bubble', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  say(gateway, 'quiet', '无话可说');
  await gateway.until(() => streamed(gateway).length === 1, '收尾帧');
  assert.match(streamed(gateway)[0]!, /没有要回复的内容/);
  assert.equal(service.ledger.outbox.counts().pending, 0);
});

test('what an internal event needs from the owner is pushed in the service\'s words, never streamed; the Router\'s reply stays in the console', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  const { ledger } = service;
  const projectId = ledger.createProject({ name: '试跑', loginMode: 'all' }, USER);
  const task = ledger.createTask({ roleId: 'implement', projectId, title: '跑', goal: '目标', acceptance: '测试通过' }, USER);
  ledger.queueTask(task.id, USER);
  // A Run needs a account the ledger holds. It is gone again before the service, which
  // has real ssh here, takes its next look.
  const account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };
  ledger.putAccount(account, USER, 'ref-t1');
  holdMachine(ledger, testMachine('h1'), USER);
  const machine = ledger.getMachine('h1')!;
  const run = ledger.createRun(task.id, { login: account, machine, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: 1 }, USER);
  ledger.markRunRunning(run.id);
  ledger.settleRun(run.id, 1, null);
  ledger.deleteAccount('t1', USER, { confirmed: true });
  await gateway.until(() => sentText(gateway).some((text) => text.startsWith('任务停住了，要你处理：跑')), '推送');
  const event = ledger.listMessages({ limit: 100 }).find(({ external_id }) => external_id === `run:${run.id}`)!;
  await gateway.until(() => ledger.getMessage(event.id).state === 'processed', '负责人回过');
  await gateway.until(() => ledger.outbox.counts().pending === 0, '记账');
  assert.ok(!sentText(gateway).some((text) => text.startsWith('回复：')), '负责人的回复不推');
  assert.deepEqual(gateway.streams(), []);
});

test('a message that has to queue says so in its bubble and is answered after the one ahead', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  // The first turn of a session carries the overview, whose text the fake CLI reads too.
  say(gateway, 'warm', '先来一条');
  await gateway.until(() => streamed(gateway).includes('回复：先来一条'), '首个回合');
  say(gateway, 'long', '长回合');
  await gateway.until(() => service.session.status().turn !== null, '开始回合');
  const reqId = say(gateway, 'next', '第二条');
  const ours = () => gateway.streams().filter((frame) => frame.reqId === reqId);
  await gateway.until(() => ours().some(({ content }) => content.includes('排队中，前面还有 1 条')), '排队提示');
  service.session.interrupt();
  await gateway.until(() => streamed(gateway).includes('回复：第二条'), '第二条终稿');
  assert.equal(said(ours().at(-1)!.content), '回复：第二条');
  assert.equal(new Set(ours().map(({ id }) => id)).size, 1);
});

test('a turn cut short ends its bubble with the unfinished notice, once', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  say(gateway, 'warm', '先来一条');
  await gateway.until(() => streamed(gateway).includes('回复：先来一条'), '首个回合');
  const reqId = say(gateway, 'long', '长回合');
  await gateway.until(() => gateway.streams().some((frame) => frame.reqId === reqId && frame.content === '开始做'), '正文');
  service.session.interrupt();
  await gateway.until(() => streamed(gateway).some((text) => text.includes('该请求未完成（长回合）')), '收尾');
  const frames = gateway.streams().filter((frame) => frame.reqId === reqId);
  assert.equal(new Set(frames.map(({ id }) => id)).size, 1);
  assert.equal(frames.filter(({ finish }) => finish).length, 1);
  await gateway.until(() => service.ledger.outbox.counts().pending === 0, '记账');
  assert.ok(!sentText(gateway).some((text) => text.includes('该请求未完成')));
});

test('an Approval goes out as a card, its button lands in the ledger, the card follows', options, async (t) => {
  const { gateway, service } = await setup(t);
  const id = openQuestion(service, [{ question: '用哪个？', options: ['甲', '乙'] }]);
  await gateway.until(() => sentCards(gateway).length === 1, '卡片');
  const [card] = sentCards(gateway);
  assert.equal(card.main_title.title, '【试跑】选库');

  gateway.press(OWNER, card.button_list[1].key);
  await gateway.until(() => gateway.sent('aibot_respond_update_msg').length === 1, '卡片更新');
  const update = gateway.sent('aibot_respond_update_msg')[0]!.body.template_card;
  assert.equal(update.task_id, card.task_id);
  assert.equal(update.sub_title_text, '已回答：乙');

  const row = service.ledger.getApprovalCard(id)!;
  assert.equal(row.state, 'answered');
  assert.equal(row.answered_via, 'wecom');
  await gateway.until(() => sentText(gateway).includes('已回答（来自 wecom）：乙'), '已回答通知');
  assert.equal(service.ledger.listApprovals(row.task_id).length, 1);
  assert.equal(sentCards(gateway).length, 1);
});

test('an answer from the Console reaches WeCom, and the old card then says closed', options, async (t) => {
  const { gateway, service } = await setup(t);
  const id = openQuestion(service, [{ question: '用哪个？', options: ['甲'] }]);
  await gateway.until(() => sentCards(gateway).length === 1, '卡片');
  service.ledger.answerApproval(id, ['甲'], 'console', 'console');
  await gateway.until(() => sentText(gateway).includes('问题已在 Console 回答：甲'), '通知');
  gateway.press(OWNER, sentCards(gateway)[0].button_list[0].key);
  await gateway.until(() => gateway.sent('aibot_respond_update_msg').length === 1, '卡片更新');
  assert.equal(gateway.sent('aibot_respond_update_msg')[0]!.body.template_card.sub_title_text, '问题已关闭，已在 console 回答');
});

test('a Task the rules stopped reaches the owner on WeCom in the service\'s words, whatever the Router replies', options, async (t) => {
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const gateway = await startGateway();
  const channel = createWecom({
    url: gateway.url, botId: 'bot', secret: SECRET, ledger: f.ledger,
    createLoginUrl: () => { throw new Error('本测试不生成登录凭据'); },
    loginValidity: () => '10 分钟',
    onMessage: () => {}, log: () => {},
  });
  t.after(async () => { channel.stop(); await gateway.close(); });
  channel.start();
  await gateway.until(() => channel.status().connected, '订阅');
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER, direct: async () => {} });
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null);
  const message = f.ledger.listMessages({ limit: 100 }).find((row) => row.external_id === `run:${run.id}`)!;
  // A stand-in Session Host completes the reply in-process; no CLI process is started.
  f.ledger.transaction(() => {
    const reply = f.ledger.writeOutbound({ channel: 'internal', text: '回复：需要处理', final: true, replyTo: message.id });
    notify.finalReply(message, reply);
  });
  const sender = createOutboxSender({ outbox: f.ledger.outbox, giveUpAfterMs: tuned('outbox.giveUpAfterMs'), retryFirstMs: tuned('outbox.retryFirstMs'), retryMaxMs: tuned('outbox.retryMaxMs'), channels: { async wecom(row) {
    const outgoing = notify.render(row);
    if (outgoing) await channel.send(outgoing.target, outgoing.body);
    else return notify.skipReason(row);
  } } });
  t.after(() => sender.stop());
  sender.start();
  await gateway.until(() => sentText(gateway).some((text) => text.startsWith('任务停住了')), '通知');
  const frame = gateway.sent('aibot_send_msg').find(({ body }) => String(body.markdown?.content).includes('任务停住了'))!;
  assert.equal(frame.body.chatid, OWNER);
  assert.match(frame.body.markdown.content, /^【试跑】/);
  assert.deepEqual(gateway.streams(), []);
  await gateway.until(() => f.ledger.outbox.counts().pending === 0, '通知记账');
  assert.ok(!sentText(gateway).includes('回复：需要处理'));
});

test('登录 gives a link on the public address that really signs in, and stores nothing', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 1, '订阅');
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  say(gateway, 'login', '登录');
  await gateway.until(() => gateway.sent('aibot_respond_msg').length === 1, '链接');
  const { content } = gateway.sent('aibot_respond_msg')[0]!.body.markdown;
  const path = /http:\/\/10\.0\.0\.2:8787(\/login#[0-9a-f]{64})/.exec(content)![1]!;
  assert.equal(service.ledger.listMessages({ limit: 50 }).filter(({ external_id }) => external_id === 'login').length, 0);
  assert.equal((await fetch(`http://127.0.0.1:${service.port}${path}`)).status, 200);
});

test('the state the page reads shows the channel and the Outbox', options, async (t) => {
  const { gateway, service } = await setup(t);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动');
  await gateway.until(() => service.ledger.outbox.counts().pending === 0, '清空');
  const state = await signedIn(service, '/api/state');
  assert.equal(state.channels.wecom.connected, true);
  assert.equal(state.channels.wecom.error, null);
  assert.ok(state.channels.wecom.since);
  assert.deepEqual(state.outbox, { pending: 0, given_up: 0 });

  gateway.event('system', { eventtype: 'disconnected_event' });
  await gateway.until(() => gateway.frames.length > 0, '帧');
  const deadline = Date.now() + 5000;
  let after = await signedIn(service, '/api/state');
  while (after.channels.wecom.connected && Date.now() < deadline) after = await signedIn(service, '/api/state');
  assert.equal(after.channels.wecom.connected, false);
  assert.match(after.channels.wecom.error, /顶掉/);
});

test('a request cut off by a crash is reported on WeCom after the restart', options, async (t) => {
  let id = '';
  const { gateway, service } = await setup(t, true, (dataDir) => {
    const ledger = openLedger(join(dataDir, 'ledger.db'));
    ledger.setWhitelist({ console: ['console'], wecom: [OWNER] }, USER);
    const projectId = ledger.createProject({ name: '试跑' }, USER);
    ({ id } = ledger.receiveMessage({ channel: 'wecom', externalId: 'm', actor: OWNER, text: '做到一半', thread: OWNER, projectId }));
    ledger.takeNextTurn(projectId);
    ledger.close();
  });
  await gateway.until(() => sentText(gateway).some((text) => text.startsWith('该请求未完成（做到一半）')), '通知');
  assert.equal(service.ledger.getMessage(id).state, 'unverified');
});

test('a Secret file emptied by hand does not stop the start: the service is up and says why the channel is not', options, async (t) => {
  const { service } = await setup(t, false, (dataDir) => {
    // After the channel was switched on in the console, which requires the Secret.
    seed(dataDir, { wecom: { botId: 'bot', secret: SECRET, owner: OWNER, url: 'ws://127.0.0.1:1' } });
    writeFileSync(wecomSecretFile(dataDir), '  ');
  });
  const client = await signIn(service);
  const { channels } = (await (await client.get('/api/state')).json()) as { channels: { wecom: { connected: boolean; error: string } } };
  assert.deepEqual(channels.wecom, { connected: false, since: null, error: '没有设置 Secret' });
});

test('without a wecom section nothing connects and the service works as before', options, async (t) => {
  const { gateway, service } = await setup(t, false);
  const projectId = service.ledger.createProject({ name: '试跑' }, USER);
  const id = service.ledger.receiveMessage({ channel: 'console', externalId: 'c1', actor: 'console', text: '你好', projectId }).id;
  await gateway.until(() => service.ledger.getMessage(id).state === 'processed', '处理完');
  const state = await signedIn(service, '/api/state');
  assert.equal(state.channels.wecom, null);
  assert.equal(gateway.connections, 0);
  assert.deepEqual(service.ledger.getWhitelist().wecom, undefined);
});

// docs/design/project-sessions.md §2, step 1: with no current project yet, what the owner writes
// in WeCom waits in the ledger; once the owner gives it a project in the console, that
// project's Router takes it and the reply comes back to WeCom.
test('a WeCom message with no project waits for the owner to give it one, then goes through that project\'s Router', options, async (t) => {
  const { gateway, service } = await setup(t, true, () => {}, true);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动通知');
  say(gateway, 'w1', '你好');
  await gateway.until(() => service.ledger.unassignedMessages().length === 1, '待归属');
  const [waiting] = service.ledger.unassignedMessages();
  await sleep(200);
  assert.equal(service.ledger.getMessage(waiting!.id).state, 'unassigned', '没有项目就不交给任何负责人');
  const projectId = service.ledger.createProject({ name: '试跑' }, USER);
  const url = `http://127.0.0.1:${service.port}`;
  const login = await fetch(`${url}/login`, { method: 'POST', headers: { Origin: url, Host: `127.0.0.1:${service.port}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: service.auth.createLink().credential }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const assigned = await fetch(`${url}/api/messages/assign`, {
    method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [waiting!.id], project_id: projectId }),
  });
  assert.equal(assigned.status, 200);
  await gateway.until(() => service.ledger.getMessage(waiting!.id).state === 'processed', '处理完');
  await gateway.until(() => sentText(gateway).includes('回复：你好'), '回复推到企微');
});

// §2: the owner's words go to the project entered in this chat, and the reply says which project
// it is from and links to that project's page, without any token in it.
test('a reply to the owner carries the project\'s mark and the way to its page', options, async (t) => {
  const { gateway, service } = await setup(t);
  const projectId = service.ledger.listProjects()[0]!.id;
  say(gateway, 'marked', '你好');
  await gateway.until(() => gateway.streams().some(({ finish }) => finish), '终稿');
  const final = gateway.streams().find(({ finish }) => finish)!.content.replace(/^<think>.*<\/think>\n\n/s, '');
  assert.ok(final.startsWith('【试跑】回复：你好'), final);
  assert.ok(final.endsWith(`[在控制台打开](http://10.0.0.2:8787/#/projects/${projectId})`), final);
  assert.doesNotMatch(final, /login|token/i);
});

// §8: forwarded material and a message naming objects of two projects. The material switches
// nothing; the conflict goes to neither project's Router until the owner picks one on its card,
// and then to that one only, the chat now in it.
test('forwarded material switches nothing; objects of two projects wait for the owner\'s pick', options, async (t) => {
  const { gateway, service } = await setup(t);
  const { ledger } = service;
  const first = ledger.listProjects()[0]!.id;
  const second = ledger.createProject({ name: '乙项目', loginMode: 'all' }, USER);
  const mine = ledger.createTask({ roleId: 'implement', projectId: first, title: '甲的', goal: '目标', acceptance: '验收' }, USER);
  const theirs = ledger.createTask({ roleId: 'implement', projectId: second, title: '乙的', goal: '目标', acceptance: '验收' }, USER);
  gateway.message({ msgid: 'fwd', from: { userid: OWNER }, chattype: 'single', msgtype: 'text', text: { content: '进入 乙项目' }, compat_info: { source: '群聊记录' } });
  await gateway.until(() => ledger.listMessages({ limit: 50 }).some(({ external_id, state }) => external_id === 'fwd' && state === 'processed'), '资料交给当前项目');
  assert.equal(ledger.frontCurrent('bot', OWNER, OWNER), first, '转发的资料不改当前项目');

  say(gateway, 'both', `${mine.id} 和 ${theirs.id} 一起看`);
  await gateway.until(() => sentCards(gateway).some((card) => card.task_id.startsWith('assign_')), '问归属的卡片');
  const card = sentCards(gateway).find((each) => each.task_id.startsWith('assign_'))!;
  assert.equal(card.main_title.title, '【系统】这条消息归哪个项目？');
  assert.deepEqual(card.button_list.map(({ text }: { text: string }) => text), ['试跑', '乙项目', '到控制台归属']);
  assert.equal(card.card_action.url, 'http://10.0.0.2:8787/#/');
  const waiting = ledger.unassignedMessages()[0]!;
  await sleep(200);
  assert.equal(ledger.getMessage(waiting.id).state, 'unassigned', '谁的负责人都没拿');

  gateway.press(OWNER, card.button_list[1].key);
  await gateway.until(() => ledger.getMessage(waiting.id).state === 'processed', '乙项目的负责人处理完');
  assert.equal(ledger.getMessage(waiting.id).project_id, second);
  assert.equal(ledger.frontCurrent('bot', OWNER, OWNER), second, '选择也改了当前项目');
  await gateway.until(() => rawText(gateway).some((text) => text.startsWith('【乙项目】回复：')), '回复推到企微');
});

// §8: a waiting message is in the ledger, not in memory: after a restart its question is still
// answerable, and the answer releases it to the project picked.
test('a waiting message and its question outlast a restart, and the pick after it goes through', options, async (t) => {
  const { gateway, service, dataDir } = await setup(t, true, () => {}, true);
  const projectId = service.ledger.createProject({ name: '试跑', loginMode: 'all' }, USER);
  await gateway.until(() => sentText(gateway).includes('服务已启动'), '启动通知');
  say(gateway, 'before', '重启前说的');
  await gateway.until(() => sentCards(gateway).some((card) => card.task_id.startsWith('assign_')), '问归属的卡片');
  const card = sentCards(gateway).find((each) => each.task_id.startsWith('assign_'))!;
  await service.stop();
  const again = await startService({ dataDir, port: 0, claude: [process.execPath, FAKE], outboxIntervalMs: 20 });
  t.after(() => again.stop());
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 2, '重连');
  const [waiting] = again.ledger.unassignedMessages();
  assert.equal(waiting!.text, '重启前说的');
  gateway.press(OWNER, card.button_list[0].key);
  await gateway.until(() => again.ledger.getMessage(waiting!.id).state === 'processed', '处理完');
  assert.equal(again.ledger.getMessage(waiting!.id).project_id, projectId);
  await gateway.until(() => sentText(gateway).includes('回复：重启前说的'), '回复推到企微');
  await again.stop();
});

// §2.1: a release checked after this service started is a result, said once. "After this service
// started" is the instance's own start: the upgrade command can finish its health check while the
// start is still waiting on the Router's checks, and that result counts.
test('a release whose check finished while the start was still under way is pushed once', options, async (t) => {
  const { gateway, dataDir } = await setup(t);
  const { started_at: startedAt } = JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { started_at: string };
  writeReleaseIntent(dataDir, { at: startedAt, run_id: 'r-gone', name: 'tycho-9.9.9.tar.gz', version: '9.9.9', sha256: 'a'.repeat(64), bytes: 1, file: join(dataDir, 'tycho-9.9.9.tar.gz') });
  writeReleaseResult(dataDir, { at: startedAt, from: '9.9.8', to: '9.9.9', verified: true, ok: true, rolled_back: false, in_use: '9.9.9', lines: [] });
  await gateway.until(() => sentText(gateway).includes('已上线 9.9.9'), '上线的成果');
  await sleep(200);
  assert.equal(sentText(gateway).filter((text) => text === '已上线 9.9.9').length, 1);
});

// Review of triggers step 2: a result written before the service took it into the ledger (a crash
// in between, or a start that came after the check) is still handled, by the ledger's mark of what
// was handled, not by when this process started; and handled, it is not handled again by the next
// instance.
test('a release result the ledger has not handled is handled after a restart, and only once', options, async (t) => {
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const { gateway, dataDir, service } = await setup(t, true, (dir) => {
    writeReleaseIntent(dir, { at: earlier, run_id: 'r-gone', name: 'tycho-9.9.7.tar.gz', version: '9.9.7', sha256: 'a'.repeat(64), bytes: 1, file: join(dir, 'tycho-9.9.7.tar.gz') });
    writeReleaseResult(dir, { at: earlier, from: '9.9.6', to: '9.9.7', verified: true, ok: true, rolled_back: false, in_use: '9.9.7', lines: [] });
  });
  await gateway.until(() => sentText(gateway).includes('已上线 9.9.7'), '入账前就写好的上线结果');
  await service.stop();
  const again = await startService({ dataDir, port: 0, claude: [process.execPath, FAKE], outboxIntervalMs: 20, pushIntervalMs: 20 });
  t.after(() => again.stop());
  await gateway.until(() => gateway.sent('aibot_subscribe').length === 2, '重连');
  await sleep(300);
  assert.equal(sentText(gateway).filter((text) => text === '已上线 9.9.7').length, 1);
  await again.stop();
});

test('the private startup card opens a project without typing a command', options, async (t) => {
  const { gateway, service } = await setup(t, true, () => {}, true);
  const target = service.ledger.createProject({ name: '私聊项目' }, USER);
  const ready = await gateway.until(() => gateway.sent('aibot_send_msg')
    .find(({ body }) => body?.template_card?.task_id === 'tycho_project_menu'), '私聊项目入口');
  const press = (key: string) => gateway.event(OWNER, { eventtype: 'template_card_event', template_card_event: { task_id: 'tycho_project_menu', event_key: key } });
  press(ready.body.template_card.button_list[0].key);
  const picker = await gateway.until(() => gateway.sent('aibot_respond_update_msg').at(-1)?.body.template_card, '项目选择卡');
  press(picker.button_list.find(({ key }: { key: string }) => key.endsWith(target)).key);
  await gateway.until(() => service.ledger.frontCurrent('bot', OWNER, OWNER) === target, '聊天已切换');
  assert.equal(service.ledger.frontFixed('bot', OWNER), null);
});

test('project switching in ordinary words opens a picker only when asked', options, async (t) => {
  const { gateway, service } = await setup(t);
  const other = service.ledger.createProject({ name: '另一个项目' }, USER);
  const ask = '我想换个项目。';
  const normal = '我想换个项目的依赖版本，请先查一下';
  say(gateway, 'normal-1', normal);
  say(gateway, 'normal-2', '讨论一下怎么切换项目');
  await gateway.until(() => streamed(gateway).includes(`回复：${normal}`) && streamed(gateway).includes('回复：讨论一下怎么切换项目'), '两条普通回复');
  assert.equal(gateway.sent('aibot_respond_msg').filter(({ body }) => body.template_card).length, 0);
  const reqId = say(gateway, 'switch', ask);
  const frame = await gateway.until(() => gateway.sent('aibot_respond_msg')
    .find(({ headers, body }) => headers.req_id === reqId && body.msgtype === 'template_card'), '按需出现的项目选择卡');
  const picker = frame.body.template_card;
  assert.equal(picker.main_title.title, '选择项目');
  const button = picker.button_list.find(({ key }: { key: string }) => key.endsWith(other));
  assert.ok(button);
  gateway.event(OWNER, { eventtype: 'template_card_event', template_card_event: { task_id: picker.task_id, event_key: button.key } });
  await gateway.until(() => service.ledger.frontCurrent('bot', OWNER, OWNER) === other, '点选后切换');
  say(gateway, 'normal-3', '你好');
  await gateway.until(() => streamed(gateway).includes('回复：你好'), '切换后的回复');
  const messages = service.ledger.listMessages({ limit: 20 });
  assert.equal(messages.find(({ external_id }) => external_id === 'normal-3')?.project_id, other);
  assert.equal(messages.find(({ external_id }) => external_id === 'switch')?.project_id, null);
  assert.equal(gateway.sent('aibot_respond_msg').filter(({ body }) => body.template_card).length, 1);
});
