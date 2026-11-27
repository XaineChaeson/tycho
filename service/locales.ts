// Host directory language pack store: reads, validates, writes, and deletes `<dataDir>/locales/*.json`.
// Mirrors `service/themes.ts`: any valid JSON language pack dropped into `<dataDir>/locales/`
// becomes immediately available across Web Console, Tauri Desktop, Login HTML, and Router/Worker
// prompts without restarting the service.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  canonicalizeLocaleId,
  isValidLocaleId,
  MAX_LOCALE_FILE_BYTES,
  replaceDirectoryLocalePacks,
  validateLocalePack,
  type LocalePack,
} from '../shared/i18n.ts';

export function localesDirOf(dataDir: string): string {
  return join(dataDir, 'locales');
}

export function listDirectoryLocales(dataDir: string): LocalePack[] {
  const dir = localesDirOf(dataDir);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir)
      .filter((name) => extname(name).toLowerCase() === '.json')
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }

  const packs: LocalePack[] = [];
  const seen = new Set<string>();
  for (const file of entries) {
    try {
      const fullPath = join(dir, file);
      const rawText = readFileSync(fullPath, 'utf8');
      if (Buffer.byteLength(rawText, 'utf8') > MAX_LOCALE_FILE_BYTES) continue;
      const parsed = JSON.parse(rawText) as unknown;
      const fallbackId = basename(file, extname(file));
      const result = validateLocalePack(parsed, { fallbackId });
      if (!result.ok || seen.has(result.pack.id)) continue;
      seen.add(result.pack.id);
      packs.push({ ...result.pack, file });
    } catch {
      // Ignore malformed drop-in JSON files so one bad file never breaks other packs.
    }
  }
  return packs;
}

export function syncDirectoryLocales(dataDir: string): LocalePack[] {
  const packs = listDirectoryLocales(dataDir);
  replaceDirectoryLocalePacks(packs);
  return packs;
}

export function saveDirectoryLocale(
  dataDir: string,
  raw: unknown,
  options?: { fallbackId?: string },
): { ok: true; pack: LocalePack } | { ok: false; error: string } {
  const validated = validateLocalePack(raw, options);
  if (!validated.ok) return validated;

  const dir = localesDirOf(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = `${validated.pack.id}.json`;
  const target = join(dir, file);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const serialized: Record<string, unknown> = {
    id: validated.pack.id,
    name: validated.pack.name,
    nativeName: validated.pack.nativeName,
    shortLabel: validated.pack.shortLabel,
    direction: validated.pack.direction,
    ...(validated.pack.fallback ? { fallback: validated.pack.fallback } : {}),
    messages: validated.pack.messages,
  };
  const payload = JSON.stringify(serialized, null, 2) + '\n';
  if (Buffer.byteLength(payload, 'utf8') > MAX_LOCALE_FILE_BYTES) {
    return { ok: false, error: `Language pack exceeds maximum size of ${Math.round(MAX_LOCALE_FILE_BYTES / 1024)} KiB.` };
  }
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, target);
  const saved: LocalePack = { ...validated.pack, file };
  syncDirectoryLocales(dataDir);
  return { ok: true, pack: saved };
}

export function deleteDirectoryLocale(dataDir: string, rawId: string): boolean {
  const id = canonicalizeLocaleId(rawId);
  if (!isValidLocaleId(id)) return false;
  const dir = localesDirOf(dataDir);
  if (!existsSync(dir)) return false;

  // Match case-insensitively on disk (e.g. zh-tw.json or zh-TW.json) to handle cross-platform FS cleanly.
  let removed = false;
  for (const name of readdirSync(dir)) {
    if (extname(name).toLowerCase() !== '.json') continue;
    const stem = basename(name, extname(name));
    if (canonicalizeLocaleId(stem).toLowerCase() === id.toLowerCase()) {
      rmSync(join(dir, name), { force: true });
      removed = true;
    }
  }
  if (removed) syncDirectoryLocales(dataDir);
  return removed;
}
