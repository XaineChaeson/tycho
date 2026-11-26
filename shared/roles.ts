// Roles: what kind of work a Task is (docs/design/roles-and-tiers.md §3). A Task names one,
// and its tier follows from the role unless the Task overrides it with a reason. The
// vocabularies and the four preset roles are declared once here: the service and the
// console both read this, so a page never offers a value the service would refuse.
//
// What a role holds beyond its default tier: what it hands over is checked at settlement and
// whether it needs an independent review gates acceptance (§9 step 3); a read-only role only
// goes to a machine whose own probe says the executor's read-only way starts there (step 4).
import type { TierId } from './tiers.ts';
import { loginName } from './logins.ts';

const PERMISSION_IDS = ['read', 'write'] as const;
export type PermissionId = (typeof PERMISSION_IDS)[number];
export const PERMISSIONS: readonly { id: PermissionId; label: string }[] = [
  { id: 'read', label: '只读' },
  { id: 'write', label: '可写' },
];

const DELIVERABLE_IDS = ['commit', 'report', 'verdict'] as const;
export type DeliverableId = (typeof DELIVERABLE_IDS)[number];
export const DELIVERABLES: readonly { id: DeliverableId; label: string }[] = [
  { id: 'commit', label: '提交' },
  { id: 'report', label: '报告' },
  { id: 'verdict', label: '结论' },
];

export const isPermissionId = (value: unknown): value is PermissionId => (PERMISSION_IDS as readonly unknown[]).includes(value);
export const isDeliverableId = (value: unknown): value is DeliverableId => (DELIVERABLE_IDS as readonly unknown[]).includes(value);
export const permissionLabel = (id: string): string => PERMISSIONS.find((each) => each.id === id)?.label ?? id;
// What whoever hands out work has to know about a read-only role (§5): commands run, but how
// far depends on the executor's own read-only way, and a round that changes its code is not
// taken. Work that has to write goes to a writable role.
export const READ_ONLY_ROUND_TEXT = '只读职能不改代码仓';
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
export const REVIEW_SHAPE_TEXT = '审阅的权限只能是只读、交付物只能是结论，这一条不能改';
export const REVIEW_KEEP_TEXT = '审阅这个职能不能删：它是独立审阅那一方的任务类型';
// What the roles page says of the review role's own tier (roles-and-tiers.md §11.5).
export const REVIEW_TIER_TEXT = '实际档位跟着被审的那一轮，默认档位只用在旧数据上';

// Only the four that differ in permission, deliverable or review (§3.1). Design, diagnosis
// and research are shaped like analysis; the owner adds them as data when wanted.
export const PRESET_ROLES: readonly RoleConfig[] = [
  {
    id: 'implement', name: '实现', default_tier: 'execute', permission: 'write', deliverable: 'commit', needs_review: true,
    description: '改代码、写测试并交付提交。',
  },
  {
    id: REVIEW_ROLE_ID, name: '审阅', default_tier: 'decide', permission: 'read', deliverable: 'verdict', needs_review: false,
    description: '对已有产物进行独立审阅并给出结论（只读）。',
  },
  {
    id: 'analyse', name: '分析', default_tier: 'decide', permission: 'read', deliverable: 'report', needs_review: false,
    description: '调研、设计、诊断分析并交付报告（只读）。',
  },
  {
    id: VERIFY_ROLE_ID, name: '验证', default_tier: 'operate', permission: 'write', deliverable: 'report', needs_review: false,
    description: '执行测试、复现或运维操作并交付报告。',
  },
  {
    id: ORCHESTRATE_ROLE_ID, name: '协调者', default_tier: 'decide', permission: 'write', deliverable: 'report', needs_review: false,
    description: '在指定机器上借助本机工具与技能协调完成复杂工作流并交付报告。',
  },
];

// Where a Task's tier came from: its role's default, the Task's own override, the service
// moving it up after a review rejected its product (§6), or — for a review — the round it
// reviews (§11.5).
export type TierSource = 'default' | 'override' | 'escalated' | 'reviewed';
// `reviewed`: a review Task whose tier comes from the round it reviews (roles-and-tiers.md
// §11.5), rather than from its own role's default.
export const TIER_SOURCE_TEXT: Record<TierSource, string> = { default: '职能默认', override: '单独指定', escalated: '审阅打回后升档', reviewed: '跟着被审的那一轮' };

// Why a Task that names no role waits, wherever the owner meets it.
export const NO_ROLE_REASON = '这个任务还没有职能，选一个职能再继续';
// Why a Run out of contact is neither judged nor continued while its Task has no role and
// names no account: nothing says where its continuation could go.
export const NO_ROLE_LOST_TEXT = '这个任务还没有职能，选一个职能后才能核实和接续失联的那一轮';
// How far an executor's read-only way reaches (§5): its tool set, the operating system's
// file access, or the native harness with post-round code-baseline verification. Declared
// by the adapter; the pages say it as it is.
const READ_ONLY_LAYER_IDS = ['tools', 'filesystem', 'contract'] as const;
export type ReadOnlyLayer = (typeof READ_ONLY_LAYER_IDS)[number];
export const READ_ONLY_LAYERS: Record<ReadOnlyLayer, string> = { tools: '工具层', filesystem: '文件系统层', contract: '事后核对层' };
export const isReadOnlyLayer = (value: unknown): value is ReadOnlyLayer => (READ_ONLY_LAYER_IDS as readonly unknown[]).includes(value);

// How one round was actually run, as its snapshot records it: read-only by the executor's
// declared way — its arguments and the layer they reach — or writable, the way a Worker runs
// with the machine as its boundary. A snapshot from before step 4 has none: it ran writable.
export type RunAccess = { permission: 'read'; layer: ReadOnlyLayer; args: string[] } | { permission: 'write' };
export const accessText = (access: RunAccess | undefined): string =>
  access?.permission === 'read' ? `只读：${READ_ONLY_LAYERS[access.layer] ?? access.layer}` : '可写';

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
const CODE_CHECK_TEXT_CUT = '……（太长，截断了）';
export function codeCheckText(check: CodeCheck): string {
  const text = ((): string => {
    switch (check.result) {
      case 'same': return '代码没变';
      case 'no-code': return `这一轮没有代码，无可核对${folderChangeText(check.folder_change)}`;
      case 'changed': return `代码被改，结果没有采用：${check.changes.join('；')}`;
      case 'unverifiable': return `核对不了，结果没有采用：${check.why}`;
    }
  })();
  return text.length > CODE_CHECK_TEXT_MAX ? `${text.slice(0, CODE_CHECK_TEXT_MAX)}${CODE_CHECK_TEXT_CUT}` : text;
}

// What the folder's own reading adds to a round that had no code of tycho's to check (§8.2):
// only ever information, so it is said beside the check and never instead of it.
function folderChangeText(change: FolderChange | undefined): string {
  if (change === undefined) return '';
  if (change.why !== undefined) return `；这一轮期间目录有没有变化不知道：${change.why}`;
  return change.changed ? '；这一轮期间目录有变化' : '；这一轮期间目录没有变化';
}
// A machine whose client does not check a read-only round's code afterwards takes none.
export const CHECK_MISSING_TEXT = '机器上的 tycho 太旧：只读那一轮结束后不会核对代码，升级后再看';

// Why a read-only Task stops: no machine said the read-only way of an executor that could
// take it starts there. `details` says, machine by machine, why not.
export const readOnlyMissingText = (loginId: string, executor: string): string =>
  `${loginName(loginId)} 的执行器 ${executor} 不提供只读，只读的职能不能交给它`;
export const noReadOnlyText =(details: string): string => `没有能只读跑的机器和执行器：${details}`;
export const ENFORCED_TEXT = '只读职能按原生执行器运行，轮次结束后核对代码基线；交付物在结算时核对，需独立审阅的任务须有有效“通过”才能验收。';
// What a Task that ended before roles existed shows in place of one.
export const OLD_NO_ROLE_TEXT = '职能未记录';
// Why a Task cannot be created without one.
export const ROLE_REQUIRED_TEXT = '任务必须选一个职能';
