import { createHmac } from 'node:crypto';
import { inboundPath, inboundResultPath, TYCHO_V1_HEADERS, type InboundReceiptResult } from '../../shared/triggers.ts';
import { tychoSignature } from '../../service/inbound/tycho-v1.ts';
import { MESSAGE_ID } from './callback.ts';

export const FEISHU_ORIGIN = 'https://open.feishu.cn';
const REQUEST_MS = 8000;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface Clients {
  submit(projectId: string, eventId: string, body: string): Promise<string>;
  result(projectId: string, receipt: string): Promise<InboundReceiptResult>;
  reply(messageId: string, text: string, uuid: string): Promise<string>;
}

export class RemoteError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

const json = { 'Content-Type': 'application/json; charset=utf-8' };
const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export function createClients(config: {
  appId: string; appSecret: string; tychoOrigin: string; tychoSource: string; tychoSecret: string;
}, options: { fetch?: typeof fetch; now?: () => number; feishuOrigin?: string } = {}): Clients {
  const request = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  const feishu = options.feishuOrigin ?? FEISHU_ORIGIN;
  let token: { value: string; expires: number } | undefined;

  async function api(url: string, requestOptions: RequestInit): Promise<{
    status: number;
    result: Record<string, unknown>;
  }> {
    const host = url.startsWith(feishu + '/') ? 'feishu' : 'tycho';
    try {
      const response = await request(url, { ...requestOptions, redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS) });
      const value: unknown = await response.json().catch(() => null);
      return { status: response.status, result: value !== null && typeof value === 'object' ? value as Record<string, unknown> : {} };
    } catch {
      throw new RemoteError(`${host}-unreachable`, true);
    }
  }

  async function tenantToken(): Promise<string> {
    if (token && token.expires > clock()) return token.value;
    const { status, result } = await api(feishu + '/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: json,
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    if (status !== 200 || result.code !== 0 || typeof result.tenant_access_token !== 'string' || typeof result.expire !== 'number'
      || !Number.isFinite(result.expire) || result.expire <= 0) {
      throw new RemoteError('feishu-auth-' + status, retryable(status));
    }
    token = { value: result.tenant_access_token, expires: clock() + Math.max(0, result.expire - 60) * 1000 };
    return token.value;
  }

  return {
    async submit(projectId, eventId, body) {
      const at = String(Math.floor(clock() / 1000));
      const { status, result } = await api(config.tychoOrigin + inboundPath(config.tychoSource), {
        method: 'POST', body, headers: {
          ...json, [TYCHO_V1_HEADERS.event]: eventId, [TYCHO_V1_HEADERS.project]: projectId, [TYCHO_V1_HEADERS.time]: at,
          [TYCHO_V1_HEADERS.signature]: tychoSignature(config.tychoSecret, at, eventId, projectId, Buffer.from(body)),
        },
      });
      const receipt = Array.isArray(result.receipts) && result.receipts.length === 1 ? result.receipts[0] : undefined;
      if (status !== 200 || result.accepted !== true || receipt?.status !== 'accepted' || typeof receipt.fire_id !== 'string' || !ULID.test(receipt.fire_id)) {
        const dormant = result.reason === 'project_paused';
        throw new RemoteError('tycho-submit-' + status, retryable(status) || dormant || (status === 200 && result.accepted === true));
      }
      return receipt.fire_id;
    },

    async result(projectId, receipt) {
      const path = inboundResultPath(config.tychoSource, receipt);
      const at = String(Math.floor(clock() / 1000));
      const signature = createHmac('sha256', config.tychoSecret).update(['tycho-result-v1', 'GET', path, at, ''].join('\n')).digest('hex');
      const { status, result } = await api(config.tychoOrigin + path, {
        headers: { [TYCHO_V1_HEADERS.time]: at, [TYCHO_V1_HEADERS.signature]: signature },
      });
      if (status !== 200) throw new RemoteError('tycho-result-' + status, retryable(status));
      if (result.fire_id !== receipt || result.project_id !== projectId || typeof result.outcome !== 'string'
        || !(typeof result.state === 'string' || result.state === null)
        || (result.reply !== undefined && (typeof result.reply !== 'string' || result.reply.trim().length === 0 || result.reply.length > 12000))) {
        throw new RemoteError('tycho-result-invalid', false);
      }
      return result as unknown as InboundReceiptResult;
    },

    async reply(messageId, text, uuid) {
      // Plain text nodes keep model output from being parsed as mentions or Markdown.
      const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text }]] } });
      const { status, result } = await api(feishu + '/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reply', {
        method: 'POST', headers: { ...json, Authorization: 'Bearer ' + await tenantToken() },
        body: JSON.stringify({ content, msg_type: 'post', reply_in_thread: true, uuid }),
      });
      const data = result.data as { message_id?: unknown } | undefined;
      if (status === 200 && result.code === 0 && typeof data?.message_id === 'string' && MESSAGE_ID.test(data.message_id)) return data.message_id;
      const code = typeof result.code === 'number' && Number.isSafeInteger(result.code) ? result.code : null;
      const invalidToken = status === 401 || code === 99991663 || code === 99991664 || code === 99991668;
      if (invalidToken) token = undefined;
      throw new RemoteError('feishu-reply-' + (code ?? status), retryable(status) || invalidToken || code === 230020 || (status === 200 && code === 0));
    },
  };
}
