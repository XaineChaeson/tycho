import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { NormalizedEvent } from '../adapters/types.ts';
import {
  createRoundWatchdog,
  DEFAULT_POST_TURN_GRACE_MS,
  type WatchdogTriggerReason,
} from '../node/watchdog.ts';

function fakeParser(line: string): NormalizedEvent[] {
  const msg = JSON.parse(line) as { type?: string; id?: string };
  if (msg.type === 'tool.start' && msg.id) {
    return [{ kind: 'tool.start', id: msg.id, category: 'run', name: 'bash', title: 'run' }];
  }
  if (msg.type === 'tool.end' && msg.id) {
    return [{ kind: 'tool.end', id: msg.id, isError: false }];
  }
  if (msg.type === 'turn.end') {
    return [{ kind: 'turn.end' }];
  }
  return [];
}

test('turn.end triggers turn_completed_hang after postTurnGraceMs and dispose before grace cancels it', async () => {
  assert.equal(DEFAULT_POST_TURN_GRACE_MS, 20_000);

  const triggered: { reason: WatchdogTriggerReason; detail: string }[] = [];
  const wd = createRoundWatchdog({
    parse: fakeParser,
    postTurnGraceMs: 40,
    onTrigger: (reason, detail) => triggered.push({ reason, detail }),
  });

  wd.feedStdout(`${JSON.stringify({ type: 'turn.end' })}\n`);
  assert.equal(wd.isTurnEnded(), true);
  assert.equal(wd.snapshot().phase, 'turn_ended');
  assert.equal(triggered.length, 0);

  await sleep(90);
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0]!.reason, 'turn_completed_hang');
  assert.equal(
    triggered[0]!.detail,
    '执行器已产出正式完成事件，但进程超过宽限期仍未退出，已自动回收并保留结果',
  );
  wd.dispose();

  // Disposing before postTurnGraceMs elapses must prevent triggering.
  const cancelledTriggers: WatchdogTriggerReason[] = [];
  const wd2 = createRoundWatchdog({
    parse: fakeParser,
    postTurnGraceMs: 50,
    onTrigger: (reason) => cancelledTriggers.push(reason),
  });
  wd2.feedStdout(`${JSON.stringify({ type: 'turn.end' })}\n`);
  assert.equal(wd2.isTurnEnded(), true);
  wd2.dispose();

  await sleep(100);
  assert.equal(cancelledTriggers.length, 0);
});

test('multi-turn safety: tool.start after turn.end cancels post-turn reclaim timer', async () => {
  const triggered: WatchdogTriggerReason[] = [];
  const wd = createRoundWatchdog({
    parse: fakeParser,
    postTurnGraceMs: 50,
    onTrigger: (reason) => triggered.push(reason),
  });

  wd.feedStdout(`${JSON.stringify({ type: 'turn.end' })}\n`);
  assert.equal(wd.isTurnEnded(), true);

  wd.feedStdout(`${JSON.stringify({ type: 'tool.start', id: 't1' })}\n`);
  assert.equal(wd.isTurnEnded(), false);
  assert.equal(wd.snapshot().phase, 'tool_running');
  assert.equal(wd.snapshot().activeTools, 1);

  await sleep(90);
  assert.equal(triggered.length, 0);
  wd.dispose();
});

test('tool.start suppresses model_idle indefinitely; tool.end re-enables model_idle', async () => {
  let clock = 1_000;
  const triggered: { reason: WatchdogTriggerReason; detail: string }[] = [];
  const wd = createRoundWatchdog({
    parse: fakeParser,
    modelIdleTimeoutMs: 5 * 60_000,
    now: () => clock,
    onTrigger: (reason, detail) => triggered.push({ reason, detail }),
  });

  wd.feedStdout(`${JSON.stringify({ type: 'tool.start', id: 'tool-1' })}\n`);
  assert.equal(wd.snapshot().phase, 'tool_running');
  assert.equal(wd.snapshot().activeTools, 1);

  // Even an hour of silence must never trigger while a tool is active.
  clock += 60 * 60_000;
  await wd.tick();
  assert.equal(triggered.length, 0);
  assert.equal(wd.snapshot().silentMs, 60 * 60_000);

  // Tool finishes -> lastProgressAt resets; phase returns to waiting_model.
  wd.feedStdout(`${JSON.stringify({ type: 'tool.end', id: 'tool-1' })}\n`);
  assert.equal(wd.snapshot().phase, 'waiting_model');
  assert.equal(wd.snapshot().activeTools, 0);
  assert.equal(wd.snapshot().silentMs, 0);

  // Just below timeout: no trigger.
  clock += 5 * 60_000 - 1;
  await wd.tick();
  assert.equal(triggered.length, 0);

  // At timeout: triggers model_idle exactly once.
  clock += 1;
  await wd.tick();
  await wd.tick();
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0]!.reason, 'model_idle');
  assert.equal(
    triggered[0]!.detail,
    '等待模型或初始化超过 5 分钟无进展且无运行中工具，已自动中止',
  );
  wd.dispose();
});

test('hasDescendantProcesses prevents false kills when busy or when check throws, and notes once per idle window', async () => {
  let clock = 10_000;
  let busy = true;
  let shouldThrow = false;
  const notes: string[] = [];
  const triggered: WatchdogTriggerReason[] = [];

  const wd = createRoundWatchdog({
    parse: fakeParser,
    modelIdleTimeoutMs: 60_000,
    now: () => clock,
    hasDescendantProcesses: async () => {
      if (shouldThrow) throw new Error('process table unreadable');
      return busy;
    },
    onNote: (msg) => notes.push(msg),
    onTrigger: (reason) => triggered.push(reason),
  });

  // Busy descendant subprocess: never triggers; note emitted at most once in this idle window.
  clock += 120_000;
  await wd.tick();
  await wd.tick();
  assert.equal(triggered.length, 0);
  assert.deepEqual(notes, ['检测到活跃子进程仍在运行，跳过静默中止']);

  // Fail-safe when process table throws: assume busy and never false-kill.
  busy = false;
  shouldThrow = true;
  clock += 60_000;
  await wd.tick();
  assert.equal(triggered.length, 0);
  assert.equal(notes.length, 1);

  // New stdout progress opens a fresh idle window; descendant busy again emits one new note.
  wd.feedStdout('{"type":"noop"}\n');
  shouldThrow = false;
  busy = true;
  clock += 60_000;
  await wd.tick();
  await wd.tick();
  assert.equal(triggered.length, 0);
  assert.equal(notes.length, 2);

  // Once descendant exits and check succeeds with false, model_idle triggers.
  busy = false;
  await wd.tick();
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0], 'model_idle');
  wd.dispose();
});

test('stdout progress arriving during async hasDescendantProcesses check aborts model_idle trigger', async () => {
  let clock = 0;
  const triggered: WatchdogTriggerReason[] = [];
  const gate = Promise.withResolvers<boolean>();

  const wd = createRoundWatchdog({
    parse: fakeParser,
    modelIdleTimeoutMs: 60_000,
    now: () => clock,
    hasDescendantProcesses: () => gate.promise,
    onTrigger: (reason) => triggered.push(reason),
  });

  clock = 60_000;
  const pending = wd.tick();
  // Concurrent tick while checkingIdle is ignored.
  await wd.tick();

  // Progress arrives before the process check resolves false.
  wd.feedStdout('{"type":"noop"}\n');
  gate.resolve(false);
  await pending;

  assert.equal(triggered.length, 0);
  wd.dispose();
});

test('feedStderr refreshes lastProgressAt in both structured parser mode and raw mode so retry/backoff progress never false-kills', async () => {
  let clock = 0;
  const codexTriggers: WatchdogTriggerReason[] = [];

  // Real codex adapter via `executor: 'codex'`.
  const codexWd = createRoundWatchdog({
    executor: 'codex',
    modelIdleTimeoutMs: 3 * 60_000,
    now: () => clock,
    onTrigger: (reason) => codexTriggers.push(reason),
  });

  // Periodic stderr retry/backoff output every 30s refreshes lastProgressAt and prevents false idle kills.
  for (let i = 0; i < 8; i++) {
    clock += 30_000;
    codexWd.feedStderr(
      'WARN codex: rate limited, retrying after backoff...\n',
    );
    await codexWd.tick();
  }
  assert.equal(codexWd.snapshot().silentMs, 0);
  assert.deepEqual(codexTriggers, []);

  // Once both stdout and stderr stay silent for modelIdleTimeoutMs, model_idle triggers normally.
  clock += 3 * 60_000;
  await codexWd.tick();
  assert.deepEqual(codexTriggers, ['model_idle']);
  codexWd.dispose();

  // Unknown / raw CLI without structured parser: stderr also resets lastProgressAt.
  let rawClock = 0;
  const rawTriggers: WatchdogTriggerReason[] = [];
  const rawWd = createRoundWatchdog({
    executor: 'unknown-raw-cli',
    modelIdleTimeoutMs: 60_000,
    now: () => rawClock,
    onTrigger: (reason) => rawTriggers.push(reason),
  });

  rawClock += 50_000;
  rawWd.feedStderr(Buffer.from('progress on stderr\n', 'utf8'));
  rawClock += 50_000;
  await rawWd.tick();
  assert.equal(rawTriggers.length, 0);
  assert.equal(rawWd.snapshot().silentMs, 50_000);

  rawClock += 10_000;
  await rawWd.tick();
  assert.deepEqual(rawTriggers, ['model_idle']);
  rawWd.dispose();
});

test('modelIdleTimeoutMs = 0 disables model_idle while turn_completed_hang still works', async () => {
  let clock = 0;
  const triggered: WatchdogTriggerReason[] = [];
  const wd = createRoundWatchdog({
    executor: 'codex',
    modelIdleTimeoutMs: 0,
    postTurnGraceMs: 35,
    now: () => clock,
    onTrigger: (reason) => triggered.push(reason),
  });

  clock += 24 * 60 * 60_000;
  await wd.tick();
  assert.equal(triggered.length, 0);

  // Feed a real Codex turn.completed line.
  wd.feedStdout('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n');
  assert.equal(wd.isTurnEnded(), true);

  await sleep(80);
  assert.deepEqual(triggered, ['turn_completed_hang']);
  wd.dispose();
});

test('multi-chunk UTF-8, partial JSON lines, malformed lines, and oversized >1MiB lines are handled cleanly', async () => {
  let clock = 0;
  const triggered: WatchdogTriggerReason[] = [];
  const wd = createRoundWatchdog({
    executor: 'codex',
    modelIdleTimeoutMs: 60_000,
    postTurnGraceMs: 40,
    now: () => clock,
    onTrigger: (reason) => triggered.push(reason),
  });

  // 1. Split a real Codex command_execution start line containing multi-byte Chinese UTF-8
  //    right in the middle of a 3-byte UTF-8 character and across JSON boundaries.
  const startLine = `${JSON.stringify({
    type: 'item.started',
    item: { id: 'cmd_utf8', type: 'command_execution', command: 'echo 中文测试' },
  })}\r\n`;
  const startBytes = Buffer.from(startLine, 'utf8');
  const zhOffset = startBytes.indexOf(Buffer.from('中', 'utf8'));
  assert.ok(zhOffset > 0);

  // Split inside the 3-byte UTF-8 sequence for '中' (1 byte, then 1 byte, then rest).
  wd.feedStdout(startBytes.subarray(0, zhOffset + 1));
  assert.equal(wd.snapshot().activeTools, 0);
  wd.feedStdout(startBytes.subarray(zhOffset + 1, zhOffset + 2));
  assert.equal(wd.snapshot().activeTools, 0);
  wd.feedStdout(startBytes.subarray(zhOffset + 2));
  assert.equal(wd.snapshot().phase, 'tool_running');
  assert.equal(wd.snapshot().activeTools, 1);

  // 2. Malformed line must not crash or corrupt parser state.
  wd.feedStdout(Buffer.from('{not valid json\n', 'utf8'));
  assert.equal(wd.snapshot().activeTools, 1);

  // 3. Complete the tool across two chunks.
  const endLine = `${JSON.stringify({
    type: 'item.completed',
    item: { id: 'cmd_utf8', type: 'command_execution', command: 'echo 中文测试', exit_code: 0 },
  })}\n`;
  const endBytes = Buffer.from(endLine, 'utf8');
  wd.feedStdout(endBytes.subarray(0, 20));
  assert.equal(wd.snapshot().activeTools, 1);
  wd.feedStdout(endBytes.subarray(20));
  assert.equal(wd.snapshot().activeTools, 0);
  assert.equal(wd.snapshot().phase, 'waiting_model');

  // 4. Giant unterminated line (> 1 MiB) still updates lastProgressAt and recovers cleanly on \n.
  clock += 50_000;
  const hugeChunk = Buffer.alloc(600 * 1024, 0x61); // 'a' * 600 KiB
  wd.feedStdout(hugeChunk);
  assert.equal(wd.snapshot().silentMs, 0);
  clock += 10_000;
  wd.feedStdout(hugeChunk); // now > 1 MiB without '\n'
  assert.equal(wd.snapshot().silentMs, 0);
  // End the giant line and immediately follow with turn.completed in the same chunk.
  wd.feedStdout(
    Buffer.from(
      'tail\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
      'utf8',
    ),
  );
  assert.equal(wd.isTurnEnded(), true);

  await sleep(90);
  assert.deepEqual(triggered, ['turn_completed_hang']);
  wd.dispose();
});

test('throwing custom parser never crashes feedStdout and subsequent valid lines still work', async () => {
  const triggered: WatchdogTriggerReason[] = [];
  const wd = createRoundWatchdog({
    parse: (line) => {
      if (line.includes('boom')) throw new Error('parser crash');
      return fakeParser(line);
    },
    postTurnGraceMs: 30,
    onTrigger: (reason) => triggered.push(reason),
  });

  assert.doesNotThrow(() => {
    wd.feedStdout('boom\n');
    wd.feedStdout(`${JSON.stringify({ type: 'turn.end' })}\n`);
  });
  assert.equal(wd.isTurnEnded(), true);

  await sleep(70);
  assert.deepEqual(triggered, ['turn_completed_hang']);
  wd.dispose();
});
