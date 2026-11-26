import './guard.ts';
import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { ADAPTERS } from '../adapters/all.ts';
import type { NormalizedEvent } from '../adapters/types.ts';
import type { Account } from '../runner/snapshot.ts';
import type { RunRow } from '../service/ledger.ts';
import type { Acceptor } from '../service/accept.ts';
import { createAcceptor } from '../service/accept.ts';
import { createAuth } from '../service/auth.ts';
import { InputError } from '../service/errors.ts';
import type { HttpOptions } from '../service/http.ts';
import { createHttp, createStream } from '../service/http.ts';
import type { ReleaseFile } from '../service/releases.ts';
import { knowledgeTokenStore, readSecret, replaceSecret, wecomSecretFile } from '../service/secrets.ts';
import { createInbounds } from '../service/inbound.ts';
import { serviceSettings } from '../service/service-settings.ts';
import { createAccounts } from '../service/accounts.ts';
import { createMachines } from '../service/machines.ts';
import { createNodes } from '../service/nodes.ts';
import { SETTINGS } from '../service/settings.ts';
import { createTools } from '../service/tools.ts';
import type { Fixture } from './helpers.ts';
import { claudeTier, CONSOLE_DIST, fixture, HTTP_TUNED, NODES_TUNED, testCredentialRef, USER } from './helpers.ts';
import { createLogins } from '../service/logins.ts';
import { readReleaseResult } from '../service/releases.ts';

// An account the console tests see: a login tycho keeps, on any machine.
const LOGIN: Account = {
  id: 't1', name: 't1',
  executor: 'claude',
  tiers: { execute: claudeTier('/tiers/execute.json') },
};

// What a test's Runner answers: the HTTP surface's own calls, and what accepting fetches.
type FakeRunner = NonNullable<HttpOptions['runner']> & {
  fetchArtifacts: (run: RunRow, into: string) => Promise<{ files: ReleaseFile[]; problem: string | null }>;
};

export const LOGIN_TOKEN = 'login-secret';
export const TOOL_TOKEN = 'tool-token-of-the-router';
export const SHUTDOWN_TOKEN = 'shutdown-secret';

// The HTTP surface on a real ledger with a stand-in Session Host, signed in the way
// a browser does: link, exchange page, cookie.
export async function consoleApp(
  t: TestContext,
  options: {
    now?: () => number;
    f?: Fixture;
    host?: string;
    toolToken?: string | undefined;
    keepaliveMs?: number;
    channels?: () => unknown;
    runner?: Partial<FakeRunner>;
    models?: HttpOptions['models'];
    quota?: HttpOptions['quota'];
    orphans?: HttpOptions['orphans'];
    backup?: HttpOptions['backup'];
    deployment?: { title: string; value: string }[];
    doctor?: HttpOptions['doctor'];
    waitingLogins?: HttpOptions['waitingLogins'];
    taskWait?: HttpOptions['taskWait'];
    lostGraceMs?: HttpOptions['lostGraceMs'];
    gateway?: HttpOptions['gateway'];
    // The machines that come back by themselves, and the snapshot a machine fetches and the
    // token one round may ask for. Absent means a hub that has seen no machine.
    nodes?: HttpOptions['nodes'];
    roundSnapshot?: HttpOptions['roundSnapshot'];
    roundCredential?: HttpOptions['roundCredential'];
    // Where the built console is. The stand-in under fixtures unless a test says otherwise.
    consoleDir?: string;
    releaseCheck?: HttpOptions['releaseCheck'];
    drain?: HttpOptions['drain'];
    releases?: HttpOptions['releases'];
    // Signing in to a Claude account; absent is a service that offers none.
    claudeLogin?: HttpOptions['claudeLogin'];
    codexLogin?: HttpOptions['codexLogin'];
    weixin?: HttpOptions['weixin'];
    replay?: HttpOptions['replay'];
    // Signing a machine in to one of its executors; absent is a service that offers none.
    signIns?: HttpOptions['signIns'];
    log?: (line: string) => void;
    // What a deleted project's copies are cleared with; the acceptor's sweep unless a test says.
    cleanupAfterProjectDelete?: HttpOptions['cleanupAfterProjectDelete'];
  } = {},
) {
  const f = options.f ?? fixture(t);
  f.ledger.setWhitelist({ console: ['console'] }, USER);
  // The one account the tests dispatch to is in the ledger, where the console keeps them.
  if (!f.ledger.getAccount(LOGIN.id)) f.ledger.putAccount(LOGIN, USER, testCredentialRef(LOGIN.id));
  const machines = createMachines({ ledger: f.ledger });
  // The adapters the service really has: what an account may set, and which executors can
  // hold a login token, comes from them.
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: Object.entries(ADAPTERS).filter(([, each]) => each.credential).map(([id]) => id),
    routingExecutors: ['claude'],
    dataDir: f.dir,
  });
  const logins = createLogins({ ledger: f.ledger, accounts, executors: ADAPTERS });
  const stream = createStream({ keepaliveMs: options.keepaliveMs });
  const runEvents = new Map<string, NormalizedEvent[]>();
  const runListeners = new Map<string, Set<(event: NormalizedEvent, index: number) => void>>();
  const runner: FakeRunner = {
    eventSnapshot: async (run: ReturnType<typeof f.ledger.getRun>) => ({
      events: runEvents.get(run.id) ?? [],
      firstIndex: 0,
      loaded: true,
    }),
    events: (id: string) => runEvents.get(id) ?? [],
    eventBase: () => 0,
    subscribe(id: string, listener: (event: NormalizedEvent, index: number) => void) {
      const listeners = runListeners.get(id) ?? new Set();
      runListeners.set(id, listeners);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async interrupt(run: ReturnType<typeof f.ledger.getRun>, ctx = USER) {
      f.ledger.markRunStopping(run.id, ctx);
      return 'running' as const;
    },
    // As the Runner does when the Task has no Run out of contact.
    async abandon(taskId: string, reason: string, ctx = USER) {
      f.ledger.abandonTask(taskId, reason, ctx);
    },
    // A Runner that has not been in touch with any machine, and finds no artifacts.
    async fetchArtifacts() {
      return { files: [], problem: null };
    },
    // A Runner that has not been in touch with any machine yet.
    machines: () => [],
    check: async () => null,
    checkMachine: async (machine: {id:string;host:string}) => ({ machine_id: machine.id, host: machine.host, reachable: true }),
    ...options.runner,
  };
  // Accepting is where a Run's artifacts come back, for the page and for the Router's tool
  // alike: the same implementation the service runs.
  const accept = createAcceptor({ ledger: f.ledger, runner, dataDir: f.dir });
  const tools = createTools({
    ledger: f.ledger,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins,
    machines,
    accept,
  });
  const emitRun = (id: string, event: NormalizedEvent) => {
    const events = runEvents.get(id) ?? [];
    events.push(event);
    runEvents.set(id, events);
    for (const listener of runListeners.get(id) ?? []) listener(event, events.length - 1);
  };
  const state = {
    current: undefined as string | undefined,
    refused: undefined as string | undefined,
    refusedLater: undefined as string | undefined,
    kicks: 0,
    interrupts: 0,
    calls: 0,
    shutdowns: 0,
    restarts: 0,
  };
  const settings = serviceSettings({ ledger: f.ledger, dataDir: f.dir, log: () => {} });
  const secretFile = wecomSecretFile(f.dir);
  const auth = createAuth({
    ledger: f.ledger,
    dataDir: f.dir,
    linkTtlMs: () => settings.get('login.linkTtlMs'),
    sessionDays: () => settings.get('login.sessionDays'),
    temporarySessionMs: () => settings.get('login.temporarySessionMs'),
    ...(options.now ? { now: options.now } : {}),
  });
  const inbounds = createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => SETTINGS['triggers.inboundSkewMs'].default, log: () => {} });
  const http = createHttp({ ...HTTP_TUNED,
    ...(options.claudeLogin ? { claudeLogin: options.claudeLogin } : {}),
    ...(options.codexLogin ? { codexLogin: options.codexLogin } : {}),
    ...(options.weixin ? { weixin: options.weixin } : {}),
    ...(options.replay ? { replay: options.replay } : {}),
    ...(options.signIns ? { signIns: options.signIns } : {}),
    ...(options.log ? { log: options.log } : {}),
    machines,
    logins,
    // The machines that come back by themselves: a console test that does not ask about
    // them gets a hub that has never seen one.
    nodes: options.nodes ?? createNodes({ ...NODES_TUNED,
      ledger: f.ledger,
      pollHoldMs: () => SETTINGS['node.pollHoldMs'].default,
      commandTimeoutMs: () => SETTINGS['node.commandTimeoutMs'].default,
      joinTtlMs: () => SETTINGS['node.joinTtlMs'].default,
      gapSlackMs: () => SETTINGS['node.gapSlackMs'].default,
      log: () => {},
    }),
    roundSnapshot: options.roundSnapshot ?? (() => null),
    roundCredential: options.roundCredential ?? (() => null),
    roundInvite: () => null,
    ledger: f.ledger,
    tools,
    accept,
    cleanupAfterProjectDelete: options.cleanupAfterProjectDelete ?? (() => accept.sweep()),
    auth,
    session: {
      admitTool() {
        if (state.refused) return { refused: state.refused };
        if (!state.current) return { refused: '当前没有在处理的消息，工具不执行' };
        state.calls += 1;
        return {
          messageId: state.current,
          messageIds: [state.current],
          projectId: f.projectId,
          // What the barrier says once the body is in: a test sets it while the body is on its way.
          recheck: () => state.refusedLater,
          done: () => {
            state.calls -= 1;
          },
        };
      },
      toolTokens: () => {
        const token = 'toolToken' in options ? options.toolToken : TOOL_TOKEN;
        return token === undefined ? [] : [token];
      },
      projectOfToken: (token) => (token !== undefined && token === ('toolToken' in options ? options.toolToken : TOOL_TOKEN) ? f.projectId : undefined),
      kick: () => {
        state.kicks += 1;
      },
      interrupt: () => {
        state.interrupts += 1;
        return state.current !== undefined;
      },
      status: () => ({
        alive: true, pid: 7, turn: state.current ?? null, turns: state.current ? [state.current] : [], error: null, restarting: false, waiting: null, launched: null,
        host_error: null,
        projects: [{ project_id: f.projectId, alive: true, pid: 7, turn: state.current ?? null, context_id: null, error: null }],
      }),
      restart: async () => {
        state.restarts += 1;
      },
    },
    stream,
    runner,
    accounts,
    ...(options.models ? { models: options.models } : {}),
    ...(options.quota ? { quota: options.quota } : {}),
    knowledgeTokens: knowledgeTokenStore(f.dir),
    inbounds,
    skillFolder: join(f.dir, 'skills'),
    wecomSecret: {
      isSet: () => readSecret(secretFile) !== '',
      set: (secret, ctx) => replaceSecret(secretFile, secret, () => f.ledger.noteAction('wecom.secret_set', ctx)),
    },
    doctor: options.doctor ?? (async () => []),
    loginUrl: (path) => `http://console.example${path}`,
    publicUrl: () => settings.get('http.publicUrl'),
    ...(options.gateway ? { gateway: options.gateway } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.channels ? { channels: options.channels } : {}),
    ...(options.orphans ? { orphans: options.orphans } : {}),
    backup: options.backup ?? {
      status: () => ({ configured: false }),
      trigger() {
        throw new InputError('没有配置自动备份');
      },
    },
    settings,
    deployment: async () => options.deployment ?? [],
    ...(options.waitingLogins ? { waitingLogins: options.waitingLogins } : {}),
    ...(options.taskWait ? { taskWait: options.taskWait } : {}),
    ...(options.lostGraceMs ? { lostGraceMs: options.lostGraceMs } : {}),
    consoleDir: options.consoleDir ?? CONSOLE_DIST,
    loginToken: LOGIN_TOKEN,
    shutdownToken: SHUTDOWN_TOKEN,
    instance: () => ({}),
    // What a service putting a release in place answers. A test of the release routes
    // replaces any of them.
    releaseCheck: options.releaseCheck ?? (() => ({ ledger: 'ok', degraded: false, recovering: false, health_window_ms: 0 })),
    drain: options.drain ?? (async () => ({ drained: true, waited_ms: 0 })),
    releases: options.releases ?? {
      dataDir: f.dir,
      version: '0.0.0',
      last: () => readReleaseResult(f.dir),
      intent: () => null,
      attempting: () => false,
      launch: () => {
        throw new InputError('这一轮没有可以上线的发布包');
      },
    },
    onShutdown: () => {
      state.shutdowns += 1;
    },
  });
  const port = await http.listen(0, options.host ?? '127.0.0.1');
  t.after(() => http.close());
  const url = `http://127.0.0.1:${port}`;
  const origin = { Origin: url };

  const newLink = async (): Promise<string> => {
    const response = await fetch(`${url}/api/login-links`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LOGIN_TOKEN}` },
    });
    return ((await response.json()) as { path: string }).path;
  };
  const exchange = (path: string, headers: Record<string, string> = origin) => {
    // A browser fixture accepts only canonical links; malformed HTTP tests use fetch directly.
    if (!/^\/login#[0-9a-f]{64}$/.test(path)) throw new Error('fixture needs a canonical login fragment');
    return fetch(`${url}/login`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: new URL(path, url).hash.slice(1) }), redirect: 'manual' });
  };
  const signIn = async (): Promise<string> => {
    const response = await exchange(await newLink());
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };

  const cookie = await signIn();
  const browser = { Cookie: cookie, ...origin };
  const get = (path: string, headers: Record<string, string> = browser) =>
    fetch(`${url}${path}`, { headers, redirect: 'manual' });
  const post = (path: string, body?: unknown, headers: Record<string, string> = browser) =>
    fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = browser) =>
    fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  return { f, url, port, http, stream, state, auth, settings, accounts, machines, inbounds, cookie, browser, origin, newLink, exchange, signIn, get, post, send,
    emitRun, runListeners, runner, accept };
}
