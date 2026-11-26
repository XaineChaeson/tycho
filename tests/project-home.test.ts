import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Db } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { restoreBackup } from '../service/restore.ts';
import { exportProjectHandoff, freezeProjectHandoff, importProjectHandoff, stageProjectHandoff } from '../service/project-home-transfer.ts';
import { createProjectHome, openProjectHome, type ProjectHome, type ProjectOwnership } from '../service/project-home.ts';

const PROJECT = '01J00000000000000000000000';
const DATA = '验证完成，报告已登记';
const HASH = createHash('sha256').update(DATA).digest('hex');

function sites(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-project-home-'));
  const opened: { close(): void }[] = [];
  t.after(() => {
    for (const home of opened) home.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const site = (name: string) => {
    const path = join(dir, name);
    const create = createProjectHome(path);
    opened.push(create);
    return { path, home: create, reopen() {
      const reopened = openProjectHome(path);
      opened.push(reopened);
      return reopened;
    } };
  };
  return { office: site('office'), home: site('home'), other: site('other'), dir, opened };
}

function arrange(t: TestContext) {
  const cutover = sites(t);
  const { office, home } = cutover;
  const original = office.home.registerNew(PROJECT);
  const to = { project_id: PROJECT, source: office.home.identity, generation: 2, bundle_sha256: HASH };
  const target = { project_id: PROJECT, target: home.home.identity.id, bundle_sha256: HASH };
  home.home.stageIncoming(to);
  return { ...cutover, original, to, target };
}

test('新服务的身份持久，现有记录缺失时拒绝恢复写入', (t) => {
  const { office, dir } = sites(t);
  const installed = office.home.registerNew(PROJECT);
  assert.equal(installed.generation, 1);
  assert.deepEqual(office.reopen().identity, office.home.identity);
  assert.throws(() => createProjectHome(office.path), /已经存在/);
  assert.throws(() => openProjectHome(join(dir, 'lost-state')), /未找到/);
  assert.throws(() => office.home.assertWritable(PROJECT, undefined), /未核实/);
  assert.throws(() => office.home.assertWritable(PROJECT, { ...installed, generation: 2 }), /未核实/);
  assert.doesNotThrow(() => office.reopen().assertWritable(PROJECT, installed));
});

test('源服务冻结先于凭证发放，目录晚更新和恢复旧账本都无法让旧端写入', (t) => {
  const { office, home, original, target } = arrange(t);
  const ledgerPath = join(office.path, 'ledger.db');
  const backupPath = join(office.path, 'ledger.before-transfer.db');
  using ledger = new DatabaseSync(ledgerPath);
  ledger.exec('CREATE TABLE project_data (text TEXT);');
  office.home.withWrite(PROJECT, original, () => ledger.prepare('INSERT INTO project_data VALUES (?)').run(DATA));
  cpSync(ledgerPath, backupPath);
  const receipt = office.home.freezeForTransfer(target, original, () => {
    assert.equal(ledger.prepare('SELECT text FROM project_data').get()?.text, DATA);
    return HASH;
  });
  assert.equal(receipt.generation, 2);
  assert.throws(() => office.reopen().withWrite(PROJECT, original, () => assert.fail('旧端不应执行写操作')), /冻结/);
  const adopted = home.home.acceptIncoming(receipt, (ownership) => {
    assert.throws(() => home.home.assertWritable(PROJECT, ownership), /尚未接管/);
    return HASH;
  });
  assert.doesNotThrow(() => home.reopen().assertWritable(PROJECT, adopted));
  using restored = new DatabaseSync(backupPath);
  assert.equal(restored.prepare('SELECT text FROM project_data').get()?.text, DATA);
  assert.throws(() => office.reopen().withWrite(PROJECT, original, () => restored.prepare('DELETE FROM project_data').run()), /冻结/);
  assert.equal(restored.prepare('SELECT text FROM project_data').get()?.text, DATA);
  assert.deepEqual(office.home.freezeForTransfer(target, original, () => assert.fail('重试不得重做源清点')), receipt);
  assert.deepEqual(home.home.acceptIncoming(receipt, () => assert.fail('重试不得重复导入')), adopted);
});

test('篡改、另一服务、另一项目和另一份数据都拿不到写权', (t) => {
  const { office, home, other, original, to, target } = arrange(t);
  other.home.stageIncoming(to);
  const receipt = office.home.freezeForTransfer(target, original, () => HASH);
  const never = () => assert.fail('未经核实不应导入');
  assert.throws(() => other.home.acceptIncoming(receipt, never), /目标服务/);
  assert.throws(() => home.home.acceptIncoming({ ...receipt, target_service: other.home.identity.id }, never), /目标服务/);
  assert.throws(() => home.home.acceptIncoming({ ...receipt, generation: 3 }, never), /核实/);
  assert.throws(() => home.home.acceptIncoming({ ...receipt, project_id: '01J00000000000000000000001' }, never), /未准备/);
  assert.throws(() => home.home.acceptIncoming({ ...receipt, bundle_sha256: '1'.repeat(64) }, never), /核实/);
  assert.throws(() => home.home.acceptIncoming({ ...receipt, transfer_id: '01J00000000000000000000001' }, never), /签名/);
  assert.throws(() => home.home.assertWritable(PROJECT, original), /尚未接管/);
});

test('清点失败不会签字或冻结，目标导入失败后重试前维持冻结与只读', (t) => {
  const { office, home, original, target } = arrange(t);
  assert.throws(() => office.home.freezeForTransfer(target, original, () => { throw new Error('还有 Worker 或对外发送'); }), /还有 Worker/);
  assert.doesNotThrow(() => office.home.assertWritable(PROJECT, original));
  const receipt = office.home.freezeForTransfer(target, original, () => HASH);
  let partial: ProjectOwnership | undefined;
  assert.throws(() => home.home.acceptIncoming(receipt, (installed) => {
    partial = installed;
    throw new Error('目标安装已开始但尚未证实成功');
  }), /尚未证实/);
  assert.throws(() => home.reopen().assertWritable(PROJECT, partial), /尚未接管/);
  assert.throws(() => office.reopen().assertWritable(PROJECT, original), /冻结/);
  const adopted = home.reopen().acceptIncoming(receipt, (ownership) => {
    assert.deepEqual(ownership, partial);
    return HASH;
  });
  assert.equal(adopted.generation, 2);
  assert.throws(() => home.home.assertWritable(PROJECT, { ...adopted, generation: 1 }), /未核实/);
});

test('真实 Tycho 账本事务守住直接与关联写入，恢复旧备份也仍拒写', (t) => {
  const { office, home, opened } = sites(t);
  const open = (path: string, authority: ProjectHome) => {
    const db = new Db(path, false, {}, { projectHome: authority });
    opened.push(db);
    return db;
  };
  const sourcePath = join(office.path, 'ledger.db');
  const source = open(sourcePath, office.home);
  const created = '2026-11-14T00:00:00Z';
  const task = '01J00000000000000000000002';
  const installed = office.home.registerNew(PROJECT, (ownership) => source.transaction(() => {
    source.installProjectOwnership(PROJECT, ownership);
    source.run('INSERT INTO project (id, created_at, name) VALUES (?, ?, ?)', PROJECT, created, '原始名称');
    source.run("INSERT INTO task (id, created_at, project_id, title, goal, state, created_by) VALUES (?, ?, ?, ?, ?, 'draft', 'console')", task, created, PROJECT, '交接验收', '确认归属');
    source.run("INSERT INTO run (id, created_at, task_id, task_revision, host, state, marker, snapshot_json) VALUES ('run', ?, ?, 1, 'node', 'ended', 'marker', '{}')", created, task);
    source.run("INSERT INTO message (id, created_at, channel, external_id, direction, text, at, project_id) VALUES ('msg', ?, 'console', 'external', 'in', '原消息', ?, ?)", created, created, PROJECT);
  }));
  assert.throws(() => source.run('UPDATE project SET name = ?', '越过事务'), /归属锁/);
  source.transaction(() => source.run("UPDATE task SET state = 'done' WHERE id = ?", task));
  source.close();
  const saved = join(office.path, 'backup-before-ledger.db');
  cpSync(sourcePath, saved);

  const dest = open(join(home.path, 'ledger.db'), home.home);
  home.home.stageIncoming({ project_id: PROJECT, source: office.home.identity, generation: installed.generation + 1, bundle_sha256: HASH });
  const receipt = office.home.freezeForTransfer({ project_id: PROJECT, target: home.home.identity.id, bundle_sha256: HASH }, installed, () => HASH);
  const adopted = home.home.acceptIncoming(receipt, (ownership) => dest.transaction(() => {
    dest.installProjectOwnership(PROJECT, ownership);
    dest.run('INSERT INTO project (id, created_at, name) VALUES (?, ?, ?)', PROJECT, created, '移交后的数据');
    return HASH;
  }));
  assert.equal(adopted.generation, 2);
  dest.transaction(() => dest.run("UPDATE project SET name = '家庭项目' WHERE id = ?", PROJECT));

  restoreBackup(office.path, saved);
  const stale = open(sourcePath, office.reopen());
  assert.equal(stale.get<{ name: string }>('SELECT name FROM project WHERE id = ?', PROJECT)?.name, '原始名称');
  assert.throws(() => stale.transaction(() => stale.run("UPDATE project SET name = '旧端不能改' WHERE id = ?", PROJECT)), /冻结/);
  assert.throws(() => stale.transaction(() => stale.run('UPDATE task SET project_id = NULL WHERE id = ?', task)), /冻结/);
  assert.throws(() => stale.transaction(() => stale.run("UPDATE run SET state = 'running' WHERE id = 'run'")), /冻结/);
  assert.throws(() => stale.transaction(() => stale.run("UPDATE message SET text = '旧端重写' WHERE id = 'msg'")), /冻结/);
  assert.throws(() => stale.transaction(() => stale.run("INSERT INTO input (id, created_at, task_id, text, actor, state) VALUES ('input', ?, ?, '迟到插话', 'console', 'queued')", created, task)), /冻结/);
  assert.throws(() => stale.transaction(() => stale.run("INSERT INTO outbox (id, created_at, channel, kind, payload_json, state, next_at) VALUES ('out', ?, 'wecom', 'result', ?, 'pending', ?)", created, JSON.stringify({ items: [{ payload: { task_id: task } }] }), created)), /冻结/);
  assert.throws(() => stale.transaction(() => stale.run("INSERT INTO inbound_source (id, created_at, updated_at, name, kind, projects_json, push_final, enabled, created_by) VALUES ('inbound', ?, ?, '来源', 'tycho-v1', ?, 1, 1, 'console')", created, created, JSON.stringify([PROJECT]))), /冻结/);
  assert.throws(() => stale.transaction(() => stale.run("INSERT INTO knowledge_proposal (id, created_at, kind, change_json, why_json, source, proposed_by, client_id, digest, content_digest, state) VALUES ('k', ?, 'knowledge', ?, '{}', 'owner', 'console', 'console', 'a', 'b', 'awaiting_owner')", created, JSON.stringify({ outputs: [{ project_ids: [PROJECT] }] }))), /冻结/);
  assert.equal(stale.get<{ name: string }>('SELECT name FROM project WHERE id = ?', PROJECT)?.name, '原始名称');
  const online = openLedger(sourcePath, { projectHome: office.reopen() });
  opened.push(online);
  assert.equal(online.getProject(PROJECT).id, PROJECT);
  online.setWhitelist({ console: ['console'] }, { actor: 'console' });
  assert.throws(() => online.receiveMessage({ channel: 'console', externalId: 'stale-http-path', actor: 'console',
    text: '再做一件', projectId: PROJECT,
  }), /冻结/);
});

test('普通建项目在真实账本合并持久归属，失败后的新请求可以重试', (t) => {
  const { office, opened } = sites(t);
  let crash = true;
  const ledger = openLedger(join(office.path, 'ledger.db'), {
    projectHome: office.home,
    testHooks: { beforeCommit(actions) {
      if (crash && actions.includes('project.create')) throw new Error('模拟账本提交前失败');
    } },
  });
  opened.push(ledger);
  assert.throws(() => ledger.createProject({ name: '办公室' }, { actor: 'console' }), /提交前失败/);
  assert.deepEqual(ledger.listProjects(), []);
  crash = false;
  const project = ledger.createProject({ name: '办公室' }, { actor: 'console' });
  const ownership = office.reopen().readOwnership(project);
  assert.equal(ownership?.generation, 1);
  assert.throws(() => openLedger(join(office.path, 'ledger.db')), /归属数据库未启用或已丢失/);
  assert.doesNotThrow(() => ledger.setProjectName(project, '办公项目', { actor: 'console' }));
  assert.equal(ledger.getProject(project).name, '办公项目');
});

test('两个真实账本离线移交，保留稳定项目、消息、任务和派发证据编号', (t) => {
  const { office, home, other, opened } = sites(t);
  const sourcePath = join(office.path, 'ledger.db');
  const destPath = join(home.path, 'ledger.db');
  const owner = { actor: 'console' };
  const source = openLedger(sourcePath, { projectHome: office.home });
  opened.push(source);
  source.setWhitelist({ console: ['console'] }, owner);
  const id = source.createProject({ name: 'QL 验证', loginMode: 'all' }, owner);
  const mail = source.receiveMessage({ channel: 'console', externalId: 'request', actor: 'console', text: '跑验证', projectId: id });
  const turn = source.takeNextTurn(id)!;
  const task = source.createTask({ projectId: id, title: '测试', goal: '跑验证', roleId: 'verify', acceptance: '报告齐全' }, { ...owner, messageId: turn.message.id });
  source.queueTask(task.id, owner);
  source.finishMessage(mail.id, 'processed');
  const trigger = source.createTrigger(id, { name: '复查', instruction: '复查验证结果', schedule: { kind: 'once', at: '2099-01-01T00:00:00Z' } }, owner);
  source.setProjectPaused(id, true, owner);
  source.close();
  const backup = join(office.path, 'before-handoff.db');
  cpSync(sourcePath, backup);

  const target = openLedger(destPath, { projectHome: home.home });
  opened.push(target);
  target.setWhitelist({ console: ['console'] }, owner);
  const nameConflict = target.createProject({ name: 'QL 验证', loginMode: 'all' }, owner);
  target.close();
  const third = openLedger(join(other.path, 'ledger.db'), { projectHome: other.home });
  third.close();

  const bytes = exportProjectHandoff(office.path, id);
  assert.throws(() => stageProjectHandoff(home.path, bytes, office.home.identity), /同名/);
  const renaming = openLedger(destPath, { projectHome: home.home });
  renaming.setProjectName(nameConflict, '家用验证', owner);
  renaming.close();
  const targetBefore = join(home.path, 'backup-before-handoff.db');
  cpSync(destPath, targetBefore);
  assert.throws(() => stageProjectHandoff(home.path, bytes, other.home.identity), /源服务身份/);
  const targetId = stageProjectHandoff(home.path, bytes, office.home.identity).id;
  stageProjectHandoff(other.path, bytes, office.home.identity);
  const receipt = freezeProjectHandoff(office.path, bytes, targetId);
  assert.throws(() => importProjectHandoff(other.path, bytes, receipt), /目标服务/);
  assert.deepEqual(freezeProjectHandoff(office.path, bytes, targetId), receipt);
  assert.throws(() => importProjectHandoff(home.path, bytes, receipt, {
    afterLedgerInstall() { throw new Error('模拟目标账本提交后、归属提交前停机'); },
  }), /归属提交前停机/);
  const interrupted = openLedger(destPath, { projectHome: home.reopen() });
  opened.push(interrupted);
  assert.equal(interrupted.getProject(id).id, id, '账本副本已经持久');
  assert.throws(() => interrupted.setProjectPaused(id, false, owner), /尚未接管/);
  interrupted.close();
  const adopted = importProjectHandoff(home.path, bytes, receipt);
  assert.equal(adopted.generation, 2);
  assert.deepEqual(importProjectHandoff(home.path, bytes, receipt), adopted);

  const moved = openLedger(destPath, { projectHome: home.home });
  opened.push(moved);
  assert.equal(moved.getProject(id).name, 'QL 验证');
  assert.equal(moved.getMessage(mail.id).text, '跑验证');
  assert.equal(moved.getTask(task.id).project_id, id);
  assert.equal(moved.getTrigger(trigger.id)?.id, trigger.id);
  assert.equal(moved.listChanges({ taskId: task.id }).find(({ action }) => action === 'task.create')?.message_id, mail.id);
  assert.equal(moved.getProject(nameConflict).name, '家用验证');
  moved.setProjectPaused(id, false, owner);
  assert.doesNotThrow(() => moved.receiveMessage({ channel: 'console', externalId: 'target-request', actor: 'console', text: '继续', projectId: id }));
  moved.close();
  restoreBackup(home.path, targetBefore);
  assert.throws(() => importProjectHandoff(home.path, bytes, receipt), /目标账本.*恢复/);

  restoreBackup(office.path, backup);
  const stale = openLedger(sourcePath, { projectHome: office.home });
  opened.push(stale);
  assert.equal(stale.getProject(id).id, id);
  assert.throws(() => stale.receiveMessage({ channel: 'console', externalId: 'wrong-address', actor: 'console', text: '继续', projectId: id }), /冻结/);
});

test('导出与冻结之间改动会失效，在途审批之外的未知副作用挡住导出', (t) => {
  const { office, home, opened } = sites(t);
  const path = join(office.path, 'ledger.db');
  const online = () => {
    const ledger = openLedger(path, { projectHome: office.home });
    opened.push(ledger);
    return ledger;
  };
  const owner = { actor: 'console' };
  const created = online();
  const id = created.createProject({ name: '暂停后移交', loginMode: 'all' }, owner);
  created.close();
  assert.throws(() => exportProjectHandoff(office.path, id), /先暂停/);
  const paused = online();
  paused.setProjectPaused(id, true, owner);
  paused.close();
  const bytes = exportProjectHandoff(office.path, id);
  const changed = online();
  changed.setProjectName(id, '新名字', owner);
  changed.close();
  assert.throws(() => freezeProjectHandoff(office.path, bytes, home.home.identity.id), /清点后的项目数据/);
  const pending = online();
  pending.enqueueNotification('wecom', 'work_ready', { external_id: 'pending', project_id: id });
  pending.close();
  assert.throws(() => exportProjectHandoff(office.path, id), /还在发送/);
});

test('源拒绝冻结过期数据后，目标能重新准备同一来源和代次', (t) => {
  const { office, home } = sites(t);
  const sourcePath = join(office.path, 'ledger.db');
  const owner = { actor: 'console' };
  const original = openLedger(sourcePath, { projectHome: office.home });
  const id = original.createProject({ name: '原项目', loginMode: 'all' }, owner);
  original.setProjectPaused(id, true, owner);
  original.close();
  openLedger(join(home.path, 'ledger.db'), { projectHome: home.home }).close();

  const oldPack = exportProjectHandoff(office.path, id);
  const target = stageProjectHandoff(home.path, oldPack, office.home.identity);
  const changed = openLedger(sourcePath, { projectHome: office.home });
  changed.setProjectName(id, '改名后的项目', owner);
  changed.close();
  assert.throws(() => freezeProjectHandoff(office.path, oldPack, target.id), /清点后的项目数据/);

  const refreshed = exportProjectHandoff(office.path, id);
  assert.throws(() => stageProjectHandoff(home.path, refreshed, office.home.identity), /--replace/);
  stageProjectHandoff(home.path, refreshed, office.home.identity, true);
  const receipt = freezeProjectHandoff(office.path, refreshed, target.id);
  assert.throws(() => importProjectHandoff(home.path, oldPack, receipt), /不一致/);
  assert.equal(importProjectHandoff(home.path, refreshed, receipt).generation, 2);
  assert.throws(() => stageProjectHandoff(home.path, oldPack, office.home.identity, true), /同编号/);
});

test('移交后的旧端不处理已冻结项目的预约和触发器，其他项目照常到期', (t) => {
  const { office, home, opened } = sites(t);
  const ledgerPath = join(office.path, 'ledger.db');
  const owner = { actor: 'console' };
  const ledger = openLedger(ledgerPath, { projectHome: office.home });
  ledger.setWhitelist({ wecom: ['owner'] }, owner);
  const moved = ledger.createProject({ name: '移交项目', loginMode: 'all' }, owner);
  const staying = ledger.createProject({ name: '原端项目', loginMode: 'all' }, owner);
  const chat = { actor: 'owner', bot: 'bot', thread: 'owner' };
  ledger.frontBind({ ...chat, projectId: moved });
  const at = new Date('2099-01-01T00:00:00Z');
  const before = new Date('2098-12-31T23:59:00Z');
  function schedule(projectId: string) {
    const task = ledger.createTask({ projectId, title: '预约验证', goal: '验证唤醒', roleId: 'verify', acceptance: '按时唤醒' }, owner);
    ledger.queueTask(task.id, owner);
    ledger.scheduleWake(task.id, at, owner);
    ledger.createTrigger(projectId, { name: '定时验证', instruction: '核对结果', schedule: { kind: 'once', at: at.toISOString() } }, owner, before);
    return task.id;
  }
  const movedTask = schedule(moved);
  const stayingTask = schedule(staying);
  ledger.setProjectPaused(moved, true, owner);
  ledger.close();
  openLedger(join(home.path, 'ledger.db'), { projectHome: home.home }).close();
  const bundle = exportProjectHandoff(office.path, moved);
  const target = stageProjectHandoff(home.path, bundle, office.home.identity);
  const claim = freezeProjectHandoff(office.path, bundle, target.id);
  importProjectHandoff(home.path, bundle, claim);

  const source = openLedger(ledgerPath, { projectHome: office.reopen() });
  opened.push(source);
  assert.deepEqual(source.fireDue(at), { woken: [stayingTask], fired: 1 });
  assert.equal(source.getTask(movedTask).state, 'waiting_timer');
  assert.equal(source.getTask(stayingTask).state, 'queued');
  assert.deepEqual(source.frontProjects(chat.bot, chat.thread, chat.actor).map(({ id }) => id), [staying]);
  source.frontBind({ ...chat, projectId: staying });
  assert.equal(source.frontCurrent(chat.bot, chat.thread, chat.actor), staying);

  const destination = openLedger(join(home.path, 'ledger.db'), { projectHome: home.reopen() });
  opened.push(destination);
  destination.setProjectPaused(moved, false, owner);
  assert.deepEqual(destination.fireDue(at), { woken: [movedTask], fired: 1 });
});

test('已信任的源服务也不能把移交包里的记录送到目标端其他项目或全局', (t) => {
  const { office, home, opened } = sites(t);
  const source = openLedger(join(office.path, 'ledger.db'), { projectHome: office.home });
  const destPath = join(home.path, 'ledger.db');
  const dest = openLedger(destPath, { projectHome: home.home });
  const owner = { actor: 'console' };
  source.setWhitelist({ console: ['console'] }, owner);
  const moved = source.createProject({ name: '移交项目', loginMode: 'all' }, owner);
  const existing = dest.createProject({ name: '已有项目', loginMode: 'all' }, owner);
  source.receiveMessage({ channel: 'console', externalId: 'forged-transfer', actor: 'console', text: '测试消息', projectId: moved });
  source.createTask({ projectId: moved, roleId: 'verify', title: '验证', goal: '验证作用域', acceptance: '验证通过' }, owner);
  source.setProjectPaused(moved, true, owner);
  source.close();
  dest.close();
  const bundle = JSON.parse(exportProjectHandoff(office.path, moved).toString('utf8'));
  bundle.rows.message[0].project_id = existing;
  const detached = structuredClone(bundle);
  detached.rows.message[0].project_id = moved;
  detached.rows.task[0].project_id = null;
  assert.throws(() => stageProjectHandoff(home.path, Buffer.from(JSON.stringify(detached)), office.home.identity), /项目归属/);
  const forged = Buffer.from(JSON.stringify(bundle));
  const digest = createHash('sha256').update(forged).digest('hex');
  home.home.stageIncoming({ project_id: moved, source: office.home.identity, generation: 2, bundle_sha256: digest });
  const signed = office.home.freezeForTransfer({ project_id: moved, target: home.home.identity.id, bundle_sha256: digest },
    office.home.readOwnership(moved), () => digest);
  assert.throws(() => importProjectHandoff(home.path, forged, signed), /其他项目|包外/);
  const checked = openLedger(destPath, { projectHome: home.reopen() });
  opened.push(checked);
  assert.equal(checked.listMessages({ limit: 10 }).length, 0);
  assert.equal(checked.getProject(existing).name, '已有项目');
  assert.throws(() => checked.getProject(moved), /不存在/);
});

function materialContext(ledger: ReturnType<typeof openLedger>, projectId: string) {
  const context = ledger.openContext({
    projectId, segmentId: ledger.ensureSegment(projectId).id, marker: 'material-' + projectId, launch: {}, knowledge: [],
  });
  ledger.recordMaterial(context.id, { text: '固定恢复材料', knowledge: [], more_requests: false });
  ledger.setContextRef(context.id, 'session-' + projectId);
  return context;
}

test('恢复材料与会话引用的审计在写入时明确所属项目', (t) => {
  const { office, opened } = sites(t);
  const path = join(office.path, 'ledger.db');
  const source = openLedger(path, { projectHome: office.home });
  opened.push(source);
  const project = source.createProject({ name: '恢复材料归属', loginMode: 'all' }, { actor: 'console' });
  const context = materialContext(source, project);
  using stored = new DatabaseSync(path, { readOnly: true });
  const rows = stored.prepare("SELECT action, detail_json FROM change WHERE action IN ('router.material', 'router.session_ref') ORDER BY seq").all();
  assert.deepEqual(rows.map((row) => ({ action: row.action, ...JSON.parse(row.detail_json as string) })), [
    { action: 'router.material', router_context_id: context.id, project_id: project },
    { action: 'router.session_ref', router_context_id: context.id, session_ref: 'session-' + project, project_id: project },
  ]);
});

test('旧恢复材料与会话引用审计只按真实上下文归属移交，内容保持一致', (t) => {
  const { office, home, opened } = sites(t);
  const path = join(office.path, 'ledger.db');
  const source = openLedger(path, { projectHome: office.home });
  opened.push(source);
  const owner = { actor: 'console' };
  const project = source.createProject({ name: '旧恢复材料', loginMode: 'all' }, owner);
  const other = source.createProject({ name: '不移交的项目', loginMode: 'all' }, owner);
  const context = materialContext(source, project);
  const otherContext = materialContext(source, other);
  source.closeContext(context.id, '离线移交');
  source.setProjectPaused(project, true, owner);
  source.close();
  {
    using legacy = new DatabaseSync(path);
    // Existing pre-fix rows named only the context; unrelated audit fields are not a scope proof.
    legacy.prepare("UPDATE change SET detail_json = json_remove(detail_json, '$.project_id') WHERE action IN ('router.material', 'router.session_ref')").run();
    legacy.prepare("INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run('unrelated-context-audit', '2026-11-14T00:00:00Z', '2026-11-14T00:00:00Z', 'fixture', 'fixture.unrelated', JSON.stringify({ router_context_id: context.id }));
  }
  const target = openLedger(join(home.path, 'ledger.db'), { projectHome: home.home });
  target.close();
  const bytes = exportProjectHandoff(office.path, project);
  const bundle = JSON.parse(bytes.toString('utf8'));
  const contextChanges = bundle.rows.change.filter((row: { action: string }) => ['router.material', 'router.session_ref'].includes(row.action));
  assert.deepEqual(contextChanges.map((row: { action: string }) => row.action), ['router.material', 'router.session_ref']);
  assert.ok(contextChanges.every((row: { detail_json: string }) => JSON.parse(row.detail_json).router_context_id === context.id));
  assert.ok(!bundle.rows.change.some((row: { action: string }) => row.action === 'fixture.unrelated'));
  assert.ok(!bundle.rows.router_context.some((row: { id: string }) => row.id === otherContext.id));
  const receipt = freezeProjectHandoff(office.path, bytes, stageProjectHandoff(home.path, bytes, office.home.identity).id);
  importProjectHandoff(home.path, bytes, receipt);
  const moved = openLedger(join(home.path, 'ledger.db'), { projectHome: home.home });
  opened.push(moved);
  assert.equal(moved.getContext(context.id)?.material_json, JSON.stringify({ text: '固定恢复材料', knowledge: [], more_requests: false }));
  assert.equal(moved.getContext(context.id)?.session_ref, 'session-' + project);
  using stored = new DatabaseSync(join(home.path, 'ledger.db'), { readOnly: true });
  const actual = stored.prepare("SELECT id, detail_json FROM change WHERE action IN ('router.material', 'router.session_ref') ORDER BY seq").all();
  assert.deepEqual(actual.map((row) => ({ id: row.id, detail_json: row.detail_json })),
    contextChanges.map((row: { id: string; detail_json: string }) => ({ id: row.id, detail_json: row.detail_json })));
});

for (const action of ['router.material', 'router.session_ref']) {
  test(`移交中的恢复材料及会话引用审计不能借合法项目归属引用包外上下文（${action}）`, (t) => {
    const { office, home, opened } = sites(t);
    const path = join(office.path, 'ledger.db');
    const source = openLedger(path, { projectHome: office.home });
    const target = openLedger(join(home.path, 'ledger.db'), { projectHome: home.home });
    const owner = { actor: 'console' };
    const project = source.createProject({ name: '材料移交', loginMode: 'all' }, owner);
    const existing = target.createProject({ name: '目标的私有项目', loginMode: 'all' }, owner);
    const context = materialContext(source, project);
    const foreignContext = materialContext(target, existing);
    source.closeContext(context.id, '离线移交');
    source.setProjectPaused(project, true, owner);
    source.close();
    target.close();
    {
      using prepared = new DatabaseSync(path);
      prepared.prepare("UPDATE change SET detail_json = json_set(detail_json, '$.project_id', ?) WHERE action IN ('router.material', 'router.session_ref')").run(project);
    }
    const bundle = JSON.parse(exportProjectHandoff(office.path, project).toString('utf8'));
    const audit = bundle.rows.change.find((row: { action: string }) => row.action === action);
    audit.detail_json = JSON.stringify({ project_id: project, router_context_id: foreignContext.id });
    const forged = Buffer.from(JSON.stringify(bundle));
    assert.throws(() => stageProjectHandoff(home.path, forged, office.home.identity), /包外/);
    const digest = createHash('sha256').update(forged).digest('hex');
    home.home.stageIncoming({ project_id: project, source: office.home.identity, generation: 2, bundle_sha256: digest });
    const signed = office.home.freezeForTransfer({ project_id: project, target: home.home.identity.id, bundle_sha256: digest },
      office.home.readOwnership(project), () => digest);
    assert.throws(() => importProjectHandoff(home.path, forged, signed), /包外/);
    const checked = openLedger(join(home.path, 'ledger.db'), { projectHome: home.reopen() });
    opened.push(checked);
    assert.equal(checked.getContext(foreignContext.id)?.project_id, existing);
    assert.throws(() => checked.getProject(project), /不存在/);
  });
}
