// Sign-ins of an executor made on a machine itself, started from the console (docs/design/
// native-login.md): the host says which executor on which machine, the machine runs its own
// adapter's command and reports how it goes on its polls (node/sign-in.ts). Nothing here is a
// remote terminal, and nothing here is kept: the sessions live in memory only, a restart forgets
// them (the machine then ends its own, since the host no longer names them), and the link and
// the one-time code never reach a log, a change row or an event.
import { randomUUID } from 'node:crypto';
import type { Adapter } from '../adapters/types.ts';
import type { NodeSignIn } from '../shared/node-protocol.ts';
import { signInEnded } from '../shared/node-protocol.ts';
import { SIGN_IN_REASON_TEXT, signInLive } from '../shared/sign-in.ts';
import type { SignInReason, SignInState, SignInView } from '../shared/sign-in.ts';
import { InputError } from './errors.ts';
import type { Ledger } from './ledger.ts';
import { NodeAway, NodeRefused } from './nodes.ts';
import type { Nodes } from './nodes.ts';
import { unusableHere } from './readonly.ts';

// How long an ended sign-in stays for the page to read.
const ENDED_KEEP_MS = 10 * 60 * 1000;
// How often the sessions are looked at for one that has gone quiet.
const SWEEP_MS = 1000;

interface Session {
  id: string;
  machine: string;
  executor: string;
  state: SignInState;
  url: string | null;
  code: string | null;
  acceptsCode: boolean;
  reason: SignInReason | null;
  startedAt: number;
  endedAt: number | null;
  // Whether the machine is still told the host holds it (the poll answer's `sign_ins`). It stops
  // once the machine has reported an ending, or once the host has given up on it: then a machine
  // still running it ends it by itself.
  listed: boolean;
  awaySince: number | null;
}

export interface SignInsOptions {
  ledger: Pick<Ledger, 'getMachine' | 'getMachineLogin' | 'listActiveRuns' | 'clearMachineLoginRefusal'> & Partial<Pick<Ledger, 'signedInAgain'>>;
  nodes: Pick<Nodes, 'connected' | 'reportedExecutors' | 'send'>;
  executors: Readonly<Record<string, Pick<Adapter, 'signIn' | 'minVersion'>>>;
  // How long one sign-in may take on the machine (accounts.loginTimeoutMs), and how long past
  // that, or past the machine going away, the host waits to hear from it (accounts.loginCleanupMs).
  limitMs: () => number;
  graceMs: () => number;
  // In degraded mode no command reaches a machine: the sessions under way are given up.
  barriers?: () => { degraded: boolean; recovering: boolean };
  now?: () => number;
  log: (line: string) => void;
  // A test sweeps by hand.
  sweepMs?: number;
}

export function createSignIns(options: SignInsOptions) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();

  const live = (each: Session): boolean => signInLive(each.state);

  function view(each: Session): SignInView {
    const reported = options.nodes.reportedExecutors(each.machine)?.executors.find((status) => status.executor === each.executor);
    return {
      id: each.id, machine: each.machine, executor: each.executor, state: each.state,
      url: each.url, code: each.code,
      ...(each.acceptsCode ? { accepts_code: true } : {}),
      reason: each.reason === null ? null : SIGN_IN_REASON_TEXT[each.reason],
      signed_in: reported?.installed === true ? reported.logged_in : null,
    };
  }

  function end(each: Session, state: SignInState, reason: SignInReason | null, listed: boolean): void {
    if (!live(each)) return;
    each.state = state;
    each.acceptsCode = false;
    each.reason = reason;
    each.endedAt = now();
    each.listed = listed;
    options.log(`机器 ${each.machine} 上 ${each.executor} 的登录 ${each.id}：${state}${reason === null ? '' : `（${reason}）`}`);
  }

  // Tell the machine to end it; one that cannot be told hears it from the poll's list instead.
  function tellCancel(each: Session): void {
    options.nodes.send(each.machine, { kind: 'sign_in_cancel', sign_in_id: each.id }).catch(() => {
      each.listed = false;
    });
  }

  function cancelOne(each: Session, reason: SignInReason | null): void {
    if (!live(each)) return;
    end(each, 'cancelled', reason, true);
    tellCancel(each);
  }

  function sweep(): void {
    const at = now();
    const barriers = options.barriers?.();
    if (barriers?.degraded) stopAll();
    for (const [id, each] of sessions) {
      if (each.listed) {
        const here = options.nodes.connected(each.machine);
        each.awaySince = here ? null : (each.awaySince ?? at);
        const away = each.awaySince !== null && at - each.awaySince > options.graceMs();
        const overdue = at - each.startedAt > options.limitMs() + options.graceMs();
        if (away || overdue) {
          if (live(each)) end(each, 'failed', 'no_echo', false);
          each.listed = false;
        }
      }
      if (!live(each) && !each.listed && each.endedAt !== null && at - each.endedAt > ENDED_KEEP_MS) sessions.delete(id);
    }
  }

  function stopAll(): void {
    for (const each of sessions.values()) {
      if (!live(each)) continue;
      end(each, 'cancelled', 'stopped', false);
      // Best effort: in degraded mode nothing is sent, and the machine ends it when the host
      // stops naming it.
      options.nodes.send(each.machine, { kind: 'sign_in_cancel', sign_in_id: each.id }).catch(() => {});
    }
  }

  const timer = setInterval(sweep, options.sweepMs ?? SWEEP_MS);
  timer.unref?.();

  return {
    start(machine: unknown, executor: unknown, machineUid?: unknown): SignInView {
      if (typeof machine !== 'string' || machine === '') throw new InputError('要说清在哪台机器上登录');
      if (typeof executor !== 'string' || executor === '') throw new InputError('要说清登录哪个执行器');
      const registered = options.ledger.getMachine(machine);
      if (!registered || !options.nodes.connected(machine)) {
        throw new InputError(`机器 ${machine} 现在不在线，登录要在它在线时发起`);
      }
      if (machineUid !== undefined && machineUid !== registered.uid) throw new InputError(`机器 ${machine} 的登记已经改变，请刷新页面后重试`);
      const adapter = Object.hasOwn(options.executors, executor) ? options.executors[executor] : undefined;
      if (!adapter?.signIn) throw new InputError(`${executor} 不能从这里登录：tycho 没有在机器上替它登录的办法`);
      const reported = options.nodes.reportedExecutors(machine)?.executors.find((status) => status.executor === executor) ?? null;
      if (reported === null || !reported.installed) {
        throw new InputError(`机器 ${machine} 没有报告装了 ${executor}${reported?.error ? `：${reported.error}` : ''}`);
      }
      const unusable = unusableHere(reported, adapter.signIn.minVersion ?? adapter.minVersion);
      if (unusable !== undefined) throw new InputError(`机器 ${machine} 上的 ${executor} 这一版用不了：${unusable}`);
      // A login that rounds are running as is not changed under them (native-login.md, ruling F).
      const login = options.ledger.getMachineLogin(machine, executor);
      const runs = login === undefined ? [] : options.ledger.listActiveRuns().filter((run) => run.login_id === login.id);
      if (runs.length > 0) {
        const tasks = [...new Set(runs.map((run) => run.task_id))].join('、');
        throw new InputError(`这份登录上还有 ${runs.length} 轮在跑（任务 ${tasks}），等它们结束再登录`);
      }
      for (const other of sessions.values()) {
        if (other.machine === machine && other.executor === executor) cancelOne(other, null);
      }
      const limit = options.limitMs();
      const each: Session = {
        id: randomUUID(), machine, executor, state: 'starting', url: null, code: null, acceptsCode: false, reason: null,
        startedAt: now(), endedAt: null, listed: true, awaySince: null,
      };
      sessions.set(each.id, each);
      options.log(`在机器 ${machine} 上发起 ${executor} 的登录 ${each.id}`);
      options.nodes.send(machine, { kind: 'sign_in', sign_in_id: each.id, executor, timeout_ms: limit }).then(
        (answer) => take(machine, [answer]),
        (error: unknown) => {
          // Not handed over, or refused: nothing runs there. One handed over and not answered in
          // time is the polls' to tell.
          if (error instanceof NodeAway || error instanceof NodeRefused) end(each, 'failed', 'not_delivered', false);
        },
      );
      return view(each);
    },

    get(id: string): SignInView | undefined {
      const each = sessions.get(id);
      return each === undefined ? undefined : view(each);
    },

    cancel(id: string): SignInView | undefined {
      const each = sessions.get(id);
      if (each === undefined) return undefined;
      cancelOne(each, null);
      return view(each);
    },

    async submitCode(id: string, code: unknown): Promise<SignInView | undefined> {
      const each = sessions.get(id);
      if (each === undefined) return undefined;
      if (typeof code !== 'string') throw new InputError('请粘贴有效的授权码或回调网址');
      const trimmed = code.trim();
      if (trimmed === '' || trimmed.length > 4096 || /[\r\n\0]/.test(trimmed)) {
        throw new InputError('请粘贴有效的授权码或回调网址');
      }
      if (each.state !== 'waiting' || !each.acceptsCode) {
        throw new InputError('这次登录当前不在等待授权码状态');
      }
      each.state = 'exchanging';
      each.acceptsCode = false;
      options.log(`机器 ${each.machine} 上 ${each.executor} 的登录 ${each.id}：已提交授权码`);
      try {
        const answer = await options.nodes.send(each.machine, { kind: 'sign_in_code', sign_in_id: each.id, code: trimmed });
        take(each.machine, [answer]);
      } catch (error) {
        if (error instanceof NodeAway || error instanceof NodeRefused) end(each, 'failed', 'not_delivered', false);
        else throw error;
      }
      return view(each);
    },

    // What a machine's poll said about its sign-ins, already in shape (service/nodes.ts).
    reported: (machine: string, entries: readonly NodeSignIn[]): void => take(machine, entries),

    // The ids a poll answer names to this machine.
    listFor(machine: string): string[] {
      return [...sessions.values()].filter((each) => each.machine === machine && each.listed).map((each) => each.id);
    },

    // Whether this machine's polls are to be answered quickly: a sign-in there is under way.
    hurried: (machine: string): boolean => [...sessions.values()].some((each) => each.machine === machine && each.listed),

    // Whether a machine's own login of this executor is being made right now: it takes no new
    // work until that is over (a cancelled one counts until the machine says it has ended).
    busy: (machine: string, executor: string): boolean =>
      [...sessions.values()].some((each) => each.machine === machine && each.executor === executor && (live(each) || (each.state === 'cancelled' && each.listed))),

    sweep,
    stopAll,
    close(): void {
      stopAll();
      clearInterval(timer);
    },
  };

  function take(machine: string, entries: readonly unknown[]): void {
    for (const raw of entries) {
      const entry = raw as Partial<NodeSignIn> | null;
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.state !== 'string') continue;
      const each = sessions.get(entry.id);
      // Only this machine's, and only one this host started.
      if (each === undefined || each.machine !== machine) continue;
      if (each.state === 'done') continue;
      each.awaySince = null;
      // A login finished here is the owner's own doing, not the removal it may have made
      // before: the machine's login is adopted again from its next report. Written before the
      // session is read as ended, so a write that fails is retried by the machine's next poll.
      if (entry.state === 'done' && (live(each) || each.state === 'cancelled')) {
        options.ledger.clearMachineLoginRefusal(machine, each.executor, { actor: 'machine' });
        // Also clear any prior `auth_failed_at` on `login_state` immediately — essential for
        // executors like `gemini` whose probe reports `logged_in: null` and therefore cannot
        // clear `auth_failed_at` via passive executor polling alone.
        const existing = options.ledger.getMachineLogin(machine, each.executor);
        if (existing) options.ledger.signedInAgain?.(existing.id, new Date(Math.max(now(), Date.now()) + 1).toISOString());
      }
      const ended = signInEnded(entry.state);
      if (ended) each.listed = false;
      // An ending the host already wrote stands, except that a cancel and a finished
      // authorisation can cross: the machine's "done" is the truth then.
      if (!live(each)) {
        if (each.state === 'cancelled' && entry.state === 'done') {
          each.state = 'done';
          each.reason = null;
          options.log(`机器 ${machine} 上 ${each.executor} 的登录 ${each.id}：取消时已经登录成功`);
        }
        continue;
      }
      if (entry.state === 'waiting' && typeof entry.url === 'string' && (typeof entry.code === 'string' || entry.accepts_code === true)) {
        // Ignore a stale `waiting` poll that left the machine before `sign_in_code` arrived.
        if (each.state !== 'exchanging') {
          each.url = entry.url;
          each.code = entry.code ?? null;
          each.acceptsCode = entry.accepts_code === true;
          if (each.state === 'starting') options.log(`机器 ${machine} 上 ${each.executor} 的登录 ${each.id}：等主人去授权`);
          each.state = 'waiting';
        }
      } else if (entry.state === 'exchanging') {
        each.state = 'exchanging';
        each.acceptsCode = false;
      }
      if (ended) end(each, entry.state, entry.state === 'failed' ? (entry.reason ?? 'exit') : null, false);
    }
  }
}

export type SignIns = ReturnType<typeof createSignIns>;
