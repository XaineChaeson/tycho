import {outputReport,releasesFor,policyOf} from './node-output.ts';
import { deviceLoginMissingText, joinMissingText, modelText, NEEDS_LOGIN_TEXT, RECENT_ENDED, WORK_GROUPS, workGroup } from '../shared/labels.ts';
import { grantsOf } from '../shared/grants.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { importSkills } from './skill-import.ts';
import { buildMachineSkillsManifest, packAuthorizedSkillBundle } from './skill-bundles.ts';
import { deleteDirectoryTheme, listDirectoryThemes, saveDirectoryTheme, themesDirOf } from './themes.ts';
import { deleteDirectoryLocale, localesDirOf, saveDirectoryLocale, syncDirectoryLocales } from './locales.ts';
import {
  exportLocaleTemplate,
  getActiveLocale,
  getLocalePack,
  getResolvedMessages,
  listLocalePackSummaries,
  normalizeLocale,
  setActiveLocale,
} from '../shared/i18n.ts';
import { isDirectorySkillId } from '../shared/skill-catalog.ts';
import { knowledgeLimits } from './service-settings.ts';
import { routerCallText } from './router-call-text.ts';
import type { OrphanReport, Runner } from '../runner/runner.ts';
import type { Auth } from './auth.ts';
import type { Backups } from './backup.ts';
import { deadLinkPage, deviceLoginFullPage, endedDeviceLoginPage, enterPage, notBuiltPage, tooManyPage, waitDeviceLoginPage } from './auth.ts';
import { inspectDotfilesBoundary, type DoctorCheck } from './doctor.ts';
import { toJsonSchemaToolsList } from './tool-schema.ts';
import { KNOWLEDGE_MCP } from '../shared/knowledge.ts';
import { assertSteady } from './degraded.ts';
import { ConfirmationRequired, DegradedError, InputError } from './errors.ts';
import { hostZone } from './schedule.ts';
import type { Inbounds } from './inbound.ts';
import type { createProjectDirectory } from './project-directory.ts';
import { DIRECTORY_FEED_PATH } from '../shared/project-directory.ts';
import { INBOUND_KIND_ABOUT, INBOUND_KINDS, INBOUND_KIND_LABELS, INBOUND_REACH_LABELS, inboundReach, type RefusalReason } from '../shared/triggers.ts';
import type { GatewayStatus } from './gateway.ts';
import { ulid } from './ids.ts';
import type { WaitingLogin } from './dispatcher.ts';
import type { Logins } from './logins.ts';
import type { LoginSettingsInput } from './accounts.ts';
import { accountNameProblem, loginName, organizationIdOf, takesTypedLogin, typedLoginRefusal, type AccountLoginOffer } from '../shared/logins.ts';
import { isTierId, TIER_IDS, tierValueFrom, type TierId } from '../shared/tiers.ts';
import { effectiveRouteOfLogin, normalizeDispatchSlotsConfig, normalizeTierSlots, slotForLogin, type DispatchSlotsConfig } from '../shared/dispatch-slots.ts';
import { dispatchOrderKey } from './settings.ts';
import { ROUTER_RECEIPT, type RouterCallTrace } from '../shared/trajectory.ts';
import { repoUrlsOf } from '../shared/sources.ts';
import { parseTaskPrefer } from '../shared/tasks.ts';
import { NO_PAGE_LOGIN_TEXT, UNSUPPORTED_TEXT } from '../shared/claude-login.ts';
import { NO_DEVICE_LOGIN_TEXT } from '../shared/codex-login.ts';
import { NO_MACHINE_SIGN_IN_TEXT } from '../shared/sign-in.ts';
import { isCodexOAuthLease, isCodexOAuthSecret } from '../adapters/codex-auth.ts';
import type { Login, Snapshot } from '../runner/snapshot.ts';
import type { ConsoleSession, Ctx, InviteRow, Ledger, AccountRecord, MachineRecord, RunRow, TaskRow } from './ledger.ts';
import type { LoginMode, MessageRow, ProjectRow } from './messages.ts';
import {
  buildSandboxedPreviewHtml,
  isPreviewableArtifactMime,
  isProjectFileKind,
  isRasterImageMime,
  MAX_IMAGE_FILE_BYTES,
  MAX_PROJECT_FILE_BYTES,
  normalizeProjectFileMime,
  normalizeProjectFileName,
  parseAttachmentIds,
  readProjectFileBytes,
  removeProjectFileBytes,
  stageRemoveProjectFileBytes,
  toProjectFileSummary,
  writeProjectFileBytes,
  type ProjectFileKind,
  type ProjectFileSummary,
} from './project-files.ts';
import { loginRefused, machineEnds, namedSkillsOf, materialEnd, NotFoundError, restingUntil, loginMissing, unconfirmedSince, unknownFrom, unreachableSince, unverifiableReason, usageNow } from './ledger.ts';
import { readTaskDiff } from './diff.ts';
import { ownLoginHere } from './readonly.ts';
import type { Wait } from './pick.ts';
import { candidateLogins, needsRoleToPlace } from './pick.ts';
import { createLoginLimit } from './login-limit.ts';
import type { LoginLimitPolicy } from './login-limit.ts';
import type { ReleaseIntent, ReleaseResult } from './releases.ts';
import { nameIsSafe, releasesOf } from './releases.ts';
import type { NodeReleases } from './node-release.ts';
import type { Acceptor } from './accept.ts';
import type { SessionHost } from './session-host.ts';
import type { SettingKey, Settings, SettingValue } from './settings.ts';
import { LOOPBACK as LOOPBACK_ADDRESS, settingKey } from './settings.ts';
import type { AccountInput, Accounts } from './accounts.ts';
import { absent, loginStatus } from './accounts.ts';
import type { QuotaReads } from './quota-read.ts';
import { latestQuota, type QuotaAlias, type QuotaLogin } from '../shared/usage.ts';
import type { UsageQuery } from './usage.ts';
import type { Machines } from './machines.ts';
import { createRoles, type RoleInput } from './roles.ts';
import { parseReviewOf } from './review.ts';
import { createLandingTask, landableOf } from './land.ts';
import type { VerdictRecord } from '../shared/review.ts';
import { NodeAway, NodeCommandTimeout, NodeRefused, type Nodes } from './nodes.ts';
import { isEntryRepairAction, protocolMismatchText, NODE_HOLD_HEADER, NODE_PROTOCOL, NODE_RELEASE_PATH, NODE_RELEASE_PACKAGE_PATH, NODE_RELEASE_SHA256_HEADER, NODE_RELEASE_VERSION_HEADER, NODE_SKILLS_PACKAGE_PREFIX } from '../shared/node-protocol.ts';
import type { EntryRepairAction, NodeCredentialAnswer, NodeEntryContent, NodeEntryReport, NodeExecutorStatus, NodeFacts, NodePollAnswer, NodeReleaseAnswer, NodeRepairEntryResult, NodeRunSummary, NodeSkillsManifest } from '../shared/node-protocol.ts';
import type { Models } from './models.ts';
import type { ExecutorUpdates } from './executor-updates.ts';
import { eligibleMachines, runOnMachine } from '../runner/snapshot.ts';
import type { Tools } from './tools.ts';
import type { KnowledgeClient, Proposer } from './knowledge.ts';
import { callLibrary, createLibrary } from './library.ts';
import { GRANTS, type Grant } from '../shared/knowledge.ts';
import { summarizeWork, workSummaries, type WorkSummary } from './work-summary.ts';
import { traceRun } from './trace.ts';
import { buildRunDiagnostics } from './run-diagnostics.ts';
import { extractTaskFacts } from './run-facts.ts';
import type { NormalizedEvent } from '../adapters/types.ts';
import { runErrorView } from './run-view.ts';
import { readRunReport, reportFilesOf } from './reports.ts';
import type { Weixin } from './weixin.ts';
import type { ImGroupBindingInput, ImGroupBindingPatch, ImGroupBindingView } from '../shared/im.ts';
import { parseGitHubRepo, type GitHubService } from './github.ts';
import type { ReplayConsole } from './replay-console.ts';
import type { ClaudeLogin } from './claude-login.ts';
import type { CodexLogin } from './codex-login.ts';
import type { SignIns } from './sign-ins.ts';
import type { SideAskContext, SideAskInput, SideAskResult, SideAskTurn } from './side-ask.ts';

const MAX_BODY_BYTES = 1024 * 1024;
// GitHub's own hook payloads go up to 25 MB, and its signature covers every byte: an inbound
// request is read whole, then judged by the much smaller `triggers.dataLimitKb` before anything
// is stored. This is GitHub's protocol fact, not a behaviour of this service to tune.
const MAX_INBOUND_BODY_BYTES = 25 * 1024 * 1024;
const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
// A project's conversation page reads this many of a segment's messages at once.
const CONVERSATION_LIMIT = 500;
// How many of a project's latest trigger occurrences its page shows.
const RECENT_FIRES = 30;
const TASK_POLL_MS = 1000;
const KEEPALIVE_MS = 15_000;
const CONSOLE_ACTOR = 'console';
// The console as its own toolchain builds it. The page is at "/" and nowhere else.
const CONSOLE_DIST = join(import.meta.dirname, '..', 'console', 'dist');
const CONSOLE_PAGE = 'index.html';
// Where the build puts files named after their content: a new build gives new names.
const HASHED_PREFIX = 'assets/';
const HASHED_CACHE = 'private, max-age=31536000, immutable';
// What the Router or a Worker writes reaches the page as text, never as markup; this is
// the second lock. Scripts, fonts and connections are this origin's and nothing else,
// and a style attribute written in markup is refused. A <style> element is allowed:
// the console's component library adds one of its own when a dialog opens.
const CONSOLE_POLICY = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'";
const ARTIFACT_PREVIEW_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const RAW_FILE_POLICY = "default-src 'none'; sandbox";
const SAFE_INLINE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);
const MAX_MESSAGE_ATTACHMENTS = 8;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};
// Static PWA install metadata and icons fetched by mobile OS/browser daemons without session cookies.
const PUBLIC_PWA_ASSET = /^\/(?:manifest\.webmanifest|icons\/[a-zA-Z0-9._-]+\.png)$/;
export const loginLinkPath = (credential: string): string => `/login#${credential}`;
const DEVICE_LOGIN = '/login/device';
const PENDING_COOKIE = 'tycho_pending';
const SETTING = '/api/settings/:key([\\w.]+)';
// An account as the console writes it, by the name each field has in the answers. The
// token goes in on the way in and never comes out.
const ACCOUNT_FIELDS: Record<string, keyof AccountInput> = {
  name: 'name',
  executor: 'executor',
  tiers: 'tiers',
  permission_mode: 'permissionMode',
  timeout_ms: 'timeoutMs',
  max_runs: 'maxRuns',
  credential: 'credential',
  provider: 'provider',
};
// A machine's own login as the console writes it: the same settings an account carries.
const MACHINE_LOGIN_FIELDS: Record<string, keyof LoginSettingsInput> = {
  tiers: 'tiers',
  permission_mode: 'permissionMode',
  timeout_ms: 'timeoutMs',
  max_runs: 'maxRuns',
};
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Whether what a caller showed is this secret, in time that does not depend on how much of
// it matched. Hashed first so that lengths do not have to agree.
function sameSecret(shown: unknown, expected: string | undefined): boolean {
  if (typeof shown !== 'string' || !expected) return false;
  const digest = (text: string): Buffer => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(shown), digest(expected));
}
// A Task whose machine is out of contact is being worked on by the rules, not by the owner.
const MOVING = new Set(['queued', 'running', 'stopping', 'needs_verification']);

type Visitor = ConsoleSession & { fromMemory?: true };

interface Asked {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  // What the `:name` parts of the route's path stood for, in order.
  params: string[];
  // The listener the request came in by. What comes in by the outside one is from the
  // internet, whatever address it shows: the gateway's requests arrive from this machine.
  outside: boolean;
}

// One row for everything the service answers except the pages. `outside: true` is what
// lets a route be reached through the gateway: a row without it is served on the inside
// listener only. A route for this machine's own processes, which shows the token that
// process was given, cannot carry the mark at all.
export type Route = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string } & (
  // `ifShown`: taken only by a request that shows a token. One without is left to the
  // row for browsers further down.
  | { token: () => string | readonly string[] | undefined; ifShown?: true; anonymous?: never; node?: never; knowledge?: never; inbound?: never; outside?: never; handle(asked: Asked): unknown }
  | { anonymous: true; token?: never; node?: never; knowledge?: never; inbound?: never; outside?: true; handle(asked: Asked): unknown }
  // A knowledge MCP client on this machine (docs/design/knowledge-and-skills.md §4.3): its own
  // token, from the loopback only, on the inside listener only — the type cannot mark it
  // outside. It opens the knowledge tools and nothing else; a machine elsewhere reaches the
  // same tools through its node channel.
  | { knowledge: true; token?: never; anonymous?: never; node?: never; inbound?: never; outside?: never; handle(asked: Asked & { client: KnowledgeClient }): unknown }
  // A machine's own client. Reachable from the internet, which is the point, and open to
  // no other kind of caller: neither a console cookie nor this machine's own token is
  // looked at here (nodes.md §5.3).
  | { node: true; outside: true; token?: never; anonymous?: never; knowledge?: never; inbound?: never; handle(asked: Asked & { node: MachineRecord }): unknown }
  // An inbound source's entrance (docs/design/triggers.md §2.2): its signature is its one
  // authentication, checked by the handler. Nothing else a request shows is looked at here — no
  // console cookie, no token of this machine or of the Router — and it opens nothing else.
  | { inbound: true; outside: true; token?: never; anonymous?: never; node?: never; knowledge?: never; handle(asked: Asked): unknown }
  // The rest are for a browser that is signed in.
  | { anonymous?: never; token?: never; node?: never; knowledge?: never; inbound?: never; outside?: true; handle(asked: Asked & { visitor: Visitor }): unknown }
);

// `:name` stands for one segment of the path, `:name(...)` for what the pattern in the
// brackets matches.
function pathPattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/:\w+(?:\(([^)]+)\))?/g, (_part, pattern?: string) => `(${pattern ?? '[^/]+'})`)}$`);
}

// A row only a machine's own client may take, told apart from the rest so that the token
// check and the handler both know what they have.
type NodeRoute = Extract<Route, { node: true }>;
const isNodeRoute = (route: Route): route is NodeRoute => (route as { node?: true }).node === true;
type KnowledgeRoute = Extract<Route, { knowledge: true }>;
const isKnowledgeRoute = (route: Route): route is KnowledgeRoute => (route as { knowledge?: true }).knowledge === true;
type InboundRoute = Extract<Route, { inbound: true }>;
const isInboundRoute = (route: Route): route is InboundRoute => (route as { inbound?: true }).inbound === true;

// How a route tells who may call it, for the list of what can be reached.
const authOf = (route: Route): 'token' | 'anonymous' | 'knowledge' | 'node' | 'signature' | 'login' =>
  route.token ? 'token' : route.anonymous ? 'anonymous' : isKnowledgeRoute(route) ? 'knowledge' : isNodeRoute(route) ? 'node' : isInboundRoute(route) ? 'signature' : 'login';

// What an inbound caller is answered when its request is not accepted (§2.2, §4): a full queue and
// a rate reached are "later", which a retry with the same event id may get past; so is a paused project.
const REFUSAL_STATUS: Record<RefusalReason, number> = {
  unsigned: 400,
  signature: 401,
  stale: 401,
  disabled: 403,
  conflict: 409,
  source: 409,
  too_large: 413,
  queue_full: 429,
  rate_trigger: 429,
  rate_global: 429,
  // Paused or archived by the owner: nothing runs now, and a retry after the restore is accepted.
  project_paused: 503,
  project_archived: 503,
  // Well-formed and signed, but it names no project this source lets through.
  no_project: 422,
};

// Who the gateway or reverse proxy says a request is from: the rightmost non-empty entry
// in X-Forwarded-For (written by the trusted proxy via `$remote_addr` or
// `$proxy_add_x_forwarded_for`, ignoring any spoofed leftmost entries or unstripped
// X-Real-IP headers from clients). Without one, everything that comes in by the outside
// listener counts as one source.
function forwardedFrom(request: IncomingMessage): string {
  const header = request.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.at(-1) ?? '';
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Stream {
  publish(event: string, data: unknown): void;
  // A stream opened under a login ends with it; `owner` is what detach() finds it by.
  attach(response: ServerResponse, owner?: string, runs?: readonly string[], valid?: () => boolean): void;
  detach(owner: string): void;
  readonly size: number;
  close(): void;
}

// Best effort by design: a client that missed something reads the snapshot again.
export function hydrateMessageEvent(
  ledger: Pick<Ledger, 'listProjectFilesByIds'>,
  payload: unknown,
): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.attachments)) return payload;
  if (typeof record.project_id !== 'string' || typeof record.attachments_json !== 'string') return payload;
  const ids = parseAttachmentIds(record.attachments_json);
  if (ids.length === 0) return payload;
  const byId = new Map(
    ledger.listProjectFilesByIds(record.project_id, ids).map((row) => [row.id, toProjectFileSummary(row)]),
  );
  const attachments = ids
    .map((id) => byId.get(id))
    .filter((file): file is ProjectFileSummary => file !== undefined);
  return attachments.length > 0 ? { ...record, attachments } : payload;
}

export function createStream({ keepaliveMs = KEEPALIVE_MS }: { keepaliveMs?: number } = {}): Stream {
  const clients = new Map<ServerResponse, { owner: string | undefined; runs: Set<string>; valid?: () => boolean }>();

  // Whatever a slow reader has not taken stays in this process. Cut off, it reads the
  // snapshot again when it reconnects, which is the same as having missed an event.
  function send(client: ServerResponse, frame: string): void {
    client.write(frame);
    if (client.writableLength <= MAX_STREAM_BUFFER_BYTES) return;
    clients.delete(client);
    client.destroy();
  }

  function heartbeat(): void {
    for (const [client, subscription] of clients) {
      if (subscription.valid && !subscription.valid()) {
        clients.delete(client);
        client.end();
      } else send(client, ': keepalive\n\n');
    }
  }
  const keepalive = setInterval(heartbeat, keepaliveMs);
  keepalive.unref();

  return {
    get size() {
      return clients.size;
    },
    publish(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const [client, subscription] of clients) {
        if (event === 'run_event' && !subscription.runs.has((data as { run_id: string }).run_id)) continue;
        send(client, frame);
      }
    },
    attach(response, owner, runs = [], valid) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        // For the gateway's reverse proxy: nginx holds a response back until its buffer
        // fills unless the response itself says not to.
        'X-Accel-Buffering': 'no',
      });
      response.write(': connected\n\n');
      clients.set(response, { owner, runs: new Set(runs), valid });
      response.on('close', () => clients.delete(response));
    },
    detach(owner) {
      for (const [client, subscription] of clients) {
        if (subscription.owner !== owner) continue;
        clients.delete(client);
        client.end();
      }
    },
    close() {
      clearInterval(keepalive);
      for (const client of clients.keys()) client.end();
      clients.clear();
    },
  };
}

export interface TaskAssignment {
  role_id: string | null;
  role_name: string | null;
  tier: string | null;
  tier_source: string | null;
  login_name: string | null;
  executor: string | null;
  machine_name: string | null;
  placed_by: string | null;
  is_live: boolean;
}

type ProjectDispatchOrder = Partial<Record<TierId, string[]>>;
type EffectiveProjectDispatchOrder = Record<TierId, string[]>;

export interface HttpOptions {
  dataDir?: string;
  weixin?: Weixin;
  github?: GitHubService;
  replay?: ReplayConsole;
  ledger: Ledger;
  tools: Pick<Tools, 'names' | 'list' | 'call'>;
  auth: Auth;
  session: Pick<SessionHost, 'admitTool' | 'toolTokens' | 'projectOfToken' | 'kick' | 'interrupt' | 'restart'> & {
    status(): Omit<ReturnType<SessionHost['status']>, 'resting_until' | 'projects'> & {
      resting_until?: string | null;
      projects: (Omit<ReturnType<SessionHost['status']>['projects'][number], 'resting_until'> & { resting_until?: string | null })[];
    };
  };
  stream: Stream;
  runner?: Pick<Runner, 'events' | 'eventBase' | 'subscribe' | 'interrupt' | 'eventSnapshot' | 'abandon' | 'machines' | 'check' | 'checkMachine'> & Partial<Pick<Runner, 'readReportFile' | 'recoverRunReport' | 'readStderrSnippet'>>;
  accounts: Pick<Accounts, 'list' | 'get' | 'put' | 'remove' | 'executors' | 'permissionModes' | 'tierForms' | 'providerForms' | 'checkLine' | 'credentialExecutors' | 'accountLogins' | 'setCredential'> & Partial<Pick<Accounts, 'judgeReport' | 'machineQuotaOffered' | 'canRoute'>>;
  // Signing in to a Claude account from the console (docs/design/native-login.md). Absent in a
  // service without it: the page offers no login, and the routes say there is none.
  claudeLogin?: Pick<ClaudeLogin, 'executor' | 'available' | 'start' | 'get' | 'submit' | 'save' | 'cancel'>;
  codexLogin?: Pick<CodexLogin, 'executor' | 'available' | 'start' | 'get' | 'save' | 'cancel'>;
  // Signing a machine in to one of its executors, run on that machine (service/sign-ins.ts).
  // Absent in a service without it: the routes say there is none, and polls name no sign-in.
  signIns?: Pick<SignIns, 'start' | 'get' | 'submitCode' | 'cancel' | 'listFor'>;
  // Every login a round can run as, and the machines' own logins to set.
  logins: Pick<Logins, 'get' | 'list' | 'machineLogins' | 'putMachineLogin' | 'removeMachineLogin'>;
  // What an account's executor last reported about its models. Absent in a service without
  // one, and then an account shows no list rather than a made-up one.
  models?: Pick<Models, 'state' | 'refresh' | 'reschedule'> & Partial<Pick<Models, 'readLine'>>;
  // Multi-machine CLI fleet updater (version drift check, idle-safe updates, scheduled policy).
  executorUpdates?: Pick<ExecutorUpdates, 'status' | 'refreshUpstream' | 'triggerUpdate' | 'setPolicy'>;
  // Ephemeral read-only Side Ask runner for clarifying questions without mutating ledger history.
  sideAsk?: (projectId: string, context: SideAskContext, input: SideAskInput) => Promise<SideAskResult>;
  // Asking an account's quota now (docs/design/usage.md §3). Absent in a service without it:
  // the figures are only those the rounds report, and the page says nothing can be asked.
  quota?: Pick<QuotaReads, 'refusal' | 'read' | 'readStale' | 'state'>;
  machines: Pick<Machines, 'list' | 'get' | 'setNote' | 'remove'>;
  // The machines that came back by themselves: who is asking to be let in, who is
  // connected right now, and the one command each of them carries (nodes.md §5.3).
  nodes: Pick<Nodes, 'register' | 'claim' | 'pendingJoins' | 'decide' | 'admitLocal' | 'authenticate' | 'poll' | 'report' | 'leave' | 'connected' | 'lastSeen' | 'reportedRuns' | 'reportedExecutors' | 'reportedEntry' | 'askExecutors' | 'noteProtocol' | 'clearProtocol' | 'redeem' | 'noteRelease' | 'reportedRelease' | 'reportedOutput' | 'reportedServiceManager' | 'boundedOutput'> & Partial<Pick<Nodes, 'reportedSkills' | 'send' | 'setEntryReport'>>;
  // The host's own release, as a machine's client fetches it (docs/design/nodes.md §1.4).
  // Absent in a service that has none to hand out: the routes answer with why.
  nodeRelease?: Pick<NodeReleases, 'answer' | 'package'>;
  // The setting node.releaseCheckMs, told to a client with every answer.
  nodeReleaseCheckMs: () => number;
  // The global entry (knowledge-and-skills.md §4.3): the content in force now, which a poll
  // whose machine is behind is given, and what this host did with it for its own executors.
  // Absent in a service without it: no machine is given any.
  globalEntry?: {
    content(): NodeEntryContent;
    hostReport(): NodeEntryReport | null;
    repairHost?: (executor: string, action: EntryRepairAction) => NodeRepairEntryResult;
  };
  // What one round's snapshot is, as the files a machine writes: the machine fetches them
  // itself (nodes.md §8.2, "大块数据是机器来取的").
  roundSnapshot: (runId: string) => { run_dir: string; files: { path: string; text: string }[] } | null;
  // The account's token for one round, read at the moment it is handed over and never
  // written down. Null when that round has none to give.
  roundCredential: (runId: string) => Promise<{ run_id: string; value: string } | null> | { run_id: string; value: string } | null;
  // The one-time join materials for a round that is starting, minted at this call (nodes.md
  // §1.3). Null when the round's task has no open quota.
  roundInvite: (runId: string) => string[] | null;
  // Write-only from here: whether one is set is all any answer says about it.
  wecomSecret: { isSet(): boolean; set(secret: unknown, ctx: Ctx): void };
  reconnectWecom?: () => { connected: boolean; since: string | null; error: string | null } | null;
  // Where a knowledge MCP client's token is kept: a Secret beside the ledger, which only holds
  // its hash. Read back only for the owner, on the knowledge page.
  knowledgeTokens: { save(id: string, token: string): void; read(id: string): string; remove(id: string): void };
  // The inbound sources' keys and the check of a request's signature (docs/design/triggers.md §2.2).
  inbounds: Inbounds;
  projectDirectory?: ReturnType<typeof createProjectDirectory>;
  // Where the owner kept skill files by project before skills were ledger entries (the data
  // directory's `skills`): what the knowledge page's import reads by default, and nothing else.
  skillFolder: string;
  doctor: () => Promise<DoctorCheck[]>;
  // A login link as it has to be opened: on the address others reach the service by.
  loginUrl: (path: string) => string;
  // A project was deleted (project-sessions, "项目的生命周期"): what it left on disk is cleared
  // now rather than at the next housekeeping pass. Absent in a service without a disk to tidy.
  cleanupAfterProjectDelete?: () => void;
  // The address the pages are opened at through the gateway, which is where a write that
  // comes in by the outside listener has to be from. Empty when none is set.
  publicUrl?: () => string;
  gateway?: () => GatewayStatus;
  // The loopback port currently bound for the local reverse proxy outside listener (0 when off).
  reverseProxyPort?: () => number;
  // The clock the count of failed logins from outside runs by, and how many it lets by.
  now?: () => number;
  loginLimit: LoginLimitPolicy;
  // Logins with work waiting and no machine that answers, as the dispatcher last found.
  waitingLogins?: () => WaitingLogin[];
  // What a Task is waiting for when none of its logins can take it now, as the
  // dispatcher would find; null when one can.
  taskWait?: (task: TaskRow) => Wait | null;
  // The grace period the Runner judges by, for saying from when a lost Run may be continued.
  lostGraceMs: () => number;
  // How often a machine's client looks at its own executors again: told with every poll.
  nodeLookEveryMs: () => number;
  // How long a machine may spend on the one command that lists its executor's models
  // (node.modelListTimeoutMs), told with every poll answer. Its own span because it may have
  // to reach the vendor after a fresh sign-in, unlike the other probes.
  nodeModelListTimeoutMs: () => number;
  // How long a machine may spend on a read of one of its own logins' quota
  // (node.quotaReadTimeoutMs), told with every poll answer. Its own span too: one of these
  // commands counts a whole session's use before it answers.
  nodeQuotaReadTimeoutMs: () => number;
  // Separate from the tool token, which is handed to the Router's proxy.
  loginToken: string;
  // What this machine's own commands show: to stop the service, and to ask who it is.
  shutdownToken: string;
  // What only the running service knows about the release it is: whether its ledger can
  // be read at all and whether it can be written, whether the inventory that follows a
  // start has finished, and how long a release is watched for crashes. Asked by the
  // command putting a release in place, over the inside listener.
  releaseCheck: () => { ledger: string; degraded: boolean; recovering: boolean; health_window_ms: number; recovery_wait_ms?: number };
  // Lets the turn being handled finish, up to the owner's setting, before the service is
  // stopped. Answers anyway once that limit is past.
  drain: () => Promise<{ drained: boolean; waited_ms: number }>;
  // Accepting a Task and taking back what its Run left: one implementation for the page
  // and for the Router's own tool.
  accept: Acceptor;
  // On-demand pulling of Worker visual/document deliverables into project files before acceptance.
  deliverables?: { ingestTask(taskId: string): Promise<{ files: ProjectFileSummary[]; problem: string | null }> };
  // The release packages the Runs left, how the last launch ended, and putting one in
  // place: the one thing the console does that an installed copy does and a checkout
  // cannot.
  releases: {
    dataDir: string;
    version: string;
    last: () => ReleaseResult | null;
    // What the owner asked for, once no result has answered it yet.
    intent: () => ReleaseIntent | null;
    // Whether an upgrade command is at work right now: the one thing that makes a second
    // request for the same release a report rather than a second release.
    attempting: () => boolean;
    // Starting the upgrade command on the package the owner confirmed, by name, digest and
    // size. It outlives this service: it is the one that stops it.
    launch: (runId: string, chosen: { name: string; sha256: string; bytes: number }, ctx: Ctx) => { started: boolean; version: string };
  };
  // Who this service is and where it really listens.
  instance: () => Record<string, unknown>;
  onShutdown: () => void;
  channels?: () => unknown;
  // The last count of what the instances hold that a restored ledger does not know.
  orphans?: () => OrphanReport[];
  backup: Pick<Backups, 'status' | 'trigger'>;
  settings: Pick<Settings, 'list' | 'set' | 'reset' | 'get'>;
  // Read-only facts for the settings page, as they are when asked. Addresses and paths,
  // never what is behind them.
  deployment: () => Promise<{ title: string; value: string }[]>;
  // The built console, where a test keeps a stand-in. Absent means the one of this checkout.
  consoleDir?: string;
  log?: (line: string) => void;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendPage(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // Not no-referrer: that would turn the form's own Origin into "null".
    'Referrer-Policy': 'strict-origin',
  });
  response.end(html);
}

// The one reader of request bodies. Bytes that are not UTF-8 (a Windows console's GBK)
// are refused, not decoded with replacement characters and stored as the text.
const UTF8 = new TextDecoder('utf-8', { fatal: true });

// A body as its bytes, for what is judged by exactly those: an inbound request's signature.
async function readBytes(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readText(request: IncomingMessage): Promise<string> {
  const bytes = await readBytes(request);
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new HttpError(400, '请求正文不是 UTF-8 编码，没有收下');
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('不是对象');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求体不是 JSON 对象');
  }
}

const USAGE_RANGE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

// The range the usage page asks for: two instants and the reader's offset from UTC in minutes,
// so that its days are the reader's (docs/design/usage.md §4).
function usageQuery(url: URL): UsageQuery {
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  const tz = Number(url.searchParams.get('tz') ?? '0');
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (Number.isNaN(Date.parse(value))) throw new InputError(`${name} 应为一个时刻`);
  }
  if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) throw new InputError('tz 应为与 UTC 相差的分钟数');
  // The page asks for 90 days at most; a year bounds what one read of the ledger sums.
  if (Date.parse(to) - Date.parse(from) > USAGE_RANGE_MAX_MS || Date.parse(to) < Date.parse(from)) throw new InputError('时间范围应在一年以内，且开始早于结束');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), tzOffsetMinutes: tz };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return parseObject(await readText(request));
}

function pageSize(value: string | null): number {
  if (value === null) return DEFAULT_PAGE;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, 'limit 应为正整数');
  return Math.min(size, MAX_PAGE);
}

// A write whose body may be left out: what a caller with nothing to say sends. Every
// field is then missing, and the route that asked says which ones it needed. Bytes that
// are not UTF-8 are not "nothing said": they are refused like anywhere else.
async function readJsonOrNone(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(request);
  try {
    return parseObject(text);
  } catch {
    return {};
  }
}

export function createHttp(options: HttpOptions) {
  // Roles read and write straight through the ledger: nothing here holds a copy.
  const roles = createRoles({ ledger: options.ledger });
  const library = createLibrary(options.ledger);
  const { ledger, tools, auth, session, stream, loginToken, shutdownToken, onShutdown } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const loginLimit = createLoginLimit(options.loginLimit, options.now);
  const taskStates = new Map<string, string>();
  const runSubscriptions = new Map<string, { count: number; stop: () => void }>();
  const SKILLS_MANIFEST_CACHE_TTL_MS = 5_000;
  const skillsManifestCache = new Map<string, { key: string; at: number; manifest: NodeSkillsManifest }>();
  let baselined = false;

  const imLoginChannels = (): { wecom: boolean; weixin: boolean } => {
    const ch = options.channels?.() as { wecom?: unknown; weixin?: { state?: unknown } | null } | undefined;
    return {
      wecom: Boolean(ch?.wecom) && options.settings.get('im.wecom.approveLogin'),
      weixin: ch?.weixin?.state === 'connected' && options.settings.get('im.weixin.approveLogin'),
    };
  };

  function workSummary(taskId: string) {
    return summarizeWork(taskId, ledger.listTasks(), ledger.listApprovalCards());
  }

  // Every top-level work with its summary, over one reading of the ledger. A work has ended
  // when its summary says so; the ledger keeps every ended one, and the listings that are
  // read on every change carry only the most recent (`RECENT_ENDED`). The others are read a
  // page at a time from the ended list.
  function listWorks() {
    const all = ledger.listTasks();
    const summarize = workSummaries(all, ledger.listApprovalCards());
    const projectOf = new Map(all.map((task) => [task.id, task.project_id]));
    const works = ledger.listTaskSummaries({ top: true }).map((row) => ({ ...row, summary: summarize(row.id) }));
    return { all, works, projectOf };
  }

  const ended = (work: { summary: WorkSummary }): boolean => work.summary.dot === 'done';
  // The most recently ended first; the id keeps works that ended at the same moment in one order.
  const byEnding = (a: { id: string; summary: WorkSummary }, b: { id: string; summary: WorkSummary }): number =>
    (b.summary.ended_at ?? '').localeCompare(a.summary.ended_at ?? '') || b.id.localeCompare(a.id);

  // Every work still open, and the most recent ended ones, in the order they came.
  function currentWorks<T extends { id: string; summary: WorkSummary }>(works: T[]): T[] {
    const recent = new Set(works.filter(ended).sort(byEnding).slice(0, RECENT_ENDED).map(({ id }) => id));
    return works.filter((work) => !ended(work) || recent.has(work.id));
  }

  // The tasks under the given works, at any depth, in the ledger's order.
  function descendants<T extends { id: string; parent_id: string | null }>(all: T[], works: { id: string }[]): T[] {
    const under = new Set(works.map(({ id }) => id));
    const byParent = new Map<string, T[]>();
    for (const task of all) {
      if (!task.parent_id) continue;
      const siblings = byParent.get(task.parent_id);
      if (siblings) siblings.push(task);
      else byParent.set(task.parent_id, [task]);
    }
    for (const id of under) for (const child of byParent.get(id) ?? []) under.add(child.id);
    return all.filter((task) => task.parent_id !== null && under.has(task.id));
  }

  const waitingLogins = (): WaitingLogin[] => options.waitingLogins?.() ?? [];

  // What keeps a Task whose Run is past its grace period from going on right now. Null
  // when nothing does and the next round of dispatch takes it up.
  function continuationBlock(taskId: string, noMachine: boolean): 'recovering' | 'paused' | 'project_paused' | 'project_archived' | 'no_role' | 'no_machine' | 'limit' | null {
    const { paused, recovering } = ledger.dispatchConditions();
    if (recovering || ledger.getRestore()) return 'recovering';
    if (paused) return 'paused';
    const held = ledger.projectStopped(ledger.getTask(taskId).project_id);
    if (held === 'archived') return 'project_archived';
    if (held === 'paused') return 'project_paused';
    if (needsRoleToPlace(ledger.getTask(taskId))) return 'no_role';
    if (noMachine) return 'no_machine';
    return ledger.lostLimitReached(taskId) ? 'limit' : null;
  }

  function activeReview(taskId: string) {
    return ledger.activeReview(taskId);
  }

  function assignmentOf(task: {
    id: string;
    state: string;
    role_id?: string | null;
    tier?: string | null;
    tier_source?: string | null;
    login_id?: string | null;
    machine_id?: string | null;
  }): TaskAssignment {
    const roleId = task.role_id ?? null;
    const roleName = roleId === null ? null : roles.get(roleId)?.name ?? null;
    const tier = task.tier ?? null;
    const tierSource = task.tier_source ?? null;
    const pinnedLoginId = task.login_id ?? null;
    const latestRun = ledger.listRuns(task.id).at(-1);

    let loginName: string | null = null;
    let executor: string | null = null;
    let machineName: string | null = null;
    let placedBy: string | null = null;

    if (latestRun) {
      const runLogin = latestRun.login_id ? options.logins.get(latestRun.login_id) : undefined;
      loginName = runLogin?.name ?? latestRun.login_name ?? latestRun.login_id ?? null;
      let runExecutor: string | null = null;
      try {
        const snapshot = JSON.parse(latestRun.snapshot_json) as { executor?: unknown };
        if (typeof snapshot.executor === 'string' && snapshot.executor !== '') runExecutor = snapshot.executor;
      } catch {
        // ignore malformed snapshot
      }
      executor = runExecutor ?? runLogin?.executor ?? null;
      const machine = latestRun.machine_id ? options.machines.get(latestRun.machine_id) : undefined;
      machineName = machine?.id ?? latestRun.machine_id ?? (latestRun.host || null);
      placedBy = ledger.placementOf(latestRun.id) ?? null;
    } else {
      if (pinnedLoginId !== null) {
        const pinnedLogin = options.logins.get(pinnedLoginId);
        loginName = pinnedLogin?.name ?? null;
        executor = pinnedLogin?.executor ?? null;
        machineName = pinnedLogin?.machine ?? null;
      }
      if (task.machine_id) machineName = task.machine_id;
    }

    return {
      role_id: roleId,
      role_name: roleName,
      tier,
      tier_source: tierSource,
      login_name: loginName,
      executor,
      machine_name: machineName,
      placed_by: placedBy,
      is_live: task.state === 'running' || task.state === 'queued',
    };
  }

  // What the pages say about a Task and the ledger does not hold: what a Task in the
  // queue waits for when none of its logins can take it (a quota to come back, a login
  // to free up, a machine to answer); and, for a Run nobody can speak for, since when the
  // wait that decides its fate has run (out of contact, or answering with no trace of the
  // start), when that wait has lasted the grace period, and what then still stands in the
  // way. That moment is when the Task may go on, never a promise that it will by then.
  // `prefer` is left out of listings that only need a Task's place in the queue: the
  // side column's works and their children never show it.
  function present<T extends { id: string; state: string; source_json?: string | null; role_id?: string | null; tier?: string | null; tier_source?: string | null; login_id?: string | null; machine_id?: string | null }>(task: T, { prefer: withPrefer = true }: { prefer?: boolean } = {}) {
    const loginId = (task as { login_id?: string | null }).login_id;
    const parsed = parseTaskPrefer((task as { prefer_json?: string | null }).prefer_json);
    const prefer = parsed === null
      ? null
      : { login_ids: parsed.login_ids.map((id) => options.logins.get(id)?.name ?? '（已删除的登录）'), reason: parsed.reason };
    // The stored pin is the ledger's; a page gets its projection (source, state, label) only.
    const { source_json: _stored, ...row } = task;
    const shown = {
      ...row,
      ...ledger.taskSourceView(task),
      assignment: assignmentOf(task),
      resumable: ledger.isTaskResumable(task.id),
      review_gate: task.state === 'ready' ? ledger.reviewGateInfo(task.id) : null,
      ...(task.state === 'ready' ? { accept_blocked: ledger.reviewGate(task.id), active_review: ledger.activeReview(task.id)?.id ?? null } : {}),
      ...(loginId === undefined ? {} : { login_name: loginId === null ? null : options.logins.get(loginId)?.name ?? '（已删除的登录）' }),
      ...(withPrefer ? { prefer } : {}),
    };
    if (task.state !== 'queued' && task.state !== 'needs_verification') return shown;
    const waiting = options.taskWait?.(ledger.getTask(task.id)) ?? null;
    if (task.state === 'queued') return waiting ? { ...shown, waiting } : shown;
    const run = ledger.listActiveRuns().find((active) => active.task_id === task.id);
    const since = run && (unreachableSince(run) ?? unconfirmedSince(run));
    return {
      ...shown,
      lost: {
        since: since ?? null,
        eligible_at: since ? new Date(Date.parse(since) + options.lostGraceMs()).toISOString() : null,
        stopping: run !== undefined && unknownFrom(run) === 'stopping',
        blocked: continuationBlock(task.id, waiting !== null),
        waiting,
        missing_login: run !== undefined && loginMissing(run) ? run.login_name : null,
        unverifiable: (run && unverifiableReason(run)) ?? null,
      },
    };
  }

  // These routes serve this machine's own processes, whatever address the service is
  // bound to. Checked before the token: from anywhere else there is nothing to discuss.
  // `expected`: the one token the route takes, or each of several (every Router process has its own).
  function requireLocal(request: IncomingMessage, expected: string | readonly string[] | undefined): void {
    if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) throw new HttpError(403, '只接受本机请求');
    const taken = typeof expected === 'string' ? [expected] : expected ?? [];
    if (!taken.some((each) => each !== '' && request.headers.authorization === `Bearer ${each}`)) throw new HttpError(401, 'token 无效');
  }

  const shownToken = (request: IncomingMessage): string | undefined => {
    const header = request.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : undefined;
  };

  // §9: the cookie is sent whichever page in the browser asks, so a write has to show
  // that it came from this site. The host varies: loopback here, EasyTier from a phone.
  // Through the gateway there is one site, the public address: with none set nothing can
  // show that it came from there, and nothing is written.
  function requireSameOrigin(request: IncomingMessage, outside: boolean): void {
    const { origin, host } = request.headers;
    if (outside) {
      const publicUrl = options.publicUrl?.() ?? '';
      if (publicUrl === '') throw new HttpError(403, '还没有填对外地址，从外面进来的操作一律不接受。在主机上打开控制台，到“设置”里填上');
      if (origin === new URL(publicUrl).origin) return;
    } else if (origin === `http://${host}` || request.headers['sec-fetch-site'] === 'same-origin') return;
    throw new HttpError(403, '请求来源不被允许');
  }

  function createLoginLink({ response }: Asked): void {
    const link = auth.createLink();
    const path = loginLinkPath(link.credential);
    sendJson(response, 201, { path, expires_at: link.expires_at, url: options.loginUrl(path), external: Boolean(options.publicUrl?.()) });
  }

  // The owner's changes to how the service is set up wait for a ledger that can record
  // them and for the inventory to finish, like the settings do. The merge asks the same
  // rule itself, where it writes; this is the entrance.
  function requireSteady(what: string): void {
    assertSteady(ledger.dispatchConditions(), what);
  }

  function shutdown({ response }: Asked): void {
    // After the answer is out: stopping closes this connection too.
    response.once('finish', onShutdown);
    sendJson(response, 202, { stopping: true });
  }

  // Valid credentials always work. The quota only suppresses failed POST replies;
  // previewing or refreshing a link neither spends it nor consumes a failure slot.
  async function exchangeLink({ request, response, outside }: Asked): Promise<void> {
    requireSameOrigin(request, outside);
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      throw new HttpError(415, '登录需要表单正文');
    }
    const form = new URLSearchParams(await readText(request));
    if (form.getAll('credential').length !== 1 || [...form.keys()].some(key => key !== 'credential')) {
      throw new HttpError(400, '登录表单不完整');
    }
    const cookie = auth.login(form.get('credential')!, outside, request.headers['user-agent'] ?? '');
    if (!cookie) {
      const source = forwardedFrom(request);
      if (outside && loginLimit.closed(source)) sendPage(response, 429, tooManyPage());
      else {
        if (outside) loginLimit.failed(source);
        sendPage(response, 410, deadLinkPage(imLoginChannels()));
      }
      return;
    }
    response.writeHead(303, { 'Set-Cookie': cookie, Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin' });
    response.end();
  }

  async function loginWithPassphrase({ request, response, outside }: Asked): Promise<void> {
    requireSameOrigin(request, outside);
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      throw new HttpError(415, '登录需要表单正文');
    }
    const form = new URLSearchParams(await readText(request));
    if (form.getAll('passphrase').length !== 1 || [...form.keys()].some((key) => key !== 'passphrase')) {
      throw new HttpError(400, '登录表单不完整');
    }
    const source = forwardedFrom(request);
    if (outside && loginLimit.closed(source)) {
      sendPage(response, 429, tooManyPage());
      return;
    }
    const passphrase = form.get('passphrase')!;
    const key = outside ? (source || 'outside') : (request.socket.remoteAddress || 'global');
    const result = await auth.loginWithPassphrase(passphrase, outside, request.headers['user-agent'] ?? '', key);
    if (result.ok) {
      redirectLogin(response, result.cookie, '/');
      return;
    }
    if (result.reason === 'busy') {
      response.setHeader('Retry-After', String(result.retryAfterSec));
      sendPage(response, 429, enterPage(imLoginChannels(), { hasPassphrase: true, error: '当前登录请求过多，请稍后再试' }));
      return;
    }
    if (result.reason === 'locked') {
      response.setHeader('Retry-After', String(result.retryAfterSec));
      sendPage(response, 429, enterPage(imLoginChannels(), { hasPassphrase: true, error: '尝试次数过多，请稍后再试' }));
      return;
    }
    if (result.reason === 'invalid') {
      if (outside) loginLimit.failed(source);
      sendPage(response, 401, enterPage(imLoginChannels(), { hasPassphrase: true, error: '口令不正确，请重试' }));
      return;
    }
    sendPage(response, 404, enterPage(imLoginChannels(), { hasPassphrase: false }));
  }

  async function setPassphrase({ request, response }: Asked): Promise<void> {
    const { passphrase } = await readJson(request);
    requireSteady('设置主人口令');
    auth.setPassphrase(passphrase);
    sendJson(response, 200, { enabled: true });
  }

  function clearPassphrase({ response }: Asked): void {
    requireSteady('清除主人口令');
    auth.clearPassphrase();
    sendJson(response, 200, { enabled: false });
  }

  function redirectLogin(response: ServerResponse, cookie?: string | string[], location = '/'): void {
    response.writeHead(303, { ...(cookie ? { 'Set-Cookie': cookie } : {}), Location: location,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin' });
    response.end();
  }

  function pendingCredential(request: IncomingMessage): string | undefined {
    return (request.headers.cookie ?? '').split(';').map(pair => pair.trim().split('='))
      .find(([name]) => name === PENDING_COOKIE)?.[1];
  }

  function pendingCookie(outside: boolean, credential = '', remainingMs = 0): string {
    return `${PENDING_COOKIE}=${credential}; HttpOnly; SameSite=Strict; Path=${DEVICE_LOGIN}${outside ? '; Secure' : ''}; Max-Age=${Math.max(0, Math.floor(remainingMs / 1000))}`;
  }

  function beginDeviceLogin({ request, response, outside }: Asked): void {
    requireSameOrigin(request, outside);
    const source = forwardedFrom(request);
    if (outside && loginLimit.closed(source)) {
      sendPage(response, 429, tooManyPage());
      return;
    }
    // Creating a request is anonymous work, charged to the same quota as bad links.
    if (outside) loginLimit.failed(source);
    const created = auth.createDeviceLogin(outside, request.headers['user-agent'] ?? '', pendingCredential(request));
    if (!created) sendPage(response, 429, deviceLoginFullPage());
    else redirectLogin(response, pendingCookie(outside, created.credential, created.remaining_ms), DEVICE_LOGIN);
  }

  function waitDeviceLogin({ request, response, outside }: Asked): void {
    response.setHeader('Referrer-Policy', 'strict-origin');
    const result = auth.deviceLogin(pendingCredential(request) ?? '', outside);
    if (result.state === 'approved') redirectLogin(response, [result.cookie, pendingCookie(outside)]);
    else if (result.state === 'pending') sendPage(response, 200, waitDeviceLoginPage(result.request, imLoginChannels()));
    else {
      response.setHeader('Set-Cookie', pendingCookie(outside));
      sendPage(response, 410, endedDeviceLoginPage(result.state === 'rejected'));
    }
  }

  // The one place the owner lets something in by its six digits (nodes.md §1.1 step 2): a
  // device asking to log in, or a machine asking to join. The two keep their own numbers,
  // so one code can name both at once; then both are listed and the owner says which.
  function admissionsOf(code: unknown) {
    const device = auth.lookupDeviceLogin(code);
    const machine = options.nodes.pendingJoins().find((join) => join.code === code);
    return [
      ...(device ? [{ kind: 'device' as const, ...device }] : []),
      ...(machine ? [{ kind: 'machine' as const, ...machine }] : []),
    ];
  }

  async function admission({ request, response, visitor }: Asked & { visitor: Visitor }, action: 'lookup' | 'approve' | 'reject'): Promise<void> {
    const { code, kind, temporary = false } = await readJson(request);
    if (action === 'lookup') {
      const matches = admissionsOf(code);
      if (matches.length === 0) throw new HttpError(404, deviceLoginMissingText);
      sendJson(response, 200, { matches });
      return;
    }
    if (kind === 'device') {
      if (action === 'approve' && typeof temporary !== 'boolean') throw new InputError('temporary 应为布尔值');
      const found = auth.decideDeviceLogin(code, action === 'approve', { actor: `console:${visitor.id}` }, temporary === true);
      if (!found) throw new HttpError(404, deviceLoginMissingText);
      sendJson(response, 200, { kind, device: found.device, ...(action === 'approve' ? { duration_ms: found.duration_ms } : {}) });
      return;
    }
    if (kind !== 'machine') throw new InputError('kind 应为 device 或 machine');
    // The barrier is the hub's: a card's press meets the same one.
    const decided = options.nodes.decide({ code }, action === 'approve', { actor: CONSOLE_ACTOR });
    if (decided.state === 'approved') sendJson(response, 200, { kind, name: decided.join.name, machine: machineView(decided.machine) });
    else if (decided.state === 'rejected') sendJson(response, 200, { kind, name: decided.join.name });
    else throw new HttpError(404, joinMissingText);
  }

  // A read still works when the ledger cannot be written; only the summary suffers.
  function markSeen(id: string): void {
    try {
      auth.touch(id);
    } catch (err) {
      log(`写入上次打开时间失败：${String(err)}`);
    }
  }

  async function callTool(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Before the first await: the call belongs to the process whose token it shows, the turn
    // that process is in and so that turn's project, however long its body takes
    // (project-sessions §4). No turn, no reason in the audit trail.
    const admission = session.admitTool(shownToken(request));
    if ('refused' in admission) {
      sendJson(response, 200, { content: [{ type: 'text', text: admission.refused }], isError: true });
      return;
    }
    try {
      const { name, arguments: args } = await readJson(request);
      if (typeof name !== 'string') throw new HttpError(400, '缺少工具名');
      // Asked again right before it acts: the service may have gone degraded or into an
      // inventory, or the turn been interrupted, while the body was on its way (§3).
      const late = admission.recheck();
      if (late !== undefined) {
        sendJson(response, 200, { content: [{ type: 'text', text: late }], isError: true });
        return;
      }
      const { messageId, messageIds, projectId, contextId, redact } = admission;
      const toolCallId = ulid();
      const knownTool = tools.names.includes(name);
      ledger.startRouterCall({
        id: toolCallId, projectId, messageId, messageIds, contextId: contextId ?? null,
        name: knownTool ? name : '未知工具',
        request: knownTool ? routerCallText(args ?? {}, redact) : null,
      });
      const finish = (state: NonNullable<RouterCallTrace['result_state']>, text: string | null): void => {
        try {
          ledger.finishRouterCall(toolCallId, state, text);
        } catch {
          log(`记录负责人工具 ${toolCallId} 的返回失败`);
        }
      };
      try {
        const result = await tools.call(name, args, { actor: 'router', messageId, messageIds, toolCallId }, { projectId });
        const state = result.isError ? 'refused' : response.destroyed || request.socket.destroyed ? 'interrupted' : 'returned';
        const safeResult = result.isError ? null : routerCallText(result, redact);
        finish(state, safeResult);
        if (!response.destroyed) sendJson(response, 200, { ...result, _meta: { [ROUTER_RECEIPT]: toolCallId } });
      } catch (error) {
        finish('failed', null);
        throw error;
      }
    } finally {
      admission.done();
    }
  }

  // As the asking process's project sees them: a login's choices are that project's (§4).
  function listTools(request: IncomingMessage, response: ServerResponse): void {
    const projectId = session.projectOfToken(shownToken(request));
    if (projectId === undefined) throw new HttpError(401, '这个负责人进程已经不在了');
    sendJson(response, 200, { tools: tools.list({ projectId }) });
  }

  function requireDataDir(): string {
    const dir = options.dataDir ?? options.releases?.dataDir;
    if (!dir) throw new HttpError(500, '服务未配置数据目录，无法访问项目文件');
    return dir;
  }

  function hydrateMessages(messages: readonly MessageRow[]): (MessageRow & { attachments?: ProjectFileSummary[] })[] {
    const byProject = new Map<string, Set<string>>();
    const parsed = messages.map((msg) => {
      const ids = parseAttachmentIds(msg.attachments_json);
      if (ids.length > 0 && msg.project_id !== null) {
        let set = byProject.get(msg.project_id);
        if (!set) {
          set = new Set();
          byProject.set(msg.project_id, set);
        }
        for (const id of ids) set.add(id);
      }
      return { msg, ids };
    });
    if (byProject.size === 0) return [...messages];
    const filesByProject = new Map<string, Map<string, ProjectFileSummary>>();
    for (const [projectId, idSet] of byProject) {
      const rows = ledger.listProjectFilesByIds(projectId, [...idSet]);
      filesByProject.set(projectId, new Map(rows.map((row) => [row.id, toProjectFileSummary(row)])));
    }
    return parsed.map(({ msg, ids }) => {
      if (ids.length === 0 || msg.project_id === null) return msg;
      const lookup = filesByProject.get(msg.project_id);
      const attachments = ids
        .map((id) => lookup?.get(id))
        .filter((file): file is ProjectFileSummary => file !== undefined);
      return attachments.length > 0 ? { ...msg, attachments } : msg;
    });
  }

  const encodeRfc5987 = (name: string): string =>
    encodeURIComponent(name).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

  function listProjectFiles(response: ServerResponse, projectId: string): void {
    ledger.getProject(projectId);
    const files = ledger.listProjectFiles(projectId).map(toProjectFileSummary);
    sendJson(response, 200, { files });
  }

  async function uploadProjectFile(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    requireSteady('上传项目文件');
    ledger.getProject(projectId);
    const rawContentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : '';
    const baseContentType = rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';

    let name: string;
    let mime: string;
    let kind: ProjectFileKind;
    let summary: string | null = null;
    let bytes: Buffer;

    if (baseContentType === 'application/json' && request.headers['x-file-name'] === undefined) {
      const rawBody = await readBytes(request, MAX_PROJECT_FILE_BYTES + 1024 * 1024);
      let textBody: string;
      try {
        textBody = UTF8.decode(rawBody);
      } catch {
        throw new HttpError(400, '请求正文不是 UTF-8 编码，没有收下');
      }
      const body = parseObject(textBody);
      if (typeof body.name !== 'string' || body.name.trim() === '') throw new HttpError(400, '缺少文件名：name');
      if (typeof body.content !== 'string') throw new HttpError(400, '缺少文件内容：content');
      if (body.mime !== undefined && typeof body.mime !== 'string') throw new HttpError(400, 'mime 应为字符串');
      if (body.kind !== undefined && !isProjectFileKind(body.kind)) throw new HttpError(400, 'kind 只能是 upload、artifact 或 doc');
      if (body.summary !== undefined && body.summary !== null && typeof body.summary !== 'string') {
        throw new HttpError(400, 'summary 应为字符串');
      }
      name = normalizeProjectFileName(body.name);
      mime = normalizeProjectFileMime(body.mime as string | undefined, name);
      bytes = Buffer.from(body.content, 'utf8');
      if (bytes.length > MAX_PROJECT_FILE_BYTES) throw new HttpError(413, '文件大小超过上限（最大 15 MiB）');
      if (isRasterImageMime(mime) && bytes.length > MAX_IMAGE_FILE_BYTES) {
        throw new HttpError(413, '图片大小不能超过 10 MiB');
      }
      kind = (body.kind as ProjectFileKind | undefined) ?? (isPreviewableArtifactMime(mime) ? 'artifact' : 'upload');
      if (typeof body.summary === 'string' && body.summary.trim() !== '') {
        summary = body.summary.trim().slice(0, 500);
      }
    } else {
      bytes = await readBytes(request, MAX_PROJECT_FILE_BYTES);
      const rawFileNameHeader = request.headers['x-file-name'];
      const rawFileNameStr = Array.isArray(rawFileNameHeader) ? rawFileNameHeader[0] : rawFileNameHeader;
      let decodedName = 'upload.bin';
      if (typeof rawFileNameStr === 'string' && rawFileNameStr.trim() !== '') {
        try {
          decodedName = decodeURIComponent(rawFileNameStr);
        } catch {
          throw new HttpError(400, 'X-File-Name 编码不合法');
        }
      }
      name = normalizeProjectFileName(decodedName);
      const rawKindHeader = request.headers['x-file-kind'];
      const rawKind = (Array.isArray(rawKindHeader) ? rawKindHeader[0] : rawKindHeader)?.trim();
      if (rawKind !== undefined && rawKind !== '' && !isProjectFileKind(rawKind)) {
        throw new HttpError(400, 'X-File-Kind 只能是 upload、artifact 或 doc');
      }
      const rawSummaryHeader = request.headers['x-file-summary'];
      const rawSummary = Array.isArray(rawSummaryHeader) ? rawSummaryHeader[0] : rawSummaryHeader;
      if (typeof rawSummary === 'string' && rawSummary.trim() !== '') {
        try {
          const trimmed = decodeURIComponent(rawSummary).trim();
          summary = trimmed === '' ? null : trimmed.slice(0, 500);
        } catch {
          throw new HttpError(400, 'X-File-Summary 编码不合法');
        }
      }
      const rawMimeHeader = typeof request.headers['x-file-mime'] === 'string' ? request.headers['x-file-mime'].trim() : undefined;
      mime = normalizeProjectFileMime(rawMimeHeader || rawContentType, name);
      if (isRasterImageMime(mime) && bytes.length > MAX_IMAGE_FILE_BYTES) {
        throw new HttpError(413, '图片大小不能超过 10 MiB');
      }
      kind = rawKind && isProjectFileKind(rawKind) ? rawKind : (isPreviewableArtifactMime(mime) ? 'artifact' : 'upload');
    }

    const dataDir = requireDataDir();
    const fileId = ulid();
    const { size, sha256 } = writeProjectFileBytes(dataDir, projectId, fileId, bytes);
    let row;
    try {
      row = ledger.createProjectFile({
        id: fileId,
        projectId,
        name,
        mime,
        size,
        sha256,
        kind,
        origin: 'owner',
        summary,
      });
    } catch (err) {
      try {
        removeProjectFileBytes(dataDir, projectId, fileId);
      } catch {
        // Ignore cleanup failure when propagating ledger error.
      }
      throw err;
    }
    sendJson(response, 201, { file: toProjectFileSummary(row) });
  }

  function getProjectFileRaw(request: IncomingMessage, response: ServerResponse, projectId: string, fileId: string, url: URL): void {
    ledger.getProject(projectId);
    const file = ledger.getProjectFile(projectId, fileId);
    if (!file) throw new HttpError(404, '项目文件不存在');
    const dataDir = requireDataDir();
    const etag = `"${file.sha256}"`;
    const ifNoneMatch = request.headers['if-none-match'];
    const matchesEtag = typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag || tag.trim() === `W/${etag}`);
    if (matchesEtag) {
      response.writeHead(304, {
        'Content-Security-Policy': RAW_FILE_POLICY,
        'Cache-Control': 'private, no-cache',
        ETag: etag,
      });
      response.end();
      return;
    }
    const bytes = readProjectFileBytes(dataDir, projectId, file.id);
    if (bytes === null) throw new HttpError(404, '项目文件内容缺失');
    const forceDownload = url.searchParams.get('download') === '1';
    const headers: Record<string, string> = {
      'Content-Type': file.mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': RAW_FILE_POLICY,
      'Cache-Control': 'private, no-cache',
      ETag: etag,
    };
    if (forceDownload || !SAFE_INLINE_MIMES.has(file.mime)) {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeRfc5987(file.name)}`;
    }
    response.writeHead(200, headers);
    response.end(bytes);
  }

  function getProjectFilePreview(response: ServerResponse, projectId: string, fileId: string, url: URL): void {
    ledger.getProject(projectId);
    const file = ledger.getProjectFile(projectId, fileId);
    if (!file) throw new HttpError(404, '项目文件不存在');
    if (!isPreviewableArtifactMime(file.mime)) throw new HttpError(400, '该文件类型不支持沙箱预览');
    const bytes = readProjectFileBytes(requireDataDir(), projectId, file.id);
    if (bytes === null) throw new HttpError(404, '项目文件内容缺失');
    const themeParam = url.searchParams.get('theme');
    const themeHint = themeParam === 'light' || themeParam === 'dark' ? themeParam : undefined;
    const html = buildSandboxedPreviewHtml(bytes.toString('utf8'), file.mime, file.name, themeHint);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': ARTIFACT_PREVIEW_POLICY,
    });
    response.end(html);
  }

  function deleteProjectFile(response: ServerResponse, projectId: string, fileId: string): void {
    requireSteady('删除项目文件');
    ledger.getProject(projectId);
    const dataDir = requireDataDir();
    const existing = ledger.getProjectFile(projectId, fileId);
    if (!existing) throw new HttpError(404, '项目文件不存在');
    const staged = stageRemoveProjectFileBytes(dataDir, projectId, existing.id);
    let removed: ReturnType<typeof ledger.deleteProjectFile>;
    try {
      removed = ledger.deleteProjectFile(projectId, existing.id);
    } catch (err) {
      staged.rollback();
      throw err;
    }
    if (!removed) {
      staged.rollback();
      throw new HttpError(404, '项目文件不存在');
    }
    staged.commit();
    sendJson(response, 200, { deleted: true });
  }

  // Written on a project's page, it goes to that project's current segment; with no project it
  // waits for the owner to give it one, like any message that names none (project-sessions §2).
  async function postMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const rawText = body.text;
    if (rawText !== undefined && typeof rawText !== 'string') throw new HttpError(400, '消息内容应为文字');
    const text = rawText ?? '';
    const projectId = body.project_id;
    if (projectId !== undefined && (typeof projectId !== 'string' || projectId === '')) {
      throw new HttpError(400, 'project_id 要是一个项目编号');
    }
    const rawAttachmentIds = body.attachment_ids;
    let attachmentIds: string[] = [];
    if (rawAttachmentIds !== undefined) {
      if (!Array.isArray(rawAttachmentIds) || rawAttachmentIds.some((each) => typeof each !== 'string' || each.trim() === '')) {
        throw new HttpError(400, 'attachment_ids 应为非空字符串数组');
      }
      attachmentIds = [...new Set(rawAttachmentIds as string[])];
      if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
        throw new HttpError(400, `单条消息最多附带 ${MAX_MESSAGE_ATTACHMENTS} 个附件`);
      }
    }
    if (text.trim() === '' && attachmentIds.length === 0) throw new HttpError(400, '消息不能为空');
    if (attachmentIds.length > 0) {
      if (projectId === undefined) throw new HttpError(400, '带附件的消息必须指定项目：project_id');
      ledger.getProject(projectId);
      const found = ledger.listProjectFilesByIds(projectId, attachmentIds);
      if (found.length !== attachmentIds.length) {
        throw new HttpError(400, '存在无效或不属于当前项目的附件');
      }
    }
    const received = ledger.transaction(() => {
      const result = ledger.receiveMessage({
        channel: 'console',
        externalId: ulid(),
        actor: CONSOLE_ACTOR,
        text,
        ...(projectId === undefined ? {} : { projectId }),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      });
      if (projectId !== undefined && attachmentIds.length > 0) {
        ledger.linkProjectFilesToMessage(projectId, attachmentIds, result.id);
      }
      return result;
    });
    stream.publish('message', hydrateMessages([ledger.getMessage(received.id)])[0]);
    session.kick();
    sendJson(response, 201, received);
  }

  function pushTaskChanges(): void {
    for (const [id, subscription] of runSubscriptions) {
      if (ledger.getRun(id).state !== 'ended') continue;
      subscription.stop();
      runSubscriptions.delete(id);
    }
    if (stream.size === 0) {
      taskStates.clear();
      baselined = false;
      return;
    }
    if (ledger.dispatchConditions().paused === null) return;
    for (const { id, state } of ledger.listTasks()) {
      if (taskStates.get(id) === state) continue;
      taskStates.set(id, state);
      if (baselined) stream.publish('task', { id, state });
    }
    baselined = true;
  }

  // A start that was never confirmed can still arrive, whatever the Run is called now.
  function launchingRuns() {
    const licensed = ledger.listActiveRuns().filter((run) => run.state === 'launching' || unknownFrom(run) === 'launching');
    return licensed.map((run) => ({
      id: run.id,
      task_id: run.task_id,
      task_title: ledger.getTask(run.task_id).title,
      host: run.host,
      created_at: run.created_at,
      unconfirmed: run.state === 'unknown',
    }));
  }

  // §2: what the owner goes through after a restore. Run states are the inventory's result.
  function restoreView() {
    const mark = ledger.getRestore();
    if (!mark) return null;
    return {
      from: mark.from,
      backup_at: mark.backup_at,
      restored_at: mark.restored_at,
      held_tasks: ledger.restoreHeldTasks().map(({ id, title }) => ({ id, title })),
      unverified_messages: mark.message_ids.map((id) => {
        const { text, at } = ledger.getMessage(id);
        return { id, text, at, changes: ledger.listChanges({ messageId: id }).map((change) => ({ action: change.action, at: change.at })) };
      }),
      runs: mark.run_ids.map((id) => {
        const { task_id, host, state, exit_kind } = ledger.getRun(id);
        return { id, task_id, task_title: ledger.getTask(task_id).title, host, state, exit_kind };
      }),
      // The name captured when each missing login ran; a later namesake is a different login.
      missing_logins: [...new Set(ledger.listActiveRuns().filter(loginMissing).map((run) => run.login_name))],
      missing_credentials: options.accounts.list().filter(({ credential }) => credential === 'missing').map(({ id, name }) => ({ id, name })),
      orphan_runs: options.orphans?.() ?? [],
    };
  }

  // The page has to be told about a retired connection, and the connection is what
  // the rest of this would read from.
  function stateOf() {
    const dispatch = ledger.dispatchConditions();
    const reachable = dispatch.paused !== null;
    return {
      version: options.releases.version,
      locale: normalizeLocale(options.settings.get('ui.locale')),
      dispatch,
      router: session.status(),
      active_runs: reachable ? ledger.listActiveRuns().length : null,
      // §5: already past the check, so these may still start after the pause.
      launching_runs: dispatch.paused ? launchingRuns() : [],
      channels: options.channels?.() ?? { wecom: null },
      gateway: options.gateway?.() ?? { state: 'off', since: null, error: null },
      outbox: reachable ? ledger.outbox.counts() : null,
      restore: reachable ? restoreView() : null,
      backup: options.backup.status(),
    };
  }

  function routerTurn({ response, url, params: [messageId] }: Asked): void {
    const message = ledger.getMessage(messageId!);
    if (message.direction !== 'in' || message.project_id === null) throw new HttpError(404, '没有这条项目消息的回合');
    const after = url.searchParams.get('after');
    if (after !== null && !/^[0-9A-Z]{26}$/.test(after)) throw new InputError('无效的调用游标');
    sendJson(response, 200, ledger.routerTurnTrace(message.project_id, message.id, after));
  }

  function changesOf(messageId: string): unknown {
    ledger.getMessage(messageId);
    const changes = ledger.listChanges({ messageId });
    const ids = changes.flatMap(({ action, task_id }) => (action === 'task.create' && task_id ? [task_id] : []));
    return { changes, tasks: ids.length ? ledger.listTaskSummaries({ ids }).map((task) => present(task)) : [] };
  }

  function approvalCards(state: string | null): unknown {
    return ledger.listApprovalCards(state === null ? {} : { state }).map((card) => ({
      id: card.id,
      created_at: card.created_at,
      task_id: card.task_id,
      task_title: card.task_title,
      // A project's conversation shows its own questions.
      project_id: card.project_id,
      review_task_id: card.review_task_id ?? null,
      state: card.state,
      questions: JSON.parse(card.questions_json),
      answers: card.answers_json === null ? null : JSON.parse(card.answers_json),
      answered_via: card.answered_via,
      decided_at: card.decided_at,
    }));
  }

  function archivedProjectIds(): Set<string> {
    return new Set(ledger.listProjects().filter(({ archived_at }) => archived_at !== null).map(({ id }) => id));
  }

  function summary({ last_seen_at: since }: ConsoleSession): unknown {
    const archived = archivedProjectIds();
    const visible = (projectId: string | null | undefined): boolean => projectId == null || !archived.has(projectId);
    const all = ledger.listTasks().filter(({ project_id }) => visible(project_id));
    const approvals = ledger.listApprovalCards().filter((card) => visible(card.project_id));
    const summarize = workSummaries(all, approvals);
    const works = ledger.listTaskSummaries({ top: true })
      .filter(({ project_id }) => visible(project_id))
      .map((work) => ({ ...work, summary: summarize(work.id) }));
    return {
      since,
      delivered: works.filter(({ state, summary: s, updated_at }) => {
        const latestAt = s.ended_at && s.ended_at > updated_at ? s.ended_at : updated_at;
        return (s.dot === 'ready' || (s.dot === 'done' && state !== 'abandoned' && (s.counts.done ?? 0) > 0)) && latestAt > since;
      }).length,
      running: works.filter(({ summary: s }) => s.dot === 'running' || s.dot === 'needs_verification').length,
      waiting: works.filter(({ summary: s }) => s.dot === 'waiting_person').length,
    };
  }

  async function answer(request: IncomingMessage, response: ServerResponse, approvalId: string): Promise<void> {
    const { answers } = await readJson(request);
    if (!Array.isArray(answers)) throw new HttpError(400, '缺少 answers');
    const result = ledger.answerApproval(approvalId, answers, CONSOLE_ACTOR, 'console');
    if (result.status === 'closed') throw new HttpError(409, '问题已关闭');
    sendJson(response, 200, result);
  }

  function runView({ snapshot_json, ...run }: ReturnType<Ledger['getRun']>) {
    const snapshot = JSON.parse(snapshot_json);
    return {
      ...run,
      executor: typeof snapshot.executor === 'string' ? snapshot.executor : null,
      placed_by: options.ledger.placementOf(run.id) ?? null,
      receipt: run.receipt_json === null ? null : JSON.parse(run.receipt_json),
      report_files: reportFilesOf(run, ledger.runReport(run.id)),
      error: runErrorView(run, (id) => options.logins.get(id)?.name),
    };
  }

  // Review on a Task's page (roles-and-tiers.md §4, §6): for a review, what it is bound to
  // and what it concluded; for any Task, the reviews of it, why it cannot be accepted yet,
  // and the times a rejection moved it up a tier. All as the ledger holds it.
  function reviewView(task: ReturnType<Ledger['getTask']>) {
    const verdictOf = (row: ReturnType<Ledger['getTask']>): VerdictRecord | null => (row.verdict_json === null ? null : JSON.parse(row.verdict_json));
    const binding = parseReviewOf(task.review_of_json);
    const reviewed = binding === null ? null : ledger.getTask(binding.task_id);
    return {
      of: binding === null ? null : { ...binding, reviewed_title: reviewed!.title, reviewed_state: reviewed!.state },
      verdict: verdictOf(task),
      reviews: ledger.reviewsOf(task.id).map((review) => ({ id: review.id, title: review.title, state: review.state, reason: review.reason, verdict: verdictOf(review) })),
      // What the round that made the current product ran as asks, not what the Task is now.
      needs_review: ledger.currentProduct(task.id).needsReview,
      blocked: task.state === 'ready' ? ledger.reviewGate(task.id) : null,
      gate: task.state === 'ready' ? ledger.reviewGateInfo(task.id) : null,
      escalations: ledger.listChanges({ taskId: task.id }).filter(({ action }) => action === 'task.escalate')
        .map(({ at, detail_json }) => ({ at, ...(JSON.parse(detail_json ?? '{}') as { review_task_id: string; from: string; to: string }) })),
    };
  }

  function taskDeliverables(task: TaskRow, runs: readonly RunRow[]): ProjectFileSummary[] {
    if (!task.project_id) return [];
    const taskTag = `[task:${task.id}]`;
    const runTags = runs.map((run) => `[run:${run.id}]`);
    return ledger
      .listProjectFiles(task.project_id)
      .filter(
        (row) =>
          row.origin === 'worker' &&
          row.summary !== null &&
          (row.summary.includes(taskTag) || runTags.some((tag) => row.summary!.includes(tag))),
      )
      .map(toProjectFileSummary);
  }

  function dispatchInfoOf(task: TaskRow, runs: readonly RunRow[]): {
    latest_login: string | null;
    latest_machine: string | null;
    failover_note: string | null;
  } {
    const latestRun = runs.at(-1);
    const loginDisplay = (run: RunRow | undefined): string | null => {
      if (!run) return null;
      if (run.login_name) return run.login_name;
      if (run.login_id) return options.logins.get(run.login_id)?.name ?? run.login_id;
      return null;
    };
    const isQuotaRun = (run: RunRow): boolean => {
      if (run.exit_kind === 'quota') return true;
      if (run.error_json) {
        try {
          const parsed = JSON.parse(run.error_json) as { quota?: unknown; reason?: unknown };
          if (parsed?.quota) return true;
          if (typeof parsed?.reason === 'string' && /quota|rate.?limit|额度|限流|429/i.test(parsed.reason)) return true;
        } catch {
          // ignore malformed json
        }
      }
      return false;
    };
    const loginKey = (run: RunRow): string | null => run.login_id ?? run.login_name ?? null;

    const latest_login = loginDisplay(latestRun);
    const latest_machine = latestRun?.machine_id ?? (latestRun?.host ? latestRun.host : null);
    let failover_note: string | null = null;

    if (latestRun) {
      if (isQuotaRun(latestRun) && task.state !== 'done' && task.state !== 'abandoned') {
        const oldName = loginDisplay(latestRun) ?? '当前账号';
        failover_note = `上一轮因账号 ${oldName} 触达额度上限，正在等待额度恢复或切换可用账号`;
      } else if (runs.length >= 2) {
        const prevQuotaRun = runs.slice(0, -1).findLast(isQuotaRun);
        if (prevQuotaRun) {
          const oldKey = loginKey(prevQuotaRun);
          const newKey = loginKey(latestRun);
          if (oldKey !== null && newKey !== null && oldKey !== newKey) {
            const oldName = loginDisplay(prevQuotaRun) ?? oldKey;
            const newName = loginDisplay(latestRun) ?? newKey;
            failover_note = `上一轮因账号 ${oldName} 触达额度上限，已自动切换至 ${newName} 继续执行`;
          }
        }
      }
    }
    return { latest_login, latest_machine, failover_note };
  }

  function taskPage(taskId: string): unknown {
    const task = ledger.getTask(taskId);
    const runs = ledger.listRuns(taskId);
    let work = task;
    while (work.parent_id !== null) work = ledger.getTask(work.parent_id);
    const routerStatus = session.status() as {
      turn?: string | null;
      resting_until?: string | null;
      projects?: { project_id: string; turn?: string | null; resting_until?: string | null }[];
    };
    const projectRouter = task.project_id === null
      ? undefined
      : routerStatus.projects?.find((each) => each.project_id === task.project_id);
    const projectAccount = task.project_id === null ? null : ledger.getProject(task.project_id).router_account;
    const fallbackRestingMs = projectAccount ? restingUntil(ledger.loginState(projectAccount), Date.now()) : undefined;
    const resting_until = projectRouter?.resting_until
      ?? routerStatus.resting_until
      ?? (fallbackRestingMs !== undefined ? new Date(fallbackRestingMs).toISOString() : null);
    const activeRev = task.state === 'ready' ? ledger.activeReview(task.id) : null;
    return {
      task: { ...present(task), summary: workSummary(task.id) },
      // The role as it is now; a Run's snapshot holds the one that round ran as.
      role: task.role_id === null ? null : roles.get(task.role_id) ?? null,
      review: reviewView(task),
      landable: landableOf(ledger, task),
      dispatch_info: dispatchInfoOf(task, runs),
      automation: {
        router_busy: Boolean(projectRouter?.turn ?? (task.project_id === null ? routerStatus.turn : null)),
        resting_until,
        active_review_id: activeRev?.id ?? null,
        active_review_state: activeRev?.state ?? null,
      },
      // A gate or curation Task belongs to no project: what it works on, the project it came from
      // and the projects its material carries (knowledge §3).
      knowledge: ledger.knowledgeTaskView(task.id),
      // The skills it names (knowledge §4.1), as they are now: one retired since stops its next round.
      skills: namedSkillsOf(task).map((id) => {
        const entry = isDirectorySkillId(id) ? ledger.getDirectorySkillEntry(id) : ledger.getEntry(id);
        return entry === undefined ? { id, title: null, revision: null, state: null } : { id, title: entry.title, revision: entry.revision, state: entry.state };
      }),
      summary: workSummary(task.id),
      work: { ...present(work), summary: workSummary(work.id) },
      children: ledger.listTasks().filter(({ parent_id }) => parent_id === taskId).map((child) => ({
        ...present(child),
        summary: workSummary(child.id),
        latest_run: ledger.listRuns(child.id).map(runView).at(-1) ?? null,
      })),
      runs: runs.map(runView),
      inputs: ledger.listInputs(taskId),
      releases: releaseView(taskId),
      deliverables: taskDeliverables(task, runs),
      approvals: ledger.listApprovals(taskId).map((approval) => ({
        ...approval,
        questions: JSON.parse(approval.questions_json),
        answers: approval.answers_json === null ? null : JSON.parse(approval.answers_json),
      })),
    };
  }

  function overview(): unknown {
    const archived = archivedProjectIds();
    const visible = (projectId: string | null | undefined): boolean => projectId == null || !archived.has(projectId);
    const { all, works: listed } = listWorks();
    const activeListed = listed.filter(({ project_id }) => visible(project_id));
    const tasks = new Map(all.filter(({ parent_id }) => parent_id === null).map((task) => [task.id, task]));
    const works = currentWorks(activeListed).map((work) => ({
      ...tasks.get(work.id)!,
      ...present(work),
      latest_run: ledger.listRuns(work.id).map(runView).at(-1) ?? null,
    }));
    const moving = works.filter(({ summary }) => [...MOVING].some((state) => summary.counts[state]) || Boolean(summary.counts.in_review));
    const openCards = ledger.listApprovalCards({ state: 'open' }).filter((card) => visible(card.project_id));
    const openCardTaskIds = new Set(openCards.map((card) => card.task_id));
    const approvals = (approvalCards('open') as { project_id?: string | null }[]).filter((card) => visible(card.project_id));
    const waiting = ledger.listTasks({ states: ['waiting_person'] }).filter((task) => visible(task.project_id));
    const parkedWaiting = waiting.filter((task) => !openCardTaskIds.has(task.id));
    const waitingIds = new Set([...openCardTaskIds, ...parkedWaiting.map((task) => task.id)]);
    const knowledgeAwaiting = ledger.listProposals({ state: 'awaiting_owner' }).length;
    const pendingJoins = options.nodes.pendingJoins().length;
    const taskTitleById = new Map(all.map((task) => [task.id, task.title]));
    const outboxFailures = ledger.outbox.listGivenUp().map((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as { task_id?: unknown };
        const taskId = typeof payload?.task_id === 'string' ? payload.task_id : null;
        const task_title = taskId ? (taskTitleById.get(taskId) ?? null) : null;
        return task_title ? { ...row, task_title } : row;
      } catch {
        return row;
      }
    });
    const state = stateOf();
    return {
      counts: {
        waiting: waitingIds.size,
        moving: moving.length,
        ready: works.filter(({ summary }) => summary.dot === 'ready').length,
        knowledge_awaiting: knowledgeAwaiting,
        pending_joins: pendingJoins,
      },
      // §5: the one case about machines the rules cannot handle. A login short of
      // machines for less than the grace period is only a queue that waits.
      no_machine: waitingLogins().filter(({ overdue }) => overdue),
      // §5: a project with no usable login can run nothing, and no machine can change that.
      // The ledger's own pool derivation says which, and why (service/ledger.ts).
      no_login: ledger.projectsWithoutLogins(),
      launching: state.launching_runs,
      outbox: { ...ledger.outbox.counts(), failures: outboxFailures },
      approvals,
      parked_waiting: parkedWaiting.map((task) => present(task)),
      moving,
      // Stopped work moves only on the owner's or the router's word, so it is listed
      // with what needs the owner, not with what has ended.
      held: works.filter(({ summary }) => summary.dot === 'held').map((work) => ({
        ...work,
        stopped_at: ledger.listChanges({ taskId: work.id }).findLast(({ action }) => action === 'task.hold')?.at
          ?? work.latest_run?.ended_at ?? null,
      })).sort((a, b) => (b.stopped_at ?? '').localeCompare(a.stopped_at ?? '')),
      recent: works.filter(ended).sort(byEnding).map((work) => ({
        ...work,
        finished_at: work.summary.ended_at ?? work.latest_run?.ended_at ?? null,
      })),
      state,
      restore: state.restore,
      backup: state.backup,
    };
  }

  // Serialize review requests for one product, including the artifact registration.
  const reviewRequests = new Map<string, Promise<string>>();
  async function requestReview(taskId: string): Promise<string> {
    const existing = reviewRequests.get(taskId);
    if (existing) return existing;
    const request = (async () => {
      const task = ledger.getTask(taskId);
      if (task.state !== 'ready' || task.project_id === null) throw new InputError('任务不在待验收状态');
      const active = () => activeReview(taskId);
      const prior = active();
      if (prior) return prior.id;
      if (!ledger.reviewGate(taskId)) throw new InputError('当前产物不需要审阅');
      const registered = await options.accept.register(taskId);
      return ledger.transaction(() => {
        const current = active();
        if (current) return current.id;
        const review = ledger.createTask({ projectId: task.project_id, title: `审阅：${task.title}`, goal: '独立审阅当前产物', acceptance: '交付审阅结论', roleId: 'review', reviewOf: { taskId, ...registered } }, { actor: CONSOLE_ACTOR });
        ledger.queueTask(review.id, { actor: CONSOLE_ACTOR });
        return review.id;
      });
    })();
    reviewRequests.set(taskId, request);
    try { return await request; } finally { reviewRequests.delete(taskId); }
  }

  async function taskAction(request: IncomingMessage, response: ServerResponse, taskId: string, action: string): Promise<void> {
    ledger.getTask(taskId);
    const ctx = { actor: CONSOLE_ACTOR };
    if (action === 'review') {
      sendJson(response, 200, { task_id: await requestReview(taskId) });
      return;
    }
    if (action === 'integrate') {
      const result = createLandingTask(ledger, taskId, ctx);
      sendJson(response, result.made ? 201 : 200, {
        made: result.made,
        task_id: result.child.id,
        pr: result.pr,
        commit: result.commit,
      });
      return;
    }
    if (action === 'hold') {
      const body = await readJsonOrNone(request);
      if (body.reason !== undefined && typeof body.reason !== 'string') throw new InputError('暂停理由要是字符串');
      const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : '主人暂停';
      ledger.holdTask(taskId, reason, ctx);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (action === 'interrupt') {
      const run = ledger.listActiveRuns().find((active) => active.task_id === taskId);
      if (!run) throw new InputError(`任务 ${taskId} 没有未结束的 Run`);
      if (!options.runner) throw new HttpError(503, '执行服务不可用');
      const verdict = await options.runner.interrupt(run, ctx);
      sendJson(response, 200, { run_id: run.id, verdict });
      return;
    }
    const body = action === 'resume' ? {} : await readJson(request);
    // What accepting brought back, when there was anything to bring: the answer says so.
    let artifacts: { stored: string[]; problem: string | null } | null = null;
    switch (action) {
      case 'resume':
        ledger.resumeTask(taskId, ctx);
        break;
      case 'abandon': {
        if (body.reason !== undefined && typeof body.reason !== 'string') throw new InputError('放弃理由要是字符串');
        const reason = body.reason ?? '';
        // The Runner knows what to do about a Run out of contact; without one there
        // is no such Run to ask about.
        if (options.runner) await options.runner.abandon(taskId, reason, ctx);
        else ledger.abandonTask(taskId, reason, ctx);
        break;
      }
      case 'accept': {
        if (body.basis !== undefined && typeof body.basis !== 'string') throw new InputError('验收依据要是字符串');
        const basis = body.basis ?? '';
        // Accepting is when the Run's own files come back to this machine: what it left
        // under artifacts/ is taken over the read channel the events come by, so that
        // the page can offer it as the next release. The ledger decides first — a Task
        // that cannot be accepted touches no machine — and the release record is written
        // only for an acceptance that happened.
        // "不经审阅验收" is the owner's alone (roles-and-tiers.md §4): the page asks for it in
        // so many words, and the ledger writes it on the timeline.
        if (body.without_review !== undefined && typeof body.without_review !== 'boolean') throw new InputError('without_review 要是 true 或 false');
        artifacts = await options.accept.accept(taskId, basis, ctx, body.without_review === true ? { withoutReview: true } : {});
        break;
      }
      case 'rework': {
        if (typeof body.note !== 'string') throw new InputError('退回说明不能为空');
        // Optional optimistic lock: when supplied, refuse notes written against an older revision.
        if (body.revision !== undefined && !Number.isInteger(body.revision)) throw new InputError('revision 要是整数');
        const id = ledger.reworkTask(taskId, body.note, body.revision as number | undefined, ctx);
        sendJson(response, 201, { id, task: ledger.getTask(taskId) });
        return;
      }
      case 'continue': {
        if (typeof body.note !== 'string' || body.note.trim() === '') throw new InputError('后续指令不能为空');
        if (body.revision !== undefined && !Number.isInteger(body.revision)) throw new InputError('revision 要是整数');
        const res = ledger.continueTask(taskId, body.note, body.revision as number | undefined, ctx);
        sendJson(response, 201, { id: res.id, queued: res.queued, active: res.active, task: ledger.getTask(taskId) });
        return;
      }
      case 'inputs': {
        if (typeof body.text !== 'string') throw new InputError('内容不能为空');
        const id = ledger.addInput(taskId, body.text, ctx);
        session.kick();
        sendJson(response, 201, { id });
        return;
      }
    }
    sendJson(response, 200, { task: ledger.getTask(taskId), ...(artifacts === null ? {} : { artifacts }) });
  }

  // What the page offers to put in place, and how the last time went. An upgrade is
  // about the program rather than the Task, so the outcome is the service's own. What
  // came back for this Task — or why nothing did — is what the ledger holds of its rounds:
  // each round's registration, and nothing on disk that no registration names.
  function releaseView(taskId: string): unknown {
    const last = options.releases.last();
    const intent = options.releases.intent();
    const held = ledger.artifactsOf(taskId);
    const mine = releasesOf(options.releases.dataDir, held);
    const newest = held[0];
    return {
      version: options.releases.version,
      last,
      // An intent no result has answered: still being done, or asked for and never
      // finished. Which of the two it is, is `attempting`.
      intent: intent !== null && (last === null || last.at < intent.at) ? intent : null,
      attempting: options.releases.attempting(),
      // The newest round's artifacts, both halves: the registration in use, and the last
      // taking since it that failed. A failed re-taking keeps the earlier product in use,
      // and is said all the same, with the way to ask again. A round the retention rule
      // cleared has no registration on disk to describe.
      fetch: newest === undefined || newest.releases_dropped_at !== null || (newest.registration === null && newest.problem === null) ? null : {
        registered: newest.registration === null ? null : { at: newest.registration.at, files: newest.registration.files.map((file) => file.name) },
        failed: newest.problem,
      },
      // The rounds whose registered copies the retention rule cleared: the page says so, and
      // offers nothing of them (docs/design/phase1-design.md "已结束的工作").
      dropped: mine.flatMap((release) => release.dropped_at === null ? [] : [{ run_id: release.run_id, at: release.dropped_at }]),
      packages: mine.flatMap((release) => release.packages.map((each) => ({ run_id: release.run_id, at: release.at, ...each }))),
    };
  }

  // What the page names: the package the owner confirmed, by the name, digest and size it
  // showed. Nothing else is started, and the service is not stopped here — the command
  // that is started stops it, after the turn being handled has finished.
  async function launchRelease({ request, response, url, params, visitor }: Asked & { visitor: Visitor }): Promise<void> {
    if (url.searchParams.get('confirm') !== '1') throw new InputError('上线要先确认：接口要带 ?confirm=1');
    const chosen = await readJsonOrNone(request);
    const { name, sha256, bytes } = chosen;
    if (typeof name !== 'string' || typeof sha256 !== 'string' || !Number.isInteger(bytes)) {
      throw new InputError('要说明上哪一个包：name、sha256、bytes');
    }
    const launched = options.releases.launch(params[0]!, { name, sha256, bytes: bytes as number }, { actor: `console:${visitor.id}` });
    // `started: false` is one release already under way: the answer is its state, not a
    // second one.
    sendJson(response, 202, { ...launched });
  }

  // Fetching again for a Task that was accepted while its machine was out of reach: the
  // problem is kept in the release record, and this is the way out of it.
  async function refetchArtifacts({ response, params }: Asked): Promise<void> {
    sendJson(response, 200, await options.accept.refetch(params[0]!));
  }

  // Pulling visual/document deliverables from the latest ended Run into project files on demand,
  // including before the owner clicks Accept.
  async function syncTaskDeliverables({ response, params }: Asked): Promise<void> {
    const taskId = params[0]!;
    ledger.getTask(taskId);
    if (!options.deliverables) throw new HttpError(503, '产物自动拉取服务不可用');
    sendJson(response, 200, await options.deliverables.ingestTask(taskId));
  }

  async function putDispatchSlots(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    if (typeof body.tier !== 'string' || !isTierId(body.tier)) {
      throw new InputError('请指定有效的档位（operate / execute / decide）');
    }
    const isStringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === 'string');
    if (
      (body.p1 !== undefined && !isStringArray(body.p1))
      || (body.p2 !== undefined && !isStringArray(body.p2))
      || (body.off !== undefined && !isStringArray(body.off))
    ) {
      throw new InputError('派发槽位 p1 / p2 / off 必须是字符串数组');
    }
    const normalized = normalizeTierSlots({ p1: body.p1, p2: body.p2, off: body.off });
    if (!normalized) throw new InputError('派发槽位格式不正确');
    const saved = ledger.setTierDispatchSlots(body.tier, normalized);
    options.settings.set(dispatchOrderKey(body.tier), saved.order, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, {
      dispatch_slots: saved.slots,
      dispatch_order: Object.fromEntries(TIER_IDS.map((tier) => [tier, options.ledger.loginOrder(tier)])),
    });
  }

  async function changeSetting(request: IncomingMessage, response: ServerResponse, name: string): Promise<void> {
    const ctx = { actor: CONSOLE_ACTOR };
    const key = settingKey(name);
    if (request.method === 'DELETE') options.settings.reset(key, ctx);
    // The value's type is the caller's claim; set() checks it.
    else options.settings.set(key, (await readJson(request)).value as SettingValue<SettingKey>, ctx);
    sendJson(response, 200, { settings: options.settings.list() });
  }

  // The queued Tasks a login may be given: those pinned to it and those that name no
  // login and could run as it (respecting project overrides and disabled priority slots).
  function queuedFor(loginId: string): number {
    const globalSlots = ledger.dispatchSlots();
    return ledger.listTasks({ states: ['queued'] }).filter((task) => {
      if (task.login_id !== null && ledger.loginRefusal(task, task.login_id) !== undefined) return false;
      const candidates = candidateLogins(task, ledger.loginPool(task).ids, options.logins, undefined, ledger.loginOrder(task.tier, task.project_id));
      const matched = candidates.find(({ id }) => id === loginId);
      if (!matched) return false;
      if (task.login_id !== null || task.tier === null || !isTierId(task.tier)) return true;
      const projSlots = task.project_id !== null ? ledger.projectDispatchSlots(task.project_id) : null;
      const projOrder = task.project_id !== null ? ledger.projectDispatchOrder(task.project_id) : null;
      const tierSlots = projSlots?.[task.tier]
        ?? (projOrder?.[task.tier] && projOrder[task.tier]!.length > 0 ? undefined : globalSlots?.[task.tier]);
      if (!tierSlots) return true;
      const routeLabel = matched.machine ? (ledger.loginState(matched.id)?.identity?.routeLabel ?? null) : null;
      const route = matched.machine ? effectiveRouteOfLogin({ routeLabel, tiers: matched.tiers }, task.tier) : null;
      return slotForLogin({ id: matched.id, executor: matched.executor, machine: matched.machine, route }, tierSlots, [], task.tier) !== 'off';
    }).length;
  }

  // Every tier goes out as the value the ledger holds, kind and all: a page that cannot
  // tell content from a place on the machine would write one back as the other. A bare
  // string is still taken on the way in as the place it always was.
  function accountView(account: AccountRecord) {
    const now = (options.now ?? Date.now)();
    // When the token this account holds came in, and when it is expected to run out: the
    // derivation the scan and the self-check use is the ledger's (docs/design/native-login.md
    // §2), so the page cannot add the days by a rule of its own. Both are null when nothing
    // recorded the moment or nothing declares a lifetime. Never a guess from the account's age.
    const { credentialAt, expected } = ledger.accountExpiry(account.id);
    const identity = ledger.loginState(account.id).identity;
    return {
      id: account.id,
      name: account.name,
      executor: account.executor,
      account_label: identity.accountLabel ?? null,
      plan_label: identity.planLabel ?? null,
      credential: account.credential ?? 'set',
      signed_in: account.signedIn === true,
      credential_at: credentialAt,
      expected_expiry: expected,
      // Whether this account may be the Router: the settings page lists only these.
      can_route: account.canRoute === true,
      tiers: { ...account.tiers },
      // Tiers held in a shape no round can be given, said as the ledger read them (shared/logins.ts).
      ...(account.retiredTiers ? { retired_tiers: account.retiredTiers } : {}),
      permission_mode: account.permissionMode ?? null,
      timeout_ms: account.timeoutMs ?? null,
      max_runs: account.maxRuns ?? null,
      // The line it is, for an executor whose account is one; its key is not in it.
      provider: account.provider ?? null,
      // What the executor last reported it may use, and when that was read. Nothing here
      // is what the owner set.
      models: options.models?.state(account.id) ?? { list: [], at: null, refreshing: false },
      // What the service has learned by using it; none of it is the owner's to set.
      status: loginStatus(ledger, account, now),
      created_at: account.created_at,
      updated_at: account.updated_at,
      queued_tasks: queuedFor(account.id),
    };
  }

  // Every login and what its executor last said of its quota, with whether it can be asked
  // now (docs/design/usage.md §3). The figures are the same ones the accounts page and the
  // pick read: one place holds them, this only says how fresh they are and how to refresh.
  const NO_QUOTA_READ = '没有可以读额度的地方';
  // A machine's own login is asked on its machine, by that machine's client (Adapter.machineQuota,
  // docs/design/usage.md §3). An executor with no such declaration offers none; one whose machine
  // is away can be asked again once it is back. The last reading and the last failure are the
  // machine's own, from the report it sent: the figures beside them are the ledger's.
  const EXECUTOR_NO_QUOTA = '这个执行器不提供用量';
  const machineQuotaRefusal = (executor: string, machine: string, rejected: boolean): string | undefined => {
    if (options.accounts.machineQuotaOffered?.(executor) === false) return EXECUTOR_NO_QUOTA;
    const reported = options.nodes.reportedExecutors(machine)?.executors.find((each) => each.executor === executor);
    if (rejected || reported?.logged_in === false) return NEEDS_LOGIN_TEXT;
    if (reported?.installed === false) return '这台机器没有找到这个执行器';
    if (reported?.unusable !== undefined) return reported.unusable;
    return options.nodes.connected(machine) ? undefined : '这台机器不在线，等它连回来才能读';
  };
  // What the machine last said about this login's quota: when it read it and, when it read
  // nothing, why. Both are the report's, so a reading that never arrived shows as none.
  const machineQuotaReads = new Map<string, { started: number; deadline: number; previous: number }>();
  const machineQuotaKey = (machine: string, executor: string) => JSON.stringify([machine, executor]);
  const machineQuotaState = (machine: string, executor: string) => {
    const quota = options.nodes.reportedExecutors(machine)?.executors.find((each) => each.executor === executor)?.quota;
    const key = machineQuotaKey(machine, executor);
    const pending = machineQuotaReads.get(key);
    const now = (options.now ?? Date.now)();
    if (pending && (now >= pending.deadline || (quota && Date.parse(quota.at) > Math.max(pending.started, pending.previous)))) machineQuotaReads.delete(key);
    return {
      reading: machineQuotaReads.has(key), tried_at: quota?.at ?? null, failure: quota?.error ?? null,
      ...(quota?.absent === true ? { limited: '这次没有读到额度窗口，留着上次的读数' } : {}),
    };
  };
  const groupLogins = <T extends { login_id: string; executor: string; machine: string | null }>(rows: T[]): T[][] => {
    // A machine probe can establish that an organization belongs to a personal subscription.
    // The stored account's API alone cannot distinguish a shared organization.
    const matchKey = (row: T): string | undefined => {
      const identity = ledger.loginState(row.login_id).identity;
      const organization = organizationIdOf(identity.organizationId);
      if (organization !== undefined) return JSON.stringify([row.executor, 'org', organization]);
      if (typeof identity.quotaOwner === 'string' && identity.quotaOwner !== '') {
        return JSON.stringify([row.executor, 'owner', identity.quotaOwner]);
      }
      return undefined;
    };
    const personal = new Set(rows.filter((row) => row.machine !== null).map(matchKey));
    const groups = new Map<string, T[]>();
    for (const row of rows) {
      const match = matchKey(row);
      const key = match !== undefined && personal.has(match) ? match : row.login_id;
      const held = groups.get(key);
      if (held === undefined) groups.set(key, [row]);
      else held.push(row);
    }
    return [...groups.values()];
  };
  // Every login the page shows, already in its group. The rows are raw (one login each) so that
  // the page can merge them and a refresh can pick the one member to ask.
  const quotaGroups = (now: number): QuotaLogin[][] => {
    const telemetryMap = typeof ledger.recentLoginTelemetry === 'function' ? ledger.recentLoginTelemetry(now) : {};
    const rows: QuotaLogin[] = [];
    for (const account of options.accounts.list()) {
      const refusal = options.quota ? options.quota.refusal(account) : NO_QUOTA_READ;
      const telemetry = telemetryMap[account.id] ?? null;
      rows.push({
        login_id: account.id, name: account.name, machine: null, executor: account.executor,
        status: loginStatus(ledger, account, now),
        read: { available: refusal === undefined, ...(refusal === undefined ? {} : { why: refusal }), ...(options.quota?.state(account.id) ?? { reading: false, tried_at: null, failure: null, limited: null, retry_at: null }) },
        ...(telemetry ? { telemetry } : {}),
      });
    }
    for (const login of options.logins.machineLogins()) {
      const status = loginStatus(ledger, login, now);
      const refusal = machineQuotaRefusal(login.executor, login.machine, status.rejected === true);
      const telemetry = telemetryMap[login.id] ?? null;
      rows.push({
        login_id: login.id, name: login.name, machine: login.machine, executor: login.executor,
        status: refusal === NEEDS_LOGIN_TEXT ? { ...status, rejected: true } : status,
        read: { available: refusal === undefined, ...(refusal === undefined ? {} : { why: refusal }), ...machineQuotaState(login.machine, login.executor) },
        ...(telemetry ? { telemetry } : {}),
      });
    }
    return groupLogins(rows);
  };

  const refreshTarget = (members: QuotaLogin[]): QuotaLogin | undefined =>
    members.find((row) => row.machine !== null && row.read.available) ?? members.find((row) => row.read.available);

  const sumQuotaTelemetry = (members: readonly QuotaLogin[]) => {
    let five_hour_tokens = 0;
    let five_hour_runs = 0;
    let day_tokens = 0;
    let day_runs = 0;
    let week_tokens = 0;
    let week_runs = 0;
    let total_tokens = 0;
    let total_runs = 0;
    let last_at: string | null = null;
    let any = false;
    for (const row of members) {
      if (!row.telemetry) continue;
      any = true;
      five_hour_tokens += row.telemetry.five_hour_tokens;
      five_hour_runs += row.telemetry.five_hour_runs;
      day_tokens += row.telemetry.day_tokens;
      day_runs += row.telemetry.day_runs;
      week_tokens += row.telemetry.week_tokens ?? row.telemetry.day_tokens;
      week_runs += row.telemetry.week_runs ?? row.telemetry.day_runs;
      total_tokens += row.telemetry.total_tokens ?? row.telemetry.week_tokens ?? row.telemetry.day_tokens;
      total_runs += row.telemetry.total_runs ?? row.telemetry.week_runs ?? row.telemetry.day_runs;
      if (row.telemetry.last_at && (!last_at || row.telemetry.last_at > last_at)) last_at = row.telemetry.last_at;
    }
    return any ? { five_hour_tokens, five_hour_runs, day_tokens, day_runs, week_tokens, week_runs, total_tokens, total_runs, last_at } : undefined;
  };

  const mergeQuotaGroup = (members: QuotaLogin[]): QuotaLogin => {
    const display = members.find((row) => row.machine === null) ?? members[0]!;
    const reader = refreshTarget(members) ?? members.find((row) => !row.status.rejected) ?? display;
    const latest = latestQuota(members, (row) => row.status.usage);
    const aliases = members.filter((row) => row.login_id !== display.login_id)
      .map(({ login_id, name, machine, executor }): QuotaAlias => ({ login_id, name, machine, executor }));
    const telemetry = sumQuotaTelemetry(members);
    return {
      login_id: display.login_id, name: display.name, machine: display.machine, executor: display.executor,
      status: {
        ...reader.status,
        usage: latest.status.usage,
        rejected: members.every((row) => row.status.rejected === true),
      },
      read: reader.read,
      ...(telemetry ? { telemetry } : {}),
      ...(aliases.length === 0 ? {} : { aliases }),
    };
  };
  const quotaPage = () => ({
    stale_ms: options.settings.get('quota.readStaleMs'),
    logins: quotaGroups((options.now ?? Date.now)()).map((members) => (members.length === 1 ? members[0]! : mergeQuotaGroup(members))),
  });
  // Ask a machine to look at its own executors without waiting for its answer. This starts its
  // own read of each of its logins' quota there: the read is beside the report, so the answer
  // comes back without it and the reading rides the machine's next poll, from where the page
  // gets it by the ledger's own "changed". A machine login of an executor with no reading, or
  // one whose machine is not here, is refused before anything is asked.
  function askMachineQuota(machine: string, executors: readonly string[]): void {
    const started = (options.now ?? Date.now)();
    const reported = options.nodes.reportedExecutors(machine)?.executors;
    const deadline = started + options.nodeQuotaReadTimeoutMs() + options.settings.get('node.pollHoldMs');
    for (const executor of executors) {
      const previous = reported?.find((each) => each.executor === executor)?.quota;
      machineQuotaReads.set(machineQuotaKey(machine, executor), { started, previous: previous ? Date.parse(previous.at) || 0 : 0, deadline });
    }
    void options.nodes.askExecutors(machine).catch((err: unknown) => {
      log(`让机器 ${machine} 现在看一次没做成：${(err as Error).message}`);
    });
  }

  // Start reads without waiting; with `all`, ask every available login; with neither, ask
  // accounts whose figures are stale. The page observes each result on its next GET.
  // Machines' own logins are asked on their own clock (node.executorRefreshMs) and by "刷新",
  // never by opening the page: the
  // read there belongs to the machine, and asking it is not the host's to schedule per view.
  async function refreshQuota(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonOrNone(request) as { login_id?: unknown; all?: unknown };
    const quota = options.quota;
    if (body.login_id === undefined) {
      if (body.all === true) {
        const groups = quotaGroups((options.now ?? Date.now)());
        const targets = groups.flatMap((members) => refreshTarget(members) ?? []);
        const machines = new Map<string, string[]>();
        for (const target of targets) {
          if (target.machine !== null) {
            const executors = machines.get(target.machine) ?? [];
            executors.push(target.executor);
            machines.set(target.machine, executors);
          } else if (quota) {
            const account = options.accounts.get(target.login_id);
            if (account) void quota.read(account);
          }
        }
        for (const [machine, executors] of machines) askMachineQuota(machine, executors);
      } else {
        quota?.readStale(options.accounts.list().flatMap((row) => options.accounts.get(row.id) ?? []));
      }
      sendJson(response, 200, quotaPage());
      return;
    }
    if (typeof body.login_id !== 'string') throw new InputError('login_id 应为登录的编号');
    const group = quotaGroups((options.now ?? Date.now)()).find((members) => members.some((row) => row.login_id === body.login_id));
    if (group === undefined) throw new InputError(`没有这个账号：${body.login_id}`);
    const target = refreshTarget(group);
    if (target === undefined) {
      if (!quota && group.every((row) => row.machine === null)) throw new HttpError(503, NO_QUOTA_READ);
      const requested = group.find((row) => row.login_id === body.login_id) ?? group[0]!;
      throw new InputError(requested.read.why ?? NO_QUOTA_READ);
    }
    if (target.machine !== null) {
      askMachineQuota(target.machine, [target.executor]);
      sendJson(response, 200, quotaPage());
      return;
    }
    if (!quota) throw new HttpError(503, NO_QUOTA_READ);
    const account = options.accounts.get(target.login_id);
    if (!account) throw new InputError(`没有这个账号：${body.login_id}`);
    void quota.read(account);
    sendJson(response, 200, quotaPage());
  }

  const accountsPage = () => ({
    accounts: options.accounts.list().map(accountView),
    login_aliases: typeof ledger.loginAliases === 'function' ? ledger.loginAliases() : {},
    login_telemetry: typeof ledger.recentLoginTelemetry === 'function' ? ledger.recentLoginTelemetry() : {},
    login_groups: groupLogins([
      ...options.accounts.list().map((account) => ({ login_id: account.id, executor: account.executor, machine: null })),
      ...options.logins.machineLogins().map((login) => ({ login_id: login.id, executor: login.executor, machine: login.machine })),
    ]).filter((group) => group.length > 1).map((group) => group.map((row) => row.login_id)),
    // Each tier's dispatch order as it stands now (roles-and-tiers.md §11): the logins the
    // owner listed for it first, then the rest. The accounts page's 派发顺序 section moves
    // names in this list and saves the result.
    dispatch_order: Object.fromEntries(TIER_IDS.map((tier) => [tier, options.ledger.loginOrder(tier)])),
    dispatch_slots: typeof options.ledger.dispatchSlots === 'function' ? options.ledger.dispatchSlots() : null,
    executors: options.accounts.executors,
    // What each executor's own command takes for a permission mode, by executor: the
    // console offers the field only where the chosen executor declared any.
    permission_modes: options.accounts.permissionModes(),
    // And how each executor's tier is written and read: by executor, the shape of its text,
    // which values the form edits and the strengths its command takes.
    tier_forms: options.accounts.tierForms(),
    // And what defines a line, by executor, for one whose account is a line and its key.
    provider_forms: options.accounts.providerForms(),
    credential_executors: options.accounts.credentialExecutors,
    // How an account of each executor gets its login, as the executor declares it, and
    // whether each way can be done here now. Signing in on the executor's own page is a
    // login session on this host: there is one for the executor it serves and for no other,
    // and the helper it needs is Windows-only.
    account_logins: Object.fromEntries(Object.entries(options.accounts.accountLogins()).map(([executor, ways]) => [executor, ways.map((way): AccountLoginOffer => {
      // On a machine: the service runs it there, and says so when it cannot.
      if (way === 'machine') return options.signIns ? { way, available: true } : { way, available: false, why: NO_MACHINE_SIGN_IN_TEXT };
      if (way === 'device') {
        if (options.codexLogin?.executor !== executor) return { way, available: false, why: NO_DEVICE_LOGIN_TEXT };
        return options.codexLogin.available() ? { way, available: true } : { way, available: false, why: NO_DEVICE_LOGIN_TEXT };
      }
      if (way !== 'page') return { way, available: true };
      if (options.claudeLogin?.executor !== executor) return { way, available: false, why: NO_PAGE_LOGIN_TEXT };
      return options.claudeLogin.available() ? { way, available: true } : { way, available: false, why: UNSUPPORTED_TEXT };
    })])),
  });

  // A project as the console shows it: what it may run on, and how much of its work is
  // moving or waiting for the owner. The counts are of top-level work, as the overview's are.
  function projectView({ id, name, spawn_machines, logins_json, login_mode, paused_at, archived_at, grants_json, router_account, router_tier, category, pinned }: ProjectRow) {
    const own = ledger.listTasks({ projectId: id });
    const summarize = workSummaries(own, ledger.listApprovalCards());
    const topWorks = own
      .filter(({ parent_id }) => parent_id === null)
      .map((work) => {
        const summary = summarize(work.id);
        return { summary, group: workGroup({ state: work.state, summary }) };
      });
    const sources = ledger.projectSourceViews(id);
    return {
      id,
      name,
      category: category ?? null,
      pinned: pinned === 1,
      // Where its code comes from, in order, the first being the default; and the sources still
      // waiting for the owner to pick the machine the migration could not name.
      sources: sources.sources,
      sources_pending_machine: sources.pending,
      spawn_machines: spawn_machines === 1,
      paused_at,
      archived_at,
      // Nothing of it has left a record behind, or it is archived and no round of it is still
      // running: what may be deleted, why not when it may not, and what would go with it.
      deletable: ledger.projectDeletable(id),
      grants: grantsOf(grants_json),
      router: { account: router_account, tier: router_tier },
      home: ledger.projectHome(id),
      logins: JSON.parse(logins_json) as string[],
      login_mode,
      // The logins it runs as now: the ledger's one derivation (project-sessions §5).
      pool: ledger.loginPool({ project_id: id }).ids,
      dispatch_order: projectDispatchOrderOf(id),
      dispatch_slots: projectDispatchSlotsOf(id),
      effective_dispatch_order: effectiveProjectDispatchOrderOf(id),
      // The machines it names, and how many it names that were deleted since: those match
      // nothing, so a list of only them allows no machine (service/ledger.ts machineRange).
      // Each by its registration, which is what a save sends back, and the name it goes by now.
      ...((({ machines, gone }) => ({ machines, machines_gone: gone }))(ledger.projectMachines(id))),
      moving: topWorks.filter(({ group }) => group === WORK_GROUPS.moving).length,
      waiting: topWorks.filter(({ group, summary }) => group === WORK_GROUPS.waiting || summary.dot === 'ready').length,
      // Every work not over: what the archive confirmation counts.
      unfinished: topWorks.filter(({ group }) => group !== WORK_GROUPS.ended).length,
    };
  }

  function projectDispatchOrderOf(projectId: string): ProjectDispatchOrder | null {
    return typeof ledger.projectDispatchOrder === 'function' ? ledger.projectDispatchOrder(projectId) : null;
  }

  function projectDispatchSlotsOf(projectId: string): DispatchSlotsConfig | null {
    return typeof ledger.projectDispatchSlots === 'function' ? ledger.projectDispatchSlots(projectId) : null;
  }

  function effectiveProjectDispatchOrderOf(projectId: string): EffectiveProjectDispatchOrder {
    if (typeof ledger.effectiveProjectDispatchOrder === 'function') return ledger.effectiveProjectDispatchOrder(projectId);
    const pool = new Set(ledger.loginPool({ project_id: projectId }).ids);
    return {
      operate: ledger.loginOrder('operate').filter((loginId) => pool.has(loginId)),
      execute: ledger.loginOrder('execute').filter((loginId) => pool.has(loginId)),
      decide: ledger.loginOrder('decide').filter((loginId) => pool.has(loginId)),
    };
  }

  // A project as the console's project page shows it. Its code sources are the same list the
  // Router's get_project answers with; nothing about a checkout is asked of the disk any more.
  async function shownProject(row: ProjectRow): Promise<Record<string, unknown>> {
    return projectView(row);
  }

  // The console's "新建项目" (project-sessions §5, §8 step 1): a name, and where its code comes
  // from — a list of repositories and machine folders, or none; the rest is optional. A new
  // project runs on every login.
  async function createProject(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    if (typeof body.name !== 'string' || body.name.trim() === '') throw new InputError('项目要有名字');
    if (body.code_dir !== undefined || body.repo !== undefined) throw new InputError('项目的代码来自 sources（仓库或机器上的文件夹）：code_dir 和 repo 不再使用');
    // The list as written; the ledger names each new item and refuses an id it does not hold.
    const sources = body.sources;
    if (body.machines !== undefined && (!Array.isArray(body.machines) || body.machines.some((each: unknown) => typeof each !== 'string'))) throw new InputError('允许的机器要是一个登记号的清单');
    if (body.spawn_machines !== undefined && typeof body.spawn_machines !== 'boolean') throw new InputError('“允许派生机器”要是开或关');
    if (body.category !== undefined && body.category !== null && typeof body.category !== 'string') throw new InputError('项目分类要是文字或 null');
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw new InputError('置顶状态要是开或关');
    requireSteady('建项目');
    const id = ledger.createProject({
      name: body.name, loginMode: 'all', ...(sources === undefined ? {} : { sources }),
      ...(body.machines === undefined ? {} : { machines: body.machines as string[] }),
      ...(body.spawn_machines === true ? { spawnMachines: true } : {}),
      ...(body.category !== undefined ? { category: body.category as string | null } : {}),
      ...(body.pinned === true ? { pinned: true } : {}),
    }, { actor: CONSOLE_ACTOR });
    sendJson(response, 201, { project: await shownProject(ledger.getProject(id)) });
  }

  // A project's conversation (project-sessions §1): its segments, the one asked for (the current
  // one by default) with its messages, and whether it can be written to — only the current one
  // can. Before its first segment, what waits for it.
  function conversationOf(projectId: string, asked: string | null) {
    const project = ledger.getProject(projectId);
    const home = ledger.projectHome(projectId);
    const segments = ledger.listSegments(projectId);
    const current = ledger.currentSegment(projectId);
    const shown = asked ? segments.find(({ id }) => id === asked) : current;
    if (asked && !shown) throw new HttpError(404, `项目 ${project.name} 没有这一段对话：${asked}`);
    const messages = shown
      ? ledger.listMessages({ segmentId: shown.id, limit: CONVERSATION_LIMIT })
      : ledger.listMessages({ projectId, limit: CONVERSATION_LIMIT });
    const router = session.status();
    const status = router.projects.find((each) => each.project_id === projectId);
    return {
      project: {
        id: project.id,
        name: project.name,
        paused_at: project.paused_at,
        archived_at: project.archived_at,
        dispatch_order: projectDispatchOrderOf(project.id),
        dispatch_slots: projectDispatchSlotsOf(project.id),
        effective_dispatch_order: effectiveProjectDispatchOrderOf(project.id),
      },
      segments: segments.map(({ id, seq, state, created_at, closed_at }) => ({ id, seq, state, created_at, closed_at })),
      segment: shown?.id ?? null,
      writable: (home === null || home.phase === 'owned') && (shown === undefined || shown.state === 'current'),
      home,
      messages: hydrateMessages(messages),
      // The executor contexts of the segment: a line in the conversation where one was rebuilt.
      contexts: shown
        ? ledger.listContexts(projectId).filter(({ segment_id }) => segment_id === shown.id)
          .map(({ id, created_at, state, closed_reason, closed_at, login_id }) => ({ id, created_at, state, closed_reason, closed_at, login_id }))
        : [],
      // How many of the old global record's messages are linked to this project (§6).
      legacy: ledger.listMessages({ legacy: true, projectId, limit: CONVERSATION_LIMIT }).filter(({ direction }) => direction === 'in').length,
      busy: status?.turn ?? null,
      router_error: router.host_error ?? status?.error ?? (project.router_account === null ? router.error : null),
    };
  }

  // "新话题": the current segment becomes history; what is queued goes to the new one (§3).
  // The owner's pause of one project (project-sessions §5), in effect at once and apart from the
  // page's draft. The Router of a resumed project takes up what waited.
  async function pauseProject(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    const body = await readJson(request);
    if (typeof body.paused !== 'boolean') throw new InputError('要说明暂停（true）还是恢复（false）');
    requireSteady(body.paused ? '暂停项目' : '恢复项目');
    const project = ledger.setProjectPaused(projectId, body.paused, { actor: CONSOLE_ACTOR });
    session.kick();
    sendJson(response, 200, { project: await shownProject(project) });
  }

  // Putting a project away, and taking it out again (project-sessions, "项目的生命周期"). Like
  // the pause it acts at once, apart from the page's draft; a restored project's Router takes up
  // what waited, and a pause it had before is still there.
  async function archiveProject(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    const body = await readJson(request);
    if (typeof body.archived !== 'boolean') throw new InputError('要说明归档（true）还是恢复（false）');
    requireSteady(body.archived ? '归档项目' : '恢复项目');
    const project = ledger.setProjectArchived(projectId, body.archived, { actor: CONSOLE_ACTOR });
    session.kick();
    sendJson(response, 200, { project: await shownProject(project) });
  }

  // A project that never left a record behind goes at any time; one with history goes once it
  // is archived and no round is still running. The ledger decides whether it may, says what is
  // there when it may not, and takes the name the page made the owner type (project-sessions,
  // "项目的生命周期"). What it left on disk is cleared by the service's own housekeeping.
  async function deleteProject(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    const body = await readJson(request);
    const confirmName = body.confirm_name;
    if (confirmName !== undefined && typeof confirmName !== 'string') throw new InputError('confirm_name 要是字符串');
    requireSteady('删项目');
    ledger.deleteProject(projectId, confirmName, { actor: CONSOLE_ACTOR });
    // Housekeeping, not part of the answer: a sweep that cannot finish leaves the bytes for
    // the next pass, and must not turn a deletion that committed into a failed request.
    try {
      options.cleanupAfterProjectDelete?.();
    } catch (err) {
      log(`删除项目 ${projectId} 后清理磁盘上的副本失败：${String(err)}`);
    }
    sendJson(response, 200, { deleted: true });
  }

  function newTopic(response: ServerResponse, projectId: string): void {
    requireSteady('开新话题');
    const segment = ledger.newTopic(projectId, { actor: CONSOLE_ACTOR });
    session.kick();
    sendJson(response, 201, { segment: { id: segment.id, seq: segment.seq, state: segment.state, created_at: segment.created_at, closed_at: segment.closed_at } });
  }

  async function sideAskProject(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    if (!options.sideAsk) throw new HttpError(503, '当前服务未启用临时追问功能');
    const project = ledger.getProject(projectId);
    const body = await readJson(request) as Record<string, unknown>;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) throw new InputError('问题不能为空');
    if (question.length > 4000) throw new InputError('临时追问内容过长（最多 4000 字符）');
    let quote: { source?: string; excerpt: string } | undefined;
    if (body.quote && typeof body.quote === 'object' && !Array.isArray(body.quote)) {
      const qObj = body.quote as Record<string, unknown>;
      const excerpt = typeof qObj.excerpt === 'string' ? qObj.excerpt.trim() : '';
      if (excerpt) {
        const source = typeof qObj.source === 'string' && qObj.source.trim() !== '' ? qObj.source.trim() : undefined;
        quote = source ? { source, excerpt: excerpt.slice(0, 2000) } : { excerpt: excerpt.slice(0, 2000) };
      }
    }
    const history: SideAskTurn[] = [];
    if (Array.isArray(body.history)) {
      for (const item of body.history.slice(-8)) {
        if (!item || typeof item !== 'object') continue;
        const role = (item as Record<string, unknown>).role;
        const text = (item as Record<string, unknown>).text;
        if ((role === 'user' || role === 'assistant') && typeof text === 'string' && text.trim() !== '') {
          history.push({ role, text: text.trim().slice(0, 2000) });
        }
      }
    }
    const locale = typeof body.locale === 'string' && body.locale.trim()
      ? normalizeLocale(body.locale)
      : normalizeLocale(options.settings.get('ui.locale'));
    const segment = ledger.currentSegment(projectId);
    const recentMessages = (segment ? ledger.listMessages({ segmentId: segment.id, limit: 12 }) : ledger.listMessages({ projectId, limit: 12 }))
      .map((msg) => ({ direction: msg.direction, text: msg.text, created_at: msg.created_at }));
    const recentTasks = ledger.listTasks({ projectId })
      .slice(0, 8)
      .map((t) => ({ id: t.id, title: t.title, state: t.state, summary: t.reason ?? null }));
    const result = await options.sideAsk(
      projectId,
      { projectName: project.name, recentMessages, recentTasks },
      { question, quote, history, locale },
    );
    sendJson(response, 200, result);
  }

  // ---- A project's triggers (docs/design/triggers.md §7). The definition is parsed by the ledger,
  // the same entrance the Router's tools go through. ----

  const broadcastGroupSummary = ({ id, channel, chat_id, chat_name, project_id, enabled, notify_events }: ImGroupBindingView) =>
    ({ id, channel, chat_id, chat_name, project_id, enabled, notify_events });

  function triggersOf(response: ServerResponse, projectId: string): void {
    ledger.getProject(projectId);
    sendJson(response, 200, {
      triggers: ledger.listTriggers(projectId),
      // Its own rules' occurrences: inbound events delivered here are the inbound page's, not
      // this project's triggers' (§2.2, §7).
      recent: ledger.listTriggerFires({ projectId, ruleOnly: true, limit: RECENT_FIRES }),
      groups: ledger.listImGroupBindings(projectId).map(broadcastGroupSummary),
      // What a new cron rule's zone is unless one is chosen, and how dense a rule may be.
      zone: hostZone(),
      min_interval_ms: options.settings.get('triggers.minIntervalMs'),
    });
  }

  // ---- Inbound sources (§2.2): tycho-wide, so one page of its own, never inside a project. ----

  function inboundPage() {
    const publicUrl = options.publicUrl?.() || null;
    const proxyPort = options.reverseProxyPort?.() ?? reverseProxy.port();
    const reach = inboundReach(options.gateway?.().state ?? 'off', { reverseProxyPort: proxyPort, publicUrl });
    return {
      sources: ledger.listInboundSources(),
      recent: ledger.listTriggerFires({ sourceOnly: true, withPublicReply: true, limit: RECENT_FIRES }),
      projects: ledger.listProjects().map(({ id, name }) => ({ id, name, repos: repoUrlsOf(ledger.projectSources(id)) })),
      groups: ledger.listImGroupBindings().map(broadcastGroupSummary),
      kinds: INBOUND_KINDS.map((kind) => ({ kind, label: INBOUND_KIND_LABELS[kind], about: INBOUND_KIND_ABOUT[kind] })),
      reach: { reach, reach_text: INBOUND_REACH_LABELS[reach], public_url: publicUrl },
    };
  }

  const inboundFields = ({ name, kind, project_ids, note, push_final, result_reply, broadcast_groups, broadcast_group_ids }: Record<string, unknown>) =>
    ({ name, kind, project_ids, note, push_final, result_reply, broadcast_groups, broadcast_group_ids });

  async function createInboundSource(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    requireSteady('建入站来源');
    sendJson(response, 201, { source: ledger.createInboundSource(inboundFields(body), { actor: CONSOLE_ACTOR }) });
  }

  async function putInboundSource(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const body = await readJson(request);
    requireSteady('改入站来源');
    sendJson(response, 200, { source: ledger.updateInboundSource(id, inboundFields(body), { actor: CONSOLE_ACTOR }) });
  }

  async function setInboundEnabled(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const { enabled } = await readJson(request);
    if (typeof enabled !== 'boolean') throw new InputError('enabled 要是开或关');
    requireSteady(enabled ? '启用入站来源' : '停用入站来源');
    sendJson(response, 200, { source: ledger.setInboundEnabled(id, enabled, { actor: CONSOLE_ACTOR }) });
  }

  function deleteInboundSource(response: ServerResponse, id: string): void {
    requireSteady('删除入站来源');
    ledger.deleteInboundSource(id, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, {});
  }

  // A source's key, first or new, shown once in this answer and never again (§2.2).
  function issueInboundKey(response: ServerResponse, id: string): void {
    requireSteady('领取入站来源的密钥');
    const { key_id: keyId, secret, source } = options.inbounds.issue(id, { actor: CONSOLE_ACTOR });
    sendJson(response, 201, { key_id: keyId, secret, source });
  }

  // An inbound request (§2.2): its signature is checked by the translator of the source's kind,
  // and the rest judged by the ledger's one acceptance. An event already accepted answers with
  // the same receipt; each event of a repository that matches several projects is its own.
  async function receiveInbound({ request, response, params: [id] }: Asked): Promise<void> {
    // Nothing from outside reaches a source that is gone or has no key in force: answered as a
    // path nobody serves, before a body is read at all.
    const source = options.ledger.getInboundSource(id!);
    if (!source || !source.ready) throw new HttpError(404, '没有这个接口');
    const body = await readBytes(request, MAX_INBOUND_BODY_BYTES);
    const header = (name: string): string | null => {
      const value = request.headers[name.toLowerCase()];
      return typeof value === 'string' ? value : null;
    };
    const result = options.inbounds.receive(id!, { header, body });
    // Nothing from outside reaches it: answered as a path nobody serves.
    if (result === undefined) throw new HttpError(404, '没有这个接口');
    if (result.status === 'ping') {
      sendJson(response, 200, { accepted: false, ping: true });
      return;
    }
    if (result.status === 'refused') {
      sendJson(response, REFUSAL_STATUS[result.reason], { error: result.text, reason: result.reason });
      return;
    }
    for (const receipt of result.receipts) {
      if (receipt.status === 'accepted' && !receipt.duplicate && receipt.message_id !== null) {
        stream.publish('message', hydrateMessages([ledger.getMessage(receipt.message_id)])[0]);
        session.kick();
      }
    }
    const refused = result.receipts.filter((receipt) => receipt.status === 'refused');
    // Nothing of a request that reached any project was taken: answer with the first refusal, so a
    // caller retrying with the same event ids gets past a full queue or a rate.
    if (result.receipts.length > 0 && refused.length === result.receipts.length) {
      const first = refused[0]!;
      if (first.status === 'refused') {
        sendJson(response, REFUSAL_STATUS[first.reason], { error: first.text, reason: first.reason });
        return;
      }
    }
    sendJson(response, 200, { accepted: true, receipts: result.receipts });
  }

  function readInboundReceipt({ request, response, params: [sourceId, receiptId], url }: Asked): void {
    if (url.search) throw new HttpError(404, '没有这个接口');
    const result = options.inbounds.readReceipt(sourceId!, receiptId!, (name) => {
      const value = request.headers[name.toLowerCase()];
      return typeof value === 'string' ? value : null;
    });
    if (result === undefined) throw new HttpError(404, '没有这个接口');
    sendJson(response, 200, result);
  }

  const triggerFields = ({ name, instruction, source, schedule, event, missed, expires_at, push_final, broadcast_groups, broadcast_group_ids }: Record<string, unknown>) =>
    ({ name, instruction, source, schedule, event, missed, expires_at, push_final, broadcast_groups, broadcast_group_ids });

  async function createTrigger(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    const body = await readJson(request);
    requireSteady('建触发器');
    sendJson(response, 201, { trigger: ledger.createTrigger(projectId, triggerFields(body), { actor: CONSOLE_ACTOR }) });
  }

  async function putTrigger(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const body = await readJson(request);
    requireSteady('改触发器');
    sendJson(response, 200, { trigger: ledger.updateTrigger(id, triggerFields(body), { actor: CONSOLE_ACTOR }) });
  }

  async function setTriggerEnabled(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const { enabled } = await readJson(request);
    if (typeof enabled !== 'boolean') throw new InputError('enabled 要是开或关');
    requireSteady(enabled ? '启用触发器' : '停用触发器');
    sendJson(response, 200, { trigger: ledger.setTriggerEnabled(id, enabled, { actor: CONSOLE_ACTOR }) });
  }

  function deleteTrigger(response: ServerResponse, id: string): void {
    requireSteady('删除触发器');
    ledger.deleteTrigger(id, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, {});
  }

  function listImGroups(response: ServerResponse): void {
    sendJson(response, 200, {
      bindings: ledger.listImGroupBindings(),
      discovered: ledger.listDiscoveredImGroups(),
      projects: ledger.listProjects().map(({ id, name }) => ({ id, name })),
    });
  }

  function listProjectImGroups(response: ServerResponse, projectId: string): void {
    ledger.getProject(projectId);
    sendJson(response, 200, {
      bindings: ledger.listImGroupBindings(projectId),
      discovered: ledger.listDiscoveredImGroups(),
    });
  }

  async function createImGroup(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    requireSteady('绑定群聊');
    const group = ledger.createImGroupBinding(body as unknown as ImGroupBindingInput, { actor: CONSOLE_ACTOR });
    stream.publish('changed', {});
    sendJson(response, 201, { group });
  }

  async function putImGroup(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const body = await readJson(request);
    requireSteady('修改群聊绑定');
    const group = ledger.updateImGroupBinding(id, body as unknown as ImGroupBindingPatch, { actor: CONSOLE_ACTOR });
    stream.publish('changed', {});
    sendJson(response, 200, { group });
  }

  function deleteImGroup(response: ServerResponse, id: string): void {
    requireSteady('解绑群聊');
    ledger.deleteImGroupBinding(id, { actor: CONSOLE_ACTOR });
    stream.publish('changed', {});
    sendJson(response, 200, { deleted: true });
  }

  // The owner gives waiting messages a project: these ones, all at once (§2).
  async function assignMessages(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { ids, project_id: projectId } = await readJson(request);
    if (!Array.isArray(ids) || ids.some((each) => typeof each !== 'string')) throw new InputError('要说明是哪几条消息：ids');
    if (typeof projectId !== 'string' || projectId === '') throw new InputError('要说明归到哪个项目：project_id');
    const rows = ledger.assignMessages(ids as string[], projectId, { actor: CONSOLE_ACTOR });
    const hydrated = hydrateMessages(rows);
    for (const row of hydrated) stream.publish('message', row);
    session.kick();
    sendJson(response, 200, { messages: hydrated });
  }

  // The list and its mode at once, as one change: the two are one choice, and a half-applied
  // edit would be a combination nobody chose. The code directory goes with them: it is what
  // every Task of the project is handed.
  async function putProject(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const body = await readJson(request);
    const names = (value: unknown, what: string): string[] => {
      if (!Array.isArray(value) || value.some((each) => typeof each !== 'string')) throw new InputError(`${what}要是一个清单`);
      return value as string[];
    };
    if (Object.hasOwn(body, 'accounts')) throw new InputError('项目允许的是登录（logins）：账号和机器自己的登录都在这一个清单里');
    // A list only when the owner edits one; with no mode, sending it chooses "only these"
    // (project-sessions §1). A mode alone switches and keeps the list.
    const logins = body.logins === undefined ? undefined : names(body.logins, '允许的登录');
    if (body.login_mode !== undefined && body.login_mode !== 'all' && body.login_mode !== 'selected') {
      throw new InputError('登录方式只有“全部登录”（all）和“只用所选”（selected）');
    }
    const loginMode = body.login_mode as LoginMode | undefined;
    // By registration (machine.uid), never by name: a name may mean another machine by now.
    const machines = body.machines === undefined ? undefined : names(body.machines, '允许的机器（登记号）');
    // Before the code sources are looked at: a service that cannot write must not do the work
    // of checking them either.
    requireSteady('改项目');
    if (body.code_dir !== undefined || body.repo !== undefined) throw new InputError('项目的代码来自 sources（仓库或机器上的文件夹）：code_dir 和 repo 不再使用');
    // The list as written; the ledger names each new item and refuses an id it does not hold.
    const sources = body.sources;
    if (body.spawn_machines !== undefined && typeof body.spawn_machines !== 'boolean') throw new InputError('“允许派生机器”要是开或关');
    if (body.grants !== undefined && (!Array.isArray(body.grants) || !body.grants.every((each) => typeof each === 'string'))) throw new InputError('授权要是一组名字：grants');
    if (body.name !== undefined && typeof body.name !== 'string') throw new InputError('项目名要是文字');
    if (body.category !== undefined && body.category !== null && typeof body.category !== 'string') throw new InputError('项目分类要是文字或 null');
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw new InputError('置顶状态要是开或关');
    let router: { account: string | null; tier: string | null } | undefined;
    if (body.router !== undefined) {
      const raw = body.router;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InputError('负责人设置无效');
      const { account, tier } = raw as Record<string, unknown>;
      if (account !== null && (typeof account !== 'string' || account === '')) throw new InputError('请选择负责人账号');
      if (tier !== null && (typeof tier !== 'string' || !isTierId(tier))) throw new InputError('请选择有效的负责人档位');
      if (account !== null) {
        const held = options.logins.get(account);
        if (!held || !(options.accounts.canRoute?.(held.executor) ?? options.accounts.get(account)?.canRoute) ||
          (held.machine && held.machine !== ledger.hostMachine())) {
          throw new InputError('请选择支持负责人的账号或本机登录');
        }
        if (tier !== null && !tierValueFrom(held.tiers, tier)) throw new InputError('这个登录没有所选档位');
      }
      router = { account, tier };
    }
    let dispatchOrder: ProjectDispatchOrder | null | undefined;
    if (Object.hasOwn(body, 'dispatch_order') && body.dispatch_order !== undefined) {
      const raw = body.dispatch_order;
      if (raw === null) {
        dispatchOrder = null;
      } else {
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          throw new InputError('派发顺序应为 null 或按档位给出的登录清单对象');
        }
        const parsed: ProjectDispatchOrder = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (!isTierId(key)) {
            throw new InputError(`派发顺序包含无效档位：${key}`);
          }
          if (value === undefined) continue;
          if (!Array.isArray(value) || value.some((each) => typeof each !== 'string')) {
            throw new InputError(`派发顺序的 ${key} 档位应为登录编号清单`);
          }
          parsed[key] = value as string[];
        }
        dispatchOrder = parsed;
      }
    }
    let dispatchSlots: DispatchSlotsConfig | null | undefined;
    if (Object.hasOwn(body, 'dispatch_slots') && body.dispatch_slots !== undefined) {
      const raw = body.dispatch_slots;
      if (raw === null) {
        dispatchSlots = null;
      } else {
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          throw new InputError('派发槽位应为 null 或按档位给出的槽位配置对象');
        }
        for (const key of Object.keys(raw as Record<string, unknown>)) {
          if (!isTierId(key)) {
            throw new InputError(`派发槽位包含无效档位：${key}`);
          }
        }
        const normalized = normalizeDispatchSlotsConfig(raw);
        if (!normalized) {
          throw new InputError('派发槽位格式不正确');
        }
        dispatchSlots = normalized;
      }
    }
    // The ledger's own checks decide what a project may be pointed at and what it may be
    // called, so the tool and the console cannot come to different conclusions about it.
    ledger.transaction(() => {
      if (typeof body.name === 'string') ledger.setProjectName(id, body.name, { actor: CONSOLE_ACTOR });
      if (Object.hasOwn(body, 'category') && body.category !== undefined) ledger.setProjectCategory(id, body.category as string | null, { actor: CONSOLE_ACTOR });
      if (typeof body.pinned === 'boolean') ledger.setProjectPinned(id, body.pinned, { actor: CONSOLE_ACTOR });
      if (logins || loginMode) ledger.setProjectLogins(id, logins, { actor: CONSOLE_ACTOR }, loginMode);
      if (dispatchSlots !== undefined) ledger.setProjectDispatchSlots(id, dispatchSlots, { actor: CONSOLE_ACTOR });
      else if (dispatchOrder !== undefined) ledger.setProjectDispatchOrder(id, dispatchOrder, { actor: CONSOLE_ACTOR });
      if (machines) ledger.setProjectMachines(id, machines, { actor: CONSOLE_ACTOR });
      if (sources !== undefined) ledger.setProjectSources(id, sources, { actor: CONSOLE_ACTOR });
      if (typeof body.spawn_machines === 'boolean') ledger.setProjectSpawnMachines(id, body.spawn_machines, { actor: CONSOLE_ACTOR });
      if (Array.isArray(body.grants)) ledger.setProjectGrants(id, body.grants as string[], { actor: CONSOLE_ACTOR });
      if (router) ledger.setProjectRouter(id, router.account, router.tier, { actor: CONSOLE_ACTOR });
    });
    if (router) session.kick();
    sendJson(response, 200, { project: await shownProject(ledger.getProject(id)) });
  }

  async function renameProjectCategory(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    if (typeof body.from !== 'string' || body.from.trim() === '') throw new InputError('要说明原分类名：from');
    if (body.to !== undefined && body.to !== null && typeof body.to !== 'string') throw new InputError('目标分类名要是文字或 null');
    requireSteady('修改项目分类');
    const updated = ledger.renameProjectCategory(body.from, (body.to ?? null) as string | null, { actor: CONSOLE_ACTOR });
    const projects = await Promise.all(ledger.listProjects().map(shownProject));
    sendJson(response, 200, { updated, projects });
  }

  function accountId(encoded: string): string {
    try {
      return decodeURIComponent(encoded);
    } catch {
      throw new InputError('账号编号不合法');
    }
  }

  // A page may hand an account's login only where the executor declares a way that has the
  // owner type the secret (an API key, a line and its key). A login obtained by a login session
  // this host runs, or one that belongs to a machine, reaches the ledger through that way alone
  // and never through an account form (docs/design/native-login.md §5): so for those executors
  // there is no account to make here, and no new credential to set. The check is at this
  // boundary and not deeper because the login window writes an account through the same store.
  function checkLoginHandedByPage(executor: string): void {
    // The executor comes from the request body: a name like "constructor" or "__proto__" must
    // read as one nobody declared, not as whatever the object's prototype holds there.
    const declared = Object.hasOwn(options.accounts.accountLogins(), executor) ? options.accounts.accountLogins()[executor]! : [];
    if (!takesTypedLogin(declared)) throw new InputError(typedLoginRefusal(executor));
  }

  function checkTypedSecretValue(value: unknown): void {
    if (typeof value === 'string' && (isCodexOAuthSecret(value) || isCodexOAuthLease(value))) {
      throw new InputError('授权令牌由登录流程自动保存，不能直接粘贴到密钥框里');
    }
  }

  async function putAccount(request: IncomingMessage, response: ServerResponse, id?: string): Promise<void> {
    const body = await readJson(request);
    const input: AccountInput = {};
    for (const [name, value] of Object.entries(body)) {
      const field = Object.hasOwn(ACCOUNT_FIELDS, name) ? ACCOUNT_FIELDS[name] : undefined;
      if (!field) throw new InputError(`账号没有 ${name} 这一项`);
      input[field] = value;
    }
    requireSteady('改账号');
    const existing = id === undefined ? undefined : options.accounts.get(id);
    if (id !== undefined && !existing) throw new InputError(`账号不存在：${id}`);
    // A new account here is one whose login is typed in this write; an existing account keeps
    // its login unless this write brings another one.
    const named = typeof input.executor === 'string' && input.executor !== '' ? input.executor : undefined;
    if (!absent(input.credential)) checkTypedSecretValue(input.credential);
    if (id === undefined) {
      if (named !== undefined) checkLoginHandedByPage(named);
    } else {
      const executor = named ?? existing!.executor;
      if (!absent(input.credential)) {
        checkLoginHandedByPage(executor);
        if (existing!.signedIn === true) throw new InputError('这个账号是通过授权登录的，不能直接填密钥；请点“重新登录”');
      }
    }
    // A name is not required to make an account: one with no name gets the ledger's default
    // (service/ledger.ts), and the answer carries the name it ended up with. An edit with no
    // name keeps the one it has (service/accounts.ts).
    const { account, created } = options.accounts.put({ ...input, ...(id === undefined ? {} : { id }) }, { actor: CONSOLE_ACTOR });
    // Asked for before the answer goes out, and never waited on: saving an account must not
    // sit on a machine or a network round trip, and the page shows the query on its way
    // rather than an older list as if it were this moment's.
    askModels(account);
    if (created) askQuota(account.id);
    sendJson(response, created ? 201 : 200, { account: accountView(account), created });
  }

  // The projects the login was allowed by, and what each has left after it goes: the answer
  // names them, and the same list is in the confirmation body when there is one
  // (docs/design/native-login.md §2).
  function deleteAccount(response: ServerResponse, id: string, confirmed: boolean): void {
    requireSteady('删账号');
    const { projects } = options.accounts.remove(id, { actor: CONSOLE_ACTOR }, { confirmed });
    sendJson(response, 200, { deleted: true, projects });
  }

  // Replacing the login of an account that is one and its key: a new API key, or a new key for
  // a line. An account whose login tycho keeps only as the login window's own has no such
  // route — signing in again is how its credential is replaced (docs/design/native-login.md §5).
  async function setAccountCredential(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const { value } = await readJson(request);
    requireSteady('换账号的密钥');
    const account = options.accounts.get(id);
    if (!account) throw new InputError(`账号不存在：${id}`);
    checkLoginHandedByPage(account.executor);
    if (account.signedIn === true) throw new InputError('这个账号是通过授权登录的，不能直接填密钥；请点“重新登录”');
    checkTypedSecretValue(value);
    options.accounts.setCredential(id, value, { actor: CONSOLE_ACTOR });
    // A token is what the account's own list is asked with, so it is asked again: like a
    // save, on its way while the answer goes out.
    askModels(options.accounts.get(id)!);
    sendJson(response, 200, { account: accountView(options.accounts.get(id)!) });
  }

  // A Claude login from the console (docs/design/native-login.md §二). The answers carry the
  // session's state and, while the owner is to open it, the whole authorization address; the
  // code and the token never come back out.
  function claudeLogin(): NonNullable<HttpOptions['claudeLogin']> {
    if (!options.claudeLogin) throw new InputError('这个服务不能在控制台登录 Claude');
    return options.claudeLogin;
  }

  function codexLogin(): NonNullable<HttpOptions['codexLogin']> {
    if (!options.codexLogin) throw new InputError('这个服务不能在控制台登录 Codex');
    return options.codexLogin;
  }

  function signIns(): NonNullable<HttpOptions['signIns']> {
    if (!options.signIns) throw new InputError('这个服务不能在机器上发起登录');
    return options.signIns;
  }

  async function startSignIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { machine, executor, machine_uid } = await readJson(request);
    requireSteady('在机器上登录');
    sendJson(response, 201, { sign_in: signIns().start(machine, executor, machine_uid) });
  }

  async function submitSignInCode(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const { code } = await readJson(request);
    requireSteady('提交登录授权码');
    sendJson(response, 200, { sign_in: signInOr404(await signIns().submitCode(id, code)) });
  }

  function signInOr404(view: ReturnType<NonNullable<HttpOptions['signIns']>['get']>): NonNullable<typeof view> {
    if (view === undefined) throw new HttpError(404, '没有这次登录（可能已经过期，或服务重启过）');
    return view;
  }

  async function startClaudeLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { account, mode } = await readJson(request);
    requireSteady('登录账号');
    sendJson(response, 201, { login: claudeLogin().start(account, mode, { actor: CONSOLE_ACTOR }) });
  }

  async function submitClaudeCode(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const { code } = await readJson(request);
    requireSteady('登录账号');
    sendJson(response, 200, { login: claudeLogin().submit(id, code) });
  }

  // A new account's tiers and limits, as the account form writes them; the executor and the
  // token are the login's.
  async function saveClaudeLogin(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const body = await readJson(request);
    const input: AccountInput = {};
    for (const [name, value] of Object.entries(body)) {
      const field = Object.hasOwn(ACCOUNT_FIELDS, name) ? ACCOUNT_FIELDS[name] : undefined;
      if (!field || field === 'credential' || field === 'executor' || field === 'name') throw new InputError(`登录后建账号没有 ${name} 这一项`);
      input[field] = value;
    }
    requireSteady('建账号');
    const { login, account } = claudeLogin().save(id, input, { actor: CONSOLE_ACTOR });
    options.models?.reschedule();
    askQuota(account.id);
    sendJson(response, 201, { login, account: accountView(options.accounts.get(account.id)!) });
  }

  async function startCodexLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { account, mode } = await readJson(request);
    requireSteady('登录账号');
    sendJson(response, 201, { login: codexLogin().start(account, mode, { actor: CONSOLE_ACTOR }) });
  }

  async function saveCodexLogin(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const body = await readJson(request);
    const input: AccountInput = {};
    for (const [name, value] of Object.entries(body)) {
      const field = Object.hasOwn(ACCOUNT_FIELDS, name) ? ACCOUNT_FIELDS[name] : undefined;
      if (!field || field === 'credential' || field === 'executor' || field === 'name') throw new InputError(`登录后建账号没有 ${name} 这一项`);
      input[field] = value;
    }
    requireSteady('建账号');
    const { login, account } = codexLogin().save(id, input, { actor: CONSOLE_ACTOR });
    options.models?.reschedule();
    askQuota(account.id);
    sendJson(response, 201, { login, account: accountView(options.accounts.get(account.id)!) });
  }

  // Asked in the background, where the answer is not something anyone is waiting for: the
  // pages read the list again by themselves, and it says when it was read.
  function askModels(account: Login): void {
    const asked = options.models?.refresh(account);
    if (!asked) return;
    void asked
      .then((result) => {
        if (!result.ok) log(`${loginName(account)} 的模型列表没读到：${result.reason}`);
      })
      .catch((err: unknown) => log(`${loginName(account)} 的模型列表查询失败：${String(err)}`));
  }

  // A new account's quota, asked once it exists, so the account page shows its windows without
  // waiting for the usage page to be opened. The same rule as that page's: an account that
  // cannot be asked, or whose figures are fresh, is left alone, and the owner's setting that
  // turns stale reads off turns this off too. Never waited on: a read is a turn of the executor.
  function askQuota(id: string): void {
    const account = options.accounts.get(id);
    if (account) options.quota?.readStale([account]);
  }

  // The owner's "try now" for an account that rests after a used-up quota.
  function retryAccount(response: ServerResponse, id: string): void {
    requireSteady('让账号现在就试');
    ledger.endRest(id, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, { account: accountView(options.accounts.get(id)!) });
  }

  function ownLogin(id: string): Login & { machine: string } {
    const login = options.logins.get(id);
    if (!login || login.machine === undefined) throw new InputError(`机器自己的登录不存在：${id}`);
    return login as Login & { machine: string };
  }

  async function putMachineLogin(request: IncomingMessage, response: ServerResponse, target: { id: string } | { uid: string; executor: string }): Promise<void> {
    const body = await readJson(request);
    const input: LoginSettingsInput = {};
    for (const [name, value] of Object.entries(body)) {
      const field = Object.hasOwn(MACHINE_LOGIN_FIELDS, name) ? MACHINE_LOGIN_FIELDS[name] : undefined;
      if (!field) throw new InputError(`机器自己的登录没有 ${name} 这一项`);
      input[field] = value;
    }
    requireSteady('改机器自己的登录');
    // Resolve after reading the body: a page bound to an old registration or deleted login
    // cannot change a new namesake, even if it was replaced while the request arrived.
    const held = 'id' in target ? ownLogin(target.id) : undefined;
    const machine = 'uid' in target
      ? ledger.listMachines().find((machine) => machine.uid === target.uid)
      : ledger.getMachine(held!.machine);
    if (!machine) throw new InputError(`机器登记不存在：${'uid' in target ? target.uid : target.id}`);
    const machineId = machine.id;
    const executor = 'executor' in target ? target.executor : held!.executor;
    // Whether the machine's executor is set up here yet is the ledger's to answer: an owner
    // write creates the login when it is not there and replaces it when it is — the values
    // written are the owner's, over whatever the host adopted from the machine's report.
    const { created } = options.logins.putMachineLogin(machineId, executor, input, { actor: CONSOLE_ACTOR });
    sendJson(response, created ? 201 : 200, { machine: machineView(ledger.getMachine(machineId)!), created });
  }

  // Batch-sync shared settings (tiers, permission mode, timeout, concurrency) across all machine
  // logins belonging to one logical executor group, keeping OAuth authorization local per host
  // while unifying configuration management into a single action.
  async function putMachineLoginsBatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const rawIds = body.login_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new InputError('至少要选择一个要同步的机器登录');
    }
    const ids = [...new Set(rawIds.map((id) => (id as string).trim()))];
    const input: LoginSettingsInput = {};
    for (const [name, value] of Object.entries(body)) {
      if (name === 'login_ids') continue;
      const field = Object.hasOwn(MACHINE_LOGIN_FIELDS, name) ? MACHINE_LOGIN_FIELDS[name] : undefined;
      if (!field) throw new InputError(`机器自己的登录没有 ${name} 这一项`);
      input[field] = value;
    }
    requireSteady('批量同步逻辑账号配置');
    const targets = ids.map((id) => ownLogin(id));
    const executor = targets[0]!.executor;
    if (targets.some((each) => each.executor !== executor)) {
      throw new InputError('批量同步的登录必须属于同一个执行器');
    }
    const updatedMachines = new Map<string, ReturnType<typeof machineView>>();
    for (const target of targets) {
      options.logins.putMachineLogin(target.machine, target.executor, input, { actor: CONSOLE_ACTOR });
      const latest = ledger.getMachine(target.machine);
      if (latest) updatedMachines.set(latest.id, machineView(latest));
    }
    sendJson(response, 200, { machines: [...updatedMachines.values()], count: targets.length });
  }

  function deleteMachineLogin(response: ServerResponse, id: string): void {
    requireSteady('删机器自己的登录');
    const login = ownLogin(id);
    const { projects } = options.logins.removeMachineLogin(login.machine, login.executor, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, { deleted: true, projects });
  }

  function retryMachineLogin(response: ServerResponse, id: string): void {
    requireSteady('让机器自己的登录现在就试');
    const login = ownLogin(id);
    ledger.endRest(login.id, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, { machine: machineView(ledger.getMachine(login.machine)!) });
  }

  // The owner is waiting on this one, so the model list is asked along with the machine: the
  // same answer the page would otherwise have to come back for. A query that fails is said
  // beside the machine's own answer, and the list stays what it was. One machine is asked
  // (accounts-machines-decoupled "控制台"); with none to ask, the answer says so.
  // What a line serves, asked while the owner is writing it, with the key typed in the form.
  // Nothing is kept: the answer only fills the form, and saving is what makes it an account's.
  // A key the service keeps never goes out this way: the line here is the request's, and an
  // account's own is asked by its connection test, with the line it has.
  async function readLineModels(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { executor, provider, key } = await readJson(request);
    if (typeof executor !== 'string') throw new InputError('要说是哪个执行器的线路');
    const line = options.accounts.checkLine(executor, provider);
    if (key !== undefined && key !== null && (typeof key !== 'string' || /[\s\0]/.test(key))) throw new InputError('密钥应为一段不含空白的文字');
    const secret = typeof key === 'string' && key !== '' ? key : undefined;
    if (!options.models?.readLine) throw new HttpError(503, '模型查询不可用');
    const answer = await options.models.readLine(executor, line, secret);
    sendJson(response, 200, answer.ok ? { models: answer.models, at: answer.at } : { models: [], reason: answer.reason });
  }

  async function checkAccount(response: ServerResponse, id: string): Promise<void> {
    const account = options.accounts.get(id);
    if (!account) throw new InputError(`账号不存在：${id}`);
    if (!options.runner) throw new HttpError(503, '执行服务不可用');
    const [machine, models] = await Promise.all([
      options.runner.check(account),
      options.models?.refresh(account) ?? Promise.resolve(undefined),
    ]);
    sendJson(response, 200, {
      account_id: id,
      machine,
      ...(machine === null ? { unchecked: `没有在线、装了 ${account.executor} 的机器，这次没有问机器` } : {}),
      models: options.models?.state(id) ?? { list: [], at: null, refreshing: false },
      ...(models === undefined || models.ok ? {} : { models_failure: models.reason }),
    });
  }


  // The models a machine's own login may use are that machine's to report (nodes.md §1.2):
  // its list with the moment it was read there, or why there is none. Nothing of the ledger's
  // and nothing asked from here: the same for a login the owner has not set up yet, which is
  // when its tiers are first filled in.
  function machineModels(machine: MachineRecord, reported: NodeExecutorStatus | null, at: string | null) {
    if (reported?.models) return { list: reported.models.list, at, refreshing: false, reason: reported.models.error ?? null };
    // Asked of nothing it could not run: not installed there, or a version this program's
    // commands do not work on. Only then is a silent client an old one.
    const reason = !options.nodes.connected(machine.id) ? modelText.machineOffline
      : reported === null ? modelText.machineNoExecutor
      : !reported.installed ? modelText.machineNotInstalled
      : reported.unusable !== undefined ? reported.unusable
      // Its version could not be read, and so nothing else was asked: the machine said why.
      : reported.version === null && reported.error !== undefined ? reported.error
      : modelText.machineSilent;
    return { list: [], at: null, refreshing: false, reason };
  }

  // A machine's own login of one executor as the machines page shows it: what the machine
  // last said about being signed in and about its models, the owner's settings for it when
  // there are any, and what the service has learned using it.
  // `reported` is what the machine said of this executor, null when it said nothing of it;
  // `at` is when it said so.
  function machineLoginView(machine: MachineRecord, executor: string, reported: NodeExecutorStatus | null, at: string | null) {
    const signedIn = reported?.installed ? reported.logged_in : null;
    const held = options.logins.machineLogins().find((login) => login.machine === machine.id && login.executor === executor);
    const id = held?.id ?? null;
    const now = (options.now ?? Date.now)();
    const state = id === null ? undefined : ledger.loginState(id);
    const identity = reported?.installed === false || signedIn === false ? undefined
      : id === null ? reported?.identity : state?.identity;
    const aliases = typeof ledger.loginAliases === 'function' ? ledger.loginAliases() : {};
    return {
      id, name: `${machine.id}/${executor}`, executor, signed_in: signedIn,
      display_name: id ? aliases[id] ?? null : null,
      account_label: identity?.accountLabel ?? null,
      plan_label: identity?.planLabel ?? null,
      route_label: identity?.routeLabel ?? null,
      routes: identity?.routes ?? [],
      configured: held !== undefined,
      can_route: (options.accounts.canRoute?.(executor) ?? false) && machine.id === ledger.hostMachine(),
      router_reason: machine.id !== ledger.hostMachine() ? '不在主机上' : null,
      tiers: held === undefined ? {} : { ...held.tiers },
      ...(held?.retiredTiers ? { retired_tiers: held.retiredTiers } : {}),
      permission_mode: held?.permissionMode ?? null,
      timeout_ms: held?.timeoutMs ?? null,
      max_runs: held?.maxRuns ?? null,
      status: held === undefined ? { active_runs: 0, max_runs: null, rest: null, usage: [] } : loginStatus(ledger, held, now),
      models: machineModels(machine, reported, at),
      queued_tasks: held === undefined ? 0 : queuedFor(held.id),
      // The two facts dispatch goes by, from the one place each is judged: whether its
      // executor refused it under a round, and whether its machine's word lets it work there.
      refused: loginRefused(state, null),
      usable_here: ownLoginHere(reported),
    };
  }

  const machineView = (machine: MachineRecord) => {
    // What the machine last said was running on it, counted as what it is: the rounds with a
    // process, and the ones it could not read. The rounds it merely holds are neither (§4.3).
    const runs = options.nodes.reportedRuns(machine.id);
    // And what it last read from its own executors: a fact about that machine and the user it
    // runs as, never an account (nodes.md §1.2). Null until it has said.
    const reported = options.nodes.reportedExecutors(machine.id);
    // Each read by this host's own declarations: whether it offers read-only, and whether its
    // version is one this host's commands work on.
    const judge = options.accounts.judgeReport;
    const executors = reported === null ? null : { ...reported, executors: reported.executors.map((entry) => {
      const item = judge === undefined ? entry : judge(entry);
      if (!item.identity) return item;
      const { quotaOwner: _owner, ...identity } = item.identity;
      return { ...item, identity };
    }) };
    // Its own logins: every executor it says it is signed in to, and every one the owner has
    // set up here, signed in now or not (docs/design/accounts-machines-decoupled.md).
    const said = new Map((reported?.executors ?? []).map((each) => [each.executor, each]));
    const set = options.logins.machineLogins().filter((login) => login.machine === machine.id).map(({ executor }) => executor);
    const own = [...new Set([...[...said.values()].filter((each) => each.installed && each.logged_in !== false).map(({ executor }) => executor), ...set])];
    return {
      id: machine.id, uid: machine.uid, host: machine.host, note: machine.note ?? null,
      created_at: machine.created_at, updated_at: machine.updated_at,
      logins: own.map((executor) => machineLoginView(machine, executor, said.get(executor) ?? null, reported?.at ?? null)),
      // Which client it is, and whether it is here now. Nothing here is a secret; the token's
      // hash never leaves the ledger.
      node: {
        node_id: machine.nodeId,
        platform: machine.platform ?? null,
        joined_at: machine.joinedAt ?? null,
        last_seen_at: options.nodes.lastSeen(machine.id),
        connected: options.nodes.connected(machine.id),
        reported_runs: runs.filter((run) => run.alive === true).length,
        reported_unknown: runs.filter((run) => run.alive === null).length,
        source: machine.source ?? null,
        ephemeral: machine.ephemeral === true,
        scope: machine.scope ?? null,
        // The endings of a spawned machine, each its own fact (nodes.md §1.3).
        ends: machine.ephemeral === true ? machineEnds(machine, machine.inviteId === undefined ? undefined : ledger.getInvite(machine.inviteId), ledger.roundsOn(machine.id).unread) : null,
        executors,
        // What it did with the global entry, as it said (knowledge §4.3).
        entry: options.nodes.reportedEntry(machine.id),
        // Read-only metadata index of non-mirror local skills on this node (zero body/scripts).
        local_skills: options.nodes.reportedSkills?.(machine.id)?.local_skills ?? [],
        // What version it runs and what it is doing about being behind this host (§1.4).
        // Null: a client too old to report it.
        release: options.nodes.reportedRelease(machine.id),
        service_manager: options.nodes.reportedServiceManager(machine.id),
        bounded_output:options.nodes.boundedOutput(machine.id)?1:null,
        output: (() => {
          const report = options.nodes.reportedOutput(machine.id);
          if (!report) return null;
          const unknown_sources = report.references.items.filter((ref) => {
            try {
              const runId = ref.run_dir.split('/')[3];
              if (!runId) return true;
              const run = ledger.getRun(runId);
              return JSON.parse(run.snapshot_json).output_capture?.source !== ref.source || run.node_id !== machine.nodeId || run.machine_id !== machine.id;
            } catch {
              return true;
            }
          }).length;
          return { ...report, unknown_sources };
        })(),
      },
    };
  };

  // --- the machines that come back by themselves (nodes.md §8.2, §5.3) --------------

  // §8.1: the version is checked before anything else is read. A mismatch is said as one,
  // never as a machine that has gone: that would judge a Run lost for being out of date. It
  // is also recorded against the machine, which is what keeps the judgment from happening
  // later anyway (§5.3).
  function checkProtocol(body: Record<string, unknown>, machine?: MachineRecord): void {
    if (body.protocol === NODE_PROTOCOL) {
      if (machine) options.nodes.clearProtocol(machine.id);
      return;
    }
    if (machine) options.nodes.noteProtocol(machine.id, typeof body.protocol === 'number' && Number.isInteger(body.protocol) ? body.protocol : null);
    throw new HttpError(426, typeof body.protocol === 'number' && Number.isInteger(body.protocol)
      ? protocolMismatchText(body.protocol)
      : `请求里没有协议版本：主机的是第 ${NODE_PROTOCOL} 版`);
  }

  // §6: while the ledger cannot take a write, no machine is given anything to do — not a
  // command, not the snapshot that would be started on, not the token a start would run on.
  function requireNodeSteady(): void {
    const { degraded, recovering } = ledger.dispatchConditions();
    if (degraded) throw new DegradedError('账本写入失败，服务处于降级模式，现在不给机器派活');
    if (recovering) throw new DegradedError('服务正在恢复清点，现在不给机器派活');
  }

  // The only node route without a token. The secret it hands back is kept by the machine
  // that asked; the host keeps only its hash, and only until it is collected.
  function nodeJoin({ request, response, outside }: Asked): Promise<void> {
    return readJson(request).then((body) => {
      checkProtocol(body);
      const claim = body.claim as { secret?: unknown } | undefined;
      // The other way in: a one-time material from a quota (nodes.md §1.3). No request to
      // approve is made; the ledger's answer is the whole of it.
      if (body.invite !== undefined) {
        requireNodeSteady();
        sendJson(response, 200, options.nodes.redeem(body.facts, body.invite, { actor: 'service' }));
        return;
      }
      // This host's own user, joining from this machine (§1.1 step 2). Only on the inside
      // listener: whatever comes in by the outside one is from the internet, whatever
      // address it shows. A token that does not match goes the ordinary way, unremarked.
      if (claim === undefined && !outside && LOOPBACK.has(request.socket.remoteAddress ?? '') && sameSecret(body.local_token, shutdownToken)) {
        requireNodeSteady();
        sendJson(response, 200, options.nodes.admitLocal(body.facts, { actor: 'service' }));
        return;
      }
      if (claim === undefined) {
        const created = options.nodes.register(body.facts);
        sendJson(response, 201, { protocol: NODE_PROTOCOL, state: 'pending', ...created });
        return;
      }
      const answer = options.nodes.claim(claim.secret);
      sendJson(response, answer.state === 'rejected' ? 403 : 200, answer);
    });
  }

  async function nodePoll({ request, response, node }: Asked & { node: MachineRecord }): Promise<void> {
    const body = await readJson(request);
    checkProtocol(body, node);
    requireNodeSteady();
    const runs = Array.isArray(body.runs) ? body.runs as NodeRunSummary[] : [];
    const abort = new AbortController();
    // The machine is gone when its request is: the hold ends rather than sitting out. A
    // response that has finished writing its answer is not that — 'close' comes with every
    // finished response too — and what the machine took is said by its next poll either way
    // (service/nodes.ts). A response destroyed before it finished is a connection that never
    // read anything, so nothing may be counted as handed to it.
    response.once('close', () => {
      if (!response.writableFinished) abort.abort();
    });
    const output=body.bounded_output===1?outputReport(body.output):undefined;
    const output_releases=releasesFor(ledger,node.id,node.nodeId!,output);
    const command = await options.nodes.poll(node.id, {
      service_manager:body.service_manager, bounded_output:body.bounded_output,output,output_ready:output_releases.length>0,
      runs,
      facts: (body.facts ?? {}) as NodeFacts,
      cursor: typeof body.cursor === 'string' ? body.cursor : null,
      // What the machine read from its own executors, as it reported it (nodes.md §1.2).
      ...(body.executors === undefined ? {} : { executors: body.executors }),
      // What it did with the global entry content it was last given (knowledge §4.3).
      ...(body.entry === undefined ? {} : { entry: body.entry }),
      ...(body.skills === undefined ? {} : { skills: body.skills }),
      // How the sign-ins it runs are going (service/sign-ins.ts).
      ...(body.sign_ins === undefined ? {} : { sign_ins: body.sign_ins }),
      // Whether it can be told to drop a Task's code copy (service/retention.ts).
      ...(body.drops_task_code === undefined ? {} : { drops_task_code: body.drops_task_code }),
    }, abort.signal, (holdMs) => {
      // The machine learns the hold from the poll itself, before it waits it out.
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', [NODE_HOLD_HEADER]: String(holdMs) });
      response.flushHeaders();
    });
    if (response.writableEnded || response.destroyed) return;
    // The content in force when the answer goes out, to a machine whose copy is behind it. A
    // client that reports no entry is from before it, and is never given one.
    const said = body.entry as { digest?: unknown } | undefined;
    // A content that cannot be read now waits for a later poll: it never fails this one.
    let entry: NodeEntryContent | undefined;
    try {
      entry = said === undefined ? undefined : options.globalEntry?.content();
    } catch {
      entry = undefined;
    }
    const saidSkills = body.skills as { digest?: unknown } | undefined;
    let skillsManifest: NodeSkillsManifest | undefined;
    if (saidSkills !== undefined) {
      try {
        const registry = ledger.skillRegistry();
        const entryMachines = ledger.entryMachines();
        const activeIds = ledger.listEntries().filter((each) => each.kind === 'skill').map((each) => each.id).sort();
        const skillsDir = ledger.skillsDirPath();
        const cacheKey = JSON.stringify([skillsDir, registry, entryMachines, activeIds]);
        const nowMs = options.now?.() ?? Date.now();
        const cached = skillsManifestCache.get(node.id);
        if (cached !== undefined && cached.key === cacheKey && nowMs - cached.at < SKILLS_MANIFEST_CACHE_TTL_MS) {
          skillsManifest = cached.manifest;
        } else {
          skillsManifest = buildMachineSkillsManifest({
            skillsDir,
            registry,
            entryMachines,
            activeLedgerIds: new Set(activeIds),
            machineId: node.id,
          });
          skillsManifestCache.set(node.id, { key: cacheKey, at: nowMs, manifest: skillsManifest });
        }
      } catch {
        skillsManifest = undefined;
      }
    }
    const startRun = command?.kind === 'start' && ledger.hasRun(command.run_id)
      ? ledger.getRun(command.run_id)
      : undefined;
    const outgoingCommand = command?.kind === 'start' && runNeedsGitHubToken(startRun) && options.github?.readToken()
      ? { ...command, github: true as const }
      : command ?? null;
    const answer: NodePollAnswer = {
      ...(body.bounded_output===1?{output_policy:policyOf(name=>options.settings.get(name)),output_releases}:{}),
      protocol: NODE_PROTOCOL, command: outgoingCommand, look_every_ms: options.nodeLookEveryMs(),
      models_timeout_ms: options.nodeModelListTimeoutMs(),
      quota_timeout_ms: options.nodeQuotaReadTimeoutMs(),
      // Read as the answer goes out: a sign-in this answer starts is already in it.
      sign_ins: options.signIns?.listFor(node.id) ?? [],
      ...(entry === undefined || said?.digest === entry.digest ? {} : { entry }),
      ...(skillsManifest === undefined || saidSkills?.digest === skillsManifest.digest ? {} : { skills: skillsManifest }),
    };
    if (response.headersSent) response.end(JSON.stringify(answer));
    else sendJson(response, 200, answer);
  }

  // Whether this machine's token is taken right now, answered without touching the queue:
  // a status question must not consume the command the machine was about to be given.
  async function nodeStatus({ request, response, node }: Asked & { node: MachineRecord }): Promise<void> {
    checkProtocol(await readJson(request), node);
    sendJson(response, 200, { protocol: NODE_PROTOCOL, machine_id: node.id, connected: options.nodes.connected(node.id) });
  }

  async function nodeReport({ request, response, node }: Asked & { node: MachineRecord }): Promise<void> {
    const body = await readJson(request);
    checkProtocol(body, node);
    if (typeof body.command_id !== 'string') throw new InputError('回报里没有命令 id');
    const known = options.nodes.report(node.id, body.command_id, body.ok === true, body.result, typeof body.error === 'string' ? body.error : undefined);
    sendJson(response, 202, { accepted: known });
  }

  // The snapshot travels to the machine, not from it: it fetches the files and reports
  // what it wrote (nodes.md §3, §6's last line). Where the round's code comes from is one
  // of those files (`source.json`); nothing binary travels beside them.
  function nodeSnapshot({ response, params, node }: Asked & { node: MachineRecord }): void {
    requireNodeSteady();
    const runId = params[0]!;
    const held = ledger.getRun(runId);
    if (!held) throw new InputError(`没有这一轮：${runId}`);
    if (!isThisMachine(held, node)) throw new HttpError(403, '这一轮不在这台机器上');
    const snapshot = options.roundSnapshot(runId);
    if (!snapshot) throw new InputError(`这一轮 ${runId} 没有可下的快照`);
    sendJson(response, 200, { protocol: NODE_PROTOCOL, ...snapshot });
  }

  // Only writable project runs associated with a GitHub repository receive the host-managed
  // GitHub token; read-only runs, knowledge tasks, and non-GitHub projects never do.
  function runNeedsGitHubToken(run: RunRow | undefined): boolean {
    if (!run || run.state === 'ended') return false;
    if (!ledger.hasTask(run.task_id)) return false;
    const task = ledger.getTask(run.task_id);
    if (!task.project_id) return false;
    let snapshot: Snapshot;
    try {
      snapshot = JSON.parse(run.snapshot_json) as Snapshot;
    } catch {
      return false;
    }
    if (snapshot.access?.permission === 'read' || snapshot.role?.permission === 'read') return false;
    // If this run is bound to an explicit repository source, decide strictly from THAT
    // repository URL so a GitLab/non-GitHub repo in a mixed-source project never receives
    // the host GitHub token (or feeds it to non-GitHub hosts via GIT_ASKPASS).
    if (snapshot.source?.kind === 'repo') {
      return parseGitHubRepo(snapshot.source.url) !== null;
    }
    return ledger.projectSources(task.project_id).some(
      (source) => source.kind === 'repo' && parseGitHubRepo(source.url) !== null,
    );
  }

  // §9: the account's token, handed to the round that is being started, over the channel
  // that exists for it and nowhere else. The guard is the Run's own record: a token the
  // owner has replaced since is not this round's to use.
  async function nodeCredential({ response, params, node }: Asked & { node: MachineRecord }): Promise<void> {
    requireNodeSteady();
    const runId = params[0]!;
    const run = ledger.getRun(runId);
    if (!run) throw new InputError(`没有这一轮：${runId}`);
    if (!isThisMachine(run, node)) throw new HttpError(403, '这一轮不在这台机器上');
    const held = await options.roundCredential(runId);
    // The join materials ride the same channel (nodes.md §1.3): minted now, for this
    // round, by the host that keeps only their hashes. A round with neither has nothing here.
    const materials = options.roundInvite(runId);
    // Host-managed GitHub token rides the same channel only for eligible writable GitHub project runs.
    const githubToken = runNeedsGitHubToken(run) ? (options.github?.readToken() ?? null) : null;
    if (!held && materials === null && githubToken === null) throw new HttpError(409, '这一轮没有令牌可取');
    const answer: NodeCredentialAnswer = {
      value: held?.value ?? null,
      materials,
      ...(githubToken !== null ? { github_token: githubToken } : {}),
    };
    sendJson(response, 200, { protocol: NODE_PROTOCOL, ...answer });
  }

  // §7, §9: a Run belongs to the client identity it was dispatched to, not to the name the
  // owner reads. A machine deleted and joined again under the same name is another machine:
  // it inherits nothing of the old one, credentials included.
  function isThisMachine(run: RunRow, node: MachineRecord): boolean {
    // A round with no identity ran over SSH, on no client: it is no machine's to read.
    return runOnMachine(run, node);
  }

  // A machine's client says what version it runs and what it is doing about being behind this
  // host, and is told which version to run and where its package is (nodes.md §1.4). FROZEN
  // (shared/node-protocol.ts): no protocol check here — this is the way a client whose protocol
  // is refused finds out what to move to.
  async function nodeReleaseReport({ request, response, node }: Asked & { node: MachineRecord }): Promise<void> {
    const body = await readJson(request);
    options.nodes.noteRelease(node.id, body);
    const answer: NodeReleaseAnswer = options.nodeRelease === undefined
      ? { version: options.releases.version, package: null, why: '这台主机没有可下发的发布包', check_every_ms: options.nodeReleaseCheckMs() }
      : await options.nodeRelease.answer();
    sendJson(response, 200, answer);
  }

  // The same package, as bytes. The client asked about it first and comes here only when it
  // was given a digest and a size.
  async function nodeReleasePackage({ response }: Asked & { node: MachineRecord }): Promise<void> {
    const held = options.nodeRelease === undefined ? { why: '这台主机没有可下发的发布包' } : await options.nodeRelease.package();
    if ('why' in held) throw new HttpError(409, `主机没有可下发的发布包：${held.why}`);
    const body = await readFile(held.file);
    response.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(body.length),
      [NODE_RELEASE_VERSION_HEADER]: held.version,
      [NODE_RELEASE_SHA256_HEADER]: held.sha256,
      'Cache-Control': 'no-store',
    });
    response.end(body);
  }

  function nodeSkillPackage({ response, params, node }: Asked & { node: MachineRecord }): void {
    let slug: string;
    try {
      slug = decodeURIComponent(params[0]!);
    } catch {
      throw new InputError('技能目录名不合法');
    }
    const packed = packAuthorizedSkillBundle({
      skillsDir: ledger.skillsDirPath(),
      registry: ledger.skillRegistry(),
      entryMachines: ledger.entryMachines(),
      activeLedgerIds: new Set(ledger.listEntries().filter((each) => each.kind === 'skill').map((each) => each.id)),
      machineId: node.id,
      slug,
    });
    if (packed === null) throw new HttpError(404, '这个技能不存在或未授权给这台机器');
    response.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(packed.tarGz.length),
      'X-Tycho-Skill-Digest': packed.digest,
      'Cache-Control': 'no-store',
    });
    response.end(packed.tarGz);
  }

  // A machine the owner let in stays registered when its client leaves (the owner deletes
  // it); one a task spawned ends its registration here — its token dies with this write,
  // and the row keeps the fact (nodes.md §1.3).
  function nodeLeave({ response, node }: Asked & { node: MachineRecord }): void {
    if (node.ephemeral) ledger.leaveMachine(node.id, 'leave', { actor: 'service' });
    options.nodes.leave(node.id);
    sendJson(response, 200, { left: true });
  }

  // The console takes a quota back: no round is handed its material any more, and one
  // already out stops redeeming. The machines it made are a separate matter (nodes.md §9).
  function revokeInvite({ response, params }: Asked): void {
    requireSteady('撤销接入名额');
    ledger.revokeInvite(params[0]!, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, { revoked: true });
  }

  // A quota as the machines page shows it: what it allows, how many machines it let in,
  // and what became of its materials — a fact about the quota, said on each machine that
  // came in under it as its first ending (§1.3).
  function inviteView(invite: InviteRow) {
    return {
      id: invite.id, created_at: invite.created_at, project_id: invite.project_id, task_id: invite.task_id,
      executors: invite.executors_json === null ? null : (JSON.parse(invite.executors_json) as string[]),
      expires_at: invite.expires_at, max_machines: invite.max_machines, used: invite.used, revoked_at: invite.revoked_at,
      last_handed_at: invite.last_handed_at, last_run_id: invite.last_run_id,
      material: materialEnd(invite),
      machines: options.machines.list().filter((machine) => machine.inviteId === invite.id).map(({ id }) => id),
    };
  }

  // What the console's machine page shows about the machines asking to be let in.
  function listJoins({ response }: Asked): void {
    sendJson(response, 200, { protocol: NODE_PROTOCOL, joins: options.nodes.pendingJoins() });
  }

  // A machine's name, hostname and identity are its client's (nodes.md §5.4): the note is all
  // the owner changes here. A machine is added by joining, never here.
  async function putMachine(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const body = await readJson(request);
    for (const key of Object.keys(body)) {
      if (key !== 'note') throw new InputError(key === 'id' || key === 'host' ? '机器名和主机名由机器上的客户端报上来，改不了：要换名字就在那台机器上用 --name 重新加入' : '机器没有 ' + key + ' 这一项');
    }
    if (!Object.hasOwn(body, 'note')) throw new InputError('没有要改的');
    requireSteady('改机器');
    if (!options.machines.get(id)) throw new InputError('机器不存在：' + id);
    const machine = options.machines.setNote(id, body.note ?? null, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, { machine: machineView(machine) });
  }
  async function putRole(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const body = await readJson(request);
    const names: Record<string, keyof RoleInput> = {
      name: 'name', description: 'description', default_tier: 'defaultTier', permission: 'permission', deliverable: 'deliverable', needs_review: 'needsReview',
    };
    const input: RoleInput = {};
    for (const [key, value] of Object.entries(body)) {
      const field = Object.hasOwn(names, key) ? names[key] : undefined;
      if (!field) throw new InputError('职能没有 ' + key + ' 这一项');
      input[field] = value;
    }
    const { role, created } = roles.put(id, input, { actor: CONSOLE_ACTOR });
    sendJson(response, created ? 201 : 200, { role, created });
  }

  // The owner picks a Task's role and its tier from the page. `tier` null is the role's
  // default; a tier is an override, whose reason the owner may leave out (§3.3).
  async function putTaskRole(request: IncomingMessage, response: ServerResponse, taskId: string): Promise<void> {
    const body = await readJson(request);
    for (const key of Object.keys(body)) if (!['role_id', 'tier', 'reason'].includes(key)) throw new InputError('任务的职能没有 ' + key + ' 这一项');
    const { role_id, tier, reason } = body as { role_id?: unknown; tier?: unknown; reason?: unknown };
    if (role_id !== undefined && typeof role_id !== 'string') throw new InputError('职能要是一个职能的标识');
    if (tier !== undefined && tier !== null && typeof tier !== 'string') throw new InputError('档位要是决策档、执行档之一，或者不指定');
    if (reason !== undefined && reason !== null && typeof reason !== 'string') throw new InputError('理由应为文字');
    if (role_id === undefined && tier === undefined) throw new InputError('没有要改的');
    const task = ledger.updateTask(taskId, {
      ...(role_id === undefined ? {} : { roleId: role_id }),
      ...(tier === undefined ? {} : { tierOverride: tier === null ? null : { tier: tier as string, reason: (reason as string | null | undefined) ?? null } }),
    }, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, { task });
  }

  function deleteMachine(response: ServerResponse, id: string, confirmed: boolean): void {
    requireSteady('删机器');
    options.machines.remove(id, { actor: CONSOLE_ACTOR }, { confirmed });
    sendJson(response, 200, { deleted: true });
  }
  async function checkMachine(response: ServerResponse, id: string): Promise<void> {
    const machine = options.machines.get(id);
    if (!machine) throw new InputError('机器不存在：' + id);
    if (!options.runner) throw new HttpError(503, '执行服务不可用');
    sendJson(response, 200, await options.runner.checkMachine(machine));
  }

  const DIR_COMMAND_TIMEOUT_MS = 15_000;

  async function runMachineDirCommand(uid: string, command: { kind: 'browse_dirs'; path?: string; show_hidden?: boolean } | { kind: 'create_dir'; parent: string; name: string } | { kind: 'rename_dir'; path: string; name: string }): Promise<unknown> {
    const machine = ledger.listMachines().find((each) => each.uid === uid);
    if (!machine) throw new InputError(`机器登记不存在：${uid}`);
    if (!options.nodes.send) throw new HttpError(503, '这个服务不支持远程目录浏览');
    if (!options.nodes.connected(machine.id)) throw new HttpError(409, `机器 ${machine.id} 当前不在线，无法访问目录`);
    try {
      return await options.nodes.send(machine.id, command, DIR_COMMAND_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof NodeAway) throw new HttpError(409, `机器 ${machine.id} 已断开连接，无法访问目录`);
      if (error instanceof NodeCommandTimeout) throw new HttpError(504, `机器 ${machine.id} 响应超时，请稍后重试`);
      if (error instanceof NodeRefused) {
        if (error.message.includes('不认识的命令')) {
          throw new HttpError(501, `机器 ${machine.id} 的客户端版本较旧，尚未支持远程目录操作，请等待节点自动升级或手动输入路径`);
        }
        throw new InputError(error.message);
      }
      throw error;
    }
  }

  async function browseMachineDirs(response: ServerResponse, uid: string, url: URL): Promise<void> {
    const path = url.searchParams.get('path') ?? undefined;
    const showHidden = url.searchParams.get('show_hidden') === '1';
    const result = await runMachineDirCommand(uid, { kind: 'browse_dirs', ...(path ? { path } : {}), ...(showHidden ? { show_hidden: true } : {}) });
    sendJson(response, 200, result);
  }

  async function createMachineDir(request: IncomingMessage, response: ServerResponse, uid: string): Promise<void> {
    const { parent, name } = await readJson(request);
    if (typeof parent !== 'string' || parent.trim() === '') throw new InputError('缺少父目录路径');
    if (typeof name !== 'string' || name.trim() === '') throw new InputError('请输入文件夹名称');
    const result = await runMachineDirCommand(uid, { kind: 'create_dir', parent: parent.trim(), name: name.trim() });
    sendJson(response, 201, result);
  }

  async function renameMachineDir(request: IncomingMessage, response: ServerResponse, uid: string): Promise<void> {
    const { path, name } = await readJson(request);
    if (typeof path !== 'string' || path.trim() === '') throw new InputError('缺少要重命名的目录路径');
    if (typeof name !== 'string' || name.trim() === '') throw new InputError('请输入新的文件夹名称');
    const result = await runMachineDirCommand(uid, { kind: 'rename_dir', path: path.trim(), name: name.trim() });
    sendJson(response, 200, result);
  }

  async function setWecomSecret(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { secret } = await readJson(request);
    requireSteady('改企业微信的 Secret');
    try {
      options.wecomSecret.set(secret, { actor: CONSOLE_ACTOR });
    } catch (err) {
      if (err instanceof InputError || err instanceof DegradedError || err instanceof HttpError) throw err;
      log(`保存企业微信 Secret 失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      throw new HttpError(500, 'Secret 没有存下来，请查看服务端日志');
    }
    sendJson(response, 200, { secret_set: true });
  }

  function reconnectWecom(response: ServerResponse): void {
    requireSteady('重连企业微信');
    if (!options.reconnectWecom) throw new InputError('此服务不支持企业微信重连');
    const wecom = options.reconnectWecom();
    if (!wecom) throw new InputError('还没有启用企业微信：先填好 Bot ID、接收人和 Secret');
    sendJson(response, 200, { ok: true, wecom });
  }

  // The record first: a restart the ledger cannot record does not happen.
  function restartRouter(response: ServerResponse): void {
    requireSteady('重启负责人');
    const waitingFor = session.status().turn;
    ledger.noteAction('router.restart', { actor: CONSOLE_ACTOR });
    void session.restart();
    sendJson(response, 202, { restarting: true, waiting_for_turn: waitingFor });
  }

  async function settingsPage() {
    return {
      settings: options.settings.list(),
      deployment: await options.deployment(),
      wecom: { secret_set: options.wecomSecret.isSet() },
      router: session.status(),
    };
  }

  function attachStream({ request, response, url, outside, visitor }: Asked & { visitor: Visitor }): void {
    const cookie = request.headers.cookie;
    const runs = [...new Set((url.searchParams.get('runs') ?? '').split(',').filter(Boolean))].filter((id) => ledger.getRun(id).state !== 'ended');
    // The filter validates every requested Run before attaching any listener.
    if (runs.length && !options.runner) throw new HttpError(503, '执行服务不可用');
    stream.attach(response, visitor.id, runs, () => Boolean(auth.authenticate(cookie, outside)));
    for (const id of runs) {
      let subscription = runSubscriptions.get(id);
      if (!subscription) {
        const stop = options.runner!.subscribe(id, (event, index) => stream.publish('run_event', {
          run_id: id,
          index,
          event,
        }));
        subscription = { count: 0, stop };
        runSubscriptions.set(id, subscription);
      }
      subscription.count += 1;
    }
    response.once('close', () => {
      for (const id of runs) {
        const subscription = runSubscriptions.get(id);
        if (!subscription || --subscription.count > 0) continue;
        subscription.stop();
        runSubscriptions.delete(id);
      }
    });
  }

  // One project's turn, when the page names its project; every turn under way otherwise.
  async function interrupt(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
    const projectId = typeof body.project_id === 'string' && body.project_id !== '' ? body.project_id : undefined;
    const { projects } = session.status();
    const turns = projects.filter((each) => each.turn !== null && (projectId === undefined || each.project_id === projectId));
    for (const { turn } of turns) ledger.noteInterrupt(turn!, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, { interrupted: turns.length > 0 ? session.interrupt(projectId) : false });
  }

  const consoleDir = options.consoleDir ?? CONSOLE_DIST;

  // The files of the build, by the path each is asked for. Listed on every request: a
  // build made while the service runs is served without a restart. A link is not a file.
  async function consoleFiles(): Promise<Set<string>> {
    try {
      const entries = await readdir(consoleDir, { recursive: true, withFileTypes: true });
      return new Set(entries.filter((entry) => entry.isFile())
        .map((entry) => join(relative(consoleDir, entry.parentPath), entry.name).split(sep).join('/')));
    } catch (err) {
      // Not built yet, which the page says. Anything else is a failure of its own.
      if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return new Set();
      throw err;
    }
  }

  // A request names a file only by being equal to one the listing holds; its path is
  // never made into a file name. Whatever it spells that is not in the build is not there.
  async function serveConsole(response: ServerResponse, pathname: string): Promise<boolean> {
    const files = await consoleFiles();
    let file: string;
    try {
      file = pathname === '/' ? CONSOLE_PAGE : decodeURIComponent(pathname.slice(1));
    } catch {
      return false;
    }
    if (pathname === '/' && !files.has(CONSOLE_PAGE)) {
      sendPage(response, 503, notBuiltPage());
      return true;
    }
    if (!files.has(file) || (file === CONSOLE_PAGE && pathname !== '/')) return false;
    let body: Buffer;
    try {
      body = await readFile(join(consoleDir, file));
    } catch (err) {
      // Gone since it was listed: a build is replacing the directory. It is not there,
      // which is an answer; the error would name where the files are on this machine.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // The type is the one said here: a browser does not guess another from the bytes.
      'X-Content-Type-Options': 'nosniff',
      // A hashed file never changes under its name; the page that names them is asked for
      // each time. Private: it is given behind a login, so no proxy on the way keeps a copy.
      'Cache-Control': file.startsWith(HASHED_PREFIX) ? HASHED_CACHE : 'no-cache',
      'Content-Security-Policy': CONSOLE_POLICY,
    });
    response.end(body);
    return true;
  }

  function refuseAnonymous(response: ServerResponse, api: boolean): void {
    if (api) {
      sendJson(response, 401, { error: '需要登录' });
      return;
    }
    response.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
    response.end();
  }

  // `segment`: one segment of a project's conversation; `legacy`: the old global record, and with
  // `project` the part of it linked to that project (project-sessions §6).
  function listMessages({ response, url, visitor }: Asked & { visitor: Visitor }): void {
    const after = url.searchParams.get('after') ?? undefined;
    const limit = pageSize(url.searchParams.get('limit'));
    const segmentId = url.searchParams.get('segment') ?? undefined;
    const projectId = url.searchParams.get('project') ?? undefined;
    const legacy = url.searchParams.get('legacy') === '1';
    const messages = ledger.listMessages({ ...(after ? { after } : {}), limit, ...(segmentId ? { segmentId } : {}), ...(projectId ? { projectId } : {}), ...(legacy ? { legacy } : {}) });
    // What each request's turn changed, with the page it belongs to: a conversation is drawn
    // from one read, not one more per turn. A request whose turn changed nothing is absent.
    const changes: Record<string, unknown> = {};
    for (const { id, direction } of messages) {
      if (direction !== 'in') continue;
      const turn = changesOf(id) as { changes: unknown[] };
      if (turn.changes.length > 0) changes[id] = turn;
    }
    sendJson(response, 200, { messages: hydrateMessages(messages), changes });
    // Only the whole picture counts as having seen it; a page of newer rows does not.
    if (!after) markSeen(visitor.id);
  }

  function listTasks({ response, url }: Asked): void {
    if (url.searchParams.get('top') !== '1') {
      const summarize = workSummaries(ledger.listTasks(), ledger.listApprovalCards());
      sendJson(response, 200, { tasks: ledger.listTaskSummaries().map((task) => ({ ...present(task), summary: summarize(task.id) })) });
      return;
    }
    // The side column's listing, read again on every change: the open works and the most
    // recent ended ones, with the tasks under them.
    const { all, works } = listWorks();
    const shown = currentWorks(works);
    sendJson(response, 200, {
      tasks: shown.map((task) => present(task, { prefer: false })),
      children: descendants(all, shown).map((task) => present(task, { prefer: false })),
    });
  }

  // Ended works, the most recently ended first, a page at a time: by project, and by words in
  // the title or the work's id.
  function listEndedWorks({ response, url }: Asked): void {
    const count = (name: string, fallback: number, min: number, max: number): number => {
      const text = url.searchParams.get(name);
      if (text === null) return fallback;
      const value = Number(text);
      if (!/^\d+$/.test(text) || value < min || value > max) throw new InputError(`${name} 要是 ${min} 到 ${max} 之间的整数`);
      return value;
    };
    const limit = count('limit', 50, 1, 200);
    // Where the last page ended, as `next` gave it: the next page starts after that work in the
    // order of ending, so works that end or reopen between two reads move no page boundary.
    const after = url.searchParams.get('after');
    const cut = after === null ? null : /^([^|]*)\|([^|]+)$/.exec(after);
    if (after !== null && !cut) throw new InputError('after 要用上一页回答里的 next');
    const mark = cut ? { id: cut[2]!, summary: { ended_at: cut[1] || null } as WorkSummary } : null;
    const project = url.searchParams.get('project');
    const words = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const { all, works, projectOf } = listWorks();
    const matched = works
      .filter((work) => ended(work)
        && (project === null || projectOf.get(work.id) === project)
        && (!words || work.title.toLowerCase().includes(words) || work.id.toLowerCase() === words))
      .sort(byEnding);
    const rest = mark ? matched.filter((work) => byEnding(mark, work) < 0) : matched;
    const page = rest.slice(0, limit);
    const last = page.at(-1);
    sendJson(response, 200, {
      total: matched.length,
      works: page,
      children: descendants(all, page),
      next: last && rest.length > limit ? `${last.summary.ended_at ?? ''}|${last.id}` : null,
    });
  }

  function listConsoleSessions({ response, visitor }: Asked & { visitor: Visitor }): void {
    sendJson(response, 200, { sessions: auth.listSessions(visitor.id), ...auth.sessionDurations() });
  }

  function revokeConsoleSession(asked: Asked & { visitor: Visitor }): void {
    const { response, params: [id], visitor } = asked;
    if (id === visitor.id) {
      logout(asked);
      return;
    }
    if (!auth.revokeSession(id!, { actor: `console:${visitor.id}` })) throw new HttpError(404, '这台设备已经退出');
    stream.detach(id!);
    sendJson(response, 200, { ok: true });
  }

  function revokeOtherConsoleSessions({ response, visitor }: Asked & { visitor: Visitor }): void {
    const ids = auth.revokeOthers(visitor.id, { actor: `console:${visitor.id}` });
    for (const id of ids) stream.detach(id);
    sendJson(response, 200, { ok: true });
  }

  function logout({ response, outside, visitor }: Asked & { visitor: Visitor }): void {
    const cleared = auth.logout(visitor.id, outside);
    stream.detach(visitor.id);
    response.writeHead(200, { 'Set-Cookie': cleared, 'Content-Type': 'application/json; charset=utf-8' });
    response.end('{}');
  }

  async function pause({ request, response }: Asked): Promise<void> {
    const { paused } = await readJson(request);
    if (typeof paused !== 'boolean') throw new InputError('paused 应为布尔值');
    ledger.setPause(paused, { actor: CONSOLE_ACTOR });
    sendJson(response, 200, { dispatch: ledger.dispatchConditions() });
  }

  async function runPart({ response, params: [runId, part] }: Asked): Promise<void> {
    const run = ledger.getRun(runId!);
    switch (part) {
      case 'events': {
        if (!options.runner) throw new HttpError(503, '执行服务不可用');
        const { events, firstIndex, loaded, reason } = await options.runner.eventSnapshot(run);
        sendJson(response, 200, { run_id: run.id, events, first_index: firstIndex, loaded, ...(reason === undefined ? {} : { reason }) });
        break;
      }
      case 'snapshot': {
        const snapshot = JSON.parse(run.snapshot_json);
        sendJson(response, 200, {
          run_id: run.id,
          snapshot,
          executor: typeof snapshot.executor === 'string' ? snapshot.executor : null,
        });
        break;
      }
      case 'trace':
        sendJson(response, 200, traceRun(ledger, run.id));
        break;
    }
  }

  async function runDiagnostics({ response, params: [runId], url }: Asked): Promise<void> {
    let run: RunRow;
    try {
      run = ledger.getRun(runId!);
    } catch (err) {
      if (err instanceof InputError && err.message.includes('不存在')) throw new HttpError(404, err.message);
      throw err;
    }
    const task = ledger.getTask(run.task_id);
    const trace = traceRun(ledger, run.id);
    const snapshot = options.runner
      ? await options.runner.eventSnapshot(run)
      : { events: [] as readonly NormalizedEvent[], firstIndex: 0, loaded: false, reason: '执行服务不可用' };
    const stderr = options.runner?.readStderrSnippet
      ? await options.runner.readStderrSnippet(run)
      : { head: [] as string[], tail: [] as string[], loaded: false, reason: undefined as string | undefined };
    const bundle = buildRunDiagnostics({
      run,
      task,
      trace,
      events: snapshot.events,
      firstIndex: snapshot.firstIndex,
      loaded: snapshot.loaded,
      reason: snapshot.reason ?? null,
      stderrHead: stderr.head,
      stderrTail: stderr.tail,
      stderrLoaded: stderr.loaded,
      stderrReason: stderr.reason ?? null,
      platformVersion: options.releases.version,
    });
    if (url.searchParams.get('download') === '1') {
      const safeId = run.id.replace(/[^A-Za-z0-9._-]/g, '_');
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="tycho-run-${safeId}-diagnostics.json"`,
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(bundle, null, 2));
      return;
    }
    sendJson(response, 200, bundle);
  }

  async function taskFacts({ response, params: [taskId] }: Asked): Promise<void> {
    const task = ledger.getTask(taskId!);
    const runs = ledger.listRuns(task.id);
    const reviewChanges = ledger.reviewsOf(task.id).flatMap((review) =>
      ledger.listChanges({ taskId: review.id }).filter((change) => change.action === 'review.verdict'),
    );
    const changes = [...ledger.listChanges({ taskId: task.id }), ...reviewChanges];
    const eventsByRun = new Map<string, readonly NormalizedEvent[]>();
    const coverageByRun = new Map<string, { loaded: boolean; firstIndex?: number; reason?: string | null }>();
    if (options.runner) {
      const CONCURRENCY = 4;
      let cursor = 0;
      const worker = async () => {
        while (cursor < runs.length) {
          const run = runs[cursor++]!;
          try {
            const snap = await options.runner!.eventSnapshot(run);
            eventsByRun.set(run.id, snap.events);
            coverageByRun.set(run.id, { loaded: snap.loaded, firstIndex: snap.firstIndex, reason: snap.reason ?? null });
          } catch (err) {
            eventsByRun.set(run.id, []);
            coverageByRun.set(run.id, { loaded: false, reason: (err as Error).message || '读取执行事件失败' });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, runs.length) }, worker));
    } else {
      for (const run of runs) {
        coverageByRun.set(run.id, { loaded: false, reason: '执行服务不可用' });
      }
    }
    sendJson(response, 200, extractTaskFacts({ task, runs, changes, eventsByRun, coverageByRun }));
  }

  function desktopReleasesDir(): string | null {
    const base = options.dataDir ?? options.releases?.dataDir;
    return base ? join(base, 'desktop-releases') : null;
  }

  function desktopLatest({ response, url }: Asked): void {
    const dir = desktopReleasesDir();
    if (!dir) {
      sendJson(response, 200, { version: null });
      return;
    }
    const manifestPath = join(dir, 'latest.json');
    if (!existsSync(manifestPath)) {
      sendJson(response, 200, { version: null });
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        version?: unknown;
        published_at?: unknown;
        notes?: unknown;
        platforms?: Record<string, { filename?: unknown; sha256?: unknown; size?: unknown; installer_filename?: unknown; installer_sha256?: unknown }>;
      };
      const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null;
      if (!version || !raw.platforms || typeof raw.platforms !== 'object') {
        sendJson(response, 200, { version: null });
        return;
      }
      const platform = url.searchParams.get('platform')?.trim() || '';
      const arch = url.searchParams.get('arch')?.trim() || '';
      const key = platform && arch ? `${platform}-${arch}` : platform;
      const picked = key ? raw.platforms[key] : undefined;
      const safeArtifact = (entry: { filename?: unknown; sha256?: unknown; size?: unknown; installer_filename?: unknown; installer_sha256?: unknown } | undefined) => {
        if (!entry || typeof entry.filename !== 'string' || !nameIsSafe(entry.filename)) return null;
        const sha256 = typeof entry.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(entry.sha256) ? entry.sha256.toLowerCase() : null;
        if (!sha256 || !existsSync(join(dir, entry.filename))) return null;
        const installerFilename = typeof entry.installer_filename === 'string' && nameIsSafe(entry.installer_filename) && existsSync(join(dir, entry.installer_filename))
          ? entry.installer_filename
          : null;
        const installerSha256 = installerFilename && typeof entry.installer_sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(entry.installer_sha256)
          ? entry.installer_sha256.toLowerCase()
          : null;
        return {
          filename: entry.filename,
          sha256,
          size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : statSync(join(dir, entry.filename)).size,
          url: `/api/desktop/download/${encodeURIComponent(entry.filename)}`,
          ...(installerFilename && installerSha256 ? {
            installer_filename: installerFilename,
            installer_sha256: installerSha256,
            installer_url: `/api/desktop/download/${encodeURIComponent(installerFilename)}`,
          } : {}),
        };
      };
      const artifact = key ? safeArtifact(picked) : null;
      const platforms = Object.fromEntries(
        Object.entries(raw.platforms)
          .map(([k, v]) => [k, safeArtifact(v)] as const)
          .filter(([, v]) => v !== null),
      );
      sendJson(response, 200, {
        version,
        published_at: typeof raw.published_at === 'string' ? raw.published_at : null,
        notes: typeof raw.notes === 'string' ? raw.notes : null,
        ...(key ? { artifact } : {}),
        platforms,
      });
    } catch {
      sendJson(response, 200, { version: null });
    }
  }

  function desktopDownload({ response, params }: Asked): void {
    const dir = desktopReleasesDir();
    const rawName = params[0] ?? '';
    let name: string;
    try { name = decodeURIComponent(rawName); } catch { throw new HttpError(400, '无效的文件名'); }
    if (!dir || !nameIsSafe(name) || !/\.(exe|dmg|AppImage|deb)$/i.test(name)) {
      throw new HttpError(404, '未找到桌面端安装包');
    }
    // Allowlist strictly against artifacts registered in latest.json so stray files in the
    // release directory are never exposed anonymously.
    const manifestPath = join(dir, 'latest.json');
    if (!existsSync(manifestPath)) throw new HttpError(404, '未找到桌面端安装包');
    const registered = new Set<string>();
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        platforms?: Record<string, { filename?: unknown; installer_filename?: unknown }>;
      };
      for (const entry of Object.values(raw.platforms ?? {})) {
        if (typeof entry?.filename === 'string' && nameIsSafe(entry.filename)) registered.add(entry.filename);
        if (typeof entry?.installer_filename === 'string' && nameIsSafe(entry.installer_filename)) registered.add(entry.installer_filename);
      }
    } catch {
      throw new HttpError(404, '未找到桌面端安装包');
    }
    if (!registered.has(name)) throw new HttpError(404, '未找到桌面端安装包');
    const filePath = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(filePath);
    } catch {
      throw new HttpError(404, '未找到桌面端安装包');
    }
    if (!st.isFile() || st.isSymbolicLink()) throw new HttpError(404, '未找到桌面端安装包');
    const stream = createReadStream(filePath);
    let headersSent = false;
    stream.on('open', () => {
      headersSent = true;
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(st.size),
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'public, max-age=3600',
      });
      stream.pipe(response);
    });
    stream.on('error', () => {
      if (!headersSent && !response.headersSent) {
        sendJson(response, 404, { error: '未找到桌面端安装包' });
      } else {
        response.destroy();
      }
    });
    response.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
  }

  const selfCheck = async ({ response }: Asked): Promise<void> => sendJson(response, 200, { checks: await options.doctor() });

  // Every route there is. The first match from the top answers.
  const routes: Route[] = [
    // For this machine's own processes, each showing the token it was given.
    { method: 'POST', path: '/tools/list', token: () => session.toolTokens(), handle: ({ request, response }: Asked) => listTools(request, response) },
    { method: 'POST', path: '/tools/call', token: () => session.toolTokens(), handle: ({ request, response }: Asked) => callTool(request, response) },
    { method: 'POST', path: '/api/login-links', token: () => loginToken, handle: createLoginLink },
    { method: 'POST', path: '/api/shutdown', token: () => shutdownToken, handle: shutdown },
    { method: 'GET', path: '/api/instance', token: () => shutdownToken, handle: ({ response }: Asked) => sendJson(response, 200, options.instance()) },
    // What only this service knows about the release it is running: a command putting a
    // new one in place asks here, and stops the service through this same token.
    { method: 'GET', path: '/api/release-check', token: () => shutdownToken, handle: ({ response }: Asked) => sendJson(response, 200, options.releaseCheck()) },
    { method: 'POST', path: '/api/drain', token: () => shutdownToken, handle: async ({ response }: Asked) => sendJson(response, 200, await options.drain()) },
    // The command on this machine asks with the token from service.json; a browser asks
    // with its cookie, further down.
    { method: 'GET', path: '/api/doctor', token: () => shutdownToken, ifShown: true, handle: selfCheck },

    { method: 'GET', path: '/api/desktop/latest', anonymous: true, outside: true, handle: desktopLatest },
    { method: 'GET', path: '/api/desktop/download/:name', anonymous: true, outside: true, handle: desktopDownload },

    // Signing in.
    { method: 'GET', path: '/login', anonymous: true, outside: true, handle: ({ response }) => sendPage(response, 200, enterPage(imLoginChannels(), { hasPassphrase: auth.hasPassphrase() })) },
    { method: 'POST', path: '/login', anonymous: true, outside: true, handle: exchangeLink },
    { method: 'POST', path: '/login/passphrase', anonymous: true, outside: true, handle: loginWithPassphrase },

    { method: 'POST', path: '/login/device', anonymous: true, outside: true, handle: beginDeviceLogin },
    { method: 'GET', path: DEVICE_LOGIN, anonymous: true, outside: true, handle: waitDeviceLogin },

    // What the pages read and do.
    { method: 'GET', path: '/api/auth/passphrase', outside: true, handle: ({ response }) => sendJson(response, 200, { enabled: auth.hasPassphrase() }) },
    { method: 'PUT', path: '/api/auth/passphrase', outside: true, handle: setPassphrase },
    { method: 'DELETE', path: '/api/auth/passphrase', outside: true, handle: clearPassphrase },
    { method: 'POST', path: '/api/admissions/lookup', outside: true, handle: asked => admission(asked, 'lookup') },
    { method: 'POST', path: '/api/admissions/approve', outside: true, handle: asked => admission(asked, 'approve') },
    { method: 'POST', path: '/api/admissions/reject', outside: true, handle: asked => admission(asked, 'reject') },
    { method: 'GET', path: '/api/console-sessions', outside: true, handle: listConsoleSessions },
    { method: 'POST', path: '/api/console-sessions/:id/revoke', outside: true, handle: revokeConsoleSession },
    { method: 'POST', path: '/api/console-sessions/revoke-others', outside: true, handle: revokeOtherConsoleSessions },
    { method: 'GET', path: '/api/messages', outside: true, handle: listMessages },
    { method: 'POST', path: '/api/messages', outside: true, handle: ({ request, response }) => postMessage(request, response) },
    { method: 'GET', path: '/api/stream', outside: true, handle: attachStream },
    { method: 'GET', path: '/api/state', outside: true, handle: ({ response }) => sendJson(response, 200, stateOf()) },
    { method: 'GET', path: '/api/tasks', outside: true, handle: listTasks },
    { method: 'GET', path: '/api/tasks/ended', outside: true, handle: listEndedWorks },
    { method: 'GET', path: '/api/summary', outside: true, handle: ({ response, visitor }) => sendJson(response, 200, summary(visitor)) },
    { method: 'GET', path: '/api/approvals', outside: true, handle: ({ response, url }) => sendJson(response, 200, { approvals: approvalCards(url.searchParams.get('state')) }) },
    { method: 'POST', path: '/api/interrupt', outside: true, handle: ({ request, response }) => interrupt(request, response) },
    { method: 'GET', path: '/api/messages/unassigned', outside: true, handle: ({ response }) => sendJson(response, 200, { messages: ledger.unassignedMessages() }) },
    { method: 'POST', path: '/api/messages/assign', outside: true, handle: ({ request, response }) => assignMessages(request, response) },
    { method: 'POST', path: '/api/logout', outside: true, handle: logout },
    { method: 'GET', path: '/api/overview', outside: true, handle: ({ response }) => sendJson(response, 200, overview()) },
    { method: 'POST', path: '/api/pause', outside: true, handle: pause },
    {
      method: 'POST', path: '/api/restore/confirm', outside: true,
      handle({ response }) {
        ledger.confirmRestore({ actor: CONSOLE_ACTOR });
        sendJson(response, 200, { confirmed: true });
      },
    },
    { method: 'POST', path: '/api/backup', outside: true, handle: async ({ response }) => sendJson(response, 200, await options.backup.trigger()) },
    { method: 'GET', path: '/api/settings', outside: true, handle: async ({ response }) => sendJson(response, 200, await settingsPage()) },
    {
      method: 'GET', path: '/api/themes', outside: true,
      handle({ response }) {
        const dir = options.dataDir ?? options.releases?.dataDir;
        if (!dir) return sendJson(response, 200, { dir: null, themes: [] });
        sendJson(response, 200, { dir: themesDirOf(dir), themes: listDirectoryThemes(dir) });
      },
    },
    {
      method: 'POST', path: '/api/themes', outside: true,
      async handle({ request, response }) {
        const dir = requireDataDir();
        const body = await readJson(request);
        const saved = saveDirectoryTheme(dir, body);
        if (!saved.ok) throw new HttpError(400, saved.error);
        sendJson(response, 200, { dir: themesDirOf(dir), theme: saved.pack });
      },
    },
    {
      method: 'DELETE', path: '/api/themes/:id', outside: true,
      handle({ response, params }) {
        const dir = requireDataDir();
        const removed = deleteDirectoryTheme(dir, params[0]!);
        if (!removed) throw new HttpError(404, '找不到这个主题插件');
        sendJson(response, 200, { deleted: true });
      },
    },
    {
      method: 'GET', path: '/api/locales', outside: true,
      handle({ response }) {
        const dir = options.dataDir ?? options.releases?.dataDir;
        if (dir) syncDirectoryLocales(dir);
        sendJson(response, 200, {
          dir: dir ? localesDirOf(dir) : null,
          active: getActiveLocale(),
          locales: listLocalePackSummaries(),
        });
      },
    },
    {
      method: 'GET', path: '/api/locales/template', outside: true,
      handle({ url, response }) {
        const dir = options.dataDir ?? options.releases?.dataDir;
        if (dir) syncDirectoryLocales(dir);
        const base = url.searchParams.get('base') ?? 'en';
        sendJson(response, 200, exportLocaleTemplate(normalizeLocale(base)));
      },
    },
    {
      method: 'GET', path: '/api/locales/:id', outside: true,
      handle({ response, params }) {
        const dir = options.dataDir ?? options.releases?.dataDir;
        if (dir) syncDirectoryLocales(dir);
        const pack = getLocalePack(params[0]!);
        if (!pack) throw new HttpError(404, `Language pack not found: ${params[0]}`);
        sendJson(response, 200, {
          pack,
          resolved_messages: getResolvedMessages(pack.id),
        });
      },
    },
    {
      method: 'POST', path: '/api/locales', outside: true,
      async handle({ request, response }) {
        const dir = requireDataDir();
        const body = await readJson(request);
        const saved = saveDirectoryLocale(dir, body);
        if (!saved.ok) throw new HttpError(400, saved.error);
        const active = normalizeLocale(options.settings.get('ui.locale'));
        setActiveLocale(active);
        sendJson(response, 200, {
          dir: localesDirOf(dir),
          locale: saved.pack,
          locales: listLocalePackSummaries(),
        });
      },
    },
    {
      method: 'DELETE', path: '/api/locales/:id', outside: true,
      handle({ response, params }) {
        const dir = requireDataDir();
        const removed = deleteDirectoryLocale(dir, params[0]!);
        if (!removed) throw new HttpError(404, '找不到这个扩展语言包');
        const active = normalizeLocale(options.settings.get('ui.locale'));
        setActiveLocale(active);
        sendJson(response, 200, {
          deleted: true,
          active: getActiveLocale(),
          locales: listLocalePackSummaries(),
        });
      },
    },
    { method: 'GET', path: '/api/doctor', outside: true, handle: selfCheck },

    { method: 'GET', path: '/api/machines', outside: true, handle: ({ response }) => sendJson(response, 200, { machines: options.machines.list().map(machineView), invites: ledger.listInvites().map(inviteView), host_machine: ledger.hostMachine(), host_entry: options.globalEntry?.hostReport() ?? null, host_version: options.releases.version, public_url: options.publicUrl?.() || null }) },
    {
      method: 'GET', path: '/api/executors/updates', outside: true,
      handle: ({ response }) => {
        if (!options.executorUpdates) throw new HttpError(503, '执行器更新服务未启用');
        sendJson(response, 200, options.executorUpdates.status());
      },
    },
    {
      method: 'POST', path: '/api/executors/updates/check', outside: true,
      handle: async ({ response }) => {
        if (!options.executorUpdates) throw new HttpError(503, '执行器更新服务未启用');
        await options.executorUpdates.refreshUpstream(true);
        sendJson(response, 200, options.executorUpdates.status());
      },
    },
    {
      method: 'POST', path: '/api/executors/updates/run', outside: true,
      handle: async ({ request, response }) => {
        if (!options.executorUpdates) throw new HttpError(503, '执行器更新服务未启用');
        const body = await readJson(request);
        const executor = typeof body.executor === 'string' ? body.executor.trim() : '';
        if (!executor) throw new InputError('请指定要更新的执行器');
        const machineIds = Array.isArray(body.machine_ids)
          ? body.machine_ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
          : undefined;
        const queued = options.executorUpdates.triggerUpdate({
          executor,
          ...(machineIds && machineIds.length > 0 ? { machineIds } : {}),
          trigger: 'manual',
        });
        sendJson(response, 200, { queued, status: options.executorUpdates.status() });
      },
    },
    {
      method: 'PUT', path: '/api/executors/updates/policy', outside: true,
      handle: async ({ request, response }) => {
        if (!options.executorUpdates) throw new HttpError(503, '执行器更新服务未启用');
        const body = await readJson(request);
        const policy = options.executorUpdates.setPolicy(body);
        sendJson(response, 200, { policy, status: options.executorUpdates.status() });
      },
    },
    { method: 'DELETE', path: '/api/invites/:id', outside: true, handle: revokeInvite },
    { method: 'POST', path: '/api/machines/:id/check', outside: true, handle: ({ response, params }) => checkMachine(response, accountId(params[0]!)) },
    { method: 'PUT', path: '/api/machines/:id', outside: true, handle: ({ request, response, params }) => putMachine(request, response, accountId(params[0]!)) },
    { method: 'DELETE', path: '/api/machines/:id', outside: true, handle: ({ response, url, params }) => deleteMachine(response, accountId(params[0]!), url.searchParams.get('confirm') === '1') },
    // The machines that come back by themselves (nodes.md §8.2). `join` is the only node
    // route without a token: the six digits point at a request, and the secret the machine
    // kept is what exchanges for the token. Everything else takes a node token only.
    { method: 'POST', path: '/api/node/join', anonymous: true, outside: true, handle: nodeJoin },
    { method: 'POST', path: '/api/node/poll', node: true, outside: true, handle: nodePoll },
    { method: 'POST', path: '/api/node/status', node: true, outside: true, handle: nodeStatus },
    { method: 'POST', path: '/api/node/report', node: true, outside: true, handle: nodeReport },
    { method: 'GET', path: '/api/node/runs/:id/snapshot', node: true, outside: true, handle: nodeSnapshot },
    { method: 'POST', path: '/api/node/runs/:id/credential', node: true, outside: true, handle: nodeCredential },
    { method: 'POST', path: '/api/node/leave', node: true, outside: true, handle: nodeLeave },
    // FROZEN (nodes.md §1.4, shared/node-protocol.ts): no protocol check, and the shapes never
    // change. They are how a client whose protocol is refused finds and fetches the version.
    { method: 'POST', path: NODE_RELEASE_PATH, node: true, outside: true, handle: nodeReleaseReport },
    { method: 'GET', path: NODE_RELEASE_PACKAGE_PATH, node: true, outside: true, handle: nodeReleasePackage },
    { method: 'GET', path: `${NODE_SKILLS_PACKAGE_PREFIX}/:slug`, node: true, outside: true, handle: nodeSkillPackage },
    // What the owner does about them from the console.
    { method: 'GET', path: '/api/node/joins', outside: true, handle: listJoins },
    { method: 'GET', path: '/api/roles', outside: true, handle: ({ response }) => sendJson(response, 200, { roles: roles.list() }) },
    { method: 'PUT', path: '/api/roles/:id', outside: true, handle: ({ request, response, params }) => putRole(request, response, accountId(params[0]!)) },
    {
      method: 'DELETE', path: '/api/roles/:id', outside: true,
      handle: ({ response, params }) => { roles.remove(accountId(params[0]!), { actor: CONSOLE_ACTOR }); sendJson(response, 200, { deleted: true }); },
    },
    { method: 'GET', path: '/api/knowledge', outside: true, handle: ({ response }) => sendJson(response, 200, knowledgePage()) },
    {
      method: 'GET', path: '/api/knowledge/effective', outside: true,
      handle: ({ url, response }) => {
        const projectId = url.searchParams.get('project_id');
        const roleId = url.searchParams.get('role_id');
        const machineId = url.searchParams.get('machine_id');
        sendJson(response, 200, ledger.effectiveContext(
          projectId === null || projectId === '' ? null : projectId,
          roleId === null || roleId === '' ? null : roleId,
          knowledgeLimits(options.settings),
          machineId === null || machineId === '' ? null : machineId,
        ));
      },
    },
    {
      method: 'PUT', path: '/api/knowledge/registry/:slug', outside: true,
      handle: async ({ request, response, params }) => {
        requireSteady('修改技能绑定');
        let slug: string;
        try {
          slug = decodeURIComponent(params[0]!);
        } catch {
          throw new InputError('技能目录名不合法');
        }
        const binding = ledger.putSkillBinding(slug, await readJson(request), { actor: CONSOLE_ACTOR });
        sendJson(response, 200, { slug, binding });
      },
    },
    {
      method: 'PUT', path: '/api/knowledge/entries/:id/machines', outside: true,
      handle: async ({ request, response, params }) => {
        requireSteady('修改条目可用机器');
        const machineIds = ledger.putEntryMachines(params[0]!, await readJson(request), { actor: CONSOLE_ACTOR });
        sendJson(response, 200, { entry_id: params[0]!, machine_ids: machineIds });
      },
    },
    {
      method: 'POST', path: '/api/knowledge/proposals/review-all', outside: true,
      handle: ({ response }) => sendJson(response, 200, ledger.markAllReviewed(CONSOLE_ACTOR)),
    },
    { method: 'GET', path: '/api/knowledge/proposals/:id', outside: true, handle: ({ response, params }) => sendJson(response, 200, proposalPage(params[0]!)) },
    {
      method: 'POST', path: '/api/knowledge/proposals', outside: true,
      handle: async ({ request, response }) => sendJson(response, 201, ledger.propose(await readJson(request), ownerProposer, { actor: CONSOLE_ACTOR })),
    },
    { method: 'POST', path: '/api/knowledge/proposals/:id/:action(decide|amend|review)', outside: true, handle: knowledgeAction },
    { method: 'GET', path: '/api/knowledge/entries/:id', outside: true, handle: ({ response, params }) => sendJson(response, 200, entryPage(params[0]!)) },
    {
      method: 'POST', path: '/api/knowledge/entries/:id/retire', outside: true,
      handle: async ({ request, response, params }) => {
        const body = await readJson(request);
        ledger.retireEntry(params[0]!, { reason: body.reason, replacedBy: body.replaced_by, revision: body.revision }, { actor: CONSOLE_ACTOR });
        sendJson(response, 200, { entry: ledger.getEntry(params[0]!) });
      },
    },
    // The owner's explicit import of the old skill files (knowledge §6): a preview, or the import.
    // Local-only: reads a filesystem path on this machine, so never exposed on the outside listener.
    {
      method: 'POST', path: '/api/knowledge/skills/import',
      handle: async ({ request, response }) => {
        const body = await readJson(request);
        const dir = typeof body.dir === 'string' && body.dir.trim() !== '' ? body.dir.trim() : options.skillFolder;
        if (!isAbsolute(dir)) throw new InputError('目录要写完整路径：' + dir);
        sendJson(response, 200, importSkills(ledger, dir, { actor: CONSOLE_ACTOR }, { dryRun: body.dry_run === true }));
      },
    },
    { method: 'POST', path: '/api/knowledge/entry/repair', outside: true, handle: ({ request, response }) => repairKnowledgeEntry(request, response) },
    { method: 'POST', path: '/api/knowledge/clients', outside: true, handle: addKnowledgeClient },
    { method: 'GET', path: '/api/knowledge/clients/:id/token', outside: true, handle: knowledgeClientToken },
    { method: 'POST', path: '/api/knowledge/clients/:id/rotate', outside: true, handle: rotateKnowledgeClient },
    { method: 'POST', path: '/api/knowledge/clients/:id/revoke', outside: true, handle: revokeKnowledgeClient },
    {
      method: 'GET', path: '/api/knowledge/export.jsonl', outside: true,
      handle: ({ url, response }) => {
        const includeRetired = url.searchParams.get('include_retired') === '1';
        const content = ledger.exportKnowledgeJsonl({ includeRetired });
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': 'attachment; filename="tycho-knowledge.jsonl"',
        });
        response.end(content);
      },
    },
    {
      method: 'POST', path: '/api/knowledge/import.jsonl', outside: true,
      handle: async ({ request, response }) => {
        const body = await readJson(request);
        const jsonl = typeof body.jsonl === 'string' ? body.jsonl : '';
        const targetProjectIds = body.target_project_ids === undefined
          ? undefined
          : (body.target_project_ids === null ? null : (Array.isArray(body.target_project_ids) ? body.target_project_ids as string[] : undefined));
        sendJson(response, 200, ledger.importKnowledgeJsonl(jsonl, {
          dryRun: body.dry_run === true,
          ...(targetProjectIds !== undefined ? { targetProjectIds } : {}),
          ctx: { actor: CONSOLE_ACTOR },
        }));
      },
    },
    {
      method: 'GET', path: '/api/knowledge/dotfiles-boundary', outside: true,
      handle: ({ response }) => sendJson(response, 200, inspectDotfilesBoundary()),
    },
    // Git-backed LLM Wiki endpoints
    {
      method: 'GET', path: '/api/wiki', outside: true,
      handle: ({ response }) => sendJson(response, 200, {
        vaults: ledger.wiki.listVaults(),
        proposals: ledger.wiki.listProposals(),
        projects: ledger.listProjects().map(({ id, name }) => ({ id, name })),
      }),
    },
    {
      method: 'POST', path: '/api/wiki/vaults', outside: true,
      handle: async ({ request, response }) => {
        const body = await readJson(request);
        sendJson(response, 201, ledger.wiki.createVault({
          name: body.name,
          repo_path: body.repo_path,
          branch: body.branch,
          description: body.description,
          autoSync: body.auto_sync !== false,
        }, { actor: CONSOLE_ACTOR }));
      },
    },
    {
      method: 'DELETE', path: '/api/wiki/vaults/:id', outside: true,
      handle: ({ response, params: [id] }) => {
        ledger.wiki.deleteVault(id!, { actor: CONSOLE_ACTOR });
        sendJson(response, 200, { ok: true });
      },
    },
    {
      method: 'POST', path: '/api/wiki/vaults/:id/sync', outside: true,
      handle: async ({ request, response, params: [id] }) => {
        const body = await readJson(request);
        const commit = typeof body.commit === 'string' && body.commit.trim() !== '' ? body.commit.trim() : undefined;
        sendJson(response, 200, ledger.wiki.syncVault(id!, { actor: CONSOLE_ACTOR }, commit));
      },
    },
    {
      method: 'GET', path: '/api/wiki/vaults/:id/lint', outside: true,
      handle: ({ response, params: [id] }) => sendJson(response, 200, ledger.wiki.lintVault(id!)),
    },
    {
      method: 'GET', path: '/api/wiki/vaults/:id/pages', outside: true,
      handle: ({ response, params: [id] }) => sendJson(response, 200, { pages: ledger.wiki.listPages(id!) }),
    },
    {
      method: 'GET', path: '/api/wiki/vaults/:id/page', outside: true,
      handle: ({ url, response, params: [id] }) => {
        const pageId = url.searchParams.get('page_id') ?? '';
        const commit = url.searchParams.get('commit') ?? undefined;
        sendJson(response, 200, ledger.wiki.readPage(id!, pageId, commit ? { commit } : undefined));
      },
    },
    {
      method: 'GET', path: '/api/wiki/search', outside: true,
      handle: ({ url, response }) => {
        const query = url.searchParams.get('q') ?? '';
        const vaultId = url.searchParams.get('vault_id') ?? undefined;
        const projectId = url.searchParams.get('project_id') ?? undefined;
        sendJson(response, 200, { hits: ledger.wiki.searchPages({ query, ...(vaultId ? { vaultId } : {}), ...(projectId ? { projectId } : {}) }) });
      },
    },
    {
      method: 'POST', path: '/api/wiki/vaults/:id/grants', outside: true,
      handle: async ({ request, response, params: [id] }) => {
        const body = await readJson(request);
        sendJson(response, 200, {
          grant: ledger.wiki.grantProject(id!, {
            project_id: body.project_id,
            pinned_commit: body.pinned_commit,
            can_propose: body.can_propose === true,
          }, { actor: CONSOLE_ACTOR }),
        });
      },
    },
    {
      method: 'DELETE', path: '/api/wiki/vaults/:id/grants/:projectId', outside: true,
      handle: ({ response, params: [id, projectId] }) => {
        ledger.wiki.revokeProject(id!, projectId!, { actor: CONSOLE_ACTOR });
        sendJson(response, 200, { ok: true });
      },
    },
    {
      method: 'POST', path: '/api/wiki/proposals', outside: true,
      handle: async ({ request, response }) => {
        const body = await readJson(request);
        sendJson(response, 201, {
          proposal: ledger.wiki.proposeUpdate({
            vault_id: body.vault_id,
            project_id: typeof body.project_id === 'string' && body.project_id ? body.project_id : null,
            path: body.path,
            new_content: body.new_content,
            rationale: body.rationale,
            base_commit: body.base_commit,
            base_mutation_version: body.base_mutation_version,
            proposed_by: CONSOLE_ACTOR,
            source: 'console',
          }, { actor: CONSOLE_ACTOR }),
        });
      },
    },
    {
      method: 'POST', path: '/api/wiki/proposals/:id/decide', outside: true,
      handle: async ({ request, response, params: [id] }) => {
        const body = await readJson(request);
        const action = body.action === 'approve' || body.action === 'reject' ? body.action : null;
        if (!action) throw new InputError('action 只能是 approve 或 reject');
        sendJson(response, 200, ledger.wiki.decideProposal(id!, { action, ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) }, { actor: CONSOLE_ACTOR }));
      },
    },
    // Cross-project pinned refs & intra-project task artifact contracts
    {
      method: 'GET', path: '/api/projects/:id/collaboration', outside: true,
      handle: ({ response, params: [id] }) => {
        ledger.getProject(id!);
        sendJson(response, 200, {
          incoming_refs: ledger.collaboration.listCrossProjectRefs({ projectId: id!, direction: 'incoming', includeRevoked: true }),
          outgoing_refs: ledger.collaboration.listCrossProjectRefs({ projectId: id!, direction: 'outgoing', includeRevoked: true }),
          contracts: ledger.collaboration.listTaskContracts({ projectId: id! }),
          wiki_vaults: ledger.wiki.listProjectVaults(id!),
        });
      },
    },
    {
      method: 'POST', path: '/api/projects/:id/refs', outside: true,
      handle: async ({ request, response, params: [id] }) => {
        const body = await readJson(request);
        sendJson(response, 201, {
          ref: ledger.collaboration.grantCrossProjectRef({
            source_project_id: id!,
            target_project_id: body.target_project_id,
            ref_kind: body.ref_kind,
            source_ref_id: body.source_ref_id,
            pinned_version: body.pinned_version,
            title: body.title,
            summary: body.summary,
          }, { actor: CONSOLE_ACTOR }),
        });
      },
    },
    {
      method: 'POST', path: '/api/collaboration/refs/:refId/revoke', outside: true,
      handle: async ({ request, response, params: [refId] }) => {
        const body = await readJson(request);
        sendJson(response, 200, {
          ref: ledger.collaboration.revokeCrossProjectRef(refId!, typeof body.reason === 'string' ? body.reason : undefined, { actor: CONSOLE_ACTOR }),
        });
      },
    },
    {
      method: 'POST', path: '/api/projects/:id/contracts', outside: true,
      handle: async ({ request, response, params: [id] }) => {
        const body = await readJson(request);
        sendJson(response, 201, {
          contract: ledger.collaboration.createTaskContract({
            project_id: id!,
            producer_task_id: body.producer_task_id,
            consumer_task_id: body.consumer_task_id,
            contract_name: body.contract_name,
            artifact_path: body.artifact_path,
          }, { actor: CONSOLE_ACTOR }),
        });
      },
    },
    {
      method: 'POST', path: '/api/projects/:id/contracts/:contractId/deliver', outside: true,
      handle: async ({ request, response, params: [id, contractId] }) => {
        const body = await readJson(request);
        sendJson(response, 200, ledger.collaboration.deliverTaskContract(contractId!, {
          artifact_path: body.artifact_path,
          delivery_summary: body.delivery_summary,
          run_id: typeof body.run_id === 'string' ? body.run_id : null,
          expected_project_id: id!,
        }, { actor: CONSOLE_ACTOR }));
      },
    },
    {
      method: 'POST', path: '/api/projects/:id/contracts/:contractId/block', outside: true,
      handle: async ({ request, response, params: [id, contractId] }) => {
        const body = await readJson(request);
        sendJson(response, 200, {
          contract: ledger.collaboration.blockTaskContract(contractId!, { question: body.question, expected_project_id: id! }, { actor: CONSOLE_ACTOR }),
        });
      },
    },
    {
      method: 'POST', path: '/api/projects/:id/contracts/:contractId/clarify', outside: true,
      handle: async ({ request, response, params: [id, contractId] }) => {
        const body = await readJson(request);
        sendJson(response, 200, {
          contract: ledger.collaboration.clarifyTaskContract(contractId!, {
            clarification_id: body.clarification_id,
            answer: body.answer,
            expected_project_id: id!,
          }, { actor: CONSOLE_ACTOR }),
        });
      },
    },
    {
      method: 'DELETE', path: '/api/projects/:id/contracts/:contractId', outside: true,
      handle: ({ response, params: [id, contractId] }) => {
        ledger.collaboration.deleteTaskContract(contractId!, id!, { actor: CONSOLE_ACTOR });
        sendJson(response, 200, { ok: true });
      },
    },
    // The knowledge MCP: on this machine by its own token (RPC + Streamable HTTP JSON-RPC 2.0),
    // from a machine elsewhere by that machine's node token plus the MCP token in a header of its own.
    { method: 'POST', path: '/api/knowledge/mcp', knowledge: true, handle: ({ request, response, client }) => knowledgeCall(request, response, client, '') },
    { method: 'POST', path: '/api/knowledge/mcp/stream', knowledge: true, handle: ({ request, response, client }) => knowledgeStreamMcp(request, response, client, '') },
    {
      method: 'POST', path: '/api/node/knowledge/mcp', node: true, outside: true,
      handle: ({ request, response, node }) => {
        const header = request.headers['x-tycho-knowledge-token'];
        const client = typeof header === 'string' ? ledger.clientByToken(header) : undefined;
        if (!client) throw new HttpError(401, '知识令牌无效：它被吊销了，或者填错了。到控制台的知识页重新签发');
        return knowledgeCall(request, response, client, '（机器 ' + node.id + '）');
      },
    },
    {
      method: 'POST', path: '/api/node/knowledge/mcp/stream', node: true, outside: true,
      handle: ({ request, response, node }) => {
        const header = request.headers['x-tycho-knowledge-token'];
        const client = typeof header === 'string' ? ledger.clientByToken(header) : undefined;
        if (!client) throw new HttpError(401, '知识令牌无效：它被吊销了，或者填错了。到控制台的知识页重新签发');
        return knowledgeStreamMcp(request, response, client, '（机器 ' + node.id + '）');
      },
    },
    { method: 'PUT', path: '/api/tasks/:id/role', outside: true, handle: ({ request, response, params }) => putTaskRole(request, response, params[0]!) },
    { method: 'GET', path: '/api/accounts', outside: true, handle: ({ response }) => sendJson(response, 200, accountsPage()) },
    { method: 'GET', path: '/api/usage', outside: true, handle: ({ response, url }) => sendJson(response, 200, ledger.usageReport(usageQuery(url))) },
    { method: 'GET', path: '/api/usage/competence', outside: true, handle: ({ response, url }) => {
      const { from, to } = usageQuery(url);
      sendJson(response, 200, ledger.competenceReport({ from, to }));
    } },
    { method: 'GET', path: '/api/quota', outside: true, handle: ({ response }) => sendJson(response, 200, quotaPage()) },
    { method: 'POST', path: '/api/quota/refresh', outside: true, handle: ({ request, response }) => refreshQuota(request, response) },
    { method: 'POST', path: '/api/accounts', outside: true, handle: ({ request, response }) => putAccount(request, response) },
    { method: 'POST', path: '/api/account-lines/models', outside: true, handle: ({ request, response }) => readLineModels(request, response) },
    {
      method: 'GET', path: DIRECTORY_FEED_PATH, outside: true, anonymous: true, handle: ({ request, response }) => {
        const feed = options.projectDirectory?.feed(request.headers.authorization);
        if (!feed) throw new HttpError(401, '服务目录令牌无效');
        sendJson(response, 200, feed);
      },
    },
    {
      method: 'GET', path: '/api/project-directory', outside: true, handle: async ({ response }) => {
        const view = await options.projectDirectory?.view();
        sendJson(response, 200, view ?? { local: null, peers: [] });
      },
    },
    { method: 'GET', path: '/api/projects', outside: true, handle: async ({ response }) => sendJson(response, 200, { projects: await Promise.all(ledger.listProjects().map(shownProject)) }) },
    { method: 'POST', path: '/api/projects', outside: true, handle: ({ request, response }) => createProject(request, response) },
    { method: 'POST', path: '/api/projects/categories/rename', outside: true, handle: ({ request, response }) => renameProjectCategory(request, response) },
    {
      method: 'GET', path: '/api/projects/:id/history-evidence', outside: true, handle: ({ response, params: [id], url }) => {
        ledger.getProject(id!);
        sendJson(response, 200, ledger.searchHistoryEvidence(id!, Object.fromEntries(url.searchParams)));
      },
    },
    { method: 'GET', path: '/api/projects/:id/conversation', outside: true, handle: ({ response, params, url }) => sendJson(response, 200, conversationOf(params[0]!, url.searchParams.get('segment'))) },
    { method: 'GET', path: '/api/projects/:id/files', outside: true, handle: ({ response, params }) => listProjectFiles(response, params[0]!) },
    { method: 'POST', path: '/api/projects/:id/files', outside: true, handle: ({ request, response, params }) => uploadProjectFile(request, response, params[0]!) },
    { method: 'GET', path: '/api/projects/:id/files/:fileId/raw', outside: true, handle: ({ request, response, params, url }) => getProjectFileRaw(request, response, params[0]!, params[1]!, url) },
    { method: 'GET', path: '/api/projects/:id/files/:fileId/preview', outside: true, handle: ({ response, params, url }) => getProjectFilePreview(response, params[0]!, params[1]!, url) },
    { method: 'DELETE', path: '/api/projects/:id/files/:fileId', outside: true, handle: ({ response, params }) => deleteProjectFile(response, params[0]!, params[1]!) },
    { method: 'POST', path: '/api/projects/:id/new-topic', outside: true, handle: ({ response, params }) => newTopic(response, params[0]!) },
    { method: 'POST', path: '/api/projects/:id/side-ask', outside: true, handle: ({ request, response, params }) => sideAskProject(request, response, params[0]!) },
    { method: 'POST', path: '/api/projects/:id/pause', outside: true, handle: ({ request, response, params }) => pauseProject(request, response, params[0]!) },
    { method: 'POST', path: '/api/projects/:id/archive', outside: true, handle: ({ request, response, params }) => archiveProject(request, response, params[0]!) },
    { method: 'DELETE', path: '/api/projects/:id', outside: true, handle: ({ request, response, params }) => deleteProject(request, response, params[0]!) },
    { method: 'GET', path: '/api/projects/:id/triggers', outside: true, handle: ({ response, params }) => triggersOf(response, params[0]!) },
    { method: 'POST', path: '/api/projects/:id/triggers', outside: true, handle: ({ request, response, params }) => createTrigger(request, response, params[0]!) },
    { method: 'GET', path: '/api/projects/:id/groups', outside: true, handle: ({ response, params }) => listProjectImGroups(response, params[0]!) },
    { method: 'GET', path: '/api/im/groups', outside: true, handle: ({ response }) => listImGroups(response) },
    { method: 'POST', path: '/api/im/groups', outside: true, handle: ({ request, response }) => createImGroup(request, response) },
    { method: 'PUT', path: '/api/im/groups/:id', outside: true, handle: ({ request, response, params }) => putImGroup(request, response, params[0]!) },
    { method: 'DELETE', path: '/api/im/groups/:id', outside: true, handle: ({ response, params }) => deleteImGroup(response, params[0]!) },
    { method: 'PUT', path: '/api/triggers/:id', outside: true, handle: ({ request, response, params }) => putTrigger(request, response, params[0]!) },
    { method: 'POST', path: '/api/triggers/:id/enabled', outside: true, handle: ({ request, response, params }) => setTriggerEnabled(request, response, params[0]!) },
    { method: 'DELETE', path: '/api/triggers/:id', outside: true, handle: ({ response, params }) => deleteTrigger(response, params[0]!) },
    // Inbound sources (docs/design/triggers.md §2.2): tycho-wide, managed only from the console.
    { method: 'GET', path: '/api/inbound', outside: true, handle: ({ response }) => sendJson(response, 200, inboundPage()) },
    { method: 'POST', path: '/api/inbound', outside: true, handle: ({ request, response }) => createInboundSource(request, response) },
    { method: 'PUT', path: '/api/inbound/:id', outside: true, handle: ({ request, response, params }) => putInboundSource(request, response, params[0]!) },
    { method: 'POST', path: '/api/inbound/:id/enabled', outside: true, handle: ({ request, response, params }) => setInboundEnabled(request, response, params[0]!) },
    { method: 'DELETE', path: '/api/inbound/:id', outside: true, handle: ({ response, params }) => deleteInboundSource(response, params[0]!) },
    { method: 'POST', path: '/api/inbound/:id/key', outside: true, handle: ({ response, params }) => issueInboundKey(response, params[0]!) },
    // An inbound source's entrance: the one route the internet reaches without a login.
    { method: 'POST', path: '/inbound/:id([0-9A-Z]{26})', inbound: true, outside: true, handle: receiveInbound },
    { method: 'GET', path: '/inbound/:id([0-9A-Z]{26})/result/:receipt([0-9A-Z]{26})', inbound: true, outside: true, handle: readInboundReceipt },
    { method: 'PUT', path: '/api/projects/:id', outside: true, handle: ({ request, response, params }) => putProject(request, response, accountId(params[0]!)) },
    { method: 'PUT', path: '/api/wecom/secret', outside: true, handle: ({ request, response }) => setWecomSecret(request, response) },
    { method: 'POST', path: '/api/wecom/reconnect', outside: true, handle: ({ response }) => reconnectWecom(response) },
    { method: 'GET', path: '/api/weixin', outside: true, handle: ({ response }) => sendJson(response, 200, options.weixin?.status() ?? { state: 'disconnected' }) },
    { method: 'POST', path: '/api/weixin/login', outside: true, handle: async ({ response }) => {
      requireSteady('连接微信');
      if (!options.weixin) throw new InputError('此服务没有启用微信登录');
      sendJson(response, 200, await options.weixin.login());
    } },
    { method: 'POST', path: '/api/weixin/pin', outside: true, handle: async ({ request, response }) => {
      requireSteady('确认微信登录');
      if (!options.weixin) throw new InputError('此服务没有启用微信登录');
      const { pin } = await readJson(request);
      sendJson(response, 200, options.weixin.pin(pin));
    } },
    { method: 'DELETE', path: '/api/weixin', outside: true, handle: ({ response }) => {
      requireSteady('断开微信');
      if (!options.weixin) throw new InputError('此服务没有启用微信登录');
      sendJson(response, 200, options.weixin.disconnect());
    } },
    { method: 'GET', path: '/api/github', outside: true, handle: ({ response }) => {
      sendJson(response, 200, options.github?.status() ?? { connected: false, connection: null, client_id: null });
    } },
    { method: 'POST', path: '/api/github/pat', outside: true, handle: async ({ request, response }) => {
      requireSteady('连接 GitHub');
      if (!options.github) throw new InputError('此服务没有启用 GitHub 集成');
      const { token } = await readJson(request);
      if (typeof token !== 'string') throw new InputError('请填写 GitHub Personal Access Token');
      const connection = await options.github.connectPat(token);
      stream.publish('changed', {});
      sendJson(response, 200, { connected: true, connection });
    } },
    { method: 'POST', path: '/api/github/device/start', outside: true, handle: async ({ request, response }) => {
      requireSteady('发起 GitHub 授权');
      if (!options.github) throw new InputError('此服务没有启用 GitHub 集成');
      const { client_id } = await readJson(request);
      if (typeof client_id !== 'string') throw new InputError('请填写 GitHub OAuth App 的 Client ID');
      sendJson(response, 200, await options.github.startDeviceFlow(client_id));
    } },
    { method: 'POST', path: '/api/github/device/poll', outside: true, handle: async ({ request, response }) => {
      requireSteady('轮询 GitHub 授权');
      if (!options.github) throw new InputError('此服务没有启用 GitHub 集成');
      const { session_id } = await readJson(request);
      if (typeof session_id !== 'string') throw new InputError('缺少 session_id');
      const result = await options.github.pollDeviceFlow(session_id);
      if (result.state === 'connected') stream.publish('changed', {});
      sendJson(response, 200, result);
    } },
    { method: 'POST', path: '/api/github/check', outside: true, handle: async ({ response }) => {
      if (!options.github) throw new InputError('此服务没有启用 GitHub 集成');
      const connection = await options.github.check();
      stream.publish('changed', {});
      sendJson(response, 200, { connected: true, connection });
    } },
    { method: 'DELETE', path: '/api/github', outside: true, handle: ({ response }) => {
      requireSteady('断开 GitHub');
      if (!options.github) throw new InputError('此服务没有启用 GitHub 集成');
      options.github.disconnect();
      stream.publish('changed', {});
      sendJson(response, 200, { connected: false, connection: null });
    } },
    { method: 'POST', path: '/api/router/restart', outside: true, handle: ({ response }) => restartRouter(response) },
    { method: 'POST', path: '/api/releases/:run/launch', outside: true, handle: launchRelease },
    { method: 'POST', path: '/api/tasks/:id/artifacts', outside: true, handle: refetchArtifacts },
    { method: 'POST', path: '/api/tasks/:id/deliverables', outside: true, handle: syncTaskDeliverables },
    { method: 'POST', path: '/api/accounts/:id/retry', outside: true, handle: ({ response, params }) => retryAccount(response, accountId(params[0]!)) },
    { method: 'POST', path: '/api/accounts/:id/check', outside: true, handle: ({ response, params }) => checkAccount(response, accountId(params[0]!)) },
    // A Claude login: start, look, the code, the new account's tiers, and cancel. The owner signs
    // in from a phone through the gateway as well.
    { method: 'POST', path: '/api/claude-logins', outside: true, handle: ({ request, response }) => startClaudeLogin(request, response) },
    { method: 'GET', path: '/api/claude-logins/:id', outside: true, handle: ({ response, params }) => sendJson(response, 200, { login: claudeLogin().get(params[0]!) }) },
    { method: 'POST', path: '/api/claude-logins/:id/code', outside: true, handle: ({ request, response, params }) => submitClaudeCode(request, response, params[0]!) },
    { method: 'POST', path: '/api/claude-logins/:id/save', outside: true, handle: ({ request, response, params }) => saveClaudeLogin(request, response, params[0]!) },
    { method: 'POST', path: '/api/claude-logins/:id/cancel', outside: true, handle: ({ response, params }) => sendJson(response, 200, { login: claudeLogin().cancel(params[0]!) }) },
    { method: 'POST', path: '/api/codex-logins', outside: true, handle: ({ request, response }) => startCodexLogin(request, response) },
    { method: 'GET', path: '/api/codex-logins/:id', outside: true, handle: ({ response, params }) => sendJson(response, 200, { login: codexLogin().get(params[0]!) }) },
    { method: 'POST', path: '/api/codex-logins/:id/save', outside: true, handle: ({ request, response, params }) => saveCodexLogin(request, response, params[0]!) },
    { method: 'POST', path: '/api/codex-logins/:id/cancel', outside: true, handle: ({ response, params }) => sendJson(response, 200, { login: codexLogin().cancel(params[0]!) }) },
    { method: 'POST', path: '/api/sign-ins', outside: true, handle: ({ request, response }) => startSignIn(request, response) },
    { method: 'GET', path: '/api/sign-ins/:id', outside: true, handle: ({ response, params }) => sendJson(response, 200, { sign_in: signInOr404(signIns().get(params[0]!)) }) },
    { method: 'POST', path: '/api/sign-ins/:id/code', outside: true, handle: ({ request, response, params }) => submitSignInCode(request, response, params[0]!) },
    { method: 'POST', path: '/api/sign-ins/:id/cancel', outside: true, handle: ({ response, params }) => sendJson(response, 200, { sign_in: signInOr404(signIns().cancel(params[0]!)) }) },
    { method: 'PUT', path: '/api/accounts/:id/credential', outside: true, handle: ({ request, response, params }) => setAccountCredential(request, response, accountId(params[0]!)) },
    { method: 'GET', path: '/api/machines/:uid/dirs', outside: true, handle: ({ response, url, params }) => browseMachineDirs(response, accountId(params[0]!), url) },
    { method: 'POST', path: '/api/machines/:uid/dirs', outside: true, handle: ({ request, response, params }) => createMachineDir(request, response, accountId(params[0]!)) },
    { method: 'PUT', path: '/api/machines/:uid/dirs', outside: true, handle: ({ request, response, params }) => renameMachineDir(request, response, accountId(params[0]!)) },
    { method: 'PUT', path: '/api/machines/:uid/logins/:executor', outside: true, handle: ({ request, response, params }) => putMachineLogin(request, response, { uid: accountId(params[0]!), executor: accountId(params[1]!) }) },
    { method: 'PUT', path: '/api/logins/batch', outside: true, handle: ({ request, response }) => putMachineLoginsBatch(request, response) },
    { method: 'PUT', path: '/api/logins/:id', outside: true, handle: ({ request, response, params }) => putMachineLogin(request, response, { id: accountId(params[0]!) }) },
    {
      method: 'DELETE', path: '/api/logins/:id', outside: true,
      handle: ({ response, params }) => deleteMachineLogin(response, accountId(params[0]!)),
    },
    { method: 'POST', path: '/api/logins/:id/retry', outside: true, handle: ({ response, params }) => retryMachineLogin(response, accountId(params[0]!)) },
    { method: 'PUT', path: '/api/accounts/:id', outside: true, handle: ({ request, response, params }) => putAccount(request, response, accountId(params[0]!)) },
    {
      method: 'DELETE', path: '/api/accounts/:id', outside: true,
      handle: ({ response, url, params }) => deleteAccount(response, accountId(params[0]!), url.searchParams.get('confirm') === '1'),
    },
    { method: 'PUT', path: '/api/dispatch/slots', outside: true, handle: ({ request, response }) => putDispatchSlots(request, response) },
    {
      method: 'PUT', path: '/api/logins/alias', outside: true,
      handle: async ({ request, response }) => {
        requireSteady('修改账号名称');
        const body = await readJson(request);
        const target = typeof body.target === 'string' ? body.target.trim() : '';
        if (!target) throw new InputError('缺少要重命名的账号标识');
        const rawName = body.name === null || body.name === undefined ? null : typeof body.name === 'string' ? body.name.trim() : undefined;
        if (rawName === undefined) throw new InputError('账号名称必须是文字');
        const account = ledger.getAccount(target);
        if (account) {
          if (!rawName) throw new InputError('先给这个账号起个名字');
          const problem = accountNameProblem(rawName);
          if (problem) throw new InputError(problem);
          ledger.renameAccount(account.id, rawName, { actor: CONSOLE_ACTOR });
          sendJson(response, 200, { target, name: rawName, login_aliases: ledger.loginAliases() });
          return;
        }
        const aliases = ledger.setLoginAlias(target, rawName || null);
        sendJson(response, 200, { target, name: aliases[target] ?? null, login_aliases: aliases });
      },
    },
    { method: 'PUT', path: SETTING, outside: true, handle: ({ request, response, params }) => changeSetting(request, response, params[0]!) },
    { method: 'DELETE', path: SETTING, outside: true, handle: ({ request, response, params }) => changeSetting(request, response, params[0]!) },
    {
      method: 'POST', path: '/api/outbox/:id/retry', outside: true,
      handle({ response, params }) {
          ledger.outbox.retry(params[0]!, { actor: CONSOLE_ACTOR });
          sendJson(response, 200, { retried: true });
      },
    },
    { method: 'GET', path: '/api/tasks/:id/facts', outside: true, handle: taskFacts },
    { method: 'GET', path: '/api/tasks/:id/diff', outside: true, handle: async ({ response, params, url }) => {
      const task = ledger.getTask(params[0]!);
      const runs = ledger.listRuns(task.id);
      const runId = url.searchParams.get('run');
      const diff = await readTaskDiff({
        dataDir: options.releases.dataDir,
        task,
        runs,
        runId,
        readRunEvents: options.runner
          ? async (run) => (await options.runner!.eventSnapshot(run)).events
          : undefined,
      });
      sendJson(response, 200, diff);
    } },
    { method: 'POST', path: '/api/tasks/:id/rollback', outside: true, handle: async ({ request, response, params }) => {
      const taskId = params[0]!;
      ledger.getTask(taskId);
      const body = await readJson(request);
      const commit = typeof body.commit === 'string' ? body.commit.trim() : '';
      if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) {
        throw new InputError('commit 必须是 7 到 40 位十六进制提交号');
      }
      const note = `将当前工作分支代码回退到提交 ${commit} 并汇报状态，不强推远端`;
      const res = ledger.continueTask(taskId, note, undefined, { actor: CONSOLE_ACTOR });
      session.kick();
      sendJson(response, 201, { id: res.id, queued: res.queued, active: res.active, commit, task: ledger.getTask(taskId) });
    } },
    { method: 'PATCH', path: '/api/tasks/:id/inputs/:inputId', outside: true, handle: async ({ request, response, params }) => {
      const body = await readJson(request);
      if (typeof body.text !== 'string') throw new InputError('内容不能为空');
      const input = ledger.updateInput(params[0]!, params[1]!, body.text, { actor: CONSOLE_ACTOR });
      sendJson(response, 200, { input });
    } },
    { method: 'DELETE', path: '/api/tasks/:id/inputs/:inputId', outside: true, handle: ({ response, params }) => {
      ledger.deleteInput(params[0]!, params[1]!, { actor: CONSOLE_ACTOR });
      sendJson(response, 200, { deleted: true });
    } },
    { method: 'GET', path: '/api/tasks/:id/feedback', outside: true, handle: ({ response, params }) => sendJson(response, 200, { feedback: ledger.listTaskFeedback(params[0]!) }) },
    { method: 'POST', path: '/api/tasks/:id/feedback', outside: true, handle: async ({ request, response, params }) => {
      const feedback = ledger.addTaskFeedback(params[0]!, await readJson(request), { actor: CONSOLE_ACTOR });
      sendJson(response, 201, { feedback });
    } },
    { method: 'GET', path: '/api/tasks/:id', outside: true, handle: ({ response, params }) => sendJson(response, 200, taskPage(params[0]!)) },
    {
      method: 'POST', path: '/api/tasks/:id/:action(resume|abandon|accept|rework|continue|interrupt|inputs|review|hold|integrate)', outside: true,
      handle: ({ request, response, params }) => taskAction(request, response, params[0]!, params[1]!),
    },
    { method: 'GET', path: '/api/runs/:id/:part(events|snapshot|trace)', outside: true, handle: runPart },
    { method: 'GET', path: '/api/runs/:id/diagnostics', outside: true, handle: runDiagnostics },
    { method: 'GET', path: '/api/runs/:id/report', outside: true, handle: async ({ response, params: [id], url }) => {
      const run = ledger.getRun(id!);
      sendJson(response, 200, await readRunReport({ run, ref: url.searchParams.get('ref'), dataDir: options.releases.dataDir,
        held: ledger.artifactsOfRun(run.id), readNode: options.runner?.readReportFile, finalMessage: ledger.runReport(run.id), recoverFinal: options.runner?.recoverRunReport }));
    } },
    { method: 'POST', path: '/api/outbox/confirm-all', outside: true, handle: ({ response }) => {
      requireSteady('全部确认通知已收到');
      const count = ledger.outbox.confirmAllReceived({ actor: CONSOLE_ACTOR });
      sendJson(response, 200, { confirmed: count });
    } },
    { method: 'POST', path: '/api/outbox/:id/confirm', outside: true, handle: ({ response, params }) => {
      requireSteady('确认通知已收到');
      ledger.outbox.confirmReceived(params[0]!, { actor: CONSOLE_ACTOR });
      sendJson(response, 200, { confirmed: true });
    } },
    { method: 'POST', path: '/api/outbox/:id/force-resend', outside: true, handle: ({ response, params }) => {
      requireSteady('强制重发通知');
      const forceResendSeq = ledger.outbox.forceResend(params[0]!, { actor: CONSOLE_ACTOR });
      sendJson(response, 200, { resent: true, force_resend_seq: forceResendSeq });
    } },
    { method: 'GET', path: '/api/replay/cases', outside: true, handle: ({ response }) => {
      if (!options.replay) throw new InputError('此服务没有安装隔离评测');
      sendJson(response, 200, options.replay.cases());
    } },
    { method: 'GET', path: '/api/replay/runs/:id/draft', outside: true, handle: ({ response, params, url }) => {
      if (!options.replay) throw new InputError('此服务没有安装隔离评测');
      sendJson(response, 200, options.replay.draft(params[0], url.searchParams.get('split') ?? 'release'));
    } },
    { method: 'POST', path: '/api/replay/run', outside: true, handle: async ({ request, response }) => {
      requireSteady('运行隔离评测');
      if (!options.replay) throw new InputError('此服务没有安装隔离评测');
      sendJson(response, 200, await options.replay.run(await readJson(request)));
    } },
    { method: 'GET', path: '/api/messages/:id/trajectory', outside: true, handle: routerTurn },
    { method: 'GET', path: '/api/messages/:id/changes', outside: true, handle: ({ response, params }) => sendJson(response, 200, changesOf(params[0]!)) },
    { method: 'POST', path: '/api/approvals/:id/answer', outside: true, handle: ({ request, response, params }) => answer(request, response, params[0]!) },
  ];
  const patterns = routes.map((each) => ({ route: each, pattern: pathPattern(each.path) }));

  // The route a request is for, on the listener it came in by. On the outside listener a
  // route without the mark is not there: the request is answered as one for a path
  // nobody serves, so the answer does not even say that such a route exists.
  function find(request: IncomingMessage, pathname: string, outside: boolean): { route: Route; params: string[] } | undefined {
    for (const { route: each, pattern } of patterns) {
      if (each.method !== request.method || (outside && !each.outside)) continue;
      if (each.token && each.ifShown && request.headers.authorization === undefined) continue;
      const match = pattern.exec(pathname);
      if (match) return { route: each, params: match.slice(1) };
    }
    return undefined;
  }

  async function route(request: IncomingMessage, response: ServerResponse, outside: boolean): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const found = find(request, url.pathname, outside);
    if (!found && url.pathname.startsWith('/login/')) {
      if (request.method === 'GET') {
        sendPage(response, 410, deadLinkPage(imLoginChannels()));
        return;
      }
      throw new HttpError(404, '没有这个登录入口');
    }
    const asked: Asked = { request, response, url, params: found?.params ?? [], outside };
    if (found?.route.token) {
      requireLocal(request, found.route.token());
      await found.route.handle(asked);
      return;
    }
    if (found?.route.anonymous) {
      await found.route.handle(asked);
      return;
    }
    if (found && isKnowledgeRoute(found.route)) {
      if (!LOOPBACK.has(request.socket.remoteAddress ?? '')) throw new HttpError(403, '知识服务只接受本机请求；别的机器经它自己的节点通道来');
      const header = request.headers.authorization ?? '';
      const client = header.startsWith('Bearer ') ? ledger.clientByToken(header.slice(7)) : undefined;
      if (!client) throw new HttpError(401, '知识令牌无效：它被吊销了，或者填错了。到控制台的知识页重新签发');
      await found.route.handle({ ...asked, client });
      return;
    }
    if (found && isInboundRoute(found.route)) {
      try {
        await found.route.handle(asked);
      } catch (err) {
        // This entrance has no owner authentication. Expected protocol errors are public;
        // storage failures and other internals belong only in the service's log.
        if (err instanceof HttpError && err.status < 500) throw err;
        log(`入站请求处理失败：${String(err)}`);
        throw new HttpError(err instanceof DegradedError ? 503 : 500, '入站请求处理失败，请稍后重试');
      }
      return;
    }
    if (found && isNodeRoute(found.route)) {
      const nodeRoute = found.route;
      // §5.3: this group takes a node token and nothing else. A console cookie is not
      // looked at here, and a node token opens nothing below.
      const header = request.headers.authorization ?? '';
      const machine = header.startsWith('Bearer ') ? options.nodes.authenticate(header.slice(7)) : undefined;
      if (!machine) throw new HttpError(401, '机器令牌无效：这台机器已经被撤销，或者它的令牌不对。在这台机器上重新运行 tycho node join');
      await nodeRoute.handle({ ...asked, node: machine });
      return;
    }

    if (request.method === 'GET' && PUBLIC_PWA_ASSET.test(url.pathname)) {
      if (await serveConsole(response, url.pathname)) return;
      throw new HttpError(404, '没有这个资源');
    }

    const visitor = auth.authenticate(request.headers.cookie, outside);
    if (!visitor) {
      refuseAnonymous(response, url.pathname.startsWith('/api/'));
      return;
    }
    if (request.method !== 'GET') {
      requireSameOrigin(request, outside);
      if (visitor.fromMemory) throw new DegradedError('账本不可用，服务处于降级模式');
    }
    if (!visitor.fromMemory) {
      try {
        auth.used(visitor.id);
      } catch (err) {
        log(`写入设备使用时间失败：${String(err)}`);
      }
      if (url.pathname !== '/api/logout') {
        try {
          const refreshed = auth.maybeRefreshSession(request.headers.cookie, visitor, outside);
          if (refreshed) response.setHeader('Set-Cookie', refreshed);
        } catch (err) {
          log(`延长控制台会话有效期失败：${String(err)}`);
        }
      }
    }
    if (found && !isNodeRoute(found.route) && !isKnowledgeRoute(found.route) && !isInboundRoute(found.route)) {
      const browserRoute = found.route;
      await browserRoute.handle({ ...asked, visitor });
      return;
    }
    // Reachable from outside: past the table there are only the pages, which both
    // listeners serve to a browser that is signed in. Anything else goes in the table.
    if (request.method === 'GET' && !url.pathname.startsWith('/api/') && (await serveConsole(response, url.pathname))) return;
    throw new HttpError(404, '没有这个接口');
  }

  // ---- Knowledge (docs/design/knowledge-and-skills.md §2–§4) ----

  // What the knowledge page lists (§3): what waits for the owner's say, what took effect
  // unreviewed, every proposal newest first, every entry with its revision in force, the MCP
  // clients, and the names the page shows scopes, roles and executors by.
  function knowledgePage() {
    const summary = ({ evidence, ...proposal }: ReturnType<typeof ledger.getProposal>) => ({ ...proposal, evidence_count: evidence.length, verified_count: evidence.filter(({ verified }) => verified).length });
    const scan = ledger.scanSkills();
    return {
      // project-sessions §6: what the upgrade could not carry over is listed, not left unseen.
      legacy: ledger.legacyDecisions(),
      awaiting: ledger.listProposals({ state: 'awaiting_owner' }).map(summary),
      to_review: ledger.reviewQueue().map(summary),
      proposals: ledger.listProposals().map(summary),
      entries: ledger.listEntries({ includeRetired: true }),
      directory_skills: scan.skills,
      ignored_skills: scan.ignored,
      skills_dir: scan.dir || options.skillFolder,
      entry_machines: ledger.entryMachines(),
      machines: ledger.listMachines().filter((machine) => machine.leftAt === undefined).map(({ id, host }) => ({ id, host })),
      public_url: options.publicUrl?.() || null,
      clients: ledger.listClients(),
      projects: ledger.listProjects().map(({ id, name }) => ({ id, name })),
      roles: ledger.listRoles().map(({ id, name }) => ({ id, name })),
      executors: options.accounts.executors,
      // Where the old skill files were kept by default: what an import reads unless told otherwise.
      skill_folder: options.skillFolder,
    };
  }

  // One proposal in full, with what it costs (§5.2): each input at the revision it pinned and as
  // it is now, the lines its change drops, and how each project and role's generated input moves.
  function proposalPage(id: string) {
    const proposal = ledger.getProposal(id);
    const change = proposal.final ?? proposal.change;
    return {
      proposal,
      inputs: change.inputs.map((input) => ({ ...input, pinned: ledger.readRevision(input.knowledge_id, input.revision) ?? null, now: ledger.getEntry(input.knowledge_id) ?? null })),
      impact: ledger.proposalImpact(id),
      ...(proposal.gate_task_id === null ? {} : { gate_task: (({ id: taskId, state, reason }) => ({ id: taskId, state, reason }))(ledger.getTask(proposal.gate_task_id)) }),
    };
  }

  function entryPage(id: string) {
    const entry = ledger.getEntry(id);
    if (!entry) throw new HttpError(404, '没有这个条目：' + id);
    return {
      entry,
      revisions: ledger.revisionsOf(id).map((revision) => {
        const { evidence, proposed_by, source } = ledger.getProposal(revision.proposal_id);
        return { ...revision, proposed_by, source, evidence };
      }),
    };
  }

  const ownerProposer: Proposer = { source: 'console', by: CONSOLE_ACTOR, client: 'console', writers: [] };

  async function knowledgeAction({ request, response, params: [id, action] }: Asked & { visitor: Visitor }): Promise<void> {
    const body = await readJson(request);
    const ctx: Ctx = { actor: CONSOLE_ACTOR };
    switch (action) {
      case 'decide': {
        const { decision, digest, note } = body as { decision?: unknown; digest?: unknown; note?: unknown };
        if (decision !== 'approve' && decision !== 'reject') throw new InputError('只能同意或驳回');
        if (typeof digest !== 'string') throw new InputError('要带上你看到的变更摘要');
        sendJson(response, 200, ledger.decideProposal(id!, { decision, digest, ...(typeof note === 'string' ? { note } : {}), via: 'console' }, ctx));
        return;
      }
      case 'amend':
        sendJson(response, 201, { id: ledger.amendProposal(id!, body, ctx) });
        return;
      case 'review':
        ledger.markReviewed(id!, ctx);
        sendJson(response, 200, { proposal: ledger.getProposal(id!) });
        return;
      default:
        throw new HttpError(404, '没有这个接口');
    }
  }

  const ENTRY_REPAIR_TIMEOUT_MS = 20_000;

  async function repairKnowledgeEntry(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    const executor = typeof body.executor === 'string' ? body.executor.trim() : '';
    const action = body.action;
    if (target === '') throw new InputError('缺少要修复的目标机器：target');
    if (executor === '') throw new InputError('缺少要修复的执行器：executor');
    if (!isEntryRepairAction(action)) throw new InputError('不支持的入口修复方式，只能是 coexist、backup_takeover 或 resync');
    if (!options.globalEntry) throw new HttpError(503, '这个服务没有开启全局知识入口管理');

    if (target === 'host') {
      if (!options.globalEntry.repairHost) throw new HttpError(503, '这个服务不支持修复主机本机全局入口');
      let result: NodeRepairEntryResult;
      try {
        result = options.globalEntry.repairHost(executor, action);
      } catch (error) {
        if (error instanceof HttpError || error instanceof InputError) throw error;
        throw new HttpError(409, (error as Error).message);
      }
      stream.publish('changed', {});
      sendJson(response, 200, {
        status: result.status,
        ...(result.backup_path === undefined ? {} : { backup_path: result.backup_path }),
        report: result.report,
      });
      return;
    }

    const machine = ledger.listMachines().find((each) => each.uid === target)
      ?? ledger.listMachines().find((each) => each.id === target);
    if (!machine) throw new HttpError(404, `没有找到这台机器：${target}`);
    if (!options.nodes.send) throw new HttpError(503, '这个服务不支持向远端机器发送入口修复命令');
    if (!options.nodes.connected(machine.id)) throw new HttpError(409, '这台机器当前离线，上线后才能修复入口');

    const content = options.globalEntry.content();
    let raw: unknown;
    try {
      raw = await options.nodes.send(machine.id, { kind: 'repair_entry', executor, action, content }, ENTRY_REPAIR_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof NodeAway) throw new HttpError(409, '这台机器当前离线，上线后才能修复入口');
      if (error instanceof NodeCommandTimeout) throw new HttpError(504, `机器 ${machine.id} 响应超时，请稍后重试`);
      if (error instanceof NodeRefused) {
        if (error.message.includes('不认识的命令')) {
          throw new HttpError(409, '该机器节点客户端版本较旧，等它空闲自动换版后即可支持一键修复');
        }
        throw new HttpError(409, error.message);
      }
      throw error;
    }
    const result = raw as Partial<NodeRepairEntryResult> | null;
    if (result === null || typeof result !== 'object' || !result.status || !result.report) {
      throw new HttpError(502, `机器 ${machine.id} 回报的入口修复结果格式不正确`);
    }
    if (options.nodes.setEntryReport) {
      try {
        options.nodes.setEntryReport(machine.id, result.report);
      } catch (error) {
        throw new HttpError(502, `机器 ${machine.id} 回报的入口状态格式不正确：${(error as Error).message}`);
      }
    }
    stream.publish('changed', {});
    sendJson(response, 200, {
      status: result.status,
      ...(typeof result.backup_path === 'string' && result.backup_path !== '' ? { backup_path: result.backup_path } : {}),
      report: result.report,
    });
  }

  async function addKnowledgeClient({ request, response }: Asked & { visitor: Visitor }): Promise<void> {
    const body = await readJson(request);
    const { id, token } = ledger.addClient({ name: body.name, executor: body.executor, grants: body.grants }, options.accounts.executors, { actor: CONSOLE_ACTOR });
    try {
      options.knowledgeTokens.save(id, token);
    } catch (err) {
      log('知识令牌没能存下来：' + String(err));
    }
    // Shown once here, and again only to the owner on this page.
    sendJson(response, 201, { client: ledger.listClients().find((client) => client.id === id), token });
  }

  function knowledgeClientToken({ response, params: [id] }: Asked & { visitor: Visitor }): void {
    const client = ledger.listClients().find((each) => each.id === id);
    if (!client || client.revoked_at !== null) throw new HttpError(404, '没有这个客户端，或者它已经吊销了');
    const token = options.knowledgeTokens.read(id!);
    if (token === '') throw new HttpError(404, '这个客户端的令牌文件不在了：吊销它，再签发一个');
    sendJson(response, 200, { token });
  }

  function rotateKnowledgeClient({ response, params: [id] }: Asked & { visitor: Visitor }): void {
    const { token } = ledger.rotateClient(id!, { actor: CONSOLE_ACTOR });
    try {
      options.knowledgeTokens.save(id!, token);
    } catch (err) {
      log('轮换后保存知识令牌失败：' + String(err));
    }
    sendJson(response, 200, { client: ledger.listClients().find((client) => client.id === id), token });
  }

  function revokeKnowledgeClient({ response, params: [id] }: Asked & { visitor: Visitor }): void {
    ledger.revokeClient(id!, { actor: CONSOLE_ACTOR });
    try {
      options.knowledgeTokens.remove(id!);
    } catch (err) {
      log('吊销后删除知识令牌文件失败：' + String(err));
    }
    sendJson(response, 200, { ok: true });
  }

  // The knowledge MCP's one call, by a client on this machine or through a machine's node
  // channel: knowledge/wiki tools, by the client's grants, and nothing else.
  async function knowledgeCall(request: IncomingMessage, response: ServerResponse, client: KnowledgeClient, via: string): Promise<void> {
    const body = await readJson(request);
    ledger.touchClient(client.id);
    const grants: readonly Grant[] = client.grants.filter((grant) => (GRANTS as readonly string[]).includes(grant));
    if (body.method === 'tools/list') {
      sendJson(response, 200, { tools: library.filter(({ grant }) => grants.includes(grant)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    }
    if (body.method !== 'tools/call') throw new InputError('只支持 tools/list 和 tools/call');
    const ctx: Ctx = { actor: 'mcp:' + client.name };
    sendJson(response, 200, callLibrary(library, body.name, body.arguments, { ctx, proposer: { source: 'mcp', by: client.name + via, client: 'mcp:' + client.id, writers: [client.executor] } }, grants));
  }

  // Standard Streamable HTTP JSON-RPC 2.0 MCP endpoint for Claude Code / Codex / Gemini / DSH
  // (speaks MCP protocol directly over HTTP without requiring a local stdio wrapper process).
  async function knowledgeStreamMcp(request: IncomingMessage, response: ServerResponse, client: KnowledgeClient, via: string): Promise<void> {
    const body = await readJson(request);
    ledger.touchClient(client.id);
    const id = body.id;
    const method = typeof body.method === 'string' ? body.method : '';
    const params = (body.params && typeof body.params === 'object' ? body.params : {}) as { protocolVersion?: string; name?: string; arguments?: unknown };
    if (id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const grants: readonly Grant[] = client.grants.filter((grant) => (GRANTS as readonly string[]).includes(grant));
    const reply = (result: unknown) => sendJson(response, 200, { jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => sendJson(response, 200, { jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        reply({
          protocolVersion: params.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: KNOWLEDGE_MCP, version: '1.0' },
          instructions: 'tycho 的知识与域 Wiki 服务：读取生效规则、按需检索 Git LLM Wiki 与提议更新。读取与提议分权；不会访问未授权项目的任务与对话。',
        });
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list': {
        const list = {
          tools: library
            .filter(({ grant }) => grants.includes(grant))
            .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
        reply(toJsonSchemaToolsList(list));
        return;
      }
      case 'tools/call': {
        const ctx: Ctx = { actor: 'mcp:' + client.name };
        const result = callLibrary(
          library,
          params.name,
          params.arguments,
          { ctx, proposer: { source: 'mcp', by: client.name + via, client: 'mcp:' + client.id, writers: [client.executor] } },
          grants,
        );
        reply(result);
        return;
      }
      default:
        fail(-32601, `不支持的方法：${method}`);
    }
  }

  function report(response: ServerResponse, err: unknown): void {
    const unavailable = err instanceof DegradedError || ledger.dispatchConditions().paused === null;
    const confirm = err instanceof ConfirmationRequired;
    const expected = err instanceof HttpError || err instanceof NotFoundError || err instanceof InputError || confirm || unavailable;
    const status = err instanceof HttpError ? err.status : err instanceof NotFoundError ? 404 : err instanceof InputError ? 400 : confirm ? 409 : unavailable ? 503 : 500;
    if (!expected) {
      const requestId = randomBytes(6).toString('hex');
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log(`HTTP 处理失败 [${requestId}]：${detail}`);
      if (response.headersSent) response.end();
      else sendJson(response, 500, { error: '服务内部错误，请查看服务端日志', request_id: requestId });
      return;
    }
    if (status === 500) log(`HTTP 处理失败：${String(err)}`);
    if (response.headersSent) response.end();
    else sendJson(response, status, { error: (err as Error).message, ...(confirm ? { needs_confirm: true, ...err.detail } : {}) });
  }

  // Two listeners, one set of routes: what differs is which of them can be reached.
  const answerOn = (outside: boolean) => (request: IncomingMessage, response: ServerResponse): void => {
    route(request, response, outside).catch((err: unknown) => report(response, err));
  };
  const listenOn = (listener: Server, port: number, host: string): Promise<number> =>
    new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(port, host, () => resolve((listener.address() as AddressInfo).port));
    });
  const server = createServer(answerOn(false));
  function outsideListener() {
    let current: Server | undefined;
    let boundPort = 0;
    function close(): Promise<void> {
      const listener = current;
      current = undefined;
      boundPort = 0;
      if (!listener) return Promise.resolve();
      listener.closeAllConnections();
      return new Promise((resolve) => listener.close(() => resolve()));
    }
    return {
      async listen(port: number): Promise<number> {
        await close();
        const listener = createServer(answerOn(true));
        try {
          const bound = await listenOn(listener, port, LOOPBACK_ADDRESS);
          current = listener;
          boundPort = bound;
          return bound;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
          throw new Error(`对外入口的端口 ${port} 被别的程序占着。请关闭占用它的程序，或修改对应的对外入口端口`, { cause: err });
        }
      },
      port: () => boundPort,
      close,
    };
  }
  const outside = outsideListener();
  const reverseProxy = outsideListener();
  // The one word that what a page shows may be out of date: no content, the page reads again
  // what it has on screen (docs/design/console.md, 数据怎么保持新).
  // Said once the operation that committed has finished: several commits of one request are one
  // word, and a stream that request ends (a revoked device) hears nothing after its end.
  let saying = false;
  const stopChanged = ledger.onChange(() => {
    if (saying) return;
    saying = true;
    queueMicrotask(() => {
      saying = false;
      stream.publish('changed', {});
    });
  });
  const poll = setInterval(() => {
    try {
      pushTaskChanges();
    } catch (err) {
      log(`任务状态推送失败：${String(err)}`);
    }
  }, TASK_POLL_MS);
  poll.unref();

  return {
    // What there is to reach, and which of it through the gateway.
    routes: routes.map((each) => ({ method: each.method, path: each.path, outside: each.outside === true, auth: authOf(each) })),

    listen: (listenPort: number, host: string): Promise<number> => listenOn(server, listenPort, host),

    // Both apply the external route and authentication policy. The SSH gateway may
    // reconnect or be disabled without closing the local reverse proxy listener.
    outside,
    reverseProxy,

    async close(): Promise<void> {
      clearInterval(poll);
      stopChanged();
      for (const subscription of runSubscriptions.values()) subscription.stop();
      runSubscriptions.clear();
      stream.close();
      await Promise.all([outside.close(), reverseProxy.close()]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
