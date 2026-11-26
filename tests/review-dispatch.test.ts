// Guards review from the Router's tool to the round on a machine (docs/design/roles-and-
// tiers.md §4, §6), and what a review is bound to now that code is not carried as a bundle
// (docs/design/code-sources.md §2, §8): the commit the reviewed round reported, checked against
// what the round's own machine read of where the code stands — a repository's remote branch head
// with `git ls-remote` on that machine, a folder's HEAD — and never what the Router says. Against:
// a review bound to a commit no machine reported, or to one that is not the head of the branch
// the receipt named; a review brief that hands the reviewer its author's receipt, summary,
// report instead of the reviewed Task's bound goal, criteria and commit; or a review's own
// supplemental requirements silently dropped from its next Run;
// a review with no eligible reviewer jamming the queue or waiting without saying who wrote the
// product; an escalated Task's next round continuing the session of its execute-tier round; a
// brief that does not say what its role must hand over, or a receipt format without the verdict;
// and the Router's accept_task going past the gate, or a page offering the owner no way past it
// that leaves a record.
// And against a round that came in while the files were being taken over being paired with
// them, a taking-over that failed wiping what an earlier one registered, and two takings of
// one round mixing their files: a binding takes only the latest registration.
// And against a review stuck for want of another executor when the author's executor could
// review it in a new session; a review that falls back silently, or while another executor is
// only busy; and a pass from such a review that does not say it was not independent.
// And against a review running on a tier other than the round it reviews (§11.5).
// And against a bound review being repinned afterwards: the move is refused and writes nothing,
// so its verdict cannot settle the reviewed Task from a source that never held the reviewed
// commit.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { Account, Snapshot } from '../runner/snapshot.ts';
import { prepareSnapshot, snapshotFiles } from '../runner/snapshot.ts';
import { createAcceptor } from '../service/accept.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import type { RunRow } from '../service/ledger.ts';
import { createTools } from '../service/tools.ts';
import { noReviewerText, type ReviewOf } from '../shared/review.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import type { NodeSourceHead } from '../shared/node-protocol.ts';
import { claudeTier, content, DISPATCH_TUNED, fixture, type Fixture, memoryLogins, readOnlyEverywhere, RUN_LIMIT_MS, tuned, USER } from './helpers.ts';

const CLAUDE: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json'), decide: claudeTier('/tiers/decide.json') } };
const CODEX: Account = { id: 't2', name: 't2', executor: 'codex', tiers: { decide: { kind: 'content', text: 'model = "x"\n' }, execute: { kind: 'content', text: 'model = "y"\n' } } };
const AUTHOR_SAYS = '作者自己说：全部测试都过了，放心';
const ROUTER_SAYS = '负责人的话：作者说已经修好，你确认一下就行';
const COMMIT = 'c'.repeat(40);
// What the review round's machine reports once it is over: the code it was handed, unchanged.
const SAME = { codeCheck: { result: 'same' } } as const;
const PASS = { status: 'done', summary: '审过', verdict: { result: 'pass', summary: '没问题' } };
const REJECT = { status: 'done', summary: '不行', verdict: { result: 'reject', summary: '漏了', violations: [{ requirement: 'r', evidence: 'e', scope: 's' }] } };

// A project whose accounts can review, and the host's channel for taking a round's files
// over: the machine answers, waits, or fails, and hands back no code — code is a commit now.
// What the round's machine read of where the code stands arrives with the settlement
// (NodeSourceHead, docs/design/code-sources.md §8 第 4、6 条), and the binding acts on that
// alone: the host never asks a remote itself.
function setUp(t: TestContext, accounts: Account[] = [CLAUDE, CODEX]) {
  const f = fixture(t);
  for (const account of accounts) f.ledger.putAccount(account, USER, `ref-${account.id}`);
  f.ledger.setProjectLogins(f.projectId, accounts.map(({ id }) => id), USER);
  const fetched: string[] = [];
  const machine: { hold?: Promise<void>; fail?: string } = {};
  const accept = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      async fetchArtifacts(run: RunRow) {
        fetched.push(run.id);
        await machine.hold;
        if (machine.fail !== undefined) return { files: [], problem: machine.fail };
        return { files: [], problem: null };
      },
    },
  });
  const tools = createTools({
    ledger: f.ledger,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: { get: (id) => f.ledger.getAccount(id), list: () => f.ledger.listAccounts() },
    machines: { list: () => [] },
    accept,
  });
  const call = async (name: string, args: unknown) => {
    const result = await tools.call(name, args, { actor: 'router' }, { projectId: f.projectId });
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  const launched: { run: RunRow }[] = [];
  // Logins none of whose machines answer; executors whose machines have not reported (null)
  // or reported that their read-only way does not start ('down'); Runs out of contact, and
  // those the dispatcher went on to judge because a continuation had somewhere to go.
  const unreachable = new Set<string>();
  const reports = new Map<string, null | 'down'>();
  const lost: RunRow[] = [];
  const presumed: string[] = [];
  const everywhere = readOnlyEverywhere({ get: (id) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() });
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    runner: {
      findMachine: async (account, machines) => (unreachable.has(account.id) ? undefined : machines[0]),
      lostCandidates: () => lost.filter((run) => f.ledger.getRun(run.id).state !== 'ended'),
      presume: async (run) => { presumed.push(run.id); return 'unknown'; },
      sweep: async () => {},
      launch: async (run) => { launched.push({ run }); },
      watch: async () => {},
    },
    logins: memoryLogins(Object.fromEntries(accounts.map((account) => [account.id, account])), f.ledger),
    // A review is read-only: its machine has said the reviewer's read-only way starts there.
    machines: everywhere.machines,
    reported: (machineId, executor) => {
      const report = reports.get(executor);
      if (report === undefined) return everywhere.reported(machineId, executor);
      const base = everywhere.reported(machineId, executor);
      return report === null ? null : { ...base, read_only: { ...base.read_only!, available: false, error: '只读起不来' } };
    },
    executors: { claude: claudeAdapter, codex: codexAdapter },
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  return { f, fetched, machine, acceptor: accept, call, dispatcher, launched, unreachable, reports, lost, presumed, accounts };
}

// What the reviewed round's machine read when it was over: the branch the receipt named, that
// branch's head on the remote, the working copy's HEAD, and the HEAD the round began from.
const repoHead = (overrides: Partial<NodeSourceHead> = {}): NodeSourceHead =>
  ({ kind: 'repo', head: COMMIT, branch: 'main', remote_head: COMMIT, start: START, ...overrides });
const folderHead = (overrides: Partial<NodeSourceHead> = {}): NodeSourceHead =>
  ({ kind: 'folder', head: COMMIT, start: START, ...overrides });

// The implementation's round, dispatched and settled by its author with its own words, and what
// its machine read of the code (absent: the machine reported nothing).
async function implemented(s: ReturnType<typeof setUp>, receipt: Record<string, unknown> = {}, head?: NodeSourceHead): Promise<{ taskId: string; runId: string }> {
  const created = await s.call('create_task', { title: '修缓存', goal: '让缓存不过期', acceptance: '测试通过', scope: '只动 cache/', role_id: 'implement' });
  const taskId = created.text.split('：')[1]!;
  await s.dispatcher.tick();
  const run = s.launched.at(-1)!.run;
  s.f.ledger.markRunRunning(run.id, { sessionRef: 'author-session' });
  s.f.ledger.settleRun(run.id, 0, { status: 'done', summary: AUTHOR_SAYS, artifacts: [{ kind: 'commit', ref: COMMIT }, { kind: 'report', ref: AUTHOR_SAYS }], ...receipt } as never, {
    sessionRef: 'author-session', ...(head === undefined ? {} : { sourceHead: head }),
  });
  assert.equal(s.f.task(taskId).state, 'ready');
  return { taskId, runId: run.id };
}

// What the round's code source is, as the Task is pinned to it (shared/sources.ts TaskSource) and
// as the round's own snapshot recorded it when it was prepared (Snapshot.source). The binding is
// made from the round's own source (service/accept.ts reads the snapshot), so a test that pins a
// Task after its round ran writes the round's snapshot too — what the dispatcher's snapshot
// preparation does for a pinned Task.
function pin(s: ReturnType<typeof setUp>, taskId: string, pinned: { id: string; kind: 'repo'; url: string } | { id: string; kind: 'folder'; machine_uid: string; path: string }): void {
  s.f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: 's1', pinned }), taskId);
  // The project holds it too: a pin the project's list no longer names would stop the Task before
  // any machine is asked (service/ledger.ts sourceRefusal).
  s.f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([pinned]), s.f.projectId);
  // The round's own snapshot names the very source it ran on, with the binding identity the host
  // prepared it with (shared/sources.ts SnapshotSource): that is what the machine's checkout
  // directory and the agreement with the pin are read by.
  const source = snapshotSourceOf(pinned);
  for (const run of s.f.ledger.listRuns(taskId)) {
    s.f.force('UPDATE run SET snapshot_json = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(run.snapshot_json) as object, source }), run.id);
  }
}

const review = async (s: ReturnType<typeof setUp>, taskId: string): Promise<string> => {
  const made = await s.call('create_task', { title: '审修缓存', goal: ROUTER_SAYS, acceptance: '给结论', role_id: 'review', review_of: taskId });
  assert.equal(made.isError, false, made.text);
  return made.text.split('：')[1]!.split('，')[0]!;
};

const bindingOf = (f: Fixture, id: string): ReviewOf => JSON.parse(f.task(id).review_of_json!) as ReviewOf;
const snapshotOf = (run: RunRow): Snapshot => JSON.parse(run.snapshot_json) as Snapshot;
// What a Run's `run.create` line recorded of how it was placed.
const createdRun = (f: Fixture, run: RunRow) => {
  const change = f.ledger.listChanges({ taskId: run.task_id }).find(({ action, run_id }) => action === 'run.create' && run_id === run.id)!;
  return JSON.parse(change.detail_json ?? '{}') as { same_executor?: { executor: string; reason: string }; placed_by?: string };
};

const REMOTE = 'https://example.test/r';
const HEAD = 'a'.repeat(40);
const START = '0'.repeat(40);

test('a review is bound to the commit the round reported, as its machine read it on the branch', async (t) => {
  const s = setUp(t);
  const { taskId, runId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ head: HEAD, remote_head: HEAD }));
  pin(s, taskId, { id: 's1', kind: 'repo', url: REMOTE });
  const reviewId = await review(s, taskId);
  const binding = bindingOf(s.f, reviewId);
  assert.deepEqual(s.fetched, [runId], '审阅建起来时把被审那一轮的产物取回主机');
  assert.deepEqual([binding.run_id, binding.reviewed, binding.start, binding.files, binding.writers], [
    runId,
    { source_kind: 'repo', commit: HEAD, branch: 'main', url: REMOTE },
    START,
    [],
    ['claude'],
  ]);
  // Without naming a Task, a standalone review task is allowed and fetches nothing.
  const before = s.fetched.length;
  const standalone = await s.call('create_task', { title: 'x', goal: 'x', acceptance: 'x', role_id: 'review' });
  assert.equal(standalone.isError, false, standalone.text);
  assert.equal(s.fetched.length, before);
});

test("best-effort review binding keeps receipt commit even when remote branch head differs", async (t) => {
  const s = setUp(t);
  const { taskId, runId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: 'b'.repeat(40) }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ head: 'b'.repeat(40), remote_head: 'c'.repeat(40) }));
  pin(s, taskId, { id: 's1', kind: 'repo', url: REMOTE });
  const reviewId = await review(s, taskId);
  assert.deepEqual(bindingOf(s.f, reviewId).reviewed, { source_kind: 'repo', commit: 'b'.repeat(40), branch: 'main', url: REMOTE });
  assert.deepEqual(s.fetched, [runId]);
});

test('best-effort review binding succeeds when machine code facts differ or are absent', async (t) => {
  const s = setUp(t);
  const other = await implemented(s, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ branch: 'release', remote_head: HEAD }));
  pin(s, other.taskId, { id: 's1', kind: 'repo', url: REMOTE });
  const otherReview = await review(s, other.taskId);
  assert.deepEqual(bindingOf(s.f, otherReview).reviewed, { source_kind: 'repo', commit: HEAD, branch: 'main', url: REMOTE });

  const s2 = setUp(t);
  const quiet = await implemented(s2, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] });
  pin(s2, quiet.taskId, { id: 's1', kind: 'repo', url: REMOTE });
  const quietReview = await review(s2, quiet.taskId);
  assert.deepEqual(bindingOf(s2.f, quietReview).reviewed, { source_kind: 'repo', commit: HEAD, branch: 'main', url: REMOTE });
});

test('a folder source binds the HEAD its machine read, and names the folder', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: 'f'.repeat(40) }, { kind: 'report', ref: AUTHOR_SAYS }] }, folderHead({ head: 'f'.repeat(40) }));
  pin(s, taskId, { id: 's1', kind: 'folder', machine_uid: 'm1', path: '/work/repo' });
  const reviewId = await review(s, taskId);
  assert.deepEqual(bindingOf(s.f, reviewId).reviewed, { source_kind: 'folder', commit: 'f'.repeat(40), path: '/work/repo' });
});

test('a folder whose machine reported no HEAD falls back to the receipt commit best-effort', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: 'f'.repeat(40) }, { kind: 'report', ref: AUTHOR_SAYS }] });
  pin(s, taskId, { id: 's1', kind: 'folder', machine_uid: 'm1', path: '/work/repo' });
  const reviewId = await review(s, taskId);
  assert.deepEqual(bindingOf(s.f, reviewId).reviewed, { source_kind: 'folder', commit: 'f'.repeat(40), path: '/work/repo' });
});

test('a Task with no code source is bound to its files alone: there is no commit to check out', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s);
  const reviewId = await review(s, taskId);
  assert.equal(bindingOf(s.f, reviewId).reviewed, undefined);
  assert.equal(bindingOf(s.f, reviewId).start, undefined, '没有来源就没有起点');
  await s.dispatcher.tick();
  const brief = snapshotOf(s.launched.at(-1)!.run).brief;
  assert.match(brief, /无代码仓库，审阅下列登记文件/);
  assert.ok(!brief.includes('看不到要审的那一份代码'), '不把没有代码来源说成审不了');
});

test('a review binds best-effort to the round source even if repinned, falling back to pinned when snapshot lacks source', async (t) => {
  const s = setUp(t);
  const task = s.f.ledger.createTask({ projectId: s.f.projectId, title: '修缓存', goal: '让缓存不过期', acceptance: '测试通过', roleId: 'implement' }, USER);
  s.f.ledger.queueTask(task.id, USER);
  const repo = { id: 's1', kind: 'repo' as const, url: REMOTE };
  s.f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([repo]), s.f.projectId);
  s.f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: repo.id, pinned: repo }), task.id);
  const run = s.f.ledger.createRun(task.id, { ...s.f.login, login: s.f.ledger.getAccount('t1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', source: snapshotSourceOf(repo) } }, USER);
  s.f.ledger.markRunRunning(run.id);
  s.f.ledger.settleRun(run.id, 0, { status: 'done', summary: '改好了', artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] } as never, { sourceHead: repoHead({ head: HEAD, remote_head: HEAD }) });
  assert.equal(s.f.task(task.id).state, 'ready');
  // Reassigned to another repository: best-effort binding still records the round's original repo url.
  s.f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: 's2', pinned: { id: 's2', kind: 'repo', url: 'https://example.test/other' } }), task.id);
  const repinnedReview = await review(s, task.id);
  assert.deepEqual(bindingOf(s.f, repinnedReview).reviewed, { source_kind: 'repo', commit: HEAD, branch: 'main', url: REMOTE });
  // When snapshot has no source, falls back to the pinned source best-effort.
  s.f.ledger.abandonTask(repinnedReview, '换一份测试', USER);
  s.f.force('UPDATE run SET snapshot_json = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(s.f.run(run.id).snapshot_json) as object, source: undefined }), run.id);
  s.f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: 's1', pinned: { id: 's1', kind: 'repo', url: REMOTE } }), task.id);
  const olderReview = await review(s, task.id);
  assert.deepEqual(bindingOf(s.f, olderReview).reviewed, { source_kind: 'repo', commit: HEAD, branch: 'main', url: REMOTE });
});

test('the review brief keeps the bound Task and commit while delivering the review Task instructions without author history', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ head: HEAD, remote_head: HEAD }));
  pin(s, taskId, { id: 's1', kind: 'repo', url: REMOTE });
  const reviewId = await review(s, taskId);
  await s.dispatcher.tick();
  const sent = s.launched.at(-1)!;
  assert.equal(sent.run.task_id, reviewId);
  assert.equal(sent.run.login_id, 't2', '写过的执行器（claude）不来审');
  // The first review of a product has nobody to spread from: it is placed by the order.
  assert.equal(createdRun(s.f, sent.run).placed_by, 'order');
  const snapshot = snapshotOf(sent.run);
  assert.deepEqual([snapshot.tier, snapshot.tier_source], ['execute', 'reviewed'], '审阅跟着被审那一轮的档位');
  for (const expected of ['让缓存不过期', '测试通过', '只动 cache/', HEAD, REMOTE, 'main', START, '"verdict"', 'pass', 'reject', 'cannot']) {
    assert.ok(snapshot.brief.includes(expected), expected);
  }
  assert.ok(!snapshot.brief.includes(AUTHOR_SAYS), '不自动带作者自述');
  assert.ok(snapshot.brief.includes(ROUTER_SAYS), '审阅任务自己的要求要送达，不能替换冻结基准');
  assert.ok(!JSON.stringify(snapshot.history).includes(AUTHOR_SAYS), '历史只是审阅自己的轮次');
  assert.equal(snapshot.session_ref, undefined, '审阅开新会话');
});

// §8.11 with the review's own pin: a review works on the source it was pinned to when it was made
// — inherited from the reviewed Task and frozen with the binding — not on whatever source the
// reviewed Task names afterwards. Against: an old review following the author Task to another
// place while its binding still names the commit of the old one, so the reviewer checks a site
// that never held that commit.
test('a review round works on the source frozen when the review was made, not the one the reviewed Task names now', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ head: HEAD, remote_head: HEAD }));
  const first = { id: 's1', kind: 'repo' as const, url: REMOTE };
  const second = { id: 's2', kind: 'repo' as const, url: 'https://example.test/other' };
  pin(s, taskId, first);
  // The project holds both, so the review's own source is still one it may be dispatched on.
  s.f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([first, second]), s.f.projectId);
  const reviewId = await review(s, taskId);
  assert.equal(JSON.parse(s.f.task(reviewId).source_json!).source_id, first.id, '审阅建起来时继承被审任务的来源');
  // The author Task is moved to another source afterwards: the review keeps its own.
  s.f.ledger.updateTask(taskId, { sourceId: second.id }, USER);
  assert.equal(JSON.parse(s.f.task(taskId).source_json!).source_id, second.id);
  await s.dispatcher.tick();
  const run = s.launched.at(-1)!.run;
  assert.equal(run.task_id, reviewId);
  assert.equal((snapshotOf(run).source as { url: string }).url, REMOTE, '审阅用的是它自己钉住的来源，不是被审任务现在的');
});

// A review's source is part of its binding, not something to repin afterwards. The binding names
// the reviewed commit, and that commit is the reviewed Task's source's; a review moved to another
// source would check a place that never held it while its verdict still settles the reviewed Task.
// Against: the Router repinning a bound review, the refusal writing anything, and the review then
// being dispatched anywhere but the source it was frozen with.
test('a bound review cannot be repinned: the move is refused, nothing is written, and it runs on its own source', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ head: HEAD, remote_head: HEAD }));
  const first = { id: 's1', kind: 'repo' as const, url: REMOTE };
  const second = { id: 's2', kind: 'repo' as const, url: 'https://example.test/other' };
  pin(s, taskId, first);
  // The project holds both, so the second is one the review could be moved to — if a move were
  // allowed at all.
  s.f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([first, second]), s.f.projectId);
  const reviewId = await review(s, taskId);
  const before = s.f.task(reviewId);
  const written = s.f.ledger.listChanges({ taskId: reviewId }).length;

  const said = await s.call('update_task', { task_id: reviewId, source: second.id });
  assert.equal(said.isError, true, said.text);
  assert.match(said.text, /审阅用的来源随被审的那一轮定下，不能改/);
  assert.equal(s.f.task(reviewId).source_json, before.source_json, '来源还是冻结的那一项，没有写入');
  assert.equal(s.f.task(reviewId).revision, before.revision, '也不算一次修订');
  assert.equal(s.f.ledger.listChanges({ taskId: reviewId }).length, written, '时间线上没有这一笔');

  await s.dispatcher.tick();
  const run = s.launched.at(-1)!.run;
  assert.equal(run.task_id, reviewId);
  assert.equal((snapshotOf(run).source as { url: string }).url, REMOTE, '照冻结的来源派发，不是被拒的那一项');
});

test('a folder review brief names the folder, the commit, and its start without checking out', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: 'f'.repeat(40) }, { kind: 'report', ref: AUTHOR_SAYS }] }, folderHead({ head: 'f'.repeat(40), branch: 'main' }));
  pin(s, taskId, { id: 's1', kind: 'folder', machine_uid: s.f.ledger.getMachine('h1')!.uid, path: '/work/repo' });
  const reviewId = await review(s, taskId);
  await s.dispatcher.tick();
  const brief = snapshotOf(s.launched.at(-1)!.run).brief;
  for (const expected of ['/work/repo', 'f'.repeat(40), START, '非 tycho 管理']) {
    assert.ok(brief.includes(expected), expected);
  }
  assert.ok(!brief.includes('git checkout'), 'tycho 不替它 checkout');
});

test('a Task without a start gives the reviewed commit without a start commit range', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ head: HEAD, remote_head: HEAD, start: null }));
  pin(s, taskId, { id: 's1', kind: 'repo', url: REMOTE });
  const reviewId = await review(s, taskId);
  assert.equal(bindingOf(s.f, reviewId).start, undefined);
  await s.dispatcher.tick();
  const brief = snapshotOf(s.launched.at(-1)!.run).brief;
  assert.ok(brief.includes(HEAD));
  assert.ok(!brief.includes('起点'), '没有起点就不写起点');
});


test('with no other executor in the project, a review runs on its author\'s executor in a new session and says so', async (t) => {
  const s = setUp(t, [CLAUDE]);
  const { taskId } = await implemented(s);
  const reviewId = await review(s, taskId);
  await s.dispatcher.tick();
  const sent = s.launched.at(-1)!.run;
  assert.deepEqual([sent.task_id, sent.login_id], [reviewId, 't1'], '没有别的执行器：由写它的 claude 来审');
  const snapshot = snapshotOf(sent);
  assert.equal(snapshot.session_ref, undefined, '开新会话');
  assert.ok(!snapshot.brief.includes(AUTHOR_SAYS), '不自动带作者自述');
  assert.ok(snapshot.brief.includes(ROUTER_SAYS), '审阅任务自己的要求要送达，不能替换冻结基准');
  assert.equal(snapshot.same_executor?.executor, 'claude');
  assert.equal(snapshot.access?.permission, 'read', '照样只读');
  assert.match(snapshot.same_executor!.reason, /未换执行器/);
  assert.match(snapshot.same_executor!.reason, /没有别的执行器/);
  assert.deepEqual(createdRun(s.f, sent).same_executor, snapshot.same_executor, '时间线上记着');
  // Cross-executor is a soft preference, so pinning the author's account is allowed.
  assert.equal((await s.call('update_task', { task_id: reviewId, login_id: 't1' })).isError, false);
  // Its pass counts, and says it was not independent.
  s.f.ledger.markRunRunning(sent.id);
  s.f.ledger.settleRun(sent.id, 0, PASS as never, SAME);
  const verdict = JSON.parse((await s.call('get_task', { task_id: reviewId })).text).task.verdict;
  assert.equal(verdict.same_executor, 'claude');
  const accepted = await s.call('accept_task', { task_id: taskId, basis: '审阅通过' });
  assert.equal(accepted.isError, false, accepted.text);
});

test('a review falls back only when other executors are genuinely unavailable, and waits when merely busy', async (t) => {
  const cases: [string, (s: ReturnType<typeof setUp>) => void, RegExp][] = [
    ['resting', (s) => s.f.ledger.restRouterLogin('t2', { message: '额度用完' }), /t2 额度歇到/],
    ['signed out', (s) => s.f.ledger.rejectCredential('t2', 'ref-t2'), /t2 登录已失效/],
    ['no machine', (s) => s.unreachable.add('t2'), /t2 没有能用的机器/],
  ];
  for (const [name, out, said] of cases) {
    const s = setUp(t);
    const { taskId } = await implemented(s);
    const reviewId = await review(s, taskId);
    out(s);
    await s.dispatcher.tick();
    const sent = s.launched.at(-1)!.run;
    assert.deepEqual([sent.task_id, sent.login_id], [reviewId, 't1'], name);
    assert.match(snapshotOf(sent).same_executor!.reason, said, name);
  }
  // When the independent non-writer executor is merely busy (full), the review waits instead of falling back to the writer.
  const s = setUp(t, [CLAUDE, { ...CODEX, maxRuns: 0 }]);
  const { taskId } = await implemented(s);
  const reviewId = await review(s, taskId);
  const launchedBefore = s.launched.length;
  await s.dispatcher.tick();
  assert.equal(s.launched.length, launchedBefore, '非作者审阅者仅并发满时等待，不退回作者执行器');
  assert.equal(s.f.task(reviewId).state, 'queued');
});

test("a review respects an explicit pin while not stalling on missing read-only probes", async (t) => {
  // Pinned to the other executor, which rests: the pin is the choice, and the review waits for it.
  const pinned = setUp(t);
  const first = await implemented(pinned);
  const reviewId = await review(pinned, first.taskId);
  assert.equal((await pinned.call('update_task', { task_id: reviewId, login_id: 't2' })).isError, false);
  pinned.f.ledger.restRouterLogin('t2', { message: '额度用完' });
  await pinned.dispatcher.tick();
  assert.equal(pinned.f.task(reviewId).state, 'queued');
  assert.notEqual(pinned.launched.at(-1)!.run.task_id, reviewId);
  // Missing read-only probe never blocks dispatch: codex runs immediately.
  const waiting = setUp(t);
  const second = await implemented(waiting);
  const other = await review(waiting, second.taskId);
  waiting.reports.set('codex', null);
  await waiting.dispatcher.tick();
  assert.equal(waiting.launched.at(-1)!.run.task_id, other);
  assert.equal(waiting.launched.at(-1)!.run.login_id, 't2');
});

test('read-only probe errors are advisory and never block codex review dispatch', async (t) => {
  // Legacy read_only.available=false is advisory only: codex still dispatches in read permission.
  const s = setUp(t);
  const first = await implemented(s);
  const reviewId = await review(s, first.taskId);
  s.reports.set('codex', 'down');
  await s.dispatcher.tick();
  const sent = s.launched.at(-1)!.run;
  assert.deepEqual([sent.task_id, sent.login_id, snapshotOf(sent).access?.permission], [reviewId, 't2', 'read']);
});

test('a fallback review out of contact is judged when its executor has somewhere to go on, and its login stays on the record while it waits for a machine', async (t) => {
  const s = setUp(t, [CLAUDE]);
  const { taskId } = await implemented(s);
  const reviewId = await review(s, taskId);
  await s.dispatcher.tick();
  const round = s.launched.at(-1)!.run;
  assert.equal(round.task_id, reviewId);
  s.f.ledger.markRunRunning(round.id);
  s.lost.push(round);
  await s.dispatcher.tick();
  assert.deepEqual(s.presumed, [round.id], '写它的执行器有地方接着做：旧的一轮拿去判定');
  // A review whose other executor rests, and whose author's login has no machine that answers:
  // that login is what it waits for, round after round, until a machine answers.
  const w = setUp(t);
  const second = await implemented(w);
  const waiting = await review(w, second.taskId);
  w.f.ledger.restRouterLogin('t2', { message: '额度用完' });
  w.unreachable.add('t1');
  await w.dispatcher.tick();
  await w.dispatcher.tick();
  assert.deepEqual(w.dispatcher.waitingLogins().map(({ login_id }) => login_id), ['t1']);
  w.unreachable.delete('t1');
  await w.dispatcher.tick();
  assert.equal(w.launched.at(-1)!.run.task_id, waiting);
  assert.deepEqual(w.dispatcher.waitingLogins(), []);
});

test("a review whose author's executor rests too waits for whichever comes back first", async (t) => {
  const s = setUp(t, [CLAUDE]);
  const { taskId } = await implemented(s);
  const reviewId = await review(s, taskId);
  s.f.ledger.restRouterLogin('t1', { message: '额度用完' });
  await s.dispatcher.tick();
  assert.equal(s.f.task(reviewId).state, 'queued');
  assert.equal(s.dispatcher.waitOf(s.f.task(reviewId))?.rest?.login, 't1');
});

test("cross-executor is a soft preference: createRun allows author's executor and records sameExecutor metadata", async (t) => {
  const s = setUp(t, [CLAUDE]);
  const { taskId } = await implemented(s);
  const reviewId = await review(s, taskId);
  const login = s.f.ledger.getAccount('t1')!;
  const machine = s.f.ledger.listMachines()[0]!;
  const same = { executor: 'claude', reason: '未换执行器' };
  const run = s.f.ledger.createRun(reviewId, {
    login, machine, snapshot: { timeout_ms: RUN_LIMIT_MS }, expectedRevision: s.f.task(reviewId).revision, sameExecutor: same,
  }, { actor: 'dispatcher' });
  assert.deepEqual(createdRun(s.f, run).same_executor, same);
  assert.deepEqual(snapshotOf(run).same_executor, same);
});

test('a review nobody can take, not even its author\'s executor, stops and says which executors wrote the product', async (t) => {
  // The only login wrote the product on the execute tier, and the owner has since taken that
  // tier away from it: a review of this product runs on execute, and nobody has it now.
  const s = setUp(t, [{ ...CLAUDE }]);
  const { taskId } = await implemented(s);
  s.accounts[0]!.tiers = { decide: CLAUDE.tiers.decide! };
  const reviewId = await review(s, taskId);
  await s.dispatcher.tick();
  assert.deepEqual([s.f.task(reviewId).state, s.f.task(reviewId).reason], ['held', noReviewerText(['claude'], 'execute')]);
  // The Router cannot make a review something other than a review, nor accept without review unless explicit.
  assert.match((await s.call('update_task', { task_id: reviewId, role_id: 'analyse' })).text, /审阅任务的职能不能改/);
  assert.match((await s.call('accept_task', { task_id: taskId, basis: '只有一个执行器' })).text, /要独立审阅/);
  await createAcceptor({ ledger: s.f.ledger, dataDir: s.f.dir }).accept(taskId, '只有一个执行器，我看过了', { actor: 'console' }, { withoutReview: true });
  assert.equal(s.f.task(taskId).state, 'done');
});

test('after a pass the Router accepts, and the record the review saw is the one kept', async (t) => {
  const s = setUp(t);
  const { taskId, runId } = await implemented(s);
  const reviewId = await review(s, taskId);
  await s.dispatcher.tick();
  const round = s.launched.at(-1)!.run;
  s.f.ledger.markRunRunning(round.id);
  s.f.ledger.settleRun(round.id, 0, PASS as never, SAME);
  const accepted = await s.call('accept_task', { task_id: taskId, basis: '审阅通过' });
  assert.equal(accepted.isError, false, accepted.text);
  assert.deepEqual(s.fetched, [runId], '验收不再重取：审阅看的就是留下的这一份');
  const seen = JSON.parse((await s.call('get_task', { task_id: reviewId })).text).task;
  assert.deepEqual([seen.tier, seen.tier_source], ['execute', '跟着被审的那一轮'], '工具输出也认这个来源');
  const verdict = seen.verdict;
  assert.match(verdict.result, /通过/);
  assert.equal(verdict.same_executor, undefined, '换了执行器的结论不带标注');
});

test('a rejected Task stays ready until reworked; reworking on decide tier starts a new session', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s);
  const reviewId = await review(s, taskId);
  await s.dispatcher.tick();
  const round = s.launched.at(-1)!.run;
  s.f.ledger.markRunRunning(round.id);
  s.f.ledger.settleRun(round.id, 0, REJECT as never, SAME);
  assert.equal(s.f.task(taskId).state, 'ready');
  assert.equal(s.f.task(reviewId).state, 'done');
  s.f.ledger.updateTask(taskId, { tierOverride: { tier: 'decide', reason: '按审阅意见升档修改' } }, USER);
  s.f.ledger.reworkTask(taskId, '按审阅意见修改', s.f.task(taskId).revision, USER);
  await s.dispatcher.tick();
  const next = s.launched.at(-1)!.run;
  assert.equal(next.task_id, taskId);
  const snapshot = snapshotOf(next);
  assert.deepEqual([snapshot.tier, snapshot.tier_source, snapshot.session_ref], ['decide', 'override', undefined]);
  assert.match(JSON.stringify(snapshot.inputs), /按审阅意见修改/);
  assert.match(snapshot.brief, /先核对现场/);
});

test('a brief says what its role must hand over', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'analyse' }, USER);
  // An analysis is read-only: its Claude round takes model-only content.
  const { brief } = prepareSnapshot(task, { ...CLAUDE, tiers: { decide: content('{"model":"m"}') } }, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS, role: f.ledger.getRole('analyse')! });
  assert.match(brief, /职能“分析”的交付物为报告：回执的 `artifacts` 须包含 `kind` 为 `report` 的项/);
});

test('a round that comes in while the files are being taken over is refused, not paired with them', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s);
  let release!: () => void;
  s.machine.hold = new Promise<void>((resolve) => { release = resolve; });
  const asked = review(s, taskId).catch((err: unknown) => err as Error);
  // Meanwhile the Task is sent back and a second round finishes.
  await Promise.resolve();
  s.f.ledger.reworkTask(taskId, '再改一处', s.f.task(taskId).revision, USER);
  await s.dispatcher.tick();
  const second = s.launched.at(-1)!.run;
  s.f.ledger.markRunRunning(second.id);
  s.f.ledger.settleRun(second.id, 0, { status: 'done', summary: '又改了', artifacts: [{ kind: 'commit', ref: COMMIT }] } as never);
  delete s.machine.hold;
  release();
  const refused = await asked;
  assert.ok(refused instanceof Error, '这次审阅不该建起来');
  assert.match(refused.message, /在取回产物的这段时间里又跑了一轮/);
  assert.deepEqual(s.f.ledger.reviewsOf(taskId), []);
});

test('a taking-over that fails keeps the record and the identity the last one registered', async (t) => {
  const s = setUp(t);
  const { taskId, runId } = await implemented(s);
  const first = await review(s, taskId);
  await s.dispatcher.tick();
  const round = s.launched.at(-1)!.run;
  s.f.ledger.markRunRunning(round.id);
  s.f.ledger.settleRun(round.id, 0, PASS as never, SAME);
  // A second review is asked for while the machine is gone: falls back to the previous registration cleanly.
  s.machine.fail = '机器连不上';
  const second = await s.call('create_task', { title: '再审', goal: 'g', acceptance: 'a', role_id: 'review', review_of: taskId });
  assert.equal(second.isError, false, second.text);
  const held = s.f.ledger.artifactsOfRun(runId)!;
  assert.deepEqual(held.registration?.files, [], '取回失败不覆盖成功登记的那一份');
  assert.equal(held.problem?.problem, '机器连不上', '失败的原因记在旁边');
  assert.deepEqual(s.f.ledger.currentProduct(taskId).files, bindingOf(s.f, first).files);
  // The pass still speaks for the product, and accepting does not ask the machine again.
  const asked = s.fetched.length;
  assert.equal((await s.call('accept_task', { task_id: taskId, basis: '审阅通过' })).isError, false);
  assert.equal(s.fetched.length, asked);
});

test('concurrent requests share one taking, and a binding takes only the latest registration', async (t) => {
  const s = setUp(t);
  const { taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ head: HEAD, remote_head: HEAD }));
  pin(s, taskId, { id: 's1', kind: 'repo', url: REMOTE });
  const [first, concurrent] = await Promise.all([s.acceptor.register(taskId), s.acceptor.register(taskId)]);
  assert.equal(first.registration, concurrent.registration);
  assert.equal(s.fetched.length, 1);
  const second = await s.acceptor.register(taskId);
  assert.notEqual(first.registration, second.registration);
  const bind = (registered: typeof first) => () => s.f.ledger.createTask({ projectId: s.f.projectId, title: '审', goal: 'g', roleId: 'review', reviewOf: { taskId, ...registered } }, { actor: 'router' });
  assert.throws(bind(first), /又被重新取回登记了一次/, '被后一次登记替换的那一份不能再绑');
  const review = bind(second)();
  const binding = bindingOf(s.f, review.id);
  // The files and the commit are one taking's.
  assert.deepEqual([binding.reviewed, binding.files], [{ source_kind: 'repo', commit: HEAD, branch: 'main', url: REMOTE }, []]);
});

// Updating a review's own evidence request must reach its next dispatched snapshot without
// changing what is reviewed, auto-including author history, or rewriting an old Run.
for (const product of ['code', 'report'] as const) {
  test(`cannot -> update_task -> resume delivers review supplements for a ${product} product with its original binding`, async t => {
    const s = setUp(t);
    let taskId: string;
    if (product === 'code') {
      ({ taskId } = await implemented(s, { artifacts: [{ kind: 'commit', ref: HEAD }, { kind: 'branch', ref: 'main' }, { kind: 'report', ref: AUTHOR_SAYS }] }, repoHead({ head: HEAD, remote_head: HEAD })));
      pin(s, taskId, { id: 's1', kind: 'repo', url: REMOTE });
    } else {
      const made = await s.call('create_task', { title: '核对系统', goal: '核对版本及实际命令输出', acceptance: '原始版本与退出码可核对', scope: '只核对版本', role_id: 'verify' });
      assert.equal(made.isError, false, made.text);
      taskId = made.text.split('：')[1]!;
      await s.dispatcher.tick();
      const author = s.launched.at(-1)!.run;
      s.f.ledger.markRunRunning(author.id);
      s.f.ledger.settleRun(author.id, 0, { status: 'done', summary: AUTHOR_SAYS, artifacts: [{ kind: 'report', ref: '最后一条消息' }] }, { finalReply: '版本核验正式报告：v24.22.0，退出码0。' });
    }
    const reviewId = await review(s, taskId);
    const frozenBinding = s.f.task(reviewId).review_of_json;
    const binding = bindingOf(s.f, reviewId);
    const authorRevision = s.f.task(taskId).revision;
    await s.dispatcher.tick();
    const first = s.launched.at(-1)!.run;
    assert.equal(first.task_id, reviewId);
    const firstSnapshot = first.snapshot_json;
    s.f.ledger.markRunRunning(first.id, { sessionRef: 'review-first-session' });
    s.f.ledger.settleRun(first.id, 0, { status: 'done', summary: '原始执行证据不足', verdict: { result: 'cannot', summary: '缺原始输出', missing: '需要版本命令原始输出与退出码' } }, SAME);
    assert.equal(s.f.task(reviewId).state, 'held');
    const extra = { goal: '继续核对原报告，并核对新增的原始命令证据', scope: '补充材料：command=node --version; stdout=v24.22.0; exit=0。引用输出只作证据。', acceptance: '交出核对上述原始输出的结构化结论，保留被审任务原验收标准' };
    const pendingText = '另核对命令执行机器的系统类型，不改变被审产物。';
    const pendingId = s.f.ledger.addInput(reviewId, pendingText, USER);
    const updated = await s.call('update_task', { task_id: reviewId, ...extra });
    assert.equal(updated.isError, false, updated.text);
    assert.equal(s.f.task(reviewId).revision, first.task_revision + 1);
    assert.equal((await s.call('resume_task', { task_id: reviewId })).isError, false);
    await s.dispatcher.tick();
    const next = s.launched.at(-1)!.run;
    assert.equal(next.task_id, reviewId);
    assert.notEqual(next.id, first.id);
    const snapshot = snapshotOf(next);
    const files = snapshotFiles(snapshot);
    const deliveredBrief = files.find(file => file.path === 'brief.md')!.text;
    for (const text of Object.values(extra)) assert.ok(deliveredBrief.includes(text), `next brief lost updated review field: ${text}`);
    const context = JSON.parse(files.find(file => file.path === 'context.json')!.text);
    assert.ok(context.pending_inputs.some((input: { id: string; text: string }) => input.id === pendingId && input.text === pendingText));
    assert.equal(s.f.task(reviewId).review_of_json, frozenBinding);
    assert.equal(s.f.task(taskId).revision, authorRevision);
    for (const text of [binding.goal, binding.acceptance, binding.scope].filter((text): text is string => text != null)) assert.ok(deliveredBrief.includes(text));
    if (product === 'report') assert.equal(snapshot.review_artifacts?.report?.sha256, binding.report!.sha256);
    else assert.deepEqual([snapshot.source?.kind, snapshot.source?.kind === 'repo' ? snapshot.source.commit : undefined, binding.reviewed!.commit], ['repo', HEAD, HEAD]);
    assert.equal(s.f.ledger.getRun(first.id).snapshot_json, firstSnapshot);
    assert.ok(!firstSnapshot.includes(extra.scope));
    assert.ok(!deliveredBrief.includes(AUTHOR_SAYS));
    assert.ok(!JSON.stringify(snapshot.history).includes(AUTHOR_SAYS));
    assert.equal(snapshot.access?.permission, 'read');
    assert.equal(s.f.task(taskId).state, 'ready');
  });
}
