// Shared schema & security validator for Tycho pluggable theme packs.
// Used identically by the host directory store (`service/themes.ts`) and browser Console (`console/src/lib/theme.ts`).

export const BUILTIN_THEME_IDS = [
  'hud',
  'linear',
  'tactile',
  'glass',
  'te',
  'paper',
  'quant',
  'swiss',
  'classic',
] as const;

export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number];

export interface DirectoryThemePack {
  id: string;
  name: string;
  badge: string;
  description: string;
  swatches: [string, string, string];
  tokens: Record<string, string>;
  file?: string;
}

export const ALLOWED_THEME_TOKENS = new Set<string>([
  '--canvas', '--background', '--raised', '--muted', '--hover', '--border', '--border-strong',
  '--foreground', '--muted-foreground', '--faint', '--ink', '--ink-foreground',
  '--primary', '--primary-hover', '--primary-foreground',
  '--brand-foreground', '--brand-soft', '--brand-border', '--ring', '--link',
  '--running', '--running-foreground', '--running-soft', '--running-border',
  '--waiting', '--waiting-foreground', '--waiting-soft', '--waiting-border',
  '--failed', '--failed-foreground', '--failed-soft', '--failed-border',
  '--success', '--success-foreground', '--success-soft', '--success-border',
  '--ended', '--code', '--bubble',
  '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl',
]);

export const THEME_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
// Rejects any syntax that could escape a single CSS custom property value (no semicolons, braces, url(), quotes).
export const SAFE_THEME_CSS_VALUE = /^[#a-zA-Z0-9(),.%/*+\-\s]+$/;
const SAFE_SWATCH_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export function sanitizeThemeTokens(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_THEME_TOKENS.has(key)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 120 || !SAFE_THEME_CSS_VALUE.test(trimmed)) continue;
    clean[key] = trimmed;
  }
  return clean;
}

export function validateThemePack(
  raw: unknown,
  options?: { fallbackId?: string },
): { ok: true; pack: DirectoryThemePack } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '主题包必须是一个 JSON 对象。' };
  }
  const rec = raw as Record<string, unknown>;
  const rawId = typeof rec.id === 'string' && rec.id.trim()
    ? rec.id.trim().toLowerCase()
    : (options?.fallbackId?.trim().toLowerCase() ?? '');

  if (!THEME_SLUG_RE.test(rawId)) {
    return { ok: false, error: '主题 id 必须是小写字母/数字开头，仅含字母、数字、-、_（最多 48 字符）。' };
  }
  if ((BUILTIN_THEME_IDS as readonly string[]).includes(rawId)) {
    return { ok: false, error: `id "${rawId}" 与内置主题重名，请换一个标识。` };
  }

  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  if (!name) {
    return { ok: false, error: '缺少主题名称 name 字段。' };
  }

  const tokens = sanitizeThemeTokens(rec.tokens);
  if (Object.keys(tokens).length === 0) {
    return { ok: false, error: 'tokens 里没有可识别的安全 CSS 变量（例如 --primary、--background）。' };
  }

  const rawSwatches = Array.isArray(rec.swatches)
    ? rec.swatches.filter((s): s is string => typeof s === 'string' && SAFE_SWATCH_COLOR.test(s.trim())).map((s) => s.trim())
    : [];

  const swatches: [string, string, string] = [
    rawSwatches[0] ?? '#0D1322',
    rawSwatches[1] ?? '#17223A',
    rawSwatches[2] ?? '#38BDF8',
  ];

  const badge = typeof rec.badge === 'string' && rec.badge.trim()
    ? rec.badge.trim().slice(0, 10)
    : 'PLUGIN';

  const description = typeof rec.description === 'string' && rec.description.trim()
    ? rec.description.trim().slice(0, 120)
    : '主机目录主题插件';

  return {
    ok: true,
    pack: {
      id: rawId,
      name: name.slice(0, 32),
      badge,
      description,
      swatches,
      tokens,
    },
  };
}
