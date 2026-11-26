// Guards against the MCP stdio contract breaking: answers that do not match their
// request, a reply to a notification, a token that never reaches the service, and a
// failed HTTP call killing the Router's tool channel or being silently retried.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const PROXY = join(import.meta.dirname, '..', 'service', 'tools-proxy.ts');

interface Seen {
  path: string;
  authorization: string | undefined;
  body: unknown;
}

async function setup(t: TestContext, respond: (seen: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      };
      seen.push(entry);
      const { status, body } = respond(entry);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const child = spawn(process.execPath, [PROXY], {
    env: { ...process.env, TYCHO_TOOLS_PORT: String(port), TYCHO_TOOLS_TOKEN: 'secret' },
  });
  t.after(async () => {
    child.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const waiters = new Map<number, (message: any) => void>();
  const unmatched: unknown[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id: number };
    const waiter = waiters.get(message.id);
    if (waiter) waiter(message);
    else unmatched.push(message);
  });
  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { seen, request, notify, unmatched };
}

const answering = (body: unknown) => () => ({ status: 200, body });

test('initialize echoes the protocol version and declares tools, without calling the service', async (t) => {
  const { request, seen } = await setup(t, answering({}));
  const reply = await request('initialize', { protocolVersion: '2099-01-01' });
  assert.equal(reply.jsonrpc, '2.0');
  assert.equal(reply.result.protocolVersion, '2099-01-01');
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.match(reply.result.instructions, /唯一写入口/);
  assert.equal(seen.length, 0);
});

test('tools/list passes through with the token', async (t) => {
  const tools = [{ name: 'list_tasks', description: 'x', inputSchema: { type: 'object' } }];
  const { request, seen } = await setup(t, answering({ tools }));
  assert.deepEqual((await request('tools/list')).result, { tools });
  assert.deepEqual(seen[0], { path: '/tools/list', authorization: 'Bearer secret', body: {} });
});

test('tools/call forwards name and arguments and returns the content untouched', async (t) => {
  const content = { content: [{ type: 'text', text: '任务已创建' }] };
  const { request, seen } = await setup(t, answering(content));
  const reply = await request('tools/call', { name: 'create_task', arguments: { title: '标题' } });
  assert.deepEqual(reply.result, content);
  assert.deepEqual(seen[0]?.body, { name: 'create_task', arguments: { title: '标题' } });
});

test('a failed call becomes an isError result, is not retried, and the channel lives on', async (t) => {
  let failing = true;
  const { request, seen } = await setup(t, () =>
    failing ? { status: 500, body: { error: '炸了' } } : { status: 200, body: { tools: [] } },
  );
  const reply = await request('tools/call', { name: 'list_tasks', arguments: {} });
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].type, 'text');
  assert.match(reply.result.content[0].text, /500.*炸了/);
  assert.equal(seen.length, 1);
  failing = false;
  assert.deepEqual((await request('tools/list')).result, { tools: [] });
});

test('tools/list has no isError form, so its failure is a JSON-RPC error', async (t) => {
  const { request } = await setup(t, () => ({ status: 401, body: { error: 'token 无效' } }));
  const reply = await request('tools/list');
  assert.equal(reply.result, undefined);
  assert.match(reply.error.message, /401/);
});

test('a service that is gone gives the same isError result', async (t) => {
  const child = spawn(process.execPath, [PROXY], {
    env: { ...process.env, TYCHO_TOOLS_PORT: '1', TYCHO_TOOLS_TOKEN: 'secret' },
  });
  t.after(() => child.kill());
  const reply = await new Promise<any>((resolve) => {
    createInterface({ input: child.stdout }).once('line', (line) => resolve(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } })}\n`);
  });
  assert.equal(reply.result.isError, true);
});

test('a notification gets no reply and an unknown method gets a method-not-found error', async (t) => {
  const { request, notify, unmatched } = await setup(t, answering({}));
  notify('notifications/initialized');
  assert.equal((await request('prompts/list')).error.code, -32601);
  assert.deepEqual((await request('ping')).result, {});
  assert.deepEqual(unmatched, []);
});
