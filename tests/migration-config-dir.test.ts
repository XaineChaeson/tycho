// Guards against: a version 31 ledger keeping a configuration directory for an account or a
// Router context after an account came to replace only the identity (merged-design §1.1); a
// value the owner had filled in vanishing without a trace in the audit; a round not yet started
// at the upgrade no longer matching its login, and so never started or moved; and a round that
// is already running, or has ended, having its snapshot rewritten — that is what was sent.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { verifySnapshot, SCHEMA_VERSION } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { loginConfig } from '../runner/snapshot.ts';

const schema = readFileSync(new URL('./fixtures/ledger/schema-v31.sql', import.meta.url), 'utf8');

test('31 → 32 drops the configuration directory, keeps what was filled in in the audit, and lets a round under way still match its login', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-config-dir-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const old = new DatabaseSync(path);
  old.exec(schema);
  const login = '{"executor":"claude","machine":null,"config_dir":null,"tiers":{},"permission_mode":null,"timeout_ms":null,"max_runs":null}';
  const named = '{"executor":"claude","machine":null,"config_dir":"/home/a","tiers":{},"permission_mode":null,"timeout_ms":null,"max_runs":null}';
  // A round that has already started carries the snapshot it was sent with: nothing rewrites it.
  const started = `{"brief":"b","config_dir":"/home/run","login":${named}}`;
  old.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '31');
    INSERT INTO project (id, created_at, name) VALUES ('p', 'now', 'project');
    INSERT INTO account (id, name, created_at, updated_at, executor, config_dir, tiers_json, credential_ref) VALUES
      ('a', 'with-dir', 'now', 'now', 'claude', '/home/a', '{}', 'ref-a'),
      ('b', 'without', 'now', 'now', 'claude', NULL, '{}', 'ref-b');
    INSERT INTO router_segment (id, created_at, project_id, seq, state) VALUES ('s', 'now', 'p', 1, 'current');
    INSERT INTO router_context (id, created_at, segment_id, project_id, marker, state, login_id, config_dir) VALUES ('c', 'now', 's', 'p', 'm', 'open', 'a', '/home/a');
    INSERT INTO task (id, created_at, project_id, title, goal, state, created_by) VALUES ('t', 'now', 'p', 'one', 'goal', 'running', 'owner'), ('t2', 'now', 'p', 'two', 'goal', 'running', 'owner'), ('t3', 'now', 'p', 'three', 'goal', 'running', 'owner');
    INSERT INTO run (id, created_at, task_id, task_revision, login_id, host, state, marker, snapshot_json) VALUES
      ('live', 'now', 't', 1, 'b', 'host', 'launching', 'm1', '{"brief":"b","config_dir":null,"login":${login}}'),
      ('running', 'now', 't3', 1, 'a', 'host', 'running', 'm2', '${started}'),
      ('ended', 'now', 't', 1, 'b', 'host', 'ended', 'm3', '{"brief":"b","config_dir":"/home/old","login":${login}}'),
      ('named', 'now', 't2', 1, 'a', 'host', 'launching', 'm4', '{"brief":"b","config_dir":"/home/a","login":${named}}');`);
  old.close();
  assert.ok(SCHEMA_VERSION >= 44);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    assert.deepEqual(ledger.getAccount('a')!.name, 'with-dir');
    assert.ok(!('configDir' in ledger.getAccount('a')!));
  } finally { ledger.close(); }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = (table: string) => (after.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(({ name }) => name);
    assert.ok(!columns('account').includes('config_dir'));
    assert.ok(!columns('router_context').includes('config_dir'));
    const audit = (after.prepare(`SELECT action, actor, detail_json FROM change ORDER BY rowid`).all() as { action: string; actor: string; detail_json: string }[])
      .map(({ action, actor, detail_json }) => ({ action, actor, ...JSON.parse(detail_json) as { config_dir_removed?: string } }));
    assert.deepEqual(audit.map(({ action, actor, config_dir_removed }) => [action, actor, config_dir_removed]), [
      ['account.update', 'migration', '/home/a'],
      ['router_context.update', 'migration', '/home/a'],
    ], '只为填过的记一笔，空的不记');
    const raw = (id: string) => (after.prepare('SELECT snapshot_json FROM run WHERE id = ?').get(id) as { snapshot_json: string }).snapshot_json;
    const snapshot = (id: string) => JSON.parse(raw(id)) as { config_dir?: unknown; login: Record<string, unknown> };
    // The rounds not yet started read as their accounts do now: compared field for field.
    assert.deepEqual(snapshot('live').login, loginConfig({ id: 'b', name: 'without', executor: 'claude', tiers: {} }));
    assert.ok(!Object.hasOwn(snapshot('live'), 'config_dir'), '顶层那个没有读者的字段也去掉了');
    assert.deepEqual(snapshot('named').login, loginConfig({ id: 'a', name: 'with-dir', executor: 'claude', tiers: {} }), '填过目录的那一轮也一样：它还没启动，不是历史');
    assert.ok(!Object.hasOwn(snapshot('named'), 'config_dir'));
    assert.equal(raw('running'), started, '已经启动的那一轮快照是送出去的记录，一字不改');
    assert.equal(snapshot('ended').login.config_dir, null, '结束了的那一轮的快照是历史，不改');
    assert.equal(snapshot('ended').config_dir, '/home/old');
  } finally { after.close(); }
});
