import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DIRECTORY_FEED_PATH, type DirectoryFeed, type DirectoryPeer, type DirectoryProject, type DirectoryView } from '../shared/project-directory.ts';
import { InputError } from './errors.ts';
import type { Ledger } from './ledger.ts';
import { acquireLock } from './lock.ts';
import { prepareOwnerOnlyDirectory, writeOwnerOnly } from './secrets.ts';

const SERVICE_ID = /^tycho:[a-f0-9]{64}$/;
const PROJECT_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TOKEN = /^[a-zA-Z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_PROJECTS = 1000;
const MAX_PEERS = 12;
const MAX_FEED_BYTES = 256 * 1024;
const REQUEST_MS = 3500;

interface RegisteredPeer {
  service_id: string;
  environment: string;
  origin: string;
}
interface PeerConfig extends RegisteredPeer {
  token: string;
}
interface Config {
  token_hash: string | null;
  peers: PeerConfig[];
}
interface CachedFeed {
  observed_at: string;
  feed: DirectoryFeed;
}

const projectDirectoryDir = (dataDir: string): string => join(dataDir, 'project-directory');
const configPath = (dataDir: string): string => join(projectDirectoryDir(dataDir), 'config.json');
const cachePath = (dataDir: string, { service_id, origin }: RegisteredPeer): string =>
  join(projectDirectoryDir(dataDir), 'cache-' + hash(service_id + '\n' + origin) + '.json');
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new InputError('无法读取服务目录文件：' + path);
  }
}

function configOf(dataDir: string): Config {
  const raw = readJson(configPath(dataDir)) as Config | undefined;
  if (raw === undefined) return { token_hash: null, peers: [] };
  if (!raw || (raw.token_hash !== null && (typeof raw.token_hash !== 'string' || !HASH.test(raw.token_hash))) || !Array.isArray(raw.peers) || raw.peers.length > MAX_PEERS) {
    throw new InputError('服务目录配置格式无效');
  }
  const seen = new Set<string>();
  for (const config of raw.peers) {
    normalizePeer(config);
    if (seen.has(config.service_id)) throw new InputError('服务目录编号重复');
    seen.add(config.service_id);
  }
  return raw;
}

function changeConfig<T>(dataDir: string, change: (config: Config) => T): T {
  const dir = projectDirectoryDir(dataDir);
  prepareOwnerOnlyDirectory(dir);
  const lock = join(dir, 'config.lock');
  acquireLock(lock, () => {});
  try {
    const config = configOf(dataDir);
    const result = change(config);
    writeOwnerOnly(configPath(dataDir), JSON.stringify(config));
    return result;
  } finally {
    rmSync(lock, { force: true });
  }
}

function normalizePeer(raw: PeerConfig): PeerConfig {
  if (typeof raw?.service_id !== 'string' || !SERVICE_ID.test(raw.service_id)) throw new InputError('目录服务编号不正确');
  const environment = typeof raw.environment === 'string' ? raw.environment.trim() : '';
  if (environment.length === 0 || environment.length > 80 || /[\p{Cc}]/u.test(environment)) throw new InputError('请输入有效环境名称，最多 80 字符');
  if (typeof raw.token !== 'string' || !TOKEN.test(raw.token)) throw new InputError('需要远程环境签发的目录令牌');
  let url: URL;
  try {
    url = new URL(raw.origin);
  } catch {
    throw new InputError('服务目录地址无效');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.hash || url.search) {
    throw new InputError('服务目录地址需要独立 HTTPS origin，例如 https://tycho.example');
  }
  return { service_id: raw.service_id, environment, origin: url.origin, token: raw.token };
}

function projectOf(entry: unknown): DirectoryProject | undefined {
  const { id, name, generation } = (entry ?? {}) as DirectoryProject;
  if (typeof id !== 'string' || !PROJECT_ID.test(id) || typeof name !== 'string' || !name.trim() || name.length > 200
    || !Number.isSafeInteger(generation) || generation < 1) return undefined;
  return { id, name, generation };
}

function acceptFeed(raw: unknown, serviceId: string): DirectoryFeed {
  const body = raw as DirectoryFeed | undefined;
  if (!body || body.version !== 1 || body.service_id !== serviceId || !Array.isArray(body.projects) || body.projects.length > MAX_PROJECTS) {
    throw new InputError('远程目录身份、版本或项目清单无效');
  }
  const projects = body.projects.map(projectOf);
  if (projects.some((project) => project === undefined) || new Set(projects.map((project) => project?.id)).size !== projects.length) {
    throw new InputError('远程目录项目清单无效');
  }
  return { version: 1, service_id: serviceId, projects: projects as DirectoryProject[] };
}

async function fetchDirectory({ service_id, origin, token }: PeerConfig): Promise<DirectoryFeed> {
  const response = await fetch(origin + DIRECTORY_FEED_PATH, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new InputError('远程目录不可读');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.length;
    if (bytes > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new InputError('远程目录响应过大');
    }
    chunks.push(part.value);
  }
  return acceptFeed(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')), service_id);
}

function storedFeed(dataDir: string, peer: PeerConfig): CachedFeed | undefined {
  try {
    const cached = readJson(cachePath(dataDir, peer)) as CachedFeed | undefined;
    if (cached && typeof cached.observed_at === 'string' && Number.isFinite(Date.parse(cached.observed_at))) {
      return { observed_at: cached.observed_at, feed: acceptFeed(cached.feed, peer.service_id) };
    }
  } catch {
    // A cache is disposable, including a partial or corrupted one.
  }
  return undefined;
}

function publicPeer({ service_id, environment, origin }: PeerConfig): RegisteredPeer {
  return { service_id, environment, origin };
}

export function issueProjectDirectoryToken(dataDir: string): string {
  const token = randomBytes(32).toString('base64url');
  changeConfig(dataDir, (config) => { config.token_hash = hash(token); });
  return token;
}

export function revokeProjectDirectoryToken(dataDir: string): void {
  changeConfig(dataDir, (config) => { config.token_hash = null; });
}

export function registerProjectDirectoryPeer(dataDir: string, raw: PeerConfig): void {
  const peer = normalizePeer(raw);
  changeConfig(dataDir, (config) => {
    const prior = config.peers.find(({ service_id }) => service_id === peer.service_id);
    if (!prior && config.peers.length >= MAX_PEERS) throw new InputError('服务目录登记数量达到上限');
    if (prior && prior.origin !== peer.origin) rmSync(cachePath(dataDir, prior), { force: true });
    config.peers = [...config.peers.filter(({ service_id }) => service_id !== peer.service_id), peer];
  });
}

export function removeProjectDirectoryPeer(dataDir: string, serviceId: string): void {
  if (!SERVICE_ID.test(serviceId)) throw new InputError('目录服务编号不正确');
  changeConfig(dataDir, (config) => {
    const prior = config.peers.find(({ service_id }) => service_id === serviceId);
    if (prior) rmSync(cachePath(dataDir, prior), { force: true });
    config.peers = config.peers.filter(({ service_id }) => service_id !== serviceId);
  });
}

export function listProjectDirectoryPeers(dataDir: string): RegisteredPeer[] {
  return configOf(dataDir).peers.map(publicPeer);
}

export function projectDirectoryFeed(ledger: Pick<Ledger, 'listProjects' | 'projectHome'>, serviceId: string | undefined): DirectoryFeed | null {
  if (!serviceId) return null;
  const projects: DirectoryProject[] = [];
  for (const project of ledger.listProjects()) {
    if (project.archived_at !== null) continue;
    const ownership = ledger.projectHome(project.id);
    if (ownership?.phase === 'owned' && ownership.generation !== null && ownership.service_id === serviceId) {
      projects.push({ id: project.id, name: project.name, generation: ownership.generation });
    }
  }
  if (projects.length > MAX_PROJECTS) throw new InputError('这个服务的项目目录超过可公开的数量上限');
  return { version: 1, service_id: serviceId, projects };
}

export function createProjectDirectory({ dataDir, local }: { dataDir: string; local: () => DirectoryFeed | null }) {
  let reading: Promise<DirectoryView> | undefined;

  async function peerView(peer: PeerConfig): Promise<DirectoryPeer> {
    const visible = publicPeer(peer);
    try {
      const feed = await fetchDirectory(peer);
      const observed_at = new Date().toISOString();
      // Configuration may change while an upstream fetch is in flight. Never recreate a
      // removed peer's cache after its owner revoked the local registration.
      const stillRegistered = configOf(dataDir).peers.some((now) => now.service_id === peer.service_id && now.origin === peer.origin && now.token === peer.token);
      if (stillRegistered) writeOwnerOnly(cachePath(dataDir, peer), JSON.stringify({ observed_at, feed }));
      return { ...visible, status: 'online', observed_at, projects: feed.projects };
    } catch {
      const cached = storedFeed(dataDir, peer);
      return { ...visible, status: 'offline', observed_at: cached?.observed_at ?? null, projects: cached?.feed.projects ?? [] };
    }
  }

  return {
    feed(authorization: string | undefined): DirectoryFeed | null {
      if (!authorization?.startsWith('Bearer ')) return null;
      const token = authorization.slice('Bearer '.length);
      if (!TOKEN.test(token) || !existsSync(configPath(dataDir))) return null;
      const expected = configOf(dataDir).token_hash;
      return expected && timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(expected, 'hex')) ? local() : null;
    },
    view(): Promise<DirectoryView> {
      reading ??= (async () => {
        const self = local();
        const peers = await Promise.all(configOf(dataDir).peers.filter(({ service_id }) => service_id !== self?.service_id).map(peerView));
        const current = configOf(dataDir).peers;
        return { local: local(), peers: peers.filter((peer) => current.some((registered) => registered.service_id === peer.service_id && registered.origin === peer.origin)) };
      })().finally(() => { reading = undefined; });
      return reading;
    },
  };
}
