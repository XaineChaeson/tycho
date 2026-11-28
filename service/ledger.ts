import {globalEntryPublisher} from './global-entry-publisher.ts';
import {captureOf,captureEvidence,outputSource,type CaptureEvidence,type CaptureDisposition} from './capture-result.ts';
import { claudeQuotaWindow } from '../shared/claude-quota.ts';
import { dirname, join } from 'node:path';
import { ACCOUNT_LOGIN_FIX, artifactsDroppedText, missingLoginText, taskStateLabels, runStateLabels, unverifiableText } from '../shared/labels.ts';
import type { MachineEnds } from '../shared/labels.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isTierId, TIER_IDS, tierLabel, tierOnlyText, type TierId } from '../shared/tiers.ts';
import { ANALYSE_ROLE_ID, codeCheckAdopted, NO_ROLE_LOST_TEXT, NO_ROLE_REASON, readOnlyMissingText, REVIEW_ROLE_ID, ROLE_REQUIRED_TEXT, VERIFY_ROLE_ID, type CodeCheck, type PermissionId, type RoleConfig, type RunAccess, type TierSource } from '../shared/roles.ts';
import { ADAPTERS } from '../adapters/all.ts';
import {
  cannotReviewText, DECIDE_ABANDON_OPTION, DECIDE_ACCEPT_OPTION, NEEDS_PASS_TEXT,
  RELEASE_NEEDS_PASS_TEXT, REVIEW_IN_PROGRESS_TEXT,
  REVIEW_ONLY_TEXT, REVIEW_ROLE_LOCK_TEXT, reviewHeldGateText, shortDeliveryText,
  type BoundFile, type ReviewGateInfo, type ReviewOf, type SameExecutor, type Verdict, type VerdictRecord,
} from '../shared/review.ts';
import { deliveryProblem, deliveryOf, executorOf, neverRan, parseReviewOf, productStale, roundCode, roundSourceOf, sameFiles, sourceHeadOf, verdictOf, writersOf, type CodeSource, type HeldArtifacts, type Product, type Registration, type RoundArtifacts } from './review.ts';
import { nameIsSafe } from './releases.ts';
import { landingJson, parseLanding, type Landing } from './land.ts';
import type { Account, Login, LoginConfig, Machine, MachineConfig, MachineLeftReason, MachineSource } from '../runner/snapshot.ts';
import type { MachineInputs } from '../shared/machine-inputs.ts';
import { accountLabelOf, accountNameProblem, ACCOUNT_NAME_MAX_CHARS, LOGIN_ALIASES_SETTING_KEY, loginName as displayLogin, machineLoginName, NO_CREDENTIAL_TEXT, parseLoginAliases, planLabelOf, retiredTier, type RetiredTier, type ExecutorIdentity } from '../shared/logins.ts';
import type { NodeFacts, NodeSourceHead } from '../shared/node-protocol.ts';
import { accessOf, sameConfig, loginConfig, machineConfig, inRange, machineAllowed } from '../runner/snapshot.ts';
import type { Executors, ModelInfo, Provider, Tier, Usage } from '../adapters/types.ts';
import { insertUsage, keepDroppedRuns, normalizeRunUsage, recentLoginTelemetry, usageReport, type LoginTelemetry, type UsageOwner, type UsageQuery, type UsageReport } from './usage.ts';
import { competenceReport, type CompetenceQuery } from './competence.ts';
import type { CompetenceReport } from '../shared/competence.ts';
import type { Ctx, DbHooks } from './db.ts';
import { Db, nowIso, TASK_SELECT, writeChange } from './db.ts';
import { readOnlyRefusal } from './readonly.ts';
import { createDegraded } from './degraded.ts';
import { ConfirmationRequired, DegradedError, InputError } from './errors.ts';
import { ulid } from './ids.ts';
import { createKnowledge, DEFAULT_KNOWLEDGE_LIMITS, parseKnowledgeTask, type Change, type Entry, type KnowledgeLimits, type KnowledgeTask, type SweptKnowledgeTask } from './knowledge.ts';
import { ENTRY_MACHINES_SETTING_KEY, isDirectorySkillId, SKILL_REGISTRY_SETTING_KEY, TASK_TIMEOUTS_SETTING_KEY, type EffectiveContextReport, type EntryMachinesMap, type SkillDirectoryScan, type SkillRegistryBinding, type SkillRegistryMap } from '../shared/skill-catalog.ts';
import { applicableDirectorySkills, buildEffectiveContext, isUnsafeSlug, parseEntryMachines, parseSkillRegistry, revisionForDirectorySkill, scanSkillDirectory, syncManagedSkills, validateMachineIds, validateSkillBinding } from './skill-catalog.ts';
import { generatedSize, type HostVersionState } from './knowledge-brief.ts';
import { DISPATCH_SLOTS_SETTING_KEY, effectiveRouteOfLogin, normalizeDispatchSlotsConfig, normalizeRouteKey, normalizeTierSlots, parseDispatchSlots, parseExecutorSlotKey, parseProjectDispatchConfig, type DispatchSlotsConfig, type TierDispatchSlots } from '../shared/dispatch-slots.ts';
import { EXECUTOR_AUTO_UPDATE_SETTING_KEY, normalizeExecutorAutoUpdatePolicy, parseExecutorAutoUpdatePolicy, type ExecutorAutoUpdatePolicy } from '../shared/executor-updates.ts';
import { knowledgeRoleRefusal } from './roles.ts';
import { createMessages } from './messages.ts';
import { createRouterCalls } from './router-calls.ts';
import { createHistoryEvidence } from './history-evidence.ts';
import { FINAL_MESSAGE_REF, finalMessageDelivery, hasFinalMessageReport, reportBinding } from '../shared/report.ts';
import { finalReportContent, readRecordedReport, RUN_REPORT_ACTION } from './run-report.ts';
import type { RunReport } from '../shared/report.ts';
import { createTaskFeedback } from './task-feedback.ts';
import { PROJECT_HOME_KEY_PREFIX, type ProjectHome, type ProjectOwnership } from './project-home.ts';
import { IN_SIGHT } from './messages.ts';
import type { InputRow, LoginMode, ProjectRow } from './messages.ts';
import { bindingKey, PENDING_MACHINE_UID, defaultSource, parseSources, snapshotSourceOf, sourceLabel, taskSourceState, type Delivery, type ReviewedCommit, type SnapshotSource, type Source, type SourceView, type TaskSource, type TaskSourceState, type TaskSourceView } from '../shared/sources.ts';
import { createOutbox } from './outbox.ts';
import { createFrontDesk } from './front-desk.ts';
import { createPushes, DAILY_BRIEF_KEY, DEFAULT_PUSH_POLICY, PUSH_LEVELS, type BriefMark, type PushPolicy } from './pushes.ts';
import { inForce, dispatchOrderKey, SETTINGS, type SettingKey, type SettingValue } from './settings.ts';
import { parseInstant } from './schedule.ts';
import { createTriggers, DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from './triggers.ts';
import { TRIGGER_CHANNEL } from '../shared/triggers.ts';
import { GRANT_IDS, GRANTS, grantsOf, isGrantId, notGrantedText, type GrantId } from '../shared/grants.ts';
import { internalEvents, type InternalEvent } from '../shared/internal-events.ts';
import { expectedExpiry } from '../shared/credential.ts';
import { parseTaskPrefer, type PlacedBy, type TaskPrefer } from '../shared/tasks.ts';
import { workSummaries } from './work-summary.ts';
import {
  isProjectFileKind,
  isProjectFileOrigin,
  type ProjectFileKind,
  type ProjectFileOrigin,
  type ProjectFileRow,
} from './project-files.ts';
import {
  IM_CHAT_ID_MAX_CHARS,
  IM_CHAT_NAME_MAX_CHARS,
  isGroupCapableChannel,
  isImChannel,
  isImGroupTriggerMode,
  validateAllowedSenders,
  validateCooldownSeconds,
  validateInlineContextCount,
  validateRuleKeywords,
  type DiscoveredImGroup,
  type ImAttachmentRef,
  type ImChannel,
  type ImGroupBindingInput,
  type ImGroupBindingPatch,
  type ImGroupBindingView,
  type ImGroupTriggerMode,
} from '../shared/im.ts';

export type { Ctx } from './db.ts';
export type { ProjectFileKind, ProjectFileOrigin, ProjectFileRow } from './project-files.ts';

export interface ImGroupContextRow {
  id: string;
  created_at: string;
  channel: ImChannel;
  chat_id: string;
  external_id: string;
  actor: string;
  actor_name: string | null;
  text: string;
  mentioned_bot: number;
  reply_to_external_id: string | null;
  attachments_meta_json: string | null;
  message_id: string | null;
  project_id: string | null;
}

export interface SafeGroupContextAttachment {
  kind: 'image' | 'file';
  name?: string;
  mime?: string;
  size?: number;
}

export interface SafeImGroupContextItem {
  id: string;
  created_at: string;
  channel: ImChannel;
  chat_id: string;
  external_id: string;
  actor: string;
  actor_name: string | null;
  text: string;
  mentioned_bot: number;
  reply_to_external_id: string | null;
  attachments: SafeGroupContextAttachment[];
  message_id: string | null;
  project_id: string | null;
  linked_task_ids: string[];
}

function sanitizeGroupContextAttachments(raw: string | null): SafeGroupContextAttachment[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: SafeGroupContextAttachment[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (rec.kind !== 'image' && rec.kind !== 'file') continue;
      const clean: SafeGroupContextAttachment = { kind: rec.kind };
      if (typeof rec.name === 'string' && rec.name !== '') clean.name = rec.name;
      if (typeof rec.mime === 'string' && rec.mime !== '') clean.mime = rec.mime;
      if (typeof rec.size === 'number' && Number.isFinite(rec.size)) clean.size = rec.size;
      result.push(clean);
    }
    return result;
  } catch {
    return [];
  }
}

interface ImGroupBindingRow {
  id: string;
  created_at: string;
  updated_at: string;
  channel: ImChannel;
  chat_id: string;
  chat_name: string;
  project_id: string;
  project_name: string;
  enabled: number;
  trigger_mode: ImGroupTriggerMode;
  allow_all_senders: number;
  allowed_senders_json: string;
  rule_keywords_json: string;
  cooldown_seconds: number;
  inline_context_count: number;
  accept_media: number;
  notify_events: number;
  last_triggered_at: string | null;
}

const IM_GROUP_BINDING_SELECT = `SELECT b.*, p.name AS project_name FROM im_group_binding b JOIN project p ON p.id = b.project_id`;
const IM_GROUP_CONTEXT_RING_MAX = 200;

function imGroupBindingView(row: ImGroupBindingRow): ImGroupBindingView {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    channel: row.channel,
    chat_id: row.chat_id,
    chat_name: row.chat_name,
    project_id: row.project_id,
    project_name: row.project_name,
    enabled: row.enabled === 1,
    trigger_mode: row.trigger_mode,
    allow_all_senders: row.allow_all_senders === 1,
    allowed_senders: JSON.parse(row.allowed_senders_json) as string[],
    rule_keywords: JSON.parse(row.rule_keywords_json) as string[],
    cooldown_seconds: row.cooldown_seconds,
    inline_context_count: row.inline_context_count,
    accept_media: row.accept_media === 1,
    notify_events: row.notify_events === 1,
    last_triggered_at: row.last_triggered_at,
  };
}

export type TaskState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'stopping'
  | 'ready'
  | 'done'
  | 'held'
  | 'waiting_person'
  | 'waiting_timer'
  | 'needs_verification'
  | 'abandoned';

type RunState = 'launching' | 'running' | 'stopping' | 'unknown' | 'ended';
// `quota`: the executor's quota was used up under the Run. Neither a failure of the Task
// nor a loss: the quota comes back by itself, and the Task goes on when it has.
type ExitKind = 'completed' | 'failed' | 'interrupted' | 'lost' | 'quota' | 'auth';
// How a Run was judged gone without a result. `seen`: the host answered and nothing of
// the Run was there. `removed`: its machine left the account. `presumed`: out of contact
// for longer than the grace period. `not_started`: no machine took the upload.
// `abandoned`: its Task was given up while it could not be reached. `superseded`: the
// instance already holds a later round of the Task.
type LostBasis = 'seen' | 'removed' | 'presumed' | 'not_started' | 'abandoned' | 'superseded';
// Why nobody can speak for a Run. `unreachable`: its machine does not answer.
// `unconfirmed`: the machine answers and shows no trace of the start. `unverifiable`: the
// machine answers and says it cannot tell, and why; no wait runs, since only an answer it
// can give ends it (or the machine going away, which is `unreachable` again). `no_target`:
// this ledger never held the Run's account, so there is no machine to ask; no wait runs.
export type UnknownCause = 'unreachable' | 'unconfirmed' | 'unverifiable' | 'no_target';
type LateReason = 'run_ended' | 'revision' | 'task_state';

// Where a Task's rounds may go; see machineRange.
type MachineRange = { allowed: string[]; projectId: string | null } | { conflict: string };

// A project's allowed machines by name, and how many of its entries are machines since deleted.
// A project's allowed machines: each by its registration and the name it goes by now, and how
// many of its entries are registrations no machine has any more.
export interface ProjectMachines { machines: { uid: string; name: string }[]; gone: number; }

export interface TaskRow {
  id: string;
  created_at: string;
  // Null for a knowledge gate or curation Task, which belongs to no project (knowledge §3).
  project_id: string | null;
  parent_id: string | null;
  title: string;
  goal: string;
  scope: string | null;
  acceptance: string | null;
  revision: number;
  login_id: string | null;
  // The role the Task is, or null for one from before roles.
  role_id: string | null;
  // The Task's own tier, when it does not run on its role's default, and why.
  tier_override: TierId | null;
  tier_reason: string | null;
  // Derived on every read (TASK_SELECT), never stored: the override, or else the tier the
  // round this review is bound to ran on, or else the role's default; null when there is
  // none. And where it came from.
  tier: TierId | null;
  tier_source: TierSource | null;
  // Derived as well: the role's permission, null without a role. Optional only so that a
  // Task written out by hand elsewhere still reads as one; every ledger read carries it.
  permission?: PermissionId | null;
  // 1 when the override is the service's, written when a review rejected a round on the
  // execute tier (docs/design/roles-and-tiers.md §6): the Router cannot take it back.
  tier_escalated: number;
  // A review Task's binding (ReviewOf) and the verdict it last handed over (VerdictRecord),
  // as JSON; null for any other Task, and for a review that has handed over none yet.
  review_of_json: string | null;
  verdict_json: string | null;
  // A knowledge gate or curation Task: what it gates or curates (service/knowledge.ts).
  knowledge_json: string | null;
  // The trigger occurrence whose turn started this work, or its parent's (docs/design/triggers.md
  // §4): the events of the work carry it, and none of them sets a trigger off.
  trigger_fire_id: string | null;
  // The skills the Task names, as a JSON list of entry ids; null when it names none. Its rounds
  // are given them in full (docs/design/knowledge-and-skills.md §4.1).
  skills_json: string | null;
  // The merge round a Task was made as (service/land.ts), as JSON; null for every other Task.
  landing_json: string | null;
  // The project source it is pinned to (shared/sources.ts TaskSource), as it stood when it was
  // pinned; null when its project names none or the Task uses the default empty task directory.
  source_json: string | null;
  // Optional target machine pinned on the Task (machine.id); null lets the dispatcher pick.
  machine_id: string | null;
  // The logins the Router asked to try first, in its order, with why (roles-and-tiers.md §11):
  // a TaskPrefer as JSON; null when it asked for none. A preference, never a pin.
  prefer_json: string | null;
  priority: number;
  state: TaskState;
  reason: string | null;
  wake_at: string | null;
  created_by: string;
  closed_at: string | null;
}

interface TierOverride {
  tier: TierId;
  reason: string | null;
}

// As a caller hands one in: the reason may be left out, and the tier is checked here.
interface TierOverrideInput {
  tier: string;
  reason?: string | null;
}

export interface RoleRecord extends RoleConfig {
  created_at: string;
  updated_at: string;
}

export interface ResumableTaskSummary {
  id: string;
  title: string;
  role_id: string | null;
  executor: string | null;
  machine_id: string | null;
  closed_at: string | null;
  last_summary: string | null;
  resumable: true;
}

export interface RunRow {
  id: string;
  created_at: string;
  task_id: string;
  task_revision: number;
  login_id: string | null;
  login_name: string | null;
  host: string;
  machine_id: string | null;
  // The node identity the Run was dispatched to, where the machine is one whose client came
  // back by itself. The name in `machine_id` is the owner's to reuse; this is not (§7).
  node_id: string | null;
  session_ref: string | null;
  state: RunState;
  marker: string;
  exit_code: number | null;
  exit_kind: ExitKind | null;
  receipt_json: string | null;
  settlement_digest: string | null;
  snapshot_json: string;
  capture_result_json: string | null;
  error_json: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_progress_at: string | null;
  // The files the host registered for this round, as JSON; null while none is registered.
  artifacts_json: string | null;
  // When the host's registered copies of this round were cleared after its work ended and the
  // retention period passed; null while they stand.
  releases_dropped_at: string | null;
  // When this round's Task's code copy was cleared on the machine it ran on, by the same rule.
  code_dropped_at: string | null;
}

// A account as the ledger keeps it: the owner's object, with when it was made and changed.
export interface AccountRecord extends Account {
  created_at: string;
  updated_at: string;
}

// An account whose token is expected to run out inside the setting's window, or already has
// (docs/design/native-login.md §2): what the self-check says and what the expiry scan pushes
// about. `credentialAt` is the credential the estimate is about, so a notice can tell whether
// the account still holds it.
export interface ExpiringAccount {
  id: string;
  name: string;
  expected: string;
  credentialAt: string;
  expired: boolean;
}


interface RoleRow {
  id: string; created_at: string; updated_at: string; name: string; description: string;
  default_tier: TierId; permission: RoleConfig['permission']; deliverable: RoleConfig['deliverable']; needs_review: number;
}
const roleRecord = (row: RoleRow): RoleRecord => ({ ...row, needs_review: row.needs_review === 1 });
// A role's content, without when it was made: what a snapshot and a change row record.
export const roleConfig = ({ id, name, description, default_tier, permission, deliverable, needs_review }: RoleConfig): RoleConfig =>
  ({ id, name, description, default_tier, permission, deliverable, needs_review });

// `uid`: this registration of the machine, never used again (what a project's list names).
export interface MachineRecord extends Machine { uid: string; created_at: string; updated_at: string; }
interface MachineRow {
  id: string; uid: string; created_at: string; updated_at: string; host: string; note: string | null;
  node_id: string; token_hash: string | null; platform: string | null; joined_at: string | null;
  last_seen_at: string | null; source: string | null; ephemeral: number;
  invite_id: string | null; claim_hash: string | null;
  drain_at: string | null; evidence_at: string | null; left_at: string | null; left_reason: string | null;
  destroyed_at: string | null; destroyed_by: string | null;
  // From the quota the machine came in under (a join): what it is allowed to take.
  scope_project_id: string | null; scope_executors_json: string | null;
}
// A machine with the range its quota gives it, read in one go: the quota is the authority
// for the range, and the machine row only points at it.
const MACHINE_SELECT = `SELECT machine.*, machine_invite.project_id AS scope_project_id, machine_invite.executors_json AS scope_executors_json
  FROM machine LEFT JOIN machine_invite ON machine_invite.id = machine.invite_id`;
function sourceOf(text: string | null): MachineSource | undefined {
  if (text === null || text === '') return undefined;
  try {
    const held = JSON.parse(text) as Partial<MachineSource>;
    if (typeof held.task_id !== 'string' || typeof held.run_id !== 'string' || typeof held.round !== 'number') return undefined;
    return { task_id: held.task_id, run_id: held.run_id, round: held.round };
  } catch {
    return undefined;
  }
}
function machineOf(row: MachineRow): MachineRecord {
  const source = sourceOf(row.source);
  return {
    id: row.id, uid: row.uid, host: row.host, nodeId: row.node_id,
    ...(row.note === null ? {} : { note: row.note }),
    ...(row.platform === null ? {} : { platform: row.platform }),
    ...(row.joined_at === null ? {} : { joinedAt: row.joined_at }),
    lastSeenAt: row.last_seen_at,
    ...(source === undefined ? {} : { source }),
    ...(row.ephemeral ? { ephemeral: true } : {}),
    ...(row.invite_id === null ? {} : { inviteId: row.invite_id }),
    ...(row.scope_project_id === null ? {} : { scope: { project_id: row.scope_project_id, executors: row.scope_executors_json === null ? null : (JSON.parse(row.scope_executors_json) as string[]) } }),
    ...(row.drain_at === null ? {} : { drainAt: row.drain_at }),
    ...(row.evidence_at === null ? {} : { evidenceAt: row.evidence_at }),
    ...(row.left_at === null ? {} : { leftAt: row.left_at }),
    ...(row.left_reason === null ? {} : { leftReason: row.left_reason as MachineLeftReason }),
    ...(row.destroyed_at === null ? {} : { destroyedAt: row.destroyed_at }),
    ...(row.destroyed_by === null ? {} : { destroyedBy: row.destroyed_by }),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

// A quota for machines a task may spawn (docs/design/nodes.md §1.3): what it allows, until
// when a round may still be handed materials, and how many machines it may register. The
// materials are rows of their own (machine_material), each good for one machine; what is
// counted here — how many were used, how many are still live — is read from them.
export interface InviteRow {
  id: string;
  created_at: string;
  project_id: string;
  task_id: string;
  executors_json: string | null;
  expires_at: string;
  max_machines: number;
  revoked_at: string | null;
  // Derived from its materials at the moment of reading.
  used: number;
  live: number;
  live_until: string | null;
  last_handed_at: string | null;
  last_run_id: string | null;
  last_used_at: string | null;
  last_expires_at: string | null;
}

// A quota with what its materials say, in one read. `live` counts the materials that could
// still let a machine in right now: unused, not past their time, under a quota that is
// neither revoked nor full.
// Its two placeholders are the moment of reading, given before any of the caller's own.
const INVITE_SELECT = `SELECT machine_invite.*,
  (SELECT count(*) FROM machine_material m WHERE m.invite_id = machine_invite.id AND m.used_at IS NOT NULL) AS used,
  (SELECT count(*) FROM machine_material m WHERE m.invite_id = machine_invite.id AND m.used_at IS NULL AND m.expires_at > ?) AS live,
  (SELECT max(m.expires_at) FROM machine_material m WHERE m.invite_id = machine_invite.id AND m.used_at IS NULL AND m.expires_at > ?) AS live_until,
  (SELECT max(m.handed_at) FROM machine_material m WHERE m.invite_id = machine_invite.id) AS last_handed_at,
  (SELECT m.run_id FROM machine_material m WHERE m.invite_id = machine_invite.id ORDER BY m.handed_at DESC LIMIT 1) AS last_run_id,
  (SELECT max(m.used_at) FROM machine_material m WHERE m.invite_id = machine_invite.id) AS last_used_at,
  (SELECT max(m.expires_at) FROM machine_material m WHERE m.invite_id = machine_invite.id) AS last_expires_at
  FROM machine_invite`;
function inviteOf(row: InviteRow): InviteRow {
  const closed = row.revoked_at !== null || row.used >= row.max_machines;
  return closed ? { ...row, live: 0, live_until: null } : row;
}

// What became of a quota's materials (nodes.md §1.3): how many could still let a machine in
// and until when, or when and why the last of them stopped being able to.
export function materialEnd(invite: InviteRow | undefined): MachineEnds['material'] {
  if (invite === undefined) return { live: 0, live_until: null, ended_at: null, ended_why: null };
  if (invite.live > 0) return { live: invite.live, live_until: invite.live_until, ended_at: null, ended_why: null };
  if (invite.revoked_at !== null) return { live: 0, live_until: null, ended_at: invite.revoked_at, ended_why: 'revoked' };
  if (invite.used >= invite.max_machines) return { live: 0, live_until: null, ended_at: invite.last_used_at, ended_why: 'used' };
  return { live: 0, live_until: null, ended_at: invite.last_expires_at, ended_why: invite.last_expires_at === null ? null : 'expired' };
}

// `lostRounds`: how many of its rounds ended judged gone (roundsOn's `unread`).
export function machineEnds(machine: MachineRecord, invite: InviteRow | undefined, lostRounds: number): MachineEnds {
  return {
    material: materialEnd(invite),
    drain_at: machine.drainAt ?? null,
    evidence_at: machine.evidenceAt ?? null,
    left_at: machine.leftAt ?? null,
    left_reason: machine.leftReason ?? null,
    destroyed_at: machine.destroyedAt ?? null,
    destroyed_by: machine.destroyedBy ?? null,
    lost_rounds: lostRounds,
  };
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

// The machines a receipt says the round destroyed (docs/design/nodes.md §1.3): a list of
// names under `destroyed_machines`, and nothing that is not one.
function destroyedIn(receipt: Receipt | null): string[] {
  const named = receipt?.destroyed_machines;
  if (!Array.isArray(named)) return [];
  return named.filter((each): each is string => typeof each === 'string' && each.trim() !== '');
}

// Why a material cannot be redeemed, in the owner's words on the new machine's terminal.
const INVITE_REFUSALS = {
  unknown: '接入材料不对：不是这台主机发的。让创建这台机器的那一轮重新拿一份',
  used: '这份接入材料已经用过了：一份材料只能接入一台机器',
  revoked: '这条接入名额已经被撤销',
  expired: '接入材料已经过期：材料只在发出后的一段时间内有效，让创建这台机器的那一轮重新拿一份',
  full: '这条接入名额已经用完：允许登记的机器数到了',
} as const;

interface AccountRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  executor: string;
  tiers_json: string;
  permission_mode: string | null;
  timeout_ms: number | null;
  max_runs: number | null;
  credential_ref: string | null;
  // When the token this account holds now was stored; null when nothing recorded one.
  credential_at: string | null;
  provider_json: string | null;
}

// A machine's own login of one executor, as the ledger keeps its settings. Whether the
// machine has that login at all is the machine's own report, never stored here.
interface MachineLoginRow {
  id: string;
  machine_uid: string;
  machine_id: string;
  executor: string;
  created_at: string;
  updated_at: string;
  tiers_json: string;
  permission_mode: string | null;
  timeout_ms: number | null;
  max_runs: number | null;
}

export interface MachineLoginRecord extends Login {
  machine: string;
  created_at: string;
  updated_at: string;
}

// How much of one quota window of a login is used, as an executor last said.
interface UsageWindow {
  window: string;
  // 0 to 1.
  used: number;
  // When the window starts over, after which this figure says nothing. Null when not said.
  resets_at: string | null;
  at: string;
}

// What the service has learned about a login by using it. Not what the owner set: it is
// kept in a table of its own and is no part of whether a login's configuration changed.
export interface LoginState {
  // Resting after a used-up quota until `rest_until`. Not resting once that is past, or
  // cleared because the owner said to try now.
  rest_until: string | null;
  // Rests in a row with no Run completed on the login between them.
  rest_streak: number;
  // What the executor said when the quota ran out.
  rest_reason: string | null;
  usage: UsageWindow[];
  // The number of a token the executor refused, as it was when it refused it. A token
  // the owner has since replaced or cleared is no longer the account's, and this names
  // something else: see credentialRejected.
  credential_rejected_ref: string | null;
  // When a machine's own login was refused by its executor under a round. It stands until
  // that machine reports, from a probe made after it, that the executor is signed in again
  // (or the owner says to try now): a report read before the refusal says nothing about it.
  auth_failed_at: string | null;
  // The models the executor last reported for this account, and when that answer was
  // read. A failed query leaves both as they were: an older list that still says when it
  // was true beats one wiped by a timeout.
  models: ModelInfo[];
  models_at: string | null;
  identity: ExecutorIdentity;
}

interface LoginStateRow {
  id: string;
  // The last change the ledger held when the rest began: a Run created after it was let
  // in to try. The sequence, not a time, so that no clock decides which Runs those are.
  rest_seq: number | null;
  rest_until: string | null;
  rest_streak: number;
  rest_reason: string | null;
  usage_json: string;
  credential_rejected_ref: string | null;
  auth_failed_at: string | null;
  models_json: string;
  models_at: string | null;
  identity_json: string;
}

const NO_STATE: LoginState = { rest_until: null, rest_streak: 0, rest_reason: null, usage: [], credential_rejected_ref: null, auth_failed_at: null, models: [], models_at: null, identity: {} };

// Keep only the organization and validated display label, discarding old profile fields.
function identityOf(json: string): ExecutorIdentity {
  const value = JSON.parse(json) as ExecutorIdentity;
  const organizationId = value.organizationId;
  const accountLabel = accountLabelOf(value.accountLabel);
  const planLabel = planLabelOf(value.planLabel);
  const routeLabel = accountLabelOf(value.routeLabel);
  const routes = Array.isArray(value.routes)
    ? value.routes
      .filter((r): r is NonNullable<ExecutorIdentity['routes']>[number] => Boolean(r && typeof r === 'object' && accountLabelOf(r.id)))
      .slice(0, 24)
    : undefined;
  return {
    ...(typeof value.quotaOwner === 'string' ? { quotaOwner: value.quotaOwner } : {}),
    ...(typeof organizationId === 'string' && organizationId !== '' ? { organizationId } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(planLabel ? { planLabel } : {}),
    ...(routeLabel ? { routeLabel } : {}),
    ...(routes && routes.length > 0 ? { routes } : {}),
  };
}

const LOGIN_STATE_SELECT = `SELECT s.*, COALESCE(a.executor, m.executor) AS executor FROM login_state s LEFT JOIN account a ON a.id = s.id LEFT JOIN machine_login m ON m.id = s.id`;

function stateOf({ rest_until, rest_streak, rest_reason, usage_json: usage, credential_rejected_ref, auth_failed_at, models_json, models_at, identity_json }: LoginStateRow, executor?: string): LoginState {
  const windows = JSON.parse(usage) as Record<string, Omit<UsageWindow, 'window'>>;
  const figures = new Map<string, UsageWindow>();
  for (const [raw, figure] of Object.entries(windows)) {
    const window = executor === 'claude' ? claudeQuotaWindow(raw) : raw;
    const previous = figures.get(window);
    if (!previous || Date.parse(figure.at) > Date.parse(previous.at)) figures.set(window, { window, ...figure });
  }
  return {
    rest_until, rest_streak, rest_reason, credential_rejected_ref, auth_failed_at, models_at,
    usage: [...figures.values()],
    models: JSON.parse(models_json) as ModelInfo[],
    identity: identityOf(identity_json),
  };
}

// Whether a rejection still says anything about the account: it names the number the
// account holds now. Replacing or clearing the token gives the account another number,
// so the mark left behind names something that is not the account's any more.
export function credentialRejected(state: LoginState | undefined, ref: string | null): boolean {
  return ref !== null && state?.credential_rejected_ref === ref;
}

// Whether a login's executor refused it and nothing since could have put that right: the one
// judgment of "give it no more work" for both kinds. An account until it holds another token
// (`ref` is the one it holds now); a machine's own login until its machine reports it signed
// in again after the refusal, which clears the mark where reports arrive.
export function loginRefused(state: LoginState | undefined, ref: string | null): boolean {
  return credentialRejected(state, ref) || (state?.auth_failed_at ?? null) !== null;
}

// When a account stops resting, in milliseconds; undefined when it is not resting at `now`.
export function restingUntil(state: LoginState | undefined, now: number): number | undefined {
  const until = state?.rest_until ? Date.parse(state.rest_until) : NaN;
  return until > now ? until : undefined;
}

// The usage figures that still say something at `now`: those of windows not yet started over.
export function usageNow(state: LoginState | undefined, now: number): UsageWindow[] {
  return (state?.usage ?? []).filter(({ resets_at: resets }) => resets === null || Date.parse(resets) > now);
}

// A login's tiers as stored. Only content is a tier: a value of another shape (the name of a
// file on the machine, which an older program wrote) is not one, and the login does not offer
// that tier until the owner fills it in — but it is not dropped in silence either: it comes
// out as a retired tier, with what it named and where to put it right (shared/logins.ts).
// No prototype: a tier name comes from the Router, and "constructor" is not a tier.
function tiersOf(json: string, loginId: string): { tiers: Record<string, Tier>; retiredTiers?: RetiredTier[] } {
  const tiers: Record<string, Tier> = Object.create(null);
  const retired: RetiredTier[] = [];
  for (const [name, value] of Object.entries(JSON.parse(json) as Record<string, { kind?: unknown; text?: unknown; value?: unknown } | null>)) {
    if (value?.kind === 'content' && typeof value.text === 'string') tiers[name] = { kind: 'content', text: value.text };
    else retired.push(retiredTier(loginId, name, typeof value?.value === 'string' ? value.value : JSON.stringify(value), tierLabel(name)));
  }
  return { tiers, ...(retired.length === 0 ? {} : { retiredTiers: retired }) };
}

function accountOf(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    name: row.name,
    executor: row.executor,
    ...(row.permission_mode === null ? {} : { permissionMode: row.permission_mode }),
    ...tiersOf(row.tiers_json, row.name),
    ...(row.timeout_ms === null ? {} : { timeoutMs: row.timeout_ms }),
    ...(row.max_runs === null ? {} : { maxRuns: row.max_runs }),
    ...(row.provider_json === null ? {} : { provider: JSON.parse(row.provider_json) as Provider }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function machineLoginOf(row: MachineLoginRow): MachineLoginRecord {
  return {
    id: row.id,
    name: `${row.machine_id}/${row.executor}`,
    executor: row.executor,
    machine: row.machine_id,
    ...(row.permission_mode === null ? {} : { permissionMode: row.permission_mode }),
    ...tiersOf(row.tiers_json, `${row.machine_id}/${row.executor}`),
    ...(row.timeout_ms === null ? {} : { timeoutMs: row.timeout_ms }),
    ...(row.max_runs === null ? {} : { maxRuns: row.max_runs }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface ApprovalRow {
  id: string;
  task_id: string;
  task_revision: number;
  questions_json: string;
  state: 'open' | 'answered' | 'closed';
  review_task_id: string | null;
}

export class NotFoundError extends InputError {
  override name = 'NotFoundError';
}

export interface ConsoleSession {
  // A hash of the cookie, never the cookie.
  id: string;
  created_at: string;
  last_seen_at: string;
  // Made through the outside listener, and good only there. One without the mark is
  // good only on the inside listener.
  outside?: true;
  device?: string;
  method?: 'link' | 'device' | 'wecom' | 'weixin' | 'passphrase';
  expires_at?: string;
  // The summary cursor remains last_seen_at; other page visits do not consume it.
  last_used_at?: string;
}

export interface Question {
  question: string;
  options?: string[];
  recommend?: number;
  about?: string;
}

export interface Receipt {
  status?: unknown;
  summary?: unknown;
  ask?: unknown;
  later?: unknown;
  [key: string]: unknown;
}

export interface SettleOptions {
  captureResult?: CaptureEvidence;
  outputProcessed?: true;
  // The adopted final reply, not a decision input or a late-result payload.
  finalReply?: string;
  // Set by the Runner when the exit code alone cannot say what happened.
  kind?: 'interrupted' | 'lost' | 'quota' | 'auth';
  reason?: string;
  // The Run's output ends on a used-up quota: what the executor said, and when it says
  // the quota comes back, if it does. The Run's account rests from this settlement on,
  // whatever `kind` is: a stop asked for meanwhile still ends the Run as interrupted.
  quota?: { message: string; resetsAt?: string };
  // Only known once the output is read, and a later resume depends on it.
  sessionRef?: string;
  // The Worker ended but left processes behind, which the Runner has cleared.
  residue?: boolean;
  // With kind 'lost', or with a stop that ended because the host stayed out of contact.
  lost?: { basis: LostBasis; since?: string; until?: string };
  // The machine's evidence that no Worker of this round ever ran, with why: the round did
  // not start, though its gate was taken. Nothing it was bound to was delivered.
  workerNotStarted?: string;
  // A read-only round's code check, as its machine reported it with the exit code
  // (roles-and-tiers.md §5). Absent: the machine gave none.
  codeCheck?: CodeCheck;
  // Where the round's code stood when it was over, as its machine read it (docs/design/
  // code-sources.md §8 第 4、6 条). Kept beside the code check in the Run's error_json: a
  // review is bound to it, and the first round's `start` is the Task's start.
  sourceHead?: NodeSourceHead;
  // What the executor reported the round used, one entry per model. Recorded with the
  // settlement, at the round's end; a repeat settlement records nothing.
  usage?: readonly Usage[];
  // Optional count of tool calls observed during this Run, used to classify zero-work startup network failures.
  toolCalls?: number;
}

type SettleResult = { late: false; task_state: TaskState } | { late: true; reason: LateReason };

// The digest keeps the exact inputs comparable without retaining another copy of the receipt.
function settleInputDigest(exitCode: number | null, receipt: Receipt | null, opts: SettleOptions): string {
  const { finalReply: _finalReply, ...decision } = opts;
  return hashOf(JSON.stringify([exitCode, receipt, decision], (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  }));
}

type AnswerResult = { status: 'accepted'; input_id?: string; action?: 'rework' | 'accept_without_review' | 'abandon' } | { status: 'closed' };

function matchDecideAction(answer: string, option: string): { matched: true; reason: string } | { matched: false } {
  if (answer === option) return { matched: true, reason: '' };
  if (answer.startsWith(`${option}：`) || answer.startsWith(`${option}:`) || answer.startsWith(`${option} `)) {
    return { matched: true, reason: answer.slice(option.length + 1).trim() };
  }
  return { matched: false };
}

// Per channel, who may answer a question.
export type Whitelist = Record<string, string[]>;

export interface LedgerOptions {
  projectHome?: ProjectHome;
  // Only on a private staging file in restoreBackup.
  sealRestore?: boolean;
  // Opens the first connection read-only, for a ledger whose writer is gone (`tycho doctor`
  // with no service running; db.ts openStoppedLedger), and so tests can provoke write
  // failures; recover() always reconnects read-write.
  readOnly?: boolean;
  // The service's lifecycle knows this; the ledger reports it with the rest, and keeps
  // the owner's restore controls shut while it lasts.
  recovery?: { recovering(): boolean };

  // Told where the copy kept before an upgrade is. Absent means stderr.
  log?: (line: string) => void;
  // False for a file that is itself a copy of a ledger kept elsewhere: no copy of it is
  // kept before an upgrade.
  copyBeforeUpgrade?: boolean;
  testHooks?: DbHooks & { afterSettleRunWrite?: () => void; beforeOutboxMarkSent?: (db: Db) => void };
  // What each executor declares — here, whether it has a read-only way at all. The program's
  // own adapters unless a test stands in others.
  executors?: Executors;
  // The size limits on knowledge (docs/design/knowledge-and-skills.md §4.1), read at each use.
  // Absent means the defaults.
  knowledgeLimits?: () => KnowledgeLimits;
  // The logins a knowledge Task may run as; empty is every login (knowledge §3). Only which
  // logins may be used: the tier's global order decides which is tried first.
  knowledgeLogins?: () => readonly string[];
  // How waiting items are reminded and results merged (project-sessions §2.1), read at each use.
  // Absent means the defaults.
  pushPolicy?: () => PushPolicy;
  // Additional owner transports, resolved when a notification enters the outbox.
  noticeTargets?: () => { channel: string; target: { chatid: string; chat_type: 1 | 2 } }[];
  // The limits on triggers (docs/design/triggers.md §4, §5), read at each use. Absent means the defaults.
  triggerPolicy?: () => TriggerPolicy;
  // Invoked after commit when a Worker round running on a stripped OAuth lease (`oauth-*`) hits
  // 401 so the Host's OAuth broker can verify or rotate the stored refresh token instead of
  // blindly poisoning the root account.
  onOAuthLeaseAuthFailure?: (loginId: string, ref: string) => void;
}

// §2: what a restored backup left for the owner to go through, until confirmed.
interface RestoreMark {
  from: string;
  backup_at: string | null;
  restored_at: string;
  run_ids: string[];
  message_ids: string[];
}

export interface RestoreCounts {
  backup_at: string | null;
  active_runs: number;
  held_tasks: number;
  unverified_messages: number;
  given_up_notifications: number;
}

// Outcome of §5.5: where a settled Run sends its Task.
type Settlement =
  | { exitKind: ExitKind; state: 'ready' }
  | { exitKind: ExitKind; state: 'held'; reason: string }
  | { exitKind: ExitKind; state: 'waiting_person'; questions: Question[] }
  | { exitKind: ExitKind; state: 'waiting_timer'; wakeAt: string }
  // Lost: the Task goes on by itself, unless settleRun finds a reason it cannot.
  | { exitKind: 'lost'; state: 'continue' }
  // The quota ran out: the Task goes back to the queue, and no count is kept of that.
  | { exitKind: 'quota' | 'auth'; state: 'requeue' }
  // A read-only round's result not taken, the first in a row: sent again, fresh (§5).
  | { exitKind: 'failed'; state: 'retry'; reason: string };

// Whether a round's code_check metadata reported a non-adopted code change (advisory).
export const refusedByCheck = (run: Pick<RunRow, 'error_json'>): boolean => {
  const check = (JSON.parse(run.error_json ?? '{}') as { code_check?: CodeCheck }).code_check;
  return check !== undefined && !codeCheckAdopted(check);
};

const RUNNER: Ctx = { actor: 'runner' };
const SERVICE: Ctx = { actor: 'service' };
const MIGRATION: Ctx = { actor: 'migration' };
const TIMER: Ctx = { actor: 'timer' };
const NOTICE_CHANNEL = 'wecom';
const NEEDS_VERIFICATION_REASON = '执行机器失联，核实中';
const MAX_UNVERIFIABLE_CHARS = 500;
const STALE_REVISION_REASON = '执行结果属于旧修订';
const RESTORE_HOLD_REASON = '恢复自备份，待确认';
const RESTORE_GIVE_UP_REASON = '恢复自备份';
const SUPERSEDED_REASON = '这一轮已被更新的一轮取代';
const ABANDONED_RUN_REASON = '任务已放弃';
const QUOTA_REASON = '额度用完';
const AUTH_REASON = `登录失效，${ACCOUNT_LOGIN_FIX}`;
const MACHINE_AUTH_REASON = '机器上的登录失效了：到那台机器上重新登录这个执行器，机器报告已登录后接着做';
const MAX_REST_REASON_CHARS = 500;
const LOST_TEXT: Record<LostBasis, string> = {
  seen: '看到进程不在',
  removed: '机器被移除',
  presumed: '失联超过宽限期',
  not_started: '机器连不上，没有启动',
  abandoned: ABANDONED_RUN_REASON,
  superseded: SUPERSEDED_REASON,
};


function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

// A project's name, as the ledger holds it: what createProject and setProjectName both take,
// so the two cannot come to different answers about a name.
function projectNameOf(name: string): string {
  if (isBlank(name)) throw new InputError('项目名不能为空');
  // It becomes a directory name when the dispatcher looks for skills.
  if (/[\\/]|^\.+$/.test(name.trim())) throw new InputError(`项目名不能含路径分隔符：${name}`);
  return name.trim();
}

// What deleting a project would take, as the ledger reads it (project-sessions, "项目的生命周期"):
// the rows that go, the shared rows that stay with this project taken out of their scope, and
// the no-project knowledge tasks it leaves pointless — those given up, those whose material
// shrinks while they stay queued, and those already over whose record only loses what points at
// the rows that go. Every list comes from the one deletion set, so the page and the audit cannot
// say one thing and the transaction do another.
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
  // Given up: unfinished knowledge tasks that lose everything they work on.
  canceled: DeletionCount[];
  // Kept and still queued, with what the project's deletion took out of their material.
  reduced: DeletionCount[];
  // Already over: nothing about them changes but the reference to a row that goes.
  finished: DeletionCount[];
}

export function unknownFrom(run: RunRow): RunState | undefined {
  return run.error_json ? (JSON.parse(run.error_json) as { unknown_from?: RunState }).unknown_from : undefined;
}

interface UnknownMarks {
  unknown_from?: RunState;
  unreachable_since?: string;
  unconfirmed_since?: string;
  // The machine's own words for why it cannot tell.
  unverifiable?: string;
  no_target?: true;
}

function unknownMarks(run: RunRow): UnknownMarks {
  return run.state === 'unknown' && run.error_json ? (JSON.parse(run.error_json) as UnknownMarks) : {};
}

// When the stretch out of contact an unknown Run is in began: the first failed contact
// since the last one that got an answer. Gone as soon as its machine answers.
export function unreachableSince(run: RunRow): string | undefined {
  return unknownMarks(run).unreachable_since;
}

// When a machine that answers was first seen to hold no trace of this Run's start. Kept
// while the Run is unknown: a start nobody confirmed is waited for from then.
export function unconfirmedSince(run: RunRow): string | undefined {
  return unknownMarks(run).unconfirmed_since;
}

// Why a machine that answers cannot tell where this Run is, in its own words.
export function unverifiableReason(run: RunRow): string | undefined {
  return unknownMarks(run).unverifiable;
}

// Unknown because the ledger holds no configuration for the Run's login and never did.
export function loginMissing(run: RunRow): boolean {
  return unknownMarks(run).no_target === true;
}

function lostBasis(run: Pick<RunRow, 'exit_kind' | 'error_json'>): LostBasis | undefined {
  if (run.exit_kind !== 'lost') return undefined;
  return (JSON.parse(run.error_json ?? '{}') as { lost?: { basis?: LostBasis } }).lost?.basis ?? 'seen';
}

// A round whose machine took it and whose Worker it confirmed never ran: held for the owner
// with why (nothing here fixes a missing or unusable executor), and, like a round no machine
// took, one that wrote nothing and was handed nothing.
export function workerNeverRan(run: Pick<RunRow, 'error_json'>): boolean {
  return typeof (JSON.parse(run.error_json ?? '{}') as { worker_not_started?: unknown }).worker_not_started === 'string';
}

// A round no machine took: nothing of it ever ran, so it is neither a result nor a loss.
export function neverStarted(run: Pick<RunRow, 'exit_kind' | 'error_json'>): boolean {
  return lostBasis(run) === 'not_started';
}

const TRANSIENT_STARTUP_NETWORK_RE = /\b(?:EOF|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|loadCodeAssist|UNAVAILABLE|502|503|504)\b|socket hang up|TLS handshake|fetch failed/i;

function inferPlainProseSummary(finalReply: string): string {
  const firstParagraph = finalReply.trim().split(/\r?\n\s*\r?\n/)[0] ?? '';
  const firstLine = firstParagraph
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0) ?? finalReply.trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine;
}

function parseProjectDispatchOrder(raw: string | null | undefined): Partial<Record<TierId, string[]>> | null {
  return parseProjectDispatchConfig(raw).order;
}

function settlement(exitCode: number | null, receipt: Receipt | null, stopIntent: boolean, opts: SettleOptions): Settlement {
  if (opts.workerNotStarted !== undefined && !stopIntent && opts.kind === undefined) {
    return { exitKind: 'failed', state: 'held', reason: opts.workerNotStarted };
  }
  // Stop intent beats whatever the Worker reported; §11 requires that a success
  // receipt cannot overwrite it, and the §4 table settles a stopping Run with no
  // process as interrupted rather than lost.
  if (stopIntent || opts.kind === 'interrupted') {
    return { exitKind: 'interrupted', state: 'held', reason: opts.reason ?? '已中断' };
  }
  if (opts.kind === 'lost') return { exitKind: 'lost', state: 'continue' };
  if (opts.kind === 'quota' || opts.kind === 'auth') return { exitKind: opts.kind, state: 'requeue' };
  if (exitCode !== 0) {
    return { exitKind: 'failed', state: 'held', reason: opts.reason ?? `进程退出码 ${exitCode}` };
  }
  switch (receipt?.status) {
    case 'done':
      return { exitKind: 'completed', state: 'ready' };
    case 'failed': {
      const summary = typeof receipt.summary === 'string' && receipt.summary ? receipt.summary : '执行失败';
      return { exitKind: 'failed', state: 'held', reason: opts.reason ?? summary };
    }
    case 'waiting': {
      const questions = Array.isArray(receipt.ask) && receipt.ask.length > 0 ? (receipt.ask as Question[]) : undefined;
      const later = receipt.later as { at?: unknown } | null | undefined;
      const wakeAt = typeof later?.at === 'string' ? parseInstant(later.at) : undefined;
      if (questions && !later) return { exitKind: 'completed', state: 'waiting_person', questions };
      if (wakeAt && !questions) return { exitKind: 'completed', state: 'waiting_timer', wakeAt };
      return { exitKind: 'completed', state: 'held', reason: '等待要求冲突' };
    }
    default:
      return { exitKind: 'failed', state: 'held', reason: opts.reason ?? '回执无法解析' };
  }
}

// Receipt use is a business fact; capture evidence only governs byte custody.
function receiptWasUsed(exitCode: number | null, receipt: Receipt | null, stopIntent: boolean, opts: SettleOptions): receipt is Receipt {
  return exitCode === 0 && receipt !== null && (receipt.status === 'done' || receipt.status === 'waiting' || receipt.status === 'failed')
    && !stopIntent && opts.kind === undefined && opts.workerNotStarted === undefined;
}

// The last release result the ledger handled (noteReleased): service state, not a setting.
const RELEASE_HANDLED_KEY = 'release_handled';
const DAY_MS = 24 * 60 * 60 * 1000;

// The skills a Task names, in the order it named them.
export const namedSkillsOf = (task: Pick<TaskRow, 'skills_json'>): string[] => (task.skills_json === null ? [] : (JSON.parse(task.skills_json) as string[]));

export function openLedger(path: string, options: LedgerOptions = {}) {
  const db = new Db(path, options.readOnly ?? false, options.testHooks, options);
  const degraded = createDegraded(db, join(dirname(path), 'degraded.log'));
  const outbox = createOutbox(db, degraded, { beforeMarkSent: () => options.testHooks?.beforeOutboxMarkSent?.(db) });
  let channels = new Set(['console', NOTICE_CHANNEL]);

  let writeDepth = 0;
  let pendingAfterCommit: (() => void)[] = [];
  const write = <T>(fn: () => T): T => {
    writeDepth += 1;
    let committed = false;
    try {
      const result = degraded.write(fn);
      committed = true;
      return result;
    } finally {
      writeDepth -= 1;
      if (writeDepth === 0) {
        const callbacks = pendingAfterCommit;
        pendingAfterCommit = [];
        if (committed) {
          for (const cb of callbacks) cb();
        }
      }
    }
  };
  const onCommit = (cb: () => void): void => {
    if (writeDepth > 0) {
      pendingAfterCommit.push(cb);
    } else {
      cb();
    }
  };
  // The one place a new account's name is decided (docs/design/native-login.md §2): what the
  // owner wrote, or else the executor's own name. An executor's login says nothing a person
  // would call it by — a Claude login token may read no profile, and an organization id is a
  // number, not a name — so nothing it reports goes into the name. A name already held is
  // numbered rather than refused: the id is the reference, and a new account is never blocked
  // on a display name. Read here, in the transaction that writes the row, so two creations
  // cannot choose the same one.
  function newAccountName(written: string | undefined, executor: string): string {
    const base = written !== undefined && written.trim() !== '' ? written : `${executor} 账号`;
    const held = new Set(db.all<{ name: string }>('SELECT name FROM account').map((row) => row.name));
    if (!held.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const suffix = ` ${n}`;
      const candidate = `${base.slice(0, ACCOUNT_NAME_MAX_CHARS - suffix.length).trimEnd()}${suffix}`;
      if (!held.has(candidate)) return candidate;
    }
  }
  function renameAccount(id: string, name: string, ctx: Ctx): void {
    write(() => {
      const row = db.get<AccountRow>('SELECT * FROM account WHERE id = ?', id);
      if (!row) throw new InputError('账号不存在：' + id);
      if (row.name === name) return;
      if (db.get('SELECT 1 FROM account WHERE name = ? AND id != ?', name, id)) {
        throw new InputError(`账号名字「${name}」已经存在，不能和它重名`);
      }
      db.run('UPDATE account SET name = ?, updated_at = ? WHERE id = ?', name, nowIso(), id);
      writeChange(db, 'account.update', ctx, {}, { account_id: id, changed: { name: { from: row.name, to: name } } });
    });
  }
  // What reaches the owner is decided by the event's kind (project-sessions §2.1): a result may
  // wait for its project's window, a waiting item is kept for its reminders.
  function noticeDestinations(channel: string, payload: unknown): { channel: string; payload: unknown }[] {
    const destinations = channels.has(channel) ? [{ channel, payload }] : [];
    // Explicit chat replies stay in that chat; only owner-directed business notices fan out.
    if (channel === NOTICE_CHANNEL && !(payload as { target?: unknown } | null)?.target) {
      for (const destination of options.noticeTargets?.() ?? []) {
        if (channels.has(destination.channel)) destinations.push({ channel: destination.channel, payload: { ...(payload as object), target: destination.target } });
      }
    }
    return destinations;
  }
  function enqueueNoticeOutbox(channel: string, kind: string, payload: unknown): void {
    for (const destination of noticeDestinations(channel, payload)) outbox.enqueue(destination.channel, kind, destination.payload);
  }
  const pushes = createPushes(db, {
    enqueue: (kind, payload) => enqueueNoticeOutbox(NOTICE_CHANNEL, kind, payload),
    policy: options.pushPolicy ?? (() => DEFAULT_PUSH_POLICY),
    // Bound late: the triggers are made below.
    triggerProblem: (payload) => triggers.problemHolds({
      ...(typeof payload.trigger_id === 'string' ? { trigger_id: payload.trigger_id } : {}),
      ...(typeof payload.source_id === 'string' ? { source_id: payload.source_id } : {}),
      problem: payload.problem, since: payload.since,
    }),
    // A login whose token is expected to run out still waits for the owner while it is the
    // token the account holds and the moment is inside the window (native-login.md §2).
    stillExpiring: expiryWaiting,
  });
  function enqueueNotification(channel: string, kind: string, payload: unknown): void {
    if (noticeDestinations(channel, payload).length === 0) return;
    write(() => {
      const level = channel === NOTICE_CHANNEL ? PUSH_LEVELS[kind] : undefined;
      const keyed = payload as { external_id: string } & Record<string, unknown>;
      if (level === 'result') {
        pushes.result(kind, keyed);
        return;
      }
      enqueueNoticeOutbox(channel, kind, payload);
      if (level === 'wait') pushes.waiting(kind, keyed);
    });
  }
  // A trigger message taken leaves room in its project's trigger queue (docs/design/triggers.md §8).
  // Bound late: the triggers are made below.
  const messages = createMessages(db, write, {
    taken: (message) => {
      if (message.channel === TRIGGER_CHANNEL && message.project_id !== null) triggers.queueTaken(message.project_id);
    },
  });
  const triggers = createTriggers(db, write, {
    policy: options.triggerPolicy ?? (() => DEFAULT_TRIGGER_POLICY),
    notify: (kind, payload) => enqueueNotification(NOTICE_CHANNEL, kind, payload),
  });
  const frontDesk = createFrontDesk(db, write, {
    enqueue: (kind, payload, channel) => enqueueNotification(channel, kind, payload),
    whitelisted: (actor, channel) => (readSetting<Whitelist>('whitelist', {})[channel] ?? []).includes(actor),
    newTopic: (projectId, ctx) => messages.newTopic(projectId, ctx),
    answerApproval: (id, answers, actor, via, messageId) => api.answerApproval(id, answers, actor, via, messageId),
  });
  // Gate and curation Tasks are made by the knowledge module, with the same checks as any
  // other, and queued at once (docs/design/knowledge-and-skills.md §3, §5.3). Bound late: the
  // ledger's own task creation is defined below.
  let knowledgeTask: (fields: { title: string; goal: string; acceptance: string; knowledge: KnowledgeTask }, ctx: Ctx) => string = () => {
    throw new Error('知识任务的创建还没接上');
  };
  let endKnowledgeTask: (taskId: string, reason: string, ctx: Ctx) => void = () => {
    throw new Error('知识任务的结束还没接上');
  };
  const knowledgeLimits = options.knowledgeLimits ?? (() => DEFAULT_KNOWLEDGE_LIMITS);
  const skillsDir = path !== ':memory:' && !path.startsWith('file:') ? join(dirname(path), 'skills') : null;
  const readSkillRegistry = (): SkillRegistryMap => parseSkillRegistry(readSetting<unknown>(SKILL_REGISTRY_SETTING_KEY, {}));
  const readEntryMachines = (): EntryMachinesMap => parseEntryMachines(readSetting<unknown>(ENTRY_MACHINES_SETTING_KEY, {}));
  const readTaskTimeouts = (): Record<string, number> => {
    const raw = readSetting<unknown>(TASK_TIMEOUTS_SETTING_KEY, {});
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 60_000 && v <= 7 * DAY_MS) out[k] = v;
    }
    return out;
  };
  function parseTaskTimeoutOverride(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 60_000 || value > 7 * DAY_MS) {
      throw new InputError('任务执行时限（timeout_ms）须在 1 分钟（60000）到 7 天（604800000）之间，或填 null 使用默认时限');
    }
    return value;
  }
  function filterLedgerEntriesByMachine(entries: Entry[], machineId: string | null): Entry[] {
    const entryMachines = readEntryMachines();
    return entries.filter((entry) => {
      if (!Object.hasOwn(entryMachines, entry.id)) return true;
      const allowed = entryMachines[entry.id];
      if (allowed === null || allowed === undefined) return true;
      if (allowed.length === 0) return false;
      return machineId === null || allowed.includes(machineId);
    });
  }
  function applicableAll(projectId: string | null, roleId: string | null, machineId: string | null = null): Entry[] {
    const ledgerEntries = filterLedgerEntriesByMachine(knowledge.applicable(projectId, roleId), machineId);
    if (skillsDir === null) return ledgerEntries;
    return [...ledgerEntries, ...applicableDirectorySkills(skillsDir, readSkillRegistry(), projectId, roleId, machineId)];
  }
  function directorySkillEntry(id: string): Entry | undefined {
    if (skillsDir === null || !isDirectorySkillId(id)) return undefined;
    const skill = scanSkillDirectory(skillsDir, readSkillRegistry()).skills.find(
      (each) => each.id === id && each.managed_ledger_id === null && each.binding.enabled,
    );
    if (!skill) return undefined;
    return {
      id: skill.id,
      revision: revisionForDirectorySkill(skill.sha256, skill.binding.loading),
      kind: 'skill',
      title: skill.name,
      when_to_use: skill.description,
      body: skill.body,
      project_ids: skill.binding.project_ids === null ? null : [...skill.binding.project_ids],
      loading: skill.binding.loading,
      roles: [...skill.binding.roles],
      proposal_id: '',
      published_by: 'directory',
      published_at: '',
      reviewed_at: null,
      created_at: '',
      state: 'active',
      retired_at: null,
      retired_by: null,
      retired_reason: null,
      replaced_by: null,
    };
  }
  function materializePublished(): void {
    if (skillsDir === null || (options.readOnly ?? false)) return;
    // Only materialize ledger `skill` entries into `<dataDir>/skills/`; plain `knowledge`
    // entries belong in brief/knowledge snapshots and global entry projections, not native
    // executor skill directories.
    const skillEntries = knowledge.listEntries({ includeRetired: true }).filter((entry) => entry.kind === 'skill');
    syncManagedSkills(skillsDir, skillEntries, (entryId, err) => {
      (options.log ?? console.error)(`将条目 ${entryId} 物化到 skills 目录失败：${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const knowledge = createKnowledge(db, write, {
    limits: knowledgeLimits,
    enqueue: enqueueNotification,
    createTask: (fields, ctx) => knowledgeTask(fields, ctx),
    endTask: (taskId, reason, ctx) => endKnowledgeTask(taskId, reason, ctx),
    afterPublish: () => {
      onCommit(materializePublished);
    },
  });
  materializePublished();

  function loadTask(id: string): TaskRow {
    const task = db.get<TaskRow>(`${TASK_SELECT} WHERE task.id = ?`, id);
    if (!task) throw new InputError(`任务不存在：${id}`);
    return task;
  }

  function loadRun(id: string): RunRow {
    const run = db.get<RunRow>('SELECT * FROM run WHERE id = ?', id);
    if (!run) throw new InputError(`Run 不存在：${id}`);
    return run;
  }

  function topWorkOf(taskId: string): TaskRow {
    let top = loadTask(taskId);
    while (top.parent_id) top = loadTask(top.parent_id);
    return top;
  }

  // Whether the whole work `task` belongs to is ready to be accepted: the one business fact of
  // "a work is done" (docs/design/triggers.md §2.3), for the owner's push and the triggers alike.
  // Every Task of the tree is ready (with review gate satisfied) or finished, at least one is
  // ready, and nothing asks the owner. A draft Task with Tasks under it only groups them; any
  // other draft is work not done. The pages' summary is not this: it shows "ready" over a failed
  // or waiting Task.
  function workReady(task: TaskRow): boolean {
    const top = topWorkOf(task.id);
    const tree = [top];
    for (let i = 0; i < tree.length; i += 1) tree.push(...db.all<TaskRow>('SELECT * FROM task WHERE parent_id = ? ORDER BY rowid', tree[i]!.id));
    const ids = tree.map((row) => row.id);
    const counted = tree.filter((row) => !(row.state === 'draft' && tree.some((child) => child.parent_id === row.id)));
    const asking = db.get(`SELECT 1 FROM approval WHERE state = 'open' AND task_id IN (${ids.map(() => '?').join(', ')})`, ...ids) !== undefined;
    return !asking
      && counted.some((row) => row.state === 'ready')
      && counted.every((row) => (row.state === 'ready' && reviewGateOf(row) === null) || row.state === 'done' || row.state === 'abandoned');
  }

  function requireState(task: TaskRow, allowed: TaskState[], what: string): void {
    if (!allowed.includes(task.state)) {
      throw new InputError(`任务 ${task.id} 状态为 ${taskStateLabels[task.state]}，不能${what}`);
    }
  }

  function activeRun(task: TaskRow): { id: string } | undefined {
    return db.get<{ id: string }>(`SELECT id FROM run WHERE task_id = ? AND state != 'ended'`, task.id);
  }

  function requireNoActiveRun(task: TaskRow, what: string): void {
    const run = activeRun(task);
    if (run) throw new InputError(`任务 ${task.id} 还有未结束的 Run ${run.id}，不能${what}`);
  }

  function roleOf(id: string): RoleRecord | undefined {
    const row = db.get<RoleRow>('SELECT * FROM role WHERE id = ?', id);
    return row && roleRecord(row);
  }

  // Whether a Task names a role that exists: what its tier, and so its place in the queue,
  // depends on. An override alone is not a role.
  function hasRole(taskId: string): boolean {
    return db.get(`SELECT 1 FROM task JOIN role ON role.id = task.role_id WHERE task.id = ?`, taskId) !== undefined;
  }

  // A read-only role is never placed on a login whose executor has no read-only way, by a
  // pin or by a Run (§5): the same judgment the pick makes (service/pick.ts). Whether a machine
  // can run that way is the machine's own report, which the dispatcher reads where it places.
  const executors = options.executors ?? ADAPTERS;
  // The model a round's tier asked for, read the way its executor writes a tier: what an
  // executor that does not name its model ran is that one, and recorded as the tier's word.
  function tierModelOf(snapshotJson: string): string | undefined {
    const snapshot = JSON.parse(snapshotJson) as { tier_value?: Tier };
    const executor = executorOf(snapshotJson);
    if (executor === undefined || snapshot.tier_value?.kind !== 'content') return undefined;
    const model = executors[executor]?.tierForm?.parse(snapshot.tier_value.text)?.model.trim();
    return model === undefined || model === '' ? undefined : model;
  }
  function requireReadOnlyWay(roleId: string | null, loginId: string | null | undefined): void {
    if (roleId === null || loginId === null || loginId === undefined) return;
    const role = roleOf(roleId);
    if (role?.permission !== 'read') return;
    const held = currentConfig(loginId);
    const why = held === undefined ? undefined : readOnlyRefusal(currentLogin(loginId)!, executors);
    if (why !== undefined) throw new InputError(why);
  }

  function requireKnowledgeRole(roleId: string): void {
    const refused = knowledgeRoleRefusal(roleOf(roleId));
    if (refused !== undefined) throw new InputError(refused);
  }

  // The skills a Task names: any active skill visible to this project (global or scoped to
  // projectId), regardless of role filter and without an artificial count cap.
  function namedSkills(ids: readonly unknown[] | undefined, projectId: string | null): string[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id === '')) throw new InputError('skill_ids 要是技能编号的列表');
    const unique = [...new Set(ids as string[])];
    for (const id of unique) {
      const entry = isDirectorySkillId(id) ? directorySkillEntry(id) : knowledge.getEntry(id);
      if (!entry) throw new InputError(`没有这个技能：${id}`);
      if (entry.kind !== 'skill') throw new InputError(`${id} 是知识，不是技能：只能点名技能`);
      if (entry.state !== 'active') continue;
      if (entry.project_ids !== null && (projectId === null || !entry.project_ids.includes(projectId))) {
        throw new InputError(`技能 ${id}“${entry.title}”不属于这个项目`);
      }
    }
    return unique;
  }

  function requireRole(roleId: unknown): RoleRecord {
    if (typeof roleId !== 'string' || roleId === '') throw new InputError(ROLE_REQUIRED_TEXT);
    const row = db.get<RoleRow>('SELECT * FROM role WHERE id = ?', roleId);
    if (!row) throw new InputError(`职能不存在：${roleId}`);
    return roleRecord(row);
  }

  // An override as it is stored: one of the tiers, and the reason if one was given. The
  // Router's tools insist on the reason; the owner may leave it out (§3.3).
  function overrideOf(override: TierOverrideInput | null | undefined): TierOverride | null {
    if (override === undefined || override === null) return null;
    if (typeof override.tier !== 'string' || !isTierId(override.tier)) throw new InputError(tierOnlyText(String(override.tier)));
    const reason = typeof override.reason === 'string' && override.reason.trim() !== '' ? override.reason.trim() : null;
    return { tier: override.tier, reason };
  }

  // A preference as it is stored (roles-and-tiers.md §11.3): one or more existing logins, with
  // optional reason.
  function preferOf(prefer: { loginIds: readonly string[]; reason?: string | null } | null | undefined): TaskPrefer | null {
    if (prefer === undefined || prefer === null) return null;
    if (!Array.isArray(prefer.loginIds) || prefer.loginIds.length === 0) throw new InputError('优先名单至少要有一个登录');
    const reason = typeof prefer.reason === 'string' ? prefer.reason.trim() : '';
    const ids = [...new Set(prefer.loginIds)];
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') throw new InputError('优先名单里的登录编号不对');
      if (!loginExists(id)) throw new InputError(`${loginName(id)} 不存在`);
    }
    return { login_ids: ids, reason };
  }

  // The one way back from 待验收 to the queue: a note for the next round, as an input, and
  // the revision unmoved. Whoever sends a Task back — the owner, the Router, a review's
  // rejection — goes through here.
  function sendBack(task: TaskRow, note: string, ctx: Ctx, detail: Record<string, unknown> = {}): string {
    const id = ulid();
    db.run(
      `INSERT INTO input (id, created_at, task_id, text, actor, message_id, state) VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      id, nowIso(), task.id, note, ctx.actor, ctx.messageId ?? null,
    );
    moveTask(task.id, 'queued');
    writeChange(db, 'task.rework', ctx, { taskId: task.id }, { input_id: id, revision: task.revision, ...detail });
    return id;
  }

  // ---- Review (docs/design/roles-and-tiers.md §4, §6) ----

  const RESUMABLE_THREAD_EXITS = new Set(['completed', 'interrupted', 'auth', 'quota', 'failed']);

  function latestRun(taskId: string): RunRow | undefined {
    return db.get<RunRow>('SELECT * FROM run WHERE task_id = ? ORDER BY rowid DESC LIMIT 1', taskId);
  }

  function latestEndedRun(taskId: string): RunRow | undefined {
    return db.get<RunRow>(`SELECT * FROM run WHERE task_id = ? AND state = 'ended' ORDER BY rowid DESC LIMIT 1`, taskId);
  }

  // What the ledger holds of a round's artifacts. A value in any other shape (one written
  // before registrations named their directories) holds nothing: the round is taken over
  // again when it is needed.
  function roundArtifacts(run: RunRow): RoundArtifacts {
    const parsed = run.artifacts_json == null ? null : (JSON.parse(run.artifacts_json) as Partial<RoundArtifacts> | null);
    const registration = parsed?.registration;
    const whole = registration != null && typeof registration.id === 'string' && typeof registration.at === 'string' && Array.isArray(registration.files);
    const registered = Array.isArray(parsed?.registered) ? parsed.registered.filter((id): id is string => typeof id === 'string') : [];
    return { registration: whole ? registration : null, registered, problem: parsed?.problem ?? null };
  }
  const heldOf = (run: RunRow): HeldArtifacts => ({ run_id: run.id, task_id: run.task_id, ...roundArtifacts(run), releases_dropped_at: run.releases_dropped_at });
  // A round's registration: what one whole taking-over of its artifacts found, under an id
  // of its own, so that a binding can tell it from a later one of the same round.
  const registrationOf = (run: RunRow | undefined): Registration | null => (run === undefined ? null : roundArtifacts(run).registration);
  const registeredFiles = (run: RunRow | undefined): BoundFile[] | null => registrationOf(run)?.files ?? null;

  // The product a Task holds now, in the one shape every comparison takes (productStale):
  // its latest round, its revision, the files registered for that round, the code that round
  // handed over as its own facts say it (roundCode, over that round's own source), whether that
  // round's role — as its snapshot recorded it — asks for review, and the source the Task is
  // pinned to now.
  function productOf(task: TaskRow): Product {
    const run = latestRun(task.id);
    const role = run === undefined ? undefined : (JSON.parse(run.snapshot_json) as { role?: { needs_review?: boolean } }).role;
    const pinned = api.taskSource(task.id)?.pinned ?? null;
    const report = run && finalMessageDelivery(run) ? runReport(run.id) : undefined;
    const roundSource = run === undefined ? null : (roundSourceOf(run) ?? (pinned === null ? null : snapshotSourceOf(pinned)));
    return {
      runId: run?.id ?? null, revision: task.revision, files: registeredFiles(run), needsReview: role?.needs_review === true,
      reviewed: run === undefined ? null : roundCode(run, roundSource),
      ...(run && finalMessageDelivery(run) ? { report: report ? reportBinding(report) : null } : {}),
      pinned: pinned === null ? null : (pinned.kind === 'repo'
        ? { source_kind: 'repo', url: pinned.url } satisfies CodeSource
        : { source_kind: 'folder', path: pinned.path } satisfies CodeSource),
    };
  }

  // Where a Task's work started (§8 第 6 条): the HEAD its machine read when the first round that
  // actually began work started. Only that round's reading counts: a later round's is another
  // moment, and a first round that began but reported no start leaves it unknown rather than
  // letting a later round stand in for the Task's own beginning.
  function taskStartOf(taskId: string): string | null {
    for (const run of db.all<RunRow>('SELECT * FROM run WHERE task_id = ? ORDER BY rowid', taskId)) {
      if (neverRan(run)) continue;
      const start = sourceHeadOf(run)?.start;
      return typeof start === 'string' && start !== '' ? start : null;
    }
    return null;
  }

  // What a review is bound to, made here from what the ledger holds: the reviewed Task, the
  // round the service took the files over from — named by the caller as it was when the
  // taking began, so that a round that came in meanwhile is refused — that round's
  // registration, files and writers together, and the commit the round handed over, checked
  // where it lives by the service before this call (shared/sources.ts ReviewedCommit). The
  // Router names the Task and nothing else. Only a Task waiting to be accepted has a product
  // to review.
  function bindReview(reviewed: TaskRow, registered: { runId?: string; revision?: number; registration?: string; reviewed?: ReviewedCommit | null }): ReviewOf {
    const run = db.all<RunRow>('SELECT * FROM run WHERE task_id = ? ORDER BY rowid DESC', reviewed.id).find((each) => each.state === 'ended');
    if (!['ready', 'done', 'held'].includes(reviewed.state) || !run) {
      throw new InputError(`任务 ${reviewed.id} 没有已结束的轮次，暂时没有可审的产物`);
    }
    // The retention rule cleared this round's copies from the host: there is nothing to bind a
    // review to, and re-taking it would quietly undo the cleanup.
    if (run.releases_dropped_at !== null) throw new InputError(artifactsDroppedText({ at: run.releases_dropped_at }));
    if (registered.runId !== run.id || registered.revision !== reviewed.revision) {
      throw new InputError(`任务 ${reviewed.id} 在取回产物的这段时间里又跑了一轮或改了修订，取回的不是它现在的产物：重新派一个审阅`);
    }
    const registration = registrationOf(run);
    if (registration === null) throw new InputError(`任务 ${reviewed.id} 这一轮的产物还没有登记到主机上，审阅绑定不了`);
    if (registration.id !== registered.registration) {
      throw new InputError(`任务 ${reviewed.id} 这一轮的产物在绑定之前又被重新取回登记了一次，取回的不是现在登记的那一份：重新派一个审阅`);
    }
    const files = registration.files;
    const rounds = db.all<RunRow>('SELECT * FROM run WHERE task_id = ? ORDER BY rowid', reviewed.id);
    const finalReport = finalMessageDelivery(run) ? runReport(run.id) : undefined;
    const commit = finalReport ? undefined : checkedCommit(registered.reviewed);
    const start = taskStartOf(reviewed.id);
    const tier = (JSON.parse(run.snapshot_json) as { tier?: unknown }).tier;
    return {
      task_id: reviewed.id, run_id: run.id, revision: reviewed.revision,
      title: reviewed.title, goal: reviewed.goal, scope: reviewed.scope, acceptance: reviewed.acceptance,
      ...(commit === undefined ? {} : { reviewed: commit }),
      ...(start === null ? {} : { start }),
      ...(finalReport ? { report: reportBinding(finalReport) } : {}),
      files, writers: writersOf(rounds), at: nowIso(),
      ...(typeof tier === 'string' && isTierId(tier) ? { tier } : {}),
    };
  }

  function checkedCommit(value: ReviewedCommit | null | undefined): ReviewedCommit | undefined {
    if (value === null || value === undefined) return undefined;
    const text = (each: unknown): string | null => (typeof each === 'string' && each.trim() !== '' ? each.trim() : null);
    const commit = text(value.commit);
    if ((value.source_kind !== 'repo' && value.source_kind !== 'folder') || commit === null) {
      return undefined;
    }
    if (value.source_kind === 'repo') {
      const url = text(value.url);
      const branch = text(value.branch);
      return {
        source_kind: 'repo',
        commit,
        ...(branch === null ? {} : { branch }),
        ...(url === null ? {} : { url }),
      };
    }
    const path = text(value.path);
    const branch = text(value.branch);
    return {
      source_kind: 'folder',
      commit,
      ...(path === null ? {} : { path }),
      ...(branch === null ? {} : { branch }),
    };
  }

  const reviewsOf = (taskId: string): TaskRow[] =>
    db.all<TaskRow>(`${TASK_SELECT} WHERE json_extract(task.review_of_json, '$.task_id') = ? ORDER BY task.rowid`, taskId);

  // The executors that have already reviewed this very product: the executors of the Runs of
  // other review Tasks bound to the same reviewed Task and the same round. A review's picks
  // put those executors behind the ones that have not seen it (roles-and-tiers.md §11.3), so
  // that a second review of one product lands somewhere new.
  function spreadExecutorsOf(task: Pick<TaskRow, 'id' | 'review_of_json'>): string[] {
    const binding = parseReviewOf(task.review_of_json);
    if (binding === null) return [];
    const rows = db.all<{ snapshot_json: string }>(
      `SELECT run.snapshot_json FROM run
       JOIN task AS review ON review.id = run.task_id
       WHERE review.id != ? AND json_extract(review.review_of_json, '$.task_id') = ?
         AND json_extract(review.review_of_json, '$.run_id') = ?
       ORDER BY run.rowid`,
      task.id, binding.task_id, binding.run_id,
    );
    return [...new Set(rows.flatMap(({ snapshot_json }) => {
      const executor = executorOf(snapshot_json);
      return executor === undefined ? [] : [executor];
    }))];
  }

  const verdictRecord = (task: TaskRow): VerdictRecord | null => (task.verdict_json === null ? null : (JSON.parse(task.verdict_json) as VerdictRecord));

  // The bindings of the passes a Task's reviews handed over, oldest first.
  const passesOf = (task: TaskRow): ReviewOf[] => reviewsOf(task.id)
    .filter((review) => verdictRecord(review)?.result === 'pass')
    .map((review) => parseReviewOf(review.review_of_json)!);

  // The pass that opens acceptance for the product the Task holds now, if any: the newest
  // binding that still speaks for it. What a landing merges is the commit that binding was
  // made at, never a later report of the branch.
  function currentPassOf(task: TaskRow): ReviewOf | null {
    const product = productOf(task);
    return passesOf(task).filter((binding) => productStale(binding, product) === null).at(-1) ?? null;
  }

  // Whether the owner let this Task past the review gate himself: the acceptance is the last one
  // this Task had, and it carries `without_review` (acceptTask). The one reading of that line, so
  // the release entry and a landing ask the same question in the same words.
  function acceptedWithoutReview(taskId: string): boolean {
    const accepted = db.get<{ detail_json: string }>(
      `SELECT detail_json FROM change WHERE task_id = ? AND action = 'task.accept' ORDER BY seq DESC LIMIT 1`, taskId,
    );
    return accepted !== undefined && (JSON.parse(accepted.detail_json) as { without_review?: boolean }).without_review === true;
  }

  // A step its project granted the Router (shared/grants.ts). The gates in front of a step are
  // the step's own (requireLandable, releaseGate) and apply to the owner's entries as well.
  function requireGrantOf(task: TaskRow, grant: GrantId, ctx: Ctx): void {
    if (ctx.actor !== 'router') return;
    const row = task.project_id === null ? undefined : db.get<{ grants_json: string }>('SELECT grants_json FROM project WHERE id = ?', task.project_id);
    if (row === undefined || !grantsOf(row.grants_json).includes(grant)) throw new InputError(notGrantedText(grant));
    if (grant === 'release') requireState(task, ['done'], GRANTS[grant].label + '（先验收）');
  }

  // The one gate in front of taking a Task's work into the main line, for the console and the
  // Router alike (project-sessions, "负责人可以自己做的事"): only accepted work has a product the
  // owner signed off on, and only that may go in.
  function requireLandable(task: TaskRow): void {
    requireState(task, ['done'], GRANTS.integrate.label + '（先验收）');
  }

  // The latest non-closed review Task bound to the product this Task currently holds, if any.
  function activeReviewOf(task: TaskRow): TaskRow | null {
    const product = productOf(task);
    return reviewsOf(task.id).filter((review) => {
      if (review.state === 'done' || review.state === 'abandoned') return false;
      const binding = parseReviewOf(review.review_of_json);
      return binding !== null && productStale(binding, product) === null;
    }).at(-1) ?? null;
  }

  // Structured reading of why this Task cannot be accepted for want of review; null when it can.
  // Only a product whose round's role asks for review is asked, and it needs a pass bound to that
  // product. When a non-closed review for the current product exists, report its live state so the
  // UI and errors say "审阅中" or "审阅已停住" instead of asking for another review.
  function reviewGateInfoOf(task: TaskRow): ReviewGateInfo | null {
    const product = productOf(task);
    if (!product.needsReview) return null;
    const stale = passesOf(task).map((binding) => productStale(binding, product));
    if (stale.includes(null)) return null;
    const active = activeReviewOf(task);
    if (active !== null) {
      if (active.state === 'held' || active.state === 'waiting_person') {
        return {
          kind: 'review_held',
          message: reviewHeldGateText(active.reason),
          review_task_id: active.id,
          review_state: active.state,
          review_reason: active.reason,
        };
      }
      return {
        kind: 'in_review',
        message: REVIEW_IN_PROGRESS_TEXT,
        review_task_id: active.id,
        review_state: active.state,
        review_reason: active.reason,
      };
    }
    if (stale.length > 0) {
      return {
        kind: 'stale_pass',
        message: `${NEEDS_PASS_TEXT}（有过的“通过”已经不算：${stale.at(-1)}）`,
      };
    }
    return { kind: 'no_review', message: NEEDS_PASS_TEXT };
  }

  // Why this Task cannot be accepted for want of review; null when it can.
  function reviewGateOf(task: TaskRow): string | null {
    return reviewGateInfoOf(task)?.message ?? null;
  }

  // An open question a review's rejection put to the owner (kept for reading legacy approvals).
  function reviewQuestionOpen(taskId: string): boolean {
    return db.get(`SELECT 1 FROM approval WHERE task_id = ? AND state = 'open' AND review_task_id IS NOT NULL`, taskId) !== undefined;
  }

  // A review's verdict, settled in the review's own settlement: records verdict_json and the
  // review.verdict timeline entry without auto-escalating tiers or locking out the Router.
  function settleVerdict(review: TaskRow, run: RunRow, verdict: Verdict): { passCurrent: boolean } {
    const binding = parseReviewOf(review.review_of_json)!;
    const reviewed = loadTask(binding.task_id);
    const current = reviewed.state === 'ready' && productStale(binding, productOf(reviewed)) === null;
    const same = (JSON.parse(run.snapshot_json) as { same_executor?: SameExecutor }).same_executor;
    const record: VerdictRecord = { ...verdict, run_id: run.id, at: nowIso(), current, ...(same ? { same_executor: same.executor } : {}) };
    db.run('UPDATE task SET verdict_json = ? WHERE id = ?', JSON.stringify(record), review.id);
    writeChange(db, 'review.verdict', RUNNER, { taskId: review.id, runId: run.id }, { reviewed_task_id: reviewed.id, result: verdict.result, current, ...(same ? { same_executor: same.executor } : {}) });
    return { passCurrent: verdict.result === 'pass' && current };
  }

  // Every Task transition goes through here, so "one waiting condition at a
  // time" holds by construction: the old question, timer and reason are dropped
  // unless the caller states a new one.
  // `byHand`: the Router or the owner parked it. Anything else that stops a Task is the rules
  // stopping it, which waits for the owner (project-sessions §2.1) — except a result of a revision
  // the Router or the owner made since, and what a restored backup stops: the owner goes through
  // those on the restore page, all at once, not one push each.
  function moveTask(
    taskId: string,
    state: TaskState,
    fields: { reason?: string; wakeAt?: string; closed?: boolean; byHand?: boolean } = {},
  ): void {
    if (state === 'held' && !fields.byHand && fields.reason !== RESTORE_HOLD_REASON && fields.reason !== STALE_REVISION_REASON) {
      const before = db.get<{ state: string; reason: string | null }>('SELECT state, reason FROM task WHERE id = ?', taskId);
      if (before && (before.state !== 'held' || before.reason !== (fields.reason ?? null))) {
        enqueueNotification(NOTICE_CHANNEL, 'held', { external_id: `held:${taskId}:${nowIso()}`, task_id: taskId, reason: fields.reason ?? null });
      }
    }
    // A Task goes into the queue only when it can leave it. One with no role (from before
    // roles, docs/design/roles-and-tiers.md §8) has no tier to be picked for, so it waits
    // for the owner instead — in the same words, whichever path brought it here: queueing,
    // resuming, a rework, an answer, a timer, or a lost Run continuing.
    if (state === 'queued' && !hasRole(taskId)) {
      state = 'waiting_person';
      fields = { reason: NO_ROLE_REASON };
    }
    const at = nowIso();
    const closing = db.all<{ id: string }>(`SELECT id FROM approval WHERE task_id = ? AND state = 'open'`, taskId);
    db.run(`UPDATE approval SET state = 'closed', decided_at = ? WHERE task_id = ? AND state = 'open'`, at, taskId);
    for (const approval of closing) {
      enqueueNotification(NOTICE_CHANNEL, 'approval_closed', {
        external_id: `approval_closed:${approval.id}`, approval_id: approval.id, task_id: taskId,
      });
    }
    db.run(
      'UPDATE task SET state = ?, reason = ?, wake_at = ?, closed_at = ? WHERE id = ?',
      state,
      fields.reason ?? null,
      fields.wakeAt ?? null,
      fields.closed ? at : null,
      taskId,
    );
  }

  function askQuestions(task: TaskRow, runId: string | null, questions: Question[], ctx: Ctx, reviewTaskId: string | null = null): string {
    moveTask(task.id, 'waiting_person');
    const id = ulid();
    db.run(
      `INSERT INTO approval (id, created_at, task_id, run_id, task_revision, questions_json, state, review_task_id)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      id,
      nowIso(),
      task.id,
      runId,
      task.revision,
      JSON.stringify(questions),
      reviewTaskId,
    );
    enqueueNotification(NOTICE_CHANNEL, 'approval', {
      external_id: `approval:${id}`,
      approval_id: id,
      task_id: task.id,
      task_revision: task.revision,
      questions,
    });
    writeChange(db, 'approval.open', ctx, { taskId: task.id, runId: runId ?? undefined }, { approval_id: id, ...(reviewTaskId === null ? {} : { review_task_id: reviewTaskId }) });
    return id;
  }

  // The login as the ledger holds it now: an account, or a machine's own login.
  function machineLoginById(id: string): MachineLoginRecord | undefined {
    const row = db.get<MachineLoginRow>('SELECT machine_login.* FROM machine_login JOIN machine ON machine.uid = machine_login.machine_uid WHERE machine_login.id = ?', id);
    return row && machineLoginOf(row);
  }
  function currentLogin(loginId: string | null): Login | undefined {
    if (loginId === null) return undefined;
    const account = db.get<AccountRow>('SELECT * FROM account WHERE id = ?', loginId);
    if (account) return accountOf(account);
    return machineLoginById(loginId);
  }
  // What a login went by when it was removed, read from the change that removed it: the
  // owner's words rather than the internal number, which reaches no sentence
  // (docs/design/accounts-machines-decoupled.md "内部编号"). An account's deletion records
  // its name; a machine's own login records the display name it had; the step to version 18
  // recorded the accounts it folded, whose reference was the name itself. Null when nothing
  // recorded one.
  function deletedLoginName(id: string | null): string | null {
    if (id === null) return null;
    const account = db.get<{ name: string | null }>(
      `SELECT json_extract(detail_json, '$.account.name') AS name FROM change
       WHERE action = 'account.delete' AND json_extract(detail_json, '$.account_id') = ? ORDER BY seq DESC LIMIT 1`, id,
    );
    if (account?.name) return account.name;
    const own = db.get<{ name: string | null }>(
      `SELECT COALESCE(json_extract(detail_json, '$.login_name'), json_extract(detail_json, '$.login.name')) AS name FROM change
       WHERE action = 'machine_login.delete' AND json_extract(detail_json, '$.login_id') = ? ORDER BY seq DESC LIMIT 1`, id,
    );
    if (own?.name) return own.name;
    const folded = db.get(`SELECT 1 FROM change WHERE action = 'login.migrate' AND json_extract(detail_json, '$.account_id') = ? LIMIT 1`, id);
    return folded === undefined ? null : id;
  }
  const loginName = (id: string | null, name?: string | null): string => {
    // Whatever name there is goes through the one display rule too: a stored deletion audit
    // carries the name, not a phrase, so a machine's own login still reads "机器 … 上的 …
    // 登录" (docs/design/accounts-machines-decoupled.md "内部编号").
    const known = currentLogin(id) ?? name ?? deletedLoginName(id);
    return known === undefined || known === null ? '已删除的登录' : displayLogin(known);
  };
  const authReason = (id: string | null): string => currentLogin(id)?.machine === undefined ? AUTH_REASON : MACHINE_AUTH_REASON;
  // The same, in the words a snapshot records it in.
  function currentConfig(loginId: string | null): LoginConfig | undefined {
    const login = currentLogin(loginId);
    return login && loginConfig(login);
  }
  const loginExists = (loginId: string | null): boolean => currentLogin(loginId) !== undefined;

  // The number of the token file the account uses now. A machine's own login has none.
  function credentialRefOf(loginId: string | null): string | null {
    if (loginId === null) return null;
    return db.get<{ credential_ref: string | null }>('SELECT credential_ref FROM account WHERE id = ?', loginId)?.credential_ref ?? null;
  }

  function quotaGeneration(loginId: string | null): string | null {
    if (loginId === null) return null;
    const row = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId);
    return (JSON.parse(row?.identity_json ?? '{}') as { quotaGeneration?: string }).quotaGeneration ?? null;
  }

  function clearQuota(loginId: string): void {
    db.run(`UPDATE login_state SET usage_json = '{}', rest_seq = NULL, rest_until = NULL,
      rest_streak = 0, rest_reason = NULL WHERE id = ?`, loginId);
  }

  function clearAccountIdentity(loginId: string): void {
    db.run("UPDATE login_state SET identity_json = '{}', models_at = NULL WHERE id = ?", loginId);
    clearQuota(loginId);
  }

  // The number a Run was started with. A Run from before the ledger named tokens has
  // none, and is a Run without a token.
  function runCredentialRef(run: RunRow): string | null {
    return (JSON.parse(run.snapshot_json) as { credential_ref?: string }).credential_ref ?? null;
  }


  function currentMachine(id: string): MachineRecord | undefined {
    const row = db.get<MachineRow>(`${MACHINE_SELECT} WHERE machine.id = ?`, id);
    return row && machineOf(row);
  }
  // A project's machines are chosen by registration, never by name: a name can mean another
  // machine by the time a choice is saved. One no machine has is refused, said by which it is.
  function heldUids(uids: readonly string[]): string[] {
    for (const uid of uids) {
      if (!db.get('SELECT 1 FROM machine WHERE uid = ?', uid)) throw new InputError(`允许的机器里有一项（登记号 ${uid}）已经不是任何一台机器：它被删掉了，或者删掉后又有同名的机器重新接入。重新打开项目页再选`);
    }
    return [...uids];
  }
  function projectMachinesOf(json: string): ProjectMachines {
    const uids = JSON.parse(json) as string[];
    const machines = uids.flatMap((uid) => {
      const row = db.get<{ id: string }>('SELECT id FROM machine WHERE uid = ?', uid);
      return row ? [{ uid, name: row.id }] : [];
    });
    return { machines, gone: uids.length - machines.length };
  }
  const namesOf = ({ machines }: ProjectMachines): string[] => machines.map(({ name }) => name);
  // A machine deleted is gone from what projects allow by itself: their machine lists name its
  // registration, which no machine has any more. Its own logins are in no project's list either,
  // so that a machine joining later under its name inherits nothing (nodes.md §5.4). Each
  // project it was in says so in the timeline.
  function scrubDispatchOrders(removedIds: ReadonlySet<string>): void {
    if (removedIds.size === 0) return;
    // Also scrub deleted login IDs from global dispatch_slots_v1 so stale IDs never accumulate.
    const globalRow = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', DISPATCH_SLOTS_SETTING_KEY);
    if (globalRow) {
      const globalSlots = parseDispatchSlots(globalRow.value_json);
      if (globalSlots) {
        let globalChanged = false;
        const nextGlobal: DispatchSlotsConfig = {};
        for (const tier of TIER_IDS) {
          const tierSlots = globalSlots[tier];
          if (!tierSlots) continue;
          const p1 = tierSlots.p1.filter((id) => !removedIds.has(id));
          const p2 = tierSlots.p2.filter((id) => !removedIds.has(id));
          const off = tierSlots.off.filter((id) => !removedIds.has(id));
          if (p1.length !== tierSlots.p1.length || p2.length !== tierSlots.p2.length || off.length !== tierSlots.off.length) globalChanged = true;
          nextGlobal[tier] = { p1, p2, off };
        }
        if (globalChanged) {
          db.run('UPDATE setting SET value_json = ? WHERE key = ?', JSON.stringify(nextGlobal), DISPATCH_SLOTS_SETTING_KEY);
        }
      }
    }
    for (const project of db.all<{ id: string; dispatch_order_json: string | null }>('SELECT id, dispatch_order_json FROM project WHERE dispatch_order_json IS NOT NULL ORDER BY rowid')) {
      const { slots, order } = parseProjectDispatchConfig(project.dispatch_order_json);
      if (!slots && !order) {
        db.run('UPDATE project SET dispatch_order_json = NULL WHERE id = ?', project.id);
        continue;
      }
      if (slots) {
        let changed = false;
        const next: DispatchSlotsConfig = {};
        for (const tier of TIER_IDS) {
          const tierSlots = slots[tier];
          if (!tierSlots) continue;
          const p1 = tierSlots.p1.filter((id) => !removedIds.has(id));
          const p2 = tierSlots.p2.filter((id) => !removedIds.has(id));
          const off = tierSlots.off.filter((id) => !removedIds.has(id));
          if (p1.length !== tierSlots.p1.length || p2.length !== tierSlots.p2.length || off.length !== tierSlots.off.length) changed = true;
          next[tier] = { p1, p2, off };
        }
        if (!changed) continue;
        const nextJson = Object.keys(next).length > 0 ? JSON.stringify(next) : null;
        db.run('UPDATE project SET dispatch_order_json = ? WHERE id = ?', nextJson, project.id);
        continue;
      }
      let changed = false;
      const next: Partial<Record<TierId, string[]>> = {};
      for (const tier of TIER_IDS) {
        const list = order?.[tier];
        if (!list) continue;
        const kept = list.filter((id) => !removedIds.has(id));
        if (kept.length !== list.length) changed = true;
        if (kept.length > 0) next[tier] = kept;
      }
      if (!changed) continue;
      const nextJson = Object.keys(next).length > 0 ? JSON.stringify(next) : null;
      db.run('UPDATE project SET dispatch_order_json = ? WHERE id = ?', nextJson, project.id);
    }
  }
  function forgetMachineInProjects(machine: MachineRecord, uid: string, ctx: Ctx): void {
    const removed = new Set(db.all<{ id: string }>('SELECT id FROM machine_login WHERE machine_uid = ?', uid).map(({ id }) => id));
    scrubDispatchOrders(removed);
    for (const project of db.all<{ id: string; logins_json: string; machines_json: string }>('SELECT id, logins_json, machines_json FROM project ORDER BY rowid')) {
      const logins = JSON.parse(project.logins_json) as string[];
      const kept = logins.filter((login) => !removed.has(login));
      const named = (JSON.parse(project.machines_json) as string[]).includes(uid);
      if (kept.length === logins.length && !named) continue;
      if (kept.length !== logins.length) db.run('UPDATE project SET logins_json = ? WHERE id = ?', JSON.stringify(kept), project.id);
      const allowed = projectMachinesOf(project.machines_json);
      const left = namesOf({ ...allowed, machines: allowed.machines.filter((held) => held.uid !== uid) });
      writeChange(db, 'project.update', ctx, {}, {
        project_id: project.id, machine_deleted: machine.id,
        ...(kept.length === logins.length ? {} : { logins: { from: logins, to: kept } }),
        ...(named ? { machines_left: left } : {}),
      });
    }
  }
  // The projects a login is allowed by, and what each would allow without it. Read for the
  // owner's confirmation and again to write, so the preview and the write cannot come to
  // different lists (docs/design/native-login.md §2).
  function projectListsAfter(loginId: string): { id: string; name: string; logins: string[]; kept: string[] }[] {
    return db.all<{ id: string; name: string; logins_json: string }>('SELECT id, name, logins_json FROM project ORDER BY rowid')
      .flatMap((project) => {
        const logins = JSON.parse(project.logins_json) as string[];
        if (!logins.includes(loginId)) return [];
        return [{ id: project.id, name: project.name, logins, kept: logins.filter((one) => one !== loginId) }];
      });
  }
  // What each of those projects has left to run on, from the one effective pool (loginPool):
  // in "全部登录" mode the pool is every login, not the stale list the project kept. The
  // login being removed is still in the ledger here, so it is taken out by id.
  const remainingAfter = (loginId: string): { id: string; name: string; remaining: number }[] =>
    projectListsAfter(loginId).map(({ id, name }) => ({ id, name, remaining: loginPool({ project_id: id }).ids.filter((one) => one !== loginId).length }));
  // Removing a login takes it out of every project's allowed list, in the same transaction as
  // the removal, and each affected project says so in its own timeline by the name it went by
  // (docs/design/native-login.md §2). A reference left behind would keep a deleted login
  // restricting where a project's work may run.
  function forgetLoginInProjects(loginId: string, removedName: string, ctx: Ctx): { id: string; name: string; remaining: number }[] {
    scrubDispatchOrders(new Set([loginId]));
    const affected: { id: string; name: string; remaining: number }[] = [];
    for (const project of projectListsAfter(loginId)) {
      // Read before the list is written: the pool answers for the project as it stands now.
      const remaining = loginPool({ project_id: project.id }).ids.filter((one) => one !== loginId).length;
      db.run('UPDATE project SET logins_json = ? WHERE id = ?', JSON.stringify(project.kept), project.id);
      writeChange(db, 'project.update', ctx, {}, {
        project_id: project.id,
        login_removed: removedName,
        logins: { from: project.logins, to: project.kept },
        reason: `登录 ${removedName} 被删掉，从项目允许的登录里去掉了它`,
      });
      affected.push({ id: project.id, name: project.name, remaining });
    }
    return affected;
  }
  function currentInvite(id: string): InviteRow | undefined {
    const at = nowIso();
    const row = db.get<InviteRow>(`${INVITE_SELECT} WHERE machine_invite.id = ?`, at, at, id);
    return row && inviteOf(row);
  }
  // The quota of a task a round may still be handed materials from: not revoked, not past
  // its time, with a machine still to register. At most one per task is ever open.
  function openInviteOf(taskId: string): InviteRow | undefined {
    const at = nowIso();
    return db.all<InviteRow>(
      `${INVITE_SELECT} WHERE machine_invite.task_id = ? AND machine_invite.revoked_at IS NULL AND machine_invite.expires_at > ? ORDER BY machine_invite.rowid DESC`,
      at, at, taskId, at,
    ).map(inviteOf).find((invite) => invite.used < invite.max_machines);
  }
  // Which round of its Task a Run is, from 1.
  function roundOf(taskId: string, runId: string): number {
    const ids = db.all<{ id: string }>('SELECT id FROM run WHERE task_id = ? ORDER BY rowid', taskId).map(({ id }) => id);
    return ids.indexOf(runId) + 1;
  }
  // One ending of an ephemeral machine, written once: a fact that is already there is not
  // rewritten with a later moment.
  function endMachine(id: string, column: 'drain_at' | 'evidence_at', ctx: Ctx | undefined, action: string): void {
    const machine = currentMachine(id);
    if (!machine) throw new InputError('机器不存在：' + id);
    if (!machine.ephemeral) throw new InputError(`机器 ${id} 不是临时机器，没有这一步`);
    if ((column === 'drain_at' ? machine.drainAt : machine.evidenceAt) !== undefined) return;
    const at = nowIso();
    db.run(`UPDATE machine SET ${column} = ? WHERE id = ?`, at, id);
    writeChange(db, action, ctx ?? SERVICE, {}, { machine_id: id, at });
  }
  function requireMachine(task: TaskRow, held: Pick<LoginConfig, 'executor' | 'machine'>, id: string): void {
    if (task.machine_id !== null && task.machine_id !== id) {
      throw new InputError(`任务指定了目标机器 ${task.machine_id}，不能派发到 ${id}`);
    }
    const login = { executor: held.executor, ...(held.machine === null ? {} : { machine: held.machine }) };
    const machine = currentMachine(id);
    // A folder source names its machine outright: the project's allowed machines do not narrow
    // it (docs/design/code-sources.md §2). The pin is read here because createRun is the last
    // gate before a Run exists, and the dispatcher's choice has to be acceptable to it.
    const pinned = task.source_json === null ? null : (JSON.parse(task.source_json) as TaskSource);
    if (machine !== undefined && pinned?.pinned.kind === 'folder' && pinned.pinned.machine_uid === machine.uid
      && (login.machine === undefined || login.machine === id)) return;
    const range = machineRange(task);
    if ('conflict' in range) throw new InputError(range.conflict);
    // The same answer eligibleMachines gives, so that what the dispatcher offers and what
    // the ledger accepts cannot disagree; a machine it does not hold is judged by name.
    const ok = machine === undefined
      ? (login.machine === undefined || login.machine === id) && inRange(range.allowed, id)
      : machineAllowed(machine, login, range.allowed, range.projectId);
    if (!ok) throw new InputError('机器 ' + id + ' 不在这份登录或项目的允许范围内，不能派发');
  }

  // The logins a Task may be picked from: its project's list; a knowledge Task's, the
  // knowledge logins, or every login the owner has when those name none (knowledge §3).
  // Every login the owner has, accounts first, each in the order it was added. This is the
  // order without a preference in force, and the order every unlisted login keeps after
  // those the owner did list for a tier.
  const everyLogin = (): string[] => [
    ...db.all<{ id: string }>('SELECT id FROM account ORDER BY rowid').map(({ id }) => id),
    ...db.all<{ id: string }>('SELECT id FROM machine_login ORDER BY rowid').map(({ id }) => id),
  ];
  // The order one tier tries its logins in (roles-and-tiers.md §11.3): the logins the owner
  // listed for that tier, in that order, then every other login in the order it was added.
  // A login deleted since is dropped. This is the only place the order is worked out; the
  // pools below still say which logins a Task may use, never which comes first.
  function expandTierSlotsToLoginIds(tierSlots: TierDispatchSlots): string[] {
    const accounts = db.all<{ id: string }>('SELECT id FROM account ORDER BY rowid').map((r) => r.id);
    const machineRows = db.all<{ id: string; executor: string; tiers_json: string | null }>('SELECT id, executor, tiers_json FROM machine_login ORDER BY rowid');
    const routeByLoginId = new Map<string, string | null>();
    const identityRows = db.all<{ id: string; identity_json: string | null }>('SELECT id, identity_json FROM login_state WHERE identity_json IS NOT NULL');
    const reportedRouteById = new Map<string, string | null>();
    for (const row of identityRows) {
      try {
        const parsed = JSON.parse(row.identity_json!) as { routeLabel?: unknown } | null;
        if (parsed && typeof parsed.routeLabel === 'string' && parsed.routeLabel.trim()) {
          reportedRouteById.set(row.id, parsed.routeLabel.trim());
        }
      } catch { /* ignore malformed identity_json */ }
    }
    for (const m of machineRows) {
      let tiers: Record<string, { text?: string } | undefined> | null = null;
      if (m.tiers_json) {
        try { tiers = JSON.parse(m.tiers_json) as Record<string, { text?: string } | undefined>; } catch { tiers = null; }
      }
      routeByLoginId.set(m.id, normalizeRouteKey(effectiveRouteOfLogin({ routeLabel: reportedRouteById.get(m.id) ?? null, tiers })));
    }
    const expandKey = (key: string): string[] => {
      const parsed = parseExecutorSlotKey(key);
      if (parsed !== null) {
        return machineRows
          .filter((m) => m.executor === parsed.executor && (parsed.route === null || routeByLoginId.get(m.id) === parsed.route))
          .map((m) => m.id);
      }
      return accounts.includes(key) || machineRows.some((m) => m.id === key) ? [key] : [];
    };
    const orderedLogins: string[] = [];
    const seen = new Set<string>();
    for (const key of [...tierSlots.p1, ...tierSlots.p2]) {
      for (const id of expandKey(key)) {
        if (seen.has(id)) continue;
        seen.add(id);
        orderedLogins.push(id);
      }
    }
    return orderedLogins;
  }
  function loginOrder(tier: string | null, projectId?: string | null): string[] {
    const all = everyLogin();
    if (tier === null || !isTierId(tier)) return all;
    const globalListed = (tuned(dispatchOrderKey(tier)) as readonly string[]).filter(loginExists);
    let projectListed: string[] = [];
    if (projectId !== undefined && projectId !== null) {
      const row = db.get<{ dispatch_order_json: string | null }>('SELECT dispatch_order_json FROM project WHERE id = ?', projectId);
      const { slots, order } = parseProjectDispatchConfig(row?.dispatch_order_json);
      const tierSlots = slots?.[tier];
      if (tierSlots) {
        projectListed = expandTierSlotsToLoginIds(tierSlots).filter(loginExists);
      } else {
        const tierList = order?.[tier];
        if (tierList && tierList.length > 0) {
          projectListed = tierList.filter(loginExists);
        }
      }
    }
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const id of [...projectListed, ...globalListed, ...all]) {
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    return merged;
  }
  function projectDispatchOrder(projectId: string): Partial<Record<TierId, string[]>> | null {
    const row = db.get<{ dispatch_order_json: string | null }>('SELECT dispatch_order_json FROM project WHERE id = ?', projectId);
    if (!row) throw new InputError(`项目不存在：${projectId}`);
    const parsed = parseProjectDispatchOrder(row.dispatch_order_json);
    if (!parsed) return null;
    const out: Partial<Record<TierId, string[]>> = {};
    for (const tier of TIER_IDS) {
      const filtered = (parsed[tier] ?? []).filter(loginExists);
      if (filtered.length > 0) out[tier] = filtered;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  function projectDispatchSlots(projectId: string): DispatchSlotsConfig | null {
    const row = db.get<{ dispatch_order_json: string | null }>('SELECT dispatch_order_json FROM project WHERE id = ?', projectId);
    if (!row) throw new InputError(`项目不存在：${projectId}`);
    return parseProjectDispatchConfig(row.dispatch_order_json).slots;
  }
  function effectiveProjectDispatchOrder(projectId: string): Record<TierId, string[]> {
    if (!db.get('SELECT 1 FROM project WHERE id = ?', projectId)) {
      throw new InputError(`项目不存在：${projectId}`);
    }
    const allowed = new Set(loginPool({ project_id: projectId }).ids);
    return Object.fromEntries(
      TIER_IDS.map((tier) => [tier, loginOrder(tier, projectId).filter((id) => allowed.has(id))]),
    ) as Record<TierId, string[]>;
  }
  // The effective pool, the one place it is derived (docs/design/project-sessions.md §5): a
  // project's every login or only those it lists, a knowledge Task's knowledge logins (knowledge
  // §3) — less any login that no longer exists. Picking, a pin, a spawned machine's accounts and
  // createRun all read this.
  function loginPool(task: Pick<TaskRow, 'project_id'>): { ids: string[]; where: string; how?: string } {
    if (task.project_id === null) {
      const named = options.knowledgeLogins?.() ?? [];
      const ids = named.length > 0 ? named.filter(loginExists) : everyLogin();
      return { ids, where: '知识任务用的登录', how: '（设置“知识任务用哪些登录”）' };
    }
    const project = db.get<{ name: string; logins_json: string; login_mode: string }>('SELECT name, logins_json, login_mode FROM project WHERE id = ?', task.project_id)!;
    if (project.login_mode === 'all') return { ids: everyLogin(), where: `项目 ${project.name} 能用的登录（全部登录）` };
    return { ids: (JSON.parse(project.logins_json) as string[]).filter(loginExists), where: `项目 ${project.name} 选用的登录`, how: '（项目页“登录”）' };
  }
  // Why this login may not run the Task, or undefined: the one judgment a pin made by anyone, the
  // dispatcher and createRun share. A pin narrows the pool and never reaches past it: a project
  // narrowed since, or a login gone, stops the Task with this as its reason (§5).
  function loginRefusal(task: Pick<TaskRow, 'project_id'>, loginId: string): string | undefined {
    // A login that is gone is the pick's to say ("没有可用的登录"), as it always was.
    if (!loginExists(loginId)) return undefined;
    const pool = loginPool(task);
    return pool.ids.includes(loginId) ? undefined : `${loginName(loginId)} 不在${pool.where}里${pool.how ?? ''}`;
  }
  function requireLoginAllowed(task: Pick<TaskRow, 'project_id'>, loginId: string | null | undefined): void {
    if (loginId !== null && loginId !== undefined && !loginExists(loginId)) throw new InputError(loginName(loginId) + ' 不存在');
    const refused = loginId === null || loginId === undefined || loginId === '' ? undefined : loginRefusal(task, loginId);
    if (refused !== undefined) throw new InputError(refused);
  }

  // Where a Task's rounds may go: its project's range (empty is any machine). A knowledge Task
  // belongs to no project (knowledge §3): its material carries the content of the projects
  // describeKnowledgeTask names, so it goes only to a machine every one of them allows, and
  // never to one spawned for a project. `conflict` says which projects have none in common.
  function machineRange(task: Pick<TaskRow, 'project_id' | 'knowledge_json'>): MachineRange {
    const held = (id: string): ProjectMachines =>
      projectMachinesOf(db.get<{ machines_json: string }>('SELECT machines_json FROM project WHERE id = ?', id)!.machines_json);
    // A list that names only machines since deleted allows none: it is not the empty list.
    const deleted = (id: string): string => `项目 ${projectName(id)} 允许的机器都已经删掉了：在项目页重新选机器（清空就是哪台都行）`;
    const rangeOf = (id: string): string[] | { conflict: string } => {
      const range = held(id);
      const names = namesOf(range);
      return names.length === 0 && range.gone > 0 ? { conflict: deleted(id) } : names;
    };
    const job = parseKnowledgeTask(task.knowledge_json);
    if (job === null) {
      const allowed = rangeOf(task.project_id!);
      return Array.isArray(allowed) ? { allowed, projectId: task.project_id! } : allowed;
    }
    const ranges = knowledge.describeKnowledgeTask(job).projects.map((id) => ({ id, allowed: rangeOf(id) }));
    const none = ranges.find(({ allowed }) => !Array.isArray(allowed));
    if (none !== undefined) return none.allowed as { conflict: string };
    const narrowing = (ranges as { id: string; allowed: string[] }[]).filter(({ allowed }) => allowed.length > 0);
    if (narrowing.length === 0) return { allowed: [], projectId: null };
    const common = narrowing.reduce<string[]>((acc, { allowed }) => acc.filter((id) => allowed.includes(id)), narrowing[0]!.allowed);
    if (common.length > 0) return { allowed: common, projectId: null };
    const named = narrowing.map(({ id, allowed }) => `${projectName(id)}（${allowed.join('、')}）`).join('、');
    return { conflict: `没有能跑这个知识任务的机器：项目 ${named}允许的机器没有交集` };
  }
  const projectName = (id: string): string => db.get<{ name: string }>('SELECT name FROM project WHERE id = ?', id)?.name ?? id;

  // --- a project's code sources (docs/design/code-sources.md; shared/sources.ts) ------------

  // How the owner reads one source now, with the machine it names. A migration that could not
  // name the host's machine leaves the folder waiting for the owner to pick one.
  function sourceLabelFor(source: Source): string {
    if (source.kind === 'repo') return sourceLabel(source);
    if (source.machine_uid === PENDING_MACHINE_UID) return `待确认的机器上的 ${source.path}`;
    return sourceLabel(source, db.get<{ id: string }>('SELECT id FROM machine WHERE uid = ?', source.machine_uid)?.id);
  }

  function projectSourcesOf(projectId: string): Source[] {
    const row = db.get<{ sources_json: string }>('SELECT sources_json FROM project WHERE id = ?', projectId);
    if (!row) throw new InputError(`项目不存在：${projectId}`);
    return JSON.parse(row.sources_json) as Source[];
  }

  // The project page's list: every source in order, the first marked default, each with the one
  // label a page uses; and the sources whose machine is still to be confirmed, which the page
  // asks the owner to pick.
  function projectSourceViewsOf(projectId: string): { sources: SourceView[]; pending: string[] } {
    const sources = projectSourcesOf(projectId);
    return {
      sources: sources.map((source, index) => ({ ...source, default: index === 0, label: sourceLabelFor(source) })),
      pending: sources.flatMap((source) => (source.kind === 'folder' && source.machine_uid === PENDING_MACHINE_UID ? [source.id] : [])),
    };
  }

  // The console's list as the ledger holds it: the service names every new item with a ULID, so
  // a deleted id can never come back, and an item that carries one must be an id the project's
  // list already holds — that is how an existing item is moved, edited or removed, and anything
  // else is refused with the owner's words, never stored half-checked (shared/sources.ts
  // parseSources is the one shape rule; the machine each folder names must exist here).
  function parseSourceInput(input: unknown, existing: readonly Source[]): Source[] {
    const known = new Set(existing.map((source) => source.id));
    let named: unknown = input;
    if (Array.isArray(input)) {
      named = input.map((item, index) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
        const raw = (item as Record<string, unknown>).id;
        if (raw === undefined) return { ...(item as Record<string, unknown>), id: ulid() };
        if (typeof raw === 'string' && raw.trim() === '') return item;
        if (typeof raw === 'string' && known.has(raw.trim())) return item;
        if (typeof raw === 'string') throw new InputError(`第 ${index + 1} 个代码来源的编号不是这个项目现在的来源：删掉的编号不会再用，重新从项目页读一遍清单`);
        // Not a string: parseSources says what is wrong with the shape.
        return item;
      });
    }
    let sources: Source[];
    try {
      sources = parseSources(named);
    } catch (err) {
      throw new InputError(err instanceof Error ? err.message : String(err));
    }
    for (const source of sources) {
      if (source.kind !== 'folder') continue;
      if (!db.get('SELECT 1 FROM machine WHERE uid = ?', source.machine_uid)) {
        throw new InputError(`代码来源里的机器（登记号 ${source.machine_uid}）已经不是任何一台机器：它被删掉了，或者删掉后又有同名的机器重新接入。重新打开项目页再选`);
      }
    }
    return sources;
  }

  // What a Task is pinned to when it is made or moved: the source it names, null when the caller
  // explicitly asks for Tycho's default empty task directory, or the project's first source. When
  // sourceId is omitted and the Task targets a specific machine (via machine_id or a machine-local
  // login) while the project's default source is a folder on another machine, it falls back to
  // null (default empty task directory on the target machine) instead of conflicting.
  function pinSource(projectId: string | null, sourceId: string | null | undefined, targetMachineId?: string | null): TaskSource | null {
    if (projectId === null) {
      if (sourceId !== undefined && sourceId !== null) throw new InputError('这个任务不属于任何项目，没有代码来源');
      return null;
    }
    if (sourceId === null) return null;
    const sources = projectSourcesOf(projectId);
    if (sourceId === undefined) {
      const first = defaultSource(sources);
      if (first === null) return null;
      if (targetMachineId && first.kind === 'folder' && first.machine_uid !== PENDING_MACHINE_UID) {
        const target = currentMachine(targetMachineId);
        if (target !== undefined && first.machine_uid !== target.uid) return null;
      }
      return { source_id: first.id, pinned: first };
    }
    const chosen = sources.find((source) => source.id === sourceId);
    if (chosen === undefined) throw new InputError(`项目里没有这个代码来源：${sourceId}（用 get_project 看现在的清单）`);
    return { source_id: chosen.id, pinned: chosen };
  }

  function normalizeMachineId(machineId: string | null | undefined): string | null | undefined {
    if (machineId === undefined || machineId === null) return machineId;
    const trimmed = machineId.trim();
    if (trimmed === '') throw new InputError('目标机器不能为空字符串；取消固定请传 null');
    return trimmed;
  }

  function validatePlacement(
    taskScope: Pick<TaskRow, 'project_id' | 'knowledge_json'>,
    loginId: string | null,
    machineId: string | null,
    source: TaskSource | null,
  ): void {
    const login = currentLogin(loginId);
    const loginMachine = login?.machine ?? null;
    const folderMachine = source?.pinned.kind === 'folder' && source.pinned.machine_uid !== PENDING_MACHINE_UID
      ? db.get<{ id: string; uid: string }>('SELECT id, uid FROM machine WHERE uid = ?', source.pinned.machine_uid)
      : undefined;
    if (machineId !== null) {
      if (taskScope.project_id === null) throw new InputError('知识任务不能指定目标机器');
      const target = currentMachine(machineId);
      if (!target || target.leftAt !== undefined) {
        throw new InputError(`机器不存在或已注销：${machineId}（用 list_machines 看现在的清单）`);
      }
      if (folderMachine !== undefined && folderMachine.uid !== target.uid) {
        throw new InputError(`目标机器 ${target.id} 与代码来源 ${sourceLabelFor(source!.pinned)} 所在机器 ${folderMachine.id} 冲突；可传 source: null 使用目标机器默认任务目录，或取消指定机器`);
      }
      if (loginMachine !== null && loginMachine !== target.id) {
        throw new InputError(`登录 ${loginName(loginId)} 只能在机器 ${loginMachine} 上跑，与目标机器 ${target.id} 冲突；请取消指定登录或改用托管账号 / ${target.id} 上的登录`);
      }
      if (!(source?.pinned.kind === 'folder' && folderMachine?.uid === target.uid)) {
        const range = machineRange(taskScope);
        if ('conflict' in range) throw new InputError(range.conflict);
        if (!inRange(range.allowed, target.id) || (target.scope !== undefined && target.scope.project_id !== range.projectId)) {
          throw new InputError(`机器 ${target.id} 不在项目允许的机器范围内`);
        }
      }
    }
    if (folderMachine !== undefined && loginMachine !== null && folderMachine.id !== loginMachine) {
      throw new InputError(`登录 ${loginName(loginId)} 只能在机器 ${loginMachine} 上跑，与代码来源 ${sourceLabelFor(source!.pinned)} 所在机器 ${folderMachine.id} 冲突；可传 source: null 使用默认任务目录，或改用托管账号 / ${folderMachine.id} 上的登录`);
    }
  }

  function taskSourceOf(taskId: string): TaskSource | null {
    const row = db.get<{ source_json: string | null }>('SELECT source_json FROM task WHERE id = ?', taskId);
    if (!row) throw new InputError(`任务不存在：${taskId}`);
    return row.source_json === null ? null : (JSON.parse(row.source_json) as TaskSource);
  }

  function taskSourceStateOf(taskId: string): TaskSourceState | null {
    const row = db.get<{ project_id: string | null }>('SELECT project_id FROM task WHERE id = ?', taskId);
    if (!row) throw new InputError(`任务不存在：${taskId}`);
    if (row.project_id === null) return null;
    return taskSourceState(projectSourcesOf(row.project_id), taskSourceOf(taskId));
  }

  // The one projection of a Task's source for a page and the Router's tools (§8 of the fix
  // review): what it is pinned to, read the way the owner reads a source, and how the pin
  // stands against the project's list now (shared/sources.ts TaskSourceView, which the console
  // declares too). All null for a Task of a project with no source.
  function taskSourceViewOf(task: { id: string; source_json?: string | null }): TaskSourceView {
    if (task.source_json === null || task.source_json === undefined) return { source: null, source_state: null, source_label: null };
    const pinned = JSON.parse(task.source_json) as TaskSource;
    return { source: pinned, source_state: taskSourceStateOf(task.id), source_label: sourceLabelFor(pinned.pinned) };
  }

  // Why a Task pinned to a source may not run now, in the owner's words: the source is gone from
  // the project, or the migration left it waiting for a machine (§8.11). A source the owner
  // edited since (same id, another address or path) is not a reason to stop: the next round goes
  // on with the snapshot the Task was pinned to, and the page shows the pin has changed. A round
  // already running is not affected either way.
  function sourceRefusalOf(task: Pick<TaskRow, 'id' | 'project_id' | 'source_json'>): string | undefined {
    if (task.source_json === null || task.project_id === null) return undefined;
    const pinned = JSON.parse(task.source_json) as TaskSource;
    if (pinned.pinned.kind === 'folder' && pinned.pinned.machine_uid === PENDING_MACHINE_UID) {
      return `代码来源还在等主人选机器（${pinned.pinned.path}）：主人在项目页选好机器后，任务才能接着做`;
    }
    const sources = projectSourcesOf(task.project_id);
    if (taskSourceState(sources, pinned) !== 'removed') return undefined;
    return `钉住的代码来源已经不在项目里了（${sourceLabelFor(pinned.pinned)}）：负责人用 update_task 改派到别的来源，或者主人在项目页把它加回来`;
  }

  function readSetting<T>(key: string, fallback: T): T {
    const row = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', key);
    return row ? (JSON.parse(row.value_json) as T) : fallback;
  }

  // The owner's settings that steer what the ledger itself decides (how many lost rounds in a
  // row hold a Task, how long a login rests on a used-up quota, when to curate): this ledger
  // holds them, so it reads them here, in the transaction that applies them, by the settings'
  // own rule of what is in force.
  const tuned = <K extends SettingKey>(key: K): SettingValue<K> => inForce(readSetting<Record<string, unknown>>('tunables', {}), key);

  // The ledger's one judgement of "this work ended long enough ago for what it left on disk to
  // go" (docs/design/phase1-design.md "已结束的工作"): a Run belongs to the top-level work its
  // Task is under, that work's summary says when all of it ended, and the period is the
  // setting in force now. Both kinds of cleanup start from this list and add what only they
  // know — a registration on the host, a machine a code copy is on.
  function dueRunsOf(now: Date): { run: RunRow; ended_at: string; days: number }[] {
    const days = tuned('retention.endedDays');
    const cutoff = now.getTime() - days * DAY_MS;
    const tasks = db.all<Pick<TaskRow, 'id' | 'parent_id' | 'state' | 'closed_at' | 'project_id'>>('SELECT id, parent_id, state, closed_at, project_id FROM task');
    const summaries = workSummaries(tasks, db.all<{ task_id: string; state: string }>(`SELECT task_id, state FROM approval WHERE state = 'open'`));
    const parentOf = new Map(tasks.map((task) => [task.id, task.parent_id]));
    const roots = new Map<string, string>();
    const rootOf = (taskId: string): string => {
      const seen: string[] = [];
      let at = taskId;
      for (;;) {
        const known = roots.get(at);
        if (known !== undefined) {
          for (const each of seen) roots.set(each, known);
          return known;
        }
        seen.push(at);
        const parent = parentOf.get(at);
        if (parent === undefined || parent === null) {
          for (const each of seen) roots.set(each, at);
          return at;
        }
        at = parent;
      }
    };
    const due: { run: RunRow; ended_at: string; days: number }[] = [];
    const projectOf = new Map(tasks.map(({ id, project_id }) => [id, project_id]));
    for (const run of db.all<RunRow>('SELECT * FROM run')) {
      if (!db.mayWriteProject(projectOf.get(run.task_id) ?? null)) continue;
      const ended = summaries(rootOf(run.task_id)).ended_at;
      if (ended === null || Date.parse(ended) > cutoff) continue;
      due.push({ run, ended_at: ended, days });
    }
    return due;
  }

  // Whether an estimate is inside the reminder window the setting names now:
  // `accounts.expiryRemindDays` away or nearer, and an estimate already past stays inside it.
  // The one judgement of "in the reminder period" (docs/design/native-login.md §2), asked by
  // the scan that queues a notice and by the check that lets a queued one go out.
  const insideWindow = (expected: string, now: number): boolean =>
    now >= Date.parse(expected) - tuned('accounts.expiryRemindDays') * DAY_MS;

  // The account's expected expiry, from the two facts it rests on: the moment its token came
  // in, and the lifetime the executor declares. Read here because the ledger holds the
  // executors' declarations, so no caller has to be told them (and a caller that forgets
  // cannot make the scan silently do nothing).
  const expiryOf = (credentialAt: string, executor: string): string | null =>
    expectedExpiry(credentialAt, executors[executor]?.credentialLifetimeDays);

  // Whether a notice is about the credential the account holds now. The one fact a queued
  // first notice is let go on: the window was the scan's to apply when it queued it, and a
  // window narrowed since must not make that notice unreachable (see expiryWaiting for the
  // reminder that keeps being checked against the window).
  function expiryCredentialCurrent(payload: Record<string, any>): boolean {
    const row = db.get<{ credential_at: string | null }>('SELECT credential_at FROM account WHERE id = ?', payload.account_id);
    return row !== undefined && typeof payload.credential_at === 'string' && row.credential_at === payload.credential_at;
  }

  // Whether a login a notice was queued about is still one to remind about: the account holds
  // that very token, and its estimate, recomputed from the ledger's own row and the executor's
  // declaration now in force, is still inside the window the setting names now. Asked when the
  // reminder is queued and again as it goes out, the same way the other waiting notices are.
  function expiryWaiting(payload: Record<string, any>): boolean {
    if (!expiryCredentialCurrent(payload)) return false;
    const row = db.get<{ credential_at: string | null; executor: string }>('SELECT credential_at, executor FROM account WHERE id = ?', payload.account_id);
    if (!row || row.credential_at === null) return false;
    const expected = expiryOf(row.credential_at, row.executor);
    return expected !== null && insideWindow(expected, Date.now());
  }

  // The accounts whose token is expected to run out inside the setting's window, or already
  // has: what the self-check says and what the expiry scan pushes about. An account whose
  // token's moment is unknown, or whose executor declares no lifetime, is not here.
  function expiringAccountsOf(now: Date): ExpiringAccount[] {
    return db.all<Pick<AccountRow, 'id' | 'name' | 'executor' | 'credential_at'>>('SELECT id, name, executor, credential_at FROM account ORDER BY rowid')
      .flatMap((row): ExpiringAccount[] => {
        if (row.credential_at === null) return [];
        const expected = expiryOf(row.credential_at, row.executor);
        if (expected === null) return [];
        return [{ id: row.id, name: row.name, expected, credentialAt: row.credential_at, expired: now.getTime() >= Date.parse(expected) }];
      })
      .filter(({ expected }) => insideWindow(expected, now.getTime()));
  }

  function writeSetting(key: string, value: unknown): void {
    db.run(
      `INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      ulid(),
      nowIso(),
      key,
      JSON.stringify(value),
    );
  }

  function isPaused(): boolean {
    return readSetting('pause.user', false);
  }

  // A retired connection cannot establish that dispatch is safe.
  function dispatchConditions(): { paused: boolean | null; degraded: boolean; recovering: boolean; canDispatch: boolean } {
    const paused = db.isOpen ? isPaused() : null;
    const isDegraded = degraded.isActive();
    const recovering = options.recovery?.recovering() ?? false;
    return { paused, degraded: isDegraded, recovering, canDispatch: paused === false && !isDegraded && !recovering };
  }

  // For the owner's restore controls only: an inventory reads the mark and the pause
  // while it runs, and its own writes have to go on.
  function refuseDuringInventory(): void {
    if (options.recovery?.recovering()) throw new DegradedError('正在清点，稍后再试');
  }

  function restoreHeldTasks(): TaskRow[] {
    return db.all<TaskRow>(`${TASK_SELECT} WHERE task.state = 'held' AND task.reason = ? ORDER BY task.rowid`, RESTORE_HOLD_REASON);
  }

  // Task state comes before revision so that 'revision' always means a Task
  // still waiting on this Run. needs_verification is such a Task: it only left
  // running or stopping because the host went quiet, and whatever ends its Run has
  // to move it, or it would wait for a Run that no longer exists.
  function lateReason(run: RunRow, task: TaskRow): LateReason | undefined {
    if (run.state === 'ended') return 'run_ended';
    const settleable = task.state === 'running' || task.state === 'stopping' || task.state === 'needs_verification';
    if (!settleable) return 'task_state';
    if (run.task_revision !== task.revision) return 'revision';
    return undefined;
  }

  // Per Run: a poll that finds the same residue again must not repeat itself. A host
  // out of contact and a lost Run are not told this way: the rules handle both.
  function askToVerify(taskId: string, runId: string, finding: 'residue'): void {
    enqueueNotification(NOTICE_CHANNEL, 'verify', {
      external_id: `verify:${runId}:${finding}`,
      task_id: taskId,
      run_id: runId,
      finding,
    });
  }

  // How many rounds in a row, counting back from the latest, started and ended lost,
  // since the owner last let the Task go on: "继续" is the owner saying the cause was
  // dealt with. A round no machine took is not one, and does not end the row either.
  function lostInARow(taskId: string): number {
    const resumed = db.get<{ seq: number | null }>(
      `SELECT max(seq) AS seq FROM change WHERE task_id = ? AND action = 'task.resume'`,
      taskId,
    )?.seq ?? 0;
    const rounds = db.all<Pick<RunRow, 'exit_kind' | 'error_json'>>(
      `SELECT run.exit_kind, run.error_json FROM run
         JOIN change ON change.run_id = run.id AND change.action = 'run.create'
        WHERE run.task_id = ? AND run.state = 'ended' AND change.seq > ? ORDER BY run.rowid DESC`,
      taskId,
      resumed,
    );
    let lost = 0;
    for (const round of rounds) {
      // A round the quota ended is like one no machine took: not a loss, and no sign
      // that the losses around it have stopped.
      if (round.exit_kind === 'quota' || round.exit_kind === 'auth') continue;
      if (round.exit_kind !== 'lost') break;
      if (!neverStarted(round)) lost += 1;
    }
    return lost;
  }

  const lostLimit = (): number => tuned('run.maxLostContinuations');

  // §5.5: a lost Run sends its Task back to the queue in the transaction that ends it.
  // Three things stop that: a later round already on the instance, a restore nobody has
  // gone through yet, and losing every round in a row. Every way a Task goes on by
  // itself comes through here. A round no machine took goes back to wait for one,
  // whatever the count: nothing was lost.
  function afterLoss(task: TaskRow, basis: LostBasis, run?: RunRow): { state: 'queued' } | { state: 'held'; reason: string } {
    if (basis === 'superseded') return { state: 'held', reason: SUPERSEDED_REASON };
    if (readSetting<RestoreMark | null>('restore', null)) return { state: 'held', reason: RESTORE_HOLD_REASON };
    const lost = lostInARow(task.id);
    if (basis !== 'not_started' && lost >= lostLimit()) return { state: 'held', reason: `连续 ${lost} 次执行都丢失` };
    writeChange(db, 'task.continue', RUNNER, { taskId: task.id, ...(run ? { runId: run.id } : {}) }, {
      reason: LOST_TEXT[basis], basis, ...(run ? { run_id: run.id, host: run.host } : {}),
    });
    return { state: 'queued' };
  }

  // A Run ended on a used-up quota, so its login sits out: until the moment the
  // executor named, or for the setting's length when it named none. A Run created after
  // the last rest began was a try that failed, and each such try doubles the wait, up to
  // the setting's ceiling; the executor's moment is taken at its word once, and after a
  // failed try only when it is later than that wait. A Run that was already going when
  // the rest began ran into the same used-up quota: it lengthens nothing but may keep
  // the login out longer. Returns when the rest ends, or nothing for a login that is gone.
  function restLogin(run: RunRow, quota: NonNullable<SettleOptions['quota']>): string | undefined {
    if (run.login_id === null || !loginExists(run.login_id)) return undefined;
    if (runCredentialRef(run) !== credentialRefOf(run.login_id) || (JSON.parse(run.snapshot_json).quota_generation ?? null) !== quotaGeneration(run.login_id)) return undefined;
    const seq = (sql: string, ...params: string[]): number => db.get<{ seq: number | null }>(sql, ...params)?.seq ?? 0;
    return restLoginFor(run.login_id, quota, (state) => state.rest_seq === null
      || seq(`SELECT max(seq) AS seq FROM change WHERE run_id = ? AND action = 'run.create'`, run.id) > state.rest_seq);
  }
  // The rest itself, one computation for a Worker's round and for a Router's turn: `tried` says
  // whether this use was a try made after the last rest began.
  function restLoginFor(loginId: string, quota: NonNullable<SettleOptions['quota']>, triedOf: (state: LoginStateRow, now: number) => boolean): string {
    // A login resting, refused or read again is on the usage and accounts pages.
    db.noteNews();
    const at = nowIso();
    const now = Date.parse(at);
    db.run('INSERT INTO login_state (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', loginId, at);
    const state = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId)!;
    const seq = (sql: string): number => db.get<{ seq: number | null }>(sql)?.seq ?? 0;
    const tried = triedOf(state, now);
    const streak = tried ? state.rest_streak + 1 : Math.max(state.rest_streak, 1);
    const base = tuned('quota.restMs');
    const waited = now + Math.min(base * 2 ** (streak - 1), Math.max(base, tuned('quota.maxRestMs')));
    const said = quota.resetsAt === undefined ? NaN : Date.parse(quota.resetsAt);
    const stated = said > now ? said : undefined;
    const until = Math.max(
      stated !== undefined && streak === 1 ? stated : Math.max(stated ?? 0, waited),
      state.rest_until === null ? 0 : Date.parse(state.rest_until),
    );
    db.run(
      'UPDATE login_state SET rest_seq = ?, rest_until = ?, rest_streak = ?, rest_reason = ? WHERE id = ?',
      tried ? seq('SELECT max(seq) AS seq FROM change') : state.rest_seq, new Date(until).toISOString(), streak, quota.message.slice(0, MAX_REST_REASON_CHARS), loginId,
    );
    return new Date(until).toISOString();
  }
  function restLoginBriefly(run: RunRow, message: string, durationMs = 60_000): string | undefined {
    if (run.login_id === null || !loginExists(run.login_id)) return undefined;
    if (runCredentialRef(run) !== credentialRefOf(run.login_id) || (JSON.parse(run.snapshot_json).quota_generation ?? null) !== quotaGeneration(run.login_id)) return undefined;
    db.noteNews();
    const at = nowIso();
    const now = Date.parse(at);
    db.run('INSERT INTO login_state (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', run.login_id, at);
    const state = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', run.login_id)!;
    const until = Math.max(now + durationMs, state.rest_until === null ? 0 : Date.parse(state.rest_until));
    const untilIso = new Date(until).toISOString();
    db.run(
      'UPDATE login_state SET rest_until = ?, rest_reason = ? WHERE id = ?',
      untilIso,
      message.slice(0, MAX_REST_REASON_CHARS),
      run.login_id,
    );
    return untilIso;
  }

  // A rejection belongs to the number the Run used, not to the account as such. A result
  // from a number the owner has since replaced or cleared only ends its own Run: it
  // cannot speak for the token the account uses now, and it tells nobody. One number is
  // refused once, so two rounds failing on the same token share a notice.
  // The last of an ephemeral machine's four endings: its instance is gone, said by the round
  // that destroyed it. Written once; a later report of the same machine changes nothing.
  function noteDestroyed(id: string, byRunId: string, ctx: Ctx): void {
    const machine = currentMachine(id);
    if (!machine) throw new InputError('机器不存在：' + id);
    if (!machine.ephemeral) throw new InputError(`机器 ${id} 不是临时机器：它的实例不归 tycho 的任务管`);
    if (machine.destroyedAt !== undefined) return;
    const at = nowIso();
    db.run('UPDATE machine SET destroyed_at = ?, destroyed_by = ?, updated_at = ? WHERE id = ?', at, byRunId, at, id);
    writeChange(db, 'machine.destroyed', ctx, { runId: byRunId }, { machine_id: id, at });
  }

  // An ephemeral machine's registration ends: the token is void from this write, and no
  // new work goes to it (a drain that was not written yet is written now, at the same
  // moment). The row stays, carrying its endings: gone from the registry says nothing about
  // the instance (§1.3).
  const LEAVE_ACTIONS: Record<MachineLeftReason, string> = { leave: 'machine.leave', revoked: 'machine.revoke', destroyed: 'machine.leave_destroyed' };
  function endRegistration(machine: MachineRecord, reason: MachineLeftReason, ctx: Ctx, detail: Record<string, unknown> = {}): void {
    if (machine.leftAt !== undefined) return;
    const at = nowIso();
    db.run('UPDATE machine SET token_hash = NULL, left_at = ?, left_reason = ?, drain_at = COALESCE(drain_at, ?), updated_at = ? WHERE id = ?', at, reason, at, at, machine.id);
    writeChange(db, LEAVE_ACTIONS[reason], ctx, {}, { machine_id: machine.id, at, ...detail });
  }

  function rejectCredentialRef(loginId: string, ref: string): void {
    db.noteNews();
    if (credentialRefOf(loginId) !== ref) return;
    const at = nowIso();
    db.run('INSERT INTO login_state (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', loginId, at);
    const state = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId)!;
    if (state.credential_rejected_ref === ref) return;
    db.run('UPDATE login_state SET credential_rejected_ref = ? WHERE id = ?', ref, loginId);
    enqueueNotification(NOTICE_CHANNEL, 'account_credential_rejected', {
      external_id: `account-credential:${ref}`, account_id: loginId, account_name: currentLogin(loginId)!.name, ref,
    });
  }

  // The executor refused the login a round ran as. An account's mark names the token it
  // refused; a machine's own login is marked at this moment, and the owner told once.
  function refuseLogin(run: RunRow): void {
    db.noteNews();
    if (run.login_id === null || !currentLogin(run.login_id)) return;
    if ((JSON.parse(run.snapshot_json).quota_generation ?? null) !== quotaGeneration(run.login_id)) return;
    if (currentLogin(run.login_id)!.machine === undefined) {
      const ref = runCredentialRef(run);
      if (ref !== null) {
        if (ref.startsWith('oauth-') && options.onOAuthLeaseAuthFailure) {
          const at = nowIso();
          const until = new Date(Date.parse(at) + 15_000).toISOString();
          db.run('INSERT INTO login_state (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', run.login_id, at);
          const state = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', run.login_id)!;
          if (state.rest_until === null || Date.parse(state.rest_until) < Date.parse(until)) {
            const seq = db.get<{ seq: number | null }>('SELECT max(seq) AS seq FROM change')?.seq ?? 0;
            db.run('UPDATE login_state SET rest_seq = ?, rest_until = ?, rest_reason = ? WHERE id = ?', seq, until, '正在向授权服务端核对并续期登录令牌', run.login_id);
          }
          const loginId = run.login_id;
          queueMicrotask(() => options.onOAuthLeaseAuthFailure!(loginId, ref));
          return;
        }
        rejectCredentialRef(run.login_id, ref);
      }
      return;
    }
    const at = nowIso();
    db.run('INSERT INTO login_state (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', run.login_id, at);
    const state = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', run.login_id)!;
    if (state.auth_failed_at !== null) return;
    db.run('UPDATE login_state SET auth_failed_at = ? WHERE id = ?', at, run.login_id);
    enqueueNotification(NOTICE_CHANNEL, 'machine_login_refused', { external_id: `machine-login-refused:${run.login_id}:${at}`, login_id: run.login_id, login_name: run.login_name, at });
  }

  // The Task of a Run the quota ended goes back to the queue in the transaction that ends
  // the Run, as after a loss, and the next round picks its login again. Nothing is
  // counted: the quota comes back by itself. Only a restore nobody has gone through stops it.
  function afterQuota(task: TaskRow, run: RunRow, restUntil: string | undefined, kind: 'quota' | 'auth'): { state: 'queued' } | { state: 'held'; reason: string } {
    if (readSetting<RestoreMark | null>('restore', null)) return { state: 'held', reason: RESTORE_HOLD_REASON };
    writeChange(db, 'task.continue', RUNNER, { taskId: task.id, runId: run.id }, {
      reason: kind === 'auth' ? authReason(run.login_id) : QUOTA_REASON, basis: kind, run_id: run.id, host: run.host, login_id: run.login_id,
      ...(restUntil ? { rest_until: restUntil } : {}),
    });
    return { state: 'queued' };
  }

  // Consumed by the Session Host. Written with the state change it reports, so
  // a crash cannot lose it: change is audit only and is never replayed. It goes to the
  // Router of the project the Task belongs to (docs/design/project-sessions.md §3); a Task of
  // no project (a knowledge Task) has no Router to tell, and the row is kept as not delivered.
  // `quiet`: a fact the Router has nothing to do about. It is kept as a record but not queued,
  // like the row of a Task of no project; the caller decides that from what it already knows,
  // never from the summary's wording.
  function tellRouter(
    externalId: string,
    actor: string,
    summary: string,
    detail: { task_id: string; [key: string]: unknown },
    options: { quiet?: boolean } = {},
  ): string {
    const at = nowIso();
    const id = ulid();
    const projectId = db.get<{ project_id: string | null }>('SELECT project_id FROM task WHERE id = ?', detail.task_id)?.project_id ?? null;
    const run = typeof detail.run_id === 'string' ? loadRun(detail.run_id) : undefined;
    const names = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(names);
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key,
        (key === 'login_id' || key === 'account_id') && typeof field === 'string'
          ? currentLogin(field)?.name ?? (field === run?.login_id ? run.login_name : null) ?? '已删除的登录'
          : names(field),
      ]));
    };
    db.run(
      `INSERT INTO message (id, created_at, channel, external_id, direction, actor, text, state, at, project_id, basis, task_id)
       VALUES (?, ?, 'internal', ?, 'in', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      at,
      externalId,
      actor,
      `${summary}\n${JSON.stringify(names(detail))}`,
      projectId === null || options.quiet === true ? 'ignored' : 'received',
      at,
      projectId,
      projectId === null ? null : 'object',
      detail.task_id,
    );
    return id;
  }

  // One internal event (shared/internal-events.ts), inside the transaction of the transition that
  // made it (docs/design/triggers.md §2.3): the owner's push, when the push table has its kind, and
  // the subscriptions of its Task's project. `from`: the Task whose work brought it about, when not
  // the event's own (the round that made a work ready); the first trigger occurrence on it or above
  // it is the event's origin, and an event with one sets nothing off (§4). `attachTo`: the message
  // it already goes to the Router by. `push: false`: another result of the same transition tells
  // the owner, so this event only reaches the subscriptions.
  function internalEvent(event: InternalEvent, options: { from?: string; attachTo?: string; push?: boolean } = {}): boolean {
    if (options.push !== false && PUSH_LEVELS[event.kind] !== undefined) enqueueNotification(NOTICE_CHANNEL, event.kind, { external_id: event.id, ...event.data });
    if (event.task_id === null) return false;
    const chain = (id: string): TaskRow[] => {
      const rows = [loadTask(id)];
      while (rows.at(-1)!.parent_id) rows.push(loadTask(rows.at(-1)!.parent_id!));
      return rows;
    };
    const own = chain(event.task_id);
    const projectId = own[0]!.project_id;
    if (projectId === null) return false;
    const origin = chain(options.from ?? event.task_id).find((row) => row.trigger_fire_id !== null)?.trigger_fire_id ?? null;
    return triggers.offerEvent(event, { projectId, tasks: own.map((row) => row.id), origin, ...(options.attachTo === undefined ? {} : { attachTo: options.attachTo }) }).length > 0;
  }

  // The one way a Task's work is recorded as going into the main line, whether the service put the
  // registered bundle there itself or a merge round merged the pull request: one audit line on the
  // Task the work belongs to, one `merged` event for triggers, and one result for the owner. The
  // merged event's own push is not queued: the integrated result is the owner's, so one fact is
  // told once. Inside a write.
  function noteIntegrated(refs: { taskId: string; runId?: string }, detail: { branch: string | null; commit: string | null } & Record<string, unknown>, ctx: Ctx): void {
    const branch = detail.branch ?? null;
    const commit = detail.commit ?? null;
    writeChange(db, 'task.integrate', ctx, refs, detail);
    internalEvent(internalEvents.merged(refs.taskId, branch, commit, nowIso()), { push: false });
    enqueueNotification(NOTICE_CHANNEL, 'integrated', {
      external_id: `task.integrate:${refs.taskId}:${commit ?? nowIso()}`,
      task_id: refs.taskId, branch, commit,
    });
  }

  // Direct ready notice when on_ready === 'notify_owner', owner is reachable, and the task
  // settled cleanly to ready.
  function mayNotifyReadyDirectly(task: TaskRow, receipt: Receipt | null): boolean {
    const ownerReachable = (channels.has(NOTICE_CHANNEL) && !!tuned('wecom.owner'))
      || (options.noticeTargets?.() ?? []).some(({ channel }) => channels.has(channel));
    if (!tuned('router.directReadyNotice') || !ownerReachable || !tuned('http.publicUrl')) return false;
    if (task.project_id === null || receipt?.status !== 'done') return false;
    const creation = db.get<{ on_ready: string | null }>(
      `SELECT json_extract(detail_json, '$.on_ready') AS on_ready FROM change WHERE task_id = ? AND action = 'task.create' LIMIT 1`, task.id,
    );
    return creation?.on_ready === 'notify_owner';
  }

  function reportSettlement(
    externalId: string,
    run: RunRow,
    result: {
      exit_code: number | null;
      exit_kind: ExitKind | null;
      receipt: Receipt | null;
      late_reason?: LateReason;
      residue?: boolean;
      work_became_ready?: boolean;
      lost?: SettleOptions['lost'];
      quota?: unknown;
      // A read-only round whose result was not taken for its code check, and why.
      refused?: string;
    },
  ): string {
    const task = loadTask(run.task_id);
    const summary = result.late_reason
      ? `任务“${task.title}”的 Run 迟到结算，结果没有推进任务`
      : result.refused !== undefined && task.state === 'queued'
        ? `任务“${task.title}”只读的这一轮没有采用（${result.refused}），已自动重派一次，开新会话，不需要处理`
      : result.exit_kind === 'auth' && task.state === 'queued'
        ? `任务“${task.title}”的一轮执行因为${loginName(run.login_id, run.login_name)} 的登录失效而结束，已自动重新排队，${ACCOUNT_LOGIN_FIX}、或换到别的登录后接续`
      : result.exit_kind === 'quota' && task.state === 'queued'
        ? `任务“${task.title}”的一轮执行因为${loginName(run.login_id, run.login_name)} 的额度用完而结束，已自动重新排队，额度恢复或换到别的登录后接续，不需要处理`
      : result.lost?.basis === 'not_started' && task.state === 'queued'
        ? `任务“${task.title}”这一轮没有机器接下，没有启动，已回到队列等可用的机器，不需要处理`
      : result.exit_kind === 'lost' && task.state === 'queued'
        ? `任务“${task.title}”的一轮执行丢失（${LOST_TEXT[result.lost?.basis ?? 'seen']}），已自动重新排队接续，不需要处理`
        : `任务“${task.title}”的 Run 已结算，任务转为 ${taskStateLabels[task.state]}`;
    const note = result.residue ? '。Worker 结束后仍有后台进程，已清理' : '';
    // The Task is back in the queue and the next round takes it by itself: the quota comes
    // back, a lost round is continued, a read-only round whose code was not adopted is sent
    // again once. None of these is the Router's to act on, so the row is only a record.
    // A refused login is not one of them: it waits for the owner.
    const quiet = task.state === 'queued'
      && (result.exit_kind === 'quota' || result.exit_kind === 'lost' || result.refused !== undefined);
    return tellRouter(externalId, RUNNER.actor, `${summary}${note}`, {
      task_id: task.id,
      run_id: run.id,
      task_state: task.state,
      task_reason: task.reason,
      ...result,
    }, { quiet });
  }

  const { scanSchedules, originOf, ...triggerApi } = triggers;

  // Every row a project's deletion takes, named by one subquery each: the counts the
  // confirmation shows, the audit line and the DELETE statements all read these, so what the
  // page says would go and what goes cannot come apart (project-sessions, "项目的生命周期").
  // front_desk is a pointer, not a record: a choice of the chat's current project goes with the
  // project and is not counted.
  //
  // Every column of this schema that can name a project, Task, Run or message was walked
  // (pragma_foreign_key_list of a ledger this program writes, plus the columns that name a row
  // by value), so that a table added later has an answer here to be measured against:
  //   project — task, run (through its Task), message, router_segment, router_context,
  //     trigger_rule, trigger_fire, push, front_desk, machine_invite: all deleted with it.
  //     router_call cascades with the project or message; kept change rows lose its reference.
  //   task — run, approval, input, machine_invite (its project_id is the Task's own), and the
  //     naming columns of task.parent_id, approval.review_task_id, message.task_id, change.task_id,
  //     input.task_id, knowledge_proposal.task_id / gate_task_id, knowledge_evidence.ref and a
  //     Task's review binding: deleted or unpinned, never left naming a gone row.
  //   run — usage (the row of use stays, with its unit and its duration: keepDroppedRuns),
  //     approval, change, input, knowledge_proposal, knowledge_evidence: unpinned.
  //   message — input, change, trigger_fire: unpinned, its segment too.
  // Columns naming a row by value are on that walk as well: a Task's parent (task.parent_id),
  // its review binding (review_of_json), its role, its reviewed tier and its prefer list — the
  // last names logins, which no project deletion takes. A JSON list is read where the object that
  // owns it is known: a kept knowledge entry's scope in deletionKnowledge, an inbound source's in
  // deletionPlan. Both keep the row and take the project off the list.
  //
  // Walked again for version 39, with the steps origin/main spent on versions 37 and 38 in place:
  // 37 is the operate tier, which moves the preset verify role's default tier and adds nothing
  // this walk reads; 38 is the archived project's own deletion, which these queries are. 39 is the
  // inbound step: it adds inbound_source, a column naming a project by value and answered above,
  // and it drops trigger_key, whose rows this walk used to take with their rule — with the table
  // gone there is nothing left to take.
  const DELETION_QUERIES = (() => {
    const tasks = 'SELECT id FROM task WHERE project_id = ?1';
    return {
      tasks,
      runs: `SELECT id FROM run WHERE task_id IN (${tasks})`,
      // A project's own messages, and those about no project that one of its Tasks carries: an
      // internal event about this project's work goes with the work.
      messages: `SELECT id FROM message WHERE project_id = ?1 OR (project_id IS NULL AND task_id IN (${tasks}))`,
      segments: 'SELECT id FROM router_segment WHERE project_id = ?1',
      contexts: 'SELECT id FROM router_context WHERE project_id = ?1',
      triggers: 'SELECT id FROM trigger_rule WHERE project_id = ?1',
      fires: 'SELECT id FROM trigger_fire WHERE project_id = ?1',
      pushes: 'SELECT id FROM push WHERE project_id = ?1',
      approvals: `SELECT id FROM approval WHERE task_id IN (${tasks})`,
      invites: 'SELECT id FROM machine_invite WHERE project_id = ?1',
      files: 'SELECT id FROM project_file WHERE project_id = ?1',
    };
  })();
  const DELETION_UNITS: Record<keyof typeof DELETION_QUERIES, { label: string; unit: string }> = {
    tasks: { label: '工作', unit: '项' }, runs: { label: '轮次', unit: '轮' }, messages: { label: '消息', unit: '条' },
    segments: { label: '对话', unit: '段' }, contexts: { label: '执行器上下文', unit: '个' }, triggers: { label: '触发器', unit: '个' },
    fires: { label: '触发记录', unit: '条' }, pushes: { label: '推送', unit: '条' }, approvals: { label: '审批卡', unit: '张' },
    invites: { label: '机器接入邀请', unit: '份' },
    files: { label: '文件', unit: '个' },
  };

  // A knowledge entry whose current scope is only this project goes with it. One that also
  // belongs elsewhere stays, and every revision loses this project from its list: an array that
  // becomes empty applies nowhere, which is not a dangling id. A proposal whose every output is
  // scoped to this project alone is this project's; one that only retires or replaces is this
  // project's when every entry it pins is one this deletion takes. One a surviving entry's
  // revision was published by is kept: deleting it would break that entry's history, and history
  // is not this deletion's to take.
  function deletionKnowledge(projectId: string): {
    deletedEntries: Set<string>;
    keptEntries: Set<string>;
    deletedProposals: Set<string>;
    keptProposals: Set<string>;
  } {
    const scoped = db.all<{ id: string; projects_json: string }>(
      `SELECT knowledge.id, knowledge_revision.projects_json
         FROM knowledge JOIN knowledge_revision ON knowledge_revision.knowledge_id = knowledge.id AND knowledge_revision.revision = knowledge.revision
        WHERE knowledge_revision.projects_json IS NOT NULL`,
    );
    const deletedEntries = new Set<string>();
    const keptEntries = new Set<string>();
    for (const { id, projects_json: projects } of scoped) {
      const list = JSON.parse(projects) as string[];
      if (!list.includes(projectId)) continue;
      if (list.every((each) => each === projectId)) deletedEntries.add(id);
      else keptEntries.add(id);
    }
    const surviving = db.all<{ id: string }>('SELECT id FROM knowledge').map(({ id }) => id).filter((id) => !deletedEntries.has(id));
    const referencedBySurviving = new Set<string>();
    if (surviving.length > 0) {
      const marks = surviving.map(() => '?').join(', ');
      for (const { proposal_id: id } of db.all<{ proposal_id: string }>(
        `SELECT DISTINCT proposal_id FROM knowledge_revision WHERE knowledge_id IN (${marks})`, ...surviving,
      )) referencedBySurviving.add(id);
    }
    const namesProject = (json: string | null): boolean => {
      if (json === null) return false;
      const outputs = (JSON.parse(json) as { outputs?: { project_ids: string[] | null }[] }).outputs ?? [];
      return outputs.some(({ project_ids }) => (project_ids ?? []).includes(projectId));
    };
    const deletedProposals = new Set<string>();
    const keptProposals = new Set<string>();
    for (const row of db.all<{ id: string; change_json: string; final_json: string | null }>(
      'SELECT id, change_json, final_json FROM knowledge_proposal',
    )) {
      if (namesProject(row.change_json) || namesProject(row.final_json)) keptProposals.add(row.id);
      if (referencedBySurviving.has(row.id)) continue;
      const change = JSON.parse(row.final_json ?? row.change_json) as {
        inputs?: { knowledge_id: string }[];
        outputs?: { project_ids: string[] | null }[];
      };
      const outputs = change.outputs ?? [];
      if (outputs.length === 0) {
        const inputs = change.inputs ?? [];
        if (inputs.length > 0 && inputs.every(({ knowledge_id: id }) => deletedEntries.has(id))) deletedProposals.add(row.id);
        continue;
      }
      if (outputs.some(({ project_ids }) => project_ids === null)) continue;
      const named = new Set(outputs.flatMap(({ project_ids }) => project_ids ?? []));
      if (named.size === 0 || [...named].some((each) => each !== projectId)) continue;
      deletedProposals.add(row.id);
    }
    // A proposal that goes is not a scope this project is merely taken out of.
    for (const id of deletedProposals) keptProposals.delete(id);
    return { deletedEntries, keptEntries, deletedProposals, keptProposals };
  }

  // What deleting a project takes, keeps with a narrower scope, and gives up: one set behind the
  // confirmation, the audit and the transaction. Read once per question and again inside the
  // deletion's own transaction, so a deletion decided on a stale answer is refused, not applied.
  function deletionPlan(projectId: string) {
    const project = db.get<{ id: string; name: string; archived_at: string | null }>('SELECT id, name, archived_at FROM project WHERE id = ?', projectId);
    if (!project) throw new InputError(`项目不存在：${projectId}`);
    const queries = DELETION_QUERIES;
    const sets = deletionKnowledge(projectId);
    // A tycho-wide inbound source is not a project's: it belongs to whoever calls, its keys live
    // on, and a deleted project is not its to lose. One that lets this project through keeps its
    // row and loses the project from its list, as a kept knowledge entry loses it from its scope.
    // A list this empties lets nothing through and stays as it is, shown as it is.
    const sources = db.all<{ id: string; projects_json: string }>('SELECT id, projects_json FROM inbound_source')
      .map(({ id, projects_json: projects }) => ({ id, project_ids: JSON.parse(projects) as string[] }))
      .filter(({ project_ids: projects }) => projects.includes(projectId));
    return {
      project,
      queries,
      sets,
      sources,
      swept: knowledge.knowledgeTasksSweptBy([...sets.deletedEntries], [...sets.deletedProposals]),
    };
  }

  // Whether a project may be deleted, why not when it may not, and what would go with it: the
  // one answer the ledger, the console's view and the confirmation all read (project-sessions,
  // "项目的生命周期"). A project with no record can go at any time; one with history has to be
  // archived and have no round still running, no Router process that may still be alive, and no
  // knowledge task of its own under way — a gate or curation it would leave pointless is waited
  // for, since ending it mid-round would lose the round's own records.
  function deletionOf(plan: ReturnType<typeof deletionPlan>): ProjectDeletion {
    const counts: DeletionCount[] = [];
    for (const key of Object.keys(DELETION_UNITS) as (keyof typeof DELETION_UNITS)[]) {
      const n = db.get<{ n: number }>(`SELECT count(*) AS n FROM (${plan.queries[key]})`, plan.project.id)!.n;
      if (n > 0) counts.push({ ...DELETION_UNITS[key], count: n });
    }
    if (plan.sets.deletedEntries.size > 0) counts.push({ label: '知识', count: plan.sets.deletedEntries.size, unit: '条' });
    if (plan.sets.deletedProposals.size > 0) counts.push({ label: '知识提议', count: plan.sets.deletedProposals.size, unit: '份' });
    const scope_removed: DeletionCount[] = [];
    if (plan.sets.keptEntries.size > 0) scope_removed.push({ label: '知识', count: plan.sets.keptEntries.size, unit: '条' });
    if (plan.sets.keptProposals.size > 0) scope_removed.push({ label: '知识提议', count: plan.sets.keptProposals.size, unit: '份' });
    if (plan.sources.length > 0) scope_removed.push({ label: '入站来源', count: plan.sources.length, unit: '个' });
    // The knowledge tasks the deletion leaves pointless, said as the three different things that
    // happen to them: the unfinished ones that lose everything they work on are given up, the
    // ones that keep something shrink and stay queued, and the ones already over only lose the
    // reference to a row that goes. One plan, three answers (project-sessions, "项目的生命周期").
    const gone = (task: { entries: string[] | null }): boolean => task.entries === null || task.entries.length === 0;
    const tasks = (only: (task: SweptKnowledgeTask) => boolean): DeletionCount[] => {
      const count = plan.swept.filter(only).length;
      return count === 0 ? [] : [{ label: '知识把关/整理任务', count, unit: '个' }];
    };
    const canceled = tasks((task) => !task.ended && gone(task));
    const reduced = tasks((task) => !task.ended && !gone(task));
    const finished = tasks((task) => task.ended);
    if (counts.length === 0 && scope_removed.length === 0 && canceled.length === 0 && reduced.length === 0 && finished.length === 0) {
      return { allowed: true, reason: null, counts, scope_removed, canceled, reduced, finished };
    }
    if (plan.project.archived_at === null) return { allowed: false, reason: '先归档才能删除', counts, scope_removed, canceled, reduced, finished };
    const active = db.get<{ n: number }>(
      `SELECT count(*) AS n FROM run JOIN task ON task.id = run.task_id WHERE task.project_id = ? AND run.state != 'ended'`,
      plan.project.id,
    )!.n;
    if (active > 0) return { allowed: false, reason: `还有 ${active} 轮在跑，等它们结束`, counts, scope_removed, canceled, reduced, finished };
    const live = db.get<{ n: number }>('SELECT count(*) AS n FROM router_context WHERE project_id = ? AND live_at IS NOT NULL', plan.project.id)!.n;
    if (live > 0) return { allowed: false, reason: '负责人还在处理，等它空闲退出后再删', counts, scope_removed, canceled, reduced, finished };
    const running = plan.swept.filter(({ running: busy }) => busy).length;
    if (running > 0) return { allowed: false, reason: `还有 ${running} 个知识把关或整理任务在跑，等它们结束`, counts, scope_removed, canceled, reduced, finished };
    return { allowed: true, reason: null, counts, scope_removed, canceled, reduced, finished };
  }

  // Deletes an archived project that left history, and everything that belongs only to it
  // (project-sessions, "项目的生命周期"). The rows that point at it from other projects are
  // unpinned, never deleted; global knowledge keeps its evidence, with the deleted project's
  // Task or Run named in words. What the project left on disk is kept as work_cleanup rows:
  // their Run rows are gone, so they name the round and machine by value, and the acceptor
  // and the retention pass can still finish the removal afterwards.
  function deleteProjectRows(projectId: string, confirmName: string | undefined, ctx: Ctx): void {
    write(() => {
      const plan = deletionPlan(projectId);
      const project = plan.project;
      if (confirmName !== undefined && confirmName !== '' && project.name !== confirmName) {
        throw new InputError(`确认删除要把项目名写全：${project.name}`);
      }
      const deletion = deletionOf(plan);
      if (!deletion.allowed) throw new InputError(deletion.reason!);
      const at = nowIso();
      const marks = (ids: readonly string[]): string => ids.map(() => '?').join(', ');
      const idsOf = (sql: string): string[] => db.all<{ id: string }>(sql, projectId).map(({ id }) => id);
      const taskIds = idsOf(plan.queries.tasks);
      const runIds = idsOf(plan.queries.runs);
      // Read before anything is unlinked: the messages this deletion takes are the project's own
      // and those about no project that one of its Tasks carries.
      const messageIds = idsOf(plan.queries.messages);
      const segmentIds = idsOf(plan.queries.segments);
      const contextIds = idsOf(plan.queries.contexts);
      const triggerIds = idsOf(plan.queries.triggers);
      const fireIds = idsOf(plan.queries.fires);
      const inviteIds = idsOf(plan.queries.invites);
      const deletedKnowledge = plan.sets.deletedEntries;
      const deletedProposals = plan.sets.deletedProposals;

      // What the deleted rows leave on disk, written before the rows go: a round's registered
      // directories on the host, and the Task's code copy on the machine it ran on. A part
      // already cleared is marked here; the rest is the cleanup's to finish.
      for (const run of runIds.length === 0 ? [] : db.all<RunRow>(`SELECT * FROM run WHERE id IN (${marks(runIds)})`, ...runIds)) {
        const held = run.artifacts_json === null ? null : (JSON.parse(run.artifacts_json) as RoundArtifacts);
        const registrations = [...new Set([...(held?.registered ?? []), ...(held?.registration === null || held?.registration === undefined ? [] : [held.registration.id])])]
          .filter((id): id is string => typeof id === 'string' && nameIsSafe(id));
        const hostPart = registrations.length > 0;
        const codePart = run.machine_id !== null && run.node_id !== null && run.code_dropped_at === null;
        const outputReleases:Array<{source?:string;legacy?:true;machine_id:string;node_id:string;machine_uid:string;reason:string}>=[];
        if(run.machine_id&&run.node_id){const capture=captureOf(run);outputReleases.push({...(capture?{source:capture.source}:{legacy:true as const}),machine_id:run.machine_id,node_id:run.node_id,machine_uid:(JSON.parse(run.snapshot_json) as {machine_uid:string}).machine_uid,reason:'project_deleted_not_adopted'});}
        for(const row of db.all<{detail_json:string}>("SELECT detail_json FROM change WHERE run_id=? AND action='run.capture_release'",run.id)){const detail=JSON.parse(row.detail_json);if(typeof detail.source==='string'&&typeof detail.machine_id==='string'&&typeof detail.node_id==='string')outputReleases.push({source:detail.source,machine_id:detail.machine_id,node_id:detail.node_id,machine_uid:detail.machine_uid,reason:'rehosted_before_start'});}
        if (!hostPart && !codePart && !outputReleases.length) continue;
        db.run(
          `INSERT INTO work_cleanup (id, created_at, project_id, project_name, run_id, task_id, machine_id, node_id,
             releases_json, releases_dropped_at, code_dropped_at,output_release_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?)`,
          ulid(), at, projectId, project.name, run.id, run.task_id, run.machine_id, run.node_id,
          JSON.stringify(registrations), hostPart ? null : at, codePart ? null : at,outputReleases.length?JSON.stringify(outputReleases):null,
        );
      }

      // What elsewhere points at a row that is about to go: unpinned, so no reference is left
      // naming something the ledger no longer holds. A kept review binding or approval is a
      // row of another Task's, and this project's deletion is not the place to take it.
      if (taskIds.length > 0) {
        db.run(`UPDATE task SET parent_id = NULL WHERE parent_id IN (${marks(taskIds)}) AND (project_id IS NULL OR project_id != ?)`, ...taskIds, projectId);
        db.run(`UPDATE approval SET review_task_id = NULL WHERE review_task_id IN (${marks(taskIds)})`, ...taskIds);
        db.run(`UPDATE message SET task_id = NULL WHERE task_id IN (${marks(taskIds)})`, ...taskIds);
        db.run(`UPDATE change SET task_id = NULL WHERE task_id IN (${marks(taskIds)})`, ...taskIds);
        db.run(`UPDATE knowledge_proposal SET task_id = NULL WHERE task_id IN (${marks(taskIds)})`, ...taskIds);
        db.run(`UPDATE knowledge_proposal SET gate_task_id = NULL WHERE gate_task_id IN (${marks(taskIds)})`, ...taskIds);
        db.run(`UPDATE knowledge_evidence SET ref = ? WHERE source = 'task' AND ref IN (${marks(taskIds)})`, `来自已删除的项目 ${project.name}`, ...taskIds);
      }
      // `input` is not in that list: its task_id is NOT NULL, so an input of a Task that goes is
      // deleted with it (below), and an input of a kept Task only loses the round or message it
      // came from. A round of this project that a kept Task's input names is unpinned here.
      if (runIds.length > 0) {
        // The body belongs to the deleted Run, not to an unowned audit timeline.
        db.run(`DELETE FROM change WHERE action = ? AND run_id IN (${marks(runIds)})`, RUN_REPORT_ACTION, ...runIds);
        db.run(`UPDATE approval SET run_id = NULL WHERE run_id IN (${marks(runIds)})`, ...runIds);
        db.run(`UPDATE change SET run_id = NULL WHERE run_id IN (${marks(runIds)})`, ...runIds);
        db.run(`UPDATE input SET run_id = NULL WHERE run_id IN (${marks(runIds)})`, ...runIds);
        db.run(`UPDATE knowledge_proposal SET run_id = NULL WHERE run_id IN (${marks(runIds)})`, ...runIds);
        db.run(`UPDATE knowledge_evidence SET ref = ? WHERE source = 'run' AND ref IN (${marks(runIds)})`, `来自已删除的项目 ${project.name}`, ...runIds);
        // The row of use keeps its figures, its unit, its duration, the login it ran as and
        // whether it ever reported a figure: the page counts the same rounds and the same time
        // as before the deletion, and shows them as a deleted project's use rather than as a
        // quota read (docs/design/usage.md §4). A round that reported nothing gets the one row
        // that keeps its unit and its duration, with no figure.
        keepDroppedRuns(db, runIds);
      }
      if (contextIds.length > 0) {
        db.run(`UPDATE usage SET context_id = NULL, dropped_source = 'router', dropped_unit = 'router:' || context_id || '@' || at,
            login_id = (SELECT login_id FROM router_context WHERE router_context.id = usage.context_id)
          WHERE context_id IN (${marks(contextIds)})`, ...contextIds);
      }
      if (messageIds.length > 0) {
        db.run(`UPDATE change SET message_id = NULL WHERE message_id IN (${marks(messageIds)})`, ...messageIds);
        db.run(`UPDATE input SET message_id = NULL WHERE message_id IN (${marks(messageIds)})`, ...messageIds);
        db.run(`UPDATE trigger_fire SET message_id = NULL WHERE message_id IN (${marks(messageIds)})`, ...messageIds);
        db.run(`UPDATE project_file SET message_id = NULL WHERE message_id IN (${marks(messageIds)})`, ...messageIds);
        db.run(`UPDATE im_group_context SET project_id = NULL, message_id = NULL WHERE project_id = ? OR message_id IN (${marks(messageIds)})`, projectId, ...messageIds);
      } else {
        db.run('UPDATE im_group_context SET project_id = NULL, message_id = NULL WHERE project_id = ?', projectId);
      }
      if (segmentIds.length > 0) db.run(`UPDATE message SET segment_id = NULL WHERE segment_id IN (${marks(segmentIds)})`, ...segmentIds);
      if (fireIds.length > 0) {
        // A kept Task that a fire of this project created loses it, and a fire of another project
        // merged into one of this project's loses the merge: the reference goes, the row stays.
        db.run(`UPDATE task SET trigger_fire_id = NULL WHERE trigger_fire_id IN (${marks(fireIds)})`, ...fireIds);
        db.run(`UPDATE trigger_fire SET merged_into = NULL WHERE merged_into IN (${marks(fireIds)})`, ...fireIds);
      }
      if (inviteIds.length > 0) db.run(`UPDATE machine SET invite_id = NULL WHERE invite_id IN (${marks(inviteIds)})`, ...inviteIds);
      // A review binding is a JSON value, not a column: one of another project's Tasks that
      // named this project's Task or Run loses the binding rather than keeping a dead id.
      const gone = new Set([...taskIds, ...runIds]);
      for (const row of db.all<{ id: string; review_of_json: string }>(
        'SELECT id, review_of_json FROM task WHERE review_of_json IS NOT NULL AND (project_id IS NULL OR project_id != ?)', projectId,
      )) {
        const binding = JSON.parse(row.review_of_json) as { task_id?: string; run_id?: string };
        if (gone.has(binding.task_id ?? '') || gone.has(binding.run_id ?? '')) db.run('UPDATE task SET review_of_json = NULL WHERE id = ?', row.id);
      }

      // A source that let this project through keeps its row and its keys, and loses the project
      // from its list: a list still naming a gone project would refuse every later delivery as
      // `no_project` and count it against the source. `updated_at` stays the moment the owner last
      // edited it — the source itself was not edited.
      for (const { id, project_ids: projects } of plan.sources) {
        db.run('UPDATE inbound_source SET projects_json = ? WHERE id = ?',
          JSON.stringify(projects.filter((each) => each !== projectId)), id);
      }
      // The other projects' and no-project Tasks that reference what goes: a binding already
      // gone above; here the proposals and entries that keep a reference column.
      if (deletedProposals.size > 0) {
        const ids = [...deletedProposals];
        db.run(`UPDATE knowledge SET retired_proposal_id = NULL WHERE retired_proposal_id IN (${marks(ids)})`, ...ids);
        db.run(`UPDATE knowledge_proposal SET amended_from = NULL WHERE amended_from IN (${marks(ids)})`, ...ids);
        db.run(`UPDATE knowledge_proposal SET prior_rejection_id = NULL WHERE prior_rejection_id IN (${marks(ids)})`, ...ids);
        db.run(`UPDATE knowledge_proposal SET next_id = NULL WHERE next_id IN (${marks(ids)})`, ...ids);
      }
      if (deletedKnowledge.size > 0) {
        const ids = [...deletedKnowledge];
        db.run(`UPDATE knowledge SET replaced_by = NULL WHERE replaced_by IN (${marks(ids)})`, ...ids);
      }

      // A kept entry or proposal loses this project from its scope lists; every revision is
      // rewritten, so no array still names the project that is about to be gone.
      const withoutProject = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(withoutProject);
        if (value === null || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, field]) => [
          key,
          key === 'project_ids' && Array.isArray(field) ? field.filter((each) => each !== projectId) : withoutProject(field),
        ]));
      };
      for (const row of db.all<{ knowledge_id: string; revision: number; projects_json: string }>(
        'SELECT knowledge_id, revision, projects_json FROM knowledge_revision WHERE projects_json IS NOT NULL',
      )) {
        if (deletedKnowledge.has(row.knowledge_id)) continue;
        const projects = JSON.parse(row.projects_json) as string[];
        if (!projects.includes(projectId)) continue;
        db.run('UPDATE knowledge_revision SET projects_json = ? WHERE knowledge_id = ? AND revision = ?',
          JSON.stringify(projects.filter((each) => each !== projectId)), row.knowledge_id, row.revision);
      }
      // A published proposal's `final_json` names, per output, the entry it became
      // (`knowledge_id`). One this deletion takes loses that name: an id that resolves to
      // nothing is not material, and the entry is gone. The submitted change's own fields are
      // not rewritten — a proposal is frozen as it was handed in — so this touches only the
      // ledger's own record of what took effect.
      const withoutGoneEntries = (change: unknown): unknown => {
        if (change === null || typeof change !== 'object' || Array.isArray(change)) return change;
        const record = change as Record<string, unknown>;
        if (!Array.isArray(record.outputs)) return change;
        return {
          ...record,
          outputs: (record.outputs as unknown[]).map((output) => {
            if (output === null || typeof output !== 'object') return output;
            const { knowledge_id: id, ...rest } = output as Record<string, unknown>;
            return typeof id === 'string' && deletedKnowledge.has(id) ? rest : output;
          }),
        };
      };
      for (const row of db.all<{ id: string; change_json: string; final_json: string | null }>(
        'SELECT id, change_json, final_json FROM knowledge_proposal',
      )) {
        if (deletedProposals.has(row.id)) continue;
        const change = withoutProject(JSON.parse(row.change_json));
        const final = row.final_json === null ? null : withoutGoneEntries(withoutProject(JSON.parse(row.final_json)));
        db.run('UPDATE knowledge_proposal SET change_json = ?, final_json = ? WHERE id = ?',
          JSON.stringify(change), final === null ? null : JSON.stringify(final), row.id);
      }

      // What the deletion leaves pointless among the no-project knowledge tasks: a waiting
      // proposal that pinned one of these entries is stale and its gate ends with it, and a
      // curation loses the entries that go — the same invalidation a published change brings
      // (§3). The tasks themselves are kept, never deleted: they belong to no project, and their
      // records are not this deletion's to take. Run before the proposals go, since it reads them.
      knowledge.sweepKnowledgeTasks([...deletedKnowledge], [...deletedProposals],
        `所依据或所把关的知识已随项目“${project.name}”删除`, ctx);

      // Rows that only this project owns. Children first: what another row points at goes
      // before the row it names.
      if (deletedKnowledge.size > 0) {
        const ids = [...deletedKnowledge];
        db.run(`DELETE FROM knowledge_revision WHERE knowledge_id IN (${marks(ids)})`, ...ids);
        db.run(`DELETE FROM knowledge WHERE id IN (${marks(ids)})`, ...ids);
      }
      if (deletedProposals.size > 0) {
        const ids = [...deletedProposals];
        db.run(`DELETE FROM knowledge_evidence WHERE proposal_id IN (${marks(ids)})`, ...ids);
        db.run(`DELETE FROM knowledge_proposal WHERE id IN (${marks(ids)})`, ...ids);
      }
      const approvalIds = taskIds.length > 0
        ? db.all<{ id: string }>(`SELECT id FROM approval WHERE task_id IN (${marks(taskIds)})`, ...taskIds).map(({ id }) => id)
        : [];
      if (taskIds.length > 0) {
        db.run(`DELETE FROM approval WHERE task_id IN (${marks(taskIds)})`, ...taskIds);
        db.run(`DELETE FROM input WHERE task_id IN (${marks(taskIds)})`, ...taskIds);
        db.run(`DELETE FROM run WHERE task_id IN (${marks(taskIds)})`, ...taskIds);
      }
      if (contextIds.length > 0) db.run(`DELETE FROM router_context WHERE project_id = ?`, projectId);
      if (segmentIds.length > 0) db.run(`DELETE FROM router_segment WHERE project_id = ?`, projectId);
      db.run('DELETE FROM project_file WHERE project_id = ?', projectId);
      db.run(
        `INSERT INTO project_files_cleanup (project_id, created_at, project_name, dropped_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT (project_id) DO UPDATE SET created_at = excluded.created_at, project_name = excluded.project_name, dropped_at = NULL`,
        projectId,
        at,
        project.name,
      );
      if (messageIds.length > 0) db.run(`DELETE FROM message WHERE id IN (${marks(messageIds)})`, ...messageIds);
      if (triggerIds.length > 0) {
        db.run(`DELETE FROM trigger_cursor WHERE trigger_id IN (${marks(triggerIds)})`, ...triggerIds);
      }
      db.run('DELETE FROM trigger_fire WHERE project_id = ?', projectId);
      db.run('DELETE FROM trigger_rule WHERE project_id = ?', projectId);
      if (inviteIds.length > 0) {
        db.run(`DELETE FROM machine_material WHERE invite_id IN (${marks(inviteIds)})`, ...inviteIds);
        db.run(`DELETE FROM machine_invite WHERE project_id = ?`, projectId);
      }
      db.run('DELETE FROM push WHERE project_id = ?', projectId);
      const taskSet = new Set(taskIds);
      const runSet = new Set(runIds);
      const messageSet = new Set(messageIds);
      const approvalSet = new Set(approvalIds);
      const referencesDeleted = (payload: Record<string, unknown> | null | undefined): boolean => {
        if (!payload || typeof payload !== 'object') return false;
        if (payload.project_id === projectId) return true;
        if (typeof payload.task_id === 'string' && taskSet.has(payload.task_id)) return true;
        if (typeof payload.run_id === 'string' && runSet.has(payload.run_id)) return true;
        if (typeof payload.message_id === 'string' && messageSet.has(payload.message_id)) return true;
        if (typeof payload.approval_id === 'string' && approvalSet.has(payload.approval_id)) return true;
        if (typeof payload.proposal_id === 'string' && deletedProposals.has(payload.proposal_id)) return true;
        if (payload.payload && typeof payload.payload === 'object' && referencesDeleted(payload.payload as Record<string, unknown>)) return true;
        return false;
      };
      const orphanOutboxIds: string[] = [];
      for (const row of db.all<{ id: string; payload_json: string }>(`SELECT id, payload_json FROM outbox WHERE state = 'pending'`)) {
        try {
          if (referencesDeleted(JSON.parse(row.payload_json) as Record<string, unknown>)) orphanOutboxIds.push(row.id);
        } catch {
          // Malformed payload is left for the sender to diagnose.
        }
      }
      if (orphanOutboxIds.length > 0) db.run(`DELETE FROM outbox WHERE id IN (${marks(orphanOutboxIds)})`, ...orphanOutboxIds);
      db.run('DELETE FROM front_desk WHERE project_id = ?', projectId);
      db.run('DELETE FROM im_group_binding WHERE project_id = ?', projectId);
      if (taskIds.length > 0) db.run(`DELETE FROM task WHERE id IN (${marks(taskIds)})`, ...taskIds);
      db.run('DELETE FROM project WHERE id = ?', projectId);
      const registry = readSkillRegistry();
      let registryChanged = false;
      const nextRegistry: SkillRegistryMap = {};
      for (const [slug, binding] of Object.entries(registry)) {
        if (binding.project_ids !== null && binding.project_ids.includes(projectId)) {
          registryChanged = true;
          const remaining = binding.project_ids.filter((each) => each !== projectId);
          nextRegistry[slug] = remaining.length > 0
            ? { ...binding, project_ids: remaining }
            : { ...binding, enabled: false, project_ids: null };
        } else {
          nextRegistry[slug] = binding;
        }
      }
      if (registryChanged) writeSetting(SKILL_REGISTRY_SETTING_KEY, nextRegistry);
      if (deletedKnowledge.size > 0) {
        const em = readEntryMachines();
        let emChanged = false;
        const nextEm: EntryMachinesMap = {};
        for (const [eid, mids] of Object.entries(em)) {
          if (deletedKnowledge.has(eid)) { emChanged = true; continue; }
          nextEm[eid] = mids;
        }
        if (emChanged) writeSetting(ENTRY_MACHINES_SETTING_KEY, nextEm);
      }
      if (taskIds.length > 0) {
        const deletedTaskSet = new Set(taskIds);
        const tt = readTaskTimeouts();
        let ttChanged = false;
        const nextTt: Record<string, number> = {};
        for (const [tid, ms] of Object.entries(tt)) {
          if (deletedTaskSet.has(tid)) { ttChanged = true; continue; }
          nextTt[tid] = ms;
        }
        if (ttChanged) writeSetting(TASK_TIMEOUTS_SETTING_KEY, nextTt);
      }
      const listed = (each: DeletionCount[]): Record<string, number> => Object.fromEntries(each.map(({ label, count }) => [label, count]));
      writeChange(db, 'project.delete', { actor: ctx.actor }, {}, {
        project_id: projectId,
        name: project.name,
        counts: listed(deletion.counts),
        scope_removed: listed(deletion.scope_removed),
        canceled: listed(deletion.canceled),
        reduced: listed(deletion.reduced),
        finished: listed(deletion.finished),
      });
      if (deletedKnowledge.size > 0) onCommit(materializePublished);
    });
  }


  // The original settlement owns receipt use. A missing proof of adoption is not
  // proof of rejection: callers must keep unknown history separate from both.
  function receiptUseOf(run: RunRow): { kind: 'used'; receipt: Receipt } | { kind: 'not_used'; reason: string } | { kind: 'unknown' } {
    if (run.state !== 'ended') return { kind: 'unknown' };
    try {
      const original = db.get<{task_id: string | null; action: string; detail_json: string | null}>(
        "SELECT task_id, action, detail_json FROM change WHERE run_id = ? AND action IN ('run.settle', 'run.settle_late') ORDER BY seq LIMIT 1", run.id);
      if (original?.action !== 'run.settle' || original.task_id !== run.task_id) return { kind: 'unknown' };
      const decision: unknown = JSON.parse(original.detail_json ?? '{}');
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return { kind: 'unknown' };
      const verdict = decision as { exit_code?: unknown; exit_kind?: unknown };
      if (verdict.exit_code !== run.exit_code || verdict.exit_kind !== run.exit_kind) return { kind: 'unknown' };
      let receipt: Receipt | null = null;
      if (run.receipt_json !== null) {
        const parsed: unknown = JSON.parse(run.receipt_json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unknown' };
        receipt = parsed as Receipt;
      }
      const outcome = settlement(run.exit_code, receipt, false, {});
      // These inputs cannot supply a receipt verdict, regardless of optional marks.
      // A declared report in that unused payload never became a formal report.
      if (!receiptWasUsed(run.exit_code, receipt, false, {})) {
        if (outcome.exitKind !== run.exit_kind) return { kind: 'unknown' };
        return { kind: 'not_used', reason: outcome.state === 'held' ? outcome.reason : '原结算未采用这一轮回执' };
      }
      const marks: unknown = JSON.parse(run.error_json ?? '{}');
      if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return { kind: 'unknown' };
      const errors = marks as { worker_not_started?: unknown; code_check?: unknown };
      if (errors.worker_not_started !== undefined) {
        if (typeof errors.worker_not_started !== 'string'
          || settlement(run.exit_code, receipt, false, {workerNotStarted: errors.worker_not_started}).exitKind !== run.exit_kind) return { kind: 'unknown' };
        return { kind: 'not_used', reason: errors.worker_not_started };
      }
      const check = errors.code_check;
      if (check !== undefined && (!check || typeof check !== 'object' || Array.isArray(check) || !codeCheckAdopted(check as CodeCheck))) return { kind: 'unknown' };
      if (outcome.exitKind !== run.exit_kind) return { kind: 'unknown' };
      return { kind: 'used', receipt };
    } catch (error) {
      if (error instanceof SyntaxError) return { kind: 'unknown' };
      throw error;
    }
  }

  function reportRecoveryReceipt(run: RunRow): Receipt {
    const use = receiptUseOf(run);
    if (use.kind !== 'used') throw new InputError('这一轮没有采用的完整交付，不能恢复正式报告');
    const receipt = use.receipt;
    if (!hasFinalMessageReport(receipt)) throw new InputError('这一轮没有声明最后回复为交付报告');
    return receipt;
  }

  function runReport(runId: string, projectId?: string): RunReport | undefined {
    const run = loadRun(runId);
    if (projectId !== undefined && loadTask(run.task_id).project_id !== projectId) throw new InputError('报告不属于这个项目');
    return readRecordedReport(db, run);
  }

  function saveRunReport(run: RunRow, text: string, source: RunReport['source']): RunReport {
    const saved = runReport(run.id);
    if (saved) return saved;
    writeChange(db, RUN_REPORT_ACTION, RUNNER, { taskId: run.task_id, runId: run.id }, { version: 1, id: ulid(), ...finalReportContent(text, source) });
    return runReport(run.id)!;
  }

  const api = {
    runReport,
    reportRecoveryReceipt: (runId: string): Receipt => reportRecoveryReceipt(loadRun(runId)),
    recordRecoveredRunReport(runId: string, receipt: Receipt, text: string): RunReport {
      return write(() => {
        const run = loadRun(runId);
        const saved = runReport(runId);
        if (saved) return saved;
        const recorded = reportRecoveryReceipt(run);
        if (settleInputDigest(0, recorded, {}) !== settleInputDigest(0, receipt, {})) throw new InputError('历史原输出的回执与这一轮不一致，不能恢复报告');
        return saveRunReport(run, text, 'recovered');
      });
    },
    ...messages,
    ...knowledge,
    applicable: (projectId: string | null, roleId: string | null, from?: readonly Entry[], machineId: string | null = null): Entry[] =>
      from !== undefined ? knowledge.applicable(projectId, roleId, from) : applicableAll(projectId, roleId, machineId),
    getDirectorySkillEntry: directorySkillEntry,
    skillsDirPath: (): string | null => skillsDir,
    scanSkills: (): SkillDirectoryScan =>
      skillsDir === null
        ? { dir: '', skills: [], ignored: [] }
        : scanSkillDirectory(skillsDir, readSkillRegistry()),
    skillRegistry: (): SkillRegistryMap => readSkillRegistry(),
    entryMachines: (): EntryMachinesMap => readEntryMachines(),
    taskTimeoutMs: (taskId: string): number | null => {
      const map = readTaskTimeouts();
      return Object.hasOwn(map, taskId) ? map[taskId]! : null;
    },
    putSkillBinding(slug: string, input: unknown, ctx: Ctx): SkillRegistryBinding {
      if (typeof slug !== 'string' || isUnsafeSlug(slug)) {
        throw new InputError(`技能目录名不合法：${String(slug)}`);
      }
      const knownProjects = db.all<{ id: string }>('SELECT id FROM project').map(({ id }) => id);
      const knownRoles = db.all<{ id: string }>('SELECT id FROM role').map(({ id }) => id);
      const knownMachines = db.all<{ id: string }>('SELECT id FROM machine WHERE left_at IS NULL').map(({ id }) => id);
      const binding = validateSkillBinding(input, knownProjects, knownRoles, knownMachines);
      return write(() => {
        const current = readSkillRegistry();
        const prev = Object.hasOwn(current, slug) ? current[slug]! : null;
        const next: SkillRegistryMap = { ...current, [slug]: binding };
        writeSetting(SKILL_REGISTRY_SETTING_KEY, next);
        writeChange(db, 'skill_registry.update', ctx, {}, { slug, from: prev, to: binding });
        return binding;
      });
    },
    putEntryMachines(entryId: string, input: unknown, ctx: Ctx): string[] | null {
      const entry = knowledge.getEntry(entryId);
      if (!entry) throw new InputError(`没有这个条目：${entryId}`);
      const raw = input !== null && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'machine_ids')
        ? (input as { machine_ids: unknown }).machine_ids
        : input;
      const knownMachines = db.all<{ id: string }>('SELECT id FROM machine WHERE left_at IS NULL').map(({ id }) => id);
      const machineIds = validateMachineIds(raw, knownMachines);
      return write(() => {
        const current = readEntryMachines();
        const prev = Object.hasOwn(current, entryId) ? current[entryId]! : null;
        const next: EntryMachinesMap = { ...current };
        if (machineIds === null) {
          delete next[entryId];
        } else {
          next[entryId] = machineIds;
        }
        writeSetting(ENTRY_MACHINES_SETTING_KEY, next);
        writeChange(db, 'knowledge_entry_machines.update', ctx, {}, { entry_id: entryId, from: prev, to: machineIds });
        return machineIds;
      });
    },
    effectiveContext(
      projectId: string | null,
      roleId: string | null,
      limits: KnowledgeLimits = knowledgeLimits(),
      machineId: string | null = null,
    ): EffectiveContextReport {
      const project = projectId === null ? null : (() => {
        const row = db.get<{ id: string; name: string }>('SELECT id, name FROM project WHERE id = ?', projectId);
        if (!row) throw new InputError(`项目不存在：${projectId}`);
        return row;
      })();
      const role = roleId === null ? null : (() => {
        const row = db.get<{ id: string; name: string }>('SELECT id, name FROM role WHERE id = ?', roleId);
        if (!row) throw new InputError(`职能不存在：${roleId}`);
        return row;
      })();
      const machine = machineId === null ? null : (() => {
        const row = currentMachine(machineId);
        if (!row) throw new InputError(`机器不存在：${machineId}`);
        return { id: row.id, host: row.host };
      })();
      const entries = applicableAll(project?.id ?? null, role?.id ?? null, machine?.id ?? null);
      return buildEffectiveContext({
        entries,
        project,
        role,
        machine,
        registry: readSkillRegistry(),
        entryMachines: readEntryMachines(),
        limits,
      });
    },
    ...frontDesk,
    ...triggerApi,

    // The due scan (docs/design/triggers.md §5): the wakes schedule_wake set, and the scheduled
    // triggers. The global pause stops neither: it is about dispatch, not about what is due.
    fireDue(now: Date = new Date()): { woken: string[]; fired: number } {
      const woken = api.fireDueWakes(now);
      return { woken, fired: scanSchedules(now) };
    },

    // Reminders that are due and results whose window has passed (project-sessions §2.1).
    pushTick(now: Date = new Date()): void {
      write(() => pushes.tick(now));
    },

    // Whether what a waiting item is about still waits for the owner, as the ledger has it now:
    // asked when a reminder is queued and again when it goes out.
    pushStillWaiting: (kind: string, payload: Record<string, unknown>): boolean => pushes.stillWaiting(kind, payload),

    // Whether a first expiry notice is still about the credential the account holds now: what
    // goes out is decided here, and the reminder window was the scan's to apply.
    expiryCredentialCurrent: (payload: Record<string, unknown>): boolean => expiryCredentialCurrent(payload),

    // The logins whose token is expected to run out soon, for the self-check (native-login.md
    // §2): one derivation, and the same one the scan below pushes about, from the executors'
    // declarations the ledger holds.
    expiringAccounts: (now: Date): ExpiringAccount[] => expiringAccountsOf(now),

    // One waiting notice per credential, the first time it is inside the window (native-login.md
    // §2). The Outbox's key and the push table make it once, however often the timer scans; a
    // token stored again is another credential and is counted again.
    expiryReminders(now: Date = new Date()): void {
      write(() => {
        for (const account of expiringAccountsOf(now)) {
          enqueueNotification(NOTICE_CHANNEL, 'account_expiry', {
            external_id: `account-expiry:${account.id}:${account.credentialAt}`,
            account_id: account.id,
            account_name: account.name,
            credential_at: account.credentialAt,
            expected_expiry: account.expected,
          });
        }
      });
    },

    // The Router's sentence for the result made at settlement (§2.1): only adds to it.
    supplementResult(key: string, summary: string): void {
      write(() => pushes.supplement(key, summary));
    },

    // The daily brief for the scheduled moment `due`, the latest one up to `now`: true when one
    // was queued. The first one only marks where changes are counted from.
    dailyBrief(now: Date, due: Date): boolean {
      return write(() => pushes.dailyBrief(now, due, {
        read: () => readSetting<BriefMark | null>(DAILY_BRIEF_KEY, null),
        write: (value) => writeSetting(DAILY_BRIEF_KEY, value),
      }));
    },

    // A release that went in place and passed its check, said once as a result of its Task's
    // project (§2.1) and offered once to its subscriptions (docs/design/triggers.md §2.3). `key`
    // tells this release result from another. The service reads the same result every round, so
    // handling it is a mark in the ledger written with its push and its trigger records: a result
    // handled is not matched again, whatever was refused, subscribed or enabled since; one whose
    // handling did not commit is handled by the next round, of this instance or the next. Results
    // only move forward, so the last one handled is the mark.
    noteReleased(key: string, fields: { runId: string | null; version: string }): void {
      write(() => {
        if (readSetting<string | null>(RELEASE_HANDLED_KEY, null) === key) return;
        const taskId = fields.runId === null ? null : db.get<{ task_id: string }>('SELECT task_id FROM run WHERE id = ?', fields.runId)?.task_id ?? null;
        internalEvent(internalEvents.released(key, taskId, fields.version));
        writeSetting(RELEASE_HANDLED_KEY, key);
        db.noteAction('release.noted');
      });
    },

    // The old rulings the migration could not turn into proposals, with why: the knowledge page
    // lists them so none sits there unseen (project-sessions §6).
    legacyDecisions(): { id: string; created_at: string; task_id: string | null; project_id: string | null; text: string; problem: string | null }[] {
      return readSetting<{ id: string; created_at: string; task_id: string | null; project_id: string | null; text: string; problem?: string }[]>('legacy_decisions', [])
        .map(({ id, created_at, task_id, project_id, text, problem }) => ({ id, created_at, task_id, project_id, text, problem: problem ?? null }));
    },
    machineRange,
    loginPool,
    loginOrder,
    projectDispatchOrder,
    projectDispatchSlots,
    effectiveProjectDispatchOrder,
    loginRefusal,
    spreadExecutorsOf,

    // Which group of logins placed a Run, from the one audit row that says so
    // (roles-and-tiers.md §11.3): the task page reads it for each round.
    placementOf(runId: string): PlacedBy | undefined {
      const row = db.get<{ detail_json: string | null }>(
        `SELECT detail_json FROM change WHERE run_id = ? AND action = 'run.create' ORDER BY seq DESC LIMIT 1`, runId,
      );
      const placed = row === undefined || row === null || row.detail_json === null ? undefined : (JSON.parse(row.detail_json) as { placed_by?: unknown }).placed_by;
      return typeof placed === 'string' ? placed as PlacedBy : undefined;
    },

    // The projects whose effective pool is empty, with why: the one derivation dispatch uses
    // (loginPool), so what the overview lists and what the dispatcher would refuse cannot
    // disagree (docs/design/project-sessions.md §5). A project swimming in logins is not here.
    projectsWithoutLogins(): { id: string; name: string; reason: string }[] {
      return db.all<{ id: string; name: string }>(`SELECT id, name FROM project WHERE ${IN_SIGHT} ORDER BY rowid`).flatMap((project) => {
        const pool = loginPool({ project_id: project.id });
        return pool.ids.length > 0 ? [] : [{ id: project.id, name: project.name, reason: `${pool.where}里一个可用的登录都没有${pool.how ?? ''}` }];
      });
    },

    // A gate or curation Task's work, its source and the projects its material carries (knowledge
    // §3); null for any other Task.
    knowledgeTaskView(taskId: string) {
      const job = parseKnowledgeTask(loadTask(taskId).knowledge_json);
      return job === null ? null : knowledge.describeKnowledgeTask(job);
    },
    outbox,
    enqueueNotification,

    setChannels(enabled: readonly string[]): void {
      const next = new Set(enabled);
      write(() => {
        const disabled = db.all<{ id: string; channel: string }>(`SELECT id, channel FROM outbox WHERE state = 'pending'`)
          .filter((row) => !next.has(row.channel));
        for (const row of disabled) {
          db.run(`UPDATE outbox SET state = 'given_up', error = '通道未启用' WHERE id = ?`, row.id);
        }
        if (disabled.length) writeChange(db, 'outbox.disable_channels', { actor: 'service' }, {}, {
          outbox_ids: disabled.map((row) => row.id), channels: [...new Set(disabled.map((row) => row.channel))],
        });
      });
      channels = next;
    },
    recover: degraded.recover,
    close: () => db.close(),
    // That something the ledger keeps has changed: what a page shows may be out of date.
    onChange: (listener: () => void): (() => void) => db.onCommit(listener),
    // Lets one tool call commit several operations as a whole.
    transaction: write,
    resultDelivery: pushes.resultDelivery,
    ...createRouterCalls(db, write),
    searchHistoryEvidence: createHistoryEvidence(db, knowledge, runReport),
    ...createTaskFeedback(db, write),
    projectHome(projectId: string) {
      const installed = readSetting<ProjectOwnership | undefined>(PROJECT_HOME_KEY_PREFIX + projectId, undefined);
      return options.projectHome?.describe(projectId, installed) ?? null;
    },
    getTask: loadTask,
    getRun: loadRun,
    hasRun: (id: string): boolean => db.get('SELECT 1 FROM run WHERE id = ?', id) !== undefined,
    hasTask: (id: string): boolean => db.get('SELECT 1 FROM task WHERE id = ?', id) !== undefined,

    listActiveRuns(): RunRow[] {
      return db.all<RunRow>(`SELECT * FROM run WHERE state != 'ended' ORDER BY rowid`);
    },

    // Progress is display data, so it writes no change row.
    touchRun(runId: string, at: string): void {
      write(() => db.run(`UPDATE run SET last_progress_at = ? WHERE id = ? AND state != 'ended'`, at, runId));
    },

    // `sources`: where its code comes from, in order, the first being the default
    // (docs/design/code-sources.md §1); empty for a project with no code.
    createProject(fields: { name: string; sources?: unknown; logins?: string[]; loginMode?: LoginMode; machines?: string[]; spawnMachines?: boolean }, ctx: Ctx) {
      const id = ulid();
      const create = (ownership?: ProjectOwnership): void => write(() => {
        const name = projectNameOf(fields.name);
        const logins = [...new Set(fields.logins ?? [])];
        const mode = fields.loginMode ?? 'selected';
        if (mode !== 'all' && mode !== 'selected') throw new InputError(`登录方式只能是 all 或 selected：${String(mode)}`);
        const sources = parseSourceInput(fields.sources ?? [], []);
        if (ownership) db.installProjectOwnership(id, ownership);
        db.run(
          'INSERT INTO project (id, created_at, name, logins_json, machines_json, spawn_machines, login_mode, sources_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          nowIso(),
          name,
          JSON.stringify(logins),
          JSON.stringify(heldUids([...new Set(fields.machines ?? [])])),
          fields.spawnMachines ? 1 : 0,
          mode,
          JSON.stringify(sources),
        );
        writeChange(db, 'project.create', ctx, {}, { project_id: id });
      });
      // Both databases use authority first, ledger second. A creation whose ledger
      // commit fails never claims the new id. If only the second commit succeeded,
      // the installed row fails closed until its missing authority is recovered.
      if (options.projectHome) options.projectHome.registerNew(id, create);
      else create();
      return id;
    },

    createTask(
      fields: {
        // Every Task's but a knowledge Task's, which has none.
        projectId: string | null;
        parentId?: string;
        title: string;
        goal: string;
        scope?: string;
        acceptance?: string;
        loginId?: string;
        roleId?: string;
        tierOverride?: TierOverrideInput | null;
        // The logins its next rounds try first, in the Router's order, with why.
        prefer?: { loginIds: readonly string[]; reason?: string | null } | null;
        priority?: number;
        // For a review: the Task under review, the round and revision the service took its
        // files over for, the registration that taking made, and the commit the round
        // reported, checked where it lives (service/accept.ts). The binding itself is made
        // here from the files that registration holds and that commit.
        reviewOf?: { taskId: string; runId?: string; revision?: number; registration?: string; reviewed?: ReviewedCommit | null };
        // For a knowledge gate or curation Task: what it gates or curates. Only the knowledge
        // module makes one; no tool or page passes it.
        knowledge?: KnowledgeTask;
        // The skills its rounds are to follow, given to them in full.
        skillIds?: readonly string[];
        // The project source its rounds work on (docs/design/code-sources.md §1). Absent: the
        // project's default (the first), or null when targeting a machine whose default folder
        // lives elsewhere. Null: explicitly use Tycho's default empty task directory.
        sourceId?: string | null;
        // Optional target machine (machine.id) to pin this Task to.
        machineId?: string | null;
        // For a merge round: the Task it lands, the pull request and the reviewed commit. Only
        // integrate_task passes it, and nothing after creation changes it.
        landing?: Landing;
        // The owner explicitly asked to take a verification report with only a notification.
        onReady?: 'notify_owner';
        // Optional per-task run timeout override in milliseconds (1 min .. 7 days); null/omitted uses default.
        timeoutMs?: number | null;
      },
      ctx: Ctx,
    ): TaskRow {
      return write(() => {
        if (isBlank(fields.title) || isBlank(fields.goal)) throw new InputError('标题和目标不能为空');
        const roleId = isBlank(fields.roleId) ? 'implement' : fields.roleId!.trim();
        requireRole(roleId);
        const timeoutOverride = parseTaskTimeoutOverride(fields.timeoutMs);
        if (fields.onReady !== undefined && fields.onReady !== 'notify_owner') {
          throw new InputError('on_ready 只能为 notify_owner');
        }
        const override = overrideOf(fields.tierOverride);
        const prefer = preferOf(fields.prefer);
        if (roleId !== REVIEW_ROLE_ID && fields.reviewOf !== undefined) throw new InputError(REVIEW_ONLY_TEXT);
        if (fields.reviewOf !== undefined && fields.sourceId !== undefined) throw new InputError('审阅任务的代码来源跟着被审的任务，不能另选');
        const binding = fields.reviewOf === undefined ? null : bindReview(loadTask(fields.reviewOf.taskId), fields.reviewOf);
        if (binding !== null && loadTask(binding.task_id).project_id !== fields.projectId) throw new InputError('审阅任务要和被审的任务在同一个项目');
        if ((fields.knowledge === undefined) !== (fields.projectId !== null)) {
          throw new InputError(fields.knowledge === undefined ? '任务要属于一个项目' : '知识任务不属于任何项目');
        }
        if (fields.projectId !== null && !db.get('SELECT 1 FROM project WHERE id = ?', fields.projectId)) {
          throw new InputError(`项目不存在：${fields.projectId}`);
        }
        requireLoginAllowed({ project_id: fields.projectId }, fields.loginId);
        const machineId = normalizeMachineId(fields.machineId) ?? null;
        const effectiveTargetMachine = machineId ?? currentLogin(fields.loginId ?? null)?.machine ?? null;
        // A review bound to a reviewed task inherits that task's source pin.
        const source = fields.reviewOf === undefined ? pinSource(fields.projectId, fields.sourceId, effectiveTargetMachine) : taskSourceOf(fields.reviewOf.taskId);
        if (fields.knowledge !== undefined) requireKnowledgeRole(roleId);
        requireReadOnlyWay(roleId, fields.loginId);
        validatePlacement(
          { project_id: fields.projectId, knowledge_json: fields.knowledge === undefined ? null : JSON.stringify(fields.knowledge) },
          fields.loginId ?? null,
          machineId,
          source,
        );
        if (fields.parentId && loadTask(fields.parentId).project_id !== fields.projectId) {
          throw new InputError('父任务必须在同一项目');
        }
        if (fields.landing !== undefined && fields.landing.of !== fields.parentId) {
          throw new InputError('合入任务要把它并入的那一个任务作为父任务');
        }
        const skills = namedSkills(fields.skillIds, fields.projectId);
        const id = ulid();
        const origin = originOf(ctx, fields.parentId ? loadTask(fields.parentId).trigger_fire_id : null);
        db.run(
          `INSERT INTO task (id, created_at, project_id, parent_id, title, goal, scope, acceptance, login_id, role_id, tier_override, tier_reason, priority, state, created_by, review_of_json, knowledge_json, trigger_fire_id, skills_json, landing_json, prefer_json, source_json, machine_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          nowIso(),
          fields.projectId,
          fields.parentId ?? null,
          fields.title,
          fields.goal,
          fields.scope ?? null,
          fields.acceptance ?? null,
          fields.loginId ?? null,
          roleId,
          override?.tier ?? null,
          override?.reason ?? null,
          fields.priority ?? 0,
          ctx.actor,
          binding === null ? null : JSON.stringify(binding),
          fields.knowledge === undefined ? null : JSON.stringify(fields.knowledge),
          origin,
          skills.length === 0 ? null : JSON.stringify(skills),
          fields.landing === undefined ? null : landingJson(fields.landing),
          prefer === null ? null : JSON.stringify(prefer),
          source === null ? null : JSON.stringify(source),
          machineId,
        );
        if (timeoutOverride !== null) {
          const tt = readTaskTimeouts();
          writeSetting(TASK_TIMEOUTS_SETTING_KEY, { ...tt, [id]: timeoutOverride });
        }
        writeChange(db, 'task.create', ctx, { taskId: id }, {
          ...(origin === null ? {} : { trigger_fire_id: origin }),
          ...(fields.onReady === undefined ? {} : { on_ready: fields.onReady }),
          ...(timeoutOverride === null ? {} : { timeout_ms: timeoutOverride }),
          role_id: roleId, ...(override ? { tier_override: override } : {}), ...(skills.length === 0 ? {} : { skills }),
          ...(source === null ? {} : { source: source.source_id }),
          ...(machineId === null ? {} : { machine_id: machineId }),
          ...(fields.knowledge ? { knowledge: fields.knowledge.kind } : {}),
          ...(prefer === null ? {} : { prefer }),
          ...(binding ? { review_of: { task_id: binding.task_id, run_id: binding.run_id, revision: binding.revision, writers: binding.writers } } : {}),
        });
        return loadTask(id);
      });
    },

    updateTask(
      taskId: string,
      patch: {
        title?: string;
        goal?: string;
        scope?: string;
        acceptance?: string;
        // Null takes the pin off: the Task then runs on whichever login of its project can.
        loginId?: string | null;
        roleId?: string;
        // Null takes the override off: the Task then runs on its role's default tier.
        tierOverride?: TierOverrideInput | null;
        // The logins its next rounds try first, in the Router's order; null takes it off.
        // Like the pin, it is not part of what the Task asks: no new revision.
        prefer?: { loginIds: readonly string[]; reason?: string | null } | null;
        priority?: number;
        // The skills its rounds follow, in full; an empty list names none. Part of what the
        // Task asks, like its goal: changing it is a new revision.
        skillIds?: readonly string[];
        // The project source it works on, moved to another item of the project's list or null
        // for Tycho's default empty task directory.
        sourceId?: string | null;
        // Optional target machine (machine.id); null clears the machine pin.
        machineId?: string | null;
        // Optional per-task run timeout override (1 min .. 7 days); null clears override back to default.
        timeoutMs?: number | null;
        // When true and task is in `ready`, immediately re-queue after applying the update.
        requeue?: boolean;
      },
      ctx: Ctx,
    ): TaskRow {
      return write(() => {
        const task = loadTask(taskId);
        if (task.state === 'done' || task.state === 'abandoned') {
          throw new InputError(`任务 ${taskId} 已关闭，不能修改`);
        }
        if (patch.roleId !== undefined) requireRole(patch.roleId);
        if (patch.roleId !== undefined && task.knowledge_json !== null) requireKnowledgeRole(patch.roleId);
        const override = patch.tierOverride === undefined ? undefined : overrideOf(patch.tierOverride);
        const prefer = patch.prefer === undefined ? undefined : preferOf(patch.prefer);
        // A bound review task stays in review role so its binding remains consistent.
        if (patch.roleId !== undefined && patch.roleId !== task.role_id && task.review_of_json !== null) {
          throw new InputError(REVIEW_ROLE_LOCK_TEXT);
        }
        requireLoginAllowed(task, patch.loginId);
        const nextLoginId = patch.loginId === undefined ? task.login_id : patch.loginId;
        requireReadOnlyWay(patch.roleId ?? task.role_id, nextLoginId);
        const normalizedMachineId = normalizeMachineId(patch.machineId);
        const nextMachineId = normalizedMachineId === undefined ? task.machine_id : normalizedMachineId;
        // Moving the pin checks the project's list as it stands now; a source removed since is
        // refused here, which is how the Router moves a stopped Task to one that is still there.
        const source = patch.sourceId === undefined ? undefined : pinSource(task.project_id, patch.sourceId, nextMachineId);
        const { roleId: _role, tierOverride: _override, skillIds: _skills, prefer: _prefer, sourceId: _source, machineId: _machineId, timeoutMs: _timeoutMs, requeue: _requeue, ...rest } = patch;
        const timeoutOverride = patch.timeoutMs === undefined ? undefined : parseTaskTimeoutOverride(patch.timeoutMs);
        const next = { ...task, ...rest };
        const skills = patch.skillIds === undefined
          ? namedSkillsOf(task)
          : namedSkills(patch.skillIds, task.project_id);
        const skillsJson = skills.length === 0 ? null : JSON.stringify(skills);
        const sourceJson = source === undefined ? task.source_json : source === null ? null : JSON.stringify(source);
        const nextSource = sourceJson === null ? null : (JSON.parse(sourceJson) as TaskSource);
        if (source !== undefined && task.review_of_json !== null && sourceJson !== task.source_json) {
          throw new InputError('审阅用的来源随被审的那一轮定下，不能改；要换就重新建审阅：这条审阅绑的是被审的那个提交，回执要对得上现场');
        }
        validatePlacement(task, nextLoginId, nextMachineId, nextSource);
        // Moving the pin is a new revision of what the Task asks for, and it waits for any round
        // in flight to end (§8.7): the round running would otherwise work somewhere other than
        // the one being recorded for the next one.
        const sourceMoved = sourceJson !== task.source_json;
        const machineMoved = nextMachineId !== task.machine_id;
        if (sourceMoved) requireNoActiveRun(task, '改派代码来源');
        if (machineMoved) requireNoActiveRun(task, '改派目标机器');
        if (isBlank(next.title) || isBlank(next.goal)) throw new InputError('标题和目标不能为空');
        const revised =
          next.goal !== task.goal || next.scope !== task.scope || next.acceptance !== task.acceptance
          || skillsJson !== task.skills_json || sourceMoved;
        // Settlement refusing the old receipt protects the ledger, but the Worker
        // would keep acting on the old brief; the stop has to come first.
        if (revised && (task.state === 'stopping' || activeRun(task))) {
          throw new InputError(`任务 ${taskId} 正在执行，要改目标、范围、验收、点名的技能或代码来源请先中断`);
        }
        const revision = revised ? task.revision + 1 : task.revision;
        const preferBefore = parseTaskPrefer(task.prefer_json);
        const preferJson = prefer === undefined ? task.prefer_json : prefer === null ? null : JSON.stringify(prefer);
        const preferChanged = prefer !== undefined && JSON.stringify(prefer) !== JSON.stringify(preferBefore);
        db.run(
          'UPDATE task SET title = ?, goal = ?, scope = ?, acceptance = ?, login_id = ?, role_id = ?, tier_override = ?, tier_reason = ?, tier_escalated = ?, priority = ?, revision = ?, skills_json = ?, prefer_json = ?, source_json = ?, machine_id = ? WHERE id = ?',
          next.title,
          next.goal,
          next.scope,
          next.acceptance,
          nextLoginId,
          patch.roleId ?? task.role_id,
          override === undefined ? task.tier_override : override?.tier ?? null,
          override === undefined ? task.tier_reason : override?.reason ?? null,
          override === undefined ? task.tier_escalated : 0,
          next.priority,
          revision,
          skillsJson,
          preferJson,
          sourceJson,
          nextMachineId,
          taskId,
        );
        // Pending questions and finished work both answer the old revision.
        // When `requeue: true` on a `ready` task, re-queue immediately instead of parking in held.
        if (patch.requeue === true && task.state === 'ready') {
          requireNoActiveRun(task, '重新排队');
          moveTask(taskId, 'queued');
        } else if (revised && (task.state === 'waiting_person' || task.state === 'ready')) {
          moveTask(taskId, 'held', { reason: '目标、范围、验收、点名的技能或代码来源已变更，请确认后继续', byHand: true });
        }
        // The role and the override are said with what they were: the timeline is where an
        // override and its reason are read back (docs/design/roles-and-tiers.md §3.3).
        const roleChanged = patch.roleId !== undefined && patch.roleId !== task.role_id;
        const before = task.tier_override === null ? null : { tier: task.tier_override, reason: task.tier_reason };
        const overrideChanged = override !== undefined && JSON.stringify(override) !== JSON.stringify(before);
        let timeoutBefore: number | null | undefined;
        if (timeoutOverride !== undefined) {
          const tt = readTaskTimeouts();
          timeoutBefore = Object.hasOwn(tt, taskId) ? tt[taskId]! : null;
          const nextTt = { ...tt };
          if (timeoutOverride === null) delete nextTt[taskId];
          else nextTt[taskId] = timeoutOverride;
          writeSetting(TASK_TIMEOUTS_SETTING_KEY, nextTt);
        }
        writeChange(db, 'task.update', ctx, { taskId }, {
          fields: Object.keys(patch), revision,
          ...(roleChanged ? { role: { from: task.role_id, to: patch.roleId } } : {}),
          ...(sourceMoved ? { source: { from: task.source_json === null ? null : JSON.parse(task.source_json), to: source } } : {}),
          ...(machineMoved ? { machine_id: { from: task.machine_id, to: nextMachineId } } : {}),
          ...(overrideChanged ? { tier_override: { from: before, to: override } } : {}),
          ...(preferChanged ? { prefer: { from: preferBefore, to: prefer } } : {}),
          ...(timeoutOverride !== undefined && timeoutBefore !== timeoutOverride ? { timeout_ms: { from: timeoutBefore, to: timeoutOverride } } : {}),
        });
        return loadTask(taskId);
      });
    },

    queueTask(taskId: string, ctx: Ctx): void {
      write(() => {
        const task = loadTask(taskId);
        requireState(task, ['draft'], '入队');
        moveTask(taskId, 'queued');
        writeChange(db, 'task.queue', ctx, { taskId });
      });
    },

    holdTask(taskId: string, reason: string, ctx: Ctx): void {
      write(() => {
        if (isBlank(reason)) throw new InputError('挂起原因不能为空');
        requireState(loadTask(taskId), ['queued', 'waiting_person', 'waiting_timer'], '挂起');
        // The dispatcher stopping one is the rules; the Router or the owner parking one is not.
        moveTask(taskId, 'held', { reason, byHand: ctx.actor !== 'dispatcher' });
        writeChange(db, 'task.hold', ctx, { taskId }, { reason });
      });
    },

    resumeTask(taskId: string, ctx: Ctx): void {
      write(() => {
        const task = loadTask(taskId);
        // A Task parked by the migration waits with no question to answer, so "继续" is
        // its way out; one that asked a question is answered, not resumed.
        requireState(task, ['held', 'waiting_person'], '继续');
        if (task.state === 'waiting_person' && db.get<{ id: string }>(
          `SELECT id FROM approval WHERE task_id = ? AND state = 'open'`, taskId,
        )) {
          throw new InputError(`任务 ${taskId} 在等你回答问题，回答后才能继续`);
        }
        // Said here rather than silently parking it again: the owner has to pick a role
        // before this Task can go back into the queue.
        if (!hasRole(taskId)) throw new InputError(NO_ROLE_REASON);
        requireNoActiveRun(task, '继续');
        moveTask(taskId, 'queued');
        writeChange(db, 'task.resume', ctx, { taskId }, { from: task.state });
      });
    },

    // `unreachable` names the Task's unknown Run when the caller has just failed to
    // reach it: §4, the Task is given up all the same and the Run ends as lost. What may
    // still be alive out there is left to the round marker and the sweep on reconnect.
    abandonTask(taskId: string, reason: string | undefined, ctx: Ctx, unreachable?: { runId: string }): void {
      write(() => {
        const effectiveReason = isBlank(reason) ? (ctx.actor === 'console' ? '主人放弃' : '已放弃') : reason!.trim();
        const task = loadTask(taskId);
        if (task.state === 'done' || task.state === 'abandoned') {
          throw new InputError(`任务 ${taskId} 已关闭，不能放弃`);
        }
        const active = activeRun(task);
        const run = active && active.id === unreachable?.runId ? loadRun(active.id) : undefined;
        if (run?.state === 'unknown') {
          const at = nowIso();
          const error = JSON.parse(run.error_json ?? '{}') as UnknownMarks;
          const lost = { basis: 'abandoned', since: error.unreachable_since ?? error.unconfirmed_since, until: at };
          db.run(
            `UPDATE run SET state = 'ended', exit_kind = 'lost', ended_at = ?, error_json = ? WHERE id = ?`,
            at,
            JSON.stringify({ ...error, lost, reason: ABANDONED_RUN_REASON }),
            run.id,
          );
          const abandonedCapture=captureOf(run);if(abandonedCapture)db.run('UPDATE run SET capture_result_json = ? WHERE id = ?',JSON.stringify({version:1,source:abandonedCapture.source,complete:false,disposition:'not_adopted',reason:'task_abandoned'}),run.id);
          writeChange(db, 'run.settle', ctx, { taskId, runId: run.id }, {
            exit_code: null, exit_kind: 'lost', basis: lost.basis, task_state: 'abandoned',
          });
        } else {
          requireNoActiveRun(task, '放弃');
        }
        moveTask(taskId, 'abandoned', { reason: effectiveReason, closed: true });
        writeChange(db, 'task.abandon', ctx, { taskId }, { reason: effectiveReason });
        if (task.knowledge_json !== null) knowledge.abandonGateTask(taskId, effectiveReason, ctx);
      });
    },

    // Old history acquires custody only when its original Node actually reports raw
    // output. Migration, a retention deadline and a receipt's path confer no such right.
    confirmLegacyOutput(runDir: string, machineId: string, nodeId: string): void {
      const barriers = dispatchConditions();
      if (barriers.degraded || barriers.recovering) return;
      const parts = /^tasks\/([A-Za-z0-9_-]+)\/runs\/([A-Za-z0-9_-]+)$/.exec(runDir);
      if (!parts) return;
      const run = db.get<RunRow>('SELECT * FROM run WHERE id = ?', parts[2]!);
      const registration = currentMachine(machineId);
      if (!run || run.task_id !== parts[1] || run.state !== 'ended' || run.capture_result_json !== null
        || run.machine_id !== machineId || run.node_id !== nodeId || registration?.nodeId !== nodeId) return;
      try {
        const snapshot = JSON.parse(run.snapshot_json) as {machine_uid?: string} | null;
        if (!registration.uid || snapshot?.machine_uid !== registration.uid || captureOf(run)) return;
      } catch (error) { if (error instanceof SyntaxError || error instanceof InputError) return; throw error; }
      const task = loadTask(run.task_id);
      // A portable project never imports machine registrations. Matching this registration's
      // UID therefore admits local rounds after handoff, without granting imported history.
      if (!db.mayWriteProject(task.project_id)) return;
      try {
        write(() => {
          const refs = {taskId: run.task_id, runId: run.id};
          const retained = (reason: string): void => {
            if (!db.get("SELECT 1 FROM change WHERE run_id = ? AND action = 'run.output_retained' AND json_extract(detail_json, '$.reason') = ?", run.id, reason)) {
              writeChange(db, 'run.output_retained', RUNNER, refs, {legacy: true, reason});
            }
          };
          const original = db.get<{seq: number; task_id: string | null; action: string; detail_json: string | null}>(
            "SELECT seq, task_id, action, detail_json FROM change WHERE run_id = ? AND action IN ('run.settle', 'run.settle_late') ORDER BY seq LIMIT 1", run.id);
          let decision: {exit_kind?: unknown; exit_code?: unknown; reason?: unknown; basis?: unknown} = {};
          try {
            const parsed: unknown = JSON.parse(original?.detail_json ?? '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) decision = parsed;
          } catch { /* No usable original verdict. */ }
          if (!original || original.task_id !== run.task_id || decision.exit_kind !== run.exit_kind || decision.exit_code !== run.exit_code) {
            retained('原始结算裁决尚未核实，保留旧原始输出；请查看这一轮原结算记录并核对现场'); return;
          }
          let disposition: 'adopted' | 'not_adopted' | undefined;
          let reason: string | undefined;
          if (original.action === 'run.settle_late' && typeof decision.reason === 'string' && ['revision', 'task_state'].includes(decision.reason)) {
            disposition = 'not_adopted'; reason = '这一轮已因任务修订或状态变化被判为迟到，原结果未采用';
          } else if (original.action === 'run.settle' && run.exit_kind === 'lost'
            && typeof decision.basis === 'string' && ['seen', 'removed', 'presumed', 'not_started', 'abandoned', 'superseded'].includes(decision.basis)) {
            disposition = 'not_adopted'; reason = '这一轮已明确判定失联或未启动，原结果未采用';
          } else if (original.action === 'run.settle' && run.exit_kind === 'interrupted'
            && db.get("SELECT 1 FROM change WHERE run_id = ? AND task_id = ? AND action = 'run.stopping' AND seq < ?", run.id, run.task_id, original.seq)) {
            disposition = 'not_adopted'; reason = '主人已明确停止这一轮，原结果未采用';
          } else if (original.action === 'run.settle' && (run.exit_kind === 'quota' || run.exit_kind === 'auth')) {
            disposition = 'not_adopted';
            try {
              const marks = JSON.parse(run.error_json ?? '{}') as {reason?: unknown};
              reason = typeof marks?.reason === 'string' ? marks.reason
                : run.exit_kind === 'quota' ? '原结算已明确判定额度用完，原结果未采用' : '原结算已明确判定登录失效，原结果未采用';
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              reason = `原业务原因已损坏；原结算明确为 ${run.exit_kind}，原结果未采用`;
            }
          } else {
            const use = receiptUseOf(run);
            if (use.kind === 'not_used') { disposition = 'not_adopted'; reason = use.reason; }
            else if (use.kind === 'used') {
              // Only an adopted payload has a formal final-message body obligation.
              if (!hasFinalMessageReport(use.receipt)) disposition = 'adopted';
              else try {
                if (readRecordedReport(db, run)) disposition = 'adopted';
              } catch (error) { if (!(error instanceof InputError)) throw error; }
              if (!disposition) { retained('正式报告正文尚未核实，保留旧原始输出；请打开这一轮报告，尝试从原始输出恢复，成功后自动回收'); return; }
            }
          }
          if (!disposition) { retained('没有已保存的正式报告或明确的原始不采用裁决，保留旧原始输出；请查看这一轮报告和原结算记录'); return; }
          const proof: CaptureDisposition = {version: 1, source: 'legacy', legacy: true, complete: false, disposition, ...(reason ? {reason} : {})};
          db.run('UPDATE run SET capture_result_json = ? WHERE id = ? AND capture_result_json IS NULL', JSON.stringify(proof), run.id);
          writeChange(db, 'run.output_custody', RUNNER, refs, {...proof, summary: '已保存正式结算材料或原始不采用裁决，允许回收旧原始输出'});
        });
      } catch (error) {
        // An expected failed ledger write cannot grant disposal or make a healthy Node
        // look offline. Existing durable release proofs remain queryable on later polls.
        if (error instanceof DegradedError || !db.mayWriteProject(task.project_id)) return;
        throw error;
      }
    },

    outputRelease(runId:string, source:string|undefined, machineId:string,nodeId:string,runDir?:string):boolean {
      const run=db.get<RunRow>('SELECT * FROM run WHERE id = ?',runId);const registration=currentMachine(machineId);if(!registration||registration.nodeId!==nodeId)return false;
      if(!run){for(const row of db.all<{task_id:string;output_release_json:string}>("SELECT task_id,output_release_json FROM work_cleanup WHERE run_id=? AND output_release_json IS NOT NULL",runId)){if(source===undefined&&runDir!==undefined&&runDir!==`tasks/${row.task_id}/runs/${runId}`)continue;const proofs=JSON.parse(row.output_release_json) as Array<{source?:string;legacy?:true;machine_id:string;node_id:string;machine_uid:string;reason:string}>;if(proofs.some(proof=>proof.machine_id===machineId&&proof.node_id===nodeId&&proof.machine_uid===registration.uid&&typeof proof.reason==='string'&&(source===undefined?proof.legacy===true:proof.source===source)))return true;}return false;}
      if(source===undefined&&runDir!==undefined&&runDir!==`tasks/${run.task_id}/runs/${runId}`)return false;
      if(source){
        const old=db.get<{detail_json:string}>("SELECT detail_json FROM change WHERE run_id=? AND action='run.capture_release' AND json_extract(detail_json,'$.source')=? AND json_extract(detail_json,'$.machine_id')=? AND json_extract(detail_json,'$.node_id')=? AND json_extract(detail_json,'$.machine_uid')=? LIMIT 1",runId,source,machineId,nodeId,registration.uid);
        if(old)return true;
      }
      if(run.machine_id!==machineId||run.node_id!==nodeId||(JSON.parse(run.snapshot_json) as {machine_uid?:string}).machine_uid!==registration.uid||!run.capture_result_json)return false;
      try{const proof=JSON.parse(run.capture_result_json) as CaptureDisposition;return proof.version===1&&['adopted','not_adopted'].includes(proof.disposition)&&(source===undefined?proof.legacy===true:proof.source===source);}catch{return false;}
    },

    // The acceptance gate (§4): a product whose round's role asks for review needs a current
    // pass unless `withoutReview: true` is passed (allowed for the owner, and for the Router
    // whenever the project grants `accept`, audit-logged in the timeline).
    acceptTask(taskId: string, basis: string | undefined, ctx: Ctx, options: { withoutReview?: boolean } = {}): void {
      write(() => {
        const effectiveBasis = isBlank(basis) ? (ctx.actor === 'console' ? '主人验收通过' : '验收通过') : basis!.trim();
        const task = loadTask(taskId);
        // Allow explicitly accepting a product parked on a legacy review approval question.
        const reviewOverride = Boolean(options.withoutReview) && task.state === 'waiting_person' && reviewQuestionOpen(taskId);
        if (!reviewOverride) requireState(task, ['ready'], '验收');
        requireGrantOf(task, 'accept', ctx);
        if (!options.withoutReview) {
          const why = reviewGateOf(task);
          if (why !== null) throw new InputError(why);
        }
        // When every pass that opened the gate came from the executor that wrote the product
        // (roles-and-tiers.md §4 ②), the line says so: an acceptance the Router made under its
        // grant on such a pass is not one an independent review stood behind.
        const product = productOf(task);
        const opening = options.withoutReview ? [] : reviewsOf(taskId)
          .filter((review) => verdictRecord(review)?.result === 'pass' && productStale(parseReviewOf(review.review_of_json)!, product) === null)
          .map((review) => verdictRecord(review)!.same_executor);
        const sameExecutor = opening.length > 0 && opening.every((executor) => executor !== undefined) ? opening[0] : undefined;
        moveTask(taskId, 'done', { closed: true });
        writeChange(db, 'task.accept', ctx, { taskId }, {
          basis: effectiveBasis, ...(options.withoutReview ? { without_review: true } : {}), ...(sameExecutor === undefined ? {} : { same_executor: sameExecutor }),
        });
        const nth = db.get<{ n: number }>(`SELECT count(*) AS n FROM change WHERE task_id = ? AND action = 'task.accept'`, taskId)!.n;
        internalEvent(internalEvents.accepted(taskId, nth, effectiveBasis));
      });
    },

    // Whether the Router may take this step for this Task without asking (shared/grants.ts). The
    // owner always may; the gates in front of the step are the step's own and apply to anyone.
    requireGrant: (taskId: string, grant: GrantId, ctx: Ctx): void => requireGrantOf(loadTask(taskId), grant, ctx),

    // The gate in front of taking a Task's work into the main line, for every entrance.
    requireLandable: (taskId: string): void => requireLandable(loadTask(taskId)),

    reviewGate: (taskId: string): string | null => reviewGateOf(loadTask(taskId)),

    reviewGateInfo: (taskId: string): ReviewGateInfo | null => reviewGateInfoOf(loadTask(taskId)),

    activeReview: (taskId: string): TaskRow | null => activeReviewOf(loadTask(taskId)),

    // The pass a landing merges at: the review that covered the product the Task holds now,
    // if one did. Null when the Task needed no review (or was accepted without one).
    currentPass: (taskId: string): ReviewOf | null => currentPassOf(loadTask(taskId)),

    currentProduct: (taskId: string): Product => productOf(loadTask(taskId)),

    // What the host took over from a round, once it took it over whole and moved it into
    // the directory this id names: the files it left. The product's identity from then on,
    // and the commit point of the taking: until it commits, that directory is nobody's. A
    // taking that failed registers nothing, and leaves what an earlier one registered as it
    // was. Once the retention rule cleared this round's copies (service/retention.ts) no new
    // registration is taken: a taking that began before the mark must not put the bytes back.
    // The code is not among the files any more: a round's commit is reported in its receipt
    // and checked where it lives (service/accept.ts).
    registerArtifacts(runId: string, files: readonly BoundFile[], id: string = ulid()): string {
      return write(() => {
        const run = loadRun(runId);
        if (run.releases_dropped_at !== null) throw new InputError(artifactsDroppedText({ at: run.releases_dropped_at }));
        const registration: Registration = { id, at: nowIso(), files: files.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) };
        const held: RoundArtifacts = { registration, registered: [...roundArtifacts(run).registered, id], problem: null };
        db.run('UPDATE run SET artifacts_json = ? WHERE id = ?', JSON.stringify(held), runId);
        writeChange(db, 'run.artifacts', SERVICE, { taskId: run.task_id, runId }, registration);
        return registration.id;
      });
    },

    // Why the latest taking of a round failed: kept beside whatever an earlier one
    // registered, which it does not touch, so the page can say it after the one answer
    // that carried it.
    noteArtifactsProblem(runId: string, problem: string): void {
      write(() => {
        const run = loadRun(runId);
        const held: RoundArtifacts = { ...roundArtifacts(run), problem: { at: nowIso(), problem } };
        db.run('UPDATE run SET artifacts_json = ? WHERE id = ?', JSON.stringify(held), runId);
        writeChange(db, 'run.artifacts_problem', SERVICE, { taskId: run.task_id, runId }, { problem });
      });
    },

    // What the ledger holds of a round's artifacts; undefined for a Run it does not hold.
    artifactsOfRun(runId: string): HeldArtifacts | undefined {
      const run = db.get<RunRow>('SELECT * FROM run WHERE id = ?', runId);
      return run === undefined ? undefined : heldOf(run);
    },

    // The rounds of a Task the host took anything over from, or tried to, newest first.
    artifactsOf(taskId: string): HeldArtifacts[] {
      return db.all<RunRow>('SELECT * FROM run WHERE task_id = ? AND artifacts_json IS NOT NULL ORDER BY rowid DESC', taskId).map(heldOf);
    },

    // The rounds of work that ended at least the retention period ago, with the work's end and
    // the days in force now (docs/design/phase1-design.md "已结束的工作"), and the copies a
    // deleted project left: those are due at once, and outlive the rows that named them.
    retentionDue(now: Date = new Date()): { run_id: string; task_id: string; machine_id: string | null; node_id: string | null; code_dropped_at: string | null; ended_at: string; days: number }[] {
      const due = dueRunsOf(now).map(({ run, ended_at, days }) => ({
        run_id: run.id,
        task_id: run.task_id,
        machine_id: run.machine_id,
        node_id: run.node_id,
        code_dropped_at: run.code_dropped_at,
        ended_at,
        days,
      }));
      const deleted = db.all<{ run_id: string; task_id: string; machine_id: string | null; node_id: string | null; code_dropped_at: string | null; created_at: string }>(
        'SELECT run_id, task_id, machine_id, node_id, code_dropped_at, created_at FROM work_cleanup ORDER BY rowid',
      ).map((each) => ({ ...each, ended_at: each.created_at, days: 0 }));
      return [...due, ...deleted];
    },

    // The host's registered directories of deleted projects, still to be removed: the same
    // cleanup as a finished work's, but the Run row is gone, so the registrations are named by
    // the cleanup row. Cleared by the acceptor's sweep after the bytes are gone.
    deletedReleasesDue(): { cleanup_id: string; run_id: string; registrations: string[] }[] {
      return db.all<{ id: string; run_id: string; releases_json: string }>(
        'SELECT id, run_id, releases_json FROM work_cleanup WHERE releases_dropped_at IS NULL ORDER BY rowid',
      ).map(({ id, run_id, releases_json }) => ({ cleanup_id: id, run_id, registrations: JSON.parse(releases_json) as string[] }));
    },

    // The host's directories of a deleted project are gone: the commit point is after the
    // bytes, because the row says what to remove until it is removed (the same repeatable
    // removal as a machine's copy).
    noteDeletedReleasesDropped(ids: readonly string[]): void {
      if (ids.length === 0) return;
      write(() => {
        const marks = ids.map(() => '?').join(', ');
        db.run(`UPDATE work_cleanup SET releases_dropped_at = ? WHERE id IN (${marks})`, nowIso(), ...ids);
      });
    },

    createProjectFile(input: {
      id?: string;
      projectId: string;
      name: string;
      mime: string;
      size: number;
      sha256: string;
      kind: ProjectFileKind;
      origin: ProjectFileOrigin;
      summary?: string | null;
      messageId?: string | null;
    }): ProjectFileRow {
      return write(() => {
        if (!db.get('SELECT 1 FROM project WHERE id = ?', input.projectId)) {
          throw new InputError(`项目不存在：${input.projectId}`);
        }
        if (!isProjectFileKind(input.kind)) throw new InputError(`不支持的文件类型：${String(input.kind)}`);
        if (!isProjectFileOrigin(input.origin)) throw new InputError(`不支持的文件来源：${String(input.origin)}`);
        if (!Number.isSafeInteger(input.size) || input.size < 0) throw new InputError('文件大小不合法');
        const id = input.id ?? ulid();
        const at = nowIso();
        db.run(
          `INSERT INTO project_file (id, project_id, name, mime, size, sha256, kind, origin, summary, message_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.projectId,
          input.name,
          input.mime,
          input.size,
          input.sha256,
          input.kind,
          input.origin,
          input.summary ?? null,
          input.messageId ?? null,
          at,
          at,
        );
        db.noteNews();
        return db.get<ProjectFileRow>('SELECT * FROM project_file WHERE id = ?', id)!;
      });
    },

    updateProjectFile(
      projectId: string,
      fileId: string,
      patch: {
        name?: string;
        mime?: string;
        size?: number;
        sha256?: string;
        kind?: ProjectFileKind;
        summary?: string | null;
      },
    ): ProjectFileRow {
      return write(() => {
        const current = db.get<ProjectFileRow>('SELECT * FROM project_file WHERE project_id = ? AND id = ?', projectId, fileId);
        if (!current) throw new InputError(`文件不存在：${fileId}`);
        if (patch.kind !== undefined && !isProjectFileKind(patch.kind)) {
          throw new InputError(`不支持的文件类型：${String(patch.kind)}`);
        }
        if (patch.size !== undefined && (!Number.isSafeInteger(patch.size) || patch.size < 0)) {
          throw new InputError('文件大小不合法');
        }
        const at = nowIso();
        const next: ProjectFileRow = {
          ...current,
          name: patch.name ?? current.name,
          mime: patch.mime ?? current.mime,
          size: patch.size ?? current.size,
          sha256: patch.sha256 ?? current.sha256,
          kind: patch.kind ?? current.kind,
          summary: patch.summary === undefined ? current.summary : patch.summary,
          updated_at: at,
        };
        db.run(
          `UPDATE project_file SET name = ?, mime = ?, size = ?, sha256 = ?, kind = ?, summary = ?, updated_at = ?
           WHERE project_id = ? AND id = ?`,
          next.name,
          next.mime,
          next.size,
          next.sha256,
          next.kind,
          next.summary,
          next.updated_at,
          projectId,
          fileId,
        );
        db.noteNews();
        return next;
      });
    },

    findProjectFileByName(projectId: string, name: string): ProjectFileRow | null {
      return db.get<ProjectFileRow>(
        'SELECT * FROM project_file WHERE project_id = ? AND name = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
        projectId,
        name,
      ) ?? null;
    },

    getProjectFile(projectId: string, fileId: string): ProjectFileRow | null {
      return db.get<ProjectFileRow>('SELECT * FROM project_file WHERE project_id = ? AND id = ?', projectId, fileId) ?? null;
    },

    listProjectFiles(projectId: string): ProjectFileRow[] {
      return db.all<ProjectFileRow>(
        'SELECT * FROM project_file WHERE project_id = ? ORDER BY updated_at DESC, id DESC',
        projectId,
      );
    },

    listProjectFilesByIds(projectId: string, ids: readonly string[]): ProjectFileRow[] {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      const marks = unique.map(() => '?').join(', ');
      return db.all<ProjectFileRow>(
        `SELECT * FROM project_file WHERE project_id = ? AND id IN (${marks})`,
        projectId,
        ...unique,
      );
    },

    linkProjectFilesToMessage(projectId: string, fileIds: readonly string[], messageId: string): void {
      const unique = [...new Set(fileIds)];
      if (unique.length === 0) return;
      write(() => {
        const marks = unique.map(() => '?').join(', ');
        db.run(
          `UPDATE project_file SET message_id = ? WHERE project_id = ? AND id IN (${marks}) AND message_id IS NULL`,
          messageId,
          projectId,
          ...unique,
        );
      });
    },

    attachFilesToMessage(projectId: string, messageId: string, fileIds: readonly string[]): void {
      const unique = [...new Set(fileIds.filter((id) => typeof id === 'string' && id.trim() !== ''))];
      if (unique.length === 0) return;
      write(() => {
        const msg = db.get<{ project_id: string | null; attachments_json: string | null }>(
          'SELECT project_id, attachments_json FROM message WHERE id = ?',
          messageId,
        );
        if (!msg) throw new InputError(`消息不存在：${messageId}`);
        if (msg.project_id !== projectId) throw new InputError(`消息不属于项目：${projectId}`);
        const marks = unique.map(() => '?').join(', ');
        const found = db.all<{ id: string }>(
          `SELECT id FROM project_file WHERE project_id = ? AND id IN (${marks})`,
          projectId,
          ...unique,
        );
        if (found.length !== unique.length) {
          const present = new Set(found.map((row) => row.id));
          const missing = unique.filter((id) => !present.has(id));
          throw new InputError(`文件不存在：${missing.join('、')}`);
        }
        const existing = msg.attachments_json ? (JSON.parse(msg.attachments_json) as string[]) : [];
        const merged = [...new Set([...existing, ...unique])];
        db.run('UPDATE message SET attachments_json = ? WHERE id = ?', JSON.stringify(merged), messageId);
        db.run(
          `UPDATE project_file SET message_id = ? WHERE project_id = ? AND id IN (${marks}) AND message_id IS NULL`,
          messageId,
          projectId,
          ...unique,
        );
        db.noteNews();
      });
    },

    // ---- IM group bindings & ambient group context ring buffer ----

    listImGroupBindings(projectId?: string): ImGroupBindingView[] {
      const rows = projectId === undefined
        ? db.all<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} ORDER BY b.rowid`)
        : db.all<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} WHERE b.project_id = ? ORDER BY b.rowid`, projectId);
      return rows.map(imGroupBindingView);
    },

    getImGroupBinding(id: string): ImGroupBindingView {
      const row = db.get<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} WHERE b.id = ?`, id);
      if (!row) throw new InputError(`群聊绑定不存在：${id}`);
      return imGroupBindingView(row);
    },

    findImGroupBinding(channel: ImChannel, chatId: string): ImGroupBindingView | undefined {
      const row = db.get<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} WHERE b.channel = ? AND b.chat_id = ?`, channel, chatId);
      return row ? imGroupBindingView(row) : undefined;
    },

    mayWriteProject(projectId: string): boolean {
      return db.mayWriteProject(projectId);
    },

    createImGroupBinding(input: ImGroupBindingInput, ctx: Ctx): ImGroupBindingView {
      return write(() => {
        if (!isImChannel(input.channel)) throw new InputError(`不支持的消息通道：${String(input.channel)}`);
        if (!isGroupCapableChannel(input.channel)) {
          throw new InputError('当前通道（微信）暂只支持私聊，不支持群聊绑定；群聊绑定目前支持企业微信');
        }
        if (typeof input.chat_id !== 'string' || input.chat_id.trim() === '') throw new InputError('群聊 chat_id 不能为空');
        const chatId = input.chat_id.trim();
        if (chatId.length > IM_CHAT_ID_MAX_CHARS) throw new InputError(`群聊 chat_id 最多 ${IM_CHAT_ID_MAX_CHARS} 个字符`);
        if (input.chat_name !== undefined && typeof input.chat_name !== 'string') throw new InputError('群聊名称必须是文字');
        const chatName = (input.chat_name ?? '').trim();
        if (chatName.length > IM_CHAT_NAME_MAX_CHARS) throw new InputError(`群聊名称最多 ${IM_CHAT_NAME_MAX_CHARS} 个字符`);
        if (typeof input.project_id !== 'string' || input.project_id.trim() === '') throw new InputError('项目编号不能为空');
        const projectId = input.project_id.trim();
        if (!db.get('SELECT 1 FROM project WHERE id = ?', projectId)) throw new InputError(`项目不存在：${projectId}`);
        const existing = db.get<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} WHERE b.channel = ? AND b.chat_id = ?`, input.channel, chatId);
        if (existing) throw new InputError(`该群聊已绑定到项目“${existing.project_name}”`);

        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new InputError('enabled 必须是开关值');
        const enabled = input.enabled ?? true;
        const triggerMode = input.trigger_mode ?? 'mention_only';
        if (!isImGroupTriggerMode(triggerMode)) throw new InputError(`不支持的群触发模式：${String(triggerMode)}`);
        if (input.allow_all_senders !== undefined && typeof input.allow_all_senders !== 'boolean') throw new InputError('allow_all_senders 必须是开关值');
        const allowAllSenders = input.allow_all_senders ?? false;
        const sendersCheck = validateAllowedSenders(input.allowed_senders ?? []);
        if (!sendersCheck.ok) throw new InputError(sendersCheck.error);
        const keywordsCheck = validateRuleKeywords(input.rule_keywords ?? []);
        if (!keywordsCheck.ok) throw new InputError(keywordsCheck.error);
        const cooldownCheck = validateCooldownSeconds(input.cooldown_seconds ?? 60);
        if (!cooldownCheck.ok) throw new InputError(cooldownCheck.error);
        const inlineCountCheck = validateInlineContextCount(input.inline_context_count ?? 6);
        if (!inlineCountCheck.ok) throw new InputError(inlineCountCheck.error);
        if (input.accept_media !== undefined && typeof input.accept_media !== 'boolean') throw new InputError('accept_media 必须是开关值');
        const acceptMedia = input.accept_media ?? true;
        if (input.notify_events !== undefined && typeof input.notify_events !== 'boolean') throw new InputError('notify_events 必须是开关值');
        const notifyEvents = input.notify_events ?? true;

        const id = ulid();
        const at = nowIso();
        db.run(
          `INSERT INTO im_group_binding (
            id, created_at, updated_at, channel, chat_id, chat_name, project_id,
            enabled, trigger_mode, allow_all_senders, allowed_senders_json, rule_keywords_json,
            cooldown_seconds, inline_context_count, accept_media, notify_events
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, at, at, input.channel, chatId, chatName, projectId,
          enabled ? 1 : 0, triggerMode, allowAllSenders ? 1 : 0,
          JSON.stringify(sendersCheck.value), JSON.stringify(keywordsCheck.value),
          cooldownCheck.value, inlineCountCheck.value, acceptMedia ? 1 : 0, notifyEvents ? 1 : 0,
        );
        writeChange(db, 'im.group_binding.create', ctx, {}, {
          binding_id: id, project_id: projectId, channel: input.channel, chat_id: chatId, chat_name: chatName,
        });
        return imGroupBindingView(db.get<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} WHERE b.id = ?`, id)!);
      });
    },

    updateImGroupBinding(id: string, patch: ImGroupBindingPatch, ctx: Ctx): ImGroupBindingView {
      return write(() => {
        const current = db.get<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} WHERE b.id = ?`, id);
        if (!current) throw new InputError(`群聊绑定不存在：${id}`);

        let chatName = current.chat_name;
        if (patch.chat_name !== undefined) {
          if (typeof patch.chat_name !== 'string') throw new InputError('群聊名称必须是文字');
          chatName = patch.chat_name.trim();
          if (chatName.length > IM_CHAT_NAME_MAX_CHARS) throw new InputError(`群聊名称最多 ${IM_CHAT_NAME_MAX_CHARS} 个字符`);
        }
        let projectId = current.project_id;
        if (patch.project_id !== undefined) {
          if (typeof patch.project_id !== 'string' || patch.project_id.trim() === '') throw new InputError('项目编号不能为空');
          projectId = patch.project_id.trim();
          if (!db.get('SELECT 1 FROM project WHERE id = ?', projectId)) throw new InputError(`项目不存在：${projectId}`);
        }
        if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new InputError('enabled 必须是开关值');
        const enabled = patch.enabled === undefined ? current.enabled === 1 : patch.enabled;
        const triggerMode = patch.trigger_mode ?? current.trigger_mode;
        if (!isImGroupTriggerMode(triggerMode)) throw new InputError(`不支持的群触发模式：${String(triggerMode)}`);
        if (patch.allow_all_senders !== undefined && typeof patch.allow_all_senders !== 'boolean') throw new InputError('allow_all_senders 必须是开关值');
        const allowAllSenders = patch.allow_all_senders === undefined ? current.allow_all_senders === 1 : patch.allow_all_senders;
        const allowedSenders = patch.allowed_senders === undefined
          ? (JSON.parse(current.allowed_senders_json) as string[])
          : (() => {
            const check = validateAllowedSenders(patch.allowed_senders);
            if (!check.ok) throw new InputError(check.error);
            return check.value;
          })();
        const ruleKeywords = patch.rule_keywords === undefined
          ? (JSON.parse(current.rule_keywords_json) as string[])
          : (() => {
            const check = validateRuleKeywords(patch.rule_keywords);
            if (!check.ok) throw new InputError(check.error);
            return check.value;
          })();
        const cooldownSeconds = patch.cooldown_seconds === undefined
          ? current.cooldown_seconds
          : (() => {
            const check = validateCooldownSeconds(patch.cooldown_seconds);
            if (!check.ok) throw new InputError(check.error);
            return check.value;
          })();
        const inlineContextCount = patch.inline_context_count === undefined
          ? current.inline_context_count
          : (() => {
            const check = validateInlineContextCount(patch.inline_context_count);
            if (!check.ok) throw new InputError(check.error);
            return check.value;
          })();
        if (patch.accept_media !== undefined && typeof patch.accept_media !== 'boolean') throw new InputError('accept_media 必须是开关值');
        const acceptMedia = patch.accept_media === undefined ? current.accept_media === 1 : patch.accept_media;
        if (patch.notify_events !== undefined && typeof patch.notify_events !== 'boolean') throw new InputError('notify_events 必须是开关值');
        const notifyEvents = patch.notify_events === undefined ? current.notify_events === 1 : patch.notify_events;

        const nextSendersJson = JSON.stringify(allowedSenders);
        const nextKeywordsJson = JSON.stringify(ruleKeywords);
        const changedFields = [
          ...(chatName === current.chat_name ? [] : ['chat_name']),
          ...(projectId === current.project_id ? [] : ['project_id']),
          ...((enabled ? 1 : 0) === current.enabled ? [] : ['enabled']),
          ...(triggerMode === current.trigger_mode ? [] : ['trigger_mode']),
          ...((allowAllSenders ? 1 : 0) === current.allow_all_senders ? [] : ['allow_all_senders']),
          ...(nextSendersJson === current.allowed_senders_json ? [] : ['allowed_senders']),
          ...(nextKeywordsJson === current.rule_keywords_json ? [] : ['rule_keywords']),
          ...(cooldownSeconds === current.cooldown_seconds ? [] : ['cooldown_seconds']),
          ...(inlineContextCount === current.inline_context_count ? [] : ['inline_context_count']),
          ...((acceptMedia ? 1 : 0) === current.accept_media ? [] : ['accept_media']),
          ...((notifyEvents ? 1 : 0) === current.notify_events ? [] : ['notify_events']),
        ];
        if (changedFields.length === 0) return imGroupBindingView(current);

        db.run(
          `UPDATE im_group_binding
           SET updated_at = ?, chat_name = ?, project_id = ?, enabled = ?, trigger_mode = ?,
               allow_all_senders = ?, allowed_senders_json = ?, rule_keywords_json = ?,
               cooldown_seconds = ?, inline_context_count = ?, accept_media = ?, notify_events = ?
           WHERE id = ?`,
          nowIso(), chatName, projectId, enabled ? 1 : 0, triggerMode,
          allowAllSenders ? 1 : 0, nextSendersJson, nextKeywordsJson,
          cooldownSeconds, inlineContextCount, acceptMedia ? 1 : 0, notifyEvents ? 1 : 0,
          id,
        );
        writeChange(db, 'im.group_binding.update', ctx, {}, {
          binding_id: id, project_id: projectId, fields: changedFields,
        });
        return imGroupBindingView(db.get<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} WHERE b.id = ?`, id)!);
      });
    },

    deleteImGroupBinding(id: string, ctx: Ctx): void {
      write(() => {
        const current = db.get<ImGroupBindingRow>(`${IM_GROUP_BINDING_SELECT} WHERE b.id = ?`, id);
        if (!current) throw new InputError(`群聊绑定不存在：${id}`);
        db.run('DELETE FROM im_group_binding WHERE id = ?', id);
        writeChange(db, 'im.group_binding.delete', ctx, {}, {
          binding_id: id, project_id: current.project_id, channel: current.channel, chat_id: current.chat_id, chat_name: current.chat_name,
        });
      });
    },

    touchImGroupBindingTriggered(id: string, atIso?: string): void {
      write(() => {
        db.run('UPDATE im_group_binding SET last_triggered_at = ? WHERE id = ?', atIso ?? nowIso(), id);
      });
    },

    listProjectBroadcastGroups(projectId: string, groupIds?: readonly string[]): ImGroupBindingView[] {
      const rows = groupIds && groupIds.length > 0
        ? (() => {
          const unique = [...new Set(groupIds)];
          const marks = unique.map(() => '?').join(', ');
          return db.all<ImGroupBindingRow>(
            `${IM_GROUP_BINDING_SELECT} WHERE b.project_id = ? AND b.enabled = 1 AND b.notify_events = 1 AND b.id IN (${marks}) ORDER BY b.rowid`,
            projectId,
            ...unique,
          );
        })()
        : db.all<ImGroupBindingRow>(
          `${IM_GROUP_BINDING_SELECT} WHERE b.project_id = ? AND b.enabled = 1 AND b.notify_events = 1 ORDER BY b.rowid`,
          projectId,
        );
      return rows.map(imGroupBindingView).filter((binding) => isGroupCapableChannel(binding.channel));
    },

    // Actively broadcast a colleague-facing update from the project's Router to authorized
    // bound groups (`enabled = 1` AND `notify_events = 1`). Private console links are
    // stripped by `notify.render` for group targets.
    postGroupUpdate(
      projectId: string,
      input: { content: string; chatId?: string; channel?: ImChannel; taskId?: string },
      ctx: Ctx,
    ): { sent: { channel: ImChannel; chat_id: string; chat_name: string | null }[] } {
      const content = typeof input.content === 'string' ? input.content.trim() : '';
      if (!content) throw new InputError('播报内容不能为空');
      if (content.length > 8000) throw new InputError('播报内容过长（最多 8000 字）');
      const taskId = input.taskId?.trim() || undefined;
      if (taskId !== undefined) {
        const task = loadTask(taskId);
        if (task.project_id !== projectId) throw new InputError(`任务 ${taskId} 不属于当前项目`);
      }
      let groups = api.listProjectBroadcastGroups(projectId);
      if (input.channel !== undefined) groups = groups.filter((g) => g.channel === input.channel);
      if (input.chatId !== undefined && input.chatId.trim() !== '') {
        const want = input.chatId.trim();
        groups = groups.filter((g) => g.chat_id === want);
      }
      if (groups.length === 0) {
        throw new InputError(
          input.chatId || input.channel
            ? '指定的群未绑定到本项目、未启用，或未开启“接收告警/结果播报”'
            : '本项目没有已启用且开启“接收告警/结果播报”的绑定群聊',
        );
      }
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 12);
      const sent = groups.map((g) => ({ channel: g.channel, chat_id: g.chat_id, chat_name: g.chat_name }));
      write(() => {
        for (const group of groups) {
          enqueueNotification(group.channel, 'markdown', {
            external_id: `group-update:${ctx.messageId ?? ulid()}:${group.channel}:${group.chat_id}:${digest}`,
            target: { chatid: group.chat_id, chat_type: 2 },
            content,
            project_id: projectId,
            path: taskId ? `/task/${taskId}` : `/projects/${projectId}`,
          });
        }
        writeChange(
          db,
          'im.group_broadcast',
          ctx,
          taskId ? { taskId } : {},
          { project_id: projectId, targets: sent.map(({ channel, chat_id }) => ({ channel, chat_id })) },
        );
      });
      return { sent };
    },

    // Resolve authorized bound groups that should receive the final conclusion of a Task:
    // 1. Ancestor `trigger_fire_id` whose fire had `broadcast_groups = 1` (respecting `broadcast_group_ids`);
    // 2. Ancestor `task.create` message originating from a bound group chat with `notify_events = 1`.
    taskBroadcastTargets(
      taskId: string,
    ): { channel: ImChannel; chat_id: string; chat_name: string | null; source: 'trigger' | 'group_mention'; trigger_name?: string }[] {
      const chain: TaskRow[] = [];
      let cur: TaskRow | undefined = db.get<TaskRow>('SELECT * FROM task WHERE id = ?', taskId);
      while (cur) {
        chain.push(cur);
        cur = cur.parent_id ? db.get<TaskRow>('SELECT * FROM task WHERE id = ?', cur.parent_id) : undefined;
      }
      const projectId = chain[0]?.project_id ?? null;
      if (projectId === null) return [];
      const seen = new Set<string>();
      const out: { channel: ImChannel; chat_id: string; chat_name: string | null; source: 'trigger' | 'group_mention'; trigger_name?: string }[] = [];
      const add = (g: ImGroupBindingView, source: 'trigger' | 'group_mention', triggerName?: string): void => {
        const key = `${g.channel}:${g.chat_id}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ channel: g.channel, chat_id: g.chat_id, chat_name: g.chat_name, source, ...(triggerName ? { trigger_name: triggerName } : {}) });
      };

      for (const row of chain) {
        if (row.trigger_fire_id !== null) {
          const fire = db.get<{ broadcast_groups: number; broadcast_group_ids_json: string | null; trigger_name: string | null }>(
            `SELECT f.broadcast_groups, f.broadcast_group_ids_json, COALESCE(r.name, s.name) AS trigger_name
             FROM trigger_fire f
             LEFT JOIN trigger_rule r ON r.id = f.trigger_id
             LEFT JOIN inbound_source s ON s.id = f.source_id
             WHERE f.id = ?`,
            row.trigger_fire_id,
          );
          if (fire && fire.broadcast_groups === 1) {
            let ids: string[] = [];
            if (fire.broadcast_group_ids_json) {
              try {
                const parsed = JSON.parse(fire.broadcast_group_ids_json);
                if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
              } catch { /* ignore malformed */ }
            }
            for (const g of api.listProjectBroadcastGroups(projectId, ids)) {
              add(g, 'trigger', fire.trigger_name ?? undefined);
            }
          }
        }
        const origin = db.get<{ channel: string; thread: string | null; actor: string | null }>(
          `SELECT m.channel, m.thread, m.actor
           FROM change c JOIN message m ON m.id = c.message_id
           WHERE c.task_id = ? AND c.action = 'task.create' AND c.message_id IS NOT NULL
           ORDER BY c.seq ASC LIMIT 1`,
          row.id,
        );
        if (origin && isImChannel(origin.channel) && isGroupCapableChannel(origin.channel) && origin.thread && origin.thread !== origin.actor) {
          const match = api.listProjectBroadcastGroups(projectId).find(
            (g) => g.channel === origin.channel && g.chat_id === origin.thread,
          );
          if (match) add(match, 'group_mention');
        }
      }
      return out;
    },

    recordImGroupContext(entry: {
      channel: ImChannel;
      chatId: string;
      externalId: string;
      actor: string;
      actorName?: string;
      text: string;
      mentionedBot: boolean;
      replyToExternalId?: string;
      attachmentsMeta?: ImAttachmentRef[];
      messageId?: string;
      projectId?: string;
    }): { id: string; fresh: boolean } {
      return write(() => {
        const existing = db.get<{ id: string }>(
          'SELECT id FROM im_group_context WHERE channel = ? AND chat_id = ? AND external_id = ?',
          entry.channel, entry.chatId, entry.externalId,
        );
        if (existing) return { id: existing.id, fresh: false };
        const id = ulid();
        const at = nowIso();
        const attachmentsMetaJson = entry.attachmentsMeta && entry.attachmentsMeta.length > 0
          ? JSON.stringify(entry.attachmentsMeta)
          : null;
        db.run(
          `INSERT INTO im_group_context (
            id, created_at, channel, chat_id, external_id, actor, actor_name, text,
            mentioned_bot, reply_to_external_id, attachments_meta_json, message_id, project_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, at, entry.channel, entry.chatId, entry.externalId, entry.actor, entry.actorName ?? null, entry.text,
          entry.mentionedBot ? 1 : 0, entry.replyToExternalId ?? null, attachmentsMetaJson,
          entry.messageId ?? null, entry.projectId ?? null,
        );
        db.run(
          `DELETE FROM im_group_context
           WHERE channel = ? AND chat_id = ?
             AND id NOT IN (
               SELECT id FROM im_group_context
               WHERE channel = ? AND chat_id = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?
             )`,
          entry.channel, entry.chatId, entry.channel, entry.chatId, IM_GROUP_CONTEXT_RING_MAX,
        );
        return { id, fresh: true };
      });
    },

    linkImGroupContextMessage(contextId: string, messageId: string, projectId: string): void {
      write(() => {
        db.run('UPDATE im_group_context SET message_id = ?, project_id = ? WHERE id = ?', messageId, projectId, contextId);
      });
    },

    recentImGroupContext(
      channel: ImChannel,
      chatId: string,
      opts?: { beforeId?: string; excludeExternalId?: string; limit?: number },
    ): ImGroupContextRow[] {
      if (opts?.limit !== undefined && opts.limit <= 0) return [];
      const limit = Math.max(1, Math.min(50, Math.floor(opts?.limit ?? 20)));
      const filters = ['channel = ?', 'chat_id = ?'];
      const params: (string | number)[] = [channel, chatId];
      if (opts?.beforeId !== undefined) {
        const anchor = db.get<{ created_at: string; id: string }>(
          'SELECT created_at, id FROM im_group_context WHERE id = ? AND channel = ? AND chat_id = ?',
          opts.beforeId, channel, chatId,
        );
        if (!anchor) return [];
        filters.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(anchor.created_at, anchor.created_at, anchor.id);
      }
      if (opts?.excludeExternalId !== undefined) {
        filters.push('external_id != ?');
        params.push(opts.excludeExternalId);
      }
      return db.all<ImGroupContextRow>(
        `SELECT * FROM im_group_context WHERE ${filters.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...params,
        limit,
      ).reverse();
    },

    findImGroupContextByExternalId(channel: ImChannel, chatId: string, externalId: string): ImGroupContextRow | undefined {
      return db.get<ImGroupContextRow>(
        'SELECT * FROM im_group_context WHERE channel = ? AND chat_id = ? AND external_id = ?',
        channel, chatId, externalId,
      );
    },

    readGroupContextForProject(
      projectId: string,
      opts: { channel?: ImChannel; chatId?: string; beforeId?: string; replyToExternalId?: string; limit?: number } = {},
    ): {
      binding: { channel: ImChannel; chat_id: string; chat_name: string };
      items: SafeImGroupContextItem[];
      next_before_id: string | null;
    } {
      if (opts.channel !== undefined && !isImChannel(opts.channel)) {
        throw new InputError(`不支持的消息通道：${String(opts.channel)}`);
      }
      const bindings = db.all<ImGroupBindingRow>(
        `${IM_GROUP_BINDING_SELECT} WHERE b.project_id = ? ORDER BY b.rowid`,
        projectId,
      );
      let binding: ImGroupBindingRow | undefined;
      if (opts.chatId !== undefined) {
        const matched = bindings.filter(
          (row) => row.chat_id === opts.chatId && (opts.channel === undefined || row.channel === opts.channel),
        );
        if (matched.length === 0) throw new InputError('当前项目未绑定该群聊，无权读取其上下文');
        if (matched.length > 1) throw new InputError('同一群号匹配到多个消息通道，请指明 channel');
        binding = matched[0];
      } else {
        const matched = opts.channel === undefined ? bindings : bindings.filter((row) => row.channel === opts.channel);
        if (matched.length === 0) throw new InputError('当前项目未绑定任何群聊');
        if (matched.length > 1) throw new InputError('当前项目绑定了多个群聊，请指明 chat_id');
        binding = matched[0];
      }

      const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 20)));
      let rows: ImGroupContextRow[] = [];
      let hasMore = false;

      if (opts.replyToExternalId !== undefined) {
        const anchor = db.get<{ created_at: string; id: string }>(
          'SELECT created_at, id FROM im_group_context WHERE channel = ? AND chat_id = ? AND external_id = ?',
          binding!.channel, binding!.chat_id, opts.replyToExternalId,
        );
        if (anchor) {
          const fetched = db.all<ImGroupContextRow>(
            `SELECT * FROM im_group_context
             WHERE channel = ? AND chat_id = ?
               AND (created_at < ? OR (created_at = ? AND id <= ?))
             ORDER BY created_at DESC, id DESC LIMIT ?`,
            binding!.channel, binding!.chat_id, anchor.created_at, anchor.created_at, anchor.id, limit + 1,
          );
          hasMore = fetched.length > limit;
          rows = (hasMore ? fetched.slice(0, limit) : fetched).reverse();
        }
      } else {
        const filters = ['channel = ?', 'chat_id = ?'];
        const params: (string | number)[] = [binding!.channel, binding!.chat_id];
        if (opts.beforeId !== undefined) {
          const anchor = db.get<{ created_at: string; id: string }>(
            'SELECT created_at, id FROM im_group_context WHERE id = ? AND channel = ? AND chat_id = ?',
            opts.beforeId, binding!.channel, binding!.chat_id,
          );
          if (anchor) {
            filters.push('(created_at < ? OR (created_at = ? AND id < ?))');
            params.push(anchor.created_at, anchor.created_at, anchor.id);
          } else {
            return {
              binding: { channel: binding!.channel, chat_id: binding!.chat_id, chat_name: binding!.chat_name },
              items: [],
              next_before_id: null,
            };
          }
        }
        const fetched = db.all<ImGroupContextRow>(
          `SELECT * FROM im_group_context WHERE ${filters.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
          ...params,
          limit + 1,
        );
        hasMore = fetched.length > limit;
        rows = (hasMore ? fetched.slice(0, limit) : fetched).reverse();
      }

      const linkedMessageIds = [
        ...new Set(
          rows
            .filter((row) => row.project_id === projectId && row.message_id !== null)
            .map((row) => row.message_id!),
        ),
      ];
      const tasksByMessage = new Map<string, string[]>();
      if (linkedMessageIds.length > 0) {
        const marks = linkedMessageIds.map(() => '?').join(', ');
        const addTask = (messageId: string, taskId: string): void => {
          const list = tasksByMessage.get(messageId) ?? [];
          if (!list.includes(taskId)) list.push(taskId);
          tasksByMessage.set(messageId, list);
        };
        for (const row of db.all<{ message_id: string; task_id: string }>(
          `SELECT c.message_id, c.task_id
           FROM change c
           JOIN task t ON t.id = c.task_id
           WHERE c.message_id IN (${marks}) AND c.task_id IS NOT NULL AND t.project_id = ?
           ORDER BY c.seq`,
          ...linkedMessageIds,
          projectId,
        )) {
          addTask(row.message_id, row.task_id);
        }
        for (const row of db.all<{ id: string; task_id: string }>(
          `SELECT m.id, m.task_id
           FROM message m
           JOIN task t ON t.id = m.task_id
           WHERE m.id IN (${marks}) AND m.task_id IS NOT NULL AND t.project_id = ?`,
          ...linkedMessageIds,
          projectId,
        )) {
          addTask(row.id, row.task_id);
        }
      }

      const items: SafeImGroupContextItem[] = rows.map((row) => {
        const sameProject = row.project_id === projectId;
        const messageId = sameProject ? row.message_id : null;
        return {
          id: row.id,
          created_at: row.created_at,
          channel: row.channel,
          chat_id: row.chat_id,
          external_id: row.external_id,
          actor: row.actor,
          actor_name: row.actor_name,
          text: row.text,
          mentioned_bot: row.mentioned_bot,
          reply_to_external_id: row.reply_to_external_id,
          attachments: sanitizeGroupContextAttachments(row.attachments_meta_json),
          message_id: messageId,
          project_id: sameProject ? row.project_id : null,
          linked_task_ids: messageId === null ? [] : (tasksByMessage.get(messageId) ?? []),
        };
      });
      const next_before_id = hasMore && items.length > 0 ? items[0]!.id : null;
      return {
        binding: { channel: binding!.channel, chat_id: binding!.chat_id, chat_name: binding!.chat_name },
        items,
        next_before_id,
      };
    },

    listDiscoveredImGroups(): DiscoveredImGroup[] {
      return db.all<DiscoveredImGroup>(
        `SELECT
           c.channel,
           c.chat_id,
           MAX(c.created_at) AS last_seen_at,
           COUNT(*) AS message_count,
           (SELECT c2.actor FROM im_group_context c2
            WHERE c2.channel = c.channel AND c2.chat_id = c.chat_id
            ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1) AS last_actor,
           (SELECT c2.text FROM im_group_context c2
            WHERE c2.channel = c.channel AND c2.chat_id = c.chat_id
            ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1) AS last_text
         FROM im_group_context c
         WHERE c.channel IN ('wecom', 'weixin')
           AND NOT EXISTS (
             SELECT 1 FROM im_group_binding b
             WHERE b.channel = c.channel AND b.chat_id = c.chat_id
           )
         GROUP BY c.channel, c.chat_id
         ORDER BY last_seen_at DESC, MAX(c.id) DESC
         LIMIT 50`,
      );
    },

    deleteProjectFile(projectId: string, fileId: string): ProjectFileRow | null {
      return write(() => {
        const row = db.get<ProjectFileRow>('SELECT * FROM project_file WHERE project_id = ? AND id = ?', projectId, fileId);
        if (!row) return null;
        db.run('DELETE FROM project_file WHERE project_id = ? AND id = ?', projectId, fileId);
        db.noteNews();
        return row;
      });
    },

    deletedProjectFilesDue(): { project_id: string; project_name: string }[] {
      return db.all<{ project_id: string; project_name: string }>(
        'SELECT project_id, project_name FROM project_files_cleanup WHERE dropped_at IS NULL ORDER BY rowid',
      );
    },

    // Automatically expire ephemeral chat attachments (upload bound to a message) and legacy
    // routine worker stage-report docs older than cutoffIso. Curated project docs, standalone
    // uploads, and interactive HTML/SVG artifacts are never touched.
    purgeExpiredEphemeralFiles(cutoffIso: string): { project_id: string; id: string }[] {
      return write(() => {
        const rows = db.all<{ project_id: string; id: string }>(
          `SELECT project_id, id FROM project_file
           WHERE created_at < ?
             AND ((kind = 'upload' AND message_id IS NOT NULL)
               OR (origin = 'worker' AND kind = 'doc'))`,
          cutoffIso,
        );
        if (rows.length === 0) return [];
        for (const row of rows) {
          db.run('DELETE FROM project_file WHERE project_id = ? AND id = ?', row.project_id, row.id);
        }
        db.noteNews();
        return rows;
      });
    },

    noteDeletedProjectFilesDropped(projectIds: readonly string[]): void {
      if (projectIds.length === 0) return;
      write(() => {
        const marks = projectIds.map(() => '?').join(', ');
        db.run(`UPDATE project_files_cleanup SET dropped_at = ? WHERE project_id IN (${marks})`, nowIso(), ...projectIds);
      });
    },

    // The host's copies of due work, marked and audited in one transaction: the commit point
    // of that cleanup, and it comes before the directories are removed. A crash in between
    // leaves them to the next sweep, never bytes gone without the ledger saying so; the
    // ledger must not call a round cleared while its files are still there. A round already
    // marked, or one that registered nothing, is not here.
    dropDueReleases(now: Date = new Date()): { run_id: string; task_id: string; registration: string; ended_at: string; days: number }[] {
      return write(() => {
        const at = nowIso();
        const marked: { run_id: string; task_id: string; registration: string; ended_at: string; days: number }[] = [];
        for (const { run, ended_at, days } of dueRunsOf(now)) {
          if (run.releases_dropped_at !== null) continue;
          const registration = roundArtifacts(run).registration;
          if (registration === null) continue;
          db.run('UPDATE run SET releases_dropped_at = ? WHERE id = ?', at, run.id);
          writeChange(db, 'run.releases_drop', SERVICE, { taskId: run.task_id, runId: run.id }, { registration: registration.id, days, ended_at });
          marked.push({ run_id: run.id, task_id: run.task_id, registration: registration.id, ended_at, days });
        }
        return marked;
      });
    },

    // The machine's copy of one Task's code is gone: every round of it bound to that very place
    // (the same machine registration and node identity) is marked in one transaction, with one
    // change. Written only after the machine confirmed the removal: the bytes are not this
    // host's to see, and the command may be repeated, so the order is the other way round
    // from the host's copies. A pass whose mark failed asks again and records then — the
    // directory already gone is a success. `code_dropped_at` is audit for the timeline only;
    // no page shows a machine copy's state.
    noteTaskCodeDropped(taskId: string, machineId: string, nodeId: string): string[] {
      return write(() => {
        const runs = db.all<Pick<RunRow, 'id'>>(
          'SELECT id FROM run WHERE task_id = ? AND machine_id = ? AND node_id = ? AND code_dropped_at IS NULL',
          taskId, machineId, nodeId,
        );
        const cleanup = db.all<{ id: string }>(
          'SELECT id FROM work_cleanup WHERE task_id = ? AND machine_id = ? AND node_id = ? AND code_dropped_at IS NULL',
          taskId, machineId, nodeId,
        );
        if (runs.length === 0 && cleanup.length === 0) return [];
        const at = nowIso();
        for (const { id } of runs) db.run('UPDATE run SET code_dropped_at = ? WHERE id = ?', at, id);
        if (cleanup.length > 0) {
          const marks = cleanup.map(() => '?').join(', ');
          db.run(`UPDATE work_cleanup SET code_dropped_at = ? WHERE id IN (${marks})`, at, ...cleanup.map(({ id }) => id));
        }
        writeChange(db, 'run.code_drop', SERVICE, runs.length === 0 ? {} : { taskId }, {
          ...(runs.length === 0 ? { task_id: taskId } : {}),
          machine_id: machineId,
          node_id: nodeId,
          ...(runs.length === 0 ? {} : { runs: runs.map(({ id }) => id) }),
          ...(cleanup.length === 0 ? {} : { cleanup: cleanup.map(({ id }) => id) }),
          days: tuned('retention.endedDays'),
        });
        return runs.map(({ id }) => id);
      });
    },

    // The release entry's gate: a package of a round whose role asked for review goes in
    // place only when a pass of the product the Task holds now covers that very file, or
    // when the owner accepted it without one.
    releaseGate(runId: string, file: BoundFile): string | null {
      const run = loadRun(runId);
      const task = loadTask(run.task_id);
      if ((JSON.parse(run.snapshot_json) as { role?: { needs_review?: boolean } }).role?.needs_review !== true) return null;
      if (acceptedWithoutReview(task.id)) return null;
      const product = productOf(task);
      const covered = passesOf(task).some((binding) =>
        binding.run_id === runId && productStale(binding, product) === null && binding.files.some((each) => sameFiles([each], [file])));
      return covered ? null : RELEASE_NEEDS_PASS_TEXT;
    },

    // Whether the owner let this Task's work past the review gate himself (acceptTask's
    // `withoutReview`): the line the acceptance left on the timeline is the one judgement of it,
    // and what the release entry and a landing ask about a product that needs review but has no
    // current pass.
    acceptedWithoutReview,

    // The reviews bound to a Task, oldest first.
    reviewsOf,

    // The other way out of 待验收: the work is not what was asked for, so the Task goes back
    // to the queue carrying a note for the next round. The note is an input, like an
    // interjection, so the next round gets it and the revision does not move: the goal and
    // the acceptance criteria are the ones the round it is sent back from was given. What
    // the caller read has to be what the Task still is — a note written about a definition
    // that has changed since does not apply to it — and the Task must have no Run left, or
    // the queue could hold two of them.
    reworkTask(taskId: string, note: string, expectedRevision: number | undefined, ctx: Ctx): string {
      return write(() => {
        if (isBlank(note)) throw new InputError('退回说明不能为空');
        const task = loadTask(taskId);
        requireState(task, ['ready', 'held', 'done'], '退回返工');
        if (expectedRevision !== undefined && task.revision !== expectedRevision) {
          throw new InputError(`任务 ${taskId} 已是修订 ${task.revision}，不是 ${expectedRevision}：看一遍再退回`);
        }
        requireNoActiveRun(task, '退回返工');
        return sendBack(task, note, ctx);
      });
    },

    hostVersionState(): HostVersionState | null {
      const row = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', 'host_version_state');
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value_json) as Partial<HostVersionState> | null;
        if (parsed && typeof parsed.current === 'string' && typeof parsed.upgraded_at === 'string') {
          return {
            current: parsed.current,
            previous: typeof parsed.previous === 'string' ? parsed.previous : null,
            upgraded_at: parsed.upgraded_at,
          };
        }
      } catch { /* ignore malformed setting */ }
      return null;
    },

    dispatchSlots(): DispatchSlotsConfig | null {
      const row = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', DISPATCH_SLOTS_SETTING_KEY);
      return parseDispatchSlots(row?.value_json);
    },

    executorAutoUpdatePolicy(): ExecutorAutoUpdatePolicy {
      const row = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', EXECUTOR_AUTO_UPDATE_SETTING_KEY);
      return parseExecutorAutoUpdatePolicy(row?.value_json);
    },

    loginAliases(): Record<string, string> {
      const row = db.get<{ value_json: string }>('SELECT value_json FROM setting WHERE key = ?', LOGIN_ALIASES_SETTING_KEY);
      return parseLoginAliases(row?.value_json);
    },

    setLoginAlias(key: string, alias: string | null): Record<string, string> {
      const trimmedKey = key.trim();
      if (!trimmedKey) throw new InputError('缺少要重命名的目标标识');
      const nextAlias = alias === null ? null : alias.trim();
      if (nextAlias !== null && nextAlias !== '') {
        const problem = accountNameProblem(nextAlias);
        if (problem) throw new InputError(problem);
      }
      return write(() => {
        const current = this.loginAliases();
        if (nextAlias === null || nextAlias === '') delete current[trimmedKey];
        else current[trimmedKey] = nextAlias;
        db.run(
          `INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
          ulid(),
          nowIso(),
          LOGIN_ALIASES_SETTING_KEY,
          JSON.stringify(current),
        );
        db.noteNews();
        return current;
      });
    },

    setExecutorAutoUpdatePolicy(policy: ExecutorAutoUpdatePolicy): ExecutorAutoUpdatePolicy {
      return write(() => {
        const normalized = normalizeExecutorAutoUpdatePolicy(policy);
        const now = nowIso();
        db.run(
          `INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
          ulid(),
          now,
          EXECUTOR_AUTO_UPDATE_SETTING_KEY,
          JSON.stringify(normalized),
        );
        return normalized;
      });
    },

    setTierDispatchSlots(tier: TierId, slots: TierDispatchSlots): { slots: DispatchSlotsConfig; order: string[] } {
      return write(() => {
        const normalized = normalizeTierSlots(slots) ?? { p1: [], p2: [], off: [] };
        const current = this.dispatchSlots() ?? {};
        const next: DispatchSlotsConfig = { ...current, [tier]: normalized };
        const now = nowIso();
        db.run(
          `INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
          ulid(),
          now,
          DISPATCH_SLOTS_SETTING_KEY,
          JSON.stringify(next),
        );
        return { slots: next, order: expandTierSlotsToLoginIds(normalized) };
      });
    },

    recordHostVersion(version: string): HostVersionState & { upgraded: boolean } {
      return write(() => {
        const prev = this.hostVersionState();
        if (prev && prev.current === version) {
          return { ...prev, upgraded: false };
        }
        const next: HostVersionState = {
          current: version,
          previous: prev?.current ?? null,
          upgraded_at: nowIso(),
        };
        db.run(
          `INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
          ulid(),
          nowIso(),
          'host_version_state',
          JSON.stringify(next),
        );
        return { ...next, upgraded: prev !== null };
      });
    },

    continueTask(
      taskId: string,
      note: string,
      expectedRevision: number | undefined,
      ctx: Ctx,
      options?: { title?: string; scope?: string },
    ): { id: string; queued: boolean; active: boolean } {
      return write(() => {
        if (isBlank(note)) throw new InputError('后续指令不能为空');
        const task = loadTask(taskId);
        if (task.state === 'abandoned') {
          throw new InputError(`任务 ${taskId} 已放弃，不能继续`);
        }
        if (expectedRevision !== undefined && task.revision !== expectedRevision) {
          throw new InputError(`任务 ${taskId} 已是修订 ${task.revision}，不是 ${expectedRevision}：看一遍再继续`);
        }
        const nextTitle = options?.title !== undefined && options.title.trim() !== '' ? options.title.trim() : undefined;
        const nextScope = options?.scope !== undefined ? options.scope : undefined;
        if (nextTitle !== undefined || nextScope !== undefined) {
          db.run(
            'UPDATE task SET title = COALESCE(?, title), scope = COALESCE(?, scope) WHERE id = ?',
            nextTitle ?? null,
            nextScope ?? null,
            taskId,
          );
          if (nextTitle !== undefined) task.title = nextTitle;
          if (nextScope !== undefined) task.scope = nextScope;
        }
        const hasActiveRun = activeRun(task) !== undefined;
        const isActiveState = task.state === 'queued' || task.state === 'running' || task.state === 'waiting_person';
        if (!hasActiveRun && !isActiveState && (task.state === 'ready' || task.state === 'held' || task.state === 'done' || task.state === 'draft' || task.state === 'waiting_timer')) {
          const inputId = sendBack(task, note, ctx);
          return { id: inputId, queued: true, active: false };
        }
        const id = ulid();
        db.run(
          `INSERT INTO input (id, created_at, task_id, text, actor, message_id, state) VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
          id,
          nowIso(),
          taskId,
          note,
          ctx.actor,
          ctx.messageId ?? null,
        );
        writeChange(db, 'task.continue', ctx, { taskId }, { input_id: id, active: true });
        tellRouter(`input:${id}`, ctx.actor, `任务“${task.title}”收到后续指令，本轮结束后自动续跑，不用回复`, {
          task_id: taskId,
          input_id: id,
          text: note,
        }, { quiet: true });
        return { id, queued: true, active: true };
      });
    },

    isTaskResumable(taskId: string): boolean {
      const run = latestEndedRun(taskId);
      return Boolean(run?.session_ref && RESUMABLE_THREAD_EXITS.has(run.exit_kind ?? ''));
    },

    listRecentResumableTasks(projectId: string, limit = 8): ResumableTaskSummary[] {
      const cap = Math.max(0, Math.floor(limit));
      if (cap === 0) return [];
      const candidates = db.all<TaskRow>(
        `${TASK_SELECT} WHERE task.project_id = ? AND task.state = 'done' AND task.review_of_json IS NULL AND task.knowledge_json IS NULL
         ORDER BY COALESCE(task.closed_at, task.created_at) DESC, task.rowid DESC LIMIT ?`,
        projectId,
        cap * 4,
      );
      const result: ResumableTaskSummary[] = [];
      for (const task of candidates) {
        const run = latestEndedRun(task.id);
        if (!run || !run.session_ref || !RESUMABLE_THREAD_EXITS.has(run.exit_kind ?? '')) continue;
        let executor: string | null = null;
        try {
          executor = executorOf(run.snapshot_json) ?? null;
        } catch {
          executor = null;
        }
        let lastSummary: string | null = null;
        if (run.receipt_json !== null) {
          try {
            const parsed = JSON.parse(run.receipt_json) as { summary?: unknown } | null;
            if (typeof parsed?.summary === 'string') lastSummary = parsed.summary;
          } catch {
            lastSummary = null;
          }
        }
        result.push({
          id: task.id,
          title: task.title,
          role_id: task.role_id,
          executor,
          machine_id: run.machine_id,
          closed_at: task.closed_at,
          last_summary: lastSummary,
          resumable: true,
        });
        if (result.length >= cap) break;
      }
      return result;
    },

    createRun(
      taskId: string,
      // Set by the dispatcher on a review no login of another executor could take: the round runs
      // on an executor that wrote the product, and says so (roles-and-tiers.md §4 ②). `placedBy`
      // is which group of logins picked it (§11): prefer, spread, order, pinned, or same_executor.
      fields: { login: Login; machine: Machine; snapshot: Record<string, unknown>; expectedRevision: number; sameExecutor?: SameExecutor; placedBy?: PlacedBy },
      ctx: Ctx,
    ): RunRow {
      return write(() => {
        const task = loadTask(taskId);
        requireState(task, ['queued'], '派发');
        if (isPaused()) throw new InputError('已全局暂停，不能派发');
        const stopped = messages.projectStopped(task.project_id);
        if (stopped !== null) throw new InputError(stopped === 'archived' ? '项目已归档，恢复后再派发' : '项目已暂停，恢复后再派发');
        if (fields.expectedRevision !== task.revision) throw new InputError('快照按修订 ' + fields.expectedRevision + ' 准备，任务已是修订 ' + task.revision);
        const loginId = fields.login.id;
        const held = currentConfig(loginId);
        if (!held) throw new InputError(displayLogin(fields.login) + ' 已经不在了，不能派发');
        if (!sameConfig(held, loginConfig(fields.login))) throw new InputError(loginName(loginId) + ' 在挑机器、准备快照的这段时间里改过，不能按旧的配置派发');
        const machine = currentMachine(fields.machine.id);
        if (!machine || machine.uid !== fields.machine.uid || !sameConfig(machineConfig(machine), machineConfig(fields.machine))) throw new InputError('机器 ' + fields.machine.id + ' 在挑机器、准备快照的这段时间里改过或已删，不能派发');
        requireMachine(task, held, machine.id);
        // The source as it stands in this transaction (docs/design/code-sources.md §8.7, §8.11):
        // the dispatcher read the project's list and prepared the snapshot before this commit, and
        // the owner may have deleted the source while a machine was being asked. A source the Task
        // is pinned to that is no longer there stops the round; where both the Task and the
        // snapshot name a source, the snapshot has to name the very binding (bindingKey) the Task
        // holds now, not one prepared before the pin moved; and a folder travels to the machine it
        // names and no other. Only the ledger can make this judgement: it is the one read this
        // commit shares. What it does not say is a source: the revision check and sourceRefusalOf
        // above are what catch a pin moved or taken away while a machine was asked.
        const sourceRefused = sourceRefusalOf(task);
        if (sourceRefused !== undefined) throw new InputError(sourceRefused);
        const pinned = task.source_json === null ? null : (JSON.parse(task.source_json) as TaskSource);
        const preparedSource = (fields.snapshot as { source?: SnapshotSource }).source;
        if (pinned !== null && preparedSource !== undefined && preparedSource.binding_key !== bindingKey(pinned.pinned)) {
          throw new InputError(`任务 ${taskId} 这一轮的代码来源和它现在钉的不是一个（快照是照另一份准备的）：这一轮不发，重新派一次`);
        }
        if (pinned !== null && pinned.pinned.kind === 'folder' && pinned.pinned.machine_uid !== machine.uid) {
          throw new InputError(`任务钉的代码来源是 ${sourceLabelFor(pinned.pinned)}，只能派到它所在的那台机器，不能派到 ${machine.id}`);
        }
        if (task.login_id !== null && task.login_id !== loginId) throw new InputError('任务 ' + taskId + ' 指定了' + loginName(task.login_id) + '，不能派到 ' + loginName(loginId));
        requireLoginAllowed(task, loginId);
        if (task.knowledge_json !== null && task.role_id !== null) requireKnowledgeRole(task.role_id);
        requireReadOnlyWay(task.role_id, loginId);
        // The round is made the way the role says in this transaction, by the executor's own
        // declaration, and recorded with it: a snapshot prepared writable for a role that is
        // read-only now, or the other way round, is not sent.
        const access = accessOf(currentLogin(loginId)!, executors, task.permission ?? 'write');
        const prepared = (fields.snapshot.access as RunAccess | undefined)?.permission;
        if (prepared !== undefined && prepared !== access.permission) {
          throw new InputError('任务 ' + taskId + ' 的职能现在是' + (access.permission === 'read' ? '只读' : '可写') + '，这一轮却是按' + (prepared === 'read' ? '只读' : '可写') + '准备的，不能派发');
        }
        // The one place a snapshot's limit is made sure of: every reader of a Run takes it as
        // there. A snapshot without one is a broken snapshot, and no Run is made of it.
        const limit = fields.snapshot.timeout_ms;
        if (!Number.isSafeInteger(limit) || (limit as number) <= 0) throw new InputError('任务 ' + taskId + ' 的快照里没有执行时限，快照坏了，不能派发');
        const id = ulid();
        const inputs = db.all<{ id: string; text: string }>("SELECT id, text FROM input WHERE task_id = ? AND state = 'queued' ORDER BY rowid", taskId);
        // The number, not the token: it is what says, later, whether this Run's result
        // still speaks for the account. A number, not a secret, so it may sit in a snapshot.
        // An account holds one by definition; a machine's own login never does.
        const credentialRef = credentialRefOf(loginId);
        // The role as it is in this transaction, and where the tier came from: what this
        // round ran as, whatever the role becomes later (docs/design/roles-and-tiers.md §3.3).
        // A snapshot prepared for another tier than the Task has now was prepared for a role
        // or an override that changed in between, and is not sent.
        const role = task.role_id === null ? undefined : roleOf(task.role_id);
        if (typeof fields.snapshot.tier === 'string' && fields.snapshot.tier !== task.tier) {
          throw new InputError('任务 ' + taskId + ' 的档位在准备快照的这段时间里变成了 ' + (task.tier ?? '没有') + '，不能按 ' + fields.snapshot.tier + ' 派发');
        }
        db.run(
          "INSERT INTO run (id, created_at, task_id, task_revision, login_id, login_name, host, machine_id, node_id, state, marker, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'launching', ?, ?)",
          id, nowIso(), taskId, task.revision, loginId, currentLogin(loginId)!.name, machine.host, machine.id, machine.nodeId, 'tycho-run:' + id,
          JSON.stringify({
            ...fields.snapshot, output_capture: (() => {
              const publisher=globalEntryPublisher(dirname(path));
              if (!('id' in publisher)) throw new InputError(publisher.problem);
              const limits=db.get<{value_json:string}>("SELECT value_json FROM setting WHERE key='tunables'");
              const values=limits?JSON.parse(limits.value_json):{};
              return {version:1,source:outputSource(publisher.id,id,taskId,machine.uid!,machine.nodeId),raw_bytes:tuned('node.runOutputLimitMb')*1024*1024,result_bytes:tuned('node.resultLimitMb')*1024*1024};
            })(), access, quota_generation: quotaGeneration(loginId), ...(credentialRef === null ? {} : { credential_ref: credentialRef }), inputs, login: held, machine: machineConfig(machine), machine_uid: machine.uid,
            ...(role ? { role: roleConfig(role) } : {}), ...(task.tier_source === null ? {} : { tier_source: task.tier_source }),
            ...((task.tier_source === 'override' || task.tier_source === 'escalated') && task.tier_reason !== null ? { tier_reason: task.tier_reason } : {}),
            ...(fields.sameExecutor ? { same_executor: fields.sameExecutor } : {}),
          }),
        );
        db.run("UPDATE input SET state = 'attached', run_id = ? WHERE task_id = ? AND state = 'queued'", id, taskId);
        moveTask(taskId, 'running');
        writeChange(db, 'run.create', ctx, { taskId, runId: id }, {
          inputs: inputs.map(input => input.id), dispatchConditions: dispatchConditions(),
          ...(fields.sameExecutor ? { same_executor: fields.sameExecutor } : {}),
          ...(fields.placedBy === undefined ? {} : { placed_by: fields.placedBy }),
        });
        return loadRun(id);
      });
    },

    // Uploads do not start work, so another allowed machine may take an untouched Run.
    // `machineInputs`: what the round may read on that machine (runner/snapshot.ts
    // machineInputsHere), which is what it is started with there.
    rehostRun(runId: string, machine: Machine, machineInputs?: MachineInputs): RunRow {
      return write(() => {
        const run = loadRun(runId);
        if (run.state !== 'launching') throw new InputError('Run ' + runId + ' 状态为 ' + runStateLabels[run.state] + '，不能换机器');
        const { session_ref: _session, ...snapshot } = JSON.parse(run.snapshot_json) as Record<string, unknown>;
        const held = currentConfig(run.login_id);
        const recorded = snapshot.login as LoginConfig | undefined;
        const current = currentMachine(machine.id);
        if (!held || !recorded || !sameConfig(held, recorded) || !current || current.uid !== machine.uid || !sameConfig(machineConfig(current), machineConfig(machine))) {
          throw new InputError(loginName(run.login_id, run.login_name) + '或机器已改或已删，Run ' + runId + ' 不能换到 ' + machine.id);
        }
        const rehostTask = loadTask(run.task_id);
        requireMachine(rehostTask, held, machine.id);
        const previousCapture=captureOf(run);
        if(previousCapture){
          const publisher=globalEntryPublisher(dirname(path));if(!('id' in publisher))throw new InputError(publisher.problem);
          snapshot.output_capture={...previousCapture,source:outputSource(publisher.id,run.id,run.task_id,current.uid!,current.nodeId)};
          writeChange(db,'run.capture_release',RUNNER,{taskId:run.task_id,runId:run.id},{source:previousCapture.source,machine_id:run.machine_id,node_id:run.node_id,machine_uid:(JSON.parse(run.snapshot_json) as {machine_uid?:string}).machine_uid,reason:'rehosted_before_start'});
        }
        snapshot.machine = machineConfig(current);
        snapshot.machine_uid = current.uid;
        if (machineInputs !== undefined) snapshot.machine_inputs = machineInputs;
        db.run('UPDATE run SET host = ?, machine_id = ?, node_id = ?, snapshot_json = ? WHERE id = ?', current.host, current.id, current.nodeId, JSON.stringify(snapshot), runId);
        writeChange(db, 'run.rehost', RUNNER, { taskId: run.task_id, runId }, { from: run.host, to: current.host, machine_id: current.id });
        return loadRun(runId);
      });
    },

    // Also the way back from unknown: verification found the executor, so the Run
    // and Task return to what they were, stopping included.
    markRunRunning(runId: string, fields: { sessionRef?: string } = {}): void {
      write(() => {
        const run = loadRun(runId);
        if (run.state !== 'launching' && run.state !== 'unknown') {
          throw new InputError(`Run ${runId} 状态为 ${runStateLabels[run.state]}，不能标记为运行中`);
        }
        const state = unknownFrom(run) === 'stopping' ? 'stopping' : 'running';
        db.run(
          `UPDATE run SET state = ?, session_ref = COALESCE(?, session_ref), started_at = COALESCE(started_at, ?), error_json = NULL
           WHERE id = ?`,
          state,
          fields.sessionRef ?? null,
          nowIso(),
          runId,
        );
        if (run.state === 'unknown' && loadTask(run.task_id).state === 'needs_verification') {
          moveTask(run.task_id, state);
        }
        writeChange(db, 'run.running', RUNNER, { taskId: run.task_id, runId }, { from: run.state, to: state });
      });
    },

    // A machine showed this round started. Only the fact: it stays where it is, and no
    // settlement after this takes it away, save one carrying the machine's own evidence that
    // no Worker of the round ever ran (workerNotStarted).
    noteRunStarted(runId: string): void {
      write(() => {
        const run = loadRun(runId);
        if (run.started_at !== null) return;
        db.run('UPDATE run SET started_at = ? WHERE id = ? AND started_at IS NULL', nowIso(), runId);
        writeChange(db, 'run.started_seen', RUNNER, { taskId: run.task_id, runId }, {});
      });
    },

    // The way back from unknown for a Run whose machine answers and shows its launcher
    // still at work: it is starting, as it was, and under the wall clock again. A stop
    // asked for meanwhile is kept.
    markRunLaunching(runId: string): void {
      write(() => {
        const run = loadRun(runId);
        if (run.state !== 'unknown') {
          throw new InputError(`Run ${runId} 状态为 ${runStateLabels[run.state]}，不能标记为启动中`);
        }
        const state = unknownFrom(run) === 'stopping' ? 'stopping' : 'launching';
        db.run('UPDATE run SET state = ?, error_json = NULL WHERE id = ?', state, runId);
        if (loadTask(run.task_id).state === 'needs_verification') {
          moveTask(run.task_id, state === 'stopping' ? 'stopping' : 'running');
        }
        writeChange(db, 'run.launching', RUNNER, { taskId: run.task_id, runId }, { from: run.state, to: state });
      });
    },

    // Called at every look that cannot say where the Run is, so it writes only what that
    // look changed. The two waits are kept apart because they end differently. A stretch
    // out of contact is over at the first answer, whatever it shows, and the next failure
    // begins a new one. The wait for a start nobody confirmed begins at the first answer
    // that shows no trace of it and lasts while the Run is unknown. Both are wall-clock
    // times in the ledger, so a restart does not start either over. A machine that answers
    // that it cannot tell ends both and starts no wait: what it said is kept instead, and
    // shown, until a look says something else.
    markRunUnknown(runId: string, cause: UnknownCause = 'unreachable', said?: string): void {
      write(() => {
        const run = loadRun(runId);
        if (run.state === 'ended') {
          throw new InputError(`Run ${runId} 状态为 ${runStateLabels[run.state]}，不能标记为未知`);
        }
        const before = unknownMarks(run);
        const at = nowIso();
        const unreachable = cause === 'unreachable' ? before.unreachable_since ?? at : undefined;
        const unconfirmed = cause === 'unconfirmed' ? before.unconfirmed_since ?? at : cause === 'unverifiable' ? undefined : before.unconfirmed_since;
        const unverifiable = cause === 'unverifiable' ? (said?.trim() || '机器没有说原因').slice(0, MAX_UNVERIFIABLE_CHARS) : undefined;
        const noAccount = cause === 'no_target';
        const same = unreachable === before.unreachable_since && unconfirmed === before.unconfirmed_since
          && unverifiable === before.unverifiable && noAccount === (before.no_target === true);
        if (run.state === 'unknown' && same) return;
        // run.state is about to lose this, and it is what "back to the matching
        // state" needs, so a stop request survives losing contact with the host.
        const marks: UnknownMarks = {
          unknown_from: run.state === 'unknown' ? before.unknown_from : run.state,
          ...(unreachable ? { unreachable_since: unreachable } : {}),
          ...(unconfirmed ? { unconfirmed_since: unconfirmed } : {}),
          ...(unverifiable ? { unverifiable } : {}),
          ...(noAccount ? { no_target: true } : {}),
        };
        db.run(`UPDATE run SET state = 'unknown', error_json = ? WHERE id = ?`, JSON.stringify(marks), runId);
        const task = loadTask(run.task_id);
        const reason = noAccount ? missingLoginText(run.login_name ?? '已删除的登录') : unverifiable ? unverifiableText(unverifiable) : NEEDS_VERIFICATION_REASON;
        const waiting = task.state === 'needs_verification' && task.reason !== reason;
        if (task.state === 'running' || task.state === 'stopping' || waiting) {
          moveTask(task.id, 'needs_verification', { reason });
        }
        writeChange(db, 'run.unknown', RUNNER, { taskId: run.task_id, runId }, { from: run.state, cause, ...(unverifiable ? { said: unverifiable } : {}) });
      });
    },

    markRunStopping(runId: string, ctx: Ctx): void {
      write(() => {
        const run = loadRun(runId);
        if (run.state === 'ended' || run.state === 'stopping' || unknownFrom(run) === 'stopping') {
          throw new InputError(`Run ${runId} 状态为 ${runStateLabels[run.state]}，不能发起停止`);
        }
        if (run.state === 'unknown') {
          // Nobody can be told to stop yet, and the waits already running must not
          // start over: the Run stays unknown and now carries the stop request.
          const error = JSON.parse(run.error_json ?? '{}') as Record<string, unknown>;
          db.run('UPDATE run SET error_json = ? WHERE id = ?', JSON.stringify({ ...error, unknown_from: 'stopping' }), runId);
        } else {
          db.run(`UPDATE run SET state = 'stopping', error_json = NULL WHERE id = ?`, runId);
          if (loadTask(run.task_id).state === 'running') moveTask(run.task_id, 'stopping');
        }
        writeChange(db, 'run.stopping', ctx, { taskId: run.task_id, runId }, { from: run.state });
      });
    },

    // The Worker ended and stop.sh cannot clear what it left: the Run stays running and
    // each poll tries again, so the owner is told once, not once per poll.
    // A Run out of contact past its grace period whose Task names no role and no account:
    // nothing says which accounts its continuation could go to, so it is neither judged nor
    // continued (the old round stays as it is). The Router is told once per Run; the page
    // reads the same fact from the Task itself (docs/design/roles-and-tiers.md §8).
    reportLostWithoutRole(runId: string): void {
      write(() => {
        const run = loadRun(runId);
        const key = `no-role:${runId}`;
        if (db.get(`SELECT 1 FROM message WHERE channel = 'internal' AND external_id = ?`, key)) return;
        const task = loadTask(run.task_id);
        writeChange(db, 'run.lost_without_role', RUNNER, { taskId: task.id, runId });
        tellRouter(key, RUNNER.actor, `任务“${task.title}”：${NO_ROLE_LOST_TEXT}`, { task_id: task.id, run_id: runId });
      });
    },

    reportStuckResidue(runId: string): void {
      write(() => {
        const run = loadRun(runId);
        const key = `residue:${runId}`;
        if (db.get(`SELECT 1 FROM message WHERE channel = 'internal' AND external_id = ?`, key)) return;
        const task = loadTask(run.task_id);
        askToVerify(task.id, runId, 'residue');
        writeChange(db, 'run.residue_stuck', RUNNER, { taskId: task.id, runId });
        tellRouter(key, RUNNER.actor, `任务“${task.title}”的 Worker 已结束，但后台进程清不掉，Run 不能结算`, {
          task_id: task.id,
          run_id: runId,
        });
      });
    },

    settleRun(
      runId: string,
      exitCode: number | null,
      receipt: Receipt | null,
      opts: SettleOptions = {},
    ): SettleResult {
      return write((): SettleResult => {
        const run = loadRun(runId);
        const task = loadTask(run.task_id);
        const refs = { taskId: task.id, runId };
        const stopIntent = run.state === 'stopping' || task.state === 'stopping' || unknownFrom(run) === 'stopping';
        const late = lateReason(run, task);
        const capture=captureOf(run);
        const evidence=capture&&opts.captureResult?captureEvidence(opts.captureResult,capture):undefined;
        const dispose=(adopted:boolean,why:string):void=>{
          if(run.capture_result_json!==null)return;
          if(!capture&&!opts.outputProcessed&&!opts.kind&&!late)return;
          const proof:CaptureDisposition={version:1,source:capture?.source??'legacy',complete:evidence?.complete??(opts.outputProcessed===true),...(evidence?.ref?{ref:evidence.ref}:{}),...(!capture?{legacy:true as const}:{}),disposition:adopted?'adopted':'not_adopted',...(!adopted?{reason:why}:{})};
          db.run('UPDATE run SET capture_result_json = ? WHERE id = ?',JSON.stringify(proof),runId);
        };
        const plainProse = exitCode === 0
          && receipt === null
          && !stopIntent
          && opts.kind === undefined
          && opts.reason === undefined
          && opts.workerNotStarted === undefined
          && typeof opts.finalReply === 'string'
          && opts.finalReply.trim() !== ''
          && task.review_of_json === null
          && task.knowledge_json === null;
        const effectiveReceipt: Receipt | null = plainProse
          ? { status: 'done', summary: inferPlainProseSummary(opts.finalReply!), artifacts: [{ kind: 'report', ref: FINAL_MESSAGE_REF }] }
          : receipt;
        const successfulInput = exitCode === 0 && effectiveReceipt?.status === 'done' ? settleInputDigest(exitCode, effectiveReceipt, opts) : null;

        if (run.state === 'ended') {
          if(evidence)dispose(false,'already_settled');
          // The first settlement stands; a repeat only leaves a trace beside it. What the round
          // used was used all the same: a result that comes after the round was settled without
          // one (lost, then its machine came back) is the only report of it, kept at its end.
          if (opts.usage && opts.usage.length > 0 && !db.get('SELECT 1 FROM usage WHERE run_id = ?', runId)) {
            const tierModel = tierModelOf(run.snapshot_json);
            const normalized = normalizeRunUsage(db, run, opts.usage, tierModel);
            insertUsage(db, { run_id: runId }, run.ended_at ?? nowIso(), normalized, tierModel);
          }
          if (run.exit_kind === 'completed' && successfulInput !== null && run.settlement_digest === successfulInput) {
            return { late: true, reason: 'run_ended' };
          }
          const error = (run.error_json ? JSON.parse(run.error_json) : {}) as { late_results?: unknown[] };
          const { finalReply: _finalReply, ...lateOptions } = opts;
          const lateResult = { at: nowIso(), exit_code: exitCode, receipt, opts: lateOptions };
          const lateResults = [...(error.late_results ?? []), lateResult];
          db.run('UPDATE run SET error_json = ? WHERE id = ?', JSON.stringify({ ...error, late_results: lateResults }), runId);
          writeChange(db, 'run.settle_late', RUNNER, refs, { reason: late, exit_code: exitCode });
          // run:<id> is taken by the first settlement and the pair is unique.
          reportSettlement(`run:${runId}:late:${lateResults.length}`, run, {
            exit_code: exitCode,
            exit_kind: null,
            receipt,
            late_reason: 'run_ended',
          });
          return { late: true, reason: 'run_ended' };
        }

        const readyBefore = workReady(task);
        let outcome = settlement(exitCode, effectiveReceipt, stopIntent, opts);
        // Keep read-only code_check purely as advisory metadata on the run record; never discard
        // receipts or retry/hold runs based on it.
        const codeCheck = opts.codeCheck;
        const ranAs = (JSON.parse(run.snapshot_json) as { role?: RoleConfig }).role;
        const delivery: Delivery | null = effectiveReceipt === null ? null : deliveryOf(effectiveReceipt);
        if (outcome.state === 'ready') {
          const short = ranAs === undefined ? null : deliveryProblem(ranAs.deliverable, effectiveReceipt);
          if (short !== null) outcome = { exitKind: 'completed', state: 'held', reason: shortDeliveryText(ranAs!.name, short) };
        }
        const residue = opts.residue ? { residue: true } : {};
        const basis = opts.lost?.basis ?? 'seen';
        const lost = outcome.exitKind === 'lost' ? { lost: { ...opts.lost, basis } } : opts.lost ? { lost: opts.lost } : {};
        // The quota is the account's, so the account rests whatever becomes of the Task,
        // and in this transaction: the rest and the Task's way on stand or fall together.
        const restUntil = opts.quota ? restLogin(run, opts.quota) : undefined;
        if (opts.kind === 'auth') refuseLogin(run);
        const quota = opts.quota
          ? {
              quota: {
                login_id: run.login_id, login_name: run.login_name, message: opts.quota.message,
                ...(opts.quota.resetsAt ? { resets_at: opts.quota.resetsAt } : {}), ...(restUntil ? { rest_until: restUntil } : {}),
              },
            }
          : {};
        const snapObj = (() => {
          try {
            return JSON.parse(run.snapshot_json) as { session_ref?: unknown; quota_generation?: unknown };
          } catch {
            return {};
          }
        })();
        // A Run that went through shows the quota is back: the next rest starts short again.
        if (outcome.exitKind === 'completed' && (snapObj.quota_generation ?? null) === quotaGeneration(run.login_id)) db.run('UPDATE login_state SET rest_streak = 0 WHERE id = ? AND rest_streak != 0', run.login_id);
        const usedSessionRef = typeof snapObj.session_ref === 'string' && snapObj.session_ref.trim() !== '' ? snapObj.session_ref.trim() : null;
        const notRestoring = !readSetting<RestoreMark | null>('restore', null);
        const failedWithoutWork = late === undefined
          && !stopIntent
          && opts.kind === undefined
          && outcome.exitKind === 'failed'
          && outcome.state === 'held'
          && effectiveReceipt === null
          && !(typeof opts.finalReply === 'string' && opts.finalReply.trim() !== '')
          && notRestoring;
        const priorRunsOnTask = failedWithoutWork
          ? db.all<{ id: string; task_revision: number; error_json: string | null; snapshot_json: string }>(
              'SELECT id, task_revision, error_json, snapshot_json FROM run WHERE task_id = ? AND id != ?',
              task.id,
              runId,
            )
          : [];
        const priorResumeFallbackForRef = usedSessionRef !== null && priorRunsOnTask.some((other) => {
          try {
            const err = JSON.parse(other.error_json ?? '{}') as { resume_failed?: unknown };
            const snap = JSON.parse(other.snapshot_json) as { session_ref?: unknown };
            return err.resume_failed === true && snap.session_ref === usedSessionRef;
          } catch {
            return false;
          }
        });
        const failureReasonText = opts.reason ?? opts.workerNotStarted ?? '';
        const deterministicConfigFailure = /does not support reasoning effort|unknown model|invalid model|model\b[^.\n]*\bnot found|unsupported (?:model|parameter|effort|provider)/i.test(failureReasonText);
        const resumeAutoFallback = failedWithoutWork
          && !deterministicConfigFailure
          && usedSessionRef !== null
          && !priorResumeFallbackForRef
          && (exitCode !== 0 || opts.workerNotStarted !== undefined || effectiveReceipt === null);
        const networkReasonText = failureReasonText;
        const priorStartupNetworkRetries = priorRunsOnTask.filter((other) => {
          if (other.task_revision !== task.revision) return false;
          try {
            return (JSON.parse(other.error_json ?? '{}') as { startup_network_retry?: unknown }).startup_network_retry === true;
          } catch {
            return false;
          }
        }).length;
        const startupNetworkAutoRetry = !resumeAutoFallback
          && failedWithoutWork
          && (opts.toolCalls === undefined || opts.toolCalls === 0)
          && TRANSIENT_STARTUP_NETWORK_RE.test(networkReasonText)
          && priorStartupNetworkRetries < 2;
        const reason = outcome.state === 'held' || outcome.state === 'retry' ? outcome.reason
          : outcome.state === 'continue' ? LOST_TEXT[basis] : outcome.state === 'requeue' ? (outcome.exitKind === 'auth' ? authReason(run.login_id) : QUOTA_REASON) : undefined;
        const never = opts.workerNotStarted === undefined ? {} : { worker_not_started: opts.workerNotStarted };
        const checked = codeCheck === undefined ? {} : { code_check: codeCheck };
        const stood = opts.sourceHead === undefined ? {} : { source_head: opts.sourceHead };
        const fallbackMark = resumeAutoFallback
          ? { resume_failed: true }
          : startupNetworkAutoRetry
            ? { startup_network_retry: true }
            : {};
        const settlementDigest = outcome.exitKind === 'completed' && late === undefined ? successfulInput : null;
        const errorJson = opts.residue || opts.lost || opts.quota || reason !== undefined || opts.workerNotStarted !== undefined || codeCheck !== undefined || opts.sourceHead !== undefined || resumeAutoFallback || startupNetworkAutoRetry
          ? JSON.stringify({ ...(run.error_json ? JSON.parse(run.error_json) : {}), ...residue, ...lost, ...quota, ...never, ...checked, ...stood, ...fallbackMark, ...(reason ? { reason } : {}) })
          : run.error_json;
        // The machine's word that nothing ran outweighs a start that was seen: the gate was
        // taken, and that is all. Its inputs were never delivered, and the next round takes them.
        if (opts.workerNotStarted !== undefined) {
          db.run('UPDATE run SET started_at = NULL WHERE id = ?', runId);
          db.run(`UPDATE input SET state = 'queued', run_id = NULL WHERE run_id = ? AND state = 'attached'`, runId);
        }
        if (resumeAutoFallback || startupNetworkAutoRetry) {
          db.run(`UPDATE input SET state = 'queued', run_id = NULL WHERE run_id = ? AND state = 'attached'`, runId);
        }
        const endedAt = nowIso();
        db.run(
          resumeAutoFallback
            ? `UPDATE run SET state = 'ended', exit_code = ?, exit_kind = ?, receipt_json = ?, ended_at = ?,
                 session_ref = NULL, error_json = ?, settlement_digest = ? WHERE id = ?`
            : `UPDATE run SET state = 'ended', exit_code = ?, exit_kind = ?, receipt_json = ?, ended_at = ?,
                 session_ref = COALESCE(?, session_ref), error_json = ?, settlement_digest = ? WHERE id = ?`,
          ...(resumeAutoFallback
            ? [
                exitCode,
                outcome.exitKind,
                effectiveReceipt === null ? null : JSON.stringify(effectiveReceipt),
                endedAt,
                errorJson,
                settlementDigest,
                runId,
              ]
            : [
                exitCode,
                outcome.exitKind,
                effectiveReceipt === null ? null : JSON.stringify(effectiveReceipt),
                endedAt,
                opts.sessionRef ?? null,
                errorJson,
                settlementDigest,
                runId,
              ]),
        );
        const receiptUsed = late === undefined && receiptWasUsed(exitCode, effectiveReceipt, stopIntent, opts);
        if (receiptUsed && opts.finalReply !== undefined && (plainProse || hasFinalMessageReport(effectiveReceipt))) saveRunReport(run, opts.finalReply, 'settlement');
        if (opts.usage && opts.usage.length > 0) {
          const tierModel = tierModelOf(run.snapshot_json);
          const normalized = normalizeRunUsage(db, run, opts.usage, tierModel);
          insertUsage(db, { run_id: runId }, endedAt, normalized, tierModel);
        }
        // Only adopted receipts may apply destroyed_machines or propose knowledge —
        // stale, interrupted, or rejected runs must not mutate ephemeral machine state.
        if (receiptUsed) {
          const ownProject = loadTask(run.task_id).project_id;
          for (const name of destroyedIn(effectiveReceipt)) {
            const named = currentMachine(name);
            if (named?.ephemeral && named.scope?.project_id === ownProject) noteDestroyed(name, runId, RUNNER);
          }
          knowledge.proposeFromReceipt(run, executorOf(run.snapshot_json), effectiveReceipt?.learned);
        }
        const result = { exit_code: exitCode, exit_kind: outcome.exitKind, receipt: effectiveReceipt, ...residue, ...lost, ...quota, ...(outcome.state === 'retry' ? { refused: outcome.reason } : {}) };
        if (late) {
          dispose(false,'stale_'+late);
          // The Run has just ended, so a Task left in running would have no way out.
          if (late === 'revision') moveTask(task.id, 'held', { reason: STALE_REVISION_REASON });
          writeChange(db, 'run.settle_late', RUNNER, refs, { reason: late, exit_code: exitCode, exit_kind: outcome.exitKind });
          reportSettlement(`run:${runId}`, run, { ...result, late_reason: late });
          return { late: true, reason: late };
        }
        // A sealed receipt is adopted only when it supplied the verdict. Failed receipts
        // count too; lost, unstarted and other explicit verdicts do not use that result.
        dispose(Boolean(receiptUsed && (capture ? evidence?.complete : opts.outputProcessed)), reason ?? outcome.exitKind);
        options.testHooks?.afterSettleRunWrite?.();

        let reviewWorkReady: { work: TaskRow; from: string } | null = null;
        switch (outcome.state) {
          case 'ready': {
            // A knowledge gate's or curation's verdict acts in this transaction too
            // (docs/design/knowledge-and-skills.md §3, §5.3): applied, the Task is done — the
            // service has taken its judgment, so there is nothing left to accept; one that does
            // not hold is a short delivery, and the proposal waits on.
            if (task.knowledge_json !== null) {
              const short = knowledge.settleKnowledgeTask(task, run.id, effectiveReceipt?.knowledge_verdict, RUNNER);
              if (short === null) moveTask(task.id, 'done', { closed: true });
              else moveTask(task.id, 'held', { reason: `交付不齐：${short}` });
              break;
            }
            // A review's verdict acts in this transaction: the review and what it does to
            // the reviewed Task stand or fall together (§6). "审不了" is not a rejection: the
            // review stops for the material to be supplied. Once pass/reject is applied, the
            // review task closes directly to done so it never lingers in ready.
            const verdict = task.review_of_json === null ? undefined : verdictOf(effectiveReceipt);
            if (verdict !== undefined && typeof verdict !== 'string') {
              if (verdict.result === 'cannot') {
                moveTask(task.id, 'held', { reason: cannotReviewText(verdict) });
                settleVerdict(task, run, verdict);
              } else {
                const binding = parseReviewOf(task.review_of_json)!;
                const reviewed = loadTask(binding.task_id);
                const reviewedReadyBefore = workReady(reviewed);
                const applied = settleVerdict(task, run, verdict);
                moveTask(task.id, 'done', { closed: true });
                if (applied.passCurrent && !reviewedReadyBefore && workReady(reviewed)) {
                  reviewWorkReady = { work: topWorkOf(reviewed.id), from: reviewed.id };
                }
              }
            } else {
              const hasQueuedInput = db.get('SELECT 1 FROM input WHERE task_id = ? AND state = ? LIMIT 1', task.id, 'queued') !== undefined;
              if (hasQueuedInput) {
                moveTask(task.id, 'queued');
                writeChange(db, 'task.auto_continue', RUNNER, refs, { reason: 'queued_input' });
              } else {
                moveTask(task.id, 'ready');
              }
            }
            break;
          }
          case 'held': {
            if (resumeAutoFallback) {
              writeChange(db, 'task.continue', RUNNER, refs, {
                reason: outcome.reason,
                basis: 'resume_failed',
                run_id: run.id,
                cleared_session_ref: usedSessionRef,
              });
              moveTask(task.id, 'queued');
              break;
            }
            if (startupNetworkAutoRetry) {
              const hasOtherLogin = task.login_id === null && loginPool(task).ids.some((id) => id !== run.login_id);
              const briefRestUntil = hasOtherLogin ? restLoginBriefly(run, networkReasonText || '启动网络异常', 60_000) : undefined;
              writeChange(db, 'task.continue', RUNNER, refs, {
                reason: outcome.reason,
                basis: 'startup_network_retry',
                run_id: run.id,
                login_id: run.login_id,
                ...(briefRestUntil ? { rest_until: briefRestUntil } : {}),
              });
              moveTask(task.id, 'queued');
              break;
            }
            const isOrdinary = task.review_of_json === null && task.knowledge_json === null && notRestoring;
            const hasQueuedInput = outcome.exitKind === 'interrupted' && isOrdinary
              && db.get('SELECT 1 FROM input WHERE task_id = ? AND state = ? LIMIT 1', task.id, 'queued') !== undefined;
            if (hasQueuedInput) {
              moveTask(task.id, 'queued');
              writeChange(db, 'task.auto_continue', RUNNER, refs, { reason: 'interrupted_with_queued_input' });
            } else {
              moveTask(task.id, 'held', { reason: outcome.reason });
            }
            break;
          }
          case 'waiting_person':
            askQuestions(task, runId, outcome.questions, RUNNER);
            break;
          case 'waiting_timer':
            moveTask(task.id, 'waiting_timer', { wakeAt: outcome.wakeAt });
            break;
          case 'continue': {
            // Bound to a round nothing of which ran, so never delivered: the next round
            // takes them. Any other lost round keeps its inputs, delivered or not.
            if (basis === 'not_started') {
              db.run(`UPDATE input SET state = 'queued', run_id = NULL WHERE run_id = ? AND state = 'attached'`, runId);
            }
            const next = afterLoss(task, basis, run);
            moveTask(task.id, next.state, next.state === 'held' ? { reason: next.reason } : {});
            break;
          }
          case 'requeue': {
            // The round ran, so its inputs stay bound, as a lost round's do: whether it
            // acted on them is for the next round to check.
            const next = afterQuota(task, run, restUntil, outcome.exitKind);
            moveTask(task.id, next.state, next.state === 'held' ? { reason: next.reason } : {});
            break;
          }
          case 'retry':
            // A ledger restored from a copy waits for the owner, as every way on by itself does.
            if (readSetting<RestoreMark | null>('restore', null)) {
              moveTask(task.id, 'held', { reason: RESTORE_HOLD_REASON });
              break;
            }
            writeChange(db, 'task.continue', RUNNER, refs, { reason: outcome.reason, run_id: run.id });
            moveTask(task.id, 'queued');
            break;
        }
        // A merge round's settlement is where the Task it lands learns the pull request went in
        // (project-sessions, "负责人可以自己做的事"): the commit the receipt names is the commit on
        // the main line, and the one landing_json holds was the reviewed one. Only a round that
        // settled ready lands it: a short delivery, a pull request no one can tell, a delivery
        // that names no one commit, or read-only code that was not adopted leaves the parent
        // untouched, and the round that goes on after the stop settles it then. A receipt that
        // does not say the merge happened leaves the parent untouched and settles this Task as it
        // is. The commit is the one this settlement read (deliveryOf), never a second reading.
        const landing = parseLanding(task.landing_json);
        if (landing !== null && outcome.state === 'ready') {
          if (delivery?.commit !== undefined) {
            noteIntegrated({ taskId: landing.of }, {
              branch: null,
              commit: delivery.commit,
              source_commit: landing.commit,
              pr: landing.pr,
              landing_task_id: task.id,
            }, RUNNER);
            moveTask(task.id, 'done', { closed: true });
          } else {
            const summary = typeof effectiveReceipt?.summary === 'string' ? effectiveReceipt.summary.trim() : '';
            moveTask(task.id, 'held', { reason: summary || '未能并入主线' });
          }
        }
        // Read back, not assumed: the queue's guard may have sent a Task with no role to
        // the owner instead, and the record and the answer say where it really is.
        const taskState = loadTask(task.id).state;
        writeChange(db, 'run.settle', RUNNER, refs, {
          exit_code: exitCode,
          exit_kind: outcome.exitKind,
          task_state: taskState,
          ...(outcome.exitKind === 'lost' ? { basis } : {}),
          ...(opts.quota ? { login_id: run.login_id, rest_until: restUntil ?? null } : {}),
        });
        // A knowledge gate or curation whose verdict the service applied leaves nothing for the
        // Router to do; one that came back short is reported like any other round.
        if (task.knowledge_json === null || taskState !== 'done') {
          // Into ready in this settlement; ready again after rework is a new round and a new time.
          const selfBecameReady = reviewWorkReady === null && !readyBefore && workReady(task);
          const readyWork = reviewWorkReady ?? (selfBecameReady ? { work: topWorkOf(task.id), from: task.id } : null);
          const becameReady = readyWork !== null;
          const direct = selfBecameReady && taskState === 'ready' && !opts.residue && !opts.quota && !opts.lost
            && mayNotifyReadyDirectly(task, effectiveReceipt);
          const told = reportSettlement(`run:${runId}`, run, { ...result, work_became_ready: becameReady });
          // A result is the settlement's, in the service's words, whatever becomes of the
          // Router: the Router's sentence may only take their place later (project-sessions §2.1).
          if (readyWork !== null) {
            const event = internalEvents.workReady(readyWork.work.id, runId);
            // A matching subscription still rides on the settlement. Keep the Router turn
            // if there is any subscription or if the owner's notice has no direct work link yet.
            const subscribed = internalEvent(event, { from: readyWork.from, attachTo: told });
            if (direct && !subscribed && pushes.resultDelivery(event.id) === 'pending') {
              db.run("UPDATE message SET state = 'ignored' WHERE id = ?", told);
              writeChange(db, 'run.ready_notice', { ...RUNNER, messageId: told }, refs, {
                rule: 'ready-report-v1', reason: 'owner_acceptance_requested', notice_key: event.id,
              });
            }
          }
        }
        return { late: false, task_state: taskState };
      });
    },

    openApproval(taskId: string, questions: Question[], ctx: Ctx): string {
      return write(() => {
        if (!Array.isArray(questions) || questions.length === 0) throw new InputError('问题不能为空');
        const task = loadTask(taskId);
        requireState(task, ['queued', 'held', 'waiting_person', 'waiting_timer'], '提问');
        return askQuestions(task, null, questions, ctx);
      });
    },

    answerApproval(
      approvalId: string,
      answers: unknown[],
      actor: string,
      via: string,
      messageId?: string,
    ): AnswerResult {
      return write((): AnswerResult => {
        const allowed = readSetting<Whitelist>('whitelist', {})[via];
        if (!Array.isArray(allowed) || !allowed.includes(actor)) throw new InputError(`${actor} 无权经 ${via} 答复`);
        const approval = db.get<ApprovalRow>('SELECT * FROM approval WHERE id = ?', approvalId);
        if (!approval) throw new InputError(`问题不存在：${approvalId}`);
        const task = loadTask(approval.task_id);
        if (approval.state !== 'open' || approval.task_revision !== task.revision) return { status: 'closed' };

        const questions = JSON.parse(approval.questions_json) as Question[];
        const complete =
          Array.isArray(answers) &&
          answers.length === questions.length &&
          answers.every((answer) => answer != null && String(answer).trim() !== '');
        if (!complete) throw new InputError('答卷不完整');

        const at = nowIso();
        // Decide-tier rejection approvals offer deterministic owner actions (accept without review
        // or abandon) alongside rework, so clicking or replying them executes directly without
        // queuing an extra worker round.
        if (approval.review_task_id != null && questions.length === 1) {
          const ans = String(answers[0]).trim();
          const acceptMatch = matchDecideAction(ans, DECIDE_ACCEPT_OPTION);
          if (acceptMatch.matched) {
            if (actor === 'router') throw new InputError('只有主人能在控制台“不经审阅验收”');
            const effectiveBasis = acceptMatch.reason || '审阅打回后主人决定不经审阅直接验收';
            db.run(
              `UPDATE approval SET state = 'answered', answers_json = ?, answered_by = ?, answered_via = ?, decided_at = ?
               WHERE id = ?`,
              JSON.stringify(answers), actor, via, at, approvalId,
            );
            moveTask(task.id, 'done', { closed: true });
            enqueueNotification(NOTICE_CHANNEL, 'approval_answered', {
              external_id: `approval_answered:${approvalId}`,
              approval_id: approvalId,
              task_id: task.id,
            });
            writeChange(db, 'approval.answer', { actor, messageId }, { taskId: task.id }, { approval_id: approvalId, via, action: 'accept_without_review' });
            writeChange(db, 'task.accept', { actor, messageId }, { taskId: task.id }, { basis: effectiveBasis, without_review: true });
            const nth = db.get<{ n: number }>(`SELECT count(*) AS n FROM change WHERE task_id = ? AND action = 'task.accept'`, task.id)!.n;
            internalEvent(internalEvents.accepted(task.id, nth, effectiveBasis));
            return { status: 'accepted', action: 'accept_without_review' };
          }
          const abandonMatch = matchDecideAction(ans, DECIDE_ABANDON_OPTION);
          if (abandonMatch.matched) {
            requireNoActiveRun(task, '放弃');
            const effectiveReason = abandonMatch.reason || '审阅打回后主人放弃';
            db.run(
              `UPDATE approval SET state = 'answered', answers_json = ?, answered_by = ?, answered_via = ?, decided_at = ?
               WHERE id = ?`,
              JSON.stringify(answers), actor, via, at, approvalId,
            );
            moveTask(task.id, 'abandoned', { reason: effectiveReason, closed: true });
            enqueueNotification(NOTICE_CHANNEL, 'approval_answered', {
              external_id: `approval_answered:${approvalId}`,
              approval_id: approvalId,
              task_id: task.id,
            });
            writeChange(db, 'approval.answer', { actor, messageId }, { taskId: task.id }, { approval_id: approvalId, via, action: 'abandon' });
            writeChange(db, 'task.abandon', { actor, messageId }, { taskId: task.id }, { reason: effectiveReason });
            return { status: 'accepted', action: 'abandon' };
          }
        }
        db.run(
          `UPDATE approval SET state = 'answered', answers_json = ?, answered_by = ?, answered_via = ?, decided_at = ?
           WHERE id = ?`,
          JSON.stringify(answers),
          actor,
          via,
          at,
          approvalId,
        );
        const inputId = ulid();
        db.run(
          `INSERT INTO input (id, created_at, task_id, text, actor, message_id, state) VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
          inputId,
          at,
          task.id,
          JSON.stringify(questions.map((q, i) => ({
            question: q.question,
            ...(q.about ? { context: q.about } : {}),
            answer: answers[i],
          }))),
          actor,
          messageId ?? null,
        );
        moveTask(task.id, 'queued');
        enqueueNotification(NOTICE_CHANNEL, 'approval_answered', {
          external_id: `approval_answered:${approvalId}`,
          approval_id: approvalId,
          task_id: task.id,
        });
        writeChange(db, 'approval.answer', { actor, messageId }, { taskId: task.id }, { approval_id: approvalId, via });
        return { status: 'accepted', input_id: inputId };
      });
    },

    addInput(taskId: string, text: string, ctx: Ctx): string {
      return write(() => {
        if (isBlank(text)) throw new InputError('内容不能为空');
        const task = loadTask(taskId);
        if (task.state === 'done' || task.state === 'abandoned') {
          throw new InputError(`任务 ${taskId} 已关闭，不能插话`);
        }
        const id = ulid();
        db.run(
          `INSERT INTO input (id, created_at, task_id, text, actor, message_id, state) VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
          id,
          nowIso(),
          taskId,
          text,
          ctx.actor,
          ctx.messageId ?? null,
        );
        writeChange(db, 'input.add', ctx, { taskId }, { input_id: id });
        tellRouter(`input:${id}`, ctx.actor, `任务“${task.title}”收到插话，下一次 Run 启动时送达，不用回复`, {
          task_id: taskId,
          input_id: id,
          text,
        }, { quiet: true });
        return id;
      });
    },

    updateInput(taskId: string, inputId: string, text: string, ctx: Ctx): InputRow {
      return write(() => {
        if (isBlank(text)) throw new InputError('内容不能为空');
        const input = db.get<InputRow>('SELECT * FROM input WHERE id = ? AND task_id = ?', inputId, taskId);
        if (!input) throw new NotFoundError(`插话不存在：${inputId}`);
        if (input.state !== 'queued' || input.run_id !== null) {
          throw new InputError('这条插话已经送达执行轮次，不能修改或撤回');
        }
        const trimmed = text.trim();
        db.run('UPDATE input SET text = ? WHERE id = ? AND task_id = ?', trimmed, inputId, taskId);
        writeChange(db, 'input.update', ctx, { taskId }, { input_id: inputId });
        return { ...input, text: trimmed };
      });
    },

    deleteInput(taskId: string, inputId: string, ctx: Ctx): void {
      write(() => {
        const input = db.get<InputRow>('SELECT * FROM input WHERE id = ? AND task_id = ?', inputId, taskId);
        if (!input) throw new NotFoundError(`插话不存在：${inputId}`);
        if (input.state !== 'queued' || input.run_id !== null) {
          throw new InputError('这条插话已经送达执行轮次，不能修改或撤回');
        }
        db.run('DELETE FROM input WHERE id = ? AND task_id = ?', inputId, taskId);
        writeChange(db, 'input.delete', ctx, { taskId }, { input_id: inputId });
        const task = loadTask(taskId);
        if (task.state === 'queued' && activeRun(task) === undefined) {
          const remaining = db.get('SELECT 1 FROM input WHERE task_id = ? AND state = ? LIMIT 1', taskId, 'queued');
          if (remaining === undefined) {
            const latestTransition = db.get<{ action: string }>(
              `SELECT action FROM change WHERE task_id = ? AND action IN ('task.auto_continue', 'task.queue', 'task.resume', 'task.rework', 'task.wake', 'run.create') ORDER BY seq DESC LIMIT 1`,
              taskId,
            );
            if (latestTransition?.action === 'task.auto_continue') {
              moveTask(taskId, 'ready');
              writeChange(db, 'task.revert_ready', ctx, { taskId }, { reason: 'queued_inputs_deleted' });
            }
          }
        }
      });
    },

    voidInput(inputId: string, ctx: Ctx): void {
      write(() => {
        const input = db.get<InputRow>('SELECT * FROM input WHERE id = ?', inputId);
        if (!input) throw new InputError(`输入不存在：${inputId}`);
        if (input.state !== 'queued') throw new InputError(`输入 ${inputId} 状态为 ${input.state}，不能作废`);
        db.run(`UPDATE input SET state = 'void' WHERE id = ?`, inputId);
        writeChange(db, 'input.void', ctx, { taskId: input.task_id }, { input_id: inputId });
      });
    },

    scheduleWake(taskId: string, at: string | Date, ctx: Ctx): void {
      write(() => {
        const wakeAt = parseInstant(at);
        if (!wakeAt) throw new InputError(`预约时间必须带时区：${String(at)}`);
        requireState(loadTask(taskId), ['queued', 'held', 'waiting_person', 'waiting_timer'], '预约');
        moveTask(taskId, 'waiting_timer', { wakeAt });
        writeChange(db, 'task.schedule_wake', ctx, { taskId }, { wake_at: wakeAt });
      });
    },

    fireDueWakes(now: Date = new Date()): string[] {
      return write(() => {
        const due = db.all<{ id: string; project_id: string | null }>(
          `SELECT id, project_id FROM task WHERE state = 'waiting_timer' AND wake_at <= ? ORDER BY wake_at, rowid`,
          now.toISOString(),
        ).filter(({ project_id }) => db.mayWriteProject(project_id));
        for (const { id } of due) {
          moveTask(id, 'queued');
          writeChange(db, 'task.wake', TIMER, { taskId: id });
        }
        return due.map(({ id }) => id);
      });
    },

    // A ledger from before lost Runs continued by themselves can hold Tasks that wait
    // for an owner's "继续" which no longer exists. Their Run is already settled as lost.
    continueStranded(): string[] {
      return write(() => {
        const stranded = db.all<{ id: string; project_id: string | null }>(
          `SELECT id, project_id FROM task WHERE state = 'needs_verification'
             AND NOT EXISTS (SELECT 1 FROM run WHERE run.task_id = task.id AND run.state != 'ended') ORDER BY rowid`,
        ).filter(({ project_id }) => db.mayWriteProject(project_id));
        for (const { id } of stranded) {
          const last = db.get<RunRow>('SELECT * FROM run WHERE task_id = ? ORDER BY rowid DESC LIMIT 1', id);
          const next = afterLoss(loadTask(id), (last && lostBasis(last)) ?? 'seen');
          moveTask(id, next.state, next.state === 'held' ? { reason: next.reason } : {});
          if (next.state === 'held') writeChange(db, 'task.hold', RUNNER, { taskId: id }, { reason: next.reason });
        }
        return stranded.map(({ id }) => id);
      });
    },

    // After a restore, dispatch resumes only on a count the owner has confirmed. Pausing
    // is always safe.
    setPause(paused: boolean, ctx: Ctx): void {
      refuseDuringInventory();
      write(() => {
        if (!paused && readSetting<RestoreMark | null>('restore', null)) throw new InputError('先确认清点完成，再恢复派发');
        writeSetting('pause.user', paused);
        writeChange(db, 'pause.set', ctx, {}, { paused });
      });
    },

    // §2, on the copy that is about to replace the ledger. Nothing in a backup can be
    // assumed unhandled, so all of it stops here, in one transaction: a file that gets
    // into place at all is already safe to start from.
    sealRestore(from: string): RestoreCounts {
      return write(() => {
        const backupAt = db.get<{ at: string }>('SELECT at FROM change ORDER BY seq DESC LIMIT 1')?.at ?? null;
        writeSetting('pause.user', true);
        const notifications = outbox.giveUpPending(RESTORE_GIVE_UP_REASON);
        const messageIds = messages.markOpenUnverified();
        const tasks = db.all<{ id: string }>(`SELECT id FROM task WHERE state IN ('queued', 'waiting_timer') ORDER BY rowid`);
        for (const { id } of tasks) {
          moveTask(id, 'held', { reason: RESTORE_HOLD_REASON });
          writeChange(db, 'task.hold', SERVICE, { taskId: id }, { reason: RESTORE_HOLD_REASON });
        }
        const runIds = db.all<{ id: string }>(`SELECT id FROM run WHERE state != 'ended' ORDER BY rowid`).map(({ id }) => id);
        const mark: RestoreMark = { from, backup_at: backupAt, restored_at: nowIso(), run_ids: runIds, message_ids: messageIds };
        writeSetting('restore', mark);
        const counts = {
          backup_at: backupAt,
          active_runs: runIds.length,
          held_tasks: tasks.length,
          unverified_messages: messageIds.length,
          given_up_notifications: notifications,
        };
        writeChange(db, 'ledger.restore', SERVICE, {}, { from, ...counts });
        return counts;
      });
    },

    getRestore: (): RestoreMark | null => readSetting<RestoreMark | null>('restore', null),

    // Whether losing the Task's current round would stop it instead of continuing it.
    lostLimitReached: (taskId: string): boolean => lostInARow(taskId) + 1 >= lostLimit(),

    restoreHeldTasks,

    // Resuming dispatch stays a separate act of the owner's.
    confirmRestore(ctx: Ctx): void {
      refuseDuringInventory();
      write(() => {
        const held = restoreHeldTasks().length;
        if (held > 0) throw new InputError(`还有 ${held} 个任务等你确认`);
        db.run(`DELETE FROM setting WHERE key = 'restore'`);
        writeChange(db, 'ledger.restore_confirm', ctx);
      });
    },

    // Execution accounts are the owner's objects. service/accounts.ts decides what a valid
    // one is; here they are rows, read at each use.
    listAccounts: (): AccountRecord[] => db.all<AccountRow>('SELECT * FROM account ORDER BY rowid').map(accountOf),

    getAccount(id: string): AccountRecord | undefined {
      const row = db.get<AccountRow>('SELECT * FROM account WHERE id = ?', id);
      return row && accountOf(row);
    },

    renameAccount,

    // The name a new account would get at this moment, by the one rule that decides it, for
    // the login window to show before the account is saved (docs/design/native-login.md §2):
    // what a clash with an existing name would make of the executor's own. Not a promise —
    // the save's own transaction decides again.
    defaultAccountName: (executor: string): string => newAccountName(undefined, executor),

    // Creates the account or replaces everything about it but its id. A write that changes
    // nothing leaves no trace. An account is a login tycho keeps: it is created with the
    // number of its token file and never stands without one, and moving it to another
    // executor takes a new token in the same write — the old one was for the old executor.
    // A name is display, not a reference: a new account's is decided here, in this same
    // transaction, from what was written, and a name already held is numbered rather than
    // refused.
    putAccount(account: Omit<Account, 'name'> & { name?: string }, ctx: Ctx, credentialRef?: string): { created: boolean } {
      return write(() => {
        const at = nowIso();
        const row = db.get<AccountRow>('SELECT * FROM account WHERE id = ?', account.id);
        if (!row) {
          if (credentialRef === undefined) throw new InputError(NO_CREDENTIAL_TEXT);
          const name = newAccountName(account.name, account.executor);
          const next = loginConfig({ ...account, name, machine: undefined });
          db.run(
            `INSERT INTO account (id, name, created_at, updated_at, executor, tiers_json, permission_mode, timeout_ms, max_runs, credential_ref, credential_at, provider_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            account.id, name, at, at, next.executor,
            JSON.stringify(next.tiers), next.permission_mode, next.timeout_ms, next.max_runs, credentialRef, at,
            next.provider === undefined ? null : JSON.stringify(next.provider),
          );
          writeChange(db, 'account.create', ctx, {}, { account_id: account.id, account: { name, ...next } });
          return { created: true };
        }
        // An edit that names no name keeps the one it has; the rename's own refusal stands.
        const name = account.name ?? row.name;
        const next = loginConfig({ ...account, name, machine: undefined });
        const before = loginConfig(accountOf(row));
        renameAccount(account.id, name, ctx);
        if (next.executor !== before.executor && credentialRef === undefined) {
          throw new InputError(`账号 ${account.id} 换执行器要同时填新执行器的登录令牌：原来的令牌是给 ${before.executor} 的`);
        }
        const changed = Object.fromEntries(
          // Both sides' fields: a line is a field only of a login that has one.
          ([...new Set([...Object.keys(before), ...Object.keys(next)])] as (keyof typeof next)[])
            .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(next[field]))
            .map((field) => [field, { from: before[field], to: next[field] }]),
        );
        const token = credentialRef !== undefined && credentialRef !== row.credential_ref;
        if (Object.keys(changed).length === 0 && !token) return { created: false };
        db.run(
          `UPDATE account SET updated_at = ?, executor = ?, tiers_json = ?,
             permission_mode = ?, timeout_ms = ?, max_runs = ?, credential_ref = ?, credential_at = ?, provider_json = ? WHERE id = ?`,
          at, next.executor, JSON.stringify(next.tiers),
          next.permission_mode, next.timeout_ms, next.max_runs, credentialRef ?? row.credential_ref,
          // A token stored in this same write is a token that came in now; the rest of the
          // account changing says nothing about when its token did.
          token ? at : row.credential_at,
          next.provider === undefined ? null : JSON.stringify(next.provider), account.id,
        );
        if (Object.keys(changed).length > 0) writeChange(db, 'account.update', ctx, {}, { account_id: account.id, changed });
        if (token) {
          clearAccountIdentity(account.id);
          writeChange(db, 'account.credential_set', ctx, {}, { account_id: account.id });
        }
        return { created: false };
      });
    },

    // A machine's own logins, by machine and executor: the owner's settings for a login the
    // machine has (docs/design/accounts-machines-decoupled.md). Whether the machine has it
    // now is its own report, read where work is placed.
    listMachineLogins: (): MachineLoginRecord[] => db.all<MachineLoginRow>('SELECT * FROM machine_login ORDER BY rowid').map(machineLoginOf),

    getMachineLoginById: machineLoginById,

    getMachineLogin(machineId: string, executor: string): MachineLoginRecord | undefined {
      const row = db.get<MachineLoginRow>('SELECT * FROM machine_login WHERE machine_id = ? AND executor = ?', machineId, executor);
      return row && machineLoginOf(row);
    },

    // Creates or replaces the settings of one machine's own login. The machine has to be one
    // the ledger holds: a login of a machine that is not there is nobody's. The owner writing
    // it is also the owner accepting the login: a refusal recorded when it was removed in this
    // registration no longer stands.
    putMachineLogin(login: Omit<Login, 'id' | 'name'> & { machine: string }, ctx: Ctx): { created: boolean } {
      return write(() => {
        const machine = currentMachine(login.machine);
        if (!machine) throw new InputError('机器不存在：' + login.machine);
        db.run('DELETE FROM machine_login_refusal WHERE machine_uid = ? AND executor = ?', machine.uid, login.executor);
        const at = nowIso();
        const row = db.get<MachineLoginRow>('SELECT * FROM machine_login WHERE machine_id = ? AND executor = ?', login.machine, login.executor);
        const id = row?.id ?? ulid();
        const next = loginConfig({ ...login, id, name: `${login.machine}/${login.executor}` });
        if (!row) {
          db.run(
            `INSERT INTO machine_login (id, machine_uid, machine_id, executor, created_at, updated_at, tiers_json, permission_mode, timeout_ms, max_runs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, machine.uid, login.machine, login.executor, at, at, JSON.stringify(next.tiers), next.permission_mode, next.timeout_ms, next.max_runs,
          );
          writeChange(db, 'machine_login.create', ctx, {}, { login_id: id, login: next });
          return { created: true };
        }
        const before = loginConfig(machineLoginOf(row));
        const changed = Object.fromEntries(
          (Object.keys(next) as (keyof typeof next)[])
            .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(next[field]))
            .map((field) => [field, { from: before[field], to: next[field] }]),
        );
        if (Object.keys(changed).length === 0) return { created: false };
        db.run(
          'UPDATE machine_login SET updated_at = ?, tiers_json = ?, permission_mode = ?, timeout_ms = ?, max_runs = ? WHERE machine_id = ? AND executor = ?',
          at, JSON.stringify(next.tiers), next.permission_mode, next.timeout_ms, next.max_runs, login.machine, login.executor,
        );
        writeChange(db, 'machine_login.update', ctx, {}, { login_id: id, changed });
        return { created: false };
      });
    },

    // A machine reported, in this registration, that one of its executors is signed in, and the
    // owner has not set that login up here (docs/design/accounts-machines-decoupled.md "机器
    // 自己的登录什么时候能用"): the login is written with the tiers its adapter declares, so it
    // can take work at once. Nothing is written when the login is already set up, when the
    // owner removed it in this registration (a refusal), or when the machine is gone. Checked
    // and written in one transaction: the same report arriving twice makes one login.
    adoptMachineLogin(
      machineId: string,
      executor: string,
      tiers: Record<string, Tier>,
      ctx: Ctx,
      identity?: ExecutorIdentity,
    ): { created: boolean } {
      return write(() => {
        const machine = currentMachine(machineId);
        if (!machine) return { created: false };
        if (db.get('SELECT 1 FROM machine_login WHERE machine_id = ? AND executor = ?', machineId, executor)) return { created: false };
        if (db.get('SELECT 1 FROM machine_login_refusal WHERE machine_uid = ? AND executor = ?', machine.uid, executor)) return { created: false };
        // Do not auto-adopt a redundant machine-local login when a centralized account for the
        // same executor already covers the exact same subscription identity (prevents duplicate
        // Codex/Claude rows whenever a new machine joins with the owner's same CLI sign-in).
        if (identity) {
          const reportedOrg = identity.organizationId?.trim() || null;
          const reportedOwner = identity.quotaOwner?.trim() || null;
          const reportedLabel = identity.accountLabel?.trim().toLowerCase() || null;
          if (reportedOrg || reportedOwner || reportedLabel) {
            const acctRows = db.all<{ id: string; identity_json: string | null }>(
              `SELECT a.id, s.identity_json FROM account a LEFT JOIN login_state s ON s.id = a.id WHERE a.executor = ?`,
              executor,
            );
            for (const row of acctRows) {
              if (!row.identity_json) continue;
              try {
                const parsed = JSON.parse(row.identity_json) as ExecutorIdentity | null;
                if (!parsed) continue;
                const sameOrg = Boolean(reportedOrg && parsed.organizationId?.trim() === reportedOrg);
                const sameOwner = Boolean(reportedOwner && parsed.quotaOwner?.trim() === reportedOwner);
                const sameLabel = Boolean(reportedLabel && parsed.accountLabel?.trim().toLowerCase() === reportedLabel);
                if (sameOrg || sameOwner || sameLabel) return { created: false };
              } catch { /* ignore malformed identity_json */ }
            }
          }
        }
        const at = nowIso();
        const id = ulid();
        const name = machineLoginName(machineId, executor);
        const next = loginConfig({ id, name, executor, machine: machineId, tiers });
        db.run(
          `INSERT INTO machine_login (id, machine_uid, machine_id, executor, created_at, updated_at, tiers_json, permission_mode, timeout_ms, max_runs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, machine.uid, machineId, executor, at, at, JSON.stringify(next.tiers), next.permission_mode, next.timeout_ms, next.max_runs,
        );
        writeChange(db, 'machine_login.create', ctx, {}, { login_id: id, login: next, reason: '机器报告已登录，自动采用' });
        return { created: true };
      });
    },

    // The owner removed a machine's own login in this registration: the host does not adopt it
    // back from the machine's reports. A sign-in made through tycho, or the owner setting it
    // up, clears it; the machine going away ends it, since a machine joined again is another
    // registration and inherits nothing.
    clearMachineLoginRefusal(machineId: string, executor: string, ctx: Ctx): void {
      const machine = currentMachine(machineId);
      if (!machine) return;
      if (!db.get('SELECT 1 FROM machine_login_refusal WHERE machine_uid = ? AND executor = ?', machine.uid, executor)) return;
      write(() => {
        db.run('DELETE FROM machine_login_refusal WHERE machine_uid = ? AND executor = ?', machine.uid, executor);
      });
    },

    // The settings go, what was learned using the login with them, and its reference in the
    // projects that allowed it. What becomes of work on it is the rules' for any login that
    // is gone: a Run on it is judged where it is, and a Task pinned to it stops. The projects
    // it was removed from come back for the answer, with what each has left. The removal is
    // also recorded as a refusal of this machine's registration, so the host never adopts it
    // back from the machine's own reports: only a sign-in made through tycho, or the owner
    // setting it up again, puts it back.
    deleteMachineLogin(machineId: string, executor: string, ctx: Ctx): { projects: { id: string; name: string; remaining: number }[] } {
      return write(() => {
        const row = db.get<MachineLoginRow>('SELECT * FROM machine_login WHERE machine_id = ? AND executor = ?', machineId, executor);
        if (!row) throw new InputError(`机器 ${machineId} 上没有设置过 ${executor} 的登录`);
        const id = row.id;
        const loginName = machineLoginOf(row).name;
        const projects = forgetLoginInProjects(id, loginName, ctx);
        db.run('DELETE FROM machine_login WHERE machine_id = ? AND executor = ?', machineId, executor);
        db.run('DELETE FROM login_state WHERE id = ?', id);
        db.run(
          `INSERT INTO machine_login_refusal (machine_uid, executor, created_at) VALUES (?, ?, ?)
             ON CONFLICT (machine_uid, executor) DO UPDATE SET created_at = excluded.created_at`,
          row.machine_uid, executor, nowIso(),
        );
        writeChange(db, 'machine_login.delete', ctx, {}, { login_id: id, login_name: loginName, login: loginConfig(machineLoginOf(row)), projects: projects.map(({ name }) => name) });
        return { projects };
      });
    },

    // Whether a login of this id is held now: an account, or a machine's own login.
    hasLogin: (loginId: string | null): boolean => loginExists(loginId),

    // Counted in the transaction that deletes, so work that arrived since the owner looked
    // asks again. What becomes of that work is the existing rules': a Run whose machine is
    // gone is judged gone, and a queued Task with no account stops with that as its reason.
    // A project left with no account that exists is named: its Tasks have nowhere to go
    // until the owner chooses another login for the project. The reference goes from every
    // project that allowed it, in this same transaction, and the answer lists them with what
    // each has left (docs/design/native-login.md §2).
    deleteAccount(id: string, ctx: Ctx, options: { confirmed?: boolean } = {}): { projects: { id: string; name: string; remaining: number }[] } {
      return write(() => {
        const row = db.get<AccountRow>('SELECT * FROM account WHERE id = ?', id);
        if (!row) throw new InputError(`账号不存在：${id}`);
        const count = (sql: string): number => db.get<{ n: number }>(sql, id)!.n;
        const queued = count(`SELECT count(*) AS n FROM task WHERE login_id = ? AND state = 'queued'`);
        const active = count(`SELECT count(*) AS n FROM run WHERE login_id = ? AND state != 'ended'`);
        const affected = remainingAfter(id);
        // A project that allowed only this login (or only deleted ones besides) has nowhere
        // to run once it goes: the count is against the logins that exist now.
        const stranded = affected.filter(({ remaining }) => remaining === 0).map(({ name }) => name);
        if ((queued > 0 || active > 0 || stranded.length > 0) && !options.confirmed) {
          const work = queued > 0 || active > 0
            ? `账号 ${row.name} 上还有 ${queued} 个排队的任务、${active} 个没结束的执行。删掉后，没结束的执行按“机器被移除”判定为不在，排队的任务会停住。`
            : '';
          const wayOut = stranded.length > 0
            ? `项目 ${stranded.join('、')} 删了以后没有可用的登录：它们的任务派不出去，需要在项目页重新选择允许的登录。`
            : '停住的任务要接着做，需要给它们换一个项目允许的登录。同名新账号不会继承引用。';
          throw new ConfirmationRequired(`${work}${wayOut}确认要删就再点一次`, {
            queued_tasks: queued, active_runs: active, stranded_projects: stranded, projects: affected,
          });
        }
        const projects = forgetLoginInProjects(id, row.name, ctx);
        db.run('DELETE FROM account WHERE id = ?', id);
        // What was learned about it goes with it: a account of this name added later is another.
        db.run('DELETE FROM login_state WHERE id = ?', id);
        writeChange(db, 'account.delete', ctx, {}, {
          account_id: id, account: { name: row.name, ...loginConfig(accountOf(row)) }, queued_tasks: queued, active_runs: active,
          projects: projects.map(({ name }) => name),
        });
        return { projects };
      });
    },

    // --- roles (docs/design/roles-and-tiers.md §3) ------------------------------------

    listRoles: (): RoleRecord[] => db.all<RoleRow>('SELECT * FROM role ORDER BY rowid').map(roleRecord),
    getRole: (id: string): RoleRecord | undefined => roleOf(id),

    // What a valid role is, the review role's shape included, is service/roles.ts's to
    // say; the ledger keeps the name unique and says what changed.
    putRole(role: RoleConfig, ctx: Ctx): { created: boolean; changed?: Record<string, { from: unknown; to: unknown }> } {
      return write(() => {
        const before = roleOf(role.id);
        const next = roleConfig(role);
        const clash = db.get<{ id: string }>('SELECT id FROM role WHERE name = ? AND id != ?', next.name, next.id);
        if (clash) throw new InputError(`职能名 ${next.name} 已经被 ${clash.id} 用了`);
        const changed = before === undefined ? undefined : Object.fromEntries(
          (Object.keys(next) as (keyof RoleConfig)[]).filter((key) => before[key] !== next[key]).map((key) => [key, { from: before[key], to: next[key] }]),
        );
        if (changed && Object.keys(changed).length === 0) return { created: false };
        const at = nowIso();
        db.run(
          `INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, name = excluded.name, description = excluded.description,
             default_tier = excluded.default_tier, permission = excluded.permission, deliverable = excluded.deliverable, needs_review = excluded.needs_review`,
          next.id, at, at, next.name, next.description, next.default_tier, next.permission, next.deliverable, next.needs_review ? 1 : 0,
        );
        writeChange(db, before ? 'role.update' : 'role.create', ctx, {}, { role_id: next.id, ...(before ? { changed } : { role: next }) });
        return { created: !before, ...(changed ? { changed } : {}) };
      });
    },

    // A role a Task that has not ended still names stays: that Task would lose its tier.
    // An ended Task keeps the id as its record; its rounds' snapshots hold what the role was.
    deleteRole(id: string, ctx: Ctx): void {
      write(() => {
        const role = roleOf(id);
        if (!role) throw new InputError('职能不存在：' + id);
        const using = db.all<{ id: string }>(`SELECT id FROM task WHERE role_id = ? AND state NOT IN ('done', 'abandoned') ORDER BY rowid`, id);
        if (using.length > 0) {
          throw new InputError(`还有 ${using.length} 个没结束的任务是这个职能（${using.slice(0, 5).map((task) => task.id).join('、')}${using.length > 5 ? ' 等' : ''}），先给它们换一个职能再删`);
        }
        db.run('DELETE FROM role WHERE id = ?', id);
        const registry = readSkillRegistry();
        let registryChanged = false;
        const nextRegistry: SkillRegistryMap = {};
        for (const [slug, binding] of Object.entries(registry)) {
          if (binding.roles.includes(id)) {
            registryChanged = true;
            nextRegistry[slug] = { ...binding, roles: binding.roles.filter((each) => each !== id) };
          } else {
            nextRegistry[slug] = binding;
          }
        }
        if (registryChanged) writeSetting(SKILL_REGISTRY_SETTING_KEY, nextRegistry);
        writeChange(db, 'role.delete', ctx, {}, { role_id: id, role: roleConfig(role) });
      });
    },

    listMachines: (): MachineRecord[] => db.all<MachineRow>(`${MACHINE_SELECT} ORDER BY machine.rowid`).map(machineOf),
    getMachine: (id: string): MachineRecord | undefined => currentMachine(id),

    // The machine a node token belongs to, or undefined. The ledger is the authority for
    // this: a machine the owner removed stops answering its client's next poll, with
    // nothing held anywhere else to invalidate (docs/design/nodes.md §9).
    machineByNodeToken(hash: string): MachineRecord | undefined {
      const row = db.get<MachineRow>(`${MACHINE_SELECT} WHERE machine.token_hash = ?`, hash);
      return row ? machineOf(row) : undefined;
    },

    machineByNodeId(nodeId: string): MachineRecord | undefined {
      const row = db.get<MachineRow>(`${MACHINE_SELECT} WHERE machine.node_id = ?`, nodeId);
      return row ? machineOf(row) : undefined;
    },

    // The owner let a machine in: the client's own identity, the token's hash, and what it
    // said about itself. `host` is what the pages and the owner call it; `source` says what
    // derived it, which is null for one the owner let in by hand.
    joinMachine(machine: { id: string; host: string; nodeId: string; tokenHash: string; platform: string; source: MachineSource | null; ephemeral: boolean; local?: boolean }, ctx: Ctx): MachineRecord {
      return write(() => {
        if (currentMachine(machine.id)) throw new InputError(`机器 ${machine.id} 已经有一台了：换一个名字，或者先删掉原来那台`);
        const at = nowIso();
        const uid = ulid();
        db.run(
          `INSERT INTO machine (id, uid, created_at, updated_at, host, note, node_id, token_hash, platform, joined_at, last_seen_at, source, ephemeral)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)`,
          machine.id, uid, at, at, machine.host, machine.nodeId, machine.tokenHash, machine.platform, at, machine.source === null ? null : JSON.stringify(machine.source), machine.ephemeral ? 1 : 0,
        );
        if (machine.local) writeSetting('host_machine_uid', uid);
        writeChange(db, machine.local ? 'machine.join_local' : 'machine.join', ctx, {}, {
          machine_id: machine.id, machine_uid: uid, host: machine.host, platform: machine.platform, source: machine.source, ephemeral: machine.ephemeral,
        });
        return currentMachine(machine.id)!;
      });
    },

    // What the Router may do in this project without asking: the owner's alone, from the console.
    setProjectGrants(projectId: string, grants: readonly string[], ctx: Ctx): void {
      write(() => {
        const unknown = grants.filter((id) => !isGrantId(id));
        if (unknown.length > 0) throw new InputError('不认识的授权：' + unknown.join('、'));
        const project = db.get<{ grants_json: string }>('SELECT grants_json FROM project WHERE id = ?', projectId);
        if (!project) throw new InputError('项目不存在：' + projectId);
        const from = grantsOf(project.grants_json);
        const to = GRANT_IDS.filter((id) => grants.includes(id));
        if (from.length === to.length && from.every((id, index) => id === to[index])) return;
        db.run('UPDATE project SET grants_json = ? WHERE id = ?', JSON.stringify(to), projectId);
        writeChange(db, 'project.update', ctx, {}, { project_id: projectId, grants: { from, to } });
      });
    },

    // --- machines a task spawns (docs/design/nodes.md §1.3) ---------------------------

    // Whether a project's tasks may spawn machines at all. Off until the owner turns it on.
    // Turning it off stops every material of the project from being handed or redeemed; the
    // machines already in are not touched — they are revoked one by one (nodes.md §9).
    setProjectSpawnMachines(projectId: string, allowed: boolean, ctx: Ctx): void {
      write(() => {
        const project = db.get<{ spawn_machines: number }>('SELECT spawn_machines FROM project WHERE id = ?', projectId);
        if (!project) throw new InputError(`项目不存在：${projectId}`);
        if ((project.spawn_machines === 1) === allowed) return;
        db.run('UPDATE project SET spawn_machines = ? WHERE id = ?', allowed ? 1 : 0, projectId);
        writeChange(db, 'project.update', ctx, {}, { project_id: projectId, spawn_machines: { from: project.spawn_machines === 1, to: allowed } });
      });
    },

    // A quota the Router asked for: the task it belongs to, which executors a machine
    // spawned under it may serve (null: any the project's accounts have), until when a round
    // may still be handed materials, how many machines it may register. The project has to
    // allow spawning, and a task has one open quota at a time: one is what a round is handed
    // materials from.
    createInvite(fields: { taskId: string; executors: string[] | null; ttlMs: number; maxMachines: number }, ctx: Ctx): InviteRow {
      return write(() => {
        const task = loadTask(fields.taskId);
        const project = db.get<{ spawn_machines: number; name: string }>('SELECT spawn_machines, name FROM project WHERE id = ?', task.project_id)!;
        if (project.spawn_machines !== 1) throw new InputError(`项目 ${project.name} 没有打开“允许派生机器”：只有主人能在控制台的项目页打开它`);
        if (task.state === 'done' || task.state === 'abandoned') throw new InputError(`任务 ${task.id} 已经结束，不能再为它申请机器`);
        if (!Number.isInteger(fields.maxMachines) || fields.maxMachines < 1) throw new InputError('可登记的机器数至少是 1');
        if (!Number.isFinite(fields.ttlMs) || fields.ttlMs <= 0) throw new InputError('名额的有效期要是正数');
        const open = openInviteOf(fields.taskId);
        if (open) throw new InputError(`任务 ${fields.taskId} 已经有一条打开的接入名额（${open.id}，到 ${open.expires_at} 为止，还能登记 ${open.max_machines - open.used} 台）：用完或撤销它再申请`);
        const executors = fields.executors === null ? null : [...new Set(fields.executors)];
        if (executors !== null && executors.length === 0) throw new InputError('允许的执行器清单不能是空的：不限就不填');
        const id = ulid();
        const at = nowIso();
        const expires = new Date(Date.parse(at) + fields.ttlMs).toISOString();
        db.run(
          'INSERT INTO machine_invite (id, created_at, project_id, task_id, executors_json, expires_at, max_machines) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, at, task.project_id, task.id, executors === null ? null : JSON.stringify(executors), expires, fields.maxMachines,
        );
        writeChange(db, 'machine.invite', ctx, { taskId: task.id }, { invite_id: id, executors, expires_at: expires, max_machines: fields.maxMachines });
        return currentInvite(id)!;
      });
    },

    openInvite: (taskId: string): InviteRow | undefined => openInviteOf(taskId),
    // Whether the Task has ever had a join quota: its rounds may spawn machines, or have to
    // destroy and report the ones an earlier round spawned.
    hadInvite: (taskId: string): boolean => db.get('SELECT 1 FROM machine_invite WHERE task_id = ?', taskId) !== undefined,
    getInvite: (id: string): InviteRow | undefined => currentInvite(id),
    listInvites: (): InviteRow[] => {
      const at = nowIso();
      return db.all<InviteRow>(`${INVITE_SELECT} ORDER BY machine_invite.rowid`, at, at).map(inviteOf);
    },

    // The materials for a round that is starting: one per machine the quota can still
    // register, minted here and now and good for `ttlMs`, each for one machine. The ledger
    // keeps their hashes and the round they went to; the plaintext goes to the caller once
    // and is never written anywhere. A material an earlier round was handed stays good until
    // its own time: an instance that round made may still be booting. The quota's ceiling
    // is kept at redemption, whatever is out.
    // A round is handed materials once. Asked again (its client lost the answer on the way),
    // it gets back those of `held` — the plaintext the caller kept from the first time —
    // that are its own and can still let a machine in, and nothing newly minted; a caller
    // that kept nothing gets nothing.
    handInvite(taskId: string, runId: string, ttlMs: number, held: readonly string[] = []): string[] | undefined {
      return write(() => {
        const invite = openInviteOf(taskId);
        if (!invite) return undefined;
        const project = db.get<{ spawn_machines: number }>('SELECT spawn_machines FROM project WHERE id = ?', invite.project_id)!;
        if (project.spawn_machines !== 1) return undefined;
        const handed = db.all<{ hash: string; invite_id: string; used_at: string | null; expires_at: string }>(
          'SELECT hash, invite_id, used_at, expires_at FROM machine_material WHERE run_id = ?', runId,
        );
        if (handed.length > 0) {
          const good = new Set(handed.filter((row) => row.invite_id === invite.id && row.used_at === null && Date.parse(row.expires_at) > Date.now()).map(({ hash }) => hash));
          const again = held.filter((material) => good.has(hashOf(material)));
          return again.length === 0 ? undefined : again;
        }
        const at = nowIso();
        const expires = new Date(Date.parse(at) + ttlMs).toISOString();
        const materials = Array.from({ length: invite.max_machines - invite.used }, () => randomBytes(32).toString('hex'));
        for (const material of materials) {
          db.run('INSERT INTO machine_material (hash, invite_id, run_id, handed_at, expires_at) VALUES (?, ?, ?, ?, ?)', hashOf(material), invite.id, runId, at, expires);
        }
        writeChange(db, 'machine.invite_handed', SERVICE, { taskId, runId }, { invite_id: invite.id, materials: materials.length, expires_at: expires });
        return materials;
      });
    },

    // A machine comes in with a material (nodes.md §1.3, and the third point of its
    // conclusion): using the material up and writing the machine are one transaction, so two
    // machines racing for one material cannot both have it. The claim secret is the
    // machine's own: the same machine asking again gets the registration it already made,
    // with a fresh token (the one that may have been lost on the way dies).
    redeemInvite(fields: { materialHash: string; claimHash: string; facts: NodeFacts; machineId: string; tokenHash: string }, ctx: Ctx): MachineRecord {
      return write(() => {
        const claimed = db.get<MachineRow>(`${MACHINE_SELECT} WHERE machine.claim_hash = ?`, fields.claimHash);
        if (claimed) {
          if (claimed.node_id !== fields.facts.node_id) throw new InputError('这份认领秘密属于另一台机器');
          if (claimed.left_at !== null) throw new InputError(`机器 ${claimed.id} 的登记已经结束，不能再认领`);
          db.run('UPDATE machine SET token_hash = ?, updated_at = ? WHERE id = ?', fields.tokenHash, nowIso(), claimed.id);
          writeChange(db, 'machine.join_reclaimed', ctx, {}, { machine_id: claimed.id });
          return currentMachine(claimed.id)!;
        }
        const material = db.get<{ invite_id: string; run_id: string; expires_at: string; used_at: string | null }>(
          'SELECT invite_id, run_id, expires_at, used_at FROM machine_material WHERE hash = ?', fields.materialHash,
        );
        if (!material) throw new InputError(INVITE_REFUSALS.unknown);
        if (material.used_at !== null) throw new InputError(INVITE_REFUSALS.used);
        const invite = currentInvite(material.invite_id)!;
        if (invite.revoked_at !== null) throw new InputError(INVITE_REFUSALS.revoked);
        const project = db.get<{ spawn_machines: number; name: string }>('SELECT spawn_machines, name FROM project WHERE id = ?', invite.project_id)!;
        if (project.spawn_machines !== 1) throw new InputError(`项目 ${project.name} 已经关掉了“允许派生机器”`);
        if (Date.parse(material.expires_at) <= Date.now()) throw new InputError(INVITE_REFUSALS.expired);
        if (invite.used >= invite.max_machines) throw new InputError(INVITE_REFUSALS.full);
        const same = db.get<{ id: string }>('SELECT id FROM machine WHERE node_id = ?', fields.facts.node_id);
        if (same) throw new InputError(`这台机器已经加入过了（${same.id}）：在控制台删掉它，或者用它原来的身份重新连回来`);
        if (currentMachine(fields.machineId)) throw new InputError(`机器 ${fields.machineId} 已经有一台了：换一个名字再加入`);
        const at = nowIso();
        const source: MachineSource = { task_id: invite.task_id, run_id: material.run_id, round: roundOf(invite.task_id, material.run_id) };
        const host = fields.facts.hostname || fields.facts.name;
        const uid = ulid();
        db.run(
          `INSERT INTO machine (id, uid, created_at, updated_at, host, note, node_id, token_hash, platform, joined_at, last_seen_at, source, ephemeral, invite_id, claim_hash)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
          fields.machineId, uid, at, at, host, fields.facts.node_id, fields.tokenHash, fields.facts.platform, at, JSON.stringify(source), invite.id, fields.claimHash,
        );
        db.run('UPDATE machine_material SET used_at = ? WHERE hash = ?', at, fields.materialHash);
        // Its own action: nobody let this machine in, a material did.
        writeChange(db, 'machine.join_spawned', ctx, { taskId: invite.task_id, runId: material.run_id }, {
          machine_id: fields.machineId, machine_uid: uid, host, platform: fields.facts.platform, source, ephemeral: true, invite_id: invite.id,
        });
        return currentMachine(fields.machineId)!;
      });
    },

    // The owner takes a quota back: no round is handed its materials any more, and one
    // already out stops redeeming. The machines it registered are not touched — revoking a
    // material is not revoking the machines it made (nodes.md §9).
    revokeInvite(id: string, ctx: Ctx): void {
      write(() => {
        const invite = currentInvite(id);
        if (!invite) throw new InputError(`没有这条接入名额：${id}`);
        if (invite.revoked_at !== null) return;
        db.run('UPDATE machine_invite SET revoked_at = ? WHERE id = ?', nowIso(), id);
        writeChange(db, 'machine.invite_revoked', ctx, { taskId: invite.task_id }, { invite_id: id });
      });
    },

    // The endings of a spawned machine, each written on its own (nodes.md §1.3). Draining:
    // no new work goes to it; what runs there finishes. Evidence: every round of its has
    // settled with its output read. Leaving: its registration is over — the token is void
    // from this write — because it left by itself, the owner revoked it, or its instance was
    // reported destroyed while it ran nothing. Destroyed: the skill that made the instance
    // said so, through the receipt of a round; nothing else writes it.
    drainMachine: (id: string, ctx?: Ctx): void => write(() => endMachine(id, 'drain_at', ctx, 'machine.drain')),
    confirmMachineEvidence: (id: string, ctx?: Ctx): void => write(() => endMachine(id, 'evidence_at', ctx, 'machine.evidence')),
    leaveMachine(id: string, reason: MachineLeftReason, ctx: Ctx): void {
      write(() => {
        const machine = currentMachine(id);
        if (!machine) throw new InputError('机器不存在：' + id);
        endRegistration(machine, reason, ctx);
      });
    },
    noteMachineDestroyed(id: string, byRunId: string, ctx: Ctx): void {
      write(() => noteDestroyed(id, byRunId, ctx));
    },

    // The machines that came in under a quota and still have an ending to come: registered,
    // or registration ended with their evidence not yet confirmed. With the quota's task:
    // what the dispatcher looks at to decide which of them is done here.
    ephemeralMachines(): { machine: MachineRecord; invite: InviteRow | undefined }[] {
      return db.all<MachineRow>(`${MACHINE_SELECT} WHERE machine.ephemeral = 1 AND (machine.left_at IS NULL OR machine.evidence_at IS NULL) ORDER BY machine.rowid`).map((row) => {
        const machine = machineOf(row);
        return { machine, invite: machine.inviteId === undefined ? undefined : currentInvite(machine.inviteId) };
      });
    },

    // What a machine's rounds left: how many are still going, and how many ended without
    // their output having been read (judged gone). Its evidence is in only when both are 0.
    roundsOn: (machineId: string): { active: number; unread: number } => db.get<{ active: number; unread: number }>(
      `SELECT coalesce(sum(state != 'ended'), 0) AS active, coalesce(sum(state = 'ended' AND exit_kind = 'lost'), 0) AS unread FROM run WHERE machine_id = ?`,
      machineId,
    )!,

    // When this machine was last heard from. Learned state, like touchRun: no change row,
    // and only written when the moment is one worth keeping. It goes through the same write
    // wrapper as everything else: a ledger that cannot take this write is a ledger that must
    // stop the host from acting (§6's seventh line).
    noteMachineSeen(id: string, at: string): void {
      write(() => { db.run('UPDATE machine SET last_seen_at = ? WHERE id = ?', at, id); });
    },

    // The owner's own words about a machine. Its name and everything else about it come from
    // its client (nodes.md §5.4): the note is all the owner writes here. Empty clears it.
    setMachineNote(id: string, note: string | null, ctx: Ctx): { changed: boolean } {
      return write(() => {
        const before = currentMachine(id);
        if (!before) throw new InputError('机器不存在：' + id);
        const next = note === null || note.trim() === '' ? null : note.trim();
        const from = before.note ?? null;
        if (from === next) return { changed: false };
        db.run('UPDATE machine SET note = ?, updated_at = ? WHERE id = ?', next, nowIso(), id);
        writeChange(db, 'machine.update', ctx, {}, { machine_id: id, changed: { note: { from, to: next } } });
        return { changed: true };
      });
    },
    // Removing a machine is revoking it: its token dies with this write and its next poll
    // is refused (nodes.md §5.4, §9). For a machine the owner let in the row goes with it.
    // For one a task spawned the row stays, carrying its four endings: that it is gone from
    // the registry says nothing about its instance, and the page must not read it as
    // released (§1.3). Removing a spawned machine whose registration has already ended is
    // the owner closing the record, and then the row goes.
    deleteMachine(id: string, ctx: Ctx, options: { confirmed?: boolean } = {}): void {
      write(() => {
        const machine = currentMachine(id);
        if (!machine) throw new InputError('机器不存在：' + id);
        const active = db.get<{ n: number }>("SELECT count(*) AS n FROM run WHERE machine_id = ? AND state != 'ended'", id)!.n;
        if (active && !options.confirmed) throw new ConfirmationRequired('机器 ' + id + ' 上还有 ' + active + ' 个没结束的执行。删掉后按“机器被移除”判定为不在。确认要删就再点一次', { active_runs: active });
        const pruneMachineBindings = (machineId: string): void => {
          const registry = readSkillRegistry();
          let registryChanged = false;
          const nextRegistry: SkillRegistryMap = {};
          for (const [slug, binding] of Object.entries(registry)) {
            if (binding.machine_ids !== null && binding.machine_ids.includes(machineId)) {
              registryChanged = true;
              const remaining = binding.machine_ids.filter((each) => each !== machineId);
              nextRegistry[slug] = remaining.length > 0
                ? { ...binding, machine_ids: remaining }
                : { ...binding, enabled: false, machine_ids: null };
            } else {
              nextRegistry[slug] = binding;
            }
          }
          if (registryChanged) writeSetting(SKILL_REGISTRY_SETTING_KEY, nextRegistry);
          const em = readEntryMachines();
          let emChanged = false;
          const nextEm: EntryMachinesMap = {};
          for (const [eid, mids] of Object.entries(em)) {
            if (mids !== null && mids.includes(machineId)) {
              emChanged = true;
              nextEm[eid] = mids.filter((each) => each !== machineId);
            } else {
              nextEm[eid] = mids;
            }
          }
          if (emChanged) writeSetting(ENTRY_MACHINES_SETTING_KEY, nextEm);
        };
        if (machine.ephemeral && machine.leftAt === undefined) {
          pruneMachineBindings(id);
          endRegistration(machine, 'revoked', ctx, { active_runs: active });
          return;
        }
        const { uid } = db.get<{ uid: string }>('SELECT uid FROM machine WHERE id = ?', id)!;
        forgetMachineInProjects(machine, uid, ctx);
        db.run('DELETE FROM machine WHERE id = ?', id);
        // Its own logins were the machine's: a machine of this name joining later is another
        // one, with logins of its own (nodes.md §7).
        for (const login of db.all<{ id: string; machine_id: string; executor: string }>('SELECT id, machine_id, executor FROM machine_login WHERE machine_id = ?', id)) {
          db.run('DELETE FROM login_state WHERE id = ?', login.id);
          writeChange(db, 'machine_login.delete', ctx, {}, { login_id: login.id, login_name: machineLoginName(login.machine_id, login.executor), machine_id: id });
        }
        db.run('DELETE FROM machine_login WHERE machine_id = ?', id);
        // A refusal was about this registration; the machine joined again is another one.
        db.run('DELETE FROM machine_login_refusal WHERE machine_uid = ?', uid);
        pruneMachineBindings(id);
        writeChange(db, 'machine.delete', ctx, {}, { machine_id: id, machine: machineConfig(machine), active_runs: active });
      });
    },
    // The machines by their registrations (machine.uid), so that one deleted and joined again
    // under its name is not in the list. A list saved replaces the whole of the old one, entries
    // of machines since deleted included: those are dropped, and the change says how many.
    setProjectMachines(projectId: string, machines: string[], ctx: Ctx): void {
      write(() => {
        const project = db.get<{ machines_json: string }>('SELECT machines_json FROM project WHERE id = ?', projectId);
        if (!project) throw new InputError('项目不存在：' + projectId);
        const uids = heldUids([...new Set(machines)]);
        if (sameConfig(JSON.parse(project.machines_json), uids)) return;
        const from = projectMachinesOf(project.machines_json);
        db.run('UPDATE project SET machines_json = ? WHERE id = ?', JSON.stringify(uids), projectId);
        writeChange(db, 'project.update', ctx, {}, { project_id: projectId, machines: { from: namesOf(from), to: namesOf(projectMachinesOf(JSON.stringify(uids))) }, ...(from.gone > 0 ? { machines_gone_dropped: from.gone } : {}) });
      });
    },

    // A project's allowed machines as the pages and the Router read them: each machine it still
    // names, by registration and name, and how many entries are of machines since deleted —
    // which match nothing, and keep the list from meaning "any machine".
    projectMachines: (projectId: string): ProjectMachines => {
      const row = db.get<{ machines_json: string }>('SELECT machines_json FROM project WHERE id = ?', projectId);
      if (!row) throw new InputError('项目不存在：' + projectId);
      return projectMachinesOf(row.machines_json);
    },

    // Where a project's code comes from, in order, the first being the default. No source means
    // its Tasks' rounds work in an empty Task directory (docs/design/code-sources.md §1).
    projectSources: (projectId: string): Source[] => projectSourcesOf(projectId),

    // The same list as the project page and the Router's get_project read it: each item marked
    // default or not, labelled, and the items still waiting for the owner to pick a machine.
    projectSourceViews: (projectId: string): { sources: SourceView[]; pending: string[] } => projectSourceViewsOf(projectId),

    // What a Task is pinned to, as it stood when it was made; null when its project names none.
    taskSource: (taskId: string): TaskSource | null => taskSourceOf(taskId),

    // How that pin stands against the project's list now (shared/sources.ts): current, changed
    // or removed. Null when the Task has no pin.
    taskSourceState: (taskId: string): TaskSourceState | null => taskSourceStateOf(taskId),

    // The Task page's and the Router's read of the pin, projected in one place so the two cannot
    // say different things: the pin's id and label, and how it stands against the list now.
    taskSourceView: (task: { id: string; source_json?: string | null }) => taskSourceViewOf(task),

    // Why the Task may not run on its pin now, in the owner's words; undefined when it may.
    // The dispatcher and the Router's placement check read this one judgment.
    sourceRefusal: (task: Pick<TaskRow, 'id' | 'project_id' | 'source_json'>): string | undefined => sourceRefusalOf(task),

    // How the owner reads one source, with the machine it names (or that the machine is gone).
    sourceLabel: (source: Source): string => sourceLabelFor(source),

    // The ledger is where a token takes effect: the file is already written when this
    // runs, and the commit that sets the number is what makes that file the account's. A
    // transaction that never commits leaves a file nobody names. The rejection mark is not
    // touched: it names the old number, which is no longer the account's, so it says
    // nothing. The file store owns token material; `ref` is a number, never a value.
    recordAccountCredential(id: string, ref: string, ctx: Ctx): void {
      write(() => {
        if (!db.get('SELECT 1 FROM account WHERE id = ?', id)) throw new InputError('账号不存在：' + id);
        // The moment the token came in, in the same write that names it: the two are one fact
        // (docs/design/native-login.md §2).
        if (credentialRefOf(id) !== ref) clearAccountIdentity(id);
        db.run('UPDATE account SET credential_ref = ?, credential_at = ? WHERE id = ?', ref, nowIso(), id);
        writeChange(db, 'account.credential_set', ctx, {}, { account_id: id });
      });
    },

    // When the token this account holds now was stored, or null when nothing recorded one:
    // the account's own fact, read where an expected expiry is wanted.
    accountCredentialAt: (id: string): string | null =>
      db.get<{ credential_at: string | null }>('SELECT credential_at FROM account WHERE id = ?', id)?.credential_at ?? null,

    // The moment and the expected expiry together, from the one derivation the scan and the
    // self-check use (docs/design/native-login.md §2): the console's account answers read
    // this rather than adding the executor's days themselves.
    accountExpiry(id: string): { credentialAt: string | null; expected: string | null } {
      const row = db.get<{ credential_at: string | null; executor: string }>('SELECT credential_at, executor FROM account WHERE id = ?', id);
      if (!row) return { credentialAt: null, expected: null };
      return { credentialAt: row.credential_at, expected: row.credential_at === null ? null : expiryOf(row.credential_at, row.executor) };
    },

    // The number of the token file this account uses; null for a machine's own login, which
    // has none. Never the token itself.
    accountCredentialRef: (id: string): string | null => credentialRefOf(id),
    quotaGeneration,

    // The token a use was started with was refused. The statement is about that number —
    // a Router process's token, a quota read's token — so the console shows the account as
    // one to be filled in again and the dispatcher stops offering it to Workers too. A
    // number the owner has replaced since is not that statement: the old token was refused,
    // and the new one is not blocked by what happened to the old. The one rejection
    // mechanism: `rejectCredentialRef` re-reads the number the login holds now, so a result
    // that arrives after a replacement cannot reject the replacement.
    rejectCredential(id: string, ref: string): void {
      write(() => rejectCredentialRef(id, ref));
    },

    // A Router turn ran into the account's used-up quota (project-sessions §3): the account rests
    // as after a Worker's round would, for the owner's rest unless it rests longer already. The
    // state is the account's, one for every project and the Workers alike.
    // `id` is the login the Router ran as: an account, or this computer's own login under its
    // machine's name (hostLogin), which is the same login a Worker on that machine would rest. A
    // turn after the last rest ended is a try, as a Worker's round after it is.
    restRouterLogin(id: string, quota: { message: string; resetsAt?: string }, credentialRef?: string | null, generation?: string | null): void {
      write(() => {
        if (credentialRef !== undefined && credentialRef !== credentialRefOf(id)) return;
        if (generation !== undefined && generation !== quotaGeneration(id)) return;
        const until = restLoginFor(id, quota, (state, now) => state.rest_until === null || Date.parse(state.rest_until) <= now);
        writeChange(db, 'router.quota', SERVICE, {}, { login_id: id, rest_until: until });
      });
    },

    // The machine this host is, when it has joined itself as one (nodes.md §1.1 step 2, the
    // local join). Null means a legacy local join could not be recovered; undefined
    // means no binding (or a later removed registration). Only null needs migration repair.
    hostMachine(): string | null | undefined {
      const uid = readSetting<string | null | undefined>('host_machine_uid', undefined);
      if (uid == null) return uid;
      return db.get<{ id: string }>('SELECT id FROM machine WHERE uid = ? AND left_at IS NULL', uid)?.id;
    },

    // What using the logins has taught the service, by login. A login nothing is known about
    // has no entry.
    loginStates: (): Map<string, LoginState> =>
      new Map(db.all<LoginStateRow & { executor: string | null }>(LOGIN_STATE_SELECT).map((row) => [row.id, stateOf(row, row.executor ?? undefined)])),

    loginState(id: string | null): LoginState {
      if (id === null) return { ...NO_STATE, usage: [], models: [], identity: {} };
      const row = db.get<LoginStateRow & { executor: string | null }>(`${LOGIN_STATE_SELECT} WHERE s.id = ?`, id);
      return row ? stateOf(row, row.executor ?? undefined) : NO_STATE;
    },

    // What an executor said, while running, about how much of the login's quota is
    // used. Display and ordering data like touchRun: no change row. Each figure carries
    // when it was last said, even when it says what the held one did: the page shows that
    // moment, and a figure read again is not an old one. The CLI says it about once per
    // process, so this is a write per start, not per line.
    // What a Router turn or a quota read used, as its executor reported it (docs/design/usage.md).
    // Learned like the quota figures: no change row.
    recordUsage(owner: Exclude<UsageOwner, { run_id: string }>, usage: readonly Usage[]): void {
      write(() => {
        if (usage.length > 0) insertUsage(db, owner, nowIso(), usage);
      });
    },

    usageReport(query: UsageQuery): UsageReport {
      return usageReport(db, query);
    },

    recentLoginTelemetry(nowMs?: number): Record<string, LoginTelemetry> {
      return recentLoginTelemetry(db, nowMs);
    },

    competenceReport(query: CompetenceQuery): CompetenceReport {
      return competenceReport(db, query);
    },

    noteUsage(loginId: string | null, windows: readonly { window: string; used: number; resetsAt: string | null }[], credentialRef?: string | null, generation?: string | null): void {
      write(() => {
        if (generation !== undefined && generation !== quotaGeneration(loginId)) return;
        if (windows.length === 0 || !loginExists(loginId)) return;
        if (credentialRef !== undefined && credentialRef !== credentialRefOf(loginId)) return;
        const at = nowIso();
        const row = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId);
        const held = JSON.parse(row?.usage_json ?? '{}') as Record<string, Omit<UsageWindow, 'window'>>;
        // Claude reports these on every answer: only figures that moved are news to a page.
        if (windows.some(({ window, used, resetsAt }) => held[window]?.used !== used || held[window]?.resets_at !== resetsAt)) db.noteNews();
        for (const { window, used, resetsAt } of windows) held[window] = { used, resets_at: resetsAt, at };
        db.run(
          `INSERT INTO login_state (id, created_at, usage_json) VALUES (?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET usage_json = excluded.usage_json`,
          loginId, at, JSON.stringify(held),
        );
      });
    },

    // What a machine read of one of its own logins' quota, as that machine reported it
    // (docs/design/usage.md §3). Unlike `noteUsage`, this is the whole set the executor named at
    // one reading, and the moment is the machine's own: a report that arrives late is still the
    // machine's order of reads, so a reading as old as the held one (the same report twice) or
    // older writes nothing and never turns a stale figure into a fresh one. A failed reading
    // carries no windows and writes nothing: why it failed is said by the report, not the ledger.
    noteQuota(loginId: string, windows: readonly { window: string; used: number; resetsAt: string | null }[], readAt: string, resultChanged = false): void {
      write(() => {
        if (!loginExists(loginId) || !Number.isFinite(Date.parse(readAt))) return;
        if (resultChanged) db.noteNews();
        if (windows.length === 0) return;
        const at = new Date(readAt).toISOString();
        const row = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId);
        const held = JSON.parse(row?.usage_json ?? '{}') as Record<string, Omit<UsageWindow, 'window'>>;
        if (Object.values(held).some((figure) => Date.parse(figure.at) >= Date.parse(at))) return;
        const next: Record<string, Omit<UsageWindow, 'window'>> = {};
        for (const { window, used, resetsAt } of windows) next[window] = { used, resets_at: resetsAt, at };
        if (JSON.stringify(next) !== JSON.stringify(held)) db.noteNews();
        db.run(
          `INSERT INTO login_state (id, created_at, usage_json) VALUES (?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET usage_json = excluded.usage_json`,
          loginId, at, JSON.stringify(next),
        );
      });
    },

    // What the login's executor reported about the models it may use, and when that was
    // read. Learned state like the usage figures: no change row, and the caller writes it
    // in the transaction that queues whatever it has to tell the owner about the change.
    noteModels(loginId: string, models: readonly ModelInfo[], at: string): void {
      write(() => {
        if (!loginExists(loginId)) return;
        const held = JSON.stringify(models);
        const row = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId);
        if (row && row.models_json === held && row.models_at === at) return;
        if (row?.models_json !== held) db.noteNews();
        db.run(
          `INSERT INTO login_state (id, created_at, models_json, models_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET models_json = excluded.models_json, models_at = excluded.models_at`,
          loginId, at, held, at,
        );
      });
    },

    // An account API answer that names no identity leaves the last known one standing.
    noteIdentity(loginId: string, identity: ExecutorIdentity): void {
      const keys = ['organizationId', 'quotaOwner', 'accountLabel', 'planLabel', 'routeLabel'] as const;
      if (keys.every((key) => identity[key] === undefined)) return;
      write(() => {
        if (!loginExists(loginId)) return;
        const row = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId);
        const old = JSON.parse(row?.identity_json ?? '{}') as Record<string, unknown>;
        const next: Record<string, unknown> = {};
        for (const key of keys) {
          if (typeof old[key] === 'string' && old[key] !== '') next[key] = old[key];
        }
        if (typeof old.quotaGeneration === 'string' && old.quotaGeneration !== '') next.quotaGeneration = old.quotaGeneration;
        for (const key of keys) {
          const value = identity[key];
          if (value === undefined) continue;
          if (value === null) delete next[key];
          else next[key] = value;
        }
        const held = JSON.stringify(next);
        if (held === row?.identity_json) return;
        db.noteNews();
        db.run(`INSERT INTO login_state (id, created_at, identity_json) VALUES (?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET identity_json = excluded.identity_json`, loginId, nowIso(), held);
      });
    },

    // An empty identity from a machine's login probe explicitly ends a known match.
    noteMachineIdentity(loginId: string, identity: ExecutorIdentity): void {
      write(() => {
        if (!loginExists(loginId)) return;
        const row = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId);
        const old = JSON.parse(row?.identity_json ?? '{}') as ExecutorIdentity & { quotaGeneration?: string };
        const next = { ...old };
        for (const key of ['organizationId', 'quotaOwner', 'accountLabel', 'planLabel', 'routeLabel', 'routes'] as const) {
          const value = identity[key];
          if (value === undefined) continue;
          if (value === null) delete next[key];
          else Object.assign(next, { [key]: value });
        }
        const hasStrongOwner = old.quotaOwner !== undefined || next.quotaOwner !== undefined
          || old.organizationId !== undefined || next.organizationId !== undefined;
        const changedOwner = (old.quotaOwner ?? null) !== (next.quotaOwner ?? null)
          || (old.organizationId ?? null) !== (next.organizationId ?? null)
          || (!hasStrongOwner && (old.accountLabel ?? null) !== (next.accountLabel ?? null))
          || (identity.quotaOwner === null && identity.organizationId === null && old.quotaGeneration === undefined);
        if (identity.accountLabel === undefined && old.organizationId !== next.organizationId) delete next.accountLabel;
        if (changedOwner) next.quotaGeneration = randomUUID();
        if (JSON.stringify(old) === JSON.stringify(next)) return;
        db.noteNews();
        db.run(`INSERT INTO login_state (id, created_at, identity_json) VALUES (?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET identity_json = excluded.identity_json`, loginId, nowIso(), JSON.stringify(next));
        if (changedOwner) clearQuota(loginId);
      });
    },

    // The owner's "try now": the rest ends here and the login is a candidate again. The
    // count of rests in a row stays, so a try that fails at once waits longer than the last.
    // A refused login is not ended here: an account's comes back with another token, a
    // machine's own when that machine reports it signed in again (signedInAgain).
    endRest(loginId: string, ctx: Ctx): void {
      write(() => {
        db.noteNews();
        if (!loginExists(loginId)) throw new InputError(`${loginName(loginId)} 不存在`);
        const row = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId);
        if (!row?.rest_until) return;
        db.run('UPDATE login_state SET rest_until = NULL WHERE id = ?', loginId);
        writeChange(db, 'login.rest_end', ctx, {}, { login_id: loginId, rest_until: row.rest_until });
      });
    },

    // A machine said, from a probe made at `probedAt`, that the executor of this machine's
    // own login is signed in: a refusal from before that probe no longer stands. Nothing is
    // written when there is nothing to clear, so the reports every poll carries cost nothing.
    signedInAgain(loginId: string, probedAt: string): void {
      if (currentLogin(loginId)?.machine === undefined) return;
      const row = db.get<LoginStateRow>('SELECT * FROM login_state WHERE id = ?', loginId);
      if (!row?.auth_failed_at || !(Date.parse(row.auth_failed_at) < Date.parse(probedAt))) return;
      write(() => {
        db.noteNews();
        db.run('UPDATE login_state SET auth_failed_at = NULL WHERE id = ? AND auth_failed_at = ?', loginId, row.auth_failed_at);
        writeChange(db, 'login.signed_in_again', { actor: 'machine' }, {}, { login_id: loginId, auth_failed_at: row.auth_failed_at, probed_at: probedAt });
      });
    },

    // Whether the owner removed a login of this id: the account, the machine's own login, or
    // the machine it was on; or the step to version 18 made it a machine's own login. A Run
    // whose login is absent without that never had its login in this ledger: a backup from
    // before accounts were kept here, which says nothing about where the Run's machine went.
    // Whether the step to version 18 folded this account into machines' own logins.
    accountFolded(id: string): boolean {
      return db.get(`SELECT 1 FROM change WHERE action = 'login.migrate' AND json_extract(detail_json, '$.account_id') = ? LIMIT 1`, id) !== undefined;
    },

    // What a login was called when it was removed, for the sentences that have to name a
    // reference the ledger no longer holds (docs/design/native-login.md §2, accounts-machines-
    // decoupled.md "内部编号"): the words are the owner's, and an internal id is not one. The
    // same reading as loginName's fallback, so a page, a reason and a check agree.
    deletedAccountName: (id: string): string | null => deletedLoginName(id),

    loginWasDeleted(id: string | null): boolean {
      if (id === null) return true;
      if (db.get(`SELECT 1 FROM change WHERE action = 'machine_login.delete' AND json_extract(detail_json, '$.login_id') = ? LIMIT 1`, id)) return true;
      return db.get(`SELECT 1 FROM change WHERE (action = 'account.delete' AND json_extract(detail_json, '$.account_id') = ?)
        OR (action = 'target.delete' AND json_extract(detail_json, '$.target_id') = ?)
        OR (action = 'login.migrate' AND json_extract(detail_json, '$.account_id') = ?) LIMIT 1`, id, id, id) !== undefined;
    },

    // Replaces the logins a project may run as, and how it uses them (docs/design/project-sessions.md
    // §1): "only these" (`selected`, the default, so choosing a list is choosing them, an empty
    // list included) or every login there is (`all`), when the list stays as written and takes no
    // part in dispatch, so switching back finds it. The list carries no order: which login comes
    // first is the tier's own (roles-and-tiers.md §11). `logins` undefined keeps the list. Checked
    // here, in the transaction that writes it: a login removed a moment ago is not one a project
    // can be pointed at.
    setProjectLogins(projectId: string, logins: string[] | undefined, ctx: Ctx, mode: LoginMode = 'selected'): void {
      write(() => {
        const project = db.get<{ logins_json: string; login_mode: LoginMode }>('SELECT logins_json, login_mode FROM project WHERE id = ?', projectId);
        if (!project) throw new InputError(`项目不存在：${projectId}`);
        if (mode !== 'all' && mode !== 'selected') throw new InputError('登录方式只有“全部登录”（all）和“只用所选”（selected）');
        const from = JSON.parse(project.logins_json) as string[];
        const allowed = logins === undefined ? from : [...new Set(logins)];
        if (logins !== undefined) for (const id of allowed) if (!loginExists(id)) throw new InputError(`${loginName(id)} 不存在`);
        const listMoved = JSON.stringify(from) !== JSON.stringify(allowed);
        if (!listMoved && project.login_mode === mode) return;
        db.run('UPDATE project SET logins_json = ?, login_mode = ? WHERE id = ?', JSON.stringify(allowed), mode, projectId);
        writeChange(db, 'project.update', ctx, {}, {
          project_id: projectId,
          ...(listMoved ? { logins: { from, to: allowed } } : {}),
          ...(project.login_mode === mode ? {} : { login_mode: { from: project.login_mode, to: mode } }),
        });
      });
    },

    setProjectDispatchSlots(projectId: string, slots: DispatchSlotsConfig | null, ctx: Ctx): void {
      write(() => {
        const row = db.get<{ dispatch_order_json: string | null }>('SELECT dispatch_order_json FROM project WHERE id = ?', projectId);
        if (!row) throw new InputError(`项目不存在：${projectId}`);
        let next: DispatchSlotsConfig | null = null;
        if (slots !== null) {
          if (typeof slots !== 'object' || Array.isArray(slots)) {
            throw new InputError('项目派发槽位必须是对象或 null');
          }
          for (const key of Object.keys(slots)) {
            if (!isTierId(key)) {
              throw new InputError(`未知档位：${key}（只接受 operate、execute、decide）`);
            }
          }
          next = normalizeDispatchSlotsConfig(slots);
        }
        const nextJson = next === null ? null : JSON.stringify(next);
        const prev = parseProjectDispatchConfig(row.dispatch_order_json).slots;
        const prevJson = prev === null ? null : JSON.stringify(prev);
        if (prevJson === nextJson && row.dispatch_order_json === nextJson) return;
        db.run('UPDATE project SET dispatch_order_json = ? WHERE id = ?', nextJson, projectId);
        writeChange(db, 'project.update', ctx, {}, {
          project_id: projectId,
          dispatch_slots: { from: prev, to: next },
        });
      });
    },

    setProjectDispatchOrder(projectId: string, order: Partial<Record<TierId, string[]>> | null, ctx: Ctx): void {
      write(() => {
        const row = db.get<{ dispatch_order_json: string | null }>('SELECT dispatch_order_json FROM project WHERE id = ?', projectId);
        if (!row) throw new InputError(`项目不存在：${projectId}`);
        let next: Partial<Record<TierId, string[]>> | null = null;
        if (order !== null) {
          if (typeof order !== 'object' || Array.isArray(order)) {
            throw new InputError('项目派发顺序必须是对象或 null');
          }
          const normalized: Partial<Record<TierId, string[]>> = {};
          for (const [key, value] of Object.entries(order)) {
            if (!isTierId(key)) {
              throw new InputError(`未知档位：${key}（只接受 operate、execute、decide）`);
            }
            if (value === undefined) continue;
            if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
              throw new InputError(`档位 ${key} 的派发顺序必须是登录 ID 字符串数组`);
            }
            const unique = [...new Set(value.map((id) => id.trim()).filter((id) => id.length > 0))];
            if (unique.length > 0) normalized[key] = unique;
          }
          next = Object.keys(normalized).length > 0 ? normalized : null;
        }
        const nextJson = next === null ? null : JSON.stringify(next);
        const prev = parseProjectDispatchOrder(row.dispatch_order_json);
        const prevJson = prev === null ? null : JSON.stringify(prev);
        if (prevJson === nextJson && row.dispatch_order_json === nextJson) return;
        db.run('UPDATE project SET dispatch_order_json = ? WHERE id = ?', nextJson, projectId);
        writeChange(db, 'project.update', ctx, {}, {
          project_id: projectId,
          dispatch_order: { from: prev, to: next },
        });
      });
    },

    // What the owner did that is not a row of its own. The act is recorded; a Secret is not.
    noteAction(
      action: 'router.restart' | 'wecom.secret_set' | 'task.integrate' | 'release.launch',
      ctx: Ctx,
      refs: { taskId?: string; runId?: string } = {},
      detail?: unknown,
    ): void {
      write(() => {
        if (action === 'task.integrate') {
          if (refs.taskId === undefined) throw new InputError('并入要写明是哪个任务');
          noteIntegrated({ taskId: refs.taskId, ...(refs.runId === undefined ? {} : { runId: refs.runId }) }, (detail ?? {}) as { branch: string | null; commit: string | null } & Record<string, unknown>, ctx);
          return;
        }
        writeChange(db, action, ctx, refs, detail);
      });
    },

    // What a project is called. A name is only shown: nothing refers to a project by it, so
    // changing it is one row and one audit line (project-sessions, "项目的生命周期"). The same
    // rules as creating one, and setting it to what it already is changes nothing.
    setProjectRouter(projectId: string, account: string | null, tier: string | null, ctx: Ctx): void {
      write(() => {
        const project = db.get<ProjectRow>('SELECT * FROM project WHERE id = ?', projectId);
        if (!project) throw new InputError('没有这个项目');
        if (account === null && tier !== null) throw new InputError('沿用服务默认负责人时也沿用它的档位');
        if (tier !== null && !['operate', 'execute', 'decide'].includes(tier)) throw new InputError('负责人档位无效');
        if (project.router_account === account && project.router_tier === tier) return;
        db.run('UPDATE project SET router_account = ?, router_tier = ? WHERE id = ?', account, tier, projectId);
        writeChange(db, 'project.update', ctx, {}, { project_id: projectId, router: { account, tier } });
      });
    },

    setProjectName(projectId: string, name: string, ctx: Ctx): ProjectRow {
      return write(() => {
        const project = db.get<ProjectRow>('SELECT * FROM project WHERE id = ?', projectId);
        if (!project) throw new InputError(`项目不存在：${projectId}`);
        const to = projectNameOf(name);
        if (project.name === to) return project;
        db.run('UPDATE project SET name = ? WHERE id = ?', to, projectId);
        writeChange(db, 'project.rename', ctx, {}, { project_id: projectId, from: project.name, to });
        return { ...project, name: to };
      });
    },

    // Whether a project may be deleted, why not, and what would go with it. The console asks
    // the same question before it offers the delete (project-sessions, "项目的生命周期").
    projectDeletable: (projectId: string): ProjectDeletion => deletionOf(deletionPlan(projectId)),

    // A project that never left a record behind goes at any time; one with history has to be
    // archived and have no round still running. The caller states the name, so a click cannot
    // take a project the owner did not mean. Everything that belongs only to it goes in the
    // one transaction (deleteProjectRows); what is left on disk is recorded there and cleared
    // afterwards by service/accept.ts and service/retention.ts.
    deleteProject(projectId: string, confirmName: string | undefined, ctx: Ctx): void {
      deleteProjectRows(projectId, confirmName, ctx);
    },

    // Where a project's code comes from, replacing the whole ordered list (docs/design/
    // code-sources.md §1, §8): the console edits one list, and the first item is the default.
    // A new item is named here; an old id that is not in the list now is refused, so a removed
    // source never comes back. A Task pinned to something the list no longer holds stops at its
    // next round; a Task of an item the owner edited goes on with its pinned snapshot. Nothing
    // running is touched, and no pin is rewritten here — with one exception, the other half of
    // §8.8: the migration could not name the machine of a folder source and wrote it as pending,
    // and a Task pinned to that item cannot run until it is named. Picking the machine in the
    // project page is exactly that confirmation, so the same transaction fills the machine into
    // the unfinished Tasks still pinned to the item: the owner is not asked to do the same thing
    // twice, and a Run already made keeps the snapshot it was made with.
    setProjectSources(projectId: string, sources: unknown, ctx: Ctx): void {
      write(() => {
        const project = db.get<{ sources_json: string }>('SELECT sources_json FROM project WHERE id = ?', projectId);
        if (!project) throw new InputError(`项目不存在：${projectId}`);
        const from = JSON.parse(project.sources_json) as Source[];
        const to = parseSourceInput(sources, from);
        if (JSON.stringify(from) === JSON.stringify(to)) return;
        db.run('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify(to), projectId);
        const confirmed = new Map<string, string>();
        for (const source of to) {
          if (source.kind !== 'folder' || source.machine_uid === PENDING_MACHINE_UID) continue;
          const before = from.find((each) => each.id === source.id);
          if (before !== undefined && before.kind === 'folder' && before.machine_uid === PENDING_MACHINE_UID) {
            confirmed.set(source.id, source.machine_uid);
          }
        }
        for (const [sourceId, machineUid] of confirmed) {
          for (const task of db.all<Pick<TaskRow, 'id' | 'source_json'>>(
            `SELECT id, source_json FROM task
              WHERE project_id = ? AND state NOT IN ('done', 'abandoned') AND source_json IS NOT NULL`,
            projectId,
          )) {
            const pinned = JSON.parse(task.source_json!) as TaskSource;
            if (pinned.source_id !== sourceId || pinned.pinned.kind !== 'folder' || pinned.pinned.machine_uid !== PENDING_MACHINE_UID) continue;
            const filled: TaskSource = { source_id: pinned.source_id, pinned: { ...pinned.pinned, machine_uid: machineUid } };
            db.run('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify(filled), task.id);
            writeChange(db, 'task.source_machine', ctx, { taskId: task.id }, { source_id: sourceId, path: pinned.pinned.path, machine_uid: machineUid });
          }
        }
        writeChange(db, 'project.update', ctx, {}, { project_id: projectId, sources: { from, to } });
      });
    },

    // service/settings.ts decides what these mean; a key it does not know stays here.
    getTunables: (): Record<string, unknown> => readSetting<Record<string, unknown>>('tunables', {}),

    writeTunable(key: string, { from, to, override }: { from: unknown; to: unknown; override: boolean }, ctx: Ctx): Record<string, unknown> {
      return write(() => {
        const { [key]: _replaced, ...others } = readSetting<Record<string, unknown>>('tunables', {});
        const tunables = override ? { ...others, [key]: to } : others;
        writeSetting('tunables', tunables);
        writeChange(db, 'setting.update', ctx, {}, { key, from, to });
        return tunables;
      });
    },

    // SQLite takes the bare columns from the row max() picked.
    lastTunableChanges: (): { key: string; at: string; actor: string }[] =>
      db.all<{ key: string; at: string; actor: string }>(
        `SELECT json_extract(detail_json, '$.key') AS key, at, actor, max(seq) FROM change
         WHERE action = 'setting.update' GROUP BY key`,
      ),

    getWhitelist: (): Whitelist => readSetting<Whitelist>('whitelist', {}),

    setWhitelist(value: Whitelist, ctx: Ctx): void {
      write(() => {
        const wellFormed =
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.values(value).every(
            (actors) => Array.isArray(actors) && actors.every((actor) => typeof actor === 'string'),
          );
        if (!wellFormed) throw new InputError('白名单格式应为 { 通道: [身份, ...] }');
        writeSetting('whitelist', value);
        writeChange(db, 'whitelist.set', ctx, {}, { whitelist: value });
      });
    },

    recordDeviceLoginDecision(approve: boolean, detail: { entry: 'inside' | 'outside'; device: string }, ctx: Ctx): void {
      write(() => writeChange(db, approve ? 'console.device.approve' : 'console.device.reject', ctx, {}, detail));
    },

    listConsoleSessions: (): ConsoleSession[] => readSetting<ConsoleSession[]>('console_sessions', []),

    addConsoleSession(session: ConsoleSession, ctx: Ctx, expiredBefore: string): void {
      write(() => {
        const live = readSetting<ConsoleSession[]>('console_sessions', []).filter(
          each => (each.last_used_at ?? each.created_at) > expiredBefore && (each.expires_at === undefined || each.expires_at > session.created_at),
        );
        writeSetting('console_sessions', [...live, session]);
        writeChange(db, 'console.login', ctx, {}, { session_id: session.id });
      });
    },

    // Display data like touchRun: no change row, and a failure is the caller's to ignore.
    touchConsoleSession(id: string, at: string, usageOnly = false): void {
      write(() => {
        const sessions = readSetting<ConsoleSession[]>('console_sessions', []);
        writeSetting(
          'console_sessions',
          sessions.map((session) => (session.id === id ? { ...session, last_used_at: at, ...(usageOnly ? {} : { last_seen_at: at }) } : session)),
        );
      });
    },

    extendConsoleSession(id: string, expiresAt: string): void {
      write(() => {
        const sessions = readSetting<ConsoleSession[]>('console_sessions', []);
        if (!sessions.some((session) => session.id === id)) return;
        writeSetting(
          'console_sessions',
          sessions.map((session) => (session.id === id ? { ...session, expires_at: expiresAt } : session)),
        );
      });
    },

    removeConsoleSessions(ids: readonly string[], ctx: Ctx): void {
      write(() => {
        const sessions = readSetting<ConsoleSession[]>('console_sessions', []);
        const removed = new Set(ids);
        writeSetting('console_sessions', sessions.filter((session) => !removed.has(session.id)));
        for (const session of sessions) {
          if (!removed.has(session.id)) continue;
          writeChange(db, 'console.logout', ctx, {}, {
            session_id: session.id, device: session.device ?? '未知设备', entry: session.outside ? 'outside' : 'inside',
          });
        }
      });
    },

    // paused is null when a failed rollback retired the connection: it cannot be
    // read until recover(), and "not paused" would be a guess.
    dispatchConditions,
    changeImpact,
    // What a proposal costs (§5.2): for one in force, what its publication really did, read back
    // from the revisions in force just before and just after it; for one still waiting, a
    // forecast on today's entries, which says it is one.
    proposalImpact(proposalId: string) {
      const proposal = knowledge.getProposal(proposalId);
      const change = proposal.final ?? proposal.change;
      if (proposal.state === 'published' && proposal.published_at !== null) {
        const at = proposal.published_at;
        return { kind: 'actual' as const, ...changeImpact(change, { before: knowledge.entriesAt(at, false), after: knowledge.entriesAt(at, true) }) };
      }
      return { kind: 'forecast' as const, ...changeImpact(change) };
    },
  };
  // What a change costs, shown before it is decided (docs/design/knowledge-and-skills.md §5.2):
  // the lines of what it revises, replaces or retires that no output carries any more, and for
  // every project and role whose generated input it moves, that input before and after —
  // measured as a round's would be (§4.1). Length alone is not the point; what goes is.
  function changeImpact(change: Change, sets?: { before: Entry[]; after: Entry[] }) {
    const kept = new Set(change.outputs.flatMap(({ body }) => body.split('\n').map((line) => line.trim()).filter(Boolean)));
    const dropped = change.inputs.filter(({ disposition }) => disposition !== 'keep').flatMap((input) => {
      const pinned = knowledge.readRevision(input.knowledge_id, input.revision);
      if (!pinned) return [];
      const lines = pinned.body.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !kept.has(line));
      return lines.length === 0 ? [] : [{ knowledge_id: input.knowledge_id, title: pinned.title, disposition: input.disposition, lines }];
    });
    const before = sets?.before ?? knowledge.listEntries();
    const after = sets?.after ?? knowledge.entriesAfter(change);
    const roles = db.all<{ id: string; name: string }>('SELECT id, name FROM role ORDER BY rowid');
    const combos = db.all<{ id: string; name: string }>('SELECT id, name FROM project ORDER BY rowid').flatMap((project) => roles.flatMap((role) => {
      const was = generatedSize(knowledge.applicable(project.id, role.id, before), project.name);
      const will = generatedSize(knowledge.applicable(project.id, role.id, after), project.name);
      return was.brief === will.brief && was.files === will.files ? [] : [{ project_id: project.id, project: project.name, role_id: role.id, role: role.name, before: was, after: will }];
    }));
    return { dropped, combos };
  }
  // The old long-term rulings the step to ledger 20 kept (knowledge §4.2): each becomes a proposal
  // of its own, from "迁移的长期裁定", with its record as the evidence, for the project of its
  // Task or else global, and goes through the gate as any other proposal — a decision inside one
  // task is turned down there, a lasting rule takes effect, a global resident one waits for the
  // owner. Taken off the list in the transaction that proposes it; one the ledger refuses stays
  // with the reason, and is said in the log.
  function carryLegacyDecisions(): void {
    type Kept = { id: string; created_at: string; task_id: string | null; scope: unknown; text: string; project_id: string | null; problem?: string };
    const keptList = (): Kept[] => readSetting<Kept[]>('legacy_decisions', []);
    for (const item of keptList().filter(({ problem }) => problem === undefined)) {
      const scope = typeof item.scope === 'string' ? item.scope : JSON.stringify(item.scope);
      const firstLine = item.text.trim().split('\n')[0]!;
      try {
        write(() => {
          knowledge.propose({
            outputs: [{
              title: firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine,
              when_to_use: `旧负责人记下的长期裁定，适用范围：${scope}`,
              body: item.text,
              project_ids: item.project_id === null ? null : [item.project_id],
              loading: 'resident',
            }],
            why: {
              when: `旧负责人记下这条裁定时写的适用范围：${scope}`,
              changes: '升级前它是负责人每次开会话都会读到的长期裁定；不经知识提议，升级后它就不再进任何负责人的输入',
              generalizes: '证据只有这条原始记录；它是长期规则还是某个任务里的一次决定，由把关判断',
            },
            evidence: [{
              source: 'record', ref: item.id, excerpt: item.text,
              location: `旧账本的长期裁定 ${item.id}（${item.created_at}${item.task_id === null ? '' : `，任务 ${item.task_id}`}）`,
            }],
            request_id: item.id,
          }, { source: 'migration', by: '迁移的长期裁定', client: 'migration', writers: [] }, MIGRATION);
          writeSetting('legacy_decisions', keptList().filter(({ id }) => id !== item.id));
        });
      } catch (err) {
        if (!(err instanceof InputError)) throw err;
        write(() => writeSetting('legacy_decisions', keptList().map((each) => (each.id === item.id ? { ...each, problem: err.message } : each))));
        (options.log ?? console.error)(`旧的长期裁定 ${item.id} 没能转成知识提议：${err.message}`);
      }
    }
    if (keptList().length === 0) write(() => db.run(`DELETE FROM setting WHERE key = 'legacy_decisions'`));
  }

  knowledgeTask = (fields, ctx) => {
    const task = api.createTask({ projectId: null, title: fields.title, goal: fields.goal, acceptance: fields.acceptance, roleId: ANALYSE_ROLE_ID, knowledge: fields.knowledge }, ctx);
    api.queueTask(task.id, ctx);
    return task.id;
  };
  endKnowledgeTask = (taskId, reason, ctx) => {
    const task = loadTask(taskId);
    if (task.state === 'done' || task.state === 'abandoned' || activeRun(task)) return;
    api.abandonTask(taskId, reason, ctx);
  };
  if (!(options.readOnly ?? false)) {
    // Only the current admission followed by this placement proves a legacy snapshot belongs
    // to the current registration. Sequence numbers, unlike timestamps, order replacement.
    const legacyPlacements = () => db.all<{ id: string; snapshot_json: string; uid: string }>(`
        SELECT r.id, r.snapshot_json, m.uid FROM run r JOIN machine m ON m.id = r.machine_id AND m.node_id = r.node_id
        WHERE json_valid(r.snapshot_json) AND json_type(r.snapshot_json, '$.machine_uid') IS NULL
          AND m.left_at IS NULL
          AND EXISTS (SELECT 1 FROM change admission
            WHERE admission.seq = (SELECT max(seq) FROM change WHERE action IN ('machine.join', 'machine.join_local', 'machine.join_spawned') AND json_extract(detail_json, '$.machine_id') = m.id)
              AND (json_type(admission.detail_json, '$.machine_uid') IS NULL OR json_extract(admission.detail_json, '$.machine_uid') = m.uid)
              AND admission.seq < (SELECT max(seq) FROM change WHERE run_id = r.id AND action IN ('run.create', 'run.rehost'))
              AND NOT EXISTS (SELECT 1 FROM change ending WHERE ending.seq > admission.seq AND ending.action IN ('machine.delete', 'machine.leave', 'machine.revoke', 'machine.leave_destroyed', 'machine.destroyed') AND json_extract(ending.detail_json, '$.machine_id') = m.id))`);
    if (legacyPlacements().length) write(() => {
      for (const row of legacyPlacements()) {
        const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
        snapshot.machine_uid = row.uid;
        db.run('UPDATE run SET snapshot_json = ? WHERE id = ?', JSON.stringify(snapshot), row.id);
      }
    });
    if (readSetting<unknown[]>('legacy_decisions', []).length > 0) carryLegacyDecisions();
    materializePublished();
  }
  return api;
}

export type Ledger = ReturnType<typeof openLedger>;
