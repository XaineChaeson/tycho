// Reactive React provider for Tycho's hot-pluggable language pack engine (`@shared/i18n.ts`).
// Zero hardcoded language pairs (`bi()` is intentionally forbidden): every UI string resolves
// through `t(key, params)` against built-in JSON packs or `<dataDir>/locales/*.json` plugins.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  getActiveLocale,
  getLocalePack,
  getLocaleRegistryVersion,
  listLocalePackSummaries,
  normalizeLocale,
  onLocaleChange,
  registerLocalePack,
  replaceDirectoryLocalePacks,
  setActiveLocale,
  t as translateRaw,
  type Locale,
  type LocalePack,
  type LocalePackSummary,
  type MessageKey,
  type TranslationParams,
} from '@shared/i18n.ts';
import { api } from '@/lib/api';

const STORAGE_KEY = 'tycho.locale';

export { translateRaw as translate };
export type { Locale, LocalePack, LocalePackSummary, MessageKey, TranslationParams };

export interface LocalesDirectoryResponse {
  dir: string | null;
  active: string;
  locales: LocalePackSummary[];
}

function readStoredLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return normalizeLocale(saved);
  } catch {
    // Ignore storage refusal.
  }
  return DEFAULT_LOCALE;
}

function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Ignore storage refusal.
  }
}

let directoryPacksDir: string | null = null;
const dirListeners = new Set<() => void>();

export function getLocalesDirectory(): string | null {
  return directoryPacksDir;
}

export async function syncDirectoryLocalePacks(): Promise<LocalesDirectoryResponse | null> {
  try {
    const listing = await api<LocalesDirectoryResponse>('/api/locales');
    directoryPacksDir = listing.dir;
    const external = listing.locales.filter((item) => !item.builtin || item.has_override);
    const loaded: LocalePack[] = [];
    await Promise.all(
      external.map(async (item) => {
        try {
          const detail = await api<{ pack: LocalePack }>(`/api/locales/${encodeURIComponent(item.id)}`);
          if (detail?.pack) loaded.push(detail.pack);
        } catch {
          // Ignore individual pack fetch failures.
        }
      }),
    );
    replaceDirectoryLocalePacks(loaded);
    for (const fn of dirListeners) fn();
    return listing;
  } catch {
    return null;
  }
}

export async function ensureLocalePackLoaded(id: string): Promise<void> {
  const existing = getLocalePack(id);
  if (existing) return;
  try {
    const detail = await api<{ pack: LocalePack }>(`/api/locales/${encodeURIComponent(id)}`);
    if (detail?.pack) registerLocalePack(detail.pack);
  } catch {
    // Fallback chain handles unavailable packs cleanly.
  }
}

export interface I18nContextValue {
  locale: Locale;
  pack: LocalePack | undefined;
  packs: LocalePackSummary[];
  localesDir: string | null;
  setLocale: (next: Locale) => void;
  refreshPacks: () => Promise<LocalesDirectoryResponse | null>;
  t: (key: MessageKey | (string & {}), params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [localesDir, setLocalesDir] = useState<string | null>(() => directoryPacksDir);
  const [initialized] = useState<Locale>(() => {
    const start = initialLocale ? normalizeLocale(initialLocale) : readStoredLocale();
    setActiveLocale(start);
    return start;
  });

  const registryVersion = useSyncExternalStore(
    onLocaleChange,
    getLocaleRegistryVersion,
    getLocaleRegistryVersion,
  );
  const locale = getActiveLocale() || initialized;

  useEffect(() => {
    const onDir = () => setLocalesDir(directoryPacksDir);
    dirListeners.add(onDir);
    return () => {
      dirListeners.delete(onDir);
    };
  }, []);

  useEffect(() => {
    const pack = getLocalePack(locale);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dir = pack?.direction ?? 'ltr';
    }
  }, [locale, registryVersion]);

  const setLocale = useCallback((raw: Locale) => {
    const apply = (resolved: Locale) => {
      setActiveLocale(resolved);
      writeStoredLocale(resolved);
    };
    if (getLocalePack(raw)) {
      apply(normalizeLocale(raw));
      return;
    }
    void ensureLocalePackLoaded(raw).then(() => {
      apply(normalizeLocale(raw));
    });
  }, []);

  const refreshPacks = useCallback(async () => {
    const result = await syncDirectoryLocalePacks();
    setLocalesDir(directoryPacksDir);
    return result;
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const pack = getLocalePack(locale);
    const packs = listLocalePackSummaries();
    const t = (key: MessageKey | (string & {}), params?: TranslationParams): string =>
      translateRaw(key, params, locale);
    return { locale, pack, packs, localesDir, setLocale, refreshPacks, t };
  }, [locale, registryVersion, localesDir, setLocale, refreshPacks]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  const current = getActiveLocale();
  return {
    locale: current,
    pack: getLocalePack(current),
    packs: listLocalePackSummaries(),
    localesDir: directoryPacksDir,
    setLocale: (next) => {
      setActiveLocale(next);
      writeStoredLocale(normalizeLocale(next));
    },
    refreshPacks: syncDirectoryLocalePacks,
    t: (key, params) => translateRaw(key, params, current),
  };
}
