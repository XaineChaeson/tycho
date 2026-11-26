// Guards a review from starting on another node with only a list of file names,
// reading changed output from an earlier Worker, or importing unbounded output.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reviewArtifactSnapshot } from '../service/accept.ts';
import { registrationDir } from '../service/releases.ts';
import type { HeldArtifacts } from '../service/review.ts';
import { prepareSnapshot, snapshotFiles } from '../runner/snapshot.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { claudeTier, fixture, RUN_LIMIT_MS, USER, DONE } from './helpers.ts';

test('a remote review snapshot carries verified registered report text and explains unavailable files', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  const registration = 'registration1';
  const dir = registrationDir(f.dir, run.id, registration);
  mkdirSync(dir, { recursive: true });
  const bodies = new Map([
    ['report.md', Buffer.from('\uFEFF报告正文\n')],
    ['binary.dat', Buffer.from([0xff, 0x00])],
    ['large.txt', Buffer.alloc(1024 * 1024, 0x41)],
    ['changed.md', Buffer.from('expected\n')],
  ]);
  const files = [...bodies].map(([name, body]) => {
    writeFileSync(join(dir, name), name === 'changed.md' ? 'not-the-original' : body);
    return { name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  });
  const held: HeldArtifacts = {
    run_id: run.id, task_id: task.id, registration: { id: registration, at: run.created_at, files },
    registered: [registration], problem: null, releases_dropped_at: null,
  };
  const binding = { task_id: task.id, run_id: run.id, files };
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.registerArtifacts(run.id, files, registration);
  const review = f.ledger.createTask({ projectId: f.projectId, title: '审阅', goal: '审阅', roleId: 'review',
    reviewOf: { taskId: task.id, runId: run.id, revision: task.revision, registration } }, USER);
  const snapshot = prepareSnapshot(review, {
    id: 'reviewer', name: 'reviewer', executor: 'claude', tiers: { execute: claudeTier('/d') },
  }, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS, permission: 'read' });
  assert.deepEqual(snapshot.review_artifacts, binding);
  assert.match(snapshot.brief, /review-files\/manifest\.md/);
  const copy = reviewArtifactSnapshot(f.dir, held, binding);
  const wire = snapshotFiles(snapshot, copy);
  assert.deepEqual(wire.find((file) => file.path === 'review-files/files/report.md'), { path: 'review-files/files/report.md', text: '\uFEFF报告正文\n' });
  const manifest = wire.find((file) => file.path === 'review-files/manifest.md')!.text;
  assert.match(manifest, /binary\.dat.+UTF-8/u);
  assert.match(manifest, /large\.txt.+上限/u);
  assert.match(manifest, /changed\.md.+登记/u);
  assert.ok(!JSON.stringify(wire).includes('not-the-original'));
  assert.ok(!JSON.stringify(snapshot).includes('报告正文'));

  const expired = reviewArtifactSnapshot(f.dir, { ...held, releases_dropped_at: run.created_at }, binding);
  assert.deepEqual(expired.map((file) => file.path), ['review-files/manifest.md']);
  assert.match(expired[0]!.text, /保留期/);
  const foreign = reviewArtifactSnapshot(f.dir, { ...held, task_id: 'other' }, binding);
  assert.deepEqual(foreign.map((file) => file.path), ['review-files/manifest.md']);
});
