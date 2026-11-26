// Guards the B block of code sources (docs/design/code-sources.md §2, §3): which machine a
// Task's rounds go to by the source it is pinned to, what one round is told about that source,
// and that the material is handed to the executor by the machine's own working directory.
//
// What this file is here to catch:
//   - a folder source's Task dispatched anywhere but the one machine the owner named, or
//     taken for a machine whose registration is gone instead of stopping with the reason;
//   - a repository source's later round starting on another machine than the one its first
//     round ran on (the checkout lives there, and the next round would find none of it);
//   - a Task pinned to a source the project no longer has going on as if it did;
//   - a folder source's machine being offline read as "no machine at all", with no reason on
//     the Task page, and an older client's machine being offered work it would misread;
//   - a round told about a source in a shape the machine cannot prepare, or the snapshot
//     losing the source altogether;
//   - a brief that does not say where the code is, or the material path not being handed to
//     Claude by --add-dir.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import type { DispatcherOptions } from '../service/dispatcher.ts';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import { roundTurn } from '../runner/snapshot.ts';
import type { Snapshot } from '../runner/snapshot.ts';
import { waitLine } from '../shared/labels.ts';
import { ARTIFACTS_PLACEHOLDER, MATERIALS_PLACEHOLDER } from '../shared/node-protocol.ts';
import { bindingKey, snapshotSourceOf, type Source } from '../shared/sources.ts';
import { claudeTier, DISPATCH_TUNED, fixture, memoryLogins, memoryMachines, testMachine, tuned, USER } from './helpers.ts';

const LOGIN = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };

// One dispatcher over a fixture, with machines the ledger knows (so that a folder source's
// registration id can be resolved) and a runner whose machine choice the test decides.
function setup(
  t: TestContext,
  machineIds: string[],
  dispatching: Partial<DispatcherOptions> = {},
  choose: (offered: string[]) => string | undefined = (offered) => offered[0],
) {
  const f = fixture(t);
  const launched: RunRow[] = [];
  const offered: string[][] = [];
  memoryMachines(Object.fromEntries(machineIds.map((id) => [id, testMachine(id)])), f.ledger).list();
  const machines = { get: (id: string) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() };
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    ...dispatching,
    runner: {
      findMachine: async (_login, candidates) => {
        offered.push(candidates.map(({ id }) => id));
        const id = choose(candidates.map((each) => each.id));
        return id === undefined ? undefined : candidates.find((each) => each.id === id);
      },
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => { launched.push(run); },
      watch: async () => {},
    },
    logins: memoryLogins({ [LOGIN.id]: LOGIN }, f.ledger),
    machines,
    executors: { claude: claudeAdapter },
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  // A Task of the project, pinned to `source` (the ledger's own columns written directly, so
  // that this fixture needs no source of its own).
  const queued = (source?: Source): TaskRow => {
    const task = f.ledger.createTask(
      { projectId: f.projectId, title: '任务', goal: '目标', acceptance: '测试通过', loginId: 't1', roleId: 'implement' },
      USER,
    );
    if (source !== undefined) f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: source.id, pinned: source }), task.id);
    f.ledger.queueTask(task.id, USER);
    return f.task(task.id);
  };
  const sources = (list: Source[]): void => f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify(list), f.projectId);
  const snapshotOf = (run: RunRow): Snapshot => JSON.parse(run.snapshot_json) as Snapshot;
  const finish = (run: RunRow): void => {
    f.ledger.markRunRunning(run.id);
    f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
    if (f.task(run.task_id).state === 'ready') f.ledger.updateTask(run.task_id, { goal: `目标 ${run.id}` }, USER);
    f.ledger.resumeTask(run.task_id, USER);
  };
  return { f, dispatcher, launched, offered, queued, sources, snapshotOf, finish };
}

const folderSource = (machineUid: string, path: string): Source => ({ id: 's-folder', kind: 'folder', machine_uid: machineUid, path });
const repoSource = (url = 'https://example.test/owner/project.git', id = 's-repo'): Extract<Source, { kind: 'repo' }> => ({ id, kind: 'repo', url });

test('a folder source goes only to the machine the owner named, whatever the project allows', async (t) => {
  const { f, dispatcher, launched, offered, queued, sources } = setup(t, ['h1', 'h2']);
  const h2 = f.ledger.getMachine('h2')!;
  // The project allows h1 alone; the folder names h2. The owner named it, so it wins.
  f.ledger.setProjectMachines(f.projectId, [f.ledger.getMachine('h1')!.uid], USER);
  const source = folderSource(h2.uid, '/srv/project');
  sources([source]);
  queued(source);
  await dispatcher.tick();
  assert.deepEqual(offered, [['h2']]);
  assert.equal(launched[0]?.host, 'h2');
});

test('a repository source starts on any allowed machine, and its later rounds prefer the first round\'s machine while keeping fallback machines', async (t) => {
  let round = 0;
  const { dispatcher, launched, offered, queued, sources, snapshotOf, finish } = setup(t, ['h1', 'h2'], {}, (ids) => (round++ === 0 ? ids.at(-1) : ids[0]));
  const source = repoSource();
  sources([source]);
  const task = queued(source);
  await dispatcher.tick();
  assert.deepEqual(offered[0], ['h1', 'h2'], '第一轮可以落在任何允许的机器上');
  assert.equal(launched[0]?.host, 'h2');
  assert.deepEqual(snapshotOf(launched[0]!).source, snapshotSourceOf(source), '这一轮带上来源的绑定身份：机器按它分开保存副本');
  finish(launched[0]!);
  await dispatcher.tick();
  assert.deepEqual(offered[1], ['h2', 'h1'], '第二轮优先排第一轮那台，其余允许的机器作为备选');
  assert.equal(launched[1]?.host, 'h2');
  assert.equal(launched[1]?.task_id, task.id);
});

// §8.7: repinning a Task to another source is what lets the old machine go. The old rounds are
// another source's work, so their machine holds nothing for the source the Task names now —
// and a Task whose first source's machine has since been deleted can go on.
test('repinning a Task to another source clears the old machine\'s hold on it', async (t) => {
  const { f, dispatcher, launched, queued, sources, finish } = setup(t, ['h1', 'h2'], {}, (ids) => ids.at(-1));
  const first = repoSource('https://example.test/owner/one.git', 's-one');
  const second = repoSource('https://example.test/owner/two.git', 's-two');
  sources([first, second]);
  const task = queued(first);
  await dispatcher.tick();
  assert.equal(launched[0]?.host, 'h2');
  finish(launched[0]!);
  // The owner repins the Task: the ledger's own column, as update_task writes it.
  f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({ source_id: second.id, pinned: second }), task.id);
  f.ledger.deleteMachine('h2', USER, { confirmed: true });
  await dispatcher.tick();
  assert.equal(launched.length, 2, '旧来源的机器没了不再拦住改派后的任务');
  assert.equal(launched[1]?.host, 'h1', '新来源重新从允许的机器里挑');
  assert.deepEqual(JSON.parse(launched[1]!.snapshot_json).source, snapshotSourceOf(second));
});

test('a Task pinned to a source the project no longer has stops and says so', async (t) => {
  const { f, dispatcher, launched, queued, sources } = setup(t, ['h1']);
  const source = repoSource();
  sources([]);
  const task = queued(source);
  await dispatcher.tick();
  assert.equal(launched.length, 0);
  assert.equal(f.task(task.id).state, 'held');
  assert.match(f.task(task.id).reason!, /来源已经不在项目里了/);
  assert.match(f.task(task.id).reason!, /example\.test/);
});

// §8.11 in createRun's own transaction: the source was there when the Task was read, and the
// owner deleted it while a machine was being asked. The wait before createRun is not a promise,
// so a check made before it is not a check: the round would be created and launched for a source
// the project no longer has, and the Task's pin would say `removed` while it runs.
test('a source deleted while the machine is being asked is refused in the same transaction: no Run is made', async (t) => {
  let remove: (() => void) | undefined;
  const { f, dispatcher, launched, queued, sources } = setup(t, ['h1'], {}, (ids) => {
    remove?.();
    return ids[0];
  });
  const source = repoSource();
  sources([source]);
  const task = queued(source);
  // The owner deletes it in the middle of the dispatch, after the Task was read and the machine picked.
  remove = () => sources([]);
  await dispatcher.tick();
  assert.equal(launched.length, 0, '来源在派发的中途没了：这一轮不开工');
  assert.equal(f.ledger.listActiveRuns().filter((run) => run.task_id === task.id).length, 0, '没有为它建 Run');
  assert.equal(f.task(task.id).state, 'queued', '这一轮没开，任务留在队列里');
  // And the next round reads the pin against the list as it is now: it stops with the reason.
  await dispatcher.tick();
  assert.equal(f.task(task.id).state, 'held');
  assert.match(f.task(task.id).reason!, /来源已经不在项目里了/);
});

// The same last gate, asked directly: a snapshot prepared for another binding of the same source
// id (the owner re-pointed it while the dispatcher was working) must not be sent, and a folder
// source travels only to the machine it names — not to another machine the project happens to allow.
test('createRun refuses a snapshot for another binding, and a folder sent to another machine', async (t) => {
  const { f, queued, sources } = setup(t, ['h1', 'h2']);
  const login = f.ledger.getAccount('t1')!;
  const h1 = f.ledger.getMachine('h1')!;
  const h2 = f.ledger.getMachine('h2')!;
  const source = repoSource();
  sources([source]);
  const repoTask = queued(source);
  const moved = { ...source, url: 'https://example.test/other.git' };
  assert.throws(
    () => f.ledger.createRun(repoTask.id, { login, machine: h1, snapshot: { timeout_ms: 60_000, brief: 'b', source: snapshotSourceOf(moved) }, expectedRevision: repoTask.revision }, USER),
    /代码来源和它现在钉的不是一个/,
  );
  // The binding the Task actually holds is accepted, so the gate is about the binding, not size.
  assert.equal(f.ledger.createRun(repoTask.id, { login, machine: h1, snapshot: { timeout_ms: 60_000, brief: 'b', source: snapshotSourceOf(source) }, expectedRevision: repoTask.revision }, USER).machine_id, 'h1');

  const folder = folderSource(h2.uid, '/srv/project');
  sources([folder]);
  const folderTask = queued(folder);
  assert.throws(
    () => f.ledger.createRun(folderTask.id, { login, machine: h1, snapshot: { timeout_ms: 60_000, brief: 'b', source: snapshotSourceOf(folder) }, expectedRevision: folderTask.revision }, USER),
    /只能派到它所在的那台机器/,
  );
  assert.equal(f.ledger.createRun(folderTask.id, { login, machine: h2, snapshot: { timeout_ms: 60_000, brief: 'b', source: snapshotSourceOf(folder) }, expectedRevision: folderTask.revision }, USER).machine_id, 'h2');
});

test('a Task whose folder source machine is gone stops and says so, and one merely offline waits with the reason', async (t) => {
  // The machine's registration is gone: the Task stops; waiting would never end.
  const gone = setup(t, ['h1']);
  gone.sources([folderSource('uid-that-is-gone', '/srv/project')]);
  const stopped = gone.queued(folderSource('uid-that-is-gone', '/srv/project'));
  await gone.dispatcher.tick();
  assert.equal(gone.f.task(stopped.id).state, 'held');
  assert.match(gone.f.task(stopped.id).reason!, /那台机器已经不在了/);

  // The machine is registered but not here: the Task waits, and the page says which machine.
  const offline = setup(t, ['h1'], { connected: () => false }, () => undefined);
  const source = folderSource(offline.f.ledger.getMachine('h1')!.uid, '/srv/project');
  offline.sources([source]);
  const waiting = offline.queued(source);
  await offline.dispatcher.tick();
  assert.equal(offline.f.task(waiting.id).state, 'queued', '离线是等，不是停住');
  assert.equal(offline.launched.length, 0);
  const wait = offline.dispatcher.waitOf(offline.f.task(waiting.id))!;
  assert.equal(wait.source_offline, 'h1');
  assert.equal(waitLine(wait), '等 h1 上线');
});

test('a machine whose client speaks another protocol takes no work, and the Task says it waits for the upgrade', async (t) => {
  const { f, dispatcher, launched, queued, sources } = setup(t, ['h1'], { refusedProtocol: (id) => id === 'h1' }, () => undefined);
  const source = repoSource();
  sources([source]);
  const task = queued(source);
  await dispatcher.tick();
  assert.equal(launched.length, 0, '旧客户端不接活');
  const wait = dispatcher.waitOf(f.task(task.id))!;
  assert.deepEqual(wait.outdated, ['h1']);
  assert.match(waitLine(wait)!, /升级到与主机同一版/);
});

test('a repository source round whose first machine is gone falls back to another eligible machine', async (t) => {
  const { f, dispatcher, launched, queued, sources, finish } = setup(t, ['h1', 'h2'], {}, (ids) => ids.at(-1));
  const source = repoSource();
  sources([source]);
  const task = queued(source);
  await dispatcher.tick();
  assert.equal(launched[0]?.host, 'h2');
  finish(launched[0]!);
  f.ledger.deleteMachine('h2', USER, { confirmed: true });
  await dispatcher.tick();
  assert.equal(launched.length, 2, '第一轮机器下线/删除后自动回退到其余可用机器');
  assert.equal(launched[1]?.host, 'h1');
  assert.equal(launched[1]?.task_id, task.id);
});

test('a repository task is NOT preferred on h2 after not_started/worker_not_started, prefers h2 when alive after a started Run, and falls back to h1 if h2 is gone', async (t) => {
  // 1. First Run failed before reaching the node (lost.basis = 'not_started'): next tick moves freely to h1.
  {
    const { f, dispatcher, launched, queued, sources } = setup(t, ['h1', 'h2'], {}, (ids) => ids.at(-1));
    const source = repoSource();
    sources([source]);
    const task = queued(source);
    await dispatcher.tick();
    const firstRun = launched[0]!;
    assert.equal(firstRun.machine_id, 'h2');
    f.ledger.settleRun(firstRun.id, null, null, { kind: 'lost', lost: { basis: 'not_started' } });
    assert.equal(f.task(task.id).state, 'queued');
    f.ledger.deleteMachine('h2', USER, { confirmed: true });
    await dispatcher.tick();
    assert.equal(launched.length, 2, '任务没有被钉死在未启动的 h2 上，顺利改派到 h1');
    assert.equal(launched[1]!.machine_id, 'h1');
  }

  // 2. First Run failed with worker_not_started (node refused before worker started): next tick also moves freely to h1.
  {
    const { f, dispatcher, launched, queued, sources } = setup(t, ['h1', 'h2'], {}, (ids) => ids.at(-1));
    const source = repoSource();
    sources([source]);
    const task = queued(source);
    await dispatcher.tick();
    const firstRun = launched[0]!;
    assert.equal(firstRun.machine_id, 'h2');
    f.ledger.settleRun(firstRun.id, 127, null, { workerNotStarted: 'claude 未安装' });
    assert.equal(f.task(task.id).state, 'held');
    f.ledger.resumeTask(task.id, USER);
    f.ledger.deleteMachine('h2', USER, { confirmed: true });
    await dispatcher.tick();
    assert.equal(launched.length, 2, 'worker_not_started 轮次也不钉死坏机器，顺利改派到 h1');
    assert.equal(launched[1]!.machine_id, 'h1');
  }

  // 3. First Run actually started and failed with exit code 1: if h2 is deleted, repo task falls back to h1 instead of holding.
  {
    const { f, dispatcher, launched, queued, sources } = setup(t, ['h1', 'h2'], {}, (ids) => ids.at(-1));
    const source = repoSource();
    sources([source]);
    const task = queued(source);
    await dispatcher.tick();
    const firstRun = launched[0]!;
    assert.equal(firstRun.machine_id, 'h2');
    f.ledger.settleRun(firstRun.id, 1, null, { reason: '执行异常' });
    assert.equal(f.task(task.id).state, 'held');
    f.ledger.resumeTask(task.id, USER);
    f.ledger.deleteMachine('h2', USER, { confirmed: true });
    await dispatcher.tick();
    assert.equal(launched.length, 2);
    assert.equal(launched[1]!.machine_id, 'h1');
  }
});

test('snapshotSourceOf keeps a source\'s own shape and its binding identity, and a review adds the commit it checks out', () => {
  const repo = { id: 's1', kind: 'repo' as const, url: 'https://example.test/a.git' };
  assert.deepEqual(snapshotSourceOf(repo), { kind: 'repo', url: repo.url, binding_key: bindingKey(repo) });
  // The identity is the id plus the content: the same id re-pointed elsewhere is another binding,
  // so the machine's checkout directory and the host's evidence comparison cannot be reused.
  assert.notEqual(bindingKey(repo), bindingKey({ ...repo, url: 'https://example.test/b.git' }));
  const folder = { id: 's2', kind: 'folder' as const, machine_uid: 'u1', path: '/srv/x' };
  assert.deepEqual(snapshotSourceOf(folder), { kind: 'folder', path: '/srv/x', binding_key: bindingKey(folder) });
  assert.notEqual(bindingKey(folder), bindingKey({ ...folder, path: '/srv/y' }));
});

test('a round is told the material by the machine\'s own path, and Claude is given it by --add-dir', () => {
  const snapshot: Snapshot = { brief: 'b', history: [], executor: 'claude', tier: 'execute', tier_value: claudeTier('/t'), timeout_ms: 60_000, source: snapshotSourceOf({ id: 's1', kind: 'repo', url: 'https://example.test/a.git' }) };
  const turn = roundTurn(snapshot, 'r1');
  assert.equal(turn.materialsDir, MATERIALS_PLACEHOLDER);
  assert.equal(turn.artifactsDir, ARTIFACTS_PLACEHOLDER);
  assert.match(turn.prompt, new RegExp(`^请先读 ${MATERIALS_PLACEHOLDER.replace(/[{}]/g, '\\$&')}/brief\\.md`));
  assert.equal(turn.tierPath, `${MATERIALS_PLACEHOLDER}/tier.json`);
  const launch = claudeAdapter.launch({ ...turn, tierPath: '/snapshot/tier.json' });
  const dirs = launch.argv.flatMap((arg, at) => (arg === '--add-dir' ? [launch.argv[at + 1]] : []));
  assert.ok(dirs.includes('.'), '工作目录照旧加进去');
  assert.ok(dirs.includes(MATERIALS_PLACEHOLDER), '这一轮的材料目录也在里面');
  assert.ok(dirs.includes(ARTIFACTS_PLACEHOLDER), '交东西的目录也在里面，否则可写不成立');
  // Even a read-only round gets artifactsDir so review/report artifacts can be delivered.
  const read = claudeAdapter.launch({ ...turn, tierPath: '/snapshot/tier.json', readOnly: true });
  const readDirs = read.argv.flatMap((arg, at) => (arg === '--add-dir' ? [read.argv[at + 1]] : []));
  assert.ok(readDirs.includes(MATERIALS_PLACEHOLDER));
  assert.equal(readDirs.includes(ARTIFACTS_PLACEHOLDER), true, '只读的一轮也带交付目录，用于写报告或产物');
});
