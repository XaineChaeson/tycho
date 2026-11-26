// Guards the watch process's side of a read-only round (docs/design/roles-and-tiers.md §5, §9
// step 6): a repository review round's code goes in a directory of its own, at the reviewed
// commit, a baseline is taken before the Worker starts, and the check is written before the
// exit code and reported with it.
//
// What this file is here to catch:
//   - a read-only review round unpacked into the Task's kept repo/ (what an earlier round left
//     there would be part of its baseline, and what it does would be left for the next), or the
//     Task's repo/ touched by it;
//   - the round's own code left on the machine after the check;
//   - a read-only round ending with no check reported beside its exit code;
//   - the check's record failing to be written taking the round's ending with it, or the round
//     reporting a check nobody wrote;
//   - a change the Worker made passing as unchanged, and an unchanged round reported changed;
//   - a read-only round with no code reporting anything but "no code";
//   - a writable round given a check it never had, or its repo/ moved;
//   - a snapshot from an old host, written without access.json, not run as the writable round it
//     was (its code kept out of the Task's repo/, or a check reported for it that nobody made).
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { HANDOVER_ENV } from '../node/client.ts';
import { boxOf, readExit, runState } from '../node/runbox.ts';
import { selectProcesses } from '../node/hostprocess.ts';
import { git, hasGit, repoAsBundle, scratchRepo } from './git-repo.ts';
import { runId } from './helpers.ts';

const FAKE = join(import.meta.dirname, 'fake-executor.mjs');
const WATCH = join(import.meta.dirname, '..', 'node', 'watch.ts');
const noGit = hasGit() ? false : '这台机器上没有可用的 git';
const run = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`r${i + 1}`, runId(`watch-ro-r${i + 1}`)])) as Record<`r${number}`, string>;

function machine(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-watch-ro-'));
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
    box: (task: string, id: string) => boxOf(dataDir, `tasks/${task}/runs/${id}`),
    start(task: string, id: string, env: Record<string, string> = {}) {
      const child = spawn(process.execPath, [WATCH, `--data=${dataDir}`, `--run=tasks/${task}/runs/${id}`, '--round=1', '--', process.execPath, FAKE], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...env, [HANDOVER_ENV]: '{}' },
      });
      return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });
    },
  };
}

// A round's snapshot as the host writes it: the brief, the permission, and the source when
// it has any. A read-only round of a repository works in a checkout of its own — at the commit
// it names, or at the clone's own HEAD when it names none; a writable round works in the
// Task's kept checkout for the source it names.
function snapshot(t: TestContext, m: ReturnType<typeof machine>, task: string, id: string, permission: 'read' | 'write', code = true, commit = permission === 'read') {
  const box = m.box(task, id);
  const dir = join(box.runDir, 'snapshot');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.md'), '# 只读的一轮\n');
  writeFileSync(join(dir, 'access.json'), `${JSON.stringify({ permission })}\n`);
  if (!code) return { box, base: '' };
  const repo = scratchRepo(t);
  writeFileSync(join(repo.dir, '.gitignore'), '*.log\n');
  const base = repo.commit('src.txt', '源代码\n');
  // The address a sandboxed machine can clone: the repository as one file (git's local-path
  // clone goes through a shell this sandbox denies).
  const url = repoAsBundle(repo.dir, join(mkdtempSync(join(tmpdir(), 'tycho-src-')), 'source.bundle'));
  writeFileSync(join(dir, 'source.json'), `${JSON.stringify({ kind: 'repo', url, binding_key: 's-one', ...(commit ? { commit: base } : {}) })}\n`);
  return { box, base };
}

// A folder source's snapshot: the folder as the machine has it, on the machine's own disk.
function folderSnapshot(m: ReturnType<typeof machine>, task: string, id: string, path: string) {
  const box = m.box(task, id);
  const dir = join(box.runDir, 'snapshot');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.md'), '# 只读的一轮\n');
  writeFileSync(join(dir, 'access.json'), `${JSON.stringify({ permission: 'read' })}\n`);
  writeFileSync(join(dir, 'source.json'), `${JSON.stringify({ kind: 'folder', path, binding_key: 'f-one' })}\n`);
  return box;
}

const ended = async (box: ReturnType<typeof boxOf>) => runState(box, selectProcesses());
// The check as the watch wrote it: the evidence itself, which is what the host reads beside
// the exit code. Read from the file rather than through runState, whose answer about a round
// is "unknown" on a machine that cannot read its own process table (nodes.md §4.3).
const checkOf = (box: ReturnType<typeof boxOf>): { result: string; changes?: string[] } =>
  JSON.parse(readFileSync(join(box.procDir, 'code-check'), 'utf8')) as { result: string; changes?: string[] };

test('只读的一轮：代码解在这一轮自己的目录，不碰任务保留的副本，没改就报“代码没变”，核对完删掉', { skip: noGit }, async (t) => {
  const m = machine(t);
  const { box } = snapshot(t, m, 't1', run.r1, 'read');
  // What an earlier round of the Task left: not this round's code, and not touched by it.
  mkdirSync(join(box.taskDir, 's-one'), { recursive: true });
  writeFileSync(join(box.taskDir, 's-one', '上一轮的.txt'), '留着');
  // Output the repository ignores, written into the round's own code: no change.
  assert.equal(await m.start('t1', run.r1, { TYCHO_FAKE_TOUCH: 'test.log' }), 0);
  assert.equal(readExit(box), 0);
  assert.deepEqual(checkOf(box), { result: 'same' });
  assert.equal(existsSync(join(box.runDir, 'repo')), false, '核对完这一轮自己的代码就删了');
  assert.equal(readFileSync(join(box.taskDir, 's-one', '上一轮的.txt'), 'utf8'), '留着', '任务保留的副本没被碰');
});

test('只读的一轮改了代码：如实记录 advisory 的 result 与 changes（不触发主机拒收），watch.log 记下改动详情', { skip: noGit }, async (t) => {
  const m = machine(t);
  const { box } = snapshot(t, m, 't2', run.r2, 'read');
  assert.equal(await m.start('t2', run.r2, { TYCHO_FAKE_TOUCH: 'made.txt' }), 0);
  assert.equal(readExit(box), 0);
  const check = checkOf(box);
  assert.deepEqual(check, { result: 'changed', changes: ['?? made.txt'] });
  assert.match(readFileSync(join(box.runDir, 'watch.log'), 'utf8'), /代码核对（仅提示）：changed：\?\?\s+made\.txt/);
  assert.ok(existsSync(join(box.procDir, 'code-check')), '核对记录在机器自己的证据目录里');
  assert.equal(existsSync(join(box.runDir, 'repo')), false);
});

test('可写的一轮：副本留在任务的来源目录里，没有核对记录', { skip: noGit }, async (t) => {
  const m = machine(t);
  const { box, base } = snapshot(t, m, 't4', run.r4, 'write');
  assert.equal(await m.start('t4', run.r4), 0);
  assert.equal(git(['-C', join(box.taskDir, 's-one'), 'rev-parse', 'HEAD']).out.trim(), base);
  assert.equal((await ended(box)).code_check, undefined);
  assert.equal(existsSync(join(box.runDir, 'repo')), false);
});

test('旧主机写的快照没有 access.json：带代码时照可写跑，没有核对记录', { skip: noGit }, async (t) => {
  const m = machine(t);
  const { box, base } = snapshot(t, m, 't6', run.r6, 'write');
  rmSync(join(box.runDir, 'snapshot', 'access.json'));
  assert.equal(await m.start('t6', run.r6), 0);
  assert.equal(git(['-C', join(box.taskDir, 's-one'), 'rev-parse', 'HEAD']).out.trim(), base);
  assert.equal((await ended(box)).code_check, undefined);
  assert.equal(existsSync(join(box.runDir, 'repo')), false);
});

// §5 with §8.7: a read-only round with no commit named is still not the Task's kept checkout.// Reusing it would make what an earlier round left (uncommitted work, a refused change) part
// of this round's baseline, and the second round would report `same` for a change the first
// one made.
test('只读的一轮没说要检出哪个提交：也用自己的干净副本，不拿任务保留的那份当基线', { skip: noGit }, async (t) => {
  const m = machine(t);
  // A writable round first: the Task's kept copy for this source is a real checkout.
  const { box } = snapshot(t, m, 't8', run.r12, 'write');
  assert.equal(await m.start('t8', run.r12), 0);
  const kept = join(box.taskDir, 's-one');
  assert.equal(existsSync(join(kept, '.git')), true, '可写的一轮把副本留在任务的来源目录里');
  // What that round left there, uncommitted: a read-only round must not find it in its code.
  writeFileSync(join(kept, 'outside.txt'), '上一轮留下的');
  // The read-only round of the same source, naming no commit: it gets a clone of its own.
  const read = snapshot(t, m, 't8', run.r13, 'read', true, false);
  assert.equal(await m.start('t8', run.r13), 0);
  assert.deepEqual(checkOf(read.box), { result: 'same' }, '对着自己的干净副本核对，越界的修改不在里面');
  assert.equal(git(['-C', kept, '-c', 'core.quotePath=false', 'status', '--porcelain']).out.includes('outside.txt'), true, '任务保留的那份没被这一轮碰过');
  assert.equal(existsSync(join(read.box.runDir, 'repo')), false, '这一轮自己的副本核对完就删');
});

test('只读的一轮没有代码：报“没有代码”', async (t) => {
  const m = machine(t);
  const { box } = snapshot(t, m, 't3', run.r3, 'read', false);
  assert.equal(await m.start('t3', run.r3), 0);
  assert.deepEqual(checkOf(box), { result: 'no-code' });
});

// A folder source is not tycho's and is never checked; a read-only round reads its HEAD and
// `git status --porcelain` before and after the Worker and reports the difference as
// information only (docs/design/code-sources.md §8.1, §8.2).
test('文件夹来源的只读一轮：报这一轮期间目录有没有变，且不往目录里写任何东西', { skip: noGit }, async (t) => {
  const m = machine(t);
  const folder = scratchRepo(t);
  // What the owner has already modified when the round begins: not the round's doing, and not
  // a difference between what this round read first and what it read last.
  writeFileSync(join(folder.dir, '之前就改过的.txt'), '主人自己改的');
  const index = join(folder.dir, '.git', 'index');
  const before = statSync(index);
  const box = folderSnapshot(m, 't9', run.r8, folder.dir);
  assert.equal(await m.start('t9', run.r8), 0);
  assert.deepEqual(checkOf(box), { result: 'no-code', folder_change: { changed: false } }, '开始和结束读到的 HEAD 和 status 一样');
  // The reading writes nothing into the folder: the index it found is the index it left, byte
  // for byte and moment for moment.
  const after = statSync(index);
  assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs], '读 HEAD 和 status 没有刷新主人目录的 index');
  assert.deepEqual(readdirSync(folder.dir).sort(), ['.git', 'README.md', '之前就改过的.txt'], 'tycho 没往这个文件夹里放东西');

  // And one the Worker does change, in a round of its own.
  const changed = folderSnapshot(m, 't10', run.r9, folder.dir);
  assert.equal(await m.start('t10', run.r9, { TYCHO_FAKE_TOUCH: '这一轮写的.txt' }), 0);
  assert.deepEqual(checkOf(changed), { result: 'no-code', folder_change: { changed: true } });
});

test('文件夹来源的只读一轮：目录不是 git 仓库时，报读不出来，不当成“没变化”', async (t) => {
  const m = machine(t);
  const folder = mkdtempSync(join(tmpdir(), 'tycho-plain-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'x.txt'), 'x');
  const box = folderSnapshot(m, 't11', run.r10, folder);
  assert.equal(await m.start('t11', run.r10), 0);
  const check = checkOf(box);
  assert.equal(check.result, 'no-code');
  assert.equal((check as { folder_change?: { changed: boolean; why?: string } }).folder_change?.changed, false);
  assert.match(String((check as { folder_change?: { why?: string } }).folder_change?.why), /读不出这个文件夹的 HEAD/);
});

// The record is evidence of the check, not the round: one that cannot be written leaves the
// round ended with its code and no check beside it, which the host reads as a check it cannot
// vouch for (node/code-check.ts) — never as a round that never ended.
test('核对记录写不下：这一轮照样结束，也不报核对', { skip: noGit }, async (t) => {
  const m = machine(t);
  const { box } = snapshot(t, m, 't7', run.r7, 'read');
  // The temporary name the record is written under is a directory: the write cannot land.
  mkdirSync(join(box.procDir, 'code-check.tmp'), { recursive: true });
  assert.equal(await m.start('t7', run.r7), 0);
  assert.equal(readExit(box), 0, '记录没写下，这一轮还是结束了');
  const state = await ended(box);
  assert.equal(state.exit, 0, '机器读到的也是这个结束');
  assert.equal('code_check' in state, false, '没人写下的核对不报');
});

test('权限写坏了：这一轮不开工，理由写在 stderr.log', async (t) => {
  const m = machine(t);
  const { box } = snapshot(t, m, 't5', run.r5, 'read', false);
  writeFileSync(join(box.runDir, 'snapshot', 'access.json'), '{坏了');
  assert.equal(await m.start('t5', run.r5), 2);
  assert.match(readFileSync(join(box.runDir, 'stderr.log'), 'utf8'), /access\.json/);
  assert.equal(existsSync(join(box.runDir, 'stdout.ndjson')), false, 'Worker 没有被起来');
});
