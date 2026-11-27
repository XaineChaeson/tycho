// Hot-pluggable internationalization engine shared across Service, Runner, Shared, and Console.
// Built-in JSON packs live in `shared/locales/{zh-CN,en}/*.json`; external packs drop into
// `<dataDir>/locales/<id>.json` and activate at runtime with zero restarts or code changes.
import {
  BUILTIN_LOCALE_DEFINITIONS,
  CANONICAL_LOCALE_KEYS,
  type MessageKey,
} from './locales/index.ts';

export type { MessageKey };
export type Locale = string;
export type LocaleDirection = 'ltr' | 'rtl';

export const DEFAULT_LOCALE = 'zh-CN';
export const LOCALE_ID_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const MAX_LOCALE_FILE_BYTES = 512 * 1024;
export const MAX_LOCALE_MESSAGE_LENGTH = 8_000;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface LocalePack {
  id: string;
  name: string;
  nativeName: string;
  shortLabel: string;
  direction: LocaleDirection;
  fallback?: string | undefined;
  messages: Record<string, string>;
  builtin?: boolean | undefined;
  hasOverride?: boolean | undefined;
  file?: string | undefined;
}

export interface LocalePackSummary {
  id: string;
  name: string;
  nativeName: string;
  shortLabel: string;
  direction: LocaleDirection;
  fallback?: string | undefined;
  builtin: boolean;
  has_override: boolean;
  total_keys: number;
  translated_keys: number;
  coverage: number;
  file?: string | undefined;
}

export type TranslationParams = Record<string, string | number | null | undefined>;

const builtinById = new Map<string, LocalePack>();
const directoryById = new Map<string, LocalePack>();

for (const def of BUILTIN_LOCALE_DEFINITIONS) {
  builtinById.set(def.id, {
    id: def.id,
    name: def.name,
    nativeName: def.nativeName,
    shortLabel: def.shortLabel,
    direction: def.direction,
    ...(def.fallback ? { fallback: def.fallback } : {}),
    messages: { ...def.messages },
    builtin: true,
    hasOverride: false,
  });
}

let activeLocale: string = DEFAULT_LOCALE;
let registryVersion = 0;
const listeners = new Set<() => void>();

function notify(): void {
  registryVersion += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Never allow one subscriber failure to break locale updates.
    }
  }
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLocaleRegistryVersion(): number {
  return registryVersion;
}

function defaultShortLabel(id: string): string {
  const base = id.split('-')[0] ?? id;
  return base.slice(0, 4).toUpperCase();
}

export function canonicalizeLocaleId(raw: string): string {
  const trimmed = raw.trim().replace(/_/g, '-');
  const parts = trimmed.split('-').filter(Boolean);
  if (parts.length === 0) return '';
  return parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      if (part.length === 4) return part[0]!.toUpperCase() + part.slice(1).toLowerCase();
      return part;
    })
    .join('-');
}

export function isValidLocaleId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const canonical = canonicalizeLocaleId(raw);
  return canonical.length >= 2 && canonical.length <= 32 && LOCALE_ID_RE.test(canonical);
}

export function validateLocalePack(
  raw: unknown,
  options?: { fallbackId?: string },
): { ok: true; pack: LocalePack } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Language pack must be a JSON object.' };
  }
  const rec = raw as Record<string, unknown>;
  const candidateId = typeof rec.id === 'string' && rec.id.trim()
    ? rec.id.trim()
    : (options?.fallbackId?.trim() ?? '');
  const id = canonicalizeLocaleId(candidateId);
  if (!isValidLocaleId(id)) {
    return { ok: false, error: 'Invalid locale id: expected a BCP-47 tag such as "en", "ja", or "zh-TW".' };
  }

  const existingBuiltin = builtinById.get(id);
  const name = typeof rec.name === 'string' && rec.name.trim()
    ? rec.name.trim().slice(0, 80)
    : existingBuiltin?.name ?? '';
  const nativeName = typeof rec.nativeName === 'string' && rec.nativeName.trim()
    ? rec.nativeName.trim().slice(0, 80)
    : existingBuiltin?.nativeName ?? name;
  if (!name || !nativeName) {
    return { ok: false, error: 'Language pack requires non-empty "name" and "nativeName" fields.' };
  }

  const shortLabel = typeof rec.shortLabel === 'string' && rec.shortLabel.trim()
    ? rec.shortLabel.trim().slice(0, 6)
    : existingBuiltin?.shortLabel ?? defaultShortLabel(id);

  const direction: LocaleDirection = rec.direction === 'rtl' ? 'rtl' : 'ltr';

  let fallback: string | undefined;
  if (typeof rec.fallback === 'string' && rec.fallback.trim()) {
    const cleanFallback = canonicalizeLocaleId(rec.fallback);
    if (!isValidLocaleId(cleanFallback) || cleanFallback === id) {
      return { ok: false, error: 'Invalid "fallback" locale id.' };
    }
    fallback = cleanFallback;
  } else if (!existingBuiltin) {
    fallback = 'en';
  }

  if (!rec.messages || typeof rec.messages !== 'object' || Array.isArray(rec.messages)) {
    return { ok: false, error: 'Language pack must include a "messages" object mapping keys to strings.' };
  }

  const cleanMessages: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec.messages as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const trimmedKey = key.trim();
    if (!trimmedKey || trimmedKey.length > 160) continue;
    if (typeof value !== 'string') continue;
    if (value.length > MAX_LOCALE_MESSAGE_LENGTH) continue;
    cleanMessages[trimmedKey] = value;
  }

  if (Object.keys(cleanMessages).length === 0) {
    return { ok: false, error: 'Language pack "messages" cannot be empty.' };
  }

  return {
    ok: true,
    pack: {
      id,
      name,
      nativeName,
      shortLabel,
      direction,
      ...(fallback ? { fallback } : {}),
      messages: cleanMessages,
      builtin: Boolean(existingBuiltin),
      hasOverride: Boolean(existingBuiltin),
    },
  };
}

function mergePack(id: string): LocalePack | undefined {
  const builtin = builtinById.get(id);
  const external = directoryById.get(id);
  if (builtin && external) {
    return {
      ...builtin,
      name: external.name || builtin.name,
      nativeName: external.nativeName || builtin.nativeName,
      shortLabel: external.shortLabel || builtin.shortLabel,
      direction: external.direction ?? builtin.direction,
      fallback: external.fallback ?? builtin.fallback,
      messages: { ...builtin.messages, ...external.messages },
      builtin: true,
      hasOverride: true,
      ...(external.file ? { file: external.file } : {}),
    };
  }
  if (external) return { ...external, builtin: false, hasOverride: false };
  if (builtin) return { ...builtin, builtin: true, hasOverride: false };
  return undefined;
}

export function getLocalePack(id: string): LocalePack | undefined {
  const exact = mergePack(id);
  if (exact) return exact;
  const canonical = canonicalizeLocaleId(id);
  if (canonical !== id) {
    const byCanonical = mergePack(canonical);
    if (byCanonical) return byCanonical;
  }
  const lower = canonical.toLowerCase();
  for (const key of new Set([...builtinById.keys(), ...directoryById.keys()])) {
    if (key.toLowerCase() === lower) return mergePack(key);
  }
  return undefined;
}

export function registerLocalePack(pack: LocalePack): void {
  directoryById.set(pack.id, pack);
  notify();
}

export function unregisterLocalePack(id: string): boolean {
  const canonical = canonicalizeLocaleId(id);
  const removed = directoryById.delete(canonical) || directoryById.delete(id);
  if (removed) {
    if (!getLocalePack(activeLocale)) activeLocale = DEFAULT_LOCALE;
    notify();
  }
  return removed;
}

export function replaceDirectoryLocalePacks(packs: readonly LocalePack[]): void {
  directoryById.clear();
  for (const pack of packs) {
    directoryById.set(pack.id, pack);
  }
  if (!getLocalePack(activeLocale)) activeLocale = DEFAULT_LOCALE;
  notify();
}

export function listLocalePacks(): LocalePack[] {
  const ids = new Set<string>([...builtinById.keys(), ...directoryById.keys()]);
  const out: LocalePack[] = [];
  for (const id of ids) {
    const merged = mergePack(id);
    if (merged) out.push(merged);
  }
  return out;
}

export function summarizeLocalePack(pack: LocalePack): LocalePackSummary {
  const total = CANONICAL_LOCALE_KEYS.length;
  let translated = 0;
  for (const key of CANONICAL_LOCALE_KEYS) {
    const val = pack.messages[key];
    if (typeof val === 'string' && val.trim() !== '') translated += 1;
  }
  const coverage = total > 0 ? Math.round((translated / total) * 100) : 100;
  return {
    id: pack.id,
    name: pack.name,
    nativeName: pack.nativeName,
    shortLabel: pack.shortLabel,
    direction: pack.direction,
    ...(pack.fallback ? { fallback: pack.fallback } : {}),
    builtin: Boolean(pack.builtin),
    has_override: Boolean(pack.hasOverride),
    total_keys: total,
    translated_keys: translated,
    coverage,
    ...(pack.file ? { file: pack.file } : {}),
  };
}

export function listLocalePackSummaries(): LocalePackSummary[] {
  return listLocalePacks().map(summarizeLocalePack);
}

export function normalizeLocale(raw: unknown): Locale {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_LOCALE;
  const canonical = canonicalizeLocaleId(raw);
  const direct = getLocalePack(canonical);
  if (direct) return direct.id;
  // Base language match (e.g., en-US -> en, zh-SG -> zh-CN, ja-JP -> ja).
  const base = canonical.split('-')[0]?.toLowerCase() ?? '';
  if (base === 'en') return getLocalePack('en')?.id ?? 'en';
  if (base === 'zh') return getLocalePack('zh-CN')?.id ?? DEFAULT_LOCALE;
  for (const pack of listLocalePacks()) {
    if (pack.id.toLowerCase() === base || pack.id.toLowerCase().startsWith(`${base}-`)) {
      return pack.id;
    }
  }
  return DEFAULT_LOCALE;
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

export function setActiveLocale(locale: Locale): void {
  const next = normalizeLocale(locale);
  if (next === activeLocale) return;
  activeLocale = next;
  notify();
}

export function isEnglish(locale: Locale = activeLocale): boolean {
  return locale === 'en' || locale.toLowerCase().startsWith('en-');
}

export function isDefaultLocale(locale: Locale = activeLocale): boolean {
  return locale === DEFAULT_LOCALE;
}

export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? whole : String(value);
  });
}

function lookupRaw(key: string, localeId: string): string | undefined {
  const visited = new Set<string>();
  let current: string | undefined = localeId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const pack = getLocalePack(current);
    if (pack && typeof pack.messages[key] === 'string') {
      return pack.messages[key];
    }
    current = pack?.fallback;
  }
  const enFallback = builtinById.get('en')?.messages[key];
  if (typeof enFallback === 'string') return enFallback;
  const zhFallback = builtinById.get(DEFAULT_LOCALE)?.messages[key];
  if (typeof zhFallback === 'string') return zhFallback;
  return undefined;
}

export function t(key: string, params?: TranslationParams, localeId: string = activeLocale): string {
  const raw = lookupRaw(key, localeId) ?? key;
  return interpolate(raw, params);
}

export function getResolvedMessages(localeId: string = activeLocale): Record<string, string> {
  const out: Record<string, string> = {};
  const pack = getLocalePack(localeId);
  const allKeys = new Set<string>([
    ...CANONICAL_LOCALE_KEYS,
    ...(pack ? Object.keys(pack.messages) : []),
  ]);
  for (const key of allKeys) {
    const resolved = lookupRaw(key, localeId);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

export function exportLocaleTemplate(baseLocale: string = 'en'): LocalePack {
  const messages = getResolvedMessages(baseLocale);
  return {
    id: 'xx',
    name: 'Your Language',
    nativeName: 'Your Language (Native)',
    shortLabel: 'XX',
    direction: 'ltr',
    fallback: baseLocale,
    messages,
  };
}

// Dynamic Proxy wrapper for shared label dictionaries so existing `map[code]` call sites
// always reflect the currently active hot-plugged language pack without freezing strings at import time.
export function localeMap<K extends string>(keyMap: Record<K, string>): Readonly<Record<K, string>> {
  return new Proxy(keyMap, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) {
        return t(target[prop as K]);
      }
      return Reflect.get(target, prop, receiver);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target, prop)) {
        return {
          enumerable: true,
          configurable: true,
          value: t(target[prop as K]),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

// Legacy compatibility export for existing code reading LOCALE_LABELS.
export const LOCALE_LABELS: Readonly<Record<string, string>> = new Proxy<Record<string, string>>({}, {
  get(_target, prop) {
    if (typeof prop === 'string') return getLocalePack(prop)?.nativeName ?? prop;
    return undefined;
  },
  ownKeys() {
    return listLocalePacks().map((p) => p.id);
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop === 'string') {
      const pack = getLocalePack(prop);
      if (pack) return { enumerable: true, configurable: true, value: pack.nativeName };
    }
    return undefined;
  },
});
