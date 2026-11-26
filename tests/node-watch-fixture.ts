// Guards the per-round watch process (docs/design/nodes.md §4.2): the gate is a one-shot,
// a later round of the Task ends an earlier one, a stop ends this one, and what the round
// leaves behind is recorded with its exit code. And the code the round was handed
// (runner/remote/start.sh's own step, now the watch's): the bundle unpacks into the Task's
// repo/, a round after the first keeps what is there, and a round whose code will not
// unpack is one that never started.
//
// What this file is here to catch:
//   - a second start of the same round (the gate must refuse it, with the code the client
//     reports),
//   - an overtaken round running on beside the round that replaced it (the marker check),
//   - a stop that leaves the round running,
//   - an exit code written without the record of what survived it, which is what a later
//     state question reads instead of a process table that may be refused,
//   - a round handed code it cannot unpack starting anyway, and one whose repo/ is already
//     there being reset over the work the round before it left,
//   - a round told where the project's remote is leaving repo/ without that origin (the
//     executor could not push or open a pull request), keeping the bundle's own tracking
//     refs under the remote's name, or taking an address git would read as an option,
//     and a round going on with the origin a round before it was told of when changing it
//     fails (it could push to the old remote),
//   - a Worker's git waiting for a credential nobody will type, until the round times out,
//   - a round under a run id another test file also uses: a round's residue is cleared by
//     its marker across the whole machine, so this file's round ending kills the other's
//     Worker,
//   - a credential the executor reads as a variable's value (`--credential=<name>`) not
//     reaching the Worker's own environment, or leaking on the way: onto the watch's command
//     line, into stdout.ndjson, stderr.log or any file of the round's directory,
//   - a variable name from the host that no system takes starting the round anyway (or
//     crashing the watch) instead of ending it as a round that did not start, and the same for
//     a named variable with no token handed over, or a token with no variable to put it in,
//   - the watch ending on its own while it waits to look again at what the Worker left: the
//     Worker exited, nothing else holds the process, and neither the record of what was
//     left nor the exit code is ever written.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { HANDOVER_ENV } from '../node/client.ts';
import { selectProcesses } from '../node/hostprocess.ts';
import { boxOf } from '../node/runbox.ts';
import type { RunBox } from '../node/runbox.ts';
import type { SnapshotSource } from '../shared/sources.ts';
import { git, hasGit, repoAsBundle, scratchRepo } from './git-repo.ts';
import { runId } from './helpers.ts';

const FAKE = join(import.meta.dirname, 'fake-executor.mjs');
const WATCH = join(import.meta.dirname, '..', 'node', 'watch.ts');
const RESIDUE_CHILD = join(import.meta.dirname, 'watch-residue.child.ts');
const noGit = hasGit() ? false : '这台机器上没有可用的 git';
// Each round under an id of its own (see runId): r1 here is no other test's r1.
const run = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`r${i + 1}`, runId(`watch-r${i + 1}`)])) as Record<`r${number}`, string>;

async function until<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

// Whether this machine can read its own process table at all (WMI on Windows, /proc on
// Linux). The sandbox these tests run in refuses it; a Windows workstation and a Linux box
// do not (§12: the sandbox's facts are not the machine's).
async function canReadProcessTable(): Promise<boolean> {
  return (await selectProcesses().descendants(process.pid)) !== undefined;
}

// One round's directory on a machine of this test's own, and the watch that owns it.
function machine(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-watch-'));
  t.after(async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200);
      }
    }
  });
  return {
    dataDir,
    box: (task: string, run: string) => boxOf(dataDir, `tasks/${task}/runs/${run}`),
    // The watch as the client starts it: a process of its own, with the handover in its
    // environment, and no pipes at all (a round's output is written where it belongs).
    start(task: string, run: string, round: number, options: { env?: Record<string, string>; handover?: Record<string, unknown>; args?: string[] } = {}) {
      const child = spawn(process.execPath, [
        WATCH, `--data=${dataDir}`, `--run=tasks/${task}/runs/${run}`, `--round=${round}`, ...(options.args ?? []), '--',
        process.execPath, FAKE,
      ], {
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          ...(options.env ?? {}),
          [HANDOVER_ENV]: JSON.stringify(options.handover ?? {}),
        },
      });
      return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });
    },
  };
}

// Every file under a directory, read whole: what the round left on this machine's disk.
function everyFile(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

// What this round's code source is, as the machine prepares it (docs/design/code-sources.md
// §2): one file of the snapshot, written before the watch starts.
function withSource(
  t: TestContext, m: ReturnType<typeof machine>, task: string, run: string,
  source: SnapshotSource, access?: 'read' | 'write',
): RunBox {
  const box = m.box(task, run);
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'brief.md'), '# 带上代码的一轮\n');
  writeFileSync(join(box.runDir, 'snapshot', 'source.json'), `${JSON.stringify(source)}\n`);
  if (access !== undefined) writeFileSync(join(box.runDir, 'snapshot', 'access.json'), `${JSON.stringify({ permission: access })}\n`);
  return box;
}

// A source address a sandboxed machine can clone: the repository as one file (git reads a
// bundle in process, while a local path would go through a shell this sandbox denies).
function sourceUrl(t: TestContext, repoDir: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-src-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return repoAsBundle(repoDir, join(dir, 'source.bundle'));
}

export { FAKE, WATCH, RESIDUE_CHILD, noGit, run, until, canReadProcessTable, machine, everyFile, withSource, sourceUrl };
