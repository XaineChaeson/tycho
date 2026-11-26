// Guards against a round being handed knowledge other than what is in force for its project
// and role (docs/design/knowledge-and-skills.md §4.1): an entry of another project, or one
// narrowed to another role, in its brief; the brief listing them out of the order the design
// gives, or a snapshot that does not say which revisions it carried; a round that would carry
// more than the limits allow being opened with part of it cut off, or stopped without saying
// what is over; a round prepared on one set of revisions and created after the set changed,
// so that it belongs to neither; a retirement rewriting the snapshot or brief of a round that
// already ran with the entry; and a session that read a rule since revised or retired being
// continued, so that the old rule goes on in it. And against a gate round handed anything
// but its proposal and the entries it touches or resembles, or run on the executor that wrote
// the proposal. And against a round that reads anything but
// its snapshot: an on-demand body left out of its files, put in its brief, or not recorded with
// how it was loaded; an entry for a set of projects missing from one of them or reaching a
// project outside it; a limit judged on what is stored rather than on what a round is given;
// and a change of loading alone not starting the executor afresh. And against a gate or curation
// task run as if it belonged to a project (§3): taking the project's logins instead of the
// knowledge logins, ordering them by `knowledge.logins` instead of the tier's global order,
// going to a machine some project its material comes from does not allow, or
// anywhere at all when those projects share no machine; a gate handed an entry of a project
// outside them; a gate whose proposal stopped waiting for it sent out all the same, carrying what
// the proposal pinned to machines the entry's new projects allow; a pin outside the knowledge
// logins, or one the list was narrowed past, run instead of stopping with why; and
// waiting silently in the queue on a role turned writable instead of stopping and saying why.
// A fixed-input gate also needs a node that can keep Tycho's live knowledge out of its run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { Runner } from '../runner/runner.ts';
import type { Account, Snapshot } from '../runner/snapshot.ts';
import { prepareSnapshot, snapshotFiles } from '../runner/snapshot.ts';
import type { Ctx } from '../service/db.ts';
import { createDispatcher, type DispatcherOptions } from '../service/dispatcher.ts';
import { DEFAULT_KNOWLEDGE_LIMITS, type KnowledgeLimits, type Proposer } from '../service/knowledge.ts';
import { knowledgeOverLimit, knowledgeTaskMaterial } from '../service/knowledge-brief.ts';
import type { Ledger, RunRow } from '../service/ledger.ts';
import { claudeTier, content, DISPATCH_TUNED, DONE, fixture, memoryLogins, readOnlyEverywhere, tune, tuned, USER, holdMachine, testMachine, uidsOf } from './helpers.ts';

const OWNER: Ctx = { actor: 'console' };
const OWNER_SAYS: Proposer = { source: 'console', by: 'console', client: 'console', writers: [] };
const WHY = { when: '何时', changes: '改什么', generalizes: '依据和边界' };
const ACCOUNT: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };

// An entry in force, as the owner's own change makes one: at once, with no gate. A revision
// names the entry and the revision it is based on.
function publish(ledger: Ledger, fields: Record<string, unknown> & { revises?: { id: string; revision: number } }): { id: string; revision: number } {
  const { revises, ...output } = fields;
  ledger.propose({
    ...(revises ? { inputs: [{ knowledge_id: revises.id, revision: revises.revision, disposition: 'revise' }] } : {}),
    outputs: [{ title: '标题', when_to_use: '何时', body: '正文', project_ids: null, loading: 'resident', ...output, ...(revises ? { revises: revises.id } : {}) }],
    why: WHY, evidence: [{ source: 'file', location: 'notes.md', excerpt: '摘录' }],
  }, OWNER_SAYS, OWNER);
  const entry = revises ? ledger.getEntry(revises.id)! : ledger.listEntries({ includeRetired: true }).at(-1)!;
  return { id: entry.id, revision: entry.revision };
}

function setup(t: TestContext, options: {
  limits?: () => KnowledgeLimits;
  findMachine?: Runner['findMachine'];
  logins?: Record<string, Account>;
  knowledgeLogins?: () => readonly string[];
  placement?: Pick<DispatcherOptions, 'executors' | 'reported' | 'reportedEntry' | 'externalEntryEnabled'>;
} = {}) {
  const f = fixture(t, options.knowledgeLogins ? { knowledgeLogins: options.knowledgeLogins } : {});
  const launched: RunRow[] = [];
  const logs: string[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    runner: {
      findMachine: options.findMachine ?? (async (_login, machines) => machines[0]),
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => {
        launched.push(run);
      },
      watch: async (_run, watching = {}) => {
        await new Promise<void>((resolve) => {
          if (watching.signal?.aborted) resolve();
          watching.signal?.addEventListener('abort', () => resolve());
        });
      },
    },
    logins: memoryLogins({ t1: ACCOUNT, ...options.logins }, f.ledger),
    // Every machine reports the read-only way that a gate round, an analysis, runs by.
    ...readOnlyEverywhere({ get: (id) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() }),
    executors: { claude: claudeAdapter },
    ...options.placement,
    ...(options.limits ? { knowledgeLimits: options.limits } : {}),
    intervalMs: 10,
    watchIntervalMs: 7,
    log: (line) => logs.push(line),
  });
  t.after(() => dispatcher.stop());
  const queued = (roleId = 'implement') => {
    const task = f.ledger.createTask({ projectId: f.projectId, title: '任务', goal: '目标', acceptance: '测试通过', loginId: 't1', roleId }, USER);
    f.ledger.queueTask(task.id, USER);
    return f.task(task.id);
  };
  const snapshotOf = (run: RunRow) => JSON.parse(f.run(run.id).snapshot_json) as Snapshot;
  const finish = (run: RunRow, sessionRef: string) => {
    f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id, 0, DONE, { sessionRef });
    f.ledger.reworkTask(run.task_id, '接着做', f.task(run.task_id).revision, USER);
  };
  return { f, dispatcher, launched, logs, queued, snapshotOf, finish };
}

test('a round gets the knowledge of its project and role, global first, any role before its own, and records the revisions', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf } = setup(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  const roleOnly = publish(f.ledger, { title: '全局·只给实现', body: '全局实现正文', roles: ['implement'] });
  const global = publish(f.ledger, { title: '全局通用', body: '全局通用正文' });
  const reviewOnly = publish(f.ledger, { title: '全局·只给审阅', body: '审阅正文', roles: ['review'] });
  const projectRole = publish(f.ledger, { title: '项目·只给实现', body: '项目实现正文', project_ids: [f.projectId], roles: ['implement'] });
  const project = publish(f.ledger, { title: '项目通用', body: '项目通用正文', project_ids: [f.projectId] });
  publish(f.ledger, { title: '别的项目的', body: '别的项目正文', project_ids: [other] });
  queued();
  await dispatcher.tick();
  const snapshot = snapshotOf(launched[0]!);
  assert.deepEqual(snapshot.knowledge!.map(({ id, revision }) => `${id}@${revision}`), [global, roleOnly, project, projectRole].map(({ id }) => `${id}@1`));
  const at = (text: string): number => {
    const index = snapshot.brief.indexOf(text);
    assert.ok(index >= 0, `brief 里应有：${text}`);
    return index;
  };
  const order = ['## 目标', '## 全局知识', '全局通用正文', '全局实现正文', '## 项目知识', '项目通用正文', '项目实现正文', '## 资料', '## 回执'].map(at);
  assert.deepEqual(order, order.toSorted((a, b) => a - b), '顺序：目标、全局、项目（不限职能在前）、技能、资料与回执');
  assert.ok(!snapshot.brief.includes('审阅正文') && !snapshot.brief.includes('别的项目正文'));
  assert.ok(snapshot.brief.includes(`${global.id}@1`), '每条带修订号');
  assert.ok(!snapshot.knowledge!.some(({ id }) => id === reviewOnly.id));
});

test('over a limit, the round still opens by downgrading resident entries or truncating oversized text with a notice', async (t) => {
  let limits: KnowledgeLimits = { ...DEFAULT_KNOWLEDGE_LIMITS, briefBytes: 600 };
  const { f, dispatcher, launched, queued, snapshotOf, finish } = setup(t, { limits: () => limits });
  const big = publish(f.ledger, { title: '很长的一条', body: '长'.repeat(300) });
  const task = queued();
  await dispatcher.tick();
  assert.equal(launched.length, 1);
  assert.equal(f.task(task.id).state, 'running');
  const firstSnap = snapshotOf(launched[0]!);
  assert.match(firstSnap.brief, /注意：.*转为按需目录/);
  assert.equal(firstSnap.knowledge!.find(({ id }) => id === big.id)?.loading, 'on_demand');

  // A limit lowered under an entry already published truncates the body instead of holding the task.
  finish(launched[0]!, 's1');
  limits = { ...DEFAULT_KNOWLEDGE_LIMITS, entryBytes: 100 };
  await dispatcher.tick();
  assert.equal(launched.length, 2);
  const secondSnap = snapshotOf(launched[1]!);
  assert.match(secondSnap.brief, /正文超出单条上限，已截断/);
  assert.match(secondSnap.brief, /…（已截断）/);

  // Back within the limits, the round carries the whole entry unmodified.
  finish(launched[1]!, 's2');
  limits = DEFAULT_KNOWLEDGE_LIMITS;
  await dispatcher.tick();
  assert.equal(launched.length, 3);
  const thirdSnap = snapshotOf(launched[2]!);
  assert.ok(thirdSnap.brief.includes('长'.repeat(300)));
  assert.equal(thirdSnap.knowledge!.find(({ id }) => id === big.id)?.loading, 'resident');
});

test('knowledge that changes while a round is being placed does not block the round, and the next one carries the new set', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf, finish } = setup(t);
  const entry = publish(f.ledger, { title: '会被修订的', body: '第一版规则' });
  queued();
  // The dispatcher reads the set once, to prepare the round; a revision lands right after
  // that read and before the Run is created.
  const realApplicable = f.ledger.applicable.bind(f.ledger);
  let reads = 0;
  f.ledger.applicable = (projectId, roleId) => {
    const read = realApplicable(projectId, roleId);
    reads += 1;
    if (reads === 1) {
      publish(f.ledger, { revises: entry, title: '会被修订的', body: '第二版规则' });
    }
    return read;
  };
  await dispatcher.tick();
  assert.equal(launched.length, 1);
  const first = snapshotOf(launched[0]!);
  assert.deepEqual(first.knowledge!.map(({ revision }) => revision), [1]);
  assert.ok(first.brief.includes('第一版规则'));

  finish(launched[0]!, 's1');
  await dispatcher.tick();
  assert.equal(launched.length, 2);
  const second = snapshotOf(launched[1]!);
  assert.deepEqual(second.knowledge!.map(({ revision }) => revision), [2]);
  assert.ok(second.brief.includes('第二版规则') && !second.brief.includes('第一版规则'));
});

test('retiring an entry leaves the rounds that used it as they were, and later rounds go without it', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf, finish } = setup(t);
  const entry = publish(f.ledger, { title: '要退役的', body: '旧规则', project_ids: [f.projectId] });
  queued();
  await dispatcher.tick();
  const before = f.run(launched[0]!.id).snapshot_json;
  finish(launched[0]!, 's1');
  f.ledger.retireEntry(entry.id, { reason: '反例推翻了它', revision: 1 }, OWNER);
  assert.equal(f.run(launched[0]!.id).snapshot_json, before, '用过它的那一轮快照不改');
  assert.ok((JSON.parse(before) as Snapshot).brief.includes('旧规则'));
  assert.equal(f.ledger.readRevision(entry.id, 1)!.body, '旧规则');
  await dispatcher.tick();
  const after = snapshotOf(launched[1]!);
  assert.deepEqual(after.knowledge, []);
  assert.ok(!after.brief.includes('旧规则'));
});

test('editing or retiring knowledge does not break warm session resume while updating the round snapshot', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf, finish } = setup(t);
  const entry = publish(f.ledger, { title: '规则', body: '第一版规则' });
  queued();
  await dispatcher.tick();
  finish(launched[0]!, 's1');
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[1]!).session_ref, 's1', '集合没变继续用会话');
  finish(launched[1]!, 's2');
  publish(f.ledger, { revises: entry, title: '规则', body: '第二版规则' });
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[2]!).session_ref, 's2', '修订后保持热会话');
  assert.deepEqual(snapshotOf(launched[2]!).knowledge!.map(({ revision }) => revision), [2]);
  finish(launched[2]!, 's3');
  f.ledger.retireEntry(entry.id, { reason: '不用了', revision: 2 }, OWNER);
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[3]!).session_ref, 's3', '退役后保持热会话');
  assert.deepEqual(snapshotOf(launched[3]!).knowledge, []);
});

test('a publication during a running round keeps its pinned file and the next round uses the new revision', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf } = setup(t);
  const entry = publish(f.ledger, { body: 'first rule', loading: 'on_demand', project_ids: [f.projectId] });
  queued();
  await dispatcher.tick();
  const old = launched[0]!;
  f.ledger.markRunRunning(old.id);
  const oldFile = snapshotFiles(snapshotOf(old)).find(({ path }) => path === `knowledge/${entry.id}@1.md`)!;
  publish(f.ledger, { revises: entry, body: 'second rule', loading: 'on_demand', project_ids: [f.projectId] });
  assert.equal(f.run(old.id).state, 'running');
  assert.deepEqual(snapshotFiles(snapshotOf(old)).find(({ path }) => path === oldFile.path), oldFile);
  assert.match(oldFile.text, /first rule/);
  f.ledger.settleRun(old.id, 0, DONE, { sessionRef: 'session-v1' });
  f.ledger.reworkTask(old.task_id, '接着做', f.task(old.task_id).revision, USER);
  await dispatcher.tick();
  const next = snapshotOf(launched[1]!);
  assert.equal(next.session_ref, 'session-v1');
  assert.match(snapshotFiles(next).find(({ path }) => path === `knowledge/${entry.id}@2.md`)!.text, /second rule/);
});

test('a Codex knowledge curation dispatches cleanly even when global entry projection is enabled, recording machine inputs transparently', async (t) => {
  const codex = { id: 'g2', name: 'g2', executor: 'codex', tiers: { decide: content('model="m"') } };
  const { f, dispatcher, launched, snapshotOf } = setup(t, {
    logins: { g2: codex },
    knowledgeLogins: () => [codex.id],
    placement: {
      executors: { codex: codexAdapter, claude: claudeAdapter },
      reported: (_machine, executor) => ({
        executor, installed: true, version: 'codex-cli 0.167.1', logged_in: true,
        read_only: { available: true, layer: 'filesystem', checks_code: true },
        config: [{ kind: 'mcp', names: [] }],
        asked_at: '2026-11-11T09:00:00.000Z',
      }),
      externalEntryEnabled: () => true,
      reportedEntry: () => ({
        digest: 'abcd', at: '2026-11-11T09:00:00.000Z',
        executors: [{ executor: 'codex', path: '/.codex/AGENTS.md', state: 'written',
          projection: { state: 'present', revisions: ['old@1'] } }],
      }),
    },
  });
  const entry = publish(f.ledger, { title: '新规约', when_to_use: '测试时', body: '正文', loading: 'on_demand', project_ids: [f.projectId] });
  const taskId = f.ledger.curate({ entries: [entry.id], reason: '需要整理' }, OWNER);
  await dispatcher.tick();
  assert.equal(f.task(taskId).state, 'running');
  assert.equal(launched.length, 1);
  const snap = snapshotOf(launched[0]!);
  assert.equal(snap.machine_inputs?.external_entry?.state, 'present');
  assert.equal(snapshotFiles(snap).find(({ path }) => path === 'fixed-knowledge.json'), undefined);
});

test('owner can approve or reject awaiting_owner (global + resident) proposals directly', async (t) => {
  const { f } = setup(t);
  const changeA = {
    outputs: [{ title: '提议甲', when_to_use: '场景甲', body: '正文甲', loading: 'resident' as const, project_ids: null }],
    why: WHY, evidence: [{ source: 'file' as const, location: 'a.md', excerpt: '摘录甲' }],
  };
  const a = f.ledger.propose(changeA, { source: 'mcp', by: '外部会话', client: 'mcp:c1', writers: ['claude'] }, OWNER);
  assert.equal(a.state, 'awaiting_owner');
  const beforeA = f.ledger.getProposal(a.id);
  const resA = f.ledger.decideProposal(a.id, { decision: 'reject', digest: beforeA.final_digest!, note: '不需要', via: 'console' }, USER);
  assert.equal(resA.state, 'rejected');
  assert.equal(f.ledger.getProposal(a.id).state, 'rejected');

  const changeB = {
    outputs: [{ title: '提议乙', when_to_use: '场景乙', body: '正文乙', loading: 'resident' as const, project_ids: null }],
    why: WHY, evidence: [{ source: 'file' as const, location: 'b.md', excerpt: '摘录乙' }],
  };
  const b = f.ledger.propose(changeB, { source: 'mcp', by: '外部会话', client: 'mcp:c1', writers: ['claude'] }, OWNER);
  assert.equal(b.state, 'awaiting_owner');
  const resB = f.ledger.decideProposal(b.id, { decision: 'approve', via: 'console' }, USER);
  assert.equal(resB.state, 'published');
  assert.equal(f.ledger.getProposal(b.id).state, 'published');
});

// A round reads only its snapshot (§4.1): resident entries in full in the brief, on-demand ones
// as a catalog in the brief that points at files the snapshot carries, each revision recorded
// with how it was loaded.
test('an on-demand entry reaches the round as a file of its snapshot, and the brief lists it without its text', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf } = setup(t);
  const resident = publish(f.ledger, { title: '常驻的', body: '常驻正文' });
  const onDemand = publish(f.ledger, { title: '按需的', when_to_use: '读历史逐笔时', body: '按需正文', loading: 'on_demand' });
  const projectOnDemand = publish(f.ledger, { title: '项目按需的', when_to_use: '调 cache 时', body: '项目按需正文', loading: 'on_demand', project_ids: [f.projectId] });
  queued();
  await dispatcher.tick();
  const snapshot = snapshotOf(launched[0]!);
  assert.deepEqual(snapshot.knowledge!.map(({ id, revision, loading }) => [id, revision, loading]), [
    [resident.id, 1, 'resident'], [onDemand.id, 1, 'on_demand'], [projectOnDemand.id, 1, 'on_demand'],
  ]);
  assert.ok(snapshot.brief.includes('常驻正文'));
  assert.ok(!snapshot.brief.includes('按需正文') && !snapshot.brief.includes('项目按需正文'), '按需的正文不进 brief');
  const files = new Map(snapshotFiles(snapshot).map(({ path, text }) => [path, text]));
  assert.ok(files.get(`knowledge/${onDemand.id}@1.md`)!.includes('按需正文'));
  assert.ok(files.get(`knowledge/${projectOnDemand.id}@1.md`)!.includes('项目按需正文'));
  assert.ok(!files.has(`knowledge/${resident.id}@1.md`), '常驻的已经在 brief 里，不另送文件');
  const at = (text: string): number => {
    const index = snapshot.brief.indexOf(text);
    assert.ok(index >= 0, `brief 里应有：${text}`);
    return index;
  };
  const order = ['## 全局知识', '常驻正文', '## 按需知识', `按需的（${onDemand.id}@1）`, '读历史逐笔时', `knowledge/${onDemand.id}@1.md`, `项目按需的（${projectOnDemand.id}@1）`, '## 回执'].map(at);
  assert.deepEqual(order, order.toSorted((a, b) => a - b));
});

test('an entry for a set of projects reaches the rounds of each of them, and of no other', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf } = setup(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  const third = f.ledger.createProject({ name: '第三个' }, USER);
  const shared = publish(f.ledger, { title: '两个项目共用', body: '共用正文', project_ids: [f.projectId, other] });
  assert.deepEqual(f.ledger.applicable(other, 'implement').map(({ id }) => id), [shared.id]);
  assert.deepEqual(f.ledger.applicable(third, 'implement'), []);
  queued();
  await dispatcher.tick();
  const snapshot = snapshotOf(launched[0]!);
  assert.deepEqual(snapshot.knowledge!.map(({ id }) => id), [shared.id]);
  assert.match(snapshot.brief, /## 项目知识（试跑）[\s\S]*共用正文/);
});

// The limits are on what is generated (§4.1): an on-demand body counts towards the snapshot's
// files, not the brief; over the snapshot limit it is trimmed/omitted gracefully with a notice.
test('an on-demand body counts towards the snapshot limit and trims gracefully instead of holding the task', async (t) => {
  let limits: KnowledgeLimits = { ...DEFAULT_KNOWLEDGE_LIMITS, briefBytes: 2000, snapshotBytes: 1000 };
  const { f, dispatcher, launched, queued, snapshotOf, finish } = setup(t, { limits: () => limits });
  const big = publish(f.ledger, { title: '长的按需条目', body: '长'.repeat(500), loading: 'on_demand' });
  queued();
  await dispatcher.tick();
  assert.equal(launched.length, 1);
  const firstSnap = snapshotOf(launched[0]!);
  assert.match(firstSnap.brief, /快照知识文件超出上限，已截断或省略/);
  const trimmedFile = snapshotFiles(firstSnap).find(({ path }) => path === `knowledge/${big.id}@1.md`);
  assert.ok(trimmedFile === undefined || Buffer.byteLength(trimmedFile.text, 'utf8') <= 1000);
  // Advisory diagnostic still accurately reports snapshot over-limit without complaining about brief.
  const entries = f.ledger.applicable(f.projectId, 'implement');
  const diag = knowledgeOverLimit(entries, '', limits)!;
  assert.match(diag, /快照里的知识与技能文件合计 [\d.]+ KiB，超过上限 1\.0 KiB/);
  assert.ok(diag.includes(`${big.id}@1“长的按需条目”`));
  assert.ok(!diag.includes('说明里'), 'brief 没有超');

  finish(launched[0]!, 's1');
  limits = { ...DEFAULT_KNOWLEDGE_LIMITS, briefBytes: 2000 };
  await dispatcher.tick();
  assert.equal(launched.length, 2, '正文 1.5 KiB 不算进 brief');
  const fullFile = snapshotFiles(snapshotOf(launched[1]!)).find(({ path }) => path === `knowledge/${big.id}@1.md`)!;
  assert.ok(fullFile.text.includes('长'.repeat(500)));
});

test('a revision that only changes how an entry is loaded updates the snapshot while preserving warm session resume', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf, finish } = setup(t);
  const entry = publish(f.ledger, { title: '规则', body: '规则正文' });
  queued();
  await dispatcher.tick();
  finish(launched[0]!, 's1');
  await dispatcher.tick();
  assert.equal(snapshotOf(launched[1]!).session_ref, 's1');
  finish(launched[1]!, 's2');
  publish(f.ledger, { revises: entry, title: '规则', body: '规则正文', loading: 'on_demand' });
  await dispatcher.tick();
  const third = snapshotOf(launched[2]!);
  assert.equal(third.session_ref, 's2');
  assert.deepEqual(third.knowledge!.map(({ loading }) => loading), ['on_demand']);
});

// A curation round reads its material from snapshot files and reports its decision via knowledge_verdict.
test('a curation round is handed its entries and evidence as snapshot files with curation instructions', async (t) => {
  const { f, dispatcher, launched, snapshotOf } = setup(t, { logins: { g1: { id: 'g1', name: 'g1', executor: 'claude', tiers: { decide: content('{"model":"m"}') } } } });
  f.ledger.setProjectLogins(f.projectId, ['t1', 'g1'], USER);
  const entry = publish(f.ledger, { title: '先分解差距再转向', body: '把总差距拆成能乘回去的因子再决定方向', project_ids: [f.projectId], loading: 'on_demand' });
  f.ledger.curate({ entries: [entry.id], reason: '条目需要复查' }, OWNER);
  await dispatcher.tick();
  const snapshot = snapshotOf(launched[0]!);
  assert.equal(launched[0]!.login_id, 'g1');
  assert.equal(snapshot.knowledge_task?.kind, 'curation');
  const files = new Map(snapshotFiles(snapshot).map(({ path, text }) => [path, text]));
  assert.ok(files.get(`knowledge-task/entries/${entry.id}@1.md`)!.includes('把总差距拆成能乘回去的因子再决定方向'));
  assert.ok(files.has(`knowledge-task/entries/${entry.id}@1.evidence.json`));
  assert.match(snapshot.brief, /## 整理材料[\s\S]*条目需要复查[\s\S]*knowledge_verdict/);
});

// The snapshot limit counts everything knowledge sends with a round (§4.1, §5.3): ordinary
// on-demand knowledge, skills, and a gate's or curation's material alike; prepareSnapshot fits
// gracefully without throwing while knowledgeOverLimit reports each source's exact bytes.
test('a curation’s material counts towards the snapshot limit in diagnostics while prepareSnapshot fits gracefully', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);
  const material = { kind: 'curation' as const, files: [{ path: 'knowledge-task/entries/x@1.md', text: '材'.repeat(400) }], listing: '- 材料' };
  const limits = { ...DEFAULT_KNOWLEDGE_LIMITS, snapshotBytes: 1024 };
  const diag = knowledgeOverLimit([], '', limits, material);
  assert.match(
    diag ?? '',
    /快照里的知识与技能文件合计 1\.2 KiB，超过上限 1\.0 KiB（按需知识 0\.0 KiB、技能 0\.0 KiB、整理材料 1\.2 KiB）/,
  );
  const snap = prepareSnapshot(task, ACCOUNT, { claude: claudeAdapter }, { timeoutMs: 60_000, knowledge: { entries: [], projectName: '试跑', limits }, knowledgeTask: material });
  assert.equal(snap.knowledge_task?.kind, 'curation');
});

// Two logins that can run knowledge tasks (decide tier, read-only), and the project's own one,
// which cannot: a knowledge task's logins are the knowledge logins, never the project's (§3).
const GATES = {
  g1: { id: 'g1', name: 'g1', executor: 'claude', tiers: { decide: content('{"model":"m"}') } },
  g2: { id: 'g2', name: 'g2', executor: 'claude', tiers: { decide: content('{"model":"m"}') } },
};
const mcp = (writers: string[]): Proposer => ({ source: 'mcp', by: '外部会话', client: 'mcp:c1', writers });
const change = (fields: Record<string, unknown> = {}) => ({
  outputs: [{ title: '差距要先分解', when_to_use: '要换方向时', body: '把总差距拆成能乘回去的因子', project_ids: null, loading: 'on_demand', ...fields }],
  why: WHY, evidence: [{ source: 'file', location: 'notes.md', excerpt: '摘录' }],
});

test('a knowledge task runs as the knowledge logins — all of the owner’s when none are named — in the tier’s global order, never as its project’s', async (t) => {
  let named: readonly string[] = [];
  const { f, dispatcher, launched } = setup(t, { logins: GATES, knowledgeLogins: () => named });
  // The project allows only t1, which has no decide tier: a task of the project could not run.
  f.ledger.setProjectLogins(f.projectId, ['t1'], USER);
  // The tier's global order decides which knowledge login goes first, as for any other Task.
  tune(f.ledger, 'dispatch.order.decide', ['g2', 'g1']);
  const e1 = publish(f.ledger, { title: '第一条', project_ids: null, loading: 'on_demand' });
  const first = f.ledger.curate({ entries: [e1.id], reason: '整理一' }, OWNER);
  await dispatcher.tick();
  assert.deepEqual(launched.map(({ login_id }) => login_id), ['g2'], '没指定时主人所有的登录都能用，按全局顺序先找 g2');
  // `knowledge.logins` only says which may take a knowledge task: g2 is outside it now.
  named = ['g1'];
  const e2 = publish(f.ledger, { title: '第二条', project_ids: null, loading: 'on_demand' });
  f.ledger.curate({ entries: [e2.id], reason: '整理二' }, OWNER);
  await dispatcher.tick();
  assert.deepEqual(launched.map(({ login_id }) => login_id), ['g2', 'g1'], '设置只定范围，先找谁仍按全局顺序');
  assert.equal(f.task(first).project_id, null);
});

test('a knowledge task goes only to machines every project of its material allows, and stops when they share none', async (t) => {
  const { f, dispatcher, launched } = setup(t, { logins: GATES });
  holdMachine(f.ledger, testMachine('h2'), USER);
  holdMachine(f.ledger, testMachine('h3'), USER);
  const a = f.projectId;
  const b = f.ledger.createProject({ name: '乙项目' }, USER);
  const c = f.ledger.createProject({ name: '丙项目' }, USER);
  f.ledger.setProjectMachines(a, uidsOf(f.ledger, ['h1', 'h2']), USER);
  f.ledger.setProjectMachines(b, uidsOf(f.ledger, ['h2', 'h3']), USER);
  f.ledger.setProjectMachines(c, uidsOf(f.ledger, ['h1']), USER);
  const machineOf = (taskId: string) => launched.find(({ task_id }) => task_id === taskId)?.host;
  // Global entry: no project narrows it.
  const globalEntry = publish(f.ledger, { title: '全局', project_ids: null, loading: 'on_demand' });
  const globalTask = f.ledger.curate({ entries: [globalEntry.id], reason: '全局整理' }, OWNER);
  // Two projects: only the machine both allow.
  const bothEntry = publish(f.ledger, { title: '甲乙', project_ids: [a, b], loading: 'on_demand' });
  const bothTask = f.ledger.curate({ entries: [bothEntry.id], reason: '甲乙整理' }, OWNER);
  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual([machineOf(globalTask), machineOf(bothTask)], ['h1', 'h2']);
  // Two projects whose ranges share nothing: it stops and names them.
  const apartEntry = publish(f.ledger, { title: '乙丙', project_ids: [b, c], loading: 'on_demand' });
  const apartTask = f.ledger.curate({ entries: [apartEntry.id], reason: '乙丙整理' }, OWNER);
  const queued = f.task(apartTask);
  // The ledger refuses such a round as the dispatcher does not offer it.
  assert.throws(() => f.ledger.createRun(queued.id, { login: GATES.g1, machine: f.ledger.getMachine('h1')!, expectedRevision: queued.revision, snapshot: { brief: 'b', timeout_ms: 60_000 } }, USER), /没有交集/);
  await dispatcher.tick();
  const held = f.task(queued.id);
  assert.equal(held.state, 'held');
  assert.equal(held.reason, '没有能跑这个知识任务的机器：项目 乙项目（h2、h3）、丙项目（h1）允许的机器没有交集');
});

test('a curation task goes where the projects of its entries allow, and global material carries no entry of a project outside them', async (t) => {
  const { f, dispatcher, launched } = setup(t, { logins: GATES });
  holdMachine(f.ledger, testMachine('h2'), USER);
  const b = f.ledger.createProject({ name: '乙项目' }, USER);
  f.ledger.setProjectMachines(b, uidsOf(f.ledger, ['h2']), USER);
  const ofB = publish(f.ledger, { title: '乙的条目', body: '把总差距拆成能乘回去的因子再决定方向', project_ids: [b], loading: 'on_demand' });
  const curation = f.ledger.curate({ entries: [ofB.id], reason: '和别的冲突' }, OWNER);
  await dispatcher.tick();
  assert.deepEqual([f.task(curation).project_id, launched.at(-1)?.host], [null, 'h2']);
  assert.deepEqual(f.ledger.knowledgeTaskView(curation), { kind: 'curation', entries: [ofB.id], source_project_id: null, projects: [b] });
  // A global change from outside any project resembles every entry, but carries no project's
  // content: the look-alike of project 乙 is not handed to its material.
  const globalProp = f.ledger.propose(change({ title: '差距要先分解', loading: 'resident' }), mcp(['codex']), OWNER);
  const material = knowledgeTaskMaterial(f.ledger, { kind: 'gate', proposal_id: globalProp.id, writers: ['codex'] });
  const paths = material.files.map(({ path }) => path);
  assert.ok(!paths.some((path) => path.includes(ofB.id)), '别的项目的相近条目不进材料');
});

test('a knowledge task left on a role turned writable dispatches cleanly instead of holding', async (t) => {
  const { f, dispatcher, launched } = setup(t, { logins: GATES });
  const entry = publish(f.ledger, { title: '要整理的', project_ids: null, loading: 'on_demand' });
  const taskId = f.ledger.curate({ entries: [entry.id], reason: '需要整理' }, OWNER);
  const analyse = f.ledger.getRole('analyse')!;
  f.ledger.putRole({ ...analyse, permission: 'write', deliverable: 'report' }, USER);
  await dispatcher.tick();
  const task = f.task(taskId);
  assert.deepEqual([launched.length, task.state, task.reason], [1, 'running', null]);
});

test('a waiting awaiting_owner proposal goes stale when its pinned entry changes', async (t) => {
  const { f } = setup(t, { logins: GATES });
  const entry = publish(f.ledger, { title: '甲的条目', body: '甲的正文', project_ids: null, loading: 'resident' });
  const waiting = f.ledger.propose({
    inputs: [{ knowledge_id: entry.id, revision: entry.revision, disposition: 'revise' }],
    outputs: [{ revises: entry.id, title: '甲的条目', when_to_use: '何时', body: '等待主人确认的新版', project_ids: null, loading: 'resident' }],
    why: WHY,
    evidence: [{ source: 'file', location: 'a.md', excerpt: '依据' }],
  }, mcp(['codex']), OWNER);
  assert.equal(waiting.state, 'awaiting_owner');
  // While it waits, the owner revises the entry directly.
  publish(f.ledger, { title: '甲的条目', body: '主人改过的新版', project_ids: null, loading: 'resident', revises: entry });
  assert.equal(f.ledger.getProposal(waiting.id).state, 'stale');
  assert.throws(() => f.ledger.decideProposal(waiting.id, { decision: 'approve', via: 'console' }, OWNER), /依据的修订已变/);
});

test('a knowledge task pinned to a login the knowledge logins no longer name stops and says why', async (t) => {
  let named: readonly string[] = ['g1'];
  const { f, dispatcher, launched } = setup(t, { logins: GATES, knowledgeLogins: () => named });
  const entry = publish(f.ledger, { title: '要整理的', project_ids: null, loading: 'on_demand' });
  const taskId = f.ledger.curate({ entries: [entry.id], reason: '需要整理' }, OWNER);
  f.ledger.updateTask(taskId, { loginId: 'g1' }, USER);
  named = ['g2'];
  await dispatcher.tick();
  const task = f.task(taskId);
  assert.deepEqual([launched.length, task.state], [0, 'held']);
  assert.equal(task.reason, '账号 g1 不在知识任务用的登录里（设置“知识任务用哪些登录”）：改钉别的登录，或者取消钉住');
});
