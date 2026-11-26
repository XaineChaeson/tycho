import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, readdirSync, rmSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedEvent } from '../adapters/types.ts';
import type { RunRow } from '../service/ledger.ts';
import { runMachineUid } from './snapshot.ts';

const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HISTORY_FILE = /^([0-9A-HJKMNP-TV-Z]{26})\.json(\.draft)?$/;
// Fixed parser envelopes are safety limits, independent of the owner's retained suffix.
export const HISTORY_EVENT_BYTES = 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024 + 4096;
const MAX_CHECKPOINT_EVENTS = 50_000;

export interface DiagnosticPolicy { maxEvents: number; maxBytes: number }
export const DEFAULT_DIAGNOSTIC_POLICY: Readonly<DiagnosticPolicy> = { maxEvents: 5000, maxBytes: 1024 * 1024 };

// The source is one stdout log on one registration of one Worker placement.
export function diagnosticSource(run: RunRow): string | undefined {
  const uid = runMachineUid(run);
  if (!RUN_ID.test(run.id) || !uid || run.node_id === null || run.machine_id === null) return undefined;
  return createHash('sha256')
    .update(JSON.stringify([run.id, run.task_id, run.machine_id, run.node_id, uid, 'stdout.ndjson']))
    .digest('hex');
}

export interface DiagnosticCheckpoint {
  version: 1;
  source: string;
  cursor: number;
  dropped: number;
  discarding: boolean;
  sourceLost: boolean;
  finished: boolean;
  events: NormalizedEvent[];
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Written by this service only. Opening first bounds the read even if the file changes.
export function readCheckpoint(dir: string, id: string, source: string): DiagnosticCheckpoint | undefined {
  let file: number;
  try {
    file = openSync(join(dir, id + '.json'), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new Error('Worker 诊断记录不是普通文件');
    if (stat.size > MAX_CHECKPOINT_BYTES) throw new Error('Worker 诊断记录超过大小上限');
    const body = Buffer.alloc(stat.size);
    for (let offset = 0; offset < body.length;) {
      const size = readSync(file, body, offset, body.length - offset, offset);
      if (size === 0) throw new Error('Worker 诊断记录读取不完整');
      offset += size;
    }
    const value = JSON.parse(body.toString('utf8')) as Partial<DiagnosticCheckpoint>;
    if (value.version !== 1 || value.source !== source) return;
    if (!counter(value.cursor) || !counter(value.dropped) || !Array.isArray(value.events) || value.events.length > MAX_CHECKPOINT_EVENTS
      || typeof value.discarding !== 'boolean' || typeof value.sourceLost !== 'boolean' || typeof value.finished !== 'boolean') {
      throw new Error('Worker 诊断记录格式损坏');
    }
    return value as DiagnosticCheckpoint;
  } finally {
    closeSync(file);
  }
}

// The next cursor and the redacted records it accounts for replace the previous checkpoint
// together. The remote spool can replay any bytes after that cursor if the Host stops first.
export async function writeCheckpoint(dir: string, id: string, checkpoint: DiagnosticCheckpoint): Promise<void> {
  const path = join(dir, id + '.json');
  const draft = path + '.draft';
  if (checkpoint.events.length > MAX_CHECKPOINT_EVENTS) throw new Error('Worker 诊断事件超过解析数量上限');
  const text = JSON.stringify(checkpoint);
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) throw new Error('Worker 诊断记录超过大小上限');
  try {
    await writeFile(draft, text, { mode: 0o600, flush: true });
    await rename(draft, path);
  } finally {
    await rm(draft, { force: true });
  }
}

export function pruneCheckpoints(dir: string, removeRun: (id: string) => boolean, writing: ReadonlySet<string>): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const file = HISTORY_FILE.exec(name);
    if (file && !writing.has(file[1]!) && (file[2] || removeRun(file[1]!))) {
      rmSync(join(dir, name), { force: true });
    }
  }
}
