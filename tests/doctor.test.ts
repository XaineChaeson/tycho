// Guards against a self-check that misleads: something missing reported as fine or the
// other way round, a line with nowhere to go to put it right, a fact that only a running
// service has being guessed at when there is none, a machine nobody has tried yet read
// as down (or as up), a public address that cannot reach what the service listens on
// passing unremarked, an account's line sending the owner to the machines page or a
// machine's own login to the accounts page, a listening address changed in the settings
// but not yet in force being shown as if it were, a login line that does not say which login it asked
// about, or speaks of the one saved for the next start while the Router runs on another,
// or calls an account's own token this computer's login; a Claude Code that the setting
// names but that is not there being reported as fine without saying which one was taken
// instead; and, with a gateway, a connection that is down or still being made passing for
// one that stands, the reason ssh gave being dropped, a public address a login from outside
// cannot work with (none, or not https) going unremarked, uppercase HTTPS being rejected
// despite working, a private key ssh would refuse being passed over or reported without the
// command that would put it right, and the owner being
// told to listen on every interface for an address that is reached through the gateway;
// and a project that allows spawning machines while the host has no public address — a
// round over SSH is then handed no materials — passing unremarked.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ClaudeInspection } from '../service/claude-cli.ts';
import type { DoctorCheck, DoctorInput } from '../service/doctor.ts';
import { doctor } from '../service/doctor.ts';
import type { SettingKey, SettingValue } from '../service/settings.ts';
import { createSettings } from '../service/settings.ts';
import { fixture, USER } from './helpers.ts';

const CLAUDE: ClaudeInspection = { path: 'C:\\tools\\claude.exe', command: ['C:\\tools\\claude.exe'], problem: null, login: { loggedIn: true, detail: 'owner@example.com' } };
const fact = (host: string, up: boolean | null, login = 't1') => ({ login_id: login, machine_id: host, host, up, last_ok_at: up ? '2026-11-06T00:00:00.000Z' : null, active_runs: 0 });
// With no login directory set and nothing said of a running process.
const NEXT_LOGIN = '查的是负责人下次启动会用的那一份：这台电脑已有的登录';

// Everything in order, for a case to change one thing in.
function setup(t: TestContext) {
  const f = fixture(t);
  const settings = createSettings({ ledger: f.ledger, log: () => {} });
  const set = <K extends SettingKey>(key: K, value: SettingValue<K>): void => settings.set(key, value, USER);
  set('backup.dir', f.dir);
  const healthy: DoctorInput = {
    nodeVersion: 'v24.3.0',
    dataDir: f.dir,
    settings,
    claude: CLAUDE,
    logins: [{ id: 't1', name: 't1' }],
    wecomSecretSet: true,
    router: { alive: true, error: null },
    listening: { host: '127.0.0.1', port: 8787 },
    machines: [fact('h1', true), fact('h2', false)],
    wecom: { connected: true, error: null },
  };
  set('wecom.owner', 'zhang');
  set('wecom.botId', 'bot');
  set('http.publicUrl', 'http://127.0.0.1:8787');
  const run = (changed: Partial<DoctorInput> = {}): Record<string, DoctorCheck> =>
    Object.fromEntries(doctor({ ...healthy, ...changed }).map((check) => [check.id, check]));
  return { f, settings, set, healthy, run };
}

test('with everything in order every line is ok and none sends the owner anywhere', (t) => {
  const { f, run } = setup(t);
  const checks = run();
  assert.deepEqual(Object.keys(checks), ['node', 'data-dir', 'claude-cli', 'claude-login', 'router', 'logins', 'login:t1', 'wecom', 'backup', 'address', 'gateway']);
  for (const check of Object.values(checks)) assert.deepEqual([check.level, check.fix], ['ok', null], check.id);
  assert.equal(checks['claude-cli']!.text, 'C:\\tools\\claude.exe');
  assert.equal(checks['claude-login']!.text, `已登录（owner@example.com）。${NEXT_LOGIN}`);
  assert.equal(checks['login:t1']!.text, '1/2 台连得上');
  assert.equal(checks['data-dir']!.text, f.dir);
});

test('an unknown host registration is reported with the local rejoin recovery', (t) => {
  const { run } = setup(t);
  const check = run({ hostMachine: null })['host-machine']!;
  assert.equal(check.level, 'warn');
  assert.match(check.text, /无法记到对应机器登录的额度/);
  assert.match(check.text, /运行服务的用户重新接入一次/);
  assert.equal(check.fix?.href, '#/machines');
  assert.equal(run({ hostMachine: 'known-machine' })['host-machine'], undefined);
  assert.equal(run({ hostMachine: undefined })['host-machine'], undefined, '从未本机接入不是绑定丢失');
});

test('every line that is not ok says what to do, and all but the ones outside the console say where', (t) => {
  const { run, set } = setup(t);
  set('wecom.botId', '');
  set('backup.dir', '');
  const checks = run({
    nodeVersion: 'v22.11.0',
    dataDir: 'Z:\\no\\such\\dir',
    claude: { path: null, command: null, problem: '在 PATH 里找不到 claude', login: null },
    router: { alive: false, error: '在 PATH 里找不到 claude。装好 Claude Code' },
    logins: [],
    machines: [],
    wecom: null,
  });
  const levels = Object.fromEntries(Object.values(checks).map(({ id, level }) => [id, level]));
  assert.deepEqual(levels, {
    node: 'fail', 'data-dir': 'fail', 'claude-cli': 'fail', 'claude-login': 'warn', router: 'fail', 'logins-account': 'fail', 'logins-machine': 'fail', wecom: 'warn', backup: 'warn', address: 'ok', gateway: 'ok',
  });
  const links = Object.fromEntries(Object.values(checks).filter(({ fix }) => fix).map(({ id, fix }) => [id, fix!.href]));
  assert.deepEqual(links, {
    'claude-cli': '#/settings/router.cli', router: '#/settings/router.cli', 'logins-account': '#/accounts', 'logins-machine': '#/machines',
    wecom: '#/settings/wecom.botId', backup: '#/settings/backup.dir',
  });
  assert.match(checks.node!.text, /需要 24\.3\.0 或更新/);
  assert.match(checks['data-dir']!.text, /不能读写/);
  assert.match(checks.router!.text, /负责人已停摆：在 PATH 里找不到 claude/);
  for (const check of Object.values(checks)) assert.ok(check.text.length > 0 && check.title.length > 0, check.id);
});

test('the login of the Router\'s Claude is ok, missing or unknown, never guessed', (t) => {
  const { run } = setup(t);
  const login = (state: ClaudeInspection['login']) => run({ claude: { ...CLAUDE, login: state } })['claude-login']!;
  assert.deepEqual([login({ loggedIn: false, detail: '' }).level, login({ loggedIn: false, detail: '' }).fix?.href], ['fail', '#/settings/router.account']);
  assert.match(login({ loggedIn: false, detail: '' }).text, /没有登录/);
  assert.match(login({ loggedIn: false, detail: '' }).text, /绑定一个账号/, '没绑账号：说在这台电脑上登录，或绑一个账号');
  assert.match(
    run({ claude: { ...CLAUDE, login: { loggedIn: false, detail: '' } }, routerLogin: { account: 'gpu', token: false } })['claude-login']!.text,
    /没有登录。.*账号 gpu 的登录（用这台电脑已有的登录）。到账号页给账号 gpu 点“重新登录”/,
    '绑了账号：理由说的是这个账号',
  );
  const unknown = login({ loggedIn: null, detail: '8 秒内没有答复' });
  assert.equal(unknown.level, 'warn');
  assert.match(unknown.text, /查不出登录状态：8 秒内没有答复/);
  assert.equal(login({ loggedIn: true, detail: '' }).text, `已登录。${NEXT_LOGIN}`);
});

test('the login line names the login it asked about: the one the Router runs on, or else the one its next start would take', (t) => {
  const { run, set, healthy } = setup(t);
  const line = (changed: Partial<DoctorInput> = {}): string => run(changed)['claude-login']!.text;
  const running = (): DoctorInput['router'] => ({ alive: true, error: null, launched: { claude: ['claude'] } });
  set('router.account', 'gpu');
  const saved = { account: 'gpu', token: false };
  assert.equal(line({ routerLogin: saved }), '已登录（owner@example.com）。查的是负责人下次启动会用的那一份：账号 gpu 的登录（用这台电脑已有的登录）');
  assert.equal(line({ router: { alive: false, error: null, launched: null }, routerLogin: saved }), line({ routerLogin: saved }), '没有进程在跑：查的是下次启动会用的');
  // An account that holds a token of its own: that is what the Router signs in with.
  assert.equal(line({ routerLogin: { account: 'gpu', token: true } }), '已登录（owner@example.com）。查的是负责人下次启动会用的那一份：账号 gpu 的令牌');
  assert.equal(
    line({ router: { alive: true, error: null, launched: { claude: ['claude'], account: 'gpu', credentialRef: '3' } } }),
    '已登录（owner@example.com）。查的是负责人正在用的那一份：账号 gpu 的令牌',
    '在跑的那个进程拿的是账号的令牌，不是这台电脑已有的登录',
  );
  // Saved since the Router started: the check is still about the one it runs on.
  assert.equal(line({ router: running() }), '已登录（owner@example.com）。查的是负责人正在用的那一份：这台电脑已有的登录', '在跑的那个进程不绑账号：查的是这台电脑已有的登录');
  const out = { claude: { ...CLAUDE, login: { loggedIn: false, detail: '' } } };
  assert.match(line({ ...out, router: running() }), /^没有登录。查的是负责人正在用的那一份：这台电脑已有的登录。/);
  assert.match(line({ ...out, claude: { ...CLAUDE, login: { loggedIn: null, detail: '8 秒内没有答复' } } }), /^查不出登录状态：8 秒内没有答复。查的是负责人下次启动会用的那一份/);
  // A command line with no service running says nothing of a process, and still names the login.
  const { router: _router, ...offline } = healthy;
  assert.match(doctor(offline).find(({ id }) => id === 'claude-login')!.text, /查的是负责人下次启动会用的那一份/);
});

test('a binding that cannot start is a failing login line about the next start, never this computer\'s own login', (t) => {
  const { run } = setup(t);
  // What the settings name cannot be started with: the account is gone, its executor cannot
  // drive the Router, its tier is not one the CLI takes, or its login directory is not there.
  // All of them are problems of the next start, and none of them is answered by asking this
  // computer's own login — which the check would otherwise find signed in and call fine.
  const gone = '负责人绑定的账号 claude 已经删了';
  const deleted = run({ routerLogin: { account: 'claude', token: false, problem: gone } })['claude-login']!;
  assert.deepEqual([deleted.level, deleted.text, deleted.fix], ['fail', gone, { label: '去设置', href: '#/settings/router.account' }]);
  const executor = '账号 codex-on-box 的执行器是 codex，不能当负责人（今天只有 Claude Code 能）';
  assert.equal(run({ routerLogin: { account: 'codex-on-box', token: false, problem: executor } })['claude-login']!.text, executor);
  const tier = '负责人的档位 decide 用不了：档位内容里不能写管权限、沙箱、审批的设置（permissions）';
  assert.equal(run({ routerLogin: { account: 'claude', token: false, problem: tier } })['claude-login']!.fix?.href, '#/settings/router.account');
  // The machine's own Claude Code being found and signed in does not make the binding fine.
  assert.equal(run({ routerLogin: { account: 'claude', token: false, problem: gone } })['claude-cli']!.level, 'ok');
});

test('a login expected to run out is a warning naming the account and the day, and says when it may be gone', (t) => {
  const { run } = setup(t);
  assert.equal(run()['login-expiry:a:c1:soon'], undefined, '不在提醒期的账号不出现');
  const soon = run({ expiringLogins: [{ id: 'a', name: 'claude', expected: '2026-12-09T12:00:00.000Z', expired: false, credentialAt: 'c1' }] })['login-expiry:a:c1:soon']!;
  assert.deepEqual([soon.level, soon.fix], ['warn', { label: '去账号页', href: '#/accounts' }]);
  assert.match(soon.text, /账号 claude/);
  assert.match(soon.text, /2026-12-09/);
  assert.ok(!/可能已经失效/.test(soon.text), '还没到预计到期：不说已经失效');
  const past = run({ expiringLogins: [{ id: 'a', name: 'claude', expected: '2026-11-01T12:00:00.000Z', expired: true, credentialAt: 'c1' }] })['login-expiry:a:c1:past']!;
  assert.equal(past.level, 'warn');
  assert.match(past.text, /可能已经失效/);
  assert.match(past.text, /2026-11-01/);
  // The credential and the state are part of the id: the home page keeps a dismissed check's
  // id, so a token stored again or an estimate since passed is a line of its own, not one the
  // owner already hid.
  const again = run({ expiringLogins: [{ id: 'a', name: 'claude', expected: '2026-12-09T12:00:00.000Z', expired: false, credentialAt: 'c2' }] });
  assert.ok(again['login-expiry:a:c2:soon'] && !again['login-expiry:a:c1:soon']);
});

test('a project with no usable login is a warning pointing at that project\'s settings', (t) => {
  const { run } = setup(t);
  const check = run({ projectsWithoutLogins: [{ id: 'p1', name: '试跑', reason: '项目 试跑 选用的登录里一个可用的登录都没有（项目页“登录”）' }] })['project-no-login:p1']!;
  assert.equal(check.level, 'warn');
  assert.equal(check.fix?.href, '#/projects/p1/settings');
  assert.match(check.text, /项目 试跑/);
  assert.match(check.text, /一个可用的登录都没有/);
  assert.equal(run()['project-no-login:p1'], undefined);
});

test('a path set for Claude Code that is not there is replaced by one that is, and the line says which', (t) => {
  const { f, run } = setup(t);
  const gone = join(f.dir, 'moved', 'claude.exe');
  const cli = (claude: ClaudeInspection): DoctorCheck => run({ claude })['claude-cli']!;
  const replaced = cli({ path: 'C:\\app\\claude.exe', command: ['C:\\app\\claude.exe'], problem: null, settingGone: gone, login: { loggedIn: true, detail: '' } });
  assert.deepEqual([replaced.level, replaced.fix?.href], ['warn', '#/settings/router.cli']);
  assert.equal(replaced.text, `设置里填的 ${gone} 不存在，改用 C:\\app\\claude.exe`);
  // Nothing found anywhere: what the setting names is in the reason.
  const none = cli({ path: null, command: null, settingGone: gone, problem: `设置里填的 Claude Code 路径不存在：${gone}，在 PATH 里都没找到 claude`, login: null });
  assert.equal(none.level, 'fail');
  assert.match(none.text, /路径不存在/);
  // A file that is there but cannot be started is the owner's own answer, never replaced.
  const named = 'C:\\tools\\claude.cmd';
  assert.equal(
    cli({ path: null, command: null, problem: `设置里填的 Claude Code 路径不是一个可执行文件：${named}`, login: null }).text,
    `设置里填的 Claude Code 路径不是一个可执行文件：${named}。负责人靠它运行：装好 Claude Code，或填上它的路径`,
  );
});

test('the gateway key line says whether ssh would accept the private key, and what to run if not', (t) => {
  const { f, run, set, healthy } = setup(t);
  const key = join(f.dir, 'door-key');
  // The registry only saves a file that is there; what the line is about is a file that was
  // there when it was saved and is gone now, which is what a moved key looks like.
  writeFileSync(key, 'KEY');
  set('gateway.ssh', 'deploy@door.example');
  set('http.publicUrl', 'https://tycho.example');
  set('gateway.keyFile', key);
  const gateway = { state: 'connected', since: '2026-11-06T00:00:00.000Z', error: null } as const;
  const line = (changed: Partial<DoctorInput> = {}): DoctorCheck => run({ gateway, ...changed })['gateway-key']!;
  set('gateway.keyFile', '');
  assert.equal(run({ gateway })['gateway-key'], undefined, '没填私钥就不查：那是运行服务的用户自己的 SSH 配置和密钥');
  set('gateway.keyFile', key);

  // What this machine really says about a file that is not there: the reading itself.
  rmSync(key);
  const missing = line();
  assert.deepEqual([missing.level, missing.fix?.href], ['fail', '#/settings/gateway.keyFile']);
  assert.match(missing.text, /私钥文件不存在/);

  const tighten = `icacls "${key}" /inheritance:r /grant:r "EXAMPLE\\owner:R"`;
  const open = line({ keyAccess: () => ({ kind: 'open', others: ['NT AUTHORITY\\Authenticated Users'], tighten }) });
  assert.equal(open.level, 'fail');
  assert.match(open.text, /别的账号也能读它：NT AUTHORITY\\Authenticated Users/);
  assert.ok(open.text.includes(tighten), '说的是能照做的那条命令');
  assert.ok(open.text.includes('/remove:g'), '明确授权的账号还要单独去掉，继承来的那条命令才管得着');

  const tight = line({ keyAccess: () => ({ kind: 'ok' }) });
  assert.deepEqual([tight.level, tight.fix], ['ok', null]);
  assert.ok(tight.text.endsWith(key) && tight.text.startsWith('只有运行服务的这个用户'), tight.text);

  const unknown = line({ keyAccess: () => ({ kind: 'unknown', reason: 'icacls 不给看' }) });
  assert.deepEqual([unknown.level, unknown.fix?.href], ['warn', '#/settings/gateway.keyFile']);
  assert.match(unknown.text, /查不了它的权限：icacls 不给看/);

  // A file on this machine, not something only a running service knows: the command line
  // answers it too.
  const { router: _router, ...offline } = healthy;
  assert.match(doctor(offline).find(({ id }) => id === 'gateway-key')!.text, /私钥文件不存在/);
});

test('a account is fine with one machine that answers, in doubt when none was tried, and failing when all were and none did', (t) => {
  const { run } = setup(t);
  const account = (machines: DoctorInput['machines']) => run({ machines })['login:t1']!;
  assert.equal(account([fact('h1', false), fact('h2', true)]).level, 'ok');
  const untried = account([fact('h1', null), fact('h2', null)]);
  assert.deepEqual([untried.level, untried.fix?.href], ['warn', '#/accounts']);
  assert.match(untried.text, /还没有连过/);
  const down = account([fact('h1', false), fact('h2', false)]);
  assert.deepEqual([down.level, down.fix?.href], ['fail', '#/accounts']);
  assert.match(down.text, /2 台机器都连不上/);
  assert.equal(account([fact('h1', false), fact('h2', null)]).level, 'fail', '试过的都不通，没试过的不算通');
  assert.equal(account([fact('h1', true, 'other')]).level, 'warn', '别的账号的机器不算它的');
  // An account and a machine's own login, each with what is known of the machines it may use,
  // and each sent to its own page: an account is put right on the accounts page, a machine's
  // own login on the machine's row of the machines page.
  const several = run({ logins: [{ id: 't1', name: 't1' }, { id: 'h9/codex', name: 'h9/codex', machine: 'h9', executor: 'codex' }], machines: [fact('h1', true), fact('h9', false, 'h9/codex')] });
  assert.deepEqual([several['login:t1']!.level, several['login:h9/codex']!.level, several.logins!.text], ['ok', 'fail', '2 个']);
  assert.equal(several['login:h9/codex']!.title, '机器 h9 上的 codex 登录 的机器');
  assert.deepEqual([several['login:h9/codex']!.fix?.href, several['login:h9/codex']!.fix?.label], ['#/machines', '去机器页']);
});

// A login the ledger never held is put right where that kind of login is made.
test('a missing login is sent to the page that makes that kind of login', (t) => {
  const { run } = setup(t);
  const checks = run({ logins: [{ id: 't1', name: 't1' }], missingLogins: ['t1', 'h9/codex'] });
  assert.deepEqual(
    [checks['login-missing:t1']!.level, checks['login-missing:t1']!.fix?.href, checks['login-missing:h9/codex']!.fix?.href],
    ['fail', '#/accounts', '#/machines'],
  );
});

test('without a running service its facts are said to be unknown, not made up', (t) => {
  const { run } = setup(t);
  const { router: _router, listening: _listening, machines: _machines, wecom: _wecom, ...offline } = setup(t).healthy;
  const checks = Object.fromEntries(doctor(offline).map((check) => [check.id, check]));
  assert.deepEqual([checks.router!.level, checks.router!.text], ['warn', '服务没有在运行，查不了']);
  assert.equal(checks['login:t1']!.level, 'warn');
  assert.equal(run({ router: { alive: false, error: null } }).router!.level, 'ok', '没有进程也没有原因：每个项目有消息时才起，空闲是常态');
  assert.ok(checks.wecom && checks.address);
});

test('WeCom is off, on and working, or on and unable to work, each with its reason', (t) => {
  const { run, set } = setup(t);
  assert.equal(run().wecom!.text, '已连接');
  const dropped = run({ wecom: { connected: false, error: '订阅失败：secret 不对' } }).wecom!;
  assert.equal(dropped.level, 'fail');
  assert.match(dropped.text, /没有连上：订阅失败：secret 不对/);
  assert.match(run({ wecom: { connected: false, error: null } }).wecom!.text, /正在重连/);
  const noSecret = run({ wecomSecretSet: false }).wecom!;
  assert.equal(noSecret.level, 'fail');
  assert.match(noSecret.text, /没有设置 Secret/);
  assert.ok(!JSON.stringify(run()).includes('secret":'), '自检不带任何密钥字段');
  set('wecom.botId', '');
  const off = run({ wecom: null }).wecom!;
  assert.equal(off.level, 'warn');
  assert.match(off.text, /没有启用/);
});

test('the address others are told has to reach what the service listens on', (t) => {
  const { run, set } = setup(t);
  const address = (changed: Partial<DoctorInput> = {}) => run(changed).address!;
  assert.equal(address().level, 'ok');
  set('http.publicUrl', 'http://10.0.0.5:8787');
  const loopback = address();
  assert.deepEqual([loopback.level, loopback.fix?.href], ['warn', '#/settings/http.host']);
  assert.match(loopback.text, /只监听 127\.0\.0\.1/);
  set('http.host', '0.0.0.0');
  assert.equal(address({ listening: { host: '0.0.0.0', port: 8787 } }).level, 'ok');
  set('http.publicUrl', 'http://10.0.0.5:9999');
  const port = address({ listening: { host: '0.0.0.0', port: 8787 } });
  assert.deepEqual([port.level, port.fix?.href], ['warn', '#/settings/http.publicUrl']);
  assert.match(port.text, /端口是 9999，服务监听的是 8787/);
  set('http.publicUrl', 'https://tycho.example');
  assert.match(address({ listening: { host: '0.0.0.0', port: 8787 } }).text, /端口是 443/);
  set('http.publicUrl', '');
  const none = address({ listening: { host: '0.0.0.0', port: 8787 } });
  assert.deepEqual([none.level, none.fix?.href], ['warn', '#/settings/http.publicUrl'], '企微启用着却没有对外地址');
  set('wecom.botId', '');
  assert.equal(address({ listening: { host: '0.0.0.0', port: 8787 } }).level, 'ok', '只在本机用，不需要对外地址');
});

test('the gateway line says what the connection is doing, with the reason ssh gave, and the address line whether a login from outside can work', (t) => {
  const { run, set, healthy } = setup(t);
  const off = run();
  assert.match(off.gateway!.text, /没有启用/);
  assert.equal(off['gateway-url'], undefined, '没有门牌就没有它的对外地址可查');

  set('gateway.ssh', 'deploy@door.example');
  set('http.publicUrl', 'https://tycho.example');
  const since = '2026-11-06T00:00:00.000Z';
  const up = run({ gateway: { state: 'connected', since, error: null } });
  assert.deepEqual([up.gateway!.level, up.gateway!.text, up.gateway!.fix], ['ok', '已连接 deploy@door.example', null]);
  assert.deepEqual([up['gateway-url']!.level, up['gateway-url']!.text, up['gateway-url']!.fix], ['ok', 'https://tycho.example', null]);
  // Reached through the gateway: what is listened on here does not have to match it.
  assert.deepEqual([up.address!.level, up.address!.text], ['ok', 'https://tycho.example（经门牌）']);

  const down = run({ gateway: { state: 'down', since, error: 'Warning: Permanently added door\nPermission denied (publickey).' } }).gateway!;
  assert.deepEqual([down.level, down.fix?.href], ['fail', '#/settings/gateway.ssh']);
  assert.equal(down.text, '连不上 deploy@door.example，会一直重试：Warning: Permanently added door；Permission denied (publickey).');
  const trying = run({ gateway: { state: 'connecting', since, error: null } }).gateway!;
  assert.deepEqual([trying.level, trying.text], ['warn', '正在连接 deploy@door.example']);
  // Trying again after a failure is the same answer as waiting to: the level must not flip
  // with the phase of the retry cycle the page happens to catch.
  const again = run({ gateway: { state: 'connecting', since, error: 'Connection refused' } }).gateway!;
  assert.deepEqual([again.level, again.text], ['fail', '连不上 deploy@door.example，会一直重试：Connection refused']);
  // A command line with no service running cannot know.
  assert.deepEqual(doctor(healthy).filter(({ id }) => id === 'gateway').map(({ level, text }) => [level, text]), [['warn', '服务没有在运行，查不了']]);

  set('http.publicUrl', 'http://tycho.example');
  const plain = run({ gateway: { state: 'connected', since, error: null } })['gateway-url']!;
  assert.deepEqual([plain.level, plain.fix?.href], ['fail', '#/settings/http.publicUrl']);
  assert.match(plain.text, /^对外地址 http:\/\/tycho\.example 不是 https/);
  set('http.publicUrl', '');
  const none = run({ gateway: { state: 'connected', since, error: null } })['gateway-url']!;
  assert.deepEqual([none.level, none.fix?.href], ['fail', '#/settings/http.publicUrl']);
  assert.match(none.text, /没有填对外地址：从门牌进来的人登录不了，也做不了任何操作/);
});

test('a listening address changed in the settings and not yet in force is said to wait for a restart', (t) => {
  const { run, set } = setup(t);
  set('http.port', 9000);
  const pending = run().address!;
  assert.deepEqual([pending.level, pending.fix?.href], ['warn', '#/settings/http.port']);
  assert.match(pending.text, /现在监听的是 127\.0\.0\.1:8787，设置里已改成 127\.0\.0\.1:9000，重启服务后才生效/);
  assert.equal(run({ listening: { host: '127.0.0.1', port: 9000 } }).address!.level, 'warn', '端口对上了，对外地址还指着旧端口');
});

test('the Node check compares the whole version with what package.json asks for, not the major alone', (t) => {
  const { run } = setup(t);
  // 24.2.0 passes a check of the major version, and the entry points do nothing on it.
  assert.equal(run({ nodeVersion: 'v24.2.0' }).node!.level, 'fail');
  assert.match(run({ nodeVersion: 'v24.2.0' }).node!.text, /需要 24\.3\.0 或更新的版本/);
  assert.equal(run({ nodeVersion: 'v24.3.0' }).node!.level, 'ok');
  assert.equal(run({ nodeVersion: 'v25.0.0' }).node!.level, 'ok');
});

test('the gateway address check uses the parsed protocol, so uppercase HTTPS works', (t) => {
  const { run, set } = setup(t);
  set('gateway.ssh', 'deploy@door.example');
  set('http.publicUrl', 'HTTPS://tycho.example');
  assert.equal(run()['gateway-url']!.level, 'ok');
});

// Shared hosts do not share account readiness or quota identity.
test('two logins on the same machine use their own observations', (t) => {
  const { run } = setup(t);
  const checks = run({ logins: [{ id: 't1', name: 't1' }, { id: 'h1/claude', name: 'h1/claude' }], machines: [fact('h1', true, 't1'), fact('h1', false, 'h1/claude')] });
  assert.deepEqual([checks['login:t1']!.level, checks['login:t1']!.text], ['ok', '1/1 台连得上']);
  assert.equal(checks['login:h1/claude']!.level, 'fail');
  assert.match(checks['login:h1/claude']!.text, /1 台机器都连不上/);
});

