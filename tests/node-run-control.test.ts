// Guards the two ends of a start that never becomes a round, and the client's own control
// path: docs/design/nodes.md §4.1 (the closed set of commands), §4.2 (the gate is a
// one-shot) and §5.3 (a client of another protocol version is refused and that refusal is
// recorded as a fact about the machine).
//
// What this file is here to catch:
//   - a start sent a second time for a round whose gate is already taken: it is answered
//     with the code the gate means, and nothing is started,
//   - a start with no snapshot on the machine: refused before the gate is even taken, so a
//     round the machine never ran is not left looking like one that started,
//   - a machine the owner revoked: its next poll is 401 and the client stops,
//   - and a client speaking another protocol version: refused as that, recorded on the
//     machine, and not left to be judged as a machine that went silent.
//
// None of these cases carries a round: what they drive is the client's start and state
// commands by hand, so the Task is made but not queued — nothing is dispatched beside what
// the case does itself.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NodeHttpError } from '../node/client.ts';
import { boxOf } from '../node/runbox.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';
import { runId } from './helpers.ts';
import { FAKE, USER, bench, options, until } from './node-run-fixture.ts';
import type { NodeBench } from './node-run-fixture.ts';

const HELD = { hold: true };

test('闸门只认第一次：已经占过的这一轮不会被第二次启动', options, async (t) => {
  const b = await bench(t, {}, {}, HELD);
  const manual = runId('manual');
  const relative = `tasks/${b.taskId}/runs/${manual}`;
  const box = boxOf(b.nodeDir, relative);
  // A round whose gate is taken (a client that died right after starting one leaves this)
  // and whose snapshot is there: the start is answered with the code the gate means.
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'brief.md'), '# 手写的一轮\n');

  const started = (await b.client.execute({
    id: 's1', kind: 'start', run_dir: relative, task_id: b.taskId, run_id: manual, round: 1,
    argv: [process.execPath, FAKE], env: {}, credential: null,
  })) as { code: number; confirmed: boolean };
  assert.equal(started.code, 3, '闸门已经被占：不再启动第二次');
  assert.equal(started.confirmed, false);
  const state = (await b.client.execute({ id: 's2', kind: 'state', run_dir: relative })) as { started: boolean; exit: number | null };
  assert.equal(state.started, true);
  assert.equal(state.exit, null, '什么都没跑，也没有退出码');
});

test('快照取不到就不启动：机器上连闸门都没占', options, async (t) => {
  const b = await bench(t, {}, {}, HELD);
  const nosnapshot = runId('nosnapshot');
  const relative = `tasks/${b.taskId}/runs/${nosnapshot}`;
  const started = (await b.client.execute({
    id: 's1', kind: 'start', run_dir: relative, task_id: b.taskId, run_id: nosnapshot, round: 9,
    argv: [process.execPath, FAKE], env: {}, credential: null,
  })) as { code: number; error?: string };
  assert.equal(started.code, 2);
  assert.match(String(started.error), /快照/);
  assert.equal(existsSync(join(boxOf(b.nodeDir, relative).runDir, 'started')), false, '连闸门都没有占');
});

test('机器被撤销：下一次 poll 就是 401，客户端停下', options, async (t) => {
  const b = await bench(t, {}, {}, HELD);
  await untilConnected(b);
  b.host.ledger.deleteMachine(b.machine.id, USER, { confirmed: true });
  await assert.rejects(
    () => b.client.run(new AbortController().signal),
    (err: unknown) => err instanceof NodeHttpError && err.status === 401,
  );
});

test('协议版本不符：如实说版本不符，记在这台机器上，不落进“失联超过宽限期”', options, async (t) => {
  const b = await bench(t, {}, {}, HELD);
  await untilConnected(b);
  // What an older client sends: a version this host does not speak.
  const answer = await fetch(`${b.base}/api/node/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
    body: JSON.stringify({ protocol: 0, cursor: null, runs: [], facts: {} }),
  });
  assert.equal(answer.status, 426);
  const body = (await answer.json()) as { error: string };
  assert.match(body.error, /协议版本不符/);
  assert.match(body.error, /第 0 版/);
  // §5.3: the refusal is a fact about this machine, not a silence to be timed out later.
  assert.equal(b.host.nodes.refusesProtocol(b.machine.id), true, '主机记下了这台机器的版本不符');
  // A client that comes back with the right version is taken again.
  const ok = await fetch(`${b.base}/api/node/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}` },
    body: JSON.stringify({ protocol: NODE_PROTOCOL }),
  });
  assert.equal(ok.status, 200);
  assert.equal(b.host.nodes.refusesProtocol(b.machine.id), false, '版本对上了就清掉那条记录');
});

// The machine is here as the host sees it: a poll answered, not a moment guessed at.
async function untilConnected(b: NodeBench): Promise<void> {
  await until(() => b.host.nodes.status().connected.length > 0, '机器连回来');
}
