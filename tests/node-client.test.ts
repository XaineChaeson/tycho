// Guards what this machine's client answers for one round (docs/design/nodes.md §4.1,
// §4.3): the closed set of commands, what "unknown" means, and the stop that may only say
// "nothing is left" when it can prove it.
//
// What this file is here to catch:
//   - a state answer that reads a refused process scan as "nothing is running", which would
//     settle a live Run as ended,
//   - a stop that reports success without having looked,
//   - reading a file outside the machine's own data directory,
//   - an artifact listing that is not checked against the bytes that come back,
//   - a client that looks at its own executors on a clock of its own instead of the one the
//     host's setting gives it with every poll answer,
//   - a credential variable name from the host that no system takes starting a round,
//   - a Task's code copy dropped while one of its rounds cannot be vouched for, or a removal
//     that failed being answered as "dropped",
//   - a half snapshot left under its final name when the code bundle did not arrive whole, so a
//     start would take it for this round's,
//   - a client that returns from its polling while a command it took is still running and
//     reporting, so a replacement client waits for nothing and works beside it.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { NodeCommand, NodeExecutorReport, NodeFacts, NodeRange, NodeStartResult, NodeState } from '../shared/node-protocol.ts';
import { NODE_HOLD_HEADER, NODE_POLL_MARGIN_MS, NODE_PROTOCOL } from '../shared/node-protocol.ts';
import { createClient } from '../node/client.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { boxOf, writeExit, writeLeft, writeWatchEvidence, writeWorkerEvidence } from '../node/runbox.ts';

const FACTS: NodeFacts = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'test', hostname: 'mac-mini-01.local' };

// A machine whose processes this test decides: `alive` is what the client is told about the
// recorded pid, and `tree`/`tagged` are what its scans answer (undefined: it cannot say).
// `start` is the moment the system says a pid began: a pid alone proves nothing, so a test
// that wants a live process taken for this round's has to answer with the moment it recorded.
function processes(answers: { alive?: boolean; start?: string; tree?: number[] | undefined; tagged?: number[] | undefined; group?: boolean | undefined }): HostProcesses {
  return {
    alive: () => answers.alive ?? false,
    startOf: async () => answers.start,
    descendants: async () => answers.tree,
    tagged: async () => answers.tagged,
    endTree: async () => {},
    endGroup: async () => {},
    ...(answers.group === undefined ? {} : { groupAlive: () => answers.group }),
  };
}

function bench(t: TestContext, answers: Parameters<typeof processes>[0] = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const client = createClient({
    dataDir,
    origin: 'http://127.0.0.1:1',
    token: 'f'.repeat(64),
    facts: FACTS,
    procs: processes(answers),
    log: () => {},
    // No host is reached by the commands this file exercises.
    fetch: (() => Promise.reject(new Error('这个测试不该去问主机'))) as unknown as typeof globalThis.fetch,
  });
  return { dataDir, client };
}

const relative = 'tasks/t1/runs/r1';

test('有记录的这一轮结束：从记录里答，不去读进程表', async (t) => {
  const { dataDir, client } = bench(t, { tree: undefined, tagged: undefined });
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, undefined);
  writeLeft(box, 'none');
  writeExit(box, 0);

  const state = (await client.execute({ id: 'c1', kind: 'state', run_dir: relative })) as NodeState;
  assert.equal(state.exit, 0);
  assert.equal(state.pid_alive, false);
  assert.equal(state.marked, false);
  assert.equal(state.unknown, null, '记下来的结束就是结束，不需要再读进程表');
});

test('读了进程表也说不清：回未知，不回“没有进程”', async (t) => {
  const { dataDir, client } = bench(t, { alive: false, tree: undefined, tagged: undefined });
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, undefined);

  const state = (await client.execute({ id: 'c1', kind: 'state', run_dir: relative })) as NodeState;
  assert.equal(state.started, true);
  assert.equal(state.exit, null);
  assert.equal(state.pid_alive, false);
  assert.match(String(state.unknown), /读不到进程表/, '说不清就要说说不清');
});

test('看管进程还在：pid 活着就是跑着，不看它下面有什么', async (t) => {
  const { dataDir, client } = bench(t, { alive: true, start: 'watch-began', tree: undefined, tagged: undefined });
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  const state = (await client.execute({ id: 'c1', kind: 'state', run_dir: relative })) as NodeState;
  assert.equal(state.pid_alive, true);
  assert.equal(state.unknown, null);
});

// The other side of the same rule (§4.3): a live pid whose moment cannot be read is not
// proved to be this round's. It is not signalled either, and it is not called gone — it may
// well be the round, and nothing more starts after the gate.
test('启动时刻读不出来：按“还可能在跑”处理，不报成没有进程', async (t) => {
  const { dataDir, client } = bench(t, { alive: true, tree: undefined, tagged: undefined });
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  const state = (await client.execute({ id: 'c1', kind: 'state', run_dir: relative })) as NodeState;
  assert.equal(state.pid_alive, true);
  assert.equal(state.unknown, null);
});

test('停止：先写停止标记、再占闸门，然后才结束进程', async (t) => {
  const { dataDir, client } = bench(t, { alive: false, tree: [4242], tagged: [] });
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');

  const answer = (await client.execute({ id: 'c1', kind: 'stop', run_dir: relative })) as { alive: boolean | null };
  assert.equal(answer.alive, false);
  assert.ok(existsSync(join(box.procDir, 'stop')), '停止标记写在前面');
  assert.equal(existsSync(join(box.runDir, 'started')), true, '闸门被占过，迟到的启动不会跑');
});

test('停止：查不清就说查不清，不当成已经清干净', async (t) => {
  const { dataDir, client } = bench(t, { alive: false, tree: undefined, tagged: undefined });
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  const answer = (await client.execute({ id: 'c1', kind: 'stop', run_dir: relative })) as { alive: boolean | null };
  assert.equal(answer.alive, null);
});

test('停止：没占过闸门的一轮就是没有东西可停', async (t) => {
  const { dataDir, client } = bench(t);
  const answer = (await client.execute({ id: 'c1', kind: 'stop', run_dir: relative })) as { alive: boolean | null };
  assert.equal(answer.alive, false);
  assert.ok(existsSync(join(boxOf(dataDir, relative).procDir, 'stop')), '停止标记还是写下了：迟到的启动要看得见');
});

test('读输出：按偏移取一段，路径不许出数据目录', async (t) => {
  const { dataDir, client } = bench(t);
  const box = boxOf(dataDir, relative);
  mkdirSync(box.runDir, { recursive: true });
  writeFileSync(join(box.runDir, 'stdout.ndjson'), 'abcdef\n');
  const whole = (await client.execute({ id: 'c1', kind: 'read_output', path: `${relative}/stdout.ndjson`, offset: 0, bytes: 256 * 1024 })) as NodeRange;
  assert.equal(Buffer.from(whole.base64, 'base64').toString('utf8'), 'abcdef\n');
  assert.equal(whole.size, 7);
  assert.ok(whole.mtime > 0);
  const slice = (await client.execute({ id: 'c2', kind: 'read_output', path: `${relative}/stdout.ndjson`, offset: 2, bytes: 3 })) as NodeRange;
  assert.equal(Buffer.from(slice.base64, 'base64').toString('utf8'), 'cde');

  const missing = (await client.execute({ id: 'c3', kind: 'read_output', path: `${relative}/nope`, offset: 0, bytes: 10 })) as NodeRange;
  assert.deepEqual([missing.size, missing.mtime, missing.base64], [0, 0, '']);

  await assert.rejects(
    () => client.execute({ id: 'c4', kind: 'read_output', path: '../outside', offset: 0, bytes: 10 }),
    /路径/,
  );
});

test('读产物拒绝 artifacts 目录链接到同数据目录的别轮或目录外', async (t) => {
  for (const outside of [false, true]) {
    const { dataDir, client } = bench(t);
    const box = boxOf(dataDir, relative);
    mkdirSync(box.runDir, { recursive: true });
    const other = join(outside ? bench(t).dataDir : dataDir, 'tasks/t2/runs/r2/artifacts');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'report.md'), 'OTHER_RUN_SYNTHETIC_REPORT');
    symlinkSync(other, join(box.runDir, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(client.execute({ id: 'linked-list', kind: 'artifacts', run_dir: relative }), /路径.*链接/);
    await assert.rejects(client.execute({ id: 'linked-read', kind: 'read_output', path: relative + '/artifacts/report.md', offset: 0, bytes: 131072 }), /路径.*链接/);
    await assert.rejects(client.execute({ id: 'linked-bounded-read', kind: 'read_file', path: relative + '/artifacts/report.md', offset: 0, bytes: 131072, file_limit_bytes: 131072 }), /路径.*链接/);
  }
});

test('限定单文件读在读取内容前拒绝超限，不访问相邻大文件', async (t) => {
  const { dataDir, client } = bench(t);
  const dir = join(boxOf(dataDir, relative).runDir, 'artifacts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), 'small report');
  writeFileSync(join(dir, 'unrelated-large.bin'), Buffer.alloc(524288));
  const stream = fs.createReadStream;
  const whole = fs.readFileSync;
  const reads: string[] = [];
  fs.createReadStream = ((path, options) => { reads.push(String(path)); return stream(path, options); }) as typeof stream;
  fs.readFileSync = ((...args: Parameters<typeof whole>) => { reads.push(String(args[0])); return whole(...args); }) as typeof whole;
  syncBuiltinESMExports();
  try {
    const result = await client.execute({ id: 'selected', kind: 'read_file', path: relative + '/artifacts/report.md', offset: 0, bytes: 131072, file_limit_bytes: 131072 }) as NodeRange;
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'small report');
    assert.equal(reads.length, 1);
    assert.ok(reads[0]!.endsWith('report.md'));
    reads.length = 0;
    await assert.rejects(client.execute({ id: 'oversized', kind: 'read_file', path: relative + '/artifacts/unrelated-large.bin', offset: 0, bytes: 131072, file_limit_bytes: 131072 }), /上限/);
    assert.deepEqual(reads, []);
  } finally {
    fs.createReadStream = stream;
    fs.readFileSync = whole;
    syncBuiltinESMExports();
  }
});

test('直接文件符号链接也不能当作本轮普通产物', async (t) => {
  const { dataDir, client } = bench(t);
  const dir = join(boxOf(dataDir, relative).runDir, 'artifacts');
  mkdirSync(dir, { recursive: true });
  const other = join(dataDir, 'other-report.md');
  writeFileSync(other, 'OTHER_RUN_SYNTHETIC_REPORT');
  try { symlinkSync(other, join(dir, 'report.md'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Windows 当前权限不能创建文件符号链接；junction 用例独立覆盖目录链接');
      return;
    }
    throw error;
  }
  await assert.rejects(client.execute({ id: 'leaf-list', kind: 'artifacts', run_dir: relative }), /路径.*链接/);
  await assert.rejects(client.execute({ id: 'leaf-read', kind: 'read_output', path: relative + '/artifacts/report.md', offset: 0, bytes: 131072 }), /路径.*链接/);
});

test('受限文件命令必须明确有效大小上限，拒绝缺少或畸形的限额', async (t) => {
  const { client } = bench(t);
  for (const limit of [undefined, -1, NaN, Infinity, 1.5]) {
    const command = { id: 'invalid-limit', kind: 'read_file', path: relative + '/artifacts/report.md', offset: 0, bytes: 131072,
      ...(limit === undefined ? {} : { file_limit_bytes: limit }) } as NodeCommand;
    await assert.rejects(client.execute(command), /上限不合法/);
  }
});

test('数据根目录本身可由主人配置成 junction，根以下普通产物照常读取', async (t) => {
  const { dataDir } = bench(t);
  const actual = join(dataDir, 'actual-root');
  const alias = join(dataDir, 'configured-root');
  mkdirSync(join(actual, relative, 'artifacts'), { recursive: true });
  writeFileSync(join(actual, relative, 'artifacts/report.md'), 'root junction is supported');
  symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const client = createClient({ dataDir: alias, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs: processes({}), log: () => {} });
  const report = await client.execute({ id: 'root-read', kind: 'read_file', path: relative + '/artifacts/report.md', offset: 0, bytes: 131072, file_limit_bytes: 131072 }) as NodeRange;
  assert.equal(Buffer.from(report.base64, 'base64').toString(), 'root junction is supported');
});

test('产物：列出这一轮自己留下的文件，附上真算出来的哈希', async (t) => {
  const { dataDir, client } = bench(t);
  const box = boxOf(dataDir, relative);
  const artifacts = join(box.runDir, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'bundle.tar.gz'), '发布包');
  mkdirSync(join(artifacts, 'sub'), { recursive: true });
  writeFileSync(join(box.runDir, 'elsewhere.txt'), '不在 artifacts 里');

  const listed = (await client.execute({ id: 'c1', kind: 'artifacts', run_dir: relative })) as { name: string; sha256: string; bytes: number }[];
  assert.deepEqual(listed.map((file) => file.name), ['bundle.tar.gz'], '只列 artifacts/ 下的文件');
  assert.equal(listed[0]!.bytes, Buffer.byteLength('发布包'));
  assert.match(listed[0]!.sha256, /^[0-9a-f]{64}$/);
});

// The failure this guards: a file whose name holds a line break skipped without a word, so
// the host takes and registers the rest as everything the round left. Windows file names
// cannot hold one, so there is nothing to find there.
test('产物：有文件名里带换行的文件，整份不列，说清单损坏', { skip: process.platform === 'win32' && 'Windows 的文件名里不能有换行' }, async (t) => {
  const { dataDir, client } = bench(t);
  const artifacts = join(boxOf(dataDir, relative).runDir, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, 'report.txt'), '报告');
  writeFileSync(join(artifacts, 'two\nlines.txt'), '名字断成两行');
  await assert.rejects(() => client.execute({ id: 'c1', kind: 'artifacts', run_dir: relative }), /产物清单损坏：文件名里有换行/);
});

test('清掉暂存：还有进程时拒绝，没有进程时只删暂存', async (t) => {
  const running = bench(t, { alive: true, start: 'watch-began', tree: [4242], tagged: [] });
  const box = boxOf(running.dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'brief.md'), 'x');
  await assert.rejects(() => running.client.execute({ id: 'c1', kind: 'drop_run', run_dir: relative }), /还有进程/);
  assert.ok(existsSync(join(box.runDir, 'snapshot', 'brief.md')));

  const stopped = bench(t, { alive: false, tree: [], tagged: [] });
  const idle = boxOf(stopped.dataDir, relative);
  mkdirSync(join(idle.runDir, 'started'), { recursive: true });
  writeWatchEvidence(idle, 4242, 'watch-began');
  writeLeft(idle, 'none');
  writeExit(idle, 0);
  mkdirSync(join(idle.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(idle.runDir, 'snapshot', 'brief.md'), 'x');
  await stopped.client.execute({ id: 'c1', kind: 'drop_run', run_dir: relative });
  assert.equal(existsSync(join(idle.runDir, 'snapshot')), false);
  assert.ok(existsSync(join(idle.runDir, 'exit')), '这一轮的证据留着');
});

// A finished work's code copies on this machine: one directory per source it worked from,
// beside the round records. What this catches: a copy removed under a process, the round
// records or the round markers (the Task's history and its place in the round order) taken
// with them, a path that is not one Task's directory accepted, and "the directory is gone"
// taken as a failure on the retry.
test('清掉一个任务的代码副本：任何一轮还有进程就拒绝，都没进程就删每个来源的副本，runs/ 和 rounds/ 原样', async (t) => {
  const running = bench(t, { alive: true, start: 'watch-began', tree: [4242], tagged: [] });
  const taskDir = join(running.dataDir, 'tasks', 't1');
  mkdirSync(join(taskDir, 's-one'), { recursive: true });
  writeFileSync(join(taskDir, 's-one', 'a.txt'), 'x');
  const live = boxOf(running.dataDir, 'tasks/t1/runs/r1');
  mkdirSync(join(live.runDir, 'started'), { recursive: true });
  writeWatchEvidence(live, 4242, 'watch-began');
  await assert.rejects(
    () => running.client.execute({ id: 'c1', kind: 'drop_task_code', task_dir: 'tasks/t1' }),
    /还有一轮有进程.*r1/,
    '有一轮还在跑就不删',
  );
  assert.ok(existsSync(join(taskDir, 's-one', 'a.txt')), '还有进程时副本原样留着');
  assert.ok(existsSync(join(live.runDir, 'started')), '这一轮的记录不动');

  const idle = bench(t, { alive: false, tree: [], tagged: [] });
  const idleTask = join(idle.dataDir, 'tasks', 't1');
  // Two sources the Task worked from, and one of an older name: every one of them goes.
  for (const name of ['s-one', 's-two', 'repo']) {
    mkdirSync(join(idleTask, name), { recursive: true });
    writeFileSync(join(idleTask, name, 'a.txt'), 'x');
  }
  mkdirSync(join(idleTask, 'rounds'), { recursive: true });
  writeFileSync(join(idleTask, 'rounds', '2'), '');
  const runDir = join(idleTask, 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'stdout.ndjson'), '{}\n');
  writeFileSync(join(runDir, 'exit'), '0\n');
  const answer = await idle.client.execute({ id: 'c1', kind: 'drop_task_code', task_dir: 'tasks/t1' });
  assert.deepEqual(answer, { dropped: true });
  for (const name of ['s-one', 's-two', 'repo']) assert.equal(existsSync(join(idleTask, name)), false, name);
  assert.equal(readFileSync(join(runDir, 'stdout.ndjson'), 'utf8'), '{}\n', '执行记录留着');
  assert.ok(existsSync(join(runDir, 'exit')), '退出证据留着');
  assert.equal(readFileSync(join(idleTask, 'rounds', '2'), 'utf8'), '', '轮次标记留着：它在不在这个任务里不由清理决定');
  // The directory is gone because it was dropped: asking again is a success.
  const again = await idle.client.execute({ id: 'c2', kind: 'drop_task_code', task_dir: 'tasks/t1' });
  assert.deepEqual(again, { dropped: true });
});

test('清掉任务的代码副本：只认 tasks/<一段>，带 ..、更深或别的开头都拒绝', async (t) => {
  const { client } = bench(t);
  for (const bad of ['tasks/../outside', 'tasks/t1/runs/r1', 'tasks', 'x/tasks/t1', 'tasks/a/b']) {
    await assert.rejects(() => client.execute({ id: 'c1', kind: 'drop_task_code', task_dir: bad }), /路径/, bad);
  }
});

// A round this machine cannot speak for is not "nothing is running": removing a Task's code
// while one of its rounds may still be alive is the failure the refusal is for, and the
// answer has to name the round that stopped it.
test('清掉代码副本：说不清还有没有进程就拒绝，并说明是哪一轮', async (t) => {
  const { dataDir, client } = bench(t, { alive: false, tree: undefined, tagged: undefined });
  const taskDir = join(dataDir, 'tasks', 't1');
  mkdirSync(join(taskDir, 'repo'), { recursive: true });
  writeFileSync(join(taskDir, 'repo', 'a.txt'), 'x');
  const live = boxOf(dataDir, 'tasks/t1/runs/r1');
  mkdirSync(join(live.runDir, 'started'), { recursive: true });
  writeWatchEvidence(live, 4242, undefined);

  await assert.rejects(
    () => client.execute({ id: 'c1', kind: 'drop_task_code', task_dir: 'tasks/t1' }),
    /说不清这个任务还有没有进程.*r1/,
    '说不清就说清是哪一轮，不当作没有进程',
  );
  assert.ok(existsSync(join(taskDir, 'repo', 'a.txt')), '说不清时副本原样留着');
});

// A removal that fails is a failed command, never a "dropped": the host records a machine's
// copy as gone only on success, so swallowing the error would make the ledger say bytes are
// gone while they are still on the machine.
test('清掉代码副本：repo/ 删不掉时回答失败，不报成功', async (t) => {
  const { dataDir, client } = bench(t, { alive: false, tree: [], tagged: [] });
  const repo = join(dataDir, 'tasks', 't1', 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'x');
  // The removal itself fails, as a file held open or a directory without write permission
  // makes it fail: stubbed, because no such hold is reliable on every platform and load.
  const real = fs.rmSync;
  const failing = t.mock.method(fs, 'rmSync', ((path: string, ...rest: []) => {
    if (String(path) === repo) throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${path}'`), { code: 'EPERM' });
    return real(path, ...rest);
  }) as typeof real);
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () => client.execute({ id: 'c1', kind: 'drop_task_code', task_dir: 'tasks/t1' }),
      /EPERM/,
      '删不掉就是失败，不能回答 dropped',
    );
    assert.ok(existsSync(repo), '删不掉时目录还在');
  } finally {
    failing.mock.restore();
    syncBuiltinESMExports();
  }
});

test('清点：列出这台机器上的轮次，alive_only 只留还有进程的', async (t) => {  const { dataDir, client } = bench(t, { alive: true, start: 'watch-began', tree: [4242], tagged: [] });
  const live = boxOf(dataDir, 'tasks/t1/runs/live');
  mkdirSync(join(live.runDir, 'started'), { recursive: true });
  writeWatchEvidence(live, 4242, 'watch-began');
  const done = boxOf(dataDir, 'tasks/t2/runs/done');
  mkdirSync(join(done.runDir, 'started'), { recursive: true });
  writeWatchEvidence(done, 4243, 'watch-began');
  writeLeft(done, 'none');
  writeExit(done, 0);

  const all = (await client.execute({ id: 'c1', kind: 'list', alive_only: false })) as { task_id: string; run_id: string; alive: boolean }[];
  assert.deepEqual(all.map((run) => `${run.task_id}/${run.run_id}:${run.alive}`).sort(), ['t1/live:true', 't2/done:false']);
  const alive = (await client.execute({ id: 'c2', kind: 'list', alive_only: true })) as { task_id: string }[];
  assert.deepEqual(alive.map((run) => run.task_id), ['t1']);
});

test('快照取不到就不启动：机器上连闸门都没占', async (t) => {
  const { dataDir, client } = bench(t);
  const started = (await client.execute({
    id: 'c1', kind: 'start', run_dir: relative, task_id: 't1', run_id: 'r1', round: 1,
    argv: [process.execPath, '-e', ''], env: {}, credential: null,
  })) as NodeStartResult;
  assert.equal(started.code, 2);
  assert.match(String(started.error), /快照/);
  assert.equal(existsSync(join(boxOf(dataDir, relative).runDir, 'started')), false);
});

// The snapshot is whole or it is not there (node/client.ts, prepare): what it writes is exactly
// the files the host named, and where the round's code comes from is one of them (`source.json`);
// nothing binary is fetched beside them.
test('取这一轮的快照：按名字写下每个文件，代码来源也在其中', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const asked: string[] = [];
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, log: () => {},
    procs: processes({ alive: false, tree: [], tagged: [] }),
    executors: { questions: [] },
    fetch: (async (url: string | URL) => {
      asked.push(String(url));
      if (String(url).endsWith('/snapshot')) {
        return new Response(JSON.stringify({
          run_dir: relative,
          files: [
            { path: 'brief.md', text: '# 这一轮\n' },
            { path: 'source.json', text: '{"kind":"repo","url":"https://example.test/a.git"}\n' },
            { path: 'access.json', text: '{"permission":"read"}\n' },
          ],
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });
  const box = boxOf(dataDir, relative);
  const written = await client.execute({ id: 'c1', kind: 'prepare', run_dir: relative }) as { path: string }[];
  assert.deepEqual(written.map(({ path }) => path).sort(), ['access.json', 'brief.md', 'source.json']);
  assert.equal(readFileSync(join(box.runDir, 'snapshot', 'source.json'), 'utf8'), '{"kind":"repo","url":"https://example.test/a.git"}\n');
  assert.deepEqual(asked.filter((url) => !url.endsWith('/snapshot')), [], '除了快照没有再取别的');
});

// The variable the credential goes into is named by the host. One no system takes is a round
// that does not start here, said as such — before the credential is even fetched.
test('主机给的凭据变量名不合法：这一轮没有开工，也不去取凭据', async (t) => {
  const { dataDir, client } = bench(t);
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'snapshot'), { recursive: true });
  writeFileSync(join(box.runDir, 'snapshot', 'brief.md'), 'x');
  for (const credential of [{ via: 'env', variable: 'A=B' }, { via: 'env', variable: '1ABC' }, { via: 'pipe', variable: 'OK' }, { via: 'fd', variable: 'OK' }]) {
    const started = (await client.execute({
      id: 'c1', kind: 'start', run_dir: relative, task_id: 't1', run_id: 'r1', round: 1,
      argv: [process.execPath, '-e', ''], env: {}, credential,
    } as unknown as NodeCommand)) as NodeStartResult;
    assert.equal(started.code, 2, JSON.stringify(credential));
    assert.match(String(started.error), /凭据(变量名不能用|交付方式不认识)|文件描述符/);
  }
  assert.equal(existsSync(join(box.runDir, 'started')), false, '闸门没被占');
});

test('这一轮的路径要像一轮：别的形状不接受', () => {
  assert.throws(() => boxOf('C:/data', 'tasks/t1'), /路径不对/);
  assert.throws(() => boxOf('C:/data', 'tasks/../x/runs/r1'), /路径不对/);
  const box = boxOf('C:/data', '.tycho/tasks/t1/runs/r1');
  assert.equal(box.runId, 'r1');
  assert.equal(box.taskId, 't1');
});

// §1.2, §11 step 5: asking this machine about its own executors is the client's own act. The
// command the host sends carries nothing, so what runs here is this machine's closed set —
// and a command that arrives with fields it has no meaning for changes nothing.
test('主机发来的 probe：只问这台机器自己声明的那几条命令，命令里带不了别的东西', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const asked: string[][] = [];
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS,
    procs: processes({}), log: () => {},
    fetch: (() => Promise.reject(new Error('这个测试不该去问主机'))) as unknown as typeof globalThis.fetch,
    executors: {
      questions: [{ executor: 'stub', command: 'stub-cli', version: ['--version'], login: ['login', 'status'] }],
      run: async (argv) => {
        asked.push(argv);
        return argv[1] === '--version' ? { stdout: 'stub-cli 1.0\n', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 };
      },
      now: () => Date.parse('2026-11-06T10:00:00.000Z'),
    },
  });
  const answer = (await client.execute({
    id: 'c1', kind: 'probe', argv: ['rm', '-rf', '/'], run_dir: 'x', credential: { via: 'env', variable: 'X' },
  } as unknown as NodeCommand)) as NodeExecutorReport;
  assert.deepEqual(asked, [['stub-cli', '--version'], ['stub-cli', 'login', 'status']], '命令里带的东西一个也没用上');
  assert.deepEqual(answer, {
    at: '2026-11-06T10:00:00.000Z',
    executors: [{ executor: 'stub', installed: true, version: 'stub-cli 1.0', logged_in: false }],
  });

  // One look at a time: a second probe landing while the first is running is the same answer,
  // not a second round of commands.
  const before = asked.length;
  const [first, second] = await Promise.all([client.look(), client.look()]);
  assert.equal(asked.length - before, 2, '同时问两次只跑一轮命令');
  assert.equal(first, second, '两次问的是同一次读到的');
});

// §4.4, §8.1: the host counts this machine as here for only a moment between two polls, and
// one look at the process table (a PowerShell per round on Windows) can take longer than
// that moment. What this catches: a poll loop that reads every round's processes before each
// poll, so that a machine with rounds on it goes out of contact between polls through no
// fault of its own — and its Runs are judged lost while they run.
test('两次 poll 之间不等自己的清点：进程表读得再慢，下一次 poll 照发', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => {
    release();
    rmSync(dataDir, { recursive: true, force: true });
  });
  // The first look at the processes answers at once; every one after it hangs until the test
  // lets go. A watch pid nobody holds is what makes the look go to the process table at all.
  let slow = false;
  const procs: HostProcesses = {
    ...processes({ alive: false, tree: [], tagged: [] }),
    descendants: async () => {
      if (slow) await released;
      return [];
    },
  };
  const polls: { runs: { run_id: string }[] }[] = [];
  const stop = new AbortController();
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs, log: () => {},
    executors: { questions: [] },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/api/node/poll')) return new Response('{}', { status: 200 });
      polls.push(JSON.parse(String(init?.body)) as { runs: { run_id: string }[] });
      slow = true;
      // Held a moment, as a host holds one: answered in the same tick, the loop would never
      // leave the microtask queue and nothing else in this process would get a turn.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ protocol: NODE_PROTOCOL, command: null }), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');

  const running = client.run(stop.signal);
  const deadline = Date.now() + 5000;
  while (polls.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort();
  release();
  await running;
  assert.ok(polls.length >= 3, `进程表卡住的时候 poll 该照发，实际只发了 ${polls.length} 次`);
  assert.deepEqual(polls[0]!.runs.map((run) => run.run_id), ['r1'], '第一次 poll 带的是刚清点出来的轮次');
});

// How often a machine looks at its executors again is the owner's setting on the host
// (node.executorRefreshMs), told with each poll answer; the client keeps no clock of its own.
test('主机在回答里说多久重看一次执行器：客户端照它重看，说变了就按新的', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  const stop = new AbortController();
  const oldEvery = 40;
  const newEvery = 60 * 60_000;
  let clock = 0;
  const starts: number[] = [];
  const probes: number[] = [];
  const lookups: ReturnType<typeof Promise.withResolvers<{ env: NodeJS.ProcessEnv }>>[] = [];
  type Poll = { answer: (every: number) => void };
  let poll = Promise.withResolvers<Poll>();
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs: processes({ alive: false, tree: [], tagged: [] }),
    log: (line) => assert.fail(line),
    lookupEnv: () => {
      starts.push(clock);
      const read = Promise.withResolvers<{ env: NodeJS.ProcessEnv }>();
      lookups.push(read);
      return read.promise;
    },
    executors: { questions: [], now: () => { probes.push(clock); return clock; } },
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      const response = Promise.withResolvers<Response>();
      const signal = init!.signal!;
      const abort = () => response.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const reached = poll;
      poll = Promise.withResolvers<Poll>();
      reached.resolve({ answer: (every) => response.resolve(new Response(JSON.stringify({ protocol: NODE_PROTOCOL, command: null, look_every_ms: every }))) });
      return response.promise.finally(() => signal.removeEventListener('abort', abort));
    }) as typeof globalThis.fetch,
  });
  const firstPoll = poll.promise;
  const running = client.run(stop.signal);
  t.after(async () => { stop.abort(); await running; rmSync(dataDir, { recursive: true, force: true }); });
  const initialLook = client.look();
  lookups[0]!.resolve({ env: {} });
  await initialLook;
  const first = await firstPoll;
  const secondPoll = poll.promise;
  first.answer(oldEvery);
  // The next request proves the previous answer, including its interval, was adopted.
  const second = await secondPoll;
  clock += oldEvery;
  t.mock.timers.tick(oldEvery);
  assert.deepEqual(starts, [0, oldEvery], '主机给的旧周期会启动一次查询');
  assert.deepEqual(probes, [0], '第二次查询仍在等 lookup，没有完成探针');
  const oldLook = client.look();
  const thirdPoll = poll.promise;
  second.answer(newEvery);
  await thirdPoll;
  clock += oldEvery;
  t.mock.timers.tick(oldEvery);
  assert.deepEqual(starts, [0, oldEvery], '旧查询在途时不重复启动');
  lookups[1]!.resolve({ env: {} });
  await oldLook;
  assert.deepEqual(probes, [0, clock], '新周期生效后，已启动的旧查询仍可完成');
  clock += oldEvery;
  t.mock.timers.tick(oldEvery);
  assert.deepEqual(starts, [0, oldEvery], '旧查询完成后，也不再按旧周期启动');
  clock += newEvery - 2 * oldEvery - 1;
  t.mock.timers.tick(newEvery - 2 * oldEvery - 1);
  assert.deepEqual(starts, [0, oldEvery], '新周期还差一毫秒时不查询');
  clock += 1;
  t.mock.timers.tick(1);
  assert.deepEqual(starts, [0, oldEvery, oldEvery + newEvery], '到新周期会再次查询');
  const newLook = client.look();
  lookups[2]!.resolve({ env: {} });
  await newLook;
  assert.equal(probes.length, 3, '新周期的查询也完成了探针');
  stop.abort();
  await running;
  clock += newEvery;
  t.mock.timers.tick(newEvery);
  assert.equal(starts.length, 3, '退出后不再启动查询');
});

// The same moment, the other question: on Windows the moment a pid began is a program run
// per pid (service/lock.ts), and it used to be run synchronously — a slow one held the whole
// client, poll and stop alike, inside a look that was meant to be in the background. What
// this catches: a start-moment query that is slow for one round holding up the next poll, a
// stop of another round, or the client's own leaving.
test('启动时刻查得再慢：下一次 poll 照发，别的轮次的停止照做，客户端照常退出', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => {
    release();
    rmSync(dataDir, { recursive: true, force: true });
  });
  // Round r1's watch is alive and the moment it began is the slow question, after the first
  // poll; round r2's watch is gone, so its stop has nothing to wait for but the look itself.
  let slow = false;
  const procs: HostProcesses = {
    ...processes({ tree: [], tagged: [] }),
    alive: (pid) => pid === 4242,
    startOf: async (pid) => {
      if (pid === 4242 && slow) await released;
      return 'watch-began';
    },
  };
  const polls: { runs: { run_id: string }[] }[] = [];
  const reports: { command_id: string; ok: boolean; result?: { alive: boolean | null } }[] = [];
  const stop = new AbortController();
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs, log: () => {},
    executors: { questions: [] },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/node/report')) {
        reports.push(JSON.parse(String(init?.body)) as (typeof reports)[number]);
        return new Response('{}', { status: 200 });
      }
      if (!String(url).endsWith('/api/node/poll')) return new Response('{}', { status: 200 });
      polls.push(JSON.parse(String(init?.body)) as { runs: { run_id: string }[] });
      slow = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      // The second poll carries a stop for the round whose processes answer: it must not
      // wait behind the look that is stuck on the other round.
      const command: NodeCommand | null = polls.length === 2
        ? { id: 'stop-r2', kind: 'stop', run_dir: 'tasks/t1/runs/r2' }
        : null;
      return new Response(JSON.stringify({ protocol: NODE_PROTOCOL, command }), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  for (const [runId, pid] of [['r1', 4242], ['r2', 4343]] as const) {
    const box = boxOf(dataDir, `tasks/t1/runs/${runId}`);
    mkdirSync(join(box.runDir, 'started'), { recursive: true });
    writeWatchEvidence(box, pid, 'watch-began');
  }

  const running = client.run(stop.signal);
  const deadline = Date.now() + 5000;
  while ((polls.length < 3 || reports.length < 1) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  // Leaving does not wait for the stuck look either. Stopped before anything is asserted: a
  // loop left running would keep this process alive past a failed assertion.
  const asked = Date.now();
  stop.abort();
  await running;
  const leaving = Date.now() - asked;
  release();
  assert.ok(polls.length >= 3, `启动时刻卡住的时候 poll 该照发，实际只发了 ${polls.length} 次`);
  assert.equal(reports[0]?.command_id, 'stop-r2', '另一轮的停止不该排在卡住的清点后面');
  assert.deepEqual(polls[0]!.runs.map((run) => run.run_id).sort(), ['r1', 'r2'], '第一次 poll 带的是刚清点出来的两轮');
  assert.ok(leaving < 2000, `客户端退出不该等卡住的清点（等了 ${leaving} 毫秒）`);
});

// What these catch: a client that gave up on a poll at a fixed 75 seconds of its own whatever
// the host said, so a hold the owner set longer than that broke every idle poll and sent the
// client into backoff; and the opposite, a poll the host has stopped answering that is never
// given up on. The hold travels in the answer's headers, which the host sends as the hold
// begins; time here is the test's, so five minutes take no time at all.
function heldPolls(t: TestContext, holdMs: number) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const polls: { signal: AbortSignal; answer: (text: string) => void }[] = [];
  const logs: string[] = [];
  let readyPolls=0;
  const arrived:Array<{count:number;resolve:()=>void}>=[];
  const waitForPoll=(count:number):Promise<void>=>readyPolls>=count?Promise.resolve():new Promise(resolve=>arrived.push({count,resolve}));
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs: processes({ tree: [], tagged: [] }),
    log: (line) => logs.push(line),
    executors: { questions: [] },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/api/node/poll')) return new Response('{}', { status: 200 });
      const signal = init!.signal!;
      let answer!: (text: string) => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          answer = (text) => {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          };
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      polls.push({ signal, answer });
      const response=new Response(body, { status: 200, headers: { [NODE_HOLD_HEADER]: String(holdMs) } });const text=response.text.bind(response);Object.defineProperty(response,'text',{value:()=>{readyPolls++;for(const waiter of arrived.splice(0)){if(readyPolls>=waiter.count)waiter.resolve();else arrived.push(waiter);}return text();}});return response;
    }) as typeof globalThis.fetch,
  });
  return { client, polls, logs,waitForPoll };
}

// Lets the client's own promises and file reads run; mocked timers do not move meanwhile.
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('长轮询挂得比 75 秒久、又没有命令：客户端不断开，等主机说的挂起时长', async (t) => {
  const HOLD = 5 * 60_000;
  const { client, polls, logs,waitForPoll } = heldPolls(t, HOLD);
  const stop = new AbortController();
  const running = client.run(stop.signal);
  await waitForPoll(1);
  assert.equal(polls.length, 1);
  t.mock.timers.tick(HOLD - 1000);
  await settle();
  assert.equal(polls[0]!.signal.aborted, false, '挂起 4 分 59 秒还没到主机说的时长，客户端不该断开');
  assert.equal(polls.length, 1, '没有断开重连');
  assert.deepEqual(logs.filter((line) => line.includes('连不上主机')), []);
  // The host's hold runs out with nothing to do: the answer comes and the next poll goes out.
  polls[0]!.answer(JSON.stringify({ protocol: NODE_PROTOCOL, command: null }));
  await waitForPoll(2);
  assert.equal(polls.length, 2, '答完马上再问');
  stop.abort();
  await running;
  assert.deepEqual(logs.filter((line) => line.includes('连不上主机')), []);
});

test('长轮询过了主机说的挂起时长加网络余量还没答：客户端当它断了，重新连', async (t) => {
  const HOLD = 5 * 60_000;
  const { client, polls, logs,waitForPoll } = heldPolls(t, HOLD);
  const stop = new AbortController();
  const running = client.run(stop.signal);
  await waitForPoll(1);
  t.mock.timers.tick(HOLD + NODE_POLL_MARGIN_MS - 1);
  await settle();
  assert.equal(polls[0]!.signal.aborted, false, '余量之内还等着');
  t.mock.timers.tick(2);
  await settle();
  assert.equal(polls[0]!.signal.aborted, true, '过了余量不再等');
  assert.ok(logs.some((line) => line.includes('连不上主机')), logs.join('\n'));
  stop.abort();
  await running;
});

// What this catches: a client of this protocol facing a host of the previous one, which
// holds a poll without ever saying for how long. The client would give up at its plain
// request limit and back off over and over, a machine that looks flaky rather than one that
// needs an upgrade. The host checks the version first, as a host of 2 did, so the client is
// told the versions differ and stops, with no wait and no retry.
test('新客户端遇到上一版协议的主机：当场得到版本不符并停下，不等挂起、不退避重试', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const OLD = NODE_PROTOCOL - 1;
  const asked: number[] = [];
  const logs: string[] = [];
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs: processes({ tree: [], tagged: [] }),
    log: (line) => logs.push(line),
    executors: { questions: [] },
    // A host of the previous protocol: every node route refuses another version with 426.
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      const { protocol } = JSON.parse(String(init?.body ?? '{}')) as { protocol?: number };
      asked.push(protocol ?? -1);
      if (protocol === OLD) return new Response(JSON.stringify({ protocol: OLD, command: null }), { status: 200 });
      return new Response(JSON.stringify({ error: `协议版本不符：这台机器上的客户端是第 ${protocol} 版，主机是第 ${OLD} 版。` }), { status: 426 });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(client.run(new AbortController().signal), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 426);
    assert.match((error as Error).message, /协议版本不符/);
    return true;
  });
  assert.deepEqual(asked, [NODE_PROTOCOL], '只问了一次，没有退避重试');
  assert.deepEqual(logs.filter((line) => line.includes('连不上主机')), []);
});

// A client that can be told to drop a Task's code copy says so on every poll; one from before
// it says nothing, and the host never sends that command to it (service/retention.ts). What
// this catches: the ability being implied by the protocol version, so an older machine would
// be asked for something it cannot do and its copies left looking cleared.
test('每次 poll 都说明能收 drop_task_code', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const polls: Record<string, unknown>[] = [];
  const stop = new AbortController();
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs: processes({ tree: [], tagged: [] }), log: () => {},
    executors: { questions: [] },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/api/node/poll')) return new Response('{}', { status: 200 });
      polls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      stop.abort();
      return new Response(JSON.stringify({ protocol: NODE_PROTOCOL, command: null }), { status: 200 });
    }) as typeof globalThis.fetch,
  });
  await client.run(stop.signal);
  assert.equal(polls[0]?.drops_task_code, true);
});

// The client answered the host for the commands it took out of the queue, so `run()`
// returning has to mean they are done: the command's own work finished and its report went
// out. What this catches: a client told to stop that returns while an accepted command is
// still running and reporting — a replacement client would then work beside it on the same
// machine, which is exactly what tests/node-run-fixture.ts's stopClients() waits on this
// return to rule out (nodes.md §4.2, §7).
test('停下之后：接下的命令和它的报告收尾了，run() 才返回', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  // The command's own work, the report that follows it, and the poll after it are each held
  // where the test decides: what run() waits for is the whole question.
  let commandBegun!: () => void;
  const begun = new Promise<void>((resolve) => { commandBegun = resolve; });
  let commandMayEnd!: () => void;
  const commandEnds = new Promise<void>((resolve) => { commandMayEnd = resolve; });
  let reportBegun!: () => void;
  const reportInFlight = new Promise<void>((resolve) => { reportBegun = resolve; });
  let reportMayEnd!: () => void;
  const reportEnds = new Promise<void>((resolve) => { reportMayEnd = resolve; });
  const reports: { command_id: string; ok: boolean; result?: unknown }[] = [];
  let polls = 0;

  // A stop looks the round's processes up, which is where the one command here hangs.
  const procs: HostProcesses = {
    ...processes({ alive: false, tree: [], tagged: [] }),
    tagged: async () => {
      commandBegun();
      await commandEnds;
      return [];
    },
  };
  const stop = new AbortController();
  const client = createClient({
    dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS, procs, log: () => {},
    executors: { questions: [] },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const at = String(url);
      if (at.endsWith('/api/node/report')) {
        reports.push(JSON.parse(String(init?.body)) as (typeof reports)[number]);
        reportBegun();
        await reportEnds;
        return new Response('{}', { status: 200 });
      }
      if (!at.endsWith('/api/node/poll')) return new Response('{}', { status: 200 });
      polls += 1;
      if (polls === 1) {
        return new Response(JSON.stringify({
          protocol: NODE_PROTOCOL,
          command: { id: 'stop-1', kind: 'stop', run_dir: relative },
        }), { status: 200 });
      }
      // Held the way the host holds one: only the client giving up on it ends this one, and
      // a request begun after that already ended is refused as it would be.
      const signal = init!.signal!;
      if (signal.aborted) throw signal.reason ?? new Error('停下了');
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('停下了')), { once: true });
      });
    }) as typeof globalThis.fetch,
  });

  const running = client.run(stop.signal);
  let returned = false;
  const done = running.then(() => { returned = true; });
  await begun;
  // The command is in hand. The client is told to stop and the command may finish; its
  // report is held, so what run() does about it is all that is left.
  stop.abort();
  commandMayEnd();
  await reportInFlight;
  await settle();
  assert.equal(returned, false, '接下的命令的报告还没发出去，run() 不该已经返回');
  reportMayEnd();
  await done;
  assert.deepEqual(reports.map((each) => [each.command_id, each.ok, each.result]), [['stop-1', true, { alive: false }]], '接下的命令报过一次，报的是它自己的结果');
  // Nothing this client took stays at work past its own return: no report and no poll after.
  const asked = polls;
  await settle();
  assert.equal(polls, asked, 'run() 返回之后不再问主机要活');
  assert.equal(reports.length, 1, 'run() 返回之后不再上报');
});

test('停止宽限期内 watch 仍存活时只向 Worker 发信号，不提前杀 watch.pid', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-node-client-stop-watch-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const box = boxOf(dataDir, relative);
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  writeWatchEvidence(box, 4242, 'watch-began');
  writeWorkerEvidence(box, 4343, 'worker-began');

  let watchAlive = true;
  let workerAlive = true;
  const signalled: { pid: number; signal: 'INT' | 'KILL'; kind: 'group' | 'tree' }[] = [];
  const procs: HostProcesses = {
    alive: (pid) => (pid === 4242 ? watchAlive : pid === 4343 ? workerAlive : false),
    startOf: async (pid) => (pid === 4242 ? 'watch-began' : pid === 4343 ? 'worker-began' : undefined),
    descendants: async (root) => {
      if (root === 4242 && watchAlive) return workerAlive ? [4242, 4343] : [4242];
      if (root === 4343 && workerAlive) return [4343];
      return [];
    },
    tagged: async () => [],
    endGroup: async (pid, signal) => {
      signalled.push({ pid, signal, kind: 'group' });
      if (pid === 4343) {
        workerAlive = false;
        // Simulate watch finishing capture.finish(), writing left/exit, and exiting cleanly.
        writeLeft(box, 'none');
        writeExit(box, 137);
        watchAlive = false;
      }
    },
    endTree: async (pid, signal) => {
      signalled.push({ pid, signal, kind: 'tree' });
    },
  };
  const client = createClient({
    dataDir,
    origin: 'http://127.0.0.1:1',
    token: 'f'.repeat(64),
    facts: FACTS,
    procs,
    log: () => {},
    fetch: (() => Promise.reject(new Error('这个测试不该去问主机'))) as unknown as typeof globalThis.fetch,
  });

  const answer = (await client.execute({ id: 'c-stop-watch', kind: 'stop', run_dir: relative })) as { alive: boolean | null };
  assert.equal(answer.alive, false);
  assert.equal(signalled.some((s) => s.pid === 4242), false, '宽限期内不得向存活的 watch.pid 发信号');
  assert.deepEqual(signalled, [{ pid: 4343, signal: 'INT', kind: 'group' }], '仅向 Worker 进程组发停止信号');
});
