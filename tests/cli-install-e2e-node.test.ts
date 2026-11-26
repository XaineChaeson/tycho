// Guards downloaded Node authenticity, version and installed launcher behavior.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { parseLauncher } from '../cli/launcher.ts';
import { until } from './cli-helpers.ts';
import { WINDOWS, TAR, VERSION, NOWHERE, sandbox, variant, sharedArchive, pathWithoutNode } from './cli-install-e2e-fixture.ts';
import type { Sandbox } from './cli-install-e2e-fixture.ts';

// ---- A machine without Node: the installer brings one, if its checksum holds ----

const NODE_OS = WINDOWS ? 'win' : process.platform;
const NODE_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const NODE_NAME = `node-v99.0.0-${NODE_OS}-${NODE_ARCH}`;

interface NodeDist {
  // What TYCHO_NODE_DIST_URL and TYCHO_NODE_SUMS_URL are pointed at.
  mirror: string;
  sums: string;
  asked: string[];
}

let nodeArchive: Buffer | undefined;

// Stands in for two places at once: nodejs.org, which says which package is the right
// one, and a mirror, which serves this very Node under a made-up version together with
// a checksum file of its own that always matches what it serves.
async function nodeDist(t: TestContext, dir: string, options: { official: 'agrees' | 'differs' }): Promise<NodeDist> {
  const scratch = join(dir, 'dist-node');
  const file = `${NODE_NAME}.${WINDOWS ? 'zip' : 'tar.gz'}`;
  if (!nodeArchive) {
    mkdirSync(join(scratch, NODE_NAME, WINDOWS ? '.' : 'bin'), { recursive: true });
    copyFileSync(process.execPath, join(scratch, NODE_NAME, WINDOWS ? 'node.exe' : join('bin', 'node')));
    const packed = spawnSync(TAR, WINDOWS ? ['-a', '-cf', file, NODE_NAME] : ['-czf', file, NODE_NAME], { cwd: scratch, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    nodeArchive = readFileSync(join(scratch, file));
  }
  const body = nodeArchive;
  const served = createHash('sha256').update(body).digest('hex');
  const sums = (sha: string): string =>
    [`${'a'.repeat(64)}  node-v99.0.0-aix-ppc64.tar.gz`, `${sha}  ${file}`, `${'b'.repeat(64)}  node-v99.0.0.pkg`, ''].join('\n');
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? '');
    const text = (content: string): void => void response.writeHead(200, { 'content-type': 'text/plain' }).end(content);
    if (request.url === '/official/SHASUMS256.txt') text(sums(options.official === 'agrees' ? served : '0'.repeat(64)));
    else if (request.url === '/mirror/SHASUMS256.txt') text(sums(served));
    else if (request.url === `/mirror/${file}`) response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
    else response.writeHead(404).end();
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { mirror: `${base}/mirror`, sums: `${base}/official/SHASUMS256.txt`, asked };
}

function useDist(s: Sandbox, dist: NodeDist): void {
  s.env.TYCHO_NODE_DIST_URL = dist.mirror;
  s.env.TYCHO_NODE_SUMS_URL = dist.sums;
}

test('没有 Node 时：下载官方发行版，校验通过才装；装好的 tycho 用的就是这一份', async (t) => {
  const s = sandbox(t);
  const archive = sharedArchive(t);
  const dist = await nodeDist(t, s.dir, { official: 'agrees' });
  useDist(s, dist);
  s.env.PATH = pathWithoutNode(s.dir);
  const ran = await s.install(archive);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.deepEqual(dist.asked, ['/official/SHASUMS256.txt', `/mirror/${NODE_NAME}.${WINDOWS ? 'zip' : 'tar.gz'}`], '镜像只被要过包本身');
  const own = join(s.prefix, 'node', WINDOWS ? 'node.exe' : join('bin', 'node'));
  assert.ok(existsSync(own));
  assert.deepEqual(parseLauncher(readFileSync(join(s.prefix, 'bin', WINDOWS ? 'tycho.cmd' : 'tycho'), 'utf8')), { node: own });
  assert.deepEqual(readdirSync(s.prefix).sort(), ['bin', 'current', 'install.json', 'node', 'versions'], '下载用的临时目录要清掉');
  const version = await s.tycho('version');
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), `tycho ${VERSION}`);

  // A second run finds the one it brought and downloads nothing.
  s.env.TYCHO_NODE_DIST_URL = NOWHERE;
  s.env.TYCHO_NODE_SUMS_URL = NOWHERE;
  assert.equal((await s.install(archive)).code, 0);

  // Windows will not delete a program that is running, and here that is the Node
  // running the uninstall: what is left goes once the command has ended.
  mkdirSync(s.dataDir, { recursive: true });
  writeFileSync(join(s.dataDir, 'ledger.db'), '账本');
  const removed = await s.tycho('uninstall');
  assert.equal(removed.code, 0, removed.stdout + removed.stderr);
  await until('程序目录删干净', () => !existsSync(s.prefix), 30_000);
  assert.equal(readFileSync(join(s.dataDir, 'ledger.db'), 'utf8'), '账本');
});

test('没有 Node 时：包对不上官方的校验值就停下，什么都不装——镜像自己的校验文件说对也没用', async (t) => {
  const s = sandbox(t);
  const archive = sharedArchive(t);
  // The mirror changed the package and serves a checksum file that matches its own.
  const dist = await nodeDist(t, s.dir, { official: 'differs' });
  useDist(s, dist);
  s.env.PATH = pathWithoutNode(s.dir);
  const ran = await s.install(archive);
  assert.notEqual(ran.code, 0);
  assert.match(ran.stdout + ran.stderr, WINDOWS ? /failed its checksum/ : /校验不过/);
  assert.equal(dist.asked.includes('/mirror/SHASUMS256.txt'), false, '哪个包是对的，不问镜像');
  assert.equal(existsSync(join(s.prefix, 'node')), false);
  assert.equal(existsSync(join(s.prefix, 'current')), false);
  assert.deepEqual(readdirSync(s.prefix), ['versions']);
  assert.deepEqual(s.versions(), []);
});

test('下载到的 Node 也按发布包的要求复核：不够新就不装', async (t) => {
  const s = sandbox(t);
  const archive = sharedArchive(t);
  // Served as v99.0.0 and passing its checksum, but really the Node running this test.
  useDist(s, await nodeDist(t, s.dir, { official: 'agrees' }));
  const ran = await s.install(variant(s.dir, archive, '93.0.0', '>=99.0.0'));
  assert.notEqual(ran.code, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout + ran.stderr, WINDOWS ? /older than the Node 99\.0\.0/ : /低于 tycho 要求的 Node 99\.0\.0/);
  assert.equal(existsSync(join(s.prefix, 'node')), false, '不合格的 Node 不该留在程序目录里');
  assert.equal(existsSync(join(s.prefix, 'current')), false);
  assert.deepEqual(readdirSync(s.prefix), ['versions']);
  assert.deepEqual(s.versions(), []);
});
