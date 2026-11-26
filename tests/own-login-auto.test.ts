// Guards a login a machine already holds (docs/design/accounts-machines-decoupled.md): what a
// machine reports signed in becomes that machine's own login without the owner declaring it
// again, with the default tiers its executor's adapter declares; an owner's removal in the same
// registration is not undone by the next report; and the owner's own write creates the login
// where it was not there instead of refusing the save.
//
// What this file is here to catch:
//   - a machine's report of a signed-in executor writing nothing, so the owner has to set up
//     in the console a login the machine already has (the duplication this change is for);
//   - an executor with no command that answers "signed in?" (`logged_in: null`, which is what
//     dsh reports) never being adopted because the report does not say `true`;
//   - the adoption and the dispatcher's own judgment of the same report disagreeing, so a login
//     is written that no round can ever use, or one that could is never written;
//   - a login adopted without its declared default tiers, or with a model name, or with a tier the executor's
//     command cannot be given;
//   - the same report adopted twice (two rows, two audits), or a login already set up being
//     replaced by the default;
//   - a removed login coming back on the machine's next report, or a refusal surviving the
//     sign-in made through tycho, the owner's write, or the machine itself;
//   - the owner's save of a login the machine already has being refused, which leaves the
//     form's values unsaved;
//   - an adopted login that the dispatcher's own rules cannot pick.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { ownLoginTiersOf } from '../adapters/tier.ts';
import { tierValueFrom } from '../shared/tiers.ts';
import type { Tier } from '../adapters/types.ts';
import type { LoginStore } from '../runner/snapshot.ts';
import { candidateLogins } from '../service/pick.ts';
import { createNodes } from '../service/nodes.ts';
import { ownLoginHere } from '../service/readonly.ts';
import type { NodeExecutorStatus } from '../shared/node-protocol.ts';
import { consoleApp } from './console-helpers.ts';
import { content, fixture, holdMachine, NODES_TUNED, testMachine, USER } from './helpers.ts';

type Fixture = ReturnType<typeof fixture>;

// A ledger with one machine of its own and no login: what a machine that just reported
// signed in starts from.
function bare(t: TestContext): Fixture {
  const f = fixture(t, {}, false);
  holdMachine(f.ledger, testMachine('h1'));
  return f;
}

const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'h1', platform: 'linux', hostname: 'h1' };
const AT = '2026-11-11T10:00:00.000Z';

// A machine's report of one executor, and nothing else: what the client says every poll.
const said = (executor: string, loggedIn: boolean | null): NodeExecutorStatus => ({ executor, installed: true, version: '1.0.0', logged_in: loggedIn });

function hub(t: TestContext, f: Fixture) {
  return createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 1, commandTimeoutMs: () => 200, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
}

// One report, as a poll carries it. The poll itself is held for a moment; nothing is asked of it.
async function report(nodes: ReturnType<typeof createNodes>, machineId: string, executors: NodeExecutorStatus[], at = AT): Promise<void> {
  await nodes.poll(machineId, { runs: [], facts: FACTS, executors: { at, executors } });
}

// What the ledger holds for a machine's own login of one executor, if anything.
const own = (f: Fixture, executor: string) => f.ledger.getMachineLogin('h1', executor);

// The store the dispatcher picks from, read through the ledger each time.
const store = (f: Fixture): LoginStore => ({
  get: (id) => {
    const record = f.ledger.getMachineLoginById(id);
    if (!record) return undefined;
    const { created_at: _made, updated_at: _changed, ...login } = record;
    return login;
  },
  list: () => f.ledger.listMachineLogins().map(({ created_at: _made, updated_at: _changed, ...login }) => login),
});

// What the dispatcher sees when a Task of this tier names no login.
const pickable = (f: Fixture, tier: string): string[] =>
  candidateLogins({ login_id: null, tier }, f.ledger.listMachineLogins().map(({ id }) => id), store(f)).map(({ id }) => id);

const declared = (executor: string): Record<string, Tier> => ownLoginTiersOf(ADAPTERS[executor]!)!;

test('机器报告 Claude 已登录：自动建一份带默认档位的登录，能派发，同一份报告只建一次', async (t) => {
  const f = bare(t);
  const nodes = hub(t, f);
  await report(nodes, 'h1', [said('claude', true)]);
  const login = own(f, 'claude');
  assert.ok(login, '机器上登录好的执行器不用主人在控制台再登记一遍');
  assert.deepEqual({ ...login.tiers }, declared('claude'));
  assert.equal(login.tiers.decide!.text, '{\n  "effortLevel": "high"\n}\n', '决策档的强度是高，模型留给机器上的默认');
  assert.equal(login.tiers.execute!.text, '{\n  "effortLevel": "medium"\n}\n', '执行档的强度是中');
  assert.equal(login.tiers.decide!.text.includes('model'), false, '不写模型名');
  assert.deepEqual(pickable(f, 'execute'), [login.id], '派发挑得中');
  // The same report arrives with every poll: one row, one audit.
  await report(nodes, 'h1', [said('claude', true)]);
  await report(nodes, 'h1', [said('claude', true)]);
  assert.equal(f.ledger.listMachineLogins().length, 1);
  const rows = f.peek<{ actor: string; detail_json: string }>(`SELECT actor, detail_json FROM change WHERE action = 'machine_login.create'`).map((row) => ({ ...row }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, 'service', '是服务自己采用的，不是控制台');
  assert.match(rows[0]!.detail_json, /机器报告已登录，自动采用/);
});

test('机器报告 Codex 已登录：默认档位是它自己的键值文本，不是模型名', async (t) => {
  const f = bare(t);
  const nodes = hub(t, f);
  await report(nodes, 'h1', [said('codex', true)]);
  const login = own(f, 'codex');
  assert.ok(login);
  assert.deepEqual({ ...login.tiers }, { decide: content('model_reasoning_effort=high\n'), execute: content('model_reasoning_effort=medium\n') });
  assert.deepEqual(pickable(f, 'decide'), [login.id]);
});

test('机器报告 dsh 已登录：默认档位都是空文本，用机器上 dsh 自己的配置，照样能派发', async (t) => {
  const f = bare(t);
  const nodes = hub(t, f);
  await report(nodes, 'h1', [said('dsh', true)]);
  const login = own(f, 'dsh');
  assert.ok(login);
  assert.deepEqual({ ...login.tiers }, { decide: content(''), execute: content('') }, '写强度会整块换掉它的 config，所以什么都不写');
  assert.deepEqual(pickable(f, 'execute'), [login.id], '空文本也是一档，派发不能当它没有');
  assert.equal(Object.hasOwn(login.tiers, 'operate'), false, '默认只写决策档和执行档');
  assert.deepEqual(pickable(f, 'operate'), [login.id], '操作档用执行档的空文本，照样能派发');
  assert.deepEqual(tierValueFrom(login.tiers, 'operate'), { value: content(''), from: 'execute' });
});

test('机器报告 dsh 装好了、没说登没登录：没有问登录的命令，照样自动建一份，默认档位空文本', async (t) => {
  const f = bare(t);
  const nodes = hub(t, f);
  await report(nodes, 'h1', [said('dsh', null)]);
  const login = own(f, 'dsh');
  assert.ok(login, 'dsh 没有问登录的命令，它的话就是"装好了就能用"，不用主人在控制台再登记一遍');
  assert.deepEqual({ ...login.tiers }, { decide: content(''), execute: content('') }, '写强度会整块换掉它的 config，所以什么都不写');
  assert.deepEqual(pickable(f, 'execute'), [login.id], '空文本也是一档，派发照样挑得中');
});

test('机器报的 unusable 仅作参考，已安装仍自动采用；没装的才不采用', async (t) => {
  const f = bare(t);
  const nodes = hub(t, f);
  await report(nodes, 'h1', [{ executor: 'dsh', installed: false, version: null, logged_in: null }]);
  assert.deepEqual(f.ledger.listMachineLogins(), [], '没装的执行器不建登录');
  await report(nodes, 'h1', [{ executor: 'dsh', installed: true, version: '0.2.1-rc.5', logged_in: null, unusable: '这一版用不了：不认 --permission-mode，升到 0.2.2-rc.1 以上' }]);
  assert.ok(own(f, 'dsh'), 'unusable 仅作参考，已安装照常采用');
});

// The one judgment both the adoption and the dispatcher go by: installed and not logged out.
test('能不能在那台机器上跑只有一处判断：已装且没说没登录（unusable 仅作参考）', () => {
  const at = (over: Partial<NodeExecutorStatus>): NodeExecutorStatus => ({ executor: 'dsh', installed: true, version: '0.2.2', logged_in: null, ...over });
  assert.equal(ownLoginHere(null), false, '机器还没说就不算能用');
  assert.equal(ownLoginHere(at({ installed: false })), false, '机器说没装就不算');
  assert.equal(ownLoginHere(at({})), true, '没说登没登录（没有问登录的命令）按它的话算');
  assert.equal(ownLoginHere(at({ logged_in: true })), true);
  assert.equal(ownLoginHere(at({ logged_in: false })), false, '机器说没登录就不算');
  assert.equal(ownLoginHere(at({ unusable: '这一版用不了：要 0.2.2 以上' })), true, 'unusable 仅作参考，不阻断采用和派发');
});

test('机器说没登录：不建；已有的登录也不被默认值改掉', async (t) => {
  const f = bare(t);
  const nodes = hub(t, f);
  await report(nodes, 'h1', [said('codex', false), said('dsh', false)]);
  assert.deepEqual(f.ledger.listMachineLogins(), [], '说没登录就不是一份登录');
  const mine = content('{"model":"owner-picked"}\n');
  f.ledger.putMachineLogin({ executor: 'claude', machine: 'h1', tiers: { decide: mine, execute: mine } }, USER);
  await report(nodes, 'h1', [said('claude', true)]);
  assert.deepEqual({ ...own(f, 'claude')!.tiers }, { decide: mine, execute: mine }, '自动采用只建不存在的，从不改已有的行');
});

test('主人删了这份登录：机器再怎么报也不加回来；在 tycho 里登录完成后会加回来', async (t) => {
  const f = bare(t);
  const nodes = hub(t, f);
  await report(nodes, 'h1', [said('codex', true)]);
  const first = own(f, 'codex')!;
  f.ledger.deleteMachineLogin('h1', 'codex', USER);
  await report(nodes, 'h1', [said('codex', true)]);
  assert.equal(own(f, 'codex'), undefined, '主人删掉的登录不从机器的报告里自己回来');
  assert.deepEqual(f.peek<{ machine_uid: string; executor: string }>('SELECT machine_uid, executor FROM machine_login_refusal').map((row) => ({ ...row })), [{ machine_uid: f.ledger.getMachine('h1')!.uid, executor: 'codex' }]);
  // What a sign-in made through tycho does when it ends (service/sign-ins.ts).
  f.ledger.clearMachineLoginRefusal('h1', 'codex', { actor: 'machine' });
  await report(nodes, 'h1', [said('codex', true)]);
  const again = own(f, 'codex');
  assert.ok(again);
  assert.notEqual(again.id, first.id, '删后重建是另一份登录，不继承原编号');
});

test('机器删掉时拒用记录一起删：同名重新接入是新登记，不继承', async (t) => {
  const f = bare(t);
  const nodes = hub(t, f);
  await report(nodes, 'h1', [said('codex', true)]);
  f.ledger.deleteMachineLogin('h1', 'codex', USER);
  assert.equal(f.peek('SELECT * FROM machine_login_refusal').length, 1);
  f.ledger.deleteMachine('h1', USER, { confirmed: true });
  assert.deepEqual(f.peek('SELECT * FROM machine_login_refusal'), []);
  assert.deepEqual(f.ledger.listMachineLogins(), []);
  void nodes;
});

// -- the owner's own write ------------------------------------------------------------------

test('PUT 一台机器的登录：没有就建，有就覆盖并回答 created:false；主人的值压过自动采用的默认值', async (t) => {
  const { f, send } = await consoleApp(t);
  const uid = f.ledger.getMachine('h1')!.uid;
  const path = `/api/machines/${uid}/logins/claude`;
  // The fixture's h1/claude is already set up.
  const mine = content('{"model":"owner-picked","effortLevel":"low"}\n');
  const updated = await send('PUT', path, { tiers: { decide: mine }, max_runs: 3 });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json() as { created: boolean }).created, false);
  assert.deepEqual({ ...own(f, 'claude')!.tiers }, { decide: mine });
  assert.equal(own(f, 'claude')!.maxRuns, 3);
  // An executor the machine has reported nothing of yet: the write is its first login.
  const made = await send('PUT', `/api/machines/${uid}/logins/codex`, { tiers: { execute: content('model=x\n') } });
  assert.equal(made.status, 201);
  assert.equal((await made.json() as { created: boolean }).created, true);
  assert.ok(own(f, 'codex'));
  // A dsh login is two empty tiers: the service takes them as written, not as "no tier".
  const dsh = await send('PUT', `/api/machines/${uid}/logins/dsh`, { tiers: { decide: content(''), execute: content('') } });
  assert.equal(dsh.status, 201);
  assert.deepEqual({ ...own(f, 'dsh')!.tiers }, { decide: content(''), execute: content('') });
  assert.ok(pickable(f, 'execute').includes(own(f, 'dsh')!.id), '默认档位空文本，派发照样挑得中');
});

test('主人 PUT 一份删掉的机器登录：拒用记录清掉，以后机器的报告又不用再登记一次', async (t) => {
  const { f, send } = await consoleApp(t);
  const uid = f.ledger.getMachine('h1')!.uid;
  const login = own(f, 'claude')!;
  assert.equal((await send('DELETE', `/api/logins/${login.id}`)).status, 200);
  assert.equal(f.peek('SELECT * FROM machine_login_refusal').length, 1);
  const made = await send('PUT', `/api/machines/${uid}/logins/claude`, { tiers: { execute: content('{"model":"m"}\n') } });
  assert.equal(made.status, 201, '删掉以后没有这一行，这次写就是新建');
  assert.deepEqual(f.peek('SELECT * FROM machine_login_refusal'), [], '主人显式设置就是收回删掉的意思');
  assert.ok(own(f, 'claude'));
});

// The tier texts are declarations in this program, not owner input: they are checked here so
// that a bad declaration fails the suite rather than the first machine that reports signed in.
test('适配器声明的默认档位都过得了它自己的 checkTier', () => {
  for (const executor of ['claude', 'codex', 'dsh', 'gemini']) {
    const adapter = ADAPTERS[executor]!;
    for (const [tier, value] of Object.entries(declared(executor))) {
      assert.equal(adapter.checkTier?.(value), undefined, `${executor} 的 ${tier}`);
    }
  }
});

test('gemini ownLoginTiers renders default effort tiers for decide and execute', async () => {
  const tiers = declared('gemini');
  assert.deepEqual(tiers, {
    decide: { kind: 'content', text: '{\n  "effort": "high"\n}\n' },
    execute: { kind: 'content', text: '{\n  "effort": "medium"\n}\n' },
  });
});
