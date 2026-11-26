// Knowledge owns the portable publication graph, including every authorized historical revision.
import { createHash } from 'node:crypto';
import { EVIDENCE_SOURCES } from '../shared/knowledge.ts';
import type { Db } from './db.ts';
import { InputError } from './errors.ts';
export type HandoffRow = Record<string, string | number | null>;
export const KNOWLEDGE_TABLES = ['knowledge', 'knowledge_proposal', 'knowledge_revision', 'knowledge_evidence'] as const;
export type KnowledgeRows = Record<typeof KNOWLEDGE_TABLES[number], HandoffRow[]>;

type Change = {
  inputs?: { knowledge_id: string; revision: number; replaced_by?: string }[];
  outputs?: { key: string; revises: string | null; project_ids: string[] | null }[];
};
const fail = (text: string): never => { throw new InputError('知识移交闭包：' + text); };
const decoded = <T>(row: HandoffRow, key: string): T => JSON.parse(String(row[key])) as T;
const changesOf = (row: HandoffRow): Change[] => ['change_json', 'final_json'].flatMap(key => row[key] === null ? [] : [decoded<Change>(row, key)]);
const references = (row: HandoffRow, fields: readonly string[]): string[] => fields.flatMap(key => row[key] === null ? [] : [String(row[key])]);
const proposalLinks = ['amended_from', 'next_id', 'prior_rejection_id'] as const;
const headProposalLinks = ['retired_proposal_id'] as const;

function scopeFits(value: unknown, project: string, historical: boolean): boolean {
  return (historical && value === null) || (Array.isArray(value) && value.length === 1 && value[0] === project);
}
type Root = { id: string; revision: number };
type Support = { tasks: readonly HandoffRow[]; runs: readonly HandoffRow[]; changes: readonly HandoffRow[]; calls: readonly HandoffRow[] };

// Only the knowledge owner derives the auxiliary task set, from proposal facts.
function gateTasks(rows: KnowledgeRows, project: string, support: Support): Map<string, HandoffRow> {
  const tasks = new Map(support.tasks.map(row => [row.id, row]));
  const runs = new Map(support.runs.map(row => [row.id, row]));
  const gates = new Map<string, HandoffRow>();
  for (const proposal of rows.knowledge_proposal) {
    if (['gating', 'awaiting_owner'].includes(String(proposal.state))) fail(`提议尚未终结：${proposal.id}`);
    if (proposal.source === 'worker') {
      const task = tasks.get(proposal.task_id), run = runs.get(proposal.run_id);
      if (!task || !run || task.project_id !== project || run.task_id !== task.id) fail(`Worker 来源无法核实：${proposal.id} task=${proposal.task_id} run=${proposal.run_id}`);
    } else if (proposal.source === 'router') {
      const origins = support.changes.filter(row => row.action === 'knowledge.propose' && decoded<{ proposal_id?: string }>(row, 'detail_json').proposal_id === proposal.id);
      if (!origins.length || origins.some(row => !support.calls.some(call => call.id === row.tool_call_id && call.project_id === project))) fail(`Router 来源无法核实：${proposal.id}`);
    } else if (proposal.source !== 'console') fail(`尚未支持服务级知识把关来源：${proposal.id} source=${proposal.source}`);
    if (proposal.source === 'console' && proposal.gate_task_id !== null) fail(`Console 提议的把关来源必须为空：${proposal.id} gate=${proposal.gate_task_id}`);
    if (proposal.gate_task_id === null) continue;
    const task = tasks.get(proposal.gate_task_id);
    if (!task || task.project_id !== null || !['done', 'abandoned'].includes(String(task.state))) fail(`把关来源的任务未终结或缺失：${proposal.id} gate=${proposal.gate_task_id}`);
    const job = task!.knowledge_json === null ? null : decoded<{ kind: string; proposal_id: string }>(task!, 'knowledge_json');
    if (job?.kind !== 'gate' || job.proposal_id !== proposal.id || gates.has(String(task!.id))) fail(`把关绑定不一致：${proposal.id} gate=${task!.id}`);
    if (['parent_id', 'review_of_json', 'landing_json', 'trigger_fire_id'].some(key => task![key] !== null)) fail(`把关任务含未支持的工作依赖：${task!.id}`);
    const gateRuns = support.runs.filter(run => run.task_id === task!.id);
    if (gateRuns.some(run => run.state !== 'ended')) fail(`把关轮次尚未结束：${task!.id}`);
    if (proposal.gate_json !== null) {
      const verdict = decoded<{ task_id: string; run_id: string }>(proposal, 'gate_json');
      if (verdict.task_id !== task!.id || !gateRuns.some(run => run.id === verdict.run_id)) fail(`把关结论引用不一致：${proposal.id}`);
    }
    gates.set(String(task!.id), proposal);
  }
  return gates;
}

function snapshotRoots(runs: readonly HandoffRow[], gates: ReadonlyMap<string, HandoffRow> = new Map(), project?: string, evidenceRefs?: { tasks: ReadonlySet<unknown>; runs: ReadonlySet<unknown>; messages: ReadonlySet<unknown> }): Root[] {
  return runs.flatMap(run => {
    const snapshot = decoded<{ skills?: unknown[]; knowledge?: Root[]; knowledge_task?: { kind: string; files: { path: string; text: string }[] } }>(run, 'snapshot_json');
    if (snapshot.skills?.length) fail(`旧本机技能材料尚未支持：${run.id}`);
    if (snapshot.knowledge !== undefined && !Array.isArray(snapshot.knowledge)) fail(`冻结知识清单无效：${run.id}`);
    const roots = [...(snapshot.knowledge ?? [])];
    if (gates.has(String(run.task_id)) || Object.hasOwn(snapshot, 'knowledge_task')) {
      const proposal = gates.get(String(run.task_id)), material = snapshot.knowledge_task;
      if (!material) return fail(`把关来源缺少已知快照材料：${proposal?.id ?? '未知提议'}，轮次 ${run.id}`);
      if (!proposal || material.kind !== 'gate' || !Array.isArray(material.files)) fail(`服务级知识工作材料尚未支持：${run.id}`);
      const seen = new Set<string>();
      for (const file of material.files) {
        if (!file || typeof file.path !== 'string' || typeof file.text !== 'string' || seen.has(file.path)) fail(`把关材料结构无效：${run.id}`);
        seen.add(file.path);
        if (file.path === 'knowledge-task/proposal.json') {
          const frozen = JSON.parse(file.text) as { proposal_id: string; source: string; evidence: { source: string; ref: string | null }[]; change: Change; prior_rejection: { proposal_id: string; change: Change } | null };
          if (frozen.proposal_id !== proposal!.id || frozen.source !== proposal!.source || JSON.stringify(frozen.change) !== JSON.stringify(decoded(proposal!, 'change_json'))) fail(`把关快照提议不一致：${run.id}`);
          for (const change of [frozen.change, ...(frozen.prior_rejection ? [frozen.prior_rejection.change] : [])]) {
            if (!Array.isArray(change.inputs) || !Array.isArray(change.outputs)) fail(`把关快照变更无效：${run.id}`);
            for (const input of change.inputs ?? []) roots.push({ id: input.knowledge_id, revision: input.revision });
            if (project !== undefined && change.outputs?.some(output => !scopeFits(output.project_ids, project, true))) fail(`把关快照输出涉及其他项目：${run.id}`);
          }
          if (!Array.isArray(frozen.evidence)) fail(`把关快照证据结构无效：${run.id}`);
          if (evidenceRefs) for (const evidence of frozen.evidence) {
            const ids = evidence.source === 'task' ? evidenceRefs.tasks : evidence.source === 'run' ? evidenceRefs.runs : evidence.source === 'owner' ? evidenceRefs.messages : undefined;
            if (evidence.source === 'record' || evidence.ref !== null && ids && !ids.has(evidence.ref)) fail(`把关快照证据超出闭包：${run.id}`);
          }
          if ((frozen.prior_rejection?.proposal_id ?? null) !== proposal!.prior_rejection_id) fail(`把关快照前序提议不一致：${run.id}`);
        } else {
          const match = /^knowledge-task\/entries\/([0-7][0-9A-HJKMNP-TV-Z]{25})@([1-9][0-9]*)\.md$/.exec(file.path);
          if (!match || !Number.isSafeInteger(Number(match[2]))) fail(`未知把关材料：${run.id} ${file.path}`);
          roots.push({ id: match![1]!, revision: Number(match![2]) });
        }
      }
      if (!seen.has('knowledge-task/proposal.json')) fail(`缺少把关提议材料：${run.id}`);
    }
    return roots;
  });
}

// Called once at the wire boundary, or on a graph derived from the source ledger.
export function validatePortableKnowledge(rows: KnowledgeRows, project: string, tasks: readonly HandoffRow[], runs: readonly HandoffRow[], messages: readonly HandoffRow[], changes: readonly HandoffRow[] = [], calls: readonly HandoffRow[] = []): ReadonlySet<string> {
  const gates = gateTasks(rows, project, { tasks, runs, changes, calls });
  for (const task of tasks) {
    if (task.project_id === null && !gates.has(String(task.id))) fail(`服务级任务缺少本项目归属：${task.id}`);
    if (task.knowledge_json !== null && !gates.has(String(task.id))) fail(`未支持的知识工作任务：${task.id}`);
  }
  const heads = new Map(rows.knowledge.map(row => [row.id, row]));
  const proposals = new Map(rows.knowledge_proposal.map(row => [row.id, row]));
  const taskIds = new Set(tasks.map(row => row.id)), runIds = new Set(runs.map(row => row.id)), messageIds = new Set(messages.map(row => row.id));
  const versions = new Map<string, HandoffRow[]>();
  for (const revision of rows.knowledge_revision) {
    if (!heads.has(revision.knowledge_id) || !proposals.has(revision.proposal_id)) fail(`修订引用未闭合：${revision.knowledge_id}@${revision.revision}`);
    if (!scopeFits(decoded(revision, 'projects_json'), project, true)) fail(`历史修订涉及其他项目：${revision.knowledge_id}@${revision.revision}`);
    const key = String(revision.knowledge_id);
    versions.set(key, [...(versions.get(key) ?? []), revision]);
  }
  for (const head of rows.knowledge) {
    const history = (versions.get(String(head.id)) ?? []).sort((a, b) => Number(a.revision) - Number(b.revision));
    if (!Number.isSafeInteger(head.revision) || Number(head.revision) < 1 || history.length !== head.revision || history.some((revision, index) => revision.revision !== index + 1)) fail(`历史修订不完整：${head.id}`);
    if (!scopeFits(decoded(history.at(-1)!, 'projects_json'), project, false)) fail(`当前头不是仅本项目：${head.id}`);
    if (head.replaced_by !== null && !heads.has(head.replaced_by)) fail(`包外替代知识：${head.id} → ${head.replaced_by}`);
    for (const id of references(head, headProposalLinks)) if (!proposals.has(id)) fail(`包外退役提议：${head.id} → ${id}`);
  }
  for (const proposal of rows.knowledge_proposal) {
    if (proposal.task_id !== null && !taskIds.has(proposal.task_id) || proposal.run_id !== null && !runIds.has(proposal.run_id)) fail(`包外提议来源：${proposal.id}`);
    for (const id of references(proposal, proposalLinks)) if (!proposals.has(id)) fail(`包外提议依赖：${proposal.id} → ${id}`);
    for (const change of changesOf(proposal)) {
      if (!Array.isArray(change.inputs) || !Array.isArray(change.outputs)) fail(`提议结构无效：${proposal.id}`);
      for (const input of change.inputs ?? []) {
        if (!heads.has(input.knowledge_id) || !versions.get(input.knowledge_id)?.some(revision => revision.revision === input.revision)) fail(`包外知识输入：${proposal.id} → ${input.knowledge_id}@${input.revision}`);
        if (input.replaced_by && !heads.has(input.replaced_by) && !change.outputs?.some(output => output.key === input.replaced_by)) fail(`包外替代输入：${proposal.id}`);
      }
      for (const output of change.outputs ?? []) {
        if (!scopeFits(output.project_ids, project, true)) fail(`跨范围提议输出：${proposal.id}`);
        if (output.revises && !heads.has(output.revises)) fail(`包外修订输出：${proposal.id} → ${output.revises}`);
      }
    }
  }
  for (const evidence of rows.knowledge_evidence) {
    if (!proposals.has(evidence.proposal_id)) fail(`孤立证据：${evidence.id}`);
    const inScope = evidence.ref === null || evidence.source === 'task' ? evidence.ref === null || taskIds.has(evidence.ref)
      : evidence.source === 'run' ? runIds.has(evidence.ref) : evidence.source === 'owner' ? messageIds.has(evidence.ref) : evidence.source !== 'record';
    if (!inScope) fail(`证据超出项目闭包：${evidence.id}`);
    if (typeof evidence.excerpt !== 'string' || evidence.sha256 !== createHash('sha256').update(String(evidence.excerpt)).digest('hex') || ![0, 1].includes(Number(evidence.verified)) || !(EVIDENCE_SOURCES as readonly unknown[]).includes(evidence.source)) fail(`证据无效：${evidence.id}`);
  }
  for (const root of snapshotRoots(runs, gates, project, { tasks: taskIds, runs: runIds, messages: messageIds })) if (!heads.has(root.id) || !versions.get(root.id)?.some(revision => revision.revision === root.revision)) fail(`缺少冻结修订：${root.id}@${root.revision}`);
  return new Set(gates.keys());
}

// Follow only structured ledger references. No scope rewriting or external evidence fetches.
export function collectPortableKnowledge(db: Db, project: string, tasks: readonly HandoffRow[], runs: readonly HandoffRow[], messages: readonly HandoffRow[]): { rows: KnowledgeRows; gateIds: readonly string[] } {
  const allHeads = db.all<HandoffRow>('SELECT * FROM knowledge ORDER BY id');
  const allVersions = db.all<HandoffRow>('SELECT * FROM knowledge_revision ORDER BY knowledge_id, revision');
  const allProposals = db.all<HandoffRow>('SELECT * FROM knowledge_proposal ORDER BY id');
  const allEvidence = db.all<HandoffRow>('SELECT * FROM knowledge_evidence ORDER BY proposal_id, seq');
  const heads = new Map(allHeads.map(row => [String(row.id), row])), proposals = new Map(allProposals.map(row => [String(row.id), row]));
  const selectedHeads = new Set<string>(), selectedProposals = new Set<string>(), selectedGates = new Map<string, HandoffRow>();
  const pendingHeads: string[] = [], pendingProposals: string[] = [];
  const addHead = (id: string): void => { if (!selectedHeads.has(id)) { selectedHeads.add(id); pendingHeads.push(id); } };
  const addProposal = (id: string): void => { if (!selectedProposals.has(id)) { selectedProposals.add(id); pendingProposals.push(id); } };
  for (const head of allHeads) {
    const current = allVersions.find(revision => revision.knowledge_id === head.id && revision.revision === head.revision);
    const scope = current && decoded<unknown>(current, 'projects_json');
    if (Array.isArray(scope) && scope.includes(project)) addHead(String(head.id));
  }
  for (const root of snapshotRoots(runs)) addHead(root.id);
  while (pendingHeads.length || pendingProposals.length) {
    while (pendingHeads.length) {
      const id = pendingHeads.pop()!, head = heads.get(id);
      if (!head) fail(`缺少知识：${id}`);
      for (const revision of allVersions.filter(row => row.knowledge_id === id)) addProposal(String(revision.proposal_id));
      for (const proposal of references(head!, headProposalLinks)) addProposal(proposal);
      if (head!.replaced_by !== null) addHead(String(head!.replaced_by));
    }
    while (pendingProposals.length) {
      const id = pendingProposals.pop()!, proposal = proposals.get(id);
      if (!proposal) fail(`缺少提议：${id}`);
      if (proposal!.gate_task_id !== null) {
        const task = db.get<HandoffRow>('SELECT * FROM task WHERE id = ?', proposal!.gate_task_id);
        if (!task) fail(`缺少把关任务：${proposal!.gate_task_id}`);
        selectedGates.set(String(task!.id), proposal!);
        for (const root of snapshotRoots(db.all<HandoffRow>('SELECT * FROM run WHERE task_id = ? ORDER BY rowid', task!.id), selectedGates)) addHead(root.id);
      }
      for (const dependency of references(proposal!, proposalLinks)) addProposal(dependency);
      for (const revision of allVersions.filter(row => row.proposal_id === id)) addHead(String(revision.knowledge_id));
      for (const change of changesOf(proposal!)) {
        for (const input of change.inputs ?? []) {
          addHead(input.knowledge_id);
          if (input.replaced_by && !change.outputs?.some(output => output.key === input.replaced_by)) addHead(input.replaced_by);
        }
        for (const output of change.outputs ?? []) if (output.revises) addHead(output.revises);
      }
    }
  }
  const taskIds = new Set(tasks.map(row => row.id)), runIds = new Set(runs.map(row => row.id));
  for (const proposal of allProposals) {
    if (selectedProposals.has(String(proposal.id))) continue;
    const related = taskIds.has(proposal.task_id) || runIds.has(proposal.run_id)
      || changesOf(proposal).some(change => change.outputs?.some(output => output.project_ids?.includes(project)) || change.inputs?.some(input => selectedHeads.has(input.knowledge_id)))
      || allEvidence.some(evidence => evidence.proposal_id === proposal.id && (evidence.source === 'task' && taskIds.has(evidence.ref) || evidence.source === 'run' && runIds.has(evidence.ref)));
    if (related) fail(`项目关联提议尚未纳入可授权历史：${proposal.id} gate=${proposal.gate_task_id}`);
  }
  const rows: KnowledgeRows = {
    knowledge: allHeads.filter(row => selectedHeads.has(String(row.id))),
    knowledge_revision: allVersions.filter(row => selectedHeads.has(String(row.knowledge_id))),
    knowledge_proposal: allProposals.filter(row => selectedProposals.has(String(row.id))),
    knowledge_evidence: allEvidence.filter(row => selectedProposals.has(String(row.proposal_id))),
  };
  return { rows, gateIds: [...selectedGates.keys()] };
}


// This is the proposal owner's business identity, separate from the proposal's primary key.
// Match the database's non-null (client_id, request_id) unique key exactly, without rewriting it.
export function requireKnowledgeHandoffTargetReady(db: Db, rows: KnowledgeRows): void {
  for (const proposal of rows.knowledge_proposal) {
    if (proposal.request_id === null) continue;
    const existing = db.get<{ id: string }>('SELECT id FROM knowledge_proposal WHERE client_id = ? AND request_id = ?', proposal.client_id, proposal.request_id);
    if (existing) fail(`请求标识冲突：源提议 ${proposal.id} 与目标提议 ${existing.id} 使用同一客户端请求标识，当前目标不能接管。请保留交接材料并核对这两份提议，不要改写原标识绕过冲突。`);
  }
}
