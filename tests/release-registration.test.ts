// Guards the one authority over what a round handed back (docs/design/roles-and-tiers.md
// §9 第 3 步): the ledger's registration. Against:
// - a taking whose directory is written but whose registration never commits (the service
//   dies in between, or the commit fails) becoming what acceptance, the release entry, the
//   page or the review binding read, while the registration and the pass on it still name
//   the earlier product;
// - a taking whose move into its own directory fails taking the earlier product's bytes
//   with it, so that the registration names files no longer on disk;
// - a directory on disk that no registration names being listed, applied or handed out;
//   the clean-up removing a directory any registration ever named, or the one a taking is
//   still writing, or leaving behind what nothing ever named;
// - a package path handed to the upgrade command disappearing because a later taking
//   replaced the registration meanwhile, and a historical bundle among the registered files
//   no longer being readable by name, digest and size;
// - a deleted project's copies: one directory that cannot be removed skipping the rest of the
//   round's or the ordinary pass, or a cleanup row being confirmed while one of its
//   directories is still there, or a confirmation that failed not being made good by the next
//   sweep;
// - the entries that put code on the host's checkout still existing;
// - files in the older layout (straight under releases/<run>/) being read as a product.
import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Account } from '../runner/snapshot.ts';
import { createAcceptor } from '../service/accept.ts';
import type { RunRow } from '../service/ledger.ts';
import { registeredFile, registeredPackage, registrationDir, releasesDir, removeDirNow } from '../service/releases.ts';
import { RELEASE_NEEDS_PASS_TEXT } from '../shared/review.ts';
import { consoleApp } from './console-helpers.ts';
import { codexTier, content, DONE, fixture, LOGIN, RUN_LIMIT_MS, USER, type Fixture } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();
const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
const CODEX: Account = { id: 't2', name: 't2', executor: 'codex', tiers: { decide: content('model=x'), execute: content('model=y') } };
const PASS = { status: 'done', summary: '审过', verdict: { result: 'pass', summary: '没问题' } };
const PACKAGE = 'tycho-1.2.0.tar.gz';

interface Product {
  // What the machine hands back, by name.
  files: { name: string; body: Buffer }[];
}

const identity = ({ name, body }: { name: string; body: Buffer }) => ({ name, sha256: sha(body), bytes: body.length });

// A Task whose implementation round is waiting to be accepted, with a machine that hands back
// whatever product it is given next. The code itself is no longer part of what comes back
// (docs/design/code-sources.md §6): what a taking registers is the files a round left, and the
// checkout a round's code is in is the machine's own (runner/snapshot.ts, node/source.ts).
async function stage(t: TestContext) {
  const machine: { next?: Product; hold?: Promise<void>; onFetch?: (run: RunRow, into: string) => void } = {};
  const app = await consoleApp(t, {
    runner: {
      async fetchArtifacts(run: RunRow, into: string) {
        await machine.hold;
        const product = machine.next!;
        mkdirSync(into, { recursive: true });
        for (const { name, body } of product.files) writeFileSync(join(into, name), body);
        machine.onFetch?.(run, into);
        return { files: product.files.map(identity), problem: null };
      },
    },
  });
  const { f } = app;
  f.ledger.putAccount(CODEX, USER, 'ref-t2');
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  assert.equal(f.task(task.id).state, 'ready');

  // One product of a round: a package, and a file from before code sources among the registered
  // files — a name and bytes a reader only ever reads back.
  const made = (text: string): Product => ({
    files: [
      { name: PACKAGE, body: Buffer.from(`发布包 ${text}`) },
      { name: 'work.bundle', body: Buffer.from(`bundle ${text}`) },
    ],
  });

  // A later taking of the round, registered in one step the way the acceptor ends one: its
  // own directory, its registration, and the sweep after it.
  const replaceWith = (product: Product): string => {
    const id = f.ledger.registerArtifacts(run.id, product.files.map(identity));
    const dir = registrationDir(f.dir, run.id, id);
    mkdirSync(dir, { recursive: true });
    for (const { name, body } of product.files) writeFileSync(join(dir, name), body);
    app.accept.sweep();
    return id;
  };

  // A pass of the product the Task holds now, by a reviewer that did not write it.
  const passed = async (): Promise<string> => {
    const registered = await app.accept.register(task.id);
    const review = f.ledger.createTask({ projectId: f.projectId, title: '审', goal: '审', acceptance: '结论', roleId: 'review', reviewOf: { taskId: task.id, ...registered } }, { actor: 'router' });
    f.ledger.queueTask(review.id, USER);
    const round = f.ledger.createRun(review.id, {
      login: f.ledger.getAccount('t2')!, machine: f.ledger.getMachine('h1')!, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'codex', tier: 'execute', tier_value: codexTier('/d') }, expectedRevision: 1,
    }, USER);
    f.ledger.markRunRunning(round.id);
    f.ledger.settleRun(round.id, 0, PASS as never, { codeCheck: { result: 'same' } });
    assert.equal(f.ledger.reviewGate(task.id), null);
    return registered.registration;
  };

  // The owner accepts it without taking the product over again: the gate in front of the main
  // line wants an accepted Task, and these tests are about which product the entries read.
  const accepted = (): void => {
    if (f.task(task.id).state !== 'done') f.ledger.acceptTask(task.id, '看过', USER, { withoutReview: true });
  };

  const runDir = join(releasesDir(f.dir), run.id);
  const subdirs = (): string[] => (existsSync(runDir) ? readdirSync(runDir).sort() : []);
  const held = () => f.ledger.artifactsOfRun(run.id);
  const ask = (product: Product, name: string) => {
    const file = identity(product.files.find((each) => each.name === name)!);
    return { run_id: run.id, ...file };
  };

  // Every entry that reads a product, asked about one product and its opposite: what it
  // offers, hands out or lets through has to be `current`'s and never `other`'s.
  async function onlySees(current: Product, other: Product): Promise<void> {
    const page = await json(await app.get(`/api/tasks/${task.id}`));
    const pkg = identity(current.files[0]!);
    const bundle = identity(current.files[1]!);
    assert.deepEqual(page.releases.packages.map((each: { sha256: string }) => each.sha256), [pkg.sha256], '页面只列登记的那一份发布包');
    // The release entry: the package it would start the upgrade on, and its gate.
    const chosen = registeredPackage(f.dir, held(), identity(current.files[0]!));
    assert.equal(chosen !== null && readFileSync(chosen.file).equals(current.files[0]!.body), true, '上线用登记的那一份字节');
    assert.equal(registeredPackage(f.dir, held(), identity(other.files[0]!)), null, '上线不认没登记的那一份');
    // A historical bundle among the registered files is still readable by name, digest and
    // size; one from another taking is not. Nothing makes a new one, and the entries that
    // put code on the host's checkout are gone.
    assert.notEqual(registeredFile(f.dir, held(), bundle), null);
    assert.equal(registeredFile(f.dir, held(), identity(other.files[1]!)), null, '拿不到没登记的那一份');
    assert.equal((await app.post(`/api/tasks/${task.id}/merge`, ask(other, 'work.bundle'))).status, 404, '合入本机检出的接口已删');
    assert.equal((await app.post(`/api/tasks/${task.id}/integrate`, { ...ask(other, 'work.bundle'), branch: 'main' })).status, 400, '并入接口只接受 PR，绝不接受本机 bundle');
  }

  return { ...app, machine, task, run, made, passed, accepted, replaceWith, runDir, subdirs, held, ask, onlySees };
}

test('登记提交前崩溃：目录写好了、账本没提交，重启后每个入口只看到旧登记那一份，旧结论只对它有效', async (t) => {
  const s = await stage(t);
  const old = s.made('old');
  s.machine.next = old;
  const first = await s.passed();
  const fresh = s.made('fresh');

  // What a crash between the move and the commit leaves: a whole directory of the new
  // product beside the registered one, and nothing about it in the ledger.
  const orphan = join(s.runDir, '01ORPHANED0000000000000000');
  mkdirSync(orphan);
  for (const { name, body } of fresh.files) writeFileSync(join(orphan, name), body);
  // The service starts again: the same ledger, the same data directory.
  const restarted = await consoleApp(t, { f: s.f });
  assert.equal(s.held()?.registration?.id, first, '登记还是旧的那一份');
  await s.onlySees(old, fresh);
  assert.equal(s.f.ledger.releaseGate(s.run.id, identity(old.files[0]!)), null, '旧结论对旧那一份照旧有效');
  assert.equal(s.f.ledger.releaseGate(s.run.id, identity(fresh.files[0]!)), RELEASE_NEEDS_PASS_TEXT, '旧结论不覆盖没登记的那一份');
  // The clean-up a starting service does takes the orphan away and nothing else.
  restarted.accept.sweep();
  assert.deepEqual(s.subdirs(), [first]);

  // The same window, reached by a commit that fails: the taking fails safely, falls back to the
  // earlier registration whose bytes stand untouched, notes the problem, and removes the new dir.
  s.machine.next = fresh;
  const dying = createAcceptor({
    ledger: { ...s.f.ledger, registerArtifacts: () => { throw new Error('服务在这里没了'); } },
    runner: s.runner,
    dataDir: s.f.dir,
  });
  const fallback = await dying.register(s.task.id);
  assert.equal(fallback.registration, first);
  assert.match(s.held()?.problem?.problem ?? '', /服务在这里没了/);
  assert.equal(s.held()?.registration?.id, first);
  await s.onlySees(old, fresh);
  assert.deepEqual(s.subdirs(), [first], '没登记上的新目录被收走，旧目录不动');

  // Accepting goes by the registration, and offers what it names.
  const accepted = await s.post(`/api/tasks/${s.task.id}/accept`, { basis: '审阅通过' });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await json(accepted)).artifacts, { stored: old.files.map(({ name }) => name), problem: null });
});

test('换成编号目录那一步失败：上一份登记和它的目录完好，验收、上线、并入照旧用上一份', async (t) => {
  const s = await stage(t);
  const old = s.made('old');
  s.machine.next = old;
  const first = await s.passed();
  const bytes = () => readdirSync(join(s.runDir, first)).sort().map((name) => sha(readFileSync(join(s.runDir, first, name))));
  const before = bytes();

  // The next taking comes back whole, but the move into its own directory fails: a
  // directory with something in it already stands under that name, which no platform's
  // rename replaces.
  const fresh = s.made('fresh');
  s.machine.next = fresh;
  s.machine.onFetch = (run, into) => {
    const id = basename(into).slice(`.incoming-${run.id}-`.length);
    mkdirSync(join(s.runDir, id));
    writeFileSync(join(s.runDir, id, 'in-the-way'), '挡路的文件');
  };
  const fallback = await s.accept.register(s.task.id);
  delete s.machine.onFetch;
  assert.equal(fallback.registration, first);
  assert.match(s.held()?.problem?.problem ?? '', /没有放好/);
  assert.equal(s.held()?.registration?.id, first);
  assert.deepEqual(bytes(), before, '上一份的字节一个没动');
  assert.equal(readdirSync(releasesDir(s.f.dir)).some((name) => name.startsWith('.incoming-')), false, '临时目录收走了');
  await s.onlySees(old, fresh);
  assert.equal(s.f.ledger.reviewGate(s.task.id), null, '通过还算数');
  assert.equal(s.f.ledger.releaseGate(s.run.id, identity(old.files[0]!)), null);
});

test('磁盘上有、账本没登记的目录谁都看不见；清理收走它们，不碰正在写的和被登记的', async (t) => {
  const s = await stage(t);
  const old = s.made('old');
  s.machine.next = old;
  const first = (await s.accept.register(s.task.id)).registration;
  const fresh = s.made('fresh');

  // Left by takings that never finished: one moved into place, one never moved.
  const stray = join(s.runDir, '01STRAY00000000000000000000');
  mkdirSync(stray);
  for (const { name, body } of fresh.files) writeFileSync(join(stray, name), body);
  const stale = join(releasesDir(s.f.dir), `.incoming-${s.run.id}-01STALE`);
  mkdirSync(stale);
  // And a round's files in the older layout, straight under its directory.
  const legacy = join(releasesDir(s.f.dir), s.run.id, 'work.bundle');
  writeFileSync(legacy, fresh.files[1]!.body);
  await s.onlySees(old, fresh);

  // A taking under way, held while it writes.
  let release!: () => void;
  s.machine.hold = new Promise<void>((resolve) => { release = resolve; });
  s.machine.next = fresh;
  const taking = s.accept.register(s.task.id);
  await new Promise((resolve) => setImmediate(resolve));
  const writing = readdirSync(releasesDir(s.f.dir)).filter((name) => name.startsWith('.incoming-') && join(releasesDir(s.f.dir), name) !== stale);
  assert.equal(writing.length, 1, '正在写的临时目录在');

  s.accept.sweep();
  assert.equal(existsSync(stray), false, '没登记的编号目录被收走');
  assert.equal(existsSync(stale), false, '没人在写的临时目录被收走');
  assert.equal(existsSync(join(releasesDir(s.f.dir), writing[0]!)), true, '正在写的不碰');
  assert.equal(existsSync(join(s.runDir, first)), true, '被登记的不碰');
  assert.equal(existsSync(legacy), true, '旧格式的文件不读、不删');

  // The taking finishes: its registration is the product now, on the page and for a merge.
  // The directory it replaced was registered once, and stays: it is never read as the
  // product again, but a review's binding names it and a reader may still be in it.
  release();
  const second = (await taking).registration;
  assert.equal(s.held()?.registration?.id, second);
  await s.onlySees(fresh, old);
  s.accept.sweep();
  assert.deepEqual(s.subdirs().filter((name) => name !== 'work.bundle'), [first, second].sort());
});

test('交给独立升级命令的包路径，在登记被换成新的一份之后仍在、字节不变', async (t) => {
  const s = await stage(t);
  const old = s.made('old');
  s.machine.next = old;
  const first = await s.passed();
  // What the release entry writes into the intent and hands to the upgrade command.
  const chosen = registeredPackage(s.f.dir, s.held(), identity(old.files[0]!))!;
  assert.equal(chosen.file.startsWith(join(s.runDir, first)), true);
  // A later taking replaces the registration before the command has copied the package.
  s.machine.next = s.made('fresh');
  await s.accept.register(s.task.id);
  s.accept.sweep();
  assert.notEqual(s.held()?.registration?.id, first);
  assert.equal(readFileSync(chosen.file).equals(old.files[0]!.body), true, '升级命令要读的那个包还在');
});

// A deleted project's cleanup row, as the ledger is left holding one: the project's own rows
// are gone with it, so this is seeded raw rather than through an operation under test.
function deletedCleanup(f: Fixture, cleanupId: string, runId: string, registrations: readonly string[]): void {
  f.force(
    `INSERT INTO work_cleanup (id, created_at, project_id, project_name, run_id, task_id, machine_id, node_id, releases_json, releases_dropped_at, code_dropped_at)
     VALUES (?, ?, 'p-gone', '删掉的项目', ?, 't-gone', NULL, NULL, ?, NULL, NULL)`,
    cleanupId, new Date().toISOString(), runId, JSON.stringify(registrations),
  );
}

const cleanupMarks = (f: Fixture): Map<string, string | null> =>
  new Map(f.peek<{ id: string; releases_dropped_at: string | null }>('SELECT id, releases_dropped_at FROM work_cleanup').map((row) => [row.id, row.releases_dropped_at]));

// The removal a test hands the acceptor: exactly the named directories refuse, and every other
// one is removed the way the service removes it.
function refusing(...paths: string[]): (path: string) => boolean {
  const refused = new Set(paths);
  return (path) => (refused.has(path) ? false : removeDirNow(path));
}

test('一份删除产物的目录删不掉，其余照常清掉，只有真清完的记录被确认', (t) => {
  const f = fixture(t);
  const stuckRun = '01GONE-STUCK';
  const otherRun = '01GONE-OTHER';
  const stuck = registrationDir(f.dir, stuckRun, '01REG-STUCK');
  const first = registrationDir(f.dir, otherRun, '01REG-FIRST');
  const second = registrationDir(f.dir, otherRun, '01REG-SECOND');
  // Two rounds of projects the ledger no longer holds: one whose only directory refuses, one
  // with two directories of its own.
  deletedCleanup(f, 'cleanup-stuck', stuckRun, ['01REG-STUCK']);
  deletedCleanup(f, 'cleanup-other', otherRun, ['01REG-FIRST', '01REG-SECOND']);
  for (const dir of [stuck, first, second]) mkdirSync(dir, { recursive: true });
  const accept = createAcceptor({ ledger: f.ledger, dataDir: f.dir, removeDir: refusing(stuck) });

  accept.sweep();

  assert.equal(existsSync(stuck), true, '删不掉的那一份留着，等下一次 sweep');
  assert.equal(existsSync(first), false, '同一轮里没被拒的那一份照常删掉');
  assert.equal(existsSync(second), false, '这一轮的第三份目录也照常删掉');
  assert.equal(existsSync(join(releasesDir(f.dir), otherRun)), false, '空了的整轮目录一起删掉');
  assert.equal(existsSync(join(releasesDir(f.dir), stuckRun)), true, '还有删不掉的目录，整轮目录留着');
  const marks = cleanupMarks(f);
  assert.equal(marks.get('cleanup-stuck'), null, '没清完的记录不确认');
  assert.notEqual(marks.get('cleanup-other'), null, '真清完的记录被确认');
});

test('清理确认写库失败后，重启再清一次会补上确认', (t) => {
  const f = fixture(t);
  const runId = '01GONE-MARK';
  const dir = registrationDir(f.dir, runId, '01REG-MARK');
  deletedCleanup(f, 'cleanup-mark', runId, ['01REG-MARK']);
  mkdirSync(dir, { recursive: true });
  // The commit point fails once, as a ledger that cannot be written just now does.
  let fails = true;
  const accept = createAcceptor({
    ledger: {
      ...f.ledger,
      noteDeletedReleasesDropped: (ids: readonly string[]) => {
        if (fails) { fails = false; throw new Error('账本写不进去'); }
        f.ledger.noteDeletedReleasesDropped(ids);
      },
    },
    dataDir: f.dir,
  });

  accept.sweep();
  assert.equal(existsSync(dir), false, '字节已经删了');
  assert.equal(existsSync(join(releasesDir(f.dir), runId)), false, '空了的整轮目录也删了');
  assert.equal(cleanupMarks(f).get('cleanup-mark'), null, '确认没写进去，这一行还留着，下一次再清');

  // The service starts again: a fresh acceptor on the same data directory. Removal is
  // idempotent, so this pass has nothing left to remove and only makes the confirmation good.
  createAcceptor({ ledger: f.ledger, dataDir: f.dir }).sweep();
  assert.notEqual(cleanupMarks(f).get('cleanup-mark'), null, '再清一次补上确认');
});
