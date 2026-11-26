// Remote directory browser & safe single-segment folder creation/renaming for code source selection.
// Never lists or reads file contents, never deletes, and never crosses outside the named parent.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import type { NodeBrowseDirsResult, NodeCreateDirResult, NodeDirEntry, NodeRenameDirResult } from '../shared/node-protocol.ts';

const MAX_DIRS = 400;
const MAX_FILES = 200;
const MAX_NAME_LENGTH = 255;
const WIN_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export interface FsBrowseOptions {
  platform?: NodeJS.Platform;
  home?: string;
  roots?: string[];
}

export function validateDirSegment(raw: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof raw !== 'string') throw new Error('文件夹名称必须是文本');
  const name = raw.trim();
  if (name === '') throw new Error('文件夹名称不能为空');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`文件夹名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  if (name === '.' || name === '..') throw new Error('文件夹名称不能是 . 或 ..');
  if (/[\\/\0\x00-\x1f\x7f]/.test(name)) throw new Error('文件夹名称不能包含路径分隔符或控制字符');
  if (platform === 'win32') {
    if (/[<>:"|?*]/.test(name)) throw new Error('文件夹名称包含 Windows 不允许的字符');
    if (name.endsWith('.')) throw new Error('Windows 文件夹名称不能以句点结尾');
    if (WIN_RESERVED.test(name)) throw new Error(`文件夹名称不能使用 Windows 保留名：${name}`);
  }
  return name;
}

export function listRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['/'];
  const drives: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      if (statSync(drive, { throwIfNoEntry: false })?.isDirectory()) drives.push(drive);
    } catch {
      // Unready removable drive or denied volume: skip cleanly.
    }
  }
  return drives.length > 0 ? drives : ['C:\\'];
}

function readableDir(candidate: string): boolean {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

function errnoMessage(error: unknown, fallback: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return '目录不存在';
  if (code === 'EACCES' || code === 'EPERM') return '没有访问权限';
  if (code === 'ENOTDIR') return '目标不是文件夹';
  if (code === 'EEXIST') return '同名文件夹或文件已存在';
  if (code === 'EBUSY') return '目录正被其他程序占用';
  return fallback;
}

function isGitRepo(dir: string): boolean {
  try {
    return existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

export function browseDirs(
  input: { path?: unknown; show_hidden?: unknown } = {},
  options: FsBrowseOptions = {},
): NodeBrowseDirsResult {
  const platform = options.platform ?? process.platform;
  const pathLib = platform === 'win32' ? win32 : posix;
  const roots = options.roots ?? listRoots(platform);
  const homeCandidate = options.home ?? homedir();
  const home = readableDir(homeCandidate) ? resolve(homeCandidate) : roots[0]!;
  const showHidden = input.show_hidden === true;

  const asked = typeof input.path === 'string' ? input.path.trim() : '';
  let target: string;
  if (asked === '') {
    target = home;
  } else {
    if (!isAbsolute(asked) && !pathLib.isAbsolute(asked)) throw new Error('目录路径必须是绝对路径');
    target = resolve(asked);
  }

  let stat;
  try {
    stat = statSync(target);
  } catch (error) {
    throw new Error(`打不开目录 ${target}：${errnoMessage(error, '无法访问')}`);
  }
  if (!stat.isDirectory()) throw new Error(`${target} 不是文件夹`);

  let rawEntries;
  try {
    rawEntries = readdirSync(target, { withFileTypes: true });
  } catch (error) {
    throw new Error(`读取目录 ${target} 失败：${errnoMessage(error, '无法读取')}`);
  }

  const dirs: NodeDirEntry[] = [];
  const files: NodeDirEntry[] = [];
  for (const dirent of rawEntries) {
    const name = dirent.name;
    if (!showHidden && name.startsWith('.')) continue;
    const full = join(target, name);
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) {
      dirs.push({ name, path: full, kind: 'dir', ...(isGitRepo(full) ? { is_git: true } : {}) });
    } else {
      files.push({ name, path: full, kind: 'file' });
    }
  }

  const cmp = (a: NodeDirEntry, b: NodeDirEntry): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  dirs.sort(cmp);
  files.sort(cmp);

  const truncated = dirs.length > MAX_DIRS || files.length > MAX_FILES;
  const entries = [...dirs.slice(0, MAX_DIRS), ...files.slice(0, MAX_FILES)];
  const parentDir = dirname(target);
  const parent = parentDir === target ? null : parentDir;

  return {
    path: target,
    parent,
    home,
    roots,
    platform,
    entries,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function createDir(
  input: { parent?: unknown; name?: unknown },
  options: FsBrowseOptions = {},
): NodeCreateDirResult {
  const platform = options.platform ?? process.platform;
  if (typeof input.parent !== 'string' || input.parent.trim() === '') throw new Error('缺少父目录路径');
  const rawParent = input.parent.trim();
  if (!isAbsolute(rawParent)) throw new Error('父目录路径必须是绝对路径');
  const parent = resolve(rawParent);
  let parentStat;
  try {
    parentStat = statSync(parent);
  } catch (error) {
    throw new Error(`父目录不可访问：${errnoMessage(error, '无法访问')}`);
  }
  if (!parentStat.isDirectory()) throw new Error('父路径不是文件夹');

  const name = validateDirSegment(input.name, platform);
  const target = join(parent, name);
  if (dirname(target) !== parent) throw new Error('文件夹名称不合法');

  try {
    mkdirSync(target, { recursive: false });
  } catch (error) {
    throw new Error(`新建文件夹失败：${errnoMessage(error, '无法创建')}`);
  }
  return { path: target, name };
}

export function renameDir(
  input: { path?: unknown; name?: unknown },
  options: FsBrowseOptions = {},
): NodeRenameDirResult {
  const platform = options.platform ?? process.platform;
  if (typeof input.path !== 'string' || input.path.trim() === '') throw new Error('缺少要重命名的目录路径');
  const rawPath = input.path.trim();
  if (!isAbsolute(rawPath)) throw new Error('目录路径必须是绝对路径');
  const current = resolve(rawPath);
  const parent = dirname(current);
  if (parent === current) throw new Error('不能重命名根目录');

  let currentStat;
  try {
    currentStat = lstatSync(current);
  } catch (error) {
    throw new Error(`目录不可访问：${errnoMessage(error, '无法访问')}`);
  }
  if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) throw new Error('只能重命名普通文件夹');

  const name = validateDirSegment(input.name, platform);
  const nextPath = join(parent, name);
  if (dirname(nextPath) !== parent) throw new Error('文件夹名称不合法');
  if (nextPath === current) return { path: current, name };

  const caseOnlyChange = platform === 'win32' && current.toLowerCase() === nextPath.toLowerCase();
  if (!caseOnlyChange && existsSync(nextPath)) {
    throw new Error(`目标名称 "${name}" 已存在`);
  }

  try {
    renameSync(current, nextPath);
  } catch (error) {
    throw new Error(`重命名文件夹失败：${errnoMessage(error, '无法重命名')}`);
  }
  return { path: nextPath, name };
}
