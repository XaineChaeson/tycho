// Guards the full service wiring: startup orphan cleanup, a Claude login reaching the store
// through service.accounts.setCredential (the same entrance the login window uses) and from
// there launch/check, rejection returning work to the queue, and replacement taking effect
// without a restart or exposing either token in reads and logs. The HTTP credential route is
// refused for Claude here; its success path for a key-typed account is covered in
// tests/account-credential-http.test.ts. An account is its token, so there is no way to take it
// off and keep the account.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { accountCredentialFile } from '../service/secrets.ts';
import { signIn, stage, until } from './stage.ts';
import { claudeTier, USER } from './helpers.ts';

const TOKEN = 'service-private-token-first';
const NEXT = 'service-private-token-next';

test('service keeps, sends, rejects and replaces a token; startup removes orphan files', { timeout: 60_000 }, async t => {
  const s = stage(t, { t1: { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } } }, ['h1']);
  const dir = join(s.dataDir, 'secrets', 'accounts');
  mkdirSync(dir, { recursive: true });
  const orphan = join(dir, 'removed');
  writeFileSync(orphan, 'orphan-token');
  writeFileSync(join(dir, 't1.new'), 'unfinished-token');
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => { logs.push(line); });
  const service = await s.start();
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(join(dir, 't1.new')), false);
  const c = await signIn(service);
  const send = (method: string, value?: string) => fetch(c.base + '/api/accounts/t1/credential', {
    method, headers: { Cookie: c.cookie, Origin: c.base, 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
  });
  // A Claude login reaches the store from the login window, never from a form: the store's
  // own entrance is what that window calls.
  assert.equal((await send('PUT', TOKEN)).status, 400, '页面递交的 Claude 登录不收');
  service.accounts.setCredential('t1', TOKEN, USER);
  const firstRef = service.ledger.accountCredentialRef('t1');
  assert.ok(firstRef);
  assert.equal((await c.post('/api/accounts/t1/check')).status, 200);
  const task = s.queued(service);
  const first = await s.launched(service, task);
  assert.equal(JSON.parse(service.ledger.getRun(first.id).snapshot_json).credential_ref, firstRef, '这一轮按当时的令牌编号启动，机器自己来取');
  Object.assign(s.remote.runOf(first.id), { stdout: JSON.stringify({ type: 'result', is_error: true,
    result: 'Not logged in', api_error_status: 401, session_id: 'managed-session' }) + '\n', exit: 1,
    pid_alive: false, marked: false, launcher_alive: false });
  await until(() => service.ledger.getRun(first.id).state === 'ended', '令牌失效这一轮结算');
  assert.equal(service.ledger.getRun(first.id).exit_kind, 'auth');
  assert.equal(service.ledger.getTask(task.id).state, 'queued');
  const rejected = await c.get('/api/accounts');
  assert.equal((await rejected.json() as any).accounts[0].credential, 'rejected');
  service.accounts.setCredential('t1', NEXT, USER);
  assert.notEqual(service.ledger.accountCredentialRef('t1'), firstRef);
  assert.equal(existsSync(accountCredentialFile(s.dataDir, firstRef!)), false, '换令牌后旧文件删掉');
  const second = await until(() => service.ledger.listRuns(task.id).find(run => run.id !== first.id), '重填后继续派发');
  await until(() => s.remote.called('start.sh', second.id) > 0, '新令牌交给下一轮');
  assert.equal(JSON.parse(service.ledger.getRun(second.id).snapshot_json).credential_ref, service.ledger.accountCredentialRef('t1'));
  s.remote.finish(second.id, { status: 'done', summary: 'done', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  await until(() => service.ledger.getTask(task.id).state === 'ready', '任务汇报');
  const secondRef = service.ledger.accountCredentialRef('t1')!;
  // Taking the token off is not a thing the service does: the account would be no login.
  assert.equal((await send('DELETE')).status, 404);
  assert.equal(service.ledger.accountCredentialRef('t1'), secondRef);
  assert.ok(existsSync(accountCredentialFile(s.dataDir, secondRef)));
  const reads = await Promise.all(['/api/accounts', '/api/state', '/api/settings',
    '/api/runs/' + first.id + '/snapshot', '/api/runs/' + first.id + '/trace',
    '/api/runs/' + first.id + '/events'].map(async path => (await c.get(path)).text()));
  const ledgerFile = new DatabaseSync(join(s.dataDir, 'ledger.db'), { readOnly: true });
  const changes = ledgerFile.prepare('SELECT * FROM change').all();
  ledgerFile.close();
  const evidence = JSON.stringify({ reads, logs, changes,
    runs: service.ledger.listRuns(task.id), events: service.runner.events(first.id) });
  for (const token of [TOKEN, NEXT]) assert.ok(!evidence.includes(token));
});
