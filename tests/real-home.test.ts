// Guards against reaching the owner's installation when callers rebuild env, or a test
// starts a non-test helper with a deliberately minimal environment.
import './guard.ts';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultPrefix } from '../cli/paths.ts';
import { dataDirOf } from '../service/config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('rebuilding env cannot erase the current test process identity', () => {
  assert.throws(() => dataDirOf({}, homedir()), /TYCHO_DATA/);
  assert.throws(() => dataDirOf({ TYCHO_DATA: '' }, homedir()), /TYCHO_DATA/);
  assert.throws(() => defaultPrefix({}, homedir()), /TYCHO_PREFIX/);
  assert.ok(dataDirOf({ TYCHO_DATA: tmpdir() }, homedir()));
  assert.ok(defaultPrefix({ TYCHO_PREFIX: tmpdir() }, homedir()));
  assert.ok(dataDirOf({}, tmpdir()).startsWith(tmpdir()));
  assert.ok(defaultPrefix({}, tmpdir()).startsWith(tmpdir()));
});

test('a helper child with env rebuilt from scratch still refuses both owner defaults', () => {
  const code = [
    "import { dataDirOf } from './service/config.ts';",
    "import { defaultPrefix } from './cli/paths.ts';",
    "import { homedir } from 'node:os';",
    "for (const [read, name] of [[dataDirOf, 'TYCHO_DATA'], [defaultPrefix, 'TYCHO_PREFIX']]) {",
    "  try { read({}, homedir()); process.exit(2); }",
    "  catch (error) { if (!error.message.includes(name)) throw error; }",
    "}",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    env: {},
    encoding: 'utf8',
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('a child whose home a test points elsewhere may use defaults there, never under the owner home', (t) => {
  const fake = mkdtempSync(join(tmpdir(), 'tycho-home-'));
  t.after(() => rmSync(fake, { recursive: true, force: true }));
  const code = [
    "import { dataDirOf } from './service/config.ts';",
    "import { defaultPrefix } from './cli/paths.ts';",
    "import { homedir } from 'node:os';",
    "for (const read of [dataDirOf, defaultPrefix]) {",
    "  if (!read({}, homedir()).startsWith(homedir())) process.exit(3);",
    "  try { read({}, " + JSON.stringify(homedir()) + "); process.exit(2); } catch (error) { if (!error.message.includes('测试里没有设')) throw error; }",
    "}",
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    env: { ...process.env, HOME: fake, USERPROFILE: fake, TYCHO_TEST_OWNER_HOME: fake },
    encoding: 'utf8',
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('promisified process creation keeps protection and its stdout/stderr result contract', async () => {
  const code = [
    "import { dataDirOf } from './service/config.ts';",
    "import { homedir } from 'node:os';",
    "try { dataDirOf({}, homedir()); process.exit(2); }",
    "catch (error) { if (!error.message.includes('TYCHO_DATA')) throw error; }",
    "process.stdout.write('guarded'); process.stderr.write('evidence');",
  ].join('\n');
  const result = await promisify(execFile)(process.execPath, ['--no-warnings', '--input-type=module', '--eval', code], {
    cwd: root,
    env: {},
    encoding: 'utf8',
  });
  assert.equal(result.stdout, 'guarded');
  assert.equal(result.stderr, 'evidence');
});

test('a plain helper that rebuilds env for its child cannot lose test isolation either', () => {
  const grandchild = [
    "import { dataDirOf } from './service/config.ts';",
    "import { defaultPrefix } from './cli/paths.ts';",
    "import { homedir } from 'node:os';",
    "for (const read of [dataDirOf, defaultPrefix]) {",
    "  try { read({}, homedir()); process.exit(2); } catch (error) { if (!error.message.includes('测试里没有设')) throw error; }",
    "}",
  ].join('\n');
  const helper = [
    "import { spawnSync } from 'node:child_process';",
    'const result = spawnSync(process.execPath, ' + JSON.stringify(['--input-type=module', '--eval', grandchild]) + ', { env: {}, encoding: "utf8" });',
    'if (result.error) throw result.error;',
    'process.stderr.write(result.stderr); process.exit(result.status ?? 1);',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', helper], { cwd: root, env: {}, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('clearing the inherited mark after imports cannot disable the guard', (t) => {
  const old = process.env.NODE_TEST_CONTEXT;
  const inherited = process.env.TYCHO_TEST_GUARD;
  t.after(() => {
    if (old === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = old;
    if (inherited === undefined) delete process.env.TYCHO_TEST_GUARD;
    else process.env.TYCHO_TEST_GUARD = inherited;
  });
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.TYCHO_TEST_GUARD;
  assert.throws(() => dataDirOf({}, homedir()), /TYCHO_DATA/);
  assert.throws(() => defaultPrefix({}, homedir()), /TYCHO_PREFIX/);
});
