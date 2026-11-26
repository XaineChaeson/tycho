// Guards the one decision every way of letting a machine in goes through (nodes.decide;
// docs/design/nodes.md §1.1 step 2):
//   - behind the recovery barrier, or in degraded mode, the console's entry refuses and a
//     card's button lets the machine in anyway (or the other way round): both must meet the
//     same barrier, say the same thing, and leave the request waiting for afterwards,
//   - how long and how many ended requests are remembered being fixed in code rather than
//     read from the settings at the moment they are used.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { joinCard } from '../channels/wecom-cards.ts';
import type { TemplateCard } from '../channels/wecom-cards.ts';
import { createWecom } from '../channels/wecom.ts';
import { DegradedError } from '../service/errors.ts';
import { createNodes } from '../service/nodes.ts';
import type { PendingJoinView } from '../service/nodes.ts';
import { SETTINGS } from '../service/settings.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, USER, NODES_TUNED } from './helpers.ts';
import { startGateway } from './wecom-gateway.mjs';
import { NO_ADDRESS } from '../service/present.ts';

const OWNER = 'zhang';
const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'darwin 24', hostname: 'mac-mini-01.local' };
const RECOVERING = '服务正在恢复清点，现在不能放行机器';

async function setup(t: TestContext, tuned: { keepMs?: number; max?: number } = {}) {
  const f = fixture(t);
  const barrier = { degraded: false, recovering: false };
  let now = Date.now();
  const nodes = createNodes({ ...NODES_TUNED,
    ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 1000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000,
    barriers: () => barrier, now: () => now, log: () => {},
    ...(tuned.keepMs === undefined ? {} : { endedJoinKeepMs: () => tuned.keepMs! }),
    ...(tuned.max === undefined ? {} : { endedJoinMax: () => tuned.max! }),
  });
  const announced: (PendingJoinView & { id: string })[] = [];
  nodes.onJoinRequest((each) => announced.push(each));
  const app = await consoleApp(t, { f, nodes });
  // After the console's own setup, which writes the whitelist too.
  f.ledger.setWhitelist({ ...f.ledger.getWhitelist(), wecom: [OWNER] }, USER);
  const gateway = await startGateway();
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
  const press = async (key: string): Promise<TemplateCard> => {
    const count = gateway.sent('aibot_respond_update_msg').length;
    gateway.press(OWNER, key);
    await gateway.until(() => gateway.sent('aibot_respond_update_msg').length > count, '卡片更新');
    return gateway.sent('aibot_respond_update_msg').at(-1)!.body.template_card as TemplateCard;
  };
  // The machines let in here; the fixture's own h1 is not one of them.
  const machines = () => f.ledger.listMachines().filter((machine) => machine.id !== 'h1');
  return { f, app, nodes, barrier, announced, press, machines, later: (ms: number) => { now += ms; } };
}

test('恢复清点期间：控制台、企微按钮、放行决策本身得到同一个拒绝，请求留着等恢复之后', async (t) => {
  const s = await setup(t);
  const request = s.nodes.register(FACTS);
  const card = joinCard(s.announced[0]!);
  s.barrier.recovering = true;

  assert.throws(() => s.nodes.decide({ code: request.code }, true, USER), (err: Error) => err instanceof DegradedError && err.message === RECOVERING);
  const answered = await s.app.post('/api/admissions/approve', { kind: 'machine', code: request.code });
  assert.equal(answered.status, 503);
  assert.equal(((await answered.json()) as { error: string }).error, RECOVERING);
  // The card carries the line every WeCom card has without an address a phone can reach.
  assert.equal((await s.press(card.button_list[0]!.key)).sub_title_text, `${RECOVERING}\n${NO_ADDRESS}`);
  assert.equal(s.machines().length, 0, '屏障后面没有机器被放进来');
  assert.equal(s.nodes.pendingJoins().length, 1, '请求还在等着');

  s.barrier.recovering = false;
  assert.match((await s.press(card.button_list[0]!.key)).sub_title_text, /^已放行 mac-mini-01/);
  assert.equal(s.machines().length, 1);
});

test('降级模式下拒绝也不记：请求原样留着', async (t) => {
  const s = await setup(t);
  const request = s.nodes.register(FACTS);
  s.barrier.degraded = true;
  const refused = await s.app.post('/api/admissions/reject', { kind: 'machine', code: request.code });
  assert.equal(refused.status, 503);
  assert.equal(s.nodes.pendingJoins().length, 1);
  assert.equal(s.nodes.claim(request.secret).state, 'pending');
});

test('处理过的请求记多久、记几条按设置来：超出的按过期回答', async (t) => {
  assert.equal(SETTINGS['node.endedJoinKeepMs'].default, 24 * 60 * 60_000);
  assert.equal(SETTINGS['node.endedJoinMax'].default, 200);
  const s = await setup(t, { keepMs: 60 * 60_000, max: 1 });
  s.nodes.register(FACTS);
  s.nodes.register({ ...FACTS, node_id: 'b1b2c3d4e5f60718', name: 'build-02' });
  const [first, second] = s.announced.map((each) => joinCard(each));
  await s.press(first!.button_list[1]!.key);
  await s.press(second!.button_list[1]!.key);
  // Gone from the requests themselves (a refused one lives until it runs out): from here
  // only what is remembered of them can answer.
  s.later(60_000 + 1);
  assert.equal(s.nodes.pendingJoins().length, 0);
  // One is kept: the older answer is forgotten and reads as expired, the newer as handled.
  assert.equal((await s.press(first!.button_list[0]!.key)).sub_title_text, `这个请求已经过期；要接这台机器进来，在那台机器上重新运行加入命令\n${NO_ADDRESS}`);
  assert.equal((await s.press(second!.button_list[0]!.key)).sub_title_text, `这个请求已经处理过了\n${NO_ADDRESS}`);
  // Past the time it is kept: forgotten as well.
  s.later(60 * 60_000 + 1);
  s.nodes.register({ ...FACTS, node_id: 'c1b2c3d4e5f60718', name: 'third' });
  await s.press(joinCard(s.announced[2]!).button_list[1]!.key);
  assert.match((await s.press(second!.button_list[0]!.key)).sub_title_text, /已经过期/);
});
