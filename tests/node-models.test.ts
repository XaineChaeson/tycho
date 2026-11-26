// Guards the models a machine reports for its own executors (docs/design/nodes.md §1.2): the
// list the owner picks from when filling in the two tiers of a machine's own login.
//
// What this file is here to catch:
//   - the list not asked on the machine at all, so the form has nothing to offer (the service
//     cannot run an executor's command, and used to say so and stop);
//   - a question that is not the adapter's own declared command, or one asked of an executor
//     whose list is the service's to ask (over HTTP, with an account's token);
//   - anything of the command's output but the parsed list leaving the machine — a
//     configuration dump may hold secrets — in the list or in the reason nothing was read;
//   - the models question changing what the report says of the install, the login or the
//     read-only way;
//   - the host keeping a list that is not the shape the protocol defines, or dropping a good one;
//   - the machines page showing the ledger's old list, or nothing and no reason, for a
//     machine's own login — set up or not;
//   - the service still asking (and logging) for a machine's own login by itself.
import './guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ADAPTERS } from '../adapters/all.ts';
import { codexAdapter } from '../adapters/codex.ts';
import type { ModelInfo } from '../adapters/types.ts';
import type { CommandAnswer } from '../node/executors.ts';
import { executorCheckTimeoutMs, MODEL_LIST_TIMEOUT_MS, PROBE_TIMEOUT_MS, probeExecutors, questionsFrom } from '../node/executors.ts';
import { CHECK_TIMEOUT_MS } from '../runner/runner.ts';
import { InputError } from '../service/errors.ts';
import type { HttpOptions } from '../service/http.ts';
import { createNodes } from '../service/nodes.ts';
import { modelText } from '../shared/labels.ts';
import type { NodeExecutorReport, NodeExecutorStatus } from '../shared/node-protocol.ts';
import { consoleApp } from './console-helpers.ts';
import { content, fixture, NODES_TUNED, USER } from './helpers.ts';
import { stage } from './stage.ts';

const ok = (stdout: string): CommandAnswer => ({ stdout, stderr: '', code: 0 });
const CODEX_CATALOG = readFileSync(join(import.meta.dirname, 'fixtures', 'codex', '0.162.0', 'models.json'), 'utf8');
const CLAUDE_HELP = readFileSync(join(import.meta.dirname, 'fixtures', 'claude', 'models', 'help.txt'), 'utf8');
// What stands in for a secret a command's output may hold beside its models.
const SECRET = 'sk-not-to-leave-this-machine';
const DSH_DUMP = `gateway:\n  config:\n    api_key: ${SECRET}\n    models: [<模型甲>, <模型乙>]\n`;

test('connection wait covers the model and other probe deadlines', () => {
  assert.ok(CHECK_TIMEOUT_MS > MODEL_LIST_TIMEOUT_MS + PROBE_TIMEOUT_MS);
  assert.ok(executorCheckTimeoutMs(45_000) > 45_000 + PROBE_TIMEOUT_MS);
});

function answering(table: Record<string, CommandAnswer>) {
  const asked: string[] = [];
  const run = async (argv: string[], timeoutMs: number): Promise<CommandAnswer> => {
    asked.push(`${argv.join(' ')} @${timeoutMs}`);
    return table[argv.join(' ')] ?? { stdout: '', stderr: '', code: null, failure: `这个测试不该运行 ${argv.join(' ')}` };
  };
  return { run, asked, commands: () => asked.map((each) => each.split(' @')[0]!) };
}

// Every executor fine. `claude --help` answers two questions: its read-only probe checks the
// switches the help lists, and without a token the help is where its models are written.
const ALL_FINE: Record<string, CommandAnswer> = {
  'claude --version': ok('2.1.312 (Claude Code)\n'),
  'claude auth status': ok('{"loggedIn":true,"authMethod":"oauth_token"}\n'),
  'claude --help': ok(`${CLAUDE_HELP}\n  --strict-mcp-config   Only use MCP servers from --mcp-config\n  --tools <tools...>   Specify the list of available tools\n`),
  'codex --version': ok('codex-cli 0.163.0\n'),
  'codex login status': ok(''),
  'codex sandbox -c sandbox_mode=read-only -- codex --version': ok('codex-cli 0.163.0\n'),
  'codex debug models': ok(CODEX_CATALOG),
  'dsh --version': ok('0.2.2-rc.1\n'),
  'dsh --profile headless --dump-config': ok(DSH_DUMP),
  'agy --version': ok('1.5.9\n'),
  'agy models': ok('gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\ngemini-4-carbon-high\tGemini 4 Carbon (High)\n'),
};

const questions = questionsFrom(ADAPTERS);
const of = (report: NodeExecutorReport, executor: string): NodeExecutorStatus => report.executors.find((each) => each.executor === executor)!;
const ids = (models: readonly ModelInfo[]): string[] => models.map((model) => model.id);

// -- on the machine: what is asked, and what is kept of the answer ---------------------------

test('问的是适配器声明的那条命令；声明成 HTTP 查询的、没有声明的都不在机器上问', async () => {
  assert.deepEqual(questions.map(({ executor, models }) => [executor, models?.argv]), [
    ['claude', ['claude', '--help']],
    ['codex', ['codex', 'debug', 'models']],
    ['dsh', ['dsh', '--profile', 'headless', '--dump-config']],
    ['gemini', ['agy', 'models']],
  ]);
  const elsewhere = questionsFrom({
    http: { ...codexAdapter, readOnly: undefined, config: undefined, listModels: () => ({ kind: 'http' as const, url: 'https://stand-in/models', headers: {}, parse: () => [{ id: 'm' }] }) },
    silent: { ...codexAdapter, readOnly: undefined, config: undefined, listModels: undefined },
  });
  assert.deepEqual(elsewhere.map(({ models }) => models), [undefined, undefined]);
  const { run, commands } = answering({ 'codex --version': ok('codex-cli 0.163.0\n'), 'codex login status': ok('') });
  const report = await probeExecutors({ questions: elsewhere, run });
  assert.deepEqual(report.executors.map((each) => 'models' in each), [false, false], '没问就什么都不报');
  assert.deepEqual([...new Set(commands())].sort(), ['codex --version', 'codex login status'], '没有第三条命令');
});

test('机器按适配器的声明把列表读出来随报告上报；模型那一问用自己的时限，其余探针不变', async () => {
  const { run, asked } = answering(ALL_FINE);
  const report = await probeExecutors({ questions, run });
  assert.deepEqual(of(report, 'codex').models, { list: codexAdapter.listModels!({}).parse(CODEX_CATALOG) });
  assert.equal(of(report, 'codex').models!.list.length, 10);
  assert.deepEqual(ids(of(report, 'dsh').models!.list), ['<模型甲>', '<模型乙>']);
  assert.deepEqual(ids(of(report, 'claude').models!.list), ['<别名甲>', '<别名乙>', '<别名丙>'], '没有令牌的 claude 报帮助里写的别名');
  // The models question gets the host's own span (or this client's 30 seconds when the host
  // said none): a fresh sign-in may make it reach the vendor.
  assert.ok(asked.includes(`codex debug models @${MODEL_LIST_TIMEOUT_MS}`) && asked.includes(`dsh --profile headless --dump-config @${MODEL_LIST_TIMEOUT_MS}`) && asked.includes(`agy models @${MODEL_LIST_TIMEOUT_MS}`));
  assert.ok(asked.includes(`claude --help @${MODEL_LIST_TIMEOUT_MS}`), 'claude 的模型那一问也一样');
  // Everything else is still the 6 seconds it always was.
  for (const argv of ['claude --version', 'claude auth status', 'codex --version', 'codex login status', 'dsh --version', 'agy --version']) {
    assert.ok(asked.includes(`${argv} @${PROBE_TIMEOUT_MS}`), `${argv} 仍是 6 秒`);
  }
  // The dump held a key beside its models: the report carries the models and not the dump.
  assert.equal(JSON.stringify(report).includes(SECRET), false, '命令的原文不出这台机器');
});

test('主机下发的模型时限优先于本机默认：模型那一问用它，版本、登录、只读仍是 6 秒', async () => {
  const { run, asked } = answering(ALL_FINE);
  await probeExecutors({ questions, run, modelsTimeoutMs: 45_000 });
  assert.ok(asked.includes('codex debug models @45000') && asked.includes('dsh --profile headless --dump-config @45000'), '模型那一问用下发的 45 秒');
  assert.ok(asked.includes('claude --help @45000'));
  for (const argv of ['claude --version', 'claude auth status', 'codex --version', 'codex login status', 'dsh --version', 'agy --version']) {
    assert.ok(asked.includes(`${argv} @${PROBE_TIMEOUT_MS}`), `${argv} 仍是 6 秒`);
  }
});

test('没读到就说原因：跑不了、退出码、一个模型都没有；登录和只读的结论不动，原因里没有命令的输出', async () => {
  const fine = of(await probeExecutors({ questions, run: answering(ALL_FINE).run }), 'codex');
  const cases: [string, CommandAnswer, string][] = [
    ['没有回答', { stdout: '', stderr: '', code: null, failure: 'codex debug models 超过 6000 毫秒没有回答' }, 'codex debug models 超过 6000 毫秒没有回答'],
    ['没有退出码', { stdout: SECRET, stderr: SECRET, code: null }, '运行不了 codex debug models'],
    ['退出码不是 0', { stdout: `{"token":"${SECRET}"}`, stderr: `error: ${SECRET}\n`, code: 2 }, 'codex debug models 退出码 2'],
    ['读不出模型', ok(`not a catalog ${SECRET}`), 'codex debug models 没有列出任何模型'],
    ['一张空表', ok('{"models":[]}'), 'codex debug models 没有列出任何模型'],
  ];
  for (const [what, answer, error] of cases) {
    const { run } = answering({ ...ALL_FINE, 'codex debug models': answer });
    const report = await probeExecutors({ questions, run });
    const codex = of(report, 'codex');
    assert.deepEqual(codex.models, { list: [], error }, what);
    const { models: _asked, ...rest } = codex;
    const { models: _fine, ...before } = fine;
    assert.deepEqual(rest, before, `${what}：装没装、登没登录、只读能不能用都和没问模型时一样`);
    assert.equal(JSON.stringify(report).includes(SECRET), false, `${what}：原因里没有命令的输出`);
    assert.ok(of(report, 'dsh').models!.list.length > 0, `${what}：别的执行器照报`);
  }
  // Running the command at all going wrong is that one answer's, as for the other questions.
  const { run } = answering(ALL_FINE);
  const thrown = of(await probeExecutors({ questions, run: async (argv, ms) => {
    if (argv.join(' ') === 'codex debug models') throw new Error('管道关掉了');
    return run(argv, ms);
  } }), 'codex');
  assert.deepEqual(thrown.models, { list: [], error: '运行不了 codex：管道关掉了' });
  assert.equal(thrown.logged_in, true);
});

test('没装的执行器不问模型；旧版 dsh 不再被判成用不了，照常问模型', async () => {
  const { run, commands } = answering({
    ...ALL_FINE,
    'codex --version': { stdout: '', stderr: '', code: null, failure: '这台机器上没有 codex（PATH 里没有这个命令）' },
    'dsh --version': ok('0.2.1-rc.5\n'),
  });
  const report = await probeExecutors({ questions, run });
  assert.equal('models' in of(report, 'codex'), false);
  assert.equal(of(report, 'dsh').unusable, undefined);
  assert.equal('models' in of(report, 'dsh'), true);
  assert.ok(!commands().includes('codex debug models') && commands().includes('dsh --profile headless --dump-config'));
});

// -- on the host: what is kept of a report -------------------------------------------------------

const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'm1', platform: 'linux', hostname: 'm1' };
const AT = '2026-11-11T10:00:00.000Z';
const LIST: ModelInfo[] = [
  { id: 'gpt-x', name: 'GPT X', efforts: ['low', 'high'], defaultEffort: 'low' },
  { id: 'gpt-hidden', hidden: true },
  { id: 'plain' },
];

function hub(t: TestContext) {
  const f = fixture(t);
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 300, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const machine = nodes.approve(nodes.register(FACTS).code, USER)!;
  return { nodes, machine };
}

test('主机收下模型那一段，原样留给页面；形状不对就整份拒收，不替掉前一份', async (t) => {
  const { nodes, machine } = hub(t);
  const report: NodeExecutorReport = {
    at: AT,
    executors: [
      { executor: 'codex', installed: true, version: 'codex-cli 0.163.0', logged_in: true, models: { list: LIST } },
      { executor: 'dsh', installed: true, version: '0.2.2', logged_in: null, models: { list: [], error: 'dsh --profile headless --dump-config 没有列出任何模型' } },
      { executor: 'claude', installed: true, version: '2.1.312', logged_in: true },
    ],
  };
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: report });
  assert.deepEqual(nodes.reportedExecutors(machine.id), report);
  // Only the fields the protocol names are kept: what else an entry carries is not shown.
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: AT, executors: [{ executor: 'codex', installed: true, version: null, logged_in: true, models: { list: [{ id: 'm', api_key: 'x' }], raw: 'x' } }] } as never });
  assert.deepEqual(nodes.reportedExecutors(machine.id)!.executors[0]!.models, { list: [{ id: 'm' }] });
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: report });

  const many = (count: number, each: (index: number) => unknown): unknown[] => Array.from({ length: count }, (_, index) => each(index));
  const bad: unknown[] = [
    'gpt-x',
    [],
    {},
    { list: 'gpt-x' },
    { list: many(201, (index) => ({ id: `m${index}` })) },
    { list: ['gpt-x'] },
    { list: [null] },
    { list: [{}] },
    { list: [{ id: '' }] },
    { list: [{ id: '   ' }] },
    { list: [{ id: 7 }] },
    { list: [{ id: 'a\nb' }] },
    { list: [{ id: 'm', name: 7 }] },
    { list: [{ id: 'm', name: 'a\nb' }] },
    { list: [{ id: 'm', efforts: 'high' }] },
    { list: [{ id: 'm', efforts: [7] }] },
    { list: [{ id: 'm', efforts: ['a\nb'] }] },
    { list: [{ id: 'm', efforts: many(21, (index) => `e${index}`) }] },
    { list: [{ id: 'm', defaultEffort: 7 }] },
    { list: [{ id: 'm', hidden: 'yes' }] },
    { list: [], error: 7 },
    { list: [], error: 'a\nb' },
  ];
  for (const models of bad) {
    const executors = { at: AT, executors: [{ executor: 'codex', installed: true, logged_in: true, models }] };
    await assert.rejects(async () => nodes.poll(machine.id, { runs: [], facts: FACTS, executors: executors as never }), InputError, JSON.stringify(models).slice(0, 80));
  }
  assert.deepEqual(nodes.reportedExecutors(machine.id), report, '拒收的一份不替掉前一份');
  // The limits themselves are within the shape.
  const full = { list: many(200, (index) => ({ id: `m${index}`, efforts: many(20, (effort) => `e${effort}`) })) };
  await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: { at: AT, executors: [{ executor: 'codex', installed: true, version: null, logged_in: true, models: full }] } as never });
  assert.deepEqual(nodes.reportedExecutors(machine.id)!.executors[0]!.models, full);
});

// A report goes with every poll, and the host refuses a whole report over one model out of
// shape: a list the host would refuse must never leave the machine, or one odd catalog would
// cut the machine off.
test('不合报告形状的列表，机器自己就说成没有列表和原因：主机不会因为它把整份报告拒掉', async (t) => {
  const { nodes, machine } = hub(t);
  const count = (length: number, each: (index: number) => ModelInfo): ModelInfo[] => Array.from({ length }, (_, index) => each(index));
  const strengths = (length: number): string[] => Array.from({ length }, (_, index) => `e${index}`);
  const cases: [string, ModelInfo[], string | null][] = [
    ['刚好到上限', count(200, (index) => ({ id: `m${index}`, efforts: strengths(20) })), null],
    ['模型太多', count(201, (index) => ({ id: `m${index}` })), 'x models 列出了 201 个模型，超过一份报告能带的 200 个'],
    ['强度太多', [{ id: 'm', efforts: strengths(21) }], 'x models 列出的模型里有推理强度超过 20 个的'],
    ['名字不是一行', [{ id: 'a\tb' }], 'x models 列出的模型里有不是一行文字的名字'],
    ['名字是空白', [{ id: ' ' }], 'x models 列出的模型里有不是一行文字的名字'],
    ['显示名不是一行', [{ id: 'm', name: 'a\nb' }], 'x models 列出的模型里有不是一行文字的名字'],
    ['强度不是一行', [{ id: 'm', efforts: ['a\rb'] }], 'x models 列出的模型里有不是一行文字的名字'],
    ['默认强度不是一行', [{ id: 'm', defaultEffort: 'a\u001bb' }], 'x models 列出的模型里有不是一行文字的名字'],
  ];
  for (const [what, list, error] of cases) {
    const { run } = answering({ 'x --version': ok('1.0\n'), 'x models': ok('') });
    const report = await probeExecutors({ questions: [{ executor: 'x', command: 'x', version: ['--version'], models: { argv: ['x', 'models'], parse: () => list } }], run });
    assert.deepEqual(report.executors[0]!.models, error === null ? { list } : { list: [], error }, what);
    await nodes.poll(machine.id, { runs: [], facts: FACTS, executors: report });
    assert.deepEqual(nodes.reportedExecutors(machine.id), report, `${what}：主机收下了`);
  }
});

test('适配器的解析自己出错，只是这一问没读到：别的执行器照报，原因里没有命令的输出', async () => {
  const { run } = answering({ 'x --version': ok('1.0\n'), 'x models': ok(SECRET), 'y --version': ok('2.0\n') });
  const report = await probeExecutors({ questions: [
    { executor: 'x', command: 'x', version: ['--version'], models: { argv: ['x', 'models'], parse: (stdout) => { throw new Error(`cannot read ${stdout}`); } } },
    { executor: 'y', command: 'y', version: ['--version'] },
  ], run });
  assert.deepEqual(report.executors.map((each) => [each.executor, each.installed, each.models]), [['x', true, { list: [], error: 'x models 的回答读不出来' }], ['y', true, undefined]]);
  assert.equal(JSON.stringify(report).includes(SECRET), false);
});

// -- the machines page: the report's list, or why there is none -------------------------------

type Shown = { id: string | null; executor: string; configured: boolean; models: { list: ModelInfo[]; at: string | null; refreshing: boolean; reason: string | null } };

// h1 as the fixture has it, with what it reported and whether it is here stood in for.
async function page(t: TestContext, state: { report: NodeExecutorReport | null; connected: boolean }) {
  const f = fixture(t);
  const real = createNodes({ ...NODES_TUNED, ledger: f.ledger, log: () => {} });
  const nodes: HttpOptions['nodes'] = { ...real, reportedExecutors: (id: string) => (id === 'h1' ? state.report : null), connected: (id: string) => id === 'h1' && state.connected };
  let asked = 0;
  const app = await consoleApp(t, { f, nodes, models: {
    // What the ledger holds for a login, which is an account's list and never a machine's.
    state: (id) => ({ list: f.ledger.loginState(id).models, at: f.ledger.loginState(id).models_at, refreshing: false }),
    refresh: async () => { asked += 1; return { ok: false as const, reason: '不该问' }; },
    reschedule: () => {},
  } });
  const logins = async (): Promise<Record<string, Shown>> => {
    const body = await (await app.get('/api/machines')).json() as { machines: { id: string; logins: Shown[] }[] };
    return Object.fromEntries(body.machines.find(({ id }) => id === 'h1')!.logins.map((login) => [login.executor, login]));
  };
  return { f, app, logins, asked: () => asked };
}

const said = (executor: string, models?: NodeExecutorStatus['models']): NodeExecutorStatus =>
  ({ executor, installed: true, version: 'v', logged_in: true, ...(models === undefined ? {} : { models }) });

test('机器页上机器自己的登录给的是机器报告的列表和报告的时刻，没设置过的也一样；账本里的旧列表不再拿出来', async (t) => {
  const state = { report: { at: AT, executors: [said('codex', { list: LIST }), said('claude', { list: [{ id: 'sonnet' }] })] } as NodeExecutorReport | null, connected: true };
  const { f, app, logins, asked } = await page(t, state);
  // The fixture's own h1/claude is set up, and once had a list of its own in the ledger.
  const claude = f.ledger.getMachineLogin('h1', 'claude')!;
  f.ledger.noteModels(claude.id, [{ id: 'stale' }], '2026-11-01T00:00:00.000Z');
  const shown = await logins();
  assert.deepEqual([shown.codex!.id, shown.codex!.configured], [null, false], 'codex 报告已登录、还没设置');
  assert.deepEqual(shown.codex!.models, { list: LIST, at: AT, refreshing: false, reason: null });
  assert.deepEqual(shown.claude!.models, { list: [{ id: 'sonnet' }], at: AT, refreshing: false, reason: null });
  // Filling in the tiers asks nobody: the list is the machine's to report.
  const uid = f.ledger.getMachine('h1')!.uid;
  const made = await app.send('PUT', `/api/machines/${uid}/logins/codex`, { tiers: { execute: content('model="gpt-x"\n') } });
  assert.equal(made.status, 201);
  const after = (await made.json() as { machine: { logins: Shown[] } }).machine.logins.find(({ executor }) => executor === 'codex')!;
  assert.deepEqual([after.configured, after.models], [true, { list: LIST, at: AT, refreshing: false, reason: null }]);
  assert.equal(asked(), 0, '服务自己不去问');
  // Away now, the last report still stands, with when it was read.
  state.connected = false;
  assert.deepEqual((await logins()).codex!.models, { list: LIST, at: AT, refreshing: false, reason: null });
});

test('机器页说得清为什么没有列表：机器没读到、机器不在线、客户端太旧、没报告这个执行器', async (t) => {
  const state = { report: { at: AT, executors: [said('codex', { list: [], error: 'codex debug models 退出码 2' }), said('claude')] } as NodeExecutorReport | null, connected: true };
  const { logins } = await page(t, state);
  const none = (reason: string, at: string | null = null) => ({ list: [], at, refreshing: false, reason });
  assert.deepEqual((await logins()).codex!.models, none('codex debug models 退出码 2', AT), '机器问过、没读到：原因和时刻都是它报的');
  assert.deepEqual((await logins()).claude!.models, none(modelText.machineSilent), '在线、报告里没有模型这一段');
  assert.match(modelText.machineSilent, /旧版/);
  // Its version could not be read, so nothing else was asked: the machine's own reason.
  state.report = { at: AT, executors: [{ executor: 'claude', installed: true, version: null, logged_in: null, error: 'claude --version 没有读出版本：退出码 3' }] };
  assert.deepEqual((await logins()).claude!.models, none('claude --version 没有读出版本：退出码 3'), '在线、版本没读出来');
  // Not asked because it could not be run there is not an old client: the reason is that one.
  state.report = { at: AT, executors: [{ ...said('claude'), unusable: '这一版用不了：要 2.1.0 以上' }] };
  assert.deepEqual((await logins()).claude!.models, none('这一版用不了：要 2.1.0 以上'), '在线、这一版用不了');
  state.report = { at: AT, executors: [{ executor: 'claude', installed: false, version: null, logged_in: null }] };
  assert.deepEqual((await logins()).claude!.models, none(modelText.machineNotInstalled), '在线、没装');
  state.report = { at: AT, executors: [said('codex', { list: LIST })] };
  assert.deepEqual((await logins()).claude!.models, none(modelText.machineNoExecutor), '在线、报告里没有这个执行器');
  state.report = null;
  assert.deepEqual((await logins()).claude!.models, none(modelText.machineNoExecutor), '在线、还什么都没报告');
  state.connected = false;
  assert.deepEqual((await logins()).claude!.models, none(modelText.machineOffline));
  assert.match(modelText.machineOffline, /不在线/);
});

// -- the service asks nothing for a machine's own login ------------------------------------------

test('定时的模型查询不问机器自己的登录，也不为它记一行日志', { timeout: 90_000 }, async (t) => {
  // The stage's one login is h1's own Claude login.
  const s = stage(t);
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  await s.start();
  // A login that is due is asked on a timer of no delay, and what comes of a query that makes
  // no request is said before any later timer runs: by now the round, if it had one, is over.
  await sleep(50);
  assert.deepEqual(lines.filter((line) => line.includes('模型')), []);
});
