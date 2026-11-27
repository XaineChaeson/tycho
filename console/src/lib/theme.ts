// Colour scheme (跟随系统 / 浅色 / 深色) and pluggable visual theme skins:
// 9 built-in named themes + host directory theme plugins (`/api/themes` -> `<dataDir>/themes/*.json`)
// + browser-local fallback custom theme packs.
import { onLocaleChange, t } from '@shared/i18n.ts';
import { sanitizeThemeTokens, validateThemePack, type BuiltinThemeId, type DirectoryThemePack } from '@shared/themes.ts';
import { api, del, post } from '@/lib/api';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type BuiltinThemeSkin = BuiltinThemeId;
export type ThemePackGroup = 'hybrid' | 'signature' | 'custom';
export type ThemePackSource = 'builtin' | 'directory' | 'local';

export interface ThemePack {
  id: string;
  name: string;
  badge: string;
  group: ThemePackGroup;
  source: ThemePackSource;
  description: string;
  swatches: [string, string, string];
  builtin: boolean;
  file?: string;
  /** Optional CSS variable overrides (only allowlisted semantic tokens are applied). */
  tokens?: Record<string, string>;
}

const SCHEME_KEY = 'tycho.theme';
const SKIN_KEY = 'tycho.skin';
const LOCAL_PACKS_KEY = 'tycho.customThemePacks';
const DIR_PACKS_CACHE_KEY = 'tycho.directoryThemePacks';

function builtinPack(spec: {
  id: BuiltinThemeSkin;
  badge: string;
  group: ThemePackGroup;
  swatches: [string, string, string];
}): ThemePack {
  return {
    id: spec.id,
    badge: spec.badge,
    group: spec.group,
    source: 'builtin',
    swatches: spec.swatches,
    builtin: true,
    get name() {
      return t(`core.theme.pack.${spec.id}.name`);
    },
    get description() {
      return t(`core.theme.pack.${spec.id}.desc`);
    },
  };
}

export const BUILTIN_THEME_PACKS: readonly ThemePack[] = [
  builtinPack({ id: 'hud', badge: 'HUD', group: 'hybrid', swatches: ['#050811', '#0D1322', '#38BDF8'] }),
  builtinPack({ id: 'linear', badge: 'LINEAR', group: 'hybrid', swatches: ['#090B10', '#121620', '#5B8CFF'] }),
  builtinPack({ id: 'tactile', badge: 'TACTILE', group: 'hybrid', swatches: ['#E7E4DC', '#1F1F1D', '#FF4F00'] }),
  builtinPack({ id: 'glass', badge: 'AURORA', group: 'hybrid', swatches: ['#0A0F1F', '#1A2444', '#818CF8'] }),
  builtinPack({ id: 'te', badge: 'FIELD', group: 'signature', swatches: ['#ECEAE4', '#1B1C1A', '#FF4F00'] }),
  builtinPack({ id: 'paper', badge: 'PAPER', group: 'signature', swatches: ['#F6F3EC', '#1E1C1A', '#C4552D'] }),
  builtinPack({ id: 'quant', badge: 'QUANT', group: 'signature', swatches: ['#050608', '#0E1218', '#FFB000'] }),
  builtinPack({ id: 'swiss', badge: 'SWISS', group: 'signature', swatches: ['#FFFFFF', '#0A0A0A', '#E62E2D'] }),
  builtinPack({ id: 'classic', badge: 'CLASSIC', group: 'signature', swatches: ['#ECEFF5', '#FCFDFF', '#2D5BE3'] }),
];

export function getSampleThemePackJson(): string {
  return JSON.stringify({
    id: 'emerald-terminal',
    name: t('core.theme.sample.name'),
    badge: 'EMERALD',
    description: t('core.theme.sample.desc'),
    swatches: ['#060B09', '#0E1714', '#10B981'],
    tokens: {
      '--canvas': 'light-dark(#EAF2EE, #060B09)',
      '--background': 'light-dark(#FFFFFF, #0D1613)',
      '--raised': 'light-dark(#F4F9F6, #13211C)',
      '--primary': 'light-dark(#047857, #10B981)',
      '--primary-hover': 'light-dark(#065F46, #34D399)',
      '--running': 'light-dark(#047857, #10B981)',
      '--waiting': 'light-dark(#D97706, #FFB000)',
    },
  }, null, 2);
}

export let SAMPLE_THEME_PACK_JSON = getSampleThemePackJson();
onLocaleChange(() => {
  SAMPLE_THEME_PACK_JSON = getSampleThemePackJson();
});

let appliedCustomKeys: string[] = [];
let cachedThemesDir: string | null = null;
const listeners = new Set<() => void>();

export function subscribeThemePacks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyThemePacks(): void {
  for (const listener of listeners) listener();
}

export function readTheme(): ThemeChoice {
  try {
    const held = localStorage.getItem(SCHEME_KEY);
    return held === 'light' || held === 'dark' ? held : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(SCHEME_KEY);
    else localStorage.setItem(SCHEME_KEY, choice);
  } catch {
    // A browser that refuses storage still gets the scheme for this session.
  }
  applyTheme(choice);
}

export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', get label() { return t('nav.themeSystem'); } },
  { value: 'light', get label() { return t('nav.themeLight'); } },
  { value: 'dark', get label() { return t('nav.themeDark'); } },
];

function parseStoredPacks(storageKey: string, source: 'directory' | 'local'): ThemePack[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const packs: ThemePack[] = [];
    for (const item of parsed) {
      const checked = validateThemePack(item);
      if (!checked.ok) continue;
      const rec = item as Record<string, unknown>;
      packs.push({
        ...checked.pack,
        group: 'custom',
        source,
        builtin: false,
        ...(typeof rec.file === 'string' ? { file: rec.file } : {}),
      });
    }
    return packs;
  } catch {
    return [];
  }
}

function writeStoredPacks(storageKey: string, packs: readonly ThemePack[]): void {
  try {
    if (packs.length === 0) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(packs));
  } catch {
    // Ignore storage quota failures.
  }
}

export function readCustomThemePacks(): ThemePack[] {
  const dirPacks = parseStoredPacks(DIR_PACKS_CACHE_KEY, 'directory');
  const seen = new Set(dirPacks.map((p) => p.id));
  const localPacks = parseStoredPacks(LOCAL_PACKS_KEY, 'local').filter((p) => !seen.has(p.id));
  return [...dirPacks, ...localPacks];
}

export function listThemePacks(): ThemePack[] {
  return [...BUILTIN_THEME_PACKS, ...readCustomThemePacks()];
}

export function getHostThemesDir(): string | null {
  return cachedThemesDir;
}

export function readThemeSkin(): string {
  try {
    const held = localStorage.getItem(SKIN_KEY)?.trim();
    if (!held) return 'hud';
    const exists = listThemePacks().some((pack) => pack.id === held);
    return exists ? held : 'hud';
  } catch {
    return 'hud';
  }
}

export function applyThemeSkin(skinId: string): void {
  const root = document.documentElement;
  for (const key of appliedCustomKeys) {
    root.style.removeProperty(key);
  }
  appliedCustomKeys = [];

  const pack = listThemePacks().find((p) => p.id === skinId) ?? BUILTIN_THEME_PACKS[0];
  if (pack.builtin) {
    if (pack.id === 'hud') root.removeAttribute('data-skin');
    else root.setAttribute('data-skin', pack.id);
    return;
  }

  root.setAttribute('data-skin', 'custom');
  for (const [key, value] of Object.entries(sanitizeThemeTokens(pack.tokens))) {
    root.style.setProperty(key, value);
    appliedCustomKeys.push(key);
  }
}

export function saveThemeSkin(skinId: string): void {
  try {
    if (skinId === 'hud') localStorage.removeItem(SKIN_KEY);
    else localStorage.setItem(SKIN_KEY, skinId);
  } catch {
    // Ignore storage errors.
  }
  applyThemeSkin(skinId);
  notifyThemePacks();
}

export async function syncDirectoryThemePacks(): Promise<{ dir: string | null; packs: ThemePack[] }> {
  try {
    const res = await api<{ dir?: string | null; themes?: DirectoryThemePack[] }>('/api/themes');
    cachedThemesDir = typeof res.dir === 'string' && res.dir.trim() ? res.dir : null;
    const rawThemes = Array.isArray(res.themes) ? res.themes : [];
    const dirPacks: ThemePack[] = [];
    for (const item of rawThemes) {
      const checked = validateThemePack(item);
      if (!checked.ok) continue;
      dirPacks.push({
        ...checked.pack,
        group: 'custom',
        source: 'directory',
        builtin: false,
        ...(item.file ? { file: item.file } : {}),
      });
    }
    writeStoredPacks(DIR_PACKS_CACHE_KEY, dirPacks);
    applyThemeSkin(readThemeSkin());
    notifyThemePacks();
    return { dir: cachedThemesDir, packs: dirPacks };
  } catch {
    return { dir: cachedThemesDir, packs: parseStoredPacks(DIR_PACKS_CACHE_KEY, 'directory') };
  }
}

export function importCustomThemePack(rawJson: string): { ok: true; pack: ThemePack } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: t('core.theme.invalidJson') };
  }
  const checked = validateThemePack(parsed);
  if (!checked.ok) return checked;
  const pack: ThemePack = {
    ...checked.pack,
    group: 'custom',
    source: 'local',
    builtin: false,
  };
  const existing = parseStoredPacks(LOCAL_PACKS_KEY, 'local').filter((p) => p.id !== pack.id);
  writeStoredPacks(LOCAL_PACKS_KEY, [...existing, pack]);
  saveThemeSkin(pack.id);
  return { ok: true, pack };
}

export async function installThemePack(rawJson: string): Promise<{ ok: true; pack: ThemePack } | { ok: false; error: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: t('core.theme.invalidJson') };
  }
  const checked = validateThemePack(parsed);
  if (!checked.ok) return checked;

  try {
    const res = await post<{ dir?: string; theme?: DirectoryThemePack }>('/api/themes', checked.pack);
    if (res.dir) cachedThemesDir = res.dir;
    const saved: ThemePack = {
      ...(res.theme ?? checked.pack),
      group: 'custom',
      source: 'directory',
      builtin: false,
    };
    const existingDir = parseStoredPacks(DIR_PACKS_CACHE_KEY, 'directory').filter((p) => p.id !== saved.id);
    writeStoredPacks(DIR_PACKS_CACHE_KEY, [...existingDir, saved]);
    saveThemeSkin(saved.id);
    return { ok: true, pack: saved };
  } catch {
    // Fallback to browser-local storage if host directory API is unavailable.
    return importCustomThemePack(rawJson);
  }
}

export function removeCustomThemePack(skinId: string): void {
  const wasActive = readThemeSkin() === skinId;
  writeStoredPacks(LOCAL_PACKS_KEY, parseStoredPacks(LOCAL_PACKS_KEY, 'local').filter((p) => p.id !== skinId));
  writeStoredPacks(DIR_PACKS_CACHE_KEY, parseStoredPacks(DIR_PACKS_CACHE_KEY, 'directory').filter((p) => p.id !== skinId));
  if (wasActive) {
    saveThemeSkin('hud');
  } else {
    notifyThemePacks();
  }
}

export async function uninstallThemePack(pack: ThemePack): Promise<void> {
  if (pack.source === 'directory') {
    try {
      await del(`/api/themes/${encodeURIComponent(pack.id)}`);
    } catch {
      // Even if already removed on disk, clean local cache below.
    }
  }
  removeCustomThemePack(pack.id);
}
