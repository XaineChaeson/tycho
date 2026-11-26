import { serviceManagerReport, type ServiceManagerReport } from '../shared/service-manager.ts';
import type {NodeOutputReport} from '../shared/node-protocol.ts';
import {outputReport} from './node-output.ts';
// The host side of the node channel: who is allowed in, who is connected right now, and
// the one command each connected machine is carrying (docs/design/nodes.md §5.3, §8.2).
//
// Two rules shape this file:
//   - The ledger is the authority for identity. A token is looked up there on every poll,
//     so removing a machine stops its client at its next request with nothing else to
//     invalidate.
//   - A command is delivered once the machine says it has it, and never twice. The host
//     writes a command into one held poll, and the only proof it ever gets that the bytes
//     arrived is the machine's next poll, which names the last command it took: one it does
//     not name is one it never saw. A command that was never delivered goes back to the
//     queue for the next connection — except a start, which is never handed over twice, so
//     its caller is told at once and what became of the round is a state question (§8.2,
//     and the first of §6's lines).
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { ModelInfo, QuotaWindow, Tier } from '../adapters/types.ts';
import { accountLabelOf, organizationIdOf, planLabelOf, type ExecutorIdentity } from '../shared/logins.ts';
import type { Ctx, Ledger, MachineRecord } from './ledger.ts';
import type { MachineSource } from '../runner/snapshot.ts';
import type { NodeCommand, NodeEntryReport, NodeEntryStatus, NodeExecutorReport, NodeExecutorStatus, NodeFacts, NodeJoinAnswer, NodeLocalSkillSummary, NodeReleaseHeld, NodeReleaseReport, NodeRunSummary, NodeSignIn, NodeSkillsReport } from '../shared/node-protocol.ts';
export type { NodeFacts } from '../shared/node-protocol.ts';
import { CONFIG_KINDS, isConfigKind } from '../shared/machine-inputs.ts';
import { NODE_CONFIG_NAMES_MAX, NODE_LOCAL_SKILL_DESC_MAX, NODE_LOCAL_SKILLS_MAX, NODE_MODEL_EFFORTS_MAX, NODE_MODELS_MAX, NODE_PROTOCOL, NODE_QUOTA_WINDOWS_MAX, SIGN_IN_REASONS, SIGN_IN_STATES } from '../shared/node-protocol.ts';
import { isReadOnlyLayer } from '../shared/roles.ts';
import { InputError } from './errors.ts';
import { assertSteady } from './degraded.ts';
import type { Barriers } from './degraded.ts';
import { ownLoginHere } from './readonly.ts';

const MINUTE_MS = 60_000;
// How often being heard from is written to the ledger. Every poll would be a write per
// machine per hold; the console's "last seen" does not need better than this.
const SEEN_WRITE_EVERY_MS = 5 * MINUTE_MS;
const MAX_PENDING_JOINS = 20;
const MAX_FACTS_CHARS = 120;
// What one report of a machine's executors may hold. This program ships three; the cap is
// what a report arriving from outside may write into the pages.
const MAX_EXECUTORS = 20;
const MAX_EXECUTOR_CHARS = 300;
// What one poll may say about sign-ins: a machine runs one per executor at a time, and keeps an
// ended one only until the host has seen it.
const MAX_SIGN_INS = 32;
const MAX_SIGN_IN_ID_CHARS = 100;
const MAX_SIGN_IN_URL_CHARS = 2000;
const MAX_SIGN_IN_CODE_CHARS = 64;

// The join as the client sends it: its own random identity, and what it calls itself.
type JoinFacts = NodeFacts;

export interface PendingJoin {
  // Names this one request, where the six digits cannot: a code is free again once its
  // request is gone, so a card pressed late must not land on another machine's request.
  id: string;
  code: string;
  facts: JoinFacts;
  created_at: number;
  expires_at: number;
  state: 'pending' | 'approved' | 'rejected';
  // The machine the owner let in, and the token this one machine may collect. The token
  // lives here until it is claimed: a host that restarts before then leaves a machine
  // nobody holds the token for, which the owner can remove and let in again.
  machine_id?: string;
  token?: string;
}

// What the console shows about a machine that is asking to be let in.
export interface PendingJoinView {
  code: string;
  name: string;
  platform: string;
  hostname: string;
  created_at: string;
  expires_at: string;
}

// What became of the owner's answer to one request, in the words the console and the card
// both report (nodes.md §1.1 step 2). `expired` and `handled` are told apart because the
// owner acts differently on them: one needs the join run again, the other needs nothing.
export type JoinDecision =
  | { state: 'approved'; machine: MachineRecord; join: PendingJoinView }
  | { state: 'rejected'; join: PendingJoinView }
  | { state: 'expired' | 'handled' | 'missing' };

export class NodeAway extends Error {
  override name = 'NodeAway';
}

// The machine took the command and answered that it could not do it. Told apart from
// NodeAway because the two are different facts about the machine: one was here and failed,
// the other never said anything (runner/host.ts's ListingFailed).
export class NodeRefused extends Error {
  override name = 'NodeRefused';
}

// The machine never answered a command it was given, or never said it had it at all. The
// caller's way forward is the same for both: ask the machine what state the round is in,
// never send the command again (nodes.md §8.2, runner/runner.ts).
export class NodeCommandTimeout extends Error {
  override name = 'NodeCommandTimeout';
}

interface Delivery {
  // Which machine was given the command: an answer is only that machine's to give (§8.2).
  machineId: string;
  // What was handed over, kept whole for the one command that may not be handed over twice.
  command: NodeCommand;
  // Written into a connection. Not delivered yet: only the machine's own next poll says it
  // took it, and one it does not name is one it never saw (shared/node-protocol.ts).
  handedOut: boolean;
  // The machine has named it, or answered it: from here on it is in flight, and the answer
  // to a command that never comes back is a state question, never a second send.
  received: boolean;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface Waiting {
  resolve(command: NodeCommand | null): void;
  // Absent for a poll answered in the same breath: there is no wait to end.
  timer?: NodeJS.Timeout;
  // The command this connection was handed, until the machine names it.
  handed: NodeCommand | null;
  // Which poll this is. A machine is here because it has a connection open, so the one that
  // is lost takes the machine away — but only while it is still the newest one: a poll the
  // next one replaced is not evidence about anything.
  poll: symbol;
}

interface Online {
  boundedOutput: boolean;
  output?: NodeOutputReport;
  // When this poll arrived, and when its answer went out: the same moment until it is held.
  // Between polls the machine is judged by the second one (`gapSlackMs`).
  at: number;
  endedAt: number;
  facts: JoinFacts;
  runs: NodeRunSummary[];
  // What this machine last read from its own executors (nodes.md §1.2). A fact about that
  // machine, for the pages; it is never evidence for a judgment about a Run.
  executors?: NodeExecutorReport;
  // What it did with the global entry content it was last given (knowledge-and-skills.md
  // §4.3), for the pages and for whether it is to be given the current one.
  entry?: NodeEntryReport;
  // What it last reported about skill mirroring and non-mirror local skills on that machine.
  skills?: NodeSkillsReport;
  // Whether this client said it can be told to drop a Task's code copy (service/retention.ts).
  // A fact about the client that is here now, read from its last poll: an old client never
  // says it, and that machine's copies are left where they are.
  dropsTaskCode: boolean;
  // The connection that said so, as above.
  poll: symbol;
}

// A command before the hub gives it its id.
type NodeCommandInput = NodeCommand extends infer T ? (T extends { id: string } ? Omit<T, 'id'> : never) : never;

interface NodeLedger {
  getMachineLogin: Ledger['getMachineLogin'];
  loginState: Ledger['loginState'];
  noteMachineIdentity: Ledger['noteMachineIdentity'];
  // A machine's own login its executor refused comes back on a report probed after that.
  signedInAgain(loginId: string, probedAt: string): void;
  // A login the machine reports signed in, and the owner has not set up here, is written with
  // the tiers its adapter declares — unless the owner removed it in this registration.
  adoptMachineLogin(machineId: string, executor: string, tiers: Record<string, Tier>, ctx: Ctx, identity?: ExecutorIdentity): { created: boolean };
  // What a machine read of one of its own logins' quota there (docs/design/usage.md §3): the
  // windows it named and the moment it read them, which is what decides whether they are news.
  noteQuota(loginId: string, windows: readonly { window: string; used: number; resetsAt: string | null }[], readAt: string, resultChanged?: boolean): void;
  machineByNodeToken(hash: string): MachineRecord | undefined;
  machineByNodeId(nodeId: string): MachineRecord | undefined;
  getMachine(id: string): MachineRecord | undefined;
  // `local`: let in by this host's own token, not by the owner (nodes.md §1.1 step 2).
  joinMachine(machine: { id: string; host: string; nodeId: string; tokenHash: string; platform: string; source: MachineSource | null; ephemeral: boolean; local?: boolean }, ctx: Ctx): MachineRecord;
  // A machine coming in with a one-time material (nodes.md §1.3): the ledger consumes the
  // material's slot and writes the machine in one transaction.
  redeemInvite(fields: { materialHash: string; claimHash: string; facts: NodeFacts; machineId: string; tokenHash: string }, ctx: Ctx): MachineRecord;
  noteMachineSeen(id: string, at: string): void;
  noteAction(action: string, ctx: Ctx): void;
}

export interface NodeOptions {
  ledger: NodeLedger;
  // The tiers a machine's own login of this executor starts with when a report says it is
  // signed in and the owner has not set it up, written by the adapter's declaration
  // (docs/design/accounts-machines-decoupled.md). Undefined: this executor's login is the
  // owner's to set up, and a report never writes one.
  ownLoginTiers?: (executor: string) => Record<string, Tier> | undefined;
  // How long this machine's poll is held open when there is nothing to send; read where it is
  // used. Shorter while a sign-in is under way there (service/sign-ins.ts).
  pollHoldMs: (machineId: string) => number;
  // How long one command may take before the caller is told the machine never answered.
  commandTimeoutMs: () => number;
  // How long a machine has to collect the token the owner released for it, and how long the
  // same secret may keep collecting it after a response was lost on the way.
  joinTtlMs: () => number;
  // How long after a poll is answered the machine still counts as here while the next one
  // is on its way: the client sends it as soon as the last was answered, and does not stop
  // to read its own process table first (node/client.ts). One that has not come back by
  // then is away, whatever its last poll said, and its Runs are judged from that moment —
  // not from a timeout that scales with the hold (nodes.md §4.4). A connection that breaks
  // before its answer takes the machine away at once. Read where it is used.
  gapSlackMs: () => number;
  // The ledger's barriers (§6): in degraded mode or behind the recovery barrier nothing is
  // sent, what was queued is dropped, and no machine is let in — whichever way the owner's
  // answer came (the console, a card), it meets the same barrier here.
  barriers?: () => Barriers;
  // How long, and how many, ended join requests are remembered so that a card pressed late
  // is told the truth. Read where they are used.
  endedJoinKeepMs: () => number;
  endedJoinMax: () => number;
  // A machine that was away is back, with what it says it has running. A client restart
  // gives the host this: the rounds it names are asked about again, and what the ledger
  // ended while it was away is cleared on it (nodes.md §4.4, runner/runner.ts).
  reclaimed?: (machineId: string, runs: NodeRunSummary[]) => void;
  now?: () => number;
  log?: (line: string) => void;
}

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

// A name from outside becomes an id: the same rules the console's own machine names obey.
function cleanName(text: string): string {
  const trimmed = text.trim().replace(/[\s/\\?#%\u0000-\u001f]+/g, '-').replace(/^-+|-+$/g, '');
  return trimmed.slice(0, MAX_FACTS_CHARS) || 'machine';
}

function asFacts(value: unknown): JoinFacts {
  const facts = value as Partial<JoinFacts> | undefined;
  const field = (name: 'name' | 'platform' | 'hostname'): string => {
    const text = facts?.[name];
    if (typeof text !== 'string' || text.trim() === '') throw new InputError(`加入请求缺少 ${name}`);
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new InputError(`加入请求里的 ${name} 不是一行文字`);
    return text.trim().slice(0, MAX_FACTS_CHARS);
  };
  if (typeof facts?.node_id !== 'string' || !/^[0-9a-f]{8,64}$/.test(facts.node_id)) throw new InputError('加入请求里的机器标识不对');
  return { node_id: facts.node_id, name: field('name'), platform: field('platform'), hostname: field('hostname') };
}

// What a machine reports about its executors, as this host will keep and show it. The report
// is written by that machine and read on a page, so only the shape this protocol defines
// gets through: anything else is refused as the machine's own mistake, never shown. Its
// configuration part is the exception: an entry this host cannot read is dropped with a line,
// and the rest of the report is kept (asConfig).
function asExecutorReport(value: unknown, log: (line: string) => void): NodeExecutorReport {
  const report = value as Partial<NodeExecutorReport> | undefined;
  // The moment is what the page says the facts are from, so it has to be a moment: a string
  // that names no time would have the page showing a report of no particular age.
  if (typeof report?.at !== 'string' || !Number.isFinite(Date.parse(report.at))) throw new InputError('机器上报的执行器状态没有说是什么时候读到的');
  if (!Array.isArray(report.executors)) throw new InputError('机器上报的执行器状态不是一张清单');
  if (report.executors.length > MAX_EXECUTORS) throw new InputError(`机器上报的执行器太多（超过 ${MAX_EXECUTORS} 个）`);
  const line = (text: unknown, what: string): string => {
    if (typeof text !== 'string') throw new InputError(`执行器的 ${what} 不是文字`);
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new InputError(`执行器的 ${what} 不是一行文字`);
    return text.slice(0, MAX_EXECUTOR_CHARS);
  };
  const executors: NodeExecutorStatus[] = report.executors.map((each) => {
    const held = each as Partial<NodeExecutorStatus> | undefined;
    const executor = line(held?.executor, '名字');
    if (executor.trim() === '') throw new InputError('执行器没有名字');
    if (typeof held?.installed !== 'boolean') throw new InputError(`${executor} 有没有装不是一个是或否`);
    if (held.version != null && typeof held.version !== 'string') throw new InputError(`${executor} 的版本不是文字`);
    if (held.logged_in != null && typeof held.logged_in !== 'boolean') throw new InputError(`${executor} 登录了没有不是一个是或否`);
    if (held.error != null && typeof held.error !== 'string') throw new InputError(`${executor} 的说明不是文字`);
    if (held.path != null && typeof held.path !== 'string') throw new InputError(`${executor} 在哪里找到的不是文字`);
    if (held.unusable != null && typeof held.unusable !== 'string') throw new InputError(`${executor} 用不了的原因不是文字`);
    const config = held.config == null ? undefined : asConfig(held.config, executor, line, log);
    const identity = held.identity == null ? undefined : asIdentity(held.identity, executor);
    return {
      executor,
      installed: held.installed,
      version: held.version == null ? null : line(held.version, '版本'),
      logged_in: held.logged_in ?? null,
      ...(held.path == null ? {} : { path: line(held.path, '位置') }),
      ...(held.error == null ? {} : { error: line(held.error, '说明') }),
      ...(held.unusable == null ? {} : { unusable: line(held.unusable, '用不了的原因') }),
      ...(held.read_only == null ? {} : { read_only: asReadOnly(held.read_only, executor, line) }),
      ...(held.credential == null ? {} : { credential: asCredential(held.credential, executor) }),
      ...(held.models == null ? {} : { models: asModels(held.models, executor, line) }),
      ...(held.quota == null ? {} : { quota: asQuota(held.quota, executor, line) }),
      ...(identity === undefined ? {} : { identity }),
      ...(config === undefined ? {} : { config }),
    };
  });
  return { at: report.at.slice(0, MAX_FACTS_CHARS), executors };
}

const ENTRY_STATES: readonly NodeEntryStatus['state'][] = ['written', 'covered', 'unconfirmed', 'occupied', 'failed', 'cleared'];

// What a machine reports about the global entry, as this host will keep and show it: only the
// shape the protocol defines, like the executor report.
function asEntryReport(value: unknown): NodeEntryReport {
  const report = value as Partial<NodeEntryReport> | undefined;
  if (report === null || typeof report !== 'object') throw new InputError('机器上报的入口状态不是一份记录');
  if (report.digest !== null && (typeof report.digest !== 'string' || !/^[0-9a-f]{1,64}$/.test(report.digest))) throw new InputError('机器上报的入口摘要不对');
  if (typeof report.at !== 'string' || !Number.isFinite(Date.parse(report.at))) throw new InputError('机器上报的入口状态没有说是什么时候写的');
  if (!Array.isArray(report.executors) || report.executors.length > MAX_EXECUTORS) throw new InputError('机器上报的入口状态不是一张清单');
  const line = (text: unknown, what: string): string => {
    if (typeof text !== 'string' || /[\u0000-\u001f\u007f]/.test(text)) throw new InputError(`入口状态的 ${what} 不是一行文字`);
    return text.slice(0, MAX_EXECUTOR_CHARS);
  };
  return {
    digest: report.digest,
    at: report.at.slice(0, MAX_FACTS_CHARS),
    executors: report.executors.map((each) => {
      const held = each as Partial<NodeEntryStatus>;
      if (!ENTRY_STATES.includes(held?.state as NodeEntryStatus['state'])) throw new InputError('入口状态不是认得的一种');
      const projection = held.projection;
      if (projection !== undefined && (projection === null || typeof projection !== 'object'
        || !['absent', 'present', 'unknown'].includes(projection.state))) throw new InputError('入口投影状态不认识');
      if (projection?.state === 'present' && (!Array.isArray(projection.revisions) || projection.revisions.length > 1024
        || !projection.revisions.every((value) => typeof value === 'string' && /^[\w-]{1,80}@\d{1,15}$/.test(value)))) {
        throw new InputError('入口投影的知识修订清单不正确');
      }
      return {
        executor: line(held.executor, '执行器'), path: line(held.path, '路径'), state: held.state!,
        ...(held.note == null ? {} : { note: line(held.note, '说明') }),
        ...(projection === undefined ? {} : { projection: projection.state === 'unknown'
          ? { state: 'unknown' as const, why: line(projection.why, '投影说明') }
          : projection.state === 'present' ? { state: 'present' as const, revisions: projection.revisions } : { state: 'absent' as const } }),
      };
    }),
  };
}

// The read-only part of one executor's report: whether its way started, how far that way
// reaches, and why not — only the shape the protocol defines, as the rest of the report.
// What a machine says about its sign-ins, as this host will read it: an entry out of shape is
// dropped (and said once per poll, without what it held — a code may be in it), the rest kept.
export function asSignIns(value: unknown, log: (line: string) => void): NodeSignIn[] {
  if (!Array.isArray(value)) {
    log('上报的登录状态不是一张清单，已丢掉');
    return [];
  }
  const kept: NodeSignIn[] = [];
  let dropped = 0;
  for (const raw of value.slice(0, MAX_SIGN_INS)) {
    const each = raw as Record<string, unknown> | null;
    const text = (field: unknown, max: number): boolean => typeof field === 'string' && field !== '' && field.length <= max;
    const ok = each !== null && typeof each === 'object'
      && text(each.id, MAX_SIGN_IN_ID_CHARS) && text(each.executor, MAX_EXECUTOR_CHARS)
      && SIGN_IN_STATES.includes(each.state as never)
      && (each.url === undefined || (text(each.url, MAX_SIGN_IN_URL_CHARS) && /^https:\/\//.test(each.url as string)))
      && (each.code === undefined || text(each.code, MAX_SIGN_IN_CODE_CHARS))
      && (each.accepts_code === undefined || typeof each.accepts_code === 'boolean')
      && (each.reason === undefined || SIGN_IN_REASONS.includes(each.reason as never));
    if (!ok) {
      dropped += 1;
      continue;
    }
    kept.push({
      id: each.id as string, executor: each.executor as string, state: each.state as NodeSignIn['state'],
      ...(each.url === undefined ? {} : { url: each.url as string }),
      ...(each.code === undefined ? {} : { code: each.code as string }),
      ...(each.accepts_code === true ? { accepts_code: true } : {}),
      ...(each.reason === undefined ? {} : { reason: each.reason as NonNullable<NodeSignIn['reason']> }),
    });
  }
  dropped += Math.max(0, value.length - MAX_SIGN_INS);
  if (dropped > 0) log(`上报的登录状态里有 ${dropped} 条读不出来，已丢掉`);
  return kept;
}

function asReadOnly(value: unknown, executor: string, line: (text: unknown, what: string) => string): NonNullable<NodeExecutorStatus['read_only']> {
  const held = value as Partial<NonNullable<NodeExecutorStatus['read_only']>> | undefined;
  if (held === null || typeof held !== 'object') throw new InputError(`${executor} 的只读报告不是一份记录`);
  if (typeof held.available !== 'boolean') throw new InputError(`${executor} 只读能不能用不是一个是或否`);
  if (!isReadOnlyLayer(held.layer)) throw new InputError(`${executor} 的只读层不是认得的一种`);
  if (held.error != null && typeof held.error !== 'string') throw new InputError(`${executor} 只读的说明不是文字`);
  return {
    available: held.available, layer: held.layer, ...(held.error == null ? {} : { error: line(held.error, '只读的说明') }),
    // Anything but `true` is a client that did not say it checks a read-only round's code.
    ...(held.checks_code === true ? { checks_code: true as const } : {}),
  };
}

// Whether a machine's executor would take the token tycho hands an account's round, and why
// not: only the shape the protocol defines, as the read-only part.
function asCredential(value: unknown, executor: string): NonNullable<NodeExecutorStatus['credential']> {
  const held = value as Partial<NonNullable<NodeExecutorStatus['credential']>> | undefined;
  if (held === null || typeof held !== 'object') throw new InputError(`${executor} 的令牌采用报告不是一份记录`);
  if (typeof held.adopted !== 'boolean') throw new InputError(`${executor} 会不会采用交过去的令牌不是一个是或否`);
  if (held.error != null && typeof held.error !== 'string') throw new InputError(`${executor} 的令牌采用说明不是文字`);
  return { adopted: held.adopted, ...(held.error == null ? {} : { error: held.error.slice(0, MAX_EXECUTOR_CHARS) }) };
}

// Rebuild only the organization and validated short label; raw profile fields are discarded.
// The organization part of one executor's report: the personal subscription the executor's own
// login belongs to, normalized to lower case, or nothing when the report named none. Anything
// out of shape refuses the whole report, as the other sub-records do.
function asIdentity(value: unknown, executor: string): ExecutorIdentity {
  const held = value as Partial<ExecutorIdentity> | undefined;
  if (held === null || typeof held !== 'object' || Array.isArray(held)) throw new InputError(`${executor} 的组织标识不是一份记录`);
  const organizationId = held.organizationId == null ? held.organizationId : organizationIdOf(held.organizationId);
  if (held.organizationId !== undefined && organizationId === undefined) throw new InputError(`${executor} 的组织标识不是认得的一份标识`);
  const label = held.accountLabel;
  if (label !== undefined && label !== null && accountLabelOf(label) === undefined) throw new InputError(`${executor} 的账号显示名不是认得的短名称`);
  const plan = held.planLabel;
  if (plan !== undefined && plan !== null && planLabelOf(plan) === undefined) throw new InputError(`${executor} 的订阅档位名不是认得的短名称`);
  const route = held.routeLabel;
  if (route !== undefined && route !== null && accountLabelOf(route) === undefined) throw new InputError(`${executor} 的线路显示名不是认得的短名称`);
  const owner = held.quotaOwner;
  if (owner !== undefined && owner !== null && (typeof owner !== 'string' || !/^v1:[0-9a-f]{64}$/.test(owner))) throw new InputError(`${executor} 的额度归属标识无效`);
  let routes: ExecutorIdentity['routes'];
  if (held.routes === null) {
    routes = null;
  } else if (held.routes !== undefined) {
    if (!Array.isArray(held.routes)) throw new InputError(`${executor} 的线路列表格式无效`);
    const cleaned: NonNullable<ExecutorIdentity['routes']> = [];
    for (const raw of held.routes.slice(0, 24)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`${executor} 的线路项格式无效`);
      const id = accountLabelOf((raw as { id?: unknown }).id);
      if (!id) throw new InputError(`${executor} 的线路 ID 不是认得的短名称`);
      const rawLabel = (raw as { label?: unknown }).label;
      const label = typeof rawLabel === 'string' && rawLabel.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(rawLabel)
        ? rawLabel.trim().slice(0, 64)
        : undefined;
      const rawSource = (raw as { source?: unknown }).source;
      const source = rawSource === 'account' || rawSource === 'api-key' || rawSource === 'custom' ? rawSource : undefined;
      cleaned.push({ id, ...(label ? { label } : {}), ...(source ? { source } : {}) });
    }
    routes = cleaned;
  }
  return {
    ...(owner === undefined ? {} : { quotaOwner: owner }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(label === undefined ? {} : { accountLabel: label }),
    ...(plan === undefined ? {} : { planLabel: plan }),
    ...(route === undefined ? {} : { routeLabel: route }),
    ...(routes === undefined ? {} : { routes }),
  };
}

// The models part of one executor's report: the list its own command gave on that machine, or
// why there is none. Rebuilt field by field, so that only what the protocol names is kept and
// shown, whatever else an entry carried.
function asModels(value: unknown, executor: string, line: (text: unknown, what: string) => string): NonNullable<NodeExecutorStatus['models']> {
  const held = value as Partial<NonNullable<NodeExecutorStatus['models']>> | undefined;
  if (held === null || typeof held !== 'object') throw new InputError(`${executor} 的模型报告不是一份记录`);
  if (!Array.isArray(held.list)) throw new InputError(`${executor} 的模型报告不是一张清单`);
  if (held.list.length > NODE_MODELS_MAX) throw new InputError(`${executor} 报告的模型太多（超过 ${NODE_MODELS_MAX} 个）`);
  const list = held.list.map((each: unknown): ModelInfo => {
    const model = each as Partial<ModelInfo> | undefined;
    if (model === null || typeof model !== 'object') throw new InputError(`${executor} 报告的一个模型不是一份记录`);
    const id = line(model.id, '模型名');
    if (id.trim() === '') throw new InputError(`${executor} 报告的一个模型没有名字`);
    if (model.efforts != null && !Array.isArray(model.efforts)) throw new InputError(`${executor} 的模型 ${id} 的推理强度不是一张清单`);
    if (model.efforts != null && model.efforts.length > NODE_MODEL_EFFORTS_MAX) throw new InputError(`${executor} 的模型 ${id} 的推理强度太多（超过 ${NODE_MODEL_EFFORTS_MAX} 个）`);
    if (model.hidden != null && typeof model.hidden !== 'boolean') throw new InputError(`${executor} 的模型 ${id} 藏没藏起来不是一个是或否`);
    return {
      id,
      ...(model.name == null ? {} : { name: line(model.name, '模型的显示名') }),
      ...(model.efforts == null ? {} : { efforts: model.efforts.map((effort) => line(effort, '模型的推理强度')) }),
      ...(model.defaultEffort == null ? {} : { defaultEffort: line(model.defaultEffort, '模型的默认推理强度') }),
      ...(model.hidden == null ? {} : { hidden: model.hidden }),
    };
  });
  return { list, ...(held.error == null ? {} : { error: line(held.error, '模型的说明') }) };
}

// The quota part of one executor's report (docs/design/usage.md §3): the windows the machine
// read of its own login there and when it read them, or why nothing was read. Rebuilt field by
// field like the models, so that only what the protocol names is kept.
function asQuota(value: unknown, executor: string, line: (text: unknown, what: string) => string): NonNullable<NodeExecutorStatus['quota']> {
  const held = value as Partial<NonNullable<NodeExecutorStatus['quota']>> | undefined;
  if (held === null || typeof held !== 'object') throw new InputError(`${executor} 的额度报告不是一份记录`);
  if (typeof held.at !== 'string' || !Number.isFinite(Date.parse(held.at))) throw new InputError(`${executor} 的额度报告没有说是哪一刻读到的`);
  if (!Array.isArray(held.windows)) throw new InputError(`${executor} 的额度报告不是一张窗口清单`);
  if (held.windows.length > NODE_QUOTA_WINDOWS_MAX) throw new InputError(`${executor} 报告的额度窗口太多（超过 ${NODE_QUOTA_WINDOWS_MAX} 个）`);
  if (held.error != null && typeof held.error !== 'string') throw new InputError(`${executor} 的额度说明不是文字`);
  if (held.absent !== undefined && held.absent !== true) throw new InputError(`${executor} 的额度报告里“没有读到窗口”这个标记不是真`);
  if (held.absent === true && held.windows.length > 0) throw new InputError(`${executor} 的额度报告既说没有窗口又带着窗口`);
  const windows = held.windows.map((each: unknown): QuotaWindow => {
    const window = each as Partial<QuotaWindow> | undefined;
    if (window === null || typeof window !== 'object') throw new InputError(`${executor} 报告的一个额度窗口不是一份记录`);
    const name = line(window.window, '额度窗口名');
    if (name.trim() === '') throw new InputError(`${executor} 报告的一个额度窗口没有名字`);
    if (typeof window.used !== 'number' || !(window.used >= 0 && window.used <= 1)) throw new InputError(`${executor} 的额度窗口 ${name} 的用量不是 0 到 1 之间的数`);
    const resets = window.resets_at;
    if (resets !== null && (typeof resets !== 'string' || !Number.isFinite(Date.parse(resets)))) throw new InputError(`${executor} 的额度窗口 ${name} 的重置时刻读不出来`);
    return { window: name, used: window.used, resets_at: resets };
  });
  return { at: held.at.slice(0, MAX_FACTS_CHARS), windows, ...(held.absent === true ? { absent: true } : {}), ...(held.error == null ? {} : { error: line(held.error, '额度说明') }) };
}

// The configuration part of one executor's report (knowledge-and-skills.md §1.2): kind by kind,
// the names its own commands listed on that machine, or why none were read. Rebuilt field by
// field like the models, so that only what the protocol names is kept. An entry this host does
// not know, or one out of shape, is dropped and said once per poll: a client newer than the
// host is no reason for its machine to look away. Not a list at all is taken as no report.
function asConfig(value: unknown, executor: string, line: (text: unknown, what: string) => string, log: (line: string) => void): NonNullable<NodeExecutorStatus['config']> | undefined {
  if (!Array.isArray(value)) {
    log(`${executor} 上报的配置不是一张清单，已丢掉`);
    return undefined;
  }
  const oneLine = (text: unknown): text is string => typeof text === 'string' && !/[\u0000-\u001f\u007f]/.test(text);
  const kept: NonNullable<NodeExecutorStatus['config']> = [];
  let dropped = Math.max(0, value.length - CONFIG_KINDS.length);
  for (const each of value.slice(0, CONFIG_KINDS.length)) {
    const held = each as { kind?: unknown; names?: unknown; error?: unknown } | null;
    if (held === null || typeof held !== 'object' || !isConfigKind(held.kind)) {
      dropped += 1;
      continue;
    }
    const { names, error } = held;
    if (names != null && (!Array.isArray(names) || names.length > NODE_CONFIG_NAMES_MAX || !names.every(oneLine))) {
      dropped += 1;
      continue;
    }
    if (error != null && !oneLine(error)) {
      dropped += 1;
      continue;
    }
    kept.push({
      kind: held.kind,
      ...(names == null ? {} : { names: (names as string[]).map((name) => line(name, '配置的名字')) }),
      ...(error == null ? {} : { error: line(error, '配置的说明') }),
    });
  }
  if (dropped > 0) log(`${executor} 的配置报告里有 ${dropped} 条读不出来，已丢掉`);
  return kept;
}

// What a client reports about the version it runs (docs/design/nodes.md §1.4). Frozen shape
// (shared/node-protocol.ts): a report out of it is a machine and a host that disagree about
// the shape, which is said as a refusal rather than kept as a page's fact.
function asReleaseReport(value: unknown): NodeReleaseReport {
  const held = value as Partial<NodeReleaseReport> | undefined;
  const line = (text: unknown, what: string): string => {
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_EXECUTOR_CHARS || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new InputError(`机器报的${what}读不出来`);
    }
    return text;
  };
  const version = line(held?.version, '版本');
  const up = held?.upgrade;
  if (up === null || up === undefined) return { version, upgrade: null };
  if (typeof up !== 'object') throw new InputError('机器报的换版状态读不出来');
  const state = (up as { state?: unknown }).state;
  if (state !== 'waiting' && state !== 'failed') throw new InputError('机器报的换版状态不是 waiting 或 failed');
  const { target, detail } = up as { target?: unknown; detail?: unknown };
  return { version, upgrade: { state, target: line(target, '目标版本'), detail: line(detail, '换版说明') } };
}

export function createNodes(options: NodeOptions) {
  const { ledger } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  // Memory only: a restart voids outstanding join requests, like a device login
  // (nodes.md §3, the third point of the conclusion).
  const joins = new Map<string, PendingJoin>();
  const online = new Map<string, Online>();
  // The name may be reused after Owner removal; diagnostics belong to the ledger registration.
  const serviceManagers = new Map<string, { uid: string; report: ServiceManagerReport }>();
  const queued = new Map<string, NodeCommand[]>();
  const waiting = new Map<string, Waiting>();
  const pending = new Map<string, Delivery>();
  const seenWritten = new Map<string, number>();
  // The protocol version a machine's client last came in with, when it was not this host's:
  // a fact about that machine, and the reason a Run on it must not be read as lost (§5.3).
  const refused = new Map<string, { version: number | null; at: number }>();
  // What each machine last said about the version it runs and what it is doing about being
  // behind this host (§1.4). Memory only: the host asks again after a restart.
  const releases = new Map<string, NodeReleaseHeld>();
  // Set once, after the Runner exists: what to do when a machine that was away comes back.
  let reclaimed: ((machineId: string, runs: NodeRunSummary[]) => void) | undefined;
  // Set once, after the sign-ins exist: who hears what a machine says about its sign-ins.
  let signInsHeard: ((machineId: string, entries: NodeSignIn[]) => void) | undefined;
  // Set once, after the models catalog exists: who hears what a machine reports of its executors.
  let executorsHeard: ((machineId: string, report: NodeExecutorReport) => void) | undefined;
  // Set once the channels exist: who is told that a machine is asking to be let in.
  let announced: ((join: PendingJoinView & { id: string }) => void) | undefined;
  // What became of requests that are gone, by request id, so that a card pressed after the
  // fact is told the truth. Memory only and bounded, like the requests themselves.
  const ended = new Map<string, { state: 'expired' | 'handled'; at: number }>();

  const iso = (at: number): string => new Date(at).toISOString();

  function endJoin(id: string, state: 'expired' | 'handled'): void {
    ended.set(id, { state, at: now() });
    const cutoff = now() - options.endedJoinKeepMs();
    const most = options.endedJoinMax();
    for (const [key, held] of ended) if (held.at < cutoff || ended.size > most) ended.delete(key);
  }

  // Here: a poll of its is open, or one was answered a moment ago and the next is on its way.
  const connected = (machineId: string): boolean => {
    if (waiting.has(machineId)) return true;
    const held = online.get(machineId);
    return held !== undefined && now() - held.endedAt < options.gapSlackMs();
  };

  // §6: while the ledger cannot take a write, no node is given anything to do, and what was
  // waiting for one is dropped rather than held until it is delivered behind the owner's back.
  const barriers = (): Barriers => options.barriers?.() ?? { degraded: false, recovering: false };
  const steady = (): boolean => {
    const held = barriers();
    return !held.degraded && !held.recovering;
  };

  // What a machine last told this host about its own executors, written where the pages and
  // the checks read it from (nodes.md §1.2). Null is "it has not said": not "nothing is
  // installed there".
  function remember(machineId: string, report: NodeExecutorReport): void {
    const held = online.get(machineId);
    if (held?.executors && Date.parse(held.executors.at) > Date.parse(report.at)) return;
    if (held) {
      // A probe answer may arrive after a poll carrying quota for the same probe.
      if (held.executors?.at === report.at) {
        report = { ...report, executors: report.executors.map((status) => {
          const prior = held.executors?.executors.find((each) => each.executor === status.executor);
          const previous = prior?.identity?.quotaOwner === status.identity?.quotaOwner && prior?.identity?.organizationId === status.identity?.organizationId && status.logged_in !== false ? prior?.quota : undefined;
          return previous && (!status.quota || Date.parse(previous.at) > Date.parse(status.quota.at)) ? { ...status, quota: previous } : status;
        }) };
      }
      held.executors = report;
    }
    learned(machineId, report);
    executorsHeard?.(machineId, report);
  }

  // What the machine reported about its skill mirror and any non-mirror local skills.
  // Malformed entries are dropped rather than failing the poll.
  function asSkillsReport(value: unknown, logLine: (line: string) => void): NodeSkillsReport | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      logLine('上报的技能状态不是对象，已忽略');
      return undefined;
    }
    const raw = value as Partial<NodeSkillsReport>;
    const digest = typeof raw.digest === 'string' ? raw.digest.slice(0, MAX_FACTS_CHARS) : '';
    const cleanLine = (text: unknown, max: number): string | null => {
      if (typeof text !== 'string') return null;
      const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
      return cleaned.slice(0, max);
    };
    const synced = Array.isArray(raw.synced)
      ? raw.synced.map((each) => cleanLine(each, MAX_FACTS_CHARS)).filter((each): each is string => Boolean(each)).slice(0, NODE_LOCAL_SKILLS_MAX)
      : [];
    let localSkills: NodeLocalSkillSummary[] | undefined;
    if (Array.isArray(raw.local_skills)) {
      const seen = new Set<string>();
      const kept: NodeLocalSkillSummary[] = [];
      for (const item of raw.local_skills) {
        if (kept.length >= NODE_LOCAL_SKILLS_MAX) break;
        if (item === null || typeof item !== 'object') continue;
        const entry = item as Partial<NodeLocalSkillSummary>;
        const slug = cleanLine(entry.slug, MAX_FACTS_CHARS);
        if (!slug || seen.has(slug)) continue;
        const name = cleanLine(entry.name, MAX_FACTS_CHARS) || slug;
        const description = cleanLine(entry.description ?? '', NODE_LOCAL_SKILL_DESC_MAX) ?? '';
        seen.add(slug);
        kept.push({ slug, name, description });
      }
      localSkills = kept;
    }
    const error = typeof raw.error === 'string' ? cleanLine(raw.error, MAX_EXECUTOR_CHARS) ?? undefined : undefined;
    return {
      digest,
      synced,
      ...(localSkills !== undefined ? { local_skills: localSkills } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  // Everything this host learns from one report of a machine's executors, in the order the two
  // depend on each other: a login it reports signed in is adopted first, and a quota it read
  // under that login is kept after. Called wherever a report arrives — a poll or an answer to
  // the host's own "look now" — so that both paths learn the same things once.
  function learned(machineId: string, report: NodeExecutorReport): void {
    signedIn(machineId, report);
    noteIdentities(machineId, report);
    noteQuotas(machineId, report);
  }

  // Which organization a machine's own login reported it belongs to. Written after adoption and
  // before the quota, so a login whose account changed drops the windows read under the old
  // organization before this report's reading names the new one (docs/design/usage.md §3). A
  // report about an executor this machine has no login for writes nothing.
  function noteIdentities(machineId: string, report: NodeExecutorReport): void {
    for (const status of report.executors) {
      if (status.identity === undefined && status.logged_in !== false) continue;
      try {
        const login = options.ledger.getMachineLogin(machineId, status.executor);
        if (login) options.ledger.noteMachineIdentity(login.id, status.logged_in === false ? { accountLabel: null, routeLabel: null, quotaOwner: null, organizationId: null } : status.identity!);
      } catch (err) {
        log(`机器 ${machineId} 报告 ${status.executor} 的登录标识，没能记下：${String(err)}`);
      }
    }
  }

  // What a machine read of its own logins' quota goes where the rounds' figures go
  // (docs/design/usage.md §3): with that login, whose machine and executor the report names.
  // The moment is the machine's own, so a report that arrives after a later reading never
  // overwrites it. A report about an executor this machine has no login for writes nothing: a
  // login is adopted by the call above, which is why that one comes first.
  const latestQuotas = new Map<string, { at: number; value: string }>();
  function noteQuotas(machineId: string, report: NodeExecutorReport): void {
    for (const status of report.executors) {
      const quota = status.quota;
      if (quota === undefined) continue;
      try {
        const login = options.ledger.getMachineLogin(machineId, status.executor);
        // The protocol names a window's reset time as the ledger holds it, and the other way
        // round: the one shape is mapped here, at the one place a report becomes ledger state.
        if (login) {
          const identity = options.ledger.loginState(login.id).identity;
          if (status.logged_in === false || (identity.quotaOwner !== undefined && status.identity?.quotaOwner !== identity.quotaOwner) || (identity.organizationId !== undefined && status.identity?.organizationId !== identity.organizationId)) continue;
          const at = Date.parse(quota.at);
          const value = JSON.stringify(quota);
          const previous = latestQuotas.get(login.id);
          const changed = Number.isFinite(at) && (!previous || at > previous.at || (at === previous.at && value !== previous.value));
          options.ledger.noteQuota(login.id, quota.windows.map(({ window, used, resets_at: resetsAt }) => ({ window, used, resetsAt })), quota.at, changed);
          if (changed) latestQuotas.set(login.id, { at, value });
        }
      } catch (err) {
        log(`机器 ${machineId} 报告 ${status.executor} 的额度，没能记下：${String(err)}`);
      }
    }
  }

  // A machine's own login its executor refused comes back once the machine says, from a probe
  // made after the refusal, that the executor is signed in (the ledger compares the times).
  // And a login the machine reports it can run, with none set up here, is adopted at once with
  // the tiers its adapter declares (docs/design/accounts-machines-decoupled.md): the machine's
  // own login is what it says it is, not something the owner has to declare twice. Whether
  // there is one to adopt is dispatch's own judgment of the same report (`ownLoginHere`), so
  // nothing is written that no round could ever use — an executor with no command that answers
  // "signed in?" (`logged_in: null`) is taken at its word like everywhere else. A report with
  // nothing to add writes nothing. A failed write leaves the next report to try again: a report
  // is never refused for it.
  function signedIn(machineId: string, report: NodeExecutorReport): void {
    for (const status of report.executors) {
      if (!ownLoginHere(status)) continue;
      try {
        const login = options.ledger.getMachineLogin(machineId, status.executor);
        if (login) {
          // Coming back from a refusal wants the machine's own word that it is signed in; a
          // report that cannot say is enough to adopt a login, not to clear a refusal.
          if (status.logged_in === true) options.ledger.signedInAgain(login.id, report.at);
          continue;
        }
        const tiers = options.ownLoginTiers?.(status.executor);
        if (tiers !== undefined) options.ledger.adoptMachineLogin(machineId, status.executor, tiers, { actor: 'service' }, status.identity);
      } catch (err) {
        log(`机器 ${machineId} 报告 ${status.executor} 已登录，没能记下：${String(err)}`);
      }
    }
  }

  // Send one command and wait for its answer. Throws NodeAway when the machine is not
  // connected, NodeCommandTimeout when it took one and never answered — or when it never
  // said it took it at all, which is the same thing for the caller: the answer to both is
  // a state question. `timeoutMs` overrides the setting for one call, for a caller the owner
  // is waiting on (a connection test): a delivery given up on is dropped there and then, so
  // it is never handed to the machine a second time.
  function sendTo(machineId: string, command: NodeCommandInput, timeoutMs?: number): Promise<unknown> {
    if (!steady()) {
      dropEverything();
      return Promise.reject(new NodeAway('服务处于降级模式，现在不能向机器发命令'));
    }
    if (!connected(machineId)) return Promise.reject(new NodeAway(`机器 ${machineId} 没有连回来`));
    const full = { ...command, id: randomUUID() } as NodeCommand;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(full.id);
        const queue = queued.get(machineId);
        if (queue) queued.set(machineId, queue.filter((each) => each.id !== full.id));
        reject(new NodeCommandTimeout(`机器 ${machineId} 收到 ${full.kind} 后没有回答`));
      }, timeoutMs ?? options.commandTimeoutMs());
      // A machine that never answers is not a reason to hold a process open: the caller
      // is answered when this fires, and its own shutdown is not held up by it.
      timer.unref?.();
      pending.set(full.id, { machineId, command: full, handedOut: false, received: false, resolve, reject, timer });
      queued.set(machineId, [...(queued.get(machineId) ?? []), full]);
      deliver(machineId);
    });
  }

  function dropEverything(): void {
    queued.clear();
    for (const [id, delivery] of pending) {
      pending.delete(id);
      clearTimeout(delivery.timer);
      delivery.reject(new NodeAway('服务处于降级模式，现在不能向机器发命令'));
    }
  }

  function expireJoins(): void {
    // An approved registration expires like any other: the token is in the machine's hands
    // once it is collected, and until then the owner's release has a life (§9).
    for (const [secretHash, join] of joins) {
      if (join.expires_at > now()) continue;
      joins.delete(secretHash);
      // One the owner answered was ended then; one nobody answered ends now.
      if (join.state === 'pending') endJoin(join.id, 'expired');
    }
  }

  function joinByCode(code: unknown): PendingJoin | undefined {
    expireJoins();
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return undefined;
    return [...joins.values()].find((join) => join.state === 'pending' && join.code === code);
  }

  // The machine object is written in the same act as the release, so the console's list
  // and the token the client will collect cannot disagree.
  function admit(facts: JoinFacts, ctx: Ctx, local: boolean): { machine: MachineRecord; token: string } {
    const token = randomBytes(32).toString('hex');
    const machine = ledger.joinMachine({
      id: freeMachineId(facts.name), host: facts.hostname || facts.name, nodeId: facts.node_id,
      tokenHash: hashOf(token), platform: facts.platform, source: null, ephemeral: false, ...(local ? { local: true } : {}),
    }, ctx);
    return { machine, token };
  }

  function refuseKnown(facts: JoinFacts): void {
    const held = ledger.machineByNodeId(facts.node_id);
    if (held) throw new InputError(`这台机器已经加入过了（${held.id}）：在控制台删掉它，或者用它原来的身份重新连回来`);
  }

  // The owner's answer, by the six digits (the console) or by the request's own id (a card).
  // A request that is gone is said to be gone the way it went.
  function decide(ref: { code: unknown } | { id: unknown }, approve: boolean, ctx: Ctx): JoinDecision {
    expireJoins();
    let join: PendingJoin | undefined;
    if ('code' in ref) join = joinByCode(ref.code);
    else {
      if (typeof ref.id !== 'string') return { state: 'missing' };
      join = [...joins.values()].find((each) => each.id === ref.id);
      if (!join) return { state: ended.get(ref.id)?.state ?? 'missing' };
      if (join.state !== 'pending') return { state: 'handled' };
    }
    if (!join) return { state: 'missing' };
    assertSteady(barriers(), approve ? '放行机器' : '拒绝机器');
    if (!approve) {
      // Written first: a refusal the ledger could not record leaves the request waiting.
      ledger.noteAction('machine.join_rejected', ctx);
      join.state = 'rejected';
      endJoin(join.id, 'handled');
      return { state: 'rejected', join: view(join) };
    }
    const { machine, token } = admit(join.facts, ctx, false);
    join.state = 'approved';
    join.machine_id = machine.id;
    join.token = token;
    endJoin(join.id, 'handled');
    return { state: 'approved', machine, join: view(join) };
  }

  const view = (join: PendingJoin): PendingJoinView => ({
    code: join.code, name: join.facts.name, platform: join.facts.platform, hostname: join.facts.hostname,
    created_at: iso(join.created_at), expires_at: iso(join.expires_at),
  });

  // A name the owner will read in a list, taken from what the machine calls itself and
  // made unique: a second machine of the same name gets a number after it.
  function freeMachineId(name: string): string {
    const base = cleanName(name);
    if (!ledger.getMachine(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}@${n}`;
      if (!ledger.getMachine(candidate)) return candidate;
    }
    throw new InputError(`机器名 ${base} 用得太多，换一个名字`);
  }

  function noteSeen(machineId: string, at: number): void {
    const last = seenWritten.get(machineId) ?? 0;
    if (at - last < SEEN_WRITE_EVERY_MS) return;
    seenWritten.set(machineId, at);
    try {
      ledger.noteMachineSeen(machineId, iso(at));
    } catch (err) {
      // Being heard from is evidence for the pages, not a reason to drop a poll.
      log(`记下机器 ${machineId} 的最近往来失败：${String(err)}`);
    }
  }

  function finishWaiting(machineId: string, command: NodeCommand | null): void {
    const holder = waiting.get(machineId);
    if (!holder) return;
    waiting.delete(machineId);
    if (holder.timer) clearTimeout(holder.timer);
    // From here the machine is between polls, and the clock on its coming back starts.
    const held = online.get(machineId);
    if (held !== undefined && held.poll === holder.poll) held.endedAt = now();
    holder.resolve(command);
  }

  function takeQueued(machineId: string): NodeCommand | undefined {
    const queue = queued.get(machineId);
    while (queue && queue.length > 0) {
      const command = queue.shift()!;
      const delivery = pending.get(command.id);
      // A command the caller gave up on is not delivered, and neither is one the machine
      // has already named: nothing is ever delivered twice.
      if (delivery && !delivery.received) return command;
    }
    return undefined;
  }

  function deliver(machineId: string): void {
    const holder = waiting.get(machineId);
    if (!holder) return;
    const command = takeQueued(machineId);
    if (!command) return;
    pending.get(command.id)!.handedOut = true;
    holder.handed = command;
    finishWaiting(machineId, command);
  }

  // The command this machine was handed and has not named back. At most one: the host hands
  // a command to a poll it is holding, and nothing else is handed over until the machine
  // says what became of that one.
  function inHand(machineId: string): Delivery | undefined {
    for (const delivery of pending.values()) {
      if (delivery.machineId === machineId && delivery.handedOut && !delivery.received) return delivery;
    }
    return undefined;
  }

  // What the machine says it took, asked of every poll: its cursor names the last command
  // it was given. Nothing else proves a command left this process — bytes written into a
  // socket nobody is reading look exactly like bytes that arrived — so this is the whole of
  // the evidence there is. The one it names it has, and never gets again; the command this
  // connection was handed and it does not name is one it never saw.
  function takeWord(machineId: string, cursor: unknown): void {
    if (typeof cursor === 'string') {
      const named = pending.get(cursor);
      if (named?.machineId === machineId) named.received = true;
    }
    const held = inHand(machineId);
    if (held && cursor !== held.command.id) notDelivered(held, '它下一次连回来时没有提起它');
  }

  // A hand-out the machine never named was never delivered. Everything but a start only
  // reads, or is safe to do twice, so it goes back to the front of the queue for the next
  // connection. A start may have been taken — the bytes may have gone out before the socket
  // went — and is never handed over twice: its caller is told now, rather than waiting out a
  // timeout for an answer that cannot come, and what became of the round is a state question
  // (§4.2, §8.2).
  function notDelivered(delivery: Delivery, why: string): void {
    delivery.handedOut = false;
    if (delivery.command.kind === 'start') {
      pending.delete(delivery.command.id);
      clearTimeout(delivery.timer);
      delivery.reject(new NodeCommandTimeout(
        `机器 ${delivery.machineId} 没有说收到这一轮的启动（${why}）：启动不重发，改问状态`,
      ));
      return;
    }
    const queue = queued.get(delivery.machineId) ?? [];
    queued.set(delivery.machineId, [delivery.command, ...queue.filter((each) => each.id !== delivery.command.id)]);
    deliver(delivery.machineId);
  }

  // The connection this poll is answered on is gone. Whatever was written into it that the
  // machine never named is not delivered either: it waits for the next connection. The
  // machine stops counting as here: the connection was the whole of the proof, and a client
  // that is killed, restarted or cut off is one whose next poll is a machine coming back
  // (nodes.md §4.4). The judgement about its Runs is the Runner's, from the calls that now
  // fail at once rather than waiting out a command timeout.
  function connectionGone(machineId: string, holder: Waiting): void {
    if (waiting.get(machineId) === holder) finishWaiting(machineId, null);
    if (holder.poll !== undefined && online.get(machineId)?.poll === holder.poll) online.delete(machineId);
    const command = holder.handed;
    if (!command) return;
    holder.handed = null;
    const delivery = pending.get(command.id);
    if (delivery && !delivery.received) notDelivered(delivery, '连接在它开口之前断了');
  }

  return {
    // --- the join ---------------------------------------------------------------

    // A machine that has never been here asks to be let in. Nothing is written until the
    // owner approves: the request lives in memory, as the six digits are only there to
    // point at it.
    register(rawFacts: unknown): { code: string; secret: string; expires_at: string } {
      expireJoins();
      const facts = asFacts(rawFacts);
      refuseKnown(facts);
      if ([...joins.values()].filter((join) => join.state === 'pending').length >= MAX_PENDING_JOINS) {
        throw new InputError('现在等着放行的机器太多，过一会儿再试');
      }
      const used = new Set([...joins.values()].map((join) => join.code));
      let number = randomInt(1_000_000);
      while (used.has(number.toString().padStart(6, '0'))) number = (number + 1) % 1_000_000;
      const secret = randomBytes(32).toString('hex');
      const at = now();
      const expires = at + options.joinTtlMs();
      const join: PendingJoin = {
        id: randomBytes(12).toString('hex'), code: number.toString().padStart(6, '0'), facts, created_at: at, expires_at: expires, state: 'pending',
      };
      joins.set(hashOf(secret), join);
      // Telling the owner is a courtesy on top of the console's list: a card that does not
      // go out leaves the request where it is.
      try {
        announced?.({ ...view(join), id: join.id });
      } catch (err) {
        log(`新机器加入请求的通知没有发出：${(err as Error).message}`);
      }
      return { code: join.code, secret, expires_at: iso(expires) };
    },

    // This host's own user joining this host (nodes.md §1.1 step 2): the caller has shown
    // the token in service.json on the inside listener's loopback, which only the user
    // running the host can read. Let in on the spot, in one ledger write, with no request
    // left behind for anyone to answer.
    admitLocal(rawFacts: unknown, ctx: Ctx): NodeJoinAnswer {
      const facts = asFacts(rawFacts);
      refuseKnown(facts);
      const { machine, token } = admit(facts, ctx, true);
      return { protocol: NODE_PROTOCOL, state: 'approved', token, machine_id: machine.id };
    },

    // Who is told when a machine asks to be let in. Set once the channels exist.
    onJoinRequest(handler: (join: PendingJoinView & { id: string }) => void): void {
      announced = handler;
    },

    decide,

    // The machine comes back with the secret it kept. The same secret always reaches the
    // same registration: repeating the request never makes a second machine.
    claim(secret: unknown): NodeJoinAnswer {
      expireJoins();
      if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) return { protocol: NODE_PROTOCOL, state: 'missing' };
      const join = joins.get(hashOf(secret));
      if (!join) return { protocol: NODE_PROTOCOL, state: 'missing' };
      if (join.state === 'rejected') {
        joins.delete(hashOf(secret));
        return { protocol: NODE_PROTOCOL, state: 'rejected' };
      }
      if (join.state === 'pending') {
        return { protocol: NODE_PROTOCOL, state: 'pending', code: join.code, secret, expires_at: iso(join.expires_at) };
      }
      const { machine_id: machineId, token } = join;
      // The same secret collects the same token for as long as the release lives: a response
      // lost on the way, or a machine that died before writing it down, must not leave the
      // owner to delete the machine and let it in again (§9).
      if (!machineId || !token) return { protocol: NODE_PROTOCOL, state: 'missing' };
      return { protocol: NODE_PROTOCOL, state: 'approved', token, machine_id: machineId };
    },

    pendingJoins(): PendingJoinView[] {
      expireJoins();
      return [...joins.values()].filter((join) => join.state === 'pending').map(view);
    },

    // The owner lets one in by its six digits.
    approve(code: unknown, ctx: Ctx): MachineRecord | undefined {
      const decided = decide({ code }, true, ctx);
      return decided.state === 'approved' ? decided.machine : undefined;
    },

    // The other way in (nodes.md §1.3): a machine a task spawned comes with the one-time
    // material its creator was handed, and a secret of its own. No six digits, no owner:
    // the quota the Router asked for is the authorization. The material is checked by its
    // hash in the ledger, in the same transaction that writes the machine; the material
    // itself is in this process's memory for the length of this call and nowhere else.
    redeem(rawFacts: unknown, invite: unknown, ctx: Ctx): NodeJoinAnswer {
      const facts = asFacts(rawFacts);
      const held = invite as Partial<{ material: unknown; secret: unknown }> | undefined;
      if (typeof held?.material !== 'string' || !/^[0-9a-f]{64}$/.test(held.material)) throw new InputError('接入材料的形状不对：应该是 64 位十六进制');
      if (typeof held.secret !== 'string' || !/^[0-9a-f]{64}$/.test(held.secret)) throw new InputError('认领秘密的形状不对：应该是 64 位十六进制');
      const token = randomBytes(32).toString('hex');
      const machine = ledger.redeemInvite({
        materialHash: hashOf(held.material), claimHash: hashOf(held.secret), facts,
        machineId: freeMachineId(facts.name), tokenHash: hashOf(token),
      }, ctx);
      return { protocol: NODE_PROTOCOL, state: 'approved', token, machine_id: machine.id };
    },

    reject(code: unknown, ctx: Ctx): boolean {
      return decide({ code }, false, ctx).state === 'rejected';
    },

    // --- the client's calls -------------------------------------------------------

    // What to do when a machine that was away comes back. Set after the Runner exists: the
    // hub is made before it, and a poll cannot arrive before the host is listening.
    onReclaim(handler: (machineId: string, runs: NodeRunSummary[]) => void): void {
      reclaimed = handler;
    },

    // A token's machine, or undefined. Every poll, report and snapshot asks this: a
    // machine the owner removed answers 401 from its very next request.
    authenticate(token: string | undefined): MachineRecord | undefined {
      if (!token) return undefined;
      return ledger.machineByNodeToken(hashOf(token));
    },

    // The client's question: hold it open until there is one command, or until the hold
    // runs out. What the machine says about itself is kept for the pages, and `cursor` is
    // what it says about the command it was last given. `onHold` is told the hold when one
    // begins, so the machine can be told how long to wait.
    poll(
      machineId: string,
      asked: { runs: NodeRunSummary[]; facts: JoinFacts; cursor?: string | null; executors?: unknown; entry?: unknown; skills?: unknown; sign_ins?: unknown; drops_task_code?: unknown; bounded_output?:unknown; output?:unknown; output_ready?:boolean; service_manager?:unknown },
      signal?: AbortSignal,
      onHold?: (holdMs: number) => void,
    ): Promise<NodeCommand | null> {
      const at = now();
      const wasAway = !connected(machineId);
      // What it says about its executors is read before the record is made: a report this
      // host will not keep is the machine's own mistake, and is answered as one — except its
      // configuration part, whose unreadable entries are dropped with a line and the rest
      // kept (asConfig). A poll that carries none is a machine with no news, not one that
      // has none: the last report stands until it is replaced by a newer one.
      const fresh = asked.executors === undefined ? undefined : asExecutorReport(asked.executors, (line) => log(`机器 ${machineId} ${line}`));
      const executors = online.get(machineId)?.executors;
      const entry = asked.entry === undefined ? undefined : asEntryReport(asked.entry);
      const skills = asked.skills === undefined ? online.get(machineId)?.skills : asSkillsReport(asked.skills, (line) => log(`机器 ${machineId} ${line}`));
      const output=outputReport(asked.output);
      const serviceManager = serviceManagerReport(asked.service_manager);
      if (serviceManager !== undefined) {
        const registration = ledger.getMachine(machineId);
        if (registration) serviceManagers.set(machineId, { uid: registration.uid, report: serviceManager });
        else serviceManagers.delete(machineId);
      }
      const poll = Symbol('poll');
      online.set(machineId, { boundedOutput:asked.bounded_output===1, ...(output?{output}:{}), at, endedAt: at, facts: asked.facts, runs: asked.runs, poll, dropsTaskCode: asked.drops_task_code === true, ...(executors === undefined ? {} : { executors }), ...(entry === undefined ? {} : { entry }), ...(skills === undefined ? {} : { skills }) });
      noteSeen(machineId, at);
      if (fresh !== undefined) remember(machineId, fresh);
      // What it says about the sign-ins it runs: an entry out of shape is dropped and said, and
      // never fails the poll.
      if (asked.sign_ins !== undefined) {
        const entries = asSignIns(asked.sign_ins, (line) => log(`机器 ${machineId} ${line}`));
        try {
          signInsHeard?.(machineId, entries);
        } catch (err) {
          log(`机器 ${machineId} 报来的登录状态没能记下：${String(err)}`);
        }
      }
      // A write that failed while this machine was being noted takes the host out of
      // service: what is in the queue now is not delivered (§6).
      if (!steady()) {
        dropEverything();
        return Promise.resolve(null);
      }
      if (wasAway) {
        log(`机器 ${machineId} 连回来了`);
        // It says what it has running. That is the host's cue to ask about those rounds
        // again instead of waiting for its own next look, and to clear what it ended while
        // the machine was away (nodes.md §4.4): a client that restarts reclaims the round
        // it was watching. Told even when it has nothing running: that it is back is what
        // ends its cooldown and brings the sweep forward. Whatever the host does about it,
        // a poll is never failed by it.
        try {
          (reclaimed ?? options.reclaimed)?.(machineId, asked.runs);
        } catch (err) {
          log(`机器 ${machineId} 连回来后认领出错：${String(err)}`);
        }
      }
      // A poll that arrives while another is held replaces it: one client, one question.
      finishWaiting(machineId, null);
      // Its word comes before what it is given: a hand-out it does not name was never
      // delivered, and goes back to the front of the queue this poll is about to read.
      takeWord(machineId, asked.cursor);
      return new Promise<NodeCommand | null>((resolve) => {
        // A connection that is already gone is not one to hold anything for: nothing
        // written here would be read, so the command keeps waiting for the next one.
        if (signal?.aborted) {
          resolve(null);
          return;
        }
        const command = takeQueued(machineId);
        const holder: Waiting = { resolve, handed: command ?? null, poll };
        if (command) {
          // Answered in the same breath, and handed over all the same: this connection is
          // the one carrying it, and only the machine's next poll says it arrived.
          pending.get(command.id)!.handedOut = true;
        } else if (asked.output_ready) {
          resolve(null);
        } else {
          const holdMs = options.pollHoldMs(machineId);
          onHold?.(holdMs);
          const timer = setTimeout(() => finishWaiting(machineId, null), holdMs);
          // The socket this answer goes out on is what keeps the process alive; a timer
          // that outlived every client must not.
          timer.unref?.();
          holder.timer = timer;
          waiting.set(machineId, holder);
        }
        signal?.addEventListener('abort', () => connectionGone(machineId, holder), { once: true });
        if (command) resolve(command);
      });
    },

    // What the machine answered. A report for a command nobody waits for any more (the
    // caller gave up) is dropped: the truth about that Run comes from a state question.
    // Only the machine the command was given to may answer it (§8.2).
    report(machineId: string, commandId: string, ok: boolean, result: unknown, error?: string): boolean {
      const delivery = pending.get(commandId);
      if (!delivery) return false;
      if (delivery.machineId !== machineId) {
        log(`机器 ${machineId} 回报了发给 ${delivery.machineId} 的命令 ${commandId}：已忽略`);
        return false;
      }
      pending.delete(commandId);
      clearTimeout(delivery.timer);
      if (ok) delivery.resolve(result);
      else delivery.reject(new NodeRefused(error ?? '机器上的这一步失败了'));
      return true;
    },

    leave(machineId: string): void {
      online.delete(machineId);
      releases.delete(machineId);
      serviceManagers.delete(machineId);
      // Nothing is thrown away: the host asks about state rather than resending, and a
      // command already in flight is the caller's to time out.
      log(`机器 ${machineId} 自己注销了`);
    },

    // §5.3: a client that speaks another protocol is refused, and that refusal is a fact
    // about the machine. Without it the Run on it would be read as "out of contact past the
    // grace period" and continued somewhere else, which is exactly the misjudgment the
    // version check exists to prevent.
    noteProtocol(machineId: string, version: number | null): void {
      const before = refused.get(machineId);
      refused.set(machineId, { version, at: now() });
      if (before === undefined) log(`机器 ${machineId} 的客户端协议版本是 ${version ?? '未知'}，主机是第 ${NODE_PROTOCOL} 版：已如实记下`);
    },

    // Whether this machine's client is refusing to speak to this host. A machine that comes
    // back with the right version clears it.
    refusesProtocol(machineId: string): boolean {
      return refused.has(machineId);
    },

    protocolRefusal(machineId: string): { version: number | null; at: string } | null {
      const held = refused.get(machineId);
      return held === undefined ? null : { version: held.version, at: iso(held.at) };
    },

    clearProtocol(machineId: string): void {
      refused.delete(machineId);
    },

    // --- the host's side ---------------------------------------------------------

    connected,

    lastSeen(machineId: string): string | null {
      const held = online.get(machineId);
      if (held) return iso(held.at);
      return ledger.getMachine(machineId)?.lastSeenAt ?? null;
    },

    // What the machine last said was alive on it, for the pages. Not evidence for a
    // judgment: that is asked for when it is needed.
    reportedRuns: (machineId: string): NodeRunSummary[] => online.get(machineId)?.runs ?? [],

    // What the machine last said about its own executors, for the pages and for a check that
    // cannot ask it now. Null is "it has not said", never "nothing is installed there".
    reportedExecutors: (machineId: string): NodeExecutorReport | null => online.get(machineId)?.executors ?? null,

    // What the machine last said it did with the global entry. Null: a client from before the
    // entry, or one that has not polled since this host started.
    reportedServiceManager(machineId: string): ServiceManagerReport | null {
      const held = serviceManagers.get(machineId);
      if (!held) return null;
      if (ledger.getMachine(machineId)?.uid !== held.uid) {
        serviceManagers.delete(machineId);
        return null;
      }
      return held.report;
    },
    reportedOutput: (machineId:string) => online.get(machineId)?.output ?? null,
    boundedOutput: (machineId:string) => online.get(machineId)?.boundedOutput === true,
    outputReady: (machineId:string) => { const held=online.get(machineId);return held?.boundedOutput===true && !!held.output && !held.output.capacity.issue && held.output.capacity.available_runs>0; },
    reportedEntry: (machineId: string): NodeEntryReport | null => online.get(machineId)?.entry ?? null,
    setEntryReport(machineId: string, value: NodeEntryReport): void {
      const held = online.get(machineId);
      if (!held) return;
      const report = asEntryReport(value);
      if (held.entry && Date.parse(held.entry.at) > Date.parse(report.at)) return;
      held.entry = report;
    },
    reportedSkills: (machineId: string): NodeSkillsReport | null => online.get(machineId)?.skills ?? null,

    // What the machine last said about the version it runs (§1.4): kept in memory, per
    // machine, and read by the machines page and list_machines. Null: a client too old to
    // report it, or one that has not asked since this host started.
    noteRelease(machineId: string, value: unknown): NodeReleaseHeld {
      const report = asReleaseReport(value);
      const held: NodeReleaseHeld = { ...report, at: iso(now()) };
      releases.set(machineId, held);
      return held;
    },

    reportedRelease: (machineId: string): NodeReleaseHeld | null => releases.get(machineId) ?? null,

    // Whether the client that is here now said it can drop a Task's code copy. False for a
    // client from before that command, and for a machine that is not here: its copies stay.
    reportedDropTaskCode: (machineId: string): boolean => online.get(machineId)?.dropsTaskCode === true,

    // Make this machine look at its own executors now and answer (nodes.md §1.2, §11 step 5).
    // The command carries nothing: the machine's own closed set decides what runs there. The
    // answer is kept where the pages read it, so the page and the check that asked for it
    // cannot come to different conclusions.
    async askExecutors(machineId: string, timeoutMs?: number): Promise<NodeExecutorReport> {
      const answer = await sendTo(machineId, { kind: 'probe' }, timeoutMs);
      let report: NodeExecutorReport;
      try {
        report = asExecutorReport(answer, (line) => log(`机器 ${machineId} ${line}`));
      } catch (err) {
        throw new NodeRefused(`机器 ${machineId} 回报的执行器状态读不出来：${(err as Error).message}`);
      }
      remember(machineId, report);
      return report;
    },

    send: sendTo,

    // Who hears what each poll says about the machine's sign-ins (service/sign-ins.ts).
    onSignIns(heard: (machineId: string, entries: NodeSignIn[]) => void): void {
      signInsHeard = heard;
    },

    // Who hears what each machine reports about its installed executors and model catalogs.
    onExecutors(heard: (machineId: string, report: NodeExecutorReport) => void): void {
      executorsHeard = heard;
    },

    // Ingest a fresh executor report received out-of-band (e.g. right after an executor CLI update).
    noteExecutors(machineId: string, rawReport: unknown): NodeExecutorReport | null {
      try {
        const report = asExecutorReport(rawReport, (line) => log(`机器 ${machineId} ${line}`));
        remember(machineId, report);
        return report;
      } catch {
        return null;
      }
    },

    // For the doctor and the pages: what the host knows without asking anyone.
    status(): { connected: string[]; queued: number; inFlight: number } {
      const connectedIds = [...online.keys()].filter(connected);
      return {
        connected: connectedIds,
        queued: [...queued.values()].reduce((total, list) => total + list.filter((each) => pending.has(each.id)).length, 0),
        inFlight: [...pending.keys()].length,
      };
    },
  };
}

export type Nodes = ReturnType<typeof createNodes>;
