// Which Claude Code the Router runs, and whether it is signed in. Asked before each
// start of the Router and by the self-check, so neither keeps its own idea of the answer.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { locate, missingText } from '../node/locate.ts';

const LOGIN_CHECK_MS = 8000;
const NPM_SCRIPT = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'];

function isRunnable(file: string, platform: NodeJS.Platform): boolean {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
  if (platform === 'win32') return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The Claude Code a start takes when the owner names none: the one lookup a machine's probe
// and its Workers use as well (node/locate.ts) — PATH first, then the places the Claude
// adapter declares. The service manager that starts the service may not have the shell's
// PATH, which is why the result is shown.
const findAny = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => locate('claude', { env, platform });

// What to start for a given file. Node does not start a .cmd without a shell, and a
// shell would mangle the Router's prompt; npm's shim only runs a script with node, so
// that script is started directly.
export function claudeCommand(file: string): string[] {
  if (!/^\.(cmd|bat)$/i.test(extname(file))) return [file];
  const script = join(dirname(file), ...NPM_SCRIPT);
  if (existsSync(script)) return [process.execPath, script];
  throw new Error(`${file} 是一个 .cmd 脚本，负责人不能直接启动它。请在“设置 › 负责人 › Claude Code 路径”里填 claude.exe 的完整路径`);
}

export interface LoginState {
  // Null when the CLI could not say: too old to know the command, or no answer in time.
  loggedIn: boolean | null;
  // For the pages: the account when signed in, or why nothing is known.
  detail: string;
}

// `claude auth status` prints one JSON object with `loggedIn`. Only that field decides:
// an exit code alone would take a CLI that does not know the command for one that is
// signed out, and keep a working Router from starting.
export function loginState(command: string[], env: NodeJS.ProcessEnv, timeoutMs = LOGIN_CHECK_MS): Promise<LoginState> {
  const [file, ...prefix] = command as [string, ...string[]];
  return new Promise((resolve) => {
    execFile(file, [...prefix, 'auth', 'status'], { env, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      let status: { loggedIn?: unknown; email?: unknown } | undefined;
      try {
        status = JSON.parse(stdout) as typeof status;
      } catch {
        status = undefined;
      }
      if (typeof status?.loggedIn === 'boolean') {
        const account = typeof status.email === 'string' && status.email ? status.email : '';
        resolve({ loggedIn: status.loggedIn, detail: account });
        return;
      }
      const killed = err && 'killed' in err && err.killed;
      resolve({ loggedIn: null, detail: killed ? `${timeoutMs / 1000} 秒内没有答复` : '这个版本的 Claude Code 说不出登录状态' });
    });
  });
}

export interface ClaudeInspection {
  // The file the Router is started from; null when there is none to start.
  path: string | null;
  // What to spawn for it; null together with `problem` set.
  command: string[] | null;
  // Why there is nothing to start, in words for the owner.
  problem: string | null;
  // The path the owner's setting names, when that file is not there and another one was
  // found instead: the start takes the other. Whoever shows it says so, rather than
  // showing it as what the setting asks for.
  settingGone?: string;
  // Null when there is no CLI to ask.
  login: LoginState | null;
  // Set when `login` is not about the process the caller named: that process holds a
  // credential the ledger no longer names, so no question can be put to it. The answer is
  // about the next start, and whoever shows it has to say so.
  loginOfNextStart?: true;
}

// What the owner's setting names that is not there, when it names one. A file that is there
// but cannot be started is not this: that one is answered with what is wrong with it.
export function missingClaudeSetting(cli: string): string | undefined {
  return cli !== '' && !existsSync(cli) ? cli : undefined;
}

// What a start takes for the owner's setting `cli`. Nothing named means the search. A path
// named but not there means the same search, said to replace it: a Claude Code that moved
// with an update should not stop the Router, and the setting is shown to be stale.
function pickClaude(cli: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { path?: string; settingGone?: string; searched: string[] } {
  const settingGone = missingClaudeSetting(cli);
  if (settingGone === undefined && cli !== '') return { path: cli, searched: [] };
  const found = findAny(env, platform);
  return { ...(found.path === undefined ? {} : { path: found.path }), ...(settingGone === undefined ? {} : { settingGone }), searched: found.searched };
}

export const claudePath = (cli: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined =>
  pickClaude(cli, env, platform).path;

// `env` is the environment the Router itself would run in, so the login asked about is
// the Router's.
export async function inspectClaude(
  cli: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeInspection> {
  const nothing = { path: null, command: null, login: null };
  const { path, settingGone, searched } = pickClaude(cli, env, platform);
  const replaced = settingGone === undefined ? {} : { settingGone };
  if (!path) {
    return {
      ...nothing, ...replaced,
      problem: settingGone === undefined
        ? missingText('claude', searched)
        : `设置里填的 Claude Code 路径不存在：${settingGone}；${missingText('claude', searched)}`,
    };
  }
  if (!isRunnable(path, platform)) return { ...nothing, ...replaced, path, problem: `设置里填的 Claude Code 路径不是一个可执行文件：${path}` };
  let command: string[];
  try {
    command = claudeCommand(path);
  } catch (err) {
    return { ...nothing, ...replaced, path, problem: (err as Error).message };
  }
  return { path, command, problem: null, ...replaced, login: await loginState(command, env) };
}
