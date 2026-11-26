// Guards against the WeCom front desk (docs/design/project-sessions.md §2) sending the owner's
// words to the wrong project: a current project shared between chats, senders or bots, or
// forgotten; a fixed phrase misread, or ordinary text that happens to hold a colon taken for one;
// forwarded or quoted material switching projects or naming objects; an object of another project
// not followed, or a conflict between what the owner named and what the text refers to settled by
// a guess instead of being put to the owner; a choice that assigns some messages and not others,
// moves the current project without releasing the message (or the other way round), or reaches
// into another chat's waiting messages; a correction landing after the Router took the message;
// a waiting message or its candidates lost over a restart; a redelivered command applied twice;
// an answer typed with a question's code reaching the current project instead of that question;
// and a stranger's text changing anything.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { shortCode } from '../service/front-desk.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { fixture, USER } from './helpers.ts';
import type { Fixture } from './helpers.ts';

const OWNER = 'zhang';
const BOT = 'bot';

function setup(t: TestContext) {
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const other = f.ledger.createProject({ name: '乙项目', loginMode: 'all' }, USER);
  let n = 0;
  const say = (text: string, fields: { thread?: string; actor?: string; bot?: string; material?: boolean; externalId?: string } = {}) =>
    f.ledger.frontReceive({
      bot: fields.bot ?? BOT,
      externalId: fields.externalId ?? `w${(n += 1)}`,
      actor: fields.actor ?? OWNER,
      thread: fields.thread ?? fields.actor ?? OWNER,
      text,
      material: fields.material ?? false,
    });
  const rows = (kind?: string): OutboxRow[] =>
    f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid').filter((row) => !kind || row.kind === kind);
  const said = (): string[] => rows('markdown').map((row) => (JSON.parse(row.payload_json) as { content: string }).content);
  const current = (thread = OWNER, actor = OWNER, bot = BOT) => f.ledger.frontCurrent(bot, thread, actor);
  return { f, other, say, rows, said, current };
}

const message = (f: Fixture, id: string) => f.ledger.getMessage(id);

test('进入 a project remembers it for this bot, chat and sender only, and says so once', (t) => {
  const { f, other, say, said, current } = setup(t);
  const entered = say('进入 乙项目', { externalId: 'enter' });
  assert.equal(current(), other);
  assert.equal(current('room', OWNER), null, '别的聊天不受影响');
  assert.equal(current(OWNER, OWNER, 'other-bot'), null, '别的机器人不受影响');
  assert.deepEqual([message(f, entered.id).state, message(f, entered.id).project_id], ['processed', null], '命令记账，不交给负责人');
  assert.deepEqual(entered.released, []);
  assert.equal(said().length, 1);
  assert.match(said()[0]!, /已进入/);
  // Redelivered: the same row, nothing applied or said again.
  say('进入 试跑', { externalId: 'enter' });
  assert.equal(current(), other);
  assert.equal(said().length, 1);
});

test('what the owner writes goes to the current project, by that as its basis', (t) => {
  const { f, other, say, current } = setup(t);
  say('进入 乙项目');
  const written = say('把登录页修一下');
  const row = message(f, written.id);
  assert.deepEqual([row.state, row.project_id, row.basis], ['received', other, 'current']);
  assert.equal(current(), other);
  assert.equal(f.ledger.takeNextTurn(other)!.message.id, written.id);
});

test('with no current project a message waits, its candidates every project, asked about once', (t) => {
  const { f, other, say, rows } = setup(t);
  const waiting = say('这是哪个项目的');
  const row = message(f, waiting.id);
  assert.deepEqual([row.state, row.project_id], ['unassigned', null]);
  assert.deepEqual(JSON.parse(row.candidates_json!), { reason: 'none', projects: [f.projectId, other] });
  assert.equal(rows('assign').length, 1);
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
  assert.equal(f.ledger.takeNextTurn(other), undefined);
});

test('"<项目名>：" switches and goes there; a colon before no project\'s name is ordinary text', (t) => {
  const { f, other, say, current } = setup(t);
  say('进入 试跑');
  const named = say('乙项目：跑一下回归');
  assert.deepEqual([message(f, named.id).project_id, message(f, named.id).basis], [other, 'owner']);
  assert.equal(current(), other);
  const plain = say('注意：明天再说');
  assert.deepEqual([message(f, plain.id).project_id, message(f, plain.id).basis], [other, 'current']);
});

test('a Task or a Run written out goes to its project and leaves the current one as it was', (t) => {
  const { f, other, say, current } = setup(t);
  say('进入 试跑');
  const theirs = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '乙的', goal: '目标', acceptance: '验收' }, USER);
  const byTask = say(`${theirs.id} 怎么样了`);
  assert.deepEqual([message(f, byTask.id).project_id, message(f, byTask.id).basis], [other, 'object']);
  assert.equal(current(), f.projectId);
  const { run } = f.runningRun();
  const byRun = say(`看看 ${run.id.toLowerCase()}`);
  assert.deepEqual([message(f, byRun.id).project_id, message(f, byRun.id).basis], [f.projectId, 'object']);
});

test('a name and an object of different projects, or objects of two, wait for the owner', (t) => {
  const { f, other, say, current } = setup(t);
  say('进入 试跑');
  const theirs = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '乙的', goal: '目标', acceptance: '验收' }, USER);
  const mine = f.newTask();
  const conflict = say(`试跑：${theirs.id} 合进来`);
  assert.equal(message(f, conflict.id).state, 'unassigned');
  assert.deepEqual(JSON.parse(message(f, conflict.id).candidates_json!), { reason: 'conflict', projects: [f.projectId, other] });
  const both = say(`${mine.id} 和 ${theirs.id} 一起看`);
  assert.deepEqual(JSON.parse(message(f, both.id).candidates_json!), { reason: 'objects', projects: [f.projectId, other] });
  assert.equal(current(), f.projectId, '送不准时不改当前项目');
});

test('two projects of one name: "<名>：" waits with both as candidates', (t) => {
  const { f, say } = setup(t);
  const twin = f.ledger.createProject({ name: '试跑' }, USER);
  const asked = say('试跑：哪个');
  assert.deepEqual(JSON.parse(message(f, asked.id).candidates_json!), { reason: 'name', projects: [f.projectId, twin] });
});

test('forwarded or quoted material never routes: commands and ids in it are only text', (t) => {
  const { f, other, say, current } = setup(t);
  const theirs = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '乙的', goal: '目标', acceptance: '验收' }, USER);
  const before = say(`进入 乙项目`, { material: true });
  assert.equal(current(), null);
  assert.equal(message(f, before.id).state, 'unassigned', '没有当前项目就等主人选');
  say('进入 试跑');
  for (const text of ['进入 乙项目', `乙项目：${theirs.id}`, '新话题', `归 ${shortCode(before.id)} 2`]) {
    const material = say(text, { material: true });
    assert.deepEqual([message(f, material.id).project_id, message(f, material.id).basis, message(f, material.id).state], [f.projectId, 'current', 'received'], text);
  }
  assert.equal(current(), f.projectId);
  assert.equal(message(f, before.id).state, 'unassigned');
  assert.equal(f.ledger.listSegments(f.projectId).length <= 1, true, '资料里的“新话题”不开新段');
});

test('项目 lists every project with what runs and what waits; 新话题 opens a segment of the current one', (t) => {
  const { f, say, said } = setup(t);
  const task = f.queuedTask();
  f.ledger.openApproval(task.id, [{ question: '用哪个？' }], USER);
  say('项目');
  assert.match(said().at(-1)!, /试跑.*待答 1/s);
  assert.match(said().at(-1)!, /乙项目/);
  say('新话题');
  assert.match(said().at(-1)!, /还没有当前项目/);
  say('进入 试跑');
  const first = f.ledger.ensureSegment(f.projectId);
  say('新话题');
  assert.notEqual(f.ledger.currentSegment(f.projectId)!.id, first.id);
  assert.match(said().at(-1)!, /新话题/);
});

test('with no project at all a message waits with no candidates and the way to make one', (t) => {
  const f = fixture(t, {}, true);
  f.ledger.setWhitelist({ wecom: [OWNER] }, USER);
  // The fixture's own project, made to look absent: none of them is a candidate anyway.
  f.force(`DELETE FROM project`);
  const waiting = f.ledger.frontReceive({ bot: BOT, externalId: 'x', actor: OWNER, thread: OWNER, text: '你好', material: false });
  assert.deepEqual(JSON.parse(f.ledger.getMessage(waiting.id).candidates_json!), { reason: 'none', projects: [] });
});

test('归 <码> <序号> gives this one message its project, makes it current and releases it, together', (t) => {
  const { f, other, say, current, said } = setup(t);
  const first = say('甲');
  const second = say('乙');
  const chose = say(`归 ${shortCode(first.id).toLowerCase()} 2`);
  assert.deepEqual(chose.released, [first.id]);
  assert.deepEqual([message(f, first.id).state, message(f, first.id).project_id, message(f, first.id).basis], ['received', other, 'owner']);
  assert.equal(message(f, second.id).state, 'unassigned', '只归这一条');
  assert.equal(current(), other);
  assert.match(said().at(-1)!, /已归到/);
  assert.equal(message(f, chose.id).state, 'processed');
});

test('全归 gives every waiting message of this chat and sender the project, and no one else\'s', (t) => {
  const { f, other, say } = setup(t);
  const first = say('甲');
  const second = say('乙');
  const elsewhere = say('丙', { thread: 'room' });
  const chose = say(`全归 ${shortCode(second.id)} 乙项目`);
  assert.deepEqual(new Set(chose.released), new Set([first.id, second.id]));
  assert.equal(message(f, elsewhere.id).state, 'unassigned');
  assert.equal(f.ledger.frontCurrent(BOT, 'room', OWNER), null);
  assert.equal(message(f, first.id).project_id, other);
});

test('a choice with a code that matches nothing, or a number past the list, changes nothing and says why', (t) => {
  const { f, say, said, current } = setup(t);
  const waiting = say('甲');
  say('归 ZZZZ 1');
  assert.match(said().at(-1)!, /找不到/);
  say(`归 ${shortCode(waiting.id)} 9`);
  assert.match(said().at(-1)!, /没有第 9 个/);
  assert.equal(message(f, waiting.id).state, 'unassigned');
  assert.equal(current(), null);
});

test('a correction before the Router takes the message moves it; after, it stays and says what stands', (t) => {
  const { f, other, say, current, said } = setup(t);
  const waiting = say('甲');
  f.ledger.frontChoose({ bot: BOT, messageId: waiting.id, projectId: f.projectId, actor: OWNER });
  // Not taken yet: the owner may still move it.
  f.ledger.frontChoose({ bot: BOT, messageId: waiting.id, projectId: other, actor: OWNER });
  assert.equal(message(f, waiting.id).project_id, other);
  assert.equal(f.ledger.takeNextTurn(other)!.message.id, waiting.id);
  assert.throws(() => f.ledger.frontChoose({ bot: BOT, messageId: waiting.id, projectId: f.projectId, actor: OWNER }), /已经被.*取走/);
  assert.equal(message(f, waiting.id).project_id, other);
  assert.equal(current(), other, '被拒的选择不改当前项目');
  say(`归 ${shortCode(waiting.id)} 1`);
  assert.match(said().at(-1)!, /已经被.*取走/);
});

test('one taken among several refuses the whole choice', (t) => {
  const { f, other, say, current } = setup(t);
  const first = say('甲');
  const second = say('乙');
  f.ledger.frontChoose({ bot: BOT, messageId: first.id, projectId: other, actor: OWNER });
  f.ledger.takeNextTurn(other);
  // The one pressed on is taken: the others it would have carried along stay as they were.
  assert.throws(() => f.ledger.frontChoose({ bot: BOT, messageId: first.id, projectId: f.projectId, actor: OWNER, all: true }), /取走/);
  assert.equal(message(f, second.id).state, 'unassigned');
  assert.equal(current(), other);
});

test('a waiting message and its candidates outlast a restart, and the choice works after it', (t) => {
  const { f, other, say } = setup(t);
  const waiting = say('甲');
  f.ledger.close();
  const reopened = f.open();
  assert.deepEqual(reopened.unassignedMessages().map(({ id }) => id), [waiting.id]);
  assert.deepEqual(JSON.parse(reopened.getMessage(waiting.id).candidates_json!).projects, [f.projectId, other]);
  assert.equal(reopened.outbox.counts().pending, 1, '问主人的那一条还在');
  const chose = reopened.frontReceive({ bot: BOT, externalId: 'after', actor: OWNER, thread: OWNER, text: `归 ${shortCode(waiting.id)} 2`, material: false });
  assert.deepEqual(chose.released, [waiting.id]);
  assert.equal(reopened.frontCurrent(BOT, OWNER, OWNER), other);
});

test('答 <码> answers that question, in its project, and leaves the current project alone', (t) => {
  const { f, other, say, current } = setup(t);
  say('进入 乙项目');
  const task = f.queuedTask();
  const id = f.ledger.openApproval(task.id, [{ question: '用哪个？', options: ['甲', '乙'] }], USER);
  const answered = say(`答 ${shortCode(id)} 2`);
  assert.deepEqual(JSON.parse(f.ledger.getApprovalCard(id)!.answers_json!), ['乙']);
  assert.equal(f.ledger.getApprovalCard(id)!.answered_via, 'wecom');
  assert.equal(message(f, answered.id).state, 'processed');
  assert.equal(current(), other);
  assert.equal(f.ledger.takeNextTurn(other), undefined, '不进当前项目的负责人');
  const free = f.ledger.openApproval(f.queuedTask().id, [{ question: '叫什么？' }], USER);
  say(`答 ${shortCode(free)} 就叫甲`);
  assert.deepEqual(JSON.parse(f.ledger.getApprovalCard(free)!.answers_json!), ['就叫甲']);
});

test('a question of several parts is answered in the console, not by a typed line', (t) => {
  const { f, say, said } = setup(t);
  const id = f.ledger.openApproval(f.queuedTask().id, [{ question: '一？' }, { question: '二？' }], USER);
  say(`答 ${shortCode(id)} 都行`);
  assert.equal(f.ledger.getApprovalCard(id)!.state, 'open');
  assert.match(said().at(-1)!, /到控制台/);
});

test('a stranger changes nothing and hears nothing, whatever they write', (t) => {
  const { f, say, current, rows } = setup(t);
  const waiting = say('甲');
  const before = rows().length;
  const stranger = say(`归 ${shortCode(waiting.id)} 1`, { actor: 'li', thread: OWNER });
  assert.equal(message(f, stranger.id).state, 'ignored');
  say('进入 试跑', { actor: 'li', thread: OWNER });
  assert.equal(message(f, waiting.id).state, 'unassigned');
  assert.equal(current(), null);
  assert.equal(f.ledger.frontCurrent(BOT, OWNER, 'li'), null);
  assert.equal(rows().length, before);
});

test('"<项目名>：" finds a project by its whole name, however long', (t) => {
  const { f, say, current } = setup(t);
  say('进入 试跑');
  const name = '乙'.repeat(60);
  const long = f.ledger.createProject({ name }, USER);
  const named = say(`${name}：请执行`);
  assert.deepEqual([message(f, named.id).project_id, message(f, named.id).basis], [long, 'owner']);
  assert.equal(current(), long);
});

// A message into a paused project would otherwise wait with no answer at all (project-sessions §5).
test('a message into a paused project is kept and the owner is told at once why no answer comes; 项目 marks it', (t) => {
  const { f, other, say, said } = setup(t);
  say('进入 乙项目');
  f.ledger.setProjectPaused(other, true, USER);
  const written = say('把登录页修一下');
  assert.deepEqual([message(f, written.id).state, message(f, written.id).project_id], ['received', other]);
  assert.match(said().at(-1)!, /项目已暂停：这条消息记下了，恢复后处理/);
  say('项目');
  assert.match(said().at(-1)!, /乙项目（当前）（已暂停）/);
  f.ledger.setProjectPaused(other, false, USER);
  const count = said().length;
  say('再说一句');
  assert.equal(said().length, count, '恢复以后不再提示');
});

// An archived project is out of sight and out of the ways of choosing one, but a message that
// names an object in it still goes there (project-sessions, "项目的生命周期").
test('an archived project is out of 项目 and 进入, a current one counts as none, yet a named task still goes there', (t) => {
  const { f, other, say, said, current } = setup(t);
  say('进入 乙项目');
  const task = f.ledger.createTask({ projectId: other, roleId: 'implement', title: '归档前的工作', goal: '做', acceptance: '好' }, USER);
  f.ledger.setProjectArchived(other, true, USER);
  assert.equal(current(), null, '当前项目已归档：当作没有当前项目');
  say('项目');
  const list = said().at(-1)!;
  assert.match(list, /试跑/);
  assert.doesNotMatch(list, /乙项目/, '已归档的不在列表里');
  say('进入 乙项目');
  assert.match(said().at(-1)!, /没有叫“乙项目”的项目/, '不能按名字切到已归档的项目');
  assert.equal(current(), null);
  // Naming a task of it still puts the message there, and says why no answer comes.
  const named = say(`关于 ${task.id} 的改动`);
  assert.deepEqual([message(f, named.id).state, message(f, named.id).project_id], ['received', other]);
  assert.match(said().at(-1)!, /项目已归档：这条消息记下了，恢复后处理/);
  // Ordinary text with no current project waits for a project, and the candidates are the ones in sight.
  const loose = say('随便说说');
  assert.equal(message(f, loose.id).state, 'unassigned');
  assert.deepEqual((JSON.parse(message(f, loose.id).candidates_json!) as { projects: string[] }).projects, [f.projectId]);
  f.ledger.setProjectArchived(other, false, USER);
  assert.equal(current(), other, '恢复后这个聊天仍记得它');
});

// "There are no projects" and "every project is archived" ask different things of the owner
// (project-sessions, "项目的生命周期"): the second is not a reason to make the first one again.
test('with every project archived, 项目 and 进入 say so instead of that there are none', (t) => {
  const { f, other, say, said } = setup(t);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  f.ledger.setProjectArchived(other, true, USER);
  say('项目');
  assert.match(said().at(-1)!, /^项目都归档了：到控制台恢复一个，或者新建一个$/);
  assert.doesNotMatch(said().at(-1)!, /还没有项目/);
  say('进入 试跑');
  assert.match(said().at(-1)!, /^项目都归档了：到控制台恢复一个，或者新建一个$/);
  assert.doesNotMatch(said().at(-1)!, /还没有项目/);
});

test('固定聊天隔离项目，解绑清除临时选择并拒绝跨项目消息', (t) => {
  const { f, other, say, current } = setup(t);
  say('进入 试跑', { thread: 'room' });
  f.ledger.frontBind({ bot: BOT, thread: 'room', actor: OWNER, projectId: other });
  assert.equal(current('room'), other);
  assert.equal(current('room2'), null);
  const conflict = say('试跑：不应投递', { thread: 'room' });
  assert.equal(message(f, conflict.id).state, 'processed');
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
  f.ledger.frontBind({ bot: BOT, thread: 'room', actor: OWNER, projectId: null });
  assert.equal(current('room'), null);
  f.ledger.frontBind({ bot: BOT, thread: 'room', actor: OWNER, projectId: f.projectId });
  assert.equal(current('room'), f.projectId);
});

test('固定项目归档时暂存消息并允许换绑，删除后聊天仍可用', (t) => {
  const { f, other, say } = setup(t);
  f.ledger.frontBind({ bot: BOT, thread: 'room', actor: OWNER, projectId: other });
  f.ledger.frontBind({ bot: BOT, thread: 'room2', actor: OWNER, projectId: other });
  f.ledger.setProjectArchived(other, true, USER);
  const held = say('等待恢复', { thread: 'room' });
  assert.deepEqual([message(f, held.id).state, message(f, held.id).project_id], ['unassigned', null]);
  f.ledger.frontBind({ bot: BOT, thread: 'room', actor: OWNER, projectId: f.projectId });
  assert.equal(message(f, say('新的消息', { thread: 'room' }).id).project_id, f.projectId);
  f.ledger.deleteProject(other, '乙项目', USER);
  assert.equal(f.ledger.frontFixed(BOT, 'room'), f.projectId);
  assert.equal(f.ledger.frontFixed(BOT, 'room2'), null);
  f.ledger.frontBind({ bot: BOT, thread: 'room2', actor: OWNER, projectId: f.projectId });
  assert.equal(f.ledger.frontFixed(BOT, 'room2'), f.projectId);
});

test('固定项目归档后普通消息等待重新归属', (t) => {
  const { f } = setup(t);
  f.ledger.frontBind({ bot: BOT, thread: OWNER, actor: OWNER, projectId: f.projectId });
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const received = f.ledger.frontReceive({ bot: BOT, externalId: 'archived-fixed', actor: OWNER, thread: OWNER, text: '继续', material: false });
  assert.equal(received.state, 'unassigned');
});

test('IM commands 验, 继, 同意知识, and 驳回知识 operate cleanly for whitelisted owner and enforce review gate', (t) => {
  const { f, say, said } = setup(t);
  // 1. 验 accepts a non-review ready task, refuses a review-gated ready task
  const verifyTask = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '验证项', goal: '验', acceptance: '交报告' }, USER);
  f.ledger.queueTask(verifyTask.id, USER);
  const vRun = f.ledger.createRun(verifyTask.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(vRun.id);
  f.ledger.settleRun(vRun.id, 0, { status: 'done', summary: 'ok', artifacts: [{ kind: 'report', ref: 'r.md' }] });

  const acceptCmd = say(`验 ${shortCode(verifyTask.id)} 没问题`);
  assert.equal(acceptCmd.state, 'processed');
  assert.equal(f.task(verifyTask.id).state, 'done');
  assert.match(said().at(-1)!, /已验收通过：验证项/);

  const { task: gatedTask, run: gatedRun } = f.runningRun();
  f.ledger.settleRun(gatedRun.id, 0, { status: 'done', summary: '改好', artifacts: [{ kind: 'commit', ref: 'abc' }, { kind: 'report', ref: 'r.md' }] });
  say(`验 ${shortCode(gatedTask.id)}`);
  assert.equal(f.task(gatedTask.id).state, 'ready', '未过审阅的任务不能在 IM 直接验收');
  assert.match(said().at(-1)!, /独立审阅/);

  // 2. 继 resumes a held task
  const heldTask = f.queuedTask();
  f.ledger.holdTask(heldTask.id, '先停一下', USER);
  say(`继 ${shortCode(heldTask.id)}`);
  assert.equal(f.task(heldTask.id).state, 'queued');
  assert.match(said().at(-1)!, /已继续任务/);

  // 3. 同意知识 / 驳回知识 decide awaiting_owner proposals directly from IM
  const makeProposal = (key: string, title: string) => {
    const { id } = f.ledger.propose(
      {
        kind: 'knowledge',
        inputs: [],
        outputs: [{ key, title, when_to_use: '全局', body: `正文-${title}`, project_ids: null, loading: 'resident', roles: [] }],
        why: { when: '下次', changes: '改动作', generalizes: '三次反例，边界清晰' },
        evidence: [{ source: 'owner', ref: `m-${key}`, location: `msg-${key}`, excerpt: '原话' }],
      },
      { source: 'mcp', by: 'external', client: `mcp:${key}`, writers: [] },
      USER,
    );
    f.force(`UPDATE knowledge_proposal SET state = 'awaiting_owner' WHERE id = ?`, id);
    return id;
  };
  const pApprove = makeProposal('k1', '全局约定甲');
  const pReject = makeProposal('k2', '全局约定乙');
  say(`同意知识 ${shortCode(pApprove)}`);
  assert.equal(f.ledger.getProposal(pApprove).state, 'published');
  assert.match(said().at(-1)!, /已同意并生效知识提议/);

  say(`驳回知识 ${shortCode(pReject)} 范围太大`);
  assert.equal(f.ledger.getProposal(pReject).state, 'rejected');
  assert.match(said().at(-1)!, /已驳回知识提议.*范围太大/);

  // Stranger cannot execute any IM command
  const otherHeld = f.queuedTask();
  f.ledger.holdTask(otherHeld.id, '停', USER);
  const stranger = say(`继 ${shortCode(otherHeld.id)}`, { actor: 'stranger', thread: 'stranger' });
  assert.equal(stranger.state, 'ignored');
  assert.equal(f.task(otherHeld.id).state, 'held');
});
