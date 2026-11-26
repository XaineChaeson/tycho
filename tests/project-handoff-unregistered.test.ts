import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openLedger } from '../service/ledger.ts';
import { createProjectHome } from '../service/project-home.ts';
import { createAcceptor } from '../service/accept.ts';
import { exportProjectHandoff, stageProjectHandoff, freezeProjectHandoff, importProjectHandoff } from '../service/project-home-transfer.ts';
import { registrationDir } from '../service/releases.ts';
import { holdMachine, MACHINE, LOGIN, USER } from './helpers.ts';

async function project(t: TestContext, declaresFile: boolean, files?: 'real' | 'empty') {
  const root = mkdtempSync(join(tmpdir(), 'tycho-unregistered-handoff-')), source = join(root, 'source'), target = join(root, 'target');
  const ah = createProjectHome(source), bh = createProjectHome(target);
  const a = openLedger(join(source, 'ledger.db'), { projectHome: ah }), b = openLedger(join(target, 'ledger.db'), { projectHome: bh });
  let closed = false;
  t.after(() => { if (!closed) { a.close(); b.close(); } ah.close(); bh.close(); rmSync(root, { recursive: true, force: true }); });
  const p = a.createProject({ name: '登记前置', loginMode: 'all' }, USER);
  const role = { ...a.getRole('analyse')!, permission: 'write' as const, default_tier: 'execute' as const };
  a.putRole(role, USER); b.putRole(role, USER); a.setWhitelist({ console: ['user'] }, USER);
  holdMachine(a, MACHINE);
  const login = { id: 'synthetic-account', name: 'synthetic', executor: 'claude', tiers: LOGIN.login.tiers };
  a.putAccount(login, USER, 'synthetic-reference');
  const task = a.createTask({ projectId: p, title: '结束轮次', goal: '报告', acceptance: '正式报告与声明材料齐全', roleId: 'analyse' }, USER); a.queueTask(task.id, USER);
  const run = a.createRun(task.id, { ...LOGIN, login, machine: a.getMachine(MACHINE.id)!, snapshot: { ...LOGIN.snapshot, access: { permission: 'write', layer: 'tools', args: [] } } }, USER);
  a.markRunRunning(run.id);
  const receipt = { status: 'done', summary: '完成', artifacts: [{ kind: 'report', ref: '最后一条消息' }, ...(declaresFile ? [{ kind: 'file', ref: '/not-a-portable-path/../../do-not-open' }] : [])] };
  a.settleRun(run.id, 0, receipt, { finalReply: '正式最后回复' });
  const body = Buffer.from([0, 255, 10, 20]);
  const file = { name: 'proof.bin', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const register = async (mode: 'real' | 'empty') => {
    const acceptor = createAcceptor({ ledger: a, dataDir: source, runner: { fetchArtifacts: async (_run, into) => {
      if (mode === 'empty') return { files: [], problem: null };
      mkdirSync(into, { recursive: true }); writeFileSync(join(into, file.name), body); return { files: [file], problem: null };
    } } });
    return acceptor.register(task.id);
  };
  if (files) await register(files);
  return { root, source, target, ah, bh, a, b, p, task, run, file, body, register,
    finish() {
      if (a.getTask(task.id).state !== 'done') a.acceptTask(task.id, 'Owner已核对正式回复', { actor: 'console' }, { withoutReview: true });
      a.pushTick(new Date('2099-01-01')); for (const row of a.outbox.takeDue(new Date('2099-01-01'))) a.outbox.markSent(row.id);
      a.setProjectPaused(p, true, USER); a.close(); b.close(); closed = true;
    },
  };
}
function transfer(f: Awaited<ReturnType<typeof project>>) {
  const bytes = exportProjectHandoff(f.source, f.p), staged = stageProjectHandoff(f.target, bytes, f.ah.identity);
  importProjectHandoff(f.target, bytes, freezeProjectHandoff(f.source, bytes, staged.id));
  return JSON.parse(bytes.toString()) as { files: { run_id: string; registration_id: string; name: string }[] };
}

test('file declaration without registration is refused before handoff rather than silently exporting files=[]', async t => {
  const f = await project(t, true); assert.equal(f.a.artifactsOfRun(f.run.id)?.registration ?? null, null); f.finish();
  assert.throws(() => exportProjectHandoff(f.source, f.p), error => error instanceof Error && error.message.includes(f.run.id) && /取回.*登记/.test(error.message) && /不可达|无法核实/.test(error.message));
  assert.equal(f.ah.describe(f.p, { service_id: f.ah.identity.id, generation: 1 }).phase, 'owned');
});

test('a final-message-only report needs no file registration and remains portable', async t => {
  const f = await project(t, false); f.finish(); assert.equal(transfer(f).files.length, 0);
  const b = openLedger(join(f.target, 'ledger.db'), { projectHome: f.bh }); try { assert.equal(b.runReport(f.run.id)?.text, '正式最后回复'); } finally { b.close(); }
});

test('normal Acceptor registration supplies the materials without reading the arbitrary receipt ref', async t => {
  const f = await project(t, true); const registered = await f.register('real'); f.finish(); assert.equal(transfer(f).files.length, 1);
  assert.equal(readFileSync(join(registrationDir(f.target, f.run.id, registered.registration), f.file.name)).equals(f.body), true);
});

test('an empty registration still does not supply a declared file', async t => {
  const f = await project(t, true, 'empty'); f.finish(); assert.throws(() => exportProjectHandoff(f.source, f.p), new RegExp(f.run.id));
});

test('a retained historical registration remains portable after a later empty registration', async t => {
  const f = await project(t, true); const first = await f.register('real'); await f.register('empty'); f.finish();
  const bundle = transfer(f); assert.equal(bundle.files.length, 1); assert.equal(bundle.files[0]!.registration_id, first.registration);
});

test('an existing drop fact remains portable without resurrecting the registered bytes', async t => {
  const f = await project(t, true, 'real'); f.a.acceptTask(f.task.id, '核对', { actor: 'console' }, { withoutReview: true });
  assert.ok(f.a.dropDueReleases(new Date('2099-01-01')).some(row => row.run_id === f.run.id));
  f.finish(); assert.equal(transfer(f).files.length, 0);
  const b = openLedger(join(f.target, 'ledger.db'), { projectHome: f.bh }); try { assert.ok(b.getRun(f.run.id).releases_dropped_at); } finally { b.close(); }
});


test('a blocked handoff can proceed after normal source refetch and registration recover the materials', async t => {
  const f = await project(t, true); f.finish();
  assert.throws(() => exportProjectHandoff(f.source, f.p), new RegExp(f.run.id));
  const recovered = openLedger(join(f.source, 'ledger.db'), { projectHome: f.ah });
  try {
    const acceptor = createAcceptor({ ledger: recovered, dataDir: f.source, runner: { fetchArtifacts: async (_run, into) => {
      mkdirSync(into, { recursive: true }); writeFileSync(join(into, f.file.name), f.body); return { files: [f.file], problem: null };
    } } });
    await acceptor.refetch(f.task.id);
    assert.equal(recovered.getRun(f.run.id).receipt_json, JSON.stringify({ status: 'done', summary: '完成', artifacts: [{ kind: 'report', ref: '最后一条消息' }, { kind: 'file', ref: '/not-a-portable-path/../../do-not-open' }] }));
  } finally { recovered.close(); }
  assert.equal(transfer(f).files.length, 1);
});
