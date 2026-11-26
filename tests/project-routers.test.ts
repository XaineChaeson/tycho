// Guards against the Routers of several projects stepping on each other or on the service's
// floors (docs/design/project-sessions.md §3, §8 acceptance): one project's long turn holding
// another project's messages back; two drivers of one project; a tool call admitted for the
// wrong project, or after its turn's context was closed by a new topic; a new topic or a stale
// context taking effect in the middle of a turn; a used-up quota of the shared login costing
// further messages instead of holding every project on it; an idle process left running, or
// its context lost instead of resumed; and recovery after degraded mode marking another
// project's turn under way as unverified.
// And (review of step 1): a tool admitted while the service is degraded or still taking stock,
// or carried out after the barrier came up while its body was on the way; a cleanup that could
// not list the contexts reported as done; a new topic during a start leaving the new segment's
// message with a context of the closed one; the draft events not saying which request, project
// and segment they answer; the Router's own login resting in memory only, for a fixed time and
// out of the Workers' sight; and a turn that failed for want of the pipe being put back as if
// the resume had been refused.
// The CLI is tests/fake-claude.mjs; the process search and the kill are this platform's own.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { SessionHostOptions } from '../service/session-host.ts';
import { createSessionHost } from '../service/session-host.ts';
import type { Schema } from '../service/tool-schema.ts';
import { createTools } from '../service/tools.ts';
import { routerMaterial } from '../service/router-material.ts';
import { hostProcesses } from '../service/processes.ts';
import { accepting, claudeTier, fixture, memoryLogins, ROUTER_TUNED, tuned, USER } from './helpers.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const TOOLS = ['list_tasks', 'get_project'];
const options = { timeout: 60_000 };

async function until<T>(read: () => T | undefined | false | null, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

type Barriers = { degraded: boolean; recovering: boolean };

function setup(t: TestContext, overrides: Partial<SessionHostOptions> = {}, barriers?: Barriers) {
  let stop = async (): Promise<void> => {};
  const previous = { ...process.env };
  t.after(async () => {
    try {
      await stop();
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
      Object.assign(process.env, previous);
    }
  });
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '乙', loginMode: 'all' }, USER);
  const logFile = join(f.dir, 'fake.log');
  Object.assign(process.env, { FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_TOOLS: JSON.stringify(TOOLS.map((name) => `mcp__tycho__${name}`)), CLAUDECODE: '1' });
  const events: { event: string; data: any }[] = [];
  const host = createSessionHost({ ...ROUTER_TUNED,
    ledger: barriers ? { ...f.ledger, dispatchConditions: () => ({ ...f.ledger.dispatchConditions(), ...barriers }) } : f.ledger,
    publish: (event, data) => events.push({ event, data }),
    dataDir: f.dir,
    launchWith: async () => ({ claude: [process.execPath, FAKE], tier: claudeTier('tier.json') }),
    toolNames: TOOLS,
    material: (projectId) => routerMaterial(f.ledger, projectId, 64 * 1024),
    log: (line) => { if (process.env.DEBUG_ROUTERS) console.error(line); },
    pollMs: 20,
    turnTimeoutMs: tuned('router.turnTimeoutMs'),
    ...overrides,
  });
  stop = host.stop;
  const say = (projectId: string, text: string) =>
    f.ledger.receiveMessage({ channel: 'console', externalId: randomUUID(), actor: 'user', text, projectId }).id;
  const state = (id: string) => f.ledger.getMessage(id).state;
  const settled = (id: string) => until(() => (state(id) === 'processed' || state(id) === 'unverified') && state(id), `消息 ${id} 收尾`);
  const log = (): { argv?: string[]; user?: string; marker_env?: string | null }[] =>
    existsSync(logFile)
      // A line being appended right now is not one yet.
      ? readFileSync(logFile, 'utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
      : [];
  const starts = () => log().filter((entry) => entry.argv);
  const users = () => log().flatMap((entry) => (entry.user === undefined ? [] : [entry.user]));
  const tokenOf = (projectId: string) => host.toolTokens().find((token) => host.projectOfToken(token) === projectId);
  return { f, host, other, say, state, settled, starts, users, tokenOf, events };
}

test('a total-control turn keeps the actual material and request through restart', options, async (t) => {
  const { f, host, other, say, settled, users } = setup(t, {
    material: (projectId) => ({
      ...routerMaterial(f.ledger, projectId, 64 * 1024),
      text: '恢复材料 Authorization: Bearer material-secret-canary',
    }),
  });
  await host.start(1);
  const request = say(f.projectId, '核对 Authorization: Bearer trajectory-secret-canary');
  host.kick(request);
  assert.equal(await settled(request), 'processed');
  assert.ok(users().some((text) => text.includes('trajectory-secret-canary')), 'redaction is for storage, not executor input');
  const reopened = f.open();
  const trace = reopened.routerTurnTrace(f.projectId, request, null);
  assert.deepEqual(trace.exchanges.map(({ phase }) => phase), ['material', 'request']);
  assert.match(trace.exchanges[0]!.input, /恢复材料.*已隐去/);
  const storedMaterial = reopened.currentContext(f.projectId)!.material_json;
  assert.doesNotMatch(storedMaterial ?? '', /material-secret-canary/);
  assert.ok(users().some((text) => text.includes('material-secret-canary')));
  assert.match(trace.exchanges[1]!.input, /已隐去/);
  assert.doesNotMatch(JSON.stringify(trace), /trajectory-secret-canary/);
  assert.equal(trace.exchanges[1]!.outcome, 'completed');
  assert.ok(trace.exchanges[1]!.template.includes('任务与状态以工具查询的账本为准'));
  assert.ok(trace.exchanges.every(({ tool_catalog }) => tool_catalog === null), 'old plain template rows do not acquire a current catalog');
  assert.deepEqual(reopened.routerTurnTrace(other, request, null).exchanges, []);
});

test('the recorded catalog is the actual trusted project-scoped tools.list definition', options, async (t) => {
  let tools: ReturnType<typeof createTools>;
  const { f, host, say, settled } = setup(t, { toolDefinitions: (projectId) => tools.list({ projectId }) });
  tools = createTools({ ledger: f.ledger, logins: memoryLogins({ own: f.login.login }),
    machines: { list: f.ledger.listMachines }, accept: accepting(f.ledger),
    runner: { events: () => [], interrupt: async () => 'ended', abandon: async () => {} } });
  const definitions = JSON.parse(JSON.stringify(tools.list({ projectId: f.projectId })));
  assert.ok(definitions.some((tool: { name: string }) => tool.name === 'create_task'));
  await host.start(1);
  const request = say(f.projectId, '核对工具目录');
  host.kick(request);
  assert.equal(await settled(request), 'processed');
  assert.deepEqual(f.ledger.routerTurnTrace(f.projectId, request, null).exchanges.at(-1)?.tool_catalog,
    { basis: 'service_available', tools: definitions });
});

test('a turn keeps its project tool definitions at exchange start, without claiming tools/list or executor receipt', options, async (t) => {
  let version = 'old-choice';
  const secret = 'router-schema-known-secret';
  const { f, host, other, say, settled } = setup(t, {
    launchWith: async () => ({ claude: [process.execPath, FAKE], tier: claudeTier('tier.json'), token: secret }),
    toolDefinitions: (projectId) => [{ name: 'project_choice', description: 'Tycho project tool ' + secret, inputSchema: {
      type: 'object', properties: { choice: { type: 'string', enum: [projectId, version] }, token: { type: 'string', description: 'ordinary token parameter' } },
    } }],
  });
  await host.start(1);
  const first = say(f.projectId, '第一轮');
  host.kick(first);
  assert.equal(await settled(first), 'processed');
  const oldTrace = f.ledger.routerTurnTrace(f.projectId, first, null);
  assert.equal(oldTrace.exchanges.length, 2);
  for (const exchange of oldTrace.exchanges) {
    assert.equal(exchange.tool_catalog?.basis, 'service_available');
    const schema = exchange.tool_catalog?.tools[0]?.inputSchema as Schema;
    assert.deepEqual(schema.properties?.choice?.enum, [f.projectId, 'old-choice']);
    assert.equal(schema.properties?.token?.type, 'string');
    assert.ok(exchange.template.includes('任务与状态以工具查询的账本为准'));
  }
  assert.doesNotMatch(JSON.stringify(oldTrace), /router-schema-known-secret/);
  assert.match(oldTrace.exchanges[0]!.tool_catalog!.tools[0]!.description, /已隐去/);
  version = 'new-choice';
  const second = say(f.projectId, '下一轮');
  host.kick(second);
  assert.equal(await settled(second), 'processed');
  const reopened = f.open();
  assert.deepEqual(reopened.routerTurnTrace(f.projectId, first, null).exchanges, oldTrace.exchanges);
  assert.deepEqual((reopened.routerTurnTrace(f.projectId, second, null).exchanges.at(-1)?.tool_catalog?.tools[0]?.inputSchema as Schema).properties?.choice?.enum, [f.projectId, 'new-choice']);
  assert.deepEqual(reopened.routerTurnTrace(other, first, null).exchanges, []);
  assert.equal(oldTrace.calls.length, 0, 'catalog availability does not fabricate an actual tools/list call');
});

test('an internal message batched behind another can open its shared turn after reopening the ledger', options, async (t) => {
  const { f, host, settled } = setup(t);
  const send = (externalId: string, text: string) => f.ledger.receiveMessage({
    channel: 'internal', externalId, actor: 'service', text, projectId: f.projectId,
  }).id;
  const first = send('trace-first-event', '第一个内部事件');
  const second = send('trace-second-event', '合并处理的第二条');
  await host.start(1);
  await settled(second);
  const reopened = f.open();
  const head = reopened.routerTurnTrace(f.projectId, first, null);
  const attached = reopened.routerTurnTrace(f.projectId, second, null);
  assert.equal(attached.turn_message_id, first);
  assert.deepEqual(attached.exchanges, head.exchanges);
  assert.match(attached.exchanges.find(({ phase }) => phase === 'request')?.input ?? '', /合并处理的第二条/);
});

test('a project login override survives an unusable service default and can change without restarting other projects', options, async (t) => {
  let isolated = '';
  let choice = 'gpt-local';
  const { host, f, other, say, state, settled, tokenOf } = setup(t, {
    projectBinding: (id) => id === isolated ? choice : null,
    launchWith: async (id) => {
      if (id !== isolated) throw new Error('default unavailable');
      if (choice === 'invalid') throw new Error('project login unavailable');
      return { claude: [process.execPath, FAKE], account: choice, tier: claudeTier('tier.json') };
    },
  });
  isolated = other;
  await host.start(1);
  assert.match(host.status().error ?? '', /default unavailable/);
  const waiting = say(f.projectId, '默认排队');
  const first = say(other, '用项目登录');
  host.kick();
  assert.equal(await settled(first), 'processed');
  assert.equal(state(waiting), 'received');
  const original = f.ledger.currentContext(other)!.id;
  assert.ok(tokenOf(other));
  choice = 'invalid';
  const second = say(other, '当前账号不可用');
  host.kick();
  await until(() => host.status().projects.find((project) => project.project_id === other)?.error?.includes('project login unavailable'), '项目启动失败');
  assert.equal(state(second), 'received');
  choice = 'backup-login';
  host.kick();
  assert.equal(await settled(second), 'processed');
  assert.notEqual(f.ledger.currentContext(other)!.id, original);
  assert.equal(state(waiting), 'received');
});

test('a project keeps using the chosen login but drops its old context after that login changes owner', options, async (t) => {
  let generation = 'old-owner';
  const { host, f, say, settled } = setup(t, {
    projectBinding: () => generation,
    launchWith: async () => ({ claude: [process.execPath, FAKE], account: 'chosen', loginGeneration: generation }),
  });
  await host.start(1);
  const first = say(f.projectId, '切换前');
  host.kick();
  assert.equal(await settled(first), 'processed');
  const context = f.ledger.currentContext(f.projectId)!;
  generation = 'new-owner';
  const second = say(f.projectId, '本机换号后');
  host.kick();
  assert.equal(await settled(second), 'processed');
  assert.equal(f.ledger.getContext(context.id)?.closed_reason, '换了登录');
  assert.notEqual(f.ledger.currentContext(f.projectId)?.id, context.id);
});

test('two projects run side by side: one project\'s long turn holds back none of the other\'s messages', options, async (t) => {
  const { f, host, other, say, state, settled, starts, users, tokenOf } = setup(t);
  await host.start(1);
  const long = say(f.projectId, '长回合');
  await until(() => users().includes('长回合'), '甲的长回合开始');
  const second = say(f.projectId, '甲的第二条');
  const theirs = say(other, '乙的第一条');
  host.kick(theirs);
  assert.equal(await settled(theirs), 'processed', '乙没有被甲的长回合拖住');
  assert.equal(state(second), 'received', '甲一次只处理一条');
  assert.equal(starts().length, 2, '两个项目各有一个驱动进程');
  const markers = new Set(starts().map((entry) => entry.marker_env));
  assert.equal(markers.size, 2);
  // A call carries its process's token: it is bound to that process's project and turn.
  const mine = host.admitTool(tokenOf(f.projectId));
  assert.ok('projectId' in mine);
  assert.deepEqual([mine.projectId, mine.messageId], [f.projectId, long]);
  mine.done();
  const idle = host.admitTool(tokenOf(other));
  assert.ok('refused' in idle, '乙没有在处理的消息，它的进程调不了工具');
  assert.equal(host.status().turns.length, 1);
  host.interrupt(f.projectId);
  assert.equal(await settled(long), 'unverified');
  assert.equal(await settled(second), 'processed');
  assert.equal(f.ledger.getContext(f.ledger.currentContext(f.projectId)!.id)!.project_id, f.projectId);
});

test('a new topic during a turn lets that turn finish in the old segment; its late tool calls are refused, and the next message starts a new context', options, async (t) => {
  const { f, host, say, settled, starts, users, tokenOf } = setup(t);
  await host.start(1);
  assert.equal(await settled(say(f.projectId, '先来一条')), 'processed');
  const before = f.ledger.currentContext(f.projectId)!;
  const long = say(f.projectId, '长回合');
  await until(() => users().includes('长回合'), '长回合开始');
  const token = tokenOf(f.projectId)!;
  const first = f.ledger.currentSegment(f.projectId)!;
  const next = f.ledger.newTopic(f.projectId, USER);
  // The turn under way is not cut short: its calls still belong to it and to the old segment.
  const during = host.admitTool(token);
  assert.ok('messageId' in during, '切段不打断正在进行的回合');
  during.done();
  const queued = say(f.projectId, '新话题的第一条');
  host.interrupt(f.projectId);
  assert.equal(await settled(long), 'unverified', 'long');
  assert.equal(f.ledger.getMessage(long).segment_id, first.id);
  // The old process is gone before the next message: its token admits nothing any more.
  assert.equal(await settled(queued), 'processed');
  assert.ok('refused' in host.admitTool(token), '迟到的工具调用不被接纳');
  assert.equal(f.ledger.getMessage(queued).segment_id, next.id);
  assert.equal(starts().length, 2);
  assert.notEqual(f.ledger.currentContext(f.projectId)!.id, before.id);
  assert.equal(f.ledger.getContext(before.id)!.closed_reason, '主人开了新话题');
  assert.match(users().at(-2)!, /从账本重建/, '新上下文先收到恢复材料');
  assert.ok(f.ledger.getContext(f.ledger.currentContext(f.projectId)!.id)!.material_json, '恢复材料送出前留了档');
  assert.deepEqual(await hostProcesses.find(before.marker), []);
});

test('a used-up quota of the shared login holds every project on it, and the failed turn is not sent again', options, async (t) => {
  const { f, host, other, say, state, settled, users } = setup(t, {
    launchWith: async () => ({ claude: [process.execPath, FAKE], tier: claudeTier('tier.json'), account: 'shared' }),
  });
  await host.start(1);
  const hit = say(f.projectId, '额度用完了吗');
  assert.equal(await settled(hit), 'unverified');
  assert.ok(f.ledger.loginState('shared').rest_until, '额度记在登录上，不按项目存');
  const mine = say(f.projectId, '甲等着');
  const theirs = say(other, '乙也等着');
  host.kick(mine);
  host.kick(theirs);
  await sleep(300);
  assert.deepEqual([state(mine), state(theirs)], ['received', 'received'], '用这个登录的项目都停止取消息');
  assert.equal(users().filter((text) => text.includes('额度用完了吗')).length, 1);
  // The rest is over (the owner's retry clears it the same way).
  f.force('UPDATE login_state SET rest_until = NULL WHERE id = ?', 'shared');
  assert.equal(await settled(mine), 'processed');
  assert.equal(await settled(theirs), 'processed');
  assert.equal(users().filter((text) => text.includes('额度用完了吗')).length, 1, '恢复后也不自动重放');
});

test('an idle process exits once its calls are done, and the next message resumes its context', options, async (t) => {
  const { f, host, say, settled, starts } = setup(t, { idleMs: () => 300 });
  await host.start(1);
  assert.equal(await settled(say(f.projectId, '先来一条')), 'processed');
  const context = f.ledger.currentContext(f.projectId)!;
  await until(() => !host.status().alive, '空闲退出');
  // Gone only once the scan says so.
  await until(() => f.ledger.getContext(context.id)!.live_at === null, '确认进程不在了');
  assert.deepEqual(await hostProcesses.find(context.marker), []);
  assert.equal(f.ledger.currentContext(f.projectId)!.id, context.id, '上下文留着，下次续接');
  assert.equal(await settled(say(f.projectId, '回来了')), 'processed');
  assert.equal(starts().length, 2);
  assert.ok(starts()[1]!.argv!.includes('--resume'));
});

test('recovery marks unverified only the messages of projects with no turn under way', options, async (t) => {
  const { f, host, other, say, users } = setup(t);
  await host.start(1);
  const long = say(f.projectId, '长回合');
  await until(() => users().includes('长回合'), '甲的长回合开始');
  // A message of the other project stranded in processing by a failed write.
  const stranded = say(other, '卡住的');
  f.ledger.takeNextTurn(other);
  assert.deepEqual(f.ledger.markProcessingUnverified(host.busyProjects()), [stranded]);
  assert.equal(f.ledger.getMessage(long).state, 'processing', '甲的回合还在进行，由它自己收尾');
  host.interrupt(f.projectId);
});

// --- review of step 1 ---

test('no tool is admitted while the service is degraded or taking stock, and one admitted before is refused once the barrier is up', options, async (t) => {
  const barriers: Barriers = { degraded: false, recovering: false };
  const { f, host, other, say, settled, users, tokenOf } = setup(t, {}, barriers);
  await host.start(1);
  const long = say(f.projectId, '长回合');
  await until(() => users().includes('长回合'), '甲的长回合开始');
  const token = tokenOf(f.projectId)!;
  // Another project's turn brought the service down: this one's calls stop too.
  barriers.degraded = true;
  const degraded = host.admitTool(token);
  assert.ok('refused' in degraded);
  assert.match(degraded.refused, /降级/);
  barriers.degraded = false;
  barriers.recovering = true;
  const recovering = host.admitTool(token);
  assert.ok('refused' in recovering);
  assert.match(recovering.refused, /清点/);
  barriers.recovering = false;
  // Admitted while all was well; the barrier comes up while the call's body is on its way.
  const admitted = host.admitTool(token);
  assert.ok('recheck' in admitted);
  assert.equal(admitted.recheck(), undefined);
  barriers.degraded = true;
  assert.match(admitted.recheck() ?? '', /降级/, '执行前再查一次');
  admitted.done();
  barriers.degraded = false;
  host.interrupt(f.projectId);
  assert.equal(await settled(long), 'unverified');
  void other;
});

test('a cleanup that cannot list the contexts that may still run fails, and starts no Router', options, async (t) => {
  const f = fixture(t);
  const listing = { failing: true };
  const host = createSessionHost({ ...ROUTER_TUNED,
    ledger: { ...f.ledger, liveContexts() { if (listing.failing) throw new Error('账本读不出来'); return f.ledger.liveContexts(); } },
    dataDir: f.dir,
    launchWith: async () => ({ claude: [process.execPath, FAKE], tier: claudeTier('tier.json') }),
    toolNames: TOOLS,
    log: () => {},
    pollMs: 20,
    turnTimeoutMs: tuned('router.turnTimeoutMs'),
  });
  await assert.rejects(host.cleanup(), /清点/);
  assert.match(host.status().error ?? '', /清点.*没有完成/);
  await host.start(1);
  const id = f.ledger.receiveMessage({ channel: 'console', externalId: 'x', actor: 'user', text: '等着', projectId: f.projectId }).id;
  host.kick(id);
  await sleep(200);
  assert.equal(f.ledger.getMessage(id).state, 'received');
  assert.deepEqual(f.ledger.liveContexts(), [], '没有新开任何上下文');
  listing.failing = false;
  await assert.rejects(async () => {
    listing.failing = true;
    await host.stop();
  }, /清点/, '停服也不能拿部分清单说清完了');
  listing.failing = false;
});

test('a new topic during a start puts the message, and the context it goes to, in the new segment', options, async (t) => {
  const gate = { open: Promise.withResolvers<void>(), asked: Promise.withResolvers<void>() };
  let asks = 0;
  const { f, host, say, settled, users } = setup(t, {
    launchWith: async () => {
      asks += 1;
      if (asks === 2) {
        gate.asked.resolve();
        await gate.open.promise;
      }
      return { claude: [process.execPath, FAKE], tier: claudeTier('tier.json') };
    },
  });
  await host.start(1);
  const id = say(f.projectId, '切段时来的');
  await gate.asked.promise;
  const first = f.ledger.currentSegment(f.projectId)!;
  const next = f.ledger.newTopic(f.projectId, USER);
  gate.open.resolve();
  assert.equal(await settled(id), 'processed');
  assert.equal(f.ledger.getMessage(id).segment_id, next.id);
  const context = f.ledger.currentContext(f.projectId)!;
  assert.equal(context.segment_id, next.id, '处理它的上下文属于新段');
  assert.ok(users().includes('切段时来的'));
  // The ledger refuses a context for a segment that is no longer current.
  assert.throws(() => f.ledger.openContext({ projectId: f.projectId, segmentId: first.id, marker: 'm', launch: {}, knowledge: [] }), /已经结束/);
});

test('each draft says which request, project and segment it answers', options, async (t) => {
  const { f, host, say, settled, events } = setup(t);
  await host.start(1);
  const id = say(f.projectId, '流式回复');
  assert.equal(await settled(id), 'processed');
  const deltas = events.filter(({ event }) => event === 'delta').map(({ data }) => data);
  assert.ok(deltas.length > 0);
  for (const each of deltas) {
    assert.deepEqual([each.reply_to, each.project_id, each.segment_id], [id, f.projectId, f.ledger.getMessage(id).segment_id]);
  }
});

test("the Router's own login rests in the ledger, under its login, for the owner's rest, and a restart still waits", options, async (t) => {
  let login: string;
  const { f, host, say, state, settled } = setup(t, { hostLogin: () => login });
  login = f.ledger.getMachineLogin('h1', 'claude')!.id;
  await host.start(1);
  const before = Date.now();
  assert.equal(await settled(say(f.projectId, '额度用完了吗')), 'unverified');
  const rest = f.ledger.loginState(login).rest_until;
  assert.ok(rest !== null, '冷却记在这份登录上');
  const until = Date.parse(rest!);
  assert.ok(until >= before + 29 * 60_000 && until <= Date.now() + 31 * 60_000, `按设置“额度用完后歇多久”（默认 30 分钟）：${rest}`);
  await host.stop();
  const again = createSessionHost({ ...ROUTER_TUNED,
    ledger: f.ledger, dataDir: f.dir, toolNames: TOOLS, log: () => {}, pollMs: 20, turnTimeoutMs: tuned('router.turnTimeoutMs'),
    launchWith: async () => ({ claude: [process.execPath, FAKE], tier: claudeTier('tier.json') }),
    hostLogin: () => login,
  });
  // Here, not in t.after: the fixture's hook comes first and removes the directory.
  try {
    await again.start(1);
    const waiting = say(f.projectId, '重启之后');
    again.kick(waiting);
    await sleep(300);
    assert.equal(state(waiting), 'received', '重启服务也还在歇');
  } finally {
    await again.stop();
  }
});

// docs/design/triggers.md §3, §6: a trigger's message goes to its project's Router like any other,
// marked as a trigger's and never as the owner's words; its tool calls are bound to that message
// before their bodies are read, and its reply stays in the console.
test("a trigger's message reaches its project's Router as a trigger's, and its reply stays in the console", options, async (t) => {
  const { f, host, settled, users, tokenOf } = setup(t);
  await host.start(1);
  const now = new Date();
  const trigger = f.ledger.createTrigger(f.projectId, { name: '长回合检查', instruction: '长回合', schedule: { kind: 'once', at: new Date(now.getTime() + 60_000).toISOString() } }, USER, now);
  f.ledger.fireDue(new Date(now.getTime() + 61_000));
  const fire = f.ledger.listTriggerFires({ triggerId: trigger.id, limit: 1 })[0]!;
  host.kick(fire.message_id!);
  const sent = await until(() => users().find((text) => text.includes('长回合检查')), '触发消息送到负责人');
  assert.match(sent, /^\[tycho 触发器\]/);
  assert.match(sent, /不是主人说的话/);
  const call = host.admitTool(tokenOf(f.projectId));
  assert.ok('messageId' in call);
  assert.deepEqual([call.messageId, call.projectId], [fire.message_id, f.projectId]);
  call.done();
  host.interrupt(f.projectId);
  await settled(fire.message_id!);
  const shortTrigger = f.ledger.createTrigger(f.projectId, { name: '短的', instruction: '你好', schedule: { kind: 'once', at: new Date(now.getTime() + 120_000).toISOString() } }, USER, now);
  f.ledger.fireDue(new Date(now.getTime() + 121_000));
  const short = f.ledger.listTriggerFires({ triggerId: shortTrigger.id, limit: 1 })[0]!.message_id!;
  host.kick(short);
  assert.equal(await settled(short), 'processed');
  const reply = f.ledger.listMessages({ limit: 100 }).find((row) => row.external_id === `reply:${short}`)!;
  assert.equal(reply.channel, 'console');
  assert.equal(reply.project_id, f.projectId);
});
