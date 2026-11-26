// Guards against the local interface letting in what it should not (a wrong token, a
// foreign web page, tools outside a turn, a machine-local route reached from elsewhere,
// a write in degraded mode), a message acknowledged before it is durable, a tool call
// charged to whichever message runs when its body arrives, a banner the page cannot
// reach, a slow reader growing the process, and the stream leaking a shutdown.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { consoleApp, LOGIN_TOKEN, SHUTDOWN_TOKEN, TOOL_TOKEN } from './console-helpers.ts';
import { fixture, USER } from './helpers.ts';
import type { ToolResult } from '../service/tool-schema.ts';
import type { traceRun } from '../service/trace.ts';
import { snapshotSourceOf } from '../shared/sources.ts';

async function setup(t: TestContext) {
  const app = await consoleApp(t);
  return { ...app, bearer: { Authorization: `Bearer ${TOOL_TOKEN}` } };
}

async function openStream(url: string, cookie: string) {
  const abort = new AbortController();
  const response = await fetch(`${url}/api/stream`, { signal: abort.signal, headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    close: () => abort.abort(),
    async until(pattern: RegExp): Promise<string> {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`流已结束：${text}`);
        text += decoder.decode(value, { stream: true });
      }
      return text;
    },
  };
}

test('the tool routes refuse a missing or wrong token', async (t) => {
  const { post } = await setup(t);
  for (const headers of [{}, { Authorization: 'Bearer wrong' }] as Record<string, string>[]) {
    assert.equal((await post('/tools/list', {}, headers)).status, 401);
    assert.equal((await post('/tools/call', { name: 'list_tasks' }, headers)).status, 401);
  }
});

test('tools/list answers with the schemas', async (t) => {
  const { post, bearer } = await setup(t);
  const { tools } = (await (await post('/tools/list', {}, bearer)).json()) as { tools: { name: string }[] };
  assert.ok(tools.some(({ name }) => name === 'create_task'));
});

test("a tool call acts on behalf of the Session Host's current message", async (t) => {
  const { f, post, bearer, state } = await setup(t);
  const { id } = f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'console', text: '建项目' });
  state.current = id;
  const response = await post(
    '/tools/call',
    { name: 'create_task', arguments: { title: '新', goal: '目标', acceptance: '验收', role_id: 'implement' } },
    bearer,
  );
  assert.equal(((await response.json()) as { isError?: boolean }).isError, undefined);
  const changes = f.ledger.listChanges({ messageId: id });
  assert.deepEqual([changes[0]?.action, changes[0]?.actor], ['task.create', 'router']);
});

test('a committed task has one tool cause and a repeated operation returns its original result across turns', async (t) => {
  const { f, post, get, bearer, state } = await setup(t);
  const first = f.ledger.receiveMessage({ channel: 'console', externalId: 'trace-a', actor: 'console', text: '验证缓存', projectId: f.projectId });
  state.current = first.id;
  const source = { kind: 'repo', url: 'https://example.test/ql.git' };
  f.ledger.setProjectSources(f.projectId, [source], USER);
  const [origin] = f.ledger.projectSources(f.projectId);
  const args = { title: '缓存验证', goal: '核对结果 Authorization: Bearer canary-do-not-store', acceptance: '交报告', role_id: 'verify', source: origin!.id, operation_key: 'ql-cache-check' };
  const created = await (await post('/tools/call', { name: 'create_task', arguments: args }, bearer)).json() as ToolResult;
  assert.equal(created.isError, undefined);
  const committed = f.ledger.listChanges({ messageId: first.id });
  assert.deepEqual(committed.map(({ action }) => action), ['task.create', 'task.queue']);
  const taskId = committed[0]!.task_id!;
  assert.ok(committed[0]!.tool_call_id);
  assert.equal(committed[0]!.tool_call_id, committed[1]!.tool_call_id);

  const next = f.ledger.receiveMessage({ channel: 'console', externalId: 'trace-b', actor: 'user', text: '检查上一条', projectId: f.projectId });
  state.current = next.id;
  const { operation_key, ...rest } = args;
  const retried = await (await post('/tools/call', { name: 'create_task', arguments: { operation_key, ...rest } }, bearer)).json() as ToolResult;
  assert.deepEqual(retried.content, created.content);
  const conflict = await (await post('/tools/call', { name: 'create_task', arguments: { ...args, title: '另一件事' } }, bearer)).json() as ToolResult;
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0]!.text, /操作编号.*不同/);
  assert.equal(f.ledger.listTasks({ projectId: f.projectId }).length, 1);

  const run = f.ledger.createRun(taskId, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'operate', source: snapshotSourceOf(origin!) } }, USER);
  const tracePath = '/api/runs/' + run.id + '/trace';
  const trace = await (await get(tracePath)).json() as ReturnType<typeof traceRun>;
  assert.ok(trace.trigger.tool_call);
  assert.equal(trace.trigger.tool_call.name, 'create_task');
  assert.equal(trace.trigger.tool_call.id, committed[0]!.tool_call_id);
  assert.deepEqual(trace.trigger.tool_call.committed.map(({ action }: { action: string }) => action), ['task.create', 'task.queue']);
  assert.equal(trace.trigger.tool_call.result_state, 'returned');
  assert.deepEqual(trace.trigger.tool_call.message_ids, [first.id]);
  assert.match(trace.trigger.tool_call.request ?? '', /已隐去/);
  assert.doesNotMatch(JSON.stringify(trace.trigger.tool_call), /canary-do-not-store/);
  assert.equal((await get(tracePath, bearer)).status, 401, 'router token cannot read the owner trace');
  const turnPath = '/api/messages/' + first.id + '/trajectory';
  assert.equal((await get(turnPath, bearer)).status, 401);
  const turn = await (await get(turnPath)).json() as { calls: { id: string }[] };
  assert.deepEqual(turn.calls.map(({ id }) => id), [committed[0]!.tool_call_id]);
  assert.equal((await get(turnPath + '?after=arbitrary')).status, 400);
  const reopened = f.open();
  assert.equal(reopened.routerCall(f.projectId, committed[0]!.tool_call_id!)?.id, committed[0]!.tool_call_id);
  f.ledger.setProjectSources(f.projectId, [{ kind: 'repo', url: 'https://example.test/other.git' }], USER);
  const afterEdit = await (await post('/tools/call', { name: 'create_task', arguments: args }, bearer)).json() as ToolResult;
  assert.deepEqual(afterEdit.content, created.content);
  assert.equal(f.ledger.listTasks({ projectId: f.projectId }).length, 1);
});

test('task creation is still traceable when the connection goes away after commit', async (t) => {
  let loseReply: (() => void) | undefined;
  const f = fixture(t, { testHooks: { afterCommit: (actions) => {
    if (actions.includes('task.create')) loseReply?.();
  } } });
  const app = await consoleApp(t, { f });
  const request = f.ledger.receiveMessage({ channel: 'console', externalId: 'trace-cut', actor: 'user', text: '开始', projectId: f.projectId });
  app.state.current = request.id;
  const controller = new AbortController();
  loseReply = () => controller.abort();
  const args = { title: '只建一次', goal: '核对', acceptance: '报告', role_id: 'verify', operation_key: 'ql-lost-reply' };
  const headers = { Authorization: 'Bearer ' + TOOL_TOKEN };
  await assert.rejects(fetch(app.url + '/tools/call', {
    method: 'POST', headers, signal: controller.signal,
    body: JSON.stringify({ name: 'create_task', arguments: args }),
  }), { name: 'AbortError' });
  const [task] = f.ledger.listTasks({ projectId: f.projectId });
  assert.ok(task);
  const change = f.ledger.listChanges({ taskId: task.id }).find(({ action }) => action === 'task.create')!;
  assert.ok(change.tool_call_id);
  const reopened = f.open();
  const call = reopened.routerCall(f.projectId, change.tool_call_id);
  assert.equal(call?.committed[0]?.task_id, task.id);
  assert.equal(call?.receipt_confirmed, false);
  assert.equal(reopened.routerCall('another-project', change.tool_call_id), undefined);
  loseReply = undefined;
  const retry = await (await app.post('/tools/call', { name: 'create_task', arguments: args }, headers)).json() as ToolResult;
  assert.match(retry.content[0]!.text, new RegExp(task.id));
  assert.equal(f.ledger.listTasks({ projectId: f.projectId }).length, 1);
});

test('a connection lost before commit leaves only a diagnostic and can retry the same operation', async (t) => {
  let cut: (() => void) | undefined;
  const f = fixture(t, { testHooks: { beforeCommit: (actions) => {
    if (!actions.includes('task.create') || cut === undefined) return;
    cut();
    throw new Error('injected failure before task transaction commit');
  } } });
  const app = await consoleApp(t, { f });
  const request = f.ledger.receiveMessage({ channel: 'console', externalId: 'trace-cut-before', actor: 'user', text: '开始', projectId: f.projectId });
  app.state.current = request.id;
  const controller = new AbortController();
  cut = () => controller.abort();
  const args = { title: '只建一次', goal: '核对', acceptance: '报告', role_id: 'verify', operation_key: 'ql-lost-before-commit' };
  const headers = { Authorization: 'Bearer ' + TOOL_TOKEN };
  await assert.rejects(fetch(app.url + '/tools/call', {
    method: 'POST', headers, signal: controller.signal,
    body: JSON.stringify({ name: 'create_task', arguments: args }),
  }), { name: 'AbortError' });
  const recovered = f.open();
  assert.equal(recovered.listTasks({ projectId: f.projectId }).length, 0);
  const original = recovered.routerTurnTrace(f.projectId, request.id, null).calls;
  assert.equal(original.length, 1);
  assert.deepEqual(original[0]!.committed, []);
  assert.equal(original[0]!.receipt_confirmed, false);
  cut = undefined;
  const retry = await (await app.post('/tools/call', { name: 'create_task', arguments: args }, headers)).json() as ToolResult;
  assert.equal(retry.isError, undefined);
  assert.equal(f.ledger.listTasks({ projectId: f.projectId }).length, 1);
});

test('a trajectory cursor can continue its own turn but cannot be used with another project', async (t) => {
  const { f, get } = await setup(t);
  const other = f.ledger.createProject({ name: '另一项目', loginMode: 'all' }, USER);
  const receive = (projectId: string, externalId: string) => f.ledger.receiveMessage({
    channel: 'console', externalId, actor: 'console', text: '查询状态', projectId,
  }).id;
  const first = receive(f.projectId, 'trajectory-page');
  const foreign = receive(other, 'different-project');
  for (let i = 0; i < 21; i++) {
    f.ledger.startRouterCall({ id: String(i + 1).padStart(26, '0'), projectId: f.projectId, messageId: first, messageIds: [first], contextId: null, name: 'list_tasks', request: '{}' });
  }
  const forMessage = (id: string) => '/api/messages/' + id + '/trajectory';
  const initial = await (await get(forMessage(first))).json() as ReturnType<typeof f.ledger.routerTurnTrace>;
  assert.equal(initial.calls.length, 20);
  assert.ok(initial.next_call);
  const next = '?after=' + initial.next_call;
  const second = await (await get(forMessage(first) + next)).json() as typeof initial;
  assert.equal(second.calls.length, 1);
  assert.equal(second.next_call, null);
  assert.equal((await get(forMessage(foreign) + next)).status, 400);
});

test('outside a turn a tool call does nothing', async (t) => {
  const { f, post, bearer } = await setup(t);
  const before = f.ledger.listTasks().length;
  const response = await post(
    '/tools/call',
    { name: 'create_task', arguments: { title: '新', goal: '目标', acceptance: '验收', role_id: 'implement' } },
    bearer,
  );
  assert.equal(((await response.json()) as { isError?: boolean }).isError, true);
  assert.equal(f.ledger.listTasks().length, before);
});

test('a refusal from the Session Host reaches the proxy as its own words, with no effect', async (t) => {
  const { f, post, bearer, state } = await setup(t);
  state.refused = '回合已中断，工具不执行';
  const before = f.ledger.listTasks().length;
  const response = await post('/tools/call', { name: 'create_task', arguments: { title: '新', goal: '目标', acceptance: '验收', role_id: 'implement' } }, bearer);
  const body = (await response.json()) as { isError?: boolean; content: { text: string }[] };
  assert.equal(body.isError, true);
  assert.equal(body.content[0]?.text, '回合已中断，工具不执行');
  assert.equal(f.ledger.listTasks().length, before);
});

test('a tool call belongs to the message current when it arrived, however late its body is', async (t) => {
  const { f, port, state } = await setup(t);
  const first = f.ledger.receiveMessage({ channel: 'console', externalId: 'a', actor: 'console', text: '一' }).id;
  const second = f.ledger.receiveMessage({ channel: 'console', externalId: 'b', actor: 'console', text: '二' }).id;
  state.current = first;
  const call = httpRequest({
    port,
    method: 'POST',
    path: '/tools/call',
    headers: { Authorization: `Bearer ${TOOL_TOKEN}`, 'Transfer-Encoding': 'chunked' },
  });
  call.flushHeaders();
  while (state.calls === 0) await sleep(5);
  state.current = second;
  call.end(JSON.stringify({ name: 'create_task', arguments: { title: '迟到', goal: '目标', acceptance: '验收', role_id: 'implement' } }));
  const [response] = (await once(call, 'response')) as [NodeJS.ReadableStream];
  response.resume();
  await once(response, 'end');
  assert.deepEqual(f.ledger.listChanges({ messageId: first }).map(({ action }) => action), ['task.create', 'task.queue']);
  assert.deepEqual(f.ledger.listChanges({ messageId: second }), []);
  assert.equal(state.calls, 0);
});

// Review of step 1: the barrier is asked again once the body is in, right before the call acts.
// A call admitted while all was well does nothing once the service went degraded meanwhile.
test('a call admitted before the service went degraded does nothing once its body arrives', async (t) => {
  const { f, port, state } = await setup(t);
  state.current = f.ledger.receiveMessage({ channel: 'console', externalId: 'a', actor: 'console', text: '一', projectId: f.projectId }).id;
  const call = httpRequest({ port, method: 'POST', path: '/tools/call', headers: { Authorization: `Bearer ${TOOL_TOKEN}`, 'Transfer-Encoding': 'chunked' } });
  call.flushHeaders();
  while (state.calls === 0) await sleep(5);
  state.refusedLater = '账本写不进去，服务处于降级模式，工具不执行';
  const tasks = f.ledger.listTasks().length;
  call.end(JSON.stringify({ name: 'create_task', arguments: { title: '降级时', goal: '目标', acceptance: '验收', role_id: 'implement' } }));
  const [response] = (await once(call, 'response')) as [NodeJS.ReadableStream & { setEncoding(e: string): void }];
  response.setEncoding('utf8');
  let body = '';
  response.on('data', (chunk: string) => { body += chunk; });
  await once(response, 'end');
  const answer = JSON.parse(body) as { isError?: boolean; content: { text: string }[] };
  assert.deepEqual([answer.isError, answer.content[0]?.text], [true, '账本写不进去，服务处于降级模式，工具不执行']);
  assert.equal(f.ledger.listTasks().length, tasks);
  assert.equal(state.calls, 0, '照样算收尾了');
});

test('an admitted call that fails on its body still counts as finished', async (t) => {
  const { f, post, bearer, state } = await setup(t);
  state.current = f.ledger.receiveMessage({ channel: 'console', externalId: 'a', actor: 'console', text: '一' }).id;
  assert.equal((await post('/tools/call', 'not an object', bearer)).status, 400);
  assert.equal(state.calls, 0);
});

test('with no process there is no valid tool token', async (t) => {
  const { url } = await consoleApp(t, { toolToken: undefined });
  const response = await fetch(`${url}/tools/list`, { method: 'POST', headers: { Authorization: 'Bearer undefined' }, body: '{}' });
  assert.equal(response.status, 401);
});

test('/api/shutdown takes only its own token and answers before it stops anything', async (t) => {
  const { post, state, bearer, browser } = await setup(t);
  assert.equal((await post('/api/shutdown', {}, {})).status, 401);
  assert.equal((await post('/api/shutdown', {}, bearer)).status, 401);
  assert.equal((await post('/api/shutdown', {}, browser)).status, 401);
  assert.equal(state.shutdowns, 0);
  assert.equal((await post('/api/shutdown', {}, { Authorization: `Bearer ${SHUTDOWN_TOKEN}` })).status, 202);
  assert.equal(state.shutdowns, 1);
});

test('machine-local routes refuse any peer that is not this machine, whatever token it has', async (t) => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((each) => each?.family === 'IPv4' && !each.internal)?.address;
  if (!address) {
    t.skip('这台机器没有非回环网卡');
    return;
  }
  const { port, get } = await consoleApp(t, { host: '0.0.0.0' });
  // This fixture tests the peer address, so an inherited proxy must not choose the route.
  const from = (path: string, token: string) => new Promise<{
    status: number | undefined; peerAddress: string | undefined; peerPort: number | undefined;
  }>((resolve, reject) => {
    const call = httpRequest({ hostname: address, port, path, method: 'POST', agent: false,
      headers: { Authorization: `Bearer ${token}` } }, (response) => {
      const result = { status: response.statusCode, peerAddress: response.socket.remoteAddress, peerPort: response.socket.remotePort };
      response.resume();
      resolve(result);
    });
    call.on('error', reject);
    call.end('{}');
  });
  t.diagnostic(`direct non-loopback target: ${address}:${port}`);
  for (const [path, token] of [
    ['/tools/list', TOOL_TOKEN], ['/tools/call', TOOL_TOKEN],
    ['/api/login-links', LOGIN_TOKEN], ['/api/shutdown', SHUTDOWN_TOKEN],
  ]) {
    const response = await from(path!, token!);
    assert.equal(response.peerAddress, address, 'request must reach the selected non-loopback interface directly');
    assert.equal(response.peerPort, port, 'request must reach this fixture server');
    assert.equal(response.status, 403);
  }
  // Same server, same bind: the loopback is what made the difference.
  assert.equal((await get('/api/state')).status, 200);
});

test('POST /api/messages stores the message as console and wakes the Session Host', async (t) => {
  const { f, post, state } = await setup(t);
  const response = await post('/api/messages', { text: '你好', project_id: f.projectId });
  assert.equal(response.status, 201);
  const { id, state: messageState } = (await response.json()) as { id: string; state: string };
  assert.equal(messageState, 'received');
  const row = f.ledger.getMessage(id);
  assert.deepEqual([row.channel, row.actor, row.text], ['console', 'console', '你好']);
  assert.equal(state.kicks, 1);
});

test('POST /api/messages refuses bad input and a foreign origin, and takes its own', async (t) => {
  const { f, post, browser } = await setup(t);
  const before = f.count('message');
  assert.equal((await post('/api/messages', { text: '  ' })).status, 400);
  assert.equal((await post('/api/messages', 'not an object')).status, 400);
  assert.equal((await post('/api/messages', { text: 'x' }, { ...browser, Origin: 'http://evil.example' })).status, 403);
  assert.equal(f.count('message'), before);
  assert.equal((await post('/api/messages', { text: 'x' })).status, 201);
});

test('a message that cannot be stored is not acknowledged', async (t) => {
  const { f, post, state } = await setup(t);
  f.ledger.close();
  const response = await post('/api/messages', { text: '你好' });
  assert.ok(response.status >= 500, `状态 ${response.status}`);
  assert.equal(state.kicks, 0);
  // The fixture closes it again on the way out.
});

test('GET /api/messages pages the snapshot', async (t) => {
  const { get, post } = await setup(t);
  const first = (await (await post('/api/messages', { text: '一' })).json()) as { id: string };
  await post('/api/messages', { text: '二' });
  const page = (await (await get(`/api/messages?after=${first.id}&limit=5`)).json()) as {
    messages: { text: string }[];
  };
  assert.deepEqual(page.messages.map(({ text }) => text), ['二']);
  assert.equal((await get('/api/messages?limit=abc')).status, 400);
});

test('GET /api/state reports dispatch, the Router and active Runs', async (t) => {
  const { f, get } = await setup(t);
  f.runningRun();
  const state = (await (await get('/api/state')).json()) as any;
  assert.deepEqual(state.dispatch, { paused: false, degraded: false, recovering: false, canDispatch: true });
  assert.equal(state.router.alive, true);
  assert.deepEqual(state.router.turns, []);
  assert.equal(state.active_runs, 1);
});

test('with the ledger connection retired, a signed-in page can still learn that and write nothing', async (t) => {
  let failRollback = false;
  const f = fixture(t, {
    testHooks: {
      beforeRollback() {
        if (failRollback) throw new Error('rollback boom');
      },
    },
  });
  const { get, post, cookie, url } = await consoleApp(t, { f });
  const task = f.newTask();
  failRollback = true;
  assert.throws(() => f.ledger.queueTask(task.id, { actor: 'user', messageId: 'no-such-message' }));
  failRollback = false;

  const response = await get('/api/state');
  assert.equal(response.status, 200);
  const state = (await response.json()) as any;
  assert.deepEqual(state.dispatch, { paused: null, degraded: true, recovering: false, canDispatch: false });
  assert.deepEqual(state.router.turns, []);
  assert.equal(state.active_runs, null);
  assert.equal((await get('/')).status, 200);

  assert.equal((await post('/api/messages', { text: '写不进去' })).status, 503);
  assert.equal((await post('/api/logout')).status, 503);
  assert.equal((await get('/api/messages')).status, 503);

  assert.equal((await fetch(`${url}/api/state`)).status, 401);
  assert.equal((await fetch(`${url}/api/state`, { headers: { Cookie: 'tycho=stranger' } })).status, 401);
  assert.equal((await get('/api/state', { Cookie: cookie })).status, 200);
});

test('a session signed out before the connection was retired stays signed out', async (t) => {
  let failRollback = false;
  const f = fixture(t, {
    testHooks: {
      beforeRollback() {
        if (failRollback) throw new Error('rollback boom');
      },
    },
  });
  const { get, post, browser, cookie } = await consoleApp(t, { f });
  await post('/api/logout');
  const task = f.newTask();
  failRollback = true;
  assert.throws(() => f.ledger.queueTask(task.id, { actor: 'user', messageId: 'no-such-message' }));
  failRollback = false;
  assert.equal((await get('/api/state', browser)).status, 401);
  assert.ok(cookie);
});

test('a reader that stops reading is cut off and the others keep getting events', async (t) => {
  const { url, cookie, stream, port } = await setup(t);
  const healthy = await openStream(url, cookie);
  t.after(healthy.close);
  while (stream.size === 0) await sleep(5);
  const slow = connect(port, '127.0.0.1');
  t.after(() => slow.destroy());
  slow.write(`GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\n\r\n`);
  while (stream.size < 2) await sleep(5);
  // From here on nothing reads this socket, so the kernel buffers fill and then Node's.
  slow.pause();
  const closed = once(slow, 'close');
  slow.on('error', () => {});
  const frame = 'x'.repeat(256 * 1024);
  let sent = 0;
  while (stream.size === 2) {
    assert.ok(sent < 2000, '慢连接没有被断开');
    stream.publish('delta', { message_id: `m${sent}`, text: frame });
    sent += 1;
    await healthy.until(new RegExp(`"m${sent - 1}"`));
  }
  assert.equal(stream.size, 1);
  stream.publish('delta', { message_id: 'after', text: '还在' });
  await healthy.until(/"after"/);
  slow.resume();
  await closed;
});

test('the stream carries delta and message events as they are published', async (t) => {
  const { url, cookie, stream, post } = await setup(t);
  const client = await openStream(url, cookie);
  t.after(client.close);
  while (stream.size === 0) await sleep(5);
  stream.publish('delta', { message_id: 'm1', text: '流式文本' });
  const text = await client.until(/流式文本/);
  assert.match(text, /event: delta\ndata: \{"message_id":"m1","text":"流式文本"\}\n\n/);
  await post('/api/messages', { text: '新消息' });
  assert.match(await client.until(/event: message/), /"text":"新消息"/);
});

test('the stream reports a task state change', async (t) => {
  const { f, url, cookie, stream } = await setup(t);
  const task = f.newTask();
  const client = await openStream(url, cookie);
  t.after(client.close);
  while (stream.size === 0) await sleep(5);
  await sleep(1100);
  f.ledger.queueTask(task.id, USER);
  assert.match(
    await client.until(/event: task/),
    new RegExp(`data: \\{"id":"${task.id}","state":"queued"\\}`),
  );
});

test('the very first Task on an empty ledger is not swallowed by the baseline', async (t) => {
  const { f, url, cookie, stream } = await setup(t);
  const client = await openStream(url, cookie);
  t.after(client.close);
  while (stream.size === 0) await sleep(5);
  await sleep(1100);
  const task = f.newTask();
  assert.match(await client.until(/event: task/), new RegExp(task.id));
});

test('an open stream does not hold up shutdown', async (t) => {
  const { url, cookie, http, stream } = await setup(t);
  const client = await openStream(url, cookie);
  t.after(client.close);
  while (stream.size === 0) await sleep(5);
  await http.close();
  assert.equal(stream.size, 0);
});

test('an unknown route is a 404', async (t) => {
  const { get } = await setup(t);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/api/nope')).status, 404);
});
