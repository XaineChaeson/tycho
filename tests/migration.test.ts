import { migrationId, migrationNames } from './migration-names.ts';
// Guards against an upgrade that loses or rewrites what an older ledger held, a crash in
// the middle of an upgrade leaving a ledger that is neither version (tables of the new
// one under the number of the old, or the other way round), a later open starting the
// steps over or skipping one, a ledger from a newer program being opened and written by
// an older one, an older ledger being altered by an open that was only meant to read,
// and a backup taken before an upgrade being refused by the restore that follows it.
// And against an upgrade with no way back, since the older program refuses the upgraded
// ledger: no copy of the ledger as it was, a copy short of the commits still in the -wal,
// an upgrade that goes ahead though its copy could not be made, a half-written or stale
// file standing where the copy belongs, a copy made where there was nothing to upgrade or
// beside a restore's working file, and a start that does not say where the copy is.
// And against the upgrade to version 6 changing what an older ledger's Tasks do: they
// all name a target, which has to read as pinned to it, with no ceiling and no rest
// appearing on a target by the upgrade itself.
// And against v7 widening an account's machine range, merging distinct SSH identities,
// losing quota state, rewriting old snapshots or leaving half of the split after a crash.
// And against the machine a Run was on being read from the missing machine_id alone: one
// the upgrade could not name waits only where the account still names it.
// And against v11 dropping what a target has learned about its account: a rest, a usage
// figure, a refused token or an already-read model list lost or rewritten by the step that
// adds the model columns.
// And against v12 inventing a code directory for a project of an older ledger: only the
// column is added, and a project that never named a checkout reads as one that names none.
// And against v13 inventing a node identity for a machine or a Run of an older ledger: the
// columns are added empty, and a machine that never came back by itself stays one reached
// over SSH.
// And against v14 making a task able to spawn machines it never could: every project's
// switch reads off, every machine there was reads as one let in by hand and still
// registered, with none of the endings a spawned machine has, and a crash on either side
// of the step's commit leaves one version or the other.
// And against v15 rewriting a tier's content while renaming it, guessing what a name it
// does not know meant, losing a value behind a name the account already held, letting a
// Task run on a name the system no longer uses, changing a closed Task's record,
// silently replacing the Router's own tier with the executor's default, renaming an old
// name some account holds together with the name it would become (which of the two values
// a reference meant is the owner's to say), parking a Task that still has a round out
// there so its receipt would be dropped, or reading a name every object has
// (`constructor`, `toString`, `__proto__`) as one the mapping knows.
// And against v16 guessing a role from an old tier, keeping a Task's tier as a stored copy,
// letting a Task with no role into the queue, parking a Task out from under a round still out
// there, a question still open, an acceptance still pending or a draft never queued, giving an
// ended Task a role or a reason it never had, touching a Run's snapshot, starting without the
// four presets, or a crash on either side of the step's commit leaving half of it.
// And against a lost round of an unpinned Task with no role being judged gone for want of
// a candidate, or left silent: it waits, the Router is told once, and a role lets it go on.
// And against v17 changing any Task while adding review, making an older override look
// like an escalation, leaving a v16 Task that needs review acceptable without one or
// unable to be reviewed, or a crash on either side of the step's commit leaving half of it.
// And against v18 moving anything an older ledger held while adding knowledge, inventing an
// entry, a proposal or a client, or a crash on either side of the step's commit leaving some
// of the five tables without the version that names them.
// And against v39 losing or inventing a project's code source (docs/design/code-sources.md §5):
// its own tests are tests/migration-sources.test.ts, over the recorded v38 schema.
// And against v43 inventing output adoption/release evidence for older Runs or cleanup
// rows, or losing an older value while adding those two nullable columns atomically.
import assert from 'node:assert/strict';
import { createAccounts } from '../service/accounts.ts';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Db, migrate, SCHEMA_VERSION, TASK_SELECT, verifySnapshot } from '../service/db.ts';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { loginMissing, openLedger } from '../service/ledger.ts';
import { startService } from '../service/main.ts';
import { restoreBackup } from '../service/restore.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner } from '../runner/runner.ts';
import { fakeRemote } from './fake-remote.ts';
import { loginConfig, sameConfig } from '../runner/snapshot.ts';
import type { Snapshot } from '../runner/snapshot.ts';
import { TIER_RENAMES } from '../service/db.ts';
import { NO_ROLE_REASON, PRESET_ROLES } from '../shared/roles.ts';
import { roleConfig } from '../service/ledger.ts';
import { stage } from './stage.ts';
import { DISPATCH_TUNED, joinedBefore24, RUNNER_TUNED, RUN_LIMIT_MS, signedInEverywhere, uidsOf } from './helpers.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import { createLogins } from '../service/logins.ts';

const FAKE_CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');
const V4 =readFileSync(new URL('./fixtures/ledger/schema-v4.sql', import.meta.url), 'utf8');
const V8 = readFileSync(new URL('./fixtures/ledger/schema-v8.sql', import.meta.url), 'utf8');
const V9 = readFileSync(new URL('./fixtures/ledger/schema-v9.sql', import.meta.url), 'utf8');
const V10 = readFileSync(new URL('./fixtures/ledger/schema-v10.sql', import.meta.url), 'utf8');
const V11 = readFileSync(new URL('./fixtures/ledger/schema-v11.sql', import.meta.url), 'utf8');
const V14 = readFileSync(new URL('./fixtures/ledger/schema-v14.sql', import.meta.url), 'utf8');
const V15 = readFileSync(new URL('./fixtures/ledger/schema-v15.sql', import.meta.url), 'utf8');
const V16 = readFileSync(new URL('./fixtures/ledger/schema-v16.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';
// Where the copy of a version 4 ledger goes, and what it is called while being written.
const COPY = 'ledger.before-v5.db';
const PARTIAL = `${COPY}.partial`;

class Crash extends Error {}

// Brings an older ledger forward through version 17 and no further: the version the
// steps before 18 are tested at. Version 18 makes every account a login tycho keeps, and
// an account of an older ledger, which kept none, a machine's own login (the tests of the
// step to 18 are below); what an older step did is read as it left it.
class StopAt17 extends Error {}
function toV17(path: string, log: (line: string) => void = () => {}): void {
  try {
    new Db(path, false, { beforeMigrationCommit(from) { if (from === 17) throw new StopAt17(); } }, { log }).close();
  } catch (err) {
    if (!(err instanceof StopAt17)) throw err;
  }
}

// What a step test before 18 reads back, read off a ledger brought through version 17:
// the same answers this program's ledger gives for what those steps wrote, without the
// step that makes accounts logins.
function atV17(path: string, options: { log?: (line: string) => void } = {}) {
  toV17(path, options.log);
  const conn = new DatabaseSync(path);
  const one = <T>(sql: string, ...params: string[]): T | undefined => conn.prepare(sql).get(...params) as T | undefined;
  type AccountRow = { id: string; executor: string; machines_json: string; config_dir: string | null; tiers_json: string; permission_mode: string | null; timeout_ms: number | null; max_runs: number | null; credential_ref: string | null };
  return {
    getAccount(id: string) {
      const row = one<AccountRow>('SELECT * FROM account WHERE id = ?', id);
      return row && {
        id: row.id, name: row.id, executor: row.executor, machines: JSON.parse(row.machines_json) as string[],
        ...(row.config_dir === null ? {} : { configDir: row.config_dir }),
        ...(row.permission_mode === null ? {} : { permissionMode: row.permission_mode }),
        tiers: JSON.parse(row.tiers_json) as Record<string, unknown>,
        ...(row.timeout_ms === null ? {} : { timeoutMs: row.timeout_ms }),
        ...(row.max_runs === null ? {} : { maxRuns: row.max_runs }),
      };
    },
    listAccounts: () => (conn.prepare('SELECT id FROM account ORDER BY rowid').all() as { id: string }[]).map(({ id }) => id),
    accountCredentialRef: (id: string): string | null => one<{ credential_ref: string | null }>('SELECT credential_ref FROM account WHERE id = ?', id)?.credential_ref ?? null,
    getTunables(): Record<string, unknown> {
      const row = one<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'tunables'`);
      return row === undefined ? {} : (JSON.parse(row.value_json) as Record<string, unknown>);
    },
    loginState(id: string) {
      const row = one<{ rest_until: string | null; rest_streak: number; rest_reason: string | null; usage_json: string; credential_rejected_ref: string | null; models_json: string; models_at: string | null }>('SELECT * FROM account_state WHERE id = ?', id);
      if (!row) return { rest_until: null, rest_streak: 0, rest_reason: null, usage: [], credential_rejected_ref: null, models: [], models_at: null };
      const usage = JSON.parse(row.usage_json) as Record<string, object>;
      return {
        rest_until: row.rest_until, rest_streak: row.rest_streak, rest_reason: row.rest_reason,
        usage: Object.entries(usage).map(([window, figure]) => ({ window, ...figure })),
        credential_rejected_ref: row.credential_rejected_ref, models: JSON.parse(row.models_json) as unknown[], models_at: row.models_at,
      };
    },
    getRun: (id: string) => one<RunRow & { account_id: string }>('SELECT * FROM run WHERE id = ?', id)!,
    getTask: (id: string) => one<TaskRow & { account_id: string | null }>(`${TASK_SELECT} WHERE task.id = ?`, id)!,
    listTasks: () => conn.prepare(`${TASK_SELECT} ORDER BY task.rowid`).all() as unknown as (TaskRow & { account_id: string | null })[],
    getProject: (id: string) => one<{ name: string; repo: string | null; code_dir: string | null; accounts_json: string; machines_json: string; spawn_machines: number }>('SELECT * FROM project WHERE id = ?', id)!,
    close: () => { if (conn.isOpen) conn.close(); },
  };
}

// Compare every pre-existing value across the deliberate v7 column renames, the v15 tier
// renames and the columns later versions add. Newly introduced columns are asserted
// independently in the tests of the step that adds them, v7 and v13 below.
// The changes an upgrade leaves, but for the audit v32 keeps of a configuration directory it
// dropped, for an account or a Router context (tests/migration-config-dir.test.ts): that one is
// the upgrade's own record of a value.
const ownChanges = (rows: unknown[]): unknown[] => rows.filter((row) => {
  const each = row as { action?: unknown; actor?: unknown; detail_json?: unknown };
  const audit = each.actor === 'migration' && (each.action === 'account.update' || each.action === 'router_context.update');
  return !(audit && String(each.detail_json).includes('config_dir_removed'));
});

function legacyRows(rows: unknown[], names = new Map<string, string>()): object[] {
  return rows.map((value) => {
    const row = { ...(value as Record<string, unknown>) };
    // Version 26 introduces opaque identities and separate historical labels.
    if (Object.hasOwn(row, 'name') && Object.hasOwn(row, 'executor')) { row.id = row.name; delete row.name; }
    // Version 27 says when the token an account holds came in; an account of an older ledger
    // has no moment, and one is not invented for the comparison either.
    delete row.credential_at;
    for (const key of ['login_id', 'account_id']) if (typeof row[key] === 'string') row[key] = names.get(row[key] as string) ?? row[key];
    if (typeof row.logins_json === 'string') row.logins_json = JSON.stringify((JSON.parse(row.logins_json) as string[]).map((id) => names.get(id) ?? id));
    delete row.login_name;
    // v27 adds an account's line, empty for every account an older ledger holds.
    if (row.provider_json === null) delete row.provider_json;
    // v29 adds a project's pause and a Router context's size, empty for an older ledger.
    if (row.paused_at === null) delete row.paused_at;
    if (row.context_tokens === null) delete row.context_tokens;
    // v35 adds a project's archive mark; no project of an older ledger is archived.
    if (row.archived_at === null) delete row.archived_at;
    // v31 gives a project what its Router may do without asking: what it could always do.
    if (row.grants_json === '["accept"]') delete row.grants_json;
    // v33 marks a merge round; no Task of an older ledger is one.
    if (row.landing_json === null) delete row.landing_json;
    // v34 says when a finished work's copies were cleared; nothing of an older ledger was.
    if (row.releases_dropped_at === null) delete row.releases_dropped_at;
    if (row.code_dropped_at === null) delete row.code_dropped_at;
    if (row.settlement_digest === null) delete row.settlement_digest;
    // v43 adds output disposition; older Runs have none (asserted separately below).
    if (row.capture_result_json === null) delete row.capture_result_json;
    // v36 adds the Router's preference for a Task; no Task of an older ledger has one.
    if (row.prefer_json === null) delete row.prefer_json;
    if (row.tool_call_id === null) delete row.tool_call_id;
    if (row.router_account === null) delete row.router_account;
    if (row.router_tier === null) delete row.router_tier;
    if (row.dispatch_order_json === null) delete row.dispatch_order_json;
    // v49 adds project single-group category and pin flag, both empty/off for older projects.
    if (row.category === null) delete row.category;
    if (row.pinned === 0) delete row.pinned;
    // v39 replaces a project's repo/code_dir with its sources list, and pins every unfinished
    // Task to the first source; an older ledger has neither column, and the step's own tests
    // assert what the migration made of them.
    delete row.repo;
    delete row.sources_json;
    delete row.source_json;
    // v32 drops the configuration directory an account and a Router context had (its audit is below).
    delete row.config_dir;
    // v16 drops a Task's own tier for its role, and adds the role and an override, both
    // empty for a Task of an older ledger: neither side of the comparison carries them.
    delete row.tier;
    delete row.role_id;
    delete row.tier_override;
    delete row.tier_reason;
    // v17 adds review: an escalation flag, a binding and a verdict, all empty for an older Task.
    delete row.tier_escalated;
    delete row.review_of_json;
    delete row.verdict_json;
    delete row.artifacts_json;
    // v19 marks a knowledge gate or curation Task; none of an older ledger is one.
    delete row.knowledge_json;
    // v21 says which trigger occurrence a Task's work came from; none of an older ledger's did.
    delete row.trigger_fire_id;
    // v22 says which skills a Task names; no older Task names any.
    delete row.skills_json;
    // v20 gives a project its way of choosing logins: an older one keeps its list, as "only these".
    if (row.login_mode === 'selected') delete row.login_mode;
    // v7 called them accounts and v18 logins (an account, or a machine's own login): a test
    // reads a ledger at either.
    for (const name of ['accounts_json', 'logins_json']) {
      if (!Object.hasOwn(row, name)) continue;
      row.allowed_targets_json = row[name];
      delete row[name];
      delete row.machines_json;
      delete row.code_dir;
      delete row.spawn_machines;
    }
    for (const name of ['account_id', 'login_id']) {
      if (!Object.hasOwn(row, name)) continue;
      row.target_id = row[name];
      delete row[name];
      delete row.machine_id;
      delete row.node_id;
    }
    return row;
  });
}

// Version 9 wraps a tier value's old string in a `ref`, in the account table and in the
// account a Run's snapshot recorded. Tests that hold an upgraded ledger against the rows
// it came from apply the same wrap to the old side.
function wrapTiers(tiers: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(tiers as Record<string, string>).map(([tier, value]) => [tier, { kind: 'ref', value }]));
}

// Version 15 renames the two old tier names in an account's tier list, so an account of an
// older ledger comes forward under the names this program uses. A name the mapping does not
// know is left as it is.
function renameTiers(tiers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(tiers).map(([name, value]) => [TIER_RENAMES.get(name) ?? name, value]));
}

// What the owner does for a Task v16 left waiting for a role: picks one, and lets it go on.
// The tests of older versions that go on to dispatch do it before they do.
function pickRoles(ledger: ReturnType<typeof openLedger>, roleId = 'implement'): void {
  for (const task of ledger.listTasks()) {
    if (task.role_id !== null || task.state === 'done' || task.state === 'abandoned') continue;
    ledger.updateTask(task.id, { roleId }, { actor: 'test' });
    if (task.state === 'waiting_person' && task.reason === NO_ROLE_REASON) ledger.resumeTask(task.id, { actor: 'test' });
  }
}

// A ledger as the previous program version left it: its schema as recorded, and rows of
// the kinds an upgrade must carry over.
function version4(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate-'));
  // Closed before the directory goes: Windows does not remove a file that is open.
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V4);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('s1', AT, 'schema_version', '4');
  setting.run('s2', AT, 'tunables', JSON.stringify({ 'run.lostGraceMs': 120_000 }));
  setting.run('s3', AT, 'whitelist', JSON.stringify({ console: ['console'] }));
  setting.run('s4', AT, 'pause.user', 'true');
  conn.prepare(`INSERT INTO project (id, created_at, name, allowed_targets_json) VALUES ('p1', ?, '试跑', '["t1"]')`).run(AT);
  conn.prepare(
    `INSERT INTO task (id, created_at, project_id, title, goal, acceptance, target_id, tier, state, created_by)
     VALUES ('k1', ?, 'p1', '旧任务', '目标', '验收', 't1', 'cheap', 'running', 'router')`,
  ).run(AT);
  conn.prepare(
    `INSERT INTO run (id, created_at, task_id, task_revision, target_id, host, state, marker, snapshot_json)
     VALUES ('r1', ?, 'k1', 1, 't1', 'h1', 'running', 'tycho-run:r1', '{"brief":"b"}')`,
  ).run(AT);
  conn.prepare(
    `INSERT INTO change (id, created_at, at, actor, task_id, run_id, action) VALUES ('c1', ?, ?, 'dispatcher', 'k1', 'r1', 'run.create')`,
  ).run(AT, AT);
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const peek = new DatabaseSync(file);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  const version = (file = path): string => read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`, file)[0]!.value_json;
  const tables = (file = path): string[] => read<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`, file).map(({ name }) => name);
  const dump = (file = path) => Object.fromEntries(
    ['project', 'task', 'run', 'change', 'setting'].map((table) => [table, legacyRows(read(`SELECT * FROM ${table} WHERE NOT (${table === 'setting' ? `key = 'schema_version'` : table === 'change' ? `actor = 'migration'` : '0'}) ORDER BY rowid`, file))]),
  );
  const copy = join(dir, COPY);
  // Everything an upgrade may have left beside the ledger, side files included.
  const copies = (): string[] => readdirSync(dir).filter((name) => name.includes('.before-v')).sort();
  return { dir, path, copy, copies, read, version, tables, dump, closing };
}

// New columns must exist and be empty, even when the historical projection omits them.
function assertNoOutputDisposition(path: string): void {
  const conn = new DatabaseSync(path);
  try {
    for (const [table, column] of [['run', 'capture_result_json'], ['work_cleanup', 'output_release_json']]) {
      const fields = conn.prepare(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${table}') WHERE name = ?`).all(column);
      assert.deepEqual(fields.map((row) => ({ ...row })), [{ name: column, type: 'TEXT', notnull: 0, dflt_value: null }]);
      const values = conn.prepare(`SELECT ${column} AS value FROM ${table}`).all() as { value: unknown }[];
      assert.deepEqual(values.map(({ value }) => value), values.map(() => null), `${table}.${column} must not invent output evidence`);
    }
  } finally {
    conn.close();
  }
}

// A commit that is only in the -wal: a second connection stays open, so closing the first
// merges nothing.
function clearedV4(rows: ReturnType<ReturnType<typeof version4>['dump']>) {
  return { ...rows,
    project: rows.project!.map((row) => ({ ...row, allowed_targets_json: '[]' })),
    task: rows.task!.map((row) => ({ ...row, target_id: null })),
    run: rows.run!.map((row) => ({ ...row, target_id: null })),
    setting: (rows.setting as { key: string; value_json: string }[]).map((row) => row.key === 'tunables'
      ? { ...row, value_json: JSON.stringify({ ...JSON.parse(row.value_json), 'knowledge.externalEntry': true }) } : row),
  };
}
function commitInWal(old: ReturnType<typeof version4>): void {
  const holder = old.closing(new DatabaseSync(old.path));
  holder.prepare(`INSERT INTO project (id, created_at, name, allowed_targets_json) VALUES ('p2', ?, '只在日志里的', '[]')`).run(AT);
  const alone = join(old.dir, 'main-file-alone.db');
  copyFileSync(old.path, alone);
  assert.deepEqual(old.read<{ id: string }>('SELECT id FROM project', alone).map(({ id }) => id), ['p1'], '这一条要的是有一部分数据只在 -wal 里');
}

test('the first upgrade leaves the ledger as it was beside the new one, commits still in the -wal included', (t) => {
  const old = version4(t);
  commitInWal(old);
  const before = old.dump();
  const tables = old.tables();
  const logs: string[] = [];
  const ledger = old.closing(openLedger(old.path, { log: (line) => logs.push(line) }));
  assert.equal(old.version(), String(SCHEMA_VERSION));

  assert.deepEqual(old.copies(), [COPY], '只有副本本身：没有半截文件，也没有 -wal、-shm');
  assert.equal(verifySnapshot(old.copy).get('schema_version'), '4');
  assert.deepEqual(old.tables(old.copy), tables, '副本是升级前的样子');
  assert.deepEqual(old.dump(old.copy), before, '-wal 里的那部分也在');
  assert.equal(logs.length, 1);
  assert.ok(logs[0]!.includes(old.copy), '启动日志里说它在哪');

  // The copy has been opened and read by now. The ledger goes on as if it were not there.
  ledger.createProject({ name: '升级后新建的' }, { actor: 'user' });
  assert.equal(old.version(), String(SCHEMA_VERSION));
  assert.equal(ledger.listProjects().length, 3);
  assert.equal(old.version(old.copy), '4');
  assert.deepEqual(old.dump(old.copy), before);
});

for (const [name, taken] of [['临时名被占着', PARTIAL], ['副本的位置被占着', COPY]] as const) {
  test(`升级前的副本做不成（${name}）：不升级，账本原样，说明怎么办；修好后照常升级`, (t) => {
    const old = version4(t);
    commitInWal(old);
    const before = old.dump();
    const tables = old.tables();
    // A directory with something in it: neither a delete nor a rename gets past it.
    const blocked = join(old.dir, taken);
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'x'), '');
    let steps = 0;
    assert.throws(() => new Db(old.path, false, { beforeMigrationCommit: () => { steps += 1; } }), (err: Error) => {
      assert.match(err.message, /副本/);
      assert.match(err.message, /账本没有动/);
      assert.match(err.message, /磁盘空间/);
      assert.match(err.message, /旧版本程序/);
      assert.ok(err.message.includes(old.dir), '说的是哪个目录');
      return true;
    });
    assert.equal(steps, 0, '一步都没开始');
    assert.equal(old.version(), '4');
    assert.deepEqual(old.tables(), tables);
    assert.deepEqual(old.dump(), before);
    assert.deepEqual(old.copies(), [taken], '没留下半截的副本');

    rmSync(blocked, { recursive: true });
    new Db(old.path, false).close();
    assert.equal(old.version(), String(SCHEMA_VERSION));
    assert.deepEqual(old.dump(old.copy), before);
  });
}

test('a half-written copy from an attempt that died, and an older copy for the same version, give way to the new one', (t) => {
  const old = version4(t);
  const before = old.dump();
  writeFileSync(join(old.dir, PARTIAL), '写到一半的副本');
  writeFileSync(old.copy, '同一版本更早的现场');
  new Db(old.path, false).close();
  assert.equal(old.version(), String(SCHEMA_VERSION));
  assert.deepEqual(old.copies(), [COPY]);
  assert.equal(verifySnapshot(old.copy).get('schema_version'), '4');
  assert.deepEqual(old.dump(old.copy), before);
});

test('a copy that does not verify as the old ledger is no copy: the upgrade does not go ahead on it', (t) => {
  const old = version4(t);
  const conn = new DatabaseSync(old.path);
  conn.exec('DROP TABLE decision');
  conn.close();
  const tables = old.tables();
  assert.throws(() => new Db(old.path, false), /副本.*没留成.*缺少表 decision/);
  assert.equal(old.version(), '4');
  assert.deepEqual(old.tables(), tables);
  assert.deepEqual(old.copies(), [], '校验不过的文件不留在副本的名字下，也不留半截');
});

test('a ledger with nothing to upgrade gets no copy and no line in the log', (t) => {
  const old = version4(t);
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  const fresh = join(old.dir, 'fresh.db');
  // New, then already at this version.
  new Db(fresh, false, {}, { log }).close();
  new Db(fresh, false, {}, { log }).close();
  old.closing(openLedger(fresh, { log }));
  assert.deepEqual(old.copies(), []);
  assert.deepEqual(logs, []);
});

test('a ledger of the previous version opens upgraded, with its Tasks, Runs and settings as they were', (t) => {
  const old = version4(t);
  const before = old.dump();
  const ledger = old.closing(openLedger(old.path));
  assert.equal(old.version(), String(SCHEMA_VERSION));
  assert.ok(old.tables().includes('account') && !old.tables().includes('target'));
  assert.deepEqual(old.dump(), clearedV4(before), '原有内容保留，悬空登录引用按版本 26 清除');
  assertNoOutputDisposition(old.path);
  assert.equal(ledger.getTask('k1').title, '旧任务');
  assert.equal(ledger.getTask('k1').prefer_json, null, '旧任务没有优先名单');
  assert.equal(ledger.getRun('r1').state, 'running');
  assert.equal(ledger.getRun('r1').machine_id, null, '旧目标已经不在时不虚构机器');
  assert.deepEqual(ledger.getTunables(), { 'run.lostGraceMs': 120_000, 'knowledge.externalEntry': true });
  assert.equal(ledger.dispatchConditions().paused, true);
  assert.deepEqual(ledger.listAccounts(), [], '账号从导入来，升级不凭空造');
});

test('an upgraded ledger has the schema a new one has', (t) => {
  const old = version4(t);
  new Db(old.path, false).close();
  const fresh = join(old.dir, 'fresh.db');
  new Db(fresh, false).close();
  const columns = (path: string) => {
    const conn = new DatabaseSync(path);
    try {
      const names = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
      return names.map(({ name }) => [name, conn.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${name}')`).all()]);
    } finally {
      conn.close();
    }
  };
  assert.deepEqual(columns(old.path), columns(fresh));
});

test('a crash before the upgrade commits leaves the old ledger whole, and the next open upgrades it', (t) => {
  const old = version4(t);
  const before = old.dump();
  const tables = old.tables();
  assert.throws(() => new Db(old.path, false, { beforeMigrationCommit() { throw new Crash(); } }), Crash);
  assert.equal(old.version(), '4');
  assert.deepEqual(old.tables(), tables, '没提交的那一步不留表');
  assert.deepEqual(old.dump(), before);
  assert.deepEqual(old.copies(), [COPY], '副本在那一步之前就已经到位');
  assert.equal(verifySnapshot(old.copy).get('schema_version'), '4');
  new Db(old.path, false).close();
  assert.equal(old.version(), String(SCHEMA_VERSION));
  assert.deepEqual(old.dump(), clearedV4(before));
  assertNoOutputDisposition(old.path);
  assert.deepEqual(old.copies(), [COPY]);
  assert.equal(verifySnapshot(old.copy).get('schema_version'), '4');
  assert.deepEqual(old.dump(old.copy), before);
});

test('a crash right after the upgrade commits leaves the new ledger whole, and the next open does not upgrade it again', (t) => {
  const old = version4(t);
  const before = old.dump();
  // After the last step: a crash after an earlier one is the test below, which goes on.
  assert.throws(() => new Db(old.path, false, { afterMigrationCommit(from) { if (from === SCHEMA_VERSION - 1) throw new Crash(); } }), Crash);
  assert.equal(old.version(), String(SCHEMA_VERSION));
  assert.ok(old.tables().includes('account') && !old.tables().includes('target'));
  const copied = readFileSync(old.copy);
  let steps = 0;
  const logs: string[] = [];
  new Db(old.path, false, { beforeMigrationCommit: () => { steps += 1; } }, { log: (line) => logs.push(line) }).close();
  assert.equal(steps, 0, '已经是新版本，不再跑任何一步');
  assert.deepEqual(old.dump(), clearedV4(before));
  assertNoOutputDisposition(old.path);
  assert.equal(verifySnapshot(old.copy).get('schema_version'), '4');
  assert.deepEqual(readFileSync(old.copy), copied, '升级前的副本不被后来的启动重做');
  assert.deepEqual(logs, []);
});

test('steps run one version at a time, and an upgrade interrupted between two goes on from where it stopped', (t) => {
  const old = version4(t);
  const ran: number[] = [];
  const steps = {
    4: (conn: DatabaseSync) => { ran.push(4); conn.exec('CREATE TABLE five (a TEXT)'); },
    5: (conn: DatabaseSync) => { ran.push(5); conn.exec('CREATE TABLE six (a TEXT)'); },
    6: (conn: DatabaseSync) => { ran.push(6); conn.exec('CREATE TABLE seven (a TEXT)'); },
  };
  const conn = old.closing(new DatabaseSync(old.path));
  assert.throws(() => migrate(conn, 4, 7, steps, { afterMigrationCommit(from) { if (from === 5) throw new Crash(); } }), Crash);
  assert.equal(old.version(), '6');
  assert.deepEqual(ran, [4, 5]);
  migrate(conn, Number(old.version()), 7, steps);
  assert.deepEqual(ran, [4, 5, 6], '接着做，不重做');
  assert.equal(old.version(), '7');
  for (const name of ['five', 'six', 'seven']) assert.ok(old.tables().includes(name));
});

test('a step that fails rolls back alone: the versions before it stay', (t) => {
  const old = version4(t);
  const conn = old.closing(new DatabaseSync(old.path));
  const steps = {
    4: (c: DatabaseSync) => c.exec('CREATE TABLE five (a TEXT)'),
    5: (c: DatabaseSync) => { c.exec('CREATE TABLE six (a TEXT)'); throw new Error('这一步坏了'); },
  };
  assert.throws(() => migrate(conn, 4, 6, steps), /这一步坏了/);
  assert.equal(old.version(), '5');
  assert.ok(old.tables().includes('five') && !old.tables().includes('six'));
  assert.throws(() => migrate(conn, 5, 7, { 5: () => {} }), /没有从 schema 版本 6 升级的步骤/);
});

test('a ledger newer than the program is refused and left as it is', (t) => {
  const old = version4(t);
  const conn = new DatabaseSync(old.path);
  conn.exec(`UPDATE setting SET value_json = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
  conn.close();
  const before = old.dump();
  const tables = old.tables();
  assert.throws(() => new Db(old.path, false), /账本比程序新/);
  assert.throws(() => openLedger(old.path), /账本比程序新/);
  assert.equal(old.version(), String(SCHEMA_VERSION + 1));
  assert.deepEqual(old.tables(), tables);
  assert.deepEqual(old.dump(), before);
});

test('a ledger older than any step kept here is refused, and so is a version that is not a number', (t) => {
  for (const stored of ['3', '"four"', '4.5']) {
    const old = version4(t);
    const conn = new DatabaseSync(old.path);
    conn.prepare(`UPDATE setting SET value_json = ? WHERE key = 'schema_version'`).run(stored);
    conn.close();
    const tables = old.tables();
    assert.throws(() => new Db(old.path, false), /schema 版本/, stored);
    assert.deepEqual(old.tables(), tables, stored);
  }
});

test('an open that only reads does not upgrade an older ledger', (t) => {
  const old = version4(t);
  assert.throws(() => new Db(old.path, true), /只读打开不能升级/);
  assert.equal(old.version(), '4');
  assert.ok(!old.tables().includes('target'));
  assert.deepEqual(old.copies(), [], '没有升级，就没有升级前的副本');
});

test('a backup from before the upgrade verifies as it stands and restores into an upgraded ledger', (t) => {
  const old = version4(t);
  const tables = old.tables();
  assert.equal(verifySnapshot(old.path).get('schema_version'), '4');
  assert.deepEqual(old.tables(), tables, '校验不升级它');
  // A data directory that is not there yet: a restore onto a new machine makes it.
  const dataDir = join(old.dir, 'new', 'data');
  const result = restoreBackup(dataDir, old.path);
  assert.equal(result.active_runs, 1);
  // The backup is the copy from before the upgrade; the restore's working file needs none.
  assert.deepEqual(readdirSync(dataDir), ['ledger.db']);
  const ledger = old.closing(openLedger(join(dataDir, 'ledger.db')));
  assert.equal(ledger.getTask('k1').title, '旧任务');
  assert.deepEqual(ledger.listAccounts(), []);
  assert.equal(old.version(), '4', '备份本身不被改写');
  assert.deepEqual(old.copies(), [], '备份旁边也不留');
});

// A data directory as the previous program left it, with nothing in the ledger.
function oldLedgerIn(dataDir: string): void {
  const conn = new DatabaseSync(join(dataDir, 'ledger.db'));
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V4);
  conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s1', ?, 'schema_version', '4')`).run(AT);
  conn.close();
}

test('a service that starts on an older ledger says in its own log where the copy is', { timeout: 60_000 }, async (t) => {
  // Not through the stage's start: that seeds the ledger first, which would upgrade it.
  const { dataDir, remote } = stage(t);
  oldLedgerIn(dataDir);
  const copy = join(dataDir, COPY);
  const lines = t.mock.method(console, 'error', () => {});
  const service = await startService({ dataDir, claude: [process.execPath, FAKE_CLAUDE], port: 0, connect: remote.connect, stopWaitMs: 2000 });
  await service.stop();
  const told = lines.mock.calls.map(({ arguments: [line] }) => String(line)).filter((line) => line.includes(copy));
  assert.equal(told.length, 1);
  // The service's log stamps each line with the time; the ledger's own default does not.
  assert.match(told[0]!, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(verifySnapshot(copy).get('schema_version'), '4');
});

// A ledger of version 5, the one before targets could rest or have a ceiling and before
// a Task could go without a target: its schema as recorded from that program, a target,
// a project that allows it, and a Task of each kind an upgrade must not disturb.
function version5(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate5-'));
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(readFileSync(new URL('./fixtures/ledger/schema-v5.sql', import.meta.url), 'utf8'));
  conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s1', ?, 'schema_version', '5')`).run(AT);
  const target = conn.prepare(
    `INSERT INTO target (id, created_at, updated_at, executor, hosts_json, ssh_config, config_dir, tiers_json, permission_mode, timeout_ms)
     VALUES (?, ?, ?, 'claude', ?, NULL, '/cfg', '{"cheap":"/tiers/cheap.json"}', NULL, 600000)`,
  );
  target.run('t1', AT, AT, '["h1"]');
  target.run('t2', AT, AT, '["h2"]');
  conn.prepare(`INSERT INTO project (id, created_at, name, allowed_targets_json) VALUES ('p1', ?, '试跑', '["t2","t1"]')`).run(AT);
  const task = conn.prepare(
    `INSERT INTO task (id, created_at, project_id, title, goal, acceptance, target_id, tier, state, created_by)
     VALUES (?, ?, 'p1', ?, '目标', '验收', 't1', 'cheap', ?, 'router')`,
  );
  task.run('k1', AT, '在跑的旧任务', 'running');
  task.run('k2', AT, '排队的旧任务', 'queued');
  conn.prepare(
    `INSERT INTO run (id, created_at, task_id, task_revision, target_id, host, state, marker, snapshot_json)
     VALUES ('r1', ?, 'k1', 1, 't1', 'h1', 'running', 'tycho-run:r1', '{"brief":"b"}')`,
  ).run(AT);
  conn.prepare(`INSERT INTO change (id, created_at, at, actor, task_id, run_id, action) VALUES ('c1', ?, ?, 'dispatcher', 'k1', 'r1', 'run.create')`).run(AT, AT);
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const peek = new DatabaseSync(file);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  const rows = (file = path) => Object.fromEntries(['project', 'task', 'run', 'change'].map((table) => [table, legacyRows(read(`SELECT * FROM ${table} ORDER BY rowid`, file))]));
  return { dir, path, read, rows, closing };
}

test('a version 5 ledger upgrades with a copy beside it: targets get no ceiling and no rest, and nothing else moves', (t) => {
  const old = version5(t);
  const before = old.rows();
  const targets = old.read('SELECT * FROM target ORDER BY rowid');
  const logs: string[] = [];
  toV17(old.path, (line) => logs.push(line));
  assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, '17');
  const copy = join(old.dir, 'ledger.before-v6.db');
  assert.equal(verifySnapshot(copy).get('schema_version'), '5', '升级前的副本是版本 5 的账本');
  assert.deepEqual(old.rows(copy), before);
  assert.ok(logs.some((line) => line.includes(copy)));
  // Only the v16 rule moves anything: the queued Task waits for a role.
  const parked = { ...before, task: before.task!.map((row) => (row as { id: string }).id === 'k2' ? { ...row, state: 'waiting_person', reason: NO_ROLE_REASON } : row) };
  assert.deepEqual(old.rows(), parked, '任务、执行、项目、审计一行不动');
  assert.deepEqual(old.read<object>('SELECT * FROM account ORDER BY rowid').map((row) => ({ ...row })), targets.map((row) => {
    const { hosts_json, ssh_config: _sshConfig, tiers_json, ...rest } = row as Record<string, unknown>;
    return { ...rest, tiers_json: JSON.stringify(renameTiers(wrapTiers(JSON.parse(tiers_json as string)))), max_runs: null, machines_json: hosts_json, credential_ref: null };
  }));
  assert.deepEqual(old.read<{ id: string; host: string }>('SELECT id, host FROM machine ORDER BY rowid').map(({ id, host }) => [id, host]), [['h1', 'h1'], ['h2', 'h2']]);
  assert.deepEqual(old.read('SELECT * FROM account_state'), []);
  assert.deepEqual(old.read<{ id: string; max_runs: number | null; timeout_ms: number }>('SELECT id, max_runs, timeout_ms FROM account ORDER BY rowid').map(({ id, max_runs, timeout_ms }) => [id, max_runs, timeout_ms]), [['t1', null, 600_000], ['t2', null, 600_000]]);
  const [r1] = old.read<{ machine_id: string; snapshot_json: string }>(`SELECT machine_id, snapshot_json FROM run WHERE id = 'r1'`);
  assert.equal(r1!.machine_id, 'h1', '没有 target 快照的旧轮次沿用当时目标的连接配置');
  assert.equal(r1!.snapshot_json, '{"brief":"b"}');
  assert.equal(verifySnapshot(old.path).get('schema_version'), '17', '升级后的账本按版本 17 的表清单验证');

  // And on to this version: the two accounts kept no login of their own, so each becomes the
  // login of the one machine it named; what pointed at them points there now.
  const ledger = old.closing(openLedger(old.path, joinedBefore24(old.path)));
  assert.deepEqual(ledger.listAccounts(), []);
  assert.deepEqual(ledger.listMachineLogins().map(({ name, timeoutMs, maxRuns }) => [name, timeoutMs, maxRuns]), [['h1/claude', 600_000, undefined], ['h2/claude', 600_000, undefined]]);
  assert.deepEqual(migrationNames(ledger, ledger.getProject('p1').logins_json), ['h2/claude','h1/claude'], '顺序照旧');
  assert.deepEqual(['k1', 'k2'].map((id) => ledger.getTask(id).login_id), [migrationId(ledger, 'h1/claude'), migrationId(ledger, 'h1/claude')]);
  assert.equal(ledger.getRun('r1').login_id, migrationId(ledger, 'h1/claude'), '还在外面的那一轮算在它现在用的登录上');
  assert.equal(ledger.getRun('r1').snapshot_json, '{"brief":"b"}', '快照不动');
  ledger.close();
  assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
});

// What the owner does after upgrading a ledger this old: its tiers were the names of files on
// the machines, which the upgrade keeps as they were but no Run can be given (only content
// rides a Run), so each is filled in with content before the queue can move.
function filledIn(path: string): void {
  const conn = new DatabaseSync(path);
  try {
    for (const table of ['account', 'machine_login']) {
      for (const row of conn.prepare(`SELECT rowid, executor, tiers_json FROM ${table}`).all() as { rowid: number; executor: string; tiers_json: string }[]) {
        const text = row.executor === 'codex' ? 'model=m\n' : '{"model":"m"}\n';
        const tiers = Object.fromEntries(Object.keys(JSON.parse(row.tiers_json) as object).map((name) => [name, { kind: 'content', text }]));
        conn.prepare(`UPDATE ${table} SET tiers_json = ? WHERE rowid = ?`).run(JSON.stringify(tiers), row.rowid);
      }
    }
  } finally {
    conn.close();
  }
}

test('Tasks of an older ledger all name their target, and after the upgrade they behave as pinned to it', async (t) => {
  const old = version5(t);
  const ledger = old.closing(openLedger(old.path, joinedBefore24(old.path)));
  filledIn(old.path);
  // The target t1 kept no login of its own: it is h1's own login now, and the pin with it.
  assert.deepEqual(['k1', 'k2'].map((id) => ledger.getTask(id).login_id), [migrationId(ledger, 'h1/claude'), migrationId(ledger, 'h1/claude')]);
  const launched: string[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED, reported: (_machine, executor) => signedInEverywhere([executor])().executors[0]!,
    ledger,
    logins: createLogins({ ledger, accounts: { get: (id) => ledger.getAccount(id), list: () => ledger.listAccounts() }, executors: { claude: claudeAdapter } }),
    machines: { get: (id) => ledger.getMachine(id), list: () => ledger.listMachines() },
    executors: { claude: claudeAdapter },
    runner: {
      findMachine: async (_account, machines) => machines[0],
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => { launched.push(run.login_id!); },
      watch: async () => {},
    },
    runTimeoutMs: () => 60_000,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  // Its login rests: the project also allows h2's, and lists it first, but the Task waits.
  ledger.settleRun('r1', 1, null, { kind: 'quota', quota: { message: '额度没了' } });
  pickRoles(ledger);
  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual(launched, [], '旧任务不换登录');
  assert.deepEqual(['k1', 'k2'].map((id) => ledger.getTask(id).state), ['queued', 'queued']);
  ledger.endRest(migrationId(ledger, 'h1/claude'), { actor: 'console' });
  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual(launched, [migrationId(ledger, 'h1/claude'), migrationId(ledger, 'h1/claude')]);
});


// A released v6 ledger, including shared machines, distinct SSH identities and an
// orphan Run. Every row is inserted through the recorded schema, never today's API.
function version6(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate6-'));
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec(readFileSync(new URL('./fixtures/ledger/schema-v6.sql', import.meta.url), 'utf8'));
  conn.prepare("INSERT INTO setting (id, created_at, key, value_json) VALUES ('s1', ?, 'schema_version', '6')").run(AT);
  const target = conn.prepare(
    "INSERT INTO target (id, created_at, updated_at, executor, hosts_json, ssh_config, config_dir, tiers_json, permission_mode, timeout_ms, max_runs) VALUES (?, ?, ?, 'claude', ?, ?, '/cfg', '{\"cheap\":\"/tiers/cheap.json\"}', NULL, 600000, 2)",
  );
  target.run('a', AT, AT, '["h1","shared"]', null);
  target.run('b', AT, AT, '["shared"]', null);
  target.run('c', AT, AT, '["shared"]', '/other/config');
  conn.prepare("INSERT INTO project (id, created_at, name, allowed_targets_json) VALUES ('p', ?, '旧项目', '[\"b\",\"a\",\"c\"]')").run(AT);
  const task = conn.prepare("INSERT INTO task (id, created_at, project_id, title, goal, target_id, tier, state, created_by) VALUES (?, ?, 'p', ?, '旧目标', ?, 'cheap', ?, 'router')");
  task.run('pinned', AT, '点名', 'a', 'queued');
  task.run('automatic', AT, '自动', null, 'queued');
  task.run('running', AT, '在跑', 'c', 'running');
  task.run('orphan', AT, '已删账号', 'deleted', 'running');
  const run = conn.prepare("INSERT INTO run (id, created_at, task_id, task_revision, target_id, host, state, marker, snapshot_json) VALUES (?, ?, ?, 1, ?, 'shared', 'running', ?, ?)");
  run.run('r-c', AT, 'running', 'c', 'tycho-run:r-c', JSON.stringify({ brief: 'unchanged', target: { ssh_config: '/other/config' } }));
  run.run('r-deleted', AT, 'orphan', 'deleted', 'tycho-run:r-deleted', JSON.stringify({ brief: 'orphan', target: { ssh_config: '/gone/config' } }));
  conn.prepare("INSERT INTO target_state (id, created_at, rest_seq, rest_until, rest_streak, rest_reason, usage_json) VALUES ('a', ?, 7, '2099-01-01T00:00:00.000Z', 2, '额度没了', '{\"session\":{\"used\":9,\"resets_at\":null,\"at\":\"2026-11-01T00:00:00.000Z\"}}')").run(AT);
  conn.prepare("INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES ('delete', ?, ?, 'console', 'target.delete', '{\"id\":\"deleted\"}')").run(AT, AT);
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const db = new DatabaseSync(file);
    try { return db.prepare(sql).all().map((row) => ({ ...row })) as T[]; } finally { db.close(); }
  };
  const tables = (file = path) => read<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name", file).map(({ name }) => name);
  const dump = (file = path) => Object.fromEntries(tables(file).map((table) => [table, read('SELECT * FROM '+table+' ORDER BY rowid', file)]));
  const version = () => read<{ value_json: string }>("SELECT value_json FROM setting WHERE key = 'schema_version'")[0]!.value_json;
  return { dir, path, read, tables, dump, version, closing, copy: join(dir, 'ledger.before-v7.db') };
}

test('v6 becomes accounts and shared machines without changing pinned Tasks, rests, audit or old snapshots', (t) => {
  const old = version6(t);
  const before = old.dump();
  toV17(old.path);
  assert.equal(old.version(), '17');
  assert.equal(verifySnapshot(old.copy).get('schema_version'), '6');
  assert.deepEqual(old.dump(old.copy), before, '副本保留 v6 的全部数据');
  assert.ok(!old.tables().includes('target') && !old.tables().includes('target_state'));
  assert.deepEqual(old.read('SELECT id, machines_json, max_runs, config_dir, created_at, updated_at FROM account ORDER BY rowid'), [
    { id: 'a', machines_json: '["h1","shared"]', max_runs: 2, config_dir: '/cfg', created_at: AT, updated_at: AT },
    { id: 'b', machines_json: '["shared"]', max_runs: 2, config_dir: '/cfg', created_at: AT, updated_at: AT },
    { id: 'c', machines_json: '["shared@c"]', max_runs: 2, config_dir: '/cfg', created_at: AT, updated_at: AT },
  ]);
  assert.deepEqual(old.read('SELECT id, host, ssh_config, note FROM machine ORDER BY rowid'), [
    { id: 'h1', host: 'h1', ssh_config: null, note: null },
    { id: 'shared', host: 'shared', ssh_config: null, note: null },
    { id: 'shared@c', host: 'shared', ssh_config: '/other/config', note: null },
  ]);
  assert.deepEqual(old.read('SELECT accounts_json, machines_json FROM project'), [{ accounts_json: '["b","a","c"]', machines_json: '[]' }]);
  assert.deepEqual(old.read('SELECT id, account_id FROM task ORDER BY rowid'), [
    { id: 'pinned', account_id: 'a' }, { id: 'automatic', account_id: null }, { id: 'running', account_id: 'c' }, { id: 'orphan', account_id: 'deleted' },
  ]);
  assert.deepEqual(old.read('SELECT id, account_id, machine_id, host, snapshot_json FROM run ORDER BY rowid'), [
    { id: 'r-c', account_id: 'c', machine_id: 'shared@c', host: 'shared', snapshot_json: JSON.stringify({ brief: 'unchanged', target: { ssh_config: '/other/config' } }) },
    { id: 'r-deleted', account_id: 'deleted', machine_id: null, host: 'shared', snapshot_json: JSON.stringify({ brief: 'orphan', target: { ssh_config: '/gone/config' } }) },
  ]);
  assert.deepEqual(old.read('SELECT * FROM account_state'), (before.target_state as object[]).map(row => ({ ...row, credential_rejected_ref: null, models_json: '[]', models_at: null })));
  assert.deepEqual(old.read('SELECT * FROM change'), before.change, '旧审计不改写');
});

for (const afterCommit of [false, true]) {
  test('v6 migration crash '+(afterCommit ? 'after' : 'before')+' commit leaves a whole schema and resumes', (t) => {
    const old = version6(t);
    const before = old.dump();
    const hooks = afterCommit
      ? { afterMigrationCommit(from: number) { if (from === 6) throw new Crash(); } }
      : { beforeMigrationCommit(from: number) { if (from === 6) throw new Crash(); } };
    assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
    assert.equal(old.version(), afterCommit ? '7' : '6');
    if (!afterCommit) assert.deepEqual(old.dump(), before, '未提交时所有改名、建表、搬数据一起回滚');
    const ran: number[] = [];
    old.closing(new Db(old.path, false, { beforeMigrationCommit(from) { ran.push(from); }, ...joinedBefore24(old.path).testHooks }, { log: () => {} }));
    assert.equal(old.version(), String(SCHEMA_VERSION));
    // Every step from there, once each and in order: how many there are is this program's.
    assert.deepEqual(ran, Array.from({ length: SCHEMA_VERSION - (afterCommit ? 7 : 6) }, (_, n) => (afterCommit ? 7 : 6) + n));
    assert.deepEqual(old.dump(old.copy), before);
    // Version 18 at the end: none of the three kept a login of its own, so each is now its
    // machines' own login — a and b on the same shared machine are one login there.
    assert.equal(old.read('SELECT * FROM account').length, 0);
    assert.deepEqual(old.read<{ machine_id: string; executor: string }>('SELECT machine_id, executor FROM machine_login ORDER BY rowid').map(({ machine_id, executor }) => `${machine_id}/${executor}`), ['h1/claude', 'shared/claude', 'shared@c/claude']);
    assert.equal(old.read('SELECT * FROM machine').length, 3);
  });
}


// A v6 queue as it stands once its accounts are machines' own logins (version 18): none of
// a, b, c kept a login of its own. a named two machines, so its pinned Task is let go and
// says why; a's rest goes with both of its logins, and the shared machine's login is one
// login whoever named it first (a). The project's order becomes the logins' order. So the
// first round goes to c's login, the only one not resting, and its ceiling of two (its own
// round still out there, and this one) keeps the rest waiting.
test('a v6 queue after its accounts become machines\' own logins: the order, the rest and the ceiling go with the logins', async (t) => {
  const old = version6(t);
  const conn = new DatabaseSync(old.path);
  conn.prepare("INSERT INTO task (id, created_at, project_id, title, goal, target_id, tier, state, created_by) VALUES ('second-c', ?, 'p', '再跑一轮', '目标', 'c', 'cheap', 'queued', 'router')").run(AT);
  conn.close();
  const ledger = old.closing(openLedger(old.path, joinedBefore24(old.path)));
  const expected = [['pinned', migrationId(ledger, 'shared@c/claude'), 'shared']];
  filledIn(old.path);
  const launched: string[][] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED, reported: (_machine, executor) => signedInEverywhere([executor])().executors[0]!,
    ledger,
    logins: createLogins({ ledger, accounts: { get: (id) => ledger.getAccount(id), list: () => ledger.listAccounts() }, executors: { claude: claudeAdapter } }),
    machines: { get: (id) => ledger.getMachine(id), list: () => ledger.listMachines() },
    executors: { claude: claudeAdapter },
    runner: {
      findMachine: async (_account, machines) => machines[0],
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => { launched.push([run.task_id, run.login_id!, run.host]); },
      watch: async () => {},
    },
    runTimeoutMs: () => 60_000,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  pickRoles(ledger);
  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual(launched, expected);
  assert.deepEqual(migrationNames(ledger, ledger.getProject('p').logins_json), ['shared/claude','h1/claude','shared@c/claude']);
  assert.deepEqual(['pinned', 'automatic', 'running', 'second-c', 'orphan'].map((id) => ledger.getTask(id).login_id), [null, null, migrationId(ledger, 'shared@c/claude'), migrationId(ledger, 'shared@c/claude'), null], '只列了一台机器的改钉那台；列了多台的不钉；删掉的账号不是这一步的');
  const why = ledger.listChanges({ taskId: 'pinned' }).find(({ action }) => action === 'login.migrate')!;
  assert.match(JSON.parse(why.detail_json!).reason, /原来指定的账号 a 没有自己的登录，用的是 2 台机器各自的登录；现在不再指定/);
  assert.deepEqual(['h1/claude', 'shared/claude'].map((name) => ledger.loginState(migrationId(ledger, name)).rest_until), ['2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'], '歇着跟着登录走');
  assert.deepEqual([ledger.getTask('automatic').state, ledger.getTask('second-c').state], ['queued', 'queued']);
});

test('v6 machine naming preserves a literal host which collides with the generated disambiguation', (t) => {
  const old = version6(t);
  const conn = new DatabaseSync(old.path);
  conn.prepare("UPDATE target SET hosts_json = '[\"shared@c\"]' WHERE id = 'b'").run();
  conn.close();
  toV17(old.path);
  assert.deepEqual(old.read('SELECT id, host, ssh_config FROM machine ORDER BY rowid'), [
    { id: 'h1', host: 'h1', ssh_config: null },
    { id: 'shared', host: 'shared', ssh_config: null },
    { id: 'shared@c', host: 'shared@c', ssh_config: null },
    { id: 'shared@c@2', host: 'shared', ssh_config: '/other/config' },
  ]);
  assert.deepEqual(old.read("SELECT machines_json FROM account WHERE id = 'c'"), [{ machines_json: '["shared@c@2"]' }]);
});

// Guards against a migrated Run whose machine the owner removed waiting forever for
// configuration: the migration leaves machine_id empty whenever the connection identity a
// Run recorded is no longer in the machine table, and reading that as "restored, the
// account is still missing" stalls the Run, its Task and the account's Runs ceiling. Two
// v6 ledgers reach it: the account's hosts no longer include the Run's host, and they do
// but under another SSH configuration.
test('a v6 Run whose machine is gone is judged removed, not left waiting for configuration', async (t) => {
  const old = version6(t);
  const conn = new DatabaseSync(old.path);
  // Target a now lists only h2: nothing in the ledger keeps h1 under any configuration.
  conn.prepare("UPDATE target SET hosts_json = '[\"h2\"]' WHERE id = 'a'").run();
  conn.prepare(
    "INSERT INTO task (id, created_at, project_id, title, goal, target_id, tier, state, created_by) VALUES ('gone', ?, 'p', '旧机器没了', '目标', 'a', 'cheap', 'running', 'router')",
  ).run(AT);
  conn.prepare(
    "INSERT INTO run (id, created_at, task_id, task_revision, target_id, host, state, marker, snapshot_json) VALUES ('r-gone', ?, 'gone', 1, 'a', 'h1', 'running', 'tycho-run:r-gone', ?)",
  ).run(AT, JSON.stringify({ brief: 'b', target: { ssh_config: null } }));
  // Target c keeps its host but with another SSH configuration.
  conn.prepare("UPDATE target SET ssh_config = '/new/config' WHERE id = 'c'").run();
  conn.prepare(
    "INSERT INTO task (id, created_at, project_id, title, goal, target_id, tier, state, created_by) VALUES ('moved', ?, 'p', '换了 SSH 配置', '目标', 'c', 'cheap', 'running', 'router')",
  ).run(AT);
  conn.prepare(
    "INSERT INTO run (id, created_at, task_id, task_revision, target_id, host, state, marker, snapshot_json) VALUES ('r-moved', ?, 'moved', 1, 'c', 'shared', 'running', 'tycho-run:r-moved', ?)",
  ).run(AT, JSON.stringify({ brief: 'b', target: { ssh_config: '/old/config' } }));
  conn.close();

  const ledger = old.closing(openLedger(old.path, joinedBefore24(old.path)));
  // The migration itself: the identity each Run recorded is not in the machine table.
  assert.deepEqual(old.read('SELECT id, machine_id, host FROM run ORDER BY rowid').slice(-2), [
    { id: 'r-gone', machine_id: null, host: 'h1' },
    { id: 'r-moved', machine_id: null, host: 'shared' },
  ]);
  assert.deepEqual(old.read('SELECT id, host FROM machine ORDER BY rowid'), [
    { id: 'h2', host: 'h2' },
    { id: 'shared', host: 'shared' },
    { id: 'shared@c', host: 'shared' },
  ]);

  const remote = fakeRemote();
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger,
    adapters: { claude: claudeAdapter },
    logins: createLogins({ ledger, accounts: { get: ledger.getAccount, list: ledger.listAccounts }, executors: { claude: claudeAdapter } }),
    machines: { get: ledger.getMachine, list: ledger.listMachines },
    connect: remote.connect,
    log: () => {},
  });
  for (const [id, host] of [['r-gone', 'h1'], ['r-moved', 'shared']] as const) {
    assert.equal(await runner.verify(ledger.getRun(id)), 'lost', id);
    const run = ledger.getRun(id);
    assert.equal(run.host, host, id);
    assert.equal(run.state, 'ended', id);
    assert.equal(run.exit_kind, 'lost', id);
    assert.equal(JSON.parse(run.error_json!).lost.basis, 'removed', id);
    assert.equal(loginMissing(run), false, `${id}：账号还在，判的是机器被移除，不是缺配置`);
  }
  assert.deepEqual(remote.calls, [], '机器被移除是不看就能下的判定');
  // They go on as any lost Run's Task does, and, having no role, wait for one instead of the queue.
  assert.deepEqual(['gone', 'moved'].map((id) => [ledger.getTask(id).state, ledger.getTask(id).reason]), [['waiting_person', NO_ROLE_REASON], ['waiting_person', NO_ROLE_REASON]], '任务自动接续，没职能就停在等你决定');
});
// v8 must preserve old behavior and commit the two credential columns with its version.
for (const point of ['none', 'before', 'after'] as const) {
  test('v7 credential migration '+point+' commit keeps all old accounts usable', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate7-'));
    const path = join(dir, 'ledger.db');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const old = new DatabaseSync(path);
    old.exec(readFileSync(new URL('./fixtures/ledger/schema-v7.sql', import.meta.url), 'utf8'));
    old.exec("INSERT INTO setting VALUES ('version', '2026-11-01', 'schema_version', '7'); INSERT INTO account (id,created_at,updated_at,executor,tiers_json) VALUES ('a','2026-11-01','2026-11-01','claude','{}'); INSERT INTO account_state(id,created_at,rest_streak) VALUES ('a','2026-11-01',2)");
    old.close();
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(path, false, hooks, { log: () => {} }), Crash);
      const check = new DatabaseSync(path);
      try {
        assert.equal(check.prepare("SELECT value_json FROM setting WHERE key='schema_version'").get()!.value_json, point === 'before' ? '7' : '8');
        const state = check.prepare("SELECT name FROM pragma_table_info('account_state')").all();
        assert.equal(state.some(row => row.name === 'credential_rejected_ref'), point === 'after');
        const account = check.prepare("SELECT name FROM pragma_table_info('account')").all();
        assert.equal(account.some(row => row.name === 'credential_ref'), point === 'after');
      } finally { check.close(); }
    }
    const ledger = atV17(path);
    try {
      assert.equal(ledger.loginState('a').credential_rejected_ref, null);
      assert.equal(ledger.accountCredentialRef('a'), null, '没有令牌：那时它用的是机器自己的登录（到第 18 版才并到机器上）');
      assert.equal(ledger.loginState('a').rest_streak, 2);
      assert.equal(ledger.getAccount('a')!.executor, 'claude');
      assert.equal(ledger.loginState('a').rest_until, null);
    } finally { ledger.close(); }
  });
}

// v9 must keep every old tier string exactly as it was, in the account and in the account
// a Run's snapshot recorded: a Run in flight is compared against the account as the ledger
// holds it now, so a record left in the old shape could never start again. The snapshot's
// `tier_file` becomes the value the round would send.
for (const point of ['none', 'before', 'after'] as const) {
  test('v8 tier migration '+point+' commit keeps every old tier as the same ref', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate8-'));
    const path = join(dir, 'ledger.db');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const tiers = '{"cheap":"/tiers/cheap.json","强 档":"/带 空格/strong.json"}';
    const snapshot = JSON.stringify({
      brief: 'b', executor: 'claude', tier: 'cheap', tier_file: '/tiers/cheap.json',
      account: { executor: 'claude', machines: ['h1'], config_dir: null, tiers: JSON.parse(tiers), permission_mode: null, timeout_ms: null, max_runs: null },
      machine: { host: 'h1', ssh_config: null, note: null },
    });
    const old = new DatabaseSync(path);
    old.exec(readFileSync(new URL('./fixtures/ledger/schema-v8.sql', import.meta.url), 'utf8'));
    old.prepare("INSERT INTO setting VALUES ('version', ?, 'schema_version', '8')").run(AT);
    old.prepare("INSERT INTO project (id,created_at,name) VALUES ('p1',?,'试跑')").run(AT);
    old.prepare("INSERT INTO task (id,created_at,project_id,title,goal,state,created_by) VALUES ('k1',?,'p1','旧任务','目标','running','router')").run(AT);
    old.prepare("INSERT INTO account (id,created_at,updated_at,executor,tiers_json,machines_json) VALUES ('a',?,?,'claude',?,'[\"h1\"]')").run(AT, AT, tiers);
    old.prepare("INSERT INTO run (id,created_at,task_id,task_revision,account_id,host,state,marker,snapshot_json) VALUES ('r1',?,'k1',1,'a','h1','launching','tycho-run:r1',?)").run(AT, snapshot);
    old.close();
    const wrapped = { cheap: { kind: 'ref', value: '/tiers/cheap.json' }, '强 档': { kind: 'ref', value: '/带 空格/strong.json' } };
    // What this program holds after its own step has renamed the two names it knows.
    const renamed = { execute: { kind: 'ref', value: '/tiers/cheap.json' }, '强 档': { kind: 'ref', value: '/带 空格/strong.json' } };
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(path, false, hooks, { log: () => {} }), Crash);
      const check = new DatabaseSync(path);
      try {
        assert.equal(check.prepare("SELECT value_json FROM setting WHERE key='schema_version'").get()!.value_json, point === 'before' ? '8' : '9');
        const stored = check.prepare("SELECT tiers_json FROM account WHERE id='a'").get()!.tiers_json as string;
        assert.deepEqual(JSON.parse(stored), point === 'before' ? JSON.parse(tiers) : wrapped, '提交之前原样，提交之后只有这一处改写');
      } finally { check.close(); }
    }
    const ledger = atV17(path);
    try {
      const account = ledger.getAccount('a')!;
      assert.deepEqual({ ...account.tiers }, renamed, '旧字符串一个字节不变，只是包成了 ref，两个旧名字换成新的');
      const recorded = JSON.parse(ledger.getRun('r1')!.snapshot_json) as Snapshot;
      assert.deepEqual(recorded.tier_value, { kind: 'ref', value: '/tiers/cheap.json' });
      assert.equal('tier_file' in recorded, false, '旧字段让位给记下来的值本身');
      // The snapshot's own copy of the account is left as that round recorded it: a round
      // dispatched under a name this program has renamed no longer compares equal, so it is
      // judged not started and the Task goes on in a new round rather than running on it.
      const old = (recorded as { account?: { tiers: unknown } }).account;
      assert.deepEqual(old!.tiers, wrapped, '那一轮记下的账号是它当时的账号');
      assert.equal(recorded.login, undefined, '旧快照原样留着，不补记登录');
      assert.notDeepEqual(old!.tiers, account.tiers, '这一轮不再按旧的账号配置启动');
    } finally { ledger.close(); }
  });
}

// A real version 9 ledger, as that program left it: the recorded schema of that version,
// its settings row, and accounts and a Session the Router's own binding must not touch.
// v10 is the step that turns the Router's two settings into an account, and it is the step
// a version 9 ledger could not be brought past at all while it was missing.
function version9(t: TestContext, tunables: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate9-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V9);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('s-version', AT, 'schema_version', '9');
  if (tunables !== undefined) setting.run('s-tunables', AT, 'tunables', tunables);
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json)
    VALUES ('a', ?, ?, 'claude', '[]', '/cfg', '{"cheap":{"kind":"ref","value":"/tiers/cheap.json"}}')`).run(AT, AT);
  conn.prepare(`INSERT INTO account_state (id, created_at, rest_streak) VALUES ('a', ?, 2)`).run(AT);
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const peek = new DatabaseSync(file);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  return { dir, path, read, closing };
}

// Both ways a version 9 ledger can hold the Router's settings: filled in, and never
// touched. Neither may fail to come forward, and a crash on either side of the step's
// commit must leave a ledger that is one version or the other, never half of both.
for (const point of ['none', 'before', 'after'] as const) {
  test('v9 Router settings migration ' + point + ' commit leaves one version or the other', (t) => {
    const old = version9(t, '{"router.configDir":"/home/router","router.tierFile":"/tiers/router.json","run.timeoutMs":1000}');
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, point === 'before' ? '9' : '10');
      const moved = old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'tunables'`)[0]!.value_json.includes('router.configDir');
      assert.equal(moved, point === 'before', '提交之前账本一个字节没动');
      assert.equal(old.read<{ n: number }>(`SELECT count(*) AS n FROM account WHERE id = 'router'`)[0]!.n, point === 'after' ? 1 : 0);
    }
    const ledger = old.closing(atV17(old.path));
    assert.equal(ledger.getTunables()['run.timeoutMs'], 1000, '别的设置照旧');
    assert.deepEqual(ledger.getTunables()['router.account'], 'router');
    assert.deepEqual(
      [ledger.getAccount('router')!.executor, ledger.getAccount('router')!.configDir, { ...ledger.getAccount('router')!.tiers }],
      ['claude', '/home/router', { default: { kind: 'ref', value: '/tiers/router.json' } }],
      '旧的登录目录和档位文件都进了那个账号，档位按现在的形状记',
    );
    assert.deepEqual(['a'].map((id) => ledger.getAccount(id)!.configDir), ['/cfg'], '原有账号不动');
    assert.deepEqual(['a'].map((id) => ({ ...ledger.getAccount(id)!.tiers })), [{ execute: { kind: 'ref', value: '/tiers/cheap.json' } }], '档位值已经是 9 的形状，不再包一层；名字换成这一版用的');
    // The name v10 gives the Router's own tier file is not one this program uses: it is
    // left standing, and the Router says why it will not start until the owner picks one of
    // the two (docs/design/roles-and-tiers.md §8).
    assert.equal(ledger.getTunables()['router.tier'], 'default', '猜不出来的名字原样留着');
    assert.equal(ledger.loginState('a').rest_streak, 2, '学到的状态不动');
    // Closed, so that the file stands alone: what a copy of it is checked against.
    ledger.close();
    assert.equal(verifySnapshot(old.path).get('schema_version'), '17');
  });
}

// The two shapes of "nothing was ever set": no tunables row at all, and one whose two
// Router settings were left empty. Neither leaves an account or a binding behind.
for (const [what, tunables] of [['no tunables row', undefined], ['empty settings', '{"router.configDir":"","router.tierFile":""}']] as const) {
  test('a v9 ledger with ' + what + ' upgrades to an empty binding', (t) => {
    const old = version9(t, tunables);
    const ledger = old.closing(atV17(old.path));
    assert.equal(ledger.getAccount('router'), undefined, '没有旧设置就不造账号');
    assert.deepEqual(ledger.getTunables(), {}, '也没有可指的绑定');
    assert.deepEqual(ownChanges(old.read('SELECT * FROM change')), [], '升级不写 change');
  });
}

// A real version 10 ledger, as that program left it: the recorded schema, its version row,
// an account and what using it had taught the service. v11 adds the columns the model list
// is kept in and must touch nothing else.
function version10(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate10-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V10);
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)').run('s-version', AT, 'schema_version', '10');
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)').run('s-tunables', AT, 'tunables', '{"run.timeoutMs":1000}');
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json, credential_ref)
    VALUES ('a', ?, ?, 'claude', '[]', '/cfg', '{"cheap":{"kind":"ref","value":"/tiers/cheap.json"}}', 'ref-1')`).run(AT, AT);
  conn.prepare(`INSERT INTO account_state (id, created_at, rest_seq, rest_until, rest_streak, rest_reason, usage_json, credential_rejected_ref)
    VALUES ('a', ?, 7, '2026-11-01T06:00:00.000Z', 2, '额度用完', '{"five_hour":{"used":0.5,"resets_at":null,"at":"2026-11-01T05:00:00.000Z"}}', 'ref-1')`).run(AT);
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const peek = new DatabaseSync(file);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  return { path, read, closing };
}

// The columns v11 adds start out as "nothing read yet" — which is what every account of an
// older ledger is — and a crash on either side of the step's commit leaves one version or
// the other, never a ledger of one version with the other's columns.
for (const point of ['none', 'before', 'after'] as const) {
  test('v10 model-list migration ' + point + ' commit leaves one version or the other', (t) => {
    const old = version10(t);
    const columns = (): string[] => old.read<{ name: string }>(`SELECT name FROM pragma_table_info('account_state')`).map(({ name }) => name);
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, point === 'before' ? '10' : '11');
      assert.equal(columns().includes('models_json'), point === 'after');
    }
    const ledger = old.closing(openLedger(old.path, { log: () => {} }));
    const state = ledger.loginState(migrationId(ledger, 'a'));
    assert.deepEqual([state.models, state.models_at], [[], null], '还没读过就是空的，不是编出来的列表');
    assert.deepEqual(
      [state.rest_until, state.rest_streak, state.rest_reason, state.credential_rejected_ref, state.usage.map(({ window }) => window)],
      ['2026-11-01T06:00:00.000Z', 2, '额度用完', 'ref-1', ['five_hour']],
      '学到的别的状态一个字段不动',
    );
    assert.deepEqual(ledger.getTunables(), { 'run.timeoutMs': 1000, 'knowledge.externalEntry': true });
    ledger.close();
    // The configuration directory it named is gone at version 32, and the audit keeps it.
    assert.ok(old.read<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'account.update'`).some(({ detail_json }) => JSON.parse(detail_json).config_dir_removed === '/cfg'));
    assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
  });
}

// What was read is written beside the rest of the learned state, and a second read of the
// same list moves the time; an account the ledger does not hold is not given a row.
test('a model list is learned state: written beside the rest, replaced by the next read', (t) => {
  const old = version10(t);
  const ledger = old.closing(openLedger(old.path, { log: () => {} }));
  const models = [{ id: '<模型>', name: '<模型>', efforts: ['low', 'high'], defaultEffort: 'low', hidden: true }];
  ledger.noteModels(migrationId(ledger, 'a'), models, '2026-11-06T00:00:00.000Z');
  assert.deepEqual(ledger.loginState(migrationId(ledger, 'a')).models, models);
  assert.equal(ledger.loginState(migrationId(ledger, 'a')).models_at, '2026-11-06T00:00:00.000Z');
  assert.deepEqual(ownChanges(old.read('SELECT * FROM change')), [], '读到的东西不是主人做的事，不写 change');
  ledger.noteModels('gone', models, '2026-11-06T00:00:00.000Z');
  assert.equal(old.read<{ n: number }>(`SELECT count(*) AS n FROM login_state WHERE id = 'gone'`)[0]!.n, 0, '没有这个登录就不记');
  ledger.noteModels(migrationId(ledger, 'a'), [{ id: '<模型乙>' }], '2026-11-06T06:00:00.000Z');
  assert.deepEqual(ledger.loginState(migrationId(ledger, 'a')).models, [{ id: '<模型乙>' }], '后一次读到的是列表本身，不是加在上面的');
  assert.equal(ledger.loginState(migrationId(ledger, 'a')).models_at, '2026-11-06T06:00:00.000Z');
  ledger.close();
});

// A real version 11 ledger, as that program left it: the recorded schema, its version row,
// a project with tasks of its own, a machine reached over SSH and an account that names it.
// v12 adds the column naming a checkout on this machine, and every project there was has
// none: an empty value is what "no code directory" means, not something the upgrade may
// invent. v13 adds the fields a machine that comes back by itself is known by, and a
// machine from before it has none: it is still one reached over SSH.
function version11(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate11-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V11);
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)').run('s-version', AT, 'schema_version', '11');
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)').run('s-tunables', AT, 'tunables', '{"run.timeoutMs":1000}');
  conn.prepare(`INSERT INTO machine (id, created_at, updated_at, host, ssh_config, note)
    VALUES ('h1', ?, ?, 'h1.example', '/home/u/.ssh/config', '集群实例')`).run(AT, AT);
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json, permission_mode, timeout_ms, max_runs, credential_ref)
    VALUES ('a', ?, ?, 'claude', '["h1"]', '/cfg', '{"cheap":{"kind":"ref","value":"/tiers/cheap.json"}}', 'acceptEdits', 900000, 3, 'ref-1')`).run(AT, AT);
  conn.prepare(`INSERT INTO account_state (id, created_at, rest_streak, usage_json, models_json, models_at)
    VALUES ('a', ?, 2, '{}', '[{"id":"<模型>"}]', '2026-11-06T00:00:00.000Z')`).run(AT);
  conn.prepare(`INSERT INTO project (id, created_at, name, repo, accounts_json, machines_json)
    VALUES ('p1', ?, '试跑', 'https://example.test/tycho.git', '["a"]', '["h1"]')`).run(AT);
  conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, account_id, tier, state, created_by)
    VALUES ('k1', ?, 'p1', '旧任务', '目标', '验收', 'a', 'cheap', 'queued', 'router')`).run(AT);
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const peek = new DatabaseSync(file);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  return { path, read, closing };
}

// The columns the two steps add start out empty — v12's is the code directory no project
// had, v13's are the identity a machine that came back by itself is known by — and a crash
// on either side of a step's commit leaves one version or the other, never a ledger of one
// version with the other's columns.
for (const point of ['none', 'before', 'after'] as const) {
  test('v11 migration ' + point + ' commit leaves one version or the other', (t) => {
    const old = version11(t);
    const projectColumns = (): string[] => old.read<{ name: string }>(`SELECT name FROM pragma_table_info('project')`).map(({ name }) => name);
    const machineColumns = (): string[] => old.read<{ name: string }>(`SELECT name FROM pragma_table_info('machine')`).map(({ name }) => name);
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, point === 'before' ? '11' : '12');
      // The step to 12 is the first one; what the step to 13 adds is not there yet.
      assert.equal(projectColumns().includes('code_dir'), point === 'after');
      assert.equal(machineColumns().includes('node_id'), false);
    }
    const ledger = old.closing(openLedger(old.path, joinedBefore24(old.path)));
    const project = ledger.getProject('p1');
    assert.deepEqual(
      ledger.projectSources('p1').map((source) => (source.kind === 'repo' ? ['repo', source.url] : ['folder', source.machine_uid, source.path])),
      [['repo', 'https://example.test/tycho.git']],
      '旧项目只有 repo 列，迁移成一个仓库来源',
    );
    assert.deepEqual(
      [project.name, JSON.stringify(migrationNames(ledger, project.logins_json)), ledger.projectMachines('p1').machines.map(({ name }) => name)],
      ['试跑', '["a"]', ['h1']],
      '项目的别的字段一个不动',
    );
    assert.equal(ledger.getTask('k1').title, '旧任务');
    assert.deepEqual(ledger.getTunables(), { 'run.timeoutMs': 1000, 'knowledge.externalEntry': true });
    assert.deepEqual(ownChanges(old.read('SELECT * FROM change')), [], '升级不写 change');
    // Written the way the console writes it now, on a ledger that came from before the column:
    // an existing item keeps its id, and what is not in the list is not accepted.
    const [kept] = ledger.projectSources('p1');
    ledger.setProjectSources('p1', [{ id: kept!.id, kind: 'repo', url: 'https://example.test/other.git' }], { actor: 'console' });
    assert.deepEqual(ledger.projectSources('p1'), [{ id: kept!.id, kind: 'repo', url: 'https://example.test/other.git' }]);

    // The machine as it was, joined by the test before the step to 24 (joinedBefore24).
    const machine = ledger.getMachine('h1')!;
    assert.deepEqual([machine.host, machine.note], ['h1.example', '集群实例']);
    // Every other column the version held is where it was.
    assert.equal(ledger.getAccount(migrationId(ledger, 'a'))!.permissionMode, 'acceptEdits');
    assert.equal(ledger.getAccount(migrationId(ledger, 'a'))!.maxRuns, 3);
    assert.deepEqual(ledger.loginState(migrationId(ledger, 'a')).models, [{ id: '<模型>' }]);
    assert.equal(ledger.machineByNodeToken('ff'), undefined, '还没有任何机器有令牌');
    ledger.close();
    assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
  });
}

// The three unique constraints the old program's own schema carries are what keeps one
// active Run, one open question and one open Router session per Task. A migrated ledger
// missing them would look right and let a second one in.
test('v11 的三个唯一约束过了迁移还在，而且真的挡得住', (t) => {
  const old = version11(t);
  const ledger = old.closing(openLedger(old.path, { log: () => {} }));
  ledger.close();
  const conn = new DatabaseSync(old.path);
  try {
    const indexes = conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[];
    // v20 replaced the one global Router session with one open executor context per project.
    for (const name of ['run_one_active', 'approval_one_open', 'router_context_one_open']) {
      assert.ok(indexes.some((each) => each.name === name), `迁移后少了索引 ${name}`);
    }
    const run = (id: string, state: string): void => {
      conn.prepare(
        `INSERT INTO run (id, created_at, task_id, task_revision, login_id, host, state, marker, snapshot_json)
         VALUES (?, ?, 'k1', 1, 'a', 'h1', ?, 'm', '{}')`,
      ).run(id, AT, state);
    };
    run('r1', 'running');
    assert.throws(() => run('r2', 'running'), /UNIQUE/, '一个任务同时只能有一个没结束的 Run');
    run('r2', 'ended'); // 已经结束的那一行不占位
    conn.prepare(`UPDATE run SET state = 'ended' WHERE id = 'r1'`).run();
    run('r3', 'launching'); // 前一个结束了，下一个就进得来

    const approval = (id: string, state: string): void => {
      conn.prepare(`INSERT INTO approval (id, created_at, task_id, task_revision, questions_json, state) VALUES (?, ?, 'k1', 1, '[]', ?)`).run(id, AT, state);
    };
    approval('q1', 'open');
    assert.throws(() => approval('q2', 'open'), /UNIQUE/, '一个任务同时只能有一个没答完的问题');
    approval('q2', 'answered');

    const context = (id: string, state: string): void => {
      conn.prepare(`INSERT INTO router_context (id, created_at, project_id, marker, state) VALUES (?, ?, 'p1', 'm', ?)`).run(id, AT, state);
    };
    context('s1', 'open');
    assert.throws(() => context('s2', 'open'), /UNIQUE/, '一个项目同时只能有一个开着的负责人上下文');
    context('s2', 'closed');
  } finally {
    conn.close();
  }
});

// What a machine that came back by itself is: the client's own identity, the token's hash,
// the moment it joined, what derived it. Read back through the ledger's own view, and never
// the token itself.
test('v13 keeps a joined machine: identity, token hash, platform, source', (t) => {
  const old = version11(t);
  const ledger = old.closing(openLedger(old.path, { log: () => {} }));
  const joined = ledger.joinMachine(
    { id: 'mac-mini-01', host: 'mac-mini-01.local', nodeId: 'a1b2c3d4e5f60718', tokenHash: 'hash-of-the-token', platform: 'darwin 24', source: null, ephemeral: false },
    { actor: 'console' },
  );
  assert.equal(joined.id, 'mac-mini-01');
  assert.equal(joined.nodeId, 'a1b2c3d4e5f60718');
  assert.equal(joined.platform, 'darwin 24');
  assert.ok(joined.joinedAt);
  assert.equal(ledger.machineByNodeToken('hash-of-the-token')?.id, 'mac-mini-01');
  assert.equal(ledger.machineByNodeId('a1b2c3d4e5f60718')?.id, 'mac-mini-01');
  // What the pages read holds the identity and not the hash or the token.
  assert.equal(JSON.stringify(ledger.listMachines()).includes('hash-of-the-token'), false);
  ledger.noteMachineSeen('mac-mini-01', '2026-11-06T10:00:00.000Z');
  assert.equal(ledger.getMachine('mac-mini-01')!.lastSeenAt, '2026-11-06T10:00:00.000Z');
  // One identity, one machine: the same client cannot be let in twice.
  assert.throws(() => ledger.joinMachine(
    { id: 'other', host: 'other', nodeId: 'a1b2c3d4e5f60718', tokenHash: 'another', platform: 'x', source: null, ephemeral: false },
    { actor: 'console' },
  ));
  ledger.close();
});

// A real version 12 ledger, as that program left it: the recorded schema, its version row, a
// project that names a checkout on this machine, a machine reached over SSH and a Run that
// was dispatched to it. v13 adds the fields a machine that came back by itself is known by
// and the node identity a Run is bound to, and must touch nothing else.
function version12(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate12-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(readFileSync(new URL('./fixtures/ledger/schema-v12.sql', import.meta.url), 'utf8'));
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)').run('s-version', AT, 'schema_version', '12');
  conn.prepare(`INSERT INTO machine (id, created_at, updated_at, host, ssh_config, note)
    VALUES ('h1', ?, ?, 'h1.example', '/home/u/.ssh/config', '集群实例')`).run(AT, AT);
  conn.prepare(`INSERT INTO project (id, created_at, name, repo, code_dir, accounts_json, machines_json)
    VALUES ('p1', ?, '试跑', 'https://example.test/tycho.git', '/host/tycho', '["t1"]', '["h1"]')`).run(AT);
  conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, state, created_by)
    VALUES ('k1', ?, 'p1', '旧任务', '目标', 'running', 'router')`).run(AT);
  conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, account_id, host, machine_id, state, marker, snapshot_json)
    VALUES ('r1', ?, 'k1', 1, 't1', 'h1.example', 'h1', 'running', 'tycho-run:r1', '{"brief":"b"}')`).run(AT);
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const peek = new DatabaseSync(file);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  return { path, read, closing };
}

// The columns v13 adds start out empty — which is what every machine and every Run of an
// older ledger is, one reached over SSH and one whose machine was only named — and a crash
// on either side of the step's commit leaves one version or the other, never a ledger of one
// version with the other's columns.
for (const point of ['none', 'before', 'after'] as const) {
  test('v12 node-identity migration ' + point + ' commit leaves one version or the other', (t) => {
    const old = version12(t);
    const columns = (table: string): string[] => old.read<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map(({ name }) => name);
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, point === 'before' ? '12' : '13');
      assert.equal(columns('run').includes('node_id'), point === 'after');
      assert.equal(columns('machine').includes('node_id'), point === 'after');
      assert.equal(columns('machine').includes('token_hash'), point === 'after');
    }
    const ledger = old.closing(openLedger(old.path, { log: () => {} }));
    const run = ledger.getRun('r1');
    assert.equal(run.node_id, null, '旧轮次没有绑节点身份：它那时的机器只有一个名字');
    assert.equal(run.machine_id, 'h1');
    assert.equal(run.snapshot_json, '{"brief":"b"}', '这一轮的输入快照一字不动');
    // It never joined: version 24 removes a machine whose client never came back.
    assert.equal(ledger.getMachine('h1'), undefined, '没经客户端接入的机器在版本 24 移除');
    // The old code directory becomes a folder source on the host's machine; no local registration
    // can be recovered here, so the project page still has to ask the owner which machine it is.
    assert.deepEqual(
      ledger.projectSources('p1').map((source) => (source.kind === 'folder' ? ['folder', source.machine_uid, source.path] : ['repo', source.url])),
      [['folder', '', '/host/tycho']],
      '上一版记的代码目录原样还在，机器等主人选',
    );
    ledger.close();
    assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
  });
}

// What a Run on a machine that came back by itself records: the client's own identity, which
// a name deleted and taken again cannot inherit (docs/design/nodes.md §7, §9).
test('v13 binds a Run to the node identity of the machine it was dispatched to', (t) => {
  const old = version12(t);
  // Right after the step to 13, before any later step touches the data: the Run from before
  // was dispatched by a version that knew the machine by name only, and the step gave it none.
  class StopAt13 extends Error {}
  assert.throws(() => new Db(old.path, false, { beforeMigrationCommit(from) { if (from === 13) throw new StopAt13(); } }, { log: () => {} }), StopAt13);
  assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, '13');
  assert.equal(old.read<{ node_id: string | null }>(`SELECT node_id FROM run WHERE id = 'r1'`)[0]!.node_id, null);
  const ledger = old.closing(openLedger(old.path, joinedBefore24(old.path)));
  // The machine joined after the upgrade: the identity's columns are what it arrives in.
  const joined = ledger.joinMachine(
    { id: 'mac-mini-01', host: 'mac-mini-01.local', nodeId: 'a1b2c3d4e5f60718', tokenHash: 'hash-of-the-token', platform: 'darwin 24', source: null, ephemeral: false },
    { actor: 'console' },
  );
  ledger.setProjectMachines('p1', uidsOf(ledger, ['h1', joined.id]), { actor: 'test' });
  const account = { id: 't1', name: 't1', executor: 'claude' as const, tiers: {} };
  ledger.putAccount(account, { actor: 'test' }, 'ref-t1');
  ledger.setProjectLogins('p1', [account.id], { actor: 'test' });
  const task = ledger.createTask({ roleId: 'implement', projectId: 'p1', title: '新任务', goal: '目标', acceptance: '验收' }, { actor: 'test' });
  ledger.queueTask(task.id, { actor: 'test' });
  // The migration left the project's folder source waiting for a machine (§8.8), and the Task it
  // pinned carries the same gap: naming the machine in the project page confirms both, in the same
  // transaction, and a round may then be made.
  const pending = ledger.projectSources('p1')[0]!;
  const machine = ledger.getMachine('mac-mini-01')!;
  const confirmed = pending.kind === 'folder' ? { ...pending, machine_uid: machine.uid } : pending;
  ledger.setProjectSources('p1', [confirmed], { actor: 'test' });
  const created = ledger.createRun(task.id, {
    login: account,
    machine,
    snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', source: snapshotSourceOf(confirmed) },
    expectedRevision: ledger.getTask(task.id).revision,
  }, { actor: 'test' });
  assert.equal(created.node_id, 'a1b2c3d4e5f60718', '这一轮绑的是客户端自己的标识');
  assert.equal(ledger.getRun(created.id)!.machine_id, 'mac-mini-01');
  // And none was made up for it on the way: nothing knows which client ran it.
  assert.equal(ledger.getRun('r1').node_id, null);
  ledger.close();
});

// A real version 13 ledger, as that program left it (the recorded schema): a project, a
// machine that came back by itself and was let in by hand, and one reached over SSH.
function version13(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate13-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(readFileSync(new URL('./fixtures/ledger/schema-v13.sql', import.meta.url), 'utf8'));
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)').run('s-version', AT, 'schema_version', '13');
  conn.prepare(`INSERT INTO machine (id, created_at, updated_at, host, ssh_config, note)
    VALUES ('h1', ?, ?, 'h1.example', '/home/u/.ssh/config', '集群实例')`).run(AT, AT);
  conn.prepare(`INSERT INTO machine (id, created_at, updated_at, host, node_id, token_hash, platform, joined_at, last_seen_at, source, ephemeral)
    VALUES ('mac-mini-01', ?, ?, 'mac-mini-01.local', 'a1b2c3d4e5f60718', 'hash-of-the-token', 'darwin 24', ?, ?, '', 0)`).run(AT, AT, AT, AT);
  conn.prepare(`INSERT INTO project (id, created_at, name, repo, code_dir, accounts_json, machines_json)
    VALUES ('p1', ?, '试跑', 'https://example.test/tycho.git', '/host/tycho', '[]', '["h1","mac-mini-01"]')`).run(AT);
  conn.close();
  const read = <T>(sql: string): T[] => {
    const peek = new DatabaseSync(path);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  return { path, read, closing };
}

for (const point of ['none', 'before', 'after'] as const) {
  test('v14 migration ' + point + ' commit: no project may spawn, every machine is one let in by hand', (t) => {
    const old = version13(t);
    const tables = (): string[] => old.read<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map(({ name }) => name);
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, point === 'before' ? '13' : '14');
      assert.equal(tables().includes('machine_invite'), point === 'after', '名额表跟着版本号一起有或一起没有');
      assert.equal(tables().includes('machine_material'), point === 'after');
    }
    const ledger = old.closing(openLedger(old.path, { log: () => {} }));
    assert.equal(ledger.getProject('p1').spawn_machines, 0, '旧项目的“允许派生机器”是关着的');
    const joined = ledger.getMachine('mac-mini-01')!;
    assert.deepEqual(
      [joined.nodeId, joined.source, joined.ephemeral, joined.inviteId, joined.scope, joined.drainAt, joined.evidenceAt, joined.leftAt, joined.destroyedAt],
      ['a1b2c3d4e5f60718', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
      '连回来的旧机器照旧：手动放进来的、还在登记里，没有任何结束事实',
    );
    assert.equal(ledger.machineByNodeToken('hash-of-the-token')?.id, 'mac-mini-01', '它的令牌照旧能用');
    assert.equal(ledger.getMachine('h1'), undefined, '没经客户端接入的机器在版本 24 移除');
    assert.deepEqual(ledger.listInvites(), []);
    ledger.close();
    assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
  });
}

// A real version 14 ledger, as that program left it: the recorded schema, accounts holding
// tiers under the two old names, under a name of their own, under a name the new one
// already has, and under names every object has; Tasks naming them, ended and not, one of
// them with a round still out there; and the Router bound to one of them. `routerTier` is
// the name the Router's own setting holds, so a name it must leave standing can be asked
// for here.
function version14(t: TestContext, routerTier = 'cheap') {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate14-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V14);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('s-version', AT, 'schema_version', '14');
  setting.run('s-tunables', AT, 'tunables', JSON.stringify({
    'router.account': 'router', 'router.tier': routerTier, 'run.timeoutMs': 1000,
  }));
  const account = conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json)
    VALUES (?, ?, ?, 'claude', '[]', NULL, ?)`);
  // Both old names, with the text the owner wrote: it has to come through byte for byte.
  account.run('router', AT, AT, JSON.stringify({
    strong: { kind: 'content', text: '{"model":"<旧强档>","effortLevel":"high"}\n' },
    cheap: { kind: 'ref', value: '/tiers/cheap.json' },
  }));
  // A name of its own, and one whose target the account already holds: neither is guessed.
  account.run('odd', AT, AT, JSON.stringify({
    escalation: { kind: 'content', text: '- id: agent-default-model\n  config:\n    model: <自起的>\n' },
    execute: { kind: 'ref', value: '/tiers/execute.json' },
  }));
  // Names every object has. Written as text, the way a ledger older than this program could
  // hold them: the mapping is not an object, so none of these is one it knows.
  account.run('proto', AT, AT, '{"constructor":{"kind":"ref","value":"/tiers/constructor.json"},"toString":{"kind":"ref","value":"/tiers/toString.json"},"__proto__":{"kind":"ref","value":"/tiers/proto.json"}}');
  conn.prepare(`INSERT INTO project (id, created_at, name, accounts_json, machines_json)
    VALUES ('p1', ?, '试跑', '["router","odd","proto"]', '[]')`).run(AT);
  const task = conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, account_id, tier, state, created_by)
    VALUES (?, ?, 'p1', ?, '目标', '验收', 'router', ?, ?, 'router')`);
  task.run('k-strong', AT, '强档的任务', 'strong', 'queued');
  task.run('k-cheap', AT, '便宜档的任务', 'cheap', 'held');
  task.run('k-own', AT, '自起名字的任务', 'escalation', 'queued');
  task.run('k-done', AT, '已经做完的', 'cheap', 'done');
  task.run('k-lost', AT, '失联机器上的', 'escalation', 'needs_verification');
  task.run('k-none', AT, '没有档位的', null, 'queued');
  task.run('k-proto', AT, '名字叫 constructor 的', 'constructor', 'queued');
  // A round that is still out there, on a name the mapping does not know: it is settled by
  // the snapshot it ran with, so this Task must not be parked out from under it.
  task.run('k-running', AT, '正在跑的一轮', 'escalation', 'running');
  const run = conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, account_id, host, state, marker, snapshot_json)
    VALUES (?, ?, ?, 1, 'router', 'h1', ?, ?, ?)`);
  run.run('r-lost', AT, 'k-lost', 'unknown', 'tycho-run:r-lost', '{"brief":"b","tier":"cheap","tier_value":{"kind":"ref","value":"/tiers/cheap.json"}}');
  run.run('r-running', AT, 'k-running', 'running', 'tycho-run:r-running', '{"brief":"b","tier":"escalation","tier_value":{"kind":"ref","value":"/tiers/escalation.json"}}');
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const peek = new DatabaseSync(file);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  return { path, read, closing };
}

// The step renames the two names and nothing else: every value keeps its bytes, a name it
// does not know is left standing, a Task that would have to run on such a name waits for
// the owner, and a crash on either side of its commit leaves one version or the other.
for (const point of ['none', 'before', 'after'] as const) {
  test('v15 tier-rename migration ' + point + ' commit leaves one version or the other', (t) => {
    const old = version14(t);
    const stored = (): { tiers_json: string }[] => old.read(`SELECT tiers_json FROM account ORDER BY rowid`);
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, point === 'before' ? '14' : '15');
      assert.equal(Object.hasOwn(JSON.parse(stored()[0]!.tiers_json), 'cheap'), point === 'before', '改名和版本号一起提交或一起没有');
    }
    const ledger = old.closing(atV17(old.path));
    // The Router's account: the two names are the new ones, and the text is the same text.
    assert.deepEqual({ ...ledger.getAccount('router')!.tiers }, {
      decide: { kind: 'content', text: '{"model":"<旧强档>","effortLevel":"high"}\n' },
      execute: { kind: 'ref', value: '/tiers/cheap.json' },
    });
    // A name the mapping does not know is not guessed, and neither is the one it collides
    // with: the owner's value stays where it was, under the name it had.
    assert.deepEqual({ ...ledger.getAccount('odd')!.tiers }, {
      escalation: { kind: 'content', text: '- id: agent-default-model\n  config:\n    model: <自起的>\n' },
      execute: { kind: 'ref', value: '/tiers/execute.json' },
    });
    // ...and neither is a name every object has: the mapping has no such key, and the value
    // under it is the owner's, byte for byte. Written as text, because `__proto__` in an
    // object literal is not a key.
    assert.deepEqual(
      { ...ledger.getAccount('proto')!.tiers },
      JSON.parse('{"constructor":{"kind":"ref","value":"/tiers/constructor.json"},"toString":{"kind":"ref","value":"/tiers/toString.json"},"__proto__":{"kind":"ref","value":"/tiers/proto.json"}}'),
    );
    // The Router's own tier is renamed the same way: 'cheap' is what it named.
    assert.equal(ledger.getTunables()['router.tier'], 'execute');
    assert.equal(ledger.getTunables()['run.timeoutMs'], 1000, '别的设置原样');
    assert.equal(ledger.getTunables()['router.account'], 'router');
    // The step after this one gives a Task a role instead of a tier: whatever v15 named, a
    // Task whose next step is the queue waits for a role, and none carries a tier of its own.
    for (const id of ['k-strong', 'k-cheap', 'k-own', 'k-none', 'k-proto']) {
      assert.deepEqual([ledger.getTask(id).state, ledger.getTask(id).reason, ledger.getTask(id).tier], ['waiting_person', NO_ROLE_REASON, null], id);
    }
    assert.deepEqual([ledger.getTask('k-done').state, ledger.getTask('k-done').reason, ledger.getTask('k-done').role_id], ['done', null, null]);
    // One that still has a round out there is left where it is: that round is judged and
    // settled by the snapshot it ran with.
    for (const id of ['k-lost', 'k-running']) {
      assert.equal(ledger.getTask(id).state, id === 'k-lost' ? 'needs_verification' : 'running', id);
      assert.equal(ledger.getTask(id).reason, null, `${id} 不因为这一版多出一条理由`);
    }
    // The snapshot of a round still out there is not touched either: it is what that round
    // ran with. The round the Task still has normally ends, and its receipt moves the Task
    // on — nothing here is treated as "not started" for having been renamed.
    assert.equal(ledger.getRun('r-lost').snapshot_json, '{"brief":"b","tier":"cheap","tier_value":{"kind":"ref","value":"/tiers/cheap.json"}}');
    ledger.close();
    const full = old.closing(openLedger(old.path, { log: () => {} }));
    assert.deepEqual(full.settleRun('r-running', 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] }), { late: false, task_state: 'ready' });
    assert.equal(full.getTask('k-running').state, 'ready', '正常结束的回执照常推进任务');
    full.close();
    assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
  });
}

// A Task a v14 ledger left on a name v15 could not map comes through v16 like any other:
// it waits for a role, and a role is what lets it in — not a tier name.
test('a v14 Task on a name v15 could not map waits for a role after v16, and picking one lets it in', (t) => {
  const old = version14(t);
  const ledger = old.closing(openLedger(old.path, { log: () => {} }));
  assert.equal(ledger.getTask('k-own').wake_at, null);
  assert.throws(() => ledger.resumeTask('k-own', { actor: 'test' }), new RegExp(NO_ROLE_REASON));
  ledger.updateTask('k-own', { roleId: 'implement' }, { actor: 'test' });
  ledger.resumeTask('k-own', { actor: 'test' });
  assert.deepEqual([ledger.getTask('k-own').state, ledger.getTask('k-own').tier], ['queued', 'execute'], '选了职能就能放行，档位由职能推出');
  assert.equal(ledger.getTask('k-done').reason, null, '已经结束的任务不因为这一版多出一条理由');
  ledger.close();
});

// The Router's own tier, left on a name every object has: the setting keeps it, so the
// Router says which names it may be and the owner can change it. A mapping read off an
// object's own prototype would have written a function there and lost the setting.
test('v15 leaves a Router tier the mapping does not know where it is, names every object has included', (t) => {
  const old = version14(t, 'constructor');
  const ledger = old.closing(atV17(old.path));
  assert.equal(ledger.getTunables()['router.tier'], 'constructor', '账本里的旧名字原样留着');
  assert.equal(ledger.getTunables()['run.timeoutMs'], 1000, '别的设置原样');
  ledger.close();
});

// A real version 14 ledger where an account holds an old name together with the name it
// would become: `router` holds `cheap` and `execute`, `odd` holds `strong` and `decide`.
// Which of the two values a reference to the old name meant is the owner's to say, so the
// step renames neither name anywhere.
function version14Collided(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate14-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V14);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('s-version', AT, 'schema_version', '14');
  setting.run('s-tunables', AT, 'tunables', JSON.stringify({
    'router.account': 'router', 'router.tier': 'cheap', 'run.timeoutMs': 1000,
  }));
  const account = conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json)
    VALUES (?, ?, ?, 'claude', '[]', NULL, ?)`);
  account.run('router', AT, AT, JSON.stringify({
    strong: { kind: 'content', text: '{"model":"<旧强档>","effortLevel":"high"}\n' },
    cheap: { kind: 'ref', value: '/tiers/cheap.json' },
    execute: { kind: 'ref', value: '/tiers/execute.json' },
  }));
  account.run('odd', AT, AT, JSON.stringify({
    strong: { kind: 'ref', value: '/tiers/strong.json' },
    decide: { kind: 'ref', value: '/tiers/decide.json' },
  }));
  conn.prepare(`INSERT INTO project (id, created_at, name, accounts_json, machines_json)
    VALUES ('p1', ?, '试跑', '["router","odd"]', '[]')`).run(AT);
  const task = conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, account_id, tier, state, created_by)
    VALUES (?, ?, 'p1', ?, '目标', '验收', ?, ?, ?, 'router')`);
  task.run('k-cheap', AT, '便宜档的任务', 'router', 'cheap', 'queued');
  task.run('k-strong', AT, '强档的任务', 'odd', 'strong', 'queued');
  task.run('k-done', AT, '已经做完的', 'router', 'cheap', 'done');
  task.run('k-run', AT, '正在跑的一轮', 'router', 'cheap', 'running');
  conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, account_id, host, state, marker, snapshot_json)
    VALUES ('r-run', ?, 'k-run', 1, 'router', 'h1', 'running', 'tycho-run:r-run', '{"brief":"b","tier":"cheap","tier_value":{"kind":"ref","value":"/tiers/cheap.json"}}')`).run(AT);
  conn.close();
  return { path, closing };
}

// One name left standing is one name left everywhere: the account that holds both values
// keeps both, every other account keeps the old name too, the Task that names it waits for
// the owner with the two names and the account they are on, and the Router's own tier is
// left on it rather than guessed at. Nothing here is renamed: the same reference would mean
// one of two values, and which one is not this program's to pick.
test('v15 renames an old name nowhere once an account holds it together with the name it would become', (t) => {
  const old = version14Collided(t);
  const ledger = old.closing(atV17(old.path));
  // Both accounts keep every key they had, including the one that would have become the
  // other name; `router` keeps `strong` as well, because one account holding both names is
  // enough for the name to stay everywhere.
  assert.deepEqual({ ...ledger.getAccount('router')!.tiers }, {
    strong: { kind: 'content', text: '{"model":"<旧强档>","effortLevel":"high"}\n' },
    cheap: { kind: 'ref', value: '/tiers/cheap.json' },
    execute: { kind: 'ref', value: '/tiers/execute.json' },
  });
  assert.deepEqual({ ...ledger.getAccount('odd')!.tiers }, {
    strong: { kind: 'ref', value: '/tiers/strong.json' },
    decide: { kind: 'ref', value: '/tiers/decide.json' },
  });
  // The Tasks that named them no longer name a tier at all after v16: they wait for a role,
  // and an ended Task says nothing new.
  for (const id of ['k-cheap', 'k-strong']) assert.deepEqual([ledger.getTask(id).state, ledger.getTask(id).reason], ['waiting_person', NO_ROLE_REASON], id);
  assert.equal(ledger.getTunables()['router.tier'], 'cheap', '负责人的档位也不改名：用哪一份由主人定');
  assert.equal(ledger.getTunables()['run.timeoutMs'], 1000, '别的设置原样');
  assert.deepEqual([ledger.getTask('k-done').state, ledger.getTask('k-done').reason], ['done', null]);
  ledger.close();
  // A round still out there is settled by its snapshot as any other: the name waits for the
  // next time the Task goes into the queue.
  const full = old.closing(openLedger(old.path, { log: () => {} }));
  assert.deepEqual(full.settleRun('r-run', 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] }), { late: false, task_state: 'ready' });
  assert.equal(full.getTask('k-run').state, 'ready');
  full.close();
  assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
});

// A version 15 ledger with a Task in every state the step to 16 has to tell apart. Every row
// goes in through the recorded schema, never today's API.
function version15(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate15-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V15);
  const setting = conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)');
  setting.run('s-version', AT, 'schema_version', '15');
  setting.run('s-whitelist', AT, 'whitelist', JSON.stringify({ console: ['user'] }));
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json)
    VALUES ('t1', ?, ?, 'claude', '[]', NULL, ?)`).run(AT, AT, JSON.stringify({ execute: { kind: 'ref', value: '/tiers/execute.json' }, decide: { kind: 'ref', value: '/tiers/decide.json' } }));
  conn.prepare(`INSERT INTO project (id, created_at, name, accounts_json, machines_json) VALUES ('p1', ?, '试跑', '["t1"]', '[]')`).run(AT);
  const task = conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, account_id, tier, state, reason, wake_at, created_by)
    VALUES (?, ?, 'p1', ?, '目标', '验收', 't1', ?, ?, ?, ?, 'router')`);
  task.run('k-queued', AT, '排队的', 'execute', 'queued', null, null);
  task.run('k-held', AT, '停住的', 'decide', 'held', '先停一下', null);
  task.run('k-timer', AT, '约了时间的', 'execute', 'waiting_timer', null, '2026-12-01T00:00:00.000Z');
  task.run('k-stale', AT, '旧名字停着的', 'escalation', 'waiting_person', '旧档位名 escalation 系统不再用，改一个档位再放行', null);
  task.run('k-asked', AT, '在等回答的', 'execute', 'waiting_person', null, null);
  task.run('k-ready', AT, '等验收的', 'execute', 'ready', null, null);
  task.run('k-draft', AT, '草稿', 'execute', 'draft', null, null);
  task.run('k-running', AT, '正在跑的', 'decide', 'running', null, null);
  task.run('k-lost', AT, '失联的', 'execute', 'needs_verification', null, null);
  task.run('k-done', AT, '做完的', 'decide', 'done', null, null);
  task.run('k-gone', AT, '放弃的', 'execute', 'abandoned', '不做了', null);
  conn.prepare(`INSERT INTO approval (id, created_at, task_id, task_revision, questions_json, state) VALUES ('a-open', ?, 'k-asked', 1, '[{"question":"用哪个？"}]', 'open')`).run(AT);
  const run = conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, account_id, host, state, marker, snapshot_json, exit_kind)
    VALUES (?, ?, ?, 1, 't1', 'h1', ?, ?, ?, ?)`);
  run.run('r-ready', AT, 'k-ready', 'ended', 'tycho-run:r-ready', SNAPSHOT_15('execute'), 'completed');
  run.run('r-running', AT, 'k-running', 'running', 'tycho-run:r-running', SNAPSHOT_15('decide'), null);
  run.run('r-lost', AT, 'k-lost', 'unknown', 'tycho-run:r-lost', SNAPSHOT_15('execute'), null);
  run.run('r-done', AT, 'k-done', 'ended', 'tycho-run:r-done', SNAPSHOT_15('decide'), 'completed');
  conn.close();
  const read = <T>(sql: string, file = path): T[] => {
    const peek = new DatabaseSync(file);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  const version = (): string => read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json;
  const columns = (): string[] => read<{ name: string }>(`SELECT name FROM pragma_table_info('task')`).map(({ name }) => name);
  return { path, read, version, columns, closing };
}
const SNAPSHOT_15 = (tier: string): string => JSON.stringify({ brief: 'b', tier, tier_value: { kind: 'ref', value: `/tiers/${tier}.json` } });

for (const point of ['none', 'before', 'after'] as const) {
  test('v16 role migration ' + point + ' commit leaves one version or the other, and guesses no role', (t) => {
    const old = version15(t);
    const snapshots = old.read<{ id: string; snapshot_json: string }>('SELECT id, snapshot_json FROM run ORDER BY rowid');
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.version(), point === 'before' ? '15' : '16');
      // The table, the columns, the presets, the parking and the version are one commit.
      assert.equal(old.columns().includes('tier'), point === 'before');
      assert.equal(old.columns().includes('role_id'), point !== 'before');
      assert.equal(old.read(`SELECT name FROM sqlite_master WHERE name = 'role'`).length, point === 'before' ? 0 : 1);
      assert.equal(old.read<{ state: string }>(`SELECT state FROM task WHERE id = 'k-queued'`)[0]!.state, point === 'before' ? 'queued' : 'waiting_person');
    }
    const ledger = old.closing(openLedger(old.path, { log: () => {} }));
    assert.deepEqual(ledger.listRoles().map(roleConfig), PRESET_ROLES.map(roleConfig), '四个预置职能');
    assert.ok(!old.columns().includes('tier'), '任务不再存一份档位');
    // No role is guessed from the old tier, ended or not.
    assert.deepEqual(ledger.listTasks().filter(({ role_id }) => role_id !== null), []);
    // A Task whose next step is the queue waits for a role, its timer and old reason gone.
    for (const id of ['k-queued', 'k-held', 'k-timer', 'k-stale']) {
      const task = ledger.getTask(id);
      assert.deepEqual([task.state, task.reason, task.wake_at, task.tier], ['waiting_person', NO_ROLE_REASON, null, null], id);
    }
    // The rest keep their state; the queue's own guard stops them when they would go in.
    assert.deepEqual(
      ['k-asked', 'k-ready', 'k-draft', 'k-running', 'k-lost', 'k-done', 'k-gone'].map((id) => [id, ledger.getTask(id).state, ledger.getTask(id).reason]),
      [['k-asked', 'waiting_person', null], ['k-ready', 'ready', null], ['k-draft', 'draft', null], ['k-running', 'running', null],
        ['k-lost', 'needs_verification', null], ['k-done', 'done', null], ['k-gone', 'abandoned', '不做了']],
    );
    assert.deepEqual(old.read('SELECT id, snapshot_json FROM run ORDER BY rowid'), snapshots, 'Run 的快照一个字不动');
    ledger.close();
    assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
  });
}

test('after v16 every way a Task with no role goes back to the queue stops it until a role is picked', (t) => {
  const old = version15(t);
  const ledger = old.closing(openLedger(old.path, { log: () => {} }));
  const ctx = { actor: 'test' };
  const parked = (id: string) => assert.deepEqual([ledger.getTask(id).state, ledger.getTask(id).reason], ['waiting_person', NO_ROLE_REASON], id);
  // An answer, a rework, the draft being queued, and a round settling all stop at the guard.
  ledger.answerApproval('a-open', ['甲'], 'user', 'console');
  parked('k-asked');
  ledger.reworkTask('k-ready', '再核一遍', ledger.getTask('k-ready').revision, ctx);
  parked('k-ready');
  ledger.queueTask('k-draft', ctx);
  parked('k-draft');
  ledger.settleRun('r-running', 1, null, { kind: 'quota', quota: { message: '额度没了' } });
  parked('k-running');
  assert.deepEqual(ledger.queuedTasks(), [], '一个没职能的任务都进不了队列');
  // "继续" says what is missing; picking a role is what lets it in, on the role's tier.
  assert.throws(() => ledger.resumeTask('k-held', ctx), new RegExp(NO_ROLE_REASON));
  ledger.updateTask('k-held', { roleId: 'verify' }, ctx);
  ledger.resumeTask('k-held', ctx);
  assert.deepEqual([ledger.getTask('k-held').state, ledger.getTask('k-held').tier, ledger.getTask('k-held').tier_source], ['queued', 'operate', 'default']);
  // A Task that ended keeps no role and cannot be given one: it is the record of what it was.
  assert.throws(() => ledger.updateTask('k-done', { roleId: 'implement' }, ctx), /已关闭/);
  ledger.close();
});

test('a v15 Task waiting to be accepted can still be accepted after v16, with no role', (t) => {
  const old = version15(t);
  const ledger = old.closing(openLedger(old.path, { log: () => {} }));
  ledger.acceptTask('k-ready', '看过了', { actor: 'test' });
  assert.deepEqual([ledger.getTask('k-ready').state, ledger.getTask('k-ready').role_id], ['done', null]);
  ledger.close();
});

// A v15 Task that names no account, with its round still out on a machine that has since
// gone quiet, and another machine that answers. After v16 it has no role, so nothing says
// which accounts its continuation could go to: the old round is left as it is (not judged
// gone), the Router is told once, and picking a role is what lets the usual judgment and
// continuation run — on the machine that answers.
test('after v16 a lost round of an unpinned Task without a role waits for one, then is judged and continued as before', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate15-lost-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V15);
  conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '15')`).run(AT);
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json)
    VALUES ('t1', ?, ?, 'claude', '[]', NULL, ?)`).run(AT, AT, JSON.stringify({ execute: { kind: 'content', text: '{"model":"m"}\n' } }));
  const machine = conn.prepare(`INSERT INTO machine (id, created_at, updated_at, host) VALUES (?, ?, ?, ?)`);
  machine.run('old', AT, AT, 'old');
  machine.run('spare', AT, AT, 'spare');
  conn.prepare(`INSERT INTO project (id, created_at, name, accounts_json, machines_json) VALUES ('p1', ?, '试跑', '["t1"]', '[]')`).run(AT);
  conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, account_id, tier, state, created_by)
    VALUES ('k-lost', ?, 'p1', '失联的', '目标', '验收', NULL, 'execute', 'needs_verification', 'router')`).run(AT);
  conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, account_id, host, machine_id, state, marker, snapshot_json, started_at)
    VALUES ('r-lost', ?, 'k-lost', 1, 't1', 'old', 'old', 'unknown', 'tycho-run:r-lost', ?, ?)`).run(AT, SNAPSHOT_15('execute'), AT);
  conn.close();

  const ledger = openLedger(path, joinedBefore24(path));
  opened.push(ledger);
  assert.deepEqual([ledger.getTask('k-lost').state, ledger.getRun('r-lost').state], ['needs_verification', 'unknown'], '迁移不动在外面的那一轮');
  const presumed: string[] = [];
  const launched: string[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED, reported: (_machine, executor) => signedInEverywhere([executor])().executors[0]!,
    ledger,
    logins: createLogins({ ledger, accounts: { get: (id) => ledger.getAccount(id), list: () => ledger.listAccounts() }, executors: { claude: claudeAdapter } }),
    machines: { get: (id) => ledger.getMachine(id), list: () => ledger.listMachines() },
    executors: { claude: claudeAdapter },
    runner: {
      // The old machine does not answer; the spare does.
      findMachine: async (_account, machines) => machines.find(({ id }) => id === 'spare'),
      lostCandidates: () => ledger.listActiveRuns().filter(({ state }) => state === 'unknown'),
      presume: async (run) => {
        presumed.push(run.id);
        ledger.settleRun(run.id, null, null, { kind: 'lost', lost: { basis: 'presumed' } });
        return 'lost';
      },
      sweep: async () => {},
      launch: async (run) => { launched.push(run.machine_id ?? ''); },
      watch: async () => {},
    },
    runTimeoutMs: () => 60_000,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  await dispatcher.tick();
  await dispatcher.tick();
  assert.deepEqual([presumed, launched], [[], []], '没有职能就不判死、不接续');
  assert.deepEqual([ledger.getTask('k-lost').state, ledger.getRun('r-lost').state], ['needs_verification', 'unknown']);
  const told = (): number => ledger.listChanges({ taskId: 'k-lost' }).filter(({ action }) => action === 'run.lost_without_role').length;
  assert.equal(told(), 1, '告诉负责人一次，不是每一轮都说');
  // The owner picks a role: the round is judged by the usual rule, and the Task goes on
  // on the machine that answers.
  ledger.updateTask('k-lost', { roleId: 'implement' }, { actor: 'test' });
  await dispatcher.tick();
  assert.deepEqual(presumed, ['r-lost']);
  assert.equal(ledger.getRun('r-lost').state, 'ended');
  assert.deepEqual(launched, ['spare'], '同一轮派发里接续到答话的那台');
  assert.equal(ledger.getTask('k-lost').state, 'running');
});

// A ledger as version 16 left it: roles, a Task waiting to be accepted on the implement role
// with its round, and one in the queue. v17 adds review (docs/design/roles-and-tiers.md §4).
function version16(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate16-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  const closing = <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; };
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V16);
  conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '16')`).run(AT);
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) role.run(each.id, AT, AT, each.name, each.description, each.default_tier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, machines_json, config_dir, tiers_json) VALUES ('t1', ?, ?, 'claude', '[]', NULL, ?)`)
    .run(AT, AT, JSON.stringify({ execute: { kind: 'ref', value: '/tiers/execute.json' } }));
  conn.prepare(`INSERT INTO project (id, created_at, name, accounts_json, machines_json) VALUES ('p1', ?, '试跑', '["t1"]', '[]')`).run(AT);
  const task = conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, account_id, role_id, tier_override, tier_reason, state, created_by)
    VALUES (?, ?, 'p1', ?, '目标', '验收', 't1', 'implement', ?, ?, ?, 'router')`);
  task.run('k-ready', AT, '等验收的', null, null, 'ready');
  task.run('k-queued', AT, '排队的', 'decide', '难', 'queued');
  conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, account_id, host, state, marker, snapshot_json, exit_kind, started_at)
    VALUES ('r-ready', ?, 'k-ready', 1, 't1', 'h1', 'ended', 'tycho-run:r-ready', ?, 'completed', ?)`)
    .run(AT, JSON.stringify({ brief: 'b', executor: 'claude', tier: 'execute', tier_value: { kind: 'ref', value: '/x' }, role: roleConfig(PRESET_ROLES[0]!), tier_source: 'default' }), AT);
  conn.close();
  const read = <T>(sql: string): T[] => {
    const peek = new DatabaseSync(path);
    try { return peek.prepare(sql).all() as T[]; } finally { peek.close(); }
  };
  const version = (): string => read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json;
  const columns = (): string[] => read<{ name: string }>(`SELECT name FROM pragma_table_info('task')`).map(({ name }) => name);
  return { path, read, version, columns, closing };
}

for (const point of ['none', 'before', 'after'] as const) {
  test('v17 review migration ' + point + ' commit leaves one version or the other, and changes no Task', (t) => {
    const old = version16(t);
    const tasks = old.read('SELECT * FROM task ORDER BY rowid');
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.version(), point === 'before' ? '16' : '17');
      // The three columns and the version are one commit.
      for (const column of ['tier_escalated', 'review_of_json', 'verdict_json']) assert.equal(old.columns().includes(column), point !== 'before', column);
      assert.equal(old.read<{ name: string }>(`SELECT name FROM pragma_table_info('run')`).some(({ name }) => name === 'artifacts_json'), point !== 'before', 'run.artifacts_json');
      assert.equal(old.read<{ name: string }>(`SELECT name FROM pragma_table_info('approval')`).some(({ name }) => name === 'review_task_id'), point !== 'before', 'approval.review_task_id');
    }
    // What the step to 17 did, read as it left it: the step to 18 repoints the pins of the
    // accounts it makes machines' own logins, and is tested on its own.
    toV17(old.path);
    assert.deepEqual(legacyRows(old.read('SELECT * FROM task ORDER BY rowid')), legacyRows(tasks), '没有任务被改动');
    const ledger = old.closing(openLedger(old.path, { log: () => {} }));
    assert.equal(old.version(), String(SCHEMA_VERSION));
    // Nothing older is a review or escalated; an override stays an override.
    assert.deepEqual([ledger.getTask('k-queued').tier_source, ledger.getTask('k-queued').review_of_json], ['override', null]);
    // A v16 Task of a role that needs review now waits for one before it can be accepted,
    // and can be reviewed: its round is what the binding is made from.
    assert.throws(() => ledger.acceptTask('k-ready', '看过了', { actor: 'router' }), /要独立审阅/);
    ledger.putAccount({ id: 't2', name: 't2', executor: 'codex', tiers: { decide: { kind: 'content', text: 'model=d\n' } } }, { actor: 'test' }, 'ref-t2');
    // Its round's files are not known until the host takes them over; then it can be bound.
    assert.equal(ledger.currentProduct('k-ready').files, null);
    const registration = ledger.registerArtifacts('r-ready', []);
    const reviewed = ledger.createTask({ projectId: 'p1', title: '审', goal: '审', roleId: 'review', reviewOf: { taskId: 'k-ready', runId: 'r-ready', revision: 1, registration } }, { actor: 'router' });
    assert.deepEqual(JSON.parse(ledger.getTask(reviewed.id).review_of_json!).writers, ['claude']);
    ledger.close();
  });
}

// A ledger as version 18 left it: a project, a Task with its round, an open question and a
// setting. v19 adds knowledge (docs/design/knowledge-and-skills.md §8 step 1): five new tables,
// empty, and nothing that was there moves.
const V18 = readFileSync(new URL('./fixtures/ledger/schema-v18.sql', import.meta.url), 'utf8');

function version18(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate18-'));
  const path = join(dir, 'ledger.db');
  const opened: { close(): void }[] = [];
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V18);
  conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '18')`).run(AT);
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) role.run(each.id, AT, AT, each.name, each.description, each.default_tier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, config_dir, tiers_json, credential_ref) VALUES ('t1', ?, ?, 'claude', NULL, ?, 'c1')`)
    .run(AT, AT, JSON.stringify({ execute: { kind: 'ref', value: '/tiers/execute.json' } }));
  conn.prepare(`INSERT INTO project (id, created_at, name, logins_json, machines_json) VALUES ('p1', ?, '试跑', '["t1"]', '[]')`).run(AT);
  conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, login_id, role_id, state, created_by) VALUES ('k1', ?, 'p1', '问着的', '目标', '验收', 't1', 'implement', 'waiting_person', 'router')`).run(AT);
  conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, login_id, host, state, marker, snapshot_json, exit_kind, started_at)
    VALUES ('r1', ?, 'k1', 1, 't1', 'h1', 'ended', 'tycho-run:r1', ?, 'completed', ?)`).run(AT, JSON.stringify({ brief: 'b', executor: 'claude', tier: 'execute', tier_value: { kind: 'ref', value: '/x' } }), AT);
  conn.prepare(`INSERT INTO approval (id, created_at, task_id, run_id, task_revision, questions_json, state) VALUES ('a1', ?, 'k1', 'r1', 1, '[{"question":"继续吗"}]', 'open')`).run(AT);
  conn.close();
  const read = <T>(sql: string): T[] => {
    const peek = new DatabaseSync(path);
    try { return peek.prepare(sql).all() as T[]; } finally { peek.close(); }
  };
  const version = (): string => read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json;
  const tables = (): string[] => read<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge%' ORDER BY name`).map(({ name }) => name);
  return { path, read, version, tables, closing: <T extends { close(): void }>(thing: T): T => { opened.push(thing); return thing; } };
}

for (const point of ['none', 'before', 'after'] as const) {
  test('v19 knowledge migration ' + point + ' commit leaves one version or the other, and moves nothing that was there', (t) => {
    const old = version18(t);
    // The task's knowledge column is new and empty: everything else is as it was.
    const rows = () => {
      const accountRows = old.read<{id:string;name?:string}>('SELECT * FROM account');
      const names = new Map(accountRows.map(({id,name}) => [id, name ?? id]));
      return ['task', 'run', 'approval', 'project', 'account', 'role'].map((table) => legacyRows(old.read(`SELECT * FROM ${table} ORDER BY rowid`), names));
    };
    const before = rows();
    const knowledgeTables = ['knowledge', 'knowledge_client', 'knowledge_evidence', 'knowledge_proposal', 'knowledge_revision'];
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.version(), point === 'before' ? '18' : '19');
      assert.deepEqual(old.tables(), point === 'before' ? [] : knowledgeTables, '五张表和版本号是同一次提交');
    }
    const ledger = old.closing(openLedger(old.path, { log: () => {} }));
    assert.equal(old.version(), String(SCHEMA_VERSION));
    assert.deepEqual(old.tables(), knowledgeTables);
    assert.deepEqual(rows(), before, '原有的行一行不动');
    assertNoOutputDisposition(old.path);
    assert.deepEqual(old.read<{ knowledge_json: string | null }>('SELECT knowledge_json FROM task').map(({ knowledge_json }) => knowledge_json), [null]);
    // v36 adds a Task's preference for logins; an older Task has none.
    assert.deepEqual(old.read<{ prefer_json: string | null }>('SELECT prefer_json FROM task').map(({ prefer_json }) => prefer_json), [null]);
    // A knowledge task belongs to no project: the column takes none now, and still names a
    // project when it holds one; references to the Task from other tables still hold.
    assert.deepEqual(old.read<{ notnull: number }>(`SELECT "notnull" FROM pragma_table_info('task') WHERE name = 'project_id'`).map(({ notnull }) => notnull), [0]);
    assert.deepEqual(old.read<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list('task') ORDER BY "table"`).map(({ table }) => table), ['project', 'task']);
    assert.equal(old.read(`SELECT * FROM pragma_foreign_key_check`).length, 0);
    assert.deepEqual([ledger.listEntries({ includeRetired: true }), ledger.listProposals(), ledger.listClients()], [[], [], []]);
    // An old round's snapshot has no knowledge, and the set it was given reads as empty.
    assert.equal((JSON.parse(ledger.getRun('r1').snapshot_json) as Snapshot).knowledge, undefined);
    const gate = ledger.propose({ outputs: [{ title: '标题', when_to_use: '何时', body: '正文', project_ids: null, loading: 'on_demand' }], why: { when: '何时', changes: '改什么', generalizes: '边界' }, evidence: [{ source: 'file', location: 'a.md', excerpt: '摘录' }] }, { source: 'mcp', by: '外部会话', client: 'mcp:c1', writers: ['codex'] }, { actor: 'user' });
    const createdProposal = ledger.getProposal(gate.id);
    if (createdProposal.gate_task_id !== null) {
      assert.equal(ledger.getTask(createdProposal.gate_task_id).project_id, null);
    } else {
      assert.ok(createdProposal.state === 'published' || createdProposal.state === 'awaiting_owner');
    }
    assert.throws(() => ledger.createTask({ projectId: 'nope', title: 't', goal: 'g', roleId: 'implement' }, { actor: 'user' }), /FOREIGN KEY|项目不存在/);
    ledger.close();
    // Closed, so that the commits are in the file and not only in its -wal.
    assert.equal(verifySnapshot(old.path).get('schema_version'), String(SCHEMA_VERSION));
  });
}


for (const point of ['none', 'before', 'after'] as const) {
  test(`v43 output columns preserve populated v42 rows across ${point} commit`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate42-output-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'ledger.db');
    const conn = new DatabaseSync(path);
    conn.exec(readFileSync(new URL('./fixtures/ledger/schema-v42.sql', import.meta.url), 'utf8'));
    conn.prepare(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '42')`).run(AT);
    conn.prepare(`INSERT INTO project (id, created_at, name) VALUES ('p1', ?, '旧项目')`).run(AT);
    conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, state, created_by) VALUES ('k1', ?, 'p1', '旧任务', '原目标', 'done', 'owner')`).run(AT);
    conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, host, state, marker, snapshot_json, session_ref, exit_code, exit_kind, receipt_json, machine_id, node_id)
      VALUES ('r1', ?, 'k1', 3, 'old-host', 'ended', 'old-marker', '{"brief":"原始快照"}', 'old-session', 0, 'completed', '{"status":"done"}', 'old-machine', 'old-node')`).run(AT);
    conn.prepare(`INSERT INTO work_cleanup (id, created_at, project_id, project_name, run_id, task_id, machine_id, node_id, releases_json, releases_dropped_at)
      VALUES ('w1', ?, 'p1', '原项目名', 'r1', 'k1', 'old-machine', 'old-node', '[]', ?)`).run(AT, AT);
    conn.close();
    const rows = () => {
      const peek = new DatabaseSync(path);
      try {
        return Object.fromEntries(['run', 'work_cleanup'].map((table) => [table, peek.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
      } finally { peek.close(); }
    };
    const version = () => {
      const peek = new DatabaseSync(path);
      try { return (peek.prepare(`SELECT value_json FROM setting WHERE key = 'schema_version'`).get() as { value_json: string }).value_json; }
      finally { peek.close(); }
    };
    const before = rows();
    const expected = {
      run: before.run!.map((row) => ({ ...row, capture_result_json: null })),
      work_cleanup: before.work_cleanup!.map((row) => ({ ...row, output_release_json: null })),
    };
    if (point === 'none') new Db(path, false, {}, { log: () => {} }).close();
    else {
      const hooks = point === 'before'
        ? { beforeMigrationCommit(from: number) { assert.equal(from, 42); throw new Crash(); } }
        : { afterMigrationCommit(from: number) { assert.equal(from, 42); throw new Crash(); } };
      assert.throws(() => new Db(path, false, hooks, { log: () => {} }), Crash);
      assert.equal(version(), point === 'before' ? '42' : '43');
      assert.deepEqual(rows(), point === 'before' ? before : expected, 'columns and version commit together without altering an old value');
    }
    let steps = 0;
    new Db(path, false, { beforeMigrationCommit() { steps += 1; } }, { log: () => {} }).close();
    const remainingFrom43 = SCHEMA_VERSION - 43;
    assert.equal(
      steps,
      point === 'none' ? 0 : point === 'before' ? remainingFrom43 + 1 : remainingFrom43,
      'only uncommitted and subsequent migrations run',
    );
    assert.equal(version(), String(SCHEMA_VERSION));
    assert.deepEqual(rows(), expected, 'every historical column stays equal; only the two new null columns appear');
    assertNoOutputDisposition(path);
  });
}
