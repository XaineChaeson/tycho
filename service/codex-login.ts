import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { codexIdentityFromTokens, encodeCodexOAuth, parseCodexAuthFile } from '../adapters/codex-auth.ts';
import { parseCodexModels, readDeviceAuth } from '../adapters/codex.ts';
import type { ModelInfo } from '../adapters/types.ts';
import { shellRun } from '../node/executors.ts';
import { selectProcesses, stopProbeTree, type HostProcesses } from '../node/hostprocess.ts';
import { CommandMissing, launchOf, type Launch } from '../node/launch.ts';
import {
  codexLoginLive,
  duplicateCodexAccountText,
  type CodexLoginReason,
  type CodexLoginState,
  type CodexLoginView,
} from '../shared/codex-login.ts';
import { accountNameProblem, type ExecutorIdentity } from '../shared/logins.ts';
import type { AccountInput, Accounts } from './accounts.ts';
import { InputError } from './errors.ts';
import type { Ctx, Ledger } from './ledger.ts';
import { prepareOwnerOnlyDirectory } from './secrets.ts';

const EXECUTOR = 'codex';
const RAW_LIMIT_CHARS = 32_768;
const MODEL_CATALOG_TIMEOUT_MS = 10_000;

type Closed = 'stopping' | 'upgrading';
const CLOSED_TEXT: Record<Closed, string> = {
  stopping: '服务正在停止，不能开始新的登录',
  upgrading: '服务正在升级，等重启后再登录',
};

export interface CodexLoginOptions {
  dataDir: string;
  ledger: Pick<Ledger, 'listAccounts' | 'loginState' | 'defaultAccountName' | 'noteModels' | 'noteIdentity' | 'transaction'>;
  accounts: Pick<Accounts, 'credentialExecutors' | 'get' | 'put' | 'setCredential'>;
  limitMs: () => number;
  cleanupMs: () => number;
  onRelogin?: (accountId: string) => void;
  platform?: NodeJS.Platform;
  env?: () => NodeJS.ProcessEnv;
  processes?: HostProcesses;
  resolveLaunch?: (argv: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => Launch;
  spawn?: typeof spawn;
  readCatalog?: (env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<{ ok: true; models: ModelInfo[]; at: string } | { ok: false; reason: string }>;
  now?: () => number;
  log?: (line: string) => void;
}

interface Session {
  id: string;
  account: string;
  accountName: string;
  written?: string;
  mode: 'new' | 'relogin';
  ctx: Ctx;
  state: CodexLoginState;
  reason: CodexLoginReason | null;
  url: string | null;
  code: string | null;
  saved: boolean;
  models: { list: ModelInfo[]; at: string | null; refreshing: boolean; reason: string | null };
  identity: ExecutorIdentity;
  deadline: number;
  deadlineTimer?: NodeJS.Timeout;
  raw: string;
  token?: string;
  dir?: string;
  codexHome?: string;
  child?: ChildProcess;
  pid?: number;
  exited: boolean;
  exitCode: number | null;
  ended: boolean;
  endedAt?: number;
  unconfirmed: boolean;
  reclaiming?: Promise<void>;
  abort: AbortController;
}

function sessionsDir(dataDir: string): string {
  return join(dataDir, 'codex-login-sessions');
}

function urlForLog(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'https://(device-auth)';
  }
}

export function createCodexLogin(options: CodexLoginOptions) {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const processes = options.processes ?? selectProcesses(platform);
  const doSpawn = options.spawn ?? spawn;
  const resolveLaunch = options.resolveLaunch ?? ((argv, env, plat) => launchOf(argv, env, plat));
  const log = options.log ?? ((line: string) => console.error(line));
  const sessions = new Map<string, Session>();
  let closed: Closed | null = null;

  const say = (session: Session, what: string): void => log(`Codex 登录（账号 ${session.accountName}）：${what}`);

  const defaultReadCatalog = async (env: NodeJS.ProcessEnv, signal: AbortSignal) => {
    const res = await shellRun(['codex', 'debug', 'models'], MODEL_CATALOG_TIMEOUT_MS, platform, {
      env,
      processes,
      signal,
    });
    if (res.code !== 0) {
      return { ok: false as const, reason: res.failure ?? '读取 Codex 模型目录失败' };
    }
    const models = parseCodexModels(res.stdout);
    return models.length > 0
      ? { ok: true as const, models, at: new Date(now()).toISOString() }
      : { ok: false as const, reason: 'codex debug models 没有返回模型列表' };
  };
  const readCatalog = options.readCatalog ?? defaultReadCatalog;

  const duplicateOf = (session: Session): string | null => {
    const owner = session.identity.quotaOwner;
    if (session.mode !== 'new' || !owner) return null;
    return options.ledger.listAccounts().find((account) =>
      account.executor === EXECUTOR && options.ledger.loginState(account.id).identity.quotaOwner === owner
    )?.name ?? null;
  };

  const previewName = (session: Session): string => session.written ?? options.ledger.defaultAccountName(EXECUTOR);

  const view = (session: Session): CodexLoginView => ({
    id: session.id,
    account: session.account,
    name: session.mode === 'new' && !session.saved ? previewName(session) : options.accounts.get(session.account)?.name ?? session.accountName,
    mode: session.mode,
    state: session.state,
    url: codexLoginLive(session.state) ? session.url : null,
    code: codexLoginLive(session.state) ? session.code : null,
    reason: session.reason,
    saved: session.saved,
    ended: session.ended,
    unconfirmed: session.unconfirmed,
    deadline: new Date(session.deadline).toISOString(),
    models: session.models,
    identity: session.identity,
    duplicate: duplicateOf(session),
  });

  const clearTimers = (session: Session): void => {
    clearTimeout(session.deadlineTimer);
  };

  function reclaim(session: Session): Promise<void> {
    session.reclaiming ??= (async () => {
      session.raw = '';
      const until = now() + options.cleanupMs();
      const child = session.child;
      if (child && !session.exited) {
        try { child.kill(); } catch { /* ignore */ }
      }
      if (session.pid !== undefined && !session.exited) {
        const confirmed = await stopProbeTree(session.pid, platform, processes).catch(() => false);
        if (!confirmed && processes.alive(session.pid)) {
          session.unconfirmed = true;
          say(session, `登录进程尚未确认结束：pid ${session.pid}`);
        }
      }
      while (child && !session.exited && now() < until) await sleep(50);
      if (session.dir) {
        const dir = session.dir;
        for (;;) {
          try {
            rmSync(dir, { recursive: true, force: true });
            break;
          } catch {
            if (now() >= until) {
              say(session, '登录用的临时目录没删掉，下次启动再清理');
              break;
            }
            await sleep(100);
          }
        }
      }
      session.ended = true;
      session.endedAt = now();
    })();
    return session.reclaiming;
  }

  function fail(session: Session, reason: CodexLoginReason): void {
    if (session.state === 'failed' || session.state === 'cancelled') return;
    session.state = 'failed';
    session.reason = reason;
    session.token = undefined;
    session.abort.abort();
    say(session, `没有登录成功：${reason}`);
    clearTimers(session);
    void reclaim(session);
  }

  function expire(session: Session): void {
    if (session.state === 'starting') {
      fail(session, session.raw.trim() === '' ? 'timeout' : 'unreadable');
      return;
    }
    if (session.state === 'waiting') {
      fail(session, 'timeout');
      return;
    }
    if (session.state === 'signed_in' && !session.saved) {
      fail(session, 'timeout');
    }
  }

  function armDeadline(session: Session): void {
    clearTimeout(session.deadlineTimer);
    session.deadlineTimer = setTimeout(() => expire(session), Math.max(0, session.deadline - now()));
    session.deadlineTimer.unref();
  }

  function completeAuth(session: Session, baseEnv: NodeJS.ProcessEnv): void {
    const authFile = session.codexHome ? join(session.codexHome, 'auth.json') : undefined;
    if (!authFile || !existsSync(authFile)) {
      fail(session, 'invalid_auth');
      return;
    }
    let bundle;
    try {
      bundle = parseCodexAuthFile(readFileSync(authFile, 'utf8'), () => new Date(now()).toISOString());
    } catch {
      bundle = undefined;
    }
    if (!bundle) {
      fail(session, 'invalid_auth');
      return;
    }
    const token = encodeCodexOAuth(bundle);
    const identity = codexIdentityFromTokens(bundle);
    session.identity = identity;

    if (session.mode === 'relogin') {
      try {
        options.accounts.setCredential(session.account, token, session.ctx);
        options.ledger.noteIdentity(session.account, identity);
      } catch (err) {
        say(session, `新令牌没存下来：${(err as Error).message}`);
        fail(session, 'not_saved');
        return;
      }
      session.saved = true;
      session.state = 'signed_in';
      clearTimers(session);
      say(session, '已登录，新令牌已经换上');
      options.onRelogin?.(session.account);
      void reclaim(session);
      return;
    }

    session.token = token;
    session.state = 'signed_in';
    session.deadline = now() + options.limitMs();
    armDeadline(session);
    say(session, '已登录，等填档位后建账号');
    // Reclaim the CLI and wipe auth.json on disk immediately; token lives in memory until saved/cancelled.
    void reclaim(session);

    session.models.refreshing = true;
    void readCatalog(baseEnv, session.abort.signal).then((answer) => {
      if (session.state !== 'signed_in' || session.saved || session.token !== token) return;
      session.models = answer.ok
        ? { list: answer.models, at: answer.at, refreshing: false, reason: null }
        : { list: [], at: null, refreshing: false, reason: answer.reason };
    }).catch((err: unknown) => {
      if (session.state !== 'signed_in' || session.saved || session.token !== token) return;
      session.models = { list: [], at: null, refreshing: false, reason: (err as Error)?.message ?? String(err) };
    });
  }

  function look(session: Session, baseEnv: NodeJS.ProcessEnv): void {
    if (!codexLoginLive(session.state)) return;
    const parsed = readDeviceAuth(session.raw);
    if (parsed && (session.url !== parsed.url || session.code !== parsed.code)) {
      session.url = parsed.url;
      session.code = parsed.code;
      if (session.state === 'starting') session.state = 'waiting';
      say(session, `设备码授权网址已取得：${urlForLog(parsed.url)}`);
    }
    if (!session.exited) return;
    if (session.exitCode === 0) {
      completeAuth(session, baseEnv);
    } else {
      fail(session, session.state === 'starting' && parsed === undefined ? 'unreadable' : 'exit');
    }
  }

  async function begin(session: Session): Promise<void> {
    if (closed !== null) {
      fail(session, 'stopped');
      return;
    }
    const baseEnv = options.env?.() ?? process.env;
    let launch: Launch;
    try {
      launch = resolveLaunch(['codex', 'login', '--device-auth'], baseEnv, platform);
    } catch (err) {
      say(session, (err as Error).message);
      fail(session, err instanceof CommandMissing ? 'no_cli' : 'start_failed');
      return;
    }

    const root = sessionsDir(options.dataDir);
    prepareOwnerOnlyDirectory(root);
    const dir = join(root, session.id);
    prepareOwnerOnlyDirectory(dir);
    session.dir = dir;
    const home = join(dir, 'home');
    const codexHome = join(dir, 'codex-home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    if (platform === 'win32') mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
    session.codexHome = codexHome;

    const env: NodeJS.ProcessEnv = { ...baseEnv };
    for (const key of Object.keys(env)) {
      if (/^(CODEX_API_KEY|OPENAI_API_KEY|CODEX_HOME)$/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      BROWSER: join(dir, 'no-browser.exe'),
    });

    if (!codexLoginLive(session.state)) {
      void reclaim(session);
      return;
    }

    let child: ChildProcess;
    try {
      child = doSpawn(launch.command, launch.args, {
        env,
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        detached: platform !== 'win32',
      });
    } catch (err) {
      say(session, `登录命令启动失败：${(err as Error).message}`);
      fail(session, 'start_failed');
      return;
    }
    session.child = child;
    session.pid = child.pid;

    const onChunk = (chunk: string): void => {
      if (session.reclaiming) return;
      session.raw = (session.raw + chunk).slice(-RAW_LIMIT_CHARS);
      look(session, baseEnv);
    };
    child.stdout?.setEncoding('utf8').on('data', onChunk);
    child.stderr?.setEncoding('utf8').on('data', onChunk);
    child.once('error', (err: NodeJS.ErrnoException) => {
      session.exited = true;
      say(session, `登录命令出错：${err.message}`);
      fail(session, err.code === 'ENOENT' ? 'no_cli' : 'start_failed');
    });
    child.once('close', (code) => {
      session.exited = true;
      session.exitCode = code;
      look(session, baseEnv);
    });
  }

  function live(id: string): Session {
    const session = sessions.get(id);
    if (!session) throw new InputError('没有这次登录：可能服务重启过，重新点一次登录');
    return session;
  }

  function prune(): void {
    for (const [id, session] of sessions) {
      if (session.ended && !session.unconfirmed && session.endedAt !== undefined && now() - session.endedAt > options.limitMs()) {
        sessions.delete(id);
      }
    }
  }

  function cancelSession(session: Session, why: 'cancelled' | 'stopped'): Promise<void> {
    if (codexLoginLive(session.state) || (session.state === 'signed_in' && !session.saved)) {
      session.token = undefined;
      session.abort.abort();
      if (why === 'stopped') {
        session.state = 'failed';
        session.reason = 'stopped';
      } else {
        session.state = 'cancelled';
      }
      say(session, why === 'stopped' ? '服务停止，登录中断' : '已取消');
      clearTimers(session);
    }
    return reclaim(session);
  }

  return {
    executor: EXECUTOR,
    available: (): boolean => true,

    start(account: unknown, mode: unknown, ctx: Ctx): CodexLoginView {
      if (closed !== null) throw new InputError(CLOSED_TEXT[closed]);
      if (mode !== 'new' && mode !== 'relogin') throw new InputError('登录要说明是新账号（new）还是重新登录（relogin）');
      if (!options.accounts.credentialExecutors.includes(EXECUTOR)) throw new InputError('这个服务不保管 Codex 的登录');
      if (mode === 'relogin' && typeof account !== 'string') throw new InputError('重新登录要说明是哪个账号');
      const id = mode === 'new' ? '' : account as string;
      const written = mode === 'new' && typeof account === 'string' && account.trim() !== '' ? account.trim() : undefined;
      const badName = written === undefined ? null : accountNameProblem(written);
      if (badName !== null) throw new InputError(badName);
      const existing = mode === 'new' ? undefined : options.accounts.get(id);
      if (mode === 'relogin' && !existing) throw new InputError(`账号不存在：${id}`);
      if (mode === 'relogin' && existing!.executor !== EXECUTOR) throw new InputError(`账号 ${existing!.name} 不是 Codex 账号`);
      prune();
      for (const other of sessions.values()) {
        if (mode === 'relogin' && other.mode === mode && other.account === id) void cancelSession(other, 'cancelled');
      }
      const session: Session = {
        id: randomUUID(),
        account: id,
        accountName: existing?.name ?? written ?? options.ledger.defaultAccountName(EXECUTOR),
        ...(written === undefined ? {} : { written }),
        mode,
        ctx,
        state: 'starting',
        reason: null,
        url: null,
        code: null,
        saved: false,
        models: { list: [], at: null, refreshing: false, reason: null },
        identity: {},
        deadline: now() + options.limitMs(),
        raw: '',
        exited: false,
        exitCode: null,
        ended: false,
        unconfirmed: false,
        abort: new AbortController(),
      };
      sessions.set(session.id, session);
      armDeadline(session);
      say(session, mode === 'new' ? '开始设备码登录新账号' : '开始设备码重新登录');
      void begin(session).catch((err: unknown) => {
        say(session, `登录没能开始：${String((err as Error)?.message ?? err)}`);
        fail(session, 'start_failed');
      });
      return view(session);
    },

    get: (id: string): CodexLoginView => view(live(id)),

    save(id: string, input: AccountInput, ctx: Ctx): { login: CodexLoginView; account: ReturnType<Accounts['put']>['account'] } {
      const session = live(id);
      if (session.mode !== 'new') throw new InputError('重新登录不用另外保存：新令牌拿到就已经换上了');
      if (session.state !== 'signed_in' || session.saved || session.token === undefined) throw new InputError('这次登录没有可保存的令牌');
      if (session.models.refreshing) throw new InputError('正在读取可用模型，稍等一下再保存');
      const { account } = options.ledger.transaction(() => {
        const duplicate = duplicateOf(session);
        if (duplicate !== null) throw new InputError(duplicateCodexAccountText(duplicate));
        const saved = options.accounts.put({
          ...input,
          ...(session.written === undefined ? {} : { name: session.written }),
          executor: EXECUTOR,
          credential: session.token,
        }, ctx);
        if (session.models.at !== null && session.models.list.length > 0) {
          options.ledger.noteModels(saved.account.id, session.models.list, session.models.at);
        }
        options.ledger.noteIdentity(saved.account.id, session.identity);
        return saved;
      });
      session.token = undefined;
      session.account = account.id;
      session.accountName = account.name;
      session.saved = true;
      clearTimers(session);
      say(session, '账号已建好');
      return { login: view(session), account };
    },

    cancel(id: string): CodexLoginView {
      const session = live(id);
      void cancelSession(session, 'cancelled');
      return view(session);
    },

    async stopAll({ close = false }: { close?: boolean | 'upgrading' } = {}): Promise<void> {
      if (close === 'upgrading') closed = 'upgrading';
      else if (close) closed = 'stopping';
      await Promise.all([...sessions.values()].map((session) => cancelSession(session, 'stopped')));
    },

    tidy(): void {
      const dir = sessionsDir(options.dataDir);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        try {
          rmSync(join(dir, name), { recursive: true, force: true });
        } catch {
          log('上次 Codex 登录留下的临时目录没删掉，下次启动再清理');
        }
      }
    },

    settled(id: string): Promise<void> {
      const session = live(id);
      return session.reclaiming ?? Promise.resolve();
    },
  };
}

export type CodexLogin = ReturnType<typeof createCodexLogin>;
