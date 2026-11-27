import './guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseUnifiedDiff, readTaskDiff } from '../service/diff.ts';
import { createLandingTask, landableOf } from '../service/land.ts';
import { InputError } from '../service/errors.ts';
import { NotFoundError } from '../service/ledger.ts';
import { consoleApp } from './console-helpers.ts';
import { git, hasGit } from './git-repo.ts';
import { fixture, RUN_LIMIT_MS, testCredentialRef, USER } from './helpers.ts';

const noGit = hasGit() ? false : '这台机器上没有可用的 git';
const json = async (response: Response): Promise<any> => response.json();

test('queued inputs can be updated and deleted via ledger and HTTP, emit change notifications, and reject consumed/missing/blank', async (t) => {
  const { f, url, cookie, post } = await consoleApp(t);
  const { task, run } = f.runningRun();

  const addedId = f.ledger.addInput(task.id, '初始插话', USER);

  let changes = 0;
  const off = f.ledger.onChange(() => { changes += 1; });
  t.after(off);

  // PATCH update queued input
  const patchRes = await fetch(`${url}/api/tasks/${task.id}/inputs/${addedId}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '  修改后的插话  ' }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await json(patchRes);
  assert.equal(patched.input.id, addedId);
  assert.equal(patched.input.text, '修改后的插话');
  assert.equal(f.ledger.listInputs(task.id).find((i) => i.id === addedId)?.text, '修改后的插话');
  assert.ok(changes >= 1, 'updateInput emits ledger change notification');

  // Blank text rejected with 400
  const blankRes = await fetch(`${url}/api/tasks/${task.id}/inputs/${addedId}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(blankRes.status, 400);

  // Missing input or mismatched taskId -> NotFoundError / 404
  const otherTask = f.queuedTask();
  assert.throws(() => f.ledger.updateInput(otherTask.id, addedId, '越权', USER), NotFoundError);
  assert.throws(() => f.ledger.deleteInput(otherTask.id, addedId, USER), NotFoundError);
  const missingPatch = await fetch(`${url}/api/tasks/${task.id}/inputs/missing-id`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '新内容' }),
  });
  assert.equal(missingPatch.status, 404);
  const missingDel = await fetch(`${url}/api/tasks/${task.id}/inputs/missing-id`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: url },
  });
  assert.equal(missingDel.status, 404);

  // Unauthenticated and cross-origin writes rejected
  const unauthDel = await fetch(`${url}/api/tasks/${task.id}/inputs/${addedId}`, { method: 'DELETE' });
  assert.equal(unauthDel.status, 401);
  const csrfDel = await fetch(`${url}/api/tasks/${task.id}/inputs/${addedId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: 'https://evil.example' },
  });
  assert.equal(csrfDel.status, 403);

  // DELETE queued input
  const beforeDeleteChanges = changes;
  const delRes = await fetch(`${url}/api/tasks/${task.id}/inputs/${addedId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: url },
  });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await json(delRes), { deleted: true });
  assert.equal(f.ledger.listInputs(task.id).length, 0);
  assert.ok(changes > beforeDeleteChanges, 'deleteInput emits ledger change notification');

  // Consumed (attached) input cannot be modified or deleted
  const consumedId = f.ledger.addInput(task.id, '会被消费的插话', USER);
  // Settling a run with a queued input automatically re-queues the task; next run attaches it
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '轮次一完成' });
  f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: f.task(task.id).revision }, USER);

  assert.throws(
    () => f.ledger.updateInput(task.id, consumedId, '晚了', USER),
    (err: unknown) => err instanceof InputError && err.message === '这条插话已经送达执行轮次，不能修改或撤回',
  );
  assert.throws(
    () => f.ledger.deleteInput(task.id, consumedId, USER),
    (err: unknown) => err instanceof InputError && err.message === '这条插话已经送达执行轮次，不能修改或撤回',
  );
  const consumedPatch = await fetch(`${url}/api/tasks/${task.id}/inputs/${consumedId}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '晚了' }),
  });
  assert.equal(consumedPatch.status, 400);
  assert.equal((await json(consumedPatch)).error, '这条插话已经送达执行轮次，不能修改或撤回');
});

test('landableOf populates active_landing_task_state and active_landing_task_title when landing is active', (t) => {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'verify', title: '修复鉴权', goal: '修复鉴权流程' }, USER);
  const commit = 'a'.repeat(40);
  const pr = 'https://github.com/o/r/pull/42';

  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', tier: 'operate' }, expectedRevision: 1 }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, {
    status: 'done',
    summary: '已开 PR',
    artifacts: [{ kind: 'report', ref: 'r.md' }, { kind: 'commit', ref: commit }, { kind: 'pr', ref: pr }],
  });
  f.ledger.acceptTask(task.id, '通过', USER);

  const before = landableOf(f.ledger, task.id);
  assert.equal(before.landable, true);
  assert.equal(before.active_landing_task_id, null);

  const created = createLandingTask(f.ledger, task.id, USER);
  const during = landableOf(f.ledger, task.id);
  assert.equal(during.landable, false);
  assert.equal(during.active_landing_task_id, created.child.id);
  assert.equal(during.active_landing_task_state, 'queued');
  assert.equal(during.active_landing_task_title, `合入：修复鉴权`);
});

test('taskPage dispatch_info reports latest_login, latest_machine, and quota failover_note', async (t) => {
  const { f, get } = await consoleApp(t);
  const acctA = { id: 'acct-a', name: 'Claude-主账号', executor: 'claude', tiers: f.login.login.tiers };
  const acctB = { id: 'acct-b', name: 'Claude-备用号', executor: 'claude', tiers: f.login.login.tiers };
  f.ledger.putAccount(acctA, USER, testCredentialRef(acctA.id));
  f.ledger.putAccount(acctB, USER, testCredentialRef(acctB.id));
  const task = f.queuedTask();

  // First run ends with quota limit on account acct-a
  const run1 = f.ledger.createRun(task.id, {
    login: acctA,
    machine: f.login.machine,
    expectedRevision: f.task(task.id).revision,
    snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'claude' },
  }, USER);
  f.ledger.markRunRunning(run1.id);
  f.ledger.settleRun(run1.id, 1, null, {
    kind: 'quota',
    reason: 'rate limit reached',
    quota: { message: 'usage limit reached' },
  });

  const whileWaiting = await json(await get(`/api/tasks/${task.id}`));
  assert.equal(whileWaiting.dispatch_info.latest_login, 'Claude-主账号');
  assert.equal(whileWaiting.dispatch_info.latest_machine, f.login.machine.id);
  assert.match(whileWaiting.dispatch_info.failover_note, /Claude-主账号.*额度上限/);

  // Second run starts on a different login acct-b
  const run2 = f.ledger.createRun(task.id, {
    login: acctB,
    machine: f.login.machine,
    expectedRevision: f.task(task.id).revision,
    snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', executor: 'claude' },
  }, USER);
  f.ledger.markRunRunning(run2.id);

  const afterFailover = await json(await get(`/api/tasks/${task.id}`));
  assert.equal(afterFailover.dispatch_info.latest_login, 'Claude-备用号');
  assert.equal(afterFailover.dispatch_info.latest_machine, f.login.machine.id);
  assert.equal(
    afterFailover.dispatch_info.failover_note,
    '上一轮因账号 Claude-主账号 触达额度上限，已自动切换至 Claude-备用号 继续执行',
  );
});

test('readTaskDiff reads local git repo (committed + uncommitted + untracked) and supports HTTP /diff', { skip: noGit }, async (t) => {
  const { f, get } = await consoleApp(t);
  const task = f.queuedTask();

  // Create a kept local git repo under dataDir/tasks/<taskId>/s-repo
  const repoDir = join(f.dir, 'tasks', task.id, 's-repo');
  mkdirSync(repoDir, { recursive: true });
  assert.equal(git(['-C', repoDir, 'init', '-q', '-b', 'main']).code, 0);
  git(['-C', repoDir, 'config', 'user.email', 'test@local']);
  git(['-C', repoDir, 'config', 'user.name', 'Test']);
  writeFileSync(join(repoDir, 'hello.txt'), 'line 1\nline 2\n');
  assert.equal(git(['-C', repoDir, 'add', 'hello.txt']).code, 0);
  assert.equal(git(['-C', repoDir, 'commit', '-q', '-m', 'base']).code, 0);
  const baseCommit = git(['-C', repoDir, 'rev-parse', 'HEAD']).out.trim();
  assert.equal(git(['-C', repoDir, 'update-ref', 'refs/remotes/origin/main', baseCommit]).code, 0);
  assert.equal(git(['-C', repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']).code, 0);

  // Make a committed edit on top of origin/HEAD
  writeFileSync(join(repoDir, 'hello.txt'), 'line 1\nline 2 modified\nline 3\n');
  assert.equal(git(['-C', repoDir, 'add', 'hello.txt']).code, 0);
  assert.equal(git(['-C', repoDir, 'commit', '-q', '-m', 'update hello']).code, 0);
  const headCommit = git(['-C', repoDir, 'rev-parse', 'HEAD']).out.trim();

  // Also add an uncommitted untracked file
  writeFileSync(join(repoDir, 'new-file.ts'), 'export const x = 1;\nexport const y = 2;\n');

  const res = await get(`/api/tasks/${task.id}/diff`);
  assert.equal(res.status, 200);
  const diff = await json(res);
  assert.equal(diff.source, 'git');
  assert.equal(diff.commit, headCommit);
  assert.equal(diff.base, baseCommit);
  assert.equal(diff.truncated, false);
  const hello = diff.files.find((file: any) => file.path === 'hello.txt');
  assert.ok(hello, 'committed file included');
  assert.equal(hello.status, 'modified');
  assert.equal(hello.additions, 2);
  assert.equal(hello.deletions, 1);
  assert.match(hello.patch, /\+line 2 modified/);

  const added = diff.files.find((file: any) => file.path === 'new-file.ts');
  assert.ok(added, 'untracked new file included');
  assert.equal(added.status, 'added');
  assert.equal(added.additions, 2);
  assert.equal(added.deletions, 0);
});

test('readTaskDiff falls back to executor events when no local repo exists, and returns none otherwise', async (t) => {
  const { f, get, emitRun } = await consoleApp(t);
  const emptyTask = f.queuedTask();

  // No repo and no runs -> source: 'none'
  const noneDiff = await json(await get(`/api/tasks/${emptyTask.id}/diff`));
  assert.deepEqual(noneDiff, {
    source: 'none',
    commit: null,
    base: null,
    branch: null,
    files: [],
    truncated: false,
    reason: '本任务暂无可审阅的代码改动',
  });

  // Remote/non-repo run with tool.end changes -> source: 'executor'
  const { task, run } = f.runningRun();
  const commit = 'c0ffee1234567';
  emitRun(run.id, {
    kind: 'tool.end',
    id: 'call-1',
    isError: false,
    changes: [
      {
        path: 'src/app.ts',
        op: 'update',
        patch: '@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;',
      },
      {
        path: 'src/new.ts',
        op: 'add',
        patch: '+export const ok = true;',
      },
    ],
  });
  f.ledger.settleRun(run.id, 0, {
    status: 'done',
    summary: '完成',
    artifacts: [{ kind: 'commit', ref: commit }, { kind: 'report', ref: 'r.md' }],
  });

  const execDiff = await json(await get(`/api/tasks/${task.id}/diff`));
  assert.equal(execDiff.source, 'executor');
  assert.equal(execDiff.commit, commit);
  assert.equal(execDiff.files.length, 2);
  assert.equal(execDiff.files[0].path, 'src/app.ts');
  assert.equal(execDiff.files[0].status, 'modified');
  assert.equal(execDiff.files[0].additions, 2);
  assert.equal(execDiff.files[0].deletions, 1);
  assert.equal(execDiff.files[1].path, 'src/new.ts');
  assert.equal(execDiff.files[1].status, 'added');

  // Truncation cap check
  const bigPatch = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -1,1 +1,5000 @@\n${'+1234567890'.repeat(40_000)}`;
  const parsed = parseUnifiedDiff(bigPatch, 1024);
  assert.equal(parsed.truncated, true);
  assert.ok(Buffer.byteLength(parsed.files[0]!.patch, 'utf8') <= 1024);
});

test('POST /api/tasks/:id/rollback validates hex SHA and queues safe continue instruction', async (t) => {
  const { f, post } = await consoleApp(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成' });

  // Invalid SHAs rejected
  assert.equal((await post(`/api/tasks/${task.id}/rollback`, { commit: 'not-a-sha' })).status, 400);
  assert.equal((await post(`/api/tasks/${task.id}/rollback`, { commit: 'abc123' })).status, 400);
  assert.equal((await post(`/api/tasks/${task.id}/rollback`, {})).status, 400);

  // Valid SHA queues safe rollback continue instruction
  const sha = 'deadbeef1234';
  const res = await post(`/api/tasks/${task.id}/rollback`, { commit: sha });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.equal(body.commit, sha);
  assert.equal(body.queued, true);
  assert.equal(f.task(task.id).state, 'queued');
  const inputs = f.ledger.listInputs(task.id);
  assert.equal(inputs.at(-1)?.text, `将当前工作分支代码回退到提交 ${sha} 并汇报状态，不强推远端`);
});

test('PWA manifest and console/index.html links are valid', () => {
  const manifestPath = new URL('../console/public/manifest.webmanifest', import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.name, 'Tycho');
  assert.equal(manifest.short_name, 'Tycho');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.theme_color, '#0D1322');
  assert.equal(manifest.background_color, '#050811');

  const html = readFileSync(new URL('../console/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"[^>]*\/?>/);
  assert.match(html, /<meta\s+name="theme-color"[^>]*content="#E9EDF4"\s*\/?>/);
  assert.match(html, /<meta\s+name="theme-color"[^>]*content="#050811"\s*\/?>/);
});

test('readTaskDiff uses source_head.start as preferred base and reads source_head.head / remote_head for run commits', { skip: noGit }, async (t) => {
  const { f, get } = await consoleApp(t);
  const { task, run: run1 } = f.runningRun();

  const repoDir = join(f.dir, 'tasks', task.id, 's-repo');
  mkdirSync(repoDir, { recursive: true });
  assert.equal(git(['-C', repoDir, 'init', '-q', '-b', 'main']).code, 0);
  git(['-C', repoDir, 'config', 'user.email', 'test@local']);
  git(['-C', repoDir, 'config', 'user.name', 'Test']);

  // C1 = origin/HEAD
  writeFileSync(join(repoDir, 'a.txt'), 'v1\n');
  assert.equal(git(['-C', repoDir, 'add', 'a.txt']).code, 0);
  assert.equal(git(['-C', repoDir, 'commit', '-q', '-m', 'c1']).code, 0);
  const c1 = git(['-C', repoDir, 'rev-parse', 'HEAD']).out.trim();
  assert.equal(git(['-C', repoDir, 'update-ref', 'refs/remotes/origin/main', c1]).code, 0);
  assert.equal(git(['-C', repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']).code, 0);

  // C2 = commit from run1 (no receipt commit, only source_head.head)
  writeFileSync(join(repoDir, 'a.txt'), 'v2\n');
  assert.equal(git(['-C', repoDir, 'add', 'a.txt']).code, 0);
  assert.equal(git(['-C', repoDir, 'commit', '-q', '-m', 'c2']).code, 0);
  const c2 = git(['-C', repoDir, 'rev-parse', 'HEAD']).out.trim();
  f.ledger.settleRun(run1.id, 0, { status: 'done', summary: '轮次一' }, {
    sourceHead: { kind: 'repo', head: c2, start: c1, branch: 'main' },
  });

  // C3 = commit from run2, starting from c2
  f.ledger.reworkTask(task.id, '继续改 b.txt', f.task(task.id).revision, USER);
  const run2 = f.ledger.createRun(task.id, { ...f.login, expectedRevision: f.task(task.id).revision }, USER);
  f.ledger.markRunRunning(run2.id);
  writeFileSync(join(repoDir, 'b.txt'), 'from run2\n');
  assert.equal(git(['-C', repoDir, 'add', 'b.txt']).code, 0);
  assert.equal(git(['-C', repoDir, 'commit', '-q', '-m', 'c3']).code, 0);
  const c3 = git(['-C', repoDir, 'rev-parse', 'HEAD']).out.trim();
  f.ledger.settleRun(run2.id, 0, { status: 'done', summary: '轮次二' }, {
    sourceHead: { kind: 'repo', head: c3, start: c2, branch: 'main' },
  });

  // Requesting ?run=<run2.id> should use run2's source_head.start (c2) as base, showing only b.txt!
  const run2Diff = await json(await get(`/api/tasks/${task.id}/diff?run=${run2.id}`));
  assert.equal(run2Diff.source, 'git');
  assert.equal(run2Diff.base, c2);
  assert.equal(run2Diff.commit, c3);
  assert.deepEqual(run2Diff.files.map((file: any) => file.path), ['b.txt']);

  // Requesting ?run=<run1.id> should resolve commit=c2 from source_head.head (not non-existent end/commit) and diff c1..c2
  const run1Diff = await json(await get(`/api/tasks/${task.id}/diff?run=${run1.id}`));
  assert.equal(run1Diff.source, 'git');
  assert.equal(run1Diff.base, c1);
  assert.equal(run1Diff.commit, c2);
  assert.deepEqual(run1Diff.files.map((file: any) => file.path), ['a.txt']);

  // Also check source_head.remote_head fallback when source_head.head is null
  const { task: remoteTask, run: remoteRun } = f.runningRun();
  const remoteSha = 'f'.repeat(40);
  f.ledger.settleRun(remoteRun.id, 0, {
    status: 'done',
    summary: '远端提交',
    file_changes: [{ path: 'remote.ts', op: 'add', patch: '+export const r = 1;' }],
  }, {
    sourceHead: { kind: 'repo', head: null, remote_head: remoteSha, start: c1, branch: 'feat/remote' },
  });
  const remoteDiff = await json(await get(`/api/tasks/${remoteTask.id}/diff`));
  assert.equal(remoteDiff.source, 'executor');
  assert.equal(remoteDiff.commit, remoteSha);
  assert.equal(remoteDiff.base, c1);
  assert.equal(remoteDiff.branch, 'feat/remote');
});

test('readTaskDiff supports local kind=folder git sources directly on host', { skip: noGit }, async (t) => {
  const { f } = await consoleApp(t);
  const folderRepo = join(f.dir, 'external-folder-repo');
  mkdirSync(folderRepo, { recursive: true });
  assert.equal(git(['-C', folderRepo, 'init', '-q', '-b', 'main']).code, 0);
  git(['-C', folderRepo, 'config', 'user.email', 'test@local']);
  git(['-C', folderRepo, 'config', 'user.name', 'Test']);
  writeFileSync(join(folderRepo, 'index.ts'), 'export const v = 1;\n');
  assert.equal(git(['-C', folderRepo, 'add', 'index.ts']).code, 0);
  assert.equal(git(['-C', folderRepo, 'commit', '-q', '-m', 'init']).code, 0);
  const baseCommit = git(['-C', folderRepo, 'rev-parse', 'HEAD']).out.trim();

  writeFileSync(join(folderRepo, 'index.ts'), 'export const v = 2;\n');
  assert.equal(git(['-C', folderRepo, 'add', 'index.ts']).code, 0);
  assert.equal(git(['-C', folderRepo, 'commit', '-q', '-m', 'bump']).code, 0);
  const headCommit = git(['-C', folderRepo, 'rev-parse', 'HEAD']).out.trim();

  const sourceJson = JSON.stringify({
    source_id: 'src-folder-1',
    pinned: { id: 'src-folder-1', kind: 'folder', machine_uid: 'host-uid', path: folderRepo },
  });

  const diff = await readTaskDiff({
    dataDir: f.dir,
    task: { id: 'task-folder-test', source_json: sourceJson },
    runs: [],
  });
  assert.equal(diff.source, 'git');
  assert.equal(diff.commit, headCommit);
  assert.equal(diff.base, baseCommit);
  assert.equal(diff.branch, 'main');
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0]?.path, 'index.ts');
  assert.match(diff.files[0]?.patch ?? '', /\+export const v = 2;/);
});

test('readTaskDiff serves persisted diff.json snapshot for remote runs when no local git repo exists', async (t) => {
  const { f, get } = await consoleApp(t);

  // Layout 1: <dataDir>/tasks/<taskId>/runs/<runId>/diff.json with structured files
  const { task: task1, run: run1 } = f.runningRun();
  const sha1 = 'a'.repeat(40);
  const start1 = '1'.repeat(40);
  f.ledger.settleRun(run1.id, 0, { status: 'done', summary: '远端完成' }, {
    sourceHead: { kind: 'repo', head: sha1, start: start1, branch: 'feat/node' },
  });
  const runDir1 = join(f.dir, 'tasks', task1.id, 'runs', run1.id);
  mkdirSync(runDir1, { recursive: true });
  writeFileSync(join(runDir1, 'diff.json'), JSON.stringify({
    source: 'git',
    files: [
      {
        path: 'src/remote.ts',
        status: 'modified',
        patch: 'diff --git a/src/remote.ts b/src/remote.ts\n@@ -1,1 +1,2 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;',
      },
    ],
    truncated: false,
  }));

  const diff1 = await json(await get(`/api/tasks/${task1.id}/diff`));
  assert.equal(diff1.source, 'git');
  assert.equal(diff1.commit, sha1);
  assert.equal(diff1.base, start1);
  assert.equal(diff1.branch, 'feat/node');
  assert.equal(diff1.files.length, 1);
  assert.equal(diff1.files[0].path, 'src/remote.ts');
  assert.equal(diff1.files[0].additions, 2);
  assert.equal(diff1.files[0].deletions, 1);

  // Layout 2: <dataDir>/runs/<runId>/diff.json with raw unified patch string
  const { task: task2, run: run2 } = f.runningRun();
  const sha2 = 'b'.repeat(40);
  f.ledger.settleRun(run2.id, 0, { status: 'done', summary: '远端补丁' });
  const runDir2 = join(f.dir, 'runs', run2.id);
  mkdirSync(runDir2, { recursive: true });
  writeFileSync(join(runDir2, 'diff.json'), JSON.stringify({
    commit: sha2,
    base: start1,
    branch: 'main',
    patch: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n',
  }));

  const diff2 = await json(await get(`/api/tasks/${task2.id}/diff`));
  assert.equal(diff2.source, 'git');
  assert.equal(diff2.commit, sha2);
  assert.equal(diff2.base, start1);
  assert.equal(diff2.branch, 'main');
  assert.equal(diff2.files.length, 1);
  assert.equal(diff2.files[0].path, 'README.md');
  assert.equal(diff2.files[0].additions, 1);
  assert.equal(diff2.files[0].deletions, 0);
});
