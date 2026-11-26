// Guards docs/design/nodes.md §1.1 step 2, "控制台：一个放行入口": one entry takes the six
// digits and says itself whether they name a device logging in or a machine joining.
//
// What this file is here to catch:
//   - a device's code not recognised as a device, or a machine's not as a machine,
//   - a code that names both at once answered by a guess: both must be listed, and the
//     owner's choice must decide that one and leave the other waiting,
//   - a machine approved here that the client cannot collect, or one refused here that
//     still gets written,
//   - an answer for a request that is gone that says less than that,
//   - the old split entries still answering.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createNodes } from '../service/nodes.ts';
import type { JoinDecision, PendingJoinView } from '../service/nodes.ts';
import { SETTINGS } from '../service/settings.ts';
import { joinMissingText } from '../shared/labels.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, NODES_TUNED } from './helpers.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36';
const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'mac-mini-01', platform: 'darwin 24', hostname: 'mac-mini-01.local' };

type Match = { kind: 'device'; code: string; device: string } | ({ kind: 'machine' } & PendingJoinView);

async function setup(t: TestContext, nodes?: NonNullable<Parameters<typeof consoleApp>[1]>['nodes']) {
  const f = fixture(t);
  const hub = createNodes({ ...NODES_TUNED,
    ledger: f.ledger,
    pollHoldMs: () => 30,
    commandTimeoutMs: () => SETTINGS['node.commandTimeoutMs'].default,
    joinTtlMs: () => SETTINGS['node.joinTtlMs'].default,
    gapSlackMs: () => SETTINGS['node.gapSlackMs'].default,
    log: () => {},
  });
  const app = await consoleApp(t, { f, nodes: nodes ?? hub });
  const device = async (): Promise<string> => {
    const response = await fetch(`${app.url}/login/device`, { method: 'POST', headers: { Origin: app.url, 'User-Agent': UA }, redirect: 'manual' });
    const page = await (await fetch(`${app.url}${response.headers.get('location')!}`, { headers: { Cookie: response.headers.getSetCookie().find(line => /Path=\/login\/device/.test(line))!.split(';')[0]! } })).text();
    return /<h1>(\d{6})<\/h1>/.exec(page)![1]!;
  };
  const lookup = async (code: string): Promise<{ status: number; matches: Match[]; error?: string }> => {
    const response = await app.post('/api/admissions/lookup', { code });
    const body = (await response.json()) as { matches?: Match[]; error?: string };
    return { status: response.status, matches: body.matches ?? [], ...(body.error ? { error: body.error } : {}) };
  };
  return { f, app, hub, device, lookup };
}

test('一个入口认出设备登录：说是设备，放行之后那台设备拿到登录', async (t) => {
  const s = await setup(t);
  const code = await s.device();
  const found = await s.lookup(code);
  assert.equal(found.status, 200);
  assert.deepEqual(found.matches.map((match) => match.kind), ['device']);
  assert.equal(found.matches[0]!.kind === 'device' ? found.matches[0]!.device : '', 'Chrome · Windows');
  const approved = await s.app.post('/api/admissions/approve', { kind: 'device', code });
  assert.equal(approved.status, 200);
  assert.deepEqual(await approved.json(), { kind: 'device', device: 'Chrome · Windows', duration_ms: s.app.settings.get('login.sessionDays') * 86_400_000 });
  assert.equal((await s.lookup(code)).status, 404, '放行过的号码不再能查到');
});

test('一个入口认出机器加入：说是机器和它报的名字、系统，放行之后客户端取得到令牌', async (t) => {
  const s = await setup(t);
  const join = s.hub.register(FACTS);
  const found = await s.lookup(join.code);
  assert.equal(found.status, 200);
  assert.equal(found.matches.length, 1);
  const match = found.matches[0]!;
  assert.equal(match.kind, 'machine');
  assert.equal(match.kind === 'machine' ? `${match.name} ${match.platform} ${match.hostname}` : '', 'mac-mini-01 darwin 24 mac-mini-01.local');

  const approved = await s.app.post('/api/admissions/approve', { kind: 'machine', code: join.code });
  assert.equal(approved.status, 200);
  const body = (await approved.json()) as { kind: string; name: string; machine: { id: string } };
  assert.deepEqual([body.kind, body.name, body.machine.id], ['machine', 'mac-mini-01', 'mac-mini-01']);
  assert.equal(s.hub.claim(join.secret).state, 'approved');

  // Pressed again (a second tab, a double click): the request is gone, and said to be.
  const again = await s.app.post('/api/admissions/approve', { kind: 'machine', code: join.code });
  assert.equal(again.status, 404);
  assert.equal(((await again.json()) as { error: string }).error, joinMissingText);
});

test('拒绝一台机器：不写机器，那台机器认领时被告知拒绝', async (t) => {
  const s = await setup(t);
  const join = s.hub.register(FACTS);
  const refused = await s.app.post('/api/admissions/reject', { kind: 'machine', code: join.code });
  assert.equal(refused.status, 200);
  assert.deepEqual(await refused.json(), { kind: 'machine', name: 'mac-mini-01' });
  assert.equal(s.hub.claim(join.secret).state, 'rejected');
  assert.equal(s.f.ledger.listMachines().some((machine) => machine.nodeId === FACTS.node_id), false);
});

test('撞号：同一个六位数既是设备又是机器时两条都列出来，主人选了哪条就只动哪条', async (t) => {
  const decided: { ref: unknown; approve: boolean }[] = [];
  let code = '';
  const join: PendingJoinView = { code: '', name: 'build-02', platform: 'win32 10', hostname: 'build-02', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() };
  // The hub's own numbers are random: this stands in for the moment one of them is the
  // device's, which is what the entry has to handle without guessing.
  const real = createNodes({ ...NODES_TUNED, ledger: fixture(t).ledger, pollHoldMs: () => 30, commandTimeoutMs: () => 1000, joinTtlMs: () => 60_000, gapSlackMs: () => 10_000, log: () => {} });
  const stand = {
    ...real,
    pendingJoins: () => [{ ...join, code }],
    decide: (ref: { code: unknown } | { id: unknown }, approve: boolean): JoinDecision => {
      decided.push({ ref, approve });
      return { state: 'rejected', join: { ...join, code } };
    },
  };
  const s = await setup(t, stand);
  code = await s.device();
  const found = await s.lookup(code);
  assert.equal(found.status, 200);
  assert.deepEqual(found.matches.map((match) => match.kind).sort(), ['device', 'machine']);

  // The owner says it is the machine: the device's request is left as it was.
  assert.equal((await s.app.post('/api/admissions/reject', { kind: 'machine', code })).status, 200);
  assert.deepEqual(decided, [{ ref: { code }, approve: false }]);
  assert.deepEqual((await s.lookup(code)).matches.map((match) => match.kind).sort(), ['device', 'machine'], '设备那条没被动');

  // An answer that does not say which is refused, rather than picking one.
  assert.equal((await s.app.post('/api/admissions/approve', { code })).status, 400);
});

test('没有这个号码：说没有，原来分开的两个入口已经不在了', async (t) => {
  const s = await setup(t);
  const missing = await s.lookup('000000');
  assert.equal(missing.status, 404);
  assert.equal(missing.error, '没有这个号码，或者它已经过期');
  for (const path of ['/api/device-logins/lookup', '/api/node/joins/000000/approve']) {
    assert.equal((await s.app.post(path, { code: '000000' })).status, 404, path);
  }
});
