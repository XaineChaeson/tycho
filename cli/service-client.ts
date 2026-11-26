// What the CLI knows of a running service: the files it leaves in its data directory and
// the routes it keeps for this machine's own processes.
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { localUrl, lockFile, loginTokenFile, serviceFile } from '../service/config.ts';
import type { DoctorCheck } from '../service/doctor.ts';
import type { Holder } from '../service/lock.ts';
import { heldBy, holderAlive, isAlive, lockElsewhere, machineName, readHolder, processStart } from '../service/lock.ts';
import { SETTINGS } from '../service/settings.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';
import type { NodeFacts, NodeJoinAnswer } from '../shared/node-protocol.ts';
import type { Timing } from './system.ts';

const REQUEST_TIMEOUT_MS = 10_000;
// A service that is up says who it is at once.
const IDENTITY_TIMEOUT_MS = 3000;

// A service that answered, with the token in its service.json, who it is. A live pid and
// an open port are not that: after a crash either can belong to another program.
export interface Running {
  state: 'running';
  pid: number;
  port: number;
  token: string;
  version: string;
  // The directory holding service/ and cli/ that it runs from.
  programDir: string;
  // The data directory it was started on, as it answered.
  dataDir: string;
  startedAt: string;
}

export type ServiceState =
  | Running
  // A live process holds the data directory and no service answered for it: one that is
  // still starting, a restore, or a service that does not answer. `announcedPort` when
  // that process did write a service.json. `elsewhere` is that holder when it is another
  // machine's — this one can neither see it nor take the lock from it.
  | { state: 'held'; pid: number; announcedPort?: number; elsewhere?: Holder }
  // `unclean`: the last one left its files behind, which a clean stop removes.
  | { state: 'stopped'; unclean: boolean; lastPort?: number };

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : {};
  }
}

// Not fetch: its keep-alive would hold the command open for seconds after the answer.
function call(
  method: 'GET' | 'POST',
  port: number,
  path: string,
  token: string,
  options: { timeoutMs?: number; cookie?: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string> } = {},
): Promise<{ status: number; body: string; setCookie: string | null }> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const body = options.form === undefined
    ? (options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json)))
    : Buffer.from(new URLSearchParams(options.form).toString());
  return new Promise((resolve, reject) => {
    const req = request(
      localUrl(port, path),
      {
        method,
        agent: false,
        timeout: timeoutMs,
        headers: {
          ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...options.headers,
          ...(method === 'POST' ? { 'Content-Length': body?.length ?? 0 } : {}),
          ...(body === undefined ? {} : { 'Content-Type': options.form === undefined ? 'application/json' : 'application/x-www-form-urlencoded' }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const sent = response.headers['set-cookie'];
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            setCookie: Array.isArray(sent) ? (sent[0] ?? null) : (sent ?? null),
          });
        });
        response.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${timeoutMs / 1000} 秒没有应答`)));
    req.on('error', reject);
    req.end(body);
  });
}

// The cookie a browser would keep from a Set-Cookie: its name and value, not the
// attributes that tell a browser how to hold it.
const cookieOf = (setCookie: string | null): string | undefined => setCookie?.split(';')[0]?.trim() || undefined;


// What answers on this port, when it is a service that knows this token.
async function identify(port: number, token: string): Promise<Omit<Running, 'state' | 'token'> | null> {
  try {
    const response = await call('GET', port, '/api/instance', token, { timeoutMs: IDENTITY_TIMEOUT_MS });
    if (response.status !== 200) return null;
    const { pid, version, program_dir: programDir, data_dir: dataDir, started_at: startedAt } = JSON.parse(response.body) as Record<string, unknown>;
    if (!Number.isInteger(pid) || typeof version !== 'string' || typeof programDir !== 'string' || typeof dataDir !== 'string' || typeof startedAt !== 'string') return null;
    return { pid: pid as number, port, version, programDir, dataDir, startedAt };
  } catch {
    return null;
  }
}

// Who is on this port now, as it answers a request carrying its own token. Null when
// nothing answers there, or what does does not know the token.
export async function instanceAt(port: number, token: string): Promise<Running | null> {
  const found = await identify(port, token);
  return found === null ? null : { state: 'running', token, ...found };
}

// Read-only: the lock itself stays the judge of who may start.
export async function serviceState(dataDir: string): Promise<ServiceState> {
  const service = readJson(serviceFile(dataDir));
  const port = service && Number.isInteger(service.port) ? (service.port as number) : undefined;
  if (port !== undefined && typeof service!.token === 'string') {
    const instance = await identify(port, service!.token);
    // The one that wrote this file, not a later service that happens to share the port.
    if (instance && instance.pid === service!.pid) return { state: 'running', token: service!.token, ...instance };
  }
  const lock = lockFile(dataDir);
  const holder = readHolder(lock);
  if (holder && holderAlive(holder)) {
    return {
      state: 'held',
      pid: holder.pid,
      ...(lockElsewhere(holder) === undefined ? {} : { elsewhere: holder }),
      ...(port !== undefined && service!.pid === holder.pid ? { announcedPort: port } : {}),
    };
  }
  return { state: 'stopped', unclean: service !== undefined || existsSync(lock), ...(port === undefined ? {} : { lastPort: port }) };
}

export const consoleUrl = (port: number): string => localUrl(port, '');

// The host on this data directory letting this machine in without anyone's approval
// (docs/design/nodes.md §1.1 step 2). Its token goes only where `tycho stop` sends it: the
// port in service.json, on the literal loopback address, by node:http with no agent of its
// own (so no proxy) and no redirect followed — never to the address `--to` names, which
// a resolver, a proxy or another listener on [::1] could put somewhere else. Only when the
// process holding the data directory's lock is shown to be the one that wrote service.json
// (service/lock.ts heldBy); nothing is sent to find out. `asked` is what `--to` said: a loopback name and the port in
// service.json, or this is not the way. Null whenever it is not: the caller asks the
// ordinary way, with no token.
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
export async function joinLocally(dataDir: string, asked: string, facts: NodeFacts, startOf: (pid: number) => string | undefined = processStart): Promise<{ answer: Extract<NodeJoinAnswer, { state: 'approved' }>; origin: string } | null> {
  const url = new URL(asked);
  if (url.protocol !== 'http:' || !LOOPBACK_NAMES.has(url.hostname)) return null;
  const service = readJson(serviceFile(dataDir));
  if (!service || !Number.isInteger(service.port) || typeof service.token !== 'string' || service.token === '') return null;
  if ((url.port || '80') !== String(service.port)) return null;
  // Shown to be the process that wrote service.json, not merely not ruled out.
  const holder = readHolder(lockFile(dataDir));
  if (!holder || !Number.isInteger(service.pid) || !heldBy(holder, service.pid as number, startOf)) return null;
  const port = service.port as number;
  let response: Awaited<ReturnType<typeof call>>;
  try {
    response = await call('POST', port, '/api/node/join', '', { json: { protocol: NODE_PROTOCOL, facts, local_token: service.token } });
  } catch {
    return null;
  }
  if (response.status !== 200) return null;
  try {
    const answer = JSON.parse(response.body) as NodeJoinAnswer;
    return answer.state === 'approved' ? { answer, origin: localUrl(port, '') } : null;
  } catch {
    return null;
  }
}

async function ask(method: 'GET' | 'POST', running: Running, path: string, token: string, what: string): Promise<string> {
  const response = await call(method, running.port, path, token).catch((err: Error) => {
    throw new Error(`连不上端口 ${running.port} 上的服务（进程 ${running.pid}）：${err.message}`);
  });
  // 201 for a link, 202 for a stop that has begun.
  if (response.status < 200 || response.status >= 300) throw new Error(`${what}失败（${response.status}）：${response.body}`);
  return response.body;
}

// A one-time login link: `local` to be opened on this machine, `url` as the service
// tells others to reach it.
export async function loginLink(dataDir: string, running: Running): Promise<{ path: string; local: string; url: string; external: boolean }> {
  let token: string;
  try {
    token = readFileSync(loginTokenFile(dataDir), 'utf8');
  } catch (err) {
    throw new Error(`读不到 ${loginTokenFile(dataDir)}：${(err as Error).message}`);
  }
  const { path, url, external } = JSON.parse(await ask('POST', running, '/api/login-links', token, '生成登录链接')) as { path: string; url?: string; external: boolean };
  const local = localUrl(running.port, path);
  return { path, local, url: url ?? local, external };
}

// The service's own self-check, answered by the service.
export async function serviceDoctor(running: Running): Promise<DoctorCheck[]> {
  const { checks } = JSON.parse(await ask('GET', running, '/api/doctor', running.token, '读取服务的自检')) as { checks: DoctorCheck[] };
  return checks;
}

// Windows has no signal another process can send for a clean stop, so every system asks
// over HTTP.
export async function requestStop(running: Running): Promise<void> {
  await ask('POST', running, '/api/shutdown', running.token, '停止服务');
}

// True once the process is gone; false when it outlived the wait.
export async function stopService(running: Running, timing: Timing): Promise<boolean> {
  await requestStop(running);
  const deadline = Date.now() + timing.stopWaitMs;
  while (isAlive(running.pid)) {
    if (Date.now() > deadline) return false;
    await sleep(timing.pollMs);
  }
  return true;
}

export type StartFailure =
  // Nothing of it was seen in the time allowed.
  | { state: 'absent' }
  // A process took the data directory's lock and is gone without having announced itself:
  // the program started and died on its way up.
  | { state: 'died'; pid: number }
  // A live process holds the data directory's lock and has not answered: the program is on
  // its way up. A slow start is not a failed one, and nothing may be taken back on it.
  | { state: 'starting'; pid: number }
  // Whether the lock's holder is alive cannot be established here, or the state could not be
  // read at all: neither health nor failure, and nothing may be decided on it.
  | { state: 'unknown'; why: string };

// For a start made through a service manager, which returns before the service is up. The
// answer comes as soon as there is one: a program that crashes on its way up leaves its lock
// behind with a pid that is no longer running, and is not waited for to the limit. A lock
// that was there before the start was asked for is not that program's.
//
// The limit is the CLI's own patience, not a verdict on the program: one that holds the lock
// and is alive at the limit is still starting, and one whose holder this machine cannot judge
// — another machine's lock, or a state that could not be read — is unknown. Neither is a
// program that did not come up, and neither may be taken back on that reading (2026-11-12:
// a candidate that needed longer than the wait was counted as never having started).
export async function waitRunning(dataDir: string, timing: Timing): Promise<Running | StartFailure> {
  const lock = lockFile(dataDir);
  const before = readHolder(lock)?.pid;
  const deadline = Date.now() + timing.startWaitMs;
  for (;;) {
    let state: ServiceState;
    try {
      state = await serviceState(dataDir);
    } catch (err) {
      return { state: 'unknown', why: (err as Error).message };
    }
    if (state.state === 'running') return state;
    if (state.state === 'stopped') {
      const holder = readHolder(lock);
      if (holder !== undefined && holder.pid !== before && !holderAlive(holder)) return { state: 'died', pid: holder.pid };
    }
    if (Date.now() > deadline) {
      if (state.state !== 'held') return { state: 'absent' };
      // A lock another machine holds is not this one's to judge: it can neither see that
      // process nor wait it out.
      return state.elsewhere === undefined
        ? { state: 'starting', pid: state.pid }
        : { state: 'unknown', why: `数据目录的锁在另一台机器上（${machineName(state.elsewhere)}）` };
    }
    await sleep(timing.pollMs);
  }
}

export function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 2000 });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

// ---- What a release asks of a running service ----

// The parts of a health check only the service can answer: whether its ledger can be
// read at all, whether it is in the degraded mode a failed write leaves it in, and
// whether the inventory that follows a start has finished. The duration is the owner's
// setting, as the service has it.
export interface ReleaseFacts {
  // 'ok' when a read of the ledger answered; otherwise why it did not.
  ledger: string;
  // True when a write failed and the service has stopped taking work in.
  degraded: boolean;
  recovering: boolean;
  healthWindowMs: number;
  // How long a release waits for the inventory: it asks machines, which may be slow.
  recoveryWaitMs: number;
}

export async function releaseFacts(running: Running): Promise<ReleaseFacts> {
  const response = await call('GET', running.port, '/api/release-check', running.token);
  if (response.status !== 200) throw new Error(`服务没有回答它自己的状态（${response.status}）：${response.body}`);
  const { ledger, degraded, recovering, health_window_ms: window, recovery_wait_ms: recoveryWait } = JSON.parse(response.body) as Record<string, unknown>;
  if (typeof ledger !== 'string' || typeof degraded !== 'boolean' || typeof recovering !== 'boolean' || !Number.isInteger(window)) {
    throw new Error(`服务对自己状态的回答看不懂：${response.body}`);
  }
  return { ledger, degraded, recovering, healthWindowMs: window as number, recoveryWaitMs: Number.isInteger(recoveryWait) ? (recoveryWait as number) : 0 };
}

// ---- The console, as a browser reaches it ----

// The session a browser would hold after opening a login link: made with the login token
// the service keeps in its data directory, exchanged for a cookie exactly as the page
// does. Nothing here reaches past the authentication the pages themselves go through:
// a check that read the page without it would pass on a service whose login is broken.
export async function consoleSession(dataDir: string, running: Running): Promise<{ cookie: string } | { problem: string }> {
  let path: string;
  try {
    ({ path } = await loginLink(dataDir, running));
  } catch (err) {
    return { problem: `要不到登录链接：${(err as Error).message}` };
  }
  // The link is shown once before it is spent, as a browser does; then the POST that
  // trades it for the cookie. The origin is the one the request is made to, which is how
  // a same-site page proves where a write came from.
  try {
    // Current hosts carry the bearer in a fragment; older installed hosts still use a path.
    // Keep that compatibility here, where the response enters the CLI's health check.
    const credential = /^\/login#([0-9a-f]{64})$/.exec(path)?.[1];
    const endpoint = credential === undefined ? path : '/login';
    const shown = await call('GET', running.port, endpoint, '');
    if (shown.status !== 200) return { problem: `登录链接打不开（${shown.status}）` };
    const entered = await call('POST', running.port, endpoint, '', {
      headers: { Origin: `http://127.0.0.1:${running.port}` },
      ...(credential === undefined ? {} : { form: { credential } }),
    });
    const cookie = cookieOf(entered.setCookie);
    if (entered.status !== 303 || cookie === undefined) return { problem: `登录没有换成会话（${entered.status}）` };
    return { cookie };
  } catch (err) {
    return { problem: `登录请求失败：${(err as Error).message}` };
  }
}

// The console page as a browser gets it, with the session it holds.
export async function consolePage(port: number, cookie: string): Promise<{ status: number; body: string }> {
  return call('GET', port, '/', '', { cookie });
}

// Whether a local file the page names is really served. The bytes are thrown away: what
// is asked is whether they are there.
export async function consoleAsset(port: number, path: string, cookie: string): Promise<{ status: number; bytes: number }> {
  const response = await call('GET', port, path, '', { cookie });
  return { status: response.status, bytes: Buffer.byteLength(response.body) };
}

// The interfaces a working console reads on every page: the messages, the tasks and the
// overview. A candidate that answers its identity but throws on these is not one to keep.
const CORE_READS = ['/api/messages?limit=1', '/api/tasks', '/api/overview'] as const;

export async function coreReads(port: number, cookie: string): Promise<string[]> {
  const failed: string[] = [];
  for (const path of CORE_READS) {
    try {
      const response = await call('GET', port, path, '', { cookie });
      if (response.status !== 200) {
        failed.push(`${path} 答 ${response.status}`);
        continue;
      }
      JSON.parse(response.body);
    } catch (err) {
      failed.push(`${path} ${(err as Error).message}`);
    }
  }
  return failed;
}

// Asks the service to let the turn it is handling finish before it is stopped. The
// service stops waiting at its own limit, which is a setting; this waits for the most that
// setting may be, plus a minute for the answer itself, so an answer always comes back.
const DRAIN_TIMEOUT_MS = SETTINGS['release.drainTimeoutMs'].max + 60_000;

export async function drain(running: Running, timeoutMs = DRAIN_TIMEOUT_MS): Promise<{ drained: boolean; waitedMs: number }> {
  const response = await call('POST', running.port, '/api/drain', running.token, { timeoutMs });
  if (response.status !== 200) throw new Error(`服务没有回答能不能等（${response.status}）：${response.body}`);
  const { drained, waited_ms: waited } = JSON.parse(response.body) as Record<string, unknown>;
  if (typeof drained !== 'boolean' || !Number.isInteger(waited)) throw new Error(`服务对等待的回答看不懂：${response.body}`);
  return { drained, waitedMs: waited as number };
}
