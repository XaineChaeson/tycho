import { migrationId } from './migration-names.ts';
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';

function oldLedger(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./fixtures/ledger/schema-v24.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '24');
    INSERT INTO account (id, created_at, updated_at, executor, tiers_json, credential_ref) VALUES ('a', 'now', 'now', 'claude', '{}', 'ref');
    INSERT INTO login_state (id, created_at, rest_until, models_json, models_at) VALUES ('a', 'now', 'later', '[{"id":"m"}]', 'before');`);
  db.close();
  return path;
}

test('24 → 25 保留已有模型、额度和账号，身份从未知开始；重开仍在', (t) => {
  const path = oldLedger(t);
  assert.equal(SCHEMA_VERSION, 44);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    const state = ledger.loginState(migrationId(ledger, 'a'));
    assert.deepEqual(state.identity, {});
    assert.deepEqual(state.models, [{ id: 'm' }]);
    assert.equal(state.models_at, 'before');
    assert.equal(state.rest_until, 'later');
    ledger.noteIdentity(migrationId(ledger, 'a'), { organizationId: 'org-fake' });
  } finally { ledger.close(); }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
  const reopened = openLedger(path);
  try { assert.deepEqual(reopened.loginState(migrationId(reopened, 'a')).identity, { organizationId: 'org-fake' }); }
  finally { reopened.close(); }
});

for (const point of ['before', 'after'] as const) {
  test(`24 → 25 在提交${point}中断后仍能重开，不留半步迁移`, (t) => {
    const path = oldLedger(t);
    const crash = (from: number) => { if (from === 24) throw new Error('fake crash'); };
    assert.throws(() => openLedger(path, { copyBeforeUpgrade: false, testHooks: point === 'before'
      ? { beforeMigrationCommit: crash } : { afterMigrationCommit: crash } }), /fake crash/);
    const ledger = openLedger(path, { copyBeforeUpgrade: false });
    try {
      assert.deepEqual(ledger.loginState(migrationId(ledger, 'a')).identity, {});
      assert.deepEqual(ledger.loginState(migrationId(ledger, 'a')).models, [{ id: 'm' }]);
    } finally { ledger.close(); }
  });
}
