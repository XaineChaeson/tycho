// `tycho node ...`: what runs on a machine that comes back to the host by itself
// (docs/design/nodes.md §1.1). Commands the owner uses, and the one that keeps running:
//
//   tycho node join --to <地址>   加入：打印六位数，等控制台放行，然后常驻
//   tycho node join --to <地址> --material-fd <n>
//                                 临时机器加入：凭任务发的一次性材料（从文件描述符读），不用放行
//   tycho node run               用这台机器已有的身份常驻（加入过之后）
//   tycho node status            这台机器是谁、加入过没有、主机答不答
//   tycho node leave             自己注销：本机不再收活（主机那边的机器还在，要删在控制台删）
//   tycho node service ...       常驻的那一个装成开机自启（cli/main.ts：定义按角色分开）
//
// One client per identity: the resident client takes a lock under its own identity
// directory, and a second one says who is there and leaves (docs/design/nodes.md §7).
import { createServiceObserver } from './service-observation.ts';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { appVersion, prefixOf, readCurrent } from '../cli/paths.ts';
import { joinLocally } from '../cli/service-client.ts';
import { InputError } from '../service/errors.ts';
import { claimLock, holderAlive, lockElsewhere, machineName, readHolder } from '../service/lock.ts';
import { writeOwnerOnly } from '../service/secrets.ts';
import type { Holder } from '../service/lock.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';
import type { NodeJoinAnswer } from '../shared/node-protocol.ts';
import { NodeHttpError, clearLeave, clearPendingJoin, clearClientStop, clearToken, createClient, existingIdentity, factsOf, identityOf, joinHost, leaveRequested, readPendingJoin, readToken, requestLeave, clientStopRequestedFor, writePendingJoin, writeToken } from './client.ts';
import type { NodeIdentity } from './client.ts';
import { SWAP_EXIT, askRelease, readReleaseStatus } from './follow.ts';
import { nodeReleaseText } from '../shared/labels.ts';

const NODE_HELP = `tycho node：让这台机器自己连回主机

用法：
  tycho node join --to <主机地址> [--name <名字>]
                             加入：打印一个六位数，在已经登录的控制台上点侧栏的“放行”，
                             输入这个数（配了企业微信也可以在手机卡片上点放行），然后
                             在这个终端里接着运行；要在后台、开机就运行，用
                             tycho node service install。主机就在这台电脑上、--to 填的是
                             本机地址时，不用放行
  tycho node join --to <主机地址> --material-fd <n> [--name <名字>]
                             任务派生的临时机器加入：从文件描述符 n 读一份一次性接入材料
                             （0 是标准输入），不用六位数、不用放行，然后常驻。材料不要写在
                             命令行上。任务结束、这台机器空闲后，它自己注销并退出
  tycho node run [--to <主机地址>] [--name <名字>]
                             用这台机器已经加入过的身份常驻
  tycho node status          这台机器是谁、加入过没有、客户端在不在跑、主机答不答
  tycho node leave           本机注销：不再收活。主机那边的机器还在，删它到控制台删
  tycho node service install|uninstall|start|stop|status
                             把常驻客户端装成开机自启（和主机服务的自启各管各的，同一台
                             电脑两个角色可以都装）

  --log <文件>               把客户端的输出写到这个文件（开机自启就是这么做的）

同一台机器、同一个身份同时只能有一个客户端在跑：第二个会说明已经有一个（进程号），
然后退出。看管进程不归客户端管：客户端重启、升级、被停，正在跑的那一轮照跑。

主机地址填控制台的对外地址（配了门牌就是门牌的 https 地址），也可以填局域网里的
http://地址:端口。这台机器只要能打开这一个地址就行。`;

// The lock one resident client holds for its identity. Everything about it is
// service/lock.ts's: the holder is a pid and the moment the system says it began, and a
// holder that is gone is taken over rather than waited out (nodes.md §7).
export const CLIENT_LOCK = 'client.lock';
const lockFile = (identity: NodeIdentity): string => join(identity.dir, CLIENT_LOCK);

// The client running under this identity right now, or nothing. Read, never taken: a
// command that only asks must not keep the next client out.
export function readClientHolder(identity: NodeIdentity): Holder | undefined {
  const holder = readHolder(lockFile(identity));
  return holder !== undefined && holderAlive(holder) ? holder : undefined;
}

// What the resident client says about itself beside its lock: which program it runs from,
// as the service says it in service.json. An upgrade reads it to keep that version directory
// (the client goes on starting watch processes out of it, docs/design/nodes.md §4.2), and an
// uninstall reads it to know whether the client is this installation's to stop.
const CLIENT_FILE = 'client.json';
const APP_ROOT = join(import.meta.dirname, '..');

function writeClientFacts(identity: NodeIdentity): void {
  writeFileSync(join(identity.dir, CLIENT_FILE), `${JSON.stringify({ pid: process.pid, program_dir: APP_ROOT, version: appVersion(APP_ROOT) })}\n`);
}

const clearClientFacts = (identity: NodeIdentity): void => rmSync(join(identity.dir, CLIENT_FILE), { force: true });

interface RunningClient {
  identity: NodeIdentity;
  pid: number;
  // Null when the client did not say (one from before the file was written): then nothing
  // about where it runs from can be told.
  programDir: string | null;
}

// The client taking this data directory's commands right now, by the lock under the identity
// this machine keeps there. Nothing is made: a data directory without an identity has no
// client, and one whose client is gone has none either.
export function runningClient(dataDir: string): RunningClient | undefined {
  const identity = existingIdentity(dataDir);
  if (identity === undefined) return undefined;
  const holder = readClientHolder(identity);
  if (holder === undefined) return undefined;
  let programDir: string | null = null;
  try {
    const facts = JSON.parse(readFileSync(join(identity.dir, CLIENT_FILE), 'utf8')) as { pid?: unknown; program_dir?: unknown };
    // Only what the process holding the lock wrote: a file a dead client left behind says
    // nothing about the one running now.
    if (facts.pid === holder.pid && typeof facts.program_dir === 'string') programDir = facts.program_dir;
  } catch {
    // Not written, or not readable: the client's whereabouts are unknown.
  }
  return { identity, pid: holder.pid, programDir };
}

// Every client saying it is running under this data directory, whichever machine identity it
// belongs to (docs/design/nodes.md §7): machines sharing one data directory and one
// installation each keep their own identity, and an upgrade must keep every version directory
// any of them still starts its watch processes from.
export interface ClientInUse extends RunningClient {
  // Set when the lock names another machine: this one can neither look at that process nor
  // wait it out, so the version directory it names is simply kept.
  elsewhere: string | undefined;
}

export function clientsInUse(dataDir: string): ClientInUse[] {
  // <data dir>/nodes/<machine>/<identity>: every machine that shares the data directory has
  // its own scope under nodes, and every identity its own directory under that (nodes.md §7).
  const nodes = join(dataDir, 'nodes');
  const found: ClientInUse[] = [];
  for (const scope of safeNames(nodes)) {
    const perMachine = join(nodes, scope);
    for (const id of safeNames(perMachine)) {
      const dir = join(perMachine, id);
      if (!existsSync(join(dir, 'id'))) continue;
      const holder = readHolder(join(dir, CLIENT_LOCK));
      let facts: { pid?: unknown; program_dir?: unknown } | undefined;
      try {
        facts = JSON.parse(readFileSync(join(dir, CLIENT_FILE), 'utf8')) as { pid?: unknown; program_dir?: unknown };
      } catch {
        // None, or not readable: this client cannot say where it runs from.
      }
      // A file left by a client that is gone says the same as one still running: a version
      // directory that might be in use is not deleted on a guess.
      if (holder === undefined && facts === undefined) continue;
      found.push({
        identity: { id, dir, dataDir },
        pid: holder?.pid ?? (typeof facts?.pid === 'number' ? facts.pid : 0),
        programDir: typeof facts?.program_dir === 'string' ? facts.program_dir : null,
        elsewhere: holder === undefined ? undefined : lockElsewhere(holder),
      });
    }
  }
  return found;
}

const safeNames = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// What the second client says before leaving. A lock whose owner is on another machine is
// one this machine cannot look at; the identity directory is per machine (§7), so that is
// a machine which cannot name itself sharing the data directory with another.
function clientRunningText(holder: Holder): string {
  const where = lockElsewhere(holder) === undefined ? '' : `（在机器 ${machineName(holder)} 上）`;
  return `这台机器上已经有一个客户端在跑${where}：进程 ${holder.pid}。同一个节点身份同一时间只能有一个客户端取命令，这一个什么都不做就退出。`
    + '要换一个：开机自启拉起来的运行 tycho node service stop，手工运行的按 Ctrl+C，或者用 tycho node leave 让它自己停。';
}

interface NodeCli {
  out(line: string): void;
  err(line: string): void;
  dataDir: string;
  signal: AbortSignal;
  // The program directory this process was loaded from: the version directory of an installed
  // copy, the checkout when run from one. The supervisor reads `current` under its prefix.
  appRoot?: string;
  // `--log <文件>`, when given: the supervisor passes it on to the client it starts, so the
  // output of every generation lands in the same file.
  logFile?: string;
}

class UsageError extends Error {}

function parse(args: string[], flags: Record<string, boolean>): Record<string, string | true | undefined> {
  const values: Record<string, string | true> = {};
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (!arg.startsWith('--')) throw new UsageError(`多了一个参数：${arg}`);
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    if (!Object.hasOwn(flags, name)) throw new UsageError(`不认识的选项：--${name}`);
    if (!flags[name]) {
      if (equals !== -1) throw new UsageError(`--${name} 不带值`);
      values[name] = true;
      continue;
    }
    const value = equals === -1 ? args[(at += 1)] : arg.slice(equals + 1);
    if (value === undefined || value === '') throw new UsageError(`--${name} 后面要跟一个值`);
    values[name] = value;
  }
  return values;
}

function addressOf(given: unknown, fallback: string | undefined): string {
  const text = typeof given === 'string' ? given : fallback;
  if (!text) throw new UsageError('要给出主机地址：--to <控制台的对外地址>');
  const url = URL.canParse(text) ? new URL(text) : undefined;
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new InputError(`主机地址应该是 http 或 https 地址：${text}`);
  return url.origin;
}

// The address the last join used is kept beside the identity: `run` and `status` need it,
// and it is not something the owner should have to paste again.
const originFile = (identity: NodeIdentity): string => `${identity.dir}/host`;

export function readOrigin(identity: NodeIdentity): string | undefined {
  try {
    const text = readFileSync(originFile(identity), 'utf8').trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

export const writeOrigin = (identity: NodeIdentity, origin: string): void => writeFileSync(originFile(identity), `${origin}\n`);

// Whatever the host says about the token, in the owner's words on that machine's terminal.
// A token the host no longer takes is gone from here as well: the design says the client
// drops it and stops, and says why (§9). Leaving it behind would have the next `node run`
// try the same rejected token again.
function tokenProblem(identity: NodeIdentity, error: unknown): never {
  if (error instanceof NodeHttpError && (error.status === 401 || error.status === 403)) {
    clearToken(identity);
    throw new Error('主机不认这台机器的令牌了：它已经被撤销（有人在控制台删掉了这台机器），或者令牌不对。本机的令牌已经清掉；要再连回来就在控制台重新放行，然后运行 tycho node join');
  }
  if (error instanceof NodeHttpError && error.status === 426) {
    throw new Error(error.message);
  }
  throw error;
}

// The join's own loop: the six digits point at the request, and the secret this machine
// keeps is what exchanges for the token. A client restarted while waiting claims the same
// registration rather than asking for a second (nodes.md §9, "兑换要能重试认领").
async function joinLoop(cli: NodeCli, identity: NodeIdentity, origin: string, name: string | undefined): Promise<{ token: string; machineId: string }> {
  const facts = factsOf(identity, name);
  const held = readPendingJoin(identity);
  // A secret another host gave out means nothing here: only this address's is claimed.
  let secret = held?.origin === origin ? held.secret : undefined;
  if (held !== undefined && secret === undefined) clearPendingJoin(identity);
  for (;;) {
    let answer: NodeJoinAnswer;
    try {
      answer = await joinHost({ origin, facts, ...(secret === undefined ? {} : { claim: { secret } }) });
    } catch (error) {
      // The host's own words: it knows both versions, this client only its own.
      if (error instanceof NodeHttpError && error.status === 426) throw new Error(error.message);
      throw error;
    }
    if (answer.state === 'missing') {
      // The host forgot this request (it restarted), or the secret is not one of its own:
      // a fresh registration is the only way on.
      secret = undefined;
      continue;
    }
    if (answer.state === 'rejected') {
      writePendingJoin(identity, { secret: '', code: '', origin });
      throw new Error('控制台拒绝了这次加入。确认一下是哪台机器，再运行一次 tycho node join');
    }
    if (answer.state === 'approved') {
      writeOrigin(identity, origin);
      return { token: answer.token, machineId: answer.machine_id };
    }
    if (secret === undefined) {
      secret = answer.secret;
      writePendingJoin(identity, { secret, code: answer.code, origin });
      cli.out('');
      cli.out(`在已经登录的控制台上点侧栏的『放行』，输入 ${answer.code}`);
      cli.out('配了企业微信的话，手机上会收到一张卡片，在上面点『放行』也行。');
      cli.out('只有你自己面前那台机器上显示着同样的数字时才放行。');
      cli.out('');
      cli.out('等着放行……（Ctrl+C 停在这里；重新运行同一条命令会接着等）');
    }
    const expires = Date.parse(answer.expires_at);
    if (Number.isFinite(expires) && Date.now() > expires) {
      cli.err('这次加入请求已经过期，重新开始一次');
      secret = undefined;
      continue;
    }
    try {
      await sleep(3000, undefined, { signal: cli.signal });
    } catch {
      throw new Error('停在这里了。放行之后重新运行 tycho node join 就接上');
    }
  }
}

// A material handed to the instance (nodes.md §1.3), read from a file descriptor so that it
// is never an argument: one material, one machine.
function readMaterial(fd: string): string {
  if (!/^\d+$/.test(fd)) throw new UsageError(`--material-fd 后面要跟一个文件描述符的编号：${fd}`);
  let text: string;
  try {
    text = readFileSync(Number(fd), 'utf8');
  } catch (error) {
    throw new InputError(`从文件描述符 ${fd} 读不到接入材料：${(error as Error).message}`);
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length !== 1) throw new InputError(words.length === 0 ? '没有读到接入材料' : `读到了 ${words.length} 份接入材料：一台机器只用一份，把其中一份交给它`);
  if (!/^[0-9a-f]{64}$/.test(words[0]!)) throw new InputError('读到的不是一份接入材料：应该是 64 位十六进制');
  return words[0]!;
}

// The secret this machine redeems a material with is made once and kept beside its
// identity, with the address it was for: a join that is retried — the answer was lost, the
// process was restarted — claims the registration it already made instead of a second one
// (nodes.md §1.3, "兑换要能重试认领").
const INVITE_FILE = 'invite.json';
function inviteSecret(identity: NodeIdentity, origin: string): string {
  try {
    const held = JSON.parse(readFileSync(join(identity.dir, INVITE_FILE), 'utf8')) as { secret?: unknown; origin?: unknown };
    if (held.origin === origin && typeof held.secret === 'string' && /^[0-9a-f]{64}$/.test(held.secret)) return held.secret;
  } catch {
    // None yet, or not readable: a fresh one.
  }
  const secret = randomBytes(32).toString('hex');
  writeOwnerOnly(join(identity.dir, INVITE_FILE), `${JSON.stringify({ secret, origin })}\n`);
  return secret;
}

const INVITE_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

async function inviteJoin(cli: NodeCli, identity: NodeIdentity, origin: string, name: string | undefined, material: string): Promise<{ token: string; machineId: string }> {
  const facts = factsOf(identity, name);
  const secret = inviteSecret(identity, origin);
  for (let attempt = 0; ; attempt += 1) {
    let answer: NodeJoinAnswer;
    try {
      answer = await joinHost({ origin, facts, invite: { material, secret } });
    } catch (error) {
      if (error instanceof NodeHttpError && error.status === 426) throw new Error(error.message);
      // The host said no: the material is wrong, used, expired or its quota closed. Asking
      // again changes nothing.
      if (error instanceof NodeHttpError && error.status < 500) throw new InputError(error.message);
      const wait = INVITE_RETRY_MS[Math.min(attempt, INVITE_RETRY_MS.length - 1)]!;
      cli.err(`连不上主机（${(error as Error).message}），${Math.round(wait / 1000)} 秒后再试`);
      try {
        await sleep(wait, undefined, { signal: cli.signal });
      } catch {
        throw new Error('停在这里了。重新运行同一条命令会认领同一条登记');
      }
      continue;
    }
    if (answer.state !== 'approved') throw new Error(`主机的回答不对：${answer.state}`);
    writeOrigin(identity, origin);
    return { token: answer.token, machineId: answer.machine_id };
  }
}

// The marker an internal supervisor puts in its child's environment: a client that was started
// this way is the resident one, and must not put another supervisor around itself.
export const SUPERVISED_ENV = 'TYCHO_NODE_SUPERVISED';
const isSupervised = (): boolean => process.env[SUPERVISED_ENV] === '1';
const programRoot = (cli: NodeCli): string => cli.appRoot ?? APP_ROOT;

// The entry the supervisor starts: the version `current` names, so that a client that left to
// move to a new version comes back as that version. A checkout has only itself; an installed
// copy whose `current` cannot be read falls back to the supervisor's own generation, which is
// all there is.
function clientEntry(cli: NodeCli): string {
  const root = programRoot(cli);
  const prefix = prefixOf(root);
  const current = prefix === null ? null : readCurrent(prefix);
  const named = current === null || prefix === null ? null : join(prefix, 'versions', current, 'cli', 'main.ts');
  return named !== null && existsSync(named) ? named : join(root, 'cli', 'main.ts');
}

// The supervisor that outlives a version swap (docs/design/nodes.md §1.4): the shape is GitHub's
// self-hosted runner's `run-helper.sh`. It starts the client, and when the client leaves with
// SWAP_EXIT it reads `current` again and starts that. Any other code is the client's own, and
// the supervisor leaves with it. It takes no client lock and writes no client.json: those belong
// to the client it starts.
//
// FROZEN command line: `node run --to <地址> [--name <名字>] [--log <文件>]`. This code keeps
// running the old program's version until something restarts the supervisor itself, so it may
// carry nothing else, and the flags it passes may not change shape.
async function supervise(cli: NodeCli, origin: string, name: string | undefined): Promise<number> {
  let child: ReturnType<typeof spawn> | null = null;
  const keep = (): void => {};
  // Ctrl+C reaches the client in the same console (stdio is inherited): the supervisor waits for
  // it to leave rather than going first and leaving an orphan. SIGTERM (a service manager's stop)
  // is sent only to the main process, so it is forwarded.
  process.on('SIGINT', keep);
  process.on('SIGBREAK', keep);
  process.on('SIGTERM', () => child?.kill('SIGTERM'));
  for (;;) {
    // Asked to stop before anything was started (a join that was told to leave as soon as it
    // printed the six digits, or a Ctrl+C in that moment): nothing to supervise.
    if (cli.signal.aborted) return 0;
    const entry = clientEntry(cli);
    const args = [
      ...process.execArgv,
      entry,
      'node', 'run',
      '--to', origin,
      ...(name === undefined ? [] : ['--name', name]),
      ...(cli.logFile === undefined ? [] : ['--log', cli.logFile]),
    ];
    const running = spawn(process.execPath, args, {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, [SUPERVISED_ENV]: '1' },
    });
    child = running;
    const code = await new Promise<number | null>((resolve) => {
      running.once('error', (error) => {
        cli.err(`客户端没能启动：${error.message}`);
        resolve(1);
      });
      running.once('exit', (exited) => resolve(exited));
    });
    child = null;
    if (code === SWAP_EXIT) {
      const prefix = prefixOf(programRoot(cli));
      cli.out(`换版本：从 ${(prefix === null ? null : readCurrent(prefix)) ?? '新版本'} 重新启动客户端。`);
      continue;
    }
    return code ?? 1;
  }
}

async function resident(cli: NodeCli, identity: NodeIdentity, token: string, origin: string, name: string | undefined): Promise<number> {
  // One client per identity, from the first moment on: two of them would take the same
  // commands out of the same queue (nodes.md §7).
  const holder = claimLock(lockFile(identity), cli.err);
  if (holder !== null) {
    cli.err(clientRunningText(holder));
    return 1;
  }
  try {
    // A stop mark left by a client that died before reading it names a pid that is not this
    // one's: nobody's order now.
    clearClientStop(identity);
    writeClientFacts(identity);
    const observer = createServiceObserver(programRoot(cli));
    const client = createClient({
      serviceManager: () => observer.report(),
      dataDir: cli.dataDir, origin, token, facts: factsOf(identity, name), log: cli.err,
      // This client follows the host's version from its own identity directory: the download,
      // the update's log and what it last reported live there (docs/design/nodes.md §1.4).
      release: { identityDir: identity.dir },
      // `tycho node leave` or `tycho node service stop` in another terminal is what this
      // sees: the client stops asking for work, and the rounds already running keep running
      // (§9, node/client.ts).
      stopped: () => leaveRequested(identity) || clientStopRequestedFor(identity, process.pid),
    });
    cli.out(`已连上 ${origin}，等着干活。正在跑的活由它们自己的看管进程看着：Ctrl+C 停掉这个命令不会停它们。`);
    try {
      await client.run(cli.signal);
    } catch (error) {
      tokenProblem(identity, error);
    } finally { observer.close(); }
    const swapped = client.swapRequested();
    if (client.retired()) {
      // The host ended this machine's work (its task is over) and the leave went through:
      // the token is void there, and nothing here should try it again.
      requestLeave(identity);
      clearToken(identity);
      cli.out('派生这台机器的任务已经结束：它已经自己注销，不再收活。实例由创建它的技能负责销毁。');
    } else if (swapped) {
      // The version this installation was told to run is now `current`, and nothing of this
      // machine is running: the supervisor starts it again from there (docs/design/nodes.md
      // §1.4). Not a failure, and not the host's business: the token stays.
      const prefix = prefixOf(programRoot(cli));
      cli.out(`换到 ${(prefix === null ? null : readCurrent(prefix)) ?? '新版本'}：交给看守进程从新版重新启动。`);
    } else if (leaveRequested(identity)) cli.out('这台机器已经注销（tycho node leave）：不再收活。要再接活就重新运行 tycho node join。');
    else if (clientStopRequestedFor(identity, process.pid)) cli.out('已按要求停下（tycho node service stop）：不再收活。正在跑的轮次照跑；要再收活运行 tycho node service start 或 tycho node run。');
    return swapped ? SWAP_EXIT : 0;
  } finally {
    // This process is the client; the lock goes when it does, and so does a stop that was
    // meant for it. A client that is killed leaves the lock behind, and service/lock.ts
    // takes such a lock over by the pid in it.
    clearClientStop(identity);
    clearClientFacts(identity);
    rmSync(lockFile(identity), { force: true });
  }
}

export async function nodeCommand(cli: NodeCli, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || ['help', '--help', '-h'].includes(action)) {
    cli.out(NODE_HELP);
    return 0;
  }
  if (!['join', 'run', 'status', 'leave'].includes(action)) throw new UsageError('tycho node 后面要跟 join、run、status、leave 之一');
  const identity = identityOf(cli.dataDir);
  const known = readOrigin(identity);

  if (action === 'join') {
    const flags = parse(rest, { to: true, name: true, 'material-fd': true });
    let origin = addressOf(flags.to, known);
    const name = typeof flags.name === 'string' ? flags.name : undefined;
    const material = typeof flags['material-fd'] === 'string' ? readMaterial(flags['material-fd']) : undefined;
    cli.out(`这台机器：${name ?? hostname()}（标识 ${identity.id}）`);
    // The host on this machine, reached where it really listens: that is the origin from here.
    const local = material === undefined ? await joinLocally(cli.dataDir, origin, factsOf(identity, name)) : null;
    if (local) {
      origin = local.origin;
      writeOrigin(identity, origin);
      cli.out('本机接入，免放行。');
    }
    const { token, machineId } = local ? { token: local.answer.token, machineId: local.answer.machine_id }
      : material === undefined ? await joinLoop(cli, identity, origin, name) : await inviteJoin(cli, identity, origin, name, material);
    writeToken(identity, token);
    // The secrets have done their work: the token is what this machine is known by from
    // here, and `tycho node status` must not go on naming a request that was answered.
    rmSync(join(identity.dir, INVITE_FILE), { force: true });
    clearPendingJoin(identity);
    // Joining again is the owner asking this machine to take work again.
    clearLeave(identity);
    cli.out(`已加入。主机上这台机器叫 ${machineId}；控制台的机器列表里能看到它连没连回来。`);
    return isSupervised() ? resident(cli, identity, token, origin, name) : supervise(cli, origin, name);
  }

  if (action === 'run') {
    const flags = parse(rest, { to: true, name: true });
    if (leaveRequested(identity)) throw new InputError('这台机器已经注销过（tycho node leave）：要再接活就重新运行 tycho node join --to <主机地址>');
    const token = readToken(identity);
    if (token === undefined) throw new InputError('这台机器还没有加入过：先运行 tycho node join --to <主机地址>');
    const origin = addressOf(flags.to, known);
    const name = typeof flags.name === 'string' ? flags.name : undefined;
    // The supervisor stays while the client changes versions under it; a client it started
    // directly is the one that takes the lock and polls (docs/design/nodes.md §1.4).
    return isSupervised() ? resident(cli, identity, token, origin, name) : supervise(cli, origin, name);
  }

  if (action === 'status') {
    parse(rest, {});
    const token = readToken(identity);
    cli.out(`这台机器：${hostname()}（标识 ${identity.id}，数据目录 ${cli.dataDir}）`);
    cli.out(`加入过：${token === undefined ? '没有。运行 tycho node join --to <主机地址>' : '是'}`);
    const holder = readClientHolder(identity);
    cli.out(`客户端：${holder === undefined ? '没有在跑' : `在跑（进程 ${holder.pid}）`}`);
    const pending = readPendingJoin(identity);
    if (pending !== undefined && pending.code !== '') cli.out(`有一个等着放行的加入请求：在控制台输入 ${pending.code}`);
    const own = appVersion(programRoot(cli));
    const held = readReleaseStatus(identity.dir);
    if (token === undefined || known === undefined) {
      cli.out(`换版本：本客户端 tycho ${own}；还没连过主机，问不到主机版本`);
      return 0;
    }
    cli.out(`主机：${known}（协议第 ${NODE_PROTOCOL} 版）`);
    const client = createClient({ dataDir: cli.dataDir, origin: known, token, facts: factsOf(identity), log: () => {} });
    try {
      cli.out((await client.status()) === 'connected' ? '主机回答：在（这台机器被认下来了）' : '主机回答：连不上，检查网络和地址');
    } catch (error) {
      tokenProblem(identity, error);
    }
    // The version this client runs, the host's, and what this machine is doing about the
    // difference (docs/design/nodes.md §1.4). The last report is read from disk: it was made by
    // the running client in another process, and a status question must not overwrite it.
    const report = { version: own, at: held?.at ?? new Date().toISOString(), upgrade: held?.upgrade ?? null };
    try {
      const answer = await askRelease({ origin: known, token, version: own, upgrade: report.upgrade });
      cli.out(`换版本：${nodeReleaseText(report, answer.version)}`);
    } catch (error) {
      const state = report.upgrade === null || report.upgrade === undefined ? '版本一致'
        : report.upgrade.state === 'failed' ? `换版没成功：${report.upgrade.detail}` : report.upgrade.detail;
      cli.out(`换版本：本客户端 tycho ${own}，主机版本没问出来（${(error as Error).message}）；${state}`);
    }
    return 0;
  }

  parse(rest, {});
  const token = readToken(identity);
  if (token === undefined) {
    cli.out('这台机器没有加入过，不用注销。');
    return 0;
  }
  // The local mark first: a client running in another terminal is the one this has to stop,
  // and it is stopped by the mark and not by the host (node/client.ts).
  requestLeave(identity);
  if (known !== undefined) {
    const client = createClient({ dataDir: cli.dataDir, origin: known, token, facts: factsOf(identity), log: () => {} });
    try {
      await client.leave();
    } catch (error) {
      // A token the host has already revoked is the same outcome from here.
      if (!(error instanceof NodeHttpError)) throw error;
    }
  }
  writePendingJoin(identity, { secret: '', code: '', origin: '' });
  clearToken(identity);
  cli.out('本机已经注销：不再收活。主机那边的机器还在，要删掉到控制台删。');
  return 0;
}
