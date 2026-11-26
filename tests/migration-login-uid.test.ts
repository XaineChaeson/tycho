import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';

const schema = readFileSync(new URL('./fixtures/ledger/schema-v25.sql', import.meta.url), 'utf8');
const snapshot = '{"brief":"original input","login":{"executor":"claude"}}';
function version25(t: TestContext, router = 'alice') {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-login-uid-'));
  const opened: Db[] = [];
  t.after(() => { for (const db of opened) db.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'ledger.db');
  const old = new DatabaseSync(path);
  old.exec(schema);
  old.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '25');
    INSERT INTO account (id, created_at, updated_at, executor, tiers_json, credential_ref) VALUES ('alice', 'now', 'now', 'claude', '{}', 'credential');
    INSERT INTO machine (id, uid, created_at, updated_at, host, node_id) VALUES ('workstation', 'registration-1', 'now', 'now', 'host', 'node-1');
    INSERT INTO machine_login (machine_id, executor, created_at, updated_at, tiers_json) VALUES ('workstation', 'codex', 'now', 'now', '{}'), ('missing-machine', 'codex', 'now', 'now', '{}');
    INSERT INTO login_state (id, created_at, rest_until, identity_json) VALUES ('alice', 'now', 'later', '{"organizationId":"org"}'), ('workstation/codex', 'now', 'tomorrow', '{}'), ('deleted', 'now', 'later', '{}');
    INSERT INTO project (id, created_at, name, logins_json) VALUES ('p', 'now', 'project', '["alice","deleted","workstation/codex","missing-machine/codex"]');
    INSERT INTO task (id, created_at, project_id, title, goal, login_id, state, created_by) VALUES ('t1', 'now', 'p', 'one', 'goal', 'alice', 'running', 'owner'), ('t2', 'now', 'p', 'two', 'goal', 'deleted', 'queued', 'owner');
    INSERT INTO router_context (id, created_at, marker, state, login_id) VALUES ('c1', 'now', 'marker', 'closed', 'alice'), ('c2', 'now', 'marker', 'closed', 'deleted');`);
  old.prepare("INSERT INTO setting (id, created_at, key, value_json) VALUES ('tunables', 'now', 'tunables', ?)").run(JSON.stringify({ 'router.account': router, 'knowledge.logins': ['workstation/codex', 'deleted', 'alice'], 'http.port': 12345 }));
  for (const [id, task, login] of [['r1', 't1', 'alice'], ['r2', 't2', 'deleted'], ['r3', 't2', 'workstation/codex']]) {
    old.prepare("INSERT INTO run (id, created_at, task_id, task_revision, login_id, host, state, marker, snapshot_json) VALUES (?, 'now', ?, 1, ?, 'host', 'ended', 'marker', ?)").run(id!, task!, login!, snapshot);
  }
  old.exec("INSERT INTO input (id, created_at, task_id, text, actor, state, run_id) VALUES ('input', 'now', 't1', 'text', 'owner', 'delivered', 'r1')");
  old.close();
  return { path, open: () => { const db = new Db(path, false, {}, { copyBeforeUpgrade: false }); opened.push(db); return db; } };
}
const inspect = (db: Db) => Object.fromEntries(['account', 'machine_login', 'project', 'task', 'run', 'router_context', 'login_state', 'setting', 'change', 'outbox', 'push'].map((table) => [table, db.all(`SELECT * FROM ${table}`)]));

test('25 → 26 migrates every reference, keeps historical names and audits dangling references', (t) => {
  const { path, open } = version25(t);
  const db = open();
  assert.equal(SCHEMA_VERSION, 44);
  const account = db.get<{ id: string; name: string; credential_ref: string }>('SELECT * FROM account')!;
  assert.equal(account.name, 'alice');
  assert.match(account.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(account.credential_ref, 'credential');
  const own = db.get<{ id: string; machine_uid: string }>('SELECT * FROM machine_login')!;
  assert.match(own.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notEqual(own.id, account.id);
  assert.equal(own.machine_uid, 'registration-1');
  assert.equal(db.all('SELECT * FROM machine_login').length, 1);
  assert.deepEqual(JSON.parse(db.get<{ logins_json: string }>('SELECT logins_json FROM project')!.logins_json), [account.id, own.id]);
  assert.deepEqual(db.all<{ login_id: string | null }>('SELECT login_id FROM task ORDER BY id').map((r) => r.login_id), [account.id, null]);
  const history = db.get<{ login_id: string }>("SELECT login_id FROM run WHERE id='r2'")!.login_id;
  assert.match(history, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notEqual(history, account.id);
  assert.notEqual(history, own.id);
  assert.deepEqual(db.all<Record<string, unknown>>('SELECT id, login_id, login_name, snapshot_json FROM run ORDER BY id').map((r) => ({ ...r })), [
    { id: 'r1', login_id: account.id, login_name: 'alice', snapshot_json: snapshot },
    { id: 'r2', login_id: history, login_name: 'deleted', snapshot_json: snapshot },
    { id: 'r3', login_id: own.id, login_name: 'workstation/codex', snapshot_json: snapshot },
  ]);
  assert.deepEqual(db.all<Record<string, unknown>>('SELECT login_id, login_name FROM router_context ORDER BY id').map((r) => ({ ...r })), [{ login_id: account.id, login_name: 'alice' }, { login_id: null, login_name: 'deleted' }]);
  assert.deepEqual(db.all<{ id: string }>('SELECT id FROM login_state').map(({ id }) => id).sort(), [account.id, own.id].sort());
  assert.equal(db.get<{ identity_json: string }>('SELECT identity_json FROM login_state WHERE id = ?', account.id)!.identity_json, '{"organizationId":"org"}');
  assert.deepEqual(JSON.parse(db.get<{ value_json: string }>("SELECT value_json FROM setting WHERE key = 'tunables'")!.value_json), { 'router.account': account.id, 'knowledge.logins': [own.id, account.id], 'http.port': 12345, 'knowledge.externalEntry': true });
  const changes = db.all<{ action: string; detail_json: string }>("SELECT action, detail_json FROM change WHERE actor = 'migration'");
  for (const action of ['project.update', 'task.update', 'run.update', 'router.context.update', 'login.state.delete', 'machine_login.delete', 'setting.update']) {
    assert.ok(changes.some((change) => change.action === action && /deleted|missing-machine/.test(change.detail_json)), `missing audit: ${action}`);
  }
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  const before = inspect(db); db.close();
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
  const again = open();
  try { assert.deepEqual(inspect(again), before); } finally { again.close(); }
});

test('migrated missing machine-login deletion is understood by the ordinary deletion query', (t) => {
  const { path, open } = version25(t);
  open().close();
  const ledger = openLedger(path);
  try { assert.equal(ledger.loginWasDeleted('missing-machine/codex'), true); }
  finally { ledger.close(); }
});

test('deleted historical logins keep one non-reusable identity; unfinished references are cleared', (t) => {
  const { path, open } = version25(t);
  const old = new DatabaseSync(path);
  old.prepare("INSERT INTO run (id, created_at, task_id, task_revision, login_id, host, state, marker, snapshot_json) VALUES ('r4', 'now', 't2', 1, 'deleted', 'host', 'ended', 'marker', ?), ('r5', 'now', 't2', 1, 'deleted', 'host', 'running', 'marker', ?)").run(snapshot, snapshot);
  old.close();
  const db = open();
  const historical = db.get<{ login_id: string }>("SELECT login_id FROM run WHERE id='r2'")!.login_id;
  assert.match(historical, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(db.get<{ login_id: string }>("SELECT login_id FROM run WHERE id='r4'")!.login_id, historical);
  assert.equal(db.get<{ login_id: string | null }>("SELECT login_id FROM run WHERE id='r5'")!.login_id, null);
  db.close();
  const ledger = openLedger(path);
  try {
    ledger.putAccount({ id: 'replacement', name: 'deleted', executor: 'claude', tiers: {} }, { actor: 'owner' }, 'ref');
    for (const id of ['r2', 'r4']) {
      const run = ledger.getRun(id);
      assert.equal(run.login_id, historical);
      assert.equal(run.login_name, 'deleted');
      assert.equal(run.snapshot_json, snapshot);
    }
  } finally { ledger.close(); }
});

for (const later of ['unchanged', 'rejoined', 'deleted', 'unknown'] as const) {
  test(`host registration migration: ${later}`, (t) => {
    const { path, open } = version25(t);
    const old = new DatabaseSync(path);
    if (later !== 'unknown') old.prepare("INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES ('local', 'now', 'now', 'owner', 'machine.join_local', ?)").run(JSON.stringify({ machine_id: 'workstation' }));
    if (later === 'rejoined') {
      old.prepare("INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES ('gone', 'now', 'now', 'owner', 'machine.delete', ?), ('remote', 'now', 'now', 'owner', 'machine.join', ?)").run(JSON.stringify({ machine_id: 'workstation' }), JSON.stringify({ machine_id: 'workstation' }));
      old.exec("UPDATE machine SET uid='replacement' WHERE id='workstation'");
    }
    if (later === 'deleted') old.exec("UPDATE machine SET left_at='later' WHERE id='workstation'");
    old.close();
    const db = open();
    const uid = db.get<{ value_json: string }>("SELECT value_json FROM setting WHERE key='host_machine_uid'");
    assert.equal(uid === undefined ? undefined : JSON.parse(uid.value_json), later === 'unchanged' ? 'registration-1' : later === 'unknown' ? undefined : null);
    db.close();
    const ledger = openLedger(path);
    try {
      assert.equal(ledger.hostMachine(), later === 'unchanged' ? 'workstation' : later === 'unknown' ? undefined : null);
      ledger.joinMachine({ id: 'recovered-host', host: 'host', nodeId: 'local-node', tokenHash: 'test-hash', platform: 'test', source: null, ephemeral: false, local: true }, { actor: 'owner' });
      assert.equal(ledger.hostMachine(), 'recovered-host', '重新本机接入后告警消失');
    }
    finally { ledger.close(); }
  });
}

test('a fresh host has no unresolved migrated local registration', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-fresh-host-'));
  const ledger = openLedger(join(dir, 'ledger.db'));
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(ledger.hostMachine(), undefined);
});

test('dangling router account is explicitly cleared and audited', (t) => {
  const db = version25(t, 'deleted').open();
  const tunables = JSON.parse(db.get<{ value_json: string }>("SELECT value_json FROM setting WHERE key = 'tunables'")!.value_json);
  assert.equal(tunables['router.account'], '');
  assert.equal(tunables['http.port'], 12345);
  assert.ok(db.all<{ detail_json: string }>("SELECT detail_json FROM change WHERE actor='migration' AND action='setting.update'").some(({ detail_json }) => detail_json.includes('router.account') && detail_json.includes('deleted')));
});

test('queued and reminded notices migrate login references, including nested payloads', (t) => {
  const { path, open } = version25(t);
  const old = new DatabaseSync(path);
  old.prepare(`INSERT INTO outbox (id, created_at, channel, kind, payload_json, state, next_at) VALUES ('notice', 'now', 'wecom', 'remind', ?, 'pending', 'now')`)
    .run(JSON.stringify({ kind: 'account_credential_rejected', payload: { account_id: 'alice', ref: 'credential' }, external_id: 'old-key' }));
  old.prepare(`INSERT INTO push (id, created_at, key, level, kind, payload_json, state) VALUES ('push', 'now', 'push-key', 'wait', 'machine_login_refused', ?, 'open')`)
    .run(JSON.stringify({ login_id: 'workstation/codex', at: 'then' }));
  old.prepare(`INSERT INTO outbox (id, created_at, channel, kind, payload_json, state, next_at) VALUES ('gone', 'now', 'wecom', 'no_machine', ?, 'pending', 'now')`)
    .run(JSON.stringify({ login_id: 'deleted' }));
  old.close();
  const db = open();
  const account = db.get<{ id: string }>('SELECT id FROM account')!;
  const own = db.get<{ id: string }>('SELECT id FROM machine_login')!;
  const payload = (table: string, id: string) => JSON.parse(db.get<{ payload_json: string }>(`SELECT payload_json FROM ${table} WHERE id = ?`, id)!.payload_json);
  assert.deepEqual(payload('outbox', 'notice'), { kind: 'account_credential_rejected', payload: { account_id: account.id, ref: 'credential' }, external_id: 'old-key' });
  assert.deepEqual(payload('push', 'push'), { login_id: own.id, at: 'then' });
  assert.equal(payload('outbox', 'gone').login_id, null);
  assert.ok(db.all<{ detail_json: string }>("SELECT detail_json FROM change WHERE actor='migration' AND action='outbox.update'").some(({ detail_json }) => detail_json.includes('deleted')));
});

test('a migrated v25 ledger has the same columns, foreign keys and indexes as a new ledger', (t) => {
  const { path, open } = version25(t);
  open().close();
  const freshPath = join(path, '..', 'fresh.db');
  new Db(freshPath, false).close();
  const shape = (file: string) => {
    const conn = new DatabaseSync(file);
    try {
      const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
      return tables.map(({ name }) => ({
        name,
        columns: conn.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`).all(name),
        foreignKeys: conn.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name),
        indexes: (conn.prepare('SELECT name, "unique", partial FROM pragma_index_list(?) ORDER BY name').all(name) as { name: string; unique: number; partial: number }[])
          .map((index) => ({ unique: index.unique, partial: index.partial, columns: conn.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name),
            where: (conn.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(index.name)?.sql as string | null)?.match(/\bWHERE\b(.+)$/i)?.[1] ?? null,
          })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      }));
    } finally { conn.close(); }
  };
  assert.deepEqual(shape(path), shape(freshPath));
});

for (const point of ['before', 'after'] as const) {
  test(`25 → 26 interrupted ${point} commit leaves one complete version; retry is idempotent`, (t) => {
    const { path, open } = version25(t);
    const crash = (from: number) => { if (from === 25) throw new Error('fake crash'); };
    assert.throws(() => new Db(path, false, point === 'before' ? { beforeMigrationCommit: crash } : { afterMigrationCommit: crash }, { copyBeforeUpgrade: false }), /fake crash/);
    const disk = new DatabaseSync(path);
    assert.equal(disk.prepare("SELECT value_json FROM setting WHERE key='schema_version'").get()!.value_json, point === 'before' ? '25' : '26');
    if (point === 'before') {
      assert.equal(disk.prepare('SELECT id FROM account').get()!.id, 'alice');
      assert.equal(disk.prepare('SELECT COUNT(*) AS n FROM change').get()!.n, 0);
    }
    disk.close();
    const db = open();
    const before = inspect(db); db.close();
    const reopened = open();
    try { assert.deepEqual(inspect(reopened), before); } finally { reopened.close(); }
  });
}

test('reusing account and machine names after migration cannot inherit old references or state', (t) => {
  const db = version25(t).open();
  const previous = db.get<{ id: string }>('SELECT id FROM account')!.id;
  const own = db.get<{ id: string }>('SELECT id FROM machine_login')!.id;
  db.run('DELETE FROM account');
  db.run("INSERT INTO account (id, name, created_at, updated_at, executor, tiers_json, credential_ref) VALUES ('new-account', 'alice', 'now', 'now', 'claude', '{}', 'new-credential')");
  db.run('DELETE FROM machine_login'); db.run('DELETE FROM machine');
  db.run("INSERT INTO machine (id, uid, created_at, updated_at, host, node_id) VALUES ('workstation', 'registration-2', 'now', 'now', 'host', 'node-2')");
  db.run("INSERT INTO machine_login (id, machine_uid, machine_id, executor, created_at, updated_at, tiers_json) VALUES ('new-own', 'registration-2', 'workstation', 'codex', 'now', 'now', '{}')");
  assert.deepEqual(JSON.parse(db.get<{ logins_json: string }>('SELECT logins_json FROM project')!.logins_json), [previous, own]);
  assert.equal(db.get<{ login_id: string }>("SELECT login_id FROM task WHERE id='t1'")!.login_id, previous);
  assert.equal(db.get("SELECT * FROM login_state WHERE id='new-account'"), undefined);
  assert.equal(db.get("SELECT * FROM login_state WHERE id='new-own'"), undefined);
});
