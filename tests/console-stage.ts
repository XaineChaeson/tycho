// The whole service for the console's browser smoke test (console/e2e), started as a
// process of its own: a real ledger in a scratch data directory, the fake CLI as the
// Router, a fake instance for the Workers, on whatever port is free. Nothing of the
// owner's is touched: not ~/.tycho, not a service already running on this machine.
// It holds work in the states the pages have to show, prints one JSON line saying where
// it listens and a login link, and runs until its stdin closes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../service/ledger.ts';
import { startService } from '../service/main.ts';
import { windowsCommandLine } from '../service/ptybridge.ts';
import { createTools } from '../service/tools.ts';
import { fakeRemote } from './fake-remote.ts';
import { machineLogin, memoryLogins, noAccept, OUTPUT_AVAILABLE, seed, signedInEverywhere, testMachine } from './helpers.ts';
import { LOGIN, MACHINE, until } from './stage.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
// The stand-in for `claude setup-token`: the code it takes and the token it prints.
const FAKE_LOGIN = join(import.meta.dirname, 'fake-claude-login.mjs');
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://api.anthropic.com') return nativeFetch(input, init);
  if (url.pathname === '/v1/models') {
    return Promise.resolve(Response.json({ data: [{ id: '<模型名>', display_name: '<模型名>' }] }));
  }
  if (url.pathname === '/v1/messages') {
    return Promise.resolve(Response.json({}, { headers: { 'anthropic-ratelimit-unified-7d-utilization': '0.5' } }));
  }
  return Promise.reject(new Error(`Unexpected Anthropic request in smoke test: ${url.pathname}`));
};
export const STAGE_LOGIN_CODE = 'smoke-code#smoke-state';
const USER = { actor: 'test' };
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const said = (text: string): string => line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const toolCall = (id: string, name: string, input: object = {}): string => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolDone = (id: string, failed = false): string => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: failed }] } });

const dataDir = mkdtempSync(join(tmpdir(), 'tycho-console-e2e-'));
const remote = fakeRemote();
const tools = createTools({
  ledger: undefined as never,
  runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
  logins: memoryLogins({}),
  machines: undefined as never,
  accept: noAccept,
});
Object.assign(process.env, {
  FAKE_CLAUDE_LOG: join(dataDir, 'fake.log'),
  FAKE_CLAUDE_TOOLS: JSON.stringify(tools.names.map((name) => `mcp__tycho__${name}`)),
});
const otherLogin = machineLogin('h2', 'claude', { tiers: LOGIN.tiers });
const ownLogin = { ...LOGIN };
const initial = openLedger(join(dataDir, 'ledger.db'));
try {
  initial.joinMachine({
    id: MACHINE.id, host: MACHINE.host, nodeId: MACHINE.nodeId!, tokenHash: 'token-of-node-h1',
    local: true, platform: 'test', source: null, ephemeral: false,
  }, USER);
} finally {
  initial.close();
}
seed(dataDir, { machines: { h1: MACHINE, h2: testMachine('h2') }, logins: { first: ownLogin, second: otherLogin } });

const service = await startService({
  dataDir,
  claude: [process.execPath, FAKE],
  claudeLogin: {
    commandLine: () => windowsCommandLine([process.execPath, FAKE_LOGIN]),
    env: () => ({ ...process.env, FAKE_LOGIN_GOOD: STAGE_LOGIN_CODE, FAKE_LOGIN_TOKEN: `sk-ant-oat01-${'smokeToken_'.repeat(8)}` }),
  },
  port: 0,
  connect: remote.connect,
  reportedExecutors: signedInEverywhere(),
  reportedOutput: () => OUTPUT_AVAILABLE,
  dispatchIntervalMs: 20,
  watchIntervalMs: 20,
  outboxIntervalMs: 20,
  stopWaitMs: 2000,
  // This process runs outside the test guard: the host's own global entry is written under
  // the scratch directory, never where the owner's executors read (knowledge §4.3).
  globalEntry: { home: join(dataDir, 'home'), env: { CLAUDE_CONFIG_DIR: join(dataDir, 'home', '.claude'), CODEX_HOME: join(dataDir, 'home', '.codex'), DSH_HOME: join(dataDir, 'home', '.dsh'), DSH_AGENTS_HOME: join(dataDir, 'home', '.agents') } },
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await service.stop();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.stdin.on('end', () => void stop());
process.stdin.on('close', () => void stop());
process.stdin.resume();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop());

try {
  const { ledger } = service;
  // Two logins in the project, so its order is something the owner can see and change.
  const projectId = ledger.createProject({ name: '试跑', logins: [ownLogin.id, otherLogin.id] }, USER);
  const task = (title: string, parentId?: string) =>
    ledger.createTask({ projectId, title, goal: `把“${title}”做完。\n\n- 先看现状\n- 再动手`, acceptance: '`npm test` 通过', loginId: ownLogin.id, roleId: 'implement', ...(parentId ? { parentId } : {}) }, USER);
  const launched = (taskId: string) => until(() => {
    const run = ledger.listRuns(taskId).at(-1);
    return run && remote.called('start.sh', run.id) > 0 && ledger.getRun(run.id).state === 'running' && run;
  }, `任务 ${taskId} 启动`);

  // A work with two tasks: one has reported and waits to be accepted, one waits for the owner.
  const work = task('发布新控制台');
  const request = ledger.receiveMessage({ channel: 'console', externalId: 'smoke-tool-trace', actor: 'console', text: '整理设计变量', projectId });
  const traceCall = 'smoke-create-task-call';
  ledger.startRouterCall({ id: traceCall, projectId, messageId: request.id, messageIds: [request.id], contextId: null, name: 'create_task', request: '{"title":"整理设计变量"}' });
  const ctx = { actor: 'router', messageId: request.id, toolCallId: traceCall };
  const reported = ledger.transaction(() => {
    const created = ledger.createTask({ projectId, parentId: work.id, title: '整理设计变量', goal: '把“整理设计变量”做完。\n\n- 先看现状\n- 再动手', acceptance: '`npm test` 通过', loginId: ownLogin.id, roleId: 'implement' }, ctx);
    ledger.queueTask(created.id, ctx);
    return created;
  });
  ledger.finishRouterCall(traceCall, 'interrupted', null);
  const first = await launched(reported.id);
  // Exercise the real final-report endpoint with content whose intrinsic width exceeds
  // both the desktop drawer and a phone. Tables and fenced code must scroll locally.
  const reportPath = '/home/researcher/' + 'project_without_breaks_'.repeat(12) + '/report.md';
  const reportText = [
    '# 宽度验收报告',
    '普通段落应在报告抽屉内换行，不能跟着表格撑宽。'.repeat(8),
    `不间断路径：\`${reportPath}\`。`,
    '| 节点 | 文件路径 | 证据 | 最后一列 |\n|---|---|---|---|\n' + `| Linux | \`${reportPath}\` | ${'proof_without_breaks_'.repeat(12)} | 表格末列可读 |`,
    '\`\`\`text\n' + reportPath + '\n\`\`\`',
    '报告末段可完整阅读。',
  ].join('\n\n');
  const reportReceipt = { status: 'done', summary: '颜色、字号、圆角整理成了**一套变量**。', artifacts: [{ kind: 'commit', ref: 'abc1234' }, { kind: 'report', ref: '最后一条消息' }] };
  Object.assign(remote.runOf(first.id), {
    stdout: said('先看现有的样式。') + toolCall('a', 'Read') + toolDone('a') + toolCall('b', 'Bash') + toolDone('b', true) + said('变量整理好了。')
      + line({ type: 'result', is_error: false, result: reportText + '\n\n\`\`\`receipt\n' + JSON.stringify(reportReceipt) + '\n\`\`\`', session_id: 'worker-session' }),
    exit: 0, pid_alive: false, marked: false, launcher_alive: false,
  });
  await until(() => ledger.getTask(reported.id).state === 'ready', '第一个子任务汇报');
  const asking = task('写冒烟测试', work.id);
  // Queued and asked in one step: the dispatcher never sees it waiting for a machine.
  ledger.queueTask(asking.id, USER);
  // One option is a whole sentence with a machine's name in it: as long as a Worker may write one.
  ledger.openApproval(asking.id, [{
    question: '冒烟用哪个浏览器？', about: '机器上已经装了 Edge', recommend: 0,
    options: ['Edge', 'Chrome', '两个都跑：先用这台机器上已经装好的 Edge 跑一遍，再到 gpu-worker-03.research-cluster.internal 上用 Chrome 重跑同样的用例，结果分开记'],
  }], USER);

  // Text with nowhere to break: a branch for a title, a path in the reason it stopped for.
  const long = task('feature/console-frontend-rewrite-with-a-branch-name-that-has-no-spaces-anywhere-in-it');
  // Queued and stopped in one step, as above: it is never dispatched.
  ledger.queueTask(long.id, USER);
  ledger.holdTask(long.id, '读不到 /home/researcher/projects/tycho-console/console/node_modules/.vite/deps/_metadata.json', USER);

  // A work that is its own task, at work right now.
  const running = task('修登录页的提示');
  ledger.queueTask(running.id, USER);
  const second = await launched(running.id);
  // A table in what it says, and a command too long for a phone that failed: neither may
  // widen the page, and the failure reads by its state, kept on one line.
  const table = '\n\n| 文件 | 说明 |\n|---|---|\n| `console/src/pages/login_page_with_a_file_name_long_enough_to_overflow_a_phone.tsx` | 登录页 |\n\n';
  const command = 'npm --prefix console run test -- --reporter=verbose src/pages/login.test.tsx src/pages/device-login.test.tsx';
  remote.runOf(second.id).stdout = said(`在看登录页。${table}`) + toolCall('d', 'Bash', { command }) + toolDone('d', true) + toolCall('c', 'Grep');

  console.log(JSON.stringify({
    url: `http://127.0.0.1:${service.port}`,
    project: projectId,
    login: ('/login#' + service.auth.createLink().credential),
    work: work.id,
    reported: reported.id,
    running: running.id,
    long: long.id,
  }));
} catch (error) {
  console.error(error);
  await service.stop();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
