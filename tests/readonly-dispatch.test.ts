// Guards how a read-only role reaches a machine (docs/design/roles-and-tiers.md §5, §9 step
// 4): only to a machine whose own report says that executor's read-only way starts there.
//
// What this file is here to catch:
//   - a read-only Task sent to a machine that said its read-only way does not start, or that
//     has not said at all — and, failing that, run writable instead of waiting;
//   - a read-only Task that cannot go anywhere waiting in silence, or held while a machine
//     that has not reported yet may still say yes;
//   - the pick, a pin and the Run's creation judging read-only by different rules, so that
//     one of them lets through what another refused;
//   - a tier's permission setting loosening the round, or dsh — which offers no read-only way —
//     taking read-only work; and a Codex or Claude tier refused it for what else it holds
//     (the read-only way is the executor's own, and the check after the round finds a change);
//   - a machine whose client does not say it checks a read-only round's code given one;
//   - the round sent again after one whose result was not taken continuing that session, or not
//     told why — or told to keep test output outside the code directory when its read-only way
//     cannot write one anywhere;
//   - a stored tier with a permission key silently stripped, or sent as it is;
//   - a dsh too old for --permission-mode given any work on that machine;
//   - a snapshot that does not say how the round was made read-only, and to which layer;
//   - a read-only round whose upload failed moved to a machine that cannot run it read-only;
//   - the machine, the session and the snapshot chosen on different reads of the role, when
//     the owner changes it while a machine is being asked;
//   - an old client's report of an old dsh taken for usable because it did not say so itself.
import './guard.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner } from '../runner/runner.ts';
import type { Account, Machine, Snapshot } from '../runner/snapshot.ts';
import { prepareSnapshot, roundTurn } from '../runner/snapshot.ts';
import { createAccounts } from '../service/accounts.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import type { RunRow } from '../service/ledger.ts';
import { candidateLogins } from '../service/pick.ts';
import { readOnlyHere, unusableHere } from '../service/readonly.ts';
import type { NodeExecutorStatus } from '../shared/node-protocol.ts';
import { CHECK_MISSING_TEXT, type ReadOnlyLayer } from '../shared/roles.ts';
import { fakeRemote } from './fake-remote.ts';
import { claudeTier, codexTier, content, DISPATCH_TUNED, dshTier, fixture, LOGIN, memoryLogins, memoryMachines, RUN_LIMIT_MS, RUNNER_TUNED, testCredentialRef, tuned, USER, holdMachine, testMachine } from './helpers.ts';

const CODEX: Account = { id: 'cx', name: 'cx', executor: 'codex', tiers: { decide: content('model=x\n'), execute: content('model=y\n') } };
const DSH: Account = { id: 'ds', name: 'ds', executor: 'dsh', permissionMode: 'danger-full-access', tiers: { decide: dshTier('/tiers/decide.patch.yml'), execute: dshTier('/tiers/execute.patch.yml') } };
// Machines that came back by themselves: an SSH machine reports nothing, ever.
const MACHINES: Record<string, Machine> = { m1: { id: 'm1', host: 'm1', nodeId: 'a1a1a1a1a1a1a1a1' }, m2: { id: 'm2', host: 'm2', nodeId: 'b2b2b2b2b2b2b2b2' } };
const BWRAP = "bwrap: Can't bind mount /oldroot/ on /newroot/: Unable to mount source on destination: Invalid argument";
// A Claude tier a read-only round takes: the model alone, as content (§5).
const MODEL_ONLY = content('{"model":"m"}');

type Reports = Record<string, Record<string, NodeExecutorStatus | null>>;
const fine = (executor: string, layer: ReadOnlyLayer): NodeExecutorStatus =>
  ({ executor, installed: true, version: 'v', logged_in: true, read_only: { available: true, layer, checks_code: true }, credential: { adopted: true } });
const broken = (executor: string, layer: ReadOnlyLayer, error: string): NodeExecutorStatus =>
  ({ executor, installed: true, version: 'v', logged_in: true, read_only: { available: false, layer, error }, credential: { adopted: true } });

function setUp(t: TestContext, accounts: Account[], reports: Reports) {
  const f = fixture(t);
  const machines = memoryMachines(MACHINES, f.ledger);
  const store = memoryLogins(Object.fromEntries(accounts.map((account) => [account.id, account])), f.ledger);
  f.ledger.setProjectLogins(f.projectId, accounts.map(({ id }) => id), USER);
  const launched: RunRow[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    runner: {
      findMachine: async (_account, offered) => offered[0],
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => { launched.push(run); },
      watch: async () => {},
    },
    logins: store,
    machines,
    executors: ADAPTERS,
    reported: (machineId, executor) => reports[machineId]?.[executor] ?? null,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  const queued = (roleId: string, extra: { loginId?: string } = {}) => {
    const task = f.ledger.createTask({ roleId, projectId: f.projectId, title: '看一看', goal: '查原因', acceptance: '交报告', ...extra }, USER);
    f.ledger.queueTask(task.id, USER);
    return task.id;
  };
  return { f, dispatcher, launched, queued };
}

const snapshotOf = (run: RunRow): Snapshot => JSON.parse(run.snapshot_json) as Snapshot;

test('只读任务派给已安装执行器的机器，快照记下方式和层；legacy read_only 探针失败仅作参考', async (t) => {
  const s = setUp(t, [CODEX], {
    m1: { codex: { executor: 'codex', installed: false, version: null, logged_in: null } },
    m2: { codex: broken('codex', 'filesystem', BWRAP) },
  });
  const id = s.queued('analyse');
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1);
  const run = s.launched[0]!;
  assert.equal(run.task_id, id);
  assert.equal(run.machine_id, 'm2', 'm1 没装 codex，派给已安装的 m2（read_only 探针不阻断）');
  assert.deepEqual(snapshotOf(run).access, { permission: 'read', layer: 'contract', args: ['-c', 'approval_policy="never"'] });
  // The round is started the way the snapshot says, without overlaying OS sandbox or bypass flags.
  const { argv } = ADAPTERS.codex!.launch(roundTurn(snapshotOf(run), run.id));
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(!argv.includes('--sandbox'));
  assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('所有机器都未安装该执行器时不派发；已安装时即便没报 read_only 也能只读派发', async (t) => {
  const uninstalled = setUp(t, [CODEX, DSH], {
    m1: { codex: { executor: 'codex', installed: false, version: null, logged_in: null }, dsh: { executor: 'dsh', installed: false, version: null, logged_in: null } },
    m2: { codex: { executor: 'codex', installed: false, version: null, logged_in: null }, dsh: { executor: 'dsh', installed: false, version: null, logged_in: null } },
  });
  const id = uninstalled.queued('analyse');
  await uninstalled.dispatcher.tick();
  assert.equal(uninstalled.launched.length, 0);
  assert.equal(uninstalled.f.task(id).state, 'queued');

  const legacy = setUp(t, [CODEX, DSH], {
    m1: { codex: broken('codex', 'filesystem', BWRAP), dsh: { executor: 'dsh', installed: true, version: '0.2.2-rc.1', logged_in: null } },
    m2: { codex: { executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: true }, dsh: { executor: 'dsh', installed: true, version: '0.2.2-rc.1', logged_in: null } },
  });
  legacy.queued('analyse');
  await legacy.dispatcher.tick();
  assert.equal(legacy.launched.length, 1);
  assert.equal(snapshotOf(legacy.launched[0]!).access?.permission, 'read');
});

test('可写与只读任务均不受 dsh 旧版或 unusable 探针阻断', async (t) => {
  const tooOld: NodeExecutorStatus = { executor: 'dsh', installed: true, version: '0.2.1-rc.5', logged_in: null, unusable: '这一版用不了：不认 --permission-mode，升到 0.2.2-rc.1 以上' };
  const s = setUp(t, [DSH], { m1: { dsh: tooOld }, m2: { dsh: { executor: 'dsh', installed: true, version: '0.2.2', logged_in: null } } });
  s.queued('implement');
  await s.dispatcher.tick();
  assert.equal(s.launched[0]?.machine_id, 'm1');
  assert.deepEqual(snapshotOf(s.launched[0]!).access, { permission: 'write' });

  const only = setUp(t, [{ ...DSH, id: 'm1/dsh', machine: 'm1' }], { m1: { dsh: tooOld } });
  only.queued('implement');
  await only.dispatcher.tick();
  assert.equal(only.launched.length, 1);
});

test('只读任务可派给已安装的 dsh；dsh 未装时派给 Codex（档位里有别的设置也照样接）', async (t) => {
  const ready = setUp(t, [DSH], { m1: { dsh: fine('dsh', 'contract') } });
  const id = ready.queued('analyse');
  await ready.dispatcher.tick();
  assert.equal(ready.launched.length, 1);
  assert.equal(ready.launched[0]?.task_id, id);
  assert.deepEqual(snapshotOf(ready.launched[0]!).access, { permission: 'read', layer: 'contract', args: [] });

  const extra: Account = { ...CODEX, id: 'cn', name: 'cn', tiers: { decide: content('model=x\nnotify=["run-me"]\n') } };
  const s = setUp(t, [DSH, extra], {
    m1: { dsh: { executor: 'dsh', installed: false, version: null, logged_in: null }, codex: fine('codex', 'contract') },
    m2: { dsh: { executor: 'dsh', installed: false, version: null, logged_in: null }, codex: { executor: 'codex', installed: false, version: null, logged_in: null } },
  });
  s.queued('analyse');
  await s.dispatcher.tick();
  assert.equal(s.launched[0]?.login_id, 'cn');
});

test('已存的档位里含原生权限/沙箱设置时照常派发，仅语法错误才拒绝', async (t) => {
  const loose: Account = { ...CODEX, tiers: { execute: content('model=y\nsandbox_mode="danger-full-access"\n') } };
  const ok = setUp(t, [loose], { m1: { codex: fine('codex', 'contract') } });
  ok.queued('implement');
  await ok.dispatcher.tick();
  assert.equal(ok.launched.length, 1);

  const malformed: Account = { ...CODEX, tiers: { execute: content('model=y\nbroken_line\n') } };
  const bad = setUp(t, [malformed], { m1: { codex: fine('codex', 'contract') } });
  const id = bad.queued('implement');
  await bad.dispatcher.tick();
  assert.equal(bad.launched.length, 0);
  assert.equal(bad.f.task(id).state, 'held');
  assert.match(bad.f.task(id).reason!, /账号 cx 档位 execute 的内容用不了：.*第 2 行没有 =/);
});

test('保存账号时允许档位透传原生权限与沙箱设置，只拦截语法错误', (t) => {
  const f = fixture(t);
  const accounts = createAccounts({ ledger: f.ledger, executors: ADAPTERS, credentialExecutors: ['codex', 'claude'], dataDir: f.dir, log: () => {} });
  const cx = accounts.put({ name: 'cx2', executor: 'codex', credential: 'tok-cx2', tiers: { execute: { kind: 'content', text: 'model=y\napproval_policy="never"\n' } } }, USER);
  const cl = accounts.put({ name: 'cl2', executor: 'claude', credential: 'tok-cl2', tiers: { decide: { kind: 'content', text: '{"permissions":{"defaultMode":"bypassPermissions"}}' } } }, USER);
  assert.ok(f.ledger.getAccount(cx.account.id));
  assert.ok(f.ledger.getAccount(cl.account.id));
  assert.throws(
    () => accounts.put({ name: 'bad', executor: 'claude', credential: 'tok-bad', tiers: { decide: { kind: 'content', text: '{not-json' } } }, USER),
    /档位 decide：不是合法的 JSON/,
  );
  assert.equal(f.ledger.getAccount('bad'), undefined);
});

// One judgment in three places: unknown executors are excluded, and a Run's snapshot access
// must match the role's read/write permission.
test('挑账号、钉账号、建 Run 用同一个判断', (t) => {
  const f = fixture(t, { executors: ADAPTERS });
  const unknown: Account = { id: 'p', name: 'p', executor: 'unknown-exec', tiers: { decide: claudeTier('/t.json') } };
  const claude: Account = { id: 'c', name: 'c', executor: 'claude', tiers: { decide: MODEL_ONLY } };
  f.ledger.putAccount(unknown, USER, 'ref-p');
  f.ledger.putAccount(claude, USER, 'ref-c');
  const store = memoryLogins({ p: unknown, c: claude });
  const analyse = f.ledger.createTask({ roleId: 'analyse', projectId: f.projectId, title: 'a', goal: 'g', acceptance: 'x' }, USER);
  assert.deepEqual(candidateLogins(f.ledger.getTask(analyse.id), ['p', 'c'], store, ADAPTERS).map(({ id }) => id), ['c']);
  // Writable work is not judged by readOnlyRefusal.
  const implement = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: 'i', goal: 'g', acceptance: 'x', tierOverride: { tier: 'decide', reason: 'r' } }, USER);
  assert.deepEqual(candidateLogins(f.ledger.getTask(implement.id), ['p', 'c'], store, ADAPTERS).map(({ id }) => id), ['p', 'c']);
  // A pin, on creation and on change, of the role or of the account.
  assert.throws(() => f.ledger.createTask({ roleId: 'analyse', projectId: f.projectId, title: 'a', goal: 'g', acceptance: 'x', loginId: 'p' }, USER), /不提供只读/);
  const pinned = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: 'i', goal: 'g', acceptance: 'x', loginId: 'p' }, USER);
  assert.throws(() => f.ledger.updateTask(pinned.id, { roleId: 'analyse' }, USER), /不提供只读/);
  assert.throws(() => f.ledger.updateTask(analyse.id, { loginId: 'p' }, USER), /不提供只读/);
  // The Run: a read-only role's round has to be one made read-only, and the other way round.
  f.ledger.queueTask(analyse.id, USER);
  const machine = f.ledger.getMachine('h1')!;
  const writable = { timeout_ms: RUN_LIMIT_MS, brief: 'b', tier: 'decide', tier_value: claudeTier('/t.json'), access: { permission: 'write' } };
  assert.throws(() => f.ledger.createRun(analyse.id, { login: claude, machine, snapshot: writable, expectedRevision: 1 }, USER), /只读/);
  const readOnly = { ...writable, access: { permission: 'read', layer: 'contract', args: [] } };
  assert.throws(() => f.ledger.createRun(analyse.id, { login: unknown, machine, snapshot: readOnly, expectedRevision: 1 }, USER), /不提供只读/);
  const run = f.ledger.createRun(analyse.id, { login: claude, machine, snapshot: readOnly, expectedRevision: 1 }, USER);
  assert.equal((JSON.parse(run.snapshot_json) as Snapshot).access?.permission, 'read');
  f.ledger.queueTask(implement.id, USER);
  assert.throws(() => f.ledger.createRun(implement.id, { login: claude, machine, snapshot: readOnly, expectedRevision: 1 }, USER), /只读/);
});

// The Runner moves a round whose upload no machine took to another allowed machine; for a
// read-only round only to one that can run it read-only, by the same judgment.
for (const [name, fitting, expected] of [['只有原来那台能只读：不换过去，判没起来', ['h1'], null], ['另一台也能只读：换过去', ['h1', 'h2'], 'h2']] as const) {
  test(`还没起来的一轮换机器时也只换到能只读跑的那台：${name}`, async (t) => {
    const f = fixture(t);
    const remote = fakeRemote();
    for (const id of ['h1', 'h2']) holdMachine(f.ledger, testMachine(id), USER);
    // An account: its login goes with the round, so the round may move to another machine.
    const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { decide: MODEL_ONLY } };
    const store = memoryLogins({ t1: account }, f.ledger);
    const machines = { get: f.ledger.getMachine, list: f.ledger.listMachines };
    const runner = createRunner({ ...RUNNER_TUNED,
      ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: store, machines, connect: remote.connect,
      credential: (id) => (id === 't1' ? { ref: testCredentialRef('t1'), value: 'token' } : undefined),
      lostGraceMs: () => 60_000, log: () => {},
      fits: (machineId, _executor, readOnly) => !readOnly || (fitting as readonly string[]).includes(machineId),
    });
    // The dispatcher sees h1 say yes; h2 has said nothing yet.
    const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
      ledger: f.ledger, runTimeoutMs: tuned('run.timeoutMs'), runner: { ...runner, watch: async () => {} }, logins: store,
      machines,
      reported: (machineId, executor) => (machineId === 'h1' ? fine(executor, 'tools') : null),
      executors: { claude: claudeAdapter }, log: () => {},
    });
    t.after(() => dispatcher.stop());
    f.ledger.setProjectLogins(f.projectId, ['t1'], USER);
    const task = f.ledger.createTask({ roleId: 'analyse', projectId: f.projectId, title: 'a', goal: 'g', acceptance: 'x' }, USER);
    f.ledger.queueTask(task.id, USER);
    remote.uploadFails.add('h1');
    await dispatcher.tick();
    const [run] = f.ledger.listRuns(task.id);
    assert.equal(remote.called('start.sh', run!.id, 'h2'), expected === null ? 0 : 1);
    if (expected === null) assert.equal(f.run(run!.id).exit_kind, 'lost', '没有能只读跑的别处，这一轮判没起来');
    else assert.equal(f.run(run!.id).host, 'h2');
  });
}

// The role is the owner's to change at any moment, a machine takes as long as it likes to
// answer, and the machine, the session and the snapshot have to have been chosen on the same
// permission: the one read when this dispatch began. A role turned read-only meanwhile makes
// createRun refuse the round; the Task stays queued and is placed afresh as read-only.
test('挑机器等待期间职能改成只读：这一轮不发，下一轮按只读重新派', async (t) => {
  const f = fixture(t);
  const account: Account = { id: 'c', name: 'c', executor: 'claude', tiers: { execute: MODEL_ONLY } };
  const store = memoryLogins({ c: account }, f.ledger);
  f.ledger.setProjectLogins(f.projectId, ['c'], USER);
  const craft = { id: 'craft', name: '手艺', description: '可写的活', default_tier: 'execute', permission: 'write', deliverable: 'report', needs_review: false } as const;
  f.ledger.putRole(craft, USER);
  let release!: () => void;
  const asked = new Promise<void>((resolve) => { release = resolve; });
  let waiting!: () => void;
  const reached = new Promise<void>((resolve) => { waiting = resolve; });
  const launched: RunRow[] = [];
  const logs: string[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'), ledger: f.ledger,
    runner: {
      // A machine whose client said nothing about read-only (an older one): writable work only.
      findMachine: async (_account, offered) => { waiting(); await asked; return offered[0]; },
      lostCandidates: () => [], presume: async () => 'unknown', sweep: async () => {},
      launch: async (run) => { launched.push(run); }, watch: async () => {},
    },
    logins: store, machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    executors: ADAPTERS, reported: (_machine, executor) => ({ executor, installed: true, version: '1.0.0', logged_in: true, credential: { adopted: true } }), log: (line) => logs.push(line),
  });
  t.after(() => dispatcher.stop());
  const task = f.ledger.createTask({ roleId: 'craft', projectId: f.projectId, title: 'a', goal: 'g', acceptance: 'x' }, USER);
  f.ledger.queueTask(task.id, USER);
  const tick = dispatcher.tick();
  await reached;
  f.ledger.putRole({ ...craft, permission: 'read' }, USER);
  release();
  await tick;
  assert.deepEqual(launched, [], '按可写挑的机器和会话，不发成只读的一轮');
  assert.deepEqual(f.ledger.listRuns(task.id), []);
  assert.equal(f.task(task.id).state, 'queued');
  assert.ok(logs.some((line) => /本轮未派发/.test(line)), logs.join('\n'));
  // Placed afresh: read-only now, and dispatches cleanly with permission='read'.
  await dispatcher.tick();
  assert.equal(launched.length, 1);
  assert.equal(snapshotOf(launched[0]!).access?.permission, 'read');
});

test('旧客户端只报了版本号：minVersion 仅作参考，dsh 照常派发', async (t) => {
  const old: NodeExecutorStatus = { executor: 'dsh', installed: true, version: '0.2.1-rc.5', logged_in: null };
  const s = setUp(t, [{ ...DSH, id: 'm1/dsh', machine: 'm1' }], { m1: { dsh: old } });
  s.queued('implement');
  await s.dispatcher.tick();
  assert.equal(s.launched[0]?.machine_id, 'm1');
  assert.equal(unusableHere(old, { version: '0.2.2-rc.1', lacks: '旧' }), undefined);
  assert.equal(unusableHere(old), undefined);
  assert.equal(readOnlyHere({ ...old, read_only: { available: true, layer: 'filesystem' } }, { version: '0.2.2-rc.1', lacks: '旧' }).ok, true);
});

test('checks_code 仅作参考：客户端未报 checks_code 时也照常派发只读任务', async (t) => {
  const quiet: NodeExecutorStatus = { executor: 'codex', installed: true, version: 'v', logged_in: true, read_only: { available: true, layer: 'filesystem' } };
  assert.deepEqual(readOnlyHere(quiet), { ok: true });
  assert.equal(readOnlyHere(fine('codex', 'filesystem')).ok, true);
  const s = setUp(t, [CODEX], { m1: { codex: quiet }, m2: { codex: quiet } });
  const id = s.queued('analyse');
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1);
  assert.equal(s.launched[0]?.task_id, id);
  assert.equal(snapshotOf(s.launched[0]!).access?.permission, 'read');
});

test('Claude：档位里夹带 hooks 也照样接只读的活，走框架默认 contract 事后核对层', async (t) => {
  const hooked: Account = { id: 'ch', name: 'ch', executor: 'claude', tiers: { decide: content('{"model":"m","hooks":{"PreToolUse":[]}}') } };
  const s = setUp(t, [hooked], { m1: { claude: fine('claude', 'contract') } });
  s.queued('analyse');
  await s.dispatcher.tick();
  assert.equal(s.launched[0]?.login_id, 'ch');
  assert.deepEqual(snapshotOf(s.launched[0]!).access, { permission: 'read', layer: 'contract', args: [] });
});

test('只读轮次代码变动不丢弃回执，prepareSnapshot 的 recheck 现场提示仍按精简文案渲染', async (t) => {
  const s = setUp(t, [CODEX], { m1: { codex: fine('codex', 'contract') } });
  const id = s.queued('analyse');
  await s.dispatcher.tick();
  const first = s.launched[0]!;
  s.f.ledger.markRunRunning(first.id);
  s.f.ledger.settleRun(first.id, 0, { status: 'done', summary: '查清了', artifacts: [{ kind: 'report', ref: '最后一条消息' }] }, {
    sessionRef: 'first-session', codeCheck: { result: 'changed', changes: ['?? out.txt'] },
  });
  assert.equal(s.f.task(id).state, 'ready');
  assert.ok(s.f.run(first.id).receipt_json);

  const claudeRecheck = prepareSnapshot(s.f.task(id), { id: 'cl', name: 'cl', executor: 'claude', tiers: { decide: MODEL_ONLY } }, ADAPTERS, {
    timeoutMs: RUN_LIMIT_MS, permission: 'read', checkSite: 'recheck',
  });
  assert.match(claudeRecheck.brief, /## 现场提示[\s\S]*上一轮代码基线核对未通过/);
});
