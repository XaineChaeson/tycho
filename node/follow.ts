// How a machine's client follows the host's version (docs/design/nodes.md §1.4). The shape is
// GitHub's self-hosted runner: the host says which version to run and hands out its package,
// the client installs it beside the one it runs, and — only between rounds, when the machine is
// idle — leaves with a code of its own so that the fixed supervisor starts it again from the
// new version (node/cli.ts).
//
// The two routes it uses are frozen and carry no protocol version (shared/node-protocol.ts):
// they are how a client the host has just refused for its protocol finds out what to install.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { appVersion, isVersion, prefixOf, readCurrent } from '../cli/paths.ts';
import { readRecord, slotOf } from '../cli/record.ts';
import type { NodeReleaseAnswer, NodeReleaseReport } from '../shared/node-protocol.ts';
import { NODE_RELEASE_PACKAGE_PATH, NODE_RELEASE_PATH } from '../shared/node-protocol.ts';

// The code the client leaves with when it has installed the host's version and is idle: the
// supervisor reads it as "start me again from `current`" (node/cli.ts). Any other code is the
// client's own and the supervisor passes it on.
export const SWAP_EXIT = 75;

const DEFAULT_CHECK_MS = 10 * 60 * 1000;
const REQUEST_MS = 60_000;
// How often the refused-poll path (426) looks at this machine while a version is ready. It
// has no poll loop left to decide at the top of, and a look at a live round's processes costs
// a process-table read on Windows, so it does not look every few seconds.
const LEAVE_WHEN_IDLE_MS = 30_000;

// What this machine is doing right now, as "waiting for idle" counts it: rounds this client
// started that are still alive or cannot be said to be over, host commands still being carried
// out, and sign-ins still running.
export interface ReleaseBusy {
  runs: number;
  commands: number;
  signIns: number;
}

// The one definition of "this machine may change version now": nothing running or unclear,
// no command being carried out, no sign-in under way. The poll loop decides with the rounds
// it last surveyed; the 426 path decides with its own look. Both ask this.
export function releaseIdle(busy: ReleaseBusy): boolean {
  return busy.runs === 0 && busy.commands === 0 && busy.signIns === 0;
}

// What this machine is waiting for, in the words the host's page and the client's log share.
export function releaseWaiting(target: string, busy: ReleaseBusy): string {
  if (busy.runs > 0) return `等 ${busy.runs} 轮跑完后换到 ${target}`;
  if (busy.signIns > 0) return '等机器上的登录结束';
  if (busy.commands > 0) return '等手头的命令做完';
  return `现在换到 ${target}`;
}

export interface ReleaseFollowOptions {
  // This client's program directory: the version directory of an installed copy, a checkout
  // when it runs from one.
  appRoot: string;
  // Where the download and the update's own output go: this identity's directory.
  identityDir: string;
  origin: string;
  token: string;
  log: (line: string) => void;
  busy: () => Promise<ReleaseBusy>;
  // Ends the poll loop, for good: the process is about to leave with SWAP_EXIT.
  stopPolling: () => void;
  fetch?: typeof globalThis.fetch;
  // How the installed copy is upgraded. A test gives one; the real one runs `tycho update`.
  update?: (entry: string, args: string[]) => Promise<{ code: number | null; tail: string }>;
  now?: () => number;
}

// The host's answer to "which version should I be, and where is it": the same call the follow
// loop makes and `tycho node status` makes (a status question reports the last state this
// machine knew, never a fresh null that would erase it on the host's page).
export async function askRelease(options: {
  origin: string;
  token: string;
  version: string;
  upgrade: NodeReleaseReport['upgrade'];
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<NodeReleaseAnswer> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const clock = AbortSignal.timeout(REQUEST_MS);
  const signal = options.signal === undefined ? clock : AbortSignal.any([clock, options.signal]);
  const response = await doFetch(`${options.origin.replace(/\/+$/, '')}${NODE_RELEASE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
    body: JSON.stringify({ version: options.version, upgrade: options.upgrade } satisfies NodeReleaseReport),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `主机回答 ${response.status}`);
  const answer = (text === '' ? {} : JSON.parse(text)) as Partial<NodeReleaseAnswer>;
  if (typeof answer.version !== 'string' || !isVersion(answer.version)) throw new Error('主机没有说它跑的是哪一版');
  const pkg = answer.package ?? null;
  if (pkg !== null && (!pkg || typeof pkg.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pkg.sha256) || !Number.isSafeInteger(pkg.bytes) || pkg.bytes <= 0)) {
    throw new Error('主机给的发布包信息读不出来');
  }
  return {
    version: answer.version,
    package: pkg,
    why: typeof answer.why === 'string' ? answer.why : null,
    check_every_ms: typeof answer.check_every_ms === 'number' && answer.check_every_ms > 0 ? answer.check_every_ms : DEFAULT_CHECK_MS,
  };
}

// What this machine last told the host about its version, kept where `tycho node status` reads
// it without asking the running client (which is another process).
export interface ReleaseStatus {
  version: string;
  host: string | null;
  at: string;
  upgrade: NodeReleaseReport['upgrade'];
}

export function releaseStatusFile(identityDir: string): string {
  return join(identityDir, 'release', 'status.json');
}

export function readReleaseStatus(identityDir: string): ReleaseStatus | null {
  try {
    const held = JSON.parse(readFileSync(releaseStatusFile(identityDir), 'utf8')) as Partial<ReleaseStatus>;
    if (typeof held.version !== 'string' || !isVersion(held.version)) return null;
    const up = held.upgrade;
    const upgrade = up === null || up === undefined ? null
      : typeof up === 'object' && (up.state === 'waiting' || up.state === 'failed') && typeof up.target === 'string' && typeof up.detail === 'string'
        ? { state: up.state, target: up.target, detail: up.detail }
        : null;
    return {
      version: held.version,
      host: typeof held.host === 'string' ? held.host : null,
      at: typeof held.at === 'string' ? held.at : new Date(0).toISOString(),
      upgrade,
    };
  } catch {
    return null;
  }
}

export function createReleaseFollow(options: ReleaseFollowOptions) {
  const own = appVersion(options.appRoot);
  const prefix = prefixOf(options.appRoot);
  const releaseDir = join(options.identityDir, 'release');
  const statusFile = releaseStatusFile(options.identityDir);
  const now = options.now ?? Date.now;
  const log = options.log;

  let hostVersion: string | null = null;
  let target: string | null = null;
  let upgrade: NodeReleaseReport['upgrade'] = null;
  let at = new Date(now()).toISOString();
  // The version this installation is on is the target: it may still be on the old program,
  // and leaves as soon as nothing is running.
  let ready = false;
  // The case where this installation already contains the target and only `current` has not
  // moved to it yet (the host's own upgrade on the same computer): its `current` changing is
  // what makes the client ready.
  let awaitingCurrent = false;
  let swapped = false;
  let stopped = false;
  let checkEvery = DEFAULT_CHECK_MS;
  let lastDetail: string | null = null;
  // A target that could not be installed is not tried again until the next check.
  let failedAt: number | null = null;
  let failedTarget: string | null = null;
  let lastCheck = 0;
  let checkTimer: ReturnType<typeof setInterval> | undefined;
  let checking: Promise<'same' | 'handled'> | null = null;

  function writeStatus(): void {
    const held: ReleaseStatus = { version: own, host: hostVersion, at, upgrade };
    try {
      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(statusFile, `${JSON.stringify(held)}\n`, { mode: 0o600 });
    } catch (err) {
      log(`记下换版状态没做成：${(err as Error).message}`);
    }
  }

  async function report(): Promise<void> {
    try {
      await askRelease({ origin: options.origin, token: options.token, version: own, upgrade, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    } catch (err) {
      // A report that cannot go out is not a reason to stop working: the host asks again when
      // it is reachable (it keeps the last one otherwise).
      log(`把换版状态报给主机没成：${(err as Error).message}`);
    }
  }

  // Says what this machine is waiting for, and reports it when it changed. The host's page and
  // the client's log say the same thing.
  async function sayWaiting(detail: string): Promise<void> {
    if (target === null) return;
    const changed = upgrade === null || upgrade.state !== 'waiting' || upgrade.detail !== detail;
    if (changed) {
      upgrade = { state: 'waiting', target, detail };
      at = new Date(now()).toISOString();
      writeStatus();
      // The host already has this state: a machine that keeps waiting is not a new report
      // with every poll.
      await report();
    }
    if (detail !== lastDetail) {
      lastDetail = detail;
      log(`换版本：${detail}`);
    }
  }

  async function sayFailed(detail: string): Promise<void> {
    // One line, as the frozen report carries it: an installer's coloured output is not
    // something the host's page can take.
    const last = detail.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().split('\n').at(-1)?.trim().slice(0, 300) || '没说原因';
    upgrade = { state: 'failed', target: target ?? hostVersion ?? own, detail: last };
    at = new Date(now()).toISOString();
    failedAt = now();
    failedTarget = target;
    lastDetail = last;
    writeStatus();
    log(`换版没成功：${last}`);
    await report();
  }

  async function ask(): Promise<NodeReleaseAnswer> {
    const answer = await askRelease({
      origin: options.origin, token: options.token, version: own, upgrade,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    hostVersion = answer.version;
    target = answer.version;
    if (Number.isFinite(answer.check_every_ms) && answer.check_every_ms > 0) checkEvery = answer.check_every_ms;
    return answer;
  }

  // The real update: the version `current` names runs its own `update --from`, the same
  // command the owner would type, on the package the host packed for it.
  async function runUpdate(entry: string, args: string[]): Promise<{ code: number | null; tail: string }> {
    if (options.update !== undefined) return options.update(entry, args);
    mkdirSync(releaseDir, { recursive: true });
    const out = join(releaseDir, 'update.log');
    rmSync(out, { force: true });
    const fd = openSync(out, 'a');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
        stdio: ['ignore', fd, fd], windowsHide: true, env: process.env,
      });
    } finally {
      closeSync(fd);
    }
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exited) => resolve(exited));
    });
    let tail = '';
    try {
      tail = readFileSync(out, 'utf8').split('\n').filter((line) => line.trim() !== '').at(-1)?.trim() ?? '';
    } catch {
      // Nothing was written: the exit code is all there is.
    }
    return { code: code ?? 1, tail };
  }

  async function download(target: string, expected: { sha256: string; bytes: number }): Promise<string> {
    const doFetch = options.fetch ?? globalThis.fetch;
    const signal = AbortSignal.timeout(REQUEST_MS);
    const response = await doFetch(`${options.origin.replace(/\/+$/, '')}${NODE_RELEASE_PACKAGE_PATH}`, {
      headers: { Authorization: `Bearer ${options.token}` }, signal,
    });
    if (!response.ok) throw new Error(`取发布包没成：${response.status} ${(await response.text()).trim()}`);
    const body = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (body.length !== expected.bytes || sha256 !== expected.sha256) {
      throw new Error(`取回的发布包不对：收到 ${body.length} 字节、${sha256}，应当是 ${expected.bytes} 字节、${expected.sha256}`);
    }
    mkdirSync(releaseDir, { recursive: true });
    const file = join(releaseDir, `${target}.tar.gz`);
    const incoming = `${file}.incoming`;
    writeFileSync(incoming, body);
    rmSync(file, { force: true });
    renameSync(incoming, file);
    return file;
  }

  // One decision, as the table in docs/design/nodes.md §1.4 spells it out. Returns 'same' only
  // when this client already runs the host's version — the one case a protocol refusal is not
  // about versions.
  async function decide(): Promise<'same' | 'handled'> {
    const answer = await ask();
    if (own === target) {
      upgrade = null;
      ready = false;
      awaitingCurrent = false;
      at = new Date(now()).toISOString();
      writeStatus();
      return 'same';
    }
    // A checkout has no version directory to install into, and it is not an installation the
    // host can hand a package to.
    if (prefix === null) {
      ready = false;
      awaitingCurrent = false;
      await sayFailed('客户端从源码目录运行，不会自己换版本');
      return 'handled';
    }
    const current = readCurrent(prefix);
    if (current === target) {
      ready = true;
      awaitingCurrent = false;
      // The exact "what it is waiting for" is filled in after the next poll, from the rounds
      // that poll carried; this says the machine is on the target and waiting to be idle.
      await sayWaiting(`等这台机器空闲后换到 ${target}`);
      return 'handled';
    }
    // The host's role is installed in this same installation: installing would stop the
    // service on this computer, so the client waits for that upgrade to reach `current`.
    if (slotOf(readRecord(prefix), 'host') !== undefined) {
      ready = false;
      awaitingCurrent = true;
      await sayWaiting('这份安装上的主机升级后跟上');
      return 'handled';
    }
    if (answer.package === null) {
      ready = false;
      awaitingCurrent = false;
      await sayFailed(answer.why ?? '主机没有可下发的发布包');
      return 'handled';
    }
    if (!isVersion(target)) {
      ready = false;
      awaitingCurrent = false;
      await sayFailed(`主机给的版本号不能当目录名用：${target}`);
      return 'handled';
    }
    // Not before the next check: the same target that just failed is not retried in a loop.
    if (failedTarget === target && failedAt !== null && now() - failedAt < checkEvery) {
      ready = false;
      return 'handled';
    }
    let file: string | null = null;
    try {
      file = await download(target, answer.package);
      const entry = join(prefix, 'versions', current ?? own, 'cli', 'main.ts');
      if (!existsSync(entry)) throw new Error(`这份安装里没有 ${entry}：换版本要由 current 那一版自己来做`);
      const ran = await runUpdate(entry, ['update', '--from', file, '--expect-version', target, '--expect-sha256', answer.package.sha256]);
      const after = readCurrent(prefix);
      if (ran.code !== 0 || after !== target) {
        ready = false;
        awaitingCurrent = false;
        await sayFailed(ran.tail !== '' ? ran.tail : `更新程序退出码 ${ran.code ?? '无'}，当前版本是 ${after ?? '未知'}`);
        return 'handled';
      }
      ready = true;
      awaitingCurrent = false;
      await sayWaiting(`等这台机器空闲后换到 ${target}`);
      return 'handled';
    } catch (err) {
      ready = false;
      awaitingCurrent = false;
      await sayFailed((err as Error).message);
      return 'handled';
    } finally {
      if (file !== null) rmSync(file, { force: true });
    }
  }

  function runCheck(): Promise<'same' | 'handled'> {
    if (checking !== null) return checking;
    lastCheck = now();
    checking = decide()
      .catch((err: unknown) => {
        // Asking is not working: keep whatever this client knew, and try again on the clock.
        log(`问主机该跑哪一版没成：${(err as Error).message}`);
        return 'handled' as const;
      })
      .finally(() => {
        checking = null;
      });
    return checking;
  }

  // Called when this machine starts, after a reconnect, and when the host refuses its protocol.
  // The protocol refusal is the one case that must not end in the ordinary error: the answer is
  // to install the host's version, not to exit with a mismatch.
  async function checkOnStart(): Promise<void> {
    await runCheck();
    startCheckTimer();
  }

  function startCheckTimer(): void {
    if (stopped) return;
    if (checkTimer !== undefined) return;
    // A tick, not a timer set to the interval: the host may change check_every_ms with any
    // answer, and a poll answer must not push the next check further out.
    checkTimer = setInterval(() => {
      if (now() - lastCheck >= checkEvery) void runCheck();
    }, 1_000);
    checkTimer.unref?.();
  }

  // After a poll that worked: the host may have changed its version, and the clock may have
  // changed with its answer. The "waiting for" line is filled in from the rounds that poll
  // carried, so nothing looks at the machine's processes on its own.
  function afterPoll(busy: ReleaseBusy): Promise<void> {
    startCheckTimer();
    const version = swapTarget();
    if (version === null) return Promise.resolve();
    return sayWaiting(releaseWaiting(version, busy));
  }

  // The synchronous "is this installation on the target already, and which version is it"
  // the poll loop asks at the top of each round. It also picks up the one case that changes
  // without a new decision: this installation already held the target and the host's own
  // upgrade has moved `current` to it since.
  function swapTarget(): string | null {
    if (stopped || swapped || target === null) return null;
    if (!ready && awaitingCurrent && prefix !== null && readCurrent(prefix) === target) {
      ready = true;
      awaitingCurrent = false;
    }
    return ready ? target : null;
  }

  // The caller has decided the machine is idle on the target (node/client.ts, at the top of
  // the poll loop). The last report is best-effort: a host that cannot be reached must not
  // keep a machine that is ready to move on the version it already replaced.
  function swapNow(): void {
    const version = swapTarget();
    if (version === null) return;
    const detail = `现在换到 ${version}`;
    upgrade = { state: 'waiting', target: version, detail };
    at = new Date(now()).toISOString();
    writeStatus();
    log(`换版本：${detail}`);
    swapped = true;
    if (checkTimer !== undefined) clearInterval(checkTimer);
    checkTimer = undefined;
    void report();
    options.stopPolling();
  }

  // Until it may leave, or until something else asks the process to stop (a service stop, a
  // leave). Used after a protocol refusal, when the poll loop is gone but rounds it started
  // keep running: the client stays until they are done, then leaves with SWAP_EXIT. It asks
  // the same "idle" question as the poll loop, far less often because there is no poll to
  // come back from.
  async function leaveWhenIdle(signal?: AbortSignal): Promise<void> {
    while (!swapped && !stopped && signal?.aborted !== true) {
      const busy = await options.busy();
      if (releaseIdle(busy)) {
        swapped = true;
        if (checkTimer !== undefined) clearInterval(checkTimer);
        checkTimer = undefined;
        options.stopPolling();
        return;
      }
      try {
        await sleep(LEAVE_WHEN_IDLE_MS, undefined, { signal });
      } catch {
        return;
      }
    }
  }

  return {
    // What the client's own start asks.
    start(): Promise<void> {
      return checkOnStart();
    },
    afterPoll,
    // The poll loop's own two steps, at the top of each round: ask whether this installation
    // is on the target, then — once the loop's last survey says nothing is running — leave.
    swapTarget,
    swapNow,
    // A 426 from the host: the one question that decides whether this is a version problem at
    // all. True means this client already runs the host's version, so the error stands.
    async mismatch(error: Error, signal?: AbortSignal): Promise<boolean> {
      const outcome = await runCheck();
      if (outcome === 'same') return true;
      // Not retried in a tight loop: this process leaves with SWAP_EXIT and the supervisor
      // brings it back at once, so a machine that cannot move waits a whole check interval
      // before leaving.
      if (!ready) {
        try {
          await sleep(checkEvery, undefined, { signal });
        } catch {
          // Asked to stop while waiting: the ordinary shutdown is next.
        }
      }
      return false;
    },
    leaveWhenIdle,
    swapped: (): boolean => swapped,
    status: (): ReleaseStatus => ({ version: own, host: hostVersion, at, upgrade }),
    checkEveryMs: (): number => checkEvery,
    stop(): void {
      stopped = true;
      if (checkTimer !== undefined) clearInterval(checkTimer);
      checkTimer = undefined;
    },
  };
}
