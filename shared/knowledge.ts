// Knowledge and skills (docs/design/knowledge-and-skills.md): the words and the vocabularies
// the service, its tools and the console all show. Declared once, here.

// What an entry is. Fixed at its first publication: a knowledge entry never becomes a skill.
// Knowledge says what to judge by; a skill says how to get a piece of work done (§1). Both go
// through the one entrance, gate and publication; they differ in their body and in how they
// reach a round: a skill is always a catalog line with its body in a file (or, when the Task
// names it, in the brief in full), never resident.
// The name the knowledge MCP is installed under on a machine (docs/deploy.md), by which a
// round tycho sends turns it off (docs/design/knowledge-and-skills.md §4.1).
export const KNOWLEDGE_MCP = 'tycho-knowledge';

export const KNOWLEDGE_KINDS = ['knowledge', 'skill'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KIND_LABELS: Record<KnowledgeKind, string> = { knowledge: '知识', skill: '技能' };

// What a skill's body answers (§1), in this order: the starting text wherever a skill is
// written, and what its gate checks it against. Not parsed: whether it answers them is the
// gate's judgment.
export const SKILL_TEMPLATE_PARTS = [
  { heading: '在哪里做', hint: '哪台机器、哪个目录、哪个仓库或系统' },
  { heading: '以谁的身份', hint: '哪个账号或用户，要什么权限' },
  { heading: '按什么顺序', hint: '一步一步写：每步做什么、用什么命令' },
  { heading: '怎样算成功', hint: '看到什么才算做完了' },
  { heading: '失败后留下什么', hint: '做到一半失败时现场是什么样、要报告什么、怎么收拾' },
] as const;
export const SKILL_TEMPLATE = SKILL_TEMPLATE_PARTS.map(({ heading, hint }) => `## ${heading}\n\n（${hint}）\n`).join('\n');
export const SKILL_TEMPLATE_TEXT = SKILL_TEMPLATE_PARTS.map(({ heading }) => heading).join('、');

// A proposal is one change (§2, §5.2): the existing entries it touches, each pinned to its
// revision and whether it was in force, with where each goes; and the entries it puts out.
// What becomes of an input: kept as it is (listed because the change relates to it), revised
// by one of the outputs, replaced by another entry, or retired.
export const DISPOSITIONS = ['keep', 'revise', 'replaced', 'retire'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const DISPOSITION_LABELS: Record<Disposition, string> = { keep: '保留', revise: '修订', replaced: '被取代', retire: '退役' };

// Where a proposal stands (§3). `gating`: its gate task has not passed or refused it yet.
// `awaiting_owner`: passed, and of the two kinds that take effect only on the owner's say.
// `stale`: an entry it pinned changed before it was published, so its difference has to be
// worked out again. `superseded`: the owner changed it in the console, which made a new one.
const PROPOSAL_STATES = ['gating', 'awaiting_owner', 'published', 'rejected', 'stale', 'superseded'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export const PROPOSAL_STATE_LABELS: Record<ProposalState, string> = {
  gating: '把关中',
  awaiting_owner: '等你点头',
  published: '已生效',
  rejected: '已驳回',
  stale: '依据的修订已变',
  superseded: '已改成新候选',
};

// Why a change waits for the owner's say even after its gate passed it (§3).
const OWNER_REASONS = ['global_resident', 'owner_entry'] as const;
export type OwnerReason = (typeof OWNER_REASONS)[number];
export const OWNER_REASON_LABELS: Record<OwnerReason, string> = {
  global_resident: '全局而且常驻：它会进所有项目的每一轮',
  owner_entry: '改动或退役你写过、审过的条目',
};

// A revision in force since its gate passed it, or since the owner saw or wrote it.
export const REVIEW_LABELS = { reviewed: '已审阅', unreviewed: '未审阅' } as const;

// A gate whose every eligible login runs the executor that wrote the proposal waits, and says
// so (§3): nobody gates what their own executor wrote.
export const noGateKeeperText = (writers: readonly string[]): string =>
  `等合格的把关者：写这份提议的执行器是 ${writers.join('、')}，知识任务能用的其余登录里没有能跑这一档的`;

// Where a gate or curation Task stands (§3): in no project; where it came from; and the projects
// whose content its material carries, every one of which must allow the machine it goes to.
export function knowledgeTaskPlaceText(source: string | null, projects: readonly string[]): string {
  const from = source === null ? '不是从哪个项目来的' : `来自项目 ${source}`;
  const where = projects.length === 0 ? '材料不涉及任何项目，机器不受项目限制' : `材料涉及项目 ${projects.join('、')}，只派到它们都允许的机器`;
  return `不属于任何项目。${from}；${where}`;
}


// How a knowledge entry reaches a round, the Router or a session (§1, §1.1): resident is its
// whole text, on demand only its title and when to use it, with the text read or sent as a file.
// Part of a revision: changing it is a new revision.
export const LOADINGS = ['resident', 'on_demand'] as const;
export type Loading = (typeof LOADINGS)[number];
export const LOADING_LABELS: Record<Loading, string> = { resident: '常驻', on_demand: '按需' };

export type EntryState = 'active' | 'retired';
export const ENTRY_STATE_LABELS: Record<EntryState, string> = { active: '可用', retired: '已退役' };

// Where a proposal came in.
export const PROPOSAL_SOURCES = ['worker', 'router', 'mcp', 'console', 'curation', 'migration', 'import'] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];
export const SOURCE_LABELS: Record<ProposalSource, string> = {
  worker: '执行者回执',
  router: '负责人',
  mcp: '外部会话（知识 MCP）',
  console: '控制台',
  curation: '整理任务',
  // An old long-term ruling of the one global Router, carried over by the step to ledger 20.
  migration: '迁移的长期裁定',
  // A skill file the owner kept under the data directory's skills folder, brought in by the
  // owner's explicit act in the console (§6) and gated like any other.
  import: '迁入的技能文件',
};

// What a piece of evidence is from.
export const EVIDENCE_SOURCES = ['run', 'task', 'commit', 'conversation', 'file', 'command', 'owner'] as const;
// `record`: a record of the ledger itself, which only a migration hands over; nobody submits it.
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number] | 'record';
export const EVIDENCE_SOURCE_LABELS: Record<EvidenceSource, string> = {
  run: '执行轮次',
  task: '任务',
  commit: '提交',
  conversation: '外部对话',
  file: '文件',
  command: '命令输出',
  owner: '主人原话',
  record: '账本里的旧记录',
};
export const VERIFIED_TEXT = '已核实';
export const UNVERIFIED_TEXT = '提交者提供，未核对原记录';

// What a knowledge MCP token may do. Reading and proposing are two grants (§4.3).
export const GRANTS = ['read', 'propose'] as const;
export type Grant = (typeof GRANTS)[number];
export const GRANT_LABELS: Record<Grant, string> = { read: '读取', propose: '提议' };

// The three questions a proposal answers before it is sent (§2). Shown in the tools' own
// descriptions and on the console's form, from this one place.
export const WHY_QUESTIONS = {
  when: '下次在什么情形下会用到它',
  changes: '它改变的是哪一个判断或动作',
  generalizes: '有什么证据支持把它推广出去，边界在哪',
} as const;

export const GLOBAL_LABEL = '全局';
export const ANY_ROLE_LABEL = '不限职能';

// One entry's scope in words: 全局, or the projects it names, with the roles it is narrowed to.
export function scopeText(projectNames: readonly string[] | null, roleNames: readonly string[]): string {
  const where = projectNames === null ? GLOBAL_LABEL : `项目 ${projectNames.join('、')}`;
  return roleNames.length === 0 ? where : `${where} · ${roleNames.join('、')}`;
}

// How a revision is cited everywhere: the entry and its revision number.
export const citation = (id: string, revision: number): string => `${id}@${revision}`;

// What the tools and the MCP say when there is nothing, so that "nothing here" is never
// mistaken for "the service did not answer" (§4.3).
export const NOT_FOUND_IN_SCOPE = '在这个范围内没找到';
export const SERVICE_UNAVAILABLE = '知识服务不可用';
