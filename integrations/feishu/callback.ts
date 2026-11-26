import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const CALLBACK_PATH = '/feishu/events';
export const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,120}$/;
const MENTION_KEY = /^@_user_\d+$/;
const CALLBACK_SKEW_MS = 5 * 60 * 1000;
const MAX_TEXT = 4000;

export interface CallbackPolicy {
  appId: string;
  tenantKey: string;
  encryptKey: string;
  verificationToken: string;
  botOpenId: string;
  projectsByChat: ReadonlyMap<string, string>;
  quickAnswers: ReadonlyMap<string, string>;
}

export interface GroupMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  threadId: string | null;
  projectId: string;
  text: string;
  quickReply: string | null;
}

export type Callback = { type: 'challenge'; challenge: string }
  | { type: 'message'; message: GroupMessage } | { type: 'ignore' };

export class CallbackError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('飞书事件无法接收');
    this.status = status;
  }
}

const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const valueOf = (headers: IncomingHttpHeaders, key: string): string | undefined => {
  const value = headers[key];
  return typeof value === 'string' ? value : undefined;
};

function unpack(body: Buffer, encryptKey: string): { data: Record<string, unknown>; encrypted: boolean } {
  try {
    const outer = objectOf(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
    if (typeof outer.encrypt !== 'string') return { data: outer, encrypted: false };
    const bytes = Buffer.from(outer.encrypt, 'base64');
    if (bytes.length < 32 || bytes.length % 16 !== 0) throw new Error('长度无效');
    const key = createHash('sha256').update(encryptKey).digest();
    const decipher = createDecipheriv('aes-256-cbc', key, bytes.subarray(0, 16));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]));
    return { data: objectOf(JSON.parse(text)), encrypted: true };
  } catch {
    throw new CallbackError(400);
  }
}

function validSignature(body: Buffer, headers: IncomingHttpHeaders, encryptKey: string, now: number): boolean {
  const timestamp = valueOf(headers, 'x-lark-request-timestamp');
  const nonce = valueOf(headers, 'x-lark-request-nonce');
  const signature = valueOf(headers, 'x-lark-signature');
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !nonce || !/^[\x21-\x7e]{1,128}$/.test(nonce)
    || !signature || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(now - Number(timestamp) * 1000) > CALLBACK_SKEW_MS) return false;
  const expected = createHash('sha256').update(timestamp + nonce + encryptKey, 'utf8').update(body).digest('hex');
  return equal(signature, expected);
}

export function readCallback(body: Buffer, headers: IncomingHttpHeaders, policy: CallbackPolicy, now = Date.now()): Callback {
  const signed = validSignature(body, headers, policy.encryptKey, now);
  const hasSignature = Object.keys(headers).some((name) => name === 'x-lark-signature' || name === 'x-lark-request-timestamp' || name === 'x-lark-request-nonce');
  if (hasSignature && !signed) throw new CallbackError(401);
  const { data, encrypted } = unpack(body, policy.encryptKey);
  // Configuration challenge is the only message Feishu can deliver without event
  // signature headers. Verify the configured token and return just its challenge.
  if (data.type === 'url_verification' && typeof data.challenge === 'string' && data.challenge.length <= 256
    && typeof data.token === 'string' && equal(data.token, policy.verificationToken)) {
    return { type: 'challenge', challenge: data.challenge };
  }
  if (!signed || !encrypted) throw new CallbackError(401);
  const header = objectOf(data.header);
  if (header.app_id !== policy.appId || header.tenant_key !== policy.tenantKey
    || typeof header.token !== 'string' || !equal(header.token, policy.verificationToken)) throw new CallbackError(401);
  if (data.schema !== '2.0' || header.event_type !== 'im.message.receive_v1') return { type: 'ignore' };
  const event = objectOf(data.event);
  const sender = objectOf(event.sender);
  const message = objectOf(event.message);
  const chatId = message.chat_id;
  const messageId = message.message_id;
  if (sender.sender_type !== 'user' || message.chat_type !== 'group' || message.message_type !== 'text'
    || typeof chatId !== 'string' || typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return { type: 'ignore' };
  const projectId = policy.projectsByChat.get(chatId);
  if (!projectId || !Array.isArray(message.mentions)) return { type: 'ignore' };
  const mentions = message.mentions.map(objectOf);
  const botKeys = new Set(mentions.filter((mention) => objectOf(mention.id).open_id === policy.botOpenId
    && typeof mention.key === 'string' && MENTION_KEY.test(mention.key)).map((mention) => mention.key));
  if (!botKeys.size || typeof message.content !== 'string') return { type: 'ignore' };
  let content: unknown;
  try { content = objectOf(JSON.parse(message.content)).text; } catch { return { type: 'ignore' }; }
  if (typeof content !== 'string' || ![...botKeys].some((key) => content.match(new RegExp(`${key}(?!\\d)`)))) return { type: 'ignore' };
  const text = content.replace(/@_user_\d+/g, (key) => botKeys.has(key) ? '' : key).trim();
  if (!text || text.length > MAX_TEXT) return { type: 'ignore' };
  return {
    type: 'message',
    message: {
      // im.message.receive can be delivered more than once. The target message ID
      // is also stable across deliveries with a different callback event ID.
      eventId: 'feishu:' + createHash('sha256').update(JSON.stringify([policy.appId, policy.tenantKey, messageId])).digest('hex'),
      messageId, chatId, threadId: typeof message.thread_id === 'string' && /^omt_[A-Za-z0-9_-]{1,120}$/.test(message.thread_id) ? message.thread_id : null,
      projectId, text, quickReply: policy.quickAnswers.get(text) ?? null,
    },
  };
}
