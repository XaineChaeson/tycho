// Guards that a release coming back leaves the ledger as it was left, and that what the
// ledger records of a Router driver is cleared by the service itself rather than by the
// upgrade:
// - a message a candidate received through its own API is still there after the rollback,
//   and so are the decision and the Run that were there before: the new version's rows are
//   kept, and the old version opens what the new one wrote;
// - a Router driver the ledger still says may be running is cleared when the service starts
//   (docs/design/project-sessions.md §3): its marker is gone from the process table
//   afterwards, and the rollback that follows goes through rather than being refused.
// Every service here is this repository's own, from a real release unpacked into the prefix.
//
// The service manager is the one thing stood in for (see cli-release-live-fixture.ts).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { consoleSession } from '../cli/service-client.ts';
import { openLedger } from '../service/ledger.ts';
import { hostProcesses } from '../service/processes.ts';
import { readReleaseResult } from '../service/releases.ts';
import { LOGIN, USER } from './helpers.ts';
import {
  NODE, OLD, NEW, currentOf, installVersion, liveStage, loseConsoleAssets, manager, oldUp, ownUnit, sayToService, scanWorks, seedProject,
} from './cli-release-live-fixture.ts';

test('控制台登录请求中断时报告核对失败', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-login-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'login-token'), 'token');
  for (const failingMethod of ['GET', 'POST']) {
    const server = createServer((req, res) => {
      if (req.url === '/api/login-links') {
        res.end(JSON.stringify({ path: '/login', external: false }));
      } else if (req.method === failingMethod) {
        req.socket.destroy();
      } else {
        res.end('login');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const result = await consoleSession(dir, { state: 'running', pid: process.pid, port: address.port, token: 'token', version: '1', programDir: dir, dataDir: dir, startedAt: '' });
      assert.ok('problem' in result);
      assert.match(result.problem, /登录请求失败/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  }
});

test('候选期间写进账本的消息，回退后还在；决定和 Run 也一个不少', { timeout: 240_000 }, async (t) => {
  // Outlast the test timeout so the candidate cannot pass observation before the test
  // kills it after the message is accepted. All other deadlines use the real clock.
  const live = liveStage(t, { healthWindowMs: 600_000 });
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  ownUnit(s, prefix);
  // What was in the ledger before the release: a Run of an earlier Task.
  const seeded = openLedger(join(s.dataDir, 'ledger.db'));
  const projectId = seedProject(seeded, '试跑');
  const task = seeded.createTask({ roleId: 'implement', projectId, title: '任务', goal: '目标', acceptance: '测试通过' }, USER);
  seeded.queueTask(task.id, USER);
  const run = seeded.createRun(task.id, { ...LOGIN, machine: seeded.getMachine('h1')!, login: seeded.getMachineLogin('h1', 'claude')! }, USER);
  seeded.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  seeded.close();
  await oldUp(t, prefix, s.dataDir);
  const m = manager(t, live);

  const upgrading = installVersion(live, NEW);
  const candidate = await m.serve('请服务管理器启动新版');
  assert.ok(candidate, `这一版先起得来。${m.said()}`);
  // Written through the candidate itself, the way the owner's next message would be.
  assert.equal(await sayToService(s.dataDir, '把发布包打出来', projectId), 201, '插话应当被接住');
  candidate.kill();
  assert.notEqual(await m.serve('请服务管理器把旧版启动回来'), null, `回退后旧版要起来。${m.said()}`);
  assert.equal(await upgrading, 1, s.text());
  assert.equal(currentOf(prefix), OLD);
  assert.match(s.err.join('\n'), /已经退回 1\.0\.0，账本没有动/);

  const after = openLedger(join(s.dataDir, 'ledger.db'), { readOnly: true });
  try {
    const texts = after.listMessages({ limit: 10 }).map(({ text }) => text);
    assert.ok(texts.includes('把发布包打出来'), `候选收下的消息要还在：${texts.join(' | ')}`);
    assert.deepEqual(after.listRuns(task.id).map(({ id }) => id), [run.id]);
  } finally {
    after.close();
  }
  assert.equal(readReleaseResult(s.dataDir)!.rolled_back, true);
  await m.stopAll();
});

// Every Router context the ledger says may still run is cleared by the service at its stop and
// its start (docs/design/project-sessions.md §3), a closed one included: what is left of a driver
// the ledger knows about does not outlive the release. A leftover that cannot be cleared keeps the
// release where it is: rollbackDecision and peekLedger have that in cli-release-live-driver.test.ts.
test('账本记着的负责人残留由服务自己清掉：清掉之后照常回退', async (t) => {
  const live = liveStage(t);
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  ownUnit(s, prefix);
  // A driver of a context the ledger closed and wrote its pid as gone, but whose processes were
  // never seen gone (its live mark stands): the marker is all that is left of it, and it is
  // what a service scans for at its start and its stop. Its marker is on its command line,
  // which is where the scan looks for it, and a process just started is not in the table yet.
  const marker = '11111111-2222-3333-4444-555555555555';
  const scans = await scanWorks();
  if (!scans) {
    t.skip('这台机器上清点进程表跑不了');
    return;
  }
  const leftover = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' });
  t.after(() => void leftover.kill());
  for (let waited = 0; !(await hostProcesses.find(marker)).includes(leftover.pid!); waited += 100) {
    assert.ok(waited < 10_000, `留下的驱动者要能被清点看见（进程 ${leftover.pid}）`);
    await sleep(100);
  }
  const seeded = openLedger(join(s.dataDir, 'ledger.db'));
  const project = seeded.createProject({ name: '试跑' }, USER);
  const context = seeded.openContext({ projectId: project, segmentId: seeded.ensureSegment(project).id, marker, launch: {}, knowledge: [] });
  seeded.setContextStarted(context.id, null);
  seeded.closeContext(context.id, '换了登录');
  seeded.close();
  await oldUp(t, prefix, s.dataDir);
  const m = manager(t, live);
  // The service that holds the ledger clears it before anything else.
  for (let waited = 0; (await hostProcesses.find(marker)).length > 0; waited += 100) {
    assert.ok(waited < 15_000, '服务启动时清掉账本记着的残留');
    await sleep(100);
  }
  const upgrading = installVersion(live, NEW, { mutate: loseConsoleAssets });
  assert.notEqual(await m.serve('请服务管理器启动新版'), null, m.said());
  assert.notEqual(await m.serve('请服务管理器把旧版启动回来'), null, `回退后旧版要起来。${m.said()}`);
  assert.equal(await upgrading, 1, s.text());
  assert.deepEqual(await hostProcesses.find(marker), [], '账本记着的残留被服务清掉了');
  assert.match(s.err.join('\n'), /已经退回 1\.0\.0，账本没有动/);
  assert.equal(currentOf(prefix), OLD);
  await m.stopAll();
});
