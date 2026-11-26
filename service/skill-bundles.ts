// Pure Node USTAR/PAX tar+gzip skill bundle packager, deterministic bundle collector,
// and per-machine authorization manifest builder (End-State 2).
// Zero runtime dependencies (Node 24 built-ins only).
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { NodeSkillBundleItem, NodeSkillsManifest } from '../shared/node-protocol.ts';
import type { DirectorySkill, EntryMachinesMap, SkillRegistryMap } from '../shared/skill-catalog.ts';
import { isUnsafeSlug, scanSkillDirectory } from './skill-catalog.ts';

export const MAX_SKILL_BUNDLE_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_FILES = 2000;

const TAR_BLOCK_SIZE = 512;
const MAX_PAX_HEADER_BYTES = 64 * 1024;
const SKIP_DIR_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store']);
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

export interface SkillBundleFile {
  path: string;
  data: Buffer;
  mode: number;
}

export interface CollectedSkillBundle {
  files: SkillBundleFile[];
  digest: string;
  bytes: number;
}

const compareCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonicalForCompare(fsPath: string): string {
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const rel = relative(canonicalForCompare(rootPath), canonicalForCompare(targetPath));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../') && !isAbsolute(rel));
}

const WINDOWS_ILLEGAL_CHAR_RE = /[<>:"|?*\x00-\x1f]/;

function validateBundleEntryPath(entryPath: string, allowDirectory = false): string {
  if (entryPath === '') {
    throw new Error('Invalid tar entry path: empty path');
  }
  if (entryPath.includes('\0') || entryPath.includes('\\') || WINDOWS_ILLEGAL_CHAR_RE.test(entryPath)) {
    throw new Error(`Invalid tar entry path: forbidden character in ${JSON.stringify(entryPath)}`);
  }
  if (entryPath.startsWith('/') || WINDOWS_DRIVE_RE.test(entryPath)) {
    throw new Error(`Invalid tar entry path: absolute or drive-prefixed path ${JSON.stringify(entryPath)}`);
  }
  const normalized = allowDirectory && entryPath.endsWith('/') ? entryPath.slice(0, -1) : entryPath;
  if (normalized === '') {
    throw new Error(`Invalid tar entry path: empty path ${JSON.stringify(entryPath)}`);
  }
  if (normalized.endsWith('/')) {
    throw new Error(`Invalid tar entry path: trailing slash in ${JSON.stringify(entryPath)}`);
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ')) {
      throw new Error(`Invalid tar entry path: unsafe segment in ${JSON.stringify(entryPath)}`);
    }
  }
  return normalized;
}

function encodeOctal(value: number, width: number): Buffer {
  const maxDigits = width - 1;
  const octal = value.toString(8);
  if (octal.length > maxDigits) {
    throw new Error(`Value ${value} exceeds octal field width ${width}`);
  }
  return Buffer.from(`${octal.padStart(maxDigits, '0')}\0`, 'ascii');
}

function parseOctal(block: Buffer, offset: number, length: number): number {
  let raw = block.subarray(offset, offset + length).toString('ascii');
  const nulIdx = raw.indexOf('\0');
  if (nulIdx !== -1) raw = raw.slice(0, nulIdx);
  raw = raw.trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid tar octal field: ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Tar octal field out of range: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function readNullTerminated(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const nulIdx = slice.indexOf(0);
  const end = nulIdx === -1 ? slice.length : nulIdx;
  return slice.subarray(0, end).toString('utf8');
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function splitUstarAsciiPath(filePath: string): { prefix: string; name: string } | null {
  if (!PRINTABLE_ASCII_RE.test(filePath)) return null;
  if (filePath.length <= 100) return { prefix: '', name: filePath };
  if (filePath.length > 255) return null;
  // Find the rightmost '/' where prefix <= 155 and name <= 100.
  const maxPrefix = Math.min(155, filePath.length - 2);
  for (let i = maxPrefix; i >= 1; i -= 1) {
    if (filePath[i] === '/') {
      const nameLen = filePath.length - i - 1;
      if (nameLen >= 1 && nameLen <= 100) {
        return { prefix: filePath.slice(0, i), name: filePath.slice(i + 1) };
      }
    }
  }
  return null;
}

function encodePaxRecord(keyword: string, value: string): Buffer {
  const body = Buffer.from(` ${keyword}=${value}\n`, 'utf8');
  let len = body.length + 1;
  while (true) {
    const lenStr = String(len);
    const total = lenStr.length + body.length;
    if (total === len) {
      return Buffer.concat([Buffer.from(lenStr, 'ascii'), body]);
    }
    len = total;
  }
}

function parsePaxRecords(buf: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < buf.length) {
    const spaceIdx = buf.indexOf(0x20, offset);
    if (spaceIdx === -1) {
      throw new Error('Invalid PAX header: missing length delimiter');
    }
    const lenStr = buf.subarray(offset, spaceIdx).toString('ascii');
    if (!/^\d+$/.test(lenStr)) {
      throw new Error('Invalid PAX header: non-numeric record length');
    }
    const recLen = Number.parseInt(lenStr, 10);
    if (!Number.isSafeInteger(recLen) || recLen < 4 || offset + recLen > buf.length) {
      throw new Error('Invalid PAX header: record length out of bounds');
    }
    if (buf[offset + recLen - 1] !== 0x0a) {
      throw new Error('Invalid PAX header: missing trailing newline');
    }
    const content = buf.subarray(spaceIdx + 1, offset + recLen - 1).toString('utf8');
    const eqIdx = content.indexOf('=');
    if (eqIdx === -1) {
      throw new Error('Invalid PAX header: missing key=value separator');
    }
    const key = content.slice(0, eqIdx);
    const val = content.slice(eqIdx + 1);
    records[key] = val;
    offset += recLen;
  }
  return records;
}

function buildTarHeader(opts: {
  name: string;
  prefix: string;
  mode: number;
  size: number;
  typeFlag: string;
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const nameBuf = Buffer.from(opts.name, 'utf8');
  const prefixBuf = Buffer.from(opts.prefix, 'utf8');
  if (nameBuf.length > 100 || prefixBuf.length > 155) {
    throw new Error('USTAR header name/prefix exceeds fixed field width');
  }
  nameBuf.copy(header, 0);
  encodeOctal(opts.mode & 0o777, 8).copy(header, 100);
  encodeOctal(0, 8).copy(header, 108); // uid
  encodeOctal(0, 8).copy(header, 116); // gid
  encodeOctal(opts.size, 12).copy(header, 124);
  encodeOctal(0, 12).copy(header, 136); // deterministic mtime = 0
  header.fill(0x20, 148, 156); // checksum placeholder spaces
  header[156] = opts.typeFlag.charCodeAt(0);
  Buffer.from('ustar\0', 'ascii').copy(header, 257);
  Buffer.from('00', 'ascii').copy(header, 263);
  encodeOctal(0, 8).copy(header, 329); // devmajor
  encodeOctal(0, 8).copy(header, 337); // devminor
  prefixBuf.copy(header, 345);

  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
    sum += header[i]!;
  }
  const chksum = `${sum.toString(8).padStart(6, '0')}\0 `;
  Buffer.from(chksum, 'ascii').copy(header, 148);
  return header;
}

function padToTarBlock(data: Buffer): Buffer {
  const rem = data.length % TAR_BLOCK_SIZE;
  if (rem === 0) return data;
  return Buffer.concat([data, Buffer.alloc(TAR_BLOCK_SIZE - rem)]);
}

function verifyHeaderChecksum(header: Buffer): void {
  const expected = parseOctal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  }
  if (sum !== expected) {
    throw new Error(`Invalid tar header checksum (expected ${expected}, computed ${sum})`);
  }
}

export function encodeTarGz(files: readonly { path: string; data: Buffer; mode?: number }[]): Buffer {
  const chunks: Buffer[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const validatedPath = validateBundleEntryPath(file.path, false);
    if (seen.has(validatedPath)) {
      throw new Error(`Duplicate tar entry path: ${validatedPath}`);
    }
    seen.add(validatedPath);

    const mode = (file.mode ?? 0o644) & 0o777;
    const size = file.data.length;
    const split = splitUstarAsciiPath(validatedPath);
    const needsPaxSize = size > 0o77777777777;

    if (split === null || needsPaxSize) {
      const paxParts: Buffer[] = [];
      if (split === null) paxParts.push(encodePaxRecord('path', validatedPath));
      if (needsPaxSize) paxParts.push(encodePaxRecord('size', String(size)));
      const paxPayload = Buffer.concat(paxParts);
      chunks.push(
        buildTarHeader({
          name: `PaxHeader/${index}`,
          prefix: '',
          mode: 0o644,
          size: paxPayload.length,
          typeFlag: 'x',
        }),
      );
      chunks.push(padToTarBlock(paxPayload));
      chunks.push(
        buildTarHeader({
          name: split ? split.name : `pax-entry-${index}`,
          prefix: split ? split.prefix : '',
          mode,
          size: needsPaxSize ? 0 : size,
          typeFlag: '0',
        }),
      );
    } else {
      chunks.push(
        buildTarHeader({
          name: split.name,
          prefix: split.prefix,
          mode,
          size,
          typeFlag: '0',
        }),
      );
    }

    if (size > 0) {
      chunks.push(padToTarBlock(file.data));
    }
  }

  // Standard POSIX tar EOF marker: two 512-byte zero blocks.
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(chunks));
}

export function decodeTarGz(
  gz: Buffer,
  limits?: { maxBytes?: number; maxFiles?: number },
): SkillBundleFile[] {
  const maxBytes = limits?.maxBytes ?? MAX_SKILL_BUNDLE_BYTES;
  const maxFiles = limits?.maxFiles ?? MAX_SKILL_BUNDLE_FILES;
  // Bound decompressed tar stream size to stop gzip bombs while allowing USTAR/PAX framing overhead.
  const maxOutputLength = maxBytes + maxFiles * 4096 + 8192;
  const tar = gunzipSync(gz, { maxOutputLength });

  if (tar.length % TAR_BLOCK_SIZE !== 0) {
    throw new Error(`Invalid tar archive length (${tar.length} is not a multiple of ${TAR_BLOCK_SIZE})`);
  }

  const files: SkillBundleFile[] = [];
  const seen = new Set<string>();
  const seenLower = new Set<string>();
  let totalBytes = 0;
  let pendingPax: Record<string, string> | null = null;
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) {
      if (pendingPax !== null) {
        throw new Error('Invalid tar archive: dangling PAX header before EOF');
      }
      break;
    }

    verifyHeaderChecksum(header);

    const rawName = readNullTerminated(header, 0, 100);
    const rawPrefix = readNullTerminated(header, 345, 155);
    const mode = parseOctal(header, 100, 8) & 0o777;
    const headerSize = parseOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]!);

    if (typeFlag === 'x' || typeFlag === 'g') {
      if (headerSize > MAX_PAX_HEADER_BYTES) {
        throw new Error(`PAX header exceeds limit (${headerSize} > ${MAX_PAX_HEADER_BYTES})`);
      }
      const dataStart = offset + TAR_BLOCK_SIZE;
      const dataEnd = dataStart + headerSize;
      const paddedSize = Math.ceil(headerSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
      const nextOffset = dataStart + paddedSize;
      if (dataEnd > tar.length || nextOffset > tar.length) {
        throw new Error('Truncated PAX header in tar archive');
      }
      const parsed = parsePaxRecords(tar.subarray(dataStart, dataEnd));
      if (typeFlag === 'x') {
        const merged: Record<string, string> = {};
        if (pendingPax !== null) Object.assign(merged, pendingPax);
        Object.assign(merged, parsed);
        pendingPax = merged;
      }
      offset = nextOffset;
      continue;
    }

    const pax = pendingPax;
    pendingPax = null;

    let entrySize = headerSize;
    if (pax?.size !== undefined) {
      if (!/^\d+$/.test(pax.size)) {
        throw new Error(`Invalid PAX size value: ${JSON.stringify(pax.size)}`);
      }
      const parsedSize = Number.parseInt(pax.size, 10);
      if (!Number.isSafeInteger(parsedSize) || parsedSize < 0) {
        throw new Error(`PAX size out of range: ${JSON.stringify(pax.size)}`);
      }
      entrySize = parsedSize;
    }

    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + entrySize;
    const paddedSize = Math.ceil(entrySize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const nextOffset = dataStart + paddedSize;
    if (dataEnd > tar.length || nextOffset > tar.length) {
      throw new Error('Truncated file entry in tar archive');
    }

    if (typeFlag === '1' || typeFlag === '2' || typeFlag === '3' || typeFlag === '4' || typeFlag === '6') {
      throw new Error(`Rejected unsafe tar entry type ${JSON.stringify(typeFlag)}`);
    }

    const entryPath = pax?.path ?? (rawPrefix !== '' ? `${rawPrefix}/${rawName}` : rawName);

    if (typeFlag === '5') {
      if (entrySize !== 0) {
        throw new Error('Invalid tar directory entry: non-zero size');
      }
      if (entryPath !== '.' && entryPath !== './') {
        validateBundleEntryPath(entryPath, true);
      }
      offset = nextOffset;
      continue;
    }

    if (typeFlag !== '0' && typeFlag !== '\0') {
      throw new Error(`Unsupported tar entry type ${JSON.stringify(typeFlag)}`);
    }

    const validatedPath = validateBundleEntryPath(entryPath, false);
    const lowerPath = validatedPath.toLowerCase();
    if (seen.has(validatedPath) || seenLower.has(lowerPath)) {
      throw new Error(`Duplicate tar entry path: ${validatedPath}`);
    }
    if (files.length + 1 > maxFiles) {
      throw new Error(`Tar archive exceeds max files limit (${maxFiles})`);
    }
    if (totalBytes + entrySize > maxBytes) {
      throw new Error(`Tar archive exceeds max bytes limit (${maxBytes})`);
    }

    const data = Buffer.from(tar.subarray(dataStart, dataEnd));
    seen.add(validatedPath);
    seenLower.add(lowerPath);
    totalBytes += data.length;
    files.push({ path: validatedPath, data, mode });
    offset = nextOffset;
  }

  if (pendingPax !== null) {
    throw new Error('Invalid tar archive: dangling PAX header before EOF');
  }

  return files;
}

export function computeSkillBundleDigest(files: readonly { path: string; data: Buffer }[]): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) => compareCodePoint(a.path, b.path));
  for (const file of sorted) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(String(file.data.length), 'ascii');
    hash.update('\0');
    hash.update(file.data);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function computeManifestDigest(items: readonly Pick<NodeSkillBundleItem, 'slug' | 'digest'>[]): string {
  const sorted = [...items].sort((a, b) => compareCodePoint(a.slug, b.slug));
  return createHash('sha256')
    .update(JSON.stringify(sorted.map((item) => [item.slug, item.digest])), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export function collectSkillBundleFiles(skillRootDir: string): CollectedSkillBundle {
  const realRoot = realpathSync(skillRootDir);
  const rootStat = statSync(realRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Skill root is not a directory: ${skillRootDir}`);
  }

  const files: SkillBundleFile[] = [];
  let totalBytes = 0;
  const visitedPaths = new Set<string>([canonicalForCompare(realRoot)]);
  const visitedInodes = new Set<string>();
  if (rootStat.ino !== 0) {
    visitedInodes.add(`${rootStat.dev}:${rootStat.ino}`);
  }

  const visitDir = (dirPath: string, relPrefix: string): void => {
    const entries: Dirent[] = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
      compareCodePoint(a.name, b.name),
    );
    for (const entry of entries) {
      if (SKIP_DIR_ENTRIES.has(entry.name)) continue;
      const relPosix = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      try {
        validateBundleEntryPath(relPosix, false);
      } catch {
        continue;
      }

      const fullPath = join(dirPath, entry.name);
      let lst;
      try {
        lst = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (lst.isSymbolicLink()) {
        let resolved: string;
        let targetStat;
        try {
          resolved = realpathSync(fullPath);
          if (!isWithinRoot(resolved, realRoot)) continue;
          targetStat = statSync(resolved);
        } catch {
          continue;
        }
        if (targetStat.isDirectory()) {
          const canon = canonicalForCompare(resolved);
          const inoKey = targetStat.ino !== 0 ? `${targetStat.dev}:${targetStat.ino}` : null;
          if (visitedPaths.has(canon) || (inoKey !== null && visitedInodes.has(inoKey))) continue;
          visitedPaths.add(canon);
          if (inoKey !== null) visitedInodes.add(inoKey);
          visitDir(resolved, relPosix);
        } else if (targetStat.isFile()) {
          if (files.length + 1 > MAX_SKILL_BUNDLE_FILES) {
            throw new Error(`Skill bundle exceeds max files limit (${MAX_SKILL_BUNDLE_FILES})`);
          }
          if (totalBytes + targetStat.size > MAX_SKILL_BUNDLE_BYTES) {
            throw new Error(`Skill bundle exceeds max bytes limit (${MAX_SKILL_BUNDLE_BYTES})`);
          }
          const data = readFileSync(resolved);
          if (totalBytes + data.length > MAX_SKILL_BUNDLE_BYTES) {
            throw new Error(`Skill bundle exceeds max bytes limit (${MAX_SKILL_BUNDLE_BYTES})`);
          }
          totalBytes += data.length;
          files.push({ path: relPosix, data, mode: targetStat.mode & 0o777 });
        }
        continue;
      }

      if (lst.isDirectory()) {
        const canon = canonicalForCompare(fullPath);
        const inoKey = lst.ino !== 0 ? `${lst.dev}:${lst.ino}` : null;
        if (visitedPaths.has(canon) || (inoKey !== null && visitedInodes.has(inoKey))) continue;
        visitedPaths.add(canon);
        if (inoKey !== null) visitedInodes.add(inoKey);
        visitDir(fullPath, relPosix);
        continue;
      }

      if (lst.isFile()) {
        if (files.length + 1 > MAX_SKILL_BUNDLE_FILES) {
          throw new Error(`Skill bundle exceeds max files limit (${MAX_SKILL_BUNDLE_FILES})`);
        }
        if (totalBytes + lst.size > MAX_SKILL_BUNDLE_BYTES) {
          throw new Error(`Skill bundle exceeds max bytes limit (${MAX_SKILL_BUNDLE_BYTES})`);
        }
        const data = readFileSync(fullPath);
        if (totalBytes + data.length > MAX_SKILL_BUNDLE_BYTES) {
          throw new Error(`Skill bundle exceeds max bytes limit (${MAX_SKILL_BUNDLE_BYTES})`);
        }
        totalBytes += data.length;
        files.push({ path: relPosix, data, mode: lst.mode & 0o777 });
      }
    }
  };

  visitDir(realRoot, '');
  files.sort((a, b) => compareCodePoint(a.path, b.path));
  const digest = computeSkillBundleDigest(files);
  return { files, digest, bytes: totalBytes };
}

export function isSkillAuthorizedForMachine(
  skill: DirectorySkill,
  activeLedgerIds: ReadonlySet<string>,
  entryMachines: EntryMachinesMap,
  machineId: string,
): boolean {
  if (skill.managed_ledger_id !== null) {
    if (!activeLedgerIds.has(skill.managed_ledger_id)) return false;
    const allowed = Object.hasOwn(entryMachines, skill.managed_ledger_id)
      ? entryMachines[skill.managed_ledger_id]
      : null;
    return allowed === null || allowed === undefined || allowed.includes(machineId);
  }
  if (!skill.binding.enabled) return false;
  return skill.binding.machine_ids === null || skill.binding.machine_ids.includes(machineId);
}

export function buildMachineSkillsManifest(input: {
  skillsDir: string | null;
  registry: SkillRegistryMap;
  entryMachines: EntryMachinesMap;
  activeLedgerIds: ReadonlySet<string>;
  machineId: string;
}): NodeSkillsManifest {
  if (input.skillsDir === null || input.skillsDir.trim() === '') {
    return { digest: computeManifestDigest([]), items: [] };
  }

  const scan = scanSkillDirectory(input.skillsDir, input.registry);
  const items: NodeSkillBundleItem[] = [];

  for (const skill of scan.skills) {
    if (!isSkillAuthorizedForMachine(skill, input.activeLedgerIds, input.entryMachines, input.machineId)) {
      continue;
    }
    try {
      const bundle = collectSkillBundleFiles(join(input.skillsDir, skill.slug));
      items.push({
        slug: skill.slug,
        digest: bundle.digest,
        bytes: bundle.bytes,
      });
    } catch {
      // Skip unreadable or oversized bundles without crashing the manifest.
    }
  }

  items.sort((a, b) => compareCodePoint(a.slug, b.slug));
  return {
    digest: computeManifestDigest(items),
    items,
  };
}

export function packAuthorizedSkillBundle(input: {
  skillsDir: string | null;
  registry: SkillRegistryMap;
  entryMachines: EntryMachinesMap;
  activeLedgerIds: ReadonlySet<string>;
  machineId: string;
  slug: string;
}): { tarGz: Buffer; digest: string; bytes: number } | null {
  if (input.skillsDir === null || input.skillsDir.trim() === '') return null;
  if (isUnsafeSlug(input.slug)) return null;

  const scan = scanSkillDirectory(input.skillsDir, input.registry);
  const skill = scan.skills.find((s) => s.slug === input.slug);
  if (!skill) return null;

  if (!isSkillAuthorizedForMachine(skill, input.activeLedgerIds, input.entryMachines, input.machineId)) {
    return null;
  }

  try {
    const collected = collectSkillBundleFiles(join(input.skillsDir, skill.slug));
    const tarGz = encodeTarGz(collected.files);
    return { tarGz, digest: collected.digest, bytes: collected.bytes };
  } catch {
    return null;
  }
}
