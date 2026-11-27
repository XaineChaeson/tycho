// How published knowledge reads where it is used (docs/design/knowledge-and-skills.md §4): a
// round's brief and snapshot files, the Router's turn, and what the tools hand back. One
// rendering, from the entries the ledger selected; each way out first takes what applies, then
// gives resident entries in full and the rest as a catalog. The size limits are judged on
// exactly what is rendered.
import { citation, DISPOSITION_LABELS, GLOBAL_LABEL, KIND_LABELS, LOADING_LABELS, OWNER_REASON_LABELS, PROPOSAL_STATE_LABELS, scopeText, SOURCE_LABELS, type KnowledgeKind, type Loading } from '../shared/knowledge.ts';
import type { KnowledgeAsk } from '../channels/wecom-cards.ts';
import type { Change, Entry, Evidenced, KnowledgeLimits, KnowledgeMaterial, KnowledgeTask, Proposal, Revision } from './knowledge.ts';
import { bytes } from './knowledge.ts';
import { createHash } from 'node:crypto';
import type { NodeEntryContent } from '../shared/node-protocol.ts';

const KIB = 1024;
const kib = (n: number): string => `${(n / KIB).toFixed(1)} KiB`;
// How many of the largest entries an over-limit message names.
const NAMED = 5;

// What a snapshot keeps of each entry it was given: which revision and how it was loaded, so
// that what a round was handed can be read back after the entry moves on or is retired. An
// on-demand entry or a skill also carries its file: the round reads it there, never the current
// version. This is what was delivered, not what was read.
export interface GivenKnowledge {
  id: string;
  revision: number;
  title: string;
  loading: Loading;
  scope: 'global' | 'project';
  roles: string[];
  // A skill (§1); absent for knowledge, and in every round from before skills.
  kind?: 'skill';
  // A skill the Task names: its text is in the brief, in full, and it has no file.
  named?: true;
  // On-demand knowledge and skills not named: where the file is in the snapshot directory,
  // and its text.
  path?: string;
  text?: string;
}

export const knowledgeFile = (entry: Pick<Entry, 'id' | 'revision'> & { kind?: KnowledgeKind }): string =>
  `${entry.kind === 'skill' ? 'skills' : 'knowledge'}/${citation(entry.id, entry.revision)}.md`;

export function entryText(entry: Pick<Entry, 'id' | 'revision' | 'title' | 'when_to_use' | 'body'>, level = '###'): string {
  return `${level} ${entry.title}（${citation(entry.id, entry.revision)}）\n\n什么时候用：${entry.when_to_use}\n\n${entry.body.trim()}\n`;
}

export const givenOf = (entry: Entry): GivenKnowledge => ({
  id: entry.id, revision: entry.revision, title: entry.title, loading: entry.loading,
  scope: entry.project_ids === null ? 'global' : 'project', roles: entry.roles,
  ...(entry.kind === 'skill' ? { kind: 'skill' as const } : {}),
  ...(entry.loading === 'on_demand' ? { path: knowledgeFile(entry), text: entryText(entry, '#') } : {}),
});

// A skill the Task names (§4.1): in the brief in full, so no file of its own.
export const namedOf = (entry: Entry): GivenKnowledge => {
  const { path: _path, text: _text, ...given } = givenOf(entry);
  return { ...given, named: true };
};

// What a round is given of these entries, the skills the Task names among them in full.
export const givenAll = (entries: readonly Entry[], named: readonly string[] = []): GivenKnowledge[] =>
  entries.map((entry) => (entry.kind === 'skill' && entry.loading === 'on_demand' && named.includes(entry.id) ? namedOf(entry) : givenOf(entry)));

const RULE = '以下为本任务适用的知识与技能（引用写 `编号@修订号`）；与任务目标或验收标准冲突时以验收标准为准。';
const ON_DEMAND_RULE = '需要时读取本文件同目录下对应文件：';
const MAX_CATALOG_TRIGGER_CHARS = 120;

// Keep on-demand knowledge and skill catalog lines compact so verbose multi-paragraph skill
// descriptions never bloat every round's brief.md.
function compactCatalogTrigger(raw: string): string {
  const single = raw.replace(/\s+/g, ' ').trim();
  if (single.length <= MAX_CATALOG_TRIGGER_CHARS) return single;
  return `${single.slice(0, MAX_CATALOG_TRIGGER_CHARS - 1).trimEnd()}…`;
}

const catalogLine = (entry: Entry, omitted = false): string => {
  const trigger = compactCatalogTrigger(entry.when_to_use);
  return omitted
    ? `- ${entry.title}（${citation(entry.id, entry.revision)}）：${trigger}（快照体积受限，正文未附带）`
    : `- ${entry.title}（${citation(entry.id, entry.revision)}）：${trigger}。正文：本文件同目录的 \`${knowledgeFile(entry)}\``;
};

const SKILL_RULE = '需要时读取本文件同目录下对应技能文件：';

// The knowledge and skill sections of a round's brief, in the order §4.1 gives: resident
// knowledge in full, global before this project's (for any role before for this role — the
// order the ledger selected them in); then the catalog of on-demand knowledge and the catalog of
// skills, whose bodies the snapshot carries as files; then the skills the Task names (`named`),
// in full. The limit on the brief is judged on exactly this text.
export function briefSections(entries: readonly Entry[], projectName: string, named: readonly string[] = [], omittedIds?: ReadonlySet<string>): string {
  if (entries.length === 0) return '';
  const resident = entries.filter(({ loading }) => loading === 'resident');
  const onDemand = entries.filter(({ kind, loading }) => kind === 'knowledge' && loading === 'on_demand');
  const skills = entries.filter(({ kind, loading }) => kind === 'skill' && loading === 'on_demand');
  const listed = skills.filter(({ id }) => !named.includes(id));
  const chosen = skills.filter(({ id }) => named.includes(id));
  const part = (heading: string, list: readonly Entry[]): string => (list.length === 0 ? '' : `## ${heading}\n\n${list.map((entry) => entryText(entry)).join('\n')}\n`);
  const renderLine = (entry: Entry): string => catalogLine(entry, omittedIds?.has(entry.id) ?? false);
  const catalog = onDemand.length === 0 ? '' : `## 按需知识\n\n${ON_DEMAND_RULE}\n\n${onDemand.map(renderLine).join('\n')}\n\n`;
  const skillCatalog = listed.length === 0 ? '' : `## 技能\n\n${SKILL_RULE}\n\n${listed.map(renderLine).join('\n')}\n\n`;
  const namedPart = chosen.length === 0 ? '' : `## 指定技能\n\n${chosen.map((entry) => entryText(entry)).join('\n')}\n`;
  return `${RULE}\n\n${part('全局知识', resident.filter(({ project_ids }) => project_ids === null))}${part(`项目知识（${projectName}）`, resident.filter(({ project_ids }) => project_ids !== null))}${catalog}${skillCatalog}${namedPart}`;
}

function truncateUtf8(text: string, maxBytes: number, suffix = ''): string {
  if (bytes(text) <= maxBytes) return text;
  const suffixBytes = bytes(suffix);
  if (maxBytes <= suffixBytes) return Buffer.from(suffix, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8').replace(/\uFFFD+$/, '');
  const head = Buffer.from(text, 'utf8').subarray(0, maxBytes - suffixBytes).toString('utf8').replace(/\uFFFD+$/, '');
  return `${head}${suffix}`;
}

export interface FittedKnowledge {
  sections: string;
  given: GivenKnowledge[];
  warning?: string;
}

// Fits a round's knowledge and skills within configured byte limits without blocking dispatch:
// oversized single bodies are truncated, overflow resident entries are downgraded to on-demand
// catalog lines, and overflow snapshot file texts are trimmed/omitted while preserving every
// entry's `{ id, revision }` in `given`.
export function fitKnowledgeForRound(
  entries: readonly Entry[],
  projectName: string,
  limits: KnowledgeLimits,
  material?: { kind: KnowledgeTask['kind']; files: readonly { text: string }[] },
  named: readonly string[] = [],
): FittedKnowledge {
  if (entries.length === 0) return { sections: '', given: [] };
  const warnings: string[] = [];

  let working: Entry[] = entries.map((entry) => {
    if (bytes(entry.body) <= limits.entryBytes) return entry;
    warnings.push(`${citation(entry.id, entry.revision)} 正文超出单条上限，已截断`);
    return { ...entry, body: truncateUtf8(entry.body, limits.entryBytes, '\n\n…（已截断）') };
  });

  let sections = briefSections(working, projectName, named);
  if (bytes(sections) > limits.briefBytes) {
    const downgraded: string[] = [];
    const residentIndices = working
      .map((entry, idx) => ({ entry, idx, size: bytes(entry.body) }))
      .filter(({ entry }) => entry.loading === 'resident')
      .sort((a, b) => b.size - a.size);
    const mutable = [...working];
    for (const { idx, entry } of residentIndices) {
      mutable[idx] = { ...entry, loading: 'on_demand' };
      downgraded.push(citation(entry.id, entry.revision));
      sections = briefSections(mutable, projectName, named);
      if (bytes(sections) <= limits.briefBytes) break;
    }
    working = mutable;
    if (downgraded.length > 0) {
      warnings.push(`常驻知识超出说明上限，已将 ${downgraded.join('、')} 转为按需目录`);
    }
  }

  const given = givenAll(working, named);
  const omittedIds = new Set<string>();
  const carried = material?.files.reduce((sum, { text }) => sum + bytes(text), 0) ?? 0;
  let filesBytes = given.reduce((sum, each) => sum + (each.text === undefined ? 0 : bytes(each.text)), 0);
  if (filesBytes + carried > limits.snapshotBytes) {
    const budget = Math.max(0, limits.snapshotBytes - carried);
    const trimmed: string[] = [];
    const bySize = given
      .map((item, idx) => ({ idx, size: item.text === undefined ? 0 : bytes(item.text) }))
      .filter(({ size }) => size > 0)
      .sort((a, b) => b.size - a.size);
    for (const { idx, size } of bySize) {
      if (filesBytes <= budget) break;
      const item = given[idx]!;
      const excess = filesBytes - budget;
      if (size <= excess) {
        delete item.text;
        delete item.path;
        omittedIds.add(item.id);
        filesBytes -= size;
      } else {
        const nextText = truncateUtf8(item.text!, size - excess, '\n\n…（已截断）');
        filesBytes -= size - bytes(nextText);
        item.text = nextText;
      }
      trimmed.push(citation(item.id, item.revision));
    }
    if (trimmed.length > 0) {
      warnings.push(`快照知识文件超出上限，已截断或省略 ${trimmed.join('、')}`);
    }
  }
  // Re-render after snapshot fitting so omitted entries never leave dangling file paths in brief.md.
  if (omittedIds.size > 0) {
    sections = briefSections(working, projectName, named, omittedIds);
  }

  const warning = warnings.length > 0 ? warnings.join('；') : undefined;
  if (warning !== undefined) {
    sections = `> 注意：${warning}。\n\n${sections}`;
  }
  if (bytes(sections) > limits.briefBytes) {
    sections = truncateUtf8(sections, limits.briefBytes, '\n\n…（知识说明超出上限，已截断）\n\n');
  }
  return { sections, given, ...(warning === undefined ? {} : { warning }) };
}

// Advisory diagnostic for knowledge budget status (does not block dispatch).
export function knowledgeOverLimit(
  entries: readonly Entry[],
  sections: string,
  limits: KnowledgeLimits,
  // A gate's or curation's material: files of the snapshot like the rest (§3, §5.3).
  material?: { kind: KnowledgeTask['kind']; files: readonly { text: string }[] },
  named: readonly string[] = [],
): string | undefined {
  const problems: string[] = [];
  for (const entry of entries) {
    if (bytes(entry.body) > limits.entryBytes) problems.push(`条目 ${citation(entry.id, entry.revision)}“${entry.title}”的正文 ${kib(bytes(entry.body))}，超过单条上限 ${kib(limits.entryBytes)}`);
  }
  const inBrief = bytes(sections);
  if (inBrief > limits.briefBytes) problems.push(`说明里的常驻知识、两份目录和点名的技能合计 ${kib(inBrief)}，超过上限 ${kib(limits.briefBytes)}`);
  const given = givenAll(entries, named);
  const filesOf = (kind: KnowledgeKind): number => given.reduce((sum, each) => sum + ((each.kind ?? 'knowledge') === kind && each.text !== undefined ? bytes(each.text) : 0), 0);
  const onDemand = filesOf('knowledge');
  const skillFiles = filesOf('skill');
  const carried = material?.files.reduce((sum, { text }) => sum + bytes(text), 0) ?? 0;
  const inSnapshot = onDemand + skillFiles + carried;
  if (inSnapshot > limits.snapshotBytes) {
    const sources = [`按需知识 ${kib(onDemand)}`, `技能 ${kib(skillFiles)}`, ...(material ? [`${material.kind === 'gate' ? '把关材料' : '整理材料'} ${kib(carried)}`] : [])];
    problems.push(`快照里的知识与技能文件合计 ${kib(inSnapshot)}，超过上限 ${kib(limits.snapshotBytes)}（${sources.join('、')}）`);
  }
  if (problems.length === 0) return undefined;
  const heaviest = [...entries].sort((a, b) => bytes(b.body) - bytes(a.body)).slice(0, NAMED)
    .map((entry) => `${citation(entry.id, entry.revision)}“${entry.title}”${kib(bytes(entry.body))}（${entry.project_ids === null ? GLOBAL_LABEL : '项目'}·${entry.kind === 'skill' ? KIND_LABELS.skill : LOADING_LABELS[entry.loading]}）`);
  return `知识体积超过建议上限（派发时将自动降级为按需目录或截断）：${problems.join('；')}。最大的几条：${heaviest.join('、')}`;
}

export function requireWithinLimits(...args: Parameters<typeof knowledgeOverLimit>): string | undefined {
  return knowledgeOverLimit(...args);
}

// What a project's Router is given (docs/design/project-sessions.md §3, knowledge §4.2): of the
// global entries and this project's, those for any role — the ledger's applicable(project, no
// role), which is what `entries` are. The resident ones go into a context once, in full, when it
// starts: `resident` are their revisions, which the context keeps, and any change to them means a
// new context, so that no rule that stopped holding stays in one. The rest are a catalog — what
// there is, not what it says — that a turn carries whenever it changed.
export interface HostVersionState {
  current: string;
  previous: string | null;
  upgraded_at: string;
}

const WORKAROUND_PATTERN = /规避|绕过|临时(?:方案|处理|措施)|直至.*修复|已知.*(?:BUG|缺陷|问题)|workaround|暂不支持|启动失败|传不过去/i;
const WORKAROUND_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// Deterministic closed-loop staleness detector for temporary workaround knowledge:
// - Never flags ordinary business/architecture knowledge.
// - Flags workaround/bug-avoidance entries once Tycho has been upgraded after the entry's
//   publication, or after 7 days without revalidation, prompting the Router to verify and
//   self-retire obsolete workarounds via `propose_learning(disposition: "retire")`.
export function workaroundRevalidationHint(
  entry: Pick<Entry, 'title' | 'when_to_use' | 'body' | 'published_at'>,
  options: { hostVersion?: HostVersionState | null; nowMs?: number } = {},
): string | null {
  const combined = `${entry.title}\n${entry.when_to_use}\n${entry.body}`;
  if (!WORKAROUND_PATTERN.test(combined)) return null;
  const publishedMs = Date.parse(entry.published_at);
  if (!Number.isFinite(publishedMs)) return null;
  const host = options.hostVersion ?? null;
  if (host) {
    const upgradedMs = Date.parse(host.upgraded_at);
    if (Number.isFinite(upgradedMs) && publishedMs < upgradedMs) {
      return `待复核：tycho 已升级至 ${host.current}，请验证此规避是否已修复；若已修复请用 propose_learning（disposition: "retire"）自行退役`;
    }
  }
  const nowMs = options.nowMs ?? Date.now();
  if (nowMs - publishedMs >= WORKAROUND_STALE_MS) {
    return '待复核：该临时规避已超过 7 天未复核，请验证是否仍成立；失效请用 propose_learning（disposition: "retire"）自行退役';
  }
  return null;
}

export interface RouterKnowledge {
  resident: string[];
  residentText: string;
  catalog: string;
}

export function routerKnowledge(
  entries: readonly Entry[],
  options: { hostVersion?: HostVersionState | null; nowMs?: number } = {},
): RouterKnowledge {
  const activeAnyRole = entries.filter(({ state, roles }) => state === 'active' && roles.length === 0);
  const resident = activeAnyRole.filter(({ loading }) => loading === 'resident');
  const onDemand = activeAnyRole.filter(({ kind, loading }) => kind === 'knowledge' && loading === 'on_demand');
  const scope = (entry: Entry): string => (entry.project_ids === null ? GLOBAL_LABEL : '项目');
  const line = (entry: Entry): string => {
    const hint = workaroundRevalidationHint(entry, options);
    return `- ${entry.title}（${citation(entry.id, entry.revision)}，${scope(entry)}）：${entry.when_to_use}${hint ? ` [${hint}]` : ''}`;
  };
  const renderResident = (entry: Entry): string => {
    const hint = workaroundRevalidationHint(entry, options);
    const body = entryText(entry);
    return hint ? `> ${hint}\n\n${body}` : body;
  };
  const skills = activeAnyRole.filter(({ kind, loading }) => kind === 'skill' && loading === 'on_demand');
  const catalogs = [
    ...(onDemand.length === 0 ? [] : [`[tycho 知识] 按需目录（正文用 read_library 读）：\n${onDemand.map(line).join('\n')}`]),
    ...(skills.length === 0 ? [] : [`[tycho 技能] 技能目录（正文用 read_library 读，建任务可用 skill_ids 指定）：\n${skills.map(line).join('\n')}`]),
  ];
  return {
    resident: resident.map(({ id, revision }) => citation(id, revision)),
    residentText: resident.length === 0
      ? ''
      : `[tycho 知识]\n\n${resident.map(renderResident).join('\n')}`,
    catalog: catalogs.join('\n\n'),
  };
}

// What the machines write into each executor's own global instruction entry (§4.3): a note on
// how to reach the rest, and the global resident entries for any role in full — nothing of a
// project, of a role, or on demand. Over the limit nothing is written and the old file is taken
// down (`text` null), never a part of it: an entry cut short reads as if it were all.
const ENTRY_INTRO = `# tycho 全局知识

以下为全局常驻条目（引用写 \`编号@修订号\`）；项目级、按需与技能条目可通过 \`tycho-knowledge\` MCP（\`get_working_context\` / \`read_library\` / \`propose_learning\`）查阅与提议。
`;

export function globalEntryContent(entries: readonly Entry[], limitBytes: number, publisher: NodeEntryContent['publisher'], enabled = true): NodeEntryContent {
  if (!enabled || 'problem' in publisher) return { publisher, digest: createHash('sha256').update(JSON.stringify([publisher, 'external-entry-disabled'])).digest('hex').slice(0, 16), revisions: [], text: null };
  const resident = entries.filter(({ kind, state, project_ids: projects, loading, roles }) =>
    kind === 'knowledge' && state === 'active' && projects === null && loading === 'resident' && roles.length === 0);
  const revisions = resident.map(({ id, revision }) => citation(id, revision));
  const whole = resident.length === 0 ? null : `${ENTRY_INTRO}\n${resident.map((entry) => entryText(entry)).join('\n')}`;
  const problem = whole !== null && bytes(whole) > limitBytes
    ? `全局常驻知识写成入口文件是 ${kib(bytes(whole))}，超过上限 ${kib(limitBytes)}（设置“执行器入口里的知识上限”）。入口没有写，旧的那份撤下了：到知识页把用不上的改成按需或退役，或者调大上限`
    : undefined;
  const text = problem === undefined ? whole : null;
  const digest = createHash('sha256').update(JSON.stringify([publisher, revisions, text, problem ?? null])).digest('hex').slice(0, 16);
  return { publisher, digest, revisions, text, ...(problem === undefined ? {} : { problem }) };
}

// What a set of entries makes of a round's input (§4.1): the brief's knowledge and skill
// sections and the snapshot's files, measured the one way the limits and the curation threshold
// use. A Task that names skills moves their text from the files into its brief: not counted here,
// where no Task is in question.
export function generatedSize(entries: readonly Entry[], projectName: string): { brief: number; files: number } {
  return {
    brief: bytes(briefSections(entries, projectName)),
    files: givenAll(entries).reduce((sum, given) => sum + (given.text === undefined ? 0 : bytes(given.text)), 0),
  };
}

// ---- What the owner is told (§3) ----

type ProposalReader = { getProposal(id: string): Proposal; getProject(id: string): { name: string }; getEntry(id: string): Entry | undefined };

// A change in a few words: what it puts out and what becomes of what it touches.
export function changeSummary(change: Change, title: (id: string) => string): string {
  const parts = [
    ...change.outputs.map((output) => `${output.revises === null ? '新建' : '修订'}${change.kind === 'skill' ? KIND_LABELS.skill : ''}“${output.title}”`),
    ...change.inputs.filter(({ disposition }) => disposition === 'retire' || disposition === 'replaced')
      .map((input) => `${DISPOSITION_LABELS[input.disposition]}“${title(input.knowledge_id)}”`),
  ];
  return parts.join('、');
}

const scopeOfChange = (ledger: ProposalReader, change: Change): string => {
  const scopes = change.outputs.map((output) => `${scopeText(output.project_ids === null ? null : output.project_ids.map((each) => ledger.getProject(each).name), output.roles)} · ${change.kind === 'skill' ? KIND_LABELS.skill : LOADING_LABELS[output.loading]}`);
  return [...new Set(scopes)].join('；') || '只有退役';
};

export function knowledgeAskOf(ledger: ProposalReader, id: string): KnowledgeAsk {
  const proposal = ledger.getProposal(id);
  const change = proposal.final ?? proposal.change;
  const title = (entryId: string): string => ledger.getEntry(entryId)?.title ?? entryId;
  return {
    id,
    title: change.outputs[0]?.title ?? (change.inputs[0] ? title(change.inputs[0].knowledge_id) : ''),
    action: changeSummary(change, title),
    scope: scopeOfChange(ledger, change),
    reasons: proposal.owner_reasons.map((reason) => OWNER_REASON_LABELS[reason]),
    proposedBy: `${SOURCE_LABELS[proposal.source]} ${proposal.proposed_by}`,
    evidence: proposal.evidence.length,
    verified: proposal.evidence.filter(({ verified }) => verified).length,
    whenToUse: change.outputs[0]?.when_to_use ?? change.inputs[0]?.note ?? '',
  };
}

export function knowledgeOutcomeText(ledger: ProposalReader, id: string): string {
  const proposal = ledger.getProposal(id);
  return `${KIND_LABELS[proposal.kind]}变更“${knowledgeAskOf(ledger, id).action}”${PROPOSAL_STATE_LABELS[proposal.state]}`;
}

// ---- What a gate or curation round is handed (§3, §5.3) ----

// The material arrives as files of the round's snapshot, the way on-demand knowledge does; the
// round reads them there and nothing else. A gate gets the proposal — its change, why, evidence,
// and the rejection of the same content before, if there was one — and the entries it touches or
// resembles. A curation round gets the entries to curate, each with the evidence behind it.
export interface KnowledgeTaskMaterial {
  kind: KnowledgeTask['kind'];
  files: { path: string; text: string }[];
  // What the brief says the files are, in order.
  listing: string;
}

const DIR = 'knowledge-task';

// The material comes from the ledger's one answer (knowledgeMaterial), which the machines a
// round of it may go to are judged by as well.
type MaterialReader = { knowledgeMaterial(job: KnowledgeTask): KnowledgeMaterial };

function entryFile(entry: Revision & { state?: string; retired_reason?: string | null }): { path: string; text: string } {
  const scope = entry.project_ids === null ? GLOBAL_LABEL : `项目 ${entry.project_ids.join('、')}`;
  const header = `${KIND_LABELS[entry.kind]}；编号 ${entry.id}，修订 ${entry.revision}；${scope}；${entry.kind === 'skill' ? '目录给到、正文另取' : LOADING_LABELS[entry.loading]}；${entry.roles.length ? `只对 ${entry.roles.join('、')}` : '不限职能'}；${entry.reviewed_at ? '主人写过或审过' : '未经主人审阅'}${entry.state === 'retired' ? `；已退役：${entry.retired_reason ?? ''}` : ''}`;
  return { path: `${DIR}/entries/${citation(entry.id, entry.revision)}.md`, text: `${entryText(entry, '#')}
---
${header}
` };
}

const evidenceView = (evidence: readonly Evidenced[]) =>
  evidence.map(({ source, ref, location, excerpt, captured_at, verified }) => ({ source, ref, location, excerpt, captured_at, verified }));

export function knowledgeTaskMaterial(ledger: MaterialReader, job: KnowledgeTask): KnowledgeTaskMaterial {
  const material = ledger.knowledgeMaterial(job);
  if (material.kind === 'gate') {
    const { proposal, prior, related: relatedEntries } = material;
    const related = relatedEntries.map(entryFile);
    const files = [
      {
        path: `${DIR}/proposal.json`,
        text: `${JSON.stringify({
          proposal_id: proposal.id, source: proposal.source, proposed_by: proposal.proposed_by, change: proposal.change, why: proposal.why,
          evidence: evidenceView(proposal.evidence),
          prior_rejection: prior === null ? null : { proposal_id: prior.id, reason: prior.state_reason, change: prior.final ?? prior.change },
        }, null, 2)}
`,
      },
      ...related,
    ];
    return {
      kind: 'gate',
      files,
      listing: [`- \`${DIR}/proposal.json\`：提议内容与证据${prior ? '（含此前驳回理由）' : ''}`,
        ...relatedEntries.map((entry, at) => (entry.state === 'retired'
          ? `- \`${related[at]!.path}\`：已退役的相近条目（退役理由：${entry.retired_reason ?? '无'}）`
          : `- \`${related[at]!.path}\`：涉及或相近的现有条目`))].join('\n'),
    };
  }
  const files = material.entries.flatMap(({ entry, evidence }) => {
    const file = entryFile(entry);
    return [file, { path: file.path.replace(/\.md$/, '.evidence.json'), text: `${JSON.stringify(evidenceView(evidence), null, 2)}
` }];
  });
  return {
    kind: 'curation',
    files,
    listing: [`为什么整理：${material.reasons.join('；')}`, ...files.map(({ path }) => `- \`${path}\``)].join('\n'),
  };
}
