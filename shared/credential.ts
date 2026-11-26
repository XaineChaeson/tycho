// When a login tycho keeps is expected to run out (docs/design/native-login.md §2, ruling L).
// The vendor says roughly how long a long-lived token lasts and gives no exact date, so the
// estimate is only the moment the token came in plus what the executor declares — and it is
// computed here, once, for the pages, the self-check and the owner's notices alike.

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (value: number): string => String(value).padStart(2, '0');

// The instant the token stored at `credentialAt` is expected to run out, as an instant; null
// when the moment it came in is unknown or the executor declares no lifetime: nothing is
// guessed from a machine's own clock or from when the account was made.
export function expectedExpiry(credentialAt: string | null | undefined, lifetimeDays: number | undefined): string | null {
  if (!credentialAt || lifetimeDays === undefined || !Number.isFinite(lifetimeDays)) return null;
  const from = Date.parse(credentialAt);
  if (!Number.isFinite(from)) return null;
  return new Date(from + lifetimeDays * DAY_MS).toISOString();
}

// That instant as the calendar day the owner reads, in their own time zone. An unknown one
// says so rather than showing a made-up date.
export function expiryDay(expected: string | null | undefined): string {
  if (!expected) return '—';
  const at = new Date(expected);
  if (Number.isNaN(at.getTime())) return '—';
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
