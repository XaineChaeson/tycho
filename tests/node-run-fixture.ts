// What every node-run case is built on: a real host service (real ledger, real HTTP, real
// dispatcher), a real machine client in this process talking to that service over HTTP, and
// a real Worker child process (tests/fake-executor.mjs). The only thing stood in is the
// executor's own command line, which no test may run for real (docs/design/nodes.md §1.2).
//
// Split out of tests/node-run.test.ts, whose cases were moved into files by what each one
// guards (tests/node-run-*.test.ts): every case here starts a service and settles a real
// round on a machine, so one file holding all of them runs far longer than the rest of the
// suite put together.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import type { Adapter } from '../adapters/types.ts';
import type { Account } from '../runner/snapshot.ts';
import type { Ctx } from '../service/ledger.ts';
import type { ServiceOptions } from '../service/main.ts';
import { startService } from '../service/main.ts';
import { createClient, factsOf, identityOf, readToken, writeToken } from '../node/client.ts';
import type { CommandAnswer } from '../node/executors.ts';
import { selectProcesses } from '../node/hostprocess.ts';
import { CONSOLE_DIST, content, testCredentialRef, writeTokenFile, uidsOf } from './helpers.ts';

export type NodeClient = ReturnType<typeof createClient>;
// The stand-in Worker every case here runs: the executor's own command line is the one
// thing a test may not run for real (docs/design/nodes.md §1.2).
export const FAKE = join(import.meta.dirname, 'fake-executor.mjs');
export const USER: Ctx = { actor: 'test' };
const NODE_ID = 'a1b2c3d4e5f60718';

// The cap on the waits that turn on the machine reading its own process table: whether it
// can read the table at all, and the round a case waits to settle.
//
// Not a knob to paper over a slow machine: it is the product's own worst case for one
// round. A watch records the two moments of a round with a command each (service/lock.ts
// bounds one at 10 seconds), then asks what the round left with two whole process-table
// reads, which node/hostprocess.ts bounds at 30 seconds apiece and which now run at once —
// so a round the machine is slow about still ends this side of a minute and a half, while
// an answer that comes sooner ends the wait at once. A cap below that made cases fail for
// the machine being slow, which is not a failure any of them is about.
export const MACHINE_TABLE_MS = 90_000;

// When a case may take a round to settle, and how long one may take: above the sum of the
// waits one case can make (the machine's table, then a round), so that a case's own bound
// is what fails, not the runner's.
export const options = { timeout: 180_000 };

// Whether this machine can read its own process table at all (WMI on Windows, /proc on
// Linux). A machine that cannot answers "unknown" about a round's processes — that is what
// nodes.md §4.3 says to do, and it means such a round is not settled as a success. The
// sandbox these tests run in refuses the query; a Windows workstation and a Linux box do not
// (§12: the sandbox's facts are not the machine's).
//
// Asked once for the whole run and kept: it is one fact about one machine, and a case that
// reads it again would be deciding that fact for itself — the file's cases have to agree on
// which of the two machines they are running against. A caller that does not need the answer
// never pays for it. Each file kicks the look off where it loads, so that it overlaps the
// cases that have work of their own — the look is a whole process-table read, and on a
// loaded Windows box that takes as long as it takes (node/hostprocess.ts bounds it).
let tableFact: Promise<boolean> | undefined;

export function tableReadable(): Promise<boolean> {
  tableFact ??= selectProcesses().descendants(process.pid).then((found) => found !== undefined);
  return tableFact;
}

// What this machine's stand-in Worker does; everything else about the adapter (parsing, the
// result, the receipt) is the real Claude one.
export interface WorkerPlan {
  exit?: number;
  sleepMs?: number;
  // Wait for this file to appear before answering: a round that is still running while the
  // test does something to it.
  waitFile?: string;
  touch?: string;
  // Write the Worker's whole environment here: what reached its hands, and nothing else.
  envFile?: string;
  // Fields added to the Worker's receipt.
  receipt?: Record<string, unknown>;
}

export function workerAdapter(plan: WorkerPlan): Adapter {
  const env: Record<string, string> = {
    TYCHO_FAKE_EXIT: String(plan.exit ?? 0),
    ...(plan.sleepMs === undefined ? {} : { TYCHO_FAKE_SLEEP_MS: String(plan.sleepMs) }),
    ...(plan.waitFile === undefined ? {} : { TYCHO_FAKE_WAIT_FILE: plan.waitFile }),
    ...(plan.touch === undefined ? {} : { TYCHO_FAKE_TOUCH: plan.touch }),
    ...(plan.envFile === undefined ? {} : { TYCHO_FAKE_ENV_FILE: plan.envFile }),
    ...(plan.receipt === undefined ? {} : { TYCHO_FAKE_RECEIPT: JSON.stringify(plan.receipt) }),
  };
  return {
    // No question about the token: these machines report no executor called stub, so the
    // answer never comes and the round waits for it (tests/node-credential-probe.test.ts is
    // where the question is tested).
    ...claudeAdapter,
    canRoute: false,
    credentialCheck: undefined,
    launch: () => ({ argv: [process.execPath, FAKE], env }),
    resume: () => ({ argv: [process.execPath, FAKE], env }),
  };
}

// What this machine's executors are, and what they answer, is the test's to decide: no test
// runs a real executor's own command (docs/design/nodes.md §1.2).
export const STAND_IN_EXECUTORS = {
  questions: [{ executor: 'claude', command: 'stub-cli', version: ['--version'], login: ['login', 'status'] }],
  run: async (argv: string[]): Promise<CommandAnswer> => (argv.includes('--version')
    ? { stdout: 'stub-cli 1.0\n', stderr: '', code: 0 }
    : { stdout: '', stderr: '', code: 1 }),
};

export interface NodeBench {
  host: Awaited<ReturnType<typeof startService>>;
  machine: { id: string; host: string; nodeId: string };
  hostDataDir: string;
  nodeDir: string;
  projectId: string;
  base: string;
  token: string;
  client: NodeClient;
  account: Account;
  taskId: string;
  // A second client on the same machine, as a restart leaves: the first one stopped, and
  // the new one has a stop of its own.
  restarted(): NodeClient;
  // Stops every client on this machine and resolves once their polling has ended: what a
  // case waits for is the client being gone, not a moment long enough for it to be.
  stopClients(): Promise<void>;
}

export async function until<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

// A watch process whose working directory is inside this tree may still be leaving: Windows
// refuses to remove a directory a process has any handle on, and a test's cleanup is not
// what should fail for that. Everything the test asserted has been asserted by then.
export async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
  console.error(`测试留下的临时目录没能删掉（不影响结论）：${dir}`);
}

// A host with one machine that has come back by itself, one account on it, and one client
// polling the host the way a machine's client does.
export async function bench(
  t: TestContext,
  plan: WorkerPlan = {},
  hostOptions: Partial<ServiceOptions> = {},
  // `anyMachine`: neither the account nor the project names a machine, so one spawned under
  // the project can take its work; `spawn`: the project allows spawning machines
  // (docs/design/nodes.md §1.3); `hold`: the task is made but not queued, so a test can set
  // things up before its first round.
  projectOptions: { anyMachine?: boolean; spawn?: boolean; hold?: boolean } = {},
): Promise<NodeBench> {
  const previousAuth = process.env.FAKE_CLAUDE_AUTH;
  process.env.FAKE_CLAUDE_AUTH = 'out';
  const hostDataDir = mkdtempSync(join(tmpdir(), 'tycho-node-host-'));
  const nodeDir = mkdtempSync(join(tmpdir(), 'tycho-node-machine-'));
  // One stop per client: a client that is replaced gets a fresh one, so that stopping the
  // first does not stop the second as well.
  const controllers = new Set<AbortController>();
  // What each client's polling is doing, so that a case that takes the client away can
  // wait for it to be gone rather than for a moment long enough that it probably is.
  const polling = new Set<Promise<void>>();
  const poll = (client: NodeClient, signal: AbortSignal): void => {
    const running: Promise<void> = client.run(signal).catch(() => {}).then(() => {
      polling.delete(running);
    });
    polling.add(running);
  };
  const stopPolling = async (): Promise<void> => {
    for (const controller of controllers) controller.abort();
    await Promise.all([...polling]);
  };
  let host: Awaited<ReturnType<typeof startService>> | undefined;
  t.after(async () => {
    try {
      await stopPolling();
      await host?.stop();
      for (const dir of [hostDataDir, nodeDir]) await removeTree(dir);
    } finally {
      if (previousAuth === undefined) delete process.env.FAKE_CLAUDE_AUTH;
      else process.env.FAKE_CLAUDE_AUTH = previousAuth;
    }
  });

  host = await startService({
    dataDir: hostDataDir,
    port: 0,
    consoleDir: CONSOLE_DIST,
    claude: [process.execPath, join(import.meta.dirname, 'fake-claude.mjs')],
    adapters: { claude: workerAdapter(plan) },
    dispatchIntervalMs: 20,
    watchIntervalMs: 20,
    outboxIntervalMs: 20,
    degradedRecoveryMs: 30,
    stopWaitMs: 3000,
    ...hostOptions,
  });
  const base = `http://127.0.0.1:${host.port}`;

  // Letting the machine in, as the console does: a request with six digits, the owner's
  // approval, then the machine collects its token. The routes themselves are covered in
  // tests/node-http.test.ts; this is the same hub underneath them.
  const facts = { node_id: NODE_ID, name: 'node-test', platform: 'test', hostname: 'node-test.local' };
  const request = host.nodes.register(facts);
  const approved = host.nodes.approve(request.code, USER);
  assert.ok(approved, '放行之后应当有这台机器');
  const claimed = host.nodes.claim(request.secret);
  assert.equal(claimed.state, 'approved');
  const token = claimed.state === 'approved' ? claimed.token : '';

  const identity = identityOf(nodeDir);
  writeToken(identity, token);
  assert.equal(readToken(identity), token, '令牌落在机器的数据目录里');

  const client = createClient({
    dataDir: nodeDir, origin: base, token, facts: factsOf(identity, 'node-test'), log: () => {},
    executors: STAND_IN_EXECUTORS,
  });
  const first = new AbortController();
  controllers.add(first);
  poll(client, first.signal);
  await until(()=>host!.nodes.connected(approved.id),'客户端首次真实poll');

  const account: Account = {
    id: 't1', name: 't1', executor: 'claude',
    tiers: { execute: content('{"model":"stub"}') },
  };
  // An account: its token, kept on the host, goes to the machine with each round.
  writeTokenFile(hostDataDir, 't1', 'token-t1');
  host.ledger.putAccount(account, USER, testCredentialRef('t1'));
  const project = host.ledger.createProject({ name: '试跑', logins: ['t1'], machines: uidsOf(host.ledger, projectOptions.anyMachine ? [] : [approved.id]) }, USER);
  if (projectOptions.spawn) host.ledger.setProjectSpawnMachines(project, true, USER);
  const task = host.ledger.createTask(
    { projectId: project, title: '节点跑一轮', goal: '跑通', acceptance: '回执', loginId: 't1', roleId: 'implement' },
    USER,
  );
  if (!projectOptions.hold) host.ledger.queueTask(task.id, USER);

  return {
    host,
    machine: host.ledger.getMachine(approved.id)!,
    hostDataDir,
    nodeDir,
    projectId: project,
    base,
    token,
    client,
    account,
    taskId: task.id,
    restarted: () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
      const fresh = createClient({ dataDir: nodeDir, origin: base, token: readToken(identity)!, facts: factsOf(identity, 'node-test'), log: () => {}, executors: STAND_IN_EXECUTORS });
      const stop = new AbortController();
      controllers.add(stop);
      poll(fresh, stop.signal);
      return fresh;
    },
    stopClients: stopPolling,
  };
}
