// `npm run restore -- --from <备份文件或目录>`. §2: an old backup cannot say what happened
// after it was taken, so it goes into place stopped. The sealed copy replaces the ledger
// in one rename, and from then on any start finds a paused ledger with nothing pending.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { dataDirFromEnv, lockFile } from './config.ts';
import { isEntry } from './entry.ts';
import { verifySnapshot } from './db.ts';
import type { RestoreCounts } from './ledger.ts';
import { openLedger } from './ledger.ts';
import { acquireLock } from './lock.ts';

const SIDE_FILES = ['-wal', '-shm'];

const log = (line: string): void => console.error(line);

export interface RestoreHooks {
  // Crash injection, on either side of the replacement.
  beforeReplace?: () => void;
  afterReplace?: () => void;
}

interface RestoreResult extends RestoreCounts {
  kept: string | null;
}

function backupFile(from: string): string {
  const file = statSync(from, { throwIfNoEntry: false })?.isDirectory() ? join(from, 'ledger.db') : from;
  if (!existsSync(file)) throw new Error(`找不到备份：${file}`);
  return file;
}

function copyWithSides(source: string, target: string): void {
  copyFileSync(source, target);
  for (const side of SIDE_FILES) {
    if (existsSync(source + side)) copyFileSync(source + side, target + side);
  }
}

function removeWithSides(file: string): void {
  for (const side of ['', ...SIDE_FILES]) rmSync(file + side, { force: true });
}

// Closing the last connection also removes the -wal, so the file stands alone.
function checkpoint(file: string): void {
  const conn = new DatabaseSync(file);
  try {
    conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    conn.close();
  }
}

// Judged on the working copy, after its -wal is merged in: a backup copied by hand can
// have its commits there, and opening the input itself would write beside it. This comes
// before openLedger, which would build a new ledger in a file that has no tables.
function prepare(source: string, prepared: string): void {
  removeWithSides(prepared);
  copyWithSides(source, prepared);
  try {
    checkpoint(prepared);
    verifySnapshot(prepared);
  } catch (err) {
    removeWithSides(prepared);
    throw new Error(`${source} 不能用来恢复：${(err as Error).message}`);
  }
}

// An older backup is upgraded here, in the working copy. The backup itself is what there
// was before the upgrade, so no second copy of it is kept in the data directory.
function seal(prepared: string, from: string): RestoreCounts {
  const ledger = openLedger(prepared, { copyBeforeUpgrade: false, sealRestore: true });
  try {
    return ledger.sealRestore(from);
  } finally {
    ledger.close();
  }
}

// Not two renames: between them there would be no ledger.db, and the next start would
// create an empty ledger. The copy comes first and takes the files as they are, since
// opening a damaged ledger can discard its -wal. Merging then keeps a crash from leaving
// the ledger short of commits, and the -wal must go, or SQLite would replay it onto the
// restored file.
function replace(current: string, prepared: string): string | null {
  let kept: string | null = null;
  if (existsSync(current)) {
    kept = current.replace(/ledger\.db$/, `ledger.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    copyWithSides(current, kept);
    try {
      checkpoint(current);
    } catch (err) {
      log(`现有账本合并日志失败，副本已原样保留：${String(err)}`);
    }
    for (const side of SIDE_FILES) rmSync(current + side, { force: true });
  }
  renameSync(prepared, current);
  return kept;
}

export function restoreBackup(dataDir: string, from: string, hooks: RestoreHooks = {}): RestoreResult {
  const source = backupFile(from);
  // A restore onto a new machine starts from nothing, as a first start does.
  mkdirSync(dataDir, { recursive: true });
  const lock = lockFile(dataDir);
  acquireLock(lock, log);
  try {
    const current = join(dataDir, 'ledger.db');
    const prepared = join(dataDir, 'ledger.restoring.db');
    prepare(source, prepared);
    const counts = seal(prepared, from);
    hooks.beforeReplace?.();
    const kept = replace(current, prepared);
    hooks.afterReplace?.();
    return { ...counts, kept };
  } finally {
    rmSync(lock, { force: true });
  }
}

function main(): void {
  const { from } = parseArgs({ options: { from: { type: 'string' } } }).values;
  if (!from) throw new Error('用法：npm run restore -- --from <备份文件或目录>');
  const result = restoreBackup(dataDirFromEnv(), from);
  console.log(`已恢复：${from}（备份时间 ${result.backup_at ?? '未知'}）`);
  if (result.kept) console.log(`原账本保留在 ${result.kept}`);
  console.log(`未结束的 Run：${result.active_runs} 个`);
  console.log(`被停住的任务：${result.held_tasks} 个`);
  console.log(`置为待核实的消息：${result.unverified_messages} 条`);
  console.log(`停止重试的通知：${result.given_up_notifications} 条`);
  console.log('派发已暂停。启动服务后在总览里逐项确认。');
}

if (isEntry(import.meta.filename)) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
