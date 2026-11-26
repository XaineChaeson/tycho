// Guards docs/design/nodes.md §11 step 2: judgement and continuation over the node channel
// — the heartbeat that says a machine is not here, the table that decides what that means,
// the inventory a restart asks for, the clearing that follows a reconnect, the client that
// reclaims the round it was watching, and the look taken just before a continuation goes
// out.
//
// What this file is here to catch:
//   - a machine whose client was killed still counted as here, so its Runs wait out a
//     command timeout instead of being judged from the moment they went out of contact,
//   - a network that is cut and comes back leaving the Run unknown for ever, instead of
//     being asked about again the moment the machine reports it,
//   - a host that is stopped and started again losing the round: the client must reconnect
//     and the inventory must find the round still running, not settle it as lost,
//   - a client restarted after a crash not reclaiming the round it left running, so the
//     host judges it lost and starts a second round on top of it,
//   - a Run judged lost and continued while the old round is still running on the machine
//     that went away: the old round must be told to stop, and its log must never be
//     written by two watchers.
//
// The machine's client is a real process (`cli/main.ts node run`) and the Rounds are real
// watch processes with a real Worker (tests/fake-executor.mjs). What the host is asked
// through is a real service: real ledger, real dispatcher, real HTTP.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import type { Adapter } from '../adapters/types.ts';
import type { Account } from '../runner/snapshot.ts';
import type { Ctx, RunRow } from '../service/ledger.ts';
import type { ServiceOptions } from '../service/main.ts';
import { startService } from '../service/main.ts';
import { NodeAway } from '../service/nodes.ts';
import { factsOf, identityOf, writeToken } from '../node/client.ts';
import { writeOrigin } from '../node/cli.ts';
import type { RunBox } from '../node/runbox.ts';
import { boxOf, readExit, readWatchEvidence, readWorkerEvidence } from '../node/runbox.ts';
import { isAlive } from '../service/lock.ts';
import { CONSOLE_DIST, content, seed, testCredentialRef, writeTokenFile, uidsOf } from './helpers.ts';

const FAKE = join(import.meta.dirname, 'fake-executor.mjs');
const CLI = join(import.meta.dirname, '..', 'cli', 'main.ts');
const REPO = join(import.meta.dirname, '..');
const USER: Ctx = { actor: 'test' };
export const options = { timeout: 180_000 };

// What the machine's stand-in Worker does; everything else about the adapter (the parsing,
// the result, the receipt) is the real Claude one.
interface WorkerPlan {
  exit?: number;
  // Wait for this file before answering: a round that is still running while the test does
  // something to its machine.
  waitFile?: string;
}

function workerAdapter(plan: WorkerPlan): Adapter {
  const env: Record<string, string> = {
    TYCHO_FAKE_EXIT: String(plan.exit ?? 0),
    ...(plan.waitFile === undefined ? {} : { TYCHO_FAKE_WAIT_FILE: plan.waitFile }),
  };
  return {
    // No question about the token: these machines report no executor called stub, so the
    // answer never comes and the round waits for it (tests/node-credential-probe.test.ts is
    // where the question is tested).
    ...claudeAdapter,
    credentialCheck: undefined,
    launch: () => ({ argv: [process.execPath, FAKE], env }),
    resume: () => ({ argv: [process.execPath, FAKE], env }),
  };
}

export async function until<T>(read: () => T | undefined | false | null | Promise<T | undefined | false | null>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

// A watch process inside this tree may still be leaving: Windows refuses to remove a
// directory a process holds. Everything asserted has been asserted by then.
async function removeTree(dir: string): Promise<void> {
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

// The network between the machines and the host, and nothing else: every connection the
// client makes goes through here, so `cut()` is a machine losing its network and `mend()`
// is the network coming back — without touching either process. The host's own port may
// change under it (a service that came back where the owner left it is what `target` is).
interface Wire {
  port: number;
  target: { port: number };
  cut(): void;
  mend(): void;
}

async function wire(t: TestContext): Promise<Wire> {
  const sockets = new Set<Socket>();
  let open = true;
  const target = { port: 0 };
  const server: Server = createServer((from) => {
    if (!open) {
      from.destroy();
      return;
    }
    const to = createConnection({ host: '127.0.0.1', port: target.port });
    sockets.add(from);
    sockets.add(to);
    from.pipe(to);
    to.pipe(from);
    const both = (): void => {
      from.destroy();
      to.destroy();
    };
    from.on('error', both);
    to.on('error', both);
    from.on('close', () => {
      sockets.delete(from);
      to.destroy();
    });
    to.on('close', () => {
      sockets.delete(to);
      from.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  // The sockets go first: `close` waits for every connection to end, and the machines are
  // still polling through this one until their own cleanup runs.
  t.after(() => {
    for (const socket of [...sockets]) socket.destroy();
    sockets.clear();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port,
    target,
    cut() {
      open = false;
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
    },
    mend() {
      open = true;
    },
  };
}

interface NodeBench {
  dataDir: string;
  // What the machines were told to reach: the wire's address when there is one.
  origin: string;
  taskId: string;
  account: Account;
  host: Awaited<ReturnType<typeof startService>>;
  machines: { id: string; name: string; nodeDir: string; identityDir: string; token: string }[];
  startClient(at: number): ChildProcess;
  clientOf(at: number): ChildProcess | undefined;
  runs(): RunRow[];
  run(): RunRow | undefined;
  box(at: number, runId: string): RunBox;
  stopHost(): Promise<void>;
  // The service again on the same data directory and the same address: a host that came
  // back where it was.
  restartHost(): Promise<Awaited<ReturnType<typeof startService>>>;
  logOf(at: number): string;
  wire?: Wire;
}

export async function bench(
  t: TestContext,
  plan: WorkerPlan = {},
  hostOptions: Partial<ServiceOptions> = {},
  benchOptions: { wire?: boolean } = {},
): Promise<NodeBench> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-judge-'));
  const children: ChildProcess[] = [];
  const net = benchOptions.wire === true ? await wire(t) : undefined;
  let host: Awaited<ReturnType<typeof startService>> | undefined;
  t.after(async () => {
    for (const child of children) if (child.pid !== undefined && isAlive(child.pid)) child.kill();
    await host?.stop().catch(() => {});
    await removeTree(dataDir);
  });

  const start = async (askedPort = 0): Promise<Awaited<ReturnType<typeof startService>>> => {
    const service = await startService({
      dataDir,
      port: askedPort,
      consoleDir: CONSOLE_DIST,
      adapters: { claude: workerAdapter(plan) },
      dispatchIntervalMs: 20,
      watchIntervalMs: 20,
      outboxIntervalMs: 50,
      degradedRecoveryMs: 50,
      stopWaitMs: 3000,
      // The wait a Run may be out of contact for is the test's to decide: the rules are the
      // same, only the clock is short.
      lostGraceMs: () => 400,
      ...hostOptions,
    });
    if (net !== undefined) net.target.port = service.port;
    return service;
  };
  // Written into the ledger before the service opens it: how long a command to a machine
  // may wait is the owner's setting, and this is the one the tests are about.
  seed(dataDir, { settings: { 'node.commandTimeoutMs': 10_000, 'node.pollHoldMs': 5000 } });
  host = await start();

  // Letting the machines in, as the console does: a request with six digits, the owner's
  // approval, then the machine collects its token.
  const machines = [0, 1].map((at) => {
    const facts = { node_id: `${'a1b2c3d4e5f6071'}${at}`, name: `node-${at}`, platform: 'test', hostname: `node-${at}.local` };
    const request = host!.nodes.register(facts);
    const approved = host!.nodes.approve(request.code, USER);
    assert.ok(approved, '放行之后应当有这台机器');
    const claimed = host!.nodes.claim(request.secret);
    assert.equal(claimed.state, 'approved');
    const token = claimed.state === 'approved' ? claimed.token : '';
    const nodeDir = mkdtempSync(join(tmpdir(), `tycho-node-judge-${at}-`));
    const identity = identityOf(nodeDir);
    writeToken(identity, token);
    writeOrigin(identity, net === undefined ? `http://127.0.0.1:${host!.port}` : `http://127.0.0.1:${net.port}`);
    return { id: approved.id, name: facts.name, nodeDir, identityDir: identity.dir, token };
  });
  // The machines' own directories go too, after the hook above has ended their processes.
  t.after(async () => {
    for (const machine of machines) await removeTree(machine.nodeDir);
  });

  const account: Account = {
    id: 't1', name: 't1', executor: 'claude',
    tiers: { execute: content('{"model":"stub"}') },
  };
  // An account: its token, kept on the host, goes to the machine with each round.
  writeTokenFile(dataDir, 't1', 'token-t1');
  host.ledger.putAccount(account, USER, testCredentialRef('t1'));
  const project = host.ledger.createProject({ name: '判定', logins: ['t1'], machines: uidsOf(host.ledger, machines.map(({ id }) => id)) }, USER);
  const task = host.ledger.createTask(
    { projectId: project, title: '节点判定', goal: '跑通', acceptance: '回执', loginId: 't1', roleId: 'implement' },
    USER,
  );
  host.ledger.queueTask(task.id, USER);

  const started = new Map<number, ChildProcess>();
  const startClient = (at: number): ChildProcess => {
    const machine = machines[at]!;
    // The client re-executes itself through `--use-env-proxy` when the environment names a
    // proxy (cli/main.ts). That is a second process in front of the one this test means to
    // kill, so the machines here are told there is none; they only reach 127.0.0.1.
    const env: NodeJS.ProcessEnv = { ...process.env, TYCHO_DATA: machine.nodeDir, TYCHO_NODE_SUPERVISED: '1' };
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) env[name] = '';
    const child = spawn(process.execPath, [CLI, 'node', 'run', '--log', join(machine.nodeDir, 'client.log')], {
      cwd: REPO,
      env,
      // Nothing is read from this process's pipes: this machine refuses them, and what the
      // client says is in the log file it was told to write.
      stdio: 'ignore',
      windowsHide: true,
    });
    children.push(child);
    started.set(at, child);
    return child;
  };

  return {
    dataDir,
    origin: net === undefined ? `http://127.0.0.1:${host.port}` : `http://127.0.0.1:${net.port}`,
    taskId: task.id,
    account,
    get host() {
      return host!;
    },
    machines,
    startClient,
    clientOf: (at) => started.get(at),
    runs: () => host!.ledger.listRuns(task.id),
    run: () => host!.ledger.listRuns(task.id).at(-1),
    box: (at, runId) => boxOf(machines[at]!.nodeDir, `tasks/${task.id}/runs/${runId}`),
    async stopHost() {
      await host!.stop();
    },
    async restartHost() {
      host = await start();
      return host;
    },
    logOf(at) {
      try {
        return readFileSync(join(machines[at]!.nodeDir, 'client.log'), 'utf8');
      } catch {
        return '';
      }
    },
    ...(net === undefined ? {} : { wire: net }),
  };
}

export const connected = (b: NodeBench, at: number): boolean => b.host.nodes.status().connected.includes(b.machines[at]!.id);

// A round that runs until the test lets it: the Worker waits for a file only this test can
// write, so nothing here depends on a race with a Worker that finished. The file is written
// once the test is over as well, so a Worker the test did not release goes away by itself
// instead of waiting out its own deadline.
export function releaseFile(t: TestContext): string {
  const file = join(tmpdir(), `tycho-release-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  t.after(() => {
    try {
      writeFileSync(file, '');
    } catch {
      // A round that already ended does not need it.
    }
  });
  return file;
}

export const watchOf = (box: RunBox): Promise<{ pid?: number }> =>
  until(() => {
    const evidence = readWatchEvidence(box);
    return evidence.pid === undefined ? undefined : evidence;
  }, '看管进程登记自己');

export const workerOf = (box: RunBox): Promise<{ pid?: number }> =>
  until(() => {
    const evidence = readWorkerEvidence(box);
    return evidence.pid === undefined ? undefined : evidence;
  }, 'Worker 登记自己');
