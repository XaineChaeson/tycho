// Guards against URL-borne login secrets, JSON pretending to be a form, approved requests
// lost by resume, premature consumption on failed writes, and old secret routes surviving.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { consoleSession, type Running } from '../cli/service-client.ts';
import { consoleApp, LOGIN_TOKEN } from './console-helpers.ts';
import { USER } from './helpers.ts';
import { fixture } from './helpers.ts';

const PUBLIC = 'https://tycho.example';
const pending = (response: Response): string => {
  const cookie = response.headers.getSetCookie().find(line => /Path=\/login\/device(?:;|$)/.test(line));
  assert.ok(cookie, 'creation must deliver a pending credential cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/i);
  return cookie.split(';')[0]!;
};

test('issued fragment is previewed without consumption and exchanged only by same-origin form body', async t => {
  const app = await consoleApp(t);
  const link = await app.newLink();
  assert.match(link, /^\/login#[0-9a-f]{64}$/);
  const credential = new URL(link, app.url).hash.slice(1);
  const page = await app.get('/login', {});
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /method="post" action="\/login"/);
  assert.match(html, /type="hidden" name="credential"/);
  assert.match(html, /hashchange/);
  assert.match(html, /<noscript>/);
  assert.match(html, /action="\/login\/device"/);
  const send = (origin: string) => fetch(app.url + '/login', { method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential }) });
  assert.equal((await send('https://elsewhere.example')).status, 403);
  assert.equal((await app.get('/login', {})).status, 200);
  assert.equal((await send(app.url)).status, 303);
  assert.equal((await send(app.url)).status, 410);
});

test('CLI obtains a real current-host link and exchanges it for an authenticated public API read', async t => {
  const app = await consoleApp(t);
  writeFileSync(join(app.f.dir, 'login-token'), LOGIN_TOKEN);
  const running: Running = { state: 'running', pid: process.pid, port: app.port, token: '', version: '0.1.785',
    programDir: process.cwd(), dataDir: app.f.dir, startedAt: new Date().toISOString() };
  const result = await consoleSession(app.f.dir, running);
  assert.ok('cookie' in result, JSON.stringify(result));
  assert.equal((await app.get('/api/state', { Cookie: result.cookie })).status, 200);
});

for (const legacy of [false, true]) test(`CLI wire exchange sends ${legacy ? 'legacy empty-body POST' : 'real urlencoded form body'}`, async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'login-token'), LOGIN_TOKEN);
  const credential = 'b'.repeat(64);
  const path = legacy ? '/login/' + credential : '/login#' + credential;
  const seen: { method: string; url: string; contentType: string | undefined; body: string; origin: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const bytes of request) body += bytes.toString();
    if (request.url === '/api/login-links') { response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ path, external: false })); return; }
    seen.push({ method: request.method!, url: request.url!, contentType: request.headers['content-type'], body, origin: request.headers.origin });
    if (request.method === 'GET') { response.writeHead(200); response.end('<html>enter</html>'); return; }
    const valid = legacy ? request.url === path && body === '' : request.url === '/login'
      && request.headers['content-type'] === 'application/x-www-form-urlencoded'
      && body === 'credential=' + credential;
    response.writeHead(valid ? 303 : 400, valid ? { 'Set-Cookie': 'tycho=wire-session; HttpOnly', Location: '/' } : {});
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const result = await consoleSession(f.dir, { state: 'running', pid: process.pid, port, token: '', version: legacy ? '0.1.765' : '0.1.785',
    programDir: process.cwd(), dataDir: f.dir, startedAt: new Date().toISOString() });
  assert.deepEqual(result, { cookie: 'tycho=wire-session' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.origin, `http://127.0.0.1:${port}`);
  assert.equal(seen[0]!.url, legacy ? path : '/login');
  assert.equal(seen[1]!.body, legacy ? '' : 'credential=' + credential);
});

for (const outside of [false, true]) test(`device reuse keeps pending and approved requests without consuming (${outside ? 'outside' : 'inside'})`, async t => {
  const app = await consoleApp(t);
  app.settings.set('http.publicUrl', PUBLIC, USER);
  const base = outside ? `http://127.0.0.1:${await app.http.outside.listen(0)}` : app.url;
  const origin = outside ? PUBLIC : app.url;
  const create = (cookie = '') => fetch(base + '/login/device', { method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie, 'User-Agent': 'initial browser' } });
  const first = await create();
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), '/login/device');
  const cookie = pending(first);
  assert.equal(/; Secure(?:;|$)/.test(first.headers.getSetCookie()[0]!), outside);
  const wait = () => fetch(base + '/login/device', { headers: { Cookie: cookie }, redirect: 'manual' });
  const page = await wait();
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<meta http-equiv="refresh"/);
  assert.doesNotMatch(html, /<script|onload|onclick/i);
  const code = /<h1>(\d{6})<\/h1>/.exec(html)![1]!;
  assert.equal(pending(await create(cookie)), cookie);
  assert.equal((await app.get('/api/state', { Cookie: cookie })).status, 401);
  await app.post('/api/admissions/approve', { kind: 'device', code });
  const before = app.f.ledger.listConsoleSessions().length;
  const resumed = await create(cookie);
  assert.equal(pending(resumed), cookie, 'approved but uncollected request must survive create');
  assert.equal(app.f.ledger.listConsoleSessions().length, before, 'create must not issue a session');
  const wrongBase = outside ? app.url : `http://127.0.0.1:${await app.http.outside.listen(0)}`;
  const wrong = await fetch(wrongBase + '/login/device', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(wrong.status, 410);
  assert.ok(wrong.headers.getSetCookie().every(line => !/^tycho=[0-9a-f]/.test(line)));
  const finished = await wait();
  assert.equal(finished.status, 303);
  assert.equal(finished.headers.get('location'), '/');
  assert.ok(finished.headers.getSetCookie().some(line => /^tycho=[0-9a-f]{64};/.test(line)));
  assert.ok(finished.headers.getSetCookie().some(line => /Path=\/login\/device/.test(line) && /Max-Age=0/.test(line)));
  assert.equal((await wait()).status, 410);
});

test('device session write failure followed by create preserves the original approved credential for retry', async t => {
  const app = await consoleApp(t);
  const create = (cookie = '') => fetch(app.url + '/login/device', { method: 'POST', redirect: 'manual', headers: { ...app.origin, Cookie: cookie } });
  const first = await create();
  const cookie = pending(first);
  const wait = () => fetch(app.url + '/login/device', { headers: { Cookie: cookie }, redirect: 'manual' });
  const html = await (await wait()).text();
  const code = /<h1>(\d{6})<\/h1>/.exec(html)![1]!;
  await app.post('/api/admissions/approve', { kind: 'device', code });
  app.f.force("CREATE TRIGGER refuse_transport_session BEFORE INSERT ON setting BEGIN SELECT RAISE(ABORT, 'session-write-failed'); END");
  const failed = await wait();
  assert.ok(failed.status >= 500);
  assert.equal(failed.headers.get('set-cookie'), null);
  const resumed = await create(cookie);
  assert.equal(resumed.status, 303);
  assert.equal(pending(resumed), cookie);
  app.f.force('DROP TRIGGER refuse_transport_session');
  app.f.ledger.recover();
  const retried = await wait();
  assert.equal(retried.status, 303);
  assert.ok(retried.headers.getSetCookie().some(line => /^tycho=[0-9a-f]{64};/.test(line)));
  assert.equal((await wait()).status, 410);
});

test('new host rejects both former secret path families without redirects or sessions', async t => {
  const app = await consoleApp(t);
  const issued = await app.newLink();
  const secret = issued.match(/[0-9a-f]{64}$/)![0];
  const created = await fetch(app.url + '/login/device', { method: 'POST', redirect: 'manual', headers: app.origin });
  const deviceCredential = pending(created).split('=')[1]!;
  for (const path of ['/login/' + secret, '/login/device/' + deviceCredential]) {
    const response = await app.get(path, {});
    assert.ok(response.status >= 400, `secret URL must be rejected: ${response.status}`);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    const html = await response.text();
    assert.match(html, /重新获取/);
    assert.match(html, /action="\/login\/device"/);
    const refused = await fetch(app.url + path, { method: 'POST', redirect: 'manual', headers: app.origin });
    assert.ok(refused.status >= 400);
    assert.equal(refused.headers.get('set-cookie'), null);
    assert.equal(refused.headers.get('location'), null);
  }
  assert.equal((await app.exchange(issued)).status, 303, 'old URL rejection must not consume the new-form bearer');
});

for (const variant of ['json', 'duplicate', 'extra'] as const) test(`rejected ${variant} login body leaves the live bearer usable`, async t => {
  const app = await consoleApp(t);
  const credential = new URL(await app.newLink(), app.url).hash.slice(1);
  const form = new URLSearchParams({ credential });
  if (variant === 'duplicate') form.append('credential', credential);
  if (variant === 'extra') form.append('next', '/');
  const response = await fetch(app.url + '/login', { method: 'POST', redirect: 'manual',
    headers: { ...app.origin, 'Content-Type': variant === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: variant === 'json' ? JSON.stringify({ credential }) : form });
  assert.equal(response.status, variant === 'json' ? 415 : 400);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.ok(!(await response.text()).includes(credential), 'refusal must not echo the credential');
  const accepted = await fetch(app.url + '/login', { method: 'POST', redirect: 'manual',
    headers: { ...app.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential }) });
  assert.equal(accepted.status, 303, 'rejection must not consume the link');
  const cookie = accepted.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await app.get('/api/state', { Cookie: cookie })).status, 200);
  assert.equal((await app.exchange('/login#' + credential)).status, 410, 'the later successful exchange still consumes once');
});
