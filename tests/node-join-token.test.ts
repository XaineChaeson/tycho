// Guards where `tycho node join` may send this host's own token (docs/design/nodes.md §1.1
// step 2): only to the port in this data directory's service.json, on the literal loopback
// address, the way `tycho stop` reaches the service — never to whatever `--to` turns into.
//
// What this file is here to catch, with a synthetic token and listeners of its own:
//   - `localhost` resolving somewhere else, and the token going there,
//   - a proxy from the environment (the CLI runs with --use-env-proxy) receiving the token,
//   - a 307 from the listener carrying the token on to another one,
//   - another service on the same port of [::1] receiving the token meant for the host,
//   - a service.json whose writer is not shown to hold the data directory's lock still being
//     trusted — another pid, a lock that recorded no start, a start the system will not tell
//     (failed, or no permission), a pid another process has taken since: then nothing is
//     sent with the token at all, and the join asks the ordinary way.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { serviceFile } from '../service/config.ts';
import { processStart } from '../service/lock.ts';
import { joinLocally } from '../cli/service-client.ts';
import { nodeCommand } from '../node/cli.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';

const TOKEN = `synthetic-local-token-${randomBytes(8).toString('hex')}`;
const options = { timeout: 60_000 };

interface Seen { url: string; headers: string; body: string }
const carries = (seen: Seen[]): Seen[] => seen.filter((each) => `${each.url}${each.headers}${each.body}`.includes(TOKEN));

type Handle = (asked: Seen, response: ServerResponse) => void;

// A join the ordinary way gets six digits; the host's own token gets a machine; anything
// else a machine's client asks for is a token the host does not know.
const host: Handle = (asked, response) => {
  if (!asked.url.endsWith('/api/node/join')) {
    response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '机器令牌无效' }));
    return;
  }
  if (asked.body.includes(TOKEN)) {
    response.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ protocol: NODE_PROTOCOL, state: 'approved', token: 'a'.repeat(64), machine_id: 'this-pc' }));
    return;
  }
  response.writeHead(201, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ protocol: NODE_PROTOCOL, state: 'pending', code: '123456', secret: 'b'.repeat(64), expires_at: new Date(Date.now() + 600_000).toISOString() }));
};

async function listen(t: TestContext, address: string, handle: Handle, port = 0): Promise<{ port: number; seen: Seen[] } | undefined> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const asked = { url: request.url ?? '', headers: JSON.stringify(request.headers), body: Buffer.concat(chunks).toString('utf8') };
      seen.push(asked);
      handle(asked, response);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, () => resolve());
    });
  } catch {
    return undefined;
  }
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { port: (server.address() as AddressInfo).port, seen };
}

// A machine's data directory with a host running on it: service.json written by the process
// that holds the lock (this test's own, which is alive).
function dataDir(t: TestContext, port: number, writer = process.pid, lock: Record<string, unknown> = { pid: process.pid, process_start: processStart(process.pid) }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-join-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(serviceFile(dir), JSON.stringify({ pid: writer, port, token: TOKEN }));
  writeFileSync(join(dir, 'lock'), JSON.stringify(lock));
  return dir;
}

// The join command until it is joined, or until it prints the six digits.
async function joinTo(dir: string, to: string): Promise<string[]> {
  const said: string[] = [];
  const stop = new AbortController();
  const note = (line: string) => {
    said.push(line);
    if (line.startsWith('已加入') || line.includes('输入 ')) stop.abort();
  };
  await nodeCommand({ out: note, err: note, dataDir: dir, signal: stop.signal }, ['join', '--to', to, '--name', 'this-pc']).catch((error: Error) => said.push(error.message));
  return said;
}

test('localhost 解析到别处：令牌只走 service.json 的端口、字面的 127.0.0.1', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const elsewhere = await listen(t, '127.0.0.2', host, real!.port);
  if (!elsewhere) return t.skip('这台机器上 127.0.0.2 起不了监听');
  const lookup = dns.lookup;
  // What a resolver that sends localhost elsewhere does: fetch asks it, the local channel does not.
  dns.lookup = ((name: string, opts: unknown, done?: unknown) => {
    const callback = (typeof opts === 'function' ? opts : done) as (...args: unknown[]) => void;
    const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
    if (name === 'localhost') return all ? callback(null, [{ address: '127.0.0.2', family: 4 }]) : callback(null, '127.0.0.2', 4);
    return (lookup as (...args: unknown[]) => void)(name, opts, done);
  }) as typeof dns.lookup;
  t.after(() => { dns.lookup = lookup; });
  const said = await joinTo(dataDir(t, real!.port), `http://localhost:${real!.port}`);
  assert.deepEqual(carries(elsewhere.seen), [], '令牌到了 localhost 解析出来的地方');
  assert.equal(carries(real!.seen).length, 1, said.join('\n'));
  assert.ok(said.includes('本机接入，免放行。'), said.join('\n'));
});

test('开了环境代理：令牌不经过代理', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const proxy = await listen(t, '127.0.0.1', (_asked, response) => response.writeHead(502).end());
  const dir = dataDir(t, real!.port);
  // The CLI's own way of running: --use-env-proxy, with a proxy in the environment that
  // names no exception for loopback. A child, because the switch is read at start.
  const cli = pathToFileURL(join(import.meta.dirname, '..', 'node', 'cli.ts')).href;
  const script = `
    const { nodeCommand } = await import(${JSON.stringify(cli)});
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 15000).unref();
    const note = (line) => { console.log(line); if (line.startsWith('已加入') || line.includes('输入 ')) stop.abort(); };
    await nodeCommand({ out: note, err: note, dataDir: ${JSON.stringify(dir)}, signal: stop.signal }, ['join', '--to', 'http://localhost:${real!.port}', '--name', 'this-pc']).catch((e) => console.log(e.message));
    process.exit(0);`;
  const child = spawn(process.execPath, ['--use-env-proxy', '--input-type=module', '-e', script], {
    env: { ...process.env, HTTP_PROXY: `http://127.0.0.1:${proxy!.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy!.port}`, NO_PROXY: '', no_proxy: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.deepEqual(carries(proxy!.seen), [], '代理收到了令牌');
  assert.equal(carries(real!.seen).length, 1, output);
});

test('对方回 307：令牌不跟着重定向走，加入退回六位数', options, async (t) => {
  const other = await listen(t, '127.0.0.1', host);
  const redirecting = await listen(t, '127.0.0.1', (_asked, response) => {
    response.writeHead(307, { Location: `http://127.0.0.1:${other!.port}/api/node/join` }).end();
  });
  const said = await joinTo(dataDir(t, redirecting!.port), `http://127.0.0.1:${redirecting!.port}`);
  assert.deepEqual(carries(other!.seen), [], '令牌跟着 307 到了另一个监听');
  assert.equal(carries(redirecting!.seen).length, 1, '令牌只到了 service.json 的端口');
  assert.ok(said.some((line) => line.includes('输入 123456')), said.join('\n'));
});

test('同端口的 [::1] 上另有服务：令牌只给 127.0.0.1 上的主机', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const other = await listen(t, '::1', host, real!.port);
  if (!other) return t.skip('这台机器上 [::1] 起不了监听');
  const said = await joinTo(dataDir(t, real!.port), `http://[::1]:${real!.port}`);
  assert.deepEqual(carries(other.seen), [], '令牌给了 [::1] 上的另一个服务');
  assert.equal(carries(real!.seen).length, 1, said.join('\n'));
});

test('service.json 不是持锁的那个进程写的：一个带令牌的请求都不发，照常要六位数', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const said = await joinTo(dataDir(t, real!.port, process.pid + 1_000_000), `http://127.0.0.1:${real!.port}`);
  assert.deepEqual(carries(real!.seen), []);
  assert.ok(said.some((line) => line.includes('输入 123456')), said.join('\n'));
});

test('--to 的端口和 service.json 对不上：不发令牌', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const asked = await listen(t, '127.0.0.1', host);
  const said = await joinTo(dataDir(t, real!.port), `http://127.0.0.1:${asked!.port}`);
  assert.deepEqual([...carries(real!.seen), ...carries(asked!.seen)], []);
  assert.ok(said.some((line) => line.includes('输入 123456')), said.join('\n'));
});

test('旧锁没有记启动时刻：不发令牌，照常要六位数', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const said = await joinTo(dataDir(t, real!.port, process.pid, { pid: process.pid }), `http://127.0.0.1:${real!.port}`);
  assert.deepEqual(carries(real!.seen), []);
  assert.ok(said.some((line) => line.includes('输入 123456')), said.join('\n'));
});

test('锁里的 PID 已被别的进程占着（启动时刻对不上）：不发令牌', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const said = await joinTo(dataDir(t, real!.port, process.pid, { pid: process.pid, process_start: 'a-process-that-began-some-other-time' }), `http://127.0.0.1:${real!.port}`);
  assert.deepEqual(carries(real!.seen), []);
  assert.ok(said.some((line) => line.includes('输入 123456')), said.join('\n'));
});

const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'this-pc', platform: 'test', hostname: 'this-pc' };

test('系统答不出那个 PID 的启动时刻：不发令牌', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const dir = dataDir(t, real!.port);
  assert.equal(await joinLocally(dir, `http://127.0.0.1:${real!.port}`, FACTS, () => undefined), null);
  assert.deepEqual(real!.seen, [], '一个请求都不该发');
});

test('查启动时刻没有权限（EPERM）：不发令牌', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const dir = dataDir(t, real!.port);
  const denied = (): never => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  assert.equal(await joinLocally(dir, `http://127.0.0.1:${real!.port}`, FACTS, denied), null);
  assert.deepEqual(real!.seen, [], '一个请求都不该发');
});

test('核实得到：同一个 PID、启动时刻记了并且对得上，才经本机通道发令牌', options, async (t) => {
  const real = await listen(t, '127.0.0.1', host);
  const dir = dataDir(t, real!.port);
  const joined = await joinLocally(dir, `http://localhost:${real!.port}`, FACTS);
  assert.equal(joined?.answer.state, 'approved');
  assert.equal(joined?.origin, `http://127.0.0.1:${real!.port}`);
  assert.equal(carries(real!.seen).length, 1);
});
