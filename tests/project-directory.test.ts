import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createProjectDirectory, issueProjectDirectoryToken, listProjectDirectoryPeers, registerProjectDirectoryPeer, removeProjectDirectoryPeer, revokeProjectDirectoryToken } from '../service/project-directory.ts';
import { runCli } from '../cli/main.ts';
import { createProjectHome } from '../service/project-home.ts';
import { startService } from '../service/main.ts';
import { stage } from './cli-helpers.ts';
import { signIn } from './stage.ts';
import { DIRECTORY_FEED_PATH, type DirectoryFeed, type DirectoryView } from '../shared/project-directory.ts';

const SOURCE = 'tycho:' + 'a'.repeat(64);
const TARGET = 'tycho:' + 'b'.repeat(64);
const ID = '01J00000000000000000000000';
const feed = (service_id: string, generation = 1): DirectoryFeed => ({
  version: 1, service_id, projects: [{ id: ID, name: '回归项目', generation }],
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject).listen(0, '127.0.0.1', resolve); });
  const place = server.address();
  if (!place || typeof place === 'string') assert.fail('没有监听端口');
  return 'http://127.0.0.1:' + place.port;
}
const stop = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

function directories(t: TestContext, local: () => DirectoryFeed | null = () => feed(TARGET, 2)) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-directories-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  const source = join(dir, 'source');
  const from = createProjectDirectory({ dataDir: source, local: () => feed(SOURCE) });
  const to = createProjectDirectory({ dataDir: target, local });
  const token = issueProjectDirectoryToken(source);
  return { from, to, source, target, token };
}

test('远端目录走专用授权，只返回指定项目字段，断线后保留已读目录和原直达地址', async (t) => {
  const { from, to, target, token } = directories(t);
  let requests = 0;
  let enabled = true;
  const server = createServer((request, response) => {
    assert.equal(request.url, DIRECTORY_FEED_PATH);
    requests += 1;
    const directory = enabled ? from.feed(request.headers.authorization) : null;
    response.writeHead(directory ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(directory));
  });
  const origin = await listen(server);
  t.after(() => stop(server));
  registerProjectDirectoryPeer(target, { service_id: SOURCE, environment: '办公环境', origin, token });
  assert.equal(from.feed(undefined), null);
  assert.equal(from.feed('Bearer ' + 'Z'.repeat(43)), null);
  assert.deepEqual(from.feed('Bearer ' + token), feed(SOURCE));
  assert.deepEqual(listProjectDirectoryPeers(target), [{ service_id: SOURCE, environment: '办公环境', origin }]);
  const [a, b] = await Promise.all([to.view(), to.view()]);
  assert.equal(requests, 1, '并发视图复用同次远程查询');
  assert.deepEqual(a, b);
  assert.equal(a.local?.projects[0]?.generation, 2);
  assert.deepEqual(a.peers[0], {
    service_id: SOURCE, environment: '办公环境', origin, status: 'online', observed_at: a.peers[0]!.observed_at,
    projects: feed(SOURCE).projects,
  });

  enabled = false;
  const nextProcess = createProjectDirectory({ dataDir: target, local: () => feed(TARGET, 2) });
  const stale = await nextProcess.view();
  assert.equal(stale.peers[0]?.status, 'offline');
  assert.equal(stale.peers[0]?.observed_at, a.peers[0]?.observed_at);
  assert.equal(stale.peers[0]?.origin, origin);
  assert.deepEqual(stale.peers[0]?.projects, feed(SOURCE).projects);
  assert.equal(stale.local?.projects[0]?.generation, 2, '缓存保留各服务视图');
  removeProjectDirectoryPeer(target, SOURCE);
  assert.deepEqual((await to.view()).peers, []);
  registerProjectDirectoryPeer(target, { service_id: SOURCE, environment: '办公环境', origin, token });
  assert.deepEqual((await to.view()).peers[0]?.projects, [], '撤除登记后清除缓存');
});

test('错误身份或地址、重定向和撤销目录令牌不能读目录', async (t) => {
  const { from, to, source, target, token } = directories(t, () => null);
  let redirected = false;
  let mode: 'identity' | 'redirect' = 'identity';
  const server = createServer((request, response) => {
    if (request.url === '/redirect-target') redirected = true;
    if (mode === 'identity') {
      response.writeHead(200).end(JSON.stringify(feed(TARGET)));
    } else {
      response.writeHead(302, { location: '/redirect-target' }).end();
    }
  });
  const origin = await listen(server);
  t.after(() => stop(server));
  assert.throws(() => registerProjectDirectoryPeer(target, { service_id: SOURCE, environment: '家庭', origin: 'http://office.example', token }), /HTTPS/);
  assert.throws(() => registerProjectDirectoryPeer(target, { service_id: SOURCE, environment: '家庭', origin: 'https://user:pass@office.example', token }), /HTTPS/);
  registerProjectDirectoryPeer(target, { service_id: SOURCE, environment: '办公', origin, token });
  assert.equal((await to.view()).peers[0]?.status, 'offline');
  mode = 'redirect';
  assert.equal((await to.view()).peers[0]?.status, 'offline');
  assert.equal(redirected, false);
  revokeProjectDirectoryToken(source);
  assert.equal(from.feed('Bearer ' + token), null);
});

test('CLI 签发与登记后，两个真实服务的目录通过 HTTP 鉴权直达项目', async (t) => {
  const source = stage(t);
  const target = stage(t);
  const sourceHome = createProjectHome(source.dataDir);
  const serviceId = sourceHome.identity.id;
  sourceHome.close();
  const targetHome = createProjectHome(target.dataDir);
  targetHome.close();
  const tokenFile = join(source.dir, 'only-directory-token');
  assert.equal(await runCli(['project-directory'], source.cli), 0);
  assert.equal(await runCli(['project-directory', 'issue', tokenFile], source.cli), 0);
  const token = readFileSync(tokenFile, 'utf8').trim();
  const s = await startService({ dataDir: source.dataDir, port: 0, claude: [process.execPath, join(import.meta.dirname, 'fake-claude.mjs')] });
  t.after(() => s.stop());
  const p = await startService({ dataDir: target.dataDir, port: 0, claude: [process.execPath, join(import.meta.dirname, 'fake-claude.mjs')] });
  t.after(() => p.stop());
  const sourceBase = 'http://127.0.0.1:' + s.port;
  const targetBase = 'http://127.0.0.1:' + p.port;
  const owner = { actor: 'console' };
  const id = s.ledger.createProject({ name: '家用饮食' }, owner);
  p.ledger.createProject({ name: '家用饮食' }, owner);
  assert.equal(await runCli(['project-directory', 'add', serviceId, '家庭 NAS', sourceBase, tokenFile], target.cli), 0);

  const bearer = { Authorization: 'Bearer ' + token };
  assert.equal((await fetch(sourceBase + DIRECTORY_FEED_PATH)).status, 401);
  assert.equal((await fetch(sourceBase + DIRECTORY_FEED_PATH, { headers: bearer })).status, 200);
  assert.equal((await fetch(sourceBase + '/api/projects', { headers: bearer })).status, 401);
  assert.equal((await fetch(targetBase + '/api/project-directory')).status, 401);
  const { get } = await signIn(p);
  const view = await (await get('/api/project-directory')).json() as DirectoryView;
  assert.equal(view.peers[0]?.projects[0]?.id, id);
  assert.equal(view.peers[0]?.environment, '家庭 NAS');
  assert.equal(view.peers[0]?.status, 'online');
  assert.equal(view.peers[0]?.origin, sourceBase);
  assert.equal(view.local?.projects[0]?.name, '家用饮食');
  assert.equal(JSON.stringify(view).includes(token), false);

  assert.equal(await runCli(['project-directory', 'revoke'], source.cli), 0);
  assert.equal((await fetch(sourceBase + DIRECTORY_FEED_PATH, { headers: bearer })).status, 401);
  const stale = await (await get('/api/project-directory')).json() as DirectoryView;
  assert.equal(stale.peers[0]?.status, 'offline');
  assert.equal(stale.peers[0]?.projects[0]?.id, id);
  await p.stop();
  await s.stop();
});
