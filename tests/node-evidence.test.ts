// Guards what one machine can say about a round's processes, and what it does about them
// (docs/design/nodes.md §4.2, §4.3, §7).
//
// What this file is here to catch, one test each:
//   - a round that finished while the question was being answered being read as lost,
//     because the exit code was read before the process was looked at (blocker 1),
//   - `left=unverified` turned into "no processes", which settles a success nobody verified
//     (blocker 2),
//   - `left=some` believed for ever, so a cleaned-up round never passes its own check
//     (blocker 3),
//   - a stop that signals a pid another process holds now, because the moment it began was
//     never compared (blocker 5),
//   - a stop that only targets the watch process's own pid, leaving a Worker that outlived it
//     running (blocker 6),
//   - two machines sharing one data directory reading each other's identity, pid file and
//     start moment (blocker 15),
//   - `tycho node status` taking a command out of the queue and dropping it (blocker 13),
//   - an exit record (or the watch's own) that is there but cannot be read, or reads as
//     nothing the watch writes, answered as "no record": with no process left that settles
//     a finished round as lost; and the same record answered by a stop as "nothing left"
//     without why, dropped from the listing the reconnect sweep goes by, or cleaned up.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { NodeFacts, NodeRunSummary, NodeState, NodeStopResult } from '../shared/node-protocol.ts';
import { judge } from '../runner/runner.ts';
import { createClient, identityOf, leaveRequested, readToken, requestLeave, writeToken } from '../node/client.ts';
import { nodeCommand } from '../node/cli.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { subtree } from '../node/hostprocess.ts';
import { machineScope } from '../node/runbox.ts';
import {
  boxOf, gateTaken, readWatchEvidence, readWorkerEvidence, requestStop, runState, takeGate,
  writeExit, writeLeft, writeWatchEvidence, writeWorkerEvidence,
} from '../node/runbox.ts';

const RELATIVE = 'tasks/t1/runs/r1';
const FACTS: NodeFacts = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'test', hostname: 'mac-mini-01.local' };

// A machine whose process table this test decides. `alive` and `start` may be given per pid:
// what is under test is which pid is taken for the round's own, so the answers have to be
// per pid rather than one answer for all of them.
interface Answers {
  alive?: boolean | ((pid: number) => boolean);
  start?: string | undefined | ((pid: number) => string | undefined);
  tree?: number[] | undefined | ((root: number) => number[] | undefined);
  tagged?: number[] | undefined;
  group?: boolean | undefined;
}

interface FakeProcesses extends HostProcesses {
  ended: { pid: number; signal: 'INT' | 'KILL'; group: boolean }[];
  // The moment a process of this test is ended, it is gone: what the caller does next is
  // what is under test, not a wait for a real signal.
  killed: Set<number>;
}

function processes(answers: Answers = {}): FakeProcesses {
  const killed = new Set<number>();
  const ask = <T>(given: T | ((pid: number) => T) | undefined, pid: number, fallback: T): T =>
    typeof given === 'function' ? (given as (pid: number) => T)(pid) : given === undefined ? fallback : given;
  const fake: FakeProcesses = {
    alive: (pid) => (killed.has(pid) ? false : ask(answers.alive, pid, false)),
    startOf: async (pid) => (killed.has(pid) ? undefined : ask(answers.start, pid, undefined)),
    // What has been ended is gone from the table it would have been found in: the look that
    // follows a signal is the thing under test, not a wait for a real process to disappear.
    descendants: async (root) => {
      const found = ask(answers.tree, root, undefined);
      return found === undefined ? undefined : found.filter((pid) => !killed.has(pid));
    },
    tagged: async () => (answers.tagged ?? []).filter((pid) => !killed.has(pid)),
    ended: [],
    killed,
    async endTree(pid, signal) {
      fake.ended.push({ pid, signal, group: false });
      killed.add(pid);
    },
    async endGroup(pid, signal) {
      fake.ended.push({ pid, signal, group: true });
      killed.add(pid);
    },
    ...(answers.group === undefined ? {} : { groupAlive: () => answers.group }),
  };
  return fake;
}

function machine(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-evidence-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    box: (relative = RELATIVE) => boxOf(dataDir, relative),
    client(procs: HostProcesses, extra: { stopped?: () => boolean } = {}) {
      const identity = identityOf(dataDir);
      writeToken(identity, 'f'.repeat(64));
      return {
        identity,
        client: createClient({
          dataDir,
          origin: 'http://127.0.0.1:1',
          token: readToken(identity)!,
          facts: FACTS,
          procs,
          log: () => {},
          ...extra,
          fetch: (() => Promise.reject(new Error('这个测试不该去问主机'))) as unknown as typeof globalThis.fetch,
        }),
      };
    },
  };
}

const state = (client: ReturnType<ReturnType<typeof machine>['client']>['client'], relative = RELATIVE): Promise<NodeState> =>
  client.execute({ id: 'c1', kind: 'state', run_dir: relative }) as Promise<NodeState>;

test('进程核实之后才读退出证据：查询途中写完退出码的一轮不算丢失', async (t) => {
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  // The watch is gone when it is looked at; the look itself is the moment it writes its
  // ending and leaves, which is what the file order has to survive.
  const procs = processes({
    alive: false,
    tree: () => {
      writeLeft(box, 'none');
      writeExit(box, 0);
      return [];
    },
    tagged: [],
  });
  const answer = await runState(box, procs);
  assert.equal(answer.exit, 0, '退出码已经写在盘上了');
  assert.equal(answer.pid_alive, false);
  assert.equal(answer.unknown, null);
  assert.equal(judge(answer, false), 'ended', '有成功退出证据的一轮要按结束结算，不能判丢失');
});

// An exit record that is there and cannot be read is not "no exit record": with the watch
// gone and no process left, reading it as none settles a finished round as lost (seen).
// A directory where the file should be stands in for a read the system refuses (EACCES on a
// locked file, EISDIR here): anything but "not there".
for (const [what, spoil] of [
  ['读取失败', (path: string) => mkdirSync(path)],
  ['内容损坏', (path: string) => writeFileSync(path, 'zero\n')],
] as const) {
  test(`退出证据${what}：答复是说不清（带原因），不是没有退出码，不判丢失`, async (t) => {
    const m = machine(t);
    const box = m.box();
    mkdirSync(join(box.runDir, 'started'), { recursive: true });
    writeWatchEvidence(box, 4242, 'watch-began');
    writeLeft(box, 'none');
    spoil(join(box.runDir, 'exit'));
    const answer = await runState(box, processes({ alive: false, tree: [], tagged: [] }));
    assert.equal(answer.started, true);
    assert.equal(answer.exit, null);
    assert.match(answer.unknown ?? '', /exit/, `说清是哪份记录读不出来：${answer.unknown}`);
    assert.equal(judge(answer, false), 'unknown', '读不出的退出证据不能结算成丢失');
  });
}

test('看管进程的记录读不出来：答复是说不清，不是看管进程还没登记', async (t) => {
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  mkdirSync(box.procDir, { recursive: true });
  writeFileSync(join(box.procDir, 'watch-pid'), 'garbage\n');
  const answer = await runState(box, processes({ alive: false, tree: [], tagged: [] }));
  assert.match(answer.unknown ?? '', /watch-pid/);
  assert.equal(judge(answer, false), 'unknown');
});

// The same unreadable record, asked about by the three commands that act on what `state`
// would say: a stop answers "cannot tell" with why, a listing keeps the round as possibly
// alive (the sweep that clears ended rounds goes by it), and a cleanup refuses.
function unreadableRound(m: ReturnType<typeof machine>) {
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  mkdirSync(box.procDir, { recursive: true });
  writeFileSync(join(box.procDir, 'watch-pid'), 'garbage\n');
  return box;
}

test('退出证据读不出来而看管进程还在：答“还在跑”，列出时也算活着', async (t) => {
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  mkdirSync(join(box.runDir, 'exit'));
  const { client } = m.client(processes({ alive: true, start: 'watch-began', tree: [4242], tagged: [] }));
  const answer = await state(client);
  assert.equal(answer.pid_alive, true, '看得见这一轮的进程，就照实说还在');
  const listed = (await client.execute({ id: 'c2', kind: 'list', alive_only: true })) as NodeRunSummary[];
  assert.deepEqual(listed.map(({ alive }) => alive), [true]);
});

test('记录读不出来时停止：答“查不清”并带上原因，不说清干净了', async (t) => {
  const m = machine(t);
  unreadableRound(m);
  const { client } = m.client(processes({ alive: false, tree: [], tagged: [] }));
  const answer = (await client.execute({ id: 'c1', kind: 'stop', run_dir: RELATIVE })) as NodeStopResult;
  assert.equal(answer.alive, null);
  assert.match(answer.unknown ?? '', /watch-pid/, '主机要拿到读不出来的是哪份记录');
});

test('记录读不出来时列出轮次：算“说不清”，只列活着的清单里也有它', async (t) => {
  const m = machine(t);
  unreadableRound(m);
  const { client } = m.client(processes({ alive: false, tree: [], tagged: [] }));
  const all = (await client.execute({ id: 'c1', kind: 'list', alive_only: false })) as NodeRunSummary[];
  assert.deepEqual(all.map(({ run_id, alive }) => [run_id, alive]), [['r1', null]]);
  const alive = (await client.execute({ id: 'c2', kind: 'list', alive_only: true })) as NodeRunSummary[];
  assert.deepEqual(alive.map(({ run_id }) => run_id), ['r1'], '没确认不在的轮次不能从清扫的候选里漏掉');
});

test('记录读不出来时清理：拒绝并说明原因，快照留着', async (t) => {
  const m = machine(t);
  const box = unreadableRound(m);
  const { client } = m.client(processes({ alive: false, tree: [], tagged: [] }));
  await assert.rejects(client.execute({ id: 'c1', kind: 'drop_run', run_dir: RELATIVE }), /watch-pid/);
  assert.equal(existsSync(join(box.runDir, 'snapshot')), true, '说不清还有没有进程，就不清理');
});

test('退出码在进程核实之前就读，会把它当丢失（这一条防的是反例本身）', async (t) => {
  // The same interleaving, read the other way round: the code is not on disk when the
  // question starts, and only appears while it is being answered.
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  let wrote = false;
  const procs = processes({
    alive: () => {
      if (!wrote) {
        wrote = true;
        writeLeft(box, 'none');
        writeExit(box, 0);
      }
      return false;
    },
    tree: [],
    tagged: [],
  });
  const answer = await runState(box, procs);
  assert.equal(answer.exit, 0);
  assert.equal(judge(answer, false), 'ended');
});

test('left=unverified：读不到进程表就说说不清，不当成没有进程', async (t) => {
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  writeLeft(box, 'unverified');
  writeExit(box, 0);

  const blind = await runState(box, processes({ alive: false, tree: undefined, tagged: undefined }));
  assert.equal(blind.exit, 0);
  assert.match(String(blind.unknown), /读不到进程表/, '残留没核实过就不能说这一轮没有进程');
  assert.equal(judge(blind, false), 'unknown', '主机不能按成功结算一个没核实过残留的轮次');

  // The table answers now and there is nothing in it: the residue has been verified since.
  const seen = await runState(box, processes({ alive: false, tree: [], tagged: [] }));
  assert.equal(seen.unknown, null);
  assert.equal(seen.pid_alive, false);
  assert.equal(judge(seen, false), 'ended');

  // And when the look does find something, that is what the host has to clean up.
  const left = await runState(box, processes({ alive: false, tree: [], tagged: [777] }));
  assert.equal(left.marked, true);
  assert.equal(left.unknown, null);
});

test('left=some：清理之后再核实的是当前现场，不是那条旧记录', async (t) => {
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  writeLeft(box, 'some');
  writeExit(box, 0);

  const state = await runState(box, processes({ alive: false, tree: [], tagged: [] }));
  assert.equal(state.marked, false, '进程表里已经没有这一轮的东西了');
  assert.equal(state.pid_alive, false);
  assert.equal(judge(state, false), 'ended', '清理干净的一轮能通过核实，不会被永远当成有残留');
});

test('看管进程不在而 Worker 还在：状态说活着，停止结束的是那个 Worker', async (t) => {
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  writeWorkerEvidence(box, 4343, 'worker-began');
  const procs = processes({
    alive: (pid) => pid === 4343,
    start: (pid) => (pid === 4343 ? 'worker-began' : undefined),
    tree: (root) => (root === 4343 ? [4343, 4344] : []),
    tagged: [],
  });
  const { client } = m.client(procs);

  const before = await state(client);
  assert.equal(before.pid_alive, true, 'Worker 活着就是这一轮还活着');
  assert.equal(before.unknown, null);

  const answer = (await client.execute({ id: 'c2', kind: 'stop', run_dir: RELATIVE })) as NodeStopResult;
  assert.equal(answer.alive, false, '停止之后要核实到没有东西了');
  const interrupts = procs.ended.filter((each) => each.signal === 'INT');
  assert.equal(interrupts.some((each) => each.pid === 4242), false, '早就没了的看管进程 pid 不再被发信号');
  const worker = interrupts.find((each) => each.pid === 4343);
  assert.ok(worker, '结束的是记下来的那个 Worker，而不是那个 Pid 文件里的旧号码');
  assert.equal(worker.group, true, 'Worker 有自己的进程组，整组一起结束');
});

test('pid 被别人占了：不发信号，报说不清', async (t) => {
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began-at');
  // 4242 is alive again, and the system says it began at another moment: it is a stranger's.
  const procs = processes({ alive: true, start: 'somebody-else', tree: [4242], tagged: [] });
  const { client } = m.client(procs);

  const answer = (await client.execute({ id: 'c1', kind: 'stop', run_dir: RELATIVE })) as NodeStopResult;
  assert.deepEqual(procs.ended, [], '没有向别人的进程发过信号');
  assert.equal(answer.alive, null, '归属证明不了就报说不清，不当成已经清干净');
});

test('启动时刻读不出来：不发信号，也不报“这里没有东西了”', async (t) => {
  const m = machine(t);
  const box = m.box();
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began-at');
  const procs = processes({ alive: true, start: undefined, tree: [4242], tagged: [] });
  const { client } = m.client(procs);
  const answer = (await client.execute({ id: 'c1', kind: 'stop', run_dir: RELATIVE })) as NodeStopResult;
  assert.deepEqual(procs.ended, [], '证明不了是自己的，就不发信号');
  assert.equal(answer.alive, true, '它可能就是我们那一轮，不能报成已经清干净');
});

test('共享 home：另一台机器的身份、pid 和证据都不认作本机的', async (t) => {
  const m = machine(t);
  // A machine that shares this data directory, with its own identity written the way a
  // client writes one.
  const foreignId = 'a'.repeat(32);
  const foreign = join(m.dataDir, 'nodes', 'another-machine', foreignId);
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'id'), `${foreignId}\n`);
  writeFileSync(join(foreign, 'token'), `${'b'.repeat(64)}\n`);

  const identity = identityOf(m.dataDir);
  assert.notEqual(identity.id, foreignId, '本机不用别的机器留下的身份');
  assert.ok(identity.dir.startsWith(join(m.dataDir, 'nodes')), '身份还是放在数据目录下面');

  // The round's own material is shared; the pid and the moment are not.
  const mine = boxOf(m.dataDir, RELATIVE);
  const theirs = boxOf(m.dataDir, RELATIVE, join(m.dataDir, 'nodes', 'another-machine'));
  takeGate(theirs);
  writeWatchEvidence(theirs, 4242, 'their-start');
  assert.deepEqual(readWatchEvidence(mine), {}, '本机读不到别台机器留下的 pid');
  assert.equal(gateTaken(mine), true, '闸门是共享的：这一轮已经被启动过');
  assert.notEqual(mine.procDir, theirs.procDir);
  assert.equal(mine.procDir.startsWith(join(machineScope(m.dataDir), 'runs')), true, '进程证据按机器分开');
  assert.equal(mine.runDir.includes(join('nodes', 'another-machine')), false, 'Run 证据仍走 tasks/');
});

// A round's watch and Worker are two roots of one table. Where the machine can read that
// table whole, both subtrees come from one look: the answer has to be the same as the two
// looks it replaces, toward a machine on which every look is an enumeration of its own.
test('一张表算两棵子树：能整表读的时候只读一次，答案和分开读的一样', async (t) => {
  const m = machine(t);
  const table = [
    { pid: 4242, ppid: 1 },
    { pid: 4343, ppid: 1 },
    { pid: 4244, ppid: 4242 },
    { pid: 4344, ppid: 4343 },
    { pid: 9001, ppid: 1 },
  ];
  const read = async (relative: string, whole: boolean) => {
    const box = m.box(relative);
    mkdirSync(join(box.runDir, 'started'), { recursive: true });
    writeWatchEvidence(box, 4242, 'watch-began');
    writeWorkerEvidence(box, 4343, 'worker-began');
    writeLeft(box, 'some');
    writeExit(box, 0);
    const calls = { table: 0, descendants: 0 };
    const procs: HostProcesses = {
      alive: () => false,
      startOf: async () => undefined,
      descendants: async (root) => {
        calls.descendants += 1;
        return subtree(table, root);
      },
      tagged: async () => [9001],
      endTree: async () => {},
      endGroup: async () => {},
      ...(whole ? { table: async () => { calls.table += 1; return table; } } : {}),
    };
    return { state: await runState(box, procs), calls };
  };

  const separate = await read('tasks/t1/runs/r1', false);
  const once = await read('tasks/t1/runs/r2', true);
  assert.deepEqual(once.state, separate.state, '一次整表读的答案和两次读的逐字相同');
  assert.deepEqual([separate.calls.table, separate.calls.descendants], [0, 2], '没有整表时，每个根各读一次');
  assert.deepEqual([once.calls.table, once.calls.descendants], [1, 0], '有整表时只读一次');
  assert.equal(once.state.pid_alive, true, '两个根下面的进程都在');
  assert.equal(once.state.marked, true, '表外面的标记进程也在');
});

test('tycho node leave：运行中的客户端停下，令牌也不再用来接活', async (t) => {
  const m = machine(t);
  const { identity } = m.client(processes());
  assert.equal(leaveRequested(identity), false);
  // What `tycho node leave` in another terminal writes, and what `node run` refuses on.
  requestLeave(identity);
  assert.equal(leaveRequested(identity), true);

  const { client } = m.client(processes(), { stopped: () => leaveRequested(identity) });
  await client.run(new AbortController().signal);
  assert.equal(existsSync(join(identity.dir, 'left')), true);
});

test('这一轮的路径要像一轮：别的形状不接受', (t) => {
  const m = machine(t);
  assert.throws(() => boxOf(m.dataDir, 'tasks/t1'), /路径不对/);
  assert.throws(() => boxOf(m.dataDir, 'tasks/../x/runs/r1'), /路径不对/);
  const box = boxOf(m.dataDir, '.tycho/tasks/t1/runs/r1');
  assert.equal(box.runId, 'r1');
  assert.equal(box.taskId, 't1');

  // What a stop revokes, and what the watch and the client look at, are files of this
  // machine's own evidence directory, never of the shared round directory (nodes.md §7).
  requestStop(box);
  assert.equal(existsSync(join(box.procDir, 'stop')), true);
  assert.equal(existsSync(join(box.runDir, 'stop')), false);
});

// A watch process that starts a Worker writes the Worker's own evidence: it is what a stop
// still has after the watch itself is gone.
test('Worker 的证据写在属主进程名下，和看管进程的分开', async (t) => {
  const m = machine(t);
  const box = m.box();
  writeWatchEvidence(box, 4242, 'watch-began');
  writeWorkerEvidence(box, 4343, 'worker-began');
  assert.deepEqual(readWatchEvidence(box), { pid: 4242, at: 'watch-began' });
  assert.deepEqual(readWorkerEvidence(box), { pid: 4343, at: 'worker-began' });
});

// `tycho node leave` in one terminal has to stop the client running in another. The mark it
// leaves is local, because the host cannot reach that process and because leaving is this
// machine's own act: the machine on the host stays until the owner deletes it (nodes.md §9).
test('tycho node leave：本机不再接活，令牌也清掉；再 run 就明确拒绝', async (t) => {
  const m = machine(t);
  const identity = identityOf(m.dataDir);
  writeToken(identity, 'f'.repeat(64));
  const said: string[] = [];
  const cli = { out: (line: string) => said.push(line), err: (line: string) => said.push(line), dataDir: m.dataDir, signal: new AbortController().signal };

  assert.equal(await nodeCommand(cli, ['leave']), 0);
  assert.equal(leaveRequested(identity), true, '留下“本机已经注销”的标记');
  assert.equal(readToken(identity), undefined, '本地令牌也清掉：它已经不能用了');
  assert.match(said.join('\n'), /不再收活/);

  await assert.rejects(() => nodeCommand(cli, ['run']), /注销过/);
});

// §9: a token the host no longer takes is a token this machine must not keep. Leaving it
// behind would have the next `node run` try the same rejected token for ever.
test('撤销之后：401 说清楚原因，本机令牌清掉', async (t) => {
  const m = machine(t);
  const identity = identityOf(m.dataDir);
  writeToken(identity, 'f'.repeat(64));
  writeFileSync(join(identity.dir, 'host'), 'http://127.0.0.1:1\n');
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: '机器令牌无效' }), { status: 401 }));

  const said: string[] = [];
  const cli = { out: (line: string) => said.push(line), err: (line: string) => said.push(line), dataDir: m.dataDir, signal: new AbortController().signal };
  await assert.rejects(() => nodeCommand(cli, ['status']), /令牌/);
  assert.equal(fetch.mock.callCount(), 1, '确实向主机询问了状态');
  assert.match(String(fetch.mock.calls[0].arguments[0]), /\/api\/node\/status$/);
  assert.equal(readToken(identity), undefined, '被撤销的令牌不留在这台机器上');
});

export { processes as fakeProcesses, machine as evidenceMachine };
