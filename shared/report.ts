// The receipt spelling is also the read-only Worker's delivery instruction.
export const FINAL_MESSAGE_REF = '最后一条消息';
export const REPORT_TEXT_LIMIT = 128 * 1024;

export interface RunReport {
  id: string;
  task_id: string;
  run_id: string;
  at: string;
  text: string;
  bytes: number;
  original_bytes: number;
  sha256: string;
  complete: boolean;
  source: 'settlement' | 'recovered';
}

// Only a role whose deliverable is a report may hand its final reply to a reviewer.
export function finalMessageDelivery(run: { snapshot_json: string; receipt_json: string | null }): boolean {
  const snapshot = JSON.parse(run.snapshot_json) as { role?: { deliverable?: string } };
  return snapshot.role?.deliverable === 'report' && hasFinalMessageReport(JSON.parse(run.receipt_json ?? 'null'));
}

export type RunReportInfo = Omit<RunReport, 'text'>;
export type ReportDescriptor = { ref: string; name: string; kind?: 'file' } | {
  ref: string;
  name: '最后回复';
  kind: 'final_message';
  state: 'saved' | 'truncated' | 'unavailable';
  bytes?: number;
  sha256?: string;
} | {
  ref: string;
  name: string;
  kind: 'invalid';
  problem: string;
};

export function reportInfo({ text: _text, ...info }: RunReport): RunReportInfo { return info; }

export function hasFinalMessageReport(receipt: unknown): boolean {
  const artifacts = (receipt as { artifacts?: unknown } | null)?.artifacts;
  return Array.isArray(artifacts) && artifacts.some(item => item?.kind === 'report' && item.ref === FINAL_MESSAGE_REF);
}

export function reportBinding({ id, sha256, bytes, complete }: RunReport): Pick<RunReportInfo, 'id' | 'sha256' | 'bytes' | 'complete'> {
  return { id, sha256, bytes, complete };
}
