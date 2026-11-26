// Guards the one exit to an executor's own directory (service/home-paths.ts executorDirOf) in a
// test process: it must never hand out the owner's real ~/.claude, ~/.codex or ~/.dsh, however the
// path reaches it.
//
// What this file is here to catch:
//   - a variable inherited from the owner's shell (CODEX_HOME, CLAUDE_CONFIG_DIR, DSH_HOME) taken as
//     "the test isolated this" because it is set at all,
//   - the same directory spelled another way: other letter case, `..` segments, a junction or
//     symbolic link that leads into it,
//   - a test run whose processes start with no temporary executor directories of their own,
//   - the compiled helper's default cache (service/home-paths.ts cachePathOf) landing in the
//     owner's own tycho directory because a test called the shared process helper directly.
//
// Every check here is on paths only: nothing is created in or near the owner's directories (a
// junction pointing at one is made in a temporary directory, and only read through).
import './guard.ts';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { cachePathOf, executorDirOf } from '../service/home-paths.ts';
import { EXECUTOR_HOME_VARIABLES, HELPER_CACHE_VARIABLE } from './guard.ts';

const OWNER = homedir();
const REFUSED = /测试碰不到主人真实的执行器目录/;
const homes = Object.values(ADAPTERS).flatMap(({ globalEntry }) => (globalEntry === undefined ? [] : [globalEntry.home]));

test('继承来的变量指着主人真实的执行器目录：照样拒绝，不因为“变量设了”就放行', () => {
  for (const { env, dir } of homes) {
    if (env !== undefined) {
      assert.throws(() => executorDirOf({ [env]: join(OWNER, dir) }, '/elsewhere', env, dir), REFUSED, env);
      assert.throws(() => executorDirOf({ [env]: join(OWNER, dir, 'sub') }, '/elsewhere', env, dir), REFUSED, `${env} 下面的目录`);
    }
    // No variable: the default place under the owner's home.
    assert.throws(() => executorDirOf({}, OWNER, env, dir), REFUSED, `${env ?? dir} 的默认位置`);
  }
  const synthetic = join(tmpdir(), 'elsewhere');
  assert.equal(executorDirOf({}, synthetic, undefined, '.gemini'), join(synthetic, '.gemini'));
});

test('换一种写法指到同一个目录：大小写、.. 段都认得出来', () => {
  const { env, dir } = homes.find((each): each is { env: string; dir: string } => each.env !== undefined)!;
  assert.throws(() => executorDirOf({ [env]: join(OWNER, 'x', '..', dir) }, '/elsewhere', env, dir), REFUSED);
  if (process.platform === 'win32') assert.throws(() => executorDirOf({ [env]: join(OWNER, dir).toUpperCase() }, '/elsewhere', env, dir), REFUSED);
});

test('经链接指过去：临时目录里的 junction 指向主人的执行器目录，也拒绝', (t) => {
  const { env, dir } = homes.find((each): each is { env: string; dir: string } => each.env !== undefined)!;
  const scratch = mkdtempSync(join(tmpdir(), 'tycho-dirs-guard-'));
  const alias = join(scratch, 'alias');
  // The link goes first, on its own: nothing that cleans up here may walk into what it points at.
  t.after(() => {
    if (lstatSync(alias, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(alias);
    rmSync(scratch, { recursive: true, force: true });
  });
  try {
    symlinkSync(join(OWNER, dir), alias, 'junction');
  } catch (error) {
    t.skip(`这台机器上建不了链接：${(error as Error).message}`);
    return;
  }
  assert.throws(() => executorDirOf({ [env]: alias }, '/elsewhere', env, dir), REFUSED);
  assert.throws(() => executorDirOf({ [env]: join(alias, 'rules') }, '/elsewhere', env, dir), REFUSED);
});

test('测试自己的临时目录照常放行', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'tycho-dirs-guard-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  for (const { env, dir } of homes) {
    assert.equal(executorDirOf(env ? { [env]: join(scratch, dir) } : {}, env ? OWNER : scratch, env, dir), join(scratch, dir));
  }
});

test('每次测试运行的进程都带着自己的临时执行器目录，不继承主人终端里的', () => {
  for (const { env } of homes) if (env !== undefined) assert.ok(EXECUTOR_HOME_VARIABLES.includes(env), `${env} 在测试防护的清单里`);
  for (const variable of EXECUTOR_HOME_VARIABLES) {
    const value = process.env[variable];
    assert.ok(value, `${variable} 设了`);
    assert.ok(value.toLowerCase().startsWith(tmpdir().toLowerCase()), `${variable} 在临时目录里：${value}`);
    assert.doesNotThrow(() => executorDirOf(process.env, OWNER, variable, '.x'));
  }
});

test('编译缓存的默认根在本次运行的临时目录里；没有它就不给主人目录下的默认值', () => {
  const root = process.env[HELPER_CACHE_VARIABLE];
  assert.ok(root, `${HELPER_CACHE_VARIABLE} 设了`);
  assert.ok(root.toLowerCase().startsWith(tmpdir().toLowerCase()), `${HELPER_CACHE_VARIABLE} 在临时目录里：${root}`);
  assert.equal(cachePathOf(process.env, OWNER, 'procinfo'), join(root, 'procinfo'));
  for (const env of [{}, { TYCHO_TEST_GUARD: '1' }, { NODE_TEST_CONTEXT: '1' }]) {
    assert.throws(() => cachePathOf(env, OWNER, 'procinfo'), /TYCHO_TEST_CACHE/, `没有 ${HELPER_CACHE_VARIABLE} 时不落到主人目录下`);
  }
});

test('非测试身份的编译缓存默认在 tycho 主目录', async () => {
  const context = process.env.NODE_TEST_CONTEXT;
  const guard = process.env.TYCHO_TEST_GUARD;
  const entry = process.argv[1];
  try {
    delete process.env.NODE_TEST_CONTEXT;
    delete process.env.TYCHO_TEST_GUARD;
    process.argv[1] = 'tycho';
    const moduleUrl = new URL('../service/home-paths.ts?production', import.meta.url).href;
    const { cachePathOf: productionCache } = await import(moduleUrl) as typeof import('../service/home-paths.ts');
    assert.equal(productionCache({}, OWNER, 'procinfo'), join(OWNER, '.tycho', 'cache', 'procinfo'));
  } finally {
    if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
    if (guard !== undefined) process.env.TYCHO_TEST_GUARD = guard;
    process.argv[1] = entry!;
  }
});
