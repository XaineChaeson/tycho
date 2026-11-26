// Guards against: a version 26 ledger not taking the usage table, a round ended before it
// read as having used nothing it could say instead of having no figure, and the step
// changing anything that was there.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';

const schema = readFileSync(new URL('./fixtures/ledger/schema-v26.sql', import.meta.url), 'utf8');

test('26 → 28 adds the usage table empty; an older round counts with no figure', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const old = new DatabaseSync(path);
  old.exec(schema);
  old.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '26');
    INSERT INTO project (id, created_at, name) VALUES ('p', 'now', 'project');
    INSERT INTO task (id, created_at, project_id, title, goal, state, created_by) VALUES ('t', 'now', 'p', 'one', 'goal', 'done', 'owner');
    INSERT INTO run (id, created_at, task_id, task_revision, host, state, marker, snapshot_json, started_at, ended_at)
      VALUES ('r', 'now', 't', 1, 'host', 'ended', 'm', '{"brief":"b","login":{"executor":"codex"}}', '2026-11-10T01:00:00.000Z', '2026-11-10T01:00:30.000Z');`);
  const before = old.prepare('SELECT * FROM run').all().map((row) => ({ ...row }));
  old.close();
  assert.equal(SCHEMA_VERSION, 44);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    const report = ledger.usageReport({ from: '2026-11-10T00:00:00.000Z', to: '2026-11-11T00:00:00.000Z', tzOffsetMinutes: 0 });
    assert.deepEqual(report.units.map((cell) => ({ ...cell })), [
      { day: '2026-11-10', source: 'run', project_id: 'p', project_dropped: false, role_id: null, tier: null, login_id: null, executor: 'codex', units: 1, without_usage: 1, duration_ms: 30000 },
    ]);
    assert.deepEqual(report.usage, []);
  } finally { ledger.close(); }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
  const after = new DatabaseSync(path);
  try {
    // Later versions add columns that are empty on older rounds.
    const rows = after.prepare('SELECT * FROM run').all()
      .map(({ releases_dropped_at, code_dropped_at, settlement_digest,capture_result_json, ...row }) => {
        assert.deepEqual([releases_dropped_at, code_dropped_at, settlement_digest,capture_result_json], [null, null, null,null]);
        return row;
      });
    assert.deepEqual(rows, before);
  } finally { after.close(); }
});
