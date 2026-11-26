// Guards how the Codex adapter reads its own device-code sign-in screen (adapters/codex.ts
// `signIn`), against the recording in tests/fixtures/codex/0.162.0/login-device.
//
// What this file is here to catch:
//   - the link or the code read with the colour sequences still around them (the owner would be
//     shown `ESC[94mhttps://…`, or the code would not be found at all),
//   - a screen printed so far only up to the link taken as ready: the owner would be shown a
//     link and no code,
//   - a screen this cannot read throwing out of the reader, which would take the machine's
//     sign-in down instead of leaving it "starting" until its time runs out,
//   - the declared command drifting from the one that was recorded.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexAdapter } from '../adapters/codex.ts';

const SCREEN = readFileSync(join(import.meta.dirname, 'fixtures', 'codex', '0.162.0', 'login-device', 'stdout.txt'), 'utf8');
const signIn = codexAdapter.signIn!;

test('实录的设备码画面：读出验证网址和用户码，不带颜色序列', () => {
  assert.deepEqual(signIn.argv, ['codex', 'login', '--device-auth']);
  assert.deepEqual(signIn.read(SCREEN), { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
});

test('分几块到达：只出现网址、还没出现码时不算读到', () => {
  const at = SCREEN.indexOf('2. Enter');
  assert.ok(at > 0);
  assert.equal(signIn.read(SCREEN.slice(0, at)), undefined, '只有网址');
  assert.equal(signIn.read(SCREEN.slice(0, SCREEN.indexOf('ABCD-123'))), undefined, '码还没印全');
  // Every prefix either reads nothing or reads exactly the recorded pair.
  for (let end = 0; end <= SCREEN.length; end += 7) {
    const read = signIn.read(SCREEN.slice(0, end));
    if (read !== undefined) assert.deepEqual(read, { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  }
});

test('认不出的画面：返回 undefined，不抛', () => {
  for (const screen of ['', 'Error: not logged in\n', '\x1b[31m\x1b[0m', 'code ABCD-12345 but no link', 'https://example.com only', '\x1b]0;title\x07\x1b[?25l']) {
    assert.equal(signIn.read(screen), undefined, JSON.stringify(screen));
  }
  assert.doesNotThrow(() => signIn.read(undefined as unknown as string));
});
