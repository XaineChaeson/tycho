// What this guards against:
//   - a line's patch drifting from the one dsh 0.2.2-rc.1 was really run with (the recording
//     under tests/fixtures/dsh/0.2.2-rc.1/line): a round would then start on a patch nobody ran;
//   - a key reaching the ledger or a snapshot by way of the definition (an address with a
//     password in it, the form's own keys said again in the free text);
//   - an account's tier turning the stored-credential services back on, or naming another
//     route: the round would run on whatever that machine has stored, not on the account —
//     which is why the line is the last patch, after the tier;
//   - the official line taking its endpoint or its key's variable from the machine
//     ($DEEPSEEK_BASE_URL), sending the account's key wherever that points;
//   - a model whose only strength is "off", which dsh refuses as a reasoning table;
//   - the key travelling under DEEPSEEK_API_KEY for a line that is not DeepSeek's, which dsh's
//     web search would send to DeepSeek.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dshAdapter } from '../adapters/dsh.ts';
import type { Provider } from '../adapters/types.ts';

const line = dshAdapter.provider!;
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/dsh/0.2.2-rc.1/line/${name}`, import.meta.url), 'utf8');
const tier = (text: string) => ({ kind: 'content' as const, text });

const RECORDED = {
  line: 'custom', api: 'openai-completions', baseURL: 'http://127.0.0.1:53998/v1',
  models: [{ id: 'fake-model', efforts: ['off', 'high', 'max'], image: true }, { id: 'fake-model-2' }],
  more: 'retryPolicy:\n  mode: normal\n  maxRetries: 2\ndefaultContextWindow: 200000',
};

function checked(input: unknown): Provider {
  const answer = line.check(input);
  if ('problem' in answer) assert.fail(answer.problem);
  return answer.provider;
}
const refused = (input: unknown): string => {
  const answer = line.check(input);
  if (!('problem' in answer)) assert.fail('应当拒收：' + JSON.stringify(input));
  return answer.problem;
};

test('a custom line is written as the patch dsh was really run with', () => {
  const { file, text } = line.config(checked(RECORDED));
  assert.equal(file, 'line.patch.yml');
  assert.equal(text, fixture('custom.line.patch.yml'));
  // The run that patch was recorded with completed.
  const last = JSON.parse(fixture('custom.run.ndjson').trim().split('\n').at(-1)!);
  assert.equal(last.type, 'final');
  assert.equal(last.reason.kind, 'completed');
});

test('an official line keeps the stored-credential services off and says its own endpoint and key variable', () => {
  const { text } = line.config(checked({ line: 'official' }));
  assert.equal(text, fixture('official.line.patch.yml'));
  assert.match(text, /- id: llm-deepseek\n  config:\n    apiKeyEnv: DEEPSEEK_API_KEY\n    baseURL: "https:\/\/api\.deepseek\.com\/anthropic"/);
  // Recorded with $DEEPSEEK_BASE_URL pointing at a local gateway: DeepSeek's own endpoint
  // answered, and refused the made-up key.
  const last = JSON.parse(fixture('official-endpoint.run.ndjson').trim().split('\n').at(-1)!);
  assert.equal(last.reason.error.code, 'AUTH');
  assert.equal(line.tierProblem(checked({ line: 'official' }), tier(fixture('official.tier.patch.yml'))), undefined);
});

test('a model whose only strength is off is written as a model that does not reason', () => {
  const { text } = line.config(checked({ ...RECORDED, models: [{ id: 'plain', efforts: ['off'] }], more: undefined }));
  assert.match(text, /- id: "plain"\n {12}reasoningEfforts: false\n/);
  assert.ok(!text.includes('"off": null'));
});

test('the key travels in the environment: tycho\'s own variable for a custom line, DeepSeek\'s for the official one', () => {
  assert.deepEqual(dshAdapter.credential!({ provider: checked(RECORDED) }), { variable: 'TYCHO_DSH_API_KEY' });
  assert.deepEqual(dshAdapter.credential!({ provider: checked({ line: 'official' }) }), { variable: 'DEEPSEEK_API_KEY' });
  assert.ok(fixture('custom.line.patch.yml').includes('apiKeyEnv: TYCHO_DSH_API_KEY'));
});

test('a definition is kept as checked, and nothing else of what was sent', () => {
  assert.deepEqual(checked({ line: 'official', baseURL: 'http://x', key: 'secret' }), { line: 'official' });
  assert.deepEqual(checked({ ...RECORDED, key: 'secret', models: [{ id: ' m ', efforts: ['high', 'high'], extra: 1 }] }), {
    line: 'custom', api: 'openai-completions', baseURL: 'http://127.0.0.1:53998/v1', models: [{ id: 'm', efforts: ['high'] }], more: RECORDED.more,
  });
  assert.equal('more' in checked({ ...RECORDED, more: '  \n' }), false);
});

test('what cannot be a line is refused with the field it is about', () => {
  assert.match(refused(null), /对象/);
  assert.match(refused({ line: 'other' }), /线路类型/);
  assert.match(refused({ ...RECORDED, api: 'grpc' }), /协议/);
  assert.match(refused({ ...RECORDED, baseURL: '' }), /地址/);
  assert.match(refused({ ...RECORDED, baseURL: 'gateway.local/v1' }), /地址/);
  assert.match(refused({ ...RECORDED, baseURL: 'ftp://gateway.local' }), /http/);
  assert.match(refused({ ...RECORDED, baseURL: 'https://user:pass@gateway.local/v1' }), /用户名和密码/);
  assert.match(refused({ ...RECORDED, models: [] }), /至少/);
  assert.match(refused({ ...RECORDED, models: [{ id: 'a' }, { id: 'a' }] }), /两次/);
  assert.match(refused({ ...RECORDED, models: [{ id: 'a b' }] }), /空白/);
  assert.match(refused({ ...RECORDED, models: [{ id: 'a', efforts: ['very high'] }] }), /强度/);
});

test('the free text may not say the form\'s keys again, nor leave the route\'s block', () => {
  for (const key of ['apiKeyEnv', 'api', 'baseURL', 'models', 'modelOverrides', 'displayName']) {
    assert.match(refused({ ...RECORDED, more: `${key}: x` }), new RegExp(key));
  }
  assert.match(refused({ ...RECORDED, more: '"apiKeyEnv": OTHER' }), /apiKeyEnv/);
  assert.match(refused({ ...RECORDED, more: '---\nretryPolicy: {}' }), /分隔线/);
  assert.match(refused({ ...RECORDED, more: 'retryPolicy:\n\tmode: normal' }), /制表符/);
  assert.match(refused({ ...RECORDED, more: '- id: credentials' }), /键: 值/);
  assert.match(refused({ ...RECORDED, more: `compat:\n  x: ${'y'.repeat(9000)}` }), /KB/);
  // A nested key of the same name is the route's own business.
  checked({ ...RECORDED, more: 'compat:\n  models: x' });
});

test('route names each line while tierProblem performs no regex policing (line.patch.yml overrides structurally)', () => {
  const custom = checked(RECORDED);
  assert.equal(line.route(custom), 'tycho');
  assert.equal(line.route(checked({ line: 'official' })), 'deepseek-official');
  assert.equal(line.tierProblem(custom, tier(fixture('custom.tier.patch.yml'))), undefined);
  assert.equal(line.tierProblem(custom, tier('- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: x\n')), undefined);
  for (const id of ['credentials', 'authorization', 'deepseek-account', 'llm-pi-ai', 'llm-deepseek']) {
    assert.equal(line.tierProblem(custom, tier(`- id: ${id}\n  disabled: false\n${fixture('custom.tier.patch.yml')}`)), undefined);
  }
});

test('a custom line says what it serves itself; the official one has to be asked', () => {
  assert.deepEqual(line.models(checked(RECORDED)), [{ id: 'fake-model', efforts: ['off', 'high', 'max'] }, { id: 'fake-model-2', efforts: [] }]);
  assert.equal(line.models(checked({ line: 'official' })), undefined);
});

test('a line is asked for its models the way dsh\'s own discovery asks', () => {
  const openai = line.discover(checked({ ...RECORDED, baseURL: 'https://gw.example/v1/' }), 'K')!;
  assert.equal(openai.url, 'https://gw.example/v1/models');
  assert.deepEqual(openai.headers, { authorization: 'Bearer K' });
  const anthropic = line.discover(checked({ ...RECORDED, api: 'anthropic-messages', baseURL: 'https://gw.example/v1' }), 'K')!;
  assert.equal(anthropic.url, 'https://gw.example/v1/models?limit=1000');
  assert.equal(anthropic.headers['x-api-key'], 'K');
  const official = line.discover(checked({ line: 'official' }), 'K')!;
  assert.equal(official.url, 'https://api.deepseek.com/models');
  assert.deepEqual(official.headers, { 'x-api-key': 'K' });
  assert.deepEqual(openai.parse('{"object":"list","data":[{"id":"a"},{"id":""},{"name":"x"},{"id":"b","owned_by":"y"}]}'), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(openai.parse('<html>'), []);
  assert.deepEqual(openai.parse('{"data":"no"}'), []);
});

test('a round of an account is started with its line after its tier, so the tier cannot undo it', () => {
  const turn = { prompt: 'p', workdir: '.', tier: tier('x'), tierPath: 'runs/r/snapshot/tier.patch.yml' };
  const own = dshAdapter.launch(turn).argv;
  assert.equal(own.filter((arg) => arg === '--patch').length, 1);
  const account = dshAdapter.launch({ ...turn, linePath: 'runs/r/snapshot/line.patch.yml' }).argv;
  const patches = account.flatMap((arg, at) => (arg === '--patch' ? [account[at + 1]] : []));
  assert.deepEqual(patches, ['runs/r/snapshot/tier.patch.yml', 'runs/r/snapshot/line.patch.yml']);
  const resumed = dshAdapter.resume({ ...turn, linePath: 'runs/r/snapshot/line.patch.yml', sessionRef: 's' }).argv;
  assert.ok(resumed.includes('runs/r/snapshot/line.patch.yml'));
});
