// Shared isolated installation and immutable release fixtures.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after } from 'node:test';
import type { TestContext } from 'node:test';
import { tool } from '../cli/system.ts';
import { pack, releaseVersionOf } from '../scripts/pack.ts';
import { releaseRoot, REPO, tempDir } from './cli-helpers.ts';

const WINDOWS = process.platform === 'win32';
const SH = join(REPO, 'install', 'install.sh');
const PS1 = join(REPO, 'install', 'install.ps1');
const TAR = tool({ platform: process.platform, env: process.env }, 'tar');
const POWERSHELL = WINDOWS ? tool({ platform: 'win32', env: process.env }, 'powershell') : 'pwsh';
// What the packer would number a release of this tree: the third part is a commit count.
const VERSION = releaseVersionOf(REPO, 7);
// Never reached: a run that forgot --from must not fetch from the internet.
const NOWHERE = 'http://127.0.0.1:9/none';

// Every consumer only reads the same packed release; variants unpack their own copy.
let archive: string | undefined;
let archiveDir: string | undefined;
function sharedArchive(t: TestContext): string {
  if (!archive) {
    archiveDir = mkdtempSync(join(tmpdir(), 'tycho-e2e-release-'));
    archive = pack(releaseRoot(t), archiveDir, VERSION);
  }
  return archive;
}
after(() => { if (archiveDir) rmSync(archiveDir, { recursive: true, force: true }); });

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Not spawnSync: the fake download server lives in this process.
function run(file: string, args: string[], env: NodeJS.ProcessEnv, shell = false): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, shell, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

// Through the launcher, the way a terminal would: on Windows cmd runs the .cmd, and the
// words are quoted as someone typing them would.
function launch(launcher: string, args: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  if (!WINDOWS) return run(launcher, args, env);
  return run([launcher, ...args].map((word) => (/\s/.test(word) ? `"${word}"` : word)).join(' '), [], env, true);
}

interface Sandbox {
  dir: string;
  prefix: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  install(from?: string): Promise<Ran>;
  tycho(...args: string[]): Promise<Ran>;
  versions(): string[];
}

function sandbox(t: TestContext, extra: NodeJS.ProcessEnv = {}): Sandbox {
  // Spaces and characters outside ASCII on every path the launcher handles.
  const dir = tempDir(t, 'tycho e2e 测试 ');
  const home = join(dir, 'home');
  const prefix = join(dir, 'program dir', 'app');
  const dataDir = join(dir, 'data');
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    TYCHO_PREFIX: prefix,
    TYCHO_DATA: dataDir,
    TYCHO_NO_MODIFY_PATH: '1',
    TYCHO_RELEASE_URL: NOWHERE,
    TYCHO_NODE_DIST_URL: NOWHERE,
    TYCHO_NODE_SUMS_URL: NOWHERE,
    ...extra,
  };
  const launcher = join(prefix, 'bin', WINDOWS ? 'tycho.cmd' : 'tycho');
  return {
    dir,
    prefix,
    dataDir,
    env,
    install: (from) =>
      WINDOWS
        ? run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...(from ? ['-From', from] : [])], env)
        : run('bash', [SH, ...(from ? ['--from', from] : [])], env),
    tycho: (...args) => launch(launcher, args, env),
    versions: () => readdirSync(join(prefix, 'versions')).sort(),
  };
}

// The release unpacked, under another version number; `node` replaces the Node it says
// it needs (null: says nothing).
function variant(dir: string, archive: string, version: string, node?: string | null): string {
  const home = join(dir, `release-${version}`);
  mkdirSync(home);
  const unpacked = spawnSync(TAR, ['-xzf', archive], { cwd: home, encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  assert.ok(existsSync(archive));
  const file = join(home, 'package.json');
  const manifest = { ...(JSON.parse(readFileSync(file, 'utf8')) as object), version, ...(node === undefined ? {} : { engines: node === null ? {} : { node } }) };
  // On one line, as a tool that rewrote the file would leave it.
  writeFileSync(file, JSON.stringify(manifest));
  return home;
}

// A PATH with the system's tools and no node on it.
function pathWithoutNode(dir: string): string {
  if (WINDOWS) return [join(process.env.SystemRoot!, 'System32'), process.env.SystemRoot!].join(delimiter);
  const bin = join(dir, 'tools');
  mkdirSync(bin);
  const tools = ['bash', 'sh', 'tar', 'gzip', 'curl', 'sha256sum', 'shasum', 'mktemp', 'uname', 'cp', 'mv', 'rm', 'mkdir', 'chmod', 'grep', 'head', 'cut', 'ls', 'cat', 'sed', 'awk', 'dirname', 'env'];
  for (const name of tools) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    if (found.startsWith('/')) symlinkSync(found, join(bin, name));
  }
  return bin;
}


export { WINDOWS, SH, PS1, TAR, POWERSHELL, VERSION, NOWHERE, run, launch, sandbox, variant, sharedArchive, pathWithoutNode };
export type { Ran, Sandbox };
