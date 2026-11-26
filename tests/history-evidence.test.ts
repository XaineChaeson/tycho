// Prevents a history lookup from following current task content, leaking another project's
// records or a revoked entry, fabricating an old revision, or skipping same-time rounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHistoryEvidence } from '../service/history-evidence.ts';
import { givenOf } from '../service/knowledge-brief.ts';
import { DONE, fixture, type Fixture, USER } from './helpers.ts';
import { create, EVIDENCE, OWNER, OWNER_SAYS, ownerEntry, output, WHY } from './knowledge-helpers.ts';

function running(f: Fixture, projectId = f.projectId) {
  const task = f.ledger.createTask({ projectId, roleId: 'implement', title: '后来改过的标题', goal: '目标', acceptance: '测试通过' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: {
    ...f.login.snapshot,
    knowledge: f.ledger.applicable(projectId, task.role_id).map(givenOf),
  } }, USER);
  f.ledger.markRunRunning(run.id);
  return { task, run };
}

function settled(f: Fixture, at: string, snapshot: object, summary: string, projectId = f.projectId) {
  const { task, run } = running(f, projectId);
  f.ledger.settleRun(run.id, 0, { ...DONE, summary });
  f.force('UPDATE run SET created_at = ?, ended_at = ?, snapshot_json = ? WHERE id = ?', at, at, JSON.stringify(snapshot), run.id);
  return { task, run };
}

function revise(f: Fixture, id: string, revision: number, fields: Record<string, unknown>) {
  return f.ledger.propose({
    inputs: [{ knowledge_id: id, revision, disposition: 'revise' }],
    outputs: [output({ revises: id, ...fields })],
    why: WHY,
    evidence: EVIDENCE,
  }, OWNER_SAYS, OWNER);
}

test('reads settled evidence at the requested instant and keeps the recorded historical revision', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '另一个项目', loginMode: 'all' }, USER);
  const k = ownerEntry(f, { title: '超时规约旧版', project_ids: [f.projectId] });
  const revoked = ownerEntry(f, { title: '私有条目', project_ids: [f.projectId, other] });
  const missing = ownerEntry(f, { title: '原条目', project_ids: [f.projectId] });
  const first = new Date(Date.now() + 10_000).toISOString();
  const second = new Date(Date.now() + 20_000).toISOString();
  const old = settled(f, first, {
    brief: '# 超时回滚\n\n此处有完整上下文',
    role: { id: 'implement', name: '开发' },
    knowledge: [
      { id: k, revision: 1, title: '超时规约旧版' },
      { id: revoked, revision: 1, title: '私有条目' },
      { id: missing, revision: 9, title: '账本没有这版' },
    ],
  }, '用退避处理网络超时 password=protected-word');
  revise(f, k, 1, { title: '超时规约新版', project_ids: [f.projectId] });
  revise(f, revoked, 1, { title: '私有条目', project_ids: [other] });
  const newer = settled(f, second, {
    brief: '# 超时回滚',
    role: { id: 'implement', name: '开发' },
    knowledge: [{ id: k, revision: 2, title: '超时规约新版' }],
  }, '用新版规约处理网络超时');
  settled(f, first, { brief: '# 超时回滚', role: { id: 'implement' } }, '项目以外的网络超时', other);
  running(f);

  const search = createHistoryEvidence(f.db(), f.ledger);
  const found = search(f.projectId, { query: '网络超时', role_id: 'implement', as_of: first, commit: 'C0FFEE' });
  assert.deepEqual(found.items.map(({ run_id }) => run_id), [old.run.id]);
  const item = found.items[0]!;
  assert.equal(item.project_id, f.projectId);
  assert.equal(item.task_id, old.task.id);
  assert.equal(item.title, '超时回滚');
  assert.equal(item.role_id, 'implement');
  assert.equal(item.knowledge_unavailable, true);
  assert.deepEqual(item.knowledge?.map(({ id, revision, title }) => ({ id, revision, title })), [{ id: k, revision: 1, title: '超时规约旧版' }]);
  assert.deepEqual(item.commits, [{ value: 'c0ffee', source: 'reported' }]);
  assert.match(item.excerpt ?? '', /网络超时/);
  assert.doesNotMatch(JSON.stringify(item), /protected-word|私有条目|账本没有这版|完整上下文/);
  assert.deepEqual(search(f.projectId, { query: '私有条目' }).items, []);
  assert.deepEqual(search(f.projectId, { query: 'protected-word' }).items, []);
  assert.deepEqual(search(f.projectId, { query: '后来改过的标题' }).items, []);
  assert.deepEqual(search(f.projectId, { since: second }).items.map(({ knowledge, run_id }) => [run_id, knowledge?.[0]?.revision]), [[newer.run.id, 2]]);
});

test('pages by a stable run position and keeps absent legacy evidence explicit', (t) => {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '另一个项目', loginMode: 'all' }, USER);
  const at = new Date().toISOString();
  const older = settled(f, at, {}, '老记录');
  const newer = settled(f, at, { brief: '# 新记录', role: { id: 'implement' }, knowledge: [] }, '新记录');
  f.force('UPDATE run SET snapshot_json = ?, receipt_json = NULL WHERE id = ?', 'malformed', older.run.id);
  const search = createHistoryEvidence(f.db(), f.ledger);

  const first = search(f.projectId, { limit: '1' });
  assert.deepEqual(first.items.map(({ run_id }) => run_id), [newer.run.id]);
  assert.deepEqual(first.items[0]?.knowledge, []);
  assert.ok(first.next_cursor);
  const second = search(f.projectId, { after: first.next_cursor, limit: 2 });
  assert.deepEqual(second.items.map(({ run_id, excerpt, role_id, title, knowledge }) => ({ run_id, excerpt, role_id, title, knowledge })), [
    { run_id: older.run.id, excerpt: null, role_id: null, title: null, knowledge: null },
  ]);
  assert.equal(second.next_cursor, null);
  assert.throws(() => search(other, { after: first.next_cursor }), /游标/);
  assert.throws(() => search(f.projectId, { after: first.next_cursor, query: '新记录' }), /游标/);
  assert.throws(() => search(f.projectId, { limit: Number.MAX_SAFE_INTEGER + 1 }), /条数/);
  assert.throws(() => search(f.projectId, { limit: '1e1' }), /条数/);
  assert.throws(() => search(f.projectId, { as_of: '2026-11-14' }), /时区/);
  assert.deepEqual(search(f.projectId, { role_id: 'implement' }).items.map(({ run_id }) => run_id), [newer.run.id]);
});


test('history finds the formal final report with a bounded excerpt and same-source metadata, never a second full body', t => {
  const f=fixture(t), {run}=running(f);
  const body='专有报告词汇 '+ '完整原文'.repeat(500);
  f.ledger.settleRun(run.id,0,{...DONE,artifacts:[{kind:'report',ref:'最后一条消息'}]},{finalReply:body});
  const found=f.ledger.searchHistoryEvidence(f.projectId,{query:'专有报告词汇'});
  assert.equal(found.items.length,1);
  assert.equal(found.items[0]!.excerpt_source,'final_message');
  assert.ok(found.items[0]!.excerpt!.length<=422);
  assert.equal(found.items[0]!.report!.sha256,f.ledger.runReport(run.id)!.sha256);
  assert.equal(JSON.stringify(found).includes(body),false);
  const other=f.ledger.createProject({name:'隔离项目',loginMode:'all'},USER);
  assert.deepEqual(f.ledger.searchHistoryEvidence(other,{query:'专有报告词汇'}).items,[]);
});
