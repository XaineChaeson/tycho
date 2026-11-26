// Guards what a round's snapshot says about the input its machine still gives it, and that the
// round is started the way the snapshot says (docs/design/knowledge-and-skills.md §1.2, §4.1, §1.3):
//   - a round that keeps off tycho's global knowledge entry has to actually carry the exclusion
//     in the settings file it is started with, beside the tier's own settings,
//   - a round that cannot keep off it says it still reads it, rather than leaving it unsaid,
//   - the executor's memory across tasks passes through, and is turned off only in a round that
//     needs a view of its own (a knowledge gate here), by the declared way and only on a version
//     that way was measured on: below it Codex would refuse the switch, so it is not given,
//   - the knowledge MCP is turned off by name; for Codex only when the machine listed it, since
//     the switch stops Codex where no such server is configured,
//   - the machine's own configuration is recorded as it reported it, and what it did not report
//     is unknown, never "none",
//   - the tier's own text in the snapshot stays as the ledger held it.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { externalEntryOf, fixedKnowledgeInput, machineInputsHere, prepareSnapshot, roundTurn, snapshotFiles } from '../runner/snapshot.ts';
import type { Account } from '../runner/snapshot.ts';
import type { KnowledgeTaskMaterial } from '../service/knowledge-brief.ts';
import { machineInputsText } from '../shared/machine-inputs.ts';
import type { ReportedStatus } from '../shared/node-protocol.ts';
import type { NodeEntryReport } from '../shared/node-protocol.ts';
import { MATERIALS_PLACEHOLDER } from '../shared/node-protocol.ts';
import { formatTime } from '../shared/time.ts';
import { DONE, fixture, RUN_LIMIT_MS, USER } from './helpers.ts';

const EXECUTORS = { claude: claudeAdapter, codex: codexAdapter, dsh: dshAdapter };
const TIER = '{\n  "model": "m",\n  "claudeMdExcludes": ["/owner/own.md"]\n}';
const CLAUDE: Account = { id: 'a', name: 'a', executor: 'claude', tiers: { execute: { kind: 'content', text: TIER } } };
const CODEX: Account = { id: 'a', name: 'a', executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m' } } };
const DSH: Account = { id: 'a', name: 'a', executor: 'dsh', tiers: { execute: { kind: 'content', text: '- id: agent-default-model\n  config:\n    model: m\n' } } };
const GATE = { kind: 'gate', files: [], listing: '' } as unknown as KnowledgeTaskMaterial;

const reportOf = (executor: string, version: string | null, config?: ReportedStatus['config']): ReportedStatus =>
  ({ executor, installed: true, version, logged_in: true, asked_at: '2026-11-11T09:00:00.000Z', ...(config ? { config } : {}) });

const projected = (projection?: NodeEntryReport['executors'][number]['projection']): NodeEntryReport => ({
  digest: 'abcd', at: '2026-11-11T09:00:00.000Z',
  executors: [{ executor: 'codex', path: '/.codex/AGENTS.md', state: projection?.state === 'present' ? 'written' : 'cleared', ...(projection ? { projection } : {}) }],
});

test('fixed knowledge never blocks dispatch on external entry projection while externalEntryOf reports projection accurately', () => {
  const cli = reportOf('codex', 'codex-cli 0.167.1', [{ kind: 'mcp', names: [] }]);
  const decide = (report: NodeEntryReport | null, enabled = false) =>
    fixedKnowledgeInput(CODEX, 'execute', EXECUTORS, cli, report, enabled);
  assert.equal(externalEntryOf('codex', projected({ state: 'present', revisions: ['k@2'] })).state, 'present');
  for (const report of [null, projected(), projected({ state: 'present', revisions: ['k@2'] }), projected({ state: 'unknown', why: 'permission' }), projected({ state: 'absent' })]) {
    assert.deepEqual(decide(report, true), { ok: true, require_absence: false });
    assert.deepEqual(decide(report, false), { ok: true, require_absence: false });
  }
  const claude = reportOf('claude', '2.1.303 (Claude Code)');
  assert.deepEqual(fixedKnowledgeInput(CLAUDE, 'execute', EXECUTORS, claude, null, true), { ok: true, require_absence: false });
});

// `report`: what the machine the round goes to reported of the executor, null when it said nothing.
function snapshotOf(t: Parameters<typeof fixture>[0], login: Account, report: ReportedStatus | null = null, independent = false) {
  const f = fixture(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);
  return prepareSnapshot(task, login, EXECUTORS, { timeoutMs: RUN_LIMIT_MS, executorReport: report, ...(independent ? { knowledgeTask: GATE } : {}) });
}

test('Claude 档位内容：按原生配置运行，不注入隐藏 claudeMdExcludes 覆盖；快照与落盘档位原文一致', (t) => {
  const snapshot = snapshotOf(t, CLAUDE, reportOf('claude', '2.1.303 (Claude Code)'));
  assert.deepEqual(snapshot.machine_inputs?.instructions, { reads: '按执行器原生配置运行' });
  assert.equal(snapshot.tier_value.kind === 'content' && snapshot.tier_value.text, TIER);
  const turn = roundTurn(snapshot, 'r1');
  const file = snapshotFiles(snapshot).find(({ path }) => turn.tierPath === `${MATERIALS_PLACEHOLDER}/${path}`)!;
  const settings = JSON.parse(file.text) as { model: string; claudeMdExcludes: string[] };
  assert.equal(settings.model, 'm');
  assert.deepEqual(settings.claudeMdExcludes, ['/owner/own.md']);
  assert.match(machineInputsText(snapshot.machine_inputs!).join('\n'), /按执行器原生配置运行/);
});

test('Claude 无论上报什么版本：都保持原生配置，不注入隐藏排除项', (t) => {
  for (const report of [reportOf('claude', '2.1.200 (Claude Code)'), null]) {
    const snapshot = snapshotOf(t, CLAUDE, report);
    assert.deepEqual(snapshot.machine_inputs!.instructions, { reads: '按执行器原生配置运行' });
    const file = snapshotFiles(snapshot).find(({ path }) => path === 'tier.json')!;
    assert.deepEqual((JSON.parse(file.text) as { claudeMdExcludes: string[] }).claudeMdExcludes, ['/owner/own.md']);
  }
});

test('一般的一轮：执行器自己的记忆照常读写，启动时不带关闭开关', (t) => {
  for (const login of [CLAUDE, CODEX]) {
    const snapshot = snapshotOf(t, login, reportOf(login.executor, login.executor === 'codex' ? 'codex-cli 0.167.1' : '2.1.303 (Claude Code)'));
    assert.deepEqual(snapshot.machine_inputs!.memory, { scope: 'shared' }, login.executor);
    assert.match(machineInputsText(snapshot.machine_inputs!).join('\n'), /跨任务的记忆：照常读写/);
    const launch = EXECUTORS[login.executor as 'claude' | 'codex'].launch(roundTurn(snapshot, 'r1'));
    assert.ok(!launch.argv.includes('memories'), `${login.executor} 不带 --disable memories`);
    assert.equal(launch.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined, `${login.executor} 不关自动记忆`);
  }
});

test('独立视角的一轮（知识把关/审阅）：按执行器原生配置运行，不注入隐藏记忆关闭开关', (t) => {
  const claude = snapshotOf(t, CLAUDE, reportOf('claude', '2.1.303 (Claude Code)'), true);
  assert.deepEqual(claude.machine_inputs!.memory, { scope: 'shared' });
  assert.equal(claudeAdapter.launch(roundTurn(claude, 'r1')).env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
  const codex = snapshotOf(t, CODEX, reportOf('codex', 'codex-cli 0.167.1'), true);
  assert.deepEqual(codex.machine_inputs!.memory, { scope: 'shared' });
  assert.ok(!codexAdapter.launch(roundTurn(codex, 'r1')).argv.includes('--disable'));
});

test('Codex 任意版本：独立视角的一轮不带 --disable memories，照实记录记忆作用域', (t) => {
  for (const report of [reportOf('codex', 'codex-cli 0.150.0'), null]) {
    const snapshot = snapshotOf(t, CODEX, report, true);
    assert.deepEqual(snapshot.machine_inputs!.memory, { scope: 'shared' });
    assert.ok(!codexAdapter.launch(roundTurn(snapshot, 'r1')).argv.includes('--disable'));
  }
});

test('dsh：全局知识入口、跨任务的记忆、知识 MCP 均按原生配置如实标出', (t) => {
  const snapshot = snapshotOf(t, DSH, null, true);
  const lines = machineInputsText(snapshot.machine_inputs!).join('\n');
  assert.match(lines, /按执行器原生配置运行/);
  assert.match(lines, /执行器有没有自己跨任务的记忆说不清/);
  assert.match(lines, /这一轮可能用到机器上的知识 MCP/);
});

test('Claude：不注入隐藏 --disallowedTools mcp__tycho-knowledge 覆盖', (t) => {
  for (const report of [reportOf('claude', '2.1.303 (Claude Code)'), reportOf('claude', '2.1.200 (Claude Code)'), null]) {
    const snapshot = snapshotOf(t, CLAUDE, report);
    assert.deepEqual(snapshot.machine_inputs!.knowledge_mcp, { may_use: '按执行器原生配置运行' });
    assert.ok(!claudeAdapter.launch(roundTurn(snapshot, 'r1')).argv.includes('--disallowedTools'));
  }
});

test('Codex：不注入隐藏 mcp_servers.tycho-knowledge.enabled=false 覆盖，照实记录原生配置', (t) => {
  for (const report of [
    reportOf('codex', 'codex-cli 0.167.1', [{ kind: 'mcp', names: ['github', 'tycho-knowledge'] }]),
    reportOf('codex', 'codex-cli 0.167.1', [{ kind: 'mcp', names: ['github'] }]),
    reportOf('codex', 'codex-cli 0.167.1', [{ kind: 'mcp', error: 'codex mcp list --json 退出码 1' }]),
    null,
  ]) {
    const snapshot = snapshotOf(t, CODEX, report);
    assert.deepEqual(snapshot.machine_inputs!.knowledge_mcp, { may_use: '按执行器原生配置运行' });
    assert.ok(!codexAdapter.launch(roundTurn(snapshot, 'r1')).argv.some((arg) => arg.startsWith('mcp_servers.')));
  }
});

// The snapshot's machine_inputs are for the machine the round was prepared on; a round moved
// before it started refreshes the new machine's reported config without hidden overlays.
test('换机器后按新机器重算：更新机器报告的配置清单，不注入隐藏开关', (t) => {
  const listed = snapshotOf(t, CODEX, reportOf('codex', 'codex-cli 0.167.1', [{ kind: 'mcp', names: ['github', 'tycho-knowledge'] }]));
  assert.deepEqual(listed.machine_inputs!.config!.kinds.find(({ kind }) => kind === 'mcp'), { kind: 'mcp', names: ['github', 'tycho-knowledge'] });
  const elsewhere = machineInputsHere(listed, EXECUTORS, reportOf('codex', 'codex-cli 0.167.1', [{ kind: 'mcp', names: ['github'] }]))!;
  assert.deepEqual(elsewhere.config!.kinds.find(({ kind }) => kind === 'mcp'), { kind: 'mcp', names: ['github'] });
  const moved = { ...listed, machine_inputs: elsewhere };
  assert.equal(roundTurn(moved, 'r1').mcpOff, undefined);
  assert.equal(roundTurn(moved, 'r1').memoryOff, undefined);
  assert.ok(!codexAdapter.launch(roundTurn(moved, 'r1')).argv.some((arg) => arg.startsWith('mcp_servers.')));
  assert.ok(!codexAdapter.launch(roundTurn(moved, 'r1')).argv.includes('--disable'));
});

test('机器报告的配置清单照实记进快照，带问到的时间；没报告的种类是未知，不当成没有', (t) => {
  const snapshot = snapshotOf(t, CODEX, reportOf('codex', 'codex-cli 0.167.1', [{ kind: 'mcp', names: ['github'] }]));
  const config = snapshot.machine_inputs!.config!;
  assert.equal(config.asked_at, '2026-11-11T09:00:00.000Z');
  assert.deepEqual(config.kinds.find(({ kind }) => kind === 'mcp'), { kind: 'mcp', names: ['github'] });
  for (const kind of ['instructions', 'connectors', 'skills', 'plugins'] as const) {
    const each = config.kinds.find((entry) => entry.kind === kind)!;
    assert.ok('unknown' in each, kind);
  }
  const shown = machineInputsText(snapshot.machine_inputs!).join('\n');
  assert.ok(shown.includes(`照常生效（机器 ${formatTime('2026-11-11T09:00:00.000Z')} 报告）：`));
  assert.match(shown, /MCP 服务器 github/);
  // Claude declares its MCP servers unasked: listing them would start them.
  const claude = snapshotOf(t, CLAUDE, reportOf('claude', '2.1.303 (Claude Code)', [{ kind: 'plugins', names: [] }]));
  const kinds = claude.machine_inputs!.config!.kinds;
  assert.deepEqual(kinds.find(({ kind }) => kind === 'plugins'), { kind: 'plugins', names: [] });
  const mcp = kinds.find(({ kind }) => kind === 'mcp')!;
  assert.ok('unknown' in mcp && /起起来/.test(mcp.unknown));
});

test('审阅任务：只读权限生效，不注入隐藏记忆覆盖', (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  f.ledger.settleRun(run.id, 0, DONE as never);
  const registration = f.ledger.registerArtifacts(run.id, []);
  const review = f.ledger.createTask({
    projectId: f.projectId, title: '审', goal: '审', acceptance: '结论', roleId: 'review',
    reviewOf: { taskId: task.id, runId: run.id, revision: f.task(task.id).revision, registration },
  }, USER);
  const reviewer: Account = { ...CLAUDE, tiers: { ...CLAUDE.tiers, decide: { kind: 'content', text: '{"model":"m"}' } } };
  const snapshot = prepareSnapshot(review, reviewer, EXECUTORS, {
    timeoutMs: RUN_LIMIT_MS, executorReport: reportOf('claude', '2.1.303 (Claude Code)'), role: f.ledger.getRole('review')!,
  });
  assert.equal(snapshot.access?.permission, 'read');
  assert.deepEqual(snapshot.machine_inputs!.memory, { scope: 'shared' });
});

