import { createResultReader, batchResult } from './result-stream.ts';
import type { ResultLimits, ResultReader } from './result-stream.ts';
import { checkTierText } from './tier.ts';
import { inputText } from './shell.ts';
import type { Adapter, Launch, ModelInfo, NormalizedEvent, Reading, ReadingError, Tier, ToolCall, ToolCategory, Turn, Usage } from './types.ts';
import { addUsage } from './usage.ts';
import { PATCH_LIST } from '../shared/tier-form.ts';
import { accountLabelOf } from '../shared/logins.ts';
import { dshCredential, dshProvider } from './dsh-provider.ts';
import { readDshMachineQuota } from './dsh-machine-quota.ts';
import { discoverLocalDshRoutesAndModels } from './dsh-routes.ts';

type Json = Record<string, unknown>;

const STDERR_TAIL = 2000;

// As the other two executors: the machine is the isolation boundary, so the Worker runs
// without a sandbox. `--permission-mode` picks one of the presets dsh-base configures, and
// the account may name another of them. A tighter preset (`workspace-write`, `read-only`) is
// the machine's own profile, a list of patches dsh composes at boot; nothing on the command
// line adds a writable root to it, so a round under one of those presets may not be able to
// write the round's own `artifacts/`, which is outside the workspace. That gap is reported as
// a design problem rather than worked around here: tycho does not loosen the mode the account
// named, and a tier may not touch the sandbox (see PERMISSION_KEYS).
const WORKER_MODE = 'danger-full-access';
// The whole preset table dsh-base configures; dsh refuses a name outside it.
const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
// dsh's own level names (its Models page, 0.2.2-rc.1). Which of them a model takes is the
// line's; a level outside this list rides the patch as it stands.
const TIER_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// Where dsh reads instructions for every session, from its own package documentation
// (@deepseek-ai/dsh-agent-instructions, kept in tests/fixtures/global-entry/dsh-0.2.2-rc.1): the
// user-global chain is `$DSH_HOME/AGENTS.md` and then `$DSH_AGENTS_HOME/AGENTS.md` (or
// `~/.agents/AGENTS.md`), under a byte budget that dsh-base's default profile sets at 65 536 for
// the rendered chain — the harness-home file dropped first, duplicates rendered once — and that a
// profile may change, or turn the loader off. None of that can be read from the files, so a file
// written there is reported with its loading unconfirmed. The home is also where the profile a
// round boots lives, and no setting turns off only the user-global chain, so a round still reads it.
const GLOBAL_ENTRY = {
  home: { env: 'DSH_HOME', dir: '.dsh' },
  file: 'AGENTS.md',
  unconfirmed: 'dsh 读不读取决于机器上的 profile：默认 profile 下它和 ~/.agents/AGENTS.md 共用 65 536 字节的渲染预算（超了先丢这一份，相同内容只算一次），profile 也能改这个上限或关掉指令插件',
};

// The tool names dsh's own packages register: fs (read/write/edit/apply_patch/read_image),
// fs-search (glob/grep), pwsh (pwsh, and shell/terminal on other profiles), web
// (web_search/web_fetch). Recorded: write and read, nothing else yet.
const CATEGORIES: Record<string, ToolCategory> = {
  read: 'read',
  read_image: 'read',
  write: 'edit',
  edit: 'edit',
  apply_patch: 'edit',
  glob: 'search',
  grep: 'search',
  web_search: 'search',
  web_fetch: 'search',
  pwsh: 'run',
  shell: 'run',
  bash: 'run',
  terminal: 'run',
};

// The codes dsh's own errors carry: a request that comes back non-2xx fails with AUTH
// (401/403) or QUOTA, and the transport's table adds RATE_LIMIT/TIMEOUT/TRANSPORT and the
// rest; an account failure adds ACCOUNT_*; a credential that is absent or malformed fails
// with MISSING_CREDENTIAL or INVALID_CREDENTIAL. Only MISSING_CREDENTIAL is recorded
// (missing-credential.ndjson); the others are read from dsh's own sources. A rate limit,
// a timeout and an interrupted task are deliberately neither: the account still works.
const AUTH_CODES = new Set([
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'ACCOUNT_SIGNED_OUT',
]);
const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA']);

// dsh's TurnEndReasonMap: a turn ends as `completed`, as `error` carrying the failure, or
// as one of these, which the process turns into a non-zero exit. Only `aborted` says why
// it was cancelled.
const ENDED_AS: Record<string, string> = {
  aborted: '这一轮被取消',
  blocked: '这一轮被挡住',
  'max-tokens': '这一轮用完了 token 上限',
  interrupted: '这一轮被中断',
  forked: '这一轮分叉了',
};
const CANCEL_CAUSE: Record<string, string> = {
  user: '有人取消',
  parent: '上一级取消',
  disposed: '进程退出',
  legacy: '原因没有记下',
};

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function lineOf(text: string): Json | undefined {
  try {
    return object(JSON.parse(text));
  } catch {
    return undefined;
  }
}

// The code decides when it is one dsh named; the wording only catches provider errors that
// arrive without one.
function classify(code: unknown, message: string): ReadingError['kind'] {
  if (typeof code === 'string') {
    if (QUOTA_CODES.has(code)) return 'quota';
    if (AUTH_CODES.has(code)) return 'auth';
  }
  if (/\bquota\b|insufficient[\s_-]+(?:quota|balance|credits?)|out of[\s_-]+(?:credits?|budget)/i.test(message)) return 'quota';
  if (/\b40[13]\b|no api key|not logged in|not authenticated|invalid api key|unauthorized|forbidden/i.test(message)) return 'auth';
  return 'other';
}

// What a turn that did not complete, and did not fail with an error of its own, says for
// itself. `forked` and `aborted` are not failures of the account, but they are all a Run
// gets to explain why the round is over.
function endingOf(reason: Json): string {
  const kind = String(reason.kind);
  const said = ENDED_AS[kind] ?? `这一轮以 ${kind} 结束`;
  const cause = object(reason.reason);
  const cancelled = typeof cause?.kind === 'string' ? cause.kind : undefined;
  if (cancelled === undefined) return said;
  const why = cancelled === 'hook'
    ? `钩子说：${typeof cause?.reason === 'string' ? cause.reason : '没说原因'}`
    : CANCEL_CAUSE[cancelled] ?? cancelled;
  return `${said}（${why}）`;
}

// The failure a turn ended with, or nothing when it completed. `fallback` is what to say
// when dsh's own record carries no message; its code alone still says something.
function failureOf(reason: Json | undefined, fallback = ''): ReadingError | undefined {
  if (!reason || typeof reason.kind !== 'string' || reason.kind === 'completed') return undefined;
  if (reason.kind !== 'error') return { kind: 'other', message: endingOf(reason) };
  const error = object(reason.error);
  const code = error?.code;
  const said = typeof error?.message === 'string' ? error.message : '';
  const message = said || fallback || (typeof code === 'string' ? code : '这一轮出错');
  return { kind: classify(code, message), message };
}

function failure(message: string): ReadingError {
  return { kind: classify(undefined, message), message };
}

// One step reports what it spent; a turn is the sum of its steps.
// Its input leaves the cache out (0.2.2-rc.1 recorded: 256 in, 39 out and 7168 read add up
// to its total of 7463). It names no model and prices nothing.
function usageOf(value: unknown): Usage[] {
  const usage = object(value);
  if (!usage) return [];
  const number = (key: string): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
  return [{
    inputTokens: number('inputTokens'),
    outputTokens: number('outputTokens'),
    cacheReadTokens: number('cacheReadTokens'),
    cacheWriteTokens: number('cacheWriteTokens'),
  }];
}

const string = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

// A call as dsh's projection gives it: the tool's name and its input. The file tools name a
// `file_path`, the shells a `command`, the searches a `pattern`.
function callOf(tool: string, value: unknown): ToolCall {
  const input = object(value) ?? {};
  const path = string(input.file_path) ?? string(input.path);
  const full = inputText(input);
  return {
    category: CATEGORIES[tool] ?? 'other',
    name: tool,
    title: string(input.description) ?? string(input.file_path) ?? string(input.command) ?? string(input.pattern) ?? string(input.query) ?? string(input.url) ?? tool,
    ...(full ? { input: full } : {}),
    ...(path && CATEGORIES[tool] !== 'search' ? { paths: [path] } : {}),
  };
}

// A tool result: `result` is what it gave back, failed or not, `error` the projection's
// structured error on a failed one, and `truncated` dsh's own mark that it cut the strings
// of this line. The text is kept whole beside the error: the error is a summary of it.
function endOf(line: Json): NormalizedEvent {
  const isError = line.status === 'error';
  const output = string(line.result);
  const reason = string(object(line.error)?.message) ?? string(line.error);
  return {
    kind: 'tool.end',
    id: line.callId as string,
    isError,
    ...(output ? { output: { text: output, ...(line.truncated === true ? { executorTruncated: true as const } : {}) } } : {}),
    ...(reason ? { reason } : {}),
  };
}

function fatal(error: ReadingError): NormalizedEvent {
  return { kind: 'diagnostic', level: 'fatal', message: error.message, cause: error.kind };
}

function statusEvents(line: Json): NormalizedEvent[] {
  if (line.phase === 'step_end') {
    const usage = usageOf(line.usage);
    return usage.length > 0 ? [{ kind: 'usage', usage }] : [];
  }
  if (line.phase !== 'turn_end') return [];
  const error = failureOf(object(line.reason));
  return error ? [fatal(error)] : [];
}

// `--patch` takes a file and nothing else, so the tier's text reaches the round as the
// snapshot's own copy, read from the Worker's working directory, which start.sh makes the
// task directory.
function overlayOf(turn: Turn): string {
  if (!turn.tierPath) throw new Error('档位内容的快照路径没有给出');
  return turn.tierPath;
}

// A patch file holds a list, one entry per overlay: a mapping or a scalar at the top level
// is not one, and dsh reads only what it can. What the entries say is dsh's own to check —
// it refuses a patch it cannot read with a non-zero exit rather than going on — so nothing
// of theirs is read here.
function checkTier(tier: Tier): string | undefined {
  // An empty tier adds no patch; the machine's own configuration stays in effect.
  if (tier.text.trim() === '') return undefined;
  const why = checkTierText(tier.text);
  if (why) return why;
  if (tier.text.includes('\0')) return '内容里有 tycho 传不过去的字符';
  // A document marker and a comment say nothing about the shape; blank lines are spacing.
  const [first] = tier.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== '---' && !line.startsWith('#'));
  if (first === undefined) return '内容不能为空';
  if (!first.startsWith('-')) return '内容应是一份 YAML 列表，每条 patch 以「- 」开头';
  return undefined;
}

const unquote = (value: string): string => value.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');

const said = (value: string | undefined): string => (value === undefined ? '' : unquote(value));

// A value written as a list: `[a, b]`, or the same separated by commas. One bare word is a
// list of one; nothing at all is an empty list.
function listOf(value: string | undefined): string[] {
  if (value === undefined) return [];
  const inside = value.trim().replace(/^\[/, '').replace(/\].*$/, '');
  return inside.split(',').map(unquote).filter((each) => each !== '');
}

// One item of a `models:` block: the name written on the item's own line, and the fields
// written under it.
interface DumpItem {
  scalar: string;
  fields: Map<string, string>;
}

// The items under a `models:` key: each begins with `- ` at one depth, and the fields under
// it belong to it until the next item or the end of the block.
function itemsUnder(lines: readonly string[], at: number, indent: number): DumpItem[] {
  const items: DumpItem[] = [];
  let depth: number | undefined;
  for (let line = at + 1; line < lines.length; line += 1) {
    const text = lines[line]!;
    if (text.trim() === '' || text.trim().startsWith('#')) continue;
    const own = /^\s*/.exec(text)![0].length;
    if (own <= indent) break;
    const item = /^\s*-\s*(.*)$/.exec(text);
    if (item && (depth === undefined || own === depth)) {
      depth = own;
      const held: DumpItem = { scalar: '', fields: new Map() };
      const pair = /^([\w.-]+):\s*(.*)$/.exec(item[1]!);
      if (pair) held.fields.set(pair[1]!, pair[2]!);
      else held.scalar = item[1]!;
      items.push(held);
      continue;
    }
    if (depth === undefined || own <= depth) break;
    const pair = /^([\w.-]+):\s*(.*)$/.exec(text.trim());
    if (pair && items.length > 0) items[items.length - 1]!.fields.set(pair[1]!, pair[2]!);
  }
  return items;
}

function modelOfItem({ scalar, fields }: DumpItem): ModelInfo | undefined {
  const id = unquote(scalar) || said(fields.get('id')) || said(fields.get('slug')) || said(fields.get('name'));
  if (id === '') return undefined;
  const name = said(fields.get('display_name')) || said(fields.get('name'));
  const efforts = listOf(fields.get('efforts') ?? fields.get('reasoningEfforts'));
  const fallback = said(fields.get('defaultEffort')) || said(fields.get('default_reasoning_level'));
  const hidden = said(fields.get('visibility')) === 'hide' || said(fields.get('hidden')) === 'true';
  return {
    id,
    ...(name === '' || name === id ? {} : { name }),
    ...(efforts.length === 0 ? {} : { efforts }),
    ...(fallback === '' ? {} : { defaultEffort: fallback }),
    ...(hidden ? { hidden: true } : {}),
  };
}

// The models a dump writes down itself. dsh's configuration is a list of patches and each
// may carry a `config:` block; a route that names its models writes them under a `models:`
// key, as a list on the line itself or as a block of items under it. What a route does not
// write down is not guessed at: the list comes back empty and the owner fills it in.
//
// Recorded (tests/fixtures/dsh/0.2.2-rc.1/dump-config-headless.yml): the dump is the composed
// profile, one `- id:` entry per plugin, and the shipped profile writes no `models:` block at
// all — dsh has no catalog of its own to print. What it does write is the one model its
// default-model entry names, which is what a round runs on when its tier names none: that
// one is read too, so the form has at least what this machine is set up for. The spelling of
// a `models:` block is still a guess (none has been recorded), so only the names above are
// read from one. A route that has to be asked for its models at its own endpoint (the ones
// whose gateway serves `/models`) is where an `http` query belongs: built from that route's
// own configuration, with that route's own credentials. Nothing here knows any gateway by name.
function modelsInDump(text: string): ModelInfo[] {
  const lines = text.split(/\r?\n/);
  const model = defaultModelIn(lines, 'model');
  const found: ModelInfo[] = model === '' ? [] : [{ id: model }];
  lines.forEach((line, at) => {
    const key = /^(\s*)(?:-\s+)?models:\s*(.*?)\s*$/.exec(line);
    if (!key) return;
    const value = key[2]!;
    if (value.startsWith('[') || value === '' || value.startsWith('#')) {
      const items = value.startsWith('[') ? [] : itemsUnder(lines, at, key[1]!.length);
      for (const id of listOf(value)) found.push({ id });
      for (const item of items) {
        const model = modelOfItem(item);
        if (model) found.push(model);
      }
    }
  });
  // A route may list the model its profile also runs by default: once is enough.
  return found.filter((model, at) => found.findIndex((each) => each.id === model.id) === at);
}

// The model the profile's default-model entry names, when it names one.
function defaultModelIn(lines: readonly string[], field: 'model' | 'provider'): string {
  let inside = false;
  for (const line of lines) {
    const entry = /^- id:\s*(.*?)\s*$/.exec(line);
    if (entry) {
      inside = unquote(entry[1]!) === DEFAULT_MODEL_ENTRY;
      continue;
    }
    const value = inside ? /^\s+(model|provider):\s*(.*?)\s*$/.exec(line) : null;
    if (value?.[1] === field) return said(value[2]);
  }
  return '';
}

// The profile every round boots, and the entry of it that names the model a round runs on.
const PROFILE = 'headless';
const DEFAULT_MODEL_ENTRY = 'agent-default-model';

function command(turn: Turn, extra: string[] = []): Launch {
  return {
    argv: [
      'dsh',
      '--profile',
      PROFILE,
      ...(turn.tier.kind === 'content' && turn.tier.text.trim() === '' ? [] : ['--patch', overlayOf(turn)]),
      // An account's line after the tier: a later patch is applied over an earlier one, so no
      // tier can turn the stored credentials back on or redefine the line (dsh-provider.ts).
      ...(turn.linePath ? ['--patch', turn.linePath] : []),
      '--json',
      ...extra,
      '--permission-mode',
      turn.permissionMode ?? WORKER_MODE,
      '--approval-policy',
      'never',
      turn.prompt,
    ],
    // The harness home stays the machine's own: the profile it booted, its patches and the
    // session log. An account's key is the launching environment's, put there for the round
    // (dsh-provider.ts).
    env: {},
  };
}

function createDshResultReader(limits?: ResultLimits): ResultReader {
  let sessionRef: string | undefined;
  let usage: Usage[] = [];
  let last: Json | undefined;
  // What a run that never ended a turn said for itself, before it exited.
  let said: string | undefined;
  return createResultReader({
    line(text) {
      const line = lineOf(text);
      if (!line) return false;
      let changed = false;
      // The session line comes first, and an interrupted run may have no final.
      if (typeof line.sessionId === 'string' && sessionRef === undefined) {
        sessionRef = line.sessionId;
        changed = true;
      }
      if (line.type === 'status' && line.phase === 'step_end') {
        usage = addUsage(usage, usageOf(line.usage));
        changed = true;
      }
      if (line.type === 'error' && typeof line.message === 'string') {
        said = line.message;
        changed = true;
      }
      if (line.type === 'final') {
        last = line;
        changed = true;
      }
      return changed;
    },
    state: () => ({ sessionRef, usage, last, said }),
    finish(exitCode, stderr) {
      const text = typeof last?.text === 'string' ? last.text : undefined;
      const reading: Reading = {
        ...(text === undefined ? {} : { text }),
        ...(sessionRef === undefined ? {} : { sessionRef }),
        ...(usage.length === 0 ? {} : { usage }),
        finished: last !== undefined,
      };
      const stderrTail = stderr.trim().slice(-STDERR_TAIL);
      // What the Runner saw, for a failure dsh's own record does not explain.
      const observed = said || stderrTail || (exitCode === null ? '' : `进程退出码 ${exitCode}`);

      if (!last) {
        // No final line: the turn never ended. A Worker the Runner stopped is passed no exit
        // code; that is not a failure of the executor.
        return exitCode === null ? reading : { ...reading, error: failure(observed) };
      }

      const error = failureOf(object(last.reason), observed);
      if (error) return { ...reading, error };
      if (exitCode !== null && exitCode !== 0) return { ...reading, error: failure(observed) };
      return reading;
    },
  }, limits);
}

export const dshAdapter: Adapter = {
  // An account of dsh is a line and its key, which the round reads from its environment.
  credential: dshCredential,
  provider: dshProvider,
  accountLogin: ['provider'],
  // guess: no `dsh --version` has been recorded on the machines this was written on, and
  // dsh's command name is the only thing known for certain. A machine that runs it reports
  // what the command answers, or that it could not be run.
  probe: { command: 'dsh', version: ['--version'] },
  // dsh is a desktop app: its installer does not put the command on PATH, and records where it
  // put the app in its uninstall entry. The command line is a cmd wrapper inside it (measured
  // on the controller workstation: <InstallLocation>\resources\runtime\cli\bin\dsh.cmd).
  installs: [{ kind: 'uninstall', displayName: 'DeepSeek Harness', path: ['resources', 'runtime', 'cli', 'bin', 'dsh.cmd'] }],
  // No `loginStatus`: dsh has no command that answers "signed in?" — the credential is the
  // launching environment's, and its absence shows up as a failure of the turn instead.
  // Recorded (resume.ndjson): `--session-id` adopts the session the previous round left,
  // and the one-shot runner accepts it in the same working directory.
  resumable: true,
  permissionModes: PERMISSION_MODES,
  globalEntry: GLOBAL_ENTRY,
  // Its own packages keep no notes they write and read back across sessions; its session
  // search is opt-in and limited to the same working directory. But a tier, and the machine's
  // own profile, can insert any plugin: what a round has cannot be told from here.
  memory: { scope: 'unknown', why: 'dsh 的档位和机器上的 profile 能插入任何插件，有没有跨任务的记忆确认不了' },
  // A tier is a patch list; the form edits the `agent-default-model` entry's provider,
  // model and reasoning effort, and leaves every other entry and setting as it was.
  tierForm: { ...PATCH_LIST, fields: ['provider', 'model', 'effort'], efforts: TIER_EFFORTS },
  // Both tiers are the empty text: a patch that writes a strength alone replaces the whole
  // `config`, and with it the provider and model the machine is configured for. So an adopted
  // login runs on the machine's own dsh configuration.
  ownLoginTiers: { decide: {}, execute: {} },
  checkTier,
  // What the configuration itself writes down, read from a dump of the profile a round boots
  // (the launcher prints nothing without one: "--profile <name> is required", exit 1). dsh
  // has no catalog of its own to print: which models a route serves is that route's business.
  listModels: () => ({
    kind: 'command',
    argv: ['dsh', '--profile', PROFILE, '--dump-config'],
    extraArgv: ['dsh', '--profile', PROFILE, '--dump-config-schema'],
    parse: (stdout, schemaStdout) => {
      const fromDump = modelsInDump(stdout);
      const local = discoverLocalDshRoutesAndModels(stdout, { schemaJson: schemaStdout });
      const merged: ModelInfo[] = [...fromDump];
      for (const model of local.models) {
        const existing = merged.find((each) => each.id === model.id);
        if (!existing) merged.push(model);
        else if ((!existing.efforts || existing.efforts.length === 0) && model.efforts && model.efforts.length > 0) {
          existing.efforts = [...model.efforts];
        }
      }
      return merged;
    },
    identity: (stdout) => {
      const local = discoverLocalDshRoutesAndModels(stdout);
      const route = accountLabelOf(local.defaultRoute ?? defaultModelIn(stdout.split(/\r?\n/), 'provider')) ?? null;
      return {
        routeLabel: route,
        ...(local.routes.length > 0 ? { routes: local.routes } : {}),
      };
    },
  }),
  machineQuota: {
    kind: 'probe',
    read: (ctx) => readDshMachineQuota(ctx),
  },
  launch: (turn) => command(turn),

  resume(turn) {
    if (!turn.sessionRef) throw new Error('续接需要 session_ref');
    return command(turn, ['--session-id', turn.sessionRef]);
  },

  parse(text) {
    const line = lineOf(text);
    if (!line) return [];
    switch (line.type) {
      case 'text':
        return typeof line.text === 'string' ? [{ kind: 'text', text: line.text }] : [];
      case 'thinking':
        return typeof line.text === 'string' ? [{ kind: 'thinking', text: line.text }] : [];
      case 'tool_call':
        if (typeof line.callId !== 'string' || typeof line.tool !== 'string') return [];
        return [{ kind: 'tool.start', id: line.callId, ...callOf(line.tool, line.input) }];
      case 'tool_result':
        if (typeof line.callId !== 'string') return [];
        return [endOf(line)];
      case 'status':
        return statusEvents(line);
      // `fail()` writes this line and exits 1, and on a usage error it is the only place
      // the reason appears: the headless app replaces commander's own error output.
      // Recorded: usage-error.ndjson.
      case 'error':
        return typeof line.message === 'string' ? [fatal(failure(line.message))] : [];
      // Emit `turn.end` only on `final` (never on status `turn_end`) so the post-result
      // watchdog timer cannot race ahead of `final` and truncate the final payload.
      case 'final':
        return [{ kind: 'turn.end' }];
      default:
        return [];
    }
  },

  resultReader: createDshResultReader,
  result(stdout, exitCode, stderr) {
    return batchResult(createDshResultReader(), stdout, exitCode, stderr);
  },
};
