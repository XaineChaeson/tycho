// Guards the package a host hands its machines (docs/design/nodes.md §1.4): it is packed from
// the version directory this host runs, once per version, and the digest and size it answers
// with are the bytes of the file the client downloads. The archive has to be one `tycho update
// --from` accepts and installs — a package root with package.json and cli/main.ts, not a tree
// nested under a version directory.
//
// What this file is here to catch:
//   - a host that packs a source checkout, or packs over a partition on every request,
//   - an answer whose sha256 or size is not the bytes that are served,
//   - a package whose layout only the test's own unpacker understands, not the installer's,
//   - old version packages left beside the current one.
import './guard.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appVersion } from '../cli/paths.ts';
import { runCli } from '../cli/main.ts';
import type { Exec, System } from '../cli/system.ts';
import { realSystem } from '../cli/system.ts';
import { createNodeReleases } from '../service/node-release.ts';
import { realApp, releaseRoot, tempDir } from './cli-helpers.ts';

const A = '0.1.100';
const B = '0.1.200';

function environment(dir: string, prefix: string, dataDir: string): NodeJS.ProcessEnv {
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ...(process.platform === 'win32' ? { APPDATA: join(home, 'AppData', 'Roaming') } : {}),
    TYCHO_PREFIX: prefix,
    TYCHO_DATA: dataDir,
    TYCHO_NO_MODIFY_PATH: '1',
  };
}

// The real commands, with their output in files instead of pipes: this machine refuses a pipe
// between a test process and its child, and the point here is the real tar and the real
// installer, not the way their output travels.
function shellExec(scratch: string, base: NodeJS.ProcessEnv): Exec {
  let count = 0;
  const quote = (word: string): string => process.platform === 'win32' ? `"${word.replace(/"/g, '""')}"` : `'${word.replace(/'/g, `'\\''`)}'`;
  return (file, args, options = {}) => {
    count += 1;
    const out = join(scratch, `exec-${count}.out`);
    const err = join(scratch, `exec-${count}.err`);
    const env = { ...base, ...options.env };
    const line = [file, ...args].map(quote).join(' ');
    let ran;
    if (process.platform === 'win32') {
      const script = join(scratch, `exec-${count}.cmd`);
      writeFileSync(script, `@echo off\r\n${line} > ${quote(out)} 2> ${quote(err)}\r\n`);
      ran = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', script], {
        env, cwd: options.cwd, stdio: 'ignore', windowsHide: true,
      });
    } else {
      ran = spawnSync('/bin/sh', ['-c', `${line} > ${quote(out)} 2> ${quote(err)}`], { env, cwd: options.cwd, stdio: 'ignore' });
    }
    const read = (path: string): string => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
    return { code: ran.status ?? 127, stdout: read(out), stderr: ran.error?.message ?? read(err) };
  };
}

test('源码目录的主机：没有包，why 说清原因', async (t) => {
  const dir = tempDir(t, 'tycho-release-');
  const appRoot = join(dir, 'checkout');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'tycho', version: A }));
  const releases = createNodeReleases({ appRoot, dataDir: dir, system: realSystem(), checkEveryMs: () => 1234 });
  const answer = await releases.answer();
  assert.equal(answer.version, A);
  assert.equal(answer.package, null);
  assert.match(answer.why ?? '', /源码目录/);
  assert.equal(answer.check_every_ms, 1234);
  const pkg = await releases.package();
  assert.ok('why' in pkg);
});

test('安装版的主机：按版本只打一次包，答案的 sha256 和字节就是下载到的字节', async (t) => {
  const dir = tempDir(t, 'tycho-release-');
  const builder = join(dir, 'builder');
  const appRoot = join(builder, 'versions', B);
  realApp(appRoot, B, { source: releaseRoot(t) });
  const dataDir = join(dir, 'data');
  const real = realSystem();
  let packed = 0;
  const system: System = {
    ...real,
    exec(file, args, options) {
      if (file === 'tar' || file.endsWith('tar.exe')) packed += 1;
      return real.exec(file, args, options);
    },
  };
  const releases = createNodeReleases({ appRoot, dataDir, system, checkEveryMs: () => 600_000 });
  const first = await releases.answer();
  assert.equal(first.version, B);
  assert.ok(first.package, first.why ?? '安装版应当有包');
  const again = await releases.answer();
  assert.deepEqual(again.package, first.package);
  assert.equal(packed, 1, '同一个版本只打一次');

  const pkg = await releases.package();
  assert.ok('file' in pkg);
  const bytes = readFileSync(pkg.file);
  assert.equal(bytes.length, first.package!.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), first.package!.sha256);
  assert.equal(pkg.sha256, first.package!.sha256);
  assert.equal(pkg.version, B);
  // Beside the package nothing of another version is kept.
  assert.deepEqual(readdirSync(join(dataDir, 'node-release')), [`${B}.tar.gz`]);
});

test('打出来的包能被 tycho update --from 装进临时 prefix（真 tar、真解包）', async (t) => {
  const dir = tempDir(t, 'tycho-release-');
  // The host's version directory: the package is packed from it, as from versions/<version>.
  const builder = join(dir, 'builder');
  const released = join(builder, 'versions', B);
  realApp(released, B, { source: releaseRoot(t) });
  const dataDir = join(dir, 'data');
  const releases = createNodeReleases({ appRoot: released, dataDir, system: realSystem(), checkEveryMs: () => 600_000 });
  const answer = await releases.answer();
  assert.ok(answer.package);
  const pkg = await releases.package();
  assert.ok('file' in pkg);

  // A different installation with A in place: a real release, so `update` can run from it.
  const prefix = join(dir, 'prefix');
  const stagedA = realApp(join(prefix, 'versions', `.staging-${process.pid}-${A}`), A, { source: releaseRoot(t) });
  const env = environment(dir, prefix, dataDir);
  const scratch = join(dir, 'scratch');
  mkdirSync(scratch, { recursive: true });
  const real = realSystem();
  const system: System = { ...real, env, home: join(dir, 'home'), exec: shellExec(scratch, env) };
  const out: string[] = [];
  const err: string[] = [];
  const cli = (appRoot: string) => ({ system, appRoot, out: (line: string) => out.push(line), err: (line: string) => err.push(line), timing: { pollMs: 20, stopWaitMs: 5000, startWaitMs: 1000 } });

  assert.equal(await runCli(['install-self', '--prefix', prefix, '--node', process.execPath], cli(stagedA)), 0, err.join('\n'));
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), A);

  const installed = await runCli(
    ['update', '--from', pkg.file, '--expect-version', B, '--expect-sha256', pkg.sha256],
    cli(join(prefix, 'versions', A)),
  );
  assert.equal(installed, 0, `包里的布局要能被 tycho update --from 认出并装上：${[...out, ...err].join('\n')}`);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), B);
  assert.equal(existsSync(join(prefix, 'versions', B, 'cli', 'main.ts')), true);
  assert.equal(JSON.parse(readFileSync(join(prefix, 'versions', B, 'package.json'), 'utf8')).version, B);
  assert.equal(appVersion(released), B);
});
