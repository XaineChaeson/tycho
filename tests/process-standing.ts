// Whether a process a test started is gone, told three ways apart: it has exited; the pid now
// names another process (a different start); or the system cannot say. Only the first two are
// "gone". A pid whose start was never recorded, or whose start cannot be read while it is
// alive, is unverifiable, and a test that asserts a process was reclaimed does not pass on it.
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive, processStartLater } from '../service/lock.ts';

export type Standing = 'exited' | 'other' | 'unverifiable' | 'ours';

export async function standing(pid: number, start: string | undefined): Promise<Standing> {
  if (!isAlive(pid)) return 'exited';
  if (start === undefined) return 'unverifiable';
  const now = await processStartLater(pid);
  if (now === undefined) return isAlive(pid) ? 'unverifiable' : 'exited';
  return now === start ? 'ours' : 'other';
}

export const gone = (found: Standing): boolean => found === 'exited' || found === 'other';

// Looks until the process is gone or the time is up, and says what it last found.
export async function settle(pid: number, start: string | undefined, withinMs = 15_000): Promise<Standing> {
  const until = Date.now() + withinMs;
  for (;;) {
    const found = await standing(pid, start);
    if (gone(found) || Date.now() >= until) return found;
    await sleep(200);
  }
}
