import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  codexAccessExpiryMs,
  codexIdentityFromTokens,
  codexJwtPayload,
  decodeCodexOAuth,
   decodeCodexOAuthLease,
  encodeCodexOAuth,
  encodeCodexOAuthLease,
  formatCodexAuthFile,
  isCodexOAuthSecret,
  parseCodexAuthFile,
  writeCodexAuthHome,
  type CodexOAuthBundle,
} from '../adapters/codex-auth.ts';
import { accountSteps, parseRateLimits } from '../adapters/codex.ts';
import type { QuotaStep } from '../adapters/types.ts';
import { shellTalk, type TalkAnswer } from '../node/executors.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import type { Account } from '../runner/snapshot.ts';
import { NEEDS_LOGIN_TEXT } from '../shared/labels.ts';
import type { Accounts } from './accounts.ts';
import { loginRefused, type Ledger } from './ledger.ts';
import type { CustomQuotaReader, QuotaReadResult } from './quota-read.ts';
import { prepareOwnerOnlyDirectory } from './secrets.ts';

export const DEFAULT_CODEX_RENEW_BEFORE_MS = 24 * 60 * 60_000;
const MIN_RENEW_BEFORE_MS = 25 * 60_000;
export const DEFAULT_CODEX_PROACTIVE_INTERVAL_MS = 10 * 60_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 20_000;
const MIN_USABLE_REMAINING_MS = 30_000;

export type CodexTalkFn = (
  argv: string[],
  steps: readonly QuotaStep[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<TalkAnswer>;

export interface CodexAuthBrokerOptions {
  dataDir: string;
  ledger: Pick<Ledger, 'accountCredentialRef' | 'loginState' | 'rejectCredential' | 'noteIdentity' | 'noteUsage'>;
  accounts: Pick<Accounts, 'credentialOf' | 'refreshCredential' | 'list'>;
  version?: string;
  renewBeforeMs?: number;
  proactiveIntervalMs?: number;
  refreshTimeoutMs?: () => number;
  quotaTimeoutMs?: () => number;
  recovering?: () => boolean;
  now?: () => number;
  platform?: NodeJS.Platform;
  env?: () => NodeJS.ProcessEnv;
  processes?: HostProcesses;
  talk?: CodexTalkFn;
  log?: (line: string) => void;
}

function isPermanentRefreshRejection(answer: string | null): boolean {
  if (!answer) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  const result = obj.result && typeof obj.result === 'object' && !Array.isArray(obj.result)
    ? obj.result as Record<string, unknown>
    : undefined;
  if (result && (result.account === null || result.requiresOpenaiAuth === true)) return true;
  const error = obj.error && typeof obj.error === 'object' && !Array.isArray(obj.error)
    ? obj.error as Record<string, unknown>
    : undefined;
  const msg = typeof error?.message === 'string' ? error.message : '';
  return /could not be refreshed|log out and sign in|invalid_grant|refresh_token_reused|token.*revoked|invalid_issuer/i.test(msg);
}

export function createCodexAuthBroker(options: CodexAuthBrokerOptions) {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const version = options.version ?? '0.1.0';
  const renewBeforeMs = options.renewBeforeMs ?? DEFAULT_CODEX_RENEW_BEFORE_MS;
  const proactiveIntervalMs = options.proactiveIntervalMs ?? DEFAULT_CODEX_PROACTIVE_INTERVAL_MS;
  const refreshTimeoutMs = options.refreshTimeoutMs ?? (() => DEFAULT_REFRESH_TIMEOUT_MS);
  const quotaTimeoutMs = options.quotaTimeoutMs ?? refreshTimeoutMs;
  const log = options.log ?? ((line: string) => console.error(line));
  const workRoot = join(options.dataDir, 'codex-auth-work');

  const defaultTalk: CodexTalkFn = (argv, steps, timeoutMs, env, signal) =>
    shellTalk(argv, steps, timeoutMs, platform, {
      env,
      ...(options.processes ? { processes: options.processes } : {}),
      ...(signal ? { signal } : {}),
    });
  const talk = options.talk ?? defaultTalk;

  const locks = new Map<string, Promise<unknown>>();
  const activeControllers = new Set<AbortController>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  function withLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const next = (locks.get(accountId) ?? Promise.resolve()).then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    locks.set(accountId, settled);
    void settled.finally(() => {
      if (locks.get(accountId) === settled) locks.delete(accountId);
    });
    return next;
  }

  function isolatedEnv(codexHome: string, workDir: string): NodeJS.ProcessEnv {
    const base = options.env?.() ?? process.env;
    const clean: NodeJS.ProcessEnv = { ...base };
    for (const key of Object.keys(clean)) {
      if (/^(CODEX_API_KEY|OPENAI_API_KEY|CODEX_HOME)$/i.test(key)) delete clean[key];
    }
    const home = join(workDir, 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (platform === 'win32') mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
    return {
      ...clean,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
    };
  }

  async function removeWorkDir(dir: string): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        if (attempt < 5) await sleep(80);
      }
    }
  }

  function renewalLeadMs(bundle: CodexOAuthBundle, expMs: number): number {
    const iat = codexJwtPayload(bundle.access_token)?.iat;
    const issuedMs = typeof iat === 'number' && Number.isFinite(iat) && iat > 0
      ? Math.floor(iat * 1000)
      : Date.parse(bundle.last_refresh);
    if (Number.isFinite(issuedMs) && expMs > issuedMs) {
      const quarter = Math.floor((expMs - issuedMs) * 0.25);
      return Math.min(renewBeforeMs, Math.max(MIN_RENEW_BEFORE_MS, quarter));
    }
    return Math.min(renewBeforeMs, MIN_RENEW_BEFORE_MS);
  }

  function needsRenewal(bundle: CodexOAuthBundle, at: number): boolean {
    const expMs = codexAccessExpiryMs(bundle.access_token);
    return expMs === undefined || expMs - at <= renewalLeadMs(bundle, expMs);
  }

  function stillUsable(bundle: CodexOAuthBundle, at: number): boolean {
    const expMs = codexAccessExpiryMs(bundle.access_token);
    return expMs === undefined || expMs - at > MIN_USABLE_REMAINING_MS;
  }

  async function refreshLocked(accountId: string, force = false): Promise<{ ref: string; value: string } | undefined> {
    const held = options.accounts.credentialOf(accountId);
    if (!held) return undefined;
    if (!isCodexOAuthSecret(held.value)) return held;
    if (loginRefused(options.ledger.loginState(accountId), held.ref)) return undefined;
    const bundle = decodeCodexOAuth(held.value);
    if (!bundle) return undefined;

    const currentAt = now();
    if (!force && !needsRenewal(bundle, currentAt)) {
      return { ref: held.ref, value: encodeCodexOAuthLease(bundle) };
    }
    if (stopped) {
      return !force && stillUsable(bundle, currentAt) ? { ref: held.ref, value: encodeCodexOAuthLease(bundle) } : undefined;
    }

    prepareOwnerOnlyDirectory(workRoot);
    const dir = join(workRoot, randomUUID());
    const codexHome = join(dir, 'codex-home');
    prepareOwnerOnlyDirectory(dir);
    writeCodexAuthHome(codexHome, formatCodexAuthFile(bundle, true));

    const controller = new AbortController();
    activeControllers.add(controller);
    try {
      const answer = await talk(
        ['codex', 'app-server', '--listen', 'stdio://'],
        accountSteps(version, 'account/read', { refreshToken: true }),
        refreshTimeoutMs(),
        isolatedEnv(codexHome, dir),
        controller.signal,
      );
      const authPath = join(codexHome, 'auth.json');
      const rotated = existsSync(authPath)
        ? parseCodexAuthFile(readFileSync(authPath, 'utf8'), () => new Date(now()).toISOString())
        : undefined;

      // Check if codex actually rotated or preserved valid tokens without reporting auth loss.
      if (rotated && !isPermanentRefreshRejection(answer.answer)) {
        const nextSecret = encodeCodexOAuth(rotated);
        if (nextSecret !== held.value) {
          options.accounts.refreshCredential(accountId, held.ref, nextSecret);
          const identity = codexIdentityFromTokens(rotated);
          if (identity.accountLabel !== undefined || identity.quotaOwner !== undefined) {
            try { options.ledger.noteIdentity(accountId, identity); } catch { /* ignore degraded ledger */ }
          }
        }
        return { ref: held.ref, value: encodeCodexOAuthLease(rotated) };
      }

      if (isPermanentRefreshRejection(answer.answer)) {
        const afterAt = now();
        if (force || !stillUsable(bundle, afterAt)) {
          try { options.ledger.rejectCredential(accountId, held.ref); } catch { /* ignore */ }
          log(`Codex 账号 ${accountId} 的刷新令牌已失效，需重新登录`);
          return undefined;
        }
        log(`Codex 账号 ${accountId} 刷新令牌被拒，当前访问令牌仍在有效期内，暂继续使用`);
        return { ref: held.ref, value: encodeCodexOAuthLease(bundle) };
      }

      // Transient error (network hiccup, timeout, CLI busy): keep stored secret intact.
      const afterAt = now();
      if (!force && stillUsable(bundle, afterAt)) {
        log(`Codex 账号 ${accountId} 预防性刷新未完成（${answer.failure ?? '未拿到有效响应'}），沿用仍在有效期内的访问令牌`);
        return { ref: held.ref, value: encodeCodexOAuthLease(bundle) };
      }
      log(`Codex 账号 ${accountId} 的访问令牌刷新未完成：${answer.failure ?? '未拿到有效响应'}`);
      return undefined;
    } finally {
      activeControllers.delete(controller);
      await removeWorkDir(dir);
    }
  }

  // Information Expert for downstream 401s on stripped `codex-oauth-lease-v1:` tokens: a Worker
  // or Router holds no `refresh_token`, so an expired or revoked `access_token` is verified here
  // against the stored `refresh_token` before permanently marking the account rejected.
  async function verifyCredential(accountId: string, expectedRef: string): Promise<'rejected' | 'valid' | 'transient'> {
    return withLock(accountId, async () => {
      const held = options.accounts.credentialOf(accountId);
      if (!held || held.ref !== expectedRef) return 'valid';
      if (!isCodexOAuthSecret(held.value)) {
        try { options.ledger.rejectCredential(accountId, expectedRef); } catch { /* ignore */ }
        return 'rejected';
      }
      if (loginRefused(options.ledger.loginState(accountId), expectedRef)) return 'rejected';
      const refreshed = await refreshLocked(accountId, true);
      if (refreshed !== undefined) return 'valid';
      return loginRefused(options.ledger.loginState(accountId), expectedRef) ? 'rejected' : 'transient';
    });
  }

  async function lease(accountId: string): Promise<{ ref: string; value: string } | undefined> {
    const held = options.accounts.credentialOf(accountId);
    if (!held) return undefined;
    if (!isCodexOAuthSecret(held.value)) return held;
    if (loginRefused(options.ledger.loginState(accountId), held.ref)) return undefined;
    const bundle = decodeCodexOAuth(held.value);
    if (!bundle) return undefined;
    if (!needsRenewal(bundle, now())) {
      return { ref: held.ref, value: encodeCodexOAuthLease(bundle) };
    }
    return withLock(accountId, () => refreshLocked(accountId));
  }

  async function runProactivePass(): Promise<void> {
    if (stopped || options.recovering?.()) return;
    for (const account of options.accounts.list()) {
      if (stopped) return;
      if (account.executor !== 'codex') continue;
      const held = options.accounts.credentialOf(account.id);
      if (!held || !isCodexOAuthSecret(held.value)) continue;
      if (loginRefused(options.ledger.loginState(account.id), held.ref)) continue;
      const bundle = decodeCodexOAuth(held.value);
      if (!bundle || !needsRenewal(bundle, now())) continue;
      await withLock(account.id, () => refreshLocked(account.id)).catch((err: unknown) => {
        log(`Codex 账号 ${account.name} 后台续期出错：${String(err)}`);
      });
    }
  }

  function armProactiveTimer(): void {
    clearTimeout(timer);
    if (stopped || proactiveIntervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runProactivePass().finally(() => {
        if (!stopped) armProactiveTimer();
      });
    }, proactiveIntervalMs);
    timer.unref();
  }

  const quotaReader: CustomQuotaReader = {
    canRead({ executor, id }) {
      if (executor !== 'codex' || id === undefined) return false;
      const ref = options.ledger.accountCredentialRef(id);
      if (ref?.startsWith('oauth-') === true) return true;
      const held = options.accounts.credentialOf(id);
      return held !== undefined && isCodexOAuthSecret(held.value);
    },
    async read(account: Account, expectedRef: string | null, signal: AbortSignal): Promise<QuotaReadResult> {
      const leased = await lease(account.id);
      if (expectedRef !== options.ledger.accountCredentialRef(account.id)) {
        return { ok: false, reason: '读取额度期间账号凭据已更换' };
      }
      if (!leased) {
        if (loginRefused(options.ledger.loginState(account.id), expectedRef)) {
          return { ok: false, reason: NEEDS_LOGIN_TEXT };
        }
        return { ok: false, reason: 'Codex 登录令牌不可用或刷新失败，请稍后重试或重新登录' };
      }
      const parsedLease = decodeCodexOAuthLease(leased.value);
      if (!parsedLease) return { ok: false, reason: 'Codex 授权凭据损坏' };

      prepareOwnerOnlyDirectory(workRoot);
      const dir = join(workRoot, randomUUID());
      const codexHome = join(dir, 'codex-home');
      prepareOwnerOnlyDirectory(dir);
      writeCodexAuthHome(codexHome, formatCodexAuthFile(parsedLease, false));
      try {
        const answer = await talk(
          ['codex', 'app-server', '--listen', 'stdio://'],
          accountSteps(version, 'account/rateLimits/read'),
          quotaTimeoutMs(),
          isolatedEnv(codexHome, dir),
          signal,
        );
        if (expectedRef !== options.ledger.accountCredentialRef(account.id)) {
          return { ok: false, reason: '读取额度期间账号凭据已更换' };
        }
        if (answer.answer === null) {
          return { ok: false, reason: answer.failure ?? 'codex 没有返回额度结果' };
        }
        const reading = parseRateLimits(answer.answer);
        if ('problem' in reading) {
          if (/401|unauthorized|not logged in/i.test(answer.answer) && expectedRef !== null) {
            await verifyCredential(account.id, expectedRef);
          }
          return { ok: false, reason: reading.problem };
        }
        options.ledger.noteUsage(
          account.id,
          reading.windows.map((w) => ({ window: w.window, used: w.used, resetsAt: w.resets_at })),
          leased.ref,
        );
        return { ok: true };
      } finally {
        await removeWorkDir(dir);
      }
    },
  };

  return {
    tidy(): void {
      try {
        rmSync(workRoot, { recursive: true, force: true });
      } catch {
        log('清理残留的 Codex 令牌刷新目录未完成，下次启动再清');
      }
    },
    start(): void {
      stopped = false;
      armProactiveTimer();
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      for (const controller of activeControllers) controller.abort();
      await Promise.allSettled([...locks.values()]);
    },
    lease,
    verifyCredential,
    runProactivePass,
    quotaReader,
  };
}

export type CodexAuthBroker = ReturnType<typeof createCodexAuthBroker>;
