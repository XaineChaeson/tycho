import { appendFileSync } from 'node:fs';
import type { Db } from './db.ts';
import { nowIso, RollbackError } from './db.ts';
import { DegradedError } from './errors.ts';
import { ulid } from './ids.ts';

const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;

function isIoError(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof code !== 'number') return false;
  // Extended result codes keep the primary code in the low byte.
  const primary = code & 0xff;
  return primary === SQLITE_READONLY || primary === SQLITE_IOERR || primary === SQLITE_FULL;
}

export interface Degraded {
  isActive(): boolean;
  assertHealthy(): void;
  write<T>(fn: () => T): T;
  recover(): boolean;
}

// What the ledger's own barriers are, as dispatchConditions() reports them.
export interface Barriers {
  degraded: boolean;
  recovering: boolean;
}

// The one rule for a control operation that acts on the world outside the ledger: it waits
// for writes to work and for the inventory to be over. Everything that does such an act
// asks this, at the moment of asking and again after any wait it took on the way.
export function assertSteady({ degraded, recovering }: Barriers, what: string): void {
  if (degraded) throw new DegradedError(`账本写入失败，服务处于降级模式，现在不能${what}`);
  if (recovering) throw new DegradedError(`服务正在恢复清点，现在不能${what}`);
}

export function createDegraded(db: Db, logPath: string): Degraded {
  let active = false;

  function log(line: string): void {
    // The disk that failed the database may also fail this write; degraded mode
    // must still engage, so stderr is the last resort.
    try {
      appendFileSync(logPath, `${nowIso()} ${line}\n`);
    } catch (err) {
      console.error('degraded.log 写入失败', err, line);
    }
  }

  function assertHealthy(): void {
    if (active) throw new DegradedError('数据库写入失败，服务处于降级模式');
  }

  return {
    isActive: () => active,
    assertHealthy,

    write<T>(fn: () => T): T {
      assertHealthy();
      try {
        return db.transaction(fn);
      } catch (err) {
        if (!(err instanceof RollbackError) && !isIoError(err)) throw err;
        active = true;
        log(`进入降级：${String(err)}`);
        throw new DegradedError('数据库写入失败，服务已进入降级模式', { cause: err });
      }
    },

    recover(): boolean {
      if (!active) return true;
      try {
        db.reopen();
        db.transaction(() => {
          db.run(
            `INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, 'degraded.probe', ?)
             ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
            ulid(),
            nowIso(),
            JSON.stringify(nowIso()),
          );
        });
      } catch (err) {
        log(`探测写入失败：${String(err)}`);
        return false;
      }
      active = false;
      log('探测写入成功，解除降级');
      return true;
    },
  };
}
