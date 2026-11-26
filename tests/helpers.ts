import './guard.ts';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Tier } from '../adapters/types.ts';
import { ADAPTERS } from '../adapters/all.ts';
import { ownLoginTiersOf } from '../adapters/tier.ts';
import type { NodeExecutorReport, NodeExecutorStatus } from '../shared/node-protocol.ts';
import type { Acceptor } from '../service/accept.ts';
import type { Login, LoginStore, Machine, MachineStore } from '../runner/snapshot.ts';
import { sameConfig, loginConfig, machineConfig } from '../runner/snapshot.ts';
import { machineLoginName } from '../shared/logins.ts';
import { accountCredentialFile } from '../service/secrets.ts';
import { createAccounts } from '../service/accounts.ts';
import { Db, TASK_SELECT } from '../service/db.ts';
import { ulid } from '../service/ids.ts';
import type { Ctx, Ledger, LedgerOptions, RunRow, TaskRow } from '../service/ledger.ts';
import { openLedger } from '../service/ledger.ts';
import { DEFAULT_KNOWLEDGE_LIMITS } from '../service/knowledge.ts';
import { putSecret, wecomSecretFile } from '../service/secrets.ts';
import { serviceSettings } from '../service/service-settings.ts';
import type { SettingKey, SettingValue } from '../service/settings.ts';
import { SETTINGS } from '../service/settings.ts';

export const USER: Ctx = { actor: 'user' };

function holdMachineLogin(ledger: Pick<Ledger, 'putMachineLogin' | 'getMachineLogin'>, login: Login & { machine: string }): void {
  ledger.putMachineLogin(login, SEEDER);
  const registered = ledger.getMachineLogin(login.machine, login.executor)!;
  login.id = registered.id;
  login.name = registered.name;
}

// A tier as accounts hold one: the executor's own text. Tests write them the way an account
// is written, one naming a model in each executor's own shape.
export const content = (text: string): Tier => ({ kind: 'content', text });
export const claudeTier = (model: string): Tier => content(`${JSON.stringify({ model })}\n`);
export const codexTier = (model: string): Tier => content(`model=${JSON.stringify(model)}\n`);
export const dshTier = (model: string): Tier => content(`- model: ${JSON.stringify(model)}\n`);

// A built console as the service is handed one: a page, its hashed assets and one file
// beside them. The real one is built by the frontend toolchain, which these tests never need.
export const CONSOLE_DIST = join(import.meta.dirname, 'fixtures', 'console-dist');

// PATH, and every place the Claude adapter declares (the native installer's under the home
// directory, the Windows desktop app's), all put out of reach: for the tests that are about a
// machine with no Claude Code at all, which would otherwise find whatever this developer's
// machine happens to have installed. `dataDir` is a directory of the test, which goes away
// with it.
export function hideClaude(dataDir: string): void {
  process.env.PATH = process.platform === 'win32'
    ? ['System32', '', 'System32\\WindowsPowerShell\\v1.0'].map((dir) => join(process.env.SystemRoot!, dir)).join(delimiter)
    : ['/usr/bin', '/bin'].join(delimiter);
  process.env.LOCALAPPDATA = join(dataDir, 'no-appdata');
  process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = join(dataDir, 'no-home');
}

// A machine's own login has an opaque id even before registration. Seeding replaces it
// with the id the ledger allocated, retaining the object the test holds.
export function machineLogin(machine: string, executor: string, settings: Omit<Login, 'id' | 'name' | 'executor' | 'machine'>): Login {
  return { id: ulid(), name: machineLoginName(machine, executor), executor, machine, ...settings };
}

// The number an account a test makes is created with: an account always holds a token.
// There is no file behind it unless the test writes one (writeTokenFile), which is what
// the tests that hand a token to a round do.
export const testCredentialRef = (accountId: string): string => `test-${accountId}`;
export function writeTokenFile(dataDir: string, accountId: string, token: string): void {
  putSecret(accountCredentialFile(dataDir, testCredentialRef(accountId)), token);
}

// Brings the ledger's logins to the ones given: accounts, created with a token number, and
// machines' own logins, whose machine has to be in the ledger already.
function syncLogins(logins: readonly Login[], ledger: Pick<Ledger, 'listAccounts' | 'putAccount' | 'deleteAccount' | 'listMachineLogins' | 'putMachineLogin' | 'getMachineLogin' | 'deleteMachineLogin' | 'getMachine'>): void {
  for (const login of logins) {
    if (login.machine === undefined) continue;
    const held = ledger.getMachineLogin(login.machine, login.executor);
    if (held) { login.id = held.id; login.name = held.name; }
  }
  const wanted = new Set(logins.map(({ id }) => id));
  for (const { id } of ledger.listAccounts()) if (!wanted.has(id)) ledger.deleteAccount(id, SEEDER, { confirmed: true });
  for (const { id, machine, executor } of ledger.listMachineLogins()) if (!wanted.has(id) && ledger.getMachine(machine)) ledger.deleteMachineLogin(machine, executor, SEEDER);
  const accounts = new Map(ledger.listAccounts().map(({ created_at: _made, updated_at: _changed, ...account }) => [account.id, account]));
  const own = new Map(ledger.listMachineLogins().map(({ created_at: _made, updated_at: _changed, ...login }) => [login.id, login]));
  for (const login of logins) {
    if (login.machine === undefined) {
      const before = accounts.get(login.id);
      if (!before) ledger.putAccount(login, SEEDER, testCredentialRef(login.id));
      else if (!sameConfig(loginConfig(before), loginConfig(login))) ledger.putAccount(login, SEEDER, before.executor === login.executor ? undefined : testCredentialRef(login.id));
    } else {
      const before = own.get(login.id);
      if (!before || !sameConfig(loginConfig(before), loginConfig(login))) holdMachineLogin(ledger, login as Login & { machine: string });
    }
  }
}

// Logins held in memory, for a module under test that only asks for one. Read through on
// every call, so a test can change them the way the owner would. Given a ledger, each read
// first brings the ledger's own logins to what the test holds: the ledger checks a Run's
// login against its tables, and the owner's change is a row there.
export function memoryLogins(
  logins: Record<string, Login>,
  ledger?: Pick<Ledger, 'listAccounts' | 'putAccount' | 'deleteAccount' | 'listMachineLogins' | 'putMachineLogin' | 'getMachineLogin' | 'deleteMachineLogin' | 'getMachine'>,
): LoginStore {
  const all = (): Login[] => Object.values(logins);
  const sync = (): void => { if (ledger) syncLogins(all(), ledger); };
  sync();
  return {
    get(id) {
      sync();
      return all().find((login) => login.id === id);
    },
    list() {
      sync();
      return all();
    },
  };
}

// The machines every login of these runs on: a machine's own login names its machine; an
// account names none, and the tests give it the ones they list besides.
export const machinesOf = (logins: Record<string, Login>, extra: readonly string[] = []): string[] =>
  [...new Set([...Object.values(logins).flatMap((login) => (login.machine === undefined ? [] : [login.machine])), ...extra])];

// What a data directory holds before a service starts on it, put there the way the
// console would have: settings through the registry, the Secret in its file, logins in
// the ledger. Logins are written as given, unchecked: tests use executors and paths
// that the console would refuse.
export interface Seed {
  // All of them: a login of the ledger that is not listed here is removed. A machine's own
  // login needs its machine, given below or already there.
  logins?: Record<string, Login>;
  machines?: Record<string, Machine>;
  // Each account's login token, written the way the console writes one: the file, and the
  // change row that says it was set.
  credentials?: Record<string, string>;
  settings?: { [K in SettingKey]?: SettingValue<K> };
  wecom?: { botId: string; owner: string; secret: string; url?: string };
}

const SEEDER: Ctx = { actor: 'seed' };

export function seed(dataDir: string, { logins, machines, credentials, settings, wecom }: Seed): void {
  const ledger = openLedger(join(dataDir, 'ledger.db'));
  try {
    if (machines) {
      for (const { id } of ledger.listMachines()) if (!Object.hasOwn(machines,id)) ledger.deleteMachine(id,SEEDER,{confirmed:true});
      for (const machine of Object.values(machines)) holdMachine(ledger, machine);
    }
    if (logins) syncLogins(Object.values(logins), ledger);
    if (credentials) {
      // The executors the service itself has, and the ones that take a token among them:
      // what a seeded ledger holds was not written by the console.
      const executors = ADAPTERS;
      const store = createAccounts({
        ledger,
        executors,
        credentialExecutors: Object.entries(executors).filter(([, each]) => each.credential).map(([id]) => id),
        dataDir,
        log: () => {},
      });
      for (const [id, token] of Object.entries(credentials)) store.setCredential(id, token, SEEDER);
    }
    const registry = serviceSettings({ ledger, dataDir, log: () => {} });
    for (const [key, value] of Object.entries(settings ?? {})) registry.set(key as SettingKey, value as SettingValue<SettingKey>, SEEDER);
    if (wecom) {
      putSecret(wecomSecretFile(dataDir), wecom.secret);
      registry.set('wecom.url', wecom.url ?? '', SEEDER);
      registry.set('wecom.owner', wecom.owner, SEEDER);
      registry.set('wecom.botId', wecom.botId, SEEDER);
    }
  } finally {
    ledger.close();
  }
}

// For a module under test that is handed a getter and whose test is about something else.
export const tuned = <K extends SettingKey>(key: K) => (): (typeof SETTINGS)[K]['default'] => SETTINGS[key].default;
const MIB = 1024 * 1024;
// The limit a dispatched Run records, at the registry's default.
export const RUN_LIMIT_MS = SETTINGS['run.timeoutMs'].default;
// The settings each module must be handed, at the registry's defaults, the way main.ts
// hands them; spread first so a test can override one.
export const RUNNER_TUNED = {
  lostGraceMs: tuned('run.lostGraceMs'),
  artifactFileLimitBytes: () => tuned('artifacts.fileLimitMb')() * MIB,
  artifactsLimitBytes: () => tuned('artifacts.totalLimitMb')() * MIB,
  displayTextBytes: () => tuned('site.outputLimitKb')() * 1024,
  cooldownMs: tuned('machine.cooldownMs'),
  probeFreshMs: tuned('machine.probeFreshMs'),
  sweepMs: tuned('machine.sweepMs'),
};
export const ROUTER_TUNED = {
  initTimeoutMs: tuned('router.startTimeoutMs'),
  interruptGraceMs: tuned('router.interruptGraceMs'),
};
// Explicit report from these stand-in Node clients, not a production legacy default.
export const OUTPUT_AVAILABLE = {bounded_output:1 as const,capacity:{limit_bytes:1073741824,used_bytes:0,reserved_bytes:0,external_bytes:0,free_bytes:1073741824,available_runs:9}};
export const DISPATCH_TUNED = {
  outputReady: (_machine:string)=>true,
  lostGraceMs: tuned('run.lostGraceMs'),
  frontLead: tuned('dispatch.frontLead'),
  usageWarnAt: () => tuned('quota.warnPercent')() / 100,
  knowledgeLimits: () => DEFAULT_KNOWLEDGE_LIMITS,
  // What the test machines' clients said: every executor installed and signed in, nothing said
  // about read-only, and the token question answered "adopted" so that an account's work is not
  // held for it. A test about what machines report brings its own.
  reported: (_machine: string, executor: string): NodeExecutorStatus => ({ executor, installed: true, version: '1.0.0', logged_in: true, credential: { adopted: true } }),
};
export const NODES_TUNED = {
  pollHoldMs: tuned('node.pollHoldMs'),
  commandTimeoutMs: tuned('node.commandTimeoutMs'),
  joinTtlMs: tuned('node.joinTtlMs'),
  gapSlackMs: tuned('node.gapSlackMs'),
  endedJoinKeepMs: tuned('node.endedJoinKeepMs'),
  endedJoinMax: tuned('node.endedJoinMax'),
  // What the service does with a report that an executor there is signed in: the tiers its
  // adapter declares (docs/design/accounts-machines-decoupled.md).
  ownLoginTiers: (executor: string) => (Object.hasOwn(ADAPTERS, executor) ? ownLoginTiersOf(ADAPTERS[executor]!) : undefined),
};
// How a failed notification is retried, at the defaults; `giveUpAfterMs` is the test's.
export const retryAfter = (giveUpAfterMs: number) => ({ giveUpAfterMs, firstDelayMs: tuned('outbox.retryFirstMs')(), maxDelayMs: tuned('outbox.retryMaxMs')() });
export const HTTP_TUNED = {
  lostGraceMs: tuned('run.lostGraceMs'),
  nodeLookEveryMs: tuned('node.executorRefreshMs'),
  nodeModelListTimeoutMs: tuned('node.modelListTimeoutMs'),
  nodeQuotaReadTimeoutMs: tuned('node.quotaReadTimeoutMs'),
  nodeReleaseCheckMs: tuned('node.releaseCheckMs'),
  loginLimit: { windowMs: tuned('login.failWindowMs'), perSource: tuned('login.failsPerSource'), total: tuned('login.failsTotal') },
};

export interface Fixture {
  dir: string;
  path: string;
  ledger: Ledger;
  // The default Run input with this fixture's registered id; also readable after close.
  readonly login: Omit<typeof LOGIN, 'login'> & { login: Login & { machine: string } };
  // Another ledger on the same file, closed before the directory is removed.
  open(options?: LedgerOptions, file?: string): Ledger;
  db(): Db;
  projectId: string;
  // Reads committed state through its own connection, the way a restart would.
  peek<T>(sql: string, ...params: string[]): T[];
  // Forces a state the public operations cannot reach.
  force(sql: string, ...params: string[]): void;
  task(id: string): TaskRow;
  run(id: string): RunRow;
  count(table: string): number;
  // Every row of every table, to prove an operation wrote nothing at all.
  dump(): Record<string, unknown[]>;
  newTask(fields?: { acceptance?: string; roleId?: string; tierOverride?: { tier: string; reason?: string | null } }): TaskRow;
  queuedTask(): TaskRow;
  runningRun(): { task: TaskRow; run: RunRow };
}

// `held` false leaves the ledger without the login a Run is created on, for the tests
// that are about logins and start from none.
// The owner's setting, stored where the console stores it: the ledger reads the policy it
// decides by (the loss limit, a quota's rest, when to curate) from there, at the moment of use.
export function tune<K extends SettingKey>(ledger: Pick<Ledger, 'writeTunable'>, key: K, value: SettingValue<K>): void {
  ledger.writeTunable(key, { from: null, to: value, override: true }, USER);
}

export function fixture(t: TestContext, options: LedgerOptions = {}, held = true): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'steward-'));
  const path = join(dir, 'ledger.db');
  const ledger = openLedger(path, options);
  const opened: { close(): void }[] = [ledger];
  t.after(() => {
    for (const each of opened) each.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function withConnection<T>(fn: (conn: DatabaseSync) => T): T {
    const conn = new DatabaseSync(path);
    try {
      return fn(conn);
    } finally {
      conn.close();
    }
  }

  const peek = <T>(sql: string, ...params: string[]): T[] =>
    withConnection((conn) => conn.prepare(sql).all(...params) as T[]);
  const force = (sql: string, ...params: string[]): void => {
    withConnection((conn) => conn.prepare(sql).run(...params));
  };

  // Every login, as a project the owner makes runs on; a test that sets the project's list
  // chooses "only these" with it.
  const projectId = ledger.createProject({ name: '试跑', loginMode: 'all' }, USER);
  ledger.setWhitelist({ wecom: ['user'], console: ['user'] }, USER);
  // A Run is only created on a login the ledger holds, as it holds it.
  const defaultLogin: Login & { machine: string } = { ...LOGIN.login };
  if (held) { holdMachine(ledger, MACHINE); holdMachineLogin(ledger, defaultLogin); }

  const defaultMachine = ledger.getMachine(LOGIN.machine.id) ?? LOGIN.machine;
  const f: Fixture = {
    dir,
    path,
    ledger,
    get login() {
      return { ...LOGIN, machine: defaultMachine, login: { ...defaultLogin } };
    },
    open(reopenOptions, file = path) {
      const reopened = openLedger(file, reopenOptions);
      opened.push(reopened);
      return reopened;
    },
    db() {
      const db = new Db(path, false);
      opened.push(db);
      return db;
    },
    projectId,
    peek,
    force,
    // As every reader gets a Task: with the tier derived from its role or override.
    task: (id) => peek<TaskRow>(`${TASK_SELECT} WHERE task.id = ?`, id)[0]!,
    run: (id) => peek<RunRow>('SELECT * FROM run WHERE id = ?', id)[0]!,
    count: (table) => peek<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]!.n,
    dump() {
      const tables = peek<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`);
      return Object.fromEntries(tables.map(({ name }) => [name, peek(`SELECT * FROM ${name} ORDER BY rowid`)]));
    },
    newTask: (fields = {}) =>
      ledger.createTask({ roleId: 'implement', projectId, title: '任务', goal: '目标', acceptance: '测试通过', ...fields }, USER),
    queuedTask() {
      const task = f.newTask();
      ledger.queueTask(task.id, USER);
      return f.task(task.id);
    },
    // On h1's own login as the ledger holds it now: a test may have put its own in its place.
    runningRun() {
      const task = f.queuedTask();
      const login = ledger.getMachineLogin(defaultLogin.machine, defaultLogin.executor);
      const run = ledger.createRun(task.id, { ...f.login, login: login ? stripped(login) : defaultLogin }, USER);
      ledger.markRunRunning(run.id);
      return { task: f.task(task.id), run: f.run(run.id) };
    },
  };
  return f;
}

// A login as the ledger hands it back, less when it was made and changed.
export const stripped = <L extends Login>({ created_at: _made, updated_at: _changed, ...login }: L & { created_at: string; updated_at: string }): Login => login;

// A template for the fixture's default Run input. Each fixture registers its own copy and
// exposes the actual id in f.login; this shared template is never changed by registration.
export const LOGIN = {
  login: { id: ulid(), name: 'h1/claude', executor: 'claude', machine: 'h1', tiers: { execute: claudeTier('/tiers/execute.json') } } satisfies Login & { machine: string },
  machine: { id: 'h1', host: 'h1', nodeId: 'node-h1' } satisfies Machine,
  // As a Run created for this login records it: the tier it would send, itself, and the
  // time limit the dispatcher writes into every Run.
  snapshot: { brief: 'b', tier: 'execute', tier_value: claudeTier('/tiers/execute.json'), timeout_ms: RUN_LIMIT_MS },
  expectedRevision: 1,
};
// A round that did its work hands over what every preset role but review asks for: a commit
// and a report (docs/design/roles-and-tiers.md §3.2). A receipt without them is a short delivery.
export const DONE = { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] };

// A machine as a test has one: joined, under a client identity of its own name unless given.
export const testMachine = (id: string, host = id, nodeId = `node-${id}`): Machine => ({ id, host, nodeId });

// Puts a machine into the ledger the one way a machine gets there, by joining. One whose
// identity or hostname moved is another machine: the old one is removed first (its own
// logins with it), as the owner would.
type MachineLedger = Pick<Ledger, 'getMachine' | 'joinMachine' | 'deleteMachine' | 'setMachineNote'>;
export function holdMachine(ledger: MachineLedger, machine: Machine, _ctx?: Ctx): void {
  const before = ledger.getMachine(machine.id);
  if (before && sameConfig(machineConfig(before), machineConfig(machine))) {
    if ((before.note ?? null) !== (machine.note ?? null)) ledger.setMachineNote(machine.id, machine.note ?? null, SEEDER);
    return;
  }
  if (before) ledger.deleteMachine(machine.id, SEEDER, { confirmed: true });
  ledger.joinMachine({ id: machine.id, host: machine.host, nodeId: machine.nodeId, tokenHash: `token-of-${machine.nodeId}`, platform: machine.platform ?? 'test', source: null, ephemeral: false }, SEEDER);
  if (machine.note !== undefined) ledger.setMachineNote(machine.id, machine.note, SEEDER);
}

// What a stand-in machine's client would report: every executor installed and signed in, the
// token question answered "adopted", and nothing said about read-only (which then goes nowhere,
// as for a client too old to say).
export const signedInEverywhere = (executors: readonly string[] = ['claude', 'codex', 'dsh']) => (): NodeExecutorReport => ({
  at: new Date(0).toISOString(),
  executors: executors.map((executor) => ({ executor, installed: true, version: '1.0.0', logged_in: true, credential: { adopted: true } })),
});

export function memoryMachines(
  machines: Record<string, Machine>,
  ledger?: Pick<Ledger, 'listMachines' | 'deleteMachine'> & MachineLedger,
): MachineStore {
  function sync(): void {
    if (!ledger) return;
    const held = new Map(ledger.listMachines().map(machine => [machine.id, machine]));
    for (const id of held.keys()) if (!Object.hasOwn(machines, id)) ledger.deleteMachine(id, SEEDER, { confirmed: true });
    for (const machine of Object.values(machines)) holdMachine(ledger, machine);
  }
  sync();
  return {
    get(id) {
      sync();
      return ledger ? ledger.getMachine(id) : Object.hasOwn(machines, id) ? machines[id] : undefined;
    },
    list() {
      sync();
      return ledger ? ledger.listMachines() : Object.values(machines);
    },
  };
}

export const MACHINE: Machine = testMachine('h1');

// Accepting, for the tests that are not about what a Run left: the transition, and nothing
// to fetch. Where a release is the point (tools.test.ts, release-http.test.ts,
// cli-release-live.test.ts) the real acceptor is built instead.
export function accepting(ledger: Pick<Ledger, 'acceptTask' | 'listRuns' | 'registerArtifacts' | 'getTask'>): Acceptor {
  return {
    async accept(taskId, basis, ctx, options) {
      ledger.acceptTask(taskId, basis, ctx, options);
      return { stored: [], problem: null };
    },
    async refetch() {
      return { stored: [], problem: null };
    },
    async register(taskId) {
      const run = ledger.listRuns(taskId).at(-1)!;
      const revision = ledger.getTask(taskId).revision;
      return { runId: run.id, revision, registration: ledger.registerArtifacts(run.id, []), reviewed: null };
    },
    sweep() {},
  };
}

// For the tests that stand everything else in and never accept anything. A test that
// reaches acceptance through this one meant to build the real thing.
export const noAccept: Acceptor = {
  accept: async () => {
    throw new Error('这个测试没有接上验收：用 createAcceptor 或 accepting(ledger)');
  },
  refetch: async () => {
    throw new Error('这个测试没有接上验收：用 createAcceptor 或 accepting(ledger)');
  },
  register: async () => {
    throw new Error('这个测试没有接上验收：用 createAcceptor 或 accepting(ledger)');
  },
  sweep() {},
};

// A run id no other test uses. A round's residue is cleared by its marker across the
// whole machine (node/runbox.ts), and test files run side by side: two of them with the
// same id kill each other's Workers. Production ids are ulids, unique the same way.
export const runId = (label = 'r'): string => `${label}-${randomUUID()}`;

// A port nothing listened on a moment ago, for a test that has to name a port up front
// (a setting, a command's argument). Another process can take it before it is bound:
// a test that only needs some port starts the service on 0 and reads the one it took.
export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// For a test whose read-only rounds are about something else: every machine of the store is
// one that came back by itself, and each says every executor's read-only way starts there
// (docs/design/roles-and-tiers.md §5). Handed to the dispatcher as `machines` and `reported`.
export function readOnlyEverywhere(store: MachineStore): { machines: MachineStore; reported: (machineId: string, executor: string) => NodeExecutorStatus } {
  const node = (machine: Machine): Machine => ({ ...machine, nodeId: machine.nodeId ?? 'f0f0f0f0f0f0f0f0' });
  return {
    machines: { get: (id) => { const machine = store.get(id); return machine && node(machine); }, list: () => store.list().map(node) },
    reported: (_machineId, executor) => ({
      executor, installed: true, version: 'v', logged_in: true,
      read_only: { available: true, layer: ADAPTERS[executor]?.readOnly?.layer ?? 'tools', checks_code: true },
      credential: { adopted: true },
    }),
  };
}

// The machines of a ledger older than version 13 were all reached over SSH, and version 24
// removes every machine whose client never joined. A test of an older step that reads the
// machines or their logins at the end has them joined by then: right before the step to 24,
// each gets a client identity, as a machine whose client joined later would. Rounds are left
// as they are: what a round recorded is history, and nothing here can know which client ran
// it. A test about what its own step did checks that right after the step.
export function joinedBefore24(path: string) {
  return {
    log: () => {},
    testHooks: {
      afterMigrationCommit(from: number) {
        if (from !== 22) return;
        const conn = new DatabaseSync(path);
        try {
          conn.exec("UPDATE machine SET node_id = 'node-' || id, token_hash = 'token-' || id WHERE node_id IS NULL");
        } finally {
          conn.close();
        }
      },
    },
  };
}

// The registrations of machines the ledger holds now, by name: what a project's machine list
// is given (service/ledger.ts setProjectMachines).
export const uidsOf = (ledger: Pick<Ledger, 'getMachine'>, names: readonly string[]): string[] =>
  names.map((name) => {
    const machine = ledger.getMachine(name);
    if (!machine) throw new Error(`测试里没有机器 ${name}`);
    return machine.uid;
  });

// A project's allowed machines by name, and how many are of machines since deleted.
export const machineNamesOf = (ledger: Pick<Ledger, 'projectMachines'>, projectId: string): { names: string[]; gone: number } => {
  const { machines, gone } = ledger.projectMachines(projectId);
  return { names: machines.map(({ name }) => name), gone };
};
