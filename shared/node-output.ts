import { localeMap, t } from './i18n.ts';

// Smallest envelope budget: fixed fields plus a worst-case 512-UTF16-unit escaped reason.
export const MIN_OUTPUT_RESULT_BYTES = 4 * 1024;
export interface OutputPolicy { store_bytes: number; raw_bytes: number; result_bytes: number; retention_ms: number }
export interface CaptureSpec { version: 1; source: string; raw_bytes: number; result_bytes: number }
export type OutputStream = 'stdout' | 'stderr';
export interface OutputExternalUsage { bytes: number; issue?: string }
export interface OutputCapacity {
  limit_bytes: number; used_bytes: number; reserved_bytes: number; external_bytes: number;
  free_bytes: number; available_runs: number; other_node_reserved_bytes?: number; issue?: string;
}
export interface OutputLease {
  root: string; source: string; run_dir: string; nodeId: string;
  raw_bytes: number; result_bytes: number; reserved_bytes: number;
}
export type ReserveResult = { state: 'ready'; lease: OutputLease } | { state: 'capacity'; capacity: OutputCapacity; reason: string };
export interface CaptureReadRequest { run_dir: string; source: string; stream: OutputStream; offset: number; bytes: number }
export interface ResultReadRequest { run_dir: string; source: string; offset: number; bytes: number }
export type CaptureRange = {
  state: 'range'; source: string; base: number; end: number; committed_end: number; start: number; base64: string;
  sealed: boolean; gap?: { from: number; to: number; reason: string }; issue?: string;
} | { state: 'unavailable'; source: string; reason: string };
export interface ResultReference { version: 1; source: string; state: 'ready' | 'incomplete'; size: number; sha256: string }
export interface ResultRange {
  state: 'pending' | 'ready' | 'incomplete' | 'released' | 'missing' | 'unavailable';
  source: string; size: number; sha256: string | null; offset: number; base64: string; reason?: string;
}
export interface OutputReference {
  source: string; run_dir: string; phase: 'reserved' | 'writing' | 'sealed' | 'release_pending' | 'released';
  result?: ResultReference; issue?: string;
}
export interface OutputWriter {
  feed(stream: OutputStream, bytes: Uint8Array): void;
  finish(envelopeBytes: Uint8Array, state: 'ready' | 'incomplete'): Promise<ResultReference>;
}
export interface OutputPool {
  capacity(policy: OutputPolicy, externalUsage: OutputExternalUsage): Promise<OutputCapacity>;
  reserve(request: {run_dir: string; spec: CaptureSpec}, policy: OutputPolicy, externalUsage: OutputExternalUsage): Promise<ReserveResult>;
  references(request?: {after?: string; limit?: number}): Promise<{items: OutputReference[]; next?: string}>;
  lease(source: string, run_dir: string): Promise<OutputLease | undefined>;
  release(source: string): Promise<void>;
  abandon(source: string, reason: string): Promise<void>;
  reap(policy: OutputPolicy): Promise<void>;
  readCapture(request: CaptureReadRequest): Promise<CaptureRange>;
  readResult(request: ResultReadRequest): Promise<ResultRange>;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('sh.nodeOutput.err.notObject'));
  return value as Record<string, unknown>;
}
export function outputInteger(value: unknown, name: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
    throw new Error(t(positive ? 'sh.nodeOutput.err.notPositiveInt' : 'sh.nodeOutput.err.notNonNegInt', { name }));
  }
  return value as number;
}
export function outputSource(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(t('sh.nodeOutput.err.invalidSource'));
  return value;
}
export function outputRunDir(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !/^tasks\/[A-Za-z0-9_-]+\/runs\/[A-Za-z0-9_-]+$/.test(value)) throw new Error(t('sh.nodeOutput.err.invalidRunDir'));
  return value;
}
function resultBytes(value: unknown): number {
  const bytes = outputInteger(value, 'result_bytes', true);
  if (bytes < MIN_OUTPUT_RESULT_BYTES) throw new Error(t('sh.nodeOutput.err.minResultBytes', { min: MIN_OUTPUT_RESULT_BYTES }));
  return bytes;
}
export function normalizeOutputPolicy(value: unknown): OutputPolicy {
  const v = object(value);
  return { store_bytes: outputInteger(v.store_bytes, 'store_bytes'), raw_bytes: outputInteger(v.raw_bytes, 'raw_bytes', true), result_bytes: resultBytes(v.result_bytes), retention_ms: outputInteger(v.retention_ms, 'retention_ms') };
}
export function normalizeCaptureSpec(value: unknown): CaptureSpec {
  const v = object(value);
  if (v.version !== 1) throw new Error(t('sh.nodeOutput.err.badVersion'));
  return { version: 1, source: outputSource(v.source), raw_bytes: outputInteger(v.raw_bytes, 'raw_bytes', true), result_bytes: resultBytes(v.result_bytes) };
}
const OUTPUT_STATE_LABELS: Readonly<Record<string, string>> = localeMap({
  pending: 'sh.nodeOutput.state.pending',
  ready: 'sh.nodeOutput.state.ready',
  incomplete: 'sh.nodeOutput.state.incomplete',
  released: 'sh.nodeOutput.state.released',
  missing: 'sh.nodeOutput.state.missing',
  unavailable: 'sh.nodeOutput.state.unavailable',
});
export const outputStateText = (state: string): string =>
  (Object.hasOwn(OUTPUT_STATE_LABELS, state) ? OUTPUT_STATE_LABELS[state] : undefined) ?? t('sh.nodeOutput.state.unknown');
