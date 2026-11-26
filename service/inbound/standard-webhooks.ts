// Standard Webhooks v1 translator (https://www.standardwebhooks.com/).
// Verifies webhook-id, webhook-timestamp, and space-delimited "v1,<base64>" HMAC-SHA256
// signatures over "<webhook-id>.<webhook-timestamp>.<raw_body>" using raw secret bytes
// decoded from "whsec_<base64>".
import { createHmac, timingSafeEqual } from 'node:crypto';
import { STANDARD_WEBHOOK_HEADERS } from '../../shared/triggers.ts';
import { bodyData, type InboundHeaders, type InboundProject, type InboundSecret, type Translation } from './types.ts';

const WEBHOOK_ID = /^[\x21-\x2d\x2f-\x7e]{1,200}$/;
const TIMESTAMP = /^\d{1,12}$/;
const V1_TOKEN = /^v1,([A-Za-z0-9+/=]{32,128})$/;
const BASE64_PADDED_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/;
const BASE64_UNPADDED_RE = /^[A-Za-z0-9+/]+$/;
const MIN_WHSEC_BYTES = 16;
const SECOND_MS = 1000;
const WHSEC_PREFIX = 'whsec_';

export function decodeStandardWebhookKey(secret: string): Buffer | null {
  if (secret.startsWith(WHSEC_PREFIX)) {
    const raw = secret.slice(WHSEC_PREFIX.length);
    if (raw.length === 0) return null;
    if (raw.includes('=')) {
      if (raw.length % 4 !== 0 || !BASE64_PADDED_RE.test(raw)) return null;
    } else if (raw.length % 4 === 1 || !BASE64_UNPADDED_RE.test(raw)) {
      return null;
    }
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length < MIN_WHSEC_BYTES) return null;
    return decoded;
  }
  const rawBuf = Buffer.from(secret, 'utf8');
  return rawBuf.length > 0 ? rawBuf : null;
}

function signStandardWebhook(key: Buffer, webhookId: string, timestamp: string, body: Uint8Array): string {
  const digest = createHmac('sha256', key)
    .update(`${webhookId}.${timestamp}.`, 'utf8')
    .update(body)
    .digest('base64');
  return `v1,${digest}`;
}

export function standardWebhookSignature(secret: string, webhookId: string, timestamp: string, body: Uint8Array): string {
  const key = decodeStandardWebhookKey(secret);
  if (key === null) {
    throw new Error('Standard Webhooks 密钥格式无效');
  }
  return signStandardWebhook(key, webhookId, timestamp, body);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function translateStandardWebhooks(
  request: { header: InboundHeaders; body: Uint8Array; now: Date; skewMs: number },
  keys: readonly InboundSecret[],
  projects: readonly InboundProject[],
): Translation {
  const webhookId = request.header(STANDARD_WEBHOOK_HEADERS.id);
  const timestamp = request.header(STANDARD_WEBHOOK_HEADERS.time);
  const signatureHeader = request.header(STANDARD_WEBHOOK_HEADERS.signature);
  if (
    webhookId === null || !WEBHOOK_ID.test(webhookId)
    || timestamp === null || !TIMESTAMP.test(timestamp)
    || signatureHeader === null || signatureHeader.trim() === ''
  ) {
    return { status: 'refused', reason: 'unsigned' };
  }

  const tokens = signatureHeader
    .trim()
    .split(/\s+/)
    .filter((token) => V1_TOKEN.test(token));
  if (tokens.length === 0) {
    return { status: 'refused', reason: 'signature' };
  }

  const keyId = keys.find(({ secret }) => {
    const key = decodeStandardWebhookKey(secret);
    if (key === null) return false;
    const expected = signStandardWebhook(key, webhookId, timestamp, request.body);
    return tokens.some((token) => safeEqual(expected, token));
  })?.id;
  if (keyId === undefined) {
    return { status: 'refused', reason: 'signature' };
  }

  if (Math.abs(request.now.getTime() - Number(timestamp) * SECOND_MS) > request.skewMs) {
    return { status: 'refused', reason: 'stale' };
  }

  // Standard Webhooks v1 does not sign X-Tycho-Project; never trust an unsigned project header.
  const projectId = projects.length === 1 ? projects[0]!.id : null;
  if (projectId === null) {
    return { status: 'refused', reason: 'no_project' };
  }

  const events = [{
    eventId: webhookId,
    projectId,
    data: {
      event_id: webhookId,
      webhook_timestamp: timestamp,
      project_id: projectId,
      ...bodyData(request.body),
    },
  }];
  return { status: 'signed', keyId, eventIdSigned: true, events };
}
