// Versioned streaming JSONL export & import for Tycho knowledge & skills (adapted from
// Octop Memory ADR-009): enables safe backup, host migration, and dry-run diff preview.
import type { Ctx } from './db.ts';
import { InputError } from './errors.ts';
import type { Entry, Knowledge, Proposer } from './knowledge.ts';
import { SCHEMA_VERSION } from './db.ts';

export const KNOWLEDGE_JSONL_FORMAT = 'tycho-knowledge-jsonl';
export const KNOWLEDGE_JSONL_VERSION = 1;

export interface KnowledgeJsonlHeader {
  type: 'header';
  format: typeof KNOWLEDGE_JSONL_FORMAT;
  version: typeof KNOWLEDGE_JSONL_VERSION;
  exported_at: string;
  ledger_version: number;
  entry_count: number;
}

export interface KnowledgeJsonlRecord {
  type: 'entry';
  id: string;
  kind: Entry['kind'];
  revision: number;
  state: Entry['state'];
  title: string;
  when_to_use: string;
  body: string;
  project_ids: string[] | null;
  loading: Entry['loading'];
  roles: string[];
  search_phrases: string[];
  published_at: string;
  reviewed_at: string | null;
  retired_reason: string | null;
}

export interface KnowledgeImportItemReport {
  line: number;
  source_id: string;
  title: string;
  action: 'create' | 'skip_duplicate' | 'invalid';
  reason?: string;
  created_id?: string;
}

export interface KnowledgeImportReport {
  dry_run: boolean;
  total: number;
  created: number;
  skipped: number;
  invalid: number;
  items: KnowledgeImportItemReport[];
}

export function exportKnowledgeJsonl(
  knowledge: Pick<Knowledge, 'listEntries'>,
  options: { includeRetired?: boolean } = {},
): string {
  const entries = knowledge.listEntries({ includeRetired: options.includeRetired === true });
  const header: KnowledgeJsonlHeader = {
    type: 'header',
    format: KNOWLEDGE_JSONL_FORMAT,
    version: KNOWLEDGE_JSONL_VERSION,
    exported_at: new Date().toISOString(),
    ledger_version: SCHEMA_VERSION,
    entry_count: entries.length,
  };
  const lines: string[] = [JSON.stringify(header)];
  for (const entry of entries) {
    const rec: KnowledgeJsonlRecord = {
      type: 'entry',
      id: entry.id,
      kind: entry.kind,
      revision: entry.revision,
      state: entry.state,
      title: entry.title,
      when_to_use: entry.when_to_use,
      body: entry.body,
      project_ids: entry.project_ids,
      loading: entry.loading,
      roles: entry.roles,
      search_phrases: entry.search_phrases ?? [],
      published_at: entry.published_at,
      reviewed_at: entry.reviewed_at,
      retired_reason: entry.retired_reason,
    };
    lines.push(JSON.stringify(rec));
  }
  return `${lines.join('\n')}\n`;
}

export function importKnowledgeJsonl(
  knowledge: Pick<Knowledge, 'listEntries' | 'propose' | 'checkProposal'>,
  jsonl: string,
  options: {
    dryRun?: boolean;
    targetProjectIds?: string[] | null;
    proposer?: Proposer;
    ctx: Ctx;
  },
): KnowledgeImportReport {
  const dryRun = options.dryRun === true;
  const rawLines = jsonl.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rawLines.length === 0) throw new InputError('JSONL 内容为空');

  let headerParsed: unknown;
  try {
    headerParsed = JSON.parse(rawLines[0]!);
  } catch {
    throw new InputError('第 1 行不是合法的 JSON 头');
  }
  const header = headerParsed as Partial<KnowledgeJsonlHeader>;
  if (header.type !== 'header' || header.format !== KNOWLEDGE_JSONL_FORMAT || header.version !== KNOWLEDGE_JSONL_VERSION) {
    throw new InputError(`不支持的导入头：期望 format=${KNOWLEDGE_JSONL_FORMAT}, version=${KNOWLEDGE_JSONL_VERSION}`);
  }

  const existing = knowledge.listEntries({ includeRetired: false });
  const existingKeys = new Set(
    existing.map((e) => `${e.kind}|${e.title.trim().toLowerCase()}|${e.body.trim().toLowerCase()}`),
  );
  const proposer: Proposer = options.proposer ?? {
    source: 'console',
    by: options.ctx.actor,
    client: 'console-import',
    writers: [],
  };

  const items: KnowledgeImportItemReport[] = [];
  let created = 0;
  let skipped = 0;
  let invalid = 0;

  for (let i = 1; i < rawLines.length; i += 1) {
    const lineNo = i + 1;
    let parsed: Partial<KnowledgeJsonlRecord>;
    try {
      parsed = JSON.parse(rawLines[i]!) as Partial<KnowledgeJsonlRecord>;
    } catch {
      invalid += 1;
      items.push({ line: lineNo, source_id: '', title: '', action: 'invalid', reason: 'JSON 解析失败' });
      continue;
    }
    if (parsed.type !== 'entry') continue;
    const sourceId = typeof parsed.id === 'string' ? parsed.id : '';
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
    const kind = parsed.kind === 'skill' ? 'skill' : 'knowledge';
    if (!title || !body) {
      invalid += 1;
      items.push({ line: lineNo, source_id: sourceId, title, action: 'invalid', reason: '缺少 title 或 body' });
      continue;
    }
    if (parsed.state === 'retired') {
      skipped += 1;
      items.push({ line: lineNo, source_id: sourceId, title, action: 'skip_duplicate', reason: '已退役条目不重新导入' });
      continue;
    }
    const dedupKey = `${kind}|${title.toLowerCase()}|${body.toLowerCase()}`;
    if (existingKeys.has(dedupKey)) {
      skipped += 1;
      items.push({ line: lineNo, source_id: sourceId, title, action: 'skip_duplicate', reason: '已存在相同标题和正文的活跃条目' });
      continue;
    }

    const projectIds = options.targetProjectIds !== undefined
      ? options.targetProjectIds
      : (Array.isArray(parsed.project_ids) ? parsed.project_ids : null);

    const proposalInput = {
      kind,
      outputs: [{
        title,
        when_to_use: typeof parsed.when_to_use === 'string' ? parsed.when_to_use : '',
        body,
        project_ids: projectIds,
        loading: kind === 'skill' ? 'on_demand' : (parsed.loading === 'resident' ? 'resident' : 'on_demand'),
        roles: Array.isArray(parsed.roles) ? parsed.roles : [],
        search_phrases: Array.isArray(parsed.search_phrases) ? parsed.search_phrases : [],
      }],
      why: { when: 'JSONL 导入迁移', changes: '从版本化备份恢复知识条目', generalizes: '' },
      evidence: [{
        source: 'file',
        ref: sourceId || null,
        location: `jsonl:line:${lineNo}`,
        excerpt: `Imported from ${KNOWLEDGE_JSONL_FORMAT} v${KNOWLEDGE_JSONL_VERSION} (${sourceId || 'unnamed'})`,
      }],
    };

    try {
      if (dryRun) {
        knowledge.checkProposal(proposalInput, proposer);
        created += 1;
        existingKeys.add(dedupKey);
        items.push({ line: lineNo, source_id: sourceId, title, action: 'create' });
      } else {
        const res = knowledge.propose(proposalInput, proposer, options.ctx);
        created += 1;
        existingKeys.add(dedupKey);
        items.push({ line: lineNo, source_id: sourceId, title, action: 'create', created_id: res.id });
      }
    } catch (err) {
      invalid += 1;
      items.push({
        line: lineNo,
        source_id: sourceId,
        title,
        action: 'invalid',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    dry_run: dryRun,
    total: items.length,
    created,
    skipped,
    invalid,
    items,
  };
}
