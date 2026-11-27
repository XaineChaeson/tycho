import { createHash, randomBytes, randomInt, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { getActiveLocale, type Locale } from '../shared/i18n.ts';
import { InputError } from './errors.ts';
import type { ConsoleSession, Ctx, Ledger } from './ledger.ts';
import { passphraseSecretFile, putSecret, readSecret, removeSecret } from './secrets.ts';

const COOKIE = 'tycho';
const MINUTE_MS = 60_000;
const DAY_S = 86_400;
// How often a session's use is written down at most.
const USED_EVERY_MS = 5 * 60_000;
const ATTRIBUTES = 'HttpOnly; SameSite=Lax; Path=/';
// Through the gateway the browser speaks HTTPS; on the inside listener, plain HTTP, over
// which a cookie marked Secure would never come back.
const attributes = (outside: boolean): string => (outside ? `${ATTRIBUTES}; Secure` : ATTRIBUTES);
const CONSOLE = { actor: 'console' };
const PASSPHRASE_MIN_CHARS = 8;
const PASSPHRASE_MAX_CHARS = 128;
const PASSPHRASE_PATTERN = /^scrypt-v1:([0-9a-f]{32}):([0-9a-f]{64})$/;
const PASSPHRASE_WINDOW_MS = 5 * MINUTE_MS;
const PASSPHRASE_MAX_FAILURES = 5;
export const PASSPHRASE_MAX_CONCURRENT_SCRYPT = 4;
export const PASSPHRASE_MAX_FAILURE_KEYS = 1000;

function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export const MAX_PENDING_DEVICE_LOGINS = 20;

interface DeviceLoginRequest {
  code: string;
  entry: 'inside' | 'outside';
  device: string;
  created_at: number;
  expires_at: number;
}

type DeviceLogin = DeviceLoginRequest & {
  state: 'pending' | 'approved' | 'rejected';
  duration_ms?: number;
  method?: 'device' | 'wecom' | 'weixin';
};
type DeviceLoginResult = { state: 'missing' | 'rejected' } | { state: 'pending'; request: DeviceLoginRequest } | { state: 'approved'; cookie: string };

export function describeDevice(userAgent: string): string {
  const browser = /Edg(?:e|A|iOS)?\//.test(userAgent) ? 'Edge'
    : /(?:Firefox|FxiOS)\//.test(userAgent) ? 'Firefox'
    : /(?:Chrome|CriOS)\//.test(userAgent) ? 'Chrome'
    : /Version\/.*Safari\//.test(userAgent) ? 'Safari' : undefined;
  const system = /iPad/.test(userAgent) ? 'iPad' : /iPhone/.test(userAgent) ? 'iPhone'
    : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows'
    : /Macintosh|Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : undefined;
  return browser && system ? `${browser} · ${system}` : userAgent.slice(0, 80) || '未知设备';
}

export type PassphraseLoginResult =
  | { ok: true; cookie: string }
  | { ok: false; reason: 'disabled' | 'invalid' }
  | { ok: false; reason: 'locked' | 'busy'; retryAfterSec: number };

interface AuthOptions {
  ledger: Ledger;
  dataDir?: string;
  linkTtlMs: () => number;
  sessionDays: () => number;
  temporarySessionMs: () => number;
  now?: () => number;
  derivePassphrase?: (passphrase: string, salt: string) => Promise<Buffer>;
}

// The ledger is copied to backups; what it holds must not work as a cookie.
const sessionId = (secret: string): string => createHash('sha256').update(secret).digest('hex');

function cookieValue(header: string | undefined): string | undefined {
  for (const pair of (header ?? '').split(';')) {
    const [name, value] = pair.trim().split('=');
    if (name === COOKIE && value) return value;
  }
  return undefined;
}

export function createAuth({ ledger, dataDir, linkTtlMs, sessionDays, temporarySessionMs, now = Date.now, derivePassphrase = (passphrase, salt) => scryptAsync(passphrase, salt, 32) }: AuthOptions) {
  // Memory only: a restart voids outstanding links.
  const links = new Map<string, number>();
  const devices = new Map<string, DeviceLogin>();
  const passphraseFile = dataDir ? passphraseSecretFile(dataDir) : null;
  const passphraseFailures = new Map<string, number[]>();
  const inFlightByKey = new Map<string, number>();
  let activeScryptVerifications = 0;

  function recordPassphraseFailure(key: string, times: number[], stamp: number): void {
    passphraseFailures.delete(key);
    if (passphraseFailures.size >= PASSPHRASE_MAX_FAILURE_KEYS) {
      for (const [entryKey, entryTimes] of passphraseFailures) {
        if (entryTimes.every((at) => stamp - at >= PASSPHRASE_WINDOW_MS)) {
          passphraseFailures.delete(entryKey);
        }
      }
    }
    while (passphraseFailures.size >= PASSPHRASE_MAX_FAILURE_KEYS) {
      const oldestKey = passphraseFailures.keys().next().value;
      if (oldestKey === undefined) break;
      passphraseFailures.delete(oldestKey);
    }
    passphraseFailures.set(key, times);
  }
  function expireDevices(): void {
    for (const [secret, request] of devices) if (request.expires_at <= now()) devices.delete(secret);
  }
  function findDevice(code: unknown): DeviceLogin | undefined {
    expireDevices();
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return undefined;
    return [...devices.values()].find(request => request.state === 'pending' && request.code === code);
  }
  const describe = (request: DeviceLogin): DeviceLoginRequest => ({
    code: request.code, entry: request.entry, device: request.device,
    created_at: request.created_at, expires_at: request.expires_at,
  });
  // What a retired ledger connection can no longer say. Keyed by the same hash the
  // ledger stores, so it holds nothing that works as a cookie either.
  const verified = new Map<string, ConsoleSession>();
  // When each session was last written down as used. Every request is a use; writing the
  // ledger for every one would make a write of each page load, and of each read that is
  // meant to change nothing.
  const usedAt = new Map<string, number>();
  // Throttle sliding renewal to at most once every 24 hours per session.
  const extendedAt = new Map<string, number>();
  const iso = (at: number): string => new Date(at).toISOString();
  const sessionSeconds = (): number => sessionDays() * DAY_S;
  const expiry = (): string => iso(now() - sessionSeconds() * 1000);
  const linkIsLive = (id: string): boolean => (links.get(id) ?? 0) > now();

  const deadline = (session: ConsoleSession): number => Math.min(
    Date.parse(session.last_used_at ?? session.created_at) + sessionSeconds() * 1000,
    session.expires_at === undefined ? Infinity : Date.parse(session.expires_at),
  );
  const isTemporary = (session: ConsoleSession): boolean => {
    if (session.expires_at === undefined) return false;
    if (session.method !== 'device' && session.method !== 'wecom' && session.method !== 'weixin') return false;
    const grantedMs = Date.parse(session.expires_at) - Date.parse(session.created_at);
    return grantedMs < sessionSeconds() * 1000 - MINUTE_MS;
  };
  const live = (session: ConsoleSession | undefined): ConsoleSession | undefined =>
    session && deadline(session) > now() ? session : undefined;

  function issueSession(outside: boolean, device: string, method: NonNullable<ConsoleSession['method']>, durationMs = sessionSeconds() * 1000): string {
    const secret = randomBytes(32).toString('hex');
    const stamp = now();
    const at = iso(stamp);
    const seconds = Math.floor(Math.min(durationMs, sessionSeconds() * 1000) / 1000);
    const session: ConsoleSession = {
      id: sessionId(secret), created_at: at, last_seen_at: at, last_used_at: at,
      device, method, expires_at: iso(stamp + seconds * 1000), ...(outside ? { outside: true } : {}),
    };
    ledger.addConsoleSession(session, CONSOLE, expiry());
    verified.set(session.id, session);
    usedAt.set(session.id, stamp);
    return `${COOKIE}=${secret}; ${attributes(outside)}; Max-Age=${seconds}`;
  }

  function revoke(ids: string[], ctx: Ctx): string[] {
    ledger.removeConsoleSessions(ids, ctx);
    for (const id of ids) {
      verified.delete(id);
      usedAt.delete(id);
      extendedAt.delete(id);
    }
    return ids;
  }

  return {
    linkIsLive,

    createDeviceLogin(outside: boolean, userAgent: string, credential?: string): (DeviceLoginRequest & { credential: string; remaining_ms: number }) | undefined {
      expireDevices();
      // Resuming never collects a session, including after approval or a failed collection.
      const existing = credential === undefined ? undefined : devices.get(credential);
      if (existing && existing.state !== 'rejected' && (existing.entry === 'outside') === outside) {
        return { ...describe(existing), credential: credential!, remaining_ms: existing.expires_at - now() };
      }
      if ([...devices.values()].filter(request => request.state === 'pending').length >= MAX_PENDING_DEVICE_LOGINS) return undefined;
      const used = new Set([...devices.values()].map(request => request.code));
      let number = randomInt(1_000_000);
      while (used.has(number.toString().padStart(6, '0'))) number = (number + 1) % 1_000_000;
      const secret = randomBytes(32).toString('hex');
      const at = now();
      const request: DeviceLogin = {
        code: number.toString().padStart(6, '0'), entry: outside ? 'outside' : 'inside',
        device: describeDevice(userAgent), created_at: at, expires_at: at + linkTtlMs(), state: 'pending',
      };
      devices.set(secret, request);
      return { ...describe(request), credential: secret, remaining_ms: request.expires_at - now() };
    },

    lookupDeviceLogin(code: unknown): DeviceLoginRequest | undefined {
      const request = findDevice(code);
      return request && describe(request);
    },

    decideDeviceLogin(code: unknown, approve: boolean, ctx: Ctx, temporary = false, method: 'device' | 'wecom' | 'weixin' = 'device'): (DeviceLoginRequest & { duration_ms: number }) | undefined {
      const request = findDevice(code);
      if (!request) return undefined;
      // The audit must be durable before the browser can collect a session.
      ledger.recordDeviceLoginDecision(approve, { entry: request.entry, device: request.device }, ctx);
      request.state = approve ? 'approved' : 'rejected';
      request.duration_ms = Math.min(temporary ? temporarySessionMs() : sessionSeconds() * 1000, sessionSeconds() * 1000);
      request.method = method;
      return { ...describe(request), duration_ms: request.duration_ms };
    },

    deviceLogin(secret: string, outside: boolean): DeviceLoginResult {
      expireDevices();
      const request = devices.get(secret);
      if (!request || (request.entry === 'outside') !== outside) return { state: 'missing' };
      if (request.state === 'pending') return { state: 'pending', request: describe(request) };
      if (request.state === 'rejected') return { state: 'rejected' };
      const cookie = issueSession(outside, request.device, request.method!, request.duration_ms!);
      devices.delete(secret);
      return { state: 'approved', cookie };
    },

    linkValidity: (): string => `${Number((linkTtlMs() / MINUTE_MS).toFixed(1))} 分钟`,

    createLink(): { credential: string; expires_at: string } {
      for (const id of links.keys()) if (!linkIsLive(id)) links.delete(id);
      const id = randomBytes(32).toString('hex');
      const expires = now() + linkTtlMs();
      links.set(id, expires);
      return { credential: id, expires_at: iso(expires) };
    },

    // Returns the Set-Cookie value. The link is spent only once the session is durable.
    // `outside` is the listener the exchange came in by: the session is good on that
    // one alone, so a cookie that travelled over plain HTTP opens nothing from the internet.
    login(linkId: string, outside = false, userAgent = ''): string | undefined {
      if (!linkIsLive(linkId)) return undefined;
      const cookie = issueSession(outside, describeDevice(userAgent), 'link');
      links.delete(linkId);
      return cookie;
    },

    authenticate(cookieHeader: string | undefined, outside = false): (ConsoleSession & { fromMemory?: true }) | undefined {
      const secret = cookieValue(cookieHeader);
      if (!secret) return undefined;
      const id = sessionId(secret);
      const here = (session: ConsoleSession | undefined) =>
        session && Boolean(session.outside) === outside ? session : undefined;
      if (ledger.dispatchConditions().paused === null) {
        const known = here(live(verified.get(id)));
        return known && { ...known, fromMemory: true };
      }
      // Kept whichever listener asks: shown at the wrong one, a session is still a session.
      const session = live(ledger.listConsoleSessions().find((each) => each.id === id));
      if (session) verified.set(id, session);
      else verified.delete(id);
      return here(session);
    },

    touch(id: string): void {
      ledger.touchConsoleSession(id, iso(now()));
    },

    used(id: string): void {
      const at = now();
      const last = usedAt.get(id);
      if (last !== undefined && at - last < USED_EVERY_MS) return;
      usedAt.set(id, at);
      const usedIso = iso(at);
      ledger.touchConsoleSession(id, usedIso, true);
      const known = verified.get(id);
      if (known) verified.set(id, { ...known, last_used_at: usedIso });
    },

    maybeRefreshSession(cookieHeader: string | undefined, session: ConsoleSession, outside: boolean): string | undefined {
      if (isTemporary(session)) return undefined;
      const secret = cookieValue(cookieHeader);
      if (!secret || sessionId(secret) !== session.id) return undefined;
      const stamp = now();
      const targetMs = stamp + sessionSeconds() * 1000;
      if (targetMs - deadline(session) < DAY_S * 1000) return undefined;
      const lastExtended = extendedAt.get(session.id);
      if (lastExtended !== undefined && stamp - lastExtended < DAY_S * 1000) return undefined;
      const expiresAt = iso(targetMs);
      const usedIso = iso(stamp);
      ledger.extendConsoleSession(session.id, expiresAt);
      ledger.touchConsoleSession(session.id, usedIso, true);
      verified.set(session.id, { ...session, expires_at: expiresAt, last_used_at: usedIso });
      usedAt.set(session.id, stamp);
      extendedAt.set(session.id, stamp);
      return `${COOKIE}=${secret}; ${attributes(outside)}; Max-Age=${sessionSeconds()}`;
    },

    hasPassphrase(): boolean {
      return passphraseFile !== null && PASSPHRASE_PATTERN.test(readSecret(passphraseFile));
    },

    setPassphrase(passphrase: unknown): void {
      if (!passphraseFile) throw new InputError('此服务未配置密钥目录，无法设置主人口令');
      if (typeof passphrase !== 'string') throw new InputError('主人口令必须是文字');
      if (passphrase.trim() === '') throw new InputError('主人口令不能为空');
      if (passphrase.length < PASSPHRASE_MIN_CHARS || passphrase.length > PASSPHRASE_MAX_CHARS) {
        throw new InputError(`主人口令长度应在 ${PASSPHRASE_MIN_CHARS} 到 ${PASSPHRASE_MAX_CHARS} 个字符之间`);
      }
      const salt = randomBytes(16).toString('hex');
      const derived = scryptSync(passphrase, salt, 32).toString('hex');
      putSecret(passphraseFile, `scrypt-v1:${salt}:${derived}`);
      passphraseFailures.clear();
    },

    clearPassphrase(): void {
      if (passphraseFile) removeSecret(passphraseFile);
      passphraseFailures.clear();
    },

    async loginWithPassphrase(passphrase: string, outside: boolean, userAgent: string, key = 'global'): Promise<PassphraseLoginResult> {
      const stored = passphraseFile ? readSecret(passphraseFile) : '';
      const parsed = PASSPHRASE_PATTERN.exec(stored);
      if (!parsed) return { ok: false, reason: 'disabled' };
      const stamp = now();
      const recent = (passphraseFailures.get(key) ?? []).filter((at) => stamp - at < PASSPHRASE_WINDOW_MS);
      const inFlight = inFlightByKey.get(key) ?? 0;
      if (recent.length + inFlight >= PASSPHRASE_MAX_FAILURES) {
        if (recent.length >= PASSPHRASE_MAX_FAILURES) {
          recordPassphraseFailure(key, recent, stamp);
          const retryAfterSec = Math.max(1, Math.ceil((recent[0]! + PASSPHRASE_WINDOW_MS - stamp) / 1000));
          return { ok: false, reason: 'locked', retryAfterSec };
        }
        return { ok: false, reason: 'busy', retryAfterSec: 1 };
      }
      if (activeScryptVerifications >= PASSPHRASE_MAX_CONCURRENT_SCRYPT) {
        return { ok: false, reason: 'busy', retryAfterSec: 1 };
      }
      activeScryptVerifications += 1;
      inFlightByKey.set(key, inFlight + 1);
      try {
        const [, salt, expectedHex] = parsed;
        const candidate = typeof passphrase === 'string' ? passphrase : '';
        const derived = await derivePassphrase(candidate, salt!);
        const expected = Buffer.from(expectedHex!, 'hex');
        if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
          const afterStamp = now();
          const updated = (passphraseFailures.get(key) ?? []).filter((at) => afterStamp - at < PASSPHRASE_WINDOW_MS);
          updated.push(afterStamp);
          recordPassphraseFailure(key, updated, afterStamp);
          return { ok: false, reason: 'invalid' };
        }
      } finally {
        activeScryptVerifications -= 1;
        const left = (inFlightByKey.get(key) ?? 1) - 1;
        if (left <= 0) inFlightByKey.delete(key);
        else inFlightByKey.set(key, left);
      }
      // Re-verify the stored passphrase did not change or get cleared while scrypt was running.
      const latestStored = passphraseFile ? readSecret(passphraseFile) : '';
      if (!PASSPHRASE_PATTERN.test(latestStored)) return { ok: false, reason: 'disabled' };
      if (latestStored !== stored) return { ok: false, reason: 'invalid' };
      passphraseFailures.delete(key);
      const cookie = issueSession(outside, describeDevice(userAgent), 'passphrase');
      return { ok: true, cookie };
    },

    sessionDurations: () => ({ session_days: sessionDays(), temporary_ms: Math.min(temporarySessionMs(), sessionSeconds() * 1000) }),

    listSessions(currentId: string) {
      return ledger.listConsoleSessions().filter(session => live(session)).map(session => ({
        id: session.id, device: session.device ?? '未知设备', entry: session.outside ? 'outside' as const : 'inside' as const,
        method: session.method ?? null, created_at: session.created_at, last_seen_at: session.last_used_at ?? session.last_seen_at,
        expires_at: iso(deadline(session)), current: session.id === currentId,
      }));
    },

    revokeSession(id: string, ctx: Ctx): boolean {
      if (!ledger.listConsoleSessions().some(session => session.id === id)) return false;
      revoke([id], ctx);
      return true;
    },

    revokeOthers(currentId: string, ctx: Ctx): string[] {
      return revoke(ledger.listConsoleSessions().filter(session => session.id !== currentId).map(session => session.id), ctx);
    },

    // Returns the Set-Cookie value that clears it.
    logout(id: string, outside = false): string {
      revoke([id], CONSOLE);
      return `${COOKIE}=; ${attributes(outside)}; Max-Age=0`;
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  ));
}

const LOGIN_FAVICON = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2064%2064'%3E%3Cdefs%3E%3ClinearGradient%20id='g'%20x1='0'%20y1='0'%20x2='1'%20y2='1'%3E%3Cstop%20offset='0'%20stop-color='%234A76F5'/%3E%3Cstop%20offset='1'%20stop-color='%231E44C8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect%20width='64'%20height='64'%20rx='18'%20fill='url(%23g)'/%3E%3Cg%20transform='rotate(-24%2032%2033)'%3E%3Cpath%20d='M12%2033A20%209.5%200%201%201%2052%2033A20%209.5%200%200%201%2020%2040.8'%20fill='none'%20stroke='%23FFFFFF'%20stroke-opacity='0.44'%20stroke-width='3'%20stroke-linecap='round'/%3E%3C/g%3E%3Cpath%20d='M18.5%2021H45.5M32%2021V46'%20fill='none'%20stroke='%23FFFFFF'%20stroke-width='5.6'%20stroke-linecap='round'/%3E%3Ccircle%20cx='49.5'%20cy='28.5'%20r='3.6'%20fill='%23F8D06B'/%3E%3C/svg%3E";
const LOGIN_MARK = `<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="tycho-login-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A76F5"/><stop offset="1" stop-color="#1E44C8"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#tycho-login-g)"/><g transform="rotate(-24 32 33)"><path d="M12 33A20 9.5 0 1 1 52 33A20 9.5 0 0 1 20 40.8" fill="none" stroke="#FFFFFF" stroke-opacity="0.44" stroke-width="2.8" stroke-linecap="round"/></g><path d="M18.5 21H45.5M32 21V46" fill="none" stroke="#FFFFFF" stroke-width="5.4" stroke-linecap="round"/><circle cx="49.5" cy="28.5" r="3.5" fill="#F8D06B"/></svg>`;

function page(body: string, refresh = false, locale: Locale = getActiveLocale()): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tycho</title>
<link rel="icon" type="image/svg+xml" href="${LOGIN_FAVICON}">
${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
<style>
:root {
  --bg: #F6F6F4; --card: #FFFFFF; --border: #E5E5E0; --text: #1B1B1A; --muted: #666661;
  --button: #1B1B1A; --on-button: #FFFFFF; --input-bg: #FFFFFF;
  --error-bg: #FEF2F2; --error-border: #FECACA; --error-text: #B91C1C;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111110; --card: #1A1A18; --border: #2C2C29; --text: #ECECEA; --muted: #A9A9A3;
    --button: #ECECEA; --on-button: #161615; --input-bg: #141413;
    --error-bg: #2B1516; --error-border: #7F1D1D; --error-text: #FCA5A5;
  }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px 16px;
  background: var(--bg); color: var(--text); text-align: center;
  font-family: 'Noto Sans SC', 'PingFang SC', system-ui, -apple-system, sans-serif;
  line-height: 1.5; }
main.card { width: 100%; max-width: 392px; display: grid; gap: 16px; padding: 28px 24px;
  background: var(--card); border: 1px solid var(--border); border-radius: 16px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.05); }
p { margin: 0; color: var(--muted); font-size: 14px; }
h1 { margin: 0; font-size: 21px; font-weight: 600; letter-spacing: -0.01em; }
form { margin: 0; display: grid; gap: 10px; }
.label { text-align: left; font-size: 13px; font-weight: 500; color: var(--muted); }
input[type="password"] { width: 100%; min-height: 44px; padding: 0 12px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--input-bg); color: var(--text); font: inherit; font-size: 16px; }
input[type="password"]:focus-visible { outline: 2px solid #245BB8; outline-offset: 1px; border-color: #245BB8; }
button { width: 100%; min-height: 44px; padding: 0 16px; border: 0; border-radius: 10px; cursor: pointer;
  background: var(--button); color: var(--on-button); font: inherit; font-weight: 500; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button:focus-visible { outline: 2px solid #245BB8; outline-offset: 2px; }
.secondary button { background: transparent; color: var(--text); border: 1px solid var(--border); }
.alert { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--error-border);
  background: var(--error-bg); color: var(--error-text); font-size: 14px; text-align: left; }
.divider { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; margin: 4px 0; }
.divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.brand-mark { width: 44px; height: 44px; margin: 0 auto 2px; display: block; filter: drop-shadow(0 2px 8px rgba(45, 91, 227, 0.25)); }
.other { display: grid; gap: 12px; }
</style>
</head>
<body><main class="card">${LOGIN_MARK}${body}</main></body>
</html>
`;
}

export type ImLoginHint = boolean | { wecom?: boolean; weixin?: boolean };

function resolveImHint(hasIm: ImLoginHint): { wecom: boolean; weixin: boolean } {
  if (typeof hasIm === 'boolean') return { wecom: hasIm, weixin: false };
  return { wecom: Boolean(hasIm.wecom), weixin: Boolean(hasIm.weixin) };
}

function imChannelNames(hasIm: ImLoginHint, locale: Locale = getActiveLocale()): string | null {
  const { wecom, weixin } = resolveImHint(hasIm);
  if (locale === 'en') {
    if (wecom && weixin) return 'WeCom or WeChat';
    if (wecom) return 'WeCom';
    if (weixin) return 'WeChat';
    return null;
  }
  if (wecom && weixin) return '企业微信或微信';
  if (wecom) return '企业微信';
  if (weixin) return '微信';
  return null;
}

const loginGuidance = (hasIm: ImLoginHint, locale: Locale = getActiveLocale()): string => {
  if (locale === 'en') {
    const command = process.env.TYCHO_STARTED_BY === 'tycho' ? 'tycho open' : 'npm run login-link';
    const channels = imChannelNames(hasIm, 'en');
    return channels
      ? `Send 'login' to the bot in ${channels} for a link, or run ${command} on the host machine.`
      : `Run ${command} on the host machine to open the console.`;
  }
  const command = process.env.TYCHO_STARTED_BY === 'tycho' ? 'tycho open 打开控制台' : 'npm run login-link 获取链接';
  const { wecom, weixin } = resolveImHint(hasIm);
  if (wecom && weixin) return `请在企业微信或微信里私聊机器人发‘登录’获取链接，也可在本机运行 ${command}。`;
  if (weixin) return `请在微信里私聊机器人发‘登录’获取链接，也可在本机运行 ${command}。`;
  return wecom ? `请私聊机器人发‘登录’获取链接，也可在本机运行 ${command}。` : `请在服务所在电脑运行 ${command}。`;
};
const startDeviceLogin = (locale: Locale = getActiveLocale()): string =>
  `<form method="post" action="/login/device"><button>${locale === 'en' ? 'Sign in on this device' : '在这台设备上登录'}</button></form>`;
export const waitDeviceLoginPage = (request: DeviceLoginRequest, hasIm: ImLoginHint = false, locale: Locale = getActiveLocale()): string => {
  const channels = imChannelNames(hasIm, locale);
  const mins = Number(((request.expires_at - request.created_at) / MINUTE_MS).toFixed(1));
  if (locale === 'en') {
    return page(
      `<h1>${request.code}</h1><p>Open the console on a signed-in device, click "Admit" in the sidebar, and enter this code.</p>
  ${channels ? `<p>Or message the bot in ${channels}: login ${request.code}</p>` : ''}
  <p>Valid for ${mins} minutes. This page will enter the console automatically once approved.</p>`, true, locale);
  }
  return page(
    `<h1>${request.code}</h1><p>在已经登录的手机或电脑上打开控制台，点侧栏的“放行”，输入这个数。</p>
  ${channels ? `<p>或者在${channels}里私聊机器人发：登录 ${request.code}</p>` : ''}
  <p>${mins} 分钟内有效，放行后这一页会自动进入控制台。</p>`, true, locale);
};
export const endedDeviceLoginPage = (rejected = false, locale: Locale = getActiveLocale()): string => locale === 'en'
  ? page(`<h1>${rejected ? 'Sign-in was not approved' : 'Sign-in request expired'}</h1>
  <p>${rejected ? 'This sign-in request was rejected.' : 'The request expired, was already used, or the service restarted.'} Please try again.</p>
  <form method="post" action="/login/device"><button>Start over</button></form>`, false, locale)
  : page(`<h1>${rejected ? '这次登录没有被放行' : '登录请求已失效'}</h1>
  <p>${rejected ? '已拒绝这次登录。' : '请求已过期、已经用过，或服务已重启。'}请重新开始。</p>
  <form method="post" action="/login/device"><button>重新开始</button></form>`, false, locale);
export const deviceLoginFullPage = (locale: Locale = getActiveLocale()): string => page(
  locale === 'en' ? '<h1>Too many pending device sign-ins. Try again shortly.</h1>' : '<h1>现在等着放行的设备太多，稍后再试</h1>',
  false,
  locale,
);
// No lifetime here: the one in force now need not be the one this link was sent under.
export const deadLinkPage = (hasIm: ImLoginHint = false, locale: Locale = getActiveLocale()): string => locale === 'en'
  ? page(`<h1>This sign-in link has expired or was already used</h1><p>Request a new one. ${loginGuidance(hasIm, locale)}</p>${startDeviceLogin(locale)}`, false, locale)
  : page(`<h1>链接已失效或已经用过</h1><p>请重新获取。${loginGuidance(hasIm, locale)}</p>${startDeviceLogin(locale)}`, false, locale);
export const tooManyPage = (locale: Locale = getActiveLocale()): string => page(
  locale === 'en' ? '<h1>Too many attempts</h1><p>Please wait a minute and try again.</p>' : '<h1>尝试次数太多</h1><p>请一分钟后再试。</p>',
  false,
  locale,
);
// A checkout whose console was never built: the service runs, there is only no page to show.
export const notBuiltPage = (locale: Locale = getActiveLocale()): string =>
  page(
    locale === 'en'
      ? '<h1>Console not built yet: run npm run build:console</h1><p>Run this command in the repository directory, then refresh. The service and API are running normally.</p>'
      : '<h1>控制台还没有构建：运行 npm run build:console</h1><p>在仓库目录运行这条命令，再刷新这一页。服务和接口照常在运行。</p>',
    false,
    locale,
  );
export const enterPage = (hasIm: ImLoginHint = false, options?: { hasPassphrase?: boolean; error?: string; locale?: Locale }): string => {
  const locale = options?.locale ?? getActiveLocale();
  const en = locale === 'en';
  const errorBanner = options?.error ? `<p class="alert" role="alert">${escapeHtml(options.error)}</p>` : '';
  const passphraseSection = options?.hasPassphrase
    ? `${errorBanner}
  <form id="passphrase-login" method="post" action="/login/passphrase">
    <label class="label" for="passphrase-input">${en ? 'Owner passphrase' : '主人口令登录'}</label>
    <input id="passphrase-input" type="password" name="passphrase" autocomplete="current-password" placeholder="${en ? 'Enter passphrase' : '输入主人口令'}" required>
    <button type="submit">${en ? 'Sign in with passphrase' : '口令登录'}</button>
  </form>
  <div class="divider" role="separator"><span>${en ? 'Other sign-in methods' : '其他登录方式'}</span></div>`
    : errorBanner;
  const fallbackSection = `<div class="${options?.hasPassphrase ? 'other secondary' : 'other'}">
  <form id="enter" method="post" action="/login"><input type="hidden" name="credential"><button disabled>${en ? 'Enter' : '进入'}</button></form>
  <p id="link-status">${en ? 'JavaScript is required to read a one-time link, or request device approval below.' : '需要 JavaScript 读取一次性链接；也可在下方请求设备放行。'}</p>
  <noscript><p>${en ? 'JavaScript is disabled in your browser. Use device approval below.' : '浏览器未启用 JavaScript，请使用下面的设备放行。'}</p></noscript>
  <p>${loginGuidance(hasIm, locale)}</p>${startDeviceLogin(locale)}
  </div>`;
  const readyMsg = en ? 'Click Enter. This link can only be used once.' : '点击进入，链接只能使用一次。';
  const missingMsg = en ? 'No valid one-time link found. Request a new one or use device approval.' : '没有可用的一次性链接，请重新获取，或使用设备放行。';
  return page(`<h1>${en ? 'Sign in to Tycho' : '进入 Tycho'}</h1>
  ${passphraseSection}
  ${fallbackSection}
  <script>
  {
    const form = document.getElementById('enter');
    const field = form.elements.namedItem('credential');
    const button = form.querySelector('button');
    const status = document.getElementById('link-status');
    const update = () => {
      const match = /^#([0-9a-f]{64})$/.exec(location.hash);
      field.value = match ? match[1] : '';
      button.disabled = !match;
      status.textContent = match ? ${JSON.stringify(readyMsg)} : ${JSON.stringify(missingMsg)};
    };
    addEventListener('hashchange', update);
    update();
  }
  </script>`, false, locale);
};
