// Ordinary CLI diagnostics must identify the selected definition, and preserve a known
// mixed Windows scene instead of creating a second entry for this installation.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { autostartFor, nameOf, ownerId, startupCmd, systemdUnit, windowsTaskXml } from '../cli/autostart.ts';
import type { Role } from '../cli/autostart.ts';
import { serviceSpec } from '../cli/install.ts';
import { runCli } from '../cli/main.ts';
import { checkAutostart } from '../cli/doctor.ts';
import { identityOf, writeToken } from '../node/client.ts';
import type { Call } from './cli-helpers.ts';
import { stage } from './cli-helpers.ts';

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function scheduler() {
  const tasks = new Map<string, string>();
  const respond = (c: Call) => {
    if (c.env.TYCHO_TASK !== undefined) {
      const xml = tasks.get(c.env.TYCHO_TASK);
      return { stdout: xml ? `present ${Buffer.from(xml).toString('base64')}` : 'absent' };
    }
    if (c.args[0] === '/Create') tasks.set(c.args[c.args.indexOf('/TN') + 1]!, readFileSync(c.args[c.args.indexOf('/XML') + 1]!, 'utf16le').replace(/^\ufeff/, ''));
    if (c.args[0] === '/Delete') tasks.delete(c.args[c.args.indexOf('/TN') + 1]!);
    return undefined;
  };
  return { tasks, respond };
}
const words = (role: Role, action: string): string[] => role === 'node' ? ['node', 'service', action] : ['service', action];

for (const platform of ['linux', 'darwin', 'win32'] as const) {
  for (const role of ['host', 'node'] as const) {
    test(`diagnostics: ${platform} ${role} status shows the actual definition`, async t => {
      const manager = scheduler();
      const s = stage(t, { platform, respond: manager.respond });
      const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir, undefined, role);
      autostartFor(s.cli.system, role).install(spec, { start: false });
      const where = autostartFor(s.cli.system, role).state(spec).where!;
      s.out.length = 0;
      assert.equal(await runCli(words(role, 'status'), s.cli), 0, s.text());
      assert.ok(s.out.join('\n').includes(where), s.text());
      if (platform === 'linux') assert.ok(s.out.join('\n').includes(`journalctl --user -u ${nameOf(role)}-${ownerId(spec)}`), s.text());
    });
  }
}

for (const legacy of [false, true]) {
  for (const role of ['host', 'node'] as const) {
    test(`diagnostics: Linux ${role} ${legacy ? 'owned legacy' : 'fresh suffix'} failed start gives its actual journal`, async t => {
      const s = stage(t, { platform: 'linux' });
      s.cli.timing.startWaitMs = 5;
      const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir, undefined, role);
      const name = legacy ? nameOf(role) : `${nameOf(role)}-${ownerId(spec)}`;
      const file = join(s.home, '.config/systemd/user', `${name}.service`);
      if (legacy) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, systemdUnit(spec));
      } else autostartFor(s.cli.system, role).install(spec, { start: false });
      assert.equal(await runCli(words(role, 'start'), s.cli), 1, s.text());
      assert.ok(s.err.join('\n').includes(`journalctl --user -u ${name}`), s.text());
    });
  }
}

for (const changed of ['absent', 'unknown'] as const) {
  test(`diagnostics: a ${changed} definition after start never invents a journal name`, async t => {
    let file = '';
    const s = stage(t, { platform: 'linux', respond: c => {
      if (file && c.file === 'systemctl' && c.args.includes('start')) {
        rmSync(file);
        if (changed === 'unknown') mkdirSync(file);
      }
      return undefined;
    } });
    s.cli.timing.startWaitMs = 5;
    const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir);
    autostartFor(s.cli.system).install(spec, { start: false });
    file = autostartFor(s.cli.system).state(spec).where!;
    assert.equal(await runCli(['service', 'start'], s.cli), 1, s.text());
    assert.doesNotMatch(s.err.join('\n'), /journalctl/);
    assert.ok(s.err.join('\n').includes(spec.logFile), s.text());
    assert.match(s.err.join('\n'), /service status|doctor/);
  });
}

for (const role of ['host', 'node'] as const) {
  for (const taskMine of [true, false]) {
    test(`diagnostics: Windows ${role} mixed legacy ownership (task mine=${taskMine}) is explained and never changed`, async t => {
      const manager = scheduler();
      const s = stage(t, { platform: 'win32', respond: manager.respond });
      s.cli.timing.startWaitMs = 5;
      const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir, undefined, role);
      const foreign = { ...spec, program: ['/another/tycho'] };
      const name = nameOf(role);
      const task = windowsTaskXml({ user: 'PC\\owner', powershell: POWERSHELL, spec: taskMine ? spec : foreign, conhost: null });
      manager.tasks.set(name, task);
      const startup = join(s.cli.system.env.APPDATA!, 'Microsoft/Windows/Start Menu/Programs/Startup', `${name}.cmd`);
      mkdirSync(dirname(startup), { recursive: true });
      const cmd = startupCmd({ powershell: POWERSHELL, spec: taskMine ? foreign : spec, home: s.home });
      writeFileSync(startup, cmd);
      writeToken(identityOf(s.dataDir), 'f'.repeat(64));
      const suffix = `${name}-${ownerId(spec)}`;
      const mutations = () => s.calls.filter(c => ['/Create', '/Delete', '/Run', '/End'].includes(c.args[0] ?? ''));
      // Exercise install before inspecting state: the regression created a new task.
      assert.equal(await runCli(words(role, 'install'), s.cli), 1, s.text());
      assert.deepEqual(mutations(), [], 'known mixed ownership must not create another task');
      const auto = autostartFor(s.cli.system, role);
      const state = auto.state(spec);
      assert.equal(state.installed, true);
      assert.equal(state.mine, false);
      assert.ok(state.ownedEntry);
      assert.equal(state.unknown, true);
      assert.ok(state.where?.includes(startup));
      const check = checkAutostart(s.cli.system, spec, role);
      assert.equal(check.level, 'warn');
      assert.equal(check.repair, undefined);
      for (const action of ['status', 'install', 'start', 'uninstall']) {
        s.out.length = 0;
        s.err.length = 0;
        const code = await runCli(words(role, action), s.cli);
        assert.equal(code, action === 'status' ? 0 : 1, `${action}: ${s.text()}`);
        assert.match(s.text(), /归属不一致|归属冲突/);
        assert.doesNotMatch(s.text(), /本来就没有安装|格式过期/);
        assert.ok(s.text().includes(startup), s.text());
      }
      // Direct process stops do not manage these definitions and remain available.
      assert.equal(await runCli(words(role, 'stop'), s.cli), 0, s.text());
      for (const action of [() => auto.install(spec, { start: false }), () => auto.start(spec), () => auto.stop(spec), () => auto.uninstall(spec)]) assert.throws(action, /归属不一致|归属冲突/);
      assert.equal(manager.tasks.get(name), task);
      assert.equal(readFileSync(startup, 'utf8'), cmd);
      assert.equal(manager.tasks.has(suffix), false);
      assert.equal(existsSync(join(dirname(startup), `${suffix}.cmd`)), false);
      assert.deepEqual(mutations(), []);
    });
  }
}

test('diagnostics: Windows wholly foreign legacy entries still allow a fresh suffix', async t => {
  const manager = scheduler();
  const s = stage(t, { platform: 'win32', respond: manager.respond });
  const spec = serviceSpec(s.cli.system, s.cli.appRoot, s.dataDir);
  const foreign = { ...spec, program: ['/another/tycho'] };
  const task = windowsTaskXml({ user: 'PC\\owner', powershell: POWERSHELL, spec: foreign, conhost: null });
  manager.tasks.set('tycho', task);
  const startup = join(s.cli.system.env.APPDATA!, 'Microsoft/Windows/Start Menu/Programs/Startup/tycho.cmd');
  mkdirSync(dirname(startup), { recursive: true });
  const cmd = startupCmd({ powershell: POWERSHELL, spec: foreign, home: s.home });
  writeFileSync(startup, cmd);
  const auto = autostartFor(s.cli.system);
  auto.install(spec, { start: false });
  assert.equal(auto.state(spec).mine, true);
  assert.ok(auto.state(spec).where!.includes(ownerId(spec)));
  assert.equal(manager.tasks.get('tycho'), task);
  assert.equal(readFileSync(startup, 'utf8'), cmd);
});
