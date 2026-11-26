import {capturedHost} from './capture-host.ts';
// Prevent fixed-size history from ignoring changed retention budgets after restart,
// and keep user retention settings from widening the parser's safety envelopes.
import './guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RemoteHost } from '../runner/host.ts';
import { Unreachable } from '../runner/host.ts';
import { createRunner } from '../runner/runner.ts';
import type { RunnerOptions } from '../runner/runner.ts';
import { diagnosticSource, readCheckpoint } from '../runner/diagnostic-history.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { createSettings, settingKey } from '../service/settings.ts';
import { DONE, fixture, memoryLogins, RUNNER_TUNED, USER } from './helpers.ts';
import type { Fixture } from './helpers.ts';

function setup(f: Fixture, text: string) {
  const run = f.runningRun().run, dir = join(f.dir, 'diagnostics'), file = Buffer.from(text);
  let until = 0, offline = false;
  const host: RemoteHost = {
    place: async () => [], start: async () => ({ code: 0, stdout: '', stderr: '' }), stop: async () => {},
    state: async () => ({ started: false, launcher_alive: false, pid_alive: false, marked: false, exit: null }),
    list: async () => [], artifacts: async () => [], dropRun: async () => {}, connected: () => !offline,
    async readRange(_path, offset) {
      if (offline) throw new Unreachable('synthetic offline');
      const bytes = file.subarray(offset, offset + 256 * 1024);
      until = offset + bytes.length;
      return { bytes, size: file.length, mtime: 1700000000 };
    },
  };
  const make = (policy: () => { maxEvents: number; maxBytes: number }) => createRunner({
    ...RUNNER_TUNED, ledger: f.ledger, adapters: { claude: { ...claudeAdapter, parse: line => [{ kind: 'text', text: line }] } },
    logins: memoryLogins({ own: f.login.login }), machines: { get: f.ledger.getMachine, list: f.ledger.listMachines }, connect: () => capturedHost(host,f.ledger),
    diagnosticsDir: dir, diagnosticsPolicy: policy,
  } as RunnerOptions);
  const drain = async (runner: ReturnType<typeof make>) => { do { await runner.tail(run); } while (until < file.length); };
  return { run, dir, checkpoint: join(dir, run.id + '.json'), make, drain, offline: () => { offline = true; } };
}

test('a smaller policy trims a real checkpoint after restart, persists the gap and leaves business settlement unchanged', async (t) => {
  const f = fixture(t), env = setup(f, Array.from({ length: 30 }, (_, i) => 'event-' + i + '\n').join(''));
  await env.drain(env.make(() => ({ maxEvents: 5000, maxBytes: 1024 * 1024 })));
  const cursor = JSON.parse(readFileSync(env.checkpoint, 'utf8')).cursor;
  f.ledger.settleRun(env.run.id, 0, DONE);
  const receipt = f.ledger.getRun(env.run.id).receipt_json;
  env.offline();
  const runner = env.make(() => ({ maxEvents: 10, maxBytes: 4096 }));
  const history = await runner.eventSnapshot(f.run(env.run.id));
  assert.equal(history.events[0]?.kind, 'truncated');
  assert.deepEqual(history.events.filter(event => event.kind === 'text').map(event => event.text), Array.from({ length: 10 }, (_, i) => 'event-' + (20 + i)));
  assert.equal(history.firstIndex, 19);
  const stored = JSON.parse(readFileSync(env.checkpoint, 'utf8'));
  assert.equal(stored.cursor, cursor);
  assert.equal(stored.dropped, 20);
  assert.equal(stored.events.length, 11);
  assert.equal(f.ledger.getRun(env.run.id).receipt_json, receipt);
});

test('shrinking the byte budget limits both current display and disk without waiting for another raw line', async (t) => {
  const f = fixture(t), env = setup(f, Array.from({ length: 12 }, (_, i) => i + ':' + 'x'.repeat(1000) + '\n').join(''));
  let policy = { maxEvents: 100, maxBytes: 16 * 1024 };
  const runner = env.make(() => policy);
  await env.drain(runner);
  policy = { maxEvents: 100, maxBytes: 4096 };
  const history = await runner.eventSnapshot(env.run);
  assert.equal(history.events[0]?.kind, 'truncated');
  assert.ok(history.events.filter(event => event.kind === 'text').length < 12);
  const stored = JSON.parse(readFileSync(env.checkpoint, 'utf8'));
  assert.ok(stored.events.reduce((sum: number, event: unknown) => sum + Buffer.byteLength(JSON.stringify(event)) + 1, 0) <= 4096);
  assert.ok(stored.dropped > 0);
  assert.deepEqual((await env.make(() => policy).eventSnapshot(env.run)).events, history.events);
});

test('raising the byte budget stores and reloads more than the old fixed one MiB suffix', async (t) => {
  const f = fixture(t), env = setup(f, Array.from({ length: 14 }, (_, i) => i + ':' + 'x'.repeat(96 * 1024) + '\n').join(''));
  const policy = () => ({ maxEvents: 100, maxBytes: 2 * 1024 * 1024 });
  await env.drain(env.make(policy));
  assert.ok(statSync(env.checkpoint).size > 1024 * 1024);
  const history = await env.make(policy).eventSnapshot(env.run);
  assert.equal(history.events.length, 14);
  assert.equal(history.events.some(event => event.kind === 'truncated'), false);
});

test('retention overrides reject invalid values, unknown keys survive and invalid stored budgets use current defaults', (t) => {
  const f = fixture(t);
  f.force("INSERT INTO setting (id, created_at, key, value_json) VALUES ('history-policy', 'now', 'tunables', ?)",
    JSON.stringify({ 'future.history': 3, 'site.diagnosticEvents': -1, 'site.diagnosticLimitKb': 'huge' }));
  const settings = createSettings({ ledger: f.ledger, log() {} });
  assert.equal(settings.get('site.diagnosticEvents'), 5000);
  assert.equal(settings.get('site.diagnosticLimitKb'), 1024);
  for (const value of [0, 9, 25001, 10.5]) assert.throws(() => settings.set('site.diagnosticEvents', value, USER));
  for (const value of [0, 3, 8193, Infinity]) assert.throws(() => settings.set('site.diagnosticLimitKb', value, USER));
  assert.throws(() => settingKey('site.diagnosticsUnknown'));
  settings.set('site.diagnosticEvents', 10, USER);
  assert.equal(f.ledger.getTunables()['future.history'], 3);
});

test('a persisted checkpoint above the fixed parser envelope is refused before parsing regardless of retention policy', (t) => {
  const f = fixture(t), env = setup(f, 'small\n');
  mkdirSync(env.dir, { recursive: true });
  writeFileSync(env.checkpoint, '{');
  truncateSync(env.checkpoint, 9 * 1024 * 1024);
  assert.throws(() => readCheckpoint(env.dir, env.run.id, diagnosticSource(env.run)!), /大小上限/);
});

test('a larger retained suffix never raises the fixed single-event or raw-line parser limits', async (t) => {
  const f = fixture(t), env = setup(f, 'x'.repeat(1024 * 1024 + 1) + '\n' + 'y'.repeat(5 * 1024 * 1024) + '\nsmall\n');
  const runner = env.make(() => ({ maxEvents: 25_000, maxBytes: 8 * 1024 * 1024 }));
  await env.drain(runner);
  const history = await runner.eventSnapshot(env.run);
  assert.ok(history.events.some(event => event.kind === 'diagnostic' && /单事件解析安全/.test(event.message)));
  assert.ok(history.events.some(event => event.kind === 'diagnostic' && /单行上限/.test(event.message)));
  assert.deepEqual(history.events.filter(event => event.kind === 'text').map(event => event.text), ['small']);
});
