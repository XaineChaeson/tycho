// Guards against a Ctrl+C that the Router, or anything below it, sends to its console on
// the way out reaching the service that started it, and through the service's console the
// autostart loop around it (on 2026-11-08 a service and its loop went down together with
// 0xC000013A, STATUS_CONTROL_C_EXIT). On Windows GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)
// reaches every process attached to the sender's console, whatever its process group.
//
// The parent stands where the service stands: on a console of its own, with Ctrl+C handled
// (it stops on SIGINT, as service/main.ts does). The PowerShell around it turns Ctrl+C back
// on first: whatever ran this test may have started it with Ctrl+C ignored, which children
// inherit, and a parent that cannot receive the event would pass for one that was shielded.
// The control case proves the event does arrive when the stand-in shares the console.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const KERNEL32 = `Add-Type -Namespace TychoTest -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add); [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'`;

// The stand-in ignores the event itself, so that it lives to say whether the call worked:
// a stand-in with no console to send on would make the test pass for nothing.
const STAND_IN = `${KERNEL32}; [TychoTest.K]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null; 'sent=' + [TychoTest.K]::GenerateConsoleCtrlEvent(0, 0)`;

const PARENT = `import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { rootSpawnOptions } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'service', 'processes.ts')).href)};
const [mode, log] = process.argv.slice(2);
const note = (line) => appendFileSync(log, line + '\\n');
const standIn = (options) => spawn(${JSON.stringify(POWERSHELL)}, ['-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(STAND_IN)}], options);
// The event is delivered on a thread of its own, soon after the call: the shared case shows
// it arrives well within this pause.
const outlive = (child, what) => child.on('close', (code) => { note(what + ' exit ' + code); setTimeout(() => { note(mode + ' alive'); process.exit(0); }, 2000); });
if (mode === 'client') {
  process.on('SIGINT', () => { note('client SIGINT'); process.exit(3); });
  // As node/client.ts spawnWatch starts the watch process.
  outlive(spawn(process.execPath, [process.argv[1], 'watch', log], { detached: true, windowsHide: true, stdio: 'ignore' }), 'watch');
} else if (mode === 'watch') {
  process.on('SIGINT', () => { note('watch SIGINT'); process.exit(3); });
  // As node/watch.ts starts the Worker: its output to files, detached only where there are groups.
  const out = openSync(log + '.worker', 'a');
  outlive(standIn({ stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32' }), 'worker');
  closeSync(out);
} else {
  process.on('SIGINT', () => { note('SIGINT'); process.exit(3); });
  // 'service': as service/session-host.ts starts the Router. 'shared': on this console.
  const child = standIn(mode === 'service' ? rootSpawnOptions(process.platform) : { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8').on('data', (text) => note('child: ' + text.trim()));
  outlive(child, 'child');
}
`;

function runParent(mode: 'service' | 'shared' | 'client'): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-ctrl-c-'));
  const parent = join(dir, 'parent.mjs');
  const log = join(dir, 'log');
  writeFileSync(parent, PARENT);
  writeFileSync(log, '');
  const wrapper = `${KERNEL32}; [TychoTest.K]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $false) | Out-Null; & $env:TYCHO_TEST_NODE $env:TYCHO_TEST_PARENT $env:TYCHO_TEST_MODE $env:TYCHO_TEST_LOG`;
  // Pipes and windowsHide: a console of its own, with no window.
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', wrapper], {
    windowsHide: true,
    env: { ...process.env, TYCHO_TEST_NODE: process.execPath, TYCHO_TEST_PARENT: parent, TYCHO_TEST_MODE: mode, TYCHO_TEST_LOG: log },
  });
  child.stdout.resume();
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      try {
        // The client exits only once the watch process has, and the watch only once its Worker has.
        const worker = mode === 'client' ? readFileSync(`${log}.worker`, 'utf8').split('\n').map((line) => `worker: ${line.trim()}`) : [];
        resolve([...readFileSync(log, 'utf8').split('\n'), ...worker].filter((line) => line !== '' && line !== 'worker: '));
      } catch (err) {
        reject(err);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

const windowsOnly = { skip: process.platform !== 'win32' && 'Windows consoles only', timeout: 60_000 };

test('the control: a stand-in on the parent console takes the parent with it', windowsOnly, async () => {
  const lines = await runParent('shared');
  assert.ok(lines.includes('SIGINT'), `the parent should have had the Ctrl+C: ${lines.join(' | ')}`);
});

test('a Ctrl+C the Router sends to its console does not reach the service', windowsOnly, async () => {
  const lines = await runParent('service');
  assert.ok(lines.includes('child: sent=True'), `the stand-in should have sent the Ctrl+C: ${lines.join(' | ')}`);
  assert.ok(!lines.includes('SIGINT'), `the service-like parent had the Ctrl+C: ${lines.join(' | ')}`);
  assert.ok(lines.includes('service alive'), lines.join(' | '));
});

// The watch process has no console (the client starts it detached), so the Worker it starts
// gets one of its own, and the client's console is not the Worker's either.
test('a Ctrl+C a Worker sends to its console reaches neither the watch process nor the client', windowsOnly, async () => {
  const lines = await runParent('client');
  assert.ok(lines.includes('worker: sent=True'), `the Worker should have sent the Ctrl+C: ${lines.join(' | ')}`);
  assert.ok(!lines.some((line) => line.endsWith('SIGINT')), lines.join(' | '));
  assert.ok(lines.includes('watch alive') && lines.includes('client alive'), lines.join(' | '));
});
