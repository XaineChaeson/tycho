import { createHash } from 'node:crypto';
import { emailAccountLabel, maskEmailIdentity, planLabelOf, type ExecutorIdentity } from '../shared/logins.ts';
import { GEMINI_SETTINGS_JSON } from '../shared/tier-form.ts';
import { geminiBaseUrl, geminiProvider, parseGeminiModelsListing } from './gemini-provider.ts';
import { createResultReader, type ResultLimits, type ResultReader } from './result-stream.ts';
import { inputText, readCommand } from './shell.ts';
import { checkTierText } from './tier.ts';
import type { Adapter, FileChange, InstallPlace, Launch, ModelInfo, NormalizedEvent, QuotaReading, QuotaWindow, Reading, ReadingError, Tier, ToolCall, ToolCategory, Turn, Usage } from './types.ts';
import { addUsage } from './usage.ts';

type Json = Record<string, any>;

const STDERR_TAIL = 2000;
const PERMISSION_MODES = ['dangerously-skip-permissions', 'accept-edits', 'auto', 'plan'] as const;
const TIER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const INSTALL_PLACES: readonly InstallPlace[] = [
  { kind: 'under', platforms: ['win32'], variable: 'LOCALAPPDATA', path: ['agy', 'bin', 'agy.exe'] },
  { kind: 'under', platforms: ['win32'], variable: 'LOCALAPPDATA', path: ['agy', 'bin', 'agy.cmd'] },
  { kind: 'under', platforms: ['win32'], variable: 'USERPROFILE', path: ['.gemini', 'bin', 'agy.exe'] },
  { kind: 'under', platforms: ['win32'], variable: 'USERPROFILE', path: ['.gemini', 'bin', 'agy.cmd'] },
  { kind: 'under', platforms: ['win32'], variable: 'USERPROFILE', path: ['.agy', 'bin', 'agy.exe'] },
  { kind: 'under', platforms: ['win32'], variable: 'USERPROFILE', path: ['.local', 'bin', 'agy.exe'] },
  { kind: 'under', platforms: ['win32'], variable: 'LOCALAPPDATA', path: ['antigravity', 'bin', 'agy.exe'] },
  { kind: 'under', platforms: ['win32'], variable: 'LOCALAPPDATA', path: ['Programs', 'Antigravity', 'bin', 'agy.exe'] },
  { kind: 'under', platforms: ['win32'], variable: 'LOCALAPPDATA', path: ['Programs', 'Antigravity', 'bin', 'agy.cmd'] },
  { kind: 'under', platforms: ['win32'], variable: 'APPDATA', path: ['npm', 'agy.cmd'] },
  { kind: 'under', platforms: ['darwin', 'linux'], variable: 'HOME', path: ['.gemini', 'bin', 'agy'] },
  { kind: 'under', platforms: ['darwin', 'linux'], variable: 'HOME', path: ['.agy', 'bin', 'agy'] },
  { kind: 'under', platforms: ['darwin', 'linux'], variable: 'HOME', path: ['.local', 'bin', 'agy'] },
];

const CATEGORIES: Record<string, ToolCategory> = {
  read_file: 'read',
  view_file: 'read',
  list_dir: 'read',
  read_browser_page: 'read',
  read_resource: 'read',
  read_url_content: 'read',
  capture_browser_screenshot: 'read',
  capture_browser_console_logs: 'read',
  list_resources: 'read',
  grep_search: 'search',
  find_by_name: 'search',
  search_web: 'search',
  search_marketplace: 'search',
  write_file: 'edit',
  write_to_file: 'edit',
  edit_file: 'edit',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  sed_file: 'edit',
  notebook_edit: 'edit',
  run_command: 'run',
  notebook_execution: 'run',
  send_command_input: 'run',
};

const EDIT_OPS: Record<string, FileChange['op']> = {
  write_file: 'add',
  write_to_file: 'add',
  edit_file: 'update',
  replace_file_content: 'update',
  multi_replace_file_content: 'update',
  sed_file: 'update',
  notebook_edit: 'update',
};

const PATH_KEYS = ['Path', 'TargetFile', 'AbsolutePath', 'DirectoryPath', 'SearchDirectory', 'SearchPath', 'FilePath', 'path', 'file_path'];
const SIGN_IN_CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const SIGN_IN_URL = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'\x00-\x1f]+/g;
const SIGN_IN_PROMPT = /paste the authorization code[\s\S]*press Enter:/i;

// Measured on `agy acp --login` 1.5.10: prints the Google OAuth link on stdout and prompts on
// stdin (`Then paste the authorization code, or the full URL of the page you land on, and press
// Enter:`). Both must appear before the link is offered so a partial line is never read early.
export function readGeminiSignIn(output: string): { url: string } | undefined {
  if (typeof output !== 'string') return undefined;
  const plain = output.replace(SIGN_IN_CONTROL, '');
  if (!SIGN_IN_PROMPT.test(plain)) return undefined;
  const url = [...plain.matchAll(SIGN_IN_URL)].at(-1)?.[0];
  return url === undefined ? undefined : { url };
}

const isObj = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function parseJsonObject(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObj(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function effortOf(tier: Tier): string | undefined {
  if (tier.text.trim() === '') return undefined;
  const parsed = parseJsonObject(tier.text);
  const effort = str(parsed?.effort)?.trim();
  return effort ? effort : undefined;
}

function tierArgs(turn: Turn): string[] {
  if (turn.tier.text.trim() === '' && !turn.managedAccount) return [];
  if (!turn.tierPath) throw new Error('Gemini 档位内容在机器上没有快照路径');
  const effort = effortOf(turn.tier);
  // agy 1.5.9 --settings validates and rejects "effort", so effort travels on the CLI while
  // the snapshot's tier.json strips it (and injects modelProvider: "gemini" for managed accounts).
  return ['--settings', turn.tierPath, ...(effort ? ['--effort', effort] : [])];
}

function modeArgs(turn: Turn): string[] {
  const mode = turn.permissionMode;
  return !mode || mode === 'dangerously-skip-permissions' ? ['--dangerously-skip-permissions'] : ['--mode', mode];
}

function dirArgs(turn: Turn): string[] {
  const seen = new Set<string>();
  const args: string[] = [];
  for (const dir of [turn.workdir, turn.materialsDir, turn.artifactsDir]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    args.push('--add-dir', dir);
  }
  return args;
}

function command(turn: Turn, extra: string[] = []): Launch {
  const baseUrl = geminiBaseUrl(turn.provider);
  return {
    argv: [
      'agy',
      '-p',
      turn.prompt,
      '--output-format',
      'stream-json',
      ...extra,
      ...tierArgs(turn),
      ...modeArgs(turn),
      ...dirArgs(turn),
    ],
    env: baseUrl ? { GOOGLE_GEMINI_BASE_URL: baseUrl } : {},
  };
}

function checkTier(tier: Tier): string | undefined {
  if (tier.text.trim() === '') return checkTierText(tier.text.length ? `${tier.text}{}` : '{}');
  const limit = checkTierText(tier.text);
  if (limit !== undefined) return limit;
  const parsed = parseJsonObject(tier.text);
  if (!parsed) return 'Gemini 档位必须是合法的 JSON 对象';
  if ('effort' in parsed && (typeof parsed.effort !== 'string' || parsed.effort.trim() === '')) {
    return 'Gemini 档位里的 effort 必须是非空字符串';
  }
  return undefined;
}

// Parse `--effort` choices dynamically from `agy --help` (e.g. `(low|medium|high|xhigh|max)`).
function parseHelpEfforts(help: string | undefined): string[] {
  if (!help) return [];
  const line = help.split(/\r?\n/).find((each) => /^\s*--effort\b/.test(each));
  if (!line) return [];
  const inside = /\(([^)]+)\)/.exec(line)?.[1];
  if (!inside) return [];
  return [...new Set(
    inside
      .split(/[|,]/)
      .map((item) => item.trim())
      .filter((item) => /^[\w.-]+$/.test(item)),
  )];
}

// `agy models` prints `<id>\t<display name>` one model per line on stdout.
function parseModels(stdout: string, helpStdout?: string): ModelInfo[] {
  const efforts = parseHelpEfforts(helpStdout);
  const models: ModelInfo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const tab = raw.indexOf('\t');
    const id = (tab < 0 ? raw : raw.slice(0, tab)).trim();
    if (!id) continue;
    const name = tab < 0 ? undefined : str(raw.slice(tab + 1).trim());
    models.push({
      id,
      ...(name && name !== id ? { name } : {}),
      ...(efforts.length > 0 ? { efforts: [...efforts] } : {}),
    });
  }
  return models;
}

// `agy mcp list` prints either `No MCP servers configured.` or a space-padded table starting with
// `NAME  TYPE  STATUS  COMMAND/URL`. Only enabled server names leave the machine.
function parseMcpList(stdout: string): string[] | undefined {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && /^No MCP servers configured\.?$/i.test(lines[0]!)) return [];
  if (lines.length === 0 || !/^NAME\s+TYPE\s+STATUS\b/.test(lines[0]!)) return undefined;
  const enabled: string[] = [];
  for (const row of lines.slice(1)) {
    const match = /^(\S+)\s+\S+\s+(\S+)(?:\s|$)/.exec(row);
    if (!match) return undefined;
    if (match[2]!.toLowerCase() === 'enabled') enabled.push(match[1]!);
  }
  return enabled;
}

function parsePlugins(stdout: string): string[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.flatMap((entry) => (isObj(entry) && typeof entry.name === 'string' && entry.name !== '' && entry.enabled !== false ? [entry.name] : []));
}

function normalizeResetIso(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const ms = Date.parse(raw);
  // agy emits Unix epoch 1970-01-01T00:00:00Z when a window is untouched (100% remaining).
  if (!Number.isFinite(ms) || ms <= 86_400_000) return null;
  return new Date(ms).toISOString();
}

function geminiBucketWindowName(groupName: string, bucketId: string, windowKind: string): string {
  const id = bucketId.toLowerCase();
  const win = windowKind.toLowerCase();
  const isGemini = id.startsWith('gemini-') || /gemini/i.test(groupName);
  const is3p = id.startsWith('3p-') || /claude|gpt/i.test(groupName);
  if (isGemini) {
    if (win === '5h' || id.endsWith('-5h')) return 'five_hour';
    if (win === 'weekly' || id.endsWith('-weekly')) return 'seven_day';
  }
  if (is3p) {
    if (win === '5h' || id.endsWith('-5h')) return 'five_hour_3p';
    if (win === 'weekly' || id.endsWith('-weekly')) return 'seven_day_3p';
  }
  return bucketId.trim() || `${groupName}_${windowKind}`;
}

// Parse `agy -p /usage --output-format json` (zero tokens, zero turns).
// Supports both structured `command.data.groups[].buckets[]` and tab-separated `response` fallback.
export function parseGeminiUsage(stdout: string): QuotaReading {
  const parsed = parseJsonObject(stdout.trim());
  const windows: QuotaWindow[] = [];

  if (parsed && isObj(parsed.command) && isObj(parsed.command.data) && Array.isArray(parsed.command.data.groups)) {
    for (const rawGroup of parsed.command.data.groups) {
      if (!isObj(rawGroup) || !Array.isArray(rawGroup.buckets)) continue;
      const groupName = typeof rawGroup.name === 'string' ? rawGroup.name : '';
      for (const rawBucket of rawGroup.buckets) {
        if (!isObj(rawBucket)) continue;
        const rem = rawBucket.remaining_fraction;
        if (typeof rem !== 'number' || !Number.isFinite(rem) || rem < 0 || rem > 1) continue;
        const bucketId = typeof rawBucket.id === 'string' ? rawBucket.id : '';
        const windowKind = typeof rawBucket.window === 'string' ? rawBucket.window : '';
        const windowName = geminiBucketWindowName(groupName, bucketId, windowKind);
        windows.push({
          window: windowName,
          used: Math.max(0, Math.min(1, 1 - rem)),
          resets_at: normalizeResetIso(rawBucket.reset_time),
        });
      }
    }
    if (windows.length > 0) return { windows };
  }

  // Fallback: tab-separated lines `<group>\t<limit name>\t<pct>%\t<iso reset>`
  const textBody = parsed && typeof parsed.response === 'string' ? parsed.response : stdout;
  for (const rawLine of textBody.split(/\r?\n/)) {
    const parts = rawLine.split('\t').map((s) => s.trim());
    if (parts.length < 3) continue;
    const pctMatch = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(parts[2]!);
    if (!pctMatch) continue;
    const remainingPct = Number(pctMatch[1]);
    if (!Number.isFinite(remainingPct) || remainingPct < 0 || remainingPct > 100) continue;
    const groupName = parts[0]!;
    const label = parts[1]!.toLowerCase();
    const windowKind = /five\s*hour|5\s*h/i.test(label) ? '5h' : /week|7\s*d/i.test(label) ? 'weekly' : label;
    windows.push({
      window: geminiBucketWindowName(groupName, '', windowKind),
      used: Math.max(0, Math.min(1, 1 - remainingPct / 100)),
      resets_at: normalizeResetIso(parts[3]),
    });
  }

  if (windows.length > 0) return { windows };
  if (parsed && typeof parsed.error === 'string' && parsed.error.trim() !== '') {
    return { problem: 'agy 额度查询失败' };
  }
  return { problem: 'agy /usage 没有返回可识别的额度窗口' };
}

function classifyError(message: string): ReadingError['kind'] {
  if (/\b401\b|\b403\b|UNAUTHENTICATED|API_KEY_INVALID|not logged in|invalid api key|unauthorized|forbidden|auth_required|sign-in update needed/i.test(message)) return 'auth';
  if (/\b429\b|\b402\b|RESOURCE_EXHAUSTED|quota|rate[ _-]?limit|usage limit|insufficient balance|credit/i.test(message)) return 'quota';
  return 'other';
}

function usageOf(raw: unknown): Usage[] {
  if (!isObj(raw)) return [];
  const inputTokens = num(raw.input_tokens);
  const outputTokens = num(raw.output_tokens);
  const cacheReadTokens = num(raw.cache_read_tokens);
  const cacheWriteTokens = num(raw.cache_write_tokens);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return [];
  return [{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }];
}

function pathOfParams(params: Json): string | undefined {
  for (const key of PATH_KEYS) {
    const candidate = str(params[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function toolCallOf(name: string, paramsRaw: unknown): ToolCall {
  const params = isObj(paramsRaw) ? paramsRaw : {};
  const cmd = str(params.CommandLine) ?? str(params.command);
  if (name === 'run_command' && cmd) {
    const read = readCommand(cmd);
    return {
      category: read.category,
      name,
      title: read.title,
      input: cmd,
      ...(read.paths?.length ? { paths: read.paths } : {}),
    };
  }
  const path = pathOfParams(params);
  const query = str(params.Query) ?? str(params.query) ?? str(params.Pattern) ?? str(params.pattern) ?? str(params.Url) ?? str(params.url);
  const full = inputText(params);
  return {
    category: CATEGORIES[name] ?? 'other',
    name,
    title: path ?? query ?? name,
    ...(full ? { input: full } : {}),
    ...(path ? { paths: [path] } : {}),
  };
}

function exitCodeOfOutput(name: string, output: string | undefined): number | undefined {
  if (name !== 'run_command' || !output) return undefined;
  const match = /\bCommand exited with code (-?\d+)\./.exec(output);
  return match ? Number(match[1]) : undefined;
}

function changesOfTool(name: string, paramsRaw: unknown): FileChange[] {
  const op = EDIT_OPS[name];
  if (!op || !isObj(paramsRaw)) return [];
  const path = pathOfParams(paramsRaw);
  return path ? [{ path, op }] : [];
}

function parse(text: string): NormalizedEvent[] {
  const line = parseJsonObject(text);
  if (!line) return [];
  if (line.event === 'step_update' && isObj(line.step_update)) {
    const su = line.step_update;
    const events: NormalizedEvent[] = [];
    if (typeof su.thinking_delta === 'string' && su.thinking_delta !== '') {
      events.push({ kind: 'thinking', text: su.thinking_delta });
    }
    if (typeof su.text_delta === 'string' && su.text_delta !== '' && su.step_type !== 'error_message') {
      events.push({ kind: 'text', text: su.text_delta });
    }
    if (su.step_type === 'tool' && typeof su.step_index === 'number') {
      const id = `step_${su.step_index}`;
      const info = isObj(su.tool_info) ? su.tool_info : {};
      const name = str(su.tool_name) ?? str(info.name) ?? 'tool';
      if (su.state === 'ACTIVE') {
        events.push({ kind: 'tool.start', id, ...toolCallOf(name, info.parameters) });
      } else if (su.state === 'DONE' || su.state === 'ERROR') {
        const isError = su.state === 'ERROR' || isObj(info.error);
        const outputText = str(info.output);
        const reason = isObj(info.error) ? (str(info.error.message) ?? str(info.error.type)) : undefined;
        const exitCode = exitCodeOfOutput(name, outputText);
        const changes = isError ? [] : changesOfTool(name, info.parameters);
        events.push({
          kind: 'tool.end',
          id,
          isError,
          ...(outputText ? { output: { text: outputText } } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(reason ? { reason } : {}),
          ...(changes.length ? { changes } : {}),
        });
      }
    }
    if (su.state === 'DONE') {
      const stepUsage = usageOf(su.usage);
      if (stepUsage.length > 0) events.push({ kind: 'usage', usage: stepUsage });
    }
    return events;
  }
  if (line.event === 'result' && isObj(line.result)) {
    const res = line.result;
    const events: NormalizedEvent[] = [];
    const unfinished = res.finished_reason === 'print_timeout' || res.finished_reason === 'interrupted' || res.status === 'CANCELED' || res.status === 'INTERRUPTED';
    if (res.status !== 'SUCCESS' || str(res.error) !== undefined) {
      const message = str(res.error) ?? '未知错误';
      events.push({ kind: 'diagnostic', level: 'fatal', message, cause: classifyError(message) });
    }
    events.push(unfinished ? { kind: 'interrupted' } : { kind: 'turn.end' });
    return events;
  }
  return [];
}

function createGeminiResultReader(limits?: ResultLimits): ResultReader {
  let lastResult: Json | undefined;
  let sessionRef: string | undefined;
  let usage: Usage[] = [];
  let sawStepUsage = false;
  let earlyError: string | undefined;
  return createResultReader({
    line(text) {
      const line = parseJsonObject(text);
      if (!line) return false;
      let changed = false;
      const conv = str(line.conversation_id)
        ?? (isObj(line.step_update) ? str(line.step_update.conversation_id) : undefined)
        ?? (isObj(line.result) ? str(line.result.conversation_id) : undefined);
      if (conv && sessionRef === undefined) {
        sessionRef = conv;
        changed = true;
      }
      if (line.event === 'step_update' && isObj(line.step_update)) {
        const su = line.step_update;
        if (su.step_type === 'error_message') {
          const msg = str(su.text_delta) ?? (isObj(su.error) ? str(su.error.message) : undefined);
          if (msg && earlyError === undefined) {
            earlyError = msg;
            changed = true;
          }
        }
        if (su.state === 'DONE') {
          const stepUsage = usageOf(su.usage);
          if (stepUsage.length > 0) {
            // Each DONE step carries its own delta, whereas result.usage sums all turns of a
            // resumed conversation. Summing steps avoids double-counting across resumed turns.
            usage = addUsage(usage, stepUsage);
            sawStepUsage = true;
            changed = true;
          }
        }
      }
      if (line.event === 'result' && isObj(line.result)) {
        lastResult = line.result;
        changed = true;
      }
      return changed;
    },
    state: () => ({ lastResult, sessionRef, usage, sawStepUsage, earlyError }),
    finish(exitCode, stderr) {
      const stderrTail = stderr.trim().slice(-STDERR_TAIL);
      const failure = (message: string): ReadingError => {
        let kind = classifyError(message);
        if (kind === 'other' && earlyError) {
          const earlyKind = classifyError(earlyError);
          if (earlyKind !== 'other') kind = earlyKind;
        }
        return { kind, message };
      };
      const session = sessionRef ? { sessionRef } : {};

      if (!lastResult) {
        if (exitCode === null) return { ...session, finished: false };
        const message = earlyError || stderrTail || `进程退出码 ${exitCode}，没有结果`;
        return { ...session, finished: false, error: failure(message) };
      }

      const unfinished = lastResult.finished_reason === 'print_timeout'
        || lastResult.finished_reason === 'interrupted'
        || lastResult.status === 'CANCELED'
        || lastResult.status === 'INTERRUPTED';
      let finalUsage = usage;
      if (!sawStepUsage && (typeof lastResult.num_turns !== 'number' || lastResult.num_turns <= 1)) {
        finalUsage = usageOf(lastResult.usage);
      }
      const response = typeof lastResult.response === 'string' && lastResult.response !== '' ? lastResult.response : undefined;
      const ref = str(lastResult.conversation_id) ?? sessionRef;
      const reading: Reading = {
        ...(response !== undefined ? { text: response } : {}),
        ...(ref ? { sessionRef: ref } : {}),
        ...(finalUsage.length > 0 ? { usage: finalUsage } : {}),
        finished: !unfinished,
      };
      const failed = unfinished || lastResult.status !== 'SUCCESS' || str(lastResult.error) !== undefined || (exitCode !== null && exitCode !== 0);
      if (!failed) return reading;
      const message = str(lastResult.error) ?? earlyError ?? (stderrTail || `进程退出码 ${exitCode}`);
      return { ...reading, error: failure(message) };
    },
  }, limits);
}

// Parse the official ACP `authenticate` JSON-RPC response (`agy acp`), which exposes
// `_meta.antigravity.tier.name` (e.g. "Google AI Ultra") and may carry user email in future releases.
export function parseGeminiAcpIdentity(line: string): ExecutorIdentity {
  const msg = parseJsonObject(line);
  const result = isObj(msg?.result) ? msg.result : undefined;
  if (!result) return {};
  const meta = isObj(result._meta) ? result._meta : undefined;
  const agyMeta = isObj(meta?.antigravity) ? meta.antigravity : undefined;
  const tier = isObj(agyMeta?.tier) ? agyMeta.tier : undefined;
  const rawPlan = str(tier?.name) ?? str(tier?.id);
  const planLabel = rawPlan ? planLabelOf(rawPlan) : undefined;
  const rawEmail = str(agyMeta?.email) ?? str(result.email) ?? (isObj(result.user) ? str(result.user.email) : undefined);
  const accountLabel = rawEmail ? (maskEmailIdentity(rawEmail) ?? emailAccountLabel(rawEmail)) : undefined;
  const normEmail = rawEmail?.trim().toLowerCase() ?? '';
  const quotaOwner = /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normEmail)
    ? `v1:${createHash('sha256').update(normEmail).digest('hex')}`
    : undefined;
  return {
    ...(accountLabel ? { accountLabel } : {}),
    ...(planLabel ? { planLabel } : {}),
    ...(quotaOwner ? { quotaOwner } : {}),
  };
}

export const geminiAdapter: Adapter = {
  credential: () => ({ variable: 'GEMINI_API_KEY' }),
  accountLogin: ['machine', 'key', 'provider'],
  provider: geminiProvider,
  signIn: {
    argv: ['agy', 'acp', '--login'],
    acceptsCode: true,
    minVersion: { version: '1.5.0', lacks: '没有 acp --login 终端授权登录命令' },
    read: readGeminiSignIn,
  },
  probe: { command: 'agy', version: ['--version'] },
  identityTalk: {
    argv: ['agy', 'acp'],
    steps: () => [
      {
        say: [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })],
        answers: (line) => parseJsonObject(line)?.id === 1,
      },
      {
        say: [JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'oauth-personal' } })],
        answers: (line) => parseJsonObject(line)?.id === 2,
      },
    ],
    parse: parseGeminiAcpIdentity,
  },
  installs: INSTALL_PLACES,
  resumable: true,
  canRoute: true,
  permissionModes: PERMISSION_MODES,
  globalEntry: {
    home: { dir: '.gemini' },
    file: 'AGENTS.md',
    unconfirmed: 'agy 按文件 24 KB 截断、全部全局规则共用 20 000 token 上限，写进去也不代表整份都进了会话',
  },
  memory: {
    scope: 'shared',
    why: 'agy 在 ~/.gemini 下保存跨会话轨迹与记忆，命令行没有单轮关闭开关',
  },
  config: [
    { kind: 'mcp', argv: ['agy', 'mcp', 'list'], parse: parseMcpList },
    { kind: 'plugins', argv: ['agy', 'plugin', 'list', '--json'], parse: parsePlugins },
  ],
  tierForm: { ...GEMINI_SETTINGS_JSON, fields: ['model', 'effort'], efforts: TIER_EFFORTS },
  ownLoginTiers: { decide: { effort: 'high' }, execute: { effort: 'medium' } },
  checkTier,
  listModels: ({ token } = {}) => token !== undefined && token !== ''
    ? {
        kind: 'http',
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
        headers: { 'x-goog-api-key': token },
        parse: parseGeminiModelsListing,
      }
    : { kind: 'command', argv: ['agy', 'models'], extraArgv: ['agy', '--help'], parse: parseModels },
  machineQuota: {
    kind: 'command',
    argv: ['agy', '-p', '/usage', '--output-format', 'json'],
    parse: parseGeminiUsage,
  },
  launch: (turn) => command(turn),
  resume: (turn) => {
    const session = typeof turn.sessionRef === 'string' ? turn.sessionRef.trim() : '';
    if (!session) throw new Error('Gemini 续接需要上一次的 sessionRef');
    return command(turn, ['--conversation', session]);
  },
  parse,
  resultReader: createGeminiResultReader,
  result: (stdout, exitCode, stderr) => {
    const reader = createGeminiResultReader();
    reader.feedStdout(Buffer.from(stdout));
    reader.feedStderr(Buffer.from(stderr));
    return reader.finish(exitCode);
  },
};
