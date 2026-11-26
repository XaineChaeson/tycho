// Guards the whole shape of docs/design/nodes.md §1.4 in one run: a machine installed with
// version A and started under its supervisor follows a host that runs version B, downloads B's
// package from the host, installs it, and — once idle — leaves with 75 so the supervisor starts
// B. The supervisor is the same process throughout.
//
// What this file is here to catch:
//   - a client that never notices the host is another version (or notices and does nothing),
//   - a download installed without the host's digest, or one that leaves the package behind,
//   - a swap that stops the supervisor or changes its pid,
//   - a client.json still naming A after the machine has moved to B.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { appVersion } from '../cli/paths.ts';
import { realSystem } from '../cli/system.ts';
import { createNodeReleases } from '../service/node-release.ts';
import { identityOf, writeToken } from '../node/client.ts';
import { requestClientStop } from '../node/client.ts';
import { NODE_RELEASE_PACKAGE_PATH, NODE_RELEASE_PATH } from '../shared/node-protocol.ts';
import { endChild, exited, ownProcess, realApp, releaseRoot, tempDir, until } from './cli-helpers.ts';

const A = '0.1.100';
const B = '0.1.200';
const options = { timeout: 180_000 };

// This run is the whole chain with real processes, and the client's update command lists an
// archive by reading tar's output through a pipe. A machine whose sandbox refuses pipes to
// children cannot run that part (the same restriction makes the probe write files instead of
// capture them); what it guards is covered by tests/node-release.test.ts (the real package and
// a real `tycho update --from` installation) and tests/node-supervisor.test.ts (the exit-75
// cycle with real processes).
const PIPES = (() => {
  const ran = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', windowsHide: true });
  return ran.error === undefined && ran.stdout.trim() === 'ok';
})();

function environment(dir: string, prefix: string, dataDir: string): NodeJS.ProcessEnv {
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ...(process.platform === 'win32' ? { APPDATA: join(home, 'AppData', 'Roaming') } : {}),
    TYCHO_PREFIX: prefix,
    TYCHO_DATA: dataDir,
    TYCHO_NO_MODIFY_PATH: '1',
    // The client re-executes itself through --use-env-proxy when the environment names one:
    // this test only reaches 127.0.0.1, and its supervisor must stay the process it started.
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
  };
}

interface Report { version: string; upgrade: { state: string; target: string; detail: string } | null }
interface Host {
  origin: string;
  reports: Report[];
  polls: number;
  close(): Promise<void>;
}

async function hostWithPackage(t: TestContext, pkg: Buffer): Promise<Host> {
  const sha = createHash('sha256').update(pkg).digest('hex');
  const host: Host = {
    origin: '', reports: [], polls: 0,
    close: async () => {},
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '';
    const body: Buffer[] = [];
    request.on('data', (chunk: Buffer) => body.push(chunk));
    request.on('end', () => {
      const send = (status: number, type: string, text: string): void => {
        response.writeHead(status, { 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(text)) });
        response.end(text);
      };
      if (url.endsWith(NODE_RELEASE_PACKAGE_PATH)) {
        response.writeHead(200, {
          'Content-Type': 'application/gzip', 'Content-Length': String(pkg.length),
          'x-tycho-version': B, 'x-tycho-sha256': sha,
        });
        response.end(pkg);
        return;
      }
      if (url.endsWith(NODE_RELEASE_PATH)) {
        host.reports.push(JSON.parse(Buffer.concat(body).toString('utf8') || '{}') as Report);
        send(200, 'application/json', JSON.stringify({
          version: B, package: { sha256: sha, bytes: pkg.length }, why: null, check_every_ms: 200,
        }));
        return;
      }
      if (url.endsWith('/api/node/poll')) {
        host.polls += 1;
        // Held a moment, so the client is not spun in a loop while this test runs.
        setTimeout(() => send(200, 'application/json', JSON.stringify({ protocol: 5, command: null, look_every_ms: 600_000, sign_ins: [] })), 20);
        return;
      }
      if (url.endsWith('/api/node/status') || url.endsWith('/api/node/leave')) {
        send(200, 'application/json', '{"connected":true,"left":true}');
        return;
      }
      send(404, 'text/plain', `没有 ${url}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  host.origin = `http://127.0.0.1:${port}`;
  host.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  t.after(() => host.close());
  return host;
}

const clientFacts = (identityDir: string): { version?: string; pid?: number } => {
  try {
    return JSON.parse(readFileSync(join(identityDir, 'client.json'), 'utf8')) as { version?: string; pid?: number };
  } catch {
    return {};
  }
};

test('安装 A 的机器经看守跑着，连上给 B 的主机：自己装 B、空闲后换过去，看守不变', { ...options, skip: PIPES ? false : '这台机器的沙箱不给子进程接管道，update 列不了包；包和安装由 node-release.test.ts 真跑，退出 75 的循环由 node-supervisor.test.ts 真跑' }, async (t) => {
  const dir = tempDir(t, 'tycho-self-update-');
  const prefix = join(dir, 'prefix');
  const dataDir = join(dir, 'data');
  const env = environment(dir, prefix, dataDir);
  const source = releaseRoot(t);

  // A installed the way the installer does it: from a staging directory inside the prefix.
  const stagedA = realApp(join(prefix, 'versions', `.staging-${process.pid}-${A}`), A, { source });
  const installed = spawnSync(process.execPath, [join(stagedA, 'cli', 'main.ts'), 'install-self', '--prefix', prefix, '--node', process.execPath], {
    env, stdio: 'ignore', windowsHide: true,
  });
  assert.equal(installed.status, 0, '版本 A 装好了');
  assert.equal(appVersion(join(prefix, 'versions', A)), A);

  // B's package, packed by the host side from a version directory (a real tar).
  const builder = join(dir, 'builder');
  const releasedB = join(builder, 'versions', B);
  realApp(releasedB, B, { source });
  const releases = createNodeReleases({ appRoot: releasedB, dataDir, system: realSystem(), checkEveryMs: () => 200 });
  const answer = await releases.answer();
  assert.ok(answer.package, answer.why ?? '主机应当有 B 的包');
  const pkg = await releases.package();
  assert.ok('file' in pkg);
  const bytes = readFileSync(pkg.file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), answer.package.sha256);

  const host = await hostWithPackage(t, bytes);
  const identity = identityOf(dataDir);
  writeToken(identity, 'f'.repeat(64));
  const log = join(dir, 'client.log');
  const supervisor = spawn(process.execPath, [join(prefix, 'versions', A, 'cli', 'main.ts'), 'node', 'run', '--to', host.origin, '--log', log], {
    env, stdio: 'ignore', windowsHide: true,
  });
  ownProcess(t, () => endChild(supervisor));
  const supervisorPid = supervisor.pid!;

  // The client installed B, then left with 75 and the supervisor started B: client.json says B
  // and names another pid than the supervisor, which is the one that did not change.
  const diagnose = (): string => {
    const said = (() => { try { return readFileSync(log, 'utf8'); } catch { return '（没有客户端日志）'; } })();
    return `client.log:\n${said}\nhost reports: ${JSON.stringify(host.reports)}\ncurrent: ${(() => { try { return readFileSync(join(prefix, 'current'), 'utf8'); } catch { return '没有'; } })()}`;
  };
  try {
    await until('客户端换成 B', () => clientFacts(identity.dir).version === B, 120_000);
  } catch (err) {
    throw new Error(`${(err as Error).message}\n${diagnose()}`);
  }
  const moved = clientFacts(identity.dir);
  assert.equal(moved.version, B);
  assert.notEqual(moved.pid, supervisorPid, '客户端不是看守自己');
  assert.equal(supervisor.exitCode, null, '看守一直在');
  assert.equal(supervisor.signalCode, null);
  assert.equal(supervisor.pid, supervisorPid, '看守还是同一个进程');

  // The host heard A first, then B on the host's version.
  await until('B 报到主机', () => host.reports.some((report) => report.version === B && report.upgrade === null), 60_000);
  assert.ok(host.reports.some((report) => report.version === A), 'A 报过自己的版本');
  assert.ok(host.polls > 0, '客户端一直在问活');

  // B is the client now, and it lives under the same data directory and token.
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), B);

  // Stop it the way the owner would: the mark names the client, the supervisor then exits 0.
  requestClientStop(identity, moved.pid!);
  await until('客户端退出', () => clientFacts(identity.dir).pid === undefined, 30_000);
  assert.equal(await exited(supervisor), 0);
});
