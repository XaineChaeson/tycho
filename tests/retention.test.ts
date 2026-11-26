// Guards the retention rule for what a finished work leaves on disk (docs/design/phase1-design.md
// "已结束的工作"). Against:
// - a copy cleared while the work is still going on: a child that ended and closed, under a
//   work still moving, or a work that ended less than the setting's days ago, or one whose
//   end was never recorded, being read as due;
// - the period being a stale value: a changed setting not deciding the next pass;
// - the host's copies marked and audited apart (a crash between the two leaves a mark with no
//   record, or a record with no mark), or a mark made besides the round it belongs to;
// - anything reading a cleared registration from disk: the page offering a package or bundle
//   that is no longer there, `registeredFile` still handing one out, a merge, an acceptance's
//   re-taking, a review binding or a registration arriving late pretending the bytes are there;
// - the sweep pulling the round's own directory out from under a taking that is moving its
//   files into it, and a taking that could not put its files in place answering with the
//   platform's error while the round the retention rule cleared is what decided its fate;
// - the sweep removing a round the rule did not name, or deleting anything in a cleared round
//   besides the directories its registrations named — the older layout's loose files and
//   anything unrecognised stay — or skipping the sweep on a pass that marked nothing new;
// - a machine being asked for a Task's code copy that is away, gone, re-registered under the
//   same name, or is a client too old to be told — or being asked twice, or its refusal being
//   written as if the copy were gone, or its confirmation being lost because the mark failed;
// - a pass going on while the service is stopping, degraded or running its recovery inventory,
//   or sending its next command after one of those began;
// - the migration from version 33 not adding both columns, or changing a row it had;
// - the setting being absent from the registry or taking a value outside its range.
import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { createAcceptor } from '../service/accept.ts';
import { DegradedError } from '../service/errors.ts';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import { openLedger } from '../service/ledger.ts';
import { createRetention } from '../service/retention.ts';
import { INCOMING, registeredFile, registrationDir, releasesDir, releasesOf, sweepReleases } from '../service/releases.ts';
import { DONE, fixture, tune, USER, type Fixture } from './helpers.ts';

const NOW = new Date('2026-12-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

// A top-level work that ran one round, was accepted, and whose end is what the test needs.
function endedWork(f: Fixture, endedAt: string): { task: TaskRow; run: RunRow } {
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.acceptTask(task.id, '看过', USER, { withoutReview: true });
  f.force('UPDATE task SET closed_at = ? WHERE id = ?', endedAt, task.id);
  return { task: f.task(task.id), run: f.run(run.id) };
}

// The same, on a work whose end was never recorded: an older ledger row with no closed_at.
function endedWorkWithoutEnd(f: Fixture): { task: TaskRow; run: RunRow } {
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.acceptTask(task.id, '看过', USER, { withoutReview: true });
  f.force('UPDATE task SET closed_at = NULL WHERE id = ?', task.id);
  return { task: f.task(task.id), run: f.run(run.id) };
}

// A child that ran, was accepted and ended long ago, under a parent that is still moving: the
// work as a whole has not ended, so nothing of it is due.
function workWithEndedChild(f: Fixture, endedAt: string): { parent: TaskRow; child: TaskRow } {
  const parent = f.ledger.createTask({ projectId: f.projectId, title: '父', goal: '目标', acceptance: '验收', roleId: 'implement' }, USER);
  f.ledger.queueTask(parent.id, USER);
  const child = f.ledger.createTask({ projectId: f.projectId, parentId: parent.id, title: '子', goal: '目标', acceptance: '验收', roleId: 'implement' }, USER);
  f.ledger.queueTask(child.id, USER);
  const run = f.ledger.createRun(child.id, { ...f.login, expectedRevision: child.revision }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE);
  f.ledger.acceptTask(child.id, '看过', USER, { withoutReview: true });
  f.force('UPDATE task SET closed_at = ? WHERE id = ?', endedAt, child.id);
  return { parent: f.task(parent.id), child: f.task(child.id) };
}

// A registration of one or more files of a round, with the directory and bytes it names.
function register(f: Fixture, runId: string, files: { name: string; text: string }[]): { id: string; dir: string; files: { name: string; sha256: string; bytes: number }[] } {
  const made = files.map(({ name, text }) => {
    const body = Buffer.from(text);
    return { name, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, body };
  });
  const id = f.ledger.registerArtifacts(runId, made.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })));
  const dir = registrationDir(f.dir, runId, id);
  mkdirSync(dir, { recursive: true });
  for (const { name, body } of made) writeFileSync(join(dir, name), body);
  return { id, dir, files: made.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) };
}

function runRow(f: Fixture, runId: string): RunRow {
  return f.run(runId);
}

test('到期判定：工作没结束、子任务结束而工作还在推进、结束不满期、结束时刻不知道都不清，满了才清', (t) => {
  const f = fixture(t);
  // Still moving: a round created and not ended.
  f.runningRun();
  // A child ended long ago under a parent still queued: the work itself has not ended.
  workWithEndedChild(f, ago(30));
  // Ended, but not for the setting's days.
  endedWork(f, ago(1));
  // Ended by its state, with no moment recorded: nothing says the period passed.
  endedWorkWithoutEnd(f);

  assert.deepEqual(f.ledger.retentionDue(NOW), [], '还没结束或没满期的工作一份都不清');

  const old = endedWork(f, ago(8));
  assert.deepEqual(f.ledger.retentionDue(NOW).map((each) => each.run_id), [old.run.id], '满期的才清');
  assert.equal(f.ledger.retentionDue(NOW)[0]!.ended_at, old.task.closed_at, '到期依据是整项工作的结束时刻');
});

test('保留天数按设置当场生效：改了设置，下一次判定就用新值', (t) => {
  const f = fixture(t);
  const work = endedWork(f, ago(4));
  assert.deepEqual(f.ledger.retentionDue(NOW), [], '默认 7 天，结束 4 天还不清');
  tune(f.ledger, 'retention.endedDays', 3);
  assert.deepEqual(f.ledger.retentionDue(NOW).map((each) => each.run_id), [work.run.id], '改成 3 天就到期');
  tune(f.ledger, 'retention.endedDays', 10);
  assert.deepEqual(f.ledger.retentionDue(NOW), [], '再改成 10 天，又不该清了');
});

test('主机产物：账本一次写下标记和 change，之后只给 dropped_at，目录被 sweep 收走', (t) => {
  const f = fixture(t);
  const due = endedWork(f, ago(8));
  const keeping = endedWork(f, ago(1));
  // A round that was taken over twice: the earlier registration is recorded before the
  // current one, so the mark names `product` and the sweep has to collect both directories.
  const earlier = register(f, due.run.id, [{ name: 'old.bundle', text: '更早的一份' }]);
  const product = register(f, due.run.id, [
    { name: 'tycho-1.2.0.tar.gz', text: '发布包' },
    { name: 'work.bundle', text: '代码包' },
  ]);
  const bundle = { file: product.files.find((file) => file.name === 'work.bundle')! };
  const kept = register(f, keeping.run.id, [{ name: 'tycho-1.3.0.tar.gz', text: '另一份' }]);

  const marked = f.ledger.dropDueReleases(NOW);
  assert.deepEqual(marked.map((each) => each.run_id), [due.run.id]);
  assert.equal(marked[0]!.registration, product.id, '标记的是这一轮现在登记的编号');
  assert.equal(marked[0]!.days, 7);
  assert.equal(marked[0]!.ended_at, due.task.closed_at);

  const after = runRow(f, due.run.id);
  assert.equal(after.releases_dropped_at !== null, true, '标记写下了');
  const changes = f.peek<{ actor: string; task_id: string; run_id: string; detail_json: string }>(
    `SELECT actor, task_id, run_id, detail_json FROM change WHERE action = 'run.releases_drop' ORDER BY seq`,
  );
  assert.equal(changes.length, 1, '同一个事务里每个受影响的轮次一条 change');
  assert.equal(changes[0]!.actor, 'service');
  assert.equal(changes[0]!.task_id, due.task.id);
  assert.equal(changes[0]!.run_id, due.run.id);
  assert.deepEqual(JSON.parse(changes[0]!.detail_json), { registration: product.id, days: 7, ended_at: due.task.closed_at });
  assert.equal(runRow(f, keeping.run.id).releases_dropped_at, null, '没到期的一轮不标');

  // What the page reads: the round is still listed with what it registered, with nothing to
  // offer and the moment it was cleared.
  const held = f.ledger.artifactsOf(due.task.id);
  const [release] = releasesOf(f.dir, held);
  assert.equal(release!.dropped_at, after.releases_dropped_at);
  assert.deepEqual(release!.files.map((file) => file.name).sort(), ['tycho-1.2.0.tar.gz', 'work.bundle']);
  assert.deepEqual(release!.packages, [], '没有可上线的东西');
  assert.equal(registeredFile(f.dir, held[0], bundle.file), null, '已清理的登记不当文件在');
  assert.equal(releasesOf(f.dir, f.ledger.artifactsOf(keeping.task.id))[0]!.dropped_at, null);

  // The sweep removes every directory the cleared round registered, and then the round's
  // own directory because nothing else was in it; the round that is not due — and the
  // layout's other rules — stay as they were.
  const orphan = join(releasesDir(f.dir), keeping.run.id, 'NOT-A-REGISTRATION');
  mkdirSync(orphan, { recursive: true });
  sweepReleases(f.dir, (runId) => f.ledger.artifactsOfRun(runId), new Set());
  assert.equal(existsSync(join(releasesDir(f.dir), due.run.id)), false, '只剩登记目录时，整轮目录也空了、删掉');
  assert.equal(existsSync(product.dir), false);
  assert.equal(existsSync(earlier.dir), false, '这一轮先前的登记目录一起收走');
  assert.equal(existsSync(kept.dir), true, '没到期的那一轮原样留着');
  assert.equal(existsSync(orphan), false, '没登记的子目录照旧由 sweep 收走');
});

// The failure this guards: a cleared round taken whole, so the older layout's loose files —
// which this program never reads and must never delete — go with it. Only directories the
// ledger's registrations name are this layout's copies.
test('已清理的一轮：目录都删掉（登记过的和没登记的），旧格式的散文件不碰', (t) => {
  const f = fixture(t);
  const due = endedWork(f, ago(8));
  const product = register(f, due.run.id, [{ name: 'work.bundle', text: '代码包' }]);
  const runDir = join(releasesDir(f.dir), due.run.id);
  const loose = join(runDir, 'old-format.tar.gz');
  const unknown = join(runDir, 'NOT-A-REGISTRATION');
  writeFileSync(loose, '旧格式');
  mkdirSync(unknown, { recursive: true });
  writeFileSync(join(unknown, 'x.txt'), '不认识');

  f.ledger.dropDueReleases(NOW);
  sweepReleases(f.dir, (runId) => f.ledger.artifactsOfRun(runId), new Set());
  assert.equal(existsSync(product.dir), false, '登记过的目录删掉');
  assert.equal(readFileSync(loose, 'utf8'), '旧格式', '旧格式的散文件不碰');
  assert.equal(existsSync(unknown), false, '没登记的目录照常收走，和没清理的一轮一样');
  assert.equal(existsSync(runDir), true, '还有旧格式的散文件，这一轮的目录不删');
});

test('已清理的登记：重新取回、合入、审阅绑定都说清是保留期清掉的，不再从机器上取', async (t) => {
  const f = fixture(t);
  const work = endedWork(f, ago(8));
  const product = register(f, work.run.id, [{ name: 'work.bundle', text: '代码包' }]);
  f.ledger.dropDueReleases(NOW);
  const text = /按保留期清理（工作结束后过了保留期）/;

  const fetched: string[] = [];
  const accept = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: { fetchArtifacts: async (_run, into) => { fetched.push(into); return { files: [], problem: null }; } },
  });
  await assert.rejects(() => accept.refetch(work.task.id), text, '重新取回不能把清理悄悄撤销');
  assert.deepEqual(fetched, [], '没有去问机器');

  // The guard is about a registration that a review would bind to; reaching it needs a Task
  // still waiting to be accepted, which the rule itself never leaves behind (cleanup only
  // happens for work that ended). Forced here rather than left to a state the owner cannot make.
  f.force(`UPDATE task SET state = 'ready' WHERE id = ?`, work.task.id);
  await assert.rejects(
    async () => f.ledger.createTask({ projectId: f.projectId, title: '审', goal: '审', acceptance: '结论', roleId: 'review', reviewOf: { taskId: work.task.id, runId: work.run.id, revision: work.task.revision, registration: product.id } }, USER),
    text,
    '审阅绑定不了已清理的那一份',
  );
});

test('取回和清理同时发生：登记被拒，已经取到的东西收走，上一份登记不动', async (t) => {
  const f = fixture(t);
  const work = endedWork(f, ago(8));
  register(f, work.run.id, [{ name: 'earlier.bundle', text: '上一份' }]);
  const before = f.ledger.artifactsOfRun(work.run.id)!;
  const accept = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      async fetchArtifacts(_run, into) {
        // The retention pass lands after the taking checked the entry, before its
        // registration: exactly the race the registration's own check is for.
        f.ledger.dropDueReleases(NOW);
        const body = Buffer.from('这一份没有登记上');
        writeFileSync(join(into, 'report.txt'), body);
        return { files: [{ name: 'report.txt', sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length }], problem: null };
      },
    },
  });

  const outcome = await accept.refetch(work.task.id);
  assert.deepEqual(outcome.stored, []);
  assert.match(String(outcome.problem), /按保留期清理/, '登记说的是同一句保留期的话，不是别的失败');
  const after = f.ledger.artifactsOfRun(work.run.id)!;
  assert.equal(after.registration?.id, before.registration?.id, '上一份登记不动');
  assert.deepEqual(after.registered, before.registered, '这次没有登记上');
  assert.deepEqual(
    { registration: after.registration, registered: after.registered, problem: after.problem },
    { registration: before.registration, registered: before.registered, problem: before.problem },
    'artifacts_json 一点没变，连失败原因也不写在这一轮上',
  );
  assert.equal(runRow(f, work.run.id).releases_dropped_at !== null, true, '这一轮确实已标记清理');
  const root = releasesDir(f.dir);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(INCOMING)), [], '临时目录收走');
  assert.equal(existsSync(join(root, work.run.id)), false, '已经放进登记位置的那一份收走，登记过的旧目录也随清理删掉');
});

// The failure this guards: the sweep pulling, out from under a taking, the very directory the
// taking is about to move its files into. On a host where that removal lands between the
// making of the round's directory and the move, the move is the platform's to lose — on
// Windows a directory that vanishes mid-move is EPERM, and the answer to the caller is then
// the disk's, not the ledger's. So the passing sweep has to know the round's directory is
// being written in, exactly as it knows the taking's own temporary directory is.
test('取回正要把东西放进这一轮目录时清理发生：清理不碰取回要用的目录，登记被拒后照样收干净', async (t) => {
  const f = fixture(t);
  const work = endedWork(f, ago(8));
  register(f, work.run.id, [{ name: 'earlier.bundle', text: '上一份' }]);
  const before = f.ledger.artifactsOfRun(work.run.id)!;
  const runDir = join(releasesDir(f.dir), work.run.id);
  let stoodDuringSweep: boolean | null = null;
  let accept!: ReturnType<typeof createAcceptor>;
  accept = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      async fetchArtifacts(_run, into) {
        // The retention pass lands while this taking is under way: the mark, and then the
        // sweep that removes the round's directories.
        f.ledger.dropDueReleases(NOW);
        accept.sweep();
        stoodDuringSweep = existsSync(runDir);
        const body = Buffer.from('这一份没有登记上');
        writeFileSync(join(into, 'report.txt'), body);
        return { files: [{ name: 'report.txt', sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length }], problem: null };
      },
    },
  });

  const outcome = await accept.refetch(work.task.id);
  assert.equal(stoodDuringSweep, true, '清理不收走取回正要放进去的这一轮目录');
  assert.deepEqual(outcome.stored, []);
  assert.match(String(outcome.problem), /按保留期清理/, '登记说的是同一句保留期的话');
  const after = f.ledger.artifactsOfRun(work.run.id)!;
  assert.equal(after.registration?.id, before.registration?.id, '上一份登记不动');
  assert.deepEqual(after.registered, before.registered, '这次没有登记上');
  assert.deepEqual(
    { registration: after.registration, registered: after.registered, problem: after.problem },
    { registration: before.registration, registered: before.registered, problem: before.problem },
    'artifacts_json 一点没变，连失败原因也不写在这一轮上',
  );
  const root = releasesDir(f.dir);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(INCOMING)), [], '临时目录收走');
  assert.equal(existsSync(runDir), false, '取回结束后清理把这一轮目录也收走');
});

// The failure this guards: a taking whose move into place fails for a reason of the host's own
// — something standing under the name it goes to, a scanner holding the just-written file open
// (the field's EPERM) — reporting that reason when the round the retention rule cleared
// meanwhile is what decides what came of the taking. Nothing can be registered for that round
// any more, so the answer is the retention rule's refusal in the same words every reader uses,
// not the disk's complaint.
test('放好那一步坏在外面、这一轮又被清理：说的是保留期的话，不是磁盘的错', async (t) => {
  const f = fixture(t);
  const work = endedWork(f, ago(8));
  register(f, work.run.id, [{ name: 'earlier.bundle', text: '上一份' }]);
  const before = f.ledger.artifactsOfRun(work.run.id)!;
  const accept = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      async fetchArtifacts(run, into) {
        // The mark lands first, and then the move cannot be made: a directory stands under the
        // name the taking is going to, the same thing the platform does when a file inside the
        // directory being moved is still open.
        f.ledger.dropDueReleases(NOW);
        mkdirSync(join(releasesDir(f.dir), run.id, basename(into).slice(`${INCOMING}${run.id}-`.length)));
        const body = Buffer.from('这一份没有登记上');
        writeFileSync(join(into, 'report.txt'), body);
        return { files: [{ name: 'report.txt', sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length }], problem: null };
      },
    },
  });

  const outcome = await accept.refetch(work.task.id);
  assert.deepEqual(outcome.stored, []);
  assert.match(String(outcome.problem), /按保留期清理/, '说的是一轮已被清理，不是放好那一步的错');
  const after = f.ledger.artifactsOfRun(work.run.id)!;
  assert.equal(after.registration?.id, before.registration?.id, '上一份登记不动');
  assert.deepEqual(after.registered, before.registered, '这次没有登记上');
  assert.deepEqual(
    { registration: after.registration, registered: after.registered, problem: after.problem },
    { registration: before.registration, registered: before.registered, problem: before.problem },
    'artifacts_json 一点没变，连失败原因也不写在这一轮上',
  );
  const root = releasesDir(f.dir);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(INCOMING)), [], '临时目录收走');
  assert.equal(existsSync(join(root, work.run.id)), false, '挡路的那一份和这一轮的目录都由清理收走');
});

test('取回成功后清理：登记过的目录照样由 sweep 收走，不算还在写', async (t) => {
  const f = fixture(t);
  const work = endedWork(f, ago(8));
  const accept = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      async fetchArtifacts(_run, into) {
        const body = Buffer.from('报告');
        writeFileSync(join(into, 'report.txt'), body);
        return { files: [{ name: 'report.txt', sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length }], problem: null };
      },
    },
  });
  const outcome = await accept.refetch(work.task.id);
  assert.equal(outcome.problem, null, '取回成功应完成登记');
  const held = f.ledger.artifactsOfRun(work.run.id)!;
  assert.notEqual(held.registration, null, '这一份登记上了');
  const dir = registrationDir(f.dir, work.run.id, held.registration!.id);
  assert.equal(existsSync(dir), true);

  f.ledger.dropDueReleases(NOW);
  accept.sweep();
  assert.equal(existsSync(dir), false, '取回结束后不再算“正在写”，到期就被 sweep 收走');
  assert.equal(existsSync(join(releasesDir(f.dir), work.run.id)), false);
});

test('账本写不进去：到期标记和 change 都不写，目录也不动', (t) => {
  const f = fixture(t);
  const work = endedWork(f, ago(8));
  const product = register(f, work.run.id, [{ name: 'work.bundle', text: '代码包' }]);
  f.ledger.close();
  const readOnly = f.open({ readOnly: true });
  assert.throws(() => readOnly.dropDueReleases(NOW), DegradedError);
  assert.equal(runRow(f, work.run.id).releases_dropped_at, null);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'run.releases_drop'`).length, 0);
  assert.equal(existsSync(product.dir), true);
});

test('标记写下了、change 写不进去：一次回滚，标记也不留，目录还在', (t) => {
  const f = fixture(t);
  const work = endedWork(f, ago(8));
  const product = register(f, work.run.id, [{ name: 'work.bundle', text: '代码包' }]);
  // The mark is written first and the audit row after it: a failure in the row takes the
  // mark with it, so nothing reads as cleared while the record of clearing it is missing.
  f.force(`CREATE TRIGGER refuse_drop BEFORE INSERT ON change WHEN NEW.action = 'run.releases_drop' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  assert.throws(() => f.ledger.dropDueReleases(NOW), /boom/);
  assert.equal(runRow(f, work.run.id).releases_dropped_at, null);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'run.releases_drop'`).length, 0);
  assert.equal(existsSync(product.dir), true);
});

// A finished work that ran twice on the same machine: two rounds, one Task's code once.
function workOnMachine(f: Fixture, endedAt: string): { task: TaskRow; runs: RunRow[] } {
  const task = f.ledger.createTask({ projectId: f.projectId, title: '任务', goal: '目标', acceptance: '验收', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  const runs: RunRow[] = [];
  for (const note of [null, '再改一次']) {
    if (note !== null) f.ledger.reworkTask(task.id, note, f.task(task.id).revision, USER);
    const run = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.task(task.id).revision }, USER);
    f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id, 0, DONE);
    runs.push(f.run(run.id));
  }
  f.ledger.acceptTask(task.id, '看过', USER, { withoutReview: true });
  f.force('UPDATE task SET closed_at = ? WHERE id = ?', endedAt, task.id);
  return { task: f.task(task.id), runs };
}

function retentionBench(
  t: TestContext,
  options: {
    connected?: boolean; declared?: boolean; failing?: boolean; blocked?: boolean; noteFails?: boolean;
    sweep?: (f: Fixture) => void; onSend?: () => void;
  } = {},
) {
  const f = fixture(t);
  const sent: { machineId: string; taskDir: string }[] = [];
  const logs: string[] = [];
  const state = {
    connected: options.connected ?? true,
    declared: options.declared ?? true,
    failing: options.failing ?? false,
    blocked: options.blocked ?? false,
    noteFails: options.noteFails ?? false,
  };
  const retention = createRetention({
    ledger: {
      dropDueReleases: (now) => f.ledger.dropDueReleases(now),
      retentionDue: (now) => f.ledger.retentionDue(now),
      getMachine: (machineId) => f.ledger.getMachine(machineId),
      noteTaskCodeDropped: (taskId, machineId, nodeId) => {
        // The ledger closing under the pass, as it does while the service stops: the
        // machine's answer stands, the mark does not.
        if (state.noteFails) {
          state.noteFails = false;
          throw new Error('账本关着');
        }
        return f.ledger.noteTaskCodeDropped(taskId, machineId, nodeId);
      },
    },
    nodes: { connected: () => state.connected, reportedDropTaskCode: () => state.declared },
    channel: {
      async dropTaskCode(machineId, taskDir) {
        sent.push({ machineId, taskDir });
        if (state.failing) throw new Error('机器说这一轮还有进程');
        options.onSend?.();
      },
    },
    sweep: () => options.sweep?.(f),
    blocked: () => state.blocked,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  return { f, sent, logs, state, retention };
}

test('机器副本：连着且说了能收的，才为（任务，机器）发一次；成功后同一任务的每一轮都记上，不再发', async (t) => {
  const { f, sent, retention } = retentionBench(t);
  const { task, runs } = workOnMachine(f, ago(8));

  await retention.runOnce();
  assert.deepEqual(sent, [{ machineId: 'h1', taskDir: `tasks/${task.id}` }], '按任务和机器去重后只发一次');
  for (const run of runs) assert.equal(runRow(f, run.id).code_dropped_at !== null, true, `第 ${run.id} 轮记下了`);
  const changes = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'run.code_drop' ORDER BY seq`);
  assert.equal(changes.length, 1, '一组一条 change');
  assert.deepEqual(JSON.parse(changes[0]!.detail_json).runs, runs.map((run) => run.id));
  assert.equal(JSON.parse(changes[0]!.detail_json).days, 7);

  await retention.runOnce();
  assert.equal(sent.length, 1, '已经记下的一组不再发第二次');
});

test('机器副本：没连着、旧客户端没声明、机器已删除或换了节点身份，都不发也不记', async (t) => {
  const away = retentionBench(t, { connected: false });
  const awayWork = workOnMachine(away.f, ago(8));
  await away.retention.runOnce();
  assert.deepEqual(away.sent, [], '没连着不发');
  assert.equal(runRow(away.f, awayWork.runs[0]!.id).code_dropped_at, null);

  const old = retentionBench(t, { declared: false });
  const oldWork = workOnMachine(old.f, ago(8));
  await old.retention.runOnce();
  assert.deepEqual(old.sent, [], '旧客户端不声明就不发，它机器上的副本留着');
  assert.equal(runRow(old.f, oldWork.runs[0]!.id).code_dropped_at, null);

  const gone = retentionBench(t);
  const goneWork = workOnMachine(gone.f, ago(8));
  gone.f.ledger.deleteMachine('h1', USER, { confirmed: true });
  await gone.retention.runOnce();
  assert.deepEqual(gone.sent, [], '机器删了就不发');
  assert.equal(runRow(gone.f, goneWork.runs[0]!.id).code_dropped_at, null);

  const moved = retentionBench(t);
  const movedWork = workOnMachine(moved.f, ago(8));
  moved.f.force(`UPDATE machine SET node_id = 'node-somebody-else' WHERE id = 'h1'`);
  await moved.retention.runOnce();
  assert.deepEqual(moved.sent, [], '同名重接的机器不是原来那一台');
  assert.equal(runRow(moved.f, movedWork.runs[0]!.id).code_dropped_at, null);
});

test('机器副本：拒绝或断开什么都不记，下次再来', async (t) => {
  const { f, sent, logs, state, retention } = retentionBench(t, { failing: true });
  const { runs } = workOnMachine(f, ago(8));

  await retention.runOnce();
  assert.equal(sent.length, 1);
  assert.equal(runRow(f, runs[0]!.id).code_dropped_at, null, '没清成就不记');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'run.code_drop'`).length, 0);
  assert.match(logs.join('\n'), /下次再试/);

  state.failing = false;
  await retention.runOnce();
  assert.equal(sent.length, 2, '下一遍再发');
  assert.equal(runRow(f, runs[0]!.id).code_dropped_at !== null, true);
});

// The machine's answer is the evidence; the mark is this host's note of it. A ledger that
// closed under the pass (a stop, a degraded mode) must not lose the machine's confirmation
// for good: the next pass asks again, the directory is already gone so the client answers
// success, and the mark is written then. What this catches: a note that failed being treated
// as the copy still there, or the exception escaping and taking the pass down.
test('机器副本：机器说删了、账本没记下，下一遍重发（目录已不在也算成功）再记上', async (t) => {
  const { f, sent, logs, retention } = retentionBench(t, { noteFails: true });
  const { runs } = workOnMachine(f, ago(8));

  await retention.runOnce();
  assert.deepEqual(sent.map((each) => each.taskDir), [`tasks/${runs[0]!.task_id}`]);
  assert.equal(runRow(f, runs[0]!.id).code_dropped_at, null, '账本没记下');
  assert.match(logs.join('\n'), /代码副本清掉了，账本没记下/);

  await retention.runOnce();
  assert.equal(sent.length, 2, '下一遍再发一次');
  assert.equal(runRow(f, runs[0]!.id).code_dropped_at !== null, true, '这次记上了');
});

// Host copies: the sweep runs on every pass, not only one that marked something. A pass
// whose removal failed leaves the mark behind, so the next pass marks nothing new — and that
// is exactly when the retry has to happen.
test('主机产物：sweep 每一遍都跑，上一遍没删掉的下一次没有新标记也删', async (t) => {
  const calls: number[] = [];
  const { f, logs, retention } = retentionBench(t, {
    sweep: (fx) => {
      calls.push(1);
      if (calls.length === 1) throw new Error('删不掉');
      sweepReleases(fx.dir, (runId) => fx.ledger.artifactsOfRun(runId), new Set());
    },
  });
  const due = endedWork(f, ago(8));
  const product = register(f, due.run.id, [{ name: 'work.bundle', text: '代码包' }]);

  await retention.runOnce();
  assert.equal(calls.length, 1, '第一遍扫了，但删失败');
  assert.equal(existsSync(product.dir), true, '目录还在');
  assert.match(logs.join('\n'), /主机上的产物这一遍没有做完/);

  await retention.runOnce();
  assert.equal(calls.length, 2, '没有新标记也扫');
  assert.equal(existsSync(product.dir), false, '这一次删掉了');
});

// The start-up pass and the timer share one guard inside retention.runOnce: while the
// service is stopping, degraded or running its recovery inventory, a pass does nothing at
// all — no mark, no sweep, no machine asked.
test('正在停止、降级或恢复清点：这一遍什么都不做', async (t) => {
  let swept = 0;
  const { f, sent, retention, state } = retentionBench(t, { sweep: () => { swept += 1; } });
  const host = endedWork(f, ago(8));
  register(f, host.run.id, [{ name: 'work.bundle', text: '代码包' }]);
  const machine = workOnMachine(f, ago(8));

  state.blocked = true;
  await retention.runOnce();
  assert.equal(swept, 0, '不 sweep');
  assert.deepEqual(sent, [], '不找机器');
  assert.equal(runRow(f, host.run.id).releases_dropped_at, null, '不写主机标记');
  for (const run of machine.runs) assert.equal(runRow(f, run.id).code_dropped_at, null, '不写机器标记');
});

// A pass already sending commands meets the guard before its next one: what it already
// confirmed and recorded stands, and nothing after that goes out.
test('一遍里停下：发了一条之后服务开始停止，下一条不再发', async (t) => {
  let bench: ReturnType<typeof retentionBench>;
  bench = retentionBench(t, { onSend: () => { bench.state.blocked = true; } });
  const first = workOnMachine(bench.f, ago(8));
  const second = workOnMachine(bench.f, ago(8));

  await bench.retention.runOnce();
  assert.equal(bench.sent.length, 1, '只发了第一条命令');
  const marked = [first, second].filter(({ runs }) => runs.some((run) => runRow(bench.f, run.id).code_dropped_at !== null));
  assert.equal(marked.length, 1, '已确认的那一组照常记下，没发的那组不记');
  assert.ok(marked[0]!.runs.every((run) => runRow(bench.f, run.id).code_dropped_at !== null), '那一组每一轮都记上');
});

test('33 版账本升上来：两列有了，旧数据一行都没变', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./fixtures/ledger/schema-v33.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '33');
    INSERT INTO project (id, created_at, name) VALUES ('p', 'now', '旧项目');
    INSERT INTO task (id, created_at, project_id, title, goal, state, created_by, closed_at) VALUES ('t', 'now', 'p', '旧任务', '目标', 'done', 'user', '2026-01-01T00:00:00.000Z');
    INSERT INTO run (id, created_at, task_id, task_revision, host, state, marker, snapshot_json, artifacts_json)
      VALUES ('r', 'now', 't', 1, 'host', 'ended', 'm', '{"brief":"b"}', '{"registration":null,"registered":[],"problem":null}');`);
  const before = db.prepare('SELECT * FROM run ORDER BY rowid').all().map((row) => ({ ...row }));
  db.close();
  assert.equal(SCHEMA_VERSION, 46);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  try {
    const [run] = ledger.listRuns('t');
    assert.equal(run!.releases_dropped_at, null);
    assert.equal(run!.code_dropped_at, null);
  } finally {
    ledger.close();
  }
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = (after.prepare(`SELECT name FROM pragma_table_info('run')`).all() as { name: string }[]).map(({ name }) => name);
    assert.ok(columns.includes('releases_dropped_at'));
    assert.ok(columns.includes('code_dropped_at'));
    assert.deepEqual(after.prepare('SELECT * FROM run ORDER BY rowid').all().map((row) => ({ ...row })), before.map((row) => ({ ...row, releases_dropped_at: null, code_dropped_at: null, settlement_digest: null,capture_result_json:null })));
  } finally {
    after.close();
  }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});
