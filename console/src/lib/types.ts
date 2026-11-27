import type { Locale } from '@shared/i18n.ts';
import type {OutputCapacity} from '@shared/node-output.ts';
import type { ReportDescriptor } from '@shared/report.ts';
export type { ReportDescriptor } from '@shared/report.ts';
import type { RouterCallTrace } from '@shared/trajectory.ts';
import type { InboundKind, InboundReach } from '@shared/triggers.ts';
import type { InternalEventKind } from '@shared/internal-events.ts';
import type { MachineInputs } from '@shared/machine-inputs.ts';
// What the service's /api answers hold, as far as the pages read them.
import type { Lost, RouterState, Summary, LoginStatus, Wait, CredentialState, MachineEnds, MachineSourceView } from '@shared/labels.ts';
import type { CodeCheck, ReadOnlyLayer, RoleConfig, RunAccess, TierSource } from '@shared/roles.ts';
import type { Disposition, EntryState, EvidenceSource, Grant, KnowledgeKind, Loading, OwnerReason, ProposalSource, ProposalState } from '@shared/knowledge.ts';
import type { DirectorySkill, EntryMachinesMap, IgnoredSkillEntry } from '@shared/skill-catalog.ts';
import type { ReviewGateInfo, ReviewOf, SameExecutor, VerdictRecord } from '@shared/review.ts';
import type { DispatchSlotsConfig } from '@shared/dispatch-slots.ts';
import type { AccountLoginOffer } from '@shared/logins.ts';
import type { TierFormSpec } from '@shared/tier-form.ts';
import type { ProviderDraft, ProviderForm } from '@shared/provider-form.ts';
import type { TierId } from '@shared/tiers.ts';
import type { DiagnosticLevel, FileChange, ModelInfo, NormalizedEvent, ToolCall, ToolCategory, ToolOutput } from '../../../adapters/types.ts';
import type { RetiredTier } from '@shared/logins.ts';
import type { SourceView, SnapshotSource, TaskSourceView } from '@shared/sources.ts';

export type { DiagnosticLevel, FileChange, Lost, ModelInfo, NormalizedEvent, ReviewGateInfo, RouterState, ToolCall, ToolCategory, ToolOutput };

export interface WorkSummary extends Summary {
  text: string;
  leaf: boolean;
  counts: Record<string, number>;
  // When the last of an ended work ended; null while any of it goes on.
  ended_at?: string | null;
}

// A page of the ended list: the works on it, how many match in all, the tasks under them,
// and where the next page starts (null on the last one).
export interface EndedWorks {
  total: number;
  next: string | null;
  works: Task[];
  children: Task[];
}

export type ProjectFileKind = 'upload' | 'artifact' | 'doc';
export type ProjectFileOrigin = 'owner' | 'router' | 'worker';

export interface ProjectFileSummary {
  id: string;
  project_id: string;
  name: string;
  mime: string;
  size: number;
  kind: ProjectFileKind;
  origin: ProjectFileOrigin;
  summary: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
  previewable: boolean;
  is_image: boolean;
}

export interface Message {
  id: string;
  direction: 'in' | 'out';
  channel?: string;
  external_id: string;
  text: string;
  state: string | null;
  final?: number | null;
  // When it was said: the ledger has always sent it; the conversation now shows it.
  created_at?: string;
  // Which project's conversation, and which segment of it (docs/design/project-sessions.md §1).
  // A message waiting to be taken has no segment yet; one in the old global record has none.
  project_id?: string | null;
  segment_id?: string | null;
  basis?: string | null;
  attachments?: ProjectFileSummary[];
}

export interface Change {
  action: string;
  at: string;
  actor?: string;
}

// A Task as a capsule under the turn that created it.
export interface TaskCapsule {
  id: string;
  title: string;
  state: string;
}

export interface TurnChanges {
  changes: Change[];
  tasks: TaskCapsule[];
}

export interface Question {
  question: string;
  about?: string;
  options?: string[];
  recommend?: number;
}

export interface Approval {
  id: string;
  task_id: string;
  task_title: string;
  // The Task's project: a project's conversation shows its own questions.
  project_id?: string | null;
  // Set when this approval was opened by a decide-tier review rejection.
  review_task_id?: string | null;
  state: string;
  questions: Question[];
  answers: unknown[] | null;
  answered_via: string | null;
  created_at?: string;
}

export interface Run {
  id: string;
  task_id: string;
  task_revision: number;
  // Internal reference and the display name captured for this round.
  login_id: string | null;
  login_name?: string | null;
  machine_id?: string | null;
  host: string;
  session_ref: string | null;
  state: string;
  exit_kind: string | null;
  executor: string | null;
  // Which group of logins placed this round (roles-and-tiers.md §11): prefer, spread, order,
  // pinned, same_executor. Null for a Run from before the ledger recorded it.
  placed_by?: string | null;
  receipt: Receipt | null;
  report_files?: ReportDescriptor[];
  // `quota`: on a Run the executor's quota ended, where it ran and until when that target rests.
  // `code_check`: on a read-only round, what became of its code (shared/roles.ts).
  error: { reason?: string; message?: string; lost?: unknown; code_check?: CodeCheck; quota?: { login_id?: string; login_name?: string; account_id?: string; target_id?: string; rest_until?: string | null } } | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export type ReportContent = { run_id: string; ref: string; name: string; text: string } & (
  { source: 'registered' | 'node' } | {
    source: 'settlement' | 'recovered';
    complete: boolean;
    bytes: number;
    original_bytes: number;
    sha256: string;
    at: string;
  }
);

export interface Artifact {
  kind: string;
  ref?: unknown;
}

export interface Receipt {
  status: string;
  summary: string;
  artifacts?: Artifact[];
  ask?: Question[];
  later?: { at: string; about?: string };
}

export interface TaskAssignment {
  role_id: string | null;
  role_name: string | null;
  tier: string | null;
  tier_source: string | null;
  login_name: string | null;
  executor: string | null;
  machine_name: string | null;
  placed_by: string | null;
  is_live: boolean;
}

export interface Task extends TaskSourceView {
  id: string;
  parent_id?: string | null;
  // Null for a knowledge gate or curation Task, which belongs to no project.
  project_id?: string | null;
  title: string;
  state: string;
  reason?: string | null;
  goal?: string;
  acceptance?: string | null;
  revision?: number;
  // The login the Task is pinned to; null lets the service pick one of its project's.
  login_id?: string | null;
  login_name?: string | null;
  // Optional target machine pinned on the Task; null lets the service choose.
  machine_id?: string | null;
  // `source`, `source_state` and `source_label` (shared/sources.ts TaskSourceView) come from the
  // service's one projection of a Task's source: what it is pinned to, how the pin stands against
  // the project's list now, and how the owner reads it. Declared there so that the service and
  // this page cannot drift apart without the compiler saying so; all null for a Task of a project
  // with no source at all.
  // Null on a Task from before roles.
  role_id?: string | null;
  // The tier a round would run on now, worked out by the service from the role and the
  // override; null when there is no role to work it out from.
  tier?: string | null;
  tier_source?: TierSource | null;
  tier_override?: TierId | null;
  tier_reason?: string | null;
  // The logins the Router asked to try first, with why, in the Router's order
  // (roles-and-tiers.md §11). A preference: the tier's global order is the fallback.
  prefer?: { login_ids: string[]; reason: string } | null;
  wake_at?: string | null;
  created_at?: string;
  updated_at?: string;
  summary?: WorkSummary;
  lost?: Lost | null;
  // What a Task in the queue waits for when none of its targets can take it now.
  waiting?: Wait | null;
  accept_blocked?: string | null;
  active_review?: string | null;
  review_gate?: ReviewGateInfo | null;
  latest_run?: Run | null;
  finished_at?: string | null;
  resumable?: boolean;
  assignment?: TaskAssignment | null;
}

export interface TaskInput {
  id: string;
  run_id: string | null;
  text: string;
  state: string;
  created_at: string;
}

// A release package a Run brought back, and how the last time one was put in place ended.
export interface ReleasePackage {
  run_id: string;
  at: string;
  // The package's name on the host, not its path: what a launch names.
  file: string;
  version: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseResult {
  at: string;
  from: string | null;
  to: string;
  // A completed health verdict; pending names checks left after the candidate started.
  verified: boolean;
  pending?: readonly string[];
  ok: boolean;
  rolled_back: boolean;
  // The version `current` named once the attempt was over: the one installed, the one
  // gone back to, or null when it could not be read.
  in_use: string | null;
  lines: string[];
}

// A release the owner asked for that no result has answered yet. Where that package sits
// on this host is deliberately not here: the page names a version and a digest, not a path.
export interface ReleaseIntent {
  at: string;
  run_id: string;
  name: string;
  version: string;
  sha256: string;
  bytes: number;
}

// What the host holds of this Task's newest Run's artifacts, both halves: the registration
// in use, and the last taking since it that failed. A failed re-taking leaves the earlier
// registration in use.
interface ReleaseFetch {
  registered: { at: string; files: string[] } | null;
  failed: { at: string; problem: string } | null;
}

// A round whose registered copies the host cleared after its work ended and the retention
// period passed (service/retention.ts): the page says so, and offers nothing of it.
export interface DroppedRelease {
  run_id: string;
  at: string;
}

export interface TaskReleases {
  // The version the service is running now.
  version: string;
  last: ReleaseResult | null;
  // Asked for and not yet answered; `attempting` says whether its command is still at work.
  intent: ReleaseIntent | null;
  attempting: boolean;
  fetch: ReleaseFetch | null;
  packages: ReleasePackage[];
  // Rounds the retention rule cleared. Absent from an older service.
  dropped?: DroppedRelease[];
}

export interface TaskDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
}

export interface TaskDiffResponse {
  source: 'git' | 'executor' | 'none';
  commit: string | null;
  base: string | null;
  branch: string | null;
  files: TaskDiffFile[];
  truncated: boolean;
  reason?: string;
}

export interface LandableInfo {
  landable: boolean;
  pr: string | null;
  commit: string | null;
  already_integrated: boolean;
  active_landing_task_id: string | null;
  active_landing_task_state?: string | null;
  active_landing_task_title?: string | null;
  reason: string | null;
}

export interface TaskAutomation {
  router_busy: boolean;
  resting_until: string | null;
  active_review_id: string | null;
  active_review_state: string | null;
}

export interface TaskPage {
  task: Task & { goal: string; revision: number; created_at: string };
  work: Task;
  children: Task[];
  runs: Run[];
  inputs: TaskInput[];
  approvals: Omit<Approval, 'task_title'>[];
  releases: TaskReleases;
  // The Task's role as it stands now, or null when it names none.
  role?: Role | null;
  // Review (docs/design/roles-and-tiers.md §4, §6). Absent from an older service.
  review?: TaskReview;
  // Whether this Task's delivered PR/branch can be merged into main. Absent from an older service.
  landable?: LandableInfo | null;
  // Live automation context (Router busy/resting or active review). Absent from an older service.
  automation?: TaskAutomation | null;
  // Automatic dispatch / failover metadata for the latest run. Absent from an older service.
  dispatch_info?: {
    latest_login: string | null;
    latest_machine: string | null;
    failover_note: string | null;
  };
  // A gate or curation Task's work, source and projects (knowledge §3); null for any other.
  knowledge?: KnowledgeTaskView | null;
  // The skills the Task names (knowledge §4.1), as they are now. Absent from an older service.
  skills?: { id: string; title: string | null; revision: number | null; state: 'active' | 'retired' | null }[];
  // Visual/document deliverables automatically ingested from Worker runs into project files.
  deliverables?: ProjectFileSummary[];
}

export interface KnowledgeTaskView {
  kind: 'gate' | 'curation';
  proposal_id?: string;
  entries?: string[];
  source_project_id: string | null;
  projects: string[];
}

export interface TaskReview {
  // For a review: what it is bound to, and the reviewed Task as it is now.
  of: (ReviewOf & { reviewed_title: string; reviewed_state: string }) | null;
  verdict: VerdictRecord | null;
  // For any Task: the reviews bound to it.
  reviews: { id: string; title: string; state: string; reason: string | null; verdict: VerdictRecord | null }[];
  needs_review: boolean;
  // Why it cannot be accepted yet, when it waits to be accepted and cannot.
  blocked: string | null;
  // Structured review gate status. Absent from an older service.
  gate?: ReviewGateInfo | null;
  // The times a review's rejection moved it up a tier.
  escalations: { at: string; review_task_id: string; from: string; to: string; reason?: string }[];
}

export interface Role extends RoleConfig {
  created_at: string;
  updated_at: string;
}

export interface RunEvents {
  events: NormalizedEvent[];
  first_index?: number;
  loaded?: boolean;
  reason?: string;
}

export interface RunSnapshot {
  brief?: string;
  tier?: string;
  // The tier whose content this round ran on, when it is not the Task's own: an operate
  // round on a login with no operate content runs on its execute content
  // (roles-and-tiers.md §10.3). Absent otherwise, and on every round from before.
  tier_from?: TierId;
  // The role as it was when this round went out, and where its tier came from. Absent on a
  // round from before roles.
  role?: RoleConfig;
  tier_source?: TierSource;
  tier_reason?: string;
  // Where this round's code came from, as that round's own snapshot recorded it (shared/sources.ts
  // SnapshotSource) — not the source the Task is pinned to now, which may have moved since.
  // Left out for a round whose project names no source: it worked in an empty task directory
  // (runner/snapshot.ts).
  source?: SnapshotSource;
  // The field a round from before code sources recorded instead: such a round had code, sent as
  // a bundle, so it is said as a round from before code sources rather than as one that worked
  // without any.
  repo?: unknown;
  // A review that ran on an executor that wrote its product, and why (roles-and-tiers §4 ②).
  same_executor?: SameExecutor;
  // How the round was run: read-only and to which layer, or writable. Absent on a round from
  // before read-only was carried out, which ran writable.
  access?: RunAccess;
  // What the round may still read on its machine beyond the snapshot (knowledge §4.1, §1.3).
  // Absent on a round from before that was recorded.
  machine_inputs?: MachineInputs;
}

export interface Trace {
  trigger: { label: string; message?: { text: string } | null; change?: Change | null; tool_call?: RouterCallTrace | null };
  origin_call?: RouterCallTrace | null;
  inputs: { text: string }[];
  session_ref: string | null;
  task_revision: number;
  dispatchConditions?: unknown;
  changes: Change[];
  settlement?: { at: string; task_state: string | null; exit_kind: string | null; policy?: { rule: string; reason: string } | null; delivery: 'held' | 'pending' | 'sent' | 'given_up' | 'unknown' } | null;
}

interface Dispatch {
  degraded?: boolean;
  recovering?: boolean;
  paused?: boolean | null;
}

export interface LaunchingRun {
  id: string;
  task_id: string;
  task_title?: string;
  host?: string;
  unconfirmed?: boolean;
}

export interface OrphanReport {
  machine_id: string;
  host: string;
  runs: { run_id: string; task_id: string; alive: boolean }[] | null;
  error?: string;
}

export interface Restore {
  from: string;
  backup_at: string | null;
  restored_at: string;
  held_tasks: { id: string; title: string }[];
  unverified_messages: { id: string; text: string; at: string; changes: Change[] }[];
  runs: { id: string; task_id: string; task_title: string; host: string; state: string; exit_kind: string | null }[];
  orphan_runs: OrphanReport[];
  missing_logins?: string[];
  missing_credentials?: { id: string; name: string }[];
}

export interface Backup {
  configured: boolean;
  dir?: string;
  at?: string;
  last_ok_at?: string | null;
  last_ok_incomplete?: boolean;
  last_error?: { at: string; text: string } | null;
  running?: boolean;
}

export interface WecomState {
  connected?: boolean;
  error?: string | null;
}

export interface WeixinChannelState {
  state: string;
  error?: string | null;
}

interface GatewayState {
  state: 'off' | 'connecting' | 'connected' | 'down';
  since: string | null;
  error: string | null;
}

export interface ServiceState {
  // Absent when talking to a service from before the page-refresh notice.
  version?: string;
  locale?: Locale;
  dispatch: Dispatch;
  router: RouterState;
  channels?: { wecom?: WecomState | null; weixin?: WeixinChannelState | null } | null;
  gateway?: GatewayState;
  launching_runs?: LaunchingRun[];
  outbox?: Outbox | null;
  restore?: Restore | null;
}

export interface OutboxFailure {
  id: string;
  payload_json: string;
  error?: string | null;
  created_at: string;
  first_failed_at?: string | null;
  task_title?: string | null;
}

export interface Outbox {
  pending?: number;
  given_up?: number;
  failures?: OutboxFailure[];
}

export interface Overview {
  counts: { waiting: number; moving: number; ready: number; knowledge_awaiting?: number; pending_joins?: number };
  approvals: Approval[];
  moving: Task[];
  recent: Task[];
  held?: Task[];
  parked_waiting?: Task[];
  no_machine?: { login_id: string; login_name?: string; since: string }[];
  launching?: LaunchingRun[];
  outbox?: Outbox;
  state: ServiceState;
  restore?: Restore | null;
  backup?: Backup;
}

export interface DoctorCheck {
  id: string;
  level: 'ok' | 'warn' | 'fail';
  title: string;
  text: string;
  fix: { label: string; href: string } | null;
}

export interface Setting {
  key: string;
  group: string;
  title: string;
  help: string;
  type: string;
  unit?: 'seconds' | 'minutes' | 'hours';
  choices?: string[];
  empty?: string;
  // A list of logins for an item of type 'logins'.
  default: string | number | boolean | string[];
  value: string | number | boolean | string[];
  restart: boolean;
  stored: boolean;
  overridden: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface SettingsPage {
  settings: Setting[];
  deployment: { title: string; value: string }[];
  wecom: { secret_set: boolean };
  router: RouterState;
}

// One executor on a machine that came back by itself, as that machine's own client read it
// when it asked (nodes.md §1.2): whether its command is on that machine at all, the version
// line it printed, and whether it is signed in. `logged_in` is null when the executor has no
// such command, or that command could not be run — `error` says which, in the owner's words.
export interface MachineExecutor {
  executor: string;
  installed: boolean;
  version: string | null;
  logged_in: boolean | null;
  // Where the machine found its command; when it is not installed, `error` says where it looked.
  path?: string;
  error?: string;
  // This version cannot run the service's commands at all, and why (shared/node-protocol.ts).
  unusable?: string;
  // Whether the executor's read-only way started there, and how far it reaches.
  read_only?: { available: boolean; layer: ReadOnlyLayer; error?: string; checks_code?: true };
  // False when this executor offers no read-only way at all: no read-only task goes to it.
  read_only_offered?: boolean;
}

// What a machine last reported of its own executors, and when it asked them. Null on a
// machine means it has not said yet — never that nothing is installed there.
export interface MachineExecutors {
  at: string;
  executors: MachineExecutor[];
}

// A machine that came back to the service by itself: which client it is, and whether it is
// here right now. `source` is the round that spawned it, null when the owner let it in by
// hand; `scope` is what its quota allows it and `ends` its endings, each its own fact
// (nodes.md §1.3) — both only on a spawned machine. `reported_runs` is what the machine
// itself last said was alive on it, and `reported_unknown` the rounds it holds whose
// processes it could not read.
export interface MachineNode {
  service_manager?: import('@shared/service-manager.ts').ServiceManagerReport | null;
  bounded_output?:1|null;
  output?:{capacity:OutputCapacity;unknown_sources?:number}|null;
  node_id: string;
  platform: string | null;
  joined_at: string | null;
  last_seen_at: string | null;
  connected: boolean;
  reported_runs: number;
  reported_unknown: number;
  source: MachineSourceView | null;
  ephemeral: boolean;
  scope: { project_id: string; executors: string[] | null } | null;
  ends: MachineEnds | null;
  // What the machine said about its own executors. Null: it has not reported yet.
  executors: MachineExecutors | null;
  // What it did with the global entry (knowledge-and-skills.md §4.3). Null: it has not said —
  // a client from before the entry, or one that has not polled since the service started.
  entry?: EntryReport | null;
  // Read-only metadata summary of non-mirror local skills on this node (zero body/scripts).
  local_skills?: { slug: string; name: string; description: string }[];
  // What version its client runs and what it is doing about being behind the host
  // (docs/design/nodes.md §1.4). Null: a client too old to report it.
  release: NodeRelease | null;
}

// A machine's own report of the version it runs, and its last move towards the host's.
export interface NodeRelease {
  version: string;
  at: string;
  upgrade: null | { state: 'waiting' | 'failed'; target: string; detail: string };
}

// The global entry of one executor on a machine (shared/node-protocol.ts NodeEntryStatus).
export interface EntryStatus {
  executor: string;
  path: string;
  state: 'written' | 'covered' | 'unconfirmed' | 'occupied' | 'failed' | 'cleared';
  note?: string;
}

export interface EntryReport {
  digest: string | null;
  at: string;
  executors: EntryStatus[];
}

// A machine's own login of one executor (docs/design/accounts-machines-decoupled.md): one
// the machine says it is signed in to, or one set up here. It runs on that machine alone,
// with the tiers and limits set here. `configured` false is one the machine reports and
// nobody has given tiers yet: it takes no work until it has them. A login with no operate
// content takes operate work on its execute content (roles-and-tiers.md §10.3).
export interface MachineLogin {
  display_name?: string | null;
  account_label?: string | null;
  plan_label?: string | null;
  route_label?: string | null;
  routes?: { id: string; label?: string; source?: 'account' | 'api-key' | 'custom' }[];
  can_route: boolean;
  router_reason: string | null;
  id: string | null;
  name: string;
  kind: 'machine';
  machine: string;
  executor: string;
  signed_in: boolean | null;
  configured: boolean;
  tiers: Record<string, Tier>;
  // Tiers it holds in a shape no round can be given; absent when there are none.
  retired_tiers?: RetiredTier[];
  permission_mode: string | null;
  timeout_ms: number | null;
  max_runs: number | null;
  status: LoginStatus;
  models?: AccountModels;
  queued_tasks: number;
  // Its executor refused it under a round, and nothing since has put that right.
  refused: boolean;
  // Whether what its machine said lets it work there: false while the machine says it is
  // signed out, or has not reported this executor.
  usable_here: boolean;
}

// A machine joined by its own client and comes back by itself (docs/design/nodes.md §1.1).
// Its name and hostname are what that client said; the note is the owner's.
export interface Machine {
  id: string;
  // This registration of the machine, never used again: what a project's choice of machines
  // names (the name can come to mean another machine).
  uid: string;
  host: string;
  note: string | null;
  node: MachineNode;
  logins?: MachineLogin[];
}

// A join quota a round of a task asked for (nodes.md §1.3): what the machines it lets in may
// do, how many it may let in and until when, and what became of the materials it handed.
// Null executors: whichever the project allows.
export interface Invite {
  id: string;
  created_at: string;
  project_id: string;
  task_id: string;
  executors: string[] | null;
  expires_at: string;
  max_machines: number;
  used: number;
  revoked_at: string | null;
  last_handed_at: string | null;
  last_run_id: string | null;
  material: MachineEnds['material'];
  machines: string[];
}

// A machine that ran the join command and waits for the owner to let it in (nodes.md §1.1).
// The six digits only point at the request; the secret that becomes its token stays on that
// machine, so this list holds nothing secret.
export interface PendingJoin {
  code: string;
  name: string;
  platform: string;
  hostname: string;
  created_at: string;
  expires_at: string;
}

// A project: which logins its tasks may run as — accounts and machines' own logins in one
// list, with no order of preference (each tier's global order decides that) — which machines
// its work may go to, and where its code comes from, in order (docs/design/code-sources.md).
// The counts are of its top-level work.
export type LoginMode = 'all' | 'selected';

// What deleting a project would take, as the ledger reads it (project-sessions, "项目的生命周期"):
// the rows that go, the shared rows that stay with this project taken out of their scope, and
// the no-project knowledge tasks it leaves pointless — given up, shrunk and still queued, or
// already over with only a reference to lose.
export interface DeletionCount {
  label: string;
  count: number;
  unit: string;
}

export interface ProjectDeletion {
  allowed: boolean;
  reason: string | null;
  counts: DeletionCount[];
  scope_removed: DeletionCount[];
  canceled: DeletionCount[];
  reduced: DeletionCount[];
  finished: DeletionCount[];
}

export interface ProjectHome {
  phase: 'owned' | 'frozen' | 'incoming' | 'unknown';
  service_id: string;
  generation: number | null;
  target_service: string | null;
}

export interface Project {
  home?: ProjectHome | null;
  id: string;
  name: string;
  // Its code sources in order of preference; the first is the default (shared/sources.ts).
  // Empty is a project whose work runs in an empty task directory.
  sources: SourceView[];
  logins: string[];
  // Every login, or only the ones listed; `pool` is what it runs as now.
  login_mode: LoginMode;
  pool?: string[];
  // The machines it allows: each by its registration, with the name it goes by now.
  machines: { uid: string; name: string }[];
  // How many machines the list names that were deleted since: they match nothing, and a list
  // of only them allows no machine.
  machines_gone?: number;
  // Whether its tasks may bring in machines of their own, with one-time join materials.
  spawn_machines: boolean;
  // When the owner paused it; null while it runs. Absent from an older service.
  paused_at?: string | null;
  // When the owner archived it; null while it is in sight. Absent from an older service.
  archived_at?: string | null;
  // Whether it may be deleted, why not, and what would go with it. Absent from an older service.
  deletable?: ProjectDeletion;
  // Every work not over, counted for the archive confirmation.
  unfinished?: number;
  // What its Router may do without asking (shared/grants.ts). Absent from an older service.
  grants?: string[];
  router?: { account: string | null; tier: string | null };
  dispatch_order?: Partial<Record<TierId, string[]>> | null;
  dispatch_slots?: DispatchSlotsConfig | null;
  effective_dispatch_order?: Record<TierId, string[]>;
  moving: number;
  waiting: number;
}

// A tier is either the executor's own configuration text, which rides this Run's snapshot
// to the machine, or a place on the machine that already holds it.
export type Tier = { kind: 'content'; text: string };

// The models the account's executor last reported, and when that was read. `refreshing`
// is a query on its way now, which is why the list beside it may be older than this moment.
export interface AccountModels {
  list: ModelInfo[];
  at: string | null;
  refreshing: boolean;
  // Why there is no list, when the service said.
  reason?: string | null;
}

export interface Account {
  credential: CredentialState;
  signed_in?: boolean | null;
  id: string;
  name: string;
  executor: string;
  account_label?: string | null;
  plan_label?: string | null;
  // Whether this account's executor can be the Router, which binds it by id.
  can_route: boolean;
  tiers: Record<string, Tier>;
  // Tiers it holds in a shape no round can be given; absent when there are none.
  retired_tiers?: RetiredTier[];
  permission_mode: string | null;
  timeout_ms: number | null;
  max_runs: number | null;
  // The line it is, for an executor whose account is a line to a model service; its key is
  // not in it. Null for any other account; absent from an older service.
  provider?: ProviderDraft | null;
  // Absent from a service with no model catalog: the form then takes a model typed by hand.
  models?: AccountModels;
  status?: LoginStatus;
  queued_tasks: number;
}

// What the console reads of the service's logins and machines, in one answer: the two pages
// that show them (账号 and 机器) share it, so a page that has just read one has the other's
// option declarations too. The service splits the same data over `/api/accounts` and
// `/api/machines`; this is that pair, joined.
export interface LoginTelemetry {
  five_hour_tokens: number;
  five_hour_runs: number;
  day_tokens: number;
  day_runs: number;
  week_tokens?: number;
  week_runs?: number;
  total_tokens?: number;
  total_runs?: number;
  last_at: string | null;
}

export interface AccountsAndMachines {
  accounts: Account[];
  login_aliases?: Record<string, string>;
  login_telemetry?: Record<string, LoginTelemetry>;
  login_groups?: string[][];
  machines: Machine[];
  invites: Invite[];
  // Each tier's dispatch order as it stands now (roles-and-tiers.md §11): logins the owner
  // listed first, then the rest. Absent from an answer from a service before this step.
  dispatch_order?: Record<string, string[]>;
  dispatch_slots?: DispatchSlotsConfig | null;
  // What the service did with the global entry for its own machine's executors. Null: not yet.
  host_entry?: EntryReport | null;
  host_machine?: string | null;
  // The version this service runs, for what each machine says it runs (nodes.md §1.4).
  host_version?: string | null;
  // The address the owner gave as this service's own; null when none was given. What a
  // machine joins at (docs/design/nodes.md §1.1).
  public_url?: string | null;
  executors: string[];
  // By executor: the permission modes its own command takes. An executor with none of its
  // own is absent, and then an account on it has no such field.
  permission_modes: Record<string, string[]>;
  // By executor: the shape its tier's text takes, which values the form edits and the
  // strengths its command takes. An executor with none is shown as its raw text.
  tier_forms: Record<string, TierFormSpec>;
  credential_executors: string[];
  // By executor: how an account of it gets the login tycho keeps, as the executor itself
  // declares it and in the order to offer them, with whether each can be done on this host
  // now. None for an executor whose login stays on its machines.
  account_logins: Record<string, AccountLoginOffer[]>;
  // By executor: what defines a line, for one whose account is a line and its key.
  provider_forms?: Record<string, ProviderForm>;
}

export interface MachineCheck {
  machine_id?: string;
  host: string;
  reachable: boolean;
  error?: string | null;
  version?: string | null;
  logged_in?: boolean | null;
  // `ref` tiers whose file this machine does not have, where the executor would go on with
  // its own configuration and say nothing. Absent when there are none.

}

// Knowledge (docs/design/knowledge-and-skills.md). The service's own shapes are in
// service/knowledge.ts; these are what the knowledge pages read of them.
export interface KnowledgeRevision {
  id: string;
  revision: number;
  kind: KnowledgeKind;
  title: string;
  when_to_use: string;
  body: string;
  // Null is 全局; otherwise one or more project ids, sorted.
  project_ids: string[] | null;
  loading: Loading;
  roles: string[];
  proposal_id: string;
  published_by: string;
  published_at: string;
  // Null while it is in force unreviewed.
  reviewed_at: string | null;
}

export interface KnowledgeEntry extends KnowledgeRevision {
  created_at: string;
  state: EntryState;
  retired_at: string | null;
  retired_by: string | null;
  retired_reason: string | null;
  replaced_by: string | null;
}

export interface KnowledgeEvidence {
  id: string;
  proposal_id: string;
  seq: number;
  source: EvidenceSource;
  ref: string | null;
  location: string;
  excerpt: string;
  captured_at: string;
  sha256: string;
  submitted_by: string;
  verified: boolean;
}

export interface KnowledgeWhy {
  when: string;
  changes: string;
  generalizes: string;
}

// An existing entry a change touches, pinned to the revision it read, and where it goes.
export interface ChangeInput {
  knowledge_id: string;
  revision: number;
  active: boolean;
  disposition: Disposition;
  // An output's key, or an existing entry's id.
  replaced_by: string | null;
  note: string;
}

// What a change puts out: a new entry, or a revision of the input it `revises`.
export interface ChangeOutput {
  key: string;
  revises: string | null;
  title: string;
  when_to_use: string;
  body: string;
  project_ids: string[] | null;
  loading: Loading;
  roles: string[];
  // The entry it became, once the change is published.
  knowledge_id?: string;
}

export interface KnowledgeChange {
  kind: KnowledgeKind;
  inputs: ChangeInput[];
  outputs: ChangeOutput[];
}

interface KnowledgeGate {
  result: 'pass' | 'reject';
  reason: string;
  modified: boolean;
  task_id: string;
  run_id: string;
}

export interface KnowledgeProposal {
  id: string;
  created_at: string;
  kind: KnowledgeKind;
  // As sent; what takes (or took) effect is `final`, which the gate may have changed.
  change: KnowledgeChange;
  final: KnowledgeChange | null;
  why: KnowledgeWhy;
  source: ProposalSource;
  proposed_by: string;
  request_id: string | null;
  task_id: string | null;
  run_id: string | null;
  amended_from: string | null;
  next_id: string | null;
  digest: string;
  final_digest: string | null;
  prior_rejection: { id: string; reason: string | null; rejected_at: string | null } | null;
  gate_task_id: string | null;
  gate: KnowledgeGate | null;
  owner_reasons: OwnerReason[];
  state: ProposalState;
  state_reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decided_via: string | null;
  decision_note: string | null;
  published_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  evidence: KnowledgeEvidence[];
}

export type KnowledgeProposalRow = Omit<KnowledgeProposal, 'evidence'> & { evidence_count: number; verified_count: number };

export interface KnowledgeClient {
  id: string;
  created_at: string;
  name: string;
  executor: string;
  grants: Grant[];
  revoked_at: string | null;
}

// An old long-term ruling the upgrade to project sessions could not turn into a knowledge
// proposal (docs/design/project-sessions.md §6): kept, with why, until the owner deals with it.
export interface LegacyDecision {
  id: string;
  created_at: string;
  task_id: string | null;
  project_id: string | null;
  text: string;
  // Null: not tried yet (it is on the next start).
  problem: string | null;
}

export interface KnowledgePage {
  legacy: LegacyDecision[];
  awaiting: KnowledgeProposalRow[];
  to_review: KnowledgeProposalRow[];
  proposals: KnowledgeProposalRow[];
  entries: KnowledgeEntry[];
  directory_skills?: DirectorySkill[];
  ignored_skills?: IgnoredSkillEntry[];
  skills_dir?: string;
  entry_machines?: EntryMachinesMap;
  machines?: { id: string; host: string }[];
  clients: KnowledgeClient[];
  projects: { id: string; name: string }[];
  roles: { id: string; name: string }[];
  executors: string[];
  public_url?: string | null;
  // Where the old skill files were kept by default: what an import reads unless told otherwise.
  skill_folder?: string;
}

// What the import of the old skill files found or did with each file (knowledge §6).
export interface SkillImportItem {
  path: string;
  project_id: string | null;
  title: string | null;
  state: 'new' | 'proposed' | 'imported' | 'refused' | 'skipped' | 'failed';
  proposal_id?: string;
  reason?: string;
}
export interface SkillImport {
  dir: string;
  items: SkillImportItem[];
}

interface KnowledgeSize {
  brief: number;
  files: number;
}

export interface KnowledgeProposalPage {
  proposal: KnowledgeProposal;
  // For `final ?? change`: each input as pinned and as it is now.
  inputs: (ChangeInput & { pinned: KnowledgeRevision | null; now: KnowledgeEntry | null })[];
  impact: {
    // actual: what a change in force did, read back from history; forecast: weighed on today's entries.
    kind: 'actual' | 'forecast';
    dropped: { knowledge_id: string; title: string; disposition: Disposition; lines: string[] }[];
    combos: { project_id: string; project: string; role_id: string; role: string; before: KnowledgeSize; after: KnowledgeSize }[];
  };
  gate_task?: { id: string; state: string; reason: string | null };
}

export interface KnowledgeEntryPage {
  entry: KnowledgeEntry;
  revisions: (KnowledgeRevision & { proposed_by: string; source: ProposalSource; evidence: KnowledgeEvidence[] })[];
}

// A project's conversation as the page reads it (docs/design/project-sessions.md §1): its
// segments, the one in view and whether it can be written to, and how much of the old global
// record is linked to the project.
export interface Segment {
  id: string;
  seq: number;
  state: 'current' | 'closed';
  created_at: string;
  closed_at: string | null;
}

export interface Conversation {
  home?: ProjectHome | null;
  project: { id: string; name: string; paused_at?: string | null; archived_at?: string | null };
  segments: Segment[];
  segment: string | null;
  writable: boolean;
  contexts: { id: string; created_at: string; state: string; closed_reason: string | null; closed_at: string | null; login_id: string | null }[];
  legacy: number;
  busy: string | null;
  router_error?: string | null;
}

// A project's trigger as the service shows it (docs/design/triggers.md §1, §7): its rule, the next
// moment in its zone and in UTC, and what it last refused.
type TriggerSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'every'; every_ms: number; anchor: string }
  | { kind: 'cron'; expr: string; zone: string };

export interface Trigger {
  id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  source: string;
  // One of the two, by source: a time rule, or the internal event it subscribes to.
  schedule: TriggerSchedule | null;
  event: { kind: InternalEventKind; task_id: string | null } | null;
  // What sets it off, in words.
  schedule_text: string;
  instruction: string;
  missed: 'latest' | 'skip';
  expires_at: string | null;
  push_final: boolean;
  broadcast_groups?: boolean;
  broadcast_group_ids?: string[];
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  zone: string;
  next_at: string | null;
  next_local: string | null;
  ended: 'done' | 'expired' | null;
  // Why the next moment is unknown: the rule cannot be worked out any more. Null otherwise.
  next_error: string | null;
  rejected: { count: number; at: string; reason: string; text: string } | null;
  // A problem of the trigger itself, while the service says it is still there (§8).
  problem: { kind: string; since: string; text: string } | null;
}

// One accepted occurrence, and how the turn of its message went.
export interface TriggerFire {
  id: string;
  created_at: string;
  // One of the two: the rule that fired, or the inbound source that delivered the event.
  trigger_id: string | null;
  source_id: string | null;
  project_id: string;
  trigger_name: string;
  event_id: string;
  scheduled_at: string | null;
  revision: number | null;
  outcome: 'delivered' | 'merged' | 'replaced' | 'missed' | 'expired';
  merged_into: string | null;
  merged_count: number;
  // merged_count is only a lower bound: the service stopped counting at its cap.
  merged_capped: boolean;
  message_id: string | null;
  message_state: string | null;
  push_final: boolean;
  public_reply?: string;
  data: Record<string, unknown>;
}

export interface TriggersPage {
  triggers: Trigger[];
  recent: TriggerFire[];
  // The host's zone, for a new cron rule; how close two moments of a rule may come.
  zone: string;
  min_interval_ms: number;
  groups?: BroadcastGroupChoice[];
}

// An inbound source (docs/design/triggers.md §2.2): one caller of the whole tycho, the projects
// it may deliver to, its keys as ids and retirement times, and its own entrance.
export interface InboundSource {
  result_reply?: boolean;
  id: string;
  name: string;
  kind: InboundKind;
  kind_label: string;
  project_ids: string[];
  note: string;
  push_final: boolean;
  broadcast_groups?: boolean;
  broadcast_group_ids?: string[];
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  rejected: { count: number; at: string; reason: string; text: string } | null;
  problem: { kind: string; since: string; text: string } | null;
  path: string;
  ready: boolean;
  keys: { id: string; created_at: string; retires_at: string | null }[];
}

export interface InboundPage {
  sources: InboundSource[];
  recent: TriggerFire[];
  projects: { id: string; name: string; repos: string[] }[];
  kinds: { kind: InboundKind; label: string; about: string }[];
  // Whether the internet can reach the sources now, and the address it would (§2.2).
  reach: { reach: InboundReach; reach_text: string; public_url: string | null };
  groups?: BroadcastGroupChoice[];
}

// An inbound key as the service hands it over, once.
export interface IssuedInboundKey {
  key_id: string;
  secret: string;
  source: InboundSource;
}

export type ImChannel = 'wecom' | 'weixin';
export type ImGroupTriggerMode = 'mention_only' | 'mention_or_rules';

export interface ImGroupBinding {
  id: string;
  created_at: string;
  updated_at: string;
  channel: ImChannel;
  chat_id: string;
  chat_name: string;
  project_id: string;
  project_name: string;
  enabled: boolean;
  trigger_mode: ImGroupTriggerMode;
  allow_all_senders: boolean;
  allowed_senders: string[];
  rule_keywords: string[];
  cooldown_seconds: number;
  inline_context_count: number;
  accept_media: boolean;
  notify_events: boolean;
  last_triggered_at: string | null;
}

export interface DiscoveredImGroup {
  channel: ImChannel;
  chat_id: string;
  last_seen_at: string;
  last_actor: string;
  last_text: string;
  message_count: number;
}

export interface ImGroupsPage {
  bindings: ImGroupBinding[];
  discovered: DiscoveredImGroup[];
  projects: { id: string; name: string }[];
}

export interface ProjectGroupsPage {
  bindings: ImGroupBinding[];
  discovered: DiscoveredImGroup[];
}

export interface BroadcastGroupChoice {
  id: string;
  channel: ImChannel;
  chat_id: string;
  chat_name: string;
  project_id?: string;
  enabled: boolean;
  notify_events: boolean;
}
