// A private GitHub asset must keep its selected version and content identity through
// download; missing access, malformed metadata and races never become an installation.
import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchGitHubRelease } from '../cli/github-release.ts';
import type { System } from '../cli/system.ts';
import { tempDir } from './cli-helpers.ts';

const content = Buffer.from('a synthetic official release');
const sha256 = createHash('sha256').update(content).digest('hex');
const metadata = () => ({ tag_name: 'v1.1.0', draft: false, prerelease: false,
  assets: [{ id: 12, name: 'tycho.tar.gz', size: content.length, state: 'uploaded', digest: `sha256:${sha256}` }] });
type Result = { code: number; stdout: string; stderr: string };

test('stable lookup and exact canonical asset download reuse gh identity, fixed host and bounded noninteractive calls', async (t) => {
  const destination = join(tempDir(t), 'release.tar.gz');
  const calls: { args: string[]; options: unknown }[] = [];
  const system: Pick<System, 'exec' | 'env'> = {
    env: { HTTPS_PROXY: 'http://proxy.invalid:8080', GH_TOKEN: 'never-copy-this', GH_DEBUG: 'api' },
    exec(file, args, options) {
      assert.equal(file, 'gh'); calls.push({ args, options });
      if (args[0] === 'api') return { code: 0, stdout: JSON.stringify(metadata()), stderr: '' };
      writeFileSync(destination, content); return { code: 0, stdout: '', stderr: '' };
    },
  };
  assert.deepEqual(await fetchGitHubRelease(system, destination), { version: '1.1.0', sha256, bytes: content.length });
  assert.ok(calls[0]!.args.includes('repos/XaineChaeson/tycho/releases/latest'));
  assert.deepEqual(calls[1]!.args, ['release', 'download', 'v1.1.0', '--repo', 'github.com/XaineChaeson/tycho', '--pattern', 'tycho.tar.gz', '--output', destination]);
  for (const { options } of calls) {
    const opts = options as { env: Record<string, string>; timeoutMs: number };
    assert.equal(opts.env.GH_PROMPT_DISABLED, '1'); assert.equal(opts.env.GH_DEBUG, '');
    assert.equal(opts.env.DEBUG, ''); assert.ok(opts.timeoutMs > 0);
    assert.equal(opts.env.GH_TOKEN, undefined, 'do not copy credentials into the child override');
    assert.equal(opts.env.HTTPS_PROXY, undefined, 'leave ordinary process proxy inheritance intact');
  }
  assert.ok(calls[0]!.args.includes('github.com'));
});

test('only an explicit version accepts a prerelease; the selected tag must match and drafts never install', async (t) => {
  for (const [explicit, changed, expected] of [
    [undefined, { prerelease: true }, /稳定/],
    ['1.1.0', { draft: true }, /草稿/],
    ['1.1.0', { tag_name: 'v1.2.0' }, /版本/],
  ] as const) {
    const destination = join(tempDir(t), 'x.tar.gz'); let downloaded = false;
    const system = { env: {}, exec(_file: string, args: string[]): Result {
      if (args[0] === 'api') return { code: 0, stdout: JSON.stringify({ ...metadata(), ...changed }), stderr: '' };
      downloaded = true; throw new Error('must not download');
    } };
    await assert.rejects(fetchGitHubRelease(system, destination, { version: explicit }), expected);
    assert.equal(downloaded, false);
  }
  const destination = join(tempDir(t), 'preview.tar.gz'); const calls: string[][] = [];
  await fetchGitHubRelease({ env: {}, exec(_file, args) {
    calls.push(args);
    if (args[0] === 'api') return { code: 0, stdout: JSON.stringify({ ...metadata(), prerelease: true }), stderr: '' };
    writeFileSync(destination, content); return { code: 0, stdout: '', stderr: '' };
  } }, destination, { version: '1.1.0' });
  assert.ok(calls[0]!.includes('repos/XaineChaeson/tycho/releases/tags/v1.1.0'));
});

test('metadata has exactly one uploaded canonical asset with a valid digest and positive safe byte count', async (t) => {
  const asset = metadata().assets[0]!;
  for (const assets of [[], [asset, asset], [{ ...asset, name: 'tycho-1.1.0.tar.gz' }],
    [{ ...asset, state: 'new' }], [{ ...asset, digest: null }], [{ ...asset, digest: 'sha256:bad' }],
    [{ ...asset, size: 0 }], [{ ...asset, size: Number.MAX_SAFE_INTEGER + 1 }]]) {
    let downloaded = false;
    await assert.rejects(fetchGitHubRelease({ env: {}, exec(_file, args) {
      if (args[0] !== 'api') { downloaded = true; throw new Error('unexpected download'); }
      return { code: 0, stdout: JSON.stringify({ ...metadata(), assets }), stderr: '' };
    } }, join(tempDir(t), 'x')), /发行|资产|摘要|大小/);
    assert.equal(downloaded, false);
  }
});

test('a changed asset or incomplete download fails against the first metadata without retry or token disclosure', async (t) => {
  for (const bytes of [Buffer.from('another asset of same length'), content.subarray(1)]) {
    const destination = join(tempDir(t), 'x'); let calls = 0;
    await assert.rejects(fetchGitHubRelease({ env: {}, exec(_file, args) {
      calls++;
      if (args[0] === 'api') return { code: 0, stdout: JSON.stringify(metadata()), stderr: '' };
      writeFileSync(destination, bytes); return { code: 0, stdout: '', stderr: '' };
    } }, destination), /校验|摘要|大小/);
    assert.equal(calls, 2);
  }
});

test('missing gh, authentication, inaccessible/latest 404, transport timeout and bad JSON give a safe offline route', async (t) => {
  for (const result of [
    { code: 127, stderr: 'spawn gh ENOENT PRIVATE_SECRET' },
    { code: 4, stderr: 'GH_TOKEN=PRIVATE_SECRET' },
    { code: 1, stderr: 'HTTP 404 https://user:PRIVATE_SECRET@github.com' },
    { code: 127, stderr: 'spawnSync gh ETIMEDOUT PRIVATE_SECRET' },
    { code: 0, stdout: 'not JSON PRIVATE_SECRET' },
  ]) {
    await assert.rejects(fetchGitHubRelease({ env: {}, exec() { return { stdout: '', stderr: '', ...result }; } }, join(tempDir(t), 'x')), error => {
      const text = (error as Error).message;
      assert.match(text, /--from/); assert.doesNotMatch(text, /PRIVATE_SECRET/);
      if (result.code === 4) assert.match(text, /gh auth login/);
      if (result.stderr?.includes('404')) assert.match(text, /权限|访问/);
      if (result.stderr?.includes('ENOENT')) assert.match(text, /GitHub CLI/);
      return true;
    });
  }
});

test('unsafe requested or returned version is rejected before any asset command', async (t) => {
  let calls = 0;
  const system = { env: {}, exec(): Result { calls++; return { code: 0, stdout: JSON.stringify({ ...metadata(), tag_name: 'v../outside' }), stderr: '' }; } };
  await assert.rejects(fetchGitHubRelease(system, join(tempDir(t), 'x'), { version: '../outside' }), /版本/);
  assert.equal(calls, 0);
  await assert.rejects(fetchGitHubRelease(system, join(tempDir(t), 'x')), /版本/);
  assert.equal(calls, 1);
});


test('a failed or timed-out asset download never exposes signed URLs or retries an ambiguous response', async (t) => {
  for (const failure of [
    { code: 1, stderr: 'https://asset.invalid?token=PRIVATE_SECRET' },
    { code: 127, stderr: 'spawnSync gh ETIMEDOUT PRIVATE_SECRET' },
  ]) {
    let calls = 0;
    await assert.rejects(fetchGitHubRelease({ env: {}, exec(_file, args) {
      calls++;
      return args[0] === 'api'
        ? { code: 0, stdout: JSON.stringify(metadata()), stderr: '' }
        : { stdout: '', ...failure };
    } }, join(tempDir(t), 'x')), error => {
      assert.match((error as Error).message, /--from/);
      assert.doesNotMatch((error as Error).message, /PRIVATE_SECRET|asset.invalid/);
      return true;
    });
    assert.equal(calls, 2);
  }
});

test('public repository release downloads anonymously over HTTPS with digest verification and never invokes gh', async (t) => {
  const destination = join(tempDir(t), 'public.tar.gz');
  const seen: { url: string; headers: Headers }[] = [];
  const assetUrl = 'https://github.com/XaineChaeson/tycho/releases/download/v1.1.0/tycho.tar.gz';
  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({ url, headers: new Headers(init?.headers) });
    if (url === 'https://api.github.com/repos/XaineChaeson/tycho/releases/latest') {
      return new Response(JSON.stringify({
        tag_name: 'v1.1.0',
        draft: false,
        prerelease: false,
        assets: [{
          id: 12,
          name: 'tycho.tar.gz',
          size: content.length,
          state: 'uploaded',
          digest: `sha256:${sha256}`,
          browser_download_url: assetUrl,
        }],
      }), { status: 200 });
    }
    if (url === assetUrl) {
      return new Response(content, { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  let ghCalled = false;
  const release = await fetchGitHubRelease(
    { env: {}, exec() { ghCalled = true; throw new Error('gh must not be called for public release'); } },
    destination,
    { fetch: mockFetch },
  );
  assert.deepEqual(release, { version: '1.1.0', sha256, bytes: content.length });
  assert.equal(ghCalled, false);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.headers.get('accept'), 'application/vnd.github+json');
  assert.equal(seen[0]!.headers.get('user-agent'), 'tycho-updater');
});

test('public repository release falls back to sibling SHA256SUMS asset when digest field is absent', async (t) => {
  const destination = join(tempDir(t), 'public-sums.tar.gz');
  const assetUrl = 'https://github.com/XaineChaeson/tycho/releases/download/v1.2.0/tycho.tar.gz';
  const sumsUrl = 'https://github.com/XaineChaeson/tycho/releases/download/v1.2.0/SHA256SUMS';
  const sumsText = `${'0'.repeat(64)}  install.sh\n${sha256}  tycho.tar.gz\n`;
  const mockFetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://api.github.com/repos/XaineChaeson/tycho/releases/tags/v1.2.0') {
      return new Response(JSON.stringify({
        tag_name: 'v1.2.0',
        draft: false,
        prerelease: false,
        assets: [
          { id: 1, name: 'tycho.tar.gz', size: content.length, state: 'uploaded', browser_download_url: assetUrl },
          { id: 2, name: 'SHA256SUMS', size: Buffer.byteLength(sumsText), state: 'uploaded', browser_download_url: sumsUrl },
        ],
      }), { status: 200 });
    }
    if (url === sumsUrl) return new Response(sumsText, { status: 200 });
    if (url === assetUrl) return new Response(content, { status: 200 });
    throw new Error(`unexpected URL: ${url}`);
  };

  const release = await fetchGitHubRelease(
    { env: {}, exec() { throw new Error('gh must not be called'); } },
    destination,
    { version: '1.2.0', fetch: mockFetch },
  );
  assert.deepEqual(release, { version: '1.2.0', sha256, bytes: content.length });
});

test('desktop app-v* tags are rejected on both anonymous HTTPS and gh paths', async (t) => {
  const mockFetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({
    tag_name: 'app-v0.1.0',
    draft: false,
    prerelease: false,
    assets: [{
      id: 1,
      name: 'tycho.tar.gz',
      size: content.length,
      state: 'uploaded',
      digest: `sha256:${sha256}`,
      browser_download_url: 'https://github.com/XaineChaeson/tycho/releases/download/app-v0.1.0/tycho.tar.gz',
    }],
  }), { status: 200 });

  let ghCalled = false;
  await assert.rejects(
    fetchGitHubRelease(
      { env: {}, exec() { ghCalled = true; return { code: 0, stdout: JSON.stringify(metadata()), stderr: '' }; } },
      join(tempDir(t), 'app-tag-public.tar.gz'),
      { fetch: mockFetch },
    ),
    /版本/,
  );
  assert.equal(ghCalled, false, 'invalid release tag must fail immediately rather than falling back to gh');

  await assert.rejects(
    fetchGitHubRelease(
      { env: {}, exec() { return { code: 0, stdout: JSON.stringify({ ...metadata(), tag_name: 'app-v0.1.0' }), stderr: '' }; } },
      join(tempDir(t), 'app-tag-gh.tar.gz'),
    ),
    /版本/,
  );
});

test('public HTTPS rejects tampered download bytes without falling back to gh', async (t) => {
  const destination = join(tempDir(t), 'tampered.tar.gz');
  const assetUrl = 'https://github.com/XaineChaeson/tycho/releases/download/v1.1.0/tycho.tar.gz';
  const mockFetch: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/latest')) {
      return new Response(JSON.stringify({
        tag_name: 'v1.1.0',
        draft: false,
        prerelease: false,
        assets: [{
          id: 12,
          name: 'tycho.tar.gz',
          size: content.length,
          state: 'uploaded',
          digest: `sha256:${sha256}`,
          browser_download_url: assetUrl,
        }],
      }), { status: 200 });
    }
    return new Response(Buffer.from('another asset of same length'), { status: 200 });
  };

  let ghCalled = false;
  await assert.rejects(
    fetchGitHubRelease(
      { env: {}, exec() { ghCalled = true; throw new Error('must not fall back'); } },
      destination,
      { fetch: mockFetch },
    ),
    /摘要|校验/,
  );
  assert.equal(ghCalled, false);
});

test('anonymous HTTPS 404/401/403 and TYCHO_USE_GH_CLI=1 gracefully fall back to gh CLI', async (t) => {
  for (const status of [404, 401, 403]) {
    const destination = join(tempDir(t), `fallback-${status}.tar.gz`);
    let fetchCalls = 0;
    let ghCalls = 0;
    const mockFetch: typeof globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('nope', { status });
    };
    const release = await fetchGitHubRelease(
      {
        env: {},
        exec(_file, args) {
          ghCalls += 1;
          if (args[0] === 'api') return { code: 0, stdout: JSON.stringify(metadata()), stderr: '' };
          writeFileSync(destination, content);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
      destination,
      { fetch: mockFetch },
    );
    assert.deepEqual(release, { version: '1.1.0', sha256, bytes: content.length });
    assert.equal(fetchCalls, 1);
    assert.equal(ghCalls, 2);
  }

  const destination = join(tempDir(t), 'force-gh.tar.gz');
  let fetchCalled = false;
  const release = await fetchGitHubRelease(
    {
      env: { TYCHO_USE_GH_CLI: '1' },
      exec(_file, args) {
        if (args[0] === 'api') return { code: 0, stdout: JSON.stringify(metadata()), stderr: '' };
        writeFileSync(destination, content);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
    destination,
    { fetch: async () => { fetchCalled = true; throw new Error('must not call fetch when TYCHO_USE_GH_CLI=1'); } },
  );
  assert.deepEqual(release, { version: '1.1.0', sha256, bytes: content.length });
  assert.equal(fetchCalled, false);
});
