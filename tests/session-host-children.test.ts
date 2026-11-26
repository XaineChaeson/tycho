// Guards Router child cleanup and tool admission against orphaned processes and calls after interruption.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Processes, RouterLaunch, SessionHost, SessionHostOptions, TurnObserver } from '../service/session-host.ts';
import type { RouterKnowledge } from '../service/knowledge-brief.ts';
import type { LedgerOptions } from '../service/ledger.ts';
import { hostProcesses } from '../service/processes.ts';
import { createSessionHost, RouterUnavailable } from '../service/session-host.ts';
import { routerMaterial } from '../service/router-material.ts';
import { claudeTier, fixture, ROUTER_TUNED, tuned, USER } from './helpers.ts';

import { hostLogin, openContext, TOKEN, FAKE, NO_STDIN, POSIX_ONLY, TOOLS, MCP_TOOLS, options, until, type LogEntry, childPids, type Barriers, setup, admitted, existingSession, closedStdin, steady } from './session-host-fixture.ts';

test('a root that dies mid turn does not take its children along, and the sweep finds them', options, async (t) => {
  const { f, host, send, settled, log } = setup(t, { FAKE_CLAUDE_CHILD: 'sleeper' });
  await host.start(1);
  await settled(send('先来一条'));
  const { marker } = f.ledger.currentContext(f.projectId)!;
  const child = childPids(log())[0]!;
  assert.ok((await hostProcesses.find(marker)).includes(child));
  assert.equal(await settled(send('崩溃')), 'unverified');
  assert.deepEqual(await hostProcesses.find(marker), []);
  assert.equal(host.status().error, null);
});

test('a root that dies between turns is swept without waiting for a message', options, async (t) => {
  const { f, host, send, settled, log, starts } = setup(t, { FAKE_CLAUDE_CHILD: 'sleeper' });
  await host.start(1);
  await settled(send('先来一条'));
  const { marker } = f.ledger.currentContext(f.projectId)!;
  process.kill(starts()[0]!.pid!);
  await until(() => !host.status().alive, '进程退出');
  const deadline = Date.now() + 20_000;
  while ((await hostProcesses.find(marker)).length > 0) {
    assert.ok(Date.now() < deadline, `还在：${childPids(log()).join(', ')}`);
    await sleep(100);
  }
  assert.equal(await settled(send('下一条')), 'processed');
});

function failingScan() {
  const state = { failing: false };
  const processes: Processes = {
    find: (marker) => (state.failing ? Promise.reject(new Error('进程表读不了')) : hostProcesses.find(marker)),
    kill: hostProcesses.kill,
  };
  return { state, processes };
}

test('a scan that fails after a turn died halts the Host and keeps the session', options, async (t) => {
  const { state: scan, processes } = failingScan();
  const { f, host, send, settled, state, starts } = setup(t, {}, { processes });
  await host.start(1);
  await settled(send('先来一条'));
  const { marker } = f.ledger.currentContext(f.projectId)!;
  scan.failing = true;
  assert.equal(await settled(send('崩溃')), 'unverified');
  assert.match(host.status().error!, /进程表读不了/);
  const later = send('再来');
  await sleep(200);
  assert.equal(state(later), 'received');
  assert.equal(starts().length, 1);
  scan.failing = false;
  assert.equal(f.ledger.currentContext(f.projectId)?.marker, marker);
});

test('a tree that will not clear halts the Host the same way', options, async (t) => {
  const state = { stuck: false };
  const processes: Processes = {
    find: (marker) => (state.stuck ? Promise.resolve([1]) : hostProcesses.find(marker)),
    kill: async (pid, marker) => {
      if (!state.stuck) await hostProcesses.kill(pid, marker);
    },
  };
  const { f, host, send, settled, starts } = setup(t, {}, { processes });
  await host.start(1);
  await settled(send('先来一条'));
  state.stuck = true;
  assert.equal(await settled(send('崩溃')), 'unverified');
  assert.match(host.status().error!, /清不掉/);
  assert.equal(starts().length, 1);
  assert.ok(f.ledger.currentContext(f.projectId));
  state.stuck = false;
});

test('a failed resume keeps its session when the tree cannot be confirmed clear', options, async (t) => {
  // The look before the start works; the one after the failed resume does not.
  let finds = 0;
  let failing = true;
  const processes: Processes = {
    find: (marker) => (++finds > 1 && failing ? Promise.reject(new Error('进程表读不了')) : hostProcesses.find(marker)),
    kill: hostProcesses.kill,
  };
  const { f, host, send, state, starts, logLines } = setup(t, { FAKE_CLAUDE_RESUME: 'exit' }, { processes });
  const ref = existingSession(f);
  await host.start(1);
  const first = send('第一条');
  await until(() => host.status().error, '停摆');
  assert.equal(f.ledger.currentContext(f.projectId)?.marker, ref, logLines.join('\n'));
  await sleep(100);
  assert.equal(state(first), 'received', '没送到的消息留着');
  assert.equal(starts().length, 1);
  failing = false;
});

test('each process gets its own tool token, and none is valid while no process runs', options, async (t) => {
  const { host, send, settled } = setup(t);
  await host.start(1);
  await settled(send('先来一条'));
  const first = host.toolTokens()[0];
  assert.ok(first);
  assert.equal(await settled(send('崩溃')), 'unverified');
  assert.equal(host.toolTokens()[0], undefined);
  assert.equal(await settled(send('下一条')), 'processed');
  assert.ok(host.toolTokens()[0]);
  assert.notEqual(host.toolTokens()[0], first);
});

test('from the interrupt on, new tool calls are refused and say why', options, async (t) => {
  const { host, send, settled, outbound } = setup(t, { FAKE_CLAUDE_CONTROL: 'no-result' }, { interruptGraceMs: () => 500 });
  await host.start(1);
  await settled(send('先来一条'));
  const id = send('长回合');
  await until(() => outbound().some((row) => row.final === 0), '中间稿');
  assert.equal(admitted(host), id);
  host.interrupt();
  const refused = host.admitTool(host.toolTokens()[0]);
  assert.ok('refused' in refused);
  assert.match(refused.refused, /回合已中断/);
  await settled(id);
});

test('a call in flight holds the turn open and keeps its message', options, async (t) => {
  const { host, send, settled, state, outbound } = setup(t);
  await host.start(1);
  await settled(send('先来一条'));
  const id = send('长回合');
  await until(() => outbound().some((row) => row.final === 0), '中间稿');
  const call = host.admitTool(host.toolTokens()[0]);
  assert.ok('messageId' in call);
  host.interrupt();
  await sleep(300);
  assert.equal(state(id), 'processing');
  assert.equal(call.messageId, id);
  call.done();
  assert.equal(await settled(id), 'unverified');
});

test('a call that never ends does not hold the turn open past the limit', options, async (t) => {
  const { host, send, settled, outbound, logLines } = setup(t, {}, { toolDrainMs: 100 });
  await host.start(1);
  await settled(send('先来一条'));
  const id = send('长回合');
  await until(() => outbound().some((row) => row.final === 0), '中间稿');
  assert.ok('messageId' in host.admitTool(host.toolTokens()[0]));
  host.interrupt();
  assert.equal(await settled(id), 'unverified');
  assert.ok(logLines.some((line) => line.includes('工具调用没结束')));
});
