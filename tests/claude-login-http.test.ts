// Guards the console's way in to a Claude login (service/http.ts) against: the login's routes
// missing on the outside listener, so the owner cannot sign in from a phone through the
// gateway; the answer holding only part of the address the owner has to open; the code or the
// token coming back out of any read the console makes; the new account's save taking an
// executor or a token from the page instead of the login's; the accounts page offering a login
// the host cannot do, not saying why, or not saying how each executor's account gets its
// login at all (the add-account window is drawn from that); and a whole login through the routes not ending in an account that has
// the token.
import './guard.ts';
import { NO_MACHINE_SIGN_IN_TEXT } from '../shared/sign-in.ts';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClaudeLogin } from '../service/claude-login.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import type { HttpOptions } from '../service/http.ts';
import { windowsCommandLine } from '../service/ptybridge.ts';
import { NO_PAGE_LOGIN_TEXT, UNSUPPORTED_TEXT, type LoginView } from '../shared/claude-login.ts';
import type { AccountLoginOffer } from '../shared/logins.ts';
import { consoleApp } from './console-helpers.ts';
import { claudeTier, fixture, USER } from './helpers.ts';

const windowsOnly = { skip: process.platform !== 'win32' && '登录助手用的是 Windows 的伪终端（ConPTY），只在 Windows 上有', timeout: 120_000 };
const FAKE = join(import.meta.dirname, 'fake-claude-login.mjs');
const GOOD = 'HttpGoodCode5566778899#state-http-123';
const TOKEN = `sk-ant-oat01-${'Http_Tok-9'.repeat(10)}ZZ`;
const PUBLIC = 'https://tycho.example';

// A login that answers without starting anything: for what the routes do, on any platform.
function standIn(): NonNullable<HttpOptions['claudeLogin']> & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const view = (id: string): LoginView => ({ id, account: 'a', name: 'a', mode: 'new', state: 'waiting_code', url: 'https://claude.com/cai/oauth/authorize?state=whole', reason: null, shape: null, saved: false, ended: false, unconfirmed: false, deadline: new Date(0).toISOString(), models: { list: [], at: null, refreshing: false, reason: null }, identity: {}, duplicate: null });
  return {
    calls,
    executor: 'claude',
    available: () => true,
    start: (account, mode) => { calls.push(['start', account, mode]); return view('s1'); },
    get: (id) => view(id),
    submit: (id, code) => { calls.push(['submit', id, code]); return view(id); },
    save: (id, input) => { calls.push(['save', id, input]); throw new Error('not here'); },
    cancel: (id) => { calls.push(['cancel', id]); return { ...view(id), state: 'cancelled' }; },
  };
}

test('登录的接口在对外监听上也有：手机经门牌也能登', async (t) => {
  const login = standIn();
  const app = await consoleApp(t, { claudeLogin: login });
  app.settings.set('http.publicUrl', PUBLIC, USER);
  const port = await app.http.outside.listen(0);
  const credential = new URL(await app.newLink(), app.url).hash.slice(1);
  assert.match(credential, /^[0-9a-f]{64}$/);
  const exchange = await fetch(`http://127.0.0.1:${port}/login`, {
    method: 'POST', headers: { Origin: PUBLIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential }), redirect: 'manual',
  });
  assert.equal(exchange.status, 303);
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  const ask = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Cookie: cookie, Origin: PUBLIC, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const started = await ask('POST', '/api/claude-logins', { mode: 'new' });
  assert.equal(started.status, 201);
  assert.deepEqual(login.calls[0], ['start', undefined, 'new'], '新账号不带名字：名字由账本在保存时定');
  assert.equal(((await started.json()) as { login: LoginView }).login.url, 'https://claude.com/cai/oauth/authorize?state=whole');
  assert.equal((await ask('GET', '/api/claude-logins/s1')).status, 200);
  assert.equal((await ask('POST', '/api/claude-logins/s1/code', { code: 'c' })).status, 200);
  assert.equal((await ask('POST', '/api/claude-logins/s1/cancel')).status, 200);
  assert.deepEqual(login.calls.map(([name]) => name), ['start', 'submit', 'cancel']);
});

test('建账号那一步只收档位和限额：执行器、令牌和名字都是登录给的', async (t) => {
  const login = standIn();
  const app = await consoleApp(t, { claudeLogin: login });
  for (const field of ['credential', 'executor', 'name']) {
    const refused = await app.send('POST', '/api/claude-logins/s1/save', { tiers: {}, [field]: 'x' });
    assert.equal(refused.status, 400, field);
  }
  assert.deepEqual(login.calls, []);
});

test('登录保存接口使用会话已登记的模型，不再次查询，也不接受页面伪造身份事实', async (t) => {
  const f = fixture(t);
  f.ledger.putAccount({ id: 'a', name: 'a', executor: 'claude', tiers: { execute: claudeTier('m') } }, USER, 'fake-ref');
  f.ledger.noteModels('a', [{ id: 'm' }], '2026-11-10T00:00:00Z');
  let refreshes = 0;
  let scheduled = 0;
  const login = standIn();
  login.save = (id) => ({ login: { ...login.get(id), state: 'signed_in', saved: true }, account: f.ledger.getAccount('a')! });
  const app = await consoleApp(t, { f, claudeLogin: login, models: {
    state: () => ({ list: f.ledger.loginState('a').models, at: f.ledger.loginState('a').models_at, refreshing: false }),
    refresh: async () => { refreshes++; return { ok: false, reason: 'should not ask' }; },
    reschedule: () => { scheduled++; },
  } });
  for (const field of ['identity', 'organizationId', 'models']) {
    assert.equal((await app.send('POST', '/api/claude-logins/s1/save', { tiers: {}, [field]: 'fake' })).status, 400);
  }
  const saved = await app.send('POST', '/api/claude-logins/s1/save', { tiers: { execute: claudeTier('m') } });
  assert.equal(saved.status, 201);
  const body = await saved.json() as { account: { models: { list: { id: string }[] } } };
  assert.deepEqual(body.account.models.list, [{ id: 'm' }]);
  assert.equal(refreshes, 0);
  assert.equal(scheduled, 1);
});

test('新账号一建好就读一次额度：账号页不用等用量页打开才有 7 天窗口', async (t) => {
  const f = fixture(t);
  f.ledger.putAccount({ id: 'a', name: 'a', executor: 'claude', tiers: { execute: claudeTier('m') } }, USER, 'fake-ref');
  const asked: string[][] = [];
  const login = standIn();
  login.save = (id) => ({ login: { ...login.get(id), state: 'signed_in', saved: true }, account: f.ledger.getAccount('a')! });
  const app = await consoleApp(t, { f, claudeLogin: login, quota: {
    refusal: () => undefined,
    read: async () => ({ ok: true }),
    readStale: (accounts) => { asked.push(accounts.map((account) => account.id)); },
    state: () => ({ reading: false, tried_at: null, failure: null, limited: null, retry_at: null }),
  } });
  assert.equal((await app.send('POST', '/api/claude-logins/s1/save', { tiers: { execute: claudeTier('m') } })).status, 201);
  assert.deepEqual(asked, [['a']], '登录窗口建好的账号');
  const route = { kind: 'content', text: '- id: agent-default-model\n  config:\n    provider: tycho\n    model: m1\n    reasoningEffort: high\n' };
  const made = await app.send('POST', '/api/accounts', { executor: 'dsh', tiers: { execute: route, decide: route }, credential: 'sk-fake-line-key',
    provider: { line: 'custom', api: 'openai-completions', baseURL: 'http://10.0.0.8:53000/v1', models: [{ id: 'm1', efforts: ['high'] }] } });
  assert.equal(made.status, 201, await made.clone().text());
  const created = ((await made.json()) as { account: { id: string } }).account.id;
  assert.deepEqual(asked.at(-1), [created], '直接建的账号也一样');
  // An edit is not a new login: nothing more is asked.
  const before = asked.length;
  assert.equal((await app.send('PUT', '/api/accounts/a', { name: 'renamed' })).status, 200);
  assert.equal(asked.length, before);
});

const offers = async (app: Awaited<ReturnType<typeof consoleApp>>) =>
  ((await (await app.get('/api/accounts')).json()) as { account_logins: Record<string, AccountLoginOffer[]> }).account_logins;

test('账号页按执行器自己的声明说账号怎么取得登录，以及这台主机现在能不能做', async (t) => {
  const without = await consoleApp(t);
  // Signing in on Claude's own page is its one way: nothing of it is typed.
  const cannot = (why: string) => [{ way: 'page', available: false, why }];
  // Each executor's ways, as its adapter lists them. A service with no login session at all
  // has the page steps for nobody, and one that cannot start a sign-in on a machine says so.
  assert.deepEqual(await offers(without), {
    claude: cannot(NO_PAGE_LOGIN_TEXT),
    codex: [
      { way: 'device', available: false, why: '这个服务还没有启用主机侧设备码登录' },
      { way: 'key', available: true },
      { way: 'machine', available: false, why: NO_MACHINE_SIGN_IN_TEXT },
    ],
    dsh: [{ way: 'provider', available: true }],
    gemini: [
      { way: 'machine', available: false, why: NO_MACHINE_SIGN_IN_TEXT },
      { way: 'key', available: true },
      { way: 'provider', available: true },
    ],
  });
  assert.equal((await without.send('POST', '/api/claude-logins', { account: 'a', mode: 'new' })).status, 400);
  const unsupported = await consoleApp(t, { claudeLogin: { ...standIn(), available: () => false } });
  assert.deepEqual((await offers(unsupported)).claude, cannot(UNSUPPORTED_TEXT));
  // The login session signs in to one executor: no other is offered its steps.
  const elsewhere = await consoleApp(t, { claudeLogin: { ...standIn(), executor: 'codex' } });
  assert.deepEqual((await offers(elsewhere)).claude![0], { way: 'page', available: false, why: NO_PAGE_LOGIN_TEXT });
  const supported = await consoleApp(t, { claudeLogin: standIn() });
  assert.deepEqual((await offers(supported)).claude, [{ way: 'page', available: true }]);
});

async function poll(app: Awaited<ReturnType<typeof consoleApp>>, id: string, pass: (view: LoginView) => boolean): Promise<LoginView> {
  const end = Date.now() + 30_000;
  for (;;) {
    const { login } = (await (await app.get(`/api/claude-logins/${id}`)).json()) as { login: LoginView };
    if (pass(login)) return login;
    if (Date.now() > end) throw new Error(`没等到：${login.state}`);
    await sleep(100);
  }
}

test('经接口走完一次新账号登录：账号建好，读接口里没有码和令牌', windowsOnly, async (t: TestContext) => {
  const app = await consoleApp(t);
  const login = createClaudeLogin({
    dataDir: app.f.dir,
    ledger: app.f.ledger,
    accounts: app.accounts,
    models: { executors: { claude: claudeAdapter }, timeoutMs: 1000, fetch: async () => new Response('{}') },
    limitMs: () => 60_000,
    cleanupMs: () => 8_000,
    settleMs: () => 2_000,
    commandLine: () => windowsCommandLine([process.execPath, FAKE]),
    env: () => ({ ...process.env, FAKE_LOGIN_GOOD: GOOD, FAKE_LOGIN_TOKEN: TOKEN }),
    log: () => {},
  });
  t.after(() => login.stopAll({ close: true }));
  const served = await consoleApp(t, { f: app.f, claudeLogin: login });
  assert.deepEqual((await offers(served)).claude![0], { way: 'page', available: true });
  const started = await served.send('POST', '/api/claude-logins', { mode: 'new' });
  assert.equal(started.status, 201);
  const { login: { id } } = (await started.json()) as { login: LoginView };
  const offered = await poll(served, id, (view) => view.state !== 'preparing');
  assert.match(offered.url!, /\/oauth\/authorize\?.*state=/);
  assert.equal((await served.send('POST', `/api/claude-logins/${id}/code`, { code: GOOD })).status, 200);
  const signedIn = await poll(served, id, (view) => view.state !== 'exchanging' && view.ended);
  assert.equal(signedIn.state, 'signed_in');
  const saved = await served.send('POST', `/api/claude-logins/${id}/save`, { tiers: { execute: claudeTier('m') } });
  assert.equal(saved.status, 201, await saved.clone().text());
  const { account } = await saved.json() as { account: { id: string; name: string; credential: string } };
  // No name was sent and the identity could not be read: the ledger's own fallback names it.
  assert.equal(account.name, 'claude 账号');
  assert.equal(account.credential, 'set');
  assert.equal(served.accounts.credentialOf(account.id)!.value, TOKEN);
  for (const path of ['/api/accounts', `/api/claude-logins/${id}`, '/api/settings', '/api/state', '/api/overview']) {
    const text = await (await served.get(path)).text();
    assert.ok(!text.includes(TOKEN) && !text.includes(GOOD), path);
  }
});
