import { createServer, type IncomingMessage } from 'node:http';
import { CallbackError, CALLBACK_PATH, readCallback, type CallbackPolicy } from './callback.ts';
import type { openFeishuQueue } from './queue.ts';

const MAX_BODY = 256 * 1024;
const READ_MS = 1800;

function bytes(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => fail(new CallbackError(408)), READ_MS);
    function fail(error: Error): void {
      clearTimeout(timer);
      failed = true;
      request.removeListener('data', append);
      request.pause();
      reject(error);
    }
    function append(chunk: Buffer): void {
      size += chunk.length;
      if (size > MAX_BODY) fail(new CallbackError(413));
      else chunks.push(chunk);
    }
    request.on('data', append);
    request.once('error', fail);
    request.once('end', () => {
      clearTimeout(timer);
      if (!failed) resolve(Buffer.concat(chunks, size));
    });
  });
}

export function createFeishuServer(policy: CallbackPolicy, queue: Pick<ReturnType<typeof openFeishuQueue>, 'record'>, now = Date.now) {
  return createServer({ headersTimeout: 3000, requestTimeout: 3000 }, async (request, response) => {
    const send = (status: number, body: object): void => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status >= 400 ? { Connection: 'close' } : {}) });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST' || request.url !== CALLBACK_PATH) {
      send(404, {});
      return;
    }
    try {
      const event = readCallback(await bytes(request), request.headers, policy, now());
      if (event.type === 'challenge') send(200, { challenge: event.challenge });
      else {
        if (event.type === 'message') queue.record(event.message);
        send(200, {});
      }
    } catch (error) {
      send(error instanceof CallbackError ? error.status : 503, {});
    }
  });
}
