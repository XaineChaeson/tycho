// What a project lets its Router do without asking (docs/design/project-sessions.md §6), declared
// once for the service and the console. Each is a step the owner can always take from the console;
// a grant only says whether the Router may take it too. The gates in front of each step (review,
// acceptance, the release gate) stay where they are and apply to the Router as to anyone: a grant
// never opens a gate, it only removes the question. What is done under a grant reaches the owner as
// the service's own result push, not in the Router's words.

import { t } from './i18n.ts';

export const GRANT_IDS = ['accept', 'integrate', 'release'] as const;
export type GrantId = (typeof GRANT_IDS)[number];

export interface GrantSpec {
  label: string;
  // What it lets the Router do, and what has to hold first, in the owner's words.
  hint: string;
  // What a project starts with. Comparable agents land work on their own branch and leave the main
  // line and deployment to a person; accepting is what the Router could always do.
  on: boolean;
}

export const GRANTS: Record<GrantId, GrantSpec> = {
  accept: {
    get label(): string { return t('sh.grants.accept.label'); },
    get hint(): string { return t('sh.grants.accept.hint'); },
    on: true,
  },
  integrate: {
    get label(): string { return t('sh.grants.integrate.label'); },
    get hint(): string { return t('sh.grants.integrate.hint'); },
    on: false,
  },
  release: {
    get label(): string { return t('sh.grants.release.label'); },
    get hint(): string { return t('sh.grants.release.hint'); },
    on: false,
  },
};

export const isGrantId = (id: unknown): id is GrantId => typeof id === 'string' && (GRANT_IDS as readonly string[]).includes(id);

export const DEFAULT_GRANTS: GrantId[] = GRANT_IDS.filter((id) => GRANTS[id].on);

// A stored list as the vocabulary has it now: unknown ids (a grant since removed) mean nothing.
export const grantsOf = (stored: string): GrantId[] => {
  const parsed = JSON.parse(stored) as unknown;
  return Array.isArray(parsed) ? GRANT_IDS.filter((id) => parsed.includes(id)) : [];
};

// The Router's refusal when a step is not granted: the owner takes it from the console.
export const notGrantedText = (id: GrantId): string =>
  t('sh.grants.notGranted', { label: GRANTS[id].label });
