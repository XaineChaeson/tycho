// What this guards against: the secret a round was handed leaving the round by way of its
// output (docs/design/native-login.md, ruling G). An executor that takes its key from the
// environment hands it to everything it starts, and a model can print what it finds there; the
// Runner's reading is where output turns into ledger rows, page events and pushes. Each test
// is one way the key could get past it: in the live events, in the settled result, in the
// history read back later, cut across two blocks, or written the way JSON escapes it.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { HIDDEN_TEXT, hider } from '../runner/redact.ts';
import { createRunner } from '../runner/runner.ts';
import { prepareSnapshot } from '../runner/snapshot.ts';
import type { Login } from '../runner/snapshot.ts';
import { redactDiagnosticText, redactWorkerDiagnosticText, routerCallText, routerTurnText } from '../service/router-call-text.ts';
import { fakeRemote } from './fake-remote.ts';
import { fixture, USER, MACHINE, memoryLogins, memoryMachines, LOGIN, RUNNER_TUNED, RUN_LIMIT_MS } from './helpers.ts';

const KEY = 'sk-printed-private-key-9041';

test('every occurrence of a known secret is replaced, and nothing else is touched', () => {
  const hide = hider([KEY, undefined]);
  assert.equal(hide(`a ${KEY} b ${KEY}`), `a ${HIDDEN_TEXT} b ${HIDDEN_TEXT}`);
  assert.equal(hide('nothing here'), 'nothing here');
  assert.equal(hider([])('x'), 'x');
  assert.equal(hider([undefined])(KEY), KEY, '没有已知的密钥就什么都不动');
});

test('a word too short to be a secret is left alone; a secret inside a longer one goes whole', () => {
  assert.equal(hider(['abc'])('abc abc'), 'abc abc');
  assert.equal(hider(['12345678', '12345678-longer'])('x 12345678-longer y'), `x ${HIDDEN_TEXT} y`);
});

test('a secret is recognised as a JSON string carries it', () => {
  const odd = 'pass"word\\with/édge';
  const line = JSON.stringify({ type: 'text', text: `the key is ${odd}` });
  const hidden = hider([odd])(line);
  assert.ok(!hidden.includes('pass'));
  assert.equal(JSON.parse(hidden).text, `the key is ${HIDDEN_TEXT}`, '替换之后仍是一行合法的 JSON');
});

function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t);
  const account: Login = { id: 'k1', name: 'k1', executor: 'claude', tiers: LOGIN.login.tiers };
  const accounts = memoryLogins({ [account.id]: account }, f.ledger);
  f.ledger.recordAccountCredential(account.id, 'ref-1', USER);
  const remote = fakeRemote();
  // What the login holds now: the test replaces it while a round runs.
  const holds = { ref: 'ref-1', value: KEY };
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: { claude: claudeAdapter }, logins: accounts,
    machines: memoryMachines({ [MACHINE.id]: MACHINE }, f.ledger), connect: remote.connect,
    credential: () => ({ ...holds }), log: () => {},
  });
  const task = f.ledger.createTask({ projectId: f.projectId, title: 'redact', goal: 'g', acceptance: '测试通过', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  const snapshot = prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS });
  const run = f.ledger.createRun(task.id, { login: account, machine: f.ledger.getMachine('h1')!, snapshot, expectedRevision: task.revision }, USER);
  return { f, remote, runner, run, holds };
}

test('the key a round was handed is hidden even after the owner replaced it', async (t) => {
  const { f, remote, runner, run, holds } = setup(t);
  await runner.launch(run);
  Object.assign(holds, { ref: 'ref-2', value: 'sk-the-replacement-key-0007' });
  remote.finish(run.id, { status: 'done', summary: `done, the key was ${KEY}`, artifacts: [] });
  await runner.settle(f.run(run.id));
  const history = await runner.loadEvents(f.run(run.id));
  assert.ok(!JSON.stringify({ rows: f.dump(), events: runner.events(run.id), history }).includes(KEY));
});

test('a key the round printed is in neither the settled result, the events, nor the history read back', async (t) => {
  const { f, remote, runner, run } = setup(t);
  await runner.launch(run);
  // The model echoed its environment, and then quoted it again in its receipt.
  remote.finish(run.id, { status: 'done', summary: `done, the key was ${KEY}`, artifacts: [] });
  const said = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${KEY}" https://example.com` } }] } });
  remote.runOf(run.id).stdout = `${said}\n${remote.runOf(run.id).stdout}`;
  await runner.settle(f.run(run.id));
  assert.equal(f.run(run.id).exit_kind, 'completed', '隐去密钥不改变这一轮的结论');
  const history = await runner.loadEvents(f.run(run.id));
  const everything = JSON.stringify({ rows: f.dump(), events: runner.events(run.id), history });
  assert.ok(!everything.includes(KEY));
  assert.ok(JSON.stringify(history).includes(HIDDEN_TEXT), '原来的位置写明隐去了什么');
  assert.ok(JSON.stringify(f.dump()).includes(HIDDEN_TEXT));
});

test('runner hides the host-managed GitHub token even after it is disconnected, and diagnostic redactors mask GitHub token prefixes', async (t) => {
  const f = fixture(t);
  const account: Login = { id: 'k1', name: 'k1', executor: 'claude', tiers: LOGIN.login.tiers };
  const accounts = memoryLogins({ [account.id]: account }, f.ledger);
  f.ledger.recordAccountCredential(account.id, 'ref-1', USER);
  const remote = fakeRemote();
  const GH_PAT = 'custom_non_prefixed_gh_secret_987654';
  let currentGithubToken: string | null = GH_PAT;
  const runner = createRunner({
    ...RUNNER_TUNED,
    ledger: f.ledger,
    adapters: { claude: claudeAdapter },
    logins: accounts,
    machines: memoryMachines({ [MACHINE.id]: MACHINE }, f.ledger),
    connect: remote.connect,
    credential: () => ({ ref: 'ref-1', value: KEY }),
    githubToken: () => currentGithubToken,
    log: () => {},
  });
  const task = f.ledger.createTask({ projectId: f.projectId, title: 'gh-redact', goal: 'g', acceptance: '测试通过', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  const snapshot = prepareSnapshot(task, account, { claude: claudeAdapter }, { timeoutMs: RUN_LIMIT_MS });
  const run = f.ledger.createRun(task.id, { login: account, machine: f.ledger.getMachine('h1')!, snapshot, expectedRevision: task.revision }, USER);
  await runner.launch(run);
  // Disconnect GitHub token mid-run: handedGithub must still redact it from output and receipt.
  currentGithubToken = null;
  remote.finish(run.id, { status: 'done', summary: `pushed with ${GH_PAT}`, artifacts: [] });
  await runner.settle(f.run(run.id));
  const history = await runner.loadEvents(f.run(run.id));
  const everything = JSON.stringify({ rows: f.dump(), events: runner.events(run.id), history });
  assert.equal(everything.includes(GH_PAT), false);
  assert.ok(everything.includes(HIDDEN_TEXT));

  // Diagnostic/router text redactors mask all standard GitHub token prefixes standalone.
  const samples = [
    'ghp_1234567890abcdef123456',
    'gho_abcdef1234567890abcd',
    'ghu_9876543210fedcba9876',
    'ghs_serverToken123456789',
    'ghr_refreshToken12345678',
    'github_pat_11AAAAAA_0123456789abcdef',
  ];
  const passthrough = (text: string) => text;
  for (const token of samples) {
    assert.equal(redactDiagnosticText(`leaked ${token} here`, passthrough), `leaked ${HIDDEN_TEXT} here`);
    assert.equal(redactWorkerDiagnosticText(`echo ${token}`, passthrough), `echo ${HIDDEN_TEXT}`);
    assert.equal(routerTurnText(`output: ${token}`, passthrough), `output: ${HIDDEN_TEXT}`);
    assert.equal(routerCallText({ note: `saw ${token}` }, passthrough).includes(token), false);
  }
});
