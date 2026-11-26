// The incremental public interface must preserve a native result across byte boundaries,
// reject incomplete results at explicit limits, and retain session/usage/error semantics.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAdapter } from '../adapters/claude.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { geminiAdapter } from '../adapters/gemini.ts';
import { ResultLimitError, type ResultLimits, type ResultReader } from '../adapters/result-stream.ts';

const adapters = [claudeAdapter, codexAdapter, dshAdapter, geminiAdapter];
const limits: ResultLimits = { recordBytes: 1024 * 1024, stateBytes: 2 * 1024 * 1024, stderrBytes: 1024 * 1024 };
const jsonl = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n');
function feed(reader: ResultReader, stream: 'feedStdout' | 'feedStderr', text: string, size: number): void {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; at += size) reader[stream](bytes.subarray(at, at + size));
}
const rows = [
  [{ type: 'system', session_id: '会话😀' }, { type: 'result', result: '前回', usage: { input_tokens: 2, output_tokens: 3 } },
    { type: 'result', result: '末回🙂', usage: { input_tokens: 5, output_tokens: 7 } }],
  [{ type: 'thread.started', thread_id: '会话😀' }, { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } },
    { type: 'item.completed', item: { type: 'agent_message', text: '末回🙂' } }, { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 7 } }],
  [{ type: 'session', sessionId: '会话😀' }, { type: 'status', phase: 'step_end', usage: { inputTokens: 2, outputTokens: 3 } },
    { type: 'final', text: '前回', reason: { kind: 'completed' } }, { type: 'status', phase: 'step_end', usage: { inputTokens: 5, outputTokens: 7 } },
    { type: 'final', text: '末回🙂', reason: { kind: 'completed' } }],
  [{ event: 'init', conversation_id: '会话😀', init: {} },
    { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 2, output_tokens: 3 } } },
    { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '末回🙂', usage: { input_tokens: 5, output_tokens: 7 } } },
    { event: 'result', result: { conversation_id: '会话😀', status: 'SUCCESS', response: '末回🙂', num_turns: 1 } }],
];
for (const [index, adapter] of adapters.entries()) {
  for (const size of [1, 2, 7, 65536]) test(`${index}: UTF-8 and multiple turns survive ${size}-byte chunks without trailing newline`, () => {
    const reader = adapter.resultReader!(limits);
    feed(reader, 'feedStdout', jsonl(rows[index]!), size);
    const reading = reader.finish(0);
    assert.equal(reading.text, '末回🙂');
    assert.equal(reading.sessionRef, '会话😀');
    assert.equal(reading.finished, true);
    assert.equal(reading.error, undefined);
    assert.equal(reading.usage?.reduce((n, each) => n + each.inputTokens, 0), 7);
    assert.equal(reading.usage?.reduce((n, each) => n + each.outputTokens, 0), 10);
    assert.deepEqual(reading, adapter.result(jsonl(rows[index]!), 0, ''));
    assert.throws(() => reader.finish(0), /already finished/);
  });
  test(`${index}: interruption retains session and does not invent completion`, () => {
    const reader = adapter.resultReader!(limits);
    feed(reader, 'feedStdout', jsonl([rows[index]![0]!]), 1);
    assert.deepEqual(reader.finish(null), { sessionRef: '会话😀', finished: false });
  });
  for (const dimension of ['recordBytes', 'stateBytes', 'stderrBytes'] as const) test(`${index}: ${dimension} overflow permanently refuses a partial result`, () => {
    const reader = adapter.resultReader!({ ...limits, [dimension]: 64 });
    const operation = () => dimension === 'stderrBytes' ? reader.feedStderr(Buffer.alloc(65, 120))
      : dimension === 'recordBytes' ? reader.feedStdout(Buffer.alloc(65, 120))
      : reader.feedStdout(Buffer.from(jsonl(rows[index]!) + '\n'));
    let failure: unknown;
    try { operation(); } catch (error) { failure = error; }
    assert.ok(failure instanceof ResultLimitError);
    assert.equal(failure.dimension, dimension);
    for (const next of [() => reader.feedStdout(Buffer.from('\n')), () => reader.feedStderr(Buffer.from('x')), () => reader.finish(0)]) {
      assert.throws(next, (error) => error === failure);
    }
  });
  test(`${index}: no implicit result limits are added to batch`, () => {
    const wide = '文'.repeat(100000);
    const line = index === 0 ? { type: 'result', result: wide } : index === 1
      ? { type: 'item.completed', item: { type: 'agent_message', text: wide } } : index === 2
        ? { type: 'final', text: wide, reason: { kind: 'completed' } } : { event: 'result', result: { status: 'SUCCESS', response: wide } };
    assert.equal(adapter.result(jsonl([line]), 0, '').text, wide);
  });
}

test('early native errors remain authoritative after later records', () => {
  const samples = [
    [{ type: 'assistant', is_api_error_message: true, error: 'authentication_failed' }, { type: 'result', is_error: true, result: 'request failed' }],
    [{ type: 'turn.failed', error: { message: 'quota exceeded' } }, { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }],
    [{ type: 'error', message: '401 unauthorized' }, { type: 'status', phase: 'step_end', usage: { inputTokens: 2, outputTokens: 3 } }, { type: 'final', reason: { kind: 'error' } }],
    [{ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'error_message', text_delta: '401 unauthorized' } },
      { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 2, output_tokens: 3 } } },
      { event: 'result', result: { status: 'ERROR', error: 'request failed', finished_reason: 'error' } }],
  ];
  for (const [index, adapter] of adapters.entries()) {
    const text = jsonl(samples[index]!);
    const reader = adapter.resultReader!(limits);
    feed(reader, 'feedStdout', text, 1);
    const actual = reader.finish(1);
    assert.equal(actual.error?.kind, index === 1 ? 'quota' : 'auth');
    assert.deepEqual(actual, adapter.result(text, 1, ''));
  }
});

test('one-byte raw streams remain usable to their exact byte limits and reject the next byte', () => {
  for (const stream of ['feedStdout', 'feedStderr'] as const) {
    const cap = 256 * 1024;
    const reader = dshAdapter.resultReader!({ ...limits, recordBytes: cap, stderrBytes: cap });
    const byte = Buffer.from('x');
    for (let i = 0; i < cap; i++) reader[stream](byte);
    assert.throws(() => reader[stream](byte), ResultLimitError);
    assert.throws(() => reader.finish(null), ResultLimitError);
  }
  const reader = dshAdapter.resultReader!({ ...limits, recordBytes: 256 * 1024 });
  feed(reader, 'feedStdout', 'x'.repeat(256 * 1024), 1);
  assert.deepEqual(reader.finish(null), { finished: false });
});

test('partial bytes are owned and UTF-8 stderr preserves its native failure message', () => {
  const reader = dshAdapter.resultReader!(limits);
  const input = Buffer.from('{"type":"session","sessionId":"original"}');
  reader.feedStdout(input);
  input.fill(120);
  feed(reader, 'feedStderr', '  错误😀  ', 1);
  const reading = reader.finish(1);
  assert.equal(reading.sessionRef, 'original');
  assert.equal(reading.error?.message, '错误😀');
});

test('final Reading is also measured, and a cap failure is permanent', () => {
  // The reducer retains no state from stderr, but the final error Reading includes it.
  const reader = dshAdapter.resultReader!({ ...limits, stateBytes: 64 });
  reader.feedStderr(Buffer.from('x'.repeat(200)));
  assert.throws(() => reader.finish(1), (error) => error instanceof ResultLimitError && error.dimension === 'stateBytes');
  assert.throws(() => reader.finish(1), ResultLimitError);
});

test('limits are copied and reject invalid numeric values', () => {
  const given = { ...limits, recordBytes: 2 };
  const reader = dshAdapter.resultReader!(given);
  given.recordBytes = 200;
  assert.throws(() => reader.feedStdout(Buffer.from('xxx')), ResultLimitError);
  for (const value of [-1, Infinity, 0.5, NaN]) assert.throws(() => dshAdapter.resultReader!({ ...limits, recordBytes: value }), RangeError);
  assert.deepEqual(dshAdapter.resultReader!({ recordBytes: 0, stderrBytes: 0, stateBytes: 100 }).finish(null), { finished: false });
});
