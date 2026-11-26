// What a Run left for the host to take, and what the host made of the release it was
// asked to put in place. Every taking-over of a round's artifacts lands in a directory of
// its own, named by the registration the ledger then commits for it:
// <数据目录>/releases/<run>/<登记编号>/. The ledger's registration is the one authority over
// what a round handed back (docs/design/roles-and-tiers.md §9 第 3 步); the directory it
// names is never written again. Everything that reads a product starts from the
// registration and finds the files through it, so a directory no registration names — a
// taking that died before its commit, files in the older layout straight under
// releases/<run>/ — is not there for anybody. A directory a registration once named stays
// after a later taking replaces it: only the current one is read as the product, but
// review bindings and release records name the earlier ones, and an upgrade command started
// before the replacement may still be reading one. It stays until the work
// it belongs to ended and the retention period passed (service/retention.ts): then every
// directory in the round's own goes, and the ledger's mark on the round is what says it did.
// A git bundle among the files is a historical artifact of an older program: it is listed
// and served like any other registered file, and nothing makes a new one (code-sources.md §6).
// Loose files of the older layout straight under releases/<run>/ are not this layout's and stay.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HeldArtifacts, Registration } from './review.ts';

const RELEASES = 'releases';
export const releasesDir = (dataDir: string): string => join(dataDir, RELEASES);

// A Run id is a ULID the ledger made; one that would name another directory is refused
// rather than cleaned up, since it can only come from outside.
const SAFE_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
export const nameIsSafe = (name: string): boolean => SAFE_NAME.test(name) && name !== '.' && name !== '..';

// What a round may call a file it leaves for the host to take: a name every host's disk
// keeps as written — no separator, no character a disk refuses or rewrites, no trailing dot
// (Windows drops it), no device name (Windows opens the device instead, extension or not),
// and no longer than a file name may be. It is the artifact name's own rule, apart from
// nameIsSafe above, which is about ledger ids used as path segments; what is said to the
// owner and to executors (skills/tycho/release.md) is this rule as written here.
const ARTIFACT_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ARTIFACT_NAME_MAX_BYTES = 255;
export const ARTIFACT_NAME_RULE =
  '产物名只能用字母、数字和 . _ -，以字母或数字开头，不以点结尾，不能是 Windows 的设备名（CON、PRN、AUX、NUL、COM1–9、LPT1–9，带不带扩展名都算），不超过 255 字节';
export const artifactNameIsUsable = (name: string): boolean =>
  ARTIFACT_NAME.test(name) && !name.endsWith('.') && !WINDOWS_DEVICE.test(name) && Buffer.byteLength(name) <= ARTIFACT_NAME_MAX_BYTES;

// Where one registration's files are. A taking writes them under a name starting with
// INCOMING first, beside every round's directory, so that the move into place is one
// rename on the same disk.
export const registrationDir = (dataDir: string, runId: string, registrationId: string): string =>
  join(releasesDir(dataDir), runId, registrationId);
export const INCOMING = '.incoming-';

// `tycho-<版本>.tar.gz`, as the skill tells the executor to name it. The version has to
// be one a version directory could be named for.
const PACKAGE = /^tycho-([0-9A-Za-z][0-9A-Za-z.+-]*)\.tar\.gz$/;
export const isPackageName = (name: string): boolean => PACKAGE.test(name);

export interface ReleaseFile {
  name: string;
  sha256: string;
  bytes: number;
}

export interface ReleasePackage {
  run_id: string;
  task_id: string;
  at: string;
  file: string;
  version: string;
  bytes: number;
  sha256: string;
}

// One round's registered product, as the console lists it.
interface StoredRelease {
  run_id: string;
  task_id: string;
  at: string;
  registration: string;
  dir: string;
  files: ReleaseFile[];
  // When the retention rule cleared this round's copies on the host; null while they stand.
  // A cleared round is still listed, with what it registered, but offers no file.
  dropped_at: string | null;
  // The release packages among its files, with the version each one carries.
  packages: (Omit<ReleasePackage, 'run_id' | 'task_id' | 'at'>)[];
}

// The directory of what a round holds registered, or null when it holds none — and when the
// retention rule cleared it, so that every reader of the bytes treats it as not there.
function located(dataDir: string, held: HeldArtifacts | undefined): { dir: string; registration: Registration } | null {
  const registration = held?.registration ?? null;
  if (!held || held.releases_dropped_at !== null || registration === null || !nameIsSafe(held.run_id) || !nameIsSafe(registration.id)) return null;
  return { dir: registrationDir(dataDir, held.run_id, registration.id), registration };
}

// The registered products of a Task's rounds, newest first, from what the ledger holds of
// them. A file that is not where its registration put it is not offered; a round the
// retention rule cleared is listed with nothing to offer.
export function releasesOf(dataDir: string, held: readonly HeldArtifacts[]): StoredRelease[] {
  const found: StoredRelease[] = [];
  for (const each of held) {
    const registration = each.registration;
    // A cleared round still says what it registered, so the page can say it was cleared;
    // nothing of it is read or offered.
    if (each.releases_dropped_at !== null) {
      if (registration === null || !nameIsSafe(each.run_id) || !nameIsSafe(registration.id)) continue;
      const files = registration.files.filter((file) => nameIsSafe(file.name));
      found.push({
        run_id: each.run_id, task_id: each.task_id, at: registration.at, registration: registration.id,
        dir: registrationDir(dataDir, each.run_id, registration.id), files, packages: [],
        dropped_at: each.releases_dropped_at,
      });
      continue;
    }
    const at = located(dataDir, each);
    if (at === null) continue;
    const { dir, registration: whole } = at;
    const files = whole.files.filter((file) => nameIsSafe(file.name));
    const present = files.filter((file) => existsSync(join(dir, file.name)));
    const packages = [];
    for (const file of present) {
      const parsed = PACKAGE.exec(file.name);
      if (parsed) packages.push({ file: file.name, version: parsed[1]!, bytes: file.bytes, sha256: file.sha256 });
    }
    found.push({ run_id: each.run_id, task_id: each.task_id, at: whole.at, registration: whole.id, dir, files, packages, dropped_at: null });
  }
  return found.sort((a, b) => b.at.localeCompare(a.at));
}

// Whether bytes are the ones a digest and a size name: the one rule for a file sent to a
// machine, one taken back from it, and one read again from where its registration put it.
export const sameBytes = (body: Buffer, want: { sha256: string; bytes: number }): boolean =>
  body.length === want.bytes && createHash('sha256').update(body).digest('hex') === want.sha256;

// A file of a round's registered product, by name, digest and size, hashed again as it is
// now: what a launch starts on, and how a registered file is read from where the
// registration put it. Null when the registration does not hold it, or the bytes where it
// put them are no longer those.
export function registeredFile(dataDir: string, held: HeldArtifacts | undefined, chosen: ReleaseFile): string | null {
  const at = located(dataDir, held);
  if (at === null || !nameIsSafe(chosen.name)) return null;
  if (!at.registration.files.some((each) => each.name === chosen.name && each.sha256 === chosen.sha256 && each.bytes === chosen.bytes)) return null;
  const file = join(at.dir, chosen.name);
  try {
    return sameBytes(readFileSync(file), chosen) ? file : null;
  } catch {
    return null;
  }
}

// What the owner confirmed, as a release package of the round's registered product: the
// name, digest and size the console showed have to be the ones the registration holds,
// and the file has to still hash to that digest. Anything else is not what was approved,
// and nothing is started for it.
export function registeredPackage(dataDir: string, held: HeldArtifacts | undefined, chosen: ReleaseFile): { file: string; name: string; version: string; bytes: number; sha256: string } | null {
  const parsed = PACKAGE.exec(chosen.name);
  if (!parsed) return null;
  const file = registeredFile(dataDir, held, chosen);
  return file === null ? null : { file, name: chosen.name, version: parsed[1]!, bytes: chosen.bytes, sha256: chosen.sha256 };
}

// Removes one directory best-effort, saying whether it is gone afterwards: a removal that
// throws, or that leaves what it was given still there, is a directory that is still there.
// Exported, and injectable into `sweepReleases` below, so that a test can make one directory
// refuse and see the others still go.
export function removeDirNow(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return !existsSync(path);
  } catch {
    return false;
  }
}

// One round of a project that is gone, as its cleanup row names it: the Run row is gone too,
// so the registrations are what says which directories on the host are its.
export interface DeletedRound {
  cleanup_id: string;
  run_id: string;
  registrations: readonly string[];
}

// Takes away what no registration ever named: a taking's directory under INCOMING that no
// taking is writing any more (`busy` are the ones still being written), and a directory
// inside a round's own that none of its registrations named. A round the retention rule
// cleared (service/retention.ts) loses every directory in it, registered or not, and its own
// directory only when that leaves it empty. Loose files of the older layout are not this
// layout's and are left alone, as AGENTS.md says of the old layout; a directory of a Run the
// ledger does not know is left alone too.
//
// `deleted` are the rounds of deleted projects, whose Run rows the ledger no longer holds:
// their cleanup row names the registration directories until they are gone. Each one is
// removed on its own, so a removal that fails leaves the others — and the ordinary pass
// below — to go on; a name that would not be a path segment names no directory, so it is
// skipped rather than counted as a failure (as the old sweep here did). A round whose own
// run_id cannot name a path segment is left alone and not confirmed either: it can only come
// from outside. The row is confirmed — pushed into `cleared` — only when every registration
// of it is really gone, a directory that is already gone counting as gone.
//
// `removeDir` is the removal of one directory, replaceable by a test so that one directory
// refuses and the rest still go; it defaults to the real one above.
//
// Best effort: what cannot be removed now is tried again next time. Returns what it removed
// and which cleanup rows it confirmed.
export function sweepReleases(
  dataDir: string,
  heldOf: (runId: string) => HeldArtifacts | undefined,
  busy: ReadonlySet<string>,
  deleted: readonly DeletedRound[] = [],
  removeDir: (path: string) => boolean = removeDirNow,
): { removed: string[]; cleared: string[] } {
  const root = releasesDir(dataDir);
  const removed: string[] = [];
  const cleared: string[] = [];
  const remove = (path: string): boolean => {
    if (busy.has(path)) return false;
    if (!removeDir(path)) return false;
    removed.push(path);
    return true;
  };
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const isDir = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  // A deleted project's rounds first: their Run rows are gone, so the pass below cannot know
  // them, and the cleanup row is what names their directories.
  for (const { cleanup_id: cleanupId, run_id: runId, registrations } of deleted) {
    // A run id that would name another directory is refused rather than cleaned up, since it
    // can only come from outside; its row is left for whoever wrote it.
    if (!nameIsSafe(runId)) continue;
    const round = join(root, runId);
    let whole = true;
    for (const registration of registrations) {
      if (!nameIsSafe(registration)) continue;
      if (!remove(join(round, registration))) whole = false;
    }
    // The round's own directory goes only when that left it empty; loose files of an older
    // layout are not this layout's and stay.
    if (list(round).length === 0 && !busy.has(round)) {
      try {
        rmdirSync(round);
        removed.push(round);
      } catch {
        // Not empty, or already gone: either way there is nothing more to remove.
      }
    }
    if (whole) cleared.push(cleanupId);
  }
  for (const name of list(root)) {
    const path = join(root, name);
    if (name.startsWith(INCOMING)) {
      remove(path);
      continue;
    }
    if (!nameIsSafe(name) || !isDir(path)) continue;
    const held = heldOf(name);
    if (held === undefined) continue;
    if (held.releases_dropped_at !== null) {
      // Every directory in it: the ones its registrations named, and any no registration named
      // (which the rule below takes from a round not cleared anyway). Loose files of the older
      // layout are not directories and stay.
      for (const entry of list(path)) {
        const each = join(path, entry);
        if (isDir(each)) remove(each);
      }
      // The round's own directory goes only when the removal left it empty; a non-recursive
      // rmdir is what makes that check, and a loose file of the older layout keeps it.
      if (!busy.has(path) && list(path).length === 0) {
        try {
          rmdirSync(path);
          removed.push(path);
        } catch {
          // Left for the next sweep.
        }
      }
      continue;
    }
    for (const entry of list(path)) {
      const each = join(path, entry);
      if (!held.registered.includes(entry) && entry !== held.registration?.id && isDir(each)) remove(each);
    }
  }
  return { removed, cleared };
}

// ---- The release the owner asked for ----

// One release attempt as the console asked for it. Written when the request is accepted,
// and read back by the console while the service is up, so a click that started nothing
// (or an attempt that never reported) does not look like one that did.
export interface ReleaseIntent {
  at: string;
  run_id: string;
  // The file name the console confirmed, with the digest and size it showed.
  name: string;
  version: string;
  sha256: string;
  bytes: number;
  // Where that file is on this machine: what the upgrade command is started on.
  file: string;
}

const releaseIntentFile = (dataDir: string): string => join(dataDir, 'release-intent.json');

export function readReleaseIntent(dataDir: string): ReleaseIntent | null {
  try {
    const { at, run_id, name, version, sha256, bytes, file } = JSON.parse(readFileSync(releaseIntentFile(dataDir), 'utf8')) as Partial<ReleaseIntent>;
    const texts = [at, run_id, name, version, sha256, file];
    if (texts.some((each) => typeof each !== 'string') || !Number.isInteger(bytes) || !nameIsSafe(name as string)) return null;
    return { at: at as string, run_id: run_id as string, name: name as string, version: version as string, sha256: sha256 as string, bytes: bytes as number, file: file as string };
  } catch {
    return null;
  }
}

export function writeReleaseIntent(dataDir: string, intent: ReleaseIntent): void {
  const file = releaseIntentFile(dataDir);
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(intent, null, 2)}\n`);
  renameSync(partial, file);
}

// ---- What the last launch ended as ----

export interface ReleaseResult {
  at: string;
  from: string | null;
  to: string;
  // A completed health verdict, whether passed or failed. Recovery still in progress
  // leaves this false; pending names what remains after the candidate started.
  verified: boolean;
  pending?: string[];
  ok: boolean;
  // True when the version in use was put back to `from` because the new one failed its
  // own health check.
  rolled_back: boolean;
  // What the program directory's `current` names after the attempt: the version that was
  // installed, or the one it went back to. Null when it cannot be read.
  in_use: string | null;
  // What the command said, one line each: the page shows them as they are.
  lines: string[];
}

const releaseResultFile = (dataDir: string): string => join(dataDir, 'release.json');

export function readReleaseResult(dataDir: string): ReleaseResult | null {
  try {
    const { at, from, to, verified, ok, pending, rolled_back, in_use, lines } = JSON.parse(readFileSync(releaseResultFile(dataDir), 'utf8')) as Partial<ReleaseResult>;
    if (typeof at !== 'string' || typeof to !== 'string' || typeof verified !== 'boolean' || typeof ok !== 'boolean' || typeof rolled_back !== 'boolean') return null;
    return {
      at,
      from: typeof from === 'string' ? from : null,
      to,
      verified,
      ...(Array.isArray(pending) && pending.length > 0 && pending.every((step) => typeof step === 'string') ? { pending } : {}),
      ok,
      rolled_back,
      in_use: typeof in_use === 'string' ? in_use : null,
      lines: Array.isArray(lines) ? lines.filter((line) => typeof line === 'string') : [],
    };
  } catch {
    return null;
  }
}

export function writeReleaseResult(dataDir: string, result: ReleaseResult): void {
  const file = releaseResultFile(dataDir);
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(partial, file);
}
