// The login helper's two ways to run on a Windows host (docs/design/native-login.md §四): the
// C# source beside this file, compiled once with the csc that ships with Windows and kept by
// the source's hash under the data directory; or, where that compiler is missing or what it
// made will not run, the same source compiled in a PowerShell by Add-Type. Before a login uses
// either, a self-check runs a command that only prints and exits, with no secret anywhere
// near it. A machine whose policy refuses both is reported as such; its policy is not touched.
//
// It is not a remote terminal: the only command lines handed to it are the login session's
// own (`claude setup-token`) and the self-check's. Nothing the service answers runs a
// command through it.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { compiledProgram, defaultCsc, defaultPowershell, firstLines, runProgram, system32, type RanProgram } from './csharp.ts';

export const BRIDGE_SOURCE = join(import.meta.dirname, 'ptybridge.cs');

// The width the CLI draws in: wide enough that an authorization address (about 350
// characters) and a token never wrap.
export const BRIDGE_COLS = 500;
export const BRIDGE_ROWS = 50;

const SELF_CHECK_MARK = 'tycho-pty-selftest';
const SELF_CHECK_CODE = 7;

// One argument as the C runtime reads it back (CommandLineToArgvW's rules), which is how both
// a .NET program and node.exe split their command line.
export function windowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let slashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      slashes++;
      continue;
    }
    quoted += char === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  return `${quoted}${'\\'.repeat(slashes * 2)}"`;
}

export const windowsCommandLine = (argv: readonly string[]): string => argv.map((arg) => windowsArg(arg)).join(' ');

// How to start the helper with these arguments: the program and what it is given.
export interface Bridge {
  kind: 'exe' | 'powershell';
  start(args: readonly string[]): { command: string; args: string[] };
}

export interface BridgeOptions {
  dataDir: string;
  source?: string;
  // The compiler and the shell, or null where a test takes one away. A compiler given as a list
  // is a program and the arguments that come before the compiler's own (a test's stand-in).
  csc?: string | readonly string[] | null;
  powershell?: string | null;
  // The self-check's command line, for a test that makes it fail or hang.
  selfCheck?: { commandLine: string; mark: string; code: number };
  // Whoever owns the preparation (a login session) ends it with this: what is running is ended,
  // and nothing more is started.
  signal?: AbortSignal;
  // Told the pid of every process the preparation starts, the moment it starts: the compiler,
  // the self-check's helper and the command inside it. The owner keeps them as its own.
  track?: (pid: number) => void;
}

export interface Prepared {
  bridge?: Bridge;
  // What went wrong on each way that was tried, in the owner's words, for the log. No secret
  // is ever in reach of these: they are the compiler's and the self-check's own lines.
  problems: string[];
}

// Runs one system command for this preparation: the compiler, the self-check's helper or the
// command inside it. Whoever owns the preparation keeps every process it started.
const run = (file: string, args: string[], timeout: number, options: BridgeOptions): Promise<RanProgram> =>
  runProgram(file, args, timeout, { ...(options.signal ? { signal: options.signal } : {}), ...(options.track ? { track: options.track } : {}) });

const STOPPED = '准备登录助手时被叫停';

// The exe for this source, made once and kept beside the data directory — the data directory
// belongs to the user the service runs as, and the directory under it is narrowed to that user
// as it is made and looked at again before every use, as the process helper's cache is
// (service/csharp.ts). The compiling and the keeping are service/csharp.ts's, shared with the
// process helper.
async function compiled(options: BridgeOptions, csc: readonly string[], source: string): Promise<{ file?: string; problem?: string }> {
  const made = await compiledProgram({
    source,
    dir: join(options.dataDir, 'login-helper'),
    name: 'ptybridge.exe',
    csc,
    label: '登录助手',
    run: (program, args, timeout) => run(program, args, timeout, options),
    aborted: () => options.signal?.aborted === true,
  });
  if (made.stopped) return { problem: STOPPED };
  return made.file === undefined ? { problem: made.problem } : { file: made.file };
}

const quotePs = (text: string): string => `'${text.replace(/'/g, "''")}'`;

function exeBridge(file: string): Bridge {
  return { kind: 'exe', start: (args) => ({ command: file, args: [...args] }) };
}

// The arguments ride inside the script, which travels encoded: no file to run, so no
// execution policy applies, and nothing for PowerShell to read from the standard input the
// helper needs.
function powershellBridge(shell: string, source: string): Bridge {
  return {
    kind: 'powershell',
    start(args) {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${quotePs(source)})) -Language CSharp`,
        `exit [PtyBridge]::Run([string[]]@(${args.map(quotePs).join(', ')}))`,
      ].join('\n');
      return {
        command: shell,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      };
    },
  };
}

export interface BridgeRun {
  deadline: number;
  commandLine: string;
  env: NodeJS.ProcessEnv;
}

// The helper started for one command. Its standard input is the channel the helper watches:
// the moment this process is gone, so is the helper, and with it the command's tree.
export function startBridge(bridge: Bridge, { deadline, commandLine, env }: BridgeRun): ChildProcess {
  const { command, args } = bridge.start([String(deadline), String(process.pid), String(BRIDGE_COLS), String(BRIDGE_ROWS), commandLine]);
  return spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

// The pid the helper says it started its command as, from its own stderr line.
export const childPidOf = (stderr: string): number | undefined => {
  const found = /ptybridge: child pid (\d+)/.exec(stderr);
  return found ? Number(found[1]) : undefined;
};

// Starts the helper on a command that only prints a mark and exits with a known code, and
// checks both came back through the pseudoconsole.
async function selfCheck(bridge: Bridge, options: BridgeOptions): Promise<string | null> {
  const check = options.selfCheck ?? {
    commandLine: `${windowsArg(win32.join(system32(), 'cmd.exe'))} /d /c echo ${SELF_CHECK_MARK}& exit /b ${SELF_CHECK_CODE}`,
    mark: SELF_CHECK_MARK,
    code: SELF_CHECK_CODE,
  };
  if (options.signal?.aborted) return STOPPED;
  // The caller owns the deadline and cancels the self-check through signal.
  const child = startBridge(bridge, { deadline: Number.MAX_SAFE_INTEGER, commandLine: check.commandLine, env: process.env });
  if (child.pid !== undefined) options.track?.(child.pid);
  let output = '';
  let errors = '';
  let inner: number | undefined;
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    errors += chunk;
    if (inner !== undefined) return;
    inner = childPidOf(errors);
    if (inner !== undefined) options.track?.(inner);
  });
  // Stopped from outside: the helper ends now, its job takes the command with it, and the
  // check is over only once the helper has closed.
  const stop = (): void => { child.kill(); };
  options.signal?.addEventListener('abort', stop, { once: true });
  const ended = await new Promise<{ code: number | null; failed?: Error }>((resolve) => {
    child.once('error', (failed) => resolve({ code: null, failed }));
    child.once('close', (code) => resolve({ code }));
  });
  options.signal?.removeEventListener('abort', stop);
  if (options.signal?.aborted) return STOPPED;
  if (ended.failed) return `登录助手（${bridge.kind}）起不来：${ended.failed.message}`;
  if (ended.code === check.code && output.includes(check.mark)) return null;
  const said = firstLines(errors.replace(/#< CLIXML[\s\S]*$/, '').replace(/^ptybridge: started \d+\r?$/gm, ''));
  return `登录助手（${bridge.kind}）自检没通过：退出码 ${ended.code}${output.includes(check.mark) ? '' : '，没看到自检输出'}${said ? `，${said}` : ''}`;
}

// The helper this host can use now, checked: the compiled one first, PowerShell second.
export async function prepareBridge(options: BridgeOptions): Promise<Prepared> {
  const source = options.source ?? BRIDGE_SOURCE;
  const problems: string[] = [];
  if (!existsSync(source)) return { problems: [`登录助手的源码不在：${source}`] };
  const given = options.csc === undefined ? defaultCsc() : options.csc;
  const csc = given === null ? null : typeof given === 'string' ? [given] : given;
  if (csc === null || !existsSync(csc[0]!)) problems.push(`这台电脑上没有 C# 编译器${csc ? `（${csc[0]}）` : ''}`);
  else {
    const made = await compiled(options, csc, source);
    if (made.file) {
      const bridge = exeBridge(made.file);
      const problem = await selfCheck(bridge, options);
      if (problem === null) return { bridge, problems };
      problems.push(problem);
    } else problems.push(made.problem!);
  }
  // Stopped: nothing more is tried.
  if (options.signal?.aborted) return { problems };
  const shell = options.powershell === undefined ? defaultPowershell() : options.powershell;
  if (shell === null || !existsSync(shell)) {
    problems.push(`这台电脑上没有 PowerShell${shell ? `（${shell}）` : ''}`);
    return { problems };
  }
  const bridge = powershellBridge(shell, source);
  const problem = await selfCheck(bridge, options);
  if (problem === null) return { bridge, problems };
  problems.push(problem);
  return { problems };
}
