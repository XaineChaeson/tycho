// Time as the owner reads it, the same on every page and in every notification.
import { getActiveLocale, t, type Locale } from './i18n.ts';

type TimeValue = string | number | Date | null | undefined;

const dateOf = (value: TimeValue): Date | null => (value === null || value === undefined || value === '' ? null : new Date(value));
const pad = (value: number): string => String(value).padStart(2, '0');

export function formatTime(value: TimeValue, now: Date = new Date(), locale: Locale = getActiveLocale()): string {
  const at = dateOf(value);
  if (!at || Number.isNaN(at.getTime())) return '—';
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day(at) === day(now)) return clock;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (at.getFullYear() === now.getFullYear() && day(at) === day(yesterday)) {
    return t('sh.time.yesterdayAt', { clock }, locale);
  }
  return `${at.getFullYear() === now.getFullYear() ? '' : `${at.getFullYear()}-`}${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

export function fullTime(value: TimeValue, locale: Locale = getActiveLocale()): string {
  const at = dateOf(value);
  if (!at || Number.isNaN(at.getTime())) return '—';
  const tag = locale === 'en' ? 'en-US' : locale;
  try {
    return at.toLocaleString(tag, { hour12: false });
  } catch {
    return at.toLocaleString('en-US', { hour12: false });
  }
}
