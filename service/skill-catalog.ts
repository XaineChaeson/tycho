// Native <dataDir>/skills/ directory catalog, top-level Registry Map validation,
// safe atomic ledger-to-SKILL.md materializer, and Project x Role effective context calculator.
// Zero runtime dependencies (Node 24 built-ins only).
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { LOADINGS, type Loading } from '../shared/knowledge.ts';
import {
  DEFAULT_SKILL_BINDING,
  directorySkillId,
  isDirectorySkillId,
  type DirectorySkill,
  type EffectiveContextItem,
  type EffectiveContextReport,
  type EntryMachinesMap,
  type IgnoredSkillEntry,
  type SkillDirectoryScan,
  type SkillRegistryBinding,
  type SkillRegistryMap,
} from '../shared/skill-catalog.ts';
import { InputError } from './errors.ts';
import { bytes, type Entry, type KnowledgeLimits } from './knowledge.ts';
import { briefSections, givenAll, knowledgeOverLimit } from './knowledge-brief.ts';

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_FALLBACK_DESC_CHARS = 300;
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const LEDGER_MARKER_RE = /<!--\s*tycho-ledger:\s*([^\s@>]+)@(\d+)\s*-->/;
const LEADING_MARKER_LINE_RE = /^[ \t]*<!--\s*tycho-ledger:\s*([^\s@>]+)@(\d+)\s*-->[ \t]*(?:\r?\n|$)/;
const BLOCK_SCALAR_HEADER_RE = /^([|>])(?:([+-])(\d*)|(\d*)([+-]?))(?:[ \t]+#.*)?$/;

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  body: string;
  managedLedgerId: string | null;
}

const compareCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const WINDOWS_ILLEGAL_SLUG_RE = /[<>:"|?*\x00-\x1f]/;

export function isUnsafeSlug(slug: string): boolean {
  return (
    slug === '' ||
    slug !== slug.trim() ||
    slug.length > 128 ||
    slug.startsWith('.') ||
    slug.includes('/') ||
    slug.includes('\\') ||
    slug.includes('..') ||
    slug.includes('\0') ||
    WINDOWS_ILLEGAL_SLUG_RE.test(slug) ||
    slug === '__proto__' ||
    slug === 'constructor' ||
    slug === 'prototype'
  );
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith('"')) {
    let end = -1;
    for (let i = 1; i < trimmed.length; i += 1) {
      if (trimmed[i] === '\\') {
        i += 1;
        continue;
      }
      if (trimmed[i] === '"') {
        end = i;
        break;
      }
    }
    if (end !== -1) {
      const quoted = trimmed.slice(0, end + 1);
      try {
        return JSON.parse(quoted) as string;
      } catch {
        return quoted
          .slice(1, -1)
          .replace(/\\(["\\\/bfnrt])/g, (_m, ch: string) => {
            if (ch === 'n') return '\n';
            if (ch === 'r') return '\r';
            if (ch === 't') return '\t';
            if (ch === 'b') return '\b';
            if (ch === 'f') return '\f';
            return ch;
          });
      }
    }
  }
  if (trimmed.startsWith("'")) {
    let end = -1;
    for (let i = 1; i < trimmed.length; i += 1) {
      if (trimmed[i] === "'") {
        if (trimmed[i + 1] === "'") {
          i += 1;
          continue;
        }
        end = i;
        break;
      }
    }
    if (end !== -1) {
      return trimmed.slice(1, end).replace(/''/g, "'");
    }
  }
  return trimmed.replace(/[ \t]+#.*$/, '').trim();
}

function decodeBlockScalar(lines: readonly string[], style: '|' | '>', explicitIndent: number): string {
  let baseIndent = explicitIndent;
  if (baseIndent <= 0) {
    for (const line of lines) {
      if (line.trim() === '') continue;
      if (line.startsWith('\t')) {
        baseIndent = 1;
      } else {
        baseIndent = /^ */.exec(line)![0]!.length;
      }
      break;
    }
  }
  const stripped = lines.map((line) => {
    if (line.trim() === '') return '';
    if (line.startsWith('\t') && baseIndent === 1) return line.slice(1);
    const spaces = /^ */.exec(line)![0]!.length;
    return line.slice(Math.min(spaces, baseIndent));
  });
  while (stripped.length > 0 && stripped.at(-1) === '') stripped.pop();
  if (stripped.length === 0) return '';
  if (style === '|') return stripped.join('\n').trim();

  // Folded scalar (`>`, `>-`, `>+`): fold single newlines between normal-indent lines into spaces,
  // preserve paragraph breaks (empty lines) and newlines around more-indented lines.
  let out = '';
  let emptyCount = 0;
  let prevKind: 'none' | 'normal' | 'more' = 'none';
  for (const line of stripped) {
    if (line === '') {
      if (prevKind !== 'none') emptyCount += 1;
      continue;
    }
    const isMore = line.startsWith(' ') || line.startsWith('\t');
    if (prevKind === 'none') {
      out = line;
    } else if (!isMore && prevKind === 'normal') {
      out += emptyCount === 0 ? ` ${line}` : `${'\n'.repeat(emptyCount)}${line}`;
    } else {
      out += `${'\n'.repeat(emptyCount + 1)}${line}`;
    }
    emptyCount = 0;
    prevKind = isMore ? 'more' : 'normal';
  }
  return out.trim();
}

function parseFrontmatterFields(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue;
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const rest = match[2]!.trimEnd();
    const blockMatch = BLOCK_SCALAR_HEADER_RE.exec(rest.trim());
    if (blockMatch) {
      const style = blockMatch[1] as '|' | '>';
      const indentStr = blockMatch[3] || blockMatch[4] || '';
      const explicitIndent = indentStr === '' ? 0 : Number.parseInt(indentStr, 10);
      const blockLines: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() === '') {
          blockLines.push(next);
          i += 1;
          continue;
        }
        if (/^[ \t]/.test(next)) {
          blockLines.push(next);
          i += 1;
          continue;
        }
        break;
      }
      fields[key] = decodeBlockScalar(blockLines, style, explicitIndent);
      continue;
    }
    fields[key] = unquoteYamlScalar(rest);
  }
  return fields;
}

function stripLeadingMarker(text: string): { id: string | null; rest: string } {
  let rest = text;
  let id: string | null = null;
  while (true) {
    const trimmedStart = rest.replace(/^(?:[ \t]*\r?\n)+/, '');
    const match = LEADING_MARKER_LINE_RE.exec(trimmedStart);
    if (!match) break;
    if (id === null) id = match[1]!;
    rest = trimmedStart.slice(match[0].length);
  }
  return { id, rest };
}

function fallbackDescription(body: string, fallbackName: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const prose = lines.find(
    (line) =>
      line !== '' &&
      !line.startsWith('#') &&
      !line.startsWith('```') &&
      !line.startsWith('<!--') &&
      !line.startsWith('---') &&
      !line.startsWith('***'),
  );
  return prose ? clip(prose, MAX_FALLBACK_DESC_CHARS) : fallbackName;
}

export function parseSkillMarkdown(raw: string, fallbackName: string): ParsedSkillMarkdown {
  const withoutBom = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const beforeFm = stripLeadingMarker(withoutBom);
  let managedLedgerId = beforeFm.id;
  const text = beforeFm.rest;

  let fields: Record<string, string> = {};
  let bodyRaw = text;

  const fmMatch = /^---[ \t]*\r?\n(?:---[ \t]*(?:\r?\n|$)|([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
  if (fmMatch) {
    const fmContent = fmMatch[1] ?? '';
    fields = parseFrontmatterFields(fmContent);
    bodyRaw = text.slice(fmMatch[0].length);
  }

  const afterFm = stripLeadingMarker(bodyRaw);
  if (managedLedgerId === null && afterFm.id !== null) {
    managedLedgerId = afterFm.id;
  }

  const body = afterFm.rest.trim();
  const name = fields.name?.trim() || fallbackName;
  const description = fields.description?.trim() || fallbackDescription(body, fallbackName);

  return { name, description, body, managedLedgerId };
}

// ---- Registry Map normalization & validation ----

export function normalizeBinding(raw: unknown): SkillRegistryBinding {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      enabled: DEFAULT_SKILL_BINDING.enabled,
      loading: DEFAULT_SKILL_BINDING.loading,
      project_ids: DEFAULT_SKILL_BINDING.project_ids,
      roles: [...DEFAULT_SKILL_BINDING.roles],
      machine_ids: DEFAULT_SKILL_BINDING.machine_ids,
    };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_SKILL_BINDING.enabled;
  const loading: Loading = (LOADINGS as readonly unknown[]).includes(obj.loading)
    ? (obj.loading as Loading)
    : DEFAULT_SKILL_BINDING.loading;

  let projectIds: string[] | null = null;
  if (obj.project_ids === null) {
    projectIds = null;
  } else if (Array.isArray(obj.project_ids)) {
    const cleaned = [...new Set(obj.project_ids.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))].sort(compareCodePoint);
    projectIds = cleaned.length === 0 ? null : cleaned;
  }

  const roles = Array.isArray(obj.roles)
    ? [...new Set(obj.roles.filter((role): role is string => typeof role === 'string' && role.trim() !== ''))].sort(compareCodePoint)
    : [];

  let machineIds: string[] | null = null;
  if (obj.machine_ids === null || obj.machine_ids === undefined) {
    machineIds = null;
  } else if (Array.isArray(obj.machine_ids)) {
    machineIds = [...new Set(obj.machine_ids.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))].sort(compareCodePoint);
  }

  return { enabled, loading, project_ids: projectIds, roles, machine_ids: machineIds };
}

export function parseSkillRegistry(raw: unknown): SkillRegistryMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map: SkillRegistryMap = {};
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isUnsafeSlug(slug)) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    map[slug] = normalizeBinding(value);
  }
  return map;
}

export function parseEntryMachines(raw: unknown): EntryMachinesMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map: EntryMachinesMap = {};
  for (const [entryId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (entryId === '' || entryId === '__proto__' || entryId === 'constructor' || entryId === 'prototype') continue;
    if (value === null) {
      map[entryId] = null;
    } else if (Array.isArray(value)) {
      map[entryId] = [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))].sort(compareCodePoint);
    }
  }
  return map;
}

export function validateMachineIds(input: unknown, knownMachines: readonly string[]): string[] | null {
  if (input === null) return null;
  if (!Array.isArray(input)) {
    throw new InputError('machine_ids 必须为 null（全部机器）或机器编号数组');
  }
  if (input.some((id) => typeof id !== 'string' || id === '')) {
    throw new InputError('machine_ids 必须为 null（全部机器）或非空机器编号列表');
  }
  if (input.length === 0) {
    throw new InputError('指定机器时 machine_ids 至少包含一台机器；全部机器请填 null');
  }
  const machineSet = new Set(knownMachines);
  const machineIds = [...new Set(input as string[])].sort(compareCodePoint);
  for (const id of machineIds) {
    if (!machineSet.has(id)) throw new InputError(`机器不存在：${id}`);
  }
  return machineIds;
}

export function validateSkillBinding(
  input: unknown,
  knownProjects: readonly string[],
  knownRoles: readonly string[],
  knownMachines: readonly string[] = [],
): SkillRegistryBinding {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('技能绑定配置必须是一个对象');
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.enabled !== 'boolean') {
    throw new InputError('enabled 必须是布尔值');
  }

  if (!(LOADINGS as readonly unknown[]).includes(obj.loading)) {
    throw new InputError(`加载方式只能是 ${LOADINGS.join('、')}`);
  }
  const loading = obj.loading as Loading;

  const projectSet = new Set(knownProjects);
  let projectIds: string[] | null;
  if (obj.project_ids === null) {
    projectIds = null;
  } else if (Array.isArray(obj.project_ids)) {
    if (obj.project_ids.some((id) => typeof id !== 'string' || id === '')) {
      throw new InputError('project_ids 必须为 null（全局）或非空项目编号列表');
    }
    if (obj.project_ids.length === 0) {
      throw new InputError('指定项目时 project_ids 至少包含一个项目编号；全局适用请填 null');
    }
    projectIds = [...new Set(obj.project_ids as string[])].sort(compareCodePoint);
    for (const id of projectIds) {
      if (!projectSet.has(id)) throw new InputError(`项目不存在：${id}`);
    }
  } else {
    throw new InputError('project_ids 必须为 null（全局）或项目编号数组');
  }

  const roleSet = new Set(knownRoles);
  if (!Array.isArray(obj.roles) || obj.roles.some((role) => typeof role !== 'string' || role === '')) {
    throw new InputError('roles 必须是职能编号数组（空数组表示不限职能）');
  }
  const roles = [...new Set(obj.roles as string[])].sort(compareCodePoint);
  for (const role of roles) {
    if (!roleSet.has(role)) throw new InputError(`职能不存在：${role}`);
  }

  const machineIds = obj.machine_ids === undefined ? null : validateMachineIds(obj.machine_ids, knownMachines);

  return { enabled: obj.enabled, loading, project_ids: projectIds, roles, machine_ids: machineIds };
}

// ---- Safe read-only directory scanner ----

export function scanSkillDirectory(skillsDir: string, registry: SkillRegistryMap): SkillDirectoryScan {
  const skills: DirectorySkill[] = [];
  const ignored: IgnoredSkillEntry[] = [];

  let entries: Dirent[];
  try {
    const dirStat = statSync(skillsDir);
    if (!dirStat.isDirectory()) return { dir: skillsDir, skills, ignored };
    entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => compareCodePoint(a.name, b.name));
  } catch {
    return { dir: skillsDir, skills, ignored };
  }

  for (const entry of entries) {
    const slug = entry.name;
    if (slug.startsWith('.')) continue;
    if (isUnsafeSlug(slug)) {
      ignored.push({ name: slug, reason: '技能目录名包含非法路径字符（已忽略）' });
      continue;
    }

    const childPath = join(skillsDir, slug);
    let childStat;
    try {
      childStat = statSync(childPath);
    } catch {
      ignored.push({ name: slug, reason: '链接目标不存在或无法读取' });
      continue;
    }

    if (!childStat.isDirectory()) {
      if (slug.toLowerCase().endsWith('.md')) {
        ignored.push({ name: slug, reason: '非标准技能目录（需为 <技能名>/SKILL.md）' });
      }
      continue;
    }

    const skillFile = join(childPath, 'SKILL.md');
    let fileStat;
    try {
      fileStat = statSync(skillFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const reason = code === 'EACCES' || code === 'EPERM' ? '链接目标不存在或无法读取' : '目录内缺少 SKILL.md（已忽略）';
      ignored.push({ name: slug, reason });
      continue;
    }

    if (!fileStat.isFile()) {
      ignored.push({ name: slug, reason: '目录内缺少 SKILL.md（已忽略）' });
      continue;
    }

    if (fileStat.size > MAX_SKILL_FILE_BYTES) {
      ignored.push({ name: slug, reason: 'SKILL.md 超过 256 KiB 上限（已忽略）' });
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(skillFile, 'utf8');
    } catch {
      ignored.push({ name: slug, reason: '链接目标不存在或无法读取' });
      continue;
    }

    if (bytes(raw) > MAX_SKILL_FILE_BYTES) {
      ignored.push({ name: slug, reason: 'SKILL.md 超过 256 KiB 上限（已忽略）' });
      continue;
    }

    const parsed = parseSkillMarkdown(raw, slug);
    const sha256 = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
    const rawBinding = Object.hasOwn(registry, slug) ? registry[slug] : undefined;
    const binding = normalizeBinding(rawBinding);

    skills.push({
      slug,
      id: directorySkillId(slug),
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      bytes: bytes(parsed.body),
      sha256,
      rel_path: `skills/${slug}/SKILL.md`,
      binding,
      managed_ledger_id: parsed.managedLedgerId,
    });
  }

  return { dir: skillsDir, skills, ignored };
}

// ---- Directory skills -> Entry[] adapter for dispatch & unified applicable ----

// Deterministic positive integer derived from the first 7 hex chars of sha256 (max 0x0fffffff).
export function revisionFromHash(sha256: string): number {
  const parsed = Number.parseInt(sha256.slice(0, 7), 16);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

// Effective revision for a directory skill: combines content sha256 AND active loading mode so
// toggling on_demand <-> resident invalidates in-flight snapshots and cached executor sessions.
export function revisionForDirectorySkill(sha256: string, loading: Loading): number {
  const combined = createHash('sha256').update(`${sha256}\0${loading}`, 'utf8').digest('hex');
  return revisionFromHash(combined);
}

export function applicableDirectorySkills(
  skillsDir: string,
  registry: SkillRegistryMap,
  projectId: string | null,
  roleId: string | null,
  machineId: string | null = null,
): Entry[] {
  const { skills } = scanSkillDirectory(skillsDir, registry);
  const matched = skills.filter((skill) => {
    if (skill.managed_ledger_id !== null) return false;
    const { enabled, project_ids: projects, roles, machine_ids: machines } = skill.binding;
    if (!enabled) return false;
    if (projects !== null && (projectId === null || !projects.includes(projectId))) return false;
    if (roles.length > 0 && (roleId === null || !roles.includes(roleId))) return false;
    if (machines !== null) {
      if (machines.length === 0) return false;
      if (machineId !== null && !machines.includes(machineId)) return false;
    }
    return true;
  });

  const rank = ({ binding }: DirectorySkill): number =>
    (binding.project_ids === null ? 0 : 2) + (binding.roles.length === 0 ? 0 : 1);

  matched.sort((a, b) => rank(a) - rank(b) || compareCodePoint(a.slug, b.slug));

  return matched.map((skill): Entry => ({
    id: skill.id,
    revision: revisionForDirectorySkill(skill.sha256, skill.binding.loading),
    kind: 'skill',
    title: skill.name,
    when_to_use: skill.description,
    body: skill.body,
    project_ids: skill.binding.project_ids === null ? null : [...skill.binding.project_ids],
    loading: skill.binding.loading,
    roles: [...skill.binding.roles],
    proposal_id: '',
    published_by: 'directory',
    published_at: '',
    reviewed_at: null,
    created_at: '',
    state: 'active',
    retired_at: null,
    retired_by: null,
    retired_reason: null,
    replaced_by: null,
  }));
}

// ---- Safe atomic ledger-to-SKILL.md materializer & retire cleaner ----

export type MaterializableEntry = Pick<Entry, 'id' | 'revision' | 'title' | 'when_to_use' | 'body' | 'state'>;

const shortIdSuffix = (id: string): string => {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned.slice(-6) || 'ledger';
};

export function slugForLedgerEntry(title: string, id: string): string {
  const suffix = shortIdSuffix(id);
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (ascii.length < 2 || RESERVED_WINDOWS_NAMES.test(ascii)) {
    return `tycho-k-${suffix}`;
  }
  return ascii;
}

function readManagedLedgerIdNoFollow(dirPath: string): string | null {
  try {
    const dirStat = lstatSync(dirPath);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
    const skillFile = join(dirPath, 'SKILL.md');
    const fileStat = lstatSync(skillFile);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > MAX_SKILL_FILE_BYTES) return null;
    const raw = readFileSync(skillFile, 'utf8');
    return parseSkillMarkdown(raw, '').managedLedgerId;
  } catch {
    return null;
  }
}

function findManagedDir(skillsDir: string, entryId: string): string | null {
  let entries: Dirent[];
  try {
    const dirStat = statSync(skillsDir);
    if (!dirStat.isDirectory()) return null;
    entries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => compareCodePoint(a.name, b.name));
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || isUnsafeSlug(entry.name)) continue;
    const childPath = join(skillsDir, entry.name);
    if (readManagedLedgerIdNoFollow(childPath) === entryId) {
      return childPath;
    }
  }
  return null;
}

function pathExistsNoFollow(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function renderManagedSkillMarkdown(entry: MaterializableEntry): string {
  const name = JSON.stringify(entry.title);
  const description = JSON.stringify(entry.when_to_use);
  const body = entry.body.trim();
  return `---\nname: ${name}\ndescription: ${description}\n---\n<!-- tycho-ledger: ${entry.id}@${entry.revision} -->\n\n${body}\n`;
}

export function materializeLedgerEntry(
  skillsDir: string,
  entry: MaterializableEntry,
): { path: string; skippedReason?: string } {
  const existingManaged = findManagedDir(skillsDir, entry.id);

  if (entry.state === 'retired') {
    if (existingManaged === null) {
      return { path: '', skippedReason: '未找到对应的托管技能目录' };
    }
    const st = lstatSync(existingManaged);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { path: join(existingManaged, 'SKILL.md'), skippedReason: '目标是符号链接或非目录，拒绝删除' };
    }
    rmSync(existingManaged, { recursive: true, force: true });
    return { path: join(existingManaged, 'SKILL.md') };
  }

  mkdirSync(skillsDir, { recursive: true });

  let targetDir = existingManaged;
  if (targetDir === null) {
    const baseSlug = slugForLedgerEntry(entry.title, entry.id);
    const suffix = shortIdSuffix(entry.id);
    const baseCandidate = join(skillsDir, baseSlug);
    if (!pathExistsNoFollow(baseCandidate)) {
      targetDir = baseCandidate;
    } else {
      const suffixedSlug = baseSlug.endsWith(`-${suffix}`) ? baseSlug : `${baseSlug}-${suffix}`;
      let candidate = join(skillsDir, suffixedSlug);
      let attempt = 2;
      while (pathExistsNoFollow(candidate)) {
        if (attempt > 100) {
          return { path: candidate, skippedReason: '目标目录已被占用且无法分配安全目录名' };
        }
        candidate = join(skillsDir, `${suffixedSlug}-${attempt}`);
        attempt += 1;
      }
      targetDir = candidate;
    }
  }

  mkdirSync(targetDir, { recursive: true });
  const targetStat = lstatSync(targetDir);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    return { path: join(targetDir, 'SKILL.md'), skippedReason: '目标目录是链接或非常规目录，已跳过写入' };
  }

  const finalPath = join(targetDir, 'SKILL.md');
  if (pathExistsNoFollow(finalPath)) {
    const existingFileStat = lstatSync(finalPath);
    if (existingFileStat.isSymbolicLink() || !existingFileStat.isFile()) {
      return { path: finalPath, skippedReason: '目标 SKILL.md 是链接或非常规文件，已跳过写入' };
    }
  }

  const content = renderManagedSkillMarkdown(entry);
  const tmpPath = join(targetDir, `.SKILL.md.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failure for temp file.
    }
    throw err;
  }

  return { path: finalPath };
}

export function syncManagedSkills(
  skillsDir: string,
  entries: readonly MaterializableEntry[],
  onError?: (entryId: string, err: unknown) => void,
): void {
  const activeIds = new Set<string>();
  for (const entry of entries) {
    if (entry.state === 'active') activeIds.add(entry.id);
    try {
      materializeLedgerEntry(skillsDir, entry);
    } catch (err) {
      if (onError) onError(entry.id, err);
    }
  }

  // Prune any orphaned managed directories (e.g. entries physically deleted when a project was deleted).
  let dirEntries: Dirent[];
  try {
    const dirStat = statSync(skillsDir);
    if (!dirStat.isDirectory()) return;
    dirEntries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => compareCodePoint(a.name, b.name));
  } catch {
    return;
  }
  for (const dirEntry of dirEntries) {
    if (dirEntry.name.startsWith('.') || isUnsafeSlug(dirEntry.name)) continue;
    const childPath = join(skillsDir, dirEntry.name);
    const managedId = readManagedLedgerIdNoFollow(childPath);
    if (managedId === null || activeIds.has(managedId)) continue;
    try {
      const st = lstatSync(childPath);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      rmSync(childPath, { recursive: true, force: true });
    } catch (err) {
      if (onError) onError(managedId, err);
    }
  }
}

// ---- Effective Context Calculator ----

export function buildEffectiveContext(input: {
  entries: readonly Entry[];
  project: { id: string; name: string } | null;
  role: { id: string; name: string } | null;
  machine?: { id: string; host: string } | null;
  registry?: SkillRegistryMap;
  entryMachines?: EntryMachinesMap;
  limits: KnowledgeLimits;
  named?: readonly string[];
}): EffectiveContextReport {
  const namedList = input.named ?? [];
  const namedSet = new Set(namedList);
  const registry = input.registry ?? {};
  const entryMachines = input.entryMachines ?? {};

  const resident: EffectiveContextItem[] = [];
  const onDemand: EffectiveContextItem[] = [];

  for (const entry of input.entries) {
    const isDir = isDirectorySkillId(entry.id);
    const slug = isDir ? entry.id.slice(4) : null;
    const machineIds = isDir
      ? (slug !== null && Object.hasOwn(registry, slug) ? registry[slug]!.machine_ids : null)
      : (Object.hasOwn(entryMachines, entry.id) ? entryMachines[entry.id]! : null);
    const item: EffectiveContextItem = {
      id: entry.id,
      title: entry.title,
      when_to_use: entry.when_to_use,
      loading: entry.loading,
      origin: isDir ? 'directory' : 'ledger',
      kind: entry.kind,
      project_ids: entry.project_ids === null ? null : [...entry.project_ids],
      roles: [...entry.roles],
      machine_ids: machineIds === null ? null : [...machineIds],
      revision: isDir ? null : entry.revision,
      slug,
      bytes: bytes(entry.body),
    };
    const isResident = entry.loading === 'resident' || (entry.kind === 'skill' && namedSet.has(entry.id));
    if (isResident) {
      resident.push(item);
    } else {
      onDemand.push(item);
    }
  }

  const projectName = input.project?.name ?? '';
  const sections = briefSections(input.entries, projectName, namedList);
  const given = givenAll(input.entries, namedList);
  const briefBytes = bytes(sections);
  const snapshotBytes = given.reduce((sum, each) => sum + (each.text === undefined ? 0 : bytes(each.text)), 0);
  const overLimit = knowledgeOverLimit(input.entries, sections, input.limits, undefined, namedList) ?? null;

  return {
    project_id: input.project?.id ?? null,
    project_name: input.project?.name ?? null,
    role_id: input.role?.id ?? null,
    role_name: input.role?.name ?? null,
    machine_id: input.machine?.id ?? null,
    machine_host: input.machine?.host ?? null,
    resident,
    on_demand: onDemand,
    budget: {
      brief_bytes: briefBytes,
      brief_limit_bytes: input.limits.briefBytes,
      snapshot_bytes: snapshotBytes,
      snapshot_limit_bytes: input.limits.snapshotBytes,
      over_limit: overLimit,
    },
  };
}
