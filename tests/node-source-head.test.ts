// Guards what a round's machine reads of the code it ran on (docs/design/code-sources.md §8
// 第 4、6 条): the remote branch head of a repository round, a folder's HEAD, and the HEAD the
// round began from. The machine is the one with the repository's access, so this is read here
// and reported with the round's state; the host never asks a remote itself.
//
// What this file is here to catch:
//   - a round that names a source and reports nothing about it, so that the host has no commit
//     to bind a review to and no start for a Task;
//   - a working copy whose HEAD cannot be read (a folder that is not a repository) reported as
//     a commit, or as no source at all;
//   - a repository the machine's own environment points git at read as the one this round was
//     handed (`GIT_DIR`, `GIT_WORK_TREE` and the rest of Git's repository-location variables);
//   - a remote that could not be read reported as a head, or its failure dropped instead of
//     said in the machine's own words;
//   - the round's own record overwritten by a later reading, or read as absent when it is
//     there and malformed.
//
// `git ls-remote` cannot complete in this sandbox (its upload-pack child cannot name its own
// objects), so the answer's parsing is exercised on its own and the live command only on its
// failure: what the remote answered is read by readRemoteHead either way.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { HANDOVER_ENV } from '../node/client.ts';
import { selectProcesses } from '../node/hostprocess.ts';
import { boxOf, runState, writeExit, writeLeft, type RunBox } from '../node/runbox.ts';
import { beginRound, endRound, readRemoteHead, readSourceHead, writeSourceHead } from '../node/source-head.ts';
import { git, hasGit, scratchRepo } from './git-repo.ts';

const FAKE = join(import.meta.dirname, 'fake-executor.mjs');
const WATCH = join(import.meta.dirname, '..', 'node', 'watch.ts');
const noGit = hasGit() ? false : '这台机器上没有可用的 git';
const HEAD = 'a'.repeat(40);
const START = '0'.repeat(40);

function machine(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-source-head-'));
  t.after(async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200);
      }
    }
  });
  return {
    dataDir,
    box: (task: string, id: string): RunBox => boxOf(dataDir, `tasks/${task}/runs/${id}`),
    // One round, in the round's own watch process: what the machine reads is written by it.
    start(task: string, id: string): Promise<number> {
      const child = spawn(process.execPath, [WATCH, `--data=${dataDir}`, `--run=tasks/${task}/runs/${id}`, '--round=1', '--', process.execPath, FAKE], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, [HANDOVER_ENV]: '{}' },
      });
      return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });
    },
  };
}

// What the host writes into a round's snapshot: the brief, the permission, and where the code
// comes from (runner/snapshot.ts source.json; node/source.ts prepares the working directory).
function snapshot(box: RunBox, source: unknown, permission: 'read' | 'write' = 'write'): void {
  const dir = join(box.runDir, 'snapshot');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.md'), '# 做点事\n');
  writeFileSync(join(dir, 'access.json'), `${JSON.stringify({ permission })}\n`);
  if (source !== undefined) writeFileSync(join(dir, 'source.json'), `${JSON.stringify(source)}\n`);
}

test('the remote branch head is the one line that names the branch, and nothing else', () => {
  const B = 'b'.repeat(40);
  const out = `1111111111111111111111111111111111111111\trefs/heads/main\n${B}\trefs/heads/other\n`;
  assert.deepEqual(readRemoteHead(out, 'main'), { head: '1'.repeat(40), problem: null });
  assert.deepEqual(readRemoteHead(out, 'other'), { head: B, problem: null });
  // A tag, a similarly named branch, or nothing at all is not this branch's head.
  assert.match(readRemoteHead(`${HEAD}\trefs/heads/main-2\n`, 'main').problem!, /没有 `main` 这条分支/);
  assert.match(readRemoteHead(`${HEAD}\trefs/tags/main\n`, 'main').problem!, /没有 `main` 这条分支/);
  assert.match(readRemoteHead('', 'main').problem!, /没有 `main` 这条分支/);
  // An answer that is not a commit is said as it is, never read as one.
  assert.match(readRemoteHead(`not-a-sha\trefs/heads/main\n`, 'main').problem!, /不是一个提交号/);
  assert.match(readRemoteHead(`${HEAD.slice(0, 8)}\trefs/heads/main\n`, 'main').problem!, /不是一个提交号/);
});

test('a repository round reports the clone it began in and the remote head it stands on', { skip: noGit }, (t) => {
  const m = machine(t);
  const box = m.box('t1', 'r1');
  snapshot(box, { kind: 'repo', url: 'https://example.test/r.git', binding_key: 's1' });
  // What the watch prepared: the Task's kept clone (node/source.ts), under the source's own
  // directory. A clone cannot be made in this sandbox (git reaches it through a shell that cannot
  // start here), so the working copy is made where it would stand.
  const dir = join(box.taskDir, 's1');
  mkdirSync(dir, { recursive: true });
  const at = (args: string[]) => git(args, dir);
  assert.equal(at(['init', '-q', '.']).code, 0);
  assert.equal(at(['symbolic-ref', 'HEAD', 'refs/heads/main']).code, 0);
  at(['config', 'user.email', 'w@example.test']);
  at(['config', 'user.name', 'w']);
  writeFileSync(join(dir, 'a.txt'), '改之前');
  assert.equal(at(['add', '-A']).code, 0);
  assert.equal(at(['commit', '-qm', 'one']).code, 0);
  const began = beginRound(box);
  assert.deepEqual([began?.head, began?.branch], [at(['rev-parse', 'HEAD']).out.trim(), 'main']);
  // The round works on: what it stands on at the end is not where it began.
  writeFileSync(join(dir, 'a.txt'), '改之后');
  assert.equal(at(['add', '-A']).code, 0);
  assert.equal(at(['commit', '-qm', 'two']).code, 0);
  endRound(box, began);
  const record = readSourceHead(box);
  assert.equal(record?.kind, 'repo');
  assert.equal(record?.head, at(['rev-parse', 'HEAD']).out.trim(), '结束时报的是现在站着的提交');
  assert.equal(record?.branch, 'main');
  assert.equal(record?.start, began?.head, '起点是这一轮开工时读到的 HEAD');
  // The remote cannot be reached from this sandbox: the failure is said in the machine's words,
  // and nothing is reported as a head.
  assert.equal(record?.remote_head, null);
  assert.ok((record?.problem ?? '').length > 0, '问不到远端时要说清');
});

test('a folder round reports its HEAD and says so when the folder is not a repository', { skip: noGit }, (t) => {
  const m = machine(t);
  const repo = scratchRepo(t);
  const box = m.box('t2', 'r2');
  snapshot(box, { kind: 'folder', path: repo.dir, binding_key: 'f1' });
  const began = beginRound(box);
  endRound(box, began);
  assert.deepEqual(readSourceHead(box), { kind: 'folder', head: repo.head(), branch: 'main', start: repo.head() });
  // The same round on a folder that is not a repository: a HEAD nobody can read, said as such.
  const plain = join(mkdtempSync(join(tmpdir(), 'tycho-plain-')), 'folder');
  mkdirSync(plain, { recursive: true });
  const other = m.box('t3', 'r3');
  snapshot(other, { kind: 'folder', path: plain, binding_key: 'f2' });
  endRound(other, beginRound(other));
  const record = readSourceHead(other);
  assert.deepEqual([record?.kind, record?.head, record?.start], ['folder', null, null]);
  assert.match(record?.problem ?? '', /读不出工作目录的 HEAD/);
});

test('a round with no source reports nothing about code', (t) => {
  const m = machine(t);
  const box = m.box('t4', 'r4');
  snapshot(box, undefined);
  assert.equal(beginRound(box), null);
  endRound(box, null);
  assert.equal(readSourceHead(box), null);
});

test('a code source that cannot be read is not reported as no source', (t) => {
  const m = machine(t);
  const box = m.box('t5', 'r5');
  snapshot(box, undefined);
  writeFileSync(join(box.runDir, 'snapshot', 'source.json'), '{坏了');
  assert.equal(beginRound(box), null);
  endRound(box, null);
  assert.equal(readSourceHead(box), null, '读不出来的来源不猜它的种类，报“机器没有报”');
});

test('the record is this machine\'s own, and one that is there and malformed is not "nothing"', (t) => {
  const m = machine(t);
  const box = m.box('t6', 'r6');
  writeSourceHead(box, { kind: 'repo', head: HEAD, branch: 'main', remote_head: HEAD, start: START });
  assert.deepEqual(readSourceHead(box), { kind: 'repo', head: HEAD, branch: 'main', remote_head: HEAD, start: START });
  writeFileSync(join(box.procDir, 'source-head'), '{不是\n');
  const broken = readSourceHead(box);
  assert.equal(broken?.head, null);
  assert.match(broken?.problem ?? '', /内容不对/);
});

test('the round state carries what the machine read, so the host needs to ask nobody else', async (t) => {
  const box = machine(t).box('t7', 'r7');
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeExit(box, 0);
  writeLeft(box, 'none');
  writeSourceHead(box, { kind: 'repo', head: HEAD, branch: 'main', remote_head: HEAD, start: START });
  const state = await runState(box, selectProcesses());
  assert.deepEqual(state.source_head, { kind: 'repo', head: HEAD, branch: 'main', remote_head: HEAD, start: START });
  assert.equal(state.exit, 0);
  // A record nobody wrote is absent, not an empty one.
  const quiet = machine(t).box('t8', 'r8');
  mkdirSync(join(quiet.runDir, 'started'), { recursive: true });
  writeExit(quiet, 0);
  writeLeft(quiet, 'none');
  assert.equal('source_head' in (await runState(quiet, selectProcesses())), false);
});

test('a folder round reads the folder it was handed, not one the environment points git at', { skip: noGit }, (t) => {
  const m = machine(t);
  const mine = scratchRepo(t);
  const other = scratchRepo(t, 'other');
  other.commit('other.txt', '别的仓库');
  // Read before the environment is polluted: the test's own git helper inherits it too.
  const mineHead = mine.head();
  const otherHead = other.head();
  assert.notEqual(mineHead, otherHead, '两个仓库的 HEAD 不一样，读错就看得出来');
  const before = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(other.dir, '.git');
  process.env.GIT_WORK_TREE = other.dir;
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const box = m.box('t10', 'r10');
  snapshot(box, { kind: 'folder', path: mine.dir, binding_key: 'f3' });
  const began = beginRound(box);
  assert.equal(began?.head, mineHead, '读的是这一轮的文件夹，不是环境里那个仓库');
  endRound(box, began);
  assert.deepEqual(readSourceHead(box), { kind: 'folder', head: mineHead, branch: 'main', start: mineHead });
});

test('a folder round run by the watch reads the folder it stood in when it began and when it ended', { skip: noGit }, async (t) => {
  const m = machine(t);
  const repo = scratchRepo(t);
  const box = m.box('t9', 'r9');
  snapshot(box, { kind: 'folder', path: repo.dir, binding_key: 'f1' });
  assert.equal(await m.start('t9', 'r9'), 0, '这一轮跑完了');
  // The watch writes the record before the exit code, as it does the read-only check; the state
  // carries it once the round is settled (node/runbox.ts), which needs a process table this
  // sandbox cannot give — so the report with the state is exercised above, and this is what the
  // round's own machine wrote.
  assert.deepEqual(readSourceHead(box), { kind: 'folder', head: repo.head(), branch: 'main', start: repo.head() });
  assert.equal(git(['-C', repo.dir, 'status', '--porcelain']).out.trim(), '', '只读地看，没有往文件夹里写东西');
});
