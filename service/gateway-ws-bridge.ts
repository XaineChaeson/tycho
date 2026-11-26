// SSH over WebSocket (443) transport bridge (docs/spike/gateway-443-evaluation.md):
// 1. Client mode (`--connect wss://host/_gateway`): OpenSSH `ProxyCommand` stdio <-> binary RFC 6455
//    WebSocket client, supporting direct TLS 443 and HTTP `CONNECT :443` via `HTTPS_PROXY`/`ALL_PROXY`.
// 2. Server mode (`--listen 127.0.0.1:18722 --target 127.0.0.1:22`): lightweight loopback unframing
//    daemon behind nginx `location = /_gateway` that forwards raw SSH TCP bytes to local `sshd`,
//    preserving OpenSSH's `authorized_keys` (`restrict,port-forwarding,permitlisten`) boundary.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Duplex, Readable, Writable } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_FRAME_PAYLOAD = 4 * 1024 * 1024;
const CHUNK_SIZE = 32 * 1024;

export const acceptKeyOf = (secKey: string): string =>
  createHash('sha1').update(secKey + WS_GUID).digest('base64');

export function encodeWsFrame(payload: Buffer, opcode: number, masked: boolean): Buffer {
  const len = payload.length;
  const headerLen = 2 + (len < 126 ? 0 : len < 65_536 ? 2 : 8) + (masked ? 4 : 0);
  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  const maskBit = masked ? 0x80 : 0;
  let offset = 2;
  if (len < 126) {
    frame[1] = maskBit | len;
  } else if (len < 65_536) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  if (!masked) {
    payload.copy(frame, offset);
    return frame;
  }
  const mask = randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;
  for (let i = 0; i < len; i += 1) {
    frame[offset + i] = payload[i]! ^ mask[i & 3]!;
  }
  return frame;
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export function createWsFrameDecoder(
  expectMasked: boolean,
  onFrame: (frame: ParsedFrame) => void,
  onProtocolError: (reason: string) => void,
): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0);
  let failed = false;
  return (chunk: Buffer) => {
    if (failed || chunk.length === 0) return;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      if (rsv !== 0) {
        failed = true;
        onProtocolError('WebSocket 收到非零扩展位');
        return;
      }
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      if (expectMasked && !masked) {
        failed = true;
        onProtocolError('客户端帧缺少掩码');
        return;
      }
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_PAYLOAD)) {
          failed = true;
          onProtocolError(`WebSocket 单帧超过上限（${MAX_FRAME_PAYLOAD} 字节）`);
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_FRAME_PAYLOAD) {
        failed = true;
        onProtocolError(`WebSocket 单帧超过上限（${MAX_FRAME_PAYLOAD} 字节）`);
        return;
      }
      const total = offset + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      let payload: Buffer;
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const raw = buf.subarray(offset + 4, total);
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) payload[i] = raw[i]! ^ mask[i & 3]!;
      } else {
        payload = Buffer.from(buf.subarray(offset, total));
      }
      buf = buf.subarray(total);
      onFrame({ fin, opcode, payload });
      if (failed) return;
    }
  };
}

function hostBypassed(hostname: string, noProxyRaw: string | undefined): boolean {
  if (!noProxyRaw) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  for (const entry of noProxyRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (entry === '*') return true;
    const stripped = entry.replace(/^\./, '').replace(/:\d+$/, '');
    if (host === stripped || host.endsWith(`.${stripped}`)) return true;
  }
  return false;
}

export function resolveHttpProxy(targetUrl: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  if (hostBypassed(targetUrl.hostname, noProxy)) return undefined;
  const secure = targetUrl.protocol === 'wss:';
  const raw = secure
    ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? env.HTTP_PROXY ?? env.http_proxy)
    : (env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy);
  if (!raw || raw.trim() === '') return undefined;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed;
  } catch {
    // Ignore malformed proxy env rather than crashing before attempting direct.
  }
  return undefined;
}

function readHttpHeaderBlock(socket: Duplex, timeoutMs: number): Promise<{ statusLine: string; statusCode: number; headers: Record<string, string>; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let acc: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待握手响应超时'));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      acc = Buffer.concat([acc, chunk]);
      const idx = acc.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (acc.length > 32_768) {
          cleanup();
          reject(new Error('握手响应头过大'));
        }
        return;
      }
      cleanup();
      const headText = acc.subarray(0, idx).toString('latin1');
      const rest = acc.subarray(idx + 4);
      const lines = headText.split('\r\n');
      const statusLine = lines[0] ?? '';
      const match = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(statusLine);
      const statusCode = match ? Number(match[1]) : 0;
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ statusLine, statusCode, headers, rest });
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('对端在握手完成前断开了连接'));
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function openRawOrProxiedSocket(targetHost: string, targetPort: number, proxy: URL | undefined, timeoutMs: number): Promise<Socket | TLSSocket> {
  if (!proxy) {
    return await new Promise<Socket>((resolve, reject) => {
      const sock = netConnect({ host: targetHost, port: targetPort });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`直连 ${targetHost}:${targetPort} 超时`));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.setNoDelay(true);
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`直连 ${targetHost}:${targetPort} 失败：${err.message}`));
      });
    });
  }

  const proxyPort = proxy.port ? Number(proxy.port) : (proxy.protocol === 'https:' ? 443 : 80);
  const proxySock = await new Promise<Socket | TLSSocket>((resolve, reject) => {
    const conn = proxy.protocol === 'https:'
      ? tlsConnect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
      : netConnect({ host: proxy.hostname, port: proxyPort });
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`连接代理 ${proxy.hostname}:${proxyPort} 超时`));
    }, timeoutMs);
    const readyEvent = proxy.protocol === 'https:' ? 'secureConnect' : 'connect';
    conn.once(readyEvent, () => {
      clearTimeout(timer);
      conn.setNoDelay(true);
      resolve(conn);
    });
    conn.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`连接代理 ${proxy.hostname}:${proxyPort} 失败：${err.message}`));
    });
  });

  const targetAuthority = targetHost.includes(':') ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
  const authHeader = proxy.username || proxy.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
    : '';
  proxySock.write(
    `CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\n${authHeader}Proxy-Connection: Keep-Alive\r\n\r\n`,
  );
  const reply = await readHttpHeaderBlock(proxySock, timeoutMs).catch((err: Error) => {
    proxySock.destroy();
    throw new Error(`代理 CONNECT ${targetAuthority} 未响应：${err.message}`);
  });
  if (reply.statusCode !== 200) {
    proxySock.destroy();
    throw new Error(`代理拒绝 CONNECT ${targetAuthority}（HTTP ${reply.statusCode || reply.statusLine}）`);
  }
  if (reply.rest.length > 0) proxySock.unshift(reply.rest);
  return proxySock;
}

export interface ConnectWssBridgeOptions {
  url: string;
  input: Readable;
  output: Writable;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
}

export async function connectWssBridge(options: ConnectWssBridgeOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const parsed = new URL(options.url);
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error(`不支持的门牌通道协议：${parsed.protocol}`);
  }
  const secure = parsed.protocol === 'wss:';
  const port = parsed.port ? Number(parsed.port) : (secure ? 443 : 80);
  const proxy = resolveHttpProxy(parsed, options.env);
  const baseSocket = await openRawOrProxiedSocket(parsed.hostname, port, proxy, timeoutMs);

  const wsSocket: Socket | TLSSocket = secure
    ? await new Promise<TLSSocket>((resolve, reject) => {
        const tlsSock = tlsConnect({
          socket: baseSocket,
          servername: parsed.hostname,
          rejectUnauthorized: options.rejectUnauthorized ?? true,
        });
        const timer = setTimeout(() => {
          tlsSock.destroy();
          reject(new Error(`TLS 握手超时（${parsed.hostname}:${port}）`));
        }, timeoutMs);
        tlsSock.once('secureConnect', () => {
          clearTimeout(timer);
          tlsSock.setNoDelay(true);
          resolve(tlsSock);
        });
        tlsSock.once('error', (err) => {
          clearTimeout(timer);
          reject(new Error(`TLS 握手失败（${parsed.hostname}:${port}）：${err.message}`));
        });
      })
    : baseSocket;

  const secKey = randomBytes(16).toString('base64');
  const pathAndQuery = `${parsed.pathname || '/'}${parsed.search || ''}`;
  const hostHeader = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  wsSocket.write(
    `GET ${pathAndQuery} HTTP/1.1\r\n` +
    `Host: ${hostHeader}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${secKey}\r\n` +
    `Sec-WebSocket-Version: 13\r\n\r\n`,
  );

  const upgrade = await readHttpHeaderBlock(wsSocket, timeoutMs).catch((err: Error) => {
    wsSocket.destroy();
    throw new Error(`WSS 握手失败：${err.message}`);
  });
  if (upgrade.statusCode !== 101) {
    wsSocket.destroy();
    throw new Error(`门牌 WSS 握手被拒（HTTP ${upgrade.statusCode || upgrade.statusLine}）`);
  }
  if (upgrade.headers['sec-websocket-accept'] !== acceptKeyOf(secKey)) {
    wsSocket.destroy();
    throw new Error('门牌 WSS 握手校验值不匹配');
  }

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      options.input.off('data', onInputData);
      options.input.off('end', onInputEnd);
      options.input.off('error', onInputError);
      wsSocket.destroy();
      if (err) reject(err);
      else resolve();
    };

    const decode = createWsFrameDecoder(
      false,
      ({ opcode, payload }) => {
        if (opcode === 0x02 || opcode === 0x01 || opcode === 0x00) {
          if (payload.length > 0 && !options.output.write(payload)) {
            wsSocket.pause();
            options.output.once('drain', () => {
              if (!settled) wsSocket.resume();
            });
          }
        } else if (opcode === 0x09) {
          wsSocket.write(encodeWsFrame(payload, 0x0a, true));
        } else if (opcode === 0x08) {
          wsSocket.write(encodeWsFrame(Buffer.alloc(0), 0x08, true), () => finish());
        }
      },
      (reason) => finish(new Error(reason)),
    );

    const onInputData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (let off = 0; off < buf.length; off += CHUNK_SIZE) {
        const slice = buf.subarray(off, Math.min(off + CHUNK_SIZE, buf.length));
        if (!wsSocket.write(encodeWsFrame(slice, 0x02, true))) {
          options.input.pause();
          wsSocket.once('drain', () => {
            if (!settled) options.input.resume();
          });
        }
      }
    };
    const onInputEnd = (): void => {
      if (!settled && wsSocket.writable) {
        wsSocket.write(encodeWsFrame(Buffer.alloc(0), 0x08, true), () => finish());
      } else {
        finish();
      }
    };
    const onInputError = (err: Error): void => finish(err);

    wsSocket.on('data', decode);
    wsSocket.once('error', (err) => finish(new Error(`门牌 WSS 通道断开：${err.message}`)));
    wsSocket.once('close', () => finish());
    options.output.once('error', () => finish());

    if (upgrade.rest.length > 0) decode(upgrade.rest);
    options.input.on('data', onInputData);
    options.input.once('end', onInputEnd);
    options.input.once('error', onInputError);
    options.input.resume();
  });
}

export interface LoopbackWsServerOptions {
  listenHost?: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  path?: string;
}

export function startLoopbackWsToTcpServer(options: LoopbackWsServerOptions): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const listenHost = options.listenHost ?? '127.0.0.1';
  const expectedPath = options.path;
  const server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Upgrade Required\n');
  });

  server.on('upgrade', (req: IncomingMessage, wsSock: Duplex, head: Buffer) => {
    const reqPath = (req.url ?? '/').split('?')[0];
    if (expectedPath && reqPath !== expectedPath) {
      wsSock.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      wsSock.destroy();
      return;
    }
    const secKey = req.headers['sec-websocket-key'];
    if (typeof secKey !== 'string' || secKey === '' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      wsSock.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      wsSock.destroy();
      return;
    }

    const tcp = netConnect({ host: options.targetHost, port: options.targetPort });
    let upgraded = false;
    let closed = false;
    const teardown = (): void => {
      if (closed) return;
      closed = true;
      tcp.destroy();
      wsSock.destroy();
    };

    tcp.once('connect', () => {
      upgraded = true;
      tcp.setNoDelay(true);
      if ('setNoDelay' in wsSock && typeof wsSock.setNoDelay === 'function') wsSock.setNoDelay(true);
      wsSock.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Accept: ${acceptKeyOf(secKey)}\r\n\r\n`,
      );

      const decode = createWsFrameDecoder(
        true,
        ({ opcode, payload }) => {
          if (opcode === 0x02 || opcode === 0x01 || opcode === 0x00) {
            if (payload.length > 0 && !tcp.write(payload)) {
              wsSock.pause();
              tcp.once('drain', () => {
                if (!closed) wsSock.resume();
              });
            }
          } else if (opcode === 0x09) {
            wsSock.write(encodeWsFrame(payload, 0x0a, false));
          } else if (opcode === 0x08) {
            wsSock.write(encodeWsFrame(Buffer.alloc(0), 0x08, false), teardown);
          }
        },
        teardown,
      );

      wsSock.on('data', decode);
      if (head.length > 0) decode(head);

      tcp.on('data', (chunk: Buffer) => {
        for (let off = 0; off < chunk.length; off += CHUNK_SIZE) {
          const slice = chunk.subarray(off, Math.min(off + CHUNK_SIZE, chunk.length));
          if (!wsSock.write(encodeWsFrame(slice, 0x02, false))) {
            tcp.pause();
            wsSock.once('drain', () => {
              if (!closed) tcp.resume();
            });
          }
        }
      });
    });

    tcp.once('error', () => {
      if (!upgraded && !closed) {
        wsSock.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      }
      teardown();
    });
    tcp.once('close', teardown);
    wsSock.once('error', teardown);
    wsSock.once('close', teardown);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.listenPort, listenHost, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : options.listenPort;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function parseHostPort(spec: string, defaultHost: string): { host: string; port: number } {
  const idx = spec.lastIndexOf(':');
  if (idx < 0) {
    const p = Number(spec);
    if (!Number.isInteger(p) || p < 1 || p > 65_535) throw new Error(`无效端口：${spec}`);
    return { host: defaultHost, port: p };
  }
  const host = spec.slice(0, idx) || defaultHost;
  const port = Number(spec.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`无效地址端口：${spec}`);
  return { host, port };
}

async function runCli(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const connectUrl = flag('--connect');
  if (connectUrl) {
    await connectWssBridge({ url: connectUrl, input: process.stdin, output: process.stdout });
    return;
  }
  const listenSpec = flag('--listen');
  if (listenSpec) {
    const targetSpec = flag('--target') ?? '127.0.0.1:22';
    const path = flag('--path');
    const listen = parseHostPort(listenSpec, '127.0.0.1');
    const target = parseHostPort(targetSpec, '127.0.0.1');
    const started = await startLoopbackWsToTcpServer({
      listenHost: listen.host,
      listenPort: listen.port,
      targetHost: target.host,
      targetPort: target.port,
      ...(path ? { path } : {}),
    });
    process.stderr.write(`门牌 WS->TCP 环回桥已启动：${listen.host}:${started.port} -> ${target.host}:${target.port}${path ? ` (${path})` : ''}\n`);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await started.close();
    return;
  }
  throw new Error('用法：--connect <wss://host/_gateway> 或 --listen <[host:]port> [--target 127.0.0.1:22] [--path /_gateway]');
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
