// The state reports the running service's release, independently of any page build.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleApp } from './console-helpers.ts';

test('GET /api/state reports the actual running service version, including a rollback', async (t) => {
  let version = '0.1.711';
  const app = await consoleApp(t, { releases: {
    dataDir: '', get version() { return version; }, last: () => null, intent: () => null,
    attempting: () => false, launch: () => { throw new Error('not a release action'); },
  } });
  const read = async () => (await (await app.get('/api/state')).json()) as { version?: string };
  assert.equal((await read()).version, '0.1.711');
  version = '0.1.700';
  assert.equal((await read()).version, '0.1.700');
});
