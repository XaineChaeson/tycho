// Guards what a machine reports about its own executors (docs/design/nodes.md §1.2, §11 step
// 5): which commands are asked, and what is read out of their answers.
//
// What this file is here to catch:
//   - a question that is not the executor's own declared command (the set is closed, and the
//     host cannot put a command line into it),
//   - a login judged from the words a CLI prints instead of its exit code — for one of these
//     two the words are not even on stdout,
//   - a version read out of a warning on stderr, or one executor's failure swallowing
//     another's answer,
//   - a command that hangs holding the whole look open, and a look that ends with a
//     command still running on the machine.
import './guard.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { HostProcesses } from '../node/hostprocess.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { CommandAnswer, ExecutorQuestion } from '../node/executors.ts';
import { PROBE_TIMEOUT_MS, probeExecutors, questionsFrom, shellInvocation, shellRun, versionLine } from '../node/executors.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'login-status');
const CLAUDE = 'claude-2.1.303-win';
const CODEX = 'codex-0.162.0-win';
const AT = Date.parse('2026-11-06T10:00:00.000Z');

const read = (dir: string, name: string): string => {
  const file = join(FIXTURES, dir, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
// One recorded command: the two streams as they were, and the exit code. A file that is not
// there is a stream the command said nothing on.
const recorded = (dir: string, name: string): CommandAnswer => ({
  stdout: read(dir, `${name}.stdout.txt`),
  stderr: read(dir, `${name}.stderr.txt`),
  code: Number(read(dir, `${name}.exit`).trim()),
});

// A machine whose answers are decided by the test, and which keeps what it was asked. A
// command with no answer in the table is one this test did not expect to be run.
function answering(table: Record<string, CommandAnswer>) {
  const asked: string[] = [];
  const run = async (argv: string[], timeoutMs: number): Promise<CommandAnswer> => {
    asked.push(`${argv.join(' ')} @${timeoutMs}`);
    return table[argv.join(' ')] ?? { stdout: '', stderr: '', code: null, failure: `这个测试不该运行 ${argv.join(' ')}` };
  };
  return { run, asked };
}

// Both executors, both recorded: their version, and their login answer in the state asked
// for. `logged-in` and `logged-out` are the two recordings there are (README.md: the expired
// token and the unsupported command were not recorded).
const BOTH = (login: 'logged-in' | 'logged-out'): Record<string, CommandAnswer> => ({
  'claude --version': recorded(CLAUDE, 'version'),
  'claude auth status': recorded(CLAUDE, login),
  'codex --version': recorded(CODEX, 'version'),
  'codex login status': recorded(CODEX, login),
});

// The version and login questions alone: the read-only probe each adapter declares beside
// them is guarded in node-readonly-probe.test.ts, the models question in node-models.test.ts,
// the configuration questions in executor-config.test.ts, the token question in
// node-credential-probe.test.ts, and the quota question in node-quota.test.ts.
const TWO = questionsFrom({
  claude: { ...claudeAdapter, readOnly: undefined, listModels: undefined, credentialCheck: undefined, config: undefined, machineQuota: undefined },
  codex: { ...codexAdapter, readOnly: undefined, listModels: undefined, credentialCheck: undefined, config: undefined, machineQuota: undefined, identityTalk: undefined },
});

test('要问的是哪几条命令：适配器声明什么就问什么，程序里带的执行器一个不少', () => {
  assert.deepEqual(TWO, [
    { executor: 'claude', command: 'claude', version: ['--version'], login: ['auth', 'status'], loginIdentity: claudeAdapter.loginIdentity, readOnly: { layer: 'contract' } },
    { executor: 'codex', command: 'codex', version: ['--version'], login: ['login', 'status'], readOnly: { layer: 'contract' } },
  ], '问的就是实录里那两条命令：版本是 <命令> --version，登录是 <命令> auth status / login status');
  // A question with no declaration is no question: an adapter that says nothing about its own
  // command is not guessed at.
  assert.deepEqual(questionsFrom({ quiet: { ...claudeAdapter, probe: undefined } }), []);
  assert.deepEqual(questionsFrom(ADAPTERS).map((each) => each.executor), ['claude', 'codex', 'dsh', 'gemini']);
});

test('实录：已登录的两份都按退出码答，版本读的是它自己那一行', async () => {
  const { run, asked } = answering(BOTH('logged-in'));
  const report = await probeExecutors({ questions: TWO, run, now: () => AT });
  assert.equal(report.at, '2026-11-06T10:00:00.000Z', '报告带着这台机器读到的时刻');
  assert.deepEqual(report.executors, [
    { executor: 'claude', installed: true, version: '2.1.303 (Claude Code)', logged_in: true, read_only: { available: true, layer: 'contract', checks_code: true }, identity: { organizationId: null, accountLabel: null } },
    { executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: true, read_only: { available: true, layer: 'contract', checks_code: true } },
  ]);
  // The two executors are asked side by side, so what is fixed is the set of questions, not
  // their order.
  assert.deepEqual([...asked].sort(), [
    'claude --version @6000', 'claude auth status @6000',
    'codex --version @6000', 'codex login status @6000',
  ].sort(), '只问这四条，没有第五条');
});

// The recording that shapes this reading: codex writes its login wording on stderr and
// answers on the exit code. A client that reads stdout for it would report nothing at all.
test('实录：codex 的原话在 stderr 上，结论仍然只看退出码', async () => {
  const { stdout, stderr, code } = recorded(CODEX, 'logged-in');
  assert.equal(stdout, '', '这一份的 stdout 是空的');
  assert.match(stderr, /Logged in using ChatGPT/);
  assert.equal(code, 0);
  const { run } = answering(BOTH('logged-in'));
  const [claude, codex] = (await probeExecutors({ questions: TWO, run })).executors;
  assert.equal(claude!.logged_in, true);
  assert.equal(codex!.logged_in, true);
  // And the words are not what decided it: the same words with a non-zero code are "not
  // signed in", which is what the CLI's own contract says they mean.
  const { run: changed } = answering({ ...BOTH('logged-in'), 'codex login status': { ...recorded(CODEX, 'logged-in'), code: 3 } });
  assert.equal((await probeExecutors({ questions: TWO, run: changed })).executors[1]!.logged_in, false);
});

test('实录：没有登录的两份都是退出码 1，不是从它打印的字里读出来的', async () => {
  assert.equal(recorded(CLAUDE, 'logged-out').code, 1);
  assert.equal(recorded(CODEX, 'logged-out').code, 1);
  const { run } = answering(BOTH('logged-out'));
  const report = await probeExecutors({ questions: TWO, run });
  assert.deepEqual(report.executors.map((each) => each.logged_in), [false, false]);
  // claude's own JSON says loggedIn: false, and none of it is read: the same bytes with an
  // exit code of 0 are "signed in".
  const { run: said } = answering({ ...BOTH('logged-out'), 'claude auth status': { ...recorded(CLAUDE, 'logged-out'), code: 0 } });
  const [claude] = (await probeExecutors({ questions: TWO, run: said })).executors;
  assert.equal(claude!.logged_in, true, '判定只看退出码');
  assert.equal(claude!.version, '2.1.303 (Claude Code)');
});

test('版本那一行：先看 stdout，stdout 没有说话才看 stderr', () => {
  const codex = recorded(CODEX, 'version');
  assert.equal(versionLine(codex.stdout, codex.stderr), 'codex-cli 0.162.0', 'stderr 上的 WARNING 不是版本');
  assert.equal(versionLine('', 'first\nsecond\n'), 'second', 'stdout 什么都没说时才用 stderr 的最后一行');
  assert.equal(versionLine('2.1.303 (Claude Code)\n', 'warning\n'), '2.1.303 (Claude Code)');
  assert.equal(versionLine('  \n', '\n'), null, '什么都没说就是没有版本');
  assert.equal(versionLine(`${'x'.repeat(500)}\n`, ''), 'x'.repeat(200), '长到不是一行版本的，切到页面放得下');
});

test('没装的执行器：命令跑不起来就是没装，别的执行器照答', async () => {
  const { run, asked } = answering({
    'claude --version': { stdout: '', stderr: '', code: null, failure: '这台机器上没有 claude（PATH 里没有这个命令）' },
    'codex --version': recorded(CODEX, 'version'),
    'codex login status': recorded(CODEX, 'logged-out'),
  });
  const report = await probeExecutors({ questions: TWO, run });
  assert.deepEqual(report.executors[0], {
    executor: 'claude', installed: false, version: null, logged_in: null,
    error: '这台机器上没有 claude（PATH 里没有这个命令）',
  });
  assert.equal(report.executors[1]!.installed, true, '一个没装不影响另一个');
  assert.equal(report.executors[1]!.logged_in, false);
  assert.deepEqual(asked.map((each) => each.split(' @')[0]), ['claude --version', 'codex --version', 'codex login status'], '没装的执行器不接着问登录');
});

test('版本命令跑起来却没读出版本：原话留在说明里，也不再问登录', async () => {
  const { run, asked } = answering({
    'claude --version': { stdout: '', stderr: 'unknown option --version\n', code: 1 },
    'codex --version': recorded(CODEX, 'version'),
    'codex login status': recorded(CODEX, 'logged-in'),
  });
  const [claude] = (await probeExecutors({ questions: TWO, run })).executors;
  assert.deepEqual(claude, {
    executor: 'claude', installed: true, version: null, logged_in: null,
    error: 'claude --version 没有读出版本：unknown option --version',
  });
  assert.equal(asked.includes('claude auth status @6000'), false, '读不出执行器就不问它登录');
});

test('没有声明登录命令的执行器：版本照报，登录这一项什么都不说', async () => {
  const questions: ExecutorQuestion[] = [{ executor: 'dsh', command: 'dsh', version: ['--version'] }];
  const { run, asked } = answering({ 'dsh --version': { stdout: 'dsh 0.2.2\n', stderr: '', code: 0 } });
  const report = await probeExecutors({ questions, run });
  assert.deepEqual(report.executors, [{ executor: 'dsh', installed: true, version: 'dsh 0.2.2', logged_in: null }]);
  assert.deepEqual(asked, ['dsh --version @6000'], '没有这条路就不去猜');
});

test('登录命令跑不起来：版本还在，登录如实说说不清', async () => {
  const { run } = answering({
    'claude --version': recorded(CLAUDE, 'version'),
    'claude auth status': { stdout: '', stderr: '', code: null, failure: 'claude auth status 超过 6000 毫秒没有回答' },
  });
  const [claude] = (await probeExecutors({ questions: TWO.slice(0, 1), run })).executors;
  assert.deepEqual(claude, {
    executor: 'claude', installed: true, version: '2.1.303 (Claude Code)', logged_in: null,
    read_only: { available: true, layer: 'contract', checks_code: true },
    error: 'claude auth status 超过 6000 毫秒没有回答',
  });
});

test('跑命令这件事本身出错，也只是这一个执行器没有答案', async () => {
  const run = async (argv: string[]): Promise<CommandAnswer> => {
    if (argv[0] === 'claude') throw new Error('管道关掉了');
    return argv[1] === '--version' ? recorded(CODEX, 'version') : recorded(CODEX, 'logged-in');
  };
  const report = await probeExecutors({ questions: TWO, run });
  assert.equal(report.executors[0]!.installed, false);
  assert.match(String(report.executors[0]!.error), /claude.*管道关掉了/);
  assert.equal(report.executors[1]!.logged_in, true);
});

test('问的时限：每条命令都带上自己的时限，一次可以改', async () => {
  const { run, asked } = answering(BOTH('logged-in'));
  await probeExecutors({ questions: TWO, run });
  assert.ok(asked.every((each) => each.endsWith(`@${PROBE_TIMEOUT_MS}`)));
  const short = answering(BOTH('logged-in'));
  await probeExecutors({ questions: TWO, run: short.run, timeoutMs: 250 });
  assert.ok(short.asked.every((each) => each.endsWith('@250')));
});

// The probe finds its command the way the watch process finds a Worker's (node/launch.ts), in
// the environment it is given — the machine's lookup environment — with no shell in between
// on any system: what was found is what is started (tests/locate.test.ts runs both).
test('探针和 Worker 同一种找法：找不到就当场说查过哪里，不起任何 shell', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    assert.throws(() => shellInvocation(['tycho_probe_definitely_absent_917a6e'], platform, { PATH: platform === 'win32' ? '' : '/nowhere' }), /^Error: 找不到 tycho_probe_definitely_absent_917a6e：查过 PATH$/, platform);
  }
});

// What the lookup gives for a `.cmd` wrapper, fixed so that these tests do not depend on what
// this machine has installed.
const WRAPPED = { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/e:on', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" --version"'], verbatim: true };

// The shell itself starts even when its target is missing, and a timeout is not complete
// until the process table proves its descendants are gone (including an exited wrapper).
function hangingProbe() {
  const child = Object.assign(new EventEmitter(), {
    pid: 400, stdout: new PassThrough(), stderr: new PassThrough(), unref() {},
  }) as unknown as ChildProcess;
  const living = new Set([401]);
  let inspected = 0;
  let release!: () => void;
  let began!: () => void;
  const ending = new Promise<void>((resolve) => { began = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const ended: number[] = [];
  const processes: HostProcesses = {
    alive: (pid) => living.has(pid), startOf: async () => 'same',
    async descendants() { inspected++; return [400, ...living]; },
    async tagged() { return []; },
    async endTree(pid) { ended.push(pid); began(); await hold; living.delete(pid); },
    async endGroup() {},
  };
  return { child, processes, living, ended, ending, release, inspections: () => inspected };
}

test('Windows 探针超时：包装进程已退出也先等待遗留子进程结束，再报告超时', async () => {
  const fake = hangingProbe();
  let returned = false;
  const answer = shellRun(['claude', '--version'], 1, 'win32', {
    spawn: (() => fake.child) as typeof import('node:child_process').spawn, processes: fake.processes, launch: WRAPPED,
  }).then((result) => { returned = true; return result; });
  await fake.ending;
  fake.child.emit('close', 0);
  assert.equal(returned, false, 'taskkill 尚未结束，不能先交回探针结果');
  fake.release();
  const result = await answer;
  assert.match(result.failure!, /超过 1 毫秒/);
  assert.doesNotMatch(result.failure!, /无法确认|未能确认/);
  assert.ok(fake.ended.includes(401), '根进程已退出，仍然清掉留着管道的子进程');
  assert.ok(fake.inspections() >= 2, '清理以后重新读现场');
});

test('Windows 探针超时：查不了进程树时，如实报告没有确认清理完成', async () => {
  const fake = hangingProbe();
  fake.processes.descendants = async () => undefined;
  fake.release();
  const result = await shellRun(['claude', '--version'], 1, 'win32', {
    spawn: (() => fake.child) as typeof import('node:child_process').spawn, processes: fake.processes, launch: WRAPPED,
  });
  assert.match(result.failure!, /无法确认.*进程树.*结束/);
});

test('Windows 探针超时：结束命令返回了但子进程仍活着，不把清理记成完成', async () => {
  const fake = hangingProbe();
  fake.processes.endTree = async () => {};
  const result = await shellRun(['claude', '--version'], 1, 'win32', {
    spawn: (() => fake.child) as typeof import('node:child_process').spawn, processes: fake.processes, launch: WRAPPED,
  });
  assert.match(result.failure!, /无法确认.*进程树.*结束/);
});

test('真的找不到执行器：报告没安装，说清查过哪里', async () => {
  const report = await probeExecutors({ questions: [{ executor: 'missing', command: 'tycho_probe_definitely_absent_917a6e', version: ['--version'] }] });
  assert.equal(report.executors[0]!.installed, false);
  assert.match(report.executors[0]!.error!, /^找不到 tycho_probe_definitely_absent_917a6e：查过 PATH/);
});

test('执行器自身返回 shell 常见错误码：没有查找失败标记仍然报告已安装', async () => {
  for (const code of [127, 9009]) {
    const { run } = answering({ 'claude --version': { stdout: '', stderr: 'executor failed', code } });
    const [executor] = (await probeExecutors({ questions: TWO.slice(0, 1), run })).executors;
    assert.equal(executor!.installed, true);
  }
});


test('Windows 探针超时：清理前清点失败、清理后为空，仍无法证明遗留进程已经结束', async () => {
  const fake = hangingProbe();
  let reads = 0;
  fake.processes.descendants = async () => ++reads === 1 ? undefined : [];
  fake.release();
  const result = await shellRun(['claude', '--version'], 1, 'win32', {
    spawn: (() => fake.child) as typeof import('node:child_process').spawn, processes: fake.processes, launch: WRAPPED,
  });
  assert.equal(reads, 2);
  assert.match(result.failure!, /无法确认.*进程树.*结束/);
});

test('Windows 启动：经 cmd 的命令行原样交出去，不让 C runtime 再改写引号', async () => {
  const fake = hangingProbe();
  const result = await shellRun(['claude', '--version'], 1000, 'win32', {
    launch: WRAPPED,
    spawn: ((command: string, args: string[], options: import('node:child_process').SpawnOptions) => {
      assert.equal(command, WRAPPED.command);
      assert.deepEqual(args, WRAPPED.args);
      assert.equal(options!.windowsVerbatimArguments, true);
      queueMicrotask(() => fake.child.emit('close', 0));
      return fake.child;
    }) as typeof import('node:child_process').spawn,
  });
  assert.equal(result.code, 0);
});

test('Windows 真实启动：找到已安装程序并执行', { skip: process.platform !== 'win32' }, async () => {
  const result = await shellRun(['where.exe', 'where.exe'], 6000);
  assert.equal(result.code, 0, result.failure ?? result.stderr);
  assert.match(result.stdout, /where\.exe/i);
});
