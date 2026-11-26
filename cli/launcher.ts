// The stable entry point: <prefix>/bin/tycho reads `current` and runs that version with the
// Node the installer found. An upgrade changes `current`, never this file's meaning, so a
// service definition that names the launcher stays good across versions.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { layoutOf } from './paths.ts';

interface LauncherInput {
  prefix: string;
  // Absolute path of the Node to run with.
  node: string;
  platform: NodeJS.Platform;
}

const MARK = 'tycho-launcher';
const NOTE = 'Written by the tycho installer; "tycho doctor --fix" rewrites it. Edits are lost.';
const ASCII = /^[\x20-\x7e]*$/;

const launcherName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'tycho.cmd' : 'tycho');
export const launcherPath = (prefix: string, platform: NodeJS.Platform): string =>
  join(layoutOf(prefix).bin, launcherName(platform));

// What the launcher was written with, readable without parsing either shell's quoting.
// Plain ASCII, and no "%": cmd expands those even in a rem line.
const meta = (node: string): string =>
  JSON.stringify({ node }).replace(/[^\x20-\x7e]|%/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

function shLauncher({ prefix, node, platform }: LauncherInput): string {
  // On Windows this one is for Git Bash, which takes the same paths with forward slashes.
  const [root, program] = [prefix, node].map((path) => (platform === 'win32' ? path.replaceAll('\\', '/') : path));
  return [
    '#!/bin/sh',
    `# ${MARK} ${meta(node)}`,
    `# ${NOTE}`,
    `prefix=${shQuote(root!)}`,
    'version=$(cat "$prefix/current" 2>/dev/null)',
    'entry="$prefix/versions/$version/cli/main.ts"',
    'if [ -z "$version" ] || [ ! -f "$entry" ]; then',
    '  echo "tycho：$prefix/current 指的版本不在了，请重新运行安装脚本。" >&2',
    '  exit 1',
    'fi',
    `exec ${shQuote(program!)} "$entry" "$@"`,
    '',
  ].join('\n');
}

// cmd reads a .cmd in the console's code page, so nothing outside ASCII can be written
// into one: its own location comes from %~dp0, and a Node whose path has such characters
// is named relative to the launcher, where the part both share (the usual case: the
// user's name) drops out.
function cmdNode(prefix: string, node: string): string {
  const literal = (path: string): string => path.replaceAll('%', '%%');
  if (ASCII.test(node)) return literal(node);
  const relative = win32.relative(win32.join(prefix, 'bin'), node);
  if (!win32.isAbsolute(relative) && ASCII.test(relative)) return `%~dp0${literal(relative)}`;
  throw new Error(
    `Node 的路径里有启动器（.cmd 文件）写不了的字符：${node}。把 Node 装到只含英文字符的路径下，或者让安装脚本自带一份（先把现在这个 Node 从 PATH 里拿掉），再装一次。`,
  );
}

function cmdLauncher({ prefix, node }: LauncherInput): string {
  const entry = '"%~dp0..\\versions\\%TYCHO_VERSION%\\cli\\main.ts"';
  return [
    '@echo off',
    `rem ${MARK} ${meta(node)}`,
    `rem ${NOTE}`,
    'setlocal',
    'set "TYCHO_VERSION="',
    '(set /p TYCHO_VERSION=<"%~dp0..\\current") 2>nul',
    `if not exist ${entry} goto missing`,
    // The jump to a label that does not exist ends the batch file, and what follows "||"
    // on the line already read still runs. Node's exit code is then the command's own,
    // and cmd never comes back to this file — which an uninstall deletes while it runs.
    `endlocal & goto #_undefined_# 2>nul || "${cmdNode(prefix, node)}" ${entry} %*`,
    ':missing',
    // English: this text would be read in the console's code page too.
    '>&2 echo tycho: the version named in "%~dp0..\\current" is missing. Run the installer again.',
    'exit /b 1',
    '',
  ].join('\r\n');
}

export function launcherFiles(input: LauncherInput): Record<string, string> {
  return input.platform === 'win32'
    ? { 'tycho.cmd': cmdLauncher(input), tycho: shLauncher(input) }
    : { tycho: shLauncher(input) };
}

export function parseLauncher(content: string): { node: string } | null {
  const found = new RegExp(`${MARK} (\\{.*\\})`).exec(content);
  if (!found) return null;
  try {
    const { node } = JSON.parse(found[1]!) as { node?: unknown };
    return typeof node === 'string' ? { node } : null;
  } catch {
    return null;
  }
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// The Node the launcher on disk runs with, or null when there is no launcher to read.
export function recordedNode(prefix: string, platform: NodeJS.Platform): string | null {
  const content = read(launcherPath(prefix, platform));
  return content === null ? null : (parseLauncher(content)?.node ?? null);
}

// Whether what is on disk is what this version would write for the same Node.
export function launchersCurrent(input: LauncherInput): boolean {
  const { bin } = layoutOf(input.prefix);
  return Object.entries(launcherFiles(input)).every(([name, content]) => read(join(bin, name)) === content);
}

// Each file appears whole or not at all, and one that is already right is left alone: a
// launcher may be the very file running this.
function put(file: string, content: string): void {
  if (read(file) === content) return;
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, content);
  if (!file.endsWith('.cmd')) chmodSync(partial, 0o755);
  renameSync(partial, file);
}

export function writeLaunchers(input: LauncherInput): void {
  const { bin } = layoutOf(input.prefix);
  mkdirSync(bin, { recursive: true });
  for (const [name, content] of Object.entries(launcherFiles(input))) put(join(bin, name), content);
}

export const launcherNames = (platform: NodeJS.Platform): string[] => (platform === 'win32' ? ['tycho.cmd', 'tycho'] : ['tycho']);

// The launchers as they are now, null for one that is not there: what an install that
// fails before it switches versions puts back.
export function savedLaunchers(prefix: string, platform: NodeJS.Platform): Record<string, string | null> {
  const { bin } = layoutOf(prefix);
  return Object.fromEntries(launcherNames(platform).map((name) => [name, read(join(bin, name))]));
}

export function restoreLaunchers(prefix: string, saved: Record<string, string | null>): void {
  const { bin } = layoutOf(prefix);
  for (const [name, content] of Object.entries(saved)) {
    // Only what the failed install changed: whatever else is in the way is not its to move.
    if (read(join(bin, name)) === content) continue;
    if (content === null) rmSync(join(bin, name), { force: true });
    else put(join(bin, name), content);
  }
}
