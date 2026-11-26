// Guards against credential readback from any console read surface, writes outside
// login/Origin/recovery gates, unsupported executors storing a token, and lost auditing. And
// against a page handing over a login its executor obtains elsewhere (docs/design/native-login.md
// §5): a Claude login is made on Claude's own page, so neither making an account nor replacing a
// credential may take one from a form — not a word of it kept — while the rest of such an
// account stays the owner's to edit.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { consoleApp } from './console-helpers.ts';
import { fixture, USER } from './helpers.ts';

const TOKEN = 'http-account-private-token-842';

// An account whose secret the owner types: a Codex API key.
async function keyed(app: Awaited<ReturnType<typeof consoleApp>>): Promise<string> {
  const made = await app.send('POST', '/api/accounts', { executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m\n' } }, credential: 'first-key-of-the-account' });
  assert.equal(made.status, 201);
  return ((await made.json()) as { account: { id: string } }).account.id;
}

test('credential endpoints write only, return state, and leave no token in any read interface', async t => {
  const app = await consoleApp(t);
  const id = await keyed(app);
  const response = await app.send('PUT', `/api/accounts/${id}/credential`, { value: TOKEN });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).account.credential, 'set');
  const { run, task } = app.f.runningRun();
  for (const path of ['/api/accounts', '/api/machines', '/api/settings', '/api/state', '/api/summary', '/api/overview',
    '/api/tasks', '/api/tasks/' + task.id, '/api/runs/' + run.id + '/snapshot',
    '/api/runs/' + run.id + '/trace', '/api/runs/' + run.id + '/events', '/api/messages', '/api/approvals']) {
    const result = await app.get(path);
    assert.equal(result.status, 200, path);
    assert.ok(!(await result.text()).includes(TOKEN), path);
  }
  assert.ok(!JSON.stringify(app.f.dump()).includes(TOKEN));
  // There is no clearing it: an account is a login tycho keeps.
  assert.equal((await app.send('DELETE', `/api/accounts/${id}/credential`)).status, 404);
  assert.equal(app.f.ledger.getAccount(id) !== undefined && app.f.ledger.accountCredentialRef(id) !== null, true);
  assert.deepEqual(app.f.peek<{ action: string }>("SELECT action FROM change WHERE action LIKE 'account.credential%' ORDER BY seq").map(c => c.action),
    ['account.credential_set']);
});

test('a login made on the executor\'s own page is never taken from a page: both ways refuse, nothing is kept, the rest can still be edited', async t => {
  const app = await consoleApp(t);
  // An account whose secret is typed, for the path that changes an existing account's executor:
  // it must be made before the baselines below, because making it is a change of its own.
  const codex = await keyed(app);
  const codexRef = app.f.ledger.accountCredentialRef(codex);
  const before = app.f.ledger.accountCredentialRef('t1');
  const count = () => app.f.ledger.listAccounts().length;
  const accounts = count();
  const audited = () => app.f.peek<{ n: number }>("SELECT count(*) AS n FROM change WHERE action LIKE 'account.%'")[0]!.n;
  const audits = audited();
  const secretDir = join(app.f.dir, 'secrets', 'accounts');
  const secretFiles = () => existsSync(secretDir) ? readdirSync(secretDir).sort() : [];
  const files = secretFiles();
  const tiers = { execute: { kind: 'content', text: '{"model":"m"}' } };
  const refusals = [
    await app.send('PUT', '/api/accounts/t1/credential', { value: TOKEN }),
    await app.send('PUT', '/api/accounts/t1', { credential: TOKEN }),
    await app.send('POST', '/api/accounts', { executor: 'claude', tiers, credential: TOKEN }),
    await app.send('POST', '/api/accounts', { name: 'typed', executor: 'claude', tiers }),
    // The executor name is the request's, not a key to look up on the prototype.
    await app.send('POST', '/api/accounts', { executor: 'constructor', tiers, credential: TOKEN }),
    await app.send('POST', '/api/accounts', { executor: '__proto__', tiers, credential: TOKEN }),
    await app.send('PUT', `/api/accounts/${codex}`, { executor: 'claude', tiers, credential: TOKEN }),
  ];
  for (const refused of refusals) {
    assert.equal(refused.status, 400);
    const said = await refused.text();
    assert.match(said, /不在账号表单里填/);
    assert.ok(!said.includes(TOKEN));
  }
  assert.equal(app.f.ledger.accountCredentialRef('t1'), before, '原来的登录没动');
  assert.equal(count(), accounts, '没有多出账号');
  assert.equal(app.accounts.get(codex)!.executor, 'codex', '换执行器没发生');
  assert.equal(app.f.ledger.accountCredentialRef(codex), codexRef, '它的凭据没换');
  assert.ok(!JSON.stringify(app.f.dump()).includes(TOKEN), '一个字也没写下');
  assert.equal(audited(), audits, '没有记下任何改动');
  assert.deepEqual(secretFiles(), files, '被拒的请求没在凭据目录里留下文件');
  // What is not its login is still the owner's to change here.
  const held = app.accounts.get('t1')!;
  assert.equal((await app.send('PUT', '/api/accounts/t1', { executor: held.executor, tiers: held.tiers, max_runs: 2 })).status, 200);
  assert.equal(app.accounts.get('t1')!.maxRuns, 2);
});

test('credential writes obey login, Origin, executor support and recovery checks', async t => {
  const barrier = { recovering: false };
  const f = fixture(t, { recovery: { recovering: () => barrier.recovering } });
  const app = await consoleApp(t, { f });
  const path = `/api/accounts/${await keyed(app)}/credential`;
  assert.equal((await app.send('PUT', path, { value: TOKEN }, app.origin)).status, 401);
  assert.equal((await app.send('PUT', path, { value: TOKEN }, { Cookie: app.cookie, Origin: 'https://elsewhere.example' })).status, 403);
  // A token is checked before anything is kept, whichever executor it is for.
  const refused = await app.send('POST', '/api/accounts', { name: 'codex', executor: 'codex', tiers: { execute: { kind: 'content', text: 'model=m\n' } }, credential: TOKEN + ' x' });
  assert.equal(refused.status, 400);
  assert.ok(!(await refused.text()).includes(TOKEN));
  assert.equal(app.f.ledger.listAccounts().some((account) => account.name === 'codex'), false);
  assert.equal((await app.send('PUT', path, { value: TOKEN + ' ' })).status, 400);
  barrier.recovering = true;
  assert.equal((await app.send('PUT', path, { value: TOKEN })).status, 503);

});
