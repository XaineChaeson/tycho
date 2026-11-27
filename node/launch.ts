// How this machine starts one of an executor's commands: the probe (node/executors.ts) and
// the watch process (node/watch.ts) both ask here, so that a command the probe found is one
// the Worker starts.
//
// The command is found by node/locate.ts: PATH first, then the places its adapter declares.
// On POSIX it is then started as found; the probe still asks inside a login shell, for the
// PATH a login has. On Windows nothing finds the command for us: `spawn('codex')` only
// tries `codex` and `codex.exe`, while an npm install leaves `codex.cmd`, and since Node's
// 2024 fix (CVE-2024-27980) a `.cmd` or `.bat` is refused outright without a shell. So the
// command is looked up the way cmd looks it up (each PATH directory, each PATHEXT
// extension), with rules cmd does not have:
//   - only fully qualified PATH entries (`C:\...`, `\\server\share\...`) count: `\dir` and
//     `dir` mean something else from every working directory, and the path handed to spawn
//     must be the one that was checked;
//   - nothing is taken from a directory of a round (the Task's directory, its `repo/`,
//     anything under them) nor from the working directory, even when PATH names one of them
//     or an alias of one: each candidate is compared where the disk says it really is
//     (junctions, symbolic links, short names, shares), and one the disk cannot place is not
//     taken. What is there came with the code, and it would run before the executor's own
//     read-only limits do;
//   - what is found is started so that the Worker's environment reaches the program:
//       * a real program (`.exe`, `.com`) directly, its arguments quoted by Node;
//       * the wrapper npm's cmd-shim writes (`"%_prog%"  "%dp0%\<script>" %*`) as the node
//         and the script it names, directly: one process fewer than cmd would make;
//       * any other wrapper through cmd, with a command line built so that cmd rewrites none
//         of it. This is the escaping Rust's standard library settled on for the same CVE:
//         every argument with a character outside a known-safe set is quoted, so cmd's
//         `& | < > ^ ( )` are inert; a `"` is doubled and the backslashes before it and before
//         the closing quote are doubled, which is how the C runtime of the program behind the
//         wrapper reads them back; and each `%` becomes `%%cd:~,%`, an empty substring of
//         `%cd%` that leaves the `%` standing and stops cmd from expanding `%NAME%`. A newline
//         cannot be carried at all and is refused rather than cut.
import { readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import type { InstallPlace } from '../adapters/types.ts';
import { CommandMissing, envOf, fullyQualified, locate, windowsFinder } from './locate.ts';
import type { RegistryQuery, WindowsFinder } from './locate.ts';

export { CommandMissing } from './locate.ts';

export interface Launch {
  command: string;
  args: string[];
  // The arguments are a command line already, and Node must not quote them again.
  verbatim: boolean;
  // Where the command was found (node/locate.ts): what a machine reports it runs.
  found?: string;
}

interface LaunchOptions {
  // Where the command runs. Never looked in, like `exclude`.
  cwd?: string;
  // Directories, and everything under them, that are never looked in.
  exclude?: string[];
  isFile?: (path: string) => boolean;
  readFile?: (path: string) => string;
  realpath?: (path: string) => string;
  // For the declared places (node/locate.ts); a test gives its own.
  places?: readonly InstallPlace[];
  listDirs?: (dir: string) => string[];
  registry?: RegistryQuery;
}

// The directories of a machine's rounds, which no command is ever looked up in: every Task's
// (their code arrives there), and this round's Task and its checkout by name as well.
export function roundDirs(dataDir: string, taskDir?: string): string[] {
  return [join(dataDir, 'tasks'), ...(taskDir === undefined ? [] : [taskDir, join(taskDir, 'repo')])];
}

const DIRECT = new Set(['.exe', '.com']);
const MAX_WIN_CMD_LINE = 8000;
const POSIX_ANCHOR_DIRS = ['/usr', '/usr/local', '/opt', '/bin', '/sbin', '/nix', '/Applications', '/Library'];
const POSIX_SYSTEM_DIRS = new Set(['/bin', '/sbin', '/usr/bin', '/usr/sbin']);
const WIN_ANCHOR_VARS = ['USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'SYSTEMROOT'];

// Service managers often launch a node client with an OS system directory as its working
// directory (notably Windows Task Scheduler defaults to `C:\Windows\System32`). Never
// exclude OS system directories as implicit `cwd`s, or built-in Windows programs such as
// `powershell.exe`, `cmd.exe`, and `curl.exe` become unreachable.
function isSystemDir(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    if (!fullyQualified(dir)) return false;
    const fold = (value: string): string => win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
    const target = fold(dir);
    const envs = platform === process.platform ? [env, process.env] : [env];
    const roots = envs.flatMap((source) =>
      ['SYSTEMROOT', 'WINDIR']
        .map((name) => envOf(source, name, 'win32'))
        .filter((each): each is string => each !== undefined && fullyQualified(each))
        .map(fold),
    );
    return roots.some((root) => target === root || target.startsWith(`${root}\\`));
  }
  if (!posix.isAbsolute(dir)) return false;
  const target = posix.normalize(dir).replace(/\/+$/, '') || '/';
  return POSIX_SYSTEM_DIRS.has(target);
}

// A process launched by systemd --user, Task Scheduler, or a login shell often inherits `$HOME`,
// `/` or `C:\Users\<user>` as its working directory. Recursively excluding such a broad root
// would block every user-installed CLI under `~/.local/bin`, `~/.tycho/cli`, or `%APPDATA%\npm`.
// Keep those directories in exact-directory exclusion (`excludeDirs`) so executables planted
// directly in `cwd` are still blocked while subdirectories remain searchable.
function isBroadRoot(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    if (!fullyQualified(dir)) return false;
    const fold = (value: string): string => win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
    const target = fold(dir);
    if (/^[a-z]:$/.test(target) || /^\\\\[^\\]+\\[^\\]+$/.test(target)) return true;
    const envs = platform === process.platform ? [env, process.env] : [env];
    const anchors = envs.flatMap((source) =>
      WIN_ANCHOR_VARS.map((name) => envOf(source, name, 'win32')).filter((each): each is string => each !== undefined && fullyQualified(each)).map(fold));
    return anchors.some((anchor) => anchor === target || anchor.startsWith(`${target}\\`));
  }
  if (!posix.isAbsolute(dir)) return false;
  const norm = (value: string): string => posix.normalize(value).replace(/\/+$/, '') || '/';
  const target = norm(dir);
  if (target === '/') return true;
  const homeEnvs = platform === process.platform ? [env['HOME'], process.env['HOME']] : [env['HOME']];
  const anchors = [
    ...POSIX_ANCHOR_DIRS,
    ...homeEnvs.filter((each): each is string => each !== undefined && posix.isAbsolute(each)),
  ].map(norm);
  return anchors.some((anchor) => anchor === target || anchor.startsWith(`${target}/`));
}

export function launchOf(argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, options: LaunchOptions = {}): Launch {
  const [name, ...args] = argv;
  if (name === undefined || name === '') throw new Error('没有给出要运行的命令');
  // PATH first, then the places the executor's adapter declares (node/locate.ts). Explicit
  // round directories (`options.exclude`) are always excluded recursively; implicit working
  // directories (`options.cwd`, `process.cwd()`) fall back to exact-directory exclusion when
  // they are `$HOME`, a filesystem root, or an ancestor of standard install roots.
  const exclude: string[] = [...(options.exclude ?? [])];
  const excludeDirs: string[] = [];
  const implicitCwds = [
    ...(options.cwd === undefined ? [] : [options.cwd]),
    ...(platform === process.platform ? [process.cwd()] : []),
  ];
  for (const dir of implicitCwds) {
    if (isSystemDir(dir, env, platform)) continue;
    if (isBroadRoot(dir, env, platform)) excludeDirs.push(dir);
    else exclude.push(dir);
  }
  const lookup = locate(name, { ...options, env, platform, exclude, excludeDirs });
  if (lookup.path === undefined) throw new CommandMissing(name, lookup.searched);
  const path = lookup.path;
  if (platform !== 'win32') return { command: path, args, verbatim: false, found: path };
  if (DIRECT.has(win32.extname(path).toLowerCase())) return { command: path, args, verbatim: false, found: path };
  const finder = windowsFinder(env, { ...options, exclude, excludeDirs });
  const shim = npmShim(path, finder, options.readFile ?? ((file) => readFileSync(file, 'utf8')));
  if (shim !== undefined) return { command: shim.node, args: [shim.script, ...args], verbatim: false, found: path };
  const root = envOf(env, 'SYSTEMROOT');
  const cmd = root !== undefined && fullyQualified(root) ? win32.join(root, 'System32', 'cmd.exe') : 'cmd.exe';
  // /e:on is what the `%cd:~,%` substring needs, /v:off keeps `!` literal, /s takes off only
  // the outer pair of quotes around the whole line.
  const line = [batToken(path, true), ...args.map((arg) => batToken(arg))].join(' ');
  if (line.length > MAX_WIN_CMD_LINE) {
    throw new Error(`命令行过长（${line.length} 字符），超过 Windows cmd 限制`);
  }
  return { command: cmd, args: ['/d', '/e:on', '/v:off', '/s', '/c', `"${line}"`], verbatim: true, found: path };
}

// The wrapper npm's cmd-shim writes for a node script, recognised by its own lines and
// nothing looser: anything else, or a script or node that is not there, goes through cmd.
const SHIM_LOCAL = /^\s*SET "_prog=%dp0%\\node\.exe"\s*$/im;
const SHIM_PATH = /^\s*SET "_prog=node"\s*$/im;
const SHIM_RUN = /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & (?:set PATHEXT=%PATHEXT:;\.JS;=;% & )?"%_prog%"\s+"%dp0%\\([^"%]+)" %\*\s*$/im;

function npmShim(path: string, finder: WindowsFinder, readFile: (path: string) => string): { node: string; script: string } | undefined {
  let text: string;
  try {
    text = readFile(path).replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
  const run = SHIM_RUN.exec(text);
  if (run === null || !SHIM_LOCAL.test(text) || !SHIM_PATH.test(text)) return undefined;
  const dir = win32.dirname(path);
  const script = win32.resolve(dir, run[1]!);
  if (!finder.isFile(script) || !finder.outside(script)) return undefined;
  // The shim's own choice: the node beside it, else the one on PATH.
  const local = win32.join(dir, 'node.exe');
  const node = finder.isFile(local) && finder.outside(local) ? local : finder.find('node');
  if (node === undefined || !DIRECT.has(win32.extname(node).toLowerCase())) return undefined;
  return { node, script };
}

// Characters cmd and the C runtime both leave alone outside quotes.
const SAFE = /^[A-Za-z0-9#$*+\-./:?@\\_]+$/;

// One token of a cmd command line, which the program behind the wrapper reads back as
// exactly `arg` (see the top of this file).
export function batToken(arg: string, forceQuote = false): string {
  if (/[\r\n\0]/.test(arg)) throw new Error(`参数里有换行，经 cmd 传不过去：${JSON.stringify(arg.slice(0, 80))}`);
  const quote = forceQuote || arg === '' || arg.endsWith('\\') || !SAFE.test(arg);
  let out = quote ? '"' : '';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1;
      out += char;
      continue;
    }
    if (char === '"') out += `${'\\'.repeat(backslashes)}"`;
    else if (char === '%') out += '%%cd:~,';
    backslashes = 0;
    out += char;
  }
  if (quote) out += `${'\\'.repeat(backslashes)}"`;
  return out;
}
