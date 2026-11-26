import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { createRunner } from '../runner/runner.ts';
import { prepareSnapshot, type Login } from '../runner/snapshot.ts';
import { createAcceptor } from '../service/accept.ts';
import { createAccounts } from '../service/accounts.ts';
import { createAuth } from '../service/auth.ts';
import { InputError } from '../service/errors.ts';
import { createHttp, createStream } from '../service/http.ts';
import { createInbounds } from '../service/inbound.ts';
import { createLogins } from '../service/logins.ts';
import { createMachines } from '../service/machines.ts';
import { createDeliverableIngestor, ingestRunDeliverables } from '../service/main.ts';
import { createNodes } from '../service/nodes.ts';
import {
  MAX_PROJECT_FILE_BYTES,
  projectFilePath,
  readProjectFileBytes,
} from '../service/project-files.ts';
import { readReleaseResult, type ReleaseFile } from '../service/releases.ts';
import { knowledgeTokenStore, readSecret, replaceSecret, wecomSecretFile } from '../service/secrets.ts';
import { serviceSettings } from '../service/service-settings.ts';
import { SETTINGS } from '../service/settings.ts';
import { createTools } from '../service/tools.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { capturedHost } from './capture-host.ts';
import {
  claudeTier,
  CONSOLE_DIST,
  fixture,
  HTTP_TUNED,
  memoryLogins,
  NODES_TUNED,
  RUNNER_TUNED,
  testCredentialRef,
  USER,
} from './helpers.ts';

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const SAMPLE_HTML = Buffer.from(
  '<!doctype html><html><body><h1>Logo 展示页</h1><div id="demo">OK</div></body></html>',
  'utf8',
);
const SAMPLE_TARBALL = Buffer.from('fake-release-tar-gz-bytes', 'utf8');

const sha256Of = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

function mockFetchArtifacts(files: Record<string, Buffer>, problem: string | null = null) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async fetchArtifacts(_run: unknown, into: string): Promise<{ files: ReleaseFile[]; problem: string | null }> {
      calls += 1;
      const result: ReleaseFile[] = [];
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(into, name), body);
        result.push({ name, sha256: sha256Of(body), bytes: body.length });
      }
      return { files: result, problem };
    },
  };
}

test('ingestRunDeliverables pulls .png and .html as worker files, skips .tar.gz and oversized files, and dedupes cleanly', async (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, {
    status: 'done',
    summary: '设计了 Logo 和交互展示页',
    artifacts: [
      { kind: 'commit', ref: 'c0ffee' },
      { kind: 'file', ref: 'logo.png' },
      { kind: 'file', ref: 'showcase.html' },
    ],
  });
  const settledRun = f.ledger.getRun(run.id);
  assert.equal(f.ledger.getTask(task.id).state, 'ready', '任务处于待验收（未点击验收）');

  const fetcher = mockFetchArtifacts({
    'logo.png': TINY_PNG,
    'showcase.html': SAMPLE_HTML,
    'tycho-1.2.3.tar.gz': SAMPLE_TARBALL,
  });
  let changedEvents = 0;

  const first = await ingestRunDeliverables(
    {
      ledger: f.ledger,
      runner: {
        fetchArtifacts: async (r, into) => {
          const out = await fetcher.fetchArtifacts(r, into);
          return {
            files: [
              ...out.files,
              { name: 'huge.bin', sha256: 'f'.repeat(64), bytes: MAX_PROJECT_FILE_BYTES + 1 },
            ],
            problem: out.problem,
          };
        },
      },
      dataDir: f.dir,
      onChanged: () => {
        changedEvents += 1;
      },
    },
    settledRun,
  );

  assert.equal(first.problem, null);
  assert.equal(first.files.length, 2, '只拉回 .png 和 .html，跳过 .tar.gz 与超大文件');
  assert.equal(changedEvents, 1, '新增产物后发布一次 changed 事件');

  const png = first.files.find((item) => item.name === 'logo.png');
  const html = first.files.find((item) => item.name === 'showcase.html');
  assert.ok(png);
  assert.ok(html);
  assert.equal(png.origin, 'worker');
  assert.equal(png.kind, 'upload');
  assert.equal(png.mime, 'image/png');
  assert.equal(png.is_image, true);
  assert.equal(png.previewable, false);
  assert.match(png.summary ?? '', new RegExp(`\\[task:${task.id}\\]\\[run:${run.id}\\]`));

  assert.equal(html.origin, 'worker');
  assert.equal(html.kind, 'artifact');
  assert.equal(html.mime, 'text/html');
  assert.equal(html.is_image, false);
  assert.equal(html.previewable, true);
  assert.match(html.summary ?? '', new RegExp(`\\[task:${task.id}\\]\\[run:${run.id}\\]`));

  assert.deepEqual(readProjectFileBytes(f.dir, f.projectId, png.id), TINY_PNG);
  assert.deepEqual(readProjectFileBytes(f.dir, f.projectId, html.id), SAMPLE_HTML);

  // Repeated call must dedupe cleanly without duplicating DB rows or firing another changed event.
  const second = await ingestRunDeliverables(
    {
      ledger: f.ledger,
      runner: fetcher,
      dataDir: f.dir,
      onChanged: () => {
        changedEvents += 1;
      },
    },
    settledRun,
  );
  assert.equal(second.files.length, 2);
  assert.deepEqual(
    second.files.map((item) => item.id).sort(),
    first.files.map((item) => item.id).sort(),
    '重复调用复用已有 project_file 行',
  );
  assert.equal(changedEvents, 1, '重复调用未新增文件，不再重复发 changed');
  assert.equal(f.ledger.listProjectFiles(f.projectId).length, 2);
});

test('ingestRunDeliverables ingests read-only run artifacts and skips no-project knowledge tasks', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();

  // Read-only runs can now deliver charts/HTML/PNG in artifacts/.
  const roSnap = JSON.stringify({ ...JSON.parse(run.snapshot_json), access: { permission: 'read', layer: 'contract', args: [] } });
  const roRun = { ...run, snapshot_json: roSnap };
  const fetcher = mockFetchArtifacts({ 'logo.png': TINY_PNG });

  const roResult = await ingestRunDeliverables({ ledger: f.ledger, runner: fetcher, dataDir: f.dir }, roRun);
  assert.equal(roResult.problem, null);
  assert.equal(roResult.files.length, 1);
  assert.equal(roResult.files[0]?.name, 'logo.png');
  assert.equal(fetcher.calls, 1, '只读轮次同样可拉取 artifacts/ 交付物');

  // Knowledge task with project_id = null.
  const noProjectTask = f.newTask({ roleId: 'analyse' });
  f.force('UPDATE task SET project_id = NULL WHERE id = ?', noProjectTask.id);
  const noProjectRun = { ...run, task_id: noProjectTask.id };
  const kpResult = await ingestRunDeliverables({ ledger: f.ledger, runner: fetcher, dataDir: f.dir }, noProjectRun);
  assert.deepEqual(kpResult, { files: [], problem: null });
  assert.equal(fetcher.calls, 1, '无项目知识任务不拉取项目文件');
});

test('GET /api/tasks/:id, POST /api/tasks/:id/deliverables, get_task MCP tool, and DELETE /api/projects/:id work end-to-end before Accept', async (t) => {
  const f = fixture(t);
  const pid = f.ledger.createProject({ name: '视觉交付项目', loginMode: 'all' }, USER);
  f.ledger.setWhitelist({ console: ['console'] }, USER);

  const login: Login = { id: 'acc1', name: 'acc1', executor: 'claude', tiers: { execute: claudeTier('sonnet') } };
  f.ledger.putAccount(login, USER, testCredentialRef(login.id));

  const task = f.ledger.createTask({
    projectId: pid,
    title: '品牌 Logo 设计',
    goal: '生成 2 版 Logo 和 HTML 预览页',
    acceptance: '交付 logo.png 和 showcase.html',
    roleId: 'implement',
  }, USER);
  f.ledger.queueTask(task.id, USER);
  const createdRun = f.ledger.createRun(
    task.id,
    {
      ...f.login,
      snapshot: { ...f.login.snapshot, brief: 'design' },
    },
    USER,
  );
  f.ledger.markRunRunning(createdRun.id);
  f.ledger.settleRun(createdRun.id, 0, {
    status: 'done',
    summary: '已完成 Logo 设计并产出预览页',
    artifacts: [
      { kind: 'commit', ref: 'c0ffee' },
      { kind: 'file', ref: 'logo.png' },
      { kind: 'file', ref: 'showcase.html' },
    ],
  });
  // Verify task is in `ready` state (NOT accepted yet!).
  assert.equal(f.ledger.getTask(task.id).state, 'ready');

  const fetcher = mockFetchArtifacts({
    'logo.png': TINY_PNG,
    'showcase.html': SAMPLE_HTML,
    'bundle-1.0.0.tar.gz': SAMPLE_TARBALL,
  });

  const machines = createMachines({ ledger: f.ledger });
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: ['claude'],
    routingExecutors: ['claude'],
    dataDir: f.dir,
  });
  const logins = createLogins({ ledger: f.ledger, accounts, executors: ADAPTERS });
  const stream = createStream();
  const accept = createAcceptor({
    ledger: f.ledger,
    runner: { fetchArtifacts: fetcher.fetchArtifacts },
    dataDir: f.dir,
  });
  const deliverables = createDeliverableIngestor({
    ledger: f.ledger,
    runner: { fetchArtifacts: fetcher.fetchArtifacts },
    dataDir: f.dir,
    onChanged: () => stream.publish('changed', {}),
  });
  const tools = createTools({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins,
    machines,
    accept,
  });
  const settings = serviceSettings({ ledger: f.ledger, dataDir: f.dir, log: () => {} });
  const auth = createAuth({
    ledger: f.ledger,
    linkTtlMs: () => settings.get('login.linkTtlMs'),
    sessionDays: () => settings.get('login.sessionDays'),
    temporarySessionMs: () => settings.get('login.temporarySessionMs'),
  });
  const inbounds = createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => SETTINGS['triggers.inboundSkewMs'].default, log: () => {} });
  const secretFile = wecomSecretFile(f.dir);
  const loginToken = 'test-login-token';

  const http = createHttp({
    ...HTTP_TUNED,
    dataDir: f.dir,
    ledger: f.ledger,
    tools,
    accept,
    deliverables: { ingestTask: deliverables.ingestTask },
    cleanupAfterProjectDelete: () => accept.sweep(),
    auth,
    session: {
      admitTool: () => ({ refused: 'no turn' }),
      toolTokens: () => [],
      projectOfToken: () => undefined,
      kick: () => {},
      interrupt: () => false,
      status: () => ({ alive: true, pid: 1, turn: null, turns: [], error: null, restarting: false, waiting: null, launched: null, host_error: null, projects: [] }),
      restart: async () => {},
    },
    stream,
    accounts,
    logins,
    machines,
    nodes: createNodes({
      ...NODES_TUNED,
      ledger: f.ledger,
      pollHoldMs: () => SETTINGS['node.pollHoldMs'].default,
      commandTimeoutMs: () => SETTINGS['node.commandTimeoutMs'].default,
      joinTtlMs: () => SETTINGS['node.joinTtlMs'].default,
      gapSlackMs: () => SETTINGS['node.gapSlackMs'].default,
      log: () => {},
    }),
    roundSnapshot: () => null,
    roundCredential: () => null,
    roundInvite: () => null,
    knowledgeTokens: knowledgeTokenStore(f.dir),
    inbounds,
    skillFolder: join(f.dir, 'skills'),
    wecomSecret: {
      isSet: () => readSecret(secretFile) !== '',
      set: (secret, ctx) => replaceSecret(secretFile, secret, () => f.ledger.noteAction('wecom.secret_set', ctx)),
    },
    doctor: async () => [],
    loginUrl: (path) => `http://127.0.0.1${path}`,
    publicUrl: () => '',
    backup: { status: () => ({ configured: false }), trigger() { throw new InputError('no backup'); } },
    settings,
    deployment: async () => [],
    consoleDir: CONSOLE_DIST,
    loginToken,
    shutdownToken: 'shutdown-secret',
    instance: () => ({}),
    releaseCheck: () => ({ ledger: 'ok', degraded: false, recovering: false, health_window_ms: 0 }),
    drain: async () => ({ drained: true, waited_ms: 0 }),
    releases: {
      dataDir: f.dir,
      version: '1.0.0',
      last: () => readReleaseResult(f.dir),
      intent: () => null,
      attempting: () => false,
      launch: () => { throw new InputError('no release'); },
    },
    onShutdown: () => {},
  });
  const port = await http.listen(0, '127.0.0.1');
  t.after(() => http.close());
  const url = `http://127.0.0.1:${port}`;
  const origin = { Origin: url };

  const linkRes = await fetch(`${url}/api/login-links`, { method: 'POST', headers: { Authorization: `Bearer ${loginToken}` } });
  const { path: linkPath } = (await linkRes.json()) as { path: string };
  const cred = new URL(linkPath, url).hash.slice(1);
  const exRes = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { ...origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: cred }),
    redirect: 'manual',
  });
  const cookie = exRes.headers.get('set-cookie')!.split(';')[0]!;
  const browser = { Cookie: cookie, ...origin };

  // Before sync: GET /api/tasks/:id returns empty deliverables while task is still `ready`.
  const beforePage = (await (await fetch(`${url}/api/tasks/${task.id}`, { headers: browser })).json()) as {
    task: { state: string };
    deliverables: Array<{ id: string; name: string }>;
  };
  assert.equal(beforePage.task.state, 'ready');
  assert.deepEqual(beforePage.deliverables, []);

  // 3. POST /api/tasks/:id/deliverables pulls deliverables on demand BEFORE acceptance.
  const syncRes = await fetch(`${url}/api/tasks/${task.id}/deliverables`, { method: 'POST', headers: browser });
  assert.equal(syncRes.status, 200);
  const synced = (await syncRes.json()) as { files: Array<{ id: string; name: string; origin: string }>; problem: string | null };
  assert.equal(synced.problem, null);
  assert.equal(synced.files.length, 2);
  assert.equal(f.ledger.getTask(task.id).state, 'ready', '同步产物不改变任务待验收状态');

  // 2. GET /api/tasks/:id returns hydrated deliverables BEFORE acceptance.
  const afterPage = (await (await fetch(`${url}/api/tasks/${task.id}`, { headers: browser })).json()) as {
    task: { state: string };
    deliverables: Array<{ id: string; name: string; is_image: boolean; previewable: boolean; origin: string }>;
  };
  assert.equal(afterPage.task.state, 'ready');
  assert.equal(afterPage.deliverables.length, 2);
  const pngFile = afterPage.deliverables.find((d) => d.name === 'logo.png')!;
  const htmlFile = afterPage.deliverables.find((d) => d.name === 'showcase.html')!;
  assert.equal(pngFile.is_image, true);
  assert.equal(pngFile.origin, 'worker');
  assert.equal(htmlFile.previewable, true);
  assert.equal(htmlFile.origin, 'worker');

  // Raw & preview endpoints immediately serve the ingested files.
  const rawPngRes = await fetch(`${url}/api/projects/${pid}/files/${pngFile.id}/raw`, { headers: browser });
  assert.equal(rawPngRes.status, 200);
  assert.deepEqual(Buffer.from(await rawPngRes.arrayBuffer()), TINY_PNG);
  const previewHtmlRes = await fetch(`${url}/api/projects/${pid}/files/${htmlFile.id}/preview`, { headers: browser });
  assert.equal(previewHtmlRes.status, 200);
  assert.match(await previewHtmlRes.text(), /Logo 展示页/);

  // 4. get_task MCP tool exposes deliverables with tycho-file:// and image_markdown.
  const toolOut = await tools.call('get_task', { task_id: task.id }, { actor: 'router' }, { projectId: pid });
  assert.equal(toolOut.isError, undefined);
  const parsedTool = JSON.parse(toolOut.content[0]!.text) as {
    deliverables: Array<{
      id: string;
      name: string;
      mime: string;
      size: number;
      kind: string;
      previewable: boolean;
      is_image: boolean;
      ref: string;
      image_markdown?: string;
    }>;
  };
  assert.equal(parsedTool.deliverables.length, 2);
  const toolPng = parsedTool.deliverables.find((d) => d.name === 'logo.png')!;
  const toolHtml = parsedTool.deliverables.find((d) => d.name === 'showcase.html')!;
  assert.equal(toolPng.ref, `tycho-file://${pngFile.id}`);
  assert.equal(toolPng.image_markdown, `![logo.png](/api/projects/${pid}/files/${pngFile.id}/raw)`);
  assert.equal(toolHtml.ref, `tycho-file://${htmlFile.id}`);
  assert.equal(toolHtml.image_markdown, undefined);

  // 5. Deleting the project cleanly wipes all ingested worker deliverables from DB and disk.
  assert.equal(existsSync(projectFilePath(f.dir, pid, pngFile.id)), true);
  assert.equal(existsSync(projectFilePath(f.dir, pid, htmlFile.id)), true);

  // Abandon the ready task so project can be archived & deleted cleanly.
  f.ledger.abandonTask(task.id, '测试清理', USER);
  const archiveRes = await fetch(`${url}/api/projects/${pid}/archive`, {
    method: 'POST',
    headers: { ...browser, 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(archiveRes.status, 200);
  const deleteRes = await fetch(`${url}/api/projects/${pid}`, {
    method: 'DELETE',
    headers: { ...browser, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_name: '视觉交付项目' }),
  });
  assert.equal(deleteRes.status, 200);

  assert.equal(f.peek('SELECT id FROM project_file WHERE project_id = ?', pid).length, 0);
  assert.equal(existsSync(join(f.dir, 'projects', pid)), false);
});

test('snapshot brief tells both writable and read-only Workers about deliverables in artifacts/', (t) => {
  const f = fixture(t);
  const task = f.newTask({ roleId: 'implement' });
  const login = f.login.login;

  const noSource = prepareSnapshot(task, login, ADAPTERS, { timeoutMs: 60_000, permission: 'write' });
  assert.match(noSource.brief, /需回传的文件（报告、图片、HTML\/SVG 预览等普通文件）放入 `\.\.\/artifacts\/`/);

  const repoSource = prepareSnapshot(task, login, ADAPTERS, {
    timeoutMs: 60_000,
    permission: 'write',
    source: { kind: 'repo', url: 'https://example.com/app.git', binding_key: 'repo:https://example.com/app.git' },
  });
  assert.match(repoSource.brief, /需回传的文件（报告、图片、HTML\/SVG 预览等普通文件）放入 `\.\.\/artifacts\/`/);
  assert.match(repoSource.brief, /如有提交、分支或 PR，一并列在回执 `artifacts` 中/);

  const readOnly = prepareSnapshot(task, login, ADAPTERS, { timeoutMs: 60_000, permission: 'read' });
  assert.match(readOnly.brief, /需回传的文件（报告、图片、HTML\/SVG 预览等普通文件）放入 `\.\.\/artifacts\/`/);
  assert.doesNotMatch(readOnly.brief, /如有提交、分支或 PR/);
});

test('createRunner invokes onRunSettled asynchronously without crashing settlement if callback rejects', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const receiptText = '完成\n```receipt\n{"status":"done","summary":"生成图片","artifacts":[{"kind":"commit","ref":"c0ffee"},{"kind":"file","ref":"logo.png"}]}\n```';
  const stdout = `${JSON.stringify({ type: 'result', is_error: false, result: receiptText, session_id: 's1' })}\n`;

  const settledCalls: Array<{ runId: string; summary: unknown }> = [];
  const settledDone = Promise.withResolvers<void>();

  const rawHost = {
    place: async () => [],
    start: async () => ({ code: 0, stdout: '', stderr: '' }),
    state: async () => ({ started: true, pid_alive: false, launcher_alive: false, marked: false, exit: 0 }),
    list: async () => [],
    readRange: async (path: string, offset: number) => {
      if (path.endsWith('stdout.ndjson')) {
        const buf = Buffer.from(stdout, 'utf8');
        return { bytes: buf.subarray(offset), size: buf.length, mtime: 1_700_000_000 };
      }
      return { bytes: Buffer.alloc(0), size: 0, mtime: 1_700_000_000 };
    },
    stop: async () => {},
    artifacts: async () => [],
    dropRun: async () => {},
    connected: () => true,
  };

  const runner = createRunner({
    ...RUNNER_TUNED,
    ledger: f.ledger,
    adapters: { claude: claudeAdapter },
    logins: memoryLogins({ [f.login.login.id]: f.login.login }),
    machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => capturedHost(rawHost, f.ledger, claudeAdapter, () => 0),
    onRunSettled: async (settledRun, receipt) => {
      settledCalls.push({ runId: settledRun.id, summary: receipt?.summary });
      settledDone.resolve();
      throw new Error('simulated callback failure must never crash settlement');
    },
  });

  const verdict = await runner.verify(run);
  assert.equal(verdict, 'ended');
  await settledDone.promise;
  assert.deepEqual(settledCalls, [{ runId: run.id, summary: '生成图片' }]);
  assert.equal(f.ledger.getRun(run.id).state, 'ended');
});
