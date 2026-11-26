import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../adapters/all.ts';
import { createAcceptor } from '../service/accept.ts';
import { createAccounts } from '../service/accounts.ts';
import { createAuth } from '../service/auth.ts';
import { createGitHubService, parseGitHubRepo, type GitHubService } from '../service/github.ts';
import { createHttp, createStream } from '../service/http.ts';
import { createInbounds } from '../service/inbound.ts';
import { createLogins } from '../service/logins.ts';
import { createMachines } from '../service/machines.ts';
import { createNodes } from '../service/nodes.ts';
import { githubSecretFile, knowledgeTokenStore, readSecret, replaceSecret, wecomSecretFile } from '../service/secrets.ts';
import { serviceSettings } from '../service/service-settings.ts';
import { createTools } from '../service/tools.ts';
import { NODE_PROTOCOL, type NodeCredentialAnswer, type NodePollAnswer } from '../shared/node-protocol.ts';
import { prepareGitHubEnv, workerEnv } from '../node/watch.ts';
import { accepting, claudeTier, CONSOLE_DIST, fixture, HTTP_TUNED, memoryLogins, NODES_TUNED, RUN_LIMIT_MS, testCredentialRef, USER } from './helpers.ts';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('parseGitHubRepo parses slug, HTTPS, SSH, and SCP formats and rejects non-GitHub URLs', () => {
  assert.deepEqual(parseGitHubRepo('octocat/hello-world'), { owner: 'octocat', repo: 'hello-world' });
  assert.deepEqual(parseGitHubRepo('octocat/hello-world.git'), { owner: 'octocat', repo: 'hello-world' });
  assert.deepEqual(parseGitHubRepo('https://github.com/octocat/hello-world'), { owner: 'octocat', repo: 'hello-world' });
  assert.deepEqual(parseGitHubRepo('https://github.com/octocat/hello-world.git'), { owner: 'octocat', repo: 'hello-world' });
  assert.deepEqual(parseGitHubRepo('https://www.github.com/octocat/hello-world/'), { owner: 'octocat', repo: 'hello-world' });
  assert.deepEqual(parseGitHubRepo('git@github.com:octocat/hello-world.git'), { owner: 'octocat', repo: 'hello-world' });
  assert.deepEqual(parseGitHubRepo('git@github.com:octocat/hello-world'), { owner: 'octocat', repo: 'hello-world' });
  assert.deepEqual(parseGitHubRepo('ssh://git@github.com/octocat/hello-world.git'), { owner: 'octocat', repo: 'hello-world' });

  assert.equal(parseGitHubRepo(''), null);
  assert.equal(parseGitHubRepo('not-a-repo'), null);
  assert.equal(parseGitHubRepo('https://gitlab.com/octocat/hello-world.git'), null);
  assert.equal(parseGitHubRepo('https://github.com/octocat/hello-world/pull/1'), null);
  assert.equal(parseGitHubRepo('../escape'), null);
});

test('createGitHubService PAT flow stores secret owner-only, never leaks token, checks, and disconnects cleanly', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-gh-pat-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  let clock = Date.parse('2026-11-21T10:00:00.000Z');
  const TOKEN = 'ghp_secret_pat_token_1234567890';
  let userCalls = 0;

  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === 'https://api.github.com/user') {
      userCalls += 1;
      if (headers.get('authorization') === `Bearer ${TOKEN}`) {
        return jsonResponse(
          { login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
          200,
          { 'x-oauth-scopes': 'repo, read:org, read:user' },
        );
      }
      return jsonResponse({ message: 'Bad credentials' }, 401);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const gh = createGitHubService({ dataDir, fetchFn, now: () => clock });

  // Initially disconnected.
  assert.deepEqual(gh.status(), { connected: false, connection: null, client_id: null });
  assert.equal(gh.readToken(), null);
  await assert.rejects(() => gh.check(), /还没有连接 GitHub/);

  // Invalid PAT is rejected and leaves nothing stored.
  await assert.rejects(() => gh.connectPat('ghp_invalid'), /无效或已过期/);
  assert.equal(gh.readToken(), null);
  assert.equal(existsSync(githubSecretFile(dataDir)), false);

  // Valid PAT verifies, stores secret under secrets/github, and persists non-secret metadata.
  const conn = await gh.connectPat(TOKEN);
  assert.equal(conn.login, 'octocat');
  assert.equal(conn.name, 'The Octocat');
  assert.equal(conn.avatar_url, 'https://avatars.githubusercontent.com/u/1');
  assert.equal(conn.mode, 'pat');
  assert.deepEqual(conn.scopes, ['repo', 'read:org', 'read:user']);
  assert.equal(conn.connected_at, '2026-11-21T10:00:00.000Z');
  assert.equal(conn.checked_at, '2026-11-21T10:00:00.000Z');

  // Token lives only in secrets/github with 0600 on POSIX, never in status() or github.json.
  const secretPath = githubSecretFile(dataDir);
  assert.equal(existsSync(secretPath), true);
  assert.equal(readSecret(secretPath), TOKEN);
  if (process.platform !== 'win32') {
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  }
  const metaText = readFileSync(join(dataDir, 'github.json'), 'utf8');
  assert.equal(metaText.includes(TOKEN), false);
  const status = gh.status();
  assert.equal(status.connected, true);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);

  // check() updates checked_at while keeping connected_at intact.
  clock += 60_000;
  const checked = await gh.check();
  assert.equal(checked.connected_at, '2026-11-21T10:00:00.000Z');
  assert.equal(checked.checked_at, '2026-11-21T10:01:00.000Z');
  assert.equal(userCalls, 3);

  // disconnect() removes secret file and clears connection.
  gh.disconnect();
  assert.equal(existsSync(secretPath), false);
  assert.equal(gh.readToken(), null);
  assert.deepEqual(gh.status(), { connected: false, connection: null, client_id: null });
});

test('createGitHubService Device Flow handles start, pending, connected, expired, and denied', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-gh-device-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  let clock = Date.parse('2026-11-21T11:00:00.000Z');
  const DEVICE_TOKEN = 'gho_device_flow_token_98765';
  const pollQueue: unknown[] = [
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { access_token: DEVICE_TOKEN, token_type: 'bearer', scope: 'repo,read:user' },
    { error: 'expired_token' },
    { error: 'access_denied' },
  ];

  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://github.com/login/device/code') {
      return jsonResponse({
        device_code: 'dev-code-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 600,
        interval: 5,
      });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return jsonResponse(pollQueue.shift() ?? { error: 'expired_token' });
    }
    if (url === 'https://api.github.com/user') {
      return jsonResponse(
        { login: 'device-user', name: null, avatar_url: null },
        200,
        { 'x-oauth-scopes': 'repo, read:user' },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const gh = createGitHubService({ dataDir, fetchFn, now: () => clock });
  await assert.rejects(() => gh.startDeviceFlow('   '), /Client ID/);

  const started = await gh.startDeviceFlow('Ov23liTestClientId');
  assert.equal(started.user_code, 'ABCD-1234');
  assert.equal(started.verification_uri, 'https://github.com/login/device');
  assert.equal(started.expires_in, 600);
  assert.equal(started.interval, 5);
  assert.equal(gh.status().client_id, 'Ov23liTestClientId');

  // Pending & slow_down both map to pending.
  assert.deepEqual(await gh.pollDeviceFlow(started.session_id), { state: 'pending' });
  assert.deepEqual(await gh.pollDeviceFlow(started.session_id), { state: 'pending' });

  // Connected saves token + device mode + cleans up session.
  const connected = await gh.pollDeviceFlow(started.session_id);
  assert.equal(connected.state, 'connected');
  assert.equal(connected.connection?.login, 'device-user');
  assert.equal(connected.connection?.mode, 'device');
  assert.equal(gh.readToken(), DEVICE_TOKEN);
  assert.equal(JSON.stringify(connected).includes(DEVICE_TOKEN), false);

  // Re-polling consumed session returns expired.
  assert.equal((await gh.pollDeviceFlow(started.session_id)).state, 'expired');

  // Expired token response from GitHub.
  const started2 = await gh.startDeviceFlow('Ov23liTestClientId');
  const expired = await gh.pollDeviceFlow(started2.session_id);
  assert.equal(expired.state, 'expired');

  // Denied response from GitHub.
  const started3 = await gh.startDeviceFlow('Ov23liTestClientId');
  const denied = await gh.pollDeviceFlow(started3.session_id);
  assert.equal(denied.state, 'denied');

  // Disconnecting preserves client_id for convenience.
  gh.disconnect();
  assert.equal(gh.status().connected, false);
  assert.equal(gh.status().client_id, 'Ov23liTestClientId');
});

test('listPullRequests and getPullRequest return concise PR and CI summaries', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tycho-gh-prs-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const TOKEN = 'ghp_pr_reader_token';
  let failChecks = false;

  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.github.com/user') {
      return jsonResponse({ login: 'octocat', name: 'Octo', avatar_url: null }, 200, { 'x-oauth-scopes': 'repo' });
    }
    if (url.startsWith('https://api.github.com/repos/acme/tycho/pulls?')) {
      return jsonResponse([
        {
          number: 42,
          title: 'Add GitHub integration',
          state: 'open',
          draft: false,
          user: { login: 'alice' },
          head: { ref: 'feat/github' },
          base: { ref: 'main' },
          updated_at: '2026-11-21T10:00:00Z',
          html_url: 'https://github.com/acme/tycho/pull/42',
        },
      ]);
    }
    if (url === 'https://api.github.com/repos/acme/tycho/pulls/42') {
      return jsonResponse({
        number: 42,
        title: 'Add GitHub integration',
        state: 'open',
        draft: false,
        mergeable: true,
        head: { ref: 'feat/github', sha: 'abc1234567890' },
        base: { ref: 'main', sha: 'def0987654321' },
        commits: 3,
        changed_files: 12,
        additions: 450,
        deletions: 20,
        html_url: 'https://github.com/acme/tycho/pull/42',
        body: 'Implements managed GitHub integration.',
      });
    }
    if (url.startsWith('https://api.github.com/repos/acme/tycho/commits/abc1234567890/check-runs')) {
      if (failChecks) return jsonResponse({ message: 'Forbidden' }, 403);
      return jsonResponse({
        check_runs: [
          { name: 'typecheck', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/tycho/runs/1' },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const gh = createGitHubService({ dataDir, fetchFn });
  await assert.rejects(() => gh.listPullRequests('acme/tycho'), /设置 › GitHub/);

  await gh.connectPat(TOKEN);
  const prs = await gh.listPullRequests('https://github.com/acme/tycho.git', 'open', 10);
  assert.deepEqual(prs, [
    {
      number: 42,
      title: 'Add GitHub integration',
      state: 'open',
      draft: false,
      user: 'alice',
      head: 'feat/github',
      base: 'main',
      updated_at: '2026-11-21T10:00:00Z',
      html_url: 'https://github.com/acme/tycho/pull/42',
    },
  ]);

  const detail = await gh.getPullRequest('git@github.com:acme/tycho.git', 42);
  assert.equal(detail.number, 42);
  assert.equal(detail.mergeable, true);
  assert.deepEqual(detail.head, { ref: 'feat/github', sha: 'abc1234567890' });
  assert.equal(detail.changed_files, 12);
  assert.equal(detail.body_preview, 'Implements managed GitHub integration.');
  assert.deepEqual(detail.checks, [
    { name: 'typecheck', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/tycho/runs/1' },
  ]);

  // Best-effort checks fallback when check-runs API fails.
  failChecks = true;
  const detailNoChecks = await gh.getPullRequest('acme/tycho', 42);
  assert.deepEqual(detailNoChecks.checks, []);
});

test('prepareGitHubEnv creates askpass without embedding secret on disk and cleans up', (t) => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'tycho-gh-askpass-'));
  t.after(() => rmSync(scratchDir, { recursive: true, force: true }));

  const TOKEN = 'ghp_never_write_to_disk_token_xyz';

  // POSIX script
  const posix = prepareGitHubEnv(scratchDir, TOKEN, 'linux');
  assert.equal(posix.env.GH_TOKEN, TOKEN);
  assert.equal(posix.env.GITHUB_TOKEN, TOKEN);
  assert.equal(posix.env.TYCHO_GITHUB_TOKEN, TOKEN);
  assert.equal(posix.env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(posix.env.GIT_ASKPASS!.endsWith('git-askpass.sh'));
  assert.equal(existsSync(posix.env.GIT_ASKPASS!), true);
  const posixScript = readFileSync(posix.env.GIT_ASKPASS!, 'utf8');
  assert.equal(posixScript.includes(TOKEN), false, 'token must never be embedded on disk');
  assert.match(posixScript, /TYCHO_GITHUB_TOKEN/);
  posix.cleanup();
  assert.equal(existsSync(posix.env.GIT_ASKPASS!), false);

  // Windows script
  const win = prepareGitHubEnv(scratchDir, TOKEN, 'win32');
  assert.ok(win.env.GIT_ASKPASS!.endsWith('git-askpass.cmd'));
  assert.equal(existsSync(win.env.GIT_ASKPASS!), true);
  const winScript = readFileSync(win.env.GIT_ASKPASS!, 'utf8');
  assert.equal(winScript.includes(TOKEN), false, 'token must never be embedded on disk');
  assert.match(winScript, /%TYCHO_GITHUB_TOKEN%/);
  win.cleanup();
  assert.equal(existsSync(win.env.GIT_ASKPASS!), false);

  // workerEnv without githubEnv preserves existing behavior and injects nothing for GH_TOKEN/GIT_ASKPASS.
  const plainEnv = workerEnv({ PATH: '/usr/bin' }, { env: {}, credentialVariable: null }, 'run-1');
  assert.equal(plainEnv.GH_TOKEN, undefined);
  assert.equal(plainEnv.GIT_ASKPASS, undefined);

  // workerEnv with githubEnv propagates GH_TOKEN and GIT_ASKPASS.
  const injectedEnv = workerEnv({ PATH: '/usr/bin' }, { env: {}, credentialVariable: null }, 'run-1', undefined, win.env);
  assert.equal(injectedEnv.GH_TOKEN, TOKEN);
  assert.equal(injectedEnv.GITHUB_TOKEN, TOKEN);
  assert.equal(injectedEnv.GIT_ASKPASS, win.env.GIT_ASKPASS);
});

test('Router MCP tools github_list_prs and github_get_pr enforce project-bound GitHub repo isolation', async (t) => {
  const f = fixture(t);
  const projectId = f.ledger.createProject({ name: 'GitHub 项目', logins: ['t1'] }, USER);
  const otherProjectId = f.ledger.createProject({ name: '其他 GitHub 项目', logins: ['t1'] }, USER);
  f.ledger.putAccount(
    { id: 't1', name: 't1', executor: 'claude', tiers: { execute: claudeTier('/tiers/execute.json') } },
    USER,
    'ref-t1',
  );
  f.ledger.setProjectSources(projectId, [
    { kind: 'repo', url: 'https://github.com/acme/demo-repo.git' },
    { kind: 'repo', url: 'git@github.com:other/explicit.git' },
  ], USER);
  f.ledger.setProjectSources(otherProjectId, [
    { kind: 'repo', url: 'https://github.com/secret-org/private-repo.git' },
  ], USER);

  const requestedUrls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === 'https://api.github.com/user') {
      return jsonResponse({ login: 'octocat', name: 'Octo', avatar_url: null }, 200, { 'x-oauth-scopes': 'repo' });
    }
    if (url.startsWith('https://api.github.com/repos/acme/demo-repo/pulls?')) {
      return jsonResponse([
        {
          number: 7,
          title: 'Inferred repo PR',
          state: 'open',
          draft: true,
          user: { login: 'dev' },
          head: { ref: 'feature' },
          base: { ref: 'main' },
          updated_at: '2026-11-21T12:00:00Z',
          html_url: 'https://github.com/acme/demo-repo/pull/7',
        },
      ]);
    }
    if (url === 'https://api.github.com/repos/other/explicit/pulls/9') {
      return jsonResponse({
        number: 9,
        title: 'Explicit repo PR',
        state: 'closed',
        draft: false,
        mergeable: null,
        head: { ref: 'fix', sha: '11112222' },
        base: { ref: 'main', sha: '33334444' },
        commits: 1,
        changed_files: 2,
        additions: 10,
        deletions: 5,
        html_url: 'https://github.com/other/explicit/pull/9',
        body: 'Done.',
      });
    }
    if (url.startsWith('https://api.github.com/repos/other/explicit/commits/11112222/check-runs')) {
      return jsonResponse({ check_runs: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const github = createGitHubService({ dataDir: f.dir, ledger: f.ledger, fetchFn });
  const tools = createTools({
    ledger: f.ledger,
    dataDir: f.dir,
    github,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({}),
    machines: createMachines({ ledger: f.ledger }),
    accept: accepting(f.ledger),
  });

  // Not connected yet → clear Chinese refusal.
  const notConnected = await tools.call('github_list_prs', {}, USER, { projectId });
  assert.equal(notConnected.isError, true);
  assert.match(notConnected.content[0]!.text, /设置 › GitHub/);

  await github.connectPat('ghp_tools_token_abc');

  // Omit repo → inferred from project's first GitHub repo source.
  const listed = await tools.call('github_list_prs', { state: 'open', limit: 5 }, USER, { projectId });
  assert.equal(listed.isError, undefined);
  const parsedList = JSON.parse(listed.content[0]!.text) as { repo: string; pulls: { number: number; title: string }[] };
  assert.equal(parsedList.repo, 'https://github.com/acme/demo-repo.git');
  assert.equal(parsedList.pulls[0]!.number, 7);

  // Explicit repo bound to this project (matching case-insensitively across slug/URL forms).
  const detail = await tools.call('github_get_pr', { repo: 'OTHER/EXPLICIT', number: 9 }, USER, { projectId });
  assert.equal(detail.isError, undefined);
  const parsedDetail = JSON.parse(detail.content[0]!.text) as { number: number; title: string };
  assert.equal(parsedDetail.number, 9);
  assert.equal(parsedDetail.title, 'Explicit repo PR');

  // Cross-project or unbound explicit repo is refused BEFORE any GitHub API call is made.
  const urlsBeforeCrossProject = requestedUrls.length;
  const crossProjectPrs = await tools.call('github_list_prs', { repo: 'secret-org/private-repo' }, USER, { projectId });
  assert.equal(crossProjectPrs.isError, true);
  assert.match(crossProjectPrs.content[0]!.text, /未绑定 GitHub 仓库/);
  const crossProjectDetail = await tools.call('github_get_pr', { repo: 'https://github.com/secret-org/private-repo.git', number: 1 }, USER, { projectId });
  assert.equal(crossProjectDetail.isError, true);
  assert.match(crossProjectDetail.content[0]!.text, /未绑定 GitHub 仓库/);
  assert.equal(requestedUrls.length, urlsBeforeCrossProject, 'no GitHub API request may fire for unbound repo');

  // Project without GitHub source fails clearly when repo is omitted OR when an unbound repo is passed.
  const emptyProjectId = f.ledger.createProject({ name: '无仓库项目', logins: ['t1'] }, USER);
  const missingRepo = await tools.call('github_list_prs', {}, USER, { projectId: emptyProjectId });
  assert.equal(missingRepo.isError, true);
  assert.match(missingRepo.content[0]!.text, /项目设置中添加 GitHub 仓库来源/);
  const unboundOnEmpty = await tools.call('github_list_prs', { repo: 'acme/demo-repo' }, USER, { projectId: emptyProjectId });
  assert.equal(unboundOnEmpty.isError, true);
  assert.match(unboundOnEmpty.content[0]!.text, /未绑定 GitHub 仓库/);
});

test('HTTP routes /api/github* and /api/node/runs/:id/credential + /api/node/poll wire GitHub end-to-end', async (t) => {
  const f = fixture(t);
  f.ledger.setWhitelist({ console: ['console'] }, USER);
  const account = {
    id: 't1',
    name: 't1',
    executor: 'claude',
    tiers: { execute: claudeTier('/tiers/execute.json') },
  };
  f.ledger.putAccount(account, USER, testCredentialRef('t1'));

  const PAT_TOKEN = 'ghp_http_surface_token_secret';
  const DEVICE_TOKEN = 'gho_http_device_token_secret';
  let devicePolls = 0;

  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://api.github.com/user') {
      return jsonResponse({ login: 'http-user', name: 'HTTP User', avatar_url: null }, 200, { 'x-oauth-scopes': 'repo' });
    }
    if (url === 'https://github.com/login/device/code') {
      return jsonResponse({
        device_code: 'dc-http',
        user_code: 'HTTP-9999',
        verification_uri: 'https://github.com/login/device',
        expires_in: 600,
        interval: 5,
      });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      devicePolls += 1;
      if (devicePolls === 1) return jsonResponse({ error: 'authorization_pending' });
      return jsonResponse({ access_token: DEVICE_TOKEN });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const github: GitHubService = createGitHubService({ dataDir: f.dir, ledger: f.ledger, fetchFn });
  const machines = createMachines({ ledger: f.ledger });
  const accounts = createAccounts({
    ledger: f.ledger,
    executors: ADAPTERS,
    credentialExecutors: ['claude'],
    routingExecutors: ['claude'],
    dataDir: f.dir,
  });
  const logins = createLogins({ ledger: f.ledger, accounts, executors: ADAPTERS });
  const nodes = createNodes({ ledger: f.ledger, ...NODES_TUNED, log: () => {} });
  const stream = createStream();
  const auth = createAuth({
    ledger: f.ledger,
    linkTtlMs: () => 15 * 60_000,
    sessionDays: () => 30,
    temporarySessionMs: () => 60 * 60_000,
  });
  const settings = serviceSettings({ ledger: f.ledger, dataDir: f.dir, log: () => {} });
  const accept = createAcceptor({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: { fetchArtifacts: async () => ({ files: [], problem: null }) },
  });
  const tools = createTools({
    ledger: f.ledger,
    dataDir: f.dir,
    github,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins,
    machines,
    accept,
  });

  const http = createHttp({
    dataDir: f.dir,
    github,
    ledger: f.ledger,
    tools,
    auth,
    session: {
      admitTool: () => ({ refused: 'not-used' }),
      toolTokens: () => [],
      projectOfToken: () => undefined,
      kick: () => {},
      interrupt: () => false,
      status: () => ({ alive: false, pid: null, turn: null, turns: [], error: null, host_error: null, restarting: false, waiting: null, launched: null, projects: [] }),
      restart: async () => {},
    },
    stream,
    accounts,
    logins,
    machines,
    nodes,
    roundSnapshot: () => null,
    roundCredential: () => null, // Simulate a machine-own login with no account credential!
    roundInvite: () => null,
    wecomSecret: { isSet: () => readSecret(wecomSecretFile(f.dir)) !== '', set: (s, ctx) => replaceSecret(wecomSecretFile(f.dir), s, () => f.ledger.noteAction('wecom.secret_set', ctx)) },
    knowledgeTokens: knowledgeTokenStore(f.dir),
    inbounds: createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => 300_000 }),
    skillFolder: join(f.dir, 'skills'),
    doctor: async () => [],
    loginUrl: (path) => `http://127.0.0.1${path}`,
    ...HTTP_TUNED,
    lostGraceMs: () => 60_000,
    nodeLookEveryMs: () => 60_000,
    nodeModelListTimeoutMs: () => 30_000,
    nodeQuotaReadTimeoutMs: () => 30_000,
    loginToken: 'login-token',
    shutdownToken: 'shutdown-token',
    releaseCheck: () => ({ ledger: 'ok', degraded: false, recovering: false, health_window_ms: 1000 }),
    drain: async () => ({ drained: true, waited_ms: 0 }),
    accept,
    releases: { dataDir: f.dir, version: '0.0.0', last: () => null, intent: () => null, attempting: () => false, launch: () => ({ started: false, version: '0.0.0' }) },
    instance: () => ({ pid: process.pid }),
    onShutdown: () => {},
    backup: {
      status: () => ({ running: false, last: null, next: null, configured: false }),
      trigger: async () => ({ ok: true, file: '', at: new Date().toISOString(), ledger_bytes: 0, runs_files: 0, runs_incomplete: [], tool: 'backup' }),
    },
    settings,
    deployment: async () => [],
    consoleDir: CONSOLE_DIST,
    log: () => {},
  });

  const port = await http.listen(0, '127.0.0.1');
  t.after(() => http.close());
  const base = `http://127.0.0.1:${port}`;

  // Sign in a console session.
  const link = auth.createLink();
  const loginRes = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
    body: `credential=${encodeURIComponent(link.credential)}`,
    redirect: 'manual',
  });
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;

  // Anonymous request refused.
  assert.equal((await fetch(`${base}/api/github`)).status, 401);

  // GET /api/github when disconnected.
  const initialRes = await fetch(`${base}/api/github`, { headers: { Cookie: cookie } });
  assert.equal(initialRes.status, 200);
  assert.deepEqual(await initialRes.json(), { connected: false, connection: null, client_id: null });

  // POST /api/github/pat connects and never returns token.
  const patRes = await fetch(`${base}/api/github/pat`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: PAT_TOKEN }),
  });
  assert.equal(patRes.status, 200);
  const patBody = await patRes.text();
  assert.equal(patBody.includes(PAT_TOKEN), false);
  assert.equal(JSON.parse(patBody).connection.login, 'http-user');

  // POST /api/github/check succeeds.
  const checkRes = await fetch(`${base}/api/github/check`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(checkRes.status, 200);

  // Bind a GitHub repo source to f.projectId so writable runs on it are authorized for the GitHub token.
  f.ledger.setProjectSources(f.projectId, [
    { kind: 'repo', url: 'https://github.com/acme/test-repo.git' },
  ], USER);

  // Join a remote node and create a Run on it (simulating machine-own login where roundCredential === null).
  const joined = nodes.admitLocal({ node_id: 'a'.repeat(32), name: 'worker-1', platform: 'linux', hostname: 'worker-1' }, USER);
  assert.equal(joined.state, 'approved');
  const nodeToken = joined.token;
  const machine = f.ledger.getMachine(joined.machine_id)!;

  const task = f.ledger.createTask({ projectId: f.projectId, roleId: 'implement', title: 'Test GH injection', goal: 'Push branch', acceptance: 'PR open' }, USER);
  f.ledger.queueTask(task.id, USER);
  const run = f.ledger.createRun(
    task.id,
    { login: account, machine, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: task.revision },
    USER,
  );

  // Helper to verify poll + credential scoping for a given run.
  async function checkRunTokenDelivery(targetTaskId: string, targetRunId: string): Promise<{ credStatus: number; credBody: NodeCredentialAnswer | null; pollGithub: boolean | undefined }> {
    const cRes = await fetch(`${base}/api/node/runs/${encodeURIComponent(targetRunId)}/credential`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${nodeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: NODE_PROTOCOL }),
    });
    const cBody = cRes.status === 200 ? (await cRes.json()) as NodeCredentialAnswer : null;
    const pPromise = fetch(`${base}/api/node/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${nodeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: NODE_PROTOCOL, cursor: null, runs: [], facts: { node_id: machine.nodeId, name: machine.id, platform: 'linux', hostname: 'worker-1' } }),
    });
    for (let i = 0; i < 50 && !nodes.connected(machine.id); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const sPromise = nodes.send(machine.id, {
      kind: 'start',
      run_dir: `tasks/${targetTaskId}/runs/${targetRunId}`,
      task_id: targetTaskId,
      run_id: targetRunId,
      round: 1,
      argv: ['claude'],
      env: {},
      credential: null,
    });
    const pRes = await pPromise;
    assert.equal(pRes.status, 200);
    const pJson = (await pRes.json()) as NodePollAnswer;
    assert.equal(pJson.command?.kind, 'start');
    const pollGithub = pJson.command?.kind === 'start' ? pJson.command.github : undefined;
    if (pJson.command?.kind === 'start') {
      nodes.report(machine.id, pJson.command.id, true, { code: 0, confirmed: true, pid: 123, started_at: new Date().toISOString() });
    }
    await sPromise;
    return { credStatus: cRes.status, credBody: cBody, pollGithub };
  }

  // Writable run on GitHub project receives github_token and github: true even when roundCredential is null.
  const writableResult = await checkRunTokenDelivery(task.id, run.id);
  assert.equal(writableResult.credStatus, 200);
  assert.equal(writableResult.credBody?.value, null);
  assert.equal(writableResult.credBody?.materials, null);
  assert.equal(writableResult.credBody?.github_token, PAT_TOKEN);
  assert.equal(writableResult.pollGithub, true);

  // Read-only run on the SAME GitHub project must NOT receive github: true or github_token.
  const roTask = f.ledger.createTask({ projectId: f.projectId, roleId: 'analyse', title: 'Read-only analyse', goal: 'Inspect', acceptance: 'Report' }, USER);
  f.ledger.queueTask(roTask.id, USER);
  const roRun = f.ledger.createRun(
    roTask.id,
    {
      login: account,
      machine,
      snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b', access: { permission: 'read', layer: 'sandbox' } },
      expectedRevision: roTask.revision,
    },
    USER,
  );
  const roResult = await checkRunTokenDelivery(roTask.id, roRun.id);
  assert.equal(roResult.credStatus, 409);
  assert.equal(roResult.pollGithub, undefined);

  // Writable run on a non-GitHub project (e.g. GitLab or no repo source) must NOT receive github: true or github_token.
  const nonGhProjectId = f.ledger.createProject({ name: '非 GitHub 项目', logins: ['t1'] }, USER);
  f.ledger.setProjectSources(nonGhProjectId, [
    { kind: 'repo', url: 'https://gitlab.example.com/team/internal.git' },
  ], USER);
  const nonGhTask = f.ledger.createTask({ projectId: nonGhProjectId, roleId: 'implement', title: 'GitLab task', goal: 'Code', acceptance: 'Pass' }, USER);
  f.ledger.queueTask(nonGhTask.id, USER);
  const nonGhRun = f.ledger.createRun(
    nonGhTask.id,
    { login: account, machine, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: nonGhTask.revision },
    USER,
  );
  const nonGhResult = await checkRunTokenDelivery(nonGhTask.id, nonGhRun.id);
  assert.equal(nonGhResult.credStatus, 409);
  assert.equal(nonGhResult.pollGithub, undefined);

  // Knowledge task (project_id === null, e.g. curation task) must NOT receive github: true or github_token.
  const proposal = f.ledger.propose({
    outputs: [{ title: '知识条目', when_to_use: '测试', body: '正文', loading: 'on_demand', project_ids: [f.projectId] }],
  }, { source: 'mcp', by: '外部会话', client: 'mcp:c1', writers: ['codex'] }, USER);
  assert.equal(proposal.state, 'published');
  const entryId = f.ledger.getProposal(proposal.id).final!.outputs[0]!.knowledge_id!;
  const knowledgeTaskId = f.ledger.curate({ entries: [entryId], reason: '测试整理' }, USER);
  const knowledgeTask = f.ledger.getTask(knowledgeTaskId);
  assert.equal(knowledgeTask.project_id, null);
  const knowledgeRun = f.ledger.createRun(
    knowledgeTask.id,
    { login: account, machine, snapshot: { timeout_ms: RUN_LIMIT_MS, brief: 'b' }, expectedRevision: knowledgeTask.revision },
    USER,
  );
  const knowledgeResult = await checkRunTokenDelivery(knowledgeTask.id, knowledgeRun.id);
  assert.equal(knowledgeResult.credStatus, 409);
  assert.equal(knowledgeResult.pollGithub, undefined);

  // Device flow via HTTP routes.
  const devStartRes = await fetch(`${base}/api/github/device/start`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'Ov23liHttpClient' }),
  });
  assert.equal(devStartRes.status, 200);
  const devStart = (await devStartRes.json()) as { session_id: string; user_code: string };
  assert.equal(devStart.user_code, 'HTTP-9999');

  const devPoll1 = await fetch(`${base}/api/github/device/poll`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: devStart.session_id }),
  });
  assert.deepEqual(await devPoll1.json(), { state: 'pending' });

  const devPoll2 = await fetch(`${base}/api/github/device/poll`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: devStart.session_id }),
  });
  const devPoll2Body = await devPoll2.text();
  assert.equal(devPoll2Body.includes(DEVICE_TOKEN), false);
  assert.equal(JSON.parse(devPoll2Body).state, 'connected');

  // DELETE /api/github disconnects; /credential now returns 409 when no other credential/materials exist.
  const delRes = await fetch(`${base}/api/github`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { connected: false, connection: null });

  const credAfterDisconnect = await fetch(`${base}/api/node/runs/${encodeURIComponent(run.id)}/credential`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${nodeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: NODE_PROTOCOL }),
  });
  assert.equal(credAfterDisconnect.status, 409);
});
