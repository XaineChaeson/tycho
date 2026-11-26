// A real git repository, for what only git can prove: where a round's code stands, and what a
// folder source's HEAD and status look like. Everything here runs git itself, with its answer
// read from files rather than pipes — a pipe is the one channel this environment denies a child
// process, and a file is what every platform gives it.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';

export interface Said {
  code: number;
  out: string;
  err: string;
}

export function git(args: string[], cwd?: string): Said {
  const scratch = mkdtempSync(join(tmpdir(), 'tycho-testgit-'));
  try {
    const out = join(scratch, 'out');
    const err = join(scratch, 'err');
    const fdOut = openSync(out, 'w');
    const fdErr = openSync(err, 'w');
    let code = 0;
    try {
      execFileSync('git', args, { ...(cwd === undefined ? {} : { cwd }), stdio: ['ignore', fdOut, fdErr] });
    } catch (error) {
      code = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : -1;
    } finally {
      closeSync(fdOut);
      closeSync(fdErr);
    }
    return { code, out: readFileSync(out, 'utf8'), err: readFileSync(err, 'utf8') };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Whether this machine can run the tests that need a repository at all.
export const hasGit = (): boolean => git(['--version']).code === 0;

export interface ScrapRepo {
  dir: string;
  head(): string;
  branch(): string;
  // A commit adding one file, and its hash.
  commit(file: string, text: string): string;
}

// A checkout as an owner's would be: one branch, one commit, and a git identity. The
// branch is named rather than asked for with `init -b`: an older git on a test machine has
// no -b, and which branch the owner is on is this line's own doing either way.
export function scratchRepo(t: TestContext, name = 'host'): ScrapRepo {
  const root = mkdtempSync(join(tmpdir(), `tycho-${name}-`));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const run = (args: string[]): Said => git(args, dir);
  assert.equal(run(['init', '-q', '.']).code, 0);
  assert.equal(run(['symbolic-ref', 'HEAD', 'refs/heads/main']).code, 0);
  run(['config', 'user.email', 'owner@example.test']);
  run(['config', 'user.name', 'owner']);
  t.after(async () => {
    // Windows keeps a directory for as long as a process stands in it.
    for (let n = 0; n < 20; n += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        return;
      } catch {
        await sleep(100);
      }
    }
  });
  const repo: ScrapRepo = {
    dir,
    head: () => run(['rev-parse', 'HEAD']).out.trim(),
    branch: () => run(['symbolic-ref', '--short', '-q', 'HEAD']).out.trim(),
    commit(file, text) {
      writeFileSync(join(dir, file), text);
      assert.equal(run(['add', '-A']).code, 0);
      assert.equal(run(['commit', '-qm', file]).code, 0);
      return repo.head();
    },
  };
  repo.commit('README.md', '先是这个');
  return repo;
}

// The repository as one file, which `git clone` reads in process. A source's address is a real
// one in production; a test machine clones this instead, because git's local-path clone goes
// through a shell that this development sandbox denies (docs/design/code-sources.md §2).
export function repoAsBundle(dir: string, file: string): string {
  const made = git(['bundle', 'create', file, 'HEAD'], dir);
  assert.equal(made.code, 0, made.err);
  return file;
}
