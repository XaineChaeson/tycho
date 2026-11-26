// Prevent a second native chat channel from borrowing WeCom identity, deduplication,
// pending messages or outbound transport. Same thread/actor strings are intentional:
// only the authoritative channel and the caller's namespaced bot distinguish them.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { shortCode } from '../service/front-desk.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { fixture, tune, USER } from './helpers.ts';

const OWNER = 'owner';
type Channel = 'wecom' | 'weixin';

function setup(t: TestContext) {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'wecom', 'weixin']);
  f.ledger.setWhitelist({ wecom: [OWNER], weixin: [OWNER], console: ['console'] }, USER);
  let seq = 0;
  const bot = (channel: Channel) => channel === 'weixin' ? 'weixin:bot' : 'bot';
  const say = (channel: Channel, text: string, externalId = `external-${++seq}`) => f.ledger.frontReceive({
    channel, bot: bot(channel), thread: OWNER, actor: OWNER, externalId, text, material: false,
  });
  const rows = (kind: string) => f.peek<OutboxRow>('SELECT * FROM outbox WHERE kind = ? ORDER BY rowid', kind);
  return { f, bot, say, rows };
}

test('the same external id is independent across channels and redelivers once within each', (t) => {
  const { f, say, rows } = setup(t);
  const wecom = say('wecom', '企微消息', 'same-id');
  const weixin = say('weixin', '微信消息', 'same-id');
  assert.notEqual(wecom.id, weixin.id);
  assert.equal(f.ledger.getMessage(wecom.id).channel, 'wecom');
  assert.equal(f.ledger.getMessage(weixin.id).channel, 'weixin');
  assert.deepEqual(rows('assign').map(row => row.channel), ['wecom', 'weixin']);
  assert.deepEqual(say('wecom', '重投', 'same-id'), { ...wecom, fresh: false });
  assert.deepEqual(say('weixin', '重投', 'same-id'), { ...weixin, fresh: false });
  assert.equal(rows('assign').length, 2);
});

test('receive, select and bind use their own whitelist and replies retain the originating channel', (t) => {
  const { f, bot, say, rows } = setup(t);
  f.ledger.setWhitelist({ wecom: [], weixin: [OWNER] }, USER);
  assert.equal(say('wecom', '进入 试跑').state, 'ignored');
  assert.equal(say('weixin', '进入 试跑').state, 'processed');
  assert.deepEqual(rows('markdown').map(row => row.channel), ['weixin']);
  assert.equal(f.ledger.frontCurrent(bot('weixin'), OWNER, OWNER), f.projectId);
  assert.equal(f.ledger.frontCurrent(bot('wecom'), OWNER, OWNER), null);
  const fields = { thread: OWNER, actor: OWNER, projectId: f.projectId };
  assert.throws(() => f.ledger.frontSelect({ ...fields, bot: bot('wecom') }), /无权/);
  assert.throws(() => f.ledger.frontBind({ ...fields, bot: bot('wecom') }), /无权/);
  f.ledger.frontSelect({ ...fields, channel: 'weixin', bot: bot('weixin') });
  f.ledger.frontBind({ ...fields, channel: 'weixin', bot: bot('weixin') });
  assert.equal(f.ledger.frontFixed(bot('weixin'), OWNER), f.projectId);
  f.ledger.setWhitelist({ wecom: [OWNER], weixin: [] }, USER);
  assert.equal(say('weixin', '新话题').state, 'ignored');
  assert.throws(() => f.ledger.frontSelect({ ...fields, channel: 'weixin', bot: bot('weixin') }), /无权/);
  assert.throws(() => f.ledger.frontBind({ ...fields, channel: 'weixin', bot: bot('weixin'), projectId: null }), /无权/);
  assert.equal(rows('markdown').length, 1);
});

test('explicit all-choice only assigns waiting messages in its channel and refuses another channel id', (t) => {
  const { f, bot, say } = setup(t);
  const wecom = say('wecom', '企微待归属');
  const first = say('weixin', '微信第一条');
  const second = say('weixin', '微信第二条');
  const chosen = f.ledger.frontChoose({ channel: 'weixin', bot: bot('weixin'), actor: OWNER, messageId: first.id, projectId: f.projectId, all: true });
  assert.deepEqual(chosen.ids, [first.id, second.id]);
  assert.equal(f.ledger.getMessage(wecom.id).state, 'unassigned');
  assert.equal(f.ledger.frontCurrent(bot('wecom'), OWNER, OWNER), null);
  assert.throws(() => f.ledger.frontChoose({ channel: 'weixin', bot: bot('weixin'), actor: OWNER, messageId: wecom.id, projectId: f.projectId }), /消息不存在/);
  assert.throws(() => f.ledger.frontChoose({ bot: bot('wecom'), actor: OWNER, messageId: first.id, projectId: f.projectId }), /消息不存在/);
});

test('typed choice searches pending codes and performs bulk assignment only in its originating channel', (t) => {
  const { f, bot, say, rows } = setup(t);
  const wecom = say('wecom', '企微待归属');
  const first = say('weixin', '微信第一条');
  const second = say('weixin', '微信第二条');
  say('weixin', `全归 ${shortCode(wecom.id)} 1`);
  assert.equal(f.ledger.getMessage(wecom.id).state, 'unassigned');
  assert.equal(f.ledger.getMessage(first.id).state, 'unassigned');
  assert.match(JSON.parse(rows('markdown').at(-1)!.payload_json).content, /找不到编号/);
  const picked = say('weixin', `全归 ${shortCode(first.id)} 1`);
  assert.deepEqual(picked.released, [first.id, second.id]);
  assert.equal(f.ledger.getMessage(wecom.id).state, 'unassigned');
  assert.equal(f.ledger.frontCurrent(bot('weixin'), OWNER, OWNER), f.projectId);
  assert.ok(rows('markdown').every(row => row.channel === 'weixin'));
});

test('approval answers record Weixin as their authority instead of borrowing the WeCom whitelist', (t) => {
  const { f, say } = setup(t);
  f.ledger.setWhitelist({ wecom: [], weixin: [OWNER] }, USER);
  const approval = f.ledger.openApproval(f.queuedTask().id, [{ question: '用哪个？', options: ['甲', '乙'] }], USER);
  assert.equal(say('weixin', `答 ${shortCode(approval)} 2`).state, 'processed');
  const card = f.ledger.getApprovalCard(approval)!;
  assert.equal(card.answered_via, 'weixin');
  assert.deepEqual(JSON.parse(card.answers_json!), ['乙']);
});

test('an explicit picker selection records the original text and releases its waiting message atomically once', (t) => {
  const { f, bot, say, rows } = setup(t);
  const waiting = say('weixin', '保留这条真正请求');
  const foreign = say('wecom', '另一渠道请求');
  const input = { channel: 'weixin' as const, bot: bot('weixin'), thread: OWNER, actor: OWNER, externalId: 'pick', text: '1', material: false,
    selection: { projectId: f.projectId, fixed: false, messageId: waiting.id } };
  const picked = f.ledger.frontReceive(input);
  assert.deepEqual(picked.released, [waiting.id]);
  assert.equal(f.ledger.getMessage(picked.id).text, '1');
  assert.equal(f.ledger.getMessage(picked.id).state, 'processed');
  assert.equal(f.ledger.getMessage(waiting.id).text, '保留这条真正请求');
  assert.equal(f.ledger.getMessage(waiting.id).state, 'received');
  assert.equal(f.ledger.getMessage(foreign.id).state, 'unassigned');
  const count = rows('markdown').length;
  assert.equal(f.ledger.frontReceive({ ...input, selection: { projectId: null, fixed: true } }).fresh, false);
  assert.equal(f.ledger.frontCurrent(bot('weixin'), OWNER, OWNER), f.projectId);
  assert.equal(rows('markdown').length, count);
});

test('a replayed project picker rebuilds its menu from the original command without recording or changing it twice', (t) => {
  const { f, bot, say } = setup(t);
  const first = say('weixin', '我想换个项目', 'picker');
  assert.deepEqual(first.projectMenu, { query: '' });
  const again = say('weixin', '进入 不应执行的项目', 'picker');
  assert.equal(again.fresh, false);
  assert.deepEqual(again.projectMenu, { query: '' });
  assert.equal(f.peek<{ n: number }>('SELECT count(*) AS n FROM message WHERE external_id=?', 'picker')[0]!.n, 1);
  assert.equal(f.ledger.getMessage(first.id).text, '我想换个项目');
  assert.equal(f.ledger.frontCurrent(bot('weixin'), OWNER, OWNER), null);
  const material = { channel: 'weixin' as const, bot: bot('weixin'), thread: OWNER, actor: OWNER, externalId: 'material-picker', text: '我想换个项目', material: true };
  f.ledger.frontReceive(material);
  assert.equal(f.ledger.frontReceive(material).projectMenu, undefined);
  assert.equal(f.ledger.frontReceive({ ...material, externalId: 'picker' }).projectMenu, undefined);
});

test('selection respects fixed bindings, permits explicit rebind and unbind, and never parses forwarded selections', (t) => {
  const { f, bot, say, rows } = setup(t);
  const other = f.ledger.createProject({ name: '另一个', loginMode: 'all' }, USER);
  let n = 0;
  const select = (selection: { projectId: string | null; fixed: boolean; messageId?: string }, material = false) => f.ledger.frontReceive({
    channel: 'weixin', bot: bot('weixin'), actor: OWNER, thread: OWNER, externalId: `pick-${++n}`, text: '原始控件文字', material, selection,
  });
  select({ projectId: f.projectId, fixed: true });
  select({ projectId: other, fixed: false });
  assert.equal(f.ledger.frontFixed(bot('weixin'), OWNER), f.projectId);
  assert.match(JSON.parse(rows('markdown').at(-1)!.payload_json).content, /固定|解绑/);
  select({ projectId: other, fixed: true });
  assert.equal(f.ledger.frontFixed(bot('weixin'), OWNER), other);
  select({ projectId: null, fixed: false });
  assert.equal(f.ledger.frontCurrent(bot('weixin'), OWNER, OWNER), null);
  assert.equal(f.ledger.frontFixed(bot('weixin'), OWNER), null);
  const forwarded = select({ projectId: other, fixed: true }, true);
  assert.equal(forwarded.state, 'unassigned');
  assert.equal(f.ledger.frontFixed(bot('weixin'), OWNER), null);
  const waiting = say('wecom', '另一渠道原消息');
  select({ projectId: other, fixed: false, messageId: waiting.id });
  assert.equal(f.ledger.getMessage(waiting.id).state, 'unassigned');
  assert.equal(f.ledger.frontCurrent(bot('weixin'), OWNER, OWNER), null);
  f.ledger.setWhitelist({ wecom: [OWNER], weixin: [] }, USER);
  assert.equal(select({ projectId: other, fixed: true }).state, 'ignored');
  assert.equal(f.ledger.frontFixed(bot('weixin'), OWNER), null);
});

test('only Weixin enabled still receives actual ready results, batched results and wait reminders through one business policy', (t) => {
  let owner = 'weixin:bot:owner';
  const f = fixture(t, { noticeTargets: () => [{ channel: 'weixin', target: { chatid: owner, chat_type: 1 } }],
    pushPolicy: () => ({ resultWindowMs: 1000, remindMs: 1000, remindMax: 1 }) });
  f.ledger.setChannels(['console', 'weixin']);
  const firstTask = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '微信验证交付', goal: '验证', acceptance: '交报告' }, USER);
  f.ledger.queueTask(firstTask.id, USER);
  const firstRun = f.ledger.createRun(firstTask.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(firstRun.id);
  const first = { task: f.task(firstTask.id), run: f.run(firstRun.id) };
  f.ledger.settleRun(first.run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  const results = () => f.peek<OutboxRow>("SELECT * FROM outbox WHERE channel='weixin' ORDER BY rowid");
  assert.equal(results()[0]!.kind, 'work_ready');
  assert.deepEqual(JSON.parse(results()[0]!.payload_json).target, { chatid: owner, chat_type: 1 });
  f.ledger.enqueueNotification('wecom', 'work_ready', { external_id: 'second-ready', task_id: first.task.id });
  assert.equal(results().length, 1, 'second result stays in the normal aggregation window');
  owner = 'weixin:replacement:owner';
  f.ledger.pushTick(new Date(Date.now() + 2000));
  assert.equal(results().length, 2);
  assert.deepEqual(JSON.parse(results()[0]!.payload_json).target, { chatid: 'weixin:bot:owner', chat_type: 1 }, 'queued destinations stay bound');
  assert.deepEqual(JSON.parse(results()[1]!.payload_json).target, { chatid: owner, chat_type: 1 });
  const approval = f.ledger.openApproval(f.queuedTask().id, [{ question: '继续吗？' }], USER);
  assert.equal(results().at(-1)!.kind, 'approval');
  f.ledger.pushTick(new Date(Date.now() + 4000));
  assert.equal(results().at(-1)!.kind, 'remind');
  assert.equal(JSON.parse(results().at(-1)!.payload_json).payload.approval_id, approval);
  assert.equal(f.peek<{ n: number }>('SELECT count(*) AS n FROM push WHERE level=?', 'wait')[0]!.n, 1);
});

test('a targeted WeCom reply and assignment never broadcast to an additional channel', (t) => {
  const f = fixture(t, { noticeTargets: () => [{ channel: 'weixin', target: { chatid: 'weixin:bot:owner', chat_type: 1 } }] });
  f.ledger.setChannels(['wecom', 'weixin']);
  f.ledger.setWhitelist({ wecom: [OWNER], weixin: [OWNER] }, USER);
  f.ledger.frontReceive({ bot: 'bot', actor: OWNER, thread: OWNER, externalId: 'wait', text: '未归属消息', material: false });
  f.ledger.frontReceive({ bot: 'bot', actor: OWNER, thread: OWNER, externalId: 'projects', text: '项目', material: false });
  assert.ok(f.peek<OutboxRow>('SELECT * FROM outbox').every(row => row.channel === 'wecom'));
});

test('only Weixin can deliver an owner-accepted report without a Router wake or duplicate settlement notice', (t) => {
  const f = fixture(t, { noticeTargets: () => [{ channel: 'weixin', target: { chatid: 'weixin:bot:owner', chat_type: 1 } }] });
  f.ledger.setChannels(['weixin']);
  tune(f.ledger, 'http.publicUrl', 'https://tycho.example');
  f.ledger.setProjectGrants(f.projectId, [], USER);
  const incoming = f.ledger.receiveMessage({ channel: 'console', externalId: 'request', actor: 'user', text: '验证完成后通知我，由我验收', projectId: f.projectId });
  f.ledger.takeNextTurn(f.projectId);
  const ctx = { actor: 'router', messageId: incoming.id };
  const task = f.ledger.createTask({ projectId: f.projectId, title: '微信验证', roleId: 'verify', goal: '验证', acceptance: '交报告', onReady: 'notify_owner' }, ctx);
  f.ledger.queueTask(task.id, ctx);
  f.ledger.finishMessage(incoming.id, 'processed');
  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: task.revision, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(run.id);
  const report = { status: 'done', summary: '验证完成', artifacts: [{ kind: 'report', ref: 'report.md' }] };
  assert.deepEqual(f.ledger.settleRun(run.id, 0, report), { late: false, task_state: 'ready' });
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
  assert.equal(f.ledger.listChanges({ taskId: task.id }).filter(row => row.action === 'run.ready_notice').length, 1);
  assert.equal(f.ledger.settleRun(run.id, 0, report).late, true);
  const notices = f.peek<OutboxRow>('SELECT * FROM outbox WHERE kind = ?', 'work_ready');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.channel, 'weixin');
  assert.throws(() => f.ledger.acceptTask(task.id, '通过', { actor: 'router' }), /没有授权/);
});
