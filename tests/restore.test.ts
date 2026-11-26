// Guards against §2's restore going wrong in the file work: a running service having its
// ledger swapped, a backup's unmerged -wal being lost, a stale -wal being replayed onto the
// restored file, a crash leaving no ledger.db (the next start would build an empty one) or
// an unsealed one, the sealing being partial, the old ledger not being kept, and an orphan
// count that reads a host it could not reach as a host with nothing on it, and an empty
// file or another program's database being restored as an empty ledger, or a file that
// carries a ledger's version without its tables getting as far as the sealing.
// The whole path through a start is in acceptance-6.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createRunner } from '../runner/runner.ts';
import type { RemoteState } from '../runner/runner.ts';
import type { Account } from '../runner/snapshot.ts';
import type { RemoteHost } from '../runner/host.ts';
import { Unreachable } from '../runner/host.ts';
import { openLedger } from '../service/ledger.ts';
import type { RestoreHooks } from '../service/restore.ts';
import { restoreBackup } from '../service/restore.ts';
import { fixture, USER, RUNNER_TUNED, testMachine } from './helpers.ts';
import type { Fixture } from './helpers.ts';
import { memoryLogins, memoryMachines } from './helpers.ts';

const RESTORE = join(import.meta.dirname, '..', 'service', 'restore.ts');
const HOLD = '恢复自备份，待确认';

class Crash extends Error {}

// A backup on one side, a data directory with a newer ledger on the other.
function setup(f: Fixture) {
  const backups = join(f.dir, 'backups');
  const dataDir = join(f.dir, 'data');
  mkdirSync(backups);
  mkdirSync(dataDir);
  for (const side of ['', '-wal', '-shm']) {
    if (existsSync(f.path + side)) copyFileSync(f.path + side, join(backups, `ledger.db${side}`));
  }
  const newer = openLedger(join(dataDir, 'ledger.db'));
  const projectId = newer.createProject({ name: '新账本才有的' }, USER);
  newer.close();
  const open = () => f.open({}, join(dataDir, 'ledger.db'));
  return { backups, dataDir, projectId, open };
}

function content(f: Fixture) {
  const running = f.runningRun();
  const queued = f.queuedTask();
  const timer = f.queuedTask();
  f.ledger.scheduleWake(timer.id, '2020-01-01T00:00:00Z', USER);
  const held = f.queuedTask();
  f.ledger.holdTask(held.id, '人工停住的', USER);
  const processing = f.ledger.receiveMessage({ channel: 'console', externalId: 'p', actor: 'user', text: '处理中的', projectId: f.projectId });
  const received = f.ledger.receiveMessage({ channel: 'console', externalId: 'r', actor: 'user', text: '收到的', projectId: f.projectId });
  f.ledger.takeNextTurn(f.projectId);
  const notice = f.ledger.outbox.enqueue('wecom', 'markdown', { text: '旧通知' });
  return { running, queued, timer, held, received, processing, notice };
}

test('the sealing is complete, counted, and the old ledger is kept', (t) => {
  const f = fixture(t);
  const made = content(f);
  const lastChange = f.peek<{ at: string }>('SELECT at FROM change ORDER BY seq DESC LIMIT 1')[0]!.at;
  const { backups, dataDir, projectId, open } = setup(f);

  const result = restoreBackup(dataDir, backups);
  assert.deepEqual(
    [result.active_runs, result.held_tasks, result.unverified_messages, result.given_up_notifications, result.backup_at],
    [1, 2, 2, 1, lastChange],
  );
  assert.equal(existsSync(join(dataDir, 'lock')), false);
  assert.equal(existsSync(join(dataDir, 'ledger.restoring.db')), false);
  const kept = openLedger(result.kept!);
  assert.deepEqual(kept.listProjects().map(({ id }) => id), [projectId], '原账本要原样留着');
  kept.close();

  const ledger = open();
  assert.equal(ledger.dispatchConditions().paused, true);
  for (const { id } of [made.queued, made.timer]) {
    const task = ledger.getTask(id);
    assert.deepEqual([task.state, task.reason, task.wake_at], ['held', HOLD, null]);
  }
  assert.equal(ledger.getTask(made.held.id).reason, '人工停住的', '原本就停住的任务不用再确认');
  assert.deepEqual(ledger.restoreHeldTasks().map(({ id }) => id), [made.queued.id, made.timer.id]);
  assert.equal(ledger.getMessage(made.received.id).state, 'unverified');
  assert.equal(ledger.getMessage(made.processing.id).state, 'unverified');
  const [notice] = ledger.outbox.listGivenUp();
  assert.deepEqual([notice?.id, notice?.error], [made.notice.id, '恢复自备份']);
  const mark = ledger.getRestore()!;
  assert.equal(mark.from, backups);
  assert.equal(mark.backup_at, lastChange);
  assert.ok(mark.restored_at > lastChange);
  assert.deepEqual(mark.run_ids, [made.running.run.id]);
  const conn = new DatabaseSync(join(dataDir, 'ledger.db'), { readOnly: true });
  const [restored] = conn.prepare(`SELECT count(*) AS n FROM change WHERE action = 'ledger.restore'`).all();
  conn.close();
  assert.equal(restored?.n, 1);
});

test('a backup with an unmerged -wal keeps what is in it, and the result stands alone', (t) => {
  const f = fixture(t);
  // Left unmerged on purpose: the fixture's connection is still open when this is copied.
  const task = f.queuedTask();
  assert.ok(existsSync(`${f.path}-wal`), '这一条要的是带 -wal 的备份');
  const { backups, dataDir, open } = setup(f);
  restoreBackup(dataDir, join(backups, 'ledger.db'));
  assert.equal(existsSync(join(dataDir, 'ledger.db-wal')), false, '准备库要自包含');
  const ledger = open();
  assert.equal(ledger.getTask(task.id).state, 'held');
});

test('a running service is not replaced', (t) => {
  const f = fixture(t);
  f.queuedTask();
  const { backups, dataDir, projectId, open } = setup(f);
  writeFileSync(join(dataDir, 'lock'), JSON.stringify({ pid: process.pid, started_at: 'now' }));
  assert.throws(() => restoreBackup(dataDir, backups), /正在运行/);
  const ledger = open();
  assert.deepEqual(ledger.listProjects().map(({ id }) => id), [projectId]);
  assert.equal(ledger.getRestore(), null);
});

test('what is not a usable backup changes nothing', (t) => {
  const f = fixture(t);
  const { dataDir, projectId, open, backups } = setup(f);
  const junk = join(backups, 'junk.db');
  writeFileSync(junk, 'not a database, by far long enough to look like one at a glance'.repeat(30));
  assert.throws(() => restoreBackup(dataDir, junk));
  assert.throws(() => restoreBackup(dataDir, join(backups, 'missing')), /找不到备份/);
  assert.equal(existsSync(join(dataDir, 'lock')), false);
  const ledger = open();
  assert.deepEqual(ledger.listProjects().map(({ id }) => id), [projectId]);
});

const notLedgers: [string, (file: string) => void][] = [
  ['零字节的文件', (file) => writeFileSync(file, '')],
  ['只有页头的空库', (file) => {
    const conn = new DatabaseSync(file);
    conn.exec('PRAGMA journal_mode=WAL');
    conn.close();
  }],
  ['别的程序的库', (file) => {
    const conn = new DatabaseSync(file);
    conn.exec('CREATE TABLE task (id TEXT)');
    conn.close();
  }],
  ['只有版本号、没有业务表的库', (file) => {
    const conn = new DatabaseSync(file);
    conn.exec('CREATE TABLE setting (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, key TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL)');
    conn.exec(`INSERT INTO setting VALUES ('s1', 'now', 'schema_version', '4')`);
    conn.close();
  }],
  ['少了一张业务表的账本', (file) => {
    openLedger(file).close();
    const conn = new DatabaseSync(file);
    conn.exec('DROP TABLE input');
    conn.close();
  }],
];
for (const [name, make] of notLedgers) {
  test(`拿${name}来恢复：拒绝并说明，现有账本不动，不封存也不另存`, (t) => {
    const f = fixture(t);
    const { dataDir, projectId, open, backups } = setup(f);
    const input = join(backups, 'empty.db');
    make(input);
    const before = readFileSync(input);
    assert.throws(() => restoreBackup(dataDir, input), /不是 tycho 账本/);
    assert.deepEqual(readdirSync(dataDir).filter((file) => !/^ledger\.db(-wal|-shm)?$/.test(file)), [], '不留准备库，不另存现有账本，不留锁');
    assert.deepEqual(readFileSync(input), before, '拿来的文件原样不动');
    const ledger = open();
    assert.deepEqual(ledger.listProjects().map(({ id }) => id), [projectId]);
    assert.equal(ledger.getRestore(), null);
  });
}

const crashes: [string, RestoreHooks, boolean][] = [
  ['替换前', { beforeReplace() { throw new Crash(); } }, false],
  ['替换后', { afterReplace() { throw new Crash(); } }, true],
];
for (const [name, hooks, replaced] of crashes) {
  test(`restore 崩溃在${name}：账本文件一直在，要么原样，要么已封存`, (t) => {
    const f = fixture(t);
    const made = content(f);
    const { backups, dataDir, projectId, open } = setup(f);
    assert.throws(() => restoreBackup(dataDir, backups, hooks), Crash);
    assert.ok(existsSync(join(dataDir, 'ledger.db')));
    const ledger = open();
    if (replaced) {
      assert.equal(ledger.dispatchConditions().paused, true);
      assert.equal(ledger.getTask(made.queued.id).state, 'held');
    } else {
      assert.equal(ledger.dispatchConditions().paused, false);
      assert.equal(ledger.getRestore(), null);
      assert.deepEqual(ledger.listProjects().map(({ id }) => id), [projectId]);
    }
    ledger.close();
    // The command can simply be run again.
    assert.equal(restoreBackup(dataDir, backups).held_tasks, 2);
    assert.equal(existsSync(join(dataDir, 'ledger.restoring.db')), false);
  });
}

test('the old -wal of a ledger that cannot be merged is kept, and not replayed onto the restored file', (t) => {
  const f = fixture(t);
  const made = content(f);
  const { backups, dataDir, open } = setup(f);
  writeFileSync(join(dataDir, 'ledger.db'), 'not a database, and long enough that SQLite says so'.repeat(100));
  writeFileSync(join(dataDir, 'ledger.db-wal'), 'old frames');
  const { kept } = restoreBackup(dataDir, backups);
  assert.equal(existsSync(`${kept}-wal`), true);
  assert.equal(existsSync(join(dataDir, 'ledger.db-wal')), false);
  const ledger = open();
  assert.equal(ledger.getTask(made.queued.id).state, 'held');
});

test('the orphan count reports per host, skips what the ledger knows, and never turns a failure into none', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  // Each machine's own login: the inventory asks every machine any login may use once.
  const account = (id: string, host: string): Account => ({ id: `${host}/${id}`, name: `${host}/${id}`, executor: id, machine: host, tiers: {} });
  const stateOf = (fields: object): RemoteState => ({ started: true, launcher_alive: false, pid_alive: false, marked: false, exit: null, unknown: null, ...fields });
  const listed = [`welcome two words`, `tycho-run ${run.task_id} ${run.id}`, 'tycho-run t9 alive', 'tycho-run t9 gone', 'tycho-run t9 starting'].join('\n');
  const listings: Record<string, number> = {};
  const host = (name: string): RemoteHost => ({
    place: async () => [],
    start: async () => ({ code: 0, stdout: '', stderr: '' }),
    stop: async () => {},
    async state(runDir) {
      const fields = { alive: { pid_alive: true }, gone: {}, starting: { launcher_alive: true } }[basename(runDir)];
      return stateOf(fields!);
    },
    async list() {
      listings[name] = (listings[name] ?? 0) + 1;
      if (name === 'down') throw new Unreachable('连不上实例');
      if (name === 'broken') throw new Unreachable('没有权限');
      // A login shell may print first, so only the marked lines are Runs.
      return listed.split('\n').flatMap((line) => {
        const [, task_id, run_id] = /^tycho-run (\S+) (\S+)$/.exec(line.trim()) ?? [];
        return task_id && run_id ? [{ task_id, run_id }] : [];
      });
    },
    async artifacts() {
      return [];
    },
    async dropRun() {},
    connected: () => true,
    readRange: async () => ({ bytes: Buffer.alloc(0), size: 0, mtime: 0 }),
  });
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger,
    adapters: {},
    machines: memoryMachines(Object.fromEntries(['up','down','broken'].map(id=>[id,testMachine(id)]))),
    logins: memoryLogins({ a: account('a', 'up'), b: account('b', 'up'), c: account('c', 'down'), d: account('d', 'broken') }),
    connect: (machine) => host(machine.host),
  });
  const [up, down, broken, ...rest] = await runner.inventoryOrphans();
  assert.deepEqual(rest, []);
  assert.deepEqual(listings, { up: 1, down: 1, broken: 1 }, '同一台主机只数一遍');
  assert.deepEqual(up, {
    machine_id: 'up',
    host: 'up',
    runs: [
      { task_id: 't9', run_id: 'alive', alive: true },
      { task_id: 't9', run_id: 'gone', alive: false },
      { task_id: 't9', run_id: 'starting', alive: true },
    ],
  });
  assert.deepEqual([down?.runs, down?.error], [null, '连不上实例']);
  assert.equal(broken?.runs, null);
  assert.match(broken?.error ?? '', /没有权限/);
});

test('npm run restore prints the inventory and points at the overview', (t) => {
  const f = fixture(t);
  content(f);
  const { backups, dataDir } = setup(f);
  const result = spawnSync(process.execPath, [RESTORE, '--from', backups], { env: { ...process.env, TYCHO_DATA: dataDir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /未结束的 Run：1 个/);
  assert.match(result.stdout, /被停住的任务：2 个/);
  assert.match(result.stdout, /置为待核实的消息：2 条/);
  assert.match(result.stdout, /停止重试的通知：1 条/);
  assert.match(result.stdout, /启动服务后在总览里逐项确认/);
  assert.equal(readdirSync(dataDir).filter((name) => name.startsWith('ledger.before-restore-')).length, 1);

  const bare = spawnSync(process.execPath, [RESTORE], { env: { ...process.env, TYCHO_DATA: dataDir }, encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /用法/);
});
