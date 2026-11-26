import {capturedHost} from './capture-host.ts';
// Guards against: a chunk ending inside a line or a multi-byte character, a line
// shown twice or skipped across polls, a line larger than one read, a parser
// failure reaching the Run, progress not advancing (or advancing with nothing
// new), an unreachable host failing what is only a display path, and a fast writer
// holding the queue a stop is waiting in, and the event log growing without end or
// dropping events without saying so.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Adapter } from '../adapters/types.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { createRunner, type RunnerOptions } from '../runner/runner.ts';
import type { Account } from '../runner/snapshot.ts';
import { Unreachable } from '../runner/host.ts';
import type { RemoteHost } from '../runner/host.ts';
import type { Fixture } from './helpers.ts';
import { fixture, LOGIN, RUNNER_TUNED } from './helpers.ts';
import { memoryLogins } from './helpers.ts';

const ACCOUNTS: Record<string, Account> = {
  // The fixture's own login, run here by the stub executor.
  [LOGIN.login.id]: { id: LOGIN.login.id, name: LOGIN.login.name, executor: 'stub', machine: 'h1', tiers: {} },
};

// Every line becomes one text event, so these tests see exactly what tail cut.
const ECHO: Adapter = {
  ...claudeAdapter,
  parse: (line) => [{ kind: 'text', text: line }],
};

interface Remote {
  host: RemoteHost;
  file: Buffer;
  mtime: number;
  chunk: number;
  reads: number[];
}

function remote(content: string | Buffer, chunk = 1 << 20): Remote {
  const fake: Remote = {
    file: Buffer.from(content),
    mtime: 1_700_000_000,
    chunk,
    reads: [],
    host: {
      // Only the read channel is asked here; the rest of §4.1's set answers as a
      // machine with nothing on it.
      place: async () => [],
      start: async () => ({ code: 0, stdout: '', stderr: '' }),
      stop: async () => {},
      state: async () => ({ started: false, launcher_alive: false, pid_alive: false, marked: false, exit: null, unknown: null }),
      list: async () => [],
      connected: () => true,
      artifacts: async () => [],
      dropRun: async () => {},
      async readRange(_path, offset) {
        fake.reads.push(offset);
        return {
          bytes: fake.file.subarray(offset, offset + fake.chunk),
          size: fake.file.length,
          mtime: fake.mtime,
        };
      },
    },
  };
  return fake;
}

function setup(f: Fixture, fake: Remote, adapter: Adapter = ECHO, run = f.runningRun().run, extra: Partial<RunnerOptions> = {}) {
  const runner = createRunner({ ...RUNNER_TUNED,
    ledger: f.ledger,
    adapters: { stub: adapter },
    logins: memoryLogins({ own: { ...Object.values(ACCOUNTS)[0]!, id: f.login.login.id, name: f.login.login.name } }), machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter),
    ...extra,
  });
  const lines = () => runner.events(run.id).map((event) => (event.kind === 'text' ? event.text : event.kind));
  return { run, runner, lines };
}

test('Worker diagnostics survive service restart and resume at the last complete line', async (t) => {
  const f = fixture(t);
  const diagnosticsDir = join(f.dir, 'diagnostics');
  const fake = remote('一\n半');
  const { run, runner } = setup(f, fake, ECHO, undefined, { diagnosticsDir });
  await runner.tail(run);

  const restarted = setup(f, fake, ECHO, run, { diagnosticsDir });
  assert.deepEqual(restarted.lines(), ['一']);
  fake.file = Buffer.from('一\n半行\n');
  await restarted.runner.tail(run);
  assert.deepEqual(restarted.lines(), ['一', '半行']);
  assert.deepEqual(fake.reads, [0, Buffer.byteLength('一\n')]);
});

test('an ended Worker history gives the confirmed prefix offline and catches up from its cursor after reconnect', async (t) => {
  const f = fixture(t);
  const diagnosticsDir = join(f.dir, 'diagnostics');
  const fake = remote('first\n');
  const { run, runner } = setup(f, fake, ECHO, undefined, { diagnosticsDir });
  await runner.tail(run);
  f.ledger.settleRun(run.id, 0, null);
  const restart = setup(f, fake, ECHO, run, { diagnosticsDir }).runner;
  const read = fake.host.readRange;
  fake.host.readRange = async () => { throw new Unreachable('离线'); };
  const offline = await restart.eventSnapshot(f.run(run.id));
  assert.equal(offline.loaded, true);
  assert.match(offline.reason ?? '', /连回/);
  assert.deepEqual(offline.events, [{ kind: 'text', text: 'first' }]);

  fake.file = Buffer.from('first\nsecond\nlast without newline');
  fake.host.readRange = read;
  const recovered = await restart.eventSnapshot(f.run(run.id));
  assert.deepEqual(recovered, {
    events: ['first', 'second', 'last without newline'].map((text) => ({ kind: 'text', text })),
    firstIndex: 0, loaded: true,
  });
  const reloaded = setup(f, fake, ECHO, run, { diagnosticsDir }).runner;
  fake.host.readRange = async () => assert.fail('已完整归档的诊断不应再查原机器');
  assert.deepEqual(await reloaded.eventSnapshot(f.run(run.id)), recovered);
  assert.deepEqual(fake.reads, [0, Buffer.byteLength('first\n')]);
});

test('Worker history cannot read a new registration or accept bytes backwards after truncation', async (t) => {
  const f = fixture(t);
  const diagnosticsDir = join(f.dir, 'diagnostics');
  const fake = remote('first\n');
  const { run, runner } = setup(f, fake, ECHO, undefined, { diagnosticsDir });
  await runner.tail(run);
  f.ledger.settleRun(run.id, 0, null);
  const savedMachine = f.ledger.getMachine(run.machine_id!)!;
  const newMachine = { ...savedMachine, nodeId: 'other-registration', uid: 'other-machine' };
  const switched = setup(f, fake, ECHO, run, {
    diagnosticsDir, machines: { get: () => newMachine, list: () => [newMachine] },
    connect: () => assert.fail('不得连到同名的新登记'),
  }).runner;
  const unavailable = await switched.eventSnapshot(f.run(run.id));
  assert.deepEqual(unavailable.events, [{ kind: 'text', text: 'first' }]);
  assert.match(unavailable.reason ?? '', /登记/);

  fake.file = Buffer.from('new\n');
  const restored = setup(f, fake, ECHO, run, { diagnosticsDir }).runner;
  const truncated = await restored.eventSnapshot(f.run(run.id));
  assert.match(truncated.reason ?? '', /缩短/);
  assert.deepEqual(truncated.events.map((event) => event.kind), ['text', 'diagnostic']);
  fake.file = Buffer.from('new\nlong enough to mask the truncation\n');
  assert.deepEqual(await restored.eventSnapshot(f.run(run.id)), truncated);
  assert.deepEqual(fake.reads, [0, Buffer.byteLength('first\n')]);
});

test('Worker history hides credentials before streaming or saving and declines an unrecognizable old credential', async (t) => {
  const f = fixture(t);
  const diagnosticsDir = join(f.dir, 'diagnostics');
  const fake = remote('known-secret-canary and Authorization: Bearer header-secret-canary\n');
  const { run: unmarked } = f.runningRun();
  const snapshot = { ...JSON.parse(unmarked.snapshot_json), credential_ref: 'first' };
  f.force('UPDATE run SET snapshot_json = ? WHERE id = ?', JSON.stringify(snapshot), unmarked.id);
  const run = f.run(unmarked.id);
  const initial = setup(f, fake, ECHO, run, { diagnosticsDir, credential: () => ({ ref: 'first', value: 'known-secret-canary' }) });
  const seen: string[] = [];
  initial.runner.subscribe(run.id, (event) => { if (event.kind === 'text') seen.push(event.text); });
  await initial.runner.tail(run);
  const text = '[已隐去的密钥] and Authorization: Bearer [已隐去的密钥]';
  assert.deepEqual(initial.lines(), [text]);
  assert.deepEqual(seen, [text]);
  const checkpoint = join(diagnosticsDir, run.id + '.json');
  assert.doesNotMatch(readFileSync(checkpoint, 'utf8'), /known-secret-canary|header-secret-canary/);

  f.ledger.settleRun(run.id, 0, null);
  fake.file = Buffer.concat([fake.file, Buffer.from('known-secret-canary\n')]);
  const rotated = setup(f, fake, ECHO, run, { diagnosticsDir, credential: () => ({ ref: 'second', value: 'other-canary' }) });
  const diagnostics = await rotated.runner.eventSnapshot(f.run(run.id));
  assert.match(diagnostics.reason ?? '', /旧凭据/);
  assert.deepEqual(rotated.lines(), [text]);
  assert.deepEqual(fake.reads, [0]);
});

test('Worker diagnostics keep a byte-bounded suffix and expire only once an ended Run is due', async (t) => {
  const f = fixture(t);
  const diagnosticsDir = join(f.dir, 'diagnostics');
  const now = () => Date.now() + 86_400_000;
  const fake = remote(Array.from({ length: 10 }, (_, n) => `${n} ${'x'.repeat(128 * 1024)}\n`).join(''));
  const { run, runner } = setup(f, fake, ECHO, undefined, { diagnosticsDir, now, diagnosticsRetentionMs: () => 100 });
  const checkpoint = join(diagnosticsDir, run.id + '.json');
  for(let n=0;n<Math.ceil(fake.file.length/262144);n++)await runner.tail(run);
  runner.pruneDiagnostics();
  assert.ok(statSync(checkpoint).size < 1024 * 1024 + 4096);
  const before = await runner.eventSnapshot(run);
  const mark = before.events[0]!;
  assert.ok(mark.kind === 'truncated' && mark.dropped > 0);
  assert.equal(before.firstIndex, mark.dropped - 1);
  const restarted = setup(f, fake, ECHO, run, { diagnosticsDir }).runner;
  assert.deepEqual(await restarted.eventSnapshot(run), before);

  f.ledger.settleRun(run.id, 0, null);
  assert.match((await runner.eventSnapshot(f.run(run.id))).reason ?? '', /保留期已过/);
  runner.pruneDiagnostics();
  assert.equal(existsSync(checkpoint), false);
});

test('a half line waits for the next poll', async (t) => {
  const f = fixture(t);
  const fake = remote('一\n半');
  const { run, runner, lines } = setup(f, fake);
  await runner.tail(run);
  assert.deepEqual(lines(), ['一']);

  fake.file = Buffer.from('一\n半行\n');
  await runner.tail(run);
  assert.deepEqual(lines(), ['一', '半行']);
});

test('a character split between two chunks survives', async (t) => {
  const f = fixture(t);
  // 3 bytes per character, so a chunk of 2 cuts through each one.
  const { run, runner, lines } = setup(f, remote('青松\n', 2));
  for (let poll = 0; poll < 2; poll += 1) await runner.tail(run);
  assert.deepEqual(lines(), ['青松']);
});

test('reading resumes at the offset and shows nothing twice', async (t) => {
  const f = fixture(t);
  const fake = remote('a\nb\n');
  const { run, runner, lines } = setup(f, fake);
  await runner.tail(run);
  fake.file = Buffer.from('a\nb\nc\n');
  await runner.tail(run);
  await runner.tail(run);
  assert.deepEqual(lines(), ['a', 'b', 'c']);
  assert.deepEqual(fake.reads, [0, 4, 6]);
});

test('a line far longer than one read comes out whole', async (t) => {
  const f = fixture(t);
  const long = 'x'.repeat(5000);
  const { run, runner, lines } = setup(f, remote(`${long}\nshort\n`, 64));
  for (let poll = 0; poll < 40; poll += 1) await runner.tail(run);
  assert.deepEqual(lines(), [long, 'short']);
});

test('a file growing faster than it is read cannot keep one poll going', async (t) => {
  const f = fixture(t);
  const fake = remote('a\n', 2);
  const read = fake.host.readRange;
  fake.host.readRange = async (path, offset) => {
    assert.ok(fake.reads.length < 10, '一轮没有停下来');
    const range = await read(path, offset);
    fake.file = Buffer.concat([fake.file, Buffer.from('bbbb\n')]);
    return { ...range, size: fake.file.length };
  };
  const { run, runner } = setup(f, fake);
  await runner.tail(run);
  assert.equal(fake.reads.length, 2);
  await runner.tail(run);
  assert.equal(fake.reads.length, 4);
});

test('an empty line and a missing file are harmless', async (t) => {
  const f = fixture(t);
  const fake = remote('');
  fake.mtime = 0;
  const { run, runner, lines } = setup(f, fake);
  await runner.tail(run);
  assert.deepEqual(lines(), []);
  assert.equal(f.run(run.id).last_progress_at, null);
});

test('subscribers see each event once, until they leave', async (t) => {
  const f = fixture(t);
  const fake = remote('a\n');
  const { run, runner } = setup(f, fake);
  const seen: string[] = [];
  const leave = runner.subscribe(run.id, (event) => seen.push(event.kind === 'text' ? event.text : ''));
  await runner.tail(run);
  leave();
  fake.file = Buffer.from('a\nb\n');
  await runner.tail(run);
  assert.deepEqual(seen, ['a']);
});

test('captured progress advances when new logical bytes arrive and remains unchanged without growth', async (t) => {
  const f = fixture(t);
  const fake = remote('a\n');
  const { run, runner } = setup(f, fake);
  await runner.tail(run);
  const first = f.run(run.id).last_progress_at;
  assert.ok(first&&Number.isFinite(Date.parse(first)));

  f.force(`UPDATE run SET last_progress_at = 'sentinel' WHERE id = ?`, run.id);
  await runner.tail(run);
  assert.equal(f.run(run.id).last_progress_at, 'sentinel');

  fake.mtime += 60;
  fake.file = Buffer.from('a\nb\n');
  await runner.tail(run);
  assert.notEqual(f.run(run.id).last_progress_at,'sentinel');
});

test('a parser that throws away a line does not disturb the rest', async (t) => {
  const f = fixture(t);
  const { run, runner } = setup(f, remote('not json\n{"type":"result","result":"x"}\n'), claudeAdapter);
  await runner.tail(run);
  assert.deepEqual(
    runner.events(run.id).map((event) => event.kind),
    ['turn.end'],
  );
});

test('an unreachable host leaves tail quiet and the Run untouched', async (t) => {
  const f = fixture(t);
  const fake = remote('a\n');
  fake.host.readRange = async () => {
    throw new Unreachable('断了');
  };
  const { run, runner } = setup(f, fake);
  await runner.tail(run);
  assert.equal(f.run(run.id).state, 'running');
});

test('a settled Run is not tailed', async (t) => {
  const f = fixture(t);
  const fake = remote('a\n');
  const { run, runner } = setup(f, fake);
  f.ledger.settleRun(run.id, 0, { status: 'done', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  await runner.tail(run);
  assert.deepEqual(fake.reads, []);
});

test('historical load reads all original lines without changing ledger or live cache', async (t) => {
  const f = fixture(t);
  const fake = remote('一\n二\n尾行', 2);
  const { run, runner } = setup(f, fake);
  f.ledger.settleRun(run.id, 0, { status: 'done', summary: '完成', artifacts: [{ kind: 'commit', ref: 'c0ffee' }, { kind: 'report', ref: 'report.md' }] });
  const before = f.dump();
  const events = await runner.loadEvents(f.run(run.id));
  assert.deepEqual(events, ['一', '二', '尾行'].map((text) => ({ kind: 'text', text })));
  assert.deepEqual(f.dump(), before);
  assert.deepEqual(runner.events(run.id), []);
});

test('historical load reports missing files and unreachable hosts as identifiable failures', async (t) => {
  const f = fixture(t);
  const fake = remote('');
  const { run, runner } = setup(f, fake);
  fake.mtime = 0;
  await assert.rejects(runner.loadEvents(run), { name: 'HistoryLoadError', message: /原始输出不存在/ });
  fake.host.readRange = async () => { throw new Unreachable('离线'); };
  await assert.rejects(runner.loadEvents(run), { name: 'HistoryLoadError', message: /离线/ });
});

test('the log keeps the latest 5000 events and its first entry says how many went', async (t) => {
  const f = fixture(t);
  const count = 5003;
  const body = Array.from({ length: count }, (_, index) => `e${index}`).join('\n');
  const { run, runner } = setup(f, remote(`${body}\n`));
  const positions: number[] = [];
  const seen: string[] = [];
  runner.subscribe(run.id, (event) => {
    seen.push(event.kind === 'text' ? event.text : event.kind);
    positions.push(runner.eventBase(run.id) + runner.events(run.id).length - 1);
  });
  await runner.tail(run);
  const events = runner.events(run.id);
  assert.equal(events.length, 5001);
  assert.deepEqual(events[0], { kind: 'truncated', dropped: 3 });
  assert.deepEqual(events[1], { kind: 'text', text: 'e3' });
  assert.deepEqual(events.at(-1), { kind: 'text', text: `e${count - 1}` });
  assert.deepEqual(seen.at(-1), `e${count - 1}`, '订阅者照常收到每一条');
  // Readers number events across the drop, and each position comes once.
  assert.deepEqual(positions, Array.from({ length: count }, (_, index) => index));
  assert.equal(runner.eventBase(run.id) + events.length, count);
});

test('below the limit nothing is marked', async (t) => {
  const f = fixture(t);
  const body = Array.from({ length: 5000 }, (_, index) => `e${index}`).join('\n');
  const { run, runner } = setup(f, remote(`${body}\n`));
  await runner.tail(run);
  assert.equal(runner.events(run.id).length, 5000);
  assert.deepEqual(runner.events(run.id)[0], { kind: 'text', text: 'e0' });
  assert.equal(runner.eventBase(run.id), 0);
});

// The setting site.outputLimitKb bounds each text a page keeps of a tool call, read when
// a line is read: a change takes effect from the next line, and the cut says it is tycho's.
test('a tool output is kept up to the limit the Runner is handed, read at each line', async (t) => {
  const f = fixture(t);
  const OUTPUT: Adapter = { ...claudeAdapter, parse: (line) => [{ kind: 'tool.end', id: line.slice(0, 1), isError: false, output: { text: line } }] };
  const fake = remote(`a${'x'.repeat(4000)}\n`);
  const { run } = f.runningRun();
  let limit = 2048;
  const runner = createRunner({ ...RUNNER_TUNED,
    displayTextBytes: () => limit,
    ledger: f.ledger,
    adapters: { stub: OUTPUT },
    logins: memoryLogins({ own: { ...Object.values(ACCOUNTS)[0]!, id: f.login.login.id, name: f.login.login.name } }), machines: { get: f.ledger.getMachine, list: f.ledger.listMachines },
    connect: () => capturedHost(fake.host,f.ledger,claudeAdapter),
  });
  await runner.tail(run);
  limit = 1 << 20;
  fake.file = Buffer.concat([fake.file, Buffer.from(`b${'y'.repeat(4000)}\n`)]);
  await runner.tail(run);
  const [first, second] = runner.events(run.id);
  assert.ok(first?.kind === 'tool.end' && second?.kind === 'tool.end');
  assert.ok(first.output!.text.length < 2200);
  assert.equal(first.output!.omittedBytes, 4001 - 2048);
  assert.equal(second.output!.text.length, 4001);
  assert.equal(second.output!.omittedBytes, undefined);
});
