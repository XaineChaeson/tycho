// Guards the read-only probe a machine runs when it reports its executors (docs/design/
// nodes.md §1.2, roles-and-tiers.md §5): whether each executor's read-only way starts on
// this machine, in the executor's own words when it does not.
//
// What this file is here to catch:
//   - a read-only way reported available when its probe failed, timed out or could not be
//     read — "说不清" is not available;
//   - the probe's own words lost, so the page cannot say why;
//   - an executor too old for the program's commands reported as usable, or asked further
//     questions as if it were;
//   - the host keeping a report whose read-only part is not the shape this protocol defines,
//     or dropping that part from a report it keeps;
//   - a client that checks a read-only round's code afterwards not saying so beside an
//     available way, or the host dropping that word.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import type { CommandAnswer } from '../node/executors.ts';
import { probeExecutors, questionsFrom } from '../node/executors.ts';
import { createAccounts } from '../service/accounts.ts';
import { InputError } from '../service/errors.ts';
import { createNodes } from '../service/nodes.ts';
import { fixture, USER, NODES_TUNED } from './helpers.ts';

const ok = (stdout: string): CommandAnswer => ({ stdout, stderr: '', code: 0 });
const HELP_CLAUDE = '  --disallowedTools, --disallowed-tools <tools...>   Comma or space-separated list of tool names to deny\n  --tools <tools...>   Specify the list of available tools\n';
const BWRAP = "bwrap: Can't bind mount /oldroot/ on /newroot/: Unable to mount source on destination: Invalid argument";

function answering(table: Record<string, CommandAnswer>) {
  const asked: string[] = [];
  const run = async (argv: string[]): Promise<CommandAnswer> => {
    asked.push(argv.join(' '));
    return table[argv.join(' ')] ?? { stdout: '', stderr: '', code: null, failure: `这个测试不该运行 ${argv.join(' ')}` };
  };
  return { run, asked };
}

const ALL_FINE: Record<string, CommandAnswer> = {
  'claude --version': ok('2.1.312 (Claude Code)\n'),
  'claude auth status': ok('{}'),
  'claude --help': ok(HELP_CLAUDE),
  'codex --version': ok('codex-cli 0.163.0\n'),
  'codex login status': ok(''),
  'dsh --version': ok('0.2.2-rc.1\n'),
  'agy --version': ok('1.5.9\n'),
};

// Without the models, configuration and token questions each adapter declares beside these:
// node-models.test.ts, executor-config.test.ts and node-credential-probe.test.ts guard them.
const questions = questionsFrom(Object.fromEntries(Object.entries(ADAPTERS).map(([executor, adapter]) => [executor, { ...adapter, listModels: undefined, config: undefined, credentialCheck: undefined }])));

test('所有已安装执行器默认通过框架契约层提供只读，无需额外只读探针子进程', async () => {
  const { run, asked } = answering(ALL_FINE);
  const report = await probeExecutors({ questions, run });
  assert.deepEqual(report.executors.map(({ executor, read_only, unusable }) => ({ executor, read_only, unusable })), [
    { executor: 'claude', read_only: { available: true, layer: 'contract', checks_code: true }, unusable: undefined },
    { executor: 'codex', read_only: { available: true, layer: 'contract', checks_code: true }, unusable: undefined },
    { executor: 'dsh', read_only: { available: true, layer: 'contract', checks_code: true }, unusable: undefined },
    { executor: 'gemini', read_only: { available: true, layer: 'contract', checks_code: true }, unusable: undefined },
  ]);
  assert.deepEqual([...new Set(asked)].sort(), ['agy --version', 'claude --version', 'claude auth status', 'codex --version', 'codex login status', 'dsh --version'].sort(), '只问版本与登录，不额外起只读沙箱或 help 探针');
});

test('起不来就报不可用，带上原话：自定义只读探针失败时保留原话且不影响可写工作', async () => {
  const customQuestions = questions.map((q) => q.executor === 'codex'
    ? { ...q, readOnly: { layer: 'filesystem' as const, probe: { argv: ['codex', 'sandbox', '-c', 'sandbox_mode=read-only', '--', 'codex', '--version'] } } }
    : q);
  const { run } = answering({ ...ALL_FINE, 'codex sandbox -c sandbox_mode=read-only -- codex --version': { stdout: '', stderr: `${BWRAP}\n`, code: 1 } });
  const codex = (await probeExecutors({ questions: customQuestions, run })).executors.find((each) => each.executor === 'codex')!;
  assert.equal(codex.read_only?.available, false);
  assert.match(codex.read_only?.error ?? '', /bwrap: Can't bind mount/);
  // The executor itself is fine: it takes writable work as before.
  assert.equal(codex.installed, true);
  assert.equal(codex.logged_in, true);
  assert.equal(codex.unusable, undefined);
});

test('说不清也是不可用：自定义探针超时、跑不了或检查未通过', async () => {
  const customQuestions = questions.map((q) => {
    if (q.executor === 'codex') {
      return { ...q, readOnly: { layer: 'filesystem' as const, probe: { argv: ['codex', 'sandbox', '-c', 'sandbox_mode=read-only', '--', 'codex', '--version'] } } };
    }
    if (q.executor === 'claude') {
      return { ...q, readOnly: { layer: 'tools' as const, probe: { argv: ['claude', '--help'], check: (out: string) => out.includes('--disallowedTools') ? undefined : '缺少 --disallowedTools' } } };
    }
    return q;
  });
  const { run } = answering({
    ...ALL_FINE,
    'codex sandbox -c sandbox_mode=read-only -- codex --version': { stdout: '', stderr: '', code: null, failure: 'codex sandbox … 超过 6000 毫秒没有回答' },
    'claude --help': ok('  --tools <tools...>\n'),
  });
  const report = await probeExecutors({ questions: customQuestions, run });
  const of = (name: string) => report.executors.find((each) => each.executor === name)!.read_only;
  assert.deepEqual(of('codex'), { available: false, layer: 'filesystem', error: 'codex sandbox … 超过 6000 毫秒没有回答' });
  assert.equal(of('claude')?.available, false);
  assert.match(of('claude')?.error ?? '', /--disallowedTools/);
});

test('dsh 旧版：不再标记 unusable，保持框架只读可用', async () => {
  const { run, asked } = answering({ ...ALL_FINE, 'dsh --version': ok('0.2.1-rc.5\n') });
  const dsh = (await probeExecutors({ questions, run })).executors.find((each) => each.executor === 'dsh')!;
  assert.equal(dsh.unusable, undefined);
  assert.equal(dsh.version, '0.2.1-rc.5');
  assert.deepEqual(dsh.read_only, { available: true, layer: 'contract', checks_code: true });
  assert.deepEqual(asked.filter((line) => line.startsWith('dsh')), ['dsh --version']);
});

test('没装的执行器不问只读', async () => {
  const { run, asked } = answering({ ...ALL_FINE, 'codex --version': { stdout: '', stderr: '', code: null, failure: '这台机器上没有 codex（PATH 里没有这个命令）' } });
  const codex = (await probeExecutors({ questions, run })).executors.find((each) => each.executor === 'codex')!;
  assert.equal(codex.installed, false);
  assert.equal(codex.read_only, undefined);
  assert.ok(!asked.some((line) => line.startsWith('codex sandbox')));
});

const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'm1', platform: 'linux', hostname: 'm1' };
function hub(t: TestContext) {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 300, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;
  return { nodes, machine };
}

test('主机收下只读那一段，原样留给页面和派发；形状不对就整份拒收', async (t) => {
  const { nodes, machine } = hub(t);
  const report = {
    at: '2026-11-09T10:00:00.000Z',
    executors: [
      { executor: 'codex', installed: true, version: 'codex-cli 0.163.0', logged_in: true, read_only: { available: false, layer: 'filesystem', error: BWRAP } },
      { executor: 'dsh', installed: true, version: '0.2.1-rc.5', logged_in: null, unusable: '这一版用不了：不认 --permission-mode，升到 0.2.2-rc.1 以上' },
      { executor: 'claude', installed: true, version: '2.1.312', logged_in: true, path: 'C:\\Users\\o\\.local\\bin\\claude.exe', read_only: { available: true, layer: 'tools', checks_code: true } },
    ],
  };
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: report });
  assert.deepEqual(nodes.reportedExecutors(machine.id), report, '只读那一段原样留下，客户端说会核对代码的那一句也在');
  // Anything but `true` is a client that did not say it: the word is not kept.
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: report.at, executors: [{ executor: 'claude', installed: true, version: '2.1.312', logged_in: true, read_only: { available: true, layer: 'tools', checks_code: 'yes' } }] } });
  assert.equal(nodes.reportedExecutors(machine.id)!.executors[0]!.read_only!.checks_code, undefined);
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: report });
  const bad = [
    { executor: 'claude', installed: true, logged_in: true, read_only: { available: 'yes', layer: 'tools' } },
    { executor: 'claude', installed: true, logged_in: true, read_only: { available: true, layer: 'everything' } },
    { executor: 'claude', installed: true, logged_in: true, read_only: { available: false, layer: 'tools', error: 3 } },
    { executor: 'claude', installed: true, logged_in: true, unusable: 5 },
    { executor: 'claude', installed: true, logged_in: true, path: ['C:\\'] },
    { executor: 'claude', installed: true, logged_in: true, path: 'C:\\a\nb' },
  ];
  for (const each of bad) {
    await assert.rejects(async () => nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: report.at, executors: [each] } }), InputError, JSON.stringify(each));
  }
  assert.deepEqual(nodes.reportedExecutors(machine.id), report, '拒收的一份不替掉前一份');
});

// The machine page reads a report by this host's own declarations: an executor that offers no
// read-only way is said as such, and a version too old for this host's commands is said as
// that even when the client, older than the host, did not say so itself.
test('主机按自己的声明读报告：已注册执行器均提供框架只读；版本号不再把执行器判成用不了', (t) => {
  const f = fixture(t);
  const accounts = createAccounts({ ledger: f.ledger, executors: ADAPTERS, credentialExecutors: [], dataDir: f.dir, log: () => {} });
  const dsh = accounts.judgeReport({ executor: 'dsh', installed: true, version: '0.2.1-rc.5', logged_in: null });
  assert.equal(dsh.read_only_offered, true);
  assert.equal(dsh.unusable, undefined);
  const unknown = accounts.judgeReport({ executor: 'unknown-exec', installed: true, version: '1.0.0', logged_in: null });
  assert.equal(unknown.read_only_offered, false);
  const codex = accounts.judgeReport({ executor: 'codex', installed: true, version: 'codex-cli 0.163.0', logged_in: true, read_only: { available: true, layer: 'filesystem' } });
  assert.equal(codex.read_only_offered, true);
  assert.equal(codex.unusable, undefined);
  assert.equal(accounts.judgeReport({ executor: 'dsh', installed: false, version: null, logged_in: null }).unusable, undefined, '没装就只是没装');
});
