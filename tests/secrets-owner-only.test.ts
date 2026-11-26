// Guards the files that hold a token this machine's own processes use (service.json,
// login-token): the local join takes "can read service.json" as "is the user running the
// host" (docs/design/nodes.md §1.1 step 2), so such a file must never be readable by
// another account — not even for the moment between writing it and narrowing it.
//
// What this file is here to catch:
//   - a token file that inherits the data directory's access (Windows keeps no mode bits;
//     what counts there is the ACL), or keeps an earlier file's wider access,
//   - a POSIX file left at the umask's mode,
//   - the service writing service.json or login-token some other way.
import './guard.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loginTokenFile, serviceFile } from '../service/config.ts';
import { startService } from '../service/main.ts';
import { writeOwnerOnly } from '../service/secrets.ts';
import { keyAccess } from '../service/ssh-key.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');

// A directory whose files everyone may read unless something narrows them.
function openDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-owner-only-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (process.platform === 'win32') execFileSync('icacls', [dir, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true, stdio: 'ignore' });
  else chmodSync(dir, 0o755);
  return dir;
}

const scratch = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-owner-only-acl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('写进去的令牌文件只有运行它的用户能读，目录放开了也一样', (t) => {
  const dir = openDir(t);
  // The setup is what it claims: a plain file here is readable by others.
  const plain = join(dir, 'plain');
  writeFileSync(plain, 'x', { mode: 0o644 });
  assert.equal(keyAccess(plain, scratch(t)).kind, 'open', '测试目录本身没有放开');

  const file = join(dir, 'service.json');
  writeOwnerOnly(file, '{"token":"synthetic"}');
  assert.equal(readFileSync(file, 'utf8'), '{"token":"synthetic"}');
  assert.deepEqual(keyAccess(file, scratch(t)), { kind: 'ok' });
});

test('换掉一份原来放开了的文件：新文件不继承旧文件的权限', (t) => {
  const dir = openDir(t);
  const file = join(dir, 'login-token');
  writeFileSync(file, 'old', { mode: 0o644 });
  writeOwnerOnly(file, 'new');
  assert.equal(readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(keyAccess(file, scratch(t)), { kind: 'ok' });
});

test('服务写的 service.json 和 login-token 只有运行服务的用户能读', { timeout: 60_000 }, async (t) => {
  const dataDir = openDir(t);
  const service = await startService({ dataDir, port: 0, claude: [process.execPath, FAKE] });
  try {
    for (const file of [serviceFile(dataDir), loginTokenFile(dataDir)]) {
      assert.deepEqual(keyAccess(file, scratch(t)), { kind: 'ok' }, file);
    }
  } finally {
    // Before the directory is removed: a running service holds files in it.
    await service.stop();
  }
});
