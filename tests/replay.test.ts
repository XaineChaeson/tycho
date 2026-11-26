// Prevents a replay from comparing against fabricated outcomes or exporting raw project,
// account, credential, receipt, or artifact details from the original ledger.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineCases, compareReadyNotice, exportReadyNoticeDraft, parseReadyNoticeCase } from '../scripts/replay-ready-notice.ts';
import { fixture, USER } from './helpers.ts';

test('frozen cases reproduce the actual notification sequence and only save the expected Router turns', async () => {
  for (const input of baselineCases) {
    const first = await compareReadyNotice(input);
    assert.deepEqual(await compareReadyNotice(input), first, input.case_id);
    assert.deepEqual(first.failures, [], input.case_id);
    assert.equal(first.external_effects, 0);
    assert.deepEqual(first.baseline.notifications, first.candidate.notifications);
    assert.equal(first.baseline.router_turns.length - first.candidate.router_turns.length, input.expected.saved_router_turns);
  }
});

test('the parser rejects hidden data and inherited metadata cannot substitute for a judge result', async () => {
  const input = baselineCases[0]!;
  assert.throws(() => parseReadyNoticeCase({ ...input, raw_trajectory: 'Private data' }), /字段/);
  const wrong = parseReadyNoticeCase({ ...input, expected: { ...input.expected, saved_router_turns: 0 } });
  assert.notDeepEqual((await compareReadyNotice(wrong)).failures, []);
});

test('projection from a real ledger exports only structural information, and the draft requires promotion', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({
    projectId: f.projectId, roleId: 'verify', title: 'unique-private-title',
    goal: 'unique-private-goal', acceptance: 'unique-private-acceptance', onReady: 'notify_owner',
  }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id,
    { ...f.login, snapshot: { ...f.login.snapshot, brief: 'unique-private-brief', tier: 'operate', credential_ref: 'unique-private-ref' } },
    USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.registerArtifacts(run.id, [{ name: 'unique-private-file.md', sha256: 'b'.repeat(64), bytes: 35 }]);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: 'unique-private-summary', artifacts: [{ kind: 'report', ref: '/private/unique-private-path' }] });
  const prior = f.dump();
  const draft = exportReadyNoticeDraft(f.path, run.id, 'release');
  assert.deepEqual(exportReadyNoticeDraft(f.path, run.id, 'release'), draft);
  const text = JSON.stringify(draft);
  assert.doesNotMatch(text, /unique-private|bbbbbbbbbbbb/);
  for (const id of [task.id, run.id, f.projectId]) assert.ok(!text.includes(id));
  assert.equal(draft.observed.receipt, 'report');
  assert.equal(draft.observed.registered_report_files, 1);
  assert.equal(draft.observed.owner_notice_requested, true);
  assert.throws(() => parseReadyNoticeCase(draft), /草稿/);
  assert.deepEqual(f.dump(), prior);
});
