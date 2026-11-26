// Reading a few things out of a ledger file without opening it the way the service does.
// A release decides from these whether the ledger moved under it while it was being put
// in place, and whether any Router driver is still around: both questions are asked
// after the service that held the ledger has stopped, and neither may create, migrate or
// write anything. Before anything is stopped, a release also asks whether the ledger is a
// version it may go up from; then the service may be writing it. A file this cannot read
// is reported as unknown, never as unchanged.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openStoppedLedger } from './db.ts';

// Whether a writer may still have the ledger open, as the caller knows it. 'stopped': the
// service that held it is confirmed stopped, and nothing beside the file is written
// (openStoppedLedger). 'live': it may be running, so this reader takes part in SQLite's
// locking like any other reader: it holds a read mark, which keeps a checkpoint from moving
// the pages it is reading, and it may create the -shm and -wal as any connection does.
export type LedgerWriter = 'stopped' | 'live';

// One Router driver the ledger says may still be running. `pid` is display data; `marker`
// is what ownership rests on: the marker its processes carry, kept after its pid has been
// written as gone, so that a scan for what is left has something to look for.
export interface PeekedDriver {
  marker: string;
  pid: number | null;
}

export type LedgerPeek =
  // `version` is the schema version the ledger records; null when there is no ledger yet.
  // `routers`: every driver not yet confirmed gone (docs/design/project-sessions.md §3).
  | { known: true; version: number | null; routers: readonly PeekedDriver[] }
  // The file is there but could not be read: whoever asked must not conclude anything.
  | { known: false; error: string };

// The one open that has no policy of its own: no migration, no durability pragmas, no
// table list. A ledger too old or too new for the program reading it still answers here,
// which is the point — that difference is what the answer is about.
export function peekLedger(path: string, writer: LedgerWriter): LedgerPeek {
  // No file at all is not an error: a data directory that never held a ledger has no
  // version, which is a fact about it rather than something unknown.
  if (!existsSync(path)) return { known: true, version: null, routers: [] };
  let conn: DatabaseSync | undefined;
  try {
    conn = writer === 'stopped' ? openStoppedLedger(path) : new DatabaseSync(path, { readOnly: true });
    const stored = (conn.prepare(`SELECT value_json FROM setting WHERE key = 'schema_version'`).get() as { value_json: string } | undefined)?.value_json;
    const version = typeof stored === 'string' && /^\d+$/.test(stored) ? Number(stored) : null;
    const has = (table: string): boolean => conn!.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
    const pidOf = (pid: unknown): number | null => (Number.isInteger(pid) ? (pid as number) : null);
    let routers: PeekedDriver[] = [];
    if (has('router_context')) {
      // Each project's Router has its own contexts; any of them whose processes were not seen
      // gone, or that is still open, may still be running.
      routers = (conn.prepare(`SELECT marker, pid FROM router_context WHERE live_at IS NOT NULL OR state = 'open' ORDER BY rowid`).all() as { marker: string; pid: unknown }[])
        .filter(({ marker }) => typeof marker === 'string' && marker !== '')
        .map(({ marker, pid }) => ({ marker, pid: pidOf(pid) }));
    } else if (has('router_session')) {
      // A ledger from before every project had its own Router: only one session could be
      // open, and the newest row is the driver the service last had — with its marker still
      // there after a close or a pid that could not be cleared.
      const last = conn.prepare(`SELECT pid, marker, state FROM router_session ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get() as { pid: unknown; marker: string | null; state: string } | undefined;
      if (typeof last?.marker === 'string' && last.marker !== '') routers = [{ marker: last.marker, pid: last.state === 'open' ? pidOf(last.pid) : null }];
    }
    return { known: true, version, routers };
  } catch (err) {
    return { known: false, error: (err as Error).message };
  } finally {
    conn?.close();
  }
}
