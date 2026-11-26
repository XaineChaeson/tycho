// Unknown service state must not become "not installed", block a heartbeat, or
// authorize observing another installation. Only the owning manager chooses names.
import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { autostartFor, ownerId, systemdUnit, TASK_QUERY, windowsTaskXml } from '../cli/autostart.ts';
import { tool } from '../cli/system.ts';
import { installedSpec } from '../cli/install.ts';
import { runCli } from '../cli/main.ts';
import { observeServices } from '../cli/service-observation.ts';
import { createClient } from '../node/client.ts';
import { createServiceObserver } from '../node/service-observation.ts';
import { createNodes } from '../service/nodes.ts';
import { createMachines } from '../service/machines.ts';
import { serviceManagerReport, type ServiceManagerReport } from '../shared/service-manager.ts';
import { NODE_PROTOCOL } from '../shared/node-protocol.ts';
import { stage } from './cli-helpers.ts';
import { fixture, NODES_TUNED, USER } from './helpers.ts';

const FACTS = { node_id: 'a1b2c3d4e5f60718', name: 'observation', platform: 'linux', hostname: 'host' };
const REPORT: ServiceManagerReport = { observed_at: '2026-11-16T00:00:00.000Z', services: [
  { role: 'node', manager: 'systemd', entry: 'tycho-node', installed: true, enabled: true, running: false, main_pid: null },
] };

test('status --json does not initialize identities, ledgers, or credentials', async t => {
  const s = stage(t, { platform: 'linux', env: { HTTPS_PROXY: 'http://unused.invalid:1234' } });
  const before = readdirSync(s.dir, { recursive: true }).sort();
  assert.equal(await runCli(['node', 'service', 'status', '--json'], s.cli), 0);
  assert.deepEqual(readdirSync(s.dir, { recursive: true }).sort(), before);
  assert.equal(existsSync(join(s.dataDir, 'node-id')), false);
  assert.equal(s.out.length, 1);
  const report = JSON.parse(s.out[0]!) as ServiceManagerReport;
  assert.deepEqual(report.services.map(({ role, installed, running }) => [role, installed, running]), [['node', false, null]]);
});

test('one ownership selection supplies exact Linux runtime facts, with bounded read-only queries', t => {
  const s = stage(t, { platform: 'linux', respond: call => {
    if (call.args.includes('show')) return { stdout: 'ActiveState=active\nUnitFileState=enabled\nMainPID=123\n' };
    if (call.args.includes('is-enabled')) return { stdout: 'enabled\n' };
    return { stdout: 'Linger=yes\n' };
  } });
  const spec = installedSpec(s.cli.system, s.cli.appRoot, 'node');
  const name = 'tycho-node-' + ownerId(spec);
  const dir = join(s.home, '.config/systemd/user');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name + '.service'), systemdUnit(spec));
  let bounded = 0;
  const system = { ...s.cli.system, exec: (...args: Parameters<typeof s.cli.system.exec>) => {
    assert.ok((args[2]?.timeoutMs ?? Infinity) <= 1500);
    assert.equal(args[2]?.maxBufferBytes, 32768);
    bounded++;
    return s.cli.system.exec(...args);
  } };
  const report = observeServices(system, s.cli.appRoot, 'node');
  assert.deepEqual(report.services[0], { role: 'node', manager: 'systemd', entry: name, installed: true, enabled: true, running: true, main_pid: 123 });
  assert.ok(bounded > 0);
  const show = s.calls.find(call => call.args.includes('show'))!;
  assert.ok(show.args.includes(name + '.service'));
  assert.ok(s.calls.every(call => !call.args.some(word => ['start', 'stop', 'enable', 'disable', 'daemon-reload'].includes(word))));
});

test('a foreign definition is not queried for runtime, and a denied user bus stays unknown', t => {
  for (const foreign of [true, false]) {
    const s = stage(t, { platform: 'linux', respond: () => ({ code: 1, stderr: 'Failed to connect to user scope bus: Operation not permitted' }) });
    const spec = installedSpec(s.cli.system, s.cli.appRoot, 'node');
    const dir = join(s.home, '.config/systemd/user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tycho-node.service'), systemdUnit(foreign ? { ...spec, program: ['/some/other/program'] } : spec));
    const observed = autostartFor(s.cli.system, 'node').observe(spec);
    assert.equal(observed.running, null);
    if (foreign) {
      assert.equal(observed.installed, false, 'the unowned legacy definition is not this installation');
      assert.equal(s.calls.some(call => call.args.includes('show')), false);
    } else {
      assert.equal(observed.installed, true);
      assert.equal(observed.problem?.kind, 'permission_error');
      assert.equal(observed.enabled, null);
    }
  }
});

test('optional report parsing drops arbitrary fields and cannot expose raw diagnostic secrets', () => {
  const normalized = serviceManagerReport({ ...REPORT, env: { secret: 'PRIVATE-RAW' }, services: [
    { ...REPORT.services[0], argv: ['PRIVATE-RAW'], problem: { kind: 'permission_error', message: 'Bearer PRIVATE-RAW' } },
  ] })!;
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE-RAW|argv|env/);
  assert.equal(normalized.services[0]?.problem?.kind, 'permission_error');
  for (const value of [null, 'broken', { ...REPORT, services: Array(3).fill(REPORT.services[0]) }, { ...REPORT, services: [{ ...REPORT.services[0], main_pid: -1 }] }]) {
    assert.equal(serviceManagerReport(value)?.services[0]?.running, null);
    assert.equal(serviceManagerReport(value)?.services[0]?.problem?.kind, 'unknown');
  }
  assert.equal(serviceManagerReport(undefined), undefined);
});

test('a slow observer is single-flight, cached, and does not delay polls or command acknowledgements', async t => {
  const s = stage(t);
  let finish!: (value: unknown) => void;
  let reads = 0;
  let at = 0;
  const observer = createServiceObserver(s.cli.appRoot, { now: () => at, read: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  t.after(() => observer.close());
  const polls: Record<string, unknown>[] = [];
  let commandReported = false;
  const stop = new AbortController();
  const client = createClient({ dataDir: s.dataDir, origin: 'http://127.0.0.1:1', token: 'f'.repeat(64), facts: FACTS,
    procs: { alive: () => false, startOf: async () => undefined, descendants: async () => [], tagged: async () => [], endTree: async () => {}, endGroup: async () => {} },
    executors: { questions: [] }, serviceManager: () => observer.report(), log: () => {},
    fetch: (async (url, init) => {
      if (String(url).endsWith('/api/node/report')) { commandReported = true; return new Response('{}'); }
      if (!String(url).endsWith('/api/node/poll')) return new Response('{}');
      polls.push(JSON.parse(String(init?.body)));
      if (polls.length === 1) return new Response(JSON.stringify({ protocol: NODE_PROTOCOL, command: { id: 'c1', kind: 'list', alive_only: true } }));
      stop.abort();
      return new Response(JSON.stringify({ protocol: NODE_PROTOCOL, command: null }));
    }) as typeof fetch,
  });
  await client.run(stop.signal);
  assert.equal(commandReported, true);
  assert.equal(polls[1]?.cursor, 'c1');
  assert.equal(reads, 1, 'a pending read never overlaps itself');
  finish(REPORT);
  await turn();
  assert.deepEqual(observer.report(), REPORT);
  at = 59_999;
  observer.report();
  await turn();
  assert.equal(reads, 1);
});

test('malformed service reports do not fail the hub poll or overwrite identity and connection facts', async t => {
  const f = fixture(t, {}, false);
  const hub = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 1, log: () => {} });
  const request = hub.register(FACTS);
  const machine = hub.approve(request.code, USER)!;
  const poll = async (service_manager?: unknown) => {
    const stop = new AbortController();
    const waiting = hub.poll(machine.id, { facts: FACTS, runs: [], ...(service_manager === undefined ? {} : { service_manager }) }, stop.signal);
    stop.abort();
    await waiting;
  };
  assert.equal(hub.reportedServiceManager(machine.id), null, 'old nodes have not reported');
  await poll(REPORT);
  assert.deepEqual(hub.reportedServiceManager(machine.id), REPORT);
  await poll();
  assert.deepEqual(hub.reportedServiceManager(machine.id), REPORT, 'offline/missing optional values preserve the last observation');
  await poll('broken');
  assert.equal(hub.reportedServiceManager(machine.id)?.services[0]?.problem?.kind, 'unknown');
  assert.equal(f.ledger.getMachine(machine.id)?.nodeId, FACTS.node_id);
  hub.leave(machine.id);
  assert.equal(hub.reportedServiceManager(machine.id), null, 'retiring a registration clears its diagnostics');
});


test('an oversized fixed CLI answer becomes a diagnostic failure and its child is closed', async t => {
  const s = stage(t);
  const app = join(s.dir, 'fake-observation-app');
  mkdirSync(join(app, 'cli'), { recursive: true });
  writeFileSync(join(app, 'cli/main.ts'), "process.stdout.write('X'.repeat(100000));\n");
  const observer = createServiceObserver(app);
  t.after(() => observer.close());
  assert.equal(observer.report(), undefined);
  const deadline = Date.now() + 5_000;
  while (observer.report() === undefined) {
    assert.ok(Date.now() < deadline, 'bounded child should return a diagnostic failure');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(observer.report()?.services[0]?.running, null);
  assert.ok(observer.report()?.services[0]?.problem);
  assert.doesNotMatch(JSON.stringify(observer.report()), /XXXXX/);
  observer.close();
});


test('a same friendly name after normal removal cannot inherit another registration service observation', async t => {
  const f = fixture(t, {}, false);
  const hub = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 1, log: () => {} });
  const store = createMachines({ ledger: f.ledger });
  const first = hub.approve(hub.register(FACTS).code, USER)!;
  const poll = async (id: string, facts: typeof FACTS, service_manager?: unknown) => {
    const stop = new AbortController();
    const waiting = hub.poll(id, { facts, runs: [], ...(service_manager === undefined ? {} : { service_manager }) }, stop.signal);
    stop.abort();
    await waiting;
  };
  await poll(first.id, FACTS, REPORT);
  assert.deepEqual(hub.reportedServiceManager(first.id), REPORT);
  // This is the same business path as Owner DELETE: it deliberately does not call hub.leave.
  store.remove(first.id, USER);
  const facts = { ...FACTS, node_id: 'b2c3d4e5f60718a1' };
  const second = hub.approve(hub.register(facts).code, USER)!;
  assert.equal(second.id, first.id, 'friendly name is reusable');
  assert.notEqual(second.uid, first.uid, 'the new registration is a different identity');
  await poll(second.id, facts);
  assert.equal(hub.reportedServiceManager(second.id), null, 'a first poll without its own sample cannot read the prior registration');
  const current = { ...REPORT, observed_at: '2026-11-16T00:01:00.000Z', services: [
    { ...REPORT.services[0]!, running: true, main_pid: 456 },
  ] };
  await poll(second.id, facts, current);
  assert.deepEqual(hub.reportedServiceManager(second.id), current);
  store.remove(second.id, USER);
  assert.equal(hub.reportedServiceManager(second.id), null, 'a deleted registration has no diagnostic owner');
});


// Both values are ordinary legal JSON; no functions, proxies or custom prototypes.
const objectEnums = () => [
  JSON.parse(JSON.stringify({ ...REPORT, services: [{ ...REPORT.services[0], manager: { toString: 'x' } }] })),
  JSON.parse(JSON.stringify({ ...REPORT, services: [{ ...REPORT.services[0], problem: { kind: { toString: 'x' } } }] })),
];

test('legal JSON object enum values cannot throw from optional diagnostic parsing', () => {
  for (const value of objectEnums()) {
    assert.doesNotThrow(() => serviceManagerReport(value));
    assert.equal(serviceManagerReport(value)?.services[0]?.problem?.kind, 'unknown');
  }
});

test('legal JSON object enum values do not break hub polls or registration identity', async t => {
  const f = fixture(t, {}, false);
  const hub = createNodes({ ...NODES_TUNED, ledger: f.ledger, pollHoldMs: () => 1, log: () => {} });
  const machine = hub.approve(hub.register(FACTS).code, USER)!;
  for (const service_manager of objectEnums()) {
    const stop = new AbortController();
    const waiting = hub.poll(machine.id, { facts: FACTS, runs: [], service_manager }, stop.signal);
    stop.abort();
    await waiting;
    assert.equal(hub.reportedServiceManager(machine.id)?.services[0]?.problem?.kind, 'unknown');
    assert.equal(f.ledger.getMachine(machine.id)?.uid, machine.uid);
    assert.equal(f.ledger.getMachine(machine.id)?.nodeId, FACTS.node_id);
  }
});

for (const scene of [
  { name: 'legacy access denial', legacy: 'denied', own: false, installed: null, problem: 'permission_error' },
  { name: 'legacy observation timeout', legacy: 'timeout', own: false, installed: null, problem: 'unavailable' },
  { name: 'a known foreign legacy task', legacy: 'foreign', own: false, installed: false, problem: undefined },
  { name: 'both task names confirmed absent', legacy: 'absent', own: false, installed: false, problem: undefined },
  { name: 'the owned task with unreadable legacy name', legacy: 'denied', own: true, installed: true, problem: undefined },
] as const) {
  test(`service observation preserves uncertainty for ${scene.name}`, t => {
    let ownName: string;
    let ownXml: string;
    let foreignXml: string;
    const s = stage(t, { platform: 'win32', respond: call => {
      if (call.args.includes(TASK_QUERY)) {
        if (call.env.TYCHO_TASK === ownName) return { stdout: scene.own ? `present ${Buffer.from(ownXml).toString('base64')}` : 'absent' };
        if (call.env.TYCHO_TASK === 'tycho-node') {
          if (scene.legacy === 'denied') return { code: 1, stderr: 'Access is denied' };
          if (scene.legacy === 'timeout') return { code: 124, stderr: 'service observation timeout' };
          return { stdout: scene.legacy === 'foreign' ? `present ${Buffer.from(foreignXml).toString('base64')}` : 'absent' };
        }
      }
      if (call.env.TYCHO_TASK === ownName) return { stdout: '{"enabled":true,"running":true}' };
      return undefined;
    } });
    const spec = installedSpec(s.cli.system, s.cli.appRoot, 'node');
    ownName = 'tycho-node-' + ownerId(spec);
    ownXml = windowsTaskXml({ user: 'PC\\owner', powershell: tool(s.cli.system, 'powershell'), conhost: null, spec });
    foreignXml = windowsTaskXml({ user: 'PC\\owner', powershell: tool(s.cli.system, 'powershell'), conhost: null, spec: { ...spec, program: ['/another/installation'] } });
    const auto = autostartFor(s.cli.system, 'node');
    const before = auto.state(spec);
    const result = auto.observe(spec);
    assert.equal(result.installed, scene.installed);
    assert.equal(result.problem?.kind, scene.problem);
    assert.equal(result.running, scene.own ? true : null);
    assert.equal(result.enabled, scene.own ? true : null);
    assert.equal(result.main_pid, null);
    assert.equal(result.entry, scene.own ? ownName : null);
    assert.deepEqual(auto.state(spec), before, 'diagnostic uncertainty does not change the management selection');
    if (scene.own) {
      auto.start(spec);
      assert.ok(s.calls.some(c => c.args[0] === '/Run' && c.args[c.args.indexOf('/TN') + 1] === ownName));
    } else {
      assert.throws(() => auto.start(spec), /还没有安装/);
      assert.ok(s.calls.every(c => !['/Create', '/Run', '/Delete', '/End'].includes(c.args[0] ?? '')));
    }
    assert.equal(s.calls.filter(c => c.env.TYCHO_TASK === 'tycho-node' && !c.args.includes(TASK_QUERY)).length, 0,
      'an unowned or unreadable legacy task is never queried for runtime');
  });
}
