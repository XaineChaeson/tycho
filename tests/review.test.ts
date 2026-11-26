// Guards review in the ledger (docs/design/roles-and-tiers.md §4, §6). Against: a binding
// the Router writes rather than one the service generates from the reviewed round; a
// verdict on an old product, or on old criteria, still letting the Task be accepted; a
// reviewer whose executor wrote the product — by the pick, by a pinned account, by a
// later pin, or by a role change — and the Router relaxing that; a receipt whose verdict
// is not one of the three, or a round of any role whose deliverable is missing, reaching
// 待验收; "审不了" counted as a rejection; acceptance of a Task that needs review going
// through without a current pass for the Router, or the owner's way past it leaving no
// line on the timeline; and the escalation: a rejection on the execute tier not sending the
// Task back on the decide tier with the opinion as its next input, a rejection on the decide
// tier not stopping for the owner, a second settlement or a stale review sending it back
// twice, a quota, a lost round or "审不了" escalating, and the Router overriding an escalated
// Task back to the execute tier.
// And against the review's effects and its settlement being separate commits: a crash
// before the settlement commits leaves neither, one after leaves both.
// And the review's own tier (§11.5): a review not running on the tier of the round it
// reviews, an override not winning over it, a binding from before the rule losing the role's
// default, or the review after an escalation not running on the escalate tier.
// And against what the first review found: the Router changing a ready Task's role to one
// without review and so accepting or releasing it unreviewed; a round whose start was never
// answered left out of the writers; a binding pairing one round's files with a round that
// came in meanwhile; an unregistered product treated like one with no files; acceptance,
// the release entry and a review's settlement disagreeing about which product is current;
// a rejection on the decide tier left to a plain hold the Router can resume; an escalated
// round's snapshot without its reason; and a branch passing for a commit. And the Router
// moving the tier of a Task waiting on that question by changing its role, or the question
// being known by anything but itself. And a receipt that names two commits read as one product,
// and a Task's start taken from a later round when the first that worked reported none.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account } from '../runner/snapshot.ts';
import {
  DECIDE_REJECTION_OPTIONS, NEEDS_PASS_TEXT, REVIEW_IN_PROGRESS_TEXT, reviewHeldGateText,
  RELEASE_NEEDS_PASS_TEXT, type ReviewOf, type VerdictRecord,
} from '../shared/review.ts';
import type { NodeSourceHead } from '../shared/node-protocol.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import { candidateLogins } from '../service/pick.ts';
import { claudeTier, codexTier, content, fixture, type Fixture, LOGIN, RUN_LIMIT_MS, USER } from './helpers.ts';

const ROUTER = { actor: 'router' };
const CONSOLE = { actor: 'console' };
// Content of the model alone: a Codex reviewer's read-only round takes no profile (§5).
const CODEX: Account = { id: 't2', name: 't2', executor: 'codex', tiers: { decide: content('model=x\n'), execute: content('model=y\n') } };
const FILES = [{ name: 'work.bundle', sha256: 'a'.repeat(64), bytes: 10 }, { name: 'tycho-1.2.3.tar.gz', sha256: 'b'.repeat(64), bytes: 20 }];
const WROTE = { status: 'done', summary: '改好了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }] };
const NO_CODE = { result: 'no-code' } as const;
const PASS = { status: 'done', summary: '看过了', verdict: { result: 'pass', summary: '没有挡住验收的问题' } };
const REJECT = {
  status: 'done', summary: '不行',
  verdict: { result: 'reject', summary: '漏了一条', violations: [{ requirement: '测试通过', evidence: 'npm test 两条失败', scope: 'service/a.ts' }] },
};
const CANNOT = { status: 'done', summary: '缺东西', verdict: { result: 'cannot', summary: '材料不够', missing: '没有测试记录' } };

const account = (f: Fixture, id: string) => f.ledger.getAccount(id)!;

// One account per executor: the author's (claude, from the fixture, which has the execute
// tier and gets decide here too) and another (codex) with both tiers.
function setUp(f: Fixture): void {
  // Model-only content: some rounds here are read-only, which take no file of the machine (§5).
  f.ledger.putAccount({ id: 't1', name: 't1', executor: 'claude', tiers: { execute: content('{"model":"m"}'), decide: content('{"model":"m"}') } }, USER, 'ref-t1');
  f.ledger.putAccount(CODEX, USER, 'ref-t2');
}

// The code source every Task in this file is pinned to (shared/sources.ts TaskSource, A's
// ledger), and what its round's machine read of the code when the round was over
// (NodeSourceHead, docs/design/code-sources.md §8 第 4、6 条): a folder on a machine, standing on
// the commit the round reported. The binding and the product identity are made from these, so a
// Task here is a Task whose code was read where it lives. The machine is the fixture's own: a
// folder source names the machine it lives on, and createRun checks the round goes to it.
const sourceOf = (f: Fixture) => ({ id: 's1', kind: 'folder' as const, machine_uid: f.ledger.getMachine('h1')!.uid, path: '/work/repo' });
const START = 'b0a1'.repeat(10);
const FOLDER_HEAD: NodeSourceHead = { kind: 'folder', head: 'c0ffee', start: START };

const sourced = (f: Fixture, taskId: string): void => {
  const pinned = sourceOf(f);
  // The project holds it too: a pin the project's list no longer names stops the Task, and
  // createRun checks that in its own transaction (service/ledger.ts sourceRefusalOf).
  f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([pinned]), f.projectId);
  f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: pinned.id, pinned }), taskId);
};

// A round of a Task on an account, settled with this receipt. The source is written into the
// round's own snapshot (Snapshot.source, service/review.ts roundSourceOf): the code facts a round
// reports belong to the source it ran on, and this file pins the Task to the same one.
function round(f: Fixture, taskId: string, loginId: string, receipt: unknown, tier?: string): string {
  const task = f.task(taskId);
  sourced(f, taskId);
  const run = f.ledger.createRun(taskId, {
    login: account(f, loginId), machine: f.ledger.getMachine('h1')!,
    snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: account(f, loginId).executor, tier: tier ?? task.tier!, tier_value: claudeTier('/x'), source: snapshotSourceOf(sourceOf(f)) }, expectedRevision: task.revision,
  }, USER);
  f.ledger.markRunRunning(run.id);
  // What a read-only round's machine reports of a round handed no code (node/code-check.ts), and
  // where this round's code stood (node/source-head.ts).
  f.ledger.settleRun(run.id, 0, receipt as never, { codeCheck: NO_CODE, sourceHead: FOLDER_HEAD });
  return run.id;
}

// An implementation that has been done once, by claude, and waits to be accepted.
function implemented(f: Fixture): { taskId: string; runId: string } {
  setUp(f);
  const task = f.newTask();
  f.ledger.queueTask(task.id, USER);
  const runId = round(f, task.id, 't1', WROTE);
  assert.equal(f.task(task.id).state, 'ready');
  return { taskId: task.id, runId };
}

// What the service does before a review is bound: the reviewed round's files taken over
// and registered, with the round and revision fixed when the taking began, and the commit
// the round reported, checked where it lives before this call.
function registered(f: Fixture, taskId: string, files = FILES, reviewed: { source_kind: 'folder'; commit: string; path: string } | null = { source_kind: 'folder', commit: 'c0ffee', path: '/work/repo' }) {
  const runId = f.ledger.listRuns(taskId).at(-1)!.id;
  const revision = f.task(taskId).revision;
  return { taskId, runId, revision, registration: f.ledger.registerArtifacts(runId, files), ...(reviewed === null ? {} : { reviewed }) };
}

function reviewFor(f: Fixture, taskId: string, files = FILES): string {
  const review = f.ledger.createTask({
    projectId: f.projectId, title: '审一下', goal: '审', acceptance: '给结论', roleId: 'review', reviewOf: registered(f, taskId, files),
  }, ROUTER);
  f.ledger.queueTask(review.id, ROUTER);
  return review.id;
}

const bindingOf = (f: Fixture, id: string): ReviewOf => JSON.parse(f.task(id).review_of_json!) as ReviewOf;
const verdictOf = (f: Fixture, id: string): VerdictRecord => JSON.parse(f.task(id).verdict_json!) as VerdictRecord;
const changes = (f: Fixture, action: string) =>
  f.peek<{ task_id: string; detail_json: string }>('SELECT task_id, detail_json FROM change WHERE action = ? ORDER BY seq', action)
    .map(({ task_id, detail_json }) => ({ task_id, ...JSON.parse(detail_json) }));

test('the binding is generated from the reviewed round, and the Router only names the Task', (t) => {
  const f = fixture(t);
  const { taskId, runId } = implemented(f);
  const reviewId = reviewFor(f, taskId);
  const binding = bindingOf(f, reviewId);
  const task = f.task(taskId);
  assert.deepEqual(
    [binding.task_id, binding.run_id, binding.revision, binding.acceptance, binding.goal, binding.reviewed, binding.files, binding.writers],
    [taskId, runId, task.revision, task.acceptance, task.goal, { source_kind: 'folder', commit: 'c0ffee', path: '/work/repo' }, FILES, ['claude']],
  );
  // Only a Task with an ended round in ready/done/held has a product to review; only the review role binds.
  const other = f.newTask();
  assert.throws(() => f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'review', reviewOf: { taskId: other.id } }, ROUTER), /没有已结束的轮次/);
  // Standalone review task without reviewOf is allowed.
  const standalone = f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'review' }, ROUTER);
  assert.equal(standalone.review_of_json, null);
  assert.throws(() => f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'analyse', reviewOf: { taskId } }, ROUTER), /只有审阅职能/);
  // Nor without naming the round the files were taken over for.
  assert.throws(() => f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'review', reviewOf: { taskId } }, ROUTER), /又跑了一轮或改了修订/);
  // A Task with no code source is bound to its files alone: there is no commit to check out.
  const declared = f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'review', reviewOf: registered(f, taskId, [], null) }, ROUTER);
  assert.deepEqual([bindingOf(f, declared.id).reviewed, bindingOf(f, declared.id).files], [undefined, []]);
  // Minimal repo commit metadata without optional branch/url is accepted best-effort.
  const minimalRepo = f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'review', reviewOf: registered(f, taskId, FILES, { source_kind: 'repo', commit: 'c0ffee' } as never) }, ROUTER);
  assert.deepEqual(bindingOf(f, minimalRepo.id).reviewed, { source_kind: 'repo', commit: 'c0ffee' });
  // The role of a bound review cannot be changed away; changing an ordinary task to standalone review is allowed.
  assert.throws(() => f.ledger.updateTask(reviewId, { roleId: 'analyse' }, ROUTER), /审阅任务的职能不能改/);
  assert.equal(f.ledger.updateTask(other.id, { roleId: 'review' }, ROUTER).role_id, 'review');
});

test('a review runs on the tier of the round it reviews, and its own override still wins', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  const reviewId = reviewFor(f, taskId);
  // The implementation ran on the execute tier: its review does too, and says where it came from.
  assert.deepEqual([bindingOf(f, reviewId).tier, f.task(reviewId).tier, f.task(reviewId).tier_source], ['execute', 'execute', 'reviewed']);
  // Its role's default is still the decide tier: the binding is what moved this review down.
  assert.equal(f.ledger.getRole('review')!.default_tier, 'decide');
  // An override on the review itself wins over the reviewed round's tier.
  f.ledger.updateTask(reviewId, { tierOverride: { tier: 'decide', reason: '改到认证，要更仔细地看' } }, ROUTER);
  assert.deepEqual(
    [f.task(reviewId).tier, f.task(reviewId).tier_source, f.task(reviewId).tier_reason],
    ['decide', 'override', '改到认证，要更仔细地看'],
  );
});

test('a decide-tier product is reviewed on decide, and a binding from before the rule keeps the role default', (t) => {
  const f = fixture(t);
  setUp(f);
  const task = f.newTask({ tierOverride: { tier: 'decide', reason: '改账本迁移' } });
  f.ledger.queueTask(task.id, USER);
  round(f, task.id, 't1', WROTE);
  const reviewId = reviewFor(f, task.id);
  assert.deepEqual([bindingOf(f, reviewId).tier, f.task(reviewId).tier, f.task(reviewId).tier_source], ['decide', 'decide', 'reviewed']);
  // A binding made before this rule carries no tier, whatever its product ran on: the review
  // role's own default, as an old review stays.
  const before = reviewFor(f, implemented(f).taskId);
  f.force(`UPDATE task SET review_of_json = json_remove(review_of_json, '$.tier') WHERE id = ?`, before);
  assert.deepEqual([bindingOf(f, before).tier, f.task(before).tier, f.task(before).tier_source], [undefined, 'decide', 'default']);
});

test('after explicit rework on decide tier, the review of the reworked product is on decide', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  round(f, reviewFor(f, taskId), 't2', REJECT);
  assert.equal(f.task(taskId).state, 'ready');
  f.ledger.updateTask(taskId, { tierOverride: { tier: 'decide', reason: '按审阅意见升档修改' } }, ROUTER);
  f.ledger.reworkTask(taskId, '按审阅意见修改', f.task(taskId).revision, ROUTER);
  const next = round(f, taskId, 't1', WROTE);
  assert.equal((JSON.parse(f.run(next).snapshot_json) as { tier: string }).tier, 'decide', '重做在决策档');
  const reviewId = reviewFor(f, taskId);
  assert.deepEqual([bindingOf(f, reviewId).tier, f.task(reviewId).tier, f.task(reviewId).tier_source], ['decide', 'decide', 'reviewed']);
});

test('cross-executor review is a soft dispatcher preference while explicit pinning is permitted', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  const reviewId = reviewFor(f, taskId);
  const review = f.task(reviewId);
  // candidateLogins still prefers executors that did not write the product.
  const accounts = { get: (id: string) => f.ledger.getAccount(id), list: () => f.ledger.listAccounts() };
  assert.deepEqual(candidateLogins(review, ['t1', 't2'], accounts).map(({ id }) => id), ['t2']);
  // Explicit pinning and running on t1 are allowed without hard throws.
  f.ledger.updateTask(reviewId, { loginId: 't1' }, ROUTER);
  assert.equal(f.task(reviewId).login_id, 't1');
  const explicit = f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'review', loginId: 't1', reviewOf: registered(f, taskId) }, ROUTER);
  assert.equal(explicit.login_id, 't1');
  round(f, reviewId, 't1', PASS);
  assert.equal(f.task(reviewId).state, 'done');
  assert.deepEqual(bindingOf(f, reviewId).writers, ['claude']);
});

test('only a round that really started counts as a writer', (t) => {
  const f = fixture(t);
  setUp(f);
  const task = f.newTask();
  f.ledger.queueTask(task.id, USER);
  // A codex round no machine took: settled lost, not started.
  const unstarted = f.ledger.createRun(task.id, {
    login: account(f, 't2'), machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'codex', tier: 'execute', tier_value: codexTier('/x') }, expectedRevision: 1,
  }, USER);
  f.ledger.settleRun(unstarted.id, null, null, { kind: 'lost', lost: { basis: 'not_started' } });
  round(f, task.id, 't1', WROTE);
  assert.deepEqual(bindingOf(f, reviewFor(f, task.id)).writers, ['claude']);
});

test('three verdicts: a pass opens acceptance, a rejection is not "审不了", and a malformed one is a short delivery', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  // Before any review the Router cannot accept; the reason says what to do.
  assert.throws(() => f.ledger.acceptTask(taskId, '看着行', ROUTER), new RegExp(NEEDS_PASS_TEXT.slice(0, 10)));
  // "审不了": the review stops for the Router to supply what is missing; nothing escalates.
  const cannot = reviewFor(f, taskId);
  round(f, cannot, 't2', CANNOT);
  assert.equal(f.task(cannot).state, 'held');
  assert.match(f.task(cannot).reason!, /审不了：没有测试记录/);
  assert.deepEqual([f.task(taskId).state, f.task(taskId).tier_override], ['ready', null]);
  // Minimal verdict (only result required) is accepted; unknown result is a short delivery.
  const minimal = reviewFor(f, taskId);
  round(f, minimal, 't2', { status: 'done', summary: '行', verdict: { result: 'reject', summary: '不行', violations: [] } });
  assert.equal(f.task(minimal).state, 'done');
  assert.equal(verdictOf(f, minimal).result, 'reject');
  const bad = reviewFor(f, taskId);
  round(f, bad, 't2', { status: 'done', summary: '行', verdict: { result: 'maybe' } });
  assert.equal(f.task(bad).state, 'held');
  assert.match(f.task(bad).reason!, /交付不齐/);
  assert.equal(f.task(taskId).state, 'ready', '格式不对的结论不算打回');
  // A pass: kept on the review, auto-closes the review task to done, and opens acceptance.
  const pass = reviewFor(f, taskId);
  round(f, pass, 't2', PASS);
  assert.deepEqual([verdictOf(f, pass).result, verdictOf(f, pass).current, f.task(pass).state], ['pass', true, 'done']);
  assert.ok(f.task(pass).closed_at !== null);
  assert.equal(f.ledger.reviewGate(taskId), null);
  f.ledger.acceptTask(taskId, '审阅通过', ROUTER);
  assert.equal(f.task(taskId).state, 'done');
});

test('a pass on an old product or old criteria does not satisfy acceptance', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  const pass = reviewFor(f, taskId);
  round(f, pass, 't2', PASS);
  // Files registered again with other bytes: not the product that was reviewed.
  f.ledger.registerArtifacts(f.ledger.listRuns(taskId).at(-1)!.id, [{ ...FILES[0]!, sha256: 'c'.repeat(64) }, FILES[1]!]);
  assert.match(f.ledger.reviewGate(taskId)!, /不一样/);
  assert.throws(() => f.ledger.acceptTask(taskId, '看着行', ROUTER), /要独立审阅/);
  f.ledger.registerArtifacts(f.ledger.listRuns(taskId).at(-1)!.id, FILES);
  assert.equal(f.ledger.reviewGate(taskId), null, '登记回审过的那一份就又对得上');
  // Criteria changed: the Task is held for confirmation, and the old pass no longer counts.
  f.ledger.updateTask(taskId, { acceptance: '测试通过，并且文档写了' }, ROUTER);
  f.ledger.resumeTask(taskId, ROUTER);
  round(f, taskId, 't1', WROTE);
  assert.equal(f.task(taskId).state, 'ready');
  assert.throws(() => f.ledger.acceptTask(taskId, '看着行', ROUTER), /要独立审阅/);
});

test('the reviewed product is the source and the commit as well as the files: another source or another commit is not it', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  round(f, reviewFor(f, taskId), 't2', PASS);
  assert.equal(f.ledger.reviewGate(taskId), null);
  // The same commit, but the Task now says its code is another folder: that place was not
  // reviewed, and the pass no longer speaks for the product (docs/design/code-sources.md §8 第 5 条).
  sourced(f, taskId);
  f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: sourceOf(f).id, pinned: { ...sourceOf(f), path: '/work/other' } }), taskId);
  assert.match(f.ledger.reviewGate(taskId)!, /代码来源或提交/);
  sourced(f, taskId);
  assert.equal(f.ledger.reviewGate(taskId), null, '回到审过的那个来源就又对得上');
  // The machine read another commit for the same round: what was reviewed is not what is there.
  const runId = f.ledger.listRuns(taskId).at(-1)!.id;
  f.force('UPDATE run SET error_json = ? WHERE id = ?', JSON.stringify({ source_head: { ...FOLDER_HEAD, head: 'd00d' } }), runId);
  assert.match(f.ledger.reviewGate(taskId)!, /代码来源或提交/);
  // And the same commit packed again into other bytes is a different product too.
  f.force('UPDATE run SET error_json = ? WHERE id = ?', JSON.stringify({ source_head: FOLDER_HEAD }), runId);
  f.ledger.registerArtifacts(runId, [{ ...FILES[0]!, sha256: 'e'.repeat(64) }, FILES[1]!]);
  assert.match(f.ledger.reviewGate(taskId)!, /产物文件/);
});

test('owner and granted Router may accept without review on the record; ungranted Router may not', (t) => {
  const f = fixture(t);
  const { taskId, runId } = implemented(f);
  // Router without accept grant is still refused.
  f.ledger.setProjectGrants(f.projectId, [], USER);
  assert.throws(() => f.ledger.acceptTask(taskId, '我说行', ROUTER, { withoutReview: true }), /没有授权负责人自己验收/);
  // Owner can always accept without review on the record.
  f.ledger.acceptTask(taskId, '只有一个执行器，我看过了', CONSOLE, { withoutReview: true });
  assert.equal(f.task(taskId).state, 'done');
  assert.deepEqual(changes(f, 'task.accept').map(({ task_id, without_review }) => [task_id, without_review]), [[taskId, true]]);
  // Launching what it left is the owner's word too.
  assert.equal(f.ledger.releaseGate(runId, FILES[1]!), null);
  // Router WITH accept grant can also pass withoutReview: true, audit-logged.
  f.ledger.setProjectGrants(f.projectId, ['accept'], USER);
  const second = implemented(f);
  f.ledger.acceptTask(second.taskId, '负责人确认跳过审阅', ROUTER, { withoutReview: true });
  assert.equal(f.task(second.taskId).state, 'done');
  assert.equal((changes(f, 'task.accept').at(-1) as { without_review?: boolean }).without_review, true);
});

test('a release of a Task that needs review is let through only for a package a current pass covers', (t) => {
  const f = fixture(t);
  const { taskId, runId } = implemented(f);
  assert.equal(f.ledger.releaseGate(runId, FILES[1]!), RELEASE_NEEDS_PASS_TEXT);
  round(f, reviewFor(f, taskId), 't2', PASS);
  assert.equal(f.ledger.releaseGate(runId, FILES[1]!), null);
  assert.equal(f.ledger.releaseGate(runId, { ...FILES[1]!, bytes: 21 }), RELEASE_NEEDS_PASS_TEXT, '换过的包不算审过');
  // A Task whose role needs no review is not asked.
  const verify = f.newTask({ roleId: 'verify' });
  f.ledger.queueTask(verify.id, USER);
  const verifyRun = round(f, verify.id, 't1', { status: 'done', summary: '跑了', artifacts: [{ kind: 'report', ref: 'r.md' }] });
  assert.equal(f.ledger.releaseGate(verifyRun, FILES[1]!), null);
});

test('a rejection on the execute tier records the verdict without auto-escalating, auto-requeuing, or locking out Router', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  const reviewId = reviewFor(f, taskId);
  round(f, reviewId, 't2', REJECT);
  const task = f.task(taskId);
  assert.deepEqual([task.state, task.tier, task.tier_source, task.tier_reason], ['ready', 'execute', 'default', null]);
  assert.deepEqual([verdictOf(f, reviewId).result, verdictOf(f, reviewId).current, f.task(reviewId).state], ['reject', true, 'done']);
  assert.equal(f.ledger.listInputs(taskId).length, 0);
  assert.deepEqual(changes(f, 'task.escalate'), []);
  // Router can freely update tier or rework without tier lock.
  f.ledger.updateTask(taskId, { tierOverride: { tier: 'decide', reason: '按审阅意见升档' } }, ROUTER);
  assert.deepEqual([f.task(taskId).tier, f.task(taskId).tier_source], ['decide', 'override']);
  f.ledger.updateTask(taskId, { tierOverride: null }, ROUTER);
  assert.deepEqual([f.task(taskId).tier, f.task(taskId).tier_source], ['execute', 'default']);
});

test('a rejection on the operate tier records the verdict without auto-escalating', (t) => {
  const f = fixture(t);
  setUp(f);
  const task = f.newTask({ roleId: 'verify' });
  f.ledger.queueTask(task.id, USER);
  const REPORT = { status: 'done', summary: '跑完了', artifacts: [{ kind: 'report', ref: 'r.md' }] };
  round(f, task.id, 't1', REPORT);
  assert.equal(f.task(task.id).state, 'ready');
  const reviewId = reviewFor(f, task.id);
  round(f, reviewId, 't2', REJECT);
  const after = f.task(task.id);
  assert.deepEqual([after.state, after.tier, after.tier_source, after.tier_reason], ['ready', 'operate', 'default', null]);
  assert.deepEqual(changes(f, 'task.escalate'), []);
});

test('a rejection on the decide tier leaves the Task ready without opening a blocking owner-only approval', (t) => {
  const f = fixture(t);
  setUp(f);
  const task = f.newTask({ tierOverride: { tier: 'decide', reason: '难' } });
  f.ledger.queueTask(task.id, USER);
  round(f, task.id, 't1', WROTE);
  const reviewId = reviewFor(f, task.id);
  round(f, reviewId, 't2', REJECT);
  assert.equal(f.task(reviewId).state, 'done');
  assert.equal(f.task(task.id).state, 'ready');
  assert.equal(f.ledger.listApprovals(task.id).filter(({ state }) => state === 'open').length, 0);
  // Router is not locked out and can rework the task directly.
  f.ledger.reworkTask(task.id, '按审阅意见再改一轮', f.task(task.id).revision, ROUTER);
  assert.deepEqual([f.task(task.id).state, f.task(task.id).tier], ['queued', 'decide']);
});

test('owner can accept a task with a legacy open review approval directly without review, closing the approval', (t) => {
  const f = fixture(t);
  setUp(f);
  const task = f.newTask({ tierOverride: { tier: 'decide', reason: '难' } });
  f.ledger.queueTask(task.id, USER);
  const approvalId = f.ledger.openApproval(task.id, [{ question: '审阅打回，怎么处理？', options: [...DECIDE_REJECTION_OPTIONS] }], USER);
  f.force('UPDATE approval SET review_task_id = ? WHERE id = ?', 'legacy-review-1', approvalId);
  assert.equal(f.task(task.id).state, 'waiting_person');
  assert.throws(() => f.ledger.acceptTask(task.id, '看着行', CONSOLE), /不能验收|不在待验收/);
  f.ledger.acceptTask(task.id, '复审属于边界场景，现状已满足需求', CONSOLE, { withoutReview: true });
  assert.equal(f.task(task.id).state, 'done');
  assert.equal(f.ledger.listApprovals(task.id).find(({ id }) => id === approvalId)?.state, 'closed');
  const acceptChange = changes(f, 'task.accept').at(-1)! as { without_review?: boolean };
  assert.equal(acceptChange.without_review, true);
});

test('a review settled twice is idempotent, and a review becomes stale after rework', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  const first = reviewFor(f, taskId);
  const second = reviewFor(f, taskId);
  const run = round(f, first, 't2', REJECT);
  // The same Run settled again is a late result: nothing more happens.
  assert.equal(f.ledger.settleRun(run, 0, REJECT as never, { codeCheck: NO_CODE }).late, true);
  assert.equal(changes(f, 'review.verdict').length, 1);
  // Once the task is reworked and a new round finishes, settling the older review marks it not current.
  f.ledger.reworkTask(taskId, '修复问题', f.task(taskId).revision, ROUTER);
  round(f, taskId, 't1', WROTE);
  round(f, second, 't2', REJECT);
  assert.equal(verdictOf(f, second).current, false);
  assert.equal(f.task(taskId).state, 'ready');
});

test('a quota, a lost round or "审不了" is not a rejection and escalates nothing', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  const reviewId = reviewFor(f, taskId);
  const quota = f.ledger.createRun(reviewId, {
    login: account(f, 't2'), machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'codex', tier: 'execute', tier_value: codexTier('/x') }, expectedRevision: 1,
  }, USER);
  f.ledger.markRunRunning(quota.id);
  f.ledger.settleRun(quota.id, 1, REJECT as never, { kind: 'quota', quota: { message: '额度没了' } });
  f.ledger.endRest('t2', USER);
  const lost = f.ledger.createRun(reviewId, {
    login: account(f, 't2'), machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'codex', tier: 'execute', tier_value: codexTier('/x') }, expectedRevision: 1,
  }, USER);
  f.ledger.markRunRunning(lost.id);
  f.ledger.settleRun(lost.id, null, REJECT as never, { kind: 'lost', lost: { basis: 'seen' } });
  round(f, reviewId, 't2', CANNOT);
  assert.deepEqual([f.task(taskId).state, f.task(taskId).tier_override], ['ready', null]);
  assert.equal(changes(f, 'task.escalate').length, 0);
});

test('commit/report deliverables missing from receipt settle to ready without short-delivery hold', (t) => {
  const f = fixture(t);
  setUp(f);
  const implement = f.newTask();
  f.ledger.queueTask(implement.id, USER);
  round(f, implement.id, 't1', { status: 'done', summary: '改好了' });
  assert.equal(f.task(implement.id).state, 'ready');
  const analyse = f.newTask({ roleId: 'analyse' });
  f.ledger.queueTask(analyse.id, USER);
  round(f, analyse.id, 't1', { status: 'done', summary: '想清楚了', artifacts: [{ kind: 'report', ref: 'report.md' }] });
  assert.equal(f.task(analyse.id).state, 'ready');
});

test('a receipt that names two commits settles to ready cleanly without throwing', (t) => {
  const f = fixture(t);
  setUp(f);
  const task = f.newTask();
  f.ledger.queueTask(task.id, USER);
  round(f, task.id, 't1', { status: 'done', summary: '改了两处', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'commit', ref: 'f00d' }] });
  assert.equal(f.task(task.id).state, 'ready');
});

test("a Task's start is the first round that really began work, never a later round standing in", (t) => {
  const f = fixture(t);
  setUp(f);
  const task = f.newTask();
  f.ledger.queueTask(task.id, USER);
  // The first round worked but reported no start (an older client, or a machine that read none).
  round(f, task.id, 't1', WROTE);
  f.force('UPDATE run SET error_json = ? WHERE id = ?', JSON.stringify({ source_head: { kind: 'folder', head: 'c0ffee' } }), f.ledger.listRuns(task.id).at(-1)!.id);
  f.ledger.reworkTask(task.id, '再改一处', f.task(task.id).revision, USER);
  // A later round reports one; the Task's start stays unknown rather than becoming that HEAD.
  round(f, task.id, 't1', WROTE);
  assert.equal(bindingOf(f, reviewFor(f, task.id)).start, undefined, '第一轮没有报起点，就不拿后面那一轮的冒充');
  // A round that never began is not the first: the next one that works starts the Task.
  const fresh = f.newTask();
  f.ledger.queueTask(fresh.id, USER);
  const silent = f.ledger.createRun(fresh.id, {
    login: account(f, 't1'), machine: f.ledger.getMachine('h1')!,
    snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'claude', tier: 'execute', tier_value: claudeTier('/x') }, expectedRevision: 1,
  }, USER);
  f.ledger.settleRun(silent.id, null, null, { kind: 'lost', lost: { basis: 'not_started' } });
  round(f, fresh.id, 't1', WROTE);
  assert.equal(bindingOf(f, reviewFor(f, fresh.id)).start, START, '没开工的那一轮不算第一轮');
});

for (const point of ['afterSettleRunWrite', 'beforeCommit', 'afterCommit'] as const) {
  test(`a crash at ${point} of the review's settlement leaves both its effects or neither`, (t) => {
    class Crash extends Error {}
    let armed = false;
    const f = fixture(t, { testHooks: {
      ...(point === 'afterCommit'
        ? { afterCommit(actions: string[], retire: () => void) { if (armed && actions.includes('run.settle')) { retire(); throw new Crash(); } } }
        : { [point]() { if (armed) throw new Crash(); } }),
    } });
    const { taskId } = implemented(f);
    const reviewId = reviewFor(f, taskId);
    const run = f.ledger.createRun(reviewId, {
      login: account(f, 't2'), machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'codex', tier: 'execute', tier_value: codexTier('/x') }, expectedRevision: 1,
    }, USER);
    f.ledger.markRunRunning(run.id);
    const before = f.dump();
    armed = true;
    assert.throws(() => f.ledger.settleRun(run.id, 0, REJECT as never, { codeCheck: NO_CODE }), Crash);
    armed = false;
    if (point !== 'afterCommit') {
      assert.deepEqual(f.dump(), before, '结算没提交，结论和任务状态也都没有写');
      f.ledger.settleRun(run.id, 0, REJECT as never, { codeCheck: NO_CODE });
    }
    const reopened = f.open();
    assert.equal(reopened.getRun(run.id).state, 'ended');
    assert.equal(reopened.getTask(reviewId).state, 'done');
    assert.equal(JSON.parse(reopened.getTask(reviewId).verdict_json!).result, 'reject');
    assert.deepEqual([reopened.getTask(taskId).state, reopened.getTask(taskId).tier_source], ['ready', 'default']);
  });
}

test('the review a product needs is its round\'s: the Router changing the Task to a role without review lets nothing through', (t) => {
  const f = fixture(t);
  const { taskId, runId } = implemented(f);
  registered(f, taskId);
  f.ledger.updateTask(taskId, { roleId: 'verify' }, ROUTER);
  assert.deepEqual([f.task(taskId).state, f.task(taskId).role_id], ['ready', 'verify']);
  assert.throws(() => f.ledger.acceptTask(taskId, '验证不用审', ROUTER), /要独立审阅/);
  assert.equal(f.ledger.releaseGate(runId, FILES[1]!), RELEASE_NEEDS_PASS_TEXT);
  // A later round runs as what the Task is then, and asks only what that role asks.
  f.ledger.reworkTask(taskId, '再跑一遍', f.task(taskId).revision, USER);
  const next = round(f, taskId, 't1', { status: 'done', summary: '跑了', artifacts: [{ kind: 'report', ref: 'r.md' }] });
  assert.equal(f.ledger.reviewGate(taskId), null);
  assert.equal(f.ledger.releaseGate(next, FILES[1]!), null);
});

test('a round whose start went out counts as a writer unless it was judged never to have started', (t) => {
  const f = fixture(t);
  setUp(f);
  const task = f.newTask();
  f.ledger.queueTask(task.id, USER);
  // codex's start was never answered and its machine then showed nothing: lost, not "not started".
  const silent = f.ledger.createRun(task.id, {
    login: account(f, 't2'), machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'codex', tier: 'execute', tier_value: codexTier('/x') }, expectedRevision: 1,
  }, USER);
  f.ledger.settleRun(silent.id, null, null, { kind: 'lost', lost: { basis: 'seen' } });
  assert.equal(f.run(silent.id).started_at, null);
  round(f, task.id, 't1', WROTE);
  assert.deepEqual(bindingOf(f, reviewFor(f, task.id)).writers, ['claude', 'codex']);
});

test('a round that came in while the files were being taken over is not paired with them', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  // Taking over began for round A, at this revision...
  const fixed = registered(f, taskId);
  // ...and meanwhile the Task was sent back and round B finished.
  f.ledger.reworkTask(taskId, '再改', f.task(taskId).revision, USER);
  round(f, taskId, 't1', WROTE);
  assert.throws(
    () => f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'review', reviewOf: fixed }, ROUTER),
    /在取回产物的这段时间里又跑了一轮/,
  );
  assert.equal(f.ledger.reviewsOf(taskId).length, 0);
});

test('a product needing review whose files are not registered cannot be accepted, and registering none is not "unknown"', (t) => {
  const f = fixture(t);
  const { taskId, runId } = implemented(f);
  assert.equal(f.ledger.currentProduct(taskId).files, null);
  assert.throws(() => f.ledger.createTask({ projectId: f.projectId, title: 'x', goal: 'x', roleId: 'review', reviewOf: { taskId, runId, revision: 1 } }, ROUTER), /还没有登记/);
  assert.throws(() => f.ledger.acceptTask(taskId, '看着行', ROUTER), /要独立审阅/);
  f.ledger.registerArtifacts(runId, []);
  assert.deepEqual(f.ledger.currentProduct(taskId).files, []);
});

test('acceptance, the release entry and a review settling all judge the product by the one identity', (t) => {
  const f = fixture(t);
  const { taskId, runId } = implemented(f);
  round(f, reviewFor(f, taskId), 't2', PASS);
  const pending = reviewFor(f, taskId);
  assert.equal(f.ledger.reviewGate(taskId), null);
  assert.equal(f.ledger.releaseGate(runId, FILES[1]!), null);
  // The same round registered again: the bundle changed, the package did not.
  f.ledger.registerArtifacts(runId, [{ ...FILES[0]!, sha256: 'd'.repeat(64) }, FILES[1]!]);
  assert.match(f.ledger.reviewGate(taskId)!, /不一样/);
  assert.equal(f.ledger.releaseGate(runId, FILES[1]!), RELEASE_NEEDS_PASS_TEXT, '没变的包也不放行：审过的是整份产物');
  // A review of the old files that rejects now is history: it moves nothing.
  round(f, pending, 't2', REJECT);
  assert.equal(verdictOf(f, pending).current, false);
  assert.deepEqual([f.task(taskId).state, f.task(taskId).tier_source], ['ready', 'default']);
});

test('a round after a tier override records the reason with its tier, and a branch-only receipt settles cleanly', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  f.ledger.updateTask(taskId, { tierOverride: { tier: 'decide', reason: '按审阅意见升档修改' } }, ROUTER);
  f.ledger.reworkTask(taskId, '按审阅意见修改', f.task(taskId).revision, ROUTER);
  const next = round(f, taskId, 't1', WROTE);
  const snapshot = JSON.parse(f.run(next).snapshot_json) as { tier: string; tier_source: string; tier_reason?: string };
  assert.deepEqual([snapshot.tier, snapshot.tier_source, snapshot.tier_reason], ['decide', 'override', '按审阅意见升档修改']);
  const branch = f.newTask();
  f.ledger.queueTask(branch.id, USER);
  round(f, branch.id, 't1', { status: 'done', summary: '在分支上', artifacts: [{ kind: 'branch', ref: 'tycho/x' }] });
  assert.equal(f.task(branch.id).state, 'ready');
});

test('reviewGateInfo and activeReview report context-aware review states accurately', (t) => {
  const f = fixture(t);
  const { taskId, runId } = implemented(f);
  // 1. No review yet
  assert.deepEqual(f.ledger.reviewGateInfo(taskId), { kind: 'no_review', message: NEEDS_PASS_TEXT });
  assert.equal(f.ledger.activeReview(taskId), null);

  // 2. Active queued review -> in_review
  const reviewId = reviewFor(f, taskId);
  assert.equal(f.ledger.activeReview(taskId)?.id, reviewId);
  assert.deepEqual(f.ledger.reviewGateInfo(taskId), {
    kind: 'in_review',
    message: REVIEW_IN_PROGRESS_TEXT,
    review_task_id: reviewId,
    review_state: 'queued',
    review_reason: null,
  });
  assert.equal(f.ledger.reviewGate(taskId), REVIEW_IN_PROGRESS_TEXT);

  // 3. Review stops with cannot -> review_held
  round(f, reviewId, 't2', CANNOT);
  const held = f.ledger.reviewGateInfo(taskId);
  assert.equal(held?.kind, 'review_held');
  assert.equal(held?.review_task_id, reviewId);
  assert.equal(held?.review_state, 'held');
  assert.equal(held?.message, reviewHeldGateText(f.task(reviewId).reason));

  // 4. Second review passes -> gate cleared & review task auto-closed to done
  const passId = reviewFor(f, taskId);
  round(f, passId, 't2', PASS);
  assert.equal(f.task(passId).state, 'done');
  assert.equal(f.ledger.reviewGateInfo(taskId), null);
  assert.equal(f.ledger.reviewGate(taskId), null);

  // 5. Files change -> stale_pass
  f.ledger.registerArtifacts(runId, [{ ...FILES[0]!, sha256: 'e'.repeat(64) }, FILES[1]!]);
  const stale = f.ledger.reviewGateInfo(taskId);
  assert.equal(stale?.kind, 'stale_pass');
  assert.match(stale?.message ?? '', /有过的“通过”已经不算/);
});

test('review reject auto-closes the review task to done while leaving the reviewed task ready', (t) => {
  const f = fixture(t);
  const { taskId } = implemented(f);
  const reviewId = reviewFor(f, taskId);
  round(f, reviewId, 't2', REJECT);
  assert.equal(f.task(reviewId).state, 'done');
  assert.ok(f.task(reviewId).closed_at !== null);
  assert.equal(f.task(taskId).state, 'ready');
});

test('work_ready fires only after review passes for tasks needing review, never prematurely', (t) => {
  const f = fixture(t);
  const sub = f.ledger.createTrigger(f.projectId, { name: '就绪监听', instruction: '处理 {{task_id}}', source: 'event', event: { kind: 'work_ready' } }, USER);
  const { taskId } = implemented(f);

  // Task is in ready state, but needs review -> NO work_ready push or trigger yet!
  assert.equal(f.task(taskId).state, 'ready');
  assert.equal(f.peek(`SELECT 1 FROM push WHERE kind = 'work_ready'`).length, 0);
  assert.equal(f.ledger.listTriggerFires({ triggerId: sub.id, limit: 10 }).length, 0);

  // Independent review passes -> work_ready fires NOW for the reviewed task!
  const reviewId = reviewFor(f, taskId);
  const reviewRunId = round(f, reviewId, 't2', PASS);
  const pushes = f.peek<{ key: string; payload_json: string }>(`SELECT key, payload_json FROM push WHERE kind = 'work_ready' ORDER BY rowid`);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.key, `work-ready:${reviewRunId}`);
  assert.equal((JSON.parse(pushes[0]!.payload_json) as { task_id: string }).task_id, taskId);
  const fires = f.ledger.listTriggerFires({ triggerId: sub.id, limit: 10 });
  assert.equal(fires.length, 1);
  assert.equal(fires[0]!.data.task_id, taskId);

  // A second passing review of the already-ready product does not duplicate work_ready.
  round(f, reviewFor(f, taskId), 't2', PASS);
  assert.equal(f.peek(`SELECT 1 FROM push WHERE kind = 'work_ready'`).length, 1);
});

test('legacy review rejection approval deterministically handles accept-without-review and abandon', (t) => {
  const makeLegacyRejectedApproval = (f: Fixture) => {
    setUp(f);
    const task = f.newTask({ tierOverride: { tier: 'decide', reason: '难' } });
    f.ledger.queueTask(task.id, USER);
    const approvalId = f.ledger.openApproval(task.id, [{ question: '审阅打回，怎么处理？', options: [...DECIDE_REJECTION_OPTIONS] }], USER);
    f.force('UPDATE approval SET review_task_id = ? WHERE id = ?', 'legacy-review-1', approvalId);
    return { taskId: task.id, approvalId };
  };

  // 1. Accept without review via approval answer (with reason)
  {
    const f = fixture(t);
    const { taskId, approvalId } = makeLegacyRejectedApproval(f);
    const inputsBefore = f.ledger.listInputs(taskId).length;
    const sub = f.ledger.createTrigger(f.projectId, { name: '验收监听', instruction: '处理 {{task_id}}', source: 'event', event: { kind: 'accepted' } }, USER);

    const res = f.ledger.answerApproval(approvalId, ['不经审阅直接验收：边角问题可后续跟踪'], 'user', 'console');
    assert.equal(res.status, 'accepted');
    assert.equal(res.action, 'accept_without_review');
    assert.equal(f.task(taskId).state, 'done');
    assert.equal(f.ledger.listInputs(taskId).length, inputsBefore, '不再入队返工输入');
    assert.equal(f.ledger.acceptedWithoutReview(taskId), true);
    const approval = f.ledger.listApprovals(taskId).find(({ id }) => id === approvalId)!;
    assert.equal(approval.state, 'answered');
    const acceptChange = changes(f, 'task.accept').at(-1) as { basis: string; without_review: boolean };
    assert.equal(acceptChange.without_review, true);
    assert.equal(acceptChange.basis, '边角问题可后续跟踪');
    assert.equal(f.ledger.listTriggerFires({ triggerId: sub.id, limit: 10 }).length, 1);
  }

  // 2. Abandon via approval answer
  {
    const f = fixture(t);
    const { taskId, approvalId } = makeLegacyRejectedApproval(f);
    const inputsBefore = f.ledger.listInputs(taskId).length;
    const res = f.ledger.answerApproval(approvalId, ['放弃这个任务：方案已废弃'], 'user', 'wecom');
    assert.equal(res.status, 'accepted');
    assert.equal(res.action, 'abandon');
    assert.equal(f.task(taskId).state, 'abandoned');
    assert.equal(f.task(taskId).reason, '方案已废弃');
    assert.equal(f.ledger.listInputs(taskId).length, inputsBefore, '不再入队返工输入');
    const approval = f.ledger.listApprovals(taskId).find(({ id }) => id === approvalId)!;
    assert.equal(approval.state, 'answered');
  }
});
