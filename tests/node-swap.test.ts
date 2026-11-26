// Guards the moment a machine's client changes version (docs/design/nodes.md §1.4): the
// decision is taken at the top of the poll loop, between two polls, from the rounds that loop
// itself surveyed — and no exit path leaves a command the last poll carried half done.
//
// What this file is here to catch:
//   - a version swap decided by a timer of the follower's own, while a poll that was already
//     out comes back with a start: the process leaves 75 with the start half done,
//   - a "waiting for idle" that keeps scanning the process table beside the poll loop, which
//     costs a PowerShell per round on Windows and is not a second opinion on the same data,
//   - run() returning before an in-flight command has reported, on a stop mark, a leave or a
//     revoked token.
import './guard.ts';
import { tuned } from './helpers.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { NodeHttpError, clientStopRequestedFor, createClient, leaveRequested, requestClientStop, requestLeave } from '../node/client.ts';
import type { NodeIdentity } from '../node/client.ts';
import { readReleaseStatus } from '../node/follow.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { boxOf, writeWatchEvidence } from '../node/runbox.ts';
import type { NodeCommand, NodeFacts, NodePollAnswer } from '../shared/node-protocol.ts';
import { NODE_PROTOCOL, NODE_RELEASE_PATH } from '../shared/node-protocol.ts';

const FACTS: NodeFacts = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'test', hostname: 'mac-mini-01.local' };
const OWN = '0.1.100';
const NEXT = '0.1.200';
const REL = 'tasks/t1/runs/r1';

interface Layout {
  dataDir: string;
  appRoot: string;
  identityDir: string;
}

// An installed copy on `OWN`, with `current` already naming the host's version: the follower
// is ready without installing anything, which is the state a swap is decided in.
function installed(t: TestContext): Layout {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-swap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prefix = join(dir, 'prefix');
  const appRoot = join(prefix, 'versions', OWN);
  mkdirSync(join(appRoot, 'cli'), { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'tycho', version: OWN, type: 'module' }));
  writeFileSync(join(appRoot, 'cli', 'main.ts'), '// the installed client\n');
  writeFileSync(join(prefix, 'current'), NEXT);
  const identityDir = join(dir, 'identity');
  mkdirSync(identityDir, { recursive: true });
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  return { dataDir, appRoot, identityDir };
}

function processes(answers: { alive?: boolean; startOf?: () => Promise<string | undefined> } = {}): HostProcesses {
  return {
    alive: () => answers.alive ?? false,
    startOf: answers.startOf ?? (async () => undefined),
    descendants: async () => [],
    tagged: async () => [],
    endTree: async () => {},
    endGroup: async () => {},
  };
}

function clientOf(layout: Layout, fetch: typeof globalThis.fetch, other: {
  procs?: HostProcesses;
  stopped?: () => boolean;
} = {}) {
  return createClient({
    dataDir: layout.dataDir,
    origin: 'http://host.invalid',
    token: 'f'.repeat(64),
    facts: FACTS,
    procs: other.procs ?? processes(),
    log: () => {},
    fetch,
    lookupEnv: async () => ({ env: {} }),
    executors: { questions: [] },
    release: { identityDir: layout.identityDir, appRoot: layout.appRoot },
    ...(other.stopped === undefined ? {} : { stopped: other.stopped }),
  });
}

async function drain(rounds = 50): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function until(enough: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!enough() && Date.now() < deadline) await drain(1);
  assert.ok(enough(), '等的事情没有发生');
}

// A poll the host has not answered yet. A stop that ends the client has to end this request
// too, as it ends a held poll in the real client (node/client.ts, `within`).
function held(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal === null || signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// A start the host sent; its credential answer is held by the test, so the command is in
// flight and its report is the last thing it does. A start whose credential never arrives
// ends as "nothing was started" without spawning a watch process.
const START: NodeCommand = {
  id: 'c-start', kind: 'start', run_dir: REL, task_id: 't1', run_id: 'r1', round: 1,
  argv: [process.execPath, '-e', ''], env: {}, credential: { via: 'env', variable: 'ROUND_TOKEN' },
};

interface InFlight {
  client: ReturnType<typeof createClient>;
  events: string[];
  pollCount: () => number;
  sawCredential: Promise<void>;
  releaseCredential: () => void;
  answerFirst: (answer: NodePollAnswer) => void;
  answerSecond: (answer: NodePollAnswer) => void;
}

// A client whose first poll is either answered with START at once, or held for the test (so
// that a decision the follower might take on its own timer would happen before any command
// is on its way), and whose second poll is either held until the test answers it, or refused
// as a revoked token. The credential answer is held as well: that is the command "on its way"
// every exit path has to let finish before the process leaves.
function startInFlight(t: TestContext, layout: Layout, options: {
  stopped?: () => boolean;
  first?: 'start' | 'hold';
  second?: 'hold' | 'revoked';
} = {}): InFlight {
  const box = boxOf(layout.dataDir, REL);
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'brief.md'), '# 这一轮\n');
  const events: string[] = [];
  let pollCount = 0;
  let releaseCredential!: () => void;
  const credentialGate = new Promise<void>((resolve) => {
    releaseCredential = resolve;
  });
  let credentialSeen!: () => void;
  const sawCredential = new Promise<void>((resolve) => {
    credentialSeen = resolve;
  });
  let answerFirst!: (answer: NodePollAnswer) => void;
  const first = new Promise<NodePollAnswer>((resolve) => {
    answerFirst = resolve;
  });
  let answerSecond!: (answer: NodePollAnswer) => void;
  const second = new Promise<NodePollAnswer>((resolve) => {
    answerSecond = resolve;
  });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith(NODE_RELEASE_PATH)) {
      return Response.json({ version: NEXT, package: null, why: '测试不打包', check_every_ms: 3_600_000 });
    }
    if (at.endsWith('/api/node/runs/r1/credential')) {
      credentialSeen();
      await credentialGate;
      return Response.json({});
    }
    if (at.endsWith('/api/node/report')) {
      events.push('report');
      return Response.json({ ok: true });
    }
    if (at.endsWith('/api/node/poll')) {
      pollCount += 1;
      if (pollCount === 1) {
        if (options.first === 'hold') return answerWhen(init?.signal, first);
        return Response.json({ protocol: NODE_PROTOCOL, command: START });
      }
      if (pollCount === 2 && options.second === 'revoked') {
        return new Response(JSON.stringify({ error: '这台机器的令牌已经被撤销' }), { status: 401 });
      }
      if (pollCount === 2) return answerWhen(init?.signal, second);
      return held(init?.signal);
    }
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;
  const client = clientOf(layout, fetchImpl, options.stopped === undefined ? {} : { stopped: options.stopped });
  return {
    client, events,
    pollCount: () => pollCount,
    sawCredential,
    releaseCredential,
    answerFirst,
    answerSecond,
  };
}

// A poll the test answers later, ended by a stop exactly as a held poll is.
function answerWhen(signal: AbortSignal | null | undefined, answer: Promise<NodePollAnswer>): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const onAbort = (): void => reject(signal?.reason);
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    void answer.then((body) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(Response.json(body));
    });
  });
}

test('换版前的最后一次 poll 带回 start：报告发出之后进程才以 75 结束', async (t) => {
  const layout = installed(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  // The poll is held while the follower finds `current` already on the target. A decision on
  // a timer of the follower's own would leave here, with nothing running and no command yet
  // handed out; the loop's own decision waits for the next poll, which brings the start.
  const inFlight = startInFlight(t, layout, { first: 'hold' });
  const events = inFlight.events;
  let ended = false;
  const running = inFlight.client.run(new AbortController().signal).then(() => {
    ended = true;
    events.push('ended');
  });
  await until(() => readReleaseStatus(layout.identityDir)?.upgrade?.state === 'waiting');
  await until(()=>inFlight.pollCount()===1);
  t.mock.timers.tick(10_000);
  await drain();
  assert.equal(ended, false, '上一个 poll 还没结束，不能换版');
  assert.equal(inFlight.client.swapRequested(), false);
  assert.equal(inFlight.pollCount(), 1, '换版判定不在 poll 之外另起一体');

  inFlight.answerFirst({ protocol: NODE_PROTOCOL, command: START, look_every_ms: 3_600_000, models_timeout_ms: tuned('node.modelListTimeoutMs')(), quota_timeout_ms: tuned('node.quotaReadTimeoutMs')(), sign_ins: [] });
  await inFlight.sawCredential;
  t.mock.timers.tick(10_000);
  await drain();
  assert.equal(ended, false, '启动还没做完，进程不能走');
  assert.equal(events.length, 0);

  inFlight.releaseCredential();
  await until(() => events.includes('report'));
  await drain();
  inFlight.answerSecond({ protocol: NODE_PROTOCOL, command: null, look_every_ms: 3_600_000, models_timeout_ms: tuned('node.modelListTimeoutMs')(), quota_timeout_ms: tuned('node.quotaReadTimeoutMs')(), sign_ins: [] });
  await running;
  assert.equal(inFlight.client.swapRequested(), true, '命令做完、报告发出之后才换版');
  assert.deepEqual(events, ['report', 'ended'], '报告在前，退出在后');
  assert.match(readReleaseStatus(layout.identityDir)?.upgrade?.detail ?? '', /现在换到 0\.1\.200/);
});

test('等空闲期间不另外清点轮次：查进程只来自 poll 循环自己的清点', async (t) => {
  const layout = installed(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const box = boxOf(layout.dataDir, REL);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  let scans = 0;
  const procs = processes({
    alive: true,
    startOf: async () => {
      scans += 1;
      return 'watch-began';
    },
  });
  let pollCount = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith(NODE_RELEASE_PATH)) {
      return Response.json({ version: NEXT, package: null, why: '测试不打包', check_every_ms: 3_600_000 });
    }
    if (at.endsWith('/api/node/poll')) {
      pollCount += 1;
      if (pollCount === 1) return Response.json({ protocol: NODE_PROTOCOL, command: null });
      return held(init?.signal);
    }
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;
  const stop = new AbortController();
  const client = clientOf(layout, fetchImpl, { procs });
  const running = client.run(stop.signal);
  // One survey before the first poll, one after its answer: then the second poll is held.
  await until(() => pollCount >= 2 && scans >= 2);
  const before = scans;
  t.mock.timers.tick(20_000);
  await drain();
  assert.equal(scans, before, '等空闲的时候不另外查进程表');
  stop.abort();
  await running;
});

for (const [name, askToStop] of [
  ['停止标记', (identity: NodeIdentity) => requestClientStop(identity, process.pid)],
  ['注销', (identity: NodeIdentity) => requestLeave(identity)],
] as const) {
  test(`${name}：在途的命令做完才退出`, async (t) => {
    const layout = installed(t);
    t.mock.timers.enable({ apis: ['setInterval'] });
    const identity: NodeIdentity = { id: FACTS.node_id, dir: layout.identityDir, dataDir: layout.dataDir };
    const inFlight = startInFlight(t, layout, {
      stopped: () => clientStopRequestedFor(identity, process.pid) || leaveRequested(identity),
    });
    let ended = false;
    const running = inFlight.client.run(new AbortController().signal).then(() => {
      ended = true;
      inFlight.events.push('ended');
    });
    await inFlight.sawCredential;
    askToStop(identity);
    t.mock.timers.tick(1_000);
    await drain();
    assert.equal(ended, false, '命令还没报告，进程不能走');
    assert.equal(inFlight.client.swapRequested(), false);
    inFlight.releaseCredential();
    await until(() => inFlight.events.includes('report'));
    await running;
    assert.deepEqual(inFlight.events, ['report', 'ended'], '报告在前，退出在后');
  });
}

test('主机不认令牌（注销后）：在途的命令做完、报告发出，run() 才报错退出', async (t) => {
  const layout = installed(t);
  const inFlight = startInFlight(t, layout, { second: 'revoked' });
  const outcome = inFlight.client.run(new AbortController().signal).then(() => 'resolved' as const, (error: unknown) => error);
  await inFlight.sawCredential;
  await drain();
  let settled = false;
  void outcome.then(() => {
    settled = true;
  });
  assert.equal(settled, false, '命令还没报告，run() 不能先结束');
  inFlight.releaseCredential();
  await until(() => inFlight.events.includes('report'));
  const error = await outcome;
  assert.ok(error instanceof NodeHttpError && error.status === 401, String(error));
  assert.deepEqual(inFlight.events, ['report'], '报告没有丢');
});
