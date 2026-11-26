// Guards against the console writing anything about a machine but its note — its name,
// hostname and identity are its client's (docs/design/nodes.md §5.4) — stale stores,
// unaudited edits, deleting live machines without confirmation, partial writes at a crash,
// HTTP changes crossing authentication or recovery barriers, and a deleted machine living on
// in what projects allow: a machine that joins later under its name inheriting a project's
// permission to run there, or a project left allowed nowhere reading as allowed anywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfirmationRequired, InputError } from '../service/errors.ts';
import { createMachines } from '../service/machines.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, holdMachine, testMachine, USER, uidsOf, machineNamesOf } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();
class Crash extends Error {}

test('machine stores read the ledger on every use; a note is the one thing written, and clears when empty', (t) => {
  const f = fixture(t, {}, false);
  const store = createMachines({ ledger: f.ledger });
  const other = createMachines({ ledger: f.ledger });
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('constructor'), undefined);
  holdMachine(f.ledger, testMachine('m1', 'worker-1'));
  const first = other.get('m1')!;
  assert.deepEqual([first.id, first.host, first.note], ['m1', 'worker-1', undefined]);
  assert.equal(store.setNote('m1', ' 主力 ', USER).note, '主力');
  assert.equal(other.get('m1')!.note, '主力');
  assert.equal(other.get('m1')!.created_at, first.created_at);
  assert.equal(store.setNote('m1', '', USER).note, undefined);
  assert.throws(() => store.setNote('m1', 7, USER), /备注应为文字/);
  assert.throws(() => store.setNote('m1', '长'.repeat(201), USER), /备注最多 200 个字/);
  assert.throws(() => store.setNote('gone', '备注', USER), /机器不存在：gone/);
  holdMachine(f.ledger, testMachine('m2', 'worker-3'));
  assert.deepEqual(other.list().map(({ id }) => id), ['m1', 'm2']);
  store.remove('m1', USER);
  assert.deepEqual(other.list().map(({ id }) => id), ['m2']);
  assert.throws(() => store.remove('m1', USER), /机器不存在：m1/);
});

test('a note change has one audit row; an unchanged save or refused value writes nothing', (t) => {
  const f = fixture(t, {}, false);
  const store = createMachines({ ledger: f.ledger });
  holdMachine(f.ledger, testMachine('m1', 'worker-1'));
  store.setNote('m1', '备机', { actor: 'console' });
  const before = f.dump();
  store.setNote('m1', '备机', { actor: 'console' });
  assert.throws(() => store.setNote('m1', 7, USER), InputError);
  assert.deepEqual(f.dump(), before);
  store.remove('m1', { actor: 'console' });
  const changes = f.peek<{ action: string; actor: string; detail_json: string }>("SELECT action, actor, detail_json FROM change WHERE action IN ('machine.update', 'machine.delete') ORDER BY seq");
  assert.deepEqual(changes.map(({ action, actor, detail_json }) => ({ action, actor, detail: JSON.parse(detail_json) })), [
    { action: 'machine.update', actor: 'console', detail: { machine_id: 'm1', changed: { note: { from: null, to: '备机' } } } },
    { action: 'machine.delete', actor: 'console', detail: { machine_id: 'm1', machine: { host: 'worker-1', node_id: 'node-m1' }, active_runs: 0 } },
  ]);
});

test('deleting a live machine requires confirmation, then keeps the Run evidence and account configuration for reconciliation', (t) => {
  const f = fixture(t);
  const store = createMachines({ ledger: f.ledger });
  const { run } = f.runningRun();
  const before = f.dump();
  assert.throws(() => store.remove('h1', USER), (error: Error) => error instanceof ConfirmationRequired && error.detail.active_runs === 1 && /机器被移除/.test(error.message));
  assert.deepEqual(f.dump(), before);
  store.remove('h1', USER, { confirmed: true });
  assert.equal(store.get('h1'), undefined);
  // The machine's own logins go with it: a machine of this name joining later is another one.
  assert.equal(f.ledger.getMachineLogin('h1', 'claude'), undefined);
  assert.equal(f.run(run.id).state, 'running');
  assert.equal(f.run(run.id).machine_id, 'h1');
});

// The failure this guards: the owner deletes a machine a project allowed, and a machine that
// joins later under the same name is let run that project's work as if it were the old one.
test('a deleted machine leaves what projects allow: one joining later under its name is not in any of them', (t) => {
  const f = fixture(t);
  const store = createMachines({ ledger: f.ledger });
  holdMachine(f.ledger, testMachine('h2'));
  const ownLogin = f.ledger.getMachineLogin('h1', 'claude')!.id;
  const only = f.ledger.createProject({ name: '只在 h1', logins: [ownLogin, 't9'], machines: uidsOf(f.ledger, ['h1']) }, USER);
  const both = f.ledger.createProject({ name: 'h1 和 h2', machines: uidsOf(f.ledger, ['h1', 'h2']) }, USER);
  store.remove('h1', USER, { confirmed: true });
  // The project that named only h1 allows no machine now — not any machine.
  assert.deepEqual(machineNamesOf(f.ledger, only), { names: [], gone: 1 });
  const range = f.ledger.machineRange({ project_id: only, knowledge_json: null });
  assert.ok('conflict' in range && /允许的机器都已经删掉了/.test(range.conflict), JSON.stringify(range));
  assert.deepEqual(machineNamesOf(f.ledger, both), { names: ['h2'], gone: 1 });
  // The machine's own logins are out of every project's list.
  assert.deepEqual(JSON.parse(f.ledger.getProject(only).logins_json), ['t9']);
  // In the timeline, for each project it was in.
  const said = f.peek<{ detail_json: string }>("SELECT detail_json FROM change WHERE action = 'project.update' ORDER BY seq").map(({ detail_json }) => JSON.parse(detail_json));
  assert.deepEqual(said.map(({ project_id, machine_deleted, machines_left }) => [project_id, machine_deleted, machines_left]), [[only, 'h1', []], [both, 'h1', ['h2']]]);
  assert.deepEqual(said[0].logins, { from: [ownLogin, 't9'], to: ['t9'] });

  // A machine joining under the same name is another one: no project allows it.
  holdMachine(f.ledger, testMachine('h1', 'h1', 'another-client'));
  assert.deepEqual(machineNamesOf(f.ledger, only), { names: [], gone: 1 });
  assert.deepEqual(machineNamesOf(f.ledger, both), { names: ['h2'], gone: 1 });
  // Saving the list again clears what it held for deleted machines.
  f.ledger.setProjectMachines(both, uidsOf(f.ledger, ['h2', 'h1']), USER);
  assert.deepEqual(machineNamesOf(f.ledger, both), { names: ['h2', 'h1'], gone: 0 });
});

for (const operation of ['update', 'delete'] as const) {
  for (const committed of [false, true]) {
    test('machine '+operation+' crash '+(committed ? 'after' : 'before')+' commit keeps the object and audit atomic', (t) => {
      let armed = false;
      const action = 'machine.'+operation;
      const f = fixture(t, { testHooks: {
        beforeCommit(actions) { if (armed && !committed && actions.includes(action)) throw new Crash(); },
        afterCommit(actions, retire) { if (armed && committed && actions.includes(action)) { retire(); throw new Crash(); } },
      } }, false);
      const store = createMachines({ ledger: f.ledger });
      holdMachine(f.ledger, testMachine('m1', 'worker-1'));
      const before = f.dump();
      armed = true;
      assert.throws(() => operation === 'delete' ? store.remove('m1', USER) : store.setNote('m1', '新备注', USER), Crash);
      armed = false;
      const reopened = f.open();
      if (!committed) assert.deepEqual(f.dump(), before);
      else {
        assert.equal(reopened.getMachine('m1')?.note, operation === 'delete' ? undefined : '新备注');
        assert.equal(f.peek<{ n: number }>("SELECT count(*) AS n FROM change WHERE action = ?", action)[0]!.n, 1);
      }
    });
  }
}

test('machine HTTP: the note is the one field written; a name or hostname is refused, and nothing is created', async (t) => {
  const { f, send, get } = await consoleApp(t);
  const noted = await send('PUT', '/api/machines/h1', { note: '主力' });
  assert.equal(noted.status, 200);
  assert.deepEqual([(await json(noted)).machine.id, (await json(await get('/api/machines'))).machines.find((machine: any) => machine.id === 'h1').note], ['h1', '主力']);
  for (const key of ['host', 'id']) {
    const refused = await send('PUT', '/api/machines/h1', { [key]: 'other' });
    assert.equal(refused.status, 400);
    assert.match((await json(refused)).error, /机器名和主机名由机器上的客户端报上来，改不了/);
  }
  const typo = await send('PUT', '/api/machines/h1', { ssh_config: '' });
  assert.match((await json(typo)).error, /机器没有 ssh_config 这一项/);
  assert.equal((await send('PUT', '/api/machines/new', { note: 'x' })).status, 400, '机器只能自己接入，这里建不了');
  assert.equal(f.ledger.getMachine('new'), undefined);
  assert.equal((await send('PUT', '/api/machines/%E0%A4%A', { note: 'x' })).status, 400);
  const rows = f.peek<{ actor: string }>("SELECT actor FROM change WHERE action = 'machine.update' AND json_extract(detail_json, '$.machine_id') = 'h1'");
  assert.deepEqual(rows.map(({ actor }) => actor), ['console']);
});

test('machine HTTP deletion confirms live Runs; connection checks only read and return the machine identity', async (t) => {
  const found = { machine_id: 'h1', host: 'h1', reachable: true };
  const seen: string[] = [];
  const { f, send, post } = await consoleApp(t, { runner: { checkMachine: async (machine) => { seen.push(machine.id); return found; } } });
  f.runningRun();
  const before = f.dump();
  const check = await post('/api/machines/h1/check');
  assert.equal(check.status, 200);
  assert.deepEqual(await json(check), found);
  assert.deepEqual(seen, ['h1']);
  assert.deepEqual(f.dump(), before);
  assert.equal((await post('/api/machines/gone/check')).status, 400);
  const asked = await send('DELETE', '/api/machines/h1');
  assert.equal(asked.status, 409);
  assert.equal((await json(asked)).active_runs, 1);
  assert.equal((await send('DELETE', '/api/machines/h1?confirm=1')).status, 200);
});

test('machine HTTP routes require a login and matching Origin for writes and checks', async (t) => {
  const { f, get, send, post, url, cookie } = await consoleApp(t);
  const before = f.dump();
  const anonymous = { Origin: url };
  assert.equal((await get('/api/machines', anonymous)).status, 401);
  assert.equal((await send('PUT', '/api/machines/h1', { note: 'x' }, anonymous)).status, 401);
  assert.equal((await send('DELETE', '/api/machines/h1', undefined, anonymous)).status, 401);
  assert.equal((await post('/api/machines/h1/check', {}, anonymous)).status, 401);
  const foreign = { Cookie: cookie, Origin: 'http://elsewhere.test' };
  assert.equal((await send('PUT', '/api/machines/h1', { note: 'x' }, foreign)).status, 403);
  assert.equal((await send('DELETE', '/api/machines/h1', undefined, foreign)).status, 403);
  assert.equal((await post('/api/machines/h1/check', {}, foreign)).status, 403);
  assert.deepEqual(f.dump(), before);
});

test('machine writes wait for recovery and stop on a write failure while reads and connection checks remain available', async (t) => {
  let recovering = false;
  let fail = false;
  const f = fixture(t, { recovery: { recovering: () => recovering }, testHooks: {
    beforeCommit() { if (fail) throw Object.assign(new Error('disk I/O error'), { errcode: 10 }); },
  } });
  const { get, send, post } = await consoleApp(t, { f });
  recovering = true;
  assert.equal((await send('PUT', '/api/machines/h1', { note: 'x' })).status, 503);
  assert.equal((await send('DELETE', '/api/machines/h1')).status, 503);
  assert.equal((await get('/api/machines')).status, 200);
  assert.equal((await post('/api/machines/h1/check')).status, 200);
  recovering = false;
  fail = true;
  assert.equal((await send('PUT', '/api/machines/h1', { note: 'x' })).status, 503);
  fail = false;
  const degraded = await send('PUT', '/api/machines/h1', { note: 'x' });
  assert.equal(degraded.status, 503);
  assert.match((await json(degraded)).error, /降级模式/);
  assert.equal(f.ledger.getMachine('h1')!.note, undefined);
});
