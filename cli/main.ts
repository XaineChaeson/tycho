// The `tycho` command. Exit codes: 0 done, 2 the command line was wrong, 1 anything else.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { dataDirOf, lockFile } from '../service/config.ts';
import { InputError } from '../service/errors.ts';
import { startedAs } from '../service/entry.ts';
import { elsewhereText } from '../service/lock.ts';
import type { Holder } from '../service/lock.ts';
import { AUTOSTART_ENV, autostartFor, autostartOutput } from './autostart.ts';
import type { ServiceSpec } from './autostart.ts';
import { doctor } from './doctor.ts';
import { observeServices } from './service-observation.ts';
import { serviceObservationText } from '../shared/service-manager.ts';
import { installedSpec, installSelf, rememberAutostart, serviceSpec, terminalPath, uninstall, update, within, withPrefixLock } from './install.ts';
import { nodeCommand, readClientHolder } from '../node/cli.ts';
import { identityOf, readToken, requestClientStop } from '../node/client.ts';
import type { NodeIdentity } from '../node/client.ts';
import { isVersion, nodeIsEnough, prefixOf, requiredNode, shownVersion } from './paths.ts';
import { readRecord, slotOf } from './record.ts';
import type { Running, ServiceState } from './service-client.ts';
import { consoleUrl, loginLink, requestStop, serviceState, stopService, waitRunning } from './service-client.ts';
import type { Cli } from './system.ts';
import { knowledgeMcpMain } from '../service/knowledge-mcp.ts';
import { projectHomeCommand } from './project-home.ts';
import { projectDirectoryCommand } from './project-directory.ts';
import { realSystem } from './system.ts';

// One file is kept beside the live one.
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const MAX_PORT = 65_535;

const HELP = `tycho：个人工作流编排服务

用法：
  tycho run [--open] [--port <端口>]
                             前台运行服务（不带子命令也是它）；--open 顺便在浏览器里打开控制台；
                             --port 只对这一次运行换一个端口
  tycho open [--print]       给运行中的服务取一条登录链接，并在浏览器里打开；--print 只打印链接
  tycho stop                 停止运行中的服务
  tycho status               服务在不在跑、装的和在跑的版本、数据目录、开机自启装没装
  tycho service install      装成开机自启：你登录后自动运行
  tycho service uninstall    卸掉开机自启
  tycho service start        让开机自启的那个服务现在就启动
  tycho service stop         停止服务（同 tycho stop）
  tycho service status [--json]
                             开机自启与系统服务运行状态；--json 只读结构化输出
  tycho doctor [--fix]       自检；--fix 修掉安装器自己写的、已经过期的东西
  tycho update [--to <版本> | --from <发布包或解开的目录>]
                             默认用本机 gh 登录取稳定发行版；--to 可选预发行版
  tycho restore --from <备份文件或目录>
                             用备份恢复账本（先停服务）
  tycho node <join|run|status|leave|service>
                             把这台机器接到主机上（机器主动连回来）；子命令的说明见 tycho node help
                             装了之后 tycho node service install 让它开机登录后自动连回来
  tycho knowledge-mcp [--node] [--url <地址>]
                             知识 MCP（stdio），给 Claude Code、Codex、dsh、Gemini（agy）挂上；令牌放环境变量
                             TYCHO_KNOWLEDGE_TOKEN。--node 经这台机器接入主机的通道去连
  tycho project-home help    查看环境身份与离线项目移交命令
  tycho project-directory help  管理可直接访问的其他 Tycho 环境
  tycho uninstall            卸载程序，不删数据
  tycho version              版本号
  tycho help                 这段说明

数据目录：环境变量 TYCHO_DATA；没设就是主目录下的 .tycho/host。`;

class UsageError extends Error {}

// `flags` names each option and whether it takes a value.
function parse(args: string[], flags: Record<string, boolean> = {}): Record<string, string | true | undefined> {
  const values: Record<string, string | true> = {};
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (!arg.startsWith('--')) throw new UsageError(`多了一个参数：${arg}`);
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (!Object.hasOwn(flags, name)) throw new UsageError(`不认识的选项：--${name}`);
    if (!flags[name]) {
      if (equals !== -1) throw new UsageError(`--${name} 不带值`);
      values[name] = true;
      continue;
    }
    const value = equals === -1 ? args[(at += 1)] : arg.slice(equals + 1);
    if (value === undefined || value === '') throw new UsageError(`--${name} 后面要跟一个值`);
    values[name] = value;
  }
  return values;
}

// Absolute from here on: a service manager starts the service somewhere else.
const dataDirFor = (cli: Cli): string => dataDirOf(cli.system.env, cli.system.home);

// A holder on another machine is not a local process that will end on its own: the way
// out of that lock is said once, in service/lock.ts.
type Held = Extract<ServiceState, { state: 'held' }>;

const heldBy = (dataDir: string, { pid, elsewhere }: Held): string =>
  elsewhere === undefined
    ? `数据目录 ${dataDir} 正被进程 ${pid} 占着，而它没有回答自己是运行中的服务：可能是服务正在启动，或者正在恢复备份。等它结束再试。`
    : `数据目录 ${dataDir} 的锁在另一台机器上，本机接管不了。${elsewhereText(lockFile(dataDir), elsewhere)}`;

function openBrowser(cli: Cli, url: string): void {
  const { system } = cli;
  // Each takes the link as an argument of its own.
  const problem = system.platform === 'win32'
    ? system.launch(join(system.env.SystemRoot ?? 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url])
    : system.launch(system.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  cli.out(problem === null ? '已请浏览器打开它；没有弹出来就手动打开上面的链接。' : `浏览器没打开（${problem}）：手动打开上面的链接。`);
}

// False when no link could be had, which has been said. `service` is a service a service
// manager pulled up, where nobody is reading this output: what is printed there outlives
// its use, so no link is made for it.
type Announce = 'show' | 'open' | 'print' | 'service';

async function announce(cli: Cli, dataDir: string, running: Running, how: Announce): Promise<boolean> {
  if (how !== 'print') cli.out(`控制台：${consoleUrl(running.port)}`);
  if (how === 'service') {
    // The one printed line that does not belong here: a link left in a service log, or in
    // a task's console, is readable by whoever gets to it long after it was made.
    cli.out('这是开机自启启动的服务，不在这里打印登录链接：要用就运行 tycho open。');
    return true;
  }
  try {
    const link = await loginLink(dataDir, running);
    if (how === 'print') {
      if (!link.external) cli.out(link.local);
      else {
        cli.out(`在外面用：${link.url}`);
        cli.out(`在这台电脑上，或经 SSH 转发端口后用：${link.local}（两条链接共用一次性凭据，用掉一条，另一条也失效）`);
      }
      return true;
    }
    cli.out(`登录链接（只能用一次）：${link.local}`);
    if (how === 'open') openBrowser(cli, link.local);
    return true;
  } catch (err) {
    cli.err(`没取到登录链接：${(err as Error).message}`);
    return false;
  }
}

// Written by this process, so the file can be turned over while the service runs. Nothing
// here may take the service down: a log that cannot be written or rotated is output
// lost, no more.
function logWriter(file: string): { write(chunk: Buffer): void; close(): void } {
  mkdirSync(dirname(file), { recursive: true });
  let fd: number | undefined;
  let size = 0;
  const open = (): void => {
    fd = openSync(file, 'a');
    size = fstatSync(fd).size;
  };
  const close = (): void => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
  };
  open();
  return {
    write(chunk) {
      try {
        if (fd === undefined) open();
        if (size > LOG_ROTATE_BYTES) {
          close();
          try {
            renameSync(file, `${file}.1`);
          } catch {
            // The same file goes on being written.
          }
          open();
          // A rotation that failed is tried again a whole file later, not on every line.
          if (size > LOG_ROTATE_BYTES) size = 0;
        }
        writeSync(fd!, chunk);
        size += chunk.length;
      } catch {
        // See above.
      }
    },
    close,
  };
}

// Under the autostart on Windows nobody types into the console: a Ctrl+C or Ctrl+Break on it
// was sent by some other program that shares or attached to it, and is no reason to stop the
// service or the client. Stopping is `tycho stop`, or the console closing, logging off or
// shutting down (SIGHUP). In a terminal Ctrl+C stops, as it should.
const ignoresConsoleBreaks = (cli: Cli): boolean => cli.system.platform === 'win32' && cli.system.env[AUTOSTART_ENV] === '1';

// A script of this release, as a child with the data directory in its environment: the
// service's entry points read it from there.
function child(cli: Cli, script: string, args: string[], env: Record<string, string>, output: 'inherit' | 'pipe') {
  return spawn(cli.system.execPath, [join(cli.appRoot, 'service', script), ...args], {
    env: { ...cli.system.env, ...env },
    stdio: ['ignore', output, output],
    windowsHide: true,
  });
}

function portOf(given: string | true | undefined): number | undefined {
  if (given === undefined) return undefined;
  const port = Number(given);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) throw new UsageError(`--port 后面要跟 1 到 ${MAX_PORT} 的整数`);
  return port;
}

async function run(cli: Cli, args: string[]): Promise<number> {
  const { open, log, port: givenPort } = parse(args, { open: false, log: true, port: true });
  const port = portOf(givenPort);
  const dataDir = dataDirFor(cli);
  // Set by every service definition the autostart writes: this run's output is a log file
  // or a console no one looks at, where a one-time login link would sit unread.
  const byAutostart = cli.system.env[AUTOSTART_ENV] === '1';
  const before = await serviceState(dataDir);
  if (before.state === 'running') {
    cli.err(`服务已经在运行（进程 ${before.pid}，端口 ${before.port}）。打开控制台用 tycho open，停掉它用 tycho stop。`);
    return 1;
  }
  if (before.state === 'held') {
    cli.err(heldBy(dataDir, before));
    return 1;
  }
  mkdirSync(dataDir, { recursive: true });
  const logger = typeof log === 'string' ? logWriter(log) : null;
  const service = child(cli, 'main.ts', [], {
    TYCHO_DATA: dataDir,
    // The service words its hints for whoever started it: only an installed copy has a `tycho` on PATH.
    ...(prefixOf(cli.appRoot) === null ? {} : { TYCHO_STARTED_BY: 'tycho' }),
    ...(port === undefined ? {} : { TYCHO_PORT: String(port) }),
  }, logger ? 'pipe' : 'inherit');
  service.stdout?.on('data', (chunk: Buffer) => logger!.write(chunk));
  service.stderr?.on('data', (chunk: Buffer) => logger!.write(chunk));

  // A terminal's Ctrl+C, or its closing, reaches the service by itself; a service manager
  // signals only this process, which passes the signal on. Windows has no signal to pass:
  // there the stop is asked for the way `tycho stop` asks. Either way this process stays
  // until the service has finished stopping.
  // What this process did with a signal goes where the service's own lines go: under the
  // autostart that is the log file, the one place anyone reads afterwards.
  const note = (line: string): void => {
    if (logger) logger.write(Buffer.from(`${new Date().toISOString()} ${line}\n`));
    else cli.err(line);
  };
  const pass = (signal: NodeJS.Signals) => (): void => {
    note(`tycho run 收到 ${signal}，请服务停止`);
    if (process.platform !== 'win32') service.kill(signal);
    else void serviceState(dataDir).then((state) => (state.state === 'running' && state.pid === service.pid ? requestStop(state) : undefined)).catch(() => {});
  };
  // A handler is what keeps the process from ending by the default rule.
  const keep = (signal: NodeJS.Signals) => (): void => note(`tycho run 收到 ${signal}：开机自启下控制台的 ${signal} 不停服务，停服务用 tycho stop`);
  const handlers = ignoresConsoleBreaks(cli)
    ? { SIGINT: keep('SIGINT'), SIGBREAK: keep('SIGBREAK'), SIGTERM: pass('SIGTERM'), SIGHUP: pass('SIGHUP') }
    : { SIGINT: pass('SIGINT'), SIGTERM: pass('SIGTERM'), SIGHUP: pass('SIGHUP') };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  let gone = false;
  let announced = false;
  const exit = new Promise<number>((resolve) => {
    service.once('error', (err) => {
      cli.err(`服务没能启动：${err.message}`);
      resolve(1);
    });
    // Not 'exit': what it printed last is still on its way.
    service.once('close', (code) => resolve(code ?? 1));
  }).finally(() => {
    gone = true;
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    logger?.close();
  });

  // However long the start takes: a recovery can be working through unreachable machines.
  for (let state: ServiceState; !gone; await sleep(cli.timing.pollMs)) {
    state = await serviceState(dataDir);
    if (state.state !== 'running' || state.pid !== service.pid) continue;
    announced = true;
    cli.out('服务已启动。');
    if (port !== undefined) cli.out(`这一次用的是端口 ${state.port}。要长期用这个端口，到设置页改“端口”。`);
    if (!(await announce(cli, dataDir, state, byAutostart ? 'service' : open === true ? 'open' : 'show'))) cli.err('服务照常在运行；稍后用 tycho open 再取登录链接。');
    if (!logger) cli.out('按 Ctrl+C 停止。');
    break;
  }
  const code = await exit;
  if (code !== 0 && !announced && typeof log === 'string') cli.err(`服务没有起来（退出码 ${code}）。它的输出在 ${log}。`);
  return code;
}

async function open(cli: Cli, args: string[]): Promise<number> {
  const { print } = parse(args, { print: false });
  const dataDir = dataDirFor(cli);
  const state = await serviceState(dataDir);
  if (state.state === 'held') {
    cli.err(heldBy(dataDir, state));
    return 1;
  }
  if (state.state === 'stopped') {
    cli.err('服务没有在运行。先运行 tycho run（或 tycho service start）。');
    return 1;
  }
  return (await announce(cli, dataDir, state, print === true ? 'print' : 'open')) ? 0 : 1;
}

async function stop(cli: Cli, args: string[], dataDir = dataDirFor(cli)): Promise<number> {
  parse(args);
  const state = await serviceState(dataDir);
  if (state.state === 'stopped') {
    cli.out(state.unclean ? '服务没有在运行（上次没有正常退出，下次启动时它自己接管）。' : '服务没有在运行。');
    return 0;
  }
  if (state.state === 'held') {
    // A holder on another machine is not asked to stop: the way out says what to do from here.
    cli.err(state.elsewhere === undefined ? `${heldBy(dataDir, state)}它现在还收不了停止请求。` : heldBy(dataDir, state));
    return 1;
  }
  if (!(await stopService(state, cli.timing))) {
    cli.err(`已请求停止，但进程 ${state.pid} 过了 ${cli.timing.stopWaitMs / 1000} 秒还没退出：它可能在等手头的事收尾。稍后用 tycho status 看。`);
    return 1;
  }
  cli.out('服务已停止。');
  return 0;
}

function describe(dataDir: string, state: ServiceState): string {
  if (state.state === 'running') return `正在运行（进程 ${state.pid}，端口 ${state.port}），控制台 ${consoleUrl(state.port)}`;
  if (state.state === 'held') return `没有就绪：${heldBy(dataDir, state)}`;
  return state.unclean ? '没有在运行（上次没有正常退出，下次启动时它自己接管）' : '没有在运行';
}

// The version the command would start, and the one that answered: after an upgrade a
// service nobody restarted is still the old one.
function versionLines(cli: Cli, state: ServiceState): string[] {
  const prefix = prefixOf(cli.appRoot);
  const own = prefix === null ? `源码目录的版本：${shownVersion(cli.appRoot)}（${cli.appRoot}）` : `已安装的版本：${shownVersion(cli.appRoot)}（装在 ${prefix}）`;
  if (state.state !== 'running') return [own];
  const same = within(state.programDir, cli.appRoot) && within(cli.appRoot, state.programDir);
  return [own, `正在运行的版本：${shownVersion(state.programDir, state.version)}（${state.programDir}）${same ? '' : '，不是上面这一份：重启服务后才用上'}`];
}

function autostartLines(cli: Cli, role: 'host' | 'node' = 'host'): string[] {
  const state = autostartFor(cli.system, role).state(installedSpec(cli.system, cli.appRoot, role));
  const what = role === 'node' ? '机器客户端的开机自启' : '开机自启';
  const command = role === 'node' ? 'tycho node service install' : 'tycho service install';
  const notes = state.notes.map((note) => `          ${note}`);
  if (state.unknown) return [`${what}：归属尚未确认，${state.where ?? '定义位置尚未核实'}`, ...notes];
  if (!state.installed) return [`${what}：没有安装（需要的话运行 ${command}）`, ...notes];
  return [
    `${what}：已安装（${state.kind}）${!state.mine ? '，启动的是另一份 tycho' : state.current ? '' : '，但它记的路径或格式过期了：运行 tycho doctor --fix'}`,
    ...(state.where ? [`          定义：${state.where}`] : []),
    ...(state.logs ? [`          输出：${state.logs}`] : []),
    ...notes,
  ];
}

async function status(cli: Cli, args: string[]): Promise<number> {
  parse(args);
  const dataDir = dataDirFor(cli);
  const state = await serviceState(dataDir);
  cli.out(`服务：${describe(dataDir, state)}`);
  for (const line of versionLines(cli, state)) cli.out(line);
  cli.out(`数据目录：${dataDir}`);
  for (const line of autostartLines(cli)) cli.out(line);
  // Only when this installation has one: a machine that never installed the client is not
  // told about a thing it does not have.
  const prefix = prefixOf(cli.appRoot);
  if (prefix !== null && slotOf(readRecord(prefix), 'node') !== undefined) for (const line of autostartLines(cli, 'node')) cli.out(line);
  return 0;
}

// A service manager returns before the service is up, so the answer is waited for. One that
// is still starting when the wait runs out is not one that failed: the limit is this
// command's patience, and what it says is where to look (cli/service-client.ts).
async function started(cli: Cli, spec: ServiceSpec): Promise<number> {
  const running = await waitRunning(spec.dataDir, cli.timing);
  if (running.state === 'died') {
    cli.err(`已请求启动，服务起来过又退出了（进程 ${running.pid}）。${autostartOutput(cli.system, spec)}`);
    return 1;
  }
  if (running.state === 'absent') {
    cli.err(`已请求启动，但过了 ${cli.timing.startWaitMs / 1000} 秒服务还没起来（它可能还在核对上次留下的执行）。用 tycho status 看；${autostartOutput(cli.system, spec)}`);
    return 1;
  }
  if (running.state === 'starting') {
    cli.err(`已请求启动，但过了 ${cli.timing.startWaitMs / 1000} 秒服务还没回答（进程 ${running.pid} 还占着数据目录）：它可能还在启动。用 tycho status 看；${autostartOutput(cli.system, spec)}`);
    return 1;
  }
  if (running.state === 'unknown') {
    cli.err(`已请求启动，但查不出服务有没有起来：${running.why}。用 tycho status 看；${autostartOutput(cli.system, spec)}`);
    return 1;
  }
  cli.out(`服务已启动（进程 ${running.pid}）。用 tycho open 打开控制台。`);
  return 0;
}

const SERVICE_ACTIONS = ['install', 'uninstall', 'start', 'stop', 'status'];

// Installing or removing a role's autostart rewrites its definition and the install record,
// which an upgrade and the other role's commands read and rewrite too: the whole of it,
// from the first read to the last write, is one holder of the prefix's lock (cli/install.ts).
const changesInstall = (action: string): boolean => action === 'install' || action === 'uninstall';

function service(cli: Cli, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || !SERVICE_ACTIONS.includes(action)) throw new UsageError(`tycho service 后面要跟 ${SERVICE_ACTIONS.join('、')} 之一`);
  const flags = parse(rest, action === 'status' ? { json: false } : {});
  if (flags.json) { cli.out(JSON.stringify(observeServices(cli.system, cli.appRoot, 'host'))); return Promise.resolve(0); }
  return changesInstall(action) ? withPrefixLock(cli, () => serviceAction(cli, action)) : serviceAction(cli, action);
}

async function serviceAction(cli: Cli, action: string): Promise<number> {
  const autostart = autostartFor(cli.system, 'host');
  // Installing takes the data directory and PATH from this terminal. Everything else is
  // about the autostart as it was installed, whatever this terminal has in its environment.
  const installed = installedSpec(cli.system, cli.appRoot, 'host');
  const spec = action === 'install' ? serviceSpec(cli.system, cli.appRoot, dataDirFor(cli), terminalPath(cli.system), 'host') : installed;
  const state = await serviceState(spec.dataDir);
  switch (action) {
    case 'install': {
      // A second service on the same data directory would only fail and be restarted.
      const start = state.state === 'stopped';
      const before = autostart.state(spec);
      if (before.mine && installed.dataDir !== spec.dataDir) cli.out(`开机自启原来用的数据目录是 ${installed.dataDir}，现在改成 ${spec.dataDir}。`);
      mkdirSync(spec.dataDir, { recursive: true });
      for (const line of autostart.install(spec, { start })) cli.out(line);
      rememberAutostart(cli.appRoot, 'host', spec);
      if (start) return started(cli, spec);
      cli.out('现在这个服务不是开机自启启动的，这次没有动它；下次登录起由开机自启接管。');
      return 0;
    }
    case 'uninstall':
      for (const line of autostart.uninstall(spec)) cli.out(line);
      rememberAutostart(cli.appRoot, 'host', null);
      return 0;
    case 'start':
      if (state.state === 'running') {
        cli.out(`服务已经在运行（进程 ${state.pid}）。`);
        return 0;
      }
      if (state.state === 'held') {
        cli.err(heldBy(spec.dataDir, state));
        return 1;
      }
      autostart.start(spec);
      return started(cli, spec);
    case 'stop':
      // The service itself, asked to stop: ending the manager's job would leave it or
      // its children behind on Windows, and count as a crash everywhere.
      return stop(cli, [], spec.dataDir);
    default:
      cli.out(`服务：${describe(spec.dataDir, state)}`);
      for (const line of autostartLines(cli)) cli.out(line);
      for (const observation of observeServices(cli.system, cli.appRoot, 'host').services) cli.out(serviceObservationText(observation));
      return 0;
  }
}

// The client holding this identity right now, as the lock file says: read without taking
// it (node/cli.ts).
const clientHolder = (identity: NodeIdentity): Holder | undefined => readClientHolder(identity);

// `tycho node service`: the machine's client as something that starts at every login
// (docs/design/nodes.md §1.1, §7). Its own definition, named apart from the host service's,
// so a computer that is both runs both — and an install, an upgrade or an uninstall of one
// never touches the other.
function nodeService(cli: Cli, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || !SERVICE_ACTIONS.includes(action)) throw new UsageError(`tycho node service 后面要跟 ${SERVICE_ACTIONS.join('、')} 之一`);
  const flags = parse(rest, action === 'status' ? { json: false } : {});
  if (flags.json) { cli.out(JSON.stringify(observeServices(cli.system, cli.appRoot, 'node'))); return Promise.resolve(0); }
  return changesInstall(action) ? withPrefixLock(cli, () => nodeServiceAction(cli, action)) : nodeServiceAction(cli, action);
}

async function nodeServiceAction(cli: Cli, action: string): Promise<number> {
  const autostart = autostartFor(cli.system, 'node');
  const installed = installedSpec(cli.system, cli.appRoot, 'node');
  const spec = action === 'install' ? serviceSpec(cli.system, cli.appRoot, dataDirFor(cli), terminalPath(cli.system), 'node') : installed;
  const identity = identityOf(spec.dataDir);
  const holder = clientHolder(identity);
  switch (action) {
    case 'install': {
      // A client that cannot take work is not one to start at every login: it would print
      // "还没有加入过" into a log nobody reads, for ever.
      if (readToken(identity) === undefined) {
        throw new InputError('这台机器还没有加入过主机：先运行 tycho node join --to <主机地址>，加入之后再装开机自启。');
      }
      mkdirSync(spec.dataDir, { recursive: true });
      // A client the owner is running by hand right now is not to be joined by a second
      // one: only one client per identity takes commands (node/cli.ts).
      for (const line of autostart.install(spec, { start: holder === undefined })) cli.out(line);
      rememberAutostart(cli.appRoot, 'node', spec);
      cli.out('这台机器开机登录后客户端会自动连回主机；正在跑的看管进程不归它管，客户端重启也不影响它们。');
      if (holder !== undefined) {
        cli.out(`现在已经有一个客户端在跑（进程 ${holder.pid}），这次没有另外启动；开机自启会在下次登录时接管。`);
        return 0;
      }
      return clientStarted(cli, spec);
    }
    case 'uninstall':
      for (const line of autostart.uninstall(spec)) cli.out(line);
      rememberAutostart(cli.appRoot, 'node', null);
      cli.out('正在跑的那个客户端没有停：要停它运行 tycho node service stop，或让它自己退出（tycho node leave）。');
      return 0;
    case 'start':
      if (holder !== undefined) {
        cli.out(`已经有一个客户端在跑（进程 ${holder.pid}），没有另外启动。`);
        return 0;
      }
      autostart.start(spec);
      return clientStarted(cli, spec);
    case 'stop': {
      // Asked of the client itself, never of its service manager: a manager's stop ends
      // everything the client started (systemd's cgroup, the scheduled task's job), and the
      // rounds running under their own watch processes are exactly what must go on
      // (nodes.md §4.2). The client leaves cleanly, which no manager here restarts.
      if (holder === undefined) {
        cli.out('现在没有客户端在跑。');
        return 0;
      }
      requestClientStop(identity, holder.pid);
      const deadline = Date.now() + cli.timing.startWaitMs;
      while (clientHolder(identity)?.pid === holder.pid) {
        if (Date.now() > deadline) {
          cli.err(`已请客户端（进程 ${holder.pid}）退出，但过了 ${cli.timing.startWaitMs / 1000} 秒它还在。它如果是手工运行的，到那个终端按 Ctrl+C。`);
          return 1;
        }
        await sleep(cli.timing.pollMs);
      }
      cli.out(`客户端（进程 ${holder.pid}）已退出，不再收活。正在跑的看管进程不受影响，会把这一轮跑完；要再收活运行 tycho node service start。`);
      return 0;
    }
    default: {
      cli.out(`机器客户端：${holder === undefined ? '没有在跑' : `在跑（进程 ${holder.pid}）`}`);
      for (const line of autostartLines(cli, 'node')) cli.out(line);
      for (const observation of observeServices(cli.system, cli.appRoot, 'node').services) cli.out(serviceObservationText(observation));
      return 0;
    }
  }
}

// The client does not answer over HTTP, so a start is asked of the service manager and the
// client's own lock is what says whether it came up.
async function clientStarted(cli: Cli, spec: ServiceSpec): Promise<number> {
  const identity = identityOf(spec.dataDir);
  const deadline = Date.now() + cli.timing.startWaitMs;
  for (;;) {
    const holder = clientHolder(identity);
    if (holder !== undefined) {
      cli.out(`机器客户端已启动（进程 ${holder.pid}）。用 tycho node status 看它连没连上主机。`);
      return 0;
    }
    if (Date.now() > deadline) {
      cli.err(`已请求启动，但过了 ${cli.timing.startWaitMs / 1000} 秒客户端还没起来。${autostartOutput(cli.system, spec)}`);
      return 1;
    }
    await sleep(cli.timing.pollMs);
  }
}

async function restore(cli: Cli, args: string[]): Promise<number> {
  const { from } = parse(args, { from: true });
  if (typeof from !== 'string') throw new UsageError('tycho restore 要用 --from 指出备份文件或目录');
  const dataDir = dataDirFor(cli);
  mkdirSync(dataDir, { recursive: true });
  const restoring = child(cli, 'restore.ts', ['--from', from], { TYCHO_DATA: dataDir }, 'inherit');
  return new Promise((resolve, reject) => {
    restoring.once('error', reject);
    restoring.once('exit', (code) => resolve(code === 0 ? 0 : 1));
  });
}

// §8.3: Node reads a proxy from the environment only with `--use-env-proxy` (or
// NODE_USE_ENV_PROXY=1, read before the process starts). There is no way to turn it on
// from inside a running process, so a client that has a proxy in its environment starts
// itself again with the switch instead of quietly going direct. `command` is the whole
// command line this process was given, subcommands included: a restart that dropped them
// would run the host's own `run` or `join` instead of the machine's.
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
export function proxyRestart(command: string[], env: NodeJS.ProcessEnv): string[] | undefined {
  if (!PROXY_VARS.some((name) => (env[name] ?? '') !== '')) return undefined;
  if (process.execArgv.includes('--use-env-proxy')) return undefined;
  // A Node that does not know the switch must not be run with it: asked once, and with
  // nothing captured — what it would say is of no use here, and asking for it costs a pipe
  // some restricted machines refuse to open.
  const known = spawnSync(process.execPath, ['--use-env-proxy', '-e', ''], { windowsHide: true, timeout: 20_000, stdio: 'ignore' });
  if (known.status !== 0) return undefined;
  return [...process.execArgv, '--use-env-proxy', process.argv[1]!, ...command];
}

// `tycho node`: the machine side of the node channel. Ctrl+C stops the client; the rounds
// it started keep running under their own watch processes. `node service` is the client as
// something that starts at every login, with a definition of its own.
async function node(cli: Cli, args: string[]): Promise<number> {
  // A local machine-readable observation neither connects nor restarts for a proxy.
  if (args[0] === 'service' && args[1] === 'status' && args.includes('--json')) return nodeService(cli, args.slice(1));
  const restart = proxyRestart(['node', ...args], cli.system.env);
  if (restart !== undefined && process.env.TYCHO_NODE_PROXY_RESTART !== '1') {
    cli.out('环境里有代理：用 --use-env-proxy 重新启动自己，好让这台机器经代理连主机。');
    const again = spawn(cli.system.execPath, restart, {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...cli.system.env, TYCHO_NODE_PROXY_RESTART: '1' },
    });
    return new Promise((resolve, reject) => {
      again.once('error', reject);
      again.once('exit', (code) => resolve(code ?? 1));
    });
  }
  if (args[0] === 'service') return nodeService(cli, args.slice(1));
  // A client started by the login autostart has no console to print to: `--log` is where
  // its output goes instead, the same way the host service's does (cli/autostart.ts). Both
  // what the subcommand prints and what this command itself reports on the way out go
  // there: a client that never started is exactly what that file is read for.
  const { log, args: rest } = takeLog(args);
  const logger = typeof log === 'string' ? logWriter(log) : null;
  const out = cli.out;
  const err = cli.err;
  if (logger !== null) {
    const write = (line: string): void => logger.write(Buffer.from(`${line}\n`));
    cli.out = write;
    cli.err = write;
  }
  const stopRequest = new AbortController();
  const keep = (signal: NodeJS.Signals) => (): void => cli.err(`tycho node 收到 ${signal}：开机自启下控制台的 ${signal} 不停客户端`);
  const handlers: [NodeJS.Signals, () => void][] = ignoresConsoleBreaks(cli)
    ? [['SIGINT', keep('SIGINT')], ['SIGBREAK', keep('SIGBREAK')], ['SIGTERM', () => stopRequest.abort()]]
    : [['SIGINT', () => stopRequest.abort()], ['SIGTERM', () => stopRequest.abort()]];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    return await nodeCommand({ out: cli.out, err: cli.err, dataDir: dataDirFor(cli), signal: stopRequest.signal, appRoot: cli.appRoot, ...(typeof log === 'string' ? { logFile: log } : {}) }, rest);
  } finally {
    cli.out = out;
    cli.err = err;
    logger?.close();
  }
}

// `--log <文件>` anywhere in a `tycho node` command line, taken out before the subcommand
// sees it: it is the launcher's own switch, not something `join` or `run` has an opinion
// about.
function takeLog(args: string[]): { log?: string; args: string[] } {
  const rest: string[] = [];
  let log: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    const equals = /^--log=(.*)$/.exec(arg);
    if (arg === '--log' || equals) {
      const value = equals ? equals[1]! : args[(at += 1)];
      if (value === undefined || value === '') throw new UsageError('--log 后面要跟一个文件');
      log = value;
      continue;
    }
    rest.push(arg);
  }
  return { ...(log === undefined ? {} : { log }), args: rest };
}

async function dispatch(argv: string[], cli: Cli): Promise<number> {
  const [command = 'run', ...args] = argv;
  if (['help', '--help', '-h'].includes(command)) {
    cli.out(HELP);
    return 0;
  }
  if (['version', '--version', '-v'].includes(command)) {
    parse(args);
    cli.out(`tycho ${shownVersion(cli.appRoot)}`);
    return 0;
  }
  if (command === 'doctor') {
    const { fix } = parse(args, { fix: false });
    // A repair may rewrite an autostart definition: that is the install lock's business.
    return fix === true ? withPrefixLock(cli, () => doctor(cli, dataDirFor(cli), { fix: true })) : doctor(cli, dataDirFor(cli), { fix: false });
  }
  const required = requiredNode(cli.appRoot);
  if (!nodeIsEnough(cli.system.nodeVersion, required)) {
    cli.err(`tycho 需要 Node ${required} 或更新的，现在是 ${cli.system.nodeVersion}（${cli.system.execPath}）。详情运行 tycho doctor。`);
    return 1;
  }
  switch (command) {
    case 'run':
      return run(cli, args);
    case 'open':
      return open(cli, args);
    case 'stop':
      return stop(cli, args);
    case 'status':
      return status(cli, args);
    case 'service':
      return service(cli, args);
    case 'update': {
      const { from, to, 'expect-version': expectVersion, 'expect-sha256': expectSha256, automatic } = parse(args, {
        from: true, to: true, 'expect-version': true, 'expect-sha256': true, automatic: false,
      });
      if (typeof to === 'string' && (!isVersion(to) || typeof from === 'string' || Boolean(cli.system.env.TYCHO_RELEASE_URL))) {
        throw new UsageError('--to 要填有效版本，不能与 --from 或 TYCHO_RELEASE_URL 同用');
      }
      return update(cli, typeof from === 'string' ? from : undefined, {
        ...(typeof to === 'string' ? { to } : {}),
        ...(typeof expectVersion === 'string' ? { expectVersion } : {}),
        ...(typeof expectSha256 === 'string' ? { expectSha256 } : {}),
        ...(automatic === true ? { automatic: true } : {}),
      });
    }
    case 'restore':
      return restore(cli, args);
    case 'project-home':
      return projectHomeCommand(cli, args);
    case 'project-directory':
      return projectDirectoryCommand(cli, args);
    case 'node':
      return node(cli, args);
    // A stdio server for as long as its session lives: nothing else may write to stdout.
    case 'knowledge-mcp': {
      const { node: viaNode, url } = parse(args, { node: false, url: true });
      await knowledgeMcpMain([...(viaNode === true ? ['--node'] : []), ...(typeof url === 'string' ? ['--url', url] : [])], cli.system.env);
      return 0;
    }
    case 'uninstall':
      parse(args);
      return uninstall(cli);
    // What the install scripts and `tycho update` hand over to, once a release is unpacked.
    case 'install-self': {
      const { prefix, node, 'expect-version': expectVersion, automatic, 'only-upgrade': onlyUpgrade } = parse(args, { prefix: true, node: true, 'expect-version': true, automatic: false, 'only-upgrade': false });
      if (typeof prefix !== 'string' || typeof node !== 'string') throw new UsageError('install-self 要有 --prefix 和 --node');
      return installSelf(cli, {
        prefix,
        node,
        ...(typeof expectVersion === 'string' ? { expectVersion } : {}),
        ...(automatic === true ? { automatic: true } : {}),
        ...(onlyUpgrade === true ? { onlyUpgrade: true } : {}),
      });
    }
    default:
      // `tycho --open` is `tycho run --open`.
      if (command.startsWith('--')) return run(cli, argv);
      throw new UsageError(`不认识的命令：${command}`);
  }
}

export async function runCli(argv: string[], cli: Cli): Promise<number> {
  try {
    return await dispatch(argv, cli);
  } catch (err) {
    if (err instanceof UsageError) {
      cli.err(`${err.message}。用法见 tycho help。`);
      return 2;
    }
    cli.err((err as Error).message);
    return 1;
  }
}

// The command on this machine as it is. `npm run stop` and `npm run login-link` are the
// same commands under the names a checkout knows them by.
export const command = (argv: string[]): Promise<number> =>
  runCli(argv, {
    system: realSystem(),
    // As the file system spells it: Windows hands over whatever case the caller typed.
    appRoot: realpathSync.native(join(import.meta.dirname, '..')),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    timing: { pollMs: 200, stopWaitMs: 60_000, startWaitMs: 30_000 },
  });

// Not import.meta.main, and not service/entry.ts's isEntry either: on a Node that is too
// old the command still runs, to say so and to let `tycho doctor` explain.
if (startedAs(import.meta.filename)) process.exitCode = await command(process.argv.slice(2));
