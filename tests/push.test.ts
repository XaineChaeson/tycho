// Guards against the owner not being reached the way docs/design/project-sessions.md §2.1 says:
// whether something is pushed decided by what the Router's reply says rather than by the kind of
// ledger event, so a question, a Task the rules stopped, a refused login or a knowledge change
// waiting for the owner is missed, or progress (a start, a retry, an ordinary settlement) is
// pushed; a waiting item never reminded, reminded past the limit, or reminded after it was dealt
// with — also when it was dealt with between the reminder being queued and being sent; results of
// one project each sent alone inside the window, merged with another project's, or held back with
// nothing after them; a result that exists only once a Router has taken its event (a Router that
// is missing, signed out or resting must not keep the owner from hearing it), or the Router's
// sentence creating a result instead of only adding to one; the daily brief sent when nothing changed, listing projects where nothing
// changed, or not sent when it is off. And against a push not saying which project it is about or
// where to look: every one starts with 【项目名】 or 【系统】 and ends with the page, without any
// token, and says so plainly when no address a phone can reach is set.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createNotify } from '../service/notify.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { fixture, LOGIN, RUN_LIMIT_MS, USER } from './helpers.ts';
import type { Fixture } from './helpers.ts';

const OWNER = 'zhang';
const MINUTE = 60_000;
const DONE = { status: 'done', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] };

function setup(t: TestContext, publicUrl = 'https://tycho.example') {
  const policy = { remindMs: 30 * MINUTE, remindMax: 2, resultWindowMs: 10 * MINUTE };
  const f = fixture(t, { pushPolicy: () => policy });
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER, publicUrl: () => publicUrl, direct: async () => {} });
  const rows = (kind?: string): OutboxRow[] =>
    f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid').filter((row) => !kind || row.kind === kind);
  const texts = (kind?: string): string[] => rows(kind).flatMap((row) => {
    const out = notify.render(row);
    if (!out) return [];
    return [out.body.msgtype === 'markdown' ? out.body.markdown.content : JSON.stringify(out.body.template_card)];
  });
  const later = (ms: number): Date => new Date(Date.now() + ms);
  return { f, policy, notify, rows, texts, later };
}

// A Task that is all its work, settled done: its work is ready, and the Router is told.
function readyWork(f: Fixture, projectId = f.projectId) {
  const task = f.ledger.createTask({ roleId: 'verify', projectId, title: `交付-${Math.random().toString(36).slice(2, 6)}`, goal: '目标', acceptance: '通过' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS } }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE);
  const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
  return { task, run, event };
}

const replyTo = (f: Fixture, event: ReturnType<typeof readyWork>['event'], text: string) =>
  f.ledger.writeOutbound({ channel: event.channel, thread: event.thread, text, final: true, replyTo: event.id });

test('a question is pushed at once as a card, marked with its project and pointing at its Task', (t) => {
  const { f, texts } = setup(t);
  const task = f.queuedTask();
  f.ledger.openApproval(task.id, [{ question: '用哪个？', options: ['甲'] }], USER);
  const [card] = texts('approval');
  assert.match(card!, /【试跑】任务/);
  assert.match(card!, new RegExp(`https://tycho\\.example/#/task/${task.id}`));
});

test('progress is not pushed: a start, a lost round continuing, an ordinary settlement, whatever the Router replies', (t) => {
  const { f, notify, rows } = setup(t);
  const { run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  f.ledger.settleRun(run.id, null, null, { kind: 'lost', lost: { basis: 'presumed' } });
  const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
  notify.finalReply(event, replyTo(f, event, '需要你核实，等你决定'));
  assert.equal(rows().length, 0);
});

test('a Task the rules stopped waits for the owner: pushed at once with its reason, not when held by hand', (t) => {
  const { f, texts } = setup(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null);
  const [held] = texts('held');
  assert.match(held!, /^【试跑】.*停住.*任务/s);
  assert.match(held!, /进程退出码 1/);
  const byHand = f.queuedTask();
  f.ledger.holdTask(byHand.id, '先放着', { actor: 'router' });
  assert.equal(texts('held').length, 1, '负责人或主人自己挂起的不推');
});

test('a waiting item is reminded at the interval, at most the set number of times', (t) => {
  const { f, policy, rows, texts, later } = setup(t);
  const id = f.ledger.openApproval(f.queuedTask().id, [{ question: '用哪个？' }], USER);
  f.ledger.pushTick(later(policy.remindMs - MINUTE));
  assert.equal(rows().length, 1, '没到间隔不提醒');
  f.ledger.pushTick(later(policy.remindMs + 1));
  assert.equal(rows().length, 2);
  assert.match(texts().at(-1)!, /^【试跑】再次提醒（1\/2）.*问题还没回答/s);
  assert.match(texts().at(-1)!, new RegExp(`答 ${id.slice(-4)}`));
  f.ledger.pushTick(later(policy.remindMs + 2));
  assert.equal(rows().length, 2, '间隔从上一次提醒算');
  f.ledger.pushTick(later(2 * policy.remindMs + 10));
  f.ledger.pushTick(later(3 * policy.remindMs + 20));
  f.ledger.pushTick(later(4 * policy.remindMs + 30));
  assert.equal(rows().length, 3, '提醒次数有上限');
});

test('an item dealt with is not reminded; a limit of zero reminds nothing', (t) => {
  const { f, policy, rows, later } = setup(t);
  const id = f.ledger.openApproval(f.queuedTask().id, [{ question: '用哪个？' }], USER);
  f.ledger.answerApproval(id, ['甲'], 'console', 'console');
  const before = rows().length;
  f.ledger.pushTick(later(policy.remindMs + 1));
  assert.equal(rows().length, before);
  policy.remindMax = 0;
  f.ledger.openApproval(f.queuedTask().id, [{ question: '再问？' }], USER);
  f.ledger.pushTick(later(policy.remindMs + 1));
  assert.equal(rows('approval').length, 2, '只有提问本身');
  assert.equal(rows().length, before + 1);
});

test('a result is pushed at settlement in the service\'s words, with no Router taking its event; more in the window go out as one', (t) => {
  const { f, policy, rows, texts, later } = setup(t);
  const first = readyWork(f);
  assert.equal(first.event.state, 'received', '没有负责人取走这条事件');
  assert.equal(rows().length, 1);
  assert.match(texts()[0]!, new RegExp(`^【试跑】${first.task.title} 做完了，等你验收`));
  assert.match(texts()[0]!, /https:\/\/tycho\.example\/#\/work\//);
  const more = [readyWork(f), readyWork(f)];
  assert.equal(rows().length, 1, '窗口内的先攒着');
  f.ledger.pushTick(later(policy.resultWindowMs - MINUTE));
  assert.equal(rows().length, 1);
  f.ledger.pushTick(later(policy.resultWindowMs + 1));
  assert.equal(rows().length, 2);
  assert.match(texts()[1]!, new RegExp(`^【试跑】.*2 项成果.*${more[0]!.task.title}.*${more[1]!.task.title}`, 's'));
});

test('the Router\'s sentence only adds to a result not yet sent; it never makes one', (t) => {
  const { f, notify, policy, rows, texts, later } = setup(t);
  const first = readyWork(f);
  const held = readyWork(f);
  notify.finalReply(held.event, replyTo(f, held.event, '导出修好了，等你验收。\n\n细节在报告里。'));
  // Already out: the sentence comes too late to change it, and adds no second message.
  notify.finalReply(first.event, replyTo(f, first.event, '登录页修好了'));
  assert.equal(rows().length, 1);
  f.ledger.pushTick(later(policy.resultWindowMs + 1));
  assert.equal(rows().length, 2);
  assert.match(texts()[1]!, /导出修好了，等你验收。/);
  assert.doesNotMatch(texts()[1]!, /细节在报告里/, '只取一句');
  // A reply to an event that made no result makes none.
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null);
  const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
  notify.finalReply(event, replyTo(f, event, '做完了，等你验收'));
  f.ledger.pushTick(later(3 * policy.resultWindowMs));
  assert.equal(rows().filter(({ kind }) => kind === 'work_ready' || kind === 'results').length, 2);
});

test('results of different projects are never merged', (t) => {
  const { f, rows } = setup(t);
  const other = f.ledger.createProject({ name: '乙项目', loginMode: 'all' }, USER);
  for (const projectId of [f.projectId, other]) readyWork(f, projectId);
  assert.equal(rows().length, 2, '各项目各自立即推');
});

test('a reminder that was dealt with before it went out is not sent', (t) => {
  const { f, policy, rows, notify, later } = setup(t);
  const { run, task } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null);
  f.ledger.pushTick(later(policy.remindMs + 1));
  const [reminder] = rows('remind');
  assert.ok(reminder, '到了间隔，提醒入队');
  f.ledger.resumeTask(task.id, USER);
  assert.equal(notify.render(reminder), undefined, '发出之前任务已经继续了');
  assert.equal(notify.skipReason(reminder), '已处理');
});

test('merging a Task\'s product is a result of its project', (t) => {
  const { f, texts } = setup(t);
  const { task, run } = f.runningRun();
  f.ledger.noteAction('task.integrate', USER, { taskId: task.id, runId: run.id }, { branch: 'main', commit: 'c0ffee' });
  assert.match(texts('integrated')[0]!, /^【试跑】已并入 main/);
});

test('a notice about no project is marked 【系统】; without a public address it says a phone cannot open the page', (t) => {
  const { notify, texts } = setup(t, '');
  notify.started();
  assert.match(texts()[0]!, /^【系统】服务已启动/);
  assert.match(texts()[0]!, /手机上打不开/);
  assert.doesNotMatch(texts()[0]!, /token|login\//);
});

test('a reply to the owner in a project carries its mark and the way to its conversation', (t) => {
  const { f, notify, texts } = setup(t);
  const { id } = f.ledger.receiveMessage({ channel: 'wecom', externalId: 'w1', actor: OWNER, thread: OWNER, text: '你好', projectId: f.projectId });
  const inbound = f.ledger.getMessage(id);
  notify.finalReply(inbound, f.ledger.writeOutbound({ channel: 'wecom', thread: OWNER, text: '在', final: true, replyTo: id }));
  assert.match(texts()[0]!, /^【试跑】在/);
  assert.match(texts()[0]!, new RegExp(`https://tycho\\.example/#/projects/${f.projectId}\\)`));
});

test('the daily brief lists only projects where something changed, and is not sent when nothing did', (t) => {
  const { f, rows, texts } = setup(t);
  const other = f.ledger.createProject({ name: '乙项目', loginMode: 'all' }, USER);
  const day = (n: number) => new Date(Date.UTC(2026, 10, 10 + n, 1));
  // The first time is where "changed" is counted from: nothing is sent.
  assert.equal(f.ledger.dailyBrief(day(0), day(0)), false);
  f.runningRun();
  const held = f.queuedTask();
  f.ledger.holdTask(held.id, '先放着', USER);
  assert.equal(f.ledger.dailyBrief(day(1), day(1)), true);
  const [brief] = texts();
  assert.match(brief!, /^【系统】每日简报/);
  assert.match(brief!, /【试跑】.*在跑 1.*卡住 1/s);
  assert.doesNotMatch(brief!, /乙项目/, '没变化的项目不列');
  assert.equal(f.ledger.dailyBrief(day(1), day(1)), false, '同一天不发第二次');
  assert.equal(f.ledger.dailyBrief(day(2), day(2)), false, '全都没变化就不发');
  assert.equal(rows().length, 1);
  // Something in the other project only: the brief names it alone.
  f.ledger.createTask({ roleId: 'implement', projectId: other, title: '乙的', goal: '目标', acceptance: '验收' }, USER);
  const theirs = f.ledger.listTasks().find((task) => task.project_id === other)!;
  f.ledger.queueTask(theirs.id, USER);
  f.ledger.holdTask(theirs.id, '等等', USER);
  assert.equal(f.ledger.dailyBrief(day(3), day(3)), true);
  assert.match(texts().at(-1)!, /【乙项目】.*卡住 1/s);
  assert.doesNotMatch(texts().at(-1)!, /【试跑】/);
});

test('an archived project is not reminded; a paused one is only resting and still is', (t) => {
  const { f, policy, rows, later } = setup(t);
  const other = f.ledger.createProject({ name: '乙项目', loginMode: 'all' }, USER);
  f.ledger.openApproval(f.queuedTask().id, [{ question: '用哪个？' }], USER);
  const theirs = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '乙的', goal: '目标', acceptance: '验收' }, USER);
  f.ledger.queueTask(theirs.id, USER);
  f.ledger.openApproval(theirs.id, [{ question: '乙用哪个？' }], USER);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  f.ledger.setProjectPaused(other, true, USER);
  f.ledger.pushTick(later(policy.remindMs + 1));
  const reminded = (): string[] => rows('remind').map((row) => (JSON.parse(row.payload_json) as { project_id: string }).project_id);
  assert.deepEqual(reminded(), [other], '已归档的不提醒；暂停只是临时停手，照旧提醒');
  const state = (projectId: string): { state: string; reminded: number } | undefined => f.peek<{ state: string; reminded: number }>(
    `SELECT state, reminded FROM push WHERE level = 'wait' AND kind = 'approval' AND project_id = ?`, projectId,
  )[0];
  assert.equal(state(f.projectId)?.state, 'open', '归档只是先不提醒：行还开着，恢复后照旧');
  assert.equal(state(f.projectId)?.reminded, 0, '提醒次数没动');
  f.ledger.setProjectArchived(f.projectId, false, USER);
  f.ledger.pushTick(later(policy.remindMs + 2));
  assert.deepEqual(reminded(), [other, f.projectId], '恢复后下一次 tick 照常判断和提醒');
});

test('the daily brief leaves an archived project out, and keeps a paused one', (t) => {
  const { f, texts } = setup(t);
  const other = f.ledger.createProject({ name: '乙项目', loginMode: 'all' }, USER);
  const day = (n: number) => new Date(Date.UTC(2026, 10, 10 + n, 1));
  assert.equal(f.ledger.dailyBrief(day(0), day(0)), false);
  const mine = f.queuedTask();
  f.ledger.holdTask(mine.id, '先放着', USER);
  const theirs = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '乙的', goal: '目标', acceptance: '验收' }, USER);
  f.ledger.queueTask(theirs.id, USER);
  f.ledger.holdTask(theirs.id, '等等', USER);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  f.ledger.setProjectPaused(other, true, USER);
  assert.equal(f.ledger.dailyBrief(day(1), day(1)), true);
  const brief = texts().at(-1)!;
  assert.doesNotMatch(brief, /【试跑】/, '已归档的项目不进简报');
  assert.match(brief, /【乙项目】.*卡住 1/s, '暂停只是临时停手，照旧进简报');
});

test('the daily brief is not queued when WeCom is off', (t) => {
  const { f, rows } = setup(t);
  f.ledger.setChannels(['console']);
  const day = (n: number) => new Date(Date.UTC(2026, 10, 10 + n, 1));
  f.ledger.dailyBrief(day(0), day(0));
  f.runningRun();
  f.ledger.dailyBrief(day(1), day(1));
  assert.equal(rows().length, 0);
});

test('the daily brief counts an actively-reviewing ready task as running rather than waiting', (t) => {
  const { f, texts } = setup(t);
  const day = (n: number) => new Date(Date.UTC(2026, 10, 10 + n, 1));
  assert.equal(f.ledger.dailyBrief(day(0), day(0)), false);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const regId = f.ledger.registerArtifacts(run.id, []);
  const review = f.ledger.createTask({
    roleId: 'review',
    projectId: f.projectId,
    title: '独立审阅',
    goal: '审阅',
    acceptance: '给结论',
    reviewOf: { taskId: task.id, runId: run.id, revision: task.revision, registration: regId },
  }, USER);
  f.ledger.queueTask(review.id, USER);
  assert.equal(f.ledger.dailyBrief(day(1), day(1)), true);
  const brief = texts().at(-1)!;
  assert.match(brief, /【试跑】.*在跑 1/);
  assert.doesNotMatch(brief, /等你/);
});
