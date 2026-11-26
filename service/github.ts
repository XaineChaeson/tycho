// Host-managed GitHub integration: PAT and OAuth Device Flow authentication,
// owner-only secret storage under <data>/secrets/github, non-secret metadata
// persistence, and read-only Pull Request inspection for the Router.
// The token is never logged, never stored in SQLite or metadata JSON, and never
// returned by any console status endpoint.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InputError } from './errors.ts';
import type { Ledger } from './ledger.ts';
import {
  discardSecret,
  githubSecretFile,
  putSecret,
  readSecret,
  removeSecret,
  secretProblem,
  writeOwnerOnly,
} from './secrets.ts';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_DEVICE_SCOPE = 'repo read:org read:user';
const REQUEST_TIMEOUT_MS = 10_000;
const BODY_PREVIEW_MAX_CHARS = 2_000;
const DEFAULT_PR_LIMIT = 20;
const MAX_PR_LIMIT = 100;
const MAX_CLIENT_ID_CHARS = 200;
const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface GitHubConnection {
  login: string;
  name: string | null;
  avatar_url: string | null;
  mode: 'pat' | 'device';
  scopes: string[];
  connected_at: string;
  checked_at: string;
}

export interface GitHubStatus {
  connected: boolean;
  connection: GitHubConnection | null;
  client_id: string | null;
}

export interface GitHubDeviceStart {
  session_id: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubDevicePoll {
  state: 'pending' | 'connected' | 'expired' | 'denied' | 'error';
  connection?: GitHubConnection;
  error?: string;
}

export interface GitHubPullSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  user: string | null;
  head: string;
  base: string;
  updated_at: string;
  html_url: string;
}

export interface GitHubCheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}

export interface GitHubPullDetail {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  mergeable: boolean | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  commits: number;
  changed_files: number;
  additions: number;
  deletions: number;
  html_url: string;
  body_preview: string;
  checks: GitHubCheckRunSummary[];
}

export interface VerifiedGitHubUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
  scopes: string[];
}

interface StoredGitHubMeta {
  connection: GitHubConnection | null;
  client_id: string | null;
}

interface DeviceSession {
  device_code: string;
  client_id: string;
  expires_at: number;
}

export interface GitHubServiceOptions {
  dataDir: string;
  ledger?: Pick<Ledger, 'dispatchConditions'>;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
}

function validRepoSegment(segment: string): boolean {
  return segment !== '.' && segment !== '..' && REPO_SEGMENT.test(segment);
}

// Accepts `owner/repo`, `https://github.com/owner/repo(.git)`, `ssh://git@github.com/owner/repo(.git)`,
// and `git@github.com:owner/repo(.git)`.
export function parseGitHubRepo(input: string): { owner: string; repo: string } | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const scpMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scpMatch) {
    const owner = scpMatch[1]!;
    const repo = scpMatch[2]!;
    return validRepoSegment(owner) && validRepoSegment(repo) ? { owner, repo } : null;
  }

  if (/^(?:https?|ssh):\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (segments.length !== 2) return null;
    const owner = segments[0]!;
    const repo = segments[1]!.replace(/\.git$/i, '');
    return validRepoSegment(owner) && validRepoSegment(repo) ? { owner, repo } : null;
  }

  const slugMatch = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (slugMatch) {
    const owner = slugMatch[1]!;
    const repo = slugMatch[2]!;
    return validRepoSegment(owner) && validRepoSegment(repo) ? { owner, repo } : null;
  }

  return null;
}

function sanitizeError(err: unknown, secret?: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!secret) return raw;
  return raw.split(secret).join('[已隐去的凭据]');
}

function parseConnection(value: unknown): GitHubConnection | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.login !== 'string' || raw.login.trim() === '') return null;
  if (raw.mode !== 'pat' && raw.mode !== 'device') return null;
  if (typeof raw.connected_at !== 'string' || typeof raw.checked_at !== 'string') return null;
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  return {
    login: raw.login,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : null,
    avatar_url: typeof raw.avatar_url === 'string' && raw.avatar_url.trim() !== '' ? raw.avatar_url : null,
    mode: raw.mode,
    scopes,
    connected_at: raw.connected_at,
    checked_at: raw.checked_at,
  };
}

function githubApiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tycho',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractApiMessage(body: unknown): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const msg = (body as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim() !== '') return msg.trim();
  }
  return '';
}

function previewBody(body: unknown): string {
  if (typeof body !== 'string') return '';
  const trimmed = body.trim();
  if (trimmed.length <= BODY_PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, BODY_PREVIEW_MAX_CHARS)}…`;
}

export function createGitHubService(options: GitHubServiceOptions) {
  const { dataDir } = options;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const secretFile = githubSecretFile(dataDir);
  const metaFile = join(dataDir, 'github.json');
  const sessions = new Map<string, DeviceSession>();

  try {
    discardSecret(secretFile);
  } catch {
    // Best-effort cleanup of interrupted secret draft on startup.
  }

  function readMeta(): StoredGitHubMeta {
    if (!existsSync(metaFile)) return { connection: null, client_id: null };
    try {
      const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as { connection?: unknown; client_id?: unknown };
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { connection: null, client_id: null };
      }
      const clientId = typeof parsed.client_id === 'string' && parsed.client_id.trim() !== ''
        ? parsed.client_id.trim()
        : null;
      return {
        connection: parseConnection(parsed.connection),
        client_id: clientId,
      };
    } catch {
      return { connection: null, client_id: null };
    }
  }

  function writeMeta(meta: StoredGitHubMeta): void {
    mkdirSync(dirname(metaFile), { recursive: true });
    // Explicitly pick only non-secret fields.
    const clean: StoredGitHubMeta = {
      connection: meta.connection ? {
        login: meta.connection.login,
        name: meta.connection.name,
        avatar_url: meta.connection.avatar_url,
        mode: meta.connection.mode,
        scopes: [...meta.connection.scopes],
        connected_at: meta.connection.connected_at,
        checked_at: meta.connection.checked_at,
      } : null,
      client_id: meta.client_id,
    };
    writeOwnerOnly(metaFile, `${JSON.stringify(clean, null, 2)}\n`);
  }

  function readToken(): string | null {
    const token = readSecret(secretFile);
    return token === '' ? null : token;
  }

  function status(): GitHubStatus {
    const meta = readMeta();
    const hasToken = readToken() !== null;
    return {
      connected: hasToken,
      connection: hasToken ? meta.connection : null,
      client_id: meta.client_id,
    };
  }

  async function verifyToken(token: string): Promise<VerifiedGitHubUser> {
    const problem = secretProblem(token);
    if (problem !== null) {
      throw new InputError(typeof token !== 'string' || token.trim() === '' ? 'GitHub Token 不能为空' : 'GitHub Token 应为一段不含空白的文字');
    }
    const trimmed = token.trim();
    let response: Response;
    try {
      response = await fetchFn(`${GITHUB_API_BASE}/user`, {
        method: 'GET',
        headers: githubApiHeaders(trimmed),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new InputError(`无法连接 GitHub API：${sanitizeError(err, trimmed)}`);
    }

    const body = await readJsonSafe(response);
    if (response.status === 401) {
      throw new InputError('GitHub Token 无效或已过期（401），请检查后重试');
    }
    if (response.status === 403) {
      const detail = extractApiMessage(body);
      throw new InputError(`GitHub 拒绝访问（403）${detail ? `：${detail}` : '，请检查 Token 权限或速率限制'}`);
    }
    if (!response.ok) {
      const detail = extractApiMessage(body);
      throw new InputError(`验证 GitHub Token 失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new InputError('GitHub 返回的用户信息格式异常');
    }
    const user = body as { login?: unknown; name?: unknown; avatar_url?: unknown };
    if (typeof user.login !== 'string' || user.login.trim() === '') {
      throw new InputError('GitHub 返回的用户信息缺少 login 字段');
    }

    const rawScopes = response.headers.get('x-oauth-scopes') ?? '';
    const scopes = rawScopes
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    return {
      login: user.login.trim(),
      name: typeof user.name === 'string' && user.name.trim() !== '' ? user.name.trim() : null,
      avatar_url: typeof user.avatar_url === 'string' && user.avatar_url.trim() !== '' ? user.avatar_url.trim() : null,
      scopes,
    };
  }

  async function connectPat(token: string): Promise<GitHubConnection> {
    const verified = await verifyToken(token);
    const trimmed = token.trim();
    putSecret(secretFile, trimmed);
    const ts = new Date(now()).toISOString();
    const connection: GitHubConnection = {
      login: verified.login,
      name: verified.name,
      avatar_url: verified.avatar_url,
      mode: 'pat',
      scopes: verified.scopes,
      connected_at: ts,
      checked_at: ts,
    };
    const meta = readMeta();
    writeMeta({ connection, client_id: meta.client_id });
    return connection;
  }

  async function check(): Promise<GitHubConnection> {
    const token = readToken();
    if (token === null) throw new InputError('还没有连接 GitHub');
    const verified = await verifyToken(token);
    const meta = readMeta();
    const ts = new Date(now()).toISOString();
    const connection: GitHubConnection = {
      login: verified.login,
      name: verified.name,
      avatar_url: verified.avatar_url,
      mode: meta.connection?.mode ?? 'pat',
      scopes: verified.scopes,
      connected_at: meta.connection?.connected_at ?? ts,
      checked_at: ts,
    };
    writeMeta({ connection, client_id: meta.client_id });
    return connection;
  }

  function disconnect(): void {
    removeSecret(secretFile);
    sessions.clear();
    const meta = readMeta();
    writeMeta({ connection: null, client_id: meta.client_id });
  }

  function pruneExpiredSessions(): void {
    const currentMs = now();
    for (const [id, session] of sessions) {
      if (currentMs >= session.expires_at) sessions.delete(id);
    }
  }

  async function startDeviceFlow(clientId: string): Promise<GitHubDeviceStart> {
    if (typeof clientId !== 'string' || clientId.trim() === '') {
      throw new InputError('请填写 GitHub OAuth App 的 Client ID');
    }
    const trimmed = clientId.trim();
    if (trimmed.length > MAX_CLIENT_ID_CHARS || /\s/.test(trimmed)) {
      throw new InputError('Client ID 应为一段不含空白的文字');
    }

    const meta = readMeta();
    writeMeta({ connection: meta.connection, client_id: trimmed });
    pruneExpiredSessions();

    let response: Response;
    try {
      response = await fetchFn(GITHUB_DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'tycho',
        },
        body: JSON.stringify({ client_id: trimmed, scope: GITHUB_DEVICE_SCOPE }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new InputError(`无法发起 GitHub Device Flow 授权：${sanitizeError(err)}`);
    }

    const body = (await readJsonSafe(response)) as Record<string, unknown> | null;
    if (!response.ok || (body && typeof body.error === 'string')) {
      const detail = typeof body?.error_description === 'string' && body.error_description.trim() !== ''
        ? body.error_description.trim()
        : typeof body?.error === 'string' && body.error.trim() !== ''
          ? body.error.trim()
          : `HTTP ${response.status}`;
      throw new InputError(`发起 GitHub 设备授权失败：${detail}`);
    }

    const deviceCode = typeof body?.device_code === 'string' ? body.device_code.trim() : '';
    const userCode = typeof body?.user_code === 'string' ? body.user_code.trim() : '';
    const verificationUri = typeof body?.verification_uri === 'string' ? body.verification_uri.trim() : '';
    const expiresIn = typeof body?.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? Math.floor(body.expires_in)
      : 900;
    const interval = typeof body?.interval === 'number' && Number.isFinite(body.interval) && body.interval > 0
      ? Math.floor(body.interval)
      : 5;

    if (!deviceCode || !userCode || !verificationUri) {
      throw new InputError('GitHub 返回的设备授权信息不完整');
    }

    const sessionId = randomBytes(16).toString('hex');
    sessions.set(sessionId, {
      device_code: deviceCode,
      client_id: trimmed,
      expires_at: now() + expiresIn * 1000,
    });

    return {
      session_id: sessionId,
      user_code: userCode,
      verification_uri: verificationUri,
      expires_in: expiresIn,
      interval,
    };
  }

  async function pollDeviceFlow(sessionId: string): Promise<GitHubDevicePoll> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new InputError('缺少 session_id');
    }
    const session = sessions.get(sessionId);
    if (!session) {
      return { state: 'expired', error: '授权会话不存在或已过期，请重新发起授权' };
    }
    if (now() >= session.expires_at) {
      sessions.delete(sessionId);
      return { state: 'expired', error: '设备授权码已过期，请重新发起授权' };
    }

    let response: Response;
    try {
      response = await fetchFn(GITHUB_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'tycho',
        },
        body: JSON.stringify({
          client_id: session.client_id,
          device_code: session.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { state: 'error', error: `轮询 GitHub 授权失败：${sanitizeError(err)}` };
    }

    const body = (await readJsonSafe(response)) as Record<string, unknown> | null;
    if (body && typeof body.access_token === 'string' && body.access_token.trim() !== '') {
      const accessToken = body.access_token.trim();
      try {
        const verified = await verifyToken(accessToken);
        putSecret(secretFile, accessToken);
        const ts = new Date(now()).toISOString();
        const connection: GitHubConnection = {
          login: verified.login,
          name: verified.name,
          avatar_url: verified.avatar_url,
          mode: 'device',
          scopes: verified.scopes,
          connected_at: ts,
          checked_at: ts,
        };
        writeMeta({ connection, client_id: session.client_id });
        sessions.delete(sessionId);
        return { state: 'connected', connection };
      } catch (err) {
        sessions.delete(sessionId);
        return { state: 'error', error: sanitizeError(err, accessToken) };
      }
    }

    const errCode = typeof body?.error === 'string' ? body.error : '';
    if (errCode === 'authorization_pending' || errCode === 'slow_down') {
      return { state: 'pending' };
    }
    if (errCode === 'expired_token') {
      sessions.delete(sessionId);
      return { state: 'expired', error: '设备授权码已过期，请重新发起授权' };
    }
    if (errCode === 'access_denied') {
      sessions.delete(sessionId);
      return { state: 'denied', error: '用户取消了 GitHub 授权' };
    }

    sessions.delete(sessionId);
    const detail = typeof body?.error_description === 'string' && body.error_description.trim() !== ''
      ? body.error_description.trim()
      : errCode || `HTTP ${response.status}`;
    return { state: 'error', error: `GitHub 授权失败：${detail}` };
  }

  function requireConnectedToken(): string {
    const token = readToken();
    if (token === null) {
      throw new InputError('尚未连接 GitHub，请先在控制台“设置 › GitHub”中完成连接');
    }
    return token;
  }

  function requireParsedRepo(repoInput: string): { owner: string; repo: string } {
    const parsed = parseGitHubRepo(repoInput);
    if (parsed === null) {
      throw new InputError(`无法识别 GitHub 仓库地址：${repoInput}，请填写 owner/repo 或 GitHub 仓库 URL`);
    }
    return parsed;
  }

  async function githubGetJson(path: string, token: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(`${GITHUB_API_BASE}${path}`, {
        method: 'GET',
        headers: githubApiHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new InputError(`请求 GitHub API 失败：${sanitizeError(err, token)}`);
    }

    const body = await readJsonSafe(response);
    if (response.status === 401) {
      throw new InputError('GitHub 凭据已失效（401），请到控制台“设置 › GitHub”重新连接');
    }
    if (response.status === 403) {
      const detail = extractApiMessage(body);
      throw new InputError(`GitHub 拒绝访问（403）${detail ? `：${detail}` : '，请检查 Token 权限或速率限制'}`);
    }
    if (response.status === 404) {
      throw new InputError('GitHub 仓库或 PR 不存在，或当前 Token 没有访问权限（404）');
    }
    if (!response.ok) {
      const detail = extractApiMessage(body);
      throw new InputError(`GitHub API 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }
    return body;
  }

  async function listPullRequests(
    repoInput: string,
    state: 'open' | 'closed' | 'all' = 'open',
    limit: number = DEFAULT_PR_LIMIT,
  ): Promise<GitHubPullSummary[]> {
    const { owner, repo } = requireParsedRepo(repoInput);
    const token = requireConnectedToken();
    if (state !== 'open' && state !== 'closed' && state !== 'all') {
      throw new InputError('state 只能是 open、closed 或 all');
    }
    const perPage = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_PR_LIMIT) : DEFAULT_PR_LIMIT;
    const raw = await githubGetJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=${perPage}&sort=updated&direction=desc`,
      token,
    );
    if (!Array.isArray(raw)) {
      throw new InputError('GitHub 返回的 PR 列表格式异常');
    }
    return raw.map((item) => {
      const pr = (item ?? {}) as {
        number?: unknown;
        title?: unknown;
        state?: unknown;
        draft?: unknown;
        user?: { login?: unknown } | null;
        head?: { ref?: unknown } | null;
        base?: { ref?: unknown } | null;
        updated_at?: unknown;
        html_url?: unknown;
      };
      return {
        number: typeof pr.number === 'number' ? pr.number : 0,
        title: typeof pr.title === 'string' ? pr.title : '',
        state: typeof pr.state === 'string' ? pr.state : '',
        draft: Boolean(pr.draft),
        user: typeof pr.user?.login === 'string' ? pr.user.login : null,
        head: typeof pr.head?.ref === 'string' ? pr.head.ref : '',
        base: typeof pr.base?.ref === 'string' ? pr.base.ref : '',
        updated_at: typeof pr.updated_at === 'string' ? pr.updated_at : '',
        html_url: typeof pr.html_url === 'string' ? pr.html_url : '',
      };
    });
  }

  async function getPullRequest(repoInput: string, number: number): Promise<GitHubPullDetail> {
    const { owner, repo } = requireParsedRepo(repoInput);
    if (!Number.isInteger(number) || number < 1) {
      throw new InputError('PR 编号应为正整数');
    }
    const token = requireConnectedToken();
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const raw = await githubGetJson(`/repos/${encodedOwner}/${encodedRepo}/pulls/${number}`, token);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InputError('GitHub 返回的 PR 详情格式异常');
    }
    const pr = raw as {
      number?: unknown;
      title?: unknown;
      state?: unknown;
      draft?: unknown;
      mergeable?: unknown;
      head?: { ref?: unknown; sha?: unknown } | null;
      base?: { ref?: unknown; sha?: unknown } | null;
      commits?: unknown;
      changed_files?: unknown;
      additions?: unknown;
      deletions?: unknown;
      html_url?: unknown;
      body?: unknown;
    };

    const headSha = typeof pr.head?.sha === 'string' ? pr.head.sha : '';
    let checks: GitHubCheckRunSummary[] = [];
    if (headSha !== '') {
      try {
        const checksResponse = await fetchFn(
          `${GITHUB_API_BASE}/repos/${encodedOwner}/${encodedRepo}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=50`,
          {
            method: 'GET',
            headers: githubApiHeaders(token),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
        if (checksResponse.ok) {
          const checksBody = (await readJsonSafe(checksResponse)) as { check_runs?: unknown } | null;
          if (Array.isArray(checksBody?.check_runs)) {
            checks = checksBody.check_runs.map((entry) => {
              const run = (entry ?? {}) as { name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown };
              return {
                name: typeof run.name === 'string' ? run.name : '',
                status: typeof run.status === 'string' ? run.status : '',
                conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
                html_url: typeof run.html_url === 'string' ? run.html_url : null,
              };
            });
          }
        }
      } catch {
        // Best-effort check-runs fetch: do not fail PR detail when checks are unavailable.
      }
    }

    return {
      number: typeof pr.number === 'number' ? pr.number : number,
      title: typeof pr.title === 'string' ? pr.title : '',
      state: typeof pr.state === 'string' ? pr.state : '',
      draft: Boolean(pr.draft),
      mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
      head: {
        ref: typeof pr.head?.ref === 'string' ? pr.head.ref : '',
        sha: headSha,
      },
      base: {
        ref: typeof pr.base?.ref === 'string' ? pr.base.ref : '',
        sha: typeof pr.base?.sha === 'string' ? pr.base.sha : '',
      },
      commits: typeof pr.commits === 'number' ? pr.commits : 0,
      changed_files: typeof pr.changed_files === 'number' ? pr.changed_files : 0,
      additions: typeof pr.additions === 'number' ? pr.additions : 0,
      deletions: typeof pr.deletions === 'number' ? pr.deletions : 0,
      html_url: typeof pr.html_url === 'string' ? pr.html_url : '',
      body_preview: previewBody(pr.body),
      checks,
    };
  }

  return {
    status,
    verifyToken,
    connectPat,
    check,
    disconnect,
    startDeviceFlow,
    pollDeviceFlow,
    readToken,
    parseGitHubRepo,
    listPullRequests,
    getPullRequest,
  };
}

export type GitHubService = ReturnType<typeof createGitHubService>;
