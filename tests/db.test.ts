// Guards against: a database that silently runs without WAL/synchronous=FULL
// (commits lost on power failure), a partial schema, a schema from another
// program version being used or altered before being refused, transactions
// that leave half their writes, and a copy taken for a ledger because SQLite can
// open it: an empty file, another program's database, another version's ledger, a file
// that carries a ledger's version without its tables; and a new schema version whose
// tables nobody listed, so that such a file would verify again.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import type { Fixture } from './helpers.ts';
import { fixture, USER } from './helpers.ts';

const TABLES = [
  'account', 'approval', 'change', 'cross_project_ref', 'front_desk', 'im_group_binding', 'im_group_context', 'inbound_key', 'inbound_receipt_reply', 'inbound_source', 'input', 'knowledge', 'knowledge_client', 'knowledge_evidence', 'knowledge_proposal',
  'knowledge_revision', 'login_state', 'machine', 'machine_invite', 'machine_login', 'machine_login_refusal', 'machine_material', 'message', 'outbox',
  'project', 'project_file', 'project_files_cleanup', 'push', 'role', 'router_call', 'router_context', 'router_exchange', 'router_segment', 'router_template', 'run', 'setting', 'task', 'task_contract', 'trigger_cursor', 'trigger_fire',
  'trigger_rule', 'usage', 'wiki_grant', 'wiki_page', 'wiki_proposal', 'wiki_vault', 'work_cleanup',
];

test('schema has the tables it declares and records its version', (t) => {
  const f = fixture(t);
  const names = f
    .peek<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((row) => row.name)
    .sort();
  assert.deepEqual(names, TABLES);
  const [version] = f.peek<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`);
  assert.equal(version!.value_json, String(SCHEMA_VERSION));
});

test('database is in WAL with synchronous=FULL', (t) => {
  const f = fixture(t);
  const db = f.db();
  assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode, 'wal');
  assert.equal(db.get<{ synchronous: number }>('PRAGMA synchronous')!.synchronous, 2);
});

test('opening refuses a database that cannot use WAL', () => {
  assert.throws(() => new Db(':memory:', false), /journal_mode/);
});

test('opening refuses a schema version it does not know', (t) => {
  const f = fixture(t);
  f.force(`UPDATE setting SET value_json = '999' WHERE key = 'schema_version'`);
  assert.throws(() => new Db(f.path, false), /schema 版本/);
});

test('refusing a schema version leaves the database untouched', (t) => {
  const f = fixture(t);
  const path = join(f.dir, 'newer.db');
  const conn = new DatabaseSync(path);
  conn.exec(`CREATE TABLE setting (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, key TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL)`);
  conn.exec(`INSERT INTO setting VALUES ('s1', 'now', 'schema_version', '999')`);
  const state = () => ({
    schema: conn.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(),
    rows: conn.prepare('SELECT * FROM setting ORDER BY rowid').all(),
    journal: conn.prepare('PRAGMA journal_mode').get(),
  });
  const before = state();

  assert.throws(() => new Db(path, false), /schema 版本/);

  assert.deepEqual(state(), before);
  conn.close();
});

test('tables without a schema version are someone else\'s file, not a new database', (t) => {
  const f = fixture(t);
  const path = join(f.dir, 'foreign.db');
  const conn = new DatabaseSync(path);
  conn.exec('CREATE TABLE task (id TEXT)');
  conn.close();
  assert.throws(() => new Db(path, false), /schema 版本/);
});

test('a database without a schema version is new and gets the schema', (t) => {
  const f = fixture(t);
  const path = join(f.dir, 'fresh.db');
  const db = new Db(path, false);
  const version = db.get<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`);
  assert.equal(version!.value_json, String(SCHEMA_VERSION));
  db.close();
  // Opening it a second time must not trip over its own version.
  new Db(path, false).close();
});

async function snapshot(f: Fixture, name = 'copy.db'): Promise<string> {
  const file = join(f.dir, name);
  const source = new DatabaseSync(f.path, { readOnly: true });
  try {
    await backup(source, file);
  } finally {
    source.close();
  }
  return file;
}

test('a snapshot of a ledger verifies as it stands: its settings come back, and nothing is written beside it', async (t) => {
  const f = fixture(t);
  f.ledger.sealRestore('D:/backups/1');
  const file = await snapshot(f);
  const before = readFileSync(file);
  const settings = verifySnapshot(file);
  assert.equal(settings.get('schema_version'), String(SCHEMA_VERSION));
  assert.equal(JSON.parse(settings.get('restore')!).from, 'D:/backups/1');
  assert.deepEqual(readdirSync(f.dir).filter((name) => name.startsWith('copy.db')), ['copy.db'], '不能在旁边留 -wal、-shm');
  assert.deepEqual(readFileSync(file), before);
});

test('what is not a ledger does not verify, though integrity_check calls it ok', async (t) => {
  const f = fixture(t);
  const make = (name: string, sql?: string): string => {
    const file = join(f.dir, name);
    const conn = new DatabaseSync(file);
    if (sql) conn.exec(sql);
    conn.close();
    return file;
  };
  const zero = join(f.dir, 'zero.db');
  writeFileSync(zero, '');
  assert.throws(() => verifySnapshot(zero), /不是 tycho 账本/);
  assert.equal(statSync(zero).size, 0, '验证不能把空文件建成账本');
  assert.throws(() => verifySnapshot(make('header.db', 'PRAGMA journal_mode=WAL')), /不是 tycho 账本/);
  assert.throws(() => verifySnapshot(make('foreign.db', 'CREATE TABLE task (id TEXT)')), /不是 tycho 账本/);
  const other = await snapshot(f, 'other.db');
  make('other.db', `UPDATE setting SET value_json = '999' WHERE key = 'schema_version'`);
  assert.throws(() => verifySnapshot(other), /不是 tycho 账本.*999/);
  const missing = join(f.dir, 'missing.db');
  assert.throws(() => verifySnapshot(missing));
  assert.equal(existsSync(missing), false, '验证不能建文件');
});

// The version row and nothing else of a ledger.
function settingOnly(f: Fixture, version: number): string {
  const file = join(f.dir, `setting-only-${version}.db`);
  const conn = new DatabaseSync(file);
  conn.exec('CREATE TABLE setting (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, key TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL)');
  conn.prepare(`INSERT INTO setting VALUES ('s1', 'now', 'schema_version', ?)`).run(String(version));
  conn.close();
  return file;
}

function without(f: Fixture, whole: string, table: string): string {
  const file = join(f.dir, `without-${table}.db`);
  copyFileSync(whole, file);
  // Off, or dropping a table that others refer to is refused.
  const conn = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  conn.exec(`DROP TABLE ${table}`);
  conn.close();
  return file;
}

const refusal = (file: string): string => {
  try {
    verifySnapshot(file);
  } catch (err) {
    return (err as Error).message;
  }
  return '';
};

test('a file with a ledger\'s version but not the tables of that version does not verify', async (t) => {
  const f = fixture(t);
  assert.match(refusal(settingOnly(f, 4)), /^不是 tycho 账本：缺少表 .*task/);
  assert.match(refusal(settingOnly(f, SCHEMA_VERSION)), /^不是 tycho 账本：缺少表 .*task/);
  const whole = await snapshot(f, 'whole.db');
  assert.equal(refusal(without(f, whole, 'input')), '不是 tycho 账本：缺少表 input');
  assert.equal(refusal(whole), '', '完整的照常通过');
});

test('every version this program opens has its tables listed, and the list for this version is what the schema builds', async (t) => {
  const f = fixture(t);
  const whole = await snapshot(f, 'whole.db');
  const built = f.peek<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).map(({ name }) => name);
  // The version is read from `setting`, so a file without it is refused before the list is asked.
  for (const table of built.filter((name) => name !== 'setting')) {
    assert.equal(refusal(without(f, whole, table)), `不是 tycho 账本：缺少表 ${table}`, `版本 ${SCHEMA_VERSION} 的清单里要有 ${table}`);
  }
  // Downwards from this version, until the program says it no longer takes that one.
  let listed = 0;
  for (let version = SCHEMA_VERSION; version > 0; version -= 1) {
    const message = refusal(settingOnly(f, version));
    if (/这个版本不能直接升级/.test(message)) break;
    assert.match(message, /缺少表/, `版本 ${version} 要有自己的表清单`);
    listed += 1;
  }
  assert.ok(listed >= 1);
  assert.equal(refusal(whole), '', '清单里没有 schema 不建的表');
});

test('a snapshot with a rule broken inside it does not verify', async (t) => {
  const f = fixture(t);
  const file = await snapshot(f);
  const conn = new DatabaseSync(file, { defensive: false });
  conn.exec(`
    CREATE TABLE broken (a);
    INSERT INTO broken VALUES (NULL);
    PRAGMA writable_schema = ON;
    UPDATE sqlite_master SET sql = 'CREATE TABLE broken (a NOT NULL)' WHERE name = 'broken';
  `);
  conn.close();
  assert.throws(() => verifySnapshot(file), /NULL value in broken\.a/);
});

test('transaction commits everything or nothing', (t) => {
  const f = fixture(t);
  const db = f.db();
  const insert = (key: string) =>
    db.run(`INSERT INTO setting (id, created_at, key, value_json) VALUES (?, 'now', ?, '1')`, key, key);

  assert.throws(
    () =>
      db.transaction(() => {
        insert('a');
        insert('a');
      }),
    /UNIQUE/,
  );
  assert.equal(f.peek(`SELECT 1 FROM setting WHERE key = 'a'`).length, 0);

  db.transaction(() => {
    insert('a');
    db.transaction(() => insert('b'));
  });
  assert.equal(f.peek(`SELECT 1 FROM setting WHERE key IN ('a', 'b')`).length, 2);
});

test('a failing operation rolls back its business write and its change row', (t) => {
  const f = fixture(t);
  const tasks = f.count('task');
  const changes = f.count('change');
  // The unknown message id passes the task insert and fails on the change insert.
  assert.throws(
    () =>
      f.ledger.createTask(
        { roleId: 'implement', projectId: f.projectId, title: '任务', goal: '目标', acceptance: '验收' },
        { actor: 'user', messageId: 'no-such-message' },
      ),
    /FOREIGN KEY/,
  );
  assert.equal(f.count('task'), tasks);
  assert.equal(f.count('change'), changes);

  const task = f.newTask();
  const after = f.count('change');
  assert.throws(() => f.ledger.queueTask(task.id, { actor: 'user', messageId: 'no-such-message' }), /FOREIGN KEY/);
  assert.equal(f.task(task.id).state, 'draft');
  assert.equal(f.count('change'), after);
});

test('every successful operation writes one change with who and why', (t) => {
  const f = fixture(t);
  f.force(
    `INSERT INTO message (id, created_at, channel, external_id, direction, text, at) VALUES ('m1', 'now', 'wecom', 'e1', 'in', '做', 'now')`,
  );
  const task = f.newTask();
  f.ledger.queueTask(task.id, { actor: 'router', messageId: 'm1' });
  const [row] = f.peek<{ actor: string; message_id: string; task_id: string; action: string }>(
    'SELECT * FROM change ORDER BY seq DESC LIMIT 1',
  );
  assert.equal(row!.actor, 'router');
  assert.equal(row!.message_id, 'm1');
  assert.equal(row!.task_id, task.id);
  assert.equal(row!.action, 'task.queue');
});
