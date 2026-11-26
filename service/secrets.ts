// Secrets stay out of the ledger: the ledger is what a backup carries away. Each is a
// file under <data>/secrets that only the user the service runs as can read. Nothing
// here is ever handed to a page, a change row or a log: callers get "set or not", and
// the one module that signs in with it gets the value.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { InputError } from './errors.ts';

const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const MAX_SECRET_CHARS = 500;

// The directory a account's token files live in. One file per number the ledger names.
export const accountsSecretDir = (dataDir: string): string => join(dataDir, 'secrets', 'accounts');

// An account's token file, named by the number the ledger holds for it. The name is a
// number this program made up, so no account name ever becomes a path: case-insensitive
// file systems and names that are special to one of them cannot make two files one.
export function accountCredentialFile(dataDir: string, ref: string): string {
  return join(accountsSecretDir(dataDir), ref);
}

export const wecomSecretFile = (dataDir: string): string => join(dataDir, 'secrets', 'wecom');
export const githubSecretFile = (dataDir: string): string => join(dataDir, 'secrets', 'github');
export const passphraseSecretFile = (dataDir: string): string => join(dataDir, 'secrets', 'passphrase');

// Windows keeps no mode bits: access is the file's ACL, inherited from wherever the data
// directory was put. So inheritance is cut and the one entry left is this user's.
function restrictToUser(path: string, descendants = false): void {
  if (process.platform !== 'win32') return;
  const { USERDOMAIN: domain, USERNAME: name = userInfo().username } = process.env;
  // By its place in the system, not by PATH: a service started with a bare PATH (an
  // autostart, a test's child) still has to narrow its token files before writing them.
  const icacls = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const access = descendants ? '(OI)(CI)F' : 'F';
  execFileSync(icacls, [path, '/inheritance:r', '/grant:r', `${domain ? `${domain}\\` : ''}${name}:${access}`], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

export function prepareOwnerOnlyDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  chmodSync(dir, OWNER_ONLY_DIR);
  restrictToUser(dir, true);
}

// Empty when none is set.
export function readSecret(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

// A Secret is replaced in steps, because no rollback of the ledger reaches a file: the
// new one is checked and written beside the old as a draft, whatever the ledger keeps of
// the change is committed, and only then is the draft moved into place. A step that
// fails ends with the draft gone and the old Secret still the one in force. A draft found
// at a start is from a process that died in between; it never took effect, and is
// discarded.
const draftOf = (file: string): string => `${file}.new`;

// The reason may quote a path, never the Secret: it was not part of any command.
const notStored = (err: unknown): Error => new Error(`Secret 没有存下来：${(err as Error).message}`);

// What a Secret may be: one stretch of text with no blank in it, and not too long. Asked here
// by whoever has to know before handing one over (a login that read a token off a screen),
// so the rule is this one and not a copy of it.
export function secretProblem(secret: unknown, maxChars: number = MAX_SECRET_CHARS): string | null {
  if (typeof secret !== 'string' || secret.trim() === '') return 'Secret 不能为空';
  const value = secret.trim();
  if (value.length > maxChars || /\s/.test(value)) return 'Secret 应为一段不含空白的文字';
  return null;
}

// Narrowed before the Secret is in it: the draft is never a file others can open.
function prepareSecret(file: string, secret: unknown, maxChars: number = MAX_SECRET_CHARS): void {
  const problem = secretProblem(secret, maxChars);
  if (problem !== null) throw new InputError(problem);
  const value = (secret as string).trim();
  mkdirSync(dirname(file), { recursive: true, mode: OWNER_ONLY_DIR });
  const draft = draftOf(file);
  rmSync(draft, { force: true });
  try {
    writeFileSync(draft, '', { mode: OWNER_ONLY_FILE, flag: 'wx' });
    chmodSync(draft, OWNER_ONLY_FILE);
    restrictToUser(draft);
    writeFileSync(draft, `${value}\n`);
  } catch (err) {
    rmSync(draft, { force: true });
    throw notStored(err);
  }
}

// Moved into place whole: a reader finds the old Secret or the new one.
function placeSecret(file: string, rename: typeof renameSync): void {
  try {
    rename(draftOf(file), file);
  } catch (err) {
    discardSecret(file);
    throw notStored(err);
  }
}

// True when there was a draft to remove.
export function discardSecret(file: string): boolean {
  const draft = draftOf(file);
  const found = existsSync(draft);
  rmSync(draft, { force: true });
  return found;
}

export function removeSecret(file: string): void {
  rmSync(file, { force: true });
  discardSecret(file);
}

// The whole order, for a Secret whose replacement the ledger records: `record` commits
// that record, and what it throws leaves the old Secret in force. `rename` is for tests.
export function replaceSecret(file: string, secret: unknown, record: () => void, rename: typeof renameSync = renameSync): void {
  prepareSecret(file, secret);
  try {
    record();
  } catch (err) {
    discardSecret(file);
    throw err;
  }
  placeSecret(file, rename);
}

// A file that holds a token this machine's own processes use (service.json, login-token):
// narrowed before the token is in it, then moved into place whole, as a Secret is. The
// local join takes "can read service.json" as "is the user running the host" (nodes.md
// §1.1 step 2), so a file left readable to others would let them in; one that cannot be
// narrowed is not written.
export function writeOwnerOnly(file: string, content: string): void {
  const draft = draftOf(file);
  rmSync(draft, { force: true });
  try {
    writeFileSync(draft, '', { mode: OWNER_ONLY_FILE, flag: 'wx' });
    chmodSync(draft, OWNER_ONLY_FILE);
    restrictToUser(draft);
    writeFileSync(draft, content);
    renameSync(draft, file);
  } catch (err) {
    rmSync(draft, { force: true });
    throw new Error(`${file} 没有写下来：${(err as Error).message}`, { cause: err });
  }
}

// For a caller that commits the ledger after the file is in place. The file is written
// whole, under a name nobody has named yet; the caller's commit is what gives it a user.
// A crash before that commit leaves a file nothing refers to, which a start removes.
export function putSecret(file: string, secret: unknown, rename: typeof renameSync = renameSync, maxChars: number = MAX_SECRET_CHARS): void {
  prepareSecret(file, secret, maxChars);
  placeSecret(file, rename);
}

// A knowledge MCP client's token, by the id the ledger gave the client
// (docs/design/knowledge-and-skills.md §4.3). The ledger holds only its hash.
const knowledgeSecretDir = (dataDir: string): string => join(dataDir, 'secrets', 'knowledge');

export function knowledgeTokenStore(dataDir: string): { save(id: string, token: string): void; read(id: string): string; remove(id: string): void } {
  const file = (id: string): string => {
    if (!/^[0-9A-Z]{26}$/.test(id)) throw new InputError(`不是客户端编号：${id}`);
    return join(knowledgeSecretDir(dataDir), id);
  };
  return {
    save: (id, token) => putSecret(file(id), token),
    read: (id) => readSecret(file(id)),
    remove: (id) => rmSync(file(id), { force: true }),
  };
}
