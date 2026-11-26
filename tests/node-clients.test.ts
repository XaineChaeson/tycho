// Guards docs/design/nodes.md §7 on real processes: one machine, one node identity, one
// client. Two clients on one identity would take the same commands out of the same queue —
// one machine would run a round twice — and a client killed outright must not keep the next
// one out.
//
// What this file is here to catch:
//   - a second client that quietly starts beside the first one (both polling, both taking
//     commands): it must say who is there and leave;
//   - a lock whose holder is gone read as "still held" (a crash or an upgrade would need the
//     owner to delete a file by hand before the machine could work again);
//   - `tycho node status` taking the lock away from the client that is running: a question
//     is not an act.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { CLIENT_LOCK, readClientHolder, writeOrigin } from '../node/cli.ts';
import { identityOf, writeToken } from '../node/client.ts';
import { isAlive } from '../service/lock.ts';
import { NODE_HOLD_HEADER, NODE_PROTOCOL } from '../shared/node-protocol.ts';

const CLI = join(import.meta.dirname, '..', 'cli', 'main.ts');
const REPO = join(import.meta.dirname, '..');
const options = { timeout: 120_000 };
// Long enough that a second client's arrival and exit happen while the first one is in a
// poll, short enough to keep the file quick.
const HOLD_MS = 300;

async function until<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`等不到：${what}`);
    const value = read();
    if (value) return value;
    await sleep(20);
  }
}

// What a machine's client is told about the host here: a proxy in the environment would make
// it re-execute itself (cli/main.ts), putting a second process in front of the one a test
// kills, and nothing here reaches outside 127.0.0.1.
const clientEnv = (dataDir: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, TYCHO_DATA: dataDir };
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) env[name] = '';
  return env;
};

interface Bench {
  dataDir: string;
  // Starts one more client on the same identity: the log it writes is `log(at)`.
  start(): ChildProcess;
  log(at: number): string;
  lock(): { pid?: number } | undefined;
  // How many polls have arrived, and the most that were ever in flight at once.
  polls(): number;
  most(): number;
  // With `holdForever`: settles once a held poll's connection is closed, which only the
  // client does (the host never answers it).
  pollCut: Promise<void>;
}

// A host as far as the client can tell: every poll is held open for a moment and answered
// with nothing. It counts what is in flight, so two clients taking commands at once is
// something this test can see. With `holdForever` a poll is held the way the real host
// holds one (it says how long, here far longer than any test) and never answered: a client
// that leaves while one is open has cut it short itself.
async function bench(t: TestContext, { holdForever = false } = {}): Promise<Bench> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-one-client-'));
  let polls = 0;
  let inFlight = 0;
  let most = 0;
  const cut = Promise.withResolvers<void>();
  const server: Server = createServer((request, response) => {
    const answer = (body: unknown): void => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/api/node/poll') {
      polls += 1;
      inFlight += 1;
      most = Math.max(most, inFlight);
      if (holdForever) {
        response.writeHead(200, { 'Content-Type': 'application/json', [NODE_HOLD_HEADER]: String(600_000) });
        response.flushHeaders();
        response.once('close', () => {
          inFlight -= 1;
          cut.resolve();
        });
        return;
      }
      const timer = setTimeout(() => {
        inFlight -= 1;
        answer({ protocol: NODE_PROTOCOL, command: null });
      }, HOLD_MS);
      // A connection that goes away is the machine going away; the count follows it.
      response.once('close', () => {
        clearTimeout(timer);
        if (!response.writableFinished) inFlight -= 1;
      });
      return;
    }
    if (request.url === '/api/node/status') return answer({ protocol: NODE_PROTOCOL, machine_id: 'm1', connected: true });
    answer({ protocol: NODE_PROTOCOL, command: null });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const identity = identityOf(dataDir);
  writeToken(identity, 'f'.repeat(64));
  writeOrigin(identity, `http://127.0.0.1:${port}`);

  const children: ChildProcess[] = [];
  t.after(() => {
    for (const child of children) if (child.pid !== undefined && isAlive(child.pid)) child.kill();
    void new Promise<void>((resolve) => server.close(() => resolve()));
  });
  t.after(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  let started = 0;
  return {
    dataDir,
    start() {
      started += 1;
      const child = spawn(process.execPath, [CLI, 'node', 'run', '--log', join(dataDir, `client-${started}.log`)], {
        cwd: REPO,
        // This test means the client itself (the process that takes the lock): a supervisor
        // would take the kill instead of it (docs/design/nodes.md §1.4).
        env: { ...clientEnv(dataDir), TYCHO_NODE_SUPERVISED: '1' },
        // Nothing is read from this process's pipes: this machine refuses them, and what a
        // client says goes to the log file it was told to write.
        stdio: 'ignore',
        windowsHide: true,
      });
      children.push(child);
      return child;
    },
    log(at) {
      try {
        return readFileSync(join(dataDir, `client-${at}.log`), 'utf8');
      } catch {
        return '';
      }
    },
    lock: () => readClientHolder(identity),
    polls: () => polls,
    most: () => most,
    pollCut: cut.promise,
  };
}

const exited = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => child.once('exit', (code) => resolve(code)));

test('同一台机器、同一个身份只能有一个客户端在跑：第二个说清是谁在跑，然后退出', options, async (t) => {
  const b = await bench(t);
  const first = b.start();
  await until(() => b.polls() > 0, '第一个客户端开始取命令');

  const second = b.start();
  assert.equal(await exited(second), 1, '第二个客户端不该装作没事');
  assert.match(b.log(2), new RegExp(`已经有一个客户端在跑.*进程 ${first.pid}`));
  assert.match(b.log(2), /tycho node service stop/, '要说清楚怎么把那个停掉');
  assert.equal(b.lock()?.pid, first.pid, '锁还是第一个客户端的');

  // One client polling: the second one never took a command.
  await sleep(HOLD_MS * 3);
  assert.equal(b.most(), 1, '同时只有一个客户端在取命令');
  assert.equal(isAlive(first.pid!), true);
});

test('客户端被杀之后：下一个接管它留下的锁，不用手工删文件', options, async (t) => {
  const b = await bench(t);
  const first = b.start();
  await until(() => b.polls() > 0, '第一个客户端开始取命令');
  assert.match(readFileSync(join(identityOf(b.dataDir).dir, CLIENT_LOCK), 'utf8'), new RegExp(`"pid":${first.pid}`));

  // SIGKILL, not the default SIGTERM: on Linux the client takes SIGTERM as an ordinary stop
  // and removes its own lock on the way out, which would leave nothing here to take over.
  first.kill('SIGKILL');
  await until(() => !isAlive(first.pid!), '被杀的客户端真的不在了');
  const before = b.polls();
  const again = b.start();
  await until(() => b.polls() > before, '下一个客户端接上来了');
  assert.equal(b.lock()?.pid, again.pid, '锁归新的客户端');
  assert.match(b.log(2), /锁文件的进程 \d+ 已不在，覆盖/, '它说明拿的是谁留下的锁');
});

test('tycho node status：只回答，不把正在跑的客户端的锁拿走', options, async (t) => {
  const b = await bench(t);
  const client = b.start();
  await until(() => b.polls() > 0, '客户端开始取命令');
  const before = b.polls();

  const said = join(b.dataDir, 'status.log');
  const asked = spawn(process.execPath, [CLI, 'node', 'status', '--log', said], {
    cwd: REPO,
    env: clientEnv(b.dataDir),
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(await exited(asked), 0);
  assert.match(readFileSync(said, 'utf8'), new RegExp(`客户端：在跑（进程 ${client.pid}）`));
  assert.equal(isAlive(client.pid!), true, 'status 没有停掉它');
  assert.equal(b.lock()?.pid, client.pid, 'status 没有把锁拿走');
  await until(() => b.polls() > before, '客户端还在取命令');
  assert.match(b.log(1), /已连上/, '它一直在跑');
});

// `tycho node service stop` asks the client itself to leave (node/client.ts): a service
// manager's stop would end everything the client started, and the rounds running under
// their own watch processes are exactly what must go on (nodes.md §4.2). What this catches:
// a stop that goes through the manager, a client that only notices between polls (a stop
// that waits out a 25-second hold), a stop mark left behind by a dead client keeping the
// next one from starting, and a stopped client leaving its lock behind.
test('tycho node service stop：请客户端自己退出，当场退出 0；留下的旧标记拦不住下一个客户端', options, async (t) => {
  // The poll the client sits in is held for ten minutes: only a client that cuts it short
  // itself leaves within this test's time. No clock is read: how long the stop command and
  // the client take to start and end depends on the machine's load, not on the hold.
  const b = await bench(t, { holdForever: true });
  const identity = identityOf(b.dataDir);
  // A mark a dead client never read: it names a pid that is nobody's now.
  writeFileSync(join(identity.dir, 'stop'), '999999\n');
  const client = b.start();
  // Listened for from the start: the client is gone by the time the stop command answers.
  const clientExit = exited(client);
  await until(() => b.polls() > 0, '客户端不理会别人的停止标记，照常取命令');
  assert.equal(existsSync(join(identity.dir, 'stop')), false, '旧标记被它清掉了');

  const asked = spawn(process.execPath, [CLI, 'node', 'service', 'stop'], {
    cwd: REPO,
    env: clientEnv(b.dataDir),
    stdio: 'ignore',
    windowsHide: true,
  });
  const stopped = exited(asked);
  // Whichever comes first: the client cutting its held poll short, or the stop command
  // answering. An answer before any cut is a client that sat in its poll, said as such.
  const first = await Promise.race([b.pollCut.then(() => 'cut' as const), stopped.then((code) => ({ code }))]);
  assert.equal(first, 'cut', `stop 命令已经回答（${JSON.stringify(first)}），挂着的 poll 却没被客户端掐断：客户端只在两次 poll 之间看停止标记`);
  assert.equal(await stopped, 0, 'stop 命令要等到客户端退出再回答');
  assert.equal(await clientExit, 0, '客户端是自己退出的，退出码 0：服务管理器不会把它当失败重新拉起');
  assert.match(b.log(1), /已按要求停下/);
  assert.equal(b.lock(), undefined, '锁随它一起走了');
  assert.equal(existsSync(join(identity.dir, 'stop')), false, '它的停止标记也清掉了');
  assert.equal(existsSync(join(identity.dir, 'token')), true, '只是停下，没有注销');
});
