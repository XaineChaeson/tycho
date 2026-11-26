// Node-side incremental skill bundle mirror & safe executor directory linker (End-State 2).
// Zero runtime dependencies (Node 24 built-ins only).
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NodeLocalSkillSummary, NodeSkillsManifest, NodeSkillsReport } from '../shared/node-protocol.ts';
import { NODE_LOCAL_SKILL_DESC_MAX, NODE_LOCAL_SKILLS_MAX } from '../shared/node-protocol.ts';
import { computeManifestDigest, computeSkillBundleDigest, decodeTarGz } from '../service/skill-bundles.ts';
import { isUnsafeSlug } from '../service/skill-catalog.ts';
import { envHome } from './global-entry.ts';

interface LocalMirrorState {
  manifest_digest: string;
  items: Record<string, string>;
  links: Record<string, string[]>;
}

export interface SyncNodeSkillsOptions {
  mirrorDir: string;
  manifest: NodeSkillsManifest;
  fetchBundle: (slug: string) => Promise<Buffer>;
  linkDirs?: readonly string[];
  skipLinkDirs?: readonly string[];
}

const compareCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const dirLinkType = (): 'junction' | 'dir' => (process.platform === 'win32' ? 'junction' : 'dir');

function stripWinExtendedPrefix(p: string): string {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

function normalizeForCompare(fsPath: string): string {
  const cleaned = resolve(stripWinExtendedPrefix(fsPath));
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

function realpathOrResolve(fsPath: string): string {
  try {
    return realpathSync(fsPath);
  } catch {
    return resolve(fsPath);
  }
}

function isWithinDir(candidate: string, root: string): boolean {
  const rel = relative(normalizeForCompare(root), normalizeForCompare(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../') && !isAbsolute(rel));
}

function pathExistsNoFollow(target: string): boolean {
  return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

function isRegularSkillDir(dirPath: string): boolean {
  const st = lstatSync(dirPath, { throwIfNoEntry: false });
  if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) return false;
  return existsSync(join(dirPath, 'SKILL.md'));
}

function removeLinkOnly(linkPath: string): void {
  const st = lstatSync(linkPath, { throwIfNoEntry: false });
  if (st === undefined || !st.isSymbolicLink()) return;
  try {
    unlinkSync(linkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EISDIR') {
      rmdirSync(linkPath);
      return;
    }
    throw err;
  }
}

function readLinkResolvedTarget(linkPath: string): string | null {
  try {
    const raw = stripWinExtendedPrefix(readlinkSync(linkPath));
    return resolve(dirname(linkPath), raw);
  } catch {
    return null;
  }
}

function isLinkPointingInto(linkPath: string, mirrorDir: string, mirrorRealRoot: string): boolean {
  const direct = readLinkResolvedTarget(linkPath);
  if (direct !== null && (isWithinDir(direct, mirrorDir) || isWithinDir(direct, mirrorRealRoot))) {
    return true;
  }
  try {
    const real = realpathSync(linkPath);
    if (isWithinDir(real, mirrorDir) || isWithinDir(real, mirrorRealRoot)) {
      return true;
    }
  } catch {
    // Broken link: direct readlink check above already determined whether it points into mirrorDir.
  }
  return false;
}

function isLinkPointingToTarget(linkPath: string, expectedTarget: string): boolean {
  const direct = readLinkResolvedTarget(linkPath);
  if (direct === null) return false;
  if (normalizeForCompare(direct) === normalizeForCompare(expectedTarget)) return true;
  try {
    return normalizeForCompare(realpathSync(linkPath)) === normalizeForCompare(realpathSync(expectedTarget));
  } catch {
    return false;
  }
}

function loadLocalState(mirrorDir: string): LocalMirrorState {
  const manifestPath = join(mirrorDir, '.manifest.json');
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<LocalMirrorState>;
    const items: Record<string, string> = {};
    if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
      for (const [slug, digest] of Object.entries(raw.items)) {
        if (!isUnsafeSlug(slug) && typeof digest === 'string') {
          items[slug] = digest;
        }
      }
    }
    const links: Record<string, string[]> = {};
    if (raw.links && typeof raw.links === 'object' && !Array.isArray(raw.links)) {
      for (const [dir, slugs] of Object.entries(raw.links)) {
        if (typeof dir === 'string' && Array.isArray(slugs)) {
          links[dir] = slugs.filter((s): s is string => typeof s === 'string' && !isUnsafeSlug(s));
        }
      }
    }
    return {
      manifest_digest: typeof raw.manifest_digest === 'string' ? raw.manifest_digest : '',
      items,
      links,
    };
  } catch {
    return { manifest_digest: '', items: {}, links: {} };
  }
}

function saveLocalStateAtomic(mirrorDir: string, state: LocalMirrorState): void {
  const manifestPath = join(mirrorDir, '.manifest.json');
  const tmpPath = join(mirrorDir, `.manifest.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, manifestPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Ignore temp cleanup failure.
    }
    throw err;
  }
}

function atomicReplaceSkillDir(mirrorDir: string, slug: string, stageDir: string, targetDir: string): void {
  const backupDir = join(mirrorDir, `.old-${slug}-${randomBytes(4).toString('hex')}`);
  let movedOld = false;
  try {
    if (pathExistsNoFollow(targetDir)) {
      renameSync(targetDir, backupDir);
      movedOld = true;
    }
    renameSync(stageDir, targetDir);
  } catch (err) {
    if (movedOld && !pathExistsNoFollow(targetDir) && pathExistsNoFollow(backupDir)) {
      try {
        renameSync(backupDir, targetDir);
      } catch {
        // Best-effort rollback of previous copy.
      }
    }
    throw err;
  } finally {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {
      // Ignore staging cleanup error.
    }
    if (movedOld) {
      try {
        rmSync(backupDir, { recursive: true, force: true });
      } catch {
        // Ignore old backup cleanup error.
      }
    }
  }
}

function findPrevManagedSlugs(links: Record<string, string[]>, linkDir: string): string[] {
  const targetKey = normalizeForCompare(linkDir);
  const found = new Set<string>();
  for (const [dir, slugs] of Object.entries(links)) {
    if (normalizeForCompare(dir) === targetKey) {
      for (const slug of slugs) found.add(slug);
    }
  }
  return [...found];
}

export function defaultExecutorSkillDirs(env?: NodeJS.ProcessEnv, home?: string): string[] {
  const resolvedHome = home ?? envHome(env);
  return [
    join(resolvedHome, '.agents', 'skills'),
    join(resolvedHome, '.claude', 'skills'),
    join(resolvedHome, '.codex', 'skills'),
    join(resolvedHome, '.gemini', 'config', 'skills'),
  ];
}

export async function syncNodeSkills(options: SyncNodeSkillsOptions): Promise<NodeSkillsReport> {
  const mirrorDir = resolve(options.mirrorDir);
  mkdirSync(mirrorDir, { recursive: true });
  const mirrorRealRoot = realpathOrResolve(mirrorDir);

  const localState = loadLocalState(mirrorDir);
  const nextItems: Record<string, string> = {};
  const synced: string[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  const skippedKeys = new Set<string>();
  const errors: string[] = [];
  const desiredSlugs = new Set<string>();

  const addSkipped = (slug: string, reason: string): void => {
    const key = `${slug}\0${reason}`;
    if (skippedKeys.has(key)) return;
    skippedKeys.add(key);
    skipped.push({ slug, reason });
  };

  for (const item of options.manifest.items) {
    if (isUnsafeSlug(item.slug)) {
      const reason = '技能目录名包含非法字符，已跳过';
      addSkipped(item.slug, reason);
      errors.push(`${item.slug}：${reason}`);
      continue;
    }

    desiredSlugs.add(item.slug);
    const targetDir = join(mirrorDir, item.slug);
    const prevDigest = Object.hasOwn(localState.items, item.slug) ? localState.items[item.slug] : undefined;

    if (prevDigest === item.digest && isRegularSkillDir(targetDir)) {
      nextItems[item.slug] = item.digest;
      synced.push(item.slug);
      continue;
    }

    const stageDir = join(mirrorDir, `.stage-${item.slug}-${randomBytes(4).toString('hex')}`);
    try {
      const tarGz = await options.fetchBundle(item.slug);
      const files = decodeTarGz(tarGz);
      const actualDigest = computeSkillBundleDigest(files);
      if (actualDigest !== item.digest) {
        throw new Error(`摘要不匹配（期望 ${item.digest}，实际 ${actualDigest}）`);
      }

      mkdirSync(stageDir, { recursive: true });
      const stageReal = realpathOrResolve(stageDir);
      for (const file of files) {
        const destPath = join(stageDir, ...file.path.split('/'));
        if (!isWithinDir(destPath, stageDir) && !isWithinDir(destPath, stageReal)) {
          throw new Error(`技能包内文件路径越界：${file.path}`);
        }
        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, file.data, { mode: ((file.mode || 0o644) | 0o200) & 0o777 });
      }

      atomicReplaceSkillDir(mirrorDir, item.slug, stageDir, targetDir);
      nextItems[item.slug] = item.digest;
      synced.push(item.slug);
    } catch (err) {
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure for staging dir.
      }
      if (prevDigest !== undefined && isRegularSkillDir(targetDir)) {
        // Preserve previous valid synced copy so failed update never corrupts mirror.
        nextItems[item.slug] = prevDigest;
      }
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${item.slug}：${message}`);
    }
  }

  // Prune removed slugs from mirrorDir (only non-symlink directories).
  for (const oldSlug of Object.keys(localState.items)) {
    if (desiredSlugs.has(oldSlug) || isUnsafeSlug(oldSlug)) continue;
    const oldDir = join(mirrorDir, oldSlug);
    try {
      const st = lstatSync(oldDir, { throwIfNoEntry: false });
      if (st !== undefined && !st.isSymbolicLink() && st.isDirectory()) {
        rmSync(oldDir, { recursive: true, force: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`清理已移除技能 ${oldSlug} 失败：${message}`);
    }
  }

  // Build normalized set of directories to skip for linking (e.g. Host's own skills dir).
  const skipDirSet = new Set<string>([
    normalizeForCompare(mirrorDir),
    normalizeForCompare(mirrorRealRoot),
  ]);
  for (const skipDir of options.skipLinkDirs ?? []) {
    skipDirSet.add(normalizeForCompare(skipDir));
    skipDirSet.add(normalizeForCompare(realpathOrResolve(skipDir)));
  }

  const shouldSkipLinkDir = (dir: string): boolean =>
    skipDirSet.has(normalizeForCompare(dir)) || skipDirSet.has(normalizeForCompare(realpathOrResolve(dir)));

  const nextLinks: Record<string, string[]> = {};
  const activeMirrorSlugs = Object.keys(nextItems).sort(compareCodePoint);
  const visitedLinkDirKeys = new Set<string>();

  for (const rawLinkDir of options.linkDirs ?? []) {
    const linkDir = resolve(rawLinkDir);
    const linkDirKey = normalizeForCompare(linkDir);
    if (visitedLinkDirKeys.has(linkDirKey)) continue;
    visitedLinkDirKeys.add(linkDirKey);

    if (shouldSkipLinkDir(linkDir)) continue;

    const prevManaged = new Set<string>(findPrevManagedSlugs(localState.links, linkDir));
    const managedNow: string[] = [];

    for (const slug of activeMirrorSlugs) {
      const target = join(mirrorDir, slug);
      const linkPath = join(linkDir, slug);
      const st = lstatSync(linkPath, { throwIfNoEntry: false });

      if (st === undefined) {
        try {
          mkdirSync(linkDir, { recursive: true });
          symlinkSync(target, linkPath, dirLinkType());
          managedNow.push(slug);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          addSkipped(slug, `创建链接失败：${message}`);
        }
        continue;
      }

      if (!st.isSymbolicLink()) {
        // Real user-owned directory or file — never overwrite or delete.
        addSkipped(slug, '本地已存在非托管目录，已保留');
        continue;
      }

      const pointsIntoMirror = isLinkPointingInto(linkPath, mirrorDir, mirrorRealRoot);
      if (pointsIntoMirror) {
        if (!isLinkPointingToTarget(linkPath, target)) {
          try {
            removeLinkOnly(linkPath);
            symlinkSync(target, linkPath, dirLinkType());
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            addSkipped(slug, `更新链接失败：${message}`);
            continue;
          }
        }
        managedNow.push(slug);
      } else {
        // External symlink/junction not managed by Tycho — never overwrite or delete.
        addSkipped(slug, '本地已存在其他链接，已保留');
      }
    }

    // Prune links we previously created in this linkDir for removed slugs.
    for (const oldSlug of prevManaged) {
      if (Object.hasOwn(nextItems, oldSlug) || isUnsafeSlug(oldSlug)) continue;
      const linkPath = join(linkDir, oldSlug);
      const st = lstatSync(linkPath, { throwIfNoEntry: false });
      if (st !== undefined && st.isSymbolicLink() && isLinkPointingInto(linkPath, mirrorDir, mirrorRealRoot)) {
        try {
          removeLinkOnly(linkPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`清理旧链接 ${oldSlug} 失败：${message}`);
        }
      }
    }

    if (managedNow.length > 0) {
      nextLinks[linkDir] = [...new Set(managedNow)].sort(compareCodePoint);
    }
  }

  // Also prune removed slugs from any previously tracked linkDirs not in current options.linkDirs.
  for (const [prevDir, prevSlugs] of Object.entries(localState.links)) {
    const prevKey = normalizeForCompare(prevDir);
    if (visitedLinkDirKeys.has(prevKey)) continue;
    if (shouldSkipLinkDir(prevDir)) continue;
    const remaining: string[] = [];
    for (const slug of prevSlugs) {
      if (isUnsafeSlug(slug)) continue;
      if (Object.hasOwn(nextItems, slug)) {
        remaining.push(slug);
        continue;
      }
      const linkPath = join(prevDir, slug);
      const st = lstatSync(linkPath, { throwIfNoEntry: false });
      if (st !== undefined && st.isSymbolicLink() && isLinkPointingInto(linkPath, mirrorDir, mirrorRealRoot)) {
        try {
          removeLinkOnly(linkPath);
        } catch {
          // Best-effort cleanup of stale link.
        }
      }
    }
    if (remaining.length > 0) {
      nextLinks[prevDir] = [...new Set(remaining)].sort(compareCodePoint);
    }
  }

  let reportDigest: string;
  if (errors.length === 0) {
    reportDigest = options.manifest.digest;
  } else {
    const actualItemsDigest = computeManifestDigest(
      Object.entries(nextItems).map(([slug, digest]) => ({ slug, digest })),
    );
    reportDigest = actualItemsDigest !== options.manifest.digest ? actualItemsDigest : '';
  }

  saveLocalStateAtomic(mirrorDir, {
    manifest_digest: reportDigest,
    items: nextItems,
    links: nextLinks,
  });

  const sortedSynced = [...new Set(synced)].sort(compareCodePoint);
  const localSkills = options.linkDirs !== undefined
    ? scanLocalNonMirrorSkills({
        mirrorDir,
        linkDirs: options.linkDirs,
        skipLinkDirs: options.skipLinkDirs,
      })
    : [];
  return {
    digest: reportDigest,
    synced: sortedSynced,
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(localSkills.length > 0 ? { local_skills: localSkills } : {}),
    ...(errors.length > 0 ? { error: errors.join('；') } : {}),
  };
}

const LOCAL_SKILL_FRONTMATTER_MAX_BYTES = 8192;
const LOCAL_SKILL_NAME_MAX = 120;

function sanitizeSingleLine(text: string, maxLen: number): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readSkillHead(filePath: string): string | null {
  let fd: number | undefined;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    fd = openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(Math.min(st.size, LOCAL_SKILL_FRONTMATTER_MAX_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function extractLocalSkillMeta(slug: string, head: string): NodeLocalSkillSummary {
  let name = slug;
  let description = '';
  const fmMatch = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(head);
  if (fmMatch) {
    const lines = fmMatch[1]!.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1]!.toLowerCase();
      const rest = kv[2]!.trim();
      if (key !== 'name' && key !== 'description') continue;
      let value: string;
      if (/^[|>][+-]?\d*$/.test(rest)) {
        const blockLines: string[] = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j]!;
          if (next.trim() === '') {
            blockLines.push('');
            continue;
          }
          if (!/^[ \t]/.test(next)) break;
          blockLines.push(next.trim());
          i = j;
        }
        value = blockLines.join(' ');
      } else {
        value = unquoteYamlScalar(rest);
      }
      if (key === 'name' && value.trim()) name = sanitizeSingleLine(value, LOCAL_SKILL_NAME_MAX);
      if (key === 'description' && value.trim()) description = sanitizeSingleLine(value, NODE_LOCAL_SKILL_DESC_MAX);
    }
  }
  return {
    slug: sanitizeSingleLine(slug, LOCAL_SKILL_NAME_MAX),
    name: name || slug,
    description,
  };
}

// Scans executor skill directories on this node for non-mirror local skills (e.g. company-intranet
// skills not managed by the Host), returning only safe metadata (slug, name, short description).
// Never reads or returns SKILL.md bodies, scripts, or host paths.
export function scanLocalNonMirrorSkills(options: {
  mirrorDir: string;
  linkDirs?: readonly string[];
  skipLinkDirs?: readonly string[];
}): NodeLocalSkillSummary[] {
  const mirrorDir = resolve(options.mirrorDir);
  const mirrorRealRoot = realpathOrResolve(mirrorDir);
  const skipSet = new Set<string>([
    normalizeForCompare(mirrorDir),
    normalizeForCompare(mirrorRealRoot),
  ]);
  for (const skip of options.skipLinkDirs ?? []) {
    skipSet.add(normalizeForCompare(skip));
    skipSet.add(normalizeForCompare(realpathOrResolve(skip)));
  }

  const found = new Map<string, NodeLocalSkillSummary>();
  const visitedDirs = new Set<string>();
  for (const rawDir of options.linkDirs ?? []) {
    const dir = resolve(rawDir);
    const dirKey = normalizeForCompare(dir);
    if (visitedDirs.has(dirKey) || skipSet.has(dirKey) || skipSet.has(normalizeForCompare(realpathOrResolve(dir)))) {
      continue;
    }
    visitedDirs.add(dirKey);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const slug of entries.sort(compareCodePoint)) {
      if (slug.startsWith('.') || isUnsafeSlug(slug) || found.has(slug)) continue;
      const entryPath = join(dir, slug);
      const lst = lstatSync(entryPath, { throwIfNoEntry: false });
      if (lst === undefined) continue;
      if (lst.isSymbolicLink() && isLinkPointingInto(entryPath, mirrorDir, mirrorRealRoot)) {
        // Host-mirrored skill — not a node-private local skill.
        continue;
      }
      const skillFile = join(entryPath, 'SKILL.md');
      const head = readSkillHead(skillFile);
      if (head === null) continue;
      found.set(slug, extractLocalSkillMeta(slug, head));
      if (found.size >= NODE_LOCAL_SKILLS_MAX) break;
    }
    if (found.size >= NODE_LOCAL_SKILLS_MAX) break;
  }

  return [...found.values()].sort((a, b) => compareCodePoint(a.slug, b.slug));
}
