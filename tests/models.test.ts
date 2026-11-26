// Guards against what an account's executor reports about its models going wrong: a list
// thrown away because one query failed or answered something unreadable, another account's
// or another executor's answer taken for this one's, a model announced every time it is
// read rather than once, a tier's model disappearing without a word, a hand-written alias
// reported as a disappearance, the periodic round asking accounts that were read a moment
// ago (or never asking at all), one account's failure stopping the others, and the
// account's login token reaching a reason, a log line or the ledger.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import type { ModelInfo } from '../adapters/types.ts';
import type { Account } from '../runner/snapshot.ts';
import { createModels, readModels } from '../service/models.ts';
import type { RefreshResult } from '../service/models.ts';
import { createNotify } from '../service/notify.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { fixture, USER, testCredentialRef, type Fixture } from './helpers.ts';

type Executors = Record<string, typeof claudeAdapter>;
const EXECUTORS: Executors = { claude: claudeAdapter, codex: codexAdapter, dsh: dshAdapter };
const CLAUDE_MODELS = readFileSync(join(import.meta.dirname, 'fixtures', 'claude', 'models', 'models.json'), 'utf8');
const TOKEN = '<令牌>';
const T1 = Date.parse('2026-11-06T00:00:00.000Z');
const AT1 = new Date(T1).toISOString();
const HOUR = 60 * 60 * 1000;
const QUERY_MS = 20_000;

test('暂存令牌不需要账号也能读模型，空回答和报错中的令牌都安全降级', async () => {
  const options = { executor: 'claude', token: TOKEN, executors: EXECUTORS, timeoutMs: QUERY_MS, now: () => T1 };
  const fetched = fakeFetch(() => ({ body: CLAUDE_MODELS }));
  const result = await readModels({ ...options, fetch: fetched.impl });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(ids(result.models), ['<模型甲>', '<模型乙>', '<模型丙>']);
    assert.equal(result.at, AT1);
  }
  assert.equal(fetched.calls.length, 1);
  for (const answer of [new Error(`拒绝 ${TOKEN}`), { body: '{}' }]) {
    const result = await readModels({ ...options, fetch: fakeFetch(() => answer).impl });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
});

test('假 HTTP 服务器：同一令牌读模型和组织，不再问账号资料；模型坏回答仍保留组织', async (t) => {
  const calls: string[] = [];
  let modelsBody = CLAUDE_MODELS;
  const server = createServer((request, response) => {
    calls.push(request.url!);
    assert.equal(request.headers.authorization, 'Bearer fake-token');
    assert.equal(request.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(request.url, '/v1/models?limit=100');
    response.writeHead(200, { 'anthropic-organization-id': 'org-fake' });
    response.end(modelsBody);
  });
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const fetchLocal: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.anthropic.com');
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
  const read = () => readModels({ executor: 'claude', token: 'fake-token', executors: EXECUTORS, timeoutMs: 1000, fetch: fetchLocal });
  const first = await read();
  assert.equal(first.ok, true);
  assert.deepEqual(first.identity, { organizationId: 'org-fake' });
  modelsBody = '{}';
  const bad = await read();
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.identity, { organizationId: 'org-fake' });
  // A Claude login token reads no account profile (its scope is inference only): never asked.
  assert.deepEqual(calls, ['/v1/models?limit=100', '/v1/models?limit=100']);
});

test('模型请求返回 401 时不记下响应头中的组织', async () => {
  const result = await readModels({ executor: 'claude', token: 'fake-token', executors: EXECUTORS, timeoutMs: QUERY_MS,
    fetch: fakeFetch(() => ({ status: 401, headers: { 'anthropic-organization-id': 'org-fake' } })).impl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.identity, {});
});

// The account under test, in the ledger and as the catalog is handed it. Its tier is
// written the way that executor writes one, so what a tier uses is read the same way.
const accountOf = (id: string, executor: string, tierText: string): Account =>
  ({ id, name: id, executor, tiers: { execute: { kind: 'content', text: tierText } } });
const CLAUDE_TIER = (model: string): string => `{\n  "model": "${model}"\n}\n`;

type Answer = { status?: number; body?: string; headers?: Record<string, string> };

// What the service makes of a stand-in HTTP answer.
function fakeFetch(handler: (url: string, headers: Record<string, string>) => Answer | Error | Promise<Answer>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const headers = init?.headers ?? {};
    calls.push({ url, headers });
    const answer = await handler(url, headers);
    if (answer instanceof Error) throw answer;
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, headers: new Headers(answer.headers), text: async () => answer.body ?? '' };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

interface Harness {
  f: Fixture;
  models: ReturnType<typeof createModels>;
  fetch: ReturnType<typeof fakeFetch>;
  rows: () => OutboxRow[];
  logs: string[];
  setNow: (at: number) => void;
  read: () => Promise<RefreshResult>;
}

interface Options {
  executor?: string;
  tier?: string;
  accounts?: Account[];
  // Undefined means the account has no token; a function gives each account its own.
  token?: string | ((id: string) => string);
  fetch?: ReturnType<typeof fakeFetch>;
  // A getter, so a test can change the setting under a running timer.
  refreshMs?: number | (() => number);
  recovering?: () => boolean;
  // The wall clock, for a test that needs time to pass; otherwise fixed at T1 or setNow's.
  realClock?: boolean;
}

// The catalog on a real ledger and the real notification renderer, so "announced once" is
// the Outbox's own record and not a stand-in's count.
function harness(t: Parameters<typeof fixture>[0], options: Options = {}): Harness {
  const f = fixture(t, {}, false);
  const accounts = options.accounts ?? [accountOf('a1', options.executor ?? 'claude', options.tier ?? CLAUDE_TIER('<模型甲>'))];
  for (const account of accounts) f.ledger.putAccount(account, USER, `ref-${account.id}`);
  let at = T1;
  const fetcher = options.fetch ?? fakeFetch(() => ({ body: CLAUDE_MODELS }));
  const logs: string[] = [];
  const notify = createNotify({ ledger: f.ledger, owner: () => 'user', direct: async () => {}, log: () => {} });
  const models = createModels({
    ledger: f.ledger, logins: () => f.ledger.listAccounts(),
    executors: EXECUTORS,
    notify,
    ...(options.token === undefined ? {} : { token: (id: string) => (typeof options.token === 'function' ? options.token(id) : options.token) }),
    fetch: fetcher.impl,
    now: options.realClock ? Date.now : () => at,
    refreshMs: typeof options.refreshMs === 'function' ? options.refreshMs : () => (options.refreshMs as number | undefined) ?? 6 * HOUR,
    timeoutMs: QUERY_MS,
    ...(options.recovering === undefined ? {} : { recovering: options.recovering }),
    log: (line) => logs.push(line),
  });
  const primary = accounts[0]!;
  return {
    f, models, fetch: fetcher, logs,
    rows: () => f.peek<OutboxRow>('SELECT * FROM outbox ORDER BY rowid'),
    setNow: (next) => { at = next; },
    read: () => models.refresh(primary),
  };
}

const stateOf = (f: Fixture, id = 'a1') => f.ledger.loginState(id);
const ids = (models: readonly ModelInfo[]): string[] => models.map((model) => model.id);
const said = (rows: readonly OutboxRow[]): string[] => rows.map((row) => (JSON.parse(row.payload_json) as { content: string }).content);
const keys = (rows: readonly OutboxRow[]): unknown[] => rows.map((row) => (JSON.parse(row.payload_json) as { external_id?: string }).external_id);
const waitUntil = async (done: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 400 && !done(); tries += 1) await sleep(5);
  assert.ok(done(), '等的事情没有发生');
};
// Why a query did not come back with a list. Fails the test when it did come back with one.
function refusal(result: RefreshResult): string {
  assert.equal(result.ok, false, '这次查询本该失败');
  return result.ok ? '' : result.reason;
}

// -- what an executor's own declaration is asked, and what is kept -------------------------

test('an account with a token is read over the API, and the list is kept with when it was read', async (t) => {
  const h = harness(t, { token: TOKEN });
  const answer = await h.read();
  assert.equal(answer.ok, true);
  assert.deepEqual(ids(stateOf(h.f).models), ['<模型甲>', '<模型乙>', '<模型丙>']);
  assert.equal(stateOf(h.f).models_at, AT1);
  assert.deepEqual(h.fetch.calls, [{ url: 'https://api.anthropic.com/v1/models?limit=100', headers: {
    Authorization: `Bearer ${TOKEN}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20',
  } }]);
  assert.deepEqual(h.models.state('a1'), { list: stateOf(h.f).models, at: AT1, refreshing: false });
  assert.deepEqual(h.rows(), [], '第一次读到不发通知');
});

test('定时刷新给已有账号补组织事实，不改配置；没读到不抹掉', async (t) => {
  let headers: Record<string, string> = { 'anthropic-organization-id': 'org-fake' };
  const h = harness(t, { token: TOKEN, fetch: fakeFetch(() => ({ body: CLAUDE_MODELS, headers })) });
  const config = h.f.ledger.getAccount('a1');
  await h.models.refreshDue();
  assert.deepEqual(stateOf(h.f).identity, { organizationId: 'org-fake' });
  assert.deepEqual(h.f.ledger.getAccount('a1'), config);
  headers = {};
  h.setNow(T1 + 7 * HOUR);
  await h.models.refreshDue();
  assert.deepEqual(stateOf(h.f).identity, { organizationId: 'org-fake' });
});

test('旧凭据的模型查询迟到时不会覆盖新凭据的订阅身份', async (t) => {
  let finishOld!: (answer: Answer) => void;
  const old = new Promise<Answer>((resolve) => { finishOld = resolve; });
  let calls = 0;
  const h = harness(t, { token: TOKEN, fetch: fakeFetch(() => ++calls === 1 ? old : ({
    body: CLAUDE_MODELS, headers: { 'anthropic-organization-id': 'new-organization' },
  })) });
  const pending = h.read();
  h.f.ledger.recordAccountCredential('a1', 'ref-new', USER);
  assert.equal((await h.read()).ok, true);
  finishOld({ body: CLAUDE_MODELS, headers: { 'anthropic-organization-id': 'old-organization' } });
  assert.equal((await pending).ok, false);
  assert.deepEqual(stateOf(h.f).identity, { organizationId: 'new-organization' });
});


// An executor that tells its models only through a command of its own is asked on a machine,
// by that machine's client, which reports the list (docs/design/nodes.md §1.2): the service
// asks nothing, and says why, with the last list left standing.
test('an executor that lists its models only by a command on a machine is not asked, and says why', async (t) => {
  const codex = harness(t, { executor: 'codex', tier: 'model=<模型甲>\n' });
  codex.f.ledger.noteModels('a1', [{ id: '<模型甲>' }], AT1);
  const reason = refusal(await codex.read());
  assert.equal(reason, '这个执行器的模型要在机器上问，由机器自己报告');
  assert.deepEqual(ids(stateOf(codex.f).models), ['<模型甲>'], '上次读到的列表还在');
  assert.deepEqual(codex.fetch.calls, [], 'codex 的列表不问 API');
});

test('an executor that cannot say, and one the service has no adapter for, are reasons and not lists', async (t) => {
  const { listModels: _dropped, ...undecided } = claudeAdapter;
  const silent = harness(t, { accounts: [accountOf('a1', 'codex', 'model=<模型甲>\n')] });
  const withoutDeclaration = createModels({
    ledger: silent.f.ledger, logins: () => silent.f.ledger.listAccounts(),
    executors: { codex: undecided as typeof claudeAdapter },
    now: () => T1,
    refreshMs: () => HOUR,
    timeoutMs: QUERY_MS,
    log: () => {},
  });
  const refused = await withoutDeclaration.refresh(silent.f.ledger.getAccount('a1')!);
  assert.equal(refusal(refused), '执行器 codex 不上报模型');
  assert.deepEqual(stateOf(silent.f).models, []);

  const absent = harness(t, { executor: 'none', tier: 'model=<模型甲>\n' });
  assert.equal(refusal(await absent.read()), '没有执行器 none 的适配器');
  assert.deepEqual(stateOf(absent.f).models, []);
});

// -- a failure leaves the last answer standing ---------------------------------------------

test('a query that fails, or answers something unreadable, keeps the last list and its time', async (t) => {
  let answer: Answer | Error = { body: CLAUDE_MODELS };
  const h = harness(t, { token: TOKEN, fetch: fakeFetch(() => answer) });
  assert.equal((await h.read()).ok, true);
  const before = stateOf(h.f);

  for (const [what, next] of [
    ['HTTP 500', { status: 500, body: '' }],
    ['打不开的连接', new Error('连接失败')],
    ['读不出来的一段', { status: 200, body: '不是 JSON' }],
    ['一个空列表', { status: 200, body: '{"data":[]}' }],
  ] as const) {
    h.setNow(T1 + HOUR);
    answer = next;
    const failed = refusal(await h.read());
    assert.ok(failed.length > 0, what);
    assert.deepEqual(stateOf(h.f), before, `${what}：列表和读到的时刻都不动`);
  }

});

// -- what the owner is told, once -----------------------------------------------------------

test('a model the list did not have before is announced once, and never on the first read', async (t) => {
  let body: Answer = { body: JSON.stringify({ data: [{ id: '<模型甲>' }, { id: '<模型乙>' }] }) };
  const h = harness(t, { token: TOKEN, fetch: fakeFetch(() => body) });
  assert.equal((await h.read()).ok, true);
  assert.deepEqual(h.rows(), [], '第一次读到不叫“新模型”');

  h.setNow(T1 + HOUR);
  body = { body: JSON.stringify({ data: [{ id: '<模型甲>' }, { id: '<模型乙>' }, { id: '<模型丙>' }] }) };
  assert.equal((await h.read()).ok, true);
  assert.deepEqual(h.rows().map((row) => row.kind), ['markdown']);
  assert.deepEqual(keys(h.rows()), ['models-added:a1:<模型丙>']);
  assert.match(said(h.rows())[0]!, /a1/);
  assert.match(said(h.rows())[0]!, /<模型丙>/);

  h.setNow(T1 + 2 * HOUR);
  assert.equal((await h.read()).ok, true);
  h.setNow(T1 + 3 * HOUR);
  body = { body: JSON.stringify({ data: [{ id: '<模型甲>' }, { id: '<模型乙>' }] }) };
  assert.equal((await h.read()).ok, true);
  h.setNow(T1 + 4 * HOUR);
  body = { body: JSON.stringify({ data: [{ id: '<模型甲>' }, { id: '<模型乙>' }, { id: '<模型丙>' }] }) };
  assert.equal((await h.read()).ok, true);
  assert.equal(h.rows().length, 1, '同一个模型只通知一次，走了再回来也不再说一遍');
});

test('a model a tier uses that the list no longer has is announced once; one it never had is not', async (t) => {
  let body: Answer = { body: JSON.stringify({ data: [{ id: '<模型甲>' }, { id: '<模型乙>' }] }) };
  const h = harness(t, { tier: CLAUDE_TIER('<模型甲>'), token: TOKEN, fetch: fakeFetch(() => body) });
  assert.equal((await h.read()).ok, true);
  assert.deepEqual(h.rows(), [], '第一次读到不算“不见了”');

  h.setNow(T1 + HOUR);
  body = { body: JSON.stringify({ data: [{ id: '<模型乙>' }] }) };
  assert.equal((await h.read()).ok, true);
  assert.deepEqual(keys(h.rows()), ['models-gone:a1:<模型甲>']);
  assert.match(said(h.rows())[0]!, /<模型甲>/);

  h.setNow(T1 + 2 * HOUR);
  assert.equal((await h.read()).ok, true);
  assert.equal(h.rows().length, 1, '同一个模型只通知一次');

  // A tier that writes an alias nobody ever listed is the owner's own choice, not a model
  // that went away.
  const alias = harness(t, { tier: CLAUDE_TIER('<别名>'), token: TOKEN, fetch: fakeFetch(() => ({ body: JSON.stringify({ data: [{ id: '<模型乙>' }] }) })) });
  assert.equal((await alias.read()).ok, true);
  alias.setNow(T1 + HOUR);
  assert.equal((await alias.read()).ok, true);
  assert.deepEqual(alias.rows(), []);
});

test('what a tier uses is read the way that executor writes a tier', async (t) => {
  // dsh writes `model:` inside the patch's config, so a model gone from the dump is a
  // disappearance like any other.
  const tier = '- id: agent-default-model\n  config:\n    provider: <线路>\n    model: <模型甲>\n';
  let body = 'gateway:\n  config:\n    models: [<模型甲>, <模型乙>]\n';
  // dsh's own listing is a command on a machine; here the same dump comes over a stand-in
  // request, so that only how the tier is read is under test.
  const parse = dshAdapter.listModels!({}).parse;
  const h = harness(t, { executor: 'dsh', tier, token: TOKEN, fetch: fakeFetch(() => ({ body })) });
  const reading = createModels({
    ledger: h.f.ledger, logins: () => h.f.ledger.listAccounts(),
    executors: { dsh: { ...dshAdapter, listModels: () => ({ kind: 'http' as const, url: 'https://stand-in/models', headers: {}, parse }) } },
    notify: createNotify({ ledger: h.f.ledger, owner: () => 'user', direct: async () => {}, log: () => {} }),
    fetch: h.fetch.impl, now: () => at, refreshMs: () => HOUR, timeoutMs: QUERY_MS, log: () => {},
  });
  let at = T1;
  const read = () => reading.refresh(h.f.ledger.getAccount('a1')!);
  assert.equal((await read()).ok, true);
  at = T1 + HOUR;
  body = 'gateway:\n  config:\n    models: [<模型乙>]\n';
  assert.equal((await read()).ok, true);
  assert.deepEqual(keys(h.rows()), ['models-gone:a1:<模型甲>']);
});

// -- the token goes nowhere else -------------------------------------------------------------

test('the token is in the request header and in no reason, log line, notification or ledger row', async (t) => {
  const failing = harness(t, { token: TOKEN, fetch: fakeFetch(() => new Error(`连接失败：${TOKEN}`)) });
  const read = refusal(await failing.read());
  assert.equal(read.includes(TOKEN), false, read);
  // The read just now counts as an attempt: the round asks again an interval later.
  failing.setNow(T1 + 6 * HOUR);
  await failing.models.refreshDue();
  assert.ok(failing.logs.length > 0, '读不到要说一声');
  assert.equal(failing.logs.some((line) => line.includes(TOKEN)), false, failing.logs.join('\n'));
  assert.equal(JSON.stringify(failing.f.peek('SELECT * FROM login_state')).includes(TOKEN), false);

  // The token is still what the query is given: hiding it must not mean not sending it.
  const sent = harness(t, { token: TOKEN });
  assert.equal((await sent.read()).ok, true);
  assert.equal(sent.fetch.calls[0]!.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(JSON.stringify(sent.rows()).includes(TOKEN), false);

});

// -- when the service asks --------------------------------------------------------------------

test('the periodic round asks the accounts whose list is older than the setting, and goes on past a failure', async (t) => {
  const tier = CLAUDE_TIER('<模型甲>');
  const asked: string[] = [];
  const h = harness(t, {
    accounts: [accountOf('stale', 'claude', tier), accountOf('fresh', 'claude', tier), accountOf('never', 'claude', tier)],
    token: (id) => `token-${id}`, refreshMs: HOUR,
    fetch: fakeFetch((_url, headers) => {
      const id = headers.Authorization!.replace('Bearer token-', '');
      asked.push(id);
      return id === 'stale' ? new Error('连不上') : { body: CLAUDE_MODELS };
    }),
  });
  // `fresh` was read a moment ago and `stale` two hours ago; neither is due but `stale` is.
  h.f.ledger.noteModels('fresh', [{ id: '<模型甲>' }], new Date(T1 - 30 * 60_000).toISOString());
  h.f.ledger.noteModels('stale', [{ id: '<模型甲>' }], new Date(T1 - 2 * HOUR).toISOString());

  await h.models.refreshDue();
  assert.deepEqual(asked, ['stale', 'never'], '过期的和没读过的都问，刚读过的不问');
  assert.equal(stateOf(h.f, 'fresh').models_at, new Date(T1 - 30 * 60_000).toISOString(), '没到期的不动');
  assert.equal(stateOf(h.f, 'never').models.length, 3, '一个账号读不到，别的账号照常读到');
  assert.deepEqual(stateOf(h.f, 'stale').models_at, new Date(T1 - 2 * HOUR).toISOString(), '读不到就还用上次读到的');
  assert.ok(h.logs.some((line) => line.includes('stale')), h.logs.join('\n'));
});

test('the round asks nothing while the service is still taking stock', async (t) => {
  const h = harness(t, { token: TOKEN, recovering: () => true });
  await h.models.refreshDue();
  assert.deepEqual(h.fetch.calls, []);
  assert.deepEqual(stateOf(h.f).models, []);
});

test('a query already on its way is the same query, not a second one', async (t) => {
  const waiting = Promise.withResolvers<Answer>();
  const h = harness(t, { token: TOKEN, fetch: fakeFetch(() => waiting.promise) });
  const first = h.read();
  const second = h.read();
  assert.equal(h.models.state('a1').refreshing, true, '问的时候页面能说“正在查询”');
  waiting.resolve({ body: CLAUDE_MODELS });
  assert.deepEqual(await first, await second);
  assert.equal(h.fetch.calls.length, 1);
  assert.equal(h.models.state('a1').refreshing, false);
});

// What these catch: a round on a clock of its own, so a setting shorter than that clock
// never takes hold (it was a fixed ten minutes); a change of the setting waiting for the old
// interval to run out; an account that cannot be reached being asked again at once, whether
// the failed query was the round's or the one a save sends; and a round that goes on asking
// after stock-taking or a stop began. Time is the test's: the timers and the clock are mocked,
// so hours take no time and nothing depends on how busy the machine is.
function mockedTime(t: Parameters<typeof fixture>[0]): { pass: (ms: number) => Promise<void>; settle: () => Promise<void> } {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T1 });
  // Lets the queries' promises and the ledger writes run, and fires what is due by now
  // (a timer set for "at once" included); the clock itself does not move.
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 20; round += 1) {
      t.mock.timers.tick(0);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    settle,
    pass: async (ms) => {
      await settle();
      t.mock.timers.tick(ms);
      await settle();
    },
  };
}

test('the timer runs the round, and stops when the service does', async (t) => {
  const time = mockedTime(t);
  const h = harness(t, { token: TOKEN, refreshMs: HOUR, realClock: true });
  h.models.start();
  t.after(() => h.models.stop());
  await time.settle();
  assert.equal(h.fetch.calls.length, 1, '没读过的账号一开始就问');
  h.models.stop();
  await time.pass(10 * HOUR);
  assert.equal(h.fetch.calls.length, 1, '停下来以后不再问');
  assert.equal(stateOf(h.f).models_at, AT1);
});

test('the round comes when the setting says, at the start and every interval after', async (t) => {
  const time = mockedTime(t);
  const h = harness(t, { token: TOKEN, refreshMs: 20 * 60_000, realClock: true });
  h.models.start();
  t.after(() => h.models.stop());
  await time.settle();
  assert.equal(h.fetch.calls.length, 1);
  await time.pass(20 * 60_000 - 1);
  assert.equal(h.fetch.calls.length, 1, '没到间隔不问');
  await time.pass(1);
  assert.equal(h.fetch.calls.length, 2, '到了 20 分钟的间隔就问，不等另一个 10 分钟的周期');
  await time.pass(20 * 60_000);
  assert.equal(h.fetch.calls.length, 3);
});

test('a shorter setting takes hold at once, not after the longer interval has run out', async (t) => {
  const time = mockedTime(t);
  let refreshMs = HOUR;
  const h = harness(t, { token: TOKEN, refreshMs: () => refreshMs, realClock: true });
  h.models.start();
  t.after(() => h.models.stop());
  await time.settle();
  assert.equal(h.fetch.calls.length, 1);
  await time.pass(30 * 60_000);
  assert.equal(h.fetch.calls.length, 1, '一小时的设置下半小时不问');
  refreshMs = 10 * 60_000;
  h.models.reschedule();
  await time.settle();
  assert.equal(h.fetch.calls.length, 2, '改成 10 分钟，已经过了半小时：马上问');
});

test('an account that cannot be reached is asked again an interval later, not in a loop', async (t) => {
  const time = mockedTime(t);
  const h = harness(t, { token: TOKEN, refreshMs: HOUR, realClock: true, fetch: fakeFetch(() => new Error('连不上')) });
  h.models.start();
  t.after(() => h.models.stop());
  await time.settle();
  assert.equal(h.fetch.calls.length, 1);
  await time.pass(HOUR - 1);
  assert.equal(h.fetch.calls.length, 1, '间隔之内不再问');
  await time.pass(1);
  assert.equal(h.fetch.calls.length, 2, '隔一个间隔再问');
});

test('an account saved after the start whose first query fails is not asked again within the interval', async (t) => {
  const time = mockedTime(t);
  const h = harness(t, { token: TOKEN, accounts: [], refreshMs: HOUR, realClock: true, fetch: fakeFetch(() => new Error('连不上')) });
  h.models.start();
  t.after(() => h.models.stop());
  await time.settle();
  assert.equal(h.fetch.calls.length, 0, '没有账号就没什么可问');
  // What saving an account does: put it in the ledger, then ask about it once.
  const saved = accountOf('a1', 'claude', CLAUDE_TIER('<模型甲>'));
  h.f.ledger.putAccount(saved, USER, testCredentialRef('a1'));
  assert.equal((await h.models.refresh(h.f.ledger.getAccount('a1')!)).ok, false);
  assert.equal(h.fetch.calls.length, 1);
  await time.pass(HOUR - 1);
  assert.equal(h.fetch.calls.length, 1, '保存时那次没问到，间隔之内定时器不再问');
  await time.pass(1);
  assert.equal(h.fetch.calls.length, 2);
  // The owner asking on the page is not held back by the interval.
  await h.models.refresh(h.f.ledger.getAccount('a1')!);
  assert.equal(h.fetch.calls.length, 3, '主人在页面上点查询，马上问');
});

test('nothing is set while the service takes stock; the round starts when it is told the stock is taken', async (t) => {
  const time = mockedTime(t);
  let recovering = true;
  const h = harness(t, { token: TOKEN, refreshMs: 10 * 60_000, realClock: true, recovering: () => recovering });
  h.models.start();
  t.after(() => h.models.stop());
  await time.pass(10 * HOUR);
  assert.deepEqual(h.fetch.calls, []);
  recovering = false;
  h.models.reschedule();
  await time.settle();
  assert.equal(h.fetch.calls.length, 1);
});

test('stock-taking that begins while a query is out stops the round before the next account', async (t) => {
  const time = mockedTime(t);
  let recovering = false;
  const first = Promise.withResolvers<Answer>();
  let answered = 0;
  const h = harness(t, {
    token: TOKEN, refreshMs: HOUR, realClock: true, recovering: () => recovering,
    accounts: [accountOf('a1', 'claude', CLAUDE_TIER('<模型甲>')), accountOf('a2', 'claude', CLAUDE_TIER('<模型甲>'))],
    fetch: fakeFetch(() => (answered++ === 0 ? first.promise : { body: CLAUDE_MODELS })),
  });
  h.models.start();
  t.after(() => h.models.stop());
  await time.settle();
  assert.equal(h.fetch.calls.length, 1, '第一个账号的查询还没回来');
  recovering = true;
  first.resolve({ body: CLAUDE_MODELS });
  await time.settle();
  assert.equal(h.fetch.calls.length, 1, '清点开始了，第二个账号不再问');
  recovering = false;
  h.models.reschedule();
  await time.settle();
  assert.equal(h.fetch.calls.length, 2, '清点结束后接着问第二个');
  assert.equal(stateOf(h.f, 'a2').models.length > 0, true);
});
