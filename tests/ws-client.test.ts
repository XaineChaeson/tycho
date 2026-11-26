// Guards against the WeCom connection silently not coming up: a handshake the real
// gateway refuses (header-name case), a refusal that never surfaces, a message split
// across frames or TCP chunks arriving broken, a ping left unanswered (the gateway
// then drops us), and a close that leaves the socket open.
import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WsClient } from '../channels/ws-client.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const REFUSAL = 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  if (payload.length < 126) return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = first;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

// A server that upgrades, hands the raw socket to the test, and records client frames.
async function server(t: TestContext, onSocket: (socket: Duplex) => void) {
  const seen: { rawHeaders: string[]; opcodes: number[]; texts: string[] } = { rawHeaders: [], opcodes: [], texts: [] };
  const http = createServer();
  // An upgraded socket is no longer the server's to close, and it stays half-open
  // after the client's end(); left alone it would hold http.close() back.
  const sockets = new Set<Duplex>();
  t.after(() => {
    for (const socket of sockets) socket.destroy();
  });
  http.on('upgrade', (request, socket) => {
    sockets.add(socket);
    seen.rawHeaders = request.rawHeaders;
    // As the real gateway does: any other spelling of this header name is a 404.
    if (!request.rawHeaders.includes('Sec-WebSocket-Key')) {
      socket.end(REFUSAL);
      return;
    }
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', (chunk: Buffer) => {
      // Enough for these tests: one short masked frame per chunk.
      const opcode = chunk[0]! & 0x0f;
      const length = chunk[1]! & 0x7f;
      const mask = chunk.subarray(2, 6);
      const payload = Buffer.from(chunk.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i & 3]!));
      seen.opcodes.push(opcode);
      if (opcode === 1) seen.texts.push(payload.toString('utf8'));
    });
    onSocket(socket);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve(undefined));
      }),
  );
  return { url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/`, seen };
}

type Event = { data?: string; code?: number; error?: Error };
const once = (client: WsClient, name: 'open' | 'message' | 'close' | 'error') =>
  new Promise<Event>((resolve) => client.addEventListener(name, resolve));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the handshake spells Sec-WebSocket-Key as the gateway insists', async (t) => {
  const { url, seen } = await server(t, () => {});
  const client = new WsClient(url);
  await once(client, 'open');
  assert.ok(seen.rawHeaders.includes('Sec-WebSocket-Key'), 'the real gateway answers 404 to any other spelling');
  assert.equal(client.readyState, WsClient.OPEN);
  client.close();
});

test('a refused handshake surfaces as an error and a close, never as open', async (t) => {
  const http = createServer();
  http.on('upgrade', (_request, socket) => socket.end(REFUSAL));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve(undefined));
      }),
  );
  const client = new WsClient(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/`);
  let opened = false;
  client.addEventListener('open', () => {
    opened = true;
  });
  const [error, closed] = await Promise.all([once(client, 'error'), once(client, 'close')]);
  assert.ok(error.error instanceof Error);
  assert.equal(closed.code, 1006);
  assert.equal(opened, false);
  assert.equal(client.readyState, WsClient.CLOSED);
});

test('a message split across frames and across TCP chunks arrives whole', async (t) => {
  const text = `{"cmd":"x","body":"${'好'.repeat(400)}"}`;
  const bytes = Buffer.from(text, 'utf8');
  const { url } = await server(t, (socket) => {
    const wire = Buffer.concat([frame(1, bytes.subarray(0, 500), false), frame(0, bytes.subarray(500), true)]);
    // Cut inside a frame header and inside a multi-byte character.
    socket.write(wire.subarray(0, 3));
    setTimeout(() => socket.write(wire.subarray(3, 701)), 5);
    setTimeout(() => socket.write(wire.subarray(701)), 10);
  });
  const client = new WsClient(url);
  const message = await once(client, 'message');
  assert.equal(message.data, text);
  client.close();
});

test('a ping is answered with a pong', async (t) => {
  const { url, seen } = await server(t, (socket) => {
    socket.write(frame(9, Buffer.from('hb')));
  });
  const client = new WsClient(url);
  await once(client, 'open');
  for (let i = 0; i < 100 && !seen.opcodes.includes(10); i++) await pause(10);
  assert.ok(seen.opcodes.includes(10), 'an unanswered ping gets the connection dropped');
  client.close();
});

test('send reaches the server as masked text, and a server close ends the connection', async (t) => {
  let peer: Duplex | undefined;
  const { url, seen } = await server(t, (socket) => {
    peer = socket;
  });
  const client = new WsClient(url);
  await once(client, 'open');
  client.send('{"cmd":"ping"}');
  for (let i = 0; i < 100 && seen.texts.length === 0; i++) await pause(10);
  assert.deepEqual(seen.texts, ['{"cmd":"ping"}']);
  const closing = once(client, 'close');
  const code = Buffer.alloc(2);
  code.writeUInt16BE(1000);
  peer!.write(frame(8, code));
  assert.equal((await closing).code, 1000);
  assert.equal(client.readyState, WsClient.CLOSED);
  assert.throws(() => client.send('late'), /连接未打开/);
});
