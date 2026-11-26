import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { boxOf } from '../node/runbox.ts';
import { mirrorDirOf, prepareSource } from '../node/source.ts';
import { git, hasGit, scratchRepo } from './git-repo.ts';

const noGit = hasGit() ? false : '这台机器上没有可用的 git';

function writeSnapshotSource(dataDir: string, taskId: string, runId: string, source: Record<string, unknown>) {
  const box = boxOf(dataDir, `tasks/${taskId}/runs/${runId}`);
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'source.json'), JSON.stringify(source));
  return box;
}

test('shared bare mirror pool caches repo across tasks, updates on fetch, and stays intact after read-only checkout deletes origin', { skip: noGit }, (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-mirror-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const upstream = scratchRepo(t);
  const firstCommit = upstream.commit('a.txt', 'v1');

  // Task 1 writable clone creates the shared bare mirror
  const box1 = writeSnapshotSource(dataDir, 'task-1', 'run-1', {
    kind: 'repo',
    url: upstream.dir,
    binding_key: 'bind-1',
  });
  const prep1 = prepareSource(box1, false);
  assert.equal(typeof prep1, 'object', `expected prepared source, got: ${String(prep1)}`);
  const dir1 = (prep1 as { cwd: string }).cwd;
  assert.equal(git(['-C', dir1, 'rev-parse', 'HEAD']).out.trim(), firstCommit);

  const mirrorDir = mirrorDirOf(box1, upstream.dir);
  assert.ok(existsSync(join(mirrorDir, 'HEAD')), 'bare mirror created under dataDir/repo-mirrors');
  assert.equal(existsSync(join(dir1, '.git', 'objects', 'info', 'alternates')), false, '--dissociate detaches checkout from mirror alternates');
  assert.equal(existsSync(`${mirrorDir}.lock`), false, 'mirror lock cleaned up after ensureMirror');

  // Upstream receives a second commit; Task 2 reuses & fetches mirror
  const secondCommit = upstream.commit('b.txt', 'v2');
  const box2 = writeSnapshotSource(dataDir, 'task-2', 'run-2', {
    kind: 'repo',
    url: upstream.dir,
    binding_key: 'bind-1',
  });
  const prep2 = prepareSource(box2, false);
  assert.equal(typeof prep2, 'object');
  const dir2 = (prep2 as { cwd: string }).cwd;
  assert.equal(git(['-C', dir2, 'rev-parse', 'HEAD']).out.trim(), secondCommit);

  // Read-only ownCheckout uses mirror, strips its own origin, and removing own does not harm mirror
  const box3 = writeSnapshotSource(dataDir, 'task-3', 'run-3', {
    kind: 'repo',
    url: upstream.dir,
    binding_key: 'bind-1',
    commit: firstCommit,
  });
  const prep3 = prepareSource(box3, true);
  assert.equal(typeof prep3, 'object');
  const ownDir = (prep3 as { cwd: string }).cwd;
  assert.equal(git(['-C', ownDir, 'rev-parse', 'HEAD']).out.trim(), firstCommit);
  assert.notEqual(git(['-C', ownDir, 'remote', 'get-url', 'origin']).code, 0, 'ownCheckout has no origin');

  // Removing read-only checkout leaves mirror completely intact with its origin
  rmSync(ownDir, { recursive: true, force: true });
  assert.equal(git(['-C', mirrorDir, 'remote', 'get-url', 'origin']).out.trim(), upstream.dir);
  assert.equal(git(['-C', mirrorDir, 'rev-parse', 'HEAD']).out.trim(), secondCommit);
});

test('corrupted mirror silently falls back to direct git clone without regression', { skip: noGit }, (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-mirror-fallback-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const upstream = scratchRepo(t);
  const head = upstream.commit('ok.txt', 'hello');

  const box = writeSnapshotSource(dataDir, 'task-fb', 'run-fb', {
    kind: 'repo',
    url: upstream.dir,
    binding_key: 'bind-fb',
  });
  // Place a broken file at the mirror path so mirror creation/fetch fails
  const mirrorDir = mirrorDirOf(box, upstream.dir);
  mkdirSync(join(mirrorDir, '..'), { recursive: true });
  writeFileSync(mirrorDir, 'corrupted-not-a-git-dir');

  const prep = prepareSource(box, false);
  assert.equal(typeof prep, 'object', `expected fallback clone to succeed, got: ${String(prep)}`);
  const dir = (prep as { cwd: string }).cwd;
  assert.equal(git(['-C', dir, 'rev-parse', 'HEAD']).out.trim(), head);
  assert.equal(git(['-C', dir, 'remote', 'get-url', 'origin']).out.trim(), upstream.dir);
});

test('dissociated checkout survives mirror deletion, ownCheckout preserves git checkout error words, and mirror lock handles busy + stale locks', { skip: noGit }, (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-mirror-bugs-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const upstream = scratchRepo(t);
  const head = upstream.commit('main.txt', 'hello world');

  // 1. Dissociated checkout owns its objects independently even if the mirror is later deleted/GC'd
  const box1 = writeSnapshotSource(dataDir, 'task-dissoc', 'run-1', {
    kind: 'repo',
    url: upstream.dir,
    binding_key: 'bind-1',
  });
  const prep1 = prepareSource(box1, false);
  assert.equal(typeof prep1, 'object');
  const dir1 = (prep1 as { cwd: string }).cwd;
  const mirrorDir = mirrorDirOf(box1, upstream.dir);
  rmSync(mirrorDir, { recursive: true, force: true });
  assert.equal(git(['-C', dir1, 'fsck', '--full']).code, 0, 'checkout remains intact after mirror deletion');
  assert.equal(git(['-C', dir1, 'rev-parse', 'HEAD']).out.trim(), head);

  // 2. ownCheckout preserves git stderr words when requested commit does not exist
  const badSha = 'deadbeef'.repeat(5);
  const boxBad = writeSnapshotSource(dataDir, 'task-bad-sha', 'run-2', {
    kind: 'repo',
    url: upstream.dir,
    binding_key: 'bind-2',
    commit: badSha,
  });
  const badResult = prepareSource(boxBad, true);
  assert.equal(typeof badResult, 'string');
  assert.match(badResult as string, new RegExp(`签不出提交 ${badSha}：.+`, 's'), `expected git error words in: ${String(badResult)}`);

  // 3. Busy (fresh) mirror lock falls back gracefully to direct clone without removing lock
  const lockPath = `${mirrorDir}.lock`;
  mkdirSync(join(mirrorDir, '..'), { recursive: true });
  writeFileSync(lockPath, '99999\n');
  const boxBusy = writeSnapshotSource(dataDir, 'task-busy-lock', 'run-3', {
    kind: 'repo',
    url: upstream.dir,
    binding_key: 'bind-3',
  });
  const prepBusy = prepareSource(boxBusy, false);
  assert.equal(typeof prepBusy, 'object', 'busy lock falls back cleanly to direct clone');
  assert.equal(existsSync(lockPath), true, 'fresh lock owned by another round is left untouched');

  // 4. Stale mirror lock (> 120s old) is reclaimed, mirror is refreshed, and lock is removed afterwards
  const staleDate = new Date(Date.now() - 180_000);
  utimesSync(lockPath, staleDate, staleDate);
  const head2 = upstream.commit('after-stale.txt', 'v2');
  const boxStale = writeSnapshotSource(dataDir, 'task-stale-lock', 'run-4', {
    kind: 'repo',
    url: upstream.dir,
    binding_key: 'bind-4',
  });
  const prepStale = prepareSource(boxStale, false);
  assert.equal(typeof prepStale, 'object');
  assert.equal(git(['-C', (prepStale as { cwd: string }).cwd, 'rev-parse', 'HEAD']).out.trim(), head2);
  assert.equal(existsSync(lockPath), false, 'reclaimed stale lock is cleaned up on exit');
});
