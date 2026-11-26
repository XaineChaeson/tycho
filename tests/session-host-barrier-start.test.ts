// Guards starts held by barriers and their cancellation against dispatch without a driver.
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

test('a barrier that begins while the login is being asked about holds the start that waited for the answer, and the question is asked again afterwards', options, async (t) => {
  const barriers = steady();
  let asked = 0;
  let gate: Promise<void> | undefined;
  const { host, send, settled, starts, state } = setup(t, {}, {
    barriers,
    launchWith: async () => {
      asked += 1;
      await gate;
      return { claude: [process.execPath, FAKE] };
    },
  });
  await host.start(1);
  const answer = Promise.withResolvers<void>();
  gate = answer.promise;
  const before = asked;
  const id = send('先来一条');
  host.kick(id);
  await until(() => asked > before, '启动前问登录');
  barriers.degraded = true;
  gate = undefined;
  answer.resolve();
  await sleep(200);
  assert.deepEqual([starts().length, host.status().alive, state(id)], [0, false, 'received'], '答复回来时屏障已经升起，仍然启动了');
  barriers.degraded = false;
  assert.equal(await settled(id), 'processed');
  assert.equal(asked, before + 2, '解除后按那时的设置再问一次');
  assert.equal(starts().length, 1);
});

test('a barrier that begins while leftovers are being looked for holds the start too, and a start during an inventory launches nothing', options, async (t) => {
  const barriers = { degraded: false, recovering: true };
  let gate: Promise<void> | undefined;
  let looks = 0;
  const processes: Processes = {
    async find(marker) {
      looks += 1;
      await gate;
      return hostProcesses.find(marker);
    },
    kill: hostProcesses.kill,
  };
  const { f, host, starts, send, settled, state } = setup(t, {}, { barriers, processes });
  // One that never reported in: once its leftovers are cleared it is closed, which is a
  // write, and a start that a barrier has overtaken must not get as far as that.
  const stale = openContext(f, randomUUID());
  await host.start(1);
  const id = send('清点时来的');
  host.kick(id);
  // A process that had been started would have reported in by now.
  await sleep(500);
  assert.deepEqual([starts().length, state(id)], [0, 'received'], '清点期间启动就拉起了负责人');
  const looked = Promise.withResolvers<void>();
  gate = looked.promise;
  const before = looks;
  barriers.recovering = false;
  host.kick(id);
  await until(() => looks > before, '启动前查残留');
  barriers.recovering = true;
  gate = undefined;
  looked.resolve();
  await sleep(200);
  assert.deepEqual([starts().length, host.status().alive, state(id)], [0, false, 'received'], '查完残留时屏障已经升起，仍然启动了');
  assert.equal(f.ledger.currentContext(f.projectId)?.id, stale.id, '屏障期间这次启动还在往下走：关掉了旧会话');
  barriers.recovering = false;
  assert.equal(await settled(id), 'processed');
  assert.equal(starts().length, 1);
  assert.notEqual(f.ledger.currentContext(f.projectId)?.id, stale.id);
});

test('a start during degraded mode asks nothing of a ledger that cannot answer, and the loop it leaves running starts the process afterwards', options, async (t) => {
  const barriers = { degraded: true, recovering: false };
  const { f, make, send, settled, starts } = setup(t);
  // The ledger as its heaviest failure leaves it: reads fail too.
  const host = make({
    ledger: {
      ...f.ledger,
      dispatchConditions: () => ({ ...f.ledger.dispatchConditions(), ...barriers }),
      currentContext(projectId: string) {
        if (barriers.degraded) throw new Error('账本不可用');
        return f.ledger.currentContext(projectId);
      },
    },
  });
  // Here, not in t.after: the fixture's hook comes first and closes the ledger.
  try {
    await host.start(1);
    assert.deepEqual([host.status().alive, host.status().error], [false, null]);
    barriers.degraded = false;
    assert.equal(await settled(send('降级之后')), 'processed');
    assert.equal(starts().length, 1);
  } finally {
    await host.stop();
  }
});

test('a start whose own write is what finds the ledger failing takes no message, and goes on once writes are back', options, async (t) => {
  const disk = { failing: false };
  let missing: string | undefined = '还没装 Claude Code';
  const { f, host, send, settled, starts, state } = setup(t, {}, {
    ledgerOptions: {
      testHooks: {
        beforeCommit(actions) {
          if (disk.failing && actions.includes('router.open')) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
        },
      },
    },
    launchWith: async () => {
      if (missing) throw new RouterUnavailable(missing);
      return { claude: [process.execPath, FAKE] };
    },
  });
  // Stopped at its start: the restart puts it right, and starts nothing without a message.
  await host.start(1);
  assert.equal(host.status().error, missing);
  missing = undefined;
  await host.restart();
  assert.deepEqual([host.status().error, host.status().alive], [null, false]);
  disk.failing = true;
  const id = send('写入失败时来的');
  host.kick(id);
  await until(() => f.ledger.dispatchConditions().degraded, '打开上下文时撞上写入失败');
  await sleep(100);
  assert.deepEqual([state(id), starts().length], ['received', 0], '没打开上下文就不取消息');
  disk.failing = false;
  assert.equal(f.ledger.recover(), true);
  assert.equal(await settled(id), 'processed');
  assert.equal(starts().length, 1);
});

test('a stop while a restart waits for a barrier ends the wait and starts nothing', options, async (t) => {
  const barriers = steady();
  const { host, send, settled, starts } = setup(t, {}, { barriers });
  await host.start(1);
  await settled(send('先来一条'));
  const restarted = host.restart();
  barriers.degraded = true;
  await until(() => host.status().waiting === 'degraded' || starts().length > 1, '重启走到启动那一步');
  // With the barrier still up: a wait that did not heed the stop would hold the stop, and the
  // restart, until the test's own time runs out.
  await host.stop();
  await restarted;
  barriers.degraded = false;
  const after = host.status();
  assert.deepEqual([starts().length, after.alive, after.restarting, after.waiting], [1, false, false, null]);
});

test('a drain whose start a barrier held back takes no message: there would be no process to hand it to', options, async (t) => {
  const barriers = { degraded: false, recovering: true };
  let asked = 0;
  let gate: Promise<void> | undefined;
  const { host, send, settled, state, starts } = setup(t, {}, {
    barriers,
    launchWith: async () => {
      asked += 1;
      await gate;
      return { claude: [process.execPath, FAKE] };
    },
  });
  await host.start(1);
  barriers.recovering = false;
  const answer = Promise.withResolvers<void>();
  gate = answer.promise;
  const id = send('屏障前来的');
  host.kick();
  await until(() => asked > 0, '为这条消息去拉起负责人');
  barriers.degraded = true;
  gate = undefined;
  answer.resolve();
  await sleep(300);
  assert.deepEqual([state(id), starts().length], ['received', 0], '没有进程可以交给，却取走了消息');
  barriers.degraded = false;
  assert.equal(await settled(id), 'processed');
});
