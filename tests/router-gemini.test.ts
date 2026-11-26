import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deploymentFacts, doctor } from '../service/doctor.ts';
import { classifyStopReason, extractReportedTools, shouldAllowPermission } from '../service/router-gemini.ts';
import { SETTINGS } from '../service/settings.ts';

const BRIDGE = fileURLToPath(new URL('../service/router-gemini.ts', import.meta.url));

function writeMockAcpServer(dir: string): string {
  const script = join(dir, 'mock-agy.mjs');
  writeFileSync(script, `
import { createInterface } from 'node:readline';
const mode = process.env.MOCK_MODE || 'normal';
const seen = {
  argv: process.argv.slice(2),
  geminiKey: process.env.GEMINI_API_KEY || null,
  baseUrl: process.env.GOOGLE_GEMINI_BASE_URL || null,
  leakedSecret: process.env.ANTHROPIC_API_KEY || process.env.CODEX_API_KEY || null,
  methods: [],
  permissions: [],
  cancelled: false,
};
const write = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
let permReqId = 900;
const permResolvers = new Map();

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method && permResolvers.has(msg.id)) {
    const fn = permResolvers.get(msg.id);
    permResolvers.delete(msg.id);
    fn(msg.result);
    return;
  }
  seen.methods.push(msg.method);
  if (msg.method === 'initialize') {
    write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (msg.method === 'session/new' || msg.method === 'session/load') {
    if (mode === 'auth_fail_init') {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required secret=DO_NOT_LEAK' } });
      return;
    }
    if (mode === 'extra_tools') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: msg.params.sessionId || 'gem-sess-extra',
          tools: ['mcp_tycho_list_tasks', 'mcp_tycho_reply', 'mcp_rogue_shell'],
        },
      });
      return;
    }
    if (mode === 'mcp_failed') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: msg.params.sessionId || 'gem-sess-fail',
          mcpServers: [{ name: 'tycho', status: 'failed', error: 'connection refused' }],
        },
      });
      return;
    }
    seen.sessionParams = msg.params;
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: msg.params.sessionId || 'gem-sess-1',
        models: {
          currentModelId: 'gemini-3.8-flash-medium',
          availableModels: [{ modelId: 'gemini-3.8-flash-medium' }, { modelId: 'gemini-3.8-flash-high' }],
        },
        configOptions: [
          { id: 'model', options: [{ value: 'gemini-3.8-flash' }] },
          { id: 'thought_level', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
        ],
      },
    });
    return;
  }
  if (msg.method === 'session/set_config_option' || msg.method === 'session/set_model') {
    seen.configCalls = (seen.configCalls || []).concat([msg.params]);
    write({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/cancel') {
    seen.cancelled = true;
    return;
  }
  if (msg.method === 'session/prompt') {
    if (mode === 'quota_fail') {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: 429, message: 'RESOURCE_EXHAUSTED key=AIzaSecretLeak' } });
      return;
    }
    if (mode === 'max_tokens' || mode === 'max_turn_requests') {
      const sid = msg.params.sessionId;
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial truncated answer' } },
        },
      });
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          stopReason: mode,
          usage: { inputTokens: 200, outputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0 },
        },
      });
      return;
    }
    if (mode === 'cancel') {
      setTimeout(() => {
        write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: seen.cancelled ? 'cancelled' : 'end_turn' } });
      }, 120);
      return;
    }
    const sid = msg.params.sessionId;
    const askPerm = (toolCall) => new Promise((resolve) => {
      const id = ++permReqId;
      permResolvers.set(id, resolve);
      write({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId: sid,
          toolCall,
          options: [
            { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
            { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
    });
    (async () => {
      const p1 = await askPerm({ toolCallId: 'tc-1', title: 'mcp_tycho_list_tasks', kind: 'other' });
      const p2 = await askPerm({ toolCallId: 'tc-2', title: 'run_command', kind: 'execute' });
      seen.permissions.push({ tycho: p1, exec: p2 });
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'mcp_tycho_list_tasks', args: { state: 'open' } } } });
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: '[]' } } });
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } });
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(seen) } } } });
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 25, cachedReadTokens: 30, cachedWriteTokens: 5 },
        },
      });
    })();
  }
});
`);
  return script;
}

function runBridge(configPath: string, extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, [BRIDGE, '--marker', 'test-marker', '--config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  const lines: Record<string, any>[] = [];
  const waiters: Array<() => void> = [];
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(JSON.parse(line));
    for (const fn of waiters.splice(0)) fn();
  });
  const waitFor = async (pred: (list: Record<string, any>[]) => boolean): Promise<Record<string, any>[]> => {
    const deadline = Date.now() + 5000;
    while (!pred(lines)) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for bridge output; got=${JSON.stringify(lines)} stderr=${stderr}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        waiters.push(() => { clearTimeout(t); resolve(); });
      });
    }
    return lines;
  };
  return { child, lines, waitFor, getStderr: () => stderr };
}

test('router-gemini bridges ACP lifecycle, permissions, tool names, usage, and secret scrubbing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-router-gemini-'));
  try {
    const mock = writeMockAcpServer(dir);
    const home = join(dir, 'managed-home');
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, mock],
      prompt: 'SYSTEM PROMPT',
      tools: ['list_tasks', 'reply'],
      mcp: { command: process.execPath, args: ['proxy.ts'], env: { TYCHO_TOOLS_PORT: '9999', TYCHO_TOOLS_TOKEN: 'tok' } },
      model: 'gemini-3.8-flash',
      effort: 'high',
      managedHome: home,
      baseUrl: 'https://gemini-proxy.example.com',
    }));

    const { child, waitFor } = runBridge(cfg, {
      GEMINI_API_KEY: 'AIzaTestKey123',
      ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
      CODEX_API_KEY: 'sk-codex-should-not-leak',
    });

    await waitFor((list) => list.some((e) => e.type === 'system' && e.subtype === 'init'));
    const init = (await waitFor((list) => list.length >= 1)).find((e) => e.type === 'system')!;
    assert.deepEqual(init.tools, ['mcp__tycho__list_tasks', 'mcp__tycho__reply']);
    assert.equal(init.session_id, 'gem-sess-1');

    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'check tasks' }] } }) + '\n');
    const events = await waitFor((list) => list.some((e) => e.type === 'result'));
    child.stdin.end();

    const toolUse = events.find((e) => e.type === 'assistant');
    assert.equal(toolUse?.message?.content?.[0]?.name, 'mcp__tycho__list_tasks');
    const toolResult = events.find((e) => e.type === 'user');
    assert.equal(toolResult?.message?.content?.[0]?.tool_use_id, 'tc-1');
    assert.equal(toolResult?.message?.content?.[0]?.is_error, false);

    const deltas = events.filter((e) => e.type === 'stream_event').map((e) => e.event.delta.text).join('');
    assert.ok(deltas.startsWith('Hello '));
    const seen = JSON.parse(deltas.slice('Hello '.length));
    assert.equal(seen.geminiKey, 'AIzaTestKey123');
    assert.equal(seen.baseUrl, 'https://gemini-proxy.example.com');
    assert.equal(seen.leakedSecret, null);
    assert.ok(seen.argv.includes('--gemini-dir'));
    assert.ok(seen.argv.includes(home));
    assert.equal(seen.sessionParams._meta.antigravity.systemPrompt.append, 'SYSTEM PROMPT');
    assert.deepEqual(seen.sessionParams.mcpServers[0].env, [
      { name: 'TYCHO_TOOLS_PORT', value: '9999' },
      { name: 'TYCHO_TOOLS_TOKEN', value: 'tok' },
      { name: 'TYCHO_MCP_SCHEMA_DIALECT', value: 'openapi' },
    ]);
    assert.deepEqual(seen.configCalls, [
      { sessionId: 'gem-sess-1', configId: 'model', value: 'gemini-3.8-flash' },
      { sessionId: 'gem-sess-1', configId: 'thought_level', value: 'high' },
    ]);
    assert.equal(seen.permissions[0].tycho.outcome.optionId, 'allow-1');
    assert.equal(seen.permissions[0].exec.outcome.optionId, 'allow-1');

    const result = events.find((e) => e.type === 'result')!;
    assert.equal(result.is_error, false);
    assert.deepEqual(result.usage, {
      input_tokens: 70,
      output_tokens: 25,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router-gemini supports resume, interrupt cancellation, and redacts quota errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-router-gemini-int-'));
  try {
    const mock = writeMockAcpServer(dir);
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, mock],
      prompt: 'SYSTEM PROMPT',
      resume: 'prev-session-42',
      tools: ['reply'],
      mcp: { command: process.execPath, args: ['proxy.ts'], env: {} },
    }));

    const cancelRun = runBridge(cfg, { MOCK_MODE: 'cancel' });
    const initEvents = await cancelRun.waitFor((list) => list.some((e) => e.type === 'system'));
    assert.equal(initEvents[0]!.session_id, 'prev-session-42');
    cancelRun.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'slow' }] } }) + '\n');
    cancelRun.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'req-1', request: { subtype: 'interrupt' } }) + '\n');
    const cancelEvents = await cancelRun.waitFor((list) => list.some((e) => e.type === 'result'));
    cancelRun.child.stdin.end();
    assert.ok(cancelEvents.some((e) => e.type === 'control_response' && e.response.request_id === 'req-1' && e.response.subtype === 'success'));
    const cancelResult = cancelEvents.find((e) => e.type === 'result')!;
    assert.equal(cancelResult.is_error, true);
    assert.equal(cancelResult.result, 'Gemini turn cancelled');

    const quotaRun = runBridge(cfg, { MOCK_MODE: 'quota_fail' });
    await quotaRun.waitFor((list) => list.some((e) => e.type === 'system'));
    quotaRun.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'quota' }] } }) + '\n');
    const quotaEvents = await quotaRun.waitFor((list) => list.some((e) => e.type === 'result'));
    quotaRun.child.stdin.end();
    const quotaResult = quotaEvents.find((e) => e.type === 'result')!;
    assert.equal(quotaResult.is_error, true);
    assert.equal(quotaResult.result, 'Gemini usage limit reached');
    assert.ok(!quotaResult.result.includes('AIzaSecretLeak'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor and deploymentFacts render gemini router status cleanly', () => {
  const settings = { get: (key: keyof typeof SETTINGS) => SETTINGS[key].default };
  const checks = doctor({
    dataDir: process.cwd(),
    settings: settings as any,
    claude: { path: '/usr/local/bin/agy', command: ['/usr/local/bin/agy'], problem: null, login: null },
    logins: [{ id: 'g1', name: 'Gemini Lead', executor: 'gemini' }],
    routerLogin: {
      executor: 'gemini',
      account: 'Gemini Lead',
      token: true,
      geminiHealth: { level: 'ok', text: 'agy 命令可用，使用托管 Gemini API 密钥' },
    },
    wecomSecretSet: false,
  });
  const gem = checks.find((c) => c.id === 'gemini-router');
  assert.ok(gem);
  assert.equal(gem.level, 'ok');
  assert.equal(gem.title, '负责人的 Gemini');

  const facts = deploymentFacts({
    dataDir: '/data',
    listening: { host: '127.0.0.1', port: 8799 },
    claude: { path: '/home/lighthouse/.local/bin/agy', command: ['/home/lighthouse/.local/bin/agy'], problem: null, login: null },
    launched: null,
    saved: { executor: 'gemini', cli: '/home/lighthouse/.local/bin/agy', account: 'Gemini Lead', token: true, tier: null },
  });
  assert.ok(facts.some((f) => f.title === '负责人下次启动会用的 Gemini (agy)' && f.value === '/home/lighthouse/.local/bin/agy'));
  assert.ok(facts.some((f) => f.title === '负责人的 Gemini 登录' && f.value === '登录与工具权限在处理消息时核验'));
});

test('shouldAllowPermission allows native router tool permissions without caging', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-gem-sandbox-'));
  try {
    const tychoTools = new Set(['list_tasks', 'reply']);
    assert.equal(shouldAllowPermission({ toolCall: { title: 'mcp_tycho_list_tasks', kind: 'other' } }, tychoTools, undefined), true);
    assert.equal(shouldAllowPermission({ toolCall: { name: 'mcp__tycho__reply', kind: 'other' } }, tychoTools, undefined), true);
    assert.equal(shouldAllowPermission({ toolCall: { name: 'read_file', kind: 'read', rawInput: { path: 'src/index.ts' } } }, tychoTools, dir), true);
    assert.equal(shouldAllowPermission({ toolCall: { name: 'edit_file', kind: 'edit', rawInput: { path: 'src/index.ts' } } }, tychoTools, dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router-gemini treats max_tokens, max_turn_requests, and refusal stopReasons as turn errors', async () => {
  assert.equal(classifyStopReason('end_turn', 'ok').isError, false);
  assert.equal(classifyStopReason(undefined, 'ok').isError, false);
  assert.equal(classifyStopReason('refusal', 'nope').isError, true);
  assert.equal(classifyStopReason('unexpected_reason', '').isError, true);

  const dir = mkdtempSync(join(tmpdir(), 'tycho-router-gemini-stop-'));
  try {
    const mock = writeMockAcpServer(dir);
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, mock],
      prompt: 'SYSTEM PROMPT',
      tools: ['reply'],
      mcp: { command: process.execPath, args: ['proxy.ts'], env: {} },
    }));

    for (const mode of ['max_tokens', 'max_turn_requests'] as const) {
      const run = runBridge(cfg, { MOCK_MODE: mode });
      await run.waitFor((list) => list.some((e) => e.type === 'system'));
      run.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'write a book' }] } }) + '\n');
      const events = await run.waitFor((list) => list.some((e) => e.type === 'result'));
      run.child.stdin.end();
      const result = events.find((e) => e.type === 'result')!;
      assert.equal(result.is_error, true, `${mode} must mark result is_error=true`);
      assert.match(result.result, new RegExp(mode));
      assert.equal(result.stop_reason, mode);
      assert.equal(result.partial_result, 'partial truncated answer');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router-gemini reports ACP tools honestly and fails when Tycho MCP server fails verification', async () => {
  const fromConfig = extractReportedTools({}, { sessionId: 's1' }, ['reply']);
  assert.deepEqual(fromConfig, { tools: ['mcp__tycho__reply'], verified: false });

  const dir = mkdtempSync(join(tmpdir(), 'tycho-router-gemini-tools-'));
  try {
    const mock = writeMockAcpServer(dir);
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, mock],
      prompt: 'SYSTEM PROMPT',
      tools: ['list_tasks', 'reply'],
      mcp: { command: process.execPath, args: ['proxy.ts'], env: {} },
    }));

    const extraRun = runBridge(cfg, { MOCK_MODE: 'extra_tools' });
    const events = await extraRun.waitFor((list) => list.some((e) => e.type === 'system'));
    extraRun.child.stdin.end();
    const init = events.find((e) => e.type === 'system')!;
    assert.equal(init.tools_verified, true);
    assert.deepEqual(init.tools, ['mcp__tycho__list_tasks', 'mcp__tycho__reply', 'mcp_rogue_shell']);

    const failRun = runBridge(cfg, { MOCK_MODE: 'mcp_failed' });
    const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => failRun.child.once('close', (c, s) => resolve([c, s])));
    assert.equal(code, 1);
    assert.match(failRun.getStderr(), /MCP verification failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
