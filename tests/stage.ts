// The whole service on a real ledger, with the fake CLI as the Router, a fake instance
// (fake-remote.ts) that outlives restarts, and the HTTP surface signed in like a browser.
//
// A crash is injected at a commit: `crashAt(action, 'before')` fails the transaction
// that writes that change row and retires the connection, so nothing in it reaches the
// file; `crashAt(action, 'after')` lets it commit and retires the connection on the next
// line. Either way no later write of this service lands, not even one on a reopened
// connection, and `wreck` then frees what only a dead process would have freed. What the
// next start finds is what a killed process leaves, and tests/crash.test.ts shows a real
// kill loses a transaction the same. The hooks reach the connection themselves, so this
// holds in the middle of a start too. tests/stage.test.ts checks the facility itself.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Snapshot, Login } from '../runner/snapshot.ts';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import type { ServiceOptions } from '../service/main.ts';
import { startService } from '../service/main.ts';
import { createTools } from '../service/tools.ts';
import { fakeRemote } from './fake-remote.ts';
import type { Seed } from './helpers.ts';
import { claudeTier, OUTPUT_AVAILABLE, CONSOLE_DIST, machineLogin, machinesOf, memoryLogins, noAccept, seed, signedInEverywhere, testMachine } from './helpers.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const USER = { actor: 'test' };

// The machine h1's own Claude Code login: what the stage's rounds run as.
export const LOGIN: Login = machineLogin('h1', 'claude', { tiers: { execute: claudeTier('/tiers/execute.json') } });

export const MACHINE = testMachine('h1');

export type Service = Awaited<ReturnType<typeof startService>>;

export class Crash extends Error {
  override name = 'Crash';
}

export async function until<T>(read: () => T | undefined | false | null, what: string): Promise<T> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(10);
  }
}

// Signed in the way a browser is: link, exchange page, cookie.
// The project whose page a test talks on: the first there is, made if there is none.
export const pageProject = (service: Service): string =>
  service.ledger.listProjects()[0]?.id ?? service.ledger.createProject({ name: '试跑', loginMode: 'all' }, USER);

// The page a message is written on, when a project can be had; a ledger that cannot write
// gets the message as it is, and answers for itself.
const onPage = (service: Service): { project_id?: string } => {
  try {
    return { project_id: pageProject(service) };
  } catch {
    return {};
  }
};

export async function signIn(service: Service) {
  const base = `http://127.0.0.1:${service.port}`;
  const { credential } = service.auth.createLink();
  const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
    headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return {
    base,
    cookie,
    get: (url: string): Promise<Response> => fetch(`${base}${url}`, { headers: { Cookie: cookie } }),
    // A message is said on a project's page: the stage's first project, unless the test names one.
    post: (url: string, body: unknown = {}): Promise<Response> =>
      fetch(`${base}${url}`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify(url === '/api/messages' && !Object.hasOwn(body as object, 'project_id') ? { ...(body as object), ...onPage(service) } : body),
      }),
    del: (url: string): Promise<Response> => fetch(`${base}${url}`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } }),
  };
}

// Every account of a stage holds a token from the start, as every account does: a file the
// service hands to each round, which a test may replace.
const stageTokens = (logins: Record<string, Login>): Record<string, string> =>
  Object.fromEntries(Object.values(logins).filter(({ machine }) => machine === undefined).map(({ id }) => [id, `stage-token-${id}`]));

// `machines` are machines there besides the ones the logins name: an account names none.
export function stage(t: TestContext, logins: Record<string, Login> = { own: { ...LOGIN } }, machines: readonly string[] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-stage-'));
  const remote = fakeRemote();
  const previous = { ...process.env };
  const running = new Set<Service>();
  // Every start is held from the moment it is asked for, not once it has returned: a case
  // that ends (or is cut short by its own timeout) while `startService` is still coming up
  // is stopped through this signal, and the teardown waits for the start to hand back what
  // it built before that is stopped too. Without it the service opened its port with
  // nothing holding it, and the file's process never exited.
  const starting = new Set<{ signal: AbortController; service: Promise<Service> }>();
  const fakeLog = join(dataDir, 'fake.log');
  const tools = createTools({
    ledger: undefined as never,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({}),
    machines: undefined as never,
    accept: noAccept,
  });
  Object.assign(process.env, {
    FAKE_CLAUDE_LOG: fakeLog,
    FAKE_CLAUDE_TOOLS: JSON.stringify(tools.names.map((name) => `mcp__tycho__${name}`)),
  });
  t.after(async () => {
    for (const { signal } of starting) signal.abort('用例结束');
    remote.releaseAll();
    for (const entry of [...starting]) {
      // A start that failed leaves nothing of its own to stop.
      const service = await entry.service.catch(() => undefined);
      if (service) running.add(service);
    }
    for (const service of running) await service.stop();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    rmSync(dataDir, { recursive: true, force: true });
  });

  let crash: { action: string; when: 'before' | 'after'; fired: PromiseWithResolvers<void> } | undefined;
  let crashing = false;

  // The stage's logins are in the ledger before the first start. A later start changes
  // what the ledger holds only when it is handed something to change: `changed.logins`
  // is then all the logins there are, as if the owner had edited them while it was down.
  let seeded = false;

  async function start(options: Omit<ServiceOptions, 'dataDir'> = {}, changed: Seed = {}): Promise<Service> {
    const first = !seeded;
    seeded = true;
    if (first || Object.keys(changed).length > 0) seed(dataDir, { ...(first ? { machines: Object.fromEntries(machinesOf(logins, machines).map((id) => [id, testMachine(id)])), logins, credentials: stageTokens(logins) } : {}), ...changed });
    const signal = new AbortController();
    const entry = { signal, service: undefined as unknown as Promise<Service> };
    entry.service = startService({
      dataDir,
      claude: [process.execPath, FAKE],
      port: 0,
      // The stand-in build: a checkout under test has no console built.
      consoleDir: CONSOLE_DIST,
      connect: remote.connect,
      reportedExecutors: signedInEverywhere(),
      reportedOutput:()=>OUTPUT_AVAILABLE,
      dispatchIntervalMs: 20,
      watchIntervalMs: 20,
      outboxIntervalMs: 20,
      degradedRecoveryMs: 30,
      stopWaitMs: 2000,
      ...options,
      // The stage's own, whatever the test handed in: the teardown has to be able to stop
      // a start that is still coming up, and that is the only thing this signal is for.
      stopSignal: signal.signal,
      ledgerHooks: {
        beforeCommit(actions) {
          options.ledgerHooks?.beforeCommit?.(actions);
          if (crashing) throw new Crash('进程已不在，写不进去');
          if (crash?.when !== 'before' || !actions.includes(crash.action)) return;
          crashing = true;
          crash.fired.resolve();
          throw new Crash(crash.action);
        },
        // Throwing here is what retires the connection with nothing committed.
        beforeRollback() {
          if (crashing) throw new Crash('进程已不在，回滚不到');
        },
        afterCommit(actions, retire) {
          if (crash?.when !== 'after' || !actions.includes(crash.action)) return;
          crashing = true;
          retire();
          crash.fired.resolve();
          throw new Crash(crash.action);
        },
      },
    }).then((service) => {
      running.add(service);
      return service;
    });
    // The teardown may outlive whoever asked for this start; a rejection here is the
    // caller's to see, and the teardown's to hear and go past.
    entry.service.catch(() => {});
    starting.add(entry);
    try {
      return await entry.service;
    } finally {
      starting.delete(entry);
    }
  }

  function crashAt(action: string, when: 'before' | 'after'): Promise<void> {
    crash = { action, when, fired: Promise.withResolvers<void>() };
    return crash.fired.promise;
  }

  // The part of a process's death that an in-process test has to do by hand. No service:
  // the crash came during a start, which took itself down.
  async function wreck(service?: Service): Promise<void> {
    if (!crash) service?.ledger.close();
    crash = undefined;
    await service?.stop();
    crashing = false;
    if (service) running.delete(service);
  }

  async function stop(service: Service): Promise<void> {
    await service.stop();
    running.delete(service);
  }

  function project(service: Service): string {
    const first = Object.values(logins)[0];
    return service.ledger.listProjects()[0]?.id
      ?? service.ledger.createProject(first ? { name: '试跑', logins: [first.id] } : { name: '试跑', loginMode: 'all' }, USER);
  }

  function queued(service: Service, title = '任务'): TaskRow {
    const task = service.ledger.createTask(
      { projectId: project(service), title, goal: '目标', acceptance: '测试通过', loginId: Object.values(logins)[0]!.id, roleId: 'implement' },
      USER,
    );
    service.ledger.queueTask(task.id, USER);
    return service.ledger.getTask(task.id);
  }

  const runsOf = (service: Service, task: TaskRow): RunRow[] => service.ledger.listRuns(task.id);

  // What the dispatcher has started for this Task, once it has.
  const launched = (service: Service, task: TaskRow): Promise<RunRow> =>
    until(() => {
      const run = runsOf(service, task).at(-1);
      return run && remote.called('start.sh', run.id) > 0 && service.ledger.getRun(run.id).state === 'running' && service.ledger.getRun(run.id);
    }, `任务 ${task.title} 启动`);

  const fakeLogLines = (): string[] => {
    try {
      // The fake CLI commits a record with its newline; an in-flight tail is not a line yet.
      return readFileSync(fakeLog, 'utf8').split('\n').slice(0, -1);
    } catch {
      return [];
    }
  };

  // The texts the fake CLI was handed as turns; a redelivered message would show here.
  const turnsSeen = (): string[] =>
    fakeLogLines().flatMap((line) => {
      const { user } = JSON.parse(line) as { user?: string };
      return user === undefined ? [] : [user];
    });

  // How many Router processes the fake CLI saw start.
  const routerStarts = (): number => fakeLogLines().filter((line) => JSON.parse(line).argv).length;

  function say(service: Service, text: string, externalId = text): string {
    const { id } = service.ledger.receiveMessage({ channel: 'console', externalId, actor: 'console', text, projectId: project(service) });
    service.session.kick();
    return id;
  }

  // The overview that opens a new session quotes recent messages, so the fake CLI would
  // act on a keyword in it. Tests that want a keyword honoured have the session up first.
  async function greet(service: Service): Promise<void> {
    const id = say(service, '开场', `开场-${routerStarts()}`);
    await until(() => service.ledger.getMessage(id).state === 'processed', '开场回合结束');
  }

  const snapshotOf = (run: RunRow): Snapshot => JSON.parse(run.snapshot_json) as Snapshot;

  return { dataDir, remote, start, stop, crashAt, wreck, queued, project, runsOf, launched, say, greet, turnsSeen, routerStarts, snapshotOf };
}
