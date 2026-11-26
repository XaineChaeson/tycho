// Guards the page's copy of a Run's events: a megabyte of output, a file written whole or
// a patch kept whole in memory for every watcher; a cut that hides where it was made or
// how much it left out; tycho's cut confused with the executor's own; a cut through a
// character that leaves garbage, or a count of bytes left out that is off by the half
// character dropped at the edge; a title that still carries the whole command past the
// limit; and short texts or other events touched at all.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedEvent } from '../adapters/types.ts';
import { codexAdapter } from '../adapters/codex.ts';
import { bounded, clip } from '../runner/display.ts';
import { SETTINGS } from '../service/settings.ts';

const LIMIT = SETTINGS['site.outputLimitKb'].default * 1024;

test('a short text is left as it is', () => {
  assert.deepEqual(clip('短', LIMIT), { text: '短', omitted: 0 });
});

test('a long text keeps its head and tail, marks the cut, and says how much it left out', () => {
  const text = `开头${'中'.repeat(20_000)}结尾`;
  const { text: kept, omitted } = clip(text, LIMIT);
  assert.ok(kept.startsWith('开头'));
  assert.ok(kept.endsWith('结尾'));
  assert.ok(Buffer.byteLength(kept) < LIMIT + 100);
  assert.match(kept, new RegExp(`tycho 省略了中间 ${omitted} 字节`));
  assert.ok(!kept.includes('�'), '切口不留半个字');
  // What is said to be left out is exactly what is not there.
  const [head, tail] = kept.split(/\n…（tycho 省略了中间 \d+ 字节）…\n/);
  assert.equal(omitted, Buffer.byteLength(text) - Buffer.byteLength(head!) - Buffer.byteLength(tail!));
});

// Review (run-scene): the title carried the whole command past the limit the input kept to.
test('a command as the adapter reads it is bounded in its title as well as its input', () => {
  const command = `bash -lc 'echo ${'x'.repeat(100_000)}'`;
  const limit = 1024;
  for (const line of [{ type: 'item.started', item: { id: 'c', type: 'command_execution', command } }, { type: 'item.completed', item: { id: 'c', type: 'command_execution', command, status: 'completed', exit_code: 0 } }]) {
    const [event] = codexAdapter.parse(JSON.stringify(line)).map((each) => bounded(each, limit));
    const call = event?.kind === 'tool.start' ? event : event?.kind === 'tool.end' ? event.call : undefined;
    assert.ok(call);
    assert.ok(Buffer.byteLength(call.title) <= limit + 100, `标题 ${Buffer.byteLength(call.title)} 字节`);
    assert.ok(Buffer.byteLength(call.input!) <= limit + 100);
    assert.match(call.title, /tycho 省略了/);
  }
});

test('what the executor says about itself is bounded too', () => {
  const said = bounded({ kind: 'diagnostic', level: 'warning', message: '<html>'.repeat(50_000) }, 1024);
  assert.ok(said.kind === 'diagnostic' && Buffer.byteLength(said.message) <= 1124);
});

test('output, input, reason and patch are bounded; tycho marks its own cut beside the executor\'s', () => {
  const long = 'x'.repeat(100_000);
  const end = bounded({
    kind: 'tool.end', id: 't', isError: false,
    call: { category: 'run', name: 'Bash', title: 't', input: long },
    output: { text: long, executorTruncated: true },
    reason: long,
    changes: [{ path: 'a', patch: long }, { path: 'b' }],
  }, LIMIT);
  assert.ok(end.kind === 'tool.end');
  assert.equal(end.output?.executorTruncated, true);
  assert.equal(end.output?.omittedBytes, 100_000 - LIMIT);
  for (const text of [end.output?.text, end.call?.input, end.reason, end.changes?.[0]?.patch]) assert.ok((text?.length ?? 0) < LIMIT + 100);
  assert.deepEqual(end.changes?.[1], { path: 'b' });
  const start = bounded({ kind: 'tool.start', id: 't', category: 'edit', name: 'Write', title: 'a', input: long }, LIMIT);
  assert.ok(start.kind === 'tool.start' && start.input!.length < LIMIT + 100);
  const small: NormalizedEvent = { kind: 'tool.end', id: 't', isError: false, output: { text: 'ok' } };
  assert.deepEqual(bounded(small, LIMIT), small);
  const text: NormalizedEvent = { kind: 'text', text: long };
  assert.equal(bounded(text, LIMIT), text, '汇报的话不截');
});
