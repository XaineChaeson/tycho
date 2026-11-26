// Prevent online updates from bypassing the established content/version/schema gates,
// silently downgrading, or mixing GitHub selection with explicit offline/URL sources.
import './guard.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { runCli } from '../cli/main.ts';
import { installSelf } from '../cli/install.ts';
import { stage, stubApp } from './cli-helpers.ts';

function scenario(t: TestContext, { version = '1.1.0', env = {} }: { version?: string; env?: Record<string, string> } = {}) {
  const bytes = Buffer.from('synthetic release archive'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const s = stage(t, { env, respond(call) {
    const { args } = call;
    if (call.file === 'gh' && args[0] === 'api') return { stdout: JSON.stringify({ tag_name: 'v' + version, draft: false, prerelease: version === '1.2.0', assets: [{ id: 1, name: 'tycho.tar.gz', state: 'uploaded', size: bytes.length, digest: 'sha256:' + sha256 }] }) };
    if (call.file === 'gh' && args[0] === 'release') { writeFileSync(args[args.indexOf('--output') + 1]!, bytes); return {}; }
    if (args[0] === '-xzf') stubApp(join(call.cwd!, args[3]!), version);
    return undefined;
  } });
  const prefix = join(s.dir, 'prefix');
  s.cli.appRoot = stubApp(join(prefix, 'versions', '1.0.0'), '1.0.0');
  mkdirSync(prefix, { recursive: true }); writeFileSync(join(prefix, 'current'), '1.0.0');
  return { s, prefix };
}

test('online stable and explicit preview bind package version and use the existing automatic install gate', async (t) => {
  for (const requested of [undefined, '1.2.0']) {
    const { s } = scenario(t, { version: requested ?? '1.1.0' });
    assert.equal(await runCli(['update', ...(requested ? ['--to', requested] : [])], s.cli), 0, s.text());
    const installed = s.calls.find(call => call.args[1] === 'install-self')!;
    assert.ok(installed); assert.ok(installed.args.includes('--automatic'));
    assert.equal(installed.args.includes('--only-upgrade'), requested === undefined);
    assert.equal(installed.args[installed.args.indexOf('--expect-version') + 1], requested ?? '1.1.0');
    assert.equal(s.calls.some(call => /curl/.test(call.file)), false);
  }
});

test('only the default GitHub choice requests the locked no-downgrade gate; explicit versions remain an explicit choice', async (t) => {
  const explicit = scenario(t, { version: '0.9.0' });
  assert.equal(await runCli(['update', '--to', '0.9.0'], explicit.s.cli), 0, explicit.s.text());
  const installed = explicit.s.calls.find(call => call.args[1] === 'install-self')!;
  assert.ok(installed.args.includes('--automatic'));
  assert.equal(installed.args.includes('--only-upgrade'), false);
});

test('--to conflicts with an offline path or configured URL before commands or data changes', async (t) => {
  for (const source of ['offline', 'url']) {
    const s = stage(t, { env: source === 'url' ? { TYCHO_RELEASE_URL: 'https://mirror.invalid/tycho.tar.gz' } : {} });
    assert.equal(await runCli(['update', '--to', '1.1.0', ...(source === 'offline' ? ['--from', 'anything'] : [])], s.cli), 2);
    assert.match(s.text(), /--to/); assert.deepEqual(s.calls, []);
  }
});

test('bad --to value is a usage error rather than a failed external command', async (t) => {
  const s = stage(t);
  assert.equal(await runCli(['update', '--to', '../outside'], s.cli), 2);
  assert.deepEqual(s.calls, []);
});


test('online selection does not overwrite an explicitly confirmed version or digest', async (t) => {
  for (const args of [['--expect-version', '9.0.0'], ['--expect-sha256', 'a'.repeat(64)]]) {
    const { s } = scenario(t);
    assert.equal(await runCli(['update', ...args], s.cli), 1);
    assert.equal(s.calls.some(call => call.args[0] === '-xzf' || call.args[1] === 'install-self'), false);
  }
});

test('the reused install-self gate rejects a different package version before switching current', async (t) => {
  const { s, prefix } = scenario(t);
  s.cli.appRoot = stubApp(join(s.dir, 'candidate'), '1.2.0');
  await assert.rejects(installSelf(s.cli, { prefix, node: s.cli.system.execPath, expectVersion: '1.1.0', automatic: true }), /包和确认的不是同一个/);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
  assert.equal(s.calls.length, 0);
});


test('help describes stable selection and --to without changing the version command', async (t) => {
  const s = stage(t);
  assert.equal(await runCli(['help'], s.cli), 0);
  assert.match(s.text(), /--to <版本>/); assert.match(s.text(), /稳定发行版/);
  assert.equal(await runCli(['version'], s.cli), 0);
  assert.equal(s.calls.length, 0);
});


// The transport is a recorder, but the installed candidate's lock and decision below
// are the actual installSelf implementation; no test copies the comparison rule.
for (const [concurrent, expected] of [['1.2.0', 1], ['1.0.5', 0], ['custom-build', 1]] as const) {
  test(`default download followed by current=${concurrent} is decided at installSelf's lock`, async (t) => {
    const { s, prefix } = scenario(t);
    const exec = s.cli.system.exec;
    const candidate = stubApp(join(s.dir, 'candidate-copy'), '1.1.0');
    let handed: string[] = [];
    s.cli.system.exec = (file, args, options) => {
      if (file === 'gh' && args[0] === 'release') {
        const result = exec(file, args, options);
        stubApp(join(prefix, 'versions', concurrent), concurrent);
        writeFileSync(join(prefix, 'current'), concurrent);
        return result;
      }
      if (args[1] === 'install-self') { handed = args; return { code: 2, stdout: '', stderr: 'candidate process is exercised below' }; }
      return exec(file, args, options);
    };
    await runCli(['update'], s.cli);
    const versionsBefore = readdirSync(join(prefix, 'versions')).sort();
    s.calls.length = 0;
    const code = await runCli([
      'install-self', '--prefix', prefix, '--node', s.cli.system.execPath,
      '--expect-version', '1.1.0', '--automatic', '--only-upgrade',
    ], { ...s.cli, appRoot: candidate });
    assert.equal(code, expected, s.text());
    assert.ok(handed.includes('--only-upgrade'));
    assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), expected ? concurrent : '1.1.0');
    if (expected) {
      assert.deepEqual(readdirSync(join(prefix, 'versions')).sort(), versionsBefore);
      assert.equal(s.calls.length, 0, 'the locked refusal precedes service operations');
      assert.match(s.text(), /更旧|无法比较/);
    }
  });
}

test('an old candidate refusing the new internal flag fails once and gives the manual --from route', async (t) => {
  const { s, prefix } = scenario(t);
  const exec = s.cli.system.exec;
  let attempts = 0;
  s.cli.system.exec = (file, args, options) => {
    if (args[1] === 'install-self') { attempts++; return { code: 2, stdout: '', stderr: 'unknown option --only-upgrade' }; }
    return exec(file, args, options);
  };
  assert.equal(await runCli(['update'], s.cli), 1);
  assert.equal(attempts, 1);
  assert.match(s.text(), /--from/);
  assert.equal(readFileSync(join(prefix, 'current'), 'utf8'), '1.0.0');
});
