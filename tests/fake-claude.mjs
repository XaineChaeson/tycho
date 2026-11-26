// Stands in for `claude -p --input-format stream-json` with the behaviour measured
// from the real CLI: init comes with each user turn, never before the first one, a
// --resume of a session that does not exist fails by itself, without any turn, and an
// interrupt is answered as fixtures/claude/2.1.309-win/control-interrupt.ndjson shows:
// a control_response first, then a result with no text; with no turn running, the
// control_response alone.
//
// FAKE_CLAUDE_LOG      file that receives one JSON line per thing that happened
// FAKE_CLAUDE_TOOLS    JSON array reported as init.tools beside the built-in tools --tools
//                      names, which the real CLI reports too (docs/spike/router-readonly.md;
//                      it sorts them, and the host compares sets). Permissions are not played:
//                      only the switches the host starts it with are checked
// FAKE_CLAUDE_RESUME   with --resume: exit | error | silent
// FAKE_CLAUDE_HOLD_OVERVIEW  the overview (recovery material) turn waits for the interrupt
// FAKE_CLAUDE_CONTROL  how an interrupt is answered: success (default), replay (the
//                      recording itself), reject (not recorded: the shape follows the
//                      success one), result-first, silent (result but no confirmation),
//                      wrong-id, no-result (confirmed, then nothing)
// FAKE_CLAUDE_CHILD    what to start next to itself: sleeper (a marked process that
//                      outlives this one) | orphan (the same, detached: without that,
//                      Windows ends it along with the service that started this one;
//                      on POSIX it leaves this one's process group for its own)
//                      | proxy (the real MCP server of --mcp-config)
// Text of a turn:      长回合 (waits for the interrupt), 不理会 (ignores the interrupt),
//                      崩溃 (exits mid turn), 出错 (is_error), 流式 (many deltas),
//                      无话可说 (an empty result),
//                      调工具 (text and tool calls, paced, one failing; the blocks as
//                      adapters/claude.ts reads them, the result only the last text),
//                      回显令牌 (a login the API refuses, with the token the process was
//                      given written back on stderr and in the result line: not recorded,
//                      and not something the real CLI is known to do),
//                      额度用完 (a used-up quota, status 429),
//                      报额度 (a rate-limit line as 2.1.309 writes it, then a plain answer)
//
// FAKE_CLAUDE_LOGIN_LOST  a file: while it exists every turn, the overview included, ends
//                      in the result line of a login the API no longer takes (is_error,
//                      api_error_status 401, "Invalid API key · Please run /login"). Not
//                      recorded: the shape is the one adapters/claude.ts classifies as auth.
//
// FAKE_CLAUDE_EXPECT_TOKEN  the login token the Router's account holds. What this process
//                      got is recorded as `token_ok` — whether it is that one — and never
//                      as the value: a log that carried it would be the leak itself.
//
// `auth status` instead of a session answers the way the CLI's documentation describes:
// one JSON object with loggedIn, exit 0 signed in and 1 signed out. It is logged without
// argv, so it does not count as a Router start, and with the login directory and the
// Router marker its environment held.
// FAKE_CLAUDE_AUTH     in (default) | out | old (a CLI that does not know the command)
//                      | hang (never answers)
//
// A process that is alive with its stdin closed is fake-claude-no-stdin.ps1 on Windows
// and fake-claude-no-stdin.sh elsewhere.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const tokenCheck = () => (process.env.FAKE_CLAUDE_EXPECT_TOKEN === undefined
  ? {}
  : { token_ok: process.env.CLAUDE_CODE_OAUTH_TOKEN === process.env.FAKE_CLAUDE_EXPECT_TOKEN });

if (argv[0] === 'auth' && argv[1] === 'status') {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? 'in';
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({
      auth,
      config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
      marker_env: process.env.TYCHO_ROUTER_MARKER ?? null,
      ...tokenCheck(),
    })}\n`);
  }
  if (auth === 'hang') await new Promise(() => setInterval(() => {}, 1000));
  if (auth === 'old') {
    console.error("error: unknown command 'auth'");
    process.exit(1);
  }
  console.log(JSON.stringify(auth === 'in'
    ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner@example.com' }
    : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));
  process.exit(auth === 'in' ? 0 : 1);
}
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const resume = flag('--resume');
const mode = resume ? process.env.FAKE_CLAUDE_RESUME : undefined;
const control = process.env.FAKE_CLAUDE_CONTROL ?? 'success';
const sessionId = resume ?? flag('--session-id');
const builtins = (flag('--tools') ?? '').split(',').filter((name) => name !== '');
const tools = [...builtins, ...JSON.parse(process.env.FAKE_CLAUDE_TOOLS ?? '[]')];
const RECORDED = new URL('./fixtures/claude/2.1.309-win/control-interrupt.ndjson', import.meta.url);

const record = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);
const delta = (text) =>
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = (text, isError = false, subtype = 'success') =>
  emit({ type: 'result', subtype, is_error: isError, result: text });

record({
  argv,
  cwd: process.cwd(),
  pid: process.pid,
  nested: Object.keys(process.env).filter((name) => /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_)/.test(name)),
  config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
  marker_env: process.env.TYCHO_ROUTER_MARKER ?? null,
  git_optional_locks: process.env.GIT_OPTIONAL_LOCKS ?? null,
  ...tokenCheck(),
});

function mcpServer() {
  const config = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.tycho;
  return { config, marker: config.args[config.args.indexOf('--marker') + 1] };
}

function startChild(kind) {
  const { config, marker } = mcpServer();
  const child =
    kind === 'proxy'
      ? spawn(config.command, config.args, { env: { ...process.env, ...config.env } })
      : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--marker', marker], {
          stdio: 'ignore',
          windowsHide: true,
          detached: kind === 'orphan',
        });
  record({ child: child.pid });
}

if (process.env.FAKE_CLAUDE_CHILD) startChild(process.env.FAKE_CLAUDE_CHILD);

if (mode === 'exit') {
  result('', true, 'error_during_execution');
  process.exit(1);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assistantBlock = (block) => emit({ type: 'assistant', message: { role: 'assistant', content: [block] } });
const userBlock = (block) => emit({ type: 'user', message: { role: 'user', content: [block] } });

async function toolTurn() {
  delta('我查一下');
  await pause(230);
  const call = { type: 'tool_use', id: 't1', name: 'mcp__tycho__list_tasks', input: {} };
  assistantBlock(call);
  // A repeat of the same block is one call.
  assistantBlock(call);
  await pause(120);
  userBlock({ type: 'tool_result', tool_use_id: 't1', content: 'ok' });
  await pause(120);
  delta('，查到了');
  await pause(230);
  assistantBlock({ type: 'tool_use', id: 't2', name: 'mcp__tycho__create_task', input: {} });
  await pause(120);
  userBlock({ type: 'tool_result', tool_use_id: 't2', content: 'no', is_error: true });
  await pause(120);
  delta('最后这句');
  await pause(230);
  result('最后这句');
}

let waiting = false;
let ignoring = false;
let firstTurn = true;
const loginLost = () => Boolean(process.env.FAKE_CLAUDE_LOGIN_LOST) && existsSync(process.env.FAKE_CLAUDE_LOGIN_LOST);

function turn(text) {
  const first = firstTurn;
  firstTurn = false;
  if (first && mode === 'silent') return;
  emit({ type: 'system', subtype: 'init', tools });
  if (first && mode === 'error') return result('No conversation found', true);
  if (loginLost()) {
    return emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key · Please run /login' });
  }
  if (process.env.FAKE_CLAUDE_HOLD_OVERVIEW && text.includes('从账本重建')) {
    waiting = true;
    return undefined;
  }
  // The recovery material quotes the owner's earlier words: none of them is a turn's command.
  if (text.includes('从账本重建')) {
    delta('好');
    return result('');
  }
  if (text.includes('崩溃')) {
    delta('开始');
    setTimeout(() => process.exit(3), 20);
    return undefined;
  }
  if (text.includes('出错')) return result('出错了', true);
  // A used-up quota, as the CLI reports one: the account has to rest.
  if (text.includes('额度用完') && !text.includes('从账本重建')) {
    return emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your limit · resets 5pm" });
  }
  // How much of the login's quota is used, in the shape of tests/fixtures/claude/2.1.309-win.
  if (text.includes('报额度') && !text.includes('从账本重建')) {
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.63, resetsAt: 1793795400 }, seven_day: { utilization: 0.66, resetsAt: 1794081600 } } } });
    return result('读到了');
  }
  // Diagnostics that carry the token: what must never reach a log, a page or a notice.
  if (text.includes('回显令牌') && !text.includes('从账本重建')) {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
    process.stderr.write(`Auth failed: ${token}\n`);
    return emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: `Invalid API key: ${token}` });
  }
  if (text.includes('长回合') || text.includes('不理会')) {
    delta('开始做');
    waiting = text.includes('长回合');
    ignoring = !waiting;
    return undefined;
  }
  if (text.includes('无话可说') && !text.includes('从账本重建')) return result('');
  // A call's message carries the context it was made with, in the shape of
  // tests/fixtures/claude/2.1.312-linux/tools.ndjson: 2 + 14738 + 11383 = 26123 tokens.
  if (text.includes('上下文很长') && !text.includes('从账本重建')) {
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好' }], usage: { input_tokens: 2, cache_creation_input_tokens: 14738, cache_read_input_tokens: 11383, output_tokens: 5 } } });
    return result('读完了');
  }
  if (text.includes('调工具') && !text.includes('从账本重建')) {
    void toolTurn();
    return undefined;
  }
  if (text.includes('流式')) {
    for (let index = 0; index < 5; index += 1) delta('字'.repeat(40));
    return result('终稿');
  }
  delta('好');
  return result(`回复：${text.slice(0, 20)}`);
}

// From the recorded confirmation through the recorded result, with this request's id.
function replayInterrupt(id) {
  const events = readFileSync(RECORDED, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const from = events.findIndex((event) => event.type === 'control_response');
  const to = events.findIndex((event) => event.type === 'result');
  events[from].response.request_id = id;
  for (const event of events.slice(from, to + 1)) process.stdout.write(`${JSON.stringify(event)}\n`);
  waiting = false;
}

function answerInterrupt(id) {
  const confirm = (requestId = id) =>
    process.stdout.write(
      `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { still_queued: [] } } })}\n`,
    );
  const reject = () =>
    process.stdout.write(
      `${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'refused' } })}\n`,
    );
  const end = () => {
    if (!waiting) return;
    waiting = false;
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true });
  };
  if (control === 'replay') return replayInterrupt(id);
  if (control === 'reject') return reject();
  if (control === 'silent') return end();
  if (control === 'wrong-id') {
    confirm('someone-else');
    return end();
  }
  if (control === 'no-result') return confirm();
  if (control === 'result-first') {
    end();
    return setTimeout(confirm, 50);
  }
  confirm();
  return end();
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    record({ control: message.request.subtype });
    // Not answering at all is what 不理会 stands for.
    if (!ignoring) answerInterrupt(message.request_id);
    return;
  }
  const { text } = message.message.content[0];
  record({ user: text });
  turn(text);
});
