// Knowledge and skills (docs/design/knowledge-and-skills.md): the words and the vocabularies
// the service, its tools and the console all show. Declared once, here.

// What an entry is. Fixed at its first publication: a knowledge entry never becomes a skill.
// Knowledge says what to judge by; a skill says how to get a piece of work done (§1). Both go
// through the one entrance, gate and publication; they differ in their body and in how they
// reach a round: a skill is always a catalog line with its body in a file (or, when the Task
// names it, in the brief in full), never resident.
// The name the knowledge MCP is installed under on a machine (docs/deploy.md), by which a
// round tycho sends turns it off (docs/design/knowledge-and-skills.md §4.1).
import { localeMap, onLocaleChange, t } from './i18n.ts';

export const KNOWLEDGE_MCP = 'tycho-knowledge';

export const KNOWLEDGE_KINDS = ['knowledge', 'skill'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KIND_LABELS: Readonly<Record<KnowledgeKind, string>> = localeMap({
  knowledge: 'sh.knowledge.kind.knowledge',
  skill: 'sh.knowledge.kind.skill',
});

// What a skill's body answers (§1), in this order: the starting text wherever a skill is
// written, and what its gate checks it against. Not parsed: whether it answers them is the
// gate's judgment.
export const SKILL_TEMPLATE_PARTS: readonly { heading: string; hint: string }[] = [
  {
    get heading(): string { return t('sh.knowledge.skillTemplate.where.heading'); },
    get hint(): string { return t('sh.knowledge.skillTemplate.where.hint'); },
  },
  {
    get heading(): string { return t('sh.knowledge.skillTemplate.who.heading'); },
    get hint(): string { return t('sh.knowledge.skillTemplate.who.hint'); },
  },
  {
    get heading(): string { return t('sh.knowledge.skillTemplate.order.heading'); },
    get hint(): string { return t('sh.knowledge.skillTemplate.order.hint'); },
  },
  {
    get heading(): string { return t('sh.knowledge.skillTemplate.success.heading'); },
    get hint(): string { return t('sh.knowledge.skillTemplate.success.hint'); },
  },
  {
    get heading(): string { return t('sh.knowledge.skillTemplate.failure.heading'); },
    get hint(): string { return t('sh.knowledge.skillTemplate.failure.hint'); },
  },
];
const computeSkillTemplate = (): string =>
  SKILL_TEMPLATE_PARTS.map(({ heading, hint }) => t('sh.knowledge.skillTemplate.section', { heading, hint })).join('\n');
const computeSkillTemplateText = (): string =>
  SKILL_TEMPLATE_PARTS.map(({ heading }) => heading).join(t('sh.listSep'));
export let SKILL_TEMPLATE: string = computeSkillTemplate();
export let SKILL_TEMPLATE_TEXT: string = computeSkillTemplateText();

// A proposal is one change (§2, §5.2): the existing entries it touches, each pinned to its
// revision and whether it was in force, with where each goes; and the entries it puts out.
// What becomes of an input: kept as it is (listed because the change relates to it), revised
// by one of the outputs, replaced by another entry, or retired.
export const DISPOSITIONS = ['keep', 'revise', 'replaced', 'retire'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const DISPOSITION_LABELS: Readonly<Record<Disposition, string>> = localeMap({
  keep: 'sh.knowledge.disposition.keep',
  revise: 'sh.knowledge.disposition.revise',
  replaced: 'sh.knowledge.disposition.replaced',
  retire: 'sh.knowledge.disposition.retire',
});

// Where a proposal stands (§3). `gating`: its gate task has not passed or refused it yet.
// `awaiting_owner`: passed, and of the two kinds that take effect only on the owner's say.
// `stale`: an entry it pinned changed before it was published, so its difference has to be
// worked out again. `superseded`: the owner changed it in the console, which made a new one.
const PROPOSAL_STATES = ['gating', 'awaiting_owner', 'published', 'rejected', 'stale', 'superseded'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export const PROPOSAL_STATE_LABELS: Readonly<Record<ProposalState, string>> = localeMap({
  gating: 'sh.knowledge.proposalState.gating',
  awaiting_owner: 'sh.knowledge.proposalState.awaiting_owner',
  published: 'sh.knowledge.proposalState.published',
  rejected: 'sh.knowledge.proposalState.rejected',
  stale: 'sh.knowledge.proposalState.stale',
  superseded: 'sh.knowledge.proposalState.superseded',
});

// Why a change waits for the owner's say even after its gate passed it (§3).
const OWNER_REASONS = ['global_resident', 'owner_entry'] as const;
export type OwnerReason = (typeof OWNER_REASONS)[number];
export const OWNER_REASON_LABELS: Readonly<Record<OwnerReason, string>> = localeMap({
  global_resident: 'sh.knowledge.ownerReason.global_resident',
  owner_entry: 'sh.knowledge.ownerReason.owner_entry',
});

// A revision in force since its gate passed it, or since the owner saw or wrote it.
export const REVIEW_LABELS = localeMap({
  reviewed: 'sh.knowledge.review.reviewed',
  unreviewed: 'sh.knowledge.review.unreviewed',
});

// A gate whose every eligible login runs the executor that wrote the proposal waits, and says
// so (§3): nobody gates what their own executor wrote.
export const noGateKeeperText = (writers: readonly string[]): string =>
  t('sh.knowledge.noGateKeeper', { writers: writers.join(t('sh.listSep')) });

// Where a gate or curation Task stands (§3): in no project; where it came from; and the projects
// whose content its material carries, every one of which must allow the machine it goes to.
export function knowledgeTaskPlaceText(source: string | null, projects: readonly string[]): string {
  const from = source === null
    ? t('sh.knowledge.taskPlace.fromNone')
    : t('sh.knowledge.taskPlace.fromProject', { source });
  const where = projects.length === 0
    ? t('sh.knowledge.taskPlace.projectsNone')
    : t('sh.knowledge.taskPlace.projectsSome', { projects: projects.join(t('sh.listSep')) });
  return t('sh.knowledge.taskPlace.full', { from, where });
}


// How a knowledge entry reaches a round, the Router or a session (§1, §1.1): resident is its
// whole text, on demand only its title and when to use it, with the text read or sent as a file.
// Part of a revision: changing it is a new revision.
export const LOADINGS = ['resident', 'on_demand'] as const;
export type Loading = (typeof LOADINGS)[number];
export const LOADING_LABELS: Readonly<Record<Loading, string>> = localeMap({
  resident: 'sh.knowledge.loading.resident',
  on_demand: 'sh.knowledge.loading.on_demand',
});

export type EntryState = 'active' | 'retired';
export const ENTRY_STATE_LABELS: Readonly<Record<EntryState, string>> = localeMap({
  active: 'sh.knowledge.entryState.active',
  retired: 'sh.knowledge.entryState.retired',
});

// Where a proposal came in.
export const PROPOSAL_SOURCES = ['worker', 'router', 'mcp', 'console', 'curation', 'migration', 'import'] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];
export const SOURCE_LABELS: Readonly<Record<ProposalSource, string>> = localeMap({
  worker: 'sh.knowledge.source.worker',
  router: 'sh.knowledge.source.router',
  mcp: 'sh.knowledge.source.mcp',
  console: 'sh.knowledge.source.console',
  curation: 'sh.knowledge.source.curation',
  // An old long-term ruling of the one global Router, carried over by the step to ledger 20.
  migration: 'sh.knowledge.source.migration',
  // A skill file the owner kept under the data directory's skills folder, brought in by the
  // owner's explicit act in the console (§6) and gated like any other.
  import: 'sh.knowledge.source.import',
});

// What a piece of evidence is from.
export const EVIDENCE_SOURCES = ['run', 'task', 'commit', 'conversation', 'file', 'command', 'owner'] as const;
// `record`: a record of the ledger itself, which only a migration hands over; nobody submits it.
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number] | 'record';
export const EVIDENCE_SOURCE_LABELS: Readonly<Record<EvidenceSource, string>> = localeMap({
  run: 'sh.knowledge.evidence.run',
  task: 'sh.knowledge.evidence.task',
  commit: 'sh.knowledge.evidence.commit',
  conversation: 'sh.knowledge.evidence.conversation',
  file: 'sh.knowledge.evidence.file',
  command: 'sh.knowledge.evidence.command',
  owner: 'sh.knowledge.evidence.owner',
  record: 'sh.knowledge.evidence.record',
});
export let VERIFIED_TEXT: string = t('sh.knowledge.verified');
export let UNVERIFIED_TEXT: string = t('sh.knowledge.unverified');

// What a knowledge MCP token may do. Reading and proposing are two grants (§4.3).
export const GRANTS = ['read', 'propose'] as const;
export type Grant = (typeof GRANTS)[number];
export const GRANT_LABELS: Readonly<Record<Grant, string>> = localeMap({
  read: 'sh.knowledge.grant.read',
  propose: 'sh.knowledge.grant.propose',
});

// The three questions a proposal answers before it is sent (§2). Shown in the tools' own
// descriptions and on the console's form, from this one place.
export const WHY_QUESTIONS = localeMap({
  when: 'sh.knowledge.why.when',
  changes: 'sh.knowledge.why.changes',
  generalizes: 'sh.knowledge.why.generalizes',
});

export let GLOBAL_LABEL: string = t('sh.knowledge.globalLabel');
export let ANY_ROLE_LABEL: string = t('sh.knowledge.anyRoleLabel');

// One entry's scope in words: 全局, or the projects it names, with the roles it is narrowed to.
export function scopeText(projectNames: readonly string[] | null, roleNames: readonly string[]): string {
  const sep = t('sh.listSep');
  const where = projectNames === null
    ? GLOBAL_LABEL
    : t('sh.knowledge.scopeProjects', { projects: projectNames.join(sep) });
  return roleNames.length === 0 ? where : `${where} · ${roleNames.join(sep)}`;
}

// How a revision is cited everywhere: the entry and its revision number.
export const citation = (id: string, revision: number): string => `${id}@${revision}`;

// What the tools and the MCP say when there is nothing, so that "nothing here" is never
// mistaken for "the service did not answer" (§4.3).
export let NOT_FOUND_IN_SCOPE: string = t('sh.knowledge.notFoundInScope');
export let SERVICE_UNAVAILABLE: string = t('sh.knowledge.serviceUnavailable');

onLocaleChange(() => {
  SKILL_TEMPLATE = computeSkillTemplate();
  SKILL_TEMPLATE_TEXT = computeSkillTemplateText();
  VERIFIED_TEXT = t('sh.knowledge.verified');
  UNVERIFIED_TEXT = t('sh.knowledge.unverified');
  GLOBAL_LABEL = t('sh.knowledge.globalLabel');
  ANY_ROLE_LABEL = t('sh.knowledge.anyRoleLabel');
  NOT_FOUND_IN_SCOPE = t('sh.knowledge.notFoundInScope');
  SERVICE_UNAVAILABLE = t('sh.knowledge.serviceUnavailable');
});
