// An inbound source's form and the lines its page shows (docs/design/triggers.md §2.2, §7). All
// pure: the page sends the whole definition and the service judges it.
import { t } from '@shared/i18n.ts';
import { GITHUB_HEADERS, STANDARD_WEBHOOK_HEADERS, TYCHO_V1_HEADERS, TYCHO_V1_VERSION, type InboundKind } from '@shared/triggers.ts';
import type { InboundSource } from './types.ts';

export interface InboundDraft {
  name: string;
  kind: InboundKind;
  projectIds: string[];
  note: string;
  pushFinal: boolean;
  resultReply: boolean;
  broadcastGroups: boolean;
  broadcastGroupIds: string[];
}

export const emptyInboundDraft = (kind: InboundKind): InboundDraft => ({
  name: '',
  kind,
  projectIds: [],
  note: '',
  pushFinal: false,
  resultReply: false,
  broadcastGroups: false,
  broadcastGroupIds: [],
});

export const inboundDraftOf = (source: InboundSource): InboundDraft => ({
  name: source.name,
  kind: source.kind,
  projectIds: [...source.project_ids],
  note: source.note,
  pushFinal: source.push_final,
  resultReply: source.result_reply ?? false,
  broadcastGroups: source.broadcast_groups ?? false,
  broadcastGroupIds: [...(source.broadcast_group_ids ?? [])],
});

export const inboundBody = (draft: InboundDraft): {
  name: string;
  kind: InboundKind;
  project_ids: string[];
  note: string;
  push_final: boolean;
  result_reply: boolean;
  broadcast_groups: boolean;
  broadcast_group_ids: string[];
} => ({
  name: draft.name.trim(),
  kind: draft.kind,
  project_ids: draft.kind === 'standard-webhooks' ? draft.projectIds.slice(0, 1) : draft.projectIds,
  note: draft.note.trim(),
  push_final: draft.pushFinal,
  result_reply: draft.kind === 'tycho-v1' && draft.resultReply,
  broadcast_groups: draft.broadcastGroups,
  broadcast_group_ids: draft.broadcastGroups ? draft.broadcastGroupIds : [],
});

// How a caller names the project it delivers to: tycho-v1 puts its number in the signed
// project header, while a GitHub event is routed by the repository the project names. The
// owner has to be able to read this here — a number that is nowhere on the page cannot be
// signed into a request.
export const projectLine = (project: { id: string; name: string; repos: string[] }, kind: InboundKind): string => {
  if (kind === 'tycho-v1' || kind === 'standard-webhooks') return t('set.inbound.projectWithId', { name: project.name, id: project.id });
  return project.repos.length === 0
    ? t('set.inbound.projectNoRepos', { name: project.name })
    : t('set.inbound.projectWithRepos', { name: project.name, repos: project.repos.join(t('set.listSep')) });
};

// Where a caller sends its requests: the public address when there is one, else only the path,
// which is reached on the service's own port inside the network.
export const inboundAddress = (path: string, publicUrl: string | null): string => (publicUrl ? `${publicUrl.replace(/\/$/, '')}${path}` : path);

// What a key is now: the one in force, or one replaced that still verifies until a moment.
export const keyLine = (key: { id: string; retires_at: string | null }): string =>
  key.retires_at === null
    ? t('set.inbound.keyActive', { id: key.id })
    : t('set.inbound.keyRetiring', { id: key.id });

// How a caller signs a tycho-v1 request (§2.2), said next to the key it was just given.
export const tychoSigningText = (): string =>
  t('set.inbound.signingTycho', {
    eventHeader: TYCHO_V1_HEADERS.event,
    timeHeader: TYCHO_V1_HEADERS.time,
    sigHeader: TYCHO_V1_HEADERS.signature,
    projectHeader: TYCHO_V1_HEADERS.project,
    version: TYCHO_V1_VERSION,
  });

// What a GitHub caller fills in, said next to the key: the address goes in the repository's hook,
// and the key in its secret.
export const githubSigningText = (): string =>
  t('set.inbound.signingGithub', {
    sigHeader: GITHUB_HEADERS.signature,
    deliveryHeader: GITHUB_HEADERS.delivery,
    eventHeader: GITHUB_HEADERS.event,
  });

export const standardWebhooksSigningText = (): string =>
  t('set.inbound.signingStandardWebhooks', {
    idHeader: STANDARD_WEBHOOK_HEADERS.id,
    timeHeader: STANDARD_WEBHOOK_HEADERS.time,
    sigHeader: STANDARD_WEBHOOK_HEADERS.signature,
  });
