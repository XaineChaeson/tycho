// Starting the service when its owner logs in. Always under the current user and as the
// current user: under any other account the Claude login and the gateway's ssh keys are out of reach.
//
// What each system is told is built by pure functions from paths, so every platform's
// definition is tested on any platform. The calls to schtasks, systemctl and launchctl sit
// behind System.exec.
import { createHash } from 'node:crypto';
import { observationProblem, type ServiceObservation } from '../shared/service-manager.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecResult, System } from './system.ts';
import { encodedCommand, said, tool, windowsBuild } from './system.ts';

export const NAME = 'tycho';

// One program, two roles: the host service (`tycho run`) and the machine's client
// (`tycho node run`). A computer that is both has two definitions, each with its own name,
// and neither's install, upgrade or uninstall touches the other (docs/design/nodes.md §1.4,
// §7). 'host' is the role a spec written before roles existed means.
export type Role = 'host' | 'node';

export const roleOf = (spec: ServiceSpec): Role => spec.role ?? 'host';

// The legacy base name of each role. New definitions append the stable installation
// owner; an existing definition with this name is reused only by its actual owner.
export const nameOf = (role: Role): string => (role === 'node' ? `${NAME}-node` : NAME);

// Which of the two programs a definition starts: the host's service, or the machine's
// client. The same launcher either way, told a different subcommand.
const runWords = (spec: ServiceSpec): string[] =>
  roleOf(spec) === 'node' ? ['node', 'run'] : ['run'];

export interface ServiceSpec {
  // What starts the CLI, as absolute paths: the launcher, or node and cli/main.ts in a
  // source checkout. A service manager does not inherit the shell's PATH.
  program: string[];
  dataDir: string;
  // Where the service's output goes on the systems whose manager keeps none.
  logFile: string;
  // The PATH of the terminal the autostart was installed from, for the systems whose
  // manager hands its service a bare one. The command's own path is absolute, but what
  // the service runs (claude, and ssh for the gateway) is found through this.
  path?: string | undefined;
  // Absent means 'host': every spec written before one program had two roles.
  role?: Role | undefined;
}

export interface AutostartState {
  installed: boolean;
  // True only when the complete definition is unambiguously this installation's.
  // A known owned entry inside a conflicted or unreadable scene is not enough.
  mine?: boolean;
  // An entry known to be ours while ownership of the complete definition is unproven.
  ownedEntry?: string;
  // What it was installed as, in the owner's words.
  kind?: string;
  where?: string;
  // Log access for this actual definition, supplied by its manager.
  logs?: string;
  // Whether the installed definition is what this version would write for these paths.
  // Its PATH is not compared: that was settled at the install, and belongs to no terminal
  // that looks at it later.
  current?: boolean;
  notes: string[];
  // The definition could not be inspected; no mutating operation may choose another name.
  unknown?: boolean;
}

type ServiceRuntime = Pick<ServiceObservation, 'enabled' | 'running' | 'main_pid' | 'problem'>;
type ManagerAutostart = Omit<Autostart, 'observe'> & { runtime?(): ServiceRuntime };

export interface Autostart {
  // Idempotent: only this installation's selected definition is updated. Other owners
  // and unreadable definitions are never replaced. Returns what to tell the owner.
  install(spec: ServiceSpec, options: { start: boolean }): string[];
  uninstall(spec: ServiceSpec): string[];
  start(spec: ServiceSpec): void;
  // Takes the service out of the manager's hands: a stop it was asked for is not a
  // failure, so it starts nothing again by itself. Asked of a service that does not
  // answer over HTTP — one that is crash-looping — before a release goes back to the
  // version before it. A manager that cannot be reached throws: what was not confirmed
  // is not reported as stopped.
  stop(spec: ServiceSpec): void;
  state(spec: ServiceSpec): AutostartState;
  observe(spec: ServiceSpec): ServiceObservation;
}

// Written into every definition, so that an upgrade, an uninstall or a repair of one
// installation leaves alone an autostart that belongs to another. The two roles of one
// installation are told apart the same way: a definition written for the machine's client
// is not the host service's to rewrite. A host spec keeps the id it had before roles
// existed, so an installation made by an older version is still recognised as this one's.
const OWNER = /owner:([0-9a-f]{16})/;
export const ownerId = (spec: ServiceSpec): string =>
  createHash('sha256').update([...spec.program, ...(roleOf(spec) === 'node' ? ['node'] : [])].join('\0')).digest('hex').slice(0, 16);
const mark = (spec: ServiceSpec): string => `tycho-autostart owner:${ownerId(spec)}`;
const ownedBy = (definition: string, spec: ServiceSpec): boolean => OWNER.exec(definition)?.[1] === ownerId(spec);

const NOT_INSTALLED = '开机自启本来就没有安装。';
const installCommand = (role: Role): string => (role === 'node' ? 'tycho node service install' : 'tycho service install');
const runCommand = (role: Role): string => (role === 'node' ? 'tycho node run' : 'tycho run');
const INSTALL_FIRST = (role: Role): string => `开机自启还没有安装：先运行 ${installCommand(role)}。`;

// Set by every definition this file writes and read by `tycho run`: the service was started
// by the login autostart, where nobody is reading its output. A one-time login link printed
// there stays readable — in a service log, or a task's console — long after it was made, so
// the command makes none of them and points at `tycho open` instead.
export const AUTOSTART_ENV = 'TYCHO_AUTOSTART';

export const xmlText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const xml = xmlText;

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// What a service manager holds, asked after one of its commands failed. `no` and `yes`
// only on an answer that says so: a manager that cannot be reached says neither.
type Held = 'yes' | 'no' | 'unknown';

// ---- Windows ----

// A console program a task starts gets a console window. `-WindowStyle Hidden` used to keep
// it off the desktop; with Windows Terminal as the default terminal it no longer does
// (measured on Windows 11: a window appears whatever PowerShell asks for, and closing it
// ends the service with it). Only the console host can be asked for a console with no
// window at all, so an action names `conhost --headless` and hands it the program and its
// command line.
//
// Two facts of the system decide whether this machine has that console host: `--headless`
// came with Windows 10 1809 (build 17763), and System32\conhost.exe has been there since
// long before it. Both are read from the machine itself (`os.release()` through System), so
// the definition that is written, the one just written and read back, and the one doctor
// judges are all the same answer on one computer. Measured, not probed: asking a console
// host to prove itself under load used to time out and silently fall back to PowerShell,
// which is how one installation ended up with two answers.
const HEADLESS_CONSOLE_BUILD = 17763;

export const conhostPath = (system: Pick<System, 'platform' | 'env' | 'release'>): string | null => {
  if (system.platform !== 'win32') return null;
  const build = windowsBuild(system.release);
  if (build === null || build < HEADLESS_CONSOLE_BUILD) return null;
  const found = tool(system, 'conhost');
  return existsSync(found) ? found : null;
};

// How a task's action is run with no standard handles at all, as Task Scheduler runs it:
// what the tests that run the real action use, so that what they read back is what a task
// would get. The console host takes its standard input and output handles
// as the two ends of a pseudoconsole whenever either is a valid handle (microsoft/terminal,
// src/host/exe/exemain.cpp hands GetStdHandle(STD_INPUT_HANDLE) and GetStdHandle(STD_OUTPUT_HANDLE)
// to ConsoleArguments, whose InConptyMode() is true for any valid one of them). Node cannot
// start a child with none — `stdio: 'ignore'` opens NUL for each — and a console host whose
// terminal is NUL reads end-of-file at once and tears the console down, before or after the
// client it was given has started (measured on Windows 11: 15 starts of 15 ran nothing).
// ShellExecute hands no standard handles down, and Start-Process is how it is reached on
// every Windows. One description for every test that runs an action this way; the argument
// line goes through the environment, where no shell on the way reads it.
export function handleFreeLaunch(powershell: string, file: string, argumentLine: string): { file: string; args: string[]; env: Record<string, string> } {
  const script = '$p = Start-Process -FilePath $env:TYCHO_LAUNCH_FILE -ArgumentList $env:TYCHO_LAUNCH_ARGS -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode';
  return { file: powershell, args: ['-NoProfile', '-NonInteractive', '-Command', script], env: { TYCHO_LAUNCH_FILE: file, TYCHO_LAUNCH_ARGS: argumentLine } };
}

// PowerShell closes a string at any of these, and doubles each to mean itself.
export const psQuote = (text: string): string => `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;

// How the wrapper below restarts a service that failed: after a pause, and no more once
// it has failed this many times without a run of SETTLED_SECONDS in between — a service
// that cannot start is not hammered for ever. Constants: they are written into the
// autostart definition, which exists before any ledger is there to hold a setting.
const RESTART_DELAY_SECONDS = 3;
const RESTART_LIMIT = 5;
const SETTLED_SECONDS = 60;

// Task Scheduler has no place for an environment, and a console program it starts gets a
// visible window that takes the service with it when closed: PowerShell sets the one
// variable and hides the window. It also does the restarting. The task's own "restart on
// failure" reacts to a task that could not be started, not to its program exiting with a
// failure (measured on Windows 11: exit code 7, and nothing for 200 seconds). A clean
// stop exits 0 and ends the loop.
//
// The loop has no terminal, so a Ctrl+C or Ctrl+Break on its console came from some other
// program, and ending the loop on it would leave the service down for good (2026-11-08:
// 0xC000013A). It answers both itself, before PowerShell's own handler (the last one
// registered is asked first), and leaves closing, logoff and shutdown to the default.
// A handler, not SetConsoleCtrlHandler(NULL): that flag would be inherited by the service,
// the Router and every executor below them. No double quote may appear (see commandLine),
// hence [char]34. Where it cannot be set up the loop runs as before.
export const HOLD_CONSOLE_BREAKS =
  "try { $q=[char]34; Add-Type -TypeDefinition ('using System.Runtime.InteropServices; public static class TychoConsoleBreaks { public delegate bool Handler(uint kind); static readonly Handler keep = Hold; static bool Hold(uint kind) { return kind < 2; } [DllImport(' + $q + 'kernel32.dll' + $q + ')] static extern bool SetConsoleCtrlHandler(Handler handler, bool add); public static bool Install() { return SetConsoleCtrlHandler(keep, true); } }'); [void][TychoConsoleBreaks]::Install() } catch { }";

export function windowsScript(spec: ServiceSpec, text: (path: string) => string = (path) => path): string {
  // Task Scheduler keeps no output of its own: the program writes its own log file.
  const words = [...spec.program, ...runWords(spec), '--log', spec.logFile].map((word) => psQuote(text(word)));
  const round = [
    '$began=Get-Date',
    `& ${words.join(' ')}`,
    'if ($LASTEXITCODE -eq 0) { exit 0 }',
    `if (((Get-Date)-$began).TotalSeconds -ge ${SETTLED_SECONDS}) { $failed=0 }`,
    '$failed++',
    `if ($failed -ge ${RESTART_LIMIT}) { exit 1 }`,
    `Start-Sleep -Seconds ${RESTART_DELAY_SECONDS}`,
  ];
  return `${HOLD_CONSOLE_BREAKS}; $env:TYCHO_DATA=${psQuote(text(spec.dataDir))}; $env:${AUTOSTART_ENV}='1'; $failed=0; while ($true) { ${round.join('; ')} }`;
}

const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden'];

// For starting the service now, where the words pass through cmd on the way (see
// System.launch): the script goes as data, so a path holding %NAME% arrives as written.
export const launchArgs = (spec: ServiceSpec): string[] => [...POWERSHELL_FLAGS, '-EncodedCommand', encodedCommand(windowsScript(spec))];

// The same flags with the script as data, as one command line: what a definition that stays
// on the machine says, where nothing rewrites it on the way and no double quote can appear
// (a Windows path cannot hold one).
export const encodedCommandLine = (script: string): string => `${POWERSHELL_FLAGS.join(' ')} -EncodedCommand ${encodedCommand(script)}`;

// For the definitions that stay on the machine, which nothing rewrites on the way: the
// script as readable text. A hidden PowerShell with an encoded command, started at every
// login, is what security software is taught to stop. The script holds no double quote:
// a Windows path cannot.
const commandLine = (script: string): string => `${POWERSHELL_FLAGS.join(' ')} -Command "${script}"`;

interface WindowsAction {
  // The program Task Scheduler starts.
  command: string;
  // Its command line, as the definition spells it.
  arguments: string;
}

// The action a definition says, from the flags and the script that go into it. Written once,
// so that what this version writes and what it reads back are judged by the same rule.
export function windowsAction({ conhost, powershell, args }: { conhost: string | null; powershell: string; args: string }): WindowsAction {
  return conhost === null
    ? { command: powershell, arguments: args }
    : { command: conhost, arguments: `--headless ${powershell} ${args}` };
}

const unxml = (text: string): string =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
const xmlElement = (document: string, name: string): string | undefined => {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(document);
  return found ? unxml(found[1]!) : undefined;
};

// The action this version would write for one machine, from the same fact conhostPath
// settles: the expected action is generated the same way for the definition that is written,
// for the one read back right after, and for the one doctor judges.
const expectedAction = (powershell: string, conhost: string | null, spec: ServiceSpec): WindowsAction =>
  windowsAction({ conhost, powershell, args: commandLine(windowsScript(spec)) });

// The action a registered definition holds, as Task Scheduler stores it. An element that is
// not there reads as the empty string, and a task without an action is then not the one
// written.
const registeredAction = (registered: string): WindowsAction => ({
  command: xmlElement(registered, 'Command') ?? '',
  arguments: xmlElement(registered, 'Arguments') ?? '',
});

const sameAction = (held: WindowsAction, expected: WindowsAction): boolean =>
  held.command === expected.command && held.arguments === expected.arguments;

// Whether a registered task runs what this version would write for these paths. Its
// action itself is compared, as Task Scheduler stores it: the description only says what
// some installer once wrote, and survives an edit of the action in Task Scheduler's own
// window. The rest of the XML comes back in Task Scheduler's layout, with its defaults.
const taskCurrent = (registered: string, powershell: string, conhost: string | null, spec: ServiceSpec): boolean =>
  sameAction(registeredAction(registered), expectedAction(powershell, conhost, spec));

// Asks Task Scheduler for one task's definition. Not `schtasks /Query /XML`: that answers
// in the console's code page (measured on a Chinese Windows: GBK, whatever the terminal
// is set to), where a path outside ASCII comes back as other bytes, some of them ASCII;
// and it tells a task that is not there from a query that failed only in localized words.
// Here the first is one HRESULT, and the definition comes back in base64.
export const TASK_QUERY = [
  `$ErrorActionPreference='Stop'`,
  `try{$s=New-Object -ComObject Schedule.Service;$s.Connect();$x=$s.GetFolder('\\').GetTask($env:TYCHO_TASK).Xml}catch{if($_.Exception.HResult -eq -2147024894){'absent';exit 0};throw}`,
  `'present '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($x))`,
].join(';');

type Task = { found: 'present'; xml: string } | { found: 'absent' } | { found: 'unknown'; why: string };

export interface TaskInput {
  // DOMAIN\name of the one who logs in.
  user: string;
  powershell: string;
  // System32\conhost.exe on a system that has one: asked to run the command with no window
  // at all. Null on an older system, where the action is PowerShell itself.
  conhost: string | null;
  spec: ServiceSpec;
}

export function windowsTaskXml({ user, powershell, conhost, spec }: TaskInput): string {
  const action = windowsAction({ conhost, powershell, args: commandLine(windowsScript(spec)) });
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>tycho: starts ${roleOf(spec) === 'node' ? 'the machine client' : 'the service'} when ${xml(user)} logs on. ${mark(spec)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xml(user)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xml(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    // The defaults would keep it from starting on battery and end it after three days.
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    // The default, 7, runs below normal priority with background I/O.
    '    <Priority>4</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(action.command)}</Command>`,
    `      <Arguments>${xml(action.arguments)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

// For when a scheduled task is refused. cmd reads this file in the console's code page, so
// it has to be plain ASCII: what lies under the home directory is named through
// %USERPROFILE%, which cmd expands correctly whatever the characters.
export function startupCmd({ powershell, spec, home }: { powershell: string; spec: ServiceSpec; home: string }): string {
  // Not when the expansion would bring in a character that ends a PowerShell string.
  const viaHome = home !== '' && !/['\u2018\u2019\u201a\u201b%]/.test(home);
  const text = (path: string): string => {
    const under = viaHome && path.toLowerCase().startsWith(`${home.toLowerCase()}\\`);
    const literal = (under ? path.slice(home.length) : path).replaceAll('%', '%%');
    return under ? `%USERPROFILE%${literal}` : literal;
  };
  const line = `start "" /min "${text(powershell)}" ${commandLine(windowsScript(spec, text))}`;
  if (!/^[\x20-\x7e]*$/.test(line)) {
    throw new Error(
      '“启动”文件夹里的 .cmd 文件写不了这些路径里的字符（它只能含英文字符，主目录以外的路径没法绕开）。把 tycho 装到只含英文字符的路径下再试。',
    );
  }
  return ['@echo off', `rem ${mark(spec)}`, `rem Written by "${installCommand(roleOf(spec))}"; "${installCommand(roleOf(spec)).replace('install', 'uninstall')}" removes it.`, line, ''].join('\r\n');
}

function windows(system: System, role: Role, name: string): ManagerAutostart {
  const taskName = `计划任务“${name}”`;
  const what = role === 'node' ? '机器客户端' : '服务';
  const schtasks = tool(system, 'schtasks');
  const powershell = tool(system, 'powershell');
  // Settled here, once: it is a property of this machine, and both what is written and what
  // a registered task is judged by have to be the same answer.
  const conhost = conhostPath(system);
  const user = system.env.USERDOMAIN ? `${system.env.USERDOMAIN}\\${system.user}` : system.user;
  const startupFile = join(
    system.env.APPDATA ?? join(system.home, 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${name}.cmd`,
  );

  function task(): Task {
    const asked = system.exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', TASK_QUERY], { env: { TYCHO_TASK: name } });
    const [word, encoded] = asked.stdout.trim().split(' ');
    if (asked.code === 0 && word === 'absent') return { found: 'absent' };
    if (asked.code === 0 && word === 'present' && encoded) return { found: 'present', xml: Buffer.from(encoded, 'base64').toString('utf8') };
    return { found: 'unknown', why: said(asked) };
  }
  const unasked = (why: string): string => `查不了计划任务（${why}）`;

  function runTask(): void {
    const ran = system.exec(schtasks, ['/Run', '/TN', name]);
    if (ran.code !== 0) throw new Error(`现在启动它没成功（${said(ran)}）。下次登录时它会自己启动；现在要用就运行 ${runCommand(role)}。`);
  }

  // Null once started: the same script the Startup folder's file runs at a login.
  const launchNow = (spec: ServiceSpec): string | null => system.launch(powershell, launchArgs(spec));

  function createTask(spec: ServiceSpec): ExecResult {
    const dir = mkdtempSync(join(tmpdir(), 'tycho-task-'));
    try {
      const file = join(dir, 'task.xml');
      // schtasks reads the encoding the declaration names, and only with its mark.
      writeFileSync(file, `\ufeff${windowsTaskXml({ user, powershell, conhost, spec })}`, 'utf16le');
      return system.exec(schtasks, ['/Create', '/TN', name, '/XML', file, '/F']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const mismatch = (why: string): string =>
    `${taskName}写进去的和应当的不一样（${why}）。登录时启动的可能不是这一份 tycho：用建它的账号（或管理员）再运行一次 ${installCommand(role)}，或到“任务计划程序”里看它的“操作”。`;

  // Reads back what was just registered and judges its action by the same expected action
  // doctor uses. A task that is missing, unreadable, or holding another action is not a
  // synced definition: saying "已同步" about it would leave the owner with the definition
  // this version exists to replace — PowerShell directly, whose window Windows 11 no longer
  // hides, and whose closing ends the service.
  function readBackTask(spec: ServiceSpec): void {
    const expected = expectedAction(powershell, conhost, spec);
    const registered = task();
    if (registered.found === 'present') {
      const held = registeredAction(registered.xml);
      if (sameAction(held, expected)) return;
      throw new Error(mismatch([
        ...(held.command === expected.command ? [] : [`启动的程序是 ${held.command}，应当是 ${expected.command}`]),
        ...(held.arguments === expected.arguments ? [] : ['命令行和这个版本要写的不一样']),
      ].join('；')));
    }
    throw new Error(mismatch(registered.found === 'absent' ? '写完之后它查不到了' : `写完之后${unasked(registered.why)}`));
  }

  return {
    install(spec, { start }) {
      const created = createTask(spec);
      if (created.code === 0) {
        // Before anything is reported as installed: the definition Task Scheduler really
        // holds is the one that will run at the next login.
        readBackTask(spec);
        // Left from an earlier refusal; both would start the service.
        try {
          rmSync(startupFile, { force: true });
        } catch (err) {
          throw new Error(
            `${taskName}已装好，但“启动”文件夹里上次留下的 ${startupFile} 删不掉（${message(err)}）：两个都在的话，登录时会启动两次。请手工删掉它。`,
          );
        }
        if (start) {
          try {
            runTask();
          } catch (err) {
            throw new Error(`${taskName}已装好，但${message(err)}`);
          }
        }
        return [
          `已装成${taskName}：你登录 Windows 后${what}自动启动，异常退出后自动重启。`,
          `${what}的输出记在 ${spec.logFile}。`,
          '不做“开机后还没登录就运行”：那需要管理员权限，而且那样运行拿不到你的网络凭据和 Claude 登录。',
        ];
      }
      // Asked after the refusal: what is registered now is what the owner is left with.
      // The Startup folder is the way out only for a task that could not be made at all;
      // beside one that stands it would be a second service at every login.
      const now = task();
      if (now.found === 'present') {
        const whose = ownedBy(now.xml, spec) ? '是这一份 tycho' : '是另一份 tycho';
        const stale = taskCurrent(now.xml, powershell, conhost, spec) ? '和这个版本要写的一样' : '和这个版本要写的不一样';
        throw new Error(
          `${taskName}已经有了，这次更新被拒（${said(created)}），它保持原样：启动的${whose}，定义${stale}。` +
            '没有改用“启动”文件夹：两个入口都在的话，登录时会启动两次。用建这个任务的账号（或管理员）再运行一次 ' + installCommand(role) + '，或先在“任务计划程序”里删掉它。',
        );
      }
      if (now.found === 'unknown') throw new Error(`${unasked(now.why)}：不能确认任务归属，没有改写启动文件。`);
      mkdirSync(dirname(startupFile), { recursive: true });
      writeFileSync(startupFile, startupCmd({ powershell, spec, home: system.home }));
      const problem = start ? launchNow(spec) : null;
      if (problem !== null) {
        throw new Error(
          `计划任务没建成（${said(created)}），改用“启动”文件夹：文件 ${startupFile} 已放好，下次登录时${what}会自动启动。但现在启动它没成功：${problem}。现在要用就运行 ${runCommand(role)}。`,
        );
      }
      return [
        `计划任务没建成（${said(created)}），改用“启动”文件夹：放了一个文件 ${startupFile}。`,
        `你登录 Windows 后${what}自动启动，异常退出后自动重启。`,
        `${what}的输出记在 ${spec.logFile}。`,
      ];
    },

    // Both entries are tried whatever happens to the other, and what is left is said.
    uninstall() {
      const done: string[] = [];
      const left: string[] = [];
      const registered = task();
      if (registered.found === 'unknown') {
        left.push(`${unasked(registered.why)}：有没有名为“${name}”的任务不知道，没有动它。到“任务计划程序”里看一眼。`);
      } else if (registered.found === 'present') {
        const deleted = system.exec(schtasks, ['/Delete', '/TN', name, '/F']);
        const now: Task = deleted.code === 0 ? { found: 'absent' } : task();
        if (now.found === 'absent') {
          done.push(`已删除${taskName}。`);
        } else if (now.found === 'present') {
          left.push(`删除${taskName}没成功（${said(deleted)}），它还在，登录时仍会启动${what}。用建它的账号（或管理员）再试，或在“任务计划程序”里删掉它。`);
        } else {
          left.push(`删除${taskName}没成功（${said(deleted)}），之后${unasked(now.why)}，它还在不在不知道。到“任务计划程序”里看一眼。`);
        }
      }
      if (existsSync(startupFile)) {
        try {
          rmSync(startupFile);
          done.push(`已删除“启动”文件夹里的 ${startupFile}。`);
        } catch (err) {
          left.push(`“启动”文件夹里的 ${startupFile} 删不掉（${message(err)}），登录时它仍会启动${what}。请手工删掉它。`);
        }
      }
      if (left.length > 0) throw new Error([...done, ...left].join('\n'));
      return done.length > 0 ? done : [NOT_INSTALLED];
    },

    start(spec) {
      const registered = task();
      if (registered.found === 'present') {
        try {
          runTask();
        } catch (err) {
          throw new Error(`${taskName}在，但${message(err)}`);
        }
        return;
      }
      if (existsSync(startupFile)) {
        const problem = launchNow(spec);
        if (problem !== null) throw new Error(`没能启动${what}：${problem}。现在要用就运行 ${runCommand(role)}。`);
        return;
      }
      throw new Error(
        registered.found === 'unknown'
          ? `${unasked(registered.why)}，“启动”文件夹里也没有 tycho 的文件：没法通过开机自启启动。现在要用就运行 ${runCommand(role)}。`
          : INSTALL_FIRST(role),
      );
    },

    // The task instance ends, and with it what it started; the definition stays, with its
    // logon trigger, so the next login is unaffected. Started from the "Startup" folder
    // there is nothing to ask: that wrapper ends as soon as the service exits cleanly.
    stop() {
      const registered = task();
      if (registered.found === 'present') {
        const ended = system.exec(schtasks, ['/End', '/TN', name]);
        if (ended.code !== 0) throw new Error(`停这个${what}没成功（${said(ended)}）。`);
        return;
      }
      if (registered.found === 'unknown') throw new Error(`${unasked(registered.why)}：没法通过它停${what}。`);
    },

    runtime() {
      const script = "$ErrorActionPreference='Stop'; $s=New-Object -ComObject 'Schedule.Service'; $s.Connect(); $t=$s.GetFolder('\\').GetTask($env:TYCHO_TASK); @{ enabled=[bool]$t.Enabled; running=($t.State -eq 4) } | ConvertTo-Json -Compress";
      const answer = system.exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { TYCHO_TASK: name } });
      if (answer.code !== 0) return { enabled: null, running: null, main_pid: null, problem: observationProblem(said(answer)) };
      try {
        const value = JSON.parse(answer.stdout) as { enabled: unknown; running: unknown };
        if (typeof value.enabled !== 'boolean' || typeof value.running !== 'boolean') throw new Error('unknown');
        return { enabled: value.enabled, running: value.running, main_pid: null };
      } catch (error) { return { enabled: null, running: null, main_pid: null, problem: observationProblem(error) }; }
    },
    state(spec) {
      const registered = task();
      let startup: string | null = null;
      let startupProblem: string | undefined;
      try { startup = read(startupFile); }
      catch (error) { startupProblem = message(error); }
      const taskMine = registered.found === 'present' && ownedBy(registered.xml, spec);
      const startupMine = startup !== null && ownedBy(startup, spec);
      const partial = (ownedEntry: string, why: string): AutostartState => ({
        installed: true,
        mine: false,
        ownedEntry,
        unknown: true,
        kind: '计划任务与“启动”文件夹',
        where: `${taskName}；${startupFile}`,
        notes: [`${why}；已确认属于本安装的入口是 ${ownedEntry}。请先核实两处归属，不能自动修改、启动、停止或卸载这些定义`],
      });
      if (startupProblem !== undefined) {
        const why = `读不了启动文件 ${startupFile}（${startupProblem}）`;
        if (taskMine) return partial(taskName, why);
        return { installed: registered.found === 'present', unknown: true, notes: [why] };
      }
      if (registered.found === 'present') {
        if (startup !== null && startupMine !== taskMine) {
          return partial(taskMine ? taskName : startupFile, '同名计划任务和启动文件的归属不一致');
        }
        return {
          installed: true,
          mine: taskMine,
          kind: '计划任务',
          where: taskName,
          current: taskCurrent(registered.xml, powershell, conhost, spec),
          notes: startup === null
            ? []
            : [`“启动”文件夹里还有一个 ${startupFile}：两个入口，登录时会启动两次。删掉这个文件，或运行 ${installCommand(role)}（它只留计划任务）。`],
        };
      }
      if (registered.found === 'unknown') {
        if (startupMine) return partial(startupFile, unasked(registered.why));
        return { installed: false, unknown: true, notes: [`${unasked(registered.why)}：有没有装成计划任务不知道。`] };
      }
      if (startup === null) return { installed: false, notes: [] };
      let expected: string | undefined;
      try {
        expected = startupCmd({ powershell, spec, home: system.home });
      } catch {
        expected = undefined;
      }
      return { installed: true, mine: startupMine, kind: '“启动”文件夹', where: startupFile, current: startup === expected, notes: [] };
    },
  };
}

// ---- Linux ----

// systemd reads "%" as a specifier everywhere, and "$" as a variable in a command line.
const unitWord = (text: string): string => `"${text.replace(/[\\"]/g, '\\$&').replaceAll('%', '%%')}"`;
const execWord = (text: string): string => unitWord(text).replaceAll('$', '$$$$');

export function systemdUnit(spec: ServiceSpec): string {
  return [
    `# ${mark(spec)}`,
    '[Unit]',
    `Description=tycho ${roleOf(spec)}`,
    // Five failed starts within a minute and systemd stops trying. Its default window is
    // shorter than five restarts take, which would mean trying for ever.
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    // systemd keeps the output itself: no --log here, and journalctl is where it is read.
    `ExecStart=${[...spec.program, ...runWords(spec)].map(execWord).join(' ')}`,
    `Environment=${unitWord(`TYCHO_DATA=${spec.dataDir}`)}`,
    // Nobody is reading the service's output here: it makes no login link of its own.
    `Environment=${unitWord(`${AUTOSTART_ENV}=1`)}`,
    ...(spec.path ? [`Environment=${unitWord(`PATH=${spec.path}`)}`] : []),
    // A clean stop exits 0 and stays stopped.
    'Restart=on-failure',
    'RestartSec=5',
    // The host: the signal goes to the command alone, which passes it on, and the service
    // then ends its own children in order. The machine's client: the signal goes to the
    // client alone and nothing else in the cgroup is touched — the rounds it started run
    // under watch processes of their own, and a client that crashes and is restarted, or
    // is stopped, must not take them with it (docs/design/nodes.md §4.2).
    roleOf(spec) === 'node' ? 'KillMode=process' : 'KillMode=mixed',
    // The command gives a stop 60 seconds before it reports it unfinished; systemd waits
    // a little longer than that before it kills. Written out because the default is
    // whatever this machine's user manager was configured with.
    'TimeoutStopSec=90',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const UNIT_PATH = /^Environment="PATH=.*\n/m;

const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const byHand = (spec: ServiceSpec): string =>
  `${AUTOSTART_ENV}=1 TYCHO_DATA=${shQuote(spec.dataDir)} nohup ${[...spec.program, ...runWords(spec), '--log', spec.logFile].map(shQuote).join(' ')} >/dev/null 2>&1 &`;

function linux(system: System, role: Role, name: string): ManagerAutostart {
  const unit = `${name}.service`;
  const what = role === 'node' ? '机器客户端' : '服务';
  const file = join(system.env.XDG_CONFIG_HOME || join(system.home, '.config'), 'systemd', 'user', unit);
  const systemctl = (...args: string[]): ExecResult => system.exec('systemctl', ['--user', ...args]);

  // Both verbs print one word for the state and exit 0 when it is the one asked about. A
  // unit systemd has never heard of is "no" too, in whichever way this version says it.
  function held(verb: 'is-enabled' | 'is-active'): Held {
    const answer = systemctl(verb, unit);
    if (answer.code === 0) return 'yes';
    const answered = /^[a-z-]+$/.test(answer.stdout.trim()) || /no such file|not found|does not exist/i.test(answer.stderr);
    return answered ? 'no' : 'unknown';
  }
  const running = (active: Held): string => ({ yes: `${what}在运行`, no: `${what}没在运行`, unknown: `${what}在不在运行查不出来` })[active];
  const logs = `原因看 systemctl --user status ${unit} 和 journalctl --user -u ${name}`;

  // Read only: turning it on is the owner's decision.
  function lingerNotes(): string[] {
    const linger = system.exec('loginctl', ['show-user', system.user, '--property=Linger']);
    return linger.code === 0 && /Linger=no/.test(linger.stdout)
      ? [`现在是“你退出登录后${what}会停、开机后要等你登录才启动”。想让它开机就运行、退出登录也不停，运行一次：loginctl enable-linger`]
      : [];
  }

  return {
    install(spec, { start }) {
      const before = read(file);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, systemdUnit(spec));
      const reload = systemctl('daemon-reload');
      if (reload.code !== 0) {
        if (before === null) rmSync(file, { force: true });
        else writeFileSync(file, before);
        throw new Error(
          `这台机器上用不了 systemd 用户服务（${said(reload)}），没法自动安装开机自启。手工办法：在你登录后会执行的地方（比如 crontab 的 @reboot 一行）加上：\n  ${byHand(spec)}`,
        );
      }
      const enabled = systemctl('enable', ...(start ? ['--now'] : []), unit);
      if (enabled.code !== 0) {
        // `enable --now` can have enabled the unit and failed to start it: each is asked.
        const now = { yes: '已启用（你登录后会自动启动）', no: '没有启用（你登录后不会自动启动）', unknown: '启用没启用查不出来' }[held('is-enabled')];
        throw new Error(
          `单元文件已写到 ${file}，但${start ? '启用并启动' : '启用'}它没成功（${said(enabled)}）。现在的实际状态：${now}，${running(held('is-active'))}。${logs}；修好后再运行一次 ${installCommand(role)}。`,
        );
      }
      return [
        `已装成 systemd 用户服务：${file}。你登录后${what}自动启动，异常退出后自动重启。`,
        `看${what}的输出：journalctl --user -u ${name}`,
        ...lingerNotes(),
      ];
    },

    uninstall() {
      if (!existsSync(file)) return [NOT_INSTALLED];
      const disabled = systemctl('disable', unit);
      rmSync(file);
      const reloaded = systemctl('daemon-reload');
      const removed = `已删除 systemd 用户服务 ${file}。`;
      if (disabled.code === 0 && reloaded.code === 0) return [removed];
      // Asked after the failure: a unit systemd never had enabled is not a failed
      // uninstall, and one it still has enabled is not a finished one.
      const enabled = held('is-enabled');
      const stale = reloaded.code === 0
        ? []
        : [`systemd 没能重新读取定义（${said(reloaded)}）：它记着的旧定义要到你下次登录、或 systemctl --user daemon-reload 成功之后才消失。`];
      if (enabled === 'no') return [removed, ...(disabled.code === 0 ? [] : ['它在 systemd 里本来就没有启用。']), ...stale];
      const failure = said(disabled.code === 0 ? reloaded : disabled);
      throw new Error(
        [
          removed,
          enabled === 'yes'
            ? `但 systemd 里它还是启用的（${failure}）。运行 systemctl --user disable ${unit} 和 systemctl --user daemon-reload，再用 systemctl --user is-enabled ${unit} 看。`
            : `但 systemd 没有应答（${failure}），它那边还剩什么不知道。下次登录后用 systemctl --user is-enabled ${unit} 看；还启用着就运行 systemctl --user disable ${unit}。`,
          ...(enabled === 'yes' ? stale : []),
        ].join('\n'),
      );
    },

    start() {
      if (!existsSync(file)) throw new Error(INSTALL_FIRST(role));
      // A unit that crash-looped is in its failed state, and systemd refuses to start it
      // again until the start limit window has passed. Clearing that is what makes coming
      // back from a failed release possible at all.
      systemctl('reset-failed', unit);
      const started = systemctl('start', unit);
      if (started.code === 0) return;
      // An error about a unit that is active all the same: it has been started.
      const active = held('is-active');
      if (active !== 'yes') throw new Error(`启动 systemd 用户服务没成功（${said(started)}），${running(active)}。${logs}。`);
    },

    // A stop systemd was asked for is not a failure: it stays stopped until it is started
    // again. Asked of a service that does not answer over HTTP — one that keeps crashing —
    // this is the only way to get it out of the way before the version before it is put
    // back. A unit that is not there at all is nothing to stop.
    stop() {
      if (!existsSync(file)) throw new Error(INSTALL_FIRST(role));
      const stopped = systemctl('stop', unit);
      if (stopped.code !== 0 && held('is-active') !== 'no') {
        throw new Error(`停 systemd 用户服务没成功（${said(stopped)}），${running(held('is-active'))}。${logs}。`);
      }
    },

    runtime() {
      const answer = systemctl('show', unit, '--no-pager', '--property=ActiveState,UnitFileState,MainPID');
      if (answer.code !== 0) return { enabled: null, running: null, main_pid: null, problem: observationProblem(said(answer)) };
      const values = Object.fromEntries(answer.stdout.trim().split('\n').map(line => line.split('=', 2)));
      const active = values.ActiveState;
      const enabled = values.UnitFileState;
      const pid = Number(values.MainPID);
      if (!['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading'].includes(active ?? '')
        || !/^[a-z-]+$/.test(enabled ?? '') || !Number.isSafeInteger(pid) || pid < 0) {
        return { enabled: null, running: null, main_pid: null, problem: observationProblem('unknown') };
      }
      return { enabled: ['enabled', 'enabled-runtime'].includes(enabled!), running: ['active', 'reloading'].includes(active!) ? true : ['inactive', 'failed'].includes(active!) ? false : null, main_pid: pid > 0 ? pid : null };
    },
    state(spec) {
      const installed = read(file);
      if (installed === null) return { installed: false, notes: [] };
      const enabled = held('is-enabled');
      return {
        installed: true,
        mine: ownedBy(installed, spec),
        kind: 'systemd 用户服务',
        where: file,
        logs: `journalctl --user -u ${name}`,
        current: installed.replace(UNIT_PATH, '') === systemdUnit({ ...spec, path: undefined }),
        notes: [
          ...(enabled === 'no' ? ['定义在，但没有启用：运行 ' + installCommand(role) + '。'] : []),
          ...(enabled === 'unknown' ? ['问不到 systemd（systemctl --user is-enabled 没有答复）：这个定义启用没启用不知道。'] : []),
          ...lingerNotes(),
        ],
      };
    },
  };
}

// ---- macOS ----

// A LaunchAgent, not a LaunchDaemon: the Claude login is in the user's Keychain.
export function launchdPlist(spec: ServiceSpec, name = nameOf(roleOf(spec))): string {
  // launchd keeps no output of its own: the program writes its own log file.
  const words = [...spec.program, ...runWords(spec), '--log', spec.logFile];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${mark(spec)} -->`,
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${name}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...words.map((word) => `    <string>${xml(word)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>TYCHO_DATA</key>',
    `    <string>${xml(spec.dataDir)}</string>`,
    // Nobody is reading the service's output here: it makes no login link of its own.
    `    <key>${AUTOSTART_ENV}</key>`,
    '    <string>1</string>',
    ...(spec.path ? ['    <key>PATH</key>', `    <string>${xml(spec.path)}</string>`] : []),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // Restarted after a failure; a clean stop exits 0 and stays stopped.
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const PLIST_PATH = /^ {4}<key>PATH<\/key>\n {4}<string>[^<]*<\/string>\n/m;

function mac(system: System, role: Role, name: string): ManagerAutostart {
  const what = role === 'node' ? '机器客户端' : '服务';
  const file = join(system.home, 'Library', 'LaunchAgents', `${name}.plist`);
  const domain = `gui/${system.uid}`;
  const launchctl = (...args: string[]): ExecResult => system.exec('launchctl', args);
  const job = `${domain}/${name}`;

  // launchctl has one way to say "no such service" (exit 113, with these words); whatever
  // else it says in place of printing the job is not an answer.
  function loaded(): Held {
    const printed = launchctl('print', job);
    if (printed.code === 0) return 'yes';
    return printed.code === 113 || /could not find service/i.test(printed.stderr + printed.stdout) ? 'no' : 'unknown';
  }

  // Takes the loaded job out: `gone` when there was one, `absent` when there was none. A
  // bootout fails for both a job that was never loaded and one that would not leave, so
  // launchd is asked afterwards which it was.
  function unload(): 'gone' | 'absent' | { still: Held; why: string } {
    const out = launchctl('bootout', job);
    if (out.code === 0) return 'gone';
    const now = loaded();
    return now === 'no' ? 'absent' : { still: now, why: said(out) };
  }
  const stuck = (left: { still: Held; why: string }): string =>
    left.still === 'yes'
      ? `launchd 没能卸下已经载入的那个${what}（${left.why}），它现在还载入着。运行 launchctl bootout ${job} 再试，或退出登录一次。`
      : `launchd 没有应答（${left.why}），已经载入的那个${what}卸没卸下不知道。用 launchctl print ${job} 看；还在就运行 launchctl bootout ${job}。`;

  // launchd keeps the definition it loaded; loading again is how it takes the file's.
  function load(): void {
    const out = unload();
    if (typeof out !== 'string') throw new Error(`${stuck(out)}新的定义（${file}）没有载入。`);
    const boot = launchctl('bootstrap', domain, file);
    if (boot.code === 0) return;
    const now = { yes: `它现在载入着：可能是上一个还没退完，过几秒再运行 ${installCommand(role).replace('install', 'start')}`, no: `它现在没有载入，${what}没有启动`, unknown: '它现在载没载入也查不出来' }[loaded()];
    throw new Error(`launchd 没有载入${what}（${said(boot)}）。${now}。定义文件在 ${file}，可以用 plutil -lint 检查它。`);
  }

  return {
    install(spec, { start }) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, launchdPlist(spec, name));
      if (start) load();
      return [
        `已装成 LaunchAgent：${file}。你登录后${what}自动启动，异常退出后自动重启。`,
        `${what}的输出记在 ${spec.logFile}。`,
      ];
    },

    uninstall() {
      if (!existsSync(file)) return [NOT_INSTALLED];
      const out = unload();
      // Whatever launchd did: without the file nothing is loaded at the next login.
      rmSync(file);
      const removed = `已删除 LaunchAgent ${file}。`;
      if (out === 'gone') return [`${removed}launchd 管着的那个${what}也随之停止。`];
      if (out === 'absent') return [`${removed}launchd 里本来就没有载入它。`];
      throw new Error(`${removed}下次登录不会再自动启动。但${stuck(out)}`);
    },

    start() {
      if (!existsSync(file)) throw new Error(INSTALL_FIRST(role));
      load();
    },

    // Taking the job out is what stops launchd from starting it again after a crash: only
    // starting it (which loads it anew) brings it back.
    stop() {
      if (!existsSync(file)) throw new Error(INSTALL_FIRST(role));
      const out = unload();
      if (typeof out !== 'string') throw new Error(stuck(out));
    },

    runtime() {
      const answer = launchctl('print', job);
      if (answer.code === 113 || /could not find service/i.test(answer.stderr + answer.stdout)) return { enabled: null, running: false, main_pid: null };
      if (answer.code !== 0) return { enabled: null, running: null, main_pid: null, problem: observationProblem(said(answer)) };
      const state = /^\s*state = ([\w-]+)\s*$/m.exec(answer.stdout)?.[1];
      const pid = /^\s*pid = (\d+)\s*$/m.exec(answer.stdout)?.[1];
      if (!state) return { enabled: null, running: null, main_pid: null, problem: observationProblem('unknown') };
      return { enabled: null, running: state === 'running', main_pid: pid && Number.isSafeInteger(Number(pid)) && Number(pid) > 0 ? Number(pid) : null };
    },
    state(spec) {
      const installed = read(file);
      if (installed === null) return { installed: false, notes: [] };
      return {
        installed: true,
        mine: ownedBy(installed, spec),
        kind: 'LaunchAgent',
        where: file,
        current: installed.replace(PLIST_PATH, '') === launchdPlist({ ...spec, path: undefined }, name),
        notes: [],
      };
    },
  };
}

function unsupported(system: System, role: Role): ManagerAutostart {
  const refuse = (spec: ServiceSpec): never => {
    throw new Error(`这个系统（${system.platform}）没有支持的开机自启方式。手工办法：在你登录后会执行的地方加上：\n  ${byHand(spec)}`);
  };
  return {
    install: refuse,
    uninstall: () => [NOT_INSTALLED],
    start: refuse,
    stop: refuse,
    state: () => ({ installed: false, notes: [] }),
  };
}

// The manager owns one namespace per user, even when program and data directories differ.
// Resolve both known names on every operation; a prior state query never selects a target.
export function autostartFor(system: System, role: Role = 'host'): Autostart {
  function at(name: string): ManagerAutostart {
    if (system.platform === 'win32') return windows(system, role, name);
    if (system.platform === 'linux') return linux(system, role, name);
    if (system.platform === 'darwin') return mac(system, role, name);
    return unsupported(system, role);
  }
  function selected(spec: ServiceSpec, manage = false): { auto: ManagerAutostart; state: AutostartState; name: string; observationProblem?: ServiceObservation['problem'] } {
    const legacyName = nameOf(role), ownName = `${legacyName}-${ownerId(spec)}`;
    function inspect(name: string) {
      const auto = at(name);
      try { return { auto, state: auto.state(spec), name }; }
      catch (error) { return { auto, state: { installed: false, unknown: true, notes: [message(error)] } satisfies AutostartState, name }; }
    }
    const own = inspect(ownName), legacy = inspect(legacyName);
    // Knowing one owned entry does not settle the complete definition's ownership.
    // Keep that fact for status without permitting changes or a second entry.
    const partial = [own, legacy].find(entry => entry.state.ownedEntry !== undefined);
    if (partial) {
      if (manage) throw new Error(`${partial.state.where}：${partial.state.notes.join(' ')}；没有改动任何定义`);
      return partial;
    }
    if (own.state.unknown) throw new Error(`查不了开机自启 ${ownName}：${own.state.notes.join(' ')}；没有改动任何定义`);
    const hasOwn = own.state.installed && own.state.mine;
    const hasLegacy = !legacy.state.unknown && legacy.state.installed && legacy.state.mine;
    if (hasOwn && hasLegacy) throw new Error(`这一份 tycho 同时有两个开机自启定义：${legacyName}、${ownName}；请先核实重复入口，没有改动任何定义`);
    if (own.state.installed && !own.state.mine) throw new Error(`开机自启名称 ${ownName} 属于其他程序或安装；没有改动任何定义`);
    if (hasOwn) return own;
    if (hasLegacy) return legacy;
    // A missing legacy file may still have a loaded job. Never allocate that shared name.
    return legacy.state.installed || legacy.state.unknown
      ? { ...own, ...(legacy.state.unknown ? { observationProblem: observationProblem(legacy.state.notes.join(' ')) } : {}), state: { ...own.state, mine: false, current: false, notes: ['旧固定名称的开机自启启动的是另一份 tycho，或归属尚未核实，不是这一份可管理的定义；没有动它。本安装使用自己的名称'] } }
      : own;
  }
  return {
    install(spec, options) { return selected(spec, true).auto.install(spec, options); },
    uninstall(spec) {
      const picked = selected(spec, true);
      return picked.state.installed ? picked.auto.uninstall(spec) : [...picked.state.notes, NOT_INSTALLED];
    },
    start(spec) {
      const picked = selected(spec, true);
      if (!picked.state.installed) throw new Error(INSTALL_FIRST(role));
      picked.auto.start(spec);
    },
    stop(spec) {
      const picked = selected(spec, true);
      if (!picked.state.installed) throw new Error(INSTALL_FIRST(role));
      picked.auto.stop(spec);
    },
    state(spec) { return selected(spec).state; },
    observe(spec) {
      const manager = system.platform === 'linux' ? 'systemd' : system.platform === 'darwin' ? 'launchd'
        : system.platform === 'win32' ? 'windows-task' : 'unsupported';
      const base: ServiceObservation = { role, manager, entry: null, installed: null, enabled: null, running: null, main_pid: null };
      if (manager === 'unsupported') return { ...base, problem: observationProblem('not available') };
      try {
        const picked = selected(spec);
        if (picked.observationProblem) return { ...base, problem: picked.observationProblem };
        if (picked.state.unknown) return { ...base, problem: observationProblem(picked.state.notes.join(' ')) };
        const own = picked.state.installed && picked.state.mine;
        const observed = { ...base, installed: picked.state.installed,
          entry: own ? picked.name : null,
          ...(picked.state.kind === '“启动”文件夹' ? { manager: 'startup' as const } : {}) };
        if (picked.state.installed && !own) return { ...observed, problem: observationProblem('ownership unknown') };
        if (!own) return observed;
        return { ...observed, ...(picked.auto.runtime?.() ?? { problem: observationProblem('runtime unknown') }) };
      } catch (error) { return { ...base, problem: observationProblem(error) }; }
    },
  };
}

// Callers know the program log path; only the autostart owner knows a manager's actual
// definition name. A missing or unreadable definition cannot supply a journal command.
export function autostartOutput(system: System, spec: ServiceSpec): string {
  let state: AutostartState | undefined;
  try { state = autostartFor(system, roleOf(spec)).state(spec); } catch { /* Preserve the startup failure; status/doctor can explain the definition. */ }
  if (state?.installed && state.mine && !state.unknown) {
    return state.logs ? `输出用 ${state.logs} 查看。` : `输出在 ${spec.logFile}。`;
  }
  const command = roleOf(spec) === 'node' ? 'tycho node service status' : 'tycho service status';
  return `程序日志（若已写出）在 ${spec.logFile}。用 ${command} 或 tycho doctor 核实自启定义。`;
}
