// What the knowledge tests share: a change in the shape every entrance takes, the proposers
// they come from, and settling a curation/knowledge round.
import type { Ctx } from '../service/db.ts';
import type { Proposer, ProposalInput } from '../service/knowledge.ts';
import type { Ledger } from '../service/ledger.ts';
import type { Account } from '../runner/snapshot.ts';
import { content, type Fixture } from './helpers.ts';

export const OWNER: Ctx = { actor: 'console' };
export const MCP: Proposer = { source: 'mcp', by: '外部会话', client: 'mcp:c1', writers: ['codex'] };
export const OWNER_SAYS: Proposer = { source: 'console', by: 'console', client: 'console', writers: [] };
export const WHY = { when: '要转方向时', changes: '先分解差距再决定', generalizes: '三次反例，边界是性能类问题' };
export const EVIDENCE = [{ source: 'conversation', ref: 'TY 会话', location: 'jsonl L12607', excerpt: '原型收益不到 20% 就放弃' }];
// An account a knowledge curation task can run on: the analysis role runs on the decide tier.
export const GATE: Account = { id: 'g1', name: 'g1', executor: 'claude', tiers: { decide: content('{"model":"m"}') } };
export const PASS = { result: 'pass', reason: '证据撑得住' };

export const output = (fields: Record<string, unknown> = {}) => ({
  title: '先分解差距', when_to_use: '要放弃一条路时', body: '把总差距拆成能乘回去的因子。', project_ids: null, loading: 'on_demand', ...fields,
});
export const create = (fields: Record<string, unknown> = {}, extra: Partial<ProposalInput> = {}): ProposalInput => ({ outputs: [output(fields)], why: WHY, evidence: EVIDENCE, ...extra });

// A running knowledge task round settled with this verdict.
export function settleGate(f: Fixture, run: { id: string; task_id: string }, verdict: unknown, ledger: Ledger = f.ledger) {
  // A knowledge task round has no code: its machine reports so (node/code-check.ts).
  const result = ledger.settleRun(run.id, 0, { status: 'done', summary: '把关', artifacts: [{ kind: 'report', ref: '最后一条消息' }], knowledge_verdict: verdict }, { codeCheck: { result: 'no-code' } });
  return { run, task: f.task(run.task_id), result };
}

// An entry in force as the owner made it: reviewed.
export function ownerEntry(f: Fixture, fields: Record<string, unknown> = {}): string {
  f.ledger.propose(create(fields), OWNER_SAYS, OWNER);
  return f.ledger.listEntries({ includeRetired: true }).at(-1)!.id;
}
