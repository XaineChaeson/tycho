// Guards against the owner being disturbed for knowledge that does not need them, or a WeCom
// card deciding anything (docs/design/knowledge-and-skills.md §3): a card for a change that took
// effect immediately; a change that waits for the owner's say (global + resident) pushed with no
// card, or with a card that does not say why it waits or leaves out the way to the page where it
// is read in full; a card with an approve button; a press that publishes or rejects anything, or
// that someone outside the whitelist can make answer; and the Router's turn missing the global
// resident knowledge in force, carrying the rest in full, or failing — or going silent about it
// — when knowledge cannot be read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { knowledgeCard } from '../channels/wecom-cards.ts';
import type { TemplateCard } from '../channels/wecom-cards.ts';
import { createWecom } from '../channels/wecom.ts';
import { knowledgeAskOf, routerKnowledge } from '../service/knowledge-brief.ts';
import { createNotify } from '../service/notify.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { fixture, USER, type Fixture } from './helpers.ts';
import { create, MCP, OWNER, OWNER_SAYS } from './knowledge-helpers.ts';
import { startGateway } from './wecom-gateway.mjs';

const OWNER_ID = 'zhang';
const cards = (f: Fixture) => f.peek<OutboxRow>(`SELECT * FROM outbox WHERE kind = 'knowledge_proposal' ORDER BY rowid`);

// A change of the kind that waits for the owner: global and resident.
function waiting(f: Fixture): string {
  const { id, state } = f.ledger.propose(create({ loading: 'resident' }), MCP, USER);
  assert.equal(state, 'awaiting_owner');
  return id;
}

test('only a change waiting for the owner’s say gets a card: a summary, why it waits, and the way to the page', (t) => {
  const f = fixture(t);
  const quiet = f.ledger.propose(create({ project_ids: [f.projectId] }), MCP, USER);
  assert.equal(quiet.state, 'published');
  assert.equal(cards(f).length, 0, '直接生效的不推送');
  const globalOnDemand = f.ledger.propose(create({ title: '全局按需', loading: 'on_demand' }), MCP, USER);
  assert.equal(globalOnDemand.state, 'published');
  assert.equal(cards(f).length, 0, '全局按需直接生效的不推送');
  const id = waiting(f);
  assert.equal(cards(f).length, 1);
  const card = knowledgeCard(knowledgeAskOf(f.ledger, id), 'https://tycho.example/');
  assert.equal(card.button_list.length, 1);
  assert.deepEqual(card.button_list[0], { text: '打开', style: 1, key: `knowledge:${id}:open`, type: 1, url: `https://tycho.example/#/knowledge/proposals/${id}` });
  assert.match(card.sub_title_text, /^新建“先分解差距”\n全局 · 常驻 · 来自 外部会话（知识 MCP） 外部会话 · 证据 1 条（已核实 0）/);
  assert.match(card.sub_title_text, /要你点头：全局而且常驻：它会进所有项目的每一轮/);
  const bare = knowledgeCard(knowledgeAskOf(f.ledger, id));
  assert.deepEqual(bare.button_list[0], { text: '到控制台的知识页看', style: 1, key: `knowledge:${id}:open` });
  // Rendered as it goes out: one decided meanwhile needs no card.
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER_ID, publicUrl: () => 'https://tycho.example', direct: async () => {} });
  const sent = notify.render(cards(f)[0]!)!;
  assert.deepEqual([sent.target, sent.body.msgtype], [{ chatid: OWNER_ID, chat_type: 1 }, 'template_card']);
  f.ledger.decideProposal(id, { decision: 'approve', digest: f.ledger.getProposal(id).final_digest!, via: 'console' }, OWNER);
  assert.equal(notify.render(cards(f)[0]!), undefined);
});

async function channel(t: TestContext) {
  const gateway = await startGateway();
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER_ID] }, USER);
  const wecom = createWecom({
    url: gateway.url, botId: 'bot', secret: 's', ledger: f.ledger, publicUrl: () => 'https://tycho.example',
    createLoginUrl: () => '', loginValidity: () => '10 分钟', onMessage: () => {}, log: () => {},
  });
  t.after(async () => {
    wecom.stop();
    await gateway.close();
  });
  wecom.start();
  await gateway.until(() => wecom.status().connected, '订阅');
  const press = async (key: string, who = OWNER_ID): Promise<TemplateCard> => {
    const count = gateway.sent('aibot_respond_update_msg').length;
    gateway.press(who, key);
    await gateway.until(() => gateway.sent('aibot_respond_update_msg').length > count, '卡片更新');
    return gateway.sent('aibot_respond_update_msg').at(-1)!.body.template_card as TemplateCard;
  };
  return { gateway, f, press };
}

test('a press on the card decides nothing: it shows where the change stands, and strangers get no answer', async (t) => {
  const c = await channel(t);
  const id = waiting(c.f);
  const key = `knowledge:${id}:open`;
  c.gateway.press('stranger', key);
  const shown = await c.press(key);
  assert.equal(c.gateway.sent('aibot_respond_update_msg').length, 1, '白名单以外的人点了，卡片不动');
  assert.equal(shown.button_list[0]!.url, `https://tycho.example/#/knowledge/proposals/${id}`);
  assert.deepEqual([c.f.ledger.getProposal(id).state, c.f.count('knowledge')], ['awaiting_owner', 0]);
  c.f.ledger.decideProposal(id, { decision: 'approve', digest: c.f.ledger.getProposal(id).final_digest!, via: 'console' }, OWNER);
  const after = await c.press(key);
  assert.match(after.sub_title_text, /已生效/);
  assert.deepEqual(after.button_list.map(({ text }) => text), ['已处理']);
});

test("a project's Router is given the global and its own entries for any role: resident in full, on-demand as a catalog", (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  const put = (fields: Record<string, unknown>): string => {
    f.ledger.propose(create(fields), OWNER_SAYS, OWNER);
    return f.ledger.listEntries({ includeRetired: true }).at(-1)!.id;
  };
  const global = put({ body: '全局正文', loading: 'resident' });
  const narrowed = put({ title: '只给审阅的', body: '审阅正文', roles: ['review'], loading: 'resident' });
  const onDemand = put({ title: '全局按需的', body: '按需正文' });
  const mine = put({ title: '项目里的', body: '项目正文', project_ids: [f.projectId, other], loading: 'resident' });
  const theirs = put({ title: '别人的', body: '别人正文', project_ids: [other], loading: 'resident' });
  const given = routerKnowledge(f.ledger.applicable(f.projectId, null));
  assert.deepEqual(given.resident, [`${global}@1`, `${mine}@1`], '全局的和本项目的常驻条目全文');
  assert.ok(given.residentText.includes('全局正文') && given.residentText.includes('项目正文'));
  assert.ok(!given.residentText.includes('审阅正文') && !given.residentText.includes('别人正文') && !given.residentText.includes('按需正文'), '限职能的、别的项目的、按需的都不给全文');
  assert.ok(given.catalog.includes(`全局按需的（${onDemand}@1，全局）`), '按需的给目录');
  assert.ok(!given.catalog.includes(narrowed) && !given.catalog.includes(theirs), '限职能的和别的项目的连目录都不给');
  f.ledger.retireEntry(global, { reason: '不用了', revision: 1 }, OWNER);
  assert.deepEqual(routerKnowledge(f.ledger.applicable(f.projectId, null)).resident, [`${mine}@1`]);
  assert.deepEqual(routerKnowledge([]), { resident: [], residentText: '', catalog: '' }, '没有知识时什么都不加');
});
