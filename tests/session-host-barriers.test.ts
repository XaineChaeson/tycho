// Guards restart barriers against starting a driver during degraded mode or inventory.
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

// --- a start held back by a barrier (§2) ---


for (const kind of ['degraded', 'recovering'] as const) {
  test(`a restart accepted before ${kind} begins starts nothing while it lasts, says what it waits for, and goes on by itself afterwards`, options, async (t) => {
    const barriers = steady();
    const { host, send, settled, state, starts } = setup(t, {}, { barriers });
    await host.start(1);
    await settled(send('先来一条'));
    // Accepted while all is well; the barrier is up before the old process is gone.
    const restarted = host.restart();
    barriers[kind] = true;
    const queued = send('重启时来的');
    await until(() => host.status().waiting === kind || starts().length > 1, '重启走到启动那一步');
    await sleep(100);
    assert.equal(starts().length, 1, '屏障期间拉起了新的负责人进程');
    const waiting = host.status();
    assert.deepEqual([waiting.alive, waiting.restarting, waiting.waiting, waiting.error], [false, true, kind, null]);
    assert.equal(state(queued), 'received');
    barriers[kind] = false;
    await restarted;
    assert.equal(await settled(queued), 'processed');
    const after = host.status();
    assert.deepEqual([starts().length, after.alive, after.restarting, after.waiting], [2, true, false, null]);
  });
}

test('a barrier that begins while a restart waits for the turn under way holds the next start once that turn is over', options, async (t) => {
  const barriers = steady();
  const { host, send, settled, starts, users, state } = setup(t, {}, { barriers });
  await host.start(1);
  await settled(send('先来一条'));
  const long = send('长回合');
  await until(() => users().includes('长回合'), '回合开始');
  const restarted = host.restart();
  barriers.recovering = true;
  await sleep(100);
  assert.deepEqual([host.status().turn, host.status().waiting], [long, null], '还在等回合，不是在等屏障');
  host.interrupt();
  assert.equal(await settled(long), 'unverified');
  await until(() => host.status().waiting === 'recovering', '重启等屏障');
  const queued = send('屏障期间来的');
  host.kick(queued);
  await sleep(100);
  assert.deepEqual([starts().length, host.status().alive, state(queued)], [1, false, 'received'], '屏障期间拉起了新的负责人进程');
  barriers.recovering = false;
  await restarted;
  assert.equal(await settled(queued), 'processed');
  assert.equal(starts().length, 2, '屏障解除后才起新进程');
});
