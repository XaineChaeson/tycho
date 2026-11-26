// Guards against a new user being unable to get from nothing to a console: a start that
// needs a file written by hand, a data directory that has to exist, a self-check that
// hides what is still missing or invents a problem, no way to sign in before anything is
// configured, a queue that breaks or hides its Task when there is no account to send it
// to; and the items that say "restart to take effect" not taking effect after one, or
// the one that says "at once" waiting for one.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { DoctorCheck } from '../service/doctor.ts';
import type { ServiceOptions } from '../service/main.ts';
import { startService } from '../service/main.ts';
import { createTools } from '../service/tools.ts';
import { CONSOLE_DIST, accepting, hideClaude, memoryLogins, noAccept, USER, freePort } from './helpers.ts';
import type { Service } from './stage.ts';
import { signIn, until } from './stage.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const LOGIN_LINK = join(import.meta.dirname, '..', 'service', 'login-link.ts');
const options = { timeout: 90_000 };
const json = async (response: Response): Promise<any> => response.json();

// A place that does not exist yet, and a service on it with nothing put there first.
function empty(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tycho-empty-'));
  const dataDir = join(root, 'not', 'made', 'yet');
  const running: Service[] = [];
  const previous = { ...process.env };
  t.after(async () => {
    for (const service of running) await service.stop();
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  });
  const tools = createTools({
    ledger: undefined as never,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({}),
    machines: undefined as never,
    accept: noAccept,
  });
  Object.assign(process.env, {
    FAKE_CLAUDE_LOG: join(root, 'fake.log'),
    FAKE_CLAUDE_TOOLS: JSON.stringify(tools.names.map((name) => `mcp__tycho__${name}`)),
  });
  const start = async (given: Partial<ServiceOptions> = {}): Promise<Service> => {
    const service = await startService({ dataDir, port: 0, claude: [process.execPath, FAKE], dispatchIntervalMs: 20, stopWaitMs: 2000, consoleDir: CONSOLE_DIST, ...given });
    running.push(service);
    return service;
  };
  const stop = async (service: Service): Promise<void> => {
    await service.stop();
    running.splice(running.indexOf(service), 1);
  };
  return { root, dataDir, start, stop };
}

const checksOf = async (client: Awaited<ReturnType<typeof signIn>>): Promise<Record<string, DoctorCheck>> =>
  Object.fromEntries(((await json(await client.get('/api/doctor'))).checks as DoctorCheck[]).map((check) => [check.id, check]));

// What is not in order. The address check is left to the test that listens on the port
// the settings name: these listen wherever is free, which the check rightly points out.
const missing = (checks: Record<string, DoctorCheck>): DoctorCheck[] =>
  Object.values(checks).filter(({ id, level }) => level !== 'ok' && id !== 'address');

const put = (client: Awaited<ReturnType<typeof signIn>>, key: string, value: unknown): Promise<Response> =>
  fetch(`${client.base}/api/settings/${key}`, {
    method: 'PUT',
    headers: { Cookie: client.cookie, Origin: client.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });

function loginLink(dataDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', LOGIN_LINK], { env: { ...process.env, TYCHO_DATA: dataDir } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout.trim(), stderr });
    });
  });
}

test('on a directory that does not exist the service comes up, and the self-check lists exactly what is still to do', options, async (t) => {
  const { dataDir, start } = empty(t);
  const service = await start();
  assert.ok(existsSync(join(dataDir, 'ledger.db')), '数据目录和账本自己建');
  assert.equal(existsSync(join(dataDir, 'config.json')), false, '不生成配置文件');
  const client = await signIn(service);
  const checks = await checksOf(client);
  assert.deepEqual(
    missing(checks).map(({ id, level, fix }) => [id, level, fix?.href ?? null]),
    [
      ['logins-account', 'fail', '#/accounts'],
      ['logins-machine', 'fail', '#/machines'],
      ['wecom', 'warn', '#/settings/wecom.botId'],
      ['backup', 'warn', '#/settings/backup.dir'],
    ],
    '全新安装缺的就是这四样，不多不少',
  );
  for (const id of ['node', 'data-dir', 'claude-cli', 'claude-login', 'router']) assert.equal(checks[id]!.level, 'ok', id);
  assert.equal(checks['data-dir']!.text, dataDir);
  for (const check of Object.values(checks)) assert.ok(check.title && check.text, check.id);

  const state = await json(await client.get('/api/state'));
  // No project has a message yet: no Router runs, and nothing is wrong (project-sessions §3).
  assert.deepEqual([state.router.alive, state.router.error, state.channels.wecom], [false, null, null]);
  assert.equal((await client.get('/')).status, 200);
  assert.deepEqual((await json(await client.get('/api/accounts'))).accounts, []);
  const defaults = Object.fromEntries((await json(await client.get('/api/settings'))).settings.map((item: { key: string; stored: boolean }) => [item.key, item.stored]));
  assert.ok(Object.values(defaults).every((stored) => stored === false), '一项都不用先填');
});

test('with no Claude Code either, the start still succeeds and that is one more line on the list', options, async (t) => {
  const { start, dataDir } = empty(t);
  hideClaude(dataDir);
  const service = await start({ claude: undefined });
  const checks = await checksOf(await signIn(service));
  assert.deepEqual(
    missing(checks).map(({ id, level }) => [id, level]),
    [['claude-cli', 'fail'], ['claude-login', 'warn'], ['router', 'fail'], ['logins-account', 'fail'], ['logins-machine', 'fail'], ['wecom', 'warn'], ['backup', 'warn']],
  );
  assert.match(checks['claude-cli']!.text, /找不到 claude/);
});

test('npm run login-link signs the owner in before anything is configured, on the address the service gives', options, async (t) => {
  const { dataDir, start } = empty(t);
  const service = await start();
  const made = await loginLink(dataDir);
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, new RegExp(`^http://127\\.0\\.0\\.1:${service.port}/login#[0-9a-f]{64}$`));
  const page = await fetch(made.stdout);
  assert.equal(page.status, 200);
  const base = `http://127.0.0.1:${service.port}`;
  const login = await fetch(new URL('/login', made.stdout), { method: 'POST', redirect: 'manual',
    headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: new URL(made.stdout).hash.slice(1) }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status, 200);

  // The address others are told is a setting that takes effect at once: the next link is built on it.
  const client = await signIn(service);
  assert.equal((await put(client, 'http.publicUrl', 'http://10.9.8.7:8787/')).status, 200);
  const published = await loginLink(dataDir);
  // Two lines for one credential: the published address, and this machine's own, which
  // still works when the published one was set wrong.
  const [outer, local] = published.stdout.split('\n');
  const credential = /^在外面用：http:\/\/10\.9\.8\.7:8787\/login#([0-9a-f]{64})$/.exec(outer!)?.[1];
  assert.ok(credential, published.stdout);
  assert.ok(local!.includes(`http://127.0.0.1:${service.port}/login#${credential}`), published.stdout);
  assert.equal((await checksOf(client)).address!.level, 'warn', '对外地址指向别处而只监听本机：提醒，不拦');
});

test('npm run login-link says so when no service is running, without needing any file to exist', options, async (t) => {
  const { root, dataDir } = empty(t);
  const none = await loginLink(dataDir);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /服务没有在运行/);
  assert.equal(existsSync(dataDir), false, '查一下不会把目录建出来');
  const stale = join(root, 'stale');
  const service = await startService({ dataDir: stale, port: 0, claude: [process.execPath, FAKE], stopWaitMs: 2000 });
  const { port } = service;
  await service.stop();
  // What a crash leaves: the files, and nothing answering on the port.
  writeFileSync(join(stale, 'service.json'), JSON.stringify({ pid: 1, port, token: 'x' }));
  writeFileSync(join(stale, 'login-token'), 'x');
  const gone = await loginLink(stale);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /服务没有在运行/);
});

test('with no account at all, an unpinned Task stops visibly and a missing pin is refused', options, async (t) => {
  const { start } = empty(t);
  const service = await start();
  const client = await signIn(service);
  const project = service.ledger.createProject({ name: '试跑' }, USER);
  const fields = { projectId: project, title: '没处可去', goal: '目标', acceptance: '验收', roleId: 'implement' };
  assert.throws(() => service.ledger.createTask({ ...fields, loginId: 'nowhere' }, USER), /不存在/);
  const task = service.ledger.createTask(fields, USER);
  service.ledger.queueTask(task.id, USER);
  await until(() => service.ledger.getTask(task.id).state === 'held', '没有目标的任务停住');
  assert.match(service.ledger.getTask(task.id).reason!, /没有可用的登录/);
  const overview = await json(await client.get('/api/overview'));
  assert.deepEqual(overview.held.map((work: { id: string }) => work.id), [task.id], '在总览“需要你”里');
  // The loop is still turning: a Task for a account added now goes out.
  const made = await fetch(`${client.base}/api/accounts`, {
    method: 'POST',
    headers: { Cookie: client.cookie, Origin: client.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'late', executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m\n' } }, credential: 'late-key' }),
  });
  assert.equal(made.status, 201);
  // The Router is told there is nothing to choose from, in words, not by a broken schema.
  const refused = await createTools({ ledger: service.ledger, runner: service.runner, logins: memoryLogins({}), machines: service.machines, accept: accepting(service.ledger) })
    .call('create_task', { title: 'x', goal: 'y', acceptance: 'z', login_id: 'nowhere', role_id: 'implement' }, { actor: 'router' }, { projectId: project });
  assert.equal(refused.isError, true);
});

test('the port and the bind address take a restart, and after one they are what the service listens on', options, async (t) => {
  const { dataDir, start, stop } = empty(t);
  const [one, two] = [await freePort(), await freePort()];
  const first = await start({ port: undefined, claude: [process.execPath, FAKE] }).catch(async () => {
    // 8787 may be taken on the machine running the tests: the default is not what is tested here.
    return start();
  });
  let client = await signIn(first);
  assert.equal((await put(client, 'http.port', one)).status, 200);
  assert.equal((await put(client, 'http.host', '0.0.0.0')).status, 200);
  const listed = Object.fromEntries((await json(await client.get('/api/settings'))).settings.map((item: { key: string; restart: boolean }) => [item.key, item.restart]));
  assert.deepEqual([listed['http.port'], listed['http.host'], listed['http.publicUrl']], [true, true, false]);
  const before = first.port;
  assert.equal((await fetch(`http://127.0.0.1:${before}/login`)).status, 200, '改了还在原来的端口上');
  const pending = (await checksOf(client)).address!;
  assert.equal(pending.level, 'warn');
  assert.match(pending.text, /重启服务后才生效/);
  await stop(first);

  const second = await start({ port: undefined });
  assert.equal(second.port, one, '重启后真的在新端口上');
  client = await signIn(second);
  const facts = Object.fromEntries((await json(await client.get('/api/settings'))).deployment.map(({ title, value }: { title: string; value: string }) => [title, value]));
  assert.equal(facts['实际监听地址'], `0.0.0.0:${one}`);
  assert.equal((await checksOf(client)).address!.level, 'ok');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')).port, one);
  const link = await loginLink(dataDir);
  assert.match(link.stdout, new RegExp(`^http://127\\.0\\.0\\.1:${one}/login#`), '0.0.0.0 上的服务，本机的链接走回环地址');

  assert.equal((await put(client, 'http.port', two)).status, 200);
  assert.equal(second.port, one);
  await stop(second);
  const third = await start({ port: undefined });
  assert.equal(third.port, two);
});

test('a port that is taken stops the start with what to do, and leaves nothing behind', options, async (t) => {
  const { dataDir, start } = empty(t);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  await assert.rejects(start({ port }), new RegExp(`端口 ${port} 已被占用`));
  assert.equal(existsSync(join(dataDir, 'lock')), false);
});
