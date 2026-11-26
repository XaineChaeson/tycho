// Guards against a streamed reply misbehaving against WeCom's protocol or losing the
// final text: two frames in flight on a req_id (the answers then cannot be paired), a
// stale snapshot left on screen, a frame rate past the three intervals, a late timeout
// hitting the frame after it, one bad frame ending the stream, a blank frame leaving
// the bubble spinning, a stream outliving its six minutes or its size limit with text
// lost at the cut, a final dropped as a duplicate, delivered twice, or reported as
// delivered when it was not, a reconnect that does not catch up, an expired stream
// written to, and a new stream opened past the rate limit.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamClock, StreamFrame, StreamTiming } from '../channels/wecom-stream.ts';
import { compose, elapsedText, ReplyStream, splitBody } from '../channels/wecom-stream.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const ZWSP = '​';

function fakeClock() {
  let at = 1_000_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: StreamClock = {
    now: () => at,
    setTimeout(fn, ms) {
      nextId += 1;
      timers.set(nextId, { at: at + ms, fn });
      return nextId;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  async function advance(ms: number): Promise<void> {
    const end = at + ms;
    await settle();
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      at = Math.max(at, due[1].at);
      timers.delete(due[0]);
      due[1].fn();
      await settle();
    }
    at = end;
    await settle();
  }
  return { clock, advance, settle };
}

interface Options {
  // Answers each frame at once; off, a test answers by hand with ack().
  auto?: boolean;
  answer?: (frame: StreamFrame, index: number) => number | undefined;
  mayOpen?: () => boolean;
  timing?: Partial<StreamTiming>;
}

function setup({ auto = true, answer = () => 0, mayOpen = () => true, timing }: Options = {}) {
  const { clock, advance, settle } = fakeClock();
  const frames: StreamFrame[] = [];
  const waiting: { resolve(): void; reject(err: unknown): void }[] = [];
  let ids = 0;
  const stream = new ReplyStream({
    reqId: 'req',
    clock,
    newId: () => {
      ids += 1;
      return `s${ids}`;
    },
    mayOpen,
    ...(timing ? { timing } : {}),
    send(frame) {
      frames.push(frame);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      if (!auto) {
        waiting.push({ resolve, reject });
        return promise;
      }
      const code = answer(frame, frames.length - 1);
      // Undefined is a frame that never gets an answer.
      if (code === 0) resolve();
      else if (code !== undefined) reject(Object.assign(new Error('refused'), { errcode: code }));
      return promise;
    },
  });
  async function ack(code = 0): Promise<void> {
    const entry = waiting.shift()!;
    if (code === 0) entry.resolve();
    else entry.reject(Object.assign(new Error('refused'), { errcode: code }));
    await settle();
  }
  return { stream, frames, advance, settle, ack, last: () => frames.at(-1)! };
}

test('the first frame goes out at once and shows the placeholder', () => {
  const { frames } = setup();
  assert.deepEqual(frames, [{ reqId: 'req', streamId: 's1', finish: false, content: '<think></think>' }]);
});

test('only one frame is in flight, and the newest snapshot follows once it is answered', async () => {
  const { stream, frames, advance, ack, last } = setup({ auto: false });
  stream.update({ body: '一' });
  stream.update({ body: '一二' });
  await advance(3 * SECOND);
  assert.equal(frames.length, 1);
  stream.update({ body: '一二三' });
  await ack();
  // The interval has long passed, so nothing waits and the middle snapshots are gone.
  assert.equal(frames.length, 2);
  assert.equal(last().content, '一二三');
});

test('an answer inside the interval waits for the interval, then sends the newest', async () => {
  const { stream, frames, advance, ack, last } = setup({ auto: false });
  await advance(100);
  await ack();
  stream.update({ body: '一' });
  await advance(800);
  stream.update({ body: '一二' });
  await advance(99);
  assert.equal(frames.length, 1);
  await advance(1);
  assert.equal(frames.length, 2);
  assert.equal(last().content, '一二');
});

test('nothing goes out when the newest snapshot is already on screen', async () => {
  const { stream, frames, advance } = setup();
  await advance(SECOND);
  stream.update({ body: '一' });
  await advance(SECOND);
  stream.update({ body: '一' });
  await advance(5 * SECOND);
  assert.equal(frames.length, 2);
});

test('a tool line alone waits two seconds, body text one', async () => {
  const { stream, frames, advance, last } = setup();
  await advance(0);
  stream.tool({ name: 'create_task', phase: 'start', isError: false });
  await advance(1999);
  assert.equal(frames.length, 1);
  await advance(1);
  assert.equal(frames.length, 2);
  assert.equal(last().content, '<think>调用 create_task…</think>');
  stream.update({ body: '好' });
  await advance(999);
  assert.equal(frames.length, 2);
  await advance(1);
  assert.equal(frames.length, 3);
});

test('body text that arrives during a tool line wait takes the shorter interval', async () => {
  const { stream, frames, advance } = setup();
  await advance(0);
  stream.tool({ name: 'a', phase: 'start', isError: false });
  await advance(500);
  stream.update({ body: '好' });
  await advance(499);
  assert.equal(frames.length, 1);
  await advance(1);
  assert.equal(frames.length, 2);
});

test('a silent stretch shows the running time, five seconds apart, with every frame different', async () => {
  const { stream, frames, advance, last } = setup();
  stream.update({ body: '开始' });
  await advance(SECOND);
  const before = frames.length;
  await advance(28 * SECOND);
  assert.equal(frames.length, before);
  await advance(SECOND);
  assert.equal(frames.length, before + 1);
  assert.match(last().content, /^<think>已运行 30 秒<\/think>\n\n开始$/);
  await advance(4 * SECOND);
  assert.equal(frames.length, before + 1);
  await advance(SECOND);
  assert.equal(frames.length, before + 2);
  await advance(50 * SECOND);
  assert.match(last().content, /已运行 1 分 2\d 秒/);
  const shown = frames.slice(before).map(({ content }) => content);
  assert.equal(new Set(shown).size, shown.length);
});

test('a refused or unanswered frame is dropped and the next one goes as usual', async () => {
  const { stream, frames, advance, last } = setup({
    answer: (_frame, index) => (index === 1 ? 846607 : index === 2 ? undefined : 0),
  });
  await advance(SECOND);
  stream.update({ body: '一' });
  await advance(0);
  assert.equal(last().content, '一');
  // Refused: the same snapshot goes again, since it never got there.
  await advance(SECOND);
  assert.equal(frames.length, 3);
  assert.equal(last().content, '一');
  stream.update({ body: '一二' });
  await advance(14 * SECOND);
  assert.equal(frames.length, 3);
  await advance(SECOND);
  assert.equal(frames.length, 4);
  assert.equal(last().content, '一二');
});

test('a timeout that fires late does not touch the frame after it', async () => {
  const { stream, frames, advance, ack, last } = setup({ auto: false });
  await advance(15 * SECOND);
  stream.update({ body: '一' });
  await advance(0);
  assert.equal(frames.length, 2);
  // The first frame's answer turns up while the second is in flight.
  await ack();
  stream.update({ body: '一二' });
  await advance(5 * SECOND);
  assert.equal(frames.length, 2);
  await ack();
  await advance(0);
  assert.equal(last().content, '一二');
});

test('at five minutes the stream closes at a paragraph and goes on with what follows it', async () => {
  const { stream, frames, advance, last } = setup();
  stream.update({ body: '第一段\n\n第二段' });
  await advance(5 * MINUTE);
  const closing = frames.find(({ finish }) => finish)!;
  assert.equal(closing.streamId, 's1');
  assert.equal(closing.content, '第一段');
  await advance(SECOND);
  assert.equal(last().streamId, 's2');
  assert.equal(last().reqId, 'req');
  assert.equal(last().finish, false);
  assert.match(last().content, /第二段/);
  assert.doesNotMatch(last().content, /第一段/);
});

test('a rotation with nothing to carry over still gives both bubbles something visible', async () => {
  const { stream, frames, advance } = setup();
  stream.tool({ name: 'list_tasks', phase: 'start', isError: false });
  await advance(5 * MINUTE + SECOND);
  const closing = frames.find(({ finish }) => finish)!;
  assert.match(closing.content.replace(/<think>.*<\/think>/s, ''), /\S/);
  const next = frames.find(({ streamId }) => streamId === 's2')!;
  assert.match(next.content, /接上一条继续/);
  assert.match(next.content, /调用 list_tasks…/);
});

test('past 18000 bytes the stream moves on at a paragraph, losing nothing and repeating nothing', async () => {
  const first = `${'字'.repeat(3000)}\n\n${'甲'.repeat(2000)}`;
  const { stream, frames, advance, last } = setup();
  await advance(SECOND);
  stream.update({ body: first });
  stream.update({ body: `${first}\n\n${'乙'.repeat(2000)}` });
  await advance(2 * SECOND);
  const closing = frames.find(({ finish }) => finish)!;
  assert.ok(Buffer.byteLength(closing.content) <= 18_000);
  assert.equal(closing.content, `${'字'.repeat(3000)}\n\n${'甲'.repeat(2000)}`);
  assert.equal(last().streamId, 's2');
  assert.match(last().content, /乙{2000}/);
  assert.doesNotMatch(last().content, /甲/);
  assert.ok(frames.every(({ content }) => Buffer.byteLength(content) <= 18_000));
});

test('a closing frame that fails stays on its stream, so the text is not stranded', async () => {
  let closings = 0;
  const { stream, frames, advance } = setup({
    answer({ finish }) {
      if (!finish) return 0;
      closings += 1;
      return closings === 1 ? 500 : 0;
    },
  });
  stream.update({ body: '第一段\n\n第二段' });
  await advance(5 * MINUTE + 10 * SECOND);
  const opened = [...new Set(frames.map(({ streamId }) => streamId))];
  assert.deepEqual(opened, ['s1', 's2']);
  assert.ok(frames.filter(({ finish, streamId }) => finish && streamId === 's1').length >= 2);
});

test('text is split at a paragraph, else a line, else where the bytes run out', () => {
  assert.deepEqual(splitBody('一\n\n二\n三', 100), { head: '一', rest: '二\n三' });
  assert.deepEqual(splitBody('一\n二', 100), { head: '一', rest: '二' });
  assert.deepEqual(splitBody('一二', 100), { head: '一二', rest: '' });
  assert.deepEqual(splitBody('一二三', 7), { head: '一二', rest: '三' });
});

test('a final frame goes out at once, on the same stream, and resolves on its answer', async () => {
  const { stream, frames, advance, ack, last } = setup({ auto: false });
  await ack();
  await advance(SECOND);
  const finishing = stream.finish('终稿');
  await advance(0);
  assert.deepEqual(last(), { reqId: 'req', streamId: 's1', finish: true, content: '终稿' });
  let settled = false;
  void finishing.then(() => {
    settled = true;
  });
  await advance(0);
  assert.equal(settled, false);
  await ack();
  assert.equal(await finishing, 'delivered');
  assert.equal(frames.length, 2);
  assert.notEqual(stream.endedAt, undefined);
});

test('a final waits for the frame in flight, and nothing follows it', async () => {
  const { stream, frames, advance, ack, last } = setup({ auto: false });
  const finishing = stream.finish('终稿');
  await advance(0);
  assert.equal(frames.length, 1);
  await ack();
  assert.equal(last().finish, true);
  await ack();
  assert.equal(await finishing, 'delivered');
  stream.update({ body: '迟到' });
  await advance(MINUTE);
  assert.equal(frames.length, 2);
});

test('a version conflict counts as delivered', async () => {
  const { stream, advance } = setup({ answer: ({ finish }) => (finish ? 6000 : 0) });
  await advance(0);
  assert.equal(await stream.finish('终稿'), 'delivered');
});

test('an expired stream hands the final back at once, without a retry', async () => {
  for (const code of [846608, 846604]) {
    const { stream, frames, advance } = setup({ answer: ({ finish }) => (finish ? code : 0) });
    await advance(0);
    assert.equal(await stream.finish('终稿'), 'fallback');
    assert.equal(frames.filter(({ finish }) => finish).length, 1);
  }
});

test('other failures retry on the same stream three times, half a second apart, then fall back', async () => {
  const { stream, frames, advance } = setup({ answer: ({ finish }) => (finish ? 500 : 0) });
  await advance(0);
  const finishing = stream.finish('终稿');
  await advance(0);
  assert.equal(frames.filter(({ finish }) => finish).length, 1);
  await advance(499);
  assert.equal(frames.filter(({ finish }) => finish).length, 1);
  await advance(1);
  assert.equal(frames.filter(({ finish }) => finish).length, 2);
  await advance(SECOND);
  assert.equal(await finishing, 'fallback');
  const finals = frames.filter(({ finish }) => finish);
  assert.equal(finals.length, 4);
  assert.ok(finals.every(({ streamId, content }) => streamId === 's1' && content === '终稿'));
});

test('a final that times out is retried like any other failure', async () => {
  const { stream, frames, advance } = setup({ answer: ({ finish }, index) => (finish && index === 1 ? undefined : 0) });
  await advance(0);
  const finishing = stream.finish('终稿');
  await advance(15 * SECOND + 500);
  assert.equal(await finishing, 'delivered');
  assert.equal(frames.filter(({ finish }) => finish).length, 2);
});

test('a final equal to the last frame gets a zero-width space, or WeCom drops it', async () => {
  const { stream, advance, last } = setup();
  await advance(SECOND);
  stream.update({ body: '终稿' });
  await advance(0);
  assert.equal(last().content, '终稿');
  assert.equal(await stream.finish('终稿'), 'delivered');
  assert.equal(last().content, `终稿${ZWSP}`);
});

test('a final that repeats the first answer without a second frame', async () => {
  const { stream, frames, advance } = setup();
  await advance(0);
  assert.equal(await stream.finish('终稿'), 'delivered');
  const count = frames.length;
  assert.equal(await stream.finish('终稿'), 'delivered');
  assert.equal(frames.length, count);
});

test('a final with nothing visible is given something visible', async () => {
  const { stream, advance, last } = setup();
  await advance(0);
  await stream.finish('  \n');
  assert.match(last().content, /\S/);
  assert.doesNotMatch(last().content, /think/);
});

test('tool lines stay on the final, the queue note does not', async () => {
  const { stream, advance, last } = setup();
  stream.update({ queue: '排队中，前面还有 1 条' });
  stream.tool({ name: 'a', phase: 'start', isError: false });
  stream.tool({ name: 'a', phase: 'end', isError: false });
  await advance(0);
  await stream.finish('终稿');
  assert.equal(last().content, '<think>调用 a…完成</think>\n\n终稿');
});

test('after a rotation the final shows what follows the cut, even when it is not an extension', async () => {
  const { stream, advance, last } = setup();
  stream.update({ body: '第一段\n\n第二段' });
  await advance(5 * MINUTE + SECOND);
  assert.equal(await stream.finish('第一段\n\n第二段，定稿'), 'delivered');
  assert.equal(last().streamId, 's2');
  assert.equal(last().content, '<think>接上一条继续</think>\n\n第二段，定稿');

  const other = setup();
  other.stream.update({ body: '第一段\n\n第二段' });
  await other.advance(5 * MINUTE + SECOND);
  assert.equal(await other.stream.finish('只有最后这句'), 'delivered');
  assert.match(other.last().content, /只有最后这句$/);
});

test('a final with nothing left after the cut says so instead of ending blank', async () => {
  const { stream, advance, last } = setup();
  stream.update({ body: '全部\n\n' });
  await advance(5 * MINUTE + SECOND);
  await stream.finish('全部\n\n');
  assert.equal(last().finish, true);
  assert.match(last().content.replace(/<think>.*<\/think>/s, ''), /\S/);
});

test('a final too long for one frame is spread over streams and ends on the last', async () => {
  const text = `${'甲'.repeat(4000)}\n\n${'乙'.repeat(4000)}\n\n${'丙'.repeat(4000)}`;
  const { stream, frames, advance } = setup();
  await advance(0);
  assert.equal(await stream.finish(text), 'delivered');
  const finals = frames.filter(({ finish }) => finish);
  assert.deepEqual(finals.map(({ streamId }) => streamId), ['s1', 's2', 's3']);
  assert.equal(finals.map(({ content }) => content.replace(/<think>.*<\/think>\n\n/s, '')).join('\n\n'), text);
  assert.ok(finals.every(({ content }) => Buffer.byteLength(content) <= 18_000));
});

test('a refused intermediate frame on an expired stream stops the stream', async () => {
  const { stream, frames, advance } = setup({ answer: (_frame, index) => (index === 1 ? 846608 : 0) });
  await advance(SECOND);
  stream.update({ body: '一' });
  await advance(MINUTE);
  assert.equal(frames.length, 2);
  assert.equal(await stream.finish('终稿'), 'fallback');
  assert.equal(frames.length, 2);
  assert.notEqual(stream.endedAt, undefined);
});

test('a stream past six minutes is not written to', async () => {
  const { stream, frames, advance } = setup();
  stream.pause();
  await advance(6 * MINUTE);
  const count = frames.length;
  assert.equal(await stream.finish('终稿'), 'fallback');
  assert.equal(frames.length, count);
});

test('a dropped connection voids the frame in flight; the reconnect sends the newest snapshot', async () => {
  const { stream, frames, advance, ack, last } = setup({ auto: false });
  await ack();
  await advance(SECOND);
  stream.update({ body: '一' });
  await advance(0);
  assert.equal(frames.length, 2);
  stream.pause();
  stream.update({ body: '一二' });
  await advance(10 * SECOND);
  assert.equal(frames.length, 2);
  // The voided frame's answer never comes; this one is the reconnect's.
  stream.resume();
  await advance(0);
  assert.equal(frames.length, 3);
  assert.equal(last().content, '一二');
  assert.equal(last().streamId, 's1');
});

test('the reconnect resends even when the snapshot has not changed', async () => {
  const { stream, frames, advance } = setup();
  await advance(SECOND);
  stream.update({ body: '一' });
  await advance(SECOND);
  const count = frames.length;
  stream.pause();
  await advance(SECOND);
  stream.resume();
  await advance(0);
  assert.equal(frames.length, count + 1);
});

test('a reconnect past six minutes marks the stream expired and sends nothing', async () => {
  const { stream, frames, advance } = setup();
  await advance(SECOND);
  stream.pause();
  await advance(6 * MINUTE);
  const count = frames.length;
  stream.resume();
  await advance(0);
  assert.equal(frames.length, count);
  assert.notEqual(stream.endedAt, undefined);
  assert.equal(await stream.finish('终稿'), 'fallback');
});

test('a final caught by a dropped connection is retried, and resolves once it gets through', async () => {
  const { stream, frames, advance, ack } = setup({ auto: false });
  await ack();
  await advance(SECOND);
  const finishing = stream.finish('终稿');
  await advance(0);
  stream.pause();
  stream.resume();
  await advance(500);
  assert.equal(frames.filter(({ finish }) => finish).length, 2);
  await ack();
  await advance(0);
  await ack();
  assert.equal(await finishing, 'delivered');
});

test('closing a stream settles a final at once, in flight or between retries', async () => {
  const { stream, advance } = setup({ auto: false });
  const finishing = stream.finish('终稿');
  await advance(0);
  stream.close();
  assert.equal(await finishing, 'fallback');

  const retrying = setup({ answer: ({ finish }) => (finish ? 500 : 0) });
  await retrying.advance(0);
  const second = retrying.stream.finish('终稿');
  await retrying.advance(100);
  retrying.stream.close();
  assert.equal(await second, 'fallback');
});

test('over the rate limit no stream opens and the final is left to the push', async () => {
  const { stream, frames, advance } = setup({ mayOpen: () => false });
  stream.update({ body: '一' });
  await advance(MINUTE);
  assert.deepEqual(frames, []);
  assert.equal(await stream.finish('终稿'), 'fallback');
  assert.deepEqual(frames, []);
});

test('a rotation refused by the rate limit ends the stream with its text in place', async () => {
  let opens = 0;
  const { stream, frames, advance } = setup({
    mayOpen: () => {
      opens += 1;
      return opens === 1;
    },
  });
  stream.update({ body: '第一段\n\n第二段' });
  await advance(5 * MINUTE + 10 * SECOND);
  assert.deepEqual([...new Set(frames.map(({ streamId }) => streamId))], ['s1']);
  assert.equal(await stream.finish('定稿'), 'fallback');
});

test('intermediate frames do not count against the limit, only each new stream does', async () => {
  let opens = 0;
  const { stream, advance } = setup({
    mayOpen: () => {
      opens += 1;
      return true;
    },
  });
  for (let index = 0; index < 20; index += 1) {
    stream.update({ body: '字'.repeat(index + 1) });
    await advance(SECOND);
  }
  assert.equal(opens, 1);
});

test('a reply that never comes ends the stream after an hour, instead of rotating for ever', async () => {
  const { stream, frames, advance } = setup();
  await advance(61 * MINUTE);
  const bubbles = new Set(frames.map(({ streamId }) => streamId)).size;
  assert.ok(bubbles <= 12, `开了 ${bubbles} 条`);
  assert.notEqual(stream.endedAt, undefined);
  const count = frames.length;
  await advance(10 * MINUTE);
  assert.equal(frames.length, count);
  assert.equal(frames.at(-1)!.finish, true);
  assert.equal(await stream.finish('终稿'), 'fallback');
});

test('composing puts think first and paired, keeps eight tool lines, and is never blank', () => {
  assert.equal(compose({}), '<think></think>');
  assert.equal(compose({ body: ' \n ' }), '<think></think>');
  assert.equal(compose({ body: '正文' }), '正文');
  assert.equal(compose({ queue: '排队', body: ' ' }), '<think>排队</think>');
  const content = compose({
    queue: '排队',
    tools: Array.from({ length: 12 }, (_, index) => `工具 ${index}`),
    elapsed: '已运行 3 秒',
    body: '正文',
  });
  assert.ok(content.startsWith('<think>排队\n工具 4\n'));
  assert.ok(content.endsWith('工具 11\n已运行 3 秒</think>\n\n正文'));
  assert.equal(content.match(/工具/g)!.length, 8);
});

test('think tags in the text itself cannot open a block', () => {
  const content = compose({ tools: ['调用 a…'], body: '解释 <think> 和 </think> 标签' });
  assert.equal(content.match(/<think>/g)!.length, 1);
  assert.equal(content.match(/<\/think>/g)!.length, 1);
  assert.ok(content.startsWith('<think>'));
});

test('the tool list keeps the eight latest, and an end finds its own start', async () => {
  const { stream, advance, last } = setup();
  await advance(0);
  for (let index = 0; index < 10; index += 1) stream.tool({ name: `t${index}`, phase: 'start', isError: false });
  stream.tool({ name: 't9', phase: 'end', isError: false });
  stream.tool({ name: 't8', phase: 'end', isError: true });
  await advance(2 * SECOND);
  assert.doesNotMatch(last().content, /t1…/);
  assert.match(last().content, /调用 t2…\n/);
  assert.match(last().content, /调用 t8…失败\n调用 t9…完成<\/think>/);
});

test('the running time reads in minutes past the first', () => {
  assert.equal(elapsedText(45_000), '已运行 45 秒');
  assert.equal(elapsedText(80_500), '已运行 1 分 20 秒');
});
