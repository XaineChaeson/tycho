// What a translator reads out of an inbound request (docs/design/triggers.md §2.2): a pure
// function of the request's headers and raw body, the keys in force, and the projects the source
// lets through. It checks the signature and maps fields; it sends nothing and touches no ledger.
// A new kind is one file like this and one line in service/inbound.ts.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TYCHO_V1_HEADERS, TYCHO_V1_VERSION } from '../../shared/triggers.ts';
import { bodyData, type InboundHeaders, type InboundProject, type InboundSecret, type Translation } from './types.ts';

const EVENT_ID = /^[\x21-\x7e]{1,200}$/;
const SIGNED_AT = /^\d{1,12}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const SECOND_MS = 1000;

// HMAC-SHA256 with the secret over "v1\n<signing time>\n<event id>\n<project id>\n" and the raw
// body, as lower-case hex. An absent project is an empty line, and is signed as one.
export function tychoSignature(secret: string, signedAt: string, eventId: string, projectId: string, body: Uint8Array): string {
  return createHmac('sha256', secret).update(`${TYCHO_V1_VERSION}\n${signedAt}\n${eventId}\n${projectId}\n`).update(body).digest('hex');
}

const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function receiptKey(keys: readonly InboundSecret[], path: string, signedAt: string | null, signature: string | null, now: Date, skewMs: number): string | undefined {
  if (signedAt === null || !SIGNED_AT.test(signedAt) || signature === null || !SIGNATURE.test(signature)) return undefined;
  if (Math.abs(now.getTime() - Number(signedAt) * SECOND_MS) > skewMs) return undefined;
  const envelope = ['tycho-result-v1', 'GET', path, signedAt, ''].join('\n');
  return keys.find(({ secret }) => equal(createHmac('sha256', secret).update(envelope).digest('hex'), signature))?.id;
}

export function translateTychoV1(
  request: { header: InboundHeaders; body: Uint8Array; now: Date; skewMs: number },
  keys: readonly InboundSecret[],
  projects: readonly InboundProject[],
): Translation {
  const eventId = request.header(TYCHO_V1_HEADERS.event);
  const signedAt = request.header(TYCHO_V1_HEADERS.time);
  const signature = request.header(TYCHO_V1_HEADERS.signature);
  const named = request.header(TYCHO_V1_HEADERS.project) ?? '';
  if (eventId === null || !EVENT_ID.test(eventId) || signedAt === null || !SIGNED_AT.test(signedAt) || signature === null || signature === '') {
    return { status: 'refused', reason: 'unsigned' };
  }
  if (!SIGNATURE.test(signature)) return { status: 'refused', reason: 'signature' };
  const keyId = keys.find(({ secret }) => equal(tychoSignature(secret, signedAt, eventId, named, request.body), signature))?.id;
  if (keyId === undefined) return { status: 'refused', reason: 'signature' };
  if (Math.abs(request.now.getTime() - Number(signedAt) * SECOND_MS) > request.skewMs) return { status: 'refused', reason: 'stale' };
  // The project header is signed with the rest, so a header changed on the way fails the
  // signature above. Which project it points at is the source's list to judge.
  const projectId = named !== '' ? named : projects.length === 1 ? projects[0]!.id : null;
  if (projectId === null || !projects.some((project) => project.id === projectId)) return { status: 'refused', reason: 'no_project' };
  const events = [{
    eventId,
    projectId,
    data: { event_id: eventId, project_id: projectId, ...bodyData(request.body) },
  }];
  return { status: 'signed', keyId, eventIdSigned: true, events };
}
