// Guards the release check and the decision to take a release back, which is the one
// thing that rewrites `current` a second time:
// - a release counted as working while the service cannot read its ledger, is in the
//   degraded mode a failed write leaves it in, is still finishing its inventory, serves no
//   console, cannot be signed in to, is a different version or runs from another directory
//   than the one just put in place, dies and comes back inside the window it has to hold,
//   or cannot answer the interfaces the pages read;
// - a release taken back while the candidate is still writing the ledger, while anything
//   of the Router that belongs to it is still running, while the ledger cannot be read at
//   all, or after the ledger moved to a version the old program may not open;
// - a checkout with no previous version being treated as something to go back to;
// - a release intent that was asked for and never answered being told apart from one that
//   is still being done;
// - a candidate that took the data directory and had not answered yet being read as "nothing
//   came up" while it was still starting: the wait is the CLI's own budget, not a verdict;
// - the package the owner confirmed being checked by name, digest and size against what is
//   on disk now, so a package replaced after the click is not the one that gets installed.
//
// The stand-in service is used where a real one cannot say what the case needs — the wrong
// version, another program directory, an inventory that never finishes, a ledger that
// cannot be read while the service runs. It signs in exactly as the real service does, so
// the check walks the same path (B1). Everything that can be produced with the real
// service is in cli-release-live.test.ts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { releaseOutcomeLine, checkRelease, consoleAssets, rollbackDecision, samePath, unfinishedStart, unverifiedLine } from '../cli/release.ts';
import { waitRunning } from '../cli/service-client.ts';
import { SCHEMA_VERSION } from '../service/db.ts';
import { peekLedger } from '../service/ledger-peek.ts';
import type { LedgerPeek } from '../service/ledger-peek.ts';
import { isAlive } from '../service/lock.ts';
import { readReleaseResult, registeredPackage, registrationDir, releasesOf, writeReleaseResult, writeReleaseIntent, readReleaseIntent } from '../service/releases.ts';
import { openLedger } from '../service/ledger.ts';
import { holdDataDir, stage, startStub, stubApp, tempDir } from './cli-helpers.ts';

// ---- A start the manager was asked for ----

// The failure this guards: an upgrade meets a candidate that has taken the data directory and
// is still on its way up, reads it as "nothing came up", takes the version back, and then
// cannot stop a candidate it has already given up on. The wait is the CLI's patience, not a
// verdict: alive and holding the lock is starting, what this machine cannot judge is unknown,
// and only a program that never appeared is nothing.
test('等待启动：持锁还活着是还在启动；锁在另一台机器上是未知；没见过的才是没起来', async (t) => {
  const absent = stage(t);
  absent.cli.timing.startWaitMs = 60;
  assert.deepEqual(await waitRunning(absent.dataDir, absent.cli.timing), { state: 'absent' });

  // A lock left behind by a process that is gone: the program started and died on its way up.
  const died = stage(t);
  died.cli.timing.startWaitMs = 5000;
  mkdirSync(died.dataDir, { recursive: true });
  const waiting = waitRunning(died.dataDir, died.cli.timing);
  await sleep(50);
  writeFileSync(join(died.dataDir, 'lock'), JSON.stringify({ pid: 999_999_999 }));
  assert.deepEqual(await waiting, { state: 'died', pid: 999_999_999 });

  const starting = stage(t);
  starting.cli.timing.startWaitMs = 80;
  holdDataDir(starting.dataDir);
  assert.deepEqual(await waitRunning(starting.dataDir, starting.cli.timing), { state: 'starting', pid: process.pid });

  // Another machine's lock: this one can neither see that process nor say whether it is alive.
  const elsewhere = stage(t);
  elsewhere.cli.timing.startWaitMs = 60;
  mkdirSync(elsewhere.dataDir, { recursive: true });
  writeFileSync(join(elsewhere.dataDir, 'lock'), JSON.stringify({ pid: 999_999_999, machine: 'another-machine' }));
  const unknown = await waitRunning(elsewhere.dataDir, elsewhere.cli.timing);
  assert.equal(unknown.state, 'unknown');
  assert.match((unknown as { why: string }).why, /锁在另一台机器上/);
});

// What the command says about a candidate that has not answered. Neither end of it is a
// release that failed, and it is not the recovery inventory that ran out of time either.
test('还没核对完的新版：说清它还在启动、没有回退，并指到 tycho status', () => {
  const check = unfinishedStart('1.1.0', { state: 'starting', pid: 4242 });
  assert.equal(check.ok, false);
  assert.deepEqual(check.pending, ['新版本还在启动（进程 4242），还没有回答']);
  assert.equal(check.pendingFrom, 'start');
  const line = releaseOutcomeLine({ check, rollback: null, from: '1.0.0', to: '1.1.0' }, '1.1.0', '1.0.0');
  assert.match(line, /还没有核对完：新版本还在启动（进程 4242）/);
  assert.match(line, /没有回退/);
  assert.match(line, /tycho status/);
  assert.doesNotMatch(line, /清点超时回退|通过了健康检查|下次启动才生效/);

  const unknown = unfinishedStart('1.1.0', { state: 'unknown', why: '数据目录的锁在另一台机器上（别的机器）' });
  assert.match(unknown.pending!.join(''), /查不出新版本是还在启动还是已经退出：数据目录的锁在另一台机器上/);

  // The recovery inventory keeps its own wording: the two delays are not the same one.
  const recovering = releaseOutcomeLine(
    { check: { ok: false, pending: ['恢复清点尚未完成'], pendingFrom: 'recovery', lines: [] }, rollback: null, from: '1.0.0', to: '1.1.0' },
    '1.1.0',
    '1.0.0',
  );
  assert.match(recovering, /版本已在跑、核对没做完：恢复清点尚未完成/);
  assert.match(recovering, /没有因清点超时回退/);
});

test('核对新版：版本、程序目录、数据目录、账本、恢复清点、登录、控制台、核心接口、观察窗口都对，才算通过', async (t) => {
  const s = stage(t);
  const app = stubApp(join(s.dir, 'app-1.0.0'), '1.0.0');
  await startStub(t, s.dataDir, { STUB_WINDOW_MS: '120' }, join(app, 'service', 'main.ts'));
  const check = await checkRelease(s.cli.timing, { version: '1.0.0', programDir: app, dataDir: s.dataDir });
  assert.equal(check.ok, true, check.lines.join('\n'));
  assert.match(check.lines.join('\n'), /账本能开/);
  assert.match(check.lines.join('\n'), /账本没有处于降级模式/);
  assert.match(check.lines.join('\n'), /恢复清点已完成/);
  assert.match(check.lines.join('\n'), /登录换到了控制台会话/);
  assert.match(check.lines.join('\n'), /控制台资源能加载/);
  assert.match(check.lines.join('\n'), /核心接口能读/);
  assert.match(check.lines.join('\n'), /观察 0\.1 秒，没有重启/);
});

test('核对新版：服务报的版本或程序目录不是刚放上去的那一份，不通过', async (t) => {
  const s = stage(t);
  const app = stubApp(join(s.dir, 'app-1.0.0'), '1.0.0');
  await startStub(t, s.dataDir, {}, join(app, 'service', 'main.ts'));
  const other = await checkRelease(s.cli.timing, { version: '1.1.0', programDir: app, dataDir: s.dataDir });
  assert.equal(other.ok, false);
  assert.match(other.lines.at(-1)!, /版本是 1\.0\.0，要的是 1\.1\.0/);

  const elsewhere = await checkRelease(s.cli.timing, { version: '1.0.0', programDir: join(s.dir, 'app-other'), dataDir: s.dataDir });
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.lines.at(-1)!, /程序目录/);

  const another = await checkRelease(s.cli.timing, { version: '1.0.0', programDir: app, dataDir: join(s.dir, 'other-data') });
  assert.equal(another.ok, false);
  assert.match(another.lines.at(-1)!, /没有在运行/);
});

test('核对新版：账本读不了、写不进去、恢复清点没做完、登录走不通、控制台资源取不到、核心接口读不了，都不通过并说清是哪一件', async (t) => {
  const s = stage(t);
  const app = stubApp(join(s.dir, 'app-1.0.0'), '1.0.0');
  const stub = join(app, 'service', 'main.ts');
  // One data directory each: a stand-in still holding the lock of the one before it
  // would not come up, and the answer would be the earlier one's.
  const one = join(s.dir, 'data-ledger');
  const two = join(s.dir, 'data-recovering');
  const three = join(s.dir, 'data-assets');
  const four = join(s.dir, 'data-login');
  const five = join(s.dir, 'data-core');
  const six = join(s.dir, 'data-degraded');
  const target = (dataDir: string) => ({ version: '1.0.0', programDir: app, dataDir });

  await startStub(t, one, { STUB_LEDGER_PROBLEM: 'database is locked' }, stub);
  const locked = await checkRelease(s.cli.timing, target(one));
  assert.equal(locked.ok, false);
  assert.match(locked.lines.at(-1)!, /账本读不了：database is locked/);

  await startStub(t, two, { STUB_RECOVERING: '1' }, stub);
  // A slow machine keeps the candidate in place, but does not prove it works.
  const recovering = await checkRelease(s.cli.timing, target(two));
  assert.equal(recovering.ok, false);
  assert.deepEqual(recovering.pending, ['恢复清点尚未完成']);
  assert.match(recovering.lines.join('\n'), /版本已在跑、核对没做完.*恢复清点尚未完成/);

  await startStub(t, three, { STUB_NO_ASSETS: '1' }, stub);
  const missing = await checkRelease(s.cli.timing, target(three));
  assert.equal(missing.ok, false);
  assert.match(missing.lines.at(-1)!, /控制台资源 \/assets\/index\.js 取不到（404）/);

  // A service whose login does not work: an anonymous page would still be served by a
  // check that skipped authentication, which is exactly what must not pass.
  await startStub(t, four, { STUB_NO_LOGIN: '1' }, stub);
  const noLogin = await checkRelease(s.cli.timing, target(four));
  assert.equal(noLogin.ok, false);
  assert.match(noLogin.lines.at(-1)!, /控制台登录走不通/);

  await startStub(t, five, { STUB_NO_CORE: '/api/tasks' }, stub);
  const core = await checkRelease(s.cli.timing, target(five));
  assert.equal(core.ok, false);
  assert.match(core.lines.at(-1)!, /控制台要读的接口读不了：\/api\/tasks 答 500/);

  await startStub(t, six, { STUB_DEGRADED: '1' }, stub);
  const degraded = await checkRelease(s.cli.timing, target(six));
  assert.equal(degraded.ok, false);
  assert.match(degraded.lines.at(-1)!, /账本写不进去，服务在降级模式/);
});

test('上线记录保留运行中版本尚未完成的核对步骤，不能读成未启动', (t) => {
  const dataDir = tempDir(t);
  const result = {
    at: '2026-01-01T00:00:00Z', from: '1.0.0', to: '1.1.0', verified: false,
    ok: false, rolled_back: false, in_use: '1.1.0', pending: ['恢复清点尚未完成'],
    lines: ['tycho 1.1.0 版本已在跑、核对没做完：恢复清点尚未完成'],
  };
  writeReleaseResult(dataDir, result);
  assert.deepEqual(readReleaseResult(dataDir), result);
  const line = releaseOutcomeLine({ check: { ok: false, pending: result.pending, lines: [] }, rollback: null, from: result.from, to: result.to }, result.to, result.from);
  assert.match(line, /版本已在跑、核对没做完.*恢复清点尚未完成/);
  assert.doesNotMatch(line, /通过了健康检查|下次启动才生效/);
});

test('核对新版：清点等待中或最终核对时进入降级、账本读不了，不能报通过或待核对', async (t) => {
  for (const [name, sequence] of [
    ['清点中降级', [{ recovering: true }, { recovering: false, degraded: true }]],
    ['清点中账本读不了', [{ recovering: true }, { recovering: false, ledger: 'database is locked' }]],
    ['最终核对降级', [{ recovering: false }, { degraded: true }]],
    ['观察时降级', [{ recovering: false }, { degraded: true }]],
  ] as const) {
    const s = stage(t);
    const app = stubApp(join(s.dir, name), '1.0.0');
    await startStub(t, s.dataDir, {
      STUB_FACTS_SEQUENCE: JSON.stringify(sequence),
      STUB_RECOVERY_WAIT_MS: '10',
      STUB_WINDOW_MS: name === '观察时降级' ? '30' : '0',
    }, join(app, 'service', 'main.ts'));
    const check = await checkRelease(s.cli.timing, { version: '1.0.0', programDir: app, dataDir: s.dataDir });
    assert.equal(check.ok, false, name);
    assert.equal(check.pending, undefined, '降级和账本故障是失败，需要走回退');
    assert.match(check.lines.at(-1)!, /账本写不进去|账本读不了/);
    assert.doesNotMatch(check.lines.join('\n'), /账本没有处于降级模式|通过健康检查/);
  }
});

test('核对新版：观察窗口里服务重启过，不通过', async (t) => {
  const s = stage(t);
  const app = stubApp(join(s.dir, 'app-1.0.0'), '1.0.0');
  // The check reads the service's facts once before the window and once in each round of
  // it: a service that dies on answering the second is one that died inside the window,
  // whatever the machine's pace — a death on a timer could fall on the login or the page
  // instead and fail the check at a different step.
  await startStub(t, s.dataDir, { STUB_WINDOW_MS: '1500', STUB_DIE_AFTER_CHECKS: '2' }, join(app, 'service', 'main.ts'));
  const check = await checkRelease(s.cli.timing, { version: '1.0.0', programDir: app, dataDir: s.dataDir });
  assert.equal(check.ok, false, check.lines.join('\n'));
  assert.match(check.lines.at(-1)!, /观察期间服务不再回答/);
});

test('核对新版：服务报了版本和目录，但目录写成另一种拼法，算同一处', () => {
  assert.equal(samePath(join('a', 'b'), join('a', 'b')), true);
  assert.equal(samePath(`${join('a', 'b')}/`, join('a', 'b')), true);
  assert.equal(samePath(join('a', 'b'), join('a', 'c')), false);
});

test('控制台资源取自页面上指向本站的地址，别的都跳过', () => {
  const html = [
    '<link rel="icon" href="/favicon.svg">',
    '<script type="module" src="/assets/index-abc.js"></script>',
    '<link rel="stylesheet" href="https://cdn.example/x.css">',
    '<img src="data:image/png;base64,AAAA">',
    '<script type="module" src="/assets/index-abc.js"></script>',
  ].join('');
  assert.deepEqual(consoleAssets(html), ['/favicon.svg', '/assets/index-abc.js']);
});

// ---- Taking a release back ----

const PEEK = { known: true, version: 7, routers: [] } as const;
const LEDGER = { before: PEEK, now: PEEK };

test('回退判定：候选服务停了、没有负责人驱动者残留、账本版本没变，才可以回退', () => {
  assert.deepEqual(
    rollbackDecision({ previous: '1.0.0', candidate: { running: false, pid: 42 }, driver: null, ledger: LEDGER }),
    { go: true },
  );
});

test('回退判定：候选服务还在跑，就不回退', () => {
  const decision = rollbackDecision({ previous: '1.0.0', candidate: { running: true, pid: 42 }, driver: null, ledger: LEDGER });
  assert.equal(decision.go, false);
  assert.match((decision as { why: string }).why, /候选服务（进程 42）没有停下来/);
});

test('回退判定：按标记找到的负责人进程还在跑，就不回退——账本里的 pid 为 null 不算停', () => {
  const decision = rollbackDecision({
    previous: '1.0.0',
    candidate: { running: false, pid: null },
    driver: { marker: 'aaaa-bbbb', pids: [77, 78] },
    ledger: LEDGER,
  });
  assert.equal(decision.go, false);
  assert.match((decision as { why: string }).why, /负责人驱动者还有进程在跑（标记 aaaa-bbbb，pid 77、78）/);
});

test('回退判定：账本版本变了，就不回退——旧版程序可能打不开它', () => {
  const decision = rollbackDecision({
    previous: '1.0.0',
    candidate: { running: false, pid: null },
    driver: null,
    ledger: { before: PEEK, now: { known: true, version: 8, routers: [] } },
  });
  assert.equal(decision.go, false);
  assert.match((decision as { why: string }).why, /账本已经从版本 7 变成 8/);
});

test('回退判定：账本读不出来时按未知处理，不回退', () => {
  const decision = rollbackDecision({
    previous: '1.0.0',
    candidate: { running: false, pid: null },
    driver: null,
    ledger: { before: PEEK, now: { known: false, error: 'database is locked' } },
  });
  assert.equal(decision.go, false);
  assert.match((decision as { why: string }).why, /读不出账本现在的样子（database is locked）/);
});

test('回退判定：第一次安装没有上一版可退', () => {
  const decision = rollbackDecision({
    previous: null,
    candidate: { running: false, pid: null },
    driver: null,
    ledger: { before: { known: true, version: null, routers: [] }, now: { known: true, version: null, routers: [] } },
  });
  assert.equal(decision.go, false);
  assert.match((decision as { why: string }).why, /第一次安装/);
});

test('回退之后说的话：说清退到哪一版、账本没动；没有回退的说明为什么', () => {
  const check = { ok: false, lines: ['服务在运行'] };
  const back = releaseOutcomeLine({ check, rollback: { state: 'rolled-back', why: '' }, from: '1.0.0', to: '1.1.0' }, '1.1.0', '1.0.0');
  assert.match(back, /^已经退回 1\.0\.0，账本没有动。/);
  const kept = releaseOutcomeLine({ check, rollback: { state: 'kept', why: '账本已经从版本 7 变成 8' }, from: '1.0.0', to: '1.1.0' }, '1.1.0', '1.0.0');
  assert.match(kept, /^没有退回原来的版本：账本已经从版本 7 变成 8/);
  const passed = releaseOutcomeLine({ check: { ok: true, lines: [] }, rollback: null, from: '1.0.0', to: '1.1.0' }, '1.1.0', '1.0.0');
  assert.match(passed, /通过了健康检查，没有回退/);
});

// What the record and the command say about a version that went in and was never run. The
// failure this guards is the one real acceptance found: a service running in the
// foreground is not this installation's autostart's to stop, so nothing was started on the
// new version and no health check happened — and the record said ok: true all the same.
test('没有换掉在跑的服务：话说这一版还没有验证、下次启动才生效，有服务在跑就说怎么用上它', () => {
  const idle = unverifiedLine('1.1.0', false);
  assert.match(idle, /装上了 tycho 1\.1\.0，但这一版还没有验证/);
  assert.match(idle, /没有把在跑的服务换到它上面，也就没有做健康检查/);
  assert.match(idle, /下次启动才生效/);
  assert.doesNotMatch(idle, /在跑的服务还是原来那一版/);

  const running = unverifiedLine('1.1.0', true);
  assert.match(running, /下次启动才生效/);
  assert.match(running, /在跑的服务还是原来那一版：停掉它（tycho stop）再重新启动/);
});

// ---- Reading a ledger off-band ----

test('peekLedger：读出账本版本、每个项目还没确认结束的负责人进程和标记，没有账本就是没有版本，读不了就说读不了', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.db');
  assert.deepEqual(peekLedger(file, 'stopped'), { known: true, version: null, routers: [] });

  const ledger = openLedger(file);
  const one = ledger.createProject({ name: '甲' }, { actor: 'test' });
  const two = ledger.createProject({ name: '乙' }, { actor: 'test' });
  const a = ledger.openContext({ projectId: one, segmentId: ledger.ensureSegment(one).id, marker: 'a', launch: {}, knowledge: [] });
  const b = ledger.openContext({ projectId: two, segmentId: ledger.ensureSegment(two).id, marker: 'b', launch: {}, knowledge: [] });
  ledger.setContextStarted(a.id, 4242);
  ledger.setContextStarted(b.id, 4343);
  ledger.close();
  const open = peekLedger(file, 'stopped');
  assert.ok(open.known);
  assert.deepEqual(open.routers, [{ marker: 'a', pid: 4242 }, { marker: 'b', pid: 4343 }], '两个项目的负责人都在里面');

  // The pid written as gone, the context closed: the marker is what a scan for what is left of
  // the driver looks for, so it has to survive both until a scan saw nothing of it.
  const again = openLedger(file);
  again.setContextPid(a.id, null);
  again.closeContext(a.id, '换了登录');
  again.setContextCleared(b.id);
  again.closeContext(b.id, '换了登录');
  again.close();
  const after = peekLedger(file, 'stopped');
  assert.deepEqual(after, { known: true, version: SCHEMA_VERSION, routers: [{ marker: 'a', pid: null }] });

  // Not a ledger at all: the answer is unknown rather than "no ledger".
  writeFileSync(join(dir, 'broken.db'), 'not a database');
  assert.equal(peekLedger(join(dir, 'broken.db'), 'stopped').known, false);
});

// What a rollback reads right after a candidate crashed: the ledger as the dead process left
// it, its last rows still in the WAL. The release looks as soon as the process is seen gone,
// and on Windows the system is still unmapping the -shm from it then: a peek that reset the
// WAL index (a write) failed there with "disk I/O error" in about one look in four under
// load, and the rollback was refused as "cannot read the ledger". Several writers die at
// once, each looked at the moment it is gone, so the window is hit if it is there.
test('peekLedger：写账本的进程刚崩掉、一被看到不在就读，照样读得出，它最后写进 WAL 的也在', async (t) => {
  const dir = tempDir(t);
  const crash = async (file: string): Promise<LedgerPeek> => {
    const writer = openLedger(file);
    writer.close();
    const child = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const conn = new DatabaseSync(${JSON.stringify(file)});
      for (let i = 0; i < 20; i += 1) conn.prepare("UPDATE setting SET value_json = ? WHERE key = 'schema_version'").run(String(${SCHEMA_VERSION + 1}));
      console.log('written');
      setTimeout(() => process.exit(1), 20);
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => child.stdout!.once('data', resolve));
    while (isAlive(child.pid!)) await sleep(2);
    const seen = peekLedger(file, 'stopped');
    await exited;
    return seen;
  };
  for (let round = 0; round < 4; round += 1) {
    const peeks = await Promise.all([0, 1, 2, 3, 4].map((each) => crash(join(dir, `ledger-${round}-${each}.db`))));
    for (const peek of peeks) assert.deepEqual(peek, { known: true, version: SCHEMA_VERSION + 1, routers: [] });
  }
});

// ---- The releases directory ----

test('产物：登记记下名字、哈希和大小，文件在登记编号的目录里；只有 tycho-<版本>.tar.gz 才是发布包', async (t) => {
  const dataDir = tempDir(t);
  const dir = registrationDir(dataDir, 'run-1', 'reg-1');
  mkdirSync(dir, { recursive: true });
  const PACKAGE = Buffer.from('x');
  writeFileSync(join(dir, 'tycho-1.2.0.tar.gz'), PACKAGE);
  writeFileSync(join(dir, 'work.bundle'), 'y');
  writeFileSync(join(dir, 'notes.md'), 'z');
  const sum = createHash('sha256').update(PACKAGE).digest('hex');
  const files = [
    { name: 'tycho-1.2.0.tar.gz', sha256: sum, bytes: PACKAGE.length },
    { name: 'work.bundle', sha256: 'b'.repeat(64), bytes: 1 },
    { name: 'notes.md', sha256: 'c'.repeat(64), bytes: 1 },
  ];
  const held = { run_id: 'run-1', task_id: 'task-1', registration: { id: 'reg-1', at: '2026-01-01T00:00:00Z', files }, registered: ['reg-1'], problem: null, releases_dropped_at: null };

  const [stored] = releasesOf(dataDir, [held]);
  assert.equal(stored?.run_id, 'run-1');
  assert.deepEqual(stored?.packages.map((each) => [each.file, each.version]), [['tycho-1.2.0.tar.gz', '1.2.0']]);
  // Historical bundle artifacts stay readable as registered files; nothing makes a new one.
  assert.deepEqual(stored?.files.map((each) => each.name), ['tycho-1.2.0.tar.gz', 'work.bundle', 'notes.md']);

  // What the console confirmed is checked again before anything is installed: the same
  // name, digest and size; and the file has to hash to that now.
  const chosen = { name: 'tycho-1.2.0.tar.gz', sha256: sum, bytes: PACKAGE.length };
  assert.deepEqual(registeredPackage(dataDir, held, chosen)?.version, '1.2.0');
  assert.equal(registeredPackage(dataDir, held, { ...chosen, sha256: 'd'.repeat(64) }), null, '摘要不是登记里的那一个');
  assert.equal(registeredPackage(dataDir, held, { ...chosen, bytes: 99 }), null, '大小不是登记里的那一个');
  assert.equal(registeredPackage(dataDir, held, { ...chosen, name: 'tycho-9.9.9.tar.gz' }), null, '不是登记里列的文件');
  assert.equal(registeredPackage(dataDir, { ...held, registration: null }, chosen), null, '没有登记就什么都没有');
  assert.equal(registeredPackage(dataDir, undefined, chosen), null, '账本里没有的 Run');
  writeFileSync(join(dir, 'tycho-1.2.0.tar.gz'), '换过的内容');
  assert.equal(registeredPackage(dataDir, held, chosen), null, '收到以后被换掉的不算');

  // A directory no registration names is not a release, whatever is in it.
  mkdirSync(join(dataDir, 'releases', 'not-ours'), { recursive: true });
  assert.equal(releasesOf(dataDir, [held, { ...held, run_id: 'run-2', registration: null }]).length, 1);
});

test('上线意图：主人要求的那一次记下来，读得回来；坏掉的记录当作没有', async (t) => {
  const dataDir = tempDir(t);
  assert.equal(readReleaseIntent(dataDir), null);
  const intent = {
    at: '2026-01-01T00:00:00Z', run_id: 'run-1', name: 'tycho-1.2.0.tar.gz',
    version: '1.2.0', sha256: 'a'.repeat(64), bytes: 3, file: '/releases/run-1/tycho-1.2.0.tar.gz',
  };
  writeReleaseIntent(dataDir, intent);
  assert.deepEqual(readReleaseIntent(dataDir), intent);
  writeFileSync(join(dataDir, 'release-intent.json'), JSON.stringify({ ...intent, name: '../escape' }));
  assert.equal(readReleaseIntent(dataDir), null);
  writeFileSync(join(dataDir, 'release-intent.json'), 'not json');
  assert.equal(readReleaseIntent(dataDir), null);
});

test('上线结果：记下从哪一版到哪一版、验没验过、成没成、退没退、current 现在指哪一版，读得回来', async (t) => {
  const dataDir = tempDir(t);
  assert.equal(readReleaseResult(dataDir), null);
  const result = { at: '2026-01-01T00:00:00Z', from: '1.0.0', to: '1.1.0', verified: true, ok: false, rolled_back: true, in_use: '1.0.0', lines: ['新版没有通过健康检查'] };
  writeReleaseResult(dataDir, result);
  assert.deepEqual(readReleaseResult(dataDir), result);

  // A record that does not say whether the new version was ever run is not read: it may be
  // one that passed its check or one that was never started, and the page must not guess.
  writeFileSync(join(dataDir, 'release.json'), JSON.stringify({ ...result, verified: undefined }));
  assert.equal(readReleaseResult(dataDir), null);
  writeFileSync(join(dataDir, 'release.json'), JSON.stringify({ ...result, verified: 'yes' }));
  assert.equal(readReleaseResult(dataDir), null);
});

test('核对新版：窗口里服务换成另一个进程（崩了又起来），不通过', async (t) => {
  const s = stage(t);
  const app = stubApp(join(s.dir, 'app-1.0.0'), '1.0.0');
  const dataDir = join(s.dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const TOKEN = 'shutdown-token';
  const LOGIN = 'health-check-login-token';
  writeFileSync(join(dataDir, 'login-token'), LOGIN);
  // A service that answers as one process the first time and as another from then on:
  // what a crash and an automatic restart look like from outside. It signs the health
  // check in the way the real one does, so the run reaches the window at all.
  let asked = 0;
  const startedAt = '2026-01-01T00:00:00Z';
  const server = createServer((request, response) => {
    const json = (body: unknown): void => void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.url === '/api/instance' && request.headers.authorization === `Bearer ${TOKEN}`) {
      asked += 1;
      json({
        pid: process.pid + asked - 1,
        port: (server.address() as { port: number }).port,
        version: '1.0.0',
        program_dir: app,
        data_dir: dataDir,
        started_at: asked === 1 ? startedAt : '2026-01-01T00:01:00Z',
      });
      return;
    }
    if (request.url === '/api/login-links' && request.headers.authorization === `Bearer ${LOGIN}`) {
      json({ path: '/login/stub-link', url: 'http://public.example/login/stub-link', external: false });
      return;
    }
    if (request.url === '/login/stub-link') {
      if (request.method === 'GET') response.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>enter</body></html>');
      else response.writeHead(303, { 'Set-Cookie': 'tycho=stub; Path=/; HttpOnly', Location: '/' }).end();
      return;
    }
    if (request.url === '/api/release-check') json({ ledger: 'ok', degraded: false, recovering: false, health_window_ms: 300 });
    else if (request.url === '/') response.writeHead(200, { 'content-type': 'text/html' }).end('<html><script src="/assets/index.js"></script></html>');
    else if (request.url === '/assets/index.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end('export {};\n');
    else if (request.url?.startsWith('/api/')) json({ stub: request.url });
    else response.writeHead(404).end();
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(dataDir, 'service.json'), JSON.stringify({ pid: process.pid, version: '1.0.0', program_dir: app, started_at: startedAt, port: (server.address() as { port: number }).port, token: TOKEN }));

  const check = await checkRelease(s.cli.timing, { version: '1.0.0', programDir: app, dataDir });
  assert.equal(check.ok, false, check.lines.join('\n'));
  assert.match(check.lines.at(-1)!, /观察期间服务重启过/);
});
