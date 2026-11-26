// Putting a release into a prefix, replacing it with a newer one, and taking it out again.
// The install scripts only find a Node and unpack the release; everything after that is
// here, done by the release being installed, so there is one implementation of the layout
// and the version that writes a launcher or a service definition is the one that reads it.
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { dataDirOf, lockFile } from '../service/config.ts';
import { projectHomeEnabled } from '../service/project-home.ts';
import { SCHEMA_VERSION } from '../service/db.ts';
import { claimLock, elsewhereText, isAlive, lockElsewhere, machineName } from '../service/lock.ts';
import type { LedgerPeek, PeekedDriver } from '../service/ledger-peek.ts';
import { peekLedger } from '../service/ledger-peek.ts';
import { hostProcesses, type Processes } from '../service/processes.ts';
import { writeReleaseResult } from '../service/releases.ts';
import { archiveProblem } from './archive.ts';
import { fetchGitHubRelease } from './github-release.ts';
import type { AutostartState, Role, ServiceSpec } from './autostart.ts';
import { autostartFor, autostartOutput, psQuote, roleOf } from './autostart.ts';
import { launcherNames, launcherPath, parseLauncher, restoreLaunchers, savedLaunchers, writeLaunchers } from './launcher.ts';
import type { Layout } from './paths.ts';
import { appVersion, isVersion, layoutOf, prefixOf, readCurrent, releaseVersion } from './paths.ts';
import { sameRelease } from './manifest.ts';
import { clientsInUse, readClientHolder, runningClient } from '../node/cli.ts';
import { requestClientStop } from '../node/client.ts';
import type { ReleaseOutcome } from './release.ts';
import { checkRelease, releaseOutcomeLine, rollbackDecision, unfinishedStart, unverifiedLine } from './release.ts';
import type { InstallRecord } from './record.ts';
import { readRecord, slotOf, withSlot, writeRecord } from './record.ts';
import type { Running, ServiceState } from './service-client.ts';
import { drain, requestStop, serviceState, stopService, waitRunning } from './service-client.ts';
import type { Cli, System } from './system.ts';
import { encodedCommand, said, tool } from './system.ts';
import { addToPath, removeFromPath } from './user-path.ts';

// Anonymous bootstrap default. The installed CLI uses the local gh identity unless
// TYCHO_RELEASE_URL explicitly selects a custom URL; the bootstrap scripts share this URL.
export const RELEASE_URL = 'https://github.com/XaineChaeson/tycho/releases/latest/download/tycho.tar.gz';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// What a service manager is told to run. An installed copy is named through its
// launcher, which survives upgrades; a source checkout has only itself. One program has two
// roles, and each role's definition is its own: the host's service, or the machine's client.
export function serviceSpec(system: System, appRoot: string, dataDir = dataDirOf(system.env, system.home), path?: string, role: Role = 'host'): ServiceSpec {
  const prefix = prefixOf(appRoot);
  // The client's own output goes beside the service's, under the role's own name: both on
  // one data directory, neither overwriting the other.
  const logFile = join(dataDir, role === 'node' ? 'node.log' : 'service.log');
  return {
    program: prefix === null ? [system.execPath, join(appRoot, 'cli', 'main.ts')] : [launcherPath(prefix, system.platform)],
    dataDir,
    logFile,
    path,
    role,
  };
}

// What an autostart installed from this terminal is told. A scheduled task takes the
// user's environment, not this terminal's.
export const terminalPath = (system: System): string | undefined =>
  system.platform === 'win32' ? undefined : system.env.PATH || undefined;

// The data directory one role's autostart runs on: what the install record kept for that
// role, or the one a start from this terminal would use. A role that was never installed
// has no slot and no answer of its own.
const autostartDataDir = (system: System, record: InstallRecord | null, role: Role = 'host'): string =>
  slotOf(record, role)?.dataDir ?? dataDirOf(system.env, system.home);

// An autostart as it was installed: its data directory and PATH are kept in the install
// record, and otherwise the data directory is this terminal's. A source checkout keeps no
// record, so the PATH is this terminal's too. An installation that kept none has none: an
// autostart from before it was kept stays as it is until the next install.
export function installedSpec(system: System, appRoot: string, role: Role = 'host'): ServiceSpec {
  const prefix = prefixOf(appRoot);
  const kept = prefix === null ? null : readRecord(prefix);
  const slot = slotOf(kept, role);
  return serviceSpec(system, appRoot, autostartDataDir(system, kept, role), prefix === null ? terminalPath(system) : slot?.path, role);
}

// Null once this role's autostart is uninstalled. A source checkout keeps no record, and a
// role never installed here keeps no slot.
export function rememberAutostart(appRoot: string, role: Role, spec: ServiceSpec | null): void {
  const prefix = prefixOf(appRoot);
  const record = prefix === null ? null : readRecord(prefix);
  if (prefix === null || record === null) return;
  writeRecord(prefix, withSlot(record, role, spec === null ? null : { dataDir: spec.dataDir, ...(spec.path ? { path: spec.path } : {}) }));
}

// ---- Which path is inside which ----

// As the file system spells it, links followed, for as much of the path as exists.
function real(path: string): string {
  const missing: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync.native(at), ...missing.reverse());
    } catch {
      if (dirname(at) === at) return resolve(path);
      missing.push(basename(at));
    }
  }
}

// Whether `inner` is `outer` or lies inside it, by where both really are.
export function within(inner: string, outer: string): boolean {
  const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path);
  const between = relative(fold(real(outer)), fold(real(inner)));
  return between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between));
}

// The data directories a service of this installation may be running on: this terminal's,
// and every role's autostart as it was installed. Both roles count: an uninstall must not
// delete a directory either of them keeps data in.
function knownDataDirs(system: System, record: InstallRecord | null): string[] {
  const slots = Object.values(record?.autostart ?? {}).map((slot) => slot.dataDir);
  return [...new Set([dataDirOf(system.env, system.home), ...slots])];
}

// ---- Whose autostart runs the service here ----

interface ManagedService {
  managed: boolean;
  // Why not, in the owner's words; empty when it is managed.
  why: string;
}

// Whether the autostart of this installation is what runs the service on this data
// directory. It is the one case in which an upgrade can stop that service and start the
// next version in its place: a service nobody manages keeps running the old program while
// `current` moves under it, so the version just put in place has nothing proving it works
// and is left for the next start. Asked the same way `stopServices` asks it, so the
// console and the command that does the work never disagree about it.
//
// The host's autostart is the one asked about: the machine client's is a different program
// with a different life, and it is not what an upgrade stops and starts.
export function autostartManages(system: System, appRoot: string, dataDir: string): ManagedService {
  const prefix = prefixOf(appRoot);
  if (prefix === null) return { managed: false, why: '这是源码目录里的 tycho，不是安装脚本装的那一份' };
  const record = readRecord(prefix);
  const wanted = autostartDataDir(system, record, 'host');
  if (!within(wanted, dataDir) || !within(dataDir, wanted)) {
    return { managed: false, why: `开机自启记的数据目录是 ${wanted}，这个服务用的是 ${dataDir}` };
  }
  let state: AutostartState;
  try {
    state = autostartFor(system, 'host').state(serviceSpec(system, appRoot, wanted, slotOf(record, 'host')?.path, 'host'));
  } catch (err) {
    return { managed: false, why: `查不出开机自启的状态（${message(err)}）` };
  }
  if (state.mine === true) return { managed: true, why: '' };
  if (!state.installed) return { managed: false, why: state.notes[0] ?? '这台机器上没有装这个安装的开机自启（tycho service status 看得到）' };
  return { managed: false, why: state.notes.length > 0 ? `${state.where ?? ''}：${state.notes.join(' ')}` : `装着的${state.kind ?? '开机自启'}启动的是另一份 tycho` };
}

// ---- One install, upgrade or uninstall at a time in a prefix ----

// Null when another one is at work, which has been said. Otherwise what releases the lock.
function lockPrefix(cli: Cli, layout: Layout): (() => void) | null {
  const holder = claimLock(layout.lock, () => {});
  if (holder) {
    const where = lockElsewhere(holder) === undefined ? '' : `另一台机器 ${machineName(holder)} 上的`;
    cli.err(`另一个安装、升级或卸载（${where}进程 ${holder.pid}）正在这个程序目录里进行：${layout.prefix}。等它结束再试。`);
    return null;
  }
  return () => rmSync(layout.lock, { force: true });
}

// The same lock around a command that reads and rewrites the install record or a role's
// autostart definition (`tycho service install`, `tycho node service install`, their
// uninstalls, a doctor's repair): the two roles' commands and an upgrade all read the whole
// record and write it back, and whichever wrote last would otherwise erase what another
// wrote in between. A source checkout has no prefix, no record and nothing to lock.
export async function withPrefixLock(cli: Cli, work: () => Promise<number>): Promise<number> {
  const prefix = prefixOf(cli.appRoot);
  if (prefix === null) return work();
  const unlock = lockPrefix(cli, layoutOf(prefix));
  if (!unlock) return 1;
  try {
    return await work();
  } finally {
    unlock();
  }
}

// ---- Placing a version ----

// Windows refuses a rename for a moment while a scanner holds a freshly written file.
function rename(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const busy = ['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '');
      if (!busy || process.platform !== 'win32' || attempt >= 20) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

interface Placed {
  staged: string;
  target: string;
  // Where the copy of the same version that was there has been moved to.
  aside: string | null;
}

const REPLACED = '.replaced-';
const STAGING = /^\.staging-(\d+)-/;

// Moves the unpacked release to versions/<version>. A copy of the same version already
// there is set aside, not deleted: it is the way back, and a service may be running from it.
// Only when it is the same program by its manifest: a version is a commit count, and
// another branch packed at the same count would otherwise replace it under the same name.
function place(staged: string, layout: Layout, version: string): Placed {
  const target = join(layout.versions, version);
  if (resolve(staged) === resolve(target)) return { staged, target, aside: null };
  if (existsSync(target) && !sameRelease(staged, target)) {
    throw new Error(`版本 ${version} 下已经装着另一份程序（多半是从另一条分支打的包），这次不换；要装请先从同一条主线打包。`);
  }
  mkdirSync(layout.versions, { recursive: true });
  const aside = existsSync(target) ? join(layout.versions, `${REPLACED}${version}-${process.pid}-${Date.now().toString(36)}`) : null;
  if (aside) rename(target, aside);
  try {
    rename(staged, target);
  } catch (err) {
    if (aside) rename(aside, target);
    throw err;
  }
  return { staged, target, aside };
}

function unplace({ staged, target, aside }: Placed): void {
  if (resolve(staged) === resolve(target)) return;
  rename(target, staged);
  if (aside) rename(aside, target);
}

// `current` names a whole version or the one before, never half a write.
function writeCurrent(layout: Layout, version: string): void {
  const partial = `${layout.current}.${process.pid}.tmp`;
  writeFileSync(partial, version);
  rename(partial, layout.current);
}

// ---- The service this installation runs ----

interface Synced {
  // Program directories a service of this installation is still running from.
  inUse: string[];
  // False when something about a running service could not be established, or a restart
  // did not happen: nothing old is cleaned up then.
  settled: boolean;
  // Whether the autostart on the data directory a service of this installation runs on is
  // this installation's. Another copy's is not this one's to rewrite.
  managed: boolean;
  // The service that was stopped and is to run on the new version, if there was one: the
  // release has to prove itself on that one. Set even when starting it did not work out —
  // a candidate that cannot start is exactly what has to be judged, and taken back.
  restart?: { dataDir: string; spec: ServiceSpec };
}

// What one role of this installation is started with, from the record as it stands. The
// version directory is passed, not the prefix: the launcher is what a manager runs, and
// that is what makes the definition survive an upgrade.
const specFor = (system: System, layout: Layout, record: InstallRecord, version: string, role: Role = 'host'): ServiceSpec =>
  serviceSpec(system, join(layout.versions, version), autostartDataDir(system, record, role), slotOf(record, role)?.path, role);

// Lets the turn the Router is handling finish before the service is stopped. A service
// that does not answer is stopped as before: waiting is a courtesy to the work in
// flight, not a condition of the upgrade. The limit is the service's own setting.
async function waitForTurn(cli: Cli, service: Running): Promise<void> {
  try {
    const { drained, waitedMs } = await drain(service);
    if (drained) cli.out(waitedMs < 1000 ? '负责人手头这一回合已经收尾，现在停服务。' : `等负责人把手头这一回合做完（${Math.round(waitedMs / 1000)} 秒），现在停服务。`);
    else cli.out(`负责人这一回合等了 ${Math.round(waitedMs / 1000)} 秒还没做完，按上限不再等，照常停服务。`);
  } catch (err) {
    cli.out(`没能让服务先收尾手头的回合（${message(err)}），照常停它。`);
  }
}

// Everything of this installation that is running, stopped before `current` is switched.
// The order is the point: the launcher reads `current`, so from the moment it names the
// new version anything that starts the service starts the candidate — including a service
// manager restarting a service that crashed in that window. A service stopped on purpose
// is not a failure, so nothing starts it again until this command asks for it. A service
// run by hand is its owner's to restart; one of another installation, even on the same
// data directory, is not stopped.
async function stopServices(cli: Cli, layout: Layout, record: InstallRecord, version: string, unfinished: string[]): Promise<Synced> {
  const { system } = cli;
  const autostart = autostartFor(system, 'host');
  const autoDataDir = autostartDataDir(system, record, 'host');
  const spec = specFor(system, layout, record, version, 'host');
  const synced: Synced = { inUse: [], settled: true, managed: false };
  let mine = false;
  try {
    // Another copy's autostart is not this one's to rewrite.
    mine = autostart.state(spec).mine === true;
  } catch (err) {
    unfinished.push(`查不出开机自启的状态：${message(err)}`);
    synced.settled = false;
  }
  synced.managed = mine;

  for (const dataDir of knownDataDirs(system, record)) {
    const service = await serviceState(dataDir);
    const managed = mine && dataDir === autoDataDir;
    if (service.state === 'held') {
      unfinished.push(service.elsewhere === undefined
        ? `数据目录 ${dataDir} 被进程 ${service.pid} 占着，而它没有回答自己是哪个版本：可能还在启动，或正在恢复备份。它结束后再运行一次升级。`
        : `数据目录 ${dataDir} 的锁在另一台机器上，本机改不了它。${elsewhereText(lockFile(dataDir), service.elsewhere)}`);
      synced.settled = false;
      continue;
    }
    const running = service.state === 'running';
    const ours = running && within(service.programDir, layout.prefix);
    if (running && !ours) cli.out(`数据目录 ${dataDir} 上运行的是另一份 tycho（${service.programDir}），没有动它。`);
    if (ours && !managed) {
      cli.out(`正在运行的服务（进程 ${service.pid}）还是原来那个版本：停掉它（tycho stop）再重新运行，才会用上这一个。`);
      synced.inUse.push(service.programDir);
    }
    if (!managed || !ours) continue;
    await waitForTurn(cli, service);
    if (!(await stopService(service, cli.timing))) {
      throw new Error(`原来的服务（进程 ${service.pid}）没有停下来。等它停了以后运行 tycho doctor --fix，再运行 tycho service start。`);
    }
    if (system.platform === 'linux') {
      // Wait for systemd to finish transitioning the unit from deactivating to inactive
      // so the subsequent `autostart.start` does not no-op on the exiting unit.
      try { autostartFor(system, 'host').stop(spec); } catch {}
    }
    cli.out('已停止原来的服务。');
    synced.restart = { dataDir, spec };
  }
  // The machine's client is not stopped and not restarted (nodes.md §4.2): it keeps running
  // the version it started from, and starts every new round's watch process out of that
  // directory, so that directory is in use for as long as it runs — through this upgrade and
  // the next. One that cannot say where it runs from leaves the cleanup undone. Every identity
  // under this data directory counts, not only this machine's: machines that share one home
  // and one installation each have their own client, and a lock held on another machine is a
  // directory this one cannot check but must keep (nodes.md §7).
  for (const dataDir of knownDataDirs(system, record)) {
    for (const client of clientsInUse(dataDir)) {
      const where = client.elsewhere === undefined ? '' : `（锁在机器 ${client.elsewhere} 上）`;
      if (client.programDir === null) {
        cli.out(`数据目录 ${dataDir} 上有机器客户端在跑（进程 ${client.pid}）${where}，但它没有说自己用的是哪个版本目录：这次不清理旧版本。`);
        synced.settled = false;
      } else if (within(client.programDir, layout.prefix)) {
        cli.out(`数据目录 ${dataDir} 上的机器客户端（进程 ${client.pid}）${where}还在用 ${client.programDir}：没有停它，那个目录留着；它空闲时会自己换到主机这一版。`);
        synced.inUse.push(client.programDir);
      }
    }
  }
  return synced;
}

// The definition this version would write, and the service started on it. Started only
// when this command stopped one: a service the owner keeps down is not started by an
// upgrade.
function syncAutostart(cli: Cli, layout: Layout, record: InstallRecord, version: string, restart: boolean, unfinished: string[]): void {
  const autostart = autostartFor(cli.system, 'host');
  const spec = specFor(cli.system, layout, record, version, 'host');
  try {
    autostart.install(spec, { start: false });
    cli.out('开机自启的定义已同步。');
  } catch (err) {
    unfinished.push(message(err));
  }
  if (!restart) return;
  try {
    autostart.start(spec);
    cli.out('已让服务用这个版本启动。');
  } catch (err) {
    unfinished.push(message(err));
  }
}

// The machine client's own definition, when this installation has one. The upgrade does not
// stop and does not start that program: the rounds it started are watched by their own
// processes, and a client replaced under them is exactly what a running round does not
// notice (docs/design/nodes.md §4.2, §4.4). What is rewritten is the definition alone, so
// that the next login starts the client this version's shape says.
function syncNodeAutostart(cli: Cli, layout: Layout, record: InstallRecord, version: string, unfinished: string[]): void {
  if (slotOf(record, 'node') === undefined) return;
  const autostart = autostartFor(cli.system, 'node');
  const spec = specFor(cli.system, layout, record, version, 'node');
  try {
    // Only a definition of this installation's is rewritten: another copy's, even on the
    // same computer, is not this one's to point at its own launcher. One that is missing is
    // not created here either — the owner installed it with `tycho node service install`.
    const held = autostart.state(spec);
    if (held.installed !== true || held.mine !== true) return;
    autostart.install(spec, { start: false });
    cli.out('机器客户端的开机自启定义已同步（它的客户端和正在跑的看管进程没有被停）。');
  } catch (err) {
    unfinished.push(`机器客户端的开机自启没同步：${message(err)}`);
  }
}

// ---- Cleaning up ----

const removeTree = (path: string): void => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// What may go: versions older than the one in use and the one before it, what an earlier
// install set aside, and what an installer that is no longer running left half done. Only
// directories this program's installer made, by what is in them and not by their name.
function removable(layout: Layout, keep: (string | null)[], placed: Placed, { inUse }: Synced): string[] {
  const used = (dir: string): boolean => inUse.some((each) => within(each, dir));
  const found: string[] = [];
  for (const name of readdirSync(layout.versions)) {
    const path = join(layout.versions, name);
    if (resolve(path) === resolve(placed.staged)) continue;
    const staging = STAGING.exec(name);
    if (staging) {
      // Another installer, unpacked and not yet at work, is not to lose its files.
      if (!isAlive(Number(staging[1]))) found.push(path);
    } else if (name.startsWith(REPLACED)) {
      // A service that was not restarted still runs from what was set aside.
      if (releaseVersion(path) !== null && inUse.length === 0) found.push(path);
    } else if (isVersion(name) && !keep.includes(name) && releaseVersion(path) === name && !used(path)) {
      found.push(path);
    }
  }
  return found;
}

function cleanUp(cli: Cli, layout: Layout, keep: (string | null)[], placed: Placed, synced: Synced, dataDirs: string[], unfinished: string[]): string[] {
  if (!synced.settled) {
    cli.out('旧版本的目录这次没有清理：上面有没确定的事。下次升级时再清。');
    return [];
  }
  const removed: string[] = [];
  for (const path of removable(layout, keep, placed, synced)) {
    const inside = dataDirs.find((dir) => within(dir, path));
    if (inside) {
      unfinished.push(`没有删旧的 ${path}：数据目录 ${inside} 在它里面。把数据挪到程序目录之外（或把 TYCHO_DATA 指到别处）。`);
      continue;
    }
    try {
      removeTree(path);
      removed.push(path);
    } catch (err) {
      unfinished.push(`旧的 ${path} 没删掉：${message(err)}`);
    }
  }
  if (placed.aside && existsSync(placed.aside) && !unfinished.some((line) => line.includes(placed.aside!))) {
    cli.out(`原来那一份留在 ${placed.aside}：还有服务在用它。那个服务停了以后，下次升级时清理。`);
  }
  return removed;
}

// ---- The release proving itself, or going back ----

interface Proving {
  version: string;
  previous: string | null;
  dataDir: string;
  spec: ServiceSpec;
  placed: Placed;
  // What the ledger was before the new version ever ran: what decides whether the old
  // program may have it back. Read before `current` was switched, so a candidate that
  // started in between cannot be mistaken for the state before the upgrade.
  ledgerBefore: LedgerPeek;
  // The install record as it was before this version rewrote it, when there was one.
  recordBefore: string | null;
}

// A release that cannot answer for itself goes back to the one before it, but only while
// every condition holds: nothing of the new one is still running, no process of its
// Router driver is left, and the ledger is at the version it was. The last is the reason
// there is no "undo" for a migration: the old program may not be able to open what the
// new one wrote.
async function verifyRelease(cli: Cli, layout: Layout, input: Proving): Promise<ReleaseOutcome> {
  const { version, previous, dataDir, spec } = input;
  cli.out('正在核对新版本：');
  // A candidate that was asked to start has this long to answer. One that never does, or
  // that died on its way up, is judged exactly like one that answered badly: a release that
  // cannot start is the case this whole path exists for.
  const came = await waitRunning(dataDir, cli.timing);
  if (came.state === 'died') {
    cli.err(`已让服务用 ${version} 启动，它起来过又退出了（进程 ${came.pid}）。${autostartOutput(cli.system, spec)}`);
  } else if (came.state === 'absent') {
    cli.err(`已让服务用 ${version} 启动，但过了 ${cli.timing.startWaitMs / 1000} 秒它还没起来。${autostartOutput(cli.system, spec)}`);
  } else if (came.state === 'starting' || came.state === 'unknown') {
    // Alive at the limit and holding the data directory, or a state this machine cannot
    // judge at all: no check is made, nothing is taken back, and this is not a release that
    // works either. What says which of the two it was is the check's pending steps.
    const check = unfinishedStart(version, came);
    for (const line of check.lines) cli.out(`  ${line}`);
    cli.out(came.state === 'starting'
      ? '新版本还在启动，还没核对完：用 tycho status 看它现在怎么样。'
      : '查不出新版本是还在启动还是已经退出：用 tycho status 看它现在怎么样。');
    return { check, rollback: null, from: previous, to: version };
  }
  const check = await checkRelease(cli.timing, { version, programDir: join(layout.versions, version), dataDir });
  for (const line of check.lines) cli.out(`  ${line}`);
  if (check.pending?.length) {
    return { check, rollback: null, from: previous, to: version };
  }
  if (check.ok) {
    cli.out(`新版 ${version} 通过健康检查。`);
    return { check, rollback: null, from: previous, to: version };
  }
  cli.err(`新版 ${version} 没有通过健康检查：${check.lines.at(-1) ?? ''}`);
  return { check, rollback: await rollBack(cli, layout, input), from: previous, to: version };
}

// A candidate, stopped for good before the version before it opens the same ledger. A service
// that answers is asked over HTTP first — the only clean stop there is on Windows — and the
// manager is told next, whether or not the candidate answered: one it starts again a few
// seconds later (the Windows loop) would come back while the old program is starting. Only
// then is the candidate confirmed gone, and the state is read again on every round, so one
// that begins to answer while this waits is asked too — the candidate that was merely slow to
// come up never got that ask. What is not confirmed gone is not reported as gone: whether the
// old program may have the ledger rests on this answer.
export async function stopCandidate(cli: Cli, spec: ServiceSpec, dataDir: string): Promise<{ running: boolean; pid: number | null; why: string }> {
  let pid: number | null = null;
  let asked = false;
  let unreadable = '';
  const read = async (): Promise<ServiceState | null> => {
    try {
      return await serviceState(dataDir);
    } catch (err) {
      unreadable = message(err);
      return null;
    }
  };
  const ask = async (state: Running): Promise<void> => {
    asked = true;
    try {
      await requestStop(state);
    } catch (err) {
      cli.out(`候选服务没有回答停止请求（${message(err)}），继续等它停。`);
    }
  };

  const first = await read();
  if (first !== null) {
    if (first.state !== 'stopped') pid = first.pid;
    if (first.state === 'running') await ask(first);
  }
  let managerProblem = '';
  try {
    autostartFor(cli.system, 'host').stop(spec);
  } catch (err) {
    managerProblem = message(err);
  }
  const deadline = Date.now() + cli.timing.stopWaitMs;
  for (;;) {
    const state = await read();
    if (state !== null && state.state === 'stopped') return { running: false, pid: null, why: '' };
    if (state !== null) pid = state.pid;
    if (state !== null && state.state === 'running' && !asked) await ask(state);
    if (Date.now() > deadline) break;
    await sleep(cli.timing.pollMs);
  }
  const what = `候选服务${pid === null ? '' : `（进程 ${pid}）`}`;
  const why = unreadable !== ''
    ? `查不出${what}还在不在：${unreadable}`
    : managerProblem === ''
      ? `${what}没有停下来：它的服务管理器也停过它了，它还在`
      : `${what}没有停下来，也没能让它的服务管理器停它：${managerProblem}`;
  return { running: true, pid, why };
}

// What is left of the Router drivers the ledger recorded: every project's, each not yet
// confirmed gone (docs/design/project-sessions.md §3). The marker is what ownership rests on:
// the pid is written as gone as soon as a process is torn down, while the processes it started
// can still be running — and one of them writing the ledger is the thing an old program must
// not meet. A scan that cannot be made is reported as unknown, which keeps the release where it is.
async function driverLeftovers(recorded: readonly PeekedDriver[], processes: Pick<Processes, 'find'>): Promise<{ marker: string; pids: number[] } | null> {
  const found = new Set<number>();
  const markers: string[] = [];
  for (const { marker, pid } of recorded) {
    const before = found.size;
    if (pid !== null && isAlive(pid)) found.add(pid);
    for (const each of await processes.find(marker)) found.add(each);
    if (found.size > before) markers.push(marker);
  }
  return found.size === 0 ? null : { marker: markers.join('、'), pids: [...found].sort((a, b) => a - b) };
}

async function rollBack(cli: Cli, layout: Layout, input: Proving): Promise<{ state: 'rolled-back' | 'kept'; why: string }> {
  const { version, previous, dataDir, spec, placed, ledgerBefore, recordBefore } = input;
  const kept = (why: string): { state: 'kept'; why: string } => {
    cli.err(`没有回退：${why}。`);
    return { state: 'kept', why };
  };

  // Whatever was on that data directory has to be gone before the old program opens the
  // same ledger; one that cannot be confirmed stopped is the one thing this must not skip.
  const candidate = await stopCandidate(cli, spec, dataDir);
  if (candidate.running) return kept(candidate.why);

  // The candidate is confirmed stopped just above: nobody writes the ledger now.
  const now = peekLedger(join(dataDir, 'ledger.db'), 'stopped');
  let driver: { marker: string; pids: number[] } | null = null;
  if (now.known) {
    try {
      driver = await driverLeftovers(now.routers, cli.processes ?? hostProcesses);
    } catch (err) {
      return kept(`查不出还有没有负责人进程残留（${message(err)}）：不能确认旧程序拿回账本时没有第二个写它的人`);
    }
  }
  const decision = rollbackDecision({ previous, candidate: { running: false, pid: null }, driver, ledger: { before: ledgerBefore, now } });
  if (!decision.go) return kept(decision.why);
  if (projectHomeEnabled(dataDir)) {
    const fallback = previous === version ? placed.aside : previous === null ? null : join(layout.versions, previous);
    if (fallback === null || declaredLedger(fallback).projectHome !== 1) {
      return kept('上一版无法核验项目归属，恢复写入前需使用支持项目归属的版本');
    }
  }

  try {
    if (previous === version) {
      // A reinstall of the same version: what place() set aside is the copy to go back to.
      if (placed.aside === null) return kept(`原来的那一份 ${version} 已经不在，没有可退的`);
      unplace(placed);
      cli.out(`已把原来那一份 ${version} 放回去。`);
    } else {
      writeCurrent(layout, previous!);
      cli.out(`已把 current 切回 ${previous}，账本没有动。`);
    }
    // The record goes back with the program: the version now in use reads it in its own
    // shape, with the autostart's data directory and PATH exactly as it kept them. What this
    // version added to it (its own directory) is not in there; a later upgrade's cleanup
    // finds that directory by its contents, not by the record.
    if (recordBefore !== null) {
      rename(recordBefore, layout.record);
      cli.out('安装记录也放回了升级前的那一份。');
    }
  } catch (err) {
    return kept(`切回 ${previous} 没成功：${message(err)}`);
  }

  // The definition in the system is the one this version wrote, and the record now in place
  // is the old one: written again from that record before the old program is started, so the
  // program in use is left managing a definition of its own shape, its own data directory and
  // its own PATH. Putting the record back is not that: the task or unit on the machine still
  // says what the version that was just taken back meant.
  const restored = readRecord(layout.prefix) ?? { files: [], paths: [] };
  const backSpec = specFor(cli.system, layout, restored, previous!, 'host');
  let definition = '';
  try {
    autostartFor(cli.system, 'host').install(backSpec, { start: false });
    cli.out(`${previous} 的开机自启定义也写回了它自己的那一份。`);
  } catch (err) {
    definition = message(err);
  }

  // The same way the upgrade started it, so what the owner finds is the autostart's doing
  // in both directions. Whether it comes back is said either way.
  try {
    autostartFor(cli.system, 'host').start(backSpec);
  } catch (err) {
    const why = `${previous} 已经切回来，但让它启动没成功：${message(err)}`;
    cli.err(`${why}。`);
    return { state: 'rolled-back', why };
  }
  const back = await waitRunning(dataDir, cli.timing);
  // The old version gets the same reading as the new one did: one that is alive and has not
  // answered is still starting, and one whose state cannot be judged is unknown. Neither is
  // said to have failed, and the version has already been switched back either way.
  if (back.state === 'starting' || back.state === 'unknown') {
    const why = back.state === 'starting'
      ? `${previous} 已经切回来，它还在启动（进程 ${back.pid}）、还没有回答`
      : `${previous} 已经切回来，但查不出它有没有起来：${back.why}`;
    cli.out(`${why}。用 tycho status 看它现在怎么样。`);
    return { state: 'rolled-back', why };
  }
  if (back.state !== 'running') {
    const why = back.state === 'died'
      ? `${previous} 已经切回来，但它起来过又退出了（进程 ${back.pid}）`
      : `${previous} 已经切回来，但过了 ${cli.timing.startWaitMs / 1000} 秒它还没起来`;
    cli.err(`${why}。`);
    return { state: 'rolled-back', why };
  }
  cli.out(`服务已用 ${previous} 重新启动。`);
  return { state: 'rolled-back', why: definition === '' ? '' : `${previous} 已经切回来，但它的开机自启定义没写回去：${definition}` };
}

// ---- install-self ----

const toRecord = (prefix: string, path: string): string => relative(prefix, path).split(sep).join('/');

interface InstallSelfInput {
  // Only default GitHub selection: decide against current while holding the prefix lock.
  onlyUpgrade?: boolean;
  prefix: string;
  node: string;
  // The version the console confirmed, when this release was asked for from there: the
  // package's own manifest has to say the same. Absent for a command run by hand.
  expectVersion?: string;
  // Selected from GitHub or the console: only a release that proves,
  // before anything is switched, that it leaves the ledger where it is may go this way.
  automatic?: boolean;
}

// Run by the release itself, from wherever it was unpacked. The write of `current` is
// the commit point. A failure before it puts everything back as it was, and the service
// that was stopped for it is started again on the version still in use. After it the new
// version is in use: nothing is put back blindly, but a release that cannot answer for
// itself and left the ledger where it was is taken back to the version before it.
export async function installSelf(cli: Cli, input: InstallSelfInput): Promise<number> {
  const { prefix: given, node } = input;
  const version = appVersion(cli.appRoot);
  if (releaseVersion(cli.appRoot) !== version) throw new Error(`${cli.appRoot} 不是 tycho 的发布包。`);
  if (input.expectVersion !== undefined && input.expectVersion !== version) {
    throw new Error(`这个包里的程序版本是 ${version}，确认要装的是 ${input.expectVersion}：包和确认的不是同一个，什么都没有装。`);
  }
  // One spelling of the prefix everywhere: what goes into the launcher, PATH and the
  // autostart is compared later with where a running copy finds itself.
  mkdirSync(given, { recursive: true });
  const layout = layoutOf(realpathSync.native(given));
  const unlock = lockPrefix(cli, layout);
  if (!unlock) return 1;
  try {
    return await installLocked(cli, layout, version, node, input.automatic === true, input.onlyUpgrade === true);
  } finally {
    unlock();
  }
}

// What a release declares about itself in its own manifest: the ledger schema it writes,
// and, for a person reading it, why it may be taken back. Null when it declares nothing,
// which the automatic path treats as "cannot be proven".
function declaredLedger(appRoot: string): { ledger: number | null; basis: string | null; projectHome: number | null } {
  try {
    const { tycho } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { tycho?: { ledger?: unknown; basis?: unknown; project_home?: unknown } };
    return {
      projectHome: tycho?.project_home === 1 ? 1 : null,
      ledger: Number.isInteger(tycho?.ledger) ? (tycho!.ledger as number) : null,
      basis: typeof tycho?.basis === 'string' && tycho.basis.trim() !== '' ? tycho.basis : null,
    };
  } catch {
    return { ledger: null, basis: null, projectHome: null };
  }
}

// §3.5: the automatic path takes back a release that fails, and it can only take back
// what did not move the ledger. The release declares the schema it writes and why it may
// be taken back; that the declaration is true is checked against the program itself, and
// it is checked against the ledger before anything is stopped or switched. What cannot be
// proven goes by hand.
function requireCompatible(cli: Cli, dataDirs: string[]): void {
  const { ledger: declared, basis } = declaredLedger(cli.appRoot);
  if (declared === null || basis === null) {
    throw new Error(`${join(cli.appRoot, 'package.json')} 里没有声明这一版写的账本版本和能退回上一版的依据（tycho.ledger、tycho.basis）：联网或控制台上线只走能证明可以退回上一版的包。这个包要人工上线：tycho update --from <包>`);
  }
  if (declared !== SCHEMA_VERSION) {
    throw new Error(`这个包声明它写的账本是版本 ${declared}，它自己的程序却是 ${SCHEMA_VERSION}：声明和程序对不上，这一版没有装。`);
  }
  for (const dataDir of dataDirs) {
    // Nothing is stopped yet: the service may be writing the ledger as this reads it.
    const now = peekLedger(join(dataDir, 'ledger.db'), 'live');
    if (!now.known) throw new Error(`读不出 ${dataDir} 里的账本（${now.error}）：不能确认这一版不会动它。要装就人工上线：tycho update --from <包>`);
    if (now.version !== null && now.version !== declared) {
      throw new Error(`账本现在是版本 ${now.version}，这一版要写到 ${declared}：账本会变的版本不走自动上线（改坏了退不回去）。要装就人工上线：tycho update --from <包>`);
    }
  }
}

async function installLocked(cli: Cli, layout: Layout, version: string, node: string, automatic: boolean, onlyUpgrade: boolean): Promise<number> {
  const { system } = cli;
  const { prefix } = layout;
  const previous = readCurrent(prefix);
  if (onlyUpgrade && previous !== null) {
    // This is the installation's current version, read under its own prefix lock.
    // Download-time observations cannot decide whether a candidate is an upgrade.
    const numeric = (value: string): bigint[] | undefined => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(BigInt) : undefined;
    const have = numeric(previous), next = numeric(version);
    if (!have || !next) {
      cli.err(`无法比较当前版本 ${previous} 和候选 ${version}，默认联网升级没有换版；请明确选择版本或人工使用 tycho update --from <发布包>。`);
      return 1;
    }
    const different = next.findIndex((part, index) => part !== have[index]);
    if (different !== -1 && next[different]! < have[different]!) {
      cli.err(`候选版本 ${version} 比当前 ${previous} 更旧，默认联网升级不降级，什么都没有换；确实要切换请明确选择版本或用 tycho update --from <发布包>。`);
      return 1;
    }
  }
  const record: InstallRecord = readRecord(prefix) ?? { files: [], paths: [] };
  const dataDirs = knownDataDirs(system, record);
  const target = join(layout.versions, version);
  const unfinished: string[] = [];
  // Where the console reads how this attempt ended. The data directory the service runs
  // on, once that is known: the one this terminal was started with can be another.
  let resultDir = dataDirOf(system.env, system.home);
  const report = (fields: { verified: boolean; ok: boolean; pending?: string[]; rolledBack: boolean; lines: string[] }): void => {
    if (!existsSync(resultDir)) return;
    try {
      writeReleaseResult(resultDir, {
        at: new Date().toISOString(),
        from: previous,
        to: version,
        verified: fields.verified,
        ...(fields.pending ? { pending: fields.pending } : {}),
        ok: fields.ok,
        rolled_back: fields.rolledBack,
        in_use: readCurrent(prefix),
        lines: fields.lines,
      });
    } catch (err) {
      cli.err(`上线结果没有记到 ${resultDir}：${message(err)} 控制台里也就看不到它。`);
    }
  };

  // Refuse a release which could write a managed project without its ownership guard.
  // This check covers the manual installer as well as automatic releases.
  if (dataDirs.some(projectHomeEnabled) && declaredLedger(cli.appRoot).projectHome !== 1) {
    const lines = ['这份程序不支持项目归属，无法安装到启用了项目移交的环境。'];
    cli.err(lines[0]!);
    report({ verified: false, ok: false, rolledBack: false, lines });
    return 1;
  }
  // Before anything moves: a release the automatic path may not take back at all is
  // refused while the service is still running and the ledger is untouched.
  if (automatic) {
    try {
      requireCompatible(cli, dataDirs);
    } catch (err) {
      const lines = [`没有上线 ${version}：${message(err)}`, `这次什么都没有换：还是在 ${previous ?? '（没有装过）'}。`];
      for (const line of lines) cli.err(line);
      report({ verified: false, ok: false, rolledBack: false, lines });
      return 1;
    }
  }

  let placed: Placed | undefined;
  let launchers: Record<string, string | null> | undefined;
  try {
    // Setting this directory aside would carry the data off with it.
    const inside = existsSync(target) && resolve(target) !== resolve(cli.appRoot) ? dataDirs.find((dir) => within(dir, target)) : undefined;
    if (inside) throw new Error(`数据目录 ${inside} 在要被换掉的 ${target} 里面。先把数据挪到程序目录之外（或把 TYCHO_DATA 指到别处）。`);
    placed = place(cli.appRoot, layout, version);
    launchers = savedLaunchers(prefix, system.platform);
    writeLaunchers({ prefix, node, platform: system.platform });
  } catch (err) {
    let restored = '';
    try {
      if (launchers) restoreLaunchers(prefix, launchers);
      if (placed) unplace(placed);
    } catch (again) {
      restored = message(again);
    }
    const scene = restored === ''
      ? (previous === null ? '程序目录里什么都没有换。' : `仍在用 ${previous}，和安装前一样。`)
      : `恢复现场时又出了错：${restored}。现在 current 指的是 ${readCurrent(prefix) ?? '（没有）'}${placed?.aside ? `，原来的那一份在 ${placed.aside}` : ''}。运行 tycho doctor 看现场，或重新运行安装脚本。`;
    cli.err(`没有装上 ${version}：${message(err)} ${scene}`);
    report({ verified: false, ok: false, rolledBack: false, lines: [`没有装上 ${version}：${message(err)}`, scene] });
    return 1;
  }

  // Everything of this installation is stopped before `current` names the new version:
  // from that moment on, anything that starts the service starts the candidate.
  let synced: Synced;
  try {
    synced = await stopServices(cli, layout, record, version, unfinished);
  } catch (err) {
    let restored = '';
    try {
      restoreLaunchers(prefix, launchers);
      unplace(placed);
    } catch (again) {
      restored = message(again);
    }
    const scene = restored === ''
      ? `这次什么都没有换：还是在 ${previous ?? '（没有装过）'}。`
      : `恢复现场时又出了错：${restored}。现在 current 指的是 ${readCurrent(prefix) ?? '（没有）'}。运行 tycho doctor 看现场。`;
    cli.err(`没有上线 ${version}：${message(err)} ${scene}`);
    report({ verified: false, ok: false, rolledBack: false, lines: [`没有上线 ${version}：${message(err)}`, scene] });
    return 1;
  }

  // What the ledger was before the new version could have touched it. Read here — after
  // everything is stopped, before `current` changes — because a candidate that starts in
  // between would make "before" mean something that already ran the new version.
  const ledgerBefore = new Map(dataDirs.map((dataDir) => [dataDir, peekLedger(join(dataDir, 'ledger.db'), 'stopped')]));
  if (synced.restart) resultDir = synced.restart.dataDir;

  try {
    writeCurrent(layout, version);
  } catch (err) {
    let restored = '';
    let back = '';
    try {
      restoreLaunchers(prefix, launchers);
      unplace(placed);
      // The service was stopped for a switch that did not happen: it goes back up on the
      // version that is still in use.
      if (synced.restart) {
        autostartFor(system, 'host').start(synced.restart.spec);
        back = `原来那个服务已按 ${previous ?? '（原来的版本）'} 重新启动。`;
      }
    } catch (again) {
      restored = message(again);
    }
    const scene = restored === ''
      ? `这次什么都没有换：还是在 ${previous ?? '（没有装过）'}。${back}`
      : `恢复现场时又出了错：${restored}。现在 current 指的是 ${readCurrent(prefix) ?? '（没有）'}。运行 tycho doctor 看现场。`;
    cli.err(`没有装上 ${version}：${message(err)} ${scene}`);
    report({ verified: false, ok: false, rolledBack: false, lines: [`没有装上 ${version}：${message(err)}`, scene] });
    return 1;
  }

  // The service that was stopped and is to run on the new version, if there was one.
  const restart = synced.restart;
  if (previous === null) cli.out(`tycho ${version} 已装到 ${prefix}。`);
  else if (previous === version) cli.out(`tycho ${version} 已重新装好。`);
  else cli.out(`tycho 已从 ${previous} 升级到 ${version}。`);
  // Nothing was stopped and nothing will be started on it: this version has not run, and
  // saying only "升级到" would read as one that had.
  if (restart === undefined) cli.out(unverifiedLine(version, synced.inUse.length > 0));

  // The record as the version before wrote it, kept byte for byte until this version has
  // proved itself: a rollback puts it back with the program, so the old version reads a
  // record of its own shape rather than one this version rewrote (see rollBack).
  let recordBefore: string | null = null;
  try {
    copyFileSync(layout.record, layout.recordBefore);
    recordBefore = layout.recordBefore;
  } catch {
    // No record yet: a first install has nothing to go back to, and nothing to keep.
  }
  const save = (): void => {
    try {
      writeRecord(prefix, record);
    } catch (err) {
      unfinished.push(`安装记录 ${layout.record} 没写成：${message(err)} 以后卸载会分不清哪些是安装器放的；重新运行一次安装脚本补上它。`);
    }
  };
  const owned = new Set(record.files);
  owned.add(toRecord(prefix, placed.target));
  owned.add(toRecord(prefix, layout.current));
  for (const name of launcherNames(system.platform)) owned.add(toRecord(prefix, join(layout.bin, name)));
  // A Node the install script brought along is the installer's too.
  if (within(node, layout.node)) owned.add(toRecord(prefix, real(node)));
  record.files = [...owned];
  save();

  if (system.env.TYCHO_NO_MODIFY_PATH) {
    cli.out(`按你的要求没有改 PATH。命令在 ${launcherPath(prefix, system.platform)}。`);
  } else {
    try {
      const { changed, where, record: added } = addToPath(system, layout.bin);
      if (added) {
        record.paths.push(added);
        save();
      }
      if (changed) cli.out(`已把 ${layout.bin} 加进 PATH（${where}）。新开一个终端，tycho 命令才找得到。`);
    } catch (err) {
      unfinished.push(`没能把 ${layout.bin} 加进 PATH：${message(err)} 请自己加上。`);
    }
  }

  // The definition this version would write, and the service started on it. A start that
  // does not work out is not the end of it: it is judged with everything else. Only a
  // definition of this installation's is rewritten; another copy's is left alone.
  if (synced.managed) syncAutostart(cli, layout, record, version, restart !== undefined, unfinished);
  // The machine client's definition, when this installation has one. Nothing of that
  // program is stopped here, and a round running under it keeps running (nodes.md §4.2).
  syncNodeAutostart(cli, layout, record, version, unfinished);

  const outcome = restart === undefined
    ? null
    : await verifyRelease(cli, layout, {
      version,
      previous,
      dataDir: restart.dataDir,
      spec: restart.spec,
      placed,
      ledgerBefore: ledgerBefore.get(restart.dataDir) ?? { known: true, version: null, routers: [] },
      recordBefore,
    });
  // A release that went back leaves both versions in place and nothing to tidy: what was
  // cleaned up here could be the only way back to a working program.
  if (outcome !== null && outcome.rollback !== null) synced.settled = false;
  const removed = cleanUp(cli, layout, [version, previous], placed, synced, dataDirs, unfinished);
  if (removed.length > 0) {
    const gone = new Set(removed.map((path) => toRecord(prefix, path)));
    record.files = record.files.filter((file) => !gone.has(file));
    save();
  }
  // Settled either way: the record in place is the one that stands, and the copy goes.
  if (outcome?.rollback?.state !== 'rolled-back') rmSync(layout.recordBefore, { force: true });

  const code = unfinished.length === 0 && (outcome === null || outcome.check.ok) ? 0 : 1;
  // A version that was never run is not a success, whatever else went right: the record is
  // what the console shows, and `ok` there is not the command's exit code.
  const verified = outcome !== null && !outcome.check.pending?.length;
  report({
    verified,
    ok: verified && code === 0,
    ...(outcome?.check.pending ? { pending: outcome.check.pending } : {}),
    rolledBack: outcome?.rollback?.state === 'rolled-back',
    lines: [
      previous === null ? `tycho ${version} 已装到 ${prefix}。` : previous === version ? `tycho ${version} 已重新装好。` : `tycho 已从 ${previous} 升级到 ${version}。`,
      ...(outcome === null ? [unverifiedLine(version, synced.inUse.length > 0)] : outcome.check.lines.map((line) => `核对：${line}`)),
      ...(outcome?.rollback ? [outcome.rollback.state === 'rolled-back' ? releaseOutcomeLine(outcome, version, previous) : `没有回退：${outcome.rollback.why}`] : []),
      ...unfinished,
    ],
  });

  if (previous === null) {
    cli.out('下一步：');
    cli.out('  tycho run --open        前台运行，并在浏览器里打开控制台');
    cli.out('  tycho service install   装成开机自启');
    cli.out('  tycho doctor            自检');
  }
  if (code === 0) return 0;
  if (unfinished.length > 0) {
    cli.err(`已经切到 ${version}，但下面的事没有做成：`);
    for (const line of unfinished) cli.err(`  ${line}`);
  }
  // Nothing was verified here, so there is no outcome to report: what there is to say about
  // the version itself has been said above.
  if (outcome !== null) cli.err(releaseOutcomeLine(outcome, version, previous));
  return 1;
}

// ---- update ----

const NOT_INSTALLED = '这是源码目录里的 tycho，不是安装脚本装的那一份';

interface UpdateOptions {
  // Explicit GitHub release version; default selects the latest stable release.
  to?: string;
  // The digest the console confirmed the package by. Checked on the file as it is here
  // now: a package replaced or damaged since the click is not the one that was approved.
  expectSha256?: string;
  // The version the console confirmed: the package's own manifest has to say the same.
  expectVersion?: string;
  // Selected from GitHub or the console: only a release that
  // proves it leaves the ledger where it is goes this way.
  automatic?: boolean;
}

const sha256Of = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

export async function update(cli: Cli, from: string | undefined, options: UpdateOptions = {}): Promise<number> {
  const { system } = cli;
  const prefix = prefixOf(cli.appRoot);
  if (prefix === null) {
    cli.err(`${NOT_INSTALLED}：用 git pull 更新它。`);
    return 1;
  }
  const layout = layoutOf(prefix);
  const before = readCurrent(prefix);
  let expectVersion = options.expectVersion;
  let automatic = options.automatic === true;
  let onlyUpgrade = false;
  let githubVersion: string | undefined;
  // With this process's id in the name: another installer cleaning up leaves alone what
  // a live one is still unpacking.
  const staging = mkdtempSync(join(layout.versions, `.staging-${process.pid}-`));
  const download = `${staging}.tar.gz`;
  try {
    if (from !== undefined && statSync(from, { throwIfNoEntry: false })?.isDirectory()) {
      cpSync(from, staging, { recursive: true });
    } else {
      if (from === undefined) {
        const url = system.env.TYCHO_RELEASE_URL;
        if (url) {
          cli.out(`正在下载 ${url}`);
          const fetched = system.exec(tool(system, 'curl'), ['-fsSL', '-o', download, url], { timeoutMs: 180_000 });
          if (fetched.code !== 0) throw new Error(`下载 ${url} 没成功：${said(fetched)}。也可以先下载好，再用 tycho update --from <文件>。`);
        } else {
          cli.out(options.to === undefined ? '正在查询 GitHub 稳定发行版。' : `正在下载 GitHub 发行版 ${options.to}。`);
          const release = await fetchGitHubRelease(system, download, { version: options.to });
          githubVersion = release.version;
          if (expectVersion !== undefined && expectVersion !== release.version) throw new Error('GitHub 发行版本与确认的版本不一致，什么都没有解开。');
          expectVersion = release.version;
          automatic = true;
          onlyUpgrade = options.to === undefined;
        }
      } else if (existsSync(from)) {
        copyFileSync(from, download);
      } else {
        throw new Error(`找不到 ${from}。`);
      }
      // Before anything is unpacked: what is here now has to be the file the console
      // confirmed, not one that replaced it since.
      if (options.expectSha256 !== undefined) {
        const found = sha256Of(download);
        if (found !== options.expectSha256) {
          throw new Error(`这个包的内容和确认时的不一样（现在是 ${found.slice(0, 16)}…，确认的是 ${options.expectSha256.slice(0, 16)}…）：什么都没有解开。重新下载或重新验收这一轮，再上线。`);
        }
      }
      // By names relative to the versions directory: the tar that ships with Windows
      // takes its arguments in the system code page, which not every path survives.
      const problem = archiveProblem(system, basename(download), layout.versions);
      if (problem !== null) throw new Error(`${from ?? '下载的发布包'} 不能用：${problem}。什么都没有解开。`);
      const unpacked = system.exec(tool(system, 'tar'), ['-xzf', basename(download), '-C', basename(staging)], { cwd: layout.versions });
      if (unpacked.code !== 0) throw new Error(`解不开 ${from ?? '下载的发布包'}：${said(unpacked)}。`);
    }
    const entry = join(staging, 'cli', 'main.ts');
    if (!existsSync(entry) || !existsSync(join(staging, 'package.json'))) {
      throw new Error(`${from ?? '下载的文件'} 不是 tycho 的发布包。`);
    }
    // The new version installs itself: it knows its own launcher and service definition,
    // and it says how the install ended, before the switch or after it. What the console
    // confirmed travels with it: the version, and whether this is the automatic path.
    // Updating this copy must not change which installation the global command selects.
    const installed = system.exec(system.execPath, [
      entry, 'install-self', '--prefix', prefix, '--node', system.execPath,
      ...(expectVersion === undefined ? [] : ['--expect-version', expectVersion]),
      ...(automatic ? ['--automatic'] : []),
      ...(onlyUpgrade ? ['--only-upgrade'] : []),
    ], { env: { TYCHO_NO_MODIFY_PATH: '1' } });
    for (const line of installed.stdout.split('\n')) if (line.trim() !== '') cli.out(line.trimEnd());
    for (const line of installed.stderr.split('\n')) if (line.trim() !== '') cli.err(line.trimEnd());
    if (githubVersion !== undefined && installed.code !== 0) cli.err(`若需要人工上线，请先用 gh release download v${githubVersion} --repo github.com/XaineChaeson/tycho --pattern tycho.tar.gz 下载同版包，再用 tycho update --from tycho.tar.gz；账本变化前后数据的取舍见部署手册。`);
    return installed.code === 0 ? 0 : 1;
  } catch (err) {
    cli.err(`升级没有完成，仍在用 ${before ?? '原来的版本'}：${message(err)}`);
    return 1;
  } finally {
    removeTree(staging);
    rmSync(download, { force: true });
  }
}

// ---- uninstall ----

// What a hidden helper runs once this process has ended: Windows will not delete a
// program that is running, and a private Node is the one running this. The helper
// checks each target again when it acts: still inside the prefix, and not a link.
export function deferredRemoval(prefix: string, targets: string[], pid: number): string {
  return [
    `$prefix = ${psQuote(prefix)}`,
    `$targets = @(${targets.map(psQuote).join(', ')})`,
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    `$root = [IO.Path]::GetFullPath($prefix).TrimEnd('\\') + '\\'`,
    'foreach ($target in $targets) {',
    '  $full = [IO.Path]::GetFullPath($target)',
    '  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { continue }',
    '  $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue',
    '  if ($null -eq $item -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }',
    '  Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue',
    '  $dir = Split-Path -Parent $full',
    // Emptied directories go too, up to and including the prefix, never above it.
    `  while (($dir + '\\').StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) {`,
    '    Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue',
    '    $dir = Split-Path -Parent $dir',
    '  }',
    '}',
  ].join('\n');
}

// Whether a recorded path still is what the installer put there. A version directory
// holds this program's release under its own number; a launcher carries the installer's
// mark; `current` and a private Node are plain files.
function stillOurs(layout: Layout, path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (dirname(path) === layout.versions) return stat.isDirectory() && releaseVersion(path) === basename(path);
  if (!stat.isFile()) return false;
  if (dirname(path) === layout.bin) return parseLauncher(readFileSync(path, 'utf8')) !== null;
  return true;
}

// Empty directories the installer made, innermost first. One that holds anything of the
// owner's stays.
function removeEmptied(layout: Layout, removed: string[]): void {
  const dirs = new Set<string>([layout.versions, layout.bin, layout.node]);
  for (const path of removed) {
    for (let dir = dirname(path); dir !== layout.prefix && within(dir, layout.prefix); dir = dirname(dir)) dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty, or not there.
    }
  }
}

export async function uninstall(cli: Cli): Promise<number> {
  const prefix = prefixOf(cli.appRoot);
  if (prefix === null) {
    cli.err(`${NOT_INSTALLED}，没有装下的东西可卸：删掉这个目录就行。开机自启用 tycho service uninstall 卸。`);
    return 1;
  }
  const layout = layoutOf(prefix);
  const unlock = lockPrefix(cli, layout);
  if (!unlock) return 1;
  let code: number;
  try {
    code = await uninstallLocked(cli, layout);
  } finally {
    unlock();
  }
  // After the lock file is gone: it is the last thing in the prefix.
  try {
    rmdirSync(prefix);
  } catch {
    // Something of the owner's is in there, or files still in use on Windows.
  }
  return code;
}

async function uninstallLocked(cli: Cli, layout: Layout): Promise<number> {
  const { system } = cli;
  const { prefix } = layout;
  const record = readRecord(prefix);
  if (record === null) {
    cli.err(`${prefix} 里没有安装记录（${layout.record}），分不清哪些是安装器放的，所以什么都没有删。重新运行一次安装脚本，它会补上记录，然后再卸载。`);
    return 1;
  }
  const dataDirs = knownDataDirs(system, record);
  // What an earlier install set aside is the installer's as well.
  const aside = existsSync(layout.versions)
    ? readdirSync(layout.versions).filter((name) => name.startsWith(REPLACED)).map((name) => join(layout.versions, name)).filter((path) => releaseVersion(path) !== null)
    : [];
  const targets = [...record.files.map((file) => join(prefix, file)).filter((path) => path !== prefix && within(path, prefix)), ...aside];

  // Before anything is removed: the data is never under something this deletes.
  for (const dataDir of dataDirs) {
    const over = targets.find((target) => within(dataDir, target));
    if (over) {
      cli.err(`数据目录 ${dataDir} 在要删的 ${over} 里面，所以什么都没有删。先把数据挪到程序目录之外（或把 TYCHO_DATA 指到别处），再卸载。`);
      return 1;
    }
  }

  const states: [string, ServiceState][] = [];
  for (const dataDir of dataDirs) states.push([dataDir, await serviceState(dataDir)]);
  for (const [dataDir, service] of states) {
    if (service.state !== 'held') continue;
    cli.err(service.elsewhere === undefined
      ? `数据目录 ${dataDir} 正被进程 ${service.pid} 占着，而它没有回答自己是不是这一份 tycho（可能还在启动，或正在恢复备份）。等它结束再卸载；什么都没有卸。`
      : `数据目录 ${dataDir} 的锁在另一台机器上，本机卸不了它。${elsewhereText(lockFile(dataDir), service.elsewhere)}`);
    return 1;
  }
  for (const [dataDir, service] of states) {
    if (service.state !== 'running') continue;
    // Only a service of this installation: another copy on the same data directory keeps working.
    if (!within(service.programDir, prefix)) {
      cli.out(`数据目录 ${dataDir} 上运行的是另一份 tycho（${service.programDir}），没有停它。`);
      continue;
    }
    if (!(await stopService(service, cli.timing))) {
      cli.err(`服务（进程 ${service.pid}）没有停下来，什么都没卸。等它停了再试。`);
      return 1;
    }
    cli.out('已停止服务。');
  }

  // The machine's client, when it is this installation's: a client left running would keep
  // taking work from the host and then start a watch process out of a program that is no
  // longer there. It is asked to leave by its own mark, never through its service manager
  // (whose stop would end the rounds it started, nodes.md §4.2), and waited for; the watch
  // processes it started and the rounds' evidence stay. One that cannot say where it runs
  // from is not known to be this installation's, and is not stopped — nor deleted under.
  for (const dataDir of dataDirs) {
    const client = runningClient(dataDir);
    if (client === undefined) continue;
    if (client.programDir === null) {
      cli.err(`数据目录 ${dataDir} 上有机器客户端在跑（进程 ${client.pid}），但它没有说自己是哪一份 tycho 的，不能确定要不要停它，所以什么都没卸。先停掉它（tycho node service stop，手工运行的按 Ctrl+C）再卸载。`);
      return 1;
    }
    if (!within(client.programDir, prefix)) {
      cli.out(`数据目录 ${dataDir} 上跑着另一份 tycho 的机器客户端（${client.programDir}），没有停它。`);
      continue;
    }
    requestClientStop(client.identity, client.pid);
    const deadline = Date.now() + cli.timing.stopWaitMs;
    while (readClientHolder(client.identity)?.pid === client.pid) {
      if (Date.now() > deadline) {
        cli.err(`已请机器客户端（进程 ${client.pid}）退出，但过了 ${cli.timing.stopWaitMs / 1000} 秒它还在，什么都没卸。它如果是手工运行的，到那个终端按 Ctrl+C，再卸载。`);
        return 1;
      }
      await sleep(cli.timing.pollMs);
    }
    cli.out(`已请机器客户端（进程 ${client.pid}）退出。它起的看管进程不受影响，正在跑的轮次会跑完。`);
  }

  // Both roles' definitions go, each only when it is this installation's: a client left
  // behind would start a program that is no longer there at every login. What each role's
  // data directory holds — the tasks, the rounds' evidence and the client's own identity —
  // is not touched here: an uninstall removes the program, never the work.
  for (const role of ['host', 'node'] as const) {
    const autostart = autostartFor(system, role);
    try {
      const spec = installedSpec(system, cli.appRoot, role);
      for (const line of autostart.uninstall(spec)) cli.out(line);
    } catch (err) {
      cli.err(`${role === 'node' ? '机器客户端的开机自启' : '开机自启'}没卸成：${message(err)} 程序和 PATH 还没有动；处理好之后再运行 tycho uninstall。`);
      return 1;
    }
  }

  const left: string[] = [];
  if (system.env.TYCHO_NO_MODIFY_PATH) {
    if (record.paths.length > 0) cli.out('按你的要求没有改 PATH：安装时加的那一条还在，请自己去掉。');
  } else {
    for (const added of record.paths) {
      try {
        const { changed, where } = removeFromPath(system, added);
        if (changed) cli.out(`已从 PATH 里去掉 ${layout.bin}（${where}）。`);
      } catch (err) {
        left.push(`PATH 里的 ${layout.bin} 没去掉：${message(err)}`);
      }
    }
  }

  const removed: string[] = [];
  const busy: string[] = [];
  for (const path of targets) {
    if (!existsSync(path)) continue;
    if (!aside.includes(path) && !stillOurs(layout, path)) {
      left.push(`${path} 已经不是安装器放的那个了，没有删。`);
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(path);
    } catch {
      busy.push(path);
    }
  }
  if (busy.length === 0) rmSync(layout.record, { force: true });
  // A copy an interrupted upgrade left behind is the installer's too.
  rmSync(layout.recordBefore, { force: true });
  removeEmptied(layout, removed);

  let later = false;
  if (busy.length > 0) {
    // The record goes last, with them: until then it still says what is the installer's.
    const waiting = [...busy, layout.record, layout.lock];
    const problem = system.platform === 'win32'
      ? system.launch(tool(system, 'powershell'), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedCommand(deferredRemoval(prefix, waiting, process.pid))])
      : '这个系统上没有延后删除的办法';
    if (problem === null) later = true;
    else left.push(`这些文件正被占用，没删掉（${problem}）。这条命令结束后请自己删：${[...busy, layout.record].join('、')}`);
  }

  if (later) cli.out(`还在用的文件（${busy.join('、')}）交给了一个后台助手，这条命令结束后由它删掉。过几秒看一下 ${prefix} 还在不在，还在就自己删。`);
  else if (left.length === 0) cli.out(existsSync(layout.bin) || existsSync(layout.versions) ? `已删除安装器放在 ${prefix} 里的程序；里面别的东西没有动。` : `已删除装在 ${prefix} 里的程序。`);
  cli.out(`你的数据没有动，还在 ${dataDirs.join('、')}。不要了就自己删掉。`);
  for (const line of left) cli.err(line);
  return left.length > 0 ? 1 : 0;
}
