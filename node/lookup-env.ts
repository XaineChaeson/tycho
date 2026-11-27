// The environment this machine looks its executors' commands up in (docs/design/nodes.md
// §1.2): one per machine, held by its client. The probe and the start of a Worker both hand
// this one to node/locate.ts, so that what a machine reports as installed is what its rounds
// start, and nothing a host sends with a round (its `start.env`) moves where a command is
// found: that environment is the Worker's, given only once the command is found.
//
// On Windows it merges the client's own environment with the system and user PATH values from
// the registry (Task Scheduler / service processes can inherit a stale or minimal PATH that
// misses user-installed CLIs). Elsewhere it is the environment a login shell of this user ends
// up with: a client started by a scheduler has none of the PATH a login has, and the executors
// are usually installed for the login. It is read by having the login shell start this same
// Node and print its environment after a marker, so that whatever the profile scripts print on
// the way is not taken for it.
import { spawn } from 'node:child_process';
import { stopProbeTree } from './hostprocess.ts';
import type { HostProcesses } from './hostprocess.ts';
import { envOf, regOnDisk, VALUE_LINE } from './locate.ts';
import type { RegistryQuery } from './locate.ts';

export const LOOKUP_ENV_TIMEOUT_MS = 6_000;
const MARK = '\u0000TYCHO_LOOKUP_ENV\u0000';
const PRINT = `process.stdout.write(${JSON.stringify(MARK)} + JSON.stringify(process.env))`;
const WIN_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
] as const;

export interface LookupEnv {
  env: NodeJS.ProcessEnv;
  // Why the login shell's environment could not be read, when it could not: the client's own
  // environment is used instead, and this says so.
  problem?: string;
}

export interface LookupEnvOptions {
  platform?: NodeJS.Platform;
  // The environment the client itself runs in.
  inherited?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  timeoutMs?: number;
  // How this machine ends a process group and looks whether it is gone (node/hostprocess.ts).
  processes?: HostProcesses;
  // Windows only: how registry PATH values are read (defaults to `reg.exe`).
  registry?: RegistryQuery;
}

function readWindowsRegistryPath(registry: RegistryQuery, inherited: NodeJS.ProcessEnv): string[] {
  const entries: string[] = [];
  for (const key of WIN_PATH_KEYS) {
    const answer = registry(['query', key, '/v', 'Path']);
    if (!answer) continue;
    const match = answer.split(/\r?\n/).map((line) => VALUE_LINE.exec(line)).find((hit) => hit?.[1]?.toLowerCase() === 'path');
    if (!match) continue;
    let raw = match[3]!.trim();
    if (match[2] === 'REG_EXPAND_SZ') {
      raw = raw.replace(/%([^%]+)%/g, (whole, name: string) => envOf(inherited, name, 'win32') ?? whole);
    }
    for (const part of raw.split(';')) {
      const cleaned = part.trim().replace(/^"(.*)"$/, '$1');
      if (cleaned !== '') entries.push(cleaned);
    }
  }
  return entries;
}

function mergeWindowsPath(inherited: NodeJS.ProcessEnv, registry: RegistryQuery): NodeJS.ProcessEnv {
  const extra = readWindowsRegistryPath(registry, inherited);
  if (extra.length === 0) return inherited;
  const pathKey = Object.keys(inherited).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const existing = (envOf(inherited, 'PATH', 'win32') ?? '')
    .split(';')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .filter((part) => part !== '');
  const fold = (dir: string): string => dir.replace(/[\\/]+$/, '').toLowerCase();
  const seen = new Set(existing.map(fold));
  const added: string[] = [];
  for (const dir of extra) {
    const folded = fold(dir);
    if (folded === '' || seen.has(folded)) continue;
    seen.add(folded);
    added.push(dir);
  }
  if (added.length === 0) return inherited;
  return { ...inherited, [pathKey]: [...existing, ...added].join(';') };
}

// What the login shell printed, after the marker: an object of strings, or nothing.
export function parseLookupEnv(stdout: string): NodeJS.ProcessEnv | undefined {
  const at = stdout.lastIndexOf(MARK);
  if (at < 0) return undefined;
  try {
    const value = JSON.parse(stdout.slice(at + MARK.length)) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, each] of Object.entries(value)) if (typeof each === 'string') env[key] = each;
    return env;
  } catch {
    return undefined;
  }
}

export function readLookupEnv(options: LookupEnvOptions = {}): Promise<LookupEnv> {
  const platform = options.platform ?? process.platform;
  const inherited = options.inherited ?? process.env;
  if (platform === 'win32') return Promise.resolve({ env: mergeWindowsPath(inherited, options.registry ?? regOnDisk) });
  const timeoutMs = options.timeoutMs ?? LOOKUP_ENV_TIMEOUT_MS;
  const fallback = (why: string): LookupEnv => ({ env: inherited, problem: `读不到登录 shell 的环境（${why}），按客户端自己的环境找执行器` });
  return new Promise<LookupEnv>((resolve) => {
    let settled = false;
    const done = (answer: LookupEnv): void => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      resolve(answer);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // macOS defaults to zsh (~/.zprofile holds Homebrew and user PATH entries), while Linux
      // uses bash. `$0` and `$1` work identically in both shells so nothing enters shell text.
      const shell = platform === 'darwin' ? 'zsh' : 'bash';
      child = (options.spawn ?? spawn)(shell, ['-l', '-c', 'exec "$0" -e "$1"', process.execPath, PRINT], {
        env: inherited, stdio: ['ignore', 'pipe', 'ignore'], detached: true,
      });
    } catch (error) {
      resolve(fallback((error as Error).message));
      return;
    }
    const out: Buffer[] = [];
    let timedOut = false;
    const clock = setTimeout(() => {
      timedOut = true;
      // Its own group: a profile script that hangs is ended with the shell, the way a probe
      // past its deadline is (node/executors.ts), and only a look afterwards says it is gone.
      void (async () => {
        const confirmed = child.pid !== undefined && await stopProbeTree(child.pid, platform, options.processes);
        child.stdout?.destroy();
        child.unref();
        done(fallback(`${timeoutMs} 毫秒没有回答${confirmed ? '' : '；无法确认登录 shell 的进程已经结束'}`));
      })();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('error', (error) => { if (!timedOut) done(fallback(error.message)); });
    child.on('close', (code) => {
      if (timedOut) return;
      const env = parseLookupEnv(Buffer.concat(out).toString('utf8'));
      done(env === undefined ? fallback(`退出码 ${code}，没有打印出环境`) : { env });
    });
  });
}
