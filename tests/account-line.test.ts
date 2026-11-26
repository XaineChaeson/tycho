// What this guards against, for an account that is a line to a model service and its key
// (docs/design/native-login.md, the dsh account):
//   - the key reaching the ledger, the audit trail, a snapshot or the start command;
//   - an account of such an executor standing without a line, or a later write of its tiers
//     quietly dropping the line it has;
//   - a tier that names another line, or turns the stored credentials back on, being saved or
//     sent: the round would run as whatever the machine has stored;
//   - a round starting on a line that changed between its snapshot and its Run;
//   - a ledger of version 27 losing an account on the way to 28.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { createRunner } from '../runner/runner.ts';
import { prepareSnapshot, roundTurn, snapshotFiles } from '../runner/snapshot.ts';
import { createAccounts } from '../service/accounts.ts';
import { SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { MATERIALS_PLACEHOLDER } from '../shared/node-protocol.ts';
import { openLedger } from '../service/ledger.ts';
import { fakeRemote } from './fake-remote.ts';
import { fixture, USER, MACHINE, memoryMachines, RUNNER_TUNED, RUN_LIMIT_MS } from './helpers.ts';

const KEY = 'sk-line-private-key-55';
const EXECUTORS = { claude: claudeAdapter, dsh: dshAdapter };
const tierOn = (route: string, model = 'm1') => ({ kind: 'content' as const, text: `- id: agent-default-model\n  config:\n    provider: ${route}\n    model: ${model}\n    reasoningEffort: high\n` });
const CUSTOM = { line: 'custom', api: 'openai-completions', baseURL: 'http://10.0.0.8:53000/v1', models: [{ id: 'm1', efforts: ['high', 'max'] }] };
const custom = { executor: 'dsh', provider: CUSTOM, tiers: { execute: tierOn('tycho'), decide: tierOn('tycho') }, credential: KEY };

function setup(t: TestContext) {
  const f = fixture(t, {}, false);
  const accounts = createAccounts({ ledger: f.ledger, executors: EXECUTORS, credentialExecutors: ['claude', 'dsh'], dataDir: f.dir, log: () => {} });
  return { f, accounts };
}

test('a dsh account is a line and its key: the line is kept as checked, the key nowhere in the ledger', (t) => {
  const { f, accounts } = setup(t);
  const { account, created } = accounts.put({ name: 'ty-local', ...custom }, USER);
  assert.equal(created, true);
  assert.deepEqual(account.provider, CUSTOM);
  assert.equal(accounts.credentialOf(account.id)!.value, KEY);
  assert.ok(!JSON.stringify(f.dump()).includes(KEY), '密钥不进账本、不进审计');
  const made = f.peek<{ detail_json: string }>("SELECT detail_json FROM change WHERE action = 'account.create'")[0]!;
  assert.deepEqual(JSON.parse(made.detail_json).account.provider, CUSTOM, '审计记下线路本身');
});

test('such an account never stands without a line, and no other executor\'s account has one', (t) => {
  const { accounts } = setup(t);
  assert.throws(() => accounts.put({ name: 'a', executor: 'dsh', tiers: custom.tiers, credential: KEY }, USER), /要有一条线路/);
  assert.throws(() => accounts.put({ name: 'a', ...custom, provider: { ...CUSTOM, baseURL: 'https://u:p@x/v1' } }, USER), /线路：.*用户名和密码/);
  assert.throws(() => accounts.put({ name: 'a', ...custom, credential: undefined }, USER), /令牌|密钥/);
  assert.throws(() => accounts.put({ name: 'c', executor: 'claude', provider: CUSTOM, tiers: { execute: { kind: 'content', text: '{"model":"m"}' } }, credential: KEY }, USER), /没有线路这一说/);
});

test('a later write that names no line keeps the one the account has; one that names another replaces it', (t) => {
  const { f, accounts } = setup(t);
  const { account } = accounts.put({ name: 'ty-local', ...custom }, USER);
  const tiers = { execute: tierOn('tycho', 'm2') };
  const kept = accounts.put({ id: account.id, name: 'ty-local', executor: 'dsh', tiers }, USER).account;
  assert.deepEqual(kept.provider, CUSTOM);
  assert.equal(accounts.credentialOf(account.id)!.value, KEY, '密钥也还是原来那把');
  const official = accounts.put({ id: account.id, name: 'ty-local', executor: 'dsh', provider: { line: 'official' }, tiers: { execute: tierOn('deepseek-official') } }, USER).account;
  assert.deepEqual(official.provider, { line: 'official' });
  const changes = f.peek<{ detail_json: string }>("SELECT detail_json FROM change WHERE action = 'account.update' ORDER BY seq").map(({ detail_json }) => JSON.parse(detail_json).changed);
  assert.deepEqual(changes.at(-1).provider, { from: CUSTOM, to: { line: 'official' } });
});

test('tiers are accepted without regex policing because line.patch.yml structurally overrides credentials and route at launch', (t) => {
  const { accounts } = setup(t);
  const saved = accounts.put({
    name: 'a',
    ...custom,
    tiers: {
      execute: tierOn('deepseek-official'),
      decide: { kind: 'content', text: `- id: credentials\n  disabled: false\n${tierOn('tycho').text}` },
    },
  }, USER);
  assert.equal(saved.created, true);
  assert.deepEqual(saved.account.provider, CUSTOM);
});

function running(t: TestContext) {
  const { f, accounts } = setup(t);
  const { account } = accounts.put({ name: 'ty-local', ...custom }, USER);
  const remote = fakeRemote();
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger, adapters: EXECUTORS, logins: accounts,
    machines: memoryMachines({ [MACHINE.id]: MACHINE }, f.ledger), connect: remote.connect,
    credential: (id) => accounts.credentialOf(id), log: () => {},
  });
  const task = f.ledger.createTask({ projectId: f.projectId, title: 'line', goal: 'g', acceptance: '测试通过', roleId: 'implement' }, USER);
  f.ledger.queueTask(task.id, USER);
  return { f, accounts, account, remote, runner, task };
}

test('a round of the account is sent its line as a file of the snapshot, and started with the line after the tier', async (t) => {
  const { f, accounts, account, remote, runner, task } = running(t);
  const snapshot = prepareSnapshot(task, accounts.get(account.id)!, EXECUTORS, { timeoutMs: RUN_LIMIT_MS });
  assert.equal(snapshot.line!.file, 'line.patch.yml');
  assert.ok(snapshot.line!.text.includes('baseURL: "http://10.0.0.8:53000/v1"'));
  const files = snapshotFiles(snapshot).map(({ path }) => path);
  assert.ok(files.includes('line.patch.yml') && files.includes('tier.patch.yml'));
  const run = f.ledger.createRun(task.id, { login: accounts.get(account.id)!, machine: f.ledger.getMachine('h1')!, snapshot, expectedRevision: task.revision }, USER);
  // The path names the material's place, not an absolute one: the Worker's working directory is
  // the source's, so the machine fills the placeholder in when it starts the round
  // (node/watch.ts fillPlaces; docs/design/code-sources.md §2). The host sends it as it is.
  assert.equal(roundTurn(snapshot, run.id).linePath, `${MATERIALS_PLACEHOLDER}/line.patch.yml`);
  await runner.launch(run);
  const start = remote.calls.find((call) => call.script === 'start.sh')!;
  // The start names the variable the key is read from (fake-remote keeps it third), never the key.
  assert.equal(start.args![2], 'TYCHO_DSH_API_KEY');
  const patches = start.args!.flatMap((arg, at) => (arg === '--patch' ? [start.args![at + 1]] : []));
  assert.deepEqual(patches, [`${MATERIALS_PLACEHOLDER}/tier.patch.yml`, `${MATERIALS_PLACEHOLDER}/line.patch.yml`]);
  const everything = JSON.stringify({ start, rows: f.dump(), files: snapshotFiles(snapshot) });
  assert.ok(!everything.includes(KEY), '密钥不在启动命令、快照和账本里');
  remote.finish(run.id, { status: 'done', summary: 'done', artifacts: [] });
});

test('a line changed between the snapshot and the Run is not the one this round was prepared for', (t) => {
  const { f, accounts, account, task } = running(t);
  const before = accounts.get(account.id)!;
  const snapshot = prepareSnapshot(task, before, EXECUTORS, { timeoutMs: RUN_LIMIT_MS });
  accounts.put({ id: account.id, name: 'custom-gw', executor: 'dsh', provider: { ...CUSTOM, baseURL: 'http://10.0.0.9:53000/v1' }, tiers: custom.tiers }, USER);
  assert.throws(() => f.ledger.createRun(task.id, { login: before, machine: f.ledger.getMachine('h1')!, snapshot, expectedRevision: task.revision }, USER), /改过/);
});

test('27 → 28 keeps every account as it was, with no line; reopening holds', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-line-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'ledger.db');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('./fixtures/ledger/schema-v27.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('version', 'now', 'schema_version', '27');
    INSERT INTO account (id, name, created_at, updated_at, executor, tiers_json, credential_ref) VALUES ('01A', 'claude', 'now', 'now', 'claude', '{"execute":{"kind":"content","text":"{}"}}', 'ref');`);
  db.close();
  assert.equal(SCHEMA_VERSION, 48);
  for (const round of [1, 2]) {
    const ledger = openLedger(path, { copyBeforeUpgrade: false });
    try {
      const [account] = ledger.listAccounts();
      assert.equal(account!.name, 'claude', `第 ${round} 次打开`);
      assert.equal(account!.provider, undefined);
      assert.equal(ledger.accountCredentialRef('01A'), 'ref');
    } finally { ledger.close(); }
  }
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});
