import { randomBytes } from 'node:crypto';

// Tencent iLink protocol and request builders:
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_VERSION = '3.0.1/tycho';

export interface WeixinAuth {
  token: string;
  botId: string;
  userId: string;
  baseUrl: string;
}

export interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string };
  [key: string]: unknown;
}

export interface WeixinMessage {
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: WeixinMessageItem[];
}

export interface WeixinQrStatus {
  status: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export class WeixinApiError extends Error {
  override name = 'WeixinApiError';
  readonly code: number;
  readonly kind: 'business' | 'transport' | 'protocol';
  readonly uncertain: boolean;
  constructor(code: number, message: string, options: { kind?: 'business' | 'transport' | 'protocol'; uncertain?: boolean } = {}) {
    super(message);
    this.code = code;
    this.kind = options.kind ?? (code === 0 ? 'protocol' : 'business');
    this.uncertain = options.uncertain ?? false;
  }
}

type ObjectValue = Record<string, unknown>;
const fail = (message: string, code = 0, kind: WeixinApiError['kind'] = 'protocol'): never => { throw new WeixinApiError(code, message, { kind }); };
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);

// The API returns origins, not arbitrary endpoints. URL userinfo and redirects must
// never change where a bot token, a QR value or a PIN is sent, including under tests.
function officialOrigin(value: string, bareHost = false): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return fail('微信 iLink 地址必须是官方 HTTPS 地址');
  let url: URL;
  try { url = new URL(bareHost && !value.includes('://') ? 'https://' + value : value); }
  catch { return fail('微信 iLink 地址无效'); }
  const authority = (bareHost && !value.includes('://') ? value : value.split('://')[1] ?? '').split(/[/?#]/)[0]!;
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com')
    || !url.hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
    || url.username || url.password || authority.includes('@') || url.port || url.pathname !== '/' || url.search || url.hash) {
    return fail('微信 iLink 地址必须是官方 HTTPS 地址，不能带用户信息、非标准端口或其他路径');
  }
  return url.origin;
}

function authenticatedOrigin(auth: WeixinAuth): string {
  if (typeof auth?.token !== 'string' || !auth.token.trim()) return fail('微信 iLink 缺少登录凭据');
  return officialOrigin(auth.baseUrl);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { void promise.catch(() => {}); reject(new Error('aborted')); return; }
    const abort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    return fail('微信 iLink 响应超过大小上限');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0, ended = false;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) { ended = true; break; }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) return fail('微信 iLink 响应超过大小上限');
      chunks.push(value);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); }
    catch { return fail('微信 iLink 响应不是有效 UTF-8 JSON'); }
  } finally {
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseResponse(text: string): ObjectValue {
  let parsed: unknown;
  try {
    // Node 24's source-aware reviver preserves uint64 IDs before Number loses precision.
    parsed = JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
      if (key === 'message_id' && typeof value === 'number' && !Number.isSafeInteger(value)) {
        if (context?.source && /^\d+$/.test(context.source)) return context.source;
        return fail('微信 iLink 消息编号无法无损读取');
      }
      return value;
    });
  } catch (error) {
    if (error instanceof WeixinApiError) throw error;
    return fail('微信 iLink 响应不是有效 JSON');
  }
  if (!object(parsed)) return fail('微信 iLink 响应格式无效');
  for (const key of ['errcode', 'ret']) {
    const code = parsed[key];
    if (code !== undefined && (typeof code !== 'number' || !Number.isSafeInteger(code))) return fail('微信 iLink 返回码格式无效');
  }
  const codes = [parsed.errcode, parsed.ret] as (number | undefined)[];
  const error = codes.includes(-14) ? -14 : codes.find((code) => code !== undefined && code !== 0);
  if (error !== undefined) {
    // Remote errmsg and raw bodies can echo secrets; keep only the numeric code.
    return fail(
      error === -14
        ? '微信登录已失效，需要重新连接（-14）'
        : error === -2
          ? '微信会话回复窗口已过期，请先在微信给机器人发一条消息刷新上下文（-2）'
          : '微信 iLink 业务请求失败（' + error + '）',
      error,
      'business',
    );
  }
  return parsed;
}

function messagesOf(value: unknown): WeixinMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail('微信 iLink 消息列表格式无效');
  return value.map((message: unknown) => {
    if (!object(message)) return fail('微信 iLink 消息格式无效');
    const id = message.message_id;
    if (id !== undefined && !(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0))) return fail('微信 iLink 消息编号格式无效');
    for (const key of ['from_user_id', 'to_user_id', 'context_token']) if (message[key] !== undefined && typeof message[key] !== 'string') return fail('微信 iLink 消息字段格式无效');
    for (const key of ['message_type', 'message_state']) if (message[key] !== undefined && !Number.isSafeInteger(message[key])) return fail('微信 iLink 消息字段格式无效');
    if (message.item_list !== undefined) {
      if (!Array.isArray(message.item_list)) return fail('微信 iLink 消息条目格式无效');
      for (const item of message.item_list as unknown[]) {
        if (!object(item) || (item.type !== undefined && !Number.isSafeInteger(item.type))) return fail('微信 iLink 消息条目格式无效');
        if (item.text_item !== undefined && (!object(item.text_item) || (item.text_item.text !== undefined && typeof item.text_item.text !== 'string'))) return fail('微信 iLink 文字条目格式无效');
      }
    }
    return message as WeixinMessage;
  });
}

export function createWeixinApi(options: { fetch?: typeof fetch; version?: string } = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const version = options.version ?? DEFAULT_VERSION;
  const parts = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:[^\d].*)?$/.exec(version);
  if (!parts) return fail('微信 iLink 客户端版本必须以三段版本号开始');
  const [major, minor, patch] = parts.slice(1, 4).map(Number);
  const clientVersion = String(((major! & 0xff) << 16) | ((minor! & 0xff) << 8) | (patch! & 0xff));
  const commonHeaders = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': clientVersion };
  const baseInfo = { channel_version: version, bot_agent: 'Tycho/1.0.0' };

  async function request(base: string, endpoint: string, method: 'GET' | 'POST', body: unknown, token: string | undefined,
    timeoutMs: number, external?: AbortSignal): Promise<ObjectValue> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    let submitted = false;
    try {
      if (signal.aborted) return fail('微信 iLink 请求已取消');
      const headers: Record<string, string> = { ...commonHeaders };
      let encoded: string | undefined;
      if (method === 'POST') {
        Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
          'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64') });
        if (token !== undefined) {
          if (typeof token !== 'string' || !token.trim()) return fail('微信 iLink 缺少登录凭据');
          headers.Authorization = 'Bearer ' + token.trim();
        }
        encoded = JSON.stringify(body);
        if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) return fail('微信 iLink 请求超过大小上限');
      }
      submitted = true;
      const response = await abortable(fetcher(new URL(endpoint, base), { method, headers, redirect: 'manual', signal,
        ...(encoded === undefined ? {} : { body: encoded }) }), signal);
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {});
        return fail('微信 iLink 拒绝 HTTP 重定向', 0, 'transport');
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return fail('微信 iLink HTTP 请求失败（' + response.status + '）', response.status, 'transport');
      }
      return parseResponse(await responseText(response, signal));
    } catch (error) {
      if (error instanceof WeixinApiError && error.kind === 'business') throw error;
      const uncertain = submitted && endpoint === '/ilink/bot/sendmessage';
      if (external?.aborted) throw new WeixinApiError(0, '微信 iLink 请求已取消', { kind: 'transport', uncertain });
      if (controller.signal.aborted) throw new WeixinApiError(0, '微信 iLink 请求超时', { kind: 'transport', uncertain });
      if (error instanceof WeixinApiError) throw new WeixinApiError(error.code, error.message, { kind: error.kind, uncertain });
      // Fetch exceptions may include an authenticated URL or a response snippet.
      throw new WeixinApiError(0, '微信 iLink 网络请求失败', { kind: 'transport', uncertain });
    } finally { clearTimeout(timer); }
  }

  return {
    async qr(tokens: string[] = [], signal?: AbortSignal): Promise<{ qrcode: string; content: string }> {
      if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string')) return fail('微信本地凭据列表格式无效');
      const result = await request(DEFAULT_BASE, '/ilink/bot/get_bot_qrcode?bot_type=3', 'POST',
        { local_token_list: tokens.slice(0, 10) }, undefined, 15_000, signal);
      if (typeof result.qrcode !== 'string' || !result.qrcode || typeof result.qrcode_img_content !== 'string' || !result.qrcode_img_content) return fail('微信 iLink 未返回有效二维码');
      return { qrcode: result.qrcode, content: result.qrcode_img_content };
    },
    async qrStatus(qrcode: string, query: { host?: string; pin?: string; signal?: AbortSignal } = {}): Promise<WeixinQrStatus> {
      const base = officialOrigin(query.host ?? DEFAULT_BASE, true);
      const search = new URLSearchParams({ qrcode });
      if (query.pin) search.set('verify_code', query.pin);
      const result = await request(base, '/ilink/bot/get_qrcode_status?' + search.toString(), 'GET', undefined, undefined, 35_000, query.signal);
      if (typeof result.status !== 'string' || !result.status) return fail('微信 iLink 未返回有效扫码状态');
      const status: WeixinQrStatus = { status: result.status };
      for (const key of ['bot_token', 'ilink_bot_id', 'baseurl', 'ilink_user_id', 'redirect_host'] as const) {
        if (result[key] !== undefined) {
          if (typeof result[key] !== 'string') return fail('微信 iLink 扫码结果字段无效');
          status[key] = result[key];
        }
      }
      if (status.baseurl) officialOrigin(status.baseurl);
      if (status.redirect_host) officialOrigin(status.redirect_host, true);
      if (status.status === 'confirmed' && (!status.bot_token || !status.ilink_bot_id || !status.baseurl || !status.ilink_user_id)) return fail('微信 iLink 登录确认缺少凭据字段');
      return status;
    },
    async updates(auth: WeixinAuth, cursor: string, signal?: AbortSignal): Promise<{ msgs: WeixinMessage[]; cursor: string; timeoutMs?: number }> {
      const result = await request(authenticatedOrigin(auth), '/ilink/bot/getupdates', 'POST',
        { get_updates_buf: cursor, base_info: baseInfo }, auth.token, 40_000, signal);
      if (result.get_updates_buf !== undefined && typeof result.get_updates_buf !== 'string') return fail('微信 iLink 游标格式无效');
      const timeout = result.longpolling_timeout_ms;
      if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0)) return fail('微信 iLink 长轮询时间格式无效');
      return { msgs: messagesOf(result.msgs), cursor: result.get_updates_buf ? result.get_updates_buf as string : cursor,
        ...(timeout === undefined ? {} : { timeoutMs: timeout as number }) };
    },
    async send(auth: WeixinAuth, target: string, text: string, contextToken: string, clientId: string, signal?: AbortSignal): Promise<void> {
      if (!contextToken) return fail('微信会话上下文已缺失，无法发送消息');
      // Official sendMessage accepts omitted ret, including a message_id-only or
      // empty object response. This says server acceptance, never phone delivery.
      await request(authenticatedOrigin(auth), '/ilink/bot/sendmessage', 'POST', { msg: {
        from_user_id: '', to_user_id: target, client_id: clientId, message_type: 2, message_state: 2,
        context_token: contextToken, item_list: [{ type: 1, text_item: { text } }],
      }, base_info: baseInfo }, auth.token, 15_000, signal);
    },
  };
}
