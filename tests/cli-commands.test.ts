// Guards against the `tycho` command lying or doing harm at its edges: a mistyped command
// passing as success (exit codes), a second service started on a data directory that is
// already in use, a stop that reports "stopped" while the process lives on or that fails
// when there was nothing to stop, a login link asked of a service that is not there, a
// service started with the wrong data directory, and a child service whose failure or
// exit code is swallowed by the command that started it. Also against taking a pid and a
// port for a service (after a crash both can belong to another program), a relative
// TYCHO_DATA meaning one directory to the command and another to the service manager,
// `open` exiting 0 without a link, a terminal closing counted as a crash, a log that
// grows without bound while the service runs, and an entry point that does nothing and
// exits 0 on a Node too old for it. Also guards against `open --print` hiding the local
// recovery link when the public address is wrong, or opening that public link on the host;
// and against a one-time login link made for a service the autostart pulled up, whose output
// goes into a log file or a console nobody is reading. The trace a stub service keeps is
// read for how the service was told to stop, not for everything the command asked of it on
// the way there: a run not started by the autostart asks for a login link first, and that
// line is not what a stop is judged by.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runCli, proxyRestart } from '../cli/main.ts';
import { readRecord } from '../cli/record.ts';
import { realSystem } from '../cli/system.ts';
import { defaultPrefix } from '../cli/paths.ts';
import { dataDirOf } from '../service/config.ts';
import { ownerId } from '../cli/autostart.ts';
import { serviceSpec } from '../cli/install.ts';
import { identityOf, writeToken } from '../node/client.ts';
import { writeOrigin } from '../node/cli.ts';
import { releaseFiles } from '../scripts/pack.ts';
import { shownVersion } from '../cli/paths.ts';
import type { Stage } from './cli-helpers.ts';
import { alive, announced, exited, holdDataDir, releaseRoot, REPO, stage, startStub, stubApp, STUB_SERVICE, tempDir, until } from './cli-helpers.ts';
import { freePort } from './helpers.ts';

const MAIN = join(REPO, 'cli', 'main.ts');

// How the service was told to stop, out of the trace a stub service keeps. A run that the
// autostart did not pull up asks it for a login link on the way, which is not a stop, and
// which is what the trace would be read as by anyone comparing the whole file.
const stops = (trace: string): string[] =>
  readFileSync(trace, 'utf8').split('\n').map((each) => each.trim()).filter((each) => each !== '' && each !== 'login-link');

test('用法错退出码是 2，并指到 tycho help', async (t) => {
  for (const argv of [['bogus'], ['run', '--bogus'], ['service'], ['service', 'bogus'], ['restore'], ['stop', 'extra'], ['update', '--from']]) {
    const s = stage(t);
    assert.equal(await runCli(argv, s.cli), 2, argv.join(' '));
    assert.match(s.err.join('\n'), /tycho help/, argv.join(' '));
    assert.deepEqual(s.calls, [], '用法错的命令什么都不该运行');
    assert.equal(existsSync(s.dataDir), false, '用法错的命令不该建数据目录');
  }
});

test('version 和 help 不需要服务', async (t) => {
  const s = stage(t);
  assert.equal(await runCli(['version'], s.cli), 0);
  assert.match(s.out.join('\n'), /1\.0\.0/);
  for (const argv of [['help'], ['--help'], ['-h']]) {
    const h = stage(t);
    assert.equal(await runCli(argv, h.cli), 0);
    for (const command of ['run', 'open', 'stop', 'status', 'service', 'doctor', 'update', 'restore', 'uninstall', 'version']) {
      assert.match(h.out.join('\n'), new RegExp(`tycho ${command}`), `帮助里没有 ${command}`);
    }
  }
});

test('真实入口：退出码传到进程', () => {
  const version = spawnSync(process.execPath, [MAIN, 'version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^tycho \S+/);
  const bogus = spawnSync(process.execPath, [MAIN, 'bogus'], { encoding: 'utf8' });
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /tycho help/);
});

test('数据目录：TYCHO_DATA 优先，否则在主目录下；程序目录同理', (t) => {
  const home = tempDir(t);
  assert.equal(dataDirOf({ TYCHO_DATA: join(home, 'x', 'data') }, home), join(home, 'x', 'data'));
  assert.equal(dataDirOf({}, home), join(home, '.tycho', 'host'));
  assert.equal(dataDirOf({ TYCHO_DATA: '' }, home), join(home, '.tycho', 'host'));
  assert.equal(defaultPrefix({}, 'home'), join('home', '.tycho', 'app'));
  assert.equal(defaultPrefix({ TYCHO_PREFIX: 'p' }, 'home'), 'p');
});

test('相对的 TYCHO_DATA 在命令入口就解析成绝对路径：服务定义里记的不是那几个字', (t) => {
  const here = process.cwd();
  // Before the stage's own cleanup: a directory cannot be removed from inside it.
  t.after(() => process.chdir(here));
  const s = stage(t, { env: { TYCHO_DATA: join('some', 'data') } });
  process.chdir(s.dir);
  // The service manager starts the service in another directory, where the same words
  // would name another place.
  const { dataDir, logFile } = serviceSpec(s.cli.system, s.cli.appRoot);
  assert.equal(dataDir, resolve(s.dir, 'some', 'data'));
  assert.ok(isAbsolute(dataDir) && isAbsolute(logFile));
});

test('status：没跑、在跑、被占三种情况如实', async (t) => {
  const stopped = stage(t);
  assert.equal(await runCli(['status'], stopped.cli), 0);
  assert.match(stopped.text(), /没有在运行/);
  assert.match(stopped.text(), /1\.0\.0/);
  assert.ok(stopped.text().includes(stopped.dataDir));
  assert.match(stopped.text(), /开机自启：没有安装/);

  const running = stage(t);
  const child = await startStub(t, running.dataDir);
  const { port } = JSON.parse(readFileSync(join(running.dataDir, 'service.json'), 'utf8')) as { port: number };
  assert.equal(await runCli(['status'], running.cli), 0);
  assert.match(running.text(), new RegExp(`正在运行（进程 ${child.pid}，端口 ${port}）`));
  // The stub runs from the repository, not from the copy this command belongs to.
  assert.match(running.text(), /版本：1\.0\.0/);
  assert.ok(running.text().includes(`正在运行的版本：${shownVersion(REPO)}（${REPO}）`), running.text());
  assert.match(running.text(), /不是上面这一份/);

  const held = stage(t);
  holdDataDir(held.dataDir);
  assert.equal(await runCli(['status'], held.cli), 0);
  assert.match(held.text(), new RegExp(`进程 ${process.pid}`));
  assert.match(held.text(), /占/);
});

test('status：service.json 里的进程活着、却不是持锁的那个，不算在跑', async (t) => {
  // After a crash the old service's pid can belong to some other program.
  const reused = stage(t);
  mkdirSync(reused.dataDir);
  writeFileSync(join(reused.dataDir, 'service.json'), JSON.stringify({ pid: process.ppid, port: 9, token: 'x' }));
  assert.equal(await runCli(['status'], reused.cli), 0);
  assert.match(reused.text(), /没有在运行/);
  assert.doesNotMatch(reused.text(), /正在运行/);

  // And while something else holds the data directory, it is that process that counts.
  const held = stage(t);
  holdDataDir(held.dataDir);
  writeFileSync(join(held.dataDir, 'service.json'), JSON.stringify({ pid: process.ppid, port: 9, token: 'x' }));
  assert.equal(await runCli(['status'], held.cli), 0);
  assert.doesNotMatch(held.text(), /正在运行/);
  assert.match(held.text(), new RegExp(`进程 ${process.pid} 占着`));
  assert.equal(await runCli(['stop'], held.cli), 1, '不向一个不是本服务的进程发停止请求');
});

test('锁在另一台机器上：本机不接管、不启动，报出那台机器、进程号，和确认对方已停后怎么处理', async (t) => {
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await exited(gone);
  const pid = gone.pid!;
  const s = stage(t);
  mkdirSync(s.dataDir);
  const lock = join(s.dataDir, 'lock');
  const body = JSON.stringify({ pid, machine: 'another-machine', hostname: 'node-b', started_at: 'then' });
  writeFileSync(lock, body);

  assert.equal(await runCli(['status'], s.cli), 0);
  assert.match(s.text(), /node-b/);
  assert.match(s.text(), new RegExp(`进程 ${pid}`));
  assert.ok(s.text().includes(lock), `说明确认对方已停后删掉 ${lock}`);
  assert.match(s.text(), /删掉/);
  assert.doesNotMatch(s.text(), /正在运行/);
  assert.doesNotMatch(s.text(), /在启动/);

  assert.equal(await runCli(['stop'], s.cli), 1, '本机停不了另一台机器上的服务');
  assert.equal(await runCli(['run'], s.cli), 1, '不覆盖另一台机器的锁，也不启动');
  assert.equal(readFileSync(lock, 'utf8'), body, '锁文件原样不动');
  assert.equal(existsSync(join(s.dataDir, 'service.json')), false);
});

test('status：上次崩溃留下的 service.json 不算在跑', async (t) => {
  const s = stage(t);
  mkdirSync(s.dataDir);
  // A pid that is certainly gone: the stub's, after it was killed outright.
  const child = await startStub(t, s.dataDir);
  child.kill('SIGKILL');
  await exited(child);
  assert.ok(existsSync(join(s.dataDir, 'service.json')));
  assert.equal(await runCli(['status'], s.cli), 0);
  assert.match(s.text(), /没有在运行/);
  assert.match(s.text(), /没有正常退出/);
});

test('stop：在跑的被优雅停止，并等到进程真的退出', async (t) => {
  const s = stage(t);
  const trace = join(s.dir, 'trace');
  const child = await startStub(t, s.dataDir, { STUB_TRACE: trace, STUB_STOP_DELAY_MS: '300' });
  assert.equal(await runCli(['stop'], s.cli), 0);
  // The command came back only after the process was gone, not when the request was accepted.
  assert.equal(alive(child), false);
  assert.equal(readFileSync(trace, 'utf8'), 'shutdown\n');
  assert.equal(existsSync(join(s.dataDir, 'service.json')), false);
  assert.match(s.text(), /已停止/);
});

test('stop：停不下来时不说已停止', async (t) => {
  const s = stage(t);
  s.cli.timing.stopWaitMs = 200;
  await startStub(t, s.dataDir, { STUB_STOP_DELAY_MS: '60000' });
  assert.equal(await runCli(['stop'], s.cli), 1);
  assert.doesNotMatch(s.text(), /已停止/);
  assert.match(s.text(), /还没退出/);
});

test('stop：没在跑是成功，被占着是失败', async (t) => {
  const stopped = stage(t);
  assert.equal(await runCli(['stop'], stopped.cli), 0);
  assert.match(stopped.text(), /没有在运行/);
  assert.equal(existsSync(stopped.dataDir), false, 'stop 不该建数据目录');

  const held = stage(t);
  holdDataDir(held.dataDir);
  assert.equal(await runCli(['stop'], held.cli), 1);
  assert.match(held.text(), new RegExp(`进程 ${process.pid}`));
});

test('stop：登记了端口却没有服务应答，报失败并说明，不说已停止', async (t) => {
  const s = stage(t);
  holdDataDir(s.dataDir);
  // Port 9 (discard) is not listened on.
  writeFileSync(join(s.dataDir, 'service.json'), JSON.stringify({ pid: process.pid, port: 9, token: 'x' }));
  assert.equal(await runCli(['stop'], s.cli), 1);
  assert.match(s.text(), new RegExp(`进程 ${process.pid} 占着`));
  assert.doesNotMatch(s.text(), /已停止/);
});

test('stop：service.json 里的令牌不是服务认的那个，不算是这个服务：不说已停止', async (t) => {
  const s = stage(t);
  const child = await startStub(t, s.dataDir);
  const file = join(s.dataDir, 'service.json');
  writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), token: 'wrong' }));
  assert.equal(await runCli(['stop'], s.cli), 1);
  assert.match(s.text(), new RegExp(`进程 ${child.pid} 占着`));
  assert.doesNotMatch(s.text(), /已停止/);
  assert.equal(alive(child), true);
});

// ---- A pid and a port are not a service ----

const answering = (t: TestContext, body: string): Promise<number> =>
  new Promise((done) => {
    const server = createServer((_, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(body));
    t.after(() => server.close());
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port));
  });

test('status：崩溃留下的锁和 service.json 记着同一个进程号，那个进程号现在是别的程序：不算在跑', async (t) => {
  const s = stage(t);
  mkdirSync(s.dataDir);
  // Both files name the same pid, as a crash leaves them, and that pid is alive: this
  // test's own. The lock says it belonged to a process that began at another time.
  writeFileSync(join(s.dataDir, 'lock'), JSON.stringify({ pid: process.pid, process_start: 'the service that crashed' }));
  writeFileSync(join(s.dataDir, 'service.json'), JSON.stringify({ pid: process.pid, port: 9, token: 'x' }));
  assert.equal(await runCli(['status'], s.cli), 0);
  assert.doesNotMatch(s.text(), /正在运行/);
  assert.match(s.text(), /没有在运行（上次没有正常退出/);
  assert.equal(await runCli(['stop'], s.cli), 0, '没有服务可停');
});

test('status：登记的端口上是别的程序在应答，不算这个服务在跑', async (t) => {
  for (const body of ['hello', '{}', JSON.stringify({ pid: 1, version: '9.9.9', program_dir: 'x', started_at: 'x' })]) {
    const s = stage(t);
    holdDataDir(s.dataDir);
    writeFileSync(join(s.dataDir, 'service.json'), JSON.stringify({ pid: process.pid, port: await answering(t, body), token: 'x' }));
    assert.equal(await runCli(['status'], s.cli), 0);
    assert.doesNotMatch(s.text(), /正在运行/, body);
    assert.doesNotMatch(s.text(), /9\.9\.9/, body);
  }
});

test('status：跑着的就是这一份时，装的版本和在跑的版本并排，不多说', async (t) => {
  const s = stage(t);
  await startStub(t, s.dataDir, {}, join(s.cli.appRoot, 'service', 'main.ts'));
  assert.equal(await runCli(['status'], s.cli), 0);
  assert.ok(s.text().includes(`正在运行的版本：1.0.0 开发版（${s.cli.appRoot}）`), s.text());
  assert.doesNotMatch(s.text(), /不是上面这一份/);
});

test('open：在跑时给出登录链接并打开浏览器；没跑或被占时失败', async (t) => {
  const running = stage(t, { platform: 'linux' });
  await startStub(t, running.dataDir);
  const { port } = JSON.parse(readFileSync(join(running.dataDir, 'service.json'), 'utf8')) as { port: number };
  assert.equal(await runCli(['open'], running.cli), 0);
  const link = `http://127.0.0.1:${port}/login/stub-link`;
  assert.ok(running.out.join('\n').includes(link));
  assert.deepEqual(running.launched.map(({ file, args }) => [file, ...args]), [['xdg-open', link]]);

  const stopped = stage(t);
  assert.equal(await runCli(['open'], stopped.cli), 1);
  assert.match(stopped.text(), /tycho run/);
  assert.deepEqual(stopped.launched, []);

  const held = stage(t);
  holdDataDir(held.dataDir);
  assert.equal(await runCli(['open'], held.cli), 1);
  assert.deepEqual(held.launched, []);
});

test('open：取不到登录链接是失败，不打开浏览器', async (t) => {
  const missing = stage(t);
  await startStub(t, missing.dataDir);
  rmSync(join(missing.dataDir, 'login-token'));
  assert.equal(await runCli(['open'], missing.cli), 1);
  assert.match(missing.err.join('\n'), /没取到登录链接/);
  assert.deepEqual(missing.launched, []);

  const refused = stage(t);
  await startStub(t, refused.dataDir);
  writeFileSync(join(refused.dataDir, 'login-token'), 'not the one the service made');
  assert.equal(await runCli(['open'], refused.cli), 1);
  assert.match(refused.err.join('\n'), /401/);
  assert.deepEqual(refused.launched, []);
});

test('open：浏览器没能启动要说出来，链接仍然给出', async (t) => {
  const s = stage(t, { refuseLaunch: () => '找不到 xdg-open' });
  await startStub(t, s.dataDir);
  assert.equal(await runCli(['open'], s.cli), 0);
  assert.match(s.out.join('\n'), /login\/stub-link/);
  assert.match(s.out.join('\n'), /浏览器没打开（找不到 xdg-open）/);
  assert.doesNotMatch(s.out.join('\n'), /已请浏览器打开/);
});

test('open --print：有对外地址时同时给出本机恢复链接，共用一个凭据（npm run login-link 就是它）', async (t) => {
  const s = stage(t);
  await startStub(t, s.dataDir);
  const { port } = JSON.parse(readFileSync(join(s.dataDir, 'service.json'), 'utf8')) as { port: number };
  assert.equal(await runCli(['open', '--print'], s.cli), 0);
  assert.deepEqual(s.out, [
    '在外面用：http://public.example/login/stub-link',
    `在这台电脑上，或经 SSH 转发端口后用：http://127.0.0.1:${port}/login/stub-link（两条链接共用一次性凭据，用掉一条，另一条也失效）`,
  ]);
  const links = s.out.map((line) => line.match(/https?:\/\/[^（\s]+/)![0]);
  assert.equal(new URL(links[0]!).pathname, new URL(links[1]!).pathname, '两条链接必须兑换同一个凭据');
  assert.deepEqual(s.launched, []);
});

test('open --print：没有对外地址时仍只打印本机链接', async (t) => {
  const s = stage(t);
  await startStub(t, s.dataDir, { STUB_LOCAL_LINK: '1' });
  const { port } = JSON.parse(readFileSync(join(s.dataDir, 'service.json'), 'utf8')) as { port: number };
  assert.equal(await runCli(['open', '--print'], s.cli), 0);
  assert.deepEqual(s.out, [`http://127.0.0.1:${port}/login/stub-link`]);
  assert.deepEqual(s.launched, []);
});

test('open --print：填了对外地址，即使它与本机相同仍给出两种用途', async (t) => {
  const s = stage(t);
  await startStub(t, s.dataDir, { STUB_PUBLIC_LOCAL_LINK: '1' });
  const { port } = JSON.parse(readFileSync(join(s.dataDir, 'service.json'), 'utf8')) as { port: number };
  const link = `http://127.0.0.1:${port}/login/stub-link`;
  assert.equal(await runCli(['open', '--print'], s.cli), 0);
  assert.deepEqual(s.out, [
    `在外面用：${link}`,
    `在这台电脑上，或经 SSH 转发端口后用：${link}（两条链接共用一次性凭据，用掉一条，另一条也失效）`,
  ]);
  assert.deepEqual(s.launched, []);
});

test('open --print：取不到链接仍退出 1，不打印误导性的链接', async (t) => {
  const s = stage(t);
  await startStub(t, s.dataDir, { STUB_NO_LINKS: '1' });
  assert.equal(await runCli(['open', '--print'], s.cli), 1);
  assert.match(s.err.join('\n'), /没取到登录链接.*500/);
  assert.deepEqual(s.out, []);
  assert.deepEqual(s.launched, []);
});

test('打开浏览器：每个系统用它自己的办法，链接是单独的一个参数', async (t) => {
  for (const [platform, opener] of [['win32', /rundll32/], ['darwin', /^open$/], ['linux', /^xdg-open$/]] as const) {
    const s = stage(t, { platform });
    await startStub(t, s.dataDir);
    assert.equal(await runCli(['open'], s.cli), 0);
    assert.equal(s.launched.length, 1);
    assert.match(s.launched[0]!.file, opener);
    assert.match(s.launched[0]!.args.at(-1)!, /^http:\/\/127\.0\.0\.1:\d+\/login\/stub-link$/);
  }
});

test('run：已经在跑或数据目录被占时不再起第二个', async (t) => {
  const running = stage(t);
  const child = await startStub(t, running.dataDir);
  assert.equal(await runCli(['run'], running.cli), 1);
  assert.match(running.text(), /已经在运行/);
  assert.match(running.text(), /tycho open/);
  assert.equal(alive(child), true, '原来的服务不该被动到');

  const held = stage(t);
  holdDataDir(held.dataDir);
  assert.equal(await runCli(['run'], held.cli), 1);
  assert.match(held.text(), new RegExp(`进程 ${process.pid}`));
  assert.equal(existsSync(join(held.dataDir, 'service.json')), false);
});

test('run：首次运行建数据目录，起来后给出地址和登录链接，停止后退出码是服务的', async (t) => {
  const s = stage(t, { platform: 'linux' });
  assert.equal(existsSync(s.dataDir), false);
  const running = runCli(['run', '--open'], s.cli);
  await until('run 打印登录链接', () => s.out.join('\n').includes('/login/stub-link'));
  const { port, pid } = JSON.parse(readFileSync(join(s.dataDir, 'service.json'), 'utf8')) as { port: number; pid: number };
  assert.notEqual(pid, process.pid, '服务在自己的进程里');
  assert.ok(s.out.join('\n').includes(`http://127.0.0.1:${port}`));
  assert.deepEqual(s.launched.map(({ args }) => args.at(-1)), [`http://127.0.0.1:${port}/login/stub-link`]);

  const stopper = stage(t, { env: { TYCHO_DATA: s.dataDir } });
  assert.equal(await runCli(['stop'], stopper.cli), 0);
  assert.equal(await running, 0);
});

test('run：没设 TYCHO_DATA 时，服务拿到的是主目录下的默认数据目录', async (t) => {
  const s = stage(t, { env: { TYCHO_DATA: '' } });
  const dataDir = join(s.home, '.tycho', 'host');
  const running = runCli(['run'], s.cli);
  // The stub writes where its own environment says, so this is what the child was given.
  await until('服务在默认数据目录里登记', () => announced(dataDir));
  const stopper = stage(t, { env: { TYCHO_DATA: dataDir } });
  assert.equal(await runCli(['stop'], stopper.cli), 0);
  assert.equal(await running, 0);
});

test('run：不带 --open 不打开浏览器；不带子命令就是 run', async (t) => {
  const s = stage(t);
  const running = runCli([], s.cli);
  await until('run 打印登录链接', () => s.out.join('\n').includes('/login/stub-link'));
  assert.deepEqual(s.launched, []);
  const stopper = stage(t, { env: { TYCHO_DATA: s.dataDir } });
  assert.equal(await runCli(['stop'], stopper.cli), 0);
  assert.equal(await running, 0);
});

test('run：服务由开机自启拉起时不打印登录链接，也不去要一条：这段输出会留在日志或没人看的控制台里', async (t) => {
  const trace = join(tempDir(t), 'trace');
  const s = stage(t, { env: { TYCHO_AUTOSTART: '1', STUB_TRACE: trace } });
  const running = runCli(['run'], s.cli);
  await until('run 报告服务已启动', () => s.out.join('\n').includes('服务已启动。'));
  assert.match(s.out.join('\n'), /控制台：http/);
  assert.match(s.out.join('\n'), /tycho open/, '要链接得自己问');
  assert.doesNotMatch(s.out.join('\n'), /login\//, '没人看着这段输出');

  const stopper = stage(t, { env: { TYCHO_DATA: s.dataDir } });
  assert.equal(await runCli(['stop'], stopper.cli), 0);
  assert.equal(await running, 0);
  // Not merely unprinted: a one-time link nobody asked for is not made at all.
  assert.equal(readFileSync(trace, 'utf8'), 'shutdown\n');
});

test('run：取不到登录链接时服务照常运行，单独报告', async (t) => {
  const s = stage(t, { env: { STUB_NO_LINKS: '1' } });
  const running = runCli(['run', '--open'], s.cli);
  await until('run 报告没取到链接', () => /没取到登录链接/.test(s.err.join('\n')));
  assert.match(s.err.join('\n'), /500/);
  assert.match(s.err.join('\n'), /服务照常在运行/);
  assert.deepEqual(s.launched, []);
  const stopper = stage(t, { env: { TYCHO_DATA: s.dataDir } });
  assert.equal(await runCli(['stop'], stopper.cli), 0);
  assert.equal(await running, 0);
});

test('run --port：只对这一次运行换端口，经环境变量交给服务，并说怎么长期用', async (t) => {
  // Other test files take ports too: one found free can be gone by the time the service
  // listens on it, and the stub then ends at once. That run is tried again on another.
  let s = stage(t);
  let port = 0;
  let running = Promise.resolve(1);
  for (let attempt = 0; ; attempt += 1) {
    const tried = stage(t);
    port = await freePort();
    running = runCli(['run', '--port', String(port)], tried.cli);
    s = tried;
    const up = await Promise.race([until('run 打印登录链接', () => tried.out.join('\n').includes('/login/stub-link')).then(() => true), running.then(() => false)]);
    if (up) break;
    assert.ok(attempt < 4, `服务在五个端口上都没起来：${tried.text()}`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, 'stub-env.json'), 'utf8')), { port: String(port), startedBy: null });
  assert.ok(s.out.join('\n').includes(`http://127.0.0.1:${port}`));
  assert.match(s.out.join('\n'), /要长期用这个端口，到设置页改“端口”/);
  const stopper = stage(t, { env: { TYCHO_DATA: s.dataDir } });
  assert.equal(await runCli(['stop'], stopper.cli), 0);
  assert.equal(await running, 0);

  for (const bad of ['0', '70000', 'http']) {
    const wrong = stage(t);
    assert.equal(await runCli(['run', '--port', bad], wrong.cli), 2, bad);
    assert.equal(existsSync(wrong.dataDir), false);
  }
});

test('run：不带 --port 时不给服务端口；只有装好的那一份才告诉服务它是 tycho 命令启动的', async (t) => {
  const checkout = stage(t);
  const running = runCli(['run'], checkout.cli);
  await until('服务起来', () => announced(checkout.dataDir));
  assert.deepEqual(JSON.parse(readFileSync(join(checkout.dataDir, 'stub-env.json'), 'utf8')), { port: null, startedBy: null });
  assert.doesNotMatch(checkout.out.join('\n'), /长期用这个端口/);
  assert.equal(await runCli(['stop'], stage(t, { env: { TYCHO_DATA: checkout.dataDir } }).cli), 0);
  assert.equal(await running, 0);

  const installed = stage(t);
  installed.cli.appRoot = stubApp(join(installed.dir, 'prefix', 'versions', '1.0.0'));
  const other = runCli(['run'], installed.cli);
  await until('服务起来', () => announced(installed.dataDir));
  assert.deepEqual(JSON.parse(readFileSync(join(installed.dataDir, 'stub-env.json'), 'utf8')), { port: null, startedBy: 'tycho' });
  assert.equal(await runCli(['stop'], stage(t, { env: { TYCHO_DATA: installed.dataDir } }).cli), 0);
  assert.equal(await other, 0);
});

test('run：终端关闭（挂断信号）到达命令时，服务被优雅停止，命令等它退出', async (t) => {
  const s = stage(t);
  const trace = join(s.dir, 'trace');
  s.cli.system.env.STUB_TRACE = trace;
  const running = runCli(['run'], s.cli);
  await until('run 打印登录链接', () => s.out.join('\n').includes('/login/stub-link'));
  // What Node does when the terminal goes away, without ending this test's own process.
  let ended: number | string = 'still running';
  try {
    assert.equal(process.emit('SIGHUP'), true, '命令要接住挂断信号');
    ended = await Promise.race([running, sleep(10_000).then(() => 'still running')]);
  } finally {
    // A service the signal did not stop must not outlive this test.
    if (ended === 'still running') await runCli(['stop'], stage(t, { env: { TYCHO_DATA: s.dataDir } }).cli);
  }
  assert.equal(ended, 0);
  // Windows has no signal to pass on: there the stop goes the way `tycho stop` goes. The
  // link this run asked for at the start is one more line in the trace and not a stop.
  assert.deepEqual(stops(trace), [process.platform === 'win32' ? 'shutdown' : 'SIGHUP']);
  assert.equal(existsSync(join(s.dataDir, 'service.json')), false);
});

test('run：服务起不来时把它的退出码传出来，不给登录链接', async (t) => {
  const s = stage(t, { env: { STUB_EXIT: '3' } });
  assert.equal(await runCli(['run'], s.cli), 3);
  assert.doesNotMatch(s.out.join('\n'), /login/);
});

test('run --log：服务的输出进日志文件', async (t) => {
  const s = stage(t);
  const log = join(s.dir, 'logs', 'service.log');
  const running = runCli(['run', '--log', log], s.cli);
  await until('服务起来', () => announced(s.dataDir));
  const stopper = stage(t, { env: { TYCHO_DATA: s.dataDir } });
  assert.equal(await runCli(['stop'], stopper.cli), 0);
  assert.equal(await running, 0);
  assert.match(readFileSync(log, 'utf8'), /stub service starting/);
});

test('run --log：日志过大时留一份旧的，另起新的', async (t) => {
  const s = stage(t, { env: { STUB_EXIT: '1' } });
  const log = join(s.dir, 'service.log');
  writeFileSync(log, Buffer.alloc(11 * 1024 * 1024, 'x'));
  assert.equal(await runCli(['run', '--log', log], s.cli), 1);
  assert.equal(readFileSync(`${log}.1`).length, 11 * 1024 * 1024);
  assert.match(readFileSync(log, 'utf8'), /^stub service starting/);
  assert.ok(s.err.join('\n').includes(log), '服务没起来时要说它的输出在哪');
});

const LIMIT = 10 * 1024 * 1024;

test('run --log：服务一直在跑、输出超过上限时也轮转，只留一份旧的', async (t) => {
  // More than twice the limit, so it turns over twice: the first old file is replaced.
  const s = stage(t, { env: { STUB_CHATTER_BYTES: String(25 * 1024 * 1024) } });
  const log = join(s.dir, 'service.log');
  const running = runCli(['run', '--log', log], s.cli);
  await until('服务说完', () => existsSync(log) && readFileSync(log, 'utf8').includes('stub chatter done'), 60_000);
  assert.ok(statSync(log).size <= LIMIT + 64 * 1024, `在写的那份 ${statSync(log).size} 字节`);
  assert.ok(statSync(`${log}.1`).size > LIMIT, '旧的那一份是写满之后换下来的');
  assert.equal(existsSync(`${log}.2`), false);
  assert.equal(await runCli(['stop'], stage(t, { env: { TYCHO_DATA: s.dataDir } }).cli), 0);
  assert.equal(await running, 0);
});

test('run --log：轮转不了时服务照常运行，输出接着写', async (t) => {
  const s = stage(t, { env: { STUB_CHATTER_BYTES: String(12 * 1024 * 1024) } });
  const log = join(s.dir, 'service.log');
  // Where the old file would go is a directory that cannot be replaced.
  mkdirSync(join(`${log}.1`, 'in the way'), { recursive: true });
  const running = runCli(['run', '--log', log], s.cli);
  await until('服务说完', () => existsSync(log) && readFileSync(log, 'utf8').includes('stub chatter done'), 60_000);
  assert.ok(statSync(log).size > LIMIT, '换不下来就接着写同一份');
  assert.equal(await runCli(['stop'], stage(t, { env: { TYCHO_DATA: s.dataDir } }).cli), 0);
  assert.equal(await running, 0);
});

test('restore：交给现有的恢复命令，带上数据目录和退出码', async (t) => {
  const s = stage(t);
  assert.equal(await runCli(['restore', '--from', 'D:\\backups\\x'], s.cli), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dataDir, 'restore-call.json'), 'utf8')), ['--from', 'D:\\backups\\x']);

  const failing = stage(t, { env: { STUB_RESTORE_EXIT: '1' } });
  assert.equal(await runCli(['restore', '--from', 'x'], failing.cli), 1);
});

// ---- The command as a process of its own ----

// A copy of this release whose service entry is the stub.
function releaseWithStub(t: TestContext): string {
  const app = join(tempDir(t), 'app');
  const root = releaseRoot(t);
  for (const file of releaseFiles(root)) {
    mkdirSync(dirname(join(app, file)), { recursive: true });
    copyFileSync(join(root, file), join(app, file));
  }
  copyFileSync(STUB_SERVICE, join(app, 'service', 'main.ts'));
  return app;
}

function foreground(t: TestContext, app: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(app, 'cli', 'main.ts'), 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => void child.kill());
  const seen = { out: '' };
  child.stdout.on('data', (chunk: Buffer) => (seen.out += chunk.toString('utf8')));
  child.stderr.resume();
  return { child, seen };
}

test('真实入口：run 守在前台，另一个终端 stop 之后它以服务的退出码结束', async (t) => {
  const app = releaseWithStub(t);
  const env = { ...process.env, TYCHO_DATA: join(tempDir(t), 'data') };
  const { child, seen } = foreground(t, app, env);
  await until('run 打印登录链接', () => seen.out.includes('/login/stub-link'));
  const stopped = spawnSync(process.execPath, [join(app, 'cli', 'main.ts'), 'stop'], { env, encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /已停止/);
  assert.equal(await exited(child), 0);
});

test('真实入口：服务管理器发来的终止信号转给服务，服务正常停止', { skip: process.platform === 'win32' && 'Windows 没有可以转交的终止信号，那里停止走 tycho stop' }, async (t) => {
  const app = releaseWithStub(t);
  const dir = tempDir(t);
  const trace = join(dir, 'trace');
  const { child, seen } = foreground(t, app, { ...process.env, TYCHO_DATA: join(dir, 'data'), STUB_TRACE: trace });
  await until('run 打印登录链接', () => seen.out.includes('/login/stub-link'));
  // To the command alone, as systemd's KillMode=mixed and launchd do.
  child.kill('SIGTERM');
  assert.equal(await exited(child), 0);
  assert.deepEqual(stops(trace), ['SIGTERM']);
});

// §8.3: with a proxy in the environment the client starts itself again with `--use-env-proxy`,
// since Node reads the proxy only before the process starts. The restart has to be the same
// command line, subcommand included: one that dropped `node` would run the host's own `run`.
test('环境里有代理：重启自己时带上完整的子命令，node 不会被吃掉', (t) => {
  const inherited = process.execArgv;
  // The test runner can turn NODE_USE_ENV_PROXY into an inherited startup flag.
  process.execArgv = inherited.filter((arg) => arg !== '--use-env-proxy');
  t.after(() => { process.execArgv = inherited; });
  const command = ['node', 'join', '--to', 'https://tycho.example.com'];
  const proxied = (value: string): NodeJS.ProcessEnv => ({
    ...process.env,
    HTTPS_PROXY: value, HTTP_PROXY: value, ALL_PROXY: value,
    https_proxy: value, http_proxy: value, all_proxy: value,
  });
  assert.equal(proxyRestart(command, proxied('')), undefined, '没有代理就不用重启自己');
  const restart = proxyRestart(command, proxied('http://proxy.example:8080'));
  assert.ok(restart, '有代理就要用 --use-env-proxy 重启自己');
  const at = restart.indexOf('--use-env-proxy');
  assert.ok(at >= 0);
  assert.equal(restart[at + 1], process.argv[1], '重启的还是这个程序');
  assert.deepEqual(restart.slice(at + 2), command, '子命令一个不少：node join 还是 node join');
  // `tycho node run` in the same environment is the other shape of the same bug: it used to
  // come back as the host's own `run`.
  const resident = proxyRestart(['node', 'run'], proxied('http://proxy.example:8080'))!;
  assert.deepEqual(resident.slice(resident.indexOf('--use-env-proxy') + 2), ['node', 'run']);
});

test('环境代理已经启用：不再重启当前命令', (t) => {
  const inherited = process.execArgv;
  process.execArgv = [...inherited.filter((arg) => arg !== '--use-env-proxy'), '--use-env-proxy'];
  t.after(() => { process.execArgv = inherited; });
  assert.equal(proxyRestart(['node', 'run'], { HTTPS_PROXY: 'http://proxy.example:8080' }), undefined);
});

test('真实入口：Node 低于发布包要求的版本时明确报错并以非 0 退出，不是什么都不做', (t) => {
  const app = releaseWithStub(t);
  const manifest = join(app, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...(JSON.parse(readFileSync(manifest, 'utf8')) as object), engines: { node: '>=99.1.2' } }));
  // The self-check also looks for a copy at the default place under home: that home is a
  // temporary one, never the owner's.
  const home = tempDir(t);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), TYCHO_DATA: join(tempDir(t), 'data') };
  const status = spawnSync(process.execPath, [join(app, 'cli', 'main.ts'), 'status'], { env, encoding: 'utf8' });
  assert.equal(status.status, 1, status.stdout);
  assert.match(status.stderr, /需要 Node 99\.1\.2 或更新的/);
  // The self-check still runs, and says the same.
  const doctor = spawnSync(process.execPath, [join(app, 'cli', 'main.ts'), 'doctor'], { env, encoding: 'utf8' });
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /\[有问题\] Node 版本/, doctor.stderr);
});

test('真实入口：不靠 import.meta.main 认出自己是入口', () => {
  // Node 24.2 and older say false there for a .ts entry: the command did nothing and
  // exited 0. Only a real run on such a Node shows it; this keeps the cause out.
  for (const file of [MAIN, join(REPO, 'service', 'main.ts'), join(REPO, 'service', 'restore.ts'), join(REPO, 'service', 'entry.ts'), join(REPO, 'scripts', 'pack.ts')]) {
    assert.doesNotMatch(readFileSync(file, 'utf8').replaceAll(/^\s*\/\/.*$/gm, ''), /import\.meta\.main/, file);
  }
});

test('真实入口：服务和恢复的入口在太旧的 Node 上也明确报错、退出 1', (t) => {
  const app = releaseWithStub(t);
  // The real service entry, not the stub: it is what would do nothing.
  copyFileSync(join(REPO, 'service', 'main.ts'), join(app, 'service', 'main.ts'));
  const manifest = join(app, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...(JSON.parse(readFileSync(manifest, 'utf8')) as object), engines: { node: '>=99.1.2' } }));
  const env = { ...process.env, TYCHO_DATA: join(tempDir(t), 'data') };
  for (const entry of [['service', 'main.ts'], ['service', 'restore.ts']]) {
    // With a limit: an entry that did not refuse would be a service running for good.
    const ran = spawnSync(process.execPath, [join(app, ...entry), '--from', 'nowhere'], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(ran.status, 1, entry.join('/'));
    assert.match(ran.stderr, /需要 Node 99\.1\.2 或更新的/, entry.join('/'));
    assert.equal(existsSync(env.TYCHO_DATA), false);
  }
});

// ---- The machine's client as a login autostart ----
//
// Guards `tycho node service` (docs/design/nodes.md §1.1, §7): an autostart installed for a
// machine that has not joined the host (a client that prints "还没有加入过" into a log
// nobody reads at every login), one that starts a second client beside the one already
// running (two clients taking the same commands out of the same queue), a definition
// installed for the wrong role, and an uninstall that stops a client the owner is running.

const nodeUnitName = (s: Stage): string => `tycho-node-${ownerId(serviceSpec(s.cli.system,s.cli.appRoot,s.dataDir,undefined,'node'))}.service`;
const nodeUnit = (s: Stage): string => join(s.home, '.config', 'systemd', 'user', nodeUnitName(s));
// An installed copy of this program, as the install script leaves one: the client's
// autostart belongs to an installation, not to a source checkout (cli/record.ts).
async function installed(t: TestContext, version = '1.0.0'): Promise<{ s: Stage; prefix: string }> {
  const s = stage(t);
  const prefix = join(s.dir, 'prefix');
  s.cli.appRoot = stubApp(join(prefix, 'versions', `.staging-${process.pid}-${version}`), version);
  assert.equal(await runCli(['install-self', '--prefix', prefix, '--node', process.execPath], s.cli), 0, s.text());
  s.cli.appRoot = join(prefix, 'versions', version);
  s.calls.length = 0;
  s.out.length = 0;
  s.err.length = 0;
  return { s, prefix };
}

// A machine that has joined: the identity, the token and the address the join writes. No
// client is started: what these tests are about is the definition and the record.
function joined(s: ReturnType<typeof stage>): string {
  const identity = identityOf(s.dataDir);
  writeToken(identity, 'f'.repeat(64));
  writeOrigin(identity, 'http://127.0.0.1:9');
  return identity.dir;
}

test('tycho node service install：没有加入过主机就不装，说明先加入', async (t) => {
  const { s, prefix } = await installed(t);
  assert.equal(await runCli(['node', 'service', 'install'], s.cli), 1);
  assert.match(s.err.join('\n'), /还没有加入过主机/);
  assert.match(s.err.join('\n'), /tycho node join/);
  assert.equal(existsSync(nodeUnit(s)), false, '不该装上');
  assert.equal(readRecord(prefix)?.autostart?.node, undefined, '记录里不该有客户端那一格');
  assert.deepEqual(s.calls, [], '什么都别运行');
});

test('tycho node service install：加入过就装成 tycho-node，跑的是客户端，记录里是客户端那一格', async (t) => {
  const { s, prefix } = await installed(t);
  joined(s);
  // The manager starts nothing here, so the client never comes up: what this test is about
  // is the definition, and the command says what it could not confirm.
  s.cli.timing.startWaitMs = 50;
  assert.equal(await runCli(['node', 'service', 'install'], s.cli), 1, s.text());
  const unit = nodeUnit(s);
  assert.equal(existsSync(unit), true);
  const written = readFileSync(unit, 'utf8');
  // The words are `node run`, not the host's `run`: one program, two roles (autostart.ts).
  assert.match(written, /ExecStart=.* "node" "run"/);
  assert.match(written, /TYCHO_DATA=/);
  assert.equal(readRecord(prefix)?.autostart?.host, undefined, '主机那份没有被碰');
  assert.equal(readRecord(prefix)?.autostart?.node?.dataDir, s.dataDir);
  const asked = s.calls.filter(({ file }) => file === 'systemctl').map(({ args }) => args.join(' '));
  assert.ok(asked.includes(`--user enable --now ${nodeUnitName(s)}`), asked.join(' | '));
  assert.equal(asked.some((line) => line.includes('tycho.service') && !line.includes('tycho-node')), false, '主机那份不该被问到');

  // Running it again with a client already there starts no second one.
  s.calls.length = 0;
  s.out.length = 0;
  s.err.length = 0;
  writeFileSync(join(identityOf(s.dataDir).dir, 'client.lock'), JSON.stringify({ pid: process.pid, hostname: 'here' }));
  assert.equal(await runCli(['node', 'service', 'install'], s.cli), 0, s.text());
  assert.match(s.text(), new RegExp(`已经有一个客户端在跑（进程 ${process.pid}）`));
  assert.equal(
    s.calls.some(({ file, args }) => file === 'systemctl' && (args.includes('--now') || args.includes('start'))),
    false,
    '不该再起一个客户端',
  );

  // `status` says who is running and what is installed; `uninstall` takes the definition
  // away and leaves the client that is running alone.
  s.out.length = 0;
  assert.equal(await runCli(['node', 'service', 'status'], s.cli), 0, s.text());
  assert.match(s.out.join('\n'), new RegExp(`在跑（进程 ${process.pid}）`));
  assert.match(s.out.join('\n'), /机器客户端的开机自启：已安装/);
  assert.equal(await runCli(['node', 'service', 'uninstall'], s.cli), 0, s.text());
  assert.equal(existsSync(unit), false);
  assert.equal(readRecord(prefix)?.autostart?.node, undefined);
  assert.match(s.text(), /正在跑的那个客户端没有停/);
});


const writes = (marker: string): string[] => ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join(' '))`];

test('启动一个比命令活得久的程序：启动了就不说有问题，它的参数原样到达', async (t) => {
  const marker = join(tempDir(t), 'started by launch');
  assert.equal(realSystem().launch(process.execPath, [...writes(marker), 'two words', "it's"]), null);
  await until('程序跑起来', () => existsSync(marker) && readFileSync(marker, 'utf8') !== '');
  assert.equal(readFileSync(marker, 'utf8'), "two words it's");
});

test('启动一个不存在的程序：说出来，不当成已启动', (t) => {
  const problem = realSystem().launch(join(tempDir(t), 'no such program.exe'), []);
  assert.ok(problem, '没启动成要有原因');
});

test('经 cmd 启动时，带 % 的词不交给 cmd：它会把 %NAME% 换成别的', { skip: process.platform !== 'win32' && '只有 Windows 上经过 cmd' }, async (t) => {
  const marker = join(tempDir(t), 'must not appear');
  const problem = realSystem().launch(process.execPath, [...writes(marker), '%TEMP%']);
  assert.match(problem ?? '', /%/);
  await sleep(1500);
  assert.equal(existsSync(marker), false, '被拒绝的命令不能已经跑了');
});
