// Guards what a machine reads of the quota of an executor's own login there, and how that
// reaches the host (docs/design/usage.md §3).
//
// What this file is here to catch:
//   - a quota read that delays the report of the executors: the Claude Code one took 55
//     seconds, and a look that waited for it would hold every page and every dispatch up;
//   - two reads of one executor at once (the clock may look again while one is still going),
//     or a read of an executor the machine says it is not signed in to;
//   - a reading that shows the command's own output, or one whose answer cannot be parsed, as
//     figures: what it learned is the adapter's parse and nothing else;
//   - a conversation (`talk`) that writes the next request before the last was answered, that
//     leaves its process running, or that never ends;
//   - a reading the host would refuse a whole report over: the machine says "no reading" with
//     why, rather than sending it and cutting itself off;
//   - a report of a client from before this field, which is not an error and carries no quota;
//   - a report that writes figures under a login that is not there, or one whose figures are
//     invented where the report said nothing.
import './guard.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ADAPTERS } from '../adapters/all.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { MachineQuota, QuotaStep } from '../adapters/types.ts';
import { createClient } from '../node/client.ts';
import type { CommandAnswer, CommandRun, ExecutorQuestion, TalkAnswer, TalkRun } from '../node/executors.ts';
import { QUOTA_READ_TIMEOUT_MS, probeExecutors, questionsFrom, readQuota, shellRun, shellTalk } from '../node/executors.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { InputError } from '../service/errors.ts';
import { createNodes } from '../service/nodes.ts';
import { NODE_PROTOCOL, NODE_QUOTA_WINDOWS_MAX } from '../shared/node-protocol.ts';
import type { NodeExecutorReport, NodeFacts } from '../shared/node-protocol.ts';
import { fixture, NODES_TUNED, USER } from './helpers.ts';

const ok = (stdout: string): CommandAnswer => ({ stdout, stderr: '', code: 0 });
const failure = (said: string): CommandAnswer => ({ stdout: '', stderr: '', code: null, failure: said });

// A question as an adapter declares one, with the quota way a test hands it.
const question = (quota?: MachineQuota): ExecutorQuestion => ({
  executor: 'er', command: 'er', version: ['--version'], login: ['login', 'status'], ...(quota === undefined ? {} : { quota }),
});
const WINDOW = [{ window: '一周窗口', used: 0.5, resets_at: null }];
const READING: MachineQuota = { kind: 'command', argv: ['er', 'quota'], parse: () => ({ windows: WINDOW }) };

// -- the machine: one reading, in the two shapes ---------------------------------------------

test('问的还是适配器声明的那几条：额度这一问只在声明了读法时才有，别的探针不问它', async () => {
  assert.deepEqual(questionsFrom(ADAPTERS).map(({ executor, quota }) => [executor, quota?.kind]), [
    ['claude', 'command'], ['codex', 'talk'], ['dsh', 'probe'], ['gemini', 'command'],
  ], '声明的读法原样成为那一问');
  // Asking the executors at all is about their versions and logins: the quota read is started
  // when a look is over (node/client.ts), never inside it.
  const asked: string[] = [];
  const run: CommandRun = async (argv) => {
    asked.push(argv.join(' '));
    return argv[1] === '--version' ? ok('1.0\n') : ok('');
  };
  const report = await probeExecutors({ questions: questionsFrom({ er: { ...ADAPTERS.claude!, machineQuota: READING } }), run });
  assert.equal('quota' in report.executors[0]!, false, '一次 look 的报告里没有额度这一段');
  assert.equal(asked.includes('er quota'), false, '也没有跑额度那一条命令');
});

test('一条命令的读法：窗口原样上来，带的是读完的那一刻；跑不了、读不出都给原因', async () => {
  const at = Date.parse('2026-11-12T10:00:00.000Z');
  const now = (): number => at;
  const command = await readQuota(READING, { version: '1', timeoutMs: 1_000, run: async () => ok('answering'), now });
  assert.deepEqual(command, { at: '2026-11-12T10:00:00.000Z', windows: WINDOW });
  assert.deepEqual(await readQuota(READING, { version: '1', timeoutMs: 1_000, run: async () => failure('er quota 超过 1000 毫秒没有回答'), now }),
    { at: '2026-11-12T10:00:00.000Z', windows: [], error: 'er quota 超过 1000 毫秒没有回答' });
  // A command that ended otherwise did not answer: its output is not read as figures.
  assert.deepEqual(await readQuota(READING, { version: '1', timeoutMs: 1_000, run: async () => ({ stdout: 'answering', stderr: '', code: 2 }), now }),
    { at: '2026-11-12T10:00:00.000Z', windows: [], error: 'er quota 退出码 2' });
  // What the parse says is the reason: one that gives a problem, and one that throws, whose
  // output must not travel either.
  for (const [parse, error] of [
    [() => ({ problem: '没读到额度窗口' }) as const, '没读到额度窗口'],
    [() => { throw new Error('SECRET-in-the-output'); }, '额度的回答读不出来'],
  ] as const) {
    const read = await readQuota({ kind: 'command', argv: ['er', 'quota'], parse }, { version: '1', timeoutMs: 1_000, run: async () => ok('SECRET-in-the-output'), now });
    assert.deepEqual(read, { at: '2026-11-12T10:00:00.000Z', windows: [], error });
    assert.equal(JSON.stringify(read).includes('SECRET'), false);
  }
});

test('形状不合报告的那一份，机器自己就说成没读到：窗口太多、名字不是一行、比例不对、重置时刻读不出来', async () => {
  const many = Array.from({ length: NODE_QUOTA_WINDOWS_MAX + 1 }, (_, index) => ({ window: `w${index}`, used: 0, resets_at: null }));
  for (const windows of [
    many,
    [{ window: 'a\nb', used: 0.1, resets_at: null }],
    [{ window: '  ', used: 0.1, resets_at: null }],
    [{ window: 'w', used: 2, resets_at: null }],
    [{ window: 'w', used: 0.1, resets_at: 'someday' }],
  ]) {
    const read = await readQuota({ kind: 'command', argv: ['er', 'quota'], parse: () => ({ windows }) }, { version: '1', timeoutMs: 1_000, run: async () => ok('answering'), now: () => 0 });
    assert.deepEqual(read.windows, [], JSON.stringify(windows).slice(0, 60));
    assert.ok(read.error, '说清了为什么没有读数');
  }
  // A window at the limit travels, reset time and all.
  const full = Array.from({ length: NODE_QUOTA_WINDOWS_MAX }, (_, index) => ({ window: `w${index}`, used: 1, resets_at: '2026-11-19T05:41:03.000Z' }));
  const read = await readQuota({ kind: 'command', argv: ['er', 'quota'], parse: () => ({ windows: full }) }, { version: '1', timeoutMs: 1_000, run: async () => ok('answering') });
  assert.deepEqual(read.windows, full);
});

test('一段对话的读法：声明的那几问原样交给它，答的那一行才是要读的', async () => {
  const steps: QuotaStep[] = [{ say: ['one'], answers: (line) => line === 'a1' }, { say: ['two', 'three'], answers: (line) => line === 'a2' }];
  const seen: { argv: string[]; steps: readonly QuotaStep[]; timeoutMs: number }[] = [];
  const talk: TalkRun = async (argv, given, timeoutMs) => {
    seen.push({ argv, steps: given, timeoutMs });
    return { answer: 'a2' };
  };
  const read = await readQuota(
    { kind: 'talk', argv: ['er', 'server'], steps: () => steps, parse: (answer) => (answer === 'a2' ? { windows: WINDOW } : { problem: '读错了' }) },
    { version: '1', timeoutMs: 4_000, talk, now: () => 7 },
  );
  assert.deepEqual(read, { at: new Date(7).toISOString(), windows: WINDOW });
  assert.deepEqual(seen.map(({ argv, timeoutMs, steps: given }) => [argv, timeoutMs, given.length]), [[['er', 'server'], 4_000, 2]]);
  // A conversation that never answered, and one whose runner threw: both are one reading that
  // did not happen, never a failure of the look.
  const way: MachineQuota = { kind: 'talk', argv: ['er', 'server'], steps: () => steps, parse: () => ({ windows: WINDOW }) };
  assert.deepEqual(await readQuota(way, { version: '1', timeoutMs: 4_000, talk: async () => ({ answer: null, failure: 'er server 超过 4000 毫秒没有回答' }), now: () => 7 }),
    { at: new Date(7).toISOString(), windows: [], error: 'er server 超过 4000 毫秒没有回答' });
  assert.deepEqual(await readQuota(way, { version: '1', timeoutMs: 4_000, talk: async () => { throw new Error('管道关掉了'); }, now: () => 7 }),
    { at: new Date(7).toISOString(), windows: [], error: '运行不了 er：管道关掉了' });
});

// What this catches: a reading whose command could not be proven gone being dropped or, the
// other way, passed on as if the machine were clean. The windows are what they always were;
// what could not be confirmed rides beside them, and the root it left running is handed up
// rather than forgotten with the handle (AGENTS.md: report what could not be verified).
test('一段对话答完、清理没确认结束时：窗口照常交回，没能确认的状态另外带上，收尾交给调用者', async () => {
  const way: MachineQuota = { kind: 'talk', argv: ['er', 'server'], steps: () => [{ say: ['one'], answers: () => true }], parse: () => ({ windows: WINDOW }) };
  const owed: [number, readonly string[]][] = [];
  const read = await readQuota(way, {
    version: '1', timeoutMs: 1_000, now: () => 7, onOwed: (pid, argv) => owed.push([pid, argv]),
    talk: async () => ({ answer: 'a1', unconfirmed: '无法确认读额度命令的进程树已经结束', owed: 700 }),
  });
  assert.deepEqual(read, { at: new Date(7).toISOString(), windows: WINDOW, error: '无法确认读额度命令的进程树已经结束' });
  assert.deepEqual(owed, [[700, ['er', 'server']]], '没能确认结束的根进程交给调用者');
  // The reading itself failed as well: both reasons are said, neither replaces the other.
  const both = await readQuota(
    { ...way, parse: () => { throw new Error('读不出来'); } },
    { version: '1', timeoutMs: 1_000, now: () => 7, talk: async () => ({ answer: 'a1', unconfirmed: '无法确认读额度命令的进程树已经结束', owed: 700 }) },
  );
  assert.deepEqual(both.windows, []);
  assert.match(both.error!, /额度的回答读不出来/);
  assert.match(both.error!, /无法确认读额度命令的进程树已经结束/);
});

// -- the conversation itself, against a stand-in command --------------------------------------

const WRAPPED = { command: 'C:\\bin\\er.exe', args: [], verbatim: false };
const silent = (): HostProcesses => ({
  alive: () => false, startOf: async () => undefined, descendants: async () => [], tagged: async () => [], endTree: async () => {}, endGroup: async () => {},
});

// One stand-in command: what it was written, and the streams the test decides.
function talkChild() {
  const written: string[] = [];
  const ended: number[] = [];
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.on('data', (chunk: Buffer) => written.push(...String(chunk).split('\n').filter((line) => line !== '')));
  const child = Object.assign(new EventEmitter(), { pid: 700, stdin, stdout, stderr: new PassThrough(), unref() {} }) as unknown as ChildProcess;
  const processes: HostProcesses = { ...silent(), endTree: async (pid: number) => { ended.push(pid); }, endGroup: async (pid: number) => { ended.push(pid); } };
  const spawn = (() => child) as unknown as typeof import('node:child_process').spawn;
  return { child, spawn, processes, written, ended, stdout, stdin };
}

test('对话按步走：写第一问、等它的回答、再写下一问；答到最后一问就关标准输入并结束进程树', async () => {
  const fake = talkChild();
  const steps: QuotaStep[] = [{ say: ['one'], answers: (line) => line === 'a1' }, { say: ['two', 'three'], answers: (line) => line === 'a2' }];
  const talking = shellTalk(['er', 'server'], steps, 5_000, 'win32', { spawn: fake.spawn, processes: fake.processes, launch: WRAPPED });
  await sleep(5);
  assert.deepEqual(fake.written, ['one'], '下一问要等这一问的回答');
  fake.stdout.write('not mine\na1\n');
  await sleep(5);
  assert.deepEqual(fake.written, ['one', 'two', 'three']);
  fake.stdout.write('a2\n');
  const answer = await talking;
  assert.deepEqual(answer, { answer: 'a2' });
  assert.deepEqual(fake.ended, [700], '答完了就把进程树结束，不留一个服务在机器上');
  assert.equal(fake.stdin.writableEnded, true, '标准输入关掉');
});

test('对话：到时限没有回答就结束进程树并如实说；进程先退出就说它没有得到回答，原话不出机器', async () => {
  const stuck = talkChild();
  const timed = await shellTalk(['er', 'server'], [{ say: ['one'], answers: () => false }], 10, 'win32', { spawn: stuck.spawn, processes: stuck.processes, launch: WRAPPED });
  assert.match(timed.failure!, /超过 10 毫秒没有回答/);
  assert.deepEqual(stuck.ended, [700]);
  // A command that goes away before answering: the exit code is said, nothing it printed is.
  const gone = talkChild();
  const closing = shellTalk(['er', 'server'], [{ say: ['SECRET'], answers: () => false }], 5_000, 'win32', { spawn: gone.spawn, processes: gone.processes, launch: WRAPPED });
  await sleep(5);
  gone.stdout.write('SECRET-in-the-output\n');
  gone.child.emit('close', 3);
  const answer = await closing;
  assert.match(answer.failure!, /退出了（退出码 3），没有得到回答/);
  assert.equal(JSON.stringify(answer).includes('SECRET'), false);
  // No steps at all is a declaration that says nothing to ask: said, not waited out.
  const none = talkChild();
  assert.match((await shellTalk(['er', 'server'], [], 5_000, 'win32', { spawn: none.spawn, processes: none.processes, launch: WRAPPED })).failure!, /没有说要发什么/);
});

// What this catches: an answer handed over as a success while the command that gave it was
// never proven gone — a server left running on the machine with nobody told (AGENTS.md: an
// inventory that cannot confirm a process is reported as such).
test('对话答完、进程树没确认结束：回答照常交回，另说清没能确认，收尾交给调用者', async () => {
  const fake = talkChild();
  // The table cannot be read: the ending was attempted, but it is not confirmed.
  fake.processes.descendants = async () => undefined;
  const talking = shellTalk(['er', 'server'], [{ say: ['one'], answers: (line) => line === 'a1' }], 5_000, 'win32', {
    spawn: fake.spawn, processes: fake.processes, launch: WRAPPED,
  });
  await sleep(5);
  fake.stdout.write('a1\n');
  const answer = await talking;
  assert.deepEqual(answer, { answer: 'a1', unconfirmed: '无法确认读额度命令的进程树已经结束', owed: 700 });
  assert.deepEqual(fake.ended, [700], '没能确认也还是结束了一次');
});

// What this catches: a client stopped while a login's quota is being read leaves the command
// running on the machine — the client's lock is released and a new client may start a second
// one — and a read begun after the stop began has nobody left to end it.
test('读额度接受停止信号：还在跑的命令结束进程树并核实；已经停下的不再开跑', async () => {
  // A conversation still going: the stop ends its tree and reads the table.
  const stop = new AbortController();
  const talking = talkChild();
  const conversation = shellTalk(['er', 'server'], [{ say: ['one'], answers: () => false }], 5_000, 'win32', {
    spawn: talking.spawn, processes: talking.processes, launch: WRAPPED, signal: stop.signal,
  });
  await sleep(5);
  stop.abort();
  const stopped = await conversation;
  assert.match(stopped.failure!, /er server 已经停止/);
  assert.doesNotMatch(stopped.failure!, /无法确认/, '核实过：进程树确实结束了');
  assert.deepEqual(talking.ended, [700]);
  // The same stop where the ending cannot be confirmed: said as such, and the root travels with
  // the answer so that its reader can still end it.
  const loose = new AbortController();
  const stuck = talkChild();
  stuck.processes.descendants = async () => undefined;
  const held = shellTalk(['er', 'server'], [{ say: ['one'], answers: () => false }], 5_000, 'win32', {
    spawn: stuck.spawn, processes: stuck.processes, launch: WRAPPED, signal: loose.signal,
  });
  await sleep(5);
  loose.abort();
  assert.deepEqual(await held, { answer: null, failure: 'er server 已经停止；无法确认探针进程树已经结束', owed: 700 });
  // A command still running is stopped the same way a conversation is.
  const stopCommand = new AbortController();
  const command = talkChild();
  const running = shellRun(['er', 'quota'], 60_000, 'win32', {
    spawn: command.spawn, processes: command.processes, launch: WRAPPED, signal: stopCommand.signal,
  });
  stopCommand.abort();
  const answer = await running;
  assert.match(answer.failure!, /er quota 已经停止/);
  assert.deepEqual(command.ended, [700]);
  // The same command where the table cannot be read: the root travels with the answer.
  const stopLoose = new AbortController();
  const looseCommand = talkChild();
  looseCommand.processes.descendants = async () => undefined;
  const stillRunning = shellRun(['er', 'quota'], 60_000, 'win32', {
    spawn: looseCommand.spawn, processes: looseCommand.processes, launch: WRAPPED, signal: stopLoose.signal,
  });
  stopLoose.abort();
  assert.deepEqual(await stillRunning, { stdout: '', stderr: '', code: null, failure: 'er quota 已经停止；无法确认探针进程树已经结束', owed: 700 });
  // A command the stop reached before it started is not started at all.
  const already = new AbortController();
  already.abort();
  const spawns = (() => { throw new Error('停止之后不该开跑'); }) as unknown as typeof import('node:child_process').spawn;
  const notStarted = await shellRun(['er', 'quota'], 1_000, 'win32', { spawn: spawns, launch: WRAPPED, signal: already.signal });
  assert.match(notStarted.failure!, /er quota 在停止之后没有开跑/);
  const notTalked = await shellTalk(['er', 'server'], [{ say: ['one'], answers: () => false }], 1_000, 'win32', { spawn: spawns, launch: WRAPPED, signal: already.signal });
  assert.match(notTalked.failure!, /er server 在停止之后没有开跑/);
});

// -- the machine's client: beside the report, once, and never for a login it does not have ----

const FACTS: NodeFacts = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'test', hostname: 'mac-mini-01.local' };
const processes: HostProcesses = silent();

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, settle };
}

function machineClient(t: TestContext, options: {
  questions: ExecutorQuestion[];
  run?: CommandRun;
  talk?: TalkRun;
  lookEveryMs?: number;
  quotaTimeoutMs?: number;
  answerQuotaTimeout?: boolean | number;
  firstAnswer?: Promise<void>;
  version?: string;
  // What this client is told about the machine's processes, and where it says what it did:
  // the stoppable ones a test decides, and the lines it logs.
  procs?: HostProcesses;
  log?: (line: string) => void;
}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-quota-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const polls: NodeExecutorReport[] = [];
  const stop = new AbortController();
  let firstPoll = true;
  // The client is stopped even when a test fails on the way: its poll loop would otherwise keep
  // the whole test process alive, and a failing test would look like a hanging one.
  t.after(() => stop.abort());
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS,
    procs: options.procs ?? processes, log: options.log ?? (() => {}),
    version: options.version ?? '1.0.0',
    // Every executor command here is a fake; do not consult a real login shell.
    lookupEnv: async () => ({ env: {} }),
    executors: {
      questions: options.questions,
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.talk === undefined ? {} : { talk: options.talk }),
      ...(options.quotaTimeoutMs === undefined ? {} : { quotaTimeoutMs: options.quotaTimeoutMs }),
    },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/api/node/poll')) return new Response('{}', { status: 200 });
      const body = JSON.parse(String(init?.body ?? '{}')) as { executors?: NodeExecutorReport };
      if (body.executors) polls.push(body.executors);
      if (firstPoll) {
        firstPoll = false;
        await options.firstAnswer;
      }
      // Yield as a real held poll would; no assertion depends on this duration.
      await sleep(2);
      return new Response(JSON.stringify({
        protocol: NODE_PROTOCOL, command: null, look_every_ms: options.lookEveryMs ?? 3_600_000, models_timeout_ms: 30_000,
        ...(options.answerQuotaTimeout === false ? {} : { quota_timeout_ms: typeof options.answerQuotaTimeout === 'number' ? options.answerQuotaTimeout : options.quotaTimeoutMs ?? QUOTA_READ_TIMEOUT_MS }),
      }), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  const running = client.run(stop.signal);
  const until = async (enough: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!enough() && Date.now() < deadline) await sleep(5);
    assert.ok(enough(), `等到：${what}`);
  };
  return {
    client, polls, until,
    async finish(): Promise<void> {
      stop.abort();
      await running;
    },
  };
}

test('额度慢不挡报告：报告先走，读数读完再随下一份报告带上；这条读用的是主机下发的时限', { timeout: 10_000 }, async (t) => {
  const held = deferred<CommandAnswer>();
  const firstRead = Promise.withResolvers<void>();
  t.after(() => {
    firstRead.resolve();
    // The fake run does not consume AbortSignal: settle it even on a failed assertion.
    held.settle(failure('测试结束'));
  });
  const quotaTimeouts: number[] = [];
  const run: CommandRun = async (argv, timeoutMs) => {
    const asked = argv.join(' ');
    if (asked === 'er --version') return ok('1.0\n');
    if (asked === 'er login status') return ok('');
    if (asked === 'er quota') { quotaTimeouts.push(timeoutMs); firstRead.resolve(); return held.promise; }
    return failure(`这个测试不该运行 ${asked}`);
  };
  const m = machineClient(t, { questions: [question(READING)], run, lookEveryMs: 20, answerQuotaTimeout: 45_000, firstAnswer: firstRead.promise });
  await m.until(() => quotaTimeouts.length > 0, '额度那一读起头了');
  assert.deepEqual(quotaTimeouts, [QUOTA_READ_TIMEOUT_MS], '主机还没说过时限，用的是客户端自己的 120 秒');
  // The read is still going, and the report has already gone out beside it.
  await m.until(() => m.polls.some((report) => report.executors[0]?.installed === true && report.executors[0]?.logged_in === true), '报告先随 poll 走了');
  assert.equal(m.polls.some((report) => report.executors[0]?.quota !== undefined), false, '额度还没读到，报告不等它');
  held.settle(ok('answering'));
  // The next look reads again, and by now the host has said how long that read may take.
  await m.until(() => quotaTimeouts.length >= 2, '主机说过时限之后的又一次读');
  assert.equal(quotaTimeouts.at(-1), 45_000, '照主机说的 45 秒（node.quotaReadTimeoutMs）');
  await m.until(() => m.polls.at(-1)?.executors[0]?.quota !== undefined, '读数随下一份报告带上');
  const quota = m.polls.at(-1)!.executors[0]!.quota!;
  assert.deepEqual(quota.windows, WINDOW);
  assert.ok(Number.isFinite(Date.parse(quota.at)), '带上读到的时刻');
  await m.finish();
});

test('旧主机不带额度时限：已收到答复之后的读取仍使用客户端 120 秒默认', async (t) => {
  const timeouts: number[] = [];
  const m = machineClient(t, {
    questions: [question(READING)], answerQuotaTimeout: false,
    run: async (argv, timeoutMs) => {
      if (argv.join(' ') === 'er quota') timeouts.push(timeoutMs);
      return ok(argv[1] === '--version' ? '1.0\n' : 'answering');
    },
  });
  await m.until(() => m.polls.some((report) => report.executors[0]?.quota !== undefined), '旧主机已收到第一次读数');
  await m.client.look();
  await m.until(() => timeouts.length >= 2, '收到无时限字段的答复后再读一次');
  assert.deepEqual(timeouts, [QUOTA_READ_TIMEOUT_MS, QUOTA_READ_TIMEOUT_MS]);
  await m.finish();
});

test('同一个执行器同时只读一次；没登录的不读', async (t) => {
  let loggedIn = true;
  const held = deferred<CommandAnswer>();
  let quotaCalls = 0;
  const run: CommandRun = async (argv) => {
    const asked = argv.join(' ');
    if (asked === 'er --version') return ok('1.0\n');
    if (asked === 'er login status') return loggedIn ? ok('') : { stdout: '', stderr: '', code: 1 };
    if (asked === 'er quota') { quotaCalls += 1; return held.promise; }
    return failure(`这个测试不该运行 ${asked}`);
  };
  const m = machineClient(t, { questions: [question(READING)], run, lookEveryMs: 20 });
  await m.until(() => quotaCalls === 1, '第一次读起头了');
  // Several looks later it is still the same one read: two of these commands at once would be
  // two turns of a session on that machine.
  await sleep(120);
  assert.equal(quotaCalls, 1, '正在读的那一次没有并发的第二次');
  held.settle(ok('answering'));
  await m.until(() => quotaCalls >= 2, '读完了，下一次 look 才再读');
  await m.finish();

  // Not signed in: nothing to read, and the read is not attempted at all.
  loggedIn = false;
  let askedQuota = 0;
  const m2 = machineClient(t, {
    questions: [question(READING)],
    run: async (argv) => {
      const asked = argv.join(' ');
      if (asked === 'er --version') return ok('1.0\n');
      if (asked === 'er login status') return { stdout: '', stderr: '', code: 1 };
      if (asked === 'er quota') { askedQuota += 1; return ok('answering'); }
      return failure(`这个测试不该运行 ${asked}`);
    },
  });
  await m2.until(() => m2.polls.some((report) => report.executors[0]?.logged_in === false), '报告说没登录');
  await sleep(30);
  assert.equal(askedQuota, 0, '没登录就不读');
  await m2.finish();
});

test('机器切换登录后，上一份登录尚未完成的额度读取不能随新身份上报', async (t) => {
  let organizationId = 'old-account';
  const oldRead = deferred<CommandAnswer>();
  const newRead = deferred<CommandAnswer>();
  let quotaCalls = 0;
  const run: CommandRun = async (argv, _timeout, _env, signal) => {
    switch (argv.join(' ')) {
      case 'er --version': return ok('1.0\n');
      case 'er login status': return ok(organizationId);
      case 'er quota': {
        const read = ++quotaCalls === 1 ? oldRead : newRead;
        signal?.addEventListener('abort', () => read.settle(failure('测试结束')), { once: true });
        return read.promise;
      }
      default: return failure('不是测试里的命令');
    }
  };
  const m = machineClient(t, {
    questions: [{ ...question(READING), loginIdentity: (stdout: string) => ({ organizationId: stdout }) }],
    run, lookEveryMs: 20,
  });
  await m.until(() => quotaCalls === 1, '旧登录正在读额度');
  organizationId = 'new-account';
  await m.until(() => m.polls.at(-1)?.executors[0]?.identity?.organizationId === organizationId, '已报告新身份');
  oldRead.settle(ok('answering'));
  await m.until(() => quotaCalls >= 2, '新登录已开始读额度');
  assert.equal(m.polls.some(({ executors: [login] }) => login?.identity?.organizationId === organizationId && login.quota !== undefined), false);
  newRead.settle(ok('answering'));
  await m.until(() => m.polls.at(-1)?.executors[0]?.quota !== undefined, '新登录自己的读数随报告上来');
  await m.finish();
});

test('读不出的原因随报告上去，命令的原文不出机器，报告里别的部分照旧', async (t) => {
  const SECRET = 'sk-not-to-leave-this-machine';
  const m = machineClient(t, {
    questions: [question({ kind: 'command', argv: ['er', 'quota'], parse: () => { throw new Error(SECRET); } })],
    run: async (argv) => {
      const asked = argv.join(' ');
      if (asked === 'er --version') return ok('1.0\n');
      if (asked === 'er login status') return ok('');
      return ok(SECRET);
    },
  });
  await m.until(() => m.polls.at(-1)?.executors[0]?.quota !== undefined, '这一读的结论随报告上来');
  const status = m.polls.at(-1)!.executors[0]!;
  assert.deepEqual(status.quota, { at: status.quota!.at, windows: [], error: '额度的回答读不出来' });
  assert.equal(JSON.stringify(status).includes(SECRET), false, '命令的原文不出这台机器');
  assert.equal(status.installed, true, '额度没读到不影响这一份报告里的其余部分');
  assert.equal(status.logged_in, true);
  await m.finish();
});

// What this catches: a client stopped while a login's quota is being read leaving that command
// running on the machine — its lock is released and the next client may start a second read —
// and a look that lands after the stop beginning a fresh read with nobody left to end it.
test('停止客户端：读额度的命令收到停止并等它结束；停止之后的 look 不再起新的读取', async (t) => {
  let reads = 0;
  let stopped = false;
  let finished = false;
  const run: CommandRun = async (argv, _timeoutMs, _env, signal) => {
    const asked = argv.join(' ');
    if (asked === 'er --version') return ok('1.0\n');
    if (asked === 'er login status') return ok('');
    if (asked === 'er quota') {
      reads += 1;
      return await new Promise<CommandAnswer>((resolve) => {
        // A client that does not hand the stop down leaves this read to end by itself, so a
        // failing run still says what it found instead of hanging.
        const alone = setTimeout(() => resolve(failure('这条读没有收到停止信号')), 1_000);
        signal?.addEventListener('abort', () => {
          stopped = true;
          clearTimeout(alone);
          // The ending itself takes a moment: the client waits for it before leaving.
          setTimeout(() => {
            finished = true;
            resolve(failure('er quota 已经停止'));
          }, 20);
        }, { once: true });
      });
    }
    return failure(`这个测试不该运行 ${asked}`);
  };
  const m = machineClient(t, { questions: [question(READING)], run });
  await m.until(() => reads === 1, '额度那一读起头了');
  await m.finish();
  assert.equal(stopped, true, '读额度收到了停止信号');
  assert.equal(finished, true, '客户端等这条读结束（命令收掉）才离开');
  const before = reads;
  await m.client.look();
  assert.equal(reads, before, '停止之后的 look 不再起新的读取');
});

// What this catches: a command a read could not prove gone being forgotten when the read ends —
// the reading is in, so the read is over, but the client leaves and its lock is released with a
// server of tycho's still on the machine. Whoever could still end it is the client, and this is
// where it does — or says it could not.
test('读额度没能确认结束的那条命令：客户端离开前再停一次并核实，验不了就如实说', async (t) => {
  const stopped: number[] = [];
  const stoppable = (found: boolean): HostProcesses => ({
    alive: () => false, startOf: async () => undefined,
    // Neither a table nor a group it can vouch for, on the platform that asks either.
    descendants: async () => (found ? [] : undefined),
    tagged: async () => [],
    endTree: async (pid) => { stopped.push(pid); },
    endGroup: async (pid) => { stopped.push(pid); },
    groupAlive: () => (found ? false : undefined),
  });
  const owedTalk: TalkRun = async () => ({ answer: 'a1', unconfirmed: '无法确认读额度命令的进程树已经结束', owed: 700 });
  const quota = question({ kind: 'talk', argv: ['er', 'server'], steps: () => [{ say: ['one'], answers: () => true }], parse: () => ({ windows: WINDOW }) });
  const logs: string[] = [];
  const m = machineClient(t, {
    questions: [quota],
    run: async (argv) => (argv[1] === '--version' ? ok('1.0\n') : ok('')),
    talk: owedTalk,
    procs: stoppable(true),
    log: (line) => logs.push(line),
  });
  await m.until(() => m.polls.at(-1)?.executors[0]?.quota !== undefined, '读数随报告上来');
  assert.deepEqual(m.polls.at(-1)!.executors[0]!.quota!.windows, WINDOW, '读数照常上报');
  assert.equal(m.polls.at(-1)!.executors[0]!.quota!.error, '无法确认读额度命令的进程树已经结束', '没能确认的状态一起上报');
  await m.finish();
  assert.deepEqual(stopped, [700], '离开前把这条命令再停一次');
  assert.deepEqual(logs, [], '核实过了就不多说');
  // The same leaving where the ending still cannot be confirmed: said, not passed over.
  const loose: string[] = [];
  const stuck = machineClient(t, {
    questions: [quota],
    run: async (argv) => (argv[1] === '--version' ? ok('1.0\n') : ok('')),
    talk: owedTalk,
    procs: stoppable(false),
    log: (line) => loose.push(line),
  });
  await stuck.until(() => stuck.polls.at(-1)?.executors[0]?.quota !== undefined, '读数随报告上来');
  await stuck.finish();
  assert.ok(loose.some((line) => line.includes('读额度用的 er server（pid 700）没能确认已经结束')), loose.join('\n'));
});

test('codex 那种对话读法在这个客户端上照跑：版本是客户端自己的，答的是适配器解析的那一行', async (t) => {
  const seen: string[] = [];
  const talk: TalkRun = async (argv, steps, timeoutMs): Promise<TalkAnswer> => {
    const version = (JSON.parse(steps[0]!.say[0]!) as { params: { clientInfo: { version: string } } }).params.clientInfo.version;
    seen.push(`${argv.join(' ')} @${timeoutMs} v${version}`);
    return { answer: JSON.stringify({ id: 2, result: { rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1795066863 }, secondary: null } } } }) };
  };
  const m = machineClient(t, {
    questions: questionsFrom({ codex: { ...codexAdapter, readOnly: undefined, listModels: undefined, config: undefined, credentialCheck: undefined } }),
    run: async (argv) => (argv[1] === '--version' ? ok('codex-cli 0.167.1\n') : ok('')),
    talk,
    version: '9.9.9',
    quotaTimeoutMs: 20_000,
  });
  await m.until(() => m.polls.at(-1)?.executors[0]?.quota !== undefined, '对话读到的窗口随报告上来');
  assert.deepEqual(seen, ['codex app-server --listen stdio:// @20000 v9.9.9']);
  assert.deepEqual(m.polls.at(-1)!.executors[0]!.quota!.windows, [{ window: 'seven_day', used: 0.01, resets_at: '2026-11-19T05:41:03.000Z' }]);
  await m.finish();

  // An executor with no declared way is never asked, and its report says nothing about quota.
  const m2 = machineClient(t, {
    questions: [question(undefined)],
    run: async (argv) => (argv[1] === '--version' ? ok('1.0\n') : ok('')),
  });
  await m2.until(() => m2.polls.some((report) => report.executors[0]?.installed === true), '报告上来了');
  await sleep(30);
  assert.equal(m2.polls.at(-1)?.executors[0]?.quota, undefined, '不声明就不报这一段');
  await m2.finish();
});

// -- the host: what it keeps of a report, and what it writes it under -------------------------

test('主机收下额度那一段；形状不对就整份拒收，不带这一段的老客户端照收', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 300, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;
  const AT = '2026-11-12T10:00:00.000Z';
  const said = (quota?: unknown): unknown => ({
    at: AT,
    executors: [{ executor: 'claude', installed: true, version: '2.1.303', logged_in: true, ...(quota === undefined ? {} : { quota }) }],
  });
  const windows = [{ window: 'Current week (all models)', used: 0.78, resets_at: '2026-11-14T23:00:00.000Z' }, { window: 'Current week (Fable)', used: 0.09, resets_at: null }];
  // A client from before this field: accepted, and nothing is written under that login.
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: said() as never });
  assert.equal(nodes.reportedExecutors(machine.id)!.executors[0]!.quota, undefined);
  assert.deepEqual(f.ledger.loginState(f.ledger.getMachineLogin(machine.id, 'claude')!.id).usage, []);
  // The quota part itself: only the fields the protocol names are kept.
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: said({ at: AT, windows: [{ ...windows[0], accountId: 'acct' }], raw: 'x' }) as never });
  assert.deepEqual(nodes.reportedExecutors(machine.id)!.executors[0]!.quota, { at: AT, windows: [windows[0]] });
  const report = said({ at: AT, windows, error: '这台机器没读到' });
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: report as never });
  assert.deepEqual(nodes.reportedExecutors(machine.id), report);
  // Out of shape: the whole report is refused and the previous one stands.
  const bad: unknown[] = [
    'a reading', [], {}, { at: 'someday', windows: [] }, { at: AT }, { at: AT, windows: 'one' },
    { at: AT, windows: [null] }, { at: AT, windows: [{}] },
    { at: AT, windows: [{ window: '', used: 0.5, resets_at: null }] },
    { at: AT, windows: [{ window: '   ', used: 0.5, resets_at: null }] },
    { at: AT, windows: [{ window: 'a\nb', used: 0.5, resets_at: null }] },
    { at: AT, windows: [{ window: 'w', used: 'half', resets_at: null }] },
    { at: AT, windows: [{ window: 'w', used: 1.5, resets_at: null }] },
    { at: AT, windows: [{ window: 'w', used: -0.1, resets_at: null }] },
    { at: AT, windows: [{ window: 'w', used: 0.5, resets_at: 'someday' }] },
    { at: AT, windows: [{ window: 'w', used: 0.5, resets_at: 7 }] },
    { at: AT, windows: Array.from({ length: NODE_QUOTA_WINDOWS_MAX + 1 }, (_, index) => ({ window: `w${index}`, used: 0, resets_at: null })) },
    { at: AT, windows: [], error: 7 }, { at: AT, windows: [], error: 'a\nb' },
  ];
  for (const quota of bad) {
    await assert.rejects(async () => nodes.poll(machine.id, { runs: [], facts: FACTS, executors: said(quota) as never }), InputError, JSON.stringify(quota).slice(0, 70));
  }
  assert.deepEqual(nodes.reportedExecutors(machine.id), report, '拒收的一份不替掉前一份');
  // The limits themselves are within the shape, and a reading at the limit travels whole.
  const full = { at: AT, windows: Array.from({ length: NODE_QUOTA_WINDOWS_MAX }, (_, index) => ({ window: `w${index}`, used: 1, resets_at: null })) };
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: said(full) as never });
  assert.deepEqual(nodes.reportedExecutors(machine.id)!.executors[0]!.quota, full);
});

test('机器的读数写在那台机器那份登录的账上，时刻是机器自己读到的；没有那份登录就什么都不写', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 300, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;
  const other = nodes.approve(nodes.register({ ...FACTS, node_id: 'b1b2c3d4e5f60718', name: 'm2' }).code, USER)!;
  // A reading about an executor this machine has no login for: nothing is written anywhere.
  await nodes.poll(other.id, {
    runs: [], facts: FACTS,
    executors: { at: '2026-11-12T10:00:00.000Z', executors: [{ executor: 'quiet', installed: true, version: '1', logged_in: true, quota: { at: '2026-11-12T09:59:00.000Z', windows: [{ window: 'w', used: 0.5, resets_at: null }] } }] } as never,
  });
  assert.equal(f.count('login_state'), 0);
  // The machine's own login is adopted from the same report, and the reading goes with it.
  const AT = '2026-11-12T10:00:00.000Z';
  await nodes.poll(machine.id, {
    runs: [], facts: FACTS,
    executors: { at: AT, executors: [{ executor: 'claude', installed: true, version: '2.1.303', logged_in: true, quota: { at: AT, windows: [{ window: 'Current week (all models)', used: 0.78, resets_at: null }] } }] } as never,
  });
  const login = f.ledger.getMachineLogin(machine.id, 'claude')!;
  assert.deepEqual(f.ledger.loginState(login.id).usage, [{ window: 'Current week (all models)', used: 0.78, resets_at: null, at: AT }]);
});
