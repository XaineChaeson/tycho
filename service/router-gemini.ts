import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';

type Config = {
  argv: string[];
  prompt: string;
  resume?: string;
  tools: string[];
  mcp: { command: string; args: string[]; env: Record<string, string> };
  model?: string;
  effort?: string;
  managedHome?: string;
  baseUrl?: string;
  cwd?: string | null;
};
type Json = Record<string, any>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// Only structured error categories leave the bridge; server error text may contain secrets.
function errorText(error: unknown): string {
  const obj = error && typeof error === 'object' ? (error as Json) : {};
  const code = typeof obj.code === 'number' ? obj.code : undefined;
  const message = typeof obj.message === 'string' ? obj.message : error instanceof Error ? error.message : '';
  if (code === 429 || code === 402 || /\b429\b|\b402\b|RESOURCE_EXHAUSTED|quota|rate[ _-]?limit|usage limit|insufficient/i.test(message)) {
    return 'Gemini usage limit reached';
  }
  if (code === -32000 || code === 401 || code === 403 || /\b401\b|\b403\b|UNAUTHENTICATED|API_KEY_INVALID|not logged in|invalid api key|unauthorized|forbidden|auth_required|authentication required/i.test(message)) {
    return 'Gemini not logged in';
  }
  return 'Gemini turn did not complete';
}

function normalizeToolName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.startsWith('mcp__')) return name;
  if (name.startsWith('mcp_tycho_')) return `mcp__tycho__${name.slice('mcp_tycho_'.length)}`;
  return name || 'tool';
}

export function shouldAllowPermission(_params?: Json, _tychoTools?: Set<string>, _workspace?: string): boolean {
  return true;
}

function serverToolNames(rawTools: unknown): string[] {
  if (Array.isArray(rawTools)) {
    return rawTools
      .map((item) => (typeof item === 'string' ? item.trim() : item && typeof item === 'object' ? String((item as Json).name ?? (item as Json).id ?? '').trim() : ''))
      .filter(Boolean);
  }
  if (rawTools && typeof rawTools === 'object') {
    return Object.keys(rawTools as Record<string, unknown>).map((k) => k.trim()).filter(Boolean);
  }
  return [];
}

export function extractReportedTools(
  initRes: Json | undefined,
  session: Json | undefined,
  configTools: string[],
): { tools: string[]; verified: boolean } {
  const serverSource = session?.mcpServers ?? initRes?.mcpServers;
  if (serverSource !== undefined && serverSource !== null) {
    const entries: Array<{ name: string; info: Json }> = Array.isArray(serverSource)
      ? serverSource
          .filter((item): item is Json => Boolean(item && typeof item === 'object' && typeof item.name === 'string'))
          .map((item) => ({ name: item.name.trim(), info: item }))
      : typeof serverSource === 'object'
        ? Object.entries(serverSource as Record<string, unknown>)
            .filter(([, info]) => Boolean(info && typeof info === 'object'))
            .map(([name, info]) => ({ name: name.trim(), info: info as Json }))
        : [];

    if (entries.length === 0) {
      throw new Error('MCP verification failed');
    }
    {
      const collected: string[] = [];
      let sawTycho = false;
      let sawToolMetadata = false;
      for (const { name, info } of entries) {
        const status = String(info.runtimeStatus ?? info.status ?? '').toLowerCase();
        const disabled = info.enabled === false || status === 'disabled';
        if (name === 'tycho') {
          sawTycho = true;
          if (disabled || status === 'failed' || status === 'error' || status === 'disconnected' || info.error || info.toolsError) {
            throw new Error('MCP verification failed');
          }
          if (info.tools !== undefined) {
            sawToolMetadata = true;
            for (const tool of serverToolNames(info.tools)) {
              collected.push(tool.startsWith('mcp__') || tool.startsWith('mcp_tycho_') ? normalizeToolName(tool) : `mcp__tycho__${tool}`);
            }
          } else {
            for (const tool of configTools) {
              collected.push(`mcp__tycho__${tool}`);
            }
          }
        } else if (!disabled) {
          sawToolMetadata = true;
          const extra = serverToolNames(info.tools);
          if (extra.length > 0) {
            for (const tool of extra) collected.push(`mcp__${name}__${tool}`);
          } else {
            collected.push(`mcp__${name}__*`);
          }
        }
      }
      if (!sawTycho) throw new Error('MCP verification failed');
      if (sawToolMetadata) return { tools: collected, verified: true };
    }
  }

  for (const rawList of [session?.tools, session?.availableTools, initRes?.tools, initRes?.agentCapabilities?.tools]) {
    if (Array.isArray(rawList)) {
      const mapped = rawList
        .map((item) => (typeof item === 'string' ? item.trim() : item && typeof item === 'object' ? String((item as Json).name ?? (item as Json).id ?? '').trim() : ''))
        .filter(Boolean)
        .map((name) => normalizeToolName(name));
      return { tools: mapped, verified: true };
    }
  }

  return {
    tools: configTools.map((name) => `mcp__tycho__${name}`),
    verified: false,
  };
}

export function classifyStopReason(
  stopReason: unknown,
  partialText: string,
): { isError: boolean; result: string; stopReason?: string; partialResult?: string } {
  if (stopReason === 'end_turn' || stopReason === undefined || stopReason === null) {
    return { isError: false, result: partialText };
  }
  const extra = partialText ? { partialResult: partialText } : {};
  if (stopReason === 'cancelled') {
    return { isError: true, result: 'Gemini turn cancelled', stopReason: 'cancelled', ...extra };
  }
  if (stopReason === 'max_tokens') {
    return { isError: true, result: 'Gemini turn truncated (max_tokens)', stopReason: 'max_tokens', ...extra };
  }
  if (stopReason === 'max_turn_requests') {
    return { isError: true, result: 'Gemini turn stopped (max_turn_requests)', stopReason: 'max_turn_requests', ...extra };
  }
  if (stopReason === 'refusal') {
    return { isError: true, result: 'Gemini turn refused', stopReason: 'refusal', ...extra };
  }
  const label = typeof stopReason === 'string' && stopReason.trim() !== '' ? stopReason.trim() : 'unknown';
  return { isError: true, result: `Gemini turn did not complete (${label})`, stopReason: label, ...extra };
}

function pickPermissionOption(options: unknown, allow: boolean): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const preferred = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const wanted of preferred) {
    const found = options.find((opt) => opt && typeof opt === 'object' && opt.kind === wanted && typeof opt.optionId === 'string');
    if (found) return found.optionId as string;
  }
  return undefined;
}

function readUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Json;
  const inputTokens = num(u.inputTokens ?? u.input_tokens);
  const outputTokens = num(u.outputTokens ?? u.output_tokens);
  const cachedRead = num(u.cachedReadTokens ?? u.cache_read_tokens);
  const cachedWrite = num(u.cachedWriteTokens ?? u.cache_write_tokens);
  if (inputTokens === 0 && outputTokens === 0 && cachedRead === 0 && cachedWrite === 0) return undefined;
  return {
    input_tokens: Math.max(0, inputTokens - cachedRead),
    output_tokens: outputTokens,
    cache_read_input_tokens: cachedRead,
    cache_creation_input_tokens: cachedWrite,
  };
}

function configOptionValues(session: Json, configId: string): string[] {
  const options = Array.isArray(session?.configOptions) ? session.configOptions : [];
  const match = options.find((item: Json) => item && typeof item === 'object' && item.id === configId);
  if (!match || !Array.isArray(match.options)) return [];
  return match.options
    .map((entry: Json) => (entry && typeof entry === 'object' && typeof entry.value === 'string' ? entry.value : ''))
    .filter(Boolean);
}

function availableModelIds(session: Json): string[] {
  const models = session?.models?.availableModels;
  if (!Array.isArray(models)) return [];
  return models
    .map((entry: Json) => (entry && typeof entry === 'object' && typeof entry.modelId === 'string' ? entry.modelId : ''))
    .filter(Boolean);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args[args.indexOf('--config') + 1];
  if (!args.includes('--marker') || !args.includes('--config') || !file) throw new Error('missing bridge arguments');
  const config = JSON.parse(readFileSync(file, 'utf8')) as Config;
  if (!Array.isArray(config.argv) || !config.argv.length || !Array.isArray(config.tools) || !config.mcp) {
    throw new Error('invalid bridge configuration');
  }
  if (config.managedHome !== undefined && (typeof config.managedHome !== 'string' || !isAbsolute(config.managedHome) || !process.env.GEMINI_API_KEY)) {
    throw new Error('invalid bridge configuration');
  }
  if (config.cwd !== undefined && config.cwd !== null && typeof config.cwd !== 'string') {
    throw new Error('invalid bridge configuration');
  }
  const workspace = config.cwd === null
    ? undefined
    : typeof config.cwd === 'string'
      ? (config.cwd.trim() !== '' ? resolve(config.cwd) : undefined)
      : resolve(process.cwd());

  const apiKey = config.managedHome ? process.env.GEMINI_API_KEY : undefined;
  if (config.managedHome) mkdirSync(config.managedHome, { recursive: true, mode: 0o700 });

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/(?:key|token|secret|password|credential)/i.test(name)) delete env[name];
  }
  if (apiKey) env.GEMINI_API_KEY = apiKey;
  if (config.baseUrl) env.GOOGLE_GEMINI_BASE_URL = config.baseUrl;
  else delete env.GOOGLE_GEMINI_BASE_URL;

  const acpArgs = [
    ...config.argv.slice(1),
    'acp',
    '--stdio',
    '--disable-telemetry',
    ...(config.managedHome ? ['--gemini-dir', config.managedHome, '--app-data-dir', 'antigravity-cli'] : []),
  ];
  const child = spawn(config.argv[0], acpArgs, { stdio: ['pipe', 'pipe', 'pipe'], env });
  child.stderr.resume();
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') child.kill();
  });

  let next = 0;
  let closed = false;
  let initialized = false;
  let sessionId = '';
  let inTurn = false;
  let finalText = '';
  let model = config.model;
  const tychoTools = new Set(config.tools);
  const startedTools = new Set<string>();
  const completedTools = new Set<string>();
  const pending = new Map<number, { method: string; resolve(value: any): void; reject(reason: Error): void }>();

  const killChild = (): void => {
    closed = true;
    try {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    } catch {
      // Best-effort child shutdown on exit/signal.
    }
  };
  process.on('exit', killChild);
  const handleSignal = (code: number): void => {
    killChild();
    process.exit(code);
  };
  process.once('SIGTERM', () => handleSignal(143));
  process.once('SIGINT', () => handleSignal(130));

  const write = (value: unknown): void => {
    if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n');
  };
  const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('acp server closed')); return; }
    const id = ++next;
    pending.set(id, { method, resolve, reject });
    write({ jsonrpc: '2.0', id, method, params });
  });
  const emit = (value: unknown): void => {
    process.stdout.write(JSON.stringify(value) + '\n');
  };

  const handleUpdate = (msg: Json): void => {
    if (msg.method !== 'session/update') return;
    const p = msg.params ?? {};
    if (!sessionId || (p.sessionId && p.sessionId !== sessionId) || !inTurn) return;
    const update = p.update;
    if (!update || typeof update !== 'object') return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : '';
      if (text !== '') {
        finalText += text;
        emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
      }
      return;
    }
    if (update.sessionUpdate === 'tool_call') {
      const toolId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (toolId && !startedTools.has(toolId)) {
        startedTools.add(toolId);
        emit({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: toolId,
              name: normalizeToolName(update.name ?? update.title),
              input: update.args ?? update.rawInput ?? {},
            }],
          },
        });
      }
      return;
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const toolId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      const status = typeof update.status === 'string' ? update.status : '';
      if (toolId && (status === 'completed' || status === 'failed') && !completedTools.has(toolId)) {
        completedTools.add(toolId);
        emit({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: toolId,
              content: update.rawOutput ?? update.content ?? '',
              is_error: status === 'failed',
            }],
          },
        });
      }
    }
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'session/request_permission') {
        const allow = shouldAllowPermission(msg.params, tychoTools, workspace);
        const optionId = pickPermissionOption(msg.params?.options, allow);
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
        });
        return;
      }
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Request rejected' } });
      return;
    }
    if (msg.method) { handleUpdate(msg); return; }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) {
      const code = typeof msg.error.code === 'number' && Number.isFinite(msg.error.code) ? msg.error.code : undefined;
      const err = new Error(
        code === -32000
          ? 'acp authentication required'
          : `acp request rejected: ${entry.method}${code !== undefined ? ` (${code})` : ''}`,
      ) as Error & { code?: number; rawMessage?: string };
      if (code !== undefined) err.code = code;
      if (typeof msg.error.message === 'string') err.rawMessage = msg.error.message;
      entry.reject(err);
    } else {
      entry.resolve(msg.result);
    }
  });

  child.on('error', () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error('acp server failed to start'));
    pending.clear();
  });
  child.on('close', () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error('acp server closed'));
    pending.clear();
    if (initialized) process.exitCode = 1;
    process.stdin.destroy();
  });

  const input = createInterface({ input: process.stdin });
  const buffered: string[] = [];
  let handleInput: ((line: string) => void) | undefined;
  input.on('line', (line) => {
    if (handleInput) handleInput(line);
    else buffered.push(line);
  });
  input.on('close', () => {
    child.stdin.end();
    child.kill();
  });

  try {
    const initRes = await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'tycho', version: '1' },
    });

    const mcpEnv: Record<string, string> = {
      ...(config.mcp.env ?? {}),
      TYCHO_MCP_SCHEMA_DIALECT: 'openapi',
    };
    const mcpServers = [{
      name: 'tycho',
      command: config.mcp.command,
      args: config.mcp.args,
      env: Object.entries(mcpEnv).map(([name, value]) => ({ name, value })),
    }];
    const sessionParams = {
      ...(config.resume ? { sessionId: config.resume } : {}),
      cwd: workspace ?? process.cwd(),
      mcpServers,
      _meta: { antigravity: { systemPrompt: { append: config.prompt } } },
    };
    const session = await call(config.resume ? 'session/load' : 'session/new', sessionParams);
    sessionId = typeof session?.sessionId === 'string' && session.sessionId !== '' ? session.sessionId : (config.resume ?? '');
    if (!sessionId || (config.resume && sessionId !== config.resume)) throw new Error('session verification failed');

    let effortApplied = false;
    if (config.model) {
      const optionModels = configOptionValues(session, 'model');
      const models = availableModelIds(session);
      const combined = config.effort ? `${config.model}-${config.effort}` : undefined;
      if (optionModels.includes(config.model)) {
        await call('session/set_config_option', { sessionId, configId: 'model', value: config.model });
      } else if (combined && models.includes(combined)) {
        await call('session/set_model', { sessionId, modelId: combined });
        effortApplied = true;
      } else if (models.includes(config.model)) {
        await call('session/set_model', { sessionId, modelId: config.model });
      } else {
        try {
          await call('session/set_model', { sessionId, modelId: config.model });
        } catch {
          await call('session/set_config_option', { sessionId, configId: 'model', value: config.model });
        }
      }
    }
    if (config.effort && !effortApplied) {
      const levels = configOptionValues(session, 'thought_level');
      if (levels.length === 0 || levels.includes(config.effort)) {
        await call('session/set_config_option', { sessionId, configId: 'thought_level', value: config.effort });
      }
    }
    model = config.model ?? session?.models?.currentModelId ?? model;

    const reported = extractReportedTools(initRes, session, config.tools);
    initialized = true;
    emit({
      type: 'system',
      subtype: 'init',
      tools: reported.tools,
      tools_verified: reported.verified,
      session_id: sessionId,
    });

    handleInput = (line) => {
      let msg: Json;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
        if (!inTurn) {
          emit({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'error' } });
        } else {
          write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
          emit({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success' } });
        }
        return;
      }
      if (msg.type !== 'user' || inTurn) return;
      const parts = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const promptBlocks: Json[] = [];
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          promptBlocks.push({ type: 'text', text: part.text });
        } else if (
          part.type === 'image' &&
          part.source &&
          typeof part.source === 'object' &&
          part.source.type === 'base64' &&
          typeof part.source.media_type === 'string' &&
          typeof part.source.data === 'string'
        ) {
          promptBlocks.push({
            type: 'image',
            mimeType: part.source.media_type,
            data: part.source.data,
          });
        }
      }
      if (!promptBlocks.some((block) => block.type === 'text')) {
        promptBlocks.unshift({ type: 'text', text: '' });
      }
      inTurn = true;
      finalText = '';
      startedTools.clear();
      completedTools.clear();
      void call('session/prompt', { sessionId, prompt: promptBlocks }).then(
        (res) => {
          inTurn = false;
          const usage = readUsage(res?.usage);
          const classified = classifyStopReason(res?.stopReason, finalText);
          emit({
            type: 'result',
            is_error: classified.isError,
            result: classified.result,
            ...(classified.stopReason ? { stop_reason: classified.stopReason } : {}),
            ...(classified.partialResult ? { partial_result: classified.partialResult } : {}),
            ...(usage ? { usage, ...(model ? { modelUsage: { [model]: {} } } : {}) } : {}),
          });
          finalText = '';
        },
        (err: Error & { code?: number; rawMessage?: string }) => {
          inTurn = false;
          finalText = '';
          emit({
            type: 'result',
            is_error: true,
            result: errorText({ code: err.code, message: err.rawMessage ?? err.message }),
          });
        },
      );
    };
    for (const line of buffered.splice(0)) handleInput(line);
  } catch (error) {
    child.stdin.end();
    child.kill();
    input.close();
    throw error;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const allowed = /^(acp authentication required|session verification failed|MCP verification failed|acp request rejected: [a-zA-Z/_-]+(?: \(-?[0-9]+\))?|acp server closed|acp server failed to start|missing bridge arguments|invalid bridge configuration)$/;
    process.stderr.write(`Gemini bridge: ${error instanceof Error && allowed.test(error.message) ? error.message : 'initialization failed'}\n`);
    process.exitCode = 1;
  });
}
