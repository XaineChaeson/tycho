// Tests for deterministic task execution facts ("执行病历") extraction and end-to-end
// compatibility with `service/knowledge.ts`'s real `ledger.propose(...)` pipeline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedEvent } from '../adapters/types.ts';
import { extractTaskFacts, normalizeToolTitle, scrubSecrets } from '../service/run-facts.ts';
import { DONE, fixture, USER } from './helpers.ts';
import { GATE, MCP, OWNER, OWNER_SAYS } from './knowledge-helpers.ts';

test('smooth single-run task is not noteworthy and produces no proposal draft', () => {
  const events: NormalizedEvent[] = [
    { kind: 'tool.start', id: 't1', category: 'read', name: 'read_file', title: 'src/app.ts' },
    { kind: 'tool.end', id: 't1', isError: false },
    { kind: 'tool.start', id: 't2', category: 'run', name: 'bash', title: 'npm test' },
    { kind: 'tool.end', id: 't2', isError: false, exitCode: 0 },
    { kind: 'diagnostic', level: 'recovering', message: 'Reconnecting... attempt 1' },
  ];

  const facts = extractTaskFacts({
    task: { id: 'task-smooth', project_id: 'proj-1', title: '常规修复' },
    runs: [
      {
        id: 'run-1',
        created_at: '2026-05-01T10:00:00.000Z',
        ended_at: '2026-05-01T10:02:00.000Z',
        exit_kind: 'completed',
        receipt_json: JSON.stringify(DONE),
      },
    ],
    changes: [
      { seq: 1, at: '2026-05-01T09:59:00.000Z', action: 'task.create', task_id: 'task-smooth' },
      { seq: 2, at: '2026-05-01T10:02:00.000Z', action: 'run.settle', task_id: 'task-smooth', run_id: 'run-1' },
    ],
    eventsByRun: new Map([['run-1', events]]),
  });

  assert.equal(facts.task_id, 'task-smooth');
  assert.equal(facts.project_id, 'proj-1');
  assert.equal(facts.analyzed_runs, 1);
  assert.equal(facts.failed_rounds, 0);
  assert.equal(facts.escalations, 0);
  assert.equal(facts.noteworthy, false);
  assert.deepEqual(facts.noteworthy_reasons, []);
  assert.deepEqual(facts.ping_pong, []);
  assert.deepEqual(facts.tool_repeats, []);
  assert.deepEqual(facts.error_facts, []);
  assert.equal(facts.proposal_draft, null);
});

test('detects repeated tool calls (>= 3 after normalization) and consecutive tool errors (>= 2)', () => {
  const repeatedEvents: NormalizedEvent[] = [
    // Three calls with different line numbers & UUIDs collapse to one normalized title
    { kind: 'tool.start', id: 'c1', category: 'run', name: 'bash', title: 'npm test src/foo.ts:12 550e8400-e29b-41d4-a716-446655440000' },
    { kind: 'tool.end', id: 'c1', isError: false, exitCode: 0 },
    { kind: 'tool.start', id: 'c2', category: 'run', name: 'bash', title: 'npm test src/foo.ts:45 123e4567-e89b-12d3-a456-426614174000' },
    { kind: 'tool.end', id: 'c2', isError: false, exitCode: 0 },
    { kind: 'tool.start', id: 'c3', category: 'run', name: 'bash', title: 'npm test src/foo.ts:99 987e6543-e21b-12d3-a456-426614174999' },
    { kind: 'tool.end', id: 'c3', isError: true, exitCode: 1 },
    // Consecutive errors (2 in a row) on another tool reported via tool.end.call
    { kind: 'tool.end', id: 'e1', isError: true, call: { category: 'edit', name: 'apply_patch', title: 'patch src/bar.ts line 10' } },
    { kind: 'tool.end', id: 'e2', isError: true, call: { category: 'edit', name: 'apply_patch', title: 'patch src/bar.ts line 22' } },
    // Non-consecutive errors (fail -> ok -> fail, count 3? no, count 2 errors + 1 ok = count 3 would trigger count; keep 2 calls: fail -> ok)
    { kind: 'tool.start', id: 'ok1', category: 'read', name: 'read_file', title: 'README.md' },
    { kind: 'tool.end', id: 'ok1', isError: true },
    { kind: 'tool.start', id: 'ok2', category: 'read', name: 'read_file', title: 'README.md' },
    { kind: 'tool.end', id: 'ok2', isError: false },
  ];

  // Test Record form of eventsByRun as well
  const facts = extractTaskFacts({
    task: { id: 'task-tools', project_id: 'proj-tools', title: '修复测试脚本' },
    runs: [{ id: 'run-t1', created_at: '2026-05-01T10:00:00.000Z', exit_kind: 'completed' }],
    changes: [],
    eventsByRun: { 'run-t1': repeatedEvents },
  });

  assert.equal(facts.noteworthy, true);
  assert.equal(facts.tool_repeats.length, 2);

  const patchRepeat = facts.tool_repeats.find((item) => item.name === 'apply_patch')!;
  assert.equal(patchRepeat.run_id, 'run-t1');
  assert.equal(patchRepeat.count, 2);
  assert.equal(patchRepeat.error_count, 2);
  assert.equal(patchRepeat.consecutive_errors, 2);
  assert.equal(patchRepeat.normalized_title, 'patch src/bar.ts line <n>');

  const bashRepeat = facts.tool_repeats.find((item) => item.name === 'bash')!;
  assert.equal(bashRepeat.count, 3);
  assert.equal(bashRepeat.error_count, 1);
  assert.equal(bashRepeat.consecutive_errors, 1);
  assert.equal(bashRepeat.normalized_title, 'npm test src/foo.ts:<n> <uuid>');

  assert.equal(facts.tool_repeats.some((item) => item.name === 'read_file'), false);
  assert.ok(facts.noteworthy_reasons.some((r) => r.includes('apply_patch') || r.includes('bash')));
  assert.ok(facts.proposal_draft !== null);
  assert.deepEqual(facts.proposal_draft.outputs[0]!.project_ids, ['proj-tools']);
});

test('detects ping-pong rejections, reworks, and tier escalations from real ledger change actions', () => {
  const facts = extractTaskFacts({
    task: { id: 'task-pp', project_id: 'proj-pp', title: '并发锁修复' },
    runs: [
      { id: 'run-1', created_at: '2026-05-01T10:00:00.000Z', exit_kind: 'completed' },
      { id: 'run-2', created_at: '2026-05-01T10:15:00.000Z', exit_kind: 'completed' },
    ],
    changes: [
      {
        seq: 10,
        at: '2026-05-01T10:05:00.000Z',
        actor: 'runner',
        task_id: 'task-pp',
        run_id: 'run-1',
        action: 'review.verdict',
        detail_json: JSON.stringify({ reviewed_task_id: 'task-pp', result: 'reject', current: true }),
      },
      {
        seq: 11,
        at: '2026-05-01T10:05:01.000Z',
        actor: 'runner',
        task_id: 'task-pp',
        action: 'task.rework',
        detail_json: JSON.stringify({ input_id: 'inp-1', revision: 1, review_task_id: 'rev-1' }),
      },
      {
        seq: 12,
        at: '2026-05-01T10:05:02.000Z',
        actor: 'runner',
        task_id: 'task-pp',
        action: 'task.escalate',
        detail_json: JSON.stringify({ review_task_id: 'rev-1', from: 'execute', to: 'decide', reason: '审阅打回后升档' }),
      },
      {
        seq: 20,
        at: '2026-05-01T10:20:00.000Z',
        actor: 'runner',
        task_id: 'task-pp',
        run_id: 'run-2',
        action: 'approval.open',
        detail_json: JSON.stringify({ approval_id: 'app-1', review_task_id: 'rev-2' }),
      },
    ],
    eventsByRun: new Map(),
  });

  assert.equal(facts.noteworthy, true);
  assert.equal(facts.escalations, 1);
  assert.equal(facts.ping_pong.length, 4);
  assert.deepEqual(
    facts.ping_pong.map((item) => item.kind),
    ['rejection', 'rework', 'escalation', 'rejection'],
  );
  assert.ok(facts.noteworthy_reasons.some((r) => r.includes('打回/返工')));
  assert.ok(facts.noteworthy_reasons.some((r) => r.includes('升档')));
  assert.ok(facts.proposal_draft !== null);
});

test('deduplicates errors, filters retry chatter, and scrubs all secrets', () => {
  const fakeHex64 = 'a'.repeat(64);
  const fakeSk = 'sk-proj-1234567890abcdefghijklmnop';
  const fakeBearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload1234567890.sig1234567890';
  const fakeTychoEnv = `TYCHO_KNOWLEDGE_TOKEN=${fakeHex64}`;
  const fakePem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';

  assert.equal(normalizeToolTitle(`curl -H "Authorization: ${fakeBearer}" https://user:pass@example.com/v1/items/42`), 'curl -H "Authorization: Bearer [REDACTED]" https://[REDACTED]@example.com/v1/items/<n>');
  assert.ok(!scrubSecrets(fakePem).includes('BEGIN RSA PRIVATE KEY'));
  assert.ok(!scrubSecrets(fakeTychoEnv).includes('TYCHO_KNOWLEDGE_TOKEN'));
  assert.ok(!scrubSecrets(fakeTychoEnv).includes(fakeHex64));

  const facts = extractTaskFacts({
    task: { id: 'task-err', project_id: null, title: '接口认证失败排查' },
    runs: [
      {
        id: 'run-e1',
        created_at: '2026-05-01T11:00:00.000Z',
        ended_at: '2026-05-01T11:01:00.000Z',
        exit_kind: 'failed',
        error_json: JSON.stringify({ reason: `ECONNREFUSED 127.0.0.1:8080 with ${fakeSk} at 2026-05-01T11:00:30Z` }),
      },
      {
        id: 'run-e2',
        created_at: '2026-05-01T11:05:00.000Z',
        ended_at: '2026-05-01T11:06:00.000Z',
        exit_kind: 'failed',
        error_json: JSON.stringify({ reason: `ECONNREFUSED 127.0.0.1:9090 with ${fakeSk} at 2026-05-01T11:05:30Z` }),
      },
      {
        // Quota rest should NOT count as a failed round or error fact.
        id: 'run-q1',
        created_at: '2026-05-01T11:08:00.000Z',
        ended_at: '2026-05-01T11:08:10.000Z',
        exit_kind: 'quota',
        error_json: JSON.stringify({ reason: '额度用完，休息至次日' }),
      },
    ],
    changes: [],
    eventsByRun: new Map<string, NormalizedEvent[]>([
      [
        'run-e1',
        [
          { kind: 'diagnostic', level: 'recovering', message: 'Reconnecting... attempt 2' },
          { kind: 'diagnostic', level: 'warning', message: 'Retrying in 5s...' },
          { kind: 'diagnostic', level: 'fatal', message: `Fatal auth error: ${fakeTychoEnv} and ${fakePem}` },
        ],
      ],
    ]),
  });

  assert.equal(facts.failed_rounds, 2);
  assert.equal(facts.noteworthy, true);
  assert.ok(facts.noteworthy_reasons.some((r) => r.includes('累计 2 轮执行失败')));

  // Chatter diagnostics were excluded; ECONNREFUSED across two runs collapsed into count 2.
  const connErr = facts.error_facts.find((item) => item.signature.includes('econnrefused'))!;
  assert.equal(connErr.count, 2);
  assert.equal(connErr.first_run_id, 'run-e1');
  assert.equal(connErr.first_at, '2026-05-01T11:01:00.000Z');
  assert.ok(!connErr.sample.includes(fakeSk));

  const fatalErr = facts.error_facts.find((item) => item.signature.includes('fatal auth error'))!;
  assert.equal(fatalErr.count, 1);
  assert.ok(!fatalErr.sample.includes(fakeHex64));
  assert.ok(!fatalErr.sample.includes('TYCHO_KNOWLEDGE_TOKEN'));
  assert.ok(!fatalErr.sample.includes('BEGIN RSA PRIVATE KEY'));

  // No chatter entries leaked into error_facts.
  assert.equal(facts.error_facts.some((item) => /reconnecting|retrying/i.test(item.sample)), false);

  // Proposal draft for a project-less task uses project_ids: null and contains no secrets.
  assert.ok(facts.proposal_draft !== null);
  assert.equal(facts.proposal_draft.outputs[0]!.project_ids, null);
  const serialized = JSON.stringify(facts.proposal_draft);
  assert.ok(!serialized.includes(fakeSk));
  assert.ok(!serialized.includes(fakeHex64));
  assert.ok(!serialized.includes('TYCHO_KNOWLEDGE_TOKEN'));
  assert.ok(!serialized.includes('BEGIN RSA PRIVATE KEY'));
});

test('end-to-end: generated proposal_draft passes real ledger.propose() validation (gate & owner paths)', (t) => {
  const f = fixture(t);
  f.ledger.putAccount(GATE, USER, 'ref-g1');

  // Issue a real Tycho knowledge client token to prove our scrubber prevents issued-token rejection.
  const { token: issuedToken } = f.ledger.addClient(
    { name: '测试客户端', executor: 'codex', grants: ['read', 'propose'] },
    ['claude', 'codex'],
    OWNER,
  );

  // Round 1: fails with a real error recorded on the run.
  const { task, run: run1 } = f.runningRun();
  f.ledger.settleRun(run1.id, 1, {
    status: 'failed',
    summary: '迁移脚本执行失败：缺少目标索引 users_email_idx',
  });

  // Resume and run round 2: completes, then gets reworked twice (or fails again).
  f.ledger.resumeTask(task.id, USER);
  const login = f.ledger.getMachineLogin(f.login.login.machine, f.login.login.executor)!;
  const run2 = f.ledger.createRun(
    task.id,
    { ...f.login, login: { ...f.login.login, id: login.id, name: login.name }, expectedRevision: f.task(task.id).revision },
    USER,
  );
  f.ledger.markRunRunning(run2.id);
  f.ledger.settleRun(run2.id, 1, {
    status: 'failed',
    summary: `迁移脚本执行失败：缺少目标索引 users_email_idx（调试带了 ${issuedToken}）`,
  });

  const eventsByRun = new Map<string, NormalizedEvent[]>([
    [
      run1.id,
      [
        { kind: 'tool.start', id: 'a1', category: 'run', name: 'bash', title: 'node scripts/migrate.ts --step 1' },
        { kind: 'tool.end', id: 'a1', isError: true, exitCode: 1 },
        { kind: 'tool.start', id: 'a2', category: 'run', name: 'bash', title: 'node scripts/migrate.ts --step 2' },
        { kind: 'tool.end', id: 'a2', isError: true, exitCode: 1 },
        { kind: 'diagnostic', level: 'fatal', message: `X-Tycho-Knowledge-Token: ${issuedToken}` },
      ],
    ],
  ]);

  const facts = extractTaskFacts({
    task: f.task(task.id),
    runs: f.ledger.listRuns(task.id),
    changes: f.ledger.listChanges({ taskId: task.id }),
    eventsByRun,
  });

  assert.equal(facts.noteworthy, true);
  assert.equal(facts.failed_rounds, 2);
  assert.equal(facts.tool_repeats.length, 1);
  assert.ok(facts.proposal_draft !== null);
  assert.deepEqual(facts.proposal_draft.outputs[0]!.project_ids, [f.projectId]);

  // Path 1: Non-owner proposer (e.g., MCP/router) for project-scoped draft -> publishes directly (unreviewed) with verified evidence!
  const direct = f.ledger.propose({ ...facts.proposal_draft, request_id: 'e2e-gate-1' }, MCP, USER);
  assert.equal(direct.duplicate, false);
  assert.equal(direct.state, 'published');

  const storedProposal = f.ledger.getProposal(direct.id);
  assert.equal(storedProposal.gate_task_id, null);
  // The clean run1 receipt excerpt is verified directly against the ledger's run row!
  assert.ok(
    storedProposal.evidence.some((item) => item.source === 'run' && item.ref === run1.id && item.verified),
    'expected at least one verified run evidence item',
  );
  assert.equal(f.ledger.listEntries().length, 1);
  assert.equal(f.ledger.listEntries()[0]!.reviewed_at, null);

  // Path 2: Owner console proposer (exact pathway of `POST /api/knowledge/proposals`) -> publishes as reviewed!
  const published = f.ledger.propose({ ...facts.proposal_draft, request_id: 'e2e-console-1' }, OWNER_SAYS, OWNER);
  assert.equal(published.duplicate, false);
  assert.equal(published.state, 'published');
  assert.equal(f.ledger.listEntries().length, 2);
  assert.deepEqual(f.ledger.listEntries()[1]!.project_ids, [f.projectId]);
  assert.ok(f.ledger.listEntries()[1]!.reviewed_at !== null);
});

test('deduplicates single review rejection + escalation and scrubs JSON-quoted secrets across proposal_draft', () => {
  const facts = extractTaskFacts({
    task: { id: 'T_DUP', project_id: 'P1', title: '审阅打回升档测试' },
    runs: [
      {
        id: 'R_DUP_1',
        created_at: '2026-11-18T10:00:00.000Z',
        exit_kind: 'failed',
        error_json: JSON.stringify({ reason: 'db login failed: {"password":"json-secret-password-999","user":"app"}' }),
      },
    ],
    changes: [
      {
        seq: 10,
        at: '2026-11-18T10:05:00.000Z',
        task_id: 'REV_1',
        run_id: 'REV_RUN_1',
        action: 'review.verdict',
        detail_json: JSON.stringify({ reviewed_task_id: 'T_DUP', result: 'reject', current: true }),
      },
      {
        seq: 11,
        at: '2026-11-18T10:05:00.000Z',
        task_id: 'T_DUP',
        action: 'task.rework',
        detail_json: JSON.stringify({ review_task_id: 'REV_1', revision: 1 }),
      },
      {
        seq: 12,
        at: '2026-11-18T10:05:00.000Z',
        task_id: 'T_DUP',
        action: 'task.escalate',
        detail_json: JSON.stringify({ review_task_id: 'REV_1', from: 'execute', to: 'decide' }),
      },
    ],
    eventsByRun: new Map(),
  });

  assert.equal(facts.noteworthy, true);
  assert.equal(facts.escalations, 1);
  // Single review rejection + escalation must NOT be reported as "发生 2 次打回/返工".
  assert.equal(facts.noteworthy_reasons.some((r) => r.includes('发生 2 次打回/返工')), false);
  assert.equal(facts.noteworthy_reasons.includes('发生 1 次打回/返工'), true);
  assert.equal(facts.noteworthy_reasons.includes('触发 1 次升档'), true);

  const serialized = JSON.stringify(facts);
  assert.equal(serialized.includes('json-secret-password-999'), false);
});
