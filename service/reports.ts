import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { InputError } from './errors.ts';
import type { RunRow } from './ledger.ts';
import { artifactNameIsUsable, nameIsSafe, registrationDir } from './releases.ts';
import type { HeldArtifacts } from './review.ts';
import { readBoundArtifact } from './artifact-file.ts';
import { FINAL_MESSAGE_REF, REPORT_TEXT_LIMIT, type RunReport, type ReportDescriptor } from '../shared/report.ts';
export { REPORT_TEXT_LIMIT } from '../shared/report.ts';

export interface ReportFile { ref: string; name: string }

function artifactSubpathIsUsable(rel: string): boolean {
  if (rel === '' || rel.includes('\\') || /[\u0000-\u001f\u007f]/.test(rel)) return false;
  const parts = rel.split('/');
  return parts.length > 0 && parts.every((part) => artifactNameIsUsable(part));
}

// Resolve a relative artifact subpath inside baseDir while verifying strict containment
// and rejecting symlinks at every path segment.
function resolveContainedFile(baseDir: string, relPath: string): string | null {
  if (!artifactSubpathIsUsable(relPath)) return null;
  const base = resolve(baseDir);
  let current = base;
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]!);
    const resolved = resolve(current);
    if (!resolved.startsWith(base + sep)) return null;
    try {
      const st = lstatSync(resolved);
      if (st.isSymbolicLink()) return null;
      if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return null;
    } catch {
      return null;
    }
  }
  return current;
}

function readFileSlice(path: string, expectedSize: number, offset: number, limit: number): Buffer | null {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== expectedSize) return null;
    if (offset >= stat.size) return Buffer.alloc(0);
    const want = Math.min(limit, stat.size - offset);
    const body = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const taken = readSync(fd, body, read, want - read, offset + read);
      if (taken === 0) break;
      read += taken;
    }
    return read === want ? body : body.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Trim incomplete multi-byte UTF-8 edges when slicing an arbitrary byte range so valid UTF-8
// files truncated at REPORT_TEXT_LIMIT decode cleanly while genuinely binary files still fail.
function decodeUtf8Slice(buf: Buffer, trimStart: boolean, trimEnd: boolean): { text: string; bytes: number } {
  let start = 0;
  let end = buf.length;
  if (trimStart) {
    while (start < end && start < 3 && (buf[start]! & 0xc0) === 0x80) start += 1;
  }
  if (trimEnd && end > start) {
    let lead = end - 1;
    let cont = 0;
    while (lead > start && cont < 3 && (buf[lead]! & 0xc0) === 0x80) {
      lead -= 1;
      cont += 1;
    }
    const byte = buf[lead]!;
    let need = 1;
    if ((byte & 0xe0) === 0xc0) need = 2;
    else if ((byte & 0xf0) === 0xe0) need = 3;
    else if ((byte & 0xf8) === 0xf0) need = 4;
    if (end - lead < need) end = lead;
  }
  const view = buf.subarray(start, end);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(view);
  if (text.includes('\u0000')) throw new Error('binary');
  return { text, bytes: view.length };
}

// Normalize at the report boundary, not at each transport. Logical report references
// remain receipt text; only files under this Run's own artifacts/ (including relative subpaths) are readable.
function reportFile(run: Pick<RunRow, 'id' | 'task_id'>, ref: string): ReportFile | null {
  const prefix = 'runs/' + run.id + '/artifacts/';
  if (/^runs\/[^/]+\/artifacts\//.test(ref) && !ref.startsWith(prefix)) return null;
  let name = ref.startsWith(prefix) ? ref.slice(prefix.length)
    : ref.startsWith('artifacts/') ? ref.slice('artifacts/'.length)
    : ref.startsWith('./artifacts/') ? ref.slice('./artifacts/'.length)
    : ref;
  if (!artifactSubpathIsUsable(name)) {
    // An absolute receipt is only a hint naming this Run's artifact. Never open it:
    // the node still resolves the safe name within its own bound Task/Run directory.
    // Some native Windows receipts contain repeated backslash separators after JSON
    // decoding. Normalize those here, without resolving dot segments or accepting UNC.
    const windows = /^[A-Za-z]:[\\/]/.test(ref);
    if (!windows && (!ref.startsWith('/') || ref.includes('\\'))) return null;
    const path = windows ? ref.replace(/\\+/g, '/') : ref;
    if (path.startsWith('//') || /[\u0000-\u001f\u007f]/.test(path)) return null;
    const parts = path.split('/').slice(1);
    if (parts.some(part => part === '' || part === '.' || part === '..' || (windows && part.includes(':')))) return null;
    let found: string[] | null = null;
    for (let i = 0; i <= parts.length - 6; i += 1) {
      if (parts[i] === 'tasks' && parts[i + 1] === run.task_id && parts[i + 2] === 'runs'
        && parts[i + 3] === run.id && parts[i + 4] === 'artifacts') {
        found = parts.slice(i + 5);
        break;
      }
    }
    if (found === null || found.length === 0) return null;
    name = found.join('/');
  }
  return artifactSubpathIsUsable(name) ? { ref, name } : null;
}

export function reportFilesOf(run: Pick<RunRow, 'id' | 'task_id' | 'receipt_json'>, finalMessage?: RunReport): ReportDescriptor[] {
  if (run.receipt_json === null) return [];
  let receipt: { artifacts?: { kind?: unknown; ref?: unknown }[] };
  try { receipt = JSON.parse(run.receipt_json); } catch { return []; }
  if (!Array.isArray(receipt?.artifacts)) return [];
  return receipt.artifacts.flatMap((item) => {
    if (item?.kind !== 'report') return [];
    const ref = typeof item.ref === 'string' ? item.ref : '';
    const invalid = (): ReportDescriptor[] => [{ ref, name: ref || '未声明报告位置', kind: 'invalid',
      problem: '这轮报告的位置无法识别。' }];
    if (typeof item.ref !== 'string') return invalid();
    if (item.ref === FINAL_MESSAGE_REF) {
      const saved = finalMessage?.run_id === run.id && finalMessage.task_id === run.task_id ? finalMessage : undefined;
      return [{ ref: item.ref, name: '最后回复', kind: 'final_message' as const, state: saved ? saved.complete ? 'saved' as const : 'truncated' as const : 'unavailable' as const,
        ...(saved ? { bytes: saved.bytes, sha256: saved.sha256 } : {}) }];
    }
    const file = reportFile(run, item.ref);
    return file ? [file] : invalid();
  });
}

// Report review hard gate removed: read-only rounds with files in artifacts/ or without an
// explicit kind:"report" declaration are never blocked (automatic final-message fallback handles missing files).
export function reportReviewProblem(_run: Pick<RunRow, 'id' | 'task_id' | 'receipt_json' | 'snapshot_json'>, _files?: readonly { name: string }[]): string | null {
  return null;
}

export async function readRunReport(options: {
  run: RunRow;
  ref: string | null;
  dataDir: string;
  held: HeldArtifacts | undefined;
  readNode?: (run: RunRow, name: string, maxBytes: number) => Promise<Buffer>;
  finalMessage?: RunReport;
  recoverFinal?: (run: RunRow) => Promise<RunReport>;
  offset?: number;
  limit?: number;
}): Promise<{ run_id: string; ref: string; name: string; text: string; source: 'registered' | 'node' | 'settlement' | 'recovered'; complete?: boolean; bytes?: number; original_bytes?: number; sha256?: string; at?: string }> {
  const { run, held } = options;
  if (run.state !== 'ended') throw new InputError('这一轮尚未结束，还没有可查看的交付报告');
  const offset = options.offset === undefined ? 0 : Math.max(0, Math.floor(options.offset));
  const limit = options.limit === undefined
    ? REPORT_TEXT_LIMIT
    : Math.min(Math.max(1, Math.floor(options.limit)), REPORT_TEXT_LIMIT);

  let file: ReportDescriptor | undefined = reportFilesOf(run, options.finalMessage).find((entry) => entry.ref === options.ref);
  if (!file) {
    if (options.ref === FINAL_MESSAGE_REF) {
      file = { ref: FINAL_MESSAGE_REF, name: '最后回复', kind: 'final_message', state: 'unavailable' };
    } else if (typeof options.ref === 'string' && options.ref !== '') {
      const parsed = reportFile(run, options.ref);
      if (parsed && held?.registration?.files.some((entry) => entry.name === parsed.name)) {
        file = parsed;
      }
    }
  }
  if (!file) throw new InputError('找不到这份交付文件或报告');
  if (file.kind === 'invalid') throw new InputError(file.problem);
  if (file.kind === 'final_message') {
    const report = options.finalMessage ?? await options.recoverFinal?.(run);
    if (!report) throw new InputError('这一轮的最后回复未保存，原始输出也无法恢复；诊断事件不是完整报告');
    if (report.run_id !== run.id || report.task_id !== run.task_id) throw new InputError('最后回复与这一轮或任务不符，无法查看');
    if (options.offset !== undefined || options.limit !== undefined) {
      const full = Buffer.from(report.text, 'utf8');
      const end = Math.min(offset + limit, full.length);
      const sliced = full.subarray(Math.min(offset, full.length), end);
      const decoded = decodeUtf8Slice(sliced, offset > 0, end < full.length);
      return {
        run_id: run.id,
        ref: file.ref,
        name: file.name,
        text: decoded.text,
        source: report.source,
        complete: report.complete && offset === 0 && end >= full.length,
        bytes: decoded.bytes,
        original_bytes: report.original_bytes,
        sha256: report.sha256,
        at: report.at,
      };
    }
    return { run_id: run.id, ref: file.ref, name: file.name, text: report.text, source: report.source, complete: report.complete,
      bytes: report.bytes, original_bytes: report.original_bytes, sha256: report.sha256, at: report.at };
  }
  if (run.releases_dropped_at !== null || held?.releases_dropped_at != null) throw new InputError('这一轮的产物已过保留期，报告已清理');
  let body: Buffer;
  let source: 'registered' | 'node';
  let originalBytes: number;
  let sha256: string | undefined;
  let truncatedEnd = false;
  if (held?.registration) {
    if (held.run_id !== run.id || held.task_id !== run.task_id || !nameIsSafe(run.id) || !nameIsSafe(held.registration.id)) {
      throw new InputError('已登记产物与这一轮不符，无法查看报告');
    }
    const registered = held.registration.files.find((entry) => entry.name === file.name);
    if (!registered) throw new InputError('已登记产物中没有这份文件，无法查看');
    const dir = registrationDir(options.dataDir, run.id, held.registration.id);
    const fullPath = resolveContainedFile(dir, file.name);
    if (fullPath === null) throw new InputError('已登记文件不可读取或路径不安全，无法查看');
    originalBytes = registered.bytes;
    sha256 = registered.sha256;
    if (offset === 0 && registered.bytes <= limit) {
      const found = readBoundArtifact(fullPath, registered);
      if (found === null) throw new InputError('已登记报告已清理或内容与登记摘要不符，无法查看');
      body = found;
    } else {
      const sliced = readFileSlice(fullPath, registered.bytes, offset, limit);
      if (sliced === null) throw new InputError('已登记报告已清理或内容与登记摘要不符，无法查看');
      body = sliced;
      truncatedEnd = offset + body.length < registered.bytes;
    }
    source = 'registered';
  } else {
    if (!options.readNode) throw new InputError('执行节点的读取服务不可用，无法查看报告');
    let raw: Buffer;
    try { raw = await options.readNode(run, file.name, REPORT_TEXT_LIMIT); }
    catch (error) { throw new InputError('报告暂时无法读取：' + (error as Error).message); }
    originalBytes = raw.length;
    const end = Math.min(offset + limit, raw.length);
    body = raw.subarray(Math.min(offset, raw.length), end);
    truncatedEnd = end < raw.length;
    source = 'node';
  }
  let decoded: { text: string; bytes: number };
  try {
    decoded = decodeUtf8Slice(body, offset > 0, truncatedEnd);
  } catch { throw new InputError('这份文件不是 UTF-8 文本，无法查看'); }
  const complete = offset === 0 && !truncatedEnd;
  return {
    run_id: run.id,
    ref: file.ref,
    name: file.name,
    text: decoded.text,
    source,
    complete,
    bytes: decoded.bytes,
    original_bytes: originalBytes,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}
