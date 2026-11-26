// `node scripts/pack.ts [--out <目录>] [--build <n>]` builds the console, then
// dist/tycho-<version>.tar.gz: what a running tycho needs and nothing else. A pack that
// fails exits non-zero and leaves no archive of this version behind, in dist/ or in --out:
// an earlier one left there would be taken for this one. The install scripts unpack it
// into a version directory. It is not an npm package: Node refuses to strip types from .ts
// files under node_modules.
//
// The version is package.json's major.minor and, as its third part, the number of commits
// up to HEAD: every release is numbered without anyone remembering to, and the same commit
// packed twice is the same version. Only the archive's package.json carries three parts;
// the checkout's keeps major.minor, which is how a program run from it knows it is not a
// release. --build gives the third part outright, and only for a tree that is not a
// repository: whoever gives it answers for the number not being one already used. Every
// package carries a manifest of its files (cli/manifest.ts), so the installer refuses
// another program under a version already in place rather than taking it for a reinstall.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MANIFEST, writeManifest } from '../cli/manifest.ts';
import { appVersion } from '../cli/paths.ts';
import { RELEASE_VERSION_ENV } from '../shared/version.ts';
import { tool } from '../cli/system.ts';
import { isEntry } from '../service/entry.ts';
import { spawnSync } from 'node:child_process';

// Everything the service and the command import or serve, by directory. Of the console
// only what its build produced: an installed tycho has no frontend toolchain. `node/` is
// the machine-side client, and it ships with the same package: installing tycho on a
// machine installs the client (docs/design/nodes.md §10).
export const RELEASE_DIRS = ['adapters', 'channels', 'cli', 'console/dist', 'node', 'runner', 'service', 'shared'];
export const RELEASE_FILES = ['package.json'];
export const LICENSE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.txt'];
const CONSOLE_PAGE = 'console/dist/index.html';

// Plain files and directories only, judged without following a link: one that points
// out of the repository would ship whatever it points at, and unpacked on another
// machine it would point wherever that machine has it. The installers refuse such an
// archive; this refuses to make one.
function refuse(path: string, stat: Stats): never {
  const kind = stat.isSymbolicLink() ? '一个符号链接' : '一个特殊文件（不是普通文件，也不是目录）';
  throw new Error(`${path} 是${kind}，发布包只收普通文件和目录。把它换成真正的文件，或者挪出去，再打包。`);
}

// A directory on the way to a release directory. One that is not there is for whoever
// looks for what is in it to report.
function above(root: string, path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(join(root, path));
  } catch {
    return;
  }
  if (!stat.isDirectory()) refuse(path, stat);
}

function collect(root: string, path: string, found: string[]): void {
  const stat = lstatSync(join(root, path));
  if (stat.isFile()) {
    found.push(path);
    return;
  }
  if (!stat.isDirectory()) refuse(path, stat);
  for (const name of readdirSync(join(root, path)).sort()) {
    // Local state and installed packages are never part of a release.
    if (name.startsWith('.') || name === 'node_modules') continue;
    collect(root, `${path}/${name}`, found);
  }
}

export interface PackOptions {
  strictLicenses?: boolean;
}

// The files of a release, relative to the repository, with forward slashes.
export function releaseFiles(root: string, { strictLicenses = false }: PackOptions = {}): string[] {
  const paths = [...RELEASE_FILES, ...RELEASE_DIRS];
  // A link above a release directory would be followed without being seen.
  for (const path of paths) for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) above(root, path.slice(0, at));
  // A release without the page installs and then has nothing to open.
  if (!existsSync(join(root, CONSOLE_PAGE))) throw new Error(`控制台还没有构建（没有 ${CONSOLE_PAGE}）：先运行 npm run build:console`);
  const files: string[] = [];
  for (const path of paths) collect(root, path, files);
  for (const licenseFile of LICENSE_FILES) {
    const stat = lstatSync(join(root, licenseFile), { throwIfNoEntry: false });
    if (stat !== undefined) {
      collect(root, licenseFile, files);
    } else if (strictLicenses) {
      throw new Error(`发布包缺少许可证文件 ${licenseFile}：请确保 ${LICENSE_FILES.join(' 和 ')} 存在（可运行 node scripts/gen-third-party-notices.ts）`);
    }
  }
  return files;
}

// What a release of this checkout is called. Throws, saying why, when there is no number to
// give it: a release comes from a repository.
export function releaseVersionOf(root: string, build?: number): string {
  const base = appVersion(root);
  if (!/^\d+\.\d+$/.test(base)) {
    throw new Error(`${join(root, 'package.json')} 的 version 只写主次版本（例如 0.1），第三段由打包时的提交数决定；现在写的是 ${base}`);
  }
  if (build !== undefined && (!Number.isSafeInteger(build) || build < 0)) throw new Error(`版本号的第三段要是不小于 0 的整数：${build}`);
  return `${base}.${build ?? commitCount(root)}`;
}

function commitCount(root: string): number {
  const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const said = (ran: ReturnType<typeof git>): string => (ran.stderr || ran.error?.message || `git 退出码 ${ran.status}`).trim();
  const refuse = (why: string): Error => new Error(`发布包必须从 git 仓库打（版本号的第三段是 HEAD 的提交数）：${why}。在仓库之外打包，用 --build <第三段> 明确给出。`);
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw refuse(`${root} 不是 git 仓库（${said(top)}）`);
  // A copy of the tree inside some other repository would be numbered by that one.
  if (realpathSync.native(top.stdout.trim()) !== realpathSync.native(root)) throw refuse(`${root} 只是仓库 ${top.stdout.trim()} 里的一个子目录`);
  const count = git(['rev-list', '--count', 'HEAD']);
  if (count.status !== 0 || !/^\d+$/.test(count.stdout.trim())) throw refuse(`git rev-list --count HEAD 没有成功（${said(count)}）`);
  return Number(count.stdout.trim());
}

// A version given by a caller is one of this tree's: its major.minor and a whole third part.
function requireOwnVersion(root: string, version: string): void {
  const base = appVersion(root);
  const third = version.startsWith(`${base}.`) ? version.slice(base.length + 1) : '';
  if (!/^\d+\.\d+$/.test(base) || !/^\d+$/.test(third)) throw new Error(`${version} 不是这棵树的版本号：应为 ${base}.<整数>`);
}

interface ConsoleBuild {
  // Whether the console's packages are there to build with.
  installed(dir: string): boolean;
  // Runs npm in `cwd` to its end and gives its exit code.
  npm(args: string[], cwd: string): number;
}

// The build of a release: the page shows the version it is packed under
// (console/src/build-version.ts reads it from the environment).
const realBuild = (version: string): ConsoleBuild => {
  const env = { ...process.env, [RELEASE_VERSION_ENV]: version };
  return {
    installed: existsSync,
    // Everything npm says goes to stderr: stdout is the archive's path and nothing else.
    // Through the shell on Windows, where npm is a .cmd, and as one line: Node warns about
    // arguments handed to a shell separately. No argument here needs quoting.
    npm: (args, cwd) => (process.platform === 'win32'
      ? spawnSync(`npm ${args.join(' ')}`, { cwd, env, stdio: ['ignore', 2, 2], shell: true })
      : spawnSync('npm', args, { cwd, env, stdio: ['ignore', 2, 2] })).status ?? 1,
  };
};

// Builds console/dist from the lock file's packages. Always built again: the page in a
// release is the one of the sources it is packed with.
export function buildConsole(root: string, build: ConsoleBuild): void {
  const step = (what: string, args: string[]): void => {
    if (build.npm(args, root) !== 0) throw new Error(`${what}失败：npm ${args.join(' ')} 没有成功，原因见上面的输出`);
  };
  if (!build.installed(join(root, 'console', 'node_modules'))) step('安装控制台的依赖', ['--prefix', 'console', 'ci']);
  step('构建控制台', ['--prefix', 'console', 'run', 'build']);
}

const archiveIn = (outDir: string, version: string): string => join(outDir, `tycho-${version}.tar.gz`);

export function pack(root: string, outDir: string, version: string, options: PackOptions = {}): string {
  requireOwnVersion(root, version);
  const archive = archiveIn(outDir, version);
  // Before anything is written: a tree that cannot be released leaves nothing behind.
  const files = releaseFiles(root, options);
  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'tycho-pack-'));
  try {
    // A copy of the release's files with the version stamped into package.json: the
    // checkout itself is not written to.
    const tree = join(scratch, 'tree');
    for (const file of files) {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      copyFileSync(join(root, file), join(tree, file));
    }
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(tree, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
    writeManifest(tree);
    const list = join(scratch, 'files');
    writeFileSync(list, `${[...files, MANIFEST].join('\n')}\n`);
    const packed = spawnSync(tool({ platform: process.platform, env: process.env }, 'tar'), ['-czf', archive, '-C', tree, '-T', list], { encoding: 'utf8' });
    if (packed.status !== 0) {
      rmSync(archive, { force: true });
      throw new Error(`tar 没能打出 ${archive}：${packed.stderr || packed.error?.message}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return archive;
}

// The whole of a pack: every archive of this version in `clear` is removed first, then the
// console is built and the archive written into the last of them. Whatever fails, none is
// left: what is there afterwards is this pack's, or nothing.
export function packRelease(root: string, clear: string[], version: string, build: ConsoleBuild = realBuild(version), options: PackOptions = {}): string {
  requireOwnVersion(root, version);
  const stale = clear.map((dir) => archiveIn(dir, version));
  for (const archive of stale) rmSync(archive, { force: true });
  try {
    buildConsole(root, build);
    return pack(root, clear.at(-1)!, version, options);
  } catch (err) {
    for (const archive of stale) rmSync(archive, { force: true });
    throw err;
  }
}

if (isEntry(import.meta.filename)) {
  const root = join(import.meta.dirname, '..');
  const flag = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1] ?? '';
  };
  const out = flag('--out');
  const given = flag('--build');
  const strictLicenses = process.argv.includes('--strict-licenses');
  const dist = join(root, 'dist');
  try {
    if (given !== undefined && !/^\d+$/.test(given)) throw new Error(`--build 要给版本号的第三段（不小于 0 的整数）：${given}`);
    const version = releaseVersionOf(root, given === undefined ? undefined : Number(given));
    console.log(packRelease(root, out === undefined ? [dist] : [dist, out], version, realBuild(version), { strictLicenses }));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
