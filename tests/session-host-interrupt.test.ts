// Guards broken input, turn deadlines and interrupt acknowledgements against lost or repeated turns.
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

test('a process alive with its stdin closed fails the turn and is replaced', options, async (t) => {
  // The first message is written while the process is still starting, before it closes its
  // stdin: it is never read, and the turn fails for want of an init.
  // Short only while the process cannot init: the working one swapped in afterwards has to
  // start under whatever load the machine has.
  let initLimit = 1500;
  const { f, host, send, settled, starts, users, claude } = closedStdin(t, {}, { initTimeoutMs: () => initLimit });
  await host.start(1);
  const first = send('下一条');
  assert.equal(await settled(first), 'unverified');
  const { marker } = f.ledger.getContext(f.peek<{ id: string }>('SELECT id FROM router_context ORDER BY rowid DESC LIMIT 1')[0]!.id)!;
  assert.deepEqual(await hostProcesses.find(marker), []);
  assert.equal(host.status().error, null);
  claude.splice(0, claude.length, process.execPath, FAKE);
  initLimit = 20_000;

  assert.equal(await settled(send('再来')), 'processed');
  assert.equal(starts().length, 1);
  assert.ok(!users().includes('下一条'));
});

test('an interrupt that cannot be written ends the turn the same way', options, async (t) => {
  const { f, host, send, settled, closedYet, logLines } = closedStdin(t, { FAKE_CLAUDE_READ_FIRST: '1' });
  await host.start(1);
  const id = send('卡住的回合');
  await closedYet();
  // The context is opened for the first message: a project's Router starts when it has one.
  const { marker } = f.ledger.currentContext(f.projectId)!;
  assert.equal(host.interrupt(), true);
  assert.equal(await settled(id), 'unverified');
  assert.ok(logLines.some((line) => line.includes('写入负责人输入失败')), logLines.join('\n'));
  assert.deepEqual(await hostProcesses.find(marker), []);
  assert.equal(host.status().alive, false);
  assert.equal(host.status().error, null);
});

test('a turn with an init and no result is interrupted at the limit, then killed; not sent again', options, async (t) => {
  const { host, send, settled, log, users, starts } = setup(t, {}, { turnTimeoutMs: () => 300, interruptGraceMs: () => 100 });
  await host.start(1);
  await settled(send('先来一条'));
  const id = send('不理会');
  assert.equal(await settled(id), 'unverified');
  assert.ok(log().some((entry) => entry.control === 'interrupt'));
  assert.equal(await settled(send('下一条')), 'processed');
  assert.ok(starts()[1]?.argv?.includes('--resume'));
  assert.equal(users().filter((text) => text === '不理会').length, 1);
});

test('the limit is read at each turn, so a change applies from the next one', options, async (t) => {
  let limit = 60_000;
  const { host, send, settled, log } = setup(t, {}, { turnTimeoutMs: () => limit, interruptGraceMs: () => 100 });
  await host.start(1);
  await settled(send('先来一条'));
  assert.ok(!log().some((entry) => entry.control === 'interrupt'));
  limit = 300;
  assert.equal(await settled(send('不理会')), 'unverified');
  assert.ok(log().some((entry) => entry.control === 'interrupt'));
});

test('the overview turn has the same limit', options, async (t) => {
  const { host, send, settled, starts } = setup(
    t,
    { FAKE_CLAUDE_HOLD_OVERVIEW: '1', FAKE_CLAUDE_CONTROL: 'no-result' },
    { turnTimeoutMs: () => 300, interruptGraceMs: () => 100 },
  );
  await host.start(1);
  assert.equal(await settled(send('你好')), 'unverified');
  assert.equal(starts().length, 1);
  assert.equal(host.status().alive, false);
});
