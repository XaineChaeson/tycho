// A handoff carries only immutable registrations, never receipt paths or native sessions.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from './errors.ts';
import { readBoundArtifact } from './artifact-file.ts';
import { artifactNameIsUsable, nameIsSafe, registrationDir, sameBytes, type ReleaseFile } from './releases.ts';
import type { HandoffRow } from './project-handoff-knowledge.ts';

export const HANDOFF_LIMIT = 64 * 1024 * 1024;
export interface HandoffFile extends ReleaseFile { run_id: string; registration_id: string; body: Buffer }
interface Manifest { run_id: string; registration_id: string; files: ReleaseFile[] }
const fail = (text: string): never => { throw new InputError('登记文件移交：' + text); };
const keyOf = (file: Omit<HandoffFile, 'body'>): string => JSON.stringify([file.run_id, file.registration_id, file.name]);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function fileInfo(value: unknown): ReleaseFile {
  if (!exact(value, ['name', 'bytes', 'sha256']) || typeof value.name !== 'string' || !artifactNameIsUsable(value.name)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('文件登记形状无效');
  const row = value as Record<string, unknown>;
  return { name: row.name as string, bytes: row.bytes as number, sha256: row.sha256 as string };
}
function registration(value: unknown): { id: string; at: string; files: ReleaseFile[] } {
  if (!exact(value, ['id', 'at', 'files']) || typeof value.id !== 'string' || !nameIsSafe(value.id) || typeof value.at !== 'string' || !Array.isArray(value.files)) fail('登记清单无效');
  const row = value as Record<string, unknown>;
  const files = (row.files as unknown[]).map(fileInfo).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (new Set(files.map(file => file.name.toLowerCase())).size !== files.length) fail('登记文件名重复或在目标文件系统上冲突');
  return { id: row.id as string, at: row.at as string, files };
}
export function registeredManifests(runs: readonly HandoffRow[], changes: readonly HandoffRow[]): Manifest[] {
  const result: Manifest[] = [];
  for (const run of runs) {
    if (!nameIsSafe(String(run.id))) fail('轮次编号无效');
    // Retention is an existing fact; a receipt is never a path to fetch or guess from.
    if (run.releases_dropped_at !== null) continue;
    const receipt = run.receipt_json == null ? null : JSON.parse(String(run.receipt_json)) as { artifacts?: unknown } | null;
    const declaresFile = Array.isArray(receipt?.artifacts) && receipt.artifacts.some(item => item !== null && typeof item === 'object' && (item as { kind?: unknown }).kind === 'file');
    const missingFiles = (): never => fail(`Run ${run.id} 声明了文件，但没有可移交的登记文件材料。请先在源服务正常取回并登记产物，再移交项目；若源材料已不可达，当前无法核实或移交该项目。`);
    if (run.artifacts_json === null) {
      if (declaresFile) missingFiles();
      continue;
    }
    let hasPortableFiles = false;
    const held = JSON.parse(String(run.artifacts_json)) as { registration?: unknown; registered?: unknown; problem?: unknown };
    if (!held || !Array.isArray(held.registered) || held.registered.some(id => typeof id !== 'string' || !nameIsSafe(id))
      || new Set(held.registered).size !== held.registered.length) fail(`登记历史无效：${run.id}`);
    const current = held.registration === null ? null : registration(held.registration);
    if (current && !(held.registered as string[]).includes(current.id)) fail(`当前登记不在历史内：${run.id}`);
    const recorded = changes.filter(row => row.action === 'run.artifacts' && row.run_id === run.id).map(row => registration(JSON.parse(String(row.detail_json))));
    if (current) recorded.push(current);
    for (const id of held.registered as string[]) {
      const versions = recorded.filter(item => item.id === id), first = versions[0];
      if (!first) fail(`缺少历史登记清单：${run.id}/${id}`);
      if (versions.some(item => JSON.stringify(item) !== JSON.stringify(first))) fail(`登记清单冲突：${run.id}/${id}`);
      hasPortableFiles ||= first!.files.length > 0;
      result.push({ run_id: String(run.id), registration_id: id, files: first!.files });
    }
    if (declaresFile && !hasPortableFiles) missingFiles();
  }
  const paths = result.map(item => (item.run_id + '/' + item.registration_id).toLowerCase());
  if (new Set(paths).size !== paths.length) fail('登记目录在目标文件系统上冲突');
  return result.sort((a, b) => (a.run_id + '/' + a.registration_id).localeCompare(b.run_id + '/' + b.registration_id, 'en'));
}
function regularPath(root: string, parts: readonly string[], leaf: boolean): string {
  let path = realpathSync(root);
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]!);
    const stat = lstatSync(path);
    if (index === parts.length - 1 && leaf ? !stat.isFile() : !stat.isDirectory()) fail(`不是受管普通路径：${path}`);
  }
  return path;
}
function exactMembers(directory: string, names: readonly string[]): void {
  const actual = readdirSync(directory).sort(), expected = [...names].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`目录成员与登记不符：${directory}`);
}
function boundBytes(path: string, file: ReleaseFile): Buffer {
  const body = readBoundArtifact(path, file);
  if (body === null) fail(`文件缺失、大小或摘要不符：${path}`);
  return body!;
}
export function collectHandoffFiles(dataDir: string, runs: readonly HandoffRow[], changes: readonly HandoffRow[]): HandoffFile[] {
  const result: HandoffFile[] = [];
  const manifests = registeredManifests(runs, changes);
  let total = 0;
  for (const manifest of manifests) for (const file of manifest.files) {
    if (file.bytes > HANDOFF_LIMIT - total) fail('读取前发现文件超过有界包预算');
    total += file.bytes;
  }
  for (const manifest of manifests) {
    if (!manifest.files.length) continue;
    const directory = regularPath(dataDir, ['releases', manifest.run_id, manifest.registration_id], false);
    exactMembers(directory, manifest.files.map(file => file.name));
    for (const file of manifest.files) {
      const path = regularPath(dataDir, ['releases', manifest.run_id, manifest.registration_id, file.name], true);
      result.push({ ...file, run_id: manifest.run_id, registration_id: manifest.registration_id, body: boundBytes(path, file) });
    }
  }
  return result;
}
export function handoffFileWire(files: readonly HandoffFile[]): unknown[] {
  return files.map(({ body, ...file }) => ({ ...file, base64: body.toString('base64') }));
}
// Wire decoding is done once. All subsequent I/O takes verified byte buffers.
export function parseHandoffFiles(value: unknown, runs: readonly HandoffRow[], changes: readonly HandoffRow[]): HandoffFile[] {
  if (!Array.isArray(value)) fail('缺少文件清单');
  const expected = new Map(registeredManifests(runs, changes).flatMap(manifest => manifest.files.map(file => {
    const item = { ...file, run_id: manifest.run_id, registration_id: manifest.registration_id };
    return [keyOf(item), item] as const;
  })));
  const result: HandoffFile[] = [];
  let total = 0;
  for (const raw of value as unknown[]) {
    if (!exact(raw, ['run_id', 'registration_id', 'name', 'bytes', 'sha256', 'base64']) || typeof raw.run_id !== 'string'
      || !nameIsSafe(raw.run_id) || typeof raw.registration_id !== 'string' || !nameIsSafe(raw.registration_id) || typeof raw.base64 !== 'string') fail('文件清单形状无效');
    const row = raw as Record<string, unknown>;
    const file = { ...fileInfo({ name: row.name, bytes: row.bytes, sha256: row.sha256 }), run_id: row.run_id as string, registration_id: row.registration_id as string };
    if (file.bytes > HANDOFF_LIMIT - total) fail('解码后文件超过有界包预算');
    total += file.bytes;
    const encoded = row.base64 as string;
    if (encoded.length !== 4 * Math.ceil(file.bytes / 3)) fail('编码大小与登记不符');
    const body = Buffer.from(encoded, 'base64'), wanted = expected.get(keyOf(file));
    if (!wanted || wanted.bytes !== file.bytes || wanted.sha256 !== file.sha256 || !sameBytes(body, file) || body.toString('base64') !== encoded) fail(`文件不匹配登记：${keyOf(file)}`);
    expected.delete(keyOf(file));
    result.push({ ...file, body });
  }
  if (expected.size) fail('缺少登记文件内容');
  return result.sort((a, b) => keyOf(a).localeCompare(keyOf(b), 'en'));
}

// Only an already complete, receipt-bound preparation may explain existing destinations.
// A failed unpublished preparation is this call's private directory, never an unknown path.
export function prepareHandoffFiles(dataDir: string, files: readonly HandoffFile[], transfer: string, bundleHash: string): void {
  if (!files.length) return;
  const releases = join(dataDir, 'releases');
  mkdirSync(releases, { recursive: true });
  regularPath(dataDir, ['releases'], false);
  const pending = join(releases, '.project-handoff-' + transfer);
  const groups = new Map<string, HandoffFile[]>();
  for (const file of files) {
    const key = JSON.stringify([file.run_id, file.registration_id]);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const planned = [...groups.values()].map((group, index) => ({ group, temporary: 'registration-' + index }));
  const manifest = JSON.stringify({ transfer, bundleHash, files: files.map(({ body, ...file }) => file) });
  if (lstatSync(pending, { throwIfNoEntry: false })) {
    regularPath(dataDir, ['releases', '.project-handoff-' + transfer], false);
    const stored = regularPath(dataDir, ['releases', '.project-handoff-' + transfer, 'manifest.json'], true);
    if (readFileSync(stored, 'utf8') !== manifest) fail('既有暂存目录不是同一移交');
  } else {
    for (const { group } of planned) {
      const first = group[0]!;
      if (lstatSync(join(releases, first.run_id), { throwIfNoEntry: false })) fail('未知既有登记目录，不覆盖');
    }
    const fresh = mkdtempSync(join(releases, '.handoff-preparing-'));
    try {
      for (const { group, temporary } of planned) {
        const directory = join(fresh, temporary);
        mkdirSync(directory, { mode: 0o700 });
        for (const file of group) writeFileSync(join(directory, file.name), file.body, { flag: 'wx', mode: 0o600 });
      }
      writeFileSync(join(fresh, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
      renameSync(fresh, pending);
    } finally { if (lstatSync(fresh, { throwIfNoEntry: false })) rmSync(fresh, { recursive: true }); }
  }
  const allowed = new Set(['manifest.json', ...planned.map(item => item.temporary)]);
  if (readdirSync(pending).some(name => !allowed.has(name))) fail('暂存目录包含未知成员');
  for (const { group, temporary } of planned) {
    const first = group[0]!, target = registrationDir(dataDir, first.run_id, first.registration_id);
    const source = join(pending, temporary);
    if (lstatSync(target, { throwIfNoEntry: false })) {
      const directory = regularPath(dataDir, ['releases', first.run_id, first.registration_id], false);
      exactMembers(directory, group.map(file => file.name));
      for (const file of group) boundBytes(regularPath(dataDir, ['releases', file.run_id, file.registration_id, file.name], true), file);
      if (lstatSync(source, { throwIfNoEntry: false })) fail('同一登记同时出现在暂存与目标目录，不能猜归属');
      continue;
    }
    const directory = regularPath(dataDir, ['releases', '.project-handoff-' + transfer, temporary], false);
    exactMembers(directory, group.map(file => file.name));
    for (const file of group) boundBytes(regularPath(directory, [file.name], true), file);
    const runDir = join(releases, first.run_id);
    mkdirSync(runDir, { recursive: true });
    regularPath(dataDir, ['releases', first.run_id], false);
    renameSync(source, target);
  }
}


// Idempotent import also checks the bytes; an already owned project is not proof of file integrity.
export function verifyHandoffFiles(dataDir: string, files: readonly HandoffFile[]): void {
  const groups = new Map<string, HandoffFile[]>();
  for (const file of files) {
    const key = JSON.stringify([file.run_id, file.registration_id]);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const directory = regularPath(dataDir, ['releases', first.run_id, first.registration_id], false);
    exactMembers(directory, group.map(file => file.name));
    for (const file of group) boundBytes(regularPath(directory, [file.name], true), file);
  }
}
