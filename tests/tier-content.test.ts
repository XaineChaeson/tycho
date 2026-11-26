// Guards against a tier that says one thing and a round that runs another: content the
// executor would silently drop being saved or started on, content that never reaches the
// machine (a Run falling back to the machine's own tier), an executor handed the text in a
// shape it cannot read, a resumed round handed a different tier than the one it started
// under, and a tier written as the name of a file on the machine being taken at all: only
// content rides a Run, so only content is a tier.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { geminiAdapter } from '../adapters/gemini.ts';
import type { Account } from '../runner/snapshot.ts';
import { prepareSnapshot, tierFor, writeSnapshot } from '../runner/snapshot.ts';
import { createAccounts } from '../service/accounts.ts';
import { createLogins } from '../service/logins.ts';
import { InputError } from '../service/errors.ts';
import { MATERIALS_PLACEHOLDER, ARTIFACTS_PLACEHOLDER } from '../shared/node-protocol.ts';
import type { FakeRemote } from './fake-remote.ts';
import { claudeTier, codexTier, content, fixture, machineLogin, RUN_LIMIT_MS, USER, holdMachine, testMachine } from './helpers.ts';
import { signIn, stage, until } from './stage.ts';

const options = { timeout: 60_000 };
const EXECUTORS = { claude: claudeAdapter, codex: codexAdapter, dsh: dshAdapter, gemini: geminiAdapter };

// What start.sh was handed as the Worker's command: the environment assignments and the
// separator come first, and the argv after it is what the CLI really got.
function argvOf(remote: FakeRemote, runId: string): string[] {
  const call = remote.calls.findLast((each) => each.script === 'start.sh' && each.runId === runId)!;
  const { args } = call;
  return args!.slice(args!.indexOf('--') + 1);
}

// The argv the host sent names the material's place, not an absolute path: the Worker's working
// directory is the source's, so the machine replaces the placeholder when it starts the round
// (node/watch.ts fillPlaces; docs/design/code-sources.md §2). What start.sh was handed is
// therefore the placeholder, and the host never sends a path of its own.
const materialPath = (file: string): string => `${MATERIALS_PLACEHOLDER}/${file}`;

// The rounds here run on h1's own login of each executor: the tier is what is under test.
const claudeContent = (text: string): Account => machineLogin('h1', 'claude', { tiers: { execute: content(text) } });

test('a Claude account runs under the tier its own snapshot carries', options, async (t) => {
  const text = '{\n  "model": "<模型名>",\n  "effortLevel": "high"\n}';
  const { remote, start, queued, launched, snapshotOf } = stage(t, { t1: claudeContent(text) });
  const service = await start();
  const task = queued(service);
  const run = await launched(service, task);
  assert.deepEqual(snapshotOf(run).tier_value, content(text), '快照记的是内容本身，不是一个路径');
  const argv = argvOf(remote, run.id);
  assert.equal(argv[argv.indexOf('--settings') + 1], materialPath('tier.json'));
  assert.ok(!argv.some((arg) => arg.includes('模型名')), '内容不进命令行');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('a dsh account gets the snapshot\'s own patch file', options, async (t) => {
  const text = '- id: agent-default-model\n  config:\n    model: <模型名>\n';
  const account: Account = machineLogin('h1', 'dsh', { tiers: { execute: content(text) } });
  const { remote, start, queued, launched, snapshotOf } = stage(t, { t1: account });
  const service = await start();
  const task = queued(service);
  const run = await launched(service, task);
  assert.deepEqual(snapshotOf(run).tier_value, content(text));
  const argv = argvOf(remote, run.id);
  assert.equal(argv[argv.indexOf('--patch') + 1], materialPath('tier.patch.yml'));
  assert.equal(argv[argv.indexOf('--profile') + 1], 'headless');
  assert.ok(!argv.some((arg) => arg.includes('agent-default-model')), '内容不进命令行');
});

test('a Codex account gets its tier as -c arguments, one per line, and no profile', options, async (t) => {
  const text = 'model=<模型名>\nmodel_reasoning_effort=high';
  const account: Account = machineLogin('h1', 'codex', { tiers: { execute: content(text) } });
  const { remote, start, queued, launched, snapshotOf } = stage(t, { t1: account });
  const service = await start();
  const task = queued(service);
  const run = await launched(service, task);
  assert.deepEqual(snapshotOf(run).tier_value, content(text));
  const argv = argvOf(remote, run.id);
  assert.deepEqual(argv, [
    'codex', 'exec', '--json',
    '-c', 'model=<模型名>',
    '-c', 'model_reasoning_effort=high',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_mode="danger-full-access"',
    // Adds this round's delivery and materials directories without replacing machine roots.
    '--add-dir', ARTIFACTS_PLACEHOLDER,
    '--add-dir', MATERIALS_PLACEHOLDER,
    '--skip-git-repo-check', '-C', '.',
    `请先读 ${materialPath('brief.md')}，按其中要求完成任务，并在最后一条消息末尾写回执（如需回传文件放 ${ARTIFACTS_PLACEHOLDER}/）。`,
  ]);
  // A machine's own login is Codex's own place on that machine: no CODEX_HOME is set for it.
  assert.equal(remote.calls.findLast((each) => each.script === 'start.sh' && each.runId === run.id)!.args!.some((arg) => arg.startsWith('CODEX_HOME=')), false);
});

test('a resumed round is handed the tier its own snapshot carries, by the same path', options, async (t) => {
  const text = '{"model":"<模型名>"}';
  const { remote, start, queued, launched, runsOf, snapshotOf } = stage(t, { t1: claudeContent(text) });
  const service = await start();
  const task = queued(service);
  const first = await launched(service, task);
  remote.finish(first.id, { status: 'done', summary: '好了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  await until(() => service.ledger.getRun(first.id).state === 'ended', '结算');

  service.ledger.updateTask(task.id, { goal: '再来一轮' }, { actor: 'test' });
  service.ledger.resumeTask(task.id, { actor: 'test' });
  const next = await until(() => {
    const run = runsOf(service, task)[1];
    if (!run) return false;
    return snapshotOf(run).session_ref !== undefined && remote.called('start.sh', run.id) > 0 && service.ledger.getRun(run.id).state === 'running' && run;
  }, '第二轮启动');
  const snapshot = snapshotOf(next);
  assert.deepEqual(snapshot.tier_value, content(text), '接续用的是这一轮自己的快照记的档位');
  const argv = argvOf(remote, next.id);
  assert.equal(argv[argv.indexOf('--settings') + 1], materialPath('tier.json'));
  assert.deepEqual(argv.slice(-2), ['--resume', snapshot.session_ref]);
});

test('the snapshot file carries the tier text as written without mutating exclusions, and only where the executor reads one', (t) => {
  const f = fixture(t, {}, false);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);
  const text = '{\n  "model": "<模型名>",\n  "effortLevel": "high"\n}\n';
  const where = mkdtempSync(join(tmpdir(), 'tycho-tier-'));
  t.after(() => rmSync(where, { recursive: true, force: true }));

  const write = (account: Account, name: string): string => {
    const dir = join(where, name);
    writeSnapshot(prepareSnapshot(f.ledger.getTask(task.id), account, EXECUTORS, { timeoutMs: RUN_LIMIT_MS }), dir);
    return dir;
  };
  const claude = write({ id: 't1', name: 't1', executor: 'claude', tiers: { execute: content(text) } }, 'claude');
  assert.deepEqual(JSON.parse(readFileSync(join(claude, 'tier.json'), 'utf8')), JSON.parse(text));
  assert.match(readFileSync(join(claude, 'brief.md'), 'utf8'), /^# t\n/, '简报还是照旧写在旁边');
  const patch = '- id: agent-default-model\n  config:\n    model: <模型名>\n';
  const dsh = write({ id: 't1', name: 't1', executor: 'dsh', tiers: { execute: content(patch) } }, 'dsh');
  assert.equal(readFileSync(join(dsh, 'tier.patch.yml'), 'utf8'), patch, 'dsh 的一个字节不动');
  const codex = write({ id: 't1', name: 't1', executor: 'codex', tiers: { execute: content('model=<模型名>\nmodel_reasoning_effort=high') } }, 'codex');
  assert.deepEqual(readdirSync(codex).sort(), ['access.json', 'brief.md', 'context.json'], 'Codex 走命令行，档位不落文件');
});

test('the tier an adapter is handed comes from the record, in the snapshot where the executor reads a file', () => {
  const tier = content('{"model":"m"}');
  assert.deepEqual(tierFor('claude', tier, 'r1'), { tier, tierPath: materialPath('tier.json') });
  assert.deepEqual(tierFor('dsh', tier, 'r1'), { tier, tierPath: materialPath('tier.patch.yml') });
  assert.deepEqual(tierFor('codex', tier, 'r1'), { tier }, '命令行执行器没有文件可指');
});

test('content the executor would drop is refused at the door, and the ledger is not written to', (t) => {
  const f = fixture(t, {}, false);
  const accounts = createAccounts({ ledger: f.ledger, executors: EXECUTORS, credentialExecutors: ['claude'], dataDir: f.dir, log: () => {} });
  const refusals: { executor: string; tiers: Record<string, unknown>; why: RegExp }[] = [
    { executor: 'claude', tiers: { execute: content('{"model":') }, why: /档位 execute：不是合法的 JSON/ },
    { executor: 'claude', tiers: { execute: content('[1, 2]') }, why: /settings 对象/ },
    { executor: 'claude', tiers: { execute: content('   ') }, why: /内容不能为空/ },
    { executor: 'codex', tiers: { execute: content('model=x\nhigh') }, why: /第 2 行没有 =/ },
    { executor: 'codex', tiers: { execute: content('=x') }, why: /第 1 行的键是空的/ },
    { executor: 'codex', tiers: { execute: content('model=x\u0000y') }, why: /传不过去的字符/ },
    // dsh reads a patch list, and a mapping at the top level is not one.
    { executor: 'dsh', tiers: { execute: content('id: agent-default-model\n') }, why: /YAML 列表/ },
    { executor: 'dsh', tiers: { execute: content('# 只有注释\n') }, why: /内容不能为空/ },
    // The name of a file on the machine is not a tier, in whatever shape it comes.
    { executor: 'claude', tiers: { execute: '/tiers/execute.json' }, why: /档位 execute 要写成 \{ "kind": "content"/ },
    { executor: 'claude', tiers: { execute: { kind: 'ref', value: '/tiers/execute.json' } }, why: /档位 execute 要写成 \{ "kind": "content"/ },
    { executor: 'claude', tiers: { execute: { kind: 'other', text: 'x' } }, why: /kind/ },
  ];
  const before = f.dump();
  for (const { executor, tiers, why } of refusals) {
    assert.throws(() => accounts.put({ ...({ executor, tiers, credential: 'token-t1' }), name: 't1' }, USER),
      (err: Error) => err instanceof InputError && why.test(err.message), `${executor} ${JSON.stringify(tiers)}：${why}`);
  }
  assert.deepEqual(f.dump(), before, '被拒的保存一个字节都不写');

  // What is stored is what was written, byte for byte: the check is not a rewrite. The two
  // names are the only ones an account may hold.
  const { account: { id } } = accounts.put({ name: 't1', executor: 'claude', tiers: { execute: content('{"model":"m","effortLevel":"high","permissions":{"defaultMode":"bypassPermissions"}}'), decide: content('{"model":"m"}') }, credential: 'token-t1' }, USER);
  assert.deepEqual({ ...accounts.get(id)!.tiers }, { execute: content('{"model":"m","effortLevel":"high","permissions":{"defaultMode":"bypassPermissions"}}'), decide: content('{"model":"m"}') });
  // Codex and dsh are machines' own logins: the same check, the same store.
  holdMachine(f.ledger, testMachine('h1'), USER);
  const logins = createLogins({ ledger: f.ledger, accounts, executors: EXECUTORS });
  logins.putMachineLogin('h1', 'codex', { tiers: { execute: content('model=x\n\n') } }, USER);
  assert.deepEqual(logins.get(f.ledger.getMachineLogin('h1', 'codex')!.id)!.tiers.execute, content('model=x\n\n'), '行尾的空行是文本文件的收尾，不是内容的一部分');
  logins.putMachineLogin('h1', 'dsh', { tiers: { execute: content('- id: agent-default-model\n  config:\n    model: <模型名>\n') } }, USER);
  assert.deepEqual(logins.get(f.ledger.getMachineLogin('h1', 'dsh')!.id)!.tiers.execute, content('- id: agent-default-model\n  config:\n    model: <模型名>\n'));
  // And a machine's own login refuses what an account refuses, by the same check.
  assert.throws(() => logins.putMachineLogin('h1', 'claude', { tiers: { execute: content('{"model":') } }, USER), /不是合法的 JSON/);
  assert.equal(f.ledger.getMachineLogin('h1', 'claude'), undefined);
});

// The same inputs, reaching the ledger behind the console: a round must not be created on
// a tier the executor would silently replace with the machine's own.
test('a tier the executor would drop behind the console is not started on either', options, async (t) => {
  const cases: Account[] = [
    machineLogin('h1', 'claude', { tiers: { execute: content('{"model":') } }),
    machineLogin('h1', 'dsh', { tiers: { execute: content('id: x\n') } }),
  ];
  const said = [
    /派发失败：机器 h1 上的 claude 登录 档位 execute 的内容用不了：不是合法的 JSON/,
    /派发失败：机器 h1 上的 dsh 登录 档位 execute 的内容用不了：.*YAML 列表/,
  ];
  for (const [index, account] of cases.entries()) {
    const { remote, start, queued } = stage(t, { t1: account });
    const service = await start();
    const task = queued(service);
    const held = await until(() => {
      const now = service.ledger.getTask(task.id);
      return now.state === 'held' && now;
    }, `派发失败：${account.executor}`);
    assert.match(held.reason!, said[index]!, `${account.executor} ${JSON.stringify(account.tiers)}`);
    assert.deepEqual(service.ledger.listRuns(task.id), [], '没有 Run 被建出来');
    assert.equal(remote.called('start.sh'), 0, '机器上什么都没启动');
  }
});

test("an account's tiers are content: the API refuses the name of a file on the machine and what it cannot read, and a refused edit leaves what was stored", options, async (t) => {
  const { start } = stage(t, {});
  const service = await start();
  const client = await signIn(service);
  const put = (path: string, body: unknown, method = 'PUT'): Promise<Response> =>
    fetch(`${client.base}${path}`, { method, headers: { Cookie: client.cookie, Origin: client.base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = async (response: Response): Promise<any> => response.json();

  // The account is made the way the login window makes one; its tiers are then the API's to edit.
  service.accounts.put({ name: 'mix', executor: 'claude', credential: 'token-mix', tiers: { execute: claudeTier('x'), decide: { kind: 'content', text: '{"model":"m"}' } } }, USER);
  const account = (await json(await client.get('/api/accounts'))).accounts[0];
  const file = await put(`/api/accounts/${account.id}`, { executor: 'claude', tiers: { execute: '/tiers/execute.json' } });
  assert.equal(file.status, 400);
  assert.match((await json(file)).error, /档位 execute 要写成 \{ "kind": "content"/);
  assert.deepEqual(account.tiers, {
    execute: claudeTier('x'),
    decide: content('{"model":"m"}'),
  });
  const refused = await put(`/api/accounts/${account.id}`, { executor: 'claude', tiers: { execute: { kind: 'content', text: 'nope' } } });
  assert.equal(refused.status, 400);
  assert.match((await json(refused)).error, /不是合法的 JSON/);
  // A name outside them is refused by the same entrance (docs/design/roles-and-tiers.md §2).
  const stale = await put(`/api/accounts/${account.id}`, { executor: 'claude', tiers: { escalation: claudeTier('e') } });
  assert.equal(stale.status, 400);
  assert.match((await json(stale)).error, /档位只有操作档（operate）、执行档（execute）、决策档（decide）三个，不能有 escalation/);
  assert.deepEqual((await json(await client.get('/api/accounts'))).accounts[0].tiers, {
    execute: claudeTier('x'),
    decide: content('{"model":"m"}'),
  }, '被拒的保存不动已经存下的那一个');
});

test('gemini tier uses tier.json in snapshot and strips effort from settings while keeping model and allowed keys', async (t) => {
  const { MATERIALS_PLACEHOLDER } = await import('../shared/node-protocol.ts');
  const { prepareSnapshot, snapshotFiles } = await import('../runner/snapshot.ts');
  const tier = content(JSON.stringify({ model: 'gemini-4-carbon-high', effort: 'high', disableSlashCommands: true }, null, 2));
  assert.deepEqual(tierFor('gemini', tier, 'r1'), {
    tier,
    tierPath: `${MATERIALS_PLACEHOLDER}/tier.json`,
  });
  const f = fixture(t);
  // Machine's own login leaves modelProvider untouched (uses machine's OS Keyring login);
  // managed account injects modelProvider: "gemini" so agy uses GEMINI_API_KEY and never falls back to Keyring.
  const ownLogin = { id: 'm1/gemini', name: 'm1/gemini', machine: 'm1', executor: 'gemini', tiers: { execute: tier } };
  const ownSnapshot = prepareSnapshot(f.newTask(), ownLogin, EXECUTORS, { timeoutMs: 60_000 });
  const ownFiles = snapshotFiles(ownSnapshot);
  assert.deepEqual(JSON.parse(ownFiles.find((each) => each.path === 'tier.json')!.text), {
    model: 'gemini-4-carbon-high',
    disableSlashCommands: true,
  });

  const managedSnapshot = { ...ownSnapshot, credential_ref: 'ref-gemini-1' };
  const managedFiles = snapshotFiles(managedSnapshot);
  assert.deepEqual(JSON.parse(managedFiles.find((each) => each.path === 'tier.json')!.text), {
    model: 'gemini-4-carbon-high',
    disableSlashCommands: true,
    modelProvider: 'gemini',
  });
  // Ledger/snapshot value still retains effort so resume & CLI --effort can read it.
  assert.equal(ownSnapshot.tier_value.text, tier.text);
  assert.equal(geminiAdapter.checkTier!(content('{"permissions":{}}')), undefined);
  // User-supplied modelProvider is allowed by checkTier and preserved in tier.json.
  assert.equal(geminiAdapter.checkTier!(content('{"modelProvider":"antigravity"}')), undefined);
  const customProviderTier = content(JSON.stringify({ model: 'gemini-4-carbon-high', effort: 'high', modelProvider: 'antigravity' }));
  const customSnapshot = { ...prepareSnapshot(f.newTask(), { ...ownLogin, tiers: { execute: customProviderTier } }, EXECUTORS, { timeoutMs: 60_000 }), credential_ref: 'ref-gemini-2' };
  assert.deepEqual(JSON.parse(snapshotFiles(customSnapshot).find((each) => each.path === 'tier.json')!.text), {
    model: 'gemini-4-carbon-high',
    modelProvider: 'antigravity',
  });
});
