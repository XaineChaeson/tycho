// Guards the step from ledger version 38 to 39 (docs/design/accounts-machines-decoupled.md
// "机器自己的登录什么时候能用"): the table that keeps a removed machine login from being
// adopted again is added, and no row of the old ledger changes. The failure this prevents is
// an upgraded ledger whose new table is missing — the first owner removal would then fail, or
// the host would adopt a login the owner had just deleted — or one whose old rows were rewritten
// by the migration.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { USER } from './helpers.ts';

const AT = '2026-11-01T00:00:00.000Z';
const TIERS = JSON.stringify({ decide: { kind: 'content', text: 'model=y\n' } });

test('v38 账本升到 v39：多出拒用记录表，旧的机器登录一行都没变', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migration-own-login-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL('./fixtures/ledger/schema-v38.sql', import.meta.url), 'utf8'));
  old.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '38');
    INSERT INTO machine (id, uid, created_at, updated_at, host, node_id, platform) VALUES ('h1', 'uid-h1', 'now', 'now', 'h1', 'node-h1', 'linux');
    INSERT INTO machine_login (id, machine_uid, machine_id, executor, created_at, updated_at, tiers_json, permission_mode, timeout_ms, max_runs)
      VALUES ('own1', 'uid-h1', 'h1', 'codex', '${AT}', '${AT}', '${TIERS.replace(/'/g, "''")}', 'workspace-write', 900000, 2);`);
  const before = old.prepare('SELECT * FROM machine_login ORDER BY rowid').all().map((row) => ({ ...row }));
  old.close();
  assert.equal(SCHEMA_VERSION, 44);

  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    const own = ledger.getMachineLogin('h1', 'codex')!;
    assert.deepEqual([own.id, own.executor, own.permissionMode, own.timeoutMs, own.maxRuns], ['own1', 'codex', 'workspace-write', 900000, 2]);
    assert.deepEqual({ ...own.tiers }, JSON.parse(TIERS));
    assert.deepEqual(ledger.listMachineLogins().map(({ id }) => id), ['own1']);
    // The new room exists and takes a removal: the owner deleting a login is not adopted
    // back, which is the one thing this step adds.
    ledger.putMachineLogin({ executor: 'claude', machine: 'h1', tiers: { execute: { kind: 'content', text: 'model=x\n' } } }, USER);
    ledger.deleteMachineLogin('h1', 'claude', USER);
    assert.equal(ledger.getMachineLogin('h1', 'claude'), undefined);
  } finally {
    ledger.close();
  }

  const after = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = after.prepare(`SELECT name FROM pragma_table_info('machine_login_refusal')`).all() as { name: string }[];
    assert.deepEqual(columns.map(({ name }) => name).sort(), ['created_at', 'executor', 'machine_uid']);
    assert.deepEqual(after.prepare('SELECT * FROM machine_login ORDER BY rowid').all().map((row) => ({ ...row })), before, 'the old row is as it was');
    assert.deepEqual(after.prepare('SELECT machine_uid, executor FROM machine_login_refusal ORDER BY rowid').all().map((row) => ({ ...row })), [{ machine_uid: 'uid-h1', executor: 'claude' }]);
  } finally {
    after.close();
  }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});

test('v38 里没有拒用记录，升级后也不会凭空多出一条', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migration-own-login-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL('./fixtures/ledger/schema-v38.sql', import.meta.url), 'utf8'));
  old.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '38');`);
  old.close();
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    assert.deepEqual(ledger.listMachineLogins(), []);
  } finally {
    ledger.close();
  }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(after.prepare('SELECT * FROM machine_login_refusal').all(), []);
  } finally {
    after.close();
  }
});
