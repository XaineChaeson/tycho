// Only an OS transaction mutex: this sidecar stores no knowledge or publication ownership.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const APPLICATION = 0x54594348;
const busy = (error: unknown): boolean => [5, 6].includes((error as { errcode?: number }).errcode ?? -1);
export type EntryMutexResult<T> = { state: 'done'; value: T } | { state: 'busy' | 'unavailable'; problem: string };

export function withEntryMutex<T>(profile: string, work: () => T): EntryMutexResult<T> {
  const file = join(profile, '.tycho-entry-mutex.sqlite');
  let db: DatabaseSync | undefined;
  let began = false;
  let enteredWork = false;
  try {
    if (lstatSync(file, { throwIfNoEntry: false }) === undefined) {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      let fresh: DatabaseSync | undefined;
      let created = false;
      try {
        writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 }); created = true;
        fresh = new DatabaseSync(temporary);
        fresh.exec(`PRAGMA application_id=${APPLICATION}; PRAGMA user_version=1;`);
        fresh.close(); fresh = undefined;
        try { linkSync(temporary, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally {
        fresh?.close();
        if (created) { rmSync(temporary, { force: true }); rmSync(temporary + '-journal', { force: true }); }
      }
    }
    const held = lstatSync(file);
    if (!held.isFile() || held.size < 100 || held.size > 65536) throw new Error('协调文件不是可核实的普通 SQLite 文件');
    const header = readFileSync(file);
    if (header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header.readInt32BE(68) !== APPLICATION || header.readInt32BE(60) !== 1) throw new Error('协调文件不属于此投影协议或版本不支持');
    // All live connections use the final canonical name. The temporary database is cold
    // before publication. An interrupted publication can leave a cold temporary alias;
    // no participant opens that alias, and it is not removed or used for lock ownership.
    const canonical = realpathSync.native(file);
    const inspection = new DatabaseSync(canonical, { readOnly: true });
    try { inspection.exec('PRAGMA busy_timeout=0'); if (inspection.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('协调文件损坏'); }
    finally { inspection.close(); }
    db = new DatabaseSync(canonical);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); began = true;
    enteredWork = true;
    return { state: 'done', value: work() };
  } catch (error) {
    if (enteredWork) throw error;
    return busy(error) ? { state: 'busy', problem: `另一进程正在核对全局知识入口（协调文件 ${file}），本次未写入，下轮自动重看` }
      : { state: 'unavailable', problem: `不能安全协调全局知识入口，未改动投影。请先停止共享此原生目录的 Tycho 主机与客户端，核对本机协调文件 ${file} 的权限和来源，再由主人备份挪开后重试。程序对未知文件保留、不重建。原因：${(error as Error).message}` };
  } finally {
    try { if (began) db?.exec('ROLLBACK'); } finally { db?.close(); }
  }
}
