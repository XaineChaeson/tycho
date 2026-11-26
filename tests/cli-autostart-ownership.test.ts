// Preserve partial ownership without telling installer consumers that a conflicted
// definition is managed: an upgrade must keep the live old host, and an uninstall
// must not remove a program still referenced by an owned entry it could not remove.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { autostartFor, nameOf, ownerId, startupCmd, windowsTaskXml } from '../cli/autostart.ts';
import type { Role, ServiceSpec } from '../cli/autostart.ts';
import { checkAutostart } from '../cli/doctor.ts';
import { serviceSpec } from '../cli/install.ts';
import { runCli } from '../cli/main.ts';
import { readRecord } from '../cli/record.ts';
import { identityOf, writeToken } from '../node/client.ts';
import type { Call, Stage } from './cli-helpers.ts';
import { alive, installedStub, stage, startStub, stubApp } from './cli-helpers.ts';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
type Scene = 'task-owned' | 'startup-owned' | 'task-unknown' | 'startup-unreadable';
function scheduler() {
  const tasks = new Map<string, string>();
  const unknown = new Set<string>();
  const respond = (c: Call) => {
    if (c.env.TYCHO_TASK !== undefined) {
      if (unknown.has(c.env.TYCHO_TASK)) return { code: 1, stderr: 'Task query denied' };
      const xml = tasks.get(c.env.TYCHO_TASK);
      return { stdout: xml ? `present ${Buffer.from(xml).toString('base64')}` : 'absent' };
    }
    if (c.args[0] === '/Create') tasks.set(c.args[c.args.indexOf('/TN') + 1]!, readFileSync(c.args[c.args.indexOf('/XML') + 1]!, 'utf16le').replace(/^\ufeff/, ''));
    if (c.args[0] === '/Delete') tasks.delete(c.args[c.args.indexOf('/TN') + 1]!);
    return undefined;
  };
  return { tasks, unknown, respond };
}
function partial(s: Stage, manager: ReturnType<typeof scheduler>, spec: ServiceSpec, scene: Scene) {
  const name = nameOf(spec.role ?? 'host');
  const foreign = { ...spec, program: ['/another/tycho'] };
  const taskSpec = scene === 'task-owned' || scene === 'startup-unreadable' ? spec : foreign;
  const task = windowsTaskXml({ user: 'PC\\owner', powershell: POWERSHELL, spec: taskSpec, conhost: null });
  manager.tasks.set(name, task);
  if (scene === 'task-unknown') manager.unknown.add(name);
  const startup = join(s.cli.system.env.APPDATA!, 'Microsoft/Windows/Start Menu/Programs/Startup', `${name}.cmd`);
  mkdirSync(dirname(startup), { recursive: true });
  if (scene === 'startup-unreadable') mkdirSync(startup);
  else writeFileSync(startup, startupCmd({ powershell: POWERSHELL, spec: scene === 'task-owned' ? foreign : spec, home: s.home }));
  return { name, task, startup };
}
const words = (role: Role, action: string): string[] => role === 'node' ? ['node', 'service', action] : ['service', action];
const mutations = (s: Stage) => s.calls.filter(c => ['/Create', '/Delete', '/Run', '/End'].includes(c.args[0] ?? ''));

for (const scene of ['task-owned', 'startup-owned', 'task-unknown', 'startup-unreadable'] as const) {
  for (const role of ['host', 'node'] as const) {
    test(`normal ownership: ${role} ${scene} remains partial, never a managed definition`, async t => {
      const manager = scheduler();
      const s = stage(t, { platform: 'win32', respond: manager.respond });
      const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir, undefined, role);
      const entry = partial(s, manager, spec, scene);
      writeToken(identityOf(s.dataDir), 'f'.repeat(64));
      const beforeStartup = scene === 'startup-unreadable' ? null : readFileSync(entry.startup, 'utf8');
      const auto = autostartFor(s.cli.system, role);
      // A normal CLI install must not create a suffix, even when only the Startup
      // owner can be read and the task query itself is unavailable.
      await runCli(words(role, 'install'), s.cli);
      assert.deepEqual(mutations(s), [], s.text());
      const state = auto.state(spec);
      assert.notEqual(state.mine, true, 'partial ownership is not a managed definition');
      assert.ok((state as { ownedEntry?: string }).ownedEntry, 'retain the known owned entry');
      assert.equal(state.installed, true);
      assert.equal(state.unknown, true);
      const check = checkAutostart(s.cli.system, spec, role);
      assert.equal(check.level, 'warn');
      assert.equal(check.repair, undefined);
      for (const action of ['install', 'start', 'uninstall']) {
        s.out.length = 0;
        s.err.length = 0;
        assert.equal(await runCli(words(role, action), s.cli), 1, s.text());
        assert.ok(s.text().includes(entry.startup), s.text());
        assert.doesNotMatch(s.text(), /本来就没有安装|格式过期/);
      }
      s.out.length = 0;
      assert.equal(await runCli(words(role, 'status'), s.cli), 0, s.text());
      assert.ok(s.text().includes(entry.startup), s.text());
      for (const action of [() => auto.install(spec, { start: false }), () => auto.start(spec), () => auto.stop(spec), () => auto.uninstall(spec)]) assert.throws(action);
      assert.equal(manager.tasks.get(entry.name), entry.task);
      if (beforeStartup !== null) assert.equal(readFileSync(entry.startup, 'utf8'), beforeStartup);
      assert.equal(manager.tasks.has(`${entry.name}-${ownerId(spec)}`), false);
      assert.deepEqual(mutations(s), []);
      // Stopping a confirmed process is not management of these definitions.
      assert.equal(await runCli(words(role, 'stop'), s.cli), 0, s.text());
    });
  }
}

async function installed(t: TestContext, manager: ReturnType<typeof scheduler>) {
  const s = stage(t, { platform: 'win32', respond: manager.respond, env: { TYCHO_NO_MODIFY_PATH: '1' } });
  s.cli.timing.startWaitMs = 10;
  const prefix = join(s.dir, 'prefix');
  s.cli.appRoot = stubApp(join(prefix, 'versions', '.staging-1.0.0'), '1.0.0');
  assert.equal(await runCli(['install-self', '--prefix', prefix, '--node', process.execPath], s.cli), 0, s.text());
  s.cli.appRoot = join(prefix, 'versions', '1.0.0');
  return { s, prefix };
}

for (const scene of ['task-owned', 'startup-owned', 'task-unknown'] as const) {
  test(`normal ownership: ordinary installer upgrade keeps the running old host with ${scene}`, async t => {
    const manager = scheduler();
    const { s, prefix } = await installed(t, manager);
    const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir);
    const entry = partial(s, manager, spec, scene);
    const startup = readFileSync(entry.startup, 'utf8');
    const old = await startStub(t, s.dataDir, {}, installedStub(prefix, '1.0.0'));
    assert.equal(await runCli(['service', 'start'], s.cli), 0, 'an already-running start is a no-op');
    s.cli.appRoot = stubApp(join(prefix, 'versions', '.staging-1.1.0'), '1.1.0');
    const code = await runCli(['install-self', '--prefix', prefix, '--node', process.execPath], s.cli);
    assert.equal(alive(old), true, 'an unmanageable autostart must not authorize stopping the old host');
    assert.equal(code, 0, s.text());
    assert.match(s.text(), /正在运行的服务.*还是原来那个版本/);
    assert.doesNotMatch(s.text(), /已停止原来的服务/);
    assert.equal(manager.tasks.get(entry.name), entry.task);
    assert.equal(readFileSync(entry.startup, 'utf8'), startup);
    assert.equal(existsSync(installedStub(prefix, '1.0.0')), true, 'the live version remains in use');
    assert.deepEqual(mutations(s), []);
    s.cli.appRoot = join(prefix, 'versions', '1.1.0');
    assert.equal(await runCli(['service', 'stop'], s.cli), 0, 'the confirmed host still accepts a direct HTTP stop');
    assert.equal(alive(old), false);
    assert.deepEqual(mutations(s), []);
  });
}

test('normal ownership: whole uninstall refuses partial ownership before deleting its installed program', async t => {
  const manager = scheduler();
  const { s, prefix } = await installed(t, manager);
  const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir);
  const entry = partial(s, manager, spec, 'task-unknown');
  const before = readFileSync(entry.startup, 'utf8');
  assert.equal(await runCli(['uninstall'], s.cli), 1, s.text());
  assert.ok(s.text().includes(entry.startup), s.text());
  assert.equal(existsSync(installedStub(prefix, '1.0.0')), true);
  assert.ok(readRecord(prefix));
  assert.equal(readFileSync(entry.startup, 'utf8'), before);
  assert.equal(manager.tasks.get(entry.name), entry.task);
  assert.deepEqual(mutations(s), []);
});

test('normal ownership: unknown legacy without any known owned entry still permits a fresh suffix', t => {
  const manager = scheduler();
  manager.unknown.add('tycho');
  const s = stage(t, { platform: 'win32', respond: manager.respond });
  const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir);
  const auto = autostartFor(s.cli.system);
  auto.install(spec, { start: false });
  assert.equal(auto.state(spec).mine, true);
  assert.ok(auto.state(spec).where!.includes(ownerId(spec)));
});
