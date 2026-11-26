// Guards against a join that meets a host of another protocol saying the wrong thing: the
// refusal rebuilt from this client's own constant would name this client's version twice
// ("客户端第 4 版，主机第 4 版"), hiding which end the owner has to upgrade. Both ways in — the
// six digits and a material — pass on the host's own words, as the running client does.
import './guard.ts';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { nodeCommand } from '../node/cli.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';

const HOST_PROTOCOL = NODE_PROTOCOL - 1;

// A host of the previous protocol: every join is refused with its own words.
async function oldHost(t: TestContext): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: `协议版本不符：这台机器上的客户端是第 ${NODE_PROTOCOL} 版，主机是第 ${HOST_PROTOCOL} 版。升级落后的那一个（tycho update），再重试。` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function joined(t: TestContext, extra: (dir: string) => string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-join-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const to = await oldHost(t);
  const note = (): void => {};
  try {
    await nodeCommand({ out: note, err: note, dataDir: dir, signal: new AbortController().signal }, ['join', '--to', to, '--name', 'pc', ...extra(dir)]);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('加入应该被拒');
}

const versions = new RegExp(`客户端是第 ${NODE_PROTOCOL} 版，主机是第 ${HOST_PROTOCOL} 版`);

test('加入时遇到另一版协议的主机：照主机的原话说两边各是第几版', async (t) => {
  assert.match(await joined(t, () => []), versions);
});

test('凭材料加入时遇到另一版协议的主机：同样照主机的原话说', async (t) => {
  const message = await joined(t, (dir) => {
    const file = join(dir, 'material');
    writeFileSync(file, 'ab'.repeat(32));
    const fd = openSync(file, 'r');
    t.after(() => closeSync(fd));
    return ['--material-fd', String(fd)];
  });
  assert.match(message, versions);
});
