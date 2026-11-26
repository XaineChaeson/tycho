// Guards against what only the real CLI can show: the proxy not being accepted as an
// MCP server, the tool list differing from what the fake reports, the Router not
// reaching the ledger through the whole chain, the real interrupt and resume not
// behaving as measured, and a tree left behind.
//
// Needs TYCHO_CLAUDE_CLI and TYCHO_ROUTER_TIER; skipped without them. Uses this
// machine's own login, so CLAUDE_CONFIG_DIR stays unset.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { knowledgeTokenStore } from '../service/secrets.ts';
import { createInbounds } from '../service/inbound.ts';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createAuth } from '../service/auth.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { createHttp, createStream } from '../service/http.ts';
import { openLedger } from '../service/ledger.ts';
import { hostProcesses } from '../service/processes.ts';
import { createSessionHost } from '../service/session-host.ts';
import type { RouterLaunch } from '../service/session-host.ts';
import { createSettings } from '../service/settings.ts';
import { claudeTier, HTTP_TUNED, NODES_TUNED, ROUTER_TUNED, tuned } from './helpers.ts';
import { createTools } from '../service/tools.ts';
import { createAccounts } from '../service/accounts.ts';
import { createLogins } from '../service/logins.ts';
import { createMachines } from '../service/machines.ts';
import { createNodes } from '../service/nodes.ts';
import { accepting, memoryLogins } from './helpers.ts';

const CLI = process.env.TYCHO_CLAUDE_CLI;
const TIER = process.env.TYCHO_ROUTER_TIER;
const TURN_MS = 120_000;
const options = { skip: CLI && TIER ? false : '没有设置 TYCHO_CLAUDE_CLI 和 TYCHO_ROUTER_TIER', timeout: 600_000 };
const LOGIN = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/t.json') } };

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + TURN_MS;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(100);
  }
}

test('the real Router reads and writes the ledger, stops when interrupted, and resumes', options, async (t) => {
  const stops: (() => Promise<unknown> | void)[] = [];
  t.after(async () => {
    for (const stop of stops.reverse()) await stop();
  });
  const dir = mkdtempSync(join(tmpdir(), 'tycho-live-'));
  stops.push(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = openLedger(join(dir, 'ledger.db'));
  stops.push(() => ledger.close());
  ledger.setWhitelist({ console: ['console'] }, { actor: 'test' });
  // A project's Router: the conversation is this project's.
  const projectId = ledger.createProject({ name: 'demo', logins: ['t1'] }, { actor: 'test' });

  const tools = createTools({
    ledger,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({ t1: LOGIN }),
    machines: createMachines({ ledger }),
    accept: accepting(ledger),
  });
  // Reads leave no change row, and §5.1 says they should not: this sees them instead.
  const called: string[] = [];
  const recording = {
    names: tools.names,
    list: tools.list,
    call: (name: string, args: unknown, ctx: { actor: string; messageId?: string }, here: { projectId: string }) => {
      called.push(name);
      return tools.call(name, args, ctx, here);
    },
  };
  const stream = createStream();
  const makeHost = () =>
    createSessionHost({ ...ROUTER_TUNED,
      ledger,
      dataDir: dir,
      // Typed, so a field RouterLaunch does not have is a compile error: a literal an arrow
      // returns is not checked for excess properties, and `tierFile` once went unnoticed here.
      launchWith: async (): Promise<RouterLaunch> => ({ claude: [CLI!], tier: claudeTier(TIER!) }),
      toolNames: tools.names,
      publish: stream.publish,
      turnTimeoutMs: tuned('router.turnTimeoutMs'),
    });
  let host = makeHost();
  const auth = createAuth({ ledger, linkTtlMs: tuned('login.linkTtlMs'), sessionDays: tuned('login.sessionDays'), temporarySessionMs: tuned('login.temporarySessionMs') });
  const http = createHttp({ ...HTTP_TUNED,
    ledger,
    tools: recording,
    accept: accepting(ledger),
    auth,
    // Nothing here asks about the machines that came back by themselves.
    nodes: createNodes({ ...NODES_TUNED, ledger, pollHoldMs: tuned('node.pollHoldMs'), commandTimeoutMs: tuned('node.commandTimeoutMs'), joinTtlMs: tuned('node.joinTtlMs'), gapSlackMs: tuned('node.gapSlackMs'), log: () => {} }),
    roundSnapshot: () => null,
    roundCredential: () => null,
    roundInvite: () => null,
    session: {
      admitTool: (token) => host.admitTool(token),
      toolTokens: () => host.toolTokens(),
      projectOfToken: (token) => host.projectOfToken(token),
      kick: () => host.kick(),
      interrupt: (projectId) => host.interrupt(projectId),
      status: () => host.status(),
      restart: () => host.restart(),
    },
    stream,
    backup: { status: () => ({ configured: false }), trigger: () => { throw new Error('本测试不备份'); } },
    settings: createSettings({ ledger }),
    accounts: createAccounts({ ledger, executors: { claude: claudeAdapter } }),
    logins: createLogins({ ledger, accounts: createAccounts({ ledger, executors: { claude: claudeAdapter } }), executors: { claude: claudeAdapter } }),
    machines: createMachines({ledger}),
    wecomSecret: { isSet: () => false, set() {} },
    knowledgeTokens: knowledgeTokenStore(dir),
    inbounds: createInbounds({ ledger, dataDir: dir, skewMs: () => 5 * 60_000, log: () => {} }),
    skillFolder: join(dir, 'skills'),
    doctor: async () => [],
    loginUrl: (path) => path,
    deployment: async () => [],
    loginToken: 'live-login-token',
    shutdownToken: 'live-shutdown-token',
    instance: () => ({}),
    releaseCheck: () => ({ ledger: 'ok', degraded: false, recovering: false, health_window_ms: 0 }),
    drain: async () => ({ drained: true, waited_ms: 0 }),
    releases: { dataDir: dir, version: '0.0.0', last: () => null, intent: () => null, attempting: () => false, launch: () => ({ started: true, version: '0.0.0' }) },
    onShutdown: () => {},
  });
  const port = await http.listen(0, '127.0.0.1');
  stops.push(() => http.close());
  stops.push(() => host.stop());

  const cookie = auth.login(auth.createLink().credential)!.split(';')[0]!;
  const post = async (text: string): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ text, project_id: projectId }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { id: string }).id;
  };
  const state = (id: string) => ledger.getMessage(id).state;
  const settled = (id: string) =>
    until(() => (state(id) === 'processed' || state(id) === 'unverified') && state(id), `消息 ${id} 收尾`);
  const reply = (id: string) => ledger.listMessages({ limit: 200 }).find((row) => row.external_id === `reply:${id}`);

  await host.start(port);

  const first = await post('列出所有任务，然后在这个项目里建一个分析任务“看看 demo”，验收是写一句结论。做完用一句话告诉我结果。');
  assert.equal(await settled(first), 'processed');
  assert.equal(host.status().error, null);
  assert.ok(called.includes('list_tasks'), `调用了：${called.join(', ')}`);
  assert.deepEqual(
    ledger
      .listChanges({ messageId: first })
      .map((change) => change.action)
      .filter((action) => action === 'task.create'),
    ['task.create'],
  );
  assert.equal(ledger.listTasks({ projectId })[0]?.project_id, projectId);
  assert.equal(reply(first)?.final, 1);
  assert.ok(reply(first)?.text.trim());
  const session = ledger.currentContext(ledger.listProjects()[0]?.id ?? '')!;
  assert.equal(session.session_ref, session.marker);
  const pid = host.status().pid;
  // The root and the MCP proxy it started: an orphaned proxy has to be findable too.
  const tree = await hostProcesses.find(session.marker);
  assert.equal(tree.length, 2, `标记找到：${tree.join(', ')}`);
  assert.ok(tree.includes(pid!));

  const long = await post('从 1 数到 3000，每个数字单独一行，不要省略。');
  await until(() => reply(long), '中间稿');
  assert.equal(host.interrupt(), true);
  assert.equal(await settled(long), 'unverified');
  assert.equal(reply(long)?.final, 0);

  const after = await post('只回复两个字：还在');
  assert.equal(await settled(after), 'processed');
  assert.equal(host.status().pid, pid);

  await host.stop();
  assert.deepEqual(await hostProcesses.find(session.marker), []);
  assert.equal(ledger.currentContext(ledger.listProjects()[0]?.id ?? '')?.id, session.id);

  host = makeHost();
  await host.start(port);
  const resumed = await post("刚才建的任务标题里提到的英文词是什么？只回复那个词。");
  assert.equal(await settled(resumed), 'processed');
  assert.equal(host.status().error, null);
  assert.match(reply(resumed)!.text, /demo/);
  assert.equal(ledger.currentContext(ledger.listProjects()[0]?.id ?? '')?.session_ref, session.session_ref);
});
