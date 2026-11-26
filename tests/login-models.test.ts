// Exercise the login's memory and ledger without a real CLI, credentials or browser.
import './guard.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeAdapter } from '../adapters/claude.ts';
import { createClaudeLogin, type ClaudeLoginOptions } from '../service/claude-login.ts';
import type { DbHooks } from '../service/db.ts';
import type { LoginView } from '../shared/claude-login.ts';
import { claudeTier, fixture, USER } from './helpers.ts';

const TOKEN = 'sk-ant-oat01-fake-token-only';
const TIERS = { execute: claudeTier('m-one') };
const BODY = JSON.stringify({ data: [{ id: 'm-one' }] });

async function until(login: ReturnType<typeof createClaudeLogin>, id: string, pass: (view: LoginView) => boolean) {
  for (let i = 0; i < 200; i++) {
    const view = login.get(id);
    if (pass(view)) return view;
    await sleep(5);
  }
  throw new Error('fake login did not reach expected state');
}

function harness(t: TestContext, fetcher: typeof fetch, hooks: DbHooks = {}) {
  const f = fixture(t, { testHooks: hooks }, false);
  const accounts: ClaudeLoginOptions['accounts'] = {
    credentialExecutors: ['claude'],
    get: (id) => f.ledger.getAccount(id),
    put: (input, ctx) => {
      assert.equal(input.credential, TOKEN);
      // The window's name, kept as the id here: this stand-in is not about id shape.
      const name = input.name as string;
      const id = input.id ?? name;
      const created = f.ledger.putAccount({ id, name, executor: 'claude', tiers: input.tiers as typeof TIERS }, ctx, 'fake-ref');
      return { ...created, account: f.ledger.getAccount(id)! };
    },
    setCredential: () => {},
  };
  const login = createClaudeLogin({
    dataDir: f.dir, accounts, ledger: f.ledger,
    models: { executors: { claude: claudeAdapter }, timeoutMs: 100, fetch: fetcher },
    platform: 'win32', commandLine: () => 'fake', log: () => {},
    limitMs: () => 60_000, cleanupMs: () => 100, settleMs: () => 5,
    processes: { alive: () => false, startOf: async () => 'fake-start', endTree: async () => {} },
    bridgeRuntime: {
      prepare: async () => ({ bridge: { kind: 'exe', start: () => ({ command: 'fake', args: [] }) }, problems: [] }),
      start: () => {
        const child = new EventEmitter() as ChildProcess;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        Object.assign(child, { pid: 12345, stdout, stderr, stdin: new Writable({ write(_chunk, _encoding, next) {
          queueMicrotask(() => stdout.write(`\r\n${TOKEN}\r\nDone.\r\n`));
          next();
        } }), kill: () => { child.emit('close', 0); return true; } });
        queueMicrotask(() => {
          stderr.write('ptybridge: child pid 12346\n');
          stdout.write('https://claude.com/cai/oauth/authorize?state=fake\r\nPaste code here');
        });
        return child;
      },
    },
  });
  t.after(() => login.stopAll({ close: true }));
  const signIn = async (name = 'fresh') => {
    const started = login.start(name, 'new', USER);
    await until(login, started.id, (v) => v.state === 'waiting_code');
    login.submit(started.id, 'fake-code');
    return until(login, started.id, (v) => v.state === 'signed_in' && !v.models.refreshing);
  };
  return { f, login, signIn };
}

test('新账号保存时立即登记初次模型，不发新增通知；提交失败不会留下半个账号', async (t) => {
  const hooks: DbHooks = {};
  let requests = 0;
  const h = harness(t, async (url) => {
    if (String(url).includes('/v1/models')) requests++;
    return new Response(BODY, { headers: { 'anthropic-organization-id': 'org-fake' } });
  }, hooks);
  const signed = await h.signIn();
  assert.deepEqual(signed.models.list.map((m) => m.id), ['m-one']);
  assert.equal(h.f.ledger.getAccount('fresh'), undefined);
  hooks.beforeCommit = (actions) => {
    if (actions.includes('account.create')) {
      assert.deepEqual(h.f.ledger.loginState('fresh').models, signed.models.list, '模型必须在提交账号前一起写好');
      assert.deepEqual(h.f.ledger.loginState('fresh').identity, signed.identity, '身份也必须在同一次提交里');
      throw new Error('fake commit failure');
    }
  };
  assert.throws(() => h.login.save(signed.id, { tiers: TIERS }, USER), /fake commit failure/);
  assert.equal(h.f.ledger.getAccount('fresh'), undefined);
  assert.deepEqual(h.f.ledger.loginState('fresh').models, []);
  assert.deepEqual(h.f.ledger.loginState('fresh').identity, {});
  hooks.beforeCommit = undefined;
  h.login.save(signed.id, { tiers: TIERS }, USER);
  assert.deepEqual(h.f.ledger.loginState('fresh').models, signed.models.list);
  assert.equal(h.f.ledger.loginState('fresh').models_at, signed.models.at);
  assert.deepEqual(h.f.ledger.loginState('fresh').identity, { organizationId: 'org-fake' });
  assert.deepEqual(h.f.peek('SELECT * FROM outbox'), []);
  assert.equal(requests, 1);
});

test('暂存模型查询的失败原因不包含令牌，手填仍可保存', async (t) => {
  const h = harness(t, async () => { throw new Error(`fake refusal ${TOKEN}`); });
  const signed = await h.signIn();
  assert.match(signed.models.reason!, /fake refusal \[已隐藏\]/);
  assert.ok(!JSON.stringify(signed).includes(TOKEN));
  h.login.save(signed.id, { tiers: TIERS }, USER);
  assert.ok(h.f.ledger.getAccount('fresh'));
});

test('组织随登录显示并同事务保存；重复账号在读取状态和保存时都能认出', async (t) => {
  const h = harness(t, async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${TOKEN}`);
    assert.match(String(url), /\/v1\/models/);
    return new Response(BODY, { headers: { 'anthropic-organization-id': 'org-fake' } });
  });
  const first = await h.signIn('one');
  assert.deepEqual(first.identity, { organizationId: 'org-fake' });
  assert.equal(first.duplicate, null);
  const other = await h.signIn('two');
  h.login.save(first.id, { tiers: TIERS }, USER);
  assert.deepEqual(h.f.ledger.loginState('one').identity, first.identity);
  assert.equal(h.login.get(other.id).duplicate, 'one', '状态按当前账本判断，不能固定在查询的那个时刻');
  assert.throws(() => h.login.save(other.id, { tiers: TIERS }, USER), /和账号 one 属于同一个 Claude 组织/);
  assert.equal(h.f.ledger.getAccount('two'), undefined);
  assert.ok(!JSON.stringify(h.f.dump()).includes(TOKEN));
});

test('缺少组织就不拦建号', async (t) => {
  const h = harness(t, async () => new Response(BODY));
  const first = await h.signIn('one');
  assert.deepEqual(first.identity, {});
  assert.equal(first.duplicate, null);
  assert.equal(first.models.reason, null);
  h.login.save(first.id, { tiers: TIERS }, USER);
  const other = await h.signIn('two');
  h.login.save(other.id, { tiers: TIERS }, USER);
  assert.ok(h.f.ledger.getAccount('two'));
});

test('模型请求在途时拒绝抢存，取消后迟到的模型和身份不能复活会话', async (t) => {
  const gate = Promise.withResolvers<Response>();
  const h = harness(t, async () => gate.promise);
  const started = h.login.start('fresh', 'new', USER);
  await until(h.login, started.id, (v) => v.state === 'waiting_code');
  h.login.submit(started.id, 'fake-code');
  const signing = await until(h.login, started.id, (v) => v.state === 'signed_in');
  assert.equal(signing.models.refreshing, true);
  assert.throws(() => h.login.save(started.id, { tiers: TIERS }, USER), /正在读取可用模型/);
  h.login.cancel(started.id);
  gate.resolve(new Response(BODY, { headers: { 'anthropic-organization-id': 'late-org' } }));
  await sleep(10);
  assert.equal(h.login.get(started.id).state, 'cancelled');
  assert.deepEqual(h.login.get(started.id).identity, {});
  assert.equal(h.f.ledger.getAccount('fresh'), undefined);
});

test('重新登录不查询模型或资料，也不受重复组织拦截', async (t) => {
  let queries = 0;
  const h = harness(t, async () => { queries++; return new Response(BODY); });
  for (const id of ['one', 'two']) {
    h.f.ledger.putAccount({ id, name: id, executor: 'claude', tiers: TIERS }, USER, 'fake-ref');
    h.f.ledger.noteIdentity(id, { organizationId: 'same-org' });
  }
  const started = h.login.start('one', 'relogin', USER);
  await until(h.login, started.id, (v) => v.state === 'waiting_code');
  h.login.submit(started.id, 'fake-code');
  const done = await until(h.login, started.id, (v) => v.state === 'signed_in');
  assert.equal(done.saved, true);
  assert.equal(done.duplicate, null);
  assert.equal(queries, 0);
});

test('新账号名字恰等于另一账号的内部编号时，仍检查那个账号的重复组织', async (t) => {
  const h = harness(t, async () => new Response(BODY, { headers: { 'anthropic-organization-id': 'same-org' } }));
  h.f.ledger.putAccount({ id: 'another-internal-id', name: '已有账号', executor: 'claude', tiers: TIERS }, USER, 'fake-ref');
  h.f.ledger.noteIdentity('another-internal-id', { organizationId: 'same-org' });
  const signed = await h.signIn('another-internal-id');
  assert.equal(signed.duplicate, '已有账号');
  assert.equal(signed.name, 'another-internal-id', 'a new name cannot resolve as another account id');
  assert.throws(() => h.login.save(signed.id, { tiers: TIERS }, USER), /和账号 已有账号 属于同一个 Claude 组织/);
});
