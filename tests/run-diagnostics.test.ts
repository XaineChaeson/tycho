import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedEvent } from '../adapters/types.ts';
import { HIDDEN_TEXT } from '../runner/redact.ts';
import type { RunRow, TaskRow } from '../service/ledger.ts';
import { buildRunDiagnostics, scrubSecrets } from '../service/run-diagnostics.ts';
import { traceRun } from '../service/trace.ts';
import { claudeTier, codexTier, DONE, fixture } from './helpers.ts';

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    created_at: '2026-11-19T08:00:00.000Z',
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    task_revision: 1,
    login_id: 'login-1',
    login_name: 'claude-main',
    host: 'worker-01',
    machine_id: 'worker-01',
    node_id: 'node-01',
    session_ref: null,
    state: 'ended',
    marker: 'm-1',
    exit_code: 1,
    exit_kind: 'failed',
    receipt_json: null,
    settlement_digest: null,
    snapshot_json: JSON.stringify({
      executor: 'claude',
      tier: 'execute',
      tier_value: claudeTier('claude-sonnet-4-6'),
    }),
    capture_result_json: null,
    error_json: null,
    started_at: '2026-11-19T08:00:01.000Z',
    ended_at: '2026-11-19T08:01:01.000Z',
    last_progress_at: '2026-11-19T08:01:00.000Z',
    artifacts_json: null,
    releases_dropped_at: null,
    code_dropped_at: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    created_at: '2026-11-19T07:59:00.000Z',
    project_id: 'proj-1',
    parent_id: null,
    title: '诊断测试任务',
    goal: '完成目标',
    scope: null,
    acceptance: '所有测试通过',
    revision: 1,
    login_id: null,
    role_id: 'implement',
    tier_override: null,
    tier_reason: null,
    tier: 'execute',
    tier_source: 'default',
    permission: 'write',
    tier_escalated: 0,
    review_of_json: null,
    verdict_json: null,
    knowledge_json: null,
    trigger_fire_id: null,
    skills_json: null,
    landing_json: null,
    source_json: null,
    prefer_json: null,
    priority: 0,
    state: 'held',
    reason: null,
    wake_at: null,
    created_by: 'user',
    closed_at: null,
    ...overrides,
  };
}

test('anti-washout first_error skips transient chatter and captures first real diagnostic', () => {
  const events: NormalizedEvent[] = [
    { kind: 'diagnostic', level: 'recovering', message: '   ' },
    { kind: 'diagnostic', level: 'recovering', message: 'Reconnecting... 1/5' },
    { kind: 'diagnostic', level: 'recovering', message: 'Retrying in 2s...' },
    { kind: 'diagnostic', level: 'warning', message: 'retry in 500ms' },
    { kind: 'diagnostic', level: 'fatal', message: '429 Too Many Requests: upstream overloaded' },
    { kind: 'diagnostic', level: 'fatal', message: 'Stream closed by peer' },
  ];
  const bundle = buildRunDiagnostics({
    run: makeRun({ error_json: JSON.stringify({ reason: 'generic run failure' }) }),
    events,
    firstIndex: 10,
    stderrHead: ['stderr fallback line'],
  });

  assert.deepEqual(bundle.first_error, {
    source: 'diagnostic',
    message: '429 Too Many Requests: upstream overloaded',
    event_index: 14,
  });
});

test('first_error falls back to run.error then stderrHead, and truncates long messages', () => {
  const onlyChatter: NormalizedEvent[] = [
    { kind: 'diagnostic', level: 'recovering', message: 'Reconnecting...' },
    { kind: 'diagnostic', level: 'recovering', message: 'Retrying in 4s' },
  ];

  const fromRunError = buildRunDiagnostics({
    run: makeRun({ error_json: JSON.stringify({ reason: 'A'.repeat(700) }) }),
    events: onlyChatter,
    stderrHead: ['stderr line 1'],
  });
  assert.equal(fromRunError.first_error?.source, 'run_error');
  assert.equal(fromRunError.first_error?.message.length, 600);
  assert.ok(fromRunError.first_error?.message.endsWith('…'));

  const fromStderr = buildRunDiagnostics({
    run: makeRun({ error_json: null }),
    events: onlyChatter,
    stderrHead: ['', '   ', 'FATAL: ENOENT config missing', 'second line'],
  });
  assert.deepEqual(fromStderr.first_error, {
    source: 'stderr',
    message: 'FATAL: ENOENT config missing',
  });

  const noError = buildRunDiagnostics({
    run: makeRun({ error_json: null }),
    events: [{ kind: 'text', text: 'all good' }],
  });
  assert.equal(noError.first_error, null);
});

test('secret scrubbing redacts sk-*, Bearer, ghp_*, glpat-* across errors, tools, stderr and snapshot', () => {
  const secretSk = 'sk-proj-abc1234567890XYZ';
  const secretBearer = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
  const secretGhp = 'ghp_1234567890abcdefghij1234567890';
  const secretGlpat = 'glpat-ABCDEF1234567890';

  const events: NormalizedEvent[] = [
    {
      kind: 'diagnostic',
      level: 'fatal',
      message: `Auth failed with Authorization: Bearer ${secretBearer} and key ${secretSk}`,
    },
    {
      kind: 'tool.start',
      id: 't-fail',
      category: 'run',
      name: 'bash',
      title: `curl -H "Authorization: Bearer ${secretBearer}" https://api.example.com`,
    },
    {
      kind: 'tool.end',
      id: 't-fail',
      isError: true,
      exitCode: 22,
      reason: `rejected token ${secretGhp}`,
    },
    {
      kind: 'tool.start',
      id: 't-open',
      category: 'run',
      name: 'git',
      title: `git clone https://oauth2:${secretGlpat}@gitlab.example.com/repo.git`,
    },
  ];

  const bundle = buildRunDiagnostics({
    run: makeRun({
      error_json: JSON.stringify({ message: `failed using ${secretSk}` }),
      snapshot_json: JSON.stringify({
        goal: `Check with ${secretGhp}`,
        executor: 'claude',
        tier: 'execute',
      }),
    }),
    events,
    stderrHead: [`stderr token=${secretGlpat}`, `Authorization: Bearer ${secretBearer}`],
    stderrTail: [`tail leak ${secretSk} and ${secretGhp}`],
  });

  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes(secretSk));
  assert.ok(!serialized.includes(secretBearer));
  assert.ok(!serialized.includes(secretGhp));
  assert.ok(!serialized.includes(secretGlpat));
  assert.ok(bundle.first_error?.message.includes(HIDDEN_TEXT));
  assert.ok(bundle.tools.failed_tools[0]?.title?.includes(HIDDEN_TEXT));
  assert.ok(bundle.tools.failed_tools[0]?.reason?.includes(HIDDEN_TEXT));
  assert.ok(bundle.tools.unfinished_tools[0]?.title?.includes(HIDDEN_TEXT));
  assert.equal(scrubSecrets(`Bearer ${secretBearer}`), `Bearer ${HIDDEN_TEXT}`);
});

test('tool pairing tracks unfinished tools, failed tools, categories, missing ids and cap', () => {
  const events: NormalizedEvent[] = [
    { kind: 'tool.start', id: 'ok-1', category: 'read', name: 'Read', title: 'src/a.ts' },
    { kind: 'tool.end', id: 'ok-1', isError: false },
    { kind: 'tool.start', id: 'fail-1', category: 'run', name: 'Bash', title: 'npm test' },
    { kind: 'tool.end', id: 'fail-1', isError: true, exitCode: 1, reason: '1 test failed' },
    { kind: 'tool.start', id: 'open-1', category: 'edit', name: 'Edit', title: 'src/b.ts' },
    // Missing id should use synthetic fallback key and remain unfinished.
    { kind: 'tool.start', id: '', category: 'search', name: 'Grep', title: 'needle' },
    // Standalone tool.end (e.g., start was dropped before firstIndex).
    {
      kind: 'tool.end',
      id: 'dropped-start',
      isError: true,
      exitCode: 127,
      call: { category: 'run', name: 'Bash', title: 'missing-cmd' },
      output: { text: 'command not found: missing-cmd' },
    },
  ];

  const bundle = buildRunDiagnostics({
    run: makeRun(),
    events,
    firstIndex: 5,
  });

  assert.equal(bundle.tools.total, 5);
  assert.equal(bundle.tools.error_count, 2);
  assert.equal(bundle.tools.unfinished_count, 2);
  assert.deepEqual(bundle.tools.by_category, { read: 1, run: 2, edit: 1, search: 1 });
  assert.deepEqual(bundle.tools.unfinished_tools.map((t) => ({ name: t.name, event_index: t.event_index })), [
    { name: 'Edit', event_index: 9 },
    { name: 'Grep', event_index: 10 },
  ]);
  assert.equal(bundle.tools.failed_tools.length, 2);
  assert.deepEqual(bundle.tools.failed_tools[0], {
    id: 'fail-1',
    name: 'Bash',
    category: 'run',
    title: 'npm test',
    exit_code: 1,
    reason: '1 test failed',
    event_index: 8,
  });
  assert.deepEqual(bundle.tools.failed_tools[1], {
    id: 'dropped-start',
    name: 'Bash',
    category: 'run',
    title: 'missing-cmd',
    exit_code: 127,
    reason: 'command not found: missing-cmd',
    event_index: 11,
  });

  // Verify failed_tools is capped at 25 while error_count stays exact.
  const manyFailures: NormalizedEvent[] = [];
  for (let i = 0; i < 30; i += 1) {
    manyFailures.push({ kind: 'tool.start', id: `f-${i}`, category: 'run', name: 'Bash', title: `cmd ${i}` });
    manyFailures.push({ kind: 'tool.end', id: `f-${i}`, isError: true, exitCode: 1, reason: `err ${i}` });
  }
  const capped = buildRunDiagnostics({ run: makeRun(), events: manyFailures });
  assert.equal(capped.tools.error_count, 30);
  assert.equal(capped.tools.failed_tools.length, 25);
});

test('models extracts distinct reported models from usage events and tier_model from snapshot', () => {
  const events: NormalizedEvent[] = [
    {
      kind: 'usage',
      usage: [
        { model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { model: '   ', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ],
    },
    {
      kind: 'usage',
      usage: [
        { model: 'claude-opus-4-6', inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { model: 'claude-sonnet-4-6', inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ],
    },
  ];

  const claudeBundle = buildRunDiagnostics({
    run: makeRun({
      snapshot_json: JSON.stringify({
        executor: 'claude',
        tier: 'execute',
        tier_value: claudeTier('claude-sonnet-4-6'),
      }),
    }),
    events,
  });
  assert.deepEqual(claudeBundle.models, {
    tier_model: 'claude-sonnet-4-6',
    reported_models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
  });

  const codexBundle = buildRunDiagnostics({
    run: makeRun({
      snapshot_json: JSON.stringify({
        executor: 'codex',
        tier: 'decide',
        tier_value: codexTier('gpt-5.4'),
      }),
    }),
    events: [],
  });
  assert.deepEqual(codexBundle.models, {
    tier_model: 'gpt-5.4',
    reported_models: [],
  });
});

test('snapshot projection strictly enforces allowlist and strips secrets/unknown fields', () => {
  const run = makeRun({
    snapshot_json: JSON.stringify({
      goal: '实现诊断包',
      acceptance: '通过所有单测',
      role: {
        id: 'implement',
        name: '实现',
        description: '写代码',
        default_tier: 'execute',
        permission: 'write',
        deliverable: 'commit',
        needs_review: true,
        secret_extra: 'should-be-dropped',
      },
      tier: 'operate',
      tier_from: 'execute',
      tier_source: 'default',
      executor: 'claude',
      login: {
        executor: 'claude',
        machine: null,
        permission_mode: 'default',
        timeout_ms: 60_000,
        max_runs: 2,
        tiers: { execute: { kind: 'content', text: '{"model":"x"}' } },
        api_key: 'sk-should-never-appear-123456',
        token: 'secret-token-value',
      },
      source: {
        kind: 'repo',
        url: 'https://github.com/org/repo.git',
        binding_key: 'src1-12345678',
        branch: 'main',
      },
      access: {
        permission: 'read',
        layer: 'tools',
        args: ['--disallowedTools', 'Write'],
      },
      machine_inputs: {
        instructions: { off: 'settings', settings: { exclude: ['CLAUDE.md'] } },
        memory: { off: 'env' },
        extra_leaked: 'drop-me',
      },
      knowledge: [
        {
          id: 'k-1',
          revision: 3,
          title: '规范',
          loading: 'on_demand',
          scope: 'global',
          roles: ['implement'],
          path: 'knowledge/k-1@3.md',
          text: 'HUGE BODY SHOULD NOT BE IN SNAPSHOT PROJECTION',
          secret: 'drop-me-too',
        },
      ],
      // Arbitrary secret/non-allowlisted top-level fields:
      brief: 'giant brief text',
      credential_ref: 'cred-file-01',
      env: { ANTHROPIC_API_KEY: 'sk-top-level-secret-999999' },
      cookies: 'session=secretcookie',
      api_key: 'sk-another-secret-888888',
      unknown_field: { nested: true },
    }),
  });

  const bundle = buildRunDiagnostics({ run, task: makeTask(), events: [] });
  assert.ok(bundle.snapshot);
  assert.deepEqual(Object.keys(bundle.snapshot).sort(), [
    'acceptance',
    'access',
    'executor',
    'goal',
    'knowledge',
    'login',
    'machine_inputs',
    'role',
    'source',
    'tier',
    'tier_from',
    'tier_source',
  ]);
  assert.equal(bundle.snapshot.goal, '实现诊断包');
  assert.equal(bundle.snapshot.acceptance, '通过所有单测');
  assert.equal(bundle.snapshot.tier, 'operate');
  assert.equal(bundle.snapshot.tier_from, 'execute');
  assert.equal(bundle.snapshot.tier_source, 'default');
  assert.equal(bundle.snapshot.executor, 'claude');
  assert.deepEqual(bundle.snapshot.login, {
    executor: 'claude',
    machine: null,
    permission_mode: 'default',
    timeout_ms: 60_000,
    max_runs: 2,
  });
  assert.deepEqual(bundle.snapshot.knowledge, [
    {
      id: 'k-1',
      revision: 3,
      title: '规范',
      loading: 'on_demand',
      scope: 'global',
      roles: ['implement'],
      path: 'knowledge/k-1@3.md',
    },
  ]);

  const serialized = JSON.stringify(bundle.snapshot);
  assert.ok(!serialized.includes('sk-should-never-appear'));
  assert.ok(!serialized.includes('sk-top-level-secret'));
  assert.ok(!serialized.includes('sk-another-secret'));
  assert.ok(!serialized.includes('secretcookie'));
  assert.ok(!serialized.includes('cred-file-01'));
  assert.ok(!serialized.includes('giant brief text'));
  assert.ok(!serialized.includes('should-be-dropped'));
  assert.ok(!serialized.includes('HUGE BODY'));

  const corrupt = buildRunDiagnostics({
    run: makeRun({ snapshot_json: '{not-json' }),
    events: [],
  });
  assert.equal(corrupt.snapshot, null);
});

test('coverage and stderr bounds report gaps and slices honestly', () => {
  const headLines = Array.from({ length: 15 }, (_, i) => `head-${i} ${'x'.repeat(500)}`);
  const tailLines = Array.from({ length: 30 }, (_, i) => `tail-${i} ${'y'.repeat(500)}`);

  const bundle = buildRunDiagnostics({
    run: makeRun(),
    events: [{ kind: 'text', text: 'partial' }],
    firstIndex: 42,
    loaded: false,
    reason: '节点已离线，未能拉取完整事件',
    stderrHead: headLines,
    stderrTail: tailLines,
    platformVersion: '0.1.811',
  });

  assert.equal(bundle.platform_version, '0.1.811');
  assert.deepEqual(bundle.coverage, {
    events_loaded: false,
    events_count: 1,
    dropped_before_index: 42,
    incomplete_reason: '节点已离线，未能拉取完整事件',
    stderr_loaded: true,
  });
  assert.equal(bundle.stderr.head.length, 8);
  assert.equal(bundle.stderr.tail.length, 20);
  assert.ok(bundle.stderr.head[0]!.startsWith('head-0 '));
  assert.equal(bundle.stderr.head[0]!.length, 400);
  assert.ok(bundle.stderr.tail[0]!.startsWith('tail-10 '));
  assert.ok(bundle.stderr.tail.at(-1)!.startsWith('tail-29 '));
  assert.equal(bundle.stderr.tail[0]!.length, 400);

  const emptyCoverage = buildRunDiagnostics({
    run: makeRun(),
    events: [],
    firstIndex: -5,
    loaded: false,
    stderrHead: ['   ', '\n'],
  });
  assert.equal(emptyCoverage.coverage.dropped_before_index, 0);
  assert.equal(emptyCoverage.coverage.stderr_loaded, false);
  assert.equal(emptyCoverage.coverage.incomplete_reason, null);
});

test('integrates cleanly with ledger fixture and traceRun', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE);
  const settledRun = f.ledger.getRun(run.id);
  const currentTask = f.ledger.getTask(task.id);
  const trace = traceRun(f.ledger, run.id);

  const bundle = buildRunDiagnostics({
    run: settledRun,
    task: currentTask,
    trace,
    events: [
      { kind: 'tool.start', id: 'call-1', category: 'read', name: 'Read', title: 'README.md' },
      { kind: 'tool.end', id: 'call-1', isError: false },
      {
        kind: 'usage',
        usage: [{ model: 'claude-sonnet-4-6', inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }],
      },
    ],
    firstIndex: 0,
    loaded: true,
    platformVersion: '0.1.811',
  });

  assert.equal(bundle.schema_version, 1);
  assert.equal(bundle.run.id, run.id);
  assert.equal(bundle.run.task_id, task.id);
  assert.equal(bundle.run.status, 'ended');
  assert.equal(bundle.run.exit_kind, 'completed');
  assert.equal(typeof bundle.run.duration_ms, 'number');
  assert.equal(bundle.task?.id, task.id);
  assert.equal(bundle.task?.status, 'ready');
  assert.equal(bundle.trace?.run_id, run.id);
  assert.equal(bundle.trace?.settlement?.task_state, 'ready');
  assert.equal(bundle.tools.total, 1);
  assert.equal(bundle.tools.unfinished_count, 0);
  assert.deepEqual(bundle.models.reported_models, ['claude-sonnet-4-6']);
});

test('sanitizes secrets in trace inputs/messages and prefers error diagnostic over warning', () => {
  const run = makeRun({
    error_json: JSON.stringify({ reason: 'fatal backend error' }),
  });
  const bundle = buildRunDiagnostics({
    run,
    task: makeTask(),
    trace: {
      run_id: run.id,
      task_id: run.task_id,
      trigger: {
        kind: 'message',
        label: '负责人按消息派发',
        change: null,
        message: {
          id: 'm1',
          at: '2026-11-18T10:00:00.000Z',
          channel: 'console',
          actor: 'owner',
          text: 'use Authorization: Bearer top-secret-bearer-token-999',
        },
        tool_call: null,
      },
      origin_call: null,
      inputs: [
        {
          id: 'i1',
          created_at: '2026-11-18T10:00:05.000Z',
          task_id: run.task_id,
          actor: 'owner',
          text: '{"password":"json-secret-value-12345","note":"ok"}',
          message_id: null,
          state: 'attached',
          run_id: run.id,
        },
      ],
      session_ref: null,
      task_revision: 1,
      dispatchConditions: null,
      changes: [],
      settlement: null,
    },
    events: [
      { kind: 'diagnostic', level: 'warning', message: 'slow network warning' },
      { kind: 'diagnostic', level: 'fatal', message: 'actual fatal failure' },
    ],
  });

  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes('top-secret-bearer-token-999'), false);
  assert.equal(serialized.includes('json-secret-value-12345'), false);
  assert.equal(bundle.first_error?.source, 'diagnostic');
  assert.equal(bundle.first_error?.message, 'actual fatal failure');
});
