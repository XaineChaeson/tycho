// Guards docs/design/nodes.md §1.1 step 2, "远程机器：手机上点一下".
//
// What this file is here to catch:
//   - a join request that never reaches the owner's phone while WeCom is set up, or a card
//     that does not say which machine, which system, which number and what to check,
//   - a button that decides something other than what the console's entry decides,
//   - a press after the request ran out, or after it was answered, that says anything but
//     "已经过期" / "已经处理过" — or that lands on a later request that took the same digits,
//   - a press by someone the owner did not allow deciding anything,
//   - a service without WeCom failing a join because there is nowhere to send the card,
//   - a local join (no one to ask) sending a card all the same,
//   - a card replaced after a press losing the line that says a phone cannot open the console.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { joinCard, parseJoinKey } from '../channels/wecom-cards.ts';
import type { TemplateCard } from '../channels/wecom-cards.ts';
import { createWecom } from '../channels/wecom.ts';
import { createNodes } from '../service/nodes.ts';
import type { PendingJoinView } from '../service/nodes.ts';
import { startService } from '../service/main.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';
import { fixture, seed, USER, NODES_TUNED } from './helpers.ts';
import { startGateway } from './wecom-gateway.mjs';
import { NO_ADDRESS } from '../service/present.ts';
import type { Gateway } from './wecom-gateway.mjs';

const OWNER = 'zhang';
const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'DEV-WORKSTATION', platform: 'win32', hostname: 'dev-workstation' };
const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const TTL_MS = 60_000;

test('卡片写着机器名、系统、号码和那句提醒，两个按钮各指向这一条请求', () => {
  const card = joinCard({ id: 'abcdef0123456789', code: '952307', name: 'DEV-WORKSTATION', platform: 'win32' });
  assert.equal(card.sub_title_text, '机器 DEV-WORKSTATION（win32）请求加入，号码 952307。只有你面前那台机器上显示着同样的数字时才放行。');
  assert.deepEqual(card.button_list.map((button) => button.text), ['放行', '拒绝']);
  assert.deepEqual(card.button_list.map((button) => parseJoinKey(button.key)), [
    { joinId: 'abcdef0123456789', approve: true },
    { joinId: 'abcdef0123456789', approve: false },
  ]);
  // The key names the request, never the six digits alone.
  assert.equal(card.button_list.some((button) => button.key.includes('952307')), false);
});

async function channel(t: TestContext) {
  const gateway = await startGateway();
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER] }, USER);
  let now = Date.now();
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 1000, joinTtlMs: () => TTL_MS, gapSlackMs: () => 10_000, now: () => now, log: () => {} });
  const announced: (PendingJoinView & { id: string })[] = [];
  nodes.onJoinRequest((each) => announced.push(each));
  const wecom = createWecom({
    url: gateway.url, botId: 'bot', secret: 's', ledger: f.ledger,
    createLoginUrl: () => '', loginValidity: () => '10 分钟', onMessage: () => {}, log: () => {},
    decideJoin: (joinId, approve, actor) => nodes.decide({ id: joinId }, approve, { actor: `wecom:${actor}` }),
  });
  t.after(async () => {
    wecom.stop();
    await gateway.close();
  });
  wecom.start();
  await gateway.until(() => wecom.status().connected, '订阅');
  const press = async (key: string, who = OWNER): Promise<TemplateCard> => {
    const count = gateway.sent('aibot_respond_update_msg').length;
    gateway.press(who, key);
    await gateway.until(() => gateway.sent('aibot_respond_update_msg').length > count, '卡片更新');
    return gateway.sent('aibot_respond_update_msg').at(-1)!.body.template_card as TemplateCard;
  };
  const machines = () => f.ledger.listMachines().filter((machine) => machine.nodeId === FACTS.node_id);
  return { gateway, f, nodes, announced, press, machines, later: (ms: number) => { now += ms; } };
}

test('点放行走和控制台同一个放行：机器写进账本，客户端取得到令牌；再点一次说已经处理过', async (t) => {
  const c = await channel(t);
  const request = c.nodes.register(FACTS);
  assert.equal(c.announced.length, 1, '有新请求就告诉主人');
  const card = joinCard(c.announced[0]!);
  assert.match(card.sub_title_text, new RegExp(request.code));

  const after = await c.press(card.button_list[0]!.key);
  assert.equal(after.sub_title_text, `已放行 DEV-WORKSTATION，它连回来后会出现在“机器”页的列表里\n${NO_ADDRESS}`);
  assert.equal(c.machines().length, 1);
  assert.equal(c.nodes.claim(request.secret).state, 'approved');
  const actors = c.f.peek<{ actor: string }>("SELECT actor FROM change WHERE action = 'machine.join' AND json_extract(detail_json, '$.machine_id') != 'h1'").map((row) => row.actor);
  assert.deepEqual(actors, [`wecom:${OWNER}`]);

  for (const key of card.button_list.map((button) => button.key)) {
    assert.equal((await c.press(key)).sub_title_text, `这个请求已经处理过了\n${NO_ADDRESS}`);
  }
  assert.equal(c.machines().length, 1, '重复点击不会多出一台');
});

test('点拒绝：不写机器，那台机器被告知拒绝', async (t) => {
  const c = await channel(t);
  const request = c.nodes.register(FACTS);
  const after = await c.press(joinCard(c.announced[0]!).button_list[1]!.key);
  assert.equal(after.sub_title_text, `已拒绝 DEV-WORKSTATION，那台机器上的加入命令已经退出\n${NO_ADDRESS}`);
  assert.equal(c.machines().length, 0);
  assert.equal(c.nodes.claim(request.secret).state, 'rejected');
});

test('请求过期后点按钮：如实说已经过期，也不会落到后来拿到同一个号码的请求上', async (t) => {
  const c = await channel(t);
  c.nodes.register(FACTS);
  const stale = joinCard(c.announced[0]!);
  c.later(TTL_MS + 1);
  assert.equal((await c.press(stale.button_list[0]!.key)).sub_title_text, `这个请求已经过期；要接这台机器进来，在那台机器上重新运行加入命令\n${NO_ADDRESS}`);
  // The machine asks again; whatever digits it gets, the old card is not its card.
  c.nodes.register(FACTS);
  assert.equal((await c.press(stale.button_list[0]!.key)).sub_title_text, `这个请求已经过期；要接这台机器进来，在那台机器上重新运行加入命令\n${NO_ADDRESS}`);
  assert.equal(c.machines().length, 0);
  assert.equal(c.nodes.pendingJoins().length, 1, '新的请求还在等着');
});

test('白名单以外的人点按钮：什么都不动，卡片也不更新', async (t) => {
  const c = await channel(t);
  c.nodes.register(FACTS);
  const card = joinCard(c.announced[0]!);
  c.gateway.press('stranger', card.button_list[0]!.key);
  c.gateway.press('stranger', card.button_list[1]!.key);
  // The owner's press after them is the first card update there is.
  const after = await c.press(card.button_list[1]!.key);
  assert.equal(c.gateway.sent('aibot_respond_update_msg').length, 1);
  assert.match(after.sub_title_text, /已拒绝/);
  assert.equal(c.machines().length, 0);
});

test('本机免放行的加入不发卡片：没有要问主人的', async (t) => {
  const c = await channel(t);
  c.nodes.admitLocal(FACTS, USER);
  assert.equal(c.announced.length, 0);
});

// The real service: a request that comes in over HTTP puts a card on the owner's phone, and
// one without WeCom set up is let in from the console as before.
async function service(t: TestContext, wecom: boolean) {
  const gateway = await startGateway();
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-join-card-'));
  seed(dataDir, {
    settings: { 'http.publicUrl': 'http://10.0.0.2:8787' },
    ...(wecom ? { wecom: { botId: 'bot', secret: 'file-secret', owner: OWNER, url: gateway.url } } : {}),
  });
  const running = await startService({ dataDir, port: 0, claude: [process.execPath, FAKE], outboxIntervalMs: 20 });
  t.after(async () => {
    await running.stop();
    await gateway.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const ask = (facts: object) => fetch(`http://127.0.0.1:${running.port}/api/node/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: NODE_PROTOCOL, facts }),
  });
  return { gateway, running, ask };
}

const joinCards = (gateway: Gateway): TemplateCard[] =>
  gateway.sent('aibot_send_msg').flatMap(({ body }) => (body.msgtype === 'template_card' && String(body.template_card.task_id).startsWith('join_') ? [body.template_card] : []));

test('配了企业微信：新的加入请求发一张卡片给主人，点放行之后机器出现', { timeout: 60_000 }, async (t) => {
  const s = await service(t, true);
  await s.gateway.until(() => s.gateway.sent('aibot_subscribe').length === 1, '订阅');
  await s.gateway.until(() => s.gateway.sent('aibot_send_msg').length > 0, '连上之后的第一条');
  const asked = await s.ask(FACTS);
  assert.equal(asked.status, 201);
  const { code } = (await asked.json()) as { code: string };
  const [card] = await s.gateway.until(() => (joinCards(s.gateway).length ? joinCards(s.gateway) : undefined), '加入卡片');
  assert.equal(s.gateway.sent('aibot_send_msg').find(({ body }) => body.template_card === card || body.template_card?.task_id === card!.task_id)!.body.chatid, OWNER);
  assert.match(card!.sub_title_text, new RegExp(`号码 ${code}`));
  s.gateway.press(OWNER, card!.button_list[0]!.key);
  await s.gateway.until(() => s.running.ledger.listMachines().some((machine) => machine.nodeId === FACTS.node_id), '机器写进账本');
});

test('没配企业微信：加入照常，不发卡片', { timeout: 60_000 }, async (t) => {
  const s = await service(t, false);
  const asked = await s.ask(FACTS);
  assert.equal(asked.status, 201);
  assert.equal(s.running.nodes.pendingJoins().length, 1);
  assert.equal(joinCards(s.gateway).length, 0);
});
