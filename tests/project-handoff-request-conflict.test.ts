import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { openLedger } from '../service/ledger.ts';
import { createProjectHome } from '../service/project-home.ts';
import { exportProjectHandoff, stageProjectHandoff, freezeProjectHandoff, importProjectHandoff } from '../service/project-home-transfer.ts';
import { create, OWNER_SAYS, OWNER } from './knowledge-helpers.ts';
import { USER } from './helpers.ts';

function sites(t: TestContext, sourceRequest: string | null, targetRequest: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'tycho-handoff-request-')), a = join(root, 'source'), b = join(root, 'target');
  const ah = createProjectHome(a), bh = createProjectHome(b);
  const source = openLedger(join(a, 'ledger.db'), { projectHome: ah }), target = openLedger(join(b, 'ledger.db'), { projectHome: bh });
  const p = source.createProject({ name: 'Source P', loginMode: 'all' }, USER), q = target.createProject({ name: 'Target Q', loginMode: 'all' }, USER);
  const input = create({ title: 'P knowledge', body: 'source P body', project_ids: [p] }, sourceRequest === null ? {} : { request_id: sourceRequest });
  const other = create({ title: 'Q knowledge', body: 'target Q body', project_ids: [q] }, targetRequest === null ? {} : { request_id: targetRequest });
  const incoming = source.propose(input, OWNER_SAYS, OWNER), existing = target.propose(other, OWNER_SAYS, OWNER);
  const qBefore = JSON.stringify({ project: target.getProject(q), proposals: target.listProposals(), entries: target.listEntries({ includeRetired: true }) });
  source.setProjectPaused(p, true, USER); source.close(); target.close();
  t.after(() => { ah.close(); bh.close(); rmSync(root, { recursive: true, force: true }); });
  const readTarget = () => openLedger(join(b, 'ledger.db'), { projectHome: bh });
  return { a, b, ah, bh, p, q, incoming, existing, input, other, qBefore, readTarget };
}
function conflict(error: unknown, source: string, target: string): boolean {
  return error instanceof Error && error.message.includes(source) && error.message.includes(target);
}

test('stage rejects the existing Console request identity before freeze and preserves both projects', t => {
  const f = sites(t, 'publish-1', 'publish-1'); assert.notEqual(f.incoming.id, f.existing.id);
  const bytes = exportProjectHandoff(f.a, f.p);
  let failure: unknown;
  try { stageProjectHandoff(f.b, bytes, f.ah.identity); } catch (error) { failure = error; }
  console.log(JSON.stringify({ event: 'request-conflict-stage', sourceProposal: f.incoming.id, targetProposal: f.existing.id, sourcePhase: f.ah.describe(f.p, { service_id: f.ah.identity.id, generation: 1 }).phase, targetPPhase: f.bh.describe(f.p).phase, error: failure instanceof Error ? failure.message : null }));
  assert.ok(conflict(failure, f.incoming.id, f.existing.id), 'stage must reject and name source and target proposals before source freezes');
  assert.equal(f.ah.describe(f.p, { service_id: f.ah.identity.id, generation: 1 }).phase, 'owned');
  assert.equal(f.bh.describe(f.p).phase, 'unknown');
  const target = f.readTarget();
  try {
    assert.equal(JSON.stringify({ project: target.getProject(f.q), proposals: target.listProposals(), entries: target.listEntries({ includeRetired: true }) }), f.qBefore);
    assert.equal(target.listProjects().some(project => project.id === f.p), false);
  } finally { target.close(); }
  const source = openLedger(join(f.a, 'ledger.db'), { projectHome: f.ah });
  try { source.setProjectPaused(f.p, false, USER); assert.equal(source.getProject(f.p).paused_at, null); } finally { source.close(); }
});

for (const [sourceRequest, targetRequest] of [[null, null], ['publish-1', 'publish-2']] as const) {
  test(`nonconflicting request identities transfer unchanged (${sourceRequest}/${targetRequest})`, t => {
    const f = sites(t, sourceRequest, targetRequest), bytes = exportProjectHandoff(f.a, f.p);
    const staged = stageProjectHandoff(f.b, bytes, f.ah.identity), receipt = freezeProjectHandoff(f.a, bytes, staged.id);
    importProjectHandoff(f.b, bytes, receipt); importProjectHandoff(f.b, bytes, receipt);
    const target = f.readTarget();
    try {
      assert.equal(target.getProposal(f.incoming.id).id, f.incoming.id);
      assert.equal(JSON.stringify(target.getProject(f.q)), JSON.stringify(JSON.parse(f.qBefore).project));
      assert.equal(JSON.stringify(target.getProposal(f.existing.id)), JSON.stringify(JSON.parse(f.qBefore).proposals[0]));
      if (sourceRequest !== null) assert.deepEqual(target.propose(f.input, OWNER_SAYS, OWNER), { id: f.incoming.id, duplicate: true, state: 'published' });
    } finally { target.close(); }
  });
}

test('import readiness rechecks a request introduced after staging without rewriting either proposal', t => {
  const f = sites(t, 'publish-1', null), bytes = exportProjectHandoff(f.a, f.p);
  const staged = stageProjectHandoff(f.b, bytes, f.ah.identity);
  const target = f.readTarget();
  let late: string, before: string;
  try {
    late = target.propose(create({ title: 'later Q knowledge', body: 'later Q body', project_ids: [f.q] }, { request_id: 'publish-1' }), OWNER_SAYS, OWNER).id;
    before = JSON.stringify({ project: target.getProject(f.q), proposals: target.listProposals(), entries: target.listEntries({ includeRetired: true }) });
  } finally { target.close(); }
  const receipt = freezeProjectHandoff(f.a, bytes, staged.id);
  for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => importProjectHandoff(f.b, bytes, receipt), error => conflict(error, f.incoming.id, late));
  assert.equal(f.bh.describe(f.p).phase, 'incoming');
  const checked = f.readTarget();
  try {
    assert.equal(JSON.stringify({ project: checked.getProject(f.q), proposals: checked.listProposals(), entries: checked.listEntries({ includeRetired: true }) }), before);
    assert.equal(checked.listProjects().some(project => project.id === f.p), false);
  } finally { checked.close(); }
});
