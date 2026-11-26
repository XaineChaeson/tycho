// Guards the compiled process helper (service/procinfo.cs, service/procinfo.ts) against what
// the PowerShell queries of old answered and a faster one could get wrong:
//   - a start time read for a process that has already ended, whose object is still open, or
//     for one that exited with 259, which is what "still active" would mean to a check by
//     exit code;
//   - a table that loses the rows whose time cannot be read, or that counts the query
//     process itself as a row of the machine;
//   - a marker query that finds the helper itself, because the marker rides its command
//     line, or that answers "nothing carries it" where WMI refused;
//   - a host without a compiler, or with one that fails, left with no answer at all, or told
//     to compile the helper again for every question;
//   - two processes compiling the same source at the same instant using half-written output.
//
// Every answer is compared against the PowerShell query the helper replaces, so the two
// cannot drift apart. The helper is Windows-only: elsewhere these are skipped.
import './guard.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { programPath } from '../service/csharp.ts';
import { isAlive } from '../service/lock.ts';
import {
  MARKER_VARIABLE, PROCINFO_SOURCE, createProcInfo,
  parseHelperTable, parseStarts, parseTagged, parseWindowsTable, type ProcRow,
} from '../service/procinfo.ts';
import { windowsProcessesWith } from '../service/processes.ts';

const windowsOnly = { skip: process.platform !== 'win32' && '进程查询助手是给 Windows 编的小程序，别处不编它', timeout: 120_000 };
const CHILD = join(import.meta.dirname, 'procinfo-compile-child.ts');
const FAKE_HELPER = join(import.meta.dirname, 'procinfo-fake-helper.mjs');
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PROCESS_BUFFER = 32 * 1024 * 1024;

function cacheDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-procinfo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

// The helper one cache directory holds now, and when it was written.
function helperOf(dir: string): { exe: string; made: number } {
  const exe = programPath({ source: PROCINFO_SOURCE, dir, name: 'procinfo.exe' });
  return { exe, made: statSync(exe).mtimeMs };
}

function powershell(script: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', env, timeout: 30_000, maxBuffer: PROCESS_BUFFER, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// The question service/lock.ts asked before the helper: one PowerShell per pid.
function oldStart(pid: number): string | undefined {
  const answer = powershell(`(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`).trim();
  return /^\d+$/.test(answer) ? answer : undefined;
}

// The whole table as node/hostprocess.ts read it before the helper.
const OLD_TABLE = `$ErrorActionPreference = 'Stop'
"$PID"
Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`;

// The marker search as service/processes.ts made it: the marker in the environment, never on
// the query's own command line.
const OLD_TAGGED = `$ErrorActionPreference = 'Stop'
$m = $env:TYCHO_TEST_MARK
Get-CimInstance Win32_Process |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($m) } |
  ForEach-Object { $_.ProcessId }`;

const oldTagged = (marker: string): number[] =>
  powershell(OLD_TAGGED, { ...process.env, TYCHO_TEST_MARK: marker }).split(/\s+/).filter(Boolean).map(Number);

// A process that stays until the test ends. It says so itself on the way up: a fixed wait here
// would be asking whether this machine is quick, not whether the process is there.
async function idle(t: TestContext): Promise<number> {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('up\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout!, 'data');
  return child.pid!;
}

// Waits with the event loop held: a child that has ended is not collected while this runs,
// so its process object is still open and only a look at whether it is signalled tells it
// from a live one.
function heldWait(withinMs: number, condition: () => boolean): boolean {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + withinMs; ; ) {
    if (condition()) return true;
    if (Date.now() > deadline) return false;
    Atomics.wait(pause, 0, 0, 10);
  }
}

const rowsOf = (stdout: string): ProcRow[] => parseHelperTable(stdout);

test('三种回答的格式：认得出，认不得就整条不作数', () => {
  assert.deepEqual([...parseStarts('42 start 134389659254779879\n43 unknown exited\n')], [[42, '134389659254779879'], [43, undefined]]);
  assert.deepEqual([...parseStarts('')], []);
  assert.throws(() => parseStarts('42 maybe 1\n'), /读不懂/, '不认得的行不能当成一个时刻');
  assert.throws(() => parseStarts('42 start oops\n'), /读不懂/);
  assert.throws(() => parseStarts('42 start 1\n42 start 2\n'), /读不懂/, '同一个 pid 两条记录不是回答');

  // A row whose time cannot be read is still a row: dropping it would hide a process.
  assert.deepEqual(rowsOf('1 0 unknown\n2 1 1343\n'), [{ pid: 1, ppid: 0 }, { pid: 2, ppid: 1, born: '1343' }]);
  assert.throws(() => rowsOf('1 unknown\n'), /读不懂/, '半张表不当一张表');

  // The PowerShell table of old, read exactly as it was: its own pid is the first line and
  // never a row, and a line that is not a row is skipped.
  assert.deepEqual(parseWindowsTable('101\n100 1\nnot a row\n101 100\n'), [{ pid: 100, ppid: 1 }]);
  assert.deepEqual(parseTagged('12\n13\n'), [12, 13]);
  assert.throws(() => parseTagged('12 x\n'), /不是 pid/);
});

test('和旧的问法逐字相同：同步、异步、一次问几个', windowsOnly, async (t) => {
  const info = createProcInfo({ cacheDir: cacheDir(t), log: (line) => assert.fail(`不该降级：${line}`) });
  const first = await idle(t);
  const second = await idle(t);
  const pids = [process.pid, first, second];
  const expected = new Map(pids.map((pid) => [pid, oldStart(pid)]));
  assert.ok([...expected.values()].every((each) => each !== undefined), `旧问法读到了每个进程：${JSON.stringify([...expected])}`);

  assert.deepEqual(info.starts(pids), expected, '同步问法');
  assert.deepEqual(await info.startsLater(pids), expected, '一次问几个');
  assert.deepEqual(await info.startsLater([first]), new Map([[first, expected.get(first)]]), '异步问法');
});

test('已经结束的进程不再报启动时刻：不靠退出码判活', windowsOnly, async (t) => {
  const info = createProcInfo({ cacheDir: cacheDir(t), log: (line) => assert.fail(`不该降级：${line}`) });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const before = (await info.startsLater([child.pid!])).get(child.pid!);
  assert.ok(before, '活着的进程读得到启动时刻');
  assert.equal(oldStart(child.pid!), before, '和旧问法读到的是同一个时刻');

  child.kill();
  assert.ok(heldWait(10_000, () => info.starts([child.pid!]).get(child.pid!) === undefined), '结束之后不再报启动时刻');

  // A process that exits with 259 — the code that means "still active" to a check by exit
  // code — is ended too, and is still uncollected while the loop is held below.
  const leaver = spawn(process.execPath, ['-e', 'process.exit(259)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { if (leaver.exitCode === null) leaver.kill(); });
  const answered = heldWait(10_000, () => info.starts([leaver.pid!]).get(leaver.pid!) === undefined);
  assert.ok(answered, '以 259 退出的进程也不报启动时刻');
  const [code] = (await once(leaver, 'exit')) as [number];
  assert.equal(code, 259, '它确实是那个以 259 退出的进程');
});

test('整张表：父→子→孙在，读不到时间的行不消失，查询进程自己不在里面', windowsOnly, async (t) => {
  const dir = cacheDir(t);
  const info = createProcInfo({ cacheDir: dir, log: (line) => assert.fail(`不该降级：${line}`) });
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(grandchild.pid);
    setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const grandchild = Number((await once(child.stdout!, 'data'))[0].toString().trim());
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ } });

  const rows = await info.table();
  assert.ok(rows, '读得到整张表');
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  assert.equal(byPid.get(child.pid!)?.ppid, process.pid, '子进程的父是本进程');
  assert.equal(byPid.get(grandchild)?.ppid, child.pid, '孙进程的父是子进程');
  assert.ok(rows.some((row) => row.born === undefined), '读不到启动时刻的行还在表里');
  // The same two links in the table of old: the two answers are the same machine's.
  const old = parseWindowsTable(powershell(OLD_TABLE));
  const oldByPid = new Map(old.map((row) => [row.pid, row]));
  assert.equal(oldByPid.get(child.pid!)?.ppid, process.pid);
  assert.equal(oldByPid.get(grandchild)?.ppid, child.pid);

  // The helper is asked directly here, so its own pid is known: a table that enumerated the
  // query process would show it, and a round's watch would read every query as its own.
  const exe = programPath({ source: PROCINFO_SOURCE, dir, name: 'procinfo.exe' });
  assert.ok(existsSync(exe), '第一次查询已经把助手编好了');
  const asked = spawn(exe, ['table'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let said = '';
  asked.stdout!.setEncoding('utf8').on('data', (chunk: string) => { said += chunk; });
  await once(asked, 'exit');
  const theirs = rowsOf(said);
  assert.ok(theirs.length > 0, '那张表不是空的');
  assert.equal(theirs.some((row) => row.pid === asked.pid), false, '查询进程自己不占一行');
});

test('标记：和旧的问法同一组；问不了时说“说不清”，不说“没有”', windowsOnly, async (t) => {
  const dir = cacheDir(t);
  const info = createProcInfo({ cacheDir: dir, log: (line) => assert.fail(`不该降级：${line}`) });
  const marker = `tycho-procinfo-${randomUUID()}`;
  // The child says it is up, and from that moment its command line carries the marker: one
  // query is then a query of something that is there, not a question of who was quick.
  const marked = spawn(process.execPath, ['-e', "process.stdout.write('up\\n'); setInterval(() => {}, 1000)", '--', '--marker', marker], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { if (marked.exitCode === null) marked.kill(); });
  await once(marked.stdout!, 'data');

  const found = await info.tagged(marker);
  assert.deepEqual(found, [marked.pid!], '带标记的进程找到了');
  assert.deepEqual([...(found ?? [])].sort((a, b) => a - b), oldTagged(marker).sort((a, b) => a - b), '和旧的问法是同一组');

  // The marker travels in the environment, never on the helper's own command line: a query
  // of the same marker running beside it would otherwise be reported as a marked process.
  const report = join(dir, 'helper-said.json');
  const fake = createProcInfo({ helper: { command: process.execPath, args: [FAKE_HELPER, report] }, log: () => {} });
  assert.deepEqual(await fake.tagged(marker), []);
  const ran = JSON.parse(readFileSync(report, 'utf8')) as { argv: string[]; marker: string | null };
  assert.equal(ran.marker, marker, '标记走环境');
  assert.equal(ran.argv.join(' ').includes(marker), false, '标记不在命令行上');

  // Two real queries of the same marker at the same instant see the marked process and
  // nothing else: a helper carrying the marker on its command line would be reported here.
  const together = await Promise.all([info.tagged(marker), info.tagged(marker)]);
  assert.deepEqual(together.map((pids) => (pids ?? []).sort((a, b) => a - b)), [[marked.pid!], [marked.pid!]]);

  // A query that cannot be made is not an empty answer: the caller must stop, not kill.
  const refused = windowsProcessesWith(createProcInfo({
    helper: { command: join(dir, 'no-such-helper.exe') }, csc: null, powershell: null, log: () => {},
  }));
  await assert.rejects(refused.find(marker), /说不清有哪些进程带着标记/);
  assert.equal(await createProcInfo({ helper: { command: join(dir, 'no-such-helper.exe') }, csc: null, powershell: null, log: () => {} }).tagged(marker), undefined);
});

test('没有编译器、编译失败、助手起不来：退回 PowerShell，原因只记一次', windowsOnly, async (t) => {
  const dir = cacheDir(t);
  const child = await idle(t);
  const expected = oldStart(child);
  assert.ok(expected, '旧问法读得到这个进程');

  const ways = [
    ['没有编译器', { csc: null }],
    ['编译失败', { csc: [process.execPath, '-e', 'process.exit(1)', '--'] }],
    ['助手起不来', { helper: { command: join(dir, 'no-such-helper.exe') } }],
  ] as const;
  for (const [what, options] of ways) {
    const said: string[] = [];
    const info = createProcInfo({ cacheDir: join(dir, what), ...options, log: (line) => said.push(line) });
    assert.equal((await info.startsLater([child])).get(child), expected, `${what}：异步问法还是对的`);
    assert.equal(info.starts([child]).get(child), expected, `${what}：同步问法还是对的`);
    assert.equal(info.starts([process.pid]).get(process.pid), oldStart(process.pid), `${what}：本进程也问得对`);
    assert.equal(said.length, 1, `${what}：降级的原因只说一次：${said.join(' | ')}`);
    assert.match(said[0]!, /PowerShell/, `${what}：说清退到哪里`);
  }
});

test('编译一次就留着：同一个缓存目录不再编译', windowsOnly, async (t) => {
  const dir = cacheDir(t);
  const child = await idle(t);
  const first = createProcInfo({ cacheDir: dir, log: (line) => assert.fail(`不该降级：${line}`) });
  assert.equal((await first.startsLater([child])).get(child), oldStart(child));
  const { exe, made } = helperOf(dir);

  const again = createProcInfo({ cacheDir: dir, log: (line) => assert.fail(`不该降级：${line}`) });
  assert.equal((await again.startsLater([child])).get(child), oldStart(child), '另一个实例用同一份助手');
  assert.equal(statSync(exe).mtimeMs, made, '第二次没有重新编译');
  assert.equal(again.starts([process.pid]).get(process.pid), oldStart(process.pid));
  assert.equal(statSync(exe).mtimeMs, made, '同一个进程里再问一次也不重编');
});

test('两个进程同时第一次编译：都拿到能用的助手，都没有退回 PowerShell', windowsOnly, async (t) => {
  const dir = cacheDir(t);
  const child = await idle(t);
  const expected = oldStart(child);
  const runs = [0, 1].map(() => spawn(process.execPath, [CHILD, dir, String(child)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  const answers = await Promise.all(runs.map(async (run) => {
    let out = '';
    let err = '';
    run.stdout!.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
    run.stderr!.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
    const [code] = await once(run, 'exit');
    return { code, out, err };
  }));
  for (const answer of answers) {
    assert.equal(answer.code, 0, `子进程正常结束：${answer.err}`);
    const said = JSON.parse(answer.out.trim()) as { answer: string | null; degraded: string | null };
    assert.equal(said.answer, expected, `两个进程都拿到同一个启动时刻：${answer.out}${answer.err}`);
    assert.equal(said.degraded, null, `两个进程真的都用上了助手：${said.degraded}`);
  }
});

// Reporting only: no assertion is made about how long anything took. Run it idle and again
// while the load helper runs, and read the numbers out of the test output.
test('性能报告：编译一次、缓存后的单 pid、批量、整表、标记，以及旧的问法', windowsOnly, async (t) => {
  const dir = cacheDir(t);
  const child = await idle(t);
  const info = createProcInfo({ cacheDir: dir, log: (line) => assert.fail(`不该降级：${line}`) });

  const compiled = Date.now();
  const first = (await info.startsLater([child])).get(child);
  const compileMs = Date.now() - compiled;
  assert.equal(first, oldStart(child));

  const time = (body: () => void): number => {
    const started = performance.now();
    body();
    return Math.round(performance.now() - started);
  };
  const onceMs = time(() => assert.ok(info.starts([child]).get(child)));
  const batch = performance.now();
  await info.startsLater([process.pid, child]);
  const batchMs = Math.round(performance.now() - batch);
  const table = performance.now();
  assert.ok(await info.table());
  const tableMs = Math.round(performance.now() - table);
  const tagged = performance.now();
  assert.deepEqual(await info.tagged('tycho-no-such-marker-in-this-test'), []);
  const taggedMs = Math.round(performance.now() - tagged);

  const oldOnce = time(() => assert.ok(oldStart(child)));
  const oldTable = time(() => assert.ok(parseWindowsTable(powershell(OLD_TABLE)).length > 0));
  const oldTaggedMs = time(() => oldTagged('tycho-no-such-marker-in-this-test'));

  t.diagnostic(`助手：首次编译（含一次查询）${compileMs} ms；缓存后单 pid ${onceMs} ms；批量两个 ${batchMs} ms；整表 ${tableMs} ms；标记 ${taggedMs} ms`);
  t.diagnostic(`旧的问法（PowerShell + WMI）：单 pid ${oldOnce} ms；整表 ${oldTable} ms；标记 ${oldTaggedMs} ms`);
  assert.equal(isAlive(child), true);
});
