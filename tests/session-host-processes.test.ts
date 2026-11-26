// Guards startup cleanup not saying what it asked the process table for.
// Guards process ownership, cleanup and stop bookkeeping against surviving or unconfirmed Router trees.
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

test('cleanup says how many queries it made and what they matched', options, async (t) => {
  const processes: Processes = {
    find: async () => [],
    kill: async () => { throw new Error('unexpected kill'); },
  };
  const { f, host } = setup(t, {}, { processes });
  f.ledger.setContextStarted(openContext(f, randomUUID()).id, null);
  const result = await host.cleanup();
  // One context with nothing left: one query, and it matched no process.
  assert.deepEqual(result, { queries: 1, matches: 0 });
});

test('cleanup retains open Codex homes and only removes safe abandoned homes', options, async (t) => {
  const active = randomUUID();
  const orphan = randomUUID();
  const busy = randomUUID();
  const processes: Processes = {
    find: async marker => marker === busy ? [123] : [],
    kill: async () => { throw new Error('unexpected kill'); },
  };
  const { f, host } = setup(t, {}, { processes });
  openContext(f, active);
  const dir = join(f.dir, 'router');
  for (const marker of [active, orphan, busy]) mkdirSync(join(dir, `codex-home-${marker}`), { recursive: true });
  mkdirSync(join(dir, 'codex-home-unrelated'));
  await host.cleanup();
  assert.ok(existsSync(join(dir, `codex-home-${active}`)));
  assert.ok(!existsSync(join(dir, `codex-home-${orphan}`)));
  assert.ok(existsSync(join(dir, `codex-home-${busy}`)));
  assert.ok(existsSync(join(dir, 'codex-home-unrelated')));
  f.ledger.closeContext(f.ledger.currentContext(f.projectId)!.id, 'test');
  await host.cleanup();
  assert.ok(!existsSync(join(dir, `codex-home-${active}`)));
});

test('cleanup finds a leftover Router by marker and kills it', options, async (t) => {
  const { f, host, log } = setup(t);
  const marker = randomUUID();
  f.ledger.setContextStarted(openContext(f, marker).id, null);
  const leftover = spawn(process.execPath, [FAKE, '--session-id', marker], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => leftover.kill());
  await until(() => log().some((entry) => entry.pid === leftover.pid), '残留进程启动');
  await host.cleanup();
  assert.deepEqual(await hostProcesses.find(marker), []);
});

test('a process table handed in is the one the Host asks, and every kill names the marker', options, async (t) => {
  const asked: unknown[][] = [];
  const processes: Processes = {
    find(marker) {
      asked.push(['find', marker]);
      return hostProcesses.find(marker);
    },
    kill(pid, marker) {
      asked.push(['kill', pid, marker]);
      return hostProcesses.kill(pid, marker);
    },
  };
  const { f, host, send, settled, starts } = setup(t, {}, { processes });
  await host.start(1);
  await settled(send('先来一条'));
  const { marker } = f.ledger.currentContext(f.projectId)!;
  const root = starts()[0]!.pid!;
  await host.stop();
  assert.deepEqual(asked.filter(([what]) => what === 'kill'), [['kill', root, marker]]);
  assert.ok(asked.some(([what, which]) => what === 'find' && which === marker));
  assert.deepEqual(await hostProcesses.find(marker), []);
});

test('a kill that fails at stop is reported, and the stop still finishes its own bookkeeping', options, async (t) => {
  const state = { failing: false };
  const processes: Processes = {
    find: hostProcesses.find,
    kill: (pid, marker) => (state.failing ? Promise.reject(new Error('信号发不出去')) : hostProcesses.kill(pid, marker)),
  };
  const { f, host, send, settled, starts } = setup(t, {}, { processes });
  await host.start(1);
  await settled(send('先来一条'));
  const session = f.ledger.currentContext(f.projectId)!;
  const root = starts()[0]!.pid!;
  assert.ok(session.pid);
  state.failing = true;
  try {
    await assert.rejects(host.stop(), /信号发不出去/);
    // The bookkeeping is the stop's own and is finished even so: the pid is written as gone
    // and the mcp file is taken away. What the failed kill left behind is still the ledger's
    // to find — the marker stays, and that is what a release scans for before it decides
    // whether the version before this one may open the same ledger.
    assert.equal(f.ledger.currentContext(f.projectId)?.pid, null);
    assert.equal(f.ledger.currentContext(f.projectId)?.marker, session.marker);
    assert.deepEqual(await hostProcesses.find(session.marker), [root]);
    assert.deepEqual(readdirSync(join(f.dir, 'router')), []);
  } finally {
    // Whatever happened above, the stop in the test's teardown must take the tree down.
    state.failing = false;
  }
});

// The process group a pid is in, asked of the system and not of the code under test.
function groupOf(pid: number): number {
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  }
  return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

test('the Router leads a process group of its own, apart from the service', { ...options, skip: POSIX_ONLY }, async (t) => {
  const { host, send, settled, starts, log } = setup(t, { FAKE_CLAUDE_CHILD: 'sleeper' });
  await host.start(1);
  // A turn went in and came out: the pipes work across the new session.
  assert.equal(await settled(send('先来一条')), 'processed');
  const root = starts()[0]!.pid!;
  assert.equal(groupOf(root), root);
  assert.notEqual(groupOf(process.pid), root);
  // What it starts stays with it, so one signal to the group reaches both.
  assert.equal(groupOf(childPids(log())[0]!), root);
});

test('a leftover that cannot be cleared blocks every new driver', options, async (t) => {
  const stuck = { find: async () => [1], kill: async () => {} };
  const { f, make, starts } = setup(t);
  openContext(f, randomUUID());
  const host = make({ processes: stuck });
  await assert.rejects(host.cleanup(), /清不掉/);
  await host.start(1);
  assert.match(host.status().error!, /清不掉/);
  const waiting = f.ledger.receiveMessage({ channel: 'console', externalId: 'w', actor: 'user', text: '等着', projectId: f.projectId }).id;
  host.kick(waiting);
  await sleep(200);
  assert.equal(f.ledger.getMessage(waiting).state, 'received', '消息留在账本里');
  assert.equal(starts().length, 0);
});
