// Where this round's code stood, as the machine that ran it can read it (docs/design/
// code-sources.md §8 第 4、6 条). The machine is the one with the repository's access — the
// host may not resolve the same SSH alias or reach a private repository at all — so the remote
// branch head is read here, with `git ls-remote`, and the host only compares it with what the
// round's receipt reported. A folder has no remote; its HEAD is what the round's code is, and
// it is read here because the folder lives on this machine alone.
//
// The watch reads HEAD when the round begins, after the code is in place and before the Worker
// starts: the first round of a Task gives the Task's start, which a review's range is measured
// from. It reads again when the Worker is over, together with the remote branch head of the
// branch the working copy stands on, and writes both beside the round. The client reports them
// with the round's state, and the host binds a review to them.
//
// Everything git says is read from a file rather than a pipe: a pipe is the one channel this
// environment denies a child process. The record is this machine's own (box.procDir), like the
// read-only code check beside it.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeSourceHead } from '../shared/node-protocol.ts';
import type { SnapshotSource } from '../shared/sources.ts';
import type { RunBox } from './runbox.ts';
import { readOnlyRound } from './code-check.ts';

// A remote that does not answer in this long is not waited on: the round is over, and the host
// says the commit could not be checked rather than holding the settlement.
const GIT_TIMEOUT_MS = 60_000;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SAID_MAX = 300;

export type Logger = (line: string) => void;

interface Said {
  code: number;
  out: string;
}

// The variables that would make git read some other repository or work tree than the one `-C`
// names: with one of them in the machine's environment, `git -C <folder> rev-parse HEAD` answers
// about what it points at, and a review would be bound to another repository's commit (this is
// Git's own repository-location environment, not a setting of ours). Everything else stays,
// including whatever carries this machine's credentials and SSH command, which is what reaches a
// private repository.
const LOCATION_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_PREFIX', 'GIT_QUARANTINE_PATH',
];

// The environment one git command of this module runs with: the machine's own, less whatever
// would move the repository out from under `-C`.
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LOCATION_ENV) delete env[name];
  // A git that can ask for a credential would wait where nobody can answer; it fails instead,
  // which is what "the remote cannot be read from here" looks like.
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never', GIT_OPTIONAL_LOCKS: '0' };
}

// One git command, its standard output read from a file and its words appended to repo.log.
// The write goes beside the round's own records, never into the folder the code is in.
function gitInto(dir: string, args: string[], outPath: string, log: string): Said {
  const fdOut = openSync(outPath, 'w');
  const fdErr = openSync(log, 'a');
  try {
    const said = spawnSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', fdOut, fdErr],
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
      env: gitEnv(),
    });
    const out = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    return { code: said.status ?? -1, out };
  } catch (error) {
    try { writeFileSync(log, `git ${args[0] ?? ''} 没能运行：${(error as Error).message}\n`, { flag: 'a' }); } catch { /* the round goes on */ }
    return { code: -1, out: '' };
  } finally {
    closeSync(fdOut);
    closeSync(fdErr);
  }
}

// What `git ls-remote <url> refs/heads/<branch>` answered, read as the commit that branch
// stands on: the one line whose ref is exactly that branch. Anything else — no such line, a
// line whose first field is not a commit — is said as it is, never guessed at.
export function readRemoteHead(out: string, branch: string): { head: string | null; problem: string | null } {
  const row = out.split('\n').map((each) => each.trim()).filter(Boolean)
    .find((each) => each.split('\t')[1] === `refs/heads/${branch}`);
  if (row === undefined) return { head: null, problem: `远端没有 \`${branch}\` 这条分支` };
  const head = row.split('\t')[0]?.trim() ?? '';
  if (!COMMIT.test(head)) return { head: null, problem: `远端对 \`${branch}\` 的回答不是一个提交号：${row.slice(0, 200)}` };
  return { head, problem: null };
}

// The source this round was given, as the snapshot names it (runner/snapshot.ts writes
// source.json; node/source.ts prepares the working directory from it). Null when there is none;
// a source that cannot be read is said in `why`, because a round that has one is not a round
// without code.
function sourceOf(box: RunBox): { source: SnapshotSource | null; why: string | null } {
  let text: string;
  try {
    text = readFileSync(join(box.runDir, 'snapshot', 'source.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { source: null, why: null };
    return { source: null, why: `来源读不出来：${(error as Error).message}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { source: null, why: `来源不是 JSON：${(error as Error).message}` };
  }
  const held = value as { kind?: unknown; url?: unknown; path?: unknown; binding_key?: unknown; branch?: unknown; commit?: unknown } | null;
  if (held === null || typeof held !== 'object') return { source: null, why: '来源读不出来' };
  const binding = typeof held.binding_key === 'string' && held.binding_key !== '' ? held.binding_key : null;
  if (held.kind === 'folder' && typeof held.path === 'string' && held.path !== '' && binding !== null) {
    return { source: { kind: 'folder', path: held.path, binding_key: binding }, why: null };
  }
  if (held.kind === 'repo' && typeof held.url === 'string' && held.url !== '' && binding !== null) {
    return {
      source: {
        kind: 'repo',
        url: held.url,
        binding_key: binding,
        ...(typeof held.branch === 'string' && held.branch !== '' ? { branch: held.branch } : {}),
        ...(typeof held.commit === 'string' && held.commit !== '' ? { commit: held.commit } : {}),
      },
      why: null,
    };
  }
  return { source: null, why: '来源的形状不对' };
}

// The working copy this round's code is in, as the watch prepared it (node/source.ts): the
// folder the source names, the round's own checkout for a read-only round that was handed a
// commit, or the Task's kept repository copy for that source binding (one directory per binding
// key, §8.7).
export function codeDirOf(box: RunBox, source: SnapshotSource): string | null {
  if (source.kind === 'folder') return source.path;
  const own = join(box.runDir, 'repo');
  const kept = join(box.taskDir, source.binding_key);
  const there = (dir: string): boolean => existsSync(join(dir, '.git'));
  // A read-only round that was handed a commit has a checkout of its own, and the Task's kept
  // copy is another round's: the two are told apart by which one this round was given.
  if (readOnlyRound(box) === true && there(own)) return own;
  if (there(kept)) return kept;
  return there(own) ? own : null;
}

export interface Standing {
  dir: string;
  source: SnapshotSource;
  head: string | null;
  branch: string | null;
  problem: string | null;
}

// What the working copy stands on right now, as git answers: the commit HEAD names and the
// branch it names. Nothing is written into the directory, so this is safe on a folder the
// owner owns.
function standing(dir: string, source: SnapshotSource, scratch: string, log: string): Standing {
  const at = (args: string[]): Said => gitInto(dir, args, scratch, log);
  const head = at(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const commit = head.code === 0 ? head.out.trim() : '';
  if (!COMMIT.test(commit)) {
    return { dir, source, head: null, branch: null, problem: '读不出工作目录的 HEAD（这个目录可能不是一个 git 仓库，或者还没有提交）' };
  }
  const ref = at(['symbolic-ref', '--quiet', 'HEAD']);
  const named = ref.code === 0 ? ref.out.trim().replace(/^refs\/heads\//, '') : '';
  return { dir, source, head: commit, branch: named === '' || named.startsWith('refs/') ? null : named, problem: null };
}

// Called by the watch once the round's code is in place and before the Worker starts. Null
// when the round has no source, or its code is not there to read: then there is no start to
// record, which is said in the round's own log.
export function beginRound(box: RunBox, note?: Logger): Standing | null {
  const { source, why } = sourceOf(box);
  if (source === null) {
    if (why !== null) note?.(`这一轮的来源读不出来，起点的 HEAD 读不了：${why}`);
    return null;
  }
  const dir = codeDirOf(box, source);
  if (dir === null) {
    note?.('这一轮的代码目录不在，起点的 HEAD 读不了');
    return null;
  }
  return standing(dir, source, scratchPath(box), join(box.runDir, 'repo.log'));
}

// Called by the watch once the Worker is over and before the exit code is written. Writes what
// this machine read, so that the client reports it with the round's state (node/runbox.ts).
export function endRound(box: RunBox, start: Standing | null, note?: Logger): void {
  const record = readAtEnd(box, start);
  if (record === null) return;
  try {
    writeSourceHead(box, record);
  } catch (error) {
    note?.(`代码来源的事实没能写下：${(error as Error).message}`);
  }
}

// What the machine reads once the round is over. Null: no source, or the working copy is gone,
// which is said in the round's log; the host then reads "the machine reported nothing" and
// binds no review.
function readAtEnd(box: RunBox, start: Standing | null): NodeSourceHead | null {
  const { source, why } = sourceOf(box);
  if (source === null) {
    // Nothing to report about, and the kind of a source that cannot be read is not something to
    // guess at: the host then reads "the machine reported nothing" and binds no review.
    if (why !== null) {
      try { writeFileSync(join(box.runDir, 'repo.log'), `来源读不出来：${why}\n`, { flag: 'a' }); } catch { /* the round's end stands */ }
    }
    return null;
  }
  const dir = codeDirOf(box, source);
  if (dir === null) {
    return { kind: source.kind, head: null, start: start?.head ?? null, problem: '这一轮的代码目录不在了，读不出 HEAD' };
  }
  const now = standing(dir, source, scratchPath(box), join(box.runDir, 'repo.log'));
  const record: NodeSourceHead = {
    kind: source.kind,
    head: now.head,
    ...(now.branch === null ? {} : { branch: now.branch }),
    ...(start?.head == null ? { start: null } : { start: start.head }),
    ...(now.problem === null ? {} : { problem: now.problem.slice(0, SAID_MAX) }),
  };
  if (source.kind === 'folder') return record;
  // A repository round that could write is the one that pushes: what the remote's branch head is
  // now is what the host checks the receipt's commit against. A read-only round is handed no
  // remote and pushes nothing, so there is nothing to ask.
  if (readOnlyRound(box) === true) return record;
  if (now.branch === null) {
    return { ...record, remote_head: null, problem: '工作目录不在任何一条分支上（HEAD 是分离的），问不了远端分支头' };
  }
  const url = source.url;
  const answer = gitInto(dir, ['ls-remote', '--', url, `refs/heads/${now.branch}`], scratchPath(box), join(box.runDir, 'repo.log'));
  if (answer.code !== 0) {
    return { ...record, remote_head: null, problem: `没能问远端 ${url}（见 repo.log）：机器上可能没有这个仓库的访问权限`.slice(0, SAID_MAX) };
  }
  const remote = readRemoteHead(answer.out, now.branch);
  return { ...record, remote_head: remote.head, ...(remote.problem === null ? {} : { problem: remote.problem.slice(0, SAID_MAX) }) };
}

// One scratch file per use, beside the round's own records: git's standard output, read whole
// and then gone.
const scratchPath = (box: RunBox): string => {
  mkdirSync(box.procDir, { recursive: true });
  return join(box.procDir, 'source-head.out');
};

// The record as the client reports it with the round's state, written before the exit code so
// that whoever reads the round's end finds it beside (node/code-check.ts does the same). One that
// cannot be written leaves the round's end as it is, and the host then reads "the machine
// reported nothing" and binds no review.
export function writeSourceHead(box: RunBox, record: NodeSourceHead): void {
  mkdirSync(box.procDir, { recursive: true });
  const path = join(box.procDir, 'source-head');
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record)}\n`);
  renameSync(`${path}.tmp`, path);
  rmSync(scratchPath(box), { force: true });
}

// Null when the watch wrote none. A record that is there and cannot be read is reported as one
// nobody can act on — head null, with the reason — and never as no source: the host refuses to
// bind a review to a guess, and a round that had code is not a round without it. The kind is not
// guessed at either; only the head matters to what a reader does with a broken record.
export function readSourceHead(box: RunBox): NodeSourceHead | null {
  let text: string;
  try {
    text = readFileSync(join(box.procDir, 'source-head'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { kind: 'repo', head: null, start: null, problem: `代码来源的记录读不出来：${(error as Error).message}`.slice(0, SAID_MAX) };
  }
  try {
    const held = JSON.parse(text) as NodeSourceHead | null;
    if (held !== null && typeof held === 'object' && (held.kind === 'repo' || held.kind === 'folder')) return held;
  } catch {
    // Said below.
  }
  return { kind: 'repo', head: null, start: null, problem: '代码来源的记录内容不对' };
}
