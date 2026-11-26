// Account quota over the adapter's HTTP protocol (docs/design/usage.md §3).
// Windows live in login_state; only in-flight state and the last failure live here.
import type { Account } from '../runner/snapshot.ts';
import type { Adapter } from '../adapters/types.ts';
import type { Ledger } from './ledger.ts';
import { loginRefused, usageNow } from './ledger.ts';
import { NEEDS_LOGIN_TEXT } from '../shared/labels.ts';

const REASON_CHARS = 300;

// A 429 without usable windows is not a broken command or a bad answer: the executor is
// limiting this read and will take it later. Said as the neutral state it is, never as the
// red failure the page shows for a genuine error.
const LIMITED_TEXT = '额度服务暂时限制了这次读取，稍后再试';
// How long a 429 with no `Retry-After` suppresses the automatic read. Bounded, so a limit
// never turns into "never read again"; a `Retry-After` overrides it, up to the cap.
const LIMITED_BACKOFF_MS = 60_000;
const LIMITED_MAX_MS = 30 * 60_000;

export interface QuotaReadState {
  reading: boolean;
  tried_at: string | null;
  // A genuine command, protocol or transport failure: the page shows it as a problem.
  failure: string | null;
  // A neutral "limited, try later" from a 429 without windows: the page says it plainly and
  // keeps the last figures. Null when the last attempt was anything else.
  limited: string | null;
  // When the suppression ends, if a limited result set one.
  retry_at: string | null;
}

export type QuotaReadResult =
  | { ok: true }
  | { ok: false; reason: string; limited?: true; retryAt?: string | null };

export interface CustomQuotaReader {
  canRead(account: Pick<Account, 'executor'> & { id?: string }): boolean;
  read(account: Account, ref: string | null, signal: AbortSignal): Promise<QuotaReadResult>;
}

export interface QuotaReadOptions {
  ledger: Pick<Ledger, 'noteUsage' | 'recordUsage' | 'loginState' | 'accountCredentialRef' | 'rejectCredential'>;
  adapters: Record<string, Adapter>;
  token(accountId: string): string | undefined;
  customRead?: CustomQuotaReader;
  // The existing model reader owns discovery, caching and its own deadline. Only needed
  // before the first quota read, when this account's model list has not arrived yet.
  refreshModels?: (account: Account) => Promise<{ ok: true } | { ok: false; reason: string; status?: number }>;
  timeoutMs(): number;
  staleMs(): number;
  log(line: string): void;
  onSettled?: () => void;
  now?: () => number;
  // Same global fetch as service/models.ts: proxy handling belongs to process startup.
  fetch?: typeof fetch;
}

export interface QuotaReads {
  refusal(account: Pick<Account, 'executor'> & { id?: string }): string | undefined;
  read(account: Account): Promise<QuotaReadResult>;
  stop(): Promise<void>;
  readStale(accounts: readonly Account[]): void;
  state(accountId: string): QuotaReadState;
}

const NOT_REPORTED = '这个执行器不报额度';

interface HeldRead {
  ref: string | null;
  at: number;
  failure: string | null;
  limited: string | null;
  retryAt: string | null;
}

// When the automatic reads may ask this account again after a limited result. A plain
// `Retry-After` in seconds or as an HTTP date; the cap keeps a vendor from parking a read for
// a day, and no header at all still gives a bounded pause rather than a hot retry.
function limitedUntil(headers: Headers, at: number): number {
  const value = headers.get('retry-after');
  let wait = LIMITED_BACKOFF_MS;
  if (value !== null && value.trim() !== '') {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) wait = seconds * 1000;
    else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) wait = Math.max(0, date - at);
    }
  }
  return at + Math.min(wait, LIMITED_MAX_MS);
}

export function createQuotaReads(options: QuotaReadOptions): QuotaReads {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;
  const inFlight = new Map<string, Promise<QuotaReadResult>>();
  const controllers = new Set<AbortController>();
  let stopped = false;
  const last = new Map<string, HeldRead>();

  const refusal = ({ executor, id }: Pick<Account, 'executor'> & { id?: string }): string | undefined => {
    if (options.adapters[executor]?.quotaRead === undefined && options.customRead?.canRead({ executor, id }) !== true) {
      return NOT_REPORTED;
    }
    // A credential the executor already refused is not read again: the owner signs in first.
    // The judgment is the ledger's, from the number the login holds now, so a replacement
    // makes it a candidate again without any other step.
    if (id !== undefined && loginRefused(options.ledger.loginState(id), options.ledger.accountCredentialRef(id))) return NEEDS_LOGIN_TEXT;
    return undefined;
  };

  // A limited read is not retried until its bounded pause is over: an explicit refresh during
  // the pause says the same neutral thing rather than spending another request.
  function suppressed(accountId: string, at: number): HeldRead | undefined {
    const held = lastRead(accountId);
    return held?.retryAt && Date.parse(held.retryAt) > at ? held : undefined;
  }

  function read(account: Account): Promise<QuotaReadResult> {
    const held = inFlight.get(account.id);
    if (held) return held;
    const paused = suppressed(account.id, now());
    if (paused) return Promise.resolve({ ok: false, reason: LIMITED_TEXT, limited: true, retryAt: paused.retryAt });
    const ref = options.ledger.accountCredentialRef(account.id);
    const going = attempt(account, ref).catch((err: unknown): QuotaReadResult => ({
      ok: false, reason: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).trim().slice(0, REASON_CHARS),
    })).then((result) => {
      if (ref !== options.ledger.accountCredentialRef(account.id)) return result;
      const limited = !result.ok && result.limited === true ? result.reason : null;
      last.set(account.id, {
        ref,
        at: now(),
        failure: result.ok || result.limited === true ? null : result.reason,
        limited,
        retryAt: result.ok || result.limited !== true ? null : (result.retryAt ?? new Date(now() + LIMITED_BACKOFF_MS).toISOString()),
      });
      return result;
    }).finally(() => {
      inFlight.delete(account.id);
      options.onSettled?.();
    });
    inFlight.set(account.id, going);
    return going;
  }

  async function attempt(account: Account, ref: string | null): Promise<QuotaReadResult> {
    if (stopped) return { ok: false, reason: '服务正在停止' };
    const how = options.adapters[account.executor]?.quotaRead;
    const custom = how === undefined && options.customRead?.canRead(account) === true ? options.customRead : undefined;
    if (!how && !custom) return { ok: false, reason: NOT_REPORTED };
    // The number the account holds when this read starts. A rejection is recorded against
    // exactly this number, and the ledger ignores it if the owner has replaced it since.
    if (loginRefused(options.ledger.loginState(account.id), ref)) return { ok: false, reason: NEEDS_LOGIN_TEXT };
    if (custom) {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        return await custom.read(account, ref, controller.signal);
      } finally {
        controllers.delete(controller);
      }
    }
    if (!how) return { ok: false, reason: NOT_REPORTED };
    const token = options.token(account.id);
    if (!token) return { ok: false, reason: '这个账号没有登录令牌' };
    const scrub = (text: string): string => text.split(token).join('[令牌已隐去]');
    const failure = (text: string): QuotaReadResult => ({ ok: false, reason: scrub(text).trim().slice(0, REASON_CHARS) });
    const controller = new AbortController();
    controllers.add(controller);
    let timer: NodeJS.Timeout | undefined;
    try {
      const modelState = options.ledger.loginState(account.id);
      if ((modelState.models.length === 0 || modelState.models_at === null) && options.refreshModels) {
        const result = await options.refreshModels(account);
        if (!result.ok) {
          if (result.status === 401 && ref !== null) options.ledger.rejectCredential(account.id, ref);
          return failure(result.reason);
        }
      }
      if (stopped) return failure('服务正在停止');
      if (ref !== options.ledger.accountCredentialRef(account.id)) return failure('读取额度期间账号凭据已更换');
      const query = how({ token, models: options.ledger.loginState(account.id).models });
      const timeoutMs = options.timeoutMs();
      // Only this HTTP request is timed, through the last body byte; model discovery uses
      // its existing deadline. Abort also closes a pending fetch when the service stops.
      timer = setTimeout(() => controller.abort(new DOMException(`${timeoutMs} ms 内没有答复`, 'TimeoutError')), timeoutMs);
      const response = await doFetch(query.url, {
        method: 'POST', headers: query.headers, body: query.body,
        redirect: 'error', signal: controller.signal,
      });
      if (response.status === 401 && ref !== null) options.ledger.rejectCredential(account.id, ref);
      const parsed = query.parse(response.headers, await response.text());
      // Even a response without quota headers may have spent tokens. Keep only normalized
      // facts, with echoed secrets removed before anything can enter the ledger/change.
      if (parsed.usage.length > 0) options.ledger.recordUsage({ login_id: account.id }, parsed.usage.map((usage) => ({
        ...usage, ...(usage.model === undefined ? {} : { model: scrub(usage.model) }),
      })));
      if (parsed.quota.length > 0 && (response.ok || response.status === 429)) {
        options.ledger.noteUsage(account.id, parsed.quota.map((window) => ({ ...window, window: scrub(window.window) })), ref);
      }
      if (!response.ok) {
        // 429 with windows is a successful read: the figures (a fully used general window
        // among them) are what say the limit, and the page shows them as figures, not as a
        // failed command. Dispatch is untouched: a rest is the ledger's own statement.
        if (response.status === 429 && parsed.quota.length > 0) return { ok: true };
        // 429 with nothing to show is the executor limiting the read, not a broken command:
        // a neutral result with a bounded pause, and the held figures stay.
        if (response.status === 429) {
          const retryAt = new Date(limitedUntil(response.headers, now())).toISOString();
          return { ok: false, reason: LIMITED_TEXT, limited: true, retryAt };
        }
        return failure(`HTTP ${response.status}: ${parsed.failure || response.statusText}`);
      }
      if (parsed.failure) return failure(parsed.failure);
      return parsed.quota.length > 0 ? { ok: true } : failure(`${account.executor} 这次没有报额度（HTTP ${response.status}）`);
    } catch (err) {
      return failure(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  function readStale(accounts: readonly Account[]): void {
    const stale = options.staleMs();
    if (stale <= 0 || stopped) return;
    const at = now();
    for (const account of accounts) {
      if (refusal(account) !== undefined || inFlight.has(account.id) || suppressed(account.id, at)) continue;
      const figures = usageNow(options.ledger.loginState(account.id), at);
      const readAt = Math.max(0, ...figures.map((figure) => Date.parse(figure.at)), lastRead(account.id)?.at ?? 0);
      if (at - readAt < stale) continue;
      void read(account).then((result) => {
        if (!result.ok) options.log(`读账号 ${account.name} 的额度没读到：${result.reason}`);
      });
    }
  }

  function lastRead(accountId: string): HeldRead | undefined {
    const held = last.get(accountId);
    return held?.ref === options.ledger.accountCredentialRef(accountId) ? held : undefined;
  }

  function state(accountId: string): QuotaReadState {
    const held = lastRead(accountId);
    return {
      reading: inFlight.has(accountId),
      tried_at: held === undefined ? null : new Date(held.at).toISOString(),
      failure: held?.failure ?? null,
      limited: held?.limited ?? null,
      retry_at: held?.retryAt ?? null,
    };
  }

  async function stop(): Promise<void> {
    stopped = true;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...inFlight.values()]);
  }

  return { refusal, read, readStale, state, stop };
}
