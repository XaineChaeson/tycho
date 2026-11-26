// Guards the lightweight advisory check after a read-only round (node/code-check.ts) on a real
// repository: a baseline of HEAD/branch taken before the Worker, compared via `git status --porcelain`
// once it is gone (no full-repo SHA-256 hashing, `GIT_OPTIONAL_LOCKS=0`, and `GIT_*` env stripped).
import './guard.ts';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { checkAgainst, takeBaseline } from '../node/code-check.ts';
import { git, hasGit, scratchRepo } from './git-repo.ts';

const noGit = hasGit() ? false : '这台机器上没有可用的 git';

// A repository as a round is handed one, with a rule that ignores test output, and the
// baseline taken of it.
function round(t: TestContext) {
  const repo = scratchRepo(t, 'check');
  writeFileSync(join(repo.dir, '.gitignore'), 'out/\n*.log\n');
  repo.commit('src.txt', '源代码\n');
  const scratch = mkdtempSync(join(tmpdir(), 'tycho-check-scratch-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const base = takeBaseline(repo.dir, scratch);
  return { repo, base, check: () => checkAgainst(repo.dir, base, scratch), at: (...path: string[]) => join(repo.dir, ...path) };
}

test('什么都没动：代码没变', { skip: noGit }, (t) => {
  const r = round(t);
  assert.equal(typeof r.base.head, 'string');
  assert.ok(r.base.head.length >= 7);
  assert.deepEqual(r.check(), { result: 'same' });
});

test('只留下仓库规则忽略的输出：代码没变', { skip: noGit }, (t) => {
  const r = round(t);
  mkdirSync(r.at('out'), { recursive: true });
  writeFileSync(r.at('out', 'report.txt'), '测试输出');
  writeFileSync(r.at('run.log'), '日志');
  mkdirSync(r.at('out', 'pkg'), { recursive: true });
  writeFileSync(r.at('out', 'pkg', '.gitignore'), '*\n');
  assert.deepEqual(r.check(), { result: 'same' });
});

test('改了、删了、新增了没被忽略的文件：都算被改，返回 git status --porcelain 条目', { skip: noGit }, (t) => {
  const r = round(t);
  appendFileSync(r.at('src.txt'), '多一行\n');
  rmSync(r.at('README.md'), { force: true });
  writeFileSync(r.at('new.txt'), '新文件');
  const check = r.check();
  assert.equal(check.result, 'changed');
  const said = check.result === 'changed' ? check.changes.join('\n') : '';
  assert.match(said, /^M\s+src\.txt$/m);
  assert.match(said, /^\?\?\s+new\.txt$/m);
  assert.match(said, /^D\s+README\.md$/m);
});

test('提交或换分支：都算被改；只建未切换的旁支不改变 HEAD 与工作区状态', { skip: noGit }, (t) => {
  const committed = round(t);
  committed.repo.commit('more.txt', '又一个提交');
  const first = committed.check();
  assert.equal(first.result, 'changed');
  assert.match(first.result === 'changed' ? first.changes.join('\n') : '', /当前提交从/);

  const branched = round(t);
  assert.equal(git(['branch', 'side'], branched.repo.dir).code, 0);
  assert.deepEqual(branched.check(), { result: 'same' });

  const switched = round(t);
  assert.equal(git(['checkout', '-q', '-b', 'other'], switched.repo.dir).code, 0);
  const third = switched.check();
  assert.equal(third.result, 'changed');
  assert.match(third.result === 'changed' ? third.changes.join('\n') : '', /当前分支从/);
});

test('改了 .gitignore 且改了被跟踪文件：git status 仍报出变动', { skip: noGit }, (t) => {
  const edited = round(t);
  appendFileSync(edited.at('.gitignore'), 'src.txt\n');
  appendFileSync(edited.at('src.txt'), '改了又想藏起来\n');
  const check = edited.check();
  assert.equal(check.result, 'changed');
  const told = check.result === 'changed' ? check.changes.join('\n') : '';
  assert.match(told, /^M\s+\.gitignore$/m);
  assert.match(told, /^M\s+src\.txt$/m);
});

test('环境里的 GIT_CONFIG_GLOBAL 不影响核对（GIT_* 环境变量被剥离）', { skip: noGit }, (t) => {
  const r = round(t);
  const home = mkdtempSync(join(tmpdir(), 'tycho-check-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const globalIgnore = join(home, 'ignore');
  writeFileSync(globalIgnore, '*.secret\n');
  const config = join(home, 'gitconfig');
  writeFileSync(config, `[core]\n\texcludesFile = ${globalIgnore.replaceAll('\\', '/')}\n`);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; });
  writeFileSync(r.at('a.secret'), '机器上的规则会忽略它');
  const check = r.check();
  assert.equal(check.result, 'changed');
  assert.match(check.result === 'changed' ? check.changes.join('\n') : '', /^\?\?\s+a\.secret$/m);
});

test('代码目录没了、git 读不了：核对不了，不当成没变', { skip: noGit }, (t) => {
  const gone = round(t);
  rmSync(gone.repo.dir, { recursive: true, force: true });
  assert.equal(gone.check().result, 'unverifiable');

  const broken = round(t);
  rmSync(broken.at('.git', 'HEAD'), { force: true });
  const check = broken.check();
  assert.notEqual(check.result, 'same');
});
