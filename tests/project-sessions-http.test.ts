// Guards the console side of project sessions (docs/design/project-sessions.md §1, §2, §5, §8
// step 1) against: no way to make a project once the Router's create_project is gone, a new
// project that does not run on every login or takes a code source no machine may be handed;
// a message written on a project's page landing elsewhere, or one written with no project being
// refused or put somewhere by a guess; a project's conversation showing another segment's
// messages or letting an earlier segment be written to; "新话题" not taking effect for what is
// queued; giving waiting messages a project being half done or moving one already taken; and the
// tools listed for a process with choices of another project, or for a token of no process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleApp, TOOL_TOKEN } from './console-helpers.ts';
import { USER } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

test('a project is made in the console with only a name, and runs on every login', async (t) => {
  const { f, post } = await consoleApp(t);
  const made = await post('/api/projects', { name: '新项目' });
  assert.equal(made.status, 201);
  const { project } = await json(made);
  assert.deepEqual([project.name, project.login_mode, project.sources, project.spawn_machines], ['新项目', 'all', [], false]);
  assert.ok(project.pool.includes(f.ledger.getMachineLogin('h1', 'claude')!.id), '全部登录：现有的登录都在池里');
  assert.equal((await post('/api/projects', { name: '  ' })).status, 400);
  assert.equal((await post('/api/projects', { name: 'a/b' })).status, 400, '项目名会成为目录名');
  const audit = f.peek<{ actor: string }>(`SELECT actor FROM change WHERE action = 'project.create' AND json_extract(detail_json, '$.project_id') = ?`, project.id);
  assert.deepEqual(audit.map(({ actor }) => actor), ['console']);
});

test('a new project takes code sources, and the old code directory field is refused', async (t) => {
  const { f, post } = await consoleApp(t);
  const machine = f.ledger.getMachine('h1')!.uid;
  const made = await json(await post('/api/projects', {
    name: '带代码',
    sources: [
      { kind: 'repo', url: 'https://example.test/tycho.git' },
      { kind: 'folder', machine_uid: machine, path: '/work/tycho' },
    ],
  }));
  assert.deepEqual(made.project.sources.map((source: { kind: string; url?: string; path?: string; default: boolean }) => [source.kind, source.default, source.url ?? source.path]), [
    ['repo', true, 'https://example.test/tycho.git'],
    ['folder', false, '/work/tycho'],
  ], '每项都由服务起编号，第一项是默认');
  assert.equal(new Set(made.project.sources.map((source: { id: string }) => source.id)).size, 2);
  const refused = await post('/api/projects', { name: '本机路径', sources: [{ kind: 'repo', url: '/work/tycho' }] });
  assert.equal(refused.status, 400);
  assert.match((await json(refused)).error, /仓库地址机器用不了/);
  const old = await post('/api/projects', { name: '旧字段', code_dir: '/work/tycho' });
  assert.equal(old.status, 400);
  assert.match((await json(old)).error, /sources/);
});

test('a message written on a project\'s page goes to it; one with no project waits for one and can be given one', async (t) => {
  const { f, post, get } = await consoleApp(t);
  const other = f.ledger.createProject({ name: '乙' }, USER);
  const mine = await json(await post('/api/messages', { text: '甲的话', project_id: f.projectId }));
  assert.deepEqual([f.ledger.getMessage(mine.id).state, f.ledger.getMessage(mine.id).project_id, f.ledger.getMessage(mine.id).basis], ['received', f.projectId, 'console']);
  const loose = await json(await post('/api/messages', { text: '没说哪个项目' }));
  assert.equal(f.ledger.getMessage(loose.id).state, 'unassigned');
  assert.deepEqual((await json(await get('/api/messages/unassigned'))).messages.map(({ id }: { id: string }) => id), [loose.id]);
  assert.equal((await post('/api/messages', { text: '找不到的项目', project_id: 'nowhere' })).status, 400);
  // A message already taken stays where it was taken, and the whole request is refused.
  f.ledger.takeNextTurn(f.projectId);
  const refused = await post('/api/messages/assign', { ids: [loose.id, mine.id], project_id: other });
  assert.equal(refused.status, 400);
  assert.equal(f.ledger.getMessage(loose.id).state, 'unassigned');
  const given = await post('/api/messages/assign', { ids: [loose.id], project_id: other });
  assert.equal(given.status, 200);
  assert.deepEqual([f.ledger.getMessage(loose.id).state, f.ledger.getMessage(loose.id).project_id], ['received', other]);
});

test('a project\'s conversation shows one segment, only the current one is writable, and a new topic takes what is queued', async (t) => {
  const { f, post, get } = await consoleApp(t);
  const conversation = async (segment?: string) =>
    json(await get(`/api/projects/${f.projectId}/conversation${segment ? `?segment=${segment}` : ''}`));
  const before = await conversation();
  assert.deepEqual([before.segments, before.segment, before.writable], [[], null, true], '还没有段时，排着的消息在这里');
  const said = await json(await post('/api/messages', { text: '第一段的话', project_id: f.projectId }));
  f.ledger.takeNextTurn(f.projectId);
  f.ledger.finishMessage(said.id, 'processed');
  const first = await conversation();
  assert.equal(first.segments.length, 1);
  assert.deepEqual(first.messages.map(({ id }: { id: string }) => id), [said.id]);
  const queued = await json(await post('/api/messages', { text: '排着的', project_id: f.projectId }));
  const topic = await post(`/api/projects/${f.projectId}/new-topic`);
  assert.equal(topic.status, 201);
  const second = await conversation();
  assert.equal(second.segments.length, 2);
  assert.equal(second.writable, true);
  assert.deepEqual(second.messages.map(({ id }: { id: string }) => id), [queued.id], '排着的消息跟着当前段走');
  const old = await conversation(first.segment);
  assert.equal(old.writable, false, '历史段只读');
  assert.deepEqual(old.messages.map(({ id }: { id: string }) => id), [said.id]);
  assert.equal((await get(`/api/projects/${f.projectId}/conversation?segment=nope`)).status, 404);
  const rows = f.peek<{ action: string }>(`SELECT action FROM change WHERE action = 'router.segment' ORDER BY seq`);
  assert.equal(rows.length, 2);
});

test('the tools listed are the asking process\'s project\'s, and a token of no process lists nothing', async (t) => {
  const { url, f } = await consoleApp(t);
  const list = (token: string) => fetch(`${url}/tools/list`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const listed = await json(await list(TOOL_TOKEN));
  const create = listed.tools.find(({ name }: { name: string }) => name === 'create_task');
  assert.equal(create.inputSchema.properties.project_id, undefined, '项目由服务绑定，不是参数');
  assert.ok(!listed.tools.some(({ name }: { name: string }) => ['create_project', 'set_project_logins', 'add_machine', 'remove_machine', 'note_decision', 'list_decisions', 'list_projects'].includes(name)));
  assert.equal((await list('not-a-process')).status, 401);
  void f;
});

// §6 (step 2 follow-up): an old ruling the knowledge entrance refused at the upgrade stays where the
// owner sees it — the knowledge page lists it with its project and the reason — not unseen.
test('the knowledge page lists the old rulings the upgrade could not carry over, with why', async (t) => {
  const { f, get } = await consoleApp(t);
  f.force(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('legacy', '2026-11-01T00:00:00.000Z', 'legacy_decisions', ?)`,
    JSON.stringify([{ id: 'd1', created_at: '2026-10-01T00:00:00.000Z', task_id: null, scope: '全局', text: '周五不发版', project_id: f.projectId, problem: '证据摘录里有令牌' }]));
  const page = await json(await get('/api/knowledge'));
  assert.deepEqual(page.legacy, [{ id: 'd1', created_at: '2026-10-01T00:00:00.000Z', task_id: null, project_id: f.projectId, text: '周五不发版', problem: '证据摘录里有令牌' }]);
});

// The owner's pause (§5) is its own action, in effect at once, apart from the page's draft: a body
// that does not say which way is refused, and the project's view says since when it is paused.
test('a project is paused and resumed from the console, and its view says so', async (t) => {
  const { f, post, get } = await consoleApp(t);
  const pause = (body: unknown) => post(`/api/projects/${f.projectId}/pause`, body);
  assert.equal((await pause({})).status, 400);
  const paused = await json(await pause({ paused: true }));
  assert.ok(paused.project.paused_at);
  assert.equal(f.ledger.projectPaused(f.projectId), true);
  const listed = (await json(await get('/api/projects'))).projects.find(({ id }: { id: string }) => id === f.projectId);
  assert.equal(listed.paused_at, paused.project.paused_at);
  assert.equal((await json(await pause({ paused: false }))).project.paused_at, null);
  assert.equal((await post('/api/projects/nowhere/pause', { paused: true })).status, 400);
  const audit = f.peek<{ action: string; actor: string }>(`SELECT action, actor FROM change WHERE action IN ('project.pause', 'project.resume') ORDER BY rowid`).map((row) => ({ ...row }));
  assert.deepEqual(audit, [{ action: 'project.pause', actor: 'console' }, { action: 'project.resume', actor: 'console' }]);
});

// The name is only shown, and it is changed in the same write as the rest of the page's
// settings (project-sessions, "项目的生命周期"): a refused one leaves everything as it was.
test('a project is renamed with the same save as its other settings, and a bad name refuses the whole write', async (t) => {
  const { f, send } = await consoleApp(t);
  const put = (body: unknown) => send('PUT', `/api/projects/${f.projectId}`, body);
  const renamed = await json(await put({ name: '  新名字  ', spawn_machines: true }));
  assert.equal(renamed.project.name, '新名字');
  assert.equal(renamed.project.spawn_machines, true, 'the other field of the same write went in');
  assert.equal((await put({ name: 'a/b', spawn_machines: false })).status, 400);
  assert.deepEqual([f.ledger.getProject(f.projectId).name, f.ledger.getProject(f.projectId).spawn_machines], ['新名字', 1], 'refused: nothing of it changed');
  assert.equal((await put({ name: 4 })).status, 400);
  const audit = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'project.rename'`).map((row) => JSON.parse(row.detail_json) as object);
  assert.deepEqual(audit, [{ project_id: f.projectId, from: '试跑', to: '新名字' }]);
});

// The archive confirmation counts every work not over, not only the moving and the waiting
// ones (project-sessions, "项目的生命周期"): a ready work is unfinished too, an ended one is not.
test('a project\'s view counts every unfinished work, not only the moving and the waiting ones', async (t) => {
  const { f, get } = await consoleApp(t);
  const task = (title: string): string => f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title, goal: '做', acceptance: '好' }, USER).id;
  f.ledger.queueTask(task('在办'), USER);
  const ready = task('待验收');
  f.force(`UPDATE task SET state = 'ready' WHERE id = ?`, ready);
  const done = task('已结束');
  f.force(`UPDATE task SET state = 'done', closed_at = '2030-01-01T00:00:00.000Z' WHERE id = ?`, done);
  const view = (await json(await get('/api/projects'))).projects.find(({ id }: { id: string }) => id === f.projectId);
  // `waiting` now includes owner-actionable `ready` works alongside `waiting_person`/`held`.
  assert.deepEqual([view.moving, view.waiting, view.unfinished], [1, 1, 2]);
});

// Archiving is the pause's kind of action: at once, apart from the save, and the view says so
// (project-sessions, "项目的生命周期").
test('a project is archived and restored from the console, and its view says since when', async (t) => {
  const { f, post, get } = await consoleApp(t);
  const archive = (body: unknown) => post(`/api/projects/${f.projectId}/archive`, body);
  assert.equal((await archive({})).status, 400);
  const archived = await json(await archive({ archived: true }));
  assert.ok(archived.project.archived_at);
  assert.equal(f.ledger.projectStopped(f.projectId), 'archived');
  const listed = (await json(await get('/api/projects'))).projects.find(({ id }: { id: string }) => id === f.projectId);
  assert.equal(listed.archived_at, archived.project.archived_at);
  assert.equal(listed.deletable.allowed, true);
  assert.equal((await json(await archive({ archived: false }))).project.archived_at, null);
  assert.equal((await post('/api/projects/nowhere/archive', { archived: true })).status, 400);
  const audit = f.peek<{ action: string; actor: string }>(`SELECT action, actor FROM change WHERE action IN ('project.archive', 'project.unarchive') ORDER BY rowid`).map((row) => ({ ...row }));
  assert.deepEqual(audit, [{ action: 'project.archive', actor: 'console' }, { action: 'project.unarchive', actor: 'console' }]);
});

// A project that never left a record behind is deleted from its settings page; one with history
// has to be archived first, and the name typed in full (project-sessions, "项目的生命周期").
test('an empty project is deleted from the console once its name is typed, and one with records waits for the archive', async (t) => {
  const { f, send, get } = await consoleApp(t);
  const empty = f.ledger.createProject({ name: '空项目' }, USER);
  const listed = (await json(await get('/api/projects'))).projects;
  assert.equal(listed.find(({ id }: { id: string }) => id === empty).deletable.allowed, true);
  const wrong = await send('DELETE', `/api/projects/${empty}`, { confirm_name: '别的名字' });
  assert.equal(wrong.status, 400);
  assert.equal((await json(await get('/api/projects'))).projects.some(({ id }: { id: string }) => id === empty), true, '名字不对什么都不删');
  assert.equal((await send('DELETE', `/api/projects/${empty}`)).status, 400, '没有 confirm_name 不删');
  assert.equal((await send('DELETE', `/api/projects/${empty}`, { confirm_name: '空项目' })).status, 200);
  assert.equal((await json(await get('/api/projects'))).projects.some(({ id }: { id: string }) => id === empty), false);

  f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title: '留下的工作', goal: '做', acceptance: '好' }, USER);
  const listedAgain = (await json(await get('/api/projects'))).projects.find(({ id }: { id: string }) => id === f.projectId);
  assert.deepEqual([listedAgain.deletable.allowed, listedAgain.deletable.reason], [false, '先归档才能删除']);
  const refused = await send('DELETE', `/api/projects/${f.projectId}`, { confirm_name: '试跑' });
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).error, '先归档才能删除');

  await send('POST', `/api/projects/${f.projectId}/archive`, { archived: true });
  const archived = (await json(await get('/api/projects'))).projects.find(({ id }: { id: string }) => id === f.projectId);
  assert.deepEqual([archived.deletable.allowed, archived.deletable.reason], [true, null]);
  assert.ok(archived.deletable.counts.some(({ label, count }: { label: string; count: number }) => label === '工作' && count === 1));
  assert.equal((await send('DELETE', `/api/projects/${f.projectId}`, { confirm_name: '试跑' })).status, 200);
  assert.equal((await json(await get('/api/projects'))).projects.some(({ id }: { id: string }) => id === f.projectId), false);
  assert.equal((await send('DELETE', '/api/projects/nowhere', { confirm_name: 'x' })).status, 400);
});
