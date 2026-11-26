// DSH account quota & balance reader supporting:
// 1) DeepSeek Official (`GET https://api.deepseek.com/user/balance`)
// 2) OpenAI/New-API compatible gateways (`GET <origin>/v1/dashboard/billing/subscription` + `usage`)
import type { Account } from '../runner/snapshot.ts';
import type { Ledger } from './ledger.ts';
import type { CustomQuotaReader, QuotaReadResult } from './quota-read.ts';

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

export interface DshQuotaReaderOptions {
  token(accountId: string): string | undefined;
  ledger: Pick<Ledger, 'noteUsage' | 'rejectCredential' | 'accountCredentialRef'>;
  timeoutMs(): number;
  fetch?: typeof fetch;
  now?: () => number;
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function gatewayOriginOf(baseURL: string): string | null {
  try {
    const parsed = new URL(baseURL);
    return parsed.origin;
  } catch {
    return null;
  }
}

function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createDshQuotaReader(options: DshQuotaReaderOptions): CustomQuotaReader {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  function canRead(account: Pick<Account, 'executor'> & { id?: string; provider?: Account['provider'] }): boolean {
    if (account.executor !== 'dsh') return false;
    if (!account.provider) return false;
    const line = (account.provider as Record<string, unknown>).line;
    return line === 'official' || line === 'custom';
  }

  async function fetchJson(url: string, token: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
    const res = await doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  async function read(account: Account, ref: string | null, parentSignal: AbortSignal): Promise<QuotaReadResult> {
    const token = options.token(account.id);
    if (!token) return { ok: false, reason: '这个账号没有 API 密钥' };
    const provider = asObj(account.provider);
    if (!provider) return { ok: false, reason: '这个 dsh 账号未配置线路' };

    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('查询余额超时', 'TimeoutError')), options.timeoutMs());

    try {
      if (provider.line === 'official') {
        const { status, body } = await fetchJson(DEEPSEEK_BALANCE_URL, token, controller.signal);
        if (status === 401 && ref !== null) {
          options.ledger.rejectCredential(account.id, ref);
          return { ok: false, reason: 'DeepSeek API 密钥被拒绝（401）' };
        }
        if (status < 200 || status >= 300) {
          return { ok: false, reason: `DeepSeek 余额接口返回 HTTP ${status}` };
        }
        const rec = asObj(body);
        const available = rec?.is_available;
        const infos = Array.isArray(rec?.balance_infos) ? rec.balance_infos : [];
        const first = infos.map(asObj).find((item) => item && typeof item.total_balance === 'string');
        const currency = typeof first?.currency === 'string' ? first.currency : 'CNY';
        const balance = typeof first?.total_balance === 'string' ? first.total_balance : null;
        if (typeof available !== 'boolean' && balance === null) {
          return { ok: false, reason: 'DeepSeek 余额接口未返回可识别字段' };
        }
        const label = balance !== null ? `balance:${currency}:${balance}` : 'balance:official';
        const used = available === false ? 1 : 0;
        if (ref === options.ledger.accountCredentialRef(account.id)) {
          options.ledger.noteUsage(account.id, [{ window: label, used, resetsAt: null }], ref);
        }
        return { ok: true };
      }

      if (provider.line === 'custom' && typeof provider.baseURL === 'string') {
        const origin = gatewayOriginOf(provider.baseURL);
        if (!origin) return { ok: false, reason: '自定义网关地址无效' };
        const sub = await fetchJson(`${origin}/v1/dashboard/billing/subscription`, token, controller.signal);
        if (sub.status === 401 && ref !== null) {
          options.ledger.rejectCredential(account.id, ref);
          return { ok: false, reason: '网关 API 密钥被拒绝（401）' };
        }
        if (sub.status < 200 || sub.status >= 300) {
          return { ok: false, reason: `网关未开放余额查询接口（HTTP ${sub.status}）` };
        }
        const subObj = asObj(sub.body);
        const hardLimitUsd = asNum(subObj?.hard_limit_usd) ?? asNum(subObj?.system_hard_limit_usd);
        if (hardLimitUsd === null) {
          return { ok: false, reason: '网关返回格式不含额度上限字段' };
        }
        const nowMs = now();
        const startDate = formatIsoDate(nowMs - 30 * 24 * 60 * 60 * 1000);
        const endDate = formatIsoDate(nowMs + 24 * 60 * 60 * 1000);
        const usageRes = await fetchJson(
          `${origin}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`,
          token,
          controller.signal,
        );
        const usageObj = asObj(usageRes.body);
        const totalUsageCents = asNum(usageObj?.total_usage) ?? 0;
        const usedUsd = totalUsageCents / 100;
        // New-API / One-API uses a very large sentinel (e.g. >= 100,000,000) or 0 for unlimited tokens.
        const isUnlimited = hardLimitUsd <= 0 || hardLimitUsd >= 100_000_000;
        const usedRatio = isUnlimited ? 0 : Math.max(0, Math.min(1, usedUsd / hardLimitUsd));
        const windowLabel = isUnlimited
          ? `gateway_unlimited:$${usedUsd.toFixed(2)}`
          : `gateway_budget:$${Math.max(0, hardLimitUsd - usedUsd).toFixed(2)}/$${hardLimitUsd.toFixed(0)}`;
        if (ref === options.ledger.accountCredentialRef(account.id)) {
          options.ledger.noteUsage(account.id, [{ window: windowLabel, used: usedRatio, resetsAt: null }], ref);
        }
        return { ok: true };
      }

      return { ok: false, reason: '当前线路不支持查询余额' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onAbort);
    }
  }

  return { canRead, read };
}

export function combineQuotaReaders(...readers: readonly CustomQuotaReader[]): CustomQuotaReader {
  return {
    canRead(account) {
      return readers.some((reader) => reader.canRead(account));
    },
    read(account, ref, signal) {
      const match = readers.find((reader) => reader.canRead(account));
      if (!match) return Promise.resolve({ ok: false, reason: '这个执行器不报额度' });
      return match.read(account, ref, signal);
    },
  };
}
