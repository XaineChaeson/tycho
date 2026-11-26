// Guards a project's code sources as the ledger holds them (docs/design/code-sources.md §1,
// §2, §8): a Task pinned to the default or to a named source, the service naming every new
// item and refusing an id the project's list does not hold (a deleted one never comes back,
// an address carrying a secret is refused rather than stored stripped), a pin that reports
// current/changed/removed, a Task pinned to a source the project edited going on unchanged
// while a removed one stops with the reason, moving the pin bumping the revision and waiting
// for any round in flight (and for the owner's answer), a review inheriting the pin of the
// Task it reviews, the audit of a list edit, and the source input's own checks.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import type { Account } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { createLogins } from '../service/logins.ts';
import { openLedger } from '../service/ledger.ts';
import type { Source } from '../shared/sources.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import { claudeTier, content, fixture, LOGIN, RUN_LIMIT_MS, USER } from './helpers.ts';

const ROUTER = { actor: 'router' };
const TUNED = { runTimeoutMs: 1, lostGraceMs: 1, orphanGraceMs: 1, intervalMs: 1, routerIdleMs: 1, stopGraceMs: 1 };
const WROTE = { status: 'done', summary: '改好了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }] };
const FILES = [{ name: 'work.bundle', sha256: 'a'.repeat(64), bytes: 10 }];

function ledgerFor(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-sources-ledger-'));
  const path = join(dir, 'ledger.db');
  const ledger = openLedger(path, { log: () => {} });
  // Closed before the directory goes: Windows keeps a directory an open database stands in.
  t.after(async () => {
    ledger.close();
    for (let n = 0; n < 20; n += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });
  const peek = <T>(sql: string, ...params: string[]): T[] => {
    const conn = new DatabaseSync(path);
    try {
      return conn.prepare(sql).all(...params) as T[];
    } finally {
      conn.close();
    }
  };
  return { ledger, peek };
}

const repo = (url: string) => ({ kind: 'repo' as const, url });
const urlsOf = (sources: Source[]): (string | null)[] => sources.map((source) => (source.kind === 'repo' ? source.url : null));

// A machine's own login a Run may start on, and the machine it runs on: enough to hold a
// round in flight for the reassignment test.
const WORK_LOGIN: Account = {
  id: 't1', name: 't1', executor: 'claude',
  tiers: { execute: content('{"model":"m"}'), decide: content('{"model":"m"}') },
};

test('建任务钉来源：不填用默认，填了用那一项，不存在的 id 被拒', (t) => {
  const { ledger } = ledgerFor(t);
  const projectId = ledger.createProject({ name: '代码项目', sources: [repo('https://example.test/a.git'), repo('https://example.test/b.git')] }, USER);
  // The service names each new item itself: one ULID per item, not a position.
  const [a, b] = ledger.projectSources(projectId);
  assert.equal(a!.id.length, 26, '新项由服务编号');
  assert.notEqual(a!.id, b!.id);
  assert.deepEqual(urlsOf(ledger.projectSources(projectId)), ['https://example.test/a.git', 'https://example.test/b.git']);

  const first = ledger.createTask({ projectId, title: '第一件', goal: '目标', acceptance: '验收', roleId: 'implement' }, USER);
  assert.deepEqual(ledger.taskSource(first.id), { source_id: a!.id, pinned: a }, '不填就是第一项');
  const second = ledger.createTask({ projectId, title: '第二件', goal: '目标', acceptance: '验收', roleId: 'implement', sourceId: b!.id }, USER);
  assert.equal(ledger.taskSource(second.id)!.source_id, b!.id);
  assert.equal(ledger.taskSourceState(second.id), 'current');
  assert.throws(
    () => ledger.createTask({ projectId, title: '第三件', goal: '目标', acceptance: '验收', roleId: 'implement', sourceId: 'nope' }, USER),
    /没有这个代码来源：nope/,
  );

  // 项目一个来源都没有：任务不钉来源，也不因为没来源被拒。
  const emptyId = ledger.createProject({ name: '没有代码' }, USER);
  const loose = ledger.createTask({ projectId: emptyId, title: '空目录', goal: '目标', acceptance: '验收', roleId: 'implement' }, USER);
  assert.equal(ledger.taskSource(loose.id), null);
  assert.equal(ledger.sourceRefusal(ledger.getTask(loose.id)), undefined);
});

test('来源被改只提示、任务照钉住的快照走；被删才停住并说明', async (t) => {
  const { ledger } = ledgerFor(t);
  const projectId = ledger.createProject({ name: '代码项目', sources: [repo('https://example.test/a.git'), repo('https://example.test/b.git')] }, USER);
  const [s1, s2] = ledger.projectSources(projectId);
  const task = ledger.createTask({ projectId, title: '钉住第二项', goal: '目标', acceptance: '验收', roleId: 'implement', sourceId: s2!.id }, USER);
  ledger.queueTask(task.id, USER);

  // 第二项被改掉地址：同一个 id，内容不一样。下一轮仍按钉住的那份快照，不停住。
  ledger.setProjectSources(projectId, [s1!, { id: s2!.id, kind: 'repo', url: 'https://example.test/c.git' }], USER);
  assert.equal(ledger.taskSourceState(task.id), 'changed');
  assert.equal(ledger.sourceRefusal(ledger.getTask(task.id)), undefined, '来源被改只是提示，不停住');
  assert.deepEqual(ledger.taskSource(task.id), { source_id: s2!.id, pinned: s2 }, '钉住的快照不动');
  assert.equal(ledger.getTask(task.id).state, 'queued');

  // 删掉它钉住的来源：停住并说明，说明里带着它当时的样子。
  ledger.setProjectSources(projectId, [s1!], USER);
  assert.equal(ledger.taskSourceState(task.id), 'removed');
  assert.match(ledger.sourceRefusal(ledger.getTask(task.id))!, /已经不在项目里了（仓库 https:\/\/example\.test\/b\.git）/);
  const dispatcher = createDispatcher({
    ...TUNED,
    ledger,
    machines: { list: () => [], get: () => undefined, connected: () => false },
    executors: ADAPTERS,
    logins: createLogins({ ledger, accounts: { list: () => [], get: () => undefined }, executors: ADAPTERS }),
    runner: {
      findMachine: async () => undefined, launch: async () => {}, watch: async () => {},
      lostCandidates: () => [], presume: async () => 'unknown', sweep: async () => {},
    },
    log: () => {},
  } as unknown as Parameters<typeof createDispatcher>[0]);
  t.after(() => dispatcher.stop());
  await dispatcher.tick();
  assert.equal(ledger.getTask(task.id).state, 'held');
  assert.match(ledger.getTask(task.id).reason!, /改派到别的来源/);

  // 改派到第一项：钉住的快照换成它，任务可以继续。
  const moved = ledger.updateTask(task.id, { sourceId: s1!.id }, USER);
  assert.deepEqual(ledger.taskSource(task.id), { source_id: s1!.id, pinned: s1 });
  assert.equal(moved.source_json, JSON.stringify({ source_id: s1!.id, pinned: s1 }));
  assert.equal(ledger.taskSourceState(task.id), 'current');
  assert.equal(ledger.sourceRefusal(moved), undefined);
  ledger.resumeTask(task.id, USER);
  assert.equal(ledger.getTask(task.id).state, 'queued');
  // 改派到不存在的 id 被拒。
  assert.throws(() => ledger.updateTask(task.id, { sourceId: 'nope' }, USER), /没有这个代码来源：nope/);
});

test('改派来源算一次修订，并记下从哪一项到哪一项', (t) => {
  const f = fixture(t);
  const projectId = f.ledger.createProject({ name: '代码项目', sources: [repo('https://example.test/a.git'), repo('https://example.test/b.git')] }, USER);
  const [a, b] = f.ledger.projectSources(projectId);
  const task = f.ledger.createTask({ projectId, title: '活', goal: '目标', acceptance: '验收', roleId: 'implement', sourceId: a!.id }, USER);
  const before = f.task(task.id).revision;
  const moved = f.ledger.updateTask(task.id, { sourceId: b!.id }, USER);
  assert.equal(moved.revision, before + 1, '来源变了就是新的修订');
  assert.equal(JSON.parse(moved.source_json!).source_id, b!.id);
  const [row] = f.peek<{ detail_json: string }>("SELECT detail_json FROM change WHERE action = 'task.update' AND task_id = ? ORDER BY seq DESC LIMIT 1", task.id);
  const detail = JSON.parse(row!.detail_json) as { revision: number; source: { from: { source_id: string }; to: { source_id: string } } };
  assert.deepEqual([detail.revision, detail.source.from.source_id, detail.source.to.source_id], [before + 1, a!.id, b!.id]);
});

test('有未结束的轮次时不能改派来源，拒绝且什么都不写', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(WORK_LOGIN, USER, 'ref-t1');
  const projectId = f.ledger.createProject({ name: '代码项目', logins: ['t1'], sources: [repo('https://example.test/a.git'), repo('https://example.test/b.git')] }, USER);
  const [a, b] = f.ledger.projectSources(projectId);
  const task = f.ledger.createTask({ projectId, title: '活', goal: '目标', acceptance: '验收', roleId: 'implement', loginId: 't1', sourceId: a!.id }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(
    task.id,
    { login: WORK_LOGIN, machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', source: snapshotSourceOf(a!) }, expectedRevision: f.task(task.id).revision },
    USER,
  );
  f.ledger.markRunRunning(run.id);
  const before = f.dump();
  assert.throws(() => f.ledger.updateTask(task.id, { sourceId: b!.id }, USER), /未结束的 Run/);
  assert.deepEqual(f.dump(), before, '在跑时改派不写任何行');
  assert.equal(JSON.parse(f.task(task.id).source_json!).source_id, a!.id, '钉住的还是原来那一项');

  // 这一轮结束之后就可以改派。
  f.ledger.settleRun(run.id, 0, WROTE as never);
  assert.equal(JSON.parse(f.ledger.updateTask(task.id, { sourceId: b!.id }, USER).source_json!).source_id, b!.id);
});

test('审阅打回遗留问题存在时，负责人不再被锁定，仍可改派来源', (t) => {
  const f = fixture(t);
  const projectId = f.ledger.createProject({ name: '代码项目', sources: [repo('https://example.test/a.git'), repo('https://example.test/b.git')] }, USER);
  const [a, b] = f.ledger.projectSources(projectId);
  const task = f.ledger.createTask({ projectId, title: '活', goal: '目标', acceptance: '验收', roleId: 'implement', sourceId: a!.id }, USER);
  f.ledger.queueTask(task.id, USER);
  const approval = f.ledger.openApproval(task.id, [{ question: '怎么办？' }], USER);
  f.force('UPDATE approval SET review_task_id = ? WHERE id = ?', 'review-1', approval);
  f.ledger.updateTask(task.id, { sourceId: b!.id }, ROUTER);
  assert.equal(JSON.parse(f.task(task.id).source_json!).source_id, b!.id);
  // 主人同样可以改派。
  f.ledger.updateTask(task.id, { sourceId: a!.id }, USER);
  assert.equal(JSON.parse(f.task(task.id).source_json!).source_id, a!.id);
});

test('审阅任务继承被审任务钉住的来源，不能另选', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(WORK_LOGIN, USER, 'ref-t1');
  const projectId = f.ledger.createProject({ name: '代码项目', logins: ['t1'], sources: [repo('https://example.test/a.git'), repo('https://example.test/b.git')] }, USER);
  const [a, b] = f.ledger.projectSources(projectId);
  const work = f.ledger.createTask({ projectId, title: '做', goal: '目标', acceptance: '验收', roleId: 'implement', loginId: 't1', sourceId: b!.id }, USER);
  f.ledger.queueTask(work.id, USER);
  const revision = f.task(work.id).revision;
  const run = f.ledger.createRun(
    work.id,
    { login: WORK_LOGIN, machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', source: snapshotSourceOf(b!) }, expectedRevision: revision },
    USER,
  );
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, WROTE as never);
  const registration = f.ledger.registerArtifacts(run.id, FILES);
  const reviewOf = { taskId: work.id, runId: run.id, revision, registration };
  const review = f.ledger.createTask({ projectId, title: '审', goal: '审', acceptance: '给结论', roleId: 'review', reviewOf }, ROUTER);
  assert.deepEqual(f.ledger.taskSource(review.id), { source_id: b!.id, pinned: b }, '继承被审任务的来源，不是项目默认来源（第一项）');
  assert.throws(
    () => f.ledger.createTask({ projectId, title: '审', goal: '审', acceptance: '给结论', roleId: 'review', reviewOf, sourceId: a!.id }, ROUTER),
    /不能另选/,
  );
});

test('设置来源替换整张清单并写一条审计，没变化就不写', (t) => {
  const { ledger, peek } = ledgerFor(t);
  const projectId = ledger.createProject({ name: '代码项目', sources: [repo('https://example.test/a.git')] }, USER);
  const [a] = ledger.projectSources(projectId);
  // 重排并把新的一项插到前面：老项保持自己的编号。
  ledger.setProjectSources(projectId, [repo('https://example.test/b.git'), a!], USER);
  const now = ledger.projectSources(projectId);
  assert.deepEqual(urlsOf(now), ['https://example.test/b.git', 'https://example.test/a.git']);
  assert.equal(now[1]!.id, a!.id, '已有的项重排后编号不变');
  const rows = peek<{ detail_json: string }>(
    "SELECT detail_json FROM change WHERE action = 'project.update' AND json_extract(detail_json, '$.project_id') = ? ORDER BY seq", projectId);
  const detail = JSON.parse(rows.at(-1)!.detail_json) as { sources: { from: Source[]; to: Source[] } };
  assert.deepEqual(urlsOf(detail.sources.from), ['https://example.test/a.git']);
  assert.deepEqual(urlsOf(detail.sources.to), ['https://example.test/b.git', 'https://example.test/a.git']);
  const before = peek('SELECT 1 FROM change').length;
  ledger.setProjectSources(projectId, now, USER);
  assert.equal(peek('SELECT 1 FROM change').length, before, '一样的清单不写 change');
});

test('来源校验：机器能用、机器要存在、编号只收这个项目现在的、地址不带秘密', (t) => {
  const { ledger, peek } = ledgerFor(t);
  const projectId = ledger.createProject({ name: '代码项目' }, USER);
  assert.throws(() => ledger.setProjectSources(projectId, [repo('/host/checkout')], USER), /仓库地址机器用不了/);
  assert.throws(() => ledger.setProjectSources(projectId, [{ kind: 'folder', machine_uid: 'nope', path: '/work' }], USER), /已经不是任何一台机器/);
  assert.throws(() => ledger.setProjectSources(projectId, {}, USER), /要是一个清单/);
  // 新项目的项由服务编号：请求带编号一律不收。
  const projects = peek('SELECT 1 FROM project').length;
  assert.throws(() => ledger.createProject({ name: '带编号', sources: [{ id: 'mine', ...repo('https://example.test/a.git') }] }, USER), /不是这个项目现在的来源/);
  assert.equal(peek('SELECT 1 FROM project').length, projects, '被拒的建项目什么都不写');
  assert.throws(() => ledger.setProjectSources(projectId, [{ id: 's1', ...repo('https://example.test/a.git') }], USER), /不是这个项目现在的来源/);

  // 地址里带秘密要拒收，不是悄悄抹掉；报错不回显秘密。
  for (const url of ['https://user:secret@example.test/a.git', 'https://example.test/a.git?token=secret', 'https://user@example.test/a.git']) {
    assert.throws(() => ledger.setProjectSources(projectId, [repo(url)], USER), (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return /不该有秘密/.test(message) && !message.includes('secret');
    }, url);
  }
  assert.deepEqual(ledger.projectSources(projectId), [], '一条都没存下');

  // 同一个项目清单里已有编号：允许改内容、重排、删掉，删掉的编号不会复活。
  ledger.setProjectSources(projectId, [repo('https://example.test/a.git')], USER);
  const [a] = ledger.projectSources(projectId);
  assert.throws(() => ledger.setProjectSources(projectId, [a!, a!], USER), /编号重复/);
  ledger.setProjectSources(projectId, [], USER);
  assert.throws(() => ledger.setProjectSources(projectId, [a!], USER), /不是这个项目现在的来源/);
  assert.deepEqual(ledger.projectSources(projectId), []);
});
