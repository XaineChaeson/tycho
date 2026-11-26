// What the host and a machine's client say to each other (docs/design/nodes.md §4.1, §8.2).
// Both sides carry a protocol version: one that does not match is refused and reported as
// such, never read as "the machine has gone" — that would turn "too old" into "the run was
// lost". The commands are a closed set: the host cannot ask a machine for anything else,
// no script path, no arbitrary shell.
//
// A path here is spelled relative to a data directory, with the prefix the protocol has always
// carried (".tycho/tasks/<task>/runs/<run>"): the client resolves it under its own data directory
// (nodes.md §7). The host never learns where that is.
import type { ModelInfo, QuotaWindow } from '../adapters/types.ts';
import type { CodeCheck, ReadOnlyLayer } from './roles.ts';
import type { ConfigKind } from './machine-inputs.ts';
import type { ExecutorIdentity } from './logins.ts';

// 2: the credential answer may carry join materials with no credential (`value` null),
// and the host may send `retire` (§1.3). A client of 1 would read that null as a token.
// 3: the hold of a poll is the host's, said in NODE_HOLD_HEADER as the hold begins. A
// client of 2 gives up on a poll at 75 s whatever the host holds it for, and a client of
// 3 facing a host of 2 never hears the hold and gives up at its plain request limit.
// 4: how often the machine looks at its executors again is the host's (node.executorRefreshMs),
// said in every poll answer as `look_every_ms`, and the client keeps no clock of its own. A
// client of 3 goes on looking every ten minutes whatever the host says, and a client of 4
// facing a host of 3 is never told and stops looking after its first look.
// 5: a start says how the credential reaches the Worker (`credential`: on a pipe whose number a
// variable carries, or as a variable's value) where it named only the pipe's variable; and a
// machine can be asked to run its executor's own sign-in (`sign_in`, `sign_in_cancel`), whose
// progress rides the polls both ways (`sign_ins`). A client of 4 does not read `credential` and
// would start the round with no credential at all: the round would run as whoever the machine
// itself is signed in as — the wrong identity, with nobody told. So the two never speak.
// Since then `credential.via` is only `env`: the pipe is gone. The field is kept so that a
// client of 5 reads the same shape it always did, and a host that still asks for the pipe is
// refused by the client with the words in `wayProblem`.
// 6: a round may name a code source instead of carrying a bundle (docs/design/code-sources.md,
// shared/sources.ts): the machine clones a repository or works in a folder already on it, and
// the round's material is reached from that working directory through
// MATERIALS_PLACEHOLDER. A client of 5 has no source handling at all and would run the round in
// an empty task directory, with the brief's paths nowhere; the two never speak, so a machine
// whose client is older takes no work at all until it is upgraded.
// During protocol 6, optional fields were added without moving the number; those additions
// were read only when present and did not hold work: in a report
// `read_only.checks_code` (and the whole `read_only`, `credential`, `models`, `config` and
// `quota` parts), and in a poll answer `models_timeout_ms`, `quota_timeout_ms` and `entry`.
// That compatibility described additions within protocol 6, not entry ownership in version 7.
// 7: global knowledge entries carry a persistent publisher; older readers cannot establish
// ownership or recognize every projection, so their entry reports cannot authorize work.
// Every supplied entry content now includes publisher (known identity or explicit problem);
// missing/invalid publisher never authorizes a write. Protocol 6 reports are refused.
export const NODE_PROTOCOL = 7;
import type {CaptureSpec,OutputPolicy,OutputCapacity,OutputReference} from './node-output.ts';
export type OutputRelease={kind:'capture';source:string}|{kind:'legacy';run_dir:string};
export interface NodeOutputReport {capacity:OutputCapacity;references:{items:OutputReference[];next?:string};legacy:{items:{run_dir:string}[]}}
export interface NodePrepareCapture {id:string;kind:'prepare_capture';run_dir:string;spec:CaptureSpec}
export interface NodeReadCapture {id:string;kind:'read_capture';run_dir:string;source:string;stream:'stdout'|'stderr';offset:number;bytes:number}
export interface NodeReadResult {id:string;kind:'read_result';run_dir:string;source:string;offset:number;bytes:number}
export type CapturePrepared={state:'ready';files:NodeFileHash[]}|{state:'capacity';reason:string;capacity:OutputCapacity};

// Where the machine puts this round's material (the snapshot directory: the brief, the
// round's files, on-demand knowledge), as every adapter's command line refers to it. The host
// writes it into the arguments it builds; the watch replaces it with the absolute directory
// before it starts the Worker, whatever its working directory is (a repository's checkout or a
// folder on the machine). A client of 6 substitutes it; nothing else may name the path.
export const MATERIALS_PLACEHOLDER = '{tycho-materials}';

// Where this round puts what it delivers (the round's own `artifacts/`, beside its snapshot),
// as an adapter that has to open that directory to its sandbox refers to it. A writable
// round's working directory is the source's — a repository checkout or a folder on the
// machine — so the delivery directory is not under it, and an executor whose sandbox allows
// writes only under its working directory has to be told about it by name. The watch makes
// the directory and substitutes this placeholder with its absolute path, exactly as for the
// material; a read-only round is never given it (docs/design/code-sources.md §2).
export const ARTIFACTS_PLACEHOLDER = '{tycho-artifacts}';

// The same delivery directory, written as a TOML string (`'C:\x'`, or `"C:\\x"` when the path
// carries the quote a literal string ends on), for an executor whose own option is TOML — Codex's
// `sandbox_workspace_write.writable_roots` (adapters/codex.ts). The encoding has to happen where
// the real path is known: encoded first and substituted after, a path with a single quote in it
// would end the string early and the whole argument would be invalid TOML. The machine is the one
// that knows the path, so the whole value is its to write.
export const ARTIFACTS_TOML_PLACEHOLDER = '{tycho-artifacts-toml}';

// One path as a TOML string: a literal string, so that a Windows path's backslashes are their own
// characters; a path carrying the quote a literal string ends on is written as a basic string,
// with the escapes TOML reads (the same rule the adapter used before the substitution moved here).
export function tomlString(path: string): string {
  return path.includes("'") ? JSON.stringify(path) : `'${path}'`;
}

// One block of a log or a file travels back in a report. The gateway's own limit is
// client_max_body_size 1m, so 256 KiB leaves room for the encoding and the rest of the
// answer without touching the gateway's configuration (nodes.md §8.2).
export const NODE_CHUNK_BYTES = 256 * 1024;

// How long a poll is held open is the host's alone to say (the setting node.pollHoldMs).
// When it starts holding one, it sends the answer's headers at once with the hold in this
// header; the client then waits that long plus NODE_POLL_MARGIN_MS for the body before it
// takes the poll for lost. Before the headers come it waits as for any other request.
export const NODE_HOLD_HEADER = 'x-tycho-hold-ms';
// What the way between the two may add to a hold: a slow link, a proxy passing the answer on.
export const NODE_POLL_MARGIN_MS = 15_000;

// What a machine's report may carry of the models one executor lists (NodeExecutorStatus):
// this many models, each with this many strengths, every name a single line. The host refuses
// a whole report over one entry out of this shape, so the machine reports a list that does not
// fit as no list, with why. The longest catalog recorded has ten models of six strengths.
export const NODE_MODELS_MAX = 200;
export const NODE_MODEL_EFFORTS_MAX = 20;

// How many names one kind may carry; a longer answer is reported as unread, with why.
export const NODE_CONFIG_NAMES_MAX = 200;

// What one machine may report of one login's quota (NodeQuotaStatus): this many windows, each
// with a name that is one line. The host refuses a whole report over one entry out of this
// shape, so the machine reports one that does not fit as no reading, with why.
export const NODE_QUOTA_WINDOWS_MAX = 20;

// What one login's quota is, as the machine that holds that login read it there
// (docs/design/usage.md §3). The host keeps these figures with the login, where the rounds'
// own figures go; the moment they were read is the machine's, so a report that arrives late
// never looks newer than it is.
export interface NodeQuotaStatus {
  // When the machine read it: the moment its command answered, not when the report arrived.
  at: string;
  windows: QuotaWindow[];
  // Why there is no reading, in the owner's words, never the command's own output. Absent
  // when `windows` is the answer; with no windows and no error the reading was empty.
  error?: string;
  // A valid answer that named no window at all (a subscription notice with the window lines
  // left out). Unavailable for this read, kept neutrally: the host preserves the last figures
  // and shows no failure. Absent when `windows` is the answer or `error` says why not.
  absent?: true;
}

// How a machine's client follows the version the host runs (docs/design/nodes.md §1.4). These
// two routes are deliberately outside the protocol version check: they are the way a client
// whose protocol is refused finds out what version to move to and gets it. FROZEN — the
// request and answer shapes below never change for the life of these routes; a change needs a
// new path instead.
export const NODE_RELEASE_PATH = '/api/node/release';
export const NODE_RELEASE_PACKAGE_PATH = '/api/node/release/package';
export const NODE_RELEASE_VERSION_HEADER = 'x-tycho-version';
// Host -> Node incremental skill bundle mirroring (End-State 2): each node receives only
// the bundles authorized for its machine_id by the Host's skill_registry / entry_machines.
export const NODE_SKILLS_PACKAGE_PREFIX = '/api/node/skills';

export interface NodeSkillBundleItem {
  slug: string;
  // Deterministic content hash of all files in the bundle (relative paths + contents + modes).
  digest: string;
  // Total uncompressed byte size of files in the bundle.
  bytes: number;
}

export interface NodeSkillsManifest {
  // Overall manifest digest derived from sorted (slug, digest) pairs; empty list has a stable digest.
  digest: string;
  items: NodeSkillBundleItem[];
}

export const NODE_LOCAL_SKILLS_MAX = 100;
export const NODE_LOCAL_SKILL_DESC_MAX = 200;

// Read-only metadata summary of a non-mirror local skill present on a node (e.g. intranet-only
// company skills). Never carries SKILL.md body, scripts, or host paths.
export interface NodeLocalSkillSummary {
  slug: string;
  name: string;
  description: string;
}

export interface NodeSkillsReport {
  digest: string;
  synced: string[];
  skipped?: { slug: string; reason: string }[];
  local_skills?: NodeLocalSkillSummary[];
  error?: string;
}
export const NODE_RELEASE_SHA256_HEADER = 'x-tycho-sha256';

// What a client says about itself: the version it is running, and what it last did about
// being behind the host. `target` is the version it was told to move to.
export interface NodeReleaseReport {
  version: string;
  upgrade: null | { state: 'waiting' | 'failed'; target: string; detail: string };
}

// What the host answers: the version it runs, the package for it (null with `why` when this
// host has none to give), and how long the client should wait before asking again.
export interface NodeReleaseAnswer {
  version: string;
  package: { sha256: string; bytes: number } | null;
  why: string | null;
  check_every_ms: number;
}

// A machine's last report, as the host keeps it: the report and when it was made. The host
// keeps this in memory only.
export interface NodeReleaseHeld extends NodeReleaseReport {
  at: string;
}

// Where a round that may spawn machines finds its one-time join materials, and the address
// a new machine joins at (docs/design/nodes.md §1.3). Both reach the Worker through its
// environment: the materials over the credential channel, one per machine the quota can
// still register, separated by single spaces; the address from whoever knows where this
// host is reached (the client, by where it polls). The names are the protocol's, so the
// skill can name them.
export const JOIN_MATERIALS_ENV = 'TYCHO_JOIN_MATERIALS';
export const HOST_URL_ENV = 'TYCHO_HOST_URL';

// Take this round's snapshot: fetch it, write it, report the hash of every file written.
// Taking a snapshot is not starting: a client that cannot do it has started nothing, and
// the host is free to send the round to another machine.
interface NodePrepare {
  id: string;
  kind: 'prepare';
  run_dir: string;
}

// Start this round: take the gate, write the round marker, start the watch process and the
// Worker, report the process evidence. Never sent twice for one round.
export interface NodeStart {
  id: string;
  kind: 'start';
  source?:string;
  run_dir: string;
  task_id: string;
  run_id: string;
  // Which round of its Task this is, from 1; a later round ends an earlier one.
  round: number;
  argv: string[];
  env: Record<string, string>;
  // How the Worker is handed its credential, as the executor's adapter declares it: as the value
  // of the variable it names. The credential itself never travels in a command: the client
  // fetches it over the channel that exists for it (POST /api/node/runs/:id/credential). Null:
  // the round runs as the machine's own login.
  credential: NodeCredentialWay | null;
  // Whether this round is handed one-time join materials for machines it may spawn
  // (nodes.md §1.3). Like the credential, they never travel in a command: the client
  // fetches both over the same channel and the Worker reads them from JOIN_MATERIALS_ENV.
  // Absent means no.
  invite?: boolean;
  // Whether this host has a managed GitHub token to deliver over the credential channel
  // for this round (even when `credential === null`, e.g. for machine-own logins).
  github?: boolean;
  // How long this round may run here. The host has the same limit and what it sends is a
  // stop; this one is what ends a round whose host cannot be reached (nodes.md §4.4).
  timeout_ms?: number;
  // State-aware watchdog: max silence while waiting on model/init with NO active tool or child subprocess.
  // Absent or <= 0 disables model-idle termination.
  model_idle_timeout_ms?: number;
}

export interface NodeCredentialWay {
  // Only `env`: the token is the variable's value. Kept as a field so that a client of version 5
  // reads the shape it was written against.
  via: 'env';
  variable: string;
}

// What a variable the host names may be called: a name every shell and system takes as it is.
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Why the host's way cannot be used on a machine, or nothing when it can. The client and the
// watch both ask before anything is started: a way they cannot use is a round that did not
// start, never one that runs without its credential.
export function wayProblem(way: NodeCredentialWay | null): string | undefined {
  if (way === null) return undefined;
  // A host still asking for the pipe is one this program no longer hands a token to
  // (tests/fixtures/claude/2.1.303-win/auth-status): told plainly, never run without it.
  if ((way.via as string) === 'fd') return '主机要求用文件描述符交令牌，这一版的 tycho 已经不这么交：把主机升级到同一版';
  if (way.via !== 'env') return `主机给的凭据交付方式不认识：${JSON.stringify(way.via)}`;
  if (typeof way.variable !== 'string' || !ENV_NAME.test(way.variable)) return `主机给的凭据变量名不能用：${JSON.stringify(String(way.variable).slice(0, 80))}`;
  return undefined;
}

// Revoke the start first, then take the gate, then end the round's own processes. Safe to
// repeat.
interface NodeStop {
  id: string;
  kind: 'stop';
  run_dir: string;
}

interface NodeStateCommand {
  id: string;
  kind: 'state';
  run_dir: string;
}

interface NodeList {
  id: string;
  kind: 'list';
  alive_only: boolean;
}

// Read a slice of one of this round's files, by byte offset.
interface NodeReadOutput {
  id: string;
  kind: 'read_output';
  path: string;
  offset: number;
  bytes: number;
}

// Bounded file content uses a distinct command so an older client rejects it before
// opening anything. It shares the output reader, including physical path checks.
interface NodeReadFile extends Omit<NodeReadOutput, 'kind'> {
  kind: 'read_file';
  file_limit_bytes: number;
}

// What this round left under its own artifacts/: one entry per file (name, sha256, size),
// as structured data; a name the listing could not carry is refused, not skipped. It reads that one directory and nothing else — the seventh command of the table in
// nodes.md §4.1 does not reach a directory listing (§1). Not an arbitrary command: the path is
// this Run's.
interface NodeArtifacts {
  id: string;
  kind: 'artifacts';
  run_dir: string;
}

// Drop what this round staged on the machine. Refused while the round still has processes.
interface NodeDropRun {
  id: string;
  kind: 'drop_run';
  run_dir: string;
}

// Drop this Task's code copies on the machine — the checkout of each of its sources, under
// tasks/<task>/<source id>/ (and the old tasks/<task>/repo/) — once the work it belongs to
// ended and its retention period passed (service/retention.ts). Refused while any round of the
// Task still has processes, or one this machine cannot check; the round's own records under
// tasks/<task>/runs/ and the round markers under tasks/<task>/rounds/ stay. A directory that is
// not there is a success, and the command may be sent again: it is the host's retry, not a
// one-shot. A folder source is never a copy of tycho's: its path is not under the Task's
// directory and nothing here reaches it.
interface NodeDropTaskCode {
  id: string;
  kind: 'drop_task_code';
  task_dir: string;
}

// Ask this machine what its own executors are and whether they are signed in
// (docs/design/nodes.md §1.2, §11 step 5). The command carries nothing: which executors are
// asked, and with which command, is the client's own closed set, read from the adapter
// declarations on that machine. Nothing the host says can put a command line into it.
interface NodeProbe {
  id: string;
  kind: 'probe';
}

// An ephemeral machine's work here is over: its quota's task has ended and it runs nothing
// (nodes.md §1.3). The client answers, leaves (POST /api/node/leave) and stops. Only a
// machine that came in with a material is ever told this; what happens to the instance
// afterwards is the creating skill's, not this protocol's.
interface NodeRetire {
  id: string;
  kind: 'retire';
}

// Run this executor's own sign-in on this machine (docs/design/native-login.md): the command is
// the one its adapter on the machine declares, never one the host sends. Answered as soon as it
// is started; what becomes of it rides the polls (`sign_ins`). A machine that cannot run it says
// so the same way, never by failing the command.
interface NodeSignInCommand {
  id: string;
  kind: 'sign_in';
  sign_in_id: string;
  executor: string;
  timeout_ms: number;
}

// End that sign-in. Safe to repeat, and for one this machine does not know.
interface NodeSignInCancel {
  id: string;
  kind: 'sign_in_cancel';
  sign_in_id: string;
}

// Hand the owner's one-time authorization code (or callback URL) to a running sign-in whose
// adapter declared `acceptsCode: true`. Written once to the child's stdin and never logged.
interface NodeSignInCode {
  id: string;
  kind: 'sign_in_code';
  sign_in_id: string;
  code: string;
}

// Read-only remote directory listing for picking a folder code source on this machine.
// Never returns file contents; only directory/file names under the requested directory.
interface NodeBrowseDirs {
  id: string;
  kind: 'browse_dirs';
  path?: string;
  show_hidden?: boolean;
}

// Create one direct subdirectory under an existing absolute directory (no recursive creation).
interface NodeCreateDir {
  id: string;
  kind: 'create_dir';
  parent: string;
  name: string;
}

// Rename a single existing directory within its current parent directory (no moves, no overwrites).
interface NodeRenameDir {
  id: string;
  kind: 'rename_dir';
  path: string;
  name: string;
}

export interface NodeDirEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  is_git?: boolean;
}

export interface NodeBrowseDirsResult {
  path: string;
  parent: string | null;
  home: string;
  roots: string[];
  platform: string;
  entries: NodeDirEntry[];
  truncated?: boolean;
}

export interface NodeCreateDirResult {
  path: string;
  name: string;
}

export interface NodeRenameDirResult {
  path: string;
  name: string;
}

export type EntryRepairAction = 'coexist' | 'backup_takeover' | 'resync';
export const ENTRY_REPAIR_ACTIONS: readonly EntryRepairAction[] = ['coexist', 'backup_takeover', 'resync'];
export const isEntryRepairAction = (value: unknown): value is EntryRepairAction =>
  typeof value === 'string' && (ENTRY_REPAIR_ACTIONS as readonly string[]).includes(value);

// Repair one executor's global instruction entry on this machine (coexist via managed block,
// back up and take over, or resync).
interface NodeRepairEntry {
  id: string;
  kind: 'repair_entry';
  executor: string;
  action: EntryRepairAction;
  content: NodeEntryContent;
}

export interface NodeRepairEntryResult {
  status: NodeEntryStatus;
  backup_path?: string;
  report: NodeEntryReport;
}

// Ask this machine to upgrade one installed executor CLI (idle-safe: refused with `busy: true`
// if the machine currently has any active run) and immediately re-probe its executors.
export interface NodeUpdateExecutor {
  id: string;
  kind: 'update_executor';
  executor: string;
  timeout_ms?: number;
}

export interface NodeUpdateExecutorResult {
  ok: boolean;
  executor: string;
  method: string;
  before_version: string | null;
  after_version: string | null;
  updated: boolean;
  busy?: boolean;
  error?: string;
  output?: string;
  report?: NodeExecutorReport;
}

export type NodeCommand =
  | NodePrepareCapture
  | NodeReadCapture
  | NodeReadResult
  | NodePrepare
  | NodeStart
  | NodeStop
  | NodeStateCommand
  | NodeList
  | NodeReadOutput
  | NodeReadFile
  | NodeArtifacts
  | NodeDropRun
  | NodeDropTaskCode
  | NodeProbe
  | NodeRetire
  | NodeSignInCommand
  | NodeSignInCancel
  | NodeSignInCode
  | NodeBrowseDirs
  | NodeCreateDir
  | NodeRenameDir
  | NodeRepairEntry
  | NodeUpdateExecutor;

// One sign-in this machine knows of, as it stands now. `url` and `code` are what the owner opens
// and types elsewhere, read off the command's screen by the adapter; nothing else the command
// printed ever leaves the machine.
//   starting   — started, nothing read yet;   waiting    — read, the owner is to authorise it;
//   exchanging — pasted code sent to stdin;   done       — the command ended 0;
//   failed     — it ended otherwise, ran out of time, or could not be started;
//   cancelled  — ended because it was asked to be.
export type NodeSignInState = 'starting' | 'waiting' | 'exchanging' | 'done' | 'failed' | 'cancelled';
// Why one failed, as one of a few kinds and never the command's own words:
//   missing — no such command here, or no sign-in declared;  exit — ended non-zero;
//   timeout — out of time after showing what to type;          unreadable — out of time, nothing read.
export type NodeSignInReason = 'missing' | 'exit' | 'timeout' | 'unreadable';

export interface NodeSignIn {
  id: string;
  executor: string;
  state: NodeSignInState;
  url?: string;
  code?: string;
  accepts_code?: boolean;
  reason?: NodeSignInReason;
}

export const SIGN_IN_STATES: readonly NodeSignInState[] = ['starting', 'waiting', 'exchanging', 'done', 'failed', 'cancelled'];
export const SIGN_IN_REASONS: readonly NodeSignInReason[] = ['missing', 'exit', 'timeout', 'unreadable'];
export const signInEnded = (state: NodeSignInState): boolean => state === 'done' || state === 'failed' || state === 'cancelled';

// §4's table, as a machine answers it. `unknown` non-null says this answer cannot be
// trusted about processes (the scan was refused, or there was nothing to read it with):
// the Run is then unknown, never ended.
export interface NodeState {
  started: boolean;
  launcher_alive: boolean;
  pid_alive: boolean;
  marked: boolean;
  exit: number | null;
  unknown: string | null;
  // Set only on a round that is over and whose Worker the watch never ran, with why: the
  // round did not start, whatever its gate says. A client from before this says nothing.
  not_started?: string;
  // A read-only round's code check (roles-and-tiers.md §5), on a round that is over: what the
  // watch found when it compared the round's own code with the baseline it took before the
  // Worker started. Absent on a writable round, and on a read-only one whose watch wrote none.
  // A folder source has no code of tycho's to compare: the machine reports `no-code` with what
  // it read of the folder — `folder_change`, information only (docs/design/code-sources.md
  // §8.2) — and is never held to have proved anything about the folder.
  code_check?: NodeCodeCheck;
  // What the watch read of this round's code source once the round was over (docs/design/
  // code-sources.md §8 第 4、6 条). Absent when the round has no source, nothing ran, or a
  // client that does not read these. The host binds a review to it and takes the Task's start
  // from it; it never asks the remote itself.
  source_head?: NodeSourceHead;
}

// Where a round's code stood, as the machine that ran it read it (docs/design/code-sources.md
// §8 第 4、6 条). The machine is the one with the repository's access, so the remote branch
// head is read there with `git ls-remote`; a folder has no remote, and its HEAD is what the
// round's code is. `start` is the HEAD read when this round began: the first round of a Task
// gives the Task's start, and a review's range is measured from it.
export interface NodeSourceHead {
  kind: 'repo' | 'folder';
  // HEAD of the working copy the round ran in, as the machine read it when the round ended;
  // null with `problem` when it could not be read (a folder that is not a repository, say).
  head: string | null;
  // The branch HEAD names, when it names one: a detached HEAD has none.
  branch?: string;
  // For a repository: the head of `branch` on the remote, read at the end of the round; null
  // with `problem` when the remote could not be asked, is not readable from this machine, or
  // has no such branch.
  remote_head?: string | null;
  // The HEAD this round started from, so that the host knows the Task's start (§8 第 6 条).
  start?: string | null;
  // Why one of the facts above could not be read, in the machine's words.
  problem?: string;
}

export type NodeCodeCheck = CodeCheck;

export interface NodeRunSummary {
  task_id: string;
  run_id: string;
  // Whether this Run still has a process on the machine. Null: the machine cannot say, and
  // its history is not the same as nothing running (docs/design/nodes.md §4.3).
  alive: boolean | null;
}

export interface NodeFileHash {
  path: string;
  sha256: string;
  bytes: number;
}

// What a machine fetches when it is told to prepare a round (GET
// /api/node/runs/:id/snapshot, §8.2): the round's own files (UTF-8 text by default, or
// base64-encoded binary when `encoding === 'base64'`). A round whose project names a source
// also has `source.json`, and the watch prepares the working directory from it.
export interface NodeSnapshot {
  run_dir: string;
  files: { path: string; text: string; encoding?: 'utf8' | 'base64' }[];
}

// One file this round left, as artifacts.sh listed it: the host checks the hash it is
// given against the bytes it reads back.
export interface NodeArtifact {
  name: string;
  sha256: string;
  bytes: number;
}

export interface NodeRange {
  // Base64: the bytes of a log are not text.
  base64: string;
  size: number;
  // Seconds since the epoch; 0 when the file does not exist.
  mtime: number;
}

export interface NodeStartResult {
  // 0 started, 3 the gate was already taken, 4 a stop overtook the start, 6 a later round
  // of the Task holds the instance, 2 nothing was started.
  code: number;
  // Whether the watch process's own evidence (pid and the moment it began) was read back
  // before this answer. False still means the gate is this round's: the host asks state
  // rather than sending the start again.
  confirmed: boolean;
  pid: number | null;
  started_at: string | null;
  // Why nothing was started, when the machine knew before it tried. Nothing was started
  // either way, and the host does not send the start again.
  error?: string;
}

export interface NodeStopResult {
  // False: nothing of this round is left. True: something is still there. Null: the check
  // could not be made, which proves nothing about the round.
  alive: boolean | null;
  // With null: why, in the machine's words. A client from before this says nothing.
  unknown?: string;
}

// What one executor on a machine says about itself, as that machine asked it (nodes.md §1.2):
// which version its own command is, whether it is signed in, and which models it lists. The
// first two are read from the command's exit code and its version line; the models are what the
// adapter's own declaration parses out of the listing command. Nothing else — no identity, no
// usage, no other words of its own — is read. The login belongs to that machine and that user:
// nothing here creates, merges or moves an account.
export interface NodeExecutorStatus {
  // The name the host knows this executor by, which is what the adapter declares.
  executor: string;
  // Whether the executor's own command runs here at all. False is "not installed": nothing
  // else in this entry means anything.
  installed: boolean;
  // The version line its own command printed, cut to what a page shows. Null when it printed
  // none, or did not run.
  version: string | null;
  // The exit code of the executor's own login command: 0 is signed in, anything else is not.
  // Null when the executor has no such command (then this says nothing about it), or when
  // that command could not be run at all — `error` says which.
  logged_in: boolean | null;
  // The personal subscription ID and optional short display label read by the login probe.
  // An absent label means the client did not report one; null clears an earlier label.
  identity?: ExecutorIdentity;
  // Where this machine found the executor's command, as an absolute path: on PATH or in one of
  // the places its adapter declares (node/locate.ts). Absent when it was not found, or an
  // older client did not say.
  path?: string;
  // Why nothing could be read, in the owner's words: the command is not there (and every place
  // that was looked in), it did not answer in time, it could not be run.
  error?: string;
  // Present when this version cannot run this program's commands at all (the adapter's
  // lowest version): what it lacks and what to upgrade to. Nothing of this executor's is
  // dispatched to this machine while it is.
  unusable?: string;
  // Whether the executor's read-only way, as this program declares it, starts here: a probe
  // that writes nothing and spends no quota (roles-and-tiers.md §5). `layer` is how far the
  // declared way reaches; `error` is why it did not start, in the executor's own words where
  // it gave any. Absent when it was not asked: not installed, or the executor declares no way.
  // `checks_code` is this client's word that it checks a read-only round's code once the round
  // is over (node/code-check.ts); a client that does not say so takes no read-only work.
  read_only?: { available: boolean; layer: ReadOnlyLayer; error?: string; checks_code?: true };
  // Whether this machine's executor would take the token tycho hands an account's round, asked
  // with the adapter's own command and a placeholder value, so that nothing is written and no
  // quota is spent (Adapter.credentialCheck). `adopted` false with `error` saying why; absent
  // when it was not asked — not installed, an unusable version, an executor that declares no
  // such question, or a client older than this field.
  credential?: { adopted: boolean; error?: string };
  // What the executor's own command lists as the models it can run here, parsed on the machine
  // by the adapter's own declaration: nothing else of that command's output leaves the machine
  // (a configuration dump may hold secrets). `error` is why nothing was read, in the owner's
  // words. Absent when it was not asked — not installed, a version that cannot be used, an
  // adapter that declares no command — or the client is older than this field.
  models?: { list: ModelInfo[]; error?: string };
  // What the executor's own commands list of its configuration here, kind by kind, as the
  // adapter's declaration parses them on the machine: the names, or why none were read (in the
  // owner's words). Only the kinds that were asked: absent altogether when nothing was — not
  // installed, a version that cannot be used, or a client older than this field.
  config?: { kind: ConfigKind; names?: string[]; error?: string }[];
  // What this machine read of this executor's own login's quota here (docs/design/usage.md §3):
  // the windows, and when they were read. Read on the machine because that is where the login
  // is; asked only of an executor whose adapter declares a way (`Adapter.machineQuota`) and
  // only while it is signed in. Absent when it was not asked — not installed, a version that
  // cannot be used, not signed in, no way declared — or the client is older than this field.
  quota?: NodeQuotaStatus;
}

// One executor's status as the host keeps it for placing work: what its machine reported,
// and when that machine asked.
export type ReportedStatus = NodeExecutorStatus & { asked_at?: string };

// What a machine reported about its executors, and the moment it asked them. A fact about
// that machine, kept as the machine's own report: the host never asks an executor anything
// itself (nodes.md §1.2, §11 step 5).
export interface NodeExecutorReport {
  at: string;
  executors: NodeExecutorStatus[];
}

// What tycho puts into each executor's own global instruction entry on a machine
// (docs/design/knowledge-and-skills.md §4.3): the owner's global resident knowledge for any role.
// The host renders it; the machine only adds the header and writes it where each of its
// executors reads it. `digest` names this content: the machine reports it back once it has
// applied it, and a file it wrote carries it, so the same content is never written twice.
export interface EntryPublisherSource { hostname: string; port: number }
export type EntryPublisher = { id: string; source?: EntryPublisherSource } | { problem: string };
export function isEntryPublisherSource(value: unknown): value is EntryPublisherSource {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Partial<EntryPublisherSource>;
  return typeof source.hostname === 'string' && /^[\p{L}\p{N}_.:-]{1,253}$/u.test(source.hostname) && Number.isInteger(source.port) && source.port! > 0 && source.port! <= 65535;
}
export const isEntryPublisherId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
export function entryPublisherOf(value: unknown): EntryPublisher {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const raw = value as { id?: unknown; source?: unknown; problem?: unknown };
    if (isEntryPublisherId(raw.id)) return { id: raw.id, ...(isEntryPublisherSource(raw.source) ? { source: { hostname: raw.source.hostname, port: raw.source.port } } : {}) };
    if (typeof raw.problem === 'string' && raw.problem.trim() !== '') return { problem: raw.problem };
  }
  return { problem: '主机没有提供可核实的全局知识发布方，未改动投影' };
}


export interface NodeEntryContent {
  publisher: EntryPublisher;
  digest: string;
  // The entries it carries, each as `id@revision`, for the file's header.
  revisions: string[];
  // What goes below the header, or null when there is nothing to write: no entry applies, or
  // what applies is over the limit (`problem` then says so). Null takes down only a file owned by this publisher.
  text: string | null;
  problem?: string;
}

// What became of the entry of one executor on a machine:
//   written  — the file holds this content, and nothing the executor's own rules say keeps it out;
//   covered  — written, but the executor will not read it (`note` says what is in the way);
//   unconfirmed — written, but whether the executor reads it turns on what could not be checked
//              here (`note` says what);
//   occupied — a file tycho did not write is there, and was left as it is;
//   failed   — it could not be written or taken down;
//   cleared  — there was nothing to write, and no file of tycho's is left there.
type NodeEntryState = 'written' | 'covered' | 'unconfirmed' | 'occupied' | 'failed' | 'cleared';

export type EntryProjection = { state: 'absent' } | { state: 'present'; revisions: string[] } | { state: 'unknown'; why: string };

export interface NodeEntryStatus {
  executor: string;
  // Where the file is, as this machine names it.
  path: string;
  state: NodeEntryState;
  note?: string;
  // Observed in the effective instruction slot, independent of what the writer tried to do.
  projection?: EntryProjection;
}

// What a machine last did with the entry content, for the machine's page. `digest` is the
// content these statuses are for, null before any was given.
export interface NodeEntryReport {
  digest: string | null;
  at: string;
  executors: NodeEntryStatus[];
}

// What a client tells the host about itself. `node_id` is the client's own random
// identity, made once and kept: it is not the hostname and not the operating system's
// machine id, which cloned images share (nodes.md §7).
export interface NodeFacts {
  node_id: string;
  name: string;
  platform: string;
  hostname: string;
}

// The join: the six digits point at one request, the secret the requesting machine keeps
// is what exchanges for a token (nodes.md §1.1, §9).
export interface NodeJoinRequest {
  protocol: number;
  facts: NodeFacts;
  // Present when this machine is claiming a registration it already holds.
  claim?: { secret: string };
  // The other way in (nodes.md §1.3): a one-time material a round of a task was handed,
  // and a secret this machine made and keeps. The secret is what makes the redemption
  // retryable — the same machine asking again with the same secret gets the registration
  // it already made, never a second one — and what keeps another machine that saw the
  // material from claiming this machine's registration.
  invite?: { material: string; secret: string };
  // This host's own token from its service.json, sent only to a loopback address (nodes.md
  // §1.1 step 2). The host takes it only on its inside listener from a loopback peer; a
  // token that does not match is not an error, the join goes the ordinary way.
  local_token?: string;
}

export type NodeJoinAnswer =
  | { protocol: number; state: 'pending'; code: string; secret: string; expires_at: string }
  | { protocol: number; state: 'missing' }
  | { protocol: number; state: 'rejected' }
  | { protocol: number; state: 'approved'; token: string; machine_id: string };

export interface NodePollRequest {
  service_manager?: import('./service-manager.ts').ServiceManagerReport;
  bounded_output?:1;
  output?:NodeOutputReport;
  protocol: number;
  // The last command this client took delivery of: the only proof the host ever gets that
  // one arrived. A command the host sent and no poll carries is one the machine never saw,
  // so it waits for the next connection — a start is the one command never sent twice, and
  // its caller is told to ask the machine what state the round is in instead.
  cursor: string | null;
  runs: NodeRunSummary[];
  facts: NodeFacts;
  // What this machine's own client read from its executors, with the moment it asked them
  // (nodes.md §1.2). Sent with every poll, like what it says is running: the host keeps the
  // last one for the pages. Absent until the first look is done.
  executors?: NodeExecutorReport;
  // What it did with the global entry content it was last given. Absent until checked;
  // protocol 7 requires a current reader before any projection fact can authorize work.
  entry?: NodeEntryReport;
  // Every sign-in this machine knows of, as it stands now. One that has ended is said until an
  // answer's `sign_ins` leaves it out: that is how the host says it has seen it.
  sign_ins?: NodeSignIn[];
  // This client can be told to drop a Task's code copy on this machine (`drop_task_code`),
  // sent with every poll. A client from before it never sends this and is never sent that
  // command: what its machine holds stays there, and the pages do not say it was cleared.
  drops_task_code?: true;
  // Last Host->Node skill bundle sync status reported by this node (additive; absent on older clients).
  skills?: NodeSkillsReport;
}

// `entry` comes with an answer when the content the poll says it applied is not the host's
// current one. In protocol 7 any supplied entry includes its publisher; old readers are refused.
// `look_every_ms`
// is how often the machine looks at its own executors again (the host's setting
// node.executorRefreshMs): the host owns the policy, the client takes it from each answer.
// `models_timeout_ms` is how long the one command that lists an executor's models may take
// (node.modelListTimeoutMs): its own span, because it may reach the vendor after a fresh
// sign-in. `quota_timeout_ms` is how long a read of one login's own quota may take
// (node.quotaReadTimeoutMs): its own span too, because one of these commands counts a whole
// session's use before it answers. A client of an older host is not told either and keeps its
// own defaults (30 and 120 seconds); the other probes keep their 6.
// `sign_ins` are this machine's sign-ins the host still holds: one the machine knows and the
// host leaves out is over for the host — ended, it is forgotten; under way, it is ended (the
// host restarted, or gave up hearing from it).
export type NodePollAnswer = {
  output_policy?: OutputPolicy;
  output_releases?: OutputRelease[];
  // Desired skill bundles authorized for this machine; sent when the node's reported digest differs.
  skills?: NodeSkillsManifest;
} & (
  | { protocol: number; command: NodeCommand; entry?: NodeEntryContent; look_every_ms: number; models_timeout_ms: number; quota_timeout_ms: number; sign_ins: string[] }
  | { protocol: number; command: null; entry?: NodeEntryContent; look_every_ms: number; models_timeout_ms: number; quota_timeout_ms: number; sign_ins: string[] });

export interface NodeReportRequest {
  protocol: number;
  command_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// What a round is handed over the credential channel: the account's token (null when the
// account has none and the machine's own login is used; how it reaches the Worker the start
// says), the one-time join materials when this round may spawn machines, and an optional
// host-managed GitHub token for zero-config git/gh authentication.
export interface NodeCredentialAnswer {
  value: string | null;
  materials: string[] | null;
  github_token?: string;
}

// A refused protocol version, in the words the owner reads on the machine.
export const protocolMismatchText = (theirs: number): string =>
  `协议版本不符：这台机器上的客户端是第 ${theirs} 版，主机是第 ${NODE_PROTOCOL} 版。升级落后的那一个（tycho update），再重试。`;
