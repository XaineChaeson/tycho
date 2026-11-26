// Only the GitHub transport. Installation, compatibility and recovery remain in install.ts.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync, writeFileSync } from 'node:fs';
import { isVersion } from './paths.ts';
import type { System } from './system.ts';

const REPO = 'github.com/XaineChaeson/tycho';
const API = 'repos/XaineChaeson/tycho/releases';
const PUBLIC_API = 'https://api.github.com/repos/XaineChaeson/tycho/releases';
const ASSET = 'tycho.tar.gz';
const SUMS_ASSET = 'SHA256SUMS';
const USER_AGENT = 'tycho-updater';
const MAX_SUMS_BYTES = 64 * 1024;
const FIELDS = '{tag_name,draft,prerelease,assets:[.assets[]|select(.name=="tycho.tar.gz")|{id,name,size,state,digest}]}';
const OFFLINE = '也可以在已授权的 GitHub CLI 或浏览器下载该版 tycho.tar.gz，按 SHA256SUMS 核对，再用 tycho update --from <发布包>。';
const LOGIN = '请在运行 tycho update 的用户下安装 GitHub CLI，并用 gh auth login --hostname github.com 正常登录有仓库权限的账号。';
const ENV = { GH_PROMPT_DISABLED: '1', GH_DEBUG: '', DEBUG: '', GH_FORCE_TTY: '', GH_PAGER: '', CLICOLOR_FORCE: '0', NO_COLOR: '1' };
const ORIGINAL_FETCH = globalThis.fetch;

interface Release {
  version: string;
  sha256: string;
  bytes: number;
}

interface ParsedReleaseBase {
  version: string;
  bytes: number;
  asset: Record<string, unknown>;
  allAssets: Record<string, unknown>[];
}

function parseReleaseBase(text: string, requested?: string): ParsedReleaseBase {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`GitHub 发行元数据不是有效 JSON。${OFFLINE}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`GitHub 发行元数据格式不完整。${OFFLINE}`);
  const value = raw as Record<string, unknown>;
  const version = typeof value.tag_name === 'string' && value.tag_name.startsWith('v') ? value.tag_name.slice(1) : undefined;
  if (!isVersion(version) || (requested !== undefined && version !== requested)) throw new Error(`GitHub 发行版本与所选版本不一致或不能识别。${OFFLINE}`);
  if (value.draft === true) throw new Error(`不安装 GitHub 草稿发行版。${OFFLINE}`);
  if (value.draft !== false || typeof value.prerelease !== 'boolean') throw new Error(`GitHub 发行元数据缺少发布状态。${OFFLINE}`);
  if (requested === undefined && value.prerelease) throw new Error(`默认升级只接受稳定发行版；预发行版请明确用 tycho update --to <版本>。${OFFLINE}`);
  const allAssets = Array.isArray(value.assets)
    ? value.assets.filter((asset): asset is Record<string, unknown> => asset !== null && typeof asset === 'object' && !Array.isArray(asset))
    : [];
  const assets = allAssets.filter((asset) => asset.name === ASSET);
  if (assets.length !== 1 || assets[0]!.state !== 'uploaded') throw new Error(`GitHub 发行版没有唯一、已上传的 ${ASSET} 资产。${OFFLINE}`);
  const asset = assets[0]!;
  if (!Number.isSafeInteger(asset.size) || (asset.size as number) <= 0) throw new Error(`GitHub 发行资产大小不正确。${OFFLINE}`);
  return { version, bytes: asset.size as number, asset, allAssets };
}

function parseDigest(digest: unknown): string | undefined {
  if (typeof digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(digest)) return undefined;
  return digest.slice(7).toLowerCase();
}

function metadata(text: string, requested?: string): Release {
  const { version, bytes, asset } = parseReleaseBase(text, requested);
  const sha256 = parseDigest(asset.digest);
  if (sha256 === undefined) throw new Error(`GitHub 发行资产缺少有效 SHA256 摘要，不能确认取回的是所选内容。${OFFLINE}`);
  return { version, sha256, bytes };
}

function isTrustedGitHubUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

function parseSha256Sums(text: string, filename: string): string | undefined {
  let matched: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)$/.exec(trimmed);
    if (!match) continue;
    const name = match[2]!.replace(/^\.\//, '');
    if (name !== filename) continue;
    const digest = match[1]!.toLowerCase();
    if (matched !== undefined && matched !== digest) return undefined;
    matched = digest;
  }
  return matched;
}

async function verifyDownloadedFile(destination: string, release: Release): Promise<void> {
  if (statSync(destination).size !== release.bytes) {
    throw new Error(`GitHub 发布包大小校验失败，未解包或换版；资产可能已被替换，请重新选择版本。${OFFLINE}`);
  }
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(destination)) hash.update(bytes);
  if (hash.digest('hex') !== release.sha256) {
    throw new Error(`GitHub 发布包摘要校验失败，未解包或换版；资产可能已被替换，请重新选择版本。${OFFLINE}`);
  }
}

async function writeResponseBounded(response: Response, destination: string, expectedBytes: number): Promise<void> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(destination, buffer);
    return;
  }
  const stream = createWriteStream(destination);
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > expectedBytes) {
        stream.destroy();
        throw new Error(`GitHub 发布包大小校验失败，未解包或换版；资产可能已被替换，请重新选择版本。${OFFLINE}`);
      }
      if (!stream.write(buf)) {
        await new Promise<void>((resolve, reject) => {
          stream.once('drain', resolve);
          stream.once('error', reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.once('error', reject);
    });
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

function resolvePublicFetch(
  system: Pick<System, 'env'>,
  injectedFetch?: typeof globalThis.fetch,
): typeof globalThis.fetch | null {
  if (system.env.TYCHO_USE_GH_CLI === '1') return null;
  if (injectedFetch !== undefined) return injectedFetch;
  if (globalThis.fetch !== ORIGINAL_FETCH) return globalThis.fetch;
  if (process.env.NODE_TEST_CONTEXT || process.env.TYCHO_TEST_GUARD) return null;
  return globalThis.fetch;
}

async function fetchPublicRelease(
  doFetch: typeof globalThis.fetch,
  destination: string,
  requested?: string,
): Promise<Release | null> {
  const endpoint = `${PUBLIC_API}/${requested === undefined ? 'latest' : `tags/v${requested}`}`;
  let metaRes: Response;
  try {
    metaRes = await doFetch(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/timeout|aborted/i.test(text)) {
      throw new Error(`GitHub 请求超时，请检查正常代理和网络后重试。${OFFLINE}`);
    }
    throw new Error(`无法访问公开 GitHub 发行接口，请检查网络或代理后重试。${OFFLINE}`);
  }
  if (metaRes.status === 404 || metaRes.status === 401 || metaRes.status === 403) {
    return null;
  }
  if (!metaRes.ok) {
    throw new Error(`公开 GitHub 发行接口返回 HTTP ${metaRes.status}。${OFFLINE}`);
  }

  const { version, bytes, asset, allAssets } = parseReleaseBase(await metaRes.text(), requested);
  if (!isTrustedGitHubUrl(asset.browser_download_url)) {
    throw new Error(`GitHub 发行资产下载地址无效或不受信任。${OFFLINE}`);
  }

  let sha256: string | undefined;
  if (asset.digest !== undefined && asset.digest !== null) {
    sha256 = parseDigest(asset.digest);
  } else {
    const sumsAssets = allAssets.filter((each) => each.name === SUMS_ASSET);
    if (
      sumsAssets.length === 1 &&
      sumsAssets[0]!.state === 'uploaded' &&
      Number.isSafeInteger(sumsAssets[0]!.size) &&
      (sumsAssets[0]!.size as number) > 0 &&
      (sumsAssets[0]!.size as number) <= MAX_SUMS_BYTES &&
      isTrustedGitHubUrl(sumsAssets[0]!.browser_download_url)
    ) {
      let sumsRes: Response;
      try {
        sumsRes = await doFetch(sumsAssets[0]!.browser_download_url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error(`无法下载 GitHub 发行校验文件 ${SUMS_ASSET}。${OFFLINE}`);
      }
      if (sumsRes.ok) {
        const sumsText = await sumsRes.text();
        if (Buffer.byteLength(sumsText, 'utf8') <= MAX_SUMS_BYTES) {
          sha256 = parseSha256Sums(sumsText, ASSET);
        }
      }
    }
  }
  if (sha256 === undefined) {
    throw new Error(`GitHub 发行资产缺少有效 SHA256 摘要，不能确认取回的是所选内容。${OFFLINE}`);
  }

  let downloadRes: Response;
  try {
    downloadRes = await doFetch(asset.browser_download_url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/timeout|aborted/i.test(text)) {
      throw new Error(`GitHub 发布包下载超时，请检查正常代理和网络后重试。${OFFLINE}`);
    }
    throw new Error(`GitHub 发布包下载失败，请检查网络后重试。${OFFLINE}`);
  }
  if (!downloadRes.ok) {
    throw new Error(`GitHub 发布包下载失败（HTTP ${downloadRes.status}）。${OFFLINE}`);
  }

  const release: Release = { version, sha256, bytes };
  await writeResponseBounded(downloadRes, destination, bytes);
  await verifyDownloadedFile(destination, release);
  return release;
}

export async function fetchGitHubRelease(
  system: Pick<System, 'exec' | 'env'>,
  destination: string,
  { version, fetch: injectedFetch }: { version?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<Release> {
  if (version !== undefined && !isVersion(version)) throw new Error(`所选发行版本不能识别。${OFFLINE}`);

  const publicFetch = resolvePublicFetch(system, injectedFetch);
  if (publicFetch !== null) {
    const publicRelease = await fetchPublicRelease(publicFetch, destination, version);
    if (publicRelease !== null) return publicRelease;
  }

  const exec = (args: string[], timeoutMs: number): string => {
    // gh retains its ordinary local credential and proxy handling. Never extract a token
    // or relay its debug/error output, which can contain credentials or signed URLs.
    const result = system.exec('gh', args, { env: ENV, timeoutMs });
    if (result.code !== 0) {
      const reason = result.code === 4 ? `GitHub 身份未登录。${LOGIN}`
        : result.code === 127 && /ENOENT|not found|cannot find/i.test(result.stderr) ? `找不到 GitHub CLI。${LOGIN}`
        : /ETIMEDOUT|timed?\s*out/i.test(result.stderr) ? 'GitHub 请求超时，请检查正常代理和网络后重试。'
        : '没有取到可访问的 GitHub 发行版或资产；请用 gh auth status --hostname github.com 核对当前身份和仓库访问权限，再确认该版本是否已发布（默认必须有稳定版）以及网络。';
      throw new Error(`${reason}${OFFLINE}`);
    }
    return result.stdout;
  };
  const release = metadata(exec(['api', '--hostname', 'github.com', `${API}/${version === undefined ? 'latest' : 'tags/v' + version}`, '--jq', FIELDS], 30_000), version);
  exec(['release', 'download', 'v' + release.version, '--repo', REPO, '--pattern', ASSET, '--output', destination], 180_000);
  await verifyDownloadedFile(destination, release);
  return release;
}
