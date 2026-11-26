// Guards a round that ended before version 18 against the step taking its history with it:
// the account it ran as was folded into a machine's own login and no longer exists, and
// that alone made its raw output unreadable, its product impossible to take over and its
// review impossible to bind — the owner's own ledger has exactly such rounds, run on the
// credential-less accounts the step folds. What a history read checks is the place the
// round is bound to (its machine, by the same node identity), never whether the login it
// ran as is still a login. And against the
// opposite mistake: a round whose machine is gone, or is now another machine under the same
// name, is still not read from.
import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { createRunner } from '../runner/runner.ts';
import type { RemoteHost } from '../runner/host.ts';
import { createAcceptor } from '../service/accept.ts';
import { openLedger } from '../service/ledger.ts';
import { createLogins } from '../service/logins.ts';
import { PRESET_ROLES } from '../shared/roles.ts';
import { RUNNER_TUNED, USER, holdMachine, testMachine } from './helpers.ts';

const V17 = readFileSync(new URL('./fixtures/ledger/schema-v17.sql', import.meta.url), 'utf8');
const AT = '2026-11-01T00:00:00.000Z';
const EXECUTORS = { claude: claudeAdapter, codex: codexAdapter };
const REPORT = Buffer.from('# 做完了\n');
// One line of codex's recorded output (tests/fixtures/codex): what the round said.
const OUTPUT = Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '好的。' } })}\n`);
const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

// The owner's shape, as version 17 left it: a codex account with no token of its own,
// naming the one machine it was signed in on, and a Task it finished there waiting to be
// accepted. The round's snapshot is version 17's: an `account`, no `login`.
function finishedBeforeTheStep(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-history17-'));
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec(V17);
  conn.prepare('INSERT INTO setting (id, created_at, key, value_json) VALUES (?, ?, ?, ?)').run('s-version', AT, 'schema_version', '17');
  // The preset roles, as every ledger since version 16 holds them.
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) role.run(each.id, AT, AT, each.name, each.description, each.default_tier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  // A machine whose client joined: one that never did is gone at version 24.
  conn.prepare('INSERT INTO machine (id, created_at, updated_at, host, ssh_config, node_id, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run('DEV-WORKSTATION', AT, AT, 'me@dev-workstation', null, 'node-dp', 'token-dp');
  conn.prepare(`INSERT INTO account (id, created_at, updated_at, executor, config_dir, tiers_json, permission_mode, timeout_ms, max_runs, machines_json, credential_ref)
    VALUES (?, ?, ?, 'codex', NULL, ?, NULL, NULL, NULL, '["DEV-WORKSTATION"]', NULL)`).run('local-codex', AT, AT, '{"execute":{"kind":"content","text":"model=\\"<甲>\\"\\n"}}');
  conn.prepare('INSERT INTO project (id, created_at, name, accounts_json, machines_json) VALUES (?, ?, ?, ?, ?)').run('p1', AT, '主项目', '["local-codex"]', '[]');
  conn.prepare(`INSERT INTO task (id, created_at, project_id, title, goal, acceptance, account_id, role_id, state, created_by)
    VALUES ('k-done', ?, 'p1', '做完的', '目标', '验收', 'local-codex', 'implement', 'ready', 'router')`).run(AT);
  const snapshot = { brief: 'b', executor: 'codex', timeout_ms: 1000, account: { executor: 'codex', machines: ['DEV-WORKSTATION'] }, machine: { host: 'me@dev-workstation', ssh_config: null } };
  conn.prepare(`INSERT INTO run (id, created_at, task_id, task_revision, account_id, host, machine_id, node_id, state, marker, exit_code, exit_kind, receipt_json, snapshot_json, started_at, ended_at)
    VALUES ('r-done', ?, 'k-done', 1, 'local-codex', 'me@dev-workstation', 'DEV-WORKSTATION', 'node-dp', 'ended', 'tycho-run:r-done', 0, 'completed', ?, ?, ?, ?)`)
    .run(AT, JSON.stringify({ status: 'done', summary: '完成', artifacts: [{ kind: 'report', ref: 'report.md' }] }), JSON.stringify(snapshot), AT, AT);
  // Old snapshots had no registration ID, but the audit sequence still proves placement.
  const change = conn.prepare('INSERT INTO change (id, created_at, at, actor, task_id, run_id, action, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  change.run('joined', AT, AT, 'user', null, null, 'machine.join', JSON.stringify({ machine_id: 'DEV-WORKSTATION' }));
  change.run('placed', AT, AT, 'runner', 'k-done', 'r-done', 'run.create', '{}');
  conn.close();

  const ledger = openLedger(path, { log: () => {} });
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const logins = createLogins({ ledger, accounts: { get: ledger.getAccount, list: ledger.listAccounts }, executors: EXECUTORS });
  const asked: string[] = [];
  const host: RemoteHost = {
    async place() { return []; },
    async start() { return { code: 0, stdout: '', stderr: '', confirmed: true }; },
    async stop() {},
    async state() { return { started: true, launcher_alive: false, pid_alive: false, marked: false, exit: 0, unknown: null }; },
    async list() { return []; },
    async artifacts() { asked.push('artifacts'); return [{ name: 'report.md', sha256: sha(REPORT), bytes: REPORT.length }]; },
    async dropRun() {},
    connected: () => true,
    async readRange(file, offset) {
      asked.push(basename(file));
      const body = basename(file) === 'stdout.ndjson' ? OUTPUT : REPORT;
      return { bytes: body.subarray(offset), size: body.length, mtime: 1 };
    },
  };
  const runner = createRunner({
    ...RUNNER_TUNED, ledger, adapters: EXECUTORS, logins,
    machines: { get: ledger.getMachine, list: ledger.listMachines },
    connect: () => host, log: () => {},
  });
  const accept = createAcceptor({ ledger, runner, dataDir: dir });
  return { ledger, runner, accept, asked, dir };
}

test('a round that ended on an account the step folded is still read, taken over and reviewed', async (t) => {
  const { ledger, runner, accept, asked, dir } = finishedBeforeTheStep(t);
  assert.equal(ledger.getAccount('local-codex'), undefined, '这个账号已经并成了机器自己的登录');
  const run = ledger.getRun('r-done');
  assert.match(run.login_id!, /^[0-9A-HJKMNP-TV-Z]{26}$/, '已结束的一轮迁移为独立的历史登录编号');
  assert.equal(run.login_name, 'local-codex', '已结束的一轮留着它当时的名字');
  ledger.putAccount({ id: 'replacement', name: 'local-codex', executor: 'claude', tiers: {} }, USER, 'test-ref');
  assert.notEqual(ledger.getRun(run.id).login_id, 'replacement', '同名新登录接不到历史引用');

  const events = await runner.loadEvents(run);
  assert.ok(JSON.stringify(events).includes('好的。'), '原始输出读得到');
  const taken = await runner.fetchArtifacts(run, join(dir, 'taken'));
  assert.deepEqual([taken.files.map(({ name }) => name), taken.problem], [['report.md'], null], '产物取得回来');
  assert.ok(asked.includes('artifacts'), '真的去机器上问了');

  // Bound for review: the round and revision the reviewer will look at, from its registration.
  const registered = await accept.register('k-done');
  assert.equal(registered.runId, 'r-done');
  const review = ledger.createTask({ projectId: 'p1', title: '审', goal: '审', acceptance: '结论', roleId: 'review', reviewOf: { taskId: 'k-done', ...registered } }, { actor: 'router' });
  assert.equal(JSON.parse(ledger.getTask(review.id).review_of_json!).run_id, 'r-done');
});

test('a round whose machine is gone, or is another machine under its name now, is not read from', async (t) => {
  const { ledger, runner, asked, dir } = finishedBeforeTheStep(t);
  holdMachine(ledger, testMachine('DEV-WORKSTATION', 'someone@else'), USER);
  await assert.rejects(runner.loadEvents(ledger.getRun('r-done')), /机器/);
  assert.match((await runner.fetchArtifacts(ledger.getRun('r-done'), join(dir, 'never-written'))).problem ?? '', /机器/);
  ledger.deleteMachine('DEV-WORKSTATION', USER, { confirmed: true });
  await assert.rejects(runner.loadEvents(ledger.getRun('r-done')), /机器/);
  assert.deepEqual(asked, [], '一次都没有去问');
});
