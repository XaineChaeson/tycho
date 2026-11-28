// Structured domain knowledge: Git-backed LLM Wiki contracts (shared between service, MCP,
// Router tools, and Console UI).
import { localeMap } from './i18n.ts';

export const WIKI_PAGE_STATUSES = ['draft', 'active', 'disputed', 'deprecated'] as const;
export type WikiPageStatus = (typeof WIKI_PAGE_STATUSES)[number];
export const WIKI_PAGE_STATUS_LABELS: Readonly<Record<WikiPageStatus, string>> = localeMap({
  draft: 'sh.wiki.status.draft',
  active: 'sh.wiki.status.active',
  disputed: 'sh.wiki.status.disputed',
  deprecated: 'sh.wiki.status.deprecated',
});

export const WIKI_PROPOSAL_STATUSES = ['pending', 'applied', 'rejected', 'stale'] as const;
export type WikiProposalStatus = (typeof WIKI_PROPOSAL_STATUSES)[number];
export const WIKI_PROPOSAL_STATUS_LABELS: Readonly<Record<WikiProposalStatus, string>> = localeMap({
  pending: 'sh.wiki.proposalStatus.pending',
  applied: 'sh.wiki.proposalStatus.applied',
  rejected: 'sh.wiki.proposalStatus.rejected',
  stale: 'sh.wiki.proposalStatus.stale',
});

export interface WikiVault {
  id: string;
  created_at: string;
  updated_at: string;
  name: string;
  description: string;
  repo_path: string;
  branch: string;
  published_commit: string | null;
  last_synced_at: string | null;
  sync_error: string | null;
}

export interface WikiGrant {
  vault_id: string;
  project_id: string;
  created_at: string;
  pinned_commit: string | null;
  can_propose: boolean;
  granted_by: string;
}

export interface WikiPage {
  vault_id: string;
  page_id: string;
  path: string;
  title: string;
  summary: string;
  body: string;
  owner: string;
  scope: string;
  status: WikiPageStatus;
  search_phrases: string[];
  sources: string[];
  links: string[];
  locked_sections: string[];
  content_sha256: string;
  commit_sha: string;
  mutation_version: number;
  dirty: boolean;
  updated_at: string;
}

export interface WikiProposal {
  id: string;
  created_at: string;
  vault_id: string;
  project_id: string | null;
  page_id: string;
  path: string;
  proposed_by: string;
  source: string;
  base_commit: string;
  base_mutation_version: number;
  branch_name: string | null;
  title: string;
  summary: string;
  new_content: string;
  rationale: string;
  status: WikiProposalStatus;
  status_reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  applied_commit: string | null;
}

export interface WikiLintIssue {
  severity: 'error' | 'warn';
  code: 'broken_link' | 'missing_frontmatter' | 'disputed_page' | 'guardrail_reconcile';
  page_id: string;
  path: string;
  message: string;
  target?: string;
}

export interface WikiLintReport {
  vault_id: string;
  commit_sha: string | null;
  checked_pages: number;
  issues: WikiLintIssue[];
}

export const WIKI_REF_PREFIX = 'wiki:';

export function wikiCitation(vaultId: string, pageId: string, commit?: string | null): string {
  const short = commit ? `@${commit.slice(0, 8)}` : '';
  return `${WIKI_REF_PREFIX}${vaultId}/${pageId}${short}`;
}

export function parseWikiCitation(raw: string): { vaultId: string; pageId: string; commit?: string } | null {
  if (!raw.startsWith(WIKI_REF_PREFIX)) return null;
  const rest = raw.slice(WIKI_REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const vaultId = rest.slice(0, slash).trim();
  const tail = rest.slice(slash + 1).trim();
  if (!vaultId || !tail) return null;
  const at = tail.lastIndexOf('@');
  if (at > 0) {
    const pageId = tail.slice(0, at).trim();
    const commit = tail.slice(at + 1).trim();
    if (!pageId) return null;
    return { vaultId, pageId, ...(commit ? { commit } : {}) };
  }
  return { vaultId, pageId: tail };
}

export interface ParsedWikiMarkdown {
  page_id: string;
  title: string;
  summary: string;
  body: string;
  owner: string;
  scope: string;
  status: WikiPageStatus;
  search_phrases: string[];
  sources: string[];
  links: string[];
  locked_sections: string[];
  has_frontmatter: boolean;
}

const HUMAN_LOCKED_BLOCK_RE = /<!--\s*tycho:human-locked(?::([a-zA-Z0-9_.-]+))?\s*-->([\s\S]*?)<!--\s*\/tycho:human-locked\s*-->/g;
const MY_NOTES_HEADING_RE = /^##\s+My Notes\s*$/im;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Extracts protected human-authored blocks (`## My Notes` section and explicit
// `<!-- tycho:human-locked -->...<!-- /tycho:human-locked -->` regions) so automated
// proposals can never silently mutate or drop owner notes (ADR-006 / ADR-043 pattern).
export function extractHumanLockedSections(markdown: string): string[] {
  const text = normalizeLineEndings(markdown);
  const sections: string[] = [];

  for (const match of text.matchAll(HUMAN_LOCKED_BLOCK_RE)) {
    sections.push(match[0].trim());
  }

  const notesMatch = MY_NOTES_HEADING_RE.exec(text);
  if (notesMatch && notesMatch.index !== undefined) {
    const start = notesMatch.index;
    const afterHeading = text.slice(start + notesMatch[0].length);
    const nextH2 = /\n##\s+/.exec(afterHeading);
    const end = nextH2 ? start + notesMatch[0].length + nextH2.index : text.length;
    sections.push(text.slice(start, end).trim());
  }

  return sections;
}

// Returns the first missing or altered locked section if an automated update violated it.
export function findViolatedHumanLockedSection(originalMarkdown: string, proposedMarkdown: string): string | null {
  const original = extractHumanLockedSections(originalMarkdown);
  if (original.length === 0) return null;
  const proposed = new Set(extractHumanLockedSections(proposedMarkdown));
  for (const block of original) {
    if (!proposed.has(block)) return block;
  }
  return null;
}

function parseSimpleYamlList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return trimmed ? [trimmed.replace(/^['"]|['"]$/g, '')] : [];
}

function parseFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string; hasFrontmatter: boolean } {
  const normalized = normalizeLineEndings(text);
  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: normalized, hasFrontmatter: false };
  }
  const endIdx = normalized.indexOf('\n---', 4);
  if (endIdx < 0) {
    return { meta: {}, body: normalized, hasFrontmatter: false };
  }
  const header = normalized.slice(4, endIdx);
  const after = normalized.slice(endIdx + 4).replace(/^\n/, '');
  const meta: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;
  for (const line of header.split('\n')) {
    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && currentListKey) {
      const val = listItem[1]!.trim().replace(/^['"]|['"]$/g, '');
      const existing = meta[currentListKey];
      if (Array.isArray(existing)) existing.push(val);
      else meta[currentListKey] = [val];
      continue;
    }
    const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      currentListKey = null;
      continue;
    }
    const key = kv[1]!.trim().toLowerCase();
    const rawVal = kv[2]!.trim();
    if (rawVal === '') {
      meta[key] = [];
      currentListKey = key;
    } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      meta[key] = parseSimpleYamlList(rawVal);
      currentListKey = null;
    } else {
      meta[key] = rawVal.replace(/^['"]|['"]$/g, '');
      currentListKey = null;
    }
  }
  return { meta, body: after, hasFrontmatter: true };
}

function defaultPageIdFromPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\/+/, '');
}

function extractTitle(body: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1]!.trim() : fallback;
}

function extractSummary(body: string): string {
  const stripped = body
    .replace(/^#.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
  const firstPara = stripped.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return firstPara.slice(0, 240);
}

export function extractWikiLinks(body: string): string[] {
  const links = new Set<string>();
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return [...links].sort();
}

export function parseWikiMarkdown(path: string, rawContent: string): ParsedWikiMarkdown {
  const { meta, body, hasFrontmatter } = parseFrontmatter(rawContent);
  const strOf = (key: string): string => {
    const v = meta[key];
    return typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.join(', ').trim() : '';
  };
  const listOf = (key: string): string[] => {
    const v = meta[key];
    if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return parseSimpleYamlList(v);
    return [];
  };
  const fallbackId = defaultPageIdFromPath(path);
  const pageId = strOf('id') || fallbackId;
  const title = strOf('title') || extractTitle(body, pageId);
  const summary = strOf('summary') || extractSummary(body);
  const rawStatus = strOf('status').toLowerCase();
  const status: WikiPageStatus = (WIKI_PAGE_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as WikiPageStatus)
    : 'active';

  return {
    page_id: pageId,
    title,
    summary,
    body,
    owner: strOf('owner'),
    scope: strOf('scope'),
    status,
    search_phrases: listOf('search_phrases').slice(0, 3),
    sources: listOf('sources'),
    links: extractWikiLinks(body),
    locked_sections: extractHumanLockedSections(rawContent),
    has_frontmatter: hasFrontmatter,
  };
}
