// Guards what the service keeps of a machine's own reading of its logins' quota, and what the
// usage page says about those logins (docs/design/usage.md §3, §4).
//
// What this file is here to catch:
//   - a reading written with the moment the report arrived instead of the moment the machine
//     read it, so that a report delayed on the way looks freshly read;
//   - a repeated report, or an older one, overwriting a newer reading, or refreshing its time;
//   - a reading that adds to the held windows instead of being the whole set the executor
//     named at that moment, so that a window the executor no longer reports never goes away;
//   - a failed reading wiping the figures, or a report about a login that is not there writing
//     learned state under a name of its own;
//   - the usage page saying "主机问不了" for a machine's own login, or showing a reading with no
//     time, a failure with no time, an executor that offers no reading as one that has none yet,
//     an absent machine as one that can be asked, or a refresh that asks nothing.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { HttpOptions } from '../service/http.ts';
import { createNodes } from '../service/nodes.ts';
import type { NodeExecutorReport, NodeQuotaStatus } from '../shared/node-protocol.ts';
import type { QuotaLogin } from '../shared/usage.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, LOGIN, NODES_TUNED, USER } from './helpers.ts';

// Ahead of the wall clock: a figure a round reports is stamped with the ledger's own now, and a
// machine's reading counts only when it is newer than everything held.
const HOUR = 3_600_000;
const AT = new Date(Date.now() + 2 * HOUR).toISOString();
const LATER = new Date(Date.now() + 3 * HOUR).toISOString();
const EARLIER = new Date(Date.now() + HOUR).toISOString();
const WEEKLY = { window: 'Current week (all models)', used: 0.78, resetsAt: null };
const FABLE = { window: 'Current week (Fable)', used: 0.09, resetsAt: null };
const ORG = '00000000-0000-0000-0000-000000000000';
const OTHER_ORG = '11111111-2222-3333-4444-555555555555';

// -- the ledger: one reading, whole, and never older than what is held ------------------------

test('一次读数按机器自己读到的时刻记下，整份换掉窗口集合；同样的一份再说一遍不写', (t) => {
  const f = fixture(t);
  const login = f.ledger.getMachineLogin('h1', 'claude')!.id;
  f.ledger.noteUsage(login, [{ window: 'five_hour', used: 0.5, resetsAt: null }]);
  f.ledger.noteQuota(login, [WEEKLY, FABLE], AT);
  assert.deepEqual(f.ledger.loginState(login).usage, [
    { window: WEEKLY.window, used: 0.78, resets_at: null, at: AT },
    { window: FABLE.window, used: 0.09, resets_at: null, at: AT },
  ], '时刻是机器读到的那个，不是写下来的时候；它报的完整集合替换掉之前那份（noteUsage 记的也在内）');
  // The same report twice: nothing is written at all, so its moment is not moved forward.
  const before = f.dump();
  f.ledger.noteQuota(login, [WEEKLY, FABLE], AT);
  assert.deepEqual(f.dump(), before, '同样的一份再说一遍一个字都不写');
  // A reading older than the one held never overwrites it, and never changes its moment.
  f.ledger.noteQuota(login, [{ window: 'stale', used: 1, resetsAt: null }], EARLIER);
  assert.deepEqual(f.ledger.loginState(login).usage, [
    { window: WEEKLY.window, used: 0.78, resets_at: null, at: AT },
    { window: FABLE.window, used: 0.09, resets_at: null, at: AT },
  ]);
  // A newer reading is the whole set: a window it does not name is gone.
  f.ledger.noteQuota(login, [FABLE], LATER);
  assert.deepEqual(f.ledger.loginState(login).usage, [{ window: FABLE.window, used: 0.09, resets_at: null, at: LATER }]);
});

test('旧 Claude 窗口别名在账本投影中合并并取最新读数', (t) => {
  const f = fixture(t);
  const id = f.ledger.getMachineLogin('h1', 'claude')!.id;
  f.ledger.noteUsage(id, [{ window: 'five_hour', used: 0.3, resetsAt: null }]);
  const legacy = {
    '7d_oi': { used: 0.2, resets_at: null, at: EARLIER },
    seven_day_overage_included: { used: 0.8, resets_at: null, at: LATER },
    five_hour: { used: 0.3, resets_at: null, at: AT },
  };
  f.force('UPDATE login_state SET usage_json = ? WHERE id = ?', JSON.stringify(legacy), id);
  const figures = f.ledger.loginState(id).usage;
  assert.deepEqual(figures.map(({ window, used }) => [window, used]), [['seven_day_fable', 0.8], ['five_hour', 0.3]]);
  assert.deepEqual(f.ledger.loginStates().get(id)?.usage, figures);
});

test('读不到的那一次不写任何东西：数字留着上一次的，账本里没有“读不到”这一回事', (t) => {
  const f = fixture(t);
  const login = f.ledger.getMachineLogin('h1', 'claude')!.id;
  f.ledger.noteQuota(login, [WEEKLY], AT);
  const before = f.dump();
  f.ledger.noteQuota(login, [], LATER);
  f.ledger.noteQuota('nobody', [WEEKLY], LATER);
  f.ledger.noteQuota(login, [WEEKLY], 'not a moment');
  assert.deepEqual(f.dump(), before, '空的、不存在的登录、读不出的时刻都不写');
  assert.deepEqual(f.ledger.loginState(login).usage, [{ window: WEEKLY.window, used: 0.78, resets_at: null, at: AT }]);
  // Learned state, not configuration: no change row either way.
  const changes = f.count('change');
  f.ledger.noteQuota(login, [WEEKLY, FABLE], LATER);
  assert.equal(f.count('change'), changes);
});

// -- the usage page ---------------------------------------------------------------------------

const said = (quota?: NodeQuotaStatus): NodeExecutorReport => ({
  at: AT,
  executors: [{ executor: 'claude', installed: true, version: '2.1.303', logged_in: true, ...(quota === undefined ? {} : { quota }) }],
});

// The fixture's h1 with a machine's own login of a quota-less executor beside its claude one, and a hub whose
// report and connection a test decides.
async function page(t: TestContext, state: { report?: NodeExecutorReport | null; connected?: boolean; look?: () => Promise<NodeExecutorReport>; now?: () => number }) {
  const f = fixture(t);
  f.ledger.putMachineLogin({ ...LOGIN.login, executor: 'silent', tiers: {} }, USER);
  const asked: string[] = [];
  const real = createNodes({ ...NODES_TUNED, ledger: f.ledger, log: () => {} });
  const nodes: HttpOptions['nodes'] = {
    ...real,
    reportedExecutors: (id: string) => (id === 'h1' ? state.report ?? null : null),
    connected: (id: string) => id === 'h1' && (state.connected ?? true),
    askExecutors: async (id: string) => {
      asked.push(id);
      if (state.look) return state.look();
      return state.report ?? { at: AT, executors: [] };
    },
  };
  const app = await consoleApp(t, { f, nodes, now: state.now });
  const quota = async (): Promise<QuotaLogin[]> => ((await (await app.get('/api/quota')).json()) as { logins: QuotaLogin[] }).logins;
  const of = async (executor: string): Promise<QuotaLogin> => (await quota()).find((login) => login.machine === 'h1' && login.executor === executor)!;
  const refresh = async (body: unknown): Promise<Response> => app.post('/api/quota/refresh', body);
  return { f, app, quota, of, refresh, asked, claudeLogin: f.ledger.getMachineLogin('h1', 'claude')!.id };
}

test('机器自己的登录给的是它的读数、读到的时刻和上次没读到的原因；不提供读法的执行器如实说不提供', async (t) => {
  const p = await page(t, { report: said({ at: AT, windows: [{ window: WEEKLY.window, used: 0.78, resets_at: null }] }) });
  p.f.ledger.noteQuota(p.claudeLogin, [WEEKLY], AT);
  const claude = await p.of('claude');
  assert.deepEqual(claude.status.usage.map(({ window, used, at }) => [window, used, at]), [[WEEKLY.window, 0.78, AT]]);
  assert.deepEqual(claude.read, { available: true, reading: false, tried_at: AT, failure: null });
  // A failed reading: the figures stay, and the page says when it was tried and why it learned
  // nothing — the machine's own words, from its report.
  p.f.ledger.noteQuota(p.claudeLogin, [WEEKLY], AT);
  const failed = await page(t, { report: said({ at: LATER, windows: [], error: 'claude 的回答读不出来' }) });
  failed.f.ledger.noteQuota(failed.claudeLogin, [WEEKLY], AT);
  const after = await failed.of('claude');
  assert.deepEqual(after.status.usage.map(({ window, used, at }) => [window, used, at]), [[WEEKLY.window, 0.78, AT]], '旧的数字留着');
  assert.deepEqual(after.read, { available: true, reading: false, tried_at: LATER, failure: 'claude 的回答读不出来' });
  // Nothing read yet: the login can be asked, and says there is no reading yet.
  const none = await page(t, { report: said() });
  assert.deepEqual((await none.of('claude')).read, { available: true, reading: false, tried_at: null, failure: null });
  // An executor that declares no reading at all: "这个执行器不提供用量", and no reading is shown as pending.
  const silent = await p.of('silent');
  assert.deepEqual(silent.read, { available: false, why: '这个执行器不提供用量', reading: false, tried_at: null, failure: null });
  assert.deepEqual(silent.status.usage, []);
});

test('a valid reading with no windows is said neutrally and keeps the last figures', async (t) => {
  const p = await page(t, { report: said({ at: LATER, windows: [], absent: true }) });
  p.f.ledger.noteQuota(p.claudeLogin, [WEEKLY], AT);
  const login = await p.of('claude');
  assert.deepEqual(login.status.usage.map(({ window, used, at }) => [window, used, at]), [[WEEKLY.window, 0.78, AT]], '旧的数字留着');
  assert.equal(login.read.failure, null, '不是失败');
  assert.match(login.read.limited!, /没有读到额度窗口/);
});

test('positively matched account and machine login are one row, named by the account', async (t) => {
  const p = await page(t, { report: said({ at: AT, windows: [{ window: WEEKLY.window, used: 0.78, resets_at: null }] }) });
  p.f.ledger.noteIdentity('t1', { organizationId: ORG });
  p.f.ledger.noteIdentity(p.claudeLogin, { organizationId: ORG });
  p.f.ledger.noteQuota(p.claudeLogin, [WEEKLY], AT);
  const groups = await (await p.app.get('/api/accounts')).json() as { login_groups: string[][] };
  assert.deepEqual(groups.login_groups, [['t1', p.claudeLogin]]);
  const claude = (await p.quota()).filter((row) => row.executor === 'claude');
  assert.equal(claude.length, 1, '同一订阅只有一行');
  assert.equal(claude[0]!.machine, null, '命名的是账本里的账号');
  assert.equal(claude[0]!.name, 't1');
  assert.deepEqual(claude[0]!.aliases?.map((alias) => alias.login_id), [p.claudeLogin]);
  assert.deepEqual(claude[0]!.status.usage.map(({ window, used }) => [window, used]), [[WEEKLY.window, 0.78]]);
  // The account's own credential is refused; the group is still readable through the machine.
  p.f.ledger.rejectCredential('t1', 'test-t1');
  const after = (await p.quota()).find((row) => row.executor === 'claude')!;
  assert.equal(after.status.rejected, false, '一份被拒不代表整组');
  assert.equal(after.read.available, true, '机器上的登录还能读');
  // One refresh for the group: it asks the machine's own login, once.
  await p.refresh({ all: true });
  assert.deepEqual(p.asked, ['h1'], '一组只问一次');
});

test('an unknown identity never joins another row', async (t) => {
  const p = await page(t, { report: said({ at: AT, windows: [] }) });
  p.f.ledger.noteIdentity('t1', { organizationId: ORG });
  assert.deepEqual(((await (await p.app.get('/api/accounts')).json()) as { login_groups: string[][] }).login_groups, []);
  // The account has an organization; the machine's own login has none: they stand apart.
  const claude = (await p.quota()).filter((row) => row.executor === 'claude');
  assert.equal(claude.length, 2, '认不出身份的各自一行');
  assert.deepEqual(claude.find((row) => row.machine === null)!.aliases, undefined);
});

test('a machine changing account drops the old reading and regroups', async (t) => {
  const p = await page(t, { report: said({ at: AT, windows: [] }) });
  p.f.ledger.noteIdentity('t1', { organizationId: ORG });
  p.f.ledger.noteIdentity(p.claudeLogin, { organizationId: ORG });
  p.f.ledger.noteQuota(p.claudeLogin, [WEEKLY], AT);
  assert.equal((await p.quota()).filter((row) => row.executor === 'claude').length, 1);
  // The machine's own login now reports another organization: the old windows go with the old
  // identity, and the row follows the new one.
  p.f.ledger.noteMachineIdentity(p.claudeLogin, { organizationId: OTHER_ORG });
  assert.deepEqual(p.f.ledger.loginState(p.claudeLogin).usage, [], '换了组织，旧窗口不跟着走');
  assert.equal((await p.quota()).filter((row) => row.executor === 'claude').length, 2, '换了订阅就不跟旧的合并');
  assert.deepEqual(((await (await p.app.get('/api/accounts')).json()) as { login_groups: string[][] }).login_groups, []);
});

test('单个和整页刷新都不等待机器重看应答，后台失败不拖住页面', { timeout: 5_000 }, async (t) => {
  let rejectLook!: (error: Error) => void;
  const pending = new Promise<NodeExecutorReport>((_resolve, reject) => { rejectLook = reject; });
  const p = await page(t, { report: said(), look: () => pending });
  const single = await p.refresh({ login_id: p.claudeLogin });
  assert.equal(single.status, 200);
  const all = await p.refresh({ all: true });
  assert.equal(all.status, 200);
  assert.deepEqual(p.asked, ['h1', 'h1']);
  rejectLook(new Error('机器应答超时'));
  assert.equal((await p.app.get('/api/quota')).status, 200);
});

test('机器不在线时这个登录问不了，理由写明；机器自己的读数还是在页面上', async (t) => {
  const away = await page(t, { report: said({ at: AT, windows: [] }), connected: false });
  away.f.ledger.noteQuota(away.claudeLogin, [WEEKLY], AT);
  const login = await away.of('claude');
  assert.equal(login.read.available, false);
  assert.match(login.read.why!, /不在线/);
  assert.deepEqual(login.status.usage.map(({ window, at }) => [window, at]), [[WEEKLY.window, AT]], '上次读到的数字照样显示，读于几点也照说');
});

test('“刷新”对机器自己的登录就是让那台机器现在看一次；不提供读法的、不在线的都当场说清', async (t) => {
  const p = await page(t, { report: said({ at: AT, windows: [] }) });
  const answer = await p.refresh({ login_id: p.claudeLogin });
  assert.equal(answer.status, 200);
  assert.deepEqual(p.asked, ['h1'], '问的是那台机器，用的就是“现在看一次”那一条命令');
  assert.equal((await answer.json() as { logins: QuotaLogin[] }).logins.some((login) => login.machine === 'h1'), true);

  const offered = await p.refresh({ all: true });
  assert.equal(offered.status, 200);
  assert.deepEqual(p.asked, ['h1', 'h1'], '整页刷新也问它');

  const silent = p.f.ledger.getMachineLogin('h1', 'silent')!.id;
  const refused = await p.refresh({ login_id: silent });
  assert.equal(refused.status, 400);
  assert.match((await refused.json() as { error: string }).error, /这个执行器不提供用量/);
  assert.deepEqual(p.asked, ['h1', 'h1'], '不提供读法的，一条命令都不发');

  const away = await page(t, { report: said(), connected: false });
  const offline = await away.refresh({ login_id: away.claudeLogin });
  assert.equal(offline.status, 400);
  assert.match((await offline.json() as { error: string }).error, /不在线/);
  assert.deepEqual(away.asked, [], '不在线的机器，一条命令都不发');
  // A refresh of a login nobody holds is still "没有这个账号", not a machine question.
  const unknown = await p.refresh({ login_id: 'nobody' });
  assert.equal(unknown.status, 400);
});


test('machine quota refresh notification', async (t) => {
  let now = Date.now();
  const state: { report: NodeExecutorReport; now: () => number } = { report: said({ at: new Date(now - 1000).toISOString(), windows: [] }), now: () => now };
  const p = await page(t, state);
  const response = await p.refresh({ login_id: p.claudeLogin });
  assert.equal((await response.json() as { logins: QuotaLogin[] }).logins.find(x => x.login_id === p.claudeLogin)!.read.reading, true);
  assert.equal((await p.of('claude')).read.reading, true);
  state.report = said({ at: new Date(now + 1).toISOString(), windows: [], error: 'read failed' });
  assert.equal((await p.of('claude')).read.reading, false);
  await p.refresh({ all: true });
  assert.equal((await p.of('claude')).read.reading, true);
  now += 24 * HOUR;
  assert.equal((await p.of('claude')).read.reading, false);
});

test('额度归属变化后，旧代次的读数和休息不能落到新登录', (t) => {
  const f = fixture(t);
  const id = f.ledger.getMachineLogin('h1', 'claude')!.id;
  f.ledger.noteUsage(id, [WEEKLY]);
  const legacy = f.ledger.quotaGeneration(id);
  assert.equal(legacy, null);
  f.ledger.noteMachineIdentity(id, { accountLabel: 'same', quotaOwner: `v1:${'a'.repeat(64)}` });
  const first = f.ledger.quotaGeneration(id);
  assert.ok(first);
  assert.deepEqual(f.ledger.loginState(id).usage, []);
  f.ledger.noteMachineIdentity(id, {});
  assert.equal(f.ledger.quotaGeneration(id), first);
  f.ledger.noteMachineIdentity(id, { accountLabel: 'same', quotaOwner: `v1:${'b'.repeat(64)}` });
  assert.notEqual(f.ledger.quotaGeneration(id), first);
  f.ledger.noteUsage(id, [WEEKLY], null, first);
  f.ledger.restRouterLogin(id, { message: 'old' }, null, first);
  assert.deepEqual(f.ledger.loginState(id).usage, []);
  assert.equal(f.ledger.loginState(id).rest_until, null);
  f.ledger.noteUsage(id, [FABLE], null, f.ledger.quotaGeneration(id));
  assert.equal(f.ledger.loginState(id).usage[0]?.window, FABLE.window);
});
