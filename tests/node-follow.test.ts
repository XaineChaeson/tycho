// Guards how a machine's client follows the host's version (docs/design/nodes.md §1.4).
//
// What this file is here to catch:
//   - a client that installs over the host's own installation and takes its service with it,
//   - a client that moves to a new version while a round, a command or a sign-in is still
//     running, or that reads "cannot tell whether the round is over" as idle,
//   - a package that is installed without the digest and size the host answered with,
//   - a failed install retried in a tight loop, or a 426 that exits the process instead of
//     moving to the host's version,
//   - a client already on the host's version that treats a 426 as a version problem.
import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { appVersion } from '../cli/paths.ts';
import { boxOf, writeExit, writeLeft } from '../node/runbox.ts';
import { busyRuns, createClient, NodeHttpError, writeToken } from '../node/client.ts';
import type { HostProcesses } from '../node/hostprocess.ts';
import { createReleaseFollow } from '../node/follow.ts';
import type { ReleaseBusy } from '../node/follow.ts';
import type { NodeFacts } from '../shared/node-protocol.ts';
import { NODE_RELEASE_PACKAGE_PATH, NODE_RELEASE_PATH } from '../shared/node-protocol.ts';
import { REPO, tempDir } from './cli-helpers.ts';

const FACTS: NodeFacts = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'test', hostname: 'mac-mini-01.local' };
const IDLE: ReleaseBusy = { runs: 0, commands: 0, signIns: 0 };

interface Layout {
  dir: string;
  prefix: string;
  appRoot: string;
  identityDir: string;
}

// An installed layout: <prefix>/versions/<own> holding package.json, with `current` naming it.
function installed(t: TestContext, own = '0.1.100'): Layout {
  const dir = tempDir(t, 'tycho-follow-');
  const prefix = join(dir, 'prefix');
  const appRoot = join(prefix, 'versions', own);
  mkdirSync(join(appRoot, 'cli'), { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'tycho', version: own, type: 'module' }));
  writeFileSync(join(appRoot, 'cli', 'main.ts'), '// the installed client\n');
  writeFileSync(join(prefix, 'current'), own);
  const identityDir = join(dir, 'identity');
  mkdirSync(identityDir, { recursive: true });
  return { dir, prefix, appRoot, identityDir };
}

// The same, from a source checkout: no versions directory above it, so no prefix and no
// installation to put a package in.
function checkout(t: TestContext, own = '0.1.100'): Layout {
  const dir = tempDir(t, 'tycho-follow-');
  const appRoot = join(dir, 'checkout');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'tycho', version: own, type: 'module' }));
  const identityDir = join(dir, 'identity');
  mkdirSync(identityDir, { recursive: true });
  return { dir, prefix: '', appRoot, identityDir };
}

interface HostAnswer {
  version: string;
  package?: { sha256: string; bytes: number } | null;
  why?: string | null;
  check_every_ms?: number;
}

// A host that only has the two frozen routes: what the release answer says, and the package
// bytes when the client fetches them.
function fakeHost(answer: HostAnswer, body?: Buffer) {
  const calls = { release: 0, package: 0, poll: 0, reports: [] as { version: string; upgrade: unknown }[] };
  const pkg = body === undefined ? null : { sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(NODE_RELEASE_PACKAGE_PATH)) {
      calls.package += 1;
      if (pkg === null) return new Response('没有包', { status: 409 });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/gzip' } });
    }
    if (url.endsWith(NODE_RELEASE_PATH)) {
      calls.release += 1;
      calls.reports.push(JSON.parse(String(init?.body ?? '{}')) as { version: string; upgrade: unknown });
      return Response.json({
        version: answer.version,
        package: answer.package === undefined ? pkg : answer.package,
        why: answer.why ?? null,
        check_every_ms: answer.check_every_ms ?? 3_600_000,
      });
    }
    if (url.endsWith('/api/node/poll')) {
      calls.poll += 1;
      return Response.json({ error: '协议版本不符：这台机器上的客户端是第 4 版，主机是第 5 版。升级落后的那一个（tycho update），再重试。' }, { status: 426 });
    }
    throw new Error(`这个测试不去问 ${url}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function followOf(layout: Layout, host: ReturnType<typeof fakeHost>, busy: ReleaseBusy = { runs: 0, commands: 0, signIns: 0 }, update = async (_entry: string, _args: string[]) => ({ code: 0, tail: '' })) {
  let stopped = false;
  const follow = createReleaseFollow({
    appRoot: layout.appRoot,
    identityDir: layout.identityDir,
    origin: 'http://host.invalid',
    token: 'f'.repeat(64),
    log: () => {},
    busy: async () => busy,
    stopPolling: () => {
      stopped = true;
    },
    fetch: host.fetch,
    update,
  });
  return { follow, stopped: () => stopped };
}

test('客户端就是主机那一版：什么都不装，也不报换版', async (t) => {
  const layout = installed(t, '0.1.100');
  const host = fakeHost({ version: '0.1.100' });
  let updated = 0;
  const { follow } = followOf(layout, host, undefined, async () => {
    updated += 1;
    return { code: 0, tail: '' };
  });
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(updated, 0, '不装任何东西');
  assert.equal(follow.status().upgrade, null, '报 null');
  assert.equal(follow.swapped(), false);
  assert.equal(host.calls.package, 0);
});

test('源码目录里跑的客户端：不装，报换版没成功并说清原因', async (t) => {
  const layout = checkout(t);
  const host = fakeHost({ version: '0.1.200' });
  const { follow } = followOf(layout, host);
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(follow.status().upgrade?.state, 'failed');
  assert.match(follow.status().upgrade?.detail ?? '', /源码目录/);
  assert.ok(host.calls.release >= 1, '问过主机');
});

test('current 已经是目标版本：不装，等空闲后退出 75', async (t) => {
  const layout = installed(t, '0.1.100');
  writeFileSync(join(layout.prefix, 'current'), '0.1.200');
  const host = fakeHost({ version: '0.1.200', package: null, why: '测试不打包' });
  const busy: ReleaseBusy = { runs: 0, commands: 0, signIns: 0 };
  const { follow, stopped } = followOf(layout, host, busy);
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(follow.status().upgrade?.state, 'waiting');
  assert.equal(host.calls.package, 0, '不用取包');
  assert.equal(follow.swapTarget(), '0.1.200', '已就绪：current 是目标版本');
  await follow.afterPoll(IDLE);
  assert.equal(follow.status().upgrade?.detail, '现在换到 0.1.200');
  follow.swapNow();
  assert.equal(follow.swapped(), true, '空闲时换版本');
  assert.equal(stopped(), true, '换版本时停下 poll');
  assert.equal(follow.status().upgrade?.detail, '现在换到 0.1.200');
  assert.equal(follow.status().upgrade?.state, 'waiting');
});

// The three things that are not idle. The round with `alive: null` is covered by busyRuns
// below: this is the follow loop's own reading of the three numbers it is given.
for (const [name, busy, detail] of [
  ['活的轮次', { runs: 2, commands: 0, signIns: 0 }, /等 2 轮跑完后换到 0\.1\.200/],
  ['正在执行的命令', { runs: 0, commands: 1, signIns: 0 }, /等手头的命令做完/],
  ['正在进行的机器登录', { runs: 0, commands: 0, signIns: 1 }, /等机器上的登录结束/],
] as const) {
  test(`${name}：不换，等它们结束`, async (t) => {
    const layout = installed(t, '0.1.100');
    writeFileSync(join(layout.prefix, 'current'), '0.1.200');
    const host = fakeHost({ version: '0.1.200' });
    const { follow } = followOf(layout, host, { ...busy });
    t.after(() => follow.stop());
    await follow.start();
    await follow.afterPoll(busy);
    assert.equal(follow.swapped(), false, '忙的时候不换');
    assert.match(follow.status().upgrade?.detail ?? '', detail);
  });
}

test('这份安装也装着主机：不装，等主机的升级把 current 带过来', async (t) => {
  const layout = installed(t, '0.1.100');
  writeFileSync(join(layout.prefix, 'install.json'), JSON.stringify({ files: [], paths: [], autostart: { host: { dataDir: join(layout.dir, 'data') } } }));
  const pkg = Buffer.from('package-b');
  const sha = createHash('sha256').update(pkg).digest('hex');
  const host = fakeHost({ version: '0.1.200', package: { sha256: sha, bytes: pkg.length } }, pkg);
  const { follow } = followOf(layout, host);
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(follow.status().upgrade?.state, 'waiting');
  assert.match(follow.status().upgrade?.detail ?? '', /这份安装上的主机升级后跟上/);
  assert.equal(host.calls.package, 0, '装着主机就绝不在它下面装一份');
  // The host's own upgrade moves `current`; the client then only waits for idle.
  writeFileSync(join(layout.prefix, 'current'), '0.1.200');
  await follow.afterPoll(IDLE);
  assert.equal(follow.swapTarget(), '0.1.200', 'current 跟上了就是就绪');
  follow.swapNow();
  assert.equal(follow.swapped(), true);
});

test('主机没有可下发的发布包：报换版没成功，用主机给的原因', async (t) => {
  const layout = installed(t, '0.1.100');
  const host = fakeHost({ version: '0.1.200', package: null, why: '主机从源码目录运行，没有可下发的发布包' });
  const { follow } = followOf(layout, host);
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(follow.status().upgrade?.state, 'failed');
  assert.equal(follow.status().upgrade?.detail, '主机从源码目录运行，没有可下发的发布包');
});

test('取包、核字节数和 sha256、用 current 那一版自己 update：成功后等空闲', async (t) => {
  const layout = installed(t, '0.1.100');
  const pkg = Buffer.from('the package bytes');
  const sha = createHash('sha256').update(pkg).digest('hex');
  const host = fakeHost({ version: '0.1.200', package: { sha256: sha, bytes: pkg.length } }, pkg);
  const ran: string[][] = [];
  let sawFile = '';
  const { follow } = followOf(layout, host, undefined, async (_entry, args) => {
    ran.push(args);
    // The package the client downloaded is there when update runs, and gone afterwards.
    const at = args.indexOf('--from');
    sawFile = at === -1 ? '' : args[at + 1]!;
    assert.equal(existsSync(sawFile), true, '更新时包还在');
    writeFileSync(join(layout.prefix, 'current'), '0.1.200');
    return { code: 0, tail: '' };
  });
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0]!.slice(0, 2), ['update', '--from']);
  assert.ok(ran[0]!.includes('--expect-version') && ran[0]!.includes('0.1.200'));
  assert.ok(ran[0]!.includes('--expect-sha256') && ran[0]!.includes(sha));
  assert.equal(sawFile, join(layout.identityDir, 'release', '0.1.200.tar.gz'));
  assert.equal(existsSync(sawFile), false, '装完删掉下载的包');
  assert.equal(follow.status().upgrade?.state, 'waiting');
  await follow.afterPoll(IDLE);
  assert.equal(follow.swapTarget(), '0.1.200');
  follow.swapNow();
  assert.equal(follow.swapped(), true);
});

test('包里的字节和主机说的不一致：不运行更新', async (t) => {
  const layout = installed(t, '0.1.100');
  const pkg = Buffer.from('the package bytes');
  const host = fakeHost({ version: '0.1.200', package: { sha256: 'a'.repeat(64), bytes: pkg.length } }, pkg);
  let updated = 0;
  const { follow } = followOf(layout, host, undefined, async () => {
    updated += 1;
    return { code: 0, tail: '' };
  });
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(updated, 0, '摘要不对就不交给更新程序');
  assert.equal(follow.status().upgrade?.state, 'failed');
  assert.match(follow.status().upgrade?.detail ?? '', /发布包不对/);
});

test('更新失败：报最后一行，下载的包删掉，同一个目标不立刻重试', async (t) => {
  const layout = installed(t, '0.1.100');
  const pkg = Buffer.from('bytes');
  const sha = createHash('sha256').update(pkg).digest('hex');
  const host = fakeHost({ version: '0.1.200', package: { sha256: sha, bytes: pkg.length }, check_every_ms: 3_600_000 }, pkg);
  let attempts = 0;
  const { follow } = followOf(layout, host, undefined, async () => {
    attempts += 1;
    return { code: 1, tail: '磁盘满了：什么都没换' };
  });
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(follow.status().upgrade?.state, 'failed');
  assert.equal(follow.status().upgrade?.detail, '磁盘满了：什么都没换');
  assert.equal(existsSync(join(layout.identityDir, 'release', '0.1.200.tar.gz')), false);
  await follow.start();
  assert.equal(attempts, 1, '同一个目标失败后等下一次检查');
});

test('更新退出 0 但 current 没变：也算没换成', async (t) => {
  const layout = installed(t, '0.1.100');
  const pkg = Buffer.from('bytes');
  const sha = createHash('sha256').update(pkg).digest('hex');
  const host = fakeHost({ version: '0.1.200', package: { sha256: sha, bytes: pkg.length } }, pkg);
  const { follow } = followOf(layout, host, undefined, async () => ({ code: 0, tail: '' }));
  t.after(() => follow.stop());
  await follow.start();
  assert.equal(follow.status().upgrade?.state, 'failed');
  assert.match(follow.status().upgrade?.detail ?? '', /当前版本是 0\.1\.100/);
});

// ---- What "idle" counts (node/client.ts) ----

function processes(alive: boolean, start?: string): HostProcesses {
  return {
    alive: () => alive,
    startOf: async () => start,
    descendants: async () => undefined,
    tagged: async () => undefined,
    endTree: async () => {},
    endGroup: async () => {},
  };
}

test('说不清的一轮也算没结束：alive 为 null 时不算空闲', async (t) => {
  const dir = tempDir(t, 'tycho-busy-');
  const box = boxOf(dir, 'tasks/t1/runs/r1');
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  mkdirSync(box.procDir, { recursive: true });
  // The process table cannot be read: no evidence and no answer is "unknown", never "over".
  assert.equal(await busyRuns(dir, processes(false)), 1, '说不清也算不空');
  writeExit(box, 0);
  writeLeft(box, 'none');
  assert.equal(await busyRuns(dir, processes(false)), 0, '记下结束的一轮不挡换版本');
});

test('别的机器身份的轮次不挡这台机器换版本', async (t) => {
  const dir = tempDir(t, 'tycho-busy-');
  const box = boxOf(dir, 'tasks/t1/runs/r1');
  mkdirSync(join(box.runDir, 'started'), { recursive: true });
  // No procDir under this machine's scope: another machine sharing the data directory started it.
  assert.equal(await busyRuns(dir, processes(false)), 0);
});

// ---- 426 ----

function fakeClientFetch(answer: HostAnswer, body?: Buffer) {
  const host = fakeHost(answer, body);
  return host;
}

function clientBench(t: TestContext, host: ReturnType<typeof fakeHost>) {
  const dataDir = tempDir(t, 'tycho-426-');
  const identityDir = join(dataDir, 'identity');
  mkdirSync(identityDir, { recursive: true });
  writeToken({ id: 'a1b2c3d4e5f60718', dir: identityDir, dataDir }, 'f'.repeat(64));
  const client = createClient({
    dataDir,
    origin: 'http://host.invalid',
    token: 'f'.repeat(64),
    facts: FACTS,
    procs: processes(false),
    log: () => {},
    fetch: host.fetch,
    lookupEnv: async () => ({ env: {} }),
    executors: { questions: [] },
    release: { identityDir, fetch: host.fetch },
  });
  return { client, dataDir };
}

test('426 且版本不一致：不再让整个进程报错退出，空闲后换版本', async (t) => {
  const target = appVersion(REPO);
  const host = fakeClientFetch({ version: `${target}-1`, check_every_ms: 100 });
  const { client } = clientBench(t, host);
  await client.run();
  assert.equal(client.swapRequested(), true, '换了版本，不是报错退出');
  assert.equal(host.calls.poll, 1, '停掉 poll，不再重发');
});

test('426 但版本一样：不是版本问题，照原来的报错', async (t) => {
  const own = appVersion(REPO);
  const host = fakeClientFetch({ version: own });
  const { client } = clientBench(t, host);
  await assert.rejects(() => client.run(), (error: unknown) => error instanceof NodeHttpError && error.status === 426);
  assert.equal(client.swapRequested(), false);
});
