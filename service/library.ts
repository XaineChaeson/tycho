// The four tools that read and propose knowledge (docs/design/knowledge-and-skills.md §4.2,
// §4.3): one implementation for the Router and for the knowledge MCP. Reading and proposing
// are separate grants; nothing here publishes, and nothing reads a file or fetches a link a
// caller names — evidence is the excerpt it hands over.
import { citation, DISPOSITIONS, EVIDENCE_SOURCES, KNOWLEDGE_KINDS, LOADINGS, NOT_FOUND_IN_SCOPE, type Grant, type KnowledgeKind } from '../shared/knowledge.ts';
import { isDirectorySkillId } from '../shared/skill-catalog.ts';
import type { Ctx } from './db.ts';
import { DegradedError, InputError } from './errors.ts';
import type { Entry, Proposer } from './knowledge.ts';
import { revisionSet } from './knowledge.ts';
import { workaroundRevalidationHint, type HostVersionState } from './knowledge-brief.ts';
import type { Ledger } from './ledger.ts';
import { described, json, object, problem, STRING, type Args, type Schema, type ToolResult } from './tool-schema.ts';

interface LibraryTool {
  name: string;
  grant: Grant;
  description: string;
  inputSchema: Schema;
  run(args: Args, caller: Caller): string;
}

// Who is asking, as the entrance knows it.
interface Caller {
  ctx: Ctx;
  proposer: Proposer;
  // Supplied by callLibrary after token authorization, never by proposal arguments.
  grants?: readonly Grant[];
}

type LibraryLedger = Pick<Ledger, 'applicable' | 'getProject' | 'getRole' | 'searchLibrary' | 'readRevision' | 'getEntry' | 'getDirectorySkillEntry' | 'revisionsOf' | 'getProposal' | 'propose'> & Partial<Pick<Ledger, 'hostVersionState'>>;

type Viewed = Pick<Entry, 'id' | 'kind' | 'revision' | 'title' | 'when_to_use' | 'body' | 'roles' | 'project_ids' | 'loading' | 'published_at'>;

// An entry as a catalog line: what it is and when it applies, never its text.
const listed = (entry: Viewed, hostVersion?: HostVersionState | null) => {
  const hint = workaroundRevalidationHint(entry, { hostVersion });
  return {
    cite: citation(entry.id, entry.revision), id: entry.id, kind: entry.kind, revision: entry.revision, title: entry.title,
    when_to_use: entry.when_to_use, ...(entry.kind === 'skill' && entry.loading === 'on_demand' ? {} : { loading: entry.loading }), scope: entry.project_ids ?? 'global', roles: entry.roles,
    ...(hint ? { recheck_hint: hint } : {}),
  };
};
// And in full, with its text.
const view = (entry: Viewed, hostVersion?: HostVersionState | null) => ({ ...listed(entry, hostVersion), body: entry.body });
// What a working context gives of an entry (§4.3): resident entries in full; on-demand
// knowledge and on-demand skills as a catalog line, whose text read_library hands over.
const contextOf = (entry: Viewed, hostVersion?: HostVersionState | null) => (entry.loading === 'resident' ? view(entry, hostVersion) : listed(entry, hostVersion));

const INPUT: Schema = object({
  knowledge_id: described('现有条目的编号'),
  revision: { type: 'integer', description: '可选：依据的修订号' },
  disposition: { type: 'string', enum: [...DISPOSITIONS], description: '可选：keep 保留、revise 修订、replaced 被取代、retire 退役' },
  replaced_by: described('可选：replaced 时取代它的输出 key 或现有条目编号'),
  note: described('可选备注'),
}, ['knowledge_id']);

const OUTPUT: Schema = object({
  key: described('可选：输出标识，默认 o1、o2'),
  revises: described('修订现有条目时填其编号；新建不填'),
  title: described('标题'),
  when_to_use: described('可选：触发情境'),
  body: described('正文'),
  project_ids: { type: 'array', items: STRING, nullable: true, description: '可选：项目编号列表，null 为全局；不填默认当前项目' },
  loading: { type: 'string', enum: [...LOADINGS], description: '可选：on_demand（默认，按需）或 resident（常驻；技能固定按需）' },
  roles: { type: 'array', items: STRING, description: '可选：限定职能编号列表' },
}, ['title', 'body']);

const WHY: Schema = object({
  when: described('何时使用'),
  changes: described('改变什么判断或动作'),
  generalizes: described('适用范围与边界'),
});

const EVIDENCE: Schema = object({
  source: { type: 'string', enum: [...EVIDENCE_SOURCES], description: '可选：run、task、commit、conversation、file、command、owner' },
  ref: described('可选：来源编号'),
  location: described('可选：位置说明'),
  excerpt: described('原文摘录（不含凭据）'),
  captured_at: described('可选：采集时间，带时区'),
});

export const PROPOSE_DESCRIPTION = '创建、修订或退役知识（knowledge，默认）或技能（skill）条目：填 outputs（新建或用 revises 修订现有条目）和/或 inputs（退役或关联现有条目），project_ids 默认当前项目（null 为全局），loading 默认 on_demand。一般条目提交即生效（标记未审阅供主人事后查看或退役），仅全局常驻（global + resident）条目需主人确认。';

export function createLibrary(ledger: LibraryLedger): LibraryTool[] {
  function requireScope(scope: string): 'global' | { projectId: string } {
    if (scope === 'global') return 'global';
    ledger.getProject(scope);
    return { projectId: scope };
  }

  return [
    {
      name: 'get_working_context',
      grant: 'read',
      description: '读一个项目、一个职能现在适用的知识和技能：全局的和这个项目的（不限职能的在前，再是这个职能的）。常驻知识给全文，按需知识和技能只给标题和什么时候用，用到时用 read_library 读正文。每条带修订号（编号@修订号），引用时照写。',
      inputSchema: object({ project_id: described('项目编号'), role_id: described('职能编号；不填只给不限职能的') }, ['project_id']),
      run({ project_id, role_id }) {
        const project = ledger.getProject(project_id);
        if (role_id !== undefined && !ledger.getRole(role_id)) throw new InputError(`职能不存在：${String(role_id)}`);
        const entries = ledger.applicable(project.id, role_id ?? null);
        const hostVersion = ledger.hostVersionState?.() ?? null;
        const knowledge = entries.filter(({ kind }) => kind === 'knowledge');
        return json({
          project: { id: project.id, name: project.name },
          role_id: role_id ?? null,
          ...(hostVersion ? { host_version: hostVersion.current } : {}),
          revision_set: revisionSet(entries),
          global: knowledge.filter(({ project_ids: of }) => of === null).map((e) => contextOf(e, hostVersion)),
          project_knowledge: knowledge.filter(({ project_ids: of }) => of !== null).map((e) => contextOf(e, hostVersion)),
          skills: entries.filter(({ kind }) => kind === 'skill').map((e) => contextOf(e, hostVersion)),
          ...(entries.length === 0 ? { note: `${NOT_FOUND_IN_SCOPE}：这个项目和职能现在没有适用的知识和技能` } : {}),
        });
      },
    },
    {
      name: 'search_library',
      grant: 'read',
      description: '在明确的范围里按文字查知识和技能：scope 填 global（全局）或一个项目编号，不能不填；kind 填 knowledge 或 skill 只查一种。只返回标题和“什么时候用”，全文用 read_library 读。结果分页：next_cursor 不是 null 时还有下一页，把它填进 cursor 再查。',
      inputSchema: object({
        query: described('要找的文字'),
        scope: described('global，或者一个项目编号'),
        role_id: described('只看不限职能的和这个职能的'),
        kind: { type: 'string', enum: [...KNOWLEDGE_KINDS], description: 'knowledge 只查知识，skill 只查技能；不填两种都查' },
        include_retired: { type: 'boolean', description: '连已退役的一起查' },
        cursor: described('上一页给的 next_cursor'),
        limit: { type: 'integer', description: '每页几条，默认 20，最多 100' },
      }, ['query', 'scope']),
      run({ query, scope, role_id, kind, include_retired, cursor, limit }) {
        const page = ledger.searchLibrary({ query, scope: requireScope(scope), roleId: role_id ?? null, kind: (kind as KnowledgeKind | undefined) ?? null, includeRetired: include_retired === true, cursor: cursor ?? null, ...(limit === undefined ? {} : { limit }) });
        if (page.total === 0) return `${NOT_FOUND_IN_SCOPE}：在 ${scope === 'global' ? '全局' : `项目 ${scope}`} 里没有和“${query}”相关的条目`;
        return json({
          total: page.total,
          items: page.items.map((entry) => ({ ...listed(entry), state: entry.state })),
          next_cursor: page.next,
        });
      },
    },
    {
      name: 'read_library',
      grant: 'read',
      description: '读一条知识或技能的一个修订：不填 revision 读现在的修订。返回正文、作用域、它是谁提议谁批准的，以及支撑这一修订的证据。',
      inputSchema: object({ id: described('条目编号'), revision: { type: 'integer', description: '修订号；不填读现在的' } }, ['id']),
      run({ id, revision }) {
        if (isDirectorySkillId(id)) {
          const dirEntry = ledger.getDirectorySkillEntry(id);
          if (!dirEntry) throw new InputError(`没有这个条目：${String(id)}`);
          if (revision !== undefined && revision !== dirEntry.revision) {
            throw new InputError(`条目 ${String(id)} 没有修订 ${String(revision)}：现在是修订 ${dirEntry.revision}`);
          }
          return json({
            ...view(dirEntry),
            state: 'active',
            origin: 'directory',
            current_revision: dirEntry.revision,
            revisions: [{ revision: dirEntry.revision, published_at: dirEntry.published_at }],
            proposed_by: 'skills 目录',
            published_by: 'skills 目录',
            published_at: dirEntry.published_at,
            reviewed: true,
            evidence: [],
          });
        }
        const entry = ledger.getEntry(id);
        if (!entry) throw new InputError(`没有这个条目：${String(id)}`);
        const read = ledger.readRevision(id, revision);
        if (!read) throw new InputError(`条目 ${String(id)} 没有修订 ${String(revision)}：现在是修订 ${entry.revision}`);
        const proposal = ledger.getProposal(read.proposal_id);
        return json({
          ...view(read),
          state: entry.state,
          current_revision: entry.revision,
          ...(entry.state === 'retired' ? { retired: { at: entry.retired_at, reason: entry.retired_reason, replaced_by: entry.replaced_by } } : {}),
          revisions: ledger.revisionsOf(id).map(({ revision: each, published_at }) => ({ revision: each, published_at })),
          proposed_by: proposal.proposed_by,
          published_by: read.published_by,
          published_at: read.published_at,
          reviewed: read.reviewed_at !== null,
          evidence: proposal.evidence.map(({ source, ref, location, excerpt, captured_at, verified }) => ({ source, ref, location, excerpt, captured_at, verified })),
        });
      },
    },
    {
      name: 'propose_learning',
      grant: 'propose',
      description: PROPOSE_DESCRIPTION,
      inputSchema: object({
        kind: { type: 'string', enum: [...KNOWLEDGE_KINDS], description: 'knowledge 知识（默认）或 skill 技能' },
        inputs: { type: 'array', items: INPUT, description: '可选：涉及的现有条目与去向' },
        outputs: { type: 'array', items: OUTPUT, description: '可选：要新建或修订的条目' },
        why: WHY,
        evidence: { type: 'array', items: EVIDENCE, description: '可选：支撑证据列表' },
        request_id: described('可选：幂等请求编号'),
      }),
      run(args, { ctx, proposer }) {
        const { id, duplicate } = ledger.propose(args, proposer, ctx);
        const proposal = ledger.getProposal(id);
        const note = duplicate
          ? '这个 request_id 已经交过，返回的是第一次建的那份'
          : proposal.state === 'awaiting_owner'
            ? '全局常驻条目，等待主人确认后生效'
            : proposal.state === 'published'
              ? '已生效（未审阅，主人可在控制台查看或退役）'
              : '';
        return json({
          proposal_id: id,
          state: proposal.state,
          duplicate,
          // A knowledge token can submit evidence; it cannot query facts about raw tasks.
          ...(proposer.source === 'mcp' ? {} : { evidence: proposal.evidence.map(({ seq, verified }) => ({ seq, verified })) }),
          ...(note === '' ? {} : { note }),
        });
      },
    },
  ];
}

// One call, checked against the schema and the caller's grants. A refusal is an answer:
// the caller reads the ledger's own words.
export function callLibrary(tools: readonly LibraryTool[], name: unknown, args: unknown, caller: Caller, grants: readonly Grant[]): ToolResult {
  const refused = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
  const tool = tools.find((each) => each.name === name);
  if (!tool) return refused(`没有这个工具：${String(name)}`);
  if (!grants.includes(tool.grant)) return refused(`这个令牌没有${tool.grant === 'read' ? '读取' : '提议'}的授权`);
  const invalid = problem(tool.inputSchema, args ?? {}, 'arguments');
  if (invalid) return refused(invalid);
  try {
    return { content: [{ type: 'text', text: tool.run((args ?? {}) as Args, { ...caller, grants }) }] };
  } catch (err) {
    if (err instanceof InputError || err instanceof DegradedError) return refused(err.message);
    throw err;
  }
}
