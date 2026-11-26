// Guards the step from version 40 to 41 (docs/design/code-sources.md §5; shared/sources.ts)
// against an upgrade that: loses a project's code directory or remote, invents one, pins a
// Task to the wrong source (or to one a project does not have), rewrites an ended Task, or
// leaves a Task of a project with no source pinned to anything; against an old remote a machine
// cannot be handed being kept as a source instead of dropped with an audit that repeats no
// secret; against a host machine
// registration that cannot be recovered being guessed instead of left to the owner; against
// reading a directory's origin through a pipe (which a confined process may not open) or
// failing the upgrade when git or the directory is not there; and against a crash on either
// side of the step's commit leaving a ledger of one version with the other's columns.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Db, SCHEMA_VERSION } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { git, hasGit, scratchRepo } from './git-repo.ts';

const V40 = readFileSync(new URL('./fixtures/ledger/schema-v40.sql', import.meta.url), 'utf8');
const AT = '2026-11-12T00:00:00.000Z';
const skipWithoutGit = hasGit() ? false : '这台机器上没有可用的 git';

class Crash extends Error {}

function version40(t: TestContext, setup: (conn: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-sources-'));
  const path = join(dir, 'ledger.db');
  // Windows keeps a directory for as long as a process (or an open ledger) stands in it.
  t.after(async () => {
    for (let n = 0; n < 20; n += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(100);
      }
    }
  });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(V40);
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)').run('s-version', AT, 'schema_version', '40');
  setup(conn);
  conn.close();
  const read = <T>(sql: string): T[] => {
    const peek = new DatabaseSync(path);
    try {
      return peek.prepare(sql).all() as T[];
    } finally {
      peek.close();
    }
  };
  return { path, read };
}

function project(conn: DatabaseSync, id: string, fields: { repo?: string | null; codeDir?: string | null } = {}): void {
  conn.prepare(`INSERT INTO project (id, created_at, name, repo, code_dir) VALUES (?, ?, ?, ?, ?)`)
    .run(id, AT, id, fields.repo ?? null, fields.codeDir ?? null);
}

function task(conn: DatabaseSync, id: string, projectId: string | null, state: string): void {
  conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, state, created_by) VALUES (?, ?, ?, ?, '目标', ?, 'router')`)
    .run(id, AT, projectId, id, state);
}

// A local machine registration and the host's binding to it: what a folder source names.
function hostMachine(conn: DatabaseSync, id = 'h1', uid = 'u-host'): void {
  conn.prepare(`INSERT INTO machine (id, uid, created_at, updated_at, host, node_id, platform, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, 'win32', ?)`).run(id, uid, AT, AT, id, `node-${id}`, AT);
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)')
    .run('s-host', AT, 'host_machine_uid', JSON.stringify(uid));
}

test('v40 的项目代码目录变成主机机器上的工作目录来源，origin 能用的排在后面；旧 repo 列变成一个仓库来源', { skip: skipWithoutGit }, (t) => {
  const repo = scratchRepo(t);
  assert.equal(git(['remote', 'add', 'origin', 'https://user:secret@example.test/tycho.git?x=1'], repo.dir).code, 0);
  const old = version40(t, (conn) => {
    hostMachine(conn);
    project(conn, 'p1', { repo: 'https://example.test/ignored.git', codeDir: repo.dir });
    project(conn, 'p2', { codeDir: join(repo.dir, 'nowhere') });
    project(conn, 'p3', { repo: 'https://example.test/only.git' });
    project(conn, 'p4');
    task(conn, 't1', 'p1', 'queued');
    task(conn, 't2', 'p1', 'done');
    task(conn, 't3', 'p2', 'running');
    task(conn, 't4', 'p3', 'draft');
    task(conn, 't5', 'p4', 'queued');
    task(conn, 't6', null, 'queued');
  });
  const ledger = openLedger(old.path, { log: () => {} });
  try {
    assert.ok(SCHEMA_VERSION >= 44);

  const p1 = ledger.projectSources('p1');
  assert.deepEqual(p1.map((source) => (source.kind === 'folder' ? ['folder', source.machine_uid, source.path] : ['repo', source.url])), [
    ['folder', 'u-host', repo.dir],
    ['repo', 'https://example.test/tycho.git'],
  ], '代码目录是第一个来源，origin 去掉秘密和查询串后排在后面（旧 repo 列不参与）');
  assert.deepEqual(ledger.projectSources('p2').map((source) => (source.kind === 'folder' ? ['folder', source.machine_uid, source.path] : ['repo', source.url])), [
    ['folder', 'u-host', join(repo.dir, 'nowhere')],
  ], '目录不在、没有 origin 时只留工作目录来源，升级不失败');
  assert.deepEqual(ledger.projectSources('p3'), [{ id: ledger.projectSources('p3')[0]!.id, kind: 'repo', url: 'https://example.test/only.git' }]);
  assert.deepEqual(ledger.projectSources('p4'), []);

  // 进行中的任务钉到迁移后的第一个来源；已结束的不动。
  assert.deepEqual(ledger.taskSource('t1'), { source_id: p1[0]!.id, pinned: p1[0] });
  assert.equal(ledger.taskSource('t2'), null, '已结束的任务不钉来源');
  assert.equal(ledger.taskSource('t3')!.source_id, ledger.projectSources('p2')[0]!.id);
  assert.equal(ledger.taskSource('t4')!.source_id, ledger.projectSources('p3')[0]!.id);
  assert.equal(ledger.taskSource('t5'), null, '项目没有来源，任务也就没有');
  assert.equal(ledger.taskSource('t6'), null, '知识任务不属于项目，没有来源');
  assert.equal(ledger.taskSourceState('t1'), 'current');

  // The project page reads the same list: the first is the default, each with its label.
  const view = ledger.projectSourceViews('p1');
  assert.deepEqual(view.pending, []);
  assert.deepEqual(view.sources.map((source) => [source.default, source.label]), [
    [true, `h1 上的 ${repo.dir}`],
    [false, '仓库 https://example.test/tycho.git'],
  ]);

  // The old columns are gone, not left beside the new one.
  const projectColumns = old.read<{ name: string }>(`SELECT name FROM pragma_table_info('project')`).map(({ name }) => name);
  assert.equal(projectColumns.includes('sources_json'), true);
  assert.equal(projectColumns.includes('repo'), false);
  assert.equal(projectColumns.includes('code_dir'), false);
  assert.ok(old.read<{ name: string }>(`SELECT name FROM pragma_table_info('task')`).some(({ name }) => name === 'source_json'));
  } finally {
    ledger.close();
  }
});

test('旧 repo 列里机器用不了的地址不建来源，记一条去掉秘密的审计', (t) => {
  const old = version40(t, (conn) => {
    project(conn, 'p1', { repo: 'ftp://user:secret@example.test/r.git?token=abc' });
    project(conn, 'p2', { repo: '/host/checkout' });
    project(conn, 'p3', { repo: 'https://example.test/ok.git' });
    project(conn, 'p4', { repo: '   ' });
    task(conn, 't1', 'p1', 'queued');
    task(conn, 't3', 'p3', 'queued');
  });
  const ledger = openLedger(old.path, { log: () => {} });
  try {
    // 机器用不了的地址没有变成来源，也没有把它原样存下来。
    assert.deepEqual(ledger.projectSources('p1'), []);
    assert.deepEqual(ledger.projectSources('p2'), []);
    assert.deepEqual(ledger.projectSources('p4'), []);
    assert.deepEqual(ledger.projectSources('p3').map((source) => (source.kind === 'repo' ? source.url : null)), ['https://example.test/ok.git']);
    assert.equal(ledger.taskSource('t1'), null, '项目没有来源，没结束的任务也就不钉');
    assert.equal(ledger.taskSource('t3')!.source_id, ledger.projectSources('p3')[0]!.id);

    const rows = old.read<{ detail_json: string }>("SELECT detail_json FROM change WHERE actor = 'migration' AND action = 'project.update' ORDER BY seq");
    assert.equal(JSON.stringify(rows).includes('secret'), false, '审计里没有秘密');
    assert.equal(JSON.stringify(rows).includes('token=abc'), false, '查询串也不留');
    const said = rows.map(({ detail_json }) => JSON.parse(detail_json) as {
      project_id: string; sources_dropped: { kind: string; value: string; reason: string }[];
    });
    assert.deepEqual(said.map(({ project_id, sources_dropped }) => [project_id, sources_dropped.map(({ kind, value }) => [kind, value])]), [
      ['p1', [['repo', 'ftp://example.test/r.git']]],
      ['p2', [['repo', '/host/checkout']]],
    ], '每个丢弃的地址记一条，值去掉用户名密码和查询串');
    assert.match(said[0]!.sources_dropped[0]!.reason, /机器用不了/);
  } finally {
    ledger.close();
  }
});

test('a code directory whose host machine cannot be recovered is left for the owner to confirm', (t) => {
  const old = version40(t, (conn) => {
    // No machine registration and no host binding: the migration must not guess one.
    project(conn, 'p1', { codeDir: '/host/tycho' });
    task(conn, 't1', 'p1', 'queued');
    // An ended Task pinned to the same item: confirming the machine has nothing to fill in there.
    task(conn, 't2', 'p1', 'done');
  });
  const ledger = openLedger(old.path, { log: () => {} });
  try {
    const [source] = ledger.projectSources('p1');
    assert.deepEqual(source, { id: source!.id, kind: 'folder', machine_uid: '', path: '/host/tycho' }, '机器记成待确认，不是编一台出来');
    assert.deepEqual(ledger.projectSourceViews('p1').pending, [source!.id]);
    assert.equal(ledger.projectSourceViews('p1').sources[0]!.label, '待确认的机器上的 /host/tycho');
    // A Task pinned there stops and says what to do.
    assert.match(ledger.sourceRefusal(ledger.getTask('t1'))!, /还在等主人选机器/);
    // Saving the list is how the owner confirms the machine; an empty machine id is not accepted.
    assert.throws(() => ledger.setProjectSources('p1', [{ id: source!.id, kind: 'folder', machine_uid: '', path: '/host/tycho' }], { actor: 'console' }), /要选一台机器/);
    // §8.8, the other half: picking the machine is that confirmation, and the unfinished Tasks
    // pinned to the item take it in the same transaction — the owner is not asked the same thing
    // twice, and each one leaves a line on its timeline.
    const machine = ledger.joinMachine(
      { id: 'mac', host: 'mac', nodeId: 'node-mac', tokenHash: 'hash-of-the-token', platform: 'test', source: null, ephemeral: false },
      { actor: 'test' },
    );
    const confirmed = { id: source!.id, kind: 'folder' as const, machine_uid: machine.uid, path: '/host/tycho' };
    ledger.setProjectSources('p1', [confirmed], { actor: 'console' });
    assert.deepEqual(ledger.taskSource('t1'), { source_id: source!.id, pinned: confirmed }, '主人选上机器，还没结束的任务一起补上');
    assert.equal(ledger.sourceRefusal(ledger.getTask('t1')), undefined, '补上之后可以接着做');
    assert.equal(ledger.listChanges({ taskId: 't1' }).filter(({ action }) => action === 'task.source_machine').length, 1, '补过的任务各记一条审计');
    const ended = ledger.taskSource('t2');
    assert.equal(ended, null, '已经结束的任务不迁来源，确认机器时也不动它');
  } finally {
    ledger.close();
  }
});

for (const point of ['none', 'before', 'after'] as const) {
  test('v40 → 41 ' + point + ' commit 留在一个版本上', (t) => {
    const old = version40(t, (conn) => {
      project(conn, 'p1', { repo: 'https://example.test/tycho.git' });
      task(conn, 't1', 'p1', 'queued');
    });
    const columns = (table: string): string[] =>
      old.read<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map(({ name }) => name);
    if (point !== 'none') {
      const hooks = point === 'before' ? { beforeMigrationCommit() { throw new Crash(); } } : { afterMigrationCommit() { throw new Crash(); } };
      assert.throws(() => new Db(old.path, false, hooks, { log: () => {} }), Crash);
      assert.equal(old.read<{ value_json: string }>(`SELECT value_json FROM setting WHERE key = 'schema_version'`)[0]!.value_json, point === 'before' ? '40' : '41');
      assert.equal(columns('project').includes('sources_json'), point === 'after');
      assert.equal(columns('task').includes('source_json'), point === 'after');
    }
    const ledger = openLedger(old.path, { log: () => {} });
    try {
      assert.deepEqual(ledger.projectSources('p1').map((source) => (source.kind === 'repo' ? source.url : null)), ['https://example.test/tycho.git']);
      assert.equal(ledger.taskSource('t1')!.source_id, ledger.projectSources('p1')[0]!.id);
    } finally {
      ledger.close();
    }
  });
}
