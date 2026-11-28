// Guards the life of a project (docs/design/project-sessions.md, "项目的生命周期"): a name
// that is only shown but is checked as it is when made; an archive that holds back dispatch,
// the Router and triggers without touching a task or a record, and a restore that gives it all
// back; a pause that survives an archive and its restore; a delete that takes an empty project
// at any time and one with history only once archived, with its name typed again; what it
// deletes, what it keeps, and what is left on disk — a cleanup a restart picks up and finishes;
// and a version 37 ledger that opens with every project in sight.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAcceptor } from '../service/accept.ts';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { InputError } from '../service/errors.ts';
import { openLedger } from '../service/ledger.ts';
import { registrationDir } from '../service/releases.ts';
import { createRetention } from '../service/retention.ts';
import { DONE, fixture, USER } from './helpers.ts';
import { create as knowledgeChange, GATE, MCP, output, ownerEntry, settleGate } from './knowledge-helpers.ts';
import { givenOf } from '../service/knowledge-brief.ts';

test('a project is renamed with the rules it was made by, and nothing refers to the old name', (t) => {
  const f = fixture(t);
  const id = f.ledger.createProject({ name: '  旧名字  ' }, USER);
  assert.equal(f.ledger.getProject(id).name, '旧名字');
  const renamed = f.ledger.setProjectName(id, '  新名字  ', USER);
  assert.equal(renamed.name, '新名字');
  assert.equal(f.ledger.getProject(id).name, '新名字');
  const audit = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'project.rename'`).map((row) => JSON.parse(row.detail_json) as { project_id: string; from: string; to: string });
  assert.deepEqual(audit, [{ project_id: id, from: '旧名字', to: '新名字' }]);

  // The same name changes and records nothing.
  f.ledger.setProjectName(id, '新名字', USER);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'project.rename'`).length, 1);

  // The same checks createProject makes: not empty, no path separator, not all dots.
  for (const bad of ['', '   ', 'a/b', 'a\\b', '..', '.']) {
    assert.throws(() => f.ledger.setProjectName(id, bad, USER), (err: unknown) => err instanceof InputError && /项目名/.test(err.message), bad);
    assert.throws(() => f.ledger.createProject({ name: bad }, USER), (err: unknown) => err instanceof InputError && /项目名/.test(err.message), bad);
  }
  assert.equal(f.ledger.getProject(id).name, '新名字', 'refused names change nothing');
});

test('an archived project dispatches nothing, takes no message and refuses a round; a restore gives it all back', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const message = f.ledger.receiveMessage({ channel: 'console', externalId: 'm1', actor: 'user', text: '在吗', projectId: f.projectId });
  f.ledger.setProjectArchived(f.projectId, true, USER);
  assert.ok(f.ledger.getProject(f.projectId).archived_at);
  assert.equal(f.ledger.projectStopped(f.projectId), 'archived');
  assert.equal(f.ledger.projectPaused(f.projectId), true, 'every place that asked "paused" is held back too');
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id), [], '派发的队列里没有它的任务');
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), (err: unknown) => err instanceof InputError && /项目已归档/.test(err.message));
  assert.equal(f.task(task.id).state, 'queued', '任务照旧排着，不改状态');
  assert.equal(f.ledger.hasReceivedMessage(f.projectId), false);
  assert.deepEqual(f.ledger.projectsWaiting(), []);
  assert.equal(f.ledger.takeNextTurn(f.projectId), undefined);
  assert.equal(f.ledger.getMessage(message.id).state, 'received', '消息照常入账，等着');
  const later = f.ledger.receiveMessage({ channel: 'console', externalId: 'm2', actor: 'user', text: '归档时来的', projectId: f.projectId });
  assert.equal(f.ledger.getMessage(later.id).state, 'received');

  f.ledger.setProjectArchived(f.projectId, false, USER);
  assert.equal(f.ledger.getProject(f.projectId).archived_at, null);
  assert.equal(f.ledger.projectStopped(f.projectId), null);
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id), [task.id]);
  assert.equal(f.ledger.takeNextTurn(f.projectId)?.message.id, message.id);
  assert.equal(f.ledger.createRun(task.id, f.login, USER).state, 'launching');
  const changes = f.peek<{ action: string; actor: string }>(`SELECT action, actor FROM change WHERE action IN ('project.archive', 'project.unarchive') ORDER BY rowid`).map((row) => ({ ...row }));
  assert.deepEqual(changes, [{ action: 'project.archive', actor: 'user' }, { action: 'project.unarchive', actor: 'user' }]);
});

test('archiving twice changes nothing, and a paused project is still paused after its archive is restored', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  f.ledger.setProjectPaused(f.projectId, true, USER);
  const pausedAt = f.ledger.getProject(f.projectId).paused_at;
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const archivedAt = f.ledger.getProject(f.projectId).archived_at;
  f.ledger.setProjectArchived(f.projectId, true, USER);
  assert.equal(f.ledger.getProject(f.projectId).archived_at, archivedAt, 'archive is idempotent');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'project.archive'`).length, 1);
  // While both hold, the archive is what the pages say, and nothing starts either way.
  assert.equal(f.ledger.projectStopped(f.projectId), 'archived');
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id), []);
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), /项目已归档/);

  f.ledger.setProjectArchived(f.projectId, false, USER);
  assert.equal(f.ledger.getProject(f.projectId).paused_at, pausedAt, '恢复归档后仍然暂停');
  assert.equal(f.ledger.projectStopped(f.projectId), 'paused');
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id), []);
  assert.throws(() => f.ledger.createRun(task.id, f.login, USER), /项目已暂停/);

  f.ledger.setProjectPaused(f.projectId, false, USER);
  assert.deepEqual(f.ledger.queuedTasks().map(({ id }) => id), [task.id]);
});

test('a project that never left a record behind goes at any time, once its name is typed again', (t) => {
  const f = fixture(t);
  const id = f.ledger.createProject({ name: '空项目' }, USER);
  f.force('INSERT INTO front_desk (id, created_at, updated_at, bot, chat, sender, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)', 'fd1', 'now', 'now', 'b', 'c', 's', id);
  assert.deepEqual(f.ledger.projectDeletable(id), { allowed: true, reason: null, counts: [], scope_removed: [], canceled: [], reduced: [], finished: [] });
  assert.throws(() => f.ledger.deleteProject(id, '别的名字', USER), /确认删除要把项目名写全/);
  assert.equal(f.peek('SELECT 1 FROM project WHERE id = ?', id).length, 1, '名字不对什么都不删');
  f.ledger.deleteProject(id, '空项目', USER);
  assert.equal(f.peek('SELECT 1 FROM project WHERE id = ?', id).length, 0);
  assert.equal(f.peek('SELECT 1 FROM front_desk WHERE project_id = ?', id).length, 0, '只是指向它的选择，跟着走');
  const audit = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'project.delete'`).map((row) => JSON.parse(row.detail_json) as { project_id: string; name: string; counts: object; scope_removed: object; canceled: object; reduced: object; finished: object });
  assert.deepEqual(audit, [{ project_id: id, name: '空项目', counts: {}, scope_removed: {}, canceled: {}, reduced: {}, finished: {} }]);
  assert.throws(() => f.ledger.deleteProject(id, '空项目', USER), /项目不存在/);
});

test('a project with history cannot go until it is archived and its last round has ended', (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const before = f.ledger.projectDeletable(f.projectId);
  assert.deepEqual([before.allowed, before.reason], [false, '先归档才能删除']);
  assert.ok(before.counts.some(({ label, count }) => label === '工作' && count === 1));
  assert.throws(() => f.ledger.deleteProject(f.projectId, '试跑', USER), /先归档才能删除/);
  assert.equal(f.ledger.getProject(f.projectId).id, f.projectId, '拒绝后项目还在');

  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.task(task.id).revision }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const busy = f.ledger.projectDeletable(f.projectId);
  assert.deepEqual([busy.allowed, busy.reason], [false, '还有 1 轮在跑，等它们结束']);
  assert.ok(busy.counts.some(({ label, count }) => label === '轮次' && count === 1));
  assert.throws(() => f.ledger.deleteProject(f.projectId, '试跑', USER), /还有 1 轮在跑，等它们结束/);
  assert.equal(f.peek('SELECT 1 FROM project WHERE id = ?', f.projectId).length, 1);

  f.ledger.settleRun(run.id, null, null, { kind: 'lost', lost: { basis: 'presumed' } });
  assert.equal(f.ledger.projectDeletable(f.projectId).allowed, true);
  assert.throws(() => f.ledger.deleteProject(f.projectId, '不是这个名字', USER), /确认删除要把项目名写全/);
});

test('deleting an archived project clears what it owns, keeps what it shares, and lets the disk cleanup finish', async (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  const otherTask = f.ledger.createTask({ projectId: other, roleId: 'implement', title: '别的任务', goal: '做', acceptance: '好' }, USER);
  const otherMessage = f.ledger.receiveMessage({ channel: 'console', externalId: 'other-1', actor: 'user', text: '别处的话', projectId: other });

  const task = f.queuedTask();
  const revision = f.task(task.id).revision;
  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: revision }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE, { usage: [{ model: 'm', inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 }] });
  f.ledger.registerArtifacts(run.id, [], 'reg1');
  const released = registrationDir(f.dir, run.id, 'reg1');
  mkdirSync(released, { recursive: true });
  writeFileSync(join(released, 'report.md'), '报告');

  const extra = f.newTask();
  const projectMessage = f.ledger.receiveMessage({ channel: 'console', externalId: 'mine-1', actor: 'user', text: '这里的话', projectId: f.projectId });
  const segment = f.ledger.newTopic(f.projectId, USER);
  f.ledger.openContext({ projectId: f.projectId, segmentId: segment.id, marker: 'ctx', launch: {}, knowledge: {} });
  const trigger = f.ledger.createTrigger(f.projectId, {
    name: '早检', instruction: '检查', source: 'schedule',
    schedule: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() }, missed: 'skip',
  }, USER);
  // A tycho-wide inbound source that also lets the other project through: it belongs to whoever
  // calls, not to either project, so it stays and only loses the deleted project from its list.
  const source = f.ledger.createInboundSource({ name: '外部 CI', kind: 'tycho-v1', project_ids: [f.projectId, other], note: '外部来的' }, USER);
  f.force(`INSERT INTO trigger_fire (id, created_at, trigger_id, project_id, event_id, digest, revision, periodic, data_json, outcome, merged_count, push_final, keep_until)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, '{}', 'accepted', 0, 0, ?)`, 'fire1', 'now', trigger.id, f.projectId, 'ev1', 'd1', '2030-01-01T00:00:00.000Z');
  f.force(`INSERT INTO push (id, created_at, key, level, kind, project_id, payload_json, state) VALUES (?, ?, ?, 'result', 'work_ready', ?, '{}', 'held')`, 'push1', 'now', 'k1', f.projectId);
  f.force(`INSERT INTO front_desk (id, created_at, updated_at, bot, chat, sender, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, 'fd1', 'now', 'now', 'b', 'c', 's', f.projectId);
  f.force(`INSERT INTO approval (id, created_at, task_id, run_id, task_revision, questions_json, state, review_task_id)
    VALUES (?, ?, ?, NULL, 1, '[]', 'open', NULL)`, 'ap1', 'now', extra.id);
  // Another project's rows that point at this one: they stay, with the reference unpinned.
  f.force(`INSERT INTO approval (id, created_at, task_id, run_id, task_revision, questions_json, state, review_task_id)
    VALUES (?, ?, ?, NULL, 1, '[]', 'open', ?)`, 'ap2', 'now', otherTask.id, task.id);
  f.force(`UPDATE task SET review_of_json = ? WHERE id = ?`, JSON.stringify({ task_id: task.id, run_id: run.id, revision: 1, title: '', goal: '', scope: null, acceptance: null, commits: [], base: null, files: [], writers: [], at: 'now' }), otherTask.id);
  f.force(`INSERT INTO message (id, created_at, channel, external_id, direction, text, final, at, project_id, task_id)
    VALUES (?, ?, 'internal', ?, 'in', '别的项目里提到这个任务', 0, ?, ?, ?)`, 'msg-cross', 'now', 'cross-1', 'now', other, task.id);

  f.force(`INSERT INTO machine_invite (id, created_at, project_id, task_id, executors_json, expires_at, max_machines, revoked_at)
    VALUES (?, ?, ?, ?, '["claude"]', ?, 1, NULL)`, 'inv1', 'now', f.projectId, extra.id, '2030-01-01T00:00:00.000Z');
  f.force(`INSERT INTO machine_material (hash, invite_id, run_id, handed_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)`, 'hash1', 'inv1', run.id, 'now', '2030-01-01T00:00:00.000Z');
  // An input of this project's Task (a word the owner put in mid-round) goes with the Task, and
  // so does an approval that was already answered: their task_id is NOT NULL, so they cannot be
  // unpinned. An input of another project's Task only loses the round and the message it names.
  f.force(`INSERT INTO input (id, created_at, task_id, text, actor, message_id, state, run_id)
    VALUES ('in1', 'now', ?, '插一句话', 'user', ?, 'delivered', ?)`, extra.id, projectMessage.id, run.id);
  f.force(`INSERT INTO input (id, created_at, task_id, text, actor, message_id, state, run_id)
    VALUES ('in2', 'now', ?, '别处插的话', 'user', ?, 'delivered', ?)`, otherTask.id, projectMessage.id, run.id);
  f.force(`INSERT INTO approval (id, created_at, task_id, run_id, task_revision, questions_json, state, answers_json, answered_by, answered_via, decided_at)
    VALUES ('ap3', 'now', ?, NULL, 1, '[]', 'answered', '[{"q":"a"}]', 'user', 'console', 'now')`, extra.id);
  // Another project's trigger references this project's fire: its own merge and a kept Task's
  // trigger_fire_id. Both stay, unpinned.
  const otherTrigger = f.ledger.createTrigger(other, {
    name: '别处的早检', instruction: '检查', source: 'schedule',
    schedule: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() }, missed: 'skip',
  }, USER);
  f.force(`INSERT INTO trigger_fire (id, created_at, trigger_id, project_id, event_id, digest, revision, periodic, data_json, outcome, merged_into, merged_count, push_final, keep_until)
    VALUES ('fire-other', 'now', ?, ?, 'ev2', 'd2', 1, 0, '{}', 'accepted', 'fire1', 1, 0, ?)`, otherTrigger.id, other, '2030-01-01T00:00:00.000Z');
  f.force(`UPDATE task SET trigger_fire_id = 'fire1' WHERE id = ?`, otherTask.id);

  const projectEntry = ownerEntry(f, { project_ids: [f.projectId], title: '只属于这个项目' });
  const multiEntry = ownerEntry(f, { project_ids: [f.projectId, other], title: '两个项目共用' });
  const globalProposal = f.ledger.propose(knowledgeChange(
    { title: '全局规则', body: '适用于所有项目。', project_ids: null },
    { evidence: [{ source: 'task', ref: task.id, location: '任务', excerpt: '目标' }] },
  ), MCP, { actor: 'user' });
  assert.equal(globalProposal.state, 'published');
  // The invite points the machine at this project.
  f.force(`UPDATE machine SET invite_id = ? WHERE id = 'h1'`, 'inv1');

  const usageBefore = f.peek<{ n: number; input: number }>('SELECT count(*) AS n, COALESCE(SUM(input_tokens), 0) AS input FROM usage')[0]!;
  interface ChangeRow { id: string; created_at: string; at: string; actor: string; action: string; detail_json: string | null; task_id: string | null; run_id: string | null; message_id: string | null }
  const AUDIT = 'SELECT id, created_at, at, actor, action, detail_json, task_id, run_id, message_id FROM change ORDER BY seq';
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const changesBefore = f.peek<ChangeRow>(AUDIT);
  const info = f.ledger.projectDeletable(f.projectId);
  assert.equal(info.allowed, true);
  assert.ok(info.counts.some(({ label, count }) => label === '工作' && count === 2));
  assert.ok(info.counts.some(({ label, count }) => label === '轮次' && count === 1));
  assert.ok(info.counts.some(({ label, count }) => label === '触发器' && count === 1));
  // What is only really changed, not deleted, is said separately: the shared entry keeps its row
  // and loses this project from its scope, and so does the inbound source that let it through.
  assert.ok(info.scope_removed.some(({ label, count }) => label === '知识' && count === 1));
  assert.ok(info.scope_removed.some(({ label, count }) => label === '入站来源' && count === 1));
  assert.deepEqual(info.canceled, []);
  f.ledger.deleteProject(f.projectId, '试跑', USER);

  const n = (sql: string, ...params: string[]): number => {
    const rows = f.peek<{ n?: number }>(sql, ...params);
    return rows[0]?.n ?? rows.length;
  };
  assert.equal(n('SELECT 1 FROM project WHERE id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM task WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM run WHERE id = ?', run.id), 0);
  assert.equal(n('SELECT 1 FROM message WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM router_segment WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM router_context WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM trigger_rule WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM trigger_fire WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM trigger_cursor WHERE trigger_id = ?', trigger.id), 0);
  assert.equal(n('SELECT 1 FROM push WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM front_desk WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM approval WHERE id = ?', 'ap1'), 0);
  assert.equal(n('SELECT 1 FROM machine_invite WHERE project_id = ?', f.projectId), 0);
  assert.equal(n('SELECT 1 FROM machine_material WHERE invite_id = ?', 'inv1'), 0);
  assert.equal(n('SELECT 1 FROM machine WHERE id = ? AND invite_id IS NULL', 'h1'), 1);

  // What belongs elsewhere is untouched, and the reference to this project's rows is unpinned.
  assert.equal(n('SELECT 1 FROM project WHERE id = ?', other), 1);
  assert.equal(n('SELECT 1 FROM task WHERE id = ?', otherTask.id), 1);
  assert.equal(n('SELECT 1 FROM message WHERE id = ?', otherMessage.id), 1);
  // The inbound source kept its row, its name and its keys, with the gone project off its list.
  assert.deepEqual(f.ledger.getInboundSource(source.id)!.project_ids, [other]);
  assert.equal(f.ledger.getInboundSource(source.id)!.name, '外部 CI');
  const cross = f.peek<{ task_id: string | null; review_of_json: string | null; approval_review: string | null }>(
    `SELECT (SELECT task_id FROM message WHERE id = 'msg-cross') AS task_id,
            (SELECT review_of_json FROM task WHERE id = ?) AS review_of_json,
            (SELECT review_task_id FROM approval WHERE id = 'ap2') AS approval_review`, otherTask.id,
  )[0]!;
  assert.deepEqual({ ...cross }, { task_id: null, review_of_json: null, approval_review: null });
  // An input of a kept Task keeps the row and loses the round and the message it named; an input
  // and an answered approval of a deleted Task go with it (their task_id is not nullable).
  const keptInput = f.peek<{ task_id: string; message_id: string | null; run_id: string | null }>('SELECT task_id, message_id, run_id FROM input WHERE id = ?', 'in2')[0]!;
  assert.deepEqual({ ...keptInput }, { task_id: otherTask.id, message_id: null, run_id: null });
  assert.equal(n('SELECT 1 FROM input WHERE id = ?', 'in1'), 0, '项目任务的插话跟着任务删');
  assert.equal(n('SELECT 1 FROM approval WHERE id = ?', 'ap3'), 0, '已答审批卡跟着任务删');
  // A fire of another project merged into one of this project's, and a kept Task's trigger
  // reference: both rows stay, unpinned.
  assert.equal(n('SELECT 1 FROM trigger_fire WHERE id = ?', 'fire-other'), 1);
  const crossFire = f.peek<{ merged_into: string | null }>(`SELECT merged_into FROM trigger_fire WHERE id = 'fire-other'`)[0]!;
  assert.equal(crossFire.merged_into, null);
  const crossTask = f.peek<{ trigger_fire_id: string | null }>('SELECT trigger_fire_id FROM task WHERE id = ?', otherTask.id)[0]!;
  assert.equal(crossTask.trigger_fire_id, null);

  // Project-scoped knowledge goes; shared knowledge loses this project; global entry and its
  // evidence stay, with the deleted Task named in words instead of a dead id.
  assert.equal(n('SELECT 1 FROM knowledge WHERE id = ?', projectEntry), 0);
  assert.equal(n('SELECT 1 FROM knowledge WHERE id = ?', multiEntry), 1);
  const shared = f.peek<{ projects_json: string }>(
    `SELECT projects_json FROM knowledge_revision WHERE knowledge_id = ? AND revision = (SELECT revision FROM knowledge WHERE id = ?)`, multiEntry, multiEntry,
  )[0]!;
  assert.deepEqual(JSON.parse(shared.projects_json), [other]);
  const globalEvidence = f.peek<{ ref: string }>(`SELECT ref FROM knowledge_evidence WHERE proposal_id = ? AND source = 'task'`, globalProposal.id)[0]!;
  assert.equal(globalEvidence.ref, '来自已删除的项目 试跑');
  assert.equal(n(`SELECT 1 FROM knowledge_proposal WHERE id = ?`, globalProposal.id), 1);

  // The figures stay, and the row says what it was and which unit it stood for; only the link to
  // the round goes, so the usage page can still count it (docs/design/usage.md §4).
  const usageAfter = f.peek<{ n: number; input: number }>('SELECT count(*) AS n, COALESCE(SUM(input_tokens), 0) AS input FROM usage')[0]!;
  assert.deepEqual(usageAfter, usageBefore);
  assert.equal(n('SELECT count(*) AS n FROM usage WHERE run_id = ?', run.id), 0);
  assert.equal(n('SELECT count(*) AS n FROM usage WHERE run_id IS NOT NULL'), 0, '这个测试里没有别的轮次用量');
  const orphan = f.peek<{ dropped_source: string; dropped_unit: string; run_id: string | null; login_id: string | null; input_tokens: number }>(
    'SELECT dropped_source, dropped_unit, run_id, login_id, input_tokens FROM usage')[0]!;
  assert.deepEqual({ ...orphan }, {
    dropped_source: 'run', dropped_unit: `run:${run.id}`, run_id: null, login_id: run.login_id, input_tokens: 10,
  });
  // What the usage API hands the page: the row is a unit of its own with its project gone, and is
  // not passed off as a quota read of the login (docs/design/usage.md §4).
  const report = f.ledger.usageReport({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z', tzOffsetMinutes: 0 });
  const goneUnit = report.units.find(({ project_dropped }) => project_dropped)!;
  assert.deepEqual({ source: goneUnit.source, project_dropped: goneUnit.project_dropped, project_id: goneUnit.project_id, units: goneUnit.units, login_id: goneUnit.login_id },
    { source: 'run', project_dropped: true, project_id: null, units: 1, login_id: run.login_id });
  assert.deepEqual(report.units.filter(({ source }) => source === 'quota'), [], '不是一次额度查询');
  assert.equal(report.usage.find(({ project_dropped }) => project_dropped)!.input, 10);
  // The audit keeps every line it had, with its own content, and only the columns naming the
  // deleted rows are cleared; the deletion adds exactly its own line. Nothing is deleted, so a
  // row-by-row reading cannot pass on a coin toss the way a count can.
  const changesAfter = f.peek<ChangeRow>(AUDIT);
  const goneTasks = new Set([task.id, extra.id]);
  const goneRuns = new Set([run.id]);
  const goneMessages = new Set([projectMessage.id]);
  assert.deepEqual(changesAfter.slice(0, changesBefore.length).map((row) => ({ ...row })), changesBefore.map((row) => ({
    ...row,
    task_id: row.task_id !== null && goneTasks.has(row.task_id) ? null : row.task_id,
    run_id: row.run_id !== null && goneRuns.has(row.run_id) ? null : row.run_id,
    message_id: row.message_id !== null && goneMessages.has(row.message_id) ? null : row.message_id,
  })), '删除前的 change 行原样留着，只把指向被删行的外键置空');
  assert.deepEqual(changesAfter.slice(changesBefore.length).map(({ action }) => action), ['project.delete']);
  const audit = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'project.delete'`).map((row) => JSON.parse(row.detail_json) as { project_id: string; name: string; counts: Record<string, number>; scope_removed: Record<string, number>; canceled: Record<string, number>; reduced: Record<string, number>; finished: Record<string, number> });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.project_id, f.projectId);
  assert.equal(audit[0]!.name, '试跑');
  assert.equal(audit[0]!.counts['工作'], 2);
  assert.equal(audit[0]!.counts['轮次'], 1);
  assert.deepEqual(audit[0]!.scope_removed, { 知识: 1, 知识提议: 1, 入站来源: 1 });
  // The three fates of a knowledge task a deletion leaves pointless are three answers here too.
  assert.deepEqual(audit[0]!.canceled, {});
  assert.deepEqual(audit[0]!.reduced, {});
  assert.deepEqual(audit[0]!.finished, {});

  // What was on disk: the host's registered directory is removed by the sweep, and the
  // machine's copy is asked for by the retention pass; the cleanup row outlived the Run.
  const accept = createAcceptor({ ledger: f.ledger, dataDir: f.dir });
  const sent: { machineId: string; taskDir: string }[] = [];
  let declared = false;
  const retention = createRetention({
    ledger: {
      dropDueReleases: (now) => f.ledger.dropDueReleases(now),
      retentionDue: (now) => f.ledger.retentionDue(now),
      getMachine: (id) => f.ledger.getMachine(id),
      noteTaskCodeDropped: (taskId, machineId, nodeId) => f.ledger.noteTaskCodeDropped(taskId, machineId, nodeId),
    },
    nodes: { connected: () => true, reportedDropTaskCode: () => declared },
    channel: { async dropTaskCode(machineId, taskDir) { sent.push({ machineId, taskDir }); } },
    sweep: () => accept.sweep(),
    blocked: () => false,
    log: () => {},
  });
  const cleanup = f.peek<{ code_dropped_at: string | null; releases_dropped_at: string | null }>('SELECT code_dropped_at, releases_dropped_at FROM work_cleanup')[0]!;
  assert.equal(cleanup.code_dropped_at, null, '机器还没确认');
  await retention.runOnce();
  assert.deepEqual(sent, [], '旧客户端没声明，代码副本留到升级后');
  assert.equal(existsSync(released), false, '主机上登记的目录不等人，照样删掉了');
  declared = true;
  await retention.runOnce();
  assert.deepEqual(sent, [{ machineId: 'h1', taskDir: `tasks/${task.id}` }]);
  const after = f.peek<{ code_dropped_at: string | null; releases_dropped_at: string | null }>('SELECT code_dropped_at, releases_dropped_at FROM work_cleanup')[0]!;
  assert.ok(after.code_dropped_at !== null);
  assert.ok(after.releases_dropped_at !== null);
});

test('a version 37 ledger opens with every project in sight, and its rows of use survive the step column for column', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./fixtures/ledger/schema-v37.sql', import.meta.url), 'utf8'));
  // A run's, a Router context's and a login's use, so the rebuilt table has all three kinds to
  // carry over, not an empty one.
  db.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '37');
    INSERT INTO project (id, created_at, name) VALUES ('p', 'now', '旧项目');
    INSERT INTO task (id, created_at, project_id, title, goal, state, created_by) VALUES ('t', 'now', 'p', '一件工作', '目标', 'done', 'owner');
    INSERT INTO run (id, created_at, task_id, task_revision, host, state, marker, snapshot_json, started_at, ended_at)
      VALUES ('r', 'now', 't', 1, 'h', 'ended', 'm', '{"brief":"b","tier":"execute"}', '2026-11-10T01:00:00.000Z', '2026-11-10T01:00:30.000Z');
    INSERT INTO router_segment (id, created_at, project_id, seq, state) VALUES ('s', 'now', 'p', 1, 'closed');
    INSERT INTO router_context (id, created_at, segment_id, project_id, marker, state, login_id)
      VALUES ('c', 'now', 's', 'p', 'mc', 'closed', 'acct');
    INSERT INTO usage (id, at, run_id, context_id, login_id, model, model_basis, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, list_cost_usd)
      VALUES ('u1', '2026-11-10T01:00:30.000Z', 'r', NULL, NULL, 'm-run', 'reported', 10, 1, 2, 3, 0.5),
             ('u2', '2026-11-10T02:00:00.000Z', NULL, 'c', NULL, 'm-ctx', 'reported', 20, 2, 4, 6, NULL),
             ('u3', '2026-11-10T03:00:00.000Z', NULL, NULL, 'acct', 'm-quota', 'reported', 30, 3, 6, 9, 0.25);`);
  const columns = ['id', 'at', 'run_id', 'context_id', 'login_id', 'model', 'model_basis', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'list_cost_usd'];
  const before = db.prepare(`SELECT ${columns.join(', ')} FROM usage ORDER BY id`).all().map((row) => ({ ...row }));
  assert.equal(before.length, 3);
  db.close();
  assert.ok(SCHEMA_VERSION >= 46);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    assert.equal(ledger.getProject('p').archived_at, null);
    assert.equal(ledger.projectStopped('p'), null);
    const deletable = ledger.projectDeletable('p');
    assert.deepEqual([deletable.allowed, deletable.reason], [false, '先归档才能删除']);
  } finally { ledger.close(); }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
  const after = new DatabaseSync(path);
  try {
    // The step rebuilds the table to relax the owner check and add three columns, and to let a
    // count be absent: every value that was there is the value it is now, and the new columns
    // are empty on every old row.
    assert.deepEqual(after.prepare('SELECT * FROM usage ORDER BY id').all().map((row) => ({ ...row })),
      before.map((row) => ({ ...row, duration_ms: null, dropped_source: null, dropped_unit: null })));
    // The column order is the one the new schema declares, and both indices survive the rebuild.
    assert.deepEqual((after.prepare('PRAGMA table_info(usage)').all() as { name: string }[]).map(({ name }) => name),
      [...columns, 'duration_ms', 'dropped_source', 'dropped_unit']);
    // A count may be absent now: a round that reported nothing keeps its unit and its duration
    // with no figure at all (docs/design/usage.md §4).
    assert.deepEqual((after.prepare(`PRAGMA table_info(usage)`).all() as { name: string; notnull: number }[])
      .filter(({ name }) => ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].includes(name)).map(({ name, notnull }) => [name, notnull]),
      [['input_tokens', 0], ['output_tokens', 0], ['cache_read_tokens', 0], ['cache_write_tokens', 0]]);
    assert.deepEqual((after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`).all() as { name: string }[]).map(({ name }) => name),
      ['usage_at', 'usage_run']);
    // Zero owners is allowed now, and says what it was; two owners, or a mark with no unit, is not.
    after.exec(`INSERT INTO usage (id, at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ('u4', 'now', 0, 0, 0, 0);
      UPDATE usage SET dropped_source = 'run', dropped_unit = 'run:r' WHERE id = 'u4';`);
    assert.throws(() => after.exec(`INSERT INTO usage (id, at, run_id, context_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ('u5', 'now', 'r', 'c', 0, 0, 0, 0)`), /CHECK/);
    assert.throws(() => after.exec(`INSERT INTO usage (id, at, run_id, dropped_source, dropped_unit, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ('u6', 'now', 'r', 'run', 'run:r', 0, 0, 0, 0)`), /CHECK/);
    assert.throws(() => after.exec(`INSERT INTO usage (id, at, dropped_source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ('u7', 'now', 'run', 0, 0, 0, 0)`), /CHECK/);
  } finally { after.close(); }
});

test('an archived project waits for its Router to go idle before it can be deleted', (t) => {
  const f = fixture(t);
  f.queuedTask();
  const segment = f.ledger.newTopic(f.projectId, USER);
  const context = f.ledger.openContext({ projectId: f.projectId, segmentId: segment.id, marker: 'ctx-live', launch: {}, knowledge: {} });
  f.ledger.setContextStarted(context.id, 4242);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const blocked = f.ledger.projectDeletable(f.projectId);
  assert.deepEqual([blocked.allowed, blocked.reason], [false, '负责人还在处理，等它空闲退出后再删']);
  assert.throws(() => f.ledger.deleteProject(f.projectId, '试跑', USER), /负责人还在处理/);
  assert.equal(f.peek('SELECT 1 FROM router_context WHERE id = ?', context.id).length, 1, '拒绝后上下文还在，进程清点的依据没丢');
  // The scan saw no process of it: the context row stays, nothing of it runs, and the project
  // can go — the deletion is not the place that stops processes.
  f.ledger.setContextCleared(context.id);
  assert.equal(f.ledger.projectDeletable(f.projectId).allowed, true);
  f.ledger.deleteProject(f.projectId, '试跑', USER);
  assert.equal(f.peek('SELECT 1 FROM router_context WHERE project_id = ?', f.projectId).length, 0);
});

test('a no-project knowledge curation task with nothing left is given up, never deleted, and is not counted as one of the project’s works', (t) => {
  const f = fixture(t);
  f.queuedTask();
  const entry = ownerEntry(f, { project_ids: [f.projectId], title: '只属于这个项目' });
  const curationTask = f.ledger.curate({ entries: [entry], reason: '需要整理' }, USER);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const info = f.ledger.projectDeletable(f.projectId);
  assert.equal(info.allowed, true);
  assert.deepEqual(info.counts.filter(({ label }) => label === '工作'), [{ label: '工作', count: 1, unit: '项' }], '整理任务不算这个项目的工作');
  assert.deepEqual(info.canceled, [{ label: '知识把关/整理任务', count: 1, unit: '个' }]);
  assert.deepEqual(info.reduced, [], '没有剩余材料可缩减');
  assert.deepEqual(info.finished, [], '这个整理还没结束');
  f.ledger.deleteProject(f.projectId, '试跑', USER);
  const kept = f.peek<{ project_id: string | null; state: string; knowledge_json: string | null }>('SELECT project_id, state, knowledge_json FROM task WHERE id = ?', curationTask)[0]!;
  assert.deepEqual({ ...kept }, { project_id: null, state: 'abandoned', knowledge_json: null }, '整理任务留着，只断了指向被删条目的引用');
  assert.equal(f.peek('SELECT 1 FROM knowledge WHERE id = ?', entry).length, 0);
});

test('a project waits for a running knowledge curation before it may go, and clears its reference once it ends', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(GATE, USER, 'ref-g1');
  f.queuedTask();
  const entry = ownerEntry(f, { project_ids: [f.projectId], title: '只属于这个项目' });
  const curationTask = f.task(f.ledger.curate({ entries: [entry], reason: '需要整理' }, USER));
  const run = f.ledger.createRun(curationTask.id, {
    login: GATE, machine: f.ledger.getMachine('h1')!, expectedRevision: curationTask.revision,
    snapshot: { brief: 'b', timeout_ms: 60_000, knowledge: f.ledger.applicable(curationTask.project_id, curationTask.role_id).map(givenOf) },
  }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const busy = f.ledger.projectDeletable(f.projectId);
  assert.deepEqual([busy.allowed, busy.reason], [false, '还有 1 个知识把关或整理任务在跑，等它们结束']);
  assert.throws(() => f.ledger.deleteProject(f.projectId, '试跑', USER), /知识把关或整理任务在跑/);
  assert.equal(f.peek('SELECT 1 FROM task WHERE id = ?', run.task_id).length, 1, '正在跑的整理任务和它那一轮都还在');
  assert.equal(f.peek('SELECT 1 FROM run WHERE id = ?', run.id).length, 1);
  settleGate(f, run, { result: 'reject', reason: '无需改动' });
  const after = f.ledger.projectDeletable(f.projectId);
  assert.equal(after.allowed, true);
  // It is over: the deletion gives nothing up, it only stops naming what goes. Said apart from
  // what would really be abandoned (project-sessions, "项目的生命周期").
  assert.deepEqual(after.canceled, []);
  assert.deepEqual(after.reduced, []);
  assert.deepEqual(after.finished, [{ label: '知识把关/整理任务', count: 1, unit: '个' }]);
  f.ledger.deleteProject(f.projectId, '试跑', USER);
  const kept = f.peek<{ state: string; knowledge_json: string | null }>('SELECT state, knowledge_json FROM task WHERE id = ?', run.task_id)[0]!;
  assert.deepEqual({ ...kept }, { state: 'done', knowledge_json: null }, '已经完成的整理任务留着，只断了引用');
});

test('a curation with something left to do is not given up: it stays queued with less material', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  f.queuedTask();
  const mine = ownerEntry(f, { project_ids: [f.projectId], title: '只属于这个项目' });
  const theirs = ownerEntry(f, { project_ids: [other], title: '别的项目的条目' });
  const curation = f.ledger.curate({ entries: [mine, theirs], reason: '太大了' }, USER);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const info = f.ledger.projectDeletable(f.projectId);
  assert.equal(info.allowed, true);
  assert.deepEqual(info.canceled, [], '还有东西可整理，不放弃它');
  assert.deepEqual(info.reduced, [{ label: '知识把关/整理任务', count: 1, unit: '个' }]);
  assert.deepEqual(info.finished, []);
  f.ledger.deleteProject(f.projectId, '试跑', USER);
  // The Task keeps its place and its record; only the entry that went is gone from its material.
  const task = f.peek<{ state: string; knowledge_json: string }>('SELECT state, knowledge_json FROM task WHERE id = ?', curation)[0]!;
  assert.equal(task.state, 'queued');
  assert.deepEqual(JSON.parse(task.knowledge_json), { kind: 'curation', entries: [theirs], reasons: ['太大了'] });
  assert.equal(f.peek('SELECT 1 FROM knowledge WHERE id = ?', mine).length, 0);
  // The audit says the same three things the confirmation did.
  const audit = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'project.delete'`)
    .map((row) => JSON.parse(row.detail_json) as { canceled: object; reduced: object; finished: object })[0]!;
  assert.deepEqual([audit.canceled, audit.reduced, audit.finished], [{}, { '知识把关/整理任务': 1 }, {}]);
});

test("a kept waiting proposal left pinning a deleted project's knowledge goes stale, and a curation loses the entry", (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  f.queuedTask();
  const entry = ownerEntry(f, { project_ids: [f.projectId], title: '只属于这个项目' });
  const shared = ownerEntry(f, { project_ids: [f.projectId, other], title: '两个项目共用' });
  const pinned = f.ledger.propose(knowledgeChange({ project_ids: null, loading: 'resident', title: '全局常驻规则' }, {
    inputs: [{ knowledge_id: entry, revision: 1, disposition: 'keep', note: '相关' }],
  }), MCP, { actor: 'user' });
  assert.equal(pinned.state, 'awaiting_owner');
  const curation = f.ledger.curate({ entries: [entry], reason: '太大了' }, USER);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  const info = f.ledger.projectDeletable(f.projectId);
  assert.equal(info.allowed, true);
  assert.ok(info.scope_removed.some(({ label, count }) => label === '知识' && count === 1), '共用的条目只是去掉本项目');
  f.ledger.deleteProject(f.projectId, '试跑', USER);

  // The waiting proposal that pinned the gone entry is stale by the same rule a moved pin takes.
  const stale = f.ledger.getProposal(pinned.id);
  assert.equal(stale.state, 'stale');
  assert.match(stale.state_reason!, /已随项目“试跑”删除/);
  // The curation had only the gone entry left: it is given up, and nothing names the dead id.
  const curationTask = f.peek<{ state: string; knowledge_json: string | null }>('SELECT state, knowledge_json FROM task WHERE id = ?', curation)[0]!;
  assert.deepEqual({ ...curationTask }, { state: 'abandoned', knowledge_json: null });
  // What was only this project's is gone; the shared entry keeps its row, without it.
  assert.equal(f.peek('SELECT 1 FROM knowledge WHERE id = ?', entry).length, 0);
  assert.equal(f.peek('SELECT 1 FROM knowledge WHERE id = ?', shared).length, 1);
  const scopes = f.peek<{ projects_json: string }>(
    `SELECT projects_json FROM knowledge_revision WHERE knowledge_id = ? AND revision = (SELECT revision FROM knowledge WHERE id = ?)`, shared, shared,
  )[0]!;
  assert.deepEqual(JSON.parse(scopes.projects_json), [other]);
});

test('a published proposal keeps its row when one of its two entries goes, and does not name the dead entry', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '别的项目' }, USER);
  f.queuedTask();
  // One proposal publishing two entries: one only this project's, one another project's. The
  // second keeps its revision's proposal alive, so the proposal survives its project.
  const proposal = f.ledger.propose(knowledgeChange({}, {
    outputs: [
      output({ title: '只属于这个项目', project_ids: [f.projectId] }),
      output({ title: '别的项目的条目', project_ids: [other] }),
    ],
  }), MCP, { actor: 'user' });
  const published = f.ledger.getProposal(proposal.id);
  assert.equal(published.state, 'published');
  const made = published.final!.outputs.map(({ knowledge_id: id }) => id!);
  assert.equal(made.length, 2);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  f.ledger.deleteProject(f.projectId, '试跑', USER);
  // The proposal survived (one of its entries did), and the entry that went is no longer named
  // by an id out of its published result.
  assert.equal(f.peek('SELECT 1 FROM knowledge_proposal WHERE id = ?', proposal.id).length, 1);
  assert.equal(f.peek('SELECT 1 FROM knowledge WHERE id = ?', made[0]!).length, 0);
  assert.equal(f.peek('SELECT 1 FROM knowledge WHERE id = ?', made[1]!).length, 1);
  const after = f.ledger.getProposal(proposal.id);
  assert.deepEqual(after.final!.outputs.map(({ knowledge_id: id }) => id ?? null), [null, made[1]!]);
  // The frozen change itself is untouched: still the two outputs as submitted.
  assert.deepEqual(after.change.outputs.map(({ title }) => title), ['只属于这个项目', '别的项目的条目']);
});

test("a deleted project's disk cleanup is picked up again after a restart, and only what is really gone is confirmed", async (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.task(task.id).revision }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE, {});
  f.ledger.registerArtifacts(run.id, [], 'reg1');
  const released = registrationDir(f.dir, run.id, 'reg1');
  mkdirSync(released, { recursive: true });
  writeFileSync(join(released, 'report.md'), '报告');
  f.ledger.setProjectArchived(f.projectId, true, USER);
  f.ledger.deleteProject(f.projectId, '试跑', USER);
  // The deletion only recorded what goes; no sweep ran yet, so the bytes are still there and the
  // row names both parts as still to do.
  const pending = (): { releases_dropped_at: string | null; code_dropped_at: string | null } =>
    f.peek<{ releases_dropped_at: string | null; code_dropped_at: string | null }>('SELECT releases_dropped_at, code_dropped_at FROM work_cleanup')[0]!;
  assert.deepEqual({ ...pending() }, { releases_dropped_at: null, code_dropped_at: null });
  assert.equal(existsSync(released), true);
  // The service stopped and started again on the same file: the ledger is closed for real
  // before it is opened again, so what the new one reads is what is in the file.
  f.ledger.close();
  const restarted = f.open();
  assert.deepEqual({ ...pending() }, { releases_dropped_at: null, code_dropped_at: null }, '重启不改账本里记下的东西');
  const accept = createAcceptor({ ledger: restarted, dataDir: f.dir });
  const sent: { machineId: string; taskDir: string }[] = [];
  let declared = false;
  const retention = createRetention({
    ledger: restarted,
    nodes: { connected: () => true, reportedDropTaskCode: () => declared },
    channel: { async dropTaskCode(machineId, taskDir) { sent.push({ machineId, taskDir }); } },
    sweep: () => accept.sweep(),
    blocked: () => false,
    log: () => {},
  });
  // The host's registered directory does not wait for the machine; the machine's copy does, and
  // an old client that never says how is left for the upgrade.
  await retention.runOnce();
  assert.equal(existsSync(released), false);
  assert.deepEqual(sent, [], '旧客户端没声明，代码副本留到升级后');
  assert.deepEqual({ releases_dropped_at: pending().releases_dropped_at !== null, code_dropped_at: pending().code_dropped_at !== null },
    { releases_dropped_at: true, code_dropped_at: false }, '哪一部分真的做完了就落哪一笔');
  declared = true;
  await retention.runOnce();
  assert.deepEqual(sent, [{ machineId: 'h1', taskDir: `tasks/${task.id}` }]);
  assert.ok(pending().releases_dropped_at !== null && pending().code_dropped_at !== null, '两部分都确认了');
  accept.sweep();
  assert.equal(f.count('work_cleanup'), 1, '没有别的待清理记录了');
});

test('deleting a project cleans up pending outbox rows referencing its deleted records without touching unrelated outbox rows', (t) => {
  const f = fixture(t);
  const otherProject = f.ledger.createProject({ name: '留存项目' }, USER);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.task(task.id).revision }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE, {});
  const msg = f.ledger.receiveMessage({ channel: 'console', externalId: 'del-msg', actor: 'user', projectId: f.projectId, text: '要删的消息' });

  f.ledger.enqueueNotification('wecom', 'markdown', { external_id: 'del-md', project_id: f.projectId, content: '项目通知' });
  f.ledger.enqueueNotification('wecom', 'verify', { external_id: 'del-verify', finding: 'residue', task_id: task.id, run_id: run.id });
  f.ledger.enqueueNotification('wecom', 'assign', { external_id: 'del-assign', message_id: msg.id });
  f.ledger.enqueueNotification('wecom', 'markdown', { external_id: 'keep-md', project_id: otherProject, content: '保留通知' });

  f.ledger.setProjectArchived(f.projectId, true, USER);
  f.ledger.deleteProject(f.projectId, '试跑', USER);

  const remaining = f.peek<{ payload_json: string }>(`SELECT payload_json FROM outbox WHERE state = 'pending'`)
    .map((r) => (JSON.parse(r.payload_json) as { external_id?: string }).external_id);
  assert.equal(remaining.includes('del-md'), false);
  assert.equal(remaining.includes('del-verify'), false);
  assert.equal(remaining.includes('del-assign'), false);
  assert.equal(remaining.includes('keep-md'), true, '其他项目的待发通知不受影响');
});

test('project single-category grouping, pinning, validation, and atomic category rename/dissolve persist cleanly', (t) => {
  const f = fixture(t);
  const p1 = f.ledger.createProject({ name: '网关', category: '  基础设施  ', pinned: true }, USER);
  const p2 = f.ledger.createProject({ name: '监控', category: '基础设施' }, USER);
  const p3 = f.ledger.createProject({ name: '杂项' }, USER);

  assert.equal(f.ledger.getProject(p1).category, '基础设施');
  assert.equal(f.ledger.getProject(p1).pinned, 1);
  assert.equal(f.ledger.getProject(p2).category, '基础设施');
  assert.equal(f.ledger.getProject(p2).pinned, 0);
  assert.equal(f.ledger.getProject(p3).category, null);

  // Validation rejects control chars and overly long category names.
  assert.throws(() => f.ledger.setProjectCategory(p3, 'a\nb', USER), InputError);
  assert.throws(() => f.ledger.setProjectCategory(p3, 'a'.repeat(41), USER), InputError);

  // Atomic rename updates every project in that category.
  assert.equal(f.ledger.renameProjectCategory('基础设施', '集群运维', USER), 2);
  assert.equal(f.ledger.getProject(p1).category, '集群运维');
  assert.equal(f.ledger.getProject(p2).category, '集群运维');

  // Dissolving clears matching projects back to null without deleting them.
  assert.equal(f.ledger.renameProjectCategory('集群运维', null, USER), 2);
  assert.equal(f.ledger.getProject(p1).category, null);
  assert.equal(f.ledger.getProject(p2).category, null);

  // Toggling pin records only when changed.
  f.ledger.setProjectPinned(p1, false, USER);
  f.ledger.setProjectPinned(p1, false, USER);
  assert.equal(f.ledger.getProject(p1).pinned, 0);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'project.pin'`).length, 1);
});
