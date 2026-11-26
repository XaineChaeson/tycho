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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXECUTOR_UPDATE_OUTPUT_MAX_CHARS } from '../shared/executor-updates.ts';
import type { CommandAnswer, CommandRun } from './executors.ts';
import { shellRun } from './executors.ts';

export const EXECUTOR_UPDATERS_FILENAME = 'executor-updaters.json';
export const DEFAULT_EXECUTOR_UPDATE_TIMEOUT_MS = 180_000;

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
    || p.includes('/n/bin/')
    || p.includes('/nodenv/')
  );
}

// Determine how to update an executor CLI on this machine.
export function resolveExecutorUpdaterPlan(
  executor: string,
  installedPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
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
      return { kind: 'run', method: 'claude-builtin', argv: ['claude', 'update'] };
    }
    case 'gemini': {
      if (p.includes('gemini-cli') || isNpmPath(p)) {
        if (isPnpmPath(p)) return { kind: 'run', method: 'pnpm-global', argv: ['pnpm', 'add', '-g', '@google/gemini-cli@latest'] };
        if (isBunPath(p)) return { kind: 'run', method: 'bun-global', argv: ['bun', 'add', '-g', '@google/gemini-cli@latest'] };
        if (p.includes('gemini')) {
          return {
            kind: 'run',
            method: 'npm-global',
            argv: ['npm', 'install', '-g', '@google/gemini-cli@latest', '--no-audit', '--no-fund', '--prefer-online'],
            ephemeralNpmCache: true,
          };
        }
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
}

export interface RunExecutorUpdateOutcome {
  ok: boolean;
  method: string;
  error?: string;
  output?: string;
}

// Run the resolved updater command. For npm global installs, an ephemeral `--cache` temp dir
// is created and removed unconditionally in `finally`, guaranteeing zero cache buildup on disk.
export async function runExecutorUpdate(options: RunExecutorUpdateOptions): Promise<RunExecutorUpdateOutcome> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const plan = resolveExecutorUpdaterPlan(options.executor, options.installedPath, env);
  if (plan.kind === 'disabled') return { ok: false, method: 'disabled', error: plan.reason };
  if (plan.kind === 'unsupported') return { ok: false, method: 'unsupported', error: plan.reason };

  const timeoutMs = plan.timeoutMs ?? options.timeoutMs ?? DEFAULT_EXECUTOR_UPDATE_TIMEOUT_MS;
  let ephemeralCacheDir: string | undefined;
  let argv = [...plan.argv];
  if (plan.ephemeralNpmCache) {
    ephemeralCacheDir = mkdtempSync(join(tmpdir(), 'tycho-npm-cache-'));
    argv = [...argv, '--cache', ephemeralCacheDir];
  }

  const run: CommandRun = options.run ?? ((cmdArgv, ms, extraEnv, signal) => shellRun(cmdArgv, ms, platform, {
    env,
    ...(extraEnv ? { extraEnv } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(signal ? { signal } : {}),
  }));

  try {
    const answer: CommandAnswer = await run(argv, timeoutMs, plan.extraEnv, options.signal);
    const output = trimOutputTail(answer.stdout, answer.stderr);
    if (answer.failure !== undefined || answer.code === null) {
      return {
        ok: false,
        method: plan.method,
        error: answer.failure ?? `更新命令 ${argv[0]} 执行失败`,
        ...(output ? { output } : {}),
      };
    }
    if (answer.code !== 0) {
      return {
        ok: false,
        method: plan.method,
        error: `更新命令退出码 ${answer.code}（${plan.method}）`,
        ...(output ? { output } : {}),
      };
    }
    return {
      ok: true,
      method: plan.method,
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
