// Guards a machine that answers and cannot say (docs/design/nodes.md §4.3): a round's record
// is there and cannot be read. Asked through the real node channel and a real client, so
// that what the host does is what the machine's own answers make it do.
//
// What this file is here to catch:
//   - a stop answered "cannot tell" taken for a machine that did not answer: the stretch
//     out of contact starts, and past the grace period the Run is settled as interrupted
//     with the machine "out of contact" while it was answering all along,
//   - why the machine cannot tell kept nowhere: the Task's page then says the machine is out
//     of contact and when the Task may go on, neither of which is so,
//   - a round the ledger has ended and the machine cannot vouch for left out of the listing
//     the reconnect sweep goes by, so it is never asked to stop.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createClient, identityOf, readToken, writeToken } from '../node/client.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { boxOf, stopRequested } from '../node/runbox.ts';
import { createNodeChannel } from '../runner/node-channel.ts';
import type { NodeChannelOptions } from '../runner/node-channel.ts';
import { createRunner } from '../runner/runner.ts';
import type { Account } from '../runner/snapshot.ts';
import { unreachableSince, unverifiableReason } from '../service/ledger.ts';
import type { RunRow } from '../service/ledger.ts';
import { SETTINGS } from '../service/settings.ts';
import { fixture, LOGIN, memoryLogins, RUNNER_TUNED, USER } from './helpers.ts';

const GRACE = SETTINGS['run.lostGraceMs'].default;
const ACCOUNTS: Record<string, Account> = {
  [LOGIN.login.id]: { id: LOGIN.login.id, name: LOGIN.login.name, executor: 'stub', machine: 'h1', tiers: {} },
};

// A process table with nothing of this round in it.
const nothing: HostProcesses = {
  alive: () => false,
  startOf: async () => undefined,
  descendants: async () => [],
  tagged: async () => [],
  endTree: async () => {},
  endGroup: async () => {},
};

function world(t: TestContext) {
  const f = fixture(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-unverifiable-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const identity = identityOf(dataDir);
  writeToken(identity, 'f'.repeat(64));
  const client = createClient({
    dataDir,
    origin: 'http://127.0.0.1:1',
    token: readToken(identity)!,
    facts: { node_id: identity.id, name: 'h1', platform: 'test', hostname: 'h1' },
    procs: nothing,
    log: () => {},
    fetch: (() => Promise.reject(new Error('这个测试不该去问主机'))) as unknown as typeof globalThis.fetch,
  });
  const sent: string[] = [];
  const nodes: NodeChannelOptions['nodes'] = {
    send: async (_machine, command) => {
      sent.push(command.kind);
      return client.execute({ id: `c${sent.length}`, ...command } as Parameters<typeof client.execute>[0]);
    },
    connected: () => true,
    lastSeen: () => null,
    reportedExecutors: () => null,
    askExecutors: () => Promise.reject(new Error('这个测试不问执行器')),
  };
  const channel = createNodeChannel({ nodes });
  let clock = Date.now();
  const logged: string[] = [];
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger,
    adapters: {},
    logins: memoryLogins({ own: { ...Object.values(ACCOUNTS)[0]!, id: f.login.login.id, name: f.login.login.name } }),
    machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => channel.for('h1'),
    now: () => clock,
    monotonic: () => clock,
    log: (line) => logged.push(line),
  });
  return {
    f, runner, sent, logged,
    advance(ms: number): void {
      clock += ms;
    },
    // The round on the machine, with the watch's own record in a state nobody can read.
    unreadable(run: RunRow) {
      const box = boxOf(dataDir, `tasks/${run.task_id}/runs/${run.id}`);
      mkdirSync(join(box.runDir, 'started'), { recursive: true });
      mkdirSync(box.procDir, { recursive: true });
      writeFileSync(join(box.procDir, 'watch-pid'), 'garbage\n');
      return box;
    },
  };
}

test('停止时机器答“查不清”：不算失联，过了宽限期也不按中断结算，原因记在账本和任务上', async (t) => {
  const w = world(t);
  const { task, run } = w.f.runningRun();
  w.unreadable(run);
  assert.equal(await w.runner.interrupt(run, USER), 'unknown');
  assert.ok(w.sent.includes('stop'), '停止发到了机器上');
  w.advance(GRACE * 2);
  assert.equal(await w.runner.verify(w.f.run(run.id)), 'unknown', '机器一直在回答：不按失联宽限期结算');
  const after = w.f.run(run.id);
  assert.equal(after.state, 'unknown');
  assert.equal(unreachableSince(after), undefined, '机器回答了，就不是失联');
  assert.match(unverifiableReason(after) ?? '', /watch-pid/, '账本记下说不清的原因');
  assert.match(w.f.task(task.id).reason ?? '', /watch-pid/, '任务上看得到原因');
  assert.deepEqual(w.runner.lostCandidates().map(({ id }) => id), [], '不进“可以接续”的候选');
});

test('状态答“查不清”：等多久都不撤销、不接续，原因可见', async (t) => {
  const w = world(t);
  const { run } = w.f.runningRun();
  w.unreadable(run);
  assert.equal(await w.runner.verify(run), 'unknown');
  w.advance(GRACE * 2);
  assert.deepEqual(w.runner.lostCandidates().map(({ id }) => id), [], '查不清不是失联，也不是启动未确认：没有超时放行');
  assert.equal(await w.runner.presume(w.f.run(run.id), () => true), 'unknown');
  assert.equal(w.sent.includes('stop'), false, '不去撤销一轮说不清的执行');
  assert.match(unverifiableReason(w.f.run(run.id)) ?? '', /watch-pid/);
});

test('重连清扫：账本里已结束、机器上说不清的轮次也会收到停止', async (t) => {
  const w = world(t);
  const { run } = w.f.runningRun();
  w.f.ledger.settleRun(run.id, null, null, { kind: 'lost' });
  const box = w.unreadable(run);
  await w.runner.sweep();
  assert.ok(w.sent.includes('list'), '清扫先问了机器上的轮次');
  assert.equal(stopRequested(box), true, '清扫的停止送到了这一轮');
  assert.ok(w.logged.some((line) => line.includes(run.id)), `说不清的结果记了一笔：${w.logged.join(' | ')}`);
});
