import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { DirectorySkill, EffectiveContextReport, IgnoredSkillEntry } from '../shared/skill-catalog.ts';
import { briefSections, givenOf, type GivenKnowledge } from '../service/knowledge-brief.ts';
import { revisionSet, type Entry } from '../service/knowledge.ts';
import { callLibrary, createLibrary } from '../service/library.ts';
import { consoleApp } from './console-helpers.ts';
import { USER } from './helpers.ts';
import { create, MCP } from './knowledge-helpers.ts';

const ALPHA_ID = 'dir-alpha-skill';
const ALPHA_BODY = '## 步骤\n\n先核对发布记录。';
const ALPHA_FILE = `---\nname: Alpha Skill\ndescription: 发布前核对\n---\n\n${ALPHA_BODY}\n`;
const LEGACY_FILE = '# 旧发布流程\n';
const REGISTRY = '/api/knowledge/registry';

async function setup(t: TestContext) {
  const app = await consoleApp(t);
  const skillsDir = join(app.f.dir, 'skills');
  const alpha = join(skillsDir, 'alpha-skill', 'SKILL.md');
  const legacy = join(skillsDir, 'legacy', 'release.md');
  for (const [file, contents] of [[alpha, ALPHA_FILE], [legacy, LEGACY_FILE]] as const) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const catalog = async () => {
    const response = await app.get('/api/knowledge');
    assert.equal(response.status, 200);
    return await response.json() as {
      directory_skills: DirectorySkill[];
      ignored_skills: IgnoredSkillEntry[];
      skills_dir: string;
      entries: Entry[];
    };
  };
  const effective = async (projectId: string, roleId?: string, machineId?: string) => {
    const query = new URLSearchParams({ project_id: projectId });
    if (roleId !== undefined) query.set('role_id', roleId);
    if (machineId !== undefined) query.set('machine_id', machineId);
    const response = await app.get(`/api/knowledge/effective?${query}`);
    assert.equal(response.status, 200);
    return await response.json() as EffectiveContextReport;
  };
  return { ...app, skillsDir, alpha, legacy, catalog, effective };
}

test('GET /api/knowledge scans standard skills and reports ignored legacy directories', async (t) => {
  const { catalog, skillsDir } = await setup(t);
  const page = await catalog();
  assert.equal(page.skills_dir, skillsDir);
  assert.deepEqual(page.directory_skills.map(({ slug, id, name, description, body, binding }) =>
    ({ slug, id, name, description, body, binding })), [{
    slug: 'alpha-skill',
    id: ALPHA_ID,
    name: 'Alpha Skill',
    description: '发布前核对',
    body: ALPHA_BODY,
    binding: { enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: null },
  }]);
  assert.deepEqual(page.ignored_skills.map(({ name }) => name), ['legacy']);
  assert.match(page.ignored_skills[0]!.reason, /缺少 SKILL.md/);
});

test('PUT validates registry bindings and leaves the skill file intact', async (t) => {
  const { f, send, catalog, alpha } = await setup(t);
  const binding = { enabled: true, loading: 'resident', project_ids: [f.projectId], roles: ['analyse'], machine_ids: null };
  const path = `${REGISTRY}/alpha-skill`;
  const response = await send('PUT', path, binding);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { slug: 'alpha-skill', binding });

  for (const [badPath, input, error] of [
    [path, { ...binding, project_ids: ['missing-project'] }, /项目不存在/],
    [path, { ...binding, roles: ['missing-role'] }, /职能不存在/],
    [path, { ...binding, enabled: 'yes' }, /enabled/],
    // An encoded separator keeps the traversal segment intact until the route decodes the slug.
    [`${REGISTRY}/${encodeURIComponent('../alpha-skill')}`, binding, /技能目录名不合法/],
  ] as const) {
    const refused = await send('PUT', badPath, input);
    assert.equal(refused.status, 400);
    const problem = await refused.json() as { error: string };
    assert.match(problem.error, error);
  }

  assert.deepEqual((await catalog()).directory_skills.find(({ id }) => id === ALPHA_ID)?.binding, binding);
  assert.deepEqual(readFileSync(alpha), Buffer.from(ALPHA_FILE));
});

test('GET /api/knowledge/effective applies both selectors and measures UTF-8 brief and snapshot bytes', async (t) => {
  const { f, send, effective } = await setup(t);
  const otherProject = f.ledger.createProject({ name: '另一项目' }, USER);
  const project = f.ledger.getProject(f.projectId);
  const binding = { enabled: true, loading: 'on_demand', project_ids: [project.id], roles: ['analyse'] };
  const update = async (loading: 'on_demand' | 'resident') => {
    const response = await send('PUT', `${REGISTRY}/alpha-skill`, { ...binding, loading });
    assert.equal(response.status, 200);
  };

  await update('on_demand');
  const demand = await effective(project.id, 'analyse');
  const entries = f.ledger.applicable(project.id, 'analyse');
  assert.deepEqual(demand.on_demand.map(({ id }) => id), [ALPHA_ID]);
  assert.deepEqual(demand.resident, []);
  assert.equal(demand.budget.brief_bytes, Buffer.byteLength(briefSections(entries, project.name)));
  const attachment = givenOf(entries[0]!).text;
  assert.ok(attachment);
  assert.ok(attachment.includes(ALPHA_BODY));
  assert.equal(demand.budget.snapshot_bytes, Buffer.byteLength(attachment));

  await update('resident');
  const resident = await effective(project.id, 'analyse');
  assert.deepEqual([resident.project_id, resident.role_id], [project.id, 'analyse']);
  assert.deepEqual(resident.resident.map(({ id, origin, bytes }) => ({ id, origin, bytes })),
    [{ id: ALPHA_ID, origin: 'directory', bytes: Buffer.byteLength(ALPHA_BODY) }]);
  assert.deepEqual(resident.on_demand, []);
  assert.ok(resident.budget.brief_bytes > 0);
  assert.equal(resident.budget.brief_bytes, Buffer.byteLength(briefSections(f.ledger.applicable(project.id, 'analyse'), project.name)));
  assert.equal(resident.budget.snapshot_bytes, 0);
  assert.equal(resident.budget.over_limit, null);

  for (const excluded of [
    await effective(otherProject, 'analyse'),
    await effective(project.id, 'implement'),
    await effective(project.id),
  ]) {
    assert.deepEqual(excluded.resident, []);
    assert.deepEqual(excluded.on_demand, []);
    assert.equal(excluded.budget.brief_bytes, 0);
    assert.equal(excluded.budget.snapshot_bytes, 0);
  }
});

test('owner publication materializes a single managed skill and retirement removes only its directory', async (t) => {
  const { f, catalog, post, skillsDir, alpha, legacy } = await setup(t);
  const published = await post('/api/knowledge/proposals', create({ title: 'Release checklist' }, { kind: 'skill' }));
  assert.equal(published.status, 201);
  const proposal = await published.json() as { id: string; state: string };
  assert.equal(proposal.state, 'published');

  const page = await catalog();
  const entries = page.entries.filter(({ proposal_id }) => proposal_id === proposal.id);
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.revision, 1);
  const managedDir = join(skillsDir, 'release-checklist');
  assert.ok(readFileSync(join(managedDir, 'SKILL.md'), 'utf8').includes(`<!-- tycho-ledger: ${entry.id}@1 -->`));
  assert.deepEqual(page.directory_skills.map(({ slug, managed_ledger_id }) => [slug, managed_ledger_id]), [
    ['alpha-skill', null], ['release-checklist', entry.id],
  ]);
  assert.deepEqual(f.ledger.applicable(f.projectId, 'implement').map(({ id }) => id).sort(),
    [ALPHA_ID, entry.id].sort());

  const retired = await post(`/api/knowledge/entries/${entry.id}/retire`, { revision: 1, reason: '发布流程已更换' });
  assert.equal(retired.status, 200);
  const result = await retired.json() as { entry: Entry };
  assert.equal(result.entry.state, 'retired');
  assert.equal(existsSync(managedDir), false);
  assert.deepEqual(readFileSync(alpha), Buffer.from(ALPHA_FILE));
  assert.deepEqual(readFileSync(legacy), Buffer.from(LEGACY_FILE));
  assert.deepEqual(f.ledger.applicable(f.projectId, 'implement').map(({ id }) => id), [ALPHA_ID]);
});

test('createRun freezes the applicable directory revision and read_library resolves its ID', async (t) => {
  const { f, alpha } = await setup(t);
  const { ledger } = f;
  const task = f.queuedTask();
  const initial = ledger.applicable(task.project_id, task.role_id);
  assert.deepEqual(initial.map(({ id }) => id), [ALPHA_ID]);

  writeFileSync(alpha, ALPHA_FILE + '\n最后记录核对结果。\n');
  const applicable = ledger.applicable(task.project_id, task.role_id);
  assert.notEqual(revisionSet(initial), revisionSet(applicable));

  const run = ledger.createRun(task.id, {
    ...f.login,
    expectedRevision: task.revision,
    snapshot: { ...f.login.snapshot, knowledge: applicable.map(givenOf) },
  }, USER);
  const snapshot = JSON.parse(run.snapshot_json) as { knowledge: GivenKnowledge[] };
  assert.equal(revisionSet(snapshot.knowledge), revisionSet(applicable));
  assert.deepEqual(snapshot.knowledge, applicable.map(givenOf));

  const result = callLibrary(createLibrary(ledger), 'read_library', { id: ALPHA_ID }, { ctx: USER, proposer: MCP }, ['read']);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0]?.type, 'text');
  const skill = JSON.parse(result.content[0]!.text);
  assert.deepEqual({ id: skill.id, origin: skill.origin, body: skill.body, current_revision: skill.current_revision }, {
    id: ALPHA_ID,
    origin: 'directory',
    body: ALPHA_BODY + '\n\n最后记录核对结果。',
    current_revision: applicable[0]!.revision,
  });
});

test('machine_ids scope filters effective preview, ledger entry machines, node skill package download, and task timeout_ms', async (t) => {
  const { f, send, get, effective } = await setup(t);
  const { ledger } = f;
  // Join two distinct machines: company workstation and home Linux.
  const workToken = 'a'.repeat(64);
  const homeToken = 'b'.repeat(64);
  const sha = async (text: string) => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(text).digest('hex');
  };
  ledger.joinMachine({ id: 'work-pc', host: 'work.local', nodeId: 'node-work', tokenHash: await sha(workToken), platform: 'win32', source: null, ephemeral: false }, USER);
  ledger.joinMachine({ id: 'home-linux', host: 'home.local', nodeId: 'node-home', tokenHash: await sha(homeToken), platform: 'linux', source: null, ephemeral: false }, USER);

  // Restrict alpha-skill to work-pc only.
  const putSkill = await send('PUT', `${REGISTRY}/alpha-skill`, {
    enabled: true, loading: 'on_demand', project_ids: null, roles: [], machine_ids: ['work-pc'],
  });
  assert.equal(putSkill.status, 200);

  // Publish a ledger entry and restrict it to home-linux only.
  const pub = await send('POST', '/api/knowledge/proposals', {
    outputs: [{ title: '家用机规范', when_to_use: '家里机器运行', body: '只在家里机器生效。', project_ids: null, loading: 'resident', roles: [] }],
    why: { when: '家里环境', changes: '机器隔离', generalizes: '长期有效' },
    evidence: [{ source: 'owner', location: '控制台', excerpt: '仅限家里机器' }],
    request_id: 'req-home-machine',
  });
  assert.equal(pub.status, 201);
  const entryId = ledger.listEntries()[0]!.id;
  const putEntry = await send('PUT', `/api/knowledge/entries/${encodeURIComponent(entryId)}/machines`, { machine_ids: ['home-linux'] });
  assert.equal(putEntry.status, 200);

  // 3D effective preview strictly separates work-pc vs home-linux.
  const workEff = await effective(f.projectId, undefined, 'work-pc');
  assert.equal(workEff.machine_id, 'work-pc');
  assert.deepEqual(workEff.resident.map(({ id }) => id), []);
  assert.deepEqual(workEff.on_demand.map(({ id }) => id), [ALPHA_ID]);

  const homeEff = await effective(f.projectId, undefined, 'home-linux');
  assert.equal(homeEff.machine_id, 'home-linux');
  assert.deepEqual(homeEff.resident.map(({ id }) => id), [entryId]);
  assert.deepEqual(homeEff.on_demand.map(({ id }) => id), []);

  // Node skill bundle download: work-pc gets 200 tar.gz; home-linux gets 404 for alpha-skill.
  const workPkg = await get('/api/node/skills/alpha-skill', { Authorization: `Bearer ${workToken}` });
  assert.equal(workPkg.status, 200);
  assert.equal(workPkg.headers.get('content-type'), 'application/gzip');
  assert.ok((await workPkg.arrayBuffer()).byteLength > 20);

  const homePkg = await get('/api/node/skills/alpha-skill', { Authorization: `Bearer ${homeToken}` });
  assert.equal(homePkg.status, 404);

  // Deleting work-pc fail-closes alpha-skill instead of widening to all machines.
  ledger.deleteMachine('work-pc', USER);
  assert.deepEqual(ledger.skillRegistry()['alpha-skill'], {
    enabled: false, loading: 'on_demand', project_ids: null, roles: [], machine_ids: null,
  });

  // Task-level timeout_ms override.
  const task = ledger.createTask({
    projectId: f.projectId, title: '长程训练', goal: '跑 24 小时训练', acceptance: '完成', roleId: 'implement', timeoutMs: 86_400_000,
  }, USER);
  assert.equal(ledger.taskTimeoutMs(task.id), 86_400_000);
  ledger.updateTask(task.id, { timeoutMs: null }, USER);
  assert.equal(ledger.taskTimeoutMs(task.id), null);
});
