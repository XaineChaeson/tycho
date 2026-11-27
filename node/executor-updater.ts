// Node-local executor CLI updater with zero-cache-accumulation hygiene and open-source
// local override support (~/.tycho/executor-updaters.json).
//
// Resolution order for upgrading an executor on a machine:
//   1. Machine-local override config (~/.tycho/executor-updaters.json)
//      Allows custom registries, private wrappers, or explicit per-machine disable.
//   2. Automatic install-method detection based on executor + resolved CLI path:
//      - npm global: runs with an ephemeral `--cache <tmpDir>` deleted in `finally`
//        so repeated updates leave 0 bytes of npm `_cacache` garbage on disk.
//      - pnpm / bun global: uses their content-addressed store without duplicating caches.
//      - brew: runs with HOMEBREW_NO_INSTALL_CLEANUP=0 to prune old versions automatically.
//      - claude native binary: runs `claude update`.
//      - agy native binary: runs `agy update`.
//   3. Clean error guiding the owner to ~/.tycho/executor-updaters.json when the CLI is
//      managed by an external desktop bundle or unknown installer.
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, posix, win32 } from 'node:path';
import { EXECUTOR_UPDATE_OUTPUT_MAX_CHARS } from '../shared/executor-updates.ts';
import type { CommandAnswer, CommandRun } from './executors.ts';
import { shellRun } from './executors.ts';
import { managedCliPrefix } from './locate.ts';

export const EXECUTOR_UPDATERS_FILENAME = 'executor-updaters.json';
export const DEFAULT_EXECUTOR_UPDATE_TIMEOUT_MS = 300_000;
const PROXIED_NPM_FIRST_TRY_TIMEOUT_MS = 90_000;

export interface CustomUpdaterEntry {
  disabled?: boolean;
  argv?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type UpdaterPlan =
  | { kind: 'run'; method: string; argv: string[]; extraEnv?: Record<string, string>; ephemeralNpmCache?: boolean; timeoutMs?: number }
  | { kind: 'disabled'; reason: string }
  | { kind: 'unsupported'; reason: string };

export function executorUpdatersConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.USERPROFILE || env.HOME || homedir();
  return join(home, '.tycho', EXECUTOR_UPDATERS_FILENAME);
}

export function loadCustomUpdater(
  executor: string,
  env: NodeJS.ProcessEnv = process.env,
): { entry: CustomUpdaterEntry | null; error?: string } {
  const file = executorUpdatersConfigPath(env);
  if (!existsSync(file)) return { entry: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { entry: null, error: `读取 ${file} 失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { entry: null, error: `${file} 必须是 JSON 对象（按执行器名映射）` };
  }
  const raw = (parsed as Record<string, unknown>)[executor];
  if (raw === undefined) return { entry: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entry: null, error: `${file} 中 ${executor} 的配置无效` };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.disabled === true) return { entry: { disabled: true } };
  if (!Array.isArray(obj.argv) || obj.argv.length === 0 || !obj.argv.every((s) => typeof s === 'string' && s.trim() !== '')) {
    return { entry: null, error: `${file} 中 ${executor}.argv 必须是非空字符串数组` };
  }
  const customEnv: Record<string, string> = {};
  if (obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)) {
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof v === 'string') customEnv[k] = v;
    }
  }
  const timeoutMs = typeof obj.timeoutMs === 'number' && Number.isFinite(obj.timeoutMs) && obj.timeoutMs >= 5_000
    ? Math.min(600_000, Math.round(obj.timeoutMs))
    : undefined;
  return {
    entry: {
      argv: obj.argv as string[],
      ...(Object.keys(customEnv).length > 0 ? { env: customEnv } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  };
}

function normPath(path: string | undefined): string {
  return (path ?? '').replace(/\\/g, '/').toLowerCase();
}

function isBrewPath(p: string): boolean {
  return p.includes('/opt/homebrew/') || p.includes('/usr/local/cellar/') || p.includes('/linuxbrew/') || p.includes('/homebrew/');
}

function isPnpmPath(p: string): boolean {
  return p.includes('/pnpm/') || p.includes('/.pnpm/') || p.includes('/pnpm-global/');
}

function isBunPath(p: string): boolean {
  return p.includes('/.bun/bin/') || p.includes('/bun/install/global/');
}

function isNpmPath(p: string): boolean {
  return (
    p.includes('/node_modules/')
    || p.includes('/appdata/roaming/npm/')
    || p.includes('/.nvm/')
    || p.includes('/fnm')
    || p.includes('/volta/')
    || p.includes('/npm-global/')
    || p.includes('/.tycho/cli/')
    || p.includes('/n/bin/')
    || p.includes('/nodenv/')
  );
}

function powershellExe(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR;
  if (root && /^[A-Za-z]:[\\/]/.test(root)) {
    return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return 'powershell.exe';
}

function remoteInstallArgv(urlPs1: string, urlSh: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [powershellExe(env), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${urlPs1} | iex`];
  }
  return ['bash', '-c', `curl -fsSL ${urlSh} | bash`];
}

// Determine how to update (or install, when not yet present) an executor CLI on this machine.
export function resolveExecutorUpdaterPlan(
  executor: string,
  installedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): UpdaterPlan {
  const custom = loadCustomUpdater(executor, env);
  if (custom.error) return { kind: 'unsupported', reason: custom.error };
  if (custom.entry?.disabled) {
    return { kind: 'disabled', reason: `本机配置 (${EXECUTOR_UPDATERS_FILENAME}) 已禁用 ${executor} 的远程更新` };
  }
  if (custom.entry?.argv) {
    return {
      kind: 'run',
      method: 'custom',
      argv: custom.entry.argv,
      ...(custom.entry.env ? { extraEnv: custom.entry.env } : {}),
      ...(custom.entry.timeoutMs ? { timeoutMs: custom.entry.timeoutMs } : {}),
    };
  }

  const p = normPath(installedPath);
  const configHint = `可在本机 ~/.tycho/${EXECUTOR_UPDATERS_FILENAME} 为 "${executor}" 配置自定义更新命令`;

  switch (executor) {
    case 'codex': {
      if (isBrewPath(p)) {
        return { kind: 'run', method: 'brew', argv: ['brew', 'upgrade', 'codex'], extraEnv: { HOMEBREW_NO_INSTALL_CLEANUP: '0' } };
      }
      if (isPnpmPath(p)) {
        return { kind: 'run', method: 'pnpm-global', argv: ['pnpm', 'add', '-g', '@openai/codex@latest'] };
      }
      if (isBunPath(p)) {
        return { kind: 'run', method: 'bun-global', argv: ['bun', 'add', '-g', '@openai/codex@latest'] };
      }
      return {
        kind: 'run',
        method: 'npm-global',
        argv: ['npm', 'install', '-g', '@openai/codex@latest', '--no-audit', '--no-fund', '--prefer-online'],
        ephemeralNpmCache: true,
      };
    }
    case 'claude': {
      if (!p) {
        return {
          kind: 'run',
          method: 'claude-install',
          argv: remoteInstallArgv('https://claude.ai/install.ps1', 'https://claude.ai/install.sh', env, platform),
        };
      }
      if (isBrewPath(p)) {
        return { kind: 'run', method: 'brew', argv: ['brew', 'upgrade', 'claude-code'], extraEnv: { HOMEBREW_NO_INSTALL_CLEANUP: '0' } };
      }
      if (isPnpmPath(p)) {
        return { kind: 'run', method: 'pnpm-global', argv: ['pnpm', 'add', '-g', '@anthropic-ai/claude-code@latest'] };
      }
      if (isBunPath(p)) {
        return { kind: 'run', method: 'bun-global', argv: ['bun', 'add', '-g', '@anthropic-ai/claude-code@latest'] };
      }
      if (isNpmPath(p)) {
        return {
          kind: 'run',
          method: 'npm-global',
          argv: ['npm', 'install', '-g', '@anthropic-ai/claude-code@latest', '--no-audit', '--no-fund', '--prefer-online'],
          ephemeralNpmCache: true,
        };
      }
      if (p.includes('/claude-data/')) {
        // Claude Desktop bundles its own claude.exe under Claude-Data where `claude update`
        // reports installMethod='unknown' / broken ~/.local/bin/claude.exe and can stall.
        // Repairing via `claude install latest --force` installs the standalone native binary
        // into ~/.local/bin/claude (checked first by adapters/claude.ts).
        return { kind: 'run', method: 'claude-install-repair', argv: ['claude', 'install', 'latest', '--force'] };
      }
      return { kind: 'run', method: 'claude-builtin', argv: ['claude', 'update'] };
    }
    case 'gemini': {
      // Tycho's gemini adapter drives the standalone Antigravity CLI (`agy`), never `@google/gemini-cli`.
      // Antigravity Desktop / IDE does not bundle `agy`, so an uninstalled machine uses the official installer.
      if (!p) {
        return {
          kind: 'run',
          method: 'agy-install',
          argv: remoteInstallArgv('https://antigravity.google/cli/install.ps1', 'https://antigravity.google/cli/install.sh', env, platform),
        };
      }
      if (isBrewPath(p)) {
        return { kind: 'run', method: 'brew', argv: ['brew', 'upgrade', 'antigravity'], extraEnv: { HOMEBREW_NO_INSTALL_CLEANUP: '0' } };
      }
      return { kind: 'run', method: 'agy-builtin', argv: ['agy', 'update'] };
    }
    case 'dsh': {
      if (isNpmPath(p) && p.includes('dsh')) {
        return {
          kind: 'run',
          method: 'npm-global',
          argv: ['npm', 'install', '-g', 'dsh@latest', '--no-audit', '--no-fund', '--prefer-online'],
          ephemeralNpmCache: true,
        };
      }
      return {
        kind: 'unsupported',
        reason: `dsh 在本机未检测到标准包管理器更新方式（桌面端或内网分发包）。${configHint}`,
      };
    }
    default:
      return {
        kind: 'unsupported',
        reason: `执行器 ${executor} 没有内置远程更新方式。${configHint}`,
      };
  }
}

export interface NpmPrefixFs {
  existsSync?: typeof existsSync;
  statSync?: typeof statSync;
  readFileSync?: typeof readFileSync;
  realpathSync?: (path: string) => string;
  isWritable?: (dir: string) => boolean;
  mkdirSync?: (dir: string) => void;
}

const MAX_WRAPPER_BYTES = 8_192;

function defaultIsWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function prefixFromNodeModulesPath(filePath: string, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') {
    const match = /^([A-Za-z]:[\\/][^"'`\r\n]*?)[\\/]node_modules(?:[\\/]|$)/i.exec(filePath.trim());
    return match?.[1] ? win32.normalize(match[1]) : undefined;
  }
  const match = /^(\/[^"'`\s]*?)\/lib\/node_modules(?:\/|$)/.exec(filePath.trim());
  return match?.[1] ? posix.normalize(match[1]) : undefined;
}

// Infer the npm global prefix an installed CLI lives under — following symlinks and small shell/cmd
// wrapper scripts (e.g. a root-owned `/usr/local/bin/codex` wrapper pointing into `~/.local/lib/node_modules`).
export function inferNpmPrefix(
  installedPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  fsDeps: NpmPrefixFs = {},
): string | undefined {
  if (!installedPath || installedPath.trim() === '') return undefined;
  const exists = fsDeps.existsSync ?? existsSync;
  const stat = fsDeps.statSync ?? statSync;
  const readFile = fsDeps.readFileSync ?? readFileSync;
  const resolveReal = fsDeps.realpathSync ?? ((p: string) => realpathSync(p));

  const candidates: string[] = [];
  try {
    const st = stat(installedPath);
    if (st.isFile() && st.size > 0 && st.size <= MAX_WRAPPER_BYTES) {
      const content = readFile(installedPath, 'utf8');
      const pattern = platform === 'win32'
        ? /[A-Za-z]:[\\/][^"'`\r\n]*?[\\/]node_modules[\\/][^"'`\r\n]*/gi
        : /\/[^"'`\s]*?\/lib\/node_modules\/[^"'`\s]*/g;
      for (const hit of content.matchAll(pattern)) {
        candidates.push(hit[0]);
      }
    }
  } catch {
    // Non-readable or non-existent on fake/test disks; continue with path-based inference.
  }
  try {
    candidates.push(resolveReal(installedPath));
  } catch {
    // Fall back to the path as reported.
  }
  candidates.push(installedPath);

  for (const candidate of candidates) {
    const prefix = prefixFromNodeModulesPath(candidate, platform);
    if (prefix) return prefix;
  }

  if (platform === 'win32') {
    const dir = win32.dirname(installedPath);
    if (dir && dir !== installedPath && exists(win32.join(dir, 'node_modules'))) return dir;
    return undefined;
  }
  const binMatch = /^(\/[^"'`\s]*?)\/bin\/[^/]+$/.exec(installedPath);
  if (binMatch?.[1] && exists(posix.join(binMatch[1], 'lib', 'node_modules'))) {
    return posix.normalize(binMatch[1]);
  }
  return undefined;
}

export function isWritableNpmPrefix(
  prefix: string,
  platform: NodeJS.Platform = process.platform,
  fsDeps: NpmPrefixFs = {},
): boolean {
  const exists = fsDeps.existsSync ?? existsSync;
  const writable = fsDeps.isWritable ?? defaultIsWritable;
  if (platform === 'win32') {
    const nm = win32.join(prefix, 'node_modules');
    return exists(nm) ? writable(nm) : writable(prefix);
  }
  const libNm = posix.join(prefix, 'lib', 'node_modules');
  const lib = posix.join(prefix, 'lib');
  const bin = posix.join(prefix, 'bin');
  const modulesWritable = exists(libNm) ? writable(libNm) : exists(lib) ? writable(lib) : writable(prefix);
  const binWritable = exists(bin) ? writable(bin) : true;
  return modulesWritable && binWritable;
}

export function isNpmPermissionFailure(answer: Pick<CommandAnswer, 'code' | 'stdout' | 'stderr'>): boolean {
  if (answer.code === 243) return true;
  return /\b(EACCES|EPERM|permission denied)\b/i.test(`${answer.stdout}\n${answer.stderr}`);
}

export function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.HTTP_PROXY?.trim()
    || env.HTTPS_PROXY?.trim()
    || env.http_proxy?.trim()
    || env.https_proxy?.trim()
    || env.ALL_PROXY?.trim()
    || env.all_proxy?.trim(),
  );
}

export function isNetworkOrTimeoutFailure(answer: Pick<CommandAnswer, 'code' | 'failure' | 'stdout' | 'stderr'>): boolean {
  if (answer.failure && /超过 \d+ 毫秒没有回答|ETIMEDOUT|timed?\s*out/i.test(answer.failure)) return true;
  if (answer.code === 0) return false;
  return /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ERR_SOCKET_TIMEOUT|EPROTO)\b|socket hang up|network timeout|tunneling socket|proxy|fetch failed/i
    .test(`${answer.failure ?? ''}\n${answer.stdout}\n${answer.stderr}`);
}

function directConnectionEnv(): Record<string, string> {
  return {
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
    NO_PROXY: '*',
    no_proxy: '*',
    NODE_USE_ENV_PROXY: '',
  };
}

function prependRuntimeNodeToPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  if (!process.execPath) return {};
  const nodeDir = dirname(process.execPath);
  if (!nodeDir) return {};
  const pathKey = platform === 'win32'
    ? (Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH')
    : 'PATH';
  const current = env[pathKey] ?? '';
  if (!current) return {};
  const sep = platform === 'win32' ? ';' : delimiter;
  const parts = current.split(sep).filter(Boolean);
  const existsAlready = parts.some((entry) =>
    platform === 'win32' ? entry.toLowerCase() === nodeDir.toLowerCase() : entry === nodeDir,
  );
  if (existsAlready) return {};
  return { [pathKey]: `${nodeDir}${sep}${current}` };
}

export function trimOutputTail(stdout: string, stderr: string, maxChars = EXECUTOR_UPDATE_OUTPUT_MAX_CHARS): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  if (combined.length <= maxChars) return combined;
  return `…${combined.slice(-maxChars)}`;
}

export interface RunExecutorUpdateOptions {
  executor: string;
  installedPath?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exclude?: string[];
  signal?: AbortSignal;
  run?: CommandRun;
  fs?: NpmPrefixFs;
}

export interface RunExecutorUpdateOutcome {
  ok: boolean;
  method: string;
  error?: string;
  output?: string;
}

// Run the resolved updater command. For npm global installs, an ephemeral `--cache` and logs dir
// are created and removed unconditionally in `finally`, guaranteeing zero cache buildup on disk.
// When the CLI lives in a user-writable prefix, `--prefix` updates it in-place without requiring
// global `.npmrc` edits; when the system prefix is read-only (e.g. root-owned `/usr/local` causing
// EACCES / exit 243), Tycho automatically installs into its managed user-local prefix `~/.tycho/cli`,
// which `node/locate.ts` picks up automatically for probes and Workers.
// When a local proxy stalls or rejects large tarball downloads (e.g. overseas host with a selective
// proxy), Tycho bounds the proxied attempt and automatically retries once via direct connection.
export async function runExecutorUpdate(options: RunExecutorUpdateOptions): Promise<RunExecutorUpdateOutcome> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fsDeps = options.fs ?? {};
  const plan = resolveExecutorUpdaterPlan(options.executor, options.installedPath, env, platform);
  if (plan.kind === 'disabled') return { ok: false, method: 'disabled', error: plan.reason };
  if (plan.kind === 'unsupported') return { ok: false, method: 'unsupported', error: plan.reason };

  const timeoutMs = plan.timeoutMs ?? options.timeoutMs ?? DEFAULT_EXECUTOR_UPDATE_TIMEOUT_MS;
  let ephemeralCacheDir: string | undefined;
  let baseArgv = [...plan.argv];
  let baseExtraEnv: Record<string, string> | undefined = plan.extraEnv ? { ...plan.extraEnv } : undefined;
  if (plan.ephemeralNpmCache) {
    ephemeralCacheDir = mkdtempSync(join(tmpdir(), 'tycho-npm-cache-'));
    baseArgv = [...baseArgv, '--cache', ephemeralCacheDir];
    baseExtraEnv = {
      ...(baseExtraEnv ?? {}),
      ...prependRuntimeNodeToPath(env, platform),
      npm_config_logs_dir: join(ephemeralCacheDir, 'logs'),
      npm_config_fetch_timeout: '45000',
      npm_config_fetch_retries: '1',
      npm_config_fetch_retry_mintimeout: '2000',
      npm_config_fetch_retry_maxtimeout: '5000',
      NODE_USE_ENV_PROXY: '',
    };
  } else if (plan.method === 'claude-builtin' || plan.method === 'claude-install' || plan.method === 'claude-install-repair') {
    baseExtraEnv = { ...(baseExtraEnv ?? {}), NONINTERACTIVE: '1' };
  }

  const run: CommandRun = options.run ?? ((cmdArgv, ms, extraEnv, signal) => shellRun(cmdArgv, ms, platform, {
    env,
    ...(extraEnv ? { extraEnv } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(signal ? { signal } : {}),
  }));

  const ensureDir = fsDeps.mkdirSync ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const managedPrefix = plan.ephemeralNpmCache ? managedCliPrefix(env, platform) : undefined;
  const inferredPrefix = plan.ephemeralNpmCache ? inferNpmPrefix(options.installedPath, platform, fsDeps) : undefined;

  let activeMethod = plan.method;
  let argv = baseArgv;
  let usedManagedPrefix = false;

  if (plan.ephemeralNpmCache && inferredPrefix !== undefined) {
    if (isWritableNpmPrefix(inferredPrefix, platform, fsDeps)) {
      argv = [...baseArgv, '--prefix', inferredPrefix];
      if (managedPrefix !== undefined && inferredPrefix === managedPrefix) {
        activeMethod = 'npm-tycho-local';
        usedManagedPrefix = true;
      }
    } else if (managedPrefix !== undefined) {
      ensureDir(managedPrefix);
      argv = [...baseArgv, '--prefix', managedPrefix];
      activeMethod = 'npm-tycho-local';
      usedManagedPrefix = true;
    }
  }

  const canProxyFallback = plan.method !== 'custom'
    && hasProxyEnv(env)
    && (
      plan.ephemeralNpmCache === true
      || plan.method === 'claude-builtin'
      || plan.method === 'claude-install'
      || plan.method === 'claude-install-repair'
      || plan.method === 'agy-builtin'
      || plan.method === 'agy-install'
    );

  const actionLabel = options.installedPath ? '更新' : '安装';

  try {
    const deadlineMs = Date.now() + timeoutMs;
    const remainingMs = (): number => Math.max(5_000, deadlineMs - Date.now());
    let activeEnv = baseExtraEnv;
    const firstTimeoutMs = canProxyFallback
      ? Math.min(remainingMs(), PROXIED_NPM_FIRST_TRY_TIMEOUT_MS)
      : remainingMs();
    let answer: CommandAnswer = await run(argv, firstTimeoutMs, activeEnv, options.signal);

    if (
      canProxyFallback
      && !options.signal?.aborted
      && Date.now() < deadlineMs - 5_000
      && (answer.failure !== undefined || answer.code !== 0)
      && isNetworkOrTimeoutFailure(answer)
    ) {
      activeEnv = { ...(baseExtraEnv ?? {}), ...directConnectionEnv() };
      answer = await run(argv, remainingMs(), activeEnv, options.signal);
    }

    if (
      plan.ephemeralNpmCache
      && !usedManagedPrefix
      && managedPrefix !== undefined
      && Date.now() < deadlineMs - 5_000
      && answer.failure === undefined
      && answer.code !== null
      && answer.code !== 0
      && isNpmPermissionFailure(answer)
    ) {
      ensureDir(managedPrefix);
      activeMethod = 'npm-tycho-local';
      usedManagedPrefix = true;
      answer = await run([...baseArgv, '--prefix', managedPrefix], remainingMs(), activeEnv, options.signal);
    }

    const output = trimOutputTail(answer.stdout, answer.stderr);
    const claudeDesktopHint = (plan.method === 'claude-builtin' || plan.method === 'claude-install-repair')
      && normPath(options.installedPath).includes('/claude-data/')
      ? '（检测到该 claude 位于 Claude Desktop 内置目录 Claude-Data，网络较慢或目录受控时可改由 Claude Desktop 自动更新，或手动执行 claude install 修复独立 CLI）'
      : '';
    if (answer.failure !== undefined || answer.code === null) {
      return {
        ok: false,
        method: activeMethod,
        error: `${answer.failure ?? `${actionLabel}命令 ${argv[0]} 执行失败`}${claudeDesktopHint}`,
        ...(output ? { output } : {}),
      };
    }
    if (answer.code !== 0) {
      const permHint = plan.ephemeralNpmCache && isNpmPermissionFailure(answer)
        ? '（权限不足 EACCES：当前用户无法写入 npm 目标目录）'
        : '';
      return {
        ok: false,
        method: activeMethod,
        error: `${actionLabel}命令退出码 ${answer.code}（${activeMethod}）${permHint}${claudeDesktopHint}`,
        ...(output ? { output } : {}),
      };
    }
    return {
      ok: true,
      method: activeMethod,
      ...(output ? { output } : {}),
    };
  } finally {
    if (ephemeralCacheDir) {
      try {
        rmSync(ephemeralCacheDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup of temp cache */ }
    }
  }
}
