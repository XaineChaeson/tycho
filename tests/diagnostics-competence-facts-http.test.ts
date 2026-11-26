// Guards the signed-in console routes against missing diagnostic evidence or download headers,
// invalid competence windows being accepted, and execution facts producing an unusable draft.
import './guard.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ulid } from '../service/ids.ts';
import type { CompetenceReport } from '../shared/competence.ts';
import type { RunDiagnosticsBundle } from '../shared/run-diagnostics.ts';
import type { TaskRunFacts } from '../shared/run-facts.ts';
import { consoleApp } from './console-helpers.ts';
import { DONE, USER } from './helpers.ts';

test('run diagnostics expose evidence as JSON and as a named attachment', async (t) => {
  const app = await consoleApp(t);
  const { task, run } = app.f.runningRun();
  app.emitRun(run.id, { kind: 'tool.start', id: 'tool-1', category: 'run', name: 'shell', title: 'Run migration' });
  app.emitRun(run.id, { kind: 'diagnostic', level: 'fatal', message: 'Migration index missing' });
  app.emitRun(run.id, {
    kind: 'usage',
    usage: [{ model: 'reported-model', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }],
  });
  app.f.ledger.settleRun(run.id, 1, { status: 'failed', summary: 'Migration failed' });

  const path = `/api/runs/${run.id}/diagnostics`;
  const response = await app.get(path);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  const bundle = await response.json() as RunDiagnosticsBundle;
  assert.equal(bundle.schema_version, 1);
  assert.equal(bundle.run.id, run.id);
  assert.equal(bundle.first_error?.source, 'diagnostic');
  assert.equal(bundle.first_error.message, 'Migration index missing');
  assert.equal(bundle.tools.unfinished_count, 1);
  assert.equal(bundle.tools.unfinished_tools[0]?.title, 'Run migration');
  assert.deepEqual(bundle.models.reported_models, ['reported-model']);
  assert.deepEqual(bundle.coverage, {
    events_loaded: true, events_count: 3, dropped_before_index: 0, incomplete_reason: null, stderr_loaded: false,
  });
  assert.equal(bundle.snapshot?.goal, task.goal);
  assert.equal(bundle.trace?.run_id, run.id);
  assert.equal(bundle.trace.task_id, task.id);

  const download = await app.get(`${path}?download=1`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /^application\/json\b/);
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="tycho-run-${run.id}-diagnostics.json"`);
  const { generated_at: downloadedAt, ...downloaded } = await download.json() as RunDiagnosticsBundle;
  const { generated_at: generatedAt, ...inline } = bundle;
  assert.ok(Number.isFinite(Date.parse(downloadedAt)));
  assert.ok(Number.isFinite(Date.parse(generatedAt)));
  assert.deepEqual(downloaded, inline);
});

test('diagnostics for a run absent from the ledger return 404', async (t) => {
  const app = await consoleApp(t);
  const response = await app.get(`/api/runs/${ulid()}/diagnostics`);
  assert.equal(response.status, 404);
});

test('competence reports a settled round in range and rejects invalid bounds', async (t) => {
  const app = await consoleApp(t);
  const { run } = app.f.runningRun();
  app.f.ledger.settleRun(run.id, 1, { status: 'failed', summary: 'Migration failed' });
  const end = Date.parse(app.f.run(run.id).ended_at!);
  const from = new Date(end - 60_000).toISOString();
  const to = new Date(end + 60_000).toISOString();
  const path = (from: string, to: string) => `/api/usage/competence?${new URLSearchParams({ from, to })}`;

  const response = await app.get(path(from, to));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  const report = await response.json() as CompetenceReport;
  assert.equal(report.from, from);
  assert.equal(report.to, to);
  assert.equal(report.min_sample_size, 5);
  assert.deepEqual(report.summary, { total_rounds: 1, reviewed_rounds: 0, escalated_rounds: 0, total_list_cost_usd: 0 });
  assert.equal(report.rows.length, 1);
  const [row] = report.rows;
  assert.ok(row);
  assert.equal(row.login_id, run.login_id);
  assert.equal(row.executor, 'claude');
  assert.equal(row.tier, 'execute');
  assert.equal(row.rounds, 1);
  assert.equal(row.failed_rounds, 1);
  assert.equal(row.first_pass_rate, null);
  assert.equal(row.advice.kind, 'insufficient');

  assert.equal((await app.get(path('not-a-date', to))).status, 400);
  assert.equal((await app.get(path(from, 'not-a-date'))).status, 400);
  assert.equal((await app.get(path(to, from))).status, 400);
});

test('a clean task has no draft and repeated failures yield a draft accepted by the proposal route', async (t) => {
  const app = await consoleApp(t);
  const { f } = app;
  const clean = f.runningRun();
  f.ledger.settleRun(clean.run.id, 0, DONE);
  const cleanResponse = await app.get(`/api/tasks/${clean.task.id}/facts`);
  assert.equal(cleanResponse.status, 200);
  assert.deepEqual(await cleanResponse.json(), {
    task_id: clean.task.id, project_id: f.projectId, analyzed_runs: 1, failed_rounds: 0, escalations: 0,
    noteworthy: false, noteworthy_reasons: [], ping_pong: [], tool_repeats: [], error_facts: [], proposal_draft: null,
    coverage: { loaded_runs: 1, incomplete_runs: 0, reasons: [] },
  } satisfies TaskRunFacts);

  const { task, run } = f.runningRun();
  const failure = { status: 'failed', summary: 'Migration failed: users_email_idx is missing' };
  f.ledger.settleRun(run.id, 1, failure);
  f.ledger.resumeTask(task.id, USER);
  const retry = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.task(task.id).revision }, USER);
  f.ledger.markRunRunning(retry.id);
  f.ledger.settleRun(retry.id, 1, failure);

  const response = await app.get(`/api/tasks/${task.id}/facts`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  const facts = await response.json() as TaskRunFacts;
  assert.equal(facts.task_id, task.id);
  assert.equal(facts.project_id, f.projectId);
  assert.equal(facts.analyzed_runs, 2);
  assert.equal(facts.failed_rounds, 2);
  assert.equal(facts.noteworthy, true);
  assert.ok(facts.noteworthy_reasons.length > 0);
  const draft = facts.proposal_draft;
  assert.ok(draft);
  assert.deepEqual(draft.outputs[0]?.project_ids, [f.projectId]);

  const submitted = await app.post('/api/knowledge/proposals', draft);
  assert.equal(submitted.status, 201);
  const proposal = await submitted.json() as { id: string; duplicate: boolean };
  assert.ok(proposal.id);
  assert.equal(proposal.duplicate, false);
  assert.ok(f.ledger.getProposal(proposal.id).evidence.some((item) => item.source === 'run' && item.ref === run.id && item.verified));
});
