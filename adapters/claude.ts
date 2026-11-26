import { createResultReader, batchResult } from './result-stream.ts';
import type { ResultLimits, ResultReader } from './result-stream.ts';
import { claudeQuotaWindow } from '../shared/claude-quota.ts';
import type { Adapter, FileChange, Launch, ModelInfo, NormalizedEvent, QuotaReading, QuotaWindow, Reading, ReadingError, Tier, ToolCall, ToolCategory, Turn, Usage } from './types.ts';
import { emailAccountLabel, maskEmailIdentity, organizationIdOf, planLabelOf, type ExecutorIdentity } from '../shared/logins.ts';
import { inputText } from './shell.ts';
import { addUsage } from './usage.ts';
import { checkTierText } from './tier.ts';
import { SETTINGS_JSON } from '../shared/tier-form.ts';

type Json = Record<string, any>;

const STDERR_TAIL = 2000;

// The account's own list, asked of the API with the account's token. The headers are the
// API's own: the version it reads, and the beta a long-lived token belongs to.
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
const MODELS_HEADERS = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' };
// An option line of the CLI's help: its columns, and the description that wraps under them.
const HELP_OPTION = /^\s{0,4}-{1,2}[^\s]/;

const CATEGORIES: Record<string, ToolCategory> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  BashOutput: 'run',
  PowerShell: 'run',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
};

// Measured on a cluster instance with CLI 2.1.312: under acceptEdits a headless Worker is
// refused every command that changes anything (git init, python3), so it cannot do its
// work. The machine is the isolation boundary, as it is for Codex.
const WORKER_MODE = 'bypassPermissions';
// What the CLI's own `--permission-mode` takes, which is also what an account may name.
const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'default', 'plan'];
// What its own `--effort` takes, read from the CLI's help on 2.1.303 ("low, medium, high,
// xhigh, max"); a settings file carries the same level as `effortLevel`.
const TIER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// A settings file the CLI cannot read is dropped whole: the round then runs on the
// machine's own tier, with exit code 0 and nothing said. Tycho validates JSON syntax only
// and passes native Claude settings through without imposing an extra key blacklist.
function settingsProblem(text: string): string | undefined {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    return `不是合法的 JSON：${(err as Error).message}`;
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return '应为一份 settings 对象';
  return undefined;
}

// Which organization this machine's own `claude.ai` login belongs to, read from the same
// `claude auth status` answer the login probe already asked for (no second command). Only a
// personal subscription can prove "the same member": a pro or max plan, with a well-formed
// org id. A team or shared organization names an organization, not the member behind it, so
// it reports no organization and two logins on it never group. Only a validated short
// handle derived from the email leaves the machine; the full address stays here.
function formatClaudePlan(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower === 'pro') return 'Pro';
  if (lower === 'max') return 'Max';
  if (lower === 'team') return 'Team';
  if (lower === 'enterprise') return 'Enterprise';
  return planLabelOf(raw.trim());
}

function loginIdentity(stdout: string): ExecutorIdentity {
  let answer: unknown;
  try { answer = JSON.parse(stdout); } catch { return {}; }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return {};
  const said = answer as Json;
  if (said.authMethod !== 'claude.ai' || said.loggedIn === false) return { organizationId: null, accountLabel: null, planLabel: null };
  const accountLabel = maskEmailIdentity(said.email) ?? emailAccountLabel(said.email);
  const planLabel = formatClaudePlan(said.subscriptionType);
  const organizationId = said.subscriptionType === 'pro' || said.subscriptionType === 'max' ? organizationIdOf(said.orgId) : undefined;
  return { organizationId: organizationId ?? null, accountLabel: accountLabel ?? null, planLabel: planLabel ?? null };
}

// The CLI reads a settings file or a JSON string; tycho always hands it a file, so that
// the tier's text never reaches a command line and both executors have one shape.
function checkTier(tier: Tier): string | undefined {
  return checkTierText(tier.text) ?? settingsProblem(tier.text);
}

// What `--settings` is handed: the file the caller wrote the tier's text to.
function settingsOf(path?: string): string {
  if (path === undefined) throw new Error('档位内容的快照路径没有给出');
  return path;
}

function command(turn: Turn, extra: string[] = []): Launch {
  return {
    argv: [
      'claude',
      '-p',
      turn.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--settings',
      settingsOf(turn.tierPath),
      '--permission-mode',
      turn.permissionMode ?? WORKER_MODE,
      '--add-dir',
      turn.workdir,
      // The round's material is not under the working directory when the code is a repository
      // checkout or a folder on the machine (docs/design/code-sources.md §2): Claude reads it
      // by an absolute path the machine put in the prompt, and needs this to be allowed there.
      ...(turn.materialsDir === undefined ? [] : ['--add-dir', turn.materialsDir]),
      // Where this round delivers what it made (also outside the working directory): always
      // passed when present, including read-only rounds so review/report artifacts can be written.
      ...(turn.artifactsDir === undefined ? [] : ['--add-dir', turn.artifactsDir]),
      ...extra,
    ],
    env: {
      ...((turn.permissionMode ?? WORKER_MODE) === 'bypassPermissions' ? { IS_SANDBOX: '1' } : {}),
    },
  };
}

// Where the CLI reads instructions for every session (docs/spike/global-entry.md): every file
// in the rules directory of its configuration directory is a user memory file of its own,
// beside CLAUDE.md, so tycho has a file of its own there and never touches the owner's CLAUDE.md.
const ENTRY_FILE = 'rules/tycho-knowledge.md';
const GLOBAL_ENTRY = {
  home: { env: 'CLAUDE_CONFIG_DIR', dir: '.claude' },
  file: ENTRY_FILE,
};
// Auto memory passes through natively; tycho does not disable Claude's own memory.
const MEMORY = { scope: 'shared' as const };
// What a machine lists of the CLI's own configuration, spending nothing (the same recordings):
// the plugins it has installed. `claude mcp list` health-checks every approved server, which is
// starting it, so the MCP servers are not asked.
const CONFIG = [
  { kind: 'plugins' as const, argv: ['claude', 'plugin', 'list', '--json'], parse: parsePlugins },
  { kind: 'mcp' as const, unasked: 'claude mcp list 会把已批准的 MCP 服务器逐个起起来做检查，所以不问' },
  { kind: 'connectors' as const, unasked: '随 claude.ai 登录带来的远端连接器，机器上问不出来' },
];

// The ids `claude plugin list --json` lists, `name@marketplace`, of the plugins enabled.
function parsePlugins(stdout: string): string[] | undefined {
  let answer: unknown;
  try { answer = JSON.parse(stdout); } catch { return undefined; }
  if (!Array.isArray(answer)) return undefined;
  return answer.flatMap((each: Json) => (each !== null && typeof each === 'object' && typeof each.id === 'string' && each.enabled !== false ? [each.id] : []));
}

function parseLine(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

// Which strengths one model of the API's answer takes: the entries of `capabilities.effort`
// whose `supported` is true; beside them the object has a `supported` of its own. Anything else
// there is not a strength this model has, and a
// shape that says nothing yields nothing rather than a guess.
function effortsOf(model: Json): string[] | undefined {
  const effort: unknown = model.capabilities?.effort;
  if (effort === null || typeof effort !== 'object' || Array.isArray(effort)) return undefined;
  const listed: unknown = (effort as Json).supported;
  if (listed === false) return [];
  const names = Array.isArray(listed)
    ? listed.filter((each): each is string => typeof each === 'string')
    : Object.entries(effort as Record<string, unknown>)
        .filter(([name]) => name !== 'supported')
        .filter(([, value]) => value === true || (value !== null && typeof value === 'object' && (value as Json).supported === true))
        .map(([name]) => name);
  return names.length > 0 ? names : undefined;
}

// One model per entry that names itself, in the order the API lists them.
function parseModels(body: string): ModelInfo[] {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    return [];
  }
  const data = answer !== null && typeof answer === 'object' ? (answer as Json).data : undefined;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const model = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Json) : undefined;
    const id = model?.id;
    if (!model || typeof id !== 'string' || id === '') return [];
    const name = typeof model.display_name === 'string' && model.display_name !== '' ? model.display_name : undefined;
    const efforts = effortsOf(model);
    return [{ id, ...(name === undefined ? {} : { name }), ...(efforts === undefined ? {} : { efforts }) }];
  });
}

// The words the help puts in quotes, or the list in its parentheses: `--model` names the
// aliases it takes, `--effort` the levels. Either is written somewhere different from
// version to version, so an answer that names nothing yields nothing.
function listed(block: string): string[] {
  const quoted = [...block.matchAll(/['"`]([^'"`\s]+)['"`]/g)].map((match) => match[1]!);
  if (quoted.length > 0) return quoted;
  const inside = /\(([^)]*)\)/.exec(block);
  if (!inside) return [];
  return inside[1]!.split(',').map((each) => each.trim()).filter((each) => /^[\w.:-]+$/.test(each));
}

// One option of the help and the lines its description wraps onto, up to the next option.
function helpBlock(help: string, option: string): string {
  const lines = help.split('\n');
  const at = lines.findIndex((line) => line.trimStart().startsWith(option));
  if (at < 0) return '';
  const rest = lines.slice(at + 1);
  const next = rest.findIndex((line) => HELP_OPTION.test(line));
  return [lines[at]!, ...(next < 0 ? rest : rest.slice(0, next))].join('\n');
}

// Without a token there is nobody to ask for the account's own list; what the help writes
// down — the aliases `--model` takes and the levels `--effort` takes — is what there is.
// The levels are the CLI's, not one model's, so each alias is offered with all of them.
function parseHelp(help: string): ModelInfo[] {
  const efforts = listed(helpBlock(help, '--effort'));
  return listed(helpBlock(help, '--model')).map((id) => ({ id, ...(efforts.length === 0 ? {} : { efforts: [...efforts] }) }));
}

// What one result line adds, per model. The CLI's per-model figures since its last result are
// this turn's own, whether the process was resumed or keeps running for the Router; its
// cumulative `modelUsage` is not (a resumed round's includes the rounds before it, 2.1.309
// recorded), so its figures are never read. A CLI without them (2.1.303 recorded) leaves the
// turn's main-thread figures, with no price; the model is named only when the session has used
// exactly one, the one its cumulative figures are keyed by. The CLI prices use itself only at
// list prices, and says so: a price on any other basis is not taken.
function usageOf(line: Json): Usage[] {
  const perModel = line.model_usage_since_last_result as Json | undefined;
  if (perModel && typeof perModel === 'object') {
    return Object.entries(perModel).flatMap(([model, figures]: [string, Json]) => {
      if (!figures || typeof figures !== 'object') return [];
      const count = (key: string): number => (typeof figures[key] === 'number' ? figures[key] : 0);
      return [{
        model,
        inputTokens: count('inputTokens'),
        outputTokens: count('outputTokens'),
        cacheReadTokens: count('cacheReadInputTokens'),
        cacheWriteTokens: count('cacheCreationInputTokens'),
        ...(figures.costBasis === 'list' && typeof figures.costUSD === 'number' ? { listCostUsd: figures.costUSD } : {}),
      }];
    });
  }
  const usage = line.usage as Json | undefined;
  if (!usage) return [];
  const models = line.modelUsage && typeof line.modelUsage === 'object' ? Object.keys(line.modelUsage as Json) : [];
  return [{
    ...(models.length === 1 ? { model: models[0]! } : {}),
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  }];
}

// (status 429 with api_error "model_requires_usage_credits"); a used-up five-hour window
// is the coordinator's sample (tests/fixtures/claude/coordinator-sample). The other status codes and error names come from the
// API's published errors, and the text patterns cover what the CLI prints.
function classify(message: string, status: unknown, code?: unknown): ReadingError['kind'] {
  if (status === 429 || status === 402 || code === 'rate_limit' || code === 'billing_error' || code === 'usage_limit_reached') return 'quota';
  if (status === 401 || status === 403 || code === 'authentication_failed') return 'auth';
  if (/usage limit|hit your (?:\w+ )?limit|quota|credit balance/i.test(message)) return 'quota';
  if (/not logged in|invalid api key|please run \/login/i.test(message)) return 'auth';
  return 'other';
}

// The recordings carry the event as a line type of its own; the coordinator's sample
// carries it as a system line. Both are read: the body is the same.
function rateLimitInfo(line: Json | undefined): Json | undefined {
  const named = line?.type === 'rate_limit_event' || (line?.type === 'system' && line.subtype === 'rate_limit_event');
  const info: unknown = named ? line.rate_limit_info : undefined;
  return info !== null && typeof info === 'object' && !Array.isArray(info) ? (info as Json) : undefined;
}

// Epoch seconds, as the CLI writes them.
const instant = (seconds: unknown): string | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

const share = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1;

// One event per window the line gives a share for. A line that only says "allowed" says
// nothing about how much is used, and yields nothing.
function quotaEvents(info: Json): Extract<NormalizedEvent, { kind: 'quota' }>[] {
  const windows: unknown = info.unifiedWindows;
  if (windows !== null && typeof windows === 'object' && !Array.isArray(windows)) {
    return Object.entries(windows as Record<string, Json | null>)
      .filter(([, each]) => share(each?.utilization))
      .map(([window, each]) => ({ kind: 'quota', window: claudeQuotaWindow(window), used: each!.utilization, resetsAt: instant(each!.resetsAt) }));
  }
  if (typeof info.rateLimitType !== 'string' || !share(info.utilization)) return [];
  return [{ kind: 'quota', window: claudeQuotaWindow(info.rateLimitType), used: info.utilization, resetsAt: instant(info.resetsAt) }];
}

// One window line of what `/usage` shows, verbatim: "<窗口名>: <数>% used · resets <时刻>
// (<时区>)". Names use the same identifiers as HTTP headers and rate_limit_event; a line
// with no reset time is still a window.
const USAGE_WINDOW = /^(.+?):\s*([0-9]+(?:\.[0-9]+)?)%\s+used(?:\s*·\s*resets\s+(.+?))?\s*$/;
function usageWindowName(name: string): string {
  if (name === 'Current session') return 'five_hour';
  const week = /^Current week \(([^()]+)\)$/.exec(name);
  if (!week) return name;
  const model = week[1]!.trim().toLowerCase();
  return model === 'all models' ? 'seven_day' : `seven_day_${model}`;
}
// The reset time it prints: "Nov 15, 7am (Asia/Shanghai)", with an optional minute. The zone
// is the line's own; without one the moment is not read, rather than read in the reader's.
const USAGE_RESET = /^([A-Za-z]{3,})\s+([0-9]{1,2}),?\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?\s*\(([^()]+)\)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The twelve-hour clock as the twenty-four it names. No marker: the hour is the hour.
function hour24(hour: number, marker: string | undefined): number | undefined {
  if (!(hour >= 1 && hour <= 12) || (marker !== undefined && hour > 12)) return undefined;
  const pm = marker?.toLowerCase() === 'pm';
  return hour % 12 + (pm ? 12 : 0);
}

const OFFSET_FORMATS = new Map<string, Intl.DateTimeFormat>();
// The wall-clock fields a zone shows at one instant. An unknown zone is an error here, and
// the caller takes it as "the moment cannot be read".
function partsAt(zone: string, at: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let format = OFFSET_FORMATS.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    OFFSET_FORMATS.set(zone, format);
  }
  const parts = format.formatToParts(new Date(at));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: field('year'), month: field('month'), day: field('day'), hour: field('hour'), minute: field('minute'), second: field('second') };
}

// How far the zone is ahead of UTC at one instant.
const offsetMs = (zone: string, at: number): number => {
  const { year, month, day, hour, minute, second } = partsAt(zone, at);
  return Date.UTC(year, month - 1, day, hour, minute, second) - at;
};

// The instant a wall-clock moment names in one zone, or nothing when the zone is unknown or
// that moment never happens there (an hour a daylight-saving jump skips): the candidate is
// read back, and a moment the zone does not show at that instant is not that moment.
function zonedInstant(zone: string, year: number, wall: { month: number; day: number; hour: number; minute: number }): number | undefined {
  const guess = Date.UTC(year, wall.month - 1, wall.day, wall.hour, wall.minute);
  try {
    // The zone's offset at the guess, then again at the instant that offset names: the second
    // one holds when a daylight-saving change is near.
    const at = guess - offsetMs(zone, guess - offsetMs(zone, guess));
    const back = partsAt(zone, at);
    return back.year === year && back.month === wall.month && back.day === wall.day && back.hour === wall.hour && back.minute === wall.minute ? at : undefined;
  } catch {
    return undefined;
  }
}

// When the line's reset time is, as an instant: the next moment the zone shows that wall
// clock, which is what "Nov 15, 7am" means for a weekly window. Nothing readable leaves the
// figure without a reset time — the share is still the executor's own number.
function resetInstant(text: string | undefined, now: number): string | null {
  const found = text === undefined ? null : USAGE_RESET.exec(text.trim());
  if (found === null) return null;
  const month = MONTHS.indexOf(found[1]!.slice(0, 3).toLowerCase()) + 1;
  const day = Number(found[2]);
  const hour = hour24(Number(found[3]), found[5]);
  const minute = found[4] === undefined ? 0 : Number(found[4]);
  if (month === 0 || !(day >= 1 && day <= 31) || hour === undefined || !(minute >= 0 && minute <= 59)) return null;
  const zone = found[6]!.trim();
  let year: number;
  try {
    year = partsAt(zone, now).year;
  } catch {
    return null;
  }
  for (const ahead of [0, 1]) {
    const at = zonedInstant(zone, year + ahead, { month, day, hour, minute });
    if (at !== undefined && at > now) return new Date(at).toISOString();
  }
  return null;
}

// What `claude -p "/usage" --output-format json` answers, run as the machine's own login
// (recorded on 2.1.303: tests/fixtures/claude/2.1.303/usage). It runs no turn and spends
// nothing; the CLI's result envelope carries the text `/usage` shows, and only its window
// lines are read. The rest of that text — what this machine's own sessions used — stays on
// the machine. A text with no window line is "没读到窗口", never a guess.
function parseUsageText(stdout: string): QuotaReading {
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return { problem: 'claude 的回答读不出来' };
  }
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return { problem: 'claude 的回答读不出来' };
  const { type, result: text, is_error: failed } = answer as Json;
  if (type !== 'result' || typeof text !== 'string') return { problem: 'claude 的回答读不出来' };
  if (failed === true) return { problem: 'claude 没有完成额度读取' };
  const now = Date.now();
  const windows: QuotaWindow[] = [];
  for (const line of text.split('\n')) {
    const found = USAGE_WINDOW.exec(line.trim());
    if (found === null) continue;
    const window = found[1]!.trim();
    const used = Number(found[2]) / 100;
    if (window === '' || !(used >= 0 && used <= 1)) continue;
    windows.push({ window: usageWindowName(window), used, resets_at: resetInstant(found[3], now) });
  }
  return windows.length === 0 ? { windows: [], absent: true } : { windows };
}

function streamEvents(line: Json): NormalizedEvent[] {
  const event = line.event as Json | undefined;
  if (event?.type !== 'content_block_delta') return [];
  const delta = event.delta as Json | undefined;
  if (delta?.type === 'text_delta') return [{ kind: 'text', text: delta.text }];
  if (delta?.type === 'thinking_delta') return [{ kind: 'thinking', text: delta.thinking }];
  return [];
}

function contentOf(line: Json): Json[] {
  const content: unknown = (line.message as Json | undefined)?.content;
  return Array.isArray(content) ? content.filter((block) => block !== null && typeof block === 'object') : [];
}

const string = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

// The short line a call of one of the CLI's own tools is shown by: what it says it does
// for a command, the file for a file tool, the pattern for a search. Anything else by name.
function titleOf(name: string, input: Json): string {
  return string(input.description) ?? string(input.file_path) ?? string(input.notebook_path) ?? string(input.pattern)
    ?? string(input.command) ?? string(input.url) ?? string(input.query) ?? name;
}

function callOf(block: Json): ToolCall {
  const name = String(block.name);
  const input = block.input !== null && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input as Json : {};
  const path = string(input.file_path) ?? string(input.notebook_path);
  const full = inputText(input);
  return {
    category: CATEGORIES[name] ?? 'other',
    name,
    title: titleOf(name, input),
    ...(full ? { input: full } : {}),
    ...(path ? { paths: [path] } : {}),
  };
}

// A tool result's content is a string or a list of blocks; the text blocks are what the
// model was handed back.
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return string(content);
  if (!Array.isArray(content)) return undefined;
  return string(content.flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n'));
}

// The patch the file tools hand back (`structuredPatch`, unified hunks with their lines
// already marked), when there is one: a file written whole has none.
function patchOf(hunks: unknown): string | undefined {
  if (!Array.isArray(hunks)) return undefined;
  const text = hunks.flatMap((hunk) => {
    if (!hunk || !Array.isArray(hunk.lines)) return [];
    return [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines.map(String)];
  });
  return text.length ? text.join('\n') : undefined;
}

// Recorded (2.1.312-linux/denied.ndjson): Write answers `{type: "create", filePath, structuredPatch: []}`;
// an edit answers `update` with its hunks, from the CLI's own result type.
function changesOf(result: unknown): FileChange[] {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return [];
  const { filePath, type, structuredPatch } = result as Json;
  const path = string(filePath);
  if (!path) return [];
  const op = type === 'create' ? 'add' : type === 'update' ? 'update' : undefined;
  const patch = patchOf(structuredPatch);
  return [{ path, ...(op ? { op } : {}), ...(patch ? { patch } : {}) }];
}

function endsOf(line: Json): NormalizedEvent[] {
  const results = contentOf(line).filter((block) => block.type === 'tool_result');
  // The line's `tool_use_result` belongs to its one result; with several it is nobody's.
  const extra = results.length === 1 ? line.tool_use_result : undefined;
  return results.map((block) => {
    const isError = block.is_error === true;
    const said = resultText(block.content);
    const changes = isError ? [] : changesOf(extra);
    return {
      kind: 'tool.end',
      id: block.tool_use_id,
      isError,
      ...(said ? (isError ? { reason: said } : { output: { text: said } }) : {}),
      ...(changes.length ? { changes } : {}),
    };
  });
}

function resultEvents(line: Json): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (line.is_error) {
    const message = String(line.result ?? '');
    events.push({ kind: 'diagnostic', level: 'fatal', message, cause: classify(message, line.api_error_status, line.api_error) });
  }
  const usage = usageOf(line);
  if (usage.length > 0) events.push({ kind: 'usage', usage });
  events.push({ kind: 'turn.end' });
  return events;
}

function createClaudeResultReader(limits?: ResultLimits): ResultReader {
  let last: Json | undefined;
  let sessionRef: string | undefined;
  let usage: Usage[] = [];
  let errorCode: unknown;
  // When the window the CLI last named as the one in force starts over.
  let resetsAt: string | null = null;
  return createResultReader({
    line(text) {
      const line = parseLine(text);
      if (!line) return false;
      let changed = false;
      const limits = rateLimitInfo(line);
      if (limits) {
        resetsAt = instant(limits.resetsAt);
        changed = true;
      }
      // An interrupted Worker has no result line, yet a resume still needs this.
      if (typeof line.session_id === 'string' && sessionRef === undefined) {
        sessionRef = line.session_id;
        changed = true;
      }
      if (line.type === 'assistant' && line.is_api_error_message) {
        errorCode = line.error;
        changed = true;
      }
      if (line.type === 'result') {
        last = line;
        usage = addUsage(usage, usageOf(line));
        changed = true;
      }
      return changed;
    },
    state: () => ({ last, sessionRef, usage, errorCode, resetsAt }),
    finish(exitCode, stderr) {
      const session = sessionRef === undefined ? {} : { sessionRef };
      const stderrTail = stderr.trim().slice(-STDERR_TAIL);
      const failure = (message: string, status: unknown, code: unknown): ReadingError => {
        const kind = classify(message, status, code);
        return { kind, message, ...(kind === 'quota' && resetsAt ? { resetsAt } : {}) };
      };

      if (!last) {
        const reading: Reading = { ...session, finished: false };
        if (exitCode === null) return reading;
        const message = stderrTail || `进程退出码 ${exitCode}，没有结果`;
        return { ...reading, error: failure(message, undefined, errorCode) };
      }

      const text = typeof last.result === 'string' ? last.result : undefined;
      const reading: Reading = {
        ...(text === undefined ? {} : { text }),
        ...(typeof last.session_id === 'string' ? { sessionRef: last.session_id } : session),
        ...(usage.length > 0 ? { usage } : {}),
        finished: true,
      };
      // subtype stays "success" on failure in the recording, so it is not consulted.
      const failed = last.is_error === true || (exitCode !== null && exitCode !== 0);
      if (!failed) return reading;
      const message = (last.is_error ? text : undefined) || stderrTail || `进程退出码 ${exitCode}`;
      return { ...reading, error: failure(message, last.api_error_status, last.api_error ?? errorCode) };
    },
  }, limits);
}

export const claudeAdapter: Adapter = {
  // A long-lived token from `claude setup-token` is about a year (docs/design/native-login.md
  // §2, ruling L). The vendor gives no exact date, so this is what an estimate rests on.
  credentialLifetimeDays: 365,
  // Recorded (2.1.303, Windows: tests/fixtures/claude/2.1.303-win/auth-status): a long-lived
  // token handed over in this variable is the login the CLI uses, and it beats the machine's
  // own login. A token on a file descriptor is not read at all on that version, which is why
  // there is no such way any more (docs/spike/claude-credential-way.md).
  credential: () => ({ variable: 'CLAUDE_CODE_OAUTH_TOKEN' }),
  // `claude setup-token` signs in on Claude's own page and prints a token that lasts
  // (docs/design/native-login.md). That is the one way in: a token is never typed into a page.
  accountLogin: ['page'],
  canRoute: true,
  // From a recording of the CLI itself (tests/fixtures/login-status): `claude --version`
  // prints its version on stdout, and exits 0 when there is one.
  probe: { command: 'claude', version: ['--version'] },
  // The native installer puts the command in ~/.local/bin, which may not be on PATH; the
  // Windows desktop app keeps copies of its own under %LOCALAPPDATA%\Claude-Data (one
  // directory per installation, one per version, one named by a hash), and the newest version
  // is the one it last updated to. Both measured on the controller workstation.
  installs: [
    { kind: 'under', platforms: ['win32'], variable: 'USERPROFILE', path: ['.local', 'bin', 'claude.exe'] },
    { kind: 'under', platforms: ['linux', 'darwin'], variable: 'HOME', path: ['.local', 'bin', 'claude'] },
    { kind: 'under', platforms: ['win32'], variable: 'LOCALAPPDATA', path: ['Claude-Data', '*', 'claude-code', '<version>', '*', 'claude.exe'] },
  ],
  // From the CLI's documentation, not from a recording: exits 0 when signed in. The same
  // answer's organization id is read by `loginIdentity` below; no second command is run.
  loginStatus: ['auth', 'status'],
  loginIdentity,
  resumable: true,
  permissionModes: PERMISSION_MODES,
  globalEntry: GLOBAL_ENTRY,
  memory: MEMORY,
  config: CONFIG,
  // Measured with setup-token on 2026-11-12: /api/oauth/usage needs user:profile;
  // count_tokens has no quota headers. A one-token message does report the windows.
  // The model list carries no price or size: use its first entry rather than inventing
  // a price table or naming a model that this account may not have.
  quotaRead: ({ token, models }) => {
    const model = models[0]?.id;
    if (!model) throw new Error('这个账号没有可用的模型，无法读额度');
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { Authorization: `Bearer ${token}`, ...MODELS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: '1' }] }),
      parse: (headers, body) => {
        const windows: Record<string, Json> = {};
        for (const [name, value] of headers) {
          const match = /^anthropic-ratelimit-unified-(.+)-utilization$/.exec(name);
          if (!match || value.trim() === '') continue;
          const nameOfWindow = match[1]!;
          const reset = headers.get(`anthropic-ratelimit-unified-${nameOfWindow}-reset`);
          const seconds = reset === null || reset.trim() === '' ? NaN : Number(reset);
          // Normalize only the API's known spellings; retain additional windows as reported.
          const window = ({ '5h': 'five_hour', '7d': 'seven_day' } as Record<string, string>)[nameOfWindow] ?? nameOfWindow.replaceAll('-', '_');
          windows[window] = { utilization: Number(value), resetsAt: Number.isFinite(seconds) && Math.abs(seconds * 1000) <= 8.64e15 ? seconds : undefined };
        }
        const answer = parseLine(body);
        const figures = answer?.usage;
        const usage = figures && typeof figures === 'object' ? usageOf({ usage: figures, modelUsage: { [string(answer?.model) ?? model]: {} } }) : [];
        const error = answer?.error;
        return {
          quota: quotaEvents({ unifiedWindows: windows }),
          usage,
          ...(error ? { failure: [error.type, error.message].filter((value) => typeof value === 'string').join(': ') } : {}),
        };
      },
    };
  },
  // The same question asked where the login is (docs/design/usage.md §3): a machine's client
  // runs the CLI as that machine's own login and reads the windows `/usage` shows. Measured on
  // 2.1.303 (tests/fixtures/claude/2.1.303/usage): it runs no turn (`num_turns: 0`, no cost),
  // and it takes most of a minute counting this machine's own sessions, so the machine reads it
  // beside its report rather than in front of one.
  machineQuota: {
    kind: 'command',
    argv: ['claude', '-p', '/usage', '--output-format', 'json'],
    parse: parseUsageText,
  },
  // A settings file is what the CLI reads; the form edits its model and effort level and
  // leaves every other setting of the text as it was written.
  tierForm: { ...SETTINGS_JSON, fields: ['model', 'effort'], efforts: TIER_EFFORTS },
  // A login adopted from what a machine reports signed in runs on the machine's own model,
  // with the strength each tier is for.
  ownLoginTiers: { decide: { effort: 'high' }, execute: { effort: 'medium' } },
  checkTier,
  // A token is the account's own access to the API, so the account's list is the API's;
  // without one the CLI can still say which aliases and levels it takes.
  listModels: ({ token }) =>
    token === undefined
      ? { kind: 'command', argv: ['claude', '--help'], parse: parseHelp }
      : { kind: 'http', url: MODELS_URL, headers: { Authorization: `Bearer ${token}`, ...MODELS_HEADERS }, parse: parseModels,
        identity: (headers) => {
          const organizationId = headers.get('anthropic-organization-id')?.trim();
          return organizationId ? { organizationId } : {};
        } },
  launch: (turn) => command(turn),

  resume(turn) {
    if (!turn.sessionRef) throw new Error('续接需要 session_ref');
    return command(turn, ['--resume', turn.sessionRef]);
  },

  parse(text) {
    const line = parseLine(text);
    const limits = rateLimitInfo(line);
    if (limits) return quotaEvents(limits);
    switch (line?.type) {
      case 'stream_event':
        return streamEvents(line);
      // Text comes from the deltas above; here it would show twice.
      case 'assistant':
        return contentOf(line)
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({ kind: 'tool.start', id: block.id, ...callOf(block) }));
      case 'user':
        return endsOf(line);
      case 'system':
        if (line.subtype !== 'api_retry') return [];
        // The turn is alive and trying again; `error` is the CLI's code for why.
        return [
          {
            kind: 'diagnostic',
            level: 'recovering',
            message: String(line.error ?? ''),
            ...(typeof line.attempt === 'number' ? { attempt: line.attempt } : {}),
            ...(typeof line.max_retries === 'number' ? { maxRetries: line.max_retries } : {}),
          },
        ];
      case 'result':
        return resultEvents(line);
      default:
        return [];
    }
  },

  resultReader: createClaudeResultReader,
  result(stdout, exitCode, stderr) {
    return batchResult(createClaudeResultReader(), stdout, exitCode, stderr);
  },
};
