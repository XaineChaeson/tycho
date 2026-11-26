// The connection to the gateway: one ssh that this service starts and keeps, through which
// a machine the owner controls hands the requests it receives to the outside listener.
// The connection is made from here outwards, so this machine opens no port to anyone.
// Keeping it up is all this does; what may come through is the outside listener's to say.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Processes } from './processes.ts';
import { hostProcesses, rootSpawnOptions } from './processes.ts';

const WS_BRIDGE_SCRIPT = fileURLToPath(new URL('./gateway-ws-bridge.ts', import.meta.url)).replace(/\\/g, '/');

export interface GatewayConfig {
  // `user@host` or `user@host:port`; empty when there is no gateway.
  ssh: string;
  // Optional `wss://` (or `ws://`) URL for SSH-over-WSS 443 transport via OpenSSH ProxyCommand.
  wss?: string;
  keyFile: string;
  remotePort: number;
  localPort: number;
}

// `since` is when the connection was last made or lost. `error` is how the last attempt
// ended, as ssh said it, and stays while the next one is being made.
export interface GatewayStatus {
  state: 'off' | 'connecting' | 'connected' | 'down';
  since: string | null;
  error: string | null;
}

const OFF: GatewayStatus = { state: 'off', since: null, error: null };
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;
// A process that has exited can leave its stderr open in something it started.
const STDERR_WAIT_MS = 1000;
const CLEAR_ATTEMPTS = 3;
const CLEAR_RECHECK_MS = 200;
const KEPT_LINES = 3;
const STDERR_LINE_BYTES = 4096;
const LOOPBACK = '127.0.0.1';
// The one line in which ssh says the gateway accepted the forward. It is printed at -v
// only; without it a running ssh says nothing about whether anything can come through.
const FORWARD_UP = /^debug1: remote forward success\b/;
// The rest of what -v adds that is not about anything going wrong: the debug lines, the
// version, who it signed in as, and the byte counts of a connection that has ended.
const CHATTER = /^(debug\d: |OpenSSH_|Authenticated to |Transferred: |Bytes per second: )/;
// Both parts become arguments of ssh: neither may read as an option.
const TARGET = /^([A-Za-z0-9_][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/;

export function parseTarget(text: string): { user: string; host: string; port?: number } | undefined {
  const [, user, host, port] = TARGET.exec(text) ?? [];
  if (!user || !host) return undefined;
  if (port === undefined) return { user, host };
  return Number(port) >= 1 && Number(port) <= 65_535 ? { user, host, port: Number(port) } : undefined;
}

export const targetProblem = (text: string): string | null =>
  text === '' || parseTarget(text) ? null : '应写成 用户名@地址，SSH 端口不是 22 时写 用户名@地址:端口';

// What the ssh of one data directory is found by, at the next start of its service. It
// has to stand on the command line, the one place every system lets a search read.
export const gatewayMarker = (dataDir: string): string =>
  `TYCHO_GATEWAY_${createHash('sha256').update(realpathSync.native(dataDir)).digest('hex').slice(0, 16)}`;

// Strict character allowlist for gateway.wss: supports IPv4/DNS/IPv6 hosts and valid
// percent-encoded path segments while blocking shell metacharacters
// ($, `, \, ;, |, &, (), <>, *, ?, #, {}, !, ~, ^, quotes, whitespace, control chars)
// and non-hex OpenSSH ProxyCommand % tokens before ssh passes ProxyCommand to a shell.
const SAFE_WSS_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/;
const SAFE_WSS_PATH = /^(?:[A-Za-z0-9/._@=+-]|%[0-9A-Fa-f]{2})*$/;
const SAFE_MARKER = /^[A-Za-z0-9_-]+$/;
const UNSAFE_QUOTED_PATH = /["`$\\\r\n\u0000-\u001f\u007f]/;

export function wssProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (/[?#\s"'`$\\;|&<>(){}*!~^\u0000-\u001f\u007f]/.test(trimmed) || !URL.canParse(trimmed)) {
    return '应为不含查询串、片段或特殊字符的 ws/wss 基础地址';
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    return '只支持 ws 或 wss 协议';
  }
  if (parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') {
    return '不能带用户名密码，且主机名不能为空';
  }
  if (!SAFE_WSS_HOST.test(parsed.hostname) || !SAFE_WSS_PATH.test(parsed.pathname)) {
    return '地址主机或路径包含不支持的字符';
  }
  return null;
}

export function proxyCommandOf(wss: string, marker: string, nodePath: string = process.execPath): string | undefined {
  const trimmed = wss.trim();
  if (trimmed === '' || wssProblem(trimmed) !== null) return undefined;
  if (!SAFE_MARKER.test(marker)) return undefined;
  const exe = nodePath.replace(/\\/g, '/');
  if (UNSAFE_QUOTED_PATH.test(exe) || UNSAFE_QUOTED_PATH.test(WS_BRIDGE_SCRIPT)) return undefined;
  // OpenSSH expands % tokens inside ProxyCommand before invoking the shell.
  const escapedExe = exe.replace(/%/g, '%%');
  const escapedScript = WS_BRIDGE_SCRIPT.replace(/%/g, '%%');
  const escapedWss = trimmed.replace(/%/g, '%%');
  return `"${escapedExe}" "${escapedScript}" --connect "${escapedWss}" --marker "${marker}"`;
}

export function sshArgs({ ssh, wss, keyFile, remotePort, localPort }: GatewayConfig, marker: string): string[] | undefined {
  const target = parseTarget(ssh);
  if (!target) return undefined;
  const hasWss = wss !== undefined && wss.trim() !== '';
  const proxyCommand = hasWss ? proxyCommandOf(wss!, marker) : undefined;
  if (hasWss && !proxyCommand) return undefined;
  return [
    '-N', '-v',
    '-R', `${LOOPBACK}:${remotePort}:${LOOPBACK}:${localPort}`,
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'ForkAfterAuthentication=no',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'ControlPersist=no',
    // The marker. To ssh it names a variable to pass on to a session; no variable has
    // this name and -N opens no session, so it does nothing but stand here.
    '-o', `SendEnv=${marker}`,
    ...(proxyCommand ? ['-o', `ProxyCommand=${proxyCommand}`] : []),
    ...(keyFile ? ['-i', keyFile, '-o', 'IdentitiesOnly=yes'] : []),
    ...(target.port ? ['-p', String(target.port)] : []),
    `${target.user}@${target.host}`,
  ];
}

export interface GatewayOptions {
  // Read at each start of a connection.
  config: () => GatewayConfig;
  marker: string;
  // Startup intent, kept until a marker search proves that no owned process remains.
  pidFile: string;
  // The outside listener, which is up exactly while a gateway is configured.
  listen(port: number): Promise<unknown>;
  unlisten(): Promise<void>;
  // In place of `ssh`, with leading arguments.
  command?: string[];
  processes?: Processes;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

const pause = (ms: number, signal: AbortSignal): Promise<void> => sleep(ms, undefined, { signal }).catch(() => {});

export function createGateway(options: GatewayOptions) {
  const { marker, pidFile } = options;
  const processes = options.processes ?? hostProcesses;
  const wait = options.sleep ?? pause;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const [command, ...leading] = options.command ?? ['ssh'];

  let status: GatewayStatus = OFF;
  let stopped = false;
  let current: AbortController | undefined;
  // One at a time: the next begins when the last has ended its ssh and closed the listener.
  let running: Promise<void> = Promise.resolve();

  const at = (): string => new Date(now()).toISOString();

  // What a service that did not stop left behind would hold the gateway's port against
  // the ssh started now, and go on forwarding to a listener this service may not have.
  async function clearLeftover(): Promise<void> {
    if (existsSync(pidFile)) {
      let found = await processes.find(marker);
      for (let attempt = 0; found.length > 0 && attempt < CLEAR_ATTEMPTS; attempt += 1) {
        for (const pid of found) await processes.kill(pid, marker);
        await sleep(CLEAR_RECHECK_MS);
        found = await processes.find(marker);
      }
      if (found.length > 0) throw new Error(`上次留下的门牌连接（ssh）清不掉：pid ${found.join(', ')}`);
      try {
        rmSync(pidFile, { force: true });
      } catch (err) {
        throw new Error(`门牌连接的归属记录删不掉：${(err as Error).message}`);
      }
    }
  }

  // Events only settle the wait. Process and file cleanup stays in the awaited path.
  async function connect(args: string[], signal: AbortSignal): Promise<{ connected: boolean; error: string }> {
    writeFileSync(pidFile, JSON.stringify({ state: 'starting', marker }), { flush: true });
    const child = spawn(command!, [...leading, ...args], { stdio: ['ignore', 'ignore', 'pipe'], ...rootSpawnOptions(process.platform) });
    let connected = false;
    let finishing = false;
    let exited = false;
    let timer: NodeJS.Timeout | undefined;
    const said: string[] = [];
    let partial = Buffer.alloc(0);
    let truncated = false;
    const line = (): void => {
      const text = partial.toString('utf8').trim();
      if (!truncated && FORWARD_UP.test(text)) {
        connected = true;
        if (!signal.aborted && !finishing) {
          status = { state: 'connected', since: at(), error: null };
          log(`门牌已连上：${args.at(-1)}`);
        }
      } else if (text !== '' && !CHATTER.test(text)) {
        said.push(text);
        if (said.length > KEPT_LINES) said.shift();
      }
      partial = Buffer.alloc(0);
      truncated = false;
    };
    const data = (chunk: Buffer): void => {
      let from = 0;
      while (from < chunk.length) {
        const newline = chunk.indexOf(10, from);
        const to = newline < 0 ? chunk.length : newline;
        const room = STDERR_LINE_BYTES - 4 - partial.length;
        const piece = chunk.subarray(from, to);
        if (piece.length > room) truncated = true;
        if (room > 0) partial = Buffer.concat([partial, piece.subarray(0, room)]);
        if (newline < 0) break;
        line();
        from = newline + 1;
      }
    };
    const ending = Promise.withResolvers<string>();
    const ended = (code: number | null, by: NodeJS.Signals | null): string =>
      said.join('\n') || `ssh 退出了（${by ?? `退出码 ${code}`}），什么都没说`;
    const end = (): void => ending.resolve('门牌连接已停止');
    try {
      child.stderr.on('data', data);
      child.once('error', (err) => ending.resolve(`ssh 启动不了：${err.message}`));
      child.once('close', (code, by) => { if (partial.length) line(); ending.resolve(ended(code, by)); });
      child.once('exit', (code, by) => {
        exited = true;
        if (finishing) return;
        timer = setTimeout(() => { if (partial.length) line(); ending.resolve(ended(code, by)); }, STDERR_WAIT_MS);
      });
      signal.addEventListener('abort', end, { once: true });
      if (signal.aborted) end();
      const error = await ending.promise;
      return { connected, error };
    } finally {
      finishing = true;
      signal.removeEventListener('abort', end);
      clearTimeout(timer);
      child.stderr.destroy();
      // A root that has ended has nothing left to end. kill() is what takes the whole
      // tree, children included, and it can only walk that tree while the root is alive;
      // for what an ended one left behind, the check below finds it by the marker.
      if (child.pid !== undefined && !exited) await processes.kill(child.pid, marker);
      await clearLeftover();
    }
  }

  // A connection kept up, not an operation tried again: it is made, and made again when
  // it ends, for as long as this configuration stands.
  async function keep(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const config = options.config();
    const enabled = config.ssh !== '';
    let since = at();
    let delay = FIRST_RETRY_MS;
    let listening = false;
    if (enabled) status = { state: 'connecting', since, error: null };
    try {
      while (!signal.aborted) {
        let error: string;
        try {
          await clearLeftover();
          if (!enabled) { status = OFF; return; }
          const args = sshArgs(config, marker);
          if (!args) {
            const wssErr = config.wss ? wssProblem(config.wss) : null;
            throw new Error(wssErr ? `门牌 443 WebSocket 通道地址写得不对：${wssErr}` : `门牌机器写得不对：${config.ssh}`);
          }
          if (!listening) {
            await options.listen(config.localPort);
            listening = true;
          }
          const ending = await connect(args, signal);
          if (ending.connected) {
            since = at();
            delay = FIRST_RETRY_MS;
          }
          error = ending.error;
        } catch (err) {
          error = (err as Error).message;
          status = { state: 'down', since, error };
          if (!enabled) {
            log(error);
            return;
          }
        }
        if (signal.aborted) return;
        // Once for each thing that goes wrong, not once for each try.
        if (status.state === 'connected' || status.error !== error) log(`门牌没有连上，会一直重试：${error}`);
        status = { state: 'down', since, error };
        await wait(delay, signal);
        delay = Math.min(delay * 2, MAX_RETRY_MS);
        if (!signal.aborted) status = { state: 'connecting', since, error };
      }
    } finally {
      if (listening) await options.unlisten().catch((err: unknown) => log(`关闭对外入口失败：${String(err)}`));
    }
  }

  // Ends the connection there is and makes the one the settings now describe.
  function apply(): void {
    if (stopped) return;
    current?.abort();
    const mine = new AbortController();
    current = mine;
    running = running.then(() => keep(mine.signal)).catch((err: unknown) => log(`门牌连接的看管出错：${String(err)}`));
  }

  return {
    start: apply,
    reconfigure: apply,
    status: (): GatewayStatus => status,
    async stop(): Promise<void> {
      stopped = true;
      current?.abort();
      await running;
      if (!existsSync(pidFile)) status = OFF;
    },
  };
}
