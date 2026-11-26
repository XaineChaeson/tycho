// Verifies node identity directory, token, and pending join secret files are written
// owner-only (0600/0700 on POSIX, restricted ACL without inheritance on Windows).
import './guard.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { identityOf, readPendingJoin, readToken, writePendingJoin, writeToken } from '../node/client.ts';
import { tempDir } from './cli-helpers.ts';

function assertOwnerOnly(path: string, expectedPosixMode: number): void {
  if (process.platform === 'win32') {
    const icacls = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'icacls.exe');
    const output = execFileSync(icacls, [path], { encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(output, /\(I\)/, `inherited ACL entries must be removed on ${path}:\n${output}`);
    assert.doesNotMatch(output, /Everyone|BUILTIN\\Users|Authenticated Users/i, `broad principal must not have access to ${path}:\n${output}`);
    return;
  }
  assert.equal(statSync(path).mode & 0o777, expectedPosixMode, path);
}

test('node identity directory, token, and pending join files are restricted to the current user', (t) => {
  const dataDir = tempDir(t, 'tycho-node-acl-');
  const identity = identityOf(dataDir);
  const token = 'a'.repeat(64);
  const pending = { secret: 'b'.repeat(64), code: '123456', origin: 'https://tycho.example.com' };

  writeToken(identity, token);
  writePendingJoin(identity, pending);

  assert.equal(readToken(identity), token);
  assert.deepEqual(readPendingJoin(identity), pending);

  assertOwnerOnly(identity.dir, 0o700);
  assertOwnerOnly(join(identity.dir, 'token'), 0o600);
  assertOwnerOnly(join(identity.dir, 'join.json'), 0o600);
});
