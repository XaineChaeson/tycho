// Guards an executor's own sign-in run on a machine (node/sign-in.ts, docs/design/native-login.md),
// with real processes: a stand-in command (tests/fake-sign-in.mjs) that prints the recorded
// Codex device-code screen and an adapter declaration that points at it.
//
// What this file is here to catch:
//   - the link and the code never reaching the poll, or reaching it before both are printed,
//   - a command that ended 0 not reported as done, or the machine not looking at its executors
//     again at once (the host would hear "signed in" only on the next clock),
//   - a command that ended otherwise, or ran out of time, reported as anything but failed, and
//     one out of time left running,
//   - a cancel, a host that no longer names the sign-in, or the client leaving, leaving the
//     command or anything it started running behind,
//   - an ended sign-in dropped before the host has said it saw it, or kept forever after,
//   - a command that prints without end growing the client's memory,
//   - the one-time code written to the client's log,
//   - a command the host sends being run: only the adapter's declared one may be,
//   - a second sign-in of the same executor running beside the first.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { isAlive } from '../service/lock.ts';
import { selectProcesses } from '../node/hostprocess.ts';
import { createMachineSignIns, SIGN_IN_OUTPUT_BYTES } from '../node/sign-in.ts';
import { createClient } from '../node/client.ts';
import type { NodeCommand, NodeFacts, NodeSignIn } from '../shared/node-protocol.ts';

const FAKE = join(import.meta.dirname, 'fake-sign-in.mjs');
const { codexAdapter } = await import('../adapters/codex.ts');
const { readGeminiSignIn } = await import('../adapters/gemini.ts');
const ADAPTERS = {
  stub: { signIn: { argv: [process.execPath, FAKE], read: codexAdapter.signIn!.read } },
  paste: { signIn: { argv: [process.execPath, FAKE], acceptsCode: true, read: readGeminiSignIn } },
};
const URL = 'https://auth.openai.com/codex/device';
const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/auth?client_id=test&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=s1';
const CODE = 'ABCD-12345';

async function until<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

async function canReadProcessTable(): Promise<boolean> {
  return (await selectProcesses().descendants(process.pid)) !== undefined;
}

function bench(t: TestContext, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-sign-in-'));
  const lines: string[] = [];
  let looks = 0;
  const signIns = createMachineSignIns({
    adapters: ADAPTERS,
    lookupEnv: async () => ({ ...process.env, ...env }),
    exclude: [],
    log: (line) => lines.push(line),
    onDone: () => {
      looks += 1;
    },
  });
  t.after(async () => {
    await signIns.stopAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const one = (id: string): NodeSignIn | undefined => signIns.report().find((each) => each.id === id);
  return { dir, lines, signIns, one, looks: () => looks };
}

test('读到网址和码进 waiting；以 0 退出进 done，并马上重看执行器', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-sign-in-go-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const go = join(dir, 'go');
  const b = bench(t, { TYCHO_FAKE_SIGNIN_EXIT: '0', TYCHO_FAKE_SIGNIN_GO: go });
  const started = await b.signIns.start({ sign_in_id: 's1', executor: 'stub', timeout_ms: 60_000 });
  assert.equal(started.state, 'starting', '起了就答，不等登录完成');
  const waiting = await until(() => b.one('s1')?.state === 'waiting' && b.one('s1'), '读到网址和码');
  assert.deepEqual(waiting, { id: 's1', executor: 'stub', state: 'waiting', url: URL, code: CODE });
  assert.equal(b.looks(), 0);
  writeFileSync(go, '');
  await until(() => b.one('s1')?.state === 'done', '以 0 退出');
  assert.equal(b.looks(), 1, '登录成功后马上重看执行器');
  assert.equal(b.lines.join('\n').includes(CODE), false, '日志里没有用户码');
  assert.ok(b.lines.some((line) => line.includes(URL)), '日志里可以有网址');
  assert.ok(b.lines.some((line) => /退出码 0/.test(line)), '日志记下退出码');
});

test('以非 0 退出：failed/exit', async (t) => {
  const b = bench(t, { TYCHO_FAKE_SIGNIN_EXIT: '3' });
  await b.signIns.start({ sign_in_id: 's1', executor: 'stub', timeout_ms: 60_000 });
  const ended = await until(() => b.one('s1')?.state === 'failed' && b.one('s1'), '非 0 退出');
  assert.equal(ended.reason, 'exit');
  assert.equal(b.looks(), 0);
});

test('到时限：进程树被结束，读到过码是 failed/timeout，一直没读到是 failed/unreadable', async (t) => {
  const tree = await canReadProcessTable();
  for (const [quiet, reason] of [[false, 'timeout'], [true, 'unreadable']] as const) {
    const b = bench(t, { TYCHO_FAKE_SIGNIN_PIDS: join(tmpdir(), `tycho-sign-in-pids-${process.pid}-${reason}`), ...(quiet ? { TYCHO_FAKE_SIGNIN_QUIET: '1' } : {}) });
    const pids = join(tmpdir(), `tycho-sign-in-pids-${process.pid}-${reason}`);
    t.after(() => rmSync(pids, { force: true }));
    await b.signIns.start({ sign_in_id: 's1', executor: 'stub', timeout_ms: 2_500 });
    const [own, child] = (await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim(), '登录程序起来了')).split(' ').map(Number);
    if (!quiet) await until(() => b.one('s1')?.state === 'waiting', '读到码');
    const ended = await until(() => b.one('s1')?.state === 'failed' && b.one('s1'), '到时限');
    assert.equal(ended.reason, reason);
    await until(() => !isAlive(own!), '登录程序被结束', 10_000);
    if (tree) await until(() => !isAlive(child!), '它起的进程也被结束', 10_000);
  }
});

test('取消：进程树被结束，记 cancelled；可重复，不认识的也照答', async (t) => {
  const pids = join(tmpdir(), `tycho-sign-in-pids-${process.pid}-cancel`);
  t.after(() => rmSync(pids, { force: true }));
  const b = bench(t, { TYCHO_FAKE_SIGNIN_PIDS: pids });
  await b.signIns.start({ sign_in_id: 's1', executor: 'stub', timeout_ms: 60_000 });
  const [own, child] = (await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim(), '登录程序起来了')).split(' ').map(Number);
  await until(() => b.one('s1')?.state === 'waiting', '读到码');
  assert.deepEqual(await b.signIns.cancel('s1'), { sign_in_id: 's1', known: true });
  assert.equal(b.one('s1')?.state, 'cancelled');
  await until(() => !isAlive(own!), '登录程序被结束', 10_000);
  if (await canReadProcessTable()) await until(() => !isAlive(child!), '它起的进程也被结束', 10_000);
  assert.deepEqual(await b.signIns.cancel('s1'), { sign_in_id: 's1', known: true });
  assert.deepEqual(await b.signIns.cancel('nobody'), { sign_in_id: 'nobody', known: false });
});

test('主机不再列它：没结束的被结束，结束了的从内存里丢掉；列着的一直报', async (t) => {
  const pids = join(tmpdir(), `tycho-sign-in-pids-${process.pid}-keep`);
  t.after(() => rmSync(pids, { force: true }));
  const b = bench(t, { TYCHO_FAKE_SIGNIN_PIDS: pids });
  await b.signIns.start({ sign_in_id: 'live', executor: 'stub', timeout_ms: 60_000 });
  const [own] = (await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim(), '登录程序起来了')).split(' ').map(Number);
  // One that ended: a sign-in of an executor this machine cannot sign in to.
  await b.signIns.start({ sign_in_id: 'ended', executor: 'nobody', timeout_ms: 60_000 });
  assert.deepEqual(b.one('ended'), { id: 'ended', executor: 'nobody', state: 'failed', reason: 'missing' });
  b.signIns.keep(['live', 'ended']);
  assert.deepEqual(b.signIns.report().map((each) => each.id).sort(), ['ended', 'live'], '主机还列着，就一直报，结束了的也报');
  b.signIns.keep(['live']);
  assert.equal(b.one('ended'), undefined, '主机见过了，结束的就丢掉');
  b.signIns.keep([]);
  assert.equal(b.one('live'), undefined);
  await until(() => !isAlive(own!), '主机不记得了的登录程序被结束', 10_000);
});

test('同一个执行器同时只有一次登录：新的来了，旧的先结束', async (t) => {
  const pids = join(tmpdir(), `tycho-sign-in-pids-${process.pid}-twice`);
  t.after(() => rmSync(pids, { force: true }));
  const b = bench(t, { TYCHO_FAKE_SIGNIN_PIDS: pids });
  await b.signIns.start({ sign_in_id: 'old', executor: 'stub', timeout_ms: 60_000 });
  const [own] = (await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim(), '第一次起来了')).split(' ').map(Number);
  await b.signIns.start({ sign_in_id: 'new', executor: 'stub', timeout_ms: 60_000 });
  await until(() => b.one('old')?.state === 'cancelled', '旧的被取消');
  await until(() => !isAlive(own!), '旧的登录程序被结束', 10_000);
  await until(() => b.one('new')?.state === 'waiting', '新的照常');
});

test('内存里的输出有上限：印个不停也只留最近的一段', async (t) => {
  const b = bench(t, { TYCHO_FAKE_SIGNIN_FLOOD: '1024' });
  await b.signIns.start({ sign_in_id: 's1', executor: 'stub', timeout_ms: 60_000 });
  await until(() => (b.signIns.heldOutput('s1') ?? 0) >= SIGN_IN_OUTPUT_BYTES, '印满');
  await sleep(500);
  assert.ok(b.signIns.heldOutput('s1')! <= SIGN_IN_OUTPUT_BYTES, `留了 ${b.signIns.heldOutput('s1')}`);
  assert.equal(b.one('s1')?.state, 'waiting', '先印出来的网址和码已经读到');
});

test('命令找不到、执行器不认识：如实答失败，不抛', async (t) => {
  const b = bench(t);
  const missing = createMachineSignIns({
    adapters: { stub: { signIn: { argv: ['tycho_sign_in_definitely_absent_91c', 'login'], read: () => undefined } } },
    lookupEnv: async () => process.env, exclude: [], log: () => {}, onDone: () => {},
  });
  t.after(() => missing.stopAll());
  assert.deepEqual(await missing.start({ sign_in_id: 's1', executor: 'stub', timeout_ms: 1000 }), { id: 's1', executor: 'stub', state: 'failed', reason: 'missing' });
  assert.deepEqual(await b.signIns.start({ sign_in_id: 's2', executor: 'toString', timeout_ms: 1000 }), { id: 's2', executor: 'toString', state: 'failed', reason: 'missing' });
});

const FACTS: NodeFacts = { node_id: 'a1b2c3d4e5f60718', name: 'm1', platform: 'test', hostname: 'm1' };

// The command is the adapter's: what the host sends beside the executor's name is not read.
test('客户端收到 sign_in：只跑适配器声明的命令，主机多给的字段不读；成功后重看执行器', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-sign-in-client-'));
  const mark = join(dataDir, 'argv.json');
  const asked: string[][] = [];
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, log: () => {},
    fetch: (() => Promise.reject(new Error('这个测试不该去问主机'))) as unknown as typeof globalThis.fetch,
    lookupEnv: async () => ({ env: { ...process.env, TYCHO_FAKE_SIGNIN_EXIT: '0', TYCHO_FAKE_SIGNIN_MARK: mark } }),
    executors: {
      questions: [{ executor: 'stub', command: 'stub-cli', version: ['--version'] }],
      run: async (argv) => {
        asked.push(argv);
        return { stdout: 'stub-cli 1.0\n', stderr: '', code: 0 };
      },
    },
    signIn: { adapters: ADAPTERS },
  });
  t.after(async () => {
    await client.stopSignIns();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const answer = (await client.execute({
    id: 'c1', kind: 'sign_in', sign_in_id: 's1', executor: 'stub', timeout_ms: 60_000,
    argv: ['rm', '-rf', '/'], command: 'evil', env: { X: '1' },
  } as unknown as NodeCommand)) as NodeSignIn;
  assert.equal(answer.id, 's1');
  await until(() => client.signIns().find((each) => each.id === 's1')?.state === 'done', '登录结束');
  assert.deepEqual(JSON.parse(readFileSync(mark, 'utf8')), [], '跑的是适配器声明的命令，参数一个都没多');
  await until(() => asked.length > 0, '重看执行器');
});

// Through the poll loop: the sign-in rides the polls, and the client leaving ends it.
test('客户端退出时不留登录进程；poll 带着登录状态，回答里的清单决定留谁', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-sign-in-loop-'));
  const pids = join(dataDir, 'pids');
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const sent: { sign_ins?: NodeSignIn[] }[] = [];
  let handed = false;
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { sign_ins?: NodeSignIn[] };
    if (url.endsWith('/api/node/poll')) {
      sent.push(body);
      const command = handed ? null : { id: 'c1', kind: 'sign_in', sign_in_id: 's1', executor: 'stub', timeout_ms: 60_000 };
      handed = true;
      if (command === null) await sleep(50, undefined, { signal: init.signal! });
      return new Response(JSON.stringify({ protocol: 5, command, look_every_ms: 600_000, sign_ins: ['s1'] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, log: () => {}, fetch,
    lookupEnv: async () => ({ env: { ...process.env, TYCHO_FAKE_SIGNIN_PIDS: pids } }),
    executors: { questions: [], run: async () => ({ stdout: '', stderr: '', code: 0 }) },
    signIn: { adapters: ADAPTERS },
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  const [own] = (await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim(), '登录程序起来了')).split(' ').map(Number);
  await until(() => sent.some((each) => each.sign_ins?.some((one) => one.id === 's1' && one.state === 'waiting' && one.code === CODE)), 'poll 报了 waiting 和码');
  stop.abort();
  await running;
  assert.equal(isAlive(own!), false, '客户端退出时登录程序已经结束');
});

test('acceptsCode 模式（agy acp --login）：读到网址进 waiting(accepts_code)，交授权码写进 stdin，成功进 done 且日志不留授权码', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-sign-in-paste-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdinOut = join(dir, 'stdin.txt');
  const secretAuthCode = '4/0AeanS0aSecretAuthCode_998877';
  const b = bench(t, {
    TYCHO_FAKE_SIGNIN_PASTE: '1',
    TYCHO_FAKE_SIGNIN_STDIN_OUT: stdinOut,
    TYCHO_FAKE_SIGNIN_EXPECT: secretAuthCode,
  });

  const started = await b.signIns.start({ sign_in_id: 'g1', executor: 'paste', timeout_ms: 60_000 });
  assert.equal(started.state, 'starting');
  const waiting = await until(() => b.one('g1')?.state === 'waiting' && b.one('g1'), '读到 Google 授权网址');
  assert.deepEqual(waiting, { id: 'g1', executor: 'paste', state: 'waiting', url: GOOGLE_URL, accepts_code: true });

  const exchanging = b.signIns.submitCode('g1', `  ${secretAuthCode}\r\n `);
  assert.deepEqual(exchanging, { id: 'g1', executor: 'paste', state: 'exchanging', url: GOOGLE_URL });

  await until(() => b.one('g1')?.state === 'done', '授权码换取成功并以 0 退出');
  assert.equal(readFileSync(stdinOut, 'utf8'), secretAuthCode);
  assert.equal(b.looks(), 1, '登录成功后马上重看执行器');
  assert.equal(b.lines.join('\n').includes(secretAuthCode), false, '节点日志绝不记录授权码');

  // Wrong code exits non-zero -> failed/exit without triggering onDone.
  const bBad = bench(t, {
    TYCHO_FAKE_SIGNIN_PASTE: '1',
    TYCHO_FAKE_SIGNIN_EXPECT: secretAuthCode,
  });
  await bBad.signIns.start({ sign_in_id: 'g2', executor: 'paste', timeout_ms: 60_000 });
  await until(() => bBad.one('g2')?.state === 'waiting', '第二次读到网址');
  bBad.signIns.submitCode('g2', 'wrong-code');
  const failed = await until(() => bBad.one('g2')?.state === 'failed' && bBad.one('g2'), '错误授权码退出');
  assert.equal(failed.reason, 'exit');
  assert.equal(bBad.looks(), 0);
});
