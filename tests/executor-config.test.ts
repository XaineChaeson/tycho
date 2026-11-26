// Guards the executor's own configuration a machine reports, and the way a round turns tycho's
// knowledge MCP off by name (docs/design/knowledge-and-skills.md §1.2, §4.1), against the
// recordings in tests/fixtures/executor-config:
//   - a listing read into the wrong names (a disabled server taken for one that is on, a
//     plugin's path or version taken for its name), or anything else of the answer leaving
//     the machine (a configuration listing may carry an MCP server's environment);
//   - a query that would start the machine's MCP servers being asked at all;
//   - a kind that could not be read reported as an empty list, which the snapshot would take
//     for "none";
//   - the host keeping a configuration report out of the protocol's shape, a bad entry costing
//     a good one, or a client older than the host failing the poll;
//   - the arguments that turn a server off by name drifting from what was measured.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { ConfigQuery } from '../adapters/types.ts';
import type { CommandAnswer } from '../node/executors.ts';
import { probeExecutors, questionsFrom } from '../node/executors.ts';
import { createNodes } from '../service/nodes.ts';
import type { NodeExecutorReport } from '../shared/node-protocol.ts';
import { fixture, NODES_TUNED, USER } from './helpers.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'executor-config');
const recorded = (...path: string[]): string => readFileSync(join(DIR, ...path), 'utf8');
const asked = (queries: readonly ConfigQuery[] | undefined, kind: string) => {
  const query = queries?.find((each) => each.kind === kind);
  return query && 'argv' in query ? query : undefined;
};

test('Codex：mcp list --json 读出开着的服务器名，停用的不算；什么都没配是空清单', () => {
  const mcp = asked(codexAdapter.config, 'mcp')!;
  assert.deepEqual(mcp.argv, ['codex', 'mcp', 'list', '--json']);
  assert.deepEqual(mcp.parse(recorded('codex-0.167.1-win', 'mcp-list-three.json')), ['github', 'tycho-knowledge']);
  assert.deepEqual(mcp.parse(recorded('codex-0.167.1-win', 'mcp-list-three-off.json')), ['github'], '关掉以后它就不在开着的清单里');
  assert.deepEqual(mcp.parse(recorded('codex-0.167.1-win', 'mcp-list-http.json')), ['tycho-knowledge']);
  assert.deepEqual(mcp.parse(recorded('codex-0.167.1-win', 'mcp-list-none.json')), []);
  assert.equal(mcp.parse('not json'), undefined, '读不出来不是空清单');
  assert.equal(mcp.parse('{}'), undefined);
});

test('Codex：不再声明 mcpOff（原生 MCP 透传，不额外关掉服务器）', () => {
  assert.equal(codexAdapter.mcpOff, undefined);
});

test('Claude：plugin list --json 读出插件的 id；MCP 不问，也不声明 mcpOff', () => {
  const plugins = asked(claudeAdapter.config, 'plugins')!;
  assert.deepEqual(plugins.argv, ['claude', 'plugin', 'list', '--json']);
  assert.deepEqual(plugins.parse(recorded('claude-2.1.303-win', 'plugin-list.json')), ['codex@openai-codex', 'ops@demo-plugins', 'analytics@demo-plugins', 'playwright@synced']);
  assert.deepEqual(plugins.parse('[{"id":"off@m","enabled":false}]'), [], '停用的插件不算');
  assert.equal(plugins.parse('nope'), undefined);
  assert.equal(asked(claudeAdapter.config, 'mcp'), undefined);
  assert.ok(claudeAdapter.config!.some((query) => query.kind === 'mcp' && 'unasked' in query));
  assert.equal(claudeAdapter.mcpOff, undefined);
});

const ok = (stdout: string): CommandAnswer => ({ stdout, stderr: '', code: 0 });

test('机器上：questionsFrom 不再附带 mcp/plugin 配置探针；显式传入 config 探针时只带走解析出的名字且不泄密', async () => {
  const SECRET = 'sk-not-to-leave-this-machine';
  const table: Record<string, CommandAnswer> = {
    'claude --version': ok('2.1.303 (Claude Code)\n'),
    'claude plugin list --json': ok(`[{"id":"a@m","enabled":true,"installPath":"${SECRET}"}]`),
    'codex --version': ok('codex-cli 0.167.1\n'),
    'codex mcp list --json': { stdout: SECRET, stderr: '', code: 1 },
  };
  const commands: string[] = [];
  const run = async (argv: string[]): Promise<CommandAnswer> => {
    commands.push(argv.join(' '));
    return table[argv.join(' ')] ?? { stdout: '', stderr: '', code: null, failure: '不在这个测试里' };
  };
  const questions = questionsFrom({ claude: ADAPTERS.claude!, codex: ADAPTERS.codex! });
  assert.equal(questions.every((q) => q.config === undefined), true, 'questionsFrom 不附带 config 探针');
  const report = await probeExecutors({ questions, run, now: () => 0 });
  assert.ok(!commands.some((each) => each.includes('mcp list') || each.includes('plugin list')), '默认探针不跑 mcp/plugin list');
  assert.equal(report.executors.find((each) => each.executor === 'claude')!.config, undefined);
  assert.equal(report.executors.find((each) => each.executor === 'codex')!.config, undefined);

  // Explicit config queries still keep only parsed names and never leak secret fields or stderr/stdout.
  const explicit = questions.map((q) => ({
    ...q,
    config: q.executor === 'claude'
      ? [asked(claudeAdapter.config, 'plugins')!]
      : [asked(codexAdapter.config, 'mcp')!],
  }));
  const explicitReport = await probeExecutors({ questions: explicit, run, now: () => 0 });
  const of = (executor: string) => explicitReport.executors.find((each) => each.executor === executor)!;
  assert.deepEqual(of('claude').config, [{ kind: 'plugins', names: ['a@m'] }]);
  assert.deepEqual(of('codex').config, [{ kind: 'mcp', error: 'codex mcp list --json 退出码 1' }]);
  assert.ok(!JSON.stringify(explicitReport).includes(SECRET), '回答里的其余内容不离开机器');
});

test('主机收下配置那一段，只留协议里的字段；形状不对的项丢掉，其余照收，不拒整份', async (t) => {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 300, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const facts = { node_id: 'a1b2c3d4e5f60718', name: 'box', platform: 'linux', hostname: 'box' };
  const machine = nodes.approve(nodes.register(facts).code, USER)!;
  const AT = '2026-11-11T09:00:00.000Z';
  const report: NodeExecutorReport = {
    at: AT,
    executors: [{ executor: 'codex', installed: true, version: 'codex-cli 0.167.1', logged_in: true, config: [{ kind: 'mcp', names: ['github'] }, { kind: 'plugins', error: '读不出来' }] }],
  };
  await nodes.poll(machine.id, { runs: [], facts, executors: report });
  assert.deepEqual(nodes.reportedExecutors(machine.id), report);
  await nodes.poll(machine.id, { runs: [], facts, executors: { at: AT, executors: [{ executor: 'codex', installed: true, version: null, logged_in: true, config: [{ kind: 'mcp', names: ['x'], env: { K: 'v' } }] }] } as never });
  assert.deepEqual(nodes.reportedExecutors(machine.id)!.executors[0]!.config, [{ kind: 'mcp', names: ['x'] }]);
  // A newer client's unknown kind or a malformed entry is dropped; the good entry beside it stays.
  await nodes.poll(machine.id, { runs: [], facts, executors: { at: AT, executors: [{ executor: 'codex', installed: true, version: null, logged_in: true, config: [
    { kind: 'mcp', names: ['kept'] },
    { kind: 'secrets', names: [] },
    { kind: 'mcp', names: 'x' },
    { kind: 'mcp', names: ['a\nb'] },
    { kind: 'mcp', names: Array.from({ length: 201 }, (_, i) => `s${i}`) },
  ] }] } as never });
  assert.deepEqual(nodes.reportedExecutors(machine.id)!.executors[0]!.config, [{ kind: 'mcp', names: ['kept'] }]);
  // Not a list at all: the section is taken as not reported, and the poll still arrives.
  await nodes.poll(machine.id, { runs: [], facts, executors: { at: AT, executors: [{ executor: 'codex', installed: true, version: null, logged_in: true, config: 'mcp' }] } as never });
  assert.equal(nodes.reportedExecutors(machine.id)!.executors[0]!.config, undefined);
});

test('gemini config parses agy mcp list and plugin list recordings without leaking URLs or commands', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { geminiAdapter } = await import('../adapters/gemini.ts');
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'gemini', '1.5.9-win', name), 'utf8');
  const mcp = geminiAdapter.config!.find((each) => each.kind === 'mcp');
  const plugins = geminiAdapter.config!.find((each) => each.kind === 'plugins');
  assert.ok(mcp && 'argv' in mcp && plugins && 'argv' in plugins);
  assert.deepEqual(mcp.argv, ['agy', 'mcp', 'list']);
  assert.deepEqual(plugins.argv, ['agy', 'plugin', 'list', '--json']);

  assert.deepEqual(mcp.parse(fixture('mcp-empty.stdout')), []);
  assert.deepEqual(mcp.parse(fixture('mcp-listed.stdout')), ['alpha']);
  assert.equal(mcp.parse('unexpected output without header\n'), undefined);

  assert.deepEqual(plugins.parse(fixture('plugins-empty.stdout')), []);
  assert.deepEqual(plugins.parse(fixture('plugins-listed.stdout')), ['sample-plugin']);
  assert.deepEqual(plugins.parse(JSON.stringify([{ name: 'on', enabled: true }, { name: 'off', enabled: false }])), ['on']);
  assert.equal(plugins.parse('not-json'), undefined);
});
