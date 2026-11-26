// `tycho doctor`: what is wrong with the installation and the service around it, one line
// each, with what to do about it. The service's own checks (Claude Code, its login, the
// accounts) come from cli/service-checks.ts, in the same report.
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { elsewhereText } from '../service/lock.ts';
import type { Role, ServiceSpec } from './autostart.ts';
import { autostartFor } from './autostart.ts';
import { installedSpec } from './install.ts';
import { launcherPath, launchersCurrent, recordedNode, writeLaunchers } from './launcher.ts';
import { defaultPrefix, layoutOf, nodeIsEnough, prefixOf, readCurrent, requiredNode, shownVersion } from './paths.ts';
import { readRecord, slotOf } from './record.ts';
import { serviceChecks } from './service-checks.ts';
import type { ServiceState } from './service-client.ts';
import { canConnect, serviceState } from './service-client.ts';
import type { Cli, System } from './system.ts';
import { lockFile } from '../service/config.ts';

// `unknown`: something only a running service can tell, asked while none is running.
// Neither a problem nor in order.
export type Level = 'ok' | 'warn' | 'fail' | 'unknown';

export interface Check {
  title: string;
  level: Level;
  detail: string;
  // What the owner can do about it.
  fix?: string;
  // Present only for what the installer itself wrote: `--fix` runs it and reports what
  // it says. Nothing of the owner's is ever repaired.
  repair?: () => string;
}

// Checks from outside this file, given the data directory and what holds it.
type CheckSource = (dataDir: string, service: ServiceState) => Check[] | Promise<Check[]>;

const FIX = '运行 tycho doctor --fix。';
const REINSTALL = '运行 tycho doctor --fix；不行就重新运行安装脚本。';

// `required` is what this release's package.json asks for.
export function checkNode(system: System, required: string): Check {
  const title = 'Node 版本';
  if (nodeIsEnough(system.nodeVersion, required)) {
    return { title, level: 'ok', detail: `${system.nodeVersion}（${system.execPath}）` };
  }
  return {
    title,
    level: 'fail',
    detail: `现在是 ${system.nodeVersion}（${system.execPath}），需要 ${required} 或更新的。`,
    fix: `装 Node ${required} 以上，或重新运行安装脚本，让它自带一份。`,
  };
}

// The launcher, `current` and the version directories have to name each other.
export function checkInstall(cli: Cli): Check[] {
  const { system, appRoot } = cli;
  const prefix = prefixOf(appRoot);
  if (prefix === null) {
    return [{ title: '安装', level: 'ok', detail: `从源码目录运行（${appRoot}），不是安装脚本装的那一份。` }];
  }
  const layout = layoutOf(prefix);
  const own = basename(appRoot);
  const current = readCurrent(prefix);
  const useOwn = (): string => {
    writeFileSync(layout.current, own);
    return `${layout.current} 已指回 ${own}。`;
  };

  let version: Check;
  if (current === null) {
    version = { title: '安装的版本', level: 'fail', detail: `${layout.current} 不在或读不出版本号。`, fix: REINSTALL, repair: useOwn };
  } else if (!existsSync(join(layout.versions, current, 'cli', 'main.ts'))) {
    version = {
      title: '安装的版本',
      level: 'fail',
      detail: `${layout.current} 指的版本 ${current} 不在 ${layout.versions} 里。`,
      fix: REINSTALL,
      repair: useOwn,
    };
  } else if (current !== own) {
    version = {
      title: '安装的版本',
      level: 'warn',
      detail: `现在运行的是 ${own}，而 tycho 命令用的是 ${current}。`,
      fix: '用 tycho 命令运行，不要直接运行某个版本目录里的文件。',
    };
  } else {
    version = { title: '安装的版本', level: 'ok', detail: `${current}，装在 ${prefix}。` };
  }

  const file = launcherPath(prefix, system.platform);
  const required = requiredNode(appRoot);
  const usable = nodeIsEnough(system.nodeVersion, required);
  const rewrite = (node: string) => (): string => {
    writeLaunchers({ prefix, node, platform: system.platform });
    return `启动器 ${file} 已重写，用的 Node 是 ${node}。`;
  };
  // With the Node running this, when it will do.
  const withThisNode = usable ? { fix: REINSTALL, repair: rewrite(system.execPath) } : { fix: '重新运行安装脚本。' };
  const recorded = recordedNode(prefix, system.platform);
  let launcher: Check;
  if (recorded === null) {
    launcher = { title: '启动器', level: 'fail', detail: `${file} 不在，或不是安装器写的那个。`, ...withThisNode };
  } else if (!existsSync(recorded)) {
    launcher = { title: '启动器', level: 'fail', detail: `启动器记的 Node 已经不在了：${recorded}。`, ...withThisNode };
  } else if (recorded !== system.execPath && !nodeIsEnough(system.exec(recorded, ['-p', 'process.versions.node']).stdout.trim(), required)) {
    launcher = { title: '启动器', level: 'fail', detail: `启动器记的 Node（${recorded}）低于 ${required}，或者运行不了。`, ...withThisNode };
  } else if (!launchersCurrent({ prefix, node: recorded, platform: system.platform })) {
    launcher = { title: '启动器', level: 'warn', detail: `${file} 是别的版本写的，和这个版本要的不一样。`, fix: FIX, repair: rewrite(recorded) };
  } else {
    launcher = { title: '启动器', level: 'ok', detail: `${file}，用的 Node 是 ${recorded}。` };
  }
  return [version, launcher];
}

export function checkDataDir(dataDir: string, service: ServiceState): Check {
  const title = '数据目录';
  const stat = statSync(dataDir, { throwIfNoEntry: false });
  if (!stat) return { title, level: 'ok', detail: `${dataDir} 还没有，第一次运行时创建。` };
  if (!stat.isDirectory()) {
    return { title, level: 'fail', detail: `${dataDir} 不是目录。`, fix: '挪开这个文件，或用环境变量 TYCHO_DATA 指到别处。' };
  }
  const probe = join(dataDir, `.doctor-${process.pid}`);
  try {
    writeFileSync(probe, '');
    rmSync(probe);
  } catch (err) {
    return {
      title,
      level: 'fail',
      detail: `${dataDir} 写不进去：${(err as Error).message}`,
      fix: '检查这个目录的权限，或用环境变量 TYCHO_DATA 指到别处。',
    };
  }
  if (service.state === 'running') return { title, level: 'ok', detail: `${dataDir}，服务（进程 ${service.pid}）正在用它。` };
  if (service.state === 'held') {
    if (service.elsewhere !== undefined) {
      return { title, level: 'warn', detail: elsewhereText(lockFile(dataDir), service.elsewhere) };
    }
    return {
      title,
      level: 'warn',
      detail: `${dataDir} 被进程 ${service.pid} 占着，而它没有回答自己是运行中的服务：可能正在启动，或者正在恢复备份。`,
      fix: `等它结束。一直这样的话，看进程 ${service.pid} 是什么：是卡住的 tycho 就结束它，再启动。`,
    };
  }
  return {
    title,
    level: 'ok',
    detail: service.unclean ? `${dataDir} 可写。上次服务没有正常退出，下次启动时它自己接管。` : `${dataDir} 可写，没有被占用。`,
  };
}

export async function checkPort(service: ServiceState): Promise<Check> {
  const title = '端口';
  // Not "something listens there": the service on it said who it is.
  if (service.state === 'running') {
    return { title, level: 'ok', detail: `端口 ${service.port} 上的服务回答了它是谁：版本 ${shownVersion(service.programDir, service.version)}，程序目录 ${service.programDir}。` };
  }
  if (service.state === 'held' && service.announcedPort !== undefined) {
    return {
      title,
      level: 'fail',
      detail: `进程 ${service.pid} 登记了端口 ${service.announcedPort}，但那个端口上没有它的应答。`,
      fix: `等一会儿再查；一直这样就结束进程 ${service.pid}，再启动服务。`,
    };
  }
  if (service.state === 'stopped' && service.lastPort !== undefined) {
    if (!(await canConnect(service.lastPort))) return { title, level: 'ok', detail: `服务没在运行；它上次用的端口 ${service.lastPort} 现在空着。` };
    return {
      title,
      level: 'warn',
      detail: `服务没在运行，但它上次用的端口 ${service.lastPort} 现在被别的程序占着。`,
      fix: '关掉占着它的程序；或者这一次换个端口运行（tycho run --port <端口>），再到控制台的设置页改“端口”。',
    };
  }
  return { title, level: 'ok', detail: '服务没在运行，没有登记的端口可查。' };
}

export function checkAutostart(system: System, spec: ServiceSpec, role: Role = 'host'): Check {
  const title = role === 'node' ? '机器客户端的开机自启' : '开机自启';
  const autostart = autostartFor(system, role);
  const command = role === 'node' ? 'tycho node service install' : 'tycho service install';
  let state: ReturnType<typeof autostart.state>;
  try { state = autostart.state(spec); }
  catch (error) { return { title, level: 'warn', detail: (error as Error).message }; }
  if (state.unknown) return { title, level: 'warn', detail: `${state.where ?? '定义位置尚未核实'}：${state.notes.join(' ')}` };
  // What could not be asked is not "nothing installed".
  if (!state.installed && state.notes.length > 0) return { title, level: 'warn', detail: `没看到已安装的开机自启。${state.notes.join(' ')}` };
  if (!state.installed) return { title, level: 'ok', detail: `没有安装。需要的话运行 ${command}。` };
  if (!state.mine) {
    return {
      title,
      level: 'warn',
      detail: `已安装（${state.kind}），但它启动的不是这一份 tycho：${state.where}。`,
      fix: `想让它启动这一份，运行 ${command}；否则留着不管。`,
    };
  }
  if (!state.current) {
    return {
      title,
      level: 'warn',
      detail: `${state.kind}里记的路径或格式过期了（升级、换了 Node 或挪了目录之后会这样）：${state.where}。`,
      fix: FIX,
      repair() {
        // The definition only: whether the service runs is not this command's business.
        autostart.install(spec, { start: false });
        return `开机自启（${state.kind}）已按现在的路径重写。正在运行的服务要重启后才用上它。`;
      },
    };
  }
  if (state.notes.length > 0) return { title, level: 'warn', detail: `已安装（${state.kind}）。${state.notes.join(' ')}` };
  return { title, level: 'ok', detail: `已安装（${state.kind}）：${state.where}。` };
}

// The directories on PATH that hold a tycho command, first one first.
function onPath(system: System): string[] {
  const names = system.platform === 'win32' ? ['tycho.cmd', 'tycho.exe', 'tycho.bat'] : ['tycho'];
  return (system.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '' && names.some((name) => existsSync(join(dir, name))));
}

const same = (system: System, a: string, b: string): boolean =>
  system.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export function checkPath(system: System, prefix: string | null): Check {
  const title = 'PATH 里的 tycho';
  const [first] = onPath(system);
  if (prefix === null) {
    return { title, level: 'ok', detail: first ? `终端里的 tycho 是装在 ${first} 的那一份，不是这个源码目录。` : 'PATH 里没有 tycho；源码目录里用 node cli/main.ts 运行。' };
  }
  const { bin } = layoutOf(prefix);
  if (first === undefined) {
    return { title, level: 'warn', detail: 'PATH 里找不到 tycho。', fix: `新开一个终端再试；还没有就把 ${bin} 加进 PATH。` };
  }
  if (same(system, first, bin)) return { title, level: 'ok', detail: `终端里的 tycho 就是这一份（${bin}）。` };
  return {
    title,
    level: 'warn',
    detail: `在终端里敲 tycho，运行的是另一份：${first}。`,
    fix: `把 ${bin} 在 PATH 里排到它前面，或者卸掉那一份。`,
  };
}

// A second copy in another prefix: the terminal and the autostart can end up on different ones.
export function checkOtherInstalls(system: System, prefix: string | null): Check {
  const title = '多处安装';
  const candidates = [defaultPrefix({}, system.home), system.env.TYCHO_PREFIX, ...onPath(system).map((dir) => dirname(dir))];
  const others = [...new Set(candidates.filter((dir): dir is string => Boolean(dir)).map((dir) => resolve(dir)))].filter(
    (dir) => (prefix === null || !same(system, dir, prefix)) && readCurrent(dir) !== null,
  );
  if (others.length === 0) return { title, level: 'ok', detail: prefix === null ? '没有发现安装的版本。' : '只有这一处。' };
  if (prefix === null) return { title, level: 'ok', detail: `另有安装的版本：${others.join('、')}。` };
  return {
    title,
    level: 'warn',
    detail: `别处还装了一份：${others.join('、')}。终端和开机自启用的可能不是同一份。`,
    fix: '留一份；另一份用它自己的 tycho uninstall 卸掉。',
  };
}

async function collect(cli: Cli, dataDir: string, sources: CheckSource[]): Promise<Check[]> {
  const { system, appRoot } = cli;
  const prefix = prefixOf(appRoot);
  const service = await serviceState(dataDir);
  // The machine client's own definition, when this installation has one: a second role on
  // one computer, checked and repaired on its own (docs/design/nodes.md §7).
  const record = prefix === null ? null : readRecord(prefix);
  const checks: Check[] = [
    checkNode(system, requiredNode(appRoot)),
    ...checkInstall(cli),
    checkDataDir(dataDir, service),
    await checkPort(service),
    // As it was installed, whatever this terminal has in its environment.
    checkAutostart(system, installedSpec(system, appRoot, 'host'), 'host'),
    ...(slotOf(record, 'node') === undefined ? [] : [checkAutostart(system, installedSpec(system, appRoot, 'node'), 'node')]),
    checkPath(system, prefix),
    checkOtherInstalls(system, prefix),
  ];
  for (const source of sources) {
    try {
      checks.push(...(await source(dataDir, service)));
    } catch (err) {
      checks.push({ title: '服务的检查', level: 'fail', detail: `检查本身出错了：${(err as Error).message}` });
    }
  }
  return checks;
}

const MARK: Record<Level, string> = { ok: '正常', warn: '注意', fail: '有问题', unknown: '不知道' };

export async function doctor(cli: Cli, dataDir: string, options: { fix: boolean }, sources: CheckSource[] = [serviceChecks]): Promise<number> {
  let checks = await collect(cli, dataDir, sources);
  if (options.fix) {
    const repairs = checks.filter((check) => check.level !== 'ok' && check.repair);
    for (const check of repairs) {
      try {
        cli.out(`已修：${check.repair!()}`);
      } catch (err) {
        cli.err(`${check.title}没修成：${(err as Error).message}`);
      }
    }
    if (repairs.length > 0) checks = await collect(cli, dataDir, sources);
    else cli.out('没有能自动修的。');
  }
  for (const check of checks) {
    cli.out(`[${MARK[check.level]}] ${check.title}：${check.detail}`);
    if (check.level !== 'ok' && check.fix) cli.out(`        怎么办：${check.fix}`);
  }
  const count = (level: Level): number => checks.filter((check) => check.level === level).length;
  const unknown = count('unknown') > 0 ? `${count('unknown')} 项要服务在跑才知道` : '';
  if (count('fail') + count('warn') === 0) cli.out(unknown === '' ? '都正常。' : `查得到的都正常；${unknown}。`);
  else cli.out(`${count('fail')} 项有问题，${count('warn')} 项要注意${unknown === '' ? '' : `，${unknown}`}。`);
  return count('fail') > 0 ? 1 : 0;
}
