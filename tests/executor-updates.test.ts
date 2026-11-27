import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inferNpmPrefix, resolveExecutorUpdaterPlan, runExecutorUpdate } from '../node/executor-updater.ts';
import { createExecutorUpdates } from '../service/executor-updates.ts';
import {
  highestSemver,
  inMaintenanceWindow,
  isLikelyManualUpdate,
  isVersionBehind,
  normalizeExecutorAutoUpdatePolicy,
} from '../shared/executor-updates.ts';
import type { NodeExecutorReport, NodeUpdateExecutorResult } from '../shared/node-protocol.ts';
import { fixture } from './helpers.ts';

test('shared version and maintenance window helpers behave accurately', () => {
  assert.equal(isVersionBehind('codex-cli 0.165.0', '0.167.1'), true);
  assert.equal(isVersionBehind('codex-cli 0.167.1', '0.167.1'), false);
  assert.equal(isVersionBehind('codex-cli 0.168.0', '0.167.1'), false);
  assert.equal(highestSemver(['codex-cli 0.163.0', 'codex-cli 0.167.1', null, '0.165.0']), '0.167.1');

  // Normal window 02:00..06:00
  const at3 = new Date(2026, 10, 26, 3, 15, 0);
  const at14 = new Date(2026, 10, 26, 14, 0, 0);
  assert.equal(inMaintenanceWindow({ windowStartHour: 2, windowEndHour: 6 }, at3), true);
  assert.equal(inMaintenanceWindow({ windowStartHour: 2, windowEndHour: 6 }, at14), false);
  // Equal hours = anytime
  assert.equal(inMaintenanceWindow({ windowStartHour: 0, windowEndHour: 0 }, at14), true);
  // Midnight wrap 23:00..05:00
  assert.equal(inMaintenanceWindow({ windowStartHour: 23, windowEndHour: 5 }, at3), true);
  assert.equal(inMaintenanceWindow({ windowStartHour: 23, windowEndHour: 5 }, at14), false);

  const norm = normalizeExecutorAutoUpdatePolicy({ enabled: true, intervalHours: 999, windowStartHour: -1, windowEndHour: 25, executors: { codex: true, claude: false } });
  assert.equal(norm.enabled, true);
  assert.equal(norm.intervalHours, 168);
  assert.equal(norm.windowStartHour, 23);
  assert.equal(norm.windowEndHour, 1);
  assert.deepEqual(norm.executors, { codex: true, claude: false });
});

test('node executor updater auto-detects install method, supports local override, and cleans ephemeral npm cache', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'tycho-updater-test-'));
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  try {
    const codexNpm = resolveExecutorUpdaterPlan('codex', 'C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd', env);
    assert.equal(codexNpm.kind, 'run');
    if (codexNpm.kind === 'run') {
      assert.equal(codexNpm.method, 'npm-global');
      assert.equal(codexNpm.ephemeralNpmCache, true);
    }

    const claudeNative = resolveExecutorUpdaterPlan('claude', '/usr/local/bin/claude', env);
    assert.equal(claudeNative.kind, 'run');
    if (claudeNative.kind === 'run') {
      assert.equal(claudeNative.method, 'claude-builtin');
      assert.deepEqual(claudeNative.argv, ['claude', 'update']);
    }

    // Verify ephemeral npm cache dir is created and cleaned up unconditionally
    let observedCacheDir: string | undefined;
    const outcome = await runExecutorUpdate({
      executor: 'codex',
      installedPath: 'C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd',
      env,
      run: async (argv) => {
        const idx = argv.indexOf('--cache');
        assert.ok(idx > 0, 'npm updater should pass --cache <tmpDir>');
        observedCacheDir = argv[idx + 1];
        assert.ok(observedCacheDir && existsSync(observedCacheDir), 'ephemeral cache dir should exist while running');
        return { stdout: 'updated codex', stderr: '', code: 0 };
      },
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.method, 'npm-global');
    assert.ok(observedCacheDir && !existsSync(observedCacheDir), 'ephemeral cache dir must be deleted after update');

    // Local override ~/.tycho/executor-updaters.json takes precedence
    mkdirSync(join(fakeHome, '.tycho'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.tycho', 'executor-updaters.json'),
      JSON.stringify({
        dsh: { argv: ['/opt/internal/update-dsh', '--quiet'], env: { CUSTOM_MIRROR: '1' } },
        gemini: { disabled: true },
      }),
      'utf8',
    );
    const dshPlan = resolveExecutorUpdaterPlan('dsh', undefined, env);
    assert.equal(dshPlan.kind, 'run');
    if (dshPlan.kind === 'run') {
      assert.equal(dshPlan.method, 'custom');
      assert.deepEqual(dshPlan.argv, ['/opt/internal/update-dsh', '--quiet']);
      assert.equal(dshPlan.extraEnv?.CUSTOM_MIRROR, '1');
    }
    const geminiPlan = resolveExecutorUpdaterPlan('gemini', undefined, env);
    assert.equal(geminiPlan.kind, 'disabled');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('host executorUpdates queues while busy, updates when idle, ingests fresh report, and persists policy', async (t) => {
  const f = fixture(t, {}, false);
  let machineBusy = true;
  const notedReports: NodeExecutorReport[] = [];
  const notices: string[] = [];
  let reported: NodeExecutorReport = {
    at: '2026-11-26T05:00:00.000Z',
    executors: [
      { executor: 'codex', installed: true, version: 'codex-cli 0.165.0', logged_in: false },
    ],
  };

  const manager = createExecutorUpdates({
    ledger: f.ledger,
    machines: { list: () => [{ id: 'dev-1' } as never] },
    nodes: {
      connected: () => true,
      reportedExecutors: () => reported,
      reportedRuns: () => (machineBusy ? [{ task_id: 't1', run_id: 'r1', alive: true }] : []),
      send: async (_machineId, cmd) => {
        assert.equal(cmd.kind, 'update_executor');
        const nextReport: NodeExecutorReport = {
          at: '2026-11-26T05:10:00.000Z',
          executors: [
            {
              executor: 'codex',
              installed: true,
              version: 'codex-cli 0.167.1',
              logged_in: false,
              models: { list: [{ id: 'gpt-6.2-sol' }] },
            },
          ],
        };
        reported = nextReport;
        return {
          ok: true,
          executor: 'codex',
          method: 'npm-global',
          before_version: 'codex-cli 0.165.0',
          after_version: 'codex-cli 0.167.1',
          updated: true,
          report: nextReport,
        } satisfies NodeUpdateExecutorResult;
      },
      noteExecutors: (_machineId, raw) => {
        notedReports.push(raw as NodeExecutorReport);
        return raw as NodeExecutorReport;
      },
    },
    notify: {
      executorUpdated: (m, e, before, after) => {
        notices.push(`${m}:${e}:${before}->${after}`);
      },
    },
    fetch: (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: '0.167.1' }),
    })) as unknown as typeof fetch,
  });

  // Policy persistence in ledger
  const savedPolicy = manager.setPolicy({
    enabled: true,
    intervalHours: 12,
    windowStartHour: 0,
    windowEndHour: 0,
    executors: { codex: true },
  });
  assert.equal(savedPolicy.enabled, true);
  assert.equal(f.ledger.executorAutoUpdatePolicy().intervalHours, 12);

  // Trigger while busy -> stays waiting_idle without sending command
  const queued = manager.triggerUpdate({ executor: 'codex', trigger: 'auto' });
  assert.equal(queued.length, 1);
  assert.equal(manager.status().active_by_key['dev-1/codex']?.state, 'waiting_idle');

  // Become idle -> pumpWaitingJobs executes upgrade, ingests fresh report, emits notice
  machineBusy = false;
  await manager.pumpWaitingJobs();
  // Wait a microtask for executeJob promise
  await new Promise((resolve) => setTimeout(resolve, 20));

  const done = manager.status().active_by_key['dev-1/codex'];
  assert.equal(done?.state, 'succeeded');
  assert.equal(done?.after_version, 'codex-cli 0.167.1');
  assert.equal(done?.updated, true);
  assert.equal(notedReports.length, 1);
  assert.deepEqual(notices, ['dev-1:codex:codex-cli 0.165.0->codex-cli 0.167.1']);

  manager.stop();
});

test('closed-loop npm updater infers writable wrapper prefix in-place and falls back to ~/.tycho/cli on read-only prefix or EACCES (243)', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'tycho-closed-loop-'));
  try {
    // 1. Wrapper script (/usr/local/bin/codex) pointing to user-writable ~/.local/lib/node_modules -> updates in-place with --prefix
    const wrapperPath = join(fakeHome, 'codex-wrapper');
    const userLocalPrefix = '/home/lighthouse/.local';
    writeFileSync(
      wrapperPath,
      `#!/bin/sh\nexec /home/lighthouse/.tycho/app/node/bin/node ${userLocalPrefix}/lib/node_modules/@openai/codex/bin/codex.js "$@"\n`,
      'utf8',
    );
    assert.equal(inferNpmPrefix(wrapperPath, 'linux'), userLocalPrefix);

    const calls1: Array<{ argv: string[]; env?: Record<string, string> }> = [];
    const res1 = await runExecutorUpdate({
      executor: 'codex',
      installedPath: wrapperPath,
      platform: 'linux',
      env: { HOME: '/home/lighthouse' },
      fs: {
        existsSync: (p) => String(p).startsWith(userLocalPrefix),
        isWritable: (dir) => dir.startsWith(userLocalPrefix),
      },
      run: async (argv, _ms, extraEnv) => {
        calls1.push({ argv, env: extraEnv });
        return { stdout: 'added 1 package', stderr: '', code: 0 };
      },
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.method, 'npm-global');
    assert.equal(calls1.length, 1);
    const pIdx1 = calls1[0]!.argv.indexOf('--prefix');
    assert.ok(pIdx1 > 0);
    assert.equal(calls1[0]!.argv[pIdx1 + 1], userLocalPrefix);
    assert.ok(calls1[0]!.env?.npm_config_logs_dir, 'ephemeral npm logs dir is set to avoid root-owned ~/.npm/_logs');

    // 2. Read-only system prefix (/usr/local) -> directly targets ~/.tycho/cli without touching system or .npmrc
    const madeDirs: string[] = [];
    const calls2: string[][] = [];
    const res2 = await runExecutorUpdate({
      executor: 'codex',
      installedPath: '/usr/local/bin/codex',
      platform: 'linux',
      env: { HOME: '/home/xaine' },
      fs: {
        realpathSync: () => '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
        existsSync: (p) => String(p).startsWith('/usr/local'),
        isWritable: () => false,
        mkdirSync: (d) => madeDirs.push(d),
      },
      run: async (argv) => {
        calls2.push(argv);
        return { stdout: 'installed in managed prefix', stderr: '', code: 0 };
      },
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.method, 'npm-tycho-local');
    assert.deepEqual(madeDirs, ['/home/xaine/.tycho/cli']);
    assert.equal(calls2.length, 1);
    assert.equal(calls2[0]![calls2[0]!.indexOf('--prefix') + 1], '/home/xaine/.tycho/cli');

    // 3. Unknown prefix hitting exit code 243 (EACCES) -> automatically retries into ~/.tycho/cli
    const calls3: string[][] = [];
    const res3 = await runExecutorUpdate({
      executor: 'codex',
      installedPath: undefined,
      platform: 'linux',
      env: { HOME: '/home/xaine' },
      fs: { mkdirSync: () => {} },
      run: async (argv) => {
        calls3.push(argv);
        if (!argv.includes('--prefix')) return { stdout: '', stderr: 'npm error EACCES: permission denied', code: 243 };
        return { stdout: 'ok', stderr: '', code: 0 };
      },
    });
    assert.equal(res3.ok, true);
    assert.equal(res3.method, 'npm-tycho-local');
    assert.equal(calls3.length, 2);
    assert.equal(calls3[1]![calls3[1]!.indexOf('--prefix') + 1], '/home/xaine/.tycho/cli');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('unsupported updater results (desktop-bundled dsh) record state=unsupported rather than failed and skip fleet batch retries', async (t) => {
  assert.equal(isLikelyManualUpdate('dsh', 'D:\\software\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd'), true);
  assert.equal(isLikelyManualUpdate('dsh', 'C:\\Users\\u\\AppData\\Roaming\\npm\\dsh.cmd'), false);
  assert.equal(isLikelyManualUpdate('codex', '/usr/local/bin/codex'), false);

  const f = fixture(t, {}, false);
  const manager = createExecutorUpdates({
    ledger: f.ledger,
    machines: { list: () => [{ id: 'win-1' } as never] },
    nodes: {
      connected: () => true,
      reportedExecutors: () => ({
        at: '2026-11-27T01:00:00.000Z',
        executors: [{ executor: 'dsh', installed: true, version: '0.2.2-rc.5', logged_in: null, path: 'D:\\software\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd' }],
      }),
      reportedRuns: () => [],
      send: async () => ({
        ok: false,
        executor: 'dsh',
        method: 'unsupported',
        before_version: '0.2.2-rc.5',
        after_version: '0.2.2-rc.5',
        updated: false,
        error: 'dsh 在本机未检测到标准包管理器更新方式',
      } satisfies NodeUpdateExecutorResult),
      noteExecutors: (_m, raw) => raw as NodeExecutorReport,
    },
  });

  manager.triggerUpdate({ executor: 'dsh', machineIds: ['win-1'], trigger: 'manual' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.status().active_by_key['win-1/dsh']?.state, 'unsupported');

  // Subsequent fleet-wide trigger skips already-unsupported machines cleanly.
  const second = manager.triggerUpdate({ executor: 'dsh', trigger: 'manual' });
  assert.equal(second.length, 0);
  manager.stop();
});

test('runExecutorUpdate retries direct connection when proxied npm stalls and surfaces Claude-Data hint on failure', async () => {
  const attempts: { argv: string[]; timeoutMs: number; env?: Record<string, string> }[] = [];
  const res = await runExecutorUpdate({
    executor: 'codex',
    installedPath: '/home/lighthouse/.local/bin/codex',
    platform: 'linux',
    env: {
      HOME: '/home/lighthouse',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NODE_USE_ENV_PROXY: '1',
    },
    fs: {
      realpathSync: () => '/home/lighthouse/.local/lib/node_modules/@openai/codex/bin/codex.js',
      existsSync: () => true,
      isWritable: () => true,
    },
    run: async (argv, timeoutMs, extraEnv) => {
      attempts.push({ argv, timeoutMs, env: extraEnv });
      if (attempts.length === 1) {
        return { stdout: '', stderr: '', code: null, failure: 'npm install 超过 90000 毫秒没有回答' };
      }
      return { stdout: 'changed 2 packages in 11s', stderr: '', code: 0 };
    },
  });
  assert.equal(res.ok, true);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.timeoutMs, 90_000);
  assert.equal(attempts[0]!.env?.NODE_USE_ENV_PROXY, '');
  assert.equal(attempts[1]!.env?.HTTP_PROXY, '');
  assert.equal(attempts[1]!.env?.HTTPS_PROXY, '');
  assert.equal(attempts[1]!.env?.NO_PROXY, '*');

  const claudeFail = await runExecutorUpdate({
    executor: 'claude',
    installedPath: 'C:\\Users\\Xaine\\AppData\\Local\\Claude-Data\\claude_abc\\claude-code\\2.1.321\\claude.exe',
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\Xaine' },
    run: async () => ({ stdout: 'Updating...', stderr: '', code: null, failure: 'claude update 超过 300000 毫秒没有回答' }),
  });
  assert.equal(claudeFail.ok, false);
  assert.match(claudeFail.error ?? '', /Claude-Data/);
});

test('uninstalled gemini and claude resolve to official remote install commands per platform with proxy fallback', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'tycho-install-plan-'));
  try {
    const winEnv = { USERPROFILE: fakeHome, SystemRoot: 'C:\\Windows' };
    const unixEnv = { HOME: fakeHome };

    const agyWin = resolveExecutorUpdaterPlan('gemini', undefined, winEnv, 'win32');
    assert.equal(agyWin.kind, 'run');
    if (agyWin.kind === 'run') {
      assert.equal(agyWin.method, 'agy-install');
      assert.equal(agyWin.argv[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.match(agyWin.argv.join(' '), /antigravity\.google\/cli\/install\.ps1/);
    }

    const agyMac = resolveExecutorUpdaterPlan('gemini', undefined, unixEnv, 'darwin');
    assert.equal(agyMac.kind, 'run');
    if (agyMac.kind === 'run') {
      assert.equal(agyMac.method, 'agy-install');
      assert.deepEqual(agyMac.argv, ['bash', '-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash']);
    }

    const agyInstalled = resolveExecutorUpdaterPlan('gemini', '/Users/u/.local/bin/agy', unixEnv, 'darwin');
    assert.equal(agyInstalled.kind, 'run');
    if (agyInstalled.kind === 'run') {
      assert.equal(agyInstalled.method, 'agy-builtin');
      assert.deepEqual(agyInstalled.argv, ['agy', 'update']);
    }

    const claudeMac = resolveExecutorUpdaterPlan('claude', undefined, unixEnv, 'darwin');
    assert.equal(claudeMac.kind, 'run');
    if (claudeMac.kind === 'run') {
      assert.equal(claudeMac.method, 'claude-install');
      assert.deepEqual(claudeMac.argv, ['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
    }

    // Remote install retries directly when a configured proxy fails with a network error.
    const installCalls: { argv: string[]; env?: Record<string, string> }[] = [];
    const installRes = await runExecutorUpdate({
      executor: 'gemini',
      installedPath: undefined,
      platform: 'darwin',
      env: { HOME: fakeHome, HTTPS_PROXY: 'http://127.0.0.1:7890' },
      run: async (argv, _ms, extraEnv) => {
        installCalls.push({ argv, env: extraEnv });
        if (installCalls.length === 1) return { stdout: '', stderr: 'curl: (7) Failed to connect: ECONNREFUSED', code: 7 };
        return { stdout: 'Installed agy to ~/.local/bin/agy', stderr: '', code: 0 };
      },
    });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.method, 'agy-install');
    assert.equal(installCalls.length, 2);
    assert.equal(installCalls[1]!.env?.HTTPS_PROXY, '');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
