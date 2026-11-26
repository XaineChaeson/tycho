// Guards against an autostart that does not come up, or comes up wrong, after the next
// login: a definition that names a relative path or leans on the shell's PATH, a path with
// spaces, quotes or non-ASCII characters split or mangled by the service manager's own
// quoting, a Windows task that is ended after three days or never starts on battery, a
// second install leaving two definitions that both start the service, a refused scheduled
// task leaving nothing installed while saying it is, a stop that ends the manager's job
// instead of asking the service (a crash, by this service's rules), a second service
// started on a data directory already in use, and a stale definition read as current.
//
// And against a service manager's failure passed over: a unit still enabled, a job still
// loaded or a task still registered reported as removed; something that was never there
// reported as a failure; a refused update of an existing task answered with a second
// entry in the Startup folder, or two entries hidden behind one; a task whose action was
// edited by hand read as current because its description still carries the old mark, or a
// current one read as stale because the query came back in the console's code page; a
// start that passes through cmd's %NAME% expansion, or is reported though nothing was
// started; a stop left to whatever timeout the user manager happens to have; and a fake
// service manager that starts the service by itself, so that no test ever sees a command
// claim a start it did not wait for.
//
// And against a service that cannot find its tools because its manager gave it a bare PATH:
// the terminal's PATH mangled by the definition's quoting, not written at all,
// or making a good definition read as stale from any other terminal.
//
// And against a service that comes up with a console window on the owner's desktop when it
// was meant to come up in the background: a task that starts PowerShell directly, whose own
// hidden window Windows 11 with Windows Terminal as the default terminal no longer honours,
// instead of asking the console host for a console with no window at all — and, on a system
// older than the build that brought `--headless`, against losing the way that older system
// has. Which of the two an action is comes from the system's own build number and whether
// System32\conhost.exe is there, and from nothing measured at the time: a probe that timed
// out on a busy machine used to fall back to PowerShell, so one installation could write one
// action and doctor judge another by it. And against a definition that was written but is
// not what this version would write being called synced: the action Task Scheduler hands
// back is read and compared with the same expected action doctor uses.
// And against the action being measured under handles no task gives it: a console host
// counts any one valid handle among its standard ones as the far end of a pseudoconsole —
// its own rule for entering that mode — so an action whose output a test sends to a file, to
// read what the service said, is not the action a task runs: on Windows 11 the one wired
// that way started nothing at all. What is read back instead is what the action itself left
// behind.
// And against a one-time login link printed where it outlives its use: the service's own
// log file, or a task's console, instead of only where the owner asked for it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ServiceSpec } from '../cli/autostart.ts';
import { autostartFor, conhostPath, handleFreeLaunch, HOLD_CONSOLE_BREAKS, launchArgs, launchdPlist, nameOf, ownerId, startupCmd, systemdUnit, TASK_QUERY, windowsScript, windowsTaskXml } from '../cli/autostart.ts';
import { serviceSpec } from '../cli/install.ts';
import { checkAutostart } from '../cli/doctor.ts';
import { runCli } from '../cli/main.ts';
import type { ExecResult } from '../cli/system.ts';
import { realSystem, tool } from '../cli/system.ts';
import type { Call, StageOptions } from './cli-helpers.ts';
import { alive, stage, startStub, STUB_SERVICE, tempDir, until } from './cli-helpers.ts';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// What Windows 10 1703 and later have, and what a task starts instead of PowerShell itself
// when it does: only the console host can be told to make no window at all.
const CONHOST = 'C:\\Windows\\System32\\conhost.exe';
const WIN: ServiceSpec = {
  program: ["C:\\Users\\张 三\\it's & co\\bin\\tycho.cmd"],
  dataDir: 'D:\\数据 目录\\host',
  logFile: 'D:\\数据 目录\\host\\service.log',
};
const POSIX: ServiceSpec = {
  program: ['/home/张 三/it\'s "50%" $HOME/bin/tycho'],
  dataDir: '/data/数据 目录/a\\b',
  logFile: '/data/数据 目录/a\\b/service.log',
};

const unescape = (text: string): string =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const element = (xml: string, name: string): string => unescape(new RegExp(`<${name}>(.*)</${name}>`).exec(xml)![1]!);

// ---- What each system is told ----

// What every Windows definition wraps the command in: started again after a failure, left
// alone after a clean stop, given up on after five failures in a row. The marker says the
// service was started by the autostart, where nobody is reading its output and a one-time
// login link would be left behind for whoever does.
const looped = (data: string, command: string): string =>
  `${HOLD_CONSOLE_BREAKS}; $env:TYCHO_DATA=${data}; $env:TYCHO_AUTOSTART='1'; $failed=0; while ($true) { $began=Get-Date; & ${command}; if ($LASTEXITCODE -eq 0) { exit 0 }; if (((Get-Date)-$began).TotalSeconds -ge 60) { $failed=0 }; $failed++; if ($failed -ge 5) { exit 1 }; Start-Sleep -Seconds 3 }`;

test('Windows：计划任务经 conhost --headless 启动 PowerShell，在登录时以当前用户运行，带上数据目录', () => {
  const xml = windowsTaskXml({ user: 'PC\\张三', powershell: POWERSHELL, spec: WIN, conhost: CONHOST });
  assert.equal(element(xml, 'Command'), CONHOST, '只起 PowerShell 的话，Windows 11 会给它一个看得见的窗口');
  assert.equal(
    element(xml, 'Arguments'),
    `--headless ${POWERSHELL} -NoProfile -NonInteractive -WindowStyle Hidden -Command "${looped("'D:\\数据 目录\\host'", "'C:\\Users\\张 三\\it''s & co\\bin\\tycho.cmd' 'run' '--log' 'D:\\数据 目录\\host\\service.log'")}"`,
  );
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\张三<\/UserId>/);
  assert.match(xml, /<Principal id="Author">\s*<UserId>PC\\张三<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
  // Raw "&" would make the file unreadable to Task Scheduler.
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;)/);
});

test('Windows：System32 里没有 conhost 的老系统，动作还是直接起 PowerShell', () => {
  const xml = windowsTaskXml({ user: 'PC\\owner', powershell: POWERSHELL, spec: WIN, conhost: null });
  assert.equal(element(xml, 'Command'), POWERSHELL);
  assert.equal(
    element(xml, 'Arguments'),
    `-NoProfile -NonInteractive -WindowStyle Hidden -Command "${looped("'D:\\数据 目录\\host'", "'C:\\Users\\张 三\\it''s & co\\bin\\tycho.cmd' 'run' '--log' 'D:\\数据 目录\\host\\service.log'")}"`,
  );
  assert.doesNotMatch(xml, /--headless/);
});

test('Windows：不重复启动第二个、不到期、不挑电源', () => {
  const xml = windowsTaskXml({ user: 'PC\\owner', powershell: POWERSHELL, spec: WIN, conhost: CONHOST });
  assert.equal(element(xml, 'MultipleInstancesPolicy'), 'IgnoreNew');
  assert.equal(element(xml, 'ExecutionTimeLimit'), 'PT0S');
  assert.equal(element(xml, 'DisallowStartIfOnBatteries'), 'false');
  assert.equal(element(xml, 'StopIfGoingOnBatteries'), 'false');
});

test('Windows：路径里的引号不会把 PowerShell 的字符串截断', () => {
  // The curly ones end a PowerShell string as well.
  const spec: ServiceSpec = { program: ['C:\\a’b\\tycho.cmd'], dataDir: "C:\\o'k", logFile: "C:\\o'k\\service.log" };
  assert.equal(windowsScript(spec), looped("'C:\\o''k'", "'C:\\a’’b\\tycho.cmd' 'run' '--log' 'C:\\o''k\\service.log'"));
});

const ONLY_WINDOWS = process.platform !== 'win32' && '只有 Windows 上有 powershell.exe';

const REAL_POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const REAL_CONHOST = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe');
// The console host this machine has, or null where it has none: the same answer the CLI
// reaches for the definition it writes here.
const HERE_CONHOST = existsSync(REAL_CONHOST) ? REAL_CONHOST : null;

// The console host started the way a task's action is started: with no standard handles,
// through ShellExecute (see handleFreeLaunch). Any valid standard handle, NUL included,
// puts the console host in pseudoconsole mode with that handle as its terminal, and a
// terminal that is NUL ends at once — then whether the client ever ran is a race the
// client loses under load. A test process cannot give a child no handles itself, so it
// asks the way the CLI's own probe asks.
function runConhost(argumentLine: string, timeout: number) {
  const { file, args, env } = handleFreeLaunch(REAL_POWERSHELL, HERE_CONHOST!, argumentLine);
  return spawnSync(file, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore', timeout });
}

// Whether this machine's console host can run a command at all, asked once with a program
// that writes a file, under the same wiring the action itself is run with (see runAction
// below). A harness that gives every process a pseudo-console of its own — an agent's
// sandbox — can still be the terminal at the console host's other end: there it starts,
// prints terminal codes and exits without running anything, so what a task would get from
// it cannot be observed on that machine.
const HERE_CONHOST_RUNS = ((): boolean => {
  if (HERE_CONHOST === null) return false;
  const dir = mkdtempSync(join(tmpdir(), 'tycho-conhost-'));
  try {
    const ran = join(dir, 'ran.txt');
    const probe = join(dir, 'probe.mjs');
    writeFileSync(probe, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ran)}, 'ran');\n`);
    runConhost(`--headless "${process.execPath}" "${probe}"`, 60_000);
    return existsSync(ran);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// A program that records how it was called and exits with the codes in `plan`, one per
// run, the last one repeating; and the service definition that runs it.
function probeIn(dir: string, plan: number[]) {
  mkdirSync(dir);
  const probe = join(dir, 'probe.mjs');
  const seen = join(dir, 'seen.jsonl');
  writeFileSync(
    probe,
    [
      "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
      `const seen = ${JSON.stringify(seen)};`,
      `const plan = ${JSON.stringify(plan)};`,
      "const run = existsSync(seen) ? readFileSync(seen, 'utf8').trim().split('\\n').length : 0;",
      "appendFileSync(seen, JSON.stringify({ argv: process.argv.slice(2), data: process.env.TYCHO_DATA }) + '\\n');",
      'process.exit(plan[Math.min(run, plan.length - 1)]);',
      '',
    ].join('\n'),
  );
  const spec: ServiceSpec = { program: [process.execPath, probe], dataDir: dir, logFile: join(dir, 'service.log') };
  const runs = (): { argv: string[]; data: string }[] =>
    existsSync(seen)
      ? readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; data: string })
      : [];
  return { spec, seen, runs, expected: { argv: ['run', '--log', join(dir, 'service.log')], data: dir } };
}

// The task's action, run the way a task is started: no terminal of its own anywhere, no
// standard handle, and nothing a test reads but what the program wrote. The question above
// (does this console host run a command at all?) and the action are asked the same way, so
// what the tests read back is what the probe wrote rather than what anything said.
function runAction(t: TestContext, plan: number[]) {
  const dir = join(tempDir(t), "空 格 it's & 数据");
  const { spec, runs, expected } = probeIn(dir, plan);
  const xml = windowsTaskXml({ user: 'PC\\owner', powershell: POWERSHELL, spec, conhost: HERE_CONHOST });
  // What the action says, split where a console host splits it: the program it is told to
  // run, and the command line after it. Asserted here, so that a change in the action's
  // shape fails this test and not only the machine it runs on.
  const written = element(xml, 'Arguments');
  const head = HERE_CONHOST === null ? '' : `--headless ${POWERSHELL} `;
  assert.ok(written.startsWith(head), written);
  const line = written.slice(head.length);
  // Through the console host where this machine's console host runs what it is given;
  // otherwise the command line it would be given is run as PowerShell's own, which is the
  // part this repository writes, and which says what it could not do.
  const through = HERE_CONHOST_RUNS ? 'console-host' : 'powershell';
  let status: number | null;
  let trouble: string;
  if (through === 'console-host') {
    const ran = runConhost(written, 120_000);
    status = ran.status;
    trouble = ran.error?.message ?? '';
  } else {
    const file = join(dir, 'action.log');
    const log = openSync(file, 'a');
    let ran;
    try {
      ran = spawnSync(REAL_POWERSHELL, [line], { windowsVerbatimArguments: true, windowsHide: true, timeout: 120_000, stdio: ['ignore', log, log] });
    } finally {
      closeSync(log);
    }
    status = ran.status;
    trouble = ran.error === undefined ? readFileSync(file, 'utf8').slice(-2000) : ran.error.message;
  }
  const made = runs();
  const said = [`经过：${through === 'console-host' ? '控制台宿主' : 'PowerShell'}，程序被运行 ${made.length} 次`, trouble].filter(Boolean).join('\n');
  return { status, said, through, runs: made, expected };
}

test('Windows：这条命令真的把参数和数据目录原样交到程序手里；正常停止后不重启', { skip: ONLY_WINDOWS }, (t) => {
  const { status, said, runs, expected } = runAction(t, [0]);
  assert.deepEqual(runs, [expected], said);
  assert.equal(status, 0, said);
});

test('Windows：服务异常退出后被重新启动', { skip: ONLY_WINDOWS }, (t) => {
  const { status, said, runs, expected } = runAction(t, [7, 0]);
  assert.deepEqual(runs, [expected, expected], said);
  assert.equal(status, 0, said);
});

test('Windows：一直起不来的服务，连续失败五次后不再重启', { skip: ONLY_WINDOWS }, (t) => {
  const { status, said, runs, through } = runAction(t, [7]);
  // Five runs is the wrapper's own limit, and the command has come back: one that gave up
  // on another count, or never gave up, is a different answer.
  assert.equal(runs.length, 5, said);
  // A console host that ran the action answers with its own exit code; `exit 1` is the
  // wrapper's answer only where the wrapper is the program this ran.
  if (through === 'powershell') assert.equal(status, 1, said);
});

test('Windows：直接启动时脚本作为编码后的数据交给 PowerShell，路径里的 %NAME% 和引号原样到达', { skip: ONLY_WINDOWS }, async (t) => {
  // %TEMP% is set wherever this runs: as text on its way through cmd it would be replaced.
  const { spec, seen, runs, expected } = probeIn(join(tempDir(t), "%TEMP% it's & 数据"), [0]);
  const args = launchArgs(spec);
  assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  assert.match(args.at(-1)!, /^[A-Za-z0-9+/=]+$/, '经过 cmd 的只能是它不会改写的字符');
  assert.equal(Buffer.from(args.at(-1)!, 'base64').toString('utf16le'), windowsScript(spec));
  // Through cmd's `start`, as the command itself does it.
  assert.equal(realSystem().launch(REAL_POWERSHELL, args), null);
  await until('程序被启动并记下它拿到的参数', () => existsSync(seen) && readFileSync(seen, 'utf8').endsWith('\n'));
  assert.deepEqual(runs(), [expected]);
});

test('Windows：查计划任务的脚本把“没有这个任务”答成 absent，不当成出错', { skip: ONLY_WINDOWS }, () => {
  // Read-only, and under a name nothing registers.
  const asked = spawnSync(REAL_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', TASK_QUERY], {
    env: { ...process.env, TYCHO_TASK: `tycho-test-absent-${process.pid}` },
    windowsHide: true,
    encoding: 'utf8',
  });
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(asked.stdout.trim(), 'absent');
});

test('Windows：“启动”文件夹里的文件只含英文字符，主目录下的路径走 %USERPROFILE%', () => {
  const home = 'C:\\Users\\张 三';
  const spec: ServiceSpec = {
    program: [`${home}\\.tycho\\app\\bin\\tycho.cmd`],
    dataDir: `${home}\\.tycho\\host`,
    logFile: `${home}\\.tycho\\host\\100%.log`,
  };
  const content = startupCmd({ powershell: POWERSHELL, spec, home });
  assert.match(content, /^[\x20-\x7e\r\n]*$/);
  assert.ok(
    content.includes(
      `start "" /min "${POWERSHELL}" -NoProfile -NonInteractive -WindowStyle Hidden -Command "${looped("'%USERPROFILE%\\.tycho\\host'", "'%USERPROFILE%\\.tycho\\app\\bin\\tycho.cmd' 'run' '--log' '%USERPROFILE%\\.tycho\\host\\100%%.log'")}"`,
    ),
    content,
  );
  // Outside the home directory there is no way round the code page: refused, not mangled.
  assert.throws(() => startupCmd({ powershell: POWERSHELL, spec: WIN, home }), /英文字符/);
  // An apostrophe in the user's name would end the PowerShell string once expanded.
  const quoted = "C:\\Users\\O'Brien";
  const plain = startupCmd({ powershell: POWERSHELL, spec: { program: [`${quoted}\\tycho.cmd`], dataDir: 'D:\\d', logFile: 'D:\\d\\l' }, home: quoted });
  assert.ok(plain.includes("& 'C:\\Users\\O''Brien\\tycho.cmd'"), plain);
});

test('Linux：unit 里是绝对路径和数据目录，失败才重启，引号、%、$ 都不被 systemd 改写', () => {
  assert.equal(
    systemdUnit(POSIX),
    [
      `# tycho-autostart owner:${ownerId(POSIX)}`,
      '[Unit]',
      'Description=tycho host',
      'StartLimitIntervalSec=60',
      'StartLimitBurst=5',
      '',
      '[Service]',
      'ExecStart="/home/张 三/it\'s \\"50%%\\" $$HOME/bin/tycho" "run"',
      'Environment="TYCHO_DATA=/data/数据 目录/a\\\\b"',
      // What tells `tycho run` that nobody is reading its output.
      'Environment="TYCHO_AUTOSTART=1"',
      'Restart=on-failure',
      'RestartSec=5',
      'KillMode=mixed',
      // Written out: left unsaid, it is whatever the user manager was configured with.
      'TimeoutStopSec=90',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  );
});

test('macOS：LaunchAgent 以参数数组启动，登录即运行，正常退出不重启', () => {
  const plist = launchdPlist({ program: ['/Users/张 三/a&b <c>/bin/tycho'], dataDir: '/Users/张 三/.tycho/host', logFile: '/Users/张 三/.tycho/host/service.log' });
  assert.match(plist, /<key>Label<\/key>\s*<string>tycho<\/string>/);
  assert.match(
    plist,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/张 三\/a&amp;b &lt;c&gt;\/bin\/tycho<\/string>\s*<string>run<\/string>\s*<string>--log<\/string>\s*<string>\/Users\/张 三\/.tycho\/host\/service.log<\/string>\s*<\/array>/,
  );
  assert.match(plist, /<key>TYCHO_DATA<\/key>\s*<string>\/Users\/张 三\/.tycho\/host<\/string>/);
  assert.match(plist, /<key>TYCHO_AUTOSTART<\/key>\s*<string>1<\/string>/, '由自启拉起的服务不打印登录链接');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
});

// ---- Installing, with the service manager faked ----

const DENIED = { code: 1, stderr: 'ERROR: Access is denied.' };

interface SchedulerOptions {
  // Each names what Task Scheduler refuses or cannot do.
  refuse?: boolean;
  keep?: boolean;
  noRun?: boolean;
  // The query itself gets no answer.
  deaf?: boolean;
}

// Task Scheduler as far as the CLI can tell: what was registered is what a query returns.
// Changes go through schtasks; the query goes through PowerShell, which names the task
// in its environment and answers in base64.
function scheduler(options: SchedulerOptions = {}) {
  const state = { xml: null as string | null, written: '', name: 'tycho' };
  const respond: StageOptions['respond'] = (call) => {
    if (call.env.TYCHO_TASK !== undefined) {
      if (options.deaf) return { code: 1, stderr: 'New-Object : Access is denied.' };
      return { stdout: state.xml === null || call.env.TYCHO_TASK !== state.name ? 'absent\r\n' : `present ${Buffer.from(state.xml).toString('base64')}\r\n` };
    }
    if (!/schtasks/i.test(call.file)) return undefined;
    const [verb] = call.args;
    if (verb === '/Create') {
      if (options.refuse) return DENIED;
      state.name = call.args[call.args.indexOf('/TN') + 1]!;
      state.written = readFileSync(call.args[call.args.indexOf('/XML') + 1]!, 'utf16le');
      // Without the byte order mark, as Task Scheduler hands a definition back.
      state.xml = state.written.charCodeAt(0) === 0xfeff ? state.written.slice(1) : state.written;
      return undefined;
    }
    if (state.xml === null) return { code: 1, stderr: 'ERROR: The system cannot find the file specified.' };
    if (verb === '/Delete') {
      if (options.keep) return DENIED;
      state.xml = null;
    }
    if (verb === '/Run' && options.noRun) return DENIED;
    return undefined;
  };
  return { state, options, respond };
}

const verbs = (calls: Call[], program: RegExp): string[] => calls.filter(({ file }) => program.test(file)).map(({ args }) => args.join(' '));
const ownName = (spec: ServiceSpec): string => `${nameOf(spec.role ?? 'host')}-${ownerId(spec)}`;
const startupFileOf = (s: { cli: { system: { env: NodeJS.ProcessEnv; home: string } } }): string =>
  join(s.cli.system.env.APPDATA!, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${ownName(winSpec(s.cli.system.home))}.cmd`);
const freshUnit = (s: ReturnType<typeof stage>): string => `${ownName(serviceSpec(s.cli.system, s.cli.appRoot))}.service`;

function winSpec(home: string): ServiceSpec {
  return { program: [`${home}\\app\\bin\\tycho.cmd`], dataDir: `${home}\\host`, logFile: `${home}\\host\\service.log` };
}

test('Windows：装两次还是一个任务；定义变了才算过期；卸载后不在', (t) => {
  const tasks = scheduler();
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const autostart = autostartFor(s.cli.system);
  const spec = winSpec(s.home);
  assert.deepEqual(autostart.state(spec), { installed: false, notes: [] });

  const said = autostart.install(spec, { start: true }).join('\n');
  assert.match(said, /计划任务/);
  assert.match(said, /管理员/, '要说明不做“开机未登录就运行”');
  // UTF-16 with its mark: the only form schtasks reads paths outside ASCII from.
  assert.equal(tasks.state.written.charCodeAt(0), 0xfeff);
  assert.match(tasks.state.xml!, /<UserId>PC\\owner<\/UserId>/);
  const first = tasks.state.xml;
  autostart.install(spec, { start: false });
  assert.equal(tasks.state.xml, first);
  assert.deepEqual(verbs(s.calls, /schtasks/).map((line) => line.split(' ')[0]), ['/Create', '/Run', '/Create']);
  for (const line of verbs(s.calls, /schtasks/).filter((each) => each.startsWith('/Create'))) assert.ok(line.includes(`/TN ${ownName(spec)} /XML `));
  assert.equal(autostart.state(spec).current, true);
  assert.equal(autostart.state({ ...spec, program: ['C:\\elsewhere\\tycho.cmd'] }).installed, false);

  assert.match(autostart.uninstall(spec).join('\n'), /已删除计划任务/);
  assert.equal(autostart.state(spec).installed, false);
  assert.match(autostart.uninstall(spec).join('\n'), /本来就没有安装/);
});

test('Windows：计划任务被拒时退到“启动”文件夹，并说清用的是哪种', (t) => {
  const tasks = scheduler({ refuse: true });
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const autostart = autostartFor(s.cli.system);
  const spec = winSpec(s.home);
  const file = startupFileOf(s);

  const said = autostart.install(spec, { start: true }).join('\n');
  assert.match(said, /计划任务没建成/);
  assert.match(said, /Access is denied/);
  assert.ok(said.includes(file));
  assert.doesNotMatch(said, /查不了/, '查得到、确实没有任务时，不必提醒去看');
  assert.match(readFileSync(file, 'utf8'), /tycho\.cmd' 'run'/);
  // Started now as well, the way the file would at the next login; the script as data,
  // so that cmd, which `start` goes through, has no text of it to rewrite.
  assert.deepEqual(s.launched.map(({ file: program, args }) => [program, ...args]), [[tool(s.cli.system, 'powershell'), ...launchArgs(spec)]]);
  assert.equal(s.launched[0]!.args.at(-2), '-EncodedCommand');

  const state = autostart.state(spec);
  assert.equal(state.installed, true);
  assert.equal(state.current, true);
  assert.match(state.kind!, /启动/);
  assert.equal(autostart.state({ ...spec, dataDir: 'D:\\other' }).current, false);

  assert.ok(autostart.uninstall(spec).join('\n').includes(file));
  assert.equal(existsSync(file), false);
});

test('Windows：已有计划任务而更新被拒：保持原状并报告，不往“启动”文件夹加第二个入口', (t) => {
  const tasks = scheduler();
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const autostart = autostartFor(s.cli.system);
  const spec = winSpec(s.home);
  autostart.install(spec, { start: false });
  const registered = tasks.state.xml;
  tasks.options.refuse = true;

  // The same definition again: refused, and what stands is this copy's and current.
  assert.throws(
    () => autostart.install(spec, { start: true }),
    (err: Error) => {
      assert.match(err.message, /更新被拒/);
      assert.match(err.message, /Access is denied/);
      assert.match(err.message, /保持原样/);
      assert.match(err.message, /是这一份 tycho/);
      assert.match(err.message, /和这个版本要写的一样/);
      return true;
    },
  );
  assert.equal(existsSync(startupFileOf(s)), false, '两个入口都在的话，登录时会启动两次');
  assert.deepEqual(s.launched, [], '没装成就不该启动什么');
  assert.equal(verbs(s.calls, /schtasks/).some((line) => line.startsWith('/Run')), false);
  assert.equal(tasks.state.xml, registered);
  assert.match(autostart.state(spec).kind!, /计划任务/);
});

test('Windows：查不了任务归属时不写启动文件、不替换或卸载', (t) => {
  const tasks = scheduler({ refuse: true, deaf: true });
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const auto = autostartFor(s.cli.system), spec = winSpec(s.home);
  assert.throws(() => auto.install(spec, {start:false}), /查不了计划任务/);
  assert.throws(() => auto.uninstall(spec), /查不了计划任务/);
  assert.throws(() => auto.state(spec), /查不了计划任务/);
  assert.equal(existsSync(startupFileOf(s)),false);
  assert.equal(s.calls.some(c => /schtasks/i.test(c.file)),false);
});

test('Windows：任务建成后，上次留在“启动”文件夹里的那个被拿掉', (t) => {
  const tasks = scheduler({ refuse: true });
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const autostart = autostartFor(s.cli.system);
  const spec = winSpec(s.home);
  const file = startupFileOf(s);
  autostart.install(spec, { start: false });
  assert.ok(existsSync(file));
  tasks.options.refuse = false;
  autostart.install(spec, { start: false });
  assert.equal(existsSync(file), false, '两个都在的话，登录时会启动两次');
  assert.match(autostart.state(spec).kind!, /计划任务/);
  assert.deepEqual(autostart.state(spec).notes, []);
});

test('Windows：计划任务和“启动”文件夹里的文件都在时，两个入口都报出来', (t) => {
  const tasks = scheduler();
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const autostart = autostartFor(s.cli.system);
  const spec = winSpec(s.home);
  autostart.install(spec, { start: false });
  const file = startupFileOf(s);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, startupCmd({ powershell: POWERSHELL, spec, home: s.home }));

  const state = autostart.state(spec);
  assert.match(state.kind!, /计划任务/);
  assert.ok(state.notes.join('\n').includes(file), '第二个入口不能被计划任务盖住');
  assert.match(state.notes.join('\n'), /启动两次/);
  // Started through the task, once: the file would be a second service.
  autostart.start(spec);
  assert.deepEqual(s.launched, []);
  // And both go when it is uninstalled.
  const said = autostart.uninstall(spec).join('\n');
  assert.match(said, /已删除计划任务/);
  assert.ok(said.includes(file));
  assert.deepEqual(autostart.state(spec), { installed: false, notes: [] });
});

// What Task Scheduler gave back for a definition this code wrote (Windows 11): its own
// layout and defaults, the quotes of the arguments no longer escaped.
const asReturned = (xml: string): string =>
  xml
    .replaceAll('&quot;', '"')
    .replace('<AllowHardTerminate>', '<IdleSettings>\r\n      <StopOnIdleEnd>true</StopOnIdleEnd>\r\n    </IdleSettings>\r\n    <WakeToRun>false</WakeToRun>\r\n    <AllowHardTerminate>');

test('Windows：定义是否过期看任务的实际动作：系统改过排版不算，手工改了动作就算，描述里的标记说了不算', (t) => {
  const tasks = scheduler();
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const autostart = autostartFor(s.cli.system);
  // Paths the console's code page would not bring back whole.
  const spec: ServiceSpec = { program: ["D:\\工具 镕喆\\it's & <co>\\tycho.cmd"], dataDir: 'D:\\数据 目录\\host', logFile: 'D:\\数据 目录\\host\\service.log' };
  autostart.install(spec, { start: false });
  const written = tasks.state.xml!;
  tasks.state.xml = asReturned(written);
  assert.notEqual(tasks.state.xml, written);
  assert.deepEqual(autostart.state(spec), { installed: true, mine: true, kind: '计划任务', where: `计划任务“${ownName(spec)}”`, current: true, notes: [] });

  // Edited in Task Scheduler's own window: the description, and so every mark in it, stays.
  tasks.state.xml = written.replace("'run'", "'run' '--port' '9999'");
  assert.equal(element(tasks.state.xml, 'Description'), element(written, 'Description'));
  assert.equal(autostart.state(spec).current, false);
  assert.equal(autostart.state(spec).mine, true);
  tasks.state.xml = written.replace(/<Command>.*<\/Command>/, '<Command>C:\\other\\powershell.exe</Command>');
  assert.equal(autostart.state(spec).current, false);
  tasks.state.xml = written.replace(/\s*<Exec>[\s\S]*<\/Exec>/, '');
  assert.equal(autostart.state(spec).current, false, '没有动作的任务什么都不启动');
});

// A Windows whose System32 does or does not have conhost.exe: one of the two facts that
// decide how a task's action is written (the other is the build number, which a test gives
// through `system.release`).
function windowsRoot(t: TestContext, { conhost }: { conhost: boolean }): string {
  const root = join(tempDir(t), 'windows');
  mkdirSync(join(root, 'System32'), { recursive: true });
  if (conhost) writeFileSync(join(root, 'System32', 'conhost.exe'), '');
  return root;
}

// Windows 10 1809. `conhost --headless` came with this build; below it the action is
// PowerShell itself.
const HEADLESS_WINDOWS = '10.0.22631';
const BEFORE_HEADLESS = '10.0.17762';

test('Windows：内部版本 17763 起用 conhost 无窗口包装，host 和 node 一样，doctor 判正常', (t) => {
  const tasks = schedulerByName();
  const root = windowsRoot(t, { conhost: true });
  const s = stage(t, { platform: 'win32', respond: tasks.respond, env: { SystemRoot: root }, system: { release: HEADLESS_WINDOWS } });
  const host = winSpec(s.home);
  const node = { ...host, role: 'node' as const, logFile: `${s.home}\\host\\node.log` };
  autostartFor(s.cli.system, 'host').install(host, { start: false });
  autostartFor(s.cli.system, 'node').install(node, { start: false });

  const console = join(root, 'System32', 'conhost.exe');
  for (const spec of [host, node]) {
    const name = ownName(spec);
    assert.equal(element(tasks.tasks.get(name)!, 'Command'), console, name);
    assert.match(element(tasks.tasks.get(name)!, 'Arguments'), /^--headless /, name);
  }
  assert.equal(checkAutostart(s.cli.system, host, 'host').level, 'ok');
  assert.equal(checkAutostart(s.cli.system, node, 'node').level, 'ok');

  // What a version before this one wrote: PowerShell itself, whose own hidden window
  // Windows 11 with Windows Terminal as the default terminal no longer honours.
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stale = tasks.tasks.get(ownName(host))!.replace(`<Command>${console}</Command>`, `<Command>${powershell}</Command>`).replace('--headless ', '');
  assert.doesNotMatch(stale, /--headless/);
  tasks.tasks.set(ownName(host), stale);
  assert.equal(autostartFor(s.cli.system, 'host').state(host).current, false, '老定义要更新才会用上无窗口包装');
  const judged = checkAutostart(s.cli.system, host, 'host');
  assert.equal(judged.level, 'warn');
  assert.match(judged.detail, /过期/);
});

test('Windows：内部版本低于 17763 的两个角色都退回 PowerShell，doctor 也按退路判正常', (t) => {
  const tasks = schedulerByName();
  // The file is there; the system is older than the build that gave it `--headless`.
  const root = windowsRoot(t, { conhost: true });
  const s = stage(t, { platform: 'win32', respond: tasks.respond, env: { SystemRoot: root }, system: { release: BEFORE_HEADLESS } });
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const host = winSpec(s.home);
  const node = { ...host, role: 'node' as const, logFile: `${s.home}\\host\\node.log` };
  autostartFor(s.cli.system, 'host').install(host, { start: false });
  autostartFor(s.cli.system, 'node').install(node, { start: false });

  for (const spec of [host, node]) {
    const name = ownName(spec);
    assert.equal(element(tasks.tasks.get(name)!, 'Command'), powershell, name);
    assert.doesNotMatch(element(tasks.tasks.get(name)!, 'Arguments'), /--headless/, name);
  }
  assert.equal(checkAutostart(s.cli.system, host, 'host').level, 'ok');
  assert.equal(checkAutostart(s.cli.system, node, 'node').level, 'ok');

  // A definition naming the console host starts nothing on this system: it is stale here.
  tasks.tasks.set(ownName(host), windowsTaskXml({ user: 'PC\\owner', powershell, conhost: join(root, 'System32', 'conhost.exe'), spec: host }));
  assert.equal(autostartFor(s.cli.system, 'host').state(host).current, false, '这台机器上跑不了 --headless，那一份要换回退路');

  // And a system with no console host at all, whatever its build number says: the action is
  // the one it has always been, not one that would fail to start there.
  const bare = scheduler();
  const none = windowsRoot(t, { conhost: false });
  const other = stage(t, { platform: 'win32', respond: bare.respond, env: { SystemRoot: none }, system: { release: HEADLESS_WINDOWS } });
  autostartFor(other.cli.system).install(winSpec(other.home), { start: false });
  assert.equal(element(bare.state.xml!, 'Command'), join(none, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.doesNotMatch(bare.state.xml!, /--headless/);
});

test('Windows：动作只由内部版本和 conhost 在不在决定，机器慢、探针超时都改不了它', (t) => {
  const root = windowsRoot(t, { conhost: true });
  const console = join(root, 'System32', 'conhost.exe');
  const tasks = scheduler();
  const s = stage(t, { platform: 'win32', respond: tasks.respond, env: { SystemRoot: root }, system: { release: HEADLESS_WINDOWS } });
  // Nothing is run to find out, so nothing about how busy the machine is can reach it.
  assert.equal(conhostPath(s.cli.system), console);
  assert.deepEqual(s.calls, [], '决定动作时不该问这台机器任何东西');

  // A stand-in that never answers a call with a deadline — the old way of asking always had
  // one — leaves the written action and its judgement exactly as they were.
  const inner = s.cli.system.exec;
  s.cli.system.exec = (file, args, options) => {
    if (options?.timeoutMs !== undefined) throw new Error('超时：这个替身从不在时限内回答');
    return inner(file, args, options);
  };
  const spec = winSpec(s.home);
  autostartFor(s.cli.system).install(spec, { start: false });
  assert.equal(element(tasks.state.xml!, 'Command'), console);
  assert.match(element(tasks.state.xml!, 'Arguments'), /^--headless /);
  assert.equal(autostartFor(s.cli.system).state(spec).current, true);

  // Which system this is stays the whole answer.
  s.cli.system.release = BEFORE_HEADLESS;
  assert.equal(conhostPath(s.cli.system), null, '低于 17763 没有 --headless');
  s.cli.system.release = '';
  assert.equal(conhostPath(s.cli.system), null, '读不出内部版本号就用到处都能跑的退路');
  s.cli.system.release = HEADLESS_WINDOWS;
  assert.equal(conhostPath(s.cli.system), console);
});

test('Windows：写进去的和应当的不一样时不说已同步', (t) => {
  const tasks = scheduler();
  const root = windowsRoot(t, { conhost: true });
  const console = join(root, 'System32', 'conhost.exe');
  const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const s = stage(t, {
    platform: 'win32',
    env: { SystemRoot: root },
    system: { release: HEADLESS_WINDOWS },
    respond(call) {
      // What Task Scheduler is asked for comes back with another action than the one it was
      // given: the definition it holds is PowerShell directly.
      if (call.env.TYCHO_TASK !== undefined && tasks.state.xml !== null) {
        tasks.state.xml = tasks.state.xml.replace(`<Command>${console}</Command>`, `<Command>${powershell}</Command>`).replace('--headless ', '');
      }
      return tasks.respond!(call);
    },
  });
  const spec = winSpec(s.home);
  assert.throws(
    () => autostartFor(s.cli.system).install(spec, { start: false }),
    (err: Error) => {
      assert.match(err.message, /写进去的和应当的不一样/);
      assert.match(err.message, /启动的程序是/);
      assert.doesNotMatch(err.message, /已装好/);
      return true;
    },
  );
  assert.equal(autostartFor(s.cli.system).state(spec).current, false);

  // And one that cannot be read back at all is not a synced definition either.
  const deaf = scheduler();
  const other = stage(t, { platform: 'win32', env: { SystemRoot: root }, system: { release: HEADLESS_WINDOWS }, respond(call) {
    const result = deaf.respond!(call);
    if (call.args[0] === '/Create') deaf.options.deaf = true;
    return result;
  } });
  assert.throws(
    () => autostartFor(other.cli.system).install(winSpec(other.home), { start: false }),
    /写进去的和应当的不一样（写完之后查不了计划任务/,
  );
});

test('Windows：删除计划任务没成功时查它还在不在，如实报告；“启动”文件夹里的照删', (t) => {
  const tasks = scheduler({ keep: true });
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const autostart = autostartFor(s.cli.system);
  const spec = winSpec(s.home);
  tasks.options.refuse = true;
  autostart.install(spec, { start: false });
  tasks.options.refuse = false;
  tasks.state.name = ownName(spec);
  tasks.state.xml = windowsTaskXml({ user: 'PC\\owner', powershell: POWERSHELL, spec, conhost: HERE_CONHOST });
  const file = startupFileOf(s);

  assert.throws(
    () => autostart.uninstall(spec),
    (err: Error) => {
      assert.match(err.message, /删除计划任务“tycho[^”]*”没成功/);
      assert.match(err.message, /Access is denied/);
      assert.match(err.message, /它还在/);
      assert.ok(err.message.includes(`已删除“启动”文件夹里的 ${file}`), err.message);
      return true;
    },
  );
  assert.equal(existsSync(file), false);
  assert.equal(autostart.state(spec).installed, true);

  // The deletion reported an error and the task is gone all the same: that is removed.
  const gone = scheduler();
  const other = stage(t, {
    platform: 'win32',
    respond(call) {
      if (!call.args.includes('/Delete')) return gone.respond!(call);
      gone.state.xml = null;
      return DENIED;
    },
  });
  const again = autostartFor(other.cli.system);
  again.install(winSpec(other.home), { start: false });
  assert.match(again.uninstall(winSpec(other.home)).join('\n'), /已删除计划任务/);
});

test('Windows：启动计划任务没成功时不说已启动，并说任务本身在不在', (t) => {
  const tasks = scheduler({ noRun: true });
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const autostart = autostartFor(s.cli.system);
  const spec = winSpec(s.home);
  assert.throws(
    () => autostart.install(spec, { start: true }),
    (err: Error) => {
      assert.match(err.message, /已装好/);
      assert.match(err.message, /启动它没成功/);
      assert.match(err.message, /Access is denied/);
      return true;
    },
  );
  assert.equal(autostart.state(spec).installed, true);
  assert.throws(() => autostart.start(spec), /启动它没成功/);
});

test('Windows：“启动”文件夹方式的启动没成功时报告原因，不当成已启动', (t) => {
  const tasks = scheduler({ refuse: true });
  const s = stage(t, { platform: 'win32', respond: tasks.respond, refuseLaunch: () => 'cmd 的 start 退出码 1' });
  const autostart = autostartFor(s.cli.system);
  const spec = winSpec(s.home);
  assert.throws(
    () => autostart.install(spec, { start: true }),
    (err: Error) => {
      assert.ok(err.message.includes(startupFileOf(s)), '文件已经放好，要说');
      assert.match(err.message, /下次登录/);
      assert.match(err.message, /cmd 的 start 退出码 1/);
      return true;
    },
  );
  assert.ok(existsSync(startupFileOf(s)));
  assert.throws(() => autostart.start(spec), /cmd 的 start 退出码 1/);
  assert.equal(s.launched.length, 2);
  for (const { args } of s.launched) assert.deepEqual(args, launchArgs(spec));
});

test('Windows：没装时 start 指到 install；查不了计划任务时说查不了', (t) => {
  const absent = stage(t, { platform: 'win32', respond: scheduler().respond });
  assert.throws(() => autostartFor(absent.cli.system).start(winSpec(absent.home)), /tycho service install/);
  const deaf = stage(t, { platform: 'win32', respond: scheduler({ deaf: true }).respond });
  assert.throws(() => autostartFor(deaf.cli.system).start(winSpec(deaf.home)), /查不了计划任务/);
});

// systemd's user manager, with lingering on or off.
const systemd = (linger: 'yes' | 'no'): StageOptions['respond'] => (call) =>
  call.file === 'loginctl' ? { stdout: `Linger=${linger}\n` } : undefined;

test('Linux：写 unit、重载、启用并启动；装两次内容不变；没开 linger 只提示不代办', (t) => {
  const s = stage(t, { platform: 'linux', respond: systemd('no') });
  const autostart = autostartFor(s.cli.system);
  const spec: ServiceSpec = { program: ['/opt/tycho/bin/tycho'], dataDir: '/data/host', logFile: '/data/host/service.log' };
  const file = join(s.home, '.config', 'systemd', 'user', `${ownName(spec)}.service`);

  const said = autostart.install(spec, { start: true }).join('\n');
  assert.equal(readFileSync(file, 'utf8'), systemdUnit(spec));
  assert.deepEqual(verbs(s.calls, /^systemctl$/), ['--user daemon-reload', `--user enable --now ${ownName(spec)}.service`]);
  assert.match(said, /loginctl enable-linger/);
  assert.equal(s.calls.some(({ args }) => args.includes('enable-linger')), false, '只提示，不替主人运行');

  autostart.install(spec, { start: false });
  assert.equal(readFileSync(file, 'utf8'), systemdUnit(spec));
  assert.equal(verbs(s.calls, /^systemctl$/).at(-1), `--user enable ${ownName(spec)}.service`);
  assert.equal(autostart.state(spec).current, true);
  assert.equal(autostart.state({ ...spec, program: ['/elsewhere/tycho'] }).installed, false);
  assert.match(autostart.state(spec).notes.join('\n'), /enable-linger/);

  assert.ok(autostart.uninstall(spec).join('\n').includes(file));
  assert.equal(existsSync(file), false);
});

test('Linux：开了 linger 就不提', (t) => {
  const s = stage(t, { platform: 'linux', respond: systemd('yes') });
  const said = autostartFor(s.cli.system).install({ program: ['/t'], dataDir: '/d', logFile: '/d/l' }, { start: false }).join('\n');
  assert.doesNotMatch(said, /linger/);
});

test('Linux：没有 systemd 时说明装不了、给出手工办法，不留下半个定义', (t) => {
  const s = stage(t, {
    platform: 'linux',
    respond: (call) => (call.file === 'systemctl' ? { code: 1, stderr: 'Failed to connect to bus: No medium found' } : undefined),
  });
  const autostart = autostartFor(s.cli.system);
  const spec: ServiceSpec = { program: ["/opt/it's/bin/tycho"], dataDir: '/data/host', logFile: '/data/host/service.log' };
  assert.throws(
    () => autostart.install(spec, { start: true }),
    (err: Error) => {
      assert.match(err.message, /systemd/);
      assert.match(err.message, /Failed to connect to bus/);
      assert.ok(err.message.includes(`TYCHO_AUTOSTART=1 TYCHO_DATA='/data/host' nohup '/opt/it'\\''s/bin/tycho' 'run' '--log' '/data/host/service.log'`), err.message);
      return true;
    },
  );
  assert.equal(existsSync(join(s.home, '.config', 'systemd', 'user', freshUnit(s))), false);
  assert.equal(autostart.state(spec).installed, false);
});

// systemd's user manager, verb by verb; a verb not named succeeds without a word.
const NO_BUS = { code: 1, stderr: 'Failed to connect to bus: No medium found' };
const DISABLED = { code: 1, stdout: 'disabled\n' };
const INACTIVE = { code: 3, stdout: 'inactive\n' };
const systemdWith = (answers: Record<string, Partial<ExecResult>>): StageOptions['respond'] => (call) => {
  if (call.file === 'loginctl') return { stdout: 'Linger=yes\n' };
  return call.file === 'systemctl' ? answers[call.args[1]!] : undefined;
};
const UNIT: ServiceSpec = { program: ['/opt/tycho/bin/tycho'], dataDir: '/data/host', logFile: '/data/host/service.log' };

function unitInstalled(home: string): string {
  const file = join(home, '.config', 'systemd', 'user', 'tycho.service');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, systemdUnit(UNIT));
  return file;
}

test('Linux 卸载：systemd 里本来就没启用不算失败，也不说成出了问题', (t) => {
  const s = stage(t, {
    respond: systemdWith({
      disable: { code: 1, stderr: 'Failed to disable unit: Unit file tycho.service does not exist.' },
      'is-enabled': { code: 1, stdout: 'not-found\n' },
    }),
  });
  const file = unitInstalled(s.home);
  const said = autostartFor(s.cli.system).uninstall(UNIT).join('\n');
  assert.ok(said.includes(`已删除 systemd 用户服务 ${file}`), said);
  assert.match(said, /本来就没有启用/);
  assert.equal(existsSync(file), false);
  // Asked once after the failure, about this unit.
  assert.deepEqual(verbs(s.calls, /^systemctl$/), ['--user is-enabled tycho.service', '--user disable tycho.service', '--user daemon-reload', '--user is-enabled tycho.service']);
});

test('Linux 卸载：disable 没成功、查下来还启用着：如实报告，给出下一步', (t) => {
  const s = stage(t, {
    respond: systemdWith({ disable: { code: 1, stderr: 'Failed to disable unit: Access denied' }, 'is-enabled': { stdout: 'enabled\n' } }),
  });
  const file = unitInstalled(s.home);
  assert.throws(
    () => autostartFor(s.cli.system).uninstall(UNIT),
    (err: Error) => {
      assert.ok(err.message.includes(`已删除 systemd 用户服务 ${file}`), '文件删没删要说');
      assert.match(err.message, /还是启用的/);
      assert.match(err.message, /Access denied/);
      assert.match(err.message, /systemctl --user disable tycho\.service/);
      return true;
    },
  );
  assert.equal(existsSync(file), false);
});

test('Linux 卸载：daemon-reload 没成功要说出来；systemd 完全没应答时说不知道，不说删干净了', (t) => {
  const reload = stage(t, { respond: systemdWith({ 'daemon-reload': { code: 1, stderr: 'Failed to reload daemon: Access denied' }, 'is-enabled': DISABLED }) });
  unitInstalled(reload.home);
  const said = autostartFor(reload.cli.system).uninstall(UNIT).join('\n');
  assert.match(said, /已删除/);
  assert.match(said, /没能重新读取/);
  assert.match(said, /Failed to reload daemon/);
  assert.doesNotMatch(said, /本来就没有启用/, 'disable 是成功的');

  const silent = stage(t, { respond: systemdWith({ disable: NO_BUS, 'daemon-reload': NO_BUS, 'is-enabled': NO_BUS }) });
  const file = unitInstalled(silent.home);
  assert.throws(
    () => autostartFor(silent.cli.system).uninstall(UNIT),
    (err: Error) => {
      assert.match(err.message, /已删除/);
      assert.match(err.message, /不知道/);
      assert.match(err.message, /Failed to connect to bus/);
      assert.match(err.message, /systemctl --user is-enabled tycho\.service/);
      return true;
    },
  );
  assert.equal(existsSync(file), false);
});

test('Linux 安装：启用没成功时说单元文件已写、实际启用和运行的状态，不当成装好了', (t) => {
  const refused = stage(t, {
    respond: systemdWith({ enable: { code: 1, stderr: 'Failed to enable unit: Access denied' }, 'is-enabled': DISABLED, 'is-active': INACTIVE }),
  });
  const file = join(refused.home, '.config', 'systemd', 'user', `${ownName(UNIT)}.service`);
  assert.throws(
    () => autostartFor(refused.cli.system).install(UNIT, { start: false }),
    (err: Error) => {
      assert.ok(err.message.includes(`单元文件已写到 ${file}`), err.message);
      assert.match(err.message, /Failed to enable unit/);
      assert.match(err.message, /没有启用/);
      assert.match(err.message, /没在运行/);
      return true;
    },
  );
  assert.equal(readFileSync(file, 'utf8'), systemdUnit(UNIT));

  // `enable --now` that enabled the unit and then could not start it.
  const half = stage(t, { respond: systemdWith({ enable: { code: 1, stderr: 'Job for tycho.service failed.' }, 'is-active': { code: 3, stdout: 'failed\n' } }) });
  assert.throws(
    () => autostartFor(half.cli.system).install(UNIT, { start: true }),
    (err: Error) => {
      assert.match(err.message, /已启用/);
      assert.match(err.message, /没在运行/);
      assert.match(err.message, /journalctl --user -u tycho/);
      return true;
    },
  );
});

test('Linux 启动：systemctl start 报错时看服务实际在不在运行', (t) => {
  const failed = stage(t, { respond: systemdWith({ start: { code: 1, stderr: 'Job for tycho.service failed.' }, 'is-active': { code: 3, stdout: 'failed\n' } }) });
  unitInstalled(failed.home);
  assert.throws(
    () => autostartFor(failed.cli.system).start(UNIT),
    (err: Error) => {
      assert.match(err.message, /Job for tycho\.service failed/);
      assert.match(err.message, /没在运行/);
      assert.match(err.message, /journalctl --user -u tycho/);
      return true;
    },
  );
  const unknown = stage(t, { respond: systemdWith({ start: NO_BUS, 'is-active': NO_BUS }) });
  unitInstalled(unknown.home);
  assert.throws(() => autostartFor(unknown.cli.system).start(UNIT), /查不出来/);
  // An error from `start` about a unit that is active all the same: it has been started.
  const active = stage(t, { respond: systemdWith({ start: { code: 1, stderr: 'Warning: unit changed on disk' } }) });
  unitInstalled(active.home);
  autostartFor(active.cli.system).start(UNIT);
});

test('Linux 状态：没启用和问不到 systemd 是两回事', (t) => {
  const disabled = stage(t, { respond: systemdWith({ 'is-enabled': DISABLED }) });
  unitInstalled(disabled.home);
  assert.match(autostartFor(disabled.cli.system).state(UNIT).notes.join('\n'), /没有启用/);
  const silent = stage(t, { respond: systemdWith({ 'is-enabled': NO_BUS }) });
  unitInstalled(silent.home);
  const notes = autostartFor(silent.cli.system).state(UNIT).notes.join('\n');
  assert.match(notes, /不知道/);
  assert.doesNotMatch(notes, /但没有启用/);
  const enabled = stage(t, { respond: systemdWith({}) });
  unitInstalled(enabled.home);
  assert.deepEqual(autostartFor(enabled.cli.system).state(UNIT).notes, []);
});

test('macOS：装在当前用户的 LaunchAgents 下，由 launchd 的用户域载入', (t) => {
  const s = stage(t, { platform: 'darwin' });
  const autostart = autostartFor(s.cli.system);
  const spec: ServiceSpec = { program: ['/Users/o/.tycho/app/bin/tycho'], dataDir: '/Users/o/.tycho/host', logFile: '/Users/o/.tycho/host/service.log' };
  const file = join(s.home, 'Library', 'LaunchAgents', `${ownName(spec)}.plist`);

  autostart.install(spec, { start: true });
  assert.equal(readFileSync(file, 'utf8'), launchdPlist(spec, ownName(spec)));
  assert.deepEqual(verbs(s.calls, /^launchctl$/), [`bootout gui/501/${ownName(spec)}`, `bootstrap gui/501 ${file}`]);
  autostart.install(spec, { start: false });
  assert.equal(verbs(s.calls, /^launchctl$/).length, 2, '不启动时只改文件');
  assert.equal(autostart.state(spec).current, true);
  assert.equal(autostart.state({ ...spec, dataDir: '/elsewhere' }).current, false);
  assert.match(autostart.uninstall(spec).join('\n'), /随之停止/);
  assert.equal(existsSync(file), false);
});

// launchd, verb by verb; a verb not named succeeds without a word.
const NOT_LOADED = { code: 3, stderr: 'Boot-out failed: 3: No such process' };
const NO_SUCH_SERVICE = { code: 113, stderr: 'Could not find service "tycho" in domain for user gui: 501' };
const IO_ERROR = { code: 5, stderr: 'Boot-out failed: 5: Input/output error' };
const launchdWith = (answers: Record<string, Partial<ExecResult>>): StageOptions['respond'] => (call) =>
  call.file === 'launchctl' ? answers[call.args[0]!] : undefined;
const AGENT: ServiceSpec = { program: ['/Users/o/.tycho/app/bin/tycho'], dataDir: '/Users/o/.tycho/host', logFile: '/Users/o/.tycho/host/service.log' };

function agentInstalled(home: string): string {
  const file = join(home, 'Library', 'LaunchAgents', 'tycho.plist');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, launchdPlist(AGENT));
  return file;
}

test('macOS 卸载：launchd 里本来就没载入不算失败，也不说服务随之停止', (t) => {
  const s = stage(t, { platform: 'darwin', respond: launchdWith({ bootout: NOT_LOADED, print: NO_SUCH_SERVICE }) });
  const file = agentInstalled(s.home);
  const said = autostartFor(s.cli.system).uninstall(AGENT).join('\n');
  assert.ok(said.includes(`已删除 LaunchAgent ${file}`), said);
  assert.match(said, /本来就没有载入/);
  assert.doesNotMatch(said, /随之停止/);
  assert.equal(existsSync(file), false);
  assert.deepEqual(verbs(s.calls, /^launchctl$/), ['bootout gui/501/tycho', 'print gui/501/tycho']);
});

test('macOS 卸载：bootout 没成功、查下来还载入着：不说服务停了，给出下一步', (t) => {
  const s = stage(t, { platform: 'darwin', respond: launchdWith({ bootout: IO_ERROR }) });
  const file = agentInstalled(s.home);
  assert.throws(
    () => autostartFor(s.cli.system).uninstall(AGENT),
    (err: Error) => {
      assert.ok(err.message.includes(`已删除 LaunchAgent ${file}`), '文件删没删要说');
      assert.match(err.message, /还载入着/);
      assert.match(err.message, /Input\/output error/);
      assert.match(err.message, /launchctl bootout gui\/501\/tycho/);
      assert.doesNotMatch(err.message, /随之停止/);
      return true;
    },
  );
  assert.equal(existsSync(file), false);

  // launchctl that answers neither way: unknown is said, not guessed.
  const silent = stage(t, { platform: 'darwin', respond: launchdWith({ bootout: IO_ERROR, print: { code: 1, stderr: 'launchctl: operation not permitted' } }) });
  agentInstalled(silent.home);
  assert.throws(() => autostartFor(silent.cli.system).uninstall(AGENT), /不知道/);
});

test('macOS 启动：原来载入的卸不下来就不再载入；本来没载入照常载入', (t) => {
  const stuck = stage(t, { platform: 'darwin', respond: launchdWith({ bootout: IO_ERROR }) });
  agentInstalled(stuck.home);
  assert.throws(() => autostartFor(stuck.cli.system).start(AGENT), /还载入着/);
  assert.equal(verbs(stuck.calls, /^launchctl$/).some((line) => line.startsWith('bootstrap')), false);

  const fresh = stage(t, { platform: 'darwin', respond: launchdWith({ bootout: NOT_LOADED, print: NO_SUCH_SERVICE }) });
  const file = agentInstalled(fresh.home);
  autostartFor(fresh.cli.system).start(AGENT);
  assert.deepEqual(verbs(fresh.calls, /^launchctl$/), ['bootout gui/501/tycho', 'print gui/501/tycho', `bootstrap gui/501 ${file}`]);
});

test('macOS 启动：launchd 不肯载入时说它现在载没载入，不当成已启动', (t) => {
  const refused = { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
  const out = stage(t, { platform: 'darwin', respond: launchdWith({ bootstrap: refused, print: NO_SUCH_SERVICE }) });
  const file = agentInstalled(out.home);
  assert.throws(
    () => autostartFor(out.cli.system).start(AGENT),
    (err: Error) => {
      assert.match(err.message, /Bootstrap failed/);
      assert.match(err.message, /没有载入/);
      assert.ok(err.message.includes(file));
      return true;
    },
  );
  // The one before had not finished leaving: it is the old one that is still loaded.
  const busy = stage(t, { platform: 'darwin', respond: launchdWith({ bootstrap: refused }) });
  agentInstalled(busy.home);
  assert.throws(() => autostartFor(busy.cli.system).install(AGENT, { start: true }), /载入着/);
});

test('别的系统：说明不支持并给出手工办法', (t) => {
  const s = stage(t, { platform: 'freebsd' });
  const autostart = autostartFor(s.cli.system);
  assert.throws(() => autostart.install({ program: ['/t'], dataDir: '/d', logFile: '/l' }, { start: true }), /nohup/);
  assert.equal(autostart.state({ program: ['/t'], dataDir: '/d', logFile: '/l' }).installed, false);
});

// ---- The commands ----

test('tycho service install：服务没跑就装好并启动，等到它真的起来才说已启动', async (t) => {
  const s = stage(t, { platform: 'linux' });
  s.cli.timing.startWaitMs = 30_000;
  const installing = runCli(['service', 'install'], s.cli);
  // systemd accepting `enable --now` is all its answer says. Nothing here starts the
  // service on the command's behalf: the test does, after seeing the command still wait.
  await until('systemd 收到启用并启动的请求', () => verbs(s.calls, /^systemctl$/).includes(`--user enable --now ${freshUnit(s)}`));
  await sleep(200);
  assert.doesNotMatch(s.text(), /服务已启动/, '服务管理器答应了不等于服务起来了');
  await startStub(t, s.dataDir);
  assert.equal(await installing, 0, s.text());
  assert.match(s.text(), /systemd 用户服务/);
  assert.match(s.text(), /服务已启动/);
  const unit = readFileSync(join(s.home, '.config', 'systemd', 'user', freshUnit(s)), 'utf8');
  // From a source checkout there is no launcher: node and the entry, both absolute.
  assert.ok(unit.includes(`ExecStart="${process.execPath.replaceAll('\\', '\\\\')}"`), unit);
  assert.ok(unit.includes(`TYCHO_DATA=${s.dataDir.replaceAll('\\', '\\\\')}`), unit);

  s.out.length = 0;
  assert.equal(await runCli(['service', 'status'], s.cli), 0);
  assert.match(s.text(), /正在运行/);
  assert.match(s.out.join('\n'), /已安装（systemd 用户服务）$/m);
});

test('tycho service install：服务管理器说成功、服务却没起来时，不说已启动', async (t) => {
  const s = stage(t, { platform: 'linux' });
  s.cli.timing.startWaitMs = 100;
  assert.equal(await runCli(['service', 'install'], s.cli), 1);
  assert.ok(verbs(s.calls, /^systemctl$/).includes(`--user enable --now ${freshUnit(s)}`));
  assert.doesNotMatch(s.text(), /服务已启动/);
  assert.match(s.text(), /还没起来/);
});

// A program that dies on its way up is known by the lock it leaves behind with a pid that is
// gone: the command says so at once instead of waiting out the start limit, which the
// owner would read as "still starting".
test('tycho service install：服务起来过又退出了，马上说出来，不等到时限', async (t) => {
  const s = stage(t, { platform: 'linux' });
  s.cli.timing.startWaitMs = 60_000;
  const installing = runCli(['service', 'install'], s.cli);
  await until('systemd 收到启用并启动的请求', () => verbs(s.calls, /^systemctl$/).includes(`--user enable --now ${freshUnit(s)}`));
  const dying = spawn(process.execPath, [STUB_SERVICE], { env: { ...process.env, TYCHO_DATA: s.dataDir, STUB_DIE_AFTER_LOCK: '1' }, stdio: 'ignore' });
  t.after(() => void dying.kill());
  assert.equal(await installing, 1, s.text());
  assert.match(s.text(), new RegExp(`服务起来过又退出了（进程 ${dying.pid}）`));
  assert.doesNotMatch(s.text(), /还没起来/);
  assert.doesNotMatch(s.text(), /服务已启动/);
});

test('tycho service install：服务已经在跑时只装定义，不起第二个', async (t) => {
  const s = stage(t, { platform: 'linux' });
  const child = await startStub(t, s.dataDir);
  assert.equal(await runCli(['service', 'install'], s.cli), 0);
  assert.deepEqual(verbs(s.calls, /^systemctl$/), ['--user daemon-reload', `--user enable ${freshUnit(s)}`]);
  assert.match(s.text(), /没有动它/);
  assert.equal(alive(child), true);
});

test('tycho service stop：请服务自己停，不去结束服务管理器里的任务', async (t) => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    const s = stage(t, { platform, respond: scheduler().respond });
    const trace = join(s.dir, 'trace');
    const child = await startStub(t, s.dataDir, { STUB_TRACE: trace });
    assert.equal(await runCli(['service', 'stop'], s.cli), 0, platform);
    assert.equal(alive(child), false);
    assert.equal(readFileSync(trace, 'utf8'), 'shutdown\n');
    assert.deepEqual(s.calls.filter(({ args }) => args.some((arg) => /^(\/End|stop|kill|bootout)$/i.test(arg))), [], platform);
  }
});

test('tycho service start：没装时失败并指到 install；已在跑时不重复启动', async (t) => {
  const s = stage(t, { platform: 'linux' });
  assert.equal(await runCli(['service', 'start'], s.cli), 1);
  assert.match(s.text(), /tycho service install/);

  const running = stage(t, { platform: 'linux' });
  await startStub(t, running.dataDir);
  assert.equal(await runCli(['service', 'start'], running.cli), 0);
  assert.deepEqual(running.calls, []);
});

test('tycho service uninstall：卸掉定义，服务照常', async (t) => {
  const s = stage(t, { platform: 'linux' });
  const child = await startStub(t, s.dataDir);
  assert.equal(await runCli(['service', 'install'], s.cli), 0);
  assert.equal(await runCli(['service', 'uninstall'], s.cli), 0);
  assert.equal(existsSync(join(s.home, '.config', 'systemd', 'user', freshUnit(s))), false);
  assert.equal(alive(child), true);
});

// ---- The PATH of the terminal that installed it ----

const AWKWARD_PATH = '/home/张 三/.local/bin:/opt/50%/"new"/a\\b:/opt/$HOME/it\'s:/opt/a&b<c>:/usr/bin';

test('Linux：PATH 写进单元，转义规则和数据目录一样；$ 在 Environment 里不是变量', () => {
  const line = systemdUnit({ ...UNIT, path: AWKWARD_PATH }).split('\n').find((text) => text.includes('PATH='));
  assert.equal(line, 'Environment="PATH=/home/张 三/.local/bin:/opt/50%%/\\"new\\"/a\\\\b:/opt/$HOME/it\'s:/opt/a&b<c>:/usr/bin"');
  assert.doesNotMatch(systemdUnit(UNIT), /PATH=/, '没有记下的 PATH 就不写这一行');
});

test('macOS：PATH 写进 EnvironmentVariables，XML 转义', () => {
  const plist = launchdPlist({ ...AGENT, path: AWKWARD_PATH });
  assert.ok(plist.includes('    <key>PATH</key>\n    <string>/home/张 三/.local/bin:/opt/50%/&quot;new&quot;/a\\b:/opt/$HOME/it\'s:/opt/a&amp;b&lt;c&gt;:/usr/bin</string>\n'), plist);
  assert.doesNotMatch(launchdPlist(AGENT), /<key>PATH<\/key>/);
});

test('Windows：计划任务继承用户环境，定义里没有 PATH', () => {
  const spec = { ...WIN, path: 'C:\\only\\this\\terminal' };
  assert.equal(windowsScript(spec), windowsScript(WIN));
  assert.equal(windowsTaskXml({ user: 'PC\\owner', powershell: 'powershell.exe', spec, conhost: CONHOST }), windowsTaskXml({ user: 'PC\\owner', powershell: 'powershell.exe', spec: WIN, conhost: CONHOST }));
});

for (const [platform, spec, name] of [['linux', UNIT, 'Linux'], ['darwin', AGENT, 'macOS']] as const) {
  test(`${name}：PATH 不同不算过期；别的地方不同仍然算`, (t) => {
    const s = stage(t, { platform });
    const autostart = autostartFor(s.cli.system);
    autostart.install({ ...spec, path: AWKWARD_PATH }, { start: false });
    assert.equal(autostart.state({ ...spec, path: AWKWARD_PATH }).current, true);
    assert.equal(autostart.state({ ...spec, path: '/another/terminal' }).current, true);
    assert.equal(autostart.state(spec).current, true, '源码目录和旧记录手里没有 PATH，也不算过期');
    assert.equal(autostart.state({ ...spec, path: '/another/terminal', dataDir: '/elsewhere' }).current, false);
  });
}

test('tycho service install：POSIX只有Codex也能安装，不替负责人判账号就绪', async (t) => {
  const s = stage(t, { platform: 'linux' });
  const bin = join(s.dir, 'only-codex');
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), '');
  s.cli.system.env.PATH = bin;
  await startStub(t, s.dataDir);
  assert.equal(await runCli(['service', 'install'], s.cli), 0, s.text());
  assert.ok(existsSync(join(s.home, '.config', 'systemd', 'user', freshUnit(s))), '服务定义已安装');
  assert.doesNotMatch(s.text(), /负责人会起不来|填上 Claude Code 的路径/);
});

test('源码目录没有安装记录：换个终端看，定义不算过期', async (t) => {
  const s = stage(t, { platform: 'linux', env: { PATH: '/from/the/first/terminal' } });
  await startStub(t, s.dataDir);
  assert.equal(await runCli(['service', 'install'], s.cli), 0, s.text());
  const unit = join(s.home, '.config', 'systemd', 'user', freshUnit(s));
  assert.ok(readFileSync(unit, 'utf8').includes('PATH=/from/the/first/terminal'));
  s.cli.system.env.PATH = '/another/terminal';
  s.out.length = 0;
  await runCli(['service', 'status'], s.cli);
  assert.doesNotMatch(s.out.join('\n'), /过期/);
});

// ---- One program, two roles: the host service and the machine's client ----
//
// Guards docs/design/nodes.md §1.4 and §7: a computer that is both the host and a machine
// has two definitions, each started with its own subcommand, each with its own name, file
// and mark. What this catches: the client's install overwriting the host's definition (a
// login that starts the wrong program), an upgrade rewriting or stopping the other role's,
// and a definition judged to be this installation's when it belongs to the other role.

const NODE_SPEC: ServiceSpec = { ...POSIX, role: 'node' };
const NODE_WIN: ServiceSpec = { ...WIN, role: 'node', logFile: 'D:\\数据 目录\\host\\node.log' };
const NODE_AGENT: ServiceSpec = {
  ...NODE_SPEC,
  program: ['/Users/张 三/a&b <c>/bin/tycho'],
  dataDir: '/Users/张 三/.tycho/host',
  logFile: '/Users/张 三/.tycho/host/node.log',
};

test('两个角色各有各的名字和标记：同一份 tycho 装两次不会互相顶掉', () => {
  assert.equal(nameOf('host'), 'tycho');
  assert.equal(nameOf('node'), 'tycho-node');
  assert.notEqual(ownerId(POSIX), ownerId(NODE_SPEC), '两个角色的定义各自属于一个角色');
  assert.equal(ownerId(POSIX), ownerId({ ...POSIX, role: 'host' }), '没写角色的规格就是主机');
  // The id a version before roles existed wrote is still the host's.
  assert.equal(ownerId({ ...POSIX, role: undefined }), createHash('sha256').update(POSIX.program.join('\0')).digest('hex').slice(0, 16));
});

test('Linux：旧固定客户端单元模板跑 node run，输出进 journald', () => {
  const unit = systemdUnit(NODE_SPEC);
  assert.match(unit, /^# tycho-autostart owner:[0-9a-f]{16}$/m);
  assert.match(unit, /Description=tycho node/);
  assert.match(unit, /ExecStart=.* "node" "run"$/m);
  assert.doesNotMatch(unit, /--log/, 'systemd 自己收着输出，不该再写一份日志文件');
  // Stopping or restarting the client must leave the watch processes in its cgroup alone:
  // the rounds they own are not the client's (nodes.md §4.2). The host keeps `mixed`.
  assert.match(unit, /^KillMode=process$/m, '客户端的单元只对客户端本身发信号');
  assert.match(systemdUnit(POSIX), /^KillMode=mixed$/m, '主机的单元不受影响');
  assert.match(unit, /Environment="TYCHO_DATA=\/data\/数据 目录\/a\\\\b"/);
});

test('macOS：旧固定客户端 LaunchAgent 模板使用 node run 和自己的日志', () => {
  const plist = launchdPlist(NODE_AGENT);
  assert.match(plist, /<key>Label<\/key>\s*<string>tycho-node<\/string>/);
  assert.match(plist, /<string>node<\/string>\s*<string>run<\/string>\s*<string>--log<\/string>\s*<string>\/Users\/张 三\/\.tycho\/host\/node\.log<\/string>/);
});

test('Windows：客户端计划任务模板使用 node run --log', () => {
  const xml = windowsTaskXml({ user: 'PC\\owner', powershell: POWERSHELL, spec: NODE_WIN, conhost: CONHOST });
  assert.match(xml, /starts the machine client when PC\\owner logs on/);
  assert.equal(element(xml, 'Command'), CONHOST, '一样走无窗口的 console host');
  assert.match(element(xml, 'Arguments'), /'node' 'run' '--log' 'D:\\数据 目录\\host\\node\.log'/);
});

// Task Scheduler with one definition per task name: what a computer running both roles has,
// where the failure to catch is one role's install reaching the other's task.
function schedulerByName() {
  const tasks = new Map<string, string>();
  const started: string[] = [];
  const respond: StageOptions['respond'] = (call) => {
    const asked = call.env.TYCHO_TASK;
    if (asked !== undefined) {
      const xml = tasks.get(asked);
      return { stdout: xml === undefined ? 'absent\r\n' : `present ${Buffer.from(xml).toString('base64')}\r\n` };
    }
    if (!/schtasks/i.test(call.file)) return undefined;
    const value = (flag: string): string => call.args[call.args.indexOf(flag) + 1]!;
    const [verb] = call.args;
    const name = value('/TN');
    if (verb === '/Create') {
      tasks.set(name, readFileSync(value('/XML'), 'utf16le').replace(/^\ufeff/, ''));
      return undefined;
    }
    if (verb === '/Delete') {
      tasks.delete(name);
      return undefined;
    }
    if (verb === '/Run') {
      started.push(name);
      return undefined;
    }
    return undefined;
  };
  return { tasks, started, respond };
}

test('Windows：两个角色的计划任务各建各的，装一个不动另一个', (t) => {
  const tasks = schedulerByName();
  const s = stage(t, { platform: 'win32', respond: tasks.respond });
  const specs = { host: winSpec(s.home), node: { ...winSpec(s.home), role: 'node' as const, logFile: `${s.home}\\host\\node.log` } };
  autostartFor(s.cli.system, 'host').install(specs.host, { start: false });
  const hostXml = tasks.tasks.get(ownName(specs.host))!;
  autostartFor(s.cli.system, 'node').install(specs.node, { start: false });

  assert.match(hostXml, /'run' '--log'/, '主机那份跑的是 run');
  assert.match(tasks.tasks.get(ownName(specs.node))!, /'node' 'run' '--log'/, '客户端那份跑的是 node run');
  assert.equal(tasks.tasks.get(ownName(specs.host)), hostXml, '装客户端没有动主机那份');

  // Each role's state answers about its own definition, and never about the other's.
  assert.equal(autostartFor(s.cli.system, 'host').state(specs.host).mine, true);
  assert.equal(autostartFor(s.cli.system, 'node').state(specs.node).mine, true);
  assert.equal(autostartFor(s.cli.system, 'node').state(specs.host).installed, false, '主机那份不是客户端角色的');
  assert.equal(autostartFor(s.cli.system, 'host').state(specs.node).installed, false);

  autostartFor(s.cli.system, 'node').uninstall(specs.node);
  assert.equal(tasks.tasks.has(ownName(specs.node)), false);
  assert.equal(tasks.tasks.get(ownName(specs.host)), hostXml, '卸客户端不碰主机那份');
  assert.equal(autostartFor(s.cli.system, 'host').state(specs.host).current, true);
});

for (const { platform, spec, name } of [{ platform: 'linux' as const, spec: NODE_SPEC, name: 'Linux' }, { platform: 'darwin' as const, spec: NODE_AGENT, name: 'macOS' }]) {
  test(`${name}：两个角色的定义各有各的文件，互不覆盖`, (t) => {
    const s = stage(t, { platform });
    const host = { ...spec, role: 'host' as const, logFile: spec.logFile.replace('node.log', 'service.log') };
    autostartFor(s.cli.system, 'host').install(host, { start: false });
    autostartFor(s.cli.system, 'node').install(spec, { start: false });
    const hostFile = platform === 'linux'
      ? join(s.home, '.config', 'systemd', 'user', `${ownName(host)}.service`)
      : join(s.home, 'Library', 'LaunchAgents', `${ownName(host)}.plist`);
    const nodeFile = platform === 'linux'
      ? join(s.home, '.config', 'systemd', 'user', `${ownName(spec)}.service`)
      : join(s.home, 'Library', 'LaunchAgents', `${ownName(spec)}.plist`);
    assert.ok(readFileSync(hostFile, 'utf8').includes(platform === 'linux' ? '"run"' : '<string>run</string>'));
    assert.ok(readFileSync(nodeFile, 'utf8').includes(platform === 'linux' ? '"node" "run"' : '<string>node</string>'));

    for (const line of autostartFor(s.cli.system, 'node').uninstall(spec)) assert.match(line, /已删除/);
    assert.equal(existsSync(nodeFile), false);
    assert.equal(existsSync(hostFile), true, '卸客户端不碰主机那份');
    assert.equal(autostartFor(s.cli.system, 'host').state(host).current, true);
  });
}

