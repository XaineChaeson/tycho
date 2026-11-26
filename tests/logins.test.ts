// Guards the logins a round can run as (docs/design/accounts-machines-decoupled.md) where
// they meet a machine at dispatch: a machine's own login sent to another machine, or to its
// own while that machine says it is signed out; an account kept to some machines when any the
// project allows would do; the read-only probe (roles-and-tiers.md §5) or the review's change
// of executor (§4) skipped because a login is a machine's rather than an account; a snapshot
// that does not say which login and which machine a round ran as, or a machine's own login
// handed a token it does not have; and the machines page unable to set a machine's own login,
// or setting one through a second set of checks. And a machine's own login its executor has
// refused under a round given more work on the strength of a report read before that; an
// account let back in by anything but a new token; and "no report" — a machine that has not
// reported yet, or one whose report leaves this executor out — read as anything but waiting.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import type { Login, Machine, Snapshot } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import type { RunRow } from '../service/ledger.ts';
import { candidateLogins } from '../service/pick.ts';
import { createNodes } from '../service/nodes.ts';
import type { NodeExecutorStatus } from '../shared/node-protocol.ts';
import { consoleApp } from './console-helpers.ts';
import { codexTier, content, DISPATCH_TUNED, DONE, fixture, machineLogin, memoryLogins, memoryMachines, NODES_TUNED, tuned, USER, testMachine, uidsOf } from './helpers.ts';

// Machines that came back by themselves; s1 has reported nothing yet.
const MACHINES: Record<string, Machine> = {
  m1: { id: 'm1', host: 'm1', nodeId: 'a1a1a1a1a1a1a1a1' },
  m2: { id: 'm2', host: 'm2', nodeId: 'b2b2b2b2b2b2b2b2' },
  s1: testMachine('s1'),
};
const MODEL_ONLY = content('{"model":"m"}');
const ACCOUNT: Login = { id: 'acct', name: 'acct', executor: 'claude', tiers: { execute: MODEL_ONLY, decide: MODEL_ONLY } };
const M1_CODEX = machineLogin('m1', 'codex', { tiers: { execute: content('model=x\n'), decide: content('model=y\n') } });

type Reports = Record<string, Record<string, NodeExecutorStatus>>;
const signedIn = (executor: string, loggedIn: boolean | null = true, readOnly?: boolean): NodeExecutorStatus => ({
  executor, installed: true, version: 'v', logged_in: loggedIn, credential: { adopted: true },
  ...(readOnly === undefined ? {} : { read_only: { available: readOnly, layer: 'filesystem' as const, ...(readOnly ? { checks_code: true as const } : { error: '起不来' }) } }),
});

function setUp(t: TestContext, logins: Login[], reports: Reports, project: { machines?: string[] } = {}) {
  const f = fixture(t);
  const machines = memoryMachines(MACHINES, f.ledger);
  const store = memoryLogins(Object.fromEntries(logins.map((login) => [login.id, login])), f.ledger);
  f.ledger.setProjectLogins(f.projectId, logins.map(({ id }) => id), USER);
  if (project.machines) f.ledger.setProjectMachines(f.projectId, uidsOf(f.ledger, project.machines), USER);
  const launched: RunRow[] = [];
  const asked: string[][] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    runner: {
      findMachine: async (_login, offered) => { asked.push(offered.map(({ id }) => id)); return offered[0]; },
      lostCandidates: () => [], presume: async () => 'unknown', sweep: async () => {},
      launch: async (run) => { launched.push(run); }, watch: async () => {},
    },
    logins: store,
    machines,
    executors: ADAPTERS,
    reported: (machineId, executor) => reports[machineId]?.[executor] ?? null,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  const queued = (roleId = 'implement', extra: { loginId?: string } = {}): string => {
    const task = f.ledger.createTask({ roleId, projectId: f.projectId, title: '活', goal: '做', acceptance: '交', ...extra }, USER);
    f.ledger.queueTask(task.id, USER);
    return task.id;
  };
  return { f, dispatcher, launched, asked, queued, store };
}

const snapshotOf = (run: RunRow): Snapshot => JSON.parse(run.snapshot_json) as Snapshot;

test('an account is offered every machine the project allows; the project narrows it, nothing else does', async (t) => {
  // Every machine has said its executor would take the token: an account is not offered one
  // that has not said (that is service/readonly.ts), and the machine's own sign-in says nothing.
  const s = setUp(t, [ACCOUNT], {
    m1: { claude: signedIn('claude', false) },
    m2: { claude: signedIn('claude', true) },
    s1: { claude: signedIn('claude', true) },
  });
  s.queued();
  await s.dispatcher.tick();
  // A machine's own sign-in says nothing about an account: its token goes with the round.
  assert.deepEqual(s.asked[0], ['m1', 'm2', 's1']);
  assert.deepEqual([s.launched[0]!.login_id, s.launched[0]!.machine_id], ['acct', 'm1']);
  s.f.ledger.setProjectMachines(s.f.projectId, uidsOf(s.f.ledger, ['m2']), USER);
  s.queued();
  await s.dispatcher.tick();
  assert.deepEqual(s.asked[1], ['m2']);
});

test('a machine\'s own login goes to its machine alone, and only while that machine does not say it is signed out', async (t) => {
  const reports: Reports = { m1: { codex: signedIn('codex', true) } };
  const s = setUp(t, [M1_CODEX], reports);
  const first = s.queued();
  await s.dispatcher.tick();
  assert.deepEqual(s.asked[0], ['m1'], '别的机器上没有这份登录');
  assert.deepEqual([s.launched[0]!.task_id, s.launched[0]!.login_id, s.launched[0]!.machine_id], [first, s.f.ledger.getMachineLogin('m1', 'codex')!.id, 'm1']);
  // Signed out there now: nothing is offered, the Task waits for it and holds nothing up.
  s.f.ledger.markRunRunning(s.launched[0]!.id);
  s.f.ledger.settleRun(s.launched[0]!.id, 0, DONE);
  reports.m1!.codex = signedIn('codex', false);
  const waiting = s.queued();
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1);
  assert.equal(s.f.task(waiting).state, 'queued', '等它重新登录，不是出错');
  assert.deepEqual(s.dispatcher.waitOf(s.f.task(waiting))?.no_machine, ['m1/codex']);
  // An executor that cannot say whether it is signed in is taken at its word.
  reports.m1!.codex = signedIn('codex', null);
  await s.dispatcher.tick();
  assert.equal(s.launched[1]?.task_id, waiting);
});

test('a machine\'s own login is never offered another machine, whatever the project allows', async (t) => {
  const s = setUp(t, [M1_CODEX], { m1: { codex: signedIn('codex') }, m2: { codex: signedIn('codex') } }, { machines: ['m2'] });
  const id = s.queued();
  await s.dispatcher.tick();
  assert.deepEqual(s.launched, []);
  assert.equal(s.f.task(id).state, 'queued');
  assert.deepEqual(s.asked, [[]], '项目只允许 m2：m1 自己的登录没有可去的地方');
});

test('the snapshot says which login and which machine a round ran as; a machine\'s own login carries no token number', async (t) => {
  const s = setUp(t, [ACCOUNT, M1_CODEX], { m1: { codex: signedIn('codex'), claude: signedIn('claude') } });
  s.queued('implement', { loginId: s.f.ledger.getMachineLogin('m1', 'codex')!.id });
  s.queued('implement', { loginId: 'acct' });
  await s.dispatcher.tick();
  await s.dispatcher.tick();
  const [own, account] = s.launched.map(snapshotOf);
  assert.deepEqual([own!.login!.machine, own!.executor, own!.credential_ref], ['m1', 'codex', undefined]);
  assert.deepEqual([account!.login!.machine, account!.executor, typeof account!.credential_ref], [null, 'claude', 'string']);
});

// Under Occam's Razor, read-only dispatch only checks installation; legacy read_only.available
// probe results are advisory and never block dispatch.
test('a read-only Task on a machine\'s own login dispatches whenever installed, even if legacy read_only probe reported unavailable, and waits when uninstalled', async (t) => {
  const reports: Reports = { m1: { codex: signedIn('codex', true, true) } };
  const s = setUp(t, [M1_CODEX], reports);
  s.queued('analyse');
  await s.dispatcher.tick();
  assert.deepEqual(snapshotOf(s.launched[0]!).access, { permission: 'read', layer: 'contract', args: ['-c', 'approval_policy="never"'] });

  const advisory = setUp(t, [M1_CODEX], { m1: { codex: signedIn('codex', true, false) } });
  advisory.queued('analyse');
  await advisory.dispatcher.tick();
  assert.equal(advisory.launched.length, 1, 'read_only 探针仅作参考，不阻断只读派发');
  assert.equal(snapshotOf(advisory.launched[0]!).access?.permission, 'read');

  const missing = setUp(t, [M1_CODEX], { m1: { codex: { executor: 'codex', installed: false, version: null, logged_in: null } } });
  const id = missing.queued('analyse');
  await missing.dispatcher.tick();
  assert.deepEqual(missing.launched, [], '未安装时仍不派发');
  assert.equal(missing.f.task(id).state, 'queued');
  assert.deepEqual(missing.dispatcher.waitOf(missing.f.task(id))?.no_machine, ['m1/codex']);
});

// §4: whoever wrote the product, by any login, its executor is excluded from automatic review candidates;
// explicit owner pinning is permitted without bureaucratic refusal.
test('a review prefers non-writer executors automatically while allowing explicit owner pinning', async (t) => {
  const M1_CLAUDE = machineLogin('m1', 'claude', { tiers: { decide: MODEL_ONLY } });
  const s = setUp(t, [ACCOUNT, M1_CLAUDE, M1_CODEX], { m1: { claude: signedIn('claude', true, true), codex: signedIn('codex', true, true) } });
  const work = s.queued('implement', { loginId: 'acct' });
  await s.dispatcher.tick();
  s.f.ledger.markRunRunning(s.launched[0]!.id);
  s.f.ledger.settleRun(s.launched[0]!.id, 0, DONE);
  const registration = s.f.ledger.registerArtifacts(s.launched[0]!.id, []);
  const review = s.f.ledger.createTask({ roleId: 'review', projectId: s.f.projectId, title: '审', goal: '审', acceptance: '结论', reviewOf: { taskId: work, runId: s.launched[0]!.id, revision: 1, registration } }, USER);
  const ownClaude = s.f.ledger.getMachineLogin('m1', 'claude')!.id;
  const ownCodex = s.f.ledger.getMachineLogin('m1', 'codex')!.id;
  assert.deepEqual(candidateLogins(s.f.ledger.getTask(review.id), ['acct', ownClaude, ownCodex], s.store).map(({ id }) => id), [ownCodex], 'claude 写过：自动候选里账号和机器自己的 claude 登录都不排在非编写者组');
  // Explicit owner pin is allowed and can be cleared back to automatic selection.
  s.f.ledger.updateTask(review.id, { loginId: ownClaude }, USER);
  assert.equal(s.f.task(review.id).login_id, ownClaude);
  s.f.ledger.updateTask(review.id, { loginId: null }, USER);
  s.f.ledger.queueTask(review.id, USER);
  await s.dispatcher.tick();
  assert.deepEqual([s.launched.at(-1)!.task_id, s.launched.at(-1)!.login_id], [review.id, ownCodex]);
});

// --- the machines page: a machine's own login, set with the account's own checks ---

test('the machines page sets, shows and removes a machine\'s own login with the same checks an account has', async (t) => {
  const { f, get, send } = await consoleApp(t);
  const machineUid = f.ledger.getMachine('h1')!.uid;
  const path = `/api/machines/${machineUid}/logins/codex`;
  const bad = await send('PUT', path, { tiers: { execute: { kind: 'content', text: 'model=y\nnot-a-setting\n' } } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json() as { error: string }).error, /档位 execute：.*第 2 行没有 =/, '和账号同一套档位校验');
  assert.equal((await send('PUT', path, { tiers: { execute: { kind: 'content', text: 'model=m' } }, machines: ['h2'] })).status, 400, '没有的字段不收');
  assert.equal((await send('PUT', '/api/machines/nope/logins/codex', { tiers: { execute: content('model=x\n') } })).status, 400, '没有这台机器');
  assert.equal((await send('PUT', `/api/machines/${machineUid}/logins/gemini`, { tiers: { execute: content('model=x\n') } })).status, 400, '没有这个执行器');
  const made = await send('PUT', path, { tiers: { execute: content('model=x\n') }, max_runs: 2 });
  assert.equal(made.status, 201);
  const shown = (await made.json() as { machine: { logins: { id: string; name: string; executor: string; configured: boolean; tiers: unknown; max_runs: number | null; status: unknown }[] } }).machine.logins;
  const codex = shown.find(({ executor }) => executor === 'codex')!;
  assert.match(codex.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(codex.id, f.ledger.getMachineLogin('h1', 'codex')!.id);
  assert.deepEqual([codex.name, codex.configured, codex.tiers, codex.max_runs], ['h1/codex', true, { execute: content('model=x\n') }, 2]);
  assert.equal(f.ledger.getMachineLogin('h1', 'codex')!.maxRuns, 2);
  // The fixture's own h1/claude is there as well: set up, though not signed in to report yet.
  const listed = (await (await get('/api/machines')).json() as { machines: { id: string; logins: { id: string }[] }[] }).machines.find(({ id }) => id === 'h1')!;
  assert.deepEqual(listed.logins.map(({ id }) => id).sort(), [f.ledger.getMachineLogin('h1', 'claude')!.id, codex.id].sort());
  // It can now be put on a project, and taken off the machine again.
  assert.equal((await send('PUT', `/api/projects/${f.projectId}`, { logins: [codex.id, 't1'] })).status, 200);
  const configuredPath = `/api/logins/${codex.id}`;
  const removed = await send('DELETE', configuredPath);
  assert.equal(removed.status, 200);
  assert.equal(f.ledger.getMachineLogin('h1', 'codex'), undefined);
  // Removing it takes it out of the projects that allowed it, in the same transaction, and
  // the answer says which they were and what each has left (docs/design/native-login.md §2).
  assert.deepEqual((await removed.json() as { projects: { id: string; name: string; remaining: number }[] }).projects, [
    { id: f.projectId, name: '试跑', remaining: 1 },
  ]);
  assert.deepEqual(f.ledger.loginPool({ project_id: f.projectId }).ids, ['t1']);
  assert.equal((await send('DELETE', configuredPath)).status, 400, '删过了就没有了');
  const rows = f.peek<{ action: string; actor: string }>(`SELECT action, actor FROM change WHERE action LIKE 'machine_login.%' ORDER BY seq`).map((row) => ({ ...row }));
  assert.deepEqual(rows.slice(-2), [{ action: 'machine_login.create', actor: 'console' }, { action: 'machine_login.delete', actor: 'console' }]);
});

test('a machine\'s own login that is not set up shows on its machine once the machine reports it signed in', async (t) => {
  const report = { at: '2026-11-09T00:00:00.000Z', executors: [signedIn('codex'), signedIn('claude', false), { executor: 'dsh', installed: false, version: null, logged_in: null }] };
  const f = fixture(t);
  f.force(`UPDATE machine SET node_id = 'c3c3c3c3c3c3c3c3' WHERE id = 'h1'`);
  f.ledger.deleteMachineLogin('h1', 'claude', USER);
  // The hub keeps what machines reported in memory: h1's report is stood in for.
  const hub = createNodes({ ...NODES_TUNED, ledger: f.ledger, log: () => {} });
  const { get } = await consoleApp(t, { f, nodes: { ...hub, reportedExecutors: (id: string) => (id === 'h1' ? report : null) } });
  const h1 = (await (await get('/api/machines')).json() as { machines: { id: string; logins: { id: string | null; name: string; signed_in: boolean | null; configured: boolean; tiers: unknown }[] }[] }).machines.find(({ id }) => id === 'h1')!;
  // Signed in and not set up: shown, so its tiers can be filled in. Signed out and not
  // set up, or not installed: not a login of this machine.
  assert.deepEqual(h1.logins.map(({ id, name, signed_in, configured, tiers }) => [id, name, signed_in, configured, tiers]), [[null, 'h1/codex', true, false, {}]]);
});

test('a machine\'s own login takes no tier outside the tier names, and a machine of that name gone takes its logins with it', (t) => {
  const f = fixture(t);
  assert.throws(() => f.ledger.putMachineLogin({ executor: 'codex', machine: 'nowhere', tiers: { execute: codexTier('x') } }, USER), /机器不存在：nowhere/);
  f.ledger.putMachineLogin({ executor: 'codex', machine: 'h1', tiers: { execute: content('model=x\n') } }, USER);
  const loginId = f.ledger.getMachineLogin('h1', 'codex')!.id;
  f.ledger.noteUsage(loginId, [{ window: 'five_hour', used: 0.5, resetsAt: null }]);
  f.ledger.deleteMachine('h1', USER, { confirmed: true });
  assert.deepEqual(f.ledger.listMachineLogins(), []);
  assert.deepEqual(f.peek('SELECT * FROM login_state'), [], '学到的状态跟着走');
  assert.equal(f.ledger.loginWasDeleted(loginId), true);
});


// --- a login its executor refused (review of 11-09, P2) ---

test("a machine's own login its executor refused under a round takes no more work, until its machine reports it signed in after that", async (t) => {
  const s = setUp(t, [M1_CODEX], { m1: { codex: signedIn('codex') } });
  const first = s.queued();
  const second = s.queued();
  await s.dispatcher.tick();
  const run = s.launched[0]!;
  s.f.ledger.markRunRunning(run.id);
  s.f.ledger.settleRun(run.id, 1, null, { kind: 'auth' });
  assert.equal(s.f.run(run.id).exit_kind, 'auth');
  assert.equal(s.f.task(first).state, 'queued', '这一轮没做成，任务回到队列');
  // The machine's last report still says signed in: it was read before the refusal, and
  // says nothing about it.
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1, '同一份登录不再接活');
  assert.deepEqual(s.dispatcher.waitOf(s.f.task(second))?.rejected, ['m1/codex']);
  // A report probed before the refusal changes nothing; one probed after it does.
  s.f.ledger.signedInAgain(run.login_id!, new Date(Date.parse(s.f.ledger.loginState(run.login_id).auth_failed_at!) - 1000).toISOString());
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1, '失败之前的报告不算数');
  s.f.ledger.signedInAgain(run.login_id!, new Date(Date.parse(s.f.ledger.loginState(run.login_id).auth_failed_at!) + 1000).toISOString());
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 2, '失败之后机器报告又登录了，接着派');
});

test('an account its executor refused takes no more work until it is given another token, as before', async (t) => {
  const s = setUp(t, [ACCOUNT], { m1: { claude: signedIn('claude') } });
  s.queued();
  const second = s.queued();
  await s.dispatcher.tick();
  const run = s.launched[0]!;
  s.f.ledger.markRunRunning(run.id);
  s.f.ledger.settleRun(run.id, 1, null, { kind: 'auth' });
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1);
  assert.deepEqual(s.dispatcher.waitOf(s.f.task(second))?.rejected, ['acct']);
  // A machine saying it is signed in is no token: the account still waits for one.
  s.f.ledger.signedInAgain('acct', new Date(Date.now() + 60_000).toISOString());
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 1);
});

// --- what "no report" means for a machine's own login (review of 11-09, P2) ---

const M2_CODEX = machineLogin('m2', 'codex', { tiers: { execute: content('model=x\n') } });

test("a machine's own login on a machine that came back by itself and has not reported waits for its report", async (t) => {
  const reports: Reports = {};
  const s = setUp(t, [M2_CODEX], reports);
  const id = s.queued();
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 0, '还没报告就不派');
  assert.equal(s.f.task(id).state, 'queued');
  reports.m2 = { codex: signedIn('codex') };
  await s.dispatcher.tick();
  assert.equal(s.launched[0]?.machine_id, 'm2');
});

test("a machine's own login whose machine reported, but nothing of this executor, waits", async (t) => {
  const reports: Reports = { m2: { claude: signedIn('claude') } };
  const s = setUp(t, [M2_CODEX], reports);
  s.queued();
  await s.dispatcher.tick();
  assert.equal(s.launched.length, 0, '报告里没有这个执行器就不派');
  reports.m2!.codex = signedIn('codex', null);
  await s.dispatcher.tick();
  assert.equal(s.launched[0]?.machine_id, 'm2', '装了、说不清登没登录：按它的话算');
});

test("the machines page is told a machine's own login is refused, and whether its machine's word lets it work there, by dispatch's own judgments", async (t) => {
  const { f, get } = await consoleApp(t);
  const loginOf = async (machine: string) => (await (await get('/api/machines')).json() as { machines: { id: string; logins: { id: string; refused: boolean; usable_here: boolean }[] }[] })
    .machines.find(({ id }) => id === machine)!.logins.find(({ id }) => id === f.ledger.getMachineLogin(machine, 'claude')!.id)!;
  // h1 has not reported its executors yet: its own login waits for the report.
  assert.deepEqual([(await loginOf('h1')).refused, (await loginOf('h1')).usable_here], [false, false]);
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null, { kind: 'auth' });
  assert.equal((await loginOf('h1')).refused, true);
});

test('a login that is gone is named by its old name in the display rule, never by an internal id', (t) => {
  const f = fixture(t);
  f.ledger.putAccount({ id: 'gone-account', name: '旧账号', executor: 'claude', tiers: { execute: MODEL_ONLY } }, USER, 'ref-gone');
  f.ledger.deleteAccount('gone-account', USER);
  // The project write reads the one display rule too: "账号 旧账号", not the id it was held by.
  assert.throws(() => f.ledger.setProjectLogins(f.projectId, ['gone-account'], USER), (err: Error) => /账号 旧账号 不存在/.test(err.message));
  const own = f.ledger.getMachineLogin('h1', 'claude')!.id;
  f.ledger.deleteMachineLogin('h1', 'claude', USER);
  assert.throws(() => f.ledger.setProjectLogins(f.projectId, [own], USER), (err: Error) => /机器 h1 上的 claude 登录 不存在/.test(err.message));
});
