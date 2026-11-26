// Machine-local quota & balance probe for `dsh` (DeepSeek Harness).
// Runs exclusively on the machine where `~/.dsh` lives so:
//   1) Local API keys never leave the machine; only normalized quota/balance windows travel to the host.
//   2) LAN-only gateways (such as an internal New-API/One-API gateway configured in `cordis.patch.yml`)
//      are reachable directly from the workstation even when the Tycho host runs in the cloud.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { QuotaReading, QuotaWindow } from './types.ts';

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const UNLIMITED_HARD_LIMIT_USD = 100_000_000;

export interface DshMachineQuotaContext {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
  homeDir?: string;
}

interface ParsedGatewayProvider {
  id: string;
  displayName: string;
  baseURL: string;
  apiKeyEnv?: string;
  apiKey?: string;
}

interface ParsedDshProfile {
  defaultProvider: string | null;
  officialDisabled: boolean;
  providers: ParsedGatewayProvider[];
}

function unquote(value: string): string {
  const cleaned = value.replace(/\s+#.*$/, '').trim();
  return cleaned.replace(/^(['"])(.*)\1$/, '$2').trim();
}

function asObj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeRouteTag(name: string): string {
  const clean = name.trim().replace(/[:\s/\\]+/g, '_').replace(/[^\w.-]/g, '').slice(0, 32);
  return clean || 'gateway';
}

function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function gatewayOriginOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).origin;
  } catch {
    return null;
  }
}

// Parse `$DSH_HOME/.credentials.yaml` `records.deepseek-account-platform/default` (`token` & `issuer`)
export function parseDshPlatformGrant(yamlText: string): { token: string; issuer: string } | null {
  const lines = yamlText.split(/\r?\n/);
  let inGrant = false;
  let grantIndent = 0;
  let token: string | null = null;
  let issuer: string | null = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = /^\s*/.exec(raw)![0].length;
    if (!inGrant) {
      if (/^['"]?deepseek-account-platform\/default['"]?:\s*$/.test(trimmed)) {
        inGrant = true;
        grantIndent = indent;
      }
      continue;
    }
    if (indent <= grantIndent) break;
    const tok = /^token:\s*(.+)$/.exec(trimmed);
    if (tok) token = unquote(tok[1]!);
    const iss = /^issuer:\s*(.+)$/.exec(trimmed);
    if (iss) issuer = unquote(iss[1]!);
  }
  if (!token || !issuer) return null;
  const origin = gatewayOriginOf(issuer);
  if (!origin) return null;
  return { token, issuer: origin };
}

function formatWalletAmount(raw: string): string | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value.toFixed(2);
}

// Parse `$DSH_HOME/.credentials.yaml` `refs:` mapping (`KEY_NAME: value`) without pulling in a YAML dependency.
export function parseDshCredentialRefs(yamlText: string): Record<string, string> {
  const refs: Record<string, string> = {};
  const lines = yamlText.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = /^\s*/.exec(raw)![0].length;
    if (!inRefs) {
      if (/^refs:\s*$/.test(trimmed)) {
        inRefs = true;
        refsIndent = indent;
      }
      continue;
    }
    if (indent <= refsIndent) {
      inRefs = false;
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(trimmed);
    if (pair) {
      const value = unquote(pair[2]!);
      if (value !== '') refs[pair[1]!] = value;
    }
  }
  return refs;
}

// Parse `$DSH_HOME/profiles/<name>/cordis.patch.yml` for:
// - `agent-default-model` -> `config.provider`
// - `llm-pi-ai` -> `config.providers.<id>` (`displayName`, `baseURL`, `apiKeyEnv`, `apiKey`)
// - `llm-deepseek` -> `disabled: true`
export function parseDshProfilePatch(yamlText: string): ParsedDshProfile {
  const lines = yamlText.split(/\r?\n/);
  let defaultProvider: string | null = null;
  let officialDisabled = false;
  const providers: ParsedGatewayProvider[] = [];

  let entryId: string | null = null;
  let inProviders = false;
  let providersIndent = -1;
  let currentProvider: Partial<ParsedGatewayProvider> & { id?: string; indent?: number } | null = null;

  const flushProvider = () => {
    if (currentProvider?.id && currentProvider.baseURL) {
      providers.push({
        id: currentProvider.id,
        displayName: currentProvider.displayName || currentProvider.id,
        baseURL: currentProvider.baseURL,
        ...(currentProvider.apiKeyEnv ? { apiKeyEnv: currentProvider.apiKeyEnv } : {}),
        ...(currentProvider.apiKey ? { apiKey: currentProvider.apiKey } : {}),
      });
    }
    currentProvider = null;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = /^\s*/.exec(raw)![0].length;

    const topEntry = /^-\s+id:\s*(.+)$/.exec(raw);
    if (topEntry) {
      flushProvider();
      entryId = unquote(topEntry[1]!);
      inProviders = false;
      providersIndent = -1;
      continue;
    }

    if (entryId === 'agent-default-model') {
      const prov = /^provider:\s*(.+)$/.exec(trimmed);
      if (prov) defaultProvider = unquote(prov[1]!);
      continue;
    }

    if (entryId === 'llm-deepseek') {
      const dis = /^disabled:\s*(true|false)$/i.exec(trimmed);
      if (dis) officialDisabled = dis[1]!.toLowerCase() === 'true';
      continue;
    }

    if (entryId === 'llm-pi-ai') {
      if (!inProviders) {
        if (/^providers:\s*$/.test(trimmed)) {
          inProviders = true;
          providersIndent = indent;
        }
        continue;
      }
      if (indent <= providersIndent) {
        flushProvider();
        inProviders = false;
        continue;
      }
      // Provider block header: one indent level deeper than `providers:`
      if (currentProvider === null || (currentProvider.indent !== undefined && indent === currentProvider.indent)) {
        const header = /^([A-Za-z0-9_.-]+):\s*$/.exec(trimmed);
        if (header) {
          flushProvider();
          currentProvider = { id: header[1]!, indent };
          continue;
        }
      }
      if (currentProvider !== null && currentProvider.indent !== undefined && indent > currentProvider.indent) {
        // Direct fields of this provider (only capture immediate scalar keys, not nested models/retryPolicy)
        const field = /^(displayName|baseURL|apiKeyEnv|apiKey):\s*(.+)$/.exec(trimmed);
        if (field) {
          const val = unquote(field[2]!);
          if (field[1] === 'displayName') currentProvider.displayName = val;
          else if (field[1] === 'baseURL') currentProvider.baseURL = val;
          else if (field[1] === 'apiKeyEnv') currentProvider.apiKeyEnv = val;
          else if (field[1] === 'apiKey') currentProvider.apiKey = val;
        }
      }
    }
  }
  flushProvider();

  return { defaultProvider, officialDisabled, providers };
}

function readTextIfExists(filePath: string): string | null {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  } catch {
    return null;
  }
}

async function fetchJson(
  doFetch: typeof fetch,
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
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

export async function readDshMachineQuota(ctx: DshMachineQuotaContext): Promise<QuotaReading> {
  const doFetch = ctx.fetch ?? fetch;
  const now = ctx.now ?? Date.now;
  const home = ctx.homeDir ?? ctx.env.USERPROFILE ?? ctx.env.HOME ?? homedir();
  const dshHome = ctx.env.DSH_HOME?.trim() || join(home, '.dsh');

  const credYaml = readTextIfExists(join(dshHome, '.credentials.yaml'));
  const refs = credYaml ? parseDshCredentialRefs(credYaml) : {};
  const platformGrant = credYaml ? parseDshPlatformGrant(credYaml) : null;
  const resolveSecret = (keyName: string | undefined, inline?: string): string | undefined => {
    if (inline && inline.trim() !== '') return inline.trim();
    if (!keyName) return undefined;
    const fromEnv = ctx.env[keyName]?.trim();
    if (fromEnv) return fromEnv;
    const fromRefs = refs[keyName]?.trim();
    return fromRefs || undefined;
  };

  const headlessYaml = readTextIfExists(join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'));
  const desktopYaml = readTextIfExists(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'));
  const profile = headlessYaml
    ? parseDshProfilePatch(headlessYaml)
    : desktopYaml
      ? parseDshProfilePatch(desktopYaml)
      : { defaultProvider: null, officialDisabled: false, providers: [] };

  // Prioritize the active default provider first, then any additional configured custom gateways.
  const orderedProviders = [...profile.providers].sort((a, b) => {
    if (a.id === profile.defaultProvider) return -1;
    if (b.id === profile.defaultProvider) return 1;
    return 0;
  });

  const controller = new AbortController();
  const onParentAbort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('查询余额超时', 'TimeoutError')), ctx.timeoutMs);

  const windows: QuotaWindow[] = [];
  const errors: string[] = [];
  let attempted = 0;
  let sawOfficialBalance = false;

  try {
    // 1) DeepSeek Official Account Platform login (`deepseek-account-platform/default` via `x-dsh-auth-token`)
    if (platformGrant) {
      attempted += 1;
      try {
        const res = await doFetch(`${platformGrant.issuer}/api/v0/users/get_user_summary`, {
          method: 'GET',
          headers: {
            'x-dsh-auth-token': platformGrant.token,
            Accept: 'application/json',
          },
          redirect: 'error',
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        const root = asObj(parsed);
        const data = asObj(root?.data);
        const biz = asObj(data?.biz_data);
        if (res.status >= 200 && res.status < 300 && root?.code === 0 && biz) {
          const normalWallets = Array.isArray(biz.normal_wallets) ? biz.normal_wallets.map(asObj).filter(Boolean) : [];
          const bonusWallets = Array.isArray(biz.bonus_wallets) ? biz.bonus_wallets.map(asObj).filter(Boolean) : [];
          for (const w of normalWallets) {
            if (!w || typeof w.currency !== 'string' || typeof w.balance !== 'string') continue;
            const amount = formatWalletAmount(w.balance);
            if (amount === null) continue;
            windows.push({ window: `balance:${w.currency}:${amount}`, used: Number(amount) <= 0 ? 1 : 0, resets_at: null });
            sawOfficialBalance = true;
          }
          for (const w of bonusWallets) {
            if (!w || typeof w.currency !== 'string' || typeof w.balance !== 'string') continue;
            const amount = formatWalletAmount(w.balance);
            if (amount === null || Number(amount) <= 0) continue;
            windows.push({ window: `bonus_balance:${w.currency}:${amount}`, used: 0, resets_at: null });
          }
        } else if (!profile.officialDisabled) {
          errors.push(`DeepSeek 官网账号余额接口返回 HTTP ${res.status}`);
        }
      } catch (err) {
        if (!profile.officialDisabled) {
          errors.push(`DeepSeek 官网账号余额查询失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 2) DeepSeek Official API key (`DEEPSEEK_API_KEY` in env or `~/.dsh/.credentials.yaml`)
    const officialKey = resolveSecret('DEEPSEEK_API_KEY');
    if (officialKey) {
      attempted += 1;
      try {
        const res = await fetchJson(doFetch, DEEPSEEK_BALANCE_URL, officialKey, controller.signal);
        if (res.status >= 200 && res.status < 300) {
          const rec = asObj(res.body);
          const available = rec?.is_available;
          const infos = Array.isArray(rec?.balance_infos) ? rec.balance_infos : [];
          const first = infos.map(asObj).find((item) => item && typeof item.total_balance === 'string');
          const currency = typeof first?.currency === 'string' ? first.currency : 'CNY';
          const balance = typeof first?.total_balance === 'string' ? formatWalletAmount(first.total_balance) : null;
          if (typeof available === 'boolean' || balance !== null) {
            const prefix = sawOfficialBalance ? 'api_balance' : 'balance';
            const windowName = balance !== null ? `${prefix}:${currency}:${balance}` : `${prefix}:official`;
            const dup = sawOfficialBalance && balance !== null && windows.some((w) => w.window === `balance:${currency}:${balance}`);
            if (!dup) {
              windows.push({
                window: windowName,
                used: available === false ? 1 : 0,
                resets_at: null,
              });
            }
          }
        } else if (!profile.officialDisabled && !sawOfficialBalance) {
          errors.push(`DeepSeek API 余额接口返回 HTTP ${res.status}`);
        }
      } catch (err) {
        if (!profile.officialDisabled && !sawOfficialBalance) {
          errors.push(`DeepSeek API 余额查询失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 3) Custom OpenAI/New-API compatible gateways configured in dsh profile (cordis.patch.yml)
    for (const provider of orderedProviders) {
      const token = resolveSecret(provider.apiKeyEnv, provider.apiKey);
      const origin = gatewayOriginOf(provider.baseURL);
      if (!token || !origin) continue;
      attempted += 1;
      try {
        const sub = await fetchJson(doFetch, `${origin}/v1/dashboard/billing/subscription`, token, controller.signal);
        if (sub.status < 200 || sub.status >= 300) {
          errors.push(`网关 ${provider.displayName} 余额接口返回 HTTP ${sub.status}`);
          continue;
        }
        const subObj = asObj(sub.body);
        const hardLimitUsd = asNum(subObj?.hard_limit_usd) ?? asNum(subObj?.system_hard_limit_usd);
        if (hardLimitUsd === null) {
          errors.push(`网关 ${provider.displayName} 返回不含额度字段`);
          continue;
        }
        const nowMs = now();
        const startDate = formatIsoDate(nowMs - 30 * 24 * 60 * 60 * 1000);
        const endDate = formatIsoDate(nowMs + 24 * 60 * 60 * 1000);
        const usageRes = await fetchJson(
          doFetch,
          `${origin}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`,
          token,
          controller.signal,
        );
        const usageObj = asObj(usageRes.body);
        const usedUsd = (asNum(usageObj?.total_usage) ?? 0) / 100;
        const routeTag = sanitizeRouteTag(provider.displayName || provider.id);
        const isUnlimited = hardLimitUsd <= 0 || hardLimitUsd >= UNLIMITED_HARD_LIMIT_USD;
        const usedRatio = isUnlimited ? 0 : Math.max(0, Math.min(1, usedUsd / hardLimitUsd));
        const windowName = isUnlimited
          ? `gateway_unlimited:${routeTag}:$${usedUsd.toFixed(2)}`
          : `gateway_budget:${routeTag}:$${Math.max(0, hardLimitUsd - usedUsd).toFixed(2)}/$${hardLimitUsd.toFixed(0)}`;
        windows.push({ window: windowName, used: usedRatio, resets_at: null });
      } catch (err) {
        errors.push(`网关 ${provider.displayName} 查询失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (windows.length > 0) return { windows };
    if (attempted === 0) return { windows: [], absent: true };
    return { problem: errors[0] ?? '未读到 dsh 余额信息' };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onParentAbort);
  }
}
