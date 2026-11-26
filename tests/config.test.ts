// Guards against a start that needs anything but a data directory: a default that is a
// path on one particular machine, a directory that has to be made by hand, and a login
// link built on an address the browser cannot use.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { dataDirFromEnv, dataDirOf, loginUrl, prepareDataDir } from '../service/config.ts';

function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the data directory is TYCHO_DATA, and otherwise the same place under the home directory on every system', (t) => {
  const previous = process.env.TYCHO_DATA;
  t.after(() => {
    if (previous === undefined) delete process.env.TYCHO_DATA;
    else process.env.TYCHO_DATA = previous;
  });
  const elsewhere = join(tmpdir(), 'somewhere', 'else');
  process.env.TYCHO_DATA = elsewhere;
  assert.equal(dataDirFromEnv(), elsewhere);
  const home = temp(t);
  assert.equal(dataDirOf({}, home), join(home, '.tycho', 'host'));
  assert.equal(dataDirOf({ TYCHO_DATA: '' }, home), join(home, '.tycho', 'host'), '空的环境变量不是一个目录');
});

test('a data directory that is not there is made, parents included; one that is there is left alone', (t) => {
  const dir = temp(t);
  const nested = join(dir, 'a', 'b', 'host');
  assert.equal(prepareDataDir(nested), nested);
  assert.ok(statSync(nested).isDirectory());
  writeFileSync(join(nested, 'keep'), 'x');
  prepareDataDir(nested);
  assert.ok(existsSync(join(nested, 'keep')));
});

test('a file where the data directory should be is refused', (t) => {
  const file = join(temp(t), 'plain');
  writeFileSync(file, '');
  assert.throws(() => prepareDataDir(file));
});

test('a login link uses the public address when there is one and an address that works when not', () => {
  const path = '/login/x';
  assert.equal(loginUrl({ host: '127.0.0.1', publicUrl: 'http://10.0.0.2:8787' }, 8787, path), 'http://10.0.0.2:8787/login/x');
  assert.equal(loginUrl({ host: '127.0.0.1', publicUrl: '' }, 8787, path), 'http://127.0.0.1:8787/login/x');
  assert.equal(loginUrl({ host: '0.0.0.0', publicUrl: '' }, 9000, path), 'http://127.0.0.1:9000/login/x', '0.0.0.0 不是浏览器能打开的地址');
});

test('a relative TYCHO_DATA becomes the absolute directory it names where the caller stands', (t) => {
  // The rule is one function for the command and the service: a service manager starts
  // the service in another directory, where the same words would name another place.
  const given = join('some', 'data');
  assert.equal(dataDirOf({ TYCHO_DATA: given }, homedir()), resolve(given));
  assert.ok(isAbsolute(dataDirOf({ TYCHO_DATA: given }, homedir())));
  assert.ok(isAbsolute(dataDirOf({}, temp(t))));
});
