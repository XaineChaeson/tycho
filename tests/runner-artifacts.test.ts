// Guards taking a Run's artifacts back over the read channel: a file listed by the
// machine but not there, one whose bytes do not hash as it said, a name that would write
// outside the directory or could not be a file name, the same name listed twice, and a
// file larger than one read being read in one go. A machine out of contact is reported,
// not thrown: the acceptance of the Task goes on without its files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { createRunner } from '../runner/runner.ts';
import type { ArtifactOnMachine } from '../runner/host.ts';
import type { Account } from '../runner/snapshot.ts';
import type { RemoteHost } from '../runner/host.ts';
import { ListingFailed, Unreachable } from '../runner/host.ts';
import { createNodeChannel } from '../runner/node-channel.ts';
import type { NodeChannelOptions } from '../runner/node-channel.ts';
import { NodeRefused } from '../service/nodes.ts';
import { ARTIFACT_NAME_RULE, artifactNameIsUsable } from '../service/releases.ts';
import { tempDir } from './cli-helpers.ts';
import type { Fixture } from './helpers.ts';
import { fixture, LOGIN, memoryLogins, RUNNER_TUNED } from './helpers.ts';

const ACCOUNTS: Record<string, Account> = {
  // The fixture's own login, run here by the stub executor.
  [LOGIN.login.id]: { id: LOGIN.login.id, name: LOGIN.login.name, executor: 'stub', machine: 'h1', tiers: {} },
};

const sum = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

interface Fake {
  host: RemoteHost;
  // Which artifact paths were read, in order, with the offset each read started at.
  reads: [string, number][];
  listed: ArtifactOnMachine[];
  code: number;
  chunk: number;
  down: boolean;
  // A machine that answers, and what it says is that it cannot list.
  listingFails?: string;
}

// The machine's answer for one Run's artifacts, as a transport hands it over: data, read
// from the machine's own words by that transport.
function fake(files: Record<string, Buffer>, options: { tamper?: string; chunk?: number; listed?: ArtifactOnMachine[]; code?: number } = {}): Fake {
  const state: Fake = {
    reads: [],
    chunk: options.chunk ?? 1 << 20,
    code: options.code ?? 0,
    down: false,
    listed: options.listed ?? Object.entries(files).map(([name, body]) => ({
      name,
      sha256: sum(name === options.tamper ? Buffer.from('换过的内容') : body),
      bytes: body.length,
    })),
    host: {
      async place() {
        if (state.down) throw new Unreachable('连不上 h1');
        return [];
      },
      async start() {
        if (state.down) throw new Unreachable('连不上 h1');
        return { code: 0, stdout: '', stderr: '', confirmed: true };
      },
      async stop() {
        if (state.down) throw new Unreachable('连不上 h1');
      },
      async state() {
        if (state.down) throw new Unreachable('连不上 h1');
        return { started: false, launcher_alive: false, pid_alive: false, marked: false, exit: null, unknown: null };
      },
      async list() {
        if (state.down) throw new Unreachable('连不上 h1');
        return [];
      },
      async artifacts() {
        if (state.down) throw new Unreachable('连不上 h1');
        if (state.listingFails !== undefined) throw new ListingFailed(state.listingFails);
        if (state.code !== 0) throw new ListingFailed(`artifacts.sh 退出码 ${state.code}：算不出哈希`);
        return state.listed;
      },
      async dropRun() {},
      connected: () => true,
      async readRange(path, offset) {
        state.reads.push([path, offset]);
        if (state.down) throw new Unreachable('连不上 h1');
        const body = files[basename(path)];
        if (!body) return { bytes: Buffer.alloc(0), size: 0, mtime: 0 };
        return { bytes: body.subarray(offset, offset + state.chunk), size: body.length, mtime: 1 };
      },
    },
  };
  return state;
}

function runnerOn(f: Fixture, state: Fake) {
  const { run } = f.runningRun();
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger,
    adapters: {},
    logins: memoryLogins({ own: { ...Object.values(ACCOUNTS)[0]!, id: f.login.login.id, name: f.login.login.name } }),
    machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => state.host,
  });
  return { run, runner };
}

test('报告预览只沿原节点读取选中文件，不扫描相邻产物、不登记', async (t) => {
  const f = fixture(t);
  const body = Buffer.from('本轮报告内容');
  const state = fake({ 'report.md': body });
  state.host.artifacts = async () => { throw new Error('预览不应扫描产物目录'); };
  const read = state.host.readRange;
  state.host.readRange = async (path, offset, options) => {
    assert.deepEqual(options, { fileLimitBytes: 128 * 1024 });
    return read(path, offset);
  };
  const { run, runner } = runnerOn(f, state);
  const before = f.ledger.artifactsOfRun(run.id);
  assert.deepEqual(await runner.readReportFile(run, 'report.md', 128 * 1024), body);
  assert.equal(state.reads.length, 1);
  assert.ok(state.reads.every(([path]) => path === `.tycho/tasks/${run.task_id}/runs/${run.id}/artifacts/report.md`));
  assert.deepEqual(f.ledger.artifactsOfRun(run.id), before);
});

test('报告预览复核传输的大小，拒绝过大文件、缺件、短读及失联', async (t) => {
  const f = fixture(t);
  const state = fake({ 'report.md': Buffer.from('report') });
  const { run, runner } = runnerOn(f, state);
  await assert.rejects(runner.readReportFile(run, 'report.md', 2), /上限/);
  assert.equal(state.reads.length, 1, '节点返回的整份大小在主机再次核对，超过上限不展示');
  await assert.rejects(runner.readReportFile(run, 'missing.md', 128 * 1024), /没有这份报告/);
  state.chunk = 2;
  await assert.rejects(runner.readReportFile(run, 'report.md', 128 * 1024), /未能完整读取/);
  state.down = true;
  await assert.rejects(runner.readReportFile(run, 'report.md', 128 * 1024), /连不上/);
});

test('报告预览在节点重新登记前后均不接受旧轮次的读取结果', async (t) => {
  const f = fixture(t);
  const state = fake({ 'report.md': Buffer.from('report') }, { chunk: 2 });
  const { run, runner } = runnerOn(f, state);
  const read = state.host.readRange;
  state.host.readRange = async (...args) => {
    const answer = await read(...args);
    f.force('UPDATE machine SET uid=? WHERE id=?', 'new-machine-registration', run.machine_id!);
    return answer;
  };
  await assert.rejects(runner.readReportFile(run, 'report.md', 128 * 1024), /重新登记/);
  const reads = state.reads.length;
  await assert.rejects(runner.readReportFile(run, 'report.md', 128 * 1024), /重新登记/);
  assert.equal(state.reads.length, reads);
});

test('产物：按机器给的哈希取回，分几次读完，写进给定的目录', async (t) => {
  const f = fixture(t);
  const body = Buffer.from('Ty'.repeat(4096));
  const state = fake({ 'tycho-1.2.0.tar.gz': body }, { chunk: 1024 });
  const { run, runner } = runnerOn(f, state);
  const into = join(tempDir(t), 'releases', run.id);
  const { files, problem } = await runner.fetchArtifacts(run, into);
  assert.equal(problem, null);
  assert.deepEqual(files, [{ name: 'tycho-1.2.0.tar.gz', sha256: sum(body), bytes: body.length }]);
  assert.equal(readFileSync(join(into, 'tycho-1.2.0.tar.gz')).equals(body), true);
  assert.ok(state.reads.length > 1, '大文件要分几次读');
  assert.deepEqual(state.reads.map(([, offset]) => offset), [0, 1024, 2048, 3072, 4096, 5120, 6144, 7168]);
});

test('产物：取回来的字节和机器上的哈希对不上，不留下它，并说清是哪一个', async (t) => {
  const f = fixture(t);
  const state = fake({ 'good.bundle': Buffer.from('good'), 'bad.bundle': Buffer.from('bad') }, { tamper: 'bad.bundle' });
  const { run, runner } = runnerOn(f, state);
  const into = join(tempDir(t), 'releases', run.id);
  const { files, problem } = await runner.fetchArtifacts(run, into);
  assert.deepEqual(files.map((file) => file.name), ['good.bundle']);
  assert.match(problem!, /bad\.bundle 取回来和机器上的对不上，没有留下/);
  assert.deepEqual(readdirSync(into), ['good.bundle']);
});

test('产物：机器没算出哈希、名字指到目录之外或当不了文件名、同一个名字列了两次，都整份不取', async (t) => {
  const f = fixture(t);
  const into = join(tempDir(t), 'releases', 'x');
  const a = { sha256: sum(Buffer.from('a')), bytes: 1 };
  const refused = async (listed: ArtifactOnMachine[], problem: RegExp): Promise<void> => {
    const { runner, run } = runnerOn(f, fake({ 'a.bin': Buffer.from('a') }, { listed }));
    const fetched = await runner.fetchArtifacts(run, into);
    assert.deepEqual(fetched.files, []);
    assert.match(fetched.problem!, problem);
  };

  const failing = runnerOn(f, fake({ 'a.bin': Buffer.from('a') }, { code: 3 }));
  assert.match((await failing.runner.fetchArtifacts(failing.run, into)).problem!, /算不出哈希/);

  // Every way a name can break the rule, each refusing the whole listing and saying the rule.
  for (const name of ['../outside.bin', `${'x'.repeat(252)}.bin`, 'my work.bundle', 'a+b.bundle', '报告.txt', '.hidden', '_x.bin', 'trailing.', 'NUL', 'nul.bundle', 'Com1.txt', 'LPT9']) {
    await refused([{ name: 'a.bin', ...a }, { name, ...a }], new RegExp(`文件名不能用：${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}。${ARTIFACT_NAME_RULE}`));
  }
  await refused([{ name: 'a.bin', ...a }, { name: 'a.bin', ...a }], /产物清单损坏：a\.bin 列了两次/);
  await refused([{ name: 'a.bin', ...a }, { name: 'A.bin', ...a }], /产物清单里 a\.bin 和 A\.bin 在主机上会是同一个文件/);
  await refused([{ name: 'a.bin', sha256: a.sha256, bytes: 2 ** 60 }], /产物清单损坏：a\.bin 的大小不对/);
});

test('产物名：字母数字开头、只有 . _ -、不以点结尾、不是设备名、不超过 255 字节的都能用', () => {
  for (const name of ['a', 'tycho-1.2.0.tar.gz', 'my_work.bundle', 'A1-b.c', 'console.log', 'nulls.txt', 'com10', 'x'.repeat(255)]) {
    assert.equal(artifactNameIsUsable(name), true, name);
  }
  assert.equal(artifactNameIsUsable('x'.repeat(256)), false);
});

// The failure this guards: a machine that answered — only that its listing is damaged —
// recorded as one that could not be reached, shown as away and kept off new rounds for the
// cooldown. The channel says it as ListingFailed, and the Runner keeps the machine in
// contact.
test('清单坏了不算机器失联：机器客户端答"做不到"是 ListingFailed，先给原话', async () => {
  const damaged = '产物清单损坏：文件名里有换行';
  const nodes = {
    send: async () => {
      throw new NodeRefused(damaged);
    },
    connected: () => true,
    lastSeen: () => null,
    reportedExecutors: () => null,
    askExecutors: async () => null,
  } as unknown as NodeChannelOptions['nodes'];
  const channel = createNodeChannel({ nodes });
  await assert.rejects(() => channel.for('m1').artifacts('.tycho/tasks/t1/runs/r1'),
    (err: Error) => err instanceof ListingFailed && err.message === damaged);
});

test('文件报告用旧节点不认识的命令安全拒绝，普通输出仍沿原命令读', async () => {
  const kinds: string[] = [];
  const nodes = {
    send: async (_machine: string, command: { kind: string }) => {
      kinds.push(command.kind);
      if (command.kind === 'read_output') return { base64: Buffer.from('ordinary log').toString('base64'), size: 12, mtime: 1 };
      throw new NodeRefused('主机发来一条不认识的命令：' + JSON.stringify(command));
    },
    connected: () => true, lastSeen: () => null, reportedExecutors: () => null, askExecutors: async () => null,
  } as unknown as NodeChannelOptions['nodes'];
  const host = createNodeChannel({ nodes }).for('m1');
  await assert.rejects(host.readRange('.tycho/tasks/t1/runs/r1/artifacts/report.md', 0, { fileLimitBytes: 131072 }), /节点需升级/);
  assert.equal((await host.readRange('.tycho/tasks/t1/runs/r1/stdout.ndjson', 0)).bytes.toString(), 'ordinary log');
  assert.deepEqual(kinds, ['read_file', 'read_output']);
});

test('受限文件读取保留节点真正拒绝原因，不把文件错误说成节点需升级', async () => {
  const reason = '路径包含链接，不能读取这一轮的文件';
  const nodes = {
    send: async () => { throw new NodeRefused(reason); },
    connected: () => true, lastSeen: () => null, reportedExecutors: () => null, askExecutors: async () => null,
  } as unknown as NodeChannelOptions['nodes'];
  const host = createNodeChannel({ nodes }).for('m1');
  await assert.rejects(host.readRange('.tycho/tasks/t1/runs/r1/artifacts/report.md', 0, { fileLimitBytes: 131072 }),
    (error: Error) => error instanceof ListingFailed && error.message === reason);
});

test('清单坏了之后，机器在页面上仍是联系中，也不进冷却', async (t) => {
  const f = fixture(t);
  const state = fake({ 'a.bin': Buffer.from('a') });
  const { run, runner } = runnerOn(f, state);
  // It has answered once.
  assert.equal((await runner.fetchArtifacts(run, join(tempDir(t), 'releases', 'ok'))).problem, null);
  state.listingFails = '产物清单损坏：文件名里有换行';
  const { files, problem } = await runner.fetchArtifacts(run, join(tempDir(t), 'releases', 'bad'));
  assert.deepEqual(files, []);
  assert.match(problem!, /产物清单损坏：文件名里有换行/);
  const facts = runner.machines();
  assert.ok(facts.length > 0, '页面上有这台机器');
  for (const fact of facts) assert.equal(fact.up, true, `机器答了，不是失联：${JSON.stringify(fact)}`);
});

test('产物：没有产物目录就是没有产物，不建目录也不报错', async (t) => {
  const f = fixture(t);
  const state = fake({}, { listed: [] });
  const { run, runner } = runnerOn(f, state);
  const into = join(tempDir(t), 'releases', run.id);
  assert.deepEqual(await runner.fetchArtifacts(run, into), { files: [], problem: null });
});

test('产物：机器连不上时如实报告，不抛给验收', async (t) => {
  const f = fixture(t);
  const state = fake({ 'a.bin': Buffer.from('a') });
  state.down = true;
  const { run, runner } = runnerOn(f, state);
  const { files, problem } = await runner.fetchArtifacts(run, join(tempDir(t), 'releases', run.id));
  assert.deepEqual(files, []);
  assert.match(problem!, /连不上 h1/);
});

test('产物：一台机器上列出的东西太大就不取，剩下的照取', async (t) => {
  const f = fixture(t);
  const state = fake({ 'small.bin': Buffer.from('small') }, {
    listed: [
      { name: 'huge.bin', sha256: sum(Buffer.alloc(0)), bytes: 70 * 1024 * 1024 },
      { name: 'small.bin', sha256: sum(Buffer.from('small')), bytes: 5 },
    ],
  });
  const { run, runner } = runnerOn(f, state);
  const { files, problem } = await runner.fetchArtifacts(run, join(tempDir(t), 'releases', run.id));
  assert.deepEqual(files.map((file) => file.name), ['small.bin']);
  assert.match(problem!, /huge\.bin 太大/);
});

// What this catches: the limits being numbers of the runner's own, so a package larger than
// them could not be taken whatever the owner set, and a change waiting for a restart.
test('产物：单个文件和一轮总量的上限按设置，改了下一次取回就按新值', async (t) => {
  const f = fixture(t);
  const files = { 'a.bin': Buffer.from('aaaaaa'), 'b.bin': Buffer.from('bbbbbb') };
  const state = fake(files);
  const { run } = f.runningRun();
  const limits = { file: 5, total: 100 };
  const runner = createRunner({ ...RUNNER_TUNED,
    artifactFileLimitBytes: () => limits.file,
    artifactsLimitBytes: () => limits.total,
    ledger: f.ledger, adapters: {}, logins: memoryLogins({ own: f.login.login }),
    machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => state.host,
  });
  const fetched = () => runner.fetchArtifacts(run, join(tempDir(t), 'releases', run.id, String(Math.random())));
  const tooBig = await fetched();
  assert.deepEqual(tooBig.files, [], '6 字节超过单个文件 5 字节的上限');
  assert.match(tooBig.problem!, /a\.bin 太大/);
  limits.file = 10;
  assert.deepEqual((await fetched()).files.map((file) => file.name), ['a.bin', 'b.bin'], '调大以后两个都取');
  limits.total = 8;
  const capped = await fetched();
  assert.deepEqual(capped.files.map((file) => file.name), ['a.bin'], '一轮总量 8 字节：第二个就超了');
  assert.match(capped.problem!, /b\.bin 太大/);
});

// The help says this: over the total, a file is skipped and named, and a later one that
// still fits is taken.
test('产物：放不进一轮总量的那个跳过并写明，后面放得下的照取', async (t) => {
  const f = fixture(t);
  const state = fake({ 'a.bin': Buffer.from('aaaaaa'), 'b.bin': Buffer.from('bbbbbb'), 'c.bin': Buffer.from('c') });
  const { run } = f.runningRun();
  const runner = createRunner({ ...RUNNER_TUNED,
    artifactFileLimitBytes: () => 100,
    artifactsLimitBytes: () => 8,
    ledger: f.ledger, adapters: {}, logins: memoryLogins({ own: f.login.login }),
    machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => state.host,
  });
  const { files, problem } = await runner.fetchArtifacts(run, join(tempDir(t), 'releases', run.id));
  assert.deepEqual(files.map((file) => file.name), ['a.bin', 'c.bin']);
  assert.match(problem!, /b\.bin 太大/);
});
