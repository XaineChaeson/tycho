import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ADAPTERS } from '../adapters/all.ts';

// Capture identity before a caller can supply a reduced env or clear inherited marks.
const testProcess = Boolean(process.env.NODE_TEST_CONTEXT || process.env.TYCHO_TEST_GUARD || /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? ''));
// The test guard passes down the home the first test process saw; a test may point a
// child's HOME at a temporary directory, which is then not the owner's.
const ownerHome = resolve(process.env.TYCHO_TEST_OWNER_HOME || homedir());

const testing = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(testProcess || process.env.NODE_TEST_CONTEXT || process.env.TYCHO_TEST_GUARD || env.NODE_TEST_CONTEXT || env.TYCHO_TEST_GUARD);
const ownersHome = (home: string): boolean => (process.platform === 'win32'
  ? resolve(home).toLowerCase() === ownerHome.toLowerCase()
  : resolve(home) === ownerHome);

// A path as the file system finally names it: links and junctions on the way followed, as far
// as it exists, and the rest kept as written. Letter case does not tell two paths apart on
// Windows.
function finalPath(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      const real = join(realpathSync.native(at), ...rest.reverse());
      return process.platform === 'win32' ? real.toLowerCase() : real;
    } catch {
      const parent = dirname(at);
      if (parent === at) return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      rest.push(basename(at));
      at = parent;
    }
  }
}

const within = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// The owner's own executor directories: each executor's default place in the owner's home, and
// whatever the owner's shell had pointed their variables at (tests/guard.ts passes those down).
function ownersExecutorDirs(): string[] {
  const defaults = Object.values(ADAPTERS).flatMap(({ globalEntry }) => (globalEntry === undefined ? [] : [join(ownerHome, globalEntry.home.dir)]));
  const inherited = JSON.parse(process.env.TYCHO_TEST_OWNER_EXECUTOR_DIRS || '[]') as string[];
  return [...defaults, ...inherited].map(finalPath);
}

// An executor's own directory (the global entry, knowledge-and-skills.md §4.3): what its
// variable names, otherwise its place under the home directory. In a test the final path is
// checked whichever way it came — an inherited variable, another spelling, a link — and one in
// or under the owner's real executor directories is refused: the owner's own sessions read there.
export function executorDirOf(env: NodeJS.ProcessEnv, home: string, variable: string | undefined, dir: string): string {
  const path = resolve((variable ? env[variable] : undefined) || join(home, dir));
  if (testing(env)) {
    const final = finalPath(path);
    const owners = ownersExecutorDirs().find((owner) => within(final, owner));
    if (owners !== undefined) throw new Error(`测试碰不到主人真实的执行器目录：${path} 落在 ${owners} 里（${variable ?? dir}）`);
  }
  return path;
}

// Both defaults share this exit. A synthetic home stays useful for tests of the path
// rule; the real owner's home requires an explicitly named data or program directory.
export function homePathOf(env: NodeJS.ProcessEnv, home: string, variable: 'TYCHO_DATA' | 'TYCHO_PREFIX'): string {
  const explicit = env[variable];
  if (explicit) return explicit;
  if (testing(env) && ownersHome(home)) throw new Error('测试里没有设 ' + variable + '：默认目录在这台电脑的主目录下，是主人正在用的那一份');
  return join(home, '.tycho', variable === 'TYCHO_DATA' ? 'host' : 'app');
}

// Compiled helpers share tycho's own home; tests use the guard's temporary cache.
export function cachePathOf(env: NodeJS.ProcessEnv, home: string, name: string): string {
  if (testing(env)) {
    const root = env.TYCHO_TEST_CACHE;
    if (!root) throw new Error('测试里没有设 TYCHO_TEST_CACHE：编译缓存会落到这台电脑主人的目录里');
    return join(root, name);
  }
  return join(home, '.tycho', 'cache', name);
}
