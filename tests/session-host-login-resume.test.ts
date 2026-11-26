// Guards session resumption against changing the identity it was opened under.
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

// --- a session and the login it was opened under ---

test('a login changed since the session was opened gets a new session with the overview, and no message pays for finding out', options, async (t) => {
  let account = 'account-a';
  // A resume here fails on its first turn, the way one does under a login that never
  // had the conversation.
  const { f, host, send, settled, users, starts } = setup(t, { FAKE_CLAUDE_RESUME: 'error' }, {
    launchWith: async () => ({ claude: [process.execPath, FAKE], account }),
  });
  await host.start(1);
  assert.equal(await settled(send('先来一条')), 'processed');
  const old = f.ledger.currentContext(f.projectId)!;
  account = 'account-b';
  const restarted = host.restart();
  const [first, second] = [send('第一条'), send('第二条')];
  await restarted;
  assert.equal(await settled(first), 'processed');
  assert.equal(await settled(second), 'processed');
  const { argv } = starts()[1]!;
  assert.equal(argv!.includes('--resume'), false);
  assert.equal(f.ledger.currentContext(f.projectId)!.login_id, 'account-b');
  assert.notEqual(f.ledger.currentContext(f.projectId)!.id, old.id);
  assert.match(users().at(-3)!, /从账本重建/);
  assert.deepEqual(users().slice(-2), ['第一条', '第二条']);
  assert.deepEqual(await hostProcesses.find(old.marker), []);
});

test('the same holds when it was the whole service that restarted in between', options, async (t) => {
  const { f, host, make, send, settled, users, starts } = setup(t, { FAKE_CLAUDE_RESUME: 'error' }, { account: 'account-a' });
  await host.start(1);
  assert.equal(await settled(send('先来一条')), 'processed');
  const old = f.ledger.currentContext(f.projectId)!;
  await host.stop();
  assert.equal(f.ledger.currentContext(f.projectId)?.id, old.id);
  const [first, second] = [send('第一条'), send('第二条')];
  const again = make({ launchWith: async () => ({ claude: [process.execPath, FAKE] }) });
  // Here, not in t.after: the fixture's hook comes first and closes the ledger.
  try {
    await again.start(1);
    assert.equal(await settled(first), 'processed');
    assert.equal(await settled(second), 'processed');
    const { argv } = starts()[1]!;
    assert.equal(argv!.includes('--resume'), false, '回到这台电脑的登录：不续接账号的会话');
    assert.notEqual(f.ledger.currentContext(f.projectId)!.id, old.id);
    assert.match(users().at(-3)!, /从账本重建/);
  } finally {
    await again.stop();
  }
});

test('under the login it was opened with, the session is kept', options, async (t) => {
  const { f, host, send, settled, starts } = setup(t, {}, { account: 'account-a' });
  await host.start(1);
  assert.equal(await settled(send('先来一条')), 'processed');
  const session = f.ledger.currentContext(f.projectId)!;
  await host.restart();
  assert.equal(await settled(send('继续')), 'processed');
  const { argv } = starts()[1]!;
  assert.equal(argv![argv!.indexOf('--resume') + 1], session.session_ref);
  assert.equal(f.ledger.currentContext(f.projectId)!.id, session.id);
});
