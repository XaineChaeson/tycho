// Guards against a backup that cannot save anyone: one that loses commits still in the
// -wal, a half-written directory passing for a backup or costing the good one, a crash
// during replacement leaving no backup, a damaged copy accepted, one unreadable log failing
// the whole night, cleanup touching what is not ours or deleting the last backup, a
// schedule that drifts or misses a day after downtime, two backups at once, a restored
// ledger overwriting the good backup, and a stop that abandons or outlives a backup.
// And against the backup disk costing more than a backup: a directory of the owner's
// replaced or deleted because of its name, a restored ledger published because its mark
// could not be read, a backup directory inside runs/ copying itself, an empty file passing
// for a ledger, a tidy at start deleting a backup in progress, a second failure on one day
// going unsaid, and a disk that is not there keeping the service down or going unreported.
// And a copy that carries a ledger's version without its tables being published as a
// backup, and the cleanup taking the copy an upgrade kept beside the ledger.
// The last tests go through a whole service.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BackupClock, BackupConfig, BackupHooks, BackupOptions, BackupReport, BackupResult } from '../service/backup.ts';
import { backupDirProblem, createBackups } from '../service/backup.ts';
import { createAccounts } from '../service/accounts.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { openLedger } from '../service/ledger.ts';
import { createNotify } from '../service/notify.ts';
import { restoreBackup } from '../service/restore.ts';
import type { Settings } from '../service/settings.ts';
import { backupConfig, createSettings } from '../service/settings.ts';
import { fixture, USER, freePort } from './helpers.ts';
import type { Fixture } from './helpers.ts';
import { signIn, stage, until } from './stage.ts';

class Crash extends Error {}

const local = (day: number, hour = 12, minute = 0, month = 10): number => new Date(2026, month, day, hour, minute).getTime();
const NOON = local(5);
const TODAY = '2026-11-05';
const MARK = '.tycho-backup';

function fakeClock(start = NOON) {
  let now = start;
  const pending: { run: () => void; due: number; cleared: boolean }[] = [];
  const clock: BackupClock = {
    now: () => now,
    setTimer(run, ms) {
      const timer = { run, due: now + ms, cleared: false };
      pending.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) (timer as { cleared: boolean }).cleared = true;
    },
  };
  return {
    clock,
    set(at: number) {
      now = at;
    },
    timers: () => pending.filter(({ cleared }) => !cleared),
    // Runs what is due, then lets everything it started finish.
    async fire(done: () => boolean) {
      const timer = pending.filter(({ cleared }) => !cleared).at(-1)!;
      now = timer.due;
      timer.cleared = true;
      timer.run();
      for (let i = 0; i < 2000 && !done(); i += 1) await sleep(2);
    },
  };
}

function tune(settings: Settings, { dir, at, keepDays }: Partial<BackupConfig>): void {
  if (dir !== undefined) settings.set('backup.dir', dir, USER);
  if (at !== undefined) settings.set('backup.at', at, USER);
  if (keepDays !== undefined) settings.set('backup.keepDays', keepDays, USER);
}

// What the owner does on the settings page, for a service that is about to start.
function backupIn(dataDir: string, dir: string): Record<string, never> {
  const ledger = openLedger(join(dataDir, 'ledger.db'));
  tune(createSettings({ ledger }), { dir });
  ledger.close();
  return {};
}

function setup(t: TestContext, fields: { config?: Partial<BackupConfig>; hooks?: BackupHooks; start?: number; f?: Fixture; options?: Partial<BackupOptions> } = {}) {
  const f = fields.f ?? fixture(t);
  const dir = join(f.dir, 'backups');
  mkdirSync(dir, { recursive: true });
  const time = fakeClock(fields.start);
  const logs: string[] = [];
  const failures: unknown[][] = [];
  const barrier = { recovering: false };
  const settings = createSettings({ ledger: f.ledger });
  tune(settings, { dir, ...fields.config });
  const make = (hooks: BackupHooks = fields.hooks ?? {}) =>
    createBackups({
      dataDir: f.dir,
      config: () => backupConfig(settings),
      ledger: f.ledger,
      recovering: () => barrier.recovering,
      onFailure: (...args) => failures.push(args),
      clock: time.clock,
      hooks,
      log: (line) => logs.push(line),
      ...fields.options,
    });
  return { f, dir, time, logs, failures, barrier, settings, make, backups: make() };
}

const report = (dir: string, day: string): BackupReport => JSON.parse(readFileSync(join(dir, day, 'backup.json'), 'utf8')) as BackupReport;
const ok = (result: BackupResult): BackupReport => {
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result;
};

function oldBackup(dir: string, day: string, at = `${day}T00:00:00.000Z`): string {
  const path = join(dir, day);
  mkdirSync(path);
  writeFileSync(join(path, 'backup.json'), JSON.stringify({ at, ledger_bytes: 1, runs_files: 0, runs_incomplete: [], tool: 'backup' }));
  return path;
}

test('what a backup makes goes straight into the restore command, commits in the -wal included', async (t) => {
  const { f, dir, backups } = setup(t);
  const task = f.queuedTask();
  const { id: messageId } = f.ledger.receiveMessage({ channel: 'console', externalId: 'b1', actor: 'user', text: '备份里的消息' });
  assert.ok(existsSync(`${f.path}-wal`), '这一条要的是账本还有没合并的 -wal');

  const result = ok(await backups.trigger());

  const formal = join(dir, TODAY);
  assert.deepEqual(readdirSync(formal).sort(), [MARK, 'backup.json', 'ledger.db'], '备份目录不能带 -wal、-shm');
  assert.deepEqual(readdirSync(dir), [TODAY]);
  assert.deepEqual(report(dir, TODAY), { at: new Date(NOON).toISOString(), ledger_bytes: result.ledger_bytes, runs_files: 0, runs_incomplete: [], tool: 'backup' });
  assert.ok(result.ledger_bytes > 0);

  const dataDir = join(f.dir, 'restored');
  mkdirSync(dataDir);
  const restored = restoreBackup(dataDir, formal);
  assert.equal(restored.held_tasks, 1);
  const ledger = f.open({}, join(dataDir, 'ledger.db'));
  assert.equal(ledger.getTask(task.id).title, task.title);
  assert.equal(ledger.getMessage(messageId).text, '备份里的消息');
});

test('restored accounts report missing credentials until replaced', async (t) => {
  const { f, dir, backups } = setup(t);
  const options = { executors: { codex: codexAdapter }, credentialExecutors: ['codex'] };
  const accounts = createAccounts({ ...options, ledger: f.ledger, dataDir: f.dir });
  const { account } = accounts.put({ executor: 'codex', tiers: { execute: { kind: 'content', text: 'model = "m"' } }, credential: 'first-secret' }, USER);
  ok(await backups.trigger());
  const restoredDir = join(f.dir, 'restored-credentials');
  mkdirSync(restoredDir);
  restoreBackup(restoredDir, join(dir, TODAY));
  const ledger = f.open({}, join(restoredDir, 'ledger.db'));
  const restored = createAccounts({ ...options, ledger, dataDir: restoredDir });
  assert.equal(restored.credentialOf(account.id), undefined);
  assert.equal(restored.get(account.id)?.credential, 'missing');
  restored.setCredential(account.id, 'replacement-secret', USER);
  assert.equal(restored.get(account.id)?.credential, 'set');
  assert.equal(restored.credentialOf(account.id)?.value, 'replacement-secret');
});

test('a backup writes nothing to the ledger', async (t) => {
  const { f, backups } = setup(t);
  f.queuedTask();
  const before = f.dump();
  ok(await backups.trigger());
  assert.deepEqual(f.dump(), before);
});

const midway: [string, BackupHooks][] = [
  ['账本备份之后', { afterLedger() { throw new Crash('写盘失败'); } }],
  ['改名之前', { beforeInstall() { throw new Crash('写盘失败'); } }],
];
for (const [name, hooks] of midway) {
  test(`失败在${name}：只留 .partial，昨天的备份原样在，下一次清掉 .partial`, async (t) => {
    const { dir, make, backups } = setup(t, { hooks });
    oldBackup(dir, '2026-11-04');
    const before = readFileSync(join(dir, '2026-11-04', 'backup.json'), 'utf8');

    const result = await backups.trigger();
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(dir, TODAY)), false, '半成品不能算正式目录');
    assert.equal(existsSync(join(dir, `${TODAY}.partial`)), true);
    assert.equal(readFileSync(join(dir, '2026-11-04', 'backup.json'), 'utf8'), before);
    const view = backups.status();
    assert.ok(view.configured);
    assert.equal(view.last_ok_at, '2026-11-04T00:00:00.000Z', '.partial 不算成功');

    ok(await make({}).trigger());
    assert.deepEqual(readdirSync(dir).sort(), ['2026-11-04', TODAY]);
  });
}

test('a ledger that cannot be read fails the backup and says so', async (t) => {
  const f = fixture(t);
  const dataDir = join(f.dir, 'empty');
  mkdirSync(dataDir);
  const { dir, backups } = setup(t, { f, options: { dataDir } });
  const result = await backups.trigger();
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(dir, TODAY)), false);
  assert.equal(existsSync(join(dataDir, 'ledger.db')), false, '备份不能顺手建出一个空账本');
  assert.deepEqual(readdirSync(join(dir, `${TODAY}.partial`)), [MARK], '归属标识要在任何别的东西之前写下');
  assert.match(readFileSync(join(dir, `${TODAY}.partial`, MARK), 'utf8'), /tycho-backup/);
  const view = backups.status();
  assert.ok(view.configured);
  assert.equal(view.last_error?.at, new Date(NOON).toISOString());
  assert.match(view.last_error?.text ?? '', /unable to open/);
});

test('a second backup on the same day replaces the first', async (t) => {
  const { f, dir, time, backups } = setup(t);
  ok(await backups.trigger());
  const task = f.queuedTask();
  time.set(NOON + 60_000);
  ok(await backups.trigger());
  assert.deepEqual(readdirSync(dir), [TODAY]);
  assert.equal(report(dir, TODAY).at, new Date(NOON + 60_000).toISOString());
  assert.equal(f.open({}, join(dir, TODAY, 'ledger.db')).getTask(task.id).title, task.title);
});

test('a crash between the two renames still leaves a whole backup at the next start', async (t) => {
  const { f, dir, make, time } = setup(t);
  ok(await make({}).trigger());
  const first = report(dir, TODAY);
  f.queuedTask();
  time.set(NOON + 60_000);
  const result = await make({ afterPark() { throw new Crash('断电'); } }).trigger();
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(dir, TODAY)), false);
  assert.equal(existsSync(join(dir, `${TODAY}.old`)), true);

  await make({}).start();
  assert.deepEqual(report(dir, TODAY), first, '旧的完整备份要回到原位');
  assert.deepEqual(readdirSync(dir), [TODAY]);
});

test('a crash after the new backup arrived drops the .old and keeps the new one', async (t) => {
  const { dir, make } = setup(t);
  // After today's 03:30 by this machine's clock, whatever its time zone: no catch-up runs.
  const kept = new Date(local(5, 4)).toISOString();
  oldBackup(dir, TODAY, kept);
  oldBackup(dir, `${TODAY}.old`, new Date(local(5, 3, 45)).toISOString());
  await make({}).start();
  assert.deepEqual(readdirSync(dir), [TODAY]);
  assert.equal(report(dir, TODAY).at, kept);
});

test('an .old of ours that is not a whole backup is dropped, not put in place as one', async (t) => {
  const { dir, make } = setup(t, { start: local(5, 2) });
  oldBackup(dir, '2026-11-04', new Date(local(4, 3, 31)).toISOString());
  mkdirSync(join(dir, `${TODAY}.old`));
  writeFileSync(join(dir, `${TODAY}.old`, MARK), 'tycho-backup');
  const backups = make({});
  await backups.start();
  assert.deepEqual(readdirSync(dir), ['2026-11-04']);
  await backups.stop(0);
});

test('a rename that fails puts the previous backup back', async (t) => {
  const { dir, make, time } = setup(t);
  ok(await make({}).trigger());
  const first = report(dir, TODAY);
  time.set(NOON + 60_000);
  const result = await make({
    // With its source gone the rename fails, here as on any platform.
    afterPark() {
      rmSync(join(dir, `${TODAY}.partial`), { recursive: true });
    },
  }).trigger();
  assert.equal(result.ok, false);
  assert.deepEqual(report(dir, TODAY), first);
  assert.equal(existsSync(join(dir, `${TODAY}.old`)), false);
});

test('a copy that fails its integrity check is no backup', async (t) => {
  const { dir, backups } = setup(t, {
    hooks: {
      afterLedger(file) {
        const fd = openSync(file, 'r+');
        writeSync(fd, Buffer.alloc(4096 * 4, 0xee), 0, 4096 * 4, 4096 * 2);
        closeSync(fd);
      },
    },
  });
  const result = await backups.trigger();
  assert.equal(result.ok, false);
  assert.equal(existsSync(join(dir, TODAY)), false);
});

test('a log that cannot be read is reported and does not fail the backup', async (t) => {
  const { f, dir, backups } = setup(t, {
    hooks: {
      async copyRun(from, to) {
        if (from.endsWith('bad.log')) throw new Error('EBUSY');
        writeFileSync(to, readFileSync(from));
      },
    },
  });
  mkdirSync(join(f.dir, 'runs', 'r1'), { recursive: true });
  writeFileSync(join(f.dir, 'runs', 'r1', 'good.log'), '全的');
  writeFileSync(join(f.dir, 'runs', 'r1', 'bad.log'), '读不出');
  writeFileSync(join(f.dir, 'runs', 'top.log'), '顶层');

  const result = ok(await backups.trigger());
  assert.equal(result.runs_files, 2);
  assert.deepEqual(result.runs_incomplete, ['r1/bad.log']);
  assert.equal(readFileSync(join(dir, TODAY, 'runs', 'r1', 'good.log'), 'utf8'), '全的');
  const view = backups.status();
  assert.ok(view.configured && view.last_ok_incomplete);
  assert.equal(view.last_error, null);
});

test('the report lists at most twenty unreadable logs and still says it is incomplete', async (t) => {
  const { f, backups } = setup(t, { hooks: { copyRun: async () => { throw new Error('EBUSY'); } } });
  mkdirSync(join(f.dir, 'runs'));
  for (let i = 0; i < 25; i += 1) writeFileSync(join(f.dir, 'runs', `${i}.log`), '');
  const result = ok(await backups.trigger());
  assert.equal(result.runs_incomplete.length, 20);
});

test('real logs are copied while they are still open for writing', async (t) => {
  const { f, dir, backups } = setup(t);
  mkdirSync(join(f.dir, 'runs'));
  const fd = openSync(join(f.dir, 'runs', 'growing.log'), 'w');
  t.after(() => closeSync(fd));
  writeSync(fd, '写到一半');
  ok(await backups.trigger());
  assert.equal(readFileSync(join(dir, TODAY, 'runs', 'growing.log'), 'utf8'), '写到一半');
});

test('cleanup removes what expired and nothing else', async (t) => {
  const { dir, backups } = setup(t, { config: { keepDays: 3 } });
  const expired = oldBackup(dir, '2026-11-01');
  const edge = oldBackup(dir, '2026-11-02');
  const invalidDate = join(dir, '2026-02-30');
  const noReport = join(dir, '2026-10-01');
  const foreign = join(dir, 'photos-2026');
  for (const path of [invalidDate, noReport, foreign]) mkdirSync(path);
  writeFileSync(join(invalidDate, 'backup.json'), '{"at":"2026-01-01T00:00:00Z"}');
  writeFileSync(join(dir, '2026-10-02'), '同名的文件');

  ok(await backups.trigger());
  assert.equal(existsSync(expired), false, '超期的要删');
  assert.equal(existsSync(edge), true, '正好 keepDays 天的不算超期');
  for (const path of [invalidDate, noReport, foreign, join(dir, '2026-10-02')]) assert.equal(existsSync(path), true, path);
});

test('cleanup leaves the copy an upgrade kept in the data directory, however old', async (t) => {
  // The backup directory is inside the data directory here, the closest the two can be.
  const { f, dir, backups } = setup(t, { config: { keepDays: 3 } });
  const copy = join(f.dir, 'ledger.before-v5.db');
  writeFileSync(copy, '升级前的账本');
  const expired = oldBackup(dir, '2026-10-01');
  ok(await backups.trigger());
  assert.equal(existsSync(expired), false, '清理确实跑过');
  assert.equal(readFileSync(copy, 'utf8'), '升级前的账本');
  assert.deepEqual(readdirSync(join(dir, TODAY)).sort(), [MARK, 'backup.json', 'ledger.db'], '它也不进每日备份');
});

test('a failed night cleans nothing away', async (t) => {
  const { dir, backups } = setup(t, { config: { keepDays: 3 }, hooks: { beforeInstall() { throw new Crash('写盘失败'); } } });
  oldBackup(dir, '2026-10-01');
  oldBackup(dir, '2026-10-02');
  await backups.trigger();
  assert.equal(existsSync(join(dir, '2026-10-01')), true);
  assert.equal(existsSync(join(dir, '2026-10-02')), true);
});

test('the newest complete backup stays even when it has expired', async (t) => {
  const { dir, backups } = setup(t, {
    config: { keepDays: 3 },
    // Today's has no readable report, so the newest that counts is an expired one.
    hooks: {
      beforeInstall() {
        writeFileSync(join(dir, `${TODAY}.partial`, 'backup.json'), '坏的');
      },
    },
  });
  const older = oldBackup(dir, '2026-10-01');
  const newest = oldBackup(dir, '2026-10-02');
  ok(await backups.trigger());
  assert.equal(existsSync(older), false);
  assert.equal(existsSync(newest), true);
});

test('a cleanup that fails costs nothing but a log line', async (t) => {
  const { dir, logs, backups } = setup(t, {
    config: { keepDays: 3 },
    hooks: { removeExpired: async () => { throw new Error('被占用'); } },
  });
  const expired = oldBackup(dir, '2026-11-01');
  ok(await backups.trigger());
  assert.equal(existsSync(expired), true);
  assert.equal(existsSync(join(dir, TODAY)), true);
  assert.ok(logs.some((line) => line.includes('删不掉')));
});

test('the timer waits for the moment, runs, then aims at the next day by the calendar', async (t) => {
  const { dir, time, backups } = setup(t, { start: local(5, 12) });
  oldBackup(dir, TODAY, new Date(local(5, 3, 30)).toISOString());
  await backups.start();
  assert.deepEqual(readdirSync(dir), [TODAY], '还没到时间不跑');
  assert.equal(time.timers().length, 1);
  assert.equal(time.timers()[0]!.due, local(6, 3, 30));

  await time.fire(() => time.timers().length === 1);
  assert.equal(report(dir, '2026-11-06').at, new Date(local(6, 3, 30)).toISOString());
  assert.equal(time.timers()[0]!.due, local(7, 3, 30));
  await backups.stop(0);
});

test('across a daylight saving change the moment stays the same on the clock', async (t) => {
  // Deleting TZ does not bring the machine's zone back, so it is named.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    process.env.TZ = zone;
  });
  const { dir, time, backups } = setup(t, { start: new Date(2026, 2, 7, 1).getTime() });
  oldBackup(dir, '2026-03-06', new Date(2026, 2, 6, 3, 31).toISOString());
  await backups.start();
  const first = time.timers()[0]!.due;
  assert.equal(first, new Date(2026, 2, 7, 3, 30).getTime());
  await time.fire(() => time.timers().length === 1);
  assert.equal(time.timers()[0]!.due - first, 23 * 3_600_000, '这天只有 23 小时，固定 24 小时会漂到 04:30');
  await backups.stop(0);
});

test('a moment later today is today, one already gone is tomorrow', async (t) => {
  const { time, make } = setup(t, { start: local(5, 2) });
  const backups = make();
  await backups.start();
  assert.equal(time.timers()[0]!.due, local(5, 3, 30));
  await backups.stop(0);
});

const catchUps: [string, (dir: string) => void, number, boolean][] = [
  ['从未备份', () => {}, local(5, 12), true],
  ['最新的早于最近一个时刻', (dir) => oldBackup(dir, '2026-11-04', new Date(local(4, 3, 30)).toISOString()), local(5, 12), true],
  ['最新的晚于最近一个时刻', (dir) => oldBackup(dir, TODAY, new Date(local(5, 3, 31)).toISOString()), local(5, 12), false],
  ['时刻还没到，昨天的算数', (dir) => oldBackup(dir, '2026-11-04', new Date(local(4, 3, 31)).toISOString()), local(5, 2), false],
];
for (const [name, prepare, start, runs] of catchUps) {
  test(`启动补做：${name}`, async (t) => {
    const { dir, backups, time } = setup(t, { start });
    prepare(dir);
    const before = readdirSync(dir).length;
    await backups.start();
    if (runs) assert.equal(report(dir, TODAY).at, new Date(start).toISOString());
    else assert.equal(readdirSync(dir).length, before);
    assert.equal(time.timers().length, 1, '补做之外照常排定时');
    await backups.stop(0);
  });
}

test('a start with the backup disk gone comes up, says so, and creates nothing in its place', async (t) => {
  const { dir, failures, backups } = setup(t);
  rmSync(dir, { recursive: true });
  await backups.start();
  assert.deepEqual(failures.map(([reason]) => reason), [`备份目录不存在：${dir}`], '整理和补做是同一件事坏了，只说一次');
  const view = backups.status();
  assert.ok(view.configured);
  assert.equal(view.last_error?.text, `备份目录不存在：${dir}`);
  const result = await backups.trigger();
  assert.equal(result.ok ? '' : result.error, `备份目录不存在：${dir}`);
  assert.equal(existsSync(dir), false, '挂载点不在时自己建目录，会写到错的盘上');
  assert.equal(failures.length, 1);
  await backups.stop(0);
});

test('with the disk gone and a restored ledger holding the catch-up back, the owner still hears of it', async (t) => {
  const f = fixture(t);
  const { dir, time, make } = setup(t, { f });
  ok(await make({}).trigger());
  const dataDir = join(f.dir, 'data');
  mkdirSync(dataDir);
  restoreBackup(dataDir, join(dir, TODAY));
  rmSync(dir, { recursive: true });
  const failures: unknown[][] = [];
  const backups = createBackups({
    dataDir,
    config: () => ({ dir, at: '03:30', keepDays: 14 }),
    ledger: f.open({}, join(dataDir, 'ledger.db')),
    recovering: () => false,
    onFailure: (...args) => failures.push(args),
    clock: time.clock,
    log: () => {},
  });
  await backups.start();
  const view = backups.status();
  assert.ok(view.configured);
  assert.equal(view.last_error?.text, `备份目录不存在：${dir}`);
  assert.deepEqual(failures.map(([reason]) => reason), [`备份目录不存在：${dir}`]);
  await backups.stop(0);
});

test('a backup in progress is shared, not repeated', async (t) => {
  const hold = Promise.withResolvers<void>();
  let copies = 0;
  const { backups } = setup(t, { hooks: { afterLedger() { copies += 1; return hold.promise; } } });
  const first = backups.trigger();
  const second = backups.trigger();
  assert.equal(first, second);
  const view = backups.status();
  assert.ok(view.configured && view.running);
  hold.resolve();
  assert.deepEqual(await second, await first);
  assert.equal(copies, 1);
  const after = backups.status();
  assert.ok(after.configured && !after.running);
});

test('the timer joins a backup already running', async (t) => {
  const hold = Promise.withResolvers<void>();
  let copies = 0;
  const { dir, time, backups } = setup(t, { hooks: { afterLedger() { copies += 1; return hold.promise; } } });
  oldBackup(dir, TODAY, new Date(local(5, 3, 30)).toISOString());
  await backups.start();
  const manual = backups.trigger();
  const fired = time.fire(() => time.timers().length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  hold.resolve();
  await Promise.all([manual, fired]);
  assert.equal(copies, 1);
  await backups.stop(0);
});

test('nothing runs behind the recovery barrier, and leaving it catches up', async (t) => {
  const { dir, time, barrier, backups } = setup(t);
  barrier.recovering = true;
  await backups.start();
  assert.deepEqual(readdirSync(dir), []);
  assert.throws(() => backups.trigger(), /恢复清点/);
  await time.fire(() => time.timers().length === 1);
  assert.deepEqual(readdirSync(dir), [], '定时也要跳过');
  barrier.recovering = false;
  await backups.catchUp();
  assert.ok(readdirSync(dir).length === 1);
  await backups.stop(0);
});

test('a restored ledger waiting for confirmation does not overwrite the good backup', async (t) => {
  const f = fixture(t);
  f.queuedTask();
  const { dir, time, make } = setup(t, { f });
  ok(await make({}).trigger());
  const before = readFileSync(join(dir, TODAY, 'ledger.db'));

  const dataDir = join(f.dir, 'data');
  mkdirSync(dataDir);
  restoreBackup(dataDir, join(dir, TODAY));
  const ledger = f.open({}, join(dataDir, 'ledger.db'));
  const settings = createSettings({ ledger });
  tune(settings, { dir });
  const backups = createBackups({
    dataDir,
    config: () => backupConfig(settings),
    ledger,
    recovering: () => false,
    clock: time.clock,
    log: () => {},
  });
  // Stale enough that only the mark holds the catch-up back.
  writeFileSync(join(dir, TODAY, 'backup.json'), JSON.stringify({ ...report(dir, TODAY), at: '2026-11-01T00:00:00.000Z' }));
  await backups.start();
  assert.throws(() => backups.trigger(), /还没确认清点/);
  await time.fire(() => time.timers().length === 1);
  assert.deepEqual(readFileSync(join(dir, TODAY, 'ledger.db')), before);
  assert.equal(existsSync(join(dir, '2026-11-06')), false, '定时也不跑');
  await backups.stop(0);
});

test('stop clears the timer and refuses what comes after', async (t) => {
  const { time, backups, dir } = setup(t);
  oldBackup(dir, TODAY, new Date(local(5, 3, 31)).toISOString());
  await backups.start();
  assert.equal(time.timers().length, 1);
  assert.equal(await backups.stop(0), true);
  assert.equal(time.timers().length, 0);
  assert.throws(() => backups.trigger(), /正在停止/);
});

test('stop waits for a backup in progress', async (t) => {
  const hold = Promise.withResolvers<void>();
  const { dir, backups } = setup(t, { hooks: { afterLedger: () => hold.promise } });
  const running = backups.trigger();
  let stopped = false;
  const stopping = backups.stop(5000).then((finished) => {
    stopped = true;
    return finished;
  });
  await sleep(20);
  assert.equal(stopped, false);
  hold.resolve();
  assert.equal(await stopping, true);
  ok(await running);
  assert.equal(existsSync(join(dir, TODAY)), true);
});

test('a backup that outlasts the stop leaves only its .partial, for the next one to clear', async (t) => {
  const hold = Promise.withResolvers<void>();
  const { dir, failures, make, backups } = setup(t, { hooks: { afterLedger: () => hold.promise } });
  const running = backups.trigger();
  assert.equal(await backups.stop(10), false);
  hold.resolve();
  assert.equal((await running).ok, false);
  assert.equal(existsSync(join(dir, TODAY)), false);
  assert.equal(existsSync(join(dir, `${TODAY}.partial`)), true);
  assert.deepEqual(failures, [], '停服不是备份失败');
  ok(await make({}).trigger());
  assert.deepEqual(readdirSync(dir), [TODAY]);
});

test('only going from good to bad is reported, and a success clears the error', async (t) => {
  const state = { failing: true };
  const { failures, dir, time, backups } = setup(t, {
    hooks: { beforeInstall() { if (state.failing) throw new Error('盘满了'); } },
  });
  oldBackup(dir, '2026-11-04');
  await backups.trigger();
  time.set(NOON + 1000);
  await backups.trigger();
  assert.deepEqual(failures, [['盘满了', '2026-11-04T00:00:00.000Z', new Date(NOON).toISOString()]], '连续失败只说一次，带的是这次失败开始的时刻');
  state.failing = false;
  ok(await backups.trigger());
  const view = backups.status();
  assert.ok(view.configured);
  assert.equal(view.last_error, null);
  state.failing = true;
  await backups.trigger();
  assert.equal(failures.length, 2, '好过之后再坏要再说');
});

test('a notification that cannot go out does not disturb the result', async (t) => {
  const { logs, backups } = setup(t, {
    hooks: { beforeInstall() { throw new Error('盘满了'); } },
    options: { onFailure() { throw new Error('通知坏了'); } },
  });
  const result = await backups.trigger();
  assert.equal(result.ok, false);
  assert.ok(logs.some((line) => line.includes('通知没发出去')));
});

test("today's name taken by a directory that is not a backup: the backup fails and nothing is moved", async (t) => {
  const { dir, backups } = setup(t);
  mkdirSync(join(dir, TODAY));
  writeFileSync(join(dir, TODAY, '照片.jpg'), '主人的');
  const result = await backups.trigger();
  assert.equal(result.ok ? '' : result.error, `备份目录里已有同名目录 ${TODAY}，不是本程序的备份`);
  assert.deepEqual(readdirSync(dir), [TODAY], '不留 .partial，也不把它挪成 .old');
  assert.deepEqual(readdirSync(join(dir, TODAY)), ['照片.jpg']);
});

test("a directory that takes today's name while the backup is copying is still not replaced", async (t) => {
  const { dir, backups } = setup(t, {
    hooks: {
      beforeInstall() {
        mkdirSync(join(dir, TODAY));
        writeFileSync(join(dir, TODAY, '照片.jpg'), '主人的');
      },
    },
  });
  const result = await backups.trigger();
  assert.equal(result.ok ? '' : result.error, `备份目录里已有同名目录 ${TODAY}，不是本程序的备份`);
  assert.deepEqual(readdirSync(join(dir, TODAY)), ['照片.jpg']);
  assert.equal(existsSync(join(dir, `${TODAY}.old`)), false);
});

test('directories shaped like leftovers but without our mark are never deleted or promoted', async (t) => {
  const { dir, logs, time, backups } = setup(t);
  const theirs = ['2026-11-03.partial', '2026-11-02.old', `${TODAY}.old`];
  for (const name of theirs) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'keep.txt'), name);
  }
  // The catch-up at start has nothing of today's to replace, so their .old is not in its way.
  await backups.start();
  assert.ok(existsSync(join(dir, TODAY, 'backup.json')));
  time.set(NOON + 60_000);
  const second = await backups.trigger();
  assert.equal(second.ok ? '' : second.error, `备份目录里已有同名目录 ${TODAY}.old，不是本程序的备份`);
  assert.equal(report(dir, TODAY).at, new Date(NOON).toISOString(), '第一份还在原位');
  for (const name of theirs) {
    assert.equal(readFileSync(join(dir, name, 'keep.txt'), 'utf8'), name);
    assert.ok(logs.some((line) => line.includes(name) && line.includes('没有动')), `${name} 要留一行日志`);
  }
  assert.equal(existsSync(join(dir, '2026-11-02')), false, '别人的 .old 不能被扶正成备份');
  await backups.stop(0);
});

test("today's .partial that is not ours stops the backup instead of being written into", async (t) => {
  const { dir, backups } = setup(t);
  mkdirSync(join(dir, `${TODAY}.partial`));
  writeFileSync(join(dir, `${TODAY}.partial`, 'keep.txt'), '主人的');
  const result = await backups.trigger();
  assert.equal(result.ok ? '' : result.error, `备份目录里已有同名目录 ${TODAY}.partial，不是本程序的备份`);
  assert.deepEqual(readdirSync(join(dir, `${TODAY}.partial`)), ['keep.txt']);
});

test('a restore mark that cannot be read on the live connection is read on the copy, and stops the publish', async (t) => {
  const f = fixture(t);
  f.queuedTask();
  const { dir, time, make } = setup(t, { f });
  ok(await make({}).trigger());
  const before = readFileSync(join(dir, TODAY, 'ledger.db'));
  const dataDir = join(f.dir, 'data');
  mkdirSync(dataDir);
  restoreBackup(dataDir, join(dir, TODAY));
  const backups = createBackups({
    dataDir,
    config: () => ({ dir, at: '03:30', keepDays: 14 }),
    // What a retired connection does, before the service is behind its next barrier.
    ledger: { getRestore() { throw new Error('database is not open'); } },
    recovering: () => false,
    clock: time.clock,
    log: () => {},
  });
  time.set(NOON + 60_000);
  const result = await backups.trigger();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /账本处于恢复待确认状态/);
  assert.deepEqual(readFileSync(join(dir, TODAY, 'ledger.db')), before, '当天的好备份不能被待确认的账本盖掉');
});

test('a backup directory inside runs/ is refused before anything is copied into itself', async (t) => {
  const f = fixture(t);
  const inside = join(f.dir, 'runs', 'backups');
  mkdirSync(inside, { recursive: true });
  let copies = 0;
  // Stopping at the first copy keeps a failure of this test from filling the disk.
  const { backups } = setup(t, { f, config: { dir: inside }, hooks: { copyRun: async () => { copies += 1; void backups.stop(0); } } });
  const result = await backups.trigger();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /runs/);
  assert.deepEqual(readdirSync(inside), []);
  assert.equal(copies, 0);
});

test('where the backup directory may not be: the data directory, runs/, or anything that resolves into it', (t) => {
  const f = fixture(t);
  const data = join(f.dir, 'data');
  const runs = join(data, 'runs');
  mkdirSync(join(runs, 'deep'), { recursive: true });
  mkdirSync(join(data, 'runs-old'));
  const plain = join(f.dir, 'plain');
  writeFileSync(plain, '');
  const alias = join(f.dir, 'alias');
  symlinkSync(runs, alias, 'junction');

  assert.match(backupDirProblem(data, data) ?? '', /数据目录/);
  assert.match(backupDirProblem(data, join(data, 'runs', '..')) ?? '', /数据目录/);
  for (const dir of [runs, join(runs, 'deep'), join(runs, 'not-yet', 'there'), `${data}/x/../runs`, alias, join(alias, 'deep'), join(alias, 'not-yet')]) {
    assert.match(backupDirProblem(data, dir) ?? '', /runs/, dir);
  }
  if (process.platform === 'win32') assert.match(backupDirProblem(data, runs.toUpperCase()) ?? '', /runs/, 'Windows 的路径不分大小写');
  assert.match(backupDirProblem(data, plain) ?? '', /不是目录/);
  for (const dir of [join(data, 'backups'), join(data, 'runs-old'), join(f.dir, 'elsewhere'), join(f.dir, 'not-mounted', 'backups')]) {
    assert.equal(backupDirProblem(data, dir), null, dir);
  }

  // runs/ itself living on another disk: what counts is where the logs really are.
  const moved = join(f.dir, 'moved');
  const logs = join(f.dir, 'logs');
  mkdirSync(moved);
  mkdirSync(logs);
  symlinkSync(logs, join(moved, 'runs'), 'junction');
  assert.match(backupDirProblem(moved, join(logs, 'backups')) ?? '', /runs/);
});

const notLedgers: [string, (file: string) => void][] = [
  ['零字节', (file) => truncateSync(file, 0)],
  ['只有页头的空库', (file) => {
    rmSync(file);
    const conn = new DatabaseSync(file);
    conn.exec('PRAGMA journal_mode=WAL');
    conn.close();
  }],
  ['别的程序的库', (file) => {
    rmSync(file);
    const conn = new DatabaseSync(file);
    conn.exec('CREATE TABLE task (id TEXT)');
    conn.close();
  }],
  ['别的版本的账本', (file) => {
    const conn = new DatabaseSync(file);
    conn.exec(`UPDATE setting SET value_json = '999' WHERE key = 'schema_version'`);
    conn.close();
  }],
  ['只有版本号、没有业务表的库', (file) => {
    rmSync(file);
    const conn = new DatabaseSync(file);
    conn.exec('CREATE TABLE setting (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, key TEXT NOT NULL UNIQUE, value_json TEXT NOT NULL)');
    conn.exec(`INSERT INTO setting VALUES ('s1', 'now', 'schema_version', '4')`);
    conn.close();
  }],
  ['少了一张业务表的账本', (file) => {
    const conn = new DatabaseSync(file);
    conn.exec('DROP TABLE input');
    conn.close();
  }],
];
for (const [name, spoil] of notLedgers) {
  test(`副本是${name}：integrity_check 说 ok，但它不是账本，不能发布`, async (t) => {
    const { dir, make } = setup(t);
    ok(await make({}).trigger());
    const good = report(dir, TODAY);
    const result = await make({ afterLedger: spoil }).trigger();
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /校验不过.*不是 tycho 账本/);
    assert.deepEqual(report(dir, TODAY), good, '当天的好备份原样在');
  });
}

test("a start that arrives while a backup is running leaves that backup's directory alone", async (t) => {
  const hold = Promise.withResolvers<void>();
  const { dir, backups } = setup(t, { hooks: { afterLedger: () => hold.promise } });
  const running = backups.trigger();
  await until(() => existsSync(join(dir, `${TODAY}.partial`, 'ledger.db')), '备份写到一半');
  await backups.start();
  assert.equal(existsSync(join(dir, `${TODAY}.partial`, 'ledger.db')), true, '启动整理不能删正在写的 .partial');
  hold.resolve();
  ok(await running);
  assert.ok(existsSync(join(dir, TODAY, 'backup.json')));
  await backups.stop(0);
});

test('failing, working, then failing again on one day tells the owner twice, through the real notifier', async (t) => {
  const f = fixture(t);
  const notify = createNotify({ ledger: f.ledger, owner: () => 'zhang', direct: async () => {}, log() {} });
  const state = { failing: true };
  const { time, backups } = setup(t, {
    f,
    hooks: { beforeInstall() { if (state.failing) throw new Error('盘满了'); } },
    options: { onFailure: notify.backupFailed },
  });
  const notices = (): number => f.peek(`SELECT 1 FROM outbox WHERE payload_json LIKE '%自动备份失败%'`).length;
  await backups.trigger();
  time.set(NOON + 60_000);
  await backups.trigger();
  assert.equal(notices(), 1, '连续失败是同一件事');
  state.failing = false;
  time.set(NOON + 120_000);
  ok(await backups.trigger());
  state.failing = true;
  time.set(NOON + 180_000);
  await backups.trigger();
  assert.equal(notices(), 2, '好过之后再坏是新的一件事，同一天也要说');
});

test('through the settings and a whole service: a backup disk that is not there does not keep the service down', { timeout: 60_000 }, async (t) => {
  const { dataDir, start } = stage(t);
  // Set while the disk was there, as the settings page requires; then the disk goes away.
  const missing = join(dataDir, 'not-mounted', 'backups');
  mkdirSync(missing, { recursive: true });
  backupIn(dataDir, missing);
  rmSync(join(dataDir, 'not-mounted'), { recursive: true });
  // The port comes from the settings here, as it does outside the tests.
  const service = await start({ port: undefined }, {
    settings: { 'http.port': await freePort() },
    wecom: { botId: 'b', secret: 's', owner: 'zhang', url: 'ws://127.0.0.1:1' },
  });
  const client = await signIn(service);
  const lastError = async () => ((await (await client.get('/api/state')).json()) as { backup: { last_error: { text: string } | null } }).backup.last_error;
  await until(() => rowsOf(join(dataDir, 'ledger.db')).length > 0, '缺盘的通知');
  assert.equal((await lastError())?.text, `备份目录不存在：${missing}`);
  assert.equal(((await (await client.post('/api/backup', {})).json()) as BackupResult).ok, false);
  assert.equal(rowsOf(join(dataDir, 'ledger.db')).length, 1);
  assert.equal(existsSync(join(dataDir, 'not-mounted')), false);
});

test('through a whole service: start catches up, the button works, a stop waits', { timeout: 60_000 }, async (t) => {
  const { dataDir, start, queued, stop } = stage(t);
  const dir = join(dataDir, 'backup-disk');
  mkdirSync(dir);
  const service = await start({}, backupIn(dataDir, dir));
  const task = queued(service);
  const client = await signIn(service);
  const today = await until(() => readdirSync(dir).find((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && existsSync(join(dir, name, 'backup.json'))), '启动补做');
  for (let running = true; running;) {
    ({ backup: { running } } = (await (await client.get('/api/state')).json()) as { backup: { running: boolean } });
  }
  const answer = await client.post('/api/backup', {});
  assert.equal(answer.status, 200);
  assert.equal(((await answer.json()) as BackupResult).ok, true);
  const { backup } = (await (await client.get('/api/state')).json()) as { backup: { configured: boolean; dir: string; last_ok_at: string | null; running: boolean } };
  assert.deepEqual([backup.configured, backup.dir, backup.running], [true, dir, false]);
  assert.ok(backup.last_ok_at);
  await stop(service);

  const restored = join(dataDir, 'restored');
  mkdirSync(restored);
  restoreBackup(restored, join(dir, today));
  const ledger = openLedger(join(restored, 'ledger.db'));
  try {
    assert.equal(ledger.getTask(task.id).title, task.title);
  } finally {
    ledger.close();
  }
});

test('through a whole service: a restored ledger refuses the button with its reason', { timeout: 60_000 }, async (t) => {
  const { dataDir, start, stop } = stage(t);
  const dir = join(dataDir, 'backup-disk');
  mkdirSync(dir);
  const first = await start();
  first.ledger.createProject({ name: '项目' }, USER);
  await stop(first);
  const kept = join(dataDir, 'copy');
  mkdirSync(kept);
  renameSync(join(dataDir, 'ledger.db'), join(kept, 'ledger.db'));
  for (const side of ['-wal', '-shm']) rmSync(join(dataDir, `ledger.db${side}`), { force: true });
  restoreBackup(dataDir, kept);

  const service = await start({}, backupIn(dataDir, dir));
  const client = await signIn(service);
  const refused = await client.post('/api/backup', {});
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /还没确认清点/);
  assert.deepEqual(readdirSync(dir), [], '启动补做也不跑');
});

function rowsOf(file: string) {
  const conn = new DatabaseSync(file, { readOnly: true });
  try {
    return conn.prepare(`SELECT payload_json FROM outbox WHERE payload_json LIKE '%自动备份失败%'`).all();
  } finally {
    conn.close();
  }
}

test('through a whole service: a failed backup reaches the owner through the Outbox, once', { timeout: 60_000 }, async (t) => {
  const { dataDir, start } = stage(t);
  const gone = join(dataDir, 'no-such-disk');
  mkdirSync(gone);
  backupIn(dataDir, gone);
  rmSync(gone, { recursive: true });
  const service = await start({}, {
    wecom: { botId: 'b', secret: 's', owner: 'zhang', url: 'ws://127.0.0.1:1' },
  });
  const client = await signIn(service);
  const lastError = async () => ((await (await client.get('/api/state')).json()) as { backup: { last_error: { text: string } | null } }).backup.last_error;
  for (let i = 0; i < 500 && !(await lastError()); i += 1) await sleep(10);
  assert.match((await lastError())?.text ?? '', /no-such-disk/);
  assert.equal(((await (await client.post('/api/backup', {})).json()) as BackupResult).ok, false);

  const notices = rowsOf(join(dataDir, 'ledger.db'));
  assert.equal(notices.length, 1, '连续失败只推一条');
  assert.match(String(notices[0]?.payload_json), /上次成功：从未/);
});

test('through a whole service: a stop waits for the backup, and no timer outlives it', { timeout: 60_000 }, async (t) => {
  const { dataDir, start } = stage(t);
  const dir = join(dataDir, 'backup-disk');
  mkdirSync(dir);
  const hold = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const time = fakeClock(Date.now());
  const service = await start({
    backupClock: time.clock,
    backupHooks: {
      afterLedger() {
        reached.resolve();
        return hold.promise;
      },
    },
    stopWaitMs: 30_000,
  }, backupIn(dataDir, dir));
  await reached.promise;
  assert.equal(time.timers().length, 1);
  let stopped = false;
  const stopping = service.stop().then(() => {
    stopped = true;
  });
  assert.equal(time.timers().length, 0, '停服一开始就清定时器');
  await sleep(100);
  assert.equal(stopped, false, '备份还在跑，服务不能先走');
  assert.equal(existsSync(join(dataDir, 'lock')), true);
  hold.resolve();
  await stopping;
  assert.equal(readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).length, 1);
});

test('through a whole service: leaving degraded mode catches up on a missed backup', { timeout: 60_000 }, async (t) => {
  const { dataDir, start } = stage(t);
  const dir = join(dataDir, 'backup-disk');
  mkdirSync(dir);
  let failing = false;
  const service = await start({
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  }, backupIn(dataDir, dir));
  // Only the day's own name: the staging directory holds a backup.json too, just before the rename.
  const today = await until(() => readdirSync(dir).find((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && existsSync(join(dir, name, 'backup.json'))), '启动补做');
  const client = await signIn(service);
  for (let running = true; running;) {
    ({ backup: { running } } = (await (await client.get('/api/state')).json()) as { backup: { running: boolean } });
  }
  failing = true;
  assert.equal((await client.post('/api/messages', { text: '写不进去的' })).status, 503);
  rmSync(join(dir, today), { recursive: true });
  failing = false;
  await until(() => existsSync(join(dir, today, 'backup.json')), '解除屏障后补做');
});

test('a copy with a rule broken inside it, which reads fine, is no backup either', async (t) => {
  const { dir, backups } = setup(t, {
    hooks: {
      afterLedger(file) {
        const conn = new DatabaseSync(file, { defensive: false });
        conn.exec(`
          CREATE TABLE broken (a);
          INSERT INTO broken VALUES (NULL);
          PRAGMA writable_schema = ON;
          UPDATE sqlite_master SET sql = 'CREATE TABLE broken (a NOT NULL)' WHERE name = 'broken';
        `);
        conn.close();
      },
    },
  });
  const result = await backups.trigger();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /校验不过/);
  assert.equal(existsSync(join(dir, TODAY)), false);
});

test('through a whole service: the button is refused while leaving degraded mode counts the instances', { timeout: 60_000 }, async (t) => {
  const { dataDir, remote, start, queued, launched } = stage(t);
  const dir = join(dataDir, 'backup-disk');
  mkdirSync(dir);
  let failing = false;
  let gate: Promise<void> = Promise.resolve();
  const service = await start({
    ledgerHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
    connect(machine) {
      const host = remote.connect(machine);
      // The calls an inventory makes wait in place — recorded, and unanswered — until
      // the gate opens: what one held script call used to cover is now these.
      const held = async <T>(call: () => Promise<T>): Promise<T> => {
        await gate;
        return call();
      };
      return {
        ...host,
        list: (asking) => held(() => host.list(asking)),
        state: (runDir) => held(() => host.state(runDir)),
        stop: (runDir) => held(() => host.stop(runDir)),
      };
    },
  }, backupIn(dataDir, dir));
  await launched(service, queued(service));
  const client = await signIn(service);
  for (let running = true; running;) {
    ({ backup: { running } } = (await (await client.get('/api/state')).json()) as { backup: { running: boolean } });
  }
  const hold = Promise.withResolvers<void>();
  t.after(() => hold.resolve());
  gate = hold.promise;
  failing = true;
  assert.equal((await client.post('/api/messages', { text: '写不进去的' })).status, 503);
  failing = false;
  await until(() => service.ledger.dispatchConditions().recovering, '进入恢复清点');
  const refused = await client.post('/api/backup', {});
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /恢复清点/);
  hold.resolve();
  await until(() => !service.ledger.dispatchConditions().recovering, '清点结束');
});

const emptySetup = (t: TestContext, fields: Parameters<typeof setup>[1] = {}) => {
  const context = setup(t, fields);
  context.settings.set('backup.dir', '', USER);
  return { ...context, backups: context.make() };
};

test('with no directory there is nothing to schedule, nothing to run and nothing to show', async (t) => {
  const { dir, time, backups } = emptySetup(t);
  await backups.start();
  assert.deepEqual(time.timers(), []);
  assert.deepEqual(backups.status(), { configured: false });
  assert.throws(() => backups.trigger(), /没有配置自动备份/);
  await backups.catchUp();
  assert.deepEqual(readdirSync(dir), []);
  await backups.stop(0);
});

test('a directory chosen while running counts as just configured: a timer, and the catch-up', async (t) => {
  const { dir, time, settings, backups } = emptySetup(t);
  await backups.start();
  settings.set('backup.dir', dir, USER);
  backups.reconfigure();
  assert.equal(time.timers().length, 1);
  assert.ok(backups.status().configured);
  await until(() => readdirSync(dir).includes(TODAY), '补做');
  await until(() => !(backups.status() as { running: boolean }).running, '做完');
  assert.equal(time.timers().length, 1);
  await backups.stop(0);
});

test('emptying the directory cancels the timer, and setting it again brings one timer back', async (t) => {
  const { dir, time, settings, backups } = setup(t, { start: local(5, 12) });
  oldBackup(dir, TODAY, new Date(local(5, 3, 30)).toISOString());
  await backups.start();
  assert.equal(time.timers().length, 1);
  settings.set('backup.dir', '', USER);
  backups.reconfigure();
  assert.deepEqual(time.timers(), []);
  assert.deepEqual(backups.status(), { configured: false });
  settings.set('backup.dir', dir, USER);
  backups.reconfigure();
  assert.deepEqual(time.timers().map(({ due }) => due), [local(6, 3, 30)]);
  await backups.stop(0);
});

test('a new time moves the one timer and starts no backup', async (t) => {
  const { dir, time, settings, backups } = setup(t, { start: local(5, 12) });
  oldBackup(dir, TODAY, new Date(local(5, 3, 30)).toISOString());
  await backups.start();
  settings.set('backup.at', '11:00', USER);
  backups.reconfigure();
  assert.deepEqual(time.timers().map(({ due }) => due), [local(6, 11, 0)]);
  settings.set('backup.at', '20:15', USER);
  backups.reconfigure();
  assert.deepEqual(time.timers().map(({ due }) => due), [local(5, 20, 15)]);
  assert.equal((backups.status() as { running: boolean }).running, false, '改时刻不补做');
  assert.deepEqual(readdirSync(dir), [TODAY]);
  await backups.stop(0);
});

test('keeping fewer days applies from the next backup', async (t) => {
  const { dir, settings, backups } = setup(t);
  oldBackup(dir, '2026-11-01');
  await backups.trigger();
  assert.ok(readdirSync(dir).includes('2026-11-01'));
  settings.set('backup.keepDays', 1, USER);
  backups.reconfigure();
  await backups.trigger();
  assert.deepEqual(readdirSync(dir), [TODAY]);
});

test('a backup under way finishes where it started, and the new directory takes over after', async (t) => {
  const hold = Promise.withResolvers<void>();
  const { f, dir, time, settings, make } = setup(t, { start: local(5, 12), hooks: { beforeInstall: () => hold.promise } });
  const backups = make();
  const started = backups.start();
  await until(() => (backups.status() as { running: boolean }).running, '开始');
  const other = join(f.dir, 'other-disk');
  mkdirSync(other);
  settings.set('backup.dir', other, USER);
  backups.reconfigure();
  assert.equal((backups.status() as { dir: string }).dir, dir, '正在做的不换目录');
  hold.resolve();
  await until(() => readdirSync(dir).includes(TODAY), '做完');
  await until(() => readdirSync(other).includes(TODAY), '新目录补做');
  assert.equal((backups.status() as { dir: string }).dir, other);
  await started;
  await until(() => !(backups.status() as { running: boolean }).running, '补做完');
  assert.equal(time.timers().length, 1, '只留一个定时器');
  await backups.stop(0);
});

test('a time changed during a scheduled backup leaves one timer, not two', async (t) => {
  const hold = Promise.withResolvers<void>();
  const { dir, time, settings, make } = setup(t, { start: local(5, 12), hooks: { beforeInstall: () => hold.promise } });
  oldBackup(dir, TODAY, new Date(local(5, 3, 30)).toISOString());
  const backups = make();
  await backups.start();
  let over = false;
  const finished = time.fire(() => over);
  await until(() => (backups.status() as { running: boolean }).running, '定时开始');
  settings.set('backup.at', '05:00', USER);
  backups.reconfigure();
  hold.resolve();
  await until(() => !(backups.status() as { running: boolean }).running && time.timers().length > 0, '做完并重排');
  over = true;
  await finished;
  await sleep(20);
  assert.deepEqual(time.timers().map(({ due }) => due), [local(6, 5, 0)]);
  await backups.stop(0);
});

test('through a whole service: changing the time on the settings page moves the timer', { timeout: 60_000 }, async (t) => {
  const { dataDir, start } = stage(t);
  const dir = join(dataDir, 'backup-disk');
  mkdirSync(dir);
  const time = fakeClock(local(5, 12));
  oldBackup(dir, TODAY, new Date(local(5, 3, 30)).toISOString());
  const service = await start({ backupClock: time.clock }, backupIn(dataDir, dir));
  assert.deepEqual(time.timers().map(({ due }) => due), [local(6, 3, 30)]);
  service.settings.set('backup.at', '20:15', USER);
  assert.deepEqual(time.timers().map(({ due }) => due), [local(5, 20, 15)]);
});

test('through a whole service: the settings page refuses a backup directory the backups cannot use', { timeout: 60_000 }, async (t) => {
  const { dataDir, start } = stage(t);
  const service = await start({}, {});
  const client = await signIn(service);
  const put = (dir: string): Promise<Response> =>
    fetch(`${client.base}/api/settings/backup.dir`, {
      method: 'PUT',
      headers: { Cookie: client.cookie, Origin: client.base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: dir }),
    });
  const inside = join(dataDir, 'runs');
  mkdirSync(inside, { recursive: true });
  for (const [dir, why] of [[dataDir, /数据目录/], [inside, /runs/]] as const) {
    const refused = await put(dir);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, why);
  }
  assert.equal(service.settings.get('backup.dir'), '');
  const good = join(dataDir, 'backup-disk');
  mkdirSync(good);
  assert.equal((await put(good)).status, 200);
  assert.equal(service.settings.get('backup.dir'), good);
});
