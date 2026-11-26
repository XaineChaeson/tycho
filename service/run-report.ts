import { createHash } from 'node:crypto';
import { REPORT_TEXT_LIMIT, reportInfo, type RunReport } from '../shared/report.ts';
import type { Db } from './db.ts';
import type { RunRow } from './ledger.ts';
import { InputError } from './errors.ts';
import type { ChangeRow } from './messages.ts';
import { redactDiagnosticText } from './router-call-text.ts';

export const RUN_REPORT_ACTION = 'run.report';
type Content = Omit<RunReport, 'id' | 'task_id' | 'run_id' | 'at'>;

// The Runner hides the credential handed to this round before extracting its result.
// Shared auth/header patterns also apply here, including recovered and direct callers.
export function finalReportContent(text: string, source: Content['source']): Content {
  const body = Buffer.from(redactDiagnosticText(text, value => value));
  let kept = body.subarray(0, REPORT_TEXT_LIMIT);
  let captured: string;
  for (;;) {
    try { captured = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(kept); break; }
    catch { kept = kept.subarray(0, kept.length - 1); }
  }
  return { text: captured, bytes: kept.length, original_bytes: body.length,
    sha256: createHash('sha256').update(kept).digest('hex'), complete: kept.length === body.length, source };
}

export function reportFromChange(row: ChangeRow | undefined): RunReport | undefined {
  if (!row || row.action !== RUN_REPORT_ACTION || row.run_id === null || row.task_id === null || row.detail_json === null) return;
  try {
    const held = JSON.parse(row.detail_json) as { version?: unknown; id?: unknown } & Partial<Content>;
    if (held.version !== 1 || typeof held.id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(held.id) || typeof held.text !== 'string' || typeof held.complete !== 'boolean'
      || (held.source !== 'settlement' && held.source !== 'recovered') || !Number.isSafeInteger(held.bytes)
      || !Number.isSafeInteger(held.original_bytes) || held.bytes! < 0 || held.bytes! > REPORT_TEXT_LIMIT
      || held.original_bytes! < held.bytes! || held.complete !== (held.bytes === held.original_bytes)
      || Buffer.byteLength(held.text) !== held.bytes || typeof held.sha256 !== 'string'
      || createHash('sha256').update(held.text).digest('hex') !== held.sha256) return;
    return { id: held.id, task_id: row.task_id, run_id: row.run_id, at: row.at,
      text: held.text, complete: held.complete, source: held.source,
      bytes: held.bytes!, original_bytes: held.original_bytes!, sha256: held.sha256 };
  } catch { return; }
}

// An audit timeline can name the report; its body is only read on the report route.
export function reportAuditView(row: ChangeRow): ChangeRow {
  if (row.action !== RUN_REPORT_ACTION) return row;
  const report = reportFromChange(row);
  return { ...row, detail_json: report ? JSON.stringify(reportInfo(report)) : JSON.stringify({ unavailable: true }) };
}


export function readRecordedReport(db: Pick<Db, 'get'>, run: Pick<RunRow, 'id' | 'task_id'>): RunReport | undefined {
  const row = db.get<ChangeRow>('SELECT * FROM change WHERE action = ? AND run_id = ? ORDER BY seq LIMIT 1', RUN_REPORT_ACTION, run.id);
  if (!row) return;
  const report = reportFromChange(row);
  if (!report || report.run_id !== run.id || report.task_id !== run.task_id) throw new InputError('正式报告记录损坏或与这一轮任务不符');
  return report;
}
