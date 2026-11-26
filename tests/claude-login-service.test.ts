// Guards the service's part in a Claude login against: a stop or an upgrade's drain leaving a
// login's CLI or helper running after the service is gone (checked by pid and the moment each
// began, a pid that cannot be checked not counting as gone); a login started once the drain has
// begun; a login that was still being prepared when the drain began going on to start the CLI
// once its preparation is over; the temporary directories a crash left behind surviving the
// next start; and the bridge's source missing from a release, which would leave an installed
// tycho with no way to sign in.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ClaudeLoginOptions } from '../service/claude-login.ts';
import { startService } from '../service/main.ts';
import { windowsCommandLine } from '../service/ptybridge.ts';
import { RELEASE_DIRS } from '../scripts/pack.ts';
import { CONSOLE_DIST, USER, claudeTier } from './helpers.ts';
import { gone, settle } from './process-standing.ts';

const windowsOnly = { skip: process.platform !== 'win32' && '登录助手用的是 Windows 的伪终端（ConPTY），只在 Windows 上有', timeout: 120_000 };
const FAKE = join(import.meta.dirname, 'fake-claude-login.mjs');
const HANG = join(import.meta.dirname, 'fake-hang.mjs');
const FAKE_ROUTER = join(import.meta.dirname, 'fake-claude.mjs');

async function service(t: TestContext, bridge?: ClaudeLoginOptions['bridge']) {
  const root = mkdtempSync(join(tmpdir(), 'tycho-login-svc-'));
  const dataDir = join(root, 'data');
  const record = join(root, 'fake.jsonl');
  // What a crash left of a login: nobody's once the service starts again.
  mkdirSync(join(dataDir, 'login-sessions', 'left-by-a-crash'), { recursive: true });
  writeFileSync(join(dataDir, 'login-sessions', 'left-by-a-crash', '.claude.json'), '{}');
  const running = await startService({
    dataDir, port: 0, claude: [process.execPath, FAKE_ROUTER], stopWaitMs: 2000, consoleDir: CONSOLE_DIST,
    claudeLogin: {
      commandLine: () => windowsCommandLine([process.execPath, FAKE]),
      env: () => ({ ...process.env, FAKE_LOGIN_GOOD: 'x#y', FAKE_LOGIN_RECORD: record }),
      ...(bridge ? { bridge } : {}),
    },
  });
  // Stopped before its directory goes: the ledger is open until then.
  t.after(async () => {
    await running.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  running.ledger.putAccount({ id: 'acct', name: 'acct', executor: 'claude', tiers: { execute: claudeTier('m') } }, USER, 'initial-ref');
  running.accounts.setCredential('acct', 'old-token', USER);
  const cliStarted = (): boolean => existsSync(record) && readFileSync(record, 'utf8').includes('"event":"start"');
  return { dataDir, running, cliStarted };
}

test('启动时清掉上次崩溃留下的登录临时目录', async (t) => {
  const { dataDir } = await service(t);
  assert.ok(!existsSync(join(dataDir, 'login-sessions', 'left-by-a-crash')));
});

test('服务停止时正在进行的登录中断，登录程序按 pid 加启动时刻核对都已退出', windowsOnly, async (t) => {
  const { running } = await service(t);
  const started = running.claudeLogin.start('acct', 'relogin', USER);
  const end = Date.now() + 30_000;
  while (running.claudeLogin.get(started.id).state === 'preparing' && Date.now() < end) await sleep(50);
  assert.equal(running.claudeLogin.get(started.id).state, 'waiting_code');
  const { helper, cli } = running.claudeLogin.processesOf(started.id);
  assert.ok(helper?.start && cli?.start);
  await running.stop();
  for (const each of [helper, cli]) {
    const found = await settle(each.pid, each.start, 0);
    assert.ok(gone(found), `pid ${each.pid}：${found}`);
  }
});

test('升级排空：一开始就不再接新登录；排空前正在准备的那次，准备完也不会起登录程序', windowsOnly, async (t) => {
  // A compiler that never finishes holds the login in its preparation.
  const { dataDir, running, cliStarted } = await service(t, { csc: [process.execPath, HANG] });
  const preparing = running.claudeLogin.start('acct', 'relogin', USER);
  const end = Date.now() + 30_000;
  while (!running.claudeLogin.processesOf(preparing.id).preparing.some((each) => each.start !== undefined)) {
    assert.ok(Date.now() < end, '没停在编译中');
    await sleep(50);
  }
  const { port, token } = JSON.parse(readFileSync(join(dataDir, 'service.json'), 'utf8')) as { port: number; token: string };
  const drain = fetch(`http://127.0.0.1:${port}/api/drain`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  // Observe that draining has begun, independently of how long HTTP delivery takes.
  while (running.claudeLogin.get(preparing.id).state === 'preparing') {
    assert.ok(Date.now() < end, '排空请求尚未处理');
    await sleep(50);
  }
  assert.throws(() => running.claudeLogin.start('acct', 'relogin', USER), /升级/);
  assert.equal((await drain).status, 200);
  const ended = running.claudeLogin.get(preparing.id);
  assert.ok(ended.ended);
  assert.equal(ended.state, 'failed');
  for (const each of running.claudeLogin.processesOf(preparing.id).preparing) {
    const found = await settle(each.pid, each.start, 0);
    assert.ok(gone(found), `pid ${each.pid}：${found}`);
  }
  await sleep(1_000);
  assert.equal(running.claudeLogin.processesOf(preparing.id).cli, undefined);
  assert.ok(!cliStarted(), '登录程序不该起来');
});

test('发布包带着登录助手的源码', () => {
  assert.ok(RELEASE_DIRS.includes('service'));
  assert.ok(existsSync(join(import.meta.dirname, '..', 'service', 'ptybridge.cs')));
});
