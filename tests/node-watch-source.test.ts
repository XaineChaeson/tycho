// Guards the code a round is handed from its Task's pinned source, and what the machine does
// with it (docs/design/code-sources.md §2, §8.11):
//   - a repository source: the machine clones it itself into tasks/<task>/<binding_key>/, and
//     the Worker works there; a later round of the same source reuses that copy without
//     resetting it or cloning again, keeping what the round before left and its own git config;
//   - a clone that fails: the round does not start, and git's own words (unsecreted and
//     shortened) are the reason, with no half a copy left behind;
//   - two sources: each has a copy of its own, and the same source id pointed at another
//     address is a new binding with a copy of its own (shared/sources.ts bindingKey);
//   - a folder source: checked as it stands, the Worker works in it, and tycho writes nothing;
//   - a round with no source at all: the Worker works in the empty Task directory;
//   - a review round: a checkout of its own at the reviewed commit, no origin, removed after
//     the check;
//   - and the placeholder substitution the Worker's command line goes through.
import './guard.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readExit, readLeft } from '../node/runbox.ts';
import { shownGitWords } from '../node/source.ts';
import { fillPlaces } from '../node/watch.ts';
import { bindingKey } from '../shared/sources.ts';
import { git, scratchRepo } from './git-repo.ts';
import { machine, noGit, run, sourceUrl, withSource } from './node-watch-fixture.ts';
test('repo 来源：机器自己 clone 到任务目录里按来源编号命名的目录，Worker 就在那里开工', { skip: noGit }, async (t) => {
  const m = machine(t);
  const repo = scratchRepo(t);
  const base = repo.commit('second.txt', '第二个提交');
  const url = sourceUrl(t, repo.dir);
  const box = withSource(t, m, 't1', run.r7, { kind: 'repo', url, binding_key: 's-one' });
  assert.equal(await m.start('t1', run.r7, 1, { env: { TYCHO_FAKE_TOUCH: 'cwd.txt' } }), 0);
  const tree = join(box.taskDir, 's-one');
  assert.equal(git(['-C', tree, 'rev-parse', 'HEAD']).out.trim(), base, '机器上的副本是仓库克隆来的');
  assert.equal(git(['-C', tree, 'remote', 'get-url', 'origin']).out.trim(), url, 'origin 是克隆自己的那一份');
  assert.ok(existsSync(join(tree, 'cwd.txt')), 'Worker 的工作目录就是这份副本');
});

test('接着上一轮做：已经在的副本不重置、不重新克隆，上一轮的工作和它的 git 配置都还在', { skip: noGit }, async (t) => {
  const m = machine(t);
  const repo = scratchRepo(t);
  const base = repo.commit('second.txt', '第二个提交');
  const url = sourceUrl(t, repo.dir);
  const source = { kind: 'repo' as const, url, binding_key: 's-one' };
  const first = withSource(t, m, 't2', run.r8, source);
  assert.equal(await m.start('t2', run.r8, 1), 0);
  const tree = join(first.taskDir, 's-one');
  writeFileSync(join(tree, '没提交的东西.txt'), '上一轮留下的');
  // What the Worker left on the clone: an added push URL, and a remote-tracking reference of
  // its own. Rebuilding `origin` round after round would take both away (§8.11).
  const push = 'https://example.test/owner/push.git';
  assert.equal(git(['-C', tree, 'remote', 'set-url', '--add', '--push', 'origin', push]).code, 0);
  // A bundle clone lands detached and makes no remote-tracking ref; this is one a fetch round
  // would leave under the remote's name.
  const tracking = 'refs/remotes/origin/keeper';
  assert.equal(git(['-C', tree, 'update-ref', tracking, 'HEAD']).code, 0);
  // The round after it: another run of the same Task, the same source. It must not reset,
  // not re-clone, and not lose what the round before it left uncommitted.
  withSource(t, m, 't2', run.r9, source);
  assert.equal(await m.start('t2', run.r9, 2), 0);
  assert.equal(readFileSync(join(tree, '没提交的东西.txt'), 'utf8'), '上一轮留下的', '上一轮没提交的工作还在');
  assert.equal(git(['-C', tree, 'rev-parse', 'HEAD']).out.trim(), base);
  assert.equal(git(['-C', tree, 'remote', 'get-url', '--push', 'origin']).out.trim(), push, '执行器留下的 pushurl 没被重建 origin 抹掉');
  assert.equal(git(['-C', tree, 'rev-parse', '--verify', tracking]).code, 0, '远端跟踪引用没被重建 origin 抹掉');
});

test('clone 失败：这一轮没有开工，git 的原话就在理由里', { skip: noGit }, async (t) => {
  const m = machine(t);
  const source = { kind: 'repo' as const, url: join(m.dataDir, '没有这个仓库'), binding_key: 's-one' };
  const box = withSource(t, m, 't3', run.r10, source);
  assert.equal(await m.start('t3', run.r10, 1), 2, '没能开工的一轮给的是“什么都没起”的码');
  assert.equal(readExit(box), 2);
  assert.equal(readLeft(box), 'none', '什么都没起，也没留下进程');
  // What git said travels with the reason: a DNS failure, a full disk or a wrong address is
  // otherwise never seen by anyone — the round's repo.log is read by nothing.
  const said = readFileSync(join(box.runDir, 'stderr.log'), 'utf8');
  assert.match(said, /没能把仓库/, said);
  assert.match(said, /fatal|does not exist|not found|无法|不存在/i, `git 的原话要在理由里：${said}`);
  assert.equal(/repo\.log/.test(said), false, '不再让读到这句话的人自己去翻 repo.log');
  assert.equal(existsSync(join(box.runDir, 'stdout.ndjson')), false, 'Worker 没有被起来');
  assert.equal(existsSync(join(box.taskDir, 's-one')), false, '克隆失败不留半个副本');
  assert.equal(existsSync(join(box.taskDir, 'repo')), false, '也不落在旧的名字下');
});

// Git's own words travel to the host, the pages and a push, so what must not be repeated is
// taken out before they leave the machine (node/source.ts).
test('git 的原话带回主机前先脱敏：地址里的用户凭据和提凭据的那行都不带回去', () => {
  assert.equal(
    shownGitWords("fatal: unable to access 'https://user:sekret-token@example.test/x.git/': Could not resolve host"),
    "fatal: unable to access 'https://example.test/x.git/': Could not resolve host",
  );
  assert.equal(shownGitWords('password=hunter2\nfatal: could not read Username'), 'fatal: could not read Username');
  assert.equal(shownGitWords('a\n\n  b  '), 'a b');
  assert.match(shownGitWords('x'.repeat(2000)), /^…x+$/);
  assert.equal(shownGitWords('x'.repeat(2000)).length, 601, '太长就只留最后一段，并写明切过');
});

test('两个来源的仓库副本分开：改派到另一个仓库不动前一个的现场', { skip: noGit }, async (t) => {
  const m = machine(t);
  const first = scratchRepo(t)
  const firstHead = first.commit('a.txt', '第一个仓库');
  const second = scratchRepo(t)
  const secondHead = second.commit('b.txt', '第二个仓库');
  withSource(t, m, 't19', run.r21, { kind: 'repo', url: sourceUrl(t, first.dir), binding_key: 's-one' });
  assert.equal(await m.start('t19', run.r21, 1), 0);
  const one = join(m.box('t19', run.r21).taskDir, 's-one');
  assert.equal(git(['-C', one, 'rev-parse', 'HEAD']).out.trim(), firstHead);
  // What the first source's round left uncommitted: it belongs to that source and stays there.
  writeFileSync(join(one, '没提交的东西.txt'), '第一个来源的现场');
  // The Task is repinned to another source (§8.7): another directory, never the first one's.
  withSource(t, m, 't19', run.r22, { kind: 'repo', url: sourceUrl(t, second.dir), binding_key: 's-two' });
  assert.equal(await m.start('t19', run.r22, 2), 0);
  const two = join(m.box('t19', run.r22).taskDir, 's-two');
  assert.equal(git(['-C', two, 'rev-parse', 'HEAD']).out.trim(), secondHead, '第二个来源在自己的目录里克隆');
  assert.equal(readFileSync(join(one, '没提交的东西.txt'), 'utf8'), '第一个来源的现场', '第一个来源的现场没被动过');
  assert.equal(existsSync(join(m.box('t19', run.r21).taskDir, 'repo')), false, '两个来源都不用旧的那个共用名字');
});

// §8.7 with the review's finding: the owner re-points the same source id at another address and
// the Task is moved to it. The binding identity is the id plus the content (shared/sources.ts
// bindingKey), so this is a new binding: the machine clones into a directory of its own and the
// first checkout is left where it is. Against: the machine reusing one directory per source id,
// so the round under the new address finds the old repository's code and its `origin`, while the
// snapshot says the new address.
test('同一来源编号改了地址：新的绑定，机器另开一份副本，旧现场留着', { skip: noGit }, async (t) => {
  const m = machine(t);
  const first = scratchRepo(t);
  const firstHead = first.commit('a.txt', '第一个地址');
  const second = scratchRepo(t);
  const secondHead = second.commit('b.txt', '第二个地址');
  const one = { id: 's-one', kind: 'repo' as const, url: sourceUrl(t, first.dir) };
  const two = { id: 's-one', kind: 'repo' as const, url: sourceUrl(t, second.dir) };
  assert.notEqual(bindingKey(one), bindingKey(two), '同一个编号、不同内容是两件绑定');
  withSource(t, m, 't20', run.r23, { ...one, binding_key: bindingKey(one) });
  assert.equal(await m.start('t20', run.r23, 1), 0);
  const oneDir = join(m.box('t20', run.r23).taskDir, bindingKey(one));
  assert.equal(git(['-C', oneDir, 'rev-parse', 'HEAD']).out.trim(), firstHead);
  writeFileSync(join(oneDir, '没提交的东西.txt'), '旧地址的现场');
  // The Task is moved to the same id as it stands now: another binding, another directory.
  withSource(t, m, 't20', run.r24, { ...two, binding_key: bindingKey(two) });
  assert.equal(await m.start('t20', run.r24, 2), 0);
  const twoDir = join(m.box('t20', run.r24).taskDir, bindingKey(two));
  assert.notEqual(oneDir, twoDir, '两份绑定的副本不共用一个目录');
  assert.equal(git(['-C', twoDir, 'rev-parse', 'HEAD']).out.trim(), secondHead, '新地址在自己的目录里克隆');
  assert.equal(git(['-C', twoDir, 'remote', 'get-url', 'origin']).out.trim(), two.url);
  assert.equal(readFileSync(join(oneDir, '没提交的东西.txt'), 'utf8'), '旧地址的现场', '旧地址的副本没被动过');
});

// The host builds the Worker's command line before any machine knows where its data directory
// is; the watch puts the two paths in. What this catches: a directory whose own name carries a
// dollar sign being read as a replacement pattern (`$&`, `$'`, `` $` ``, `$$`); and the TOML one
// (an executor whose own option is TOML) being substituted before it is encoded, which would make
// a path with a single quote in it an invalid argument.
test('占位符替换：目录名里的 $ 是字符，不是替换语法；TOML 的值在替换之后才编码', () => {
  const dirs = { materials: 'C:\\jobs$&data\\snapshot', artifacts: `D:\\it's$'here\\artifacts` };
  assert.deepEqual(fillPlaces(['--label={tycho-materials}/brief.md', '--out={tycho-artifacts}'], dirs), [
    `--label=${dirs.materials}/brief.md`,
    `--out=${dirs.artifacts}`,
  ]);
  assert.deepEqual(fillPlaces(['{tycho-materials}{tycho-artifacts}'], { materials: '$$', artifacts: '$&' }), ['$$$&']);
  assert.deepEqual(fillPlaces(['sandbox_workspace_write.writable_roots=[{tycho-artifacts-toml}]'], dirs), [
    `sandbox_workspace_write.writable_roots=[${JSON.stringify(dirs.artifacts)}]`,
  ]);
  assert.deepEqual(fillPlaces(['writable_roots=[{tycho-artifacts-toml}]'], { materials: 'M', artifacts: 'C:\\plain dir' }), [
    "writable_roots=['C:\\plain dir']",
  ]);
});

test('folder 来源：核对存在且可写，Worker 就在那个文件夹里，tycho 不往里写东西', async (t) => {
  const m = machine(t);
  const folder = mkdtempSync(join(tmpdir(), 'tycho-folder-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, '已有的东西.txt'), '原样');
  const box = withSource(t, m, 't6', run.r13, { kind: 'folder', path: folder, binding_key: 'f-folder' });
  assert.equal(await m.start('t6', run.r13, 1, { env: { TYCHO_FAKE_TOUCH: 'cwd.txt' } }), 0);
  assert.ok(existsSync(join(folder, 'cwd.txt')), 'Worker 的工作目录就是那个文件夹');
  assert.deepEqual(readdirSync(folder).sort(), ['cwd.txt', '已有的东西.txt'], 'tycho 只让 Worker 在里面写');
  assert.equal(existsSync(join(box.taskDir, 'repo')), false, 'folder 来源不建 repo/');
});

test('folder 来源不存在或不是文件夹：这一轮没有开工', async (t) => {
  const m = machine(t);
  const missing = withSource(t, m, 't7', run.r14, { kind: 'folder', path: join(m.dataDir, '没有这个文件夹'), binding_key: 'f-missing' });
  assert.equal(await m.start('t7', run.r14, 1), 2);
  assert.match(readFileSync(join(missing.runDir, 'stderr.log'), 'utf8'), /不存在、不是文件夹，或者读不了/);
  // A file where a folder was named: the same refusal, and nothing started.
  const file = join(m.dataDir, '是个文件.txt');
  writeFileSync(file, 'x');
  const notDir = withSource(t, m, 't8', run.r15, { kind: 'folder', path: file, binding_key: 'f-file' });
  assert.equal(await m.start('t8', run.r15, 1), 2);
  assert.match(readFileSync(join(notDir.runDir, 'stderr.log'), 'utf8'), /不存在、不是文件夹，或者读不了/);
  assert.equal(existsSync(join(notDir.runDir, 'stdout.ndjson')), false);
  // A folder that cannot be written: the same refusal. Windows keeps its own idea of what a
  // readable directory is, so this is checked where the mode bits are the machine's word.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = mkdtempSync(join(tmpdir(), 'tycho-folder-ro-'));
    t.after(() => { chmodSync(locked, 0o755); rmSync(locked, { recursive: true, force: true }); });
    chmodSync(locked, 0o555);
    const unwritable = withSource(t, m, 't12', run.r19, { kind: 'folder', path: locked, binding_key: 'f-locked' });
    assert.equal(await m.start('t12', run.r19, 1), 2);
    assert.match(readFileSync(join(unwritable.runDir, 'stderr.log'), 'utf8'), /不可写/);
  }
});

// A round that is not about any code at all: no source.json. That is not a failure — most
// rounds are this — and the Worker works in the empty Task directory.
test('没有来源的一轮：照常起 Worker，在空的任务目录里，不建 repo/', { skip: noGit }, async (t) => {
  const m = machine(t);
  const box = m.box('t9', run.r16);
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'brief.md'), '# 没有代码的一轮\n');
  assert.equal(await m.start('t9', run.r16, 1, { env: { TYCHO_FAKE_TOUCH: 'cwd.txt' } }), 0);
  assert.ok(existsSync(join(box.taskDir, 'cwd.txt')), 'Worker 的工作目录是任务目录');
  assert.equal(existsSync(join(box.taskDir, 'repo')), false);
  assert.equal(readExit(box), 0);
});

// A review round of a repository source: a checkout of its own, at the reviewed commit and
// with no origin, checked afterwards and removed (docs/design/code-sources.md §2,
// roles-and-tiers.md §5).
test('审阅的一轮：按被审的提交检出到这一轮自己的 repo/，没有 origin，核对完就删', { skip: noGit }, async (t) => {
  const m = machine(t);
  const repo = scratchRepo(t);
  const base = repo.commit('second.txt', '被审的提交');
  const url = sourceUrl(t, repo.dir);
  const box = withSource(t, m, 't10', run.r17, { kind: 'repo', url, commit: base, binding_key: 's-review' }, 'read');
  assert.equal(await m.start('t10', run.r17, 1), 0);
  const check = JSON.parse(readFileSync(join(box.procDir, 'code-check'), 'utf8')) as { result: string };
  assert.equal(check.result, 'same', '只读那一轮对着自己的检出核对');
  assert.equal(existsSync(join(box.runDir, 'repo')), false, '这一轮自己的检出核对完就删');
  assert.equal(existsSync(join(box.taskDir, 'repo')), false, '任务保留的 repo/ 不被这一轮碰');
});

test('要签出的提交不是一个提交号：这一轮没有开工', async (t) => {
  const m = machine(t);
  // Written by hand: the host would never send this, but the watch parses the file as data.
  const box = m.box('t11', run.r18);
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'source.json'), `${JSON.stringify({ kind: 'repo', url: 'https://example.test/a.git', binding_key: 's-one', commit: '--upload-pack=touch /tmp/x' })}\n`);
  assert.equal(await m.start('t11', run.r18, 1), 2);
  assert.match(readFileSync(join(box.runDir, 'stderr.log'), 'utf8'), /不是一个提交号/);
  assert.equal(existsSync(join(box.runDir, 'stdout.ndjson')), false);
});

test('可写 git 轮次结束时在 runDir 写入有界 diff.json，以 startHead 为基线捕获改动', { skip: noGit }, async (t) => {
  const m = machine(t);
  const repo = scratchRepo(t);
  const base = repo.commit('base.txt', '初始内容\n');
  const url = sourceUrl(t, repo.dir);
  const box = withSource(t, m, 't-diff', run.r19, { kind: 'repo', url, binding_key: 's-diff' });
  assert.equal(await m.start('t-diff', run.r19, 1, { env: { TYCHO_FAKE_TOUCH: 'added.txt' } }), 0);

  const diffPath = join(box.runDir, 'diff.json');
  assert.equal(existsSync(diffPath), true, 'runDir 下应写入 diff.json');
  const diff = JSON.parse(readFileSync(diffPath, 'utf8')) as {
    source: string;
    commit: string | null;
    base: string | null;
    branch: string | null;
    files: { path: string; status: string; patch: string }[];
    truncated: boolean;
  };
  assert.equal(diff.source, 'git');
  assert.equal(diff.commit, base);
  assert.equal(diff.base, base);
  assert.equal(diff.truncated, false);
  assert.ok(diff.files.some((file) => file.path === 'added.txt' && file.status === 'added'));
  assert.ok(Buffer.byteLength(readFileSync(diffPath, 'utf8'), 'utf8') <= 256 * 1024);
});
