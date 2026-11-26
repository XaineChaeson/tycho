// Where this round's code is, on the machine that runs it (docs/design/code-sources.md §2).
// The watch prepares it after the gate and before the Worker, and the Worker's working
// directory is the source's:
//
//   - repository, writable: the Task's kept checkout for this source binding, under
//     `tasks/<task>/<binding key>/` (shared/sources.ts bindingKey). The first round of the
//     binding clones it with the machine's own git login; later rounds reuse it, uncommitted work
//     and all. Two bindings of one Task never share a directory (§8.7), so repinning the Task —
//     or the owner re-pointing the same source id elsewhere — leaves the old checkout where it is.
//   - repository, read-only: a checkout of this round's own under `runs/<run>/repo/`, at the
//     commit the round names or at the cloned HEAD, with no origin: nothing of it is left for a
//     later round, and nothing a later round left is part of it. A read-only round is checked
//     afterwards against what it was when it started (node/code-check.ts).
//   - folder: the folder as the machine has it. tycho writes nothing into it and vouches for
//     nothing about it, so there is no code check; a read-only round reads its HEAD and its
//     `git status --porcelain` for information only (§8.1, §8.2).
//   - no source: the Task's directory, with no checkout.
//
// Everything git says is read from files rather than pipes: a pipe is the one channel this
// environment denies a child process, and a file is what every platform gives it. The
// answers go to the round's own repo.log; a clone that fails carries what git said into the
// round's own reason, so that the host and the page can see it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SnapshotSource } from '../shared/sources.ts';
import type { RunBox } from './runbox.ts';

// A checkout the owner has open elsewhere can hold a lock for a while, and a repository can
// be large; past this the round is refused rather than waited on.
const GIT_TIMEOUT_MS = 120_000;
// How much of what git said may travel on as a reason: enough for the line that says why, not
// a whole transcript. Cut from the front, because git says the reason last.
const GIT_WORDS_MAX = 600;

const SOURCE_BROKEN = (why: string): string => `这一轮的代码来源读不出来（snapshot/source.json：${why}）：这一轮没有开工`;
const FOLDER_MISSING = (path: string): string => `这一轮的代码是这台机器上的文件夹 ${path}，它不存在、不是文件夹，或者读不了：这一轮没有开工`;
const FOLDER_UNWRITABLE = (path: string): string => `这一轮的代码是这台机器上的文件夹 ${path}，它不可写（只读，或者没有权限）：这一轮没有开工`;
// What git said goes into the reason itself, cut and stripped: the log beside the round is not
// read by anything, so a DNS failure or a full disk would never be seen otherwise.
const CLONE_FAILED = (url: string, said: string): string => `没能把仓库 ${url} 克隆到任务目录里${said === '' ? '（多半是这台机器没有访问权限）' : `：${said}`}：这一轮没有开工`;
const CHECKOUT_FAILED = (commit: string, said: string): string => `克隆下来的仓库里签不出提交 ${commit}${said === '' ? '' : `：${said}`}：这一轮没有开工`;
const EXISTING_UNUSABLE = (url: string): string => `任务工作目录里的代码副本用不了：它不是一个可以接着做的仓库（见 repo.log），项目现在的远端是 ${url}：这一轮没有开工`;
// A binding identity that is not one: the directory a checkout is kept under is named by it, and
// a name that could point anywhere is refused rather than written to.
const BAD_BINDING_KEY = (key: string): string => `代码来源的绑定身份不能当一个目录名用（${JSON.stringify(key).slice(0, 60)}）：这一轮没有开工`;

// One git command of the preparation, its answers appended to the round's repo.log. Nothing
// of it is piped, and no answer of git's is read here: the exit code is the whole question,
// and the reason a reader wants is in the log beside the round.
function gitIn(dir: string, args: string[], log: string, extraEnv?: Record<string, string>): boolean {
  const out = openSync(log, 'a');
  const err = openSync(log, 'a');
  try {
    const said = spawnSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', out, err],
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
      env: { ...process.env, ...(extraEnv ?? {}), GIT_TERMINAL_PROMPT: '0' },
    });
    return said.status === 0;
  } catch {
    return false;
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

// A clone with its own stdout and stderr, for the first one: there is no directory to run
// `-C` in yet.
function gitClone(args: string[], log: string, extraEnv?: Record<string, string>): boolean {
  const out = openSync(log, 'a');
  const err = openSync(log, 'a');
  try {
    const said = spawnSync('git', args, {
      stdio: ['ignore', out, err],
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
      // The machine's own git login reaches the child through its environment, as for any
      // other git command: this is where credentials come from (docs/design/code-sources.md §2).
      env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: '0' },
    });
    return said.status === 0;
  } catch {
    return false;
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

// Where one git command's words begin in the log: the log is appended to across all of a
// round's commands, so only what the command that failed wrote is read back.
const wordsAt = (log: string): number => {
  try {
    return statSync(log).size;
  } catch {
    return 0;
  }
};

// What git said from that moment on, as much as a reason may carry and with what must not
// travel on taken out (shownGitWords). Nothing here reads the round's own output: this is
// git's own stderr, in the round's repo.log.
function gitWords(log: string, from: number): string {
  let text = '';
  try {
    const end = statSync(log).size;
    const start = Math.max(from, end - GIT_WORDS_MAX * 4);
    if (end > start) {
      const held = Buffer.alloc(end - start);
      const fd = openSync(log, 'r');
      try {
        readSync(fd, held, 0, held.length, start);
      } finally {
        closeSync(fd);
      }
      text = held.toString('utf8');
    }
  } catch {
    return '';
  }
  return shownGitWords(text);
}

// What of git's words may be repeated to the host and shown on the Task page: an address's
// user part taken out (a token is often put there, and the reason travels to the ledger, the
// pages and a phone), a line that names a credential dropped, and the whole cut to the last
// stretch — git says the reason last. The Runner hides the secrets it knows on top of this;
// this is what the machine can tell by itself.
export function shownGitWords(text: string): string {
  const clean = text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1')
    .split('\n')
    .filter((line) => !/password|passwd|token|authorization/i.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > GIT_WORDS_MAX ? `…${clean.slice(-GIT_WORDS_MAX)}` : clean;
}

function readSource(box: RunBox): SnapshotSource | null | string {
  let text: string;
  try {
    text = readFileSync(join(box.runDir, 'snapshot', 'source.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return SOURCE_BROKEN((error as Error).message);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return SOURCE_BROKEN((error as Error).message);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return SOURCE_BROKEN('不是一项来源');
  const held = value as { kind?: unknown; url?: unknown; commit?: unknown; path?: unknown; binding_key?: unknown };
  // The binding identity the host prepared the round with (shared/sources.ts bindingKey) is
  // carried, never worked out here: the checkout directory is named after it, so a source the
  // owner re-pointed under the same id gets its own directory instead of reusing the one the old
  // address was cloned into. A round without one is a snapshot nobody wrote.
  if (typeof held.binding_key !== 'string' || !/^[\w-]{1,80}$/.test(held.binding_key)) {
    return held.binding_key === undefined
      ? SOURCE_BROKEN('来源没有绑定身份，说不清它的副本该放在哪个目录里')
      : BAD_BINDING_KEY(String(held.binding_key));
  }
  if (held.kind === 'folder') {
    if (typeof held.path !== 'string' || held.path === '') return SOURCE_BROKEN('文件夹来源没有路径');
    return { kind: 'folder', path: held.path, binding_key: held.binding_key };
  }
  if (held.kind === 'repo') {
    if (typeof held.url !== 'string' || held.url === '') return SOURCE_BROKEN('仓库来源没有地址');
    if (held.commit !== undefined && (typeof held.commit !== 'string' || !/^[0-9a-fA-F]+$/.test(held.commit))) {
      return SOURCE_BROKEN('要签出的提交不是一个提交号');
    }
    return {
      kind: 'repo',
      url: held.url,
      binding_key: held.binding_key,
      ...(typeof held.commit === 'string' ? { commit: held.commit } : {}),
    };
  }
  return SOURCE_BROKEN(`不认识的来源种类 ${JSON.stringify(String(held.kind)).slice(0, 40)}`);
}

// The branch a Task's rounds live on when one is made here: a name of this program's own, so
// that nothing the machine's configuration says is taken as the branch to work on.
const branchOf = (box: RunBox): string => `tycho/${box.taskId}`;

// Where a repository's kept checkout lives: one directory per binding of the Task (§8.7), named
// by the binding identity the snapshot carries, so that repinning it — or the owner re-pointing
// the same source id at another address — never puts another repository under work the first one
// left behind. A directory of an older name, or of a binding the Task no longer holds, is left
// for the retention period to clean (node/runbox.ts).
const keptDirOf = (box: RunBox, source: Extract<SnapshotSource, { kind: 'repo' }>): string =>
  join(box.taskDir, source.binding_key);

// Shared bare mirror cache under `<dataDir>/repo-mirrors/<sha256(url).slice(0, 16)>.git`:
// speeds up cold starts via `--reference-if-able` while keeping every task/run checkout standalone.
export const mirrorDirOf = (box: RunBox, url: string): string =>
  join(dirname(box.taskDir), '..', 'repo-mirrors', `${createHash('sha256').update(url).digest('hex').slice(0, 16)}.git`);

function isHealthyMirror(mirrorDir: string): boolean {
  return existsSync(join(mirrorDir, 'HEAD')) && existsSync(join(mirrorDir, 'objects'));
}

const MIRROR_LOCK_STALE_MS = 120_000;

function acquireMirrorLock(lockPath: string): boolean {
  const tryCreate = (): boolean => {
    try {
      writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return true;
  try {
    const st = statSync(lockPath);
    if (Date.now() - st.mtimeMs >= MIRROR_LOCK_STALE_MS) {
      rmSync(lockPath, { force: true });
      return tryCreate();
    }
  } catch {
    // Lock vanished or unreadable; fall back gracefully to direct clone.
  }
  return false;
}

// Best-effort bare mirror creation/update. Returns the mirror path when healthy, or null so the
// caller falls back silently to a direct `git clone` without polluting failure diagnostics.
function ensureMirror(url: string, mirrorDir: string, log: string, extraEnv?: Record<string, string>): string | null {
  let locked = false;
  const lockPath = `${mirrorDir}.lock`;
  try {
    mkdirSync(dirname(mirrorDir), { recursive: true });
    locked = acquireMirrorLock(lockPath);
    if (!locked) return null;
    if (!existsSync(mirrorDir)) {
      const tmp = `${mirrorDir}.tmp.${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      if (!gitClone(['clone', '--mirror', '--quiet', '--', url, tmp], log, extraEnv)) {
        rmSync(tmp, { recursive: true, force: true });
        return null;
      }
      try {
        renameSync(tmp, mirrorDir);
      } catch {
        rmSync(tmp, { recursive: true, force: true });
        if (!isHealthyMirror(mirrorDir)) return null;
      }
      return isHealthyMirror(mirrorDir) ? mirrorDir : null;
    }
    if (!isHealthyMirror(mirrorDir)) return null;
    if (!gitIn(mirrorDir, ['fetch', '--quiet', '--prune'], log, extraEnv)) return null;
    return mirrorDir;
  } catch {
    return null;
  } finally {
    if (locked) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Best-effort lock cleanup; stale lock expiry handles leftovers.
      }
    }
  }
}

function cloneWithMirror(
  box: RunBox,
  url: string,
  dest: string,
  noCheckout: boolean,
  log: string,
  extraEnv?: Record<string, string>,
): { ok: true } | { ok: false; said: string } {
  const baseArgs = noCheckout ? ['clone', '--quiet', '--no-checkout'] : ['clone', '--quiet'];
  const mirror = ensureMirror(url, mirrorDirOf(box, url), log, extraEnv);
  if (mirror !== null) {
    if (gitClone([...baseArgs, '--reference-if-able', mirror, '--dissociate', '--', url, dest], log, extraEnv)) {
      return { ok: true };
    }
    rmSync(dest, { recursive: true, force: true });
  }
  const from = wordsAt(log);
  if (gitClone([...baseArgs, '--', url, dest], log, extraEnv)) {
    return { ok: true };
  }
  rmSync(dest, { recursive: true, force: true });
  return { ok: false, said: gitWords(log, from) };
}

// The Task's kept checkout for one source, cloned on the first round of it. The origin is the
// one the clone made: the source a Task is pinned to does not change under it (§8.11), so
// nothing rewrites it round after round and the machine's own git configuration — push URLs,
// refspecs, remote-tracking refs — is left to whoever works there.
function keptRepo(box: RunBox, source: Extract<SnapshotSource, { kind: 'repo' }>, log: string, extraEnv?: Record<string, string>): { dir: string } | string {
  const repo = keptDirOf(box, source);
  if (!existsSync(repo)) {
    const incoming = `${repo}.incoming.${process.pid}`;
    rmSync(incoming, { recursive: true, force: true });
    const cloned = cloneWithMirror(box, source.url, incoming, false, log, extraEnv);
    if (!cloned.ok) {
      return CLONE_FAILED(source.url, cloned.said);
    }
    // A commit needs an identity, and the machine may have none. This clone belongs to the
    // Worker, so one is set here only where there is nothing to inherit.
    if (!gitIn(incoming, ['config', 'user.email'], log, extraEnv)) gitIn(incoming, ['config', 'user.email', 'tycho@localhost'], log, extraEnv);
    if (!gitIn(incoming, ['config', 'user.name'], log, extraEnv)) gitIn(incoming, ['config', 'user.name', 'tycho'], log, extraEnv);
    // The move is the publication: a directory that is already there is a refusal, not this
    // tree moved inside it.
    try {
      renameSync(incoming, repo);
    } catch {
      rmSync(incoming, { recursive: true, force: true });
      if (!existsSync(repo)) return EXISTING_UNUSABLE(source.url);
    }
  } else if (!existsSync(join(repo, '.git'))) {
    return EXISTING_UNUSABLE(source.url);
  }
  return { dir: repo };
}

// A read-only round's own checkout, at the commit it names or at the cloned HEAD, with no
// origin: nothing of this round is pushed, and it is removed once the round is checked. Every
// read-only repository round gets one of its own — not the Task's kept checkout — so that what
// it finds is what the repository holds and never what an earlier round left behind.
function ownCheckout(box: RunBox, source: Extract<SnapshotSource, { kind: 'repo' }>, log: string, extraEnv?: Record<string, string>): { dir: string } | string {
  const own = join(box.runDir, 'repo');
  // Only the watch that took the gate gets here, once: anything there is a leftover.
  rmSync(own, { recursive: true, force: true });
  // A round that names a commit clones without a checkout and detaches at it; one that names
  // none gets the clone's own HEAD, as a writable round works on the branch it cloned.
  const cloned = cloneWithMirror(box, source.url, own, source.commit !== undefined, log, extraEnv);
  if (!cloned.ok) {
    return CLONE_FAILED(source.url, cloned.said);
  }
  if (source.commit !== undefined) {
    const checkoutFrom = wordsAt(log);
    if (!gitIn(own, ['checkout', '--quiet', '--detach', source.commit], log, extraEnv)) {
      const said = gitWords(log, checkoutFrom);
      rmSync(own, { recursive: true, force: true });
      return CHECKOUT_FAILED(source.commit, said);
    }
  }
  // A read-only round is not given a remote: what it can reach with the machine's own git
  // login is not what its read-only way holds it to, so there is nothing to push to. The
  // branch the clone carried is dropped for the same reason; the clone's own HEAD is the code.
  gitIn(own, ['remote', 'remove', 'origin'], log, extraEnv);
  gitIn(own, ['branch', '-D', branchOf(box)], log, extraEnv);
  return { dir: own };
}

function folderDir(path: string, readOnly: boolean): { dir: string } | string {
  let found;
  try {
    found = statSync(path, { throwIfNoEntry: false });
  } catch {
    return FOLDER_MISSING(path);
  }
  if (found === undefined || !found.isDirectory()) return FOLDER_MISSING(path);
  try {
    // A check, not a write: tycho never puts anything in the owner's folder.
    accessSync(path, readOnly ? constants.R_OK : constants.R_OK | constants.W_OK);
  } catch {
    return readOnly ? FOLDER_MISSING(path) : FOLDER_UNWRITABLE(path);
  }
  return { dir: path };
}

// What the watch prepared for this round: the directory the Worker runs in, the checkout a
// read-only round is checked against (null: no code of tycho's), and the folder a read-only
// round reads for information (null: the source is not a folder). A string is why the round
// did not start.
export type PreparedSource =
  | string
  | { cwd: string; check: string | null; folder: string | null };

export function prepareSource(box: RunBox, readOnly: boolean, extraEnv?: Record<string, string>): PreparedSource {
  const source = readSource(box);
  if (typeof source === 'string') return source;
  const log = join(box.runDir, 'repo.log');
  if (source === null) return { cwd: box.taskDir, check: null, folder: null };
  if (source.kind === 'folder') {
    const folder = folderDir(source.path, readOnly);
    return typeof folder === 'string' ? folder : { cwd: folder.dir, check: null, folder: folder.dir };
  }
  const repo = readOnly ? ownCheckout(box, source, log, extraEnv) : keptRepo(box, source, log, extraEnv);
  if (typeof repo === 'string') return repo;
  return { cwd: repo.dir, check: readOnly ? repo.dir : null, folder: null };
}

// Why this round did not start (its code could not be prepared, or its Worker could not be
// run), in the round's own words for it: appended.
export function noteNotStarted(box: RunBox, reason: string): void {
  try {
    mkdirSync(box.runDir, { recursive: true });
    writeFileSync(join(box.runDir, 'stderr.log'), `${reason}\n`, { flag: 'a' });
  } catch {
    // A round that cannot write its words is still a round that did not start.
  }
}
