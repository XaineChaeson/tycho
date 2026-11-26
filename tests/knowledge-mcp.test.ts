// Guards against the knowledge MCP being a way past the knowledge it serves
// (docs/design/knowledge-and-skills.md §4.3): its token reaching the Router's tools, the
// routes only this machine's own processes may use, the console, or any tool but the four;
// the MCP answering on the outside listener; reading and proposing being one grant, or a
// revoked token still opening anything; a path or an id in a request making the service read
// a file of the host; a machine elsewhere reaching it without both its own node token and a
// knowledge token; and the three ways a read can end — the service unavailable, nothing in
// that range, more than one page — being told apart wrongly or not at all, so that a session
// takes "unavailable" for "nothing there".
// And it runs the first real data through the whole loop, in a data directory of its own:
// the TY coordinator's lessons of 11-06..11-09 sorted as §7 says, proposed through the MCP's
// stdio server, approved in the console, in the brief of a new round, and revised with a
// counter-example (§8 step 1).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import type { Snapshot } from '../runner/snapshot.ts';
import { snapshotFiles } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import type { RunRow } from '../service/ledger.ts';
import { consoleApp, LOGIN_TOKEN, SHUTDOWN_TOKEN, TOOL_TOKEN } from './console-helpers.ts';
import { LOGIN, DONE, memoryLogins, tuned, USER, DISPATCH_TUNED, holdMachine, testMachine } from './helpers.ts';
import { ownerEntry } from './knowledge-helpers.ts';
import { createLibrary } from '../service/library.ts';

const MCP_SERVER = join(import.meta.dirname, '..', 'service', 'knowledge-mcp.ts');
const SYNTHETIC_SEED = `# Synthetic Knowledge Seed\n\n${Array.from({ length: 12 }, (_, idx) => {
  const n = idx + 1;
  const key = `E${n}`;
  const scoped = n >= 11 ? '只适用于当前项目环境' : '所有工程任务通用';
  return [
    `### ${key} 工程经验条目 ${n}`,
    `- **适用范围**：${scoped}`,
    `- **触发情境**：执行第 ${n} 类排查或性能优化任务时`,
    `- **正确做法**：先量化基线再做第 ${n} 步改动。改动后用同一测试集复测确认收益。`,
    `- **反例**：`,
    `  - L${100 + n} 未测基线直接改代码，耗时从 7.92s 抖动到 48–67s`,
  ].join('\n');
}).join('\n\n')}`;
const WHY = { when: '何时', changes: '改什么', generalizes: '依据和边界' };
const EVIDENCE = [{ source: 'conversation', ref: 's1', location: 'L1', excerpt: '摘录' }];

type App = Awaited<ReturnType<typeof consoleApp>>;

// A client for a session on codex: its proposals' gates run on another executor (claude here).
async function issue(app: App, grants: string[], name = '本机 Codex'): Promise<{ id: string; token: string }> {
  const response = await app.post('/api/knowledge/clients', { name, executor: 'codex', grants });
  assert.equal(response.status, 201);
  const { client, token } = (await response.json()) as { client: { id: string }; token: string };
  return { id: client.id, token };
}

const mcp = (app: App, token: string, body: unknown): Promise<Response> =>
  fetch(`${app.url}/api/knowledge/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function call(app: App, token: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const response = await mcp(app, token, { method: 'tools/call', name, arguments: args });
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0]!.text, isError: result.isError === true };
}

// For a proposal that waits for the owner (global + resident), approve it in the console.
// Proposals that already published immediately return their published state directly.
async function through(app: App, id: string): Promise<{ state: string; entries: Record<string, string> }> {
  const { proposal } = (await (await app.get(`/api/knowledge/proposals/${id}`)).json()) as { proposal: { state: string; final_digest: string } };
  if (proposal.state !== 'awaiting_owner') return { state: proposal.state, entries: {} };
  const response = await app.post(`/api/knowledge/proposals/${id}/decide`, { decision: 'approve', digest: proposal.final_digest });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as { state: string; entries: Record<string, string> };
}

const entryOf = (app: App, proposalId: string): string => app.f.ledger.listEntries({ includeRetired: true }).find(({ proposal_id }) => proposal_id === proposalId)!.id;

// The stdio server as a session would start it: one process, lines in, lines out.
function stdioServer(t: TestContext, args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [MCP_SERVER, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } };
    waiting.get(message.id)?.(message);
  });
  let next = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<{ result?: any; error?: { message: string } }>((resolve) => {
      next += 1;
      waiting.set(next, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
    });
  const tool = async (name: string, args: unknown): Promise<{ text: string; isError: boolean }> => {
    const { result } = await request('tools/call', { name, arguments: args });
    return { text: result.content[0].text as string, isError: result.isError === true };
  };
  return { request, tool };
}

test('a knowledge token opens the four knowledge tools and nothing else, and only on the inside listener', async (t) => {
  const app = await consoleApp(t);
  const { token } = await issue(app, ['read', 'propose']);
  const listed = (await (await mcp(app, token, { method: 'tools/list' })).json()) as { tools: { name: string }[] };
  assert.deepEqual(listed.tools.map(({ name }) => name).sort(), ['get_working_context', 'propose_learning', 'read_library', 'search_library']);
  // Not the Router's tools, not this machine's own routes, not the console.
  for (const [method, path] of [['POST', '/tools/list'], ['POST', '/tools/call'], ['POST', '/api/login-links'], ['POST', '/api/shutdown'], ['GET', '/api/instance'], ['GET', '/api/knowledge'], ['POST', '/api/knowledge/proposals']] as const) {
    const response = await fetch(`${app.url}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  // A tool name of the Router's is no tool here.
  const projects = app.f.ledger.listProjects().length;
  assert.deepEqual(await call(app, token, 'create_project', { name: '从知识令牌建的' }), { text: '没有这个工具：create_project', isError: true });
  assert.equal(app.f.ledger.listProjects().length, projects);
  // The Router's and this machine's own tokens are not knowledge tokens.
  for (const other of [TOOL_TOKEN, LOGIN_TOKEN, SHUTDOWN_TOKEN]) assert.equal((await mcp(app, other, { method: 'tools/list' })).status, 401);
  // The outside listener does not have the route at all: it answers as for a path nobody serves.
  const outside = await app.http.outside.listen(0);
  const ask = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${outside}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ method: 'tools/list' }) });
    return [response.status, await response.text()];
  };
  assert.deepEqual(await ask('/api/knowledge/mcp'), await ask('/api/no-such-route'));
});

test('reading and proposing are separate grants, and a revoked token opens nothing', async (t) => {
  const app = await consoleApp(t);
  const reader = await issue(app, ['read'], '只读');
  const proposer = await issue(app, ['propose'], '只提议');
  const listed = (await (await mcp(app, reader.token, { method: 'tools/list' })).json()) as { tools: { name: string }[] };
  assert.ok(!listed.tools.some(({ name }) => name === 'propose_learning'));
  const proposal = { outputs: [{ title: 't', when_to_use: 'w', body: 'b', project_ids: null, loading: 'on_demand' }], why: WHY, evidence: EVIDENCE };
  assert.deepEqual(await call(app, reader.token, 'propose_learning', proposal), { text: '这个令牌没有提议的授权', isError: true });
  assert.deepEqual(await call(app, proposer.token, 'search_library', { query: 'x', scope: 'global' }), { text: '这个令牌没有读取的授权', isError: true });
  assert.equal((await call(app, proposer.token, 'propose_learning', proposal)).isError, false);
  // Who proposed it is the client the token belongs to, whatever the request says.
  assert.equal(app.f.ledger.listProposals()[0]!.proposed_by, '只提议');
  assert.equal((await app.post(`/api/knowledge/clients/${reader.id}/revoke`, {})).status, 200);
  assert.equal((await mcp(app, reader.token, { method: 'tools/list' })).status, 401);
  // The token was shown once at issue; the owner can see it again until it is revoked.
  assert.equal(((await (await app.get(`/api/knowledge/clients/${proposer.id}/token`)).json()) as { token: string }).token, proposer.token);
  assert.equal((await app.get(`/api/knowledge/clients/${reader.id}/token`)).status, 404);
});

test('no file of the host is read by a path or an id a request names', async (t) => {
  const app = await consoleApp(t);
  const { token } = await issue(app, ['read', 'propose']);
  mkdirSync(join(app.f.dir, 'secrets'), { recursive: true });
  const secret = join(app.f.dir, 'secrets', 'wecom');
  writeFileSync(secret, 'TOPSECRET-VALUE\n');
  const proposed = await call(app, token, 'propose_learning', {
    outputs: [{ title: 't', when_to_use: 'w', body: 'b', project_ids: null, loading: 'on_demand' }], why: WHY,
    evidence: [{ source: 'file', ref: secret, location: secret, excerpt: '只有这一句' }],
  });
  assert.equal(proposed.isError, false);
  assert.ok(!JSON.stringify(app.f.dump()).includes('TOPSECRET'), '账本里没有那个文件的内容');
  assert.deepEqual(app.f.ledger.listProposals()[0]!.evidence.map(({ excerpt, verified }) => [excerpt, verified]), [['只有这一句', false]]);
  for (const id of ['../secrets/wecom', secret, '..\\..\\ledger.db']) {
    assert.deepEqual(await call(app, token, 'read_library', { id }), { text: `没有这个条目：${id}`, isError: true });
  }
  assert.equal((await call(app, token, 'search_library', { query: 'TOPSECRET', scope: '../secrets' })).text, '项目不存在：../secrets');
});

test('a machine elsewhere reaches the tools through its node channel, with its node token and a knowledge token both', async (t) => {
  const app = await consoleApp(t);
  const { token } = await issue(app, ['read']);
  const nodeToken = 'a'.repeat(64);
  app.f.ledger.joinMachine({ id: 'n1', host: 'n1', nodeId: 'b'.repeat(32), tokenHash: createHash('sha256').update(nodeToken).digest('hex'), platform: 'linux', source: null, ephemeral: false }, USER);
  const ask = (headers: Record<string, string>) =>
    fetch(`${app.url}/api/node/knowledge/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method: 'tools/list' }) });
  assert.equal((await ask({ 'X-Tycho-Knowledge-Token': token })).status, 401, '没有机器令牌');
  assert.equal((await ask({ Authorization: `Bearer ${nodeToken}` })).status, 401, '没有知识令牌');
  assert.equal((await ask({ Authorization: `Bearer ${token}`, 'X-Tycho-Knowledge-Token': token })).status, 401, '知识令牌当不了机器令牌');
  const ok = await ask({ Authorization: `Bearer ${nodeToken}`, 'X-Tycho-Knowledge-Token': token });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { tools: unknown[] }).tools.length, 3);
});

test('unavailable, nothing found and another page are three different answers', async (t) => {
  const app = await consoleApp(t);
  const { token } = await issue(app, ['read', 'propose']);
  // Nothing listens there: the answer says the service is unavailable, as an error.
  const down = stdioServer(t, ['--url', 'http://127.0.0.1:9'], { TYCHO_KNOWLEDGE_TOKEN: token });
  const unavailable = await down.tool('search_library', { query: '差距', scope: 'global' });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.text, /^知识服务不可用：/);
  assert.match(unavailable.text, /不要改去读本地的旧记忆文件/);
  assert.match((await down.request('tools/list')).error!.message, /^知识服务不可用/);
  const up = stdioServer(t, ['--url', app.url], { TYCHO_KNOWLEDGE_TOKEN: token });
  const initialized = await up.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.serverInfo.name, 'tycho-knowledge');
  // Nothing in that range: an answer, not an error.
  const empty = await up.tool('search_library', { query: '差距', scope: 'global' });
  assert.deepEqual([empty.isError, empty.text.startsWith('在这个范围内没找到')], [false, true]);
  const context = JSON.parse((await up.tool('get_working_context', { project_id: app.f.projectId })).text) as { note: string };
  assert.match(context.note, /^在这个范围内没找到/);
  // A missing entry is an error that names it.
  assert.deepEqual(await up.tool('read_library', { id: 'NOSUCH' }), { text: '没有这个条目：NOSUCH', isError: true });
  // More than a page: the cursor leads on, and the last page says there is no more.
  for (let n = 0; n < 5; n += 1) {
    const { text } = await up.tool('propose_learning', { outputs: [{ title: `差距 ${n}`, when_to_use: 'w', body: '分解差距', project_ids: null, loading: 'on_demand' }], why: WHY, evidence: EVIDENCE, request_id: `page-${n}` });
    await through(app, (JSON.parse(text) as { proposal_id: string }).proposal_id);
  }
  const first = JSON.parse((await up.tool('search_library', { query: '差距', scope: 'global', limit: 2 })).text) as { total: number; items: { title: string }[]; next_cursor: string | null };
  assert.deepEqual([first.total, first.items.map(({ title }) => title), first.next_cursor], [5, ['差距 0', '差距 1'], '2']);
  const last = JSON.parse((await up.tool('search_library', { query: '差距', scope: 'global', limit: 2, cursor: '4' })).text) as { items: { title: string }[]; next_cursor: string | null };
  assert.deepEqual([last.items.map(({ title }) => title), last.next_cursor], [['差距 4'], null]);
  // And a token the host does not know is not "nothing found" either.
  const stranger = stdioServer(t, ['--url', app.url], { TYCHO_KNOWLEDGE_TOKEN: 'f'.repeat(64) });
  assert.match((await stranger.tool('search_library', { query: '差距', scope: 'global' })).text, /^知识服务不可用：主机回答 401/);
});

// ---- The first batch of real data (§7) ----

interface Lesson {
  key: string;
  title: string;
  range: string;
  trigger: string;
  practice: string;
  examples: string[];
}

function lessonsOf(markdown: string): Lesson[] {
  return markdown.split(/\n(?=### E\d+ )/).slice(1).map((section) => {
    const [head, ...lines] = section.split('\n');
    const [, key, title] = /^### (E\d+) (.+)$/.exec(head!)!;
    const field = (name: string): string => lines.find((line) => line.startsWith(`- **${name}**：`))!.slice(`- **${name}**：`.length).trim();
    const start = lines.findIndex((line) => line.startsWith('- **反例**'));
    const examples: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('  - ')) break;
      examples.push(line.slice(4).trim());
    }
    return { key: key!, title: title!, range: field('适用范围'), trigger: field('触发情境'), practice: field('正确做法'), examples };
  });
}

// §7's sorting: a sound method is knowledge — global when the seed says it is general, the
// project's when it says it holds for one environment only; the numbers and the failed tries
// stay in the evidence, never in the body.
const projectOnly = (lesson: Lesson): boolean => lesson.range.startsWith('只适用于');

function outputOf(lesson: Lesson, projectId: string) {
  return {
    title: lesson.title,
    when_to_use: lesson.trigger,
    body: `${lesson.practice}\n\n边界：${lesson.range}`,
    project_ids: projectOnly(lesson) ? [projectId] : null,
    // The general methods are what every round should carry; the environment-specific ones are
    // looked up when that environment comes up.
    loading: projectOnly(lesson) ? 'on_demand' : 'resident',
  };
}

function proposalOf(lesson: Lesson, projectId: string) {
  return {
    outputs: [outputOf(lesson, projectId)],
    why: {
      when: lesson.trigger,
      changes: lesson.practice.split('。')[0]!,
      generalizes: `${lesson.examples.length} 次反例（见证据）；适用范围：${lesson.range}`,
    },
    evidence: lesson.examples.map((example) => ({
      source: 'conversation',
      ref: '5419629a-49a9-4730-b7ac-1d4591a3b5ef',
      location: `TY负责人会话 jsonl ${example.match(/L\d+/g)?.join(' ') ?? '（见摘录）'}`,
      excerpt: example,
      captured_at: '2026-11-09T12:00:00+08:00',
    })),
    request_id: `ty-2026-11-09-${lesson.key}`,
  };
}

test('the TY lessons go in through the MCP, publish or await owner, reach a new round, and are revised with a counter-example', async (t) => {
  const app = await consoleApp(t);
  const ql = app.f.ledger.createProject({ name: 'QL' }, USER);
  const { token } = await issue(app, ['read', 'propose'], 'TY 负责人会话');
  const session = stdioServer(t, ['--url', app.url], { TYCHO_KNOWLEDGE_TOKEN: token });
  const lessons = lessonsOf(SYNTHETIC_SEED);
  assert.deepEqual(lessons.map(({ key }) => key), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11', 'E12']);

  // Submitted, each once: a retry of the whole batch makes nothing new.
  const ids = new Map<string, string>();
  for (const lesson of lessons) {
    const { text, isError } = await session.tool('propose_learning', proposalOf(lesson, ql));
    assert.equal(isError, false, `${lesson.key}：${text}`);
    ids.set(lesson.key, (JSON.parse(text) as { proposal_id: string }).proposal_id);
  }
  for (const lesson of lessons) {
    assert.equal((JSON.parse((await session.tool('propose_learning', proposalOf(lesson, ql))).text) as { duplicate: boolean }).duplicate, true);
  }
  assert.equal(app.f.ledger.listProposals().length, 12);

  // Project-scoped on-demand lessons publish immediately (unreviewed, no gate task);
  // global + resident lessons wait for owner confirmation in the console.
  for (const lesson of lessons) {
    const p = app.f.ledger.getProposal(ids.get(lesson.key)!);
    assert.equal(p.gate_task_id, null);
    assert.equal(p.state, projectOnly(lesson) ? 'published' : 'awaiting_owner');
  }
  const published = new Map<string, string>();
  for (const lesson of lessons) {
    const { state } = await through(app, ids.get(lesson.key)!);
    assert.equal(state, 'published');
    published.set(lesson.key, entryOf(app, ids.get(lesson.key)!));
  }
  assert.deepEqual(lessons.filter(projectOnly).map(({ key }) => key), ['E11', 'E12']);
  assert.deepEqual(app.f.ledger.reviewQueue().map(({ id }) => id), ['E11', 'E12'].map((key) => ids.get(key)), '点头过的不进待阅，自动生效的进');

  // The MCP takes a skill and coerces its loading to on_demand without throwing.
  const skill = await session.tool('propose_learning', { ...proposalOf(lessons[4]!, ql), kind: 'skill', request_id: 'ty-skill-perf' });
  assert.equal(skill.isError, false, skill.text);
  const skillProposalId = (JSON.parse(skill.text) as { proposal_id: string }).proposal_id;
  assert.equal(app.f.ledger.getProposal(skillProposalId).state, 'published');
  const skillEntry = app.f.ledger.getEntry(entryOf(app, skillProposalId))!;
  assert.deepEqual([skillEntry.kind, skillEntry.loading], ['skill', 'on_demand']);
  app.f.ledger.retireEntry(skillEntry.id, { reason: '测试后清理' }, { actor: 'console' });

  // A new round of a QL task carries them, global first, with their revisions.
  holdMachine(app.f.ledger, testMachine('h1'), USER);
  const login = app.f.login.login;
  app.f.ledger.setProjectLogins(ql, [login.id], USER);
  const launched: RunRow[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: app.f.ledger,
    runner: {
      findMachine: async (_login, machines) => machines[0],
      lostCandidates: () => [], presume: async () => 'unknown', sweep: async () => {},
      launch: async (run) => void launched.push(run),
      watch: async () => {},
    },
    logins: memoryLogins({ [login.id]: login }, app.f.ledger),
    machines: { get: (id) => app.f.ledger.getMachine(id), list: () => app.f.ledger.listMachines() },
    executors: { claude: claudeAdapter },
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  const task = app.f.ledger.createTask({ projectId: ql, title: '读历史逐笔为什么慢', goal: '找出慢在哪', acceptance: '给出闭合的分解', loginId: login.id, roleId: 'implement' }, USER);
  app.f.ledger.queueTask(task.id, USER);
  await dispatcher.tick();
  assert.equal(launched.length, 1, app.f.task(task.id).reason ?? '');
  const brief = (JSON.parse(app.f.run(launched[0]!.id).snapshot_json) as Snapshot).brief;
  for (const lesson of lessons) assert.ok(brief.includes(`${published.get(lesson.key)}@1`), `${lesson.key} 在 brief 里`);
  assert.ok(brief.indexOf(lessons[0]!.title) < brief.indexOf('## 按需知识') && brief.indexOf('## 按需知识') < brief.indexOf(lessons[10]!.title));
  // E11 and E12 are on demand: a catalog line in the brief, their text a file of the snapshot.
  const files = new Map(snapshotFiles(JSON.parse(app.f.run(launched[0]!.id).snapshot_json) as Snapshot).map(({ path, text }) => [path, text]));
  for (const key of ['E11', 'E12']) {
    const lesson = lessons.find((each) => each.key === key)!;
    assert.ok(!brief.includes(lesson.practice), `${key} 的正文不在 brief 里`);
    assert.ok(files.get(`knowledge/${published.get(key)}@1.md`)!.includes(lesson.practice), `${key} 的正文随快照送达`);
  }
  // The numbers of the failed tries are evidence, not rules.
  assert.ok(!brief.includes('7.92') && !brief.includes('48–67'));

  // A new session with none of TY's memory reads the method for its project...
  const context = JSON.parse((await session.tool('get_working_context', { project_id: ql, role_id: 'implement' })).text) as { global: { cite: string; body?: string }[]; project_knowledge: { cite: string; body?: string }[] };
  assert.equal(context.global.length + context.project_knowledge.length, 12);
  // Resident in full; on demand as a catalog line, its text by read_library.
  assert.ok(context.global.every(({ body }) => body !== undefined));
  assert.ok(context.project_knowledge.every(({ body }) => body === undefined));
  const e11 = JSON.parse((await session.tool('read_library', { id: published.get('E11')! })).text) as { body: string; loading: string };
  assert.deepEqual([e11.loading, e11.body.includes(lessons[10]!.practice)], ['on_demand', true]);
  // ...and hands a counter-example back: E6 is revised, not added to.
  const e6 = published.get('E6')!;
  const revised = await session.tool('propose_learning', {
    ...proposalOf(lessons[5]!, ql),
    inputs: [{ knowledge_id: e6, revision: 1, disposition: 'revise', note: '细化通过线的写法' }],
    outputs: [{ ...outputOf(lessons[5]!, ql), revises: e6, body: `${lessons[5]!.practice}\n\n修订二：通过线一律写成配对区间的上界，不写单次测得的倍数。` }],
    evidence: [{ source: 'conversation', ref: '5419629a-49a9-4730-b7ac-1d4591a3b5ef', location: 'TY负责人会话 jsonl L14914 L14938', excerpt: '把线收紧到“优于”，即配对区间上界 < 1.0' }],
    request_id: 'ty-2026-11-09-E6-r2',
  });
  assert.equal(revised.isError, false, revised.text);
  const revision = JSON.parse(revised.text) as { proposal_id: string };
  // E6 is global and resident: the revision waits for the owner too.
  assert.equal(app.f.ledger.getProposal(revision.proposal_id).state, 'awaiting_owner');
  assert.deepEqual(app.f.ledger.getProposal(revision.proposal_id).owner_reasons, ['global_resident']);
  const shown = app.f.ledger.getProposal(revision.proposal_id);
  assert.equal((await app.post(`/api/knowledge/proposals/${revision.proposal_id}/decide`, { decision: 'approve', digest: shown.final_digest })).status, 200);
  assert.equal(app.f.ledger.getEntry(e6)!.revision, 2);
  app.f.ledger.markRunRunning(launched[0]!.id);
  app.f.ledger.settleRun(launched[0]!.id, 0, DONE);
  app.f.ledger.reworkTask(task.id, '按新的判据再做一轮', app.f.task(task.id).revision, USER);
  await dispatcher.tick();
  const next = JSON.parse(app.f.run(launched[1]!.id).snapshot_json) as Snapshot;
  assert.ok(next.brief.includes(`${e6}@2`) && !next.brief.includes(`${e6}@1`));
  assert.ok(next.brief.includes('修订二：通过线一律写成配对区间的上界'));
  const read = JSON.parse((await session.tool('read_library', { id: e6, revision: 1 })).text) as { body: string; current_revision: number };
  assert.deepEqual([read.current_revision, read.body.includes('修订二')], [2, false], '旧修订原样可读');
});


test('MCP proposal acknowledgements do not grant a raw-report verification oracle or knowledge reads',async t=>{
  const app=await consoleApp(t),{run}=app.f.runningRun();
  app.f.ledger.settleRun(run.id,0,{...DONE,artifacts:[{kind:'report',ref:'最后一条消息'}]},{finalReply:'PRIVATE_RUN_REPORT_CANARY'});
  const retired=ownerEntry(app.f,{title:'PRIVATE_RETIRED_TITLE',body:'每次修改运行代码之前先保留原始结果并列出明确的验收标准，完成后独立检查失败条件、资源边界、上下文与版本，发现异常时记录证据再继续处理。迁移项目应冻结源端写入并核对目标服务身份，报告正文与摘要都需要验证绑定轮次及项目权限，最后才能把观察结论写入知识。',project_ids:[app.f.projectId]});
  app.f.ledger.retireEntry(retired,{reason:'PRIVATE_RETIREMENT_REASON',revision:1},{actor:'console'});
  const published=ownerEntry(app.f,{title:'公开给知识读者',body:'已发布知识正文'});
  const proposeOnly=await issue(app,['propose'],'只提议受理');
  assert.deepEqual(await call(app,proposeOnly.token,'read_library',{id:published}),{text:'这个令牌没有读取的授权',isError:true});
  const both=await issue(app,['read','propose'],'知识读者及提议者');
  const request=(excerpt:string)=>({outputs:[{title:'新的候选',when_to_use:'需要学习时',body:'每次修改运行代码之前先保留原始结果并列出明确的验收标准，完成后独立检查失败条件、资源边界、上下文与版本，发现异常时记录证据再继续处理。迁移项目应冻结源端写入并核对目标服务身份，报告正文与摘要都需要验证绑定轮次及项目权限，最后才能把观察结论写入知识。',project_ids:null,loading:'on_demand'}],why:WHY,evidence:[{source:'run',ref:run.id,location:'正式报告',excerpt},...EVIDENCE]});
  const proposals:string[]=[];
  for(const [token] of [[proposeOnly.token],[both.token]] as const){
    for(const excerpt of ['PRIVATE_RUN_REPORT_CANARY','NO_SUCH_REPORT_WORD']){
      const result=await call(app,token,'propose_learning',request(excerpt));
      assert.equal(result.isError,false);
      const ack=JSON.parse(result.text) as {proposal_id:string;state:string;evidence?:unknown;retired_matches?:unknown};
      assert.equal(ack.state,'published');
      assert.equal('evidence' in ack,false,'even a knowledge reader is not granted raw-task verification facts');
      assert.equal('retired_matches' in ack,false);
      assert.doesNotMatch(result.text,/PRIVATE_RETIRED_TITLE|PRIVATE_RETIREMENT_REASON/);
      proposals.push(ack.proposal_id);
      assert.equal(app.f.ledger.getProposal(ack.proposal_id).evidence[0]!.verified,excerpt==='PRIVATE_RUN_REPORT_CANARY','internal verification facts are preserved on the proposal');
    }
  }
  const read=await call(app,both.token,'read_library',{id:published});assert.equal(read.isError,false);assert.match(read.text,/已发布知识正文/);
  const gateMaterial=app.f.ledger.describeKnowledgeTask({kind:'gate',proposal_id:proposals[0]!,writers:['codex']});
  assert.ok(gateMaterial.projects.includes(app.f.projectId));
  const tool=createLibrary(app.f.ledger).find(tool=>tool.name==='propose_learning')!;
  const routerAck=JSON.parse(tool.run(request('PRIVATE_RUN_REPORT_CANARY'),{ctx:USER,proposer:{source:'router',by:'router',client:'router',writers:[],projectId:app.f.projectId}})) as {evidence:{verified:boolean}[]};
  assert.equal(routerAck.evidence[0]!.verified,true,'a Router with the original project read authority keeps its verification facts');
});

test('knowledge-mcp tools/list emits standard JSON Schema anyOf for nullable fields by default and preserves OpenAPI dialect when requested', async (t) => {
  const app = await consoleApp(t);
  const { token } = await issue(app, ['read', 'propose']);

  const hasNullableKey = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(hasNullableKey);
    if ('nullable' in node) return true;
    return Object.values(node).some(hasNullableKey);
  };

  // Standard MCP clients (Claude/Codex/Cursor): zero `nullable`, uses `anyOf: [..., { type: 'null' }]`.
  const standard = stdioServer(t, ['--url', app.url], { TYCHO_KNOWLEDGE_TOKEN: token, TYCHO_MCP_SCHEMA_DIALECT: '' });
  const stdRes = await standard.request('tools/list');
  const stdTools = stdRes.result.tools as Array<{ name: string; inputSchema: Record<string, any> }>;
  assert.equal(hasNullableKey(stdTools), false, 'knowledge-mcp default tools/list must have zero nullable keys');
  const stdPropose = stdTools.find((tool) => tool.name === 'propose_learning')!;
  const stdProjectIds = stdPropose.inputSchema.properties.outputs.items.properties.project_ids;
  assert.deepEqual(stdProjectIds.anyOf, [{ type: 'array', items: { type: 'string' } }, { type: 'null' }]);
  assert.equal(stdProjectIds.nullable, undefined);
  assert.ok(typeof stdProjectIds.description === 'string' && stdProjectIds.description.length > 0);

  // Gemini OpenAPI dialect preserves scalar type + nullable: true.
  const openApi = stdioServer(t, ['--url', app.url], { TYCHO_KNOWLEDGE_TOKEN: token, TYCHO_MCP_SCHEMA_DIALECT: 'openapi' });
  const gemRes = await openApi.request('tools/list');
  const gemTools = gemRes.result.tools as Array<{ name: string; inputSchema: Record<string, any> }>;
  const gemPropose = gemTools.find((tool) => tool.name === 'propose_learning')!;
  const gemProjectIds = gemPropose.inputSchema.properties.outputs.items.properties.project_ids;
  assert.equal(gemProjectIds.type, 'array');
  assert.equal(gemProjectIds.nullable, true);
  assert.equal(gemProjectIds.anyOf, undefined);
});
