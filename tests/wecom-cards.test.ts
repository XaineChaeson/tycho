// Guards against a question that cannot be read or answered from the card: buttons
// that do not map back to the option they show, a button that can only fail (a sheet
// is accepted whole, so several questions must not offer a press), more buttons than
// the card allows, a clipped label with no way to read it in full; and against a
// press that is misread, or answered on the wrong card after the fact. The channel
// half runs against the fake gateway: every outcome has to reach the card in reply.
// Console-only cards must navigate there, and indistinguishable clipped options
// must never invite an accidental answer. A card asking which project a message belongs to must
// carry one button per candidate it can hold, map each press back to that message and project,
// and leave the rest to the numbered list and the console, with a way to the page always there.
// A card replaced after a press keeps its project's mark and the way to its page, or says plainly
// that a phone cannot open the console (project-sessions §2).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  assignCard,
  knowledgeCard,
  parseAssignKey,
  answeredCard,
  closedCard,
  missingCard,
  optionOf,
  parseEventKey,
  questionCard,
  unavailableCard,
} from '../channels/wecom-cards.ts';
import { createWecom } from '../channels/wecom.ts';
import { DegradedError } from '../service/errors.ts';
import type { Question } from '../service/ledger.ts';
import { fixture, USER } from './helpers.ts';
import { startGateway } from './wecom-gateway.mjs';

const OWNER = 'zhang';
const approval = (questions: Question[]) => ({
  id: 'A1',
  task_title: '选库',
  questions_json: JSON.stringify(questions),
});

test('one question: a button per option, keyed by its position, and a way out', () => {
  const card = questionCard(approval([{ question: '用哪个？', options: ['甲', '乙'], recommend: 1, about: '影响发布' }]));
  assert.equal(card.card_type, 'button_interaction');
  assert.equal(card.main_title.title, '选库');
  assert.match(card.sub_title_text, /用哪个？/);
  assert.match(card.sub_title_text, /影响发布/);
  assert.deepEqual(card.button_list.map(({ text }) => text), ['甲', '乙', '其他…']);
  assert.deepEqual(card.button_list.map(({ key }) => key), ['approval:A1:q0:0', 'approval:A1:q0:1', 'approval:A1:other']);
  assert.deepEqual(card.button_list.map(({ style }) => style), [2, 1, 2]);
});

test('no options: the only button goes to the Console', () => {
  const card = questionCard(approval([{ question: '叫什么？' }]));
  assert.deepEqual(card.button_list.map(({ text, key }) => [text, key]), [['到 Console 回答', 'approval:A1:other']]);
});

test('several questions are all listed and offer no press that would be refused', () => {
  const card = questionCard(approval([{ question: '第一？', options: ['甲'] }, { question: '第二？', options: ['乙'] }]));
  assert.match(card.sub_title_text, /1\. 第一？/);
  assert.match(card.sub_title_text, /2\. 第二？/);
  assert.match(card.sub_title_text, /到 Console 回答/);
  assert.deepEqual(card.button_list.map(({ key }) => key), ['approval:A1:other']);
});

test('the Console-only button opens the configured public URL', () => {
  const card = questionCard(approval([{ question: '第一？' }, { question: '第二？' }]), undefined, 'https://console.example/');
  assert.deepEqual(card.button_list, [{
    text: '到 Console 回答', style: 2, key: 'approval:A1:other', type: 1, url: 'https://console.example/',
  }]);
});

test('options clipped to the same label leave only the Console entrance', () => {
  const card = questionCard(approval([{
    question: '选哪个？', options: ['完全相同的前十个字符甲', '完全相同的前十个字符乙'],
  }]), undefined, 'https://console.example/');
  assert.equal(card.button_list.length, 1);
  assert.equal(card.button_list[0]!.text, '到 Console 回答');
  assert.equal(card.button_list[0]!.url, 'https://console.example/');
});

test('more options than buttons: at most six buttons, and the card says there are more', () => {
  const options = ['一', '二', '三', '四', '五', '六', '七'];
  const card = questionCard(approval([{ question: '哪个？', options }]));
  assert.equal(card.button_list.length, 6);
  assert.match(card.sub_title_text, /另有 2 个选项/);
});

test('a label too long for a button is clipped there and readable in the text', () => {
  const long = '这是一个相当长的选项写不进按钮里';
  const card = questionCard(approval([{ question: '哪个？', options: [long, '短'] }]));
  assert.ok(card.button_list[0]!.text.length <= 11);
  assert.ok(card.sub_title_text.includes(`1. ${long}`));
});

test('a question too long for the card points to the full text', () => {
  const card = questionCard(approval([{ question: '长'.repeat(1000) }]));
  assert.ok(card.sub_title_text.length < 350);
  assert.match(card.sub_title_text, /全文到 Console 看/);
});

test('event keys parse back to what they were built from, and nothing else parses', () => {
  const [first, , other] = questionCard(approval([{ question: '？', options: ['甲', '乙'] }])).button_list;
  assert.deepEqual(parseEventKey(first!.key), { approvalId: 'A1', option: 0 });
  assert.deepEqual(parseEventKey(other!.key), { approvalId: 'A1' });
  for (const key of ['approval:A1:done', 'approval:A1:q1:0', 'approval:A1:q0:x', 'other', '', undefined, 7]) {
    assert.equal(parseEventKey(key), undefined);
  }
});

test('an option is found by position, and only on a one-question sheet', () => {
  const one = approval([{ question: '？', options: ['甲', '乙'] }]);
  assert.equal(optionOf(one, 1), '乙');
  assert.equal(optionOf(one, 2), undefined);
  assert.equal(optionOf(approval([{ question: '？', options: ['甲'] }, { question: '？' }]), 0), undefined);
});

test('the three result cards keep the card id and leave no live button', () => {
  const asked = questionCard(approval([{ question: '？', options: ['甲'] }]));
  const cards = [
    answeredCard({ id: 'A1', task_title: '选库' }, '甲'),
    closedCard({ id: 'A1', task_title: '选库', answered_via: 'console' }),
    unavailableCard('A1', '选库'),
    missingCard('A1'),
  ];
  for (const card of cards) {
    assert.equal(card.task_id, asked.task_id);
    assert.equal(parseEventKey(card.button_list[0]!.key), undefined);
  }
  assert.equal(cards[0]!.sub_title_text, '已回答：甲');
  assert.equal(cards[1]!.sub_title_text, '问题已关闭，已在 console 回答');
  assert.equal(closedCard({ id: 'A1', task_title: '选库', answered_via: null }).sub_title_text, '问题已关闭');
  assert.equal(cards[2]!.sub_title_text, '暂时无法记录，请稍后在 Console 回答');
});

async function pressing(t: TestContext, publicUrl = 'https://console.example/') {
  const gateway = await startGateway();
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const wecom = createWecom({
    url: gateway.url,
    botId: 'bot',
    secret: 's',
    publicUrl: () => publicUrl,
    ledger: f.ledger,
    createLoginUrl: () => '',
    loginValidity: () => '10 分钟',
    onMessage: () => {},
    log: () => {},
  });
  t.after(async () => {
    wecom.stop();
    await gateway.close();
  });
  wecom.start();
  await gateway.until(() => wecom.status().connected, '订阅');
  const open = (questions: Question[]) => f.ledger.openApproval(f.queuedTask().id, questions, USER);
  const press = async (key: string, who = OWNER) => {
    const count = gateway.sent('aibot_respond_update_msg').length;
    const reqId = gateway.press(who, key);
    await gateway.until(() => gateway.sent('aibot_respond_update_msg').length > count, '卡片更新');
    const frame = gateway.sent('aibot_respond_update_msg').at(-1)!;
    assert.equal(frame.headers.req_id, reqId);
    assert.equal(frame.body.response_type, 'update_template_card');
    return frame.body.template_card;
  };
  return { gateway, f, open, press };
}

test('a press answers the question and the card says so', async (t) => {
  const { f, open, press } = await pressing(t);
  const id = open([{ question: '用哪个？', options: ['甲', '乙'] }]);
  const card = await press(`approval:${id}:q0:1`);
  assert.equal(card.sub_title_text, '已回答：乙');
  const row = f.ledger.getApprovalCard(id)!;
  assert.equal(row.state, 'answered');
  assert.equal(row.answers_json, '["乙"]');
  assert.equal(row.answered_by, OWNER);
  assert.equal(row.answered_via, 'wecom');
});

test('a question answered elsewhere comes back closed, naming where', async (t) => {
  const { f, open, press } = await pressing(t);
  const id = open([{ question: '用哪个？', options: ['甲'] }]);
  f.ledger.answerApproval(id, ['甲'], 'console', 'console');
  const card = await press(`approval:${id}:q0:0`);
  assert.equal(card.sub_title_text, '问题已关闭，已在 console 回答');
  assert.equal(f.ledger.getApprovalCard(id)!.answered_via, 'console');
});

test('a ledger that cannot record the press says so and does not count as answered', async (t) => {
  const { f, open, press } = await pressing(t);
  const id = open([{ question: '用哪个？', options: ['甲'] }]);
  const real = f.ledger.answerApproval;
  let calls = 0;
  f.ledger.answerApproval = () => {
    calls += 1;
    throw new DegradedError('降级');
  };
  const card = await press(`approval:${id}:q0:0`);
  assert.equal(card.sub_title_text, '暂时无法记录，请稍后在 Console 回答');
  assert.equal(calls, 1);
  assert.equal(f.ledger.getApprovalCard(id)!.state, 'open');
  f.ledger.answerApproval = real;
});

test('the Console button keeps the question live and points the way', async (t) => {
  const { f, open, press } = await pressing(t);
  const id = open([{ question: '用哪个？', options: ['甲'] }]);
  const card = await press(`approval:${id}:other`);
  assert.match(card.sub_title_text, /请到 Console 回答/);
  assert.equal(card.button_list.length, 2);
  assert.equal(card.button_list[1]!.type, 1);
  assert.equal(card.button_list[1]!.url, `https://console.example/#/task/${f.ledger.getApprovalCard(id)!.task_id}`);
  assert.equal(f.ledger.getApprovalCard(id)!.state, 'open');
});

test('a key for an option that is not there answers nothing', async (t) => {
  const { f, open, press } = await pressing(t);
  const id = open([{ question: '用哪个？', options: ['甲'] }]);
  await press(`approval:${id}:q0:5`);
  assert.equal(f.ledger.getApprovalCard(id)!.state, 'open');
});

test('an Approval the ledger does not know closes the card', async (t) => {
  const { press } = await pressing(t);
  assert.equal((await press('approval:nope:q0:0')).sub_title_text, '问题已关闭');
});

test('a stranger pressing changes neither the question nor the card', async (t) => {
  const { gateway, f, open } = await pressing(t);
  const id = open([{ question: '用哪个？', options: ['甲'] }]);
  gateway.press('stranger', `approval:${id}:q0:0`);
  gateway.press(OWNER, 'approval:nothing');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.ledger.getApprovalCard(id)!.state, 'open');
  assert.equal(gateway.sent('aibot_respond_update_msg').length, 0);
});

test('an assign card has a button per candidate up to five, each pressing back to its message and project', () => {
  const id = '01M709JK793VZTEKGEP7Q0MTM0';
  const projects = Array.from({ length: 7 }, (_, index) => ({ id: `01M709JK793VZTEKGEP7Q0MTA${index}`, name: `项目${index + 1}` }));
  const card = assignCard({ id, code: 'MTM0', text: '这是哪个项目的', reason: 'none', projects }, 'https://tycho.example/#/');
  assert.equal(card.button_list.length, 6);
  assert.deepEqual(parseAssignKey(card.button_list[2]!.key), { messageId: id, projectId: projects[2]!.id });
  assert.equal(card.button_list[5]!.url, 'https://tycho.example/#/');
  assert.equal(parseAssignKey(card.button_list[5]!.key), undefined, '到控制台的那个按钮不是选择');
  assert.match(card.sub_title_text, /归 MTM0/);
  assert.match(card.sub_title_text, /7\. 项目7/);
});

test('knowledgeCard includes IM approve/reject command hint when publicUrl is absent', () => {
  const id = '01M709JK793VZTEKGEP7Q0ABCD';
  const ask = {
    id,
    title: '全局规范',
    action: '新建“全局规范”',
    scope: '全局 · 常驻',
    reasons: ['全局而且常驻'],
    proposedBy: '负责人',
    evidence: 1,
    verified: 1,
    whenToUse: '每轮生效',
  };
  const bare = knowledgeCard(ask);
  assert.match(bare.sub_title_text, /同意知识 ABCD/);
  assert.match(bare.sub_title_text, /驳回知识 ABCD/);
  const linked = knowledgeCard(ask, 'https://tycho.example');
  assert.doesNotMatch(linked.sub_title_text, /同意知识 ABCD/);
});

test('a card replaced after a press keeps the project\'s mark and the way to its page', async (t) => {
  const { f, open, press } = await pressing(t);
  const id = open([{ question: '用哪个？', options: ['甲', '乙'] }]);
  const card = await press(`approval:${id}:q0:1`);
  assert.equal(card.main_title.title, '【试跑】任务');
  assert.deepEqual(card.card_action, { type: 1, url: `https://console.example/#/task/${f.ledger.getApprovalCard(id)!.task_id}` });
  const unknown = await press('approval:nope:q0:0');
  assert.equal(unknown.main_title.title, '【系统】问题');
});

test('without an address a phone can reach, a replaced card says so instead of linking', async (t) => {
  const { open, press } = await pressing(t, '');
  const id = open([{ question: '用哪个？', options: ['甲'] }]);
  const card = await press(`approval:${id}:q0:0`);
  assert.equal(card.card_action, undefined);
  assert.match(card.sub_title_text, /^已回答：甲\n控制台：还没有配置对外地址，手机上打不开$/);
});

test('an assign card with few candidates still has its way to the console', () => {
  const id = '01M709JK793VZTEKGEP7Q0MTM0';
  const card = assignCard({ id, code: 'MTM0', text: '哪个项目', reason: 'none', projects: [{ id: '01M709JK793VZTEKGEP7Q0MTA0', name: '甲' }] }, 'https://tycho.example/#/');
  assert.deepEqual(card.button_list.map(({ text }) => text), ['甲', '到控制台归属']);
  assert.equal(card.button_list[1]!.url, 'https://tycho.example/#/');
  const bare = assignCard({ id, code: 'MTM0', text: '哪个项目', reason: 'none', projects: [{ id: '01M709JK793VZTEKGEP7Q0MTA0', name: '甲' }] });
  assert.equal(bare.button_list.length, 2, '没有地址也留着入口，卡片正文说明手机打不开');
});
