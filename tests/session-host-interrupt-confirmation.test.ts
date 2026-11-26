// Guards interrupt confirmations and grace limits against keeping the wrong process or losing a turn.
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

// One turn the fake holds until the interrupt, answered the way `control` says.
async function interrupted(t: TestContext, control: string, overrides: Partial<SessionHostOptions> = {}) {
  const context = setup(t, { FAKE_CLAUDE_CONTROL: control }, overrides);
  const { host, send, settled, outbound } = context;
  await host.start(1);
  await settled(send('先来一条'));
  const id = send('长回合');
  await until(() => outbound().some((row) => row.final === 0), '中间稿');
  assert.equal(host.interrupt(), true);
  assert.equal(await settled(id), 'unverified');
  return context;
}

test('the interrupt as recorded from the real CLI ends the turn and keeps the process', options, async (t) => {
  const { host, starts, send, settled, log } = await interrupted(t, 'replay');
  assert.equal(await settled(send('下一条')), 'processed');
  assert.equal(starts().length, 1);
  assert.equal(host.status().error, null);
  assert.equal(log().filter((entry) => entry.control === 'interrupt').length, 1);
});

test('confirmation then result keeps the process', options, async (t) => {
  const { host, starts, send, settled } = await interrupted(t, 'success');
  assert.equal(await settled(send('下一条')), 'processed');
  assert.equal(starts().length, 1);
  assert.equal(host.status().error, null);
});

test('a result ahead of its confirmation keeps the process too', options, async (t) => {
  const { starts, send, settled } = await interrupted(t, 'result-first');
  assert.equal(await settled(send('下一条')), 'processed');
  assert.equal(starts().length, 1);
});

test('a refused interrupt ends the process', options, async (t) => {
  const { f, host, starts, send, settled } = await interrupted(t, 'reject', { controlTimeoutMs: 60_000 });
  assert.equal(host.status().alive, false);
  assert.deepEqual(await hostProcesses.find(f.ledger.currentContext(f.projectId)!.marker), []);
  assert.equal(await settled(send('下一条')), 'processed');
  assert.equal(starts().length, 2);
});

test('a confirmation that never comes ends the process, even with a result in hand', options, async (t) => {
  const { host, starts } = await interrupted(t, 'silent', { controlTimeoutMs: 200 });
  assert.equal(host.status().alive, false);
  assert.equal(starts().length, 1);
});

test('a confirmation of some other request does not count', options, async (t) => {
  const { host } = await interrupted(t, 'wrong-id', { controlTimeoutMs: 200 });
  assert.equal(host.status().alive, false);
});

test('a confirmed interrupt with no result is killed at the grace limit', options, async (t) => {
  const { host } = await interrupted(t, 'no-result', { interruptGraceMs: () => 200 });
  assert.equal(host.status().alive, false);
});
