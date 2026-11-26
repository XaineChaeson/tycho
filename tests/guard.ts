// Ordinary test env reconstruction must not remove the identity passed to a helper.
// Only test processes install this guard; the runtime does not replace process APIs.
// Preloading it in Node helpers protects grandchildren even if the helper imports no app code.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

type ProcessFunctions = Record<string, (...args: unknown[]) => unknown>;
const MARK = 'TYCHO_TEST_GUARD';
const PRELOAD = '--import=' + import.meta.url;
// The owner's home as the first test process saw it. A child whose HOME a test points at a
// temporary directory would otherwise take that directory for the owner's and refuse it.
const HOME_MARK = 'TYCHO_TEST_OWNER_HOME';
const ownerHome = process.env[HOME_MARK] || homedir();
// The owner's own home, as the guard compares it: a child is never handed a home under it to
// make (a test's temporary homes live under %TEMP%, which is under the owner's home, so only
// that one directory itself is excluded here).
const OWNER_HOME = resolve(ownerHome).toLowerCase();

// Windows answers "where is the local app data folder" from the home a process was given, and
// the answer is empty while <home>\AppData\Local is missing: Windows PowerShell then builds its
// module analysis cache path as a relative one, and the cache is written into the process's
// working directory — under `npm test`, the repository. A test points a child's home away from
// the owner's, and often at a directory that was never made; the directory Windows needs is
// made here, before any child asks. A home that is not an absolute path is left alone: making
// it would create it in the working directory, which is the very thing being avoided.
function completeWindowsHome(env: NodeJS.ProcessEnv): void {
  if (process.platform !== 'win32') return;
  const home = env.USERPROFILE;
  if (!home || (!/^[A-Za-z]:[\\/]/.test(home) && !home.startsWith('\\\\'))) return;
  if (resolve(home).toLowerCase() === OWNER_HOME) return;
  try {
    mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
  } catch {
    // A home that cannot be made is already the failure it is; the guard never fails a spawn.
  }
}
// The variables that move the executors' own directories (the adapters' globalEntry.home.env,
// and dsh's shared root beside its home; tests/executor-dirs-guard.test.ts checks the list covers
// the adapters). A test run never inherits the owner's: the first test process points each at a
// directory of its own, and passes down what the owner's shell had set, for
// service/home-paths.ts to refuse as the owner's own.
export const EXECUTOR_HOME_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'DSH_AGENTS_HOME'];
const EXECUTOR_MARK = 'TYCHO_TEST_EXECUTOR_HOMES';
const OWNER_DIRS_MARK = 'TYCHO_TEST_OWNER_EXECUTOR_DIRS';
if (!process.env[EXECUTOR_MARK]) {
  const owners = EXECUTOR_HOME_VARIABLES.flatMap((variable) => (process.env[variable] ? [process.env[variable]!] : []));
  const root = mkdtempSync(join(tmpdir(), 'tycho-test-executors-'));
  process.env[EXECUTOR_MARK] = root;
  process.env[OWNER_DIRS_MARK] = JSON.stringify([...(JSON.parse(process.env[OWNER_DIRS_MARK] || '[]') as string[]), ...owners]);
  for (const variable of EXECUTOR_HOME_VARIABLES) process.env[variable] = join(root, variable.toLowerCase());
  // Only the process that made them takes them away; its children were handed them.
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
// Where this run's compiled helpers go (service/home-paths.ts cachePathOf): the shared process
// helper would otherwise compile into the owner's own tycho directory, because a test
// that calls it directly has no data directory to point somewhere else. The first test process
// makes one directory for the run and hands it down; one that made its own would leave it behind.
const CACHE_MARK = 'TYCHO_TEST_CACHE';
export const HELPER_CACHE_VARIABLE = CACHE_MARK;
if (!process.env[CACHE_MARK]) {
  const root = mkdtempSync(join(tmpdir(), 'tycho-test-cache-'));
  process.env[CACHE_MARK] = root;
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
const guardedEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const options = env.NODE_OPTIONS ?? '';
  // A child given no LOCALAPPDATA of its own gets one inside the test's own tree: the Claude
  // desktop app's installations are found through that variable, and a test must not find the
  // owner's. (PowerShell's module cache is not decided by it — see completeWindowsHome.)
  let localAppData = env.LOCALAPPDATA;
  if (process.platform === 'win32' && !localAppData) {
    localAppData = join(process.env[EXECUTOR_MARK]!, 'localappdata');
    mkdirSync(localAppData, { recursive: true });
  }
  completeWindowsHome(env);
  // The executor variables are passed down as the code under test passes them, never added
  // back: a child given none (the Router's own environment drops CLAUDE_CONFIG_DIR) falls to the
  // default places, which service/home-paths.ts refuses in a test.
  return {
    ...env, ...(localAppData ? { LOCALAPPDATA: localAppData } : {}), [MARK]: '1', [HOME_MARK]: ownerHome,
    [EXECUTOR_MARK]: process.env[EXECUTOR_MARK]!, [OWNER_DIRS_MARK]: process.env[OWNER_DIRS_MARK]!, [CACHE_MARK]: process.env[CACHE_MARK]!,
    NODE_OPTIONS: options.split(/\s+/).includes(PRELOAD) ? options : (options + ' ' + PRELOAD).trim(),
  };
};
let installed = false;

function keepTestIdentityInChildren(): void {
  if (installed) return;
  installed = true;
  const inherited = guardedEnv(process.env);
  process.env[MARK] = inherited[MARK];
  process.env[HOME_MARK] = inherited[HOME_MARK];
  process.env.NODE_OPTIONS = inherited.NODE_OPTIONS;
  const childProcess = createRequire(import.meta.url)('node:child_process') as ProcessFunctions;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name]!;
    const guardedCall = (run: (...args: unknown[]) => unknown) => (...input: unknown[]): unknown => {
      const args = [...input];
      const withArgs = name === 'spawn' || name === 'spawnSync' || name === 'execFile' || name === 'execFileSync' || name === 'fork';
      const index = withArgs && (Array.isArray(args[1]) || (args.length > 2 && args[1] == null)) ? 2 : 1;
      const value = args[index];
      const options = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
      const env = options.env !== null && typeof options.env === 'object' ? options.env : process.env;
      const guarded = { ...options, env: guardedEnv(env as NodeJS.ProcessEnv) };
      if (typeof value === 'function') args.splice(index, 0, guarded);
      else args[index] = guarded;
      return Reflect.apply(run, childProcess, args);
    };
    const wrapped = guardedCall(original);
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
    if (typeof custom === 'function') Object.defineProperty(wrapped, promisify.custom, { value: guardedCall(custom as (...args: unknown[]) => unknown) });
    childProcess[name] = wrapped;
  }
  // Update existing named imports too: test modules commonly import spawn before paths.
  syncBuiltinESMExports();
}

keepTestIdentityInChildren();
