// The whole service on fake machines, for what only shows when its parts work together.
// Guards against a used-up quota reaching the owner at all on the way from the Worker's
// output to the next round: a Task that stops, a line under "需要你", a notification; the
// Task not moving to the next account by itself, or the first account never coming back;
// the pages not saying what a waiting Task waits for, or listing it with what needs the
// owner; the machines page not showing a rest, a ceiling or the usage, "现在就试" not
// ending a rest, a ceiling that cannot be saved or cleared from the console, or one that
// the dispatcher does not go by; and the new route missing from the outside listener's
// table, where everything a signed-in owner can do has to be.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account } from '../runner/snapshot.ts';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import { DONE } from './helpers.ts';
import type { Service } from './stage.ts';
import { signIn, stage, LOGIN, until } from './stage.ts';
import { setTimeout as sleep } from 'node:timers/promises';

const USER = { actor: 'test' };
const HOUR = 60 * 60 * 1000;
const options = { timeout: 60_000 };
// Two accounts, each a login tycho keeps: either may run on h1 or h2.
const FIRST: Account = { id: 't1', name: 't1', executor: 'claude', tiers: LOGIN.tiers };
const OTHER: Account = { ...FIRST, id: 't2', name: 't2' };
const json = async (response: Response): Promise<any> => response.json();

// The window line and the failed result a Worker leaves when the quota runs out, with
// the time it comes back in epoch seconds.
function quotaOutput(resetsAt: number): string {
  return [
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt } } } },
    { type: 'result', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', result: "You've hit your session limit", session_id: 's' },
  ].map((line) => `${JSON.stringify(line)}\n`).join('');
}

function setup(t: Parameters<typeof stage>[0]) {
  const s = stage(t, { t1: FIRST, t2: OTHER }, ['h1', 'h2']);
  let skew = 0;
  let first = true;
  const start = async () => {
    const service = await s.start({ now: () => Date.now() + skew }, first ? { credentials: { t1: 'token-t1', t2: 'token-t2' } } : {});
    first = false;
    const projectId = service.ledger.createProject({ name: '贯穿', logins: ['t1', 't2'] }, USER);
    const queued = (title: string, loginId?: string): TaskRow => {
      const task = service.ledger.createTask({ projectId, title, goal: '目标', acceptance: '测试通过', roleId: 'implement', ...(loginId ? { loginId } : {}) }, USER);
      service.ledger.queueTask(task.id, USER);
      return service.ledger.getTask(task.id);
    };
    const browser = await signIn(service);
    const put = (url: string, body: unknown): Promise<Response> =>
      fetch(`${browser.base}${url}`, { method: 'PUT', headers: { Cookie: browser.cookie, Origin: browser.base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const account = async (id: string) => (await json(await browser.get('/api/accounts'))).accounts.find((each: { id: string }) => each.id === id);
    return { service, queued, browser, put, account };
  };
  // The Run after `previous` of this Task, once its start has reached a machine.
  const next = (service: Service, task: TaskRow, previous?: RunRow): Promise<RunRow> =>
    until(() => {
      const run = s.runsOf(service, task).at(-1);
      return run && run.id !== previous?.id && s.remote.called('start.sh', run.id) > 0 && run.state === 'running' && run;
    }, `任务 ${task.title} 的下一轮启动`);
  const usedUp = (run: RunRow, resetsAt: number): void => {
    Object.assign(s.remote.runOf(run.id), { stdout: quotaOutput(resetsAt), exit: 1, pid_alive: false, marked: false, launcher_alive: false });
  };
  return { s, start, next, usedUp, advance: (ms: number) => { skew += ms; } };
}

test('one Task, two accounts: the first runs out of quota, the Task finishes on the second, and the owner is asked nothing', options, async (t) => {
  const { s, start, next, usedUp, advance } = setup(t);
  const { service, queued, browser, account } = await start();
  const task = queued('贯穿任务');
  const first = await next(service, task);
  assert.deepEqual([first.login_id, first.host], ['t1', 'h1']);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  usedUp(first, resetsAt);

  const second = await next(service, task, first);
  assert.equal(second.login_id, 't2', '自动换到下一个账号');
  assert.equal(service.ledger.getRun(first.id).exit_kind, 'quota');
  assert.match(s.snapshotOf(second).brief, /先核对现场/);

  // While it runs on the second account: the first rests, and nothing waits for the owner.
  const resting = await account('t1');
  assert.deepEqual(resting.status.rest, { until: new Date(resetsAt * 1000).toISOString(), reason: "You've hit your session limit" });
  assert.deepEqual(resting.status.usage.map((figure: { window: string; used: number }) => [figure.window, figure.used]), [['five_hour', 1]]);
  assert.deepEqual([(await account('t2')).status.rest, (await account('t2')).status.active_runs], [null, 1]);
  const overview = await json(await browser.get('/api/overview'));
  assert.deepEqual([overview.approvals, overview.held, overview.no_machine], [[], [], []], '“需要你”里什么都没有');
  assert.deepEqual(overview.moving.map((work: { id: string }) => work.id), [task.id]);
  assert.equal((await json(await browser.get('/api/summary'))).waiting, 0);

  s.remote.finish(second.id, DONE);
  await until(() => service.ledger.getTask(task.id).state === 'ready', '任务在第二个目标上完成');
  const page = await json(await browser.get(`/api/tasks/${task.id}`));
  assert.deepEqual(page.runs.map((run: RunRow) => [run.login_id, run.exit_kind]), [['t1', 'quota'], ['t2', 'completed']]);
  assert.deepEqual(page.runs[0].error.quota, { login_id: 't1', login_name: 't1', message: "You've hit your session limit", resets_at: resting.status.rest.until, rest_until: resting.status.rest.until });
  // The timeline keeps the record: which round, on which account, until when.
  const continued = service.ledger.listChanges({ taskId: task.id }).find(({ action }) => action === 'task.continue')!;
  assert.deepEqual(JSON.parse(continued.detail_json!), { reason: '额度用完', basis: 'quota', run_id: first.id, host: 'h1', login_id: 't1', rest_until: resting.status.rest.until });
  // Nothing was ever queued for the owner, and the Task was never stopped.
  assert.deepEqual(service.ledger.outbox.counts(), { pending: 0, given_up: 0 });
  assert.equal(service.ledger.listChanges({ taskId: task.id }).some(({ action }) => action === 'task.hold' || action === 'approval.open'), false);
  const event = service.ledger.listMessages({ limit: 1000 }).find((row) => row.external_id === `run:${first.id}`)!;
  assert.match(event.text, /不需要处理/);

  // The first account is back at its time: it is the project's first, so it is used again.
  advance(HOUR + 60_000);
  assert.equal((await account('t1')).status.rest, null);
  const later = queued('恢复之后');
  assert.equal((await next(service, later)).login_id, 't1');
});

test('a pinned Task waits where the pages can see why, under what is moving, and "现在就试" sends it off', options, async (t) => {
  const { start, next, usedUp } = setup(t);
  const { service, queued, browser, account } = await start();
  const task = queued('钉在 t1 上', 't1');
  const first = await next(service, task);
  usedUp(first, Math.floor(Date.now() / 1000) + 2 * 3600);
  await until(() => service.ledger.getRun(first.id).state === 'ended', '额度用完的一轮结算');
  const until2h = service.ledger.loginState('t1').rest_until;
  const waiting = { rest: { login: 't1', until: until2h }, full: [], no_machine: [] };

  const listed = (await json(await browser.get('/api/tasks'))).tasks.find((each: { id: string }) => each.id === task.id);
  assert.deepEqual([listed.state, listed.reason, listed.waiting], ['queued', null, waiting]);
  const overview = await json(await browser.get('/api/overview'));
  assert.deepEqual(overview.moving.map((work: { id: string; waiting: unknown }) => [work.id, work.waiting]), [[task.id, waiting]]);
  assert.deepEqual([overview.held, overview.approvals, overview.counts.waiting], [[], [], 0]);
  assert.deepEqual((await json(await browser.get(`/api/tasks/${task.id}`))).task.waiting, waiting);
  assert.equal((await account('t1')).queued_tasks, 1);
  assert.equal(service.ledger.listRuns(task.id).length, 1, '歇着期间不派');

  const retried = await browser.post('/api/accounts/t1/retry');
  assert.equal(retried.status, 200);
  assert.equal((await json(retried)).account.status.rest, null);
  assert.equal((await next(service, task, first)).login_id, 't1');
  assert.equal((await browser.post('/api/accounts/gone/retry')).status, 400);
});

test('the ceiling is saved and cleared from the console, and the dispatcher goes by it at once', options, async (t) => {
  const { start, next } = setup(t);
  const { service, queued, browser, put, account } = await start();
  const body = { executor: 'claude', tiers: { execute: { kind: 'content', text: '{"model":"m"}' } } };
  for (const bad of [0, -1, 1.5, 'two']) {
    const refused = await put('/api/accounts/t1', { ...body, max_runs: bad });
    assert.equal(refused.status, 400);
    assert.match((await json(refused)).error, /同时最多几轮执行应为正整数/);
  }
  const saved = await put('/api/accounts/t1', { ...body, max_runs: 1 });
  assert.equal(saved.status, 200);
  assert.deepEqual([(await json(saved)).account.max_runs, service.ledger.getAccount('t1')!.maxRuns], [1, 1]);
  assert.equal((await account('t1')).max_runs, 1);

  const one = queued('第一个', 't1');
  const two = queued('第二个', 't1');
  await next(service, one);
  // The first Run is under way, so the second Task has nowhere to go: the pages say so.
  const listed = (await json(await browser.get('/api/tasks'))).tasks.find((each: { id: string }) => each.id === two.id);
  const full = await account('t1');
  assert.deepEqual([full.status.active_runs, full.status.max_runs, full.queued_tasks], [1, 1, 1]);
  assert.deepEqual([listed.state, listed.waiting], ['queued', { rest: null, full: ['t1'], no_machine: [] }]);
  // Several rounds of dispatch later it is still waiting.
  await sleep(200);
  assert.equal(service.ledger.listRuns(two.id).length, 0);

  const cleared = await put('/api/accounts/t1', { ...body, max_runs: null });
  assert.deepEqual([cleared.status, (await json(cleared)).account.max_runs], [200, null]);
  assert.equal(service.ledger.getAccount('t1')!.maxRuns, undefined);
  assert.equal((await next(service, two)).login_id, 't1', '清掉上限就不限了');
});
