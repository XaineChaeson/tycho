import {capturedHost} from './capture-host.ts';
// Guards against: any row of §4's table landing on the wrong ledger operation; a
// new start while the executor is unknown; an orphan Worker being called lost; a
// success receipt beating a stop; a lost contact, a repeated poll or a timeout
// settling twice or not at all; a failed ledger write letting a signal out; a
// process outliving its settled Run; settle() going around the stop check; a start
// sent for a Run the ledger has moved on; a clock that a restart resets, that a later
// change of the setting moves, or that overrules a finished Worker; a stop believed
// after it could not revoke the start;
// one broken Run stopping recovery; a display failure reaching a settlement; residue
// that cannot be cleared going unreported, or reported once per poll; and tidying the
// script directory getting in the way of an inventory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { DegradedError, InputError } from '../service/errors.ts';
import type { Ledger, RunRow } from '../service/ledger.ts';
import { loginMissing, unknownFrom, unreachableSince } from '../service/ledger.ts';
import type { ExecutorsAnswer } from '../runner/host.ts';
import type { RemoteState, Verdict } from '../runner/runner.ts';
import { CHECK_TIMEOUT_MS, createRunner, judge, parseReceipt } from '../runner/runner.ts';
import { prepareSnapshot } from '../runner/snapshot.ts';
import type { Account } from '../runner/snapshot.ts';
import type { RemoteHost } from '../runner/host.ts';
import { Unreachable } from '../runner/host.ts';
import { snapshotSourceOf } from '../shared/sources.ts';
import { claudeTier, DONE, RUN_LIMIT_MS, RUNNER_TUNED, holdMachine, testMachine } from './helpers.ts';
import type { Fixture } from './helpers.ts';
import { fixture, LOGIN, USER } from './helpers.ts';
import { memoryLogins } from './helpers.ts';

// The fixture's own login: h1's Claude Code, which every Run here is made on.
const ACCOUNTS: Record<string, Account> = {
  t1: { ...LOGIN.login },
};

const NOT_STARTED: RemoteState = { started: false, launcher_alive: false, pid_alive: false, marked: false, exit: null };
const STARTED = { ...NOT_STARTED, started: true };
const LAUNCHING = { ...STARTED, launcher_alive: true };
const ALIVE = { ...STARTED, pid_alive: true, marked: true };
const EXITED = { ...STARTED, exit: 0 };
const UNREACHABLE = null;

const result = (text: string, fields: object = {}) =>
  `${JSON.stringify({ type: 'result', is_error: false, result: text, session_id: 's-1', ...fields })}\n`;
const receipt = (value: unknown) => `回执\n\`\`\`receipt\n${JSON.stringify(value)}\n\`\`\``;
const DONE_OUTPUT = result(receipt({ status: 'done', summary: '好了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] }));

interface Fake {
  host: RemoteHost;
  calls: string[];
  state: RemoteState | null;
  stdout: string;
  stderr: string;
  startCode: number;
  stopCode: number;
  startFails: boolean;
  uploadFails: boolean;
  stopped: () => void;
}

function fakeHost(state: RemoteState | null, stdout = ''): Fake {
  const fake: Fake = {
    calls: [],
    state,
    stdout,
    stderr: '',
    startCode: 0,
    stopCode: 0,
    startFails: false,
    uploadFails: false,
    stopped() {},
    host: {
      // The closed set of §4.1, each call recorded under the script it used to be, so
      // what the tests count still reads the way it did. A machine that is not there
      // throws on every call, and whatever it answers arrives as data.
      async place() {
        fake.calls.push('upload');
        if (fake.uploadFails) throw new Unreachable('断了');
        return [];
      },
      async start() {
        fake.calls.push('start.sh');
        if (fake.startFails) throw new Unreachable('断了');
        const confirmed = fake.startCode === 0;
        return { code: fake.startCode, stdout: 'started 42\n', stderr: '', confirmed, ...(confirmed ? { pid: 42 } : {}) };
      },
      async stop() {
        fake.calls.push('stop.sh');
        if (fake.state === UNREACHABLE) throw new Unreachable('断了');
        if (fake.stopCode !== 0) throw new Unreachable(`stop.sh 退出码 ${fake.stopCode}：什么都没撤销`);
        fake.stopped();
      },
      async state() {
        // Every answer is one a machine gave; one that cannot be read is the transport
        // refusing it, which is an Unreachable like any other.
        fake.calls.push('state.sh');
        if (fake.state === UNREACHABLE) throw new Unreachable('断了');
        return { ...fake.state, unknown: null };
      },
      async list() {
        fake.calls.push('list-runs.sh');
        if (fake.state === UNREACHABLE) throw new Unreachable('断了');
        return [];
      },
      async artifacts() {
        fake.calls.push('artifacts.sh');
        if (fake.state === UNREACHABLE) throw new Unreachable('断了');
        return [];
      },
      async dropRun() {},
      connected: () => true,
      async readRange(path, offset) {
        const whole = Buffer.from(path.endsWith('stderr.log') ? fake.stderr : fake.stdout);
        return { bytes: whole.subarray(offset), size: whole.length, mtime: 1_700_000_000 };
      },
    },
  };
  return fake;
}

function runnerFor(f: Fixture, fake: Fake, ledger: Ledger = f.ledger) {
  return createRunner({ ...RUNNER_TUNED, ledger, adapters: { claude: claudeAdapter }, logins: memoryLogins({ ...ACCOUNTS, t1: { ...ACCOUNTS.t1!, id: f.login.login.id } }), machines: { get: f.ledger.getMachine, list: f.ledger.listMachines }, connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null) });
}

function launchingRun(f: Fixture): RunRow {
  return f.ledger.createRun(f.queuedTask().id, f.login, USER);
}

function unknownRun(f: Fixture, from: 'running' | 'stopping'): RunRow {
  const { run } = f.runningRun();
  if (from === 'stopping') f.ledger.markRunStopping(run.id, USER);
  f.ledger.markRunUnknown(run.id);
  return f.run(run.id);
}

// The seven rows of §4, in table order. The stopping variant of row 6 is below.
const ROWS: {
  row: string;
  state: RemoteState | null;
  stdout?: string;
  verdict: Verdict;
  run: string;
  task: string;
  exitKind?: string;
}[] = [
  { row: '1 no started/', state: NOT_STARTED, verdict: 'unknown', run: 'unknown', task: 'needs_verification' },
  { row: '2 launcher still there', state: LAUNCHING, verdict: 'waiting', run: 'launching', task: 'running' },
  { row: '3 launcher died before pid', state: STARTED, verdict: 'lost', run: 'ended', task: 'queued', exitKind: 'lost' },
  { row: '4 running', state: ALIVE, verdict: 'running', run: 'running', task: 'running' },
  { row: '5 exit written', state: EXITED, stdout: DONE_OUTPUT, verdict: 'ended', run: 'ended', task: 'ready', exitKind: 'completed' },
  { row: '6 gone without exit', state: { ...STARTED }, verdict: 'lost', run: 'ended', task: 'queued', exitKind: 'lost' },
  { row: '7 host unreachable', state: UNREACHABLE, verdict: 'unknown', run: 'unknown', task: 'needs_verification' },
];

for (const { row, state, stdout, verdict, run: runState, task: taskState, exitKind } of ROWS) {
  test(`table row ${row}`, async (t) => {
    const f = fixture(t);
    const run = launchingRun(f);
    const fake = fakeHost(state, stdout);
    assert.equal(await runnerFor(f, fake).verify(run), verdict);
    const after = f.run(run.id);
    assert.equal(after.state, runState);
    assert.equal(after.exit_kind, exitKind ?? null);
    assert.equal(f.task(run.task_id).state, taskState);
    assert.ok(!fake.calls.includes('start.sh'), '核实绝不重发启动');
  });
}

test('row 6 of a stopping Run settles as interrupted: a killed Worker may leave no exit', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  f.ledger.markRunStopping(run.id, USER);
  assert.equal(await runnerFor(f, fakeHost(STARTED)).verify(f.run(run.id)), 'ended');
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(task.id).state, 'held');
});

test('an orphan Worker with no pid file is running, never lost', async (t) => {
  const f = fixture(t);
  const run = launchingRun(f);
  assert.equal(await runnerFor(f, fakeHost({ ...STARTED, marked: true })).verify(run), 'running');
  assert.equal(f.run(run.id).state, 'running');
});

test('a group that outlived its wrapper is still running', () => {
  assert.equal(judge({ ...STARTED, pid_alive: true }, false), 'running');
});

test('an exit file with a leftover process ends the Run, but a stop waits for the process', () => {
  const state = { ...ALIVE, exit: 0 };
  assert.equal(judge(state, false), 'ended');
  assert.equal(judge(state, true), 'running');
});

test('leftover processes are cleared before settling, and the settlement says so', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  const fake = fakeHost({ ...ALIVE, exit: 0 }, DONE_OUTPUT);
  fake.stopped = () => {
    fake.state = EXITED;
  };
  assert.equal(await runnerFor(f, fake).verify(run), 'ended');
  assert.deepEqual(fake.calls, ['state.sh', 'stop.sh', 'state.sh']);
  const after = f.run(run.id);
  assert.equal(after.exit_kind, 'completed');
  assert.equal(JSON.parse(after.error_json!).residue, true);
  assert.equal(f.task(task.id).state, 'ready');
  const [note] = f.peek<{ text: string }>(`SELECT text FROM message WHERE channel = 'internal'`);
  assert.match(note!.text, /仍有后台进程，已清理/);
});

test('a clean end carries no residue mark', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  await runnerFor(f, fakeHost(EXITED, DONE_OUTPUT)).verify(run);
  assert.equal(f.run(run.id).error_json, null);
});

test('leftover processes that survive the stop keep the Run open', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  assert.equal(await runnerFor(f, fakeHost({ ...ALIVE, exit: 0 }, DONE_OUTPUT)).verify(run), 'running');
  assert.equal(f.run(run.id).state, 'running');
});

test('a Run found finished from launching keeps a start time', async (t) => {
  const f = fixture(t);
  const run = launchingRun(f);
  await runnerFor(f, fakeHost(EXITED, DONE_OUTPUT)).verify(run);
  assert.ok(f.run(run.id).started_at);
  assert.equal(f.task(run.task_id).state, 'ready');
});

test('unknown comes back to running when the executor is found', async (t) => {
  const f = fixture(t);
  const run = unknownRun(f, 'running');
  assert.equal(f.task(run.task_id).state, 'needs_verification');
  await runnerFor(f, fakeHost(ALIVE)).verify(run);
  assert.equal(f.run(run.id).state, 'running');
  assert.equal(f.task(run.task_id).state, 'running');
});

test('unknown with an exit file is restored, then settled', async (t) => {
  const f = fixture(t);
  const run = unknownRun(f, 'running');
  await runnerFor(f, fakeHost(EXITED, DONE_OUTPUT)).verify(run);
  assert.equal(f.run(run.id).exit_kind, 'completed');
  assert.equal(f.task(run.task_id).state, 'ready');
});

test('unknown found lost sends the Task back to the queue: the executor was seen gone', async (t) => {
  const f = fixture(t);
  const run = unknownRun(f, 'running');
  await runnerFor(f, fakeHost(STARTED)).verify(run);
  assert.equal(f.run(run.id).exit_kind, 'lost');
  assert.equal(f.task(run.task_id).state, 'queued');
});

test('a stop that lost contact still settles as interrupted, success receipt or not', async (t) => {
  const f = fixture(t);
  const run = unknownRun(f, 'stopping');
  const fake = fakeHost(EXITED, DONE_OUTPUT);
  await runnerFor(f, fake).verify(run);
  assert.ok(fake.calls.includes('stop.sh'));
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(run.task_id).state, 'held');
});

test('a stop that could not revoke the start settles nothing and keeps the intent', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  // Looks gone, which is exactly what must not be believed after a failed revocation.
  const fake = fakeHost(STARTED);
  fake.stopCode = 5;
  assert.equal(await runnerFor(f, fake).interrupt(run, USER), 'unknown');
  assert.deepEqual(fake.calls, ['stop.sh']);
  assert.equal(f.run(run.id).state, 'unknown');
  assert.equal(unknownFrom(f.run(run.id)), 'stopping');
  assert.equal(f.task(task.id).state, 'needs_verification');

  fake.stopCode = 0;
  assert.equal(await runnerFor(f, fake).verify(run), 'ended');
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(task.id).state, 'held');
});

test('a failed cleanup of leftover processes does not settle either', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const fake = fakeHost({ ...ALIVE, exit: 0 }, DONE_OUTPUT);
  fake.stopCode = 5;
  assert.equal(await runnerFor(f, fake).verify(run), 'unknown');
  assert.equal(f.run(run.id).state, 'unknown');
});

test('repeated unreachable polls do not fail on the second mark', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const runner = runnerFor(f, fakeHost(UNREACHABLE));
  assert.equal(await runner.verify(run), 'unknown');
  assert.equal(await runner.verify(run), 'unknown');
});

test('losing the host while reading the final output settles nothing', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const fake = fakeHost(EXITED, DONE_OUTPUT);
  fake.host.readRange = async () => {
    throw new Unreachable('断了');
  };
  assert.equal(await runnerFor(f, fake).verify(run), 'unknown');
  assert.equal(f.run(run.id).state, 'unknown');
});

test('a garbled state answer is not taken for a dead process', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const fake = fakeHost(ALIVE);
  // An answer that cannot be read is not a machine saying nothing is left: the transport
  // refuses it, and the Run is unknown rather than gone.
  fake.host.state = async () => {
    throw new Unreachable('没有给出可读的执行状态');
  };
  assert.equal(await runnerFor(f, fake).verify(run), 'unknown');
  assert.equal(f.run(run.id).state, 'unknown');
});

test('two overlapping polls settle once', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const runner = runnerFor(f, fakeHost(EXITED, DONE_OUTPUT));
  await Promise.all([runner.verify(run), runner.verify(run)]);
  assert.equal(f.peek(`SELECT 1 FROM message WHERE external_id LIKE '%:late:%'`).length, 0);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'run.settle'`).length, 1);
});

test('settlement: exit 0 and a done receipt, with the session kept for resume', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  await runnerFor(f, fakeHost(EXITED, DONE_OUTPUT)).settle(run);
  const after = f.run(run.id);
  assert.equal(after.exit_code, 0);
  assert.equal(after.session_ref, 's-1');
  assert.deepEqual(JSON.parse(after.receipt_json!), { status: 'done', summary: '好了', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
});

test('settle refuses a Run with no exit file', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  await assert.rejects(runnerFor(f, fakeHost(ALIVE)).settle(run), InputError);
  assert.equal(f.run(run.id).state, 'running');
});

test('settle goes through the stop check: an exit file does not end a live stopping Run', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  f.ledger.markRunStopping(run.id, USER);
  const fake = fakeHost({ ...ALIVE, exit: 0 }, DONE_OUTPUT);
  await assert.rejects(runnerFor(f, fake).settle(run), InputError);
  assert.ok(fake.calls.includes('stop.sh'));
  assert.equal(f.run(run.id).state, 'stopping');
  assert.equal(f.task(task.id).state, 'stopping');
});

test('settling a settled Run does not reach the ledger again', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const fake = fakeHost(EXITED, DONE_OUTPUT);
  const runner = runnerFor(f, fake);
  await runner.settle(run);
  const before = f.dump();
  const calls = fake.calls.length;
  await runner.settle(run);
  assert.deepEqual(f.dump(), before);
  assert.equal(fake.calls.length, calls);
});

test('settlement: is_error with exit 0 never counts as done', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  const output = result(receipt({ status: 'done' }), { is_error: true });
  await runnerFor(f, fakeHost(EXITED, output)).verify(run);
  assert.equal(f.run(run.id).exit_kind, 'failed');
  assert.equal(f.task(task.id).state, 'held');
});

test('settlement: a non-zero exit keeps the receipt it wrote', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  await runnerFor(f, fakeHost({ ...STARTED, exit: 1 }, DONE_OUTPUT)).verify(run);
  assert.equal(JSON.parse(f.run(run.id).receipt_json!).status, 'done');
  assert.equal(f.task(task.id).state, 'held');
});

test('settlement: exit 0 plain prose settles cleanly while empty output without receipt holds the Task', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  await runnerFor(f, fakeHost(EXITED, result('没写回执但已完整答复'))).verify(run);
  assert.equal(f.run(run.id).exit_kind, 'completed');
  assert.equal(f.task(task.id).state, 'ready');
  assert.equal(f.ledger.runReport(run.id)?.text, '没写回执但已完整答复');

  const empty = f.runningRun();
  await runnerFor(f, fakeHost(EXITED, result('   '))).verify(empty.run);
  assert.equal(f.task(empty.task.id).state, 'held');
  assert.equal(f.task(empty.task.id).reason, '回执无法解析');
});

test('settlement: a login failure takes the login out of work and sends the Task back to the queue, and so does a used-up quota', async (t) => {
  const f = fixture(t);
  const login = f.runningRun();
  await runnerFor(f, fakeHost({ ...STARTED, exit: 1 }, result('Please run /login', { is_error: true }))).verify(login.run);
  assert.deepEqual([f.task(login.task.id).state, f.run(login.run.id).exit_kind], ['queued', 'auth']);
  assert.match(JSON.parse(f.run(login.run.id).error_json!).reason, /机器上的登录失效了/);
  assert.ok(f.ledger.loginState(login.run.login_id).auth_failed_at !== null, '这份登录不再接新活');
  const quota = f.runningRun();
  await runnerFor(f, fakeHost({ ...STARTED, exit: 1 }, result('hit your limit', { is_error: true }))).verify(quota.run);
  assert.deepEqual([f.task(quota.task.id).state, f.task(quota.task.id).reason, f.run(quota.run.id).exit_kind], ['queued', null, 'quota']);
});

test('settlement: no result line takes its reason from stderr', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  const fake = fakeHost({ ...STARTED, exit: 127 });
  fake.stderr = 'claude: command not found\n';
  await runnerFor(f, fake).verify(run);
  assert.equal(f.task(task.id).reason, 'claude: command not found');
});

test('interrupt records the stop before any signal, then settles once the process is gone', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  const fake = fakeHost(ALIVE);
  fake.stopped = () => {
    assert.equal(f.run(run.id).state, 'stopping');
    fake.state = STARTED;
  };
  assert.equal(await runnerFor(f, fake).interrupt(run, USER), 'ended');
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(task.id).state, 'held');
  assert.deepEqual(fake.calls, ['stop.sh', 'state.sh']);
});

test('interrupt that cannot be written sends no signal', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const fake = fakeHost(ALIVE);
  const broken = {
    ...f.ledger,
    markRunStopping() {
      throw new DegradedError('写不进去');
    },
  };
  await assert.rejects(runnerFor(f, fake, broken).interrupt(run, USER), DegradedError);
  assert.deepEqual(fake.calls, []);
});

test('interrupt on an unreachable host keeps the stop intent through unknown', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  const fake = fakeHost(UNREACHABLE);
  const runner = runnerFor(f, fake);
  assert.equal(await runner.interrupt(run, USER), 'unknown');
  assert.equal(f.run(run.id).state, 'unknown');

  fake.state = STARTED;
  assert.equal(await runner.verify(run), 'ended');
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(task.id).state, 'held');
});

test('a stop that leaves the process alive does not settle', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  assert.equal(await runnerFor(f, fakeHost(ALIVE)).interrupt(run, USER), 'running');
  assert.equal(f.run(run.id).state, 'stopping');
  assert.equal(f.task(task.id).state, 'stopping');
});

test('a Run whose start never happened can still be stopped, and ends interrupted', async (t) => {
  const f = fixture(t);
  const run = launchingRun(f);
  const fake = fakeHost(NOT_STARTED);
  const runner = runnerFor(f, fake);
  await runner.verify(run);
  assert.equal(f.run(run.id).state, 'unknown');
  // stop.sh takes the gate, which is what makes this conclusive.
  fake.stopped = () => {
    fake.state = STARTED;
  };
  await runner.interrupt(run, USER);
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(run.task_id).state, 'held');
});

test('a account the owner deleted does not stop recovery of the other Runs', async (t) => {
  const f = fixture(t);
  const broken = f.runningRun().run;
  f.ledger.putAccount({ id: 'gone', name: 'gone', executor: 'claude', tiers: ACCOUNTS.t1!.tiers }, USER, 'ref-gone');
  f.force(`UPDATE run SET login_id = 'gone' WHERE id = ?`, broken.id);
  f.ledger.deleteAccount('gone', USER, { confirmed: true });
  const stopping = f.runningRun().run;
  f.ledger.markRunStopping(stopping.id, USER);
  const fake = fakeHost(ALIVE);
  fake.stopped = () => {
    fake.state = STARTED;
  };
  assert.deepEqual(await runnerFor(f, fake).recover(), [
    { runId: broken.id, verdict: 'lost' },
    { runId: stopping.id, verdict: 'ended' },
  ]);
  assert.equal(f.run(stopping.id).exit_kind, 'interrupted');
  // §4: the owner took its machine away, which says the Run is gone. Nobody is asked.
  assert.equal(f.run(broken.id).exit_kind, 'lost');
  assert.equal(JSON.parse(f.run(broken.id).error_json!).lost.basis, 'removed');
  assert.equal(f.task(broken.task_id).state, 'queued');
});

// What a backup from before accounts were kept in the ledger leaves: Runs that name a
// account the ledger has no row for and no record of deleting. Review finding 3: reading
// that as "the owner removed the machine" settled live Runs as lost without asking anyone.
test('a Run whose account the ledger never held stays unknown: no machine is asked, nothing is judged, and no wait begins', async (t) => {
  const f = fixture(t);
  const orphaned = f.runningRun().run;
  f.force(`UPDATE run SET login_id = 'never' WHERE id = ?`, orphaned.id);
  const other = f.runningRun().run;
  const fake = fakeHost(EXITED, DONE_OUTPUT);
  const runner = runnerFor(f, fake);
  assert.deepEqual(await runner.recover(), [
    { runId: orphaned.id, verdict: 'unknown' },
    { runId: other.id, verdict: 'ended' },
  ]);
  assert.equal(f.run(orphaned.id).state, 'unknown');
  assert.equal(f.run(orphaned.id).exit_kind, null, '没有人看过它，不能判成丢失');
  assert.equal(loginMissing(f.run(orphaned.id)), true);
  assert.equal(unreachableSince(f.run(orphaned.id)), undefined, '没有失联的起点，也就没有宽限期');
  assert.equal(f.task(orphaned.task_id).state, 'needs_verification');
  assert.match(f.task(orphaned.task_id).reason!, /账本里没有机器 h1 上的 claude 登录 的配置：需要重新选择登录，同名新建的账号或机器登录不会接续这份引用/);
  assert.deepEqual(runner.lostCandidates(), [], '它不等宽限期，也就不会被接续');
  const asked = fake.calls.length;
  assert.equal(await runner.verify(f.run(orphaned.id)), 'unknown');
  await runner.tail(f.run(orphaned.id));
  assert.equal(fake.calls.length, asked, '没有目标配置就不知道去问哪台机器');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE run_id = ? AND action = 'run.unknown'`, orphaned.id).length, 1, '同一个结论不重复记');
});

test('once the original login configuration is readable again, its Run is verified the ordinary way', async (t) => {
  const f = fixture(t);
  const orphaned = f.runningRun().run;
  const accounts: Record<string, Account> = {};
  const fake = fakeHost(ALIVE);
  const runner = createRunner({ ...RUNNER_TUNED, ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: memoryLogins(accounts), machines: { get: f.ledger.getMachine, list: f.ledger.listMachines }, connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null) });
  assert.equal(await runner.verify(f.run(orphaned.id)), 'unknown');
  accounts.original = { ...f.login.login };
  assert.equal(await runner.verify(f.run(orphaned.id)), 'running');
  assert.equal(f.run(orphaned.id).state, 'running');
  assert.equal(f.task(orphaned.task_id).state, 'running');
  // And one whose machine is now another client under the same name was removed, as ever.
  const elsewhere = f.runningRun().run;
  f.force(`UPDATE run SET node_id = 'another-client' WHERE id = ?`, elsewhere.id);
  assert.equal(await runner.verify(f.run(elsewhere.id)), 'lost');
  assert.equal(JSON.parse(f.run(elsewhere.id).error_json!).lost.basis, 'removed');
});

test('a Run nobody here can read any more is unknown, and recovery of the others goes on', async (t) => {
  const f = fixture(t);
  const unreadable = f.runningRun().run;
  f.force(`UPDATE run SET snapshot_json = json_set(snapshot_json, '$.output_capture.version', 99) WHERE id = ?`, unreadable.id);
  const other = f.runningRun().run;
  const results = await runnerFor(f, fakeHost(EXITED, DONE_OUTPUT)).recover();
  assert.deepEqual(results, [
    { runId: unreadable.id, error: '节点输出版本不可读' },
    { runId: other.id, verdict: 'ended' },
  ]);
  assert.equal(f.run(unreadable.id).state, 'unknown');
  assert.equal(f.run(other.id).exit_kind, 'completed');
});

test('a failing database goes through recover instead of being listed as one Run', async (t) => {
  const f = fixture(t);
  launchingRun(f);
  const broken = {
    ...f.ledger,
    markRunRunning() {
      throw new DegradedError('写不进去');
    },
  };
  await assert.rejects(runnerFor(f, fakeHost(ALIVE), broken).recover(), DegradedError);
});

test('recover finishes a stop before anything else and reports every Run', async (t) => {
  const f = fixture(t);
  const stopping = f.runningRun().run;
  f.ledger.markRunStopping(stopping.id, USER);
  const running = f.runningRun().run;
  const fake = fakeHost(ALIVE);
  fake.stopped = () => {
    fake.state = STARTED;
  };
  const before = fake.calls;
  const results = await runnerFor(f, fake).recover();
  assert.equal(before[0], 'stop.sh');
  assert.deepEqual(
    results.map(({ runId }) => runId),
    [stopping.id, running.id],
  );
  assert.equal(f.run(stopping.id).exit_kind, 'interrupted');
});

function snapshotRun(f: Fixture): RunRow {
  const task = f.ledger.createTask(
    { projectId: f.projectId, title: '任务', goal: '目标', acceptance: '验收', roleId: 'implement' },
    USER,
  );
  f.ledger.queueTask(task.id, USER);
  const snapshot = prepareSnapshot(task, ACCOUNTS.t1!, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS });
  return f.ledger.createRun(task.id, { ...f.login, snapshot, expectedRevision: task.revision }, USER);
}

test('launch uploads first, starts once, and marks running on the ack', async (t) => {
  const f = fixture(t);
  const run = snapshotRun(f);
  const fake = fakeHost(ALIVE);
  await runnerFor(f, fake).launch(run);
  assert.deepEqual(fake.calls, ['upload', 'start.sh']);
  assert.equal(f.run(run.id).state, 'running');
});

test('a lost start ack stays launching and is not sent again', async (t) => {
  const f = fixture(t);
  const run = snapshotRun(f);
  const fake = fakeHost(ALIVE);
  fake.startFails = true;
  const runner = runnerFor(f, fake);
  await runner.launch(run);
  assert.equal(f.run(run.id).state, 'launching');
  assert.deepEqual(fake.calls, ['upload', 'start.sh']);

  await runner.verify(run);
  assert.equal(f.run(run.id).state, 'running');
  assert.equal(fake.calls.filter((call) => call === 'start.sh').length, 1);
});

test('a failed upload never reaches start.sh, and with no other machine the Run ends as never started', async (t) => {
  const f = fixture(t);
  const run = snapshotRun(f);
  const fake = fakeHost(NOT_STARTED);
  fake.uploadFails = true;
  await runnerFor(f, fake).launch(run);
  assert.deepEqual(fake.calls, ['upload']);
  const after = f.run(run.id);
  assert.deepEqual([after.state, after.exit_kind], ['ended', 'lost']);
  assert.equal(JSON.parse(after.error_json!).lost.basis, 'not_started');
  assert.equal(f.task(run.task_id).state, 'queued', '什么都没启动：不留未知 Run，任务回去排队');
});

test('a taken gate goes to verify instead of claiming a start', async (t) => {
  const f = fixture(t);
  const run = snapshotRun(f);
  const fake = fakeHost(STARTED);
  fake.startCode = 3;
  await runnerFor(f, fake).launch(run);
  assert.equal(f.run(run.id).exit_kind, 'lost');
});

test('a start overtaken by a stop goes to verify like a taken gate', async (t) => {
  const f = fixture(t);
  const run = snapshotRun(f);
  const fake = fakeHost(ALIVE);
  fake.startCode = 4;
  await runnerFor(f, fake).launch(run);
  assert.deepEqual(fake.calls, ['upload', 'start.sh', 'state.sh']);
  assert.equal(f.run(run.id).state, 'running');
});

test('launch sends nothing for a Run that is no longer launching', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const fake = fakeHost(ALIVE);
  await runnerFor(f, fake).launch(run);
  assert.deepEqual(fake.calls, []);
});

test('a stale launching object does not start a Run the ledger calls unknown', async (t) => {
  const f = fixture(t);
  const run = snapshotRun(f);
  f.ledger.markRunUnknown(run.id);
  const fake = fakeHost(NOT_STARTED);
  await runnerFor(f, fake).launch(run);
  assert.deepEqual(fake.calls, []);
});

test('a degraded service sends no start, before the upload or after it', async (t) => {
  const f = fixture(t);
  const run = snapshotRun(f);
  let degraded = true;
  let recovering = false;
  const ledger = {
    ...f.ledger,
    dispatchConditions: () => ({ paused: false, degraded, recovering, canDispatch: !degraded && !recovering }),
  };
  const fake = fakeHost(NOT_STARTED);
  await assert.rejects(runnerFor(f, fake, ledger).launch(run), DegradedError);
  assert.deepEqual(fake.calls, []);

  degraded = false;
  const place = fake.host.place;
  fake.host.place = async (runDir, localDir) => {
    const written = await place(runDir, localDir);
    degraded = true;
    return written;
  };
  await assert.rejects(runnerFor(f, fake, ledger).launch(run), DegradedError);
  assert.deepEqual(fake.calls, ['upload']);
  assert.equal(f.run(run.id).state, 'launching');

  // The same gate for an inventory that began while the upload was on its way.
  degraded = false;
  fake.calls.length = 0;
  fake.host.place = async (runDir, localDir) => {
    const written = await place(runDir, localDir);
    recovering = true;
    return written;
  };
  await assert.rejects(runnerFor(f, fake, ledger).launch(run), /恢复清点/);
  assert.deepEqual(fake.calls, ['upload']);
  assert.equal(f.run(run.id).state, 'launching');
});

test('a stop that arrives during launch is not overwritten by the ack', async (t) => {
  const f = fixture(t);
  const run = snapshotRun(f);
  const fake = fakeHost(ALIVE);
  const place = fake.host.place;
  fake.host.place = async (runDir, localDir) => {
    const written = await place(runDir, localDir);
    f.ledger.markRunStopping(run.id, USER);
    return written;
  };
  await runnerFor(f, fake).launch(run);
  assert.equal(f.run(run.id).state, 'stopping');
  assert.deepEqual(fake.calls, ['upload']);
});

test('the wall clock interrupts through tail and says why', async (t) => {
  const f = fixture(t);
  const task = f.queuedTask();
  const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { brief: 'b', timeout_ms: 1 } }, USER);
  f.ledger.markRunRunning(run.id);
  f.force(`UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, run.id);
  const fake = fakeHost(ALIVE);
  fake.stopped = () => {
    fake.state = STARTED;
  };
  await runnerFor(f, fake).tail(f.run(run.id));
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(task.id).state, 'held');
  assert.equal(f.task(task.id).reason, '超时');
});

test('the clock survives a restart because it reads the ledger', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.force(`UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, run.id);
  const fake = fakeHost(ALIVE);
  await runnerFor(f, fake).tail(f.run(run.id));
  assert.equal(f.run(run.id).state, 'stopping');
});

test('a start confirmed late does not earn a new budget: the clock runs from created_at', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  assert.ok(Date.now() - Date.parse(f.run(run.id).started_at!) < 60_000);
  f.force(`UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, run.id);
  await runnerFor(f, fakeHost(ALIVE)).tail(f.run(run.id));
  assert.equal(f.run(run.id).state, 'stopping');
});

test('an overdue Run is stopped even when its log cannot be read', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.force(`UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, run.id);
  const fake = fakeHost(ALIVE);
  fake.host.readRange = async () => {
    throw new Unreachable('断了');
  };
  await runnerFor(f, fake).tail(f.run(run.id));
  assert.ok(fake.calls.includes('stop.sh'));
  assert.equal(f.run(run.id).state, 'stopping');
});

test('watch stops an overdue launching Run whose launcher never returns', async (t) => {
  const f = fixture(t);
  const run = launchingRun(f);
  f.force(
    `UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`,
    run.id,
  );
  // A launcher that stays put keeps the Run launching, so tail never gets to it.
  const fake = fakeHost(LAUNCHING);
  fake.stopped = () => {
    fake.state = STARTED;
  };
  const controller = new AbortController();
  const polling = fake.host.state;
  fake.host.state = async (runDir) => {
    if (fake.calls.length >= 20) controller.abort();
    return polling(runDir);
  };
  await runnerFor(f, fake).watch(run, { intervalMs: 1, signal: controller.signal });
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(run.task_id).reason, '超时');
});

test('an overdue Run that already finished settles its result instead of a timeout', async (t) => {
  const f = fixture(t);
  const run = launchingRun(f);
  f.force(`UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, run.id);
  const fake = fakeHost(EXITED, DONE_OUTPUT);
  await runnerFor(f, fake).watch(run, { intervalMs: 1 });
  assert.ok(!fake.calls.includes('stop.sh'));
  assert.equal(f.run(run.id).exit_kind, 'completed');
  assert.equal(f.task(run.task_id).state, 'ready');
  assert.equal(f.task(run.task_id).reason, null);
});

test('the same through tail: a running Run that finished is not stopped at the deadline', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  f.force(`UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, run.id);
  await runnerFor(f, fakeHost(EXITED, DONE_OUTPUT)).tail(f.run(run.id));
  assert.equal(f.run(run.id).exit_kind, 'completed');
  assert.equal(f.task(task.id).state, 'ready');
});

test('an overdue Run on an unreachable host still gets its stop intent recorded', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  f.force(`UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, run.id);
  await runnerFor(f, fakeHost(UNREACHABLE)).tail(f.run(run.id));
  assert.equal(f.run(run.id).state, 'unknown');
  assert.equal(unknownFrom(f.run(run.id)), 'stopping');
});

test('an unknown Run has no clock', async (t) => {
  const f = fixture(t);
  const run = unknownRun(f, 'running');
  f.force(`UPDATE run SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, run.id);
  const controller = new AbortController();
  const fake = fakeHost(UNREACHABLE);
  const verifying = fake.host.state;
  fake.host.state = async (runDir) => {
    controller.abort();
    return verifying(runDir);
  };
  await runnerFor(f, fake).watch(run, { intervalMs: 1, signal: controller.signal });
  assert.equal(f.run(run.id).state, 'unknown');
  assert.ok(!fake.calls.includes('stop.sh'));
});

test('within the limit tail leaves the Run alone', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const fake = fakeHost(ALIVE);
  await runnerFor(f, fake).tail(f.run(run.id));
  assert.equal(f.run(run.id).state, 'running');
  assert.deepEqual(fake.calls, []);
});

test('a subscriber or a parser that throws does not stop a settlement', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  const adapter = {
    ...claudeAdapter,
    parse(line: string) {
      if (line.includes('坏')) throw new Error('解析崩了');
      return claudeAdapter.parse(line);
    },
  };
  const fake = fakeHost(EXITED, `{"type":"坏"}\n${DONE_OUTPUT}`);
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger,
    adapters: { claude: adapter },
    logins: memoryLogins({ ...ACCOUNTS, t1: { ...ACCOUNTS.t1!, id: f.login.login.id } }), machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null),
  });
  const seen: string[] = [];
  runner.subscribe(run.id, () => {
    throw new Error('订阅者崩了');
  });
  runner.subscribe(run.id, (event) => seen.push(event.kind));
  await runner.verify(run);
  assert.equal(f.task(task.id).state, 'ready');
  assert.ok(seen.includes('turn.end'));
});

test('a progress read that fails does not stop a settlement', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  const broken = {
    ...f.ledger,
    touchRun() {
      throw new Error('展示写失败');
    },
  };
  await runnerFor(f, fakeHost(EXITED, DONE_OUTPUT), broken).verify(run);
  assert.equal(f.task(task.id).state, 'ready');
});

test('watch follows a Run to its end', async (t) => {
  const f = fixture(t);
  const { run, task } = f.runningRun();
  const fake = fakeHost(ALIVE, DONE_OUTPUT);
  let polls = 0;
  const polling = fake.host.state;
  fake.host.state = async (runDir) => {
    polls += 1;
    if (polls === 2) fake.state = EXITED;
    return polling(runDir);
  };
  await runnerFor(f, fake).watch(run, { intervalMs: 1 });
  assert.equal(f.task(task.id).state, 'ready');
});

test('watch stops when aborted and leaves the Run as it is', async (t) => {
  const f = fixture(t);
  const { run } = f.runningRun();
  const controller = new AbortController();
  const watching = runnerFor(f, fakeHost(ALIVE)).watch(run, { intervalMs: 10_000, signal: controller.signal });
  setImmediate(() => controller.abort());
  await watching;
  assert.equal(f.run(run.id).state, 'running');
});

test('parseReceipt accepts trailing prose after a closed receipt fence and falls back cleanly to ```json with valid status', () => {
  assert.deepEqual(parseReceipt('x\n```receipt\n{"status":"done"}\n```'), { status: 'done' });
  assert.deepEqual(parseReceipt('```receipt\n{"status":"done"}\n```\n\n'), { status: 'done' });
  assert.deepEqual(parseReceipt('```receipt\n{"status":"done"}\n```\n然后我又说了话 🎉'), { status: 'done' });
  assert.deepEqual(parseReceipt('```receipt\n{"status":"done"}\n```\n已附上 ```receipt``` 回执。'), { status: 'done' });
  assert.equal(parseReceipt('```receipt\n{broken\n```'), null);
  assert.equal(parseReceipt('```receipt\n[1]\n```'), null);
  assert.equal(parseReceipt('没有'), null);
  assert.equal(parseReceipt(undefined), null);

  // Fallback to ```json ONLY when no ```receipt fence exists AND status is a valid receipt status string
  assert.deepEqual(parseReceipt('完成。\n```json\n{"status":"done","summary":"ok"}\n```\n祝顺利'), { status: 'done', summary: 'ok' });
  assert.deepEqual(parseReceipt('```json\n{"status":"need_input","summary":"need choice"}\n```'), { status: 'need_input', summary: 'need choice' });
  assert.equal(parseReceipt('```json\n{"foo":"bar"}\n```'), null);
  assert.equal(parseReceipt('```json\n{"status":"unknown_status"}\n```'), null);
  // Broken ```receipt fence does NOT fall back to an earlier ```json snippet
  assert.equal(parseReceipt('```json\n{"status":"done"}\n```\n```receipt\n{broken\n```'), null);
});

test('an example receipt earlier in the message does not hide the real one', () => {
  const text = '格式是这样：\n```receipt\n{"status":"failed"}\n```\n我的回执：\n```receipt\n{"status":"done"}\n```\n';
  assert.deepEqual(parseReceipt(text), { status: 'done' });
  assert.equal(parseReceipt('```receipt\n{"status":"done"}\n```\n```receipt\n{"status":"done"}'), null);
});

test('findMachine respects preferOrder for continuation affinity while preserving load-balancing by default', async (t) => {
  const f = fixture(t);
  const m1 = f.ledger.getMachine('h1')!;
  holdMachine(f.ledger, testMachine('h2'));
  const m2 = f.ledger.getMachine('h2')!;
  const account = f.ledger.getAccount('t1')!;
  // Put one active run on h1 so h1 has 1 active run and h2 has 0.
  f.runningRun();
  const runner = createRunner({
    ledger: f.ledger,
    adapters: { claude: claudeAdapter },
    logins: { get: (id) => f.ledger.getAccount(id), list: () => f.ledger.listAccounts() },
    machines: { get: (id) => f.ledger.getMachine(id), list: () => f.ledger.listMachines() },
    connect: () => fakeHost(STARTED).host,
    lostGraceMs: () => 60_000,
    cooldownMs: () => 60_000,
    probeFreshMs: () => 60_000,
    sweepMs: () => 60_000,
    artifactFileLimitBytes: () => 1024 * 1024,
    artifactsLimitBytes: () => 10 * 1024 * 1024,
    displayTextBytes: () => 4096,
    log: () => {},
  });

  // Default (preferOrder=false): load-balances to h2 (0 active runs vs h1's 1).
  assert.equal((await runner.findMachine(account, [m1, m2]))?.id, 'h2');
  // preferOrder=true: honors candidate order (h1 at index 0) despite h1 having an active run.
  assert.equal((await runner.findMachine(account, [m1, m2], false, new Set(), undefined, true))?.id, 'h1');
});

test('residue that cannot be cleared keeps the Run open and tells the owner once', async (t) => {
  const f = fixture(t);
  const { task, run } = f.runningRun();
  const fake = fakeHost({ ...ALIVE, exit: 0 }, DONE_OUTPUT);
  const runner = runnerFor(f, fake);
  assert.equal(await runner.verify(run), 'running');
  assert.equal(await runner.verify(run), 'running');
  assert.equal(f.run(run.id).state, 'running', '进程还在就不能结算');
  const notices = f.peek<{ payload_json: string }>(`SELECT payload_json FROM outbox WHERE kind = 'verify'`);
  assert.equal(notices.length, 1, '每轮都通知就成了噪音');
  assert.equal((JSON.parse(notices[0]!.payload_json) as { finding: string }).finding, 'residue');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'run.residue_stuck'`).length, 1);
  assert.equal(f.peek(`SELECT 1 FROM message WHERE channel = 'internal' AND external_id = ?`, `residue:${run.id}`).length, 1);

  fake.state = { ...STARTED, exit: 0 };
  assert.equal(await runner.verify(run), 'ended');
  assert.equal(f.task(task.id).state, 'ready');
});

test('recover asks only the machines its Runs are on, and a machine that does not answer changes nothing', async (t) => {
  const f = fixture(t);
  const fake = fakeHost(ALIVE);
  const { run } = f.runningRun();
  holdMachine(f.ledger, testMachine('h3'), USER);
  const accounts = { t1: f.login.login, t2: { ...ACCOUNTS.t1!, id: 't2' }, t3: { ...ACCOUNTS.t1!, id: 't3', machines: ['h3'] } };
  const connected: string[] = [];
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger,
    adapters: { claude: claudeAdapter },
    logins: memoryLogins(accounts), machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect(machine) {
      connected.push(machine.host);
      // A machine that does not answer: every call it is asked fails, and the recovery
      // goes on without it.
      const down = async (): Promise<never> => Promise.reject(new Unreachable('断了'));
      if (machine.host === 'h3') return { ...fake.host, list: down, state: down };
      return fake.host;
    },
  });
  assert.deepEqual(await runner.recover(), [{ runId: run.id, verdict: 'running' }]);
  assert.ok(!connected.includes('h3'), '没有轮次在 h3 上，恢复不去问它');
});

test('a Run goes by the limit in its snapshot; a snapshot without one makes no Run', async (t) => {
  const f = fixture(t);
  const HOUR = 3_600_000;
  // The reason its Task is left with once a Run this old is looked at, null while it runs on.
  async function reasonAfter(ageMs: number, limitMs: number) {
    const task = f.queuedTask();
    const run = f.ledger.createRun(task.id, { ...f.login, snapshot: { brief: 'b', timeout_ms: limitMs } }, USER);
    f.ledger.markRunRunning(run.id);
    f.force(`UPDATE run SET created_at = ? WHERE id = ?`, new Date(Date.now() - ageMs).toISOString(), run.id);
    const fake = fakeHost(ALIVE);
    fake.stopped = () => {
      fake.state = STARTED;
    };
    // The Runner is not given the setting at all: only the dispatcher reads it, into the snapshot.
    const runner = createRunner({ ...RUNNER_TUNED, ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: memoryLogins({ ...ACCOUNTS, t1: { ...ACCOUNTS.t1!, id: f.login.login.id } }), machines: { get: f.ledger.getMachine, list: f.ledger.listMachines }, connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null) });
    await runner.tail(f.run(run.id));
    return f.task(task.id).reason;
  }
  assert.equal(await reasonAfter(2 * HOUR, HOUR), '超时', '按快照里记下的时限');
  assert.equal(await reasonAfter(HOUR, 2 * HOUR), null, '没到记下的时限不中断');
  // Every Run has a limit: a snapshot without one is broken, and is refused where Runs are made.
  const task = f.queuedTask();
  assert.throws(() => f.ledger.createRun(task.id, { ...f.login, snapshot: { brief: 'b' } }, USER), /没有执行时限/);
  assert.equal(f.task(task.id).state, 'queued', '拒了就没有这一轮，任务还在队列里');
});

// What this catches: a launcher that died after making started/ and before writing
// launcher.pid. Nothing on the machine can tell it from one paused there, so the machine
// keeps answering "the launcher is there" (runner/remote/owned.sh), and a machine that
// answers is never out of contact. Only the clock ends that wait; without it the Run would
// stay launching for ever.
test('a launcher that died before writing its pid: the Run waits, and the clock ends the wait', async (t) => {
  const f = fixture(t);
  const run = launchingRun(f);
  // started/ with no launcher.pid and no stop marker: what that machine says, round after round.
  const fake = fakeHost(LAUNCHING);
  fake.stopped = () => {
    fake.state = STARTED;
  };
  const runner = runnerFor(f, fake);
  for (let round = 0; round < 3; round += 1) await runner.verify(f.run(run.id));
  assert.equal(f.run(run.id).state, 'launching', '时限之内只是等着');
  assert.equal(fake.calls.includes('stop.sh'), false);

  f.force(`UPDATE run SET created_at = ? WHERE id = ?`, new Date(Date.now() - RUN_LIMIT_MS - 60_000).toISOString(), run.id);
  const controller = new AbortController();
  const polling = fake.host.state;
  fake.host.state = async (runDir) => {
    if (fake.calls.length >= 40) controller.abort();
    return polling(runDir);
  };
  await runner.watch(f.run(run.id), { intervalMs: 1, signal: controller.signal });
  assert.ok(fake.calls.includes('stop.sh'), '过了时限要发停止');
  assert.equal(f.run(run.id).exit_kind, 'interrupted');
  assert.equal(f.task(run.task_id).reason, '超时');
});

// §1.2, §11 step 5: a connection test of an account on a machine that came back by itself.
// The machine's own client reads its executors and answers, and
// what it reports is what the check says — with a stale report never passing for a fresh one.
const NODE_REPORT = {
  at: '2026-11-06T10:00:00.000Z',
  executors: [
    { executor: 'claude', installed: true, version: '2.1.303 (Claude Code)', logged_in: true },
    { executor: 'codex', installed: false, version: null, logged_in: null, error: '找不到 codex：查过 PATH' },
  ],
};

// A machine that came back by itself: its client answers, and there is no command line to ask.
function nodeBench(t: TestContext, answer: (machineId: string, timeoutMs: number) => Promise<ExecutorsAnswer> | ExecutorsAnswer) {
  const f = fixture(t);
  const machine = { id: 'mac-mini-01', host: 'mac-mini-01.local', nodeId: 'a1b2c3d4e5f60718' };
  const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };
  const fake = fakeHost(ALIVE);
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter, codex: codexAdapter },
    logins: memoryLogins({ t1: account }),
    machines: { get: (id) => (id === machine.id ? machine : undefined), list: () => [machine] },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null),
    executors: async (machineId, timeoutMs) => answer(machineId, timeoutMs),
  });
  return { runner, machine, fake, account };
}

// docs/design/accounts-machines-decoupled.md "控制台": an account's connection test asks one
// machine, online and with the executor, once — not every machine there is. Guards against a
// test that waits on every machine, one that asks a machine without the executor or one away,
// and one that has nowhere to ask passing for one that failed there.
test('账号的连接检查：挑一台在线、装了这个执行器的机器问一次', async (t) => {
  const f = fixture(t);
  const list = ['bare', 'away', 'ready', 'spare'].map((id, n) => ({ id, host: id, nodeId: String(n).padStart(16, '0') }));
  const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };
  const asked: string[] = [];
  const make = (installed: (id: string) => boolean, here: (id: string) => boolean) => createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter },
    logins: memoryLogins({ t1: account }),
    machines: { get: (id) => list.find((each) => each.id === id), list: () => list },
    connect: (machine) => { const fake = fakeHost(ALIVE); fake.host.connected = () => here(machine.id); return fake.host; },
    fits: (machineId) => installed(machineId),
    executors: async (machineId) => { asked.push(machineId); return { connected: true, fresh: true, report: NODE_REPORT }; },
  });
  const runner = make((id) => id !== 'bare', (id) => id !== 'away');
  assert.deepEqual(await runner.check(account), {
    machine_id: 'ready', host: 'ready', reachable: true, version: '2.1.303 (Claude Code)', logged_in: true,
  });
  assert.deepEqual(asked, ['ready'], '只问了一台：没装的、不在的都跳过');
  assert.equal(await make(() => false, () => true).check(account), null, '没有能问的机器就不问');
  assert.equal(await make(() => true, () => false).check(account), null);
  assert.deepEqual(asked, ['ready']);
});

test('账号的连接检查：读机器自己报的版本和登录，机器上不跑任何东西', async (t) => {
  const asked: { machineId: string; timeoutMs: number }[] = [];
  const { runner, fake, account } = nodeBench(t, (machineId, timeoutMs) => {
    asked.push({ machineId, timeoutMs });
    return { connected: true, fresh: true, report: NODE_REPORT };
  });
  const answer = await runner.check(account);
  assert.deepEqual(asked, [{ machineId: 'mac-mini-01', timeoutMs: CHECK_TIMEOUT_MS }], '问的是这台机器，时限是自己的那一个');
  assert.deepEqual(answer, {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: true,
    version: '2.1.303 (Claude Code)', logged_in: true,
  });
  assert.deepEqual(fake.calls, [], '节点机器上不跑任何脚本，也没有命令行可以问');
  // A machine's own login is checked on its machine only: one the host does not have is not
  // checked at all.
  assert.equal(await runner.check({ ...account, id: 'another-machine/claude', machine: 'another-machine' }), null);
});

test('账号的连接检查：机器没连回来时报的是它上次读到的，而且说了这是上次的', async (t) => {
  const { runner, account } = nodeBench(t, () => ({ connected: false, fresh: false, report: NODE_REPORT, problem: '机器 mac-mini-01 没有连回来' }));
  const answer = await runner.check(account);
  assert.deepEqual(answer, {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: false,
    version: '2.1.303 (Claude Code)', logged_in: true,
    error: '机器 mac-mini-01 没有连回来；下面是它上次报的',
  });
  // An account with its own token runs on the token, not on that machine's login, and this
  // check cannot try the token there: it says nothing about a login rather than showing the
  // machine's own as this account's (nodes.md §1.2, "两种来源在页面上分开写").
  const f = fixture(t);
  const machine = { id: 'mac-mini-01', host: 'mac-mini-01.local', nodeId: 'a1b2c3d4e5f60718' };
  const fake = fakeHost(ALIVE);
  const token = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter },
    logins: memoryLogins({ t1: account }),
    machines: { get: (id) => (id === machine.id ? machine : undefined), list: () => [machine] },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null),
    credential: () => ({ ref: 'ref-1', value: 'oauth-token' }),
    executors: async () => ({ connected: true, fresh: true, report: NODE_REPORT }),
  });
  assert.deepEqual(await token.check(account), {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: true,
    version: '2.1.303 (Claude Code)', logged_in: null,
  });
});

test('账号的连接检查：没装的执行器、执行器自己的说明、没问过它，都如实说', async (t) => {
  const { runner, account } = nodeBench(t, () => ({ connected: true, fresh: true, report: NODE_REPORT }));
  const codex = { ...account, executor: 'codex' };
  assert.deepEqual(await runner.check(codex), {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: true, version: null, logged_in: null,
    error: '找不到 codex：查过 PATH',
  });
  const report = { ...NODE_REPORT, executors: [{ executor: 'claude', installed: true, version: '2.1.303 (Claude Code)', logged_in: null, error: 'claude auth status 超过 6000 毫秒没有回答' }] };
  const { runner: other, account: same } = nodeBench(t, () => ({ connected: true, fresh: true, report }));
  assert.deepEqual(await other.check(same), {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: true, version: '2.1.303 (Claude Code)', logged_in: null,
    error: 'claude auth status 超过 6000 毫秒没有回答',
  });
  const { runner: silent, account: third } = nodeBench(t, () => ({ connected: true, fresh: true, report: { at: '2026-11-06T10:00:00.000Z', executors: [] } }));
  assert.deepEqual(await silent.check(third), {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: true, version: null, logged_in: null,
    error: '这台机器上的客户端没有报过 claude：它可能不认这个执行器',
  });
});

test('账号的连接检查：没有上报过，或者这台机器压根问不了，都说清楚', async (t) => {
  const { runner, account: named } = nodeBench(t, () => ({ connected: false, fresh: false, report: null, problem: '机器 mac-mini-01 没有连回来' }));
  assert.deepEqual(await runner.check(named), {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: false, version: null, logged_in: null,
    error: '机器 mac-mini-01 没有连回来；下面是它上次报的',
  });
  // A service wired without a node channel cannot ask such a machine at all, and says so
  // instead of reading it as one that is away.
  const f = fixture(t);
  const machine = { id: 'mac-mini-01', host: 'mac-mini-01.local', nodeId: 'a1b2c3d4e5f60718' };
  const fake = fakeHost(ALIVE);
  const account: Account = { ...ACCOUNTS.t1!, id: 'mac-mini-01/claude', machine: 'mac-mini-01' };
  const bare = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter },
    logins: memoryLogins({ t1: account }),
    machines: { get: (id) => (id === machine.id ? machine : undefined), list: () => [machine] }, connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null),
  });
  assert.deepEqual(await bare.check(account), {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: false, version: null, logged_in: null,
    error: '服务里没有这条到机器的通道；下面是它上次报的',
  });
  // And a machine that is asked and never answers does not hold a connection test past its
  // own deadline.
  const runner2 = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, checkTimeoutMs: 5,
    logins: memoryLogins({ t1: account }),
    machines: { get: (id) => (id === machine.id ? machine : undefined), list: () => [machine] },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null), executors: () => new Promise(() => {}),
  });
  assert.deepEqual(await runner2.check(account), {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: false, version: null, logged_in: null,
    error: '0.005 秒内没有回答',
  });
});

test('机器连接检查：节点机器是它的客户端现在答了一次', async (t) => {
  const { runner, machine } = nodeBench(t, () => ({ connected: true, fresh: true, report: NODE_REPORT }));
  assert.deepEqual(await runner.checkMachine(machine), { machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: true });

  // The machine is here but did not answer: that is not a machine that answered.
  const { runner: slow } = nodeBench(t, () => ({ connected: true, fresh: false, report: NODE_REPORT, problem: '机器 mac-mini-01 收到 probe 后没有回答' }));
  assert.deepEqual(await slow.checkMachine(machine), {
    machine_id: 'mac-mini-01', host: 'mac-mini-01.local', reachable: false, error: '机器 mac-mini-01 收到 probe 后没有回答',
  });

});

// What this catches: the runner handing a round to a machine on the strength of its last
// answer after that machine's client has gone away. The cache of a recent answer must come
// after the question "is its client here now": a client that went away a moment after
// answering is gone now. And a machine whose client is away is not one that failed to
// answer: nothing is probed, nothing is written into the failure cooldown, so the moment
// the client is back the machine is picked again (docs/design/nodes.md §4.4).
test('机器刚成功应答、随后 connected() 变成 false：下一次选机器不选它，也不产生一轮没启动的 Run、不写入失败冷却', async (t) => {
  const f = fixture(t);
  const machine = { id: 'mac-mini-01', host: 'mac-mini-01.local', nodeId: 'a1b2c3d4e5f60718' };
  const account: Account = { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } };
  const fake = fakeHost(ALIVE);
  let here = true;
  let probes = 0;
  const readRange = fake.host.readRange;
  fake.host.readRange = async (path, offset) => {
    probes++;
    return readRange(path, offset);
  };
  fake.host.connected = () => here;
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter },
    logins: memoryLogins({ t1: account }),
    machines: { get: (id) => (id === machine.id ? machine : undefined), list: () => [machine] },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null),
  });

  // Its client is here and it answers the probe: chosen, and its answer is remembered.
  assert.equal(await runner.findMachine(account, [machine]), machine);
  assert.equal(probes, 1);

  // The client goes away a moment later. The remembered answer does not make it a choice,
  // and it is not probed either: a machine whose client is away is not asked anything.
  here = false;
  assert.equal(await runner.findMachine(account, [machine]), undefined, '客户端不在就不选它，不管它刚才答得多好');
  assert.equal(probes, 1, '不在的机器不探测');
  assert.deepEqual(f.ledger.listActiveRuns(), [], '没选到机器就什么都不开：不留一轮没启动的 Run');

  // The client is back: picked at once, on the strength of the answer still fresh — a
  // failure cooldown written while it was away would have kept it out here.
  here = true;
  assert.equal(await runner.findMachine(account, [machine]), machine, '连回来当场可选，没有失败冷却挡着');
  assert.equal(probes, 1, '刚才的成功应答还新鲜，不用再探测');
});

// What §2's machine exception means for a round already placed: a folder source is on the
// machine the owner named, whatever the project's own machine list says. The Runner judges a
// round's place as the dispatcher chose it; reading the list again here would take a machine
// the owner named for one the owner removed, and settle the round as lost without asking it
// anything.
test('文件夹来源的一轮：机器不在项目的机器清单里也不算“机器被移除”', async (t) => {
  const f = fixture(t);
  holdMachine(f.ledger, testMachine('h2'), USER);
  // The machine the folder names, as the ledger holds it: its registration id is the one a
  // source carries, never the row's name.
  const h2 = f.ledger.getMachine('h2')!;
  const account: Account = { id: 'acct', name: 'acct', executor: 'claude', tiers: ACCOUNTS.t1!.tiers };
  f.ledger.putAccount(account, USER, 'ref-acct');
  // The project allows h1 alone; the Task's folder names h2, and the owner named it.
  f.ledger.setProjectMachines(f.projectId, [f.ledger.getMachine('h1')!.uid], USER);
  const task = f.queuedTask();
  const folder = { id: 's-folder', kind: 'folder' as const, machine_uid: h2.uid, path: '/srv/project' };
  // The project holds the item too: createRun checks the pin still stands against its list.
  f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([folder]), f.projectId);
  f.force('UPDATE task SET source_json = ? WHERE id = ?', JSON.stringify({
    source_id: folder.id,
    pinned: folder,
  }), task.id);
  const run = f.ledger.createRun(task.id, {
    login: account,
    machine: h2,
    snapshot: { ...LOGIN.snapshot, source: snapshotSourceOf(folder) },
    expectedRevision: 1,
  }, USER);
  const fake = fakeHost(ALIVE);
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter },
    logins: memoryLogins({ acct: account }),
    machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null),
  });
  assert.equal(await runner.verify(f.run(run.id)), 'running', '照旧去问那台机器，不判成被移除');
  assert.equal(f.run(run.id).exit_kind, null);
  assert.equal(f.run(run.id).error_json, null);
  assert.ok(fake.calls.includes('state.sh'), '真的去问了那台机器');
});

// §2 with §8.7: a repository round after its source's first one stays on the machine the
// checkout is on. A snapshot the machine would not take is a round that did not start — never
// a reason to clone the work afresh somewhere else and lose what that machine holds.
test('仓库来源的后续轮次：上传没送到也不换机器，这一轮判没起来', async (t) => {
  const f = fixture(t);
  holdMachine(f.ledger, testMachine('h2'), USER);
  const account: Account = { id: 'acct', name: 'acct', executor: 'claude', tiers: ACCOUNTS.t1!.tiers };
  f.ledger.putAccount(account, USER, 'ref-acct');
  const task = f.queuedTask();
  const snapshot = { ...LOGIN.snapshot, source: { kind: 'repo' as const, url: 'https://example.test/o/p.git', binding_key: 's-one-1a2b3c4d' } };
  const h1 = f.ledger.getMachine('h1')!;
  // The source's first round ran on h1: its checkout is in that machine's task directory.
  const first = f.ledger.createRun(task.id, { login: account, machine: h1, snapshot, expectedRevision: 1 }, USER);
  f.ledger.markRunRunning(first.id);
  f.ledger.settleRun(first.id, 0, DONE, {});
  f.ledger.updateTask(task.id, { goal: '接着做' }, USER);
  f.ledger.resumeTask(task.id, USER);
  const second = f.ledger.createRun(task.id, { login: account, machine: h1, snapshot, expectedRevision: f.task(task.id).revision }, USER);
  const fake = fakeHost(NOT_STARTED);
  fake.uploadFails = true;
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter },
    logins: memoryLogins({ acct: account }),
    machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter,()=>fake.state?.exit??null),
  });
  await runner.launch(second);
  assert.equal(f.run(second.id).host, 'h1', '没有换到另一台去重新 clone');
  assert.equal(f.run(second.id).exit_kind, 'lost');
  assert.equal(JSON.parse(f.run(second.id).error_json!).lost.basis, 'not_started', '没送到就是没起来，下一轮还等那台机器');
  assert.equal(fake.calls.filter((call) => call === 'start.sh').length, 0);
});
