// A sign-in of an executor's own, run on this machine because the login it makes can only live
// here (docs/design/native-login.md: a ChatGPT login of Codex rotates its tokens). This is not a
// remote terminal:
//   - the command is the one this program's adapter declares (`signIn.argv`); the host names
//     an executor and nothing else, and nothing it sends reaches a command line;
//   - it is found and started the way a probe is (node/launch.ts), in this machine's lookup
//     environment and as this machine's user, with nothing typed into it: the login it writes
//     is this machine's own, in the executor's own directory;
//   - what it prints stays in memory, bounded, and is read only by the adapter's `read`. The
//     link and the code that reads out go to the host and nowhere else: not to a file, not to a
//     log — a log says what happened and, at most, the link.
// Every one is ended by the handle this client started it with, and its tree: never by a name.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { MachineSignIn } from '../adapters/types.ts';
import type { NodeSignIn, NodeSignInReason, NodeSignInState } from '../shared/node-protocol.ts';
import { signInEnded } from '../shared/node-protocol.ts';
import { stopProbeTree } from './hostprocess.ts';
import type { HostProcesses } from './hostprocess.ts';
import { CommandMissing, launchOf } from './launch.ts';

// How much of what a sign-in printed is kept to read from: the screen that matters is a few
// lines, and a command that prints without end must not grow this process.
export const SIGN_IN_OUTPUT_BYTES = 64 * 1024;
// A command that says no limit, or one that cannot be read, still ends.
const DEFAULT_LIMIT_MS = 15 * 60 * 1000;

interface Held {
  id: string;
  executor: string;
  state: NodeSignInState;
  url?: string;
  code?: string;
  acceptsCode?: boolean;
  reason?: NodeSignInReason;
  child?: ChildProcess;
  output: string;
  timer?: NodeJS.Timeout;
  // Settled once its process is gone (or there never was one).
  over: Promise<void>;
  finish(): void;
}

export interface SignInOptions {
  // The adapters this machine's program ships, by executor: only their `signIn` is read.
  adapters: Readonly<Record<string, { signIn?: MachineSignIn }>>;
  // The machine's lookup environment (node/lookup-env.ts): what the command is found and run in.
  lookupEnv: () => Promise<NodeJS.ProcessEnv>;
  // Directories no command is looked up in (node/launch.ts).
  exclude: string[];
  procs?: HostProcesses;
  log: (line: string) => void;
  // A sign-in ended 0: the machine looks at its executors again, so the host hears it is
  // signed in without waiting for the clock.
  onDone: () => void;
  platform?: NodeJS.Platform;
}

export function createMachineSignIns(options: SignInOptions) {
  const platform = options.platform ?? process.platform;
  const held = new Map<string, Held>();

  const viewOf = (each: Held): NodeSignIn => ({
    id: each.id, executor: each.executor, state: each.state,
    ...(each.url === undefined ? {} : { url: each.url }),
    ...(each.code === undefined ? {} : { code: each.code }),
    ...(each.acceptsCode ? { accepts_code: true } : {}),
    ...(each.reason === undefined ? {} : { reason: each.reason }),
  });

  function settle(each: Held, state: NodeSignInState, reason?: NodeSignInReason): void {
    if (signInEnded(each.state)) return;
    each.state = state;
    each.acceptsCode = false;
    if (reason !== undefined) each.reason = reason;
    clearTimeout(each.timer);
  }

  // Its tree ended by the handle it was started with; the pipes are let go of whatever the
  // look at the table says, so a child left holding them cannot hold this client.
  async function end(each: Held, state: NodeSignInState, reason?: NodeSignInReason): Promise<void> {
    const child = each.child;
    settle(each, state, reason);
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const confirmed = await stopProbeTree(child.pid, platform, options.procs).catch(() => false);
      if (!confirmed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Gone already.
        }
        options.log(`${each.executor} 的登录程序（pid ${child.pid}）没能确认已经结束`);
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    each.finish();
    await each.over;
  }

  function hold(id: string, executor: string): Held {
    const finished = Promise.withResolvers<void>();
    const each: Held = { id, executor, state: 'starting', output: '', over: finished.promise, finish: () => finished.resolve() };
    held.set(id, each);
    return each;
  }

  return {
    // Started, and answered at once: what becomes of it rides the polls.
    async start(command: { sign_in_id: unknown; executor: unknown; timeout_ms: unknown }): Promise<NodeSignIn> {
      const id = String(command.sign_in_id);
      const executor = String(command.executor);
      const already = held.get(id);
      if (already) return viewOf(already);
      // One sign-in of an executor at a time: a new one ends the one before it.
      for (const other of held.values()) {
        if (other.executor === executor && !signInEnded(other.state)) void end(other, 'cancelled');
      }
      const each = hold(id, executor);
      const signIn = Object.hasOwn(options.adapters, executor) ? options.adapters[executor]!.signIn : undefined;
      if (signIn === undefined) {
        options.log(`登录 ${id}：这台机器上的 tycho 不能替 ${executor} 登录`);
        settle(each, 'failed', 'missing');
        each.finish();
        return viewOf(each);
      }
      const limit = typeof command.timeout_ms === 'number' && command.timeout_ms > 0 ? command.timeout_ms : DEFAULT_LIMIT_MS;
      let child: ChildProcess;
      try {
        const env = await options.lookupEnv();
        // Cancelled while the environment was being read: nothing is started.
        if (signInEnded(each.state)) {
          each.finish();
          return viewOf(each);
        }
        const launch = launchOf(signIn.argv, env, platform, { exclude: options.exclude });
        child = spawn(launch.command, launch.args, {
          env,
          stdio: [signIn.acceptsCode ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: launch.verbatim,
          // A group of its own where there are groups, so that ending it reaches what it started.
          detached: platform !== 'win32',
        });
        child.stdin?.on('error', () => {});
      } catch (error) {
        options.log(`登录 ${id}：${executor} 的登录命令起不来：${error instanceof CommandMissing ? error.message : (error as Error).message}`);
        settle(each, 'failed', 'missing');
        each.finish();
        return viewOf(each);
      }
      each.child = child;
      options.log(`登录 ${id}：在这台机器上开始 ${executor} 的登录（pid ${child.pid ?? '无'}）`);
      const take = (chunk: Buffer): void => {
        each.output = (each.output + chunk.toString('utf8')).slice(-SIGN_IN_OUTPUT_BYTES);
        if (each.state !== 'starting') return;
        let read: { url: string; code?: string } | undefined;
        try {
          read = signIn.read(each.output);
        } catch {
          read = undefined;
        }
        if (read === undefined || (!signIn.acceptsCode && read.code === undefined)) return;
        each.state = 'waiting';
        each.url = read.url;
        if (read.code !== undefined) each.code = read.code;
        if (signIn.acceptsCode) each.acceptsCode = true;
        options.log(`登录 ${id}：读到了验证网址 ${read.url}，等主人去授权`);
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (signInEnded(each.state)) return;
        options.log(`登录 ${id}：${executor} 的登录命令起不来：${error.code ?? error.message}`);
        settle(each, 'failed', error.code === 'ENOENT' ? 'missing' : 'exit');
        each.finish();
      });
      child.once('close', (code) => {
        options.log(`登录 ${id}：${executor} 的登录命令结束，退出码 ${code ?? '无'}`);
        each.finish();
        // A cancel that came as the command finished signing in does not undo the sign-in.
        if (code === 0 && each.state === 'cancelled') {
          each.state = 'done';
          options.onDone();
          return;
        }
        if (signInEnded(each.state)) return;
        if (code === 0) {
          settle(each, 'done');
          options.onDone();
        } else {
          settle(each, 'failed', 'exit');
        }
      });
      each.timer = setTimeout(() => {
        options.log(`登录 ${id}：到了时限（${limit} 毫秒），结束登录程序`);
        void end(each, 'failed', each.state === 'waiting' || each.state === 'exchanging' ? 'timeout' : 'unreadable');
      }, limit);
      each.timer.unref?.();
      return viewOf(each);
    },

    // Write the owner's pasted authorization code (or callback URL) once to stdin and close it.
    submitCode(id: string, rawCode: string): NodeSignIn {
      const each = held.get(id);
      if (!each) return { id, executor: '', state: 'failed', reason: 'exit' };
      const clean = rawCode.replace(/[\r\n\0]+/g, '').trim();
      if (each.state !== 'waiting' || !each.acceptsCode || !clean || !each.child?.stdin || each.child.stdin.destroyed) {
        return viewOf(each);
      }
      each.state = 'exchanging';
      each.acceptsCode = false;
      options.log(`登录 ${id}：已向 ${each.executor} 提交授权码`);
      try {
        each.child.stdin.end(`${clean}\n`);
      } catch {
        settle(each, 'failed', 'exit');
      }
      return viewOf(each);
    },

    // Safe to repeat, and for one this machine does not know.
    async cancel(id: string): Promise<{ sign_in_id: string; known: boolean }> {
      const each = held.get(id);
      if (each) await end(each, 'cancelled');
      return { sign_in_id: id, known: each !== undefined };
    },

    // What the next poll says.
    report: (): NodeSignIn[] => [...held.values()].map(viewOf),

    // The host's list in a poll answer: an ended one it no longer names has been seen and is
    // forgotten; one under way that it no longer names is over for the host, and is ended here.
    keep(ids: readonly string[]): void {
      const named = new Set(ids);
      for (const [id, each] of held) {
        if (named.has(id)) continue;
        held.delete(id);
        if (!signInEnded(each.state)) {
          options.log(`登录 ${id}：主机已经不记得它了，结束登录程序`);
          void end(each, 'cancelled');
        }
      }
    },

    // The client is leaving: nothing it started outlives it.
    async stopAll(): Promise<void> {
      await Promise.all([...held.values()].map((each) => end(each, 'cancelled')));
    },

    // How many characters of output one sign-in holds: for a test of the bound.
    heldOutput: (id: string): number | undefined => held.get(id)?.output.length,
  };
}

export type MachineSignIns = ReturnType<typeof createMachineSignIns>;
