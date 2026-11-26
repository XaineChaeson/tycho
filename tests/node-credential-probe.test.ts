// Guards the question a machine asks about its own executor: would it take the token tycho
// hands an account's round (docs/design/native-login.md), and what the host does with the
// answer. Recorded on 2.1.303, Windows (tests/fixtures/claude/2.1.303-win/auth-status): a token
// on a file descriptor is not read at all, and one in the variable is the login the CLI uses.
//
// What this file is here to catch:
//   - the question asked with a real token instead of a placeholder, or with the machine's
//     lookup environment changed beyond that one variable;
//   - an answer of "not taken" read as taken because its exit code was non-zero (the CLI exits
//     1 when it is signed in to nothing and says which login it used);
//   - the question asked of an executor that declares none, or of one that is not installed or
//     is too old for this program's commands;
//   - a machine's report of the answer dropped, or its shape not checked;
//   - an account's work sent to a machine that said the token would not be used, or held
//     while a machine has yet to say, or a machine's own login (which is handed no token)
//     held by this question at all.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { CommandAnswer } from '../node/executors.ts';
import { probeExecutors, questionsFrom } from '../node/executors.ts';
import type { Account, Login, Machine } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { createAccounts } from '../service/accounts.ts';
import { InputError } from '../service/errors.ts';
import { createNodes } from '../service/nodes.ts';
import { accountHere, fitsHere } from '../service/readonly.ts';
import type { NodeExecutorStatus } from '../shared/node-protocol.ts';
import type { RunRow } from '../service/ledger.ts';
import { content, DISPATCH_TUNED, fixture, machineLogin, memoryLogins, memoryMachines, NODES_TUNED, testMachine, tuned, USER } from './helpers.ts';

const ok = (stdout: string): CommandAnswer => ({ stdout, stderr: '', code: 0 });
const OAUTH = '{"loggedIn":true,"authMethod":"oauth_token"}\n';
const MACHINE_LOGIN = '{"loggedIn":true,"authMethod":"claude.ai"}\n';
const NONE = '{"loggedIn":false,"authMethod":"none"}\n';
// What the Claude adapter answers with when the CLI says it uses the machine's own login.
const NOT_ADOPTED_TEXT = 'claude auth status 说它会用 claude.ai，不是交过去的令牌';

// What this machine's client would run, and with what: the adapter's own command names.
function answering(table: Record<string, CommandAnswer>) {
  const asked: { argv: string[]; env?: Record<string, string> }[] = [];
  const run = async (argv: string[], _timeoutMs: number, env?: Record<string, string>): Promise<CommandAnswer> => {
    asked.push({ argv, ...(env === undefined ? {} : { env }) });
    return table[argv.join(' ')] ?? { stdout: '', stderr: '', code: null, failure: `这个测试不该运行 ${argv.join(' ')}` };
  };
  return { run, asked };
}

// Synthetic adapter declaring a credentialCheck probe to guard probeExecutors' placeholder/env
// hygiene, while claudeAdapter itself no longer declares credentialCheck under Occam's Razor.
const CLAUDE_WITH_CHECK = {
  ...claudeAdapter,
  credentialCheck: {
    argv: ['claude', 'auth', 'status'],
    check(stdout: string): string | undefined {
      try {
        const parsed = JSON.parse(stdout) as { authMethod?: unknown };
        if (parsed.authMethod === 'oauth_token') return undefined;
        return `claude auth status 说它会用 ${String(parsed.authMethod ?? 'unknown')}，不是交过去的令牌`;
      } catch {
        return 'claude auth status 回答读不出来';
      }
    },
  },
};
const CLAUDE_ONLY = questionsFrom({ claude: CLAUDE_WITH_CHECK });
const TOKEN_QUESTION = { 'claude --version': ok('2.1.303 (Claude Code)\n') };

test('机器拿一个占位值去问，而且只加这一个变量；问的是哪份登录，不是这份有没有效', async () => {
  assert.equal(claudeAdapter.credentialCheck, undefined, '内置 claudeAdapter 不再声明阻塞性的 credentialCheck');
  const { run, asked } = answering({ ...TOKEN_QUESTION, 'claude auth status': ok(OAUTH) });
  const [claude] = (await probeExecutors({ questions: CLAUDE_ONLY, run })).executors;
  assert.deepEqual(claude!.credential, { adopted: true });
  const probe = asked.filter(({ argv }) => argv.join(' ') === 'claude auth status').findLast(({ env }) => env !== undefined)!;
  assert.deepEqual(Object.keys(probe.env!), ['CLAUDE_CODE_OAUTH_TOKEN'], '只加声明的那个变量');
  assert.match(probe.env!.CLAUDE_CODE_OAUTH_TOKEN!, /^tycho-/, '占位值不是真令牌');
  assert.notEqual(probe.env!.CLAUDE_CODE_OAUTH_TOKEN, '');
});

test('说会用机器自己的登录、或什么都没登录：仅作参考（adopted: true），同时原话带上它用的是哪份', async () => {
  for (const [answer, said] of [[ok(MACHINE_LOGIN), /claude\.ai/], [{ stdout: NONE, stderr: '', code: 1 }, /none/]] as const) {
    const { run } = answering({ ...TOKEN_QUESTION, 'claude auth status': answer });
    const [claude] = (await probeExecutors({ questions: CLAUDE_ONLY, run })).executors;
    assert.equal(claude!.credential?.adopted, true, JSON.stringify(answer));
    assert.match(claude!.credential?.error ?? '', said);
  }
});

test('读不出回答、命令起不来：仅作参考（adopted: true），原话带上原因；退出码不是 0 仍然交给适配器判', async () => {
  const unreadable = answering({ ...TOKEN_QUESTION, 'claude auth status': ok('not json') });
  assert.match((await probeExecutors({ questions: CLAUDE_ONLY, run: unreadable.run })).executors[0]!.credential?.error ?? '', /读不出来/);
  const gone = answering({ ...TOKEN_QUESTION, 'claude auth status': { stdout: '', stderr: '', code: null, failure: 'claude auth status 超过 6000 毫秒没有回答' } });
  assert.deepEqual((await probeExecutors({ questions: CLAUDE_ONLY, run: gone.run })).executors[0]!.credential, { adopted: true, error: 'claude auth status 超过 6000 毫秒没有回答' });
  // A non-zero exit is still an answer, and the answer is what decides the advisory warning.
  const refused = answering({ ...TOKEN_QUESTION, 'claude auth status': { stdout: NONE, stderr: '', code: 1 } });
  assert.equal((await probeExecutors({ questions: CLAUDE_ONLY, run: refused.run })).executors[0]!.credential?.adopted, true);
  assert.match((await probeExecutors({ questions: CLAUDE_ONLY, run: refused.run })).executors[0]!.credential?.error ?? '', /none/);
});

test('没声明问法、没装：不问，报告里没有这一项；minVersion 仅作参考不阻断探针', async () => {
  const both = questionsFrom({ claude: claudeAdapter, codex: codexAdapter });
  assert.equal(both.find((each) => each.executor === 'claude')!.credential, undefined);
  assert.equal(both.find((each) => each.executor === 'codex')!.credential, undefined);
  const { run } = answering({ ...TOKEN_QUESTION, 'claude auth status': ok(OAUTH) });
  const report = await probeExecutors({ questions: both, run });
  assert.equal(report.executors.find((each) => each.executor === 'codex')!.credential, undefined);
  // Not installed: nothing else is asked, the token question included.
  const missing = answering({ 'claude --version': { stdout: '', stderr: '', code: null, failure: '这台机器上没有 claude' } });
  const [notThere] = (await probeExecutors({ questions: CLAUDE_ONLY, run: missing.run })).executors;
  assert.equal(notThere!.credential, undefined);
  assert.equal(missing.asked.some(({ argv }) => argv[1] === 'auth'), false);
});

// -- on the host: the field kept, and what it decides ----------------------------------------

const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'm1', platform: 'linux', hostname: 'm1' };
function hub(t: TestContext) {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 300, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;
  return { nodes, machine };
}

test('主机收下这一项并原样留着；形状不对就整份拒收', async (t) => {
  const { nodes, machine } = hub(t);
  const report = {
    at: '2026-11-11T10:00:00.000Z',
    executors: [
      { executor: 'claude', installed: true, version: '2.1.303', logged_in: true, credential: { adopted: false, error: NOT_ADOPTED_TEXT } },
      { executor: 'codex', installed: true, version: 'codex-cli 0.162.0', logged_in: true, credential: { adopted: true } },
    ],
  };
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: report });
  assert.deepEqual(nodes.reportedExecutors(machine.id), report);
  const bad = [
    { executor: 'claude', installed: true, logged_in: true, credential: { adopted: 'yes' } },
    { executor: 'claude', installed: true, logged_in: true, credential: 'adopted' },
    { executor: 'claude', installed: true, logged_in: true, credential: { adopted: false, error: 3 } },
  ];
  for (const each of bad) {
    await assert.rejects(async () => nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: report.at, executors: [each] } }), InputError, JSON.stringify(each));
  }
  assert.deepEqual(nodes.reportedExecutors(machine.id), report, '拒收的一份不替掉前一份');
});

const status = (credential?: NonNullable<NodeExecutorStatus['credential']>): NodeExecutorStatus =>
  ({ executor: 'claude', installed: true, version: '2.1.303', logged_in: true, ...(credential === undefined ? {} : { credential }) });

test('判定：credentialCheck 仅作参考，只有没装才阻断派发', () => {
  assert.deepEqual(accountHere(status(), undefined), { ok: true });
  assert.deepEqual(accountHere(null, CLAUDE_WITH_CHECK), { ok: true });
  assert.deepEqual(accountHere(status(), CLAUDE_WITH_CHECK), { ok: true });
  assert.deepEqual(accountHere(status({ adopted: false, error: NOT_ADOPTED_TEXT }), CLAUDE_WITH_CHECK), {
    ok: true, advisory: `账号的令牌在这台机器上可能不会被采用：${NOT_ADOPTED_TEXT}`,
  });
  assert.deepEqual(accountHere(status({ adopted: true }), CLAUDE_WITH_CHECK), { ok: true });
  assert.deepEqual(accountHere({ ...status(), installed: false }, CLAUDE_WITH_CHECK), { ok: false, why: '没装', settled: true });
  assert.equal(fitsHere(status({ adopted: true }), { readOnly: false, account: true }, CLAUDE_WITH_CHECK), true);
  assert.equal(fitsHere(status({ adopted: false }), { readOnly: false, account: true }, CLAUDE_WITH_CHECK), true);
  assert.equal(fitsHere({ ...status(), installed: false }, { readOnly: false, account: true }, CLAUDE_WITH_CHECK), false);
  assert.equal(fitsHere(status(), { readOnly: false }, CLAUDE_WITH_CHECK), true);
});

// One account's Task, two machines: what their clients said decides where it goes.
const ACCOUNT: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: content('{"model":"m"}') } };
const OWN = machineLogin('m1', 'claude', { tiers: { execute: content('{"model":"m"}') } });
const MACHINES: Record<string, Machine> = { m1: testMachine('m1'), m2: testMachine('m2') };
type Reports = Record<string, NodeExecutorStatus | null>;

function setUp(t: TestContext, login: Login, reports: Reports) {
  const f = fixture(t);
  const machines = memoryMachines(MACHINES, f.ledger);
  const store = memoryLogins({ [login.id]: login }, f.ledger);
  f.ledger.setProjectLogins(f.projectId, [login.id], USER);
  const launched: RunRow[] = [];
  const dispatcher = createDispatcher({ ...DISPATCH_TUNED,
    runTimeoutMs: tuned('run.timeoutMs'),
    ledger: f.ledger,
    runner: {
      findMachine: async (_login, offered) => offered[0],
      lostCandidates: () => [],
      presume: async () => 'unknown',
      sweep: async () => {},
      launch: async (run) => { launched.push(run); },
      watch: async () => {},
    },
    logins: store, machines, executors: ADAPTERS,
    reported: (machineId) => reports[machineId] ?? null,
    log: () => {},
  });
  t.after(() => dispatcher.stop());
  const id = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '做', goal: '做', acceptance: '过' }, USER).id;
  f.ledger.queueTask(id, USER);
  return { f, dispatcher, launched, id, login };
}

const NOT_ADOPTED = (error: string): NonNullable<NodeExecutorStatus['credential']> => ({ adopted: false, error });

test('credential.adopted=false 仅作参考，不阻断已安装机器派发；只有所有机器都没装才停下', async (t) => {
  const advisory = setUp(t, ACCOUNT, {
    m1: status(NOT_ADOPTED(NOT_ADOPTED_TEXT)),
    m2: status(NOT_ADOPTED('claude auth status 说它会用 none，不是交过去的令牌')),
  });
  await advisory.dispatcher.tick();
  assert.equal(advisory.launched.length, 1, '已安装时照常派发，不因 credential 探针挂起');

  const uninstalled = setUp(t, ACCOUNT, {
    m1: { executor: 'claude', installed: false, version: null, logged_in: null },
    m2: { executor: 'claude', installed: false, version: null, logged_in: null },
  });
  await uninstalled.dispatcher.tick();
  assert.deepEqual(uninstalled.launched, []);
  assert.equal(uninstalled.f.task(uninstalled.id).state, 'queued');
});

test('还有机器没报告，或旧客户端没报 credential 项：均不阻断派发', async (t) => {
  const partial = setUp(t, ACCOUNT, { m1: status(NOT_ADOPTED('不会用')) });
  await partial.dispatcher.tick();
  assert.equal(partial.launched.length, 1);

  const legacy = setUp(t, ACCOUNT, { m1: status(), m2: status() });
  await legacy.dispatcher.tick();
  assert.equal(legacy.launched.length, 1);
  assert.equal(legacy.launched[0]?.machine_id, 'm1');
});

test('机器自己的登录不交令牌：这一项说不采用也不影响它', async (t) => {
  const s = setUp(t, OWN, { m1: status(NOT_ADOPTED('不会用')) });
  await s.dispatcher.tick();
  assert.equal(s.launched[0]?.machine_id, 'm1');
  assert.equal(s.launched[0]?.login_id, OWN.id);
});

// The console reads a machine's report through the accounts view; the token answer has to
// survive that read, or the machine page would say nothing about it.
test('账号页读到的报告里带着这一项', (t) => {
  const f = fixture(t);
  const accounts = createAccounts({ ledger: f.ledger, executors: ADAPTERS, credentialExecutors: [], dataDir: f.dir, log: () => {} });
  assert.deepEqual(accounts.judgeReport(status(NOT_ADOPTED('不会用'))).credential, NOT_ADOPTED('不会用'));
});
