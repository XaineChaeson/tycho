// Guards a machine's own login that its executor refused under a round (review of 11-09,
// P2): the round read as a plain failure that stops the Task for the owner, while the login
// went on taking other work on the strength of a report read before the refusal; and the way
// back missing — the machine saying, from a probe made after the refusal, that the executor is
// signed in again. A report probed before the refusal is no way back, and nothing else is one.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodes } from '../service/nodes.ts';
import { fixture, NODES_TUNED } from './helpers.ts';

test('a machine that came back by itself brings its login back with a report probed after the refusal, not one probed before', (t) => {
  const f = fixture(t);
  const ID = f.ledger.getMachineLogin('h1', 'claude')!.id;
  const nodes = createNodes({ ...NODES_TUNED, ledger: f.ledger, log: () => {} });
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null, { kind: 'auth' });
  const failedAt = f.ledger.loginState(ID).auth_failed_at!;
  const report = (at: number, loggedIn: boolean | null) => ({
    at: new Date(Date.parse(failedAt) + at).toISOString(),
    executors: [{ executor: 'claude', installed: true, version: '2.1.0', logged_in: loggedIn }],
  });
  const facts = { node_id: 'node-h1', name: 'h1', platform: 'linux', hostname: 'h1' };
  const said = (executors: unknown): void => {
    const held = new AbortController();
    held.abort();
    void nodes.poll('h1', { runs: [], facts, executors }, held.signal);
  };
  said(report(-1000, true));
  assert.ok(f.ledger.loginState(ID).auth_failed_at !== null, '失败之前探的报告不算数');
  said(report(1000, null));
  assert.ok(f.ledger.loginState(ID).auth_failed_at !== null, '说不清登没登录，不算重新登录');
  said(report(1000, true));
  assert.equal(f.ledger.loginState(ID).auth_failed_at, null, '失败之后探到已登录，这份登录又能接活');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'login.signed_in_again'`).length, 1, '时间线上记了一条');
});

test('the owner’s "try now" ends a rest and leaves a refusal standing: only the machine’s own report brings it back', (t) => {
  const f = fixture(t);
  const ID = f.ledger.getMachineLogin('h1', 'claude')!.id;
  const { run } = f.runningRun();
  f.ledger.settleRun(run.id, 1, null, { kind: 'auth' });
  const failedAt = f.ledger.loginState(ID).auth_failed_at;
  assert.ok(failedAt !== null);
  f.ledger.endRest(ID, { actor: 'console' });
  assert.equal(f.ledger.loginState(ID).auth_failed_at, failedAt);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'login.rest_end'`).length, 0, '没有歇着就没有可结束的，什么都不写');
});
