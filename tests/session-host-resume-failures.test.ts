// Guards failed processes and unexpected tools against redelivery and an unsafe Router.
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

test('a process that dies mid turn leaves the message unverified; the next one resumes', options, async (t) => {
  const { f, host, send, settled, starts, users } = setup(t);
  await host.start(1);
  await settled(send('先来一条'));
  const ref = f.ledger.currentContext(f.projectId)?.session_ref;
  assert.equal(await settled(send('崩溃')), 'unverified');
  assert.equal(host.status().alive, false);
  assert.equal(starts().length, 1);
  assert.equal(await settled(send('下一条')), 'processed');
  const argv = starts()[1]?.argv!;
  assert.equal(argv[argv.indexOf('--resume') + 1], ref);
  assert.equal(users().filter((text) => text.includes('从账本重建')).length, 1);
});

test('a session that never reported in is not resumed', options, async (t) => {
  const { f, host, send, settled, starts } = setup(t);
  const stale = openContext(f, randomUUID());
  await host.start(1);
  assert.equal(await settled(send('你好')), 'processed');
  assert.equal(starts()[0]?.argv?.includes('--resume'), false);
  assert.notEqual(f.ledger.currentContext(f.projectId)?.id, stale.id);
});

test('extra native tools alongside Tycho MCP tools are allowed', options, async (t) => {
  const { host, send, settled } = setup(t, {
    FAKE_CLAUDE_TOOLS: JSON.stringify([...MCP_TOOLS, 'Edit', 'Bash']),
  });
  await host.start(1);
  assert.equal(await settled(send('你好')), 'processed');
  assert.equal(host.status().error, null);
});

test('a tool list missing required Tycho MCP tools stops the process and refuses to drive it further', options, async (t) => {
  const { f, host, send, settled, state, starts, outbound } = setup(t, { FAKE_CLAUDE_TOOLS: JSON.stringify(MCP_TOOLS.slice(1)) });
  await host.start(1);
  const id = send('你好');
  assert.equal(await settled(id), 'unverified');
  assert.match(host.status().error!, /工具列表不符/);
  await until(() => !host.status().alive, '进程退出');
  assert.deepEqual(await hostProcesses.find(f.ledger.currentContext(f.projectId)!.marker), []);
  const later = send('再来');
  await sleep(200);
  assert.equal(state(later), 'received');
  assert.equal(starts().length, 1);
  assert.equal(outbound().length, 0);
});
