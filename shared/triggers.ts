// The words of triggers (docs/design/triggers.md), one copy for the service and the console.
import { localeMap } from './i18n.ts';

// The channel a trigger's message comes in by: not the owner's words, and its reply stays in
// the console unless the trigger pushes it (§8).
export const TRIGGER_CHANNEL = 'trigger';
// Channels whose messages are the service's, not the owner's: an internal event, a trigger.
export const fromOwner = (channel: string): boolean => channel !== 'internal' && channel !== TRIGGER_CHANNEL;

// Where a project's trigger gets what it hands the Router: its own time rule, or an internal
// event (§2). An inbound source (§2.2) is tycho-wide, not a trigger source.
export const TRIGGER_SOURCES = ['schedule', 'event'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];
export const SOURCE_LABELS: Readonly<Record<string, string>> = localeMap({
  schedule: 'sh.triggers.source.schedule',
  event: 'sh.triggers.source.event',
});

export const SCHEDULE_KINDS = ['once', 'every', 'cron'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export const SCHEDULE_LABELS: Readonly<Record<ScheduleKind, string>> = localeMap({
  once: 'sh.triggers.schedule.once',
  every: 'sh.triggers.schedule.every',
  cron: 'sh.triggers.schedule.cron',
});

// What happens to moments the service was not there for (§5).
export const MISSED_POLICIES = ['latest', 'skip'] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];
export const MISSED_LABELS: Readonly<Record<MissedPolicy, string>> = localeMap({
  latest: 'sh.triggers.missed.latest',
  skip: 'sh.triggers.missed.skip',
});

// What became of an accepted occurrence (§1): its own message, merged into a waiting one, a
// waiting one replaced by a newer revision, recorded only (missed, or past the deadline).
export type FireOutcome = 'delivered' | 'merged' | 'replaced' | 'missed' | 'expired';
export const OUTCOME_LABELS: Readonly<Record<FireOutcome, string>> = localeMap({
  delivered: 'sh.triggers.outcome.delivered',
  merged: 'sh.triggers.outcome.merged',
  replaced: 'sh.triggers.outcome.replaced',
  missed: 'sh.triggers.outcome.missed',
  expired: 'sh.triggers.outcome.expired',
});

// Why an occurrence was not accepted. None of them writes a record; each is counted (§1, §4).
export type RefusalReason =
  | 'disabled' | 'source' | 'conflict' | 'too_large' | 'rate_trigger' | 'rate_global' | 'queue_full'
  // The owner paused or archived the trigger's project (project-sessions §5): none of its
  // triggers runs.
  | 'project_paused' | 'project_archived'
  // An inbound source's own (§2.2): a header missing, a signature no live key made, a signing
  // time too far off, or no project of the source's list the event belongs to.
  | 'unsigned' | 'signature' | 'stale' | 'no_project';
export const REFUSAL_LABELS: Readonly<Record<RefusalReason, string>> = localeMap({
  disabled: 'sh.triggers.refusal.disabled',
  source: 'sh.triggers.refusal.source',
  conflict: 'sh.triggers.refusal.conflict',
  too_large: 'sh.triggers.refusal.too_large',
  rate_trigger: 'sh.triggers.refusal.rate_trigger',
  rate_global: 'sh.triggers.refusal.rate_global',
  queue_full: 'sh.triggers.refusal.queue_full',
  project_paused: 'sh.triggers.refusal.project_paused',
  project_archived: 'sh.triggers.refusal.project_archived',
  unsigned: 'sh.triggers.refusal.unsigned',
  signature: 'sh.triggers.refusal.signature',
  stale: 'sh.triggers.refusal.stale',
  no_project: 'sh.triggers.refusal.no_project',
});

// The problems of a trigger or an inbound source itself that wait for the owner (§8), each a
// run of one kind of refusal or failure: signatures that keep failing, a project whose trigger
// queue stays full, a rule the service cannot work out any more.
export type TriggerProblem = 'signature' | 'queue_full' | 'broken';
export const PROBLEM_OF: Partial<Record<RefusalReason, TriggerProblem>> = { unsigned: 'signature', signature: 'signature', stale: 'signature', queue_full: 'queue_full' };
export const PROBLEM_LABELS: Readonly<Record<TriggerProblem, string>> = localeMap({
  signature: 'sh.triggers.problem.signature',
  queue_full: 'sh.triggers.problem.queue_full',
  broken: 'sh.triggers.problem.broken',
});

// The inbound sources of the whole tycho (§2.2). A source is one caller, one address and one
// rotating key; a translator reads what that caller sends into events for the projects the
// owner let through. The kinds this program has, and what each one's requests look like.
export const INBOUND_KINDS = ['tycho-v1', 'standard-webhooks', 'github'] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];
export const INBOUND_KIND_LABELS: Readonly<Record<InboundKind, string>> = localeMap({
  'tycho-v1': 'sh.triggers.inboundKind.tycho-v1',
  'standard-webhooks': 'sh.triggers.inboundKind.standard-webhooks',
  github: 'sh.triggers.inboundKind.github',
});
export const INBOUND_KIND_ABOUT: Readonly<Record<InboundKind, string>> = localeMap({
  'tycho-v1': 'sh.triggers.inboundAbout.tycho-v1',
  'standard-webhooks': 'sh.triggers.inboundAbout.standard-webhooks',
  github: 'sh.triggers.inboundAbout.github',
});

// The tycho protocol, version 1 (§2.2): what a caller sends and what it signs —
// HMAC-SHA256 with the key over "v1\n<signing time>\n<event id>\n<project id>\n" and the raw
// body's bytes, in lower-case hex; the signing time is UTC seconds. The project header is
// empty in what is signed when the request names no project.
export const TYCHO_V1_VERSION = 'v1';
export const TYCHO_V1_HEADERS = { event: 'X-Tycho-Event-Id', time: 'X-Tycho-Timestamp', signature: 'X-Tycho-Signature', project: 'X-Tycho-Project' } as const;
// Standard Webhooks v1 (https://www.standardwebhooks.com/): HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<raw_body>" with base64-decoded key after "whsec_".
export const STANDARD_WEBHOOK_HEADERS = { id: 'webhook-id', time: 'webhook-timestamp', signature: 'webhook-signature' } as const;
// What a GitHub push sends (§2.2): its own headers, and its signature over the body alone.
export const GITHUB_HEADERS = { event: 'X-GitHub-Event', delivery: 'X-GitHub-Delivery', signature: 'X-Hub-Signature-256' } as const;
export interface InboundReceiptResult {
  fire_id: string;
  project_id: string;
  outcome: FireOutcome;
  state: string | null;
  reply?: string;
}

export const inboundResultPath = (sourceId: string, receiptId: string): string =>
  inboundPath(sourceId) + '/result/' + receiptId;
export const inboundPath = (sourceId: string): string => `/inbound/${sourceId}`;

// Whether the internet can reach the inbound sources (§2.2), by the gateway's state or an active
// reverse-proxy outside listener with a public address: without either they are only reached on
// the inside listener.
export type InboundReach = 'no_gateway' | 'gateway_down' | 'ready';
export const INBOUND_REACH_LABELS: Readonly<Record<InboundReach, string>> = localeMap({
  no_gateway: 'sh.triggers.inboundReach.no_gateway',
  gateway_down: 'sh.triggers.inboundReach.gateway_down',
  ready: 'sh.triggers.inboundReach.ready',
});
export const inboundReach = (
  gateway: 'off' | 'connecting' | 'connected' | 'down',
  options?: { reverseProxyPort?: number; publicUrl?: string | null },
): InboundReach => {
  if (gateway === 'connected') return 'ready';
  if ((options?.reverseProxyPort ?? 0) > 0 && Boolean(options?.publicUrl?.trim())) return 'ready';
  return gateway === 'off' ? 'no_gateway' : 'gateway_down';
};

// How the turn of an accepted occurrence went, as its message stands.
export const FIRE_MESSAGE_LABELS: Readonly<Record<string, string>> = localeMap({
  received: 'sh.triggers.fireMessage.received',
  processing: 'sh.triggers.fireMessage.processing',
  processed: 'sh.triggers.fireMessage.processed',
  unverified: 'sh.triggers.fireMessage.unverified',
  ignored: 'sh.triggers.fireMessage.ignored',
});
