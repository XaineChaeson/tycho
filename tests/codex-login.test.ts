import './guard.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import { ADAPTERS } from '../adapters/all.ts';
import { decodeCodexOAuth, encodeCodexOAuth, formatCodexAuthFile } from '../adapters/codex-auth.ts';
import { createAccounts } from '../service/accounts.ts';
import { createCodexLogin } from '../service/codex-login.ts';
import type { CodexLoginView } from '../shared/codex-login.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, USER } from './helpers.ts';

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig_login_test`;
}

function makeBundle(email: string, tag = '1') {
  const expSec = 1_850_000_000;
  return {
    id_token: fakeJwt({ email, sub: `u_${tag}`, exp: expSec }),
    access_token: fakeJwt({ sub: `u_${tag}`, exp: expSec, jti: `acc_${tag}` }),
    refresh_token: `rt_codex_login_${tag}_secret`,
    account_id: `acct_${tag}`,
    last_refresh: '2026-11-17T00:00:00.000Z',
  };
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 42420;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test('Host Codex device-auth login creates OAuth account, detects duplicates, supports relogin, and cleans up temp dir without leaking secrets', async (t) => {
  const f = fixture(t);
  const logs: string[] = [];
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: ['claude', 'codex', 'dsh', 'gemini'],
    routingExecutors: ['claude', 'codex'],
    dataDir: f.dir,
    log: (line) => logs.push(line),
  });

  const spawned: { child: FakeChild; env: NodeJS.ProcessEnv }[] = [];
  let reloggedAccount: string | undefined;

  const login = createCodexLogin({
    dataDir: f.dir,
    ledger: f.ledger,
    accounts,
    limitMs: () => 60_000,
    cleanupMs: () => 2_000,
    onRelogin: (id) => { reloggedAccount = id; },
    processes: {
      alive: () => false,
      startOf: async () => undefined,
      descendants: async () => [],
      tagged: async () => [],
      endTree: async () => {},
      endGroup: async () => {},
    },
    resolveLaunch: () => ({ command: 'codex', args: ['login', '--device-auth'], verbatim: false, found: '/usr/bin/codex' }),
    spawn: ((_cmd: string, _args: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild();
      spawned.push({ child, env: opts.env });
      return child as unknown as ChildProcess;
    }) as typeof import('node:child_process').spawn,
    readCatalog: async () => ({
      ok: true,
      models: [{ id: 'gpt-5.4', name: 'GPT-5.4', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }],
      at: '2026-11-17T00:00:00.000Z',
    }),
    log: (line) => logs.push(line),
  });
  t.after(() => login.stopAll({ close: true }));

  const initial = login.start(undefined, 'new', USER);
  assert.equal(initial.state, 'starting');
  await sleep(20);
  assert.equal(spawned.length, 1);

  const first = spawned[0]!;
  first.child.stdout.write('Open https://auth.openai.com/codex/device and enter code ABCD-12345\n');
  await sleep(10);
  const waiting = login.get(initial.id);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.url, 'https://auth.openai.com/codex/device');
  assert.equal(waiting.code, 'ABCD-12345');

  const bundle1 = makeBundle('owner@example.com', 'first');
  writeFileSync(join(first.env.CODEX_HOME!, 'auth.json'), formatCodexAuthFile(bundle1, true));
  first.child.emit('close', 0);
  await login.settled(initial.id);
  await sleep(20);

  // Temp session directory and auth.json on disk must be wiped as soon as token is held in memory.
  assert.equal(existsSync(first.env.CODEX_HOME!), false);

  const signedIn = login.get(initial.id);
  assert.equal(signedIn.state, 'signed_in');
  assert.equal(signedIn.url, null);
  assert.equal(signedIn.code, null);
  assert.equal(signedIn.identity.accountLabel, 'owner@e***.com');
  assert.equal(signedIn.models.list[0]?.id, 'gpt-5.4');
  assert.equal(signedIn.duplicate, null);
  // Ensure view & logs never leak tokens or user code.
  assert.ok(!JSON.stringify(signedIn).includes(bundle1.refresh_token));
  assert.ok(!JSON.stringify(signedIn).includes(bundle1.access_token));
  assert.ok(!logs.join('\n').includes('ABCD-12345'));
  assert.ok(!logs.join('\n').includes(bundle1.refresh_token));

  const { account } = login.save(initial.id, {
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\nmodel_reasoning_effort=high\n' } },
  }, USER);
  assert.equal(account.signedIn, true);
  assert.equal(decodeCodexOAuth(accounts.credentialOf(account.id)!.value)?.refresh_token, bundle1.refresh_token);

  // Second 'new' login with the same ChatGPT email detects duplicate and refuses save.
  const dupView = login.start(undefined, 'new', USER);
  await sleep(20);
  const second = spawned[1]!;
  writeFileSync(join(second.env.CODEX_HOME!, 'auth.json'), formatCodexAuthFile(makeBundle('OWNER@example.com', 'dup'), true));
  second.child.emit('close', 0);
  await login.settled(dupView.id);
  await sleep(20);
  assert.equal(login.get(dupView.id).duplicate, account.name);
  assert.throws(() => login.save(dupView.id, { tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } } }, USER), /同一个/);

  // 'relogin' replaces the stored OAuth credential directly without needing save().
  const reloginView = login.start(account.id, 'relogin', USER);
  await sleep(20);
  const third = spawned[2]!;
  const bundle2 = makeBundle('owner@example.com', 'relogged');
  writeFileSync(join(third.env.CODEX_HOME!, 'auth.json'), formatCodexAuthFile(bundle2, true));
  third.child.emit('close', 0);
  await login.settled(reloginView.id);

  const afterRelogin = login.get(reloginView.id);
  assert.equal(afterRelogin.state, 'signed_in');
  assert.equal(afterRelogin.saved, true);
  assert.equal(reloggedAccount, account.id);
  assert.equal(decodeCodexOAuth(accounts.credentialOf(account.id)!.value)?.refresh_token, bundle2.refresh_token);
});

test('HTTP routes serve /api/codex-logins, mark signed_in on OAuth accounts, and forbid typed key replacement on OAuth accounts', async (t) => {
  const bundle = makeBundle('http.owner@example.com', 'http1');
  const encoded = encodeCodexOAuth(bundle);

  let savedAccountId = '';
  const app = await consoleApp(t, {
    codexLogin: {
      executor: 'codex',
      available: () => true,
      start: (_account, mode) => ({
        id: 'cx-session-1',
        account: '',
        name: 'codex',
        mode: mode as 'new' | 'relogin',
        state: 'waiting',
        url: 'https://auth.openai.com/codex/device',
        code: 'WXYZ-98765',
        reason: null,
        saved: false,
        ended: false,
        unconfirmed: false,
        deadline: '2026-11-17T01:00:00.000Z',
        models: { list: [{ id: 'gpt-5.4' }], at: '2026-11-17T00:00:00.000Z', refreshing: false, reason: null },
        identity: { accountLabel: 'http.owner', quotaOwner: `v1:${'c'.repeat(64)}` },
        duplicate: null,
      }),
      get: (id): CodexLoginView => ({
        id,
        account: savedAccountId,
        name: 'codex',
        mode: 'new',
        state: 'signed_in',
        url: null,
        code: null,
        reason: null,
        saved: savedAccountId !== '',
        ended: true,
        unconfirmed: false,
        deadline: '2026-11-17T01:00:00.000Z',
        models: { list: [{ id: 'gpt-5.4' }], at: '2026-11-17T00:00:00.000Z', refreshing: false, reason: null },
        identity: { accountLabel: 'http.owner', quotaOwner: `v1:${'c'.repeat(64)}` },
        duplicate: null,
      }),
      save: (id, input, ctx) => {
        const created = app.accounts.put({ ...input, executor: 'codex', credential: encoded }, ctx);
        savedAccountId = created.account.id;
        return {
          login: {
            id,
            account: created.account.id,
            name: created.account.name,
            mode: 'new',
            state: 'signed_in',
            url: null,
            code: null,
            reason: null,
            saved: true,
            ended: true,
            unconfirmed: false,
            deadline: '2026-11-17T01:00:00.000Z',
            models: { list: [{ id: 'gpt-5.4' }], at: '2026-11-17T00:00:00.000Z', refreshing: false, reason: null },
            identity: { accountLabel: 'http.owner', quotaOwner: `v1:${'c'.repeat(64)}` },
            duplicate: null,
          },
          account: created.account,
        };
      },
      cancel: (id) => ({
        id,
        account: '',
        name: 'codex',
        mode: 'new',
        state: 'cancelled',
        url: null,
        code: null,
        reason: null,
        saved: false,
        ended: true,
        unconfirmed: false,
        deadline: '2026-11-17T01:00:00.000Z',
        models: { list: [], at: null, refreshing: false, reason: null },
        identity: {},
        duplicate: null,
      }),
    },
  });

  const started = await app.send('POST', '/api/codex-logins', { mode: 'new' });
  assert.equal(started.status, 201);
  const startBody = (await started.json()) as { login: CodexLoginView };
  assert.equal(startBody.login.code, 'WXYZ-98765');

  const saved = await app.send('POST', '/api/codex-logins/cx-session-1/save', {
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } },
  });
  assert.equal(saved.status, 201);
  const savedBody = (await saved.json()) as { account: { id: string; signed_in: boolean } };
  assert.equal(savedBody.account.signed_in, true);

  // Replacing a signed-in OAuth account's credential via typed key endpoint is refused.
  const replaceTyped = await app.send('PUT', `/api/accounts/${savedBody.account.id}/credential`, { value: 'sk-plain-key' });
  assert.equal(replaceTyped.status, 400);
  assert.match(((await replaceTyped.json()) as { error: string }).error, /重新登录/);

  // Pasting a raw codex-oauth-v1 bundle into POST /api/accounts is refused.
  const rawPaste = await app.send('POST', '/api/accounts', {
    executor: 'codex',
    credential: encoded,
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } },
  });
  assert.equal(rawPaste.status, 400);

  // Plain API-key Codex account still works and has signed_in: false.
  const keyCreated = await app.send('POST', '/api/accounts', {
    executor: 'codex',
    credential: 'sk-openai-123456',
    tiers: { execute: { kind: 'content', text: 'model=gpt-5.4\n' } },
  });
  assert.equal(keyCreated.status, 201);
  const keyBody = (await keyCreated.json()) as { account: { id: string; signed_in: boolean } };
  assert.equal(keyBody.account.signed_in, false);

  const keyReplaced = await app.send('PUT', `/api/accounts/${keyBody.account.id}/credential`, { value: 'sk-openai-654321' });
  assert.equal(keyReplaced.status, 200);

  // Gemini API-key account creation works end-to-end over HTTP.
  const geminiCreated = await app.send('POST', '/api/accounts', {
    executor: 'gemini',
    credential: 'AIzaSyTestGeminiKey001',
    tiers: { execute: { kind: 'content', text: '{"model":"gemini-2.5-pro","effort":"high"}' } },
  });
  assert.equal(geminiCreated.status, 201);
  const geminiBody = (await geminiCreated.json()) as { account: { id: string; executor: string; signed_in: boolean } };
  assert.equal(geminiBody.account.executor, 'gemini');
  assert.equal(geminiBody.account.signed_in, false);
});
