// Guards against a release that cannot run or carries what it should not: a file the
// service or the command imports left out of the package, tests, briefs, local state or
// installed packages shipped to users, and a layout Node refuses to run (type stripping
// is refused under node_modules, which is why this is not an npm package). With the
// console built by its own toolchain: a package with no page in it, or with the page of
// an earlier build because nothing built it again; the frontend's sources, project files
// or installed packages shipped along; and a build that failed going unnoticed, or
// failing without saying which step it was.
// Also against a link in the tree shipping whatever it points at, and against an archive
// that is let through to tar although a member of it would land outside the directory it
// is unpacked into (a ".." on the way, an absolute or drive-letter name) or is a symbolic
// or hard link, through which a later member is written somewhere else.
// And against every release being called the same: a release is numbered package.json's
// major.minor and the count of commits up to HEAD, stamped in by the packer, so the
// number grows along one line of history; a tree that is not a repository has no such
// number and is refused, not numbered 0, and a number given by hand has to be of this
// tree's major.minor. Two branches packed at the same count do share a number: what keeps
// one from replacing the other is the release manifest (file → sha256) shipped with every
// package, which the installer compares before it takes a version for a reinstall.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { archiveProblem } from '../cli/archive.ts';
import { appVersion } from '../cli/paths.ts';
import { realSystem, tool } from '../cli/system.ts';
import { buildConsole, pack, packRelease, releaseFiles, releaseVersionOf } from '../scripts/pack.ts';
import { MANIFEST, readManifest } from '../cli/manifest.ts';
import { releaseRoot, tempDir } from './cli-helpers.ts';
import { git, hasGit } from './git-repo.ts';
import type { Hostile } from './cli-tar.ts';
import { hostileArchives, plainArchive, tarGz } from './cli-tar.ts';

const TAR = tool({ platform: process.platform, env: process.env }, 'tar');
// The version a test packs under: the repository's major.minor, numbered as a release.
const V = releaseVersionOf(join(import.meta.dirname, '..'), 7);

test('清单：运行要用的都在，不该有的都不在', (t) => {
  const files = releaseFiles(releaseRoot(t));
  for (const needed of [
    'package.json',
    'cli/main.ts',
    'service/main.ts',
    'service/restore.ts',
    'service/router-prompt.md',
    'runner/node-channel.ts',
    // The login helper's source: an installed host compiles it the first time the owner signs in.
    'service/ptybridge.cs',
    // The process helper's source: a Windows host compiles it the first time it asks about a pid.
    'service/procinfo.cs',
    'adapters/claude.ts',
    'channels/ws-client.ts',
    'shared/labels.ts',
    'shared/time.ts',
    // The machine-side client: installing tycho on a machine is how the client gets there.
    'node/cli.ts',
    'node/watch.ts',
    'console/dist/index.html',
    'console/dist/assets/index-0a1b2c3d.js',
  ]) {
    assert.ok(files.includes(needed), `包里少了 ${needed}`);
  }
  for (const file of files) {
    assert.match(file, /^(package\.json$|(adapters|channels|cli|console\/dist|node|runner|service|shared)\/)/, `包里不该有 ${file}`);
    assert.doesNotMatch(file, /(^|\/)(node_modules|tests|docs|install|scripts|src)\//, file);
    assert.doesNotMatch(file, /(^|\/)\./, `本地状态不该进包：${file}`);
  }
  assert.equal(new Set(files).size, files.length);
});

test('清单：目录里的本地状态和装下的依赖不进包，控制台只带构建产物', (t) => {
  const root = tempDir(t);
  const put = (path: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), '');
  };
  for (const dir of ['adapters', 'channels', 'cli', 'node', 'runner', 'service', 'shared']) put(`${dir}/kept.ts`);
  put('package.json');
  put('console/dist/index.html');
  put('console/dist/assets/index-1.js');
  put('console/src/main.tsx');
  put('console/package.json');
  put('console/package-lock.json');
  put('console/vite.config.ts');
  put('console/index.html');
  put('console/node_modules/react/index.js');
  put('service/.local/secret');
  put('service/.DS_Store');
  put('cli/node_modules/some-package/index.ts');
  put('tests/a.test.ts');
  put('docs/briefs/b.md');
  put('.local/notes');
  put('node_modules/typescript/index.js');
  assert.deepEqual(releaseFiles(root), [
    'package.json',
    'adapters/kept.ts',
    'channels/kept.ts',
    'cli/kept.ts',
    'console/dist/assets/index-1.js',
    'console/dist/index.html',
    'node/kept.ts',
    'runner/kept.ts',
    'service/kept.ts',
    'shared/kept.ts',
  ]);
});

test('控制台没有构建就不打包：没有页面的包装上去打不开', (t) => {
  const root = releaseRoot(t, { built: false });
  const out = join(tempDir(t), 'dist');
  assert.throws(() => releaseFiles(root), /控制台还没有构建/);
  assert.throws(() => pack(root, out, V), /控制台还没有构建/);
  assert.equal(existsSync(out), false, '没打成就不该留下东西');
});

test('打包前先构建控制台：没装依赖先装，哪一步失败就说哪一步', () => {
  const root = join('some', 'checkout');
  const runs = (installed: boolean, failing?: string) => {
    const calls: string[] = [];
    const build = () => buildConsole(root, {
      installed: (dir) => {
        assert.equal(dir, join(root, 'console', 'node_modules'));
        return installed;
      },
      npm(args, cwd) {
        assert.equal(cwd, root);
        calls.push(args.join(' '));
        return args.at(-1) === failing ? 1 : 0;
      },
    });
    return { calls, build };
  };
  const fresh = runs(false);
  fresh.build();
  assert.deepEqual(fresh.calls, ['--prefix console ci', '--prefix console run build']);
  const ready = runs(true);
  ready.build();
  assert.deepEqual(ready.calls, ['--prefix console run build'], '装过依赖就不重装');

  const noInstall = runs(false, 'ci');
  assert.throws(noInstall.build, /安装控制台的依赖失败.*npm --prefix console ci/);
  assert.deepEqual(noInstall.calls, ['--prefix console ci'], '依赖没装上就不往下构建');
  const noBuild = runs(true, 'build');
  assert.throws(noBuild.build, /构建控制台失败.*npm --prefix console run build/);
});

// A tree with one file in every directory a release is made of.
function releaseTree(t: TestContext): string {
  const root = tempDir(t);
  for (const dir of ['adapters', 'channels', 'cli', 'console/dist', 'node', 'runner', 'service', 'shared']) {
    mkdirSync(join(root, dir), { recursive: true });
    // The page is what makes a tree a release.
    writeFileSync(join(root, dir, dir === 'console/dist' ? 'index.html' : 'kept.ts'), '');
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tycho', version: V.slice(0, V.lastIndexOf('.')) }));
  return root;
}

test('打包：目录里有符号链接就报错并点名，不出包', (t) => {
  const elsewhere = tempDir(t);
  writeFileSync(join(elsewhere, 'secret'), '不该进包');

  // A junction where the system has them: Windows asks for a privilege to make a
  // symbolic link, and Node reports both as one. Anywhere else the word is ignored.
  const inside = releaseTree(t);
  symlinkSync(elsewhere, join(inside, 'service', 'linked'), 'junction');
  assert.throws(() => releaseFiles(inside), (err: Error) => err.message.includes('service/linked') && /符号链接/.test(err.message));
  assert.throws(() => pack(inside, join(inside, 'dist'), V), /service\/linked/);
  assert.equal(existsSync(join(inside, 'dist')), false, '打不出来的包什么都不该留下');

  // One of the release's own directories being a link is no different.
  const top = releaseTree(t);
  rmSync(join(top, 'console'), { recursive: true });
  symlinkSync(elsewhere, join(top, 'console'), 'junction');
  assert.throws(() => releaseFiles(top), (err: Error) => err.message.startsWith('console ') && /符号链接/.test(err.message));

  // What is not part of a release is not looked at.
  const beside = releaseTree(t);
  symlinkSync(elsewhere, join(beside, 'docs'), 'junction');
  assert.equal(releaseFiles(beside).length, 9);

  // A link to a file. Windows may refuse to make one without a privilege.
  const file = releaseTree(t);
  try {
    symlinkSync(join(elsewhere, 'secret'), join(file, 'cli', 'secret.ts'), 'file');
  } catch (err) {
    t.diagnostic(`这台机器不让建指向文件的符号链接（${(err as NodeJS.ErrnoException).code}），这一种没有测`);
    return;
  }
  assert.throws(() => releaseFiles(file), /cli\/secret\.ts/);
});

const SYSTEM = { platform: process.platform, env: process.env, exec: realSystem().exec };

test('解包前的检查：正常的包放行；会落到解包目录之外的成员、链接都被点名拒绝，而且什么都没解开', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'plain.tar.gz'), plainArchive());
  assert.equal(archiveProblem(SYSTEM, 'plain.tar.gz', dir), null);
  // What `pack` itself makes passes, on whichever tar this system has.
  const release = pack(releaseRoot(t), dir, V);
  assert.equal(archiveProblem(SYSTEM, basename(release), dir), null);

  const outside = '/somewhere/else';
  const says: Record<Hostile, RegExp> = {
    dotdot: /解包目录之外.*\.\.\/dotdot\.txt/,
    absolute: /解包目录之外.*\/somewhere\/else\/absolute\.txt/,
    drive: /解包目录之外.*C:\/drive\.txt/,
    symlink: /不是普通文件或目录.*link/,
    hardlink: /不是普通文件或目录.*hard/,
  };
  for (const [kind, archive] of Object.entries(hostileArchives(outside)) as [Hostile, Buffer][]) {
    writeFileSync(join(dir, `${kind}.tar.gz`), archive);
    const problem = archiveProblem(SYSTEM, `${kind}.tar.gz`, dir);
    assert.match(problem ?? '（放行了）', says[kind], kind);
  }
  // A backslash is a separator to Windows, whatever the tar that made the archive meant.
  writeFileSync(join(dir, 'backslash.tar.gz'), tarGz([{ name: 'cli\\..\\..\\up.txt', content: 'out' }]));
  assert.match(archiveProblem(SYSTEM, 'backslash.tar.gz', dir) ?? '（放行了）', /解包目录之外/);
  assert.deepEqual(
    readdirSync(dir).sort(),
    ['absolute.tar.gz', 'backslash.tar.gz', 'dotdot.tar.gz', 'drive.tar.gz', 'hardlink.tar.gz', 'plain.tar.gz', 'symlink.tar.gz', basename(release)].sort(),
    '检查只看不解',
  );

  writeFileSync(join(dir, 'junk.tar.gz'), 'x');
  assert.match(archiveProblem(SYSTEM, 'junk.tar.gz', dir) ?? '', /读不出/);
  assert.match(archiveProblem(SYSTEM, 'missing.tar.gz', dir) ?? '', /读不出/);
});

test('打出的包：内容就是清单；解开后命令能跑，服务的全部模块都载得进来', (t) => {
  const dir = tempDir(t);
  const root = releaseRoot(t);
  const archive = pack(root, join(dir, 'dist'), V);
  assert.equal(basename(archive), `tycho-${V}.tar.gz`);

  const listed = spawnSync(TAR, ['-tzf', basename(archive)], { cwd: join(dir, 'dist'), encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const packed = listed.stdout.split(/\r?\n/).filter((line) => line !== '').sort();
  assert.deepEqual(packed, [...releaseFiles(root), MANIFEST].sort());
  assert.ok(packed.includes('console/dist/index.html'));
  assert.deepEqual(packed.filter((file) => file.startsWith('console/') && !file.startsWith('console/dist/')), [], '前端工程的源码和依赖进了包');

  // Unpacked the way the installer does it: a version directory, not node_modules.
  const home = join(dir, 'app', 'versions', V);
  mkdirSync(home, { recursive: true });
  const unpacked = spawnSync(TAR, ['-xzf', join('..', '..', '..', 'dist', basename(archive))], { cwd: home, encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  // The checkout's package.json with the release's version stamped in, and nothing else changed.
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'package.json'), 'utf8')), { ...source, version: V });
  assert.equal(appVersion(root), V.split('.').slice(0, 2).join('.'), '打包不改仓库里的 package.json');
  assert.equal(readFileSync(join(home, 'console', 'dist', 'index.html'), 'utf8'), readFileSync(join(root, 'console', 'dist', 'index.html'), 'utf8'));
  // The manifest names every other file of the package with the hash of what was packed.
  const manifest = readManifest(home)!;
  assert.deepEqual(Object.keys(manifest).sort(), releaseFiles(root).sort());
  for (const file of ['package.json', 'cli/main.ts', 'console/dist/index.html']) {
    assert.equal(manifest[file], createHash('sha256').update(readFileSync(join(home, file))).digest('hex'), file);
  }

  const version = spawnSync(process.execPath, [join(home, 'cli', 'main.ts'), 'version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `tycho ${V}`);

  // Importing the service's entry loads every module it needs without starting it: a
  // file missing from the package fails here.
  const loaded = spawnSync(process.execPath, ['-e', `await import(${JSON.stringify(pathToFileURL(join(home, 'service', 'main.ts')).href)})`, '--input-type=module'], { encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
});

test('同样的文件放在 node_modules 下 Node 不肯跑：所以不走 npm', (t) => {
  const dir = tempDir(t);
  const home = join(dir, 'node_modules', 'tycho');
  mkdirSync(join(home, 'cli'), { recursive: true });
  writeFileSync(join(home, 'package.json'), '{"type":"module"}');
  writeFileSync(join(home, 'cli', 'main.ts'), 'const n: number = 1;\nconsole.log(n);\n');
  const ran = spawnSync(process.execPath, [join(home, 'cli', 'main.ts')], { encoding: 'utf8' });
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
});

// What this catches: a failed console build leaving the archive of an earlier pack in
// dist/ (and in --out), so a deployment that only looked for the file installed the old
// version and seemed to succeed. Run as the script is run: the exit code is what a
// deployment goes by. The tree's console has no build script, so the build fails for real
// and without the network; its packages are "installed", so nothing is fetched.
test('控制台构建失败：退出码非零，dist 和 --out 里这一版的旧包都不在了', (t) => {
  const root = releaseRoot(t, { built: false });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'pack.ts'), readFileSync(join(import.meta.dirname, '..', 'scripts', 'pack.ts')));
  const name = `tycho-${V}.tar.gz`;
  const out = join(tempDir(t), 'out');
  for (const dir of [join(root, 'dist'), out]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), '上一次打的旧包');
    writeFileSync(join(dir, 'tycho-0.0.0-older.tar.gz'), '别的版本不归这次管');
  }
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'pack.ts'), '--out', out, '--build', '7'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /构建控制台失败/);
  assert.equal(run.stdout, '', '失败时不报出包的路径');
  assert.equal(existsSync(join(root, 'dist', name)), false, 'dist 里的旧包还在');
  assert.equal(existsSync(join(out, name)), false, '--out 里的旧包还在');
  assert.equal(existsSync(join(out, 'tycho-0.0.0-older.tar.gz')), true, '别的版本的包不动');
});

test('打包中途失败：这一版的包一个也不留，原因照常抛出', (t) => {
  const root = releaseRoot(t, { built: false });
  const out = join(tempDir(t), 'dist');
  const archive = join(out, `tycho-${V}.tar.gz`);
  mkdirSync(out, { recursive: true });
  writeFileSync(archive, '上一次打的旧包');
  const built = { installed: () => true, npm: () => 0 };
  assert.throws(() => packRelease(root, [out], V, built), /控制台还没有构建/);
  assert.equal(existsSync(archive), false);
});

test('版本号：package.json 的主次版本加 HEAD 的提交数；同一个提交两次一样；显式给的第三段优先', { skip: !hasGit() && '这台机器没有 git' }, (t) => {
  const root = tempDir(t);
  const run = (...args: string[]): string => {
    const said = git(['-c', 'user.email=owner@example.test', '-c', 'user.name=owner', ...args], root);
    assert.equal(said.code, 0, said.err);
    return said.out;
  };
  run('init', '-q', '.');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tycho', version: '0.3' }));
  run('add', 'package.json');
  run('commit', '-q', '-m', 'one');
  for (const n of [2, 3]) run('commit', '-q', '--allow-empty', '-m', String(n));
  assert.equal(releaseVersionOf(root), '0.3.3');
  assert.equal(releaseVersionOf(root), '0.3.3', '同一个提交打两次包得到同一个版本号');
  run('commit', '-q', '--allow-empty', '-m', 'four');
  assert.equal(releaseVersionOf(root), '0.3.4', '多一个提交，版本号跟着变');
  assert.equal(releaseVersionOf(root, 12), '0.3.12');
  for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => releaseVersionOf(root, bad), /第三段/);

  // The third part is the packer's: a package.json that writes one is refused, not overwritten.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tycho', version: '0.3.1' }));
  assert.throws(() => releaseVersionOf(root), /只写主次版本/);
});

test('版本号：不在 git 仓库里、或者只是别的仓库里的一个子目录，都说清楚并拒绝，不编一个号', { skip: !hasGit() && '这台机器没有 git' }, (t) => {
  const bare = tempDir(t);
  writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'tycho', version: '0.3' }));
  assert.throws(() => releaseVersionOf(bare), /发布包必须从 git 仓库打/);

  // A copy of the tree put inside some other repository would be numbered by that one.
  const outer = tempDir(t);
  assert.equal(git(['init', '-q', '.'], outer).code, 0);
  const inner = join(outer, 'copy');
  mkdirSync(inner);
  writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'tycho', version: '0.3' }));
  assert.throws(() => releaseVersionOf(inner), /发布包必须从 git 仓库打/);
});

test('打包命令：不在仓库里又没给 --build 就失败，不留包、不报路径', { skip: !hasGit() && '这台机器没有 git' }, (t) => {
  const root = releaseRoot(t);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'pack.ts'), readFileSync(join(import.meta.dirname, '..', 'scripts', 'pack.ts')));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'pack.ts')], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /发布包必须从 git 仓库打.*--build/s);
  assert.equal(run.stdout, '');
  assert.equal(existsSync(join(root, 'dist')), false);
  for (const bad of ['', 'x', '-1']) {
    const wrong = spawnSync(process.execPath, [join(root, 'scripts', 'pack.ts'), '--build', bad], { cwd: root, encoding: 'utf8' });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /第三段/);
  }
});

test('打包只认这棵树的版本号：主次版本不是 package.json 里的、第三段不是整数，都不打', (t) => {
  const root = releaseRoot(t);
  const out = join(tempDir(t), 'dist');
  const base = appVersion(root);
  for (const wrong of ['9.9.7', base, `${base}.7-x`, `${base}.`, `${base}.07x`]) {
    assert.throws(() => pack(root, out, wrong), /不是这棵树的版本号/, wrong);
    assert.throws(() => packRelease(root, [out], wrong, { installed: () => true, npm: () => 0 }), /不是这棵树的版本号/, wrong);
  }
  assert.equal(existsSync(out), false, '没打成就不该留下东西');
});

test('从仓库直接跑：版本是 package.json 的主次版本加“开发版”', () => {
  const ran = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli', 'main.ts'), 'version'], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), `tycho ${appVersion(join(import.meta.dirname, '..'))} 开发版`);
});
