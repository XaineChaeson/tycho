// Signing in to a Claude account from the console (docs/design/native-login.md, step 1's first
// half). A login session runs `claude setup-token` through the login helper (ptybridge.ts),
// hands the owner the authorization address, types the code the owner pastes back in once,
// and reads the token off the screen that follows.
//
// What it holds it holds in memory only (§三 C): the session, the CLI's whole raw output — in
// which the pasted code and the token appear in clear — and, for a new account, the token
// until the owner has filled in the tiers. None of it is written to a file, a log line, a
// change row or an event. The log gets what happened, the address up to its query, and, for a
// screen it could not read, the screen's shape (login-screen.ts) and nothing of its text. A
// restart ends every session: the CLI holds the login's secret half in its own memory, so a
// session could not be picked up again anyway.
//
// A session owns every process it starts, from its first moment: the compiler and the
// self-check while the helper is being prepared, then the helper and the CLI. Cancel, the time
// limit and a stop all end the same set the same way and wait for it. They are ended only
// through what this module started and recorded: by the handle they were spawned with, and
// anything that outlived that by the pid it was recorded as, after the system confirms that
// pid still began when it did.
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchOf } from '../node/launch.ts';
import { selectProcesses } from '../node/hostprocess.ts';
import type { FailReason, LoginState, LoginView } from '../shared/claude-login.ts';
import { UNSUPPORTED_TEXT, duplicateAccountText, loginLive } from '../shared/claude-login.ts';
import { accountNameProblem } from '../shared/logins.ts';
import type { AccountInput, Accounts } from './accounts.ts';
import { InputError } from './errors.ts';
import type { Ctx, Ledger } from './ledger.ts';
import { authorizeUrl, outcomeOf, pastePrompt, shapeOf, stripScreen, urlForLog } from './login-screen.ts';
import type { BridgeOptions, Prepared } from './ptybridge.ts';
import { childPidOf, prepareBridge, startBridge, windowsArg, windowsCommandLine } from './ptybridge.ts';
import { secretProblem } from './secrets.ts';
import { readModels, type ModelReadOptions } from './models.ts';

const EXECUTOR = 'claude';

// How much of the CLI's output is held: a bound on memory, not behaviour anyone tunes.
const RAW_LIMIT_CHARS = 2_000_000;
// The code is typed, then Enter after a pause: the CLI's prompt takes a paste as one input.
const ENTER_AFTER_MS = 300;
const MAX_CODE_CHARS = 4_000;

// Why starts are refused, once they are: the service is stopping, or an upgrade is draining it.
type Closed = 'stopping' | 'upgrading';
const CLOSED_TEXT: Record<Closed, string> = {
  stopping: '服务正在停止，过一会儿再登录',
  upgrading: '服务正在升级，稍后再登录',
};

// What a session knows about one process it started: the pid, and when the system says that
// process began. Undefined `start` is a process the system could not place: it is never ended
// by its pid, and a session that cannot see it gone says so.
interface Recorded { pid: number; start: string | undefined }

interface Session {
  id: string;
  account: string;
  accountName: string;
  // A name the caller gave for a new account, if any. Not a requirement and not checked here:
  // the ledger's own rule uses it as the base and numbers it if it is taken.
  written?: string;
  mode: 'new' | 'relogin';
  ctx: Ctx;
  state: LoginState;
  reason: FailReason | null;
  shape: string | null;
  url: string | null;
  saved: boolean;
  models: LoginView['models'];
  identity: LoginView['identity'];
  deadline: number;
  // In memory only, and dropped the moment the session no longer needs it.
  raw: string;
  token: string | undefined;
  // Where in `raw` the code went in.
  mark: number;
  // Nothing has come from the CLI for the settle wait since its last chunk.
  quiet: boolean;
  settleTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
  // The preparation of the helper: ended through `abort`, over when `preparation` settles.
  abort: AbortController;
  preparation?: Promise<void>;
  preparing: Recorded[];
  child?: ChildProcess;
  exited: boolean;
  helper?: Recorded;
  cli?: Recorded;
  // Both processes recorded with when they began: until then the owner is not handed the
  // address, so a login that goes on is one whose processes can be told apart from any other.
  recorded: boolean;
  dir?: string;
  reclaiming?: Promise<void>;
  ended: boolean;
  unconfirmed: boolean;
  endedAt?: number;
}

export interface LoginProcesses {
  alive(pid: number): boolean;
  startOf(pid: number): Promise<string | undefined>;
  endTree(pid: number, signal: 'KILL'): Promise<void>;
}

export interface ClaudeLoginOptions {
  dataDir: string;
  accounts: Pick<Accounts, 'get' | 'put' | 'setCredential' | 'credentialExecutors'>;
  models: ModelReadOptions;
  ledger: Pick<Ledger, 'transaction' | 'noteModels' | 'noteIdentity' | 'loginState' | 'listAccounts' | 'defaultAccountName'>;
  // The owner's settings, read when used: how long one login may take, how long its processes
  // get to be gone once it ends, and how long the result screen must stay still before a token
  // printed last on it counts as whole.
  limitMs: () => number;
  cleanupMs: () => number;
  settleMs: () => number;
  // The command line of `claude setup-token`, found the one way commands are found
  // (node/locate.ts). A test gives its own.
  commandLine?: (env: NodeJS.ProcessEnv) => string;
  // The environment the login starts from. The session's own directories go on top.
  env?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  bridge?: Omit<BridgeOptions, 'dataDir' | 'signal' | 'track'>;
  // The login transport, replaceable without starting a real helper in state tests.
  bridgeRuntime?: { prepare: typeof prepareBridge; start: typeof startBridge };
  processes?: LoginProcesses;
  now?: () => number;
  log?: (line: string) => void;
}

// `claude setup-token` as a command line, by the lookup every executor command goes through.
export function setupTokenCommand(env: NodeJS.ProcessEnv): string {
  const launch = launchOf([EXECUTOR, 'setup-token'], env, 'win32');
  // A wrapper that goes through cmd comes with its command line already built.
  return launch.verbatim ? `${windowsArg(launch.command)} ${launch.args.join(' ')}` : windowsCommandLine([launch.command, ...launch.args]);
}

const sessionsDir = (dataDir: string): string => join(dataDir, 'login-sessions');

// Read afresh: another call may have moved the session on while this one awaited.
const stateOf = (session: { state: LoginState }): LoginState => session.state;

export function createClaudeLogin(options: ClaudeLoginOptions) {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const log = options.log ?? console.error;
  const processes: LoginProcesses = options.processes ?? selectProcesses(platform);
  const commandLine = options.commandLine ?? setupTokenCommand;
  const sessions = new Map<string, Session>();
  // Set the moment a stop or a drain begins, before anything is awaited: no login starts after.
  let closed: Closed | null = null;

  const say = (session: Session, what: string): void => log(`Claude 登录（账号 ${session.accountName}）：${what}`);

  // Consult the current ledger, including at the save's commit: another pending login
  // may have made this account since the model request completed.
  const duplicateOf = (session: Session): string | null => {
    const organization = session.identity.organizationId;
    if (session.mode !== 'new' || !organization) return null;
    return options.ledger.listAccounts().find((account) => account.executor === EXECUTOR
      && options.ledger.loginState(account.id).identity.organizationId === organization)?.name ?? null;
  };

  // What a new account would be called at this moment, for the window to show before the
  // account exists: what the caller wrote, or else the ledger's own rule
  // (docs/design/native-login.md §2).
  const previewName = (session: Session): string => session.written ?? options.ledger.defaultAccountName(EXECUTOR);

  const view = (session: Session): LoginView => ({
    id: session.id,
    account: session.account,
    name: session.mode === 'new' && !session.saved ? previewName(session) : options.accounts.get(session.account)?.name ?? session.accountName,
    mode: session.mode,
    state: session.state,
    url: session.state === 'preparing' || session.state === 'waiting_code' ? session.url : null,
    reason: session.reason,
    shape: session.shape,
    saved: session.saved,
    ended: session.ended,
    unconfirmed: session.unconfirmed,
    deadline: new Date(session.deadline).toISOString(),
    models: session.models,
    identity: session.identity,
    duplicate: duplicateOf(session),
  });

  const clearTimers = (session: Session): void => {
    clearTimeout(session.settleTimer);
    clearTimeout(session.deadlineTimer);
  };

  // The one time limit of a login, from preparing to the tiers: what it ends depends on where
  // the login stands. A result screen that never said anything readable ends as one that cannot
  // be read, with its shape, whether the CLI was slow or the owner was late with the code.
  function expire(session: Session): void {
    switch (session.state) {
      case 'preparing':
        // The address came, the prompt never did: a screen this version cannot read.
        if (authorizeUrl(session.raw) !== undefined) fail(session, 'unrecognized', stripScreen(session.raw));
        else fail(session, 'timeout', session.raw === '' ? undefined : stripScreen(session.raw));
        return;
      case 'waiting_code':
        fail(session, 'timeout');
        return;
      case 'exchanging':
        // A code submitted just before the deadline may not have produced a new byte yet.
        // The screen already held is still evidence, and its shape must not disappear.
        fail(session, 'unrecognized', stripScreen(session.raw.slice(session.mark) || session.raw));
        return;
      case 'signed_in':
        if (!session.saved) fail(session, 'timeout');
        return;
      default:
    }
  }

  const armDeadline = (session: Session): void => {
    clearTimeout(session.deadlineTimer);
    session.deadlineTimer = setTimeout(() => expire(session), Math.max(0, session.deadline - now()));
    session.deadlineTimer.unref();
  };

  // Recorded, or not: a pid whose start the system cannot say is kept as unplaced.
  const record = async (pid: number): Promise<Recorded> => ({ pid, start: await processes.startOf(pid).catch(() => undefined) });

  // A process the preparation started, kept from the moment it starts; its start follows.
  function trackPreparing(session: Session, pid: number): void {
    const entry: Recorded = { pid, start: undefined };
    session.preparing.push(entry);
    void record(pid).then((found) => { entry.start = found.start; });
  }

  // Still the very process recorded: same pid, same moment it began. A pid that is alive but
  // could not be placed is reported as maybe so (`unknown`), and never ended by its number.
  async function standing(each: Recorded): Promise<'gone' | 'ours' | 'unknown'> {
    if (!processes.alive(each.pid)) return 'gone';
    if (each.start === undefined) return 'unknown';
    const start = await processes.startOf(each.pid).catch(() => undefined);
    if (start === undefined) return processes.alive(each.pid) ? 'unknown' : 'gone';
    return start === each.start ? 'ours' : 'gone';
  }

  // Ends what the session started and confirms it is gone: the preparation is stopped and
  // waited for; the helper is ended by its own handle, which takes the command's tree with it
  // (its job object); then every recorded process is looked at by pid and start, and one still
  // standing is ended by that pid, until the owner's wait is up.
  function reclaim(session: Session): Promise<void> {
    session.reclaiming ??= (async () => {
      clearTimeout(session.settleTimer);
      session.raw = '';
      session.abort.abort();
      const until = now() + options.cleanupMs();
      if (session.preparation) {
        const wait = new AbortController();
        try {
          await Promise.race([session.preparation, sleep(Math.max(0, until - now()), undefined, { signal: wait.signal }).catch((err: unknown) => {
            if ((err as Error).name !== 'AbortError') throw err;
          })]);
        } finally {
          wait.abort();
        }
      }
      const child = session.child;
      if (child && !session.exited) child.kill();
      while (child && !session.exited && now() < until) await sleep(50);
      const recorded = (): Recorded[] => [...session.preparing, ...(session.helper ? [session.helper] : []), ...(session.cli ? [session.cli] : [])];
      for (;;) {
        const left: Recorded[] = [];
        let unknown = false;
        for (const each of recorded()) {
          const found = await standing(each);
          if (found === 'ours') left.push(each);
          if (found === 'unknown') unknown = true;
        }
        if (left.length === 0 && !unknown) break;
        if (now() >= until) {
          session.unconfirmed = true;
          say(session, `登录程序尚未确认结束：${recorded().map((each) => `pid ${each.pid}（启动于 ${each.start ?? '未知'}）`).join('、')}`);
          break;
        }
        for (const each of left) await processes.endTree(each.pid, 'KILL').catch(() => undefined);
        await sleep(200);
      }
      // The CLI's own directories: nothing of the login is meant to be in them, and they go.
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
            await sleep(200);
          }
        }
      }
      session.ended = true;
      session.endedAt = now();
    })();
    return session.reclaiming;
  }

  function fail(session: Session, reason: FailReason, screen?: string): void {
    if (session.state === 'failed' || session.state === 'cancelled') return;
    session.state = 'failed';
    session.reason = reason;
    session.token = undefined;
    if (screen !== undefined) {
      session.shape = shapeOf(screen);
      say(session, `${reason}，画面形状：\n${session.shape}`);
    } else say(session, `没有登录成功：${reason}`);
    clearTimers(session);
    void reclaim(session);
  }

  function succeed(session: Session, token: string): void {
    const problem = secretProblem(token);
    // Not something storage takes: as if no token had been read, with the screen's shape.
    if (problem !== null) {
      fail(session, 'unrecognized', stripScreen(session.raw.slice(session.mark)));
      return;
    }
    clearTimeout(session.settleTimer);
    if (session.mode === 'relogin') {
      // Replaced only once the new one is stored: setCredential writes it, then the ledger
      // names it. A failure leaves the account on the token it had.
      try {
        options.accounts.setCredential(session.account, token, session.ctx);
      } catch (err) {
        say(session, `新令牌没存下来：${(err as Error).message}`);
        fail(session, 'not_saved');
        return;
      }
      session.saved = true;
      clearTimeout(session.deadlineTimer);
      say(session, '已登录，新令牌已经换上');
    } else {
      // The account is made with its tiers, which the owner fills in next: until then the token
      // is held here, and only here.
      session.token = token;
      session.deadline = now() + options.limitMs();
      armDeadline(session);
      say(session, '已登录，等填档位后建账号');
      session.models.refreshing = true;
      void readModels({ ...options.models, executor: EXECUTOR, token, now }).then((answer) => {
        // Cancellation or expiry may have let go of this token while HTTP was pending.
        if (session.state !== 'signed_in' || session.saved || session.token !== token) return;
        session.models = answer.ok
          ? { list: answer.models, at: answer.at, refreshing: false, reason: null }
          : { list: [], at: null, refreshing: false, reason: answer.reason };
        session.identity = answer.identity;
      });
    }
    session.state = 'signed_in';
    void reclaim(session);
  }

  // Looks at the screen again after anything changed.
  function look(session: Session): void {
    if (session.state === 'preparing') {
      // The code is taken only once the CLI shows it is asking for one: an address alone is
      // not a CLI ready to read a paste. Waiting for the prompt is bounded by the login's limit.
      const url = authorizeUrl(session.raw);
      if (url !== undefined && session.url !== url) {
        session.url = url;
        say(session, `授权网址已取得：${urlForLog(url)}`);
      }
      if (url !== undefined && session.recorded && pastePrompt(session.raw)) {
        session.state = 'waiting_code';
        return;
      }
      if (session.exited) fail(session, 'start_failed', stripScreen(session.raw));
      return;
    }
    if (session.state === 'waiting_code') {
      if (session.exited) fail(session, 'start_failed', stripScreen(session.raw));
      return;
    }
    if (session.state !== 'exchanging') return;
    const outcome = outcomeOf(session.raw.slice(session.mark), { exited: session.exited, quiet: session.quiet });
    if (outcome.kind === 'token') succeed(session, outcome.token);
    else if (outcome.kind === 'rejected') fail(session, 'rejected');
    else if (outcome.kind === 'unreachable') fail(session, 'unreachable');
    else if (outcome.kind === 'unreadable' || session.exited) fail(session, 'unrecognized', stripScreen(session.raw.slice(session.mark)));
  }

  // Each chunk of the exchange restarts the settle wait; when it runs out with nothing new, the
  // screen is looked at once more as one that has stopped moving.
  function heard(session: Session): void {
    if (session.state !== 'exchanging') return;
    session.quiet = false;
    clearTimeout(session.settleTimer);
    session.settleTimer = setTimeout(() => {
      session.quiet = true;
      look(session);
    }, options.settleMs());
    session.settleTimer.unref();
  }

  async function begin(session: Session): Promise<void> {
    const preparing: Promise<Prepared> = (options.bridgeRuntime?.prepare ?? prepareBridge)({
      dataDir: options.dataDir,
      ...options.bridge,
      signal: session.abort.signal,
      track: (pid) => trackPreparing(session, pid),
    });
    session.preparation = preparing.then(() => undefined, () => undefined);
    const prepared = await preparing;
    // Ended while it was being prepared (cancel, the limit, a stop): nothing more is started.
    if (stateOf(session) !== 'preparing') return;
    if (closed !== null) {
      fail(session, 'stopped');
      return;
    }
    for (const problem of prepared.problems) say(session, problem);
    if (!prepared.bridge) {
      fail(session, 'blocked');
      return;
    }
    const base = options.env?.() ?? process.env;
    let line: string;
    try {
      line = commandLine(base);
    } catch (err) {
      say(session, (err as Error).message);
      fail(session, 'no_cli');
      return;
    }
    // The CLI's own places, all of them the session's: it writes nothing where the owner's
    // Claude Code keeps things, and every trace of it goes with the directory. BROWSER names a
    // program that is not there, so the CLI cannot open a browser on this host.
    const dir = join(sessionsDir(options.dataDir), session.id);
    session.dir = dir;
    const place = (name: string): string => {
      const path = join(dir, name);
      mkdirSync(path, { recursive: true });
      return path;
    };
    // Windows answers "where is the local app data folder" from the home a program is started
    // with, and answers nothing while AppData\Local is missing under it: a program that asks —
    // the PowerShell login assistant — then keeps its module analysis cache in its working
    // directory, which is the service's. The session's home is made whole before anything is
    // started with it.
    const home = place('home');
    if (platform === 'win32') mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
    const env: NodeJS.ProcessEnv = { ...base };
    for (const name of Object.keys(env)) if (/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/i.test(name)) delete env[name];
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      APPDATA: place('appdata'),
      LOCALAPPDATA: place('localappdata'),
      CLAUDE_CONFIG_DIR: place('claude-config'),
      BROWSER: join(dir, 'no-browser.exe'),
    });
    let child: ChildProcess;
    try {
      // The helper's own deadline is the backstop: this module ends it first, with a state to show.
      child = (options.bridgeRuntime?.start ?? startBridge)(prepared.bridge, { deadline: session.deadline + options.cleanupMs(), commandLine: line, env });
    } catch (err) {
      say(session, `登录助手起不来：${(err as Error).message}`);
      fail(session, 'start_failed');
      return;
    }
    session.child = child;
    let errors = '';
    const cliRecorded = Promise.withResolvers<void>();
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      if (session.reclaiming) return;
      session.raw = (session.raw + chunk).slice(-RAW_LIMIT_CHARS);
      heard(session);
      look(session);
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      errors += chunk;
      if (session.cli !== undefined) return;
      const pid = childPidOf(errors);
      if (pid === undefined) return;
      session.cli = { pid, start: undefined };
      void record(pid).then((found) => { session.cli = found; }).finally(cliRecorded.resolve);
    });
    child.once('error', (err) => {
      session.exited = true;
      cliRecorded.resolve();
      say(session, `登录助手起不来：${err.message}`);
      fail(session, 'start_failed');
    });
    child.once('close', () => {
      session.exited = true;
      cliRecorded.resolve();
      look(session);
    });
    if (child.pid !== undefined) {
      session.helper = { pid: child.pid, start: undefined };
      session.helper = await record(child.pid);
    }
    await cliRecorded.promise;
    session.recorded = true;
    look(session);
    // Cancelled while it was starting: what started is ended like any other.
    if (!loginLive(stateOf(session))) void reclaim(session);
  }

  function live(id: string): Session {
    const session = sessions.get(id);
    if (!session) throw new InputError('没有这次登录：可能服务重启过，重新点一次登录');
    return session;
  }

  // Sessions that ended a while ago are forgotten, unless their processes were never seen gone.
  function prune(): void {
    for (const [id, session] of sessions) {
      if (session.ended && !session.unconfirmed && session.endedAt !== undefined && now() - session.endedAt > options.limitMs()) sessions.delete(id);
    }
  }

  // Whatever the session holds is let go of, and what it started is reclaimed — in preparation
  // as much as after it.
  function cancelSession(session: Session, why: 'cancelled' | 'stopped'): Promise<void> {
    if (loginLive(session.state) || (session.state === 'signed_in' && !session.saved)) {
      session.token = undefined;
      if (why === 'stopped') {
        session.state = 'failed';
        session.reason = 'stopped';
      } else session.state = 'cancelled';
      say(session, why === 'stopped' ? '服务停止，登录中断' : '已取消');
      clearTimers(session);
    }
    return reclaim(session);
  }

  return {
    // Whether this host can sign in here at all: the helper is Windows-only for now.
    // The one executor these sessions sign in to.
    executor: EXECUTOR,
    available: (): boolean => platform === 'win32',

    // A new login for an account, or a new account whose name is not decided yet. For a new
    // account nothing is asked but the mode: the name comes from the ledger's own rule at save
    // (docs/design/native-login.md §2). A name a caller still sends is the base for that rule;
    // it is held to the name rule here, before any login is done, so a login that succeeds is
    // never then refused at save for its name. A clash is not refused: the ledger numbers it.
    // Re-logging in names the account it replaces, and
    // whatever login that account had going is cancelled first: one account, one login at a time.
    start(account: unknown, mode: unknown, ctx: Ctx): LoginView {
      if (platform !== 'win32') throw new InputError(UNSUPPORTED_TEXT);
      if (closed !== null) throw new InputError(CLOSED_TEXT[closed]);
      if (mode !== 'new' && mode !== 'relogin') throw new InputError('登录要说明是新账号（new）还是重新登录（relogin）');
      if (!options.accounts.credentialExecutors.includes(EXECUTOR)) throw new InputError('这个服务不保管 Claude 的登录');
      if (mode === 'relogin' && typeof account !== 'string') throw new InputError('重新登录要说明是哪个账号');
      const id = mode === 'new' ? '' : account as string;
      const written = mode === 'new' && typeof account === 'string' && account.trim() !== '' ? account.trim() : undefined;
      const badName = written === undefined ? null : accountNameProblem(written);
      if (badName !== null) throw new InputError(badName);
      const existing = mode === 'new' ? undefined : options.accounts.get(id);
      if (mode === 'relogin' && !existing) throw new InputError(`账号不存在：${id}`);
      if (mode === 'relogin' && existing!.executor !== EXECUTOR) throw new InputError(`账号 ${existing!.name} 不是 Claude 账号`);
      prune();
      // Only a re-login replaces a session: two new accounts are two logins, and neither is
      // tied to a name until it is saved.
      for (const other of sessions.values()) if (mode === 'relogin' && other.mode === mode && other.account === id) void cancelSession(other, 'cancelled');
      const session: Session = {
        id: randomUUID(),
        account: id,
        // A label for the log lines alone; the page reads the name the ledger would give.
        accountName: existing?.name ?? written ?? options.ledger.defaultAccountName(EXECUTOR),
        ...(written === undefined ? {} : { written }),
        mode,
        ctx,
        state: 'preparing',
        reason: null,
        shape: null,
        url: null,
        saved: false,
        models: { list: [], at: null, refreshing: false, reason: null },
        identity: {},
        deadline: now() + options.limitMs(),
        raw: '',
        token: undefined,
        mark: 0,
        quiet: false,
        abort: new AbortController(),
        preparing: [],
        exited: false,
        recorded: false,
        ended: false,
        unconfirmed: false,
      };
      sessions.set(session.id, session);
      armDeadline(session);
      say(session, mode === 'new' ? '开始登录新账号' : '开始重新登录');
      void begin(session).catch((err: unknown) => {
        say(session, `登录没能开始：${String((err as Error)?.message ?? err)}`);
        fail(session, 'start_failed');
      });
      return view(session);
    },

    get: (id: string): LoginView => view(live(id)),

    // The code the owner pasted, typed in once. One attempt takes one code: a code that is not
    // accepted ends the attempt, and "重新授权" is a new one with a new address. How long the
    // exchange may take is what is left of the login's limit.
    submit(id: string, code: unknown): LoginView {
      const session = live(id);
      if (session.state !== 'waiting_code') throw new InputError(session.state === 'exchanging' ? '授权码已经交了，正在核对' : '这次登录现在不收授权码');
      if (typeof code !== 'string' || code.trim() === '') throw new InputError('先贴上授权码');
      const value = code.trim();
      if (value.length > MAX_CODE_CHARS || /[\u0000-\u001f\u007f]/.test(value)) throw new InputError('授权码应为一行文字');
      session.state = 'exchanging';
      session.mark = session.raw.length;
      session.child!.stdin!.write(value);
      setTimeout(() => {
        if (session.state === 'exchanging' && !session.exited) session.child!.stdin!.write('\r');
      }, ENTER_AFTER_MS).unref();
      say(session, '授权码已提交');
      return view(session);
    },

    // A new account, once its login is done: made the one way accounts are made, with the token
    // the login read and the tiers the owner gave. The name is not an input: the ledger decides
    // it in this same transaction (docs/design/native-login.md §2). A refusal (a tier the executor would not take) leaves the token held, for the owner
    // to fix the form and save again.
    save(id: string, input: AccountInput, ctx: Ctx): { login: LoginView; account: ReturnType<Accounts['put']>['account'] } {
      const session = live(id);
      if (session.mode !== 'new') throw new InputError('重新登录不用另外保存：新令牌拿到就已经换上了');
      if (session.state !== 'signed_in' || session.saved || session.token === undefined) throw new InputError('这次登录没有可保存的令牌');
      if (session.models.refreshing) throw new InputError('正在读取可用模型，稍等一下再保存');
      const { account } = options.ledger.transaction(() => {
        const duplicate = duplicateOf(session);
        if (duplicate !== null) throw new InputError(duplicateAccountText(duplicate));
        const saved = options.accounts.put({
          ...input,
          // A name the caller wrote, when there was one. The ledger decides what it becomes.
          ...(session.written === undefined ? {} : { name: session.written }),
          executor: EXECUTOR, credential: session.token,
        }, ctx);
        if (session.models.at !== null) options.ledger.noteModels(saved.account.id, session.models.list, session.models.at);
        options.ledger.noteIdentity(saved.account.id, session.identity);
        return saved;
      });
      session.token = undefined;
      session.account = account.id;
      session.accountName = account.name;
      session.saved = true;
      clearTimeout(session.deadlineTimer);
      say(session, '账号已建好');
      return { login: view(session), account };
    },

    cancel(id: string): LoginView {
      const session = live(id);
      void cancelSession(session, 'cancelled');
      return view(session);
    },

    // Every session ended and its processes reclaimed, preparation included: at a stop, and when
    // an upgrade drains the service. `close` refuses new logins from this moment, before anything
    // is awaited; 'upgrading' says why in the owner's words.
    async stopAll({ close = false }: { close?: boolean | 'upgrading' } = {}): Promise<void> {
      if (close === 'upgrading') closed = 'upgrading';
      else if (close) closed = 'stopping';
      await Promise.all([...sessions.values()].map((session) => cancelSession(session, 'stopped')));
    },

    // What a start does: the directories of sessions a crash ended are nobody's.
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
          log('上次登录留下的临时目录没删掉，下次启动再清理');
        }
      }
    },

    // For tests and the log: what a session recorded about its processes. No secret is here.
    processesOf(id: string): { helper?: Recorded; cli?: Recorded; preparing: Recorded[] } {
      const session = live(id);
      return { ...(session.helper ? { helper: session.helper } : {}), ...(session.cli ? { cli: session.cli } : {}), preparing: [...session.preparing] };
    },

    // Resolves once the session's processes are reclaimed (for tests and a stop).
    settled(id: string): Promise<void> {
      const session = live(id);
      return session.reclaiming ?? Promise.resolve();
    },
  };
}

export type ClaudeLogin = ReturnType<typeof createClaudeLogin>;
