// Guards against the Router's own configuration, now set in the console, taking the
// service down or going unnoticed: a Claude Code that is not installed, not signed in,
// or pointed at a tier file that is gone stopping the start (or costing the messages
// that arrive meanwhile) when it should leave the service up and say what is wrong; a
// Claude Code the setting names that is not there any more stopping the Router instead of
// being replaced by one the same search finds, or being replaced without a word about which
// one was taken; the Windows desktop app's own copy being looked for under a version
// written into the code; a
// second mechanism for "the Router cannot run" beside the existing halt; "重启负责人"
// starting with stale settings, cutting a turn short, taking a message during the wait,
// leaving two drivers, outliving a stop, slipping past the recovery barrier or leaving no
// trace; a Router bound to no account still setting CLAUDE_CONFIG_DIR, or leaving the one
// the service's own environment carries in force, so that the environment stays a second
// place the login is configured; the login question carrying the Router's marker; a CLI
// that cannot say whether it is signed in being taken for one that is signed out; the
// .cmd shim npm installs on Windows being handed to a spawn that cannot start it; a login
// that expires under a running Router reading as a Router that runs while it turns the
// queue into unverified messages; and the settings page showing the account, the Claude
// and the login that were saved for the next start as the ones the Router is running on.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { bannerNotes } from '../shared/labels.ts';
import type { Account } from '../runner/snapshot.ts';
import { claudeCommand, claudePath, inspectClaude, loginState, missingClaudeSetting } from '../service/claude-cli.ts';
import type { SessionHostOptions } from '../service/session-host.ts';
import { hostProcesses } from '../service/processes.ts';
import { createSessionHost, RouterUnavailable } from '../service/session-host.ts';
import { consoleApp } from './console-helpers.ts';
import type { AccountInput } from '../service/accounts.ts';
import { claudeTier, fixture, hideClaude, ROUTER_TUNED, tuned, USER } from './helpers.ts';
import type { Service } from './stage.ts';
import { pageProject, signIn, stage, until } from './stage.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const options = { timeout: 90_000 };
// The Router's lookup on a real disk is the host system's own: the Windows rules on Windows,
// the POSIX ones elsewhere. The rules themselves, for either system on any host, are in
// tests/locate.test.ts.
const onlyWindows = process.platform === 'win32' ? false : '真实的 Windows 文件系统';
const onlyPosix = process.platform === 'win32' ? '真实的 POSIX 文件系统' : false;
const json = async (response: Response): Promise<any> => response.json();
const WINDOWS = process.platform === 'win32';

// What the service itself needs from PATH, and nothing a Claude Code could be found in.
const systemPath = (): string =>
  WINDOWS
    ? ['System32', '', 'System32\\WindowsPowerShell\\v1.0'].map((dir) => join(process.env.SystemRoot!, dir)).join(delimiter)
    : ['/usr/bin', '/bin'].join(delimiter);

// A `claude` as an installer leaves one on PATH, which runs the fake CLI: npm's .cmd shim
// beside its script on Windows, an executable script elsewhere. Returns the file found.
function installClaude(dir: string): string {
  mkdirSync(dir, { recursive: true });
  if (!WINDOWS) {
    const file = join(dir, 'claude');
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(file, 0o755);
    return file;
  }
  const script = join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(script, { recursive: true });
  writeFileSync(join(script, 'cli.js'), `import ${JSON.stringify(pathToFileURL(FAKE).href)};\n`);
  writeFileSync(join(script, 'package.json'), '{"type":"module"}');
  const file = join(dir, 'claude.cmd');
  writeFileSync(file, '@echo off\r\nnode "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  return file;
}

async function client(service: Service) {
  const signed = await signIn(service);
  const put = (key: string, value: unknown): Promise<Response> =>
    fetch(`${signed.base}/api/settings/${key}`, {
      method: 'PUT',
      headers: { Cookie: signed.cookie, Origin: signed.base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  // A Claude account is written by the login window, which goes through this same store: a
  // page cannot hand in a login tycho obtains by a session on this host
  // (docs/design/native-login.md §5).
  const createAccount = (name: string, body: AccountInput) => service.accounts.put({ ...body, name }, USER);
  const router = async () => (await json(await signed.get('/api/state'))).router as { alive: boolean; pid: number | null; turn: string | null; error: string | null; restarting: boolean };
  const check = async (id: string) => ((await json(await signed.get('/api/doctor'))).checks as { id: string; level: string; text: string; fix: { href: string } | null }[]).find((each) => each.id === id)!;
  const restart = () => signed.post('/api/router/restart');
  // The read-only facts beside the settings, by title.
  const facts = async (): Promise<Record<string, string | undefined>> =>
    Object.fromEntries(((await json(await signed.get('/api/settings'))).deployment as { title: string; value: string }[]).map(({ title, value }) => [title, value]));
  return { ...signed, put, createAccount, router, check, restart, facts };
}

// A Router account: what it holds is its token (given when the console creates it) and a tier.
function routerAccount(id = 'router'): Account {
  return { id, name: id, executor: 'claude', tiers: { decide: claudeTier(`model-${id}`) } };
}

// What the facts say of a tier: its text is the account's, and the page says how much of it.
const tierFact = (account: Account): string => `账号里的档位内容（${account.tiers.decide!.text.length} 字）`;

// A restart that has run its course, and the process a project's next message brings up
// (docs/design/project-sessions.md §3: a Router starts when its project has a message).
async function restarted(service: Service, starts: () => number, count: number): Promise<boolean> {
  await until(() => !service.session.status().restarting, '重启受理完');
  const id = service.ledger.receiveMessage({ channel: 'console', externalId: `restart-${count}`, actor: 'console', text: '重启之后', projectId: pageProject(service) }).id;
  service.session.kick(id);
  return until(() => starts() === count && service.ledger.getMessage(id).state === 'processed', `第 ${count} 次启动负责人`);
}

// What is committed, read the way a restart would read it.
function countChanges(service: Service, action: string): number {
  const conn = new DatabaseSync(join(service.dataDir, 'ledger.db'), { readOnly: true });
  try {
    return (conn.prepare('SELECT count(*) AS n FROM change WHERE action = ?').get(action) as { n: number }).n;
  } finally {
    conn.close();
  }
}

// --- a Router that cannot be started as things stand ---

test('with no Claude Code anywhere the service is up, says so, keeps the messages, and the Router starts once one is there', options, async (t) => {
  const { start, dataDir, say, routerStarts } = stage(t, {});
  hideClaude(dataDir);
  const service = await start({ claude: undefined });
  const c = await client(service);
  const router = await c.router();
  assert.equal(router.alive, false);
  assert.match(router.error!, /找不到 claude/);
  assert.match(router.error!, /设置 › 负责人/, '横幅说去哪里改');
  assert.equal(routerStarts(), 0);
  const cli = await c.check('claude-cli');
  assert.deepEqual([cli.level, cli.fix?.href], ['fail', '#/settings/router.cli']);
  assert.equal((await c.check('router')).level, 'fail');

  // The console works, and what arrives meanwhile is kept for when the Router is back.
  const posted = await c.post('/api/messages', { text: '负责人不在时发的' });
  assert.equal(posted.status, 201);
  const { id } = await json(posted);
  const other = say(service, '第二条');
  assert.deepEqual([service.ledger.getMessage(id).state, service.ledger.getMessage(other).state], ['received', 'received']);

  const installed = installClaude(join(dataDir, 'bin'));
  assert.equal((await c.put('router.cli', installed)).status, 200);
  assert.equal((await c.router()).alive, false, '改设置不动负责人：下次启动负责人时生效');
  const answer = await c.restart();
  assert.equal(answer.status, 202);
  assert.deepEqual(await json(answer), { restarting: true, waiting_for_turn: null });
  await until(() => service.ledger.getMessage(other).state === 'processed', '留下的消息被处理');
  assert.equal(service.ledger.getMessage(id).state, 'processed');
  const after = await c.router();
  assert.deepEqual([after.alive, after.error, after.restarting], [true, null, false]);
  assert.equal((await c.check('claude-cli')).level, 'ok');
  assert.equal((await c.check('claude-cli')).text, installed);
  assert.equal(countChanges(service, 'router.restart'), 1);
});

test('a Claude Code on PATH is found without being named, and shown as the one in use', options, async (t) => {
  const { start, dataDir, greet } = stage(t, {});
  const installed = installClaude(join(dataDir, 'bin'));
  process.env.PATH = [join(dataDir, 'bin'), systemPath()].join(delimiter);
  const service = await start({ claude: undefined });
  const c = await client(service);
  assert.equal((await c.router()).error, null);
  await greet(service);
  const facts = await c.facts();
  assert.equal(facts['负责人正在用的 Claude Code'], installed);
  assert.equal(facts['负责人的 Claude 登录'], '已登录（owner@example.com）。查的是负责人正在用的那一份：这台电脑已有的登录');
  assert.equal(facts['数据目录'], dataDir);
  assert.equal(facts['实际监听地址'], `127.0.0.1:${service.port}`);
});

test('a path set for Claude Code that is gone is replaced by one the search finds, and the self-check says which', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const named = installClaude(join(dataDir, 'bin-named'));
  const kept = installClaude(join(dataDir, 'bin-kept'));
  hideClaude(dataDir);
  process.env.PATH = [join(dataDir, 'bin-named'), join(dataDir, 'bin-kept'), process.env.PATH].join(delimiter);
  // The console only saves a path whose file is there; what this is about is the file
  // going away afterwards, as an update that moved it does.
  const service = await start({ claude: undefined }, { settings: { 'router.cli': named } });
  const c = await client(service);
  assert.equal((await c.router()).error, null);
  await greet(service);
  assert.equal((await c.facts())['负责人正在用的 Claude Code'], named);

  const before = routerStarts();
  rmSync(named, { force: true });
  assert.equal((await c.restart()).status, 202);
  await restarted(service, routerStarts, before + 1);
  await greet(service);
  // The Router runs on what the search found, and the line says which file that is and
  // that the one the setting names is gone.
  const cli = await c.check('claude-cli');
  assert.deepEqual([cli.level, cli.fix?.href], ['warn', '#/settings/router.cli']);
  assert.equal(cli.text, `设置里填的 ${named} 不存在，改用 ${kept}`);
  assert.equal((await c.facts())['负责人正在用的 Claude Code'], `${kept}（设置里填的 ${named} 不存在）`);
});

test('a Claude Code that is not signed in is not started: the reason shows, and signing in plus a restart brings the Router up', options, async (t) => {
  const { start, say, routerStarts } = stage(t, {});
  process.env.FAKE_CLAUDE_AUTH = 'out';
  const service = await start();
  const c = await client(service);
  const router = await c.router();
  assert.equal(router.alive, false);
  assert.match(router.error!, /负责人用的 Claude 没有登录/);
  assert.equal(routerStarts(), 0, '没登录就不启动：不拿第一条消息去试');
  const login = await c.check('claude-login');
  assert.deepEqual([login.level, login.fix?.href], ['fail', '#/settings/router.account']);
  assert.match(login.text, /^没有登录。查的是负责人下次启动会用的那一份：这台电脑已有的登录/);
  // No process runs: what is shown is said to be what the next start would take.
  const facts = await c.facts();
  assert.equal(facts['负责人下次启动会用的 Claude Code'], [process.execPath, FAKE].join(' '));
  assert.equal(facts['负责人正在用的 Claude Code'], undefined);
  assert.match(facts['负责人的 Claude 登录']!, /^没有登录。查的是负责人下次启动会用的那一份/);
  const waiting = say(service, '等登录');
  process.env.FAKE_CLAUDE_AUTH = 'in';
  assert.equal((await c.restart()).status, 202);
  await until(() => service.ledger.getMessage(waiting).state === 'processed', '登录后处理');
  assert.equal((await c.check('claude-login')).level, 'ok');
  assert.equal(routerStarts(), 1);
});

test('a Claude Code that cannot say whether it is signed in is started all the same', options, async (t) => {
  const { start, greet } = stage(t, {});
  process.env.FAKE_CLAUDE_AUTH = 'old';
  const service = await start();
  const c = await client(service);
  assert.equal((await c.router()).error, null);
  await greet(service);
  const login = await c.check('claude-login');
  assert.equal(login.level, 'warn');
  assert.match(login.text, /查不出登录状态/);
});

test('the account\'s tier is what the settings file --settings is handed holds; no tier hands an empty object', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const account = routerAccount();
  const service = await start({}, { logins: { router: account }, credentials: { router: 'router-test-token' }, settings: { 'router.account': 'router', 'router.tier': 'decide' } });
  const c = await client(service);
  await greet(service);
  const argvOf = (index: number): string[] => startsOf(dataDir)[index]!;
  const before = routerStarts();
  const first = argvOf(before - 1);
  assert.deepEqual(
    JSON.parse(readFileSync(first[first.indexOf('--settings') + 1]!, 'utf8')),
    JSON.parse(account.tiers.decide!.text),
    '档位内容原样写进负责人的设置文件',
  );

  assert.equal((await c.put('router.tier', '')).status, 200);
  await c.restart();
  await restarted(service, routerStarts, before + 1);
  // No tier: settings file is an empty object without hidden exclusions.
  const argv = argvOf(before);
  assert.deepEqual(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1]!, 'utf8')), {}, '没有选档位，设置为空对象');
});

// What the fake CLI logged: each Router start with its argv, each login question.
function logOf(dataDir: string): { argv?: string[]; auth?: string; config_dir?: string | null; marker_env?: string | null; pid?: number; token_ok?: boolean }[] {
  return readFileSync(join(dataDir, 'fake.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

const startsOf = (dataDir: string): string[][] => logOf(dataDir).flatMap(({ argv }) => (argv ? [argv] : []));

test('the account\'s token and the marker are this start\'s to say, whatever environment the service itself was started in', options, async (t) => {
  const { start, dataDir, greet, say, routerStarts } = stage(t, {});
  // What a service started from a shell that runs Claude Code, or from inside a Router,
  // finds in its own environment.
  process.env.CLAUDE_CONFIG_DIR = join(dataDir, 'inherited-home');
  process.env.TYCHO_ROUTER_MARKER = 'inherited-marker';
  process.env.FAKE_CLAUDE_EXPECT_TOKEN = 'router-token';
  t.after(() => delete process.env.FAKE_CLAUDE_EXPECT_TOKEN);
  const account = routerAccount();
  const service = await start();
  const c = await client(service);
  await greet(service);
  // Each login question and each Router start the fake CLI saw from `from` on.
  const asked = (from = 0) => logOf(dataDir).slice(from).filter(({ argv, auth }) => argv || auth);
  const questions = (from = 0) => asked(from).filter(({ auth }) => auth);
  for (const entry of asked()) assert.equal(entry.config_dir, null, '没有绑定账号：登录检查和负责人进程都不用环境里带来的那个');
  for (const entry of questions()) assert.equal(entry.marker_env, null, '问登录状态不带负责人的标记');
  assert.equal(asked().find(({ argv }) => argv)!.marker_env, service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!.marker);

  // Bound to an account: the login is that account's, from here on.
  const body = { executor: account.executor, tiers: account.tiers, credential: 'router-token' };
  const { account: { id } } = c.createAccount('router', body);
  assert.equal((await c.put('router.account', id)).status, 200);
  assert.equal((await c.put('router.tier', 'decide')).status, 200);
  let before = logOf(dataDir).length;
  const opened = service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!;
  await c.restart();
  const [first, second] = [say(service, '换登录后第一条'), say(service, '换登录后第二条')];
  await restarted(service, routerStarts, 2);
  assert.ok(asked(before).length >= 2);
  for (const entry of asked(before)) assert.deepEqual([entry.config_dir, entry.token_ok], [null, true], '登录检查问的就是账号那一份登录：令牌是它的，配置照旧是这台机器的');
  for (const entry of questions(before)) assert.equal(entry.marker_env, null);
  // The old session lived in the old login: it is not tried on a message.
  assert.ok(!startsOf(dataDir)[1]!.includes('--resume'));
  assert.notEqual(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!.id, opened.id);
  await until(() => service.ledger.getMessage(second).state === 'processed', '换登录后的消息处理完');
  assert.equal(service.ledger.getMessage(first).state, 'processed');

  // Cleared in the page: back to the login this machine has, not to the inherited one.
  assert.equal((await c.put('router.account', '')).status, 200);
  assert.equal((await c.put('router.tier', '')).status, 200);
  before = logOf(dataDir).length;
  await c.restart();
  await restarted(service, routerStarts, 3);
  assert.ok(asked(before).length >= 2);
  for (const entry of asked(before)) assert.equal(entry.config_dir, null, '页面解绑了账号，仍在用环境里的那个');
  for (const entry of questions(before)) assert.equal(entry.marker_env, null);
});

test('the deployment facts and the login check are about the Claude the Router runs on; what was saved since waits for a restart and says so', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const service = await start();
  const c = await client(service);
  await greet(service);
  const machine = '这台电脑已有的登录';
  const none = '没有绑定账号，用这台电脑已有的登录和默认档位';
  let facts = await c.facts();
  assert.equal(facts['负责人正在用的 Claude Code'], [process.execPath, FAKE].join(' '));
  assert.equal(facts['负责人正在用的账号'], none);
  assert.equal(facts['负责人正在用的登录目录'], undefined, '账号只换身份：没有登录目录这一说');
  assert.equal(facts['负责人正在用的档位'], '没有指定，用 Claude Code 自己的默认档位');
  assert.equal(facts['已保存，重启负责人后生效'], undefined);

  // Saved in the console and not yet in force: the account, its login and its tier.
  const account = routerAccount();
  const { account: { id } } = c.createAccount('router', { executor: account.executor, tiers: account.tiers, credential: 'router-token' });
  assert.equal((await c.put('router.account', id)).status, 200);
  assert.equal((await c.put('router.tier', 'decide')).status, 200);
  const before = logOf(dataDir).length;
  facts = await c.facts();
  assert.equal(facts['负责人正在用的账号'], none, '保存了还没重启：显示的仍是在用的那一份');
  assert.equal(facts['负责人正在用的档位'], '没有指定，用 Claude Code 自己的默认档位');
  assert.equal(facts['已保存，重启负责人后生效'], `账号：router；档位：${tierFact(account)}`);
  assert.equal(facts['负责人的 Claude 登录'], `已登录（owner@example.com）。查的是负责人正在用的那一份：${machine}`);
  assert.equal((await c.check('claude-login')).text, `已登录（owner@example.com）。查的是负责人正在用的那一份：${machine}`);
  const questions = logOf(dataDir).slice(before).filter(({ auth }) => auth);
  assert.ok(questions.length >= 1);
  for (const entry of questions) assert.equal(entry.config_dir, null, '查的是负责人实际在用的那份登录，不是刚保存还没生效的那份');

  await c.restart();
  await restarted(service, routerStarts, 2);
  facts = await c.facts();
  assert.deepEqual(
    [facts['负责人正在用的账号'], facts['负责人正在用的档位']],
    ['router', tierFact(account)],
  );
  assert.equal(facts['已保存，重启负责人后生效'], undefined, '重启后在用的和保存的一致');
  assert.equal(facts['负责人的 Claude 登录'], '已登录（owner@example.com）。查的是负责人正在用的那一份：账号 router 的令牌');
});

test('a login that expires while the Router runs reads as 负责人停摆 with where to put it right, and the rest of the queue waits for the restart', options, async (t) => {
  const { start, dataDir, greet, say, turnsSeen } = stage(t, {});
  const lost = join(dataDir, 'login-lost');
  process.env.FAKE_CLAUDE_LOGIN_LOST = lost;
  const service = await start();
  const c = await client(service);
  await greet(service);
  writeFileSync(lost, '');
  const [first, second, third] = [say(service, '甲'), say(service, '乙'), say(service, '丙')];
  const stateOf = (id: string) => service.ledger.getMessage(id).state;
  await until(() => stateOf(first) === 'unverified', '在手上的那条待核实');
  await until(() => !service.session.status().alive, '失效的进程收尾');
  assert.deepEqual([stateOf(second), stateOf(third)], ['received', 'received'], '排队的消息被逐条变成了待核实');
  const state = await json(await c.get('/api/state'));
  assert.equal(state.router.alive, false);
  assert.match(state.router.error, /Claude 登录已失效.*设置 › 负责人.*重启负责人/);
  assert.deepEqual(bannerNotes(state).map(({ text, href }) => [/^负责人已停摆：.*登录已失效/.test(text), href]), [[true, '#/settings/router.cli']]);
  assert.equal((await c.check('router')).level, 'fail');

  rmSync(lost);
  assert.equal((await c.restart()).status, 202);
  await until(() => stateOf(third) === 'processed', '登录恢复并重启后处理剩下的');
  assert.equal(stateOf(second), 'processed');
  assert.deepEqual(turnsSeen().slice(-2), ['乙', '丙']);
  assert.equal((await c.router()).error, null);
});

test('a Router stopped for any other reason is cleared the same way: there is one "负责人停摆"', options, async (t) => {
  const { start, say } = stage(t, {});
  const tools = process.env.FAKE_CLAUDE_TOOLS!;
  process.env.FAKE_CLAUDE_TOOLS = JSON.stringify(['Bash']);
  const service = await start();
  const c = await client(service);
  const lost = say(service, '触发工具核对');
  await until(() => service.session.status().error !== null, '工具列表不符而停摆');
  assert.match((await c.router()).error!, /负责人工具列表不符/);
  await until(() => service.ledger.getMessage(lost).state === 'unverified', '那条消息待核实');
  process.env.FAKE_CLAUDE_TOOLS = tools;
  const next = say(service, '恢复之后');
  await c.restart();
  await until(() => service.ledger.getMessage(next).state === 'processed', '重启负责人后恢复');
  assert.equal((await c.router()).error, null);
});

// --- restarting it ---

test('重启负责人 waits for the turn under way, takes no message meanwhile, and then one new process drives', options, async (t) => {
  const { start, greet, say, routerStarts } = stage(t, {});
  const service = await start();
  const c = await client(service);
  await greet(service);
  const first = (await c.router()).pid!;
  const marker = service.ledger.currentContext(pageProject(service))!.marker;
  const long = say(service, '长回合');
  await until(() => service.session.status().turn === long, '回合开始');
  const queued = say(service, '排在后面');

  const answer = await c.restart();
  assert.equal(answer.status, 202);
  assert.deepEqual(await json(answer), { restarting: true, waiting_for_turn: long });
  const waiting = await c.router();
  assert.deepEqual([waiting.restarting, waiting.pid, waiting.turn], [true, first, long], '回合没有被重启打断');
  assert.equal(service.ledger.getMessage(queued).state, 'received', '等待期间不接新消息');
  assert.equal((await c.restart()).status, 202, '再点一次是同一次重启');

  // The owner's own interrupt is what hastens it, by the existing rule.
  assert.equal((await c.post('/api/interrupt')).status, 200);
  await until(() => service.ledger.getMessage(queued).state === 'processed', '重启后处理排队的消息');
  assert.equal(service.ledger.getMessage(long).state, 'unverified', '被打断的回合按现有规则待核实');
  const after = await c.router();
  assert.equal(after.restarting, false);
  assert.notEqual(after.pid, first);
  assert.equal(routerStarts(), 2);
  assert.deepEqual(await hostProcesses.find(marker), [after.pid], '只有新负责人进程仍带着会话标记');
  assert.equal(countChanges(service, 'router.restart'), 2, '每次请求都留了记录');
});

test('a stop during a pending restart ends cleanly and starts nothing', options, async (t) => {
  const { start, greet, say, routerStarts, stop } = stage(t, {});
  const service = await start();
  const c = await client(service);
  await greet(service);
  const marker = service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!.marker;
  const long = say(service, '长回合');
  await until(() => service.session.status().turn === long, '回合开始');
  await c.restart();
  assert.equal(service.session.status().restarting, true);
  await stop(service);
  assert.equal(routerStarts(), 1, '停服之后没有再拉起负责人');
  assert.deepEqual(await hostProcesses.find(marker), []);
});

test('a restart keeps the session: the Router goes on with the conversation it had', options, async (t) => {
  const { start, dataDir, greet, routerStarts } = stage(t, {});
  const service = await start();
  const c = await client(service);
  await greet(service);
  const session = service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!;
  await c.restart();
  await restarted(service, routerStarts, 2);
  assert.equal(service.ledger.currentContext(service.ledger.listProjects()[0]?.id ?? '')!.id, session.id);
  const argv = startsOf(dataDir)[1]!;
  assert.deepEqual(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2), ['--resume', session.session_ref]);
});

test('POST /api/router/restart follows the rules of the other controls: login, Origin, degraded mode, the recovery barrier, a change row', async (t) => {
  const barrier = { recovering: false };
  const crash = { armed: false };
  const f = fixture(t, {
    recovery: { recovering: () => barrier.recovering },
    testHooks: { beforeCommit: () => { if (crash.armed) throw Object.assign(new Error('disk I/O error'), { errcode: 10 }); } },
  });
  const { post, url, cookie, state } = await consoleApp(t, { f });
  const rows = () => f.peek<{ actor: string }>(`SELECT actor FROM change WHERE action = 'router.restart'`).map((row) => row.actor);
  assert.equal((await post('/api/router/restart', {}, { Origin: url })).status, 401);
  assert.equal((await post('/api/router/restart', {}, { Cookie: cookie, Origin: 'http://elsewhere.test' })).status, 403);
  assert.equal((await post('/api/router/restart', {}, { Cookie: cookie })).status, 403);
  barrier.recovering = true;
  const held = await post('/api/router/restart');
  assert.equal(held.status, 503);
  assert.match((await json(held)).error, /恢复清点，现在不能重启负责人/);
  barrier.recovering = false;
  assert.deepEqual([state.restarts, rows()], [0, []]);

  state.current = 'm1';
  const done = await post('/api/router/restart');
  assert.equal(done.status, 202);
  assert.deepEqual(await json(done), { restarting: true, waiting_for_turn: 'm1' });
  assert.deepEqual([state.restarts, rows()], [1, ['console']]);

  crash.armed = true;
  assert.equal((await post('/api/router/restart')).status, 503);
  crash.armed = false;
  const degraded = await post('/api/router/restart');
  assert.equal(degraded.status, 503);
  assert.match((await json(degraded)).error, /降级模式/);
  assert.deepEqual([state.restarts, rows()], [1, ['console']], '记不下来的重启不发生');
});

// --- the Session Host on its own ---

function hostOn(t: TestContext, launchWith: SessionHostOptions['launchWith']) {
  let stop = async (): Promise<void> => {};
  const previous = { ...process.env };
  t.after(async () => {
    try {
      await stop();
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
      Object.assign(process.env, previous);
    }
  });
  const f = fixture(t);
  Object.assign(process.env, { FAKE_CLAUDE_LOG: join(f.dir, 'fake.log'), FAKE_CLAUDE_TOOLS: JSON.stringify(['mcp__tycho__list_tasks']) });
  const halts: string[] = [];
  const host = createSessionHost({ ...ROUTER_TUNED,
    ledger: f.ledger, dataDir: f.dir, launchWith, toolNames: ['list_tasks'], pollMs: 20,
    turnTimeoutMs: tuned('router.turnTimeoutMs'), onHalt: (reason) => halts.push(reason), log: () => {},
  });
  stop = host.stop;
  const send = (text: string): string => f.ledger.receiveMessage({ channel: 'console', externalId: text, actor: 'user', text, projectId: f.projectId }).id;
  return { f, host, halts, send };
}

test('the Host asks what to start with at every start, stops on the reason it is given, and opens no session it cannot use', options, async (t) => {
  let reason: string | undefined = '找不到 Claude Code';
  let asked = 0;
  const { f, host, halts, send } = hostOn(t, async () => {
    asked += 1;
    if (reason) throw new RouterUnavailable(reason);
    return { claude: [process.execPath, FAKE] };
  });
  await host.start(1);
  assert.deepEqual([host.status().alive, host.status().error, asked], [false, '找不到 Claude Code', 1]);
  assert.deepEqual(halts, ['找不到 Claude Code'], '原因原样给主人，不加“启动失败”');
  assert.equal(f.ledger.currentContext(f.ledger.listProjects()[0]?.id ?? ''), undefined, '起不来就不开会话');
  const message = send('等着');
  host.kick();

  await host.restart();
  assert.equal(f.ledger.getMessage(message).state, 'received');
  assert.deepEqual([host.status().alive, host.status().error, asked], [false, '找不到 Claude Code', 2], '还是起不来：按今天的原因再停');
  assert.equal(halts.length, 2);
  reason = undefined;
  await host.restart();
  assert.equal(host.status().error, null);
  await until(() => f.ledger.getMessage(message).state === 'processed', '起来之后处理留下的消息');
  // The restart asks, and so does the start the waiting message brings.
  assert.equal(asked, 4);
});

test('a restart asked for before the start has finished follows it, and one asked for after a stop does nothing', options, async (t) => {
  let asked = 0;
  const { host } = hostOn(t, async () => {
    asked += 1;
    return { claude: [process.execPath, FAKE] };
  });
  const early = host.restart();
  assert.equal(host.status().restarting, true);
  assert.equal(asked, 0, '启动之前什么都不拉起：还没有端口可以给工具代理');
  await host.start(1);
  await early;
  // Each asked what to start with; a project's process comes up with its first message.
  assert.deepEqual([asked, host.status().alive, host.status().restarting, host.status().error], [2, false, false, null]);
  await host.stop();
  await host.restart();
  assert.deepEqual([asked, host.status().alive], [2, false]);
});

test('an unexpected failure to say what to start with stops the Host as a failed start', options, async (t) => {
  const { host } = hostOn(t, async () => {
    throw new Error('boom');
  });
  await host.start(1);
  assert.match(host.status().error!, /负责人启动失败：Error: boom/);
});

// --- finding the CLI and asking it ---

test('claude is looked for on PATH, .exe before .cmd on Windows, and only a file counts', { skip: onlyWindows }, (t) => {
  // The Router asks the same lookup a machine does (node/locate.ts); none of the declared
  // places is in these environments.
  const findClaude = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined => claudePath('', env, platform);
  const f = fixture(t);
  const [a, b] = [join(f.dir, 'a'), join(f.dir, 'b')];
  mkdirSync(a);
  mkdirSync(b);
  const env = (...dirs: string[]): NodeJS.ProcessEnv => ({ Path: dirs.join(delimiter) });
  assert.equal(findClaude(env(a, b), 'win32'), undefined);
  assert.equal(findClaude({}, 'win32'), undefined);
  mkdirSync(join(a, 'claude.exe'));
  writeFileSync(join(b, 'claude.cmd'), '');
  assert.equal(findClaude(env(a, b), 'win32'), join(b, 'claude.cmd'), '目录不是可执行文件');
  writeFileSync(join(b, 'claude.exe'), '');
  assert.equal(findClaude(env(a, b), 'win32'), join(b, 'claude.exe'));
  writeFileSync(join(a, 'claude'), '');
  assert.equal(findClaude({ PATH: [a, b].join(delimiter) }, 'win32'), join(b, 'claude.exe'), 'Windows 上不认没有扩展名的');
  // PATH comes before the places the adapter declares.
  const home = join(f.dir, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'claude.exe'), '');
  assert.equal(findClaude({ PATH: b, USERPROFILE: home }, 'win32'), join(b, 'claude.exe'), 'PATH 上有就用 PATH 上的');
  assert.equal(findClaude({ PATH: a, USERPROFILE: home }, 'win32'), join(home, '.local', 'bin', 'claude.exe'), 'PATH 上没有就找原生安装器的位置');
});

test('on Linux and macOS the Router looks on PATH, then in ~/.local/bin, and only an executable file counts', { skip: onlyPosix }, (t) => {
  const f = fixture(t);
  const [bin, home] = [join(f.dir, 'bin'), join(f.dir, 'home')];
  mkdirSync(bin);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const native = join(home, '.local', 'bin', 'claude');
  writeFileSync(native, '#!/bin/sh\n');
  chmodSync(native, 0o755);
  const onPath = join(bin, 'claude');
  writeFileSync(onPath, '#!/bin/sh\n');
  chmodSync(onPath, 0o644);
  assert.equal(claudePath('', { PATH: bin, HOME: home }, process.platform), native, '不能执行的不算，接着找原生安装器的位置');
  chmodSync(onPath, 0o755);
  assert.equal(claudePath('', { PATH: bin, HOME: home }, process.platform), onPath, 'PATH 上有就用 PATH 上的');
  assert.equal(claudePath('', { PATH: bin.slice(1), HOME: home }, process.platform), native, '相对的 PATH 项不认');
});

test('a .cmd is npm\'s shim: its script is started with node, and one that is not npm\'s is refused with what to do', (t) => {
  const f = fixture(t);
  assert.deepEqual(claudeCommand(join(f.dir, 'claude.exe')), [join(f.dir, 'claude.exe')]);
  assert.deepEqual(claudeCommand('/usr/local/bin/claude'), ['/usr/local/bin/claude']);
  const shim = join(f.dir, 'claude.cmd');
  assert.throws(() => claudeCommand(shim), /\.cmd 脚本.*claude\.exe 的完整路径/);
  const script = join(f.dir, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(script, { recursive: true });
  writeFileSync(join(script, 'cli.js'), '');
  assert.deepEqual(claudeCommand(shim), [process.execPath, join(script, 'cli.js')]);
  assert.deepEqual(claudeCommand(join(f.dir, 'CLAUDE.CMD')), [process.execPath, join(script, 'cli.js')]);
});

test('only the CLI\'s own answer decides whether it is signed in', options, async (t) => {
  const f = fixture(t);
  const cli = [process.execPath, FAKE];
  const env = (auth: string): NodeJS.ProcessEnv => ({ ...process.env, FAKE_CLAUDE_AUTH: auth, FAKE_CLAUDE_LOG: join(f.dir, 'fake.log') });
  assert.deepEqual(await loginState(cli, env('in')), { loggedIn: true, detail: 'owner@example.com' });
  assert.deepEqual(await loginState(cli, env('out')), { loggedIn: false, detail: '' });
  const old = await loginState(cli, env('old'));
  assert.equal(old.loggedIn, null, '退出码 1 而没有答复：不知道，不当成没登录');
  const started = performance.now();
  const silent = await loginState(cli, env('hang'), 400);
  assert.deepEqual(silent, { loggedIn: null, detail: '0.4 秒内没有答复' });
  assert.ok(performance.now() - started < 5000);
  const missing = await loginState([join(f.dir, 'no-such-claude.exe')], process.env);
  assert.equal(missing.loggedIn, null);
});

test('a path set by hand is used as it is, and one that is not a file is said to be so', options, async (t) => {
  const f = fixture(t);
  const dir = join(f.dir, 'not-a-file');
  mkdirSync(dir);
  const none = await inspectClaude(dir, process.env);
  assert.deepEqual([none.command, none.login], [null, null]);
  assert.match(none.problem!, /不是一个可执行文件/);
  const installed = installClaude(join(f.dir, 'bin'));
  const found = await inspectClaude(installed, { ...process.env, FAKE_CLAUDE_LOG: join(f.dir, 'fake.log') });
  assert.equal(found.problem, null);
  assert.equal(found.path, installed);
  assert.equal(found.login?.loggedIn, true);
  // What the setting names is a fact of its own: it is read the same way whatever happens
  // to be on PATH.
  assert.equal(missingClaudeSetting(''), undefined, '什么都没填就没有哪条路径是过期的');
  assert.equal(missingClaudeSetting(installed), undefined);
  assert.equal(missingClaudeSetting(join(f.dir, 'gone.exe')), join(f.dir, 'gone.exe'));
});

test('the Claude Code the Windows desktop app installs is found by version, not by a version written into the code', { ...options, skip: onlyWindows }, async (t) => {
  const f = fixture(t);
  const app = join(f.dir, 'Claude-Data');
  const put = (install: string, version: string, hash: string): string => {
    const file = join(app, install, 'claude-code', version, hash, 'claude.exe');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    return file;
  };
  const findClaudeApp = (env: NodeJS.ProcessEnv): string | undefined => claudePath('', env, 'win32');
  assert.equal(findClaudeApp({}), undefined, '没有 LOCALAPPDATA 就没有它的安装目录');
  assert.equal(findClaudeApp({ LOCALAPPDATA: join(f.dir, 'not-there') }), undefined);
  const older = put('claude_aaa', '2.1.309', 'hash-a');
  const newer = put('claude_aaa', '2.1.317', 'hash-b');
  assert.equal(findClaudeApp({ LocalAppData: f.dir }), newer, '大小写不分的变量名也读，最新的版本胜出');
  // A version directory with no executable in it is not one to start.
  mkdirSync(join(app, 'claude_aaa', 'claude-code', '99.0.0', 'hash-c'), { recursive: true });
  // Another installation whose newest version is newer by the numbers, and a directory
  // that is not a version at all.
  const other = put('claude_bbb', '10.0.0', 'hash-d');
  put('claude_bbb', 'nightly', 'hash-e');
  assert.equal(findClaudeApp({ LOCALAPPDATA: f.dir }), other, '10.0.0 比 2.1.317 新');
  assert.equal(findClaudeApp({ LOCALAPPDATA: f.dir, PATH: '' }), other, '桌面应用的那份不看 PATH');
  rmSync(other, { force: true });

  // What a start takes for a setting whose file is gone: the same search, and the setting's
  // own path is carried along to be said out loud.
  const gone = join(f.dir, 'gone.exe');
  const env = { LOCALAPPDATA: f.dir, PATH: '' };
  assert.deepEqual([claudePath(gone, env, 'win32'), missingClaudeSetting(gone)], [newer, gone]);
  assert.deepEqual([claudePath('', env, 'win32'), missingClaudeSetting('')], [newer, undefined], '没有指定路径时也一样按这条规则找');
  assert.deepEqual([claudePath(older, env, 'win32'), missingClaudeSetting(older)], [older, undefined], '文件还在就用它，不做别的');
  // A file that is there but cannot be started is the setting's own answer: never replaced.
  const shim = join(f.dir, 'claude.cmd');
  writeFileSync(shim, '');
  const refused = await inspectClaude(gone, { LOCALAPPDATA: f.dir, PATH: f.dir }, 'win32');
  assert.deepEqual([refused.path, refused.settingGone], [shim, gone]);
  assert.match(refused.problem!, /是一个 \.cmd 脚本|不是一个可执行文件/);
  assert.equal(refused.login, null, '启动不了就没有登录可问');
});
