// Guards against the Console's read routes showing the wrong thing (a child Task in the
// left column, a capsule missing its Task, an away summary that never resets), answers
// or interruptions that skip the ledger's checks or the audit trail. And the built
// console: a page the browser keeps after a release replaced it, hashed assets fetched
// again on every visit, a request that reaches a file outside the build (however its
// path is spelled), a directory or the page under a second address being served, anything
// handed to a visitor who is not signed in, a clone that was never built showing a
// bare error or taking the interfaces down with it, a build replaced while the service
// runs answering with a server error that spells out where the files are on this
// machine, and a file's type left for the browser to guess.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './cli-helpers.ts';
import { consoleApp } from './console-helpers.ts';
import { USER } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

test('GET /api/tasks?top=1 lists top-level Tasks with when they last changed', async (t) => {
  const { f, get } = await consoleApp(t);
  const task = f.queuedTask();
  f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, parentId: task.id, title: '子任务', goal: '目标' }, USER);
  const body = await json(await get('/api/tasks?top=1'));
  assert.deepEqual(body.tasks.map(({ id }: { id: string }) => id), [task.id]);
  assert.deepEqual(
    Object.keys(body.tasks[0]).sort(),
    ['assignment', 'id', 'login_id', 'login_name', 'project_id', 'reason', 'resumable', 'review_gate', 'role_id', 'source', 'source_label', 'source_state', 'state', 'summary', 'tier', 'tier_override', 'tier_source', 'title', 'updated_at'],
  );
  assert.equal(body.tasks[0].state, 'queued');
  const [last] = f.peek<{ at: string }>(`SELECT max(at) AS at FROM change WHERE task_id = ?`, task.id);
  assert.equal(body.tasks[0].updated_at, last!.at);
  assert.equal((await get('/api/tasks?top=1', {})).status, 401);
});

test('GET /api/summary counts what happened since this session last read a snapshot', async (t) => {
  const { f, get } = await consoleApp(t);
  const { since } = await json(await get('/api/summary'));
  f.queuedTask();
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  f.ledger.openApproval(f.queuedTask().id, [{ question: '选哪个？' }], USER);

  const away = await json(await get('/api/summary'));
  assert.deepEqual([away.since, away.delivered, away.running, away.waiting], [since, 1, 1, 1]);

  assert.equal((await get('/api/messages')).status, 200);
  const back = await json(await get('/api/summary'));
  assert.ok(back.since > since);
  assert.equal(back.delivered, 0);
  assert.equal((await get('/api/summary', {})).status, 401);
});

test('a page of newer messages is not a snapshot and does not reset the summary', async (t) => {
  const { get } = await consoleApp(t);
  const { since } = await json(await get('/api/summary'));
  await get('/api/messages?after=0');
  assert.equal((await json(await get('/api/summary'))).since, since);
});

test('GET /api/messages/<id>/changes gives the records and the Tasks created in that turn', async (t) => {
  const { f, get } = await consoleApp(t);
  const { id } = f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'console', text: '建任务' });
  const created = f.ledger.createTask(
    { roleId: 'implement', projectId: f.projectId, title: '探针', goal: '目标' },
    { actor: 'router', messageId: id },
  );
  const body = await json(await get(`/api/messages/${id}/changes`));
  assert.deepEqual(body.changes.map(({ action }: { action: string }) => action), ['task.create']);
  assert.deepEqual(body.tasks.map(({ id: taskId, title }: { id: string; title: string }) => [taskId, title]), [
    [created.id, '探针'],
  ]);
  assert.equal((await get('/api/messages/nosuch/changes')).status, 400);
  assert.equal((await get(`/api/messages/${id}/changes`, {})).status, 401);
});

test('a turn that committed nothing has empty changes', async (t) => {
  const { f, get } = await consoleApp(t);
  const { id } = f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'console', text: '你好' });
  assert.deepEqual(await json(await get(`/api/messages/${id}/changes`)), { changes: [], tasks: [] });
});

test('GET /api/approvals lists questions by state, with their Task and parsed questions', async (t) => {
  const { f, get } = await consoleApp(t);
  const open = f.ledger.openApproval(
    f.queuedTask().id,
    [{ question: '选哪个？', options: ['甲', '乙'], recommend: 1 }],
    USER,
  );
  const done = f.ledger.openApproval(f.queuedTask().id, [{ question: '要吗？' }], USER);
  f.ledger.answerApproval(done, ['要'], 'console', 'console');

  const body = await json(await get('/api/approvals?state=open'));
  assert.deepEqual(body.approvals.map(({ id }: { id: string }) => id), [open]);
  assert.equal(body.approvals[0].task_title, '任务');
  assert.deepEqual(body.approvals[0].questions[0].options, ['甲', '乙']);

  const all = await json(await get('/api/approvals'));
  assert.deepEqual(all.approvals.map(({ state }: { state: string }) => state), ['open', 'answered']);
  assert.deepEqual([all.approvals[1].answers, all.approvals[1].answered_via], [['要'], 'console']);
  assert.equal((await get('/api/approvals?state=nonsense')).status, 400);
  assert.equal((await get('/api/approvals', {})).status, 401);
});

test('an answer goes through the ledger as console, and only the first one counts', async (t) => {
  const { f, post } = await consoleApp(t);
  const task = f.queuedTask();
  const id = f.ledger.openApproval(task.id, [{ question: '选哪个？' }], USER);
  assert.equal((await post(`/api/approvals/${id}/answer`, { answers: [] })).status, 400);
  assert.equal((await post(`/api/approvals/${id}/answer`, {})).status, 400);

  const accepted = await post(`/api/approvals/${id}/answer`, { answers: ['甲'] });
  assert.equal(accepted.status, 200);
  assert.equal((await json(accepted)).status, 'accepted');
  const row = f.ledger.listApprovals(task.id)[0]!;
  assert.deepEqual([row.answered_by, row.answered_via], ['console', 'console']);
  assert.equal(f.task(task.id).state, 'queued');

  const again = await post(`/api/approvals/${id}/answer`, { answers: ['乙'] });
  assert.equal(again.status, 409);
  assert.deepEqual(await json(again), { error: '问题已关闭' });
});

test('POST /api/interrupt stops the running turn and records who did', async (t) => {
  const { f, post, state } = await consoleApp(t);
  const { id } = f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'console', text: '长活' });
  state.current = id;
  assert.deepEqual(await json(await post('/api/interrupt')), { interrupted: true });
  assert.equal(state.interrupts, 1);
  const [change] = f.peek<{ actor: string; detail_json: string }>(
    `SELECT actor, detail_json FROM change WHERE action = 'message.interrupt'`,
  );
  assert.equal(change?.actor, 'console');
  assert.equal(JSON.parse(change!.detail_json).message_id, id);
  // It is not something the turn committed.
  assert.deepEqual(f.ledger.listChanges({ messageId: id }), []);
});

test('POST /api/interrupt with no turn does nothing and writes nothing', async (t) => {
  const { f, post } = await consoleApp(t);
  const before = f.count('change');
  assert.deepEqual(await json(await post('/api/interrupt')), { interrupted: false });
  assert.equal(f.count('change'), before);
});

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'";
const IMMUTABLE = 'private, max-age=31536000, immutable';

test('the built console is served whole: the page fresh on every visit, its hashed assets for good', async (t) => {
  const { get } = await consoleApp(t);
  for (const [path, type, cache] of [
    ['/', 'text/html; charset=utf-8', 'no-cache'],
    ['/assets/index-0a1b2c3d.js', 'text/javascript; charset=utf-8', IMMUTABLE],
    ['/assets/index-0a1b2c3d.css', 'text/css; charset=utf-8', IMMUTABLE],
    ['/favicon.svg', 'image/svg+xml', 'no-cache'],
  ] as const) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type, path);
    assert.equal(response.headers.get('cache-control'), cache, path);
    assert.equal(response.headers.get('content-security-policy'), CSP, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
  }
  assert.match(await (await get('/')).text(), /stand-in console/);
  assert.match(await (await get('/assets/index-0a1b2c3d.js')).text(), /^document\.title = "Tycho";/);
  assert.equal((await get('/index.html')).status, 404, '页面只有 / 一个地址');
  assert.equal((await get('/assets/index-ffffffff.js')).status, 404);
  for (const path of ['/', '/assets/index-0a1b2c3d.js', '/favicon.svg']) {
    const response = await get(path, {});
    assert.equal(response.status, 302, `没登录也拿到了 ${path}`);
    assert.equal(response.headers.get('location'), '/login');
  }
});

test('only files that are in the build are served, however the path is spelled', async (t) => {
  const root = tempDir(t, 'tycho-console-');
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>page</title>');
  writeFileSync(join(dist, 'assets', 'app-1.js'), 'in');
  writeFileSync(join(dist, 'name with space.txt'), 'spaced');
  // Beside the build, and under the names the build itself uses.
  writeFileSync(join(root, 'secret.txt'), 'outside');
  writeFileSync(join(root, 'app-1.js'), 'outside');
  writeFileSync(join(root, 'index.html'), 'outside');
  const { get, port, browser } = await consoleApp(t, { consoleDir: dist });

  assert.equal(await (await get('/assets/app-1.js')).text(), 'in');
  assert.equal(await (await get('/name%20with%20space.txt')).text(), 'spaced');
  for (const path of [
    '/%2e%2e/service/auth.ts',
    '/..%2fpackage.json',
    '/assets/..%5c..%5cpackage.json',
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets/../../secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/assets//app-1.js',
    '/assets%2fapp-1.js%00',
    '/%zz',
    '/assets',
    '/assets/',
    '/secret.txt',
    '/app-1.js',
  ]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /outside/, path);
  }
  // From a client that sends the path as written, where fetch would tidy it first.
  const asWritten = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = request({ hostname: '127.0.0.1', port, path, headers: browser }, (response) => {
      let body = '';
      response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk)).on('end', () => resolve({ status: response.statusCode!, body }));
    });
    sent.on('error', reject).end();
  });
  assert.deepEqual(await asWritten('/assets/app-1.js'), { status: 200, body: 'in' });
  for (const path of ['/../secret.txt', '/assets/../../secret.txt', '/assets/..\\..\\secret.txt', '/./../secret.txt', '/assets/./../../secret.txt']) {
    const answer = await asWritten(path);
    assert.equal(answer.status, 404, path);
    assert.doesNotMatch(answer.body, /outside/, path);
  }
});

test('a file of the build that is gone by the time it is read is simply not there: no server error, and no path of this machine in the answer', async (t) => {
  const root = tempDir(t, 'tycho-console-');
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>page</title>');
  writeFileSync(join(dist, 'assets', 'app-1.js'), 'in');
  const { get } = await consoleApp(t, { consoleDir: dist });
  assert.equal((await get('/assets/app-1.js')).status, 200);

  // A build replaces the directory between the listing and the read: the file is
  // listed, and removed just before it is opened.
  const read = fsPromises.readFile;
  const removing = t.mock.method(fsPromises, 'readFile', ((path: string, ...rest: []) => {
    if (/app-1\.js$|index\.html$/.test(String(path))) rmSync(path, { force: true });
    return read(path, ...rest);
  }) as typeof read);
  syncBuiltinESMExports();
  t.after(() => {
    removing.mock.restore();
    syncBuiltinESMExports();
  });

  for (const path of ['/assets/app-1.js', '/']) {
    const response = await get(path);
    const body = await response.text();
    assert.equal(response.status, 404, `${path}: ${body}`);
    assert.doesNotMatch(body, /ENOENT|tycho-console-|dist/, path);
  }
  // The interfaces are untouched by it.
  assert.equal((await get('/api/state')).status, 200);
});

test('a clone that was never built says how to build the console, and its interfaces work as ever', async (t) => {
  const root = tempDir(t, 'tycho-console-');
  for (const consoleDir of [join(root, 'dist'), root]) {
    const { get, post } = await consoleApp(t, { consoleDir });
    const page = await get('/');
    assert.equal(page.status, 503);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /控制台还没有构建：运行 npm run build:console/);
    assert.equal((await get('/assets/index-0a1b2c3d.js')).status, 404);
    assert.equal((await get('/api/state')).status, 200);
    assert.equal((await post('/api/messages', { text: '照常' })).status, 201);
    assert.equal((await get('/', {})).status, 302, '没登录时不说这些');
  }
});

test('POST /api/tasks/:id/hold, POST /api/knowledge/proposals/review-all, overview parked_waiting/counts, taskPage landable/automation, summary and projectView waiting', async (t) => {
  const { f, get, post } = await consoleApp(t);
  // 1. POST /api/tasks/:id/hold
  const q = f.queuedTask();
  const holdRes = await post(`/api/tasks/${q.id}/hold`, { reason: '等接口确认' });
  assert.equal(holdRes.status, 200);
  assert.deepEqual(await json(holdRes), { ok: true });
  assert.equal(f.task(q.id).state, 'held');
  assert.equal(f.task(q.id).reason, '等接口确认');
  f.ledger.resumeTask(q.id, USER);
  const holdDefaultRes = await post(`/api/tasks/${q.id}/hold`, {});
  assert.equal(holdDefaultRes.status, 200);
  assert.equal(f.task(q.id).reason, '主人暂停');

  // 2. POST /api/knowledge/proposals/review-all
  const { id: p1 } = f.ledger.propose(
    {
      kind: 'knowledge',
      inputs: [],
      outputs: [{ key: 'k1', title: '经验一', when_to_use: '测试用', body: '正文一', project_ids: [f.projectId], loading: 'on_demand', roles: [] }],
      why: { when: '下次', changes: '改动作', generalizes: '有证据' },
      evidence: [{ source: 'owner', ref: 'm1', location: 'msg1', excerpt: '原话' }],
    },
    { source: 'mcp', by: 'external', client: 'mcp:1', writers: [] },
    USER,
  );
  // Force proposal to published & unreviewed to test batch review-all
  f.force(`UPDATE knowledge_proposal SET state = 'published', published_at = ?, reviewed_at = NULL WHERE id = ?`, new Date().toISOString(), p1);
  const reviewAllRes = await post('/api/knowledge/proposals/review-all', {});
  assert.equal(reviewAllRes.status, 200);
  assert.deepEqual(await json(reviewAllRes), { count: 1 });
  assert.deepEqual(await json(await post('/api/knowledge/proposals/review-all', {})), { count: 0 });

  // 3. overview parked_waiting + counts.knowledge_awaiting + counts.pending_joins + outbox.failures[].task_title
  const parked = f.queuedTask();
  f.force(`UPDATE task SET state = 'waiting_person', reason = '这个任务还没有职能，选一个职能再继续', role_id = NULL WHERE id = ?`, parked.id);
  const { id: awaitingProp } = f.ledger.propose(
    {
      kind: 'knowledge',
      inputs: [],
      outputs: [{ key: 'k2', title: '待批全局', when_to_use: '全局用', body: '正文二', project_ids: null, loading: 'resident', roles: [] }],
      why: { when: '下次', changes: '改动作', generalizes: '有证据' },
      evidence: [{ source: 'owner', ref: 'm2', location: 'msg2', excerpt: '原话' }],
    },
    { source: 'mcp', by: 'external', client: 'mcp:2', writers: [] },
    USER,
  );
  f.force(`UPDATE knowledge_proposal SET state = 'awaiting_owner' WHERE id = ?`, awaitingProp);
  const failedRow = f.ledger.outbox.enqueue('wecom', 'held', { task_id: q.id, reason: '失败通知' });
  f.force(`UPDATE outbox SET state = 'given_up', error = '网络超时' WHERE id = ?`, failedRow.id);

  const ov = await json(await get('/api/overview'));
  assert.equal(ov.counts.knowledge_awaiting, 1);
  assert.equal(ov.counts.pending_joins, 0);
  assert.equal(ov.counts.waiting, 1);
  assert.equal(ov.parked_waiting.length, 1);
  assert.equal(ov.parked_waiting[0].id, parked.id);
  const enrichedFailure = ov.outbox.failures.find((row: { id: string }) => row.id === failedRow.id);
  assert.equal(enrichedFailure?.task_title, q.title);

  // 4. taskPage review.gate, landable, automation + summary & projectView.waiting
  const { task: implTask, run: implRun } = f.runningRun();
  f.ledger.settleRun(implRun.id, 0, { status: 'done', summary: '改好', artifacts: [{ kind: 'commit', ref: 'abc123' }, { kind: 'report', ref: 'r.md' }] });
  const pageBefore = await json(await get(`/api/tasks/${implTask.id}`));
  assert.equal(pageBefore.task.review_gate.kind, 'no_review');
  assert.equal(pageBefore.review.gate.kind, 'no_review');
  assert.equal(pageBefore.landable.landable, false);
  assert.deepEqual(pageBefore.automation, {
    router_busy: false,
    resting_until: null,
    active_review_id: null,
    active_review_state: null,
  });

  // Start an active review on implTask -> summary counts it as running (not delivered), projectView counts owner-actionable ready in waiting
  const regId = f.ledger.registerArtifacts(implRun.id, []);
  const rev = f.ledger.createTask({
    roleId: 'review',
    projectId: f.projectId,
    title: '审阅',
    goal: '审',
    acceptance: '给结论',
    reviewOf: { taskId: implTask.id, runId: implRun.id, revision: implTask.revision, registration: regId },
  }, USER);
  f.ledger.queueTask(rev.id, USER);
  const pageInReview = await json(await get(`/api/tasks/${implTask.id}`));
  assert.equal(pageInReview.task.review_gate.kind, 'in_review');
  assert.equal(pageInReview.review.gate.kind, 'in_review');
  assert.equal(pageInReview.automation.active_review_id, rev.id);
  assert.equal(pageInReview.automation.active_review_state, 'queued');

  // Verify a genuinely owner-actionable ready work counts in projectView().waiting
  const verifyTask = f.ledger.createTask({ roleId: 'verify', projectId: f.projectId, title: '直接可验', goal: '验', acceptance: '交报告' }, USER);
  f.ledger.queueTask(verifyTask.id, USER);
  const verifyRun = f.ledger.createRun(verifyTask.id, { ...f.login, snapshot: { ...f.login.snapshot, tier: 'operate' } }, USER);
  f.ledger.markRunRunning(verifyRun.id);
  f.ledger.settleRun(verifyRun.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'report', ref: 'r.md' }] });
  const projectsBody = await json(await get('/api/projects'));
  const proj = projectsBody.projects.find((p: { id: string }) => p.id === f.projectId);
  // waiting includes held (q), waiting_person (parked), and ready (verifyTask) = 3; implTask is in_review so it's moving!
  assert.equal(proj.waiting, 3);
  assert.ok(proj.moving >= 1);
});
