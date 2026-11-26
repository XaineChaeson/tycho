// The Runner's side of a machine that came back by itself: the closed set of
// runner/host.ts, carried over the node channel (docs/design/nodes.md §5.2). The rules
// that judge, settle and continue a Run live in runner/runner.ts and are untouched; only
// the way a machine is asked changed.
//
// Two things this file is responsible for:
//   - A run directory is resolved against the machine's own data directory, which only
//     the machine knows: the host
//     sends "tasks/<task>/runs/<run>" and the client puts it where its own data directory
//     is (nodes.md §7).
//   - Start is never sent twice. A start whose answer was lost throws, and the Runner's
//     next look is a state question (nodes.md §4.2, §8.2).
//
// What the snapshot directory holds is text: the brief, the round's files, and where its
// code comes from (`source.json`). Nothing big travels beside it any more — the machine
// clones a repository or works in the folder itself (docs/design/code-sources.md §2, §6).
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {normalizeCaptureSpec} from '../shared/node-output.ts';
import type {CaptureRange,ResultRange} from '../shared/node-output.ts';
import type {CapturePrepared} from '../shared/node-protocol.ts';
import type { ArtifactOnMachine, ExecutorsAnswer, PlacedFile, Range, RemoteHost, RemoteState, RunOnMachine, StartedRound, StartRequest } from './host.ts';
import { ListingFailed, Unreachable, Unverifiable } from './host.ts';
import { NODE_CHUNK_BYTES } from '../shared/node-protocol.ts';
import type { NodeArtifact, NodeExecutorReport, NodeFileHash, NodeRange, NodeSourceHead, NodeStartResult, NodeState, NodeStopResult } from '../shared/node-protocol.ts';
import type { Nodes } from '../service/nodes.ts';
import { NodeAway, NodeCommandTimeout, NodeRefused } from '../service/nodes.ts';
import type { CodeCheck, FolderChange } from '../shared/roles.ts';

// What the Runner says, in the words the machine's client reads.
const place = (runDir: string): string => runDir.replace(/^\.tycho\//, '');

export interface NodeChannelOptions {
  nodes: Pick<Nodes, 'send' | 'connected' | 'lastSeen' | 'reportedExecutors' | 'askExecutors'>;
}

interface NodeChannel {
  for(machineId: string): RemoteHost;
  connected(machineId: string): boolean;
  lastSeen(machineId: string): string | null;
  // What a machine's own client says about the executors on it, asked now (nodes.md §1.2,
  // §11 step 5). A machine that is not here, or that does not answer in time, is answered
  // with what it last reported and why that is all there is.
  executors(machineId: string, timeoutMs: number): Promise<ExecutorsAnswer>;
  // Drop a Task's code copy on a machine whose client said it can (service/retention.ts):
  // tasks/<task>/repo/ and nothing else. The client refuses while a round of it still has
  // processes; a refusal is an error here and nothing is recorded for it.
  dropTaskCode(machineId: string, taskDir: string): Promise<void>;
}

export function createNodeChannel(options: NodeChannelOptions): NodeChannel {
  const { nodes } = options;

  // What the hub says, in the words the Runner's rules are written in: "the machine did
  // not answer" and "the machine answered that it could not" are both Unreachable for the
  // calls that carry a round's life, which then ask state rather than acting on it.
  async function ask<T>(machineId: string, command: Parameters<Nodes['send']>[1]): Promise<T> {
    try {
      return await nodes.send(machineId, command) as T;
    } catch (err) {
      if (err instanceof NodeRefused || err instanceof NodeAway || err instanceof NodeCommandTimeout) throw new Unreachable(err.message);
      throw err;
    }
  }

  // The same, for a listing: the machine answered and its answer was a failure to build
  // one, which is ListingFailed and not "the machine has gone" (runner/host.ts).
  async function askListing<T>(machineId: string, command: Parameters<Nodes['send']>[1]): Promise<T> {
    try {
      return await nodes.send(machineId, command) as T;
    } catch (err) {
      if (err instanceof NodeRefused) throw new ListingFailed(err.message);
      if (err instanceof NodeAway || err instanceof NodeCommandTimeout) throw new Unreachable(err.message);
      throw err;
    }
  }

  // A bounded read refusal is uncertainty about this Run's data, not a failed inventory.
  async function askOutput<T>(machineId: string, command: Parameters<Nodes['send']>[1]): Promise<T> {
    try {
      return await nodes.send(machineId, command) as T;
    } catch (err) {
      if (err instanceof NodeRefused) throw new Unverifiable(err.message);
      if (err instanceof NodeAway || err instanceof NodeCommandTimeout) throw new Unreachable(err.message);
      throw err;
    }
  }

  return {
    connected: (machineId) => nodes.connected(machineId),
    lastSeen: (machineId) => nodes.lastSeen(machineId),

    // The one question that is not about a round: what this machine's own client knows about
    // the executors on it. The command carries nothing, so what runs there is the client's own
    // closed set; what the machine last reported is the answer for a machine that cannot be
    // asked right now, together with why (nodes.md §1.2).
    async executors(machineId: string, timeoutMs: number): Promise<ExecutorsAnswer> {
      if (!nodes.connected(machineId)) {
        return { connected: false, report: nodes.reportedExecutors(machineId), fresh: false, problem: `机器 ${machineId} 没有连回来` };
      }
      let report: NodeExecutorReport;
      try {
        report = await nodes.askExecutors(machineId, timeoutMs);
      } catch (err) {
        if (err instanceof NodeRefused || err instanceof NodeAway || err instanceof NodeCommandTimeout) {
          return { connected: true, report: nodes.reportedExecutors(machineId), fresh: false, problem: err.message };
        }
        throw err;
      }
      return { connected: true, report, fresh: true };
    },

    async dropTaskCode(machineId: string, taskDir: string): Promise<void> {
      // The path is the protocol's spelling of one Task's directory, never a caller's path.
      if (!/^tasks\/[0-9A-Za-z][0-9A-Za-z._-]*$/.test(taskDir)) throw new Error(`这个任务的路径不对：${taskDir}`);
      await ask<{ dropped: boolean }>(machineId, { kind: 'drop_task_code', task_dir: taskDir });
    },

    for(machineId: string): RemoteHost {
      return {
        async place(runDir,localDir): Promise<PlacedFile[]> {
          // The machine fetches the snapshot itself (nodes.md §8.2): this only tells it
          // to. The files it reports are checked by the Runner against what was sent.
          let written:NodeFileHash[];const meta=join(localDir,'output.json');
          if(existsSync(meta)){
            const spec=normalizeCaptureSpec(JSON.parse(readFileSync(meta,'utf8')).capture);
            const result=await ask<CapturePrepared>(machineId,{kind:'prepare_capture',run_dir:place(runDir),spec});
            if(result.state!=='ready')throw new Unreachable('节点输出容量不足，未启动：'+result.reason);written=result.files;
          }else written=await ask<NodeFileHash[]>(machineId,{kind:'prepare',run_dir:place(runDir)});
          return written.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
        },

        async start(request: StartRequest): Promise<StartedRound> {
          // §9: the token does not travel in the command. The machine asks for it over
          // the channel that exists for it, and only for a round it is starting.
          const result = await ask<NodeStartResult>(machineId, {
            kind: 'start',
            ...(request.source===undefined?{}:{source:request.source}),
            run_dir: place(request.runDir),
            task_id: request.taskId,
            run_id: request.runId,
            round: request.round,
            argv: request.argv,
            env: request.env,
            // The token is the variable's value (the adapter says which variable); the field
            // keeps `via` only so that a client of protocol 5 reads the shape it knows.
            credential: request.credential === null ? null : { via: 'env', variable: request.credential.variable },
            // Only that there is one: the machine asks for it with the credential, and the
            // host mints it then (nodes.md §1.3). Nothing secret is in this command.
            ...(request.invite ? { invite: true } : {}),
            ...(request.timeoutMs === undefined ? {} : { timeout_ms: request.timeoutMs }),
            ...(request.modelIdleTimeoutMs === undefined ? {} : { model_idle_timeout_ms: request.modelIdleTimeoutMs }),
          });
          return {
            code: result.code,
            stdout: '',
            stderr: '',
            ...(result.pid === null ? {} : { pid: result.pid }),
            ...(result.started_at === null ? {} : { startedAt: result.started_at }),
            confirmed: result.confirmed,
            // A start the machine refused before it began: nothing is running there, and
            // the Runner's own answer to that is to look again, not to start again.
            ...(result.error === undefined ? {} : { stderr: result.error }),
          };
        },

        async stop(runDir): Promise<void> {
          const result = await ask<NodeStopResult>(machineId, { kind: 'stop', run_dir: place(runDir) });
          // Only "nothing is left" lets a caller read anything after this as gone; a
          // machine that could not finish the check proves nothing either way.
          if (result.alive === null) throw new Unverifiable(result.unknown ?? `机器 ${machineId} 说查不清这一轮还有没有进程`);
          if (result.alive) throw new Unreachable(`机器 ${machineId} 说这一轮还有东西在跑（还活着）`);
        },

        async state(runDir): Promise<RemoteState> {
          const answer = await ask<NodeState>(machineId, { kind: 'state', run_dir: place(runDir) });
          const head = sourceHeadOf(answer.source_head);
          return {
            started: answer.started, launcher_alive: answer.launcher_alive, pid_alive: answer.pid_alive,
            marked: answer.marked, exit: answer.exit, unknown: answer.unknown,
            ...(typeof answer.not_started === 'string' && answer.not_started !== '' ? { not_started: answer.not_started } : {}),
            ...(answer.code_check === undefined ? {} : { code_check: codeCheckOf(answer.code_check) }),
            ...(head === undefined ? {} : { source_head: head }),
          };
        },

        async list({ aliveOnly }): Promise<RunOnMachine[]> {
          // A listing the machine could not build is ListingFailed (askListing), not a
          // machine that has gone: the two callers here treat those differently.
          const runs = await askListing<RunOnMachine[]>(machineId, { kind: 'list', alive_only: aliveOnly });
          return runs.map(({ task_id, run_id }) => ({ task_id, run_id }));
        },

        readCapture:request=>askOutput<CaptureRange>(machineId,{kind:'read_capture',...request,run_dir:place(request.run_dir)}),
        readResult:request=>askOutput<ResultRange>(machineId,{kind:'read_result',...request,run_dir:place(request.run_dir)}),
        async readRange(path, offset, options): Promise<Range> {
          let slice: NodeRange;
          if (options === undefined) {
            slice = await ask<NodeRange>(machineId, { kind: 'read_output', path: place(path), offset, bytes: NODE_CHUNK_BYTES });
          } else {
            try {
              slice = await askListing<NodeRange>(machineId, { kind: 'read_file', path: place(path), offset,
                bytes: NODE_CHUNK_BYTES, file_limit_bytes: options.fileLimitBytes });
            } catch (error) {
              if (error instanceof ListingFailed && error.message.startsWith('主机发来一条不认识的命令：')) {
                throw new ListingFailed('执行节点需升级后才能查看文件报告');
              }
              throw error;
            }
          }
          return { bytes: Buffer.from(slice.base64, 'base64'), size: slice.size, mtime: slice.mtime };
        },

        async artifacts(runDir): Promise<ArtifactOnMachine[]> {
          const listed = await askListing<NodeArtifact[]>(machineId, { kind: 'artifacts', run_dir: place(runDir) });
          return listed.map(({ name, sha256, bytes }) => ({ name, sha256, bytes }));
        },

        async dropRun(runDir): Promise<void> {
          await ask<{ dropped: boolean }>(machineId, { kind: 'drop_run', run_dir: place(runDir) });
        },

        // No ask: the closed set is the whole of what a client takes, and the executor's
        // own facts are what it reports by itself (nodes.md §11, step 5).
        connected: () => nodes.connected(machineId),
      };
    },
  };
}

// A read-only round's code check as the machine said it, rebuilt field by field: one that is not
// of the protocol's shape is a check nobody can vouch for, never one that passed. Its words go
// into the Task's reason and the pages, so they are cut where the machine's other words are: the
// file is the Worker's user's to write (nodes.md §4.2).
const CHECK_LINES = 31;
const CHECK_CHARS = 500;
// What a folder round read of its folder (§8.2): information the page shows beside the round,
// so it is rebuilt as narrowly as the check itself — a shape that is not the protocol's is
// dropped rather than repeated, and never turns a "no code" into something else.
function folderChangeOf(value: unknown): FolderChange | undefined {
  const held = value as { changed?: unknown; why?: unknown } | null;
  if (held === null || typeof held !== 'object' || typeof held.changed !== 'boolean') return undefined;
  return held.why === undefined
    ? { changed: held.changed }
    : { changed: held.changed, why: typeof held.why === 'string' ? held.why.slice(0, CHECK_CHARS) : '机器给的说法读不出来' };
}
export function codeCheckOf(value: unknown): CodeCheck {
  const held = value as { result?: unknown; changes?: unknown; why?: unknown; folder_change?: unknown } | null;
  const result = held !== null && typeof held === 'object' ? held.result : undefined;
  if (result === 'no-code') {
    const folder = folderChangeOf(held!.folder_change);
    return folder === undefined ? { result } : { result, folder_change: folder };
  }
  if (result === 'same') return { result };
  if (result === 'changed' && Array.isArray(held!.changes) && held!.changes.length > 0 && held!.changes.every((each) => typeof each === 'string')) {
    return { result, changes: (held!.changes as string[]).slice(0, CHECK_LINES).map((each) => each.slice(0, CHECK_CHARS)) };
  }
  if (result === 'unverifiable' && typeof held!.why === 'string') return { result, why: held!.why.slice(0, CHECK_CHARS) };
  return { result: 'unverifiable', why: '机器给的核对记录形状不对' };
}

// Where a round's code stood, as the machine said it, rebuilt field by field: a report that is
// not of the protocol's shape is no report at all, never something the host could bind a review
// to. A report is the Worker's own user's to write, so its words are cut where the machine's
// other words are, and every commit it names must be one. A field that is there and is not what
// the protocol says makes the whole report no report: filling in a required one, or dropping a
// malformed one and binding by the rest, would bind a review to a report nobody made.
const HEAD_CHARS = 500;
export function sourceHeadOf(value: unknown): NodeSourceHead | undefined {
  const held = value as { kind?: unknown; head?: unknown; branch?: unknown; remote_head?: unknown; start?: unknown; problem?: unknown } | null;
  if (held === null || typeof held !== 'object') return undefined;
  if (held.kind !== 'repo' && held.kind !== 'folder') return undefined;
  const commit = (each: unknown): string | null => (typeof each === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(each.trim()) ? each.trim() : null);
  // A word of the machine's: cut where its other words are. Null is "this is not a string at
  // all", which no field of this shape may be; undefined is a word that is not there.
  const word = (each: unknown): string | undefined | null => (typeof each !== 'string' ? null : each.trim() === '' ? undefined : each.trim().slice(0, HEAD_CHARS));
  // `head` is required, and null is the machine saying it could not be read: absent, or of any
  // other type, is a report this program cannot read.
  const head = held.head === null ? null : commit(held.head);
  if (head === null && held.head !== null) return undefined;
  const branch = held.branch === undefined || held.branch === null ? undefined : word(held.branch);
  if (branch === null) return undefined;
  // `remote_head` is a repository's, and a read-only repository round legitimately reports none:
  // absent stays absent. What is there must be a commit, or the machine's null with `problem`.
  let remote: string | null | undefined;
  if (held.remote_head !== undefined) {
    if (held.kind === 'folder' && held.remote_head !== null) return undefined;
    remote = held.remote_head === null ? null : commit(held.remote_head) ?? undefined;
    if (remote === undefined) return undefined;
  }
  let start: string | null | undefined;
  if (held.start !== undefined) {
    start = held.start === null ? null : commit(held.start);
    if (start === null && held.start !== null) return undefined;
  }
  const problem = held.problem === undefined || held.problem === null ? undefined : word(held.problem);
  if (problem === null) return undefined;
  return {
    kind: held.kind,
    head,
    ...(branch === undefined ? {} : { branch }),
    ...(held.kind === 'repo' ? { remote_head: remote ?? null } : {}),
    ...(start === undefined ? {} : { start }),
    ...(problem === undefined ? {} : { problem }),
  };
}
