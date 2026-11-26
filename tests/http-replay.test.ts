// Isolated rules stay behind the owner session. Requests cannot choose production
// paths, and running the evaluation never changes the live task ledger.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplayConsole } from '../service/replay-console.ts';
import { consoleApp, TOOL_TOKEN } from './console-helpers.ts';
import { fixture } from './helpers.ts';

test('replay routes require owner authentication, enforce origin and leave the real ledger untouched', async t => {
  const f = fixture(t);
  const replay = createReplayConsole({ dataDir: f.dir });
  const { get, send, cookie, url } = await consoleApp(t, { f, replay });
  const chosen = replay.cases().cases.find(item => item.case_id === 'clean-owner-review')!;
  for (const [method, path, body] of [['GET', '/api/replay/cases', undefined], ['GET', '/api/replay/runs/missing/draft', undefined], ['POST', '/api/replay/run', chosen]] as const) {
    assert.equal((await send(method, path, body, { Origin: url })).status, 401);
    assert.equal((await send(method, path, body, { Origin: url, Authorization: `Bearer ${TOOL_TOKEN}` })).status, 401);
  }
  assert.equal((await send('POST', '/api/replay/run', chosen, { Cookie: cookie, Origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await get('/api/replay/cases')).status, 200);
  const before = f.dump();
  const result = await send('POST', '/api/replay/run', chosen);
  assert.equal(result.status, 200);
  const answer = await result.json() as Awaited<ReturnType<typeof replay.run>>;
  assert.equal(answer.mode, 'isolated-rule-simulation');
  assert.equal(answer.external_effects, 0);
  assert.deepEqual(answer.result.failures, []);
  assert.deepEqual(f.dump(), before);
  assert.equal((await send('POST', '/api/replay/run', { ...chosen, baseline: '/private/path' })).status, 400);
  assert.equal((await get('/api/replay/runs/missing/draft')).status, 400);
});
