// A stand-in for wss://openws.work.weixin.qq.com, as docs/spike/wecom-protocol.md
// describes it: a hand-written WebSocket server that handles text frames only. It
// records what it gets, answers each request by req_id, and can inject callbacks,
// refuse, fall silent, delay a stream frame's answer or cut the connection.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 1;
const OP_CLOSE = 8;

function encode(opcode, payload) {
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])]);
  return Buffer.concat([head, payload]);
}

// Returns the frames complete so far and what is left of the buffer.
function decode(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    if (rest.length < 2) return { frames, rest };
    const opcode = rest[0] & 0x0f;
    let length = rest[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (rest.length < 4) return { frames, rest };
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (rest.length < 10) return { frames, rest };
      length = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }
    // Client frames are always masked.
    if (rest.length < offset + 4 + length) return { frames, rest };
    const mask = rest.subarray(offset, offset + 4);
    const payload = Buffer.from(rest.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    frames.push({ opcode, payload });
    rest = rest.subarray(offset + 4 + length);
  }
}

export async function startGateway() {
  const sockets = new Set();
  const gateway = {
    url: '',
    // Every frame received, parsed, in order.
    frames: [],
    connections: 0,
    // How many connections are open now.
    get open() {
      return sockets.size;
    },
    // What to answer a request with; undefined stays silent.
    answer: () => ({ errcode: 0, errmsg: 'ok' }),
    // How to treat one stream frame, the first being 0: undefined as `answer` says,
    // 'silent' no answer, { errcode, errmsg } that answer, { delayMs } a late one.
    onStream: () => undefined,

    sent: (cmd) => gateway.frames.filter((frame) => frame.cmd === cmd),

    // The stream frames in order, as { reqId, id, finish, content }.
    streams: () =>
      gateway.sent('aibot_respond_msg').flatMap(({ headers, body }) =>
        body?.msgtype === 'stream' ? [{ reqId: headers.req_id, ...body.stream }] : [],
      ),

    inject(frame) {
      const data = encode(OP_TEXT, Buffer.from(JSON.stringify(frame)));
      for (const socket of sockets) socket.write(data);
    },

    message(body, reqId = randomBytes(8).toString('hex')) {
      gateway.inject({ cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body });
      return reqId;
    },

    event(from, event, reqId = randomBytes(8).toString('hex')) {
      gateway.inject({
        cmd: 'aibot_event_callback',
        headers: { req_id: reqId },
        body: { msgid: randomBytes(8).toString('hex'), from: { userid: from }, chattype: 'single', msgtype: 'event', event },
      });
      return reqId;
    },

    press(from, key) {
      return gateway.event(from, { eventtype: 'template_card_event', template_card_event: { event_key: key } });
    },

    // The way a dead network looks: no close frame, no further data.
    cut() {
      for (const socket of sockets) socket.destroy();
    },

    async until(read, what, ms = 10_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`等不到：${what}`);
        await sleep(5);
      }
    },

    async close() {
      gateway.cut();
      await new Promise((resolve) => server.close(resolve));
    },
  };

  function onFrame(socket, { opcode, payload }) {
    if (opcode === OP_CLOSE) {
      socket.write(encode(OP_CLOSE, Buffer.alloc(0)));
      socket.end();
      return;
    }
    if (opcode !== OP_TEXT) return;
    const frame = JSON.parse(payload.toString('utf8'));
    gateway.frames.push(frame);
    const answer = (reply) => {
      if (reply) socket.write(encode(OP_TEXT, Buffer.from(JSON.stringify({ headers: frame.headers, ...reply }))));
    };
    const plan = frame.body?.msgtype === 'stream' ? gateway.onStream(gateway.streams().at(-1), gateway.streams().length - 1) : undefined;
    if (plan === 'silent') return;
    if (plan?.delayMs !== undefined) {
      setTimeout(() => {
        if (!socket.destroyed) answer(gateway.answer(frame));
      }, plan.delayMs);
    } else {
      answer(plan ?? gateway.answer(frame));
    }
  }

  const server = createServer();
  server.on('upgrade', (request, socket) => {
    // The real gateway matches this header name case-sensitively and answers 404
    // otherwise (measured 2026-11-05); Node's built-in WebSocket sends it lowercase.
    if (!request.rawHeaders.includes('Sec-WebSocket-Key')) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}${GUID}`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    gateway.connections += 1;
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const { frames, rest } = decode(Buffer.concat([buffer, chunk]));
      buffer = rest;
      for (const frame of frames) onFrame(socket, frame);
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  gateway.url = `ws://127.0.0.1:${server.address().port}`;
  return gateway;
}
