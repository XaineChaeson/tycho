// Guards roles (docs/design/roles-and-tiers.md §3). Against: a ledger that starts without
// the four presets, or with presets that differ from what the program declares; a role
// saved with a tier, permission or deliverable outside the vocabulary, a blank name or
// description, or a name another role already has; the review role being made writable,
// made to hand over anything but a verdict, or deleted — from the store or over HTTP; a role
// deleted from under a Task that has not ended; a Task created with no role or an unknown
// one; a Task's tier stored as a copy that drifts from its role, rather than derived from
// the override or else the role's default; an override with a tier outside the two; an
// override or a role change left out of the timeline; the owner being made to give a reason
// the Router has to give; the accounts a Task may run on picked by anything but that derived
// tier; a Run's snapshot not recording the role as it was and where its tier came from, or
// a later edit to the role reaching a round already opened; a snapshot prepared for one tier
// being sent after the Task's tier changed; and a Task with no role reaching the queue —
// by "继续", by an answer, or otherwise — before the owner picks one.
// And against "继续" going through for a Task that has an override but no role (writing
// task.resume and answering "queued" while the Task stays put); a settlement whose answer
// and audit row say "queued" while the queue's guard has sent the Task to the owner; and a
// Run out of contact whose Task has no role and no account being left silent — the page
// not saying why it is not continued.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRESET_ROLES, NO_ROLE_LOST_TEXT, NO_ROLE_REASON, REVIEW_KEEP_TEXT, REVIEW_SHAPE_TEXT, ROLE_REQUIRED_TEXT } from '../shared/roles.ts';
import { InputError } from '../service/errors.ts';
import { roleConfig } from '../service/ledger.ts';
import { candidateLogins } from '../service/pick.ts';
import { createRoles } from '../service/roles.ts';
import type { Snapshot } from '../runner/snapshot.ts';
import { consoleApp } from './console-helpers.ts';
import type { Account, AccountStore } from '../runner/snapshot.ts';
import { lostLine } from '../shared/labels.ts';
import { content, fixture, LOGIN, USER } from './helpers.ts';

const ANALYST = { name: '诊断', description: '查清根因，交报告。别用它：根因已明时派实现。', defaultTier: 'decide', permission: 'read', deliverable: 'report', needsReview: false };
const changesOf = (f: ReturnType<typeof fixture>, action: string) =>
  f.peek<{ detail_json: string }>('SELECT detail_json FROM change WHERE action = ? ORDER BY seq', action).map(({ detail_json }) => JSON.parse(detail_json));

test('a new ledger holds the five preset roles, as the program declares them', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.ledger.listRoles().map(roleConfig), PRESET_ROLES.map(roleConfig));
  assert.deepEqual(f.ledger.listRoles().map(({ name }) => name), ['实现', '审阅', '分析', '验证', '协调者']);
  const review = f.ledger.getRole('review')!;
  assert.deepEqual([review.permission, review.deliverable, review.default_tier], ['read', 'verdict', 'decide']);
});

test('roles are added, changed and removed, with what changed on the timeline', (t) => {
  const f = fixture(t);
  const roles = createRoles({ ledger: f.ledger });
  const added = roles.put('diagnose', ANALYST, USER);
  assert.equal(added.created, true);
  assert.equal(roles.get('diagnose')!.name, '诊断');
  const same = roles.put('diagnose', ANALYST, USER);
  assert.deepEqual([same.created, same.changed], [false, undefined], '一个字没变就不记一笔');
  const changed = roles.put('diagnose', { ...ANALYST, defaultTier: 'execute', needsReview: true }, USER);
  assert.deepEqual(changed.changed, { default_tier: { from: 'decide', to: 'execute' }, needs_review: { from: false, to: true } });
  // A preset is data too: its name, description and default tier are the owner's.
  roles.put('implement', { ...ANALYST, name: '动手', permission: 'write', deliverable: 'commit', defaultTier: 'decide' }, USER);
  assert.equal(roles.get('implement')!.name, '动手');
  roles.remove('diagnose', USER);
  assert.equal(roles.get('diagnose'), undefined);
  assert.deepEqual(changesOf(f, 'role.create').map(({ role_id }) => role_id), ['diagnose']);
  assert.equal(changesOf(f, 'role.update').length, 2);
  assert.equal(changesOf(f, 'role.delete')[0].role.name, '诊断');
});

test('a role outside the vocabulary, or with a name another has, is refused', (t) => {
  const f = fixture(t);
  const roles = createRoles({ ledger: f.ledger });
  const refused = (id: string, input: object, why: RegExp) => assert.throws(() => roles.put(id, { ...ANALYST, ...input }, USER), why);
  refused('x', { defaultTier: 'strong' }, /默认档位只能是/);
  refused('x', { defaultTier: 'constructor' }, /默认档位只能是/);
  refused('x', { permission: 'workdir' }, /权限只能是只读、可写之一/);
  refused('x', { deliverable: 'branch' }, /交付物只能是提交、报告、结论之一/);
  refused('x', { name: '  ' }, /职能名不能为空/);
  refused('x', { description: 123 }, /职能说明要是文字/);
  refused('x', { needsReview: 'yes' }, /要独立审阅/);
  refused('a b', {}, /标识 a b 不能用/);
  refused('x', { name: '分析' }, /职能名 分析 已经被 analyse 用了/);
  assert.deepEqual(f.ledger.listRoles().map(({ id }) => id), ['implement', 'review', 'analyse', 'verify', 'orchestrate'], '被拒的一个也没写进去');
  // Blank description is allowed.
  roles.put('empty_desc', { ...ANALYST, name: '空说明', description: '' }, USER);
  assert.equal(roles.get('empty_desc')!.description, '');
});

test('the review role is editable as data and is never removed', (t) => {
  const f = fixture(t);
  const roles = createRoles({ ledger: f.ledger });
  const review = { name: '复核', description: '只给结论', defaultTier: 'decide', permission: 'read', deliverable: 'verdict', needsReview: false };
  roles.put('review', { ...review, permission: 'write', deliverable: 'report', defaultTier: 'execute' }, USER);
  assert.deepEqual([roles.get('review')!.name, roles.get('review')!.default_tier, roles.get('review')!.permission, roles.get('review')!.deliverable], ['复核', 'execute', 'write', 'report']);
  assert.throws(() => roles.remove('review', USER), new RegExp(REVIEW_KEEP_TEXT));
  assert.ok(roles.get('review'));
});

test('a role a Task that has not ended names stays; one only ended Tasks named can go', (t) => {
  const f = fixture(t);
  const roles = createRoles({ ledger: f.ledger });
  const open = f.newTask({ roleId: 'verify' });
  assert.throws(() => roles.remove('verify', USER), /还有 1 个没结束的任务是这个职能/);
  f.ledger.abandonTask(open.id, '不做了', USER);
  roles.remove('verify', USER);
  assert.equal(f.task(open.id).role_id, 'verify', '结束的任务留着它当时的职能标识');
});

test('a Task defaults omitted role to implement and refuses unknown roles', (t) => {
  const f = fixture(t);
  const base = { projectId: f.projectId, title: '任务', goal: '目标', acceptance: '验收' };
  const omitted = f.ledger.createTask({ ...base }, USER);
  assert.equal(omitted.role_id, 'implement');
  const blank = f.ledger.createTask({ ...base, roleId: '' }, USER);
  assert.equal(blank.role_id, 'implement');
  const count = f.count('task');
  assert.throws(() => f.ledger.createTask({ ...base, roleId: 'design' }, USER), /职能不存在：design/);
  assert.throws(() => f.ledger.createTask({ ...base, roleId: 'analyse', tierOverride: { tier: 'strong', reason: '想快' } }, USER), InputError);
  assert.equal(f.count('task'), count);
});

test("a Task's tier is its override, or else its role's default, read fresh each time and never stored", (t) => {
  const f = fixture(t);
  const roles = createRoles({ ledger: f.ledger });
  const task = f.newTask({ roleId: 'analyse' });
  assert.deepEqual([task.tier, task.tier_source, task.tier_override], ['decide', 'default', null]);
  assert.ok(!Object.hasOwn(f.peek<Record<string, unknown>>('SELECT * FROM task WHERE id = ?', task.id)[0]!, 'tier'), '账本不存一份档位');
  // The role's default moves, and the Task follows it.
  const analyse = roles.get('analyse')!;
  roles.put('analyse', { name: analyse.name, description: analyse.description, defaultTier: 'execute', permission: 'read', deliverable: 'report', needsReview: false }, USER);
  assert.deepEqual([f.ledger.getTask(task.id).tier, f.ledger.getTask(task.id).tier_source], ['execute', 'default']);
  // An override stands until it is taken off.
  f.ledger.updateTask(task.id, { tierOverride: { tier: 'decide', reason: '要先想清楚' } }, USER);
  assert.deepEqual([f.ledger.getTask(task.id).tier, f.ledger.getTask(task.id).tier_source, f.ledger.getTask(task.id).tier_reason], ['decide', 'override', '要先想清楚']);
  f.ledger.updateTask(task.id, { roleId: 'implement' }, USER);
  assert.equal(f.ledger.getTask(task.id).tier, 'decide', '换职能不动覆盖');
  f.ledger.updateTask(task.id, { tierOverride: null }, USER);
  assert.deepEqual([f.ledger.getTask(task.id).tier, f.ledger.getTask(task.id).tier_source, f.ledger.getTask(task.id).tier_reason], ['execute', 'default', null]);
  // listTasks and the queue read it the same way.
  f.ledger.queueTask(task.id, USER);
  assert.equal(f.ledger.queuedTasks()[0]!.tier, 'execute');
  assert.equal(f.ledger.listTasks()[0]!.tier_source, 'default');
});

test('the role and an override go on the timeline with what they were; the owner may leave the reason out', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: '任务', goal: '目标', roleId: 'implement', tierOverride: { tier: 'decide', reason: '根因要再确认' } }, USER);
  assert.deepEqual(changesOf(f, 'task.create')[0], { role_id: 'implement', tier_override: { tier: 'decide', reason: '根因要再确认' } });
  f.ledger.updateTask(task.id, { roleId: 'analyse', tierOverride: { tier: 'execute', reason: '  ' } }, USER);
  const [update] = changesOf(f, 'task.update');
  assert.deepEqual(update.role, { from: 'implement', to: 'analyse' });
  assert.deepEqual(update.tier_override, { from: { tier: 'decide', reason: '根因要再确认' }, to: { tier: 'execute', reason: null } });
  assert.equal(f.task(task.id).tier_reason, null, '空白理由当作没写');
});

test('the accounts a Task may run on are picked by its derived tier', (t) => {
  const f = fixture(t);
  const store = new Map<string, Account>([
    // Model-only content: the analysis below is read-only, and a read-only round takes no file of the machine.
    ['e', { id: 'e', name: 'e', executor: 'claude', tiers: { execute: content('{"model":"m"}') } }],
    ['d', { id: 'd', name: 'd', executor: 'claude', tiers: { decide: content('{"model":"m"}') } }],
  ]);
  const accounts = { get: (id: string) => store.get(id), list: () => [...store.values()] } satisfies AccountStore;
  const ids = (id: string) => candidateLogins(f.ledger.getTask(id), ['e', 'd'], accounts).map(({ id }) => id);
  const task = f.newTask({ roleId: 'verify' });
  assert.deepEqual(ids(task.id), ['e'], '验证默认操作档：e 没有操作档，用它的执行档内容顶上');
  f.ledger.updateTask(task.id, { tierOverride: { tier: 'decide', reason: '复现要先想' } }, USER);
  assert.deepEqual(ids(task.id), ['d'], '覆盖成决策档就只挑有决策档的');
  f.ledger.updateTask(task.id, { tierOverride: null, roleId: 'analyse' }, USER);
  assert.deepEqual(ids(task.id), ['d'], '分析默认决策档');
});

test("a Run's snapshot records the role as it was and where its tier came from; later edits reach only later Runs", (t) => {
  const f = fixture(t);
  const roles = createRoles({ ledger: f.ledger });
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, f.login, USER);
  const snapshot = JSON.parse(f.run(run.id).snapshot_json) as Snapshot;
  assert.deepEqual(snapshot.role, roleConfig(PRESET_ROLES[0]!));
  assert.deepEqual([snapshot.tier, snapshot.tier_source, snapshot.tier_reason], ['execute', 'default', undefined]);
  roles.put('implement', { name: '写代码', description: '改过的说明', defaultTier: 'execute', permission: 'write', deliverable: 'commit', needsReview: false }, USER);
  assert.equal(f.run(run.id).snapshot_json, JSON.stringify(snapshot), '已开的这一轮不受影响');
  // The next round, on an override, says so.
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  f.ledger.reworkTask(task.id, '再来', f.task(task.id).revision, USER);
  const analysed = f.newTask({ roleId: 'verify', tierOverride: { tier: 'execute', reason: '只是跑一遍' } });
  f.ledger.queueTask(analysed.id, USER);
  const second = JSON.parse(f.run(f.ledger.createRun(analysed.id, f.login, USER).id).snapshot_json) as Snapshot;
  assert.deepEqual([second.role?.name, second.tier, second.tier_source, second.tier_reason], ['验证', 'execute', 'override', '只是跑一遍']);
  const third = JSON.parse(f.run(f.ledger.createRun(task.id, f.login, USER).id).snapshot_json) as Snapshot;
  assert.deepEqual([third.role?.name, third.role?.needs_review], ['写代码', false], '改职能之后的那一轮用改过的内容');
});

test('a snapshot prepared for one tier is not sent once the Task runs on another', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.updateTask(task.id, { tierOverride: { tier: 'decide', reason: '临时改' } }, USER);
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), /档位在准备快照的这段时间里变成了 decide/);
  assert.equal(f.task(task.id).state, 'queued');
  assert.equal(f.count('run'), 0);
});

test('a Task with no role does not reach the queue until the owner picks one', (t) => {
  const f = fixture(t);
  const task = f.newTask();
  f.force(`UPDATE task SET role_id = NULL, state = 'held', reason = '旧的' WHERE id = ?`, task.id);
  assert.deepEqual([f.ledger.getTask(task.id).tier, f.ledger.getTask(task.id).tier_source], [null, null]);
  assert.throws(() => f.ledger.resumeTask(task.id, USER), new RegExp(NO_ROLE_REASON));
  // Whatever brings it to the queue — here an answer — parks it with the reason instead.
  f.force(`UPDATE task SET state = 'queued', reason = NULL WHERE id = ?`, task.id);
  const approval = f.ledger.openApproval(task.id, [{ question: '用哪个库？' }], USER);
  f.ledger.answerApproval(approval, ['a'], 'user', 'wecom');
  assert.deepEqual([f.task(task.id).state, f.task(task.id).reason], ['waiting_person', NO_ROLE_REASON]);
  f.ledger.updateTask(task.id, { roleId: 'analyse' }, USER);
  f.ledger.resumeTask(task.id, USER);
  assert.equal(f.task(task.id).state, 'queued');
});

test('the console lists roles, edits them under the same rules, and sets a Task’s role and tier without a reason', async (t) => {
  const app = await consoleApp(t);
  const json = async (response: Response): Promise<any> => response.json();
  const listed = await json(await app.get('/api/roles'));
  assert.deepEqual(listed.roles.map(({ id }: { id: string }) => id), ['implement', 'review', 'analyse', 'verify', 'orchestrate']);
  const body = { name: '诊断', description: '查根因', default_tier: 'decide', permission: 'read', deliverable: 'report', needs_review: false };
  assert.equal((await app.send('PUT', '/api/roles/diagnose', body)).status, 201);
  assert.equal((await app.send('PUT', '/api/roles/diagnose', { ...body, name: '诊断二' })).status, 200);
  const editedReview = await app.send('PUT', '/api/roles/review', { ...body, name: '审阅', permission: 'write', deliverable: 'verdict' });
  assert.equal(editedReview.status, 200);
  assert.equal((await app.send('PUT', '/api/roles/x', { ...body, model: 'x' })).status, 400, '职能上没有模型这一项');
  assert.equal((await app.send('DELETE', '/api/roles/review')).status, 400);
  assert.equal((await app.send('DELETE', '/api/roles/diagnose')).status, 200);
  assert.equal((await app.get('/api/roles', {})).status, 401);

  const task = app.f.queuedTask();
  const set = await app.send('PUT', `/api/tasks/${task.id}/role`, { role_id: 'analyse', tier: 'execute' });
  assert.equal(set.status, 200);
  const page = await json(await app.get(`/api/tasks/${task.id}`));
  assert.deepEqual([page.task.role_id, page.task.tier, page.task.tier_source, page.task.tier_reason, page.role.name], ['analyse', 'execute', 'override', null, '分析']);
  assert.equal((await app.send('PUT', `/api/tasks/${task.id}/role`, { tier: null })).status, 200);
  assert.deepEqual([app.f.task(task.id).tier_override], [null]);
  assert.equal((await app.send('PUT', `/api/tasks/${task.id}/role`, { tier: 'strong' })).status, 400);
  assert.equal((await app.send('PUT', `/api/tasks/${task.id}/role`, {})).status, 400);
  const actors = app.f.peek<{ actor: string }>(`SELECT actor FROM change WHERE action = 'task.update' AND task_id = ?`, task.id);
  assert.equal(actors.length, 2, '主人改一次记一笔');
});

test('"继续" needs a role that exists: an override alone is refused, and nothing is written', (t) => {
  const f = fixture(t);
  const task = f.newTask();
  f.force(`UPDATE task SET role_id = NULL, tier_override = 'execute', state = 'waiting_person', reason = ? WHERE id = ?`, NO_ROLE_REASON, task.id);
  assert.equal(f.ledger.getTask(task.id).tier, 'execute', '有覆盖就有档位，但没有职能');
  const resumes = () => f.count('change') ;
  const before = resumes();
  assert.throws(() => f.ledger.resumeTask(task.id, USER), new RegExp(NO_ROLE_REASON));
  assert.equal(resumes(), before, '被拒就不写 task.resume');
  // A role that was removed is no role either.
  f.force(`UPDATE task SET role_id = 'gone' WHERE id = ?`, task.id);
  assert.throws(() => f.ledger.resumeTask(task.id, USER), new RegExp(NO_ROLE_REASON));
  assert.equal(f.task(task.id).state, 'waiting_person');
});

test("a settlement says where the Task really went: the guard's state is the answer, the audit row and the Task's", (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.force('UPDATE task SET role_id = NULL WHERE id = ?', task.id);
  const answer = f.ledger.settleRun(run.id, 1, null, { kind: 'quota', quota: { message: '额度没了' } });
  const [settle] = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'run.settle' AND run_id = ?`, run.id);
  assert.deepEqual(
    [f.task(task.id).state, answer.late === false && answer.task_state, JSON.parse(settle!.detail_json).task_state],
    ['waiting_person', 'waiting_person', 'waiting_person'],
  );
  // With a role nothing changes: the same three say queued.
  const other = f.runningRun();
  const queued = f.ledger.settleRun(other.run.id, 1, null, { kind: 'quota', quota: { message: '额度没了' } });
  assert.deepEqual([f.task(other.task.id).state, queued.late === false && queued.task_state], ['queued', 'queued']);
});

test('a Run out of contact whose Task has no role and no account says so on the page, and the Router is told once', async (t) => {
  const app = await consoleApp(t);
  const { task, run } = app.f.runningRun();
  app.f.force('UPDATE task SET role_id = NULL, login_id = NULL WHERE id = ?', task.id);
  app.f.ledger.markRunUnknown(run.id);
  const page = (await (await app.get(`/api/tasks/${task.id}`)).json()) as { task: { lost: { blocked: string } } };
  assert.equal(page.task.lost.blocked, 'no_role');
  assert.equal(lostLine({ eligible_at: '2026-01-01T00:00:00.000Z', stopping: false, blocked: 'no_role' }, Date.parse('2026-02-01')), NO_ROLE_LOST_TEXT);
  app.f.ledger.reportLostWithoutRole(run.id);
  app.f.ledger.reportLostWithoutRole(run.id);
  const told = app.f.peek<{ text: string }>(`SELECT text FROM message WHERE channel = 'internal' AND external_id = ?`, `no-role:${run.id}`);
  assert.equal(told.length, 1, '同一轮只告诉负责人一次');
  assert.match(told[0]!.text, new RegExp(NO_ROLE_LOST_TEXT));
  assert.deepEqual([app.f.run(run.id).state, app.f.task(task.id).state], ['unknown', 'needs_verification'], '旧的一轮原样留着，不判死');
  // Pinned to an account, it has somewhere to go: nothing blocks it for want of a role.
  app.f.force(`UPDATE task SET login_id = 't1' WHERE id = ?`, task.id);
  const pinned = (await (await app.get(`/api/tasks/${task.id}`)).json()) as { task: { lost: { blocked: string | null } } };
  assert.notEqual(pinned.task.lost.blocked, 'no_role');
});
