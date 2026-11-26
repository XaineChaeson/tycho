// Which of the logins a Task may run as takes its next Run. The pattern is the one
// reverse proxies and LLM gateways use: an ordered list of fallbacks, a member that
// failed sits out for a while and is then let one request through to try, and among
// those that can take work the order is kept without letting the first one queue alone.
// Everything here is decided from facts handed in: nothing is read, nothing is asked.
import { ADAPTERS } from '../adapters/all.ts';
import { tierValueFrom } from '../shared/tiers.ts';
import type { Executors } from '../adapters/types.ts';
import { readOnlyRefusal } from './readonly.ts';
import type { Login, LoginStore } from '../runner/snapshot.ts';
import type { Wait } from '../shared/labels.ts';
import { parseReviewOf } from './review.ts';
import type { OutReason } from '../shared/review.ts';
import { parseKnowledgeTask } from './knowledge.ts';
import type { PlacedBy } from '../shared/tasks.ts';

export type { Wait } from '../shared/labels.ts';

// One login a Task may run as, as it stands at this moment.
export interface Candidate {
  id: string;
  // Runs on it that have not ended.
  active: number;
  // The owner's ceiling on those. Absent means none.
  maxRuns?: number;
  // Resting after a used-up quota until this moment, in milliseconds. Past or absent: not resting.
  restUntil?: number;
  // The largest share used, 0 to 1, among its quota windows that have not started over.
  usage?: number;
  // No machine of it answered when it was last asked.
  noMachine?: boolean;
  // Stays unavailable until the owner replaces or clears the credential.
  credentialRejected?: boolean;
  credentialMissing?: boolean;
  // Optional priority slot (1 = P1 primary load-balanced, 2 = P2 fallback).
  // When present on any candidate, pickLogin performs Least-Active -> Quota-Aware load balancing
  // within each slot and strict failover across slots.
  slot?: 1 | 2;
}

interface PickOptions {
  now: number;
  // How many more Runs a login may hold than any login after it before the next Task
  // goes to the one after. A very large number is strict order.
  lead: number;
  // A login whose usage has reached this share is used only when no other can be.
  warnAt: number;
}

const resting = (candidate: Candidate, now: number): boolean => candidate.restUntil !== undefined && candidate.restUntil > now;
const full = (candidate: Candidate): boolean => candidate.maxRuns !== undefined && candidate.active >= candidate.maxRuns;

// Whether a login could be given a Run at all right now.
export const usable = (candidate: Candidate, now: number): boolean => !candidate.credentialRejected && !candidate.credentialMissing && !resting(candidate, now) && !full(candidate) && !candidate.noMachine;

// `candidates` are in the order to try them in — the tier's global order, or a group of it
// (roles-and-tiers.md §11). The answer is the login to try, or what the Task is waiting for
// when none can be tried.
export function pickLogin(candidates: readonly Candidate[], { now, lead, warnAt }: PickOptions): { pick: string } | { wait: Wait } {
  const open = candidates.filter((candidate) => usable(candidate, now));
  if (open.length === 0) {
    const rejected = candidates.filter((candidate) => candidate.credentialRejected && !candidate.credentialMissing).map(({ id }) => id);
    const missing = candidates.filter((candidate) => candidate.credentialMissing).map(({ id }) => id);
    const available = candidates.filter((candidate) => !candidate.credentialRejected && !candidate.credentialMissing);
    const rests = available.filter((candidate) => resting(candidate, now)).sort((a, b) => a.restUntil! - b.restUntil!);
    const others = available.filter((candidate) => !resting(candidate, now));
    return {
      wait: {
        rest: rests[0] ? { login: rests[0].id, until: new Date(rests[0].restUntil!).toISOString() } : null,
        full: others.filter(full).map(({ id }) => id),
        no_machine: others.filter((candidate) => !full(candidate)).map(({ id }) => id),
        ...(rejected.length ? { rejected } : {}),
        ...(missing.length ? { missing_credentials: missing } : {}),
      },
    };
  }
  // Priority-slot mode: Least-Active -> Quota-Aware load balancing within each slot,
  // strict failover from P1 to P2 when P1 has no fresh (or usable) candidates.
  if (candidates.some((candidate) => candidate.slot !== undefined)) {
    const pickBest = (pool: readonly Candidate[]): Candidate => {
      let best = pool[0]!;
      for (const each of pool.slice(1)) {
        if (each.active < best.active) {
          best = each;
          continue;
        }
        if (each.active === best.active) {
          const eachUsage = each.usage ?? 0;
          const bestUsage = best.usage ?? 0;
          if (eachUsage < bestUsage) best = each;
        }
      }
      return best;
    };
    const isFresh = (candidate: Candidate): boolean => !(candidate.usage !== undefined && candidate.usage >= warnAt);
    for (const targetSlot of [1, 2, undefined] as const) {
      const inSlot = open.filter((candidate) => candidate.slot === targetSlot && isFresh(candidate));
      if (inSlot.length > 0) return { pick: pickBest(inSlot).id };
    }
    for (const targetSlot of [1, 2, undefined] as const) {
      const inSlot = open.filter((candidate) => candidate.slot === targetSlot);
      if (inSlot.length > 0) return { pick: pickBest(inSlot).id };
    }
  }
  // Legacy linear order:
  // A login close to using its quota up would likely lose the Run halfway: it is kept
  // for when nothing else can take the Task.
  const fresh = open.filter((candidate) => !(candidate.usage !== undefined && candidate.usage >= warnAt));
  const group = fresh.length > 0 ? fresh : open;
  // The first login that would not, with this Run, hold more than `lead` Runs above any
  // login after it. The last one always qualifies.
  const pick = group.find((candidate, index) => group.slice(index + 1).every((later) => candidate.active - later.active < lead))!;
  return { pick: pick.id };
}

// A login takes the Task's tier when it holds content for it — or, for an operate round, when
// it holds the execute content that stands in (shared/tiers.ts, roles-and-tiers.md §10.3).
const hasTier = (login: Login, tier: string | null): boolean =>
  tier !== null && tierValueFrom(login.tiers, tier) !== undefined;

// A Task that names no login and has no tier (no role yet) has nowhere its next Run
// could go: that is the owner's to settle, not a wait for capacity.
export const needsRoleToPlace = (task: { login_id: string | null; tier: string | null }): boolean =>
  task.login_id === null && task.tier === null;

// The logins a Task may run as, in order of preference. A Task that names a login is pinned
// to it and waits for it. One that names none takes whichever of its project's logins has
// its tier: `allowed` says which may be used, and `order` — the tier's global order
// (roles-and-tiers.md §11) — says which comes first; the project's own list no longer has an
// order of its own. A login that is not in the store any more is not a candidate. Each
// candidate is an account, which can go to any machine the project allows, or a machine's own
// login, which can go only to its machine; the machine is chosen afterwards
// (service/dispatcher.ts).
// A review Task is not run by an executor that wrote what it reviews (roles-and-tiers.md
// §4 ②) — unless none other can take it, which sameExecutorReviewers below answers — and a
// read-only Task never by one with no read-only way (§5): a login of either is not a
// candidate here, pinned or not. Which machine can run that way is the machines' own
// report, asked where a machine is chosen (service/readonly.ts).
export function candidateLogins(
  task: { login_id: string | null; tier: string | null; review_of_json?: string | null; knowledge_json?: string | null; permission?: string | null },
  allowed: readonly string[],
  logins: LoginStore,
  executors: Executors = ADAPTERS,
  order: readonly string[] = allowed,
): Login[] {
  const writers = excludedExecutors(task);
  const readOnly = task.permission === 'read';
  const reviewer = (login: Login): boolean =>
    !writers.includes(login.executor) && (!readOnly || readOnlyRefusal(login, executors) === undefined);
  // Whether a pin may stand at all is the ledger's loginRefusal, asked before this.
  if (task.login_id !== null) {
    const pinned = logins.get(task.login_id);
    return pinned && reviewer(pinned) ? [pinned] : [];
  }
  // The global order may name logins the pool does not allow: it only decides the order, so
  // the pool still bounds the answer. A login the order does not name is not a candidate.
  const permitted = new Set(allowed);
  return order.flatMap((id) => {
    if (!permitted.has(id)) return [];
    const login = logins.get(id);
    return login && hasTier(login, task.tier) && reviewer(login) ? [login] : [];
  });
}

// The groups a Task's next Run is tried in, in order (roles-and-tiers.md §11.3): the
// Router's preference first, then the reviewers that have not seen this product, then every
// candidate in the tier's order. Empty groups are left out; a pinned Task has one group,
// its login, because the pin is the choice. A spread group exists only once another review
// of the same product has made a Run (`reviewed`, service/ledger.ts spreadExecutorsOf): with
// nobody to spread from, the first review is placed by the tier's order.
export interface PlacementGroup {
  logins: Login[];
  placedBy: PlacedBy;
}

export function placementGroups(
  task: { login_id: string | null; prefer_json?: string | null; review_of_json?: string | null },
  candidates: readonly Login[],
  reviewed: readonly string[] = [],
): PlacementGroup[] {
  if (task.login_id !== null) {
    return [{ logins: candidates.filter((login) => login.id === task.login_id), placedBy: 'pinned' }];
  }
  const spread = task.review_of_json == null || reviewed.length === 0
    ? []
    : candidates.filter((login) => !reviewed.includes(login.executor));
  return [
    { logins: spread, placedBy: 'spread' as const },
    { logins: [...candidates], placedBy: 'order' as const },
  ].filter((group) => group.logins.length > 0);
}

// The logins a review or knowledge gate may fall back to once no login of another executor
// can take it: those of the executors that wrote its product/proposal, each in a fresh
// independent session (roles-and-tiers.md §4 ②). Never for a task pinned to a login.
export function sameExecutorReviewers(
  task: { login_id: string | null; tier: string | null; review_of_json?: string | null; knowledge_json?: string | null; permission?: string | null },
  allowed: readonly string[],
  logins: LoginStore,
  executors: Executors = ADAPTERS,
  order: readonly string[] = allowed,
): Login[] {
  const writers = excludedExecutors(task);
  if (writers.length === 0 || task.login_id !== null) return [];
  return candidateLogins({ ...task, review_of_json: null, knowledge_json: null }, allowed, logins, executors, order).filter((login) => writers.includes(login.executor));
}

// Why a login of another executor cannot review now, when the reason does not end with a Run
// of its own ending: signed out, resting, or no machine that answers. Undefined when it can
// take the review, or is only busy — then the review waits for it.
export function outReason(candidate: Candidate, now: number): OutReason | undefined {
  if (candidate.credentialMissing) return 'missing_credential';
  if (candidate.credentialRejected) return 'rejected';
  if (resting(candidate, now)) return 'resting';
  if (candidate.noMachine) return 'no_machine';
  return undefined;
}

// The executors a Task may not run on: for a review, those that wrote its product; for a
// knowledge gate, the one that wrote the proposal (docs/design/knowledge-and-skills.md §3). The
// one judgment the pick, a pin and createRun share: nobody checks what they wrote themselves —
// except a review no other executor can take, which falls back (sameExecutorReviewers).
export const excludedExecutors = (task: { review_of_json?: string | null; knowledge_json?: string | null }): string[] => {
  const job = parseKnowledgeTask(task.knowledge_json);
  return [...(parseReviewOf(task.review_of_json ?? null)?.writers ?? []), ...(job?.kind === 'gate' ? job.writers : [])];
};
