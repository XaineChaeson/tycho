// Deterministic task execution facts ("执行病历") and the knowledge proposal draft synthesized
// from them. Shared by the service extractor and the console card.
import type { EvidenceSource, KnowledgeKind, Loading } from './knowledge.ts';

export interface PingPongFact {
  kind: 'rejection' | 'rework' | 'escalation';
  timestamp: string;
  run_id?: string;
  summary: string;
}

export interface ToolRepeatFact {
  run_id: string;
  name: string;
  normalized_title: string;
  count: number;
  error_count: number;
  consecutive_errors: number;
}

export interface ErrorFact {
  signature: string;
  sample: string;
  count: number;
  first_run_id: string;
  first_at: string;
}

export interface KnowledgeProposalDraftOutput {
  title: string;
  when_to_use: string;
  body: string;
  project_ids: string[] | null;
  loading: Loading;
  roles: string[];
}

export interface KnowledgeProposalDraftWhy {
  when: string;
  changes: string;
  generalizes: string;
}

export interface KnowledgeProposalDraftEvidence {
  source: Exclude<EvidenceSource, 'record'>;
  ref: string | null;
  location: string;
  excerpt: string;
  captured_at?: string | null;
}

// Matches `ProposalInput` in `service/knowledge.ts` and `POST /api/knowledge/proposals` directly.
export interface KnowledgeProposalDraft {
  kind: KnowledgeKind;
  inputs: [];
  outputs: KnowledgeProposalDraftOutput[];
  why: KnowledgeProposalDraftWhy;
  evidence: KnowledgeProposalDraftEvidence[];
  request_id?: string;
}

export interface TaskRunFactsCoverage {
  loaded_runs: number;
  incomplete_runs: number;
  reasons: string[];
}

export interface TaskRunFacts {
  task_id: string;
  project_id: string | null;
  analyzed_runs: number;
  failed_rounds: number;
  escalations: number;
  noteworthy: boolean;
  noteworthy_reasons: string[];
  ping_pong: PingPongFact[];
  tool_repeats: ToolRepeatFact[];
  error_facts: ErrorFact[];
  proposal_draft: KnowledgeProposalDraft | null;
  coverage?: TaskRunFactsCoverage;
}
