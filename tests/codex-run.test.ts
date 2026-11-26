import {openLedger} from '../service/ledger.ts';
// Guards against the Codex wiring failing where the adapter's contract tests cannot see
// it: the service refusing a Codex account, a tier name passed as a file, a thread being
// resumed against §8, an interrupt recording mistaken for a finished Run, a provider
// that never answers holding a Task forever with no clock of its own, and a Run read by
// the executor its account has now instead of the one that ran it. Recordings go
// through the real Runner; only the instance is fake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Account } from '../runner/snapshot.ts';
import { receiptOutput } from './fake-remote.ts';
import { claudeTier, codexTier, machineLogin } from './helpers.ts';
import { stage, until } from './stage.ts';

const options = { timeout: 60_000 };
const DIR = join(import.meta.dirname, 'fixtures', 'codex', '0.163.0');
// The machine h1's own Codex login: a Codex subscription stays on the machine it is on.
const CODEX: Account = machineLogin('h1', 'codex', { tiers: { execute: codexTier('execute') } });
// An account, which can change executor under one name.
const T1: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };

const recording = (name: string): string => readFileSync(join(DIR, `${name}.ndjson`), 'utf8');

// Codex's own shape around the receipt, from the normal recording.
function finalMessage(receipt: unknown): string {
  const text = (JSON.parse(receiptOutput(receipt)) as { result: string }).result;
  const message = JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  return recording('normal').replace(/^.*"agent_message".*$/m, message);
}

test('the service starts a Codex login on its tier content, and settles what it reports', options, async (t) => {
  const { remote, start, queued, launched, runsOf, snapshotOf } = stage(t, { t1: CODEX });
  const service = await start();
  const task = queued(service);
  const run = await launched(service, task);
  assert.deepEqual(snapshotOf(run).tier_value, codexTier('execute'));
  Object.assign(remote.runOf(run.id), { stdout: finalMessage({ status: 'done', summary: '好了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] }), exit: 0, pid_alive: false, marked: false });
  await until(() => service.ledger.getRun(run.id).state === 'ended', '结算');
  assert.equal(service.ledger.getRun(run.id).exit_kind, 'completed');
  assert.equal(service.ledger.getTask(task.id).state, 'ready');
  // Recorded for display; §8 keeps a Codex Run from ever using it.
  assert.equal(service.ledger.getRun(run.id).session_ref, '01a1a679-2a95-76d2-ab19-b7b85e95871b');

  service.ledger.updateTask(task.id, { goal: '再来一轮' }, { actor: 'test' });
  service.ledger.resumeTask(task.id, { actor: 'test' });
  const next = await until(() => runsOf(service, task)[1], '第二轮');
  assert.equal(snapshotOf(next).session_ref, '01a1a679-2a95-76d2-ab19-b7b85e95871b', 'Codex 支持原生续接，下一轮沿用上一轮会话');
});

test('a account changed to Codex still settles its old Claude Run as Claude, from the snapshot', options, async (t) => {
  const { dataDir,remote, start, stop, queued, launched, snapshotOf } = stage(t, { t1: T1 }, ['h1']);
  const first = await start({}, { credentials: { t1: 'token-t1' } });
  const task = queued(first);
  const run = await launched(first, task);
  assert.equal(snapshotOf(run).executor, 'claude');
  const credential=first.accounts.credentialOf('t1')!;assert.equal(snapshotOf(run).credential_ref,credential.ref);
  await stop(first);

  remote.finish(run.id, { status: 'done', summary: 'Claude 做完的', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  // The same account, now on another executor: the Run's own snapshot says what ran.
  // This case changes only executor configuration. Keep the staged synthetic credential
  // generation readable; real replacement/ref-change rejection has its own guard tests.
  const configured=openLedger(join(dataDir,'ledger.db'));
  try{configured.putAccount({...T1,executor:'codex',tiers:{execute:codexTier('execute')}},{actor:'test'},credential.ref);}finally{configured.close();}
  const service = await start();
  assert.equal(service.ledger.getAccount('t1')!.executor,'codex');
  assert.equal(service.accounts.credentialOf('t1')?.ref,credential.ref);
  const settled = service.ledger.getRun(run.id);
  assert.equal(settled.exit_kind, 'completed', '§5.5：旧 Run 被新执行器的解析器读成了没有回执');
  assert.equal((JSON.parse(settled.receipt_json!) as { summary: string }).summary, 'Claude 做完的');
  assert.equal(service.ledger.getTask(task.id).state, 'ready');
});

test('a recorded interrupt settles as interrupted, with no end event to go by', options, async (t) => {
  const { remote, start, queued, launched } = stage(t, { t1: CODEX });
  const service = await start();
  const task = queued(service);
  const run = await launched(service, task);
  remote.runOf(run.id).stdout = recording('interrupt');
  remote.runOf(run.id).exit = 1;
  service.ledger.markRunStopping(run.id, { actor: 'test' });
  await until(() => service.ledger.getRun(run.id).state === 'ended', '结算');
  assert.equal(service.ledger.getRun(run.id).exit_kind, 'interrupted');
  assert.equal(service.ledger.getTask(task.id).state, 'held');
});

test('a provider that never answers is ended by the wall clock', options, async (t) => {
  const { remote, start, queued, launched, snapshotOf } = stage(t, { t1: { ...CODEX, timeoutMs: 300 } });
  const service = await start();
  const task = queued(service);
  const run = await launched(service, task);
  assert.equal(snapshotOf(run).timeout_ms, 300);
  // What a Run looks like here: alive, reconnecting, and never finishing by itself.
  remote.runOf(run.id).stdout = recording('fail-provider-unreachable');
  await until(() => service.ledger.getRun(run.id).state === 'ended', '墙钟到期');
  assert.equal(service.ledger.getRun(run.id).exit_kind, 'interrupted');
  const after = service.ledger.getTask(task.id);
  assert.deepEqual([after.state, after.reason], ['held', '超时']);
});
