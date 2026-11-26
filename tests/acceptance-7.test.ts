// Guards against §11 group 7: control from anyone but the signed-in owner, a page on
// another site driving the service, a stranger's message or answer taking effect, a
// logout not holding across a crash, and a new Router started next to one that could not
// be cleared. End to end: real ledger, fake CLI, fake instance, HTTP; a crash on each side
// of the commit.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import type { Processes } from '../service/session-host.ts';
import { signIn, stage } from './stage.ts';

const options = { timeout: 90_000 };
const SENTENCE = '非授权控制被拒绝；残留负责人清理失败时阻止启动新驱动者';
const FLOOR = '底线“负责人进程唯一归属”';
const stuck: Processes = { find: async () => [4242], kill: async () => {} };

test(`${SENTENCE}（身份、Origin、token）`, options, async (t) => {
  const { start, queued, launched, remote } = stage(t);
  const service = await start();
  const { ledger } = service;
  const task = queued(service);
  const run = await launched(service, task);
  const client = await signIn(service);
  const { base, cookie } = client;
  const post = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });

  for (const path of ['/api/pause', `/api/tasks/${task.id}/interrupt`, '/api/messages', '/api/interrupt']) {
    assert.equal((await post(path)).status, 401, `没登录也能控制 ${path}`);
    assert.equal((await post(path, { Cookie: cookie, Origin: 'http://evil.example' })).status, 403, `跨站能控制 ${path}`);
  }
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal(remote.called('stop.sh'), 0);
  assert.equal(ledger.getRun(run.id).state, 'running');
  assert.equal(ledger.dispatchConditions().paused, false);

  assert.equal((await post('/tools/call')).status, 401, '没有工具 token 也能调工具');
  assert.equal((await post('/tools/call', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post('/api/shutdown', { Authorization: 'Bearer wrong' })).status, 401, '没有停服 token 也能停服');
  assert.equal((await post('/api/login-links', { Authorization: 'Bearer wrong' })).status, 401);

  const approval = ledger.openApproval(queued(service, '要问的').id, [{ question: '？' }], { actor: 'test' });
  assert.throws(() => ledger.answerApproval(approval, ['是'], 'stranger', 'wecom'), InputError, '白名单外的人答复了问题');
  const stranger = ledger.receiveMessage({ channel: 'wecom', externalId: 'x', actor: 'stranger', text: '开工' });
  assert.equal(stranger.state, 'ignored', '白名单外的消息进了负责人');
});

test(`${SENTENCE}（注销提交前崩溃）`, options, async (t) => {
  const { start, crashAt, wreck } = stage(t);
  const first = await start();
  const client = await signIn(first);
  const crashed = crashAt('console.logout', 'before');
  await client.post('/api/logout');
  await crashed;
  await wreck(first);

  const service = await start();
  const response = await fetch(`http://127.0.0.1:${service.port}/api/state`, { headers: { Cookie: client.cookie } });
  assert.equal(response.status, 200, '没提交的注销不算数，账本是唯一权威');
});

test(`${SENTENCE}（注销提交后崩溃，登录链接重启作废）`, options, async (t) => {
  const { start, crashAt, wreck } = stage(t);
  const first = await start();
  const client = await signIn(first);
  const { credential } = first.auth.createLink();
  const crashed = crashAt('console.logout', 'after');
  await client.post('/api/logout');
  await crashed;
  await wreck(first);

  const service = await start();
  const base = `http://127.0.0.1:${service.port}`;
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: client.cookie } })).status, 401, '已注销的 Cookie 重启后又能用了');
  const link = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential }) });
  assert.equal(link.status, 410, '上一次启动的登录链接重启后还能兑换');
});

for (const when of ['before', 'after'] as const) {
  test(`${SENTENCE}（取消息${when === 'before' ? '提交前' : '提交后'}崩溃，残留负责人清不掉）`, options, async (t) => {
    const { start, crashAt, wreck, greet, say, routerStarts, turnsSeen } = stage(t);
    const first = await start();
    await greet(first);
    const session = first.ledger.currentContext(first.ledger.listProjects()[0]?.id ?? '')!;
    const crashed = crashAt('message.take', when);
    const message = say(first, '崩溃时在取的');
    await crashed;
    await wreck(first);
    const started = routerStarts();

    const service = await start({ processes: stuck });
    const client = await signIn(service);
    const state = (await (await client.get('/api/state')).json()) as { router: { alive: boolean; error: string | null } };
    assert.match(state.router.error ?? '', /清不掉/, '§11 第七组：停摆没有在 /api/state 上显示');
    assert.equal(state.router.alive, false);

    const posted = await client.post('/api/messages', { text: '停摆时发的', project_id: service.ledger.listProjects()[0]!.id });
    assert.equal(posted.status, 201, '服务还活着，消息照常落库');
    await sleep(200);
    assert.equal(routerStarts(), started, `${FLOOR}：清理失败还启动了新负责人`);
    assert.equal(turnsSeen().includes('停摆时发的'), false);
    assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')?.id, session.id, '不能确认旧负责人已死，就不能关掉它的会话');
    assert.equal(service.ledger.getMessage(message).state, when === 'before' ? 'received' : 'unverified');
  });
}
