// Guards session resume and failed starts against lost messages, unsafe tools and stale drivers.
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

test('a stored session is resumed, without an overview, and stays findable by marker', options, async (t) => {
  const { f, host, send, settled, users, starts } = setup(t);
  const ref = existingSession(f);
  await host.start(1);
  await settled(send('继续'));
  const { argv } = starts()[0]!;
  assert.equal(argv![argv!.indexOf('--resume') + 1], ref);
  assert.equal(argv!.includes('--session-id'), false);
  assert.deepEqual(users(), ['继续']);
  assert.equal(f.ledger.currentContext(f.projectId)?.session_ref, ref);
  assert.equal((await hostProcesses.find(ref)).length, 1);
});

test('a resume whose first turn fails marks that message and opens a new session with the overview', options, async (t) => {
  const { f, host, send, settled, users, starts } = setup(t, { FAKE_CLAUDE_RESUME: 'error' });
  const ref = existingSession(f);
  await host.start(1);
  const lost = send('第一条');
  assert.equal(await settled(lost), 'unverified');
  assert.equal(await settled(send('第二条')), 'processed');
  assert.equal(starts().length, 2);
  assert.equal(starts()[1]?.argv?.includes('--resume'), false);
  assert.notEqual(f.ledger.currentContext(f.projectId)?.marker, ref);
  assert.match(users().at(-2)!, /从账本重建/);
  assert.equal(users().at(-1), '第二条');
  assert.deepEqual(await hostProcesses.find(ref), []);
});

test('a resume with no init in time counts as failed too', options, async (t) => {
  // Short only for the process that is never going to init: the new one has to start under
  // whatever load the machine has, and a limit it could miss would fail the wrong message.
  let initLimit = 300;
  const { f, host, send, settled, starts } = setup(t, { FAKE_CLAUDE_RESUME: 'silent' }, { initTimeoutMs: () => initLimit });
  const ref = existingSession(f);
  await host.start(1);
  assert.equal(await settled(send('第一条')), 'unverified');
  initLimit = 20_000;
  assert.equal(await settled(send('第二条')), 'processed');
  assert.equal(starts()[1]?.argv?.includes('--resume'), false);
  assert.notEqual(f.ledger.currentContext(f.projectId)?.marker, ref);
});

test('a resume that fails by itself before any turn costs no message', options, async (t) => {
  const { f, host, send, settled, starts, users } = setup(t, { FAKE_CLAUDE_RESUME: 'exit' });
  const ref = existingSession(f);
  const old = f.ledger.currentContext(f.projectId)!;
  await host.start(1);
  // The message goes to the resumed process, which is gone before it ever initialised: it
  // never reached a model, so it waits for the new context instead of being lost.
  const id = send('第一条');
  assert.equal(await settled(id), 'processed');
  assert.equal(starts().length, 2);
  assert.ok(starts()[0]?.argv?.includes('--resume'));
  assert.equal(starts()[1]?.argv?.includes('--resume'), false);
  assert.notEqual(f.ledger.currentContext(f.projectId)?.marker, ref);
  assert.deepEqual([f.ledger.getContext(old.id)!.state, f.ledger.getContext(old.id)!.closed_reason], ['closed', '续接失败']);
  assert.deepEqual(users().filter((text) => text === '第一条'), ['第一条'], '新上下文里只送了一次');
  assert.deepEqual(f.peek<{ action: string }>(`SELECT action FROM change WHERE action = 'message.requeue'`).length, 1);
});

test('a resume the CLI refuses puts every event of its turn back, and the new context takes them once', options, async (t) => {
  const { f, host, settled, users } = setup(t, { FAKE_CLAUDE_RESUME: 'exit' });
  existingSession(f);
  const ids = ['a', 'b', 'c'].map((tag) =>
    f.ledger.receiveMessage({ channel: 'internal', externalId: `event-${tag}`, actor: 'runner', text: `事件 ${tag}`, projectId: f.projectId }).id);
  await host.start(1);
  for (const id of ids) assert.equal(await settled(id), 'processed');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'message.requeue'`).length, 3, '三条都回到了队列');
  const merged = users().filter((text) => text.startsWith('[tycho 内部事件] 以下为资料'));
  assert.equal(merged.length, 1, '新上下文一次收下三条');
  assert.equal(merged[0]!.split('\n').length, 4);
});
