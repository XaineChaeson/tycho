// Guards the step from ledger version 36 to 37 (docs/design/roles-and-tiers.md §10) against:
// the preset verify role keeping its old execute default; a role the owner changed being
// rewritten; a login being given operate content it never had; a crash on either side of the
// step's commit leaving a ledger between the two versions; and a backup of the new version
// not verifying as a ledger.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { PRESET_ROLES, VERIFY_ROLE_ID } from '../shared/roles.ts';

const V36 = readFileSync(new URL('./fixtures/ledger/schema-v36.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';
class Crash extends Error {}

// A version 36 ledger, as the program wrote it: the verify role on execute, and one role the
// owner changed (analyse, on execute rather than its preset decide).
function version36(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate36-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V36);
  const run = (sql: string, ...params: string[]) => conn.prepare(sql).run(...params);
  run(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '36')`, AT);
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) {
    const defaultTier = each.id === VERIFY_ROLE_ID ? 'execute' : each.id === 'analyse' ? 'execute' : each.default_tier;
    role.run(each.id, AT, AT, each.name, each.description, defaultTier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  }
  run(`INSERT INTO project (id, created_at, name, login_mode) VALUES ('p1', ?, 'tycho', 'all')`, AT);
  run(`INSERT INTO account (id, name, created_at, updated_at, executor, tiers_json) VALUES ('l1', 'l1', ?, ?, 'claude', '{"execute":{"kind":"content","text":"x"}}')`, AT, AT);
  run(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, role_id, state, created_by) VALUES ('k1', ?, 'p1', '验证一次', '目标', '验收', 'verify', 'queued', 'router')`, AT);
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

test('a version 36 ledger’s verify role moves to the operate tier, a role the owner changed stays, and no login is given operate content', (t) => {
  const path = version36(t);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  t.after(() => ledger.close());
  assert.equal(ledger.getRole(VERIFY_ROLE_ID)!.default_tier, 'operate');
  assert.equal(ledger.getRole('analyse')!.default_tier, 'execute', '主人改过的职能不动');
  // The substitute is a judgment, not a copy: a login with no operate content keeps exactly
  // what it had, and its operate work runs on the execute content (roles-and-tiers.md §10.3).
  assert.deepEqual({ ...ledger.getAccount('l1')!.tiers }, { execute: { kind: 'content', text: 'x' } });
  assert.deepEqual([ledger.getTask('k1').tier, ledger.getTask('k1').tier_source], ['operate', 'default'], '没结束的任务不改，档位由职能推出');
  ledger.close();
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});

test('a crash on either side of the step’s commit leaves version 36 or 37 whole, and the next open finishes', (t) => {
  for (const side of ['before', 'after'] as const) {
    const path = version36(t);
    assert.throws(() => new Db(path, false, {
      [side === 'before' ? 'beforeMigrationCommit' : 'afterMigrationCommit']: (from: number) => { if (from === 36) throw new Crash(); },
    }, { copyBeforeUpgrade: false }), Crash);
    assert.equal(version(path), side === 'before' ? '36' : '37');
    const db = new Db(path, false, {}, { copyBeforeUpgrade: false });
    assert.equal(db.all<{ default_tier: string }>(`SELECT default_tier FROM role WHERE id = 'verify'`)[0]!.default_tier, 'operate');
    db.close();
  }
});
