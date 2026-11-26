import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultProcInfo } from './procinfo.ts';

const ASK_MS = 10_000;
const execFileLater = promisify(execFile);

// One question to another program, answered in text. Nothing it says on the way is of any
// use here, and an answer that never comes must not hold up a start.
function say(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(file, args, { encoding: 'utf8', env, timeout: ASK_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// The same question without holding the thread, for the one caller that has to keep
// answering a host while it asks (node/hostprocess.ts).
async function sayLater(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await execFileLater(file, args, { encoding: 'utf8', env, timeout: ASK_MS, windowsHide: true });
  return stdout.trim();
}

// A process that has ended keeps its pid until its parent collects it, and a signal to
// it still succeeds. Where the parent is busy, or never collects — a container with no
// init — such a process would count as running for good. Linux only: elsewhere no file
// says so without asking the process itself, and the pid decides.
function ended(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // After the program's name in brackets, which may hold brackets itself.
    const state = stat.charAt(stat.lastIndexOf(')') + 2);
    return state === 'Z' || state === 'X';
  } catch {
    return false;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  return !ended(pid);
}

// Linux answers from a file: there is no program to run.
function linuxStart(pid: number): string | undefined {
  // The second field is the program's name in brackets and may hold brackets and
  // spaces itself; the start, in clock ticks since boot, is the 22nd.
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!ticks) return undefined;
  let boot = '';
  try {
    boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Ticks alone still tell two processes of one boot apart.
  }
  return `${boot}:${ticks}`;
}

// Where else a start is asked for: `ps`, in one language whoever asks (it prints the date in
// the caller's). On Windows the question goes to the process helper (service/procinfo.ts),
// which gives the same answer the PowerShell of old did, from one program rather than one
// per pid; Linux answers from a file.
const psQuestion = (pid: number): { file: string; args: string[]; env: NodeJS.ProcessEnv } =>
  ({ file: 'ps', args: ['-o', 'lstart=', '-p', String(pid)], env: { ...process.env, LC_ALL: 'C' } });

function askSystem(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') return linuxStart(pid);
    if (process.platform === 'win32') return defaultProcInfo().starts([pid]).get(pid);
    const { file, args, env } = psQuestion(pid);
    return say(file, args, env) || undefined;
  } catch {
    return undefined;
  }
}

async function askSystemLater(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') return linuxStart(pid);
    if (process.platform === 'win32') return (await defaultProcInfo().startsLater([pid])).get(pid);
    const { file, args, env } = psQuestion(pid);
    return (await sayLater(file, args, env)) || undefined;
  } catch {
    return undefined;
  }
}

// One question to the system, and what is kept of the answer about this process's own start.
// Another process is asked about every time: a pid comes to mean another process once the
// first is gone. This process's own start never changes, so it is kept — but an answer that
// was not read is not an answer, and the next question asks again. Two questions in the air
// at once are one question: the client asks while it polls, and each ask is a whole program.
export function startQuestions(
  askNow: (pid: number) => string | undefined,
  askLater: (pid: number) => Promise<string | undefined>,
  self: number = process.pid,
): { start(pid: number): string | undefined; startLater(pid: number): Promise<string | undefined> } {
  let own: string | undefined;
  let asking: Promise<string | undefined> | undefined;
  return {
    start(pid) {
      if (pid !== self) return askNow(pid);
      if (own === undefined) {
        const start = askNow(pid);
        if (start !== undefined) own = start;
      }
      return own;
    },
    async startLater(pid) {
      if (pid !== self) return askLater(pid);
      if (own === undefined) {
        asking ??= askLater(pid).then((start) => {
          if (start !== undefined) own = start;
          asking = undefined;
          return own;
        });
        await asking;
      }
      return own;
    },
  };
}

const own = startQuestions(askSystem, askSystemLater);

// When the operating system says a process began, as text that only ever compares with
// itself. A pid alone does not name a process: in a container every start of the service
// gets the same one, and anywhere a pid is handed out again once its process is gone.
// Undefined when the system cannot say.
export const processStart = (pid: number): string | undefined => own.start(pid);

// The same answer without holding the thread while the system is asked. For the machine's
// client, which keeps its poll going while it reads its rounds' processes: on Windows that
// is one program per question, and a slow one must not hold up the next poll (nodes.md §4.4).
export const processStartLater = (pid: number): Promise<string | undefined> => own.startLater(pid);

// What the operating system keeps to name this installation for its whole life. Undefined
// when this system keeps nothing of the sort.
function askMachine(): string | undefined {
  try {
    if (process.platform === 'linux') {
      // Written at installation by the system and by every container image of it.
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = readFileSync(file, 'utf8').trim();
          if (id !== '') return id;
        } catch {
          // The next file, and then no answer.
        }
      }
    } else if (process.platform === 'darwin') {
      const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(say('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']))?.[1];
      if (uuid !== undefined) return uuid;
    } else if (process.platform === 'win32') {
      const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
      const guid = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(say(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']))?.[1];
      if (guid !== undefined) return guid;
    }
  } catch {
    // Nothing to ask, or nothing that answered.
  }
  return undefined;
}

let ownName: { id: string | undefined; host: string | undefined } | undefined;

// The hostname is for whoever has to read which machine a lock belongs to; the identity is
// what decides. A machine that can say neither records no machine at all, exactly like a
// version from before this field existed.
function ownMachine(): { id: string | undefined; host: string | undefined } {
  if (ownName === undefined) {
    let host: string | undefined;
    try {
      host = hostname() || undefined;
    } catch {
      host = undefined;
    }
    ownName = { id: askMachine() ?? host, host };
  }
  return ownName;
}

// What this machine calls itself, for a lock to record. Undefined when it cannot say.
export function machineId(): string | undefined {
  return ownMachine().id;
}

export interface Holder {
  pid: number;
  // Absent in a lock written by a version that did not record it.
  start?: string;
  // The machine that wrote the lock and its hostname for reading. Absent in a lock from a
  // version that did not record them, or from a machine that cannot name itself.
  machine?: string;
  hostname?: string;
}

// Undefined when the file is not there or names no process.
export function readHolder(file: string): Holder | undefined {
  try {
    const { pid, process_start: start, machine, hostname: host } = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!Number.isInteger(pid) || (pid as number) <= 0) return undefined;
    return {
      pid: pid as number,
      ...(typeof start === 'string' ? { start } : {}),
      ...(typeof machine === 'string' && machine !== '' ? { machine } : {}),
      ...(typeof host === 'string' && host !== '' ? { hostname: host } : {}),
    };
  } catch {
    return undefined;
  }
}

// The machine a lock belongs to, when it is not this one. Pids mean nothing across
// machines: two of them sharing a data directory (a cluster instance's home) each see the
// other's holder holding a pid they cannot look up. A lock that names no machine is not
// another machine's: it is judged by the pid, exactly as before.
export function lockElsewhere(holder: Holder): string | undefined {
  return holder.machine !== undefined && holder.machine !== machineId() ? holder.machine : undefined;
}

// The machine a holder names, as the one who reads the report needs it to find that
// machine: its hostname, and the identity that decides when the two differ.
export function machineName({ hostname: host, machine }: Holder): string {
  if (host === undefined) return machine ?? '说不出来的机器';
  return machine === undefined || machine === host ? host : `${host}（标识 ${machine}）`;
}

// What to do about a lock another machine wrote: this one can neither see whether that
// process is still there nor wait it out, so it may not take the lock. The way through is
// to stop that service over there, or, once it is certainly gone, to delete the file. One
// text, because the service, the restore command, the CLI and the doctor all report it.
export function elsewhereText(file: string, holder: Holder): string {
  return `锁属于机器 ${machineName(holder)} 上的进程 ${holder.pid}：本机看不到那个进程，判断不了它是不是还在，不能接管。到那台机器上停掉那份服务；那台机器已经不在、或者确认它上面的服务已经不在了，就删掉 ${file}，再启动。`;
}

// The pid is alive and is still the process that took the lock. A lock from another
// machine counts as held: what this machine cannot see, it does not declare gone. Where
// the start was not recorded, or the system cannot say, the pid decides.
export function holderAlive(holder: Holder): boolean {
  if (lockElsewhere(holder) !== undefined) return true;
  if (!isAlive(holder.pid)) return false;
  if (holder.start === undefined) return true;
  const now = processStart(holder.pid);
  return now === undefined || now === holder.start;
}

// The opposite stance to holderAlive, for handing a secret to the process that holds the
// lock (the local join, docs/design/nodes.md §1.1 step 2): true only when that is shown, not
// when it cannot be ruled out. The lock is this machine's and names the pid it expects;
// it recorded the moment that process began; the system says now when the process with
// that pid began; and the two are the same. A lock from before the moment was recorded, a
// question the system would not answer (no such process, no permission), or a pid another
// process has taken since: all false. `startOf` is for tests.
export function heldBy(holder: Holder, pid: number, startOf: (pid: number) => string | undefined = processStart): boolean {
  if (holder.pid !== pid || lockElsewhere(holder) !== undefined || holder.start === undefined) return false;
  let now: string | undefined;
  try {
    now = startOf(pid);
  } catch {
    return false;
  }
  return now !== undefined && now === holder.start;
}

// Null once the lock is this process's; otherwise the live process that holds it.
export function claimLock(file: string, log: (line: string) => void): Holder | null {
  const { id: machine, host } = ownMachine();
  const start = processStart(process.pid);
  const body = JSON.stringify({
    pid: process.pid,
    ...(start === undefined ? {} : { process_start: start }),
    ...(machine === undefined ? {} : { machine }),
    ...(host === undefined ? {} : { hostname: host }),
    started_at: new Date().toISOString(),
  });
  try {
    writeFileSync(file, body, { flag: 'wx' });
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // Whoever is creating it this instant has made the file and not yet written into it.
  let holder = readHolder(file);
  for (let attempt = 0; !holder && attempt < 3; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    holder = readHolder(file);
  }
  if (!holder) throw new Error(`锁文件 ${file} 读不出 pid；确认持有它的进程已经不在之后删掉它`);
  if (holderAlive(holder)) return holder;
  log(`锁文件的进程 ${holder.pid} 已不在，覆盖`);
  rmSync(file);
  writeFileSync(file, body, { flag: 'wx' });
  return null;
}

// §11: everything after this, down to the first cleanup, assumes no other service
// shares the data directory. A second one must leave without touching anything.
export function acquireLock(file: string, log: (line: string) => void): void {
  const holder = claimLock(file, log);
  if (holder === null) return;
  if (lockElsewhere(holder) !== undefined) throw new Error(elsewhereText(file, holder));
  throw new Error(`另一份服务（${holder.pid}）正在运行`);
}
