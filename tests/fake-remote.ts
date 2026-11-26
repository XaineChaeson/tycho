import {ADAPTERS} from '../adapters/all.ts';
import {createHash} from 'node:crypto';
import type {CaptureSpec} from '../shared/node-output.ts';
// The instances as the Runner sees them through RemoteHost, shared by a service and the
// one that replaces it: the Workers on them outlive any restart, which is the point of
// the restart and acceptance tests. Behaviour follows a machine's client (node/client.ts,
// node/watch.ts) at the level of §4's table: what a state reports, what a stop revokes,
// what a start refuses. Calls are recorded under the names they had as scripts.
// Machines are told apart by name and share one home directory, as the cluster's do:
// a Run's files are seen from all of them, its processes live on the one that started it.
// A later round starting ends nothing: the watch beside an overtaken Worker ends it some
// seconds later, and that moment is the test's to call (`watchLooks`), so that the time
// both rounds are alive is something a test can stand in. `fakeSites` is several of
// these that share nothing, for what happens when one name comes to mean another machine.
import { cpSync, mkdtempSync,existsSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { RemoteState } from '../runner/runner.ts';
import type { Machine } from '../runner/snapshot.ts';
import type { RemoteHost } from '../runner/host.ts';
import { ListingFailed, Unreachable } from '../runner/host.ts';

const START_REVOKED = 4;
const START_SUPERSEDED = 6;
const SUPERSEDED_EXIT = 86;

export interface RemoteRun extends RemoteState {
  stdout: string;
  stderr: string;
  revoked: boolean;
  // Where its processes are, once a start reached a machine.
  host: string | undefined;
  round: number | undefined;
}

export interface Call {
  script: string;
  runId: string | undefined;
  host: string;
  // For a start, what its command carries: `<run dir> <round> <credential fd name>
  // NAME=VALUE ... [--invite] -- <the Worker's own command>`. No token is in it: the machine
  // fetches that over its own channel.
  args?: string[];
}

const resultLine = (text: string): string =>
  `${JSON.stringify({ type: 'result', is_error: false, result: text, session_id: 'worker-session' })}\n`;

// What a Worker's last message looks like in stdout.ndjson.
export const receiptOutput = (receipt: unknown): string =>
  resultLine(`好了\n\`\`\`receipt\n${JSON.stringify(receipt)}\n\`\`\``);

export function fakeRemote() {
  const runs = new Map<string, RemoteRun>();
  const calls: Call[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const held = new Set<PromiseWithResolvers<void>>();
  // Run directory by Run, as a listing of the instance would find them.
  const dirs = new Map<string, string>();
  const captures=new Map<string,{executor:string;capture:CaptureSpec}>();
  // The highest round marker in each Task directory. Markers are never removed, so the
  // highest is all a start or a watch reads from them.
  const rounds = new Map<string, number>();

  function runOf(id: string): RemoteRun {
    let run = runs.get(id);
    if (!run) {
      run = {
        started: false, launcher_alive: false, pid_alive: false, marked: false, exit: null,
        stdout: '', stderr: '', revoked: false, host: undefined, round: undefined,
      };
      runs.set(id, run);
    }
    return run;
  }

  const alive = (run: RemoteRun): boolean => run.pid_alive || run.marked || run.launcher_alive;

  const remote = {
    // False: no machine answers. `down` names single machines that do not.
    reachable: true,
    down: new Set<string>(),
    // Machines that answer a probe and then fail the upload.
    uploadFails: new Set<string>(),
    // start.sh did its work and the answer never came back.
    startReplyLost: false,
    // The start never arrived: nothing ran, and the caller only knows it got no answer.
    startLost: false,
    startRefused: undefined as string | undefined,
    // stop.sh signals, and the group stays.
    unkillable: false,
    // list-runs.sh runs and exits with an error.
    listFails: false,
    // Machines whose client is not connected now.
    away: new Set<string>(),
    // What a machine received, when a test asks to keep it: a directory of this fake's
    // own holding the files an upload put there. The Runner drops its copy as soon as the
    // upload returns, so nothing else can look at what was sent.
    keepUploads: false,
    uploads: new Map<string, string>(),
    calls,
    rounds,
    runOf,

    called: (script: string, runId?: string, host?: string): number =>
      calls.filter((call) => call.script === script && (runId === undefined || call.runId === runId) && (host === undefined || call.host === host)).length,

    // The named script, 'upload' or 'read', waits in place, already recorded, until the returned call.
    hold(script: string): () => void {
      const gate = Promise.withResolvers<void>();
      gates.set(script, gate);
      held.add(gate);
      return () => {
        if (gates.get(script) === gate) gates.delete(script);
        held.delete(gate);
        gate.resolve();
      };
    },

    releaseAll(): void {
      gates.clear();
      for (const gate of held) gate.resolve();
      held.clear();
    },

    // The watch beside every Worker takes its look at the rounds: each Run that a later
    // round of its Task has overtaken ends, whole group, and its exit file says why.
    // Until a test calls this, an overtaken Run and the round after it are both alive.
    watchLooks(): string[] {
      const ended: string[] = [];
      for (const [id, run] of runs) {
        const taskId = dirs.get(id)?.split('/')[2];
        if (taskId === undefined || run.round === undefined || !(run.pid_alive || run.marked)) continue;
        if ((rounds.get(taskId) ?? 0) <= run.round) continue;
        Object.assign(run, { pid_alive: false, marked: false, exit: SUPERSEDED_EXIT });
        ended.push(id);
      }
      return ended;
    },

    // The Worker's last act: the output, then the exit file, then nothing running.
    finish(id: string, receipt: unknown, exit = 0): void {
      Object.assign(runOf(id), { stdout: receiptOutput(receipt), exit, pid_alive: false, marked: false, launcher_alive: false });
    },

    connect(machine?: Machine): RemoteHost {
      const name = machine?.host ?? 'h1';
      const answer = (): void => {
        if (!remote.reachable || remote.down.has(name)) throw new Unreachable(`连不上 ${name}`);
      };
      return {
        // Placing a snapshot: the same call the upload used to be, recorded under the name
        // the scripts gave it so the tests that count calls read the same way. The run
        // directory is the one without `/snapshot`, so its own name is the Run's.
        async place(runDir, localDir) {
          calls.push({ script: 'upload', runId: basename(runDir), host: name });
          await gates.get('upload')?.promise;
          answer();
          if (remote.uploadFails.has(name)) throw new Unreachable(`${name} 上传失败`);
          dirs.set(basename(runDir), runDir);
          const meta=join(localDir,'output.json');if(existsSync(meta))captures.set(basename(runDir),JSON.parse(readFileSync(meta,'utf8')));
          if (remote.keepUploads) {
            const kept = mkdtempSync(join(tmpdir(), 'tycho-uploaded-'));
            cpSync(localDir, kept, { recursive: true });
            remote.uploads.set(basename(runDir), kept);
          }
          // What the machine reports having written. These scripts report nothing, so the
          // Runner has nothing to compare here; a test about the hash check brings its own
          // host.
          return [];
        },

        async start(request) {
          const runId = basename(request.runDir);
          const envArgs = Object.entries(request.env).map(([name, value]) => `${name}=${value}`);
          calls.push({
            script: 'start.sh', runId, host: name,
            args: [request.runDir, String(request.round), request.credential?.variable ?? '', ...envArgs, ...(request.invite ? ['--invite'] : []), '--', ...request.argv],
          });
          await gates.get('start.sh')?.promise;
          answer();
          const run = runOf(runId);
          if (remote.startLost) throw new Unreachable('启动没有送到');
          // The machine said before it tried that it would start nothing, and why: no gate taken.
          if (remote.startRefused !== undefined) return { code: 2, stdout: '', stderr: remote.startRefused, confirmed: false, pid: undefined, started_at: null };
          const taken = run.started;
          run.started = true;
          if (run.revoked) return { code: START_REVOKED, stdout: '', stderr: '', confirmed: false, pid: undefined, started_at: null };
          if (!taken) {
            // The round markers: this round publishes its own, then reads the highest.
            // A later one already there, and this is an old Run arriving late.
            const latest = Math.max(rounds.get(request.taskId) ?? 0, request.round);
            rounds.set(request.taskId, latest);
            if (latest > request.round) {
              run.exit = SUPERSEDED_EXIT;
              return { code: START_SUPERSEDED, stdout: '', stderr: '', confirmed: false, pid: undefined, started_at: null };
            }
            // Earlier rounds still alive stay alive: ending them is their watch's
            // doing, ten seconds or so later, and `watchLooks` is that moment.
            Object.assign(run, { pid_alive: true, marked: true, host: name, round: request.round });
          }
          if (remote.startReplyLost) throw new Unreachable('启动的回答丢了');
          return { code: 0, stdout: 'started 42\n', stderr: '', confirmed: true, pid: 42, started_at: new Date(0).toISOString() };
        },

        async stop(runDir) {
          const runId = basename(runDir);
          calls.push({ script: 'stop.sh', runId, host: name });
          await gates.get('stop.sh')?.promise;
          answer();
          const run = runOf(runId);
          // Takes the gate too: a start on its way will not run.
          Object.assign(run, { revoked: true, started: true });
          if (!remote.unkillable) Object.assign(run, { pid_alive: false, marked: false, launcher_alive: false });
        },

        async state(runDir) {
          calls.push({ script: 'state.sh', runId: basename(runDir), host: name });
          await gates.get('state.sh')?.promise;
          answer();
          const { started, launcher_alive, pid_alive, marked, exit, unknown, not_started } = runOf(basename(runDir));
          return { started, launcher_alive, pid_alive, marked, exit, unknown: unknown ?? null, ...(not_started === undefined ? {} : { not_started }) };
        },

        async list({ aliveOnly }) {
          calls.push({ script: 'list-runs.sh', runId: undefined, host: name });
          await gates.get('list-runs.sh')?.promise;
          answer();
          // The machine answered and could not build the listing: that is ListingFailed and
          // not "the machine has gone" (runner/host.ts), and the Runner's sweep logs it.
          if (remote.listFails) throw new ListingFailed('list-runs.sh 退出码 1：读不了进程表');
          return [...dirs]
            .filter(([id]) => !aliveOnly || (runOf(id).host === name && alive(runOf(id))))
            .map(([id, dir]) => ({ task_id: dir.split('/')[2]!, run_id: id }));
        },

        async readResult(request){
          calls.push({script:'read',runId:undefined,host:name});await gates.get('read')?.promise;answer();
          const id=basename(request.run_dir),meta=captures.get(id),run=runOf(id);
          if(!meta)return {state:'missing',source:request.source,size:0,sha256:null,offset:request.offset,base64:''};if(meta.capture.source!==request.source)throw new Error('fixture has no matching prepared capture');
          if(run.exit===null)return {state:'pending',source:request.source,size:0,sha256:null,offset:request.offset,base64:''};
          const reader=ADAPTERS[meta.executor]!.resultReader!({recordBytes:meta.capture.result_bytes,stateBytes:meta.capture.result_bytes,stderrBytes:meta.capture.result_bytes});reader.feedStdout(Buffer.from(run.stdout));reader.feedStderr(Buffer.from(run.stderr));
          const bytes=Buffer.from(JSON.stringify({version:1,source:request.source,state:'ready',reading:reader.finish(run.exit)}));
          return {state:'ready',source:request.source,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),offset:request.offset,base64:bytes.subarray(request.offset,request.offset+request.bytes).toString('base64')};
        },
        async readCapture(request){
          calls.push({script:'read',runId:undefined,host:name});await gates.get('read')?.promise;answer();
          const id=basename(request.run_dir),meta=captures.get(id),run=runOf(id);if(!meta)return {state:'unavailable',source:request.source,reason:'capture was never prepared'};if(meta.capture.source!==request.source)throw new Error('fixture capture not prepared');
          const bytes=Buffer.from(request.stream==='stdout'?run.stdout:run.stderr);
          return {state:'range',source:request.source,base:0,start:request.offset,end:bytes.length,committed_end:bytes.length,base64:bytes.subarray(request.offset,request.offset+request.bytes).toString('base64'),sealed:run.exit!==null};
        },
        async readRange(path, offset) {
          calls.push({ script: 'read', runId: undefined, host: name });
          await gates.get('read')?.promise;
          answer();
          const run = runOf(basename(path.slice(0, path.lastIndexOf('/'))));
          const whole = Buffer.from(path.endsWith('stderr.log') ? run.stderr : run.stdout);
          return { bytes: whole.subarray(offset), size: whole.length, mtime: 1_700_000_000 };
        },

        // A Run that left nothing under artifacts/: this stand-in never has any, and the
        // tests about taking them back bring their own host.
        async artifacts() {
          return [];
        },

        async dropRun() {},

        connected: () => !remote.away.has(name),
      };
    },
  };
  return remote;
}

export type FakeRemote = ReturnType<typeof fakeRemote>;

// Remotes that share nothing, told apart by the client identity of a machine: the same
// name under another identity is another machine, with its own files and its own
// processes. A snapshot uploaded to one is not on the other, which is what one shared home
// cannot show.
export function fakeSites<Identity extends string>(...identities: Identity[]) {
  const sites = Object.fromEntries(identities.map((identity) => [identity, fakeRemote()])) as Record<Identity, FakeRemote>;
  return {
    sites,
    connect(machine: Machine): RemoteHost {
      // A test may name several machines under one client stand-in: `<identity>#<machine>`.
      const site = sites[machine.nodeId.split('#')[0] as Identity];
      if (!site) throw new Error(`没有身份 ${machine.nodeId} 的假机器`);
      return site.connect(machine);
    },
  };
}
