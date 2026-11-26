// Lightweight advisory check for read-only rounds: records HEAD/branch before the Worker
// starts and runs non-destructive `git status --porcelain` afterwards (no full-repo SHA-256
// hashing, no `.gitignore` mutation, and `GIT_OPTIONAL_LOCKS=0` so the index is never touched).
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeCodeCheck } from '../shared/node-protocol.ts';
import type { FolderChange } from '../shared/roles.ts';
import type { RunBox } from './runbox.ts';

const GIT_TIMEOUT_MS = 120_000;
const CHANGES_SHOWN = 30;

export interface Baseline {
  head: string;
  // The branch HEAD names, or '' when it is detached.
  branch: string;
}

class GitFailed extends Error {}

// One git command whose answer is read from a file: a pipe is the channel some machines deny a
// child process (node/source.ts). `scratch` is the watch's own directory for this round.
function git(repo: string, scratch: string, args: string[]): string {
  mkdirSync(scratch, { recursive: true });
  const outPath = join(scratch, 'git.out');
  const errPath = join(scratch, 'git.err');
  const out = openSync(outPath, 'w');
  const err = openSync(errPath, 'w');
  // Nothing of git's own from the environment: no other repository, index or work tree.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  let status: number | null;
  try {
    status = spawnSync('git', ['-C', repo, ...args], {
      stdio: ['ignore', out, err],
      // No optional lock: a reading must not refresh the index of a directory.
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
    }).status;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  if (status !== 0) {
    const said = readFileSync(errPath, 'utf8').trim().slice(-500);
    throw new GitFailed(`git ${args[0]} 出错（退出码 ${status ?? '无'}）${said ? `：${said}` : ''}`);
  }
  return readFileSync(outPath, 'utf8');
}

function headOf(repo: string, scratch: string): { head: string; branch: string } {
  const head = git(repo, scratch, ['rev-parse', '--verify', 'HEAD']).trim();
  let branch = '';
  try {
    branch = git(repo, scratch, ['symbolic-ref', '-q', 'HEAD']).trim();
  } catch (error) {
    if (!(error instanceof GitFailed)) throw error;
    // Detached: symbolic-ref says so with its exit code.
  }
  return { head, branch };
}

// Lightweight pre-run baseline: only HEAD and branch (instant regardless of repo size).
export function takeBaseline(repo: string, scratch: string): Baseline {
  return headOf(repo, scratch);
}

// Whether the snapshot this round was handed is a read-only one: `snapshot/access.json`. A
// snapshot without it is from a host that did not write it, and was never read-only here.
export function readOnlyRound(box: RunBox): boolean | string {
  let text: string;
  try {
    text = readFileSync(join(box.runDir, 'snapshot', 'access.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return `这一轮的权限读不出来（snapshot/access.json：${(error as Error).message}）：这一轮没有开工`;
  }
  try {
    return (JSON.parse(text) as { permission?: unknown }).permission === 'read';
  } catch {
    return '这一轮的权限写坏了（snapshot/access.json 不是 JSON）：这一轮没有开工';
  }
}

// Where the watch keeps what the check needs while the round runs: this machine's own.
export const scratchOf = (box: RunBox): string => join(box.procDir, 'code-check.d');

// What a folder source's directory looks like, read only: the commit HEAD names and
// `git status --porcelain`. Nothing is written into the folder and git takes no optional locks.
export interface FolderRead {
  head: string;
  status: string;
}

export function readFolder(dir: string, scratch: string): FolderRead | string {
  try {
    return {
      head: git(dir, scratch, ['rev-parse', '--verify', 'HEAD']).trim(),
      status: git(dir, scratch, ['status', '--porcelain']),
    };
  } catch (error) {
    return `读不出这个文件夹的 HEAD 和 git status：${(error as Error).message}`;
  }
}

export function folderChangeOf(before: FolderRead | string, after: FolderRead | string): FolderChange {
  if (typeof before === 'string') return { changed: false, why: before };
  if (typeof after === 'string') return { changed: false, why: after };
  return before.head === after.head && before.status === after.status ? { changed: false } : { changed: true };
}

// The check's evidence: written before the exit code, read with it (node/runbox.ts).
export const writeCodeCheck = (box: RunBox, check: NodeCodeCheck): void => {
  mkdirSync(box.procDir, { recursive: true });
  const path = join(box.procDir, 'code-check');
  writeFileSync(`${path}.tmp`, `${JSON.stringify(check)}\n`);
  renameSync(`${path}.tmp`, path);
};

// Null when the watch wrote none; a record that cannot be read is a check nobody can vouch for.
export function readCodeCheck(box: RunBox): NodeCodeCheck | null {
  let text: string;
  try {
    text = readFileSync(join(box.procDir, 'code-check'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { result: 'unverifiable', why: `核对记录读不出来：${(error as Error).message}` };
  }
  try {
    const check = JSON.parse(text) as NodeCodeCheck;
    if (['no-code', 'same', 'changed', 'unverifiable'].includes(check.result)) return check;
  } catch {
    // Said below.
  }
  return { result: 'unverifiable', why: '核对记录的内容不对' };
}

// The round's own code and the check's scratch, gone once they have served: nothing reads them
// after the check, and a round that never started leaves nothing behind.
export function dropOwn(box: RunBox): void {
  for (const dir of [join(box.runDir, 'repo'), scratchOf(box)]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file the system still holds stays: it is never read again.
    }
  }
}

// Lightweight post-run advisory check: compares HEAD/branch (when baseline available) and runs
// `git status --porcelain` without hashing files or modifying `.gitignore`.
export function checkAgainst(repo: string, base: Baseline | undefined, scratch: string): NodeCodeCheck {
  if (!existsSync(join(repo, '.git'))) return { result: 'unverifiable', why: '这一轮的代码目录不在了（或者已经不是 git 仓库）' };
  try {
    const changes: string[] = [];
    if (base !== undefined) {
      const { head, branch } = headOf(repo, scratch);
      if (head !== base.head) changes.push(`当前提交从 ${base.head.slice(0, 12)} 变成了 ${head.slice(0, 12)}`);
      if (branch !== base.branch) changes.push(`当前分支从 ${base.branch || '（不在分支上）'} 变成了 ${branch || '（不在分支上）'}`);
    }
    const status = git(repo, scratch, ['status', '--porcelain']);
    for (const raw of status.split(/\r?\n/)) {
      const line = raw.trim();
      if (line !== '') changes.push(line);
    }
    if (changes.length === 0) return { result: 'same' };
    const shown = changes.slice(0, CHANGES_SHOWN);
    if (changes.length > CHANGES_SHOWN) shown.push(`还有 ${changes.length - CHANGES_SHOWN} 处`);
    return { result: 'changed', changes: shown };
  } catch (error) {
    return { result: 'unverifiable', why: (error as Error).message };
  }
}
