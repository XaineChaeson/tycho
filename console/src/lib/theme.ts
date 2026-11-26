// Colour scheme (跟随系统 / 浅色 / 深色) and pluggable visual theme skins:
// 9 built-in named themes + host directory theme plugins (`/api/themes` -> `<dataDir>/themes/*.json`)
// + browser-local fallback custom theme packs.
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

export const BUILTIN_THEME_PACKS: readonly ThemePack[] = [
  {
    id: 'hud',
    name: '测控星盘',
    badge: 'HUD',
    group: 'hybrid',
    source: 'builtin',
    description: '紧凑平铺 + 精密点阵外框 + 青蓝遥测 + 锐利 1px 网格',
    swatches: ['#050811', '#0D1322', '#38BDF8'],
    builtin: true,
  },
  {
    id: 'linear',
    name: '星仪暗夜',
    badge: 'LINEAR',
    group: 'hybrid',
    source: 'builtin',
    description: '柔炭灰/陶瓷白层次 + 钴蓝高光 + 舒展圆角',
    swatches: ['#090B10', '#121620', '#5B8CFF'],
    builtin: true,
  },
  {
    id: 'tactile',
    name: '信号橙工坊',
    badge: 'TACTILE',
    group: 'hybrid',
    source: 'builtin',
    description: '骨白/哑光炭黑 + 信号橙警示 + 瑞士工业线条',
    swatches: ['#E7E4DC', '#1F1F1D', '#FF4F00'],
    builtin: true,
  },
  {
    id: 'glass',
    name: '极光玻璃',
    badge: 'AURORA',
    group: 'hybrid',
    source: 'builtin',
    description: '柔光氛围景深 + 玻璃层级 + 靛蓝微光',
    swatches: ['#0A0F1F', '#1A2444', '#818CF8'],
    builtin: true,
  },
  {
    id: 'te',
    name: '合成器控制台',
    badge: 'FIELD',
    group: 'signature',
    source: 'builtin',
    description: '骨白铝灰机身 + 实体按压键 + 森林绿状态灯',
    swatches: ['#ECEAE4', '#1B1C1A', '#FF4F00'],
    builtin: true,
  },
  {
    id: 'paper',
    name: '燕麦书房',
    badge: 'PAPER',
    group: 'signature',
    source: 'builtin',
    description: '燕麦暖纸 / 浓缩咖啡底色 + 陶土红点缀 + 衬线标题温润阅读',
    swatches: ['#F6F3EC', '#1E1C1A', '#C4552D'],
    builtin: true,
  },
  {
    id: 'quant',
    name: '琥珀暗房',
    badge: 'QUANT',
    group: 'signature',
    source: 'builtin',
    description: '极深碳底 + 1px 钢灰网格 + 荧光琥珀与翡翠绿信号',
    swatches: ['#050608', '#0E1218', '#FFB000'],
    builtin: true,
  },
  {
    id: 'swiss',
    name: '苏黎世墨印',
    badge: 'SWISS',
    group: 'signature',
    source: 'builtin',
    description: '纯白纯黑 0 圆角建筑网格 + 唯一朱红信号点 + 极致锋利反差',
    swatches: ['#FFFFFF', '#0A0A0A', '#E62E2D'],
    builtin: true,
  },
  {
    id: 'classic',
    name: '天仪经典',
    badge: 'CLASSIC',
    group: 'signature',
    source: 'builtin',
    description: 'Tycho 初代钴蓝圆润工作台风格',
    swatches: ['#ECEFF5', '#FCFDFF', '#2D5BE3'],
    builtin: true,
  },
];

export const SAMPLE_THEME_PACK_JSON = JSON.stringify({
  id: 'emerald-terminal',
  name: '翡翠终端',
  badge: 'EMERALD',
  description: '暗绿琥珀量化终端主题插件示例',
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
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
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
    return { ok: false, error: 'JSON 格式有误，请检查语法。' };
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
    return { ok: false, error: 'JSON 格式有误，请检查语法。' };
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
