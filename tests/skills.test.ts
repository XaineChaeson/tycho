// Guards against skills going wrong (docs/design/knowledge-and-skills.md §1, §3, §4, §6, §8 step
// 3): a skill taken as resident, or a change mixing a skill with knowledge; a skill proposal taking
// effect without its gate, or a gate not told to check that the steps do the work and do no harm;
// a round not given the skills of its project and role as a catalog with their bodies as files of
// its snapshot, given another project's or role's, or a skill the Task names left out of its brief,
// cut short, or sent again as a file; a Task naming something that is not a skill in force for it,
// or a change of what it names not being a new revision of what it asks; a named skill retired
// after the naming sent out anyway or silently dropped; a round prepared on one set of skills
// created after the set changed; the Router and the knowledge MCP not seeing skills in their
// catalogs and reads; a skill file left in the data directory reaching the ledger except by the
// owner's explicit import, the import publishing without a gate, bringing a file in twice, losing
// the original text it came from, taking a file it cannot place silently, a preview passing a
// file the import then refuses, or one unreadable file ending the import with nothing said of the
// rest; a gate turning a skill into knowledge; a curation round of a skill, its one gate, not told
// to check the steps; and the platform's spawn convention missing from the brief of a Task with a join quota, or present without one.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import type { Account, Snapshot } from '../runner/snapshot.ts';
import { prepareSnapshot, SKILL_CHECK, snapshotFiles } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { givenOf, knowledgeTaskMaterial, routerKnowledge } from '../service/knowledge-brief.ts';
import { parseKnowledgeTask } from '../service/knowledge.ts';
import { createLibrary } from '../service/library.ts';
import type { Ledger, RunRow } from '../service/ledger.ts';
import { importSkills } from '../service/skill-import.ts';
import { consoleApp } from './console-helpers.ts';
import { content, fixture, memoryLogins, readOnlyEverywhere, claudeTier, tuned, USER, DISPATCH_TUNED, type Fixture } from './helpers.ts';
import { create, EVIDENCE, GATE, MCP, OWNER, OWNER_SAYS, WHY } from './knowledge-helpers.ts';

const ACCOUNT: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };
const SKILL_BODY = '## 在哪里做\n\n在仓库根目录\n\n## 按什么顺序\n\n1. 跑 npm test';

// A skill in force as the owner writes one: at once, with no gate.
function skill(ledger: Ledger, fields: Record<string, unknown> = {}): string {
  ledger.propose({ kind: 'skill', outputs: [{ title: '发布', when_to_use: '要上线时', body: SKILL_BODY, project_ids: null, ...fields }], why: WHY, evidence: EVIDENCE }, OWNER_SAYS, OWNER);
  return ledger.listEntries({ includeRetired: true }).at(-1)!.id;
}

function setup(t: TestContext) {
  const f = fixture(t);
  f.ledger.putAccount(GATE, USER, 'ref-g1');
  const launched: RunRow[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    runner: {
      findMachine: async (_login, machines) => machines[0],
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => { launched.push(run); },
      watch: async (_run, watching = {}) => {
        await new Promise<void>((resolve) => {
          if (watching.signal?.aborted) resolve();
          watching.signal?.addEventListener('abort', () => resolve());
        });
      },
    },
    logins: memoryLogins({ t1: ACCOUNT }, f.ledger),
    ...readOnlyEverywhere({ get: (id) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() }),
    executors: { claude: claudeAdapter },
    intervalMs: 10,
    watchIntervalMs: 7,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  const queued = (fields: { skillIds?: string[]; roleId?: string } = {}) => {
    const task = f.ledger.createTask({ projectId: f.projectId, title: '任务', goal: '目标', acceptance: '测试通过', loginId: 't1', roleId: fields.roleId ?? 'implement', ...(fields.skillIds ? { skillIds: fields.skillIds } : {}) }, USER);
    f.ledger.queueTask(task.id, USER);
    return f.task(task.id);
  };
  const snapshotOf = (run: RunRow) => JSON.parse(f.run(run.id).snapshot_json) as Snapshot;
  return { f, dispatcher, launched, queued, snapshotOf };
}

test('a skill is proposed like knowledge, always coerces loading to on_demand, and publishes immediately unreviewed', (t) => {
  const f = fixture(t);
  const asSkill = (fields: Record<string, unknown> = {}) => create({ body: SKILL_BODY, ...fields }, { kind: 'skill' });
  const forced = f.ledger.propose(asSkill({ title: '强行常驻的技能', loading: 'resident' }), MCP, USER);
  assert.equal(forced.state, 'published');
  assert.equal(f.ledger.getProposal(forced.id).gate_task_id, null);
  const forcedEntry = f.ledger.listEntries().at(-1)!;
  assert.deepEqual([forcedEntry.kind, forcedEntry.loading, forcedEntry.reviewed_at], ['skill', 'on_demand', null]);

  const { loading: _l, ...unloaded } = (asSkill({ title: '默认加载的技能' }).outputs as Record<string, unknown>[])[0]!;
  const proposed = f.ledger.propose({ ...asSkill(), outputs: [unloaded] }, MCP, USER);
  assert.equal(proposed.state, 'published');
  assert.equal(f.ledger.getProposal(proposed.id).gate_task_id, null);
  const entry = f.ledger.listEntries().at(-1)!;
  assert.deepEqual([entry.kind, entry.loading, entry.reviewed_at], ['skill', 'on_demand', null]);

  // Kind changes are allowed without artificial locks.
  f.ledger.propose(create({ title: '一条知识' }), OWNER_SAYS, OWNER);
  const fact = f.ledger.listEntries().at(-1)!;
  const converted = f.ledger.propose({ kind: 'skill', outputs: [{ revises: fact.id, title: '转成技能', body: SKILL_BODY }] }, MCP, USER);
  assert.equal(converted.state, 'published');
  assert.equal(f.ledger.getEntry(fact.id)!.kind, 'skill');
});

test('a round gets its skills as a catalog with files, and the skill its Task names in full in the brief', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf } = setup(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  const listed = skill(f.ledger, { title: '全局技能', body: '全局技能的步骤' });
  const named = skill(f.ledger, { title: '项目技能', body: '项目技能的步骤', project_ids: [f.projectId] });
  skill(f.ledger, { title: '别的项目的技能', body: '别处的步骤', project_ids: [other] });
  skill(f.ledger, { title: '只给审阅的技能', body: '审阅的步骤', roles: ['review'] });
  queued({ skillIds: [named] });
  await dispatcher.tick();
  const snapshot = snapshotOf(launched[0]!);
  assert.deepEqual(snapshot.knowledge!.map(({ id, kind, named: isNamed, path }) => [id, kind, isNamed ?? false, path ?? null]), [
    [listed, 'skill', false, `skills/${listed}@1.md`],
    [named, 'skill', true, null],
  ]);
  const at = (text: string): number => {
    const index = snapshot.brief.indexOf(text);
    assert.ok(index >= 0, `brief 里应有：${text}`);
    return index;
  };
  const order = ['## 目标', '## 技能', `全局技能（${listed}@1）`, '## 指定技能', '项目技能的步骤', '## 资料', '## 回执'].map(at);
  assert.deepEqual(order, order.toSorted((a, b) => a - b));
  for (const absent of ['全局技能的步骤', '别处的步骤', '审阅的步骤']) assert.equal(snapshot.brief.includes(absent), false, absent);
  const files = new Map(snapshotFiles(snapshot).map(({ path, text }) => [path, text]));
  assert.match(files.get(`skills/${listed}@1.md`)!, /全局技能的步骤/);
  assert.equal([...files.keys()].some((path) => path.includes(named)), false, '点名的全文在说明里，不另给文件');
});

test('a Task names only skills visible to its project regardless of role, and a change of them is a new revision', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  const mine = skill(f.ledger);
  const elsewhere = skill(f.ledger, { project_ids: [other] });
  const forImplement = skill(f.ledger, { roles: ['implement'] });
  f.ledger.propose(create({ title: '一条知识' }), OWNER_SAYS, OWNER);
  const fact = f.ledger.listEntries().at(-1)!.id;
  const make = (skillIds: string[]) => f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', acceptance: 'a', roleId: 'implement', skillIds }, USER);
  assert.throws(() => make([fact]), /是知识，不是技能/);
  assert.throws(() => make([elsewhere]), /不属于这个项目/);
  assert.throws(() => make(['nope']), /没有这个技能/);
  const task = make([forImplement, forImplement]);
  assert.deepEqual(JSON.parse(task.skills_json!), [forImplement], '同一个只点一次');
  // Changing role does not reject a project-visible named skill.
  const rerole = f.ledger.updateTask(task.id, { roleId: 'analyse' }, USER);
  assert.equal(rerole.role_id, 'analyse');
  const renamed = f.ledger.updateTask(task.id, { skillIds: [mine] }, USER);
  assert.deepEqual([renamed.revision, JSON.parse(renamed.skills_json!)], [2, [mine]]);
  assert.equal(f.ledger.updateTask(task.id, { skillIds: [] }, USER).skills_json, null);
});

test('a skill retired after the Task named it is skipped with a note instead of holding the Task', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf } = setup(t);
  const named = skill(f.ledger, { body: '已退役技能的步骤' });
  const task = queued({ skillIds: [named] });
  f.ledger.retireEntry(named, { reason: '步骤过时了', revision: 1 }, OWNER);
  await dispatcher.tick();
  assert.equal(launched.length, 1);
  assert.equal(f.task(task.id).state, 'running');
  const brief = snapshotOf(launched[0]!).brief;
  assert.match(brief, new RegExp(`任务原指定的技能 \`${named}\` 已退役或当前不适用，已跳过`));
  assert.equal(brief.includes('已退役技能的步骤'), false);
});

test('a round prepared before a skill was published still creates cleanly with its frozen snapshot', (t) => {
  const f = fixture(t);
  skill(f.ledger);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', acceptance: 'a', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  f.ledger.putAccount({ ...ACCOUNT, tiers: { execute: content('{}') } }, USER, 'ref-t1');
  const prepared = f.ledger.applicable(f.projectId, 'implement').map(givenOf);
  skill(f.ledger, { title: '新来的技能' });
  const run = f.ledger.createRun(task.id, { login: { ...ACCOUNT, tiers: { execute: content('{}') } }, machine: f.ledger.getMachine('h1')!, expectedRevision: 1, snapshot: { brief: 'b', timeout_ms: 60_000, knowledge: prepared } }, USER);
  const snap = JSON.parse(run.snapshot_json) as Snapshot;
  assert.deepEqual(snap.knowledge, prepared);
});

test('the Router and the knowledge MCP see the skills in their catalogs, reads and searches, and can propose one', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(GATE, USER, 'ref-g1');
  const global = skill(f.ledger, { title: '全局技能' });
  const project = skill(f.ledger, { title: '项目技能', project_ids: [f.projectId] });
  skill(f.ledger, { title: '只给实现的技能', roles: ['implement'] });
  f.ledger.propose(create({ title: '常驻知识', loading: 'resident' }), OWNER_SAYS, OWNER);
  const router = routerKnowledge(f.ledger.applicable(f.projectId, null));
  assert.match(router.catalog, /\[tycho 技能\]/);
  assert.ok(router.catalog.includes(`全局技能（${global}@1，全局）`) && router.catalog.includes(`项目技能（${project}@1，项目）`));
  assert.equal(router.catalog.includes('只给实现的技能'), false, '限了职能的不进负责人');
  assert.equal(router.residentText.includes('全局技能'), false, '技能没有常驻');

  const tools = new Map(createLibrary(f.ledger).map((tool) => [tool.name, tool]));
  const caller = { ctx: USER, proposer: MCP };
  const context = JSON.parse(tools.get('get_working_context')!.run({ project_id: f.projectId, role_id: 'implement' }, caller)) as { global: { title: string }[]; skills: { title: string; kind: string; body?: string }[] };
  assert.deepEqual(context.skills.map(({ title, kind, body }) => [title, kind, body ?? null]), [['全局技能', 'skill', null], ['只给实现的技能', 'skill', null], ['项目技能', 'skill', null]]);
  assert.deepEqual(context.global.map(({ title }) => title), ['常驻知识']);
  const read = JSON.parse(tools.get('read_library')!.run({ id: global }, caller)) as { kind: string; body: string };
  assert.deepEqual([read.kind, read.body], ['skill', SKILL_BODY]);
  const found = JSON.parse(tools.get('search_library')!.run({ query: '技能', scope: 'global', kind: 'skill' }, caller)) as { items: { title: string }[] };
  assert.deepEqual(found.items.map(({ title }) => title), ['全局技能', '只给实现的技能']);
  const proposed = JSON.parse(tools.get('propose_learning')!.run({ ...create({ title: '外部提的技能', body: SKILL_BODY, loading: undefined }), kind: 'skill', request_id: 'r1' }, caller)) as { state: string; proposal_id: string };
  assert.equal(proposed.state, 'published');
  assert.equal(f.ledger.getProposal(proposed.proposal_id).kind, 'skill');
});

function skillFolder(f: Fixture): string {
  const folder = join(f.dir, 'skills');
  mkdirSync(join(folder, '试跑'), { recursive: true });
  mkdirSync(join(folder, '没有的项目'), { recursive: true });
  writeFileSync(join(folder, '试跑', 'deploy.md'), '---\nname: 部署\ndescription: 要把服务部署到机器上时\n---\n# 部署\n\n1. 打包\n2. 上传\n');
  writeFileSync(join(folder, '试跑', 'plain.md'), '# 清缓存\n\n缓存出错时先清一遍。\n');
  writeFileSync(join(folder, '试跑', 'notes.txt'), '不是技能');
  writeFileSync(join(folder, '试跑', 'empty.md'), '  \n');
  writeFileSync(join(folder, '试跑', 'big.md'), `# 很长\n\n${'长'.repeat(12_000)}`);
  writeFileSync(join(folder, '没有的项目', 'x.md'), '# x');
  writeFileSync(join(folder, 'top.md'), '# 顶层');
  return folder;
}

test('the old skill files come in only by the owner\'s import, each a gated proposal with its file as evidence, once', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(GATE, USER, 'ref-g1');
  const folder = skillFolder(f);
  const state = (items: { path: string; state: string }[]) => Object.fromEntries(items.map(({ path, state: each }) => [path, each]));

  const preview = importSkills(f.ledger, folder, OWNER, { dryRun: true });
  assert.deepEqual(state(preview.items), {
    'top.md': 'skipped', '没有的项目/x.md': 'skipped', '试跑/big.md': 'refused', '试跑/deploy.md': 'new', '试跑/empty.md': 'skipped', '试跑/plain.md': 'new',
  });
  assert.match(preview.items.find(({ path }) => path === '没有的项目/x.md')!.reason!, /没有叫“没有的项目”的项目/);
  assert.equal(f.count('knowledge_proposal'), 0, '预览什么都不写');
  const previewed = preview.items.find(({ path }) => path === '试跑/big.md')!.reason!;
  assert.match(previewed, /超过了单条上限/, '预览就说出导入时会拒收的原因');

  const done = importSkills(f.ledger, folder, OWNER, { dryRun: false });
  assert.deepEqual(state(done.items), {
    'top.md': 'skipped', '没有的项目/x.md': 'skipped', '试跑/big.md': 'refused', '试跑/deploy.md': 'proposed', '试跑/empty.md': 'skipped', '试跑/plain.md': 'proposed',
  });
  assert.equal(done.items.find(({ path }) => path === '试跑/big.md')!.reason, previewed, '和预览说的是同一个原因');
  const deploy = f.ledger.getProposal(done.items.find(({ path }) => path === '试跑/deploy.md')!.proposal_id!);
  assert.deepEqual([deploy.kind, deploy.source, deploy.state, deploy.reviewed_at], ['skill', 'import', 'published', null], '迁入的立即生效（未审阅）');
  const output = deploy.change.outputs[0]!;
  assert.deepEqual([output.title, output.when_to_use, output.project_ids], ['部署', '要把服务部署到机器上时', [f.projectId]]);
  assert.equal(deploy.evidence[0]!.excerpt, '---\nname: 部署\ndescription: 要把服务部署到机器上时\n---\n# 部署\n\n1. 打包\n2. 上传', '原文作证据');
  assert.deepEqual([deploy.evidence[0]!.source, deploy.evidence[0]!.ref], ['file', '试跑/deploy.md']);
  const plain = f.ledger.getProposal(done.items.find(({ path }) => path === '试跑/plain.md')!.proposal_id!).change.outputs[0]!;
  assert.deepEqual([plain.title, plain.when_to_use], ['清缓存', '缓存出错时先清一遍。']);
  assert.equal(f.ledger.listEntries().length, 2, '导入的两份技能已生效');

  const again = importSkills(f.ledger, folder, OWNER, { dryRun: false });
  assert.equal(state(again.items)['试跑/deploy.md'], 'imported');
  assert.equal(f.count('knowledge_proposal'), 2, '同一份文件不进第二次');
  writeFileSync(join(folder, '试跑', 'deploy.md'), '# 部署\n\n1. 打包\n2. 上传\n3. 核对\n');
  assert.equal(state(importSkills(f.ledger, folder, OWNER, { dryRun: false }).items)['试跑/deploy.md'], 'proposed', '改过的再导入一次');
  assert.throws(() => importSkills(f.ledger, join(folder, 'nope'), OWNER, { dryRun: true }), /目录不存在/);
});

test('the platform\'s way to spawn a machine is in the brief of a Task that has had a quota, and only there', async (t) => {
  const { f, dispatcher, launched, queued, snapshotOf } = setup(t);
  const plain = queued();
  f.ledger.setProjectSpawnMachines(f.projectId, true, USER);
  const spawning = queued();
  f.ledger.createInvite({ taskId: spawning.id, executors: null, ttlMs: 60_000, maxMachines: 1 }, USER);
  await dispatcher.tick();
  await dispatcher.tick();
  const brief = (taskId: string) => snapshotOf(launched.find((run) => run.task_id === taskId)!).brief;
  assert.equal(brief(plain.id).includes('## 派生机器'), false);
  assert.match(brief(spawning.id), /## 派生机器[\s\S]*TYCHO_JOIN_MATERIALS[\s\S]*destroyed_machines/);
});

test('the console starts the import: a preview first, by default in the data directory\'s skills folder', async (t) => {
  const app = await consoleApp(t);
  app.f.ledger.putAccount(GATE, USER, 'ref-g1');
  skillFolder(app.f);
  const page = (await (await app.get('/api/knowledge')).json()) as { skill_folder: string };
  assert.equal(page.skill_folder, join(app.f.dir, 'skills'));
  const preview = (await (await app.post('/api/knowledge/skills/import', { dry_run: true })).json()) as { dir: string; items: { state: string }[] };
  assert.equal(preview.dir, join(app.f.dir, 'skills'));
  assert.equal(preview.items.filter(({ state }) => state === 'new').length, 2);
  assert.equal(app.f.count('knowledge_proposal'), 0);
  const done = (await (await app.post('/api/knowledge/skills/import', {})).json()) as { items: { state: string }[] };
  assert.equal(done.items.filter(({ state }) => state === 'proposed').length, 2);
  assert.equal((await app.post('/api/knowledge/skills/import', { dir: 'relative/path' })).status, 400);
});

test('a skill curation round is told to check the steps', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(GATE, USER, 'ref-g1');
  const entry = skill(f.ledger, { title: '部署' });
  const curation = f.task(f.ledger.curate({ entries: [entry], reason: '步骤过时' }, USER));
  const { brief } = prepareSnapshot(curation, GATE, { claude: claudeAdapter }, {
    timeoutMs: 60_000, permission: 'read',
    knowledgeTask: knowledgeTaskMaterial(f.ledger, parseKnowledgeTask(curation.knowledge_json)!),
  });
  assert.ok(brief.includes(SKILL_CHECK), `${curation.title} 的说明里要有技能的检查要求`);
});

test('a file or a project folder that cannot be read says why on its own line, and the import goes on; a ledger that cannot write stops it', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(GATE, USER, 'ref-g1');
  f.ledger.createProject({ name: '别的' }, USER);
  const folder = join(f.dir, 'skills');
  mkdirSync(join(folder, '试跑'), { recursive: true });
  mkdirSync(join(folder, '别的'), { recursive: true });
  for (const name of ['a', 'b', 'c']) writeFileSync(join(folder, '试跑', `${name}.md`), `# ${name}\n\n步骤 ${name}`);
  writeFileSync(join(folder, '别的', 'x.md'), '# x');
  const denied = (path: string) => Object.assign(new Error(`EACCES: permission denied, ${path}`), { code: 'EACCES' });
  const files = {
    list: (dir: string) => {
      if (dir.endsWith('别的')) throw denied(dir);
      return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    },
    read: (file: string) => {
      if (file.endsWith('b.md')) throw denied(file);
      return readFileSync(file, 'utf8');
    },
  };
  const done = importSkills(f.ledger, folder, OWNER, { dryRun: false, files });
  const line = (path: string) => done.items.find((item) => item.path === path)!;
  assert.deepEqual(done.items.map(({ path, state }) => [path, state]), [['别的/', 'failed'], ['试跑/a.md', 'proposed'], ['试跑/b.md', 'failed'], ['试跑/c.md', 'proposed']]);
  assert.match(line('试跑/b.md').reason!, /没有权限读（EACCES）/);
  assert.match(line('别的/').reason!, /这个目录没有权限读（EACCES），里面的文件一份都没有看/);
  assert.equal(f.count('knowledge_proposal'), 2);

  // The ledger failing is not one file's problem: the import stops there.
  writeFileSync(join(folder, '试跑', 'd.md'), '# d');
  writeFileSync(join(folder, '试跑', 'e.md'), '# e');
  const broken = { ...f.ledger, listProjects: () => f.ledger.listProjects(), checkProposal: f.ledger.checkProposal, propose: () => { throw new Error('disk I/O error'); } };
  assert.throws(() => importSkills(broken, folder, OWNER, { dryRun: false, files }), /disk I\/O error/);
  assert.equal(f.count('knowledge_proposal'), 2);
});

test('a link in the skills folder, to a project folder or a file, is listed as not followed', (t) => {
  const f = fixture(t);
  const folder = join(f.dir, 'skills');
  const real = join(f.dir, 'elsewhere');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'deploy.md'), '# 部署');
  mkdirSync(folder, { recursive: true });
  symlinkSync(real, join(folder, '试跑'), 'junction');
  const preview = importSkills(f.ledger, folder, OWNER, { dryRun: true });
  assert.deepEqual(preview.items.map(({ path, state }) => [path, state]), [['试跑', 'skipped']]);
  assert.match(preview.items[0]!.reason!, /是一个链接，没有跟过去读/);
});
