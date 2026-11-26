// What this guards against, on the Codex CLI the machines were upgraded to (0.167.1): an
// upgrade that changes what tycho reads out of the command without a test noticing — its version
// line, the exit codes of its login status, its model catalog signed in and signed out, the
// device sign-in's screen, a refused key, the switches a round is started with, the read-only
// probe, the memories switch every round passes, and where it reads the global entry.
// Recorded on the controller workstation without spending quota (tests/fixtures/codex/0.167.1).
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexAdapter } from '../adapters/codex.ts';
import { tooOld } from '../adapters/version.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'codex', '0.167.1');
const read = (path: string): string => readFileSync(join(DIR, path), 'utf8');
const exit = (path: string): number => Number(read(path).trim());

test('the version line reads as a version, and login status answers by its exit code', () => {
  const line = read('login-status/version.stdout.txt').trim();
  assert.equal(line, 'codex-cli 0.167.1');
  assert.equal(codexAdapter.minVersion, undefined, '没有最低版本：旧版只是不带记忆开关');
  assert.deepEqual(codexAdapter.loginStatus, ['login', 'status']);
  assert.equal(exit('login-status/logged-in.exit'), 0);
  assert.equal(exit('login-status/logged-out.exit'), 1);
});

test('the catalog signed in is the vendor\'s, and the one signed out is what this version ships with', () => {
  const query = codexAdapter.listModels!({});
  assert.equal(query.kind, 'command');
  if (query.kind !== 'command') return;
  assert.deepEqual(query.argv, ['codex', 'debug', 'models']);
  const signedIn = query.parse(read('models/signed-in.json'));
  const signedOut = query.parse(read('models/signed-out.json'));
  assert.ok(signedIn.some(({ id, hidden }) => id === 'gpt-6.1-terra' && hidden !== true));
  assert.ok(signedIn.every(({ efforts }) => (efforts?.length ?? 0) > 0), '每个模型自己说接受哪些强度');
  assert.ok(signedIn.some(({ hidden }) => hidden === true), '隐藏的照样报，由控制台决定');
  assert.ok(signedOut.length > 0);
  assert.equal(exit('models/signed-in.exit'), 0);
  assert.equal(exit('models/signed-out.exit'), 0);
});

test('the device sign-in prints the address and the code where they were', () => {
  assert.deepEqual(codexAdapter.signIn!.read(read('login-device/stdout.txt')), { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
});

test('every switch a round is started with is taken, and a refused key is a login failure', () => {
  for (const name of ['wrong-key', 'wrong-key-read-only']) {
    const stdout = read(`api-key/${name}.ndjson`);
    // Recorded with the switches launch() passes; a switch it no longer took would end the
    // command before any turn, with its usage text and no thread.
    assert.match(stdout, /"type":"thread.started"/);
    const reading = codexAdapter.result(stdout, exit(`api-key/${name}.exit`), '');
    assert.equal(reading.error!.kind, 'auth', name);
  }
  assert.deepEqual(codexAdapter.credential!({}), { variable: 'CODEX_API_KEY' });
});

test('the read-only probe starts, and the memories switch every round passes is still known', () => {
  assert.equal(exit('readonly/sandbox.exit'), 0);
  assert.match(read('readonly/sandbox.stdout.txt'), /^codex-cli /);
  assert.match(read('global-entry/features-memories.txt'), /^memories\s/m);
  // An unknown feature fails the whole command: the switch is not dropped silently.
  assert.equal(exit('global-entry/unknown-feature.exit'), 1);
});

test('the global entry is read from its home, and an override beside it is read instead', () => {
  assert.equal(codexAdapter.globalEntry!.file, 'AGENTS.md');
  assert.match(read('global-entry/prompt-input-global.txt'), /tycho-global-entry-marker-167/);
  const overridden = read('global-entry/prompt-input-override.txt');
  assert.match(overridden, /override-marker-167/);
  assert.doesNotMatch(overridden, /tycho-global-entry-marker-167/);
});
