// Putting <prefix>/bin on the user's own PATH, and taking it off again. Never the
// system-wide one. What was added is handed back as a record, and only a record is ever
// undone: an entry the owner had before the installer came is not the installer's to remove.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { System } from './system.ts';
import { said, tool } from './system.ts';

export type PathRecord =
  // `file` is the file written, behind any link; `created` when the installer made it.
  | { kind: 'rc'; file: string; line: string; created: boolean }
  | { kind: 'windows'; entry: string };

interface PathChange {
  changed: boolean;
  // Where the entry lives, in the owner's words.
  where: string;
  // Present only when this call added something.
  record?: PathRecord;
}

// For tests: runs between reading a startup file and committing the change to it, where
// an editor or another installer could save.
interface RcHooks {
  beforeCommit?(file: string): void;
}

// ---- Linux and macOS: one line in the shell's startup file ----

const shellOf = (system: System): string => basename(system.env.SHELL ?? '');

// What a bash login shell reads: the first of these that exists, and no other.
const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile'];

export function rcFile(system: System): string {
  const shell = shellOf(system);
  if (shell === 'zsh') return join(system.env.ZDOTDIR || system.home, '.zshrc');
  if (shell === 'fish') return join(system.env.XDG_CONFIG_HOME || join(system.home, '.config'), 'fish', 'config.fish');
  if (shell === 'bash') {
    if (system.platform !== 'darwin') return join(system.home, '.bashrc');
    // Terminal on macOS opens login shells, which do not read .bashrc. A new
    // .bash_profile would end the reading of a .bash_login or .profile already there.
    const candidates = BASH_LOGIN_FILES.map((name) => join(system.home, name));
    return candidates.find((file) => existsSync(file)) ?? candidates[0]!;
  }
  return join(system.home, '.profile');
}

// The trailing mark is how the line is recognised as this installer's.
export function rcLine(system: System, bin: string): string {
  // --path changes this shell's PATH only. Without it fish stores the directory in a
  // universal variable, which stays after the line is gone.
  if (shellOf(system) === 'fish') return `fish_add_path --path "${bin.replace(/[\\"$]/g, '\\$&')}" # tycho`;
  return `export PATH="${bin.replace(/[\\"$`]/g, '\\$&')}:$PATH" # tycho`;
}

// The file a shell ends up reading. A startup file kept in a dotfile repository is a
// link into it, and a rename onto the link would replace it with a plain file.
function behindLinks(file: string): string {
  try {
    return realpathSync.native(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const link = lstatSync(file, { throwIfNoEntry: false });
  return link?.isSymbolicLink() ? resolve(dirname(file), readlinkSync(file)) : file;
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// An editor may have saved the file with CRLF since the line went in.
const isLine = (line: string) => (each: string): boolean => each.replace(/\r$/, '') === line;

// Whole or not at all, with the permissions the file had.
function replace(file: string, content: string): void {
  const mode = statSync(file, { throwIfNoEntry: false })?.mode;
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.tmp`;
  try {
    // Never readable by more than the file was, not even until the chmod; and the chmod
    // because the umask may have taken away more than that.
    writeFileSync(partial, content, mode === undefined ? {} : { mode: mode & 0o7777 });
    if (mode !== undefined) chmodSync(partial, mode & 0o7777);
    renameSync(partial, file);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
}

// `decide` is given the content (null: no file) and answers with the new content, null
// for "no file", or undefined for "leave it". Nothing is written from a read that is no
// longer true: when the file changed in between, the decision is made again on what is
// there now, once.
function change(file: string, decide: (content: string | null) => string | null | undefined, hooks: RcHooks): boolean {
  for (let attempt = 0; ; attempt += 1) {
    const seen = read(file);
    const next = decide(seen);
    if (next === undefined) return false;
    hooks.beforeCommit?.(file);
    if (read(file) !== seen) {
      if (attempt > 0) throw new Error(`${file} 正在被别的程序改，这次没有动它。等它改完再试一次。`);
      continue;
    }
    if (next === null) rmSync(file, { force: true });
    else replace(file, next);
    return true;
  }
}

function addRc(system: System, bin: string, hooks: RcHooks): PathChange {
  const where = rcFile(system);
  const file = behindLinks(where);
  const line = rcLine(system, bin);
  let created = false;
  const changed = change(file, (content) => {
    const text = content ?? '';
    if (text.split('\n').some(isLine(line))) return undefined;
    created = content === null;
    return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
  }, hooks);
  return changed ? { changed, where, record: { kind: 'rc', file, line, created } } : { changed, where };
}

function removeRc({ file, line, created }: Extract<PathRecord, { kind: 'rc' }>, hooks: RcHooks): PathChange {
  const changed = change(file, (content) => {
    const lines = content?.split('\n') ?? [];
    if (!lines.some(isLine(line))) return undefined;
    const rest = lines.filter((each) => !isLine(line)(each)).join('\n');
    // A file the installer made and nobody has used since goes with the line: on macOS
    // an empty .bash_profile still keeps bash from reading .profile.
    return created && rest.trim() === '' ? null : rest;
  }, hooks);
  return { changed, where: file };
}

// ---- Windows: the current user's Path in the registry ----

// The new value, or $null when there is nothing to change. Other entries stay as they
// are, character for character; two spellings of one directory (case, the direction of
// the slashes, one at the end) count as the same entry. Removing takes out one entry:
// the one spelled as it was written when there is one, else the last equivalent.
// PowerShell, because it has to run in the process that reads and writes the registry;
// no double quote in it, so it survives being one argument on a command line.
export const PATH_EDIT_FUNCTION = [
  'function Edit-PathValue([string]$Value, [string]$Entry, [string]$Op) {',
  "  $norm = { param([string]$p) $p.Replace('/', '\\').TrimEnd([char[]]'\\').ToLowerInvariant() }",
  '  $want = & $norm $Entry',
  "  $parts = [string[]]$Value.Split(';')",
  '  $exact = -1',
  '  $same = -1',
  '  for ($i = 0; $i -lt $parts.Length; $i++) {',
  '    if ([string]::Equals($parts[$i], $Entry)) { $exact = $i }',
  '    if ([string]::Equals((& $norm $parts[$i]), $want)) { $same = $i }',
  '  }',
  "  if ($Op -eq 'add') {",
  '    if ($same -ge 0) { return $null }',
  "    if ($Value -eq '' -or $Value.EndsWith(';')) { return $Value + $Entry }",
  "    return $Value + ';' + $Entry",
  '  }',
  '  $at = if ($exact -ge 0) { $exact } else { $same }',
  '  if ($at -lt 0) { return $null }',
  '  $kept = @()',
  '  for ($i = 0; $i -lt $parts.Length; $i++) { if ($i -ne $at) { $kept += $parts[$i] } }',
  "  return [string]::Join(';', [string[]]$kept)",
  '}',
].join('\n');

// Read, edit and write in one process: a value read by one PowerShell and written back by
// another would overwrite whatever a different installer stored in between.
//
// Read as stored, not expanded: writing an expanded value back would freeze every
// %VARIABLE% another program put there. The last two lines tell running programs
// (Explorer, and so new terminals) that the environment changed: setting a variable
// through .NET broadcasts it, writing the registry does not. The answer is plain ASCII:
// PowerShell prints in the console's code page.
const REGISTRY_EDIT = [
  "$ErrorActionPreference = 'Stop'",
  PATH_EDIT_FUNCTION,
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "$old = $key.GetValue($env:TYCHO_VAR, $null, 'DoNotExpandEnvironmentNames')",
  "if ($null -ne $old -and $old -isnot [string]) { throw 'the stored value is not text' }",
  '$kind = if ($null -eq $old) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $key.GetValueKind($env:TYCHO_VAR) }',
  '$new = Edit-PathValue ([string]$old) $env:TYCHO_ENTRY $env:TYCHO_OP',
  "if ($null -eq $new) { 'unchanged'; exit 0 }",
  '$key.SetValue($env:TYCHO_VAR, $new, $kind)',
  "[Environment]::SetEnvironmentVariable('TYCHO_PATH_NOTIFY', '1', 'User')",
  "[Environment]::SetEnvironmentVariable('TYCHO_PATH_NOTIFY', $null, 'User')",
  "'changed'",
].join('\n');

const WINDOWS_WHERE = '当前用户的环境变量';

// True when the value was changed. `variable` is Path everywhere but in a check of this
// very code against a scratch name.
function editWindowsPath(system: System, entry: string, op: 'add' | 'remove', variable = 'Path'): boolean {
  const ran = system.exec(tool(system, 'powershell'), ['-NoProfile', '-NonInteractive', '-Command', REGISTRY_EDIT], {
    env: { TYCHO_VAR: variable, TYCHO_ENTRY: entry, TYCHO_OP: op },
  });
  if (ran.code !== 0) throw new Error(`改不了${WINDOWS_WHERE} PATH：${said(ran)}`);
  const answer = ran.stdout.trim();
  if (answer !== 'changed' && answer !== 'unchanged') throw new Error(`改不了${WINDOWS_WHERE} PATH：PowerShell 的答复看不懂。`);
  return answer === 'changed';
}

export function addToPath(system: System, bin: string, hooks: RcHooks = {}): PathChange {
  if (system.platform !== 'win32') return addRc(system, bin, hooks);
  const changed = editWindowsPath(system, bin, 'add');
  return changed ? { changed, where: WINDOWS_WHERE, record: { kind: 'windows', entry: bin } } : { changed, where: WINDOWS_WHERE };
}

// Undoes what the record says was done, and nothing else.
export function removeFromPath(system: System, record: PathRecord, hooks: RcHooks = {}): PathChange {
  if (record.kind === 'rc') return removeRc(record, hooks);
  return { changed: editWindowsPath(system, record.entry, 'remove'), where: WINDOWS_WHERE };
}
