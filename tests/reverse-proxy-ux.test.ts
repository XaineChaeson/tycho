import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../service/db.ts';
import { doctor } from '../service/doctor.ts';
import { openLedger } from '../service/ledger.ts';
import { createSettings } from '../service/settings.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture } from './helpers.ts';
import { ownerEntry } from './knowledge-helpers.ts';

const OWNER = { actor: 'console:owner' };
const ROUTER = { actor: 'router' };

test('doctor validates reverseProxyPort, HTTPS publicUrl requirement, and codexHealth', (t) => {
  const f = fixture(t);
  const settings = createSettings({ ledger: f.ledger });
  settings.set('http.port', 8799, OWNER);
  settings.set('http.reverseProxyPort', 8800, OWNER);
  settings.set('http.publicUrl', 'https://tycho.example.com', OWNER);
  const baseInput = {
    dataDir: f.dir,
    settings,
    claude: { command: null, path: null, problem: 'no claude', login: { loggedIn: null, detail: '' } },
    router: { alive: false, error: null },
    routerLogin: { executor: 'codex', account: 'codex 账号', token: true, codexHealth: { level: 'ok' as const, text: 'Codex 命令可用，托管授权已通过额度查询验证' } },
    listening: { host: '127.0.0.1', port: 8799, reverseProxyPort: 8800 },
    logins: [],
    wecomSecretSet: false,
  };
  const okChecks = doctor(baseInput);
  const addrOk = okChecks.find((c) => c.id === 'address')!;
  const gwOk = okChecks.find((c) => c.id === 'gateway')!;
  const codexOk = okChecks.find((c) => c.id === 'codex-router')!;
  assert.equal(addrOk.level, 'ok');
  assert.match(addrOk.text, /8800/);
  assert.equal(gwOk.level, 'ok');
  assert.match(gwOk.text, /反向代理/);
  assert.equal(codexOk.level, 'ok');

  // Pending restart warning when saved reverseProxyPort differs from listening port.
  const restartWarn = doctor({ ...baseInput, listening: { host: '127.0.0.1', port: 8799, reverseProxyPort: 0 } }).find((c) => c.id === 'address')!;
  assert.equal(restartWarn.level, 'warn');
  assert.match(restartWarn.text, /重启/);

  // Non-HTTPS publicUrl fails when reverseProxyPort is active.
  settings.set('http.publicUrl', 'http://tycho.example.com', OWNER);
  const nonHttps = doctor(baseInput).find((c) => c.id === 'address')!;
  assert.equal(nonHttps.level, 'fail');
  assert.match(nonHttps.text, /HTTPS/);
});

test('archived projects stay out of overview todo, counts, approvals, and summary', async (t) => {
  const app = await consoleApp(t);
  const { f } = app;
  const activeProj = f.projectId;
  const archivedProj = f.ledger.createProject({ name: '已归档测试项目' }, OWNER);

  // Create ready + waiting + held tasks in both projects.
  const activeTask = f.ledger.createTask({ projectId: activeProj, title: '活跃待验收', goal: 'g', acceptance: 'a', roleId: 'verify' }, OWNER);
  const archivedReady = f.ledger.createTask({ projectId: archivedProj, title: '归档待验收', goal: 'g', acceptance: 'a', roleId: 'verify' }, OWNER);
  const archivedHeld = f.ledger.createTask({ projectId: archivedProj, title: '归档已挂起', goal: 'g', acceptance: 'a', roleId: 'verify' }, OWNER);
  const archivedWait = f.ledger.createTask({ projectId: archivedProj, title: '归档等你决定', goal: 'g', acceptance: 'a', roleId: 'verify' }, OWNER);

  for (const tid of [activeTask.id, archivedReady.id, archivedHeld.id, archivedWait.id]) {
    f.ledger.queueTask(tid, OWNER);
  }
  f.db().run(`UPDATE task SET state = 'ready' WHERE id IN (?, ?)`, activeTask.id, archivedReady.id);
  f.ledger.holdTask(archivedHeld.id, '暂停', OWNER);
  f.ledger.openApproval(archivedWait.id, [{ question: '要继续吗？', options: ['要', '不要'] }], OWNER);

  // Archive archivedProj.
  f.ledger.setProjectArchived(archivedProj, true, OWNER);

  const ov = await (await app.get('/api/overview')).json() as {
    counts: { ready: number; waiting: number; moving: number };
    approvals: { project_id: string | null }[];
    held: { project_id: string | null }[];
    moving: { project_id: string | null }[];
    recent: { project_id: string | null }[];
  };
  assert.equal(ov.counts.ready, 1, '归档项目的待验收任务不计入总览计数');
  assert.equal(ov.counts.waiting, 0, '归档项目的待决定任务不计入总览等待计数');
  assert.equal(ov.approvals.length, 0, '归档项目的审批卡不出现在总览待办');
  assert.equal(ov.held.length, 0, '归档项目的已停住任务不出现在总览待办');
});

test('owner and router can accept, abandon, and retire without typing a reason; rework still requires a note', async (t) => {
  const app = await consoleApp(t);
  const { f } = app;

  // 1. Owner normal accept with empty basis succeeds (defaults to '主人验收通过').
  const tAccept = f.ledger.createTask({ projectId: f.projectId, title: '免填验收', goal: 'g', acceptance: 'a', roleId: 'verify' }, OWNER);
  f.ledger.queueTask(tAccept.id, OWNER);
  f.db().run(`UPDATE task SET state = 'ready' WHERE id = ?`, tAccept.id);
  const resAccept = await app.send('POST', `/api/tasks/${tAccept.id}/accept`, { basis: '' });
  assert.equal(resAccept.status, 200);
  assert.equal(f.task(tAccept.id).state, 'done');

  // 2. Rework still requires non-empty note.
  const tGate = f.ledger.createTask({ projectId: f.projectId, title: '需审阅验收', goal: 'g', acceptance: 'a', roleId: 'implement' }, OWNER);
  f.ledger.queueTask(tGate.id, OWNER);
  f.db().run(`UPDATE task SET state = 'ready' WHERE id = ?`, tGate.id);
  const resRework = await app.send('POST', `/api/tasks/${tGate.id}/rework`, { note: '', revision: f.task(tGate.id).revision });
  assert.equal(resRework.status, 400);

  // 3. Owner without_review accept also allows empty basis (defaults to '主人验收通过').
  const resNoReview = await app.send('POST', `/api/tasks/${tGate.id}/accept`, { basis: '   ', without_review: true });
  assert.equal(resNoReview.status, 200);
  assert.equal(f.task(tGate.id).state, 'done');

  // 4. Router accept also allows empty basis (defaults to '验收通过').
  const tRouter = f.ledger.createTask({ projectId: f.projectId, title: '负责人验收', goal: 'g', acceptance: 'a', roleId: 'verify' }, OWNER);
  f.ledger.queueTask(tRouter.id, OWNER);
  f.db().run(`UPDATE task SET state = 'ready' WHERE id = ?`, tRouter.id);
  f.ledger.acceptTask(tRouter.id, '', ROUTER);
  assert.equal(f.task(tRouter.id).state, 'done');

  // 5. Owner abandon with empty reason succeeds (defaults to '主人放弃').
  const tAbandon = f.ledger.createTask({ projectId: f.projectId, title: '免填放弃', goal: 'g', acceptance: 'a', roleId: 'verify' }, OWNER);
  const resAbandon = await app.send('POST', `/api/tasks/${tAbandon.id}/abandon`, { reason: '' });
  assert.equal(resAbandon.status, 200);
  assert.equal(f.task(tAbandon.id).state, 'abandoned');
  assert.equal(f.task(tAbandon.id).reason, '主人放弃');

  // 6. Owner retire knowledge entry with empty reason succeeds (defaults to '主人退役').
  const entryId = ownerEntry(f, { title: '测试方法' });
  const entry = f.ledger.getEntry(entryId)!;
  const resRetire = await app.send('POST', `/api/knowledge/entries/${entryId}/retire`, { reason: '', revision: entry.revision });
  assert.equal(resRetire.status, 200);
  assert.equal(f.ledger.getEntry(entryId)!.state, 'retired');
  assert.equal(f.ledger.getEntry(entryId)!.retired_reason, '主人退役');
});

test('schema migration 43 -> 44 seeds orchestrate role without overwriting existing roles', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-v44-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');

  // Create fresh v44 db, roll back schema_version to 43 and delete orchestrate to simulate a pre-44 ledger.
  const init = openLedger(path, { copyBeforeUpgrade: false });
  init.close();
  const raw = new DatabaseSync(path);
  raw.prepare(`DELETE FROM role WHERE id = 'orchestrate'`).run();
  raw.prepare(`UPDATE setting SET value_json = '43' WHERE key = 'schema_version'`).run();
  raw.prepare(`UPDATE role SET name = '自定义验证' WHERE id = 'verify'`).run();
  raw.close();

  assert.equal(SCHEMA_VERSION, 46);
  const upgraded = openLedger(path, { copyBeforeUpgrade: false });
  try {
    const orch = upgraded.getRole('orchestrate');
    assert.ok(orch, 'orchestrate role seeded by migration 43 -> 44');
    assert.equal(orch.name, '协调者');
    assert.equal(orch.default_tier, 'decide');
    assert.equal(orch.permission, 'write');
    assert.equal(orch.deliverable, 'report');
    assert.equal(orch.needs_review, false);
    assert.equal(upgraded.getRole('verify')!.name, '自定义验证', 'existing role customizations preserved');
  } finally {
    upgraded.close();
  }
});

test('deleting an archived project works without confirm_name while still enforcing archive gate and wrong confirm_name rejection', async (t) => {
  const app = await consoleApp(t);
  const { f } = app;
  const pid = f.ledger.createProject({ name: '待删项目' }, OWNER);
  f.ledger.createTask({ projectId: pid, title: '留痕任务', goal: 'g', acceptance: 'a', roleId: 'verify' }, OWNER);

  // Refused before archive even without confirm_name.
  const beforeArchive = await app.send('DELETE', `/api/projects/${pid}`, {});
  assert.equal(beforeArchive.status, 400);

  f.ledger.setProjectArchived(pid, true, OWNER);

  // Wrong explicit confirm_name is still rejected.
  const wrongName = await app.send('DELETE', `/api/projects/${pid}`, { confirm_name: '写错的名字' });
  assert.equal(wrongName.status, 400);

  // Empty body deletes cleanly once archived.
  const ok = await app.send('DELETE', `/api/projects/${pid}`, {});
  assert.equal(ok.status, 200);
});
