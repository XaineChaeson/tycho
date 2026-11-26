import { migrationId } from './migration-names.ts';
// Guards against the step to ledger version 20 (docs/design/project-sessions.md §6) going wrong:
// an existing project switched to every login, or its empty list starting to dispatch; the old
// global session resumed, turned into some project's first segment, or its marker forgotten
// while a process of it may still be running; a message of the old conversation claimed for a
// project the ledger cannot tell, or one it can tell left unlinked; a message nobody had taken
// put into a project by a guess, or lost; an unverified one replayed; and a crash at the commit
// leaving a ledger that is neither version.
// And (review of step 1) against the old long-term rulings going quiet: each becomes a knowledge
// proposal — from "迁移的长期裁定", with the original record as its evidence, for the project its
// Task is in or else global — that goes through the gate as any other, once; and no decision table
// or reader of it is left behind.
// And (step 2) against the front desk and the pushes being there in name only after the upgrade: a
// migrated ledger routes a WeCom message, asks about one it cannot place, lets the owner pick, and
// pushes and reminds a question.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Db, SCHEMA_VERSION } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { peekLedger } from '../service/ledger-peek.ts';
import { PRESET_ROLES } from '../shared/roles.ts';

const V19 = readFileSync(new URL('./fixtures/ledger/schema-v19.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';

class Crash extends Error {}

// A ledger as version 19 left it: two projects — one listing a login, one listing none — the
// one global Router session (open, with its login recorded) and its conversation: a request
// whose turn created a Task of the first project, a request that touched nothing, a reply, an
// internal event about the second project's Task, an unverified request, and messages nobody
// had taken yet.
function version19(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate19-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V19);
  const run = (sql: string, ...params: (string | null)[]) => conn.prepare(sql).run(...params);
  run(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '19')`, AT);
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) role.run(each.id, AT, AT, each.name, each.description, each.default_tier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  run(`INSERT INTO account (id, created_at, updated_at, executor, config_dir, tiers_json, credential_ref) VALUES ('t1', ?, ?, 'claude', NULL, '{}', 'c1')`, AT, AT);
  run(`INSERT INTO project (id, created_at, name, logins_json, machines_json) VALUES ('p1', ?, 'tycho', '["t1"]', '[]')`, AT);
  run(`INSERT INTO project (id, created_at, name, logins_json, machines_json) VALUES ('p2', ?, '空清单', '[]', '[]')`, AT);
  run(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, role_id, state, created_by) VALUES ('k1', ?, 'p1', '甲的', '目标', '验收', 'implement', 'queued', 'router')`, AT);
  run(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, role_id, state, created_by) VALUES ('k2', ?, 'p2', '乙的', '目标', '验收', 'implement', 'queued', 'router')`, AT);
  run(`INSERT INTO router_session (id, created_at, session_ref, pid, marker, state, last_turn_at) VALUES ('old', ?, 'ref-old', 4242, 'marker-old', 'open', ?)`, AT, AT);
  run(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-login', ?, 'router_session_login', ?)`, AT, JSON.stringify({ session_id: 'old', account: 't1', config_dir: null }));
  const message = (id: string, fields: { channel?: string; external?: string; direction?: string; text: string; state: string | null }) =>
    run(`INSERT INTO message (id, created_at, channel, external_id, direction, actor, text, state, final, at) VALUES (?, ?, ?, ?, ?, 'console', ?, ?, 1, ?)`,
      id, AT, fields.channel ?? 'console', fields.external ?? `x-${id}`, fields.direction ?? 'in', fields.text, fields.state, AT);
  message('m1', { text: '建个任务', state: 'processed' });
  run(`INSERT INTO change (id, created_at, at, actor, message_id, task_id, action) VALUES ('c1', ?, ?, 'router', 'm1', 'k1', 'task.create')`, AT, AT);
  message('m2', { direction: 'out', external: 'reply:m1', text: '建好了', state: null });
  message('m3', { text: '随便聊聊', state: 'processed' });
  message('m4', { channel: 'internal', external: 'run:k2', text: `任务“乙的”结算了\n${JSON.stringify({ task_id: 'k2' })}`, state: 'processed' });
  message('m5', { text: '做到一半的', state: 'unverified' });
  message('m6', { text: '还没取走的', state: 'received' });
  message('m7', { channel: 'internal', external: 'input:k2', text: `任务“乙的”收到插话\n${JSON.stringify({ task_id: 'k2' })}`, state: 'received' });
  run(`INSERT INTO decision (id, created_at, task_id, scope_json, text, at) VALUES ('d1', ?, 'k1', '"发布"', '周五不发版', ?)`, AT, AT);
  run(`INSERT INTO decision (id, created_at, task_id, scope_json, text, at) VALUES ('d2', ?, NULL, '"全局"', '先量再改', ?)`, AT, AT);
  conn.close();
  const read = <T>(sql: string): T[] => {
    const peek = new DatabaseSync(path);
    try { return (peek.prepare(sql).all() as T[]).map((row) => ({ ...row })); } finally { peek.close(); }
  };
  const version = (): string => read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json;
  return { path, read, version, closing: <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; } };
}

for (const point of ['none', 'before', 'after'] as const) {
  test(`v20 project sessions migration ${point} commit leaves one version or the other`, (t) => {
    const old = version19(t);
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.version(), point === 'before' ? '19' : '20');
      // Before the commit the old table is all there is; after it, all of the new shape.
      const tables = old.read<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'router%' ORDER BY name`).map(({ name }) => name);
      assert.deepEqual(tables, point === 'before' ? ['router_session'] : ['router_context', 'router_segment']);
    }
    const ledger = old.closing(openLedger(old.path, { log: () => {} }));
    assert.equal(old.version(), String(SCHEMA_VERSION));

    // Every project keeps its list, as "only these": the empty one dispatches nothing.
    assert.deepEqual(ledger.listProjects().map(({ id, login_mode, logins_json }) => [id, login_mode, logins_json]), [['p1', 'selected', JSON.stringify([migrationId(ledger, 't1')])], ['p2', 'selected', '[]']]);
    assert.deepEqual(ledger.loginPool({ project_id: 'p2' }).ids, []);

    // The old session is the record: closed, its login kept, its marker still to be scanned for.
    const [context] = ledger.listContexts(null);
    assert.deepEqual([context!.id, context!.state, context!.closed_reason, context!.login_id, context!.segment_id, context!.marker], ['old', 'closed', '旧全局记录', migrationId(ledger, 't1'), null, 'marker-old']);
    assert.notEqual(context!.live_at, null);
    assert.deepEqual(ledger.liveContexts().map(({ marker }) => marker), ['marker-old']);
    // The ledger above is still open: a writer may be there.
    const peeked = peekLedger(old.path, 'live');
    assert.ok(peeked.known);
    assert.deepEqual(peeked.routers.map(({ marker }) => marker), ['marker-old'], '回退前的清点照样找得到旧负责人');
    assert.equal(ledger.currentContext('p1'), undefined, '不续接旧会话');
    assert.deepEqual(ledger.listSegments('p1'), [], '旧会话不是任何项目的第一段');
    assert.equal(old.read(`SELECT 1 FROM setting WHERE key = 'router_session_login'`).length, 0);

    // The old conversation: linked where the ledger can tell, left alone where it cannot.
    const row = (id: string) => ledger.getMessage(id);
    assert.deepEqual(['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => [id, row(id).basis, row(id).project_id, row(id).state]), [
      ['m1', 'legacy', 'p1', 'processed'],
      ['m2', 'legacy', 'p1', null],
      ['m3', 'legacy', null, 'processed'],
      ['m4', 'legacy', 'p2', 'processed'],
      ['m5', 'legacy', null, 'unverified'],
    ]);
    assert.deepEqual(ledger.listMessages({ legacy: true, projectId: 'p1', limit: 10 }).map(({ id }) => id), ['m1', 'm2']);
    // Never taken: the owner's waits for a project; an event goes to its Task's project.
    assert.deepEqual([row('m6').state, row('m6').project_id], ['unassigned', null]);
    assert.deepEqual([row('m7').state, row('m7').project_id, row('m7').basis], ['received', 'p2', 'object']);
    assert.deepEqual(ledger.projectsWaiting(), ['p2']);
    // The first message of a project starts a context of its own, in its first segment.
    const taken = ledger.takeNextTurn('p2')!;
    assert.equal(taken.message.id, 'm7');
    assert.equal(ledger.getSegment(taken.message.segment_id!)!.seq, 1);
    assert.equal(ledger.takeNextTurn('p1'), undefined);

    // The rulings: each a proposal of the migration, its record the evidence, gated as any other.
    assert.equal(old.read(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decision'`).length, 0, '旧表不留');
    const proposals = old.read<{ id: string; source: string; request_id: string; change_json: string; state: string; gate_task_id: string | null }>(`SELECT id, source, request_id, change_json, state, gate_task_id FROM knowledge_proposal ORDER BY request_id`);
    assert.deepEqual(proposals.map(({ source, request_id }) => [source, request_id]), [['migration', 'd1'], ['migration', 'd2']]);
    const outputs = proposals.map(({ change_json }) => (JSON.parse(change_json) as { outputs: { body: string; project_ids: string[] | null; loading: string }[] }).outputs[0]!);
    assert.deepEqual(outputs.map(({ body, project_ids, loading }) => [body, project_ids, loading]), [['周五不发版', ['p1'], 'resident'], ['先量再改', null, 'resident']]);
    assert.ok(proposals.every(({ state, gate_task_id }) => gate_task_id !== null || state === 'awaiting_owner' || state === 'published'), '走把关、等主人点头或自动生效');
    const evidence = old.read<{ source: string; ref: string; excerpt: string; verified: number }>(`SELECT source, ref, excerpt, verified FROM knowledge_evidence ORDER BY ref`);
    assert.deepEqual(evidence.map(({ source, ref, excerpt, verified }) => [source, ref, excerpt, verified]), [['record', 'd1', '周五不发版', 1], ['record', 'd2', '先量再改', 1]]);
    // Opened again: nothing made twice.
    old.closing(openLedger(old.path, { log: () => {} }));
    assert.equal(old.read('SELECT id FROM knowledge_proposal').length, 2);
  });
}

test('after the migration the front desk places, asks and takes a pick, and a question is pushed and reminded', (t) => {
  const old = version19(t);
  const ledger = old.closing(openLedger(old.path, { log: () => {}, pushPolicy: () => ({ remindMs: 60_000, remindMax: 1, resultWindowMs: 0 }) }));
  ledger.setWhitelist({ wecom: ['zhang'] }, { actor: 'test' });
  const say = (externalId: string, text: string) => ledger.frontReceive({ bot: 'bot', externalId, actor: 'zhang', thread: 'zhang', text, material: false });
  const waiting = say('w1', '这是哪个项目的');
  assert.deepEqual(JSON.parse(ledger.getMessage(waiting.id).candidates_json!), { reason: 'none', projects: ['p1', 'p2'] });
  const kinds = () => old.read<{ kind: string }>('SELECT kind FROM outbox ORDER BY rowid').map(({ kind }) => kind);
  assert.ok(kinds().includes('assign'), '问主人的卡片入队');
  assert.deepEqual(ledger.frontChoose({ bot: 'bot', messageId: waiting.id, projectId: 'p1', actor: 'zhang' }).ids, [waiting.id]);
  assert.equal(ledger.frontCurrent('bot', 'zhang', 'zhang'), 'p1');
  const next = say('w2', '接着说');
  assert.deepEqual([ledger.getMessage(next.id).project_id, ledger.getMessage(next.id).basis], ['p1', 'current']);
  ledger.openApproval('k1', [{ question: '用哪个？' }], { actor: 'test' });
  ledger.pushTick(new Date(Date.now() + 61_000));
  assert.ok(kinds().includes('approval') && kinds().includes('remind'), '问题推出、到点提醒');
});
