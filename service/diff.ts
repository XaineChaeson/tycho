import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange, NormalizedEvent } from '../adapters/types.ts';
import { bindingKey, type TaskSource } from '../shared/sources.ts';
import type { RunRow, TaskRow } from './ledger.ts';
import { deliveryOf } from './review.ts';

const GIT_TIMEOUT_MS = 10_000;
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const NO_DIFF_REASON = '本任务暂无可审阅的代码改动';

export interface TaskDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
}

export interface TaskDiffResponse {
  source: 'git' | 'executor' | 'none';
  commit: string | null;
  base: string | null;
  branch: string | null;
  files: TaskDiffFile[];
  truncated: boolean;
  reason?: string;
}

export interface ReadTaskDiffOptions {
  dataDir: string;
  task: Pick<TaskRow, 'id' | 'source_json'>;
  runs: readonly RunRow[];
  runId?: string | null;
  readRunEvents?: (run: RunRow) => Promise<readonly NormalizedEvent[]> | readonly NormalizedEvent[];
}

function gitOut(dir: string, args: string[]): string | null {
  try {
    const res = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) return null;
    return typeof res.stdout === 'string' ? res.stdout : '';
  } catch {
    return null;
  }
}

function isSafeSegment(value: string): boolean {
  return value !== '' && !value.includes('..') && !value.includes('/') && !value.includes('\\');
}

function safeTaskDir(dataDir: string, taskId: string): string | null {
  if (!isSafeSegment(taskId)) return null;
  const dir = join(dataDir, 'tasks', taskId);
  return existsSync(dir) ? dir : null;
}

function pinnedFolderPath(sourceJson: string | null): string | null {
  if (!sourceJson) return null;
  try {
    const parsed = JSON.parse(sourceJson) as Partial<TaskSource> | { kind?: unknown; path?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = 'pinned' in parsed && parsed.pinned && typeof parsed.pinned === 'object' ? parsed.pinned : parsed;
    const rec = candidate as { kind?: unknown; path?: unknown };
    if (rec.kind !== 'folder' || typeof rec.path !== 'string' || rec.path.trim() === '') return null;
    return rec.path.trim();
  } catch {
    return null;
  }
}

function pinnedBindingKey(sourceJson: string | null): string | null {
  if (!sourceJson) return null;
  try {
    const parsed = JSON.parse(sourceJson) as Partial<TaskSource> | { id?: unknown; kind?: unknown; url?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = 'pinned' in parsed && parsed.pinned && typeof parsed.pinned === 'object' ? parsed.pinned : parsed;
    const rec = candidate as { id?: unknown; kind?: unknown; url?: unknown };
    if (rec.kind !== 'repo' || typeof rec.id !== 'string' || typeof rec.url !== 'string') return null;
    return bindingKey({ id: rec.id, kind: 'repo', url: rec.url });
  } catch {
    return null;
  }
}

function findLocalGitRepo(dataDir: string, task: Pick<TaskRow, 'id' | 'source_json'>): string | null {
  const folderPath = pinnedFolderPath(task.source_json);
  if (folderPath !== null && existsSync(join(folderPath, '.git'))) {
    return folderPath;
  }

  const taskDir = safeTaskDir(dataDir, task.id);
  if (taskDir === null) return null;

  const preferred = pinnedBindingKey(task.source_json);
  if (preferred !== null) {
    const preferredDir = join(taskDir, preferred);
    if (existsSync(join(preferredDir, '.git'))) return preferredDir;
  }

  let entries: string[];
  try {
    entries = readdirSync(taskDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name === 'runs' || name === 'rounds' || name.startsWith('.') || name.includes('.incoming.')) continue;
    const candidate = join(taskDir, name);
    try {
      if (!statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(candidate, '.git'))) return candidate;
  }
  return null;
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function stripDiffPrefix(raw: string): string {
  const clean = unquoteGitPath(raw);
  if (clean.startsWith('a/') || clean.startsWith('b/')) return clean.slice(2);
  return clean;
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  const lines = patch.split(/\r?\n/);
  const hasHunkHeader = lines.some((line) => line.startsWith('@@ '));
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (hasHunkHeader && !inHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function trimToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let cut = buf.subarray(0, maxBytes).toString('utf8');
  // Avoid broken trailing unicode replacement char
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
}

export function parseUnifiedDiff(raw: string, maxBytes = MAX_DIFF_BYTES): { files: TaskDiffFile[]; truncated: boolean } {
  if (!raw || !raw.trim()) return { files: [], truncated: false };
  const chunks = raw.split(/^diff --git /m).filter((part) => part.trim() !== '');
  const files: TaskDiffFile[] = [];
  let usedBytes = 0;
  let truncated = false;

  for (const part of chunks) {
    const fullPatch = `diff --git ${part}`.replace(/\r\n/g, '\n').trimEnd();
    const lines = fullPatch.split('\n');
    const header = lines[0] ?? '';

    let status: TaskDiffFile['status'] = 'modified';
    let renameTo: string | null = null;
    let plusPath: string | null = null;
    let minusPath: string | null = null;

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.startsWith('@@ ')) break;
      if (line.startsWith('new file mode ')) status = 'added';
      else if (line.startsWith('deleted file mode ')) status = 'deleted';
      else if (line.startsWith('rename from ')) status = 'renamed';
      else if (line.startsWith('rename to ')) {
        status = 'renamed';
        renameTo = unquoteGitPath(line.slice('rename to '.length));
      } else if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        if (p === '/dev/null') status = 'added';
        else minusPath = stripDiffPrefix(p);
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        if (p === '/dev/null') status = 'deleted';
        else plusPath = stripDiffPrefix(p);
      }
    }

    let path = renameTo ?? (status === 'deleted' ? minusPath : plusPath) ?? plusPath ?? minusPath ?? '';
    if (!path) {
      const match = /^diff --git ("[^"]+"|\S+) ("[^"]+"|\S+)/.exec(header);
      if (match) path = stripDiffPrefix(match[2]!);
    }
    if (!path) continue;

    const { additions, deletions } = countPatchLines(fullPatch);
    const bytes = Buffer.byteLength(fullPatch, 'utf8');
    let patch = fullPatch;
    if (usedBytes + bytes > maxBytes) {
      truncated = true;
      const remaining = Math.max(0, maxBytes - usedBytes);
      patch = remaining > 0 ? trimToBytes(fullPatch, remaining) : '';
      usedBytes = maxBytes;
    } else {
      usedBytes += bytes;
    }

    files.push({ path, status, additions, deletions, patch });
  }

  return { files, truncated };
}

function collectUntrackedFiles(dir: string, existingPaths: ReadonlySet<string>, remainingBytes: number): { files: TaskDiffFile[]; truncated: boolean } {
  const out = gitOut(dir, ['ls-files', '--others', '--exclude-standard']);
  if (!out) return { files: [], truncated: false };
  const names = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const files: TaskDiffFile[] = [];
  let budget = remainingBytes;
  let truncated = false;

  for (const relPath of names) {
    if (existingPaths.has(relPath)) continue;
    const fullPath = join(dir, relPath);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      files.push({
        path: relPath,
        status: 'added',
        additions: 0,
        deletions: 0,
        patch: `diff --git a/${relPath} b/${relPath}\nnew file\nBinary or large file (${stat.size} bytes)`,
      });
      continue;
    }

    let buf: Buffer;
    try {
      buf = readFileSync(fullPath);
    } catch {
      continue;
    }
    if (buf.includes(0)) {
      files.push({
        path: relPath,
        status: 'added',
        additions: 0,
        deletions: 0,
        patch: `diff --git a/${relPath} b/${relPath}\nnew file\nBinary file`,
      });
      continue;
    }

    const content = buf.toString('utf8').replace(/\r\n/g, '\n');
    const contentLines = content === '' ? [] : content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
    const body = contentLines.map((line) => `+${line}`).join('\n');
    const fullPatch = [
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relPath}`,
      ...(contentLines.length > 0 ? [`@@ -0,0 +1,${contentLines.length} @@`, body] : []),
    ].join('\n');

    const bytes = Buffer.byteLength(fullPatch, 'utf8');
    let patch = fullPatch;
    if (bytes > budget) {
      truncated = true;
      patch = budget > 0 ? trimToBytes(fullPatch, budget) : '';
      budget = 0;
    } else {
      budget -= bytes;
    }

    files.push({
      path: relPath,
      status: 'added',
      additions: contentLines.length,
      deletions: 0,
      patch,
    });
  }

  return { files, truncated };
}

interface RunSourceHead {
  head: string | null;
  remote_head: string | null;
  start: string | null;
  branch: string | null;
}

function parseSourceHead(run: RunRow | undefined): RunSourceHead | null {
  if (!run?.error_json) return null;
  try {
    const err = JSON.parse(run.error_json) as {
      source_head?: {
        head?: unknown;
        remote_head?: unknown;
        start?: unknown;
        branch?: unknown;
      };
    };
    const sh = err?.source_head;
    if (!sh || typeof sh !== 'object') return null;
    const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
    return {
      head: nonEmpty(sh.head),
      remote_head: nonEmpty(sh.remote_head),
      start: nonEmpty(sh.start),
      branch: nonEmpty(sh.branch),
    };
  } catch {
    return null;
  }
}

function commitFromRun(run: RunRow | undefined): string | null {
  if (!run) return null;
  if (run.receipt_json) {
    try {
      const receipt = JSON.parse(run.receipt_json);
      const delivery = deliveryOf(receipt);
      if (delivery.commit) return delivery.commit;
    } catch {
      // ignore invalid receipt
    }
  }
  const sh = parseSourceHead(run);
  return sh?.head ?? sh?.remote_head ?? null;
}

function startCommitForDiff(runs: readonly RunRow[], selectedRun: RunRow | undefined, runId?: string | null): string | null {
  if (runId) return parseSourceHead(selectedRun)?.start ?? null;
  for (const run of runs) {
    const start = parseSourceHead(run)?.start;
    if (start) return start;
  }
  return parseSourceHead(selectedRun)?.start ?? null;
}

function readGitDiff(dir: string, targetCommit: string | null, startCommit: string | null = null): TaskDiffResponse {
  const head = gitOut(dir, ['rev-parse', 'HEAD'])?.trim() || null;
  const rawBranch = gitOut(dir, ['symbolic-ref', '--short', 'HEAD'])?.trim() || null;
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;

  const inspectRef = targetCommit && targetCommit !== head && gitOut(dir, ['rev-parse', '--verify', `${targetCommit}^{commit}`]) !== null
    ? targetCommit
    : null;

  const ref = inspectRef ?? 'HEAD';
  let base: string | null = null;
  if (startCommit && gitOut(dir, ['rev-parse', '--verify', `${startCommit}^{commit}`]) !== null) {
    base = gitOut(dir, ['rev-parse', `${startCommit}^{commit}`])?.trim() || startCommit;
  }
  if (!base) {
    base = gitOut(dir, ['merge-base', ref, 'origin/HEAD'])?.trim() || null;
  }
  if (!base) {
    base = gitOut(dir, ['rev-parse', '--verify', `${ref}~1`])?.trim() || null;
  }

  const diffArgs = inspectRef
    ? (base ? ['diff', '--no-color', '--find-renames', base, inspectRef] : ['show', '--format=', '--no-color', '--find-renames', inspectRef])
    : (base ? ['diff', '--no-color', '--find-renames', base] : ['diff', '--no-color', '--find-renames', 'HEAD']);

  const rawDiff = gitOut(dir, diffArgs) ?? '';
  const parsed = parseUnifiedDiff(rawDiff, MAX_DIFF_BYTES);
  const usedBytes = parsed.files.reduce((sum, file) => sum + Buffer.byteLength(file.patch, 'utf8'), 0);

  let files = parsed.files;
  let truncated = parsed.truncated;

  if (!inspectRef) {
    const existing = new Set(files.map((f) => f.path));
    const untracked = collectUntrackedFiles(dir, existing, Math.max(0, MAX_DIFF_BYTES - usedBytes));
    if (untracked.files.length > 0) {
      files = [...files, ...untracked.files];
      truncated = truncated || untracked.truncated;
    }
  }

  return {
    source: 'git',
    commit: inspectRef ?? head,
    base,
    branch,
    files,
    truncated,
    ...(files.length === 0 ? { reason: NO_DIFF_REASON } : {}),
  };
}

function receiptFileChanges(run: RunRow): FileChange[] {
  if (!run.receipt_json) return [];
  try {
    const receipt = JSON.parse(run.receipt_json) as { file_changes?: unknown };
    if (!Array.isArray(receipt?.file_changes)) return [];
    const changes: FileChange[] = [];
    for (const item of receipt.file_changes) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as { path?: unknown; op?: unknown; status?: unknown; patch?: unknown };
      if (typeof rec.path !== 'string' || !rec.path.trim()) continue;
      const op = rec.op === 'add' || rec.status === 'added'
        ? 'add'
        : rec.op === 'delete' || rec.status === 'deleted'
          ? 'delete'
          : 'update';
      changes.push({
        path: rec.path.trim(),
        op,
        ...(typeof rec.patch === 'string' ? { patch: rec.patch } : {}),
      });
    }
    return changes;
  } catch {
    return [];
  }
}

function executorChangesToDiff(changes: readonly FileChange[]): { files: TaskDiffFile[]; truncated: boolean } {
  const byPath = new Map<string, { status: TaskDiffFile['status']; patches: string[] }>();
  for (const change of changes) {
    if (!change.path) continue;
    const mapped: TaskDiffFile['status'] = change.op === 'add' ? 'added' : change.op === 'delete' ? 'deleted' : 'modified';
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, { status: mapped, patches: change.patch ? [change.patch] : [] });
    } else {
      if (mapped === 'deleted') existing.status = 'deleted';
      else if (existing.status !== 'added') existing.status = mapped;
      if (change.patch) existing.patches.push(change.patch);
    }
  }

  const files: TaskDiffFile[] = [];
  let usedBytes = 0;
  let truncated = false;

  for (const [path, entry] of byPath) {
    const fullPatch = entry.patches.join('\n').replace(/\r\n/g, '\n').trimEnd();
    const { additions, deletions } = countPatchLines(fullPatch);
    const bytes = Buffer.byteLength(fullPatch, 'utf8');
    let patch = fullPatch;
    if (usedBytes + bytes > MAX_DIFF_BYTES) {
      truncated = true;
      const remaining = Math.max(0, MAX_DIFF_BYTES - usedBytes);
      patch = remaining > 0 ? trimToBytes(fullPatch, remaining) : '';
      usedBytes = MAX_DIFF_BYTES;
    } else {
      usedBytes += bytes;
    }
    files.push({ path, status: entry.status, additions, deletions, patch });
  }

  return { files, truncated };
}

function normalizePersistedFile(item: unknown): TaskDiffFile | null {
  if (!item || typeof item !== 'object') return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.path !== 'string' || rec.path.trim() === '') return null;
  const rawStatus = rec.status;
  const status: TaskDiffFile['status'] =
    rawStatus === 'added' || rawStatus === 'deleted' || rawStatus === 'renamed' || rawStatus === 'modified'
      ? rawStatus
      : 'modified';
  const patch = typeof rec.patch === 'string' ? rec.patch : '';
  const counts = countPatchLines(patch);
  const additions = typeof rec.additions === 'number' && Number.isFinite(rec.additions) ? rec.additions : counts.additions;
  const deletions = typeof rec.deletions === 'number' && Number.isFinite(rec.deletions) ? rec.deletions : counts.deletions;
  return { path: rec.path.trim(), status, additions, deletions, patch };
}

function readPersistedRunDiff(dataDir: string, taskId: string, run: RunRow): TaskDiffResponse | null {
  if (!isSafeSegment(taskId) || !isSafeSegment(run.id)) return null;
  const candidates = [
    join(dataDir, 'tasks', taskId, 'runs', run.id, 'diff.json'),
    join(dataDir, 'runs', run.id, 'diff.json'),
  ];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

      const sh = parseSourceHead(run);
      const source: TaskDiffResponse['source'] =
        parsed.source === 'git' || parsed.source === 'executor' || parsed.source === 'none'
          ? parsed.source
          : 'git';
      const commit = (typeof parsed.commit === 'string' && parsed.commit !== '' ? parsed.commit : null)
        ?? commitFromRun(run);
      const base = (typeof parsed.base === 'string' && parsed.base !== '' ? parsed.base : null)
        ?? sh?.start
        ?? null;
      const branch = (typeof parsed.branch === 'string' && parsed.branch !== '' ? parsed.branch : null)
        ?? sh?.branch
        ?? null;

      let files: TaskDiffFile[] = [];
      let truncated = parsed.truncated === true;

      if (Array.isArray(parsed.files)) {
        files = parsed.files.map(normalizePersistedFile).filter((f): f is TaskDiffFile => f !== null);
      } else if (typeof parsed.diff === 'string') {
        const fromUnified = parseUnifiedDiff(parsed.diff, MAX_DIFF_BYTES);
        files = fromUnified.files;
        truncated = truncated || fromUnified.truncated;
      } else if (typeof parsed.patch === 'string') {
        const fromUnified = parseUnifiedDiff(parsed.patch, MAX_DIFF_BYTES);
        files = fromUnified.files;
        truncated = truncated || fromUnified.truncated;
      } else {
        continue;
      }

      const reason = typeof parsed.reason === 'string' && parsed.reason !== ''
        ? parsed.reason
        : files.length === 0
          ? NO_DIFF_REASON
          : undefined;

      return {
        source,
        commit,
        base,
        branch,
        files,
        truncated,
        ...(reason !== undefined ? { reason } : {}),
      };
    } catch {
      // Ignore corrupt or unreadable persisted diff snapshot and try next candidate
    }
  }
  return null;
}

export async function readTaskDiff(options: ReadTaskDiffOptions): Promise<TaskDiffResponse> {
  const selectedRun = options.runId
    ? options.runs.find((run) => run.id === options.runId)
    : options.runs.at(-1);

  const localRepo = findLocalGitRepo(options.dataDir, options.task);
  if (localRepo !== null) {
    const targetCommit = options.runId ? commitFromRun(selectedRun) : null;
    const startCommit = startCommitForDiff(options.runs, selectedRun, options.runId);
    return readGitDiff(localRepo, targetCommit, startCommit);
  }

  // Fallback: persisted run diff.json (for remote nodes) or recorded executor file changes
  const candidateRuns = options.runId
    ? (selectedRun ? [selectedRun] : [])
    : [...options.runs].reverse();

  for (const run of candidateRuns) {
    const persisted = readPersistedRunDiff(options.dataDir, options.task.id, run);
    if (persisted !== null) return persisted;

    const collected: FileChange[] = [];
    if (options.readRunEvents) {
      try {
        const events = await options.readRunEvents(run);
        for (const event of events) {
          if (event.kind === 'tool.end' && Array.isArray(event.changes)) {
            collected.push(...event.changes);
          }
        }
      } catch {
        // Degrade gracefully when run events are unavailable
      }
    }
    if (collected.length === 0) {
      collected.push(...receiptFileChanges(run));
    }
    if (collected.length > 0) {
      const { files, truncated } = executorChangesToDiff(collected);
      if (files.length > 0) {
        const sh = parseSourceHead(run);
        return {
          source: 'executor',
          commit: commitFromRun(run),
          base: sh?.start ?? null,
          branch: sh?.branch ?? null,
          files,
          truncated,
        };
      }
    }
  }

  return {
    source: 'none',
    commit: null,
    base: null,
    branch: null,
    files: [],
    truncated: false,
    reason: NO_DIFF_REASON,
  };
}
