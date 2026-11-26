// Guards docs/design/nodes.md §1.1 step 2, "本机接本机：不用放行", and the waiting record the
// join leaves on the machine.
//
// What this file is here to catch:
//   - a loopback join that shows this host's own token still waiting for the owner,
//   - a wrong token let in, or answered with an error instead of the ordinary six digits,
//   - the same token letting a join in through the outside listener (the gateway's requests
//     come from this machine too, so the peer address proves nothing there),
//   - the token written into a log line or the ledger's change rows,
//   (where the client may send the token is tests/node-join-token.test.ts),
//   - `tycho node status` still saying a request is waiting after the join went through.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { SETTINGS } from '../service/settings.ts';
import { createNodes } from '../service/nodes.ts';
import { serviceFile } from '../service/config.ts';
import { processStart } from '../service/lock.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';
import { identityOf, writePendingJoin } from '../node/client.ts';
import { nodeCommand } from '../node/cli.ts';
import { consoleApp, SHUTDOWN_TOKEN } from './console-helpers.ts';
import { fixture, NODES_TUNED } from './helpers.ts';

const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'this-pc', platform: 'win32 10', hostname: 'this-pc' };

async function host(t: TestContext) {
  const f = fixture(t);
  const logs: string[] = [];
  const nodes = createNodes({ ...NODES_TUNED,
    ledger: f.ledger,
    pollHoldMs: () => 30,
    commandTimeoutMs: () => SETTINGS['node.commandTimeoutMs'].default,
    joinTtlMs: () => SETTINGS['node.joinTtlMs'].default,
    gapSlackMs: () => SETTINGS['node.gapSlackMs'].default,
    log: (line) => logs.push(line),
  });
  const app = await consoleApp(t, { f, nodes });
  const ask = (base: string, body: object) => fetch(`${base}/api/node/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: NODE_PROTOCOL, facts: FACTS, ...body }),
  });
  return { f, app, nodes, logs, join: ask };
}

const tempDir = (t: TestContext, prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('本机令牌对的回环请求当场放行：一次写账本，时间线记“本机接入，免放行”，不留等着放行的请求', async (t) => {
  const h = await host(t);
  const answer = await h.join(h.app.url, { local_token: SHUTDOWN_TOKEN });
  assert.equal(answer.status, 200);
  const body = (await answer.json()) as { state: string; token: string; machine_id: string };
  assert.equal(body.state, 'approved');
  assert.equal(body.machine_id, 'this-pc');
  // The token it collected is the one the ledger now knows this machine by.
  assert.equal(h.nodes.authenticate(body.token)?.id, 'this-pc');
  assert.deepEqual(h.nodes.pendingJoins(), [], '没有留下等人放行的请求');
  const actions = h.f.peek<{ action: string }>("SELECT action FROM change WHERE action LIKE 'machine.join%' AND json_extract(detail_json, '$.machine_id') != 'h1' ORDER BY seq").map((row) => row.action);
  assert.deepEqual(actions, ['machine.join_local']);
});

test('本机令牌不对就走普通的六位数流程，不报错', async (t) => {
  const h = await host(t);
  const answer = await h.join(h.app.url, { local_token: 'not-the-token' });
  assert.equal(answer.status, 201);
  const body = (await answer.json()) as { state: string; code: string };
  assert.equal(body.state, 'pending');
  assert.match(body.code, /^\d{6}$/);
  assert.equal(h.f.ledger.listMachines().filter((machine) => machine.id !== 'h1').length, 0, '没有放行就没有机器');
});

test('对外监听上带着正确的本机令牌也不免放行：门牌进来的请求看起来也来自本机', async (t) => {
  const h = await outsideHost(t);
  const answer = await h.join(h.outsideUrl, { local_token: SHUTDOWN_TOKEN });
  assert.equal(answer.status, 201);
  assert.equal(((await answer.json()) as { state: string }).state, 'pending');
  assert.equal(h.f.ledger.listMachines().filter((machine) => machine.id !== 'h1').length, 0);
});

async function outsideHost(t: TestContext) {
  const h = await host(t);
  const port = await h.app.http.outside.listen(0);
  return { ...h, outsideUrl: `http://127.0.0.1:${port}` };
}

test('本机令牌不进日志，也不进 change', async (t) => {
  const h = await outsideHost(t);
  await h.join(h.app.url, { local_token: 'not-the-token' });
  await h.join(h.outsideUrl, { local_token: SHUTDOWN_TOKEN });
  await h.join(h.app.url, { facts: { ...FACTS, node_id: 'b1b2c3d4e5f60718', name: 'other' }, local_token: SHUTDOWN_TOKEN });
  const rows = h.f.peek<{ detail_json: string | null; actor: string }>('SELECT detail_json, actor FROM change');
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(JSON.stringify(row).includes(SHUTDOWN_TOKEN), false, '本机令牌进了 change');
  for (const line of h.logs) assert.equal(line.includes(SHUTDOWN_TOKEN), false, '本机令牌进了日志');
});

test('加入成功后等候记录清掉，tycho node status 不再说有等着放行的请求', async (t) => {
  const h = await host(t);
  const dataDir = tempDir(t, 'tycho-node-local-');
  // A host running on this data directory: the lock's holder is the one that wrote service.json.
  writeFileSync(serviceFile(dataDir), JSON.stringify({ pid: process.pid, port: h.app.port, token: SHUTDOWN_TOKEN }));
  writeFileSync(join(dataDir, 'lock'), JSON.stringify({ pid: process.pid, process_start: processStart(process.pid) }));
  // A request left from before, for this same address: the host no longer knows it.
  writePendingJoin(identityOf(dataDir), { secret: 'f'.repeat(64), code: '482913', origin: h.app.url });
  const said: string[] = [];
  const stop = new AbortController();
  const cli = {
    out: (line: string) => {
      said.push(line);
      // Joined: the resident client that follows is not under test here.
      if (line.startsWith('已加入')) stop.abort();
    },
    err: (line: string) => said.push(line),
    dataDir,
    signal: stop.signal,
  };
  await nodeCommand(cli, ['join', '--to', h.app.url, '--name', 'this-pc']).catch(() => {});
  assert.ok(said.some((line) => line.includes('本机接入，免放行')), said.join('\n'));
  assert.equal(h.f.ledger.listMachines().filter((machine) => machine.id !== 'h1').length, 1);

  const status: string[] = [];
  await nodeCommand({ ...cli, out: (line) => status.push(line), err: (line) => status.push(line) }, ['status']).catch(() => {});
  assert.equal(status.some((line) => line.includes('等着放行')), false, status.join('\n'));
});
