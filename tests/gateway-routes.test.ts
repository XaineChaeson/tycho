// Guards against the internet reaching, once a gateway is connected, what only this
// machine may use: a route of the inside listener answering on the outside one (the
// Router's tools, making login links, stopping the service, saying who the service is,
// the self-check by the token in service.json); a route added later being reachable from
// outside without anyone having decided so; an answer that gives away that such a route
// exists; a session made over plain HTTP opening the service from the internet, or the
// other way round; a cookie from outside without Secure; a write taken from another site,
// or with no public address to compare with; failed exchange replies going on without
// limit, or that limit blocking a valid credential, another source, or the inside
// listener; a login credential leaking through Referer; and pages missing outside.
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { consoleApp, LOGIN_TOKEN, SHUTDOWN_TOKEN, TOOL_TOKEN } from './console-helpers.ts';
import { USER } from './helpers.ts';

const PUBLIC = 'https://tycho.example';
const TOKENS = [TOOL_TOKEN, LOGIN_TOKEN, SHUTDOWN_TOKEN];
const NO_ROUTE = '没有这个接口';
const MINUTE = 60_000;

type Options = NonNullable<Parameters<typeof consoleApp>[1]>;

// The HTTP surface with both listeners up, and a browser signed in through each: `app`
// is the inside one as every other test has it, `out` what the gateway would reach.
async function setup(t: TestContext, options: Options = {}, publicUrl = PUBLIC) {
  const app = await consoleApp(t, options);
  if (publicUrl) app.settings.set('http.publicUrl', publicUrl, USER);
  const port = await app.http.outside.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const origin = { Origin: PUBLIC };
  const ask = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Response> =>
    fetch(`${url}${path}`, { method, headers, redirect: 'manual', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const exchange = (link: string, headers: Record<string, string> = origin): Promise<Response> => {
    assert.match(link, /^\/login#[0-9a-f]{64}$/);
    return fetch(url + '/login', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: new URL(link, url).hash.slice(1) }), redirect: 'manual' });
  };
  const signIn = async (headers: Record<string, string> = origin): Promise<string> => {
    const response = await exchange(await app.newLink(), headers);
    assert.equal(response.status, 303, '从对外入口登录');
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };
  return { app, out: { url, port, origin, ask, exchange, signIn } };
}

// What tells one answer from another: the status, where it sends the browser, the body.
const told = async (response: Response): Promise<[number, string | null, string]> =>
  [response.status, response.headers.get('location'), await response.text()];

const SAMPLE: Record<string, string> = { link: 'a'.repeat(64), key: 'run.timeoutMs', action: 'resume', part: 'events' };
const concrete = (path: string): string => path.replace(/:(\w+)(\([^)]*\))?/g, (_part, name: string) => SAMPLE[name] ?? 'x');

test('what serves this machine alone is not there on the outside listener, with a token or without', async (t) => {
  const { app, out } = await setup(t);
  const cookie = await out.signIn();
  const { id } = app.f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'console', text: '在处理' });
  app.state.current = id;
  const projects = app.f.ledger.listProjects().length;
  const call = { name: 'create_project', arguments: { name: '从外面建的', accounts: [] } };

  for (const [method, path] of [['POST', '/tools/list'], ['POST', '/tools/call'], ['POST', '/api/login-links'], ['POST', '/api/shutdown'], ['GET', '/api/instance']] as const) {
    const body = method === 'POST' ? call : undefined;
    for (const token of TOKENS) {
      const bearer = { Authorization: `Bearer ${token}` };
      const signed = await out.ask(method, path, { ...bearer, ...out.origin, Cookie: cookie }, body);
      assert.equal(signed.status, 404, `${method} ${path}`);
      assert.equal(((await signed.json()) as { error: string }).error, NO_ROUTE);
      // To someone not signed in it is what any path nobody serves is: nothing in the
      // answer says that this one exists.
      assert.deepEqual(await told(await out.ask(method, path, bearer, body)), await told(await out.ask(method, `${path}-nowhere`, bearer, body)), `${method} ${path}`);
    }
  }
  assert.equal(app.state.shutdowns, 0, '从外面停不了服务');
  assert.equal(app.f.ledger.listProjects().length, projects, '从外面调不了负责人的工具');

  // The same requests are served where they belong.
  assert.equal((await app.post('/tools/list', {}, { Authorization: `Bearer ${TOOL_TOKEN}` })).status, 200);
  assert.equal((await app.get('/api/instance', { Authorization: `Bearer ${SHUTDOWN_TOKEN}` })).status, 200);
});

test('the token in service.json opens the self-check on the inside listener only; outside it takes a login', async (t) => {
  const { app, out } = await setup(t, { doctor: async () => [{ id: 'node', level: 'ok', title: 'Node 版本', text: 'ok', fix: null }] });
  const bearer = { Authorization: `Bearer ${SHUTDOWN_TOKEN}` };
  assert.equal((await app.get('/api/doctor', bearer)).status, 200);
  const refused = await out.ask('GET', '/api/doctor', bearer);
  assert.equal(refused.status, 401);
  assert.equal(((await refused.json()) as { error: string }).error, '需要登录');
  const signed = await out.ask('GET', '/api/doctor', { Cookie: await out.signIn() });
  assert.equal(signed.status, 200);
  assert.equal(((await signed.json()) as { checks: unknown[] }).checks.length, 1);
});

test('no route reaches the outside listener unless it is marked for it: every row of the table is tried', async (t) => {
  const { app, out } = await setup(t);
  const cookie = await out.signIn();
  const unmarked = app.http.routes.filter((route) => !route.outside);
  assert.ok(unmarked.length >= 6 && app.http.routes.length > unmarked.length, '路由表读不出来');
  for (const { method, path } of unmarked) {
    // The self-check has a row for browsers too, which is the one that answers out there.
    const alsoOutside = app.http.routes.some((other) => other.outside && other.method === method && other.path === path);
    for (const token of TOKENS) {
      const bearer = { Authorization: `Bearer ${token}` };
      const bare = await out.ask(method, concrete(path), bearer);
      if (alsoOutside) {
        assert.equal(bare.status, 401, `${method} ${path}：令牌在对外入口不算数`);
        continue;
      }
      assert.deepEqual(await told(bare), await told(await out.ask(method, `${concrete(path)}-nowhere`, bearer)), `${method} ${path}`);
      const signed = await out.ask(method, concrete(path), { ...bearer, ...out.origin, Cookie: cookie });
      assert.deepEqual([signed.status, ((await signed.json()) as { error: string }).error], [404, NO_ROUTE], `${method} ${path}`);
    }
  }
  assert.equal(app.state.shutdowns, 0);
});

test('what the internet can reach is this list: a route joins it by a decision, not by being added', async (t) => {
  const { app } = await setup(t);
  assert.deepEqual(app.http.routes.filter((route) => route.outside).map(({ method, path }) => `${method} ${path}`).sort(), [
    'GET /login',
    'POST /login/device',
    'GET /login/device',
    'POST /login/passphrase',
    // The one entry that lets a device or a machine in by its six digits.
    'POST /api/admissions/lookup',
    'POST /api/admissions/approve',
    'POST /api/admissions/reject',
    'POST /login',
    'GET /api/auth/passphrase',
    'PUT /api/auth/passphrase',
    'DELETE /api/auth/passphrase',
    'GET /api/github',
    'POST /api/github/pat',
    'POST /api/github/device/start',
    'POST /api/github/device/poll',
    'POST /api/github/check',
    'DELETE /api/github',
    'GET /api/messages',
    'POST /api/messages',
    'GET /api/messages/:id/changes',
    'GET /api/messages/:id/trajectory',
    'GET /api/stream',
    'GET /api/state',
    'GET /api/summary',
    'GET /api/overview',
    'GET /api/tasks',
    'GET /api/tasks/ended',
    'GET /api/tasks/:id',
    'GET /api/tasks/:id/diff',
    'GET /api/tasks/:id/facts',
    'GET /api/tasks/:id/feedback',
    'POST /api/tasks/:id/feedback',
    'PATCH /api/tasks/:id/inputs/:inputId',
    'DELETE /api/tasks/:id/inputs/:inputId',
    'POST /api/tasks/:id/rollback',
    'POST /api/tasks/:id/:action(resume|abandon|accept|rework|continue|interrupt|inputs|review|hold|integrate)',
  // Asking again for a Task's artifacts, after a machine was out of reach at the acceptance.
    'POST /api/tasks/:id/artifacts',
    'POST /api/tasks/:id/deliverables',
    'GET /api/runs/:id/:part(events|snapshot|trace)',
    'GET /api/runs/:id/diagnostics',
    // The owner reads a declared report before deciding whether to accept it.
    'GET /api/runs/:id/report',
    'GET /api/approvals',
    'POST /api/approvals/:id/answer',
    'POST /api/interrupt',
    // What waits for a project, and giving it one (docs/design/project-sessions.md §2).
    'GET /api/messages/unassigned',
    'POST /api/messages/assign',
    'POST /api/logout',
    'GET /api/console-sessions',
    'POST /api/console-sessions/revoke-others',
    'POST /api/console-sessions/:id/revoke',
    'POST /api/pause',
    'POST /api/restore/confirm',
    'POST /api/backup',
    'POST /api/outbox/:id/retry',
    'POST /api/outbox/confirm-all',
    'POST /api/outbox/:id/confirm',
    'POST /api/outbox/:id/force-resend',
    'GET /api/replay/cases',
    'GET /api/replay/runs/:id/draft',
    'POST /api/replay/run',
    'GET /api/settings',
    'PUT /api/settings/:key([\\w.]+)',
    'DELETE /api/settings/:key([\\w.]+)',
    'PUT /api/wecom/secret',
    'POST /api/wecom/reconnect',
    'GET /api/weixin',
    'POST /api/weixin/login',
    'POST /api/weixin/pin',
    'DELETE /api/weixin',
    'POST /api/router/restart',
    'POST /api/releases/:run/launch',
    'GET /api/doctor',
    'GET /api/accounts',
    'POST /api/accounts',
    'POST /api/account-lines/models',
    // What the executors used, and asking a login's quota again (docs/design/usage.md §4).
    'GET /api/usage',
    'GET /api/usage/competence',
    'GET /api/quota',
    'POST /api/quota/refresh',
    'GET /api/project-directory',
    'GET /api/project-directory/feed',
    'GET /api/projects',
    // Making a project, and its conversation (project-sessions §5, §1).
    'POST /api/projects',
    'GET /api/projects/:id/conversation',
    'GET /api/projects/:id/files',
    'POST /api/projects/:id/files',
    'GET /api/projects/:id/files/:fileId/raw',
    'GET /api/projects/:id/files/:fileId/preview',
    'DELETE /api/projects/:id/files/:fileId',
    'GET /api/projects/:id/history-evidence',
    'POST /api/projects/:id/new-topic',
    'POST /api/projects/:id/side-ask',
    // The owner's pause and archive of one project (project-sessions §5, "项目的生命周期").
    'POST /api/projects/:id/pause',
    'POST /api/projects/:id/archive',
    // Deleting a project that never left a record behind (project-sessions, "项目的生命周期").
    'DELETE /api/projects/:id',
    // A project's triggers: the owner's own management of them (docs/design/triggers.md §7).
    'GET /api/projects/:id/triggers',
    'POST /api/projects/:id/triggers',
    'GET /api/projects/:id/groups',
    'GET /api/im/groups',
    'POST /api/im/groups',
    'PUT /api/im/groups/:id',
    'DELETE /api/im/groups/:id',
    'PUT /api/triggers/:id',
    'POST /api/triggers/:id/enabled',
    'DELETE /api/triggers/:id',
    // Inbound sources (§2.2, step 4): tycho-wide, managed by the owner from one page.
    'GET /api/inbound',
    'POST /api/inbound',
    'PUT /api/inbound/:id',
    'POST /api/inbound/:id/enabled',
    'DELETE /api/inbound/:id',
    'POST /api/inbound/:id/key',
    // An inbound source's entrance: the one route the internet reaches without a login, and only
    // by a signature made with a key of that source (§2.2).
    'POST /inbound/:id([0-9A-Z]{26})',
    'GET /inbound/:id([0-9A-Z]{26})/result/:receipt([0-9A-Z]{26})',
    'PUT /api/projects/:id',
    'PUT /api/accounts/:id/credential',
    'DELETE /api/invites/:id',

    'GET /api/machines',
    'PUT /api/machines/:id',
    'DELETE /api/machines/:id',
    'GET /api/machines/:uid/dirs',
    'POST /api/machines/:uid/dirs',
    'PUT /api/machines/:uid/dirs',
    // A machine's own login: what tycho adds to it, and its rest ended by hand.
    'PUT /api/machines/:uid/logins/:executor',
    'PUT /api/logins/:id',
    'DELETE /api/logins/:id',
    'POST /api/logins/:id/retry',
    'POST /api/machines/:id/check',
    'PUT /api/accounts/:id',
    'DELETE /api/accounts/:id',
    'POST /api/accounts/:id/check',
    'POST /api/accounts/:id/retry',
    // Signing in to a Claude account (native-login.md §二): the owner does it from a phone too.
    'POST /api/claude-logins',
    'GET /api/claude-logins/:id',
    'POST /api/claude-logins/:id/code',
    'POST /api/claude-logins/:id/save',
    'POST /api/claude-logins/:id/cancel',
    // Signing in to a centralized Codex account via Host device-auth: from a phone too.
    'POST /api/codex-logins',
    'GET /api/codex-logins/:id',
    'POST /api/codex-logins/:id/save',
    'POST /api/codex-logins/:id/cancel',
    // Signing a machine in to one of its executors (native-login.md): from a phone too.
    'POST /api/sign-ins',
    'GET /api/sign-ins/:id',
    'POST /api/sign-ins/:id/code',
    'POST /api/sign-ins/:id/cancel',
    // Roles, and a Task's role and tier (roles-and-tiers.md §3): the console's own editing,
    // which the signed-in owner does through the gateway like any other.
    'GET /api/roles',
    'PUT /api/roles/:id',
    'DELETE /api/roles/:id',
    'PUT /api/tasks/:id/role',
    // Knowledge (knowledge-and-skills.md §3): reading, proposing and deciding are the owner's
    // own console, wherever it is opened. The knowledge MCP is not here: on this machine it is
    // the inside listener's, and a machine elsewhere reaches it through its node channel.
    'GET /api/knowledge',
    'GET /api/knowledge/effective',
    'POST /api/knowledge/entry/repair',
    'PUT /api/knowledge/registry/:slug',
    'PUT /api/knowledge/entries/:id/machines',
    'POST /api/knowledge/proposals/review-all',
    'GET /api/knowledge/proposals/:id',
    'POST /api/knowledge/proposals',
    'POST /api/knowledge/proposals/:id/:action(decide|amend|review)',
    'GET /api/knowledge/entries/:id',
    'POST /api/knowledge/entries/:id/retire',
    'POST /api/knowledge/clients',
    'GET /api/knowledge/clients/:id/token',
    'POST /api/knowledge/clients/:id/revoke',
    // The machines that come back by themselves (nodes.md §5.3, §8.2): reachable from the
    // internet, because that is the point — a machine has no way in of its own.
    'POST /api/node/join',
    'POST /api/node/poll',
    'POST /api/node/status',
    'POST /api/node/report',
    'GET /api/node/runs/:id/snapshot',
    'POST /api/node/runs/:id/credential',
    'POST /api/node/leave',
    'POST /api/node/knowledge/mcp',
    // The two frozen routes a client uses to follow the host's version (nodes.md §1.4.1):
    // they must be reachable before the client's protocol matches, so they are node-token
    // routes on the outside listener like the rest of /api/node.
    'POST /api/node/release',
    'GET /api/node/release/package',
    'GET /api/node/skills/:slug',
    // What the owner sees of them from the console.
    'GET /api/node/joins',
    // Desktop thin-shell release metadata & allowlisted binary downloads (anonymous, same-origin verified).
    'GET /api/desktop/latest',
    'GET /api/desktop/download/:name',
    // Logical-account priority slots, aliases, batch login updates, themes, and fleet CLI updaters.
    'PUT /api/dispatch/slots',
    'PUT /api/logins/alias',
    'PUT /api/logins/batch',
    'GET /api/themes',
    'POST /api/themes',
    'DELETE /api/themes/:id',
    'GET /api/locales',
    'GET /api/locales/template',
    'GET /api/locales/:id',
    'POST /api/locales',
    'DELETE /api/locales/:id',
    'GET /api/executors/updates',
    'POST /api/executors/updates/check',
    'POST /api/executors/updates/run',
    'PUT /api/executors/updates/policy',
  ].sort());
});

test('the pages, the login page and what the pages read are served outside, to a browser signed in there', async (t) => {
  const { app, out } = await setup(t);
  const anonymous = await out.ask('GET', '/');
  assert.deepEqual([anonymous.status, anonymous.headers.get('location')], [302, '/login']);
  assert.equal((await out.ask('GET', '/login')).status, 200);
  assert.equal((await out.ask('GET', '/api/state')).status, 401);

  const signed = { Cookie: await out.signIn() };
  const page = await out.ask('GET', '/', signed);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /text\/html/);
  for (const path of ['/assets/index-0a1b2c3d.js', '/assets/index-0a1b2c3d.css', '/api/state', '/api/overview', '/api/messages', '/api/tasks?top=1', '/api/settings', '/api/accounts', '/api/machines']) {
    assert.equal((await out.ask('GET', path, signed)).status, 200, path);
  }
  const stream = await out.ask('GET', '/api/stream', signed);
  assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  await stream.body!.cancel();

  // And it can act: a message sent from outside is in the ledger like any other.
  const sent = await out.ask('POST', '/api/messages', { ...signed, ...out.origin }, { text: '从手机发的' });
  assert.equal(sent.status, 201);
  assert.equal(app.f.ledger.listMessages({ limit: 10 }).at(-1)?.text, '从手机发的');
  assert.equal(app.state.kicks, 1);
});

test('a cookie from outside is Secure and one from inside is not; neither session works on the other listener', async (t) => {
  const { app, out } = await setup(t);
  const made = await out.exchange(await app.newLink());
  assert.match(made.headers.get('set-cookie')!, /^tycho=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=2592000$/);
  const inside = await app.exchange(await app.newLink());
  assert.match(inside.headers.get('set-cookie')!, /^tycho=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  const fromOutside = made.headers.get('set-cookie')!.split(';')[0]!;
  const fromInside = inside.headers.get('set-cookie')!.split(';')[0]!;

  // Each on its own listener.
  assert.equal((await out.ask('GET', '/api/state', { Cookie: fromOutside })).status, 200);
  assert.equal((await app.get('/api/state', { Cookie: fromInside })).status, 200);
  // And not on the other: read, write, page or stream.
  assert.equal((await out.ask('GET', '/api/state', { Cookie: fromInside })).status, 401, '对内的会话带到对外不被接受');
  assert.equal((await out.ask('POST', '/api/messages', { Cookie: fromInside, ...out.origin }, { text: '混进来' })).status, 401);
  assert.equal((await out.ask('GET', '/', { Cookie: fromInside })).status, 302);
  assert.equal((await out.ask('GET', '/api/stream', { Cookie: fromInside })).status, 401);
  assert.equal((await app.get('/api/state', { Cookie: fromOutside })).status, 401, '对外的会话带到对内也不被接受');
  assert.equal((await app.post('/api/messages', { text: '混进来' }, { Cookie: fromOutside, ...app.origin })).status, 401);
  assert.equal(app.f.ledger.listMessages({ limit: 10 }).some(({ text }) => text === '混进来'), false);
  // Being shown at the wrong listener ends neither.
  assert.equal((await out.ask('GET', '/api/state', { Cookie: fromOutside })).status, 200);
  assert.equal((await app.get('/api/state', { Cookie: fromInside })).status, 200);

  // The ledger says which is which, and still holds nothing that works as a cookie.
  const marks = app.f.ledger.listConsoleSessions().map(({ outside }) => outside === true);
  assert.deepEqual(marks.sort(), [false, false, true], '登录时那一个、这里对内的一个、对外的一个');
  assert.equal(JSON.stringify(app.f.dump()).includes(fromOutside.slice('tycho='.length)), false);

  // Signing out clears the cookie the way it was set, and the session is gone.
  const left = await out.ask('POST', '/api/logout', { Cookie: fromOutside, ...out.origin });
  assert.equal(left.headers.get('set-cookie'), 'tycho=; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=0');
  assert.equal((await out.ask('GET', '/api/state', { Cookie: fromOutside })).status, 401);
  assert.equal((await app.get('/api/state', { Cookie: fromInside })).status, 200, '对内的那一个不受影响');
});

test('a stream opened outside ends when its session does, and not when one from inside signs out', async (t) => {
  const { app, out } = await setup(t, { keepaliveMs: 20 });
  const cookie = await out.signIn();
  const stream = await out.ask('GET', '/api/stream', { Cookie: cookie });
  const reader = stream.body!.getReader();
  await reader.read();
  await app.post('/api/logout');
  // Still open: a keepalive arrives.
  assert.equal((await reader.read()).done, false);
  await out.ask('POST', '/api/logout', { Cookie: cookie, ...out.origin });
  let done = false;
  for (let reads = 0; reads < 5 && !done; reads += 1) done = (await reader.read()).done;
  assert.equal(done, true);
});

test('outside, a write has to come from the public address: no other origin will do', async (t) => {
  const { app, out } = await setup(t);
  const cookie = { Cookie: await out.signIn() };
  const send = (headers: Record<string, string>): Promise<Response> => out.ask('POST', '/api/messages', { ...cookie, ...headers }, { text: '写' });
  assert.equal((await send(out.origin)).status, 201);
  for (const headers of [
    {},
    { Origin: 'https://evil.example' },
    // What the inside listener takes: the listener's own address, and the browser's word.
    { Origin: out.url },
    { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' },
    { 'Sec-Fetch-Site': 'same-origin' },
    { Origin: 'http://tycho.example' },
    { Origin: `${PUBLIC}:8443` },
  ] as Record<string, string>[]) {
    const refused = await send(headers);
    assert.equal(refused.status, 403, JSON.stringify(headers));
  }
  assert.equal(app.f.ledger.listMessages({ limit: 10 }).length, 1);
  // The exchange is a write too.
  const link = await app.newLink();
  assert.equal((await out.exchange(link, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await out.exchange(link)).status, 303, '被拒的兑换不消耗链接');
  // The inside listener goes on as before.
  assert.equal((await app.post('/api/messages', { text: '对内' })).status, 201);
});

test('with no public address set, nothing is written from outside and nobody signs in there', async (t) => {
  const { app, out } = await setup(t);
  const cookie = { Cookie: await out.signIn() };
  app.settings.set('http.publicUrl', '', USER);
  const refused = await out.ask('POST', '/api/messages', { ...cookie, ...out.origin }, { text: '写' });
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { error: string }).error, /还没有填对外地址/);
  for (const headers of [{ Origin: out.url }, { 'Sec-Fetch-Site': 'same-origin' }, {}] as Record<string, string>[]) {
    assert.equal((await out.ask('PUT', '/api/settings/run.maxLostContinuations', { ...cookie, ...headers }, { value: 5 })).status, 403);
  }
  const link = await app.newLink();
  assert.equal((await out.exchange(link)).status, 403);
  assert.equal(app.f.ledger.listMessages({ limit: 10 }).length, 0);
  assert.equal(app.settings.get('run.maxLostContinuations'), 3);
  // Reading goes on, and so does everything on the inside listener.
  assert.equal((await out.ask('GET', '/api/state', cookie)).status, 200);
  assert.equal((await app.post('/api/messages', { text: '对内' })).status, 201);
  assert.equal((await app.exchange(link)).status, 303);
});

test('failed POST quota never blocks a live link, and opening dead links never spends it', async (t) => {
  let clock = 1_000_000;
  const { app, out } = await setup(t, { now: () => clock });
  const cookie = { Cookie: await out.signIn() };
  const from = (address: string): Record<string, string> => ({ ...out.origin, 'X-Forwarded-For': address });
  const dead = '/login#' + '0'.repeat(64);
  for (let n = 0; n < 15; n += 1) assert.equal((await out.ask('GET', dead, from('203.0.113.7'))).status, 200);
  for (let n = 0; n < 10; n += 1) {
    // Trusted reverse proxy appends the real client IP at the rightmost position;
    // spoofed leftmost entries supplied by the caller must be ignored.
    assert.equal((await out.exchange(dead, from('10.0.0.1, 203.0.113.7'))).status, 410, '第 ' + (n + 1) + ' 次 POST');
    clock += 1000;
  }
  const good = await app.newLink();
  assert.equal((await out.exchange(dead, from('203.0.113.7'))).status, 429, '第 11 次失败');
  assert.equal((await out.ask('GET', dead, from('203.0.113.7'))).status, 200, 'GET 预览不带凭据，也不限速');
  assert.equal((await out.ask('GET', good, from('203.0.113.7'))).status, 200, '好链接随时能打开');
  const accepted = await out.exchange(good, from('203.0.113.7'));
  assert.equal(accepted.status, 303, '失败额度用完仍能登录');
  assert.ok(accepted.headers.get('set-cookie'));
  assert.equal((await out.exchange(good, from('203.0.113.7'))).status, 429, '用过的链接现在只报超限');
  assert.equal((await out.ask('GET', '/api/state', { ...cookie, ...from('203.0.113.7') })).status, 200);
  assert.equal((await out.ask('POST', '/api/messages', { ...cookie, ...from('203.0.113.7') }, { text: '照常' })).status, 201);
  assert.equal((await out.exchange(dead, from('198.51.100.9'))).status, 410, '另一个来源不受影响');
  clock += 50_000;
  assert.equal((await out.exchange(dead, from('203.0.113.7'))).status, 410, '最早一次已过一分钟');
  assert.equal((await out.exchange(dead, from('203.0.113.7'))).status, 429, '又满了十次');
  clock += MINUTE;
  assert.equal((await out.exchange(dead, from('203.0.113.7'))).status, 410);
});

test('exchanges that succeed are not counted, and the inside listener is never limited', async (t) => {
  const { app, out } = await setup(t, { now: () => 1_000_000 });
  for (let n = 0; n < 15; n += 1) assert.equal((await out.exchange(await app.newLink(), { ...out.origin, 'X-Forwarded-For': '203.0.113.7' })).status, 303);
  for (let n = 0; n < 15; n += 1) assert.equal((await app.exchange(`/login#${'0'.repeat(64)}`)).status, 410);
  assert.equal((await app.exchange(await app.newLink())).status, 303);
});

test('without a forwarded address everything from outside is one source; and sixty failures in a minute suppress only failed exchanges for everyone', async (t) => {
  let clock = 1_000_000;
  const { app, out } = await setup(t, { now: () => clock });
  const dead = `/login#${'0'.repeat(64)}`;
  for (let n = 0; n < 10; n += 1) assert.equal((await out.exchange(dead)).status, 410);
  assert.equal((await out.exchange(dead)).status, 429, '没有来源地址的都算在一起');
  assert.equal((await out.exchange(dead, { ...out.origin, 'X-Forwarded-For': '192.0.2.1' })).status, 410, '带来源地址的另算');

  // 11 so far. Five more sources at nine each stay under their own limit and reach sixty.
  for (let source = 2; source <= 6; source += 1) {
    for (let n = 0; n < 9; n += 1) {
      assert.equal((await out.exchange(dead, { ...out.origin, 'X-Forwarded-For': `192.0.2.${source}` })).status, 410);
    }
  }
  for (let n = 0; n < 4; n += 1) assert.equal((await out.exchange(dead, { ...out.origin, 'X-Forwarded-For': '192.0.2.7' })).status, 410);
  const fresh = { ...out.origin, 'X-Forwarded-For': '192.0.2.99' };
  assert.equal((await out.exchange(dead, fresh)).status, 429, '全局满六十次，没失败过的来源也被挡');
  const good = await app.newLink();
  assert.equal((await out.ask('GET', good, fresh)).status, 200);
  assert.equal((await out.exchange(good, fresh)).status, 303, '全局失败额度也不能挡住好链接');
  assert.equal((await app.exchange(await app.newLink())).status, 303, '对内照常');

  clock += MINUTE;
  assert.equal((await out.exchange(await app.newLink(), fresh)).status, 303, '一分钟后恢复');
  assert.equal((await out.exchange(dead)).status, 410);
});

test('the state the pages read says how the gateway stands', async (t) => {
  const { app } = await setup(t);
  assert.deepEqual(((await (await app.get('/api/state')).json()) as { gateway: unknown }).gateway, { state: 'off', since: null, error: null });
  const down = { state: 'down' as const, since: '2026-11-06T01:02:03.000Z', error: 'ssh: connect to host door.example port 22: Connection refused' };
  const { app: other } = await setup(t, { gateway: () => down });
  assert.deepEqual(((await (await other.get('/api/state')).json()) as { gateway: unknown }).gateway, down);
});

test('the outside listener answers on this machine alone, and says so when its port is taken', async (t) => {
  const { app, out } = await setup(t);
  await assert.rejects(app.http.outside.listen(app.port), /对外入口的端口 \d+ 被别的程序占着/);
  // The failed attempt took the old listener down with it; a new one comes up as asked.
  await assert.rejects(fetch(`${out.url}/login`));
  const port = await app.http.outside.listen(0);
  assert.equal((await fetch(`http://127.0.0.1:${port}/login`)).status, 200);
  // Only the loopback answers: nothing reaches it from another machine but through the gateway.
  const address = Object.values(networkInterfaces()).flat().find((each) => each?.family === 'IPv4' && !each.internal)?.address;
  if (address) await assert.rejects(fetch(`http://${address}:${port}/login`), '对外入口只绑 127.0.0.1');
  await app.http.outside.close();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/login`));
  assert.equal((await app.get('/api/state')).status, 200, '对内的不受影响');
});

// The preview has no bearer in its request URI; strict-origin retains the form's Origin.
test('login pages use strict-origin and their form still exchanges with the public Origin', async (t) => {
  const { app, out } = await setup(t);
  const link = await app.newLink();
  for (const path of ['/login', link, '/login/' + '0'.repeat(64)]) {
    const response = await out.ask('GET', path);
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin', path);
    if (path === link) {
      const html = await response.text();
      assert.match(html, /method="post" action="\/login"/);
      assert.match(html, /type="hidden" name="credential"/);
      assert.equal(response.headers.get('set-cookie'), null, 'preview must not issue a session');
    }
  }
  const response = await out.exchange(link, { Origin: PUBLIC, Referer: PUBLIC + '/' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin');
  assert.match(response.headers.get('set-cookie')!, /Secure/);
});

test('forwardedFrom uses rightmost X-Forwarded-For (ignoring spoofed X-Real-IP), and outside passphrase login shares loginLimit', async (t) => {
  let clock = 2_000_000;
  const { app, out } = await setup(t, { now: () => clock });
  const dead = `/login#${'0'.repeat(64)}`;

  // Spoofing different leftmost XFF addresses cannot bypass rate limiting when the rightmost proxy-appended IP is the same.
  for (let n = 0; n < 10; n += 1) {
    const res = await out.exchange(dead, { ...out.origin, 'X-Forwarded-For': `198.51.100.${n + 1}, 203.0.113.42` });
    assert.equal(res.status, 410, `spoofed attempt ${n + 1}`);
  }
  assert.equal(
    (await out.exchange(dead, { ...out.origin, 'X-Forwarded-For': '198.51.100.250, 203.0.113.42' })).status,
    429,
    'rotating leftmost XFF still hits the rightmost IP quota',
  );
  // Spoofing X-Real-IP cannot escape the rightmost X-Forwarded-For bucket (nginx only overwrites X-Forwarded-For).
  assert.equal(
    (await out.exchange(dead, { ...out.origin, 'X-Real-IP': '198.51.100.251', 'X-Forwarded-For': '203.0.113.42' })).status,
    429,
    'spoofed X-Real-IP must not bypass rightmost X-Forwarded-For rate limit',
  );

  // Configure passphrase on the service and verify POST /login/passphrase is gated by loginLimit on the outside listener.
  const passphrase = 'correct horse battery staple';
  const putRes = await app.send('PUT', '/api/auth/passphrase', { passphrase });
  assert.equal(putRes.status, 200);

  const postPassphrase = (bodyPassphrase: string, headers: Record<string, string>) =>
    fetch(`${out.url}/login/passphrase`, {
      method: 'POST',
      headers: { ...out.origin, ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ passphrase: bodyPassphrase }),
      redirect: 'manual',
    });

  // 203.0.113.42 already exhausted loginLimit via failed link exchanges -> blocked with 429 BEFORE passphrase verification even with valid passphrase!
  const blockedBeforeVerify = await postPassphrase(passphrase, { 'X-Forwarded-For': '1.2.3.4, 203.0.113.42' });
  assert.equal(blockedBeforeVerify.status, 429);

  // Failed passphrase attempts from a fresh outside source charge loginLimit (shared with link exchanges).
  const attackerHeaders = { 'X-Forwarded-For': '1.1.1.1, 203.0.113.77' };
  for (let n = 0; n < 5; n += 1) {
    const bad = await postPassphrase('wrong passphrase', { 'X-Forwarded-For': `1.1.1.${n + 1}, 203.0.113.77` });
    assert.equal(bad.status, 401);
  }
  // 5 failures already charged to loginLimit for 203.0.113.77; 5 more dead link exchanges reach 10, so the 6th dead link hits 429.
  for (let n = 0; n < 5; n += 1) {
    assert.equal((await out.exchange(dead, { ...out.origin, ...attackerHeaders })).status, 410);
  }
  assert.equal((await out.exchange(dead, { ...out.origin, ...attackerHeaders })).status, 429);
});
