import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { decodeCodexOAuthLease, formatCodexAuthFile, isCodexOAuthLease, isCodexOAuthSecret, writeCodexAuthHome } from '../adapters/codex-auth.ts';

type Config = { argv: string[]; prompt: string; resume?: string; tools: string[]; mcp: { command: string; args: string[]; env: Record<string, string> }; model?: string; effort?: string; managedHome?: string };
type Json = Record<string, any>;

function imageExtension(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg':
    case 'image/jpg': return '.jpg';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    default: return '.png';
  }
}

// Only structured error categories leave the bridge; server error text may contain secrets.
function errorText(info: unknown): string {
  const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
  const status = kind && typeof info === 'object' && info !== null
    ? (info as Record<string, { httpStatusCode?: number }>)[kind]?.httpStatusCode : undefined;
  if (status === 429 || status === 402 || kind === 'usageLimitExceeded' || kind === 'rateLimitExceeded' || kind === 'insufficientCredits') return 'Codex usage limit reached';
  if (status === 401 || status === 403 || kind === 'unauthorized' || kind === 'authenticationFailed') return 'Codex not logged in';
  return 'Codex turn did not complete';
}


async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args[args.indexOf('--config') + 1];
  if (!args.includes('--marker') || !args.includes('--config') || !file) throw new Error('missing bridge arguments');
  const config = JSON.parse(readFileSync(file, 'utf8')) as Config;
  if (!Array.isArray(config.argv) || !config.argv.length || !Array.isArray(config.tools) || !config.mcp) throw new Error('invalid bridge configuration');
  if (config.managedHome !== undefined && (typeof config.managedHome !== 'string' || !isAbsolute(config.managedHome) || !process.env.CODEX_API_KEY)) throw new Error('invalid bridge configuration');
  const credential = config.managedHome ? process.env.CODEX_API_KEY : undefined;
  const isOAuth = credential !== undefined && (isCodexOAuthLease(credential) || isCodexOAuthSecret(credential));
  const oauthLease = isOAuth ? decodeCodexOAuthLease(credential) : undefined;
  if (isOAuth && !oauthLease) throw new Error('invalid bridge configuration');
  const apiKey = oauthLease ? undefined : credential;
  if (config.managedHome) {
    mkdirSync(config.managedHome, { recursive: true, mode: 0o700 });
    if (oauthLease) writeCodexAuthHome(config.managedHome, formatCodexAuthFile(oauthLease, false));
  }
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/(?:key|token|secret|password|credential)/i.test(name)) delete env[name];
  if (config.managedHome) env.CODEX_HOME = config.managedHome;
  const managedArgs = !config.managedHome
    ? []
    : oauthLease
      ? ['-c', 'cli_auth_credentials_store="file"']
      : ['-c', 'model_provider="openai"', '-c', 'cli_auth_credentials_store="ephemeral"'];
  const child = spawn(config.argv[0], [...config.argv.slice(1), 'app-server', ...managedArgs], { stdio: ['pipe', 'pipe', 'pipe'], env });
  child.stderr.resume();
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') child.kill();
  });
  let next = 0, closed = false, initialized = false;
  const pending = new Map<number, { method: string; resolve(value: any): void; reject(reason: Error): void }>();
  const write = (value: unknown): void => { if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n'); };
  const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('app-server closed')); return; }
    const id = ++next; pending.set(id, { method, resolve, reject }); write({ id, method, params });
  });
  const emit = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
  let threadId = '', turnId: string | undefined, starting = false, finalText = '', model = config.model;
  let total: Json | undefined, baseline: Json | undefined;
  const queued: Json[] = [];
  const interrupts: string[] = [];
  const turnTempFiles: string[] = [];
  const cleanupTurnTempFiles = (): void => {
    for (const target of turnTempFiles.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of turn temp images.
      }
    }
  };
  process.on('exit', cleanupTurnTempFiles);
  const handleSignal = (code: number): void => {
    cleanupTurnTempFiles();
    closed = true;
    try {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    } catch {
      // Best-effort child shutdown on signal.
    }
    process.exit(code);
  };
  process.once('SIGTERM', () => handleSignal(143));
  process.once('SIGINT', () => handleSignal(130));
  const flushInterrupts = (): void => {
    if (!turnId) return;
    for (const id of interrupts.splice(0)) void call('turn/interrupt', { threadId, turnId }).then(() => emit({ type: 'control_response', response: { request_id: id, subtype: 'success' } }), () => emit({ type: 'control_response', response: { request_id: id, subtype: 'error' } }));
  };
  const note = (msg: Json): void => {
    const p = msg.params ?? {};
    if (p.threadId !== threadId || !threadId) return;
    if (starting && !turnId) { queued.push(msg); return; }
    const eventTurn = msg.method === 'turn/completed' || msg.method === 'turn/started' ? p.turn?.id : p.turnId;
    if (!turnId || eventTurn !== turnId) return;
    if (msg.method === 'item/agentMessage/delta') emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: p.delta } } });
    if (msg.method === 'thread/tokenUsage/updated') { total = p.tokenUsage?.total; }
    const item = p.item;
    if (msg.method === 'item/completed' && item?.type === 'agentMessage') finalText = item.text ?? '';
    if (item?.type === 'mcpToolCall' && msg.method === 'item/started') emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments }] } });
    if (item?.type === 'mcpToolCall' && msg.method === 'item/completed') emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: item.result, is_error: !!item.error }] } });
    if (msg.method === 'turn/completed') {
      cleanupTurnTempFiles();
      const counts = total && baseline ? Object.fromEntries(['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens'].map(k => [k, Math.max(0, (total![k] ?? 0) - (baseline![k] ?? 0))])) : (!config.resume ? total : undefined);
      const usage = counts ? { input_tokens: Math.max(0, counts.inputTokens - counts.cachedInputTokens), output_tokens: counts.outputTokens, cache_read_input_tokens: counts.cachedInputTokens, cache_creation_input_tokens: counts.cacheWriteInputTokens } : undefined;
      emit({ type: 'result', is_error: p.turn.status !== 'completed', result: p.turn.status === 'completed' ? finalText : errorText(p.turn.error?.codexErrorInfo), ...(usage ? { usage, ...(model ? { modelUsage: { [model]: {} } } : {}) } : {}) });
      baseline = total; turnId = undefined; starting = false; finalText = '';
      for (const id of interrupts.splice(0)) emit({ type: 'control_response', response: { request_id: id, subtype: 'error' } });
    }
  };
  createInterface({ input: child.stdout }).on('line', line => {
    let msg: Json; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) { write({ id: msg.id, error: { code: -32600, message: 'Request rejected' } }); return; }
    if (msg.method) { note(msg); return; }
    const entry = pending.get(msg.id); if (!entry) return; pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(`app-server request rejected: ${entry.method}${typeof msg.error.code === 'number' && Number.isFinite(msg.error.code) ? ` (${msg.error.code})` : ''}`)); else entry.resolve(msg.result);
  });
  child.on('error', () => { cleanupTurnTempFiles(); closed = true; for (const p of pending.values()) p.reject(new Error('app-server failed to start')); pending.clear(); });
  child.on('close', () => { cleanupTurnTempFiles(); closed = true; for (const p of pending.values()) p.reject(new Error('app-server closed')); pending.clear(); if (initialized) process.exitCode = 1; process.stdin.destroy(); });
  const input = createInterface({ input: process.stdin });
  const buffered: string[] = [];
  let handleInput: ((line: string) => void) | undefined;
  input.on('line', line => {
    if (handleInput) handleInput(line);
    else buffered.push(line);
  });
  input.on('close', () => { cleanupTurnTempFiles(); child.stdin.end(); child.kill(); });
  try {
    await call('initialize', { clientInfo: { name: 'tycho', title: 'Tycho', version: '1' }, capabilities: { experimentalApi: true } });
    write({ method: 'initialized' });
    if (apiKey) await call('account/login/start', { type: 'apiKey', apiKey });
    const threadConfig = {
      shell_environment_policy: { inherit: 'core', exclude: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] },
      ...(config.managedHome && !oauthLease ? { model_provider: 'openai' } : {}),
      mcp_servers: {
        tycho: { ...config.mcp, required: true, startup_timeout_sec: 8, default_tools_approval_mode: 'approve' },
      },
      ...(config.effort ? { model_reasoning_effort: config.effort } : {}),
    };
    const thread = await call(config.resume ? 'thread/resume' : 'thread/start', {
      ...(config.resume ? { threadId: config.resume } : {}),
      cwd: process.cwd(),
      developerInstructions: config.prompt,
      ...(config.model ? { model: config.model } : {}),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: threadConfig,
    });
    threadId = thread?.thread?.id;
    if (!threadId || (config.resume && threadId !== config.resume)) throw new Error('thread policy verification failed');
    model = thread.model ?? model;
    initialized = true;
    emit({ type: 'system', subtype: 'init', tools: config.tools.map(name => `mcp__tycho__${name}`), session_id: threadId });
    handleInput = line => {
      let msg: Json; try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') { if (!starting && !turnId) emit({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'error' } }); else { interrupts.push(msg.request_id); flushInterrupts(); } return; }
      if (msg.type !== 'user' || starting || turnId) return;
      cleanupTurnTempFiles();
      const parts = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const turnInput: Json[] = [];
      try {
        let imgDir: string | undefined;
        let imgCount = 0;
        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text' && typeof part.text === 'string') {
            turnInput.push({ type: 'text', text: part.text, text_elements: [] });
          } else if (
            part.type === 'image' &&
            part.source &&
            typeof part.source === 'object' &&
            part.source.type === 'base64' &&
            typeof part.source.media_type === 'string' &&
            typeof part.source.data === 'string'
          ) {
            if (!imgDir) {
              imgDir = mkdtempSync(join(tmpdir(), 'tycho-codex-img-'));
              try { chmodSync(imgDir, 0o700); } catch { /* ignore on platforms without POSIX chmod */ }
              turnTempFiles.push(imgDir);
            }
            imgCount += 1;
            const imgPath = join(imgDir, `image-${imgCount}${imageExtension(part.source.media_type)}`);
            writeFileSync(imgPath, Buffer.from(part.source.data, 'base64'), { mode: 0o600 });
            turnInput.push({ type: 'localImage', path: imgPath });
          }
        }
      } catch {
        cleanupTurnTempFiles();
        emit({ type: 'result', is_error: true, result: 'Codex turn could not start' });
        return;
      }
      if (turnInput.length === 0) {
        turnInput.push({ type: 'text', text: '', text_elements: [] });
      }
      starting = true; baseline = total; finalText = '';
      void call('turn/start', { threadId, input: turnInput }).then(result => { if (!starting) return; turnId = result.turn?.id; if (!turnId) throw new Error('missing turn id'); flushInterrupts(); for (const event of queued.splice(0)) note(event); }).catch(() => { cleanupTurnTempFiles(); starting = false; queued.length = 0; emit({ type: 'result', is_error: true, result: 'Codex turn could not start' }); for (const id of interrupts.splice(0)) emit({ type: 'control_response', response: { request_id: id, subtype: 'error' } }); });
    };
    for (const line of buffered.splice(0)) handleInput(line);
  } catch (error) {
    cleanupTurnTempFiles();
    child.stdin.end(); child.kill(); input.close();
    throw error;
  }
}

main().catch((error: unknown) => { process.stderr.write(`Codex bridge: ${error instanceof Error && /^(configuration read failed|thread policy verification failed|MCP status incomplete|MCP verification failed|app-server request rejected: [a-zA-Z/]+(?: \(-?[0-9]+\))?|app-server closed|app-server failed to start|missing bridge arguments|invalid bridge configuration)$/.test(error.message) ? error.message : 'initialization failed'}\n`); process.exitCode = 1; });
