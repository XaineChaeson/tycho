// Guards against the ways choosing a account can go wrong: a Task sent to a account that
// is resting after a used-up quota, is at the owner's ceiling, or has no machine that
// answers; the tier’s global order ignored, or the project’s own list taken as that order;
// a preference group or a review’s spread group never tried, a spread group invented before
// another review has made a Run, or either still waited on after every
// login in it has been used up; followed so strictly that the first account queues alone while the next sits idle; the allowance for the first account not being
// the setting's; a account near the end of its quota taking work another could take, or
// refusing work when it is the only one left; a rest or a usage figure that is over
// still keeping a account out; a Task with nowhere to go reported without what it waits
// for or without the earliest time anything comes back; a pinned Task wandering to
// another account or being narrowed by a preference; and a account without the Task's tier,
// or no longer there, counted in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Login } from '../runner/snapshot.ts';
import type { Candidate, Wait } from '../service/pick.ts';
import { candidateLogins, pickLogin, placementGroups, usable } from '../service/pick.ts';
import { claudeTier, codexTier, content, memoryLogins } from './helpers.ts';

const NOW = Date.parse('2026-11-06T01:00:00.000Z');
const LATER = NOW + 60 * 60 * 1000;
const OPTIONS = { now: NOW, lead: 1, warnAt: 0.9 };

const of = (id: string, fields: Partial<Candidate> = {}): Candidate => ({ id, active: 0, ...fields });
const pick = (candidates: Candidate[], options: Partial<typeof OPTIONS> = {}): string | Wait => {
  const answer = pickLogin(candidates, { ...OPTIONS, ...options });
  return 'pick' in answer ? answer.pick : answer.wait;
};

test('the first account in the project order takes the Task when all are idle', () => {
  assert.equal(pick([of('a'), of('b'), of('c')]), 'a');
  assert.equal(pick([of('b'), of('a')]), 'b');
});

test('the first account may run one more than the ones after it, and then it is their turn', () => {
  assert.equal(pick([of('a', { active: 1 }), of('b')]), 'b');
  assert.equal(pick([of('a', { active: 1 }), of('b', { active: 1 })]), 'a');
  assert.equal(pick([of('a', { active: 2 }), of('b', { active: 1 })]), 'b');
  // Against every account after it, not only the next: the idle third is not left out.
  assert.equal(pick([of('a', { active: 1 }), of('b', { active: 1 }), of('c')]), 'c');
  // Several Tasks in a row: first, second, then the first again.
  const counts = { a: 0, b: 0 };
  const given: string[] = [];
  for (let round = 0; round < 5; round += 1) {
    const to = pick([of('a', { active: counts.a }), of('b', { active: counts.b })]) as 'a' | 'b';
    counts[to] += 1;
    given.push(to);
  }
  assert.deepEqual(given, ['a', 'b', 'a', 'b', 'a']);
});

test('the allowance is the setting: a larger one keeps to the first longer, a very large one is strict order', () => {
  assert.equal(pick([of('a', { active: 2 }), of('b')], { lead: 3 }), 'a');
  assert.equal(pick([of('a', { active: 3 }), of('b')], { lead: 3 }), 'b');
  assert.equal(pick([of('a', { active: 500 }), of('b')], { lead: 1_000_000 }), 'a');
});

test('a resting account is passed over until its time, and is a candidate again from then', () => {
  assert.equal(pick([of('a', { restUntil: LATER }), of('b', { active: 4 })]), 'b');
  assert.equal(pick([of('a', { restUntil: NOW }), of('b')]), 'a');
  assert.equal(pick([of('a', { restUntil: NOW - 1 }), of('b')]), 'a');
  assert.equal(usable(of('a', { restUntil: LATER }), NOW), false);
  assert.equal(usable(of('a', { restUntil: LATER }), LATER), true);
});

test('a account at its ceiling takes nothing more, one below it does, and no ceiling is no limit', () => {
  assert.equal(pick([of('a', { active: 2, maxRuns: 2 }), of('b', { active: 9 })]), 'b');
  assert.equal(pick([of('a', { active: 1, maxRuns: 2 }), of('b', { active: 9 })]), 'a');
  assert.equal(pick([of('a', { active: 40 })]), 'a');
});

test('a account with no machine that answers is passed over', () => {
  assert.equal(pick([of('a', { noMachine: true }), of('b')]), 'b');
});

test('a account near the end of its quota is used only when no other can take the Task', () => {
  assert.equal(pick([of('a', { usage: 0.95 }), of('b')]), 'b');
  assert.equal(pick([of('a', { usage: 0.9 }), of('b')]), 'b');
  assert.equal(pick([of('a', { usage: 0.89 }), of('b')]), 'a');
  // Not even to even out the load: the other account can still take it.
  assert.equal(pick([of('a', { active: 3 }), of('b', { usage: 0.99 })]), 'a');
  // The only one left takes it, and several of them keep their order.
  assert.equal(pick([of('a', { usage: 0.95 }), of('b', { restUntil: LATER })]), 'a');
  assert.equal(pick([of('a', { usage: 0.95 }), of('b', { usage: 0.99 })]), 'a');
  assert.equal(pick([of('a', { usage: 0.5 }), of('b')], { warnAt: 0.4 }), 'b');
});

test('with nowhere to go the answer is what the Task waits for and the earliest time anything comes back', () => {
  const soon = NOW + 10 * 60 * 1000;
  assert.deepEqual(pick([of('a', { restUntil: LATER }), of('b', { restUntil: soon }), of('c', { active: 1, maxRuns: 1 }), of('d', { noMachine: true })]), {
    rest: { login: 'b', until: new Date(soon).toISOString() },
    full: ['c'],
    no_machine: ['d'],
  });
  assert.deepEqual(pick([of('a', { active: 2, maxRuns: 2 })]), { rest: null, full: ['a'], no_machine: [] });
  assert.deepEqual(pick([of('a', { noMachine: true })]), { rest: null, full: [], no_machine: ['a'] });
  // A resting account is named as resting, whatever else is true of it.
  assert.deepEqual(pick([of('a', { restUntil: LATER, active: 1, maxRuns: 1, noMachine: true })]), {
    rest: { login: 'a', until: new Date(LATER).toISOString() }, full: [], no_machine: [],
  });
  assert.deepEqual(pick([]), { rest: null, full: [], no_machine: [] });
});

const ACCOUNTS: Record<string, Login> = {
  a: { id: 'a', name: 'a', executor: 'claude', tiers: { execute: claudeTier('/c.json'), decide: claudeTier('/s.json') } },
  b: { id: 'b', name: 'b', executor: 'codex', tiers: { execute: codexTier('execute') } },
  c: { id: 'c', name: 'c', executor: 'codex', tiers: { decide: codexTier('decide'), empty: content('') } },
};

test('a Task that names no account may run on the project accounts that have its tier, in the tier’s global order', () => {
  const store = memoryLogins(ACCOUNTS);
  const ids = (task: { login_id: string | null; tier: string | null }, allowed: string[], order: string[]) =>
    candidateLogins(task, allowed, store, undefined, order).map(({ id }) => id);
  // The order decides, never the project list's own order.
  assert.deepEqual(ids({ login_id: null, tier: 'execute' }, ['b', 'a', 'c'], ['a', 'b', 'c']), ['a', 'b']);
  assert.deepEqual(ids({ login_id: null, tier: 'execute' }, ['c', 'a', 'b'], ['b', 'a', 'c']), ['b', 'a']);
  assert.deepEqual(ids({ login_id: null, tier: 'decide' }, ['b', 'a', 'c'], ['c', 'a', 'b']), ['c', 'a']);
  // The operate tier runs on a login's own execute content when it holds no operate content
  // (roles-and-tiers.md §10.3); a login with only decide content does not take it. A real
  // operate value is never preferred over a substitute: the order alone decides.
  assert.deepEqual(ids({ login_id: null, tier: 'operate' }, ['a', 'b', 'c'], ['c', 'b', 'a']), ['b', 'a']);
  assert.deepEqual(ids({ login_id: null, tier: 'operate' }, ['c'], ['c']), []);
  // Not in the pool, gone from the store, a tier nobody has, no tier at all. An empty text is
  // a tier the login holds: the executor runs on its own configuration (how an adopted dsh
  // login is), and whether its command can be given that text is checked where a round is made.
  assert.deepEqual(ids({ login_id: null, tier: 'execute' }, ['b', 'gone'], ['b', 'gone']), ['b']);
  assert.deepEqual(ids({ login_id: null, tier: 'execute' }, [], ['a', 'b']), []);
  assert.deepEqual(ids({ login_id: null, tier: 'constructor' }, ['a', 'b', 'c'], ['a', 'b', 'c']), []);
  assert.deepEqual(ids({ login_id: null, tier: 'empty' }, ['c'], ['c']), []);
  assert.deepEqual(ids({ login_id: null, tier: null }, ['a'], ['a']), []);
  // An unlisted login is not picked by a list the order does not name.
  assert.deepEqual(ids({ login_id: null, tier: 'execute' }, ['a', 'b'], ['b']), ['b']);
});

test('a Task that names a account is pinned to it: no other is a candidate, and a missing one leaves none', () => {
  const store = memoryLogins(ACCOUNTS);
  const ids = (account: string) => candidateLogins({ login_id: account, tier: 'execute' }, ['a', 'b'], store, undefined, ['b', 'a']).map(({ id }) => id);
  assert.deepEqual(ids('b'), ['b']);
  // As before this step: the pin holds whatever the project's list or the tiers say.
  assert.deepEqual(ids('c'), ['c']);
  assert.deepEqual(ids('gone'), []);
  // Pinned, the operate substitute is not a second tier check: the pin is the choice, and
  // whether its login takes the tier is asked where the Task is made or changed
  // (requireTier) and again when the round's snapshot is prepared (runner/snapshot.ts 的
  // tierValueOf, which names the tier) — so a login with execute content takes an operate
  // pin, and one with only decide content is still the pin, exactly as before this step.
  assert.deepEqual(candidateLogins({ login_id: 'b', tier: 'operate' }, ['a', 'b'], store, undefined, ['b', 'a']).map(({ id }) => id), ['b']);
  assert.deepEqual(candidateLogins({ login_id: 'c', tier: 'operate' }, ['a', 'c'], store, undefined, ['c', 'a']).map(({ id }) => id), ['c']);
});

test('placement strictly follows pinned > spread > order and ignores legacy Router preference', () => {
  const store = memoryLogins(ACCOUNTS);
  const all = candidateLogins({ login_id: null, tier: 'execute' }, ['a', 'b', 'c'], store, undefined, ['a', 'b', 'c']);
  const groups = (task: { login_id: string | null; prefer_json?: string | null; review_of_json?: string | null }, reviewed: string[] = []) =>
    placementGroups(task, all, reviewed).map((group) => [group.placedBy, group.logins.map(({ id }) => id)]);
  const prefer = JSON.stringify({ login_ids: ['b', 'a'], reason: '这类活先找 codex' });
  // Legacy prefer_json never hijacks owner priority order.
  assert.deepEqual(groups({ login_id: null, prefer_json: prefer, review_of_json: null }), [['order', ['a', 'b']]]);
  assert.deepEqual(groups({ login_id: null, prefer_json: JSON.stringify({ login_ids: ['c', 'b'], reason: 'x' }), review_of_json: null }), [['order', ['a', 'b']]]);
  // A second review first looks for an executor that has not reviewed this product.
  assert.deepEqual(groups({ login_id: null, review_of_json: '{"writers":["dsh"]}' }, ['claude']), [['spread', ['b']], ['order', ['a', 'b']]]);
  // The first review has nobody to spread from: the order alone, not a spread group.
  assert.deepEqual(groups({ login_id: null, review_of_json: '{"writers":["dsh"]}' }, []), [['order', ['a', 'b']]]);
  // A pin is its own single group: no preference or spread narrows it.
  assert.deepEqual(placementGroups({ login_id: 'a', prefer_json: prefer, review_of_json: '{"writers":["dsh"]}' }, all, ['claude']).map((group) => group.placedBy), ['pinned']);
});

test('a spread group whose login is at its ceiling falls back to the whole order', () => {
  const spread = pick([of('b', { maxRuns: 0 })]);
  assert.ok(typeof spread === 'object' && 'full' in spread, '分散组跑满时这一组挑不出');
  assert.equal(pick([of('a'), of('b', { maxRuns: 0 })]), 'a', '退回全部候选，不是干等');
});

// A rejected credential cannot recover on a clock or masquerade as a missing machine.
test('rejected tokens are skipped permanently, with replacement named as the wait', () => {
  assert.equal(pick([of('a', { credentialRejected: true }), of('b')]), 'b');
  assert.equal(usable(of('a', { credentialRejected: true }), LATER + 10 ** 12), false);
  assert.deepEqual(pick([of('a', { credentialRejected: true, restUntil: LATER, maxRuns: 0, noMachine: true })]), { rest: null, full: [], no_machine: [], rejected: ['a'] });
});
