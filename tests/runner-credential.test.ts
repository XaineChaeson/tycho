// Guards against credentials reaching the start's command, snapshots, events or the ledger;
// crossing accounts on one machine; resuming without the token; starting after a clear during
// upload; and treating machine-login failures like managed-token rejection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner } from '../runner/runner.ts';
import { prepareSnapshot } from '../runner/snapshot.ts';
import type { Login } from '../runner/snapshot.ts';
import { fakeRemote } from './fake-remote.ts';
import { fixture, USER, MACHINE, memoryLogins, memoryMachines, LOGIN, RUNNER_TUNED, RUN_LIMIT_MS } from './helpers.ts';

const TOKEN = 'runner-private-token-31';
const REF = 'ref-runner-0001';

// An account and its token; or, with no token, the machine's own login, which has none.
function setup(t: Parameters<typeof fixture>[0], token = TOKEN) {
  const f = fixture(t);
  const account: Login = token ? { id: 't1', name: 't1', executor: 'claude', tiers: LOGIN.login.tiers } : { ...LOGIN.login };
  const accounts = memoryLogins({ [account.id]: account }, f.ledger);
  if (token) f.ledger.recordAccountCredential(account.id, REF, USER);
  const remote = fakeRemote();
  const logs: string[] = [];
  let value = token;
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: accounts,
    machines: memoryMachines({ [MACHINE.id]: MACHINE }, f.ledger), connect: remote.connect,
    credential: () => (value ? { ref: REF, value } : undefined),
    log: line => logs.push(line),
  });
  const make = (sessionRef?: string) => {
    const task = f.ledger.createTask({ projectId: f.projectId, title: 'credential', goal: 'g', acceptance: '测试通过', roleId: 'implement' }, USER);
    f.ledger.queueTask(task.id, USER);
    const snapshot = prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS, sessionRef });
    return f.ledger.createRun(task.id, { login: account, machine: f.ledger.getMachine('h1')!, snapshot, expectedRevision: task.revision }, USER);
  };
  return { f, account, accounts, remote, runner, make, logs, clear: () => { value = ''; } };
}

for (const session of [undefined, 'old-session']) test('launch and resume name where the token is read from, never the token: ' + session, async t => {
  const { f, remote, runner, make, logs } = setup(t);
  const run = make(session);
  await runner.launch(run);
  const start = remote.calls.find(call => call.script === 'start.sh')!;
  // The machine fetches the token over its own channel (nodes.md §9): the start names the
  // variable the Worker reads it from, and carries nothing of it.
  assert.equal(start.args![2], claudeAdapter.credential!({}).variable);
  assert.ok(!JSON.stringify(start.args).includes(TOKEN));
  assert.equal(start.args!.includes('--resume'), !!session);
  remote.finish(run.id, { status: 'done', summary: 'done', artifacts: [] });
  await runner.settle(f.run(run.id));
  assert.equal(f.run(run.id).exit_kind, 'completed');
  assert.equal(JSON.parse(f.run(run.id).snapshot_json).credential_ref, REF);
  assert.ok(!JSON.stringify({ db: f.dump(), logs, events: runner.events(run.id) }).includes(TOKEN));
});

test('a token that is gone by the time the upload ends withdraws instead of launching', async t => {
  const { f, remote, runner, make, clear } = setup(t);
  const run = make();
  const release = remote.hold('upload');
  const launched = runner.launch(run);
  // launch enters upload synchronously until its first await.
  clear(); release();
  await launched;
  assert.equal(remote.called('start.sh'), 0);
  assert.equal(f.task(run.task_id).state, 'queued');
});

for (const managed of [true, false]) test('auth rejection marks the login either way, an account by the token it refused, a machine own login by the moment: ' + managed, async t => {
  const { f, runner, remote, make } = setup(t, managed ? TOKEN : '');
  const run = make();
  await runner.launch(run);
  Object.assign(remote.runOf(run.id), { pid_alive: false, marked: false, exit: 1,
    stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in', api_error_status: 401, session_id: 's' }) + '\n' });
  await runner.settle(f.run(run.id));
  assert.equal(f.run(run.id).exit_kind, 'auth');
  assert.equal(f.task(run.task_id).state, 'queued');
  assert.equal(f.ledger.loginState(run.login_id).credential_rejected_ref, managed ? REF : null);
  assert.equal(f.ledger.loginState(run.login_id).auth_failed_at !== null, !managed);
  assert.ok(!JSON.stringify(f.dump()).includes(TOKEN));
});

test('two accounts on the same machine each start under their own token number', async t => {
  const f = fixture(t);
  const remote = fakeRemote();
  const a: Login = { id: 't1', name: 't1', executor: 'claude', tiers: LOGIN.login.tiers };
  const b = { ...a, id: 'another', name: 'another' };
  const accounts = memoryLogins({ [a.id]: a, [b.id]: b }, f.ledger);
  const tokens: Record<string, string> = { [a.id]: TOKEN, [b.id]: 'another-private-token' };
  const refs: Record<string, string> = { [a.id]: 'ref-account-a', [b.id]: 'ref-account-b' };
  for (const id of [a.id, b.id]) f.ledger.recordAccountCredential(id, refs[id]!, USER);
  const runner = createRunner({ ...RUNNER_TUNED, ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: accounts,
    machines: memoryMachines({ [MACHINE.id]: MACHINE }, f.ledger), connect: remote.connect, credential: id => ({ ref: refs[id]!, value: tokens[id]! }) });
  for (const account of [a, b]) {
    const task = f.ledger.createTask({ projectId: f.projectId, title: account.id, goal: 'g', acceptance: '测试通过', roleId: 'implement' }, USER);
    f.ledger.queueTask(task.id, USER);
    const snapshot = prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS });
    const run = f.ledger.createRun(task.id, { login: account, machine: f.ledger.getMachine('h1')!, snapshot, expectedRevision: task.revision }, USER);
    assert.equal(JSON.parse(run.snapshot_json).credential_ref, refs[account.id]);
    await runner.launch(run);
    const start = remote.calls.find(c => c.script === 'start.sh' && c.runId === run.id)!;
    assert.ok(!JSON.stringify(start.args).includes(tokens[account.id]!));
  }
});

// From review: a machine that refuses a start before it tries (it could not take this round's
// credential) has started nothing. Read back later, a round with no gate looked unknown, was
// stopped (which takes the gate) and then counted as started and lost — "may have written".
test('a start the machine refused before it tried is a round that never started, with its words', async t => {
  const { f, remote, runner, make } = setup(t);
  const run = make();
  remote.startRefused = '取不到这一轮的凭据：主机没有给这一轮的令牌';
  await runner.launch(run);
  const ended = f.run(run.id);
  assert.equal(ended.state, 'ended');
  assert.equal(ended.started_at, null, '没开工的一轮不算写过产物');
  assert.equal(f.task(run.task_id).state, 'held');
  assert.match(JSON.stringify(f.dump()), /取不到这一轮的凭据/);
});
