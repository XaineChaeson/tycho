import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emailAccountLabel, maskEmailIdentity, planLabelOf, type ExecutorIdentity } from '../shared/logins.ts';

export const CODEX_OAUTH_PREFIX = 'codex-oauth-v1:';
export const CODEX_OAUTH_LEASE_PREFIX = 'codex-oauth-lease-v1:';
export const MAX_CODEX_OAUTH_SECRET_CHARS = 16_384;

export interface CodexOAuthLease {
  id_token: string;
  access_token: string;
  account_id: string | null;
  last_refresh: string;
}

export interface CodexOAuthBundle extends CodexOAuthLease {
  refresh_token: string;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const tokenString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && !/[\s\0]/.test(value) ? value : undefined;

const optionalAccountId = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' && !/[\s\0]/.test(value) ? value : undefined;
};

export const isCodexOAuthSecret = (value: string): boolean => value.startsWith(CODEX_OAUTH_PREFIX);
export const isCodexOAuthLease = (value: string): boolean => value.startsWith(CODEX_OAUTH_LEASE_PREFIX);

export function encodeCodexOAuth(bundle: CodexOAuthBundle): string {
  const payload: CodexOAuthBundle = {
    id_token: bundle.id_token,
    access_token: bundle.access_token,
    refresh_token: bundle.refresh_token,
    account_id: bundle.account_id,
    last_refresh: bundle.last_refresh,
  };
  return `${CODEX_OAUTH_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeCodexOAuth(secret: string): CodexOAuthBundle | undefined {
  if (!isCodexOAuthSecret(secret) || secret.length > MAX_CODEX_OAUTH_SECRET_CHARS || /[\s\0]/.test(secret)) return undefined;
  const encoded = secret.slice(CODEX_OAUTH_PREFIX.length);
  if (encoded === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const idToken = tokenString(parsed.id_token);
  const accessToken = tokenString(parsed.access_token);
  const refreshToken = tokenString(parsed.refresh_token);
  const accountId = optionalAccountId(parsed.account_id);
  const lastRefresh = typeof parsed.last_refresh === 'string' && parsed.last_refresh.trim() !== '' ? parsed.last_refresh.trim() : undefined;
  if (!idToken || !accessToken || !refreshToken || accountId === undefined || !lastRefresh) return undefined;
  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    last_refresh: lastRefresh,
  };
}

export function encodeCodexOAuthLease(bundle: CodexOAuthLease): string {
  const payload: CodexOAuthLease = {
    id_token: bundle.id_token,
    access_token: bundle.access_token,
    account_id: bundle.account_id,
    last_refresh: bundle.last_refresh,
  };
  return `${CODEX_OAUTH_LEASE_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

export function decodeCodexOAuthLease(secret: string): CodexOAuthLease | undefined {
  if (isCodexOAuthSecret(secret)) {
    const full = decodeCodexOAuth(secret);
    return full ? { id_token: full.id_token, access_token: full.access_token, account_id: full.account_id, last_refresh: full.last_refresh } : undefined;
  }
  if (!isCodexOAuthLease(secret) || secret.length > MAX_CODEX_OAUTH_SECRET_CHARS || /[\s\0]/.test(secret)) return undefined;
  const encoded = secret.slice(CODEX_OAUTH_LEASE_PREFIX.length);
  if (encoded === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const idToken = tokenString(parsed.id_token);
  const accessToken = tokenString(parsed.access_token);
  const accountId = optionalAccountId(parsed.account_id);
  const lastRefresh = typeof parsed.last_refresh === 'string' && parsed.last_refresh.trim() !== '' ? parsed.last_refresh.trim() : undefined;
  if (!idToken || !accessToken || accountId === undefined || !lastRefresh) return undefined;
  return {
    id_token: idToken,
    access_token: accessToken,
    account_id: accountId,
    last_refresh: lastRefresh,
  };
}

export function parseCodexAuthFile(text: string, fallbackNow = () => new Date().toISOString()): CodexOAuthBundle | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const tokens = isObject(parsed.tokens) ? parsed.tokens : undefined;
  if (!tokens) return undefined;
  const idToken = tokenString(tokens.id_token);
  const accessToken = tokenString(tokens.access_token);
  const refreshToken = tokenString(tokens.refresh_token);
  const accountId = optionalAccountId(tokens.account_id);
  if (!idToken || !accessToken || !refreshToken || accountId === undefined) return undefined;
  const lastRefresh = typeof parsed.last_refresh === 'string' && parsed.last_refresh.trim() !== '' ? parsed.last_refresh.trim() : fallbackNow();
  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    last_refresh: lastRefresh,
  };
}

export function formatCodexAuthFile(bundle: CodexOAuthBundle | CodexOAuthLease, includeRefresh: boolean): string {
  const refresh = includeRefresh && 'refresh_token' in bundle ? bundle.refresh_token : '';
  return `${JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: bundle.id_token,
      access_token: bundle.access_token,
      refresh_token: refresh,
      account_id: bundle.account_id,
    },
    last_refresh: bundle.last_refresh,
  }, null, 2)}\n`;
}

export function codexJwtPayload(jwt: string): JsonObject | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function codexAccessExpiryMs(accessToken: string): number | undefined {
  const exp = codexJwtPayload(accessToken)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? Math.floor(exp * 1000) : undefined;
}

function formatCodexPlan(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower === 'plus') return 'Plus';
  if (lower === 'pro') return 'Pro';
  if (lower === 'team') return 'Team';
  if (lower === 'enterprise') return 'Enterprise';
  if (lower === 'free') return 'Free';
  return planLabelOf(raw.trim());
}

export function codexEmailIdentity(rawEmail: unknown, rawPlan?: unknown): ExecutorIdentity {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  const quotaOwner = /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(email)
    ? `v1:${createHash('sha256').update(email).digest('hex')}`
    : undefined;
  const label = maskEmailIdentity(rawEmail) ?? emailAccountLabel(rawEmail);
  const plan = formatCodexPlan(rawPlan);
  return {
    ...(label ? { accountLabel: label } : {}),
    ...(plan ? { planLabel: plan } : {}),
    ...(quotaOwner === undefined ? {} : { quotaOwner }),
  };
}

export function codexIdentityFromTokens(tokens: Pick<CodexOAuthLease, 'id_token' | 'access_token'>): ExecutorIdentity {
  const idClaims = codexJwtPayload(tokens.id_token);
  const accessClaims = codexJwtPayload(tokens.access_token);
  const profile = isObject(accessClaims?.['https://api.openai.com/profile']) ? accessClaims['https://api.openai.com/profile'] : undefined;
  const idAuth = isObject(idClaims?.['https://api.openai.com/auth']) ? idClaims['https://api.openai.com/auth'] : undefined;
  const accessAuth = isObject(accessClaims?.['https://api.openai.com/auth']) ? accessClaims['https://api.openai.com/auth'] : undefined;
  const email = idClaims?.email ?? profile?.email ?? accessClaims?.email;
  const plan = idAuth?.chatgpt_plan_type ?? accessAuth?.chatgpt_plan_type;
  return codexEmailIdentity(email, plan);
}

export function codexSecretStrings(credential: string): string[] {
  const full = decodeCodexOAuth(credential);
  if (full) {
    return [credential, encodeCodexOAuthLease(full), full.access_token, full.id_token, full.refresh_token];
  }
  const lease = decodeCodexOAuthLease(credential);
  if (lease) {
    return [credential, lease.access_token, lease.id_token];
  }
  return [credential];
}

export function writeCodexAuthHome(targetHome: string, authJson: string): void {
  mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  try { chmodSync(targetHome, 0o700); } catch { /* Windows ACL handled by parent dir */ }
  const authPath = join(targetHome, 'auth.json');
  rmSync(authPath, { force: true });
  writeFileSync(authPath, authJson, { mode: 0o600 });
  try { chmodSync(authPath, 0o600); } catch { /* Windows mode bits ignored */ }
}

export function normalizedConfigToml(text: string): string {
  // Strip top-level `service_tier` (e.g. desktop `service_tier = "ultrafast"` / `"fast"`) so
  // unattended background workers never silently inherit high-multiplier desktop speed tiers.
  // Explicit tier overrides still apply via `-c service_tier=...` on the CLI.
  // Also ensure a machine config that opted into OS keyring never overrides the leased auth.json.
  const lines = text.split(/\r?\n/);
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) inSection = true;
    if (!inSection && /^\s*service_tier\s*=/.test(line)) continue;
    if (/^\s*cli_auth_credentials_store\s*=/.test(line)) {
      out.push('cli_auth_credentials_store = "file"');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function linkOrCopyDir(sourceDir: string, targetDir: string): void {
  try {
    if (!statSync(sourceDir).isDirectory()) return;
  } catch {
    return;
  }
  rmSync(targetDir, { recursive: true, force: true });
  try {
    symlinkSync(resolve(sourceDir), targetDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    try {
      cpSync(sourceDir, targetDir, { recursive: true });
    } catch {
      // Non-essential machine convenience directory; round proceeds cleanly without it.
    }
  }
}

function stripTychoGlobalEntry(text: string): string | null {
  const normalized = text.replace(/^\uFEFF/, '');
  const first = normalized.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (/^<!--\s*tycho:generated(?::v2\s+publisher:[^ ]+)?\s*-->$/i.test(first)) {
    return null;
  }
  const stripped = normalized
    .replace(/\r?\n?<!-- tycho:managed:v2:start publisher:[^ ]+ -->[\s\S]*?<!-- tycho:managed:v2:end publisher:[^ ]+ -->\r?\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped === '' ? null : `${stripped}\n`;
}

export function removeCodexAuthFile(targetHome: string): void {
  try {
    rmSync(join(targetHome, 'auth.json'), { force: true });
  } catch {
    // Best-effort cleanup; auth.json holds only an access-token lease without refresh_token.
  }
}

export function materializeCodexWorkerHome(
  lease: CodexOAuthLease,
  targetHome: string,
  baseHome?: string,
): Record<string, string | undefined> {
  mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  try { chmodSync(targetHome, 0o700); } catch { /* Windows mode bits ignored */ }
  if (baseHome && existsSync(baseHome) && resolve(baseHome) !== resolve(targetHome)) {
    const configPath = join(baseHome, 'config.toml');
    if (existsSync(configPath)) {
      try {
        writeFileSync(join(targetHome, 'config.toml'), normalizedConfigToml(readFileSync(configPath, 'utf8')));
      } catch { /* ignore unreadable machine config */ }
    }
    for (const file of ['AGENTS.md', 'AGENTS.override.md']) {
      const src = join(baseHome, file);
      const dst = join(targetHome, file);
      if (existsSync(src)) {
        try {
          const sanitized = stripTychoGlobalEntry(readFileSync(src, 'utf8'));
          if (sanitized !== null) writeFileSync(dst, sanitized, 'utf8');
          else rmSync(dst, { force: true });
        } catch { /* ignore */ }
      }
    }
    for (const dir of ['skills', 'memories', '.sandbox', '.sandbox-bin', '.sandbox-secrets']) {
      linkOrCopyDir(join(baseHome, dir), join(targetHome, dir));
    }
  }
  writeCodexAuthHome(targetHome, formatCodexAuthFile(lease, false));
  return {
    CODEX_HOME: targetHome,
    CODEX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  };
}
