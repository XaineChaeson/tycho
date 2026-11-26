import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { InputError } from './errors.ts';

export const MAX_PROJECT_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TURN_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
export const PROJECT_FILE_KINDS = ['upload', 'artifact', 'doc'] as const;
export const PROJECT_FILE_ORIGINS = ['owner', 'router', 'worker'] as const;

export type ProjectFileKind = (typeof PROJECT_FILE_KINDS)[number];
export type ProjectFileOrigin = (typeof PROJECT_FILE_ORIGINS)[number];

export interface ProjectFileRow {
  id: string;
  project_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  kind: ProjectFileKind;
  origin: ProjectFileOrigin;
  summary: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectFileSummary {
  id: string;
  project_id: string;
  name: string;
  mime: string;
  size: number;
  kind: ProjectFileKind;
  origin: ProjectFileOrigin;
  summary: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
  previewable: boolean;
  is_image: boolean;
}

export function isProjectFileKind(value: unknown): value is ProjectFileKind {
  return typeof value === 'string' && (PROJECT_FILE_KINDS as readonly string[]).includes(value);
}

export function isProjectFileOrigin(value: unknown): value is ProjectFileOrigin {
  return typeof value === 'string' && (PROJECT_FILE_ORIGINS as readonly string[]).includes(value);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MAX_FILE_NAME_CHARS = 160;

const EXTENSION_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'application/xml',
  '.css': 'text/css',
};

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'text/javascript': 'application/javascript',
  'application/x-javascript': 'application/javascript',
  'text/xml': 'application/xml',
  'application/x-yaml': 'text/yaml',
  'text/x-yaml': 'text/yaml',
  'application/xhtml+xml': 'text/html',
};

export function normalizeProjectFileName(raw: string): string {
  const segments = raw.split(/[/\\]+/).filter((segment) => segment.length > 0);
  const base = segments.length > 0 ? segments[segments.length - 1]! : '';
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[/\\]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_FILE_NAME_CHARS)
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'untitled';
  return cleaned;
}

export function normalizeProjectFileMime(rawMime: string | undefined, fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  const fromExt = Object.hasOwn(EXTENSION_MIMES, ext) ? EXTENSION_MIMES[ext]! : undefined;
  const parsed = rawMime?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (parsed !== '' && VALID_MIME.test(parsed)) {
    const normalized = Object.hasOwn(MIME_ALIASES, parsed) ? MIME_ALIASES[parsed]! : parsed;
    if (normalized !== 'application/octet-stream' && normalized !== 'binary/octet-stream') {
      return normalized;
    }
  }
  return fromExt ?? 'application/octet-stream';
}

export function isRasterImageMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp';
}

export function matchesRasterImageMagic(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png':
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif': {
      if (bytes.length < 6) return false;
      const header = bytes.subarray(0, 6).toString('ascii');
      return header === 'GIF87a' || header === 'GIF89a';
    }
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    default:
      return false;
  }
}

export function parseAttachmentIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && item.trim() !== '' && !seen.has(item)) {
        seen.add(item);
        ids.push(item);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

export function isPreviewableArtifactMime(mime: string): boolean {
  return mime === 'text/html' || mime === 'image/svg+xml';
}

export function isTextFileMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'image/svg+xml' ||
    mime === 'application/xml' ||
    mime === 'application/javascript'
  );
}

export function toProjectFileSummary(row: ProjectFileRow): ProjectFileSummary {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    origin: row.origin,
    summary: row.summary,
    message_id: row.message_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    previewable: isPreviewableArtifactMime(row.mime),
    is_image: isRasterImageMime(row.mime),
  };
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new InputError(`${label}不合法：${value}`);
  }
}

export function projectFilesDir(dataDir: string, projectId: string): string {
  assertSafeId(projectId, '项目编号');
  return join(dataDir, 'projects', projectId, 'files');
}

export function projectFilePath(dataDir: string, projectId: string, fileId: string): string {
  assertSafeId(projectId, '项目编号');
  assertSafeId(fileId, '文件编号');
  return join(dataDir, 'projects', projectId, 'files', fileId);
}

export function writeProjectFileBytes(
  dataDir: string,
  projectId: string,
  fileId: string,
  bytes: Buffer,
): { size: number; sha256: string } {
  if (bytes.length > MAX_PROJECT_FILE_BYTES) {
    throw new InputError(`文件超过大小上限（最大 ${Math.floor(MAX_PROJECT_FILE_BYTES / (1024 * 1024))} MiB）`);
  }
  const dir = projectFilesDir(dataDir, projectId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = projectFilePath(dataDir, projectId, fileId);
  const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Ignore cleanup errors when propagating the primary write error.
    }
    throw err;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { size: bytes.length, sha256 };
}

export function readProjectFileBytes(dataDir: string, projectId: string, fileId: string): Buffer | null {
  const target = projectFilePath(dataDir, projectId, fileId);
  try {
    return readFileSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function removeProjectFileBytes(dataDir: string, projectId: string, fileId: string): void {
  const target = projectFilePath(dataDir, projectId, fileId);
  rmSync(target, { force: true });
}

// Two-phase deletion on the same filesystem: rename away before the ledger delete commits so
// permission/guard errors (e.g. frozen/transferred project) can cleanly restore the file
// without losing bytes, and successful deletes never leave orphan disk bytes behind.
export function stageRemoveProjectFileBytes(
  dataDir: string,
  projectId: string,
  fileId: string,
): { commit(): void; rollback(): void } {
  const target = projectFilePath(dataDir, projectId, fileId);
  const staged = `${target}.deleting.${randomBytes(4).toString('hex')}`;
  let moved = false;
  try {
    const stat = lstatSync(target);
    if (stat.isDirectory()) {
      const dirErr = Object.assign(new Error(`EISDIR: illegal operation on a directory, unlink '${target}'`), { code: 'EISDIR' });
      throw dirErr;
    }
    renameSync(target, staged);
    moved = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return {
    commit(): void {
      if (moved) rmSync(staged, { force: true });
    },
    rollback(): void {
      if (!moved) return;
      try {
        renameSync(staged, target);
      } catch {
        // Best-effort rollback.
      }
    },
  };
}

export function removeProjectFilesDir(dataDir: string, projectId: string): void {
  assertSafeId(projectId, '项目编号');
  rmSync(join(dataDir, 'projects', projectId), { recursive: true, force: true });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TYCHO_PREVIEW_THEME_STYLE = `<style id="tycho-artifact-theme">
:root {
  color-scheme: light dark;
  --canvas: #F2F4F8;
  --background: #FFFFFF;
  --raised: #FFFFFF;
  --muted: #F5F7FA;
  --border: #E3E7EE;
  --foreground: #0E1420;
  --muted-foreground: #525D6F;
  --primary: #2D5BE3;
  --series-1: #2A78D6;
  --series-2: #EB6834;
  --series-3: #1BAF7A;
  --series-4: #EDA100;
  --series-5: #E87BA4;
  --font-sans: 'Inter Variable', 'Noto Sans SC Variable', 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono Variable', ui-monospace, 'Cascadia Mono', Consolas, 'Noto Sans SC Variable', 'Microsoft YaHei UI', monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --canvas: #090B0F;
    --background: #0F1218;
    --raised: #161A22;
    --muted: #141820;
    --border: #1F2530;
    --foreground: #E9ECF2;
    --muted-foreground: #9BA4B5;
    --primary: #4A74F2;
    --series-1: #3987E5;
    --series-2: #D95926;
    --series-3: #199E70;
    --series-4: #C98500;
    --series-5: #D55181;
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --canvas: #F2F4F8;
  --background: #FFFFFF;
  --raised: #FFFFFF;
  --muted: #F5F7FA;
  --border: #E3E7EE;
  --foreground: #0E1420;
  --muted-foreground: #525D6F;
  --primary: #2D5BE3;
  --series-1: #2A78D6;
  --series-2: #EB6834;
  --series-3: #1BAF7A;
  --series-4: #EDA100;
  --series-5: #E87BA4;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --canvas: #090B0F;
  --background: #0F1218;
  --raised: #161A22;
  --muted: #141820;
  --border: #1F2530;
  --foreground: #E9ECF2;
  --muted-foreground: #9BA4B5;
  --primary: #4A74F2;
  --series-1: #3987E5;
  --series-2: #D95926;
  --series-3: #199E70;
  --series-4: #C98500;
  --series-5: #D55181;
}
</style>`;

const TYCHO_PREVIEW_BRIDGE_SCRIPT = `<script id="tycho-artifact-bridge">
(() => {
  const root = document.documentElement;
  const applyTheme = (theme) => {
    if (theme === 'light' || theme === 'dark') {
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
    }
  };
  if (root.dataset.theme === 'light' || root.dataset.theme === 'dark') {
    root.style.colorScheme = root.dataset.theme;
  }
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && typeof data === 'object' && data.type === 'tycho:artifact:theme') {
      applyTheme(data.theme);
    }
  });
  let lastHeight = 0;
  let timer = 0;
  const postHeight = () => {
    timer = 0;
    const body = document.body;
    const height = Math.ceil(Math.max(root.scrollHeight, body ? body.scrollHeight : 0));
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      try {
        window.parent.postMessage({ type: 'tycho:artifact:resize', height }, '*');
      } catch {
        // Ignore postMessage failures when opened standalone.
      }
    }
  };
  const schedule = () => {
    if (timer) return;
    timer = window.setTimeout(postHeight, 32);
  };
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    if (document.body) observer.observe(document.body);
  }
  window.addEventListener('load', postHeight);
  window.addEventListener('resize', schedule);
  schedule();
})();
</script>`;

function replaceLastCaseInsensitive(str: string, needle: string, replacement: string): string | null {
  const idx = str.toLowerCase().lastIndexOf(needle.toLowerCase());
  if (idx === -1) return null;
  return `${str.slice(0, idx)}${replacement}${str.slice(idx + needle.length)}`;
}

export function buildSandboxedPreviewHtml(
  raw: string,
  mime: string,
  title: string,
  themeHint?: 'light' | 'dark',
): string {
  const themeAttr = themeHint === 'light' || themeHint === 'dark' ? ` data-theme="${themeHint}"` : '';
  const safeTitle = escapeHtml(title);

  if (mime === 'image/svg+xml') {
    return `<!doctype html>
<html${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
${TYCHO_PREVIEW_THEME_STYLE}
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
}
.tycho-svg-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  padding: 16px;
}
.tycho-svg-stage > svg {
  max-width: 100%;
  height: auto;
  display: block;
}
</style>
</head>
<body>
<main class="tycho-svg-stage">${raw}</main>
${TYCHO_PREVIEW_BRIDGE_SCRIPT}
</body>
</html>`;
  }

  // text/html: full document vs fragment.
  if (/<!doctype\b|<html[\s>]/i.test(raw)) {
    let html = raw;
    if (themeHint === 'light' || themeHint === 'dark') {
      html = html.replace(/<html\b([^>]*)>/i, (match, attrs: string) => {
        if (/\bdata-theme\s*=/i.test(attrs)) return match;
        return `<html${attrs} data-theme="${themeHint}">`;
      });
    }
    const withHeadClose = replaceLastCaseInsensitive(html, '</head>', `${TYCHO_PREVIEW_THEME_STYLE}\n</head>`);
    if (withHeadClose !== null) {
      html = withHeadClose;
    } else if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${TYCHO_PREVIEW_THEME_STYLE}`);
    } else if (/<html\b[^>]*>/i.test(html)) {
      html = html.replace(/<html\b[^>]*>/i, (match) => `${match}\n${TYCHO_PREVIEW_THEME_STYLE}`);
    } else if (/<!doctype[^>]*>/i.test(html)) {
      html = html.replace(/<!doctype[^>]*>/i, (match) => `${match}\n${TYCHO_PREVIEW_THEME_STYLE}`);
    } else {
      html = `${TYCHO_PREVIEW_THEME_STYLE}\n${html}`;
    }
    const withBodyClose = replaceLastCaseInsensitive(html, '</body>', `${TYCHO_PREVIEW_BRIDGE_SCRIPT}\n</body>`);
    if (withBodyClose !== null) {
      html = withBodyClose;
    } else {
      const withHtmlClose = replaceLastCaseInsensitive(html, '</html>', `${TYCHO_PREVIEW_BRIDGE_SCRIPT}\n</html>`);
      html = withHtmlClose ?? `${html}\n${TYCHO_PREVIEW_BRIDGE_SCRIPT}`;
    }
    return html;
  }

  return `<!doctype html>
<html${themeAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
${TYCHO_PREVIEW_THEME_STYLE}
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 16px;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
}
code, pre { font-family: var(--font-mono); }
img, svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
${raw}
${TYCHO_PREVIEW_BRIDGE_SCRIPT}
</body>
</html>`;
}
