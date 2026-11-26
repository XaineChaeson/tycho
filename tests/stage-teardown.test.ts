// Guards against a case that ends while `stage.start()` is still coming up. The start is
// not in the stage's set of running services yet, so the teardown has nothing to stop: the
// setup goes on after the hook has run, opens its port, and the file's process never exits
// — one watchdog timeout in a full run leaves `node --test` hanging (measured: it never
// returned). What is proven here is a process, because only a process shows it: the child
// is a real test file of two cases run as its own process, the first ending with a start
// still in flight, the second checking the port that start opened is closed again, and the
// parent that the process ends by itself.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// A start left in flight never returns, so this bound is a hang detector, not a budget:
// the child's own two cases are what accept the behaviour.
const EXIT_WITHIN_MS = 120_000;

const CHILD = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { stage } from 'STAGE';

let dataDir = '';
let port = 0;
let seen = 0;

test('用例在 start() 还在启动时结束', { timeout: 120_000 }, async (t) => {
  const s = stage(t);
  dataDir = s.dataDir;
  const first = await s.start();
  const run = await s.launched(first, s.queued(first, '排队的'));
  await s.stop(first);
  // The next start inventories this Run through the machine, and that is where it waits.
  const release = s.remote.hold('state.sh');
  seen = s.remote.called('state.sh', run.id);
  void s.start().catch(() => undefined);
  while (s.remote.called('state.sh', run.id) === seen) await sleep(10);
  port = (JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { port: number }).port;
  assert.ok(port > 0);
  // The start is in flight and its port is already open: exactly the window a case that
  // ends here used to leave a service in.
  assert.equal((await fetch('http://127.0.0.1:' + port + '/api/state')).status, 401);
  // The case body ends with that start in flight; the machine answers afterwards.
  setTimeout(release, 300);
});

test('用例结束后，那次启动开出来的服务已被停掉', { timeout: 120_000 }, async () => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    let listening = true;
    try {
      await fetch('http://127.0.0.1:' + port + '/api/state');
    } catch {
      listening = false;
    }
    if (!listening) return;
    assert.ok(Date.now() < deadline, '用例结束后服务还在监听 ' + port);
    await sleep(50);
  }
});
`;

test('用例在启动中途结束时，服务被停掉、文件进程自己退出', { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-stage-teardown-'));
  try {
    const child = join(dir, 'child.test.ts');
    writeFileSync(child, CHILD.replace("'STAGE'", JSON.stringify(pathToFileURL(join(import.meta.dirname, 'stage.ts')).href)));
    const ran = spawnSync(process.execPath, [child], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: EXIT_WITHIN_MS });
    assert.equal(ran.error, undefined, `文件进程没有自己退出（${EXIT_WITHIN_MS} 毫秒后仍在跑）：${ran.stdout}${ran.stderr}`);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /pass 2/, ran.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('用例失败且远程调用一直被按住时，服务仍被停掉、文件进程退出', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-stage-teardown-held-'));
  try {
    const child = join(dir, 'child.test.ts');
    const source = CHILD.replace("'STAGE'", JSON.stringify(pathToFileURL(join(import.meta.dirname, 'stage.ts')).href))
      .replace('setTimeout(release, 300);', "assert.fail('deliberate failure');");
    writeFileSync(child, source);
    const ran = spawnSync(process.execPath, [child], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 30_000 });
    assert.equal(ran.error, undefined, `文件进程没有自己退出：${ran.stdout}${ran.stderr}`);
    assert.equal(ran.status, 1, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /deliberate failure/);
    assert.match(ran.stdout, /pass 1/, ran.stdout);
    assert.match(ran.stdout, /fail 1/, ran.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
