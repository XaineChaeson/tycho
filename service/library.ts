// The four tools that read and propose knowledge (docs/design/knowledge-and-skills.md §4.2,
// §4.3): one implementation for the Router and for the knowledge MCP. Reading and proposing
// are separate grants; nothing here publishes, and nothing reads a file or fetches a link a
// caller names — evidence is the excerpt it hands over.
import { citation, DISPOSITIONS, EVIDENCE_SOURCES, KNOWLEDGE_KINDS, LOADINGS, NOT_FOUND_IN_SCOPE, type Grant, type KnowledgeKind } from '../shared/knowledge.ts';
import { parseWikiCitation, wikiCitation } from '../shared/wiki.ts';
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

type LibraryLedger = Pick<Ledger, 'applicable' | 'getProject' | 'getRole' | 'searchLibrary' | 'readRevision' | 'getEntry' | 'getDirectorySkillEntry' | 'revisionsOf' | 'getProposal' | 'propose'> & Partial<Pick<Ledger, 'hostVersionState' | 'wiki' | 'collaboration'>>;

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
  search_phrases: { type: 'array', items: STRING, description: '可选：最多 3 条近义检索短语，仅用于 FTS5 词法索引，不改变正文' },
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
        const wikiVaults = ledger.wiki?.listProjectVaults(project.id) ?? [];
        const crossRefs = ledger.collaboration?.listCrossProjectRefs({ projectId: project.id, direction: 'incoming' }) ?? [];
        return json({
          project: { id: project.id, name: project.name },
          role_id: role_id ?? null,
          ...(hostVersion ? { host_version: hostVersion.current } : {}),
          revision_set: revisionSet(entries),
          global: knowledge.filter(({ project_ids: of }) => of === null).map((e) => contextOf(e, hostVersion)),
          project_knowledge: knowledge.filter(({ project_ids: of }) => of !== null).map((e) => contextOf(e, hostVersion)),
          skills: entries.filter(({ kind }) => kind === 'skill').map((e) => contextOf(e, hostVersion)),
          ...(wikiVaults.length > 0 ? {
            wiki_vaults: wikiVaults.map((v) => ({
              id: v.id,
              name: v.name,
              description: v.description,
              commit: v.effective_commit,
              page_count: v.page_count,
              can_propose: v.grant.can_propose,
            })),
          } : {}),
          ...(crossRefs.length > 0 ? {
            cross_project_refs: crossRefs.map((ref) => ({
              id: ref.id,
              source_project_id: ref.source_project_id,
              ref_kind: ref.ref_kind,
              pinned_version: ref.pinned_version,
              title: ref.title,
              summary: ref.summary,
              content_sha256: ref.content_sha256,
            })),
          } : {}),
          ...(entries.length === 0 && wikiVaults.length === 0 ? { note: `${NOT_FOUND_IN_SCOPE}：这个项目和职能现在没有适用的知识和技能` } : {}),
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
        include_wiki: { type: 'boolean', description: '是否同时检索本项目已授权的 Git LLM Wiki（默认 true）' },
        exclude_ids: { type: 'array', items: STRING, description: '可选：当前会话快照已包含的条目编号（去重抑制）' },
        cursor: described('上一页给的 next_cursor'),
        limit: { type: 'integer', description: '每页几条，默认 20，最多 100' },
      }, ['query', 'scope']),
      run({ query, scope, role_id, kind, include_retired, include_wiki, exclude_ids, cursor, limit }) {
        const resolvedScope = requireScope(scope);
        const page = ledger.searchLibrary({
          query,
          scope: resolvedScope,
          roleId: role_id ?? null,
          kind: (kind as KnowledgeKind | undefined) ?? null,
          includeRetired: include_retired === true,
          cursor: cursor ?? null,
          ...(Array.isArray(exclude_ids) ? { excludeIds: exclude_ids as string[] } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
        const wikiHits = (resolvedScope !== 'global' && include_wiki !== false && (!kind || kind === 'knowledge') && !cursor)
          ? (ledger.wiki?.searchPages({ query, projectId: resolvedScope.projectId, limit: Math.min(limit ?? 10, 15) }) ?? [])
          : [];
        if (page.total === 0 && wikiHits.length === 0) return `${NOT_FOUND_IN_SCOPE}：在 ${scope === 'global' ? '全局' : `项目 ${scope}`} 里没有和“${query}”相关的条目`;
        return json({
          total: page.total,
          items: page.items.map((entry) => ({ ...listed(entry), state: entry.state })),
          ...(wikiHits.length > 0 ? {
            wiki_items: wikiHits.map((hit) => ({
              cite: wikiCitation(hit.vault_id, hit.page_id, hit.commit_sha),
              vault_id: hit.vault_id,
              vault_name: hit.vault_name,
              page_id: hit.page_id,
              path: hit.path,
              title: hit.title,
              summary: hit.summary,
              owner: hit.owner,
              scope: hit.scope,
              status: hit.status,
              commit: hit.commit_sha,
            })),
          } : {}),
          next_cursor: page.next,
        });
      },
    },
    {
      name: 'read_library',
      grant: 'read',
      description: '读一条知识、技能的一个修订，或一篇已授权 Git LLM Wiki 页面（id 填 wiki:<vault_id>/<page_id>[@commit]）：不填 revision 读现在的修订。返回正文、作用域、来源和证据。',
      inputSchema: object({ id: described('条目编号，或 wiki:<vault_id>/<page_id>[@commit]'), revision: { type: 'integer', description: '修订号；不填读现在的' }, project_id: described('可选：读取 Wiki 时指定当前项目以核对授权与钉死提交') }, ['id']),
      run({ id, revision, project_id }, { proposer }) {
        const wikiRef = parseWikiCitation(id);
        if (wikiRef) {
          if (!ledger.wiki) throw new InputError('Wiki 知识库未启用');
          const effectiveProjectId = typeof project_id === 'string' && project_id.trim() !== ''
            ? project_id.trim()
            : proposer.projectId;
          const page = ledger.wiki.readPage(wikiRef.vaultId, wikiRef.pageId, {
            ...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
            ...(wikiRef.commit ? { commit: wikiRef.commit } : {}),
          });
          return json({
            cite: wikiCitation(page.vault_id, page.page_id, page.commit_sha),
            origin: 'wiki',
            vault_id: page.vault_id,
            vault_name: page.vault_name,
            page_id: page.page_id,
            path: page.path,
            title: page.title,
            summary: page.summary,
            body: page.body,
            owner: page.owner,
            scope: page.scope,
            status: page.status,
            sources: page.sources,
            links: page.links,
            backlinks: page.backlinks,
            locked_sections: page.locked_sections.length,
            commit: page.commit_sha,
            mutation_version: page.mutation_version,
          });
        }
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
    ...(ledger?.wiki ? [{
      name: 'propose_wiki_update',
      grant: 'propose' as const,
      description: '向已授权的 Git LLM Wiki 提交页面修订提议（不直接改写已发布分支）。强制校验 base_commit / base_mutation_version（防并发覆盖）并硬性保护人类锁定区块（## My Notes / <!-- tycho:human-locked -->）。',
      inputSchema: object({
        vault_id: described('Wiki 知识库编号'),
        project_id: described('提交所属项目编号（核对提议授权）'),
        path: described('仓库内相对 Markdown 路径，例如 topics/dmob-10.md'),
        new_content: described('完整的修订后 Markdown 正文（含 frontmatter 与所有人类锁定区块原文）'),
        rationale: described('修订理由与引用证据'),
        base_commit: described('可选：读取页面时的提交号（用于 CAS 校验）'),
        base_mutation_version: { type: 'integer', description: '可选：读取页面时的 mutation_version（用于 CAS 校验）' },
      }, ['vault_id', 'path', 'new_content']),
      run(args: Args, { ctx, proposer }: Caller) {
        const projectId = typeof args.project_id === 'string' && args.project_id.trim() !== ''
          ? args.project_id.trim()
          : (proposer.projectId ?? null);
        const proposal = ledger.wiki!.proposeUpdate({
          vault_id: args.vault_id,
          project_id: projectId,
          path: args.path,
          new_content: args.new_content,
          rationale: args.rationale,
          base_commit: args.base_commit,
          base_mutation_version: args.base_mutation_version,
          proposed_by: proposer.by,
          source: proposer.source,
        }, ctx);
        return json({
          proposal_id: proposal.id,
          status: proposal.status,
          branch_name: proposal.branch_name,
          base_commit: proposal.base_commit,
          base_mutation_version: proposal.base_mutation_version,
          note: 'Wiki 修订提议已入账，等待主人在控制台审核并合入发布分支',
        });
      },
    }] : []),
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
