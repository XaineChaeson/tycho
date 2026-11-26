// A Run's display events have a persisted, bounded recent suffix and
// go to every page that watches; a tool's output, a command, a file written whole, a patch
// or what an executor says about itself can each be megabytes. Each such text keeps its
// head and tail up to the size the setting site.outputLimitKb gives, with a mark where
// tycho cut it. The raw log keeps everything: this is the page's copy.
import type { NormalizedEvent, ToolCall } from '../adapters/types.ts';

// A quarter of what is kept comes from the head, the rest from the tail: a command's
// failure is usually said at its end, what a file is at its start.
const HEAD_SHARE = 0.25;

// The text, or its head and tail with the mark between them, and how many bytes left out:
// counted from what is kept, after a character cut in half at either edge is dropped.
export function clip(text: string, limit: number): { text: string; omitted: number } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return { text, omitted: 0 };
  const head = Math.floor(limit * HEAD_SHARE);
  const start = bytes.subarray(0, head).toString('utf8').replace(/�+$/, '');
  const end = bytes.subarray(bytes.length - (limit - head)).toString('utf8').replace(/^�+/, '');
  const omitted = bytes.length - Buffer.byteLength(start) - Buffer.byteLength(end);
  return { text: `${start}\n…（tycho 省略了中间 ${omitted} 字节）…\n${end}`, omitted };
}

// The event as the page keeps it, each text of it at most `limit` bytes and a mark. The
// title carries the command too when there is nothing shorter to show it by.
export function bounded(event: NormalizedEvent, limit: number): NormalizedEvent {
  const clipped = (text: string): string => clip(text, limit).text;
  const boundCall = <T extends Partial<ToolCall>>(call: T): T => ({
    ...call,
    ...(call.title === undefined ? {} : { title: clipped(call.title) }),
    ...(call.input === undefined ? {} : { input: clipped(call.input) }),
  });
  if (event.kind === 'diagnostic') return { ...event, message: clipped(event.message) };
  if (event.kind === 'tool.start') return boundCall(event);
  if (event.kind !== 'tool.end') return event;
  const next = { ...event };
  if (next.call) next.call = boundCall(next.call);
  if (next.reason !== undefined) next.reason = clipped(next.reason);
  if (next.output) {
    const { text, omitted } = clip(next.output.text, limit);
    next.output = omitted ? { ...next.output, text, omittedBytes: omitted } : next.output;
  }
  if (next.changes) next.changes = next.changes.map((change) => (change.patch === undefined ? change : { ...change, patch: clipped(change.patch) }));
  return next;
}
