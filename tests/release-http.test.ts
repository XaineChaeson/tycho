// Guards the two ends of a release the console has anything to do with:
// - accepting a Task taking back what its Run left under artifacts/, over the Runner's
//   read channel, into <数据目录>/releases/<run>/<登记编号>/ under the registration the
//   ledger commits for it, and the page then offering it — and only for an acceptance
//   that happened, so a Task that cannot be accepted leaves no package the page could
//   offer;
// - fetching again for a Task that was accepted while its machine was out of reach;
// - putting one in place: an ask without a confirmation, for a Run whose package is not
//   the one that was confirmed, or from a visitor who is not signed in being refused; a
//   good one starting the upgrade command on the package the console named and answering
//   with the state of the release already under way instead of starting a second one;
// - what only the running service knows about itself (its ledger, whether it can be
//   written, its inventory, the observation window) being answered on the inside listener
//   only, to a request with its token.
//
// The HTTP surface is exercised on a real ledger through its real routes; the Runner is
// stood in for, because there is no machine to read from here (cli-release-live.test.ts
// covers the same paths against a real service/main.ts).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readReleaseResult, registrationDir, writeReleaseResult } from '../service/releases.ts';
import { consoleApp, SHUTDOWN_TOKEN } from './console-helpers.ts';
import { DONE, fixture } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();

const PACKAGE = Buffer.from('发布包的内容，够长到要分几次读');
const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

test('验收时把 Run 的产物取回 <数据目录>/releases/<run>/<登记编号>/，任务页随之给出上线入口', async (t) => {
  const asked: string[] = [];
  const { f, get, post } = await consoleApp(t, {
    runner: {
      async fetchArtifacts(run, into) {
        asked.push(run.id);
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(into, { recursive: true });
        writeFileSync(join(into, 'tycho-1.2.0.tar.gz'), PACKAGE);
        return { files: [{ name: 'tycho-1.2.0.tar.gz', sha256: sha(PACKAGE), bytes: PACKAGE.length }], problem: null };
      },
    },
  });
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const accepted = await post(`/api/tasks/${task.id}/accept`, { basis: '检查通过', without_review: true });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await json(accepted).then((body) => body.artifacts), { stored: ['tycho-1.2.0.tar.gz'], problem: null });
  assert.deepEqual(asked, [run.id]);

  const held = f.ledger.artifactsOfRun(run.id)!;
  const dir = registrationDir(f.dir, run.id, held.registration!.id);
  assert.equal(readFileSync(join(dir, 'tycho-1.2.0.tar.gz')).toString(), PACKAGE.toString());
  assert.deepEqual(held.registration!.files, [{ name: 'tycho-1.2.0.tar.gz', sha256: sha(PACKAGE), bytes: PACKAGE.length }]);

  const page = await json(await get(`/api/tasks/${task.id}`));
  assert.deepEqual(page.releases.packages.map((each: { file: string; version: string }) => [each.file, each.version]), [['tycho-1.2.0.tar.gz', '1.2.0']]);
  assert.equal(page.releases.last, null);
  // Another Task's page is not offered this Task's package.
  const other = await json(await get(`/api/tasks/${f.queuedTask().id}`));
  assert.deepEqual(other.releases.packages, []);
});

test('产物取不回来时说清楚，验收照常记下，原因留在记录里', async (t) => {
  const { f, post } = await consoleApp(t, {
    runner: { fetchArtifacts: async () => ({ files: [], problem: '连不上 h1：ssh 超时' }) },
  });
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const accepted = await post(`/api/tasks/${task.id}/accept`, { basis: '检查通过', without_review: true });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await json(accepted).then((body) => body.artifacts), { stored: [], problem: '连不上 h1：ssh 超时' });
  assert.equal(f.task(task.id).state, 'done');
  // Not only in that one answer: the ledger keeps it beside the round, so the page can
  // say it after a reload and offer asking again.
  assert.equal(f.ledger.artifactsOfRun(run.id)?.problem?.problem, '连不上 h1：ssh 超时');
  assert.equal(f.ledger.artifactsOfRun(run.id)?.registration, null, '取不回来就没有登记');
  const later = await consoleApp(t, { f });
  const page = await json(await later.get(`/api/tasks/${task.id}`));
  assert.deepEqual(page.releases.fetch, { registered: null, failed: { at: page.releases.fetch.failed.at, problem: '连不上 h1：ssh 超时' } });
});

test('重新取产物：验收过的任务可以再取一次，没验收的不行', async (t) => {
  let answer: { files: { name: string; sha256: string; bytes: number }[]; problem: string | null } = { files: [], problem: '连不上 h1：ssh 超时' };
  const asked: string[] = [];
  const { f, get, post } = await consoleApp(t, {
    runner: {
      async fetchArtifacts(run, into) {
        asked.push(run.id);
        if (answer.files.length === 0) return answer;
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(into, { recursive: true });
        writeFileSync(join(into, 'tycho-1.2.0.tar.gz'), PACKAGE);
        return answer;
      },
    },
  });
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  assert.equal((await post(`/api/tasks/${task.id}/artifacts`)).status, 400, '还没有验收');
  assert.deepEqual(asked, []);
  await post(`/api/tasks/${task.id}/accept`, { basis: '检查通过', without_review: true });
  assert.deepEqual(asked, [run.id]);

  answer = { files: [{ name: 'tycho-1.2.0.tar.gz', sha256: sha(PACKAGE), bytes: PACKAGE.length }], problem: '连不上 h1：ssh 超时' };
  const again = await post(`/api/tasks/${task.id}/artifacts`);
  assert.equal(again.status, 200);
  assert.deepEqual(await json(again), { stored: ['tycho-1.2.0.tar.gz'], problem: '连不上 h1：ssh 超时' });
  assert.deepEqual(asked, [run.id, run.id], '主人要的这一次才再取一次');
  // Half of it came back with a problem: nothing is registered, so nothing is offered.
  assert.deepEqual((await json(await get(`/api/tasks/${task.id}`))).releases.packages, []);
  answer = { ...answer, problem: null };
  assert.deepEqual(await json(await post(`/api/tasks/${task.id}/artifacts`)), { stored: ['tycho-1.2.0.tar.gz'], problem: null });
  const page = await json(await get(`/api/tasks/${task.id}`));
  assert.deepEqual([page.releases.packages.map((each: { file: string }) => each.file), page.releases.fetch.failed], [['tycho-1.2.0.tar.gz'], null]);
  assert.deepEqual(page.releases.fetch.registered.files, ['tycho-1.2.0.tar.gz']);

  // Asked again and failing this time: the package taken before stays offered, and the
  // page says the failure beside it, with the way to ask once more.
  answer = { files: [], problem: '机器又连不上了' };
  assert.deepEqual(await json(await post(`/api/tasks/${task.id}/artifacts`)), { stored: [], problem: '机器又连不上了' });
  const after = (await json(await get(`/api/tasks/${task.id}`))).releases;
  assert.deepEqual(after.packages.map((each: { file: string }) => each.file), ['tycho-1.2.0.tar.gz'], '之前取回的那一份照旧可用');
  assert.deepEqual([after.fetch.registered.files, after.fetch.failed.problem], [['tycho-1.2.0.tar.gz'], '机器又连不上了'], '失败也照实说');
  assert.equal((await post(`/api/tasks/${task.id}/artifacts`, undefined, {})).status, 401, '没登录不行');
});

test('上线：没有确认、包和确认的不一样、没登录，都不动手', async (t) => {
  const f = fixture(t);
  const launched: string[] = [];
  const { post } = await consoleApp(t, {
    f,
    releases: {
      dataDir: f.dir,
      version: '1.1.0',
      last: () => null,
      intent: () => null,
      attempting: () => false,
      launch: (runId) => {
        launched.push(runId);
        return { started: true, version: '1.2.0' };
      },
    },
  });
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const chosen = { name: 'tycho-1.2.0.tar.gz', sha256: sha(PACKAGE), bytes: PACKAGE.length };
  assert.equal((await post(`/api/releases/${run.id}/launch`, chosen)).status, 400, '要确认');
  assert.equal((await post(`/api/releases/${run.id}/launch?confirm=1`, undefined, {})).status, 401, '没登录不行');
  assert.equal((await post(`/api/releases/${run.id}/launch?confirm=1`, {})).status, 400, '要说上哪一个包');
  assert.deepEqual(launched, []);
  assert.equal(f.task(task.id).state, 'ready');
});

test('上线：确认了就以那个包启动升级命令，不再自己停服务', async (t) => {
  const f = fixture(t);
  const chosen: unknown[] = [];
  const { post, state } = await consoleApp(t, {
    f,
    releases: {
      dataDir: f.dir,
      version: '1.1.0',
      last: () => null,
      intent: () => null,
      attempting: () => false,
      launch: (runId, asked, ctx) => {
        if (runId !== 'run-1') throw new Error(`不认识的 Run：${runId}`);
        chosen.push(asked);
        // Who asked goes with it, for the line on the timeline.
        assert.match(ctx.actor, /^console:/);
        return { started: true, version: '1.2.0' };
      },
    },
  });
  const answer = await post('/api/releases/run-1/launch?confirm=1', { name: 'tycho-1.2.0.tar.gz', sha256: sha(PACKAGE), bytes: PACKAGE.length });
  assert.equal(answer.status, 202);
  assert.deepEqual(await json(answer), { started: true, version: '1.2.0' });
  assert.deepEqual(chosen, [{ name: 'tycho-1.2.0.tar.gz', sha256: sha(PACKAGE), bytes: PACKAGE.length }]);
  // Stopping this service is the upgrade command's to do, after the turn being handled:
  // the request that started it leaves the service running.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.shutdowns, 0);
});

test('上线：已经有一次在做，第二次请求得到它的状态，不再启动一个', async (t) => {
  const f = fixture(t);
  const launched: string[] = [];
  const intent = {
    at: '2026-01-01T00:00:00Z', run_id: 'run-1', name: 'tycho-1.2.0.tar.gz',
    version: '1.2.0', sha256: sha(PACKAGE), bytes: PACKAGE.length, file: '/releases/run-1/tycho-1.2.0.tar.gz',
  };
  const { post, get } = await consoleApp(t, {
    f,
    releases: {
      dataDir: f.dir,
      version: '1.1.0',
      last: () => null,
      intent: () => intent,
      attempting: () => true,
      launch: (runId) => {
        launched.push(runId);
        return { started: false, version: '1.2.0' };
      },
    },
  });
  const answer = await post('/api/releases/run-1/launch?confirm=1', { name: 'tycho-1.2.0.tar.gz', sha256: sha(PACKAGE), bytes: PACKAGE.length });
  assert.equal(answer.status, 202);
  assert.deepEqual(await json(answer), { started: false, version: '1.2.0' });
  const { task } = f.runningRun();
  const page = await json(await get(`/api/tasks/${task.id}`));
  assert.deepEqual({ attempting: page.releases.attempting, intent: page.releases.intent, last: page.releases.last }, { attempting: true, intent, last: null });
});

test('上线：要求过的那一次有了结果以后，页面上就不再是「没有下文」', async (t) => {
  const f = fixture(t);
  const intent = {
    at: '2026-01-01T00:00:00Z', run_id: 'run-1', name: 'tycho-1.2.0.tar.gz',
    version: '1.2.0', sha256: sha(PACKAGE), bytes: PACKAGE.length, file: '/releases/run-1/tycho-1.2.0.tar.gz',
  };
  const result = { at: '2026-01-01T00:01:00Z', from: '1.1.0', to: '1.2.0', verified: true, ok: true, rolled_back: false, in_use: '1.2.0', lines: [] };
  const { get } = await consoleApp(t, {
    f,
    releases: { dataDir: f.dir, version: '1.2.0', last: () => result, intent: () => intent, attempting: () => false, launch: () => ({ started: true, version: '1.2.0' }) },
  });
  const { task } = f.runningRun();
  const page = await json(await get(`/api/tasks/${task.id}`));
  assert.equal(page.releases.intent, null, '结果比意图新，就没有在等的那一次');
  assert.deepEqual(page.releases.last, result);
});

test('上线结果取自服务记下的那一次，页面上看得到验没验过、成没成、退没退、current 现在指哪一版', async (t) => {
  const f = fixture(t);
  const { get } = await consoleApp(t, { f });
  const { task } = f.runningRun();
  const result = { at: '2026-01-01T00:00:00Z', from: '1.1.0', to: '1.2.0', verified: true, ok: false, rolled_back: true, in_use: '1.1.0', lines: ['新版没有通过健康检查'] };
  writeReleaseResult(f.dir, result);
  const page = await json(await get(`/api/tasks/${task.id}`));
  assert.deepEqual(page.releases, { version: '0.0.0', last: result, intent: null, attempting: false, fetch: null, dropped: [], packages: [] });

  // A version that went in without ever being started: the page is told so, and is not left
  // to read it as a release that worked.
  const unverified = {
    at: '2026-01-01T00:02:00Z', from: '1.2.0', to: '1.3.0', verified: false, ok: false, rolled_back: false, in_use: '1.3.0',
    lines: ['装上了 tycho 1.3.0，但这一版还没有验证：这次没有把在跑的服务换到它上面，也就没有做健康检查，下次启动才生效。'],
  };
  writeReleaseResult(f.dir, unverified);
  assert.deepEqual((await json(await get(`/api/tasks/${task.id}`))).releases.last, unverified);
});

test('服务自己的状态和等待回合：只在内部监听上、只认自己的令牌', async (t) => {
  const { url, post, get } = await consoleApp(t, {
    releaseCheck: () => ({ ledger: 'ok', degraded: false, recovering: false, health_window_ms: 10_000 }),
    drain: async () => ({ drained: true, waited_ms: 1200 }),
  });
  const withToken = (path: string, token: string) => fetch(`${url}${path}`, { method: path === '/api/drain' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await withToken('/api/release-check', 'wrong')).status, 401);
  assert.equal((await get('/api/release-check')).status, 401);
  assert.deepEqual(await json(await withToken('/api/release-check', SHUTDOWN_TOKEN)), { ledger: 'ok', degraded: false, recovering: false, health_window_ms: 10_000 });
  assert.equal((await get('/api/drain')).status, 404, '等待回合是 POST');
  assert.deepEqual(await json(await withToken('/api/drain', SHUTDOWN_TOKEN)), { drained: true, waited_ms: 1200 });
  assert.equal((await post('/api/drain')).status, 401);

  // A ledger the service cannot read, and one it cannot write: each answered as such, not
  // as a failure of the route.
  const broken = await consoleApp(t, { releaseCheck: () => ({ ledger: 'database is locked', degraded: true, recovering: true, health_window_ms: 0 }) });
  const answer = await fetch(`${broken.url}/api/release-check`, { headers: { Authorization: `Bearer ${SHUTDOWN_TOKEN}` } });
  assert.deepEqual(await json(answer), { ledger: 'database is locked', degraded: true, recovering: true, health_window_ms: 0 });
});

test('一个 Run 什么都没留下：不建目录、不写记录，验收不因此失败', async (t) => {
  const { f, post } = await consoleApp(t, {
    runner: {
      // What a Runner returns when there is nothing under artifacts/.
      fetchArtifacts: async () => ({ files: [], problem: null }),
    },
  });
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const accepted = await post(`/api/tasks/${task.id}/accept`, { basis: '检查通过', without_review: true });
  assert.equal(accepted.status, 200);
  assert.equal(existsSync(join(f.dir, 'releases', run.id)), false, '没有产物就不建目录');
  assert.deepEqual(await json(accepted).then((body) => body.artifacts), { stored: [], problem: null });
});

// A registration and its directory, read back by the console: the shape the page depends on.
test('发布包记录：只有 tycho-<版本>.tar.gz 会出现在页面上', async (t) => {
  const { f, get } = await consoleApp(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const id = f.ledger.registerArtifacts(run.id, [
    { name: 'tycho-2.0.0.tar.gz', sha256: 'a'.repeat(64), bytes: 3 },
    { name: 'work.bundle', sha256: 'b'.repeat(64), bytes: 4 },
  ]);
  const dir = registrationDir(f.dir, run.id, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tycho-2.0.0.tar.gz'), 'abc');
  writeFileSync(join(dir, 'work.bundle'), 'defg');
  const page = await json(await get(`/api/tasks/${task.id}`));
  assert.deepEqual(page.releases.packages.map((each: { version: string }) => each.version), ['2.0.0']);
});
