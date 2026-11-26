// Starting the command that puts a release in place, so that it outlives the service that
// asked for it. The command stops that service and switches the version under it: a child
// of the service is killed with it, and what is killed where is a property of the manager.
//
// - Linux: systemd collects everything in a unit's cgroup when the unit stops, whatever
//   session or process group a leftover made for itself (KillMode=mixed, the unit this
//   repository writes). A transient unit of its own is out of that cgroup, so
//   `systemd-run --user` is tried first. Without it — a service nobody manages, or a
//   machine with no user manager — a detached process is enough, and that it may not be
//   is said rather than hidden.
// - Windows: Task Scheduler ends the processes of a task instance when that instance
//   ends, and the service's own task ends as soon as the service exits cleanly. A second,
//   triggerless task of its own is a task instance that has nothing to do with the
//   service's, so the upgrade is not in what ends. Nothing here creates an on-demand task
//   that could ever start by itself: it has no trigger at all.
// - macOS: launchd ends the job's process group, and `detached` gives the child a session
//   of its own, which is outside it. The service's own plist restarts it only after a
//   failure (`KeepAlive`/`SuccessfulExit` false), so a clean stop stays stopped.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holderAlive, readHolder } from '../service/lock.ts';
import { conhostPath, encodedCommandLine, psQuote, windowsAction, xmlText } from './autostart.ts';
import { layoutOf } from './paths.ts';
import type { System } from './system.ts';
import { said, tool } from './system.ts';

export const UPGRADE_TASK = 'tycho-upgrade';

interface UpgradePlan {
  // The installed command: the launcher, which reads `current` and so survives the switch.
  launcher: string;
  // The package file the console confirmed.
  packageFile: string;
  // The version the package says it is, and the digest it was confirmed by: the command
  // checks both again before it installs anything.
  version: string;
  sha256: string;
  // The data directory the release acts on: the network the manager starts it in carries
  // no environment.
  dataDir: string;
}

// What the upgrade command is asked to do, as the words of a command line.
export function upgradeArgs({ packageFile, version, sha256 }: UpgradePlan): string[] {
  return ['update', '--from', packageFile, '--expect-version', version, '--expect-sha256', sha256, '--automatic'];
}

// Null once it is started; otherwise why it was not. The line says how it was started:
// which of the ways above was the one that worked.
export type UpgradeStarter = (plan: UpgradePlan) => string | null;

// Whether an upgrade command is at work in this program directory. It holds the install
// lock from before anything is switched until the rollback, the cleanup and the record of
// the result are done: while it is held, a second release is not started.
export function upgradeRunning(prefix: string): boolean {
  const holder = readHolder(layoutOf(prefix).lock);
  return holder !== undefined && holderAlive(holder);
}

// The default. `log` is told which way was taken and why a way was passed over.
export function upgradeStarter(system: System, log: (line: string) => void): UpgradeStarter {
  const detach = (plan: UpgradePlan): string | null =>
    system.launch(plan.launcher, upgradeArgs(plan), { env: { TYCHO_DATA: plan.dataDir } });

  if (system.platform === 'linux') {
    return (plan) => {
      // --collect: the unit goes away once it has run, so one name can be used again and
      // a failed attempt leaves nothing behind for the next one to collide with.
      const ran = system.exec('systemd-run', [
        '--user', '--collect', `--unit=${UPGRADE_TASK}`, '--description=tycho: 上线新版本',
        plan.launcher, ...upgradeArgs(plan),
      ], { env: { TYCHO_DATA: plan.dataDir } });
      if (ran.code === 0) {
        log(`已用 systemd 的临时单元 ${UPGRADE_TASK} 启动升级命令，它不在服务的 cgroup 里`);
        return null;
      }
      log(`用 systemd-run 起升级命令没成功（${said(ran)}），改用独立会话启动；这个服务如果由 systemd 管着，systemd 停它时可能把这个进程一起停掉`);
      return detach(plan);
    };
  }

  if (system.platform === 'win32') {
    const schtasks = tool(system, 'schtasks');
    const user = system.env.USERDOMAIN ? `${system.env.USERDOMAIN}\\${system.user}` : system.user;
    return (plan) => {
      // The task is run from the console, as the service's own task is; on a system whose
      // System32 has no console host it is PowerShell itself that is started. Asked here and
      // not when the starter is made: proving the console host runs costs a child process, and
      // a service that never releases anything would pay it at every start.
      const conhost = conhostPath(system);
      const dir = mkdtempSync(join(tmpdir(), 'tycho-upgrade-'));
      try {
        const file = join(dir, `${UPGRADE_TASK}.xml`);
        // schtasks reads the encoding the declaration names, and only with its mark.
        writeFileSync(file, `\ufeff${upgradeTaskXml({ plan, user, powershell: tool(system, 'powershell'), conhost })}`, 'utf16le');
        const made = system.exec(schtasks, ['/Create', '/TN', UPGRADE_TASK, '/XML', file, '/F']);
        if (made.code !== 0) return `建升级用的计划任务没成功：${said(made)}`;
      } catch (err) {
        return `建升级用的计划任务没成功：${(err as Error).message}`;
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      const ran = system.exec(schtasks, ['/Run', '/TN', UPGRADE_TASK]);
      if (ran.code !== 0) return `运行升级用的计划任务没成功：${said(ran)}`;
      log(`已用独立的计划任务 ${UPGRADE_TASK} 启动升级命令，它不在服务那个任务实例里`);
      return null;
    };
  }

  return (plan) => {
    log('已用独立会话启动升级命令');
    return detach(plan);
  };
}

interface UpgradeTaskInput {
  plan: UpgradePlan;
  // DOMAIN\name of the one the task runs as, which is the one the service runs as.
  user: string;
  powershell: string;
  // System32\conhost.exe on a system that has one: it runs the command with no window at
  // all, as the service's own task does. Null on an older system.
  conhost: string | null;
}

// An on-demand task: no trigger, so nothing ever starts it but the `/Run` that follows.
// The action is PowerShell through the console host, which sets the one variable the CLI
// reads and leaves no console window on the owner's screen; the words go as data no shell
// on the way reads.
export function upgradeTaskXml({ plan, user, powershell, conhost }: UpgradeTaskInput): string {
  const script = `$env:TYCHO_DATA=${psQuote(plan.dataDir)}; & ${psQuote(plan.launcher)} ${upgradeArgs(plan).map(psQuote).join(' ')}`;
  const action = windowsAction({ conhost, powershell, args: encodedCommandLine(script) });
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>tycho: puts a release in place once, when the console asks. ${UPGRADE_TASK}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers />',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlText(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>true</Hidden>',
    '    <Priority>4</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlText(action.command)}</Command>`,
    `      <Arguments>${xmlText(action.arguments)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}
