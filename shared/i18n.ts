// Shared lightweight internationalization primitives usable in both Node (service/runner/shared)
// and Browser (console) with zero runtime dependencies.
export type Locale = 'zh-CN' | 'en';

export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en'] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

export function normalizeLocale(raw: unknown): Locale {
  if (typeof raw !== 'string') return DEFAULT_LOCALE;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'en' || trimmed.startsWith('en-') || trimmed.startsWith('en_')) return 'en';
  if (trimmed === 'zh' || trimmed.startsWith('zh-') || trimmed.startsWith('zh_')) return 'zh-CN';
  return DEFAULT_LOCALE;
}

let activeLocale: Locale = DEFAULT_LOCALE;

export function getActiveLocale(): Locale {
  return activeLocale;
}

export function setActiveLocale(locale: Locale): void {
  activeLocale = normalizeLocale(locale);
}

export function isEnglish(locale: Locale = activeLocale): boolean {
  return locale === 'en';
}

export function pickLocale<T>(zh: T, en: T, locale: Locale = activeLocale): T {
  return locale === 'en' ? en : zh;
}

export function interpolate(template: string, params?: Record<string, string | number | null | undefined>): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? whole : String(value);
  });
}
