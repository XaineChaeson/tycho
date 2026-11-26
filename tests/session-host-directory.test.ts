// Guards Router working directory changes and failed starts against stale contexts and lost messages.
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
import { claudeTier, fixture, ROUTER_TUNED, tuned } from './helpers.ts';

import { hostLogin, openContext, TOKEN, FAKE, NO_STDIN, POSIX_ONLY, TOOLS, MCP_TOOLS, options, until, type LogEntry, childPids, type Barriers, setup, admitted, existingSession, closedStdin, steady } from './session-host-fixture.ts';

// The project's default source is a folder on this machine (docs/design/code-sources.md §3):
// the ledger's two columns written directly, and the host's own machine registration named.
function folderSource(f: ReturnType<typeof fixture>, path: string, machineUid = f.ledger.getMachine('h1')!.uid): void {
  f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([{ id: 'src-code', kind: 'folder', machine_uid: machineUid, path }]), f.projectId);
  f.force("INSERT OR REPLACE INTO setting (id, created_at, key, value_json) VALUES ('host-binding','now','host_machine_uid',?)", JSON.stringify(machineUid));
}

test('a project with a code directory has its Router started there', options, async (t) => {
  const { f, host, send, settled, starts } = setup(t);
  const code = join(f.dir, 'code');
  mkdirSync(code);
  folderSource(f, code);
  await host.start(1);
  assert.equal(await settled(send('你好')), 'processed');
  assert.equal(starts()[0]?.cwd, code);
});

// A repository source is not read where it is: tycho does not clone for the Router, so it
// starts in the empty directory (docs/design/code-sources.md §3).
test('a project with a repository source, or no source, has its Router started in the empty directory', options, async (t) => {
  const { f, host, send, settled, starts } = setup(t);
  f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([{ id: 'src-repo', kind: 'repo', url: 'https://example.test/owner/project.git' }]), f.projectId);
  await host.start(1);
  assert.equal(await settled(send('你好')), 'processed');
  assert.equal(starts()[0]?.cwd, join(f.dir, 'router-empty'));
});

test('a code directory that changes, or goes missing, gets a new context before the next message', options, async (t) => {
  const { f, host, send, settled, starts, logLines } = setup(t);
  const first = join(f.dir, 'first');
  const second = join(f.dir, 'second');
  mkdirSync(first);
  mkdirSync(second);
  folderSource(f, first);
  await host.start(1);
  assert.equal(await settled(send('一')), 'processed');
  const opened = f.ledger.currentContext(f.projectId)!;
  assert.equal(await settled(send('一又一')), 'processed');
  assert.equal(starts().length, 1, '目录没变：同一个进程接着用');
  await host.restart();
  assert.equal(await settled(send('一又二')), 'processed');
  assert.equal(starts()[1]?.argv![starts()[1]!.argv!.indexOf('--resume') + 1], opened.session_ref, '目录没变：重起之后续接同一个上下文');
  folderSource(f, second);
  assert.equal(await settled(send('二')), 'processed');
  assert.deepEqual([f.ledger.getContext(opened.id)!.state, f.ledger.getContext(opened.id)!.closed_reason], ['closed', '负责人的工作目录变了']);
  assert.equal(starts()[2]?.cwd, second);
  assert.equal(starts()[2]?.argv?.includes('--resume'), false, 'Claude 按目录存会话，换了目录续接不上');
  const gone = join(f.dir, 'gone');
  folderSource(f, gone);
  assert.equal(await settled(send('三')), 'processed', '代码目录不在了：照常处理，只是读不到代码');
  assert.deepEqual(readdirSync(starts()[3]!.cwd!), []);
  assert.ok(logLines.some((line) => line.includes(gone) && line.includes('不在')), logLines.join('\n'));
});

// A code directory that was there when workDirOf looked at it and cannot be entered when the
// process is started: this project's Router starts in the empty directory instead, and no other
// project is stopped by it, and the context the next start opens records where it really runs.
// openContext is the one step between the look and the spawn, so removing the directory there
// reproduces it every time instead of racing the start.
test('a code directory the process cannot be started in falls back to the empty one without stopping the Host', options, async (t) => {
  const { f, make, send, settled, starts, logLines } = setup(t);
  const code = join(f.dir, 'code');
  mkdirSync(code);
  folderSource(f, code);
  let removed = false;
  const host = make({
    ledger: {
      ...f.ledger,
      openContext: (...args: Parameters<typeof f.ledger.openContext>) => {
        if (!removed) rmSync(code, { recursive: true, force: true });
        removed = true;
        return f.ledger.openContext(...args);
      },
    },
  });
  try {
    await host.start(1);
    assert.equal(await settled(send('你好')), 'processed');
    assert.equal(host.status().error, null, logLines.join('\n'));
    // One start that ran, in the empty directory: the first could not be started at all.
    assert.equal(starts().length, 1);
    assert.notEqual(starts()[0]?.cwd, code);
    assert.deepEqual(readdirSync(starts()[0]!.cwd!), []);
    assert.ok(
      logLines.some((line) => line.includes(code) && line.includes('下一次改在空目录里起')),
      logLines.join('\n'),
    );
    const context = f.ledger.currentContext(f.projectId)!;
    assert.ok(context.pid, '在空目录里起来的进程记进了账本');
    assert.equal(JSON.parse(context.launch_json!).cwd, starts()[0]?.cwd, '上下文记的目录就是它真正跑的目录，下一次起进程才续得上');
    // Started again: the same context goes on, in the same directory.
    await host.restart();
    assert.equal(await settled(send('再来')), 'processed');
    assert.equal(starts()[1]?.argv![starts()[1]!.argv!.indexOf('--resume') + 1], context.session_ref);
    // The directory is back: a restart looks at it again, and the Router runs there.
    mkdirSync(code);
    await host.restart();
    assert.equal(await settled(send('回来了')), 'processed');
    assert.equal(starts()[2]?.cwd, code);
  } finally {
    // Not the hook in setup: that one stops the Host it made, which this test never started.
    await host.stop();
  }
});

test('a CLI that ends before its init on a new context stops the Router with its words, and the message waits', options, async (t) => {
  const old = [process.execPath, '-e', `process.stderr.write("error: unknown option '--restricted'"); process.exit(1)`, '--'];
  const { f, host, send, state } = setup(t, {}, { claude: old });
  await host.start(1);
  const id = send('你好');
  await until(() => host.status().error, '负责人停摆');
  assert.match(host.status().error!, /负责人起不来.*unknown option '--restricted'/);
  await until(() => state(id) === 'received', '消息放回队列');
  const later = send('再来');
  await sleep(200);
  assert.equal(state(later), 'received', '停摆之后不再一条条起进程、一条条记成待核实');
  assert.equal(f.peek(`SELECT 1 FROM message WHERE state = 'unverified'`).length, 0);
});

test('a context whose launch record holds no object is still resumed, not stuck', options, async (t) => {
  const { f, host, send, settled, starts } = setup(t);
  const ref = randomUUID();
  const segment = f.ledger.ensureSegment(f.projectId);
  const held = f.ledger.openContext({ projectId: f.projectId, segmentId: segment.id, marker: ref, launch: null, knowledge: [], loginId: hostLogin(f) });
  f.ledger.setContextRef(held.id, ref);
  await host.start(1);
  assert.equal(await settled(send('你好')), 'processed');
  assert.equal(await settled(send('再来')), 'processed', '每条消息之前的核对不因它出错');
  assert.equal(starts()[0]?.argv![starts()[0]!.argv!.indexOf('--resume') + 1], ref);
});
