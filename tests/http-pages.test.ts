import {capturedHost} from './capture-host.ts';
// Guards against page reads mixing Tasks or Runs, actions bypassing ledger state
// checks or identity, cross-site and anonymous writes, overview counts losing child
// Approvals, Run SSE leaking unselected events or retaining abandoned listeners, and a
// backup the owner cannot see or that any page in the browser can set off, and a restore
// whose count is confirmed, or whose pause is lifted, before the count is done. And a
// task whose machine is out of contact shown with a time taken from the wrong wait, or
// without what is keeping it from being continued; or one whose machine answers that it
// cannot tell shown as out of contact, with a time it may go on at.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner } from '../runner/runner.ts';
import { InputError } from '../service/errors.ts';
import { RECENT_ENDED, taskLine, unverifiableText } from '../shared/labels.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, LOGIN, retryAfter, RUN_LIMIT_MS, RUNNER_TUNED, testCredentialRef, tune, USER } from './helpers.ts';
import { memoryLogins, memoryMachines, MACHINE } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

test('task detail returns its own children, history, Inputs, Approvals, and owning work', async (t) => {
  const { f, get } = await consoleApp(t);
  const work = f.queuedTask();
  const child = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, parentId: work.id, title: '子任务', goal: '目标' }, USER);
  const { task, run } = f.runningRun();
  f.ledger.addInput(work.id, '补充', USER);
  const approval = f.ledger.openApproval(work.id, [{ question: '继续？' }], USER);
  const body = await json(await get(`/api/tasks/${work.id}`));
  assert.equal(body.task.id, work.id);
  assert.deepEqual(body.children.map((row: any) => row.id), [child.id]);
  assert.equal(body.inputs[0].text, '补充');
  assert.equal(body.approvals[0].id, approval);
  assert.deepEqual(body.approvals[0].questions, [{ question: '继续？' }]);
  assert.deepEqual(body.runs, []);
  assert.equal((await json(await get(`/api/tasks/${child.id}`))).work.id, work.id);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  const history = (await json(await get(`/api/tasks/${task.id}`))).runs[0];
  assert.equal(history.receipt.summary, '完成');
  assert.equal(history.executor, null);
  assert.equal((await get('/api/tasks/missing')).status, 400);
  assert.equal((await get(`/api/tasks/${work.id}`, {})).status, 401);
  const list = await json(await get('/api/tasks?top=1'));
  assert.equal(list.children[0].id, child.id);
});

test('Run reads return the actual snapshot, normalized events, and trace, and reject missing Runs', async (t) => {
  const { f, get, emitRun } = await consoleApp(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: '实际内容', session_ref: 'old', executor: 'claude' } }, USER);
  emitRun(run.id, { kind: 'text', text: '输出' });
  assert.equal((await json(await get(`/api/runs/${run.id}/snapshot`))).snapshot.brief, '实际内容');
  assert.equal((await json(await get(`/api/runs/${run.id}/snapshot`))).executor, 'claude');
  assert.equal((await json(await get(`/api/tasks/${task.id}`))).runs[0].executor, 'claude');
  assert.deepEqual((await json(await get(`/api/runs/${run.id}/events`))).events, [{ kind: 'text', text: '输出' }]);
  assert.equal((await json(await get(`/api/runs/${run.id}/trace`))).run_id, run.id);
  for (const suffix of ['snapshot', 'events', 'trace']) {
    assert.equal((await get(`/api/runs/missing/${suffix}`)).status, 400, suffix);
    assert.equal((await get(`/api/runs/${run.id}/${suffix}`, {})).status, 401, suffix);
  }
});

test('resume, abandon, and accept keep ledger validation and record console identity', async (t) => {
  const { f, post } = await consoleApp(t);
  const held = f.queuedTask();
  f.ledger.holdTask(held.id, '暂停', USER);
  assert.equal((await post(`/api/tasks/${held.id}/resume`)).status, 200);
  const refused = await post(`/api/tasks/${held.id}/resume`, {});
  assert.equal(refused.status, 400);
  const refusal = await json(refused);
  assert.throws(() => f.ledger.resumeTask(held.id, USER), (error: Error) => {
    assert.equal(refusal.error, error.message);
    return true;
  });
  assert.equal((await post(`/api/tasks/${held.id}/abandon`, { reason: 123 })).status, 400);
  assert.equal((await post(`/api/tasks/${held.id}/abandon`, { reason: '不再需要' })).status, 200);
  assert.equal((await post(`/api/tasks/${held.id}/abandon`, { reason: '重复' })).status, 400);
  const { task, run } = f.runningRun();
  assert.equal((await post(`/api/tasks/${task.id}/accept`, { basis: '检查通过', without_review: true })).status, 400);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  assert.equal((await post(`/api/tasks/${task.id}/accept`, { basis: '检查通过', without_review: true })).status, 200);
  assert.equal(f.task(task.id).state, 'done');
  for (const action of ['task.resume', 'task.abandon', 'task.accept']) {
    assert.equal(f.ledger.listChanges({ taskId: action === 'task.accept' ? task.id : held.id })
      .find((row) => row.action === action)?.actor, 'console');
  }
});

test('Input and interrupt act on the selected Task through the ledger and Runner', async (t) => {
  const { f, post, state } = await consoleApp(t);
  const { task, run } = f.runningRun();
  const input = await post(`/api/tasks/${task.id}/inputs`, { text: '先检查现场' });
  assert.equal(input.status, 201);
  assert.equal((await json(input)).id, f.ledger.listInputs(task.id)[0]?.id);
  assert.equal(state.kicks, 1);
  assert.equal((await post(`/api/tasks/${task.id}/inputs`, { text: '' })).status, 400);
  assert.deepEqual(await json(await post(`/api/tasks/${task.id}/interrupt`, {})), { run_id: run.id, verdict: 'running' });
  assert.equal(f.task(task.id).state, 'stopping');
  const stopping = f.ledger.listChanges({ taskId: task.id }).find((row) => row.action === 'run.stopping');
  assert.equal(stopping?.actor, 'console');
  assert.equal((await post(`/api/tasks/${f.queuedTask().id}/interrupt`, {})).status, 400);
  f.ledger.settleRun(run.id, null, null);
  f.ledger.abandonTask(task.id, '不做了', USER);
  assert.equal((await post(`/api/tasks/${task.id}/inputs`, { text: '迟到' })).status, 400);
});

test('every Task write requires login and Origin and rejects a nonexistent Task', async (t) => {
  const { post, cookie } = await consoleApp(t);
  for (const [action, body] of [['resume', {}], ['abandon', { reason: '理由' }], ['accept', { basis: '依据' }],
    ['interrupt', {}], ['inputs', { text: '内容' }]] as const) {
    const path = `/api/tasks/missing/${action}`;
    assert.equal((await post(path, body, {})).status, 401, action);
    assert.equal((await post(path, body, { Cookie: cookie, Origin: 'https://elsewhere.test' })).status, 403, action);
    assert.equal((await post(path, body)).status, 400, action);
  }
});

test('pause writes a boolean as console, returns dispatch state, and rejects unsafe writes', async (t) => {
  const { f, post, cookie } = await consoleApp(t);
  assert.equal((await post('/api/pause', { paused: true }, {})).status, 401);
  assert.equal((await post('/api/pause', { paused: true }, { Cookie: cookie })).status, 403);
  assert.equal((await post('/api/pause', { paused: 'true' })).status, 400);
  assert.equal((await json(await post('/api/pause', { paused: true }))).dispatch.paused, true);
  assert.equal(f.peek<{ actor: string }>("SELECT actor FROM change WHERE action = 'pause.set'").at(-1)?.actor, 'console');
  assert.equal((await json(await post('/api/pause', { paused: false }))).dispatch.canDispatch, true);
});

test('overview counts top-level work but includes open child Approvals and the latest finished work items, as many as the side column carries', async (t) => {
  const { f, get } = await consoleApp(t);
  const work = f.queuedTask();
  const child = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, parentId: work.id, title: '子任务', goal: '目标', acceptance: '检查通过' }, USER);
  f.ledger.queueTask(child.id, USER);
  f.ledger.openApproval(child.id, [{ question: '决定？' }], USER);
  const task = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '验证交付', goal: '目标', acceptance: '检查通过' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  for (let i = 0; i < 12; i++) f.ledger.abandonTask(f.queuedTask().id, '关闭', USER);
  const body = await json(await get('/api/overview'));
  assert.deepEqual(body.counts, { waiting: 1, moving: 1, ready: 1, knowledge_awaiting: 0, pending_joins: 0 });
  assert.equal(body.approvals[0].task_id, child.id);
  assert.deepEqual(body.moving.map((row: any) => row.id), [work.id]);
  assert.equal(body.recent.length, RECENT_ENDED);
  assert.equal(body.state.router.alive, true);
  // The child's question, and the work that became ready: a result pushed at its settlement.
  assert.equal(body.state.outbox.pending, 2);
  assert.ok(!body.recent.some((row: any) => row.id === task.id));
  assert.equal((await get('/api/overview', {})).status, 401);
});

test('overview lists stopped work apart from finished work, each by when it stopped or finished', async (t) => {
  const { f, get } = await consoleApp(t);
  const { task: old, run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null);
  f.force('UPDATE run SET ended_at = ? WHERE id = ?', '2026-11-01T10:00:00.000Z', run.id);
  const newer = f.queuedTask();
  f.ledger.abandonTask(newer.id, '不再需要', USER);
  f.force('UPDATE task SET closed_at = ? WHERE id = ?', '2026-11-02T10:00:00.000Z', newer.id);
  f.ledger.addInput(old.id, '补充调查', USER);
  f.force("UPDATE change SET at = ? WHERE task_id = ? AND action = 'input.add'", '2099-11-04T10:00:00.000Z', old.id);
  const held = f.queuedTask();
  f.ledger.holdTask(held.id, '等资料', USER);
  f.force("UPDATE change SET at = ? WHERE task_id = ? AND action = 'task.hold'", '2026-11-03T10:00:00.000Z', held.id);
  const body = await json(await get('/api/overview'));
  assert.deepEqual(body.recent.map((row: any) => row.id), [newer.id]);
  assert.equal(body.recent[0].finished_at, '2026-11-02T10:00:00.000Z');
  assert.deepEqual(body.held.map((row: any) => row.id), [held.id, old.id]);
  assert.equal(body.held[0].stopped_at, '2026-11-03T10:00:00.000Z');
  assert.equal(body.held[0].reason, '等资料');
  assert.equal(body.held[0].summary.leaf, true);
});

test('SSE subscribes only selected Runs, shares Runner listeners, and releases them after close/logout', async (t) => {
  const { f, get, post, emitRun, runListeners } = await consoleApp(t);
  const a = f.runningRun().run;
  const b = f.runningRun().run;
  assert.equal((await get('/api/stream?runs=missing')).status, 400);
  assert.equal((await get(`/api/stream?runs=${a.id}`, {})).status, 401);
  const plain = await get('/api/stream');
  const one = await get(`/api/stream?runs=${a.id},${a.id}`);
  const two = await get(`/api/stream?runs=${a.id}`);
  const reader = one.body!.getReader();
  const decoder = new TextDecoder();
  let received = decoder.decode((await reader.read()).value);
  assert.equal(runListeners.get(a.id)?.size, 1);
  assert.equal(runListeners.get(b.id)?.size ?? 0, 0);
  const other = await get(`/api/stream?runs=${b.id}`);
  assert.equal(runListeners.get(b.id)?.size, 1);
  emitRun(b.id, { kind: 'text', text: '不能泄漏' });
  emitRun(a.id, { kind: 'text', text: '当前现场' });
  emitRun(a.id, { kind: 'text', text: '当前现场' });
  while ((received.match(/当前现场/g)?.length ?? 0) < 2) received += decoder.decode((await reader.read()).value);
  assert.match(received, /event: run_event/);
  assert.ok(!received.includes('不能泄漏'));
  assert.equal(received.match(/当前现场/g)?.length, 2);
  const events = received.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map(({ index }) => index), [0, 1]);
  const plainReader = plain.body!.getReader();
  let plainText = decoder.decode((await plainReader.read()).value);
  assert.ok(!plainText.includes('run_event'));
  await reader.cancel();
  await plainReader.cancel();
  await post('/api/logout', {});
  await two.body!.cancel();
  await other.body!.cancel();
  for (let n = 0; n < 50 && runListeners.get(a.id)?.size; n++) await sleep(10);
  assert.equal(runListeners.get(a.id)?.size, 0);
  assert.equal(runListeners.get(b.id)?.size, 0);
});

test('draft works expose child progress consistently in all reads', async (t) => {
  const { f, get } = await consoleApp(t);
  const work = f.newTask();
  const child = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, parentId: work.id, title: '执行', goal: '目标', acceptance: '通过' }, USER);
  f.ledger.queueTask(child.id, USER);
  const run = f.ledger.createRun(child.id, f.login, USER);
  f.ledger.markRunRunning(run.id);
  for (const state of ['running', 'ready', 'waiting_person']) {
    f.force('UPDATE task SET state = ? WHERE id = ?', state, child.id);
    const listed = (await json(await get('/api/tasks?top=1'))).tasks[0];
    const detail = await json(await get(`/api/tasks/${work.id}`));
    const overview = await json(await get('/api/overview'));
    assert.equal(listed.summary.dot, state);
    assert.deepEqual(detail.task.summary, listed.summary);
    assert.equal(detail.task.state, 'draft');
    if (state === 'running') assert.equal(overview.counts.moving, 1);
    if (state === 'ready') assert.equal(overview.counts.ready, 1);
    if (state === 'waiting_person') assert.equal(overview.counts.waiting, 1);
  }
});

test('a task whose machine is out of contact is moving work with the time it may be continued from and what holds that back, and launches already licensed stay visible while paused', async (t) => {
  const grace = 7 * 60_000;
  const { f, get, post } = await consoleApp(t, { lostGraceMs: () => grace });
  const { task, run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  const since = JSON.parse(f.run(run.id).error_json!).unreachable_since as string;
  const eligibleAt = new Date(Date.parse(since) + grace).toISOString();
  const lostOf = async () => (await json(await get(`/api/tasks/${task.id}`))).task.lost;
  assert.deepEqual(await lostOf(), { since, eligible_at: eligibleAt, stopping: false, blocked: null, waiting: null, missing_login: null, unverifiable: null });

  const launching = f.ledger.createRun(f.queuedTask().id, f.login, USER);
  await post('/api/pause', { paused: true });
  const overview = await json(await get('/api/overview'));
  assert.equal(overview.counts.waiting, 0, '失联中的任务不算等你');
  assert.equal(overview.verification, undefined, '“需要你核实”的列表已经去掉');
  const moving = overview.moving.find((work: any) => work.id === task.id);
  assert.ok(moving, '失联中的任务归在推进');
  assert.equal(overview.counts.moving, overview.moving.length);
  assert.deepEqual(moving.lost, { since, eligible_at: eligibleAt, stopping: false, blocked: 'paused', waiting: null, missing_login: null, unverifiable: null }, '暂停期间不会接续，要说出来');
  assert.equal(overview.launching[0].id, launching.id);

  const listed = (await json(await get('/api/tasks?top=1'))).tasks.find((row: any) => row.id === task.id);
  assert.equal(listed.lost.eligible_at, eligibleAt, '侧栏也要拿到可以接续的时刻');
  assert.equal((await lostOf()).eligible_at, eligibleAt);
  assert.equal((await json(await get('/api/summary'))).running, 2, '摘要里也归在推进');

  const refused = await post(`/api/tasks/${task.id}/resume`);
  assert.equal(refused.status, 400, '失联的任务不提供“继续”');
  assert.equal((await post(`/api/tasks/${task.id}/interrupt`)).status, 200);
  assert.equal((await json(await get(`/api/tasks/${task.id}`))).task.lost.stopping, true);
  f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  assert.equal(f.task(task.id).state, 'held', '停止意图优先');
  assert.equal((await post(`/api/tasks/${task.id}/resume`)).status, 200);
});

test('what holds a continuation back is read from what is true now: a restore not gone through, the loss limit, and the wait that actually decides', async (t) => {
  const grace = 7 * 60_000;
  const f = fixture(t);
  tune(f.ledger, 'run.maxLostContinuations', 2);
  const { get } = await consoleApp(t, { f, lostGraceMs: () => grace });
  const lostOf = async (taskId: string) => (await json(await get(`/api/tasks/${taskId}`))).task.lost;

  // One round lost already: losing this one too reaches the limit, and nothing continues it.
  const task = f.queuedTask();
  const first = f.ledger.createRun(task.id, f.login, USER);
  f.ledger.markRunRunning(first.id);
  f.ledger.settleRun(first.id, null, null, { kind: 'lost' });
  const second = f.ledger.createRun(task.id, f.login, USER);
  f.ledger.markRunRunning(second.id);
  f.ledger.markRunUnknown(second.id);
  assert.equal((await lostOf(task.id)).blocked, 'limit');

  // A start nobody confirmed, on a machine that answers: the time is counted from the
  // first answer that showed no trace of it, not from when contact was lost before that.
  const { task: other, run } = f.runningRun();
  f.ledger.markRunUnknown(run.id);
  f.ledger.markRunUnknown(run.id, 'unconfirmed');
  f.force(`UPDATE run SET error_json = json_set(error_json, '$.unconfirmed_since', '2026-11-05T01:00:00.000Z') WHERE id = ?`, run.id);
  assert.deepEqual(await lostOf(other.id), {
    since: '2026-11-05T01:00:00.000Z', eligible_at: '2026-11-05T01:07:00.000Z', stopping: false, blocked: null, waiting: null, missing_login: null, unverifiable: null,
  });
  // Out of contact again: that stretch decides, with its own beginning.
  f.ledger.markRunUnknown(run.id, 'unreachable');
  const again = JSON.parse(f.run(run.id).error_json!).unreachable_since as string;
  assert.equal((await lostOf(other.id)).since, again);

  f.ledger.sealRestore('backup.db');
  assert.equal((await lostOf(other.id)).blocked, 'recovering', '恢复清点没做完，不会接续');
});

// A machine that answers and cannot tell is neither out of contact nor a start nobody
// confirmed: the page says what the machine said, and gives no time the Task may go on at.
test('a Run whose machine answers that it cannot tell shows why, with no time to go on at', async (t) => {
  const { f, get } = await consoleApp(t);
  const { task, run } = f.runningRun();
  f.ledger.markRunUnknown(run.id, 'unreachable');
  f.ledger.markRunUnknown(run.id, 'unverifiable', '读不出 exit：EACCES');
  const shown = (await json(await get(`/api/tasks/${task.id}`))).task;
  assert.equal(shown.lost.unverifiable, '读不出 exit：EACCES');
  assert.equal(shown.lost.since, null, '机器回答了：失联的区间结束');
  assert.equal(shown.lost.eligible_at, null, '没有到点放行的时刻');
  assert.equal(taskLine(shown), unverifiableText('读不出 exit：EACCES'));
  assert.match(f.task(task.id).reason!, /读不出 exit：EACCES/, '任务的原因也是机器的原话');
  // Out of contact after all: that is the wait again, and the machine's old words are gone.
  f.ledger.markRunUnknown(run.id, 'unreachable');
  const away = (await json(await get(`/api/tasks/${task.id}`))).task.lost;
  assert.equal(away.unverifiable, null);
  assert.ok(away.eligible_at);
});

test('a account with no machine left shows on its waiting tasks at once and under what needs the owner once it is overdue', async (t) => {
  let waiting = [{ login_id: 't1', login_name: 't1', since: '2026-11-05T01:00:00.000Z', overdue: false }];
  // What the dispatcher would answer for a Task whose only account has no machine.
  const noMachine = (account: string) => ({ rest: null, full: [], no_machine: [account] });
  const { f, get } = await consoleApp(t, {
    waitingLogins: () => waiting,
    taskWait: ({ login_id: on }) => (on !== null && waiting.some(({ login_id: id }) => id === on) ? noMachine(on) : null),
  });
  const queuedOn = (loginId: string) => {
    const task = f.ledger.createTask({ projectId: f.projectId, title: loginId, goal: '目标', acceptance: '通过', loginId, roleId: 'implement' }, USER);
    f.ledger.queueTask(task.id, USER);
    return task;
  };
  const starved = queuedOn('t1');
  f.ledger.putAccount({ ...f.ledger.getAccount('t1')!, id: 't2', name: 't2' }, USER, 'ref-t2');
  const fine = queuedOn('t2');
  const { task: lost, run } = f.runningRun();
  f.force(`UPDATE task SET login_id = 't1' WHERE id = ?`, lost.id);
  f.ledger.markRunUnknown(run.id);

  let overview = await json(await get('/api/overview'));
  const waitOf = (id: string) => overview.moving.find((work: any) => work.id === id).waiting;
  assert.deepEqual(waitOf(starved.id), noMachine('t1'), '在等什么要写在看得见的地方');
  assert.equal(waitOf(fine.id), undefined);
  const held = overview.moving.find((work: any) => work.id === lost.id).lost;
  assert.deepEqual([held.blocked, held.waiting], ['no_machine', noMachine('t1')]);
  assert.deepEqual(overview.no_machine, [], '不到宽限期只是在等容量');
  assert.equal(f.task(starved.id).reason, null, '账本里不记：这是派发器当下看到的');
  assert.equal(f.task(starved.id).state, 'queued');

  waiting = [{ ...waiting[0]!, overdue: true }];
  overview = await json(await get('/api/overview'));
  assert.deepEqual(overview.no_machine, waiting);
  waiting = [];
  overview = await json(await get('/api/overview'));
  assert.equal(waitOf(starved.id), undefined, '机器回来后就不再写在等什么');
  assert.deepEqual(overview.no_machine, []);
});

test('abandoning from the Console goes through the Runner, which knows what to do about a Run out of contact', async (t) => {
  const f = fixture(t);
  const abandoned: unknown[] = [];
  const stub = (await consoleApp(t, { f })).runner;
  const { post } = await consoleApp(t, {
    f,
    runner: { ...stub, abandon: async (taskId, reason, ctx) => { abandoned.push([taskId, reason, ctx.actor]); } },
  });
  const { task } = f.runningRun();
  assert.equal((await post(`/api/tasks/${task.id}/abandon`, { reason: '不做了' })).status, 200);
  assert.deepEqual(abandoned, [[task.id, '不做了', 'console']]);
  assert.equal((await post(`/api/tasks/${task.id}/abandon`, { reason: 123 })).status, 400);
  assert.equal(abandoned.length, 1);
});

test('failed notifications are visible and retry is authenticated and audited', async (t) => {
  const { f, get, post, cookie } = await consoleApp(t);
  const row = f.ledger.outbox.enqueue('wecom', 'markdown', { text: '通知' });
  const start = new Date('2026-01-01T00:00:00Z');
  f.ledger.outbox.markFailed(row.id, '断线', retryAfter(3600000), start);
  f.ledger.outbox.markFailed(row.id, '断线', retryAfter(3600000), new Date(start.getTime() + 3600000));
  const overview = await json(await get('/api/overview'));
  assert.equal(overview.outbox.pending, 0);
  assert.equal(overview.outbox.given_up, 1);
  assert.equal(overview.outbox.failures[0].error, '断线');
  const path = `/api/outbox/${row.id}/retry`;
  assert.equal((await post(path, {}, {})).status, 401);
  assert.equal((await post(path, {}, { Cookie: cookie, Origin: 'http://elsewhere.test' })).status, 403);
  assert.equal((await post(path, {})).status, 200);
  assert.equal(f.peek<{ actor: string }>("SELECT actor FROM change WHERE action = 'outbox.retry'")[0]?.actor, 'console');
  f.ledger.outbox.markSent(row.id);
  assert.equal((await post(path, {})).status, 400);
});

test('ended Run reads distinguish complete, partial and unavailable history', async (t) => {
  const { f, get, runner } = await consoleApp(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  const path = '/api/runs/' + run.id + '/events';
  runner.eventSnapshot = async () => ({ events: [{ kind: 'text', text: '远端历史' }], firstIndex: 9, loaded: true });
  assert.deepEqual(await json(await get(path)), {
    run_id: run.id, events: [{ kind: 'text', text: '远端历史' }], first_index: 9, loaded: true,
  });
  runner.eventSnapshot = async () => ({ events: [], firstIndex: 0, loaded: false, reason: '主机不可达' });
  assert.deepEqual(await json(await get(path)), { run_id: run.id, events: [], first_index: 0, loaded: false, reason: '主机不可达' });
  runner.eventSnapshot = async () => ({ events: [{ kind: 'text', text: '缓存' }], firstIndex: 3, loaded: true, reason: '主机不可达' });
  assert.deepEqual(await json(await get(path)), {
    run_id: run.id, events: [{ kind: 'text', text: '缓存' }], first_index: 3, loaded: true, reason: '主机不可达',
  });
});

test('ended Runs do not retain live listeners and final events arrive before release', async (t) => {
  const { f, get, emitRun, runListeners } = await consoleApp(t);
  const { run } = f.runningRun();
  const ended = f.runningRun().run;
  f.ledger.settleRun(ended.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  const stream = await get(`/api/stream?runs=${run.id},${ended.id}`);
  const reader = stream.body!.getReader();
  await reader.read();
  assert.equal(runListeners.get(ended.id)?.size ?? 0, 0);
  emitRun(run.id, { kind: 'text', text: '最后输出' });
  const received = new TextDecoder().decode((await reader.read()).value);
  assert.match(received, /最后输出/);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  await sleep(1100);
  assert.equal(runListeners.get(run.id)?.size, 0);
  await reader.cancel();
});

test('SSE ends when its session naturally expires', async (t) => {
  let now = Date.now();
  const { get } = await consoleApp(t, { now: () => now, keepaliveMs: 20 });
  const response = await get('/api/stream');
  const reader = response.body!.getReader();
  await reader.read();
  now += 31 * 86400000;
  let done = false;
  for (let reads = 0; reads < 3 && !done; reads++) done = (await reader.read()).done;
  assert.equal(done, true);
});

test('login guidance depends on whether WeCom is configured', async (t) => {
  const { get: plain } = await consoleApp(t);
  const { get: wecom } = await consoleApp(t, { channels: () => ({ wecom: { connected: false } }) });
  for (const path of ['/login', `/login/${'0'.repeat(64)}`]) {
    assert.match(await (await plain(path, {})).text(), /npm run login-link/);
    assert.doesNotMatch(await (await plain(path, {})).text(), /私聊/);
    assert.match(await (await wecom(path, {})).text(), /私聊机器人发.*登录/);
  }
});

test('after a lost Run the task is already queued again: nothing to resume, and it can still be abandoned', async (t) => {
  const { f, post } = await consoleApp(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.ledger.listActiveRuns().length, 0);
  assert.equal((await post(`/api/tasks/${task.id}/resume`)).status, 400);
  assert.equal((await post(`/api/tasks/${task.id}/abandon`, { reason: '不再继续' })).status, 200);
  assert.equal(f.task(task.id).state, 'abandoned');
});

test('the task page carries the wake time for the page to show in local time', async (t) => {
  const { f, get } = await consoleApp(t);
  const task = f.queuedTask();
  f.ledger.scheduleWake(task.id, '2030-01-01T09:00:00+08:00', USER);
  const body = await json(await get(`/api/tasks/${task.id}`));
  assert.equal(body.task.wake_at, '2030-01-01T01:00:00.000Z');
});

test('the event snapshot and SSE number one sequence across a real truncation', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const total = 5010;
  const output = Buffer.from(Array.from({ length: total }, (_, line) => `l${line}\n`).join(''));
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger,
    machines: memoryMachines({h1:MACHINE}, f.ledger),
    adapters: { claude: { ...claudeAdapter, parse: (line) => [{ kind: 'text', text: line }] } },
    logins: memoryLogins({ t1: { ...f.login.login, tiers: {} } }),
    connect: () => capturedHost({
      // Only the read channel is asked here; the rest of §4.1's set answers as a
      // machine with nothing on it.
      place: async () => [],
      start: async () => ({ code: 0, stdout: '', stderr: '' }),
      stop: async () => {},
      state: async () => ({ started: false, launcher_alive: false, pid_alive: false, marked: false, exit: null, unknown: null }),
      list: async () => [],
      connected: () => true,
      artifacts: async () => [],
      dropRun: async () => {},
      readRange: async (_path, offset) => ({ bytes: output.subarray(offset), size: output.length, mtime: 1_700_000_000 }),
    },f.ledger),
  });
  const { get } = await consoleApp(t, { f, runner });
  const stream = await get(`/api/stream?runs=${run.id}`);
  const reader = stream.body!.getReader();
  await reader.read();
  await runner.tail(run);
  let frames = '';
  const lastFrame = new RegExp(`"text":"l${total - 1}"`);
  while (!lastFrame.test(frames)) frames += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const live = frames.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.equal(live.length, total);
  const body = await json(await get(`/api/runs/${run.id}/events`));
  assert.equal(body.events[0].kind, 'truncated', '超过 5000 条要真的截断');
  assert.equal(body.events[0].dropped, total - 5000);
  assert.equal(body.first_index + body.events.length, total, '快照的终点就是总事件数');
  assert.deepEqual(live.map(({ index }) => index), Array.from({ length: total }, (_, index) => index));
  for (const { index, event } of live.slice(-4999)) {
    assert.deepEqual(body.events[index - body.first_index], event, `SSE 序号 ${index} 要指向快照里同一条事件`);
  }
});

test('a restore stays on the overview until it is confirmed, and held Tasks block the confirmation', async (t) => {
  const orphans = [{ account_id: 't1', machine_id: 'h1', host: 'h1', runs: null, error: '连不上实例' }];
  const { f, get, post } = await consoleApp(t, { orphans: () => orphans });
  assert.equal((await json(await get('/api/state'))).restore, null);
  const active = f.runningRun();
  const task = f.queuedTask();
  const message = f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'console', text: '旧指令' });
  f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '已提交', goal: '目标' }, { actor: 'router', messageId: message.id });
  f.ledger.sealRestore('D:/backups/1');

  const { restore } = await json(await get('/api/overview'));
  assert.equal((await json(await get('/api/state'))).dispatch.paused, true);
  assert.equal(restore.from, 'D:/backups/1');
  assert.deepEqual(restore.held_tasks, [{ id: task.id, title: '任务' }]);
  assert.deepEqual(restore.unverified_messages.map(({ id, changes }: any) => [id, changes.map(({ action }: any) => action)]), [[message.id, ['task.create']]]);
  assert.deepEqual(restore.runs.map(({ id, state }: any) => [id, state]), [[active.run.id, 'running']]);
  assert.deepEqual(restore.orphan_runs, orphans);
  assert.deepEqual((await json(await get('/api/state'))).restore, restore);

  const refused = await post('/api/restore/confirm');
  assert.equal(refused.status, 400);
  assert.match((await json(refused)).error, /还有 1 个任务/);
  assert.equal((await post(`/api/tasks/${task.id}/resume`)).status, 200);
  const early = await post('/api/pause', { paused: false });
  assert.equal(early.status, 400, '清点没确认就恢复了派发');
  assert.equal((await json(early)).error, '先确认清点完成，再恢复派发');
  assert.equal((await post('/api/pause', { paused: true })).status, 200, '置为暂停一直可以');
  assert.equal((await post('/api/restore/confirm')).status, 200);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'ledger.restore_confirm' AND actor = 'console'`).length, 1);
  assert.equal((await json(await get('/api/state'))).restore, null);
  assert.equal((await json(await get('/api/state'))).dispatch.paused, true, '恢复派发是另外一步');
  assert.equal((await post('/api/restore/confirm', {}, {})).status, 401);
  assert.equal((await json(await post('/api/pause', { paused: false }))).dispatch.canDispatch, true, '确认之后恢复派发走得通');
});

test('while an inventory runs the restore controls answer 503 with the reason and change nothing', async (t) => {
  const barrier = { recovering: false };
  const f = fixture(t, { recovery: { recovering: () => barrier.recovering } });
  const { post, get } = await consoleApp(t, { f });
  f.ledger.sealRestore('D:/backups/1');
  barrier.recovering = true;
  const attempts: [string, unknown][] = [['/api/restore/confirm', {}], ['/api/pause', { paused: false }], ['/api/pause', { paused: true }]];
  for (const [path, body] of attempts) {
    const refused = await post(path, body);
    assert.equal(refused.status, 503, path);
    assert.equal((await json(refused)).error, '正在清点，稍后再试');
  }
  assert.ok(f.ledger.getRestore());
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action IN ('pause.set', 'ledger.restore_confirm')`).length, 0);
  assert.equal((await get('/api/overview')).status, 200, '读不受影响');
  barrier.recovering = false;
  assert.equal((await post('/api/restore/confirm')).status, 200);
});

const BACKUP_VIEW = {
  configured: true, dir: 'E:\\b', at: '03:30', last_ok_at: '2026-11-05T00:00:00.000Z', last_ok_incomplete: false,
  last_error: { at: '2026-11-05T01:00:00.000Z', text: '盘满了' }, running: false,
} as const;

test('state and overview say whether backups are configured and how they stand', async (t) => {
  const bare = await consoleApp(t);
  for (const path of ['/api/state', '/api/overview']) {
    assert.deepEqual((await json(await bare.get(path))).backup, { configured: false }, path);
  }
  const app = await consoleApp(t, { backup: { status: () => BACKUP_VIEW, trigger: async () => ({ ok: false, at: 'x', error: 'y' }) } });
  for (const path of ['/api/state', '/api/overview']) {
    assert.deepEqual((await json(await app.get(path))).backup, BACKUP_VIEW, path);
  }
});

test('POST /api/backup needs login and Origin, waits for the result, and passes a refusal on', async (t) => {
  let calls = 0;
  let refused = false;
  const backup = {
    status: () => BACKUP_VIEW,
    trigger: async () => {
      if (refused) throw new InputError('还没确认清点');
      calls += 1;
      return { ok: true as const, at: 'x', ledger_bytes: 1, runs_files: 0, runs_incomplete: [], tool: 'backup' as const };
    },
  };
  const { post, cookie } = await consoleApp(t, { backup });
  assert.equal((await post('/api/backup', {}, {})).status, 401);
  assert.equal((await post('/api/backup', {}, { Cookie: cookie, Origin: 'https://elsewhere.test' })).status, 403);
  assert.equal(calls, 0);
  const done = await post('/api/backup');
  assert.equal(done.status, 200);
  assert.equal((await json(done)).ok, true);
  refused = true;
  const refusal = await post('/api/backup');
  assert.equal(refusal.status, 400);
  assert.equal((await json(refusal)).error, '还没确认清点');
});

test('POST /api/backup with no backup configured says so', async (t) => {
  const { post } = await consoleApp(t);
  const answer = await post('/api/backup');
  assert.equal(answer.status, 400);
  assert.equal((await json(answer)).error, '没有配置自动备份');
});

test('tasks and message changes include rich assignment projection across all task read routes', async (t) => {
  const { f, get } = await consoleApp(t);
  const acct = { id: 'acct-assign', name: 'Claude-主力', executor: 'claude', tiers: f.login.login.tiers };
  f.ledger.putAccount(acct, USER, testCredentialRef(acct.id));

  // Message turn creates a pinned task with no runs yet
  const { id: msgId } = f.ledger.receiveMessage({
    channel: 'console',
    externalId: 'assign-msg-1',
    actor: 'console',
    text: '建一个带分配信息的任务',
    projectId: f.projectId,
  });
  const pinnedTask = f.ledger.createTask(
    {
      roleId: 'implement',
      projectId: f.projectId,
      loginId: acct.id,
      title: '带预选账号任务',
      goal: '验证 assignment',
    },
    { actor: 'router', messageId: msgId },
  );
  f.ledger.queueTask(pinnedTask.id, USER);

  // Check /api/messages/:id/changes returns presented tasks with assignment, resumable, and clean source
  const changesBody = await json(await get(`/api/messages/${msgId}/changes`));
  assert.equal(changesBody.tasks.length, 1);
  const capsuleTask = changesBody.tasks[0];
  assert.equal(capsuleTask.id, pinnedTask.id);
  assert.equal(capsuleTask.source_json, undefined);
  assert.equal(typeof capsuleTask.resumable, 'boolean');
  assert.deepEqual(capsuleTask.assignment, {
    role_id: 'implement',
    role_name: '实现',
    tier: 'execute',
    tier_source: 'default',
    login_name: 'Claude-主力',
    executor: 'claude',
    machine_name: null,
    placed_by: null,
    is_live: true,
  });

  // Start a run on the task so latestRun populates machine_name, placed_by, executor, and login_name
  const run = f.ledger.createRun(
    pinnedTask.id,
    {
      login: acct,
      machine: f.login.machine,
      expectedRevision: f.task(pinnedTask.id).revision,
      snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'claude' },
      placedBy: 'order',
    },
    USER,
  );
  f.ledger.markRunRunning(run.id);

  const expectedLiveAssignment = {
    role_id: 'implement',
    role_name: '实现',
    tier: 'execute',
    tier_source: 'default',
    login_name: 'Claude-主力',
    executor: 'claude',
    machine_name: f.login.machine.id,
    placed_by: 'order',
    is_live: true,
  };

  // Verify on /api/tasks, /api/tasks?top=1, /api/tasks/:id, and /api/messages/:id/changes
  const allTasks = await json(await get('/api/tasks'));
  assert.deepEqual(allTasks.tasks.find((item: any) => item.id === pinnedTask.id)?.assignment, expectedLiveAssignment);

  const topTasks = await json(await get('/api/tasks?top=1'));
  assert.deepEqual(topTasks.tasks.find((item: any) => item.id === pinnedTask.id)?.assignment, expectedLiveAssignment);

  const detail = await json(await get(`/api/tasks/${pinnedTask.id}`));
  assert.deepEqual(detail.task.assignment, expectedLiveAssignment);

  const liveChanges = await json(await get(`/api/messages/${msgId}/changes`));
  assert.deepEqual(liveChanges.tasks[0].assignment, expectedLiveAssignment);

  // After settling, is_live becomes false while run metadata remains
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成' });
  const settledDetail = await json(await get(`/api/tasks/${pinnedTask.id}`));
  assert.deepEqual(settledDetail.task.assignment, {
    ...expectedLiveAssignment,
    is_live: false,
  });
});

test('projects GET, conversation, and PUT expose and validate per-project dispatch_order', async (t) => {
  const { f, url, cookie, get } = await consoleApp(t);
  const acctA = { id: 'acct-prio-a', name: 'A账号', executor: 'claude', tiers: f.login.login.tiers };
  const acctB = { id: 'acct-prio-b', name: 'B账号', executor: 'claude', tiers: f.login.login.tiers };
  f.ledger.putAccount(acctA, USER, testCredentialRef(acctA.id));
  f.ledger.putAccount(acctB, USER, testCredentialRef(acctB.id));

  const putProject = (body: unknown) => fetch(`${url}/api/projects/${f.projectId}`, {
    method: 'PUT',
    headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Initial GET /api/projects and GET /api/projects/:id/conversation expose dispatch_order + effective_dispatch_order
  const listBefore = await json(await get('/api/projects'));
  const projBefore = listBefore.projects.find((p: any) => p.id === f.projectId);
  assert.equal(projBefore.dispatch_order, null);
  assert.ok(Array.isArray(projBefore.effective_dispatch_order.operate));
  assert.ok(Array.isArray(projBefore.effective_dispatch_order.execute));
  assert.ok(Array.isArray(projBefore.effective_dispatch_order.decide));

  const convBefore = await json(await get(`/api/projects/${f.projectId}/conversation`));
  assert.equal(convBefore.project.dispatch_order, null);
  assert.deepEqual(convBefore.project.effective_dispatch_order, projBefore.effective_dispatch_order);

  // Invalid dispatch_order payloads are rejected with 400
  assert.equal((await putProject({ dispatch_order: 'bad' })).status, 400);
  assert.equal((await putProject({ dispatch_order: ['a'] })).status, 400);
  assert.equal((await putProject({ dispatch_order: { bogus: [acctA.id] } })).status, 400);
  assert.equal((await putProject({ dispatch_order: { execute: [123] } })).status, 400);

  // Valid PUT sets project dispatch_order and reflects in GET /api/projects and conversation
  const updated = await putProject({ dispatch_order: { execute: [acctB.id, acctA.id] } });
  assert.equal(updated.status, 200);
  const updatedBody = await json(updated);
  assert.deepEqual(updatedBody.project.dispatch_order, { execute: [acctB.id, acctA.id] });
  assert.deepEqual(updatedBody.project.effective_dispatch_order.execute.slice(0, 2), [acctB.id, acctA.id]);

  const convAfter = await json(await get(`/api/projects/${f.projectId}/conversation`));
  assert.deepEqual(convAfter.project.dispatch_order, { execute: [acctB.id, acctA.id] });
  assert.deepEqual(convAfter.project.effective_dispatch_order.execute.slice(0, 2), [acctB.id, acctA.id]);

  // Setting dispatch_order to null clears the project override
  const cleared = await putProject({ dispatch_order: null });
  assert.equal(cleared.status, 200);
  assert.equal((await json(cleared)).project.dispatch_order, null);
});
