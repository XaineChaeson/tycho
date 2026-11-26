// A successful receipt retried before the Router takes its next turn must not wake it.
// A different late response and newly reported facts still reach the audit and the Router.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DONE, fixture } from './helpers.ts';

function clearRouter(f: ReturnType<typeof fixture>): string[] {
  const ids: string[] = [];
  for (let turn = f.ledger.takeNextTurn(f.projectId); turn !== undefined; turn = f.ledger.takeNextTurn(f.projectId)) {
    for (const message of [turn.message, ...turn.attached]) {
      ids.push(message.external_id);
      f.ledger.finishMessage(message.id, 'processed');
    }
  }
  return ids;
}

test('an exact retry adds no handoff before or after the original was taken', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  const opts = { sessionRef: 'same-session', sourceHead: { kind: 'folder' as const, head: 'abc123' } };
  assert.equal(f.ledger.settleRun(run.id, 0, DONE, opts).late, false);
  assert.equal(f.ledger.settleRun(run.id, 0, { artifacts: DONE.artifacts, summary: DONE.summary, status: 'done' }, opts).late, true);
  assert.deepEqual(clearRouter(f), [`run:${run.id}`]);
  assert.equal(f.ledger.settleRun(run.id, 0, DONE, opts).late, true);
  assert.deepEqual(clearRouter(f), []);

  const changed = { ...opts, sourceHead: { ...opts.sourceHead, head: 'def456' } };
  assert.equal(f.ledger.settleRun(run.id, 0, DONE, changed).late, true);
  assert.deepEqual(clearRouter(f), [`run:${run.id}:late:1`]);
  const late = f.ledger.listChanges({ taskId: task.id }).filter(({ action }) => action === 'run.settle_late');
  assert.equal(late.length, 1);
  assert.match(f.run(run.id).error_json ?? '', /def456/);
});

test('a late receipt after a lost round remains evidence and reaches the Router', (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  clearRouter(f);
  assert.equal(f.ledger.settleRun(run.id, 0, DONE).late, true);
  assert.deepEqual(clearRouter(f), [`run:${run.id}:late:1`]);
  assert.match(f.run(run.id).error_json ?? '', /late_results/);
});
