// Feedback is an owner's audit, never a task input, a new round, or a knowledge publication.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProjectHome } from '../service/project-home.ts';
import { openLedger } from '../service/ledger.ts';
import { exportProjectHandoff, freezeProjectHandoff, importProjectHandoff, stageProjectHandoff } from '../service/project-home-transfer.ts';
import { fixture, USER } from './helpers.ts';

test('feedback persists in the existing audit with the actual task and run revisions, without dispatch or publishing', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: '验证', roleId: 'implement', goal: '目标', acceptance: '报告' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, f.login, USER);
  f.force('UPDATE task SET revision = revision + 1 WHERE id = ?', task.id);
  const before = ['task', 'run', 'input', 'knowledge', 'knowledge_proposal', 'message', 'outbox'].map((table) => f.count(table));
  const saved = f.ledger.addTaskFeedback(task.id, { kind: 'slow', note: '等待原机器太久', run_id: run.id }, USER);
  assert.deepEqual({ ...saved, id: undefined, created_at: undefined }, {
    id: undefined, created_at: undefined, actor: USER.actor, task_id: task.id, task_revision: task.revision + 1,
    run_id: run.id, run_revision: run.task_revision, kind: 'slow', note: '等待原机器太久',
  });
  assert.deepEqual(f.ledger.listTaskFeedback(task.id), [saved]);
  const audit = f.ledger.listChanges({ taskId: task.id }).find(({ action }) => action === 'task.feedback')!;
  assert.equal(audit.run_id, run.id);
  assert.equal(JSON.parse(audit.detail_json!).project_id, f.projectId);
  assert.deepEqual(['task', 'run', 'input', 'knowledge', 'knowledge_proposal', 'message', 'outbox'].map((table) => f.count(table)), before);
  assert.deepEqual(f.open().listTaskFeedback(task.id), [saved]);
});

test('a closed task can receive task-wide feedback; foreign or invented sources and malformed fields leave no feedback', (t) => {
  const f = fixture(t);
  const create = (projectId: string) => f.ledger.createTask({ projectId, title: '验证', roleId: 'implement', goal: '目标', acceptance: '报告' }, USER);
  const task = create(f.projectId);
  f.ledger.abandonTask(task.id, '结束', USER);
  const other = create(f.ledger.createProject({ name: '其他项目', loginMode: 'all' }, USER));
  f.ledger.queueTask(other.id, USER);
  const run = f.ledger.createRun(other.id, f.login, USER);
  const saved = f.ledger.addTaskFeedback(task.id, { kind: 'reuse' }, USER);
  assert.equal(saved.run_id, null);
  assert.equal(saved.run_revision, null);
  assert.equal(saved.note, null);
  for (const body of [{ kind: 'incorrect', run_id: run.id }, { kind: 'slow', run_id: 'missing' }, { kind: 'other' }, { kind: 'reuse', note: 7 }, { kind: 'slow', note: '字'.repeat(2049) }, { kind: 'reuse', task_revision: 900 }]) {
    assert.throws(() => f.ledger.addTaskFeedback(task.id, body, USER));
  }
  assert.throws(() => f.ledger.listTaskFeedback('missing'), /不存在/);
  assert.deepEqual(f.ledger.listTaskFeedback(task.id), [saved]);
});

test('archived projects reject feedback and the persistent project-home guard also refuses a frozen project', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-feedback-home-'));
  const home = createProjectHome(join(dir, 'authority'));
  const target = createProjectHome(join(dir, 'target'));
  t.after(() => { home.close(); target.close(); rmSync(dir, { recursive: true, force: true }); });
  const f = fixture(t, { projectHome: home });
  const task = f.ledger.createTask({ projectId: f.projectId, title: '验证', roleId: 'verify', goal: '目标', acceptance: '报告' }, USER);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  assert.throws(() => f.ledger.addTaskFeedback(task.id, { kind: 'reuse' }, USER), /归档/);
  f.ledger.setProjectArchived(f.projectId, false, USER);
  const hash = createHash('sha256').update('frozen').digest('hex');
  const ownership = f.ledger.projectHome(f.projectId)!;
  // Freeze the real source authority; the ledger's regular change trigger owns the refusal.
  home.freezeForTransfer({ project_id: f.projectId, target: target.identity.id, bundle_sha256: hash }, {
    service_id: home.identity.id, generation: ownership.generation!,
  }, () => hash);
  assert.throws(() => f.ledger.addTaskFeedback(task.id, { kind: 'incorrect' }, USER), /冻结/);
  assert.deepEqual(f.ledger.listTaskFeedback(task.id), []);
});

test('a portable project takes its feedback through the existing audit handoff without a second feedback store', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-feedback-transfer-'));
  const sourceDir = join(dir, 'source');
  const targetDir = join(dir, 'target');
  const sourceHome = createProjectHome(sourceDir);
  const targetHome = createProjectHome(targetDir);
  const source = openLedger(join(sourceDir, 'ledger.db'), { projectHome: sourceHome });
  const target = openLedger(join(targetDir, 'ledger.db'), { projectHome: targetHome });
  const opened = [source, target];
  t.after(() => { for (const ledger of opened) ledger.close(); sourceHome.close(); targetHome.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = source.createProject({ name: '便携反馈', loginMode: 'all' }, USER);
  const task = source.createTask({ projectId: project, title: '报告', roleId: 'verify', goal: '验证', acceptance: '报告' }, USER);
  source.setProjectPaused(project, true, USER);
  const feedback = source.addTaskFeedback(task.id, { kind: 'reuse', note: '报告格式值得复用' }, USER);
  source.close();
  target.close();
  const bytes = exportProjectHandoff(sourceDir, project);
  const to = stageProjectHandoff(targetDir, bytes, sourceHome.identity);
  const receipt = freezeProjectHandoff(sourceDir, bytes, to.id);
  importProjectHandoff(targetDir, bytes, receipt);
  const moved = openLedger(join(targetDir, 'ledger.db'), { projectHome: targetHome });
  opened.push(moved);
  assert.deepEqual(moved.listTaskFeedback(task.id), [feedback]);
});
