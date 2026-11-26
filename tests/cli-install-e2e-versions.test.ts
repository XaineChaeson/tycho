// Guards the release Node requirement and refusal of invalid versions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './cli-helpers.ts';
import { hostileArchives } from './cli-tar.ts';
import type { Hostile } from './cli-tar.ts';
import { WINDOWS, sandbox, variant, sharedArchive } from './cli-install-e2e-fixture.ts';

// ---- Which Node will do is the release's to say ----

const [NODE_MAJOR, NODE_MINOR, NODE_PATCH] = process.versions.node.split('.').map(Number) as [number, number, number];

test('最低 Node 版本取自发布包：主、次、修订都比；PATH 里的 Node 低一个修订号也不用', async (t) => {
  const s = sandbox(t);
  const archive = sharedArchive(t);

  // Exactly the Node on PATH, and a requirement with parts left out: both accepted.
  const exact = await s.install(variant(s.dir, archive, '91.0.0', `>=${NODE_MAJOR}.${NODE_MINOR}.${NODE_PATCH}`));
  assert.equal(exact.code, 0, exact.stdout + exact.stderr);
  const short = await s.install(variant(s.dir, archive, '91.0.1', `>=${NODE_MAJOR}`));
  assert.equal(short.code, 0, short.stdout + short.stderr);
  assert.equal(existsSync(join(s.prefix, 'node')), false);
  assert.equal(readFileSync(join(s.prefix, 'current'), 'utf8'), '91.0.1');

  // One patch release short: not used. With nowhere to download from, the install stops
  // and says what it was looking for.
  const above = `${NODE_MAJOR}.${NODE_MINOR}.${NODE_PATCH + 1}`;
  const refused = await s.install(variant(s.dir, archive, '91.0.2', `>=${above}`));
  assert.notEqual(refused.code, 0, refused.stdout + refused.stderr);
  assert.ok((refused.stdout + refused.stderr).includes(above), refused.stdout + refused.stderr);
  assert.equal(readFileSync(join(s.prefix, 'current'), 'utf8'), '91.0.1');
  assert.deepEqual(s.versions(), ['91.0.0', '91.0.1']);
});

test('发布包没说要哪个 Node，或说法看不懂：停下并说明，不猜', async (t) => {
  const s = sandbox(t);
  const archive = sharedArchive(t);
  for (const [version, node] of [['92.0.0', null], ['92.0.1', '^24.0.0'], ['92.0.2', '>=24.x']] as const) {
    const ran = await s.install(variant(s.dir, archive, version, node));
    assert.notEqual(ran.code, 0, String(node));
    assert.match(ran.stdout + ran.stderr, /engines\.node/, String(node));
    assert.equal(existsSync(join(s.prefix, 'current')), false);
    assert.deepEqual(s.versions(), []);
  }
});
