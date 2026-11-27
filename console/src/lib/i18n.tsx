import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE,
  getActiveLocale,
  interpolate,
  LOCALE_LABELS,
  normalizeLocale,
  setActiveLocale,
  SUPPORTED_LOCALES,
  type Locale,
} from '@shared/i18n.ts';
import { en } from '@/locales/en';
import { zhCN, type MessageKey, type Messages } from '@/locales/zh-CN';

export { DEFAULT_LOCALE, LOCALE_LABELS, normalizeLocale, SUPPORTED_LOCALES, type Locale, type MessageKey };

const LOCALE_STORAGE_KEY = 'tycho.locale';
const DICTIONARIES: Record<Locale, Messages> = { 'zh-CN': zhCN, en };

export function readStoredLocale(): Locale {
  try {
    if (typeof localStorage === 'undefined') return getActiveLocale();
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw) return normalizeLocale(raw);
  } catch {
    // Ignore storage access errors in restricted contexts.
  }
  return DEFAULT_LOCALE;
}

export function writeStoredLocale(locale: Locale): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    }
  } catch {
    // Ignore storage access errors.
  }
}

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number | null | undefined>): string {
  const dict = DICTIONARIES[locale] ?? zhCN;
  const template = dict[key] ?? zhCN[key] ?? key;
  return interpolate(template, params);
}

interface I18nContextValue {
  locale: Locale;
  isEn: boolean;
  setLocale: (next: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number | null | undefined>) => string;
  bi: (zh: string, enText: string) => string;
}

const DEFAULT_VALUE: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  isEn: false,
  setLocale: () => {},
  t: (key, params) => translate(DEFAULT_LOCALE, key, params),
  bi: (zh) => zh,
};

const I18nContext = createContext<I18nContextValue>(DEFAULT_VALUE);

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const resolved = initialLocale ?? readStoredLocale();
    setActiveLocale(resolved);
    return resolved;
  });

  const setLocale = useCallback((next: Locale) => {
    const normalized = normalizeLocale(next);
    setActiveLocale(normalized);
    writeStoredLocale(normalized);
    setLocaleState(normalized);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = normalized;
    }
  }, []);

  useEffect(() => {
    setActiveLocale(locale);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    isEn: locale === 'en',
    setLocale,
    t: (key, params) => translate(locale, key, params),
    bi: (zh, enText) => (locale === 'en' ? enText : zh),
  }), [locale, setLocale]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
