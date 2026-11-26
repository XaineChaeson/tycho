// Guards against §11 group 5: a pause lost across a restart, a pause not holding against
// the next dispatch, and a Run that was already past the check going unlisted, so the
// owner thinks nothing can start while something still can. End to end: real ledger, fake
// CLI, fake instance, HTTP; a crash on each side of the commit.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { Service } from './stage.ts';
import type { FakeRemote } from './fake-remote.ts';
import { signIn, stage, until } from './stage.ts';

const options = { timeout: 90_000 };
const SENTENCE = '暂停跨重启保留；已取得资格的 Run 明确列出';

type Launching = { id: string; task_title: string; unconfirmed: boolean };

const stateOf = async (service: Service): Promise<{ dispatch: { paused: boolean }; launching_runs: Launching[] }> =>
  (await (await signIn(service)).get('/api/state')).json() as never;

async function listTasks(service: Service, s: ReturnType<typeof stage>): Promise<string> {
  // A turn is what admits a tool call.
  const message = s.say(service, '长回合', `长回合-${Date.now()}`);
  await until(() => service.session.status().turn === message, '回合开始');
  await until(() => !('refused' in probe(service)), '工具可用');
  const response = await fetch(`http://127.0.0.1:${service.port}/tools/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${service.session.toolTokens()[0]}` },
    body: JSON.stringify({ name: 'list_tasks', arguments: {} }),
  });
  const { content } = (await response.json()) as { content: { text: string }[] };
  service.session.interrupt();
  return content[0]!.text;
}

function probe(service: Service) {
  const admission = service.session.admitTool(service.session.toolTokens()[0]);
  if ('done' in admission) admission.done();
  return admission;
}

test(`${SENTENCE}（暂停提交前崩溃）`, options, async (t) => {
  const { start, crashAt, wreck, queued, runsOf } = stage(t);
  const first = await start({ dispatchIntervalMs: 60_000 });
  const task = queued(first);
  const client = await signIn(first);
  const crashed = crashAt('pause.set', 'before');
  assert.equal((await client.post('/api/pause', { paused: true })).status, 503, '没落库的暂停不能回答成功');
  await crashed;
  await wreck(first);

  const service = await start();
  assert.equal((await stateOf(service)).dispatch.paused, false);
  await until(() => runsOf(service, task).length === 1, '没生效的暂停不挡派发');
});

test(`${SENTENCE}（暂停提交后崩溃）`, options, async (t) => {
  const s = stage(t);
  const first = await s.start({ dispatchIntervalMs: 60_000 });
  await s.greet(first);
  const task = s.queued(first);
  const client = await signIn(first);
  const crashed = s.crashAt('pause.set', 'after');
  await client.post('/api/pause', { paused: true });
  await crashed;
  await s.wreck(first);

  const service = await s.start();
  assert.equal((await stateOf(service)).dispatch.paused, true, '§11 第五组：暂停没有跨重启保留');
  await sleep(150);
  assert.equal(s.runsOf(service, task).length, 0, '§5：暂停期间授予了新的启动资格');
  assert.match(await listTasks(service, s), /^派发已暂停\n\{/, 'list_tasks 要告诉负责人派发已暂停');

  await (await signIn(service)).post('/api/pause', { paused: false });
  await until(() => s.runsOf(service, task).length === 1, '恢复后派发');
});

test(`${SENTENCE}（暂停与启动竞争）`, options, async (t) => {
  const { remote, start, queued, runsOf } = stage(t);
  const service = await start();
  const client = await signIn(service);
  const release = remote.hold('start.sh');
  const raced = queued(service, '抢先的');
  await until(() => remote.called('start.sh') === 1, '启动在路上');
  const blocked = queued(service, '被挡住的');
  assert.equal((await client.post('/api/pause', { paused: true })).status, 200);

  const run = runsOf(service, raced)[0]!;
  const state = await stateOf(service);
  assert.deepEqual(state.launching_runs.map(({ id, task_title }) => [id, task_title]), [[run.id, '抢先的']], '§5：已取得资格的 Run 没有列出');
  const overview = (await (await client.get('/api/overview')).json()) as { state: { launching_runs: Launching[] } };
  assert.deepEqual(overview.state.launching_runs.map(({ id }) => id), [run.id], '总览看不到已取得资格的 Run');

  release();
  await until(() => service.ledger.getRun(run.id).state === 'running', '已取得资格的 Run 随后启动');
  assert.deepEqual((await stateOf(service)).launching_runs, []);
  await sleep(100);
  assert.equal(runsOf(service, blocked).length, 0, '§5：暂停之后又派发了');
});

test(`${SENTENCE}（启动竞争中崩溃，重启后仍然列出）`, options, async (t) => {
  const { remote, start, wreck, queued, runsOf } = stage(t);
  const first = await start();
  const client = await signIn(first);
  const release = remote.hold('start.sh');
  const task = queued(first, '抢先的');
  await until(() => remote.called('start.sh') === 1, '启动在路上');
  assert.equal((await client.post('/api/pause', { paused: true })).status, 200);
  const run = runsOf(first, task)[0]!;
  await wreck(first);
  release();
  // The launcher is up and has not reported a pid: §4's "starting, wait".
  Object.assign(remote.runOf(run.id), { started: true, launcher_alive: true, pid_alive: false, marked: false });

  const service = await start();
  const state = await stateOf(service);
  assert.equal(state.dispatch.paused, true);
  assert.deepEqual(state.launching_runs.map(({ id }) => id), [run.id], '§11 第五组：重启后已取得资格的 Run 不再列出');
});

for (const [name, lose] of [
  ['实例上没有 started/', () => {}],
  ['主机不可达', (remote: FakeRemote) => { remote.reachable = false; }],
] as const) {
  test(`${SENTENCE}（启动确认丢失，重启时${name}，仍然列出且标明未确认）`, options, async (t) => {
    const { remote, start, wreck, queued, runsOf } = stage(t);
    const first = await start();
    const client = await signIn(first);
    const release = remote.hold('start.sh');
    const task = queued(first, '抢先的');
    await until(() => remote.called('start.sh') === 1, '启动在路上');
    assert.equal((await client.post('/api/pause', { paused: true })).status, 200);
    const run = runsOf(first, task)[0]!;
    await wreck(first);
    lose(remote);
    const service = await start();
    assert.equal(service.ledger.getRun(run.id).state, 'unknown', '这一组要的是启动未确认转成 unknown');
    const state = await stateOf(service);
    assert.deepEqual(state.launching_runs.map(({ id, unconfirmed }) => [id, unconfirmed]), [[run.id, true]], '§11 第五组：启动未确认的 Run 从暂停提示里消失了');
    const overview = (await (await (await signIn(service)).get('/api/overview')).json()) as { launching: { id: string; unconfirmed: boolean }[] };
    assert.deepEqual(overview.launching.map(({ id, unconfirmed }) => [id, unconfirmed]), [[run.id, true]]);
    release();
  });
}
