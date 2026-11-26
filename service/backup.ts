// §2's daily backup. What exists in the backup directory is the record: a directory named
// after its day is complete, because it only ever arrives by rename, and nothing about
// backups is written to the ledger. The directory can hold the owner's own things, so a
// name never makes a directory ours: only the mark written into it, or its report, does.
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifySnapshot } from './db.ts';
import { InputError } from './errors.ts';
import type { Ledger } from './ledger.ts';

const DAY_NAME = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEFTOVER = /^(.+)\.(old|partial)$/;
const REPORT = 'backup.json';
// Written into a .partial before anything else: what says a directory without a report
// is ours to delete.
const OWNER_MARK = '.tycho-backup';
const OWNER_TEXT = 'tycho-backup：这个目录由 tycho 的自动备份创建和管理，会被整个替换或删除，不要往里放东西。\n';
const RESTORE_SETTING = 'restore';
// A constant, not a setting: how many leftovers of interrupted copies are tolerated says
// nothing the owner chooses; keepDays is what governs what is kept.
const MAX_INCOMPLETE = 20;
// One step: copying in batches would start over on every commit the service makes.
// The largest batch SQLite's page count can name. Node 24.22 refuses the negative value
// that older versions took to mean the same thing.
const ALL_PAGES = 2 ** 31 - 1;
const RM_RETRIES = 3;

export interface BackupConfig {
  // Empty means no automatic backup.
  dir: string;
  // Local time, HH:MM.
  at: string;
  keepDays: number;
}

export interface BackupReport {
  at: string;
  ledger_bytes: number;
  runs_files: number;
  runs_incomplete: string[];
  tool: 'backup' | 'vacuum';
}

export type BackupResult = ({ ok: true } & BackupReport) | { ok: false; at: string; error: string };

type BackupView =
  | { configured: false }
  | {
      configured: true;
      dir: string;
      at: string;
      last_ok_at: string | null;
      last_ok_incomplete: boolean;
      last_error: { at: string; text: string } | null;
      running: boolean;
    };

export interface BackupClock {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface BackupHooks {
  // Crash injection, and the points a test holds a backup at.
  afterLedger?: (file: string) => Promise<void> | void;
  beforeInstall?: () => Promise<void> | void;
  afterPark?: () => Promise<void> | void;
  copyRun?: (from: string, to: string) => Promise<void>;
  removeExpired?: (path: string) => Promise<void>;
}

export interface BackupOptions {
  dataDir: string;
  config: () => BackupConfig;
  ledger: Pick<Ledger, 'getRestore'>;
  recovering: () => boolean;
  // Called only on going from good to bad, with the time that failure began.
  onFailure?: (reason: string, lastOkAt: string | null, failedAt: string) => void;
  clock?: BackupClock;
  hooks?: BackupHooks;
  log?: (line: string) => void;
}

const REAL_CLOCK: BackupClock = {
  now: Date.now,
  setTimer(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

const pad = (value: number): string => String(value).padStart(2, '0');

function dayName(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function isDay(name: string): boolean {
  const match = DAY_NAME.exec(name);
  return match !== null && dayName(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) === name;
}

// The path as the file system has it. What does not exist yet is taken from the nearest
// ancestor that does, so a junction above it still counts.
function realPath(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync.native(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(realPath(parent), basename(full));
  }
}

// Where `path` is from `parent`, both as the file system has them; '' when they are the
// same. On Windows `relative` compares without regard to case, as the file system does.
const from = (parent: string, path: string): string => relative(realPath(parent), realPath(path));

// Why this directory cannot hold the backups, in words for the owner, or null. One that
// does not exist is no problem here: a disk that is away is a failed backup, not a wrong
// setting.
export function backupDirProblem(dataDir: string, dir: string): string | null {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === false) return `备份目录指向的不是目录：${dir}`;
  if (from(dataDir, dir) === '') return `备份目录不能就是数据目录：${dir}`;
  // runs/ is what a backup copies, so a backup in there would be copied into itself.
  const inRuns = from(join(dataDir, 'runs'), dir);
  const outside = inRuns === '..' || inRuns.startsWith(`..${sep}`) || isAbsolute(inRuns);
  if (!outside) return `备份目录不能放在数据目录的 runs 里面，那样备份会把自己再备份进去：${dir}`;
  return null;
}

export function createBackups({ dataDir, config, ledger, recovering, onFailure, clock = REAL_CLOCK, hooks = {}, log = (line) => console.error(line) }: BackupOptions) {
  let { dir, at: time, keepDays } = config();
  // By calendar, not by adding 24 hours, so daylight saving cannot move it.
  function moment(day: Date, offset: number): number {
    const [hour, minute] = time.split(':').map(Number) as [number, number];
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, hour, minute).getTime();
  }
  function nextMoment(after: number): number {
    let offset = 0;
    while (moment(new Date(after), offset) <= after) offset += 1;
    return moment(new Date(after), offset);
  }
  function lastMoment(now: number): number {
    let offset = 0;
    while (moment(new Date(now), offset) > now) offset -= 1;
    return moment(new Date(now), offset);
  }

  let current: Promise<BackupResult> | undefined;
  let timer: unknown;
  let opened = false;
  let closed = false;
  let abandoned = false;
  let lastError: { at: string; text: string } | null = null;

  function readReport(name: string): BackupReport | null {
    try {
      const report = JSON.parse(readFileSync(join(dir, name, REPORT), 'utf8')) as BackupReport;
      return Number.isNaN(Date.parse(report.at)) ? null : report;
    } catch {
      return null;
    }
  }

  // Newest first. A directory of that name without a report is somebody else's.
  function completed(): { name: string; report: BackupReport }[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter(isDay).sort().reverse().flatMap((name) => {
      const report = readReport(name);
      return report ? [{ name, report }] : [];
    });
  }

  const isComplete = (path: string): boolean => existsSync(join(path, REPORT));

  function isMarked(path: string): boolean {
    try {
      return readFileSync(join(path, OWNER_MARK), 'utf8').includes('tycho-backup');
    } catch {
      return false;
    }
  }

  const taken = (name: string): Error => new Error(`备份目录里已有同名目录 ${name}，不是本程序的备份`);

  // Not created when missing: with the disk away, that would write to whatever is under
  // the mount point. Checked each time, since the directory can turn up later.
  function requireDir(): void {
    const problem = backupDirProblem(dataDir, dir);
    if (problem) throw new Error(problem);
    if (!existsSync(dir)) throw new Error(`备份目录不存在：${dir}`);
  }

  // Leftovers of a backup that did not finish. Synchronous so that nothing can start
  // between finding one and settling it; a backup calls this itself, so it never runs
  // while one is in progress.
  function repair(): void {
    requireDir();
    for (const name of readdirSync(dir)) {
      const [, day, kind] = LEFTOVER.exec(name) ?? [];
      if (!day || !isDay(day)) continue;
      const path = join(dir, name);
      if (!isComplete(path) && !isMarked(path)) {
        log(`备份目录里的 ${name} 不是本程序留下的，没有动它`);
        continue;
      }
      if (kind === 'old' && isComplete(path) && !existsSync(join(dir, day))) renameSync(path, join(dir, day));
      else rmSync(path, { recursive: true, force: true, maxRetries: RM_RETRIES });
    }
  }

  async function copyTree(from: string, to: string, path: string, tally: { files: number; failed: string[] }): Promise<void> {
    let entries;
    try {
      entries = await readdir(from, { withFileTypes: true });
      await mkdir(to, { recursive: true });
    } catch (err) {
      if (path === '' && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
      tally.failed.push(path || 'runs');
      return;
    }
    for (const entry of entries) {
      if (abandoned) return;
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      const relative = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await copyTree(source, target, relative, tally);
      } else if (entry.isFile()) {
        try {
          await (hooks.copyRun ?? copyFile)(source, target);
          tally.files += 1;
        } catch {
          tally.failed.push(relative);
        }
      }
    }
  }

  // What stands where today's backup goes and is not a backup of ours. After repair() any
  // .old still there is somebody else's, and it is only in the way of a replacement.
  function obstacle(day: string): string | undefined {
    const formal = join(dir, day);
    if (!existsSync(formal)) return undefined;
    if (!isComplete(formal)) return day;
    return existsSync(`${formal}.old`) ? `${day}.old` : undefined;
  }

  async function install(day: string, partial: string): Promise<void> {
    const formal = join(dir, day);
    const old = `${formal}.old`;
    // Asked again here, where the move happens: the copying before it can take long.
    const blocked = obstacle(day);
    if (blocked) throw taken(blocked);
    const replacing = existsSync(formal);
    if (replacing) {
      await rename(formal, old);
      await hooks.afterPark?.();
    }
    try {
      await rename(partial, formal);
    } catch (err) {
      if (replacing) await rename(old, formal);
      throw err;
    }
    if (!replacing) return;
    await rm(old, { recursive: true, force: true, maxRetries: RM_RETRIES }).catch((err: unknown) => {
      log(`旧备份 ${old} 删不掉：${String(err)}`);
    });
  }

  async function backUp(day: string, at: string): Promise<BackupReport> {
    repair();
    const partial = join(dir, `${day}.partial`);
    const blocked = existsSync(partial) ? `${day}.partial` : obstacle(day);
    if (blocked) throw taken(blocked);
    await mkdir(partial);
    await writeFile(join(partial, OWNER_MARK), OWNER_TEXT);
    const file = join(partial, 'ledger.db');
    // Its own connection: the ledger's can be reopened at any time on leaving degraded mode.
    // The service is running and writing the ledger meanwhile, so this is a plain read-only
    // connection that holds SQLite's locks and read marks (not openStoppedLedger, which is
    // only for a ledger nobody writes).
    const source = new DatabaseSync(join(dataDir, 'ledger.db'), { readOnly: true });
    try {
      await backup(source, file, { rate: ALL_PAGES });
    } finally {
      source.close();
    }
    await hooks.afterLedger?.(file);
    let settings;
    try {
      settings = verifySnapshot(file);
    } catch (err) {
      throw new Error(`备份出来的账本校验不过：${(err as Error).message}`);
    }
    // Asked of the copy, which is what would be published: the live connection may be
    // unable to say, and a ledger not yet confirmed must not replace the day's good backup.
    if (settings.has(RESTORE_SETTING)) throw new Error('账本处于恢复待确认状态，这次的副本不能当备份');
    const tally = { files: 0, failed: [] as string[] };
    await copyTree(join(dataDir, 'runs'), join(partial, 'runs'), '', tally);
    if (tally.failed.length > 0) log(`备份的日志副本不完整：${tally.failed.length} 个文件没复制下来`);
    const report: BackupReport = {
      at,
      ledger_bytes: statSync(file).size,
      runs_files: tally.files,
      runs_incomplete: tally.failed.slice(0, MAX_INCOMPLETE),
      tool: 'backup',
    };
    await writeFile(join(partial, REPORT), JSON.stringify(report, null, 2));
    await hooks.beforeInstall?.();
    if (abandoned) throw new Error('服务停止，备份没有做完');
    await install(day, partial);
    return report;
  }

  async function prune(now: Date): Promise<void> {
    const cutoff = dayName(new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays));
    const remove = hooks.removeExpired ?? ((path: string) => rm(path, { recursive: true, force: true, maxRetries: RM_RETRIES }));
    // The newest stays whatever its age: an old backup beats having none.
    for (const { name } of completed().slice(1)) {
      if (name >= cutoff) continue;
      await remove(join(dir, name)).catch((err: unknown) => {
        log(`过期备份 ${name} 删不掉：${String(err)}`);
      });
    }
  }

  function failed(at: string, err: unknown): BackupResult {
    const text = err instanceof Error ? err.message : String(err);
    if (abandoned) return { ok: false, at, error: text };
    log(`备份失败：${text}`);
    const wasFailing = lastError !== null;
    lastError = { at, text };
    if (!wasFailing) {
      try {
        onFailure?.(text, completed()[0]?.report.at ?? null, at);
      } catch (notifyError) {
        log(`备份失败通知没发出去：${String(notifyError)}`);
      }
    }
    return { ok: false, at, error: text };
  }

  async function execute(): Promise<BackupResult> {
    const now = new Date(clock.now());
    const at = now.toISOString();
    const day = dayName(now);
    try {
      const report = await backUp(day, at);
      lastError = null;
      await prune(now);
      log(`备份完成：${join(dir, day)}`);
      return { ok: true, ...report };
    } catch (err) {
      return failed(at, err);
    }
  }

  function begin(): Promise<BackupResult> {
    current = execute().finally(() => {
      current = undefined;
      reconfigure();
    });
    return current;
  }

  function refusal(): string | null {
    if (!dir) return '没有配置自动备份';
    if (closed) return '服务正在停止，不能备份';
    if (recovering()) return '正在恢复清点，暂时不能备份';
    try {
      if (ledger.getRestore()) return '账本是从备份恢复的，还没确认清点，这时备份会盖掉当天的好备份；确认清点后再备份';
    } catch {
      // Unknown, not absent: the attempt goes ahead, and the copy it makes answers.
    }
    return null;
  }

  function schedule(after: number): void {
    clock.clearTimer(timer);
    if (closed || !dir) return;
    const target = nextMoment(after);
    timer = clock.setTimer(() => void fire(target), Math.max(0, target - clock.now()));
  }

  async function fire(target: number): Promise<void> {
    const skip = current ? null : refusal();
    if (skip) log(`跳过这次定时备份：${skip}`);
    else await (current ?? begin());
    schedule(Math.max(target, clock.now()));
  }

  async function catchUp(): Promise<void> {
    if (current || refusal()) return;
    const latest = completed()[0];
    if (latest && Date.parse(latest.report.at) >= lastMoment(clock.now())) return;
    await begin();
  }

  async function open(): Promise<void> {
    schedule(clock.now());
    if (!dir) return;
    // A backup already running has done this, and its .partial is no leftover. A
    // failure counts as a failed backup: the catch-up may be held back and never say it.
    if (!current) {
      try {
        repair();
      } catch (err) {
        failed(new Date(clock.now()).toISOString(), err);
      }
    }
    log(`备份目录 ${dir}，每天 ${time}，上次成功：${completed()[0]?.report.at ?? '从未'}`);
    await catchUp();
  }

  // A backup in progress keeps what it started with, so that its .partial and its rename
  // land in one directory. It comes back here when it ends.
  function reconfigure(): void {
    if (current || closed) return;
    const { dir: oldDir, at: oldTime } = { dir, at: time };
    ({ dir, at: time, keepDays } = config());
    if (!opened) return;
    if (dir !== oldDir) void open();
    else if (time !== oldTime) schedule(clock.now());
  }

  return {
    async start(): Promise<void> {
      reconfigure();
      opened = true;
      await open();
    },

    catchUp,

    reconfigure,

    // Waits for the outcome: a backup that failed is an answer, one refused is an error.
    trigger(): Promise<BackupResult> {
      if (current) return current;
      const reason = refusal();
      if (reason) throw new InputError(reason);
      return begin();
    },

    status(): BackupView {
      if (!dir) return { configured: false };
      const latest = completed()[0]?.report;
      return {
        configured: true,
        dir,
        at: time,
        last_ok_at: latest?.at ?? null,
        last_ok_incomplete: (latest?.runs_incomplete.length ?? 0) > 0,
        last_error: lastError,
        running: current !== undefined,
      };
    },

    // Takes effect before its first await. A backup that outlasts the wait stops short of
    // the rename and leaves its .partial, which the next one clears.
    async stop(waitMs: number): Promise<boolean> {
      closed = true;
      clock.clearTimer(timer);
      if (!current) return true;
      const finished = await Promise.race([current.then(() => true), sleep(waitMs, false, { ref: false })]);
      if (!finished) {
        abandoned = true;
        log(`备份 ${waitMs} 毫秒内没有做完，不再等`);
      }
      return finished;
    },
  };
}

export type Backups = ReturnType<typeof createBackups>;
