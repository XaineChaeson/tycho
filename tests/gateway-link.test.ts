// Guards against the connection to the gateway being kept wrongly: an ssh started with
// arguments that do not forward what the settings say, a key path with a space in it
// arriving in two pieces, a machine name that ssh would read as an option; a connection
// called up before ssh has said the forward was accepted; a lost one not made again, or
// made again without a pause, or the pauses never coming back down after it held; what
// ssh said being lost, or buried in what -v adds; a changed setting leaving the old ssh
// beside the new one; a switch-off or a stop leaving an ssh or the outside listener
// behind; an ssh that ended on its own being ended again, or one left by a service that
// did not stop living on next to the new one; and failed ownership writes starting ssh,
// cleanup failures crashing the service, background or proxy processes escaping
// supervision, and unbounded stderr lines.
import './guard.ts';
import assert from 'node:assert/strict';
import childProcess, { ChildProcess, spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { GatewayConfig, GatewayOptions, GatewayStatus } from '../service/gateway.ts';
import { createGateway, gatewayMarker, parseTarget, sshArgs, targetProblem } from '../service/gateway.ts';
import { isAlive, processStartLater } from '../service/lock.ts';
import type { Processes } from '../service/processes.ts';
import { hostProcesses, rootSpawnOptions } from '../service/processes.ts';

const FAKE = join(import.meta.dirname, 'fake-ssh.mjs');
const options = { timeout: 60_000 };
const MARKER = 'TYCHO_GATEWAY_0123456789abcdef';

const COMMON = [
  '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
  '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
  '-o', 'ForkAfterAuthentication=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
  '-o', `SendEnv=${MARKER}`,
];

async function until<T>(read: () => T | undefined | false | null, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(10);
  }
}

// Observe direct children before spawn returns, including ones that exit before kill
// returns. A recycled pid cannot change an exit event we have already received.
const observers = new WeakMap<TestContext, Map<number, { child: ChildProcess; done: Promise<void>; ended: boolean }>>();
function observeChildren(t: TestContext, launch?: typeof spawn) {
  const existing = observers.get(t);
  if (existing) return existing;
  const children = new Map<number, { child: ChildProcess; done: Promise<void>; ended: boolean }>();
  observers.set(t, children);
  const original = childProcess.spawn;
  const observing = t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof spawn>) => {
    const child = launch && args[0] === process.execPath && args[1]?.[0] === FAKE ? launch(...args) : original(...args);
    if (child.pid !== undefined) {
      const done = Promise.withResolvers<void>();
      const record = { child, done: done.promise, ended: false };
      child.once('exit', () => { record.ended = true; done.resolve(); });
      children.set(child.pid, record);
    }
    return child;
  }) as typeof spawn);
  syncBuiltinESMExports();
  t.after(() => { observing.mock.restore(); syncBuiltinESMExports(); });
  return children;
}

// The lines another process has finished appending: what a test polls and parses. A fake
// ssh may be between creating the file and writing its line, or halfway through the line,
// while the test reads.
function written(file: string): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.pop();
  return lines;
}

// Every line there, one still being written included: what a test counts at its end.
function anything(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function setup(t: TestContext, plan?: string[], launch?: typeof spawn) {
  const observed = observeChildren(t, launch);
  const dir = mkdtempSync(join(tmpdir(), 'tycho-gateway-'));
  const log = join(dir, 'ssh.log');
  const pidFile = join(dir, 'gateway.pid');
  if (plan) writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  const previous = { ...process.env };
  Object.assign(process.env, { FAKE_SSH_LOG: log, FAKE_SSH_PLAN: join(dir, 'plan.json'), FAKE_SSH_RECORD: pidFile });
  const config: GatewayConfig = { ssh: 'deploy@door.example', keyFile: '', remotePort: 18787, localPort: 8788 };
  // What the supervisor did to the outside listener, in order.
  const listener: string[] = [];
  const made: ReturnType<typeof createGateway>[] = [];
  const strays: number[] = [];
  // One hook, in this order: a directory cannot go while a process still has files in it.
  t.after(async () => {
    for (const gateway of made) await gateway.stop();
    for (const pid of new Set([...starts().map(({ pid }) => pid), ...strays])) {
      if (!observed.get(pid)?.ended) await end(pid);
    }
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  });

  const children = (): number[] => written(join(dir, 'children.log')).map(Number);
  const starts = (): { pid: number; argv: string[]; intent?: string }[] =>
    written(log).map((line) => JSON.parse(line) as { pid: number; argv: string[]; intent?: string });

  function gateway(extra: Partial<GatewayOptions> = {}) {
    const one = createGateway({
      config: () => ({ ...config }),
      marker: MARKER,
      pidFile,
      listen: async (port) => void listener.push(`listen ${port}`),
      unlisten: async () => void listener.push('unlisten'),
      command: [process.execPath, FAKE],
      processes: {
        find: async () => starts().map(({ pid }) => pid).filter(alive),
        kill: (pid) => end(pid),
      },
      log: () => {},
      ...extra,
    });
    made.push(one);
    return one;
  }

  // An ssh as a service that did not stop would have left it: running, with the marker
  // on its command line, and its pid in the file.
  async function stray(): Promise<number> {
    const child = spawn(process.execPath, [FAKE, ...sshArgs(config, MARKER)!], { stdio: 'ignore', ...rootSpawnOptions(process.platform) });
    strays.push(child.pid!);
    await until(() => starts().some(({ pid }) => pid === child.pid), '上次留下的 ssh 起来');
    writeFileSync(pidFile, `${child.pid}\n`);
    return child.pid!;
  }

  // For what a test asserts at its end: every line there, one still being written included,
  // so a start halfway through its line counts and "nothing started" cannot pass on it.
  const startsSeen = (): number => anything(log).length;
  const childrenSeen = (): number => anything(join(dir, 'children.log')).length;

  // The starts this test has seen end, and how many starts there were when it saw it. A
  // pid alone comes to mean another process once the first is gone, so nothing asks a pid
  // afterwards whether it is alive: its end is seen while the process at it is still the
  // one that was started, and that is what a test asserts on.
  const ended = new Map<number, number>();
  const alive = (pid: number): boolean => observed.has(pid) && !observed.get(pid)!.ended;
  async function end(pid: number): Promise<void> {
    const child = observed.get(pid);
    assert.ok(child, `进程 ${pid} 的启动必须已被观察`);
    if (child.ended) return;
    await hostProcesses.kill(pid, MARKER);
    await child.done;
    ended.set(pid, startsSeen());
  }

  return { dir, config, listener, pidFile, starts, children, startsSeen, childrenSeen, ended, alive, end, observed, gateway, stray };
}

// Reconnection policy needs process events, not real OS starts. Keep real processes in
// the ownership and tree-cleanup tests; drive stderr, exit and backoff explicitly here.
function controlledSsh(t: TestContext) {
  const children: ChildProcess[] = [];
  const ready: ChildProcess[] = [];
  let waiting: ((child: ChildProcess) => void) | undefined;
  const launch = (() => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 400 + children.length });
    child.stderr = new PassThrough();
    children.push(child);
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(child); }
    else ready.push(child);
    return child;
  }) as typeof spawn;
  const s = setup(t, undefined, launch);
  const finish = (child: ChildProcess): void => {
    child.emit('exit', 255, null);
    child.emit('close', 255, null);
  };
  return {
    ...s,
    next: (): Promise<ChildProcess> => ready.length ? Promise.resolve(ready.shift()!) : new Promise((resolve) => { waiting = resolve; }),
    say: (child: ChildProcess, text: string): void => { child.stderr!.emit('data', Buffer.from(text + '\n')); },
    finish,
    count: () => children.length,
    gateway: (extra: Partial<GatewayOptions> = {}) => s.gateway({
      processes: { find: async () => [], kill: async (pid) => finish(children.find((child) => child.pid === pid)!) },
      ...extra,
    }),
  };
}

const connected = (gateway: { status(): GatewayStatus }): Promise<GatewayStatus> =>
  until(() => gateway.status().state === 'connected' && gateway.status(), '门牌连上');

test('ssh is told to forward the gateway port to the outside listener, and nothing else about how to get there', () => {
  assert.deepEqual(sshArgs({ ssh: 'deploy@door.example', keyFile: '', remotePort: 18787, localPort: 8788 }, MARKER), [
    '-N', '-v', '-R', '127.0.0.1:18787:127.0.0.1:8788', ...COMMON, 'deploy@door.example',
  ]);
  assert.deepEqual(sshArgs({ ssh: 'ops_1@203.0.113.7:2222', keyFile: 'C:\\Users\\some one\\.ssh\\door key', remotePort: 9000, localPort: 9001 }, MARKER), [
    '-N', '-v', '-R', '127.0.0.1:9000:127.0.0.1:9001', ...COMMON,
    '-i', 'C:\\Users\\some one\\.ssh\\door key', '-o', 'IdentitiesOnly=yes', '-p', '2222', 'ops_1@203.0.113.7',
  ]);
});

test('a machine that is not user@host or user@host:port is refused, above all one ssh would read as an option', () => {
  assert.deepEqual(parseTarget('deploy@door.example'), { user: 'deploy', host: 'door.example' });
  assert.deepEqual(parseTarget('deploy@door.example:2222'), { user: 'deploy', host: 'door.example', port: 2222 });
  for (const bad of [
    'door.example', '@door.example', 'deploy@', '-oProxyCommand=calc@door.example', 'deploy@-oProxyCommand=calc', 'deploy@door.example:0',
    'deploy@door.example:65536', 'deploy@door.example:22x', 'deploy@door example', 'deploy@door.example -v', 'de ploy@door.example', 'deploy@door.example:',
  ]) {
    assert.equal(parseTarget(bad), undefined, bad);
    assert.equal(sshArgs({ ssh: bad, keyFile: '', remotePort: 1, localPort: 2 }, MARKER), undefined, bad);
    assert.match(targetProblem(bad)!, /用户名@地址/, bad);
  }
  assert.equal(targetProblem(''), null, '空就是不启用');
  assert.equal(targetProblem('deploy@door.example'), null);
});

test('the marker is one per data directory, the same at every start, and a word a search can find', (t) => {
  const { dir } = setup(t);
  const other = join(dir, 'other');
  mkdirSync(other);
  assert.match(gatewayMarker(dir), /^TYCHO_GATEWAY_[0-9a-f]{16}$/);
  assert.equal(gatewayMarker(dir), gatewayMarker(join(dir, '.')));
  assert.notEqual(gatewayMarker(dir), gatewayMarker(other));
});

test('with no gateway set nothing is started and nothing listens', options, async (t) => {
  const s = setup(t);
  s.config.ssh = '';
  const gateway = s.gateway();
  gateway.start();
  await gateway.stop();
  assert.deepEqual(gateway.status(), { state: 'off', since: null, error: null });
  assert.equal(s.startsSeen(), 0);
  assert.deepEqual(s.listener, []);
});

test('it listens, starts ssh with the arguments as given, and is connected only once ssh says the forward is up', options, async (t) => {
  const s = setup(t);
  s.config.keyFile = join(s.dir, 'door key');
  // A clock that moves a second each time it is read.
  let clock = Date.parse('2026-11-06T08:00:00.000Z');
  let whileListening: GatewayStatus | undefined;
  let gateway: ReturnType<typeof createGateway>;
  gateway = s.gateway({
    now: () => (clock += 1000),
    async listen(port) {
      s.listener.push(`listen ${port}`);
      whileListening = gateway.status();
      assert.equal(s.startsSeen(), 0, '先有对外入口，再有连接');
    },
  });
  gateway.start();
  assert.deepEqual(gateway.status(), { state: 'off', since: null, error: null }, '还没开始');
  assert.deepEqual(await connected(gateway), { state: 'connected', since: '2026-11-06T08:00:02.000Z', error: null });
  assert.deepEqual(whileListening, { state: 'connecting', since: '2026-11-06T08:00:01.000Z', error: null }, 'ssh 说转发建立之前只是连接中');
  assert.deepEqual(s.listener, ['listen 8788']);
  const { pid, argv } = s.starts()[0]!;
  assert.deepEqual(argv, sshArgs(s.config, MARKER), '带空格的密钥路径是一个参数');
  assert.equal(argv[argv.indexOf('-i') + 1], join(s.dir, 'door key'));
  assert.deepEqual(JSON.parse(readFileSync(s.pidFile, 'utf8')), { state: 'starting', marker: MARKER });
  assert.deepEqual(JSON.parse(s.starts()[0]!.intent!), { state: 'starting', marker: MARKER }, 'ssh 创建前记录已经在');

  await gateway.stop();
  assert.equal(s.ended.has(pid), true, '停服后不留 ssh');
  assert.equal(existsSync(s.pidFile), false);
  assert.deepEqual(s.listener, ['listen 8788', 'unlisten']);
  assert.equal(gateway.status().state, 'off');
});

test('a recycled pid cannot keep an observed ssh alive', options, async (t) => {
  const s = setup(t);
  const gateway = s.gateway();
  gateway.start();
  await connected(gateway);
  const { pid } = s.starts()[0]!;
  const kill = hostProcesses.kill;
  t.mock.method(hostProcesses, 'kill', async (target: number, marker: string) => {
    await kill(target, marker);
    await s.observed.get(target)!.done;
  });
  const original = process.kill;
  // Once the original child exits, the OS may report that pid alive again. Only a
  // liveness query is simulated; never send a real signal to a recycled identity.
  t.mock.method(process, 'kill', (target: number, signal?: NodeJS.Signals | number) => {
    if (target === pid && s.observed.get(pid)!.ended) {
      assert.equal(signal, 0, '不得向复用的 pid 发停止信号');
      return true;
    }
    return original(target, signal);
  });
  await gateway.stop();
  assert.equal(s.ended.has(pid), true);
  assert.equal(existsSync(s.pidFile), false);
});

test('an ssh that runs and never says the forward is up is not a connection', options, async (t) => {
  const s = setup(t, ['silent']);
  const gateway = s.gateway();
  gateway.start();
  await until(() => s.starts().length === 1, 'ssh 启动');
  await sleep(300);
  assert.equal(gateway.status().state, 'connecting');
  assert.equal(gateway.status().error, null);
});

test('a connection that cannot be made is tried again after 1 second, then twice as long each time, up to a minute', options, async (t) => {
  const s = controlledSsh(t);
  const pauses: number[] = [];
  const seen: GatewayStatus[] = [];
  let gateway: ReturnType<typeof createGateway>;
  const hold = Promise.withResolvers<void>();
  gateway = s.gateway({
    async sleep(ms, signal) {
      pauses.push(ms);
      seen.push(gateway.status());
      // Nine tries are enough to see the ceiling; the tenth waits for the stop.
      if (pauses.length === 9) {
        hold.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      }
    },
  });
  gateway.start();
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const child = await s.next();
    s.say(child, 'ssh: connect to host door.example port 22: Connection refused');
    s.finish(child);
  }
  await hold.promise;
  assert.deepEqual(pauses, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  assert.equal(s.count(), 9, '每等一次才试一次');
  for (const status of seen) {
    assert.deepEqual([status.state, status.error], ['down', 'ssh: connect to host door.example port 22: Connection refused']);
  }
  assert.equal(new Set(seen.map(({ since }) => since)).size, 1, '一直没连上：断开的时刻不变');
  assert.deepEqual(s.listener, ['listen 8788'], '对外入口不跟着重连反复开关');
});

test('after a connection that held, the next loss starts again from 1 second; what ssh said last is the reason', options, async (t) => {
  const s = controlledSsh(t);
  const pauses: number[] = [];
  const seen: GatewayStatus[] = [];
  let gateway: ReturnType<typeof createGateway>;
  gateway = s.gateway({
    async sleep(ms) {
      pauses.push(ms);
      seen.push(gateway.status());
    },
  });
  gateway.start();
  for (const step of ['drop', 'taken', 'mute', 'drop']) {
    const child = await s.next();
    if (step === 'drop') {
      s.say(child, 'debug1: remote forward success for: listen 127.0.0.1:18787, connect 127.0.0.1:8788');
      assert.equal(gateway.status().state, 'connected');
      s.say(child, 'Connection to door.example closed by remote host.');
      s.say(child, 'Transferred: sent 3212, received 2936 bytes, in 4.3 seconds');
      s.say(child, 'Bytes per second: sent 742.9, received 679.1');
    } else if (step === 'taken') {
      s.say(child, 'debug1: remote forward failure for: listen 127.0.0.1:18787, connect 127.0.0.1:8788');
      s.say(child, 'Error: remote port forwarding failed for listen port 18787');
    }
    s.finish(child);
  }
  const fifth = await s.next();
  assert.equal(s.count(), 5);
  s.say(fifth, 'debug1: remote forward success for: listen 127.0.0.1:18787, connect 127.0.0.1:8788');
  const up = await connected(gateway);
  assert.deepEqual(pauses, [1000, 2000, 4000, 1000]);
  assert.deepEqual(seen.map(({ state, error }) => [state, error]), [
    // What -v prints besides: the version, who it signed in as, the byte counts.
    ['down', 'Connection to door.example closed by remote host.'],
    ['down', 'Error: remote port forwarding failed for listen port 18787'],
    ['down', 'ssh 退出了（退出码 255），什么都没说'],
    ['down', 'Connection to door.example closed by remote host.'],
  ]);
  assert.equal(up.error, null, '连上之后不再挂着上一次的原因');
  assert.ok(seen[0]!.since! <= seen[3]!.since! && seen[3]!.since! <= up.since!);
});

test('while it tries again, the state says so and keeps the reason of the last failure', options, async (t) => {
  const s = setup(t, ['refused', 'silent']);
  const gateway = s.gateway({ sleep: async () => {} });
  gateway.start();
  await until(() => s.starts().length === 2, '第二次启动');
  await until(() => gateway.status().state === 'connecting', '回到连接中');
  assert.equal(gateway.status().error, 'ssh: connect to host door.example port 22: Connection refused');
});

test('an ssh that ended by itself is not ended again', options, async (t) => {
  const s = setup(t, ['refused']);
  const killed: number[] = [];
  const waiting = Promise.withResolvers<void>();
  const gateway = s.gateway({
    processes: {
      find: async () => s.starts().map(({ pid }) => pid).filter(s.alive),
      async kill(pid, marker) {
        killed.push(pid);
        await hostProcesses.kill(pid, marker);
      },
    },
    async sleep(_ms, signal) {
      waiting.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  gateway.start();
  await waiting.promise;
  assert.deepEqual(killed, [], '自己结束的 ssh 不再结束一次');
  assert.equal(s.startsSeen(), 1);
});

test('an ssh that cannot be started at all is a reason like any other', options, async (t) => {
  const s = setup(t);
  const seen = Promise.withResolvers<GatewayStatus>();
  let gateway: ReturnType<typeof createGateway>;
  gateway = s.gateway({
    command: [join(s.dir, 'no-such-ssh')],
    async sleep(_ms, signal) {
      seen.resolve(gateway.status());
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  gateway.start();
  const status = await seen.promise;
  assert.equal(status.state, 'down');
  assert.match(status.error!, /^ssh 启动不了：.*ENOENT/);
});

test('a machine name the settings would not have taken starts no ssh', options, async (t) => {
  const s = setup(t);
  s.config.ssh = '-oProxyCommand=calc@door.example';
  const gateway = s.gateway({ sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) });
  gateway.start();
  await until(() => gateway.status().state === 'down', '报出来');
  assert.match(gateway.status().error!, /门牌机器写得不对/);
  assert.equal(s.startsSeen(), 0);
  assert.deepEqual(s.listener, []);
});

test('when the outside listener cannot come up, that is the reason, no ssh is started, and it is tried again', options, async (t) => {
  const s = setup(t);
  let taken = true;
  const pauses: number[] = [];
  const seen: GatewayStatus[] = [];
  let gateway: ReturnType<typeof createGateway>;
  gateway = s.gateway({
    async listen(port) {
      if (taken) throw new Error(`对外入口的端口 ${port} 被别的程序占着`);
      s.listener.push(`listen ${port}`);
    },
    async sleep(ms) {
      pauses.push(ms);
      seen.push(gateway.status());
      assert.equal(s.startsSeen(), 0, '入口没起来就不连');
      if (pauses.length === 2) taken = false;
    },
  });
  gateway.start();
  await connected(gateway);
  assert.deepEqual(pauses, [1000, 2000]);
  assert.deepEqual(seen.map(({ state, error }) => [state, error]), [['down', '对外入口的端口 8788 被别的程序占着'], ['down', '对外入口的端口 8788 被别的程序占着']]);
  assert.deepEqual(s.listener, ['listen 8788']);
  assert.equal(s.startsSeen(), 1);
});

test('a changed setting ends the old ssh and the old listener before the new ones come up', options, async (t) => {
  const s = setup(t);
  const gateway = s.gateway();
  gateway.start();
  await connected(gateway);
  const first = s.starts()[0]!;

  Object.assign(s.config, { ssh: 'ops@other.example:2200', remotePort: 19000, localPort: 9100 });
  gateway.reconfigure();
  await until(() => s.starts().length === 2, '按新值重连');
  const second = s.starts()[1]!;
  // Not "is that pid alive": the pid the old ssh had is free to come to mean another
  // process. What says the two did not stand side by side is seeing the old one end
  // while it was still the only start.
  assert.equal(s.ended.get(first.pid), 1, '旧的 ssh 不和新的并存');
  assert.deepEqual(second.argv, sshArgs(s.config, MARKER));
  assert.equal(second.argv.includes('127.0.0.1:19000:127.0.0.1:9100'), true);
  await connected(gateway);
  assert.deepEqual(s.listener, ['listen 8788', 'unlisten', 'listen 9100']);

  // Several changes in a row leave one connection, on the last of them.
  s.config.remotePort = 19001;
  gateway.reconfigure();
  s.config.remotePort = 19002;
  gateway.reconfigure();
  await until(() => s.starts().at(-1)?.argv.includes('127.0.0.1:19002:127.0.0.1:9100'), '最后一次的值');
  await connected(gateway);
  const last = s.starts().at(-1)!;
  for (const earlier of s.starts().slice(0, -1)) {
    assert.equal(s.ended.has(earlier.pid), true, '先前的连接都结束了');
  }
  assert.equal(isAlive(last.pid), true, '留下来的只有最后一次');
  assert.equal(last.argv.includes('127.0.0.1:19002:127.0.0.1:9100'), true);
});

test('clearing the machine ends the ssh and closes the listener; setting it again brings both back', options, async (t) => {
  const s = setup(t);
  const gateway = s.gateway();
  gateway.start();
  await connected(gateway);
  const { pid } = s.starts()[0]!;
  s.config.ssh = '';
  gateway.reconfigure();
  await until(() => gateway.status().state === 'off', '停用');
  assert.equal(s.ended.has(pid), true);
  assert.deepEqual(s.listener, ['listen 8788', 'unlisten']);
  assert.equal(existsSync(s.pidFile), false);

  s.config.ssh = 'deploy@door.example';
  gateway.reconfigure();
  await connected(gateway);
  assert.deepEqual(s.listener, ['listen 8788', 'unlisten', 'listen 8788']);
  assert.equal(s.startsSeen(), 2);
});

test('a stop during the pause before a retry, or before ssh has connected, leaves nothing running', options, async (t) => {
  const s = setup(t, ['refused', 'silent']);
  const waiting = Promise.withResolvers<void>();
  const gateway = s.gateway({
    async sleep(_ms, signal) {
      waiting.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  gateway.start();
  await waiting.promise;
  await gateway.stop();
  assert.equal(s.startsSeen(), 1, '停了就不再重连');
  assert.deepEqual(s.listener, ['listen 8788', 'unlisten']);
  // Nothing is made after a stop, whoever asks.
  gateway.reconfigure();
  gateway.start();
  await sleep(200);
  assert.equal(s.startsSeen(), 1);

  const other = setup(t, ['silent']);
  const second = other.gateway();
  second.start();
  await until(() => other.starts().length === 1, 'ssh 启动');
  await second.stop();
  assert.equal(other.ended.has(other.starts()[0]!.pid), true);
  assert.equal(existsSync(other.pidFile), false);
});

test('an ssh left by a service that did not stop is ended before a new one is started', options, async (t) => {
  const s = setup(t);
  const left = await s.stray();
  const calls: string[] = [];
  const stopped = new Set<number>();
  const processes: Processes = {
    async find(marker) {
      calls.push(`find ${marker}`);
      return s.alive(left) ? [left] : [];
    },
    async kill(pid, marker) {
      if (!s.alive(pid)) return;
      calls.push(`kill ${pid} ${marker}`);
      if (pid === left) assert.equal(s.startsSeen(), 1, '清掉之前不能起新的');
      await s.end(pid);
      stopped.add(pid);
    },
  };
  const gateway = s.gateway({ processes });
  gateway.start();
  await connected(gateway);
  assert.equal(stopped.has(left), true);
  assert.deepEqual(calls, [`find ${MARKER}`, `kill ${left} ${MARKER}`, `find ${MARKER}`]);
  assert.equal(s.startsSeen(), 2);
  assert.deepEqual(JSON.parse(readFileSync(s.pidFile, 'utf8')), { state: 'starting', marker: MARKER }, '记录不靠 pid 认领进程');

  // A later change also verifies the old connection has gone.
  s.config.remotePort = 19000;
  gateway.reconfigure();
  await until(() => s.starts().length === 3, '重连');
  assert.ok(calls.filter((call) => call.startsWith('find ')).length > 2, '每次结束都核实旧执行不在');
});

test('what was left is ended even when the gateway has since been switched off', options, async (t) => {
  const s = setup(t);
  const left = await s.stray();
  s.config.ssh = '';
  const cleared = Promise.withResolvers<void>();
  const gateway = s.gateway({
    processes: {
      find: async () => (s.alive(left) ? [left] : []),
      async kill(pid) {
        await s.end(pid);
        cleared.resolve();
      },
    },
  });
  gateway.start();
  await cleared.promise;
  await until(() => !existsSync(s.pidFile), '记录删掉');
  assert.equal(gateway.status().state, 'off');
  assert.equal(s.startsSeen(), 1, '只有留下的那一个，没有起新的');
});

test('one that cannot be ended stops the connection from being made, says why, and is tried again', options, async (t) => {
  const s = setup(t);
  const left = await s.stray();
  let stubborn = true;
  let gone = false;
  const pauses: number[] = [];
  const seen: GatewayStatus[] = [];
  let gateway: ReturnType<typeof createGateway>;
  gateway = s.gateway({
    processes: {
      find: async () => (s.alive(left) ? [left] : []),
      async kill(pid) {
        if (stubborn) return;
        await s.end(pid);
        gone = true;
      },
    },
    async sleep(ms) {
      pauses.push(ms);
      seen.push(gateway.status());
      assert.equal(s.startsSeen(), 1, '旧的还在就不起新的');
      stubborn = false;
    },
  });
  gateway.start();
  await connected(gateway);
  assert.deepEqual(pauses, [1000]);
  assert.deepEqual([seen[0]!.state, seen[0]!.error], ['down', `上次留下的门牌连接（ssh）清不掉：pid ${left}`]);
  assert.equal(gone, true);
});


test('a record that cannot be written starts no ssh', options, async (t) => {
  const s = setup(t);
  const gateway = s.gateway({ pidFile: join(s.dir, 'missing', 'gateway.pid'), sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) });
  gateway.start();
  await until(() => gateway.status().state === 'down', '记录写失败');
  await sleep(150);
  assert.equal(s.startsSeen(), 0, '写意图失败不得拉起进程');
});

test('a starting intent left by a crash is enough to clear the marked ssh', options, async (t) => {
  const s = setup(t);
  const left = await s.stray();
  writeFileSync(s.pidFile, JSON.stringify({ state: 'starting', marker: MARKER }));
  const gateway = s.gateway();
  gateway.start();
  await connected(gateway);
  assert.equal(s.ended.has(left), true);
  assert.equal(s.startsSeen(), 2);
});

test('failure to remove ownership is reported on stop and never escapes an event callback', options, async (t) => {
  const s = setup(t);
  const gateway = s.gateway();
  gateway.start();
  await connected(gateway);
  rmSync(s.pidFile);
  mkdirSync(s.pidFile);
  await gateway.stop();
  assert.equal(s.ended.has(s.starts()[0]!.pid), true);
  assert.equal(gateway.status().state, 'down');
  assert.match(gateway.status().error!, /记录|EISDIR|EPERM/);
  assert.equal(existsSync(s.pidFile), true);
});

test('ssh configuration cannot move the forward into a background process', options, async (t) => {
  const s = setup(t, ['fork']);
  const gateway = s.gateway();
  gateway.start();
  await connected(gateway);
  await sleep(300);
  assert.equal(isAlive(s.starts()[0]!.pid), true);
  assert.equal(s.childrenSeen(), 0);
  assert.equal(s.startsSeen(), 1);
});

test('stopping ssh ends its ProxyCommand child before removing ownership', options, async (t) => {
  const s = setup(t, ['proxy']);
  let childGone = false;
  const gateway = s.gateway({
    processes: {
      find: async () => s.starts().map(({ pid }) => pid).filter(s.alive),
      async kill(pid, marker) {
        // These are grandchildren: capture their identity while ssh is still alive.
        const kids = await Promise.all(s.children().map(async (pid) => {
          const start = await processStartLater(pid);
          assert.ok(start, `停止前应能读到 ProxyCommand ${pid} 的启动时刻`);
          return { pid, start };
        }));
        await hostProcesses.kill(pid, marker);
        await s.observed.get(pid)!.done;
        for (const kid of kids) {
          const deadline = Date.now() + 20_000;
          while (isAlive(kid.pid)) {
            const start = await processStartLater(kid.pid);
            if (start !== undefined && start !== kid.start) break;
            if (Date.now() > deadline) throw new Error(`ProxyCommand ${kid.pid} 尚未结束`);
            await sleep(10);
          }
        }
        childGone = kids.length > 0;
      },
    },
  });
  gateway.start();
  await connected(gateway);
  await until(() => s.children().length === 1, 'ProxyCommand 子进程');
  await gateway.stop();
  assert.equal(childGone, true, '不能只结束父进程');
  assert.equal(existsSync(s.pidFile), false);
});

test('an ssh that ignores the graceful stop is forcibly ended and verified', options, async (t) => {
  const s = setup(t, ['stubborn']);
  const gateway = s.gateway();
  gateway.start();
  await connected(gateway);
  await gateway.stop();
  assert.equal(s.ended.has(s.starts()[0]!.pid), true);
  assert.equal(existsSync(s.pidFile), false);
});

for (const mode of ['huge-line', 'huge-unfinished']) {
  test('stderr has a byte limit for ' + mode, options, async (t) => {
    const s = setup(t, [mode]);
    const waiting = Promise.withResolvers<void>();
    const gateway = s.gateway({ sleep: (_ms, signal) => { waiting.resolve(); return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); } });
    gateway.start();
    await waiting.promise;
    assert.equal(gateway.status().state, 'down');
    assert.ok(Buffer.byteLength(gateway.status().error!) <= 3 * 4096, '错误保留的字节数有上限');
    assert.match(gateway.status().error!, /^故障/);
  });
}

for (const failure of ['alive', 'record'] as const) {
  test('disabled gateway keeps cleanup failure visible: ' + failure, options, async (t) => {
    const s = setup(t);
    s.config.ssh = '';
    if (failure === 'record') mkdirSync(s.pidFile);
    else writeFileSync(s.pidFile, JSON.stringify({ state: 'starting', marker: MARKER }));
    const gateway = s.gateway({
      processes: { find: async () => failure === 'alive' ? [424242] : [], kill: async () => {} },
    });
    gateway.start();
    await until(() => gateway.status().state === 'down', '清理失败显示故障');
    assert.match(gateway.status().error!, failure === 'alive' ? /清不掉/ : /归属记录删不掉/);
    await gateway.stop();
    assert.equal(gateway.status().state, 'down', '不能用没有启用掩盖清理失败');
    assert.equal(existsSync(s.pidFile), true);
    assert.equal(s.startsSeen(), 0);
  });
}

test('cancelled reconfigurations cannot erase an earlier cleanup failure', options, async (t) => {
  const s = setup(t);
  s.config.ssh = '';
  mkdirSync(s.pidFile);
  const gateway = s.gateway();
  gateway.start();
  await until(() => gateway.status().state === 'down', '记录删除失败');
  const failure = gateway.status();
  s.config.ssh = 'deploy@door.example';
  gateway.reconfigure();
  gateway.reconfigure();
  await gateway.stop();
  assert.deepEqual(gateway.status(), failure, '已取消轮不能覆盖未知现场的原因');
  assert.equal(s.startsSeen(), 0);
});
