// Guards signing in to a Claude account from the console (service/claude-login.ts) against:
// no address handed to the owner; a token read off the screen that never reaches the account,
// or reaches it cut short or with a wrapped line glued on; a code that was not accepted being
// retried on the same process instead of a new one with a new address; a new login on an
// account leaving the old one running; cancel, time-out or a stopping service leaving the CLI or
// the helper running (checked by pid and the moment each began); the code or the token landing
// in the data directory, the log or the ledger; an address logged with its query; a failed or
// cancelled re-login touching the token the account already had; a screen that cannot be read
// reported with any of its letters or digits; the CLI opening a browser on the host; and a
// host the helper does not run on offering a login at all. And, from the review of the first
// cut: a wrapped token saved after only its first chunk had arrived; a token-shaped example on a
// failure screen, or on the screen before the code, taken for the login's token; the helper's
// compile or self-check left running when a login being prepared is cancelled, times out or the
// service stops; the code taken before the CLI shows its prompt; a result that cannot be read
// reported as a bare time-out without its shape; and a process counted as reclaimed when its
// pid could not be checked at all.
//
// Every login here runs the fake CLI (tests/fake-claude-login.mjs) through the real helper:
// ConPTY is Windows-only, so those tests are skipped elsewhere.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeAdapter } from '../adapters/claude.ts';
import { selectProcesses } from '../node/hostprocess.ts';
import { processStartLater } from '../service/lock.ts';
import { createAccounts } from '../service/accounts.ts';
import { createClaudeLogin, type ClaudeLoginOptions } from '../service/claude-login.ts';
import type { LedgerOptions } from '../service/ledger.ts';
import type { DbHooks } from '../service/db.ts';
import { windowsCommandLine, type prepareBridge } from '../service/ptybridge.ts';
import { accountCredentialFile } from '../service/secrets.ts';
import { UNSUPPORTED_TEXT, type LoginView } from '../shared/claude-login.ts';
import { claudeTier, fixture, USER } from './helpers.ts';
import { gone, settle } from './process-standing.ts';

// The helper only runs on Windows; the bound is the test runner's own, big enough that a
// machine under load (each login asks the system for two process starts, a PowerShell each)
// finishes the work rather than being cut off by the harness.
const windowsOnly = { skip: process.platform !== 'win32' && '登录助手用的是 Windows 的伪终端（ConPTY），只在 Windows 上有', timeout: 240_000 };
const FAKE = join(import.meta.dirname, 'fake-claude-login.mjs');
const HANG = join(import.meta.dirname, 'fake-hang.mjs');
const GOOD = 'GoodCode0123456789abcdef#state-xyz-987';
const BAD = 'WrongCode99887766#state-bad-555';
const TOKEN = `sk-ant-oat01-${'Qw3_e-Rt5'.repeat(11)}AA`;
const OLD = 'old-token-should-stay-0451';
const TIERS = { execute: claudeTier('m-execute') };
// The login's limit for the tests that advance it themselves: short in the login's own time,
// so one tick reaches it, while the cleanup wait keeps the helper's real backstop far enough
// out that a loaded machine's compile is never what ends a login.
const CLOCK_LIMIT_MS = 5_000;
// Past any preparation this machine has been seen to take (tens of seconds under load), and no
// further: the session's cleanup wait is also the longest backstop a reclaim leaves pending, and
// a pending wait outlives the test that made it.
const CLOCK_CLEANUP_MS = 120_000;
const clocked = { limitMs: () => CLOCK_LIMIT_MS, cleanupMs: () => CLOCK_CLEANUP_MS } as const;
// The login types the Enter a moment after the code (ENTER_AFTER_MS, service/claude-login.ts):
// on the test's clock that moment is the test's to give, past it and short of the settle wait.
const CLOCK_ENTER_MS = 400;
// The login's own clock has run out to its limit: the test's, not the wall's.
const reachLimit = (t: TestContext): void => { t.mock.timers.tick(CLOCK_LIMIT_MS + 5); };

function setup(t: TestContext, fake: Record<string, string> = {}, tuned: Partial<ClaudeLoginOptions> = {}, ledgerOptions: LedgerOptions = {}) {
  let login: ReturnType<typeof createClaudeLogin> | undefined;
  let record: string | undefined;
  // Registered before fixture's directory cleanup: a live CLI still owns that directory.
  t.after(async () => {
    await login?.stopAll({ close: true });
    if (record) rmSync(record, { force: true });
  });
  const f = fixture(t, ledgerOptions);
  const accounts = createAccounts({ ledger: f.ledger, executors: { claude: claudeAdapter }, credentialExecutors: ['claude'], routingExecutors: ['claude'], dataDir: f.dir });
  f.ledger.putAccount({ id: 'old', name: 'old', executor: 'claude', tiers: TIERS }, USER, 'initial-ref');
  accounts.setCredential('old', OLD, USER);
  // Beside the data directory, never in it (what the secret scan reads is the service's own),
  // and gone with the test.
  record = `${f.dir}-fake.jsonl`;
  const logs: string[] = [];
  login = createClaudeLogin({
    dataDir: f.dir,
    ledger: f.ledger,
    accounts,
    models: { executors: { claude: claudeAdapter }, timeoutMs: 1000, fetch: async () => new Response('{}') },
    // The owner's settings at the values production runs with. A login here is not about how
    // long the machine takes to prepare the helper (a compile and two process-start queries,
    // which on a loaded machine is tens of seconds), so that must not be what ends one; the
    // tests that watch the limit give it their own clock and advance it themselves.
    limitMs: () => 15 * 60_000,
    // Long enough for the system to answer for every recorded process while the machine is
    // busy: one such answer is a PowerShell start, and it can take most of this on its own.
    cleanupMs: () => 60_000,
    settleMs: () => 2_000,
    commandLine: () => windowsCommandLine([process.execPath, FAKE]),
    env: () => ({ ...process.env, FAKE_LOGIN_RECORD: record, FAKE_LOGIN_GOOD: GOOD, FAKE_LOGIN_TOKEN: TOKEN, ...fake }),
    log: (line) => logs.push(line),
    ...tuned,
  });
  const events = (): { pid: number; event: string; browser?: string; opened?: boolean; host?: string; last?: boolean }[] => {
    try {
      return readFileSync(record!, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { f, accounts, login, logs, events, record };
}

// Waits for a fact, not for a while. The bound is only how long the test is willing to be
// wrong about its own failure; the preparation of the helper alone (a compile and the system's
// answer for two process starts) can take half a minute on a loaded machine.
async function until(read: () => LoginView, pass: (view: LoginView) => boolean, ms = 90_000): Promise<LoginView> {
  const end = Date.now() + ms;
  for (;;) {
    const view = read();
    if (pass(view)) return view;
    if (Date.now() > end) throw new Error(`没等到：${JSON.stringify({ ...view, url: view.url ? '…' : null })}`);
    await sleep(50);
  }
}

const waiting = (view: LoginView): boolean => view.state === 'waiting_code' || view.state === 'failed';
const settled = (view: LoginView): boolean => !['preparing', 'waiting_code', 'exchanging'].includes(view.state) && view.ended;

test('假 CLI 的记录随测试收尾删除', windowsOnly, async (t) => {
  let record = '';
  await t.test('生成自己的记录', async (child) => {
    const fixture = setup(child);
    record = fixture.record;
    const started = fixture.login.start('old', 'relogin', USER);
    await until(() => fixture.login.get(started.id), waiting);
    assert.ok(existsSync(record), '确实生成过记录');
  });
  assert.ok(record && !existsSync(record), '子测试收尾以后记录已删除');
});

// When the system says a process began, asked again while it has no answer: one such answer is
// a PowerShell start, and on a loaded machine it can outlast the query's own patience.
async function startOf(pid: number, withinMs = 60_000): Promise<string | undefined> {
  const end = Date.now() + withinMs;
  for (;;) {
    const start = await processStartLater(pid);
    if (start !== undefined || Date.now() >= end) return start;
    await sleep(200);
  }
}

// Every process the session recorded, gone: exited, or the pid now names another process. One
// that is still alive with a start that was never read, or cannot be read, does not pass. (A
// compile that ends in a fraction of a second may be gone before its start is read; gone is
// still gone.) The login's own two always have theirs: the address waits for them. Waited for,
// not sampled: on a busy machine the system's answer for a pid on its way out can take longer
// than the session's own cleanup wait, and "cannot say" is never "gone".
async function reclaimed(login: ReturnType<typeof createClaudeLogin>, id: string, { started = true } = {}): Promise<void> {
  const { helper, cli, preparing } = login.processesOf(id);
  if (started) assert.ok(helper?.start && cli?.start, '会话记下了助手和命令的进程和启动时刻');
  for (const each of [...preparing, ...(helper ? [helper] : []), ...(cli ? [cli] : [])]) {
    const found = await settle(each.pid, each.start, 60_000);
    assert.ok(gone(found), `pid ${each.pid}：${found}`);
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : statSync(path).isFile() ? [path] : [];
  });
}

test('非 Windows 主机：入口说不支持，不起任何东西', (t) => {
  const { login } = setup(t, {}, { platform: 'linux' });
  assert.equal(login.available(), false);
  assert.throws(() => login.start('old', 'relogin', USER), (err: Error) => err.message === UNSUPPORTED_TEXT);
});

// Windows answers "where is the local app data folder" from the home a program is started
// with, and answers nothing while AppData\Local is missing under it: the PowerShell login
// assistant then keeps its module analysis cache in its working directory, which is the
// service's. The session's own home has to be one Windows can answer for.
test('会话交给登录助手的主目录带着 AppData\\Local', windowsOnly, async (t) => {
  let handed: NodeJS.ProcessEnv | undefined;
  const { login } = setup(t, {}, {
    bridgeRuntime: {
      prepare: async () => ({ bridge: { kind: 'powershell', start: () => ({ command: 'powershell.exe', args: [] }) }, problems: [] }),
      start: (_bridge, run) => { handed = run.env; throw new Error('测试只取环境，不真起助手'); },
    },
  });
  const started = login.start('old', 'relogin', USER);
  await login.settled(started.id);
  assert.ok(handed, '登录把助手起过');
  assert.ok(existsSync(join(handed.USERPROFILE!, 'AppData', 'Local')), '主目录下要有 AppData\\Local');
});

test('重新登录：拿到网址，交码后新令牌换上，进程收回，秘密只在账号的凭据里', windowsOnly, async (t) => {
  const { f, accounts, login, logs, events } = setup(t);
  const started = login.start('old', 'relogin', USER);
  const offered = await until(() => login.get(started.id), waiting);
  assert.equal(offered.state, 'waiting_code');
  assert.match(offered.url!, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?.*state=[0-9a-f]{32}$/);
  login.submit(started.id, GOOD);
  const done = await until(() => login.get(started.id), settled);
  assert.deepEqual({ state: done.state, saved: done.saved, reason: done.reason, unconfirmed: done.unconfirmed }, { state: 'signed_in', saved: true, reason: null, unconfirmed: false });
  assert.equal(accounts.credentialOf('old')!.value, TOKEN);
  await reclaimed(login, started.id);

  // The CLI asked for a browser, and was given one that is not there.
  const browser = events().find((each) => each.event === 'browser');
  assert.ok(browser && browser.browser !== 'default' && browser.opened === false, JSON.stringify(browser));

  // Nothing of the code or the token anywhere but the account's own token file.
  const ref = f.ledger.accountCredentialRef('old')!;
  const keep = accountCredentialFile(f.dir, ref);
  for (const file of filesUnder(f.dir)) {
    const text = readFileSync(file).toString('latin1');
    assert.ok(!text.includes(GOOD) && !text.includes(GOOD.slice(-6)), `授权码在 ${file}`);
    if (file !== keep) assert.ok(!text.includes(TOKEN), `令牌在 ${file}`);
  }
  assert.ok(!readdirSync(f.dir).includes('login-sessions') || readdirSync(join(f.dir, 'login-sessions')).length === 0, '临时目录删掉了');
  const dumped = JSON.stringify(f.dump());
  assert.ok(!dumped.includes(GOOD) && !dumped.includes(TOKEN));
  const logged = logs.join('\n');
  assert.ok(!logged.includes(GOOD) && !logged.includes(TOKEN) && !logged.includes(GOOD.slice(-6)));
  assert.match(logged, /授权网址已取得：https:\/\/claude\.com\/cai\/oauth\/authorize$/m);
  assert.doesNotMatch(logged, /authorize\?/);
});

test('新账号：登录后令牌只在内存里，填好档位才建账号；档位被拒时令牌还在', windowsOnly, async (t) => {
  const { accounts, login } = setup(t);
  // A new login may carry a name an account already has: nothing is checked at start. The name
  // is the ledger's to decide, and to number if it is taken, in the save's own transaction.
  const clash = login.start('old', 'new', USER);
  assert.equal(login.get(clash.id).name, 'old');
  login.cancel(clash.id);
  assert.equal(accounts.get('old')!.name, 'old', '开始登录不动已有的账号');
  const started = login.start('fresh', 'new', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, GOOD);
  const signedIn = await until(() => login.get(started.id), settled);
  assert.deepEqual({ state: signedIn.state, saved: signedIn.saved }, { state: 'signed_in', saved: false });
  assert.equal(accounts.get('fresh'), undefined, '档位填好前没有账号');
  await reclaimed(login, started.id);

  assert.throws(() => login.save(started.id, { tiers: { execute: { kind: 'content', text: 'not json' } } }, USER));
  assert.equal(accounts.get('fresh'), undefined);
  const { login: saved, account } = login.save(started.id, { tiers: TIERS }, USER);
  assert.equal(saved.saved, true);
  assert.equal(account.executor, 'claude');
  assert.equal(account.name, 'fresh');
  assert.notEqual(account.id, 'fresh');
  assert.equal(accounts.credentialOf(account.id)!.value, TOKEN);
  assert.throws(() => login.save(started.id, { tiers: TIERS }, USER), /没有可保存的令牌/);
});

test('新账号不带名字：保存时用执行器的名字，重名自动加序号，新建不被重名拦住', windowsOnly, async (t) => {
  const { accounts, login } = setup(t);
  const first = login.start(undefined, 'new', USER);
  assert.equal(login.get(first.id).name, 'claude 账号', '一开始就能说会叫什么');
  await until(() => login.get(first.id), waiting);
  login.submit(first.id, GOOD);
  await until(() => login.get(first.id), settled);
  const { account: one } = login.save(first.id, { tiers: TIERS }, USER);
  assert.equal(one.name, 'claude 账号');
  // A second one, named the same way, is numbered rather than refused: a name is display, and
  // the id is the reference.
  const second = login.start(undefined, 'new', USER);
  await until(() => login.get(second.id), waiting);
  login.submit(second.id, GOOD);
  await until(() => login.get(second.id), settled);
  const { account: two } = login.save(second.id, { tiers: TIERS }, USER);
  assert.equal(two.name, 'claude 账号 2');
  assert.notEqual(two.id, one.id);
  assert.equal(accounts.list().filter(({ name }) => name.startsWith('claude 账号')).length, 2);
});

test('新账号读到组织后，名字仍是执行器的名字：组织标识不是名字', windowsOnly, async (t) => {
  const asked: string[] = [];
  const { login } = setup(t, {}, { models: {
    executors: { claude: claudeAdapter }, timeoutMs: 1000,
    fetch: async (url) => {
      asked.push(new URL(String(url)).pathname);
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { headers: { 'anthropic-organization-id': '3f6982b1-cb66-4a3c-95d1-5325e8e544a5' } });
    },
  } });
  const started = login.start(undefined, 'new', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, GOOD);
  const signed = await until(() => login.get(started.id), (view) => view.state === 'signed_in' && !view.models.refreshing);
  assert.deepEqual(signed.identity, { organizationId: '3f6982b1-cb66-4a3c-95d1-5325e8e544a5' });
  assert.equal(signed.name, 'claude 账号');
  const { account } = login.save(started.id, { tiers: TIERS }, USER);
  assert.equal(account.name, 'claude 账号');
  assert.deepEqual(asked, ['/v1/models'], '登录令牌读不了账号资料，不去问');
});

test('新账号自动读取暂存令牌的模型，失败原因不带令牌；重新登录不查询', windowsOnly, async (t) => {
  let calls = 0;
  const { login } = setup(t, {}, { models: {
    executors: { claude: claudeAdapter }, timeoutMs: 1000,
    fetch: async (url, init) => {
      if (String(url).includes('/v1/models')) calls += 1;
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${TOKEN}`);
      throw new Error(`fake server rejected ${TOKEN}`);
    },
  } });
  const started = login.start('fresh', 'new', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, GOOD);
  const signed = await until(() => login.get(started.id), (view) => view.state === 'signed_in' && !view.models.refreshing);
  assert.equal(calls, 1);
  assert.equal(signed.models.at, null);
  assert.match(signed.models.reason!, /fake server rejected \[已隐藏\]/);
  assert.ok(!JSON.stringify(signed).includes(TOKEN));
  login.cancel(started.id);
  const again = login.start('old', 'relogin', USER);
  await until(() => login.get(again.id), waiting);
  login.submit(again.id, GOOD);
  await until(() => login.get(again.id), settled);
  assert.equal(calls, 1);
});

test('新账号与初次模型清单同一事务保存，不发新增模型通知；失败时两者一起撤回', windowsOnly, async (t) => {
  const hooks: DbHooks = {};
  const { f, login } = setup(t, {}, { models: {
    executors: { claude: claudeAdapter }, timeoutMs: 1000,
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'm-one' }] })),
  } }, { testHooks: hooks });
  const started = login.start('fresh', 'new', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, GOOD);
  const signed = await until(() => login.get(started.id), (view) => view.state === 'signed_in' && !view.models.refreshing);
  assert.deepEqual(signed.models.list.map((m) => m.id), ['m-one']);
  assert.equal(f.ledger.getAccount('fresh'), undefined);
  // Fail the commit after both writes have run.
  hooks.beforeCommit = (actions) => { if (actions.includes('account.create')) throw new Error('fake commit failure'); };
  assert.throws(() => login.save(started.id, { tiers: TIERS }, USER), /fake commit failure/);
  assert.equal(f.ledger.getAccount('fresh'), undefined);
  assert.deepEqual(f.ledger.loginState('fresh').models, []);
  hooks.beforeCommit = undefined;
  const { account } = login.save(started.id, { tiers: TIERS }, USER);
  assert.deepEqual(f.ledger.loginState(account.id).models, signed.models.list);
  assert.equal(f.ledger.loginState(account.id).models_at, signed.models.at);
  assert.deepEqual(f.peek('SELECT * FROM outbox'), []);
});

test('授权码不对：这次结束；重新授权是新进程、新网址；旧登录不动', windowsOnly, async (t) => {
  const { accounts, login } = setup(t);
  const first = login.start('old', 'relogin', USER);
  const offered = await until(() => login.get(first.id), waiting);
  login.submit(first.id, BAD);
  assert.throws(() => login.submit(first.id, GOOD), /已经交了/);
  const refused = await until(() => login.get(first.id), settled);
  assert.deepEqual({ state: refused.state, reason: refused.reason }, { state: 'failed', reason: 'rejected' });
  await reclaimed(login, first.id);
  assert.equal(accounts.credentialOf('old')!.value, OLD);

  const again = login.start('old', 'relogin', USER);
  const reoffered = await until(() => login.get(again.id), waiting);
  assert.equal(reoffered.state, 'waiting_code');
  assert.notEqual(reoffered.url, offered.url);
  assert.notEqual(login.processesOf(again.id).cli!.pid, login.processesOf(first.id).cli!.pid);
  login.submit(again.id, GOOD);
  await until(() => login.get(again.id), settled);
  assert.equal(accounts.credentialOf('old')!.value, TOKEN);
});

test('连不上厂商：固定原因，不是“码不对”', windowsOnly, async (t) => {
  const { login } = setup(t, { FAKE_LOGIN_ERROR: 'network' });
  const started = login.start('old', 'relogin', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, BAD);
  assert.equal((await until(() => login.get(started.id), settled)).reason, 'unreachable');
});

test('取消、同一账号再开一次：进程收回，旧登录不动', windowsOnly, async (t) => {
  const { accounts, login } = setup(t);
  const first = login.start('old', 'relogin', USER);
  await until(() => login.get(first.id), waiting);
  const second = login.start('old', 'relogin', USER);
  const replaced = await until(() => login.get(first.id), settled);
  assert.equal(replaced.state, 'cancelled');
  await reclaimed(login, first.id);
  await until(() => login.get(second.id), waiting);
  assert.equal(login.cancel(second.id).state, 'cancelled');
  await until(() => login.get(second.id), settled);
  await reclaimed(login, second.id);
  assert.equal(accounts.credentialOf('old')!.value, OLD);
});

test('超时：作废并收回进程', windowsOnly, async (t) => {
  const { login } = setup(t, { FAKE_LOGIN_SILENT: '1' }, clocked);
  // The limit is the test's own clock: how long the helper takes to compile is not what this
  // is about, so it must not be what ends the login.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = login.start('old', 'relogin', USER);
  // The CLI is up and silent: no address ever comes, and only the limit ends this.
  await until(() => login.get(started.id), (view) => login.processesOf(view.id).cli?.start !== undefined);
  reachLimit(t);
  const ended = await until(() => login.get(started.id), settled);
  assert.deepEqual({ state: ended.state, reason: ended.reason }, { state: 'failed', reason: 'timeout' });
  await reclaimed(login, started.id);
});

test('服务停止：所有登录中断并收回，之后不再接新的', windowsOnly, async (t) => {
  const { login } = setup(t);
  const started = login.start('old', 'relogin', USER);
  await until(() => login.get(started.id), waiting);
  await login.stopAll({ close: true });
  const ended = login.get(started.id);
  assert.deepEqual({ state: ended.state, reason: ended.reason, ended: ended.ended }, { state: 'failed', reason: 'stopped', ended: true });
  await reclaimed(login, started.id);
  assert.throws(() => login.start('old', 'relogin', USER), /服务正在停止/);
});

for (const [name, fake, wantSaved] of [
  ['令牌折行：接回整段', { FAKE_LOGIN_WRAP: '37' }, true],
  ['令牌超长：不存，算认不出', { FAKE_LOGIN_TOKEN: `sk-ant-oat01-${'x'.repeat(600)}` }, false],
  ['令牌带空白：不猜，算认不出', { FAKE_LOGIN_TOKEN: 'sk-ant-oat01-abc def0123456789' }, false],
  ['成功画面上没有令牌：认不出', { FAKE_LOGIN_SCREEN: 'unknown', FAKE_LOGIN_EXIT: '1' }, false],
] as const) {
  test(name, windowsOnly, async (t) => {
    const { accounts, login, logs } = setup(t, fake);
    const started = login.start('old', 'relogin', USER);
    await until(() => login.get(started.id), waiting);
    login.submit(started.id, GOOD);
    const ended = await until(() => login.get(started.id), settled);
    await reclaimed(login, started.id);
    if (wantSaved) {
      assert.equal(ended.state, 'signed_in');
      assert.equal(accounts.credentialOf('old')!.value, TOKEN);
      return;
    }
    assert.deepEqual({ state: ended.state, reason: ended.reason }, { state: 'failed', reason: 'unrecognized' });
    assert.equal(accounts.credentialOf('old')!.value, OLD, '旧登录原样');
    // The shape is in the answer and the log, and holds no letter or digit of the screen.
    assert.ok(ended.shape && ended.shape.length > 0);
    assert.doesNotMatch(ended.shape, /[b-zA-Z1-9]/);
    assert.ok(logs.join('\n').includes(ended.shape));
    const printed = fake.FAKE_LOGIN_TOKEN ?? TOKEN;
    assert.ok(!logs.join('\n').includes(printed.slice(0, 20)));
  });
}

test('令牌一段段印出来、印完就停在那里：每段之后停住时都不存，静默满等待才存整段', windowsOnly, async (t) => {
  const { accounts, login, events } = setup(t, { FAKE_LOGIN_SCREEN: 'tail', FAKE_LOGIN_WRAP: '23', FAKE_LOGIN_PAUSE_MS: '1500' }, { settleMs: () => 4_000 });
  const started = login.start('old', 'relogin', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, GOOD);
  // While pieces are still coming, with pauses longer than any chunking, nothing is saved.
  let pieces = 0;
  while (!events().some((each) => each.event === 'piece' && each.last)) {
    pieces = events().filter((each) => each.event === 'piece').length;
    assert.equal(accounts.credentialOf('old')!.value, OLD, `印到第 ${pieces} 段时就存了`);
    assert.notEqual(login.get(started.id).state, 'signed_in');
    await sleep(100);
  }
  const lastAt = Date.now();
  const done = await until(() => login.get(started.id), settled);
  assert.equal(done.state, 'signed_in');
  assert.ok(Date.now() - lastAt >= 3_000, '印完以后等够了静默');
  assert.equal(accounts.credentialOf('old')!.value, TOKEN, '存的是整段');
  await reclaimed(login, started.id);
});

test('失败画面里的示例令牌不算：仍是“授权码未被接受”，旧登录不动', windowsOnly, async (t) => {
  const { accounts, login } = setup(t, { FAKE_LOGIN_ERROR: 'sample' });
  const started = login.start('old', 'relogin', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, BAD);
  const ended = await until(() => login.get(started.id), settled);
  assert.deepEqual({ state: ended.state, reason: ended.reason }, { state: 'failed', reason: 'rejected' });
  assert.equal(accounts.credentialOf('old')!.value, OLD);
});

test('交码之前画面上的示例令牌不算：交码后认不出就是认不出', windowsOnly, async (t) => {
  const { accounts, login } = setup(t, { FAKE_LOGIN_PRELUDE: '1', FAKE_LOGIN_SCREEN: 'unknown', FAKE_LOGIN_EXIT: '1' });
  const started = login.start('old', 'relogin', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, GOOD);
  const ended = await until(() => login.get(started.id), settled);
  assert.deepEqual({ state: ended.state, reason: ended.reason }, { state: 'failed', reason: 'unrecognized' });
  assert.equal(accounts.credentialOf('old')!.value, OLD);
});

test('没看到粘贴提示就不收码；到时限认不出，留形状', windowsOnly, async (t) => {
  const { login } = setup(t, { FAKE_LOGIN_PROMPT: '0' }, clocked);
  // The limit is the test's own clock: the address is a fact to wait for, and the helper's
  // compile takes as long as the machine needs.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = login.start('old', 'relogin', USER);
  // Ready to take a code but never asking for one: the address is up and both processes are
  // recorded, which is the state the paste prompt would come out of.
  const offered = await until(() => login.get(started.id), (view) => view.url !== null
    && login.processesOf(view.id).helper?.start !== undefined && login.processesOf(view.id).cli?.start !== undefined);
  assert.equal(offered.state, 'preparing', '网址出来了，但提示没出来');
  assert.ok(offered.url!.startsWith('https://claude.com/cai/oauth/authorize?'));
  assert.throws(() => login.submit(started.id, GOOD), /现在不收授权码/);
  reachLimit(t);
  const ended = await until(() => login.get(started.id), settled);
  assert.deepEqual({ state: ended.state, reason: ended.reason }, { state: 'failed', reason: 'unrecognized' });
  assert.ok(ended.shape && ended.shape.length > 0);
  await reclaimed(login, started.id);
});

test('交码后一直没有结果：等到登录时限，按认不出收场并留形状', windowsOnly, async (t) => {
  const { login, events } = setup(t, { FAKE_LOGIN_SCREEN: 'hang' }, clocked);
  // The exchange is given the rest of the login's limit, and that limit is the test's clock:
  // the screen has gone quiet, and advancing the clock is what ends it, not the wall.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = login.start('old', 'relogin', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, GOOD);
  // The code's Enter, then the screen falling quiet: both are the login's own clock.
  t.mock.timers.tick(CLOCK_ENTER_MS);
  await until(() => login.get(started.id), () => events().some((each) => each.event === 'hang'));
  reachLimit(t);
  const ended = await until(() => login.get(started.id), settled);
  assert.deepEqual({ state: ended.state, reason: ended.reason }, { state: 'failed', reason: 'unrecognized' });
  assert.ok(ended.shape && ended.shape.length > 0 && !/[b-zA-Z1-9]/.test(ended.shape));
  await reclaimed(login, started.id);
});

test('交换超过 90 秒仍使用登录时限剩余时间；到期才按认不出收场', windowsOnly, async (t) => {
  const { login } = setup(t, { FAKE_LOGIN_SCREEN: 'hang' }, { limitMs: () => 150_000, now: () => Date.now() });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const started = login.start('old', 'relogin', USER);
  await until(() => login.get(started.id), waiting);
  login.submit(started.id, GOOD);
  t.mock.timers.tick(90_001);
  assert.equal(login.get(started.id).state, 'exchanging', '不再有独立的 90 秒截止');
  t.mock.timers.tick(new Date(started.deadline).getTime() - Date.now() + 1);
  const ended = login.get(started.id);
  t.mock.timers.reset();
  assert.equal(ended.reason, 'unrecognized');
  await login.settled(started.id);
});

test('主人临近截止才交码、尚无新输出：认不出也留下已有画面的形状', windowsOnly, async (t) => {
  const { login } = setup(t, {}, { now: () => Date.now() });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const started = login.start('old', 'relogin', USER);
  await until(() => login.get(started.id), waiting);
  t.mock.timers.tick(new Date(started.deadline).getTime() - Date.now() - 1);
  login.submit(started.id, GOOD);
  t.mock.timers.tick(2);
  const ended = login.get(started.id);
  t.mock.timers.reset();
  assert.equal(ended.reason, 'unrecognized');
  assert.ok(ended.shape && ended.shape.length > 0, '不能只报到期、丢掉画面形状');
  await login.settled(started.id);
});

// The preparation, held where the test wants it: a compiler that never finishes, or a self-check
// that never ends. Either way the login has started processes before any CLI runs.
const stuck = {
  compile: { csc: [process.execPath, HANG] },
  selfCheck: { selfCheck: { commandLine: windowsCommandLine([process.execPath, HANG]), mark: 'never-printed', code: 7 } },
} as const;

for (const [where, bridge, needs] of [['编译中', stuck.compile, 1], ['自检中', stuck.selfCheck, 2]] as const) {
  for (const how of ['取消', '超时', '服务停止'] as const) {
    test(`准备阶段停在${where}时${how}：它起的进程按 pid 加启动时刻核对都已不在，登录程序没起`, windowsOnly, async (t) => {
      const { f, login, events } = setup(t, {}, { bridge, ...(how === '超时' ? clocked : {}) });
      // A time-out here is the login's limit reaching a preparation that is still going. That
      // limit is the test's to advance: at the wall, a slow machine's compile would decide it.
      if (how === '超时') t.mock.timers.enable({ apis: ['setTimeout'] });
      const record = join(f.dir, 'preparing.jsonl');
      const previous = process.env.FAKE_HANG_RECORD;
      process.env.FAKE_HANG_RECORD = record;
      t.after(() => {
        if (previous === undefined) delete process.env.FAKE_HANG_RECORD;
        else process.env.FAKE_HANG_RECORD = previous;
      });
      const started = login.start('old', 'relogin', USER);
      // Held there, with what it started recorded.
      const end = Date.now() + 60_000;
      while (!existsSync(record)) {
        assert.ok(Date.now() < end, `没停在${where}：${JSON.stringify(login.processesOf(started.id))}`);
        assert.equal(login.get(started.id).state, 'preparing');
        await sleep(50);
      }
      const hung = JSON.parse(readFileSync(record, 'utf8').trim()) as { pid: number; parent: number };
      const pids = needs === 2 ? [hung.pid, hung.parent] : [hung.pid];
      const recorded = await Promise.all(pids.map(async (pid) => ({ pid, start: await startOf(pid) })));
      assert.ok(recorded.every((each) => each.start !== undefined), '准备中的进程已核实启动时刻');
      // Also reclaims a regressed implementation's compiler if the assertion below fails.
      t.after(async () => {
        const processes = selectProcesses(process.platform);
        for (const each of recorded) {
          if (each.start !== undefined && await processes.startOf(each.pid) === each.start) await processes.endTree(each.pid, 'KILL');
        }
      });
      if (how === '取消') {
        login.cancel(started.id);
        await login.settled(started.id);
      } else if (how === '超时') {
        reachLimit(t);
        await until(() => login.get(started.id), settled);
        await login.settled(started.id);
      } else {
        await login.stopAll({ close: true });
      }
      const view = login.get(started.id);
      assert.ok(view.ended, '回收完了才返回');
      assert.equal(view.state, how === '取消' ? 'cancelled' : 'failed');
      for (const each of recorded) assert.ok(gone(await settle(each.pid, each.start, 60_000)), `准备进程 ${each.pid} 仍在`);
      await reclaimed(login, started.id, { started: false });
      assert.equal(login.processesOf(started.id).cli, undefined);
      await sleep(500);
      assert.ok(!events().some((each) => each.event === 'start'), '登录程序不该起来');
    });
  }
}

// A completed preparation must not leave the reclaim backstop keeping the process alive.
test('准备结束后回收不留下等待中的计时器', async (t) => {
  const preparation = Promise.withResolvers<Awaited<ReturnType<typeof prepareBridge>>>();
  const { login } = setup(t, {}, {
    platform: 'win32', cleanupMs: () => 1_000,
    bridgeRuntime: { prepare: () => preparation.promise, start: () => { throw new Error('不应启动'); } },
  });
  const timersBefore = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const started = login.start('old', 'relogin', USER);
  login.cancel(started.id);
  preparation.resolve({ bridge: undefined, problems: [] });
  await login.settled(started.id);
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, timersBefore);
});
