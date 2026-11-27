// Ephemeral, strictly read-only Side Ask runner for quick clarifying questions in the console.
// Never mutates the ledger, never writes project files, and never interrupts active Router or Worker turns.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCodexOAuthLease, formatCodexAuthFile, isCodexOAuthLease, isCodexOAuthSecret, writeCodexAuthHome } from '../adapters/codex-auth.ts';
import { codexSettings } from '../adapters/tier.ts';
import { hider } from '../runner/redact.ts';
import { getActiveLocale, type Locale } from '../shared/i18n.ts';
import { codexRouterEnv } from './codex-router-safety.ts';
import { rootSpawnOptions } from './processes.ts';
import type { RouterLaunch } from './session-host.ts';

const DEFAULT_SIDE_ASK_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_CONTEXT_MESSAGE_CHARS = 900;

export interface SideAskTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface SideAskContext {
  projectName: string;
  recentMessages: readonly { direction: 'in' | 'out'; text: string; created_at?: string }[];
  recentTasks: readonly { id: string; title: string; state: string; summary?: string | null }[];
}

export interface SideAskInput {
  question: string;
  quote?: { source?: string; excerpt: string } | undefined;
  history?: readonly SideAskTurn[] | undefined;
  locale?: Locale | undefined;
}

export interface SideAskResult {
  answer: string;
  executor: 'claude' | 'codex' | 'gemini';
  duration_ms: number;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export function buildSideAskPrompt(context: SideAskContext, input: SideAskInput): string {
  const locale = input.locale ?? getActiveLocale();
  const lines: string[] = [];
  if (locale === 'en') {
    lines.push(
      'You are answering a quick, read-only Side Ask inside Tycho.',
      'Be direct, accurate, and concise. Answer based on the project context and quoted excerpt below.',
      'Do NOT run commands, do NOT edit files, and do NOT propose creating tasks unless asked.',
      'Respond in English unless the user writes in another language.',
    );
  } else {
    lines.push(
      '你正在 Tycho 控制台的「临时追问」浮层中回答主人的旁路疑问。',
      '请基于下方项目只读摘要与引用片段直接、准确、简明地答疑解惑。',
      '严禁执行命令、严禁修改文件、不要展开冗长计划；如果上下文里没有足够证据，请坦诚说明缺少哪项信息。',
    );
  }
  lines.push('', `## Project: ${context.projectName}`);

  if (context.recentTasks.length > 0) {
    lines.push('', '### Recent tasks');
    for (const task of context.recentTasks.slice(0, 8)) {
      const summary = task.summary ? ` — ${clip(task.summary, 180)}` : '';
      lines.push(`- [${task.state}] ${task.title} (${task.id})${summary}`);
    }
  }

  if (context.recentMessages.length > 0) {
    lines.push('', '### Recent conversation');
    for (const msg of context.recentMessages.slice(-8)) {
      const speaker = msg.direction === 'in' ? 'Owner' : 'Router';
      lines.push(`- ${speaker}: ${clip(msg.text, MAX_CONTEXT_MESSAGE_CHARS)}`);
    }
  }

  if (input.quote?.excerpt?.trim()) {
    const label = input.quote.source?.trim() ? ` (${input.quote.source.trim()})` : '';
    lines.push('', `### Quoted excerpt${label}`, clip(input.quote.excerpt, 1600));
  }

  if (input.history && input.history.length > 0) {
    lines.push('', '### Prior side-ask turns');
    for (const turn of input.history.slice(-8)) {
      lines.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${clip(turn.text, 1200)}`);
    }
  }

  lines.push('', '### Current question', input.question.trim());
  return lines.join('\n');
}

function extractGeminiJsonAnswer(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['response', 'result', 'text', 'output']) {
      if (typeof parsed[key] === 'string' && parsed[key]!.trim() !== '') return parsed[key]!.trim();
    }
    if (parsed.command && typeof parsed.command === 'object') {
      const resp = (parsed.command as Record<string, unknown>).response;
      if (typeof resp === 'string' && resp.trim() !== '') return resp.trim();
    }
  } catch {
    // Fall back to plain stdout if non-JSON.
  }
  return trimmed;
}

function parseJsonTier(text: string | undefined): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function runSubprocess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...rootSpawnOptions(process.platform),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.slice(0, MAX_OUTPUT_CHARS - stdout.length);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk.slice(0, 4000 - stderr.length);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.on('error', () => { /* ignore broken pipe */ });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export async function runSideAsk(
  launch: RouterLaunch,
  context: SideAskContext,
  input: SideAskInput,
  options: { timeoutMs?: number } = {},
): Promise<SideAskResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SIDE_ASK_TIMEOUT_MS;
  const executor: 'claude' | 'codex' | 'gemini' = launch.executor === 'codex' || launch.executor === 'gemini' ? launch.executor : 'claude';
  const prompt = buildSideAskPrompt(context, input);
  const workDir = mkdtempSync(join(tmpdir(), 'tycho-side-ask-'));
  const secret = launch.token;
  const redact = hider([secret]);

  try {
    const [bin, ...lead] = launch.claude;
    if (!bin) throw new Error('未找到可用的负责人执行器命令');

    if (executor === 'codex') {
      const outPath = join(workDir, 'last-message.txt');
      const env = codexRouterEnv({ ...process.env }, secret);
      const managedArgs: string[] = [];
      if (secret && (isCodexOAuthLease(secret) || isCodexOAuthSecret(secret))) {
        const lease = decodeCodexOAuthLease(secret);
        if (!lease) throw new Error('Codex 登录凭据无效');
        const codexHome = join(workDir, 'codex-home');
        mkdirSync(codexHome, { recursive: true, mode: 0o700 });
        writeCodexAuthHome(codexHome, formatCodexAuthFile(lease, false));
        env.CODEX_HOME = codexHome;
        delete env.CODEX_API_KEY;
        delete env.OPENAI_API_KEY;
        managedArgs.push('-c', 'cli_auth_credentials_store="file"');
      } else if (secret) {
        env.OPENAI_API_KEY = secret;
      }
      const tierPairs = codexSettings(launch.tier?.text ?? '');
      const readTierVal = (key: string): string | undefined => {
        const raw = tierPairs.find((item) => item.key.trim() === key)?.value.trim();
        if (!raw) return undefined;
        try { return JSON.parse(raw) as string; } catch { return raw; }
      };
      const model = readTierVal('model');
      const args = [
        ...lead,
        'exec',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '-o', outPath,
        ...managedArgs,
        ...(model ? ['-m', model] : []),
        '-',
      ];
      const res = await runSubprocess(bin, args, { cwd: workDir, env, stdin: prompt, timeoutMs });
      if (res.timedOut) throw new Error('临时追问超时，请稍后重试或简化问题');
      const fileText = existsSync(outPath) ? readFileSync(outPath, 'utf8').trim() : '';
      const answer = fileText || res.stdout.trim();
      if (res.code !== 0 && !answer) {
        throw new Error(`临时追问失败（Codex 退出码 ${res.code}）：${redact(res.stderr.trim()).slice(0, 240)}`);
      }
      if (!answer) throw new Error('执行器未返回回答内容');
      return { answer, executor, duration_ms: Date.now() - started };
    }

    if (executor === 'gemini') {
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^(CODEX_.*|OPENAI_API_KEY|ANTHROPIC_.*|CLAUDE.*|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GEMINI_BASE_URL)$/i.test(k)),
      );
      if (secret) env.GEMINI_API_KEY = secret;
      if (launch.baseUrl) env.GOOGLE_GEMINI_BASE_URL = launch.baseUrl;
      const tierObj = parseJsonTier(launch.tier?.text);
      const model = typeof tierObj.model === 'string' && tierObj.model.trim() !== '' ? tierObj.model.trim() : undefined;
      const effort = typeof tierObj.effort === 'string' && tierObj.effort.trim() !== '' ? tierObj.effort.trim() : undefined;
      let settingsPath: string | undefined;
      if (model) {
        settingsPath = join(workDir, 'tier.json');
        writeFileSync(settingsPath, JSON.stringify({ model }), 'utf8');
      }
      const args = [
        ...lead,
        '-p', prompt,
        '--output-format', 'json',
        '--mode', 'plan',
        ...(settingsPath ? ['--settings', settingsPath] : []),
        ...(effort ? ['--effort', effort] : []),
      ];
      const res = await runSubprocess(bin, args, { cwd: workDir, env, timeoutMs });
      if (res.timedOut) throw new Error('临时追问超时，请稍后重试或简化问题');
      const answer = extractGeminiJsonAnswer(res.stdout);
      if (res.code !== 0 && !answer) {
        throw new Error(`临时追问失败（Gemini 退出码 ${res.code}）：${redact(res.stderr.trim()).slice(0, 240)}`);
      }
      if (!answer) throw new Error('执行器未返回回答内容');
      return { answer, executor, duration_ms: Date.now() - started };
    }

    // Claude Code one-shot tool-free read-only answer
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
    if (secret) env.CLAUDE_CODE_OAUTH_TOKEN = secret;
    const tierObj = parseJsonTier(launch.tier?.text);
    const model = typeof tierObj.model === 'string' && tierObj.model.trim() !== '' ? tierObj.model.trim() : undefined;
    const args = [
      ...lead,
      '-p', prompt,
      '--output-format', 'text',
      '--tools', '',
      '--no-session-persistence',
      ...(model ? ['--model', model] : []),
    ];
    const res = await runSubprocess(bin, args, { cwd: workDir, env, timeoutMs });
    if (res.timedOut) throw new Error('临时追问超时，请稍后重试或简化问题');
    const answer = res.stdout.trim();
    if (res.code !== 0 && !answer) {
      throw new Error(`临时追问失败（Claude 退出码 ${res.code}）：${redact(res.stderr.trim()).slice(0, 240)}`);
    }
    if (!answer) throw new Error('执行器未返回回答内容');
    return { answer, executor, duration_ms: Date.now() - started };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
