// A WebSocket client for text frames, over node:http(s).
//
// Node's built-in WebSocket cannot reach the WeCom gateway: the gateway matches the
// handshake header name `Sec-WebSocket-Key` case-sensitively and answers 404 to the
// lowercase form the built-in client sends (measured 2026-11-05, see
// docs/spike/wecom-protocol.md). This client writes the names as the RFC spells them.
// It offers no extensions and connects directly: no proxy support.
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const HANDSHAKE_TIMEOUT_MS = 15_000;
// One WeCom frame is a small JSON document; anything near this is not one.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

type Listener = (event: { data?: string; code?: number; reason?: string; error?: Error }) => void;
type EventName = 'open' | 'message' | 'close' | 'error';

function encode(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  let head: Buffer;
  if (length < 126) head = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 65_536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([head, mask, masked]);
}

export class WsClient {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = WsClient.CONNECTING;
  #socket: Duplex | undefined;
  #listeners: Record<EventName, Set<Listener>> = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;

  constructor(url: string) {
    const target = new URL(url);
    const secure = target.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');
    const request = (secure ? httpsRequest : httpRequest)({
      host: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
    });
    request.setTimeout(HANDSHAKE_TIMEOUT_MS, () => request.destroy(new Error('握手超时')));
    request.on('error', (error) => this.#fail(error));
    request.on('response', (response) => {
      response.resume();
      this.#fail(new Error(`握手被拒绝：HTTP ${response.statusCode}`));
    });
    request.on('upgrade', (response, socket, head) => {
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        this.#fail(new Error('握手校验失败'));
        return;
      }
      socket.setTimeout(0);
      this.#socket = socket;
      this.readyState = WsClient.OPEN;
      socket.on('data', (chunk: Buffer) => this.#receive(chunk));
      socket.on('error', (error: Error) => this.#emit('error', { error }));
      socket.on('close', () => this.#closed(1006, ''));
      this.#emit('open', {});
      if (head.length) this.#receive(head);
    });
    request.end();
  }

  addEventListener(name: EventName, listener: Listener): void {
    this.#listeners[name].add(listener);
  }

  send(text: string): void {
    if (this.readyState !== WsClient.OPEN || !this.#socket) throw new Error('连接未打开');
    this.#socket.write(encode(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  close(): void {
    if (this.readyState === WsClient.CLOSED || this.readyState === WsClient.CLOSING) return;
    const socket = this.#socket;
    if (!socket) {
      this.#closed(1006, '');
      return;
    }
    this.readyState = WsClient.CLOSING;
    socket.write(encode(OP_CLOSE, Buffer.alloc(0)), () => socket.end());
    // A peer that never answers the close must not keep the socket forever.
    setTimeout(() => socket.destroy(), 2000).unref();
  }

  #emit(name: EventName, event: Parameters<Listener>[0]): void {
    for (const listener of this.#listeners[name]) {
      try {
        listener(event);
      } catch {
        // A listener's failure is its own; the connection goes on.
      }
    }
  }

  #fail(error: Error): void {
    if (this.readyState === WsClient.CLOSED) return;
    this.#emit('error', { error });
    this.#closed(1006, error.message);
  }

  #closed(code: number, reason: string): void {
    if (this.readyState === WsClient.CLOSED) return;
    this.readyState = WsClient.CLOSED;
    this.#socket?.destroy();
    this.#emit('close', { code, reason });
  }

  #receive(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      const buffer = this.#buffer;
      if (buffer.length < 2) return;
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const long = buffer.readBigUInt64BE(2);
        if (long > BigInt(MAX_MESSAGE_BYTES)) {
          this.#fail(new Error('帧过大'));
          return;
        }
        length = Number(long);
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskAt, maskAt + 4);
        const clear = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) clear[i] = payload[i]! ^ mask[i & 3]!;
        payload = clear;
      }
      this.#buffer = buffer.subarray(offset + length);
      if (!this.#frame(fin, opcode, payload)) return;
    }
  }

  // Returns false once the connection is over and the rest of the buffer is moot.
  #frame(fin: boolean, opcode: number, payload: Buffer): boolean {
    switch (opcode) {
      case OP_PING:
        this.#socket?.write(encode(OP_PONG, payload));
        return true;
      case OP_PONG:
        return true;
      case OP_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (this.readyState === WsClient.OPEN) this.#socket?.write(encode(OP_CLOSE, payload.subarray(0, 2)));
        this.#closed(code, reason);
        return false;
      }
      case OP_TEXT:
      case OP_CONTINUATION: {
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.length;
        if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
          this.#fail(new Error('消息过大'));
          return false;
        }
        if (!fin) return true;
        const data = Buffer.concat(this.#fragments).toString('utf8');
        this.#fragments = [];
        this.#fragmentBytes = 0;
        this.#emit('message', { data });
        return true;
      }
      default:
        // Binary and reserved frames: the gateway speaks JSON text only.
        return true;
    }
  }
}
