// Guards the fixed tiers (docs/design/roles-and-tiers.md §2, §8, §10). Against: an account
// saved with a tier name outside them, whatever it is called; a Task's override or the
// Router's own tier naming one; a Task waiting on an answer being resumed past it; the
// Router's own tier being quietly replaced by the executor's default when an older
// layout left a name this version does not use; one old name meaning two values at once
// — an account holding both `cheap` and `execute` — being settled by picking one of them;
// and the operate tier's substitute (an operate round on an account with no operate content
// runs on its execute content) being missing for a pick or a Task, or reaching past where it
// may: an execute round never takes the cheaper operate content, and the decide tier never
// substitutes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { checkAccount, createAccounts } from '../service/accounts.ts';
import { InputError } from '../service/errors.ts';
import { createMachines } from '../service/machines.ts';
import { serviceSettings } from '../service/service-settings.ts';
import { createTools } from '../service/tools.ts';
import { TIER_IDS, tierNamesText, tierValueFrom } from '../shared/tiers.ts';
import { accepting, claudeTier, content, fixture, USER } from './helpers.ts';

const EXECUTORS = { claude: claudeAdapter, codex: codexAdapter, dsh: dshAdapter };

function refusal(act: () => unknown): string {
  try {
    act();
  } catch (err) {
    assert.ok(err instanceof InputError, String(err));
    return err.message;
  }
  return '';
}

// --- what an account may hold ---

test('an account holds the tier names, some or all, and no other name', () => {
  const account = (tiers: unknown) =>
    checkAccount({ executor: 'claude', tiers }, EXECUTORS);
  assert.deepEqual(Object.keys(account({ decide: claudeTier('/d') }).tiers), ['decide'], '只填一个也行');
  assert.deepEqual(Object.keys(account({ operate: claudeTier('/o') }).tiers), ['operate'], '操作档也可以只有它');
  assert.deepEqual(Object.keys(account({ decide: claudeTier('/d'), execute: claudeTier('/e') }).tiers), ['decide', 'execute']);
  assert.deepEqual(Object.keys(account({ operate: claudeTier('/o'), execute: claudeTier('/e'), decide: claudeTier('/d') }).tiers), ['operate', 'execute', 'decide']);
  // A name the system does not use is refused as what it is, whatever it came from: one an
  // older layout left, one the owner invented, or one every object has.
  for (const name of ['cheap', 'strong', 'escalation', 'fast', 'constructor', '__proto__']) {
    assert.equal(
      refusal(() => account({ [name]: claudeTier('/t') })),
      `档位只有${tierNamesText}三个，不能有 ${name}`,
      name,
    );
  }
  assert.equal(refusal(() => account({})), '档位至少要填一个');
});

// The one substitute (roles-and-tiers.md §10.3): an operate round runs on the login's
// execute content when it holds no operate content of its own. Upwards one step only.
test('the operate tier is the only one that substitutes, and only with the login’s execute content', () => {
  const operate = claudeTier('/operate');
  const execute = claudeTier('/execute');
  const decide = claudeTier('/decide');
  assert.deepEqual(tierValueFrom({ operate, execute }, 'operate'), { value: operate, from: 'operate' }, '自己填了就用自己的');
  assert.deepEqual(tierValueFrom({ execute }, 'operate'), { value: execute, from: 'execute' }, '没填操作档，用执行档内容');
  assert.deepEqual(tierValueFrom({ execute }, 'execute'), { value: execute, from: 'execute' });
  assert.deepEqual(tierValueFrom({ decide }, 'decide'), { value: decide, from: 'decide' });
  // Downwards never: an execute round on a login with only operate content waits for one
  // that has execute content.
  assert.equal(tierValueFrom({ operate }, 'execute'), undefined);
  // The top tier never substitutes, and a login that filled in only the decide tier takes no
  // operate work (it has no execute content to stand in).
  assert.equal(tierValueFrom({ execute, operate }, 'decide'), undefined);
  assert.equal(tierValueFrom({ decide }, 'operate'), undefined);
  // A held empty tier runs on the executor's own configuration, including when substituted.
  assert.deepEqual(tierValueFrom({ execute: content('') }, 'operate'), { value: content(''), from: 'execute' });
  assert.deepEqual(tierValueFrom({ operate: content(''), execute }, 'operate'), { value: content(''), from: 'operate' });
  // A name the system no longer uses is not a tier.
  assert.equal(tierValueFrom({ execute }, 'default'), undefined);
});

test('a save through the account store refuses a name outside the tiers and leaves what was there alone', (t) => {
  const f = fixture(t, {}, false);
  const store = createAccounts({ ledger: f.ledger, executors: EXECUTORS, credentialExecutors: ['claude'], dataDir: f.dir, log: () => {} });
  const { account: { id } } = store.put({ name: 'a', executor: 'claude', tiers: { decide: claudeTier('/tiers/decide.json') }, credential: 'token-a' }, USER);
  assert.deepEqual({ ...store.get(id)!.tiers }, { decide: claudeTier('/tiers/decide.json') });
  const before = f.dump();
  assert.match(
    refusal(() => store.put({ id, name: 'a', executor: 'claude', tiers: { escalation: claudeTier('/tiers/e.json') } }, USER)),
    /不能有 escalation/,
  );
  assert.deepEqual(f.dump(), before, '被拒的保存什么都不写');
  assert.deepEqual({ ...store.get(id)!.tiers }, { decide: claudeTier('/tiers/decide.json') });
});

// --- what a Task and the Router may name ---

function toolSetup(t: TestContext) {
  const f = fixture(t, {}, false);
  const projectId = f.ledger.createProject({ name: '项目', logins: ['t1'] }, USER);
  // An account that takes only one of the two: what a Task naming the other is refused by.
  f.ledger.putAccount({ id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } }, USER, 'ref-t1');
  const tools = createTools({
    ledger: f.ledger,
    runner: {
      interrupt: async () => 'ended',
      events: () => [],
      abandon: async (taskId, reason, ctx) => f.ledger.abandonTask(taskId, reason, ctx),
    },
    logins: { get: f.ledger.getAccount, list: f.ledger.listAccounts },
    machines: createMachines({ ledger: f.ledger }),
    accept: accepting(f.ledger),
  });
  const call = async (name: string, args: unknown) => {
    const result = await tools.call(name, args, USER, { projectId });
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  const schema = (name: string): Record<string, any> =>
    tools.list({ projectId }).find((tool) => tool.name === name)!.inputSchema.properties as Record<string, any>;
  const args = { title: '标题', goal: '目标', acceptance: '通过', login_id: 't1', role_id: 'implement' };
  return { f, call, schema, args };
}

test('the Router overrides a Task\'s tier only with one of the names, and the schema says which and what they are for', async (t) => {
  const { f, call, schema, args } = toolSetup(t);
  const override = (tier: string) => ({ tier, reason: '这一个确实不同' });
  for (const name of ['create_task', 'update_task'] as const) {
    const tier = schema(name).tier_override.properties.tier;
    assert.deepEqual(tier.enum, [...TIER_IDS], name);
    assert.match(tier.description, /operate（操作档）/, name);
    assert.match(tier.description, /execute（执行档）/, name);
    assert.match(tier.description, /decide（决策档）/, name);
  }
  // A name outside them never reaches the ledger: the schema is the check.
  for (const tier of ['cheap', 'strong', 'escalation', 'nope']) {
    const refused = await call('create_task', { ...args, tier_override: override(tier) });
    assert.equal(refused.isError, true, tier);
    assert.match(refused.text, /arguments\.tier_override\.tier 只能是 operate、execute、decide/, tier);
  }
  assert.equal(f.count('task'), 0, '被拒的调用什么都不写');
  // A tier the account does not hold and cannot substitute succeeds with an advisory warning.
  const warnOverride = await call('create_task', { ...args, tier_override: override('decide') });
  assert.equal(warnOverride.isError, false, warnOverride.text);
  assert.match(warnOverride.text, /注意：账号 t1 没有档位 decide/);
  const warnRole = await call('create_task', { ...args, role_id: 'analyse' });
  assert.equal(warnRole.isError, false, warnRole.text);
  assert.match(warnRole.text, /注意：账号 t1 没有档位 decide/);
  const made = await call('create_task', args);
  assert.equal(made.isError, false, made.text);
  const taskId = made.text.split('：')[1]!;
  assert.match((await call('update_task', { task_id: taskId, tier_override: override('cheap') })).text, /arguments\.tier_override\.tier 只能是 operate、execute、decide/);
  assert.equal(f.ledger.getTask(taskId).tier, 'execute', '被拒的修改不动原来那个');
  const warnUpdateOverride = await call('update_task', { task_id: taskId, tier_override: override('decide') });
  assert.equal(warnUpdateOverride.isError, false, warnUpdateOverride.text);
  assert.match(warnUpdateOverride.text, /注意：账号 t1 没有档位 decide/);
  assert.equal(f.ledger.getTask(taskId).tier, 'decide');
  const warnUpdateRole = await call('update_task', { task_id: taskId, role_id: 'analyse', tier_override: null });
  assert.equal(warnUpdateRole.isError, false, warnUpdateRole.text);
  assert.match(warnUpdateRole.text, /注意：账号 t1 没有档位 decide/);
  assert.equal(f.ledger.getTask(taskId).tier, 'decide');
  const changed = await call('update_task', { task_id: taskId, tier_override: override('execute') });
  assert.equal(changed.isError, false, changed.text);
  assert.equal(f.ledger.getTask(taskId).tier, 'execute');
  // The operate tier runs on the login's execute content (roles-and-tiers.md §10.3): a verify
  // Task on an account with only execute content is a candidate, not one missing a tier.
  const verify = await call('create_task', { ...args, role_id: 'verify' });
  assert.equal(verify.isError, false, verify.text);
  assert.equal(f.ledger.getTask(verify.text.split('：')[1]!).tier, 'operate');
});

test('a Task waiting on an answer is answered, not resumed', (t) => {
  const f = fixture(t);
  // The question was asked for a reason, and "继续" would throw it away.
  const asked = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '有问题', goal: '目标', acceptance: '通过', loginId: f.login.login.id }, USER);
  f.ledger.queueTask(asked.id, USER);
  f.ledger.openApproval(asked.id, [{ question: '选哪个？' }], USER);
  assert.match(refusal(() => f.ledger.resumeTask(asked.id, USER)), /在等你回答问题/);
  assert.equal(f.task(asked.id).state, 'waiting_person');
});

// --- the Router's own tier ---

test('the Router\'s tier is one of the names, or empty for the executor\'s own default', (t) => {
  const f = fixture(t);
  const settings = () => serviceSettings({ ledger: f.ledger, dataDir: f.dir, log: () => {} });
  for (const id of TIER_IDS) settings().set('router.tier', id, USER);
  assert.equal(settings().get('router.tier'), TIER_IDS.at(-1));
  assert.match(refusal(() => settings().set('router.tier', 'default', USER)), new RegExp(`负责人的档位只能是${tierNamesText}之一`));
  assert.match(refusal(() => settings().set('router.tier', 'cheap', USER)), /只能是/);
  assert.equal(settings().get('router.tier'), TIER_IDS.at(-1), '被拒的值没有写进去');
  settings().set('router.tier', '', USER);
  assert.equal(settings().get('router.tier'), '');
  // A value an older layout left is not accepted by this version and not used either; the
  // Router says why it will not start and the page offers to change or clear it.
  f.force(`UPDATE setting SET value_json = ? WHERE key = 'tunables'`, JSON.stringify({ 'router.tier': 'default' }));
  const reopened = settings();
  assert.equal(reopened.get('router.tier'), 'default', '账本里的值还在，页面才看得到要改什么');
  assert.equal(reopened.list().find(({ key }) => key === 'router.tier')!.overridden, true);
  reopened.reset('router.tier', USER);
  assert.equal(settings().get('router.tier'), '');
});
