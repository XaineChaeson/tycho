// Where an executor's command is on this computer: the one lookup the machine's probe
// (node/executors.ts), its watch process (node/watch.ts, through node/launch.ts), the Router
// and the self-check (service/claude-cli.ts) all use, so that the same question never has two
// answers (docs/design/nodes.md §1.2).
//
// PATH first, then the places the executor's adapter declares (Adapter.installs): a desktop
// app or an installer that leaves the command off PATH. Those places are this program's own
// closed set, picked by the command's name among the adapters it ships; nothing a host sends
// can add one or change one. A place that is not there is not a problem: it is only one more
// place the answer says was looked in.
//
// On Windows the rules node/launch.ts states for PATH hold for every candidate: only fully
// qualified directories count, and nothing is taken from a directory that is excluded or that
// the disk cannot place. On other systems only PATH's absolute directories count, and a file
// has to be executable.
//
// Which environment is looked in is the caller's: on a machine, the one lookup environment its
// client holds (node/lookup-env.ts), never the environment a host sends with a round.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { ADAPTERS } from '../adapters/all.ts';
import type { InstallPlace } from '../adapters/types.ts';
import { compareVersions, versionOf } from '../adapters/version.ts';

// Runs `reg` with these arguments and gives what it printed, or nothing when it could not be
// run or found nothing: a registry that cannot be read is a place with nothing in it.
export type RegistryQuery = (args: string[]) => string | undefined;

export interface LocateOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  // Directories, and everything under them, that are never looked in (e.g. task checkouts).
  exclude?: string[];
  // Exact directories (without their subdirectories) that are never looked in (e.g. when a
  // process's working directory is $HOME or a filesystem root).
  excludeDirs?: string[];
  // The declared places to try after PATH. By default the adapters' for this command name.
  places?: readonly InstallPlace[];
  isFile?: (path: string) => boolean;
  realpath?: (path: string) => string;
  // The names of the directories in one, or none when it is not there.
  listDirs?: (dir: string) => string[];
  registry?: RegistryQuery;
}

export interface Lookup {
  // The absolute path of the command, or nothing when no place has it.
  path: string | undefined;
  // Every place that was looked in, in the owner's words, in order: the last is the one that
  // had it, when one did.
  searched: string[];
}

// The command is in none of the places: the executor is not installed for this process.
export class CommandMissing extends Error {
  readonly searched: string[];
  constructor(name: string, searched: string[]) {
    super(missingText(name, searched));
    this.searched = searched;
  }
}

export const missingText = (name: string, searched: string[]): string => `找不到 ${name}：查过 ${searched.join('、')}`;

// The places the adapters this program ships declare for a command of this name. A path
// (anything with a separator) is no command name, and has none.
export function placesOf(name: string): readonly InstallPlace[] {
  if (/[\\/]/.test(name)) return [];
  return Object.values(ADAPTERS).filter((adapter) => adapter.probe?.command === name).flatMap((adapter) => adapter.installs ?? []);
}

// Windows' variables have no case: `Path` is `PATH`. The last spelling wins, as the later
// of two spread objects does. Elsewhere a name is only itself.
export function envOf(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = 'win32'): string | undefined {
  if (platform !== 'win32') return env[name];
  let found: string | undefined;
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name.toUpperCase() && value !== undefined) found = value;
  return found;
}

// A drive and a root, or a share: the same place from every working directory.
export const fullyQualified = (path: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/.test(path);

// A path folded for comparison: case, trailing separators and `..`.
const fold = (path: string): string => win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase();

// Where a path really is: short names, junctions, symbolic links and shares resolved by the
// disk. Undefined when the disk cannot say, which is never taken for "somewhere safe".
function located(path: string, realpath: (path: string) => string): string | undefined {
  try {
    return fold(realpath(win32.normalize(path)));
  } catch {
    return undefined;
  }
}

const isFileOnDisk = (path: string): boolean => {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
};

const isExecutableOnDisk = (path: string): boolean => {
  if (!isFileOnDisk(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const dirsOnDisk = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
};

// `reg.exe` by its full path: a bare name would be looked for in the working directory first.
export function regOnDisk(args: string[]): string | undefined {
  const root = envOf(process.env, 'SYSTEMROOT');
  const reg = win32.join(root !== undefined && fullyQualified(root) ? root : 'C:\\Windows', 'System32', 'reg.exe');
  try {
    return execFileSync(reg, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // `reg query` exits 1 when nothing matches: that and any other failure are "nothing here".
    return undefined;
  }
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface WindowsFinder {
  // The first PATH directory that holds the name, with one of PATHEXT's extensions.
  find: (name: string) => string | undefined;
  isFile: (path: string) => boolean;
  // Whether a file may be taken: it, the directory it was found through and the directory it
  // really lives in are all outside every excluded root, and the disk can place each.
  outside: (file: string) => boolean;
}

export function windowsFinder(env: NodeJS.ProcessEnv, options: Pick<LocateOptions, 'exclude' | 'excludeDirs' | 'isFile' | 'realpath'> = {}): WindowsFinder {
  const isFile = options.isFile ?? isFileOnDisk;
  const realpath = options.realpath ?? ((path: string) => realpathSync.native(path));
  const exts = (envOf(env, 'PATHEXT') ?? DEFAULT_PATHEXT).split(';').map((each) => each.trim().toLowerCase()).filter((each) => each.startsWith('.'));
  // Both as written and as the disk resolves it: a root's alias may be the one PATH names.
  const expand = (dirs: readonly string[] | undefined): string[] => (dirs ?? [])
    .filter(fullyQualified).flatMap((dir) => [fold(dir), located(dir, realpath)])
    .filter((each): each is string => each !== undefined);
  const roots = expand(options.exclude);
  const exactDirs = expand(options.excludeDirs);
  const inside = (path: string): boolean =>
    roots.some((root) => path === root || path.startsWith(`${root}\\`))
    || exactDirs.some((dir) => path === dir);
  // Asked only of a directory that holds the name, so a lookup does not reach out to every
  // share on PATH.
  const outside = (file: string): boolean => {
    const dir = win32.dirname(file);
    const real = located(file, realpath);
    const places = [fold(dir), located(dir, realpath), real === undefined ? undefined : fold(win32.dirname(real))];
    return places.every((place) => place !== undefined && !inside(place));
  };
  // A name that already ends in one of them is tried as it is; any other is tried with each.
  const named = (base: string): string[] => (exts.includes(win32.extname(base).toLowerCase()) ? [base] : exts.map((ext) => base + ext));
  const find = (name: string): string | undefined => {
    if (/[\\/]/.test(name)) {
      if (!fullyQualified(name)) return undefined;
      const file = named(win32.normalize(name)).find(isFile);
      return file !== undefined && outside(file) ? file : undefined;
    }
    const dirs = (envOf(env, 'PATH') ?? '').split(';').map((each) => each.trim().replace(/^"(.*)"$/, '$1'))
      .filter(fullyQualified).map((each) => win32.normalize(each));
    for (const dir of dirs) {
      const found = named(win32.join(dir, name)).find(isFile);
      if (found !== undefined && outside(found)) return found;
    }
    return undefined;
  };
  return { find, isFile, outside };
}

// Canonical containment check for POSIX paths so a PATH entry, managed prefix, or symlink
// resolving inside an excluded task checkout directory can never be launched as an executor.
function posixOutside(options: Pick<LocateOptions, 'exclude' | 'excludeDirs' | 'realpath'>): (file: string) => boolean {
  const excluded = (options.exclude ?? []).filter((dir) => posix.isAbsolute(dir));
  const exactExcluded = (options.excludeDirs ?? []).filter((dir) => posix.isAbsolute(dir));
  if (excluded.length === 0 && exactExcluded.length === 0) return () => true;
  const realpath = options.realpath ?? ((path: string) => realpathSync.native(path));
  const resolveOrUndef = (path: string): string | undefined => {
    try { return posix.normalize(realpath(path)); } catch { return undefined; }
  };
  const norm = (path: string): string => posix.normalize(path).replace(/\/+$/, '') || '/';
  const expandDirs = (dirs: readonly string[]): string[] => dirs.flatMap((dir) => {
    const resolved = resolveOrUndef(dir);
    return resolved === undefined ? [norm(dir)] : [norm(dir), norm(resolved)];
  });
  const roots = expandDirs(excluded);
  const exactDirs = expandDirs(exactExcluded);
  const inside = (path: string): boolean => {
    const p = norm(path);
    return roots.some((root) => p === root || (root === '/' ? p.startsWith('/') : p.startsWith(`${root}/`)))
      || exactDirs.some((dir) => p === dir);
  };
  return (file: string): boolean => {
    const dir = posix.dirname(file);
    const real = resolveOrUndef(file);
    const places = [dir, resolveOrUndef(dir), real === undefined ? undefined : posix.dirname(real)];
    return places.every((place) => place !== undefined && !inside(place));
  };
}

// The first executable `name` in one of PATH's absolute directories (POSIX).
function posixPath(name: string, env: NodeJS.ProcessEnv, take: (path: string) => boolean): string | undefined {
  if (name.includes('/')) return posix.isAbsolute(name) && take(name) ? name : undefined;
  for (const dir of (env['PATH'] ?? '').split(':').filter((each) => posix.isAbsolute(each))) {
    const file = posix.join(dir, name);
    if (take(file)) return file;
  }
  return undefined;
}

const VERSION_SEGMENT = '<version>';

// Every file a declared path names under `base`, with the version directory it was found in
// when the path has one. In name order, so that equal versions resolve the same way each time.
function expand(base: string, segments: readonly string[], join: (...parts: string[]) => string, listDirs: (dir: string) => string[]): { file: string; version?: string }[] {
  let at: { dir: string; version?: string }[] = [{ dir: base }];
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) return at.map((each) => ({ ...each, file: join(each.dir, segment) }));
    if (segment === '*' || segment === VERSION_SEGMENT) {
      at = at.flatMap((each) => listDirs(each.dir).sort()
        // The whole name is the version, nothing around it: `backup-99.0.0-disabled` is not one.
        .filter((name) => segment === '*' || versionOf(name) === name)
        .map((name) => ({ dir: join(each.dir, name), ...(segment === '*' ? (each.version === undefined ? {} : { version: each.version }) : { version: name }) })));
    } else {
      at = at.map((each) => ({ ...each, dir: join(each.dir, segment) }));
    }
  }
  return [];
}

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// One value line of `reg query`: four spaces, the name, its type, its data.
export const VALUE_LINE = /^\s+(\S.*?)\s{4}(REG_SZ|REG_EXPAND_SZ)\s{4}(.*)$/;

// The folders the uninstall entries with this display name record, as `reg query` prints
// them. A value of the expandable kind has its `%VARIABLE%`s filled in from `env`.
export function installLocations(displayName: string, registry: RegistryQuery, env: NodeJS.ProcessEnv): string[] {
  const found: string[] = [];
  for (const root of UNINSTALL_KEYS) {
    const listing = registry(['query', root, '/s', '/f', displayName, '/d', '/e']);
    if (listing === undefined) continue;
    // A key is taken when one of the value lines under it is its DisplayName with exactly
    // this text: `/f` matches the text in any value.
    let key: string | undefined;
    const keys: string[] = [];
    for (const line of listing.split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) {
        key = line.trim();
        continue;
      }
      const value = VALUE_LINE.exec(line);
      if (key !== undefined && value !== null && value[1] === 'DisplayName' && value[3]!.trim() === displayName && !keys.includes(key)) keys.push(key);
    }
    for (const each of keys) {
      const answer = registry(['query', each, '/v', 'InstallLocation']);
      const value = answer?.split(/\r?\n/).map((line) => VALUE_LINE.exec(line)).find((match) => match?.[1] === 'InstallLocation');
      if (!value) continue;
      let folder = value[3]!.trim().replace(/^"(.*)"$/, '$1');
      if (value[2] === 'REG_EXPAND_SZ') folder = folder.replace(/%([^%]+)%/g, (whole, name: string) => envOf(env, name) ?? whole);
      if (folder !== '' && !found.includes(folder)) found.push(folder);
    }
  }
  return found;
}

// Where Tycho's node-local CLI updater installs user-scoped npm CLIs when the system global
// npm prefix is read-only (e.g. root-owned /usr/local on Linux). Derived solely from the
// machine's own lookup environment, never from host-sent round env.
export function managedCliPrefix(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') {
    const home = envOf(env, 'USERPROFILE', 'win32');
    return home !== undefined && fullyQualified(home) ? win32.join(home, '.tycho', 'cli') : undefined;
  }
  const home = envOf(env, 'HOME', platform);
  return home !== undefined && posix.isAbsolute(home) ? posix.join(home, '.tycho', 'cli') : undefined;
}

export function managedCliBinDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  const prefix = managedCliPrefix(env, platform);
  if (prefix === undefined) return undefined;
  return platform === 'win32' ? prefix : posix.join(prefix, 'bin');
}

// Where the command is, or every place that was looked in. Never throws.
export function locate(name: string, options: LocateOptions): Lookup {
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const env = options.env;
  const searched: string[] = [];
  const finder = windows ? windowsFinder(env, options) : undefined;
  const isFile = options.isFile ?? (windows ? isFileOnDisk : isExecutableOnDisk);
  const outsidePosix = windows ? undefined : posixOutside(options);
  const take = (file: string): boolean => (finder === undefined ? isFile(file) && outsidePosix!(file) : finder.isFile(file) && finder.outside(file));
  // Prefer a Tycho-managed user-local CLI binary when present (installed by node/executor-updater.ts
  // after a read-only system prefix prevented in-place upgrade). Only checked for bare command names
  // and omitted from `searched` when absent so default PATH lookup diagnostics stay unchanged.
  if (!/[\\/]/.test(name)) {
    const managedBin = managedCliBinDir(env, platform);
    if (managedBin !== undefined) {
      const managed = finder === undefined
        ? (() => {
            const file = posix.join(managedBin, name);
            return take(file) ? file : undefined;
          })()
        : finder.find(win32.join(managedBin, name));
      if (managed !== undefined) return { path: managed, searched: [managed] };
    }
  }
  const onPath = finder === undefined ? posixPath(name, env, take) : finder.find(name);
  searched.push(/[\\/]/.test(name) ? name : 'PATH');
  if (onPath !== undefined) return { path: onPath, searched };
  const join = windows ? win32.join : posix.join;
  const listDirs = options.listDirs ?? dirsOnDisk;
  const absolute = (path: string): boolean => (windows ? fullyQualified(path) : posix.isAbsolute(path));
  for (const place of options.places ?? placesOf(name)) {
    if (place.kind === 'under') {
      if (!place.platforms.includes(platform)) continue;
      const base = envOf(env, place.variable, platform);
      const shown = place.path.map((segment) => (segment === VERSION_SEGMENT ? '<版本>' : segment));
      if (base === undefined || !absolute(base)) {
        const why = base === undefined ? `没有设置 ${place.variable}` : `${place.variable} 不是绝对路径：${base}`;
        searched.push(`${join(windows ? `%${place.variable}%` : `$${place.variable}`, ...shown)}（${why}）`);
        continue;
      }
      searched.push(join(base, ...shown));
      const files = expand(base, place.path, join, listDirs).filter((each) => take(each.file));
      // The newest version, the first of equal ones; a path with no version takes the first.
      const best = files.reduce<(typeof files)[number] | undefined>((held, each) =>
        held === undefined || (each.version !== undefined && held.version !== undefined && compareVersions(each.version, held.version) > 0) ? each : held, undefined);
      if (best !== undefined) return { path: best.file, searched };
    } else {
      if (!windows) continue;
      const folders = installLocations(place.displayName, options.registry ?? regOnDisk, env).filter(fullyQualified);
      if (folders.length === 0) searched.push(`Windows 卸载登记里的 ${place.displayName}（没有登记）`);
      for (const folder of folders) {
        const file = win32.join(folder, ...place.path);
        searched.push(file);
        if (take(file)) return { path: file, searched };
      }
    }
  }
  return { path: undefined, searched };
}
