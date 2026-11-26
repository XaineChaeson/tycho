// Guards the login helper (service/ptybridge.ts, service/ptybridge.cs) against: a compiled helper
// made again on every login instead of kept by its source's hash; a host without the compiler
// left with no helper when PowerShell could run the same source; a host where both are refused
// reported as anything but that; a helper whose self-check fails used anyway; a helper that
// outlives the process holding it, or its deadline, and keeps the CLI's tree alive; and a
// command line the helper hands on split differently from how it was meant.
//
// ConPTY is Windows-only, and so is the helper: elsewhere these are skipped.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { isAlive, processStartLater } from '../service/lock.ts';
import { BRIDGE_SOURCE, childPidOf, prepareBridge, startBridge, windowsArg, windowsCommandLine } from '../service/ptybridge.ts';
import { gone as isGone, settle } from './process-standing.ts';

const windowsOnly = { skip: process.platform !== 'win32' && '登录助手用的是 Windows 的伪终端（ConPTY），只在 Windows 上有', timeout: 120_000 };
const FAKE = join(import.meta.dirname, 'fake-claude-login.mjs');
const HOLDER = join(import.meta.dirname, 'login-bridge-holder.ts');

function dataDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

// Gone, by pid and the moment it began: exited, or the pid now names another process. A start
// that was never read is "cannot tell", which is not gone.
async function gone(pid: number, start: string | undefined): Promise<boolean> {
  assert.ok(start !== undefined, `pid ${pid} 的启动时刻没读到，核实不了`);
  return isGone(await settle(pid, start));
}

test('命令行按 C 运行库的规则引起来，拆回去和原来一样', () => {
  assert.equal(windowsArg('plain'), 'plain');
  assert.equal(windowsArg('with space'), '"with space"');
  assert.equal(windowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(windowsArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(windowsArg(''), '""');
});

test('编译一次按源码哈希缓存；自检通过才用', windowsOnly, async (t) => {
  const dir = dataDir(t);
  const first = await prepareBridge({ dataDir: dir });
  assert.equal(first.bridge?.kind, 'exe', first.problems.join('\n'));
  const [hash] = readdirSync(join(dir, 'login-helper'));
  const exe = join(dir, 'login-helper', hash!, 'ptybridge.exe');
  const made = statSync(exe).mtimeMs;
  const again = await prepareBridge({ dataDir: dir });
  assert.equal(again.bridge?.kind, 'exe');
  assert.equal(statSync(exe).mtimeMs, made, '第二次没有重新编译');
  assert.deepEqual(readdirSync(join(dir, 'login-helper', hash!)), ['ptybridge.exe'], '编译的草稿没有留下');
});

test('没有编译器时退到 PowerShell；两条路都没有时如实说', windowsOnly, async (t) => {
  const fallback = await prepareBridge({ dataDir: dataDir(t), csc: null });
  assert.equal(fallback.bridge?.kind, 'powershell', fallback.problems.join('\n'));
  assert.match(fallback.problems.join('\n'), /没有 C# 编译器/);

  const neither = await prepareBridge({ dataDir: dataDir(t), csc: null, powershell: null });
  assert.equal(neither.bridge, undefined);
  assert.match(neither.problems.join('\n'), /没有 C# 编译器[\s\S]*没有 PowerShell/);
});

test('自检没通过的那条路不用；两条都没通过时没有登录助手', windowsOnly, async (t) => {
  const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const selfCheck = { commandLine: `${windowsArg(cmd)} /d /c echo something-else& exit /b 0`, mark: 'tycho-pty-selftest', code: 7 };
  const prepared = await prepareBridge({ dataDir: dataDir(t), selfCheck });
  assert.equal(prepared.bridge, undefined);
  assert.doesNotMatch(prepared.problems.join('\n'), /ptybridge: started \d+/);
  assert.match(prepared.problems.join('\n'), /登录助手（exe）自检没通过[\s\S]*登录助手（powershell）自检没通过/);
});

test('持有登录助手的进程被杀掉后，助手和它起的命令自己消失', windowsOnly, async (t) => {
  const holder = spawn(process.execPath, [HOLDER, dataDir(t), FAKE], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  let pids: { holder: number; helper: number; cli: number; helperStart: string; cliStart: string } | undefined;
  for await (const line of createInterface({ input: holder.stdout! })) {
    pids = JSON.parse(line) as typeof pids;
    break;
  }
  assert.ok(pids && 'helper' in pids, JSON.stringify(pids));
  assert.ok(isAlive(pids.helper) && isAlive(pids.cli));
  assert.equal(await processStartLater(pids.helper), pids.helperStart);
  assert.equal(await processStartLater(pids.cli), pids.cliStart);
  holder.kill();
  assert.ok(await gone(pids.helper, pids.helperStart), '登录助手还在');
  assert.ok(await gone(pids.cli, pids.cliStart), '助手起的命令还在');
});

test('到了截止时刻，助手自己退出，带走它起的命令', windowsOnly, async (t) => {
  const dir = dataDir(t);
  // Compile the real helper with a controlled clock and timer. Its normal entry point is
  // retained for preparation's self-check; only this run gets the named timer pipe.
  const source = join(dir, 'clock-bridge.cs');
  const code = readFileSync(BRIDGE_SOURCE, 'utf8').replace('public static int Main(string[] args)', 'public static int OriginalMain(string[] args)');
  writeFileSync(source, code + `
public static class TestClockEntry {
    public static int Main(string[] args) {
        string pipe = Environment.GetEnvironmentVariable("TYCHO_TEST_CLOCK_PIPE");
        if (pipe == null) return PtyBridge.OriginalMain(args);
        return PtyBridge.Run(args, delegate { return long.Parse(args[0]) - 1; }, delegate(int ms) {
            using (var timer = new System.IO.Pipes.NamedPipeClientStream(".", pipe, System.IO.Pipes.PipeDirection.In)) {
                timer.Connect(); timer.ReadByte();
            }
        });
    }
}
`);
  const { bridge } = await prepareBridge({ dataDir: dir, source });
  assert.ok(bridge);
  const pipe = `tycho-test-clock-${randomUUID()}`;
  let accept!: (socket: Socket) => void;
  const connected = new Promise<Socket>((resolve) => { accept = resolve; });
  const server = createServer(accept);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${pipe}`, resolve); });
  t.after(() => server.close());
  const child = startBridge(bridge, {
    deadline: Date.now() + 2_000,
    commandLine: windowsCommandLine([process.execPath, FAKE]),
    env: { ...process.env, FAKE_LOGIN_SILENT: '1', TYCHO_TEST_CLOCK_PIPE: pipe },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let errors = '';
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    errors += chunk;
    if (/ptybridge: child pid \d+ started \d+\r?\n/.test(errors)) ready();
  });
  child.stdout!.resume();
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  const socket = await Promise.race([Promise.all([connected, started]).then(([connection]) => connection), closed.then(() => { throw new Error(`助手在报告身份前退出：${errors}`); })]);
  const cli = childPidOf(errors);
  const cliStart = /ptybridge: child pid \d+ started (\d+)\r?\n/.exec(errors)?.[1];
  const helperStart = /ptybridge: started (\d+)\r?\n/.exec(errors)?.[1];
  assert.ok(cli !== undefined && cliStart && child.pid !== undefined && helperStart);
  assert.equal(await processStartLater(child.pid), helperStart);
  assert.equal(await processStartLater(cli), cliStart);
  socket.end('x');
  assert.equal(await closed, 123, errors);
  assert.match(errors, /deadline passed/);
  assert.ok(await gone(cli, cliStart), '助手起的命令还在');
});
