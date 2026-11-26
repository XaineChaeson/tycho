// Guards failed startup and stop against taking messages or admitting tools without a working Router.
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

test('a CLI that cannot start stops the Host instead of failing message after message', options, async (t) => {
  const { host, send, state, logLines, events } = setup(t, {}, { claude: ['Z:\\nowhere\\claude.exe'] });
  const first = send('第一条');
  const second = send('第二条');
  await host.start(1);
  // A project's Router starts for its first message, and that start is what fails.
  assert.match(await until(() => host.status().error ?? undefined, '停摆'), /负责人启动失败/, logLines.join('\n'));
  // No commit says the Router stopped: the settings page is told all the same.
  assert.ok(events.some(({ event }) => event === 'changed'), '停摆没有告诉控制台');
  await sleep(200);
  assert.equal(state(first), 'received');
  assert.equal(state(second), 'received');
});

test('from stop on, no new message is consumed and no tool is admitted', options, async (t) => {
  const { host, send, settled, state, outbound } = setup(t);
  await host.start(1);
  await settled(send('先来一条'));
  const held = send('不理会');
  await until(() => outbound().some((row) => row.final === 0), '中间稿');
  const stopping = host.stop();
  assert.equal(admitted(host), undefined);
  const later = send('停止时来的');
  host.kick();
  await stopping;
  assert.equal(state(held), 'unverified');
  assert.equal(state(later), 'received');
});

test('stopping the Router is reported once, whatever comes after', options, async (t) => {
  const stuck = { find: async () => [1], kill: async () => {} };
  const { f, make } = setup(t);
  openContext(f, randomUUID());
  const reasons: string[] = [];
  const host = make({ processes: stuck, onHalt: (reason: string) => reasons.push(reason) });
  await assert.rejects(host.cleanup());
  await host.start(1);
  host.kick(f.ledger.receiveMessage({ channel: 'console', externalId: 'w', actor: 'user', text: '等着', projectId: f.projectId }).id);
  await sleep(100);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /清不掉/);
});
