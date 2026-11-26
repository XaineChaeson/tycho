// Guards against §5.6 not holding on a real restart: dispatch running before the
// inventory, a second Router next to one that could not be cleared, a Run left unchecked
// or a stop left unfinished, a message left in processing or sent again, a wake firing
// twice or not at all, notifications lost, a failed resume leaving the Router without
// context, degraded mode ending with dispatch released before anything was counted, the
// other doors staying open during that count (a start in flight, a message, a notice),
// and a stop that leaves an inventory or a half-done start running on after it; a trigger due
// while the service was down not taken up at the start, or one taken up twice over restarts.
// One case per step, on the real ledger, the real startService, the fake CLI and instance.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { serviceFile } from '../service/config.ts';
import type { Processes } from '../service/session-host.ts';
import { hostProcesses } from '../service/processes.ts';
import { startGateway } from './wecom-gateway.mjs';
import { signIn, stage, LOGIN, until, pageProject } from './stage.ts';

const options = { timeout: 90_000 };
const USER = { actor: 'test' };
const stuck: Processes = { find: async () => [4242], kill: async () => {} };

test('第 1 步：核实完成之前不派发', options, async (t) => {
  const { remote, start, stop, queued, launched, runsOf } = stage(t);
  const first = await start();
  const busy = queued(first, '在跑的');
  const run = await launched(first, busy);
  await stop(first);

  const before = await start({ dispatchIntervalMs: 60_000 });
  const waiting = queued(before, '排队的');
  await stop(before);

  const release = remote.hold('state.sh');
  const seen = remote.called('state.sh', run.id);
  const starting = start();
  await until(() => remote.called('state.sh', run.id) > seen, '开始核实');
  await sleep(150);
  assert.equal(remote.called('start.sh'), 1, '§5.6 第 1 步：核实结束前发出了新的启动');
  release();
  const service = await starting;
  await until(() => runsOf(service, waiting).length === 1, '核实之后派发');
  assert.equal(service.ledger.getTask(waiting.id).state, 'running');
});

test('第 2 步：残留负责人清不掉时不启动新驱动者，服务进入停摆且可见', options, async (t) => {
  const { start, stop, greet, routerStarts } = stage(t);
  const first = await start();
  await greet(first);
  const session = first.ledger.currentContext(first.ledger.listProjects()[0]?.id ?? '')!;
  await stop(first);
  const started = routerStarts();

  const service = await start({ processes: stuck });
  const client = await signIn(service);
  const state = (await (await client.get('/api/state')).json()) as { router: { alive: boolean; error: string | null } };
  assert.match(state.router.error ?? '', /清不掉/, '§11 第七组：停摆没有出现在 /api/state');
  assert.equal(state.router.alive, false);
  const message = service.ledger.receiveMessage({ channel: 'console', externalId: '之后', actor: 'console', text: '之后', projectId: pageProject(service) });
  await sleep(150);
  assert.equal(routerStarts(), started, '底线“负责人进程唯一归属”：清不掉残留还启动了新的负责人');
  assert.equal(service.ledger.getMessage(message.id).state, 'received');
  assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')?.id, session.id, '不能确认旧负责人已死，就不能关掉它的会话');
});

test('第 2 步：能清掉的残留清掉后正常接上', options, async (t) => {
  const { start, stop, routerStarts, greet } = stage(t);
  const first = await start();
  // A project's Router starts with its first message.
  await greet(first);
  await stop(first);
  const killed: number[] = [];
  let leftover = [99_999];
  const service = await start({
    processes: {
      // Only the naming of the leftover is this stand-in's: once it is gone, looking for a
      // marker is the real thing again. service/processes.ts promises nothing by a kill
      // returning — the Host looks again — so a find that always answers "nothing" would let
      // the stop finish while the real Router it just signalled still holds its working
      // directory, and the fixture's own cleanup of the data directory then fails with EPERM.
      find: async (marker) => (leftover.length > 0 ? leftover : hostProcesses.find(marker)),
      async kill(pid, marker) {
        if (pid !== 99_999) return hostProcesses.kill(pid, marker);
        killed.push(pid);
        leftover = [];
      },
    },
  });
  assert.deepEqual(killed, [99_999]);
  assert.equal(service.session.status().error, null);
  await greet(service);
  await until(() => routerStarts() === 2, '新负责人启动');
});

test('第 3 步：每个非终态 Run 都核实，停止中的先完成停止', options, async (t) => {
  const { remote, start, stop, queued, launched } = stage(t);
  const first = await start();
  const going = await launched(first, queued(first, '继续跑的'));
  const gone = await launched(first, queued(first, '消失的'));
  const ended = await launched(first, queued(first, '跑完的'));
  const stopped = await launched(first, queued(first, '停止中的'));
  first.ledger.markRunStopping(stopped.id, USER);
  // Before the watcher gets to it: the stop has to wait for the restart.
  await stop(first);
  // What the service missed while it was down.
  Object.assign(remote.runOf(gone.id), { pid_alive: false, marked: false });
  remote.finish(ended.id, { status: 'done', summary: '好了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  remote.finish(stopped.id, { status: 'done', summary: '抢在停止前写完', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  Object.assign(remote.runOf(stopped.id), { pid_alive: true, marked: true });

  const service = await start({ dispatchIntervalMs: 60_000, watchIntervalMs: 60_000 });
  const { ledger } = service;
  assert.equal(ledger.getRun(going.id).state, 'running');
  assert.equal(ledger.getRun(gone.id).exit_kind, 'lost');
  assert.equal(ledger.getTask(gone.task_id).state, 'queued', '看到进程不在：自动回去排队，不等人');
  assert.equal(ledger.getRun(ended.id).exit_kind, 'completed');
  assert.equal(ledger.getTask(ended.task_id).state, 'ready');
  assert.ok(remote.called('stop.sh', stopped.id) >= 1, '§5.6 第 3 步：stopping 的 Run 没有先完成停止');
  assert.equal(ledger.getRun(stopped.id).exit_kind, 'interrupted');
  assert.equal(ledger.getTask(stopped.task_id).state, 'held');
});

test('第 3 步：配置里没了的账号，它的 Run 按机器被移除判定丢失；任务没有目标可接续才停住', options, async (t) => {
  const { remote, start, stop, queued, launched } = stage(t);
  const first = await start();
  const run = await launched(first, queued(first));
  await stop(first);
  const calls = remote.called('state.sh', run.id);
  const service = await start({}, { logins: { other: { id: 'other', name: 'other', executor: 'claude', tiers: LOGIN.tiers } } });
  const settled = service.ledger.getRun(run.id);
  assert.equal(settled.exit_kind, 'lost');
  assert.equal(JSON.parse(settled.error_json!).lost.basis, 'removed');
  assert.equal(remote.called('state.sh', run.id), calls, '机器被移除就是不在了，不用去连');
  await until(() => service.ledger.getTask(run.task_id).state === 'held', '没有目标可接续的任务停住');
  assert.match(service.ledger.getTask(run.task_id).reason!, /没有可用的登录/);
});

test('第 4 步：processing 的消息置 unverified，不重投', options, async (t) => {
  const { start, wreck, greet, say, turnsSeen } = stage(t);
  const first = await start();
  await greet(first);
  const message = say(first, '长回合');
  await until(() => turnsSeen().includes('长回合'), '回合开始');
  await wreck(first);

  const service = await start();
  assert.equal(service.ledger.getMessage(message).state, 'unverified');
  await sleep(150);
  assert.deepEqual(turnsSeen().filter((text) => text === '长回合'), ['长回合'], '§5.1：中断的消息被重投');
});

test('第 5 步：到期的预约只恢复一次', options, async (t) => {
  const { start, stop, queued } = stage(t);
  const first = await start({ dispatchIntervalMs: 60_000 });
  first.ledger.setPause(true, USER);
  const task = queued(first);
  first.ledger.scheduleWake(task.id, new Date(Date.now() + 100).toISOString(), USER);
  await stop(first);
  await sleep(150);

  const second = await start({ dispatchIntervalMs: 60_000 });
  const wakes = () => second.ledger.listChanges({ taskId: task.id }).filter(({ action }) => action === 'task.wake');
  assert.equal(second.ledger.getTask(task.id).state, 'queued');
  assert.equal(second.ledger.getTask(task.id).wake_at, null);
  assert.equal(wakes().length, 1);
  await stop(second);

  const third = await start({ dispatchIntervalMs: 60_000 });
  const again = third.ledger.listChanges({ taskId: task.id }).filter(({ action }) => action === 'task.wake');
  assert.equal(again.length, 1, '§5.6 第 5 步：同一个预约恢复了两次');
});

test('第 5 步：还没到期的预约重启后还在', options, async (t) => {
  const { start, stop, queued } = stage(t);
  const first = await start({ dispatchIntervalMs: 60_000 });
  const task = queued(first);
  const at = new Date(Date.now() + 3_600_000).toISOString();
  first.ledger.scheduleWake(task.id, at, USER);
  await stop(first);
  const second = await start();
  assert.equal(second.ledger.getTask(task.id).state, 'waiting_timer');
  assert.equal(second.ledger.getTask(task.id).wake_at, at);
});

test('第 6 步：Outbox 继续发送重启前留下的 pending', options, async (t) => {
  const gateway = await startGateway();
  t.after(() => gateway.close());
  const { dataDir, start, stop } = stage(t);
  const first = await start();
  first.ledger.outbox.enqueue('wecom', 'markdown', { target: { chatid: 'zhang', chat_type: 1 }, content: '重启前留下的' });
  await stop(first);

  await start({}, { wecom: { botId: 'bot', secret: 'secret', owner: 'zhang', url: gateway.url } });
  await until(
    () => gateway.sent('aibot_send_msg').some(({ body }) => body.msgtype === 'markdown' && body.markdown.content.startsWith('【系统】重启前留下的')),
    '留下的通知发出去',
  );
});

test('第 7 步：续接负责人原会话', options, async (t) => {
  const { start, stop, greet, say, turnsSeen } = stage(t);
  const first = await start();
  await greet(first);
  const session = first.ledger.currentContext(first.ledger.listProjects()[0]?.id ?? '')!;
  await stop(first);
  const overviews = turnsSeen().filter((text) => text.includes('从账本重建')).length;

  const service = await start();
  const message = say(service, '接着');
  await until(() => service.ledger.getMessage(message).state === 'processed', '回合结束');
  assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')?.id, session.id);
  assert.equal(turnsSeen().filter((text) => text.includes('从账本重建')).length, overviews, '续接成功时不该重发概览');
});

test('第 7 步：续接失败就新开，首条消息是从账本重建', options, async (t) => {
  const { start, stop, greet, say, turnsSeen } = stage(t);
  const first = await start();
  await greet(first);
  const session = first.ledger.currentContext(first.ledger.listProjects()[0]?.id ?? '')!;
  await stop(first);
  const seen = turnsSeen().length;

  process.env.FAKE_CLAUDE_RESUME = 'exit';
  const service = await start();
  // The resume fails before the CLI has taken anything up: the message never reached a model,
  // and goes to the new context instead of being lost (docs/design/project-sessions.md §3).
  const failed = say(service, '第一条');
  await until(() => service.ledger.getMessage(failed).state === 'processed', '续接失败后新开的上下文处理了它');
  const message = say(service, '第二条');
  await until(() => service.ledger.getMessage(message).state === 'processed', '新会话回合结束');
  assert.notEqual(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')?.id, session.id);
  const turns = turnsSeen().slice(seen);
  const overview = turns.findIndex((text) => text.includes('从账本重建'));
  assert.ok(overview >= 0 && overview < turns.indexOf('第一条'), '§5.6 第 7 步：新上下文首条不是从账本重建的材料');
});

test('降级恢复：写入恢复后先清点，清点完才放开派发', options, async (t) => {
  const { remote, start, queued, launched, runsOf } = stage(t);
  let failing = false;
  const service = await start({
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  const { ledger } = service;
  const run = await launched(service, queued(service, '在跑的'));
  const waiting = queued(service, '排队的');
  const before = runsOf(service, waiting).length;
  await until(() => runsOf(service, waiting).length > before, '第二个任务派发');
  const waitingRun = runsOf(service, waiting).at(-1)!;
  await until(() => ledger.getRun(waitingRun.id).state === 'running', '第二个任务运行');
  const later = queued(service, '降级之后排的');
  // The queue is empty, so later waits only for the next tick, unless degraded got there first.
  failing = true;
  await until(() => ledger.dispatchConditions().degraded, '进入降级');
  const runsDuring = runsOf(service, later).length;
  remote.finish(run.id, { status: 'done', summary: '降级期间跑完', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });

  const release = remote.hold('state.sh');
  const startsBefore = remote.called('start.sh');
  const seen = remote.called('state.sh');
  failing = false;
  await until(() => remote.calls.filter(({ script }) => script === 'state.sh').length > seen || !ledger.dispatchConditions().degraded, '恢复开始');
  await until(() => !ledger.dispatchConditions().degraded, '解除降级');
  await sleep(200);
  assert.equal(remote.called('start.sh'), startsBefore, '§2：写入一恢复就放开了派发，没有先清点');
  assert.equal(runsOf(service, later).length, runsDuring);
  release();
  await until(() => ledger.getRun(run.id).state === 'ended', '清点结算了降级期间结束的 Run');
  assert.equal(ledger.getTask(run.task_id).state, 'ready');
  await until(() => runsOf(service, later).length > runsDuring, '清点完放开派发');
});

test('降级恢复：探测写入失败就保持降级，不放开派发', options, async (t) => {
  const { remote, start, queued, launched } = stage(t);
  let failing = false;
  const service = await start({
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  await launched(service, queued(service));
  failing = true;
  await until(() => service.ledger.dispatchConditions().degraded, '进入降级');
  const starts = remote.called('start.sh');
  await sleep(200);
  assert.equal(service.ledger.dispatchConditions().degraded, true);
  assert.equal(remote.called('start.sh'), starts);
  failing = false;
  await until(() => !service.ledger.dispatchConditions().degraded, '探测成功后解除');
});

test('降级恢复：降级时卡在 processing 的消息转待核实，后面的消息不被堵死', options, async (t) => {
  const { start, greet, say, turnsSeen } = stage(t);
  let failing = false;
  const service = await start({
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  const { ledger } = service;
  await greet(service);
  const stranded = say(service, '长回合');
  await until(() => turnsSeen().includes('长回合'), '回合开始');
  failing = true;
  service.session.interrupt();
  await until(() => ledger.dispatchConditions().degraded, '收尾写库失败进入降级');
  await until(() => service.session.status().turn === null, '回合结束');
  failing = false;
  await until(() => ledger.getMessage(stranded).state === 'unverified', '卡住的消息转待核实');
  const next = say(service, '下一条');
  await until(() => ledger.getMessage(next).state === 'processed', '下一条处理完');
});

async function degradable(t: TestContext) {
  const scene = stage(t);
  const control = { failing: false };
  const failure = {
    ledgerHooks: {
      beforeCommit() {
        if (control.failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  };
  const service = await scene.start(failure);
  // Any write notices; the round that would is sitting in the upload.
  const degrade = (): void => {
    control.failing = true;
    assert.throws(() => service.ledger.outbox.enqueue('console', 'markdown', {}));
  };
  return { ...scene, service, control, degrade };
}

test('恢复屏障：清点挂起时启动、消息、通知都不动，状态如实，清点完统一开放', options, async (t) => {
  const { remote, service, control, degrade, queued, launched, say, greet, runsOf } = await degradable(t);
  const { ledger } = service;
  const client = await signIn(service);
  await greet(service);
  const running = await launched(service, queued(service, '在跑的'));

  const upload = remote.hold('upload');
  const uploading = queued(service, '上传中的');
  await until(() => remote.called('upload') === 2, '第二个 Run 在上传');
  const run = runsOf(service, uploading)[0]!;
  const starts = remote.called('start.sh');
  degrade();
  const inventory = remote.hold('state.sh');
  const seen = remote.called('state.sh', running.id);
  control.failing = false;
  await until(() => ledger.dispatchConditions().recovering, '清点开始');
  await until(() => remote.called('state.sh', running.id) > seen, '清点挂在 SSH 上');

  assert.equal(ledger.dispatchConditions().degraded, false, '写入已恢复，这一段不是降级');
  const state = (await (await client.get('/api/state')).json()) as { dispatch: { canDispatch: boolean; recovering: boolean } };
  assert.deepEqual([state.dispatch.canDispatch, state.dispatch.recovering], [false, true], '§2：/api/state 不能在清点时说可以派发');
  const message = say(service, '清点时来的');
  const row = ledger.outbox.enqueue('console', 'markdown', { text: '清点时要发的' });
  upload();
  await sleep(150);
  assert.equal(remote.called('start.sh'), starts, '§2：上传返回后发出了启动');
  assert.equal(ledger.getMessage(message).state, 'received', '§2：清点时负责人消费了消息');
  assert.deepEqual(ledger.outbox.takeDue().map(({ id }) => id), [row.id], '§2：清点时 Outbox 发了');

  inventory();
  await until(() => !ledger.dispatchConditions().recovering, '清点结束');
  await until(() => ledger.getMessage(message).state === 'processed', '清点完处理消息');
  await until(() => ledger.outbox.takeDue().length === 0, '清点完发通知');
  await until(() => ledger.getRun(run.id).state === 'unknown', '没发启动的 Run 只能经核实');
  assert.equal(remote.called('start.sh'), starts, '底线“未知执行者阻止重派”：之后也不能补发启动');
  assert.equal(ledger.dispatchConditions().canDispatch, true);
});

test('恢复屏障：降级恢复的清点没做完就保持，失败了重试', options, async (t) => {
  const { remote, service, control, degrade, queued, launched } = await degradable(t);
  await launched(service, queued(service));
  degrade();
  remote.reachable = true;
  // The inventory's look at the Run, held on the machine. The watcher polls the same script
  // every 20ms, so a call to it is no proof that the inventory is the one looking: the
  // barrier is what says the inventory has begun, and it is the barrier being asserted.
  const inventory = remote.hold('state.sh');
  const seen = remote.called('state.sh');
  control.failing = false;
  await until(() => service.ledger.dispatchConditions().recovering && remote.called('state.sh') > seen, '清点挂在核实上');
  assert.equal(service.ledger.dispatchConditions().canDispatch, false);
  assert.equal(service.ledger.dispatchConditions().recovering, true);
  inventory();
  await until(() => service.ledger.dispatchConditions().canDispatch, '清点完放开');
});

// What a recovery task does after the stop shows only in its log, once the ledger is shut.
const logged = (t: TestContext): string[] => {
  const lines: string[] = [];
  const real = console.error;
  t.mock.method(console, 'error', (...args: unknown[]) => {
    lines.push(args.join(' '));
    real(...args);
  });
  return lines;
};

test('停服：清点挂起超过上限时照常收尾，恢复任务不再做后面的事', options, async (t) => {
  const { remote, dataDir, start, queued, launched, stop } = stage(t);
  const logs = logged(t);
  let failing = false;
  const service = await start({
    stopWaitMs: 150,
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  await launched(service, queued(service, '第一个'));
  await launched(service, queued(service, '第二个'));
  failing = true;
  assert.throws(() => service.ledger.outbox.enqueue('console', 'markdown', {}));
  const inventory = remote.hold('state.sh');
  const seen = remote.called('state.sh');
  failing = false;
  await until(() => service.ledger.dispatchConditions().recovering && remote.called('state.sh') > seen, '清点挂在 SSH 上');

  await stop(service);
  assert.equal(existsSync(join(dataDir, 'lock')), false, '上限到了照常收尾');
  const reads = remote.called('state.sh');
  inventory();
  await sleep(150);
  assert.equal(remote.called('state.sh'), reads, '停服之后恢复任务还在核实下一个 Run');
  assert.equal(service.ledger.dispatchConditions().recovering, true, '没做完的清点不能算做完');
  assert.deepEqual(logs.filter((line) => line.includes('降级恢复失败')), [], '停服之后恢复任务还在碰账本');

  const again = await start();
  assert.equal(again.ledger.dispatchConditions().recovering, false);
});

test('停服：恢复任务在上限内时等它做完才关账本', options, async (t) => {
  const { remote, dataDir, start, queued, launched } = stage(t);
  let failing = false;
  const service = await start({
    stopWaitMs: 10_000,
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  await launched(service, queued(service));
  failing = true;
  assert.throws(() => service.ledger.outbox.enqueue('console', 'markdown', {}));
  // The inventory's look at the Run, held on the machine.
  const inventory = remote.hold('state.sh');
  const seen = remote.called('state.sh');
  failing = false;
  await until(() => remote.called('state.sh') > seen, '清点挂在核实上');
  let finished = false;
  const stopping = service.stop().then(() => { finished = true; });
  await sleep(2000);
  assert.equal(finished, false, '清点还在跑就收尾了');
  assert.equal(existsSync(join(dataDir, 'lock')), true);
  assert.equal(service.ledger.dispatchConditions().paused, false, '账本要开到恢复任务结束');
  inventory();
  await stopping;
});

test('停服：负责人没起来时停服，启动不再装后台任务，也不算启动失败', options, async (t) => {
  const { dataDir, remote, start, queued, routerStarts, stop } = stage(t);
  // Past its first round nothing dispatches, so a start that got that far would show.
  const first = await start({ dispatchIntervalMs: 60_000 });
  queued(first, '排队的');
  await stop(first);

  // session.start() asks the CLI whether it is signed in, to say now what would stop a start;
  // that question is the one that waits.
  const started = routerStarts();
  const starts = remote.called('start.sh');
  const logs = logged(t);
  process.env.FAKE_CLAUDE_AUTH = 'hang';
  const asked = (): boolean => existsSync(join(dataDir, 'fake.log')) && readFileSync(join(dataDir, 'fake.log'), 'utf8').includes('"auth":"hang"');
  const starting = start();
  await until(() => existsSync(serviceFile(dataDir)) && asked(), '启动时去问登录状态');
  const { port, token } = JSON.parse(readFileSync(serviceFile(dataDir), 'utf8')) as { port: number; token: string };
  const answer = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(answer.status, 202);
  const service = await starting;
  assert.equal(await service.stopped, true);
  await sleep(100);
  assert.equal(routerStarts(), started, '§11：停服之后还启动了负责人');
  assert.deepEqual(logs.filter((line) => line.includes('服务已启动')), [], '停服之后启动还在往下走');
  assert.equal(remote.called('start.sh'), starts, '停服之后还开始派发');
  assert.equal(existsSync(join(dataDir, 'lock')), false);
  assert.equal(existsSync(serviceFile(dataDir)), false);
});

// docs/design/triggers.md §5: a trigger due while the service was down is taken up once at the
// start, by its policy, before anything else moves; a running service's due scan hands the next
// one to the project's Router; and a further restart delivers neither again.
test('触发器：停机期间到点的启动时受理一次，运行中的到点由到期扫描交给负责人，重启不重投', options, async (t) => {
  const { start, stop } = stage(t);
  const first = await start({ dispatchIntervalMs: 60_000 });
  const project = pageProject(first);
  const now = new Date();
  const down = first.ledger.createTrigger(project, { name: '停机时到点', instruction: '看一眼', schedule: { kind: 'once', at: new Date(now.getTime() + 200).toISOString() } }, USER, now);
  await stop(first);
  await sleep(400);

  const second = await start({ dispatchIntervalMs: 60_000, dueIntervalMs: 50 });
  const firesOf = (service: typeof second, id: string) => service.ledger.listTriggerFires({ triggerId: id, limit: 10 });
  assert.deepEqual(firesOf(second, down.id).map(({ outcome }) => outcome), ['delivered'], '启动时就受理了');
  const message = firesOf(second, down.id)[0]!.message_id!;
  await until(() => second.ledger.getMessage(message).state === 'processed', '负责人处理了停机时到点的那条');
  const later = new Date();
  const running = second.ledger.createTrigger(project, { name: '运行中到点', instruction: '再看一眼', schedule: { kind: 'once', at: new Date(later.getTime() + 300).toISOString() } }, USER, later);
  const next = await until(() => firesOf(second, running.id)[0]?.message_id, '运行中到点');
  await until(() => second.ledger.getMessage(next).state === 'processed', '负责人处理了运行中到点的那条');
  await stop(second);

  const third = await start({ dispatchIntervalMs: 60_000, dueIntervalMs: 50 });
  await sleep(300);
  assert.equal(firesOf(third, down.id).length, 1, '重启不重投');
  assert.equal(firesOf(third, running.id).length, 1, '重启不重投');
});
