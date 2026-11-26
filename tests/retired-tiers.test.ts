// Guards against a tier a login holds in a shape no round can be given any more — the name of a
// file or a profile on the machine, which programs before content-only tiers wrote — being
// dropped in silence: the login reading as one that simply has no such tier, its card saying it
// is usable, the self-check saying nothing, and a Task pinned to it held with "no such tier".
// What it was, why it does not work and where to fill it in again come out of the ledger in one
// place and reach the pages, the self-check and the dispatch refusal in the same words.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { prepareSnapshot } from '../runner/snapshot.ts';
import { doctor } from '../service/doctor.ts';
import { createSettings } from '../service/settings.ts';
import { RETIRED_TIER_STANDING } from '../shared/logins.ts';
import { consoleApp } from './console-helpers.ts';
import { claudeTier, codexTier, fixture, RUN_LIMIT_MS, USER, holdMachine, testMachine } from './helpers.ts';

// A ledger as the owner's is: a machine's own Codex login whose two tiers were profile names,
// and an account whose decide tier was a settings file, beside an execute tier of content.
function setup(t: TestContext) {
  const f = fixture(t);
  holdMachine(f.ledger, testMachine('cluster-1'), USER);
  f.ledger.putMachineLogin({ executor: 'codex', machine: 'cluster-1', tiers: { execute: codexTier('x') } }, USER);
  f.force(`UPDATE machine_login SET tiers_json = ? WHERE machine_id = 'cluster-1'`, JSON.stringify({ execute: { kind: 'ref', value: 'execute' }, decide: { kind: 'ref', value: 'decide' } }));
  f.ledger.putAccount({ id: 'a1', name: 'a1', executor: 'claude', tiers: { execute: claudeTier('m') } }, USER, 'ref-a1');
  f.force(`UPDATE account SET tiers_json = ? WHERE id = 'a1'`, JSON.stringify({ execute: claudeTier('m'), decide: { kind: 'ref', value: '/home/w/.claude/tiers/decide.json' } }));
  return f;
}

test('the ledger reads a stored file name as a retired tier, not as a tier and not as nothing', (t) => {
  const f = setup(t);
  const own = f.ledger.getMachineLogin('cluster-1', 'codex')!;
  assert.deepEqual({ ...own.tiers }, {}, '派发只认内容：这两档都不是档位');
  assert.deepEqual(own.retiredTiers!.map(({ tier, was }) => [tier, was]), [['execute', 'execute'], ['decide', 'decide']]);
  const [first] = own.retiredTiers!;
  assert.match(first!.text, /机器 cluster-1 上的 codex 登录 的执行档原来写的是机器上的文件或 profile「execute」/);
  assert.match(first!.text, /到“机器”页这份登录那里重新填/);
  const account = f.ledger.getAccount('a1')!;
  assert.deepEqual(Object.keys(account.tiers), ['execute'], '内容那一档照常');
  assert.match(account.retiredTiers![0]!.text, /账号 a1 的决策档原来写的是.*「\/home\/w\/\.claude\/tiers\/decide\.json」.*到“账号”页/);
  // A login with nothing retired carries no such list at all.
  assert.equal(f.ledger.getMachineLogin('h1', 'claude')!.retiredTiers, undefined);
});

test('the pages are given the same words, and such a login is never shown as usable', async (t) => {
  const f = setup(t);
  const { get } = await consoleApp(t, { f });
  const machines = await (await get('/api/machines')).json() as { machines: { id: string; logins: { id: string; configured: boolean; retired_tiers?: { tier: string; text: string }[] }[] }[] };
  const own = machines.machines.find(({ id }) => id === 'cluster-1')!.logins.find(({ id }) => id === f.ledger.getMachineLogin('cluster-1', 'codex')!.id)!;
  assert.deepEqual(own.retired_tiers!.map(({ text }) => text), f.ledger.getMachineLogin('cluster-1', 'codex')!.retiredTiers!.map(({ text }) => text));
  const accounts = await (await get('/api/accounts')).json() as { accounts: { id: string; retired_tiers?: { text: string }[] }[] };
  assert.equal(accounts.accounts.find(({ id }) => id === 'a1')!.retired_tiers![0]!.text, f.ledger.getAccount('a1')!.retiredTiers![0]!.text);
  // The card's word for it is one the console takes from shared/, never "可用".
  assert.notEqual(RETIRED_TIER_STANDING, '可用');
});

test('the self-check says it, in the same words, and sends the owner to the page that puts it right', (t) => {
  const f = setup(t);
  const settings = createSettings({ ledger: f.ledger, log: () => {} });
  const logins = [...f.ledger.listAccounts(), ...f.ledger.listMachineLogins()];
  const checks = doctor({ dataDir: f.dir, settings, claude: { path: null, command: null, problem: 'x', login: null } as never, logins, wecomSecretSet: false });
  const own = checks.find(({ id }) => id === `login-retired:${f.ledger.getMachineLogin('cluster-1', 'codex')!.id}`)!;
  assert.equal(own.level, 'warn');
  assert.equal(own.text, f.ledger.getMachineLogin('cluster-1', 'codex')!.retiredTiers!.map(({ text }) => text).join('；'));
  assert.equal(own.fix?.href, '#/machines');
  assert.equal(checks.find(({ id }) => id === 'login-retired:a1')!.fix?.href, '#/accounts');
  assert.equal(checks.some(({ id }) => id === `login-retired:${f.ledger.getMachineLogin('h1', 'claude')!.id}`), false);
});

test('a round on such a tier is refused with what it was and where to fill it in, not "no such tier"', (t) => {
  const f = setup(t);
  const task = f.ledger.createTask({ projectId: f.projectId, title: 't', goal: 'g', roleId: 'implement' }, USER);
  const login = f.ledger.getMachineLogin('cluster-1', 'codex')!;
  assert.throws(
    () => prepareSnapshot(f.ledger.getTask(task.id), login, { claude: claudeAdapter, codex: codexAdapter }, { timeoutMs: RUN_LIMIT_MS }),
    (err: Error) => err.message === login.retiredTiers!.find(({ tier }) => tier === 'execute')!.text,
  );
});
