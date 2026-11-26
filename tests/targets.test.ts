// Guards against execution accounts, now objects the owner edits in the console, going
// wrong where a file used to be read once: an account the Runner cannot use getting into
// the ledger (one without a login of its own, one still naming machines, a name ssh would
// read as an option, no tier, a tier that is only an inherited name, a permission mode on
// an executor that has none, an executor with no adapter, or one whose login tycho cannot
// keep), a change that leaves no trace or a trace that does not say what changed, a holder
// of the store keeping a copy that misses a change, an account deleted from under queued
// work without the owner agreeing to what happens to it, a connection test that writes to
// the machine or to the ledger or hangs on a machine that does not answer, a change taken
// while the ledger cannot record it or an inventory is running, a new account or a removed
// machine only taking effect after a restart, an account kept to the machines it was first
// seen on rather than any machine the project allows (docs/design/accounts-machines-
// decoupled.md), and a Task sent out with a skill file from the data directory, which no
// round reads any more (skills are ledger entries, docs/design/knowledge-and-skills.md §6).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { createRunner } from '../runner/runner.ts';
import type { ExecutorsAnswer } from '../runner/host.ts';
import type { NodeExecutorReport, NodeExecutorStatus } from '../shared/node-protocol.ts';
import type { Account, Login } from '../runner/snapshot.ts';
import { ConfirmationRequired, InputError } from '../service/errors.ts';
import type { AccountInput } from '../service/accounts.ts';
import { checkAccount, checkAccountName, createAccounts } from '../service/accounts.ts';
import { accountCredentialFile } from '../service/secrets.ts';
import { NO_CREDENTIAL_TEXT } from '../shared/logins.ts';
import { expectedExpiry } from '../shared/credential.ts';
import { consoleApp } from './console-helpers.ts';
import { fakeRemote } from './fake-remote.ts';
import { claudeTier, codexTier, dshTier, machineLogin, RUNNER_TUNED, holdMachine, testMachine, uidsOf } from './helpers.ts';
import type { Fixture } from './helpers.ts';
import { fixture, memoryLogins, memoryMachines, MACHINE, LOGIN as RUN, USER } from './helpers.ts';
import { signIn, stage, until } from './stage.ts';

// The adapters themselves: an account is checked against what its executor declares.
const EXECUTORS = { claude: claudeAdapter, codex: codexAdapter, dsh: dshAdapter };
const VALID: AccountInput = { executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };
// What a new account is made with: its login token.
const MADE: AccountInput = { ...VALID, credential: 'token-1' };
// An account as the whole service holds one, and its token.
const T1: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };
const options = { timeout: 60_000 };
const json = async (response: Response): Promise<any> => response.json();

function refusal(input: AccountInput): string {
  try {
    // A name that is valid, so that what a case is about is the one thing it changed.
    checkAccount({ name: 't1', ...input }, EXECUTORS);
  } catch (err) {
    assert.ok(err instanceof InputError, String(err));
    return err.message;
  }
  return '';
}

function setup(t: TestContext, f: Fixture = fixture(t, {}, false)) {
  const accounts = createAccounts({ ledger: f.ledger, executors: EXECUTORS, credentialExecutors: ['claude'], dataDir: f.dir, log: () => {} });
  for (const id of ['h1', 'h2', 'h3', 'h9']) holdMachine(f.ledger, testMachine(id));
  const changes = (action?: string) =>
    f.peek<{ action: string; actor: string; detail_json: string }>(`SELECT action, actor, detail_json FROM change WHERE action LIKE 'account.%' ORDER BY seq`)
      .filter((row) => !action || row.action === action)
      .map((row) => ({ action: row.action, actor: row.actor, detail: JSON.parse(row.detail_json) }));
  return { f, accounts, changes };
}

// --- what a valid account is ---

test('a complete account passes, with what is optional left out', () => {
  const checked = checkAccount({ ...VALID, name: 't1' }, EXECUTORS);
  assert.deepEqual({ ...checked, tiers: { ...checked.tiers } }, { name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } });
  // What a form sends for a field left empty is the same as leaving it out.
  const blank = checkAccount({ ...VALID, name: 't1', permissionMode: '', timeoutMs: null }, EXECUTORS);
  for (const field of ['permissionMode', 'timeoutMs'] as const) assert.ok(!(field in blank), field);
  // No name at all is fine for a new account: the ledger decides one from the executor's
  // identity in the transaction that writes the row (service/ledger.ts), so nothing here can
  // require one or fall back to the account's own id.
  const unnamed = checkAccount(VALID, EXECUTORS);
  assert.ok(!('name' in unnamed) && !('id' in unnamed));
});

test('an account needs a supported executor and tier, and names no machines: a list of them is refused, never dropped', () => {
  assert.match(refusal({ ...VALID, executor: '' }), /执行器不能为空/);
  assert.match(refusal({ ...VALID, executor: undefined }), /执行器不能为空/);
  assert.match(refusal({ ...VALID, executor: 'gemini' }), /没有执行器 gemini 的适配器，可选：claude、codex、dsh/);
  for (const machines of [[], ['h1'], 'h1', null]) {
    assert.match(refusal({ ...VALID, machines } as AccountInput), /账号不再列机器/, JSON.stringify(machines));
  }
  for (const tiers of [undefined, {}, [], 'execute', null]) assert.match(refusal({ ...VALID, tiers }), /档位至少要填一个/, JSON.stringify(tiers));
  assert.match(refusal({ ...VALID, tiers: { execute: { kind: 'content', text: ' ' } } }), /档位 execute：内容不能为空/);
  // A tier is the executor's own text, and nothing else: not the name of a file on the machine.
  for (const value of ['/tiers/execute.json', 5, { kind: 'ref', value: '/tiers/execute.json' }, { kind: 'content' }]) {
    assert.match(refusal({ ...VALID, tiers: { execute: value } }), /档位 execute (要写成 \{ "kind": "content"|的内容应为一段文字)/, JSON.stringify(value));
  }
});

test('the tier map holds only the fixed names, and has no prototype to read one off', () => {
  // A name every object inherits is not a tier either: the names in shared/tiers.ts are the
  // only ones, so it is refused like any other. The map itself is built without a prototype,
  // so nothing inherited can be read as one.
  assert.match(
    refusal(JSON.parse('{"executor":"claude","tiers":{"__proto__":"/p.json"}}') as AccountInput),
    /不能有 __proto__/,
  );
  const { tiers } = checkAccount({ executor: 'claude', tiers: { execute: { kind: 'content', text: '{"model":"m"}' } } }, EXECUTORS);
  assert.equal(tiers.toString, undefined);
  assert.equal(tiers.constructor, undefined);
  assert.deepEqual(Object.keys(tiers), ['execute']);
});

// What a permission mode may be is the executor's own declaration: Claude's modes are not
// dsh's presets, and Codex has neither.
test('a permission mode is one the account\'s own executor declares', () => {
  assert.equal(checkAccount({ ...VALID, permissionMode: 'acceptEdits' }, EXECUTORS).permissionMode, 'acceptEdits');
  assert.match(refusal({ ...VALID, permissionMode: 'anything' }), /权限模式应为 bypassPermissions、acceptEdits、default、plan 之一/);
  assert.match(refusal({ ...VALID, executor: 'codex', tiers: { execute: codexTier('m') }, permissionMode: 'acceptEdits' }), /^权限模式只对 claude、dsh 执行器有意义$/);
  // A dsh account is a line; its tier names a model on that line.
  const dsh = { executor: 'dsh', provider: { line: 'official' }, tiers: { execute: { kind: 'content', text: '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: m\n' } } };
  assert.equal(checkAccount({ ...dsh, permissionMode: 'workspace-write' }, EXECUTORS).permissionMode, 'workspace-write');
  assert.match(refusal({ ...dsh, permissionMode: 'acceptEdits' }), /权限模式应为 read-only、workspace-write、danger-full-access 之一/);
});

test('a time limit is a positive whole number', () => {
  assert.equal(checkAccount({ ...VALID, timeoutMs: 60_000 }, EXECUTORS).timeoutMs, 60_000);
  for (const bad of [0, -1, 1.5, '60000']) assert.match(refusal({ ...VALID, timeoutMs: bad }), /单次执行时限应为正整数/, String(bad));
});

test('a name goes into addresses and the Router\'s tools: nothing that breaks either', () => {
  // '/new' is the console's add form key: the slash keeps any account name out of it, and
  // out of the "machine/executor" a machine's own login is named by. An ordinary space
  // inside a name is display only, so it is kept; an edge space is not. Where a name is
  // written, an unset one is not written at all: a new account without a name gets the
  // ledger's default.
  for (const id of ['', ' t1', 't1 ', 'a/b', 'a\\b', 'a?b', 'a#b', 'a%20b', 'x'.repeat(65), '/new']) assert.throws(() => checkAccountName(id), InputError, JSON.stringify(id));
  for (const id of ['t1', 't 1', '集群 claude', '集群-claude', 'cluster.codex_2', 'x'.repeat(64)]) assert.equal(checkAccountName(id), id);
  // A name that keeps names out of addresses is not required of a new account.
  assert.ok(!('name' in checkAccount(VALID, EXECUTORS)));
});

// --- an account is a login tycho keeps ---

test('an account is made with its login token or not at all, and only for an executor whose login tycho can keep', (t) => {
  const { f, accounts } = setup(t);
  const before = f.dump();
  assert.throws(() => accounts.put({ ...(VALID), name: 't1' }, USER), (err: Error) => err instanceof InputError && err.message === NO_CREDENTIAL_TEXT);
  assert.throws(() => accounts.put({ ...({ ...VALID, credential: '' }), name: 't1' }, USER), (err: Error) => err.message === NO_CREDENTIAL_TEXT);
  assert.throws(() => accounts.put({ ...({ ...VALID, credential: 'has space' }), name: 't1' }, USER), /登录的密钥应为一段不含空白的文字/);
  // Codex's subscription login cannot be carried from machine to machine: it is a machine's own.
  assert.throws(() => accounts.put({ ...({ executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m\n' } }, credential: 'k' }), name: 'c1' }, USER), /codex 的登录不能交给 tycho 保管：它只能是机器自己的登录/);
  assert.deepEqual(f.dump(), before, '一个字也没写进账本');
  // The ledger refuses one too, whoever asks it.
  assert.throws(() => f.ledger.putAccount({ id: 'raw', name: 'raw', executor: 'claude', tiers: { execute: claudeTier('/t.json') } }, USER), (err: Error) => err.message === NO_CREDENTIAL_TEXT);

  const { account, created } = accounts.put({ ...(MADE), name: 't1' }, USER);
  const t1 = account.id;
  assert.deepEqual([created, account.credential], [true, 'set']);
  const ref1 = f.ledger.accountCredentialRef(t1)!;
  assert.ok(existsSync(accountCredentialFile(f.dir, ref1)), '令牌在它自己的文件里');
  assert.equal(accounts.credentialOf(t1)!.value, 'token-1');
  // Saved again without one, it keeps the one it holds; with one, it holds the new one.
  accounts.put({ id: t1, ...({ ...VALID, timeoutMs: 1000 }), name: 't1' }, USER);
  assert.equal(f.ledger.accountCredentialRef(t1), ref1);
  accounts.put({ id: t1, ...({ ...VALID, credential: 'token-2' }), name: 't1' }, USER);
  assert.equal(accounts.credentialOf(t1)!.value, 'token-2');
  assert.equal(existsSync(accountCredentialFile(f.dir, ref1)), false, '换下来的令牌文件删掉');
  // Another executor reads another kind of token: the change has to bring one.
  const ledger = f.ledger;
  ledger.putAccount({ id: 'x1', name: 'x1', executor: 'claude', tiers: { execute: claudeTier('/t.json') } }, USER, 'ref-x1');
  assert.throws(() => ledger.putAccount({ id: 'x1', name: 'x1', executor: 'dsh', tiers: { execute: dshTier('/t.yml') } }, USER), /换执行器要同时填新执行器的登录令牌/);
  // And there is no clearing it: an account without a login is not an account.
  assert.equal('clearCredential' in accounts, false);
});

// --- the store on the ledger ---

test('a account is created, read, changed and removed, and every holder of the store sees it at once', (t) => {
  const { f, accounts } = setup(t);
  const other = createAccounts({ ledger: f.ledger, executors: EXECUTORS });
  assert.deepEqual(accounts.list(), []);
  assert.equal(accounts.get('t1'), undefined);
  assert.equal(accounts.get('toString'), undefined, '继承来的名字不是账号');

  const made = accounts.put({ ...({ ...MADE, permissionMode: 'plan', timeoutMs: 5000 }), name: 't1' }, USER);
  const t1 = made.account.id;
  assert.equal(made.created, true);
  assert.deepEqual(other.list().map(({ id }) => id), [t1]);
  const { created_at: createdAt, updated_at: updatedAt, ...stored } = other.get(t1)!;
  // canRoute is the store's own reading, from the executors it was told can drive the
  // Router: this one was told none.
  assert.deepEqual({ ...stored, tiers: { ...stored.tiers } }, {
    id: t1, name: 't1', executor: 'claude', permissionMode: 'plan', tiers: { execute: claudeTier('/tiers/execute.json') }, timeoutMs: 5000, canRoute: false, signedIn: false, credential: 'set',
  });
  assert.equal(createdAt, updatedAt);
  assert.equal(other.get(t1)!.tiers.constructor, undefined, '从账本读回来的档位表也没有继承来的名字');

  const changed = accounts.put({ id: t1, ...({ ...VALID, timeoutMs: 9000 }), name: 't1' }, USER);
  assert.equal(changed.created, false);
  assert.equal(other.get(t1)!.timeoutMs, 9000);
  assert.equal(other.get(t1)!.permissionMode, undefined, '改就是整个换掉，没写的可选项就是没有');
  assert.equal(other.get(t1)!.created_at, createdAt);

  const { account: { id: t2 } } = accounts.put({ ...({ ...MADE, credential: 'token-2' }), name: 't2' }, USER);
  assert.deepEqual(other.list().map(({ id }) => id), [t1, t2], '按加进来的先后');
  accounts.remove(t1, USER);
  assert.deepEqual(other.list().map(({ id }) => id), [t2]);
  assert.throws(() => accounts.remove(t1, USER), /账号不存在/);
});

test('each change leaves a row saying who did it and what changed; a save that changes nothing leaves none', (t) => {
  const { accounts, changes } = setup(t);
  const { account: { id: t1 } } = accounts.put({ ...(MADE), name: 't1' }, { actor: 'console' });
  accounts.put({ id: t1, ...(VALID), name: 't1' }, { actor: 'console' });
  accounts.put({ id: t1, ...({ ...VALID, timeoutMs: 9000 }), name: 't1' }, { actor: 'console' });
  accounts.remove(t1, { actor: 'console' });
  const fields = { name: 't1', executor: 'claude', machine: null, tiers: { execute: claudeTier('/tiers/execute.json') }, permission_mode: null, timeout_ms: null, max_runs: null };
  assert.deepEqual(changes(), [
    { action: 'account.create', actor: 'console', detail: { account_id: t1, account: fields } },
    { action: 'account.update', actor: 'console', detail: { account_id: t1, changed: { timeout_ms: { from: null, to: 9000 } } } },
    { action: 'account.delete', actor: 'console', detail: { account_id: t1, account: { ...fields, timeout_ms: 9000 }, queued_tasks: 0, active_runs: 0, projects: [] } },
  ]);
});

test('a reference to a deleted account is named by what it was called, never by its internal id', (t) => {
  const { f } = setup(t);
  f.ledger.putAccount({ id: 'internal-1', name: 'claude', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } }, USER, 'ref-one');
  assert.equal(f.ledger.deletedAccountName('internal-1'), null, '还在的账号不问它被删时的名字');
  assert.equal(f.ledger.deletedAccountName('never-existed'), null, '账本里从来没有过的引用没有名字');
  f.ledger.deleteAccount('internal-1', USER);
  assert.equal(f.ledger.deletedAccountName('internal-1'), 'claude', '说名字，不说编号');
  // A reference the step to version 18 folded into a machine's own login was the name itself.
  f.force(`INSERT INTO change (id, created_at, at, actor, action, detail_json) VALUES ('fold', 'now', 'now', 'migration', 'login.migrate', '{"account_id":"anywhere"}')`);
  assert.equal(f.ledger.deletedAccountName('anywhere'), 'anywhere');
});

test('a refused account writes nothing at all', (t) => {
  const { f, accounts } = setup(t);
  const { account: { id: t1 } } = accounts.put({ ...(MADE), name: 't1' }, USER);
  const before = f.dump();
  assert.throws(() => accounts.put({ id: t1, ...({ ...VALID, machines: ['h1'] } as AccountInput), name: 't1' }, USER), InputError);
  assert.throws(() => accounts.put({ ...(MADE), name: 'bad/id' }, USER), InputError);
  assert.deepEqual(f.dump(), before);
});

test('deleting a account with work on it takes the owner\'s word: the count comes back, and nothing is deleted until it is given', (t) => {
  const { f, accounts, changes } = setup(t);
  const { account: { id: t1 } } = accounts.put({ ...(MADE), name: 't1' }, USER);
  f.ledger.createRun(f.queuedTask().id, { ...RUN, machine: f.ledger.getMachine('h1')!, login: accounts.get(t1)! }, USER);
  const waiting = f.ledger.createTask({ projectId: f.projectId, title: '排队的', goal: '目标', acceptance: '验收', loginId: t1, roleId: 'implement' }, USER);
  f.ledger.queueTask(waiting.id, USER);
  const before = f.dump();
  assert.throws(
    () => accounts.remove(t1, USER),
    (err: Error) => err instanceof ConfirmationRequired && /1 个排队的任务、1 个没结束的执行/.test(err.message) && /机器被移除/.test(err.message)
      && err.detail.queued_tasks === 1 && err.detail.active_runs === 1,
  );
  assert.deepEqual(f.dump(), before);
  accounts.remove(t1, USER, { confirmed: true });
  assert.equal(accounts.get(t1), undefined);
  assert.deepEqual(changes('account.delete')[0]!.detail.queued_tasks, 1);
  assert.equal(f.task(waiting.id).state, 'queued', '任务本身不在这一步里动：派发时没有目标才停住');
});

// Review finding 16: the question used to promise a way out that did not exist ("wait for
// you to give them another account") for the common project that allows one account only.
// A machine's own login a project allows is a way out too.
test('deleting a account names the projects it leaves with nowhere to run and says how they get out, work on it or not', (t) => {
  const { f, accounts } = setup(t);
  const { account: { id: t1 } } = accounts.put({ ...(MADE), name: 't1' }, USER);
  const { account: { id: t2 } } = accounts.put({ ...(MADE), name: 't2' }, USER);
  f.ledger.putMachineLogin({ executor: 'claude', machine: 'h1', tiers: { execute: claudeTier('/t.json') } }, USER);
  const own = f.ledger.getMachineLogin('h1', 'claude')!.id;
  const only = f.ledger.createProject({ name: '只有一个', logins: [t1] }, USER);
  const two = f.ledger.createProject({ name: '有两个', logins: [t1, t2] }, USER);
  const withOwn = f.ledger.createProject({ name: '还有机器的登录', logins: [t1, own] }, USER);
  const gone = f.ledger.createProject({ name: '另一个早没了', logins: ['gone', t1] }, USER);
  const listed = (id: string): string[] => JSON.parse(f.peek<{ logins_json: string }>('SELECT logins_json FROM project WHERE id = ?', id)[0]!.logins_json) as string[];
  const before = f.dump();
  assert.throws(() => accounts.remove(t1, USER), (err: Error) => {
    assert.ok(err instanceof ConfirmationRequired);
    assert.match(err.message, /项目 只有一个、另一个早没了 删了以后没有可用的登录/);
    assert.match(err.message, /项目页.*重新选/);
    assert.doesNotMatch(err.message, /有两个|还有机器的登录|等你给它们换账号/);
    // The confirmation carries the same list the answer will: every project that allowed it,
    // and what each would have left once it is gone.
    assert.deepEqual(err.detail, {
      queued_tasks: 0, active_runs: 0,
      stranded_projects: ['只有一个', '另一个早没了'],
      projects: [
        { id: only, name: '只有一个', remaining: 0 },
        { id: two, name: '有两个', remaining: 1 },
        { id: withOwn, name: '还有机器的登录', remaining: 1 },
        { id: gone, name: '另一个早没了', remaining: 0 },
      ],
    });
    return true;
  });
  assert.deepEqual(f.dump(), before, '没有排队的任务也要先问：删了以后这些项目就派不出去了');
  // Nothing stranded and no work: no question. 有两个 still has t1.
  accounts.remove(t2, USER);
  assert.equal(accounts.get(t2), undefined);
  assert.deepEqual(listed(two), [t1], '删 t2 也从清单里去掉了它');
  const beforeT1 = f.peek<{ n: number }>(`SELECT count(*) AS n FROM change WHERE action = 'project.update'`)[0]!.n;
  // Told to go ahead: the reference goes from every list in the same transaction, each
  // project records it by the name it went by, and the answer says what each has left.
  const { projects } = accounts.remove(t1, USER, { confirmed: true });
  assert.deepEqual(projects, [
    { id: only, name: '只有一个', remaining: 0 },
    { id: two, name: '有两个', remaining: 0 },
    { id: withOwn, name: '还有机器的登录', remaining: 1 },
    { id: gone, name: '另一个早没了', remaining: 0 },
  ]);
  for (const id of [only, two, withOwn, gone]) assert.ok(!listed(id).includes(t1), `项目 ${id} 的清单里不再有 t1`);
  assert.deepEqual(listed(withOwn), [own], '别的登录留着');
  const removed = f.peek<{ detail_json: string }>(`SELECT detail_json FROM change WHERE action = 'project.update' ORDER BY seq`)
    .slice(beforeT1)
    .map((row) => JSON.parse(row.detail_json) as { login_removed?: string; reason?: string })
    .filter((detail) => detail.login_removed !== undefined);
  assert.deepEqual(removed.map((detail) => detail.login_removed), ['t1', 't1', 't1', 't1']);
  assert.match(String(removed[0]!.reason), /登录 t1 被删掉/);
});

test('a account with work on it and no project stranded says what the stopped tasks need, without promising it happens by itself', (t) => {
  const { f, accounts } = setup(t);
  const { account: { id: t1 } } = accounts.put({ ...(MADE), name: 't1' }, USER);
  const { account: { id: t2 } } = accounts.put({ ...(MADE), name: 't2' }, USER);
  const projectId = f.ledger.createProject({ name: '有两个', logins: [t1, t2] }, USER);
  const waiting = f.ledger.createTask({ projectId, title: '排队的', goal: '目标', acceptance: '验收', loginId: t1, roleId: 'implement' }, USER);
  f.ledger.queueTask(waiting.id, USER);
  assert.throws(() => accounts.remove(t1, USER), (err: Error) => {
    assert.ok(err instanceof ConfirmationRequired);
    assert.match(err.message, /1 个排队的任务、0 个没结束的执行/);
    assert.match(err.message, /换一个项目允许的登录/);
    assert.deepEqual(err.detail.stranded_projects, []);
    return true;
  });
});

// --- the console's interface ---

test('GET /api/accounts lists each account with what is known of the machines it may use and what the form may offer', async (t) => {
  const facts = [
    { login_id: 't1', machine_id: 'h1', host: 'h1', up: true, last_ok_at: '2026-11-06T01:00:00.000Z', active_runs: 2 },
    { login_id: 'other', machine_id: 'h1', host: 'h1', up: false, last_ok_at: null, active_runs: 9 },
  ];
  const { f, get } = await consoleApp(t, { runner: { machines: () => facts } });
  holdMachine(f.ledger, testMachine('h2'), USER);
  f.ledger.putAccount({ ...f.ledger.getAccount('t1')!, timeoutMs: 60_000 }, USER);
  f.ledger.setProjectLogins(f.projectId, ['t1'], USER);
  f.queuedTask();
  const waiting = f.ledger.createTask({ projectId: f.projectId, title: '排队的', goal: '目标', acceptance: '验收', loginId: 't1', roleId: 'implement' }, USER);
  f.ledger.queueTask(waiting.id, USER);
  const body = await json(await get('/api/accounts'));
  assert.deepEqual(body.executors, ['claude', 'codex', 'dsh', 'gemini']);
  // By executor, from the adapters: the console offers the field only where one is declared.
  assert.deepEqual(body.permission_modes, {
    claude: ['bypassPermissions', 'acceptEdits', 'default', 'plan'],
    dsh: ['read-only', 'workspace-write', 'danger-full-access'],
    gemini: ['dangerously-skip-permissions', 'accept-edits', 'auto', 'plan'],
  });
  // And how a tier of each is written and read: the shape of its text, the values the
  // console's form edits, and the strengths its own command takes. Nothing of this is a
  // model name, and the functions stay on the service's side.
  assert.deepEqual(body.tier_forms, {
    claude: { format: 'settings-json', fields: ['model', 'effort'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    codex: { format: 'key-value-lines', fields: ['model', 'effort'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    dsh: { format: 'patch-list', fields: ['provider', 'model', 'effort'], efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    gemini: { format: 'gemini-settings-json', fields: ['model', 'effort'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  });
  assert.equal(body.accounts.length, 1);
  const { created_at: createdAt, updated_at: updatedAt, credential_at: credentialAt, expected_expiry: expectedExpiryAt, ...account } = body.accounts[0];
  assert.ok(createdAt && updatedAt);
  // When the token came in and when it is expected to run out: the moment is the account's own
  // fact, and the estimate is that moment plus what the executor declares (native-login.md §2).
  assert.ok(credentialAt && !Number.isNaN(Date.parse(credentialAt)));
  assert.equal(expectedExpiryAt, expectedExpiry(credentialAt, claudeAdapter.credentialLifetimeDays));
  assert.deepEqual(account, {
    id: 't1', name: 't1', executor: 'claude', credential: 'missing', signed_in: true, can_route: true, tiers: { execute: claudeTier('/tiers/execute.json') },
    permission_mode: null, timeout_ms: 60_000, max_runs: null, provider: null,
    // Nothing has run on it yet: no rest, no usage, and the Runs the ledger counts.
    status: { active_runs: 0, max_runs: null, rest: null, usage: [] },
    // And this service has no model catalog: the account shows no list rather than a
    // made-up one. tests/models.test.ts asks the real one.
    models: { list: [], at: null, refreshing: false },
    // No machines: an account names none, its token goes to whichever is picked.
    queued_tasks: 2,
  });
});

test('POST creates a named account and PUT changes it by id; a refusal is a 400 with the reason', async (t) => {
  const { f, send } = await consoleApp(t);
  const body = { executor: 'codex', tiers: { execute: codexTier('m') }, permission_mode: null, timeout_ms: 120_000 };
  const bare = await send('POST', '/api/accounts', { ...body, name: 'c1' });
  assert.equal(bare.status, 400);
  assert.equal((await json(bare)).error, NO_CREDENTIAL_TEXT);
  const created = await send('POST', '/api/accounts', { ...body, name: 'c1', credential: 'token-c1' });
  assert.equal(created.status, 201);
  const made = await json(created);
  const id = made.account.id;
  assert.equal(made.created, true);
  assert.notEqual(id, 'c1');
  assert.deepEqual([made.account.name, made.account.executor, made.account.credential, made.account.timeout_ms], ['c1', 'codex', 'set', 120_000]);
  assert.equal('machines' in made.account, false);
  assert.equal(JSON.stringify(made).includes('token-c1'), false, '令牌只进不出');
  const changed = await send('PUT', `/api/accounts/${id}`, { ...body, timeout_ms: 60_000 });
  assert.equal(changed.status, 200);
  assert.equal((await json(changed)).created, false);
  assert.equal(f.ledger.getAccount(id)!.timeoutMs, 60_000);
  const rows = f.peek<{ action: string; actor: string }>(`SELECT action, actor FROM change WHERE action LIKE 'account.%' AND json_extract(detail_json, '$.account_id') = ? ORDER BY seq`, id);
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ action: 'account.create', actor: 'console' }, { action: 'account.update', actor: 'console' }]);

  // No name at all is fine: the ledger names it from the executor's identity — the fallback
  // here, since this host read no identity — and the answer carries what it ended up with
  // (docs/design/native-login.md §2).
  const unnamed = await send('POST', '/api/accounts', { ...body, credential: 'k' });
  assert.equal(unnamed.status, 201);
  assert.equal((await json(unnamed)).account.name, 'codex 账号');
  const second = await send('POST', '/api/accounts', { ...body, credential: 'k' });
  assert.equal((await json(second)).account.name, 'codex 账号 2');
  // A new account is never refused for a name already held: it is numbered. A rename still is.
  const numbered = await send('POST', '/api/accounts', { ...body, name: 'c1', credential: 'k' });
  assert.equal(numbered.status, 201);
  assert.equal((await json(numbered)).account.name, 'c1 2');
  const clash = await send('PUT', `/api/accounts/${id}`, { ...body, name: 'c1 2' });
  assert.equal(clash.status, 400);
  assert.match((await json(clash)).error, /重名/);

  const listed = await send('POST', '/api/accounts', { ...body, name: 'c2', credential: 'k', machines: ['h1'] });
  assert.equal(listed.status, 400);
  assert.match((await json(listed)).error, /没有 machines 这一项/, '账号不再有机器清单，旧字段名照样拒');
  // A Codex account is an API key, which tycho keeps like any account's login.
  const codex = await send('POST', '/api/accounts', { name: 'codex-key', executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m\n' } }, credential: 'sk-codex-k' });
  assert.equal(codex.status, 201);
  assert.equal(JSON.stringify(await json(codex)).includes('sk-codex-k'), false);
  const typo = await send('POST', '/api/accounts', { ...body, name: 'c2', credential: 'k', host: 'box-1' });
  assert.equal(typo.status, 400);
  assert.match((await json(typo)).error, /没有 host 这一项/, '写错名字的字段不被悄悄丢掉');
  assert.equal((await send('PUT', '/api/accounts/a%2Fb', { ...body, credential: 'k' })).status, 400);
  assert.equal((await send('PUT', '/api/accounts/%E0%A4%A', { ...body, credential: 'k' })).status, 400);
  assert.equal(f.ledger.getAccount('c2'), undefined);
  const named = await send('POST', '/api/accounts', { ...body, name: '集群 x', credential: 'k' });
  assert.equal(named.status, 201, '名字中间的普通空格可以');
  assert.equal((await json(named)).account.name, '集群 x');
  // What the owner typed is trimmed where it enters, so an edge space never reaches the rule.
  const edged = await send('POST', '/api/accounts', { ...body, name: ' 集群 y ', credential: 'k' });
  assert.equal(edged.status, 201, '首尾空格在入口去掉');
  assert.equal((await json(edged)).account.name, '集群 y');
  assert.equal((await send('POST', '/api/accounts', { ...body, name: '集群-x', credential: 'k' })).status, 201);
  assert.ok(f.ledger.listAccounts().some(({ name }) => name === '集群-x'));
  // There is no clearing a token: the route is gone.
  assert.equal((await send('DELETE', '/api/accounts/c1/credential')).status, 404);
});

test('DELETE asks before it leaves work without a account, and deletes once told to', async (t) => {
  const { f, send } = await consoleApp(t);
  f.ledger.markRunRunning(f.ledger.createRun(f.queuedTask().id, { ...RUN, machine: f.ledger.getMachine('h1')!, login: f.ledger.getAccount('t1')! }, USER).id);
  const asked = await send('DELETE', '/api/accounts/t1');
  assert.equal(asked.status, 409);
  const answer = await json(asked);
  assert.equal(answer.needs_confirm, true);
  assert.deepEqual([answer.queued_tasks, answer.active_runs], [0, 1]);
  assert.match(answer.error, /确认要删就再点一次/);
  assert.ok(f.ledger.getAccount('t1'));
  const done = await send('DELETE', '/api/accounts/t1?confirm=1');
  assert.equal(done.status, 200);
  assert.deepEqual(await json(done), { deleted: true, projects: [] });
  assert.equal(f.ledger.getAccount('t1'), undefined);
  assert.equal((await send('DELETE', '/api/accounts/t1?confirm=1')).status, 400);
  f.ledger.putAccount({ ...T1, id: 'idle', name: 'idle' }, USER, 'ref-idle');
  assert.equal((await send('DELETE', '/api/accounts/idle')).status, 200, '没有活的目标一次就删');
});

test('the overview lists the projects whose effective pool of logins is empty, from the ledger\'s own derivation', async (t) => {
  const { f, get } = await consoleApp(t);
  const t1 = f.ledger.getAccount('t1')!.id;
  const empty = f.ledger.createProject({ name: '还没选' }, USER);
  const chosen = f.ledger.createProject({ name: '只剩它', logins: [t1] }, USER);
  const noLogin = async (): Promise<{ id: string; name: string; reason: string }[]> =>
    ((await json(await get('/api/overview'))) as { no_login: { id: string; name: string; reason: string }[] }).no_login;
  // A project that never chose a login is the same case as one whose only login is gone.
  assert.deepEqual(await noLogin(), [{ id: empty, name: '还没选', reason: '项目 还没选 选用的登录里一个可用的登录都没有（项目页“登录”）' }]);
  // The account it allows is deleted: the project stops being able to run anything, and the
  // page says so without asking a page's own words. The fixture's own project runs on every
  // login and still has the machine's own one: it is not listed.
  f.ledger.deleteAccount(t1, USER, { confirmed: true });
  const after = await noLogin();
  assert.deepEqual(after.map(({ name }) => name), ['还没选', '只剩它']);
  assert.equal(after[1]!.id, chosen);
  assert.match(after[1]!.reason, /选用的登录里一个可用的登录都没有/);
  assert.ok(!after.some(({ id }) => id === f.projectId));
  // Archived is put away, so it asks for no login; paused is only resting, so it still does.
  f.ledger.setProjectArchived(empty, true, USER);
  f.ledger.setProjectPaused(chosen, true, USER);
  assert.deepEqual((await noLogin()).map(({ id }) => id), [chosen]);
});

test('without a login nothing is shown or changed, and from another site nothing is changed', async (t) => {
  const { f, url, cookie, get, send, post } = await consoleApp(t);
  const body = { executor: 'claude', tiers: { execute: { kind: 'content', text: '{"model":"m"}' } }, credential: 'k' };
  const anonymous = { Origin: url };
  assert.equal((await get('/api/accounts', anonymous)).status, 401);
  assert.equal((await send('PUT', '/api/accounts/x', body, anonymous)).status, 401);
  assert.equal((await send('DELETE', '/api/accounts/t1', undefined, anonymous)).status, 401);
  assert.equal((await post('/api/accounts/t1/check', {}, anonymous)).status, 401);
  const elsewhere = { Cookie: cookie, Origin: 'http://elsewhere.test' };
  assert.equal((await send('PUT', '/api/accounts/x', body, elsewhere)).status, 403);
  assert.equal((await send('DELETE', '/api/accounts/t1', undefined, elsewhere)).status, 403);
  assert.equal((await post('/api/accounts/t1/check', {}, elsewhere)).status, 403);
  assert.equal(f.ledger.getAccount('x'), undefined);
  assert.ok(f.ledger.getAccount('t1'));
});

test('a change is answered 503 while an inventory runs or the ledger cannot be written, and reading still works', async (t) => {
  const barrier = { recovering: false };
  const crash = { armed: false };
  const f = fixture(t, {
    recovery: { recovering: () => barrier.recovering },
    testHooks: { beforeCommit: () => { if (crash.armed) throw Object.assign(new Error('disk I/O error'), { errcode: 10 }); } },
  });
  const { send, get, post } = await consoleApp(t, { f, runner: { check: async () => ({ machine_id: 'h1', host: 'h1', reachable: true, version: '1', logged_in: null }) } });
  const body = { executor: 'claude', tiers: { execute: { kind: 'content', text: '{"model":"m"}' } }, timeout_ms: 120_000 };
  barrier.recovering = true;
  for (const answer of [await send('PUT', '/api/accounts/t1', body), await send('DELETE', '/api/accounts/t1')]) {
    assert.equal(answer.status, 503);
    assert.match((await json(answer)).error, /恢复清点/);
  }
  assert.equal((await get('/api/accounts')).status, 200, '读不受影响');
  assert.equal((await post('/api/accounts/t1/check')).status, 200, '测试连接什么都不改，不用等');
  barrier.recovering = false;
  crash.armed = true;
  assert.equal((await send('PUT', '/api/accounts/t1', body)).status, 503);
  crash.armed = false;
  const degraded = await send('PUT', '/api/accounts/t1', body);
  assert.equal(degraded.status, 503);
  assert.match((await json(degraded)).error, /降级模式/);
  assert.equal(f.ledger.getAccount('x'), undefined);
});

// --- the connection test ---

function runnerOn(t: TestContext, login: Login, machineIds: readonly string[], checkTimeoutMs = 2000, answer?: (machineId: string) => Promise<ExecutorsAnswer>) {
  const f = fixture(t);
  const remote = fakeRemote();
  const asked: string[] = [];
  const report = (executor: string, fields: Partial<NodeExecutorStatus> = {}): NodeExecutorReport =>
    ({ at: '2026-11-10T00:00:00.000Z', executors: [{ executor, installed: true, version: '2.1.312 (Claude Code)', logged_in: true, ...fields }] });
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter, codex: codexAdapter }, logins: memoryLogins({ [login.id]: login }),
    machines: memoryMachines(Object.fromEntries(machineIds.map(id => [id, testMachine(id)]))),
    connect: remote.connect, checkTimeoutMs, log: () => {},
    credential: (id) => (id === login.id && login.machine === undefined ? { ref: 'ref', value: 'token' } : undefined),
    // Each machine's client looks at itself again and answers (nodes.md §1.2).
    executors: (machineId) => {
      asked.push(machineId);
      return answer?.(machineId) ?? Promise.resolve({ connected: true, report: report(login.executor), fresh: true });
    },
  });
  return { f, remote, runner, asked, report };
}

// accounts-machines-decoupled "控制台": the first machine that answers is asked, once; one
// that does not answer is passed over, and the rest are not asked at all.
test('a connection test of an account asks one machine that answers, and that machine\'s client says what it has', async (t) => {
  const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/t.json') } };
  const { remote, runner, asked } = runnerOn(t, account, ['h1', 'h2', 'h3']);
  remote.down.add('h1');
  const result = await runner.check(account);
  // An account runs on its own token: the machine's own sign-in says nothing about it.
  assert.deepEqual(result, { machine_id: 'h2', host: 'h2', reachable: true, version: '2.1.312 (Claude Code)', logged_in: null });
  assert.deepEqual(asked, ['h2'], '只问一台，h3 没被问');
  const none = runnerOn(t, account, ['h1']);
  none.remote.down.add('h1');
  assert.equal(await none.runner.check(account), null, '没有应答的机器就不问');
});

test('a machine\'s own login is asked on its own machine, and a machine without the executor says so in its own words', async (t) => {
  const own = machineLogin('h1', 'codex', { tiers: { execute: codexTier('execute') } });
  let installed = false;
  const { runner, asked, report } = runnerOn(t, own, ['h1', 'h2'], 2000, async () => ({
    connected: true, fresh: true,
    report: installed ? report('codex', { version: 'codex-cli 0.162.0', logged_in: false }) : report('codex', { installed: false, version: null, logged_in: null, error: '找不到 codex：查过 PATH' }),
  }));
  const machine = await runner.check(own);
  assert.deepEqual([machine!.machine_id, machine!.reachable, machine!.version, machine!.logged_in], ['h1', true, null, null]);
  assert.equal(machine!.error, '找不到 codex：查过 PATH');
  installed = true;
  assert.deepEqual(await runner.check(own), { machine_id: 'h1', host: 'h1', reachable: true, version: 'codex-cli 0.162.0', logged_in: false });
  assert.deepEqual(asked, ['h1', 'h1'], '机器自己的登录只问它那台机器');
});

test('a connection test only asks: nothing is run, uploaded or written, on the machine or in the ledger', async (t) => {
  const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/t.json') } };
  const { f, remote, runner } = runnerOn(t, account, ['h1', 'h2']);
  f.runningRun();
  const before = f.dump();
  await runner.check(account);
  // The probe that picks the machine reads, the check asks the client: neither writes.
  assert.deepEqual([...new Set(remote.calls.map(({ script }) => script))].sort(), ['read']);
  assert.deepEqual(f.dump(), before);
});

test('a machine that never answers costs the test its short limit and the other machines nothing', async (t) => {
  const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/t.json') } };
  const { runner } = runnerOn(t, account, ['h1'], 150, () => new Promise<ExecutorsAnswer>(() => {}));
  const started = performance.now();
  const machine = await runner.check(account);
  assert.ok(performance.now() - started < 2000, '不等机器，等的是时限');
  assert.deepEqual(machine, { machine_id: 'h1', host: 'h1', reachable: false, version: null, logged_in: null, error: '0.15 秒内没有回答' });
});

test('a machine that cannot be asked now shows what it last said, and says so', async (t) => {
  const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/t.json') } };
  const { runner, report } = runnerOn(t, account, ['h1'], 2000, async () => ({ connected: false, fresh: false, report: report('claude'), problem: '机器现在没连回来' }));
  const machine = await runner.check(account);
  assert.equal(machine!.reachable, false);
  assert.equal(machine!.version, '2.1.312 (Claude Code)');
  assert.equal(machine!.error, '机器现在没连回来；下面是它上次报的');
});

test('the transport is told the same short limit, and what the Runner has learned shows in its facts about machines', async (t) => {
  const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/t.json') } };
  const f = fixture(t);
  const remote = fakeRemote();
  const limits: (number | undefined)[] = [];
  const machines = memoryMachines(Object.fromEntries(['h1', 'h2', 'h3'].map(id => [id, testMachine(id)])), f.ledger);
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: memoryLogins({ t1: account }), machines, checkTimeoutMs: 700, log: () => {},
    connect: (given, opts) => { limits.push(opts?.timeoutMs); return remote.connect(given); },
    executors: async () => ({ connected: true, fresh: true, report: null }),
  });
  f.ledger.putAccount(account, USER, 'ref-t1');
  const run = f.ledger.createRun(f.queuedTask().id, { ...RUN, machine: f.ledger.getMachine('h1')!, login: account }, USER);
  assert.deepEqual(runner.machines(), [
    { login_id: 't1', machine_id: 'h1', host: 'h1', up: null, last_ok_at: null, active_runs: 1 },
    { login_id: 't1', machine_id: 'h2', host: 'h2', up: null, last_ok_at: null, active_runs: 0 },
    { login_id: 't1', machine_id: 'h3', host: 'h3', up: null, last_ok_at: null, active_runs: 0 },
  ]);
  remote.down.add('h2');
  const before = Date.now();
  // Two machines' own logins: each asks its own machine, and what is learned is the machine's.
  for (const machine of ['h1', 'h2']) await runner.check(machineLogin(machine, 'claude', { tiers: account.tiers }));
  // The probe that picks the machine and the check itself both have the short limit.
  assert.deepEqual(limits.filter((each) => each !== undefined).every((each) => each === 700), true);
  const [h1, h2, h3] = runner.machines();
  assert.equal(h1!.up, true);
  assert.ok(Date.parse(h1!.last_ok_at!) >= before - 5 && Date.parse(h1!.last_ok_at!) <= Date.now() + 5);
  assert.deepEqual([h2!.up, h2!.last_ok_at], [false, null]);
  assert.deepEqual([h3!.up, h3!.last_ok_at], [null, null], '没问过的机器不猜');
  assert.equal(run.host, 'h1');
});

test('POST /api/accounts/<id>/check answers with what the Runner found, and for an unknown account with a 400', async (t) => {
  const seen: string[] = [];
  const found = { machine_id: 'h1', host: 'h1', reachable: true, version: '2.1.312', logged_in: true };
  const { f, post, get } = await consoleApp(t, { runner: { check: async (account) => { seen.push(account.id); return found; } } });
  const before = f.dump();
  const answer = await post('/api/accounts/t1/check');
  assert.equal(answer.status, 200);
  assert.deepEqual(await json(answer), { account_id: 't1', machine: found, models: { list: [], at: null, refreshing: false } });
  assert.deepEqual(seen, ['t1']);
  const unknown = await post('/api/accounts/nope/check');
  assert.equal(unknown.status, 400);
  assert.match((await json(unknown)).error, /账号不存在：nope/);
  assert.deepEqual(f.dump(), before);
});

// The two moments the owner asks for a fresh list: the connection test waits for it, and a
// save does not — saving must not sit on a machine that does not answer. A query that
// fails is said beside the machines' own answers, and changes nothing else.
test('a connection test asks for the models too, and a save asks without waiting for the answer', async (t) => {
  const asked: string[] = [];
  const waiting = Promise.withResolvers<void>();
  const models = {
    state: (id: string) => ({ list: [{ id: `<${id} 的模型>` }], at: '2026-11-06T00:00:00.000Z', refreshing: false }),
    reschedule: () => {},
    refresh: async (account: { id: string }) => {
      asked.push(account.id);
      await waiting.promise;
      return { ok: false as const, reason: '机器连不上' };
    },
  };
  const { post, send, get } = await consoleApp(t, { runner: { check: async () => null }, models });
  const checked = post('/api/accounts/t1/check');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked, ['t1'], '连接测试等这次查询');
  waiting.resolve();
  const answer = await json(await checked);
  assert.deepEqual(answer.models, { list: [{ id: '<t1 的模型>' }], at: '2026-11-06T00:00:00.000Z', refreshing: false });
  assert.equal(answer.models_failure, '机器连不上', '问不到就如实说，列表还用上次读到的');

  // A save answers without the query: its answer is on its way while the query is not.
  waiting.resolve();
  const saved = await send('PUT', '/api/accounts/t1', { executor: 'claude', tiers: { execute: { kind: 'content', text: '{"model":"m"}' } } });
  assert.equal(saved.status, 200);
  assert.equal((await json(saved)).account.models.list.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(asked, ['t1', 't1'], '保存也问了一次，只是不等它');
  assert.equal((await json(await get('/api/accounts'))).accounts[0].models.at, '2026-11-06T00:00:00.000Z');
});

// --- with the dispatcher and the Runner, in a whole service ---

const put = (client: Awaited<ReturnType<typeof signIn>>, path: string, method: string, body?: unknown): Promise<Response> =>
  fetch(`${client.base}${path}`, {
    method,
    headers: { Cookie: client.cookie, Origin: client.base, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test('an account just made takes work at once on a machine it never named, its token fetched by that machine', options, async (t) => {
  const { start, remote } = stage(t, {});
  const service = await start();
  const client = await signIn(service);
  assert.deepEqual((await json(await client.get('/api/accounts'))).accounts, []);
  // A machine comes in by joining; the console cannot add one.
  assert.equal((await put(client, '/api/machines/m1', 'PUT', { note: '新机器' })).status, 400);
  holdMachine(service.ledger, testMachine('m1'));
  const tiers = { execute: { kind: 'content' as const, text: '{"model":"m"}' } };
  // Made the way the login window makes one: a Claude login is not typed into a form.
  const { account: { id } } = service.accounts.put({ name: 'fresh', executor: 'claude', tiers, credential: 'fresh-token' }, USER);
  assert.notEqual(id, 'fresh');
  const project = service.ledger.createProject({ name: '试跑', logins: [id] }, USER);
  const task = service.ledger.createTask({ projectId: project, title: '新目标上的任务', goal: '目标', acceptance: '验收', loginId: id, roleId: 'implement' }, USER);
  service.ledger.queueTask(task.id, USER);
  const run = await until(() => service.ledger.listRuns(task.id).at(-1), '在新目标上派发');
  assert.deepEqual([run.login_id, run.login_name, run.host], [id, 'fresh', 'm1']);
  await until(() => remote.called('start.sh', run.id, 'm1') > 0, '在新机器上启动');
  // The command names where the Worker reads the token from, and never the token: the
  // machine fetches it over its own channel (nodes.md §9).
  const started = remote.calls.find(({ script, runId }) => script === 'start.sh' && runId === run.id)!;
  assert.equal(started.args![2], 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.ok(!started.args!.some((arg) => arg.includes('fresh-token')));
});

test('a machine taken off the project\'s list ends its Run as "machine removed", and the Task goes on by itself on what is left', options, async (t) => {
  const { start, remote, launched, runsOf } = stage(t, { t1: T1 }, ['h1', 'h2']);
  const service = await start({}, { credentials: { t1: 'token-t1' } });
  const client = await signIn(service);
  const project = service.ledger.createProject({ name: '试跑', logins: ['t1'], machines: uidsOf(service.ledger, ['h1']) }, USER);
  const task = service.ledger.createTask({ projectId: project, title: '任务', goal: '目标', acceptance: '测试通过', roleId: 'implement' }, USER);
  service.ledger.queueTask(task.id, USER);
  const first = await launched(service, task);
  assert.equal(first.host, 'h1');
  const changed = await put(client, `/api/projects/${project}`, 'PUT', { logins: ['t1'], machines: uidsOf(service.ledger, ['h2']) });
  assert.equal(changed.status, 200);
  const lost = await until(() => service.ledger.getRun(first.id).state === 'ended' && service.ledger.getRun(first.id), '旧执行被判定不在');
  assert.equal(lost.exit_kind, 'lost');
  assert.equal(JSON.parse(lost.error_json!).lost.basis, 'removed');
  const next = await until(() => runsOf(service, task).length === 2 && runsOf(service, task)[1], '自动接续');
  assert.equal(next.host, 'h2');
  await until(() => remote.called('start.sh', next.id, 'h2') > 0, '在剩下的机器上启动');
});

test('a skill file left in the data directory reaches no round, and the setting that pointed elsewhere is gone', options, async (t) => {
  const { start, dataDir, queued, launched, snapshotOf } = stage(t);
  const service = await start();
  const client = await signIn(service);
  mkdirSync(join(dataDir, 'skills', '试跑'), { recursive: true });
  writeFileSync(join(dataDir, 'skills', '试跑', 'default-place.md'), '默认目录里的');
  const first = await launched(service, queued(service, '第一件'));
  assert.equal(snapshotOf(first).skills, undefined);
  assert.equal(snapshotOf(first).brief.includes('默认目录里的'), false, '只有账本里的技能条目进这一轮');
  assert.notEqual((await put(client, '/api/settings/skills.dir', 'PUT', { value: dataDir })).status, 200);
});

test('deleting a account under a queued Task needs the confirmation, and the Task then stops with the reason', options, async (t) => {
  const { start, queued } = stage(t, { t1: T1 }, ['h1']);
  const service = await start({ dispatchIntervalMs: 60_000 }, { credentials: { t1: 'token-t1' } });
  const client = await signIn(service);
  service.ledger.setPause(true, USER);
  const task = queued(service);
  const asked = await put(client, '/api/accounts/t1', 'DELETE');
  assert.equal(asked.status, 409);
  assert.equal((await json(asked)).queued_tasks, 1);
  assert.equal((await put(client, '/api/accounts/t1?confirm=1', 'DELETE')).status, 200);
  service.ledger.setPause(false, USER);
  await service.stop();
  const again = await start();
  await until(() => again.ledger.getTask(task.id).state === 'held', '没有目标的任务停住');
  assert.match(again.ledger.getTask(task.id).reason!, /没有可用的登录：指定的登录已删除，请重新选择/);
  assert.deepEqual(again.accounts.list(), [], '重启不会把删掉的目标带回来');
});

test('a connection test through the whole service reaches one machine that answers and changes nothing', options, async (t) => {
  const { start, remote, dataDir } = stage(t, { t1: T1 }, ['h1', 'h2']);
  const service = await start({ dispatchIntervalMs: 60_000, checkTimeoutMs: 1500 }, { credentials: { t1: 'token-t1' } });
  const client = await signIn(service);
  remote.down.add('h1');
  const changes = (): number => {
    const conn = new DatabaseSync(join(dataDir, 'ledger.db'), { readOnly: true });
    try {
      return (conn.prepare('SELECT count(*) AS n FROM change').get() as { n: number }).n;
    } finally {
      conn.close();
    }
  };
  const before = changes();
  const answer = await json(await client.post('/api/accounts/t1/check'));
  // h2 answers; its stand-in has no client to look at itself, which the answer says.
  assert.deepEqual([answer.machine.host, answer.machine.reachable], ['h2', false]);
  assert.match(answer.machine.error, /下面是它上次报的/);
  assert.equal(changes(), before);
});


test('an account ceiling is positive and optional, and empty means unlimited', () => {
  assert.equal(checkAccount({ ...VALID, maxRuns: 2 }, EXECUTORS).maxRuns, 2);
  for (const value of [undefined, null, '']) assert.equal(checkAccount({ ...VALID, maxRuns: value }, EXECUTORS).maxRuns, undefined);
  for (const value of [0, -1, 1.5, '2']) assert.match(refusal({ ...VALID, maxRuns: value }), /同时最多几轮执行应为正整数/);
});


for (const operation of ['create', 'update', 'delete'] as const) {
  for (const committed of [false, true]) {
    test('account '+operation+' crash '+(committed ? 'after' : 'before')+' commit keeps configuration, state and audit atomic', (t) => {
      class AccountCrash extends Error {}
      let armed = false;
      const action = 'account.'+operation;
      const f = fixture(t, { testHooks: {
        beforeCommit(actions) { if (armed && !committed && actions.includes(action)) throw new AccountCrash(); },
        afterCommit(actions, retire) { if (armed && committed && actions.includes(action)) { retire(); throw new AccountCrash(); } },
      } }, false);
      const { accounts } = setup(t, f);
      const id = operation === 'create' ? undefined : accounts.put({ ...MADE, name: 't1' }, USER).account.id;
      if (operation === 'delete') f.ledger.noteUsage(id!, [{ window: 'session', used: 42, resetsAt: null }]);
      const before = f.dump();
      armed = true;
      assert.throws(() => operation === 'delete' ? accounts.remove(id!, USER) : accounts.put({ ...MADE, maxRuns: 2, name: 't1', ...(id === undefined ? {} : { id }) }, USER), AccountCrash);
      armed = false;
      const reopened = f.open();
      if (!committed) assert.deepEqual(f.dump(), before);
      else {
        const account = reopened.listAccounts().find(({ name }) => name === 't1');
        assert.equal(account?.maxRuns, operation === 'delete' ? undefined : 2);
        assert.equal(f.peek<{ n: number }>('SELECT count(*) AS n FROM change WHERE action = ?', action)[0]!.n, 1);
        if (operation === 'delete') assert.deepEqual(f.peek('SELECT * FROM login_state'), []);
        // Committed with its token: the account never stands without one.
        if (operation !== 'delete') assert.notEqual(reopened.accountCredentialRef(account!.id), null);
      }
    });
  }
}

test('connection fields and retired target routes are rejected instead of becoming another configuration source', async (t) => {
  const { send, get } = await consoleApp(t);
  for (const field of ['hosts', 'ssh_config', 'machines']) {
    const response = await send('POST', '/api/accounts', { name: 'new', executor: 'claude', tiers: { execute: { kind: 'content', text: '{"model":"m"}' } }, credential: 'k', [field]: field === 'ssh_config' ? '' : ['h1'] });
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, new RegExp('没有 '+field+' 这一项'));
  }
  assert.equal((await get('/api/targets')).status, 404);
});
