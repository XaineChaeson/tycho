// Guards the account form boundary: machine IDs stay ordered and an empty choice stays
// unrestricted; machine connection configuration never leaks into an account write;
// optional limits retain the service's units and validation responsibility; a permission
// mode is sent only when the chosen executor's own command takes it; and — since a tier is
// either the executor's own text or a place on the machine — a form keeps which one it is
// and the text itself, byte for byte, so that saving another field cannot turn content
// into a path. Also: a machine missing a ref tier's file is not shown as a passed check.
//
// And the tier form itself: a new account opens on the three fixed rows, always all and in
// their one order, a blank one being an account that does not take that tier; a name the
// system no longer uses, or content whose model is missing or whose text its executor's
// shape cannot read, is refused beside that row rather than saved; a reference names a
// place on the machine and is not asked for a model; and what the form offers for a model
// and a strength is what that account's executor reported, with a model outside it marked
// rather than rejected — an alias the executor still takes is not a mistake.
import { expect, test } from 'vitest';
import type { TierFormSpec } from '@shared/tier-form.ts';
import { modelText, tierText } from '@shared/labels.ts';
import {
  accountBody, loginSettingsBody, blankTier, checkFine, checkLine, defaultEffortOf, effortChoices, effortUnsupported, formOf, modelChoices, modelMissing, modelsFor,
  modelsLine, newAccountForm, tierEditorOf, tierRefusal, tierRowsOf,
} from './accounts.ts';
import type { Account, AccountModels } from './types.ts';

const CLAUDE_MODES = ['bypassPermissions', 'acceptEdits', 'default', 'plan'];
const DSH_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
// What the service hands over for each executor, from the adapters' own declarations.
const TIER_FORMS: Record<string, TierFormSpec> = {
  claude: { format: 'settings-json', fields: ['model', 'effort'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { format: 'key-value-lines', fields: ['model', 'effort'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  dsh: { format: 'patch-list', fields: ['provider', 'model', 'effort'], efforts: ['low', 'medium', 'high', 'max'] },
};

test('an account names no machines: it runs wherever its executor is, and machine identity stays with machines', () => {
  const form = formOf({ executor: 'claude', tiers: { execute: { kind: 'content', text: '{"model":"m"}' } }, timeout_ms: 90_000, max_runs: 2 });
  const body = accountBody(form);
  expect(body).not.toHaveProperty('machines');
  expect(body.timeout_ms).toBe(90_000);
  expect(body.max_runs).toBe(2);
  expect(body).not.toHaveProperty('hosts');
});

test('blank optional values stay unset, and an existing account sends no token unless one was typed', () => {
  expect(accountBody(formOf({ executor: 'claude' }))).toEqual({ name: '', executor: 'claude', tiers: {}, permission_mode: null, timeout_ms: null, max_runs: null });
  expect(accountBody({ ...formOf({ executor: 'claude' }), credential: 'tok' })).toMatchObject({ credential: 'tok' });
});

test("a machine's own login sends only what tycho adds to it: no executor, directory, token or name", () => {
  const body = loginSettingsBody({ ...formOf({ executor: 'codex', tiers: { decide: { kind: 'content', text: 'model = "x"' } }, max_runs: 1 }), credential: 'never' });
  expect(Object.keys(body).sort()).toEqual(['max_runs', 'permission_mode', 'tiers', 'timeout_ms']);
  expect(body.max_runs).toBe(1);
});

test("values the service must refuse reach it intact, and a permission mode its executor does not take is not sent (codex and dsh are machines' own logins)", () => {
  const form = { ...formOf({ executor: 'codex' }), tiers: [{ name: 'plain', value: 'x' }], timeout: 'abc', max_runs: '两个', permission_mode: 'plan' };
  expect(loginSettingsBody(form)).toMatchObject({ tiers: { plain: { kind: 'content', text: 'x' } }, timeout_ms: 'abc', max_runs: '两个', permission_mode: null });
  // What the executor does take goes as it stands, whichever executor it is.
  expect(loginSettingsBody({ ...form, executor: 'claude' }, CLAUDE_MODES).permission_mode).toBe('plan');
  expect(loginSettingsBody({ ...form, executor: 'dsh', permission_mode: 'workspace-write' }, DSH_MODES).permission_mode).toBe('workspace-write');
  // A mode picked before the executor changed is dropped, not sent to be refused.
  expect(loginSettingsBody({ ...form, executor: 'dsh' }, DSH_MODES).permission_mode).toBeNull();
});

test('checks distinguish machine names that share a hostname', () => {
  expect(checkLine({ machine_id: 'worker@second', host: 'worker', reachable: true })).toBe('worker@second（worker）：连得上');
});

// The tier box is where content was lost: the page read an object as a string, and the
// next save wrote a file reference named "[object Object]" in its place.
test('a tier keeps its text through the form, byte for byte', () => {
  const text = '{\n  "model": "<模型名>",\n  "effortLevel": "high"\n}\n';
  const account = {
    executor: 'claude',
    // One of the names, and a name the ledger still keeps from an older layout: the
    // fixed rows come first either way, the missing ones as blank rows.
    tiers: { execute: { kind: 'content' as const, text }, plain: { kind: 'content' as const, text: 'old' } },
  };
  const form = formOf(account);
  expect(form.tiers).toEqual([
    { name: 'operate', value: '', held: false },
    { name: 'execute', value: text, held: true },
    { name: 'decide', value: '', held: false },
    { name: 'plain', value: 'old', held: true },
  ]);
  expect(accountBody(form).tiers).toEqual({
    execute: { kind: 'content', text },
    plain: { kind: 'content', text: 'old' },
  });
});

// A dsh login the host adopted starts as empty tier values: empty text means "run on the
// machine's own configuration", so a save must keep them, not send an empty map (which the
// service refuses, and which would leave the owner unable to edit such a login at all).
test('a login that holds a tier with an empty text keeps that tier when it is saved', () => {
  const form = formOf({ executor: 'dsh', tiers: { decide: { kind: 'content' as const, text: '' }, execute: { kind: 'content' as const, text: '' } } });
  expect(form.tiers.map(({ held }) => held)).toEqual([false, true, true]);
  expect(loginSettingsBody(form).tiers).toEqual({
    decide: { kind: 'content', text: '' },
    execute: { kind: 'content', text: '' },
  });
  // A row the login does not hold, still blank, is not a tier: clearing one it did hold drops it.
  const cleared = formOf({ executor: 'claude', tiers: { execute: { kind: 'content' as const, text: 'model=x\n' } } });
  expect(loginSettingsBody({ ...cleared, tiers: cleared.tiers.map((row) => ({ ...row, value: '', held: row.value.trim() === '' ? row.held : false })) }).tiers).toEqual({});
});

test('saving another field leaves a tier exactly as it was', () => {
  const text = 'model=<模型名>\nmodel_reasoning_effort=high\n';
  const form = { ...formOf({ executor: 'codex', tiers: { execute: { kind: 'content' as const, text } } }), max_runs: '2' };
  expect(loginSettingsBody(form).tiers, '只改并发上限，内容一个字节不动').toEqual({ execute: { kind: 'content', text } });
});

test('a connection test line says what the machine answered, and a signed-out login is not a pass', () => {
  const answer = { machine_id: 'h', host: 'h', reachable: true, version: '0.163.0', logged_in: true };
  expect(checkLine(answer)).toBe('h：连得上 · 0.163.0 · 已登录');
  expect(checkFine(answer)).toBe(true);
  expect(checkFine({ ...answer, logged_in: false })).toBe(false);
});

test('a new account opens on the fixed tiers, all blank, with the model left to the owner', () => {
  const form = newAccountForm('claude');
  expect(form.executor).toBe('claude');
  expect(form.tiers).toEqual([
    { name: 'operate', value: '', held: false },
    { name: 'execute', value: '', held: false },
    { name: 'decide', value: '', held: false },
  ]);
  expect(form.tiers.every(blankTier)).toBe(true);
});

test('a text its shape cannot read is refused beside that row; a model left out is the executor\'s default', () => {
  const claude = tierEditorOf(TIER_FORMS, 'claude')!;
  expect([...claude.fields]).toEqual(['model', 'effort']);
  expect([...tierEditorOf(TIER_FORMS, 'dsh')!.fields]).toEqual(['provider', 'model', 'effort']);
  // A blank row is not a fault: it is an account that does not take that tier.
  expect(tierRefusal([{ name: 'decide', value: '' }], claude)).toBeNull();
  expect(tierRefusal([{ name: 'decide', value: '{"model":' }], claude)).toEqual({ at: 0, message: tierText.unreadable });
  expect(tierRefusal([{ name: 'decide', value: '{"model":"<模型名>"}' }], claude)).toBeNull();
  // Content the form filled in without a model: the executor's own default, which is how a
  // login adopted from a machine's report starts. Not a fault.
  expect(tierRefusal([{ name: 'decide', value: '{"effortLevel":"high"}' }], claude)).toBeNull();
  expect(tierRefusal([
    { name: 'decide', value: '{"model":"<模型名>"}' },
    { name: 'execute', value: '{"effortLevel":"low"}' },
  ], claude)).toBeNull();

  // An executor that declares no form is its raw text only, and nothing is known to check.
  expect(tierRefusal([{ name: 'decide', value: 'whatever' }], undefined)).toBeNull();
  // A name the system no longer uses cannot be saved, and is refused on its own row.
  expect(tierRefusal([{ name: 'plain', value: 'x' }], claude)).toEqual({ at: 0, message: `${tierText.stale}：${tierText.staleNote}` });
  // Two rows of one name would keep the last of them: about the list, not one row. The form
  // cannot make them (the tier names are fixed), so this guards the boundary itself.
  expect(tierRefusal([
    { name: 'decide', value: '{"model":"<模型甲>"}' },
    { name: 'decide', value: '{"model":"<模型乙>"}' },
  ], claude)).toEqual({ at: null, message: '第 2 个档位和第 1 个都叫 decide：档位名不能重复' });
  // What is wrong with the list itself is not beside any one row.
  expect(tierRefusal([{ name: ' ', value: '' }], claude)?.at).toBeNull();
  expect(tierRefusal([{ name: ' ', value: '' }], claude)?.message).toMatch(/第 1 个档位没有名字/);
});

// The rows the form holds: the three names always there, in their one order, each a blank row
// when the account does not provide it, and then whatever names the ledger still keeps from
// an older layout, in the order the account holds them. A blank row is one that says nothing.
test('the form always draws the three tiers first, blank when the account does not provide them', () => {
  expect(tierRowsOf({
    plain: { kind: 'content', text: 'model=<旧>\n' },
    execute: { kind: 'content', text: 'model=<模型乙>\n' },
    decide: { kind: 'content', text: 'model=<模型甲>\n' },
  })).toEqual([
    { name: 'operate', value: '', held: false },
    { name: 'execute', value: 'model=<模型乙>\n', held: true },
    { name: 'decide', value: 'model=<模型甲>\n', held: true },
    { name: 'plain', value: 'model=<旧>\n', held: true },
  ]);
  expect(tierRowsOf(undefined)).toEqual([
    { name: 'operate', value: '', held: false },
    { name: 'execute', value: '', held: false },
    { name: 'decide', value: '', held: false },
  ]);
  expect(blankTier({ name: 'decide', value: '  ' })).toBe(true);
  expect(blankTier({ name: 'decide', value: 'model=<模型名>\n' })).toBe(false);

});

test('what the form offers for a model and a strength follows the account\'s own list', () => {
  const models: AccountModels = {
    at: '2026-11-06T00:00:00.000Z',
    refreshing: false,
    list: [
      { id: '<模型甲>', name: '<模型甲>', efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: '<模型乙>', efforts: ['medium'] },
      { id: '<隐藏的>', hidden: true },
      { id: '<没说强度的>' },
    ],
  };
  expect(tierEditorOf(TIER_FORMS, '没有这个执行器')).toBeUndefined();
  expect(tierEditorOf({ odd: { format: '没有这个形状', fields: ['model'], efforts: [] } }, 'odd')).toBeUndefined();

  // The models to choose from: what the executor listed, with what it hides left out.
  expect(modelChoices(models)).toEqual(['<模型甲>', '<模型乙>', '<没说强度的>']);
  expect(modelChoices(undefined)).toEqual([]);
  expect(modelChoices({ list: [], at: null, refreshing: false })).toEqual([]);

  // A model the list does not have is marked; a list never read says nothing about it, an
  // empty model is not a model that went away, and a hidden model is still one the executor
  // reports — the form does not offer it, but a tier using it is not out of date.
  expect(modelMissing(models, '<模型甲>')).toBe(false);
  expect(modelMissing(models, '<别名>')).toBe(true);
  expect(modelMissing(models, '<隐藏的>')).toBe(false);
  expect(modelMissing(models, '')).toBe(false);
  expect(modelMissing(undefined, '<别名>')).toBe(false);
  expect(modelMissing({ list: [], at: null, refreshing: false }, '<别名>')).toBe(false);

  // The strengths follow the model: its own entry when it has one (including explicit `[]` for
  // non-reasoning models — never falling back to hardcoded executor defaults), the executor's own
  // declaration when the list says nothing, and the declaration again for a model the list
  // does not have.
  const modelsWithNonReasoning: AccountModels = {
    ...models,
    list: [...models.list, { id: '<非推理模型>', efforts: [] }],
  };
  expect(effortChoices(modelsWithNonReasoning, '<模型甲>', ['low', 'max'])).toEqual(['low', 'high']);
  expect(effortChoices(modelsWithNonReasoning, '<非推理模型>', ['low', 'max'])).toEqual([]);
  expect(effortUnsupported(modelsWithNonReasoning, '<非推理模型>')).toBe(true);
  expect(effortUnsupported(modelsWithNonReasoning, '<模型甲>')).toBe(false);
  expect(effortChoices(models, '<没说强度的>', ['low', 'max'])).toEqual(['low', 'max']);
  expect(effortChoices(models, '<别名>', ['low', 'max'])).toEqual(['low', 'max']);
  expect(effortChoices(undefined, '<模型甲>', ['low', 'max'])).toEqual(['low', 'max']);
  expect(defaultEffortOf(models, '<模型甲>')).toBe('high');
  expect(defaultEffortOf(models, '<模型乙>')).toBeUndefined();

  // The account's card says how many and when they were read, never that an old list is
  // this moment's.
  expect(modelsLine(undefined)).toContain(modelText.notRead);
  expect(modelsLine({ list: [], at: null, refreshing: false })).toContain(modelText.notRead);
  expect(modelsLine(models, Date.parse('2026-11-06T01:00:00.000Z'))).toMatch(/^3 个，最后读到 [^\n（）]+$/);
  expect(modelsLine({ ...models, refreshing: true })).toMatch(new RegExp(`^${modelText.refreshing}`));
});

// The list belongs to the executor it came from: a form switched to another executor is
// about another account, and nothing of this one's list applies to it.
test('a model list is offered only while the form is still about that account\'s executor', () => {
  const models: AccountModels = { list: [{ id: '<模型甲>' }], at: '2026-11-06T00:00:00.000Z', refreshing: false };
  const account = { id: 'a', executor: 'claude', models } as unknown as Account;
  expect(modelsFor(account, 'claude')).toBe(models);
  expect(modelsFor(account, 'codex')).toBeUndefined();
  expect(modelsFor(undefined, 'claude')).toBeUndefined();
});
