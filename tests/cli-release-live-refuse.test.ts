// Guards what the automatic path refuses before anything moves: nothing is stopped, no
// version is switched, and the answer says which condition failed.
// - the ledger is not the schema this version writes: the package is refused while the
//   service is still running and the ledger is untouched, and no version directory is left;
// - the package declares no ledger version, or one that disagrees with its own program: the
//   proof that this release can be taken back is missing, so only a hand-run install goes;
// - a service that does not belong to this installation's autostart: nothing could stop it
//   and nothing would start the new version in its place, so the console's release is
//   refused outright, with the two ways out, and neither the intent nor `current` is written;
// - the environment such a service is started with: no PATH and no native executor install
//   of the owner's, so a test release can never reach the developer's own Claude Code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { locate } from '../node/locate.ts';
import { consoleSession, serviceState } from '../cli/service-client.ts';
import { SCHEMA_VERSION } from '../service/db.ts';
import { openLedger } from '../service/ledger.ts';
import { peekLedger } from '../service/ledger-peek.ts';
import { readReleaseIntent, readReleaseResult, registrationDir } from '../service/releases.ts';
import { serviceEnv, startRealService } from './cli-helpers.ts';
import { LOGIN, USER } from './helpers.ts';
import { NEW, OLD, currentOf, declareLedger, installVersion, liveStage, manager, oldLedger, seedProject, versionsIn } from './cli-release-live-fixture.ts';

test('release service environments exclude the owner native executor installs as well as PATH', () => {
  const before = { ...process.env };
  try {
    for (const platform of ['linux', 'win32'] as const) {
      process.env.HOME = '/owner';
      process.env.USERPROFILE = 'C:\\owner';
      const native = platform === 'linux' ? '/owner/.local/bin/claude' : 'C:\\owner\\.local\\bin\\claude.exe';
      const found = locate('claude', {
        platform, env: serviceEnv(join(import.meta.dirname, 'isolated-service')),
        isFile: (file) => file === native, realpath: (file) => file,
        listDirs: () => [], registry: () => undefined,
      });
      assert.equal(found.path, undefined, `${platform}: 测试发布的服务不能找到主人的原生执行器`);
    }
  } finally {
    for (const key of ['HOME', 'USERPROFILE']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test('账本比这一版旧：自动上线不装，什么都不换', async (t) => {
  const live = liveStage(t);
  const { s, prefix } = live;
  oldLedger(join(s.dataDir, 'ledger.db'), SCHEMA_VERSION - 1);
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  const before = peekLedger(join(s.dataDir, 'ledger.db'), 'stopped');
  const m = manager(t, live);

  const code = await installVersion(live, NEW);
  assert.equal(code, 1, s.text());
  assert.match(s.err.join('\n'), new RegExp(`账本现在是版本 ${SCHEMA_VERSION - 1}，这一版要写到 ${SCHEMA_VERSION}`));
  assert.match(s.err.join('\n'), /这次什么都没有换/);
  assert.equal(currentOf(prefix), OLD);
  assert.deepEqual(versionsIn(prefix), [OLD], '没有装上的版本不留目录');
  assert.equal(m.starts(), 0, '没有让服务管理器启动过任何东西');
  assert.equal(m.stops(), 0, '没有停过服务');
  assert.deepEqual(peekLedger(join(s.dataDir, 'ledger.db'), 'stopped'), before, '账本没有被动过');
  await m.stopAll();
});

test('包没有声明账本版本，或声明和自己的程序对不上：自动上线不装', async (t) => {
  const live = liveStage(t);
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());

  const noDeclaration = await installVersion(live, '1.2.0', {
    mutate: (root) => {
      const manifest = join(root, 'package.json');
      const read = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      delete read.tycho;
      writeFileSync(manifest, JSON.stringify(read));
    },
  });
  assert.equal(noDeclaration, 1, s.text());
  assert.match(s.err.join('\n'), /没有声明这一版写的账本版本和能退回上一版的依据/);

  const wrongDeclaration = await installVersion(live, '1.3.0', { mutate: declareLedger(SCHEMA_VERSION + 1) });
  assert.equal(wrongDeclaration, 1, s.text());
  assert.match(s.err.join('\n'), new RegExp(`这个包声明它写的账本是版本 ${SCHEMA_VERSION + 1}，它自己的程序却是 ${SCHEMA_VERSION}`));
  assert.equal(currentOf(prefix), OLD);
  assert.deepEqual(versionsIn(prefix), [OLD]);

  // The same package by hand: the owner typing the command is the decision, and the
  // automatic path's proof is not asked for.
  assert.equal(await installVersion(live, '1.3.0', { automatic: false, mutate: declareLedger(SCHEMA_VERSION + 1) }), 0, s.text());
  assert.equal(currentOf(prefix), '1.3.0');
});

// The console's release promises a health check and a way back to the version before it.
// Both are the autostart's to give: it is what stops the service and what starts the next
// version in its place. A service the owner runs in the foreground is nobody's to stop, so
// the click is answered with that fact and the two ways out — and nothing is written or
// switched, which is what the intent file and `current` are read for.
test('服务不归开机自启管（前台运行）：控制台的上线被明确拒绝，什么都不换', async (t) => {
  // The installation is this machine's, so the launcher the service looks for is the one
  // the installer wrote; what is missing is the autostart, which is the point.
  const live = liveStage(t, {
    platform: process.platform,
    respond: (call) => (call.env.TYCHO_TASK ? { stdout: 'absent\r\n' } : call.env.TYCHO_OP ? { stdout: 'unchanged\r\n' } : undefined),
  });
  const { s, prefix } = live;
  assert.equal(await installVersion(live, OLD, { automatic: false }), 0, s.text());
  // The package the owner would put in place, in the shape the console receives it: a
  // round's registration in the ledger and the directory it names. The service checks
  // name, digest and size against it before it starts anything.
  const pkg = Buffer.from('发布包的内容，够长到要分几次读');
  const sum = createHash('sha256').update(pkg).digest('hex');
  const seeded = openLedger(join(s.dataDir, 'ledger.db'));
  let runId: string;
  try {
    const project = seedProject(seeded, '上线');
    const task = seeded.createTask({ projectId: project, title: '新版', goal: '新版', acceptance: '测试通过', roleId: 'implement' }, USER);
    seeded.queueTask(task.id, USER);
    runId = seeded.createRun(task.id, { ...LOGIN, machine: seeded.getMachine('h1')!, login: seeded.getMachineLogin('h1', 'claude')! }, USER).id;
    const registration = seeded.registerArtifacts(runId, [{ name: `tycho-${NEW}.tar.gz`, sha256: sum, bytes: pkg.length }]);
    const dir = registrationDir(s.dataDir, runId, registration);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `tycho-${NEW}.tar.gz`), pkg);
  } finally {
    seeded.close();
  }
  const before = readReleaseResult(s.dataDir);

  const service = await startRealService(t, prefix, s.dataDir);
  assert.notEqual(service.port, null, '服务要起得来');
  const state = await serviceState(s.dataDir);
  assert.equal(state.state, 'running');
  const session = await consoleSession(s.dataDir, state);
  assert.ok('cookie' in session, 'cookie' in session ? '' : session.problem);

  const answer = await fetch(`http://127.0.0.1:${service.port}/api/releases/${runId}/launch?confirm=1`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${service.port}` },
    body: JSON.stringify({ name: `tycho-${NEW}.tar.gz`, sha256: sum, bytes: pkg.length }),
  });
  assert.equal(answer.status, 400);
  const { error } = (await answer.json()) as { error: string };
  assert.match(error, /不归开机自启管/);
  assert.match(error, /没有谁能把新版本启起来核对/);
  assert.match(error, /tycho service install/, '说清怎么办');
  assert.match(error, /tycho update --from/);
  // Refused before anything was recorded or started.
  assert.equal(readReleaseIntent(s.dataDir), null, '拒绝发生在写下发布意图之前');
  assert.deepEqual(readReleaseResult(s.dataDir), before, '没有记下一次没有做的上线');
  assert.equal(currentOf(prefix), OLD);
});
