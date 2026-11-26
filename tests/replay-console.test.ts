// The Console may simulate a fixed rule case, never launch a Worker/model, make an
// HTTP/IM call, mutate the live ledger or load caller-selected code. Parallel runs
// and a source change must not produce a result under a misleading fixed basis.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createReplayConsole } from '../service/replay-console.ts';
import { InputError } from '../service/errors.ts';
import { fixture, USER } from './helpers.ts';

test('published fixed cases are independent copies and replay uses only isolated state with zero external calls', async t => {
  const f = fixture(t);
  const replay = createReplayConsole({ dataDir: f.dir });
  const catalog = replay.cases();
  assert.equal(catalog.family, 'ready-notice');
  assert.equal(catalog.cases.length, 8);
  assert.equal(catalog.cases.filter(item => item.split === 'release').length, 5);
  const input = structuredClone(catalog.cases[0]!);
  catalog.cases[0]!.case_id = 'changed';
  assert.notEqual(replay.cases().cases[0]!.case_id, 'changed');
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('external effect forbidden'); };
  t.mock.method(globalThis, 'fetch', forbidden);
  for (const owner of [http, https]) for (const key of ['request', 'get'] as const) t.mock.method(owner, key, forbidden);
  for (const key of ['spawn', 'spawnSync', 'exec', 'execFile', 'fork'] as const) t.mock.method(childProcess, key, forbidden);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const before = f.dump();
  const result = await replay.run(input);
  assert.equal(result.family, 'ready-notice');
  assert.equal(result.mode, 'isolated-rule-simulation');
  assert.deepEqual(result.input, input);
  assert.deepEqual(result.result.failures, []);
  assert.equal(result.result.external_effects, 0);
  assert.equal(result.external_effects, 0);
  assert.match(result.basis.source_digest, /^[0-9a-f]{64}$/);
  assert.ok(result.basis.source_files.includes('service/ledger.ts'));
  assert.ok(result.basis.source_files.includes('service/notify.ts'));
  assert.equal(typeof result.basis.version, 'string');
  assert.deepEqual(result.basis.baseline, { setting: 'router.directReadyNotice', value: false });
  assert.deepEqual(result.basis.candidate, { setting: 'router.directReadyNotice', value: true });
  assert.deepEqual(f.dump(), before);
  assert.equal(calls, 0);
});

test('draft export reads only the configured ledger and never exports prompts or accepts a draft as a runnable case', async t => {
  const f = fixture(t);
  const replay = createReplayConsole({ dataDir: f.dir });
  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'verify', title: 'private-title', goal: 'private-goal', acceptance: 'private-acceptance', onReady: 'notify_owner' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'operate', brief: 'private-brief' } }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: 'private-summary', artifacts: [{ kind: 'report', ref: '/private-path/report.md' }] });
  const before = f.dump();
  const draft = replay.draft(run.id, 'release');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.observed.role, 'verify');
  assert.doesNotMatch(JSON.stringify(draft), /private-|private\/|private-path/);
  assert.deepEqual(f.dump(), before);
  await assert.rejects(replay.run(draft), /草稿/);
  assert.throws(() => replay.draft(join(f.dir, 'ledger.db'), 'release'), InputError);
  assert.throws(() => replay.draft(run.id, 'invalid'), InputError);
  assert.throws(() => replay.draft({ runId: run.id, path: f.path }, 'release'), InputError);
  const ordinary = f.runningRun();
  f.ledger.settleRun(ordinary.run.id, 0, { status: 'done', summary: 'done', artifacts: [] });
  assert.throws(() => replay.draft(ordinary.run.id, 'release'), /验证职能/);
});

test('a request cannot select code, an executor or an external ledger and only one run occupies the instance', async t => {
  const replay = createReplayConsole({ dataDir: fixture(t).dir });
  const input = replay.cases().cases[0]!;
  for (const fields of [{ baseline: 'C:/foreign' }, { candidate: 'C:/foreign' }, { executor: 'real-model' }, { path: '/external/ledger.db' }]) {
    await assert.rejects(replay.run({ ...input, ...fields }), InputError);
  }
  const first = replay.run(input);
  await assert.rejects(replay.run(input), /正在/);
  assert.deepEqual((await first).result.failures, []);
  assert.deepEqual((await replay.run(input)).result.failures, []);
});

test('scratch failures release the run slot and a source change invalidates the reported basis', async t => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const replay = createReplayConsole({ dataDir: fixture(t).dir });
  const input = replay.cases().cases[0]!;
  const failed = t.mock.method(fs, 'mkdtempSync', () => { throw new Error('scratch unavailable'); });
  syncBuiltinESMExports();
  await assert.rejects(replay.run(input), /scratch unavailable/);
  failed.mock.restore(); syncBuiltinESMExports();
  let reads = 0;
  const original = fs.readFileSync;
  const changing = t.mock.method(fs, 'readFileSync', function (path: unknown, ...args: unknown[]) {
    const result = Reflect.apply(original, fs, [path, ...args]);
    if (String(path).replaceAll('\\', '/').endsWith('/service/replay-console.ts') && ++reads > 1) {
      return typeof result === 'string' ? result + '\n// concurrent source change' : Buffer.concat([result, Buffer.from('\n// concurrent source change')]);
    }
    return result;
  });
  syncBuiltinESMExports();
  await assert.rejects(replay.run(input), /代码.*变|程序.*变/);
  changing.mock.restore(); syncBuiltinESMExports();
  assert.deepEqual((await replay.run(input)).result.failures, []);
});

test('the packaged runtime runs without scripts, tests, fixtures or Git', async t => {
  const isolated = fs.mkdtempSync(join(tmpdir(), 'tycho-packaged-replay-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  const source = dirname(import.meta.dirname);
  for (const tree of ['adapters', 'channels', 'cli', 'node', 'runner', 'service', 'shared']) {
    fs.cpSync(join(source, tree), join(isolated, tree), { recursive: true });
  }
  fs.copyFileSync(join(source, 'package.json'), join(isolated, 'package.json'));
  const installed = await import(pathToFileURL(join(isolated, 'service/replay-console.ts')).href) as typeof import('../service/replay-console.ts');
  const replay = installed.createReplayConsole({ dataDir: isolated });
  assert.equal(fs.existsSync(join(isolated, 'tests')), false);
  assert.equal(fs.existsSync(join(isolated, 'scripts')), false);
  const result = await replay.run(replay.cases().cases[0]!);
  assert.deepEqual(result.result.failures, []);
  assert.equal(result.external_effects, 0);
  assert.ok(result.basis.source_files.every(file => !file.startsWith('tests/') && !file.startsWith('scripts/')));
});
