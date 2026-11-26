// Offline self-explaining diagnostics bundle for a single Run.
// Pure shared types: imported by both the service builder and the console UI,
// with zero runtime dependencies and no backend-only imports.
import type { Loading } from './knowledge.ts';
import type { MachineInputs } from './machine-inputs.ts';
import type { RoleConfig, RunAccess, TierSource } from './roles.ts';
import type { SnapshotSource } from './sources.ts';
import type { TierId } from './tiers.ts';
import type { RouterCallTrace } from './trajectory.ts';

export type DiagnosticErrorSource = 'diagnostic' | 'run_error' | 'stderr';

export type DiagnosticFirstError = {
  source: DiagnosticErrorSource;
  message: string;
  timestamp?: string;
  event_index?: number;
} | null;

export interface UnfinishedTool {
  id: string;
  name: string;
  category?: string;
  title?: string;
  started_at?: string;
  event_index: number;
}

export interface FailedTool {
  id?: string;
  name: string;
  category?: string;
  title?: string;
  exit_code?: number;
  reason?: string;
  event_index: number;
}

export interface ToolSummary {
  total: number;
  error_count: number;
  unfinished_count: number;
  by_category: Record<string, number>;
  failed_tools: FailedTool[];
  unfinished_tools: UnfinishedTool[];
}

export interface ModelEvidence {
  tier_model: string | null;
  reported_models: string[];
}

export interface DiagnosticCoverage {
  events_loaded: boolean;
  events_count: number;
  dropped_before_index: number;
  incomplete_reason: string | null;
  stderr_loaded: boolean;
}

export interface SafeLoginProjection {
  id?: string;
  name?: string;
  executor?: string;
  machine?: string | null;
  permission_mode?: string | null;
  timeout_ms?: number | null;
  max_runs?: number | null;
}

export interface SafeKnowledgeProjection {
  id: string;
  revision: number;
  title: string;
  loading: Loading;
  scope: 'global' | 'project';
  roles: string[];
  kind?: 'skill';
  named?: true;
  path?: string;
}

export interface SafeSnapshotProjection {
  goal?: string | null;
  acceptance?: string | null;
  role?: RoleConfig | null;
  tier?: string | null;
  tier_from?: TierId | null;
  tier_source?: TierSource | null;
  executor?: string | null;
  login?: SafeLoginProjection | string | null;
  source?: SnapshotSource | null;
  access?: RunAccess | null;
  machine_inputs?: MachineInputs | null;
  knowledge?: SafeKnowledgeProjection[] | null;
}

export interface RunTraceChange {
  seq: number;
  at: string;
  actor: string;
  message_id: string | null;
  task_id: string | null;
  run_id: string | null;
  action: string;
  detail_json: string | null;
  tool_call_id?: string | null;
}

export interface RunTraceMessage {
  id: string;
  text: string;
  channel?: string;
  actor?: string | null;
  at?: string;
  created_at?: string;
  project_id?: string | null;
}

export interface RunTraceInput {
  id: string;
  created_at: string;
  task_id: string;
  text: string;
  actor: string;
  message_id: string | null;
  state: 'queued' | 'attached' | 'void';
  run_id: string | null;
}

export interface RunTraceSettlement {
  at: string;
  task_state: string | null;
  exit_kind: string | null;
  policy: { rule: string; reason: string } | null;
  delivery: 'held' | 'pending' | 'sent' | 'given_up' | 'unknown';
}

export interface RunTrace {
  run_id: string;
  task_id: string;
  trigger: {
    kind: 'message' | 'approval' | 'timer' | 'resume' | 'unknown';
    label: string;
    change: RunTraceChange | null;
    message: RunTraceMessage | null;
    tool_call: RouterCallTrace | null;
  };
  origin_call: RouterCallTrace | null;
  inputs: RunTraceInput[];
  session_ref: string | null;
  task_revision: number;
  dispatchConditions: unknown;
  changes: RunTraceChange[];
  settlement: RunTraceSettlement | null;
}

export interface RunDiagnosticsBundle {
  schema_version: 1;
  generated_at: string;
  platform_version: string | null;
  run: {
    id: string;
    task_id: string;
    status: string;
    exit_kind?: string | null;
    exit_code?: number | null;
    executor: string;
    tier: string | null;
    login_id: string | null;
    login_name?: string | null;
    machine_id?: string | null;
    node_id: string | null;
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
    error: string | null;
  };
  task: {
    id: string;
    title: string;
    status: string;
    project_id: string | null;
  } | null;
  snapshot: SafeSnapshotProjection | null;
  first_error: DiagnosticFirstError;
  stderr: {
    head: string[];
    tail: string[];
  };
  tools: ToolSummary;
  models: ModelEvidence;
  coverage: DiagnosticCoverage;
  trace: RunTrace | null;
}
