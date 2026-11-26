// Guards against wrong HTTP requests/models, missing quota windows or probe usage,
// invented figures, lost error types, unbounded/duplicate reads and leaked tokens.
import './guard.ts';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import type { Account } from '../runner/snapshot.ts';
import { createQuotaReads, type QuotaReadOptions } from '../service/quota-read.ts';
import { quotaUsedUp } from '../shared/labels.ts';
import { fixture, USER } from './helpers.ts';

const TOKEN = 'SECRET-TOKEN';
const BODY = { model: 'available-model', usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 4 } };
const HEADERS = { 'anthropic-ratelimit-unified-7d-utilization': '0.78', 'anthropic-ratelimit-unified-7d-reset': '4102444800' };

async function setup(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void, extra: Partial<QuotaReadOptions> = {}) {
  const f = fixture(t);
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => err ? reject(err) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const account: Account = { id: 'acct', name: 'acct', executor: 'claude', tiers: {} };
  f.ledger.putAccount(account, USER, 'ref');
  f.ledger.noteModels(account.id, [{ id: 'available-model' }], new Date().toISOString());
  const logs: string[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const reads = createQuotaReads({
    ledger: f.ledger, adapters: ADAPTERS, token: () => TOKEN,
    timeoutMs: () => 2_000, staleMs: () => 60_000, log: (line) => logs.push(line),
    fetch: (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, init);
    },
    ...extra,
  });
  t.after(() => reads.stop());
  return { f, reads, account, logs, requests };
}

for (const alias of ['7d_oi', 'seven-day-overage-included']) test(`Claude HTTP Fable alias ${alias} is normalized without changing other windows`, async (t) => {
  const { f, reads, account } = await setup(t, (_req, res) => {
    res.writeHead(200, { ...HEADERS, [`anthropic-ratelimit-unified-${alias}-utilization`]: '0.45' });
    res.end(JSON.stringify(BODY));
  });
  assert.deepEqual(await reads.read(account), { ok: true });
  assert.deepEqual(f.ledger.loginState(account.id).usage.map(({ window, used }) => [window, used]).sort(), [['seven_day', 0.78], ['seven_day_fable', 0.45]]);
});

for (const fiveHour of [false, true]) test(`HTTP quota headers and probe usage (${fiveHour ? 'both windows' : '7d only'})`, async (t) => {
  let wire: { url?: string; headers?: IncomingMessage['headers']; body?: unknown } = {};
  const { f, reads, account, requests } = await setup(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    wire = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    assert.equal(req.method, 'POST');
    res.writeHead(200, { ...HEADERS, ...(fiveHour ? { 'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': '4102444800' } : {}) });
    res.end(JSON.stringify(BODY));
  });
  const one = reads.read(account);
  assert.equal(reads.state(account.id).reading, true);
  assert.equal(reads.read(account), one);
  assert.deepEqual(await one, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(wire.url, '/v1/messages');
  assert.equal(wire.headers!.authorization, `Bearer ${TOKEN}`);
  assert.equal(wire.headers!['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(wire.headers!['anthropic-version'], '2023-06-01');
  assert.equal(wire.headers!['content-type'], 'application/json');
  assert.deepEqual(wire.body, { model: 'available-model', max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: '1' }] });
  assert.deepEqual(f.ledger.loginState(account.id).usage.map(({ window, used, resets_at }) => [window, used, resets_at]).sort(),
    [...(fiveHour ? [['five_hour', 0.42, '2100-01-01T00:00:00.000Z']] : []), ['seven_day', 0.78, '2100-01-01T00:00:00.000Z']]);
  const report = f.ledger.usageReport({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z', tzOffsetMinutes: 0 });
  assert.equal(report.units[0]!.source, 'quota');
  assert.deepEqual(report.usage.map(({ model, input, output, cache_read, cache_write }) => [model, input, output, cache_read, cache_write]), [['available-model', 3, 1, 2, 4]]);
});

test('missing or invalid headers preserve old figures but still record spent tokens', async (t) => {
  let settled = 0;
  const { f, reads, account } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'anthropic-ratelimit-unified-5h-utilization': '', 'anthropic-ratelimit-unified-7d-utilization': 'NaN' });
    res.end(JSON.stringify(BODY));
  }, { onSettled: () => { settled++; } });
  f.ledger.noteUsage(account.id, [{ window: 'five_hour', used: 0.3, resetsAt: '2999-01-01T00:00:00.000Z' }]);
  assert.match((await reads.read(account) as { reason: string }).reason, /没有报额度/);
  assert.equal(f.ledger.loginState(account.id).usage[0]!.used, 0.3);
  assert.equal(f.count('usage'), 1);
  assert.equal(settled, 1);
});

for (const status of [401, 403, 500]) test(`HTTP ${status} keeps error type and scrubs token everywhere`, async (t) => {
  const { f, reads, account, logs, requests } = await setup(t, (_req, res) => {
    res.writeHead(status);
    res.end(JSON.stringify({ error: { type: 'original_error_type', message: `rejected ${TOKEN}` } }));
  });
  reads.readStale([account]);
  const result = await reads.read(account);
  assert.equal(result.ok, false);
  assert.match(reads.state(account.id).failure!, new RegExp(`HTTP ${status}.*original_error_type`));
  assert.equal(f.ledger.loginState(account.id).usage.length, 0);
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify([result, reads.state(account.id), logs, f.peek('SELECT * FROM change'), f.ledger.loginState(account.id)]).includes(TOKEN));
  reads.readStale([account]);
  assert.equal(requests.length, 1, '刚问失败的账号也不立即重试');
});

test('401 记在被拒的那份凭据上：停读、换一份后恢复，迟到的 401 不能拒绝替换', async (t) => {
  const { f, reads, account, requests } = await setup(t, (_req, res) => {
    res.writeHead(401);
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: `revoked ${TOKEN}` } }));
  });
  assert.equal(f.ledger.accountCredentialRef(account.id), 'ref');
  assert.equal((await reads.read(account)).ok, false);
  assert.equal(f.ledger.loginState(account.id).credential_rejected_ref, 'ref', '被拒的是这次用的那个编号');
  assert.equal(reads.refusal(account), '需要重新登录');
  reads.readStale([account]);
  assert.equal(requests.length, 1, '被拒的凭据不再自动重读');
  // The owner stores another token: the mark names the old number, so this one is a candidate.
  f.ledger.noteIdentity(account.id, { organizationId: 'old-organization' });
  f.ledger.noteUsage(account.id, [{ window: 'seven_day', used: 1, resetsAt: null }]);
  f.ledger.recordAccountCredential(account.id, 'ref2', USER);
  assert.equal(f.ledger.accountCredentialRef(account.id), 'ref2');
  assert.deepEqual(f.ledger.loginState(account.id).identity, {});
  assert.deepEqual(f.ledger.loginState(account.id).usage, []);
  f.ledger.noteUsage(account.id, [{ window: 'seven_day', used: 1, resetsAt: null }], 'ref');
  assert.deepEqual(f.ledger.loginState(account.id).usage, [], '旧凭据的迟到读数不会写给新凭据');
  assert.equal(reads.refusal(account), undefined, '换了凭据就不再是被拒的那个');
  const resumed = await reads.read(account);
  assert.equal(resumed.ok, false, '这一份也回 401，但记的是它自己的编号');
  assert.equal(requests.length, 2, '换过之后会再读一次');
  assert.equal(f.ledger.loginState(account.id).credential_rejected_ref, 'ref2');
});

test('late 401 cannot reject a replacement', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { f, reads, account } = await setup(t, async (_req, res) => {
    await gate;
    res.writeHead(401);
    res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'revoked' } }));
  });
  const pending = reads.read(account);
  // The owner replaces the token while the request is still on the wire.
  f.ledger.recordAccountCredential(account.id, 'ref2', USER);
  release();
  assert.equal((await pending).ok, false);
  assert.equal(f.ledger.loginState(account.id).credential_rejected_ref, null, '迟到的 401 拒绝不了替换后的凭据');
  assert.equal(reads.refusal(account), undefined);
});

test('额度查询需要先发现模型时，模型接口的 401 也会标记这份凭据', async (t) => {
  const { f, reads, account, requests } = await setup(t, () => assert.fail('未取得模型就不发额度请求'), {
    refreshModels: async () => ({ ok: false, reason: 'HTTP 401', status: 401 }),
  });
  f.ledger.noteModels(account.id, [], new Date().toISOString());
  assert.equal((await reads.read(account)).ok, false);
  assert.equal(requests.length, 0);
  assert.equal(f.ledger.loginState(account.id).credential_rejected_ref, 'ref');
});

test('429 with usable windows is a successful read: figures kept, spent tokens recorded', async (t) => {
  const full = { 'anthropic-ratelimit-unified-7d-utilization': '1', 'anthropic-ratelimit-unified-7d-reset': '4102444800', 'anthropic-ratelimit-unified-5h-utilization': '1', 'anthropic-ratelimit-unified-5h-reset': '4102444800' };
  const { f, reads, account } = await setup(t, (_req, res) => { res.writeHead(429, full); res.end(JSON.stringify(BODY)); });
  assert.deepEqual(await reads.read(account), { ok: true });
  assert.equal(reads.state(account.id).failure, null, '429 带着窗口不是失败');
  assert.equal(reads.state(account.id).limited, null);
  const held = f.ledger.loginState(account.id).usage;
  assert.deepEqual(held.map(({ window, used }) => [window, used]).sort(), [['five_hour', 1], ['seven_day', 1]]);
  assert.equal(quotaUsedUp(held), true, '一般窗口用满了：页面可以说“额度已用完”');
  assert.equal(f.count('usage'), 1, '这一问花掉的 token 照记');
});

test('429 with no windows is a neutral limited read with a bounded Retry-After pause', async (t) => {
  let clock = Date.now();
  let calls = 0;
  const { reads, account, requests, logs } = await setup(t, (_req, res) => {
    calls++;
    res.writeHead(429, { 'retry-after': '120' });
    res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: TOKEN } }));
  }, { now: () => clock });
  const result = await reads.read(account);
  assert.equal(result.ok, false);
  assert.equal((result as { limited?: boolean }).limited, true);
  assert.match((result as { reason: string }).reason, /限制了这次读取/);
  assert.ok(!JSON.stringify([result, reads.state(account.id), logs]).includes(TOKEN), '不泄露令牌');
  const state = reads.state(account.id);
  assert.equal(state.failure, null, '不是红色的失败');
  assert.match(state.limited!, /限制了这次读取/);
  assert.equal(Date.parse(state.retry_at!), clock + 120_000, 'Retry-After 定住重试的时刻');
  // Within the pause, neither an automatic nor an explicit read asks again.
  reads.readStale([account]);
  assert.equal(calls, 1);
  assert.equal(quotaUsedUp([]), false);
  await reads.read(account);
  assert.equal(calls, 1, '暂停期内再点也只用那个中性的结果回答');
  // Past the pause it is asked again.
  clock += 120_001;
  await reads.read(account);
  assert.equal(calls, 2);
  assert.equal(requests.length, 2);
});

test('HTTP deadline covers a body that never finishes; stopping aborts reads', async (t) => {
  const { reads, account } = await setup(t, (_req, res) => { res.writeHead(200); res.write('{'); }, { timeoutMs: () => 80 });
  assert.match((await reads.read(account) as { reason: string }).reason, /TimeoutError/);
  const pending = reads.read(account);
  await reads.stop();
  assert.equal((await pending).ok, false);
  assert.equal(reads.state(account.id).reading, false);
});

test('the HTTP deadline also stops waiting for response headers', async (t) => {
  const { reads, account } = await setup(t, () => {}, { timeoutMs: () => 80 });
  assert.match((await reads.read(account) as { reason: string }).reason, /TimeoutError/);
});

test('transport failures and echoed model names never persist the token', async (t) => {
  const { f, reads, account, logs } = await setup(t, (_req, res) => {
    res.writeHead(200, HEADERS);
    res.end(JSON.stringify({ ...BODY, model: TOKEN }));
  });
  assert.deepEqual(await reads.read(account), { ok: true });
  assert.ok(!JSON.stringify(f.dump()).includes(TOKEN));
  const failing = createQuotaReads({
    ledger: f.ledger, adapters: ADAPTERS, token: () => TOKEN,
    timeoutMs: () => 100, staleMs: () => 1, log: (line) => logs.push(line),
    fetch: async () => { throw new TypeError(`connection failed ${TOKEN}`); },
  });
  const result = await failing.read(account);
  assert.match((result as { reason: string }).reason, /TypeError/);
  assert.ok(!JSON.stringify([result, failing.state(account.id), logs]).includes(TOKEN));
});

test('fresh/recently attempted accounts are not reread; missing models use existing reader', async (t) => {
  let refreshed = 0;
  const { f, reads, account, requests } = await setup(t, (_req, res) => { res.writeHead(200, HEADERS); res.end(JSON.stringify(BODY)); }, {
    refreshModels: async (login) => {
      refreshed++;
      f.ledger.noteModels(login.id, [{ id: 'available-model' }], new Date().toISOString());
      return { ok: true };
    },
  });
  f.ledger.noteUsage(account.id, [{ window: 'seven_day', used: 0.3, resetsAt: '2999-01-01T00:00:00.000Z' }]);
  reads.readStale([account]);
  assert.equal(requests.length, 0);
  f.ledger.noteModels(account.id, [], new Date().toISOString());
  await reads.read(account);
  assert.equal(refreshed, 1);
  reads.readStale([account]);
  assert.equal(requests.length, 1);
  assert.equal(reads.refusal({ executor: 'dsh' }), '这个执行器不报额度');
});


test('credential I/O failure is a settled quota failure', async (t) => {
  const { reads, account } = await setup(t, () => {}, { token: () => { throw new Error('credential access denied'); } });
  const result = await reads.read(account);
  assert.equal(result.ok, false);
  assert.match(reads.state(account.id).failure!, /credential access denied/);
  assert.equal(reads.state(account.id).reading, false);
});
