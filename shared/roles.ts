// Roles: what kind of work a Task is (docs/design/roles-and-tiers.md §3). A Task names one,
// and its tier follows from the role unless the Task overrides it with a reason. The
// vocabularies and the four preset roles are declared once here: the service and the
// console both read this, so a page never offers a value the service would refuse.
//
// What a role holds beyond its default tier: what it hands over is checked at settlement and
// whether it needs an independent review gates acceptance (§9 step 3); a read-only role only
// goes to a machine whose own probe says the executor's read-only way starts there (step 4).
import { localeMap, onLocaleChange, t } from './i18n.ts';
import type { TierId } from './tiers.ts';
import { loginName } from './logins.ts';

const PERMISSION_IDS = ['read', 'write'] as const;
export type PermissionId = (typeof PERMISSION_IDS)[number];
export const PERMISSIONS: readonly { id: PermissionId; label: string }[] = [
  { id: 'read', get label(): string { return t('sh.roles.permission.read'); } },
  { id: 'write', get label(): string { return t('sh.roles.permission.write'); } },
];

const DELIVERABLE_IDS = ['commit', 'report', 'verdict'] as const;
export type DeliverableId = (typeof DELIVERABLE_IDS)[number];
export const DELIVERABLES: readonly { id: DeliverableId; label: string }[] = [
  { id: 'commit', get label(): string { return t('sh.roles.deliverable.commit'); } },
  { id: 'report', get label(): string { return t('sh.roles.deliverable.report'); } },
  { id: 'verdict', get label(): string { return t('sh.roles.deliverable.verdict'); } },
];

export const isPermissionId = (value: unknown): value is PermissionId => (PERMISSION_IDS as readonly unknown[]).includes(value);
export const isDeliverableId = (value: unknown): value is DeliverableId => (DELIVERABLE_IDS as readonly unknown[]).includes(value);
export const permissionLabel = (id: string): string => PERMISSIONS.find((each) => each.id === id)?.label ?? id;
// What whoever hands out work has to know about a read-only role (§5): commands run, but how
// far depends on the executor's own read-only way, and a round that changes its code is not
// taken. Work that has to write goes to a writable role.
export let READ_ONLY_ROUND_TEXT: string = t('sh.roles.readOnlyRound');
export const deliverableLabel = (id: string): string => DELIVERABLES.find((each) => each.id === id)?.label ?? id;

// A role as the ledger, the tools and the console all see it.
export interface RoleConfig {
  id: string;
  name: string;
  // What it is for, and when not to use it.
  description: string;
  default_tier: TierId;
  permission: PermissionId;
  deliverable: DeliverableId;
  needs_review: boolean;
}

// The review role is the one role whose shape is the kind of task it is, not data: it reads
// and hands over a verdict. Its id is what the service knows it by; its name is the owner's.
export const REVIEW_ROLE_ID = 'review';
// The role a knowledge gate or curation Task is made with (docs/design/knowledge-and-skills.md
// §3, §5.3): read-only, handing over a judgment as a report.
export const ANALYSE_ROLE_ID = 'analyse';
// The role a merge of an accepted Task's pull request is made with (service/land.ts).
export const VERIFY_ROLE_ID = 'verify';
// The role for an Orchestrator running on a specific machine to coordinate local/cluster
// sub-workflows using machine-local skills and environment.
export const ORCHESTRATE_ROLE_ID = 'orchestrate';
export const REVIEW_SHAPE = { permission: 'read', deliverable: 'verdict' } as const;
export let REVIEW_SHAPE_TEXT: string = t('sh.roles.reviewShape');
export let REVIEW_KEEP_TEXT: string = t('sh.roles.reviewKeep');
// What the roles page says of the review role's own tier (roles-and-tiers.md §11.5).
export let REVIEW_TIER_TEXT: string = t('sh.roles.reviewTier');

// Only the four that differ in permission, deliverable or review (§3.1). Design, diagnosis
// and research are shaped like analysis; the owner adds them as data when wanted.
export const PRESET_ROLES: readonly RoleConfig[] = [
  {
    id: 'implement',
    get name(): string { return t('sh.roles.preset.implement.name'); },
    default_tier: 'execute',
    permission: 'write',
    deliverable: 'commit',
    needs_review: true,
    get description(): string { return t('sh.roles.preset.implement.desc'); },
  },
  {
    id: REVIEW_ROLE_ID,
    get name(): string { return t('sh.roles.preset.review.name'); },
    default_tier: 'decide',
    permission: 'read',
    deliverable: 'verdict',
    needs_review: false,
    get description(): string { return t('sh.roles.preset.review.desc'); },
  },
  {
    id: 'analyse',
    get name(): string { return t('sh.roles.preset.analyse.name'); },
    default_tier: 'decide',
    permission: 'read',
    deliverable: 'report',
    needs_review: false,
    get description(): string { return t('sh.roles.preset.analyse.desc'); },
  },
  {
    id: VERIFY_ROLE_ID,
    get name(): string { return t('sh.roles.preset.verify.name'); },
    default_tier: 'operate',
    permission: 'write',
    deliverable: 'report',
    needs_review: false,
    get description(): string { return t('sh.roles.preset.verify.desc'); },
  },
  {
    id: ORCHESTRATE_ROLE_ID,
    get name(): string { return t('sh.roles.preset.orchestrate.name'); },
    default_tier: 'decide',
    permission: 'write',
    deliverable: 'report',
    needs_review: false,
    get description(): string { return t('sh.roles.preset.orchestrate.desc'); },
  },
];

// Where a Task's tier came from: its role's default, the Task's own override, the service
// moving it up after a review rejected its product (§6), or — for a review — the round it
// reviews (§11.5).
export type TierSource = 'default' | 'override' | 'escalated' | 'reviewed';
// `reviewed`: a review Task whose tier comes from the round it reviews (roles-and-tiers.md
// §11.5), rather than from its own role's default.
export const TIER_SOURCE_TEXT: Readonly<Record<TierSource, string>> = localeMap({
  default: 'sh.roles.tierSource.default',
  override: 'sh.roles.tierSource.override',
  escalated: 'sh.roles.tierSource.escalated',
  reviewed: 'sh.roles.tierSource.reviewed',
});

// Why a Task that names no role waits, wherever the owner meets it.
export let NO_ROLE_REASON: string = t('sh.roles.noRoleReason');
// Why a Run out of contact is neither judged nor continued while its Task has no role and
// names no account: nothing says where its continuation could go.
export let NO_ROLE_LOST_TEXT: string = t('sh.roles.noRoleLost');
// How far an executor's read-only way reaches (§5): its tool set, the operating system's
// file access, or the native harness with post-round code-baseline verification. Declared
// by the adapter; the pages say it as it is.
const READ_ONLY_LAYER_IDS = ['tools', 'filesystem', 'contract'] as const;
export type ReadOnlyLayer = (typeof READ_ONLY_LAYER_IDS)[number];
export const READ_ONLY_LAYERS: Readonly<Record<ReadOnlyLayer, string>> = localeMap({
  tools: 'sh.roles.readOnlyLayer.tools',
  filesystem: 'sh.roles.readOnlyLayer.filesystem',
  contract: 'sh.roles.readOnlyLayer.contract',
});
export const isReadOnlyLayer = (value: unknown): value is ReadOnlyLayer => (READ_ONLY_LAYER_IDS as readonly unknown[]).includes(value);

// How one round was actually run, as its snapshot records it: read-only by the executor's
// declared way — its arguments and the layer they reach — or writable, the way a Worker runs
// with the machine as its boundary. A snapshot from before step 4 has none: it ran writable.
export type RunAccess = { permission: 'read'; layer: ReadOnlyLayer; args: string[] } | { permission: 'write' };
export const accessText = (access: RunAccess | undefined): string =>
  access?.permission === 'read'
    ? t('sh.roles.access.read', { layer: READ_ONLY_LAYERS[access.layer] ?? access.layer })
    : t('sh.roles.access.write');

// What a read-only round found of a folder source's directory, read only
// (docs/design/code-sources.md §8.1, §8.2): the commit HEAD names and `git status --porcelain`
// before the Worker and again after it. It is information, never a verdict: a folder is not
// tycho's, other work and the owner may be changing it, so a difference says nothing about the
// round the way a changed repository checkout does. `why` is there when the folder could not be
// read (it is not a git repository, or git failed), and `changed` then means nothing.
export interface FolderChange {
  changed: boolean;
  why?: string;
}

// What became of a read-only round's code (§5): there was none to check; it is as it was; it was
// changed, and how; or it could not be told, and why. The machine's watch finds it out
// (node/code-check.ts); the settlement takes its word, or "cannot check" where it gave none
// that holds. Only the first two let the round's result be taken — and for a folder source
// "no code" is the machine's honest answer, with what it read of the folder beside it.
export type CodeCheck =
  | { result: 'no-code'; folder_change?: FolderChange }
  | { result: 'same' }
  | { result: 'changed'; changes: string[] }
  | { result: 'unverifiable'; why: string };
export const codeCheckAdopted = (check: CodeCheck): boolean => check.result === 'same' || check.result === 'no-code';
// What a check's words go into — the Run's error, the Task's reason, a push — is shown as one
// stretch, so a long list of changes is cut here and nowhere else, and says it was cut.
const CODE_CHECK_TEXT_MAX = 1000;
export function codeCheckText(check: CodeCheck): string {
  const text = ((): string => {
    switch (check.result) {
      case 'same': return t('sh.roles.codeCheck.same');
      case 'no-code': return t('sh.roles.codeCheck.noCode', { folderChange: folderChangeText(check.folder_change) });
      case 'changed': return t('sh.roles.codeCheck.changed', { changes: check.changes.join(t('sh.semicolonSep')) });
      case 'unverifiable': return t('sh.roles.codeCheck.unverifiable', { why: check.why });
    }
  })();
  return text.length > CODE_CHECK_TEXT_MAX ? `${text.slice(0, CODE_CHECK_TEXT_MAX)}${t('sh.roles.codeCheck.truncated')}` : text;
}

// What the folder's own reading adds to a round that had no code of tycho's to check (§8.2):
// only ever information, so it is said beside the check and never instead of it.
function folderChangeText(change: FolderChange | undefined): string {
  if (change === undefined) return '';
  if (change.why !== undefined) return t('sh.roles.codeCheck.folderUnknown', { why: change.why });
  return change.changed ? t('sh.roles.codeCheck.folderChanged') : t('sh.roles.codeCheck.folderUnchanged');
}
// A machine whose client does not check a read-only round's code afterwards takes none.
export let CHECK_MISSING_TEXT: string = t('sh.roles.checkMissing');

// Why a read-only Task stops: no machine said the read-only way of an executor that could
// take it starts there. `details` says, machine by machine, why not.
export const readOnlyMissingText = (loginId: string, executor: string): string =>
  t('sh.roles.readOnlyMissing', { login: loginName(loginId), executor });
export const noReadOnlyText = (details: string): string => t('sh.roles.noReadOnly', { details });
export let ENFORCED_TEXT: string = t('sh.roles.enforced');
// What a Task that ended before roles existed shows in place of one.
export let OLD_NO_ROLE_TEXT: string = t('sh.roles.oldNoRole');
// Why a Task cannot be created without one.
export let ROLE_REQUIRED_TEXT: string = t('sh.roles.roleRequired');

onLocaleChange(() => {
  READ_ONLY_ROUND_TEXT = t('sh.roles.readOnlyRound');
  REVIEW_SHAPE_TEXT = t('sh.roles.reviewShape');
  REVIEW_KEEP_TEXT = t('sh.roles.reviewKeep');
  REVIEW_TIER_TEXT = t('sh.roles.reviewTier');
  NO_ROLE_REASON = t('sh.roles.noRoleReason');
  NO_ROLE_LOST_TEXT = t('sh.roles.noRoleLost');
  CHECK_MISSING_TEXT = t('sh.roles.checkMissing');
  ENFORCED_TEXT = t('sh.roles.enforced');
  OLD_NO_ROLE_TEXT = t('sh.roles.oldNoRole');
  ROLE_REQUIRED_TEXT = t('sh.roles.roleRequired');
});
