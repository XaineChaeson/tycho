// Guards the hub's own promises (docs/design/nodes.md §5.3, §8.2): one registration per
// machine, one delivery per command, and a machine that is not connected being told apart
// from one that took a command and went away.
//
// What this file is here to catch:
//   - a repeat of the same join request making a second machine,
//   - a command delivered twice (a start sent again is the thing the whole design forbids),
//   - a command left in a queue for a machine that has gone, which would be run when it
//     came back,
//   - a machine that stopped polling still counting as connected,
//   - a command written into a poll response the machine never read counting as delivered:
//     the caller then waits out the whole command timeout for an answer that cannot come,
//     and the round it was asking about is never read to its end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createNodes } from '../service/nodes.ts';
import { NodeAway, NodeCommandTimeout, NodeRefused } from '../service/nodes.ts';
import { DegradedError, InputError } from '../service/errors.ts';
import type { MachineRecord } from '../service/ledger.ts';
import { fixture, USER, NODES_TUNED } from './helpers.ts';

const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'darwin 24', hostname: 'mac-mini-01.local' };

test('放行一台机器：同一个秘密反复认领都是同一条登记，响应丢了还能再领', async (t) => {
  // No machine and no account to begin with: this file counts what the hub writes.
  let at = 1_000_000;
  const f = fixture(t, {}, false);
  const nodes = createNodes({ ...NODES_TUNED,
    ledger: f.ledger,
    pollHoldMs: () => 30,
    commandTimeoutMs: () => 200,
    joinTtlMs: () => 60_000,
    gapSlackMs: () => 10_000,
    now: () => at,
    log: () => {},
  });
  const request = nodes.register(FACTS);
  assert.match(request.code, /^\d{6}$/, '六位数只用来指认请求');
  assert.equal(request.secret.length, 64);

  // Waiting: the machine comes back with the same secret and reaches the same request.
  const first = nodes.claim(request.secret);
  assert.equal(first.state, 'pending');
  assert.equal(first.state === 'pending' ? first.code : '', request.code);
  assert.equal(nodes.pendingJoins().length, 1, '还是那一条，不是第二条');

  const machine = nodes.approve(request.code, USER);
  assert.ok(machine);
  assert.equal(nodes.pendingJoins().length, 0);
  // The same secret collects the token, and keeps collecting it while the release lives: a
  // response lost on the way, or a machine that died before writing it down, is a failure
  // the owner must not have to fix by hand (§9, "兑换要能重试认领").
  const claimed = nodes.claim(request.secret);
  assert.equal(claimed.state, 'approved');
  const again = nodes.claim(request.secret);
  assert.equal(again.state, 'approved', '同一条登记，同一个令牌');
  assert.equal(again.state === 'approved' ? again.token : '', claimed.state === 'approved' ? claimed.token : '');
  // The release has a life of its own: once it is over, the registration is gone and the
  // token can only be had by letting the machine in again.
  at += 60_001;
  assert.equal(nodes.claim(request.secret).state, 'missing', '有效期过了就不再交令牌');

  // The machine is one, and its token is the one the ledger names.
  const token = claimed.state === 'approved' ? claimed.token : '';
  const found: MachineRecord | undefined = nodes.authenticate(token);
  assert.equal(found?.id, machine.id);
  assert.equal(nodes.authenticate('0'.repeat(64)), undefined, '别的令牌不是这台机器');
  const rows = f.ledger.listMachines();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.nodeId, FACTS.node_id, '机器绑的是客户端自己那个标识');
  assert.equal(rows[0]!.platform, FACTS.platform);
});

test('同一条命令只送一次，第二次 poll 拿不到它', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 500, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const request = nodes.register(FACTS);
  const machine = nodes.approve(request.code, USER)!;

  // Nothing to do: the poll is held, and answers "nothing" when the hold runs out.
  const idle = await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.equal(idle, null);

  const sent = nodes.send(machine.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const delivered = await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.equal(delivered?.kind, 'state');
  // The next poll is the machine's word that it has it: the cursor names the last command
  // it took. A command it has named is in flight, and is never handed over a second time.
  const again = await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: delivered!.id });
  assert.equal(again, null, '机器说收到了：同一条命令不会再送一次');

  nodes.report(machine.id, delivered!.id, true, { started: false, launcher_alive: false, pid_alive: false, marked: false, exit: null });
  assert.deepEqual(await sent, { started: false, launcher_alive: false, pid_alive: false, marked: false, exit: null });

  // A report for something nobody waits for any more is dropped, not an error.
  assert.equal(nodes.report(machine.id, delivered!.id, true, {}), false);
});

// §8.2: what the host writes into a poll response is not delivered until the machine says
// it has it. This is the failure that was read back from a Linux run of
// tests/node-run.test.ts: a read_output of the round's own log was written into a response
// whose client was being stopped in that same moment. The bytes reached a socket nobody was
// reading, so the machine never saw the command — and nothing said so. The watch process
// waiting for that answer sat on it for the whole command timeout, and the round was never
// read to its end.
test('写进了连接却没送到：机器没说收到，命令留给下一条连接', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 5_000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;

  const held = nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null });
  const sent = nodes.send(machine.id, { kind: 'read_output', path: 'tasks/t/runs/r/stdout.ndjson', offset: 0, bytes: 1024 });
  const written = await held;
  assert.equal(written?.kind, 'read_output', '这一条命令写进了那条连接');

  // A new client on the same machine — a restart, an upgrade, a crash — has no cursor of
  // its own, so it cannot name it: it says only that it has nothing.
  const again = await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null });
  assert.equal(again?.id, written.id, '机器没有说收到它：还是同一条命令，交给下一条连接');
  assert.equal(nodes.report(machine.id, again!.id, true, { base64: '', size: 0, mtime: 0 }), true);
  assert.deepEqual(await sent, { base64: '', size: 0, mtime: 0 });
});

// The same fact on the other way a command leaves: it was waiting in the queue and a poll
// took it out and was answered with it. That connection carries it just the same, and the
// machine naming it is still the only proof it arrived.
test('队列里的命令被 poll 直接拿走：机器没说收到，它还得回来', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 5_000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;
  await nodes.poll(machine.id, { runs: [], facts: FACTS });

  // Nothing is holding a poll when this is sent: it waits in the queue until one comes.
  const sent = nodes.send(machine.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const connection = new AbortController();
  const first = await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null }, connection.signal);
  assert.equal(first?.kind, 'state');
  connection.abort();

  const again = await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null });
  assert.equal(again?.id, first!.id, '机器没有说收到它：命令回到队列，交给下一条连接');
  assert.equal(nodes.report(machine.id, again!.id, true, { started: true }), true);
  assert.deepEqual(await sent, { started: true });
});

// The other half of the same fact: the connection is known to be gone before the machine
// could have said anything about what it was handed. Nothing is written to a connection that
// has closed, so the command was never delivered either.
test('连接在机器开口之前断了：没送出去的命令回到队列', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 5_000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;

  const connection = new AbortController();
  const held = nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null }, connection.signal);
  const sent = nodes.send(machine.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const written = await held;
  connection.abort();

  const again = await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null });
  assert.equal(again?.id, written!.id, '连接断了：命令没送出去，下一条连接拿到它');
  assert.equal(nodes.report(machine.id, again!.id, true, { started: true }), true);
  assert.deepEqual(await sent, { started: true });
});

// A command that was handed out, undone when its connection died, and then named by the
// machine anyway: the two events are a race, and the machine's word is what settles it. It
// has it, so it is not handed over a second time — a query run twice is a query run twice.
test('连接断了才被机器认回来的命令：还是不会送第二次', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 5_000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;

  const connection = new AbortController();
  const held = nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null }, connection.signal);
  const sent = nodes.send(machine.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const written = await held;
  connection.abort();

  // The machine comes back naming it: it did take it, and the hand-out that was undone was
  // undone too early. Nothing is delivered from the queue for it again.
  const again = await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: written!.id });
  assert.equal(again, null, '机器点过名的命令不会再送');
  assert.equal(nodes.report(machine.id, written!.id, true, { started: true }), true);
  assert.deepEqual(await sent, { started: true });
});

// §8.2, both halves of the rule for a command that may not be repeated. A start is never
// handed over twice whatever the evidence says: what became of it is a state question, and
// its caller is told at once rather than waiting out a timeout for an answer that cannot come.
test('机器没有说收到启动：不重发，当场告诉调用方去问状态', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 60_000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;

  const held = nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null });
  const started = nodes.send(machine.id, {
    kind: 'start', run_dir: 'tasks/t/runs/r', task_id: 't', run_id: 'r', round: 1, argv: ['true'], env: {}, credential: null,
  });
  const written = await held;
  assert.equal(written?.kind, 'start');

  // The machine comes back without a word about it. The wait is 60 seconds, so an answer
  // arriving at all is the assertion: this one is told now.
  const refused = assert.rejects(() => started, (err: unknown) => err instanceof NodeCommandTimeout);
  assert.equal(await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null }), null, '启动没有再交给下一条连接');
  assert.equal(nodes.status().inFlight, 0, '调用方当场得到答复，不是等满了时限');
  await refused;
});

// A command the machine has named is in flight. The connection it was written to dying
// afterwards says nothing about that: the answer to a command that never comes back is a
// state question, never a second send.
test('机器说收到了之后连接才断：命令不再送，也不会因为连接断了被当成没送', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 5_000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;

  const connection = new AbortController();
  const held = nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: null }, connection.signal);
  const sent = nodes.send(machine.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const written = await held;
  // It has it: the next poll names it, and only then does the connection go.
  assert.equal(await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: written!.id }), null);
  connection.abort();

  assert.equal(await nodes.poll(machine.id, { runs: [], facts: FACTS, cursor: written!.id }), null, '收到过的命令不会再送');
  assert.equal(nodes.report(machine.id, written!.id, true, { started: true }), true);
  assert.deepEqual(await sent, { started: true });
});

test('没连回来的机器：发命令当场就说没连，不是等它超时', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 200, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const request = nodes.register(FACTS);
  const machine = nodes.approve(request.code, USER)!;

  assert.equal(nodes.connected(machine.id), false);
  await assert.rejects(
    () => nodes.send(machine.id, { kind: 'list', alive_only: false }),
    (err: unknown) => err instanceof NodeAway,
  );

  // One poll and it is connected; its report says what it has running.
  await nodes.poll(machine.id, { runs: [{ task_id: 't1', run_id: 'r1', alive: true }], facts: FACTS });
  assert.equal(nodes.connected(machine.id), true);
  assert.deepEqual(nodes.reportedRuns(machine.id), [{ task_id: 't1', run_id: 'r1', alive: true }]);
  assert.deepEqual(nodes.status().connected, [machine.id]);
  assert.match(nodes.lastSeen(machine.id) ?? '', /^\d{4}-/);
});

// A machine is here because it has a poll open, and between two polls only for the moment
// it takes to send the next one (nodes.md §4.4, §8.1). What this catches: a client that was
// killed between polls counting as here until a timeout that scales with the hold — the
// Runs on it then wait out a command timeout instead of being judged from the moment the
// machine went away — and a held poll being timed out by a clock it has nothing to do with.
test('在线的判定：poll 挂着就在，答完之后只再算一小会儿，连接断了当场不在', async (t) => {
  let at = 1_000_000;
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 200, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, now: () => at, log: () => {} });
  const request = nodes.register(FACTS);
  const machine = nodes.approve(request.code, USER)!;

  // Held: however long the wall clock says the poll has been open, the connection is there.
  const held = nodes.poll(machine.id, { runs: [], facts: FACTS }, new AbortController().signal);
  at += 120_000;
  assert.equal(nodes.connected(machine.id), true, 'poll 挂着的机器一直在');
  assert.equal(await held, null);

  // Answered: the machine is between polls. It stays here for the moment the next poll
  // takes to arrive, and no longer.
  at += 2_000;
  assert.equal(nodes.connected(machine.id), true, '答完几秒内它还在来的路上');
  at += 60_000;
  assert.equal(nodes.connected(machine.id), false, '答完很久没再来，就是不在了');
  await assert.rejects(() => nodes.send(machine.id, { kind: 'list', alive_only: false }), (err: unknown) => err instanceof NodeAway);

  // Gone: the connection a poll was held on broke before it was answered.
  const abort = new AbortController();
  const broken = nodes.poll(machine.id, { runs: [], facts: FACTS }, abort.signal);
  assert.equal(nodes.connected(machine.id), true);
  abort.abort();
  assert.equal(await broken, null);
  assert.equal(nodes.connected(machine.id), false, '连接断了，当场不算在');
  await assert.rejects(() => nodes.send(machine.id, { kind: 'list', alive_only: false }), (err: unknown) => err instanceof NodeAway);
});

test('机器收了命令却没有回答：等到时限就报没答，命令不再发', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 120, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const request = nodes.register(FACTS);
  const machine = nodes.approve(request.code, USER)!;
  const polled = nodes.poll(machine.id, { runs: [], facts: FACTS });
  const sent = nodes.send(machine.id, { kind: 'start', run_dir: 'tasks/t/runs/r', task_id: 't', run_id: 'r', round: 1, argv: ['true'], env: {}, credential: null });
  await polled;
  await assert.rejects(() => sent, (err: unknown) => err instanceof NodeCommandTimeout);
  // Whatever the machine says now is a report nobody waits for: the host asks about state
  // rather than sending the start again.
  assert.equal(await nodes.poll(machine.id, { runs: [], facts: FACTS }).then((command) => command?.kind ?? null), null);
});

test('自己注销的机器不再算连着，它手上的命令也不再等', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 200, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const request = nodes.register(FACTS);
  const machine = nodes.approve(request.code, USER)!;
  await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.equal(nodes.connected(machine.id), true);
  nodes.leave(machine.id);
  assert.equal(nodes.connected(machine.id), false);
});

test('等待放行的机器太多：当场拒绝，不记下没用的请求', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 200, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  for (let n = 0; n < 20; n += 1) nodes.register({ ...FACTS, node_id: `a1b2c3d4e5f607${String(n).padStart(2, '0')}` });
  assert.throws(() => nodes.register({ ...FACTS, node_id: 'ffffffffffffffff' }), /太多/);
});

// §6, "写库失败停止副作用": while the ledger cannot take a write, nothing is given to a
// machine — including what is already queued, which is dropped rather than delivered later
// behind the owner's back.
test('进入降级：队列里的启动不再投递，等着的调用当场得到答复', async (t) => {
  let failing = false;
  const f = fixture(t, {
    testHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  const nodes = createNodes({ ...NODES_TUNED,
    ledger: f.ledger,
    pollHoldMs: () => 30,
    commandTimeoutMs: () => 5_000,
    joinTtlMs: () => 60_000,
    gapSlackMs: () => 10_000,
    barriers: () => ({ degraded: f.ledger.dispatchConditions().degraded, recovering: false }),
    log: () => {},
  });
  const request = nodes.register(FACTS);
  const machine = nodes.approve(request.code, USER)!;
  await nodes.poll(machine.id, { runs: [], facts: FACTS });

  // A start is queued for the machine, and the ledger breaks before it is taken.
  const queued = nodes.send(machine.id, { kind: 'start', run_dir: 'tasks/t/runs/r', task_id: 't', run_id: 'r', round: 1, argv: ['true'], env: {}, credential: null });
  const refused = assert.rejects(() => queued, /降级/);
  failing = true;
  assert.throws(() => f.ledger.setPause(true, USER), DegradedError);

  const delivered = await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.equal(delivered, null, '降级期间下发的第一条命令不能是启动');
  await refused;
  failing = false;
  assert.equal(await nodes.poll(machine.id, { runs: [], facts: FACTS }), null, '队列已经清掉，不会等恢复之后补发');
});

test('最近往来写不进去也算写库失败：同一次 poll 不再交付命令', async (t) => {
  let failing = false;
  let at = Date.now();
  const f = fixture(t, {
    testHooks: {
      beforeCommit() {
        if (failing) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
    },
  });
  const nodes = createNodes({ ...NODES_TUNED,
    ledger: f.ledger,
    pollHoldMs: () => 30,
    commandTimeoutMs: () => 5_000,
    joinTtlMs: () => 60_000,
    gapSlackMs: () => 10_000,
    barriers: () => ({ degraded: f.ledger.dispatchConditions().degraded, recovering: false }),
    now: () => at,
    log: () => {},
  });
  const request = nodes.register(FACTS);
  const machine = nodes.approve(request.code, USER)!;
  await nodes.poll(machine.id, { runs: [], facts: FACTS });

  const queued = nodes.send(machine.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const refused = assert.rejects(() => queued, /降级/);
  // The poll itself is what cannot be written down — the note is due again by now — and the
  // command waiting behind it is not delivered on the strength of a write that failed.
  at += 6 * 60_000;
  failing = true;
  assert.equal(await nodes.poll(machine.id, { runs: [], facts: FACTS }), null);
  await refused;
  assert.equal(f.ledger.dispatchConditions().degraded, true, '记不下最近往来就是写入失败');
});

test('别的机器不能替这台机器回报：命令的归属对不上就不认', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 500, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const one = nodes.approve(nodes.register(FACTS).code, USER)!;
  const other = nodes.approve(nodes.register({ ...FACTS, node_id: 'ffffffffffffffff', name: 'other' }).code, USER)!;
  const polled = nodes.poll(one.id, { runs: [], facts: FACTS });
  const sent = nodes.send(one.id, { kind: 'state', run_dir: 'tasks/t/runs/r' });
  const delivered = await polled;
  assert.equal(delivered?.kind, 'state');

  assert.equal(nodes.report(other.id, delivered!.id, true, { started: true }), false, '不是发给它的命令');
  assert.equal(nodes.report(one.id, delivered!.id, true, { started: true }), true, '发给它的才认');
  assert.deepEqual(await sent, { started: true });
});

// §1.2, §11 step 5: what a machine reads from its own executors travels with its poll, and
// the host keeps the last of it for the pages. Nothing here is an account, and a machine
// that has not said is not read as one that has nothing.
const REPORT = {
  at: '2026-11-06T10:00:00.000Z',
  executors: [
    { executor: 'claude', installed: true, version: '2.1.303 (Claude Code)', logged_in: true },
    { executor: 'codex', installed: false, version: null, logged_in: null, error: '这台机器上没有 codex（PATH 里没有这个命令）' },
    { executor: 'dsh', installed: true, version: 'dsh 0.2.2', logged_in: null },
  ],
};

function hub(t: TestContext) {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 300, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;
  return { nodes, machine, f };
}

test('执行器状态跟着 poll 存下来：后一份替掉前一份，没有新消息时最后一份站着', async (t) => {
  const { nodes, machine } = hub(t);
  assert.equal(nodes.reportedExecutors(machine.id), null, '还没说过就是没有，不是"没装"');
  assert.deepEqual(nodes.reportedExecutors('nobody'), null);

  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: REPORT });
  assert.deepEqual(nodes.reportedExecutors(machine.id), REPORT);
  // A poll with no report is a machine with no news, not one that has none: the last report
  // stands until a newer one replaces it.
  await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.deepEqual(nodes.reportedExecutors(machine.id), REPORT);

  const newer = { at: '2026-11-06T11:00:00.000Z', executors: [{ executor: 'claude', installed: true, version: '2.1.304', logged_in: false }] };
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: newer });
  assert.deepEqual(nodes.reportedExecutors(machine.id), newer, '整份换掉，不是加在上面');
});

test('上报的形状不对就拒收：页面上不会出现机器自己编的东西', async (t) => {
  const { nodes, machine } = hub(t);
  const bad = [
    { executors: [] },
    { at: '明天', executors: [] },
    { at: 'x', executors: [{ executor: 'claude' }] },
    { at: '2026-11-06T10:00:00.000Z', executors: [{ executor: '' , installed: true }] },
    { at: '2026-11-06T10:00:00.000Z', executors: [{ executor: 'claude', installed: 'yes' }] },
    { at: '2026-11-06T10:00:00.000Z', executors: [{ executor: 'claude', installed: true, logged_in: 'yes' }] },
    { at: '2026-11-06T10:00:00.000Z', executors: [{ executor: 'claude', installed: true, logged_in: true, error: 7 }] },
    { at: '2026-11-06T10:00:00.000Z', executors: [{ executor: 'claude', installed: true, identity: 'x' }] },
    { at: '2026-11-06T10:00:00.000Z', executors: [{ executor: 'claude', installed: true, identity: { organizationId: 7 } }] },
    { at: '2026-11-06T10:00:00.000Z', executors: [{ executor: 'claude', installed: true, identity: { organizationId: 'x@example.com' } }] },
    { at: '2026-11-06T10:00:00.000Z', executors: Array.from({ length: 21 }, () => ({ executor: 'x', installed: true })) },
  ];
  for (const executors of bad) {
    await assert.rejects(async () => nodes.poll(machine.id, { runs: [], facts: FACTS, executors }), InputError, JSON.stringify(executors).slice(0, 60));
    assert.equal(nodes.reportedExecutors(machine.id), null, '拒收的一份不进页面');
  }
});

// §1.2: which organization a machine's own login belongs to travels with the same report that
// says it is signed in. Only a well-formed id is kept, lower-cased; the host writes it on that
// login, and a report naming another organization drops the windows read under the old one.
test('机器报告的登录组织编号被收下、归一，并从同一份报告写进它自己的登录', async (t) => {
  const { nodes, machine, f } = hub(t);
  const org = 'AABBCCDD-EEFF-0011-2233-445566778899';
  await nodes.poll(machine.id, {
    runs: [], facts: FACTS,
    executors: { at: '2026-11-06T10:00:00.000Z', executors: [{ executor: 'claude', installed: true, version: '2.1.303', logged_in: true, identity: { organizationId: org, email: 'x@example.com' } }] },
  });
  assert.deepEqual(nodes.reportedExecutors(machine.id)!.executors[0]!.identity, { organizationId: org.toLowerCase() }, '只留编号，邮箱丢掉');
  const login = f.ledger.getMachineLogin(machine.id, 'claude')!;
  assert.equal(f.ledger.loginState(login.id).identity.organizationId, org.toLowerCase());
  f.ledger.noteUsage(login.id, [{ window: 'five_hour', used: 0.5, resetsAt: null }]);
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: '2026-11-06T10:10:00.000Z', executors: [{ executor: 'claude', installed: true, logged_in: true, identity: { organizationId: org, accountLabel: 'sample' } }] } });
  assert.equal(f.ledger.loginState(login.id).identity.accountLabel, 'sample');
  f.ledger.noteMachineIdentity(login.id, { organizationId: org.toLowerCase(), routeLabel: 'route1' });
  f.ledger.noteMachineIdentity(login.id, { organizationId: org.toLowerCase() });
  assert.equal(f.ledger.loginState(login.id).identity.routeLabel, 'route1', '未报告线路时保留');
  f.ledger.noteMachineIdentity(login.id, { organizationId: org.toLowerCase(), routeLabel: null });
  assert.equal(f.ledger.loginState(login.id).identity.routeLabel, undefined, '明确清除线路');
  assert.equal(f.ledger.loginState(login.id).usage.length, 1, '显示名变化不清额度');
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: '2026-11-06T10:20:00.000Z', executors: [{ executor: 'claude', installed: true, logged_in: true, identity: { organizationId: org } }] } });
  assert.equal(f.ledger.loginState(login.id).identity.accountLabel, 'sample', '旧节点不带字段不抹掉名称');
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: '2026-11-06T10:30:00.000Z', executors: [{ executor: 'claude', installed: true, logged_in: true, identity: { organizationId: org, accountLabel: null } }] } });
  assert.equal(f.ledger.loginState(login.id).identity.accountLabel, undefined, '明确清除名称');

  await nodes.poll(machine.id, {
    runs: [], facts: FACTS,
    executors: { at: '2026-11-06T11:00:00.000Z', executors: [{ executor: 'claude', installed: true, version: '2.1.303', logged_in: true, identity: { organizationId: '00000000-0000-0000-0000-000000000000' } }] },
  });
  assert.deepEqual(f.ledger.loginState(login.id).usage, [], '换了组织，旧窗口不跟着走');
  await nodes.poll(machine.id, {
    runs: [], facts: FACTS,
    executors: { at: '2026-11-06T11:05:00.000Z', executors: [{ executor: 'claude', installed: true, logged_in: true }] },
  });
  assert.equal(f.ledger.loginState(login.id).identity.organizationId, '00000000-0000-0000-0000-000000000000');
  f.ledger.noteUsage(login.id, [{ window: 'five_hour', used: 0.3, resetsAt: null }]);
  await nodes.poll(machine.id, {
    runs: [], facts: FACTS,
    executors: { at: '2026-11-06T11:10:00.000Z', executors: [{ executor: 'claude', installed: true, logged_in: true, identity: { organizationId: null, accountLabel: null } }] },
  });
  assert.deepEqual(f.ledger.loginState(login.id).identity, {}, '探针明确没有个人订阅标识，解除原来的匹配');
  assert.deepEqual(f.ledger.loginState(login.id).usage, []);
  // Out of shape or not an organization id: the whole report is refused, never guessed at.
  for (const identity of ['x', { organizationId: 7 }, { organizationId: 'x@example.com' }, { accountLabel: 4 }]) {
    await assert.rejects(
      async () => nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: '2026-11-06T12:00:00.000Z', executors: [{ executor: 'claude', installed: true, identity }] } }),
      InputError,
      JSON.stringify(identity),
    );
  }
});

test('probe 命令里没有别的东西，机器答回来的就是它读到的', async (t) => {
  const { nodes, machine } = hub(t);
  await nodes.poll(machine.id, { runs: [], facts: FACTS });
  const sent = nodes.send(machine.id, { kind: 'probe' });
  const delivered = await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.deepEqual(Object.keys(delivered!).sort(), ['id', 'kind'], '命令本身不带任何参数');
  assert.equal(delivered!.kind, 'probe');
  assert.equal(nodes.report(machine.id, delivered!.id, true, REPORT), true);
  assert.deepEqual(await sent, REPORT);
});

test('问一次机器现在就问：答案存到这台机器上，没连回来是没连回来，不答是不答', async (t) => {
  const { nodes, machine } = hub(t);
  await nodes.poll(machine.id, { runs: [], facts: FACTS });

  const asked = nodes.askExecutors(machine.id, 1_000);
  const delivered = await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.equal(delivered!.kind, 'probe');
  assert.equal(nodes.report(machine.id, delivered!.id, true, REPORT), true);
  assert.deepEqual(await asked, REPORT);
  assert.deepEqual(nodes.reportedExecutors(machine.id), REPORT, '问到的就存在这台机器上，页面和这次检查看到的是一份');

  // A machine that is not connected is not asked: the caller hears that, not a timeout.
  const away = nodes.approve(nodes.register({ ...FACTS, node_id: 'f'.repeat(16), name: 'away' }).code, USER)!;
  await assert.rejects(() => nodes.askExecutors(away.id, 50), NodeAway);

  // A machine that takes the question and never answers: the caller is told, and the
  // command is not handed to it a second time.
  await nodes.poll(away.id, { runs: [], facts: FACTS });
  await assert.rejects(() => nodes.askExecutors(away.id, 40), NodeCommandTimeout);
  assert.equal(await nodes.poll(away.id, { runs: [], facts: FACTS, cursor: null }), null, '放弃的这一次不会再交给机器');

  // An answer the host cannot read is the machine's own mistake, and never reaches a page.
  const wrong = nodes.askExecutors(machine.id, 1_000);
  const again = await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.equal(nodes.report(machine.id, again!.id, true, { at: '2026-11-06T10:00:00.000Z', executors: 'nope' }), true);
  await assert.rejects(() => wrong, NodeRefused);
});

test('迟到的机器探针回执不能换回上一份订阅', async (t) => {
  const { nodes, machine, f } = hub(t);
  const report = (hour: number, organizationId: string) => ({
    at: `2026-11-06T${hour}:00:00.000Z`,
    executors: [{ executor: 'claude', installed: true, logged_in: true, identity: { organizationId } }],
  });
  const old = report(10, 'aabbccdd-eeff-0011-2233-445566778899');
  const current = report(11, '00000000-0000-0000-0000-000000000000');
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: old });
  const requested = nodes.askExecutors(machine.id);
  const command = await nodes.poll(machine.id, { runs: [], facts: FACTS });
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: current });
  assert.equal(nodes.report(machine.id, command!.id, true, old), true);
  await requested;
  const login = f.ledger.getMachineLogin(machine.id, 'claude')!;
  assert.deepEqual(f.ledger.loginState(login.id).identity, current.executors[0]!.identity);
  assert.equal(nodes.reportedExecutors(machine.id)!.at, current.at);
});

// What this catches: a machine that comes back with nothing running being treated as if it
// had not come back. The reclaim callback is also what ends the runner's failure cooldown
// for that machine and brings its sweep forward (service/main.ts, runner/runner.ts); a
// machine that says "nothing here" needs that just as much as one naming a round.
test('机器连回来时即使没有在跑的轮次也通知认领回调', async (t) => {
  let at = 1_000_000;
  const f = fixture(t);
  const reclaims: { machineId: string; runs: unknown[] }[] = [];
  const nodes = createNodes({ ...NODES_TUNED,
    ledger: f.ledger,
    pollHoldMs: () => 30,
    commandTimeoutMs: () => 300,
    joinTtlMs: () => 60_000,
    gapSlackMs: () => 10_000,
    now: () => at,
    log: () => {},
  });
  nodes.onReclaim((machineId, runs) => reclaims.push({ machineId, runs }));
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;

  // Its first poll ever: away until now, and it has nothing running.
  await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.deepEqual(reclaims, [{ machineId: machine.id, runs: [] }], '连回来就通知，哪怕它说什么都没在跑');

  // Still connected: the next poll within the gap is not a return.
  at += 5_000;
  await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.equal(reclaims.length, 1, '连着的机器再 poll 一次不算连回来');

  // Gone past the gap and back again, still with nothing: told again.
  at += 10_001;
  assert.equal(nodes.connected(machine.id), false);
  await nodes.poll(machine.id, { runs: [], facts: FACTS });
  assert.equal(reclaims.length, 2);
  assert.deepEqual(reclaims[1], { machineId: machine.id, runs: [] });
});


test('machine quota refresh notification', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 1, log: () => {} });
  let changes = 0;
  f.ledger.onChange(() => changes++);
  const quota = { at: new Date().toISOString(), windows: [], error: 'read failed' };
  const report = { at: quota.at, executors: [{ executor: 'claude', installed: true, version: '2.1.303', logged_in: true, quota }] };
  await nodes.poll('h1', { runs: [], facts: FACTS, executors: report });
  assert.ok(changes > 0);
  changes = 0;
  await nodes.poll('h1', { runs: [], facts: FACTS, executors: report });
  assert.equal(changes, 0);
});
