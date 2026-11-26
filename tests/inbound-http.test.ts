// Guards an inbound source's entrance and keys over HTTP (docs/design/triggers.md §2.2, §7)
// against: the owner's login, this machine's tokens or the Router's tool token standing in for
// the signature, on either listener; the internet reaching any other route without a login, or
// any route newly reachable without one but this; a refusal answered with a status that tells the
// caller to give up when it may retry (a full queue), or retry when it may not; a paused or
// archived project's refusal being 503 and taking no identity, so the same event id is taken
// after it resumes; a key's secret
// shown again after the answer that issued it, written into the page, the Router's tool results or
// the audit trail; the key route open to a browser not signed in; the page not telling apart "no
// gateway", "gateway down" and "can receive"; a signature that is there but not the protocol's
// answered as a missing one; a body that is not text refused, or its bytes changed before they are
// checked; and the Router's tools reaching a source it does not manage.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { GatewayStatus } from '../service/gateway.ts';
import { tychoSignature } from '../service/inbound/tycho-v1.ts';
import { inboundSecretDir } from '../service/inbound.ts';
import { inboundReach, TYCHO_V1_HEADERS } from '../shared/triggers.ts';
import { consoleApp, LOGIN_TOKEN, SHUTDOWN_TOKEN, TOOL_TOKEN } from './console-helpers.ts';
import { DEFAULT_TRIGGER_POLICY } from '../service/triggers.ts';
import { fixture, USER } from './helpers.ts';

const PUBLIC = 'https://tycho.example';
const json = async (response: Response): Promise<any> => response.json();
const now = (): string => String(Math.floor(Date.now() / 1000));

async function setup(t: TestContext, gateway: GatewayStatus['state'] = 'connected', queueMax = DEFAULT_TRIGGER_POLICY.queueMax) {
  let state = gateway;
  const f = fixture(t, { triggerPolicy: () => ({ ...DEFAULT_TRIGGER_POLICY, queueMax }) });
  const app = await consoleApp(t, { f, gateway: () => ({ state, since: null, error: null }) });
  app.settings.set('http.publicUrl', PUBLIC, { actor: 'user' });
  const outPort = await app.http.outside.listen(0);
  const source = (await json(await app.send('POST', '/api/inbound', { name: 'CI', kind: 'tycho-v1', project_ids: [app.f.projectId], note: '看看 {{event_id}}' }))).source;
  const issue = async (): Promise<{ key_id: string; secret: string }> => {
    const answer = await app.post(`/api/inbound/${source.id}/key`, {});
    assert.equal(answer.status, 201);
    return json(answer);
  };
  // A caller's request, signed with `secret` unless headers say otherwise, to either listener.
  const deliver = (secret: string | null, eventId: string, body: string | Uint8Array, options: { outside?: boolean; headers?: Record<string, string>; project?: string } = {}) => {
    const signedAt = now();
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    const project = options.project ?? '';
    const signed = secret === null ? {} : {
      [TYCHO_V1_HEADERS.event]: eventId,
      [TYCHO_V1_HEADERS.time]: signedAt,
      [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, signedAt, eventId, project, bytes),
      ...(options.project === undefined ? {} : { [TYCHO_V1_HEADERS.project]: project }),
    };
    const base = options.outside ? `http://127.0.0.1:${outPort}` : app.url;
    return fetch(`${base}/inbound/${source.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signed, ...options.headers }, body: bytes });
  };
  const fires = () => app.f.ledger.listTriggerFires({ sourceId: source.id, limit: 50 });
  return { app, outPort, source, issue, deliver, fires, setGateway: (next: GatewayStatus['state']) => { state = next; } };
}

test('a signed request is accepted on either listener, without any login', async (t) => {
  const { app, issue, deliver, fires } = await setup(t);
  const { secret } = await issue();
  const kicks = app.state.kicks;
  const inside = await deliver(secret, 'in-1', '{"ok":false}');
  assert.equal(inside.status, 200);
  const receipt = (await json(inside)).receipts[0];
  assert.deepEqual([receipt.status, receipt.duplicate], ['accepted', false]);
  assert.equal(receipt.outcome, 'delivered');
  const outside = await deliver(secret, 'out-1', '{"ok":true}', { outside: true });
  assert.equal(outside.status, 200);
  assert.equal(fires().length, 2);
  assert.ok(app.state.kicks > kicks, '收下了就叫负责人来取');
  // The same event again is answered with the same receipt.
  const again = (await json(await deliver(secret, 'in-1', '{"ok":false}'))).receipts[0];
  assert.deepEqual([again.fire_id, again.duplicate], [receipt.fire_id, true]);
});

test('neither the owner\'s login nor any token of this machine or the Router stands in for the signature', async (t) => {
  const { app, outPort, issue, deliver, fires } = await setup(t);
  await issue();
  const outCookie = await (async () => {
    const credential = new URL(await app.newLink(), app.url).hash.slice(1);
    assert.match(credential, /^[0-9a-f]{64}$/);
    const response = await fetch(`http://127.0.0.1:${outPort}/login`, {
      method: 'POST', headers: { Origin: PUBLIC, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential }), redirect: 'manual',
    });
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  })();
  const stand_ins: Record<string, string>[] = [
    app.browser,
    ...[TOOL_TOKEN, LOGIN_TOKEN, SHUTDOWN_TOKEN].map((token) => ({ Authorization: `Bearer ${token}` })),
    { ...app.browser, Authorization: `Bearer ${TOOL_TOKEN}` },
  ];
  for (const headers of stand_ins) {
    const bare = await deliver(null, 'e', '{}', { headers });
    assert.equal(bare.status, 400, JSON.stringify(headers));
    assert.equal((await json(bare)).reason, 'unsigned');
    const forged = await deliver(null, 'e', '{}', { headers: { ...headers, [TYCHO_V1_HEADERS.event]: 'e', [TYCHO_V1_HEADERS.time]: now(), [TYCHO_V1_HEADERS.signature]: 'f'.repeat(64) } });
    assert.equal(forged.status, 401);
    assert.equal((await json(forged)).reason, 'signature');
  }
  // From outside, with the session made there.
  const outside = await deliver(null, 'e', '{}', { outside: true, headers: { Cookie: outCookie, Origin: PUBLIC } });
  assert.equal(outside.status, 400);
  assert.equal(fires().length, 0);
});

test('outside, only the inbound delivery and receipt entrances use signature authentication', async (t) => {
  const { app } = await setup(t);
  const open = app.http.routes.filter((route) => route.outside && route.auth !== 'login');
  assert.deepEqual(open.filter(({ path }) => /inbound/.test(path)).map(({ method, path, auth }) => `${method} ${path} ${auth}`), [
    'POST /inbound/:id([0-9A-Z]{26}) signature',
    'GET /inbound/:id([0-9A-Z]{26})/result/:receipt([0-9A-Z]{26}) signature',
  ]);
  assert.equal(open.filter(({ auth }) => auth === 'signature').length, 2);
  // Every other way in without a login is what it was: the login pages and a machine's own.
  assert.deepEqual([...new Set(open.filter(({ auth }) => auth !== 'signature').map(({ auth }) => auth))].sort(), ['anonymous', 'node']);
  // The owner's own source management needs the login, outside as inside.
  for (const { method, path } of app.http.routes.filter((route) => route.outside && /\/api\/inbound/.test(route.path))) {
    assert.equal(app.http.routes.find((route) => route.method === method && route.path === path)!.auth, 'login', `${method} ${path}`);
  }
});

test('a receipt reads only the original source event while the source still has access', async (t) => {
  const { app, outPort, source, issue, deliver } = await setup(t);
  const { secret } = await issue();
  const { fire_id, message_id } = (await json(await deliver(secret, 'original', '{}'))).receipts[0];
  const path = (sourceId: string, receipt: string) => '/inbound/' + sourceId + '/result/' + receipt;
  const base = 'http://127.0.0.1:' + outPort;
  const read = (sourceId: string, receipt: string, key: string, options: { at?: string; signPath?: string } = {}) => {
    const signedAt = options.at ?? now();
    const resource = path(sourceId, receipt);
    const signature = createHmac('sha256', key).update(['tycho-result-v1', 'GET', options.signPath ?? resource, signedAt, ''].join('\n')).digest('hex');
    return fetch(base + resource, { headers: { [TYCHO_V1_HEADERS.time]: signedAt, [TYCHO_V1_HEADERS.signature]: signature } });
  };
  assert.equal((await fetch(base + path(source.id, fire_id), { headers: app.browser })).status, 404);
  assert.equal((await read(source.id, fire_id, secret, { at: '0' })).status, 404);
  const other = (await json(await app.post('/api/inbound', {
    name: '另一个来源', kind: 'tycho-v1', project_ids: [app.f.projectId],
  }))).source;
  const otherKey = (await json(await app.post('/api/inbound/' + other.id + '/key', {}))).secret;
  assert.equal((await read(other.id, fire_id, otherKey)).status, 404);
  assert.equal((await read(other.id, fire_id, secret, { signPath: path(source.id, fire_id) })).status, 404);
  const pending = await read(source.id, fire_id, secret);
  assert.equal(pending.status, 200);
  assert.equal(pending.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await json(pending), { fire_id, project_id: app.f.projectId, outcome: 'delivered', state: 'received' });

  app.f.ledger.takeNextTurn(app.f.projectId);
  app.f.ledger.writeOutbound({ channel: 'trigger', text: '项目私有正文', final: true, replyTo: message_id });
  app.f.ledger.finishMessage(message_id, 'processed');
  assert.deepEqual(await json(await read(source.id, fire_id, secret)), {
    fire_id, project_id: app.f.projectId, outcome: 'delivered', state: 'processed',
  });
  app.state.current = message_id;
  const model = { Authorization: 'Bearer ' + TOOL_TOKEN };
  const publish = (text: string) => app.post('/tools/call', {
    name: 'reply_to_inbound_source', arguments: { text },
  }, model).then(json);
  assert.equal((await publish('来源未授权，拒绝')).isError, true);
  assert.equal((await app.send('PUT', '/api/inbound/' + source.id, { result_reply: true })).status, 200);
  assert.equal((await publish('现有回执权限不追溯')).isError, true);
  const next = (await json(await deliver(secret, 'next', '{}'))).receipts[0];
  app.state.current = next.message_id;
  app.f.ledger.takeNextTurn(app.f.projectId);
  const publicReply = '你的验证已经开始 Authorization: Bearer synthetic-receipt-secret';
  assert.equal((await publish(publicReply)).isError, undefined);
  assert.equal((await publish(publicReply)).isError, undefined);
  assert.equal((await publish('意外覆盖')).isError, true);
  assert.deepEqual(await json(await read(source.id, next.fire_id, secret)), {
    fire_id: next.fire_id, project_id: app.f.projectId, outcome: 'delivered', state: 'processing', reply: '你的验证已经开始 Authorization: Bearer [已隐去的密钥]',
  });
  assert.equal((await app.send('PUT', '/api/inbound/' + source.id, { result_reply: false })).status, 200);
  assert.equal((await json(await read(source.id, next.fire_id, secret))).reply, undefined);
  const ownerView = await json(await app.send('GET', '/api/inbound'));
  assert.equal(ownerView.recent.find(({ id }: { id: string }) => id === next.fire_id)?.public_reply, '你的验证已经开始 Authorization: Bearer [已隐去的密钥]');
  assert.equal(app.f.ledger.listTriggerFires({ sourceId: source.id, limit: 10 }).find(({ id }) => id === next.fire_id)?.public_reply, undefined);
  assert.equal((await read(source.id, 'Z'.repeat(26), secret, { signPath: path(source.id, fire_id) })).status, 404);
  assert.equal((await read(source.id, 'Z'.repeat(26), secret)).status, 404);
  const outsideTrace = await fetch(base + '/api/messages/' + message_id + '/trajectory', {
    headers: { [TYCHO_V1_HEADERS.time]: now(), [TYCHO_V1_HEADERS.signature]: 'f'.repeat(64) },
  });
  assert.equal(outsideTrace.status, 401);
  const replacement = app.f.ledger.createProject({ name: '替代项目' }, USER);
  app.f.ledger.updateInboundSource(source.id, { project_ids: [replacement] }, USER);
  assert.equal((await read(source.id, fire_id, secret)).status, 404);
  app.f.ledger.updateInboundSource(source.id, { project_ids: [replacement, app.f.projectId] }, USER);
  app.f.ledger.setInboundEnabled(source.id, false, USER);
  assert.equal((await read(source.id, fire_id, secret)).status, 404);
});

test('refusals tell the caller whether to retry: a full queue is 429, a conflict 409, an unknown source nothing at all', async (t) => {
  const { app, issue, deliver, source } = await setup(t, 'connected', 1);
  const { secret } = await issue();
  assert.equal((await deliver(secret, 'a', '{"n":1}')).status, 200);
  const full = await deliver(secret, 'b', '{"n":2}');
  assert.equal(full.status, 429);
  assert.equal((await json(full)).reason, 'queue_full');
  const conflict = await deliver(secret, 'a', '{"n":3}');
  assert.equal(conflict.status, 409);
  const unknown = await fetch(`${app.url}/inbound/${'Z'.repeat(26)}`, { method: 'POST', body: '{}' });
  assert.deepEqual([unknown.status, (await json(unknown)).error], [404, '没有这个接口']);
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const stale = await fetch(`${app.url}/inbound/${source.id}`, {
    method: 'POST', body: '{}',
    headers: { [TYCHO_V1_HEADERS.event]: 'c', [TYCHO_V1_HEADERS.time]: old, [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, old, 'c', '', Buffer.from('{}')) },
  });
  assert.deepEqual([stale.status, (await json(stale)).reason], [401, 'stale']);
});

test('a paused project refuses a signed event as 503, and takes the same event after it resumes', async (t) => {
  const { app, issue, deliver } = await setup(t);
  const { secret } = await issue();
  app.f.ledger.setProjectPaused(app.f.projectId, true, USER);
  const paused = await deliver(secret, 'paused-1', '{}');
  assert.deepEqual([paused.status, (await json(paused)).reason], [503, 'project_paused']);
  app.f.ledger.setProjectPaused(app.f.projectId, false, USER);
  // A refusal takes no identity: the caller retries the same event id and is accepted.
  assert.equal((await deliver(secret, 'paused-1', '{}')).status, 200);
});

// An archived project is a "later", as a paused one is (project-sessions, "项目的生命周期").
test('an archived project refuses a signed event as 503, and takes the same event after the restore', async (t) => {
  const { app, issue, deliver, fires } = await setup(t);
  const { secret } = await issue();
  app.f.ledger.setProjectArchived(app.f.projectId, true, USER);
  const archived = await deliver(secret, 'archived-1', '{}');
  assert.deepEqual([archived.status, (await json(archived)).reason], [503, 'project_archived']);
  assert.equal(fires().length, 0);
  app.f.ledger.setProjectArchived(app.f.projectId, false, USER);
  assert.equal((await deliver(secret, 'archived-1', '{}')).status, 200);
  assert.equal(fires().length, 1);
});

test('a project header naming nothing the source lets through is 422; a signature missing is 400; one malformed or not verifying is 401; bytes that are not text are taken as they are', async (t) => {
  const { app, issue, source, fires } = await setup(t);
  const { secret } = await issue();
  const signedAt = now();
  const post = (body: Uint8Array, headers: Record<string, string>) => fetch(`${app.url}/inbound/${source.id}`, { method: 'POST', body, headers });
  const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x80]);
  assert.equal((await post(bytes, { [TYCHO_V1_HEADERS.event]: 'bin-1', [TYCHO_V1_HEADERS.time]: signedAt })).status, 400);
  for (const malformed of ['x', 'A'.repeat(64)]) {
    const answer = await post(bytes, { [TYCHO_V1_HEADERS.event]: 'bin-1', [TYCHO_V1_HEADERS.time]: signedAt, [TYCHO_V1_HEADERS.signature]: malformed });
    assert.deepEqual([answer.status, (await json(answer)).reason], [401, 'signature'], malformed);
  }
  const elsewhere = await post(bytes, {
    [TYCHO_V1_HEADERS.event]: 'bin-2', [TYCHO_V1_HEADERS.time]: signedAt, [TYCHO_V1_HEADERS.project]: 'not-a-project',
    [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, signedAt, 'bin-2', 'not-a-project', bytes),
  });
  assert.deepEqual([elsewhere.status, (await json(elsewhere)).reason], [422, 'no_project']);
  const taken = await post(bytes, {
    [TYCHO_V1_HEADERS.event]: 'bin-1', [TYCHO_V1_HEADERS.time]: signedAt,
    [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, signedAt, 'bin-1', '', bytes),
  });
  assert.equal(taken.status, 200);
  assert.deepEqual(fires()[0]!.data, { event_id: 'bin-1', project_id: app.f.projectId, body_base64: Buffer.from(bytes).toString('base64') });
});

test('a source made without a key is reached by nothing; its key is shown once, and replacing it keeps the old one for a while', async (t) => {
  const { app, source, issue, deliver } = await setup(t);
  assert.equal((await deliver('whatever', 'e', '{}')).status, 404, '没领密钥，外面投不进来');
  const first = await issue();
  const page = await json(await app.get('/api/inbound'));
  const listed = page.sources.find((each: { id: string }) => each.id === source.id);
  assert.deepEqual([listed.ready, listed.path, listed.keys.length], [true, `/inbound/${source.id}`, 1]);
  const second = await issue();
  assert.notEqual(first.secret, second.secret);
  const after = await app.get('/api/inbound');
  const text = await after.text();
  for (const secret of [first.secret, second.secret]) assert.ok(!text.includes(secret), '页面里没有密钥');
  const keys = JSON.parse(text).sources.find((each: { id: string }) => each.id === source.id).keys;
  assert.equal(keys.length, 2);
  assert.ok(keys[0].retires_at, '旧密钥写着什么时候作废');
  assert.equal((await deliver(first.secret, 'old', '{}')).status, 200, '过渡期内旧密钥还能用');
  assert.equal((await deliver(second.secret, 'new', '{}')).status, 200);
  const audit = JSON.stringify(app.f.peek('SELECT * FROM change'));
  for (const secret of [first.secret, second.secret]) assert.ok(!audit.includes(secret), '审计里没有密钥');
  // Not to a browser that is not signed in, inside or out.
  assert.equal((await fetch(`${app.url}/api/inbound/${source.id}/key`, { method: 'POST' })).status, 401);
});

test('the page says whether the internet can reach the sources: no gateway, gateway down, or can receive', async (t) => {
  const { app, setGateway } = await setup(t, 'off');
  const reach = async () => (await json(await app.get('/api/inbound'))).reach;
  const none = await reach();
  assert.deepEqual([none.reach, none.public_url], ['no_gateway', PUBLIC]);
  assert.match(none.reach_text, /没配置门牌/);
  setGateway('down');
  assert.equal((await reach()).reach, 'gateway_down');
  setGateway('connecting');
  assert.equal((await reach()).reach, 'gateway_down');
  setGateway('connected');
  assert.deepEqual([(await reach()).reach, (await reach()).reach_text], ['ready', '可以接收']);
});

test('reverse-proxy mode reports ready on /api/inbound when reverseProxy listener and publicUrl are active, even with gateway off', async (t) => {
  assert.equal(inboundReach('off', { reverseProxyPort: 8800, publicUrl: PUBLIC }), 'ready');
  assert.equal(inboundReach('off', { reverseProxyPort: 8800, publicUrl: '' }), 'no_gateway');
  assert.equal(inboundReach('off', { reverseProxyPort: 0, publicUrl: PUBLIC }), 'no_gateway');

  const { app } = await setup(t, 'off');
  const reach = async () => (await json(await app.get('/api/inbound'))).reach;
  assert.equal((await reach()).reach, 'no_gateway');

  await app.http.reverseProxy.listen(0);
  const ready = await reach();
  assert.deepEqual([ready.reach, ready.reach_text, ready.public_url], ['ready', '可以接收', PUBLIC]);

  // Without a publicUrl, reverse-proxy alone cannot give external callers an address.
  app.settings.reset('http.publicUrl', USER);
  assert.deepEqual([(await reach()).reach, (await reach()).public_url], ['no_gateway', null]);

  app.settings.set('http.publicUrl', PUBLIC, USER);
  assert.equal((await reach()).reach, 'ready');

  await app.http.reverseProxy.close();
  assert.equal((await reach()).reach, 'no_gateway');
});

test('the Router cannot make or see an inbound source: only its own rules are its tools\' business', async (t) => {
  const { app, issue, source } = await setup(t);
  const { id } = app.f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'console', text: 'CI 失败就告诉我', projectId: app.f.projectId });
  app.state.current = id;
  const call = async (name: string, args: unknown): Promise<string> =>
    (await json(await app.post('/tools/call', { name, arguments: args }, { Authorization: `Bearer ${TOOL_TOKEN}` }))).content[0].text;
  const refused = await json(await app.post('/tools/call', { name: 'create_trigger', arguments: { name: '构建失败', instruction: '看', source: 'email' } }, { Authorization: `Bearer ${TOOL_TOKEN}` }));
  assert.match(refused.content[0].text, /只能是 schedule、event/);
  const { secret } = await issue();
  const listed = await call('list_triggers', {});
  assert.ok(!listed.includes(secret));
  assert.ok(!listed.includes(source.id), '工具结果里没有入站来源');
  assert.ok(!/inbound|source_id/.test(listed));
});

test('an unauthenticated inbound caller sees no secret path or storage error when reading a key fails', async (t) => {
  const { app, issue, deliver, fires } = await setup(t);
  const { key_id: keyId } = await issue();
  const file = join(inboundSecretDir(app.f.dir), keyId);
  rmSync(file);
  mkdirSync(file);
  for (const outside of [false, true]) {
    const response = await deliver(null, 'no-signature', '{}', { outside });
    assert.equal(response.status, 500);
    const answer = await json(response);
    assert.deepEqual(answer, { error: '入站请求处理失败，请稍后重试' });
    for (const internal of [app.f.dir, keyId, 'EISDIR', 'read']) {
      assert.ok(!JSON.stringify(answer).includes(internal), internal);
    }
  }
  assert.equal(fires().length, 0);
});

test('an inbound body over the transport limit is refused before signature processing', async (t) => {
  const { app, source, issue, deliver, fires } = await setup(t);
  await issue();
  const bytes = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
  for (const outside of [false, true]) {
    const response = await deliver(null, 'large', bytes, { outside });
    assert.equal(response.status, 413);
    assert.deepEqual(await json(response), { error: '请求体过大' });
  }
  assert.equal(fires().length, 0);
  assert.equal(app.f.ledger.getInboundSource(source.id)!.rejected, null);
});
