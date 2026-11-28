// Cross-project pinned read-only references and intra-project task artifact contracts.
import { localeMap } from './i18n.ts';

export const CROSS_PROJECT_REF_KINDS = ['project_file', 'knowledge', 'wiki_page', 'artifact'] as const;
export type CrossProjectRefKind = (typeof CROSS_PROJECT_REF_KINDS)[number];
export const CROSS_PROJECT_REF_KIND_LABELS: Readonly<Record<CrossProjectRefKind, string>> = localeMap({
  project_file: 'sh.collab.refKind.project_file',
  knowledge: 'sh.collab.refKind.knowledge',
  wiki_page: 'sh.collab.refKind.wiki_page',
  artifact: 'sh.collab.refKind.artifact',
});

export interface CrossProjectRef {
  id: string;
  created_at: string;
  source_project_id: string;
  target_project_id: string;
  ref_kind: CrossProjectRefKind;
  source_ref_id: string;
  pinned_version: string;
  title: string;
  summary: string;
  content_sha256: string;
  frozen_bytes: number;
  granted_by: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

export const TASK_CONTRACT_STATUSES = ['pending', 'delivered', 'blocked', 'clarified', 'superseded'] as const;
export type TaskContractStatus = (typeof TASK_CONTRACT_STATUSES)[number];
export const TASK_CONTRACT_STATUS_LABELS: Readonly<Record<TaskContractStatus, string>> = localeMap({
  pending: 'sh.collab.contractStatus.pending',
  delivered: 'sh.collab.contractStatus.delivered',
  blocked: 'sh.collab.contractStatus.blocked',
  clarified: 'sh.collab.contractStatus.clarified',
  superseded: 'sh.collab.contractStatus.superseded',
});

export interface ContractClarification {
  id: string;
  at: string;
  by: string;
  producer_revision: number;
  contract_version: number;
  question: string;
  answer?: string;
  answered_at?: string;
  answered_by?: string;
}

export interface TaskContract {
  id: string;
  created_at: string;
  updated_at: string;
  project_id: string;
  producer_task_id: string;
  consumer_task_id: string;
  contract_name: string;
  artifact_path: string;
  registered_version: number;
  status: TaskContractStatus;
  delivered_run_id: string | null;
  delivered_sha256: string | null;
  delivery_summary: string | null;
  clarifications: ContractClarification[];
  coalesced_revision: number;
  notified_version: number;
}

export const MAX_CONTRACT_CLARIFICATIONS = 10;
export const MAX_CONTRACT_CLARIFICATION_CHARS = 1000;
