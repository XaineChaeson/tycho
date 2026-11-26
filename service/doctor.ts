// The self-check: what stands between this installation and working, one line each, with
// where to put it right. A function of facts handed in, with no HTTP and no ledger of
// its own, so the console and a command line ask the same questions. A fact that only a
// running service has (the Router process, what the Runner has learned about machines,
// the WeCom connection) may be absent, and its check then says so instead of guessing.
import { accessSync, constants } from 'node:fs';
import { missingLoginText } from '../shared/labels.ts';
import { expiryDay } from '../shared/credential.ts';
import { HOST_MACHINE_UNKNOWN_TEXT, loginName as loginLabel, loginPage, type LoginDisplay, type RetiredTier } from '../shared/logins.ts';
import { join } from 'node:path';
import { nodeIsEnough, requiredNode } from '../cli/paths.ts';
import type { MachineFact } from '../runner/runner.ts';
import type { Tier } from '../adapters/types.ts';
import type { ClaudeInspection } from './claude-cli.ts';
import type { GatewayStatus } from './gateway.ts';
import type { RouterLaunch } from './session-host.ts';
import { LOOPBACK, WILDCARD } from './settings.ts';
import type { Settings } from './settings.ts';
import { keyAccess } from './ssh-key.ts';

export type Level = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  level: Level;
  title: string;
  // One sentence: what is, and when something is wrong, what to do.
  text: string;
  // Where in the console to put it right; null when the answer is not in the console.
  fix: { label: string; href: string } | null;
}

export interface DoctorInput {
  nodeVersion?: string;
  dataDir: string;
  settings: Pick<Settings, 'get'>;
  claude: ClaudeInspection;
  // Every login a round can run as: the accounts and the machines' own logins, with the tiers
  // each holds in a shape no round can be given.
  logins: { id: string; name: string; machine?: string; executor?: string; retiredTiers?: RetiredTier[]; credential?: 'set' | 'rejected' | 'missing' }[];
  // The login the next start of the Router would use, resolved by the caller from the
  // account it is bound to: an account name, or empty for this machine's own login.
  routerLogin?: RouterLogin;
  // Accounts whose token is expected to run out inside the owner's reminder window, or already
  // has (docs/design/native-login.md §2). One derivation, handed in as the ledger read it:
  // `credentialAt` says which credential the estimate is about, so this check's line changes
  // when the token does, and an account past its estimate is a different line again.
  expiringLogins?: { id: string; name: string; expected: string; expired: boolean; credentialAt: string }[];
  // Projects whose effective pool of logins is empty, as the ledger's own derivation read it
  // (docs/design/project-sessions.md §5): their work has nowhere to run.
  projectsWithoutLogins?: { id: string; name: string; reason: string }[];
  wecomSecretSet: boolean;
  // The three below come from a running service. `launched` is what the Router process
  // was started with: when it is there, `claude` is about that one, and otherwise about
  // what the next start would take.
  router?: { alive: boolean; error: string | null; launched?: RouterLaunch | null };
  listening?: { host: string; port: number; reverseProxyPort?: number };
  machines?: MachineFact[];
  // Logins that unfinished executions name and the ledger never held.
  missingLogins?: string[];
  // Null means the running host cannot identify its own current machine registration.
  hostMachine?: string | null;
  wecom?: { connected: boolean; error: string | null } | null;
  // The connection to the gateway as the running service keeps it.
  gateway?: GatewayStatus;
  // How this machine's answer about a private key's permissions is read. The self-check
  // reads it itself; a caller that already knows hands it in instead.
  keyAccess?: typeof keyAccess;
}

const setting = (key: string, label = '去设置'): DoctorCheck['fix'] => ({ label, href: `#/settings/${key}` });
const ACCOUNTS: DoctorCheck['fix'] = { label: '去账号页', href: '#/accounts' };
const MACHINES: DoctorCheck['fix'] = { label: '去机器页', href: '#/machines' };
// Where a login is put right, and what that page is called in a sentence: an account on the
// accounts page, a machine's own login on that machine's row of the machines page. The id
// says which it is (shared/logins.ts).
const loginPlace = (login: LoginDisplay): { fix: DoctorCheck['fix']; page: string } =>
  loginPage(login).path === '/accounts' ? { fix: ACCOUNTS, page: '账号页' } : { fix: MACHINES, page: '机器页' };
const LOOPBACK_NAMES = new Set([LOOPBACK, 'localhost', '[::1]']);

// Against what this program's package.json asks for: the one place the minimum is written.
function nodeCheck(version: string): DoctorCheck {
  const required = requiredNode(join(import.meta.dirname, '..'));
  const ok = nodeIsEnough(version, required);
  return {
    id: 'node', level: ok ? 'ok' : 'fail', title: 'Node 版本', fix: null,
    text: ok ? `Node ${version}` : `Node ${version} 太旧，需要 ${required} 或更新的版本`,
  };
}

function dataDirCheck(dataDir: string): DoctorCheck {
  const base = { id: 'data-dir', title: '数据目录', fix: null };
  try {
    accessSync(dataDir, constants.R_OK | constants.W_OK);
    return { ...base, level: 'ok', text: dataDir };
  } catch (err) {
    return { ...base, level: 'fail', text: `数据目录 ${dataDir} 不能读写：${(err as NodeJS.ErrnoException).code ?? String(err)}。让运行服务的用户能读写它` };
  }
}

const MACHINE_LOGIN = '这台电脑已有的登录';

// Which login a check is about: the bound account's when there is one, this machine's
// own otherwise.
interface RouterLogin {
  executor?: string;
  account: string;
  codexHealth?: Pick<DoctorCheck, 'level' | 'text'>;
  geminiHealth?: Pick<DoctorCheck, 'level' | 'text'>;
  // The account holds a login token: that token is what the Router signs in with. Without
  // one it is this computer's own login.
  token: boolean;
  // Why the binding the settings name cannot be started, in the owner's words, or null when
  // it can. Present: the login line is that reason, and this computer's own login is not
  // asked about — it would call a binding that cannot start fine.
  problem?: string | null;
}

const loginWhere = ({ account, token }: RouterLogin): string => {
  if (account === '') return MACHINE_LOGIN;
  return token ? `账号 ${account} 的令牌` : `账号 ${account} 的登录（用${MACHINE_LOGIN}）`;
};

// What a Router process was started with, as the login it holds.
const launchedLogin = (launched: RouterLaunch): RouterLogin => ({
  account: launched.accountName ?? launched.account ?? '',
  // The number of the token it was started with: a process holding the account's token
  // signs in with that, not with whatever login this machine has.
  token: launched.credentialRef !== undefined,
});

// Which login a check asked about. A login saved since the Router started is not the one
// it runs on, and a check of it says nothing about the messages being handled.
// With no process, or one whose own credential the ledger has replaced since it started,
// the answer is about the next start, and only that one is claimed.
const loginAsked = (launched: RouterLaunch | null | undefined, saved: RouterLogin, ofNextStart = false): string => {
  if (launched && ofNextStart) {
    return `负责人正在用的那份登录账本里已经换掉了，它现在还能不能用查不出来；查的是负责人下次启动会用的那一份：${loginWhere(saved)}`;
  }
  return launched
    ? `查的是负责人正在用的那一份：${loginWhere(launchedLogin(launched))}`
    : `查的是负责人下次启动会用的那一份：${loginWhere(saved)}`;
};

const NO_MACHINE_LOGIN_FIX = `在这台电脑上以运行服务的用户运行 claude 完成登录，或在设置里绑定一个账号，然后重启负责人`;
const ACCOUNT_LOGIN_FIX = (account: string): string =>
  `到账号页给账号 ${account} 点“重新登录”，或在设置里改绑另一个账号，然后重启负责人`;

function claudeChecks({ claude: { path, problem, settingGone, login, loginOfNextStart }, router, settings, routerLogin }: DoctorInput): DoctorCheck[] {
  if (routerLogin?.executor === 'codex') {
    const reason = routerLogin.problem;
    const health = reason ? { level: 'fail' as const, text: reason } : routerLogin.codexHealth ??
      { level: 'warn' as const, text: '尚未核对 Codex 命令和登录' };
    return [{ id: 'codex-router', title: '负责人的 Codex', ...health, fix: health.level === 'fail' ? setting('router.account') : null }];
  }
  if (routerLogin?.executor === 'gemini') {
    const reason = routerLogin.problem;
    const health = reason ? { level: 'fail' as const, text: reason } : routerLogin.geminiHealth ??
      { level: 'warn' as const, text: '尚未核对 Gemini 命令和登录' };
    return [{ id: 'gemini-router', title: '负责人的 Gemini', ...health, fix: health.level === 'fail' ? setting('router.account') : null }];
  }
  const cli: DoctorCheck = problem
    ? { id: 'claude-cli', level: 'fail', title: 'Claude Code', text: `${problem}。负责人靠它运行：装好 Claude Code，或填上它的路径`, fix: setting('router.cli') }
    : settingGone === undefined
      ? { id: 'claude-cli', level: 'ok', title: 'Claude Code', text: path!, fix: null }
      // What the setting names is not there and another one was taken: the Router runs,
      // and the setting is said to be what it is.
      : { id: 'claude-cli', level: 'warn', title: 'Claude Code', text: `设置里填的 ${settingGone} 不存在，改用 ${path}`, fix: setting('router.cli') };
  const base = { id: 'claude-login', title: '负责人的 Claude 登录' };
  // What the settings bind cannot be started at all: the reason is the whole answer, and the
  // check does not go looking for another login to call fine (docs/design/native-login.md §2).
  const saved = routerLogin ?? { account: '', token: false };
  if (saved.problem) return [cli, { ...base, level: 'fail', fix: setting('router.account'), text: saved.problem }];
  if (!login) return [cli, { ...base, level: 'warn', text: '找到 Claude Code 之后才能检查登录', fix: null }];
  const asked = loginAsked(router?.launched, saved, loginOfNextStart);
  if (login.loggedIn === true) return [cli, { ...base, level: 'ok', text: `已登录${login.detail ? `（${login.detail}）` : ''}。${asked}`, fix: null }];
  if (login.loggedIn === false) {
    return [cli, {
      ...base, level: 'fail', fix: setting('router.account'),
      text: `没有登录。${asked}。${saved.account ? ACCOUNT_LOGIN_FIX(saved.account) : NO_MACHINE_LOGIN_FIX}`,
    }];
  }
  return [cli, { ...base, level: 'warn', text: `查不出登录状态：${login.detail}。${asked}`, fix: null }];
}

// A login whose token is expected to run out soon, or already has (docs/design/native-login.md
// §2, rulings J and L): the account, the day, and the accounts page where it is signed in
// again. One line per account; an estimate already past says it may be gone.
function expiryChecks(expiring: DoctorInput['expiringLogins']): DoctorCheck[] {
  return (expiring ?? []).map(({ id, name, expected, expired, credentialAt }) => ({
    // The credential and the state are in the id: the home page keeps a dismissed check's id,
    // and a token stored again (or an estimate that has since passed) is another thing to say.
    id: `login-expiry:${id}:${credentialAt}:${expired ? 'past' : 'soon'}`, level: 'warn', title: `账号 ${name} 的登录预计到期`, fix: ACCOUNTS,
    text: expired
      ? `账号 ${name} 的登录可能已经失效：预计到期 ${expiryDay(expected)}。到账号页重新登录`
      : `账号 ${name} 的登录预计 ${expiryDay(expected)} 到期，到期后它就跑不了了。到账号页重新登录`,
  }));
}

// Projects with no login to run as: the overview lists the same projects from the same
// derivation, and each line points at its own settings page (docs/design/project-sessions.md §5).
function projectLoginChecks(projects: DoctorInput['projectsWithoutLogins']): DoctorCheck[] {
  return (projects ?? []).map(({ id, name, reason }) => ({
    id: `project-no-login:${id}`, level: 'warn', title: `项目 ${name} 没有可用的登录`,
    text: `${reason}。它的任务派不出去：到项目页重新选允许的登录`,
    fix: { label: '去项目设置', href: `#/projects/${id}/settings` },
  }));
}

function routerCheck(router: DoctorInput['router']): DoctorCheck {
  const base = { id: 'router', title: '负责人进程' };
  if (!router) return { ...base, level: 'warn', text: '服务没有在运行，查不了', fix: null };
  if (router.error) return { ...base, level: 'fail', text: `负责人已停摆：${router.error}`, fix: setting('router.cli', '去设置里重启负责人') };
  if (router.alive) return { ...base, level: 'ok', text: '在运行', fix: null };
  // Each project's Router starts with its project's message and exits when idle
  // (docs/design/project-sessions.md §3): none running is the ordinary state.
  return { ...base, level: 'ok', text: '空闲：哪个项目有消息就起哪个项目的负责人', fix: null };
}

function loginChecks(logins: DoctorInput['logins'], machines: MachineFact[] | undefined, missing: string[] = []): DoctorCheck[] {
  // Executions the ledger holds for a login it never held: left unknown, and said so.
  const unknown = missing.map((id): DoctorCheck => ({
    id: `login-missing:${id}`, level: 'fail', title: loginLabel(id), text: missingLoginText(id), fix: loginPlace(id).fix,
  }));
  if (logins.length === 0) {
    // Two ways to get a login, on two pages: each line carries the page that puts it right.
    return [
      { id: 'logins-account', level: 'fail', title: '账号', text: '还没有能用的登录，任务派不出去。到账号页添加一个账号', fix: ACCOUNTS },
      { id: 'logins-machine', level: 'fail', title: '机器上的登录', text: '机器自己的登录也一个都没有：机器报告已登录的执行器会自动成为登录，不用你登记；一台都没有时，到机器页看那台机器上的执行器登录了没有', fix: MACHINES },
      ...unknown,
    ];
  }
  const count: DoctorCheck = { id: 'logins', level: 'ok', title: '登录', text: `${logins.length} 个`, fix: null };
  // A tier left in a shape no round can be given: the same words the login's page shows.
  const retired = logins.flatMap((login): DoctorCheck[] => (login.retiredTiers?.length
    ? [{ id: `login-retired:${login.id}`, level: 'warn', title: `${loginLabel(login)} 的档位`, text: login.retiredTiers.map(({ text }) => text).join('；'), fix: loginPlace(login).fix }]
    : []));
  const credentials = logins.flatMap((login): DoctorCheck[] => login.credential === 'missing'
    ? [{ id: `login-credential:${login.id}`, level: 'fail', title: `${loginLabel(login)} 的凭据`, text: '凭据缺失，到账号页重新登录或更换密钥', fix: ACCOUNTS }] : []);
  return [count, ...unknown, ...retired, ...credentials, ...logins.map((login): DoctorCheck => {
    const { id } = login;
    const { fix, page } = loginPlace(login);
    const base = { id: `login:${id}`, title: `${loginLabel(login)} 的机器` };
    const facts = (machines ?? []).filter((fact) => fact.login_id === id);
    if (facts.some(({ up }) => up === true)) return { ...base, level: 'ok', text: `${facts.filter(({ up }) => up).length}/${facts.length} 台连得上`, fix: null };
    if (!machines || facts.every(({ up }) => up === null)) {
      return { ...base, level: 'warn', text: `还没有连过它能用的机器。到${page}点“测试连接”`, fix };
    }
    return { ...base, level: 'fail', text: `${facts.length} 台机器都连不上。到${page}点“测试连接”看原因`, fix };
  })];
}

function wecomCheck({ settings, wecomSecretSet, wecom }: DoctorInput): DoctorCheck {
  const base = { id: 'wecom', title: '企业微信' };
  if (settings.get('wecom.botId') === '') {
    return { ...base, level: 'warn', text: '没有启用：手机上收不到通知，也不能在企业微信里指挥。要用就填上 Secret、接收人和 Bot ID', fix: setting('wecom.botId') };
  }
  if (!wecomSecretSet) return { ...base, level: 'fail', text: '启用了，但没有设置 Secret，连不上', fix: setting('wecom.botId') };
  if (settings.get('wecom.owner') === '') return { ...base, level: 'fail', text: '启用了，但没有填接收人，通知不知道发给谁', fix: setting('wecom.owner') };
  if (wecom === undefined) return { ...base, level: 'ok', text: '已启用', fix: null };
  if (wecom?.connected) return { ...base, level: 'ok', text: '已连接', fix: null };
  return { ...base, level: 'fail', text: `已启用，但没有连上${wecom?.error ? `：${wecom.error}` : '，正在重连'}`, fix: setting('wecom.botId') };
}

function backupCheck(settings: DoctorInput['settings']): DoctorCheck {
  const dir = settings.get('backup.dir');
  return dir === ''
    ? { id: 'backup', level: 'warn', title: '自动备份', text: '没有配置：这台电脑的盘坏了，账本就没了。填一个备份目录，最好在另一块盘上', fix: setting('backup.dir') }
    : { id: 'backup', level: 'ok', title: '自动备份', text: `每天 ${settings.get('backup.at')} 备份到 ${dir}`, fix: null };
}

// Whether the address others are told to use can reach what the service listens on, and
// whether what it listens on is what the settings say.
function addressCheck({ settings, listening }: DoctorInput): DoctorCheck {
  const base = { id: 'address', title: '访问地址' };
  const host = listening?.host ?? settings.get('http.host');
  const port = listening?.port ?? settings.get('http.port');
  if (listening && (listening.host !== settings.get('http.host') || listening.port !== settings.get('http.port'))) {
    return {
      ...base, level: 'warn', fix: setting('http.port'),
      text: `现在监听的是 ${listening.host}:${listening.port}，设置里已改成 ${settings.get('http.host')}:${settings.get('http.port')}，重启服务后才生效`,
    };
  }
  const publicUrl = settings.get('http.publicUrl');
  const proxyPort = settings.get('http.reverseProxyPort');
  if (listening && proxyPort !== (listening.reverseProxyPort ?? 0)) {
    return { ...base, level: 'warn', fix: setting('http.reverseProxyPort'), text: '反向代理入口端口已改，重启服务后才生效' };
  }
  if (listening?.reverseProxyPort) {
    if (!publicUrl || new URL(publicUrl).protocol !== 'https:') {
      return { ...base, level: 'fail', fix: setting('http.publicUrl'), text: '反向代理入口需要 HTTPS 对外地址' };
    }
    return { ...base, level: 'ok', fix: null, text: `${publicUrl} 由反向代理转发到回环端口 ${listening.reverseProxyPort}` };
  }
  if (publicUrl === '') {
    return settings.get('wecom.botId') === ''
      ? { ...base, level: 'ok', text: `只在这台电脑上用：http://${LOOPBACK}:${port}`, fix: null }
      : { ...base, level: 'warn', text: '没有填对外地址：企业微信里发出的登录链接和通知里的链接，手机上打不开', fix: setting('http.publicUrl') };
  }
  // Through the gateway the address is the gateway's own, whatever is listened on here.
  if (settings.get('gateway.ssh') !== '') return { ...base, level: 'ok', text: `${publicUrl}（经门牌）`, fix: null };
  const url = new URL(publicUrl);
  if (host !== WILDCARD && !LOOPBACK_NAMES.has(url.hostname)) {
    return {
      ...base, level: 'warn', fix: setting('http.host'),
      text: `对外地址是 ${publicUrl}，但服务只监听 ${host}，别的设备连不上。把监听地址改成 ${WILDCARD} 并重启服务；中间有反向代理的话可以不管`,
    };
  }
  const urlPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (urlPort !== port) {
    return {
      ...base, level: 'warn', fix: setting('http.publicUrl'),
      text: `对外地址的端口是 ${urlPort}，服务监听的是 ${port}。中间有反向代理或端口转发的话可以不管，否则把两边改成一样`,
    };
  }
  return { ...base, level: 'ok', text: publicUrl, fix: null };
}

// The private key the gateway signs in with: ssh refuses one others can read, and says so
// only in the connection's own words. Checked here so that the owner is told before that,
// with the command that would put it right. Nothing is changed: the file is the owner's.
function gatewayKeyCheck({ settings, dataDir, keyAccess: read = keyAccess }: DoctorInput): DoctorCheck[] {
  const file = settings.get('gateway.keyFile');
  // Nothing named: ssh uses the user's own configuration and keys, which are its business.
  if (file === '') return [];
  const base = { id: 'gateway-key', title: '门牌的私钥', fix: setting('gateway.keyFile') };
  const access = read(file, dataDir);
  switch (access.kind) {
    case 'ok':
      return [{ ...base, level: 'ok', text: `只有运行服务的这个用户和系统账号能读：${file}`, fix: null }];
    case 'missing':
      return [{ ...base, level: 'fail', text: `设置里填的私钥文件不存在：${file}。ssh 拿不到它，就登录不了门牌` }];
    case 'unknown':
      return [{ ...base, level: 'warn', text: `查不了它的权限：${access.reason}。以运行服务的这个用户查一下它谁能读` }];
    case 'open':
      return [{
        ...base, level: 'fail',
        text: `别的账号也能读它：${access.others.join('、')}。ssh 会因此拒绝用这个私钥；以运行服务的用户运行 ${access.tighten}`
          + `（列出来的账号如果还在，再逐个运行 icacls "${file}" /remove:g "<账号>"）`,
      }];
  }
}

// The gateway: whether the connection to it stands, whether the private key it signs in
// with is one ssh will accept, and whether the address it serves the pages at is one a
// login from outside can work with. Nothing to check while there is none.
function gatewayChecks(input: DoctorInput): DoctorCheck[] {
  const { settings, gateway } = input;
  const base = { id: 'gateway', title: '门牌' };
  const account = settings.get('gateway.ssh');
  if (account === '') return [{
    ...base, level: 'ok',
    text: input.listening?.reverseProxyPort ? '没有启用：对外入口由反向代理提供' : '没有启用：只有这台电脑，以及它所在的局域网或组网里的设备，能打开控制台',
    fix: null,
  }];
  const key = gatewayKeyCheck(input);
  const why = gateway?.error ? gateway.error.replaceAll('\n', '；') : '';
  const fix = setting('gateway.ssh');
  // One answer for the whole retry cycle: after a failed attempt the connection is 'down'
  // while it waits and 'connecting' while it tries again, and the owner reading the page
  // mid-cycle must see the same thing either way. 'connecting' with no error yet is the
  // first attempt, which has nothing to report.
  const link: DoctorCheck = !gateway
    ? { ...base, level: 'warn', text: '服务没有在运行，查不了', fix: null }
    : gateway.state === 'connected'
      ? { ...base, level: 'ok', text: `已连接 ${account}`, fix: null }
      : gateway.state === 'down' || why !== ''
        ? { ...base, level: 'fail', text: `连不上 ${account}，会一直重试：${why}`, fix }
        : { ...base, level: 'warn', text: `正在连接 ${account}`, fix };

  const address = { id: 'gateway-url', title: '门牌的对外地址', fix: setting('http.publicUrl') };
  const publicUrl = settings.get('http.publicUrl');
  if (publicUrl === '') {
    return [link, ...key, { ...address, level: 'fail', text: '没有填对外地址：从门牌进来的人登录不了，也做不了任何操作。填上门牌的 https 地址' }];
  }
  if (new URL(publicUrl).protocol !== 'https:') {
    return [link, ...key, { ...address, level: 'fail', text: `对外地址 ${publicUrl} 不是 https：从门牌登录用的 Cookie 只在 https 下有效，浏览器不会带上它。填门牌的 https 地址` }];
  }
  return [link, ...key, { ...address, level: 'ok', text: publicUrl, fix: null }];
}

// What a Router process is, or would be, started with. An empty account is this
// computer's own login; no tier, the executor's own default tier.
export interface RouterSetup {
  executor?: string;
  // Null when no Claude Code is named and none is on PATH.
  cli: string | null;
  // The account the Router is bound to, empty when it is bound to none.
  account: string;
  // The bound account holds a login token: the Router is started with it.
  token: boolean;
  // The value of the tier the settings name, as the account held it, or null when none is
  // named. A content tier is shown as text, not as the file the service writes it to.
  tier: Tier | null;
}

const NO_CLI = '在 PATH 里找不到 claude';
const NO_ACCOUNT = '没有绑定账号，用这台电脑已有的登录和默认档位';
const NO_TIER = '没有指定，用 Claude Code 自己的默认档位';

const tierShown = (tier: Tier | null, executor?: string): string => (
  tier === null
    ? (executor === 'codex' ? '没有指定，用 Codex 的默认档位' : executor === 'gemini' ? '没有指定，用 Gemini 的默认档位' : NO_TIER)
    : `账号里的档位内容（${tier.text.length} 字）`
);

const cliNameOf = (executor?: string): string => (executor === 'codex' ? 'Codex' : executor === 'gemini' ? 'Gemini (agy)' : 'Claude Code');
const cliMissingOf = (executor?: string): string => (executor === 'codex' ? '找不到 codex' : executor === 'gemini' ? '找不到 agy' : NO_CLI);
const loginLabelOf = (executor?: string): string => (executor === 'codex' ? 'Codex' : executor === 'gemini' ? 'Gemini' : 'Claude');

// What the settings page shows as read-only: where the data is, what the service really
// listens on, and which Claude Code the Router runs, signed in or not. Paths, addresses
// and an account name; never a token. `launched` is what the Router process was started
// with, null while there is none: with a process the facts are its own, and what `saved`
// says differently is listed apart as waiting for a restart; without one they are
// `saved`, said to be what the next start takes. `claude` is about whichever is shown.
export function deploymentFacts(facts: Pick<DoctorInput, 'dataDir' | 'claude'> & {
  listening: { host: string; port: number };
  launched: RouterLaunch | null;
  saved: RouterSetup;
}): { title: string; value: string }[] {
  const { dataDir, listening, claude, launched, saved } = facts;
  const shown: RouterSetup = launched
    ? {
        executor: launched.executor,
        cli: launched.path ?? launched.claude.join(' '),
        account: launched.accountName ?? launched.account ?? '',
        token: launched.credentialRef !== undefined,
        tier: launched.tier ?? null,
      }
    : saved;
  const which = launched ? '负责人正在用的' : '负责人下次启动会用的';
  const exec = shown.executor ?? 'claude';
  const savedExec = saved.executor ?? 'claude';
  const bridged = exec === 'codex' || exec === 'gemini';
  const pending = [
    (savedExec !== exec || saved.cli !== shown.cli) && `${cliNameOf(savedExec)}：${saved.cli ?? cliMissingOf(savedExec)}`,
    saved.account !== shown.account && `账号：${saved.account || NO_ACCOUNT}`,
    JSON.stringify(saved.tier) !== JSON.stringify(shown.tier) && `档位：${tierShown(saved.tier, savedExec)}`,
  ].filter((line) => line !== false);
  const login = bridged ? '登录与工具权限在处理消息时核验' : !claude.login
    ? '查不了：没有可用的 Claude Code'
    : `${claude.login.loggedIn === true
      ? `已登录${claude.login.detail ? `（${claude.login.detail}）` : ''}`
      : claude.login.loggedIn === false ? '没有登录' : `查不出：${claude.login.detail}`}。${loginAsked(launched, saved, claude.loginOfNextStart)}`;
  // What the setting names is said to be gone here too: the file shown is the one the
  // search took in its place, or the one the running process was started from. With
  // nothing found at all, the reason already says it.
  const namedGone = claude.settingGone === undefined || claude.problem !== null ? '' : `（设置里填的 ${claude.settingGone} 不存在）`;
  const cliShown = `${launched ? shown.cli! : claude.problem ?? shown.cli ?? cliMissingOf(exec)}${namedGone}`;
  return [
    { title: '数据目录', value: dataDir },
    { title: '实际监听地址', value: `${listening.host}:${listening.port}` },
    { title: `${which} ${cliNameOf(exec)}`, value: cliShown },
    { title: `${which}账号`, value: shown.account || NO_ACCOUNT },
    { title: `${which}档位`, value: tierShown(shown.tier, exec) },
    ...(pending.length > 0 ? [{ title: '已保存，重启负责人后生效', value: pending.join('；') }] : []),
    { title: `负责人的 ${loginLabelOf(exec)} 登录`, value: login },
  ];
}

export function doctor(input: DoctorInput): DoctorCheck[] {
  return [
    nodeCheck(input.nodeVersion ?? process.version),
    dataDirCheck(input.dataDir),
    ...claudeChecks(input),
    routerCheck(input.router),
    ...(input.hostMachine === null ? [{ id: 'host-machine', level: 'warn' as const, title: '主机的机器登记', text: HOST_MACHINE_UNKNOWN_TEXT, fix: MACHINES }] : []),
    ...loginChecks(input.logins, input.machines, input.missingLogins),
    ...projectLoginChecks(input.projectsWithoutLogins),
    ...expiryChecks(input.expiringLogins),
    wecomCheck(input),
    backupCheck(input.settings),
    addressCheck(input),
    ...gatewayChecks(input),
  ];
}
