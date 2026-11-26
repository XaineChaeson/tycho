// What the installer put into a prefix and changed outside it. An uninstall undoes this
// list and nothing else: a directory's name is no proof of who made it, and an entry on
// PATH that was there before the installer came is not the installer's to remove.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Role } from './autostart.ts';
import { layoutOf } from './paths.ts';
import type { PathRecord } from './user-path.ts';

// One role's autostart as it was installed: the data directory it runs on, and the PATH of
// the terminal that installed it. An upgrade keeps each role's on what it had, whatever
// the terminal that runs the upgrade has in its environment.
interface AutostartSlot {
  dataDir: string;
  // No PATH on an autostart installed before it was kept, and on Windows, where the task
  // takes the user's.
  path?: string;
}

export interface InstallRecord {
  // Relative to the prefix, with forward slashes: version directories and single files.
  files: string[];
  // Each change made to the user's PATH; empty when the installer made none.
  paths: PathRecord[];
  // One slot per role: a computer that is both the host and a machine has two definitions,
  // installed from their own terminals, and neither's install, upgrade or uninstall touches
  // the other (docs/design/nodes.md §1.4, §7).
  autostart?: { host?: AutostartSlot; node?: AutostartSlot };
}

// The slots as the file holds them, one per role.
function readAutostart(value: unknown): InstallRecord['autostart'] {
  const held = value as { host?: unknown; node?: unknown } | undefined;
  if (held === undefined || held === null) return undefined;
  const slot = (raw: unknown): AutostartSlot | undefined => {
    const { dataDir, path } = (raw ?? {}) as { dataDir?: unknown; path?: unknown };
    return typeof dataDir === 'string'
      ? { dataDir, ...(typeof path === 'string' ? { path } : {}) }
      : undefined;
  };
  const host = slot(held.host);
  const node = slot(held.node);
  if (host === undefined && node === undefined) return undefined;
  return { ...(host === undefined ? {} : { host }), ...(node === undefined ? {} : { node }) };
}

// Null when there is none, or it cannot be read as one.
export function readRecord(prefix: string): InstallRecord | null {
  try {
    const { files, paths, autostart } = JSON.parse(readFileSync(layoutOf(prefix).record, 'utf8')) as Partial<InstallRecord>;
    if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) return null;
    const slots = readAutostart(autostart);
    return {
      files,
      paths: Array.isArray(paths) ? paths : [],
      ...(slots === undefined ? {} : { autostart: slots }),
    };
  } catch {
    return null;
  }
}

// The slot one role holds, or nothing when that role was never installed here.
export const slotOf = (record: InstallRecord | null, role: Role): AutostartSlot | undefined => record?.autostart?.[role];

// The record with one role's slot as given: the other role's is left exactly as it stands.
export function withSlot(record: InstallRecord, role: Role, slot: AutostartSlot | null): InstallRecord {
  const { autostart: _, ...rest } = record;
  const held = { ...(record.autostart ?? {}), ...(slot === null ? { [role]: undefined } : { [role]: slot }) };
  const kept = Object.fromEntries(Object.entries(held).filter(([, each]) => each !== undefined)) as InstallRecord['autostart'];
  return Object.keys(kept ?? {}).length === 0 ? rest : { ...rest, autostart: kept };
}

// Whole or not at all: a half-written record would make an uninstall leave things behind.
export function writeRecord(prefix: string, record: InstallRecord): void {
  const file = layoutOf(prefix).record;
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(partial, file);
}
