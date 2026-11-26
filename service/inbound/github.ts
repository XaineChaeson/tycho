// GitHub's inbound requests (docs/design/triggers.md §2.2): its signature over the body alone,
// its delivery id as the event id, and the repository in the body deciding the project. GitHub
// signs neither the time nor the delivery id. Within the dedupe window the ledger also matches
// the signed body's digest, so changing the unsigned headers cannot replay an accepted body.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GITHUB_HEADERS } from '../../shared/triggers.ts';
import type { InboundEvent } from '../triggers.ts';
import { githubRepoName, normalizeRepo, payloadSummary, type InboundHeaders, type InboundProject, type InboundSecret, type Translation } from './types.ts';

const SIGNED = /^sha256=([0-9a-f]{64})$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function translateGithub(
  request: { header: InboundHeaders; body: Uint8Array },
  keys: readonly InboundSecret[],
  projects: readonly InboundProject[],
): Translation {
  const signature = request.header(GITHUB_HEADERS.signature);
  const delivery = request.header(GITHUB_HEADERS.delivery);
  const event = request.header(GITHUB_HEADERS.event);
  if (signature === null || signature === '' || delivery === null || delivery.trim() === '' || event === null || event.trim() === '') {
    return { status: 'refused', reason: 'unsigned' };
  }
  const matched = SIGNED.exec(signature);
  if (matched === null) return { status: 'refused', reason: 'signature' };
  const keyId = keys.find(({ secret }) => equal(createHmac('sha256', secret).update(request.body).digest('hex'), matched[1]!))?.id;
  if (keyId === undefined) return { status: 'refused', reason: 'signature' };
  // What arrives when the owner saves the repository's hook: acknowledged, nothing accepted,
  // nothing counted.
  if (event === 'ping') return { status: 'ping', keyId };
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(UTF8.decode(request.body)) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'refused', reason: 'no_project' };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { status: 'refused', reason: 'no_project' };
  }
  const repository = payload['repository'];
  const fullName = repository !== null && typeof repository === 'object' ? (repository as Record<string, unknown>)['full_name'] : undefined;
  if (typeof fullName !== 'string' || fullName.trim() === '') return { status: 'refused', reason: 'no_project' };
  const here = githubRepoName(fullName);
  if (here === null) return { status: 'refused', reason: 'no_project' };
  const matchedProjects = projects.filter((project) => project.repos.some((url) => normalizeRepo(url) === here));
  if (matchedProjects.length === 0) return { status: 'refused', reason: 'no_project' };
  const { title, url, summary } = payloadSummary(payload);
  const action = typeof payload['action'] === 'string' ? payload['action'] : '';
  const sender = payload['sender'];
  const login = sender !== null && typeof sender === 'object' ? (sender as Record<string, unknown>)['login'] : undefined;
  const events: InboundEvent[] = matchedProjects.map((project) => ({
    eventId: delivery.trim(),
    projectId: project.id,
    data: {
      event_id: delivery.trim(),
      project_id: project.id,
      event: action === '' ? event : `${event}.${action}`,
      repository: here,
      title,
      url,
      sender: typeof login === 'string' ? login : null,
      summary,
    },
  }));
  return { status: 'signed', keyId, eventIdSigned: false, events };
}
