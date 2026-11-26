// Guards against archives escaping staging or containing links.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './cli-helpers.ts';
import { hostileArchives } from './cli-tar.ts';
import type { Hostile } from './cli-tar.ts';
import { WINDOWS, sandbox, variant, sharedArchive } from './cli-install-e2e-fixture.ts';

// ---- An archive that reaches outside the staging directory ----

// Every directory, file (by content) and link under these roots.
function snapshot(roots: string[]): string[] {
  const seen: string[] = [];
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) seen.push(`${path} -> ${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      seen.push(`${path}/`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else seen.push(`${path} = ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
  };
  roots.forEach(walk);
  return seen;
}

test('坏包装不进去：安装失败并说明原因，暂存区之外什么都没有变', async (t) => {
  const s = sandbox(t);
  // Its own short directory: the names that aim at it have to fit a tar header.
  const target = tempDir(t, 'ty-');
  const outside = join(target, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.txt'), '原样');
  const archives = hostileArchives(outside.replaceAll('\\', '/'));
  for (const [kind, archive] of Object.entries(archives)) writeFileSync(join(s.dir, `${kind}.tar.gz`), archive);
  // What the script makes before it looks at any archive.
  mkdirSync(join(s.prefix, 'versions'), { recursive: true });
  // Not the home directory: PowerShell keeps things of its own there.
  const watched = [join(s.dir, 'program dir'), target];
  const before = snapshot(watched);

  const says: Record<Hostile, RegExp> = WINDOWS
    ? { dotdot: /outside the directory/, absolute: /outside the directory/, drive: /outside the directory/, symlink: /not a plain file or a directory/, hardlink: /not a plain file or a directory/ }
    : { dotdot: /解包目录之外/, absolute: /解包目录之外/, drive: /解包目录之外/, symlink: /不是普通文件或目录/, hardlink: /不是普通文件或目录/ };
  for (const kind of Object.keys(archives) as Hostile[]) {
    const ran = await s.install(join(s.dir, `${kind}.tar.gz`));
    assert.notEqual(ran.code, 0, `${kind}：${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout + ran.stderr, says[kind], kind);
    assert.deepEqual(snapshot(watched), before, `${kind}：暂存区清掉以后，一切都该和安装前一样`);
  }
});
