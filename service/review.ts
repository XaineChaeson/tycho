// What the service decides about review (docs/design/roles-and-tiers.md §4, §6), from facts
// handed in: whether a receipt carries its role's deliverable, which verdict it hands over,
// which executors wrote a product, and whether a binding still speaks for the product a
// Task holds now. The ledger asks these in the transactions that act on them.
import { deliverableLabel, type DeliverableId } from '../shared/roles.ts';
import type { NodeSourceHead } from '../shared/node-protocol.ts';
import { isVerdictId, type BoundFile, type ReviewOf, type Verdict, type Violation } from '../shared/review.ts';
import { bindingKey, type Delivery, type ReviewedCommit, type SnapshotSource, type Source } from '../shared/sources.ts';

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

// The verdict a receipt hands over, or why it is not one. Only verdict.result is required;
// summary defaults from receipt.summary (or empty string), and violations/missing subfields
// are optional so a review round is never rejected for minor formatting omissions.
export function verdictOf(receipt: unknown): Verdict | string {
  const raw = (receipt as { verdict?: unknown } | null)?.verdict as Record<string, unknown> | undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return '回执里没有 verdict';
  if (!isVerdictId(raw.result)) return 'verdict.result 只能是 pass、reject、cannot 之一';
  const summary = filled(raw.summary)
    ? raw.summary.trim()
    : filled((receipt as { summary?: unknown } | null)?.summary)
      ? String((receipt as { summary: string }).summary).trim()
      : '';
  if (raw.result === 'pass') return { result: 'pass', summary };
  if (raw.result === 'cannot') {
    return {
      result: 'cannot',
      summary,
      ...(filled(raw.missing) ? { missing: raw.missing.trim() } : {}),
    };
  }
  const rawViolations = Array.isArray(raw.violations) ? raw.violations : [];
  const violations: Violation[] = [];
  for (const each of rawViolations) {
    if (typeof each === 'string') {
      const text = each.trim();
      if (text !== '') violations.push({ requirement: text, evidence: '', scope: '' });
      continue;
    }
    if (each === null || typeof each !== 'object' || Array.isArray(each)) continue;
    const item = each as Record<string, unknown>;
    const requirement = filled(item.requirement) ? item.requirement.trim() : '';
    const evidence = filled(item.evidence) ? item.evidence.trim() : '';
    const scope = filled(item.scope) ? item.scope.trim() : '';
    if (requirement !== '' || evidence !== '' || scope !== '') {
      violations.push({ requirement, evidence, scope });
    }
  }
  return { result: 'reject', summary, ...(violations.length > 0 ? { violations } : {}) };
}

// Only verdict deliverables are checked at settlement; commit/report deliverables are never
// hard-rejected so a completed status:"done" run is never demoted to held for missing artifact tags.
export function deliveryProblem(deliverable: DeliverableId, receipt: unknown): string | null {
  if (deliverable === 'verdict') {
    const verdict = verdictOf(receipt);
    return typeof verdict === 'string' ? `${deliverableLabel(deliverable)}：${verdict}` : null;
  }
  return null;
}

export interface DeliveryDetail extends Delivery {
  branches?: string[];
  commits?: string[];
  prs?: string[];
}

// What a round's receipt says it delivered: accepts multiple commits, branches, or PRs without
// throwing, exposing the last/primary ref on branch/commit/pr alongside full arrays when present.
export function deliveryOf(receipt: unknown): DeliveryDetail {
  const artifacts = (receipt as { artifacts?: unknown } | null)?.artifacts;
  const delivery: DeliveryDetail = {};
  if (!Array.isArray(artifacts)) return delivery;
  const branches: string[] = [];
  const commits: string[] = [];
  const prs: string[] = [];
  for (const each of artifacts as { kind?: unknown; ref?: unknown }[]) {
    const kind = each?.kind;
    if (!filled(each?.ref)) continue;
    const ref = each.ref.trim();
    if (kind === 'branch') {
      branches.push(ref);
      delivery.branch = ref;
    } else if (kind === 'commit') {
      commits.push(ref);
      delivery.commit = ref;
    } else if (kind === 'pr') {
      prs.push(ref);
      delivery.pr = ref;
    }
  }
  if (branches.length > 0) delivery.branches = branches;
  if (commits.length > 0) delivery.commits = commits;
  if (prs.length > 0) delivery.prs = prs;
  return delivery;
}

// A round as it bears on who wrote a product: whether it is known to have started, what it
// was judged as when it ended, and what its snapshot says it ran as.
interface WrittenRound {
  started_at: string | null;
  exit_kind: string | null;
  error_json: string | null;
  snapshot_json: string;
}

// A round no machine took, or one whose machine confirmed its Worker never ran: judged so,
// with nothing of it ever having run. The ledger asks this too, to know which of a Task's rounds
// was the first that really began its work (§8 第 6 条).
export function neverRan(round: WrittenRound): boolean {
  if (round.started_at !== null) return false;
  const error = JSON.parse(round.error_json ?? '{}') as { lost?: { basis?: string }; worker_not_started?: unknown };
  return (round.exit_kind === 'lost' && error.lost?.basis === 'not_started') || typeof error.worker_not_started === 'string';
}

// The executors of every round that may have written: every round whose start went out,
// unless it was judged never to have started. A start whose answer was lost is not a start
// that did not happen. A round from before roles recorded no permission, so it is counted
// as one that could write: excluding too many reviewers only makes the owner decide;
// excluding too few lets an author review itself.
export function writersOf(rounds: readonly WrittenRound[]): string[] {
  const found = new Set<string>();
  for (const round of rounds) {
    if (neverRan(round)) continue;
    const snapshot = JSON.parse(round.snapshot_json) as { role?: { permission?: unknown } };
    if (snapshot.role?.permission === 'read') continue;
    const executor = executorOf(round.snapshot_json);
    if (executor !== undefined) found.add(executor);
  }
  return [...found].sort();
}

// The executor a round ran on, as its snapshot recorded it.
export function executorOf(snapshotJson: string): string | undefined {
  const snapshot = JSON.parse(snapshotJson) as { executor?: unknown; login?: { executor?: unknown } };
  const executor = typeof snapshot.executor === 'string' ? snapshot.executor : snapshot.login?.executor;
  return typeof executor === 'string' ? executor : undefined;
}

const fileKey = ({ name, sha256, bytes }: BoundFile): string => `${name}\u0000${sha256}\u0000${bytes}`;
export const sameFiles = (a: readonly BoundFile[], b: readonly BoundFile[]): boolean =>
  JSON.stringify(a.map(fileKey).sort()) === JSON.stringify(b.map(fileKey).sort());

// The product a Task holds now: its latest round, its revision, and the whole set of files
// the host registered for that round — null while none is registered, which is not the
// same as an empty set. Whether that round's role asks for review is read from the round
// itself: what a Task becomes later does not change what its product needed.
// One whole taking-over of a round's artifacts, as the ledger registers it: the files, when
// it was registered, and an id that tells this taking from any later one of the same round.
// The id also names the directory the files are in (releases/<run>/<id>/, service/releases.ts);
// with no files there is no directory. The code itself is not among them any more: a round's
// commit is reported in its receipt and checked where it lives (shared/sources.ts
// ReviewedCommit), not carried back as a bundle.
export interface Registration {
  id: string;
  at: string;
  files: BoundFile[];
}

// What the ledger holds of one round's artifacts (`run.artifacts_json`): the registration
// of its last whole taking, the ids of every registration the round has had (the current
// one among them), and why the last taking since then failed, if one did. A registered
// directory is never removed for being replaced: review bindings and release records still
// name it, and an upgrade command may be reading it right now.
export interface RoundArtifacts {
  registration: Registration | null;
  registered: string[];
  problem: { at: string; problem: string } | null;
}

export interface HeldArtifacts extends RoundArtifacts {
  run_id: string;
  task_id: string;
  // When the retention rule cleared this round's registered copies on the host (its work
  // ended and the setting's days passed); null while they stand (docs/design/phase1-design.md
  // "已结束的工作"). A cleared round still lists what it registered; nothing is on disk.
  releases_dropped_at: string | null;
}

export interface Product {
  runId: string | null;
  revision: number;
  files: BoundFile[] | null;
  needsReview: boolean;
  report?: ReviewOf['report'] | null;
  // The code this product is: the source that round itself ran on (its snapshot's `source`) and
  // the commit it handed over, as the round's own facts say it (roundCode). The round's own
  // source, never the Task's current one: a Task re-pinned since then holds a round whose commit
  // and remote head belong to the old place, and reading them as the new one's would bind a
  // review to code that place never saw (docs/design/code-sources.md §8 第 4、5 条). Null when
  // that round names no source, or none of it can be told.
  reviewed: ReviewedCommit | null;
  // The source the Task is pinned to now, in the same shape and without a commit. A pass speaks
  // for the product only while the Task still names the place the review looked at: a Task
  // re-pinned afterwards is not the one that was reviewed. Null when the Task names none.
  pinned: CodeSource | null;
}

// Where a piece of code is, without the commit: the source and the place it is, which two
// readings of the same code must agree on. A ReviewedCommit is one of these with a commit.
export interface CodeSource {
  source_kind: 'repo' | 'folder';
  url?: string;
  path?: string;
}

// One identity, compared as one whole: two pieces of code are the same only when the source
// they came from and the commit are the same. The folder's path is part of it, because two
// folders on the same machine are two places, and a Task moved from one to the other was not
// reviewed in the new one.
const codeKey = (code: ReviewedCommit | null | undefined): string => code === null || code === undefined
  ? ''
  : JSON.stringify([code.source_kind, code.commit, code.branch ?? null, code.url ?? null, code.path ?? null]);
// The source half of that identity, for when the commit is not in question: which place the code
// is in.
export const codeSourceKey = (source: CodeSource | null | undefined): string => source === null || source === undefined
  ? ''
  : JSON.stringify([source.source_kind, source.url ?? null, source.path ?? null]);

// The one comparison of a binding with the product a Task holds now: acceptance, the
// release entry and a review's settlement all ask this. Null when the binding still speaks
// for it; otherwise why not.
export function productStale(binding: ReviewOf, product: Product): string | null {
  if (product.revision !== binding.revision) return `验收标准已改过（现在是修订 ${product.revision}，审的是修订 ${binding.revision}）`;
  if (product.runId !== binding.run_id) return '任务在审阅之后又跑过一轮，产物已经不是审的那一份';
  if (binding.report) {
    if (!product.report || JSON.stringify([binding.report.id, binding.report.sha256, binding.report.bytes, binding.report.complete]) !== JSON.stringify([product.report.id, product.report.sha256, product.report.bytes, product.report.complete])) return '正式报告和审阅时绑定的不是同一份完整正文';
  } else if (codeKey(product.reviewed) !== codeKey(binding.reviewed)
    || (binding.reviewed !== undefined && codeSourceKey(binding.reviewed) !== codeSourceKey(product.pinned))) {
    return '任务的代码来源或提交和审阅时绑定的不一样，审的那一份已经不是现在的产物';
  }
  if (product.files === null) return '这一轮的产物还没有登记到主机上，说不清是不是审的那一份';
  if (!sameFiles(product.files, binding.files)) return '这一轮的产物文件和审阅时登记的不一样';
  return null;
}

// Where a round's code stood, as the settlement kept it in the Run's error_json beside its code
// check (NodeSourceHead, written by the machine's watch). Null when the machine reported none:
// a client that does not read these, or a round nothing ran in.
export function sourceHeadOf(run: { error_json: string | null }): NodeSourceHead | null {
  const held = (JSON.parse(run.error_json ?? '{}') as { source_head?: NodeSourceHead }).source_head;
  if (held === null || held === undefined || typeof held !== 'object') return null;
  return held;
}

// Where a round's code came from, as that round's own snapshot recorded it (Snapshot.source,
// written when the round was prepared). Every code fact a round reports — the commit in its
// receipt, the HEAD and remote head its machine read — belongs to this source and no other. Null
// when the snapshot names none, or names one this program never wrote: a round from before code
// sources, or one whose snapshot was damaged, has no source its evidence could be attributed to.
export function roundSourceOf(run: { snapshot_json: string }): SnapshotSource | null {
  let held: { source?: unknown } | null;
  try {
    held = JSON.parse(run.snapshot_json) as { source?: unknown } | null;
  } catch {
    return null;
  }
  const source = held?.source as { kind?: unknown; url?: unknown; path?: unknown; binding_key?: unknown; branch?: unknown; commit?: unknown } | null | undefined;
  if (source === null || source === undefined || typeof source !== 'object') return null;
  const binding = typeof source.binding_key === 'string' && source.binding_key !== '' ? source.binding_key : null;
  if (source.kind === 'repo' && typeof source.url === 'string' && source.url !== '' && binding !== null) {
    return {
      kind: 'repo',
      url: source.url,
      binding_key: binding,
      ...(typeof source.branch === 'string' && source.branch !== '' ? { branch: source.branch } : {}),
      ...(typeof source.commit === 'string' && source.commit !== '' ? { commit: source.commit } : {}),
    };
  }
  if (source.kind === 'folder' && typeof source.path === 'string' && source.path !== '' && binding !== null) {
    return { kind: 'folder', path: source.path, binding_key: binding };
  }
  return null;
}

// Whether a round ran on the very source a Task is pinned to now: the binding identity
// (shared/sources.ts bindingKey) the round's snapshot carried and the one the pin names, which is
// the id plus what the source held when the Task was pinned. A Task repinned to another
// repository or folder — or to the same id re-pointed elsewhere — holds rounds whose code facts
// are about the old place. This is the one comparison; nothing here reads an id or an address by
// itself.
export function sourceAgrees(round: SnapshotSource, pinned: Source): boolean {
  return round.binding_key === bindingKey(pinned);
}

// The code a round handed over, as that round's own facts say it — what its receipt reported and
// where the machine read the code to stand — in the one shape the review binding, the product
// identity and the landing use (shared/sources.ts ReviewedCommit). `source` is the round's own
// (roundSourceOf), never the Task's current pin: this is what the product *is*, and it must not
// change when the Task is re-pinned. Null when the round names no source, and when its facts do
// not name one commit at all; a repository needs the branch and commit its receipt reported, a
// folder needs the HEAD its machine read (§8 第 4 条). Whether those facts agree with each other
// is the binding's question (service/accept.ts), not this one.
export function roundCode(
  run: { receipt_json: string | null; error_json: string | null },
  source: SnapshotSource | null,
): ReviewedCommit | null {
  if (source === null) return null;
  let receipt: unknown = null;
  try {
    receipt = run.receipt_json === null ? null : JSON.parse(run.receipt_json);
  } catch {
    receipt = null;
  }
  const delivery = deliveryOf(receipt);
  const head = sourceHeadOf(run);
  if (source.kind === 'repo') {
    const factCommit = head?.kind === 'repo' && head.remote_head ? head.remote_head : undefined;
    const factBranch = head?.kind === 'repo' ? head.branch : undefined;
    const commit = delivery.commit ?? factCommit;
    const branch = delivery.branch ?? factBranch ?? source.branch;
    if (commit === undefined) return null;
    return {
      source_kind: 'repo',
      commit,
      ...(branch === undefined ? {} : { branch }),
      url: source.url,
    };
  }
  const factCommit = head?.kind === 'folder' && head.head ? head.head : undefined;
  const factBranch = head?.kind === 'folder' ? head.branch : undefined;
  const commit = factCommit ?? delivery.commit;
  const branch = factBranch ?? delivery.branch;
  if (commit === undefined) return null;
  return {
    source_kind: 'folder',
    commit,
    path: source.path,
    ...(branch === undefined ? {} : { branch }),
  };
}

export const parseReviewOf = (text: string | null): ReviewOf | null => (text === null ? null : (JSON.parse(text) as ReviewOf));
