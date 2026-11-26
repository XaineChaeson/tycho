import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveExecutorUpdaterPlan, runExecutorUpdate } from '../node/executor-updater.ts';
import { createExecutorUpdates } from '../service/executor-updates.ts';
import {
  highestSemver,
  inMaintenanceWindow,
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
