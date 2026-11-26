// Host directory theme plugin store: reads, validates, writes, and deletes `<dataDir>/themes/*.json`.
// Any valid JSON theme pack dropped into `<dataDir>/themes/` becomes immediately available across
// Web Console, Tauri Desktop, and mobile sessions without restarting the service.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { THEME_SLUG_RE, validateThemePack, type DirectoryThemePack } from '../shared/themes.ts';

export const MAX_THEME_FILE_BYTES = 64 * 1024;

export function themesDirOf(dataDir: string): string {
  return join(dataDir, 'themes');
}

export function listDirectoryThemes(dataDir: string): DirectoryThemePack[] {
  const dir = themesDirOf(dataDir);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir)
      .filter((name) => extname(name).toLowerCase() === '.json')
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }

  const packs: DirectoryThemePack[] = [];
  const seen = new Set<string>();
  for (const file of entries) {
    try {
      const fullPath = join(dir, file);
      const rawText = readFileSync(fullPath, 'utf8');
      if (Buffer.byteLength(rawText, 'utf8') > MAX_THEME_FILE_BYTES) continue;
      const parsed = JSON.parse(rawText) as unknown;
      const fallbackId = basename(file, extname(file));
      const result = validateThemePack(parsed, { fallbackId });
      if (!result.ok || seen.has(result.pack.id)) continue;
      seen.add(result.pack.id);
      packs.push({ ...result.pack, file });
    } catch {
      // Ignore malformed JSON files so one broken drop-in never breaks other themes.
    }
  }
  return packs;
}

export function saveDirectoryTheme(
  dataDir: string,
  raw: unknown,
): { ok: true; pack: DirectoryThemePack } | { ok: false; error: string } {
  const validated = validateThemePack(raw);
  if (!validated.ok) return validated;

  const dir = themesDirOf(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = `${validated.pack.id}.json`;
  const target = join(dir, file);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(validated.pack, null, 2) + '\n';
  if (Buffer.byteLength(payload, 'utf8') > MAX_THEME_FILE_BYTES) {
    return { ok: false, error: '主题包体积不能超过 64 KiB。' };
  }
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, target);
  return { ok: true, pack: { ...validated.pack, file } };
}

export function deleteDirectoryTheme(dataDir: string, rawId: string): boolean {
  const id = rawId.trim().toLowerCase();
  if (!THEME_SLUG_RE.test(id)) return false;
  const target = join(themesDirOf(dataDir), `${id}.json`);
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}
