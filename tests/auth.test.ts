// Guards against a login link that outlives its ten minutes or works twice, a cookie
// missing the attributes §9 relies on, a session that survives logout or expiry, one
// lost to a restart, a foreign page posting with the owner's cookie, and the tool
// token or the Bearer routes being confused with a browser session.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { createAcceptor } from '../service/accept.ts';
import { createAccounts } from '../service/accounts.ts';
import { createAuth, PASSPHRASE_MAX_CONCURRENT_SCRYPT, PASSPHRASE_MAX_FAILURE_KEYS } from '../service/auth.ts';
import { createHttp, createStream } from '../service/http.ts';
import { createInbounds } from '../service/inbound.ts';
import { createLogins } from '../service/logins.ts';
import { createMachines } from '../service/machines.ts';
import { createNodes } from '../service/nodes.ts';
import { knowledgeTokenStore, passphraseSecretFile } from '../service/secrets.ts';
import { serviceSettings } from '../service/service-settings.ts';
import { SETTINGS } from '../service/settings.ts';
import { createTools } from '../service/tools.ts';
import { consoleApp, LOGIN_TOKEN, SHUTDOWN_TOKEN, TOOL_TOKEN } from './console-helpers.ts';
import { CONSOLE_DIST, fixture, HTTP_TUNED, NODES_TUNED, tuned, USER } from './helpers.ts';

const TUNING = { linkTtlMs: tuned('login.linkTtlMs'), sessionDays: tuned('login.sessionDays'), temporarySessionMs: tuned('login.temporarySessionMs') };

const TEN_MINUTES = 10 * 60_000;
const ONE_DAY = 24 * 3600_000;
const THIRTY_DAYS = 30 * ONE_DAY;

test('a link is good for ten minutes, not a moment longer', async (t) => {
  let clock = 1_000_000;
  const app = await consoleApp(t, { now: () => clock });
  const early = await app.newLink();
  const late = await app.newLink();
  clock += TEN_MINUTES - 1;
  assert.equal((await app.exchange(early)).status, 303);
  clock += 1;
  assert.equal((await app.get(late, {})).status, 200);
  assert.equal((await app.exchange(late)).status, 410);
});

test('a link works once, and opening the page does not use it up', async (t) => {
  const app = await consoleApp(t);
  const path = await app.newLink();
  assert.match(path, /^\/login#[0-9a-f]{64}$/);
  const page = await app.get(path, {});
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post"/);
  assert.equal((await app.get(path, {})).status, 200);
  assert.equal((await app.exchange(path)).status, 303);
  assert.equal((await app.exchange(path)).status, 410);
  assert.equal((await app.get(path, {})).status, 200);
});

test('the cookie carries exactly the attributes of §9', async (t) => {
  const app = await consoleApp(t);
  const response = await app.exchange(await app.newLink());
  assert.equal(response.headers.get('location'), '/');
  assert.match(
    response.headers.get('set-cookie')!,
    /^tycho=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/,
  );
  // Outside listener also marks the cookie Secure alongside SameSite=Lax.
  app.settings.set('http.publicUrl', 'https://tycho.example', USER);
  const outsidePort = await app.http.outside.listen(0);
  const link = await app.newLink();
  const outsideResponse = await fetch(`http://127.0.0.1:${outsidePort}/login`, {
    method: 'POST',
    headers: { Origin: 'https://tycho.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: link.slice('/login#'.length) }),
    redirect: 'manual',
  });
  assert.equal(outsideResponse.status, 303);
  assert.match(
    outsideResponse.headers.get('set-cookie')!,
    /^tycho=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=2592000$/,
  );
});

test('the ledger stores nothing that works as a cookie', async (t) => {
  const app = await consoleApp(t);
  const [session] = app.f.ledger.listConsoleSessions();
  assert.ok(session);
  assert.equal(JSON.stringify(app.f.dump()).includes(app.cookie.slice('tycho='.length)), false);
});

test('a foreign page cannot consume a link', async (t) => {
  const app = await consoleApp(t);
  const path = await app.newLink();
  assert.equal((await app.exchange(path, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await app.exchange(path, {})).status, 403);
  assert.equal((await app.exchange(path)).status, 303);
});

test('a same-origin fetch metadata header stands in for a missing Origin', async (t) => {
  const app = await consoleApp(t);
  assert.equal((await app.exchange(await app.newLink(), { 'Sec-Fetch-Site': 'same-origin' })).status, 303);
  assert.equal((await app.exchange(await app.newLink(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('without a valid cookie the API says 401 and pages send you to the login notice', async (t) => {
  const app = await consoleApp(t);
  const nobody = {};
  for (const path of ['/api/messages', '/api/state', '/api/stream', '/api/tasks?top=1', '/api/nope']) {
    assert.equal((await app.get(path, nobody)).status, 401, path);
    assert.equal((await app.get(path, { Cookie: 'tycho=wrong' })).status, 401, path);
  }
  for (const path of ['/', '/assets/index-0a1b2c3d.js', '/favicon.svg', '/nope']) {
    const response = await app.get(path, nobody);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), '/login');
  }
  const notice = await app.get('/login', nobody);
  assert.equal(notice.status, 200);
  assert.match(await notice.text(), /进入 Tycho/);
  assert.equal((await app.post('/api/messages', { text: 'x' }, app.origin)).status, 401);
});

test('a write from a foreign page is refused even with the cookie', async (t) => {
  const app = await consoleApp(t);
  const before = app.f.count('message');
  for (const headers of [
    { Cookie: app.cookie },
    { Cookie: app.cookie, Origin: 'http://evil.example' },
    { Cookie: app.cookie, Origin: 'null' },
    { Cookie: app.cookie, 'Sec-Fetch-Site': 'cross-site' },
  ] as Record<string, string>[]) {
    assert.equal((await app.post('/api/messages', { text: 'x' }, headers)).status, 403);
    assert.equal((await app.post('/api/logout', {}, headers)).status, 403);
    assert.equal((await app.post('/api/interrupt', {}, headers)).status, 403);
  }
  assert.equal(app.f.count('message'), before);
  assert.equal((await app.get('/api/state')).status, 200);
});

test('logging out ends this session, clears the cookie and leaves other devices alone', async (t) => {
  const app = await consoleApp(t);
  const other = await app.signIn();
  const response = await app.post('/api/logout');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), 'tycho=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  assert.equal((await app.get('/api/state')).status, 401);
  assert.equal((await app.get('/api/state', { Cookie: other })).status, 200);
  const audit = app.f.peek<{ action: string; actor: string }>(
    `SELECT action, actor FROM change WHERE action LIKE 'console.%' ORDER BY seq`,
  );
  assert.deepEqual(audit.map(({ action }) => action), ['console.login', 'console.login', 'console.logout']);
  assert.equal(audit[2]?.actor, 'console');
});

test('logging out cuts the stream that session had open', async (t) => {
  const app = await consoleApp(t);
  const stream = await app.get('/api/stream');
  assert.equal(stream.status, 200);
  assert.equal(app.stream.size, 1);
  await app.post('/api/logout');
  assert.equal(app.stream.size, 0);
  await stream.body!.cancel();
});

test('a session stops working when its cookie would have expired, and goes at the next login', (t) => {
  const f = fixture(t);
  let clock = 1_000_000;
  const auth = createAuth({ ledger: f.ledger, ...TUNING, now: () => clock });
  const signIn = () => auth.login(auth.createLink().credential)!;
  const cookie = signIn().split(';')[0]!;
  clock += THIRTY_DAYS - 1;
  assert.ok(auth.authenticate(cookie));
  clock += 1;
  assert.equal(auth.authenticate(cookie), undefined);
  assert.equal(f.ledger.listConsoleSessions().length, 1);
  signIn();
  assert.equal(f.ledger.listConsoleSessions().length, 1);
});

test('a session survives a restart, and an unused link does not', async (t) => {
  const app = await consoleApp(t);
  const unused = (await app.newLink()).slice('/login#'.length);
  const reopened = createAuth({ ledger: app.f.open(), ...TUNING });
  assert.ok(reopened.authenticate(app.cookie));
  assert.equal(reopened.linkIsLive(unused), false);
  assert.equal(reopened.login(unused), undefined);
});

test('a login that could not be stored leaves the link usable', (t) => {
  const f = fixture(t);
  const auth = createAuth({ ledger: f.ledger, ...TUNING });
  const id = auth.createLink().credential;
  f.force(`CREATE TRIGGER refuse BEFORE INSERT ON setting BEGIN SELECT RAISE(ABORT, 'no'); END`);
  assert.throws(() => auth.login(id));
  assert.equal(auth.linkIsLive(id), true);
});

test('login links need the internal token', async (t) => {
  const app = await consoleApp(t);
  const ask = (headers: Record<string, string>) => fetch(`${app.url}/api/login-links`, { method: 'POST', headers });
  assert.equal((await ask({})).status, 401);
  assert.equal((await ask({ Authorization: `Bearer ${TOOL_TOKEN}` })).status, 401);
  assert.equal((await ask({ Cookie: app.cookie, ...app.origin })).status, 401);
  const response = await ask({ Authorization: `Bearer ${LOGIN_TOKEN}` });
  assert.equal(response.status, 201);
  const { path, expires_at } = (await response.json()) as { path: string; expires_at: string };
  assert.match(path, /^\/login#[0-9a-f]{64}$/);
  assert.ok(new Date(expires_at).getTime() > Date.now());
});

test('the tool routes take their Bearer token and nothing a browser holds', async (t) => {
  const app = await consoleApp(t);
  assert.equal((await app.post('/tools/list', {}, app.browser)).status, 401);
  assert.equal((await app.post('/tools/list', {}, { Authorization: `Bearer ${LOGIN_TOKEN}` })).status, 401);
  assert.equal((await app.post('/tools/list', {}, { Authorization: `Bearer ${TOOL_TOKEN}` })).status, 200);
});

test('a new link takes the new lifetime, one already out keeps its own, and a reply states the current one', async (t) => {
  const f = fixture(t);
  let clock = 1_000_000;
  let ttl = 10 * 60_000;
  const auth = createAuth({ ledger: f.ledger, linkTtlMs: () => ttl, sessionDays: () => 30, temporarySessionMs: tuned('login.temporarySessionMs'), now: () => clock });
  const old = auth.createLink().credential;
  ttl = 60_000;
  const short = auth.createLink();
  assert.equal(Date.parse(short.expires_at), clock + 60_000);
  assert.equal(auth.linkValidity(), '1 分钟');
  clock += 60_001;
  assert.equal(auth.linkIsLive(short.credential), false);
  assert.equal(auth.linkIsLive(old), true);
  ttl = 90_000;
  assert.equal(auth.linkValidity(), '1.5 分钟');
});

test('the dead-link page names no lifetime: the one in force now is not the one the link was sent under', async (t) => {
  const app = await consoleApp(t, { channels: () => ({ wecom: {} }) });
  const used = await app.newLink();
  await app.exchange(used);
  app.settings.set('login.linkTtlMs', 25 * 60_000, USER);
  const pages = [await app.exchange(used), await app.exchange(`/login#${'0'.repeat(64)}`)];
  for (const page of pages) {
    assert.equal(page.status, 410);
    const text = await page.text();
    assert.match(text, /链接已失效或已经用过/);
    assert.match(text, /请重新获取。请私聊机器人发‘登录’获取链接，也可在本机运行 npm run login-link 获取链接。/);
    assert.doesNotMatch(text, /分钟|小时|内有效/);
  }
});

test('the session length is checked against the setting as it stands, for sessions already open too', (t) => {
  const f = fixture(t);
  let clock = 1_000_000;
  let days = 30;
  const auth = createAuth({ ledger: f.ledger, linkTtlMs: () => 60_000, sessionDays: () => days, temporarySessionMs: tuned('login.temporarySessionMs'), now: () => clock });
  const set = auth.login(auth.createLink().credential)!;
  assert.match(set, new RegExp(`Max-Age=${30 * 86_400}`));
  const cookie = set.split(';')[0]!;
  clock += 2 * 86_400_000;
  assert.ok(auth.authenticate(cookie));
  days = 1;
  assert.equal(auth.authenticate(cookie), undefined, '缩短后超过新天数的立即失效');
  days = 3;
  assert.ok(auth.authenticate(cookie), '账本里的会话还在，放宽后按新值算');
  days = 7;
  assert.match(auth.login(auth.createLink().credential)!, new RegExp(`Max-Age=${7 * 86_400}`));
});

test('sliding session extends expires_at and refreshes cookie once per day, while temporary sessions never extend', async (t) => {
  let clock = 1_000_000;
  const app = await consoleApp(t, { now: () => clock });
  const initial = app.f.ledger.listConsoleSessions()[0]!;
  const initialExpiry = Date.parse(initial.expires_at!);

  // Within the first day: no Set-Cookie refresh yet.
  clock += ONE_DAY - 10_000;
  const beforeDay = await app.get('/');
  assert.equal(beforeDay.status, 200);
  assert.equal(beforeDay.headers.get('set-cookie'), null);

  // Past 1 full day: GET / extends expires_at and returns a refreshed SameSite=Lax cookie.
  clock += 20_000;
  const refreshed = await app.get('/');
  assert.equal(refreshed.status, 200);
  assert.equal(
    refreshed.headers.get('set-cookie'),
    `${app.cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
  );
  const extended = app.f.ledger.listConsoleSessions()[0]!;
  assert.equal(Date.parse(extended.expires_at!), clock + THIRTY_DAYS);
  assert.ok(Date.parse(extended.expires_at!) > initialExpiry);

  // Second request within the same 24h window is throttled (no redundant Set-Cookie).
  clock += 60 * 60_000;
  const throttled = await app.get('/api/state');
  assert.equal(throttled.status, 200);
  assert.equal(throttled.headers.get('set-cookie'), null);

  // Advance past the original 30-day mark (day 30.5 from start, still inside the extended 31-day expiry).
  clock = 1_000_000 + THIRTY_DAYS + 12 * 3600_000;
  const stillValid = await app.get('/api/state');
  assert.equal(stillValid.status, 200);
  assert.equal(
    stillValid.headers.get('set-cookie'),
    `${app.cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
  );

  // Another device signing in does NOT prune this active sliding session even past created_at + 30d.
  await app.signIn();
  assert.equal(app.f.ledger.listConsoleSessions().length, 2);

  // Temporary device admission (12h) must NEVER be extended by sliding renewal.
  const f = fixture(t);
  let devClock = 10_000_000;
  const devAuth = createAuth({ ledger: f.ledger, ...TUNING, now: () => devClock });
  const pending = devAuth.createDeviceLogin(false, 'Mozilla/5.0 Chrome/130.0 Windows')!;
  devAuth.decideDeviceLogin(pending.code, true, USER, true);
  const collected = devAuth.deviceLogin(pending.credential, false);
  assert.equal(collected.state, 'approved');
  const tempCookie = collected.cookie.split(';')[0]!;
  const tempInitial = f.ledger.listConsoleSessions()[0]!;

  devClock += 6 * 3600_000;
  const tempSession = devAuth.authenticate(tempCookie)!;
  assert.ok(tempSession);
  assert.equal(devAuth.maybeRefreshSession(tempCookie, tempSession, false), undefined);
  assert.equal(f.ledger.listConsoleSessions()[0]!.expires_at, tempInitial.expires_at);

  devClock += 6 * 3600_000 + 1;
  assert.equal(devAuth.authenticate(tempCookie), undefined, '临时会话到达 12 小时后照常过期');
});

async function passphraseHttpApp(t: TestContext, now: () => number) {
  const f = fixture(t);
  f.ledger.setWhitelist({ console: ['console'] }, USER);
  const settings = serviceSettings({ ledger: f.ledger, dataDir: f.dir, log: () => {} });
  const machines = createMachines({ ledger: f.ledger });
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: Object.entries(ADAPTERS).filter(([, each]) => each.credential).map(([id]) => id),
    routingExecutors: ['claude'],
    dataDir: f.dir,
  });
  const logins = createLogins({ ledger: f.ledger, accounts, executors: ADAPTERS });
  const stream = createStream();
  const accept = createAcceptor({
    ledger: f.ledger,
    runner: { fetchArtifacts: async () => ({ files: [], problem: null }) },
    dataDir: f.dir,
  });
  const tools = createTools({
    ledger: f.ledger,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins,
    machines,
    accept,
  });
  const auth = createAuth({
    ledger: f.ledger,
    dataDir: f.dir,
    linkTtlMs: () => settings.get('login.linkTtlMs'),
    sessionDays: () => settings.get('login.sessionDays'),
    temporarySessionMs: () => settings.get('login.temporarySessionMs'),
    now,
  });
  const http = createHttp({
    ...HTTP_TUNED,
    ledger: f.ledger,
    tools,
    auth,
    session: {
      admitTool: () => ({ refused: 'no turn' }),
      toolTokens: () => [TOOL_TOKEN],
      projectOfToken: () => undefined,
      kick: () => {},
      interrupt: () => false,
      status: () => ({ alive: true, pid: 1, turn: null, turns: [], error: null, restarting: false, waiting: null, launched: null, host_error: null, projects: [] }),
      restart: async () => {},
    },
    stream,
    accounts,
    logins,
    machines,
    nodes: createNodes({
      ...NODES_TUNED,
      ledger: f.ledger,
      pollHoldMs: () => SETTINGS['node.pollHoldMs'].default,
      commandTimeoutMs: () => SETTINGS['node.commandTimeoutMs'].default,
      joinTtlMs: () => SETTINGS['node.joinTtlMs'].default,
      gapSlackMs: () => SETTINGS['node.gapSlackMs'].default,
      log: () => {},
    }),
    roundSnapshot: () => null,
    roundCredential: () => null,
    roundInvite: () => null,
    wecomSecret: { isSet: () => false, set: () => {} },
    knowledgeTokens: knowledgeTokenStore(f.dir),
    inbounds: createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => SETTINGS['triggers.inboundSkewMs'].default, log: () => {} }),
    skillFolder: join(f.dir, 'skills'),
    doctor: async () => [],
    loginUrl: (path) => `http://console.example${path}`,
    publicUrl: () => settings.get('http.publicUrl'),
    now,
    accept,
    backup: { status: () => ({ configured: false }), trigger: () => { throw new Error('unused'); } },
    settings,
    deployment: async () => [],
    consoleDir: CONSOLE_DIST,
    loginToken: LOGIN_TOKEN,
    shutdownToken: SHUTDOWN_TOKEN,
    instance: () => ({}),
    releaseCheck: () => ({ ledger: 'ok', degraded: false, recovering: false, health_window_ms: 0 }),
    drain: async () => ({ drained: true, waited_ms: 0 }),
    releases: {
      dataDir: f.dir,
      version: '0.0.0',
      last: () => null,
      intent: () => null,
      attempting: () => false,
      launch: () => { throw new Error('unused'); },
    },
    onShutdown: () => {},
  });
  const port = await http.listen(0, '127.0.0.1');
  t.after(() => http.close());
  const url = `http://127.0.0.1:${port}`;
  const origin = { Origin: url };
  const linkRes = await fetch(`${url}/api/login-links`, { method: 'POST', headers: { Authorization: `Bearer ${LOGIN_TOKEN}` } });
  const { path } = (await linkRes.json()) as { path: string };
  const exRes = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { ...origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: path.slice('/login#'.length) }),
    redirect: 'manual',
  });
  const cookie = exRes.headers.get('set-cookie')!.split(';')[0]!;
  return { f, url, origin, cookie, browser: { Cookie: cookie, ...origin }, auth };
}

test('owner passphrase lifecycle: configure, scrypt-v1 secret file, login, rate-limit 429, and clear', async (t) => {
  let clock = 5_000_000;
  const app = await passphraseHttpApp(t, () => clock);
  const secretFile = passphraseSecretFile(app.f.dir);

  // Initially disabled.
  const initialStatus = await fetch(`${app.url}/api/auth/passphrase`, { headers: app.browser });
  assert.equal(initialStatus.status, 200);
  assert.deepEqual(await initialStatus.json(), { enabled: false });
  assert.equal(existsSync(secretFile), false);

  const loginPageBefore = await (await fetch(`${app.url}/login`)).text();
  assert.doesNotMatch(loginPageBefore, /id="passphrase-login"/);

  // POST /login/passphrase while disabled returns 404.
  const postDisabled = await fetch(`${app.url}/login/passphrase`, {
    method: 'POST',
    headers: { ...app.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase: 'my secret passphrase' }),
    redirect: 'manual',
  });
  assert.equal(postDisabled.status, 404);

  // Reject too-short and whitespace-only passphrases.
  const tooShort = await fetch(`${app.url}/api/auth/passphrase`, {
    method: 'PUT',
    headers: app.browser,
    body: JSON.stringify({ passphrase: 'short' }),
  });
  assert.equal(tooShort.status, 400);
  const blank = await fetch(`${app.url}/api/auth/passphrase`, {
    method: 'PUT',
    headers: app.browser,
    body: JSON.stringify({ passphrase: '        ' }),
  });
  assert.equal(blank.status, 400);

  // Set a valid passphrase containing spaces.
  const passphrase = 'correct horse battery staple';
  const putRes = await fetch(`${app.url}/api/auth/passphrase`, {
    method: 'PUT',
    headers: app.browser,
    body: JSON.stringify({ passphrase }),
  });
  assert.equal(putRes.status, 200);
  assert.deepEqual(await putRes.json(), { enabled: true });

  const enabledStatus = await fetch(`${app.url}/api/auth/passphrase`, { headers: app.browser });
  assert.deepEqual(await enabledStatus.json(), { enabled: true });

  // Secret file uses scrypt-v1 format and never stores plaintext passphrase on disk.
  const onDisk = readFileSync(secretFile, 'utf8').trim();
  assert.match(onDisk, /^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(onDisk.includes(passphrase), false);

  // /login now renders the passphrase form.
  const loginPageEnabled = await (await fetch(`${app.url}/login`)).text();
  assert.match(loginPageEnabled, /id="passphrase-login"/);
  assert.match(loginPageEnabled, /action="\/login\/passphrase"/);

  // Foreign origin is refused with 403.
  const foreign = await fetch(`${app.url}/login/passphrase`, {
    method: 'POST',
    headers: { Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase }),
    redirect: 'manual',
  });
  assert.equal(foreign.status, 403);

  // Valid passphrase succeeds with 303 + SameSite=Lax cookie and method='passphrase'.
  const okLogin = await fetch(`${app.url}/login/passphrase`, {
    method: 'POST',
    headers: { ...app.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase }),
    redirect: 'manual',
  });
  assert.equal(okLogin.status, 303);
  assert.equal(okLogin.headers.get('location'), '/');
  const issuedCookie = okLogin.headers.get('set-cookie')!;
  assert.match(issuedCookie, /^tycho=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  const stateRes = await fetch(`${app.url}/api/state`, { headers: { Cookie: issuedCookie.split(';')[0]! } });
  assert.equal(stateRes.status, 200);
  assert.ok(app.f.ledger.listConsoleSessions().some((s) => s.method === 'passphrase'));

  // 5 invalid attempts return 401; 6th attempt (even with valid passphrase) is rate-limited with 429.
  for (let i = 0; i < 5; i++) {
    const bad = await fetch(`${app.url}/login/passphrase`, {
      method: 'POST',
      headers: { ...app.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ passphrase: 'wrong passphrase' }),
      redirect: 'manual',
    });
    assert.equal(bad.status, 401, `attempt ${i + 1}`);
    assert.match(await bad.text(), /口令不正确，请重试/);
  }
  const locked = await fetch(`${app.url}/login/passphrase`, {
    method: 'POST',
    headers: { ...app.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase }),
    redirect: 'manual',
  });
  assert.equal(locked.status, 429);
  assert.match(await locked.text(), /尝试次数过多，请稍后再试/);

  // After the 5-minute window expires, valid passphrase works again.
  clock += 5 * 60_000 + 1;
  const unlocked = await fetch(`${app.url}/login/passphrase`, {
    method: 'POST',
    headers: { ...app.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase }),
    redirect: 'manual',
  });
  assert.equal(unlocked.status, 303);

  // DELETE /api/auth/passphrase removes the secret file and disables passphrase login.
  const delRes = await fetch(`${app.url}/api/auth/passphrase`, {
    method: 'DELETE',
    headers: app.browser,
  });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { enabled: false });
  assert.equal(existsSync(secretFile), false);

  const afterClear = await fetch(`${app.url}/login/passphrase`, {
    method: 'POST',
    headers: { ...app.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase }),
    redirect: 'manual',
  });
  assert.equal(afterClear.status, 404);
});

test('loginWithPassphrase runs async scrypt with concurrency cap and bounded passphraseFailures map', async (t) => {
  const f = fixture(t);
  let clock = 10_000_000;
  let inFlight = 0;
  let maxInFlight = 0;
  const gates: (() => void)[] = [];

  const auth = createAuth({
    ledger: f.ledger,
    dataDir: f.dir,
    linkTtlMs: () => 10 * 60_000,
    sessionDays: () => 30,
    temporarySessionMs: () => 60 * 60_000,
    now: () => clock,
    derivePassphrase: async (candidate, salt) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise<void>((resolve) => { gates.push(resolve); });
        return Buffer.alloc(32, candidate === 'wrong' ? 0 : salt.charCodeAt(0));
      } finally {
        inFlight -= 1;
      }
    },
  });
  auth.setPassphrase('valid passphrase 123');

  // Start PASSPHRASE_MAX_CONCURRENT_SCRYPT concurrent attempts; the next one must immediately return busy.
  const pending = Array.from({ length: PASSPHRASE_MAX_CONCURRENT_SCRYPT }, (_, idx) =>
    auth.loginWithPassphrase('wrong', true, 'Mozilla/5.0', `ip-${idx}`),
  );
  const overloaded = await auth.loginWithPassphrase('wrong', true, 'Mozilla/5.0', 'ip-overflow');
  assert.deepEqual(overloaded, { ok: false, reason: 'busy', retryAfterSec: 1 });
  assert.equal(maxInFlight, PASSPHRASE_MAX_CONCURRENT_SCRYPT);

  // Release all pending scrypt tasks and verify they settle as invalid.
  while (gates.length > 0) gates.shift()!();
  const settled = await Promise.all(pending);
  assert.ok(settled.every((res) => !res.ok && res.reason === 'invalid'));

  // Test bounded passphraseFailures map (evicts oldest once PASSPHRASE_MAX_FAILURE_KEYS is reached).
  const fastAuth = createAuth({
    ledger: f.ledger,
    dataDir: f.dir,
    linkTtlMs: () => 10 * 60_000,
    sessionDays: () => 30,
    temporarySessionMs: () => 60 * 60_000,
    now: () => clock,
    derivePassphrase: async () => Buffer.alloc(32, 0),
  });
  // Lock key-0 with 5 failures.
  for (let i = 0; i < 5; i += 1) {
    const res = await fastAuth.loginWithPassphrase('wrong', true, 'UA', 'key-0');
    assert.deepEqual(res, { ok: false, reason: 'invalid' });
  }
  const locked = await fastAuth.loginWithPassphrase('wrong', true, 'UA', 'key-0');
  assert.ok(!locked.ok);
  assert.equal(locked.reason, 'locked');

  // Insert PASSPHRASE_MAX_FAILURE_KEYS distinct newer failing keys so key-0 is evicted as oldest.
  for (let i = 1; i <= PASSPHRASE_MAX_FAILURE_KEYS; i += 1) {
    const res = await fastAuth.loginWithPassphrase('wrong', true, 'UA', `key-${i}`);
    assert.deepEqual(res, { ok: false, reason: 'invalid' });
  }
  // Because key-0 was evicted when the map hit its 1000-entry cap, key-0 is no longer locked (attempts verify again).
  const afterEvict = await fastAuth.loginWithPassphrase('wrong', true, 'UA', 'key-0');
  assert.deepEqual(afterEvict, { ok: false, reason: 'invalid' });
});

test('public PWA manifest and icons are readable anonymously while sw.js and pages stay protected', async (t) => {
  const f = fixture(t);
  const distDir = join(f.dir, 'console-dist');
  mkdirSync(join(distDir, 'icons'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>tycho</title>');
  writeFileSync(join(distDir, 'manifest.webmanifest'), JSON.stringify({ name: 'Tycho', display: 'standalone' }));
  writeFileSync(join(distDir, 'sw.js'), 'self.addEventListener("install", () => {});');
  writeFileSync(join(distDir, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const app = await consoleApp(t, { f, consoleDir: distDir });

  const manifestRes = await app.get('/manifest.webmanifest', {});
  assert.equal(manifestRes.status, 200);
  assert.match(manifestRes.headers.get('content-type') ?? '', /application\/manifest\+json/);
  assert.match(await manifestRes.text(), /"Tycho"/);

  const iconRes = await app.get('/icons/icon-192.png', {});
  assert.equal(iconRes.status, 200);
  assert.equal(iconRes.headers.get('content-type'), 'image/png');

  const missingIconRes = await app.get('/icons/missing.png', {});
  assert.equal(missingIconRes.status, 404);

  // Service worker, root HTML, and non-PNG files under /icons must still require login.
  for (const path of ['/', '/sw.js', '/icons/evil.js']) {
    const res = await app.get(path, {});
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/login');
  }
});
