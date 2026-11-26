import { join } from 'node:path';
import { createResultReader, batchResult } from './result-stream.ts';
import type { ResultLimits, ResultReader } from './result-stream.ts';
import { checkTierText, codexLines, codexSettings } from './tier.ts';
import { codexEmailIdentity, codexSecretStrings, decodeCodexOAuthLease, isCodexOAuthLease, isCodexOAuthSecret, materializeCodexWorkerHome } from './codex-auth.ts';
import { readCommand } from './shell.ts';
import type { Adapter, DiagnosticLevel, FileChange, ModelInfo, NormalizedEvent, QuotaReading, QuotaStep, QuotaWindow, Reading, ReadingError, Tier, ToolCall, Turn, Usage } from './types.ts';
import { addUsage } from './usage.ts';
import { KEY_VALUE_LINES } from '../shared/tier-form.ts';

// guess: the reasoning levels the CLI's own model catalog lists (read from `codex debug
// models` on 0.162.0: low, medium, high, xhigh, max); a level outside this list is the
// owner's own text and rides the tier as it stands.
const TIER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Non-interactive execution: Workers run unattended with the machine as the isolation boundary.
// Defaulting sandbox_mode to `danger-full-access` aligns Codex with Claude (bypassPermissions),
// Gemini (--dangerously-skip-permissions), and DSH (danger-full-access) so Workers never fail
// silently on machines whose ~/.codex/config.toml left the default read-only sandbox. Accounts
// may tighten via permissionMode (`workspace-write` / `read-only`) or choose `inherit-machine`
// to defer completely to the machine's native `~/.codex/config.toml`.
const WORKER_MODE = 'danger-full-access';
const PERMISSION_MODES = ['danger-full-access', 'workspace-write', 'read-only', 'inherit-machine'] as const;
const NON_INTERACTIVE_ARGS = ['-c', 'approval_policy="never"'];

function sandboxArgs(turn: Turn, tierEntries: readonly { key: string; value: string }[]): string[] {
  if (turn.permissionMode === 'inherit-machine') return [];
  if (!turn.permissionMode && tierEntries.some(({ key }) => key === 'sandbox_mode')) return [];
  const mode = turn.permissionMode ?? WORKER_MODE;
  return ['-c', `sandbox_mode="${mode}"`];
}

// Add this round's delivery and materials directories without replacing roots from the
// machine's config. --add-dir takes one raw argv path; the existing machine-side placeholder
// substitution handles spaces and quotes without TOML encoding or a shell. Always passed when
// present, including read-only rounds so brief.md/followup.md can be read and review/report
// artifacts can be written.
function writableRoots(turn: Turn): string[] {
  const dirs: string[] = [];
  if (turn.artifactsDir !== undefined) dirs.push('--add-dir', turn.artifactsDir);
  if (turn.materialsDir !== undefined && turn.materialsDir !== turn.artifactsDir) {
    dirs.push('--add-dir', turn.materialsDir);
  }
  return dirs;
}

// Where the CLI reads instructions for every session (docs/spike/global-entry.md), recorded
// with `codex debug prompt-input` on 0.162.0 (tests/fixtures/global-entry/codex-0.162.0-win):
// `$CODEX_HOME/AGENTS.md`, unless `AGENTS.override.md` is beside it, which is then read instead.
// An empty or white-space-only override is passed over (recorded too). 60 000 bytes went in
// whole: no cap of its own on this file was found. Nothing keeps a round off it but another
// CODEX_HOME, which is also where the login is, so a round still reads it.
const GLOBAL_ENTRY = { home: { env: 'CODEX_HOME', dir: '.codex' }, file: 'AGENTS.md', coveredBy: [{ file: 'AGENTS.override.md', when: 'not-blank' as const }] };
// Codex's native memories pass through; tycho does not disable memories or native MCPs.
const MEMORY = { scope: 'shared' as const };
// What a machine lists of the CLI's own configuration, spending nothing (the same recordings):
// the MCP servers it has on, read from the configuration without starting any.
const CONFIG = [
  { kind: 'mcp' as const, argv: ['codex', 'mcp', 'list', '--json'], parse: parseMcpList },
  { kind: 'connectors' as const, unasked: '随 ChatGPT 登录带来的应用（codex_apps），机器上问不出来' },
];

// The names `codex mcp list --json` lists of the servers that are on.
function parseMcpList(stdout: string): string[] | undefined {
  let answer: unknown;
  try { answer = JSON.parse(stdout); } catch { return undefined; }
  if (!Array.isArray(answer)) return undefined;
  return answer.flatMap((each) => {
    const server = object(each);
    return server && typeof server.name === 'string' && server.enabled !== false ? [server.name] : [];
  });
}

type Json = Record<string, unknown>;
function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}
function lineOf(text: string): Json | undefined {
  try { return object(JSON.parse(text)); } catch { return undefined; }
}

// The strengths one model of the CLI's catalog takes, in its own order.
function effortsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const effort = object(entry)?.effort;
    return typeof effort === 'string' && effort !== '' ? [effort] : [];
  });
}

// Recorded (tests/fixtures/codex/0.162.0/models.json): one JSON object whose `models` list
// is the CLI's own catalog. `slug` is what a tier writes, `visibility` says whether the
// CLI's picker hides it, and each model carries the strengths it takes — which differ from
// model to model, so they are read per model and never from one table.
export function parseCodexModels(stdout: string): ModelInfo[] {
  let answer: Json | undefined;
  try {
    answer = object(JSON.parse(stdout));
  } catch {
    return [];
  }
  const models = answer?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    const model = object(entry);
    const id = model?.slug;
    if (!model || typeof id !== 'string' || id === '') return [];
    const name = typeof model.display_name === 'string' && model.display_name !== '' ? model.display_name : undefined;
    const efforts = effortsOf(model.supported_reasoning_levels);
    const fallback = model.default_reasoning_level;
    return [{
      id,
      ...(name === undefined ? {} : { name }),
      ...(efforts.length === 0 ? {} : { efforts }),
      ...(typeof fallback === 'string' && fallback !== '' ? { defaultEffort: fallback } : {}),
      ...(model.visibility === 'hide' ? { hidden: true } : {}),
    }];
  });
}

// The id of the request a JSON-RPC line answers, when it answers one. Nothing else of a line
// is read here: the conversation is the adapter's, declared step by step below.
function replyId(line: string): number | undefined {
  const answer = lineOf(line);
  return typeof answer?.id === 'number' ? answer.id : undefined;
}

// The two steps of an app-server account read: initialize, wait for its
// answer, then say it is initialized and ask for the rate limits in the same breath. The
// handshake names this client, which is the only place its version is written. A `JSON-RPC`
// notification carries no id, and only the two requests are waited for.
export function accountSteps(version: string, method: string, params?: object): readonly QuotaStep[] {
  return [
    {
      say: [JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'tycho', title: 'tycho', version } } })],
      answers: (line) => replyId(line) === 1,
    },
    {
      say: [JSON.stringify({ method: 'initialized', params: {} }), JSON.stringify({ id: 2, method, ...(params ? { params } : {}) })],
      answers: (line) => replyId(line) === 2,
    },
  ];
}

// One window of a rate-limit bucket. `primary` and `secondary` are the two windows a bucket
// may carry, either absent; standard lengths share the round events' window identifiers,
// and other lengths keep their minutes. A window whose share is not readable is left out.
function quotaWindowOf(bucket: string, key: string, value: unknown): QuotaWindow[] {
  const window = object(value);
  if (!window) return [];
  const percent = window.usedPercent;
  if (typeof percent !== 'number' || !(percent >= 0 && percent <= 100)) return [];
  const minutes = window.windowDurationMins;
  const duration = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day'
    : typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? `${minutes}m` : key;
  const name = bucket === 'codex' ? duration : `${bucket}_${duration}`;
  const resets = window.resetsAt;
  return [{ window: name, used: percent / 100, resets_at: typeof resets === 'number' && Number.isFinite(resets) ? new Date(resets * 1000).toISOString() : null }];
}

// What `account/rateLimits/read` answers (recorded on 0.167.1:
// tests/fixtures/codex/0.167.1/rate-limits). `rateLimitsByLimitId` is read when it is there
// and `rateLimits` only when it is not, so one bucket is never counted twice. The account's
// own id and everything else in the answer stay where they are.
export function parseRateLimits(answer: string): QuotaReading {
  const line = lineOf(answer);
  if (!line) return { problem: 'codex 的回答读不出来' };
  const payload = object(line.result) ?? line;
  const byId = object(payload.rateLimitsByLimitId);
  const buckets: [string, Json][] = byId
    ? Object.entries(byId).flatMap(([id, each]) => {
      const snapshot = object(each);
      return snapshot ? [[id, snapshot] as [string, Json]] : [];
    })
    : (() => {
      const one = object(payload.rateLimits);
      return one ? [[typeof one.limitId === 'string' && one.limitId !== '' ? one.limitId : 'codex', one] as [string, Json]] : [];
    })();
  const windows = buckets.flatMap(([id, snapshot]) => {
    const named = typeof snapshot.limitId === 'string' && snapshot.limitId !== '' ? snapshot.limitId : id;
    return [...quotaWindowOf(named, 'primary', snapshot.primary), ...quotaWindowOf(named, 'secondary', snapshot.secondary)];
  });
  return windows.length === 0 ? { problem: 'codex 没有报额度窗口' } : { windows };
}

// A turn's use. Codex counts the cached input inside its input (0.163.0 recorded: 15104 in, of
// them 12160 cached), so input here is what is left. It names no model and prices nothing.
function usageOf(value: unknown): Usage[] {
  const usage = object(value);
  const number = (key: string) => typeof usage?.[key] === 'number' ? usage[key] as number : 0;
  const cached = number('cached_input_tokens');
  return [{ inputTokens: Math.max(0, number('input_tokens') - cached), outputTokens: number('output_tokens'), cacheReadTokens: cached, cacheWriteTokens: number('cache_write_input_tokens') }];
}
// guess: authentication and quota wording has not been recorded yet.
function classify(message: string): ReadingError['kind'] {
  if (/\b(429|402)\b|quota|rate.limit|usage limit|credit balance/i.test(message)) return 'quota';
  if (/\b(401|403)\b|unauthorized|forbidden|not logged in|not authenticated|invalid api key/i.test(message)) return 'auth';
  return 'other';
}
// The top-level `error` and an `error` item go on past (a fallback notice, a configuration
// warning, "Reconnecting..."): the turn carries on, and only `turn.failed` stops it.
function diagnostic(message: unknown, level: DiagnosticLevel): NormalizedEvent[] {
  if (typeof message !== 'string') return [];
  return [level === 'fatal' ? { kind: 'diagnostic', level, message, cause: classify(message) } : { kind: 'diagnostic', level, message }];
}
const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;
const OPS: Record<string, FileChange['op']> = { add: 'add', update: 'update', delete: 'delete' };

// The changes a `file_change` item lists: a path and add, update or delete. No patch:
// Codex's JSON does not carry one.
function changesOf(item: Json): FileChange[] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((entry) => {
    const change = object(entry);
    const path = text(change?.path);
    if (!path) return [];
    const op = typeof change!.kind === 'string' ? OPS[change!.kind] : undefined;
    return [{ path, ...(op ? { op } : {}) }];
  });
}

// What one tool item is, from whichever of its lines arrives: an item carries all of it on
// `item.started` and again on `item.completed`.
function callOf(item: Json): ToolCall | undefined {
  switch (item.type) {
    case 'command_execution': {
      const command = text(item.command);
      if (!command) return undefined;
      const { title, category, paths } = readCommand(command);
      return { category, name: item.type, title, input: command, ...(paths ? { paths } : {}) };
    }
    // Recorded only from Codex's own protocol source: a change may come only completed.
    case 'file_change': {
      const paths = changesOf(item).map((change) => change.path);
      const title = paths.length > 1 ? `${paths[0]} 等 ${paths.length} 个文件` : paths[0] ?? item.type;
      return { category: 'edit', name: item.type, title, ...(paths.length ? { paths } : {}) };
    }
    case 'web_search': {
      const query = text(item.query);
      return { category: 'search', name: item.type, title: query ?? item.type, ...(query ? { input: query } : {}) };
    }
    case 'mcp_tool_call': {
      const tool = text(item.tool) ?? item.type;
      const server = text(item.server);
      const input = item.arguments === undefined ? undefined : JSON.stringify(item.arguments, null, 2);
      return { category: 'other', name: tool, title: server ? `${server} · ${tool}` : tool, ...(input ? { input } : {}) };
    }
    default:
      return undefined;
  }
}

// What an MCP call's result says: the text blocks of its content (recorded,
// fixtures/readonly/codex/codex-readonly-mcp.ndjson). A refusal comes this way too, with
// `error: null`; other kinds of block (an image) are not text to show.
function mcpText(result: unknown): string | undefined {
  const content = object(result)?.content;
  if (!Array.isArray(content)) return undefined;
  return text(content.flatMap((block) => {
    const each = object(block);
    return each?.type === 'text' && typeof each.text === 'string' ? [each.text] : [];
  }).join('\n'));
}

function endOf(id: string, item: Json, call: ToolCall): NormalizedEvent {
  const isError = item.status === 'failed' || item.status === 'declined';
  const output = text(item.aggregated_output) ?? mcpText(item.result);
  const reason = text(object(item.error)?.message) ?? (item.status === 'declined' ? 'Codex 没有批准，命令没有执行' : undefined);
  const changes = item.type === 'file_change' && !isError ? changesOf(item) : [];
  return {
    kind: 'tool.end',
    id,
    isError,
    call,
    ...(output ? { output: { text: output } } : {}),
    ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
    ...(reason ? { reason } : {}),
    ...(changes.length ? { changes } : {}),
  };
}

function events(line: Json): NormalizedEvent[] {
  if (line.type === 'error') return diagnostic(line.message, 'warning');
  if (line.type === 'turn.failed') return diagnostic(object(line.error)?.message, 'fatal');
  if (line.type === 'turn.completed') return [{ kind: 'usage', usage: usageOf(line.usage) }, { kind: 'turn.end' }];
  if (line.type !== 'item.started' && line.type !== 'item.completed') return [];
  const item = object(line.item);
  if (!item || typeof item.type !== 'string') return [];
  if (line.type === 'item.completed' && item.type === 'error') return diagnostic(item.message, 'warning');
  if (line.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') return [{ kind: 'text', text: item.text }];
  if (line.type === 'item.completed' && item.type === 'reasoning' && typeof item.text === 'string') return [{ kind: 'thinking', text: item.text }];
  if (typeof item.id !== 'string') return [];
  const call = callOf(item);
  if (!call) return [];
  return line.type === 'item.started' ? [{ kind: 'tool.start', id: item.id, ...call }] : [endOf(item.id, item, call)];
}

// Codex takes its tier on the command line, one argument per line. What an argument
// cannot carry is a NUL; what a value cannot carry is the newline that would have ended
// its line.
function checkTier(tier: Tier): string | undefined {
  const text = tier.text;
  const why = checkTierText(text);
  if (why) return why;
  if (text.includes('\0')) return '内容里有 tycho 传不过去的字符';
  for (const { at, line } of codexLines(text)) {
    const equal = line.indexOf('=');
    if (equal < 0) return `第 ${at} 行没有 =，每行要写成 键=值`;
    if (line.slice(0, equal).trim() === '') return `第 ${at} 行的键是空的，每行要写成 键=值`;
  }
  return undefined;
}

// The device-code screen, colours taken off: the first https link and the first code shaped as
// the CLI prints one (four characters, a hyphen, five). Both or nothing — a link alone is a
// screen still being printed.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const DEVICE_URL = /https:\/\/[^\s\x00-\x1f]+/;
const DEVICE_CODE = /(?<![A-Za-z0-9-])[A-Z0-9]{4}-[A-Z0-9]{5}(?![A-Za-z0-9-])/;
export function readDeviceAuth(output: string): { url: string; code: string } | undefined {
  const plain = String(output).replace(CONTROL, '');
  const url = DEVICE_URL.exec(plain)?.[0];
  const code = DEVICE_CODE.exec(plain)?.[0];
  return url === undefined || code === undefined ? undefined : { url, code };
}

const RECEIPT_BLOCK_RE = /```receipt[^\S\n]*\r?\n[\s\S]*?\r?\n?```/;

function createCodexResultReader(limits?: ResultLimits): ResultReader {
  const reading: Reading = { finished: false };
  let error: ReadingError | undefined;
  let turnFailed = false;
  return createResultReader({
    line(text) {
      const line = lineOf(text);
      if (!line) return false;
      let changed = false;
      if (line.type === 'thread.started' && typeof line.thread_id === 'string') {
        reading.sessionRef = line.thread_id;
        changed = true;
      }
      if (line.type === 'turn.completed') {
        reading.finished = true;
        reading.usage = addUsage(reading.usage ?? [], usageOf(line.usage));
        changed = true;
      }
      if (line.type === 'turn.failed') {
        turnFailed = true;
        changed = true;
      }
      for (const event of events(line)) {
        if (event.kind === 'text') {
          if (
            reading.text !== undefined &&
            RECEIPT_BLOCK_RE.test(reading.text) &&
            !RECEIPT_BLOCK_RE.test(event.text)
          ) {
            reading.text = `${reading.text}\n\n${event.text}`;
          } else {
            reading.text = event.text;
          }
          changed = true;
        }
        if (event.kind === 'diagnostic') {
          error = { kind: event.cause ?? classify(event.message), message: event.message };
          changed = true;
        }
      }
      return changed;
    },
    state: () => ({ reading, error, turnFailed }),
    finish(exitCode, stderr) {
      // Error events alone do not fail a Run: the recordings show a metadata warning
      // as an item error and "Reconnecting..." as top-level errors, and a turn can
      // still complete after either. Only a failed turn or a non-zero exit does.
      if (turnFailed || (exitCode !== null && exitCode !== 0)) {
        const message = error?.message || stderr.trim().slice(-2000) || `进程退出码 ${exitCode}`;
        reading.error = { kind: classify(message), message };
      }
      return reading;
    },
  }, limits);
}

export const codexAdapter: Adapter = {
  canRoute: true,
  // An API key is a login tycho can keep: `codex exec` takes it from this variable of its
  // launching environment, over whatever login the machine has of its own (recorded,
  // tests/fixtures/codex/0.162.0/api-key). A ChatGPT login is not one — the vendor rotates
  // it, so a copy on a second machine puts the first one out — and stays a machine's own.
  // No `credentialCheck`: `codex login status` does not look at this variable (measured on
  // 0.167.1: an empty CODEX_HOME with the variable set still answers Not logged in), so there
  // is no way to ask, without spending quota, whether a round would take the key. The
  // recording above is the whole of the claim.
  credential: () => ({ variable: 'CODEX_API_KEY' }),
  prepareCredential({ variable, credential, scratchDir, baseExecutorDir, taskDir }) {
    if (!isCodexOAuthSecret(credential) && !isCodexOAuthLease(credential)) {
      return { [variable]: credential };
    }
    const lease = decodeCodexOAuthLease(credential);
    if (!lease) throw new Error('Codex 授权凭据损坏，无法为这一轮准备隔离登录目录');
    const targetHome = taskDir ? join(taskDir, 'codex-home') : join(scratchDir, 'codex-home');
    return materializeCodexWorkerHome(lease, targetHome, baseExecutorDir);
  },
  secretStrings: codexSecretStrings,
  // Host-brokered ChatGPT device-auth comes first (one login on Host, leased with refresh_token
  // stripped to every machine), followed by OpenAI API key; 'machine' is used by machines.tsx only.
  accountLogin: ['device', 'key', 'machine'],
  // Recorded (tests/fixtures/login-status): `codex --version` prints its version on stdout.
  probe: { command: 'codex', version: ['--version'] },
  // Recorded (tests/fixtures/login-status): `codex login status` answers on its exit code —
  // 0 signed in — and prints its wording on stderr, where nothing reads it. The expired-token
  // case is not recorded.
  loginStatus: ['login', 'status'],
  identityTalk: {
    argv: ['codex', 'app-server', '--listen', 'stdio://'],
    steps: (version) => accountSteps(version, 'account/read', { refreshToken: false }),
    parse: (line) => {
      const result = object(lineOf(line)?.result);
      if (result?.account === null) return { accountLabel: null, quotaOwner: null };
      const account = object(result?.account);
      if (account?.type === 'apiKey') return { accountLabel: null, quotaOwner: null };
      if (account?.type !== 'chatgpt') return {};
      return codexEmailIdentity(account.email, account.planType);
    },
  },
  // A ChatGPT login rotates its own tokens, so it stays on the machine that made it: the
  // device-code sign-in runs there, prints a link and a one-time code, and ends 0 once the owner
  // has entered the code elsewhere (tests/fixtures/codex/0.162.0/login-device). Only those two
  // are read off the screen; the success screen is not recorded and not read.
  signIn: { argv: ['codex', 'login', '--device-auth'], read: readDeviceAuth },
  // Native Codex session resume via `codex exec ... resume --all <sessionRef> <prompt>`.
  resumable: true,
  permissionModes: PERMISSION_MODES,
  readOnly: {
    layer: 'contract',
    args: NON_INTERACTIVE_ARGS,
  },
  globalEntry: GLOBAL_ENTRY,
  memory: MEMORY,
  config: CONFIG,
  // A tier is one `键=值` per line; the form edits the model and the reasoning effort and
  // leaves every other line, and the exact way its value was written, as it was.
  tierForm: { ...KEY_VALUE_LINES, fields: ['model', 'effort'], efforts: TIER_EFFORTS },
  // A login adopted from what a machine reports signed in runs on the machine's own model,
  // with the strength each tier is for.
  ownLoginTiers: { decide: { effort: 'high' }, execute: { effort: 'medium' } },
  checkTier,
  // The CLI's own catalog, which it prints without a login and without the network.
  listModels: () => ({ kind: 'command', argv: ['codex', 'debug', 'models'], parse: parseCodexModels }),
  // A ChatGPT login lives on the machine that made it, so its quota is asked there and only
  // there (docs/design/usage.md §3): the app-server on stdio, two request lines, and the
  // rate-limit answer. Measured on 0.167.1 (tests/fixtures/codex/0.167.1/rate-limits): 2.2
  // seconds to initialize, 3.7 to answer, no turn run and no quota spent. The account id the
  // answer carries does not leave the machine.
  machineQuota: { kind: 'talk', argv: ['codex', 'app-server', '--listen', 'stdio://'], steps: (version) => accountSteps(version, 'account/rateLimits/read'), parse: parseRateLimits },
  launch(turn) {
    const tierEntries = codexSettings(turn.tier.text);
    const tier = tierEntries.flatMap(({ key, value }) => ['-c', `${key}=${value}`]);
    const access = [...NON_INTERACTIVE_ARGS, ...sandboxArgs(turn, tierEntries), ...writableRoots(turn)];
    return {
      argv: [
        'codex', 'exec', '--json', ...tier, ...access,
        '--skip-git-repo-check', '-C', turn.workdir, turn.prompt,
      ],
      env: {},
    };
  },
  resume(turn) {
    if (!turn.sessionRef) throw new Error('续接需要 session_ref');
    const tierEntries = codexSettings(turn.tier.text);
    const tier = tierEntries.flatMap(({ key, value }) => ['-c', `${key}=${value}`]);
    const access = [...NON_INTERACTIVE_ARGS, ...sandboxArgs(turn, tierEntries), ...writableRoots(turn)];
    return {
      argv: [
        'codex', 'exec', '--json', ...tier, ...access,
        '--skip-git-repo-check', '-C', turn.workdir,
        'resume', '--all', turn.sessionRef, turn.prompt,
      ],
      env: {},
    };
  },
  parse(text) { const line = lineOf(text); return line ? events(line) : []; },
  resultReader: createCodexResultReader,
  result(stdout, exitCode, stderr) {
    return batchResult(createCodexResultReader(), stdout, exitCode, stderr);
  },
};
