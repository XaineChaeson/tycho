// Guards the step from ledger version 35 to 36 (docs/design/roles-and-tiers.md §11) against:
// an existing Task losing the column that holds the Router's preference or being given one;
// a crash on either side of the step's commit leaving a ledger between the two versions; and
// a backup of the new version not verifying as a ledger.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { PRESET_ROLES } from '../shared/roles.ts';

const V35 = readFileSync(new URL('./fixtures/ledger/schema-v35.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';
class Crash extends Error {}

function version35(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate35-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V35);
  const run = (sql: string, ...params: string[]) => conn.prepare(sql).run(...params);
  run(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '35')`, AT);
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) role.run(each.id, AT, AT, each.name, each.description, each.default_tier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  run(`INSERT INTO project (id, created_at, name, login_mode) VALUES ('p1', ?, 'tycho', 'all')`, AT);
  run(`INSERT INTO account (id, name, created_at, updated_at, executor, tiers_json) VALUES ('l1', 'l1', ?, ?, 'claude', '{"execute":{"kind":"content","text":"x"}}')`, AT, AT);
  run(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, role_id, state, created_by) VALUES ('k1', ?, 'p1', '旧任务', '目标', '验收', 'implement', 'queued', 'router')`, AT);
  conn.close();
  return path;
}

const version = (path: string): string => {
  const conn = new DatabaseSync(path, { readOnly: true });
  try {
    return String(JSON.parse((conn.prepare(`SELECT value_json FROM setting WHERE key = 'schema_version'`).get() as { value_json: string }).value_json));
  } finally {
    conn.close();
  }
};

test('a version 35 ledger’s Tasks carry no preference, and a Task after the step can carry one', (t) => {
  const path = version35(t);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  t.after(() => ledger.close());
  assert.equal(ledger.getTask('k1').prefer_json, null);
  const task = ledger.createTask({
    projectId: 'p1', title: '新任务', goal: '目标', acceptance: '验收', roleId: 'implement',
    prefer: { loginIds: ['l1'], reason: '先找它' },
  }, { actor: 'user' });
  assert.deepEqual(JSON.parse(ledger.getTask(task.id).prefer_json!), { login_ids: ['l1'], reason: '先找它' });
  ledger.close();
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});

test('a crash on either side of the step’s commit leaves version 35 or 36 whole, and the next open finishes', (t) => {
  for (const side of ['before', 'after'] as const) {
    const path = version35(t);
    assert.throws(() => new Db(path, false, {
      [side === 'before' ? 'beforeMigrationCommit' : 'afterMigrationCommit']: (from: number) => { if (from === 35) throw new Crash(); },
    }, { copyBeforeUpgrade: false }), Crash);
    assert.equal(version(path), side === 'before' ? '35' : '36');
    const db = new Db(path, false, {}, { copyBeforeUpgrade: false });
    assert.equal(db.all<{ name: string }>(`SELECT name FROM pragma_table_info('task') WHERE name = 'prefer_json'`).length, 1);
    db.close();
  }
});
