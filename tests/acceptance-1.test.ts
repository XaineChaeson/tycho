// Guards against §11 group 1: a message acknowledged but not stored, a stored message
// lost in a crash, and a request cut short being replayed or shown as finished. End to
// end: real ledger, fake CLI, fake instance, HTTP; a crash on each side of the commit,
// and one real kill of the service process with a marked orphan left behind.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { hostProcesses } from '../service/processes.ts';
import type { Service } from './stage.ts';
import { signIn, stage, LOGIN, until } from './stage.ts';

const options = { timeout: 90_000 };
const SENTENCE = '已收消息可查；未完成请求显示为待核实并列出已提交操作，不自动重放';

const texts = async (client: Awaited<ReturnType<typeof signIn>>): Promise<string[]> => {
  const { messages } = (await (await client.get('/api/messages')).json()) as { messages: { text: string }[] };
  return messages.map(({ text }) => text);
};

test(`${SENTENCE}（入站，提交前崩溃）`, options, async (t) => {
  const { start, crashAt, wreck, project } = stage(t);
  const first = await start();
  const client = await signIn(first);
  const crashed = crashAt('message.receive', 'before');
  const response = await client.post('/api/messages', { text: '没落库的', project_id: project(first) });
  await crashed;
  assert.equal(response.status, 503, '底线“写库失败停止副作用”：没落库的消息被确认了');
  await wreck(first);

  const service = await start();
  assert.equal((await texts(await signIn(service))).includes('没落库的'), false);
});

test(`${SENTENCE}（入站，提交后崩溃）`, options, async (t) => {
  const { start, crashAt, wreck, turnsSeen, project } = stage(t);
  const first = await start();
  const client = await signIn(first);
  const crashed = crashAt('message.receive', 'after');
  await client.post('/api/messages', { text: '落了库的', project_id: project(first) });
  await crashed;
  await wreck(first);

  const service = await start();
  assert.ok((await texts(await signIn(service))).includes('落了库的'), '§11 第一组：已收消息查不到');
  // Nothing of it had reached the Router, so this is its first delivery and not a replay.
  await until(() => turnsSeen().includes('落了库的'), '消息被处理');
});

async function midTurn(service: Service, s: ReturnType<typeof stage>): Promise<{ message: string; call: Promise<Response> }> {
  await s.greet(service);
  const project = s.project(service);
  const message = s.say(service, '长回合');
  await until(() => s.turnsSeen().includes('长回合'), '回合开始');
  const call = fetch(`http://127.0.0.1:${service.port}/tools/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${service.session.toolTokens()[0]}` },
    body: JSON.stringify({
      name: 'create_task',
      arguments: { title: '负责人建的', goal: '目标', acceptance: '测试通过', login_id: LOGIN.name, role_id: 'implement' },
    }),
  });
  return { message, call };
}

async function unfinished(service: Service, message: string) {
  const client = await signIn(service);
  const { messages } = (await (await client.get('/api/messages')).json()) as { messages: { id: string; state: string }[] };
  const { changes } = (await (await client.get(`/api/messages/${message}/changes`)).json()) as { changes: { action: string }[] };
  return { state: messages.find(({ id }) => id === message)?.state, committed: changes.map(({ action }) => action) };
}

test(`${SENTENCE}（负责人回合内的工具调用，提交前崩溃）`, options, async (t) => {
  const s = stage(t);
  const first = await s.start();
  const crashed = s.crashAt('task.create', 'before');
  const { message } = await midTurn(first, s);
  await crashed;
  await s.wreck(first);

  const service = await s.start();
  assert.deepEqual(await unfinished(service, message), { state: 'unverified', committed: [] });
  assert.equal(service.ledger.listTasks().length, 0);
  await sleep(150);
  assert.equal(s.turnsSeen().filter((text) => text === '长回合').length, 1, '§5.1：未完成的请求被自动重放');
});

test(`${SENTENCE}（负责人回合内的工具调用，提交后崩溃）`, options, async (t) => {
  const s = stage(t);
  const first = await s.start();
  const crashed = s.crashAt('task.create', 'after');
  const { message } = await midTurn(first, s);
  await crashed;
  await s.wreck(first);

  const service = await s.start();
  assert.deepEqual(
    await unfinished(service, message),
    { state: 'unverified', committed: ['task.create', 'task.queue'] },
    '§11 第一组：待核实的请求没有列出已提交的操作',
  );
  await sleep(150);
  assert.equal(s.turnsSeen().filter((text) => text === '长回合').length, 1, '§5.1：未完成的请求被自动重放');
  assert.equal(service.ledger.listTasks().length, 1, '操作只提交了一次');
});

test(`${SENTENCE}（真杀服务进程，留下带标记的孤儿）`, options, async (t) => {
  const s = stage(t);
  const main = new URL('../service/main.ts', import.meta.url).href;
  const cli = [process.execPath, join(import.meta.dirname, 'fake-claude.mjs')];
  const script = `
    import { startService } from ${JSON.stringify(main)};
    const service = await startService(${JSON.stringify({ dataDir: s.dataDir, port: 0, claude: cli })});
    const projectId = service.ledger.createProject({ name: '试跑' }, { actor: 'test' });
    const say = (text) => service.ledger.receiveMessage({ channel: 'console', externalId: text, actor: 'console', text, projectId }).id;
    const opening = say('开场');
    while (service.ledger.getMessage(opening).state !== 'processed') await new Promise((done) => setTimeout(done, 20));
    console.log(JSON.stringify({ message: say('长回合'), marker: service.ledger.currentContext(projectId).marker }));
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, FAKE_CLAUDE_CHILD: 'orphan' },
  });
  t.after(() => child.kill('SIGKILL'));
  const [line] = (await once(createInterface({ input: child.stdout }), 'line')) as [string];
  const { message, marker } = JSON.parse(line) as { message: string; marker: string };
  await until(() => s.turnsSeen().includes('长回合'), '回合开始');
  child.kill('SIGKILL');
  await once(child, 'close');
  assert.ok((await hostProcesses.find(marker)).length > 0, '这条用例要的是真有孤儿留下');

  const service = await s.start();
  assert.equal(service.ledger.getMessage(message).state, 'unverified', '§5.1：被杀时在处理的消息没有置为待核实');
  assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')?.marker, marker);
  // A project's Router starts with its next message, after the orphan is cleared.
  s.say(service, '之后');
  await until(() => service.session.status().pid, '负责人接上');
  assert.deepEqual(await hostProcesses.find(marker), [service.session.status().pid], '底线“负责人进程唯一归属”：孤儿没有清掉');
  await sleep(150);
  assert.equal(s.turnsSeen().filter((text) => text === '长回合').length, 1, '§5.1：未完成的请求被自动重放');
});
