// Guards against the owner not hearing what they need to: a reply going to the wrong
// chat or a group reply sent as a single chat, an unfinished WeCom request silently
// vanishing, a question reaching no one or a card for a question already answered, the
// Console's answer never told to WeCom, a lost Run not raised, degraded mode going
// unreported because reporting it needed the ledger; and a notification that can be
// lost separately from the state change that caused it, internal successes causing
// noise, stale verification requests, disabled channels collecting notifications, or a
// failed backup reported twice for one failure, not reported when it goes bad again on the
// same day, or not at all when the ledger is down too. What is pushed about an internal event
// follows the kind of ledger event (project-sessions §2.1, push.test.ts covers the table): the
// Router's wording never makes it louder or quieter. And a reminder calling the owner to a page
// where the thing it asks for no longer exists: the token form is gone, so a reminder about a
// rejected login must send them to sign in again rather than to refill a token.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { MessageRow } from '../service/messages.ts';
import { createNotify } from '../service/notify.ts';
import { expiryDay } from '../shared/credential.ts';
import type { OutboxRow } from '../service/outbox.ts';
import type { Fixture } from './helpers.ts';
import { DONE, fixture, LOGIN, USER, RUN_LIMIT_MS, holdMachine, testMachine, codexTier, tune } from './helpers.ts';
import { ACCOUNT_LOGIN_FIX } from '../shared/labels.ts';
import { ulid } from '../service/ids.ts';

const OWNER = 'zhang';

function seedAccount(f: Fixture, name: string) {
  const account = { id: ulid(), name, executor: 'claude', tiers: LOGIN.login.tiers };
  f.ledger.putAccount(account, USER, `notify-${ulid()}`);
  return account;
}

function seedMachineLogin(f: Fixture) {
  holdMachine(f.ledger, testMachine('gpu-1'), USER);
  f.ledger.putMachineLogin({ machine: 'gpu-1', executor: 'codex', tiers: { execute: codexTier('m') } }, USER);
  return f.ledger.getMachineLogin('gpu-1', 'codex')!;
}

function setup(t: TestContext, f: Fixture = fixture(t)) {
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const direct: string[] = [];
  const logs: string[] = [];
  const state = { directFails: false };
  const notify = createNotify({
    ledger: f.ledger,
    owner: () => OWNER,
    direct: async (content) => {
      if (state.directFails) throw new Error('未连接');
      direct.push(content);
    },
    log: (line) => logs.push(line),
  });
  const rows = (kind?: string): OutboxRow[] =>
    f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid').filter((row) => !kind || row.kind === kind);
  const rendered = (kind?: string) => rows(kind).map((row) => notify.render(row));
  return { f, notify, direct, logs, state, rows, rendered };
}

// A message to the owner's project, as the front desk or the console page places it.
function inbound(f: Fixture, fields: { channel: string; thread?: string; actor?: string; text?: string }): MessageRow {
  const { id } = f.ledger.receiveMessage({
    externalId: `e-${Math.random()}`,
    actor: OWNER,
    text: '做个东西',
    ...(fields.channel === 'internal' ? {} : { projectId: f.projectId }),
    ...fields,
  });
  return f.ledger.getMessage(id);
}

const NO_ADDRESS = '\n\n控制台：还没有配置对外地址，手机上打不开';
const contentOf = (out: { body: { msgtype: string } } | undefined): string =>
  out?.body.msgtype === 'markdown' ? (out.body as unknown as { markdown: { content: string } }).markdown.content : '';

const reply = (f: Fixture, message: MessageRow, text = '**好了**'): MessageRow =>
  f.ledger.writeOutbound({ channel: message.channel, thread: message.thread, text, final: true, replyTo: message.id });

// A Task at whatever state it is, queued and settled ready: its settlement's internal message.
const readyRun = (f: Fixture, taskId: string): string => {
  f.ledger.queueTask(taskId, USER);
  const run = f.ledger.createRun(taskId, { ...f.login, snapshot: { ...f.login.snapshot, tier: f.task(taskId).tier ?? 'execute' } }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE);
  return run.id;
};

test('a row names the message it answers only when it ends a reply', (t) => {
  const { f, notify, rows } = setup(t);
  const message = inbound(f, { channel: 'wecom', thread: OWNER });
  notify.finalReply(message, reply(f, message));
  notify.unverified(message);
  notify.started();
  assert.deepEqual(rows().map((row) => notify.answers(row)), [message.id, message.id, undefined]);
});

test('a reply to a WeCom message goes back to its thread as markdown', (t) => {
  const { f, notify, rendered } = setup(t);
  const message = inbound(f, { channel: 'wecom', thread: OWNER });
  notify.finalReply(message, reply(f, message));
  assert.deepEqual(rendered(), [
    { target: { chatid: OWNER, chat_type: 1 }, body: { msgtype: 'markdown', markdown: { content: `【试跑】**好了**${NO_ADDRESS}` } } },
  ]);
});

test('a reply in a group goes to the group, as a group', (t) => {
  const { f, notify, rendered } = setup(t);
  const message = inbound(f, { channel: 'wecom', thread: 'room' });
  notify.finalReply(message, reply(f, message));
  assert.deepEqual(rendered()[0]!.target, { chatid: 'room', chat_type: 2 });
});

test('a reply to a Console message stays in the Console', (t) => {
  const { f, notify, rows } = setup(t);
  const message = inbound(f, { channel: 'console', actor: 'console' });
  notify.finalReply(message, reply(f, message));
  assert.equal(rows().length, 0);
});

test('the same reply is queued once', (t) => {
  const { f, notify, rows } = setup(t);
  const message = inbound(f, { channel: 'wecom', thread: OWNER });
  const written = reply(f, message);
  notify.finalReply(message, written);
  notify.finalReply(message, written);
  assert.equal(rows().length, 1);
});

test('a reply over the size limit is cut on a character boundary and says so', (t) => {
  const { f, notify, rendered } = setup(t);
  const message = inbound(f, { channel: 'wecom', thread: OWNER });
  notify.finalReply(message, reply(f, message, '字'.repeat(10_000)));
  const { body } = rendered()[0]!;
  const content = body.msgtype === 'markdown' ? body.markdown.content : '';
  assert.ok(Buffer.byteLength(content) <= 20_000);
  assert.ok(content.endsWith(`字\n\n……内容太长，全文到 Console 看${NO_ADDRESS}`), '截掉的是正文，项目标记和控制台那一行留着');
  assert.ok(content.startsWith('【试跑】'));
  assert.ok(!content.includes('�'));
});

test('an unfinished WeCom request lists what was committed and promises no redo', (t) => {
  const { f, notify, rendered } = setup(t);
  const message = inbound(f, { channel: 'wecom', thread: OWNER, text: '创建一个任务' });
  f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '甲', goal: '目标' }, { actor: 'router', messageId: message.id });
  notify.unverified(message);
  const { body } = rendered()[0]!;
  assert.equal(body.msgtype, 'markdown');
  const content = body.msgtype === 'markdown' ? body.markdown.content : '';
  assert.match(content, /该请求未完成（创建一个任务）/);
  assert.match(content, /已提交的操作如下：\n- 创建任务/);
  assert.match(content, /不会自动重做/);
});

test('an unfinished request with nothing committed says that; console stays quiet while unverified internal turn notifies owner', (t) => {
  const { f, notify, rows, rendered } = setup(t);
  notify.unverified(inbound(f, { channel: 'console', actor: 'console' }));
  assert.equal(rows().length, 0);
  notify.unverified(inbound(f, { channel: 'internal', actor: 'runner', text: '任务完成结算' }));
  assert.equal(rows().length, 1);
  assert.match(JSON.stringify(rendered()[0]), /一条内部事件处理未确认完成（任务完成结算）/);
  notify.unverified(inbound(f, { channel: 'wecom', thread: OWNER }));
  assert.match(JSON.stringify(rendered()[1]), /没有已提交的操作/);
});

test('an opened Approval becomes a card to the owner, queued with the question itself', (t) => {
  const { f, rendered } = setup(t);
  const id = f.ledger.openApproval(f.queuedTask().id, [{ question: '用哪个？', options: ['甲'] }], USER);
  const [sent] = rendered('approval');
  assert.deepEqual(sent!.target, { chatid: OWNER, chat_type: 1 });
  assert.equal(sent!.body.msgtype, 'template_card');
  const card = sent!.body.msgtype === 'template_card' ? sent!.body.template_card : undefined;
  assert.equal(card!.main_title.title, '【试跑】任务');
  assert.equal(card!.button_list[0]!.key, `approval:${id}:q0:0`);
});

test('a question answered before its card went out needs no card', (t) => {
  const { f, rendered } = setup(t);
  const id = f.ledger.openApproval(f.queuedTask().id, [{ question: '用哪个？' }], USER);
  f.ledger.answerApproval(id, ['甲'], 'console', 'console');
  assert.deepEqual(rendered('approval'), [undefined]);
});

test('an answer in the Console tells WeCom what was answered', (t) => {
  const { f, rendered } = setup(t);
  const id = f.ledger.openApproval(f.queuedTask().id, [{ question: '一？' }, { question: '二？' }], USER);
  f.ledger.answerApproval(id, ['甲', '乙'], 'console', 'console');
  const [sent] = rendered('approval_answered');
  assert.deepEqual(sent?.target, { chatid: OWNER, chat_type: 1 });
  assert.equal(contentOf(sent), `【试跑】问题已在 Console 回答：甲；乙${NO_ADDRESS}`);
});

test('an answer on WeCom is noted with where it came from', (t) => {
  const { f, rendered } = setup(t);
  const id = f.ledger.openApproval(f.queuedTask().id, [{ question: '一？' }], USER);
  f.ledger.answerApproval(id, ['甲'], OWNER, 'wecom');
  assert.match(JSON.stringify(rendered('approval_answered')[0]), /已回答（来自 wecom）：甲/);
});

test('a machine out of contact is told to nobody: the rules are handling it', (t) => {
  const { f, rows } = setup(t);
  const { run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  assert.equal(f.task(run.task_id).state, 'needs_verification');
  f.ledger.markRunRunning(run.id);
  f.ledger.markRunUnknown(run.id);
  assert.equal(rows().length, 0, '失联中的任务不推企微');
});

test('a settled work\'s Router sentence replaces the service\'s own instead of pushing a second row', (t) => {
  const { f, notify, rows } = setup(t);
  const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '验证', goal: '做', acceptance: '好' }, USER);
  const runId = readyRun(f, task.id);
  const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${runId}`)!;
  assert.equal(event.state, 'received', '要负责人处理的结果照常投递');
  assert.equal(rows().length, 1, '结算自己已经推了一条');
  const before = JSON.stringify(rows()[0]);
  notify.finalReply(event, reply(f, event, '做完了，等你验收'));
  assert.equal(rows().length, 1, '只替换，不另推');
  assert.notEqual(JSON.stringify(rows()[0]), before);
  assert.match(JSON.stringify(notify.render(rows()[0]!)), /做完了，等你验收/);
});

test('a merged turn pushes the attached subscription\'s final reply, and only the first Run\'s sentence is replaced', (t) => {
  const { f, notify, rows } = setup(t);
  const a = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: 'A', goal: '做', acceptance: '好' }, USER);
  const b = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: 'B', goal: '做', acceptance: '好' }, USER);
  // A project subscription that rides on A's settlement message and asks for the final reply.
  f.ledger.createTrigger(f.projectId, { name: '日报', instruction: '看', source: 'event', event: { kind: 'work_ready', task_id: a.id }, push_final: true }, USER);
  const runB = readyRun(f, b.id);
  const runA = readyRun(f, a.id);
  const eventOf = (runId: string) => f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${runId}`)!;
  const [first, second] = [eventOf(runB), eventOf(runA)];
  assert.equal(second.state, 'received');
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  assert.deepEqual([taken.message.id, ...taken.attached.map(({ id }) => id)], [first.id, second.id]);

  f.ledger.finishMessage(first.id, 'processed');
  f.ledger.finishMessage(second.id, 'processed');
  notify.finalReply(first, reply(f, first, '第一条的摘要'));
  notify.finalReply(second, reply(f, second, '第二条的摘要'), { supplementRun: false });

  const finals = rows().filter((row) => (JSON.parse(row.payload_json) as { external_id?: string }).external_id === `trigger-final:${second.id}`);
  assert.equal(finals.length, 1, '订阅挂在第二条上，也要推');
  assert.match(JSON.stringify(finals[0]), /第二条的摘要/);
  assert.equal(
    rows().filter((row) => (JSON.parse(row.payload_json) as { external_id?: string }).external_id === `trigger-final:${first.id}`).length,
    0,
    '第一条没有订阅',
  );
  // A 'sent' result is rendered from its Outbox row; one still 'open' is rendered from the push.
  const summaryOf = (runId: string): string | undefined => {
    const key = `work-ready:${runId}`;
    const held = f.peek<{ state: string; payload_json: string }>('SELECT state, payload_json FROM push WHERE key = ?', key)[0]!;
    const payload = held.state === 'open'
      ? held.payload_json
      : f.peek<{ payload_json: string }>(`SELECT payload_json FROM outbox WHERE json_extract(payload_json, '$.external_id') = ?`, key)[0]!.payload_json;
    return (JSON.parse(payload) as { summary?: string }).summary;
  };
  assert.equal(summaryOf(runB), '第一条的摘要', '第一条的 Run 结果被负责人那句话替换');
  assert.equal(summaryOf(runA), undefined, '随后一起取走的保留服务自己的话');
});

test('a merged turn\'s unverified push for an attached subscription lists the turn\'s committed operations', (t) => {
  const { f, notify, rows } = setup(t);
  const a = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: 'A', goal: '做', acceptance: '好' }, USER);
  const b = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: 'B', goal: '做', acceptance: '好' }, USER);
  f.ledger.createTrigger(f.projectId, { name: '日报', instruction: '看', source: 'event', event: { kind: 'work_ready', task_id: a.id }, push_final: true }, USER);
  const runB = readyRun(f, b.id);
  const runA = readyRun(f, a.id);
  const eventOf = (runId: string) => f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${runId}`)!;
  const [first, second] = [eventOf(runB), eventOf(runA)];
  // What the turn committed hangs on its first message, and the second message's push lists it.
  f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '新任务', goal: '做', acceptance: '好' }, { actor: 'router', messageId: first.id });
  notify.unverified(second, { committedBy: first.id });
  const finals = rows().filter((row) => (JSON.parse(row.payload_json) as { external_id?: string }).external_id === `trigger-final:${second.id}`);
  assert.equal(finals.length, 1);
  assert.match(JSON.stringify(finals[0]), /未确认完成/);
  assert.match(JSON.stringify(finals[0]), /创建任务/, '列的是本回合的变更');
});

test('a lost Run that continued by itself is a record only: the Router is not woken and the owner is not pushed', (t) => {
  const { f, rows } = setup(t);
  const { run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  f.ledger.settleRun(run.id, null, null, { kind: 'lost', lost: { basis: 'presumed' } });
  assert.equal(f.task(run.task_id).state, 'queued');
  const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
  assert.equal(event.state, 'ignored');
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
  assert.equal(rows().length, 0, '丢失后自动接续不推企微');
});

test('losing every round in a row is what reaches the owner: the Task is held', (t) => {
  const { f, notify, rows } = setup(t);
  const task = f.queuedTask();
  for (const expected of [0, 0, 1]) {
    const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS } }, USER);
    f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
    const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
    notify.finalReply(event, reply(f, event, '又丢了一轮'));
    assert.equal(rows('held').length, expected);
    assert.equal(rows('markdown').length, 0, '负责人的回复不推');
  }
  assert.equal(f.task(task.id).state, 'held');
});

test('an account with no machine left is told once per stretch, and again when a new stretch begins', (t) => {
  const { f, notify, rendered, rows } = setup(t);
  const gpu = seedAccount(f, 'gpu');
  const cpu = seedAccount(f, 'cpu');
  notify.noMachine(gpu.id, '2026-11-05T01:00:00.000Z');
  notify.noMachine(gpu.id, '2026-11-05T01:00:00.000Z');
  assert.equal(rows().length, 1, '同一次不可用只推一条');
  assert.match(JSON.stringify(rendered()[0]), /账号 gpu 没有可用的机器/);
  assert.deepEqual(rendered()[0]?.target, { chatid: OWNER, chat_type: 1 });
  notify.noMachine(gpu.id, '2026-11-05T09:00:00.000Z');
  notify.noMachine(cpu.id, '2026-11-05T01:00:00.000Z');
  assert.equal(rows().length, 3, '恢复后再出现、或别的目标，各推一次');
  f.ledger.deleteAccount(gpu.id, USER);
  assert.match(JSON.stringify(rendered()[0]), /账号 gpu 没有可用的机器/, '删除后仍按通知入队时的名称显示');
});

test('an ordinary settlement raises nothing but the result it makes', (t) => {
  const { f, rows } = setup(t);
  const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '验证', goal: '做', acceptance: '好' }, USER);
  readyRun(f, task.id);
  assert.deepEqual(rows().map(({ kind }) => kind), ['work_ready']);
});

test('a service start is one sentence to the owner', (t) => {
  const { notify, rendered } = setup(t);
  notify.started();
  assert.deepEqual(rendered(), [
    { target: { chatid: OWNER, chat_type: 1 }, body: { msgtype: 'markdown', markdown: { content: `【系统】服务已启动${NO_ADDRESS}` } } },
  ]);
});

function degradedSetup(t: TestContext) {
  const f = fixture(t);
  const task = f.queuedTask();
  const made = setup(t, f);
  f.ledger.close();
  const ledger = f.open({ readOnly: true });
  return { ...made, task, ledger };
}

test('degraded mode is reported past the Outbox, once, and recovery through it', (t) => {
  const f = fixture(t);
  const made = setup(t, f);
  const { notify, direct, rendered } = made;
  const real = f.ledger.dispatchConditions;
  let degraded = true;
  f.ledger.dispatchConditions = () => ({ ...real(), degraded });
  notify.checkHealth();
  notify.checkHealth();
  assert.equal(direct.length, 1);
  assert.equal(direct[0], `【系统】服务进入降级模式：账本写不进去，已停止派发${NO_ADDRESS}`);
  assert.equal(rendered().length, 0);

  degraded = false;
  notify.checkHealth();
  notify.checkHealth();
  assert.match(JSON.stringify(rendered()), /服务已从降级模式恢复/);
  assert.equal(rendered().length, 1);
});

test('a failed degraded notice is logged, not thrown into the Outbox loop', async (t) => {
  const f = fixture(t);
  const { notify, logs, state } = setup(t, f);
  state.directFails = true;
  const real = f.ledger.dispatchConditions;
  f.ledger.dispatchConditions = () => ({ ...real(), degraded: true });
  notify.checkHealth();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(logs.join('\n'), /降级通知发送失败/);
});

test('a real write failure cannot be queued, which is why the notice goes direct', (t) => {
  const { ledger, task } = degradedSetup(t);
  assert.throws(() => ledger.holdTask(task.id, '挂起', USER));
  assert.throws(() => ledger.outbox.enqueue('wecom', 'markdown', {}));
  assert.equal(ledger.dispatchConditions().degraded, true);
});

test('a row of a kind nobody knows fails loudly instead of counting as sent', (t) => {
  const { f, notify } = setup(t);
  const row = f.ledger.outbox.enqueue('wecom', 'note', {});
  assert.throws(() => notify.render(row), /不认识的出站类型/);
});

// What a settlement pushes is its event's: a question's card, a stopped Task, a piece of work
// done; never the Router's reply as such, whatever it claims.
for (const [status, expected] of [
  ['done', ['work_ready']], ['waiting', ['approval']], ['failed', ['held']], ['timer', []],
] as const) {
  test(`internal settlement reply: ${status}`, (t) => {
    const { f, notify, rows } = setup(t);
    const task = f.ledger.createTask({ roleId: status === 'done' ? 'verify' : 'implement', projectId: f.projectId, title: '任务', goal: '目标', acceptance: '通过' }, USER);
    f.ledger.queueTask(task.id, USER);
    const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: status === 'done' ? 'operate' : 'execute' } }, USER);
    f.ledger.markRunRunning(run.id);
    const receipt = status === 'waiting' ? { status: 'waiting', ask: [{ question: '决定？' }] }
      : status === 'timer' ? { status: 'waiting', later: { at: '2099-01-01T00:00:00Z' } }
        : status === 'done' ? { status, summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] }
          : { status, summary: '完成' };
    f.ledger.settleRun(run.id, 0, receipt);
    const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
    notify.finalReply(event, reply(f, event, '已经完成，不需要决定'));
    assert.deepEqual(rows().map(({ kind }) => kind), expected);
  });
}

test('unrecognized internal events stay in Console regardless of reply wording', (t) => {
  const { f, notify, rows } = setup(t);
  const event = inbound(f, { channel: 'internal', actor: 'runner' });
  notify.finalReply(event, reply(f, event, '需要你核实，等你决定'));
  assert.equal(rows().length, 0);
});

test('a successful child stays quiet while another child is advancing; final child announces work readiness', (t) => {
  const { f, notify, rows } = setup(t);
  const parent = f.newTask({ acceptance: '' });
  const child = () => {
    const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, parentId: parent.id, title: '子任务', goal: '目标', acceptance: '通过' }, USER);
    f.ledger.queueTask(task.id, USER);
    const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, tier: 'operate' } }, USER);
    f.ledger.markRunRunning(run.id);
    return run;
  };
  const first = child();
  const second = child();
  for (const [run, expected] of [[first, 0], [second, 1]] as const) {
    f.ledger.settleRun(run.id, 0, { status: 'done', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
    const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
    notify.finalReply(event, reply(f, event));
    assert.equal(rows('work_ready').length, expected);
  }
});

test('a request to verify a machine out of contact, queued before the rules took that over, is never sent', (t) => {
  const { f, notify, rows } = setup(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  // What an earlier version queued at this point, and at the loss that followed.
  for (const finding of ['unknown', 'lost']) {
    f.ledger.enqueueNotification('wecom', 'verify', { external_id: `verify:${run.id}:${finding}`, task_id: task.id, run_id: run.id, finding });
  }
  assert.equal(rows('verify').length, 2);
  assert.ok(rows('verify').every((row) => notify.render(row) === undefined && notify.skipReason(row) === '已失效'));
});

test('residue that cannot be cleared is still asked about until its Run ends', (t) => {
  const { f, notify, rows } = setup(t);
  const { run } = f.runningRun();
  f.ledger.reportStuckResidue(run.id);
  const row = rows('verify')[0]!;
  assert.equal(notify.skipReason(row), undefined);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  assert.equal(notify.skipReason(row), '已失效');
});

test('closing an Approval with the Task notifies the owner', (t) => {
  const { f, rendered } = setup(t);
  const task = f.queuedTask();
  f.ledger.openApproval(task.id, [{ question: '继续？' }], USER);
  f.ledger.abandonTask(task.id, '不再做', USER);
  assert.match(JSON.stringify(rendered('approval_closed')), /问题已关闭/);
});


test('disabling WeCom suppresses new reply, question, answer, closure and verification notifications', (t) => {
  const { f, notify, rows } = setup(t);
  f.ledger.setChannels(['console']);
  const message = inbound(f, { channel: 'wecom', thread: OWNER });
  notify.finalReply(message, reply(f, message));
  notify.started();
  const task = f.queuedTask();
  const answered = f.ledger.openApproval(task.id, [{ question: '继续？' }], USER);
  f.ledger.answerApproval(answered, ['是'], 'console', 'console');
  f.ledger.openApproval(task.id, [{ question: '继续？' }], USER);
  f.ledger.abandonTask(task.id, '不再做', USER);
  f.ledger.markRunUnknown(f.runningRun().run.id);
  assert.equal(rows().length, 0);
});

test('internal settlement summaries use the shared Chinese Task state label', (t) => {
  const { f } = setup(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, { status: 'waiting', ask: [{ question: '决定？' }] });
  const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
  assert.match(event.text.split('\n')[0]!, /任务转为 等你决定$/);
});

test('two child results queued before either internal reply produce one work-ready notification', (t) => {
  const { f, notify, rows } = setup(t);
  const parent = f.newTask({ acceptance: '' });
  const runs = ['甲', '乙'].map((title) => {
    const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, parentId: parent.id, title, goal: '目标', acceptance: '通过' }, USER);
    f.ledger.queueTask(task.id, USER);
    const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, tier: 'operate' } }, USER);
    f.ledger.markRunRunning(run.id);
    return run;
  });
  for (const run of runs) f.ledger.settleRun(run.id, 0, { status: 'done', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  for (const run of runs) {
    const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
    notify.finalReply(event, reply(f, event));
  }
  assert.equal(rows('work_ready').length, 1);
});

for (const reason of ['已中断', '超时']) {
  test(`an internally reported held Task notifies after ${reason}`, (t) => {
    const { f, notify, rows } = setup(t);
    const { run } = f.runningRun();
    f.ledger.markRunStopping(run.id, USER);
    f.ledger.settleRun(run.id, null, null, { kind: 'interrupted', reason });
    const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${run.id}`)!;
    notify.finalReply(event, reply(f, event));
    assert.equal(rows('held').length, 1);
  });
}

test('work done at settlement is a result there and then, once, whatever happens to the work or the Router after', (t) => {
  const { f, notify, rows } = setup(t);
  const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '验证', goal: '做', acceptance: '好' }, USER);
  const runId = readyRun(f, task.id);
  assert.equal(rows('work_ready').length, 1);
  const event = f.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${runId}`)!;
  const child = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, parentId: task.id, title: '新子任务', goal: '目标', acceptance: '通过' }, USER);
  f.ledger.queueTask(child.id, USER);
  notify.finalReply(event, reply(f, event));
  assert.equal(rows('work_ready').length, 1);
});

test('skipReason suppresses stale held and work_ready notifications before send', (t) => {
  const { f, notify, rows } = setup(t);
  const { task: heldTask, run: heldRun } = f.runningRun();
  f.ledger.settleRun(heldRun.id, 1, null);
  const [heldRow] = rows('held');
  assert.ok(heldRow);
  assert.equal(notify.skipReason(heldRow), undefined);
  f.ledger.resumeTask(heldTask.id, USER);
  assert.equal(notify.skipReason(heldRow), '已处理');
  assert.equal(notify.render(heldRow), undefined);

  const readyTask = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '待验收', goal: '做', acceptance: '好' }, USER);
  readyRun(f, readyTask.id);
  const [readyRow] = rows('work_ready');
  assert.ok(readyRow);
  assert.equal(notify.skipReason(readyRow), undefined);
  f.ledger.acceptTask(readyTask.id, '已看', USER);
  assert.equal(notify.skipReason(readyRow), '已处理');
  assert.equal(notify.render(readyRow), undefined);

  // A work_ready row for a review-gated ready task is also skipped.
  const { task: gatedTask, run: gatedRun } = f.runningRun();
  f.ledger.settleRun(gatedRun.id, 0, DONE);
  const fakeReady = f.ledger.outbox.enqueue('wecom', 'work_ready', { external_id: `stale:${gatedTask.id}`, task_id: gatedTask.id });
  assert.equal(notify.skipReason(fakeReady), '需先审阅');
  assert.equal(notify.render(fakeReady), undefined);
});

test('residue that cannot be cleared and a stopped Router both reach the owner in words', (t) => {
  const { f, notify, rendered } = setup(t);
  const { run } = f.runningRun();
  f.ledger.reportStuckResidue(run.id);
  notify.routerHalted('残留负责人进程清不掉');
  const [residue, halted] = rendered().map((row) => JSON.stringify(row?.body));
  assert.match(residue!, /后台进程清不掉/);
  assert.match(halted!, /负责人已停摆.*残留负责人进程清不掉/);
});

test('a failed backup says why and when it last worked, once for each time it goes bad', (t) => {
  const { notify, rows, rendered } = setup(t);
  notify.backupFailed('盘满了', null, '2026-11-05T04:00:00.000Z');
  notify.backupFailed('盘满了', null, '2026-11-05T04:00:00.000Z');
  assert.equal(rows('markdown').length, 1, '同一次失败只有一条');
  const [outgoing] = rendered('markdown');
  assert.deepEqual(outgoing?.target, { chatid: OWNER, chat_type: 1 });
  assert.match(contentOf(outgoing), /^【系统】自动备份失败：盘满了。上次成功：从未\n\n/);
  notify.backupFailed('盘满了', '2026-11-05T06:00:00.000Z', '2026-11-05T12:00:00.000Z');
  assert.equal(rows('markdown').length, 2, '同一天里好过之后再坏，是另一次失败');
  const second = rendered('markdown')[1];
  assert.match(second?.body.msgtype === 'markdown' ? second.body.markdown.content : '', /上次成功：2026\//);
});

test('a failed backup is not queued for a channel that is off', (t) => {
  const { f, notify, rows } = setup(t);
  f.ledger.setChannels(['console']);
  notify.backupFailed('盘满了', null, '2026-11-05T04:00:00.000Z');
  assert.deepEqual(rows('markdown'), []);
});

test('a failed backup with the ledger down too goes around the Outbox', (t) => {
  const failing = { on: false };
  const f = fixture(t, { testHooks: { beforeCommit() { if (failing.on) throw Object.assign(new Error('disk I/O error'), { errcode: 10 }); } } });
  const sent: string[] = [];
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER, direct: async (content) => { sent.push(content); }, log() {} });
  failing.on = true;
  notify.backupFailed('读不出账本', null, '2026-11-05T04:00:00.000Z');
  assert.deepEqual(sent, [`【系统】自动备份失败：读不出账本。上次成功：从未${NO_ADDRESS}`], '绕过出站的也有标记和那一行');
});

test('a rejected account login tells the owner to renew it on the accounts page, without carrying a token', t => {
  const { f, rendered } = setup(t);
  const account = seedAccount(f, 't1');
  f.ledger.enqueueNotification('wecom', 'account_credential_rejected', { external_id: 'rejected-once', account_id: account.id, account_name: account.name });
  f.ledger.deleteAccount(account.id, USER);
  assert.deepEqual(rendered('account_credential_rejected'), [{ target: { chatid: OWNER, chat_type: 1 },
    body: { msgtype: 'markdown', markdown: { content: `【系统】账号 t1 的登录失效，${ACCOUNT_LOGIN_FIX}${NO_ADDRESS}` } } }]);
});

test('a rejected account login is reminded to sign in again or change its key, not to refill a token', t => {
  const { f, rendered } = setup(t);
  const account = seedAccount(f, 't1');
  f.ledger.rejectCredential(account.id, f.ledger.accountCredentialRef(account.id)!);
  f.ledger.pushTick(new Date(Date.now() + 2 * 60 * 60 * 1000));
  const [reminder] = rendered('remind');
  assert.match(contentOf(reminder), new RegExp(`账号 t1 的登录还没换上新的：${ACCOUNT_LOGIN_FIX}`));
  assert.doesNotMatch(contentOf(reminder), /令牌/, '不再叫主人去填一个已经没有的入口');
});

test("a machine's own login refused by its executor tells the owner where to sign in again", t => {
  const { f, rendered } = setup(t);
  const login = seedMachineLogin(f);
  f.ledger.enqueueNotification('wecom', 'machine_login_refused', { external_id: 'refused-once', login_id: login.id, login_name: login.name });
  f.ledger.deleteMachineLogin(login.machine, login.executor, USER);
  assert.deepEqual(rendered('machine_login_refused'), [{ target: { chatid: OWNER, chat_type: 1 },
    body: { msgtype: 'markdown', markdown: { content: `【系统】机器 gpu-1 上的 codex 登录 登录失效了：到那台机器上重新登录这个执行器。机器报告已登录后自动接着派${NO_ADDRESS}` } } }]);
});

test('a notice about a login expected to run out names the account, the day and the accounts page', (t) => {
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER, publicUrl: () => 'https://tycho.example/', direct: async () => {}, log() {} });
  f.ledger.setChannels(['console', 'wecom']);
  const account = seedAccount(f, 'claude');
  // Five days from the estimate: inside the reminder window whenever this test runs.
  const now = Date.now();
  const expires = new Date(now + 5 * 24 * 60 * 60 * 1000);
  const cameIn = new Date(expires.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  f.force(`UPDATE account SET credential_at = ? WHERE id = ?`, cameIn, account.id);
  f.ledger.expiryReminders(new Date(now));
  const rows = f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid').filter((row) => row.kind === 'account_expiry');
  const said = contentOf(notify.render(rows[0]!));
  assert.match(said, /账号 claude/);
  assert.match(said, new RegExp(`预计 ${expiryDay(expires.toISOString())} 到期`));
  assert.ok(said.includes('#/accounts'), said);
  // The reminder window narrowed after this one was queued: the first notice still goes out.
  // It entered the period once, and that is what the owner has not seen; only the reminders
  // that follow are held to the window as it is now.
  tune(f.ledger, 'accounts.expiryRemindDays', 1);
  assert.ok(notify.render(rows[0]!), '窗口收窄：初发照发');
  // Stored again since it was queued: the notice is about a credential the account no longer
  // holds, and goes out as nothing rather than as a stale reminder.
  f.ledger.recordAccountCredential(account.id, 'ref-next', USER);
  assert.equal(notify.render(rows[0]!), undefined, '换了凭据：这条不再发');
  assert.equal(rows.length, 1);
});

// Review of the page split: a notice about a login points to the page where that login is set
// up, and says the same page in words — an account to 账号 (#/accounts), a machine's own login
// to 机器 (#/machines). Guards against the old settings address, and against a machine's own
// login being sent to the accounts page where its tiers are not.
test('a notice about a login names and links the page that login is set up on', (t) => {
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER, publicUrl: () => 'https://tycho.example/', direct: async () => {}, log() {} });
  const account = seedAccount(f, 't1');
  const login = seedMachineLogin(f);
  notify.modelsAdded(account.id, { id: '<模型甲>' });
  notify.modelsAdded(login.id, { id: '<模型乙>' });
  notify.modelsGone(account.id, { id: '<模型丙>' });
  notify.modelsGone(login.id, { id: '<模型丁>' });
  f.ledger.enqueueNotification('wecom', 'account_credential_rejected', { external_id: 'rejected-once', account_id: account.id, account_name: account.name });
  const said = f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid').map((row) => contentOf(notify.render(row)));
  const [added, addedOwn, gone, goneOwn, rejected] = said;
  assert.match(added!, /到“账号”页/);
  assert.ok(added!.endsWith('(https://tycho.example/#/accounts)'), added);
  assert.match(addedOwn!, /机器 gpu-1 上的 codex 登录 .*到“机器”页/);
  assert.ok(addedOwn!.endsWith('(https://tycho.example/#/machines)'), addedOwn);
  assert.match(gone!, /到“账号”页/);
  assert.ok(gone!.endsWith('(https://tycho.example/#/accounts)'), gone);
  assert.match(goneOwn!, /到“机器”页/);
  assert.ok(goneOwn!.endsWith('(https://tycho.example/#/machines)'), goneOwn);
  assert.ok(rejected!.endsWith('(https://tycho.example/#/accounts)'), rejected);
  assert.ok(said.every((each) => !each.includes('/settings/')), '不再指向设置页');
});

test('Weixin 1v1 DM replies stay SINGLE (chat_type=1) with console links while WeCom groups stay GROUP (chat_type=2) redacted', (t) => {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'wecom', 'weixin']);
  f.ledger.setWhitelist({ wecom: [OWNER], weixin: ['wx-owner'], console: ['console'] }, USER);
  const notify = createNotify({
    ledger: f.ledger,
    owner: () => OWNER,
    publicUrl: () => 'https://private-tycho.example',
    direct: async () => {},
    log() {},
  });

  // 1. Weixin 1v1 DM: thread = "weixin:<botId>:<actor>" !== actor, must still be chat_type 1 with console link
  const wxMsg = inbound(f, { channel: 'weixin', actor: 'wx-owner', thread: 'weixin:wx-bot-1:wx-owner', text: '查一下状态' });
  notify.finalReply(wxMsg, reply(f, wxMsg, '详情见 https://private-tycho.example/#/overview'));
  notify.unverified(wxMsg);

  // 2. WeCom group: thread = "wr-group" !== actor, must remain chat_type 2 and redact private console URL
  const wcGroup = inbound(f, { channel: 'wecom', actor: OWNER, thread: 'wr-group', text: '群里查状态' });
  notify.finalReply(wcGroup, reply(f, wcGroup, '群汇报 https://private-tycho.example/#/overview'));

  // 3. WeCom DM: thread === actor, must remain chat_type 1 with console link
  const wcDm = inbound(f, { channel: 'wecom', actor: OWNER, thread: OWNER, text: '私聊查状态' });
  notify.finalReply(wcDm, reply(f, wcDm, '私聊汇报'));

  // 4. Weixin unassigned message assign card also targets SINGLE (1) with console link
  const wxUnassigned = f.ledger.frontReceive({
    channel: 'weixin',
    bot: 'weixin:wx-bot-1',
    externalId: 'wx-unassigned-1',
    actor: 'wx-owner',
    thread: 'weixin:wx-bot-1:wx-owner',
    text: '归属测试',
    material: false,
  });
  assert.equal(wxUnassigned.state, 'unassigned');

  const rows = f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid');
  const [wxReplyRow, wxUnverifiedRow, wcGroupRow, wcDmRow, wxAssignRow] = rows;
  assert.ok(wxReplyRow && wxUnverifiedRow && wcGroupRow && wcDmRow && wxAssignRow);

  const wxReplyOut = notify.render(wxReplyRow)!;
  assert.deepEqual(wxReplyOut.target, { chatid: 'weixin:wx-bot-1:wx-owner', chat_type: 1 });
  assert.match(contentOf(wxReplyOut), /\[在控制台打开\]\(https:\/\/private-tycho\.example\/#\/projects\//);
  assert.doesNotMatch(contentOf(wxReplyOut), /私有控制台链接已隐藏/);

  const wxUnverifiedOut = notify.render(wxUnverifiedRow)!;
  assert.deepEqual(wxUnverifiedOut.target, { chatid: 'weixin:wx-bot-1:wx-owner', chat_type: 1 });
  assert.match(contentOf(wxUnverifiedOut), /\[在控制台打开\]\(https:\/\/private-tycho\.example/);

  const wcGroupOut = notify.render(wcGroupRow)!;
  assert.deepEqual(wcGroupOut.target, { chatid: 'wr-group', chat_type: 2 });
  assert.doesNotMatch(contentOf(wcGroupOut), /private-tycho\.example/);
  assert.doesNotMatch(contentOf(wcGroupOut), /在控制台打开/);
  assert.match(contentOf(wcGroupOut), /\[私有控制台链接已隐藏\]/);

  const wcDmOut = notify.render(wcDmRow)!;
  assert.deepEqual(wcDmOut.target, { chatid: OWNER, chat_type: 1 });
  assert.match(contentOf(wcDmOut), /\[在控制台打开\]\(https:\/\/private-tycho\.example/);

  const wxAssignOut = notify.render(wxAssignRow)!;
  assert.deepEqual(wxAssignOut.target, { chatid: 'weixin:wx-bot-1:wx-owner', chat_type: 1 });
  assert.equal(wxAssignOut.body.msgtype, 'template_card');
  const wxAssignCard = wxAssignOut.body.msgtype === 'template_card' ? wxAssignOut.body.template_card : undefined;
  assert.equal(wxAssignCard?.card_action?.url, 'https://private-tycho.example/#/');
});

test('notify.skipReason and render gracefully skip orphan outbox rows whose referenced records were deleted', (t) => {
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER, publicUrl: () => 'https://tycho.example', direct: async () => {}, log() {} });

  const cases: { kind: string; payload: Record<string, unknown>; expectedReason: RegExp }[] = [
    { kind: 'assign', payload: { external_id: 'orphan-assign', message_id: 'deleted-msg' }, expectedReason: /关联记录已删除/ },
    { kind: 'verify', payload: { external_id: 'orphan-verify', finding: 'residue', task_id: 'deleted-task', run_id: 'deleted-run' }, expectedReason: /关联记录已删除/ },
    { kind: 'approval', payload: { external_id: 'orphan-approval', approval_id: 'deleted-approval', task_id: 'deleted-task' }, expectedReason: /关联记录已删除/ },
    { kind: 'knowledge_proposal', payload: { external_id: 'orphan-proposal', proposal_id: 'deleted-proposal' }, expectedReason: /关联记录已删除/ },
    { kind: 'remind', payload: { external_id: 'orphan-remind-verify', kind: 'verify', payload: { finding: 'residue', task_id: 'deleted-task', run_id: 'deleted-run' }, n: 1, of: 3 }, expectedReason: /关联记录已删除/ },
  ];

  for (const item of cases) {
    f.ledger.enqueueNotification('wecom', item.kind, item.payload);
    const row = f.peek<OutboxRow>(
      `SELECT * FROM outbox WHERE json_extract(payload_json, '$.external_id') = ?`,
      String(item.payload.external_id),
    )[0]!;
    assert.equal(notify.render(row), undefined, `${item.kind} render should return undefined instead of throwing`);
    assert.match(notify.skipReason(row) ?? '', item.expectedReason, `${item.kind} skipReason should explain deletion`);
  }
});
