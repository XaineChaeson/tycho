// Guards upgrading a v41 ledger with existing tasks and no tool references.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fixture } from './helpers.ts';

test('v41 task history survives without a fabricated tool cause', (t) => {
  const f = fixture(t);
  const path = join(f.dir, 'old.db');
  const old = new DatabaseSync(path);
  const at = '2026-11-14T00:00:00.000Z';
  try {
    old.exec(readFileSync(new URL('./fixtures/ledger/schema-v41.sql', import.meta.url), 'utf8'));
    old.prepare("INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', ?, 'schema_version', '41')").run(at);
    old.prepare("INSERT INTO project (id, created_at, name) VALUES ('old-project', ?, '旧项目')").run(at);
    old.prepare("INSERT INTO task (id, created_at, project_id, title, goal, state, created_by) VALUES ('old-task', ?, 'old-project', '旧任务', '目标', 'queued', 'router')").run(at);
    old.prepare("INSERT INTO change (id, created_at, at, actor, task_id, action) VALUES ('old-change', ?, ?, 'router', 'old-task', 'task.queue')").run(at, at);
  } finally {
    old.close();
  }
  const migrated = f.open({ log: () => {} }, path);
  assert.equal(migrated.getTask('old-task').title, '旧任务');
  assert.equal(migrated.getProject('old-project').router_account, null);
  assert.equal(migrated.getProject('old-project').router_tier, null);
  assert.equal(migrated.getTunables()['knowledge.externalEntry'], true);
  const [change] = migrated.listChanges({ taskId: 'old-task' });
  assert.equal(change?.action, 'task.queue');
  assert.equal(change?.tool_call_id, null);
  assert.equal(migrated.routerCall('old-project', 'old-change'), undefined);
});
