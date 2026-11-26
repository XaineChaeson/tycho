// A C# program this host compiles for itself, once, and keeps by its source's hash: the
// login helper (service/ptybridge.ts) and the process helper (service/procinfo.ts) share
// this. The compiler is the one .NET Framework 4 puts on every Windows 10 and 11; a host
// without it, or where what came out will not run, is the caller's problem to handle.
//
// Two callers may compile the same source at the same instant (a service and a machine
// client, or two processes of one test): each writes its own draft and renames it into
// place, and the rename settles which one stays.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { win32 } from 'node:path';

// This program's own patience with the compiler, not behaviour the owner tunes.
export const COMPILE_MS = 60_000;

const systemRoot = (): string => process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
export const system32 = (): string => win32.join(systemRoot(), 'System32');

// The compiler .NET Framework 4 puts on every Windows 10 and 11: 64-bit first.
export function defaultCsc(): string | null {
  for (const framework of ['Framework64', 'Framework']) {
    const file = win32.join(systemRoot(), 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (existsSync(file)) return file;
  }
  return null;
}

export const defaultPowershell = (): string => win32.join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export interface RanProgram {
  code: number | null;
  stdout: string;
  stderr: string;
  // Why there is no exit code at all: it would not start, or it was ended.
  failed?: string;
}

// Resolves once the program has ended, aborted or not: an aborted one is ended by Node
// (TerminateProcess on its own handle), and only then is the running over. The caller keeps
// the parts it reads: a compiler's complaints and a query's answer are different things.
export function runProgram(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; track?: (pid: number) => void; maxBuffer?: number } = {},
): Promise<RanProgram> {
  return new Promise((resolve) => {
    const child = execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }), ...(options.env ? { env: options.env } : {}), ...(options.signal ? { signal: options.signal } : {}) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, stdout, stderr, ...(err && code === null ? { failed: String(err.message) } : {}) });
    });
    if (child.pid !== undefined) options.track?.(child.pid);
  });
}

export interface CompileWays {
  source: string;
  // Where the programs are kept: <dir>/<source hash>/<name>.
  dir: string;
  name: string;
  // The compiler, and the arguments that come before its own (a test's stand-in). Never
  // empty here: the caller has already checked that there is one.
  csc: readonly string[];
  // What the program is called in the one failure line, in the caller's words.
  label: string;
  // Compiler arguments of the caller's own, such as a reference: they come before the source.
  references?: readonly string[];
  // Runs the compiler and resolves once it has ended, aborted or not. The caller owns
  // tracking and cancelling it.
  run(program: string, args: string[], timeoutMs: number): Promise<RanProgram>;
  // Whether the caller called this off while the compiler ran.
  aborted?: () => boolean;
}

// The first lines of what a program said on its way, for the one reason a caller reports.
export const firstLines = (text: string): string => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(' / ');

// Where the program for this source is, or would be, made: by the source's hash, so a new
// release that changes the source gets a new one.
export function programPath({ source, dir, name }: Pick<CompileWays, 'source' | 'dir' | 'name'>): string {
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  return win32.join(dir, hash, name);
}

// Return the already compiled program, if present.
export function keptProgram(ways: Pick<CompileWays, 'source' | 'dir' | 'name'>): string | undefined {
  try {
    const file = programPath(ways);
    return existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

// The exe for this source, made once: by its hash, and two callers that compile at once each
// write their own file and the rename settles it. `stopped` is set when the caller called it
// off; `problem` says what went wrong, in the caller's words, for the log.
export async function compiledProgram(ways: CompileWays): Promise<{ file?: string; problem?: string; stopped?: boolean }> {
  const file = programPath(ways);
  if (existsSync(file)) return { file };
  mkdirSync(win32.dirname(file), { recursive: true });
  const draft = win32.join(win32.dirname(file), `${ways.name}.${randomBytes(4).toString('hex')}.tmp.exe`);
  const [program, ...before] = ways.csc as [string, ...string[]];
  const result = await ways.run(program, [...before, '-nologo', '-optimize', `-out:${draft}`, ...(ways.references ?? []), ways.source], COMPILE_MS);
  if (ways.aborted?.() || result.code !== 0 || !existsSync(draft)) {
    rmSync(draft, { force: true });
    if (ways.aborted?.()) return { stopped: true };
    const said = firstLines(`${result.stdout}${result.stderr}${result.failed ?? ''}`);
    return { problem: `编译${ways.label}没成功（${program}）：${said || `退出码 ${result.code}`}` };
  }
  try {
    renameSync(draft, file);
  } catch {
    // Another caller put its copy there first: the same source, the same program.
    rmSync(draft, { force: true });
  }
  return { file };
}
