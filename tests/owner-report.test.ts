import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consoleApp, TOOL_TOKEN } from './console-helpers.ts';
import { DONE, USER } from './helpers.ts';
import { registrationDir } from '../service/releases.ts';
import { readRunReport, reportFilesOf } from '../service/reports.ts';

test('owner can read an ended Run report before accepting without registering or changing its product', async (t) => {
  const app = await consoleApp(t, { runner: { readReportFile: async (_run, name) => {
    assert.equal(name, 'report.md');
    return Buffer.from('实际命令输出：验证完成\n');
  } } });
  const { task, run } = app.f.runningRun();
  const ref = 'runs/' + run.id + '/artifacts/report.md';
  app.f.ledger.settleRun(run.id, 0, { ...DONE, artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref }] });
  const before = app.f.ledger.artifactsOfRun(run.id);
  const response = await app.get('/api/runs/' + run.id + '/report?ref=' + encodeURIComponent(ref));
  assert.equal(response.status, 200);
  const report = await response.json() as { text: string; source: string };
  assert.equal(report.text, '实际命令输出：验证完成\n');
  assert.equal(report.source, 'node');
  assert.equal(app.f.ledger.getTask(task.id).state, 'ready');
  assert.deepEqual(app.f.ledger.artifactsOfRun(run.id), before);
  assert.equal((await app.get('/api/runs/' + run.id + '/report?ref=' + encodeURIComponent(ref), { Authorization: 'Bearer ' + TOOL_TOKEN })).status, 401);
  assert.equal((await fetch(app.url + '/api/runs/' + run.id + '/report?ref=' + encodeURIComponent(ref))).status, 401);
  const page = await (await app.get('/api/tasks/' + task.id)).json() as { runs: { report_files: { ref: string; name: string }[] }[] };
  assert.deepEqual(page.runs[0]!.report_files, [{ ref, name: 'report.md' }]);
  app.f.ledger.acceptTask(task.id, '主人读过报告', USER, { withoutReview: true });
  assert.equal((await app.get('/api/runs/' + run.id + '/report?ref=' + encodeURIComponent(ref))).status, 200);
});

test('only this ended Run receipt can authorize safe report paths; only the canonical final-message reference is additionally offered', async (t) => {
  let reads = 0;
  const app = await consoleApp(t, { runner: { readReportFile: async () => { reads++; return Buffer.from('ok'); } } });
  const { run } = app.f.runningRun();
  assert.equal((await app.get('/api/runs/' + run.id + '/report?ref=report.md')).status, 400);
  const refs = ['report.md', 'artifacts/report.md', 'runs/' + run.id + '/artifacts/report.md', 'artifacts/sub/report.md', '../secret', '/tmp/tasks/' + run.task_id + '/runs/other/artifacts/report.md', '最后一条消息', 'C:\\report.md', '/report.md', 'artifacts/../secret', 'artifacts/CON.md', 'artifacts/report.md.'];
  app.f.ledger.settleRun(run.id, 0, { ...DONE, artifacts: refs.map(ref => ({ kind: 'report', ref })) });
  const ended = app.f.ledger.getRun(run.id);
  const reports = reportFilesOf(ended);
  assert.deepEqual(reports.map(report => report.ref), refs);
  assert.deepEqual(reports.slice(0, 3), refs.slice(0, 3).map(ref => ({ ref, name: 'report.md' })));
  assert.deepEqual(reports[3], { ref: 'artifacts/sub/report.md', name: 'sub/report.md' });
  assert.deepEqual(reports[6], { ref: '最后一条消息', name: '最后回复', kind: 'final_message', state: 'unavailable' });
  assert.ok(reports.filter((_, i) => i >= 4 && i !== 6).every(report => report.kind === 'invalid'));
  for (const [i, ref] of refs.entries()) {
    const response = await app.get('/api/runs/' + run.id + '/report?ref=' + encodeURIComponent(ref));
    assert.equal(response.status, i < 4 ? 200 : 400, ref);
  }
  assert.equal((await app.get('/api/runs/' + run.id + '/report?ref=unlisted.md')).status, 400);
  assert.equal(reads, 4);
});

test('a registered report stays readable from history after acceptance without rebinding independent review', async (t) => {
  const app = await consoleApp(t, { runner: { readReportFile: async () => { throw new Error('must not query node'); } } });
  const { task, run } = app.f.runningRun();
  app.f.ledger.settleRun(run.id, 0, DONE);
  const body = Buffer.from('已登记报告\n');
  const files = [{ name: 'report.md', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }];
  const dir = registrationDir(app.f.dir, run.id, 'report-registration');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), body);
  app.f.ledger.registerArtifacts(run.id, files, 'report-registration');
  const review = app.f.ledger.createTask({ projectId: app.f.projectId, title: '独立审阅', goal: '核对报告', roleId: 'review', reviewOf: { taskId: task.id, runId: run.id, revision: task.revision, registration: 'report-registration' } }, USER);
  const before = app.f.ledger.getTask(review.id).review_of_json;
  const registration = app.f.ledger.artifactsOfRun(run.id);
  const path = '/api/runs/' + run.id + '/report?ref=report.md';
  assert.deepEqual(await (await app.get(path)).json(), {
    run_id: run.id, ref: 'report.md', name: 'report.md', text: body.toString(), source: 'registered',
    complete: true, bytes: body.length, original_bytes: body.length, sha256: files[0]!.sha256,
  });
  assert.equal(app.f.ledger.getTask(review.id).review_of_json, before);
  assert.deepEqual(app.f.ledger.artifactsOfRun(run.id), registration);
  app.f.ledger.acceptTask(task.id, '主人读过报告', USER, { withoutReview: true });
  assert.equal((await app.get(path)).status, 200);
  writeFileSync(join(dir, 'report.md'), '变动后的内容');
  const changed = await app.get(path);
  assert.equal(changed.status, 400);
  assert.match((await changed.json() as { error: string }).error, /登记摘要/);
});

test('unavailable, oversized, binary and expired reports say why instead of offering acceptance', async (t) => {
  let body = Buffer.from('ok');
  let problem: string | undefined;
  const app = await consoleApp(t, { runner: { readReportFile: async () => { if (problem) throw new Error(problem); return body; } } });
  const { task, run } = app.f.runningRun();
  app.f.ledger.settleRun(run.id, 0, DONE);
  const path = '/api/runs/' + run.id + '/report?ref=report.md';
  for (const value of [Buffer.from([0xff]), Buffer.from('a\u0000b'), Buffer.alloc(128 * 1024 + 1)]) {
    body = value;
    const response = await app.get(path);
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /UTF-8|上限/);
  }
  problem = '执行节点失联';
  const offline = await app.get(path);
  assert.equal(offline.status, 400);
  assert.match((await offline.json() as { error: string }).error, /节点失联/);
  app.f.force('UPDATE run SET releases_dropped_at=? WHERE id=?', '2026-11-14T00:00:00.000Z', run.id);
  const expired = await app.get(path);
  assert.equal(expired.status, 400);
  assert.match((await expired.json() as { error: string }).error, /保留期/);
  assert.equal(app.f.ledger.getTask(task.id).state, 'ready');
});

test('registered report lookup rejects foreign Run, Task and unsafe registration identity before disk access', async (t) => {
  const app = await consoleApp(t);
  const { task, run } = app.f.runningRun();
  app.f.ledger.settleRun(run.id, 0, DONE);
  app.f.ledger.registerArtifacts(run.id, [], 'registration');
  const held = app.f.ledger.artifactsOfRun(run.id)!;
  const ended = app.f.ledger.getRun(run.id);
  for (const altered of [
    { ...held, run_id: 'another-run' },
    { ...held, task_id: task.id + '-other' },
    { ...held, registration: { ...held.registration!, id: '../outside' } },
  ]) {
    await assert.rejects(readRunReport({ run: ended, ref: 'report.md', dataDir: app.f.dir, held: altered }), /与这一轮不符/);
  }
});

// Unsupported declared reports remain visible to the owner and never trigger file or recovery I/O.
test('owner sees an unsupported declared report and is told to rework before any I/O', async t => {
  let reads = 0;
  const app = await consoleApp(t, { runner: { readReportFile: async () => { reads++; return Buffer.from('must not read'); } } });
  const { task, run } = app.f.runningRun();
  const ref = '本条最终消息中的核验报告';
  app.f.ledger.settleRun(run.id, 0, { ...DONE, artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref }] });
  const page = await (await app.get(`/api/tasks/${task.id}`)).json() as { runs: { report_files: { kind?: string; ref: string; problem?: string }[] }[] };
  const report = page.runs[0]!.report_files[0]!;
  assert.equal(report.ref, ref);
  assert.equal(report.kind, 'invalid');
  assert.match(report.problem!, /无法识别/);
  const response = await app.get(`/api/runs/${run.id}/report?ref=${encodeURIComponent(ref)}`);
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /无法识别/);
  let recovered = 0;
  await assert.rejects(readRunReport({ run: app.f.ledger.getRun(run.id), ref, dataDir: '/nonexistent-report-test', held: undefined,
    readNode: async () => { reads++; throw new Error('unexpected node read'); },
    recoverFinal: async () => { recovered++; throw new Error('unexpected recovery'); } }), /无法识别/);
  assert.equal(reads, 0);
  assert.equal(recovered, 0);
  assert.equal(app.f.ledger.getTask(task.id).state, 'ready');
});
