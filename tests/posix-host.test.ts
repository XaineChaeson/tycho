// Guards against a stop the operating system asks for turning into a crash: SIGTERM
// (systemd, `kill`) or SIGINT (Ctrl+C) ending the service without its teardown, so that
// the lock, service.json or the Router stay behind, or the exit code tells a supervisor
// to start it again.
//
// A Router runs only once its project has a message, so one waits at the start.
// Runs service/main.ts itself, the way `npm start` does, with a CLI that is one
// executable file. Windows has no signal that arrives: a kill there ends the process
// outright, and tests/acceptance-1.test.ts covers that as the crash it is.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { serviceFile } from '../service/config.ts';
import { openLedger } from '../service/ledger.ts';
import { hostProcesses } from '../service/processes.ts';
import { serviceSettings } from '../service/service-settings.ts';
import { createTools } from '../service/tools.ts';
import { claudeTier, memoryLogins, noAccept, testCredentialRef, writeTokenFile } from './helpers.ts';

const MAIN = join(import.meta.dirname, '..', 'service', 'main.ts');
const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const options = {
  skip: process.platform === 'win32' ? 'Windows 上没有能送达的 SIGTERM 和 SIGINT，这条测的是 POSIX 的信号' : false,
  timeout: 60_000,
};

const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} stops the service the clean way: exit code 0 and nothing left behind`, options, async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tycho-signal-'));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    // The service takes the CLI as one executable, so the fake gets a launcher. `exec`
    // keeps it one process: the pid the Host started is the pid that runs the fake.
    const cli = join(dataDir, 'claude');
    writeFileSync(cli, `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(FAKE)} "$@"\n`, { mode: 0o755 });
    const tierFile = join(dataDir, 'tier.json');
    writeFileSync(tierFile, '{}');
    // What the owner would have set on the settings page before this start: the account
    // the Router is bound to — an account always holds its token — and the one tier of it.
    const ledger = openLedger(join(dataDir, 'ledger.db'));
    const OWNER = { actor: 'test' };
    writeTokenFile(dataDir, 'router', 'token-of-the-router-account');
    ledger.putAccount({ id: 'router', name: 'router', executor: 'claude', tiers: { decide: claudeTier(tierFile) } }, OWNER, testCredentialRef('router'));
    const settings = serviceSettings({ ledger, dataDir, log: () => {} });
    settings.set('router.cli', cli, OWNER);
    settings.set('router.account', 'router', OWNER);
    settings.set('router.tier', 'decide', OWNER);
    // A Router starts when its project has a message (project-sessions §3): one waiting at the
    // start is what brings this project's up, and its process is what the stop must clear.
    ledger.setWhitelist({ console: ['console'] }, OWNER);
    const projectId = ledger.createProject({ name: '试跑', loginMode: 'all' }, OWNER);
    ledger.receiveMessage({ channel: 'console', externalId: 'm1', actor: 'console', text: '你好', projectId });
    ledger.close();
    const tools = createTools({
      ledger: undefined as never,
      runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
      logins: memoryLogins({}),
      machines: undefined as never,
      accept: noAccept,
    });
    const fakeLog = join(dataDir, 'fake.log');
    const child = spawn(process.execPath, [MAIN], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        TYCHO_DATA: dataDir,
        TYCHO_PORT: '0',
        FAKE_CLAUDE_LOG: fakeLog,
        FAKE_CLAUDE_TOOLS: JSON.stringify(tools.names.map((name) => `mcp__tycho__${name}`)),
      },
    });
    t.after(() => child.kill('SIGKILL'));
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;

    async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
      for (const deadline = Date.now() + 30_000; ; ) {
        const value = read();
        if (value) return value;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`服务提前退出了：${stderr}`);
        if (Date.now() > deadline) throw new Error(`等不到：${what}\n${stderr}`);
        await sleep(20);
      }
    }
    await until(() => stderr.includes('服务已启动'), '服务启动');
    const router = await until(
      () =>
        existsSync(fakeLog) &&
        readFileSync(fakeLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { argv?: string[]; pid?: number })
          .find((entry) => entry.argv),
      '负责人启动',
    );
    const marker = router.argv![router.argv!.indexOf('--session-id') + 1]!;
    assert.deepEqual(await hostProcesses.find(marker), [router.pid]);

    child.kill(signal);
    const [code, endedBy] = await closed;
    assert.equal(endedBy, null, `服务是被信号打死的，没有走收尾：${stderr}`);
    assert.equal(code, 0, stderr);
    assert.equal(existsSync(join(dataDir, 'lock')), false, '锁没有释放');
    assert.equal(existsSync(serviceFile(dataDir)), false, 'service.json 没有删');
    assert.deepEqual(await hostProcesses.find(marker), [], '负责人留下了');
  });
}
