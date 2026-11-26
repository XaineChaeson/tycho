// The whole service on fake machines. Guards against: a round's use reported by its executor
// not reaching the usage page; a range the page cannot read taken as some
// other range; the quota page leaving out an account, or a refresh of a login that is not one
// taken as a refresh of all, or a refresh waiting for a slow quota read.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { ADAPTERS } from '../adapters/all.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import type { Account } from '../runner/snapshot.ts';
import { DONE } from './helpers.ts';
import { LOGIN, signIn, stage, until } from './stage.ts';

const USER = { actor: 'test' };
const ACCOUNT: Account = { id: 't1', name: 't1', executor: 'claude', tiers: LOGIN.tiers };
const json = async (response: Response): Promise<any> => response.json();

test('all and single refresh return old figures while each account reads once; GET sees independent results', { timeout: 60_000 }, async (t) => {
  const pending = new Map<string, ServerResponse>();
  const asked: string[] = [];
  const api = createServer((req, res) => {
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'available-model' }] })); return; }
    const id = req.headers.authorization === 'Bearer token-t1' ? 't1' : 't2';
    asked.push(id);
    pending.set(id, res);
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { api.closeAllConnections(); api.close(() => resolve()); }));
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const s = stage(t, { t1: ACCOUNT, t2: { ...ACCOUNT, id: 't2', name: 't2' } }, []);
  const service = await s.start({ adapters: { ...ADAPTERS, claude: {
    ...claudeAdapter,
    listModels: (context) => {
      const query = claudeAdapter.listModels!(context);
      assert.equal(query.kind, 'http');
      return { ...query, url: `${base}/v1/models` };
    },
    quotaRead: (context) => ({ ...claudeAdapter.quotaRead!(context), url: `${base}/v1/messages` }),
  } } }, { credentials: { t1: 'token-t1', t2: 'token-t2' }, settings: { 'quota.readStaleMs': 0 } });
  for (const id of ['t1', 't2']) {
    service.ledger.noteModels(id, [{ id: 'available-model' }], new Date().toISOString());
    service.ledger.noteUsage(id, [{ window: 'seven_day', used: 0.2, resetsAt: '2999-01-01T00:00:00.000Z' }]);
  }
  const browser = await signIn(service);
  const response = await browser.post('/api/quota/refresh', { all: true });
  assert.equal(response.status, 200);
  const page = await json(response);
  assert.deepEqual(page.logins.map((login: any) => [login.read.reading, login.status.usage[0].used]), [[true, 0.2], [true, 0.2]]);
  const singles = await Promise.all([browser.post('/api/quota/refresh', { login_id: 't1' }), browser.post('/api/quota/refresh', { all: true })]);
  for (const each of singles) assert.equal((await json(each)).logins[0].read.reading, true);
  await until(() => pending.size === 2, '两个账号的请求到达');
  assert.deepEqual(asked.sort(), ['t1', 't2']);
  const finish = (id: string) => {
    pending.get(id)!.writeHead(200, { 'anthropic-ratelimit-unified-7d-utilization': '0.78', 'anthropic-ratelimit-unified-7d-reset': '4102444800' });
    pending.get(id)!.end(JSON.stringify({ model: 'available-model', usage: { input_tokens: 3, output_tokens: 1 } }));
  };
  finish('t1');
  await until(() => service.ledger.loginState('t1').usage[0]?.used === 0.78, '第一个账号写入');
  const next = await json(await browser.get('/api/quota'));
  assert.deepEqual(next.logins.map((login: any) => [login.read.reading, login.status.usage[0].used]), [[false, 0.78], [true, 0.2]]);
  finish('t2');
  await until(() => service.ledger.loginState('t2').usage[0]?.used === 0.78, '第二个账号写入');
  assert.ok((await json(await browser.get('/api/quota'))).logins.every((login: any) => !login.read.reading));
});

const output = [
  { type: 'result', is_error: false, result: ['好了', '```receipt', JSON.stringify(DONE), '```'].join('\n'), session_id: 's', model_usage_since_last_result: { 'model-a': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.5, costBasis: 'list' } } },
].map((line) => `${JSON.stringify(line)}\n`).join('');

test('a round reports its use on the usage page; the quota page lists every login and asks only accounts', { timeout: 60_000 }, async (t) => {
  const s = stage(t, { t1: ACCOUNT }, ['h1']);
  const service = await s.start({}, { credentials: { t1: 'token-t1' } });
  const projectId = service.ledger.createProject({ name: '用量', logins: ['t1'] }, USER);
  const task = service.ledger.createTask({ projectId, title: '算一算', goal: '目标', acceptance: '测试通过', roleId: 'implement' }, USER);
  service.ledger.queueTask(task.id, USER);
  const run = await until(() => {
    const held = s.runsOf(service, service.ledger.getTask(task.id)).at(-1);
    return held && s.remote.called('start.sh', held.id) > 0 && held.state === 'running' && held;
  }, '这一轮启动');
  Object.assign(s.remote.runOf(run.id), { stdout: output, exit: 0, pid_alive: false, marked: false, launcher_alive: false });
  await until(() => service.ledger.getRun(run.id).state === 'ended', '这一轮结算');

  const browser = await signIn(service);
  const from = new Date(Date.now() - 3600_000).toISOString();
  const to = new Date(Date.now() + 3600_000).toISOString();
  const report = await json(await browser.get(`/api/usage?from=${from}&to=${to}&tz=480`));
  assert.equal(report.units.length, 1);
  assert.equal(report.units[0].project_id, projectId);
  assert.deepEqual(report.usage.map((cell: { model: string; input: number; list_cost_usd: number }) => [cell.model, cell.input, cell.list_cost_usd]), [['model-a', 10, 0.5]]);
  assert.equal(report.names.projects[projectId], '用量');
  assert.equal(report.top_tasks[0].task_id, task.id);
  assert.equal((await browser.get(`/api/usage?from=yesterday&to=${to}`)).status, 400);
  assert.equal((await browser.get(`/api/usage?from=${from}&to=${to}&tz=1.5`)).status, 400);

  const quota = await json(await browser.get('/api/quota'));
  const account = quota.logins.find((login: { name: string; machine: string | null }) => login.name === 't1' && login.machine === null);
  assert.equal(account.read.available, true);
  const refused = await browser.post('/api/quota/refresh', { login_id: 'no-such-login' });
  assert.equal(refused.status, 400);
  assert.match((await json(refused)).error, /没有这个账号/);

});
