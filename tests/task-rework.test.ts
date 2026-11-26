// Guards the way back from 待验收 into 接着做 — what the owner does when the work is not
// what was asked for — against:
// - a Task sent back with nothing said about what to redo, from a state that is not 待验收,
//   or by a caller acting on a revision the Task has since left: nothing is written then;
// - the note not reaching the next round as a pending input, the round after the return
//   starting from another source or in a new session instead of the one the Task left,
//   or the returned Task being dispatched twice;
// - the console's own action and the Router's tool reaching the ledger by different ways,
//   or the Router being able to send back a Task without saying which revision it read.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner } from '../runner/runner.ts';
import type { Snapshot } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import type { TaskRow } from '../service/ledger.ts';
import { createMachines } from '../service/machines.ts';
import { createTools } from '../service/tools.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import { consoleApp } from './console-helpers.ts';
import { fakeRemote } from './fake-remote.ts';
import { accepting, claudeTier, DISPATCH_TUNED, DONE, fixture, memoryLogins, RUNNER_TUNED, USER } from './helpers.ts';

// The machine h1's own Claude Code login: the fixture's.
const LOGIN = { id: 'h1/claude', name: 'h1/claude', executor: 'claude', machine: 'h1', tiers: { execute: claudeTier('/tiers/execute.json') } };

// A Task that has run once and is waiting to be accepted: the state the owner sends back.
function accepted(t: TestContext): { f: ReturnType<typeof fixture>; task: TaskRow } {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE, { sessionRef: 's1' });
  return { f, task };
}

test('退回返工：任务回队列、说明成为下一次执行的输入、修订不动', (t) => {
  const { f, task } = accepted(t);
  assert.equal(f.task(task.id).state, 'ready');
  const before = f.dump();

  const inputId = f.ledger.reworkTask(task.id, '最后一次测试之后你又改过文件，重新跑一遍测试再交', task.revision, USER);

  const after = f.task(task.id);
  assert.equal(after.state, 'queued');
  assert.equal(after.revision, task.revision, '退回不改目标、范围或验收，修订也就不动');
  assert.deepEqual(
    f.ledger.listInputs(task.id).map(({ id, text, state }) => ({ id, text, state })),
    [{ id: inputId, text: '最后一次测试之后你又改过文件，重新跑一遍测试再交', state: 'queued' }],
  );
  // 退回是一次控制操作：谁发起、按哪个修订、说明落到哪一条输入，都要留在审计里。
  const rows = f.peek<{ actor: string; detail_json: string }>(`SELECT actor, detail_json FROM change WHERE action = 'task.rework'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, 'user');
  assert.deepEqual(JSON.parse(rows[0]!.detail_json), { input_id: inputId, revision: task.revision });
  assert.equal((before.change as unknown[]).length + 1, f.count('change'), '退回只写这一行状态转换');
});

test('退回说不清或走不通时什么都不写：修订不对、状态不是待验收、说明为空、还挂着 Run', (t) => {
  const { f, task } = accepted(t);
  const refuse = (why: RegExp, run: () => void): void => {
    const before = f.dump();
    assert.throws(run, why);
    assert.deepEqual(f.dump(), before, `被拒的退回不该写任何东西：${why}`);
  };

  refuse(/修订/, () => f.ledger.reworkTask(task.id, '再来一次', task.revision + 1, USER));
  refuse(/修订/, () => f.ledger.reworkTask(task.id, '再来一次', task.revision - 1, USER));
  refuse(/退回说明不能为空/, () => f.ledger.reworkTask(task.id, '  ', task.revision, USER));
  assert.equal(f.task(task.id).state, 'ready');
  assert.deepEqual(f.ledger.listInputs(task.id), []);

  // 排队中的任务不能退回；已验收(done)和已停住(held)的任务可以退回返工；已放弃的不能退回。
  const queued = f.queuedTask();
  refuse(/排队中.*不能退回返工/, () => f.ledger.reworkTask(queued.id, '再来一次', queued.revision, USER));
  const finished = f.runningRun();
  f.ledger.settleRun(finished.run.id, 0, DONE);
  f.ledger.acceptTask(finished.task.id, '看过', USER, { withoutReview: true });
  f.ledger.reworkTask(finished.task.id, '补充遗漏项', f.task(finished.task.id).revision, USER);
  assert.equal(f.task(finished.task.id).state, 'queued');
  const abandoned = f.queuedTask();
  f.ledger.abandonTask(abandoned.id, '不用做了', USER);
  refuse(/已放弃.*不能退回返工/, () => f.ledger.reworkTask(abandoned.id, '再来一次', f.task(abandoned.id).revision, USER));

  // 待验收却还挂着一个没结束的 Run：单活跃 Run 的底线在前，退回被拒，不会多派一轮。
  const odd = f.runningRun();
  f.force(`UPDATE task SET state = 'ready' WHERE id = ?`, odd.task.id);
  refuse(/还有未结束的 Run/, () => f.ledger.reworkTask(odd.task.id, '再来一次', f.task(odd.task.id).revision, USER));
  assert.equal(f.run(odd.run.id).state, 'running');
});

test('退回后接续的一轮：同一个代码来源、同一个会话，说明随快照送到机器上', async (t) => {
  const f = fixture(t);
  const remote = fakeRemote();
  remote.keepUploads = true;
  const accounts = memoryLogins({ [LOGIN.id]: LOGIN }, f.ledger);
  const machines = { get: (id: string) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() };
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: accounts, machines, connect: remote.connect, log: () => {},
  });
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    ledger: f.ledger,
    runner,
    logins: accounts,
    machines,
    executors: { claude: claudeAdapter },
    runTimeoutMs: () => 60_000,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  // The project's code is a repository its machines clone (the ledger's two columns written
  // directly, so that the fixture needs no project of its own).
  const source = { id: 'src1', kind: 'repo' as const, url: 'https://example.test/owner/project.git' };
  f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([source]), f.projectId);

  const task = f.ledger.createTask(
    { projectId: f.projectId, title: '改一处', goal: '目标', acceptance: '测试通过', loginId: LOGIN.id, roleId: 'implement' },
    USER,
  );
  f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: source.id, pinned: source }), task.id);
  f.ledger.queueTask(task.id, USER);
  await dispatcher.tick();
  const first = f.ledger.listRuns(task.id).at(-1)!;
  const snapshotOf = (run: { snapshot_json: string }): Snapshot => JSON.parse(run.snapshot_json) as Snapshot;
  assert.deepEqual(snapshotOf(first).source, snapshotSourceOf(source));

  // 这一轮跑完，交回来的东西不被接受：退回接着做。
  f.ledger.settleRun(first.id, 0, DONE, { sessionRef: 's1' });
  assert.equal(f.task(task.id).state, 'ready');
  const inputId = f.ledger.reworkTask(task.id, '你交的提交上没有跑过测试：跑一遍再交', 1, USER);
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.ledger.listRuns(task.id).length, 1, '退回本身不派发');
  await dispatcher.tick();

  const second = f.ledger.listRuns(task.id).at(-1)!;
  assert.notEqual(second.id, first.id);
  const snapshot = snapshotOf(second);
  assert.deepEqual(
    snapshot.source,
    snapshotSourceOf(source),
    '同一绑定身份的那份副本：还是同一个来源，机器上那一棵树不被换掉',
  );
  assert.equal(snapshot.session_ref, 's1', '能续接的执行器接着上一轮的会话');
  assert.deepEqual(snapshot.inputs, [{ id: inputId, text: '你交的提交上没有跑过测试：跑一遍再交' }]);
  assert.match(snapshot.brief, /先核对现场/, '被人退回之后重新放行的一轮先核对现场');
  assert.match(snapshot.brief, /同任务后续轮次复用/);

  // 送上机器的上下文里，退回的说明是这一轮要处理的要求，不是上一轮的历史。
  const sent = remote.uploads.get(second.id);
  assert.ok(sent, '这一轮没有往机器上传东西');
  t.after(() => rmSync(sent, { recursive: true, force: true }));
  const context = JSON.parse(readFileSync(join(sent, 'context.json'), 'utf8')) as {
    pending_inputs: { id: string; text: string }[];
    history: unknown[];
  };
  assert.deepEqual(context.pending_inputs, [{ id: inputId, text: '你交的提交上没有跑过测试：跑一遍再交' }]);
  assert.equal(context.history.length, 1, '上一轮只作资料');
});

test('负责人的 rework_task：说明为空或修订不对被拒，省略 expected_revision 时照常生效', async (t) => {
  const { f, task } = accepted(t);
  const tools = createTools({
    ledger: f.ledger,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: { get: f.ledger.getAccount, list: f.ledger.listAccounts },
    machines: createMachines({ ledger: f.ledger }),
    accept: accepting(f.ledger),
  });
  const call = async (args: unknown) => {
    const result = await tools.call('rework_task', args, { actor: 'router' }, { projectId: f.projectId });
    return { text: result.content[0]!.text, isError: result.isError === true };
  };

  assert.equal(tools.names.includes('rework_task'), true);
  const blankNote = await call({ task_id: task.id, note: '   ' });
  assert.equal(blankNote.isError, true);
  assert.match(blankNote.text, /退回说明不能为空/);

  const stale = await call({ task_id: task.id, note: '再来一次', expected_revision: task.revision + 1 });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /修订/);
  assert.equal(f.task(task.id).state, 'ready');
  assert.deepEqual(f.ledger.listInputs(task.id), []);

  // Omitting expected_revision succeeds directly.
  const sent = await call({ task_id: task.id, note: '再核验一次再交' });
  assert.equal(sent.isError, false);
  assert.match(sent.text, /退回接着做/);
  assert.equal(f.task(task.id).state, 'queued');
  assert.deepEqual(
    f.ledger.listInputs(task.id).map(({ text, actor }) => ({ text, actor })),
    [{ text: '再核验一次再交', actor: 'router' }],
  );
  assert.deepEqual(
    f.peek<{ actor: string }>(`SELECT actor FROM change WHERE action = 'task.rework'`).map(({ actor }) => actor),
    ['router'],
  );
});

test('控制台的退回：带上页面上的修订，走的是同一个账本函数', async (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const { post } = await consoleApp(t, { f });
  assert.equal(f.task(task.id).state, 'ready');

  const ok = await post(`/api/tasks/${task.id}/rework`, { note: '测试是在旧提交上跑的，重跑一遍', revision: task.revision });
  assert.equal(ok.status, 201);
  assert.equal(((await ok.json()) as { task: TaskRow }).task.state, 'queued');
  assert.deepEqual(
    f.ledger.listInputs(task.id).map(({ text, actor, state }) => ({ text, actor, state })),
    [{ text: '测试是在旧提交上跑的，重跑一遍', actor: 'console', state: 'queued' }],
  );

  // 页面上那个修订已经被改过：退回被拒，任务留在原地，说明也不落账。
  const second = f.runningRun();
  f.ledger.settleRun(second.run.id, 0, DONE);
  const refused = await post(`/api/tasks/${second.task.id}/rework`, { note: '再来一次', revision: second.task.revision + 1 });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /修订/);
  assert.equal(f.task(second.task.id).state, 'ready');

  const empty = await post(`/api/tasks/${second.task.id}/rework`, { note: '   ', revision: second.task.revision });
  assert.equal(empty.status, 400);
  assert.match(((await empty.json()) as { error: string }).error, /退回说明不能为空/);
  assert.equal(f.task(second.task.id).state, 'ready');
  assert.deepEqual(f.ledger.listInputs(second.task.id), []);

  // rework 也支持省略 revision
  const noRev = await post(`/api/tasks/${second.task.id}/rework`, { note: '不带修订号也能退回' });
  assert.equal(noRev.status, 201);
  assert.equal(((await noRev.json()) as { task: TaskRow }).task.state, 'queued');
});

test('continueTask 续接已验收(done)任务：重排并沿用原 session_ref，且支持 HTTP /continue 接口', async (t) => {
  const f = fixture(t);
  const remote = fakeRemote();
  const accounts = memoryLogins({ [LOGIN.id]: LOGIN }, f.ledger);
  const machines = { get: (id: string) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() };
  const runner = createRunner({
    ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: accounts, machines, connect: remote.connect, log: () => {},
  });
  const dispatcher = createDispatcher({
    ...DISPATCH_TUNED,
    ledger: f.ledger, runner, logins: accounts, machines, executors: { claude: claudeAdapter }, runTimeoutMs: () => 60_000, log: () => {},
  });
  t.after(() => dispatcher.stop());

  const task = f.ledger.createTask(
    { projectId: f.projectId, title: '主功能线程', goal: '实现初版', acceptance: '单测通过', loginId: LOGIN.id, roleId: 'implement' },
    USER,
  );
  f.ledger.queueTask(task.id, USER);
  await dispatcher.tick();
  const first = f.ledger.listRuns(task.id).at(-1)!;
  f.ledger.settleRun(first.id, 0, DONE, { sessionRef: 'sess-thread-1' });
  f.ledger.acceptTask(task.id, '初版通过', USER, { withoutReview: true });
  assert.equal(f.task(task.id).state, 'done');

  // continueTask on done task immediately re-queues and keeps session_ref on next dispatch
  const res = f.ledger.continueTask(task.id, '增加批量导出支持', undefined, USER);
  assert.equal(res.queued, true);
  assert.equal(res.active, false);
  assert.equal(f.task(task.id).state, 'queued');
  await dispatcher.tick();

  const second = f.ledger.listRuns(task.id).at(-1)!;
  assert.notEqual(second.id, first.id);
  const snapshot = JSON.parse(second.snapshot_json) as Snapshot;
  assert.equal(snapshot.session_ref, 'sess-thread-1');
  assert.deepEqual(snapshot.inputs, [{ id: res.id, text: '增加批量导出支持' }]);

  // HTTP POST /api/tasks/:id/continue works on running task (active: true) and on done/ready task (active: false)
  const { post } = await consoleApp(t, { f });
  const activeHttp = await post(`/api/tasks/${task.id}/continue`, { note: '顺带加上进度条' });
  assert.equal(activeHttp.status, 201);
  const activeBody = (await activeHttp.json()) as { id: string; queued: boolean; active: boolean; task: TaskRow };
  assert.equal(activeBody.queued, true);
  assert.equal(activeBody.active, true);
  assert.equal(activeBody.task.state, 'running');

  // Abandoned task is refused
  const abandoned = f.queuedTask();
  f.ledger.abandonTask(abandoned.id, '取消', USER);
  assert.throws(() => f.ledger.continueTask(abandoned.id, '再试', undefined, USER), /已放弃，不能继续/);
});
