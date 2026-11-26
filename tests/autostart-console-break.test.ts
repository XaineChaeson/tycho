// Guards against a Ctrl+C or Ctrl+Break on the console of the Windows autostart taking the
// service down for good (2026-11-08: the loop died with 0xC000013A, `tycho run` asked the
// service to stop, and nothing started it again). Started the way the task starts it —
// conhost --headless, the loop this version writes, `tycho run --log`, the service — the
// loop and `tycho run` live through both events and the service is not asked to stop. And
// the opposite failure: `tycho run` in a terminal no longer stopping the service on Ctrl+C.
//
// The service is the stand-in the CLI tests use; the loop and the CLI are this repository's
// own. Whatever runs this test may have started it with Ctrl+C ignored, which children
// inherit: the launch turns it back on, as a task started by Task Scheduler has it, or the
// loop would pass for one that was shielded.
import './guard.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { handleFreeLaunch, HOLD_CONSOLE_BREAKS, windowsTaskXml, type ServiceSpec } from '../cli/autostart.ts';
import { STUB_SERVICE } from './cli-helpers.ts';

const REPO = join(import.meta.dirname, '..');
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const POWERSHELL = join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CONHOST = join(SYSTEM32, 'conhost.exe');
const STUB_TOKEN = 'stub-shutdown-token';

const KERNEL32 = `Add-Type -Namespace TychoTest -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add); [DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid); [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'`;
const ENABLE_CTRL_C = `${KERNEL32}; [void][TychoTest.K]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $false)`;

const windowsOnly = { skip: process.platform !== 'win32' && 'Windows consoles only', timeout: 180_000 };

// A release directory of this repository's sources, with the stand-in as its service.
function stage(dir: string): string {
  const app = join(dir, 'app');
  for (const part of ['cli', 'service', 'shared', 'adapters', 'runner', 'channels', 'node']) cpSync(join(REPO, part), join(app, part), { recursive: true });
  copyFileSync(join(REPO, 'package.json'), join(app, 'package.json'));
  copyFileSync(STUB_SERVICE, join(app, 'service', 'main.ts'));
  return app;
}

function parentOf(pid: number): number {
  const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`], { windowsHide: true, encoding: 'utf8' });
  return Number(out.trim());
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Ctrl+C and then Ctrl+Break on the console `pid` is attached to, from a process that
// attaches to it for the purpose and holds both events itself, so that it lives to say
// whether each call worked. The handler goes in after the attach: one installed before
// FreeConsole was not called (measured: the sender died of its own Ctrl+Break).
function sendBreaks(pid: number): string {
  const script = `${KERNEL32}; [void][TychoTest.K]::FreeConsole(); 'attached=' + [TychoTest.K]::AttachConsole(${pid}); ${HOLD_CONSOLE_BREAKS}; 'c=' + [TychoTest.K]::GenerateConsoleCtrlEvent(0, 0); Start-Sleep -Milliseconds 500; 'break=' + [TychoTest.K]::GenerateConsoleCtrlEvent(1, 0)`;
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
}

async function until(what: string, ms: number, done: () => boolean): Promise<void> {
  for (const deadline = Date.now() + ms; !done(); await sleep(200)) {
    if (Date.now() > deadline) throw new Error(`没有等到：${what}`);
  }
}

const readOr = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

interface Started {
  launcher: ChildProcess;
  closed: Promise<void>;
  service: { pid: number; port: number };
}

// The launcher and everything below it are this test's: ended whole if a test leaves them.
function launch(t: TestContext, command: string, env: Record<string, string>): Started['launcher'] & { closed: Promise<void> } {
  const launcher = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, env: { ...process.env, ...env } });
  launcher.stdout!.resume();
  launcher.stderr!.resume();
  const closed = new Promise<void>((resolve) => launcher.once('close', () => resolve()));
  t.after(async () => {
    if (launcher.exitCode === null && launcher.pid !== undefined) {
      try {
        execFileSync(join(SYSTEM32, 'taskkill.exe'), ['/T', '/F', '/PID', String(launcher.pid)], { windowsHide: true, stdio: 'ignore' });
      } catch {
        // Gone in the meantime.
      }
      await closed;
    }
  });
  return Object.assign(launcher, { closed });
}

async function serviceUp(dataDir: string, log: string): Promise<{ pid: number; port: number }> {
  const file = join(dataDir, 'service.json');
  await until(`服务起来（日志：${readOr(log)}）`, 90_000, () => existsSync(file) && readOr(file) !== '');
  return JSON.parse(readFileSync(file, 'utf8')) as { pid: number; port: number };
}

async function shutdown(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${STUB_TOKEN}` } }).catch(() => {});
}

test('the autostart loop, tycho run and the service live through a Ctrl+C and a Ctrl+Break on its console', windowsOnly, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-autostart-break-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = stage(dir);
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  const log = join(dataDir, 'service.log');
  const trace = join(dir, 'trace');
  const spec: ServiceSpec = { program: [process.execPath, join(app, 'cli', 'main.ts')], dataDir, logFile: log };
  // The action as the task this version registers says it.
  const xml = windowsTaskXml({ user: 'test', powershell: POWERSHELL, conhost: CONHOST, spec });
  const action = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)![1]!
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
  const how = handleFreeLaunch(POWERSHELL, CONHOST, action);
  const launcher = launch(t, `${ENABLE_CTRL_C}; ${how.args.at(-1)!}`, { ...how.env, TYCHO_PREFIX: join(dir, 'prefix'), STUB_TRACE: trace, STUB_TAKE_OVER: '1' });

  const service = await serviceUp(dataDir, log);
  const cli = parentOf(service.pid);
  const loop = parentOf(cli);
  t.after(() => shutdown(service.port));
  // The CLI has said its piece and is waiting on the service: what it does with a signal now
  // is what the owner's was doing at 07:21.
  await until('tycho run 报告服务已启动', 30_000, () => readOr(log).includes('stub service starting'));

  const said = sendBreaks(cli);
  assert.match(said, /attached=True[\s\S]*c=True[\s\S]*break=True/, said);
  await sleep(3000);

  const seen = `日志：${readOr(log)}\n记录：${readOr(trace)}`;
  assert.ok(alive(loop), `守护循环没了：${seen}`);
  assert.ok(alive(cli), `tycho run 没了：${seen}`);
  assert.ok(alive(service.pid), `服务没了：${seen}`);
  assert.equal(readOr(trace), '', `服务被请求停止了：${seen}`);
  assert.match(readOr(log), /tycho run 收到 SIGINT：开机自启下/, seen);
  assert.match(readOr(log), /tycho run 收到 SIGBREAK：开机自启下/, seen);

  // A loop PowerShell gave a Ctrl+C to is still there while the program it waits on runs:
  // it gives up the script once that program ends. So the loop is asked to do its job — a
  // service that fails is started again.
  process.kill(service.pid);
  await until(`守护循环重启服务（日志：${readOr(log)}）`, 90_000, () => {
    try {
      return (JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { pid: number }).pid !== service.pid;
    } catch {
      return false;
    }
  });
  const again = await serviceUp(dataDir, log);
  t.after(() => shutdown(again.port));
  assert.equal(parentOf(parentOf(again.pid)), loop);

  // tycho stop still stops it, and the loop takes the clean stop as the end.
  await shutdown(again.port);
  await launcher.closed;
  assert.equal(readOr(trace), 'shutdown\n');
  assert.ok(!alive(loop));
});

test('tycho run in a terminal still stops the service on Ctrl+C', windowsOnly, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-foreground-break-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = stage(dir);
  const dataDir = join(dir, 'data');
  const trace = join(dir, 'trace');
  // A console of its own, the terminal: PowerShell with pipes and no window.
  const launcher = launch(t, `${ENABLE_CTRL_C}; & $env:TEST_NODE $env:TEST_CLI run`, {
    TEST_NODE: process.execPath,
    TEST_CLI: join(app, 'cli', 'main.ts'),
    TYCHO_DATA: dataDir,
    TYCHO_PREFIX: join(dir, 'prefix'),
    STUB_TRACE: trace,
  });
  const service = await serviceUp(dataDir, trace);
  const cli = parentOf(service.pid);
  t.after(() => shutdown(service.port));

  const said = sendBreaks(cli);
  assert.match(said, /attached=True[\s\S]*c=True/, said);
  await until('服务停下', 30_000, () => !alive(service.pid));
  await until('tycho run 退出', 30_000, () => !alive(cli));
  assert.match(readOr(trace), /SIGINT|shutdown/);
  await launcher.closed;
});
