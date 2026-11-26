// Machine-local external quota probe plugin hook.
// Allows any user or team to drop a tiny script into `~/.tycho/quota-probes/<executor>.mjs`
// (or `.js` / `.sh` / `.cmd`, or override directory via `TYCHO_QUOTA_PROBES_DIR`) to report
// proprietary/private gateway balances or custom quota windows without ever forking Tycho
// or letting local API keys leave the machine.
//
// Protocol:
//   - Invoked locally on the machine with env `TYCHO_EXECUTOR=<executor>`
//   - Receives JSON on stdin: `{ "executor": "<executor>", "builtin": { "windows": [...], "error"?: "..." } | null }`
//   - Prints JSON to stdout:
//       `{ "mode"?: "merge" | "replace", "windows": [{ "window": "balance:CNY:39.84", "used": 0, "resets_at": null }] }`
//     or `{ "problem": "reason" }`
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { QuotaWindow } from '../adapters/types.ts';

export interface QuotaPluginInput {
  executor: string;
  builtin: { windows: QuotaWindow[]; error?: string; absent?: boolean } | null;
}

export interface QuotaPluginResult {
  mode: 'merge' | 'replace';
  windows?: QuotaWindow[];
  problem?: string;
}

const DEFAULT_PROBE_SUBDIR = join('.tycho', 'quota-probes');
const MAX_STDOUT_BYTES = 256 * 1024;

export function quotaProbesDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.TYCHO_QUOTA_PROBES_DIR?.trim();
  if (custom) return custom;
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  return join(home, DEFAULT_PROBE_SUBDIR);
}

// Locate a machine-local plugin script for `<executor>`, or return null when none is installed.
export function findQuotaPlugin(
  executor: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { path: string; command: string; args: string[] } | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(executor)) return null;
  const dir = quotaProbesDir(env);
  if (!existsSync(dir)) return null;

  const candidates = platform === 'win32'
    ? [`${executor}.mjs`, `${executor}.js`, `${executor}.cmd`, `${executor}.bat`]
    : [`${executor}.mjs`, `${executor}.js`, `${executor}.sh`, executor];

  for (const name of candidates) {
    const full = join(dir, name);
    if (!existsSync(full)) continue;
    const ext = extname(full).toLowerCase();
    if (ext === '.mjs' || ext === '.js') {
      return { path: full, command: process.execPath, args: [full] };
    }
    if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      return { path: full, command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', full] };
    }
    if (ext === '.sh') {
      return { path: full, command: 'sh', args: [full] };
    }
    return { path: full, command: full, args: [] };
  }
  return null;
}

export function parseQuotaPluginOutput(stdout: string): QuotaPluginResult | { error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) return { error: '额度插件没有输出 JSON' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: '额度插件输出不是合法 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '额度插件输出必须是 JSON 对象' };
  }
  const obj = parsed as Record<string, unknown>;
  const mode: 'merge' | 'replace' = obj.mode === 'replace' ? 'replace' : 'merge';
  if (typeof obj.problem === 'string' && obj.problem.trim() !== '') {
    return { mode, problem: obj.problem.trim() };
  }
  if (!Array.isArray(obj.windows)) {
    return { error: '额度插件输出缺少 windows 数组' };
  }
  const windows: QuotaWindow[] = [];
  for (const item of obj.windows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.window !== 'string' || rec.window.trim() === '') continue;
    const used = typeof rec.used === 'number' && Number.isFinite(rec.used) ? rec.used : 0;
    const resetsAt = typeof rec.resets_at === 'string' && rec.resets_at.trim() !== '' ? rec.resets_at : null;
    windows.push({ window: rec.window.trim(), used, resets_at: resetsAt });
  }
  return { mode, windows };
}

export async function runQuotaPlugin(
  input: QuotaPluginInput,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; signal?: AbortSignal },
): Promise<QuotaPluginResult | { error: string } | null> {
  const env = options.env ?? process.env;
  const plugin = findQuotaPlugin(input.executor, env, options.platform ?? process.platform);
  if (!plugin) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: QuotaPluginResult | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(res);
    };

    const child = spawn(plugin.command, plugin.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...env, TYCHO_EXECUTOR: input.executor },
    });

    const killChild = () => {
      try { child.kill(); } catch { /* ignore */ }
    };
    const onAbort = () => {
      killChild();
      finish({ error: '额度插件已取消' });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      killChild();
      finish({ error: `额度插件 ${plugin.path} 执行超时` });
    }, Math.max(500, options.timeoutMs));

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ error: `运行额度插件失败：${err.message}` });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().slice(-200);
        finish({ error: tail ? `额度插件退出码 ${code}：${tail}` : `额度插件退出码 ${code}` });
        return;
      }
      finish(parseQuotaPluginOutput(stdout));
    });

    try {
      child.stdin?.end(JSON.stringify(input));
    } catch {
      /* ignore broken pipe if plugin exited immediately */
    }
  });
}

// Merge plugin windows with built-in windows (plugin windows overwrite same-key window or append).
export function mergeQuotaWindows(
  builtin: readonly QuotaWindow[],
  extra: readonly QuotaWindow[],
  mode: 'merge' | 'replace',
): QuotaWindow[] {
  if (mode === 'replace') return [...extra];
  const byKey = new Map<string, QuotaWindow>();
  for (const w of builtin) byKey.set(w.window, w);
  for (const w of extra) byKey.set(w.window, w);
  return [...byKey.values()];
}
