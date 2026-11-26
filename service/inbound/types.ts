// The types every translator reads and writes (docs/design/triggers.md §2.2), and the one shape
// of a translation the ledger judges.
import type { InboundEvent } from '../triggers.ts';

export type InboundHeaders = (name: string) => string | null;

export interface InboundSecret {
  id: string;
  secret: string;
}

// A project the source lets through, with the repositories a `github` event is routed by: the
// repo sources the project names, in their order (shared/sources.ts repoUrlsOf). Empty for a
// project that names only folders.
export interface InboundProject {
  id: string;
  repos: readonly string[];
}

export type Translation =
  | { status: 'signed'; keyId: string; eventIdSigned: boolean; events: InboundEvent[] }
  | { status: 'ping'; keyId: string }
  | { status: 'refused'; reason: 'unsigned' | 'signature' | 'stale' | 'no_project' };

export type Translator = (
  request: { header: InboundHeaders; body: Uint8Array; now: Date; skewMs: number },
  keys: readonly InboundSecret[],
  projects: readonly InboundProject[],
) => Translation;

// A request's body as material for the Router (§3): JSON as it is, other text as text, and bytes
// that are not text as base64. Nothing in it is fetched or followed.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
export function bodyData(body: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = UTF8.decode(body);
  } catch {
    return { body_base64: Buffer.from(body).toString('base64') };
  }
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { body: text };
  }
}

// GitHub's full_name is a repository name, never a remote URL or a path. Invalid inputs must
// not acquire a meaning by having a sequence of apparent remote prefixes stripped from them.
export function githubRepoName(value: string): string | null {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9_.-]+$/i.test(value)
    && !['.', '..'].includes(value.split('/')[1]!) ? value.toLowerCase() : null;
}

// A project's remote: one optional GitHub prefix, one owner/name, and an optional clone suffix.
// A foreign host, query, fragment or nested prefix is not a GitHub repository.
export function normalizeRepo(value: string): string | null {
  const remote = /^(?:(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|git:\/\/(?:www\.)?github\.com\/|github\.com\/))?([^/]+\/[^/]+)\/?$/i.exec(value.trim());
  return remote === null ? null : githubRepoName(remote[1]!.replace(/\.git$/i, ''));
}

// A GitHub payload as material for the Router (§2.2): what the event is, the repository, its own
// identifiers, a title, a link, the sender and a bounded summary. Never the whole payload: it can
// be megabytes, and the Router can look at it itself.
const SUMMARY_CHARS = 2000;

function clip(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length <= SUMMARY_CHARS ? value : `${value.slice(0, SUMMARY_CHARS)}…（tycho 截断）`;
}

export function payloadSummary(payload: Record<string, unknown>): { title: string; url: string | null; summary: string } {
  const pick = (each: unknown): Record<string, unknown> => (each !== null && typeof each === 'object' ? each as Record<string, unknown> : {});
  const candidates = [
    pick(payload.pull_request),
    pick(payload.issue),
    pick(payload.comment),
    pick(payload.release),
    pick(payload.head_commit),
  ].filter((each) => Object.keys(each).length > 0);
  const first = candidates[0] ?? {};
  const title = [first['title'], first['name'], first['message']].find((value) => typeof value === 'string' && value.trim() !== '') as string | undefined
    ?? payload['action'] as string | undefined ?? '';
  const url = [first['html_url'], first['url'], payload['compare']].find((value) => typeof value === 'string') as string | undefined ?? null;
  const body = [first['body'], first['message']].find((value) => typeof value === 'string') as string | undefined ?? '';
  return { title: clip(title), url, summary: clip(body) };
}
