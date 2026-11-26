// Stands in for service/main.ts in the CLI tests: the files a running service leaves in
// its data directory and the local routes the CLI calls, answering with the status codes
// the real ones use, and nothing else of the service. It imports nothing of the
// repository: a copy of it is the service entry of the releases the tests make up.
import { appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.TYCHO_DATA;
// Never the current directory: a caller that forgot to say where must fail, not litter.
if (!dataDir) {
  console.error('stub service: TYCHO_DATA is not set');
  process.exit(2);
}
const LOGIN_TOKEN = 'stub-login-token';
const SHUTDOWN_TOKEN = 'stub-shutdown-token';
const COOKIE = 'tycho';
const lockFile = join(dataDir, 'lock');
const serviceFile = join(dataDir, 'service.json');
const programDir = realpathSync.native(join(import.meta.dirname, '..'));

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(programDir, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'stub';
  }
}

console.error('stub service starting');
if (process.env.STUB_EXIT) {
  console.error('另一份服务（1）正在运行');
  process.exit(Number(process.env.STUB_EXIT));
}

// What a second instance meets, as the real lock does. A test that replaces one stand-in
// with another on the same data directory takes the lock over.
try {
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
} catch (err) {
  if (process.env.STUB_TAKE_OVER !== '1') throw err;
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
}
// A program that crashes on its way up: the lock taken, then gone without a word and
// without tidying — what a bug in a start, or a kill, leaves behind.
if (process.env.STUB_DIE_AFTER_LOCK) process.exit(1);
// A release that brings the ledger to a newer schema version when it opens it: what the
// host cannot go back over.
if (process.env.STUB_BUMP_SCHEMA) {
  const bump = new DatabaseSync(join(dataDir, 'ledger.db'));
  try {
    bump.prepare(`UPDATE setting SET value_json = ? WHERE key = 'schema_version'`).run(JSON.stringify(Number(process.env.STUB_BUMP_SCHEMA)));
  } finally {
    bump.close();
  }
}
writeFileSync(join(dataDir, 'login-token'), LOGIN_TOKEN);
// What this run was started with, for a test to read back.
writeFileSync(join(dataDir, 'stub-env.json'), JSON.stringify({ port: process.env.TYCHO_PORT ?? null, startedBy: process.env.TYCHO_STARTED_BY ?? null }));

let stopping = false;
function stop(why: string): void {
  if (stopping) return;
  stopping = true;
  if (process.env.STUB_TRACE) appendFileSync(process.env.STUB_TRACE, `${why}\n`);
  setTimeout(() => {
    rmSync(serviceFile, { force: true });
    rmSync(lockFile, { force: true });
    process.exit(0);
  }, Number(process.env.STUB_STOP_DELAY_MS ?? 0));
}

const identity = { pid: process.pid, version: version(), program_dir: programDir, started_at: new Date().toISOString() };
// What the service's self-check would answer; a test sets its own.
const doctor = process.env.STUB_DOCTOR ?? JSON.stringify([{ id: 'router', level: 'ok', title: '负责人进程', text: '在运行', fix: null }]);

const factSequence = JSON.parse(process.env.STUB_FACTS_SEQUENCE ?? '[]') as Record<string, unknown>[];
let releaseChecks = 0;

const server = createServer((request, response) => {
  const route = `${request.method} ${request.url}`;
  const bearer = request.headers.authorization;
  if (route === 'POST /api/login-links') {
    // Asked before it is answered: a test that must see "no link was made" reads this.
    if (process.env.STUB_TRACE) appendFileSync(process.env.STUB_TRACE, 'login-link\n');
    if (process.env.STUB_NO_LINKS) {
      response.writeHead(500).end('账本不可用');
      return;
    }
    if (bearer !== `Bearer ${LOGIN_TOKEN}`) {
      response.writeHead(401).end('token 无效');
      return;
    }
    response.writeHead(201, { 'content-type': 'application/json' });
    const { port } = server.address() as { port: number };
    const publicUrl = process.env.STUB_PUBLIC_LOCAL_LINK ? `http://127.0.0.1:${port}` : 'http://public.example';
    response.end(JSON.stringify({ path: '/login/stub-link', external: !process.env.STUB_LOCAL_LINK, ...(process.env.STUB_LOCAL_LINK ? {} : { url: `${publicUrl}/login/stub-link` }), expires_at: new Date(Date.now() + 600_000).toISOString() }));
    return;
  }
  // The sign-in the real service puts in front of the page, as the CLI's health check
  // walks it: the link shown, then traded for a cookie, and the page behind that cookie.
  // What the check is asked to see has to be the real rule (B1); `STUB_NO_LOGIN` is the
  // service nobody can sign in to.
  if (request.url === '/login/stub-link') {
    const host = request.headers.host ?? '';
    const sameSite = request.headers.origin === `http://${host}` || request.headers['sec-fetch-site'] === 'same-origin';
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><body>enter</body></html>');
      return;
    }
    if (process.env.STUB_NO_LOGIN) {
      response.writeHead(410).end('链接已失效');
      return;
    }
    if (!sameSite) {
      response.writeHead(403).end('请求来源不被允许');
      return;
    }
    response.writeHead(303, { 'Set-Cookie': `${COOKIE}=stub-session; Path=/; HttpOnly; SameSite=Lax`, Location: '/', 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  const signedIn = (request.headers.cookie ?? '').split(';').some((pair) => pair.trim() === `${COOKIE}=stub-session`);
  // The three below answer the token in service.json.
  if (['POST /api/shutdown', 'GET /api/instance', 'GET /api/doctor', 'GET /api/release-check', 'POST /api/drain'].includes(route) && bearer !== `Bearer ${SHUTDOWN_TOKEN}`) {
    response.writeHead(401).end('token 无效');
    return;
  }
  if (route === 'POST /api/shutdown') {
    response.writeHead(202, { 'content-type': 'application/json' }).end('{"stopping":true}');
    stop('shutdown');
    return;
  }
  // What a release health check asks of the service itself. A test sets any of it.
  if (route === 'GET /api/release-check') {
    // A service that goes away in the observation window: it dies once this many checks
    // have been answered, the answer flushed first and the listener closed with the process,
    // so the next thing asked of it is refused rather than left half-answered.
    const diesAfter = Number(process.env.STUB_DIE_AFTER_CHECKS ?? 0);
    const dying = diesAfter > 0 && releaseChecks + 1 >= diesAfter;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      ledger: process.env.STUB_LEDGER_PROBLEM ?? 'ok',
      degraded: process.env.STUB_DEGRADED === '1',
      recovering: process.env.STUB_RECOVERING === '1',
      health_window_ms: Number(process.env.STUB_WINDOW_MS ?? 0),
      recovery_wait_ms: Number(process.env.STUB_RECOVERY_WAIT_MS ?? 0),
      ...(factSequence[Math.min(releaseChecks++, factSequence.length - 1)] ?? {}),
    }), () => {
      if (!dying) return;
      server.closeAllConnections();
      server.close();
      stop('died');
    });
    return;
  }
  // Waiting for the turn in flight, which this stand-in never has. A stand-in that does
  // not know the route at all is a service from before it existed.
  if (route === 'POST /api/drain') {
    if (process.env.STUB_NO_DRAIN) {
      response.writeHead(404).end();
      return;
    }
    if (process.env.STUB_TRACE) appendFileSync(process.env.STUB_TRACE, 'drain\n');
    const waited = Number(process.env.STUB_DRAIN_MS ?? 0);
    setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ drained: process.env.STUB_DRAIN_BUSY !== '1', waited_ms: waited })), waited);
    return;
  }
  // The console as the service serves it: one page, one asset it names, both behind the
  // sign-in above. An anonymous request is turned to the login page, as the real one does.
  const url = request.url ?? '';
  if (request.method === 'GET' && (url === '/' || url === '/index.html' || url.startsWith('/assets/'))) {
    if (!signedIn) {
      response.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (url === '/' || url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body><div id="root">stub</div><script type="module" src="/assets/index.js"></script></body></html>`);
      return;
    }
    if (process.env.STUB_NO_ASSETS) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/javascript' }).end('export {};\n');
    return;
  }
  // What the console reads on every page, also behind the sign-in.
  if (request.method === 'GET' && ['/api/messages?limit=1', '/api/tasks', '/api/overview'].includes(request.url ?? '')) {
    if (!signedIn) {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"需要登录"}');
      return;
    }
    if (process.env.STUB_NO_CORE === request.url) {
      response.writeHead(500).end('读不了');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stub: request.url }));
    return;
  }  // A service that does not say who it is: one from before it could, or one that hangs.
  if (route === 'GET /api/instance' && !process.env.STUB_NO_IDENTITY) {
    const { port } = server.address() as { port: number };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...identity, port, host: '127.0.0.1', data_dir: dataDir }));
    return;
  }
  if (route === 'GET /api/doctor') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(`{"checks":${doctor}}`);
    return;
  }
  response.writeHead(404).end();
});

server.listen(Number(process.env.TYCHO_PORT ?? 0), '127.0.0.1', () => {
  const { port } = server.address() as { port: number };
  writeFileSync(serviceFile, JSON.stringify({ ...identity, port, token: SHUTDOWN_TOKEN }));
  // Said once the announcement is on disk, for whoever started this stand-in to wait on:
  // service.json itself can be read and acted on (a failed candidate is stopped) in less
  // time than a poll's gap, while what was written here stays.
  console.error('stub service announced');
  // A service that goes on talking, for the log to be turned over under.
  const chatter = Number(process.env.STUB_CHATTER_BYTES ?? 0);
  const line = `${'x'.repeat(1023)}\n`;
  for (let written = 0; written < chatter; written += line.length) process.stderr.write(line);
  if (chatter > 0) process.stderr.write('stub chatter done\n');
  // A service that dies on its own a moment after it answered, for the window in which a
  // release must not crash.
  const dies = Number(process.env.STUB_DIE_AFTER_MS ?? 0);
  if (dies > 0) setTimeout(() => stop('died'), dies);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => stop(signal));
