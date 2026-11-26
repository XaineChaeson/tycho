// What this guards against, at the console's interface for an account that is a line and its
// key (docs/design/native-login.md):
//   - the page not being told how a line is asked for, so the console would have to know dsh;
//   - the key coming back out of any answer, the line's or the models';
//   - "read the models from the line" asking with a key other than the one in the form, or
//     keeping what it read; or sending a key the service keeps to a line the request names;
//   - a line that cannot be one being asked at all.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dshAdapter } from '../adapters/dsh.ts';
import { readModels } from '../service/models.ts';
import { consoleApp } from './console-helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

const KEY = 'sk-line-http-key-7781';
const OTHER = 'sk-line-http-other-0042';
const CUSTOM = { line: 'custom', api: 'openai-completions', baseURL: 'http://gateway.test/v1', models: [{ id: 'm1', efforts: ['high'] }] };
const OFFICIAL_TIER = { kind: 'content', text: '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n' };
const CUSTOM_TIER = { kind: 'content', text: '- id: agent-default-model\n  config:\n    provider: tycho\n    model: m1\n' };

// A gateway that answers its listing to one key only, and remembers who asked.
function gateway() {
  // `key` is the key as either header carried it: a bearer token or x-api-key.
  const asked: { url: string; key: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const key = headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    asked.push({ url: String(input), key });
    if (key !== KEY) return new Response('{"error":"bad key"}', { status: 401 });
    return new Response(JSON.stringify({ data: [{ id: 'served-a' }, { id: 'served-b' }] }), { status: 200 });
  }) as typeof fetch;
  return { asked, fetcher };
}

async function app(t: Parameters<typeof consoleApp>[0]) {
  const { asked, fetcher } = gateway();
  const models = {
    state: () => ({ list: [], at: null, refreshing: false }),
    refresh: async () => ({ ok: false as const, reason: 'not here' }),
    reschedule: () => {},
    readLine: (executor: string, provider: Record<string, unknown>, key: string | undefined) =>
      readModels({ executor, provider, executors: { dsh: dshAdapter }, timeoutMs: 1000, fetch: fetcher, ...(key === undefined ? {} : { token: key }) }),
  };
  const served = await consoleApp(t, { models });
  return { ...served, asked };
}

test('the page says how a line is defined, by executor; an account shows its line and never its key', async (t) => {
  const { send } = await app(t);
  const page = await json(await send('GET', '/api/accounts'));
  assert.deepEqual(Object.keys(page.provider_forms), ['dsh', 'gemini']);
  assert.deepEqual(page.provider_forms.dsh.lines.map((line: { id: string }) => line.id), ['custom', 'official']);
  assert.deepEqual(page.provider_forms.gemini.lines.map((line: { id: string }) => line.id), ['custom', 'official']);
  assert.ok(page.credential_executors.includes('dsh') && page.credential_executors.includes('codex'));
  const made = await send('POST', '/api/accounts', { name: 'ds', executor: 'dsh', provider: { line: 'official' }, tiers: { execute: OFFICIAL_TIER }, credential: KEY });
  assert.equal(made.status, 201);
  const body = await json(made);
  assert.deepEqual(body.account.provider, { line: 'official' });
  const listed = await json(await send('GET', '/api/accounts'));
  assert.equal(listed.accounts.find((account: { name: string }) => account.name === 'ds').provider.line, 'official');
  assert.equal(JSON.stringify([body, listed]).includes(KEY), false);
  const claude = listed.accounts.find((account: { executor: string }) => account.executor === 'claude');
  assert.equal(claude.provider, null);
});

test('a line is checked where it is saved, with the field it is about', async (t) => {
  const { send } = await app(t);
  const bad = await send('POST', '/api/accounts', { name: 'ds', executor: 'dsh', provider: { ...CUSTOM, baseURL: 'nope' }, tiers: { execute: CUSTOM_TIER }, credential: KEY });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error, /^线路：地址/);
  const none = await send('POST', '/api/accounts', { name: 'ds', executor: 'dsh', tiers: { execute: CUSTOM_TIER }, credential: KEY });
  assert.match((await json(none)).error, /要有一条线路/);
});

test('reading a line\'s models asks with the key in the form, keeps nothing, and says why when it cannot', async (t) => {
  const { send, asked } = await app(t);
  const listed = await send('POST', '/api/account-lines/models', { executor: 'dsh', provider: { ...CUSTOM, models: undefined }, key: KEY });
  // A line with no models written is still a draft the form may ask about; the check that
  // refuses it is the save's.
  assert.equal(listed.status, 400);
  const draft = { ...CUSTOM, models: [{ id: 'placeholder' }] };
  const written = await json(await send('POST', '/api/account-lines/models', { executor: 'dsh', provider: draft, key: KEY }));
  assert.deepEqual(written.models, [{ id: 'placeholder', efforts: [] }], '线路自己写了模型就用它写的，不去问');
  assert.equal(asked.length, 0);
  const official = await json(await send('POST', '/api/account-lines/models', { executor: 'dsh', provider: { line: 'official' }, key: KEY }));
  assert.deepEqual(official.models, [{ id: 'served-a' }, { id: 'served-b' }]);
  assert.equal(asked.at(-1)!.url, 'https://api.deepseek.com/models');
  const refused = await json(await send('POST', '/api/account-lines/models', { executor: 'dsh', provider: { line: 'official' }, key: OTHER }));
  assert.deepEqual(refused.models, []);
  assert.match(refused.reason, /401/);
  assert.equal(JSON.stringify(refused).includes(OTHER), false);
  const keyless = await json(await send('POST', '/api/account-lines/models', { executor: 'dsh', provider: { line: 'official' } }));
  assert.match(keyless.reason, /没有这条线路的密钥/);
  const claude = await send('POST', '/api/account-lines/models', { executor: 'claude', provider: { line: 'official' }, key: KEY });
  assert.match((await json(claude)).error, /没有线路这一说/);
});

test('a key the service keeps never goes out with a line the request names', async (t) => {
  const { send, asked } = await app(t);
  const made = await json(await send('POST', '/api/accounts', { name: 'ds', executor: 'dsh', provider: { line: 'official' }, tiers: { execute: OFFICIAL_TIER }, credential: KEY }));
  const answer = await json(await send('POST', '/api/account-lines/models', { executor: 'dsh', provider: { ...CUSTOM, models: undefined, baseURL: 'https://elsewhere.test/v1' }, account: made.account.id }));
  assert.equal(asked.some((each) => each.key === KEY), false);
  assert.equal(JSON.stringify(answer).includes(KEY), false);
});
