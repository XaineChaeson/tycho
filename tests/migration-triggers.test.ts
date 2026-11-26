// Guards the step from ledger version 20 to 21 (docs/design/triggers.md) against: an existing
// Task left without the column that says which trigger its work came from, or given one; the
// three trigger tables missing or not taking a trigger once the step is done; a crash on either
// side of the step's commit leaving a ledger between the two versions; and a backup of the new
// version not verifying as a ledger.
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
import { USER } from './helpers.ts';

const V20 = readFileSync(new URL('./fixtures/ledger/schema-v20.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';
class Crash extends Error {}

function version20(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate20-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V20);
  const run = (sql: string, ...params: string[]) => conn.prepare(sql).run(...params);
  run(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '20')`, AT);
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) role.run(each.id, AT, AT, each.name, each.description, each.default_tier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  run(`INSERT INTO project (id, created_at, name, login_mode) VALUES ('p1', ?, 'tycho', 'all')`, AT);
  run(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, role_id, state, created_by) VALUES ('k1', ?, 'p1', '旧任务', '目标', '验收', 'implement', 'queued', 'router')`, AT);
  conn.close();
  return path;
}

const version = (path: string): string => {
  const conn = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.parse((conn.prepare(`SELECT value_json FROM setting WHERE key = 'schema_version'`).get() as { value_json: string }).value_json) as string;
  } finally {
    conn.close();
  }
};

test('a version 20 ledger gains the trigger tables, and its Tasks come from no trigger', (t) => {
  const path = version20(t);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  t.after(() => ledger.close());
  assert.equal(ledger.getTask('k1').trigger_fire_id, null);
  const trigger = ledger.createTrigger('p1', { name: '早检', instruction: '看', schedule: { kind: 'every', every_ms: 600_000, anchor: '2030-01-01T00:00:00Z' } }, USER, new Date('2030-01-01T00:00:00Z'));
  ledger.fireDue(new Date('2030-01-01T00:10:00Z'));
  assert.equal(ledger.listTriggerFires({ triggerId: trigger.id, limit: 10 }).length, 1);
  ledger.close();
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});

test('a crash on either side of the step\'s commit leaves version 20 or 21 whole, and the next open finishes', (t) => {
  for (const side of ['before', 'after'] as const) {
    const path = version20(t);
    assert.throws(() => new Db(path, false, {
      [side === 'before' ? 'beforeMigrationCommit' : 'afterMigrationCommit']: (from: number) => { if (from === 20) throw new Crash(); },
    }, { copyBeforeUpgrade: false }), Crash);
    assert.equal(String(version(path)), side === 'before' ? '20' : '21');
    const db = new Db(path, false, {}, { copyBeforeUpgrade: false });
    // The step to 22 adds the keys; the step to 35 moves them to inbound sources, which is where
    // this program's ledger has them now.
    assert.deepEqual(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'trigger_%' OR name LIKE 'inbound_%') ORDER BY name`).map(({ name }) => name), ['inbound_key', 'inbound_receipt_reply', 'inbound_source', 'trigger_cursor', 'trigger_fire', 'trigger_rule']);
    db.close();
  }
});
