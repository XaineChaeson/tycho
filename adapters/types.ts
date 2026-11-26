import type { ResultLimits, ResultReader } from './result-stream.ts';
import type { Tier } from './tier.ts';
import type { TierForm, TierValues } from '../shared/tier-form.ts';
import type { TierId } from '../shared/tiers.ts';
import type { ProviderForm } from '../shared/provider-form.ts';
import type { ReadOnlyLayer } from '../shared/roles.ts';
import type { AccountLoginWay, ExecutorIdentity } from '../shared/logins.ts';
import type { ConfigKind } from '../shared/machine-inputs.ts';

export type { Tier };

export interface Turn {
  prompt: string;
  workdir: string;
  // Where this round's material is (the brief, context.json, on-demand knowledge): an absolute
  // path the machine substitutes for MATERIALS_PLACEHOLDER before it starts the Worker. The
  // material lives in the Task's directory, while the working directory is the source's
  // (a repository checkout or a folder on the machine), so an executor that can open a
  // directory besides its working one is given this.
  materialsDir?: string;
  // Where this round delivers what it made (its own `artifacts/`, beside the material), as the
  // machine substitutes ARTIFACTS_PLACEHOLDER for it. Always available on both writable and
  // read-only rounds so review/report artifacts can be delivered cleanly.
  artifactsDir?: string;
  // The tier as the ledger held it: content is the executor's own configuration text,
  // `ref` a place on the machine that has it.
  tier: Tier;
  // For content, where the snapshot keeps it. The machine substitutes MATERIALS_PLACEHOLDER
  // with the absolute snapshot directory, so it stays right whatever the working directory is.
  tierPath?: string;
  // For an account that is a line (Adapter.provider): where the snapshot keeps the line's own
  // configuration, relative to the Worker's working directory. Absent for any other login.
  linePath?: string;
  // The non-secret line definition itself, for adapters that pass its endpoint in environment
  // variables (e.g., Gemini's GOOGLE_GEMINI_BASE_URL).
  provider?: Provider;
  // What the account named, out of the adapter's permissionModes. Absent means the mode
  // the adapter runs a Worker under.
  permissionMode?: string;
  // A round of a read-only role: the adapter starts it its declared read-only way, whatever
  // `permissionMode` says — an account's mode may make it tighter, never looser.
  readOnly?: boolean;
  // A round that needs a view of its own (a review, a knowledge gate or curation): started with
  // the executor's memory across tasks off, its adapter's declared way (§1.3). Any other round
  // reads and writes it as the machine has it.
  memoryOff?: boolean;
  // MCP servers of the machine's, by name, this round is started with turned off: tycho's own
  // knowledge outlet (§4.1), which the snapshot already holds pinned. Its adapter's declared way.
  mcpOff?: readonly string[];
  // A managed account round (as opposed to a machine's own login), for executors whose
  // CLI requires a settings file even when the tier text itself is empty.
  managedAccount?: boolean;
  sessionRef?: string;
}

// One place an executor's command may be installed outside PATH (Adapter.installs).
export type InstallPlace =
  // A path under the directory an environment variable names, on the systems listed. A `*`
  // segment is any one directory there; a `<version>` segment is any directory named as a
  // version, and of all the files the path matches the one in the newest version is taken.
  | { kind: 'under'; platforms: readonly NodeJS.Platform[]; variable: string; path: readonly string[] }
  // Windows: a path under the folder an installer's uninstall entry (HKCU and HKLM, found by
  // its display name) records as `InstallLocation`.
  | { kind: 'uninstall'; displayName: string; path: readonly string[] };

// How this executor runs a round read-only (docs/design/roles-and-tiers.md §5), measured in
// docs/spike/readonly.md. `args` are what its command carries for it; `layer` is how far they
// reach. Whether the way works is a fact of each machine, which its client finds out with
// `probe`: a command that writes nothing and spends no quota, run in that machine's login
// shell. Exit code 0 and nothing said by `check` is "available"; anything else — a failure, a
// timeout, a check that finds the switch missing — is not, with the words it gave.
export interface ReadOnlyWay {
  layer: ReadOnlyLayer;
  args: readonly string[];
  probe?: { argv: string[]; check?: (stdout: string, stderr: string) => string | undefined };
}

// Where this executor reads instructions for every session it starts, as its own rules say
// (docs/design/knowledge-and-skills.md §4.3; measured in docs/spike/global-entry.md). A
// machine's client writes the owner's global resident knowledge there, and a round tycho sends
// keeps off it where `offInRound` says how (§4.1).
export interface GlobalEntry {
  // The executor's own directory: the variable that moves it (when the CLI accepts one),
  // and where it is otherwise, relative to the home directory.
  home: { env?: string; dir: string };
  // The file tycho writes, relative to that directory.
  file: string;
  // Files beside it that the executor reads instead of this one, and when: 'not-blank' is a
  // file with anything but white space in it (an empty one is passed over).
  coveredBy?: readonly { file: string; when: 'not-blank' }[];
  // What its loading also turns on that a machine cannot check from the files alone (a profile
  // that sets a budget or turns the loader off), in the owner's words. Present: a file written
  // there is reported written with its loading unconfirmed, never as read.
  unconfirmed?: string;
  // How a round is kept from loading it: settings its one settings file carries, which only a
  // tier the snapshot writes can be given. `since` is the version it was measured on, and why it
  // is not promised below that: an older command, or one whose version is not known, is still
  // given the settings, and the round's snapshot says it may read the file. Absent: nothing keeps
  // it out, and the snapshot says the round still reads it.
  offInRound?: { settings: Readonly<Record<string, readonly string[]>>; how: string; since: { version: string; why: string } };
}

// The executor's own notes that outlast a session (§1.3). `scope` is how far they are shared:
// 'none' it keeps none; 'task' only within the directory a task runs in; 'shared' across
// tasks (by user, machine or repository); 'unknown' cannot be told. They pass through like the
// rest of the machine's configuration; `off` is how a round that needs a view of its own is run
// with them off (`Turn.memoryOff`), said in words for the snapshot. `why` is what the declaration
// rests on, for a memory that cannot be turned off.
interface ExecutorMemory {
  scope: 'none' | 'task' | 'shared' | 'unknown';
  // `env` and `args` are what the command is started with for it; the declaration is the one
  // place they are written, for a Worker's launch and for anything else started on the executor.
  // `since`: the version the switch was measured on, below which (or with no version known) it
  // is not given — an older command may refuse it — and the snapshot says the round may read them.
  off?: { how: string; env?: Readonly<Record<string, string>>; args?: readonly string[]; since?: { version: string; why: string } };
  why?: string;
}

// How the machine's client lists one kind of the executor's own configuration there
// (docs/design/knowledge-and-skills.md §1.2): a command that spends no quota and how its answer
// is read into names (undefined: it cannot be read), parsed on the machine so that nothing else
// the command printed leaves it. `unasked` instead: there is no such command, or the only one
// would start something of the machine's (its MCP servers), so the client does not ask and the
// snapshot says why the kind is unknown.
export type ConfigQuery =
  | { kind: ConfigKind; argv: string[]; parse(stdout: string): string[] | undefined }
  | { kind: ConfigKind; unasked: string };

// How a round is started with one MCP server of the machine's turned off by name (§4.1),
// measured on the recordings in tests/fixtures/executor-config. `listed`: the arguments stop the
// command when no server of that name is configured, so they are given only when the machine's
// report lists it.
export interface McpOff {
  args(name: string): string[];
  how: string;
  // The version the switch was measured on: below it, or with no version known, it is not
  // given and the snapshot says the server may still be used.
  since?: { version: string; why: string };
  listed?: true;
}

// The lowest version of the executor's own command that takes what this program's commands
// pass it, and what an older one lacks, in the owner's words.
export interface MinVersion {
  version: string;
  lacks: string;
}


export interface Launch {
  argv: string[];
  env: Record<string, string>;
}

export type ToolCategory = 'read' | 'edit' | 'run' | 'search' | 'other';

// What an executor counted as used, for one model. The four counts do not overlap: input is
// what was neither read from nor written to the cache, whatever the executor's own count
// includes. `model` only where the executor names the model it ran; `listCostUsd` only where
// it priced the use itself, at list prices, which is not what a subscription is billed.
export interface Usage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  listCostUsd?: number;
}

// How much of one quota window a login has used, as an executor itself reported it. `used` is
// 0 to 1; `resets_at` is when the window starts over, after which the figure says nothing,
// and null when the executor named no time.
export interface QuotaWindow {
  window: string;
  used: number;
  resets_at: string | null;
}

// What one reading of a login's quota gave: the windows the executor named, or why nothing
// could be read, in the owner's words and never the command's own output — a quota listing
// may carry an account's identity. A valid answer that names no window at all (a subscription
// notice with the window lines left out) is `absent`: unavailable for this read, said neutrally,
// with the last figures preserved, as distinct from a `problem` — a command or answer that could
// not be read, which is a failure.
export type QuotaReading = { windows: QuotaWindow[]; absent?: true } | { problem: string };

// One request of a `talk` reading (below): the lines written to the command's standard input,
// in this order, and how a line of its answer is known to be this step's.
export interface QuotaStep {
  say: readonly string[];
  answers(line: string): boolean;
}

// How this executor's quota is read on a machine, for a login that lives there and whose
// credential the host does not hold (docs/design/usage.md §3): what the machine's client runs
// and how it reads the answer. Declared by the adapter; the client runs it and parses it, so
// that nothing but the windows leaves the machine, and no generic code knows an executor's
// name. Two shapes, as the two CLIs need:
//   command — one command whose whole standard output is parsed once it ends;
//   talk    — a few lines written to its standard input, each step's answer waited for before
//             the next is written, and the last answer parsed. `version` is the version this
//             client tells the executor it is (the Codex handshake names one).
// It spends no quota where the executor has a way to ask that does not. Absent: the executor
// offers no reading, and a machine reports none.
export interface MachineQuotaProbeContext {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export type MachineQuota =
  | { kind: 'command'; argv: readonly string[]; parse(stdout: string): QuotaReading }
  | { kind: 'talk'; argv: readonly string[]; steps(version: string): readonly QuotaStep[]; parse(answer: string): QuotaReading }
  | { kind: 'probe'; read(ctx: MachineQuotaProbeContext): Promise<QuotaReading> };

export interface ReadingError {
  kind: 'quota' | 'auth' | 'other';
  message: string;
  // With 'quota', when the executor's own output says the quota comes back. Never read
  // out of the message: that is a sentence for people, in the account's time zone.
  resetsAt?: string;
}

// What the executor said about itself while it ran, apart from how the round ends: a
// `warning` it went on past, a `recovering` it is retrying through, a `fatal` it stopped
// on. None of them decides the Run's outcome: that is `result()`'s.
export type DiagnosticLevel = 'warning' | 'recovering' | 'fatal';

// One tool call as the executor reported it. `name` is the executor's own name for the
// tool, kept to trace it back; `title` is one short line to show by default (a command
// without the shell it was wrapped in, a path, a pattern); `input` is the whole input as
// given — a command's text exactly, anything else as JSON — and `paths` the files it
// names plainly.
export interface ToolCall {
  category: ToolCategory;
  name: string;
  title: string;
  input?: string;
  paths?: string[];
}

// What a call printed. `executorTruncated` is the executor's own cut; `omittedBytes` is
// tycho's: the Runner keeps a bounded part of a long text, its mark where it cut.
export interface ToolOutput {
  text: string;
  executorTruncated?: true;
  omittedBytes?: number;
}

// A file a completed call reports it changed. `op` is absent when the executor does not
// say which kind of change; `patch` only when the executor handed over a real one.
export interface FileChange {
  path: string;
  op?: 'add' | 'update' | 'delete';
  patch?: string;
}

export type NormalizedEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | ({ kind: 'tool.start'; id: string } & ToolCall)
  // `call` is there when the executor describes the call at its end too: a call reported
  // only at its end still has a row, and none is made up for one that has neither.
  | {
      kind: 'tool.end';
      id: string;
      isError: boolean;
      call?: ToolCall;
      output?: ToolOutput;
      exitCode?: number;
      reason?: string;
      changes?: FileChange[];
    }
  | { kind: 'turn.end' }
  | { kind: 'interrupted' }
  // `cause` comes with `fatal`; `attempt` and `maxRetries` with a `recovering` that counts.
  | {
      kind: 'diagnostic';
      level: DiagnosticLevel;
      message: string;
      cause?: ReadingError['kind'];
      attempt?: number;
      maxRetries?: number;
    }
  // What this line adds to the round's use, one entry per model.
  | { kind: 'usage'; usage: Usage[] }
  // How much of one of the account's quota windows is used, 0 to 1, and when that window
  // starts over. Only from an executor that reports it while it runs. It is about the
  // target, not the Run: the Runner keeps it out of the Run's log.
  | { kind: 'quota'; window: string; used: number; resetsAt: string | null }
  // Never from an adapter: the Runner's mark for what its bounded log has dropped.
  | { kind: 'truncated'; dropped: number };

export interface Reading {
  text?: string;
  sessionRef?: string;
  // The whole round's use, one entry per model: the sum of what its lines added. Absent when
  // the executor reported none.
  usage?: Usage[];
  error?: ReadingError;
  finished: boolean;
}

// One model an executor reports for an account: `id` is what a tier names it by, `name`
// what the executor shows it as. `efforts` are the strengths this model takes, in its own
// order, and `defaultEffort` the one the executor uses when a tier names none. `hidden`
// is a model the executor keeps out of its own picker; it is reported all the same, and
// what to do with it is the console's. Absent `efforts` means the executor says nothing
// about that model's strengths, not that it takes none.
export interface ModelInfo {
  id: string;
  name?: string;
  efforts?: string[];
  defaultEffort?: string;
  hidden?: boolean;
}

// How this executor answers "which models can this login use": one question, and how to
// read its answer. The adapter declares both and asks neither. A request is the service's,
// made over the network with an account's token. A command is a machine's: its client runs it
// when it looks at its own executors, parses the answer there and reports the list, so that
// nothing else the command printed leaves the machine (docs/design/nodes.md §1.2); the
// service never runs one. Either way an answer that cannot be read comes back as no models,
// never as a guess, and `parse` does not throw.
export type ModelQuery =
  // A request the caller makes itself. The token is in `headers` and belongs nowhere else.
  | { kind: 'http'; url: string; headers: Record<string, string>; parse(body: string): ModelInfo[]; identity?: (headers: Headers) => ExecutorIdentity }
  // A command run on a machine, as that machine's own login would run it. Optional `extraArgv`
  // supplies a second read-only local probe (e.g. `--dump-config-schema` or `--help`) whose
  // stdout is passed into `parse` so supported models and reasoning efforts come straight from the CLI.
  | { kind: 'command'; argv: string[]; extraArgv?: string[]; parse(stdout: string, extraStdout?: string): ModelInfo[]; identity?: (stdout: string) => ExecutorIdentity };

// How a login tycho keeps reaches the process of a round (docs/design/native-login.md): as the
// value of the variable named here, which is where every executor here reads its key. What the
// process starts inherits it: the machine is the boundary.
export interface CredentialWay {
  variable: string;
}

// How a machine asks its executor, without writing anything or spending quota, which login it
// would use when tycho hands a round a token: the command, run with `CredentialWay.variable`
// set to a placeholder value of this program's own (never a real token), and the reading of its
// answer — why the token would not be used, or nothing when it would. What it asks is which
// login the executor takes, not whether this token is valid. The variable is the one
// `credential({})` names, so this way of asking fits only an executor whose variable name does
// not change with the line.
export interface CredentialCheck {
  argv: string[];
  check(stdout: string, stderr: string): string | undefined;
}

// How a login of this executor is made on a machine itself, for one that only a machine can
// hold (a login the vendor rotates is such a one). The machine's client runs `argv` as that
// machine's user, with no terminal and nothing typed into it; it ends 0 when the machine is
// signed in. What it prints is read on the machine by `read`, and only that answer leaves it.
export interface MachineSignIn {
  argv: string[];
  // True when the command prints an authorization link and reads the authorization code (or
  // callback URL) from stdin, rather than showing a device user-code.
  acceptsCode?: boolean;
  // Lowest CLI version that supports `argv`, when newer than `Adapter.minVersion`.
  minVersion?: MinVersion;
  // What the owner opens (and types, for device-code flows) to finish the sign-in elsewhere.
  // Undefined until ready, and for a screen this cannot read.
  read(output: string): { url: string; code?: string } | undefined;
}

// A line to a model service that an account of this executor can be: where requests go and
// what is served there, without the key, which tycho keeps like any account's login. The
// definition is the executor's own shape, checked and written out by its adapter alone.
export type Provider = Readonly<Record<string, unknown>>;

export interface ProviderDeclaration {
  // What the console's form asks, by line (shared/provider-form.ts).
  form: ProviderForm;
  // The definition as it is kept, from what someone wrote: every field a claim until checked.
  check(input: unknown): { provider: Provider } | { problem: string };
  // The line's own configuration as the executor reads it: a file of the round's snapshot
  // (`Turn.linePath`), which the round is started with before its tier. No secret is in it.
  config(provider: Provider): { file: string; text: string };
  // Why a tier cannot be an account's on this line, or nothing: what it must leave to the line.
  tierProblem(provider: Provider, tier: Tier): string | undefined;
  // The name a tier calls this line by, which the console's form writes and does not ask.
  route(provider: Provider): string;
  // The models the definition itself says the line serves. Undefined when it lists none and
  // the line has to be asked (`listModels`).
  models(provider: Provider): ModelInfo[] | undefined;
  // How the line is asked what it serves, with its key: the request and how to read the answer.
  // Undefined for a line that cannot be asked.
  discover(provider: Provider, key: string): { url: string; headers: Record<string, string>; parse(body: string): ModelInfo[] } | undefined;
}

export interface Adapter {
  // Roughly how many days a token this executor's account holds lasts, where the vendor says
  // so and gives no exact date (docs/design/native-login.md §2, ruling L). Absent: no expiry
  // is expected, and nothing is shown or reminded about. Shared/credential.ts does the adding.
  credentialLifetimeDays?: number;
  // How a login of this executor that tycho keeps is handed to a round, given the account's
  // line when it has one. Absent: tycho cannot keep a login of this executor, and it is only
  // ever a machine's own.
  credential?: (login: { provider?: Provider }) => CredentialWay;
  // Materializes an account credential into environment variables (and any round-local files
  // under `scratchDir`) before starting the Worker. Absent: `[variable]: credential`.
  prepareCredential?: (context: {
    variable: string;
    credential: string;
    scratchDir: string;
    baseExecutorDir?: string;
    taskDir?: string;
  }) => Record<string, string | undefined>;
  // Secret strings derived from an encoded credential that must also be redacted from Worker output.
  secretStrings?: (credential: string) => readonly string[];
  // Present when a machine can ask its executor whether a token tycho hands a round is the
  // login it would use. Absent: nothing is asked, and every machine takes the account's work as
  // it always has; what the declaration rests on is the recording it names in its comment.
  credentialCheck?: CredentialCheck;
  // How the login of an account of this executor is obtained, in the order the console
  // offers them (shared/logins.ts). It says something only beside `credential`: an
  // executor whose login cannot be handed to a round is no account, however it signs in.
  accountLogin?: readonly AccountLoginWay[];
  // Present when an account of this executor is a line and its key (dsh).
  provider?: ProviderDeclaration;
  // Present when a login of it can be made on a machine from the console (Codex).
  signIn?: MachineSignIn;
  // Declared by the executor that can drive the Router itself: it has to run with no
  // built-in tools and answer each turn, which not every CLI here does.
  canRoute?: boolean;
  // How this executor's own command is asked what it is, on a machine that may run it: the
  // command itself, and the arguments that make it print its version. Declared because the
  // command name and its own switch are the executor's facts, not the caller's. Absent when
  // there is no such command, and then a machine reports nothing about this executor
  // (docs/design/nodes.md §1.2, §11 step 5).
  probe?: { command: string; version: string[] };
  // Where this executor's command is commonly installed besides PATH, in the order they are
  // tried after it (docs/design/nodes.md §1.2): a desktop app or an installer that does not
  // put the command on PATH. A closed set this program ships: nothing a host sends adds a
  // place or changes one. node/locate.ts is the one reader, for a machine's probe, its watch
  // process, the Router and the self-check alike. Absent: PATH only.
  installs?: readonly InstallPlace[];
  // The arguments that make the executor's own command say whether it is signed in, by
  // its exit code: 0 when it is. Absent when the executor has no such command.
  loginStatus?: string[];
  // How that same command's answer names the organization this login belongs to, read on
  // the machine so that only the organization id leaves it (an answer also carries an
  // account's email and other raw fields, which must not). It is the same probe as
  // `loginStatus`: no second command is run. Absent, or an answer out of shape, reports no
  // identity. Only the organization id is meaningful here, and only for a login the
  // executor presents as a personal subscription.
  loginIdentity?: (stdout: string, stderr: string) => ExecutorIdentity;
  // Read account identity over a local CLI conversation when the login status has no label.
  identityTalk?: { argv: string[]; steps(version: string): readonly QuotaStep[]; parse(answer: string): ExecutorIdentity };
  // Whether a later Run of the same Task, on the same account and machine, may adopt the
  // session this one leaves. Absent means it may not: the next round starts a new session.
  resumable?: boolean;
  // What this executor's own command takes for the permission mode, as the values an
  // account may name. Absent when it takes none, and then an account must not name one.
  permissionModes?: readonly string[];
  // How a round of this executor is made read-only. Absent when it has no way that holds,
  // and then no read-only role is ever dispatched to it.
  readOnly?: ReadOnlyWay;
  // Absent when any version of its command will do.
  minVersion?: MinVersion;
  // Where it reads instructions for every session, and how a round is kept off them. Absent:
  // no such place is known, and nothing is written for it.
  globalEntry?: GlobalEntry;
  // Its own notes across sessions. Absent is the same as 'unknown'.
  memory?: ExecutorMemory;
  // How each kind of its own configuration on a machine is listed. Absent: none can be.
  config?: readonly ConfigQuery[];
  // How a round turns an MCP server off by name. Absent: it has no measured way.
  mcpOff?: McpOff;
  // One small HTTP request with an account's token, and how to read its windows and spent
  // tokens (docs/design/usage.md). Models are the account's existing list, never a tier or
  // a hard-coded model. Absent when the executor has no such account query.
  quotaRead?: (context: { token: string; models: readonly ModelInfo[] }) => {
    url: string;
    headers: Record<string, string>;
    body: string;
    parse(headers: Headers, body: string): {
      quota: Extract<NormalizedEvent, { kind: 'quota' }>[];
      usage: Usage[];
      failure?: string;
    };
  };
  // How one of this executor's own logins on a machine is asked for its quota there
  // (docs/design/usage.md §3): the command (or the short conversation) and the reading of its
  // answer, run and parsed on that machine, which is the only place the login's credential
  // is. Absent: the executor offers no reading, and the usage page says so.
  machineQuota?: MachineQuota;

  // How a tier of this executor is written and read: which shape its text takes, which
  // values the console's form edits, and the strengths its own command takes. Absent when
  // the console may only show the text as it is.
  tierForm?: TierForm;
  // The default tiers a machine's own login starts with, when the machine reports
  // it signed in and the owner has not set that login up (docs/design/accounts-machines-
  // decoupled.md "机器自己的登录什么时候能用"): the values the console's form edits, written
  // by `tierForm.render`. A tier whose declared values are all empty is the empty text, which
  // runs on the machine's own configuration — the only shape dsh can be given without replacing
  // its provider and model. Absent: a reported login is never adopted, and the owner sets it up.
  ownLoginTiers?: Partial<Record<TierId, Partial<TierValues>>>;
  // Whether this executor could be handed a tier's value at all: the whole of what can be
  // told without asking the CLI, which drops or replaces a tier it cannot read without a
  // word. A `ref` is a place on the machine, except where the executor's own command reads
  // a value of that shape as the tier's text. Absent when any value will do.
  checkTier?: (tier: Tier) => string | undefined;
  // How to ask which models a login of this executor may use: given an account's login token,
  // or nothing for a machine's own login. Absent when there is no way to ask, and then the
  // list stays empty and the console's form takes a model typed by hand.
  listModels?: (context: { token?: string }) => ModelQuery;

  launch(turn: Turn): Launch;
  resume(turn: Turn): Launch;
  // For display only: a line it cannot read yields nothing and never changes a Run.
  parse(line: string): NormalizedEvent[];
  resultReader?: (limits?: ResultLimits) => ResultReader;
  result(stdout: string, exitCode: number | null, stderr: string): Reading;
}

// What the service reads out of the adapters by executor name instead of asking about any
// executor itself: the dispatcher whether a session may be continued, the account check
// which permission modes an account may name and which tier values its command can be
// given, the model catalog how an account's models are asked for, and the console how a
// tier of it is written. The adapters themselves are the authority.
export type ExecutorDeclarations = Pick<Adapter, 'accountLogin' | 'resumable' | 'permissionModes' | 'checkTier' | 'tierForm' | 'listModels' | 'readOnly' | 'minVersion' | 'globalEntry' | 'memory' | 'config' | 'mcpOff' | 'machineQuota' | 'credential' | 'credentialCheck' | 'provider' | 'signIn' | 'credentialLifetimeDays'>;
export type Executors = Readonly<Record<string, ExecutorDeclarations>>;
