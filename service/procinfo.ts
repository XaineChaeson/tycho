// This machine's own processes, answered by one small compiled helper (service/procinfo.cs)
// instead of a PowerShell per question: when a process began, what is below what, and which
// carry a marker. The two ways of asking are the same two answers, so the callers keep their
// own failure policy: an unreadable table is "cannot say", never "nothing is there".
//
//   - service/lock.ts asks about single pids, and one of its callers must not hold the
//     thread while it does: on Windows a PowerShell per pid is 0.6 s, and a busy machine
//     answers too late to judge anything.
//   - node/hostprocess.ts and service/processes.ts read the whole table and the marker.
//
// Where there is no compiler, the compiler fails, or the helper will not start, the queries
// of old (PowerShell and WMI) answer instead, and the reason is said once for this process:
// the conclusion is kept, so nothing tries to compile again for every question.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compiledProgram, defaultCsc, defaultPowershell, keptProgram, runProgram } from './csharp.ts';
import { cachePathOf } from './home-paths.ts';

export const PROCINFO_SOURCE = join(import.meta.dirname, 'procinfo.cs');

// This program's own patience with a question, not behaviour the owner tunes. One pid
// keeps the bound it had; the whole table and the marker search keep theirs.
const ASK_MS = 10_000;
const TABLE_MS = 30_000;
// With every process in it, and WMI's command lines, an answer can be large.
const MAX_BUFFER = 32 * 1024 * 1024;

// The marker of `tagged` travels in the environment, never on the helper's command line:
// a command line carrying it would make the helper itself a marked process, and a query of
// the same marker running beside it would report it (service/procinfo.cs says the same).
export const MARKER_VARIABLE = 'TYCHO_PROCINFO_MARKER';

// One line of what a program said on its way, for the one reason recorded.
const firstLine = (text: string): string => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';

export interface ProcRow {
  pid: number;
  ppid: number;
  // When this process began, where the table could read it: a pid alone comes to mean
  // another process once the first is gone. A row whose time cannot be read stays, without it.
  born?: string;
}

export interface ProcInfo {
  // When these processes began, as text that only compares with itself; undefined for one
  // that cannot be read. Synchronous: one caller judges a lock without yielding.
  starts(pids: readonly number[]): Map<number, string | undefined>;
  // The same without holding the thread, for the machine's client (nodes.md §4.4).
  startsLater(pids: readonly number[]): Promise<Map<number, string | undefined>>;
  // Every process of this machine. Undefined when it cannot be read; a machine that cannot
  // read it says so, and never "nothing is running".
  table(): Promise<ProcRow[] | undefined>;
  // Every process whose command line carries the marker. Undefined when it cannot be read.
  tagged(marker: string): Promise<number[] | undefined>;
}

// One record a line: "<pid> start <filetime>" or "<pid> unknown <why>", the why last
// because it is the one part that may hold spaces. Anything else is not an answer.
export function parseStarts(stdout: string): Map<number, string | undefined> {
  const found = new Map<number, string | undefined>();
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const [pid, kind, ...rest] = line.split(' ');
    if (!/^\d+$/.test(pid ?? '') || (kind !== 'start' && kind !== 'unknown') || found.has(Number(pid))) {
      throw new Error(`进程助手回答的启动时刻读不懂：${line.slice(0, 200)}`);
    }
    if (kind === 'start' && !/^\d+$/.test(rest[0] ?? '')) throw new Error(`进程助手回答的启动时刻读不懂：${line.slice(0, 200)}`);
    found.set(Number(pid), kind === 'start' ? rest[0] : undefined);
  }
  return found;
}

// "<pid> <ppid> <filetime|unknown>". A row with no readable time is still a row.
export function parseHelperTable(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const [pid, ppid, born] = line.split(' ');
    if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(ppid ?? '')) {
      throw new Error(`进程助手回答的进程表读不懂：${line.slice(0, 200)}`);
    }
    rows.push({ pid: Number(pid), ppid: Number(ppid), ...(born === undefined || born === 'unknown' ? {} : { born }) });
  }
  return rows;
}

// The query of old: `Get-CimInstance Win32_Process`, one "pid ppid" a line, with the query's
// own pid first. The parent link survives the parent's death on Windows, so a tree is still
// found from a pid that is gone.
const WINDOWS_TABLE = `$ErrorActionPreference = 'Stop'
"$PID"
Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`;

// The first line is the query's own pid: it is never a row of the table.
export function parseWindowsTable(stdout: string): ProcRow[] {
  const lines = stdout.split('\n');
  const query = Number(lines[0]);
  const rows: ProcRow[] = [];
  for (const line of lines.slice(1)) {
    const found = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (found && Number(found[1]) !== query) rows.push({ pid: Number(found[1]), ppid: Number(found[2]) });
  }
  return rows;
}

// The marker is on the watch process's own command line, which is ours to write; WMI can
// read command lines and cannot read environments.
const WINDOWS_TAGGED = `$ErrorActionPreference = 'Stop'
$m = $env:${MARKER_VARIABLE}
Get-CimInstance Win32_Process |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($m) } |
  ForEach-Object { $_.ProcessId }`;

export function parseTagged(stdout: string): number[] {
  const pids = stdout.split(/\s+/).filter(Boolean).map(Number);
  if (pids.some(Number.isNaN)) throw new Error(`进程查询的输出不是 pid：${stdout.slice(0, 200)}`);
  return pids;
}

export interface ProcInfoOptions {
  // Where the compiled helper is kept: <dir>/<source hash>/procinfo.exe. The default is under
  // tycho's own home (service/home-paths.ts cachePathOf); callers such as
  // service/lock.ts have no data directory of their own.
  cacheDir?: string;
  source?: string;
  // The compiler, or the shell, taken away or given by a test; a helper stand-in is a
  // program and the arguments that come before its own.
  csc?: string | readonly string[] | null;
  powershell?: string | null;
  helper?: { command: string; args?: readonly string[] } | null;
  log?: (line: string) => void;
}

const startQuestion = (pid: number): string => `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`;

class Machine implements ProcInfo {
  private readonly options: ProcInfoOptions;
  private readonly cacheDir: string;
  private readonly source: string;
  private readonly log: (line: string) => void;
  // Set once: the helper, or none because this machine cannot use one. The second is kept
  // for this process's life, so nothing compiles again for every question.
  private helper: { command: string; args: string[] } | null = null;
  private refused = false;
  private building: Promise<void> | undefined;
  private said = false;

  constructor(options: ProcInfoOptions) {
    this.options = options;
    this.cacheDir = options.cacheDir ?? cachePathOf(process.env, homedir(), 'procinfo');
    this.source = options.source ?? PROCINFO_SOURCE;
    this.log = options.log ?? ((line) => console.error(line));
  }

  // Given up on for this process: the old way answers from here on, and why is said once.
  private giveUp(why: string): void {
    this.refused = true;
    this.helper = null;
    if (!this.said) {
      this.said = true;
      this.log(why);
    }
  }

  private shellPath(): string | null {
    return this.options.powershell === undefined ? defaultPowershell() : this.options.powershell;
  }

  // One question to the shell, in the words of old. Undefined where it will not answer: the
  // caller's own failure policy decides what that means.
  private async shellQuestion(script: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
    const shell = this.shellPath();
    if (shell === null) return undefined;
    try {
      return await this.answerLater({ command: shell, args: [] }, ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs, env);
    } catch {
      return undefined;
    }
  }

  // The helper this process can use right now without waiting for anything: one a test gave,
  // one already made for this source, or none. None does not
  // mean a failure: the compile is started for the next question, and this one is asked the
  // old way.
  private ready(): { command: string; args: string[] } | null {
    if (this.refused) return null;
    const given = this.options.helper;
    if (given !== undefined) return given === null ? null : { command: given.command, args: [...(given.args ?? [])] };
    if (this.helper) return this.helper;
    const file = keptProgram({ source: this.source, dir: this.cacheDir, name: 'procinfo.exe' });
    if (file === undefined) return null;
    this.helper = { command: file, args: [] };
    return this.helper;
  }

  private ensure(): Promise<void> {
    this.building ??= this.build();
    return this.building;
  }

  private async build(): Promise<void> {
    if (this.refused || this.helper !== null) return;
    const given = this.options.helper;
    if (given !== undefined) {
      if (given === null) this.giveUp('没有进程查询助手可用，进程查询用 PowerShell');
      else this.helper = { command: given.command, args: [...(given.args ?? [])] };
      return;
    }
    if (!existsSync(this.source)) {
      this.giveUp(`进程查询助手的源码不在（${this.source}），进程查询用 PowerShell`);
      return;
    }
    const givenCsc = this.options.csc === undefined ? defaultCsc() : this.options.csc;
    const csc = givenCsc === null ? null : typeof givenCsc === 'string' ? [givenCsc] : givenCsc;
    if (csc === null || !existsSync(csc[0]!)) {
      this.giveUp(`这台电脑上没有 C# 编译器${csc ? `（${csc[0]}）` : ''}，进程查询用 PowerShell`);
      return;
    }
    const made = await compiledProgram({
      source: this.source,
      dir: this.cacheDir,
      name: 'procinfo.exe',
      csc,
      label: '进程查询助手',
      // The command lines of WMI are read through System.Management.
      references: ['-r:System.Management.dll'],
      run: (program, args, timeoutMs) => runProgram(program, args, timeoutMs),
    });
    if (made.file === undefined) {
      this.giveUp(`${made.problem}；进程查询用 PowerShell`);
      return;
    }
    if (!this.refused) this.helper = { command: made.file, args: [] };
  }

  // One question to the helper, answered in text. Both ways of asking use this, so the two
  // cannot drift apart.
  private answerSync(program: { command: string; args: readonly string[] }, args: readonly string[], timeoutMs: number, env?: NodeJS.ProcessEnv): string {
    return execFileSync(program.command, [...program.args, ...args], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env } : {}),
    }).trim();
  }

  private async answerLater(program: { command: string; args: readonly string[] }, args: readonly string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
    const ran = await runProgram(program.command, [...program.args, ...args], timeoutMs, { maxBuffer: MAX_BUFFER, ...(env ? { env } : {}) });
    if (ran.code === 0) return ran.stdout.trim();
    throw new Error(`${ran.code === null ? ran.failed ?? '没有回答' : `退出码 ${ran.code}`}${ran.stderr.trim() ? `：${firstLine(ran.stderr)}` : ''}`);
  }

  // The answer of old: one PowerShell per pid, the same question service/lock.ts asked.
  private askStart(pid: number): string | undefined {
    const shell = this.shellPath();
    if (shell === null) return undefined;
    try {
      const answer = this.answerSync({ command: shell, args: [] }, ['-NoProfile', '-NonInteractive', '-Command', startQuestion(pid)], ASK_MS, process.env);
      return /^\d+$/.test(answer) ? answer : undefined;
    } catch {
      return undefined;
    }
  }

  private async askStartLater(pid: number): Promise<string | undefined> {
    const answer = await this.shellQuestion(startQuestion(pid), ASK_MS, process.env);
    return answer !== undefined && /^\d+$/.test(answer) ? answer : undefined;
  }

  starts(pids: readonly number[]): Map<number, string | undefined> {
    if (pids.length === 0) return new Map();
    const helper = this.ready();
    if (helper !== null) {
      try {
        const answers = parseStarts(this.answerSync(helper, ['starts', ...pids.map(String)], ASK_MS));
        if (pids.every((pid) => answers.has(pid))) return answers;
        throw new Error('助手没有回答问到的每个进程');
      } catch (error) {
        this.giveUp(`进程查询助手用不了（${(error as Error).message}），进程查询用 PowerShell`);
      }
    }
    // Made for the next question without holding this one, which is asked the old way.
    void this.ensure().catch(() => {});
    return new Map(pids.map((pid) => [pid, this.askStart(pid)]));
  }

  async startsLater(pids: readonly number[]): Promise<Map<number, string | undefined>> {
    if (pids.length === 0) return new Map();
    try {
      await this.ensure();
    } catch (error) {
      this.giveUp(`进程查询助手准备不了（${(error as Error).message}），进程查询用 PowerShell`);
    }
    if (this.helper !== null) {
      try {
        const answers = parseStarts(await this.answerLater(this.helper, ['starts', ...pids.map(String)], ASK_MS));
        if (pids.every((pid) => answers.has(pid))) return answers;
        throw new Error('助手没有回答问到的每个进程');
      } catch (error) {
        this.giveUp(`进程查询助手用不了（${(error as Error).message}），进程查询用 PowerShell`);
      }
    }
    const answers = new Map<number, string | undefined>();
    for (const pid of pids) answers.set(pid, await this.askStartLater(pid));
    return answers;
  }

  async table(): Promise<ProcRow[] | undefined> {
    try {
      await this.ensure();
    } catch (error) {
      this.giveUp(`进程查询助手准备不了（${(error as Error).message}），进程查询用 PowerShell`);
    }
    if (this.helper !== null) {
      try {
        return parseHelperTable(await this.answerLater(this.helper, ['table'], TABLE_MS));
      } catch (error) {
        this.giveUp(`进程查询助手用不了（${(error as Error).message}），进程查询用 PowerShell`);
      }
    }
    const stdout = await this.shellQuestion(WINDOWS_TABLE, TABLE_MS, process.env);
    return stdout === undefined ? undefined : parseWindowsTable(stdout);
  }

  async tagged(marker: string): Promise<number[] | undefined> {
    try {
      await this.ensure();
    } catch (error) {
      this.giveUp(`进程查询助手准备不了（${(error as Error).message}），进程查询用 PowerShell`);
    }
    const env = { ...process.env, [MARKER_VARIABLE]: marker };
    if (this.helper !== null) {
      try {
        return parseTagged(await this.answerLater(this.helper, ['tagged'], TABLE_MS, env));
      } catch (error) {
        this.giveUp(`进程查询助手用不了（${(error as Error).message}），进程查询用 PowerShell`);
      }
    }
    const stdout = await this.shellQuestion(WINDOWS_TAGGED, TABLE_MS, env);
    return stdout === undefined ? undefined : parseTagged(stdout);
  }
}

export const createProcInfo = (options: ProcInfoOptions = {}): ProcInfo => new Machine(options);

// The one this host uses. A caller with a data directory of its own (a test) makes its own
// through createProcInfo; nothing else shares an answer with it.
let shared: ProcInfo | undefined;
export const defaultProcInfo = (): ProcInfo => (shared ??= createProcInfo());
