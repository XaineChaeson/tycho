import type { RunReportInfo } from './report.ts';
export interface HistoricalKnowledge {
  id: string;
  revision: number;
  title: string;
}

export interface HistoricalCommit {
  value: string;
  source: 'reported' | 'observed' | 'remote' | 'pinned';
}

export interface HistoryEvidence {
  project_id: string;
  task_id: string;
  task_revision: number;
  run_id: string;
  ended_at: string;
  exit_kind: string | null;
  title: string | null;
  role_id: string | null;
  role_name: string | null;
  excerpt: string | null;
  excerpt_source: 'receipt' | 'settlement' | 'final_message' | null;
  report?: RunReportInfo & { ref: string };
  commits: HistoricalCommit[];
  knowledge: HistoricalKnowledge[] | null;
  knowledge_unavailable: boolean;
}

export interface HistoryEvidencePage {
  items: HistoryEvidence[];
  next_cursor: string | null;
}
