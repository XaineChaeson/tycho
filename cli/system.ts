// What a command is handed instead of reaching for the machine itself. Every other
// program the CLI runs goes through `exec` or `launch`, so a test passes fakes and the
// real scheduled tasks, user PATH and service managers are never touched.
import type { Processes } from '../service/processes.ts';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, release as osRelease, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecOptions {
  // Added to this process's environment.
  env?: Record<string, string>;
  cwd?: string;
  // A probe whose own output means nothing: only what its program wrote is read.
  stdio?: 'ignore';
  timeoutMs?: number;
  maxBufferBytes?: number;
}

// Runs a program to its end.
export type Exec = (file: string, args: string[], options?: ExecOptions) => ExecResult;
// Starts a program that outlives this one. Null once it is started; otherwise why it was not.
export type Launch = (file: string, args: string[], options?: ExecOptions) => string | null;

export interface System {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  user: string;
  // -1 on Windows.
  uid: number;
  // The node running this.
  execPath: string;
  nodeVersion: string;
  // What `os.release()` answers, read once here: on Windows that is
  // "<major>.<minor>.<build>", and the build number is the operating system's own fact
  // (see windowsBuild). A test replaces it with the machine it stands in for.
  release: string;
  exec: Exec;
  launch: Launch;
}

export interface Timing {
  pollMs: number;
  // How long a stop may take before it is reported as not finished.
  stopWaitMs: number;
  // How long a start through the service manager may take.
  startWaitMs: number;
}

export interface Cli {
  system: System;
  // The process table a release asks about what is left of the Router drivers; this machine's
  // own unless a test hands in another.
  processes?: Pick<Processes, 'find'>;
  // The directory holding cli/, service/ and package.json.
  appRoot: string;
  out(line: string): void;
  err(line: string): void;
  timing: Timing;
}

const NOT_FOUND = 127;

const realExec: Exec = (file, args, options = {}) => {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...(options.maxBufferBytes === undefined ? {} : { maxBuffer: options.maxBufferBytes }),
    env: { ...process.env, ...options.env },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.stdio === undefined ? {} : { stdio: options.stdio }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  if (result.error) return { code: NOT_FOUND, stdout: '', stderr: result.error.message };
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

// The C runtime's rules, by which a Windows program reads its command line.
const winQuote = (arg: string): string => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;

// Windows offers Node two ways to start a child, and neither outlives this process as a
// console program: a plain child is in a job that is killed when Node exits, and a
// detached one has no console, where PowerShell does nothing and exits. A grandchild is
// outside the job, so cmd starts the program (sharing cmd's own hidden console) and
// returns at once; waiting for cmd is what keeps it from being killed before it has.
//
// cmd expands %NAME% in that text whatever the quoting, so a word holding "%" is refused
// here, not started as something else: a script for PowerShell goes as encodedCommand().
function launchOnWindows(file: string, args: string[], env: NodeJS.ProcessEnv): string | null {
  const words = [file, ...args];
  // Asked here, not of `start`: for a program that is not there it puts up a dialog.
  if (isAbsolute(file) && !existsSync(file)) return `找不到 ${file}`;
  if (words.some((word) => word.includes('%'))) return `要启动的命令里有 %，cmd 会把它当成变量：${words.join(' ')}`;
  const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const started = spawnSync(cmd, [`/d /s /c "start "" /b ${words.map(winQuote).join(' ')}"`], {
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
    env,
  });
  if (started.error) return started.error.message;
  return started.status === 0 ? null : `cmd 的 start 退出码 ${started.status}`;
}

// A PowerShell script as the one argument no shell on the way reads: base64 of UTF-16,
// for -EncodedCommand. A path in it arrives as written, "%NAME%" and quotes included.
export const encodedCommand = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

const realLaunch: Launch = (file, args, options = {}) => {
  if (process.platform === 'win32') return launchOnWindows(file, args, { ...process.env, ...options.env });
  const child = spawn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...options.env },
  });
  // A program that is not there comes back as an event, after this has returned: it is
  // for whoever asked to notice that nothing happened, not for a crash here.
  child.on('error', () => {});
  child.unref();
  return child.pid === undefined ? `${file} 启动不了` : null;
};

export function realSystem(): System {
  const { username, uid } = userInfo();
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    user: username,
    uid,
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    release: osRelease(),
    exec: realExec,
    launch: realLaunch,
  };
}

// Windows tools by their full path: a Git Bash earlier in PATH has its own tar, which
// reads "C:\..." as a remote host.
export function tool(system: Pick<System, 'platform' | 'env'>, name: 'tar' | 'curl' | 'schtasks' | 'powershell' | 'conhost'): string {
  if (system.platform !== 'win32') return name;
  const system32 = join(system.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return name === 'powershell'
    ? join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : join(system32, `${name}.exe`);
}

// The build number of the Windows this runs on, from what `os.release()` says: Windows 10
// and 11 answer "<major>.<minor>.<build>", and callers ask for a third part. Anything else
// — another system, an answer in another shape — is null, and the caller then takes the way
// that works everywhere.
export function windowsBuild(release: string): number | null {
  const third = /^\d+\.\d+\.(\d+)/.exec(release.trim())?.[1];
  return third === undefined ? null : Number(third);
}

// What a program said, when it can be shown: Windows tools answer in the console's code
// page, which reads as noise here.
export function said(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim();
  return /^[\x20-\x7e\s]*$/.test(text) && text !== '' ? `${text}（退出码 ${result.code}）` : `退出码 ${result.code}`;
}
