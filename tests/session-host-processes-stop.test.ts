// Guards Router stop, startup tools and MCP cleanup against surviving processes or false completion.
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

// The MCP config is this Host's own file, not the Router's process. One the file system
// will not let go of — Windows keeps a file another process still holds — must be logged
// and left, not reported as a stop that did not finish: `tycho stop` and the upgrade path
// read that answer as "a process of the old version is still out there".
test('a stop whose MCP config cannot be removed still stops cleanly, and says so', options, async (t) => {
  const quiet = { find: async () => [], kill: async () => {} };
  // 一个起不来的 CLI：配置照样先写在磁盘上，这正是要留一个删不掉的文件的那一刻。
  void quiet;
  const { f, make, logLines, send, settled } = setup(t);
  const host = make();
  await host.start(1);
  assert.equal(await settled(send('先来一条')), 'processed');
  const session = f.ledger.currentContext(f.projectId)!;
  const file = join(f.dir, 'router', `mcp-${session.marker}.json`);
  assert.equal(existsSync(file), true, '这一轮确实写下了 MCP 配置');
  // 名字被一个目录占着：删文件那一步会失败。
  rmSync(file);
  mkdirSync(file, { recursive: true });

  await host.stop();
  assert.ok(
    logLines.some((line) => /删除负责人的 MCP 配置失败/.test(line)),
    `删不掉要如实记下来，不能装作收干净了：${JSON.stringify(logLines)}`,
  );
  rmSync(file, { recursive: true, force: true });
});

test('stop interrupts the turn, clears the tree, and leaves the session to resume', options, async (t) => {
  const { f, host, send, settled, state, outbound } = setup(t);
  await host.start(1);
  await settled(send('先来一条'));
  const id = send('不理会');
  await until(() => outbound().some((row) => row.final === 0), '中间稿');
  const session = f.ledger.currentContext(f.projectId)!;
  await host.stop();
  assert.equal(state(id), 'unverified');
  assert.deepEqual(await hostProcesses.find(session.marker), []);
  assert.equal(f.ledger.currentContext(f.projectId)?.id, session.id);
  assert.equal(f.ledger.currentContext(f.projectId)?.pid, null);
  assert.deepEqual(readdirSync(join(f.dir, 'router')), []);
});

test('tools stay shut during the overview, and a failed overview is sent again', options, async (t) => {
  const { host, send, settled, users } = setup(t, { FAKE_CLAUDE_HOLD_OVERVIEW: '1' });
  await host.start(1);
  const id = send('你好');
  await until(() => users()[0], '概览回合');
  assert.equal(host.status().turn, id);
  assert.equal(admitted(host), undefined);
  host.interrupt();
  assert.equal(await settled(id), 'unverified');
  assert.deepEqual(users().filter((text) => text === '你好'), []);
  const next = send('第二条');
  await until(() => users().length === 2, '第二次概览');
  assert.match(users()[1]!, /从账本重建/);
  assert.equal(host.interrupt(), true);
  await settled(next);
});

test('the role prompt reaches the CLI exactly as the file has it', options, async (t) => {
  const { host, send, settled, starts } = setup(t);
  await host.start(1);
  await settled(send('你好'));
  const { argv } = starts()[0]!;
  const prompt = readFileSync(join(import.meta.dirname, '..', 'service', 'router-prompt.md'), 'utf8');
  assert.equal(argv![argv!.indexOf('--append-system-prompt') + 1], prompt);
});

for (const [what, reported] of [
  ['one swapped for another of the same length', [MCP_TOOLS[0], 'Edit']],
  ['a duplicate covering a missing one', [MCP_TOOLS[0], MCP_TOOLS[0]]],
  ['something that is not a name', [MCP_TOOLS[0], 7]],
] as const) {
  test(`a tool list with ${what} is refused`, options, async (t) => {
    const { host, send, settled } = setup(t, { FAKE_CLAUDE_TOOLS: JSON.stringify(reported) });
    await host.start(1);
    assert.equal(await settled(send('你好')), 'unverified');
    assert.match(host.status().error!, /工具列表不符/);
  });
}

test('a live root goes first and takes the real MCP proxy with it', options, async (t) => {
  const kills: number[] = [];
  const processes: Processes = {
    find: hostProcesses.find,
    kill(pid, marker) {
      kills.push(pid);
      return hostProcesses.kill(pid, marker);
    },
  };
  const { f, host, send, settled, starts, log, outbound } = setup(
    t,
    { FAKE_CLAUDE_CHILD: 'proxy' },
    { processes, interruptGraceMs: () => 100 },
  );
  await host.start(1);
  await settled(send('先来一条'));
  const { marker } = f.ledger.currentContext(f.projectId)!;
  const root = starts()[0]!.pid!;
  const proxy = childPids(log())[0]!;
  // The proxy's own command line is what makes an orphan findable.
  assert.deepEqual((await hostProcesses.find(marker)).sort(), [root, proxy].sort());

  const id = send('不理会');
  await until(() => outbound().some((row) => row.final === 0), '中间稿');
  host.interrupt();
  assert.equal(await settled(id), 'unverified');
  assert.equal(kills[0], root);
  assert.deepEqual(await hostProcesses.find(marker), []);
  assert.equal(host.status().error, null);
});
