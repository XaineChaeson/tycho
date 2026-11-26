// Guards the console's hold on the service while it is open: a broken stream retried in
// a tight loop or never again (the wait doubles from 1 second to 30 and starts over once
// a snapshot is read), a reconnect that keeps showing what it had instead of reading the
// snapshot again, an event that arrives while a snapshot is being read applied to the
// older picture and then overwritten by it, a reply's first words lost because no row
// for it has been pushed yet, a finished reply overwritten by a late draft, a sent
// message shown twice or shown as pending for ever when its event never comes, the
// "since you last opened" count read after the snapshot that resets it, an expired
// login going unnoticed behind a stream that only says "error", and a second console
// (React's double start in development) left listening after it was stopped. Across
// connections: a snapshot asked for by a connection that has since broken coming back
// late and putting its older picture over what the next connection already shows (a
// finished reply turned back into a half-written one, a turn that is over shown as at
// work again), or its return letting out the events the next connection holds back for
// its own snapshot; a list that connection asked for landing in the side column after
// the newer one; the browser's own reconnect of a broken stream running beside the
// console's, so that there are two; and a change made between a page's first read and
// the stream being opened, which no one was listening for, never reaching the page.
// And the text typed to the Router: lost when it is refused, or sent twice. And what keeps
// the rest fresh: a change the ledger committed left unread until a poll comes round, a burst
// of changes read again once per change, a conversation read again turn by turn (one read
// per request), a conversation shown again starting from nothing, and walking from one
// conversation to another reading every list of the console again.
import { QueryClient } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { session } from './api.ts';
import { processing } from './conversation.ts';
import { createLive } from './live.ts';
import type { Message } from './types.ts';
import { deferred, FakeEventSource, refusal, serve, sources, type Handler } from '@/test/harness';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const inbound = (id: string, text: string, state = 'processed'): Message => ({ id, direction: 'in', channel: 'console', external_id: `x-${id}`, text, state });

function fixture(handler: Handler = () => undefined) {
  FakeEventSource.autoOpen = false;
  const service = serve(handler);
  const timers: { fn: () => void; delay: number }[] = [];
  // Reads again waiting for a burst of changes to be over.
  const gathered: (() => void)[] = [];
  let clock = 1000;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const live = createLive({
    client,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    now: () => clock,
    gather: (fn) => { gathered.push(fn); return gathered.length; },
  });
  // The conversation in view: project p1, its segment s1 (docs/design/project-sessions.md §1).
  live.focusOn({ project: 'p1', segment: 's1' });
  const stream = (): FakeEventSource => sources.at(-1)!;
  return {
    ...service, live, client, timers, stream, gathered,
    // The burst is over: what was changed is read again.
    gather() { for (const fn of gathered.splice(0)) fn(); },
    advance: (ms: number) => { clock += ms; },
    // The stream connects, and the snapshot it prompts is read.
    async connected() { stream().open(); await tick(); },
    async started() { live.start(); await tick(); },
    // The wait is over: the console tries again.
    async fire() { timers.shift()!.fn(); await tick(); },
    // The owner types a text and sends it.
    say(text: string) { live.type(text); return live.send(); },
    texts: () => [...live.getState().messages.values()].map((row) => row.text),
  };
}

test('the count of what happened while away is read before the snapshot that resets it', async () => {
  const f = fixture((call) => (call.path === '/api/summary' ? { delivered: 2, running: 0, waiting: 1 } : undefined));
  await f.started();
  expect(f.reads).toEqual(['/api/summary']);
  expect(f.live.getState().summary).toBe('上次打开以来：交付 2 件，1 件等你决定');
  await f.connected();
  expect(f.reads[1]).toBe('/api/messages?segment=s1&limit=50');
  expect(f.live.getState().connected).toBe(true);
});

test('a summary that cannot be read is said, and the console connects all the same', async () => {
  const f = fixture((call) => { if (call.path === '/api/summary') throw refusal('读不到', 500); return undefined; });
  await f.started();
  expect(f.live.getState().error).toBe('读不到');
  await f.connected();
  expect(f.live.getState().connected).toBe(true);
});

test('the snapshot holds the conversation and what each turn committed, in one read, and nothing for a message never taken up', async () => {
  const f = fixture((call) => {
    if (call.path === '/api/messages?segment=s1&limit=50') {
      return { messages: [inbound('01', '建任务'), inbound('02', '排着的', 'received'), inbound('03', '什么也没做')], changes: { '01': { changes: [{ action: 'task.create', at: 'x' }], tasks: [{ id: 't', title: '探针', state: 'queued' }] } } };
    }
    return undefined;
  });
  await f.started();
  await f.connected();
  expect(f.texts()).toEqual(['建任务', '排着的', '什么也没做']);
  expect(f.live.getState().changes.get('01')!.tasks).toHaveLength(1);
  // A turn the answer names nothing for changed nothing.
  expect(f.live.getState().changes.get('03')).toEqual({ changes: [], tasks: [] });
  expect(f.live.getState().changes.has('02')).toBe(false);
  expect(f.reads.filter((path) => path.endsWith('/changes'))).toEqual([]);
  expect(f.live.getState().lastUpdate).toBe(1000);
});

test('a broken stream is retried after 1 second, then twice as long each time up to 30, and from 1 again once a snapshot is read', async () => {
  const f = fixture();
  await f.started();
  const delays: number[] = [];
  for (let round = 0; round < 7; round += 1) {
    const broken = f.stream();
    broken.fail();
    expect(broken.closed).toBe(true);
    expect(f.live.getState().connected).toBe(false);
    expect(f.timers).toHaveLength(1);
    delays.push(f.timers[0]!.delay);
    await f.fire();
    expect(f.stream()).not.toBe(broken);
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  await f.connected();
  expect(f.live.getState().connected).toBe(true);
  f.stream().fail();
  expect(f.timers[0]!.delay).toBe(1000);
});

test('one break schedules one retry, however many times the stream says so', async () => {
  const f = fixture();
  await f.started();
  const broken = f.stream();
  broken.fail();
  broken.fail();
  expect(f.timers).toHaveLength(1);
});

test('after a break the snapshot is read again: what the service has replaces what the page had, and the page in view reads again too', async () => {
  let rows = [inbound('01', '断线前')];
  const f = fixture((call) => (call.path === '/api/messages?segment=s1&limit=50' ? { messages: rows } : undefined));
  const refreshed = vi.spyOn(f.client, 'invalidateQueries');
  await f.started();
  await f.connected();
  expect(f.texts()).toEqual(['断线前']);
  // The first snapshot too: the page's own read came before anyone was listening.
  f.gather();
  expect(refreshed).toHaveBeenCalledTimes(1);
  f.advance(60_000);
  f.stream().fail();
  expect(f.live.getState()).toMatchObject({ connected: false, lastUpdate: 1000 });
  rows = [inbound('01', '断线前'), inbound('02', '断线期间来的')];
  await f.fire();
  await f.connected();
  expect(f.texts()).toEqual(['断线前', '断线期间来的']);
  expect(f.live.getState()).toMatchObject({ connected: true, lastUpdate: 61_000 });
  f.gather();
  expect(refreshed).toHaveBeenCalledTimes(2);
});

const reply = (id: string, to: string, text: string, final: number): Message => ({ id, direction: 'out', external_id: `reply:${to}`, text, state: null, final });
// Each read of the conversation waits for the test to answer it, oldest first.
function gatedSnapshots() {
  const gates: ReturnType<typeof deferred<{ messages: Message[] }>>[] = [];
  const handler: Handler = (call) => {
    if (call.path !== '/api/messages?segment=s1&limit=50') return undefined;
    gates.push(deferred());
    return gates.at(-1)!.promise;
  };
  return { gates, handler };
}

test('a snapshot asked for by a connection that broke comes back after the next connection shows the finished reply: it is dropped whole', async () => {
  const { gates, handler } = gatedSnapshots();
  const f = fixture(handler);
  await f.started();
  // Connection A asks for its snapshot, and breaks before the answer.
  f.stream().open();
  await tick();
  expect(gates).toHaveLength(1);
  f.stream().fail();
  // Connection B reads the reply as it was finished.
  await f.fire();
  f.stream().open();
  await tick();
  gates[1]!.resolve({ messages: [inbound('01', '问', 'processed'), reply('02', '01', '写完了。', 1)] });
  await tick();
  expect(f.live.getState().connected).toBe(true);
  f.gather();
  const refreshed = vi.spyOn(f.client, 'invalidateQueries');
  // A's answer, from when the reply was half written.
  gates[0]!.resolve({ messages: [inbound('01', '问', 'processing'), reply('02', '01', '写到一', 0)] });
  await tick();
  expect(f.live.getState().messages.get('02')).toMatchObject({ text: '写完了。', final: 1 });
  // What the page calls "负责人在处理".
  expect(processing(f.live.getState().messages.values())).toBeUndefined();
  expect(f.live.getState().connected).toBe(true);
  // Nor does it have the lists read again: they would be read for a connection that is over.
  f.gather();
  expect(refreshed).not.toHaveBeenCalled();
});

test('the late return of an earlier connection\'s snapshot lets out nothing the next connection holds back for its own', async () => {
  const { gates, handler } = gatedSnapshots();
  const f = fixture(handler);
  await f.started();
  f.stream().open();
  await tick();
  f.stream().fail();
  await f.fire();
  f.stream().open();
  await tick();
  // Pushed to B while B's snapshot is read: newer than what that read will bring.
  f.stream().emit('message', inbound('01', '问', 'processed'));
  gates[0]!.resolve({ messages: [] });
  await tick();
  expect(f.texts(), '上一轮的读取回来，把这一轮压着的事件放了出去').toEqual([]);
  gates[1]!.resolve({ messages: [inbound('01', '问', 'processing')] });
  await tick();
  expect([...f.live.getState().messages.values()].map((row) => row.state)).toEqual(['processed']);
  expect(f.live.getState().connected).toBe(true);
});

test('a stream that broke is closed before the console connects again: the browser\'s own reconnect never runs beside it', async () => {
  const f = fixture();
  await f.started();
  await f.connected();
  const broken = f.stream();
  broken.fail();
  await f.fire();
  expect(f.stream()).not.toBe(broken);
  // What a browser does with a broken stream nobody closed: connects it again.
  broken.open();
  await f.connected();
  expect(sources.filter((source) => !source.closed)).toEqual([f.stream()]);
  expect(f.reads.filter((path) => path === '/api/messages?segment=s1&limit=50'), '两条连接各读了一遍快照').toHaveLength(2);
});

test('a snapshot that cannot be read says why, asks what state the service is in, and tries again', async () => {
  let down = true;
  const f = fixture((call) => { if (down && call.path === '/api/messages?segment=s1&limit=50') throw refusal('账本不可用', 503); return undefined; });
  await f.started();
  await f.connected();
  expect(f.live.getState()).toMatchObject({ connected: false, error: '账本不可用' });
  expect(f.timers.map(({ delay }) => delay)).toEqual([1000]);
  down = false;
  await f.fire();
  await f.connected();
  expect(f.live.getState().connected).toBe(true);
});

test('an expired login is noticed on the retry: the stream itself only says "error"', async () => {
  const f = fixture((call) => { if (call.path === '/api/state') throw refusal('需要登录', 401); return undefined; });
  await f.started();
  f.stream().fail();
  expect(session.toLogin).not.toHaveBeenCalled();
  await f.fire();
  expect(session.toLogin).toHaveBeenCalled();
});

test('an event that arrives while the snapshot is read waits for it, and is then applied on top', async () => {
  const gate = deferred<{ messages: Message[] }>();
  const f = fixture((call) => (call.path === '/api/messages?segment=s1&limit=50' ? gate.promise : undefined));
  await f.started();
  f.stream().open();
  await tick();
  // Pushed while the read is on its way: newer than what the read will bring.
  f.stream().emit('message', inbound('01', '问', 'processed'));
  expect(f.texts()).toEqual([]);
  gate.resolve({ messages: [inbound('01', '问', 'processing')] });
  await tick();
  expect([...f.live.getState().messages.values()].map((row) => row.state)).toEqual(['processed']);
});

test('a reply shows from its first words, grows as it is written, and its last word stands', async () => {
  const f = fixture((call) => (call.path === '/api/messages?segment=s1&limit=50' ? { messages: [inbound('01', '问', 'processing')] } : undefined));
  await f.started();
  await f.connected();
  f.stream().emit('delta', { message_id: '02', text: '好', reply_to: '01', project_id: 'p1', segment_id: 's1' });
  expect(f.live.getState().messages.get('02')).toMatchObject({ direction: 'out', external_id: 'reply:01', text: '好', final: 0 });
  f.stream().emit('delta', { message_id: '02', text: '好的，我来', reply_to: '01', project_id: 'p1', segment_id: 's1' });
  expect(f.live.getState().messages.get('02')!.text).toBe('好的，我来');
  f.stream().emit('message', { id: '02', direction: 'out', external_id: 'reply:01', text: '好的，我来办。', state: null, final: 1 });
  // A draft that was on its way when the reply was finished changes nothing.
  f.stream().emit('delta', { message_id: '02', text: '好的，我', reply_to: '01', project_id: 'p1', segment_id: 's1' });
  expect(f.live.getState().messages.get('02')).toMatchObject({ text: '好的，我来办。', final: 1 });
});

test('what was sent shows as pending until the ledger shows it back, and is then shown once', async () => {
  const answer = deferred<{ id: string }>();
  const f = fixture((call) => (call.path === '/api/messages' && call.method === 'POST' ? answer.promise : undefined));
  await f.started();
  await f.connected();
  const sent = f.say('你好');
  expect(f.live.getState().sending).toBe('你好');
  // A second send while the first is on its way is not taken.
  expect(await f.say('再来')).toBe(false);
  answer.resolve({ id: '01' });
  expect(await sent).toBe(true);
  expect(f.live.getState().sending).toBe('你好');
  f.stream().emit('message', inbound('01', '你好', 'received'));
  expect(f.live.getState().sending).toBeNull();
  expect(f.texts()).toEqual(['你好']);
  expect(f.calls).toEqual([{ path: '/api/messages', method: 'POST', body: { text: '你好', project_id: 'p1' } }]);
});

test('the event can beat the answer to the send, and with no stream it never comes: neither leaves the message pending', async () => {
  const answer = deferred<{ id: string }>();
  const f = fixture((call) => (call.method === 'POST' ? answer.promise : undefined));
  await f.started();
  await f.connected();
  const early = f.say('先到的事件');
  f.stream().emit('message', inbound('01', '先到的事件', 'received'));
  // The service publishes the row before it answers the send, so this is the usual
  // order in a browser: from here on the row stands for the message, and showing the
  // pending one beside it would show it twice.
  expect(f.live.getState().sending).toBeNull();
  expect(f.texts()).toEqual(['先到的事件']);
  answer.resolve({ id: '01' });
  await early;
  expect(f.live.getState().sending).toBeNull();

  // Somebody else's message arriving while the send is on its way is not taken for it.
  const other = deferred<{ id: string }>();
  const busy = fixture((call) => (call.method === 'POST' ? other.promise : undefined));
  await busy.started();
  await busy.connected();
  const mine = busy.say('我发的');
  busy.stream().emit('message', { ...inbound('05', '我发的', 'received'), channel: 'wecom' });
  busy.stream().emit('message', inbound('06', '别的话', 'received'));
  expect(busy.live.getState().sending).toBe('我发的');
  other.resolve({ id: '07' });
  await mine;
  expect(busy.live.getState().sending).toBe('我发的');
  busy.stream().emit('message', inbound('07', '我发的', 'received'));
  expect(busy.live.getState().sending).toBeNull();

  const offline = fixture((call) => (call.method === 'POST' ? { id: '09' } : undefined));
  await offline.started();
  expect(await offline.say('没有流')).toBe(true);
  expect(offline.live.getState().sending).toBeNull();
});

test('a stream that breaks while a message waits for its event stops waiting: the snapshot will show it', async () => {
  const f = fixture((call) => (call.method === 'POST' ? { id: '01' } : undefined));
  await f.started();
  await f.connected();
  await f.say('发出去了');
  expect(f.live.getState().sending).toBe('发出去了');
  f.stream().fail();
  expect(f.live.getState().sending).toBeNull();
});

test('a message the service refuses is not pending, and its reason is said', async () => {
  const f = fixture((call) => { if (call.method === 'POST') throw refusal('账本不可用，服务处于降级模式', 503); return undefined; });
  await f.started();
  await f.connected();
  expect(await f.say('发不出去')).toBe(false);
  // The text is the draft again, with why.
  expect(f.live.getState()).toMatchObject({ sending: null, draft: '发不出去', refused: '账本不可用，服务处于降级模式' });
  // Typing over it lets the reason go.
  f.live.type('发不出去的');
  expect(f.live.getState()).toMatchObject({ draft: '发不出去的', refused: null });
  expect(await f.say('   ')).toBe(false);
  expect(f.calls).toHaveLength(1);
});

test('a text begun while another is being sent is kept when that one is refused: both are in the draft', async () => {
  const answer = deferred<{ id: string }>();
  const f = fixture((call) => (call.method === 'POST' ? answer.promise : undefined));
  await f.started();
  await f.connected();
  const sent = f.say('第一句');
  expect(f.live.getState()).toMatchObject({ sending: '第一句', draft: '' });
  // From another page: "在负责人里谈这项工作".
  f.live.type('关于工作 甲：');
  answer.reject(refusal('账本不可用', 503));
  expect(await sent).toBe(false);
  expect(f.live.getState()).toMatchObject({ sending: null, draft: '第一句\n关于工作 甲：', refused: '账本不可用' });
});

test('a task that changes state shows at once in the capsule under its turn; the lists wait for the change the ledger tells of', async () => {
  const f = fixture((call) => {
    if (call.path === '/api/messages?segment=s1&limit=50') return { messages: [inbound('01', '建任务')], changes: { '01': { changes: [{ action: 'task.create', at: 'x' }], tasks: [{ id: 't', title: '探针', state: 'queued' }] } } };
    return undefined;
  });
  await f.started();
  await f.connected();
  f.gather();
  const refreshed = vi.spyOn(f.client, 'invalidateQueries');
  f.stream().emit('task', { id: 't', state: 'running' });
  expect(f.live.getState().changes.get('01')!.tasks).toEqual([{ id: 't', title: '探针', state: 'running' }]);
  expect(f.gathered).toHaveLength(0);
  f.stream().emit('changed', {});
  f.gather();
  expect(refreshed).toHaveBeenCalledTimes(1);
});

test('a turn that ends has its changes read, and the work and the questions with the change the ledger tells of', async () => {
  const f = fixture((call) => (call.path === '/api/messages/01/changes' ? { changes: [{ action: 'task.create', at: 'x' }], tasks: [] } : undefined));
  await f.started();
  await f.connected();
  f.gather();
  const refreshed = vi.spyOn(f.client, 'invalidateQueries');
  f.stream().emit('message', inbound('01', '建任务', 'processed'));
  await tick();
  expect(f.live.getState().changes.get('01')!.changes).toHaveLength(1);
  f.stream().emit('changed', {});
  f.gather();
  expect(refreshed).toHaveBeenCalledTimes(1);
});

test('a console that was stopped listens to nothing and tries nothing again', async () => {
  const f = fixture();
  f.live.start();
  f.live.stop();
  await tick();
  // Started and stopped before its first read came back: no stream is ever opened.
  expect(sources).toHaveLength(0);
  await f.started();
  const stream = f.stream();
  f.live.stop();
  expect(stream.closed).toBe(true);
  stream.fail();
  expect(f.timers).toHaveLength(0);
});

// docs/design/project-sessions.md §1, §2: a message goes to the project in view, and what was
// typed to one project's Router is not in another's box.
test('each project keeps its own draft, and a send goes to the project in view', async () => {
  const f = fixture();
  await f.started();
  await f.connected();
  f.live.type('给甲的');
  f.live.focusOn({ project: 'p2', segment: null });
  expect(f.live.getState().draft).toBe('');
  f.live.type('给乙的');
  await f.live.send();
  expect(f.calls.at(-1)).toEqual({ path: '/api/messages', method: 'POST', body: { text: '给乙的', project_id: 'p2' } });
  f.live.focusOn({ project: 'p1', segment: 's1' });
  expect(f.live.getState().draft).toBe('给甲的');
  f.live.focusOn(null);
  f.live.type('哪儿也不去');
  expect(await f.live.send()).toBe(false);
  expect(f.live.getState().refused).toMatch(/要在一个项目的页面里/);
});

// Review of step 1: several projects stream at once. A draft says which request it answers, and
// in which project and segment; nothing is guessed from whichever message is being handled.
test('drafts of two projects written at once each go under their own request', async () => {
  const f = fixture((call) => (call.path === '/api/messages?segment=s1&limit=50'
    ? { messages: [inbound('a1', '甲问', 'processing'), { ...inbound('b1', '乙问', 'processing'), project_id: 'p2', segment_id: 's9' }] }
    : undefined));
  await f.started();
  await f.connected();
  f.stream().emit('delta', { message_id: 'b-reply', text: '乙的草稿', reply_to: 'b1', project_id: 'p2', segment_id: 's9' });
  f.stream().emit('delta', { message_id: 'a-reply', text: '甲的草稿', reply_to: 'a1', project_id: 'p1', segment_id: 's1' });
  expect(f.live.getState().messages.get('b-reply')).toMatchObject({ external_id: 'reply:b1', project_id: 'p2', segment_id: 's9', text: '乙的草稿' });
  expect(f.live.getState().messages.get('a-reply')).toMatchObject({ external_id: 'reply:a1', project_id: 'p1', segment_id: 's1', text: '甲的草稿' });
});

// docs/design/console.md, 数据怎么保持新: one word from the service that the ledger changed,
// and what is on screen is read again, once for a burst.
test('a change the ledger committed has what is on screen read again, once for a burst of them', async () => {
  const f = fixture();
  await f.started();
  await f.connected();
  f.gather();
  const refreshed = vi.spyOn(f.client, 'invalidateQueries');
  f.stream().emit('changed', {});
  f.stream().emit('changed', {});
  f.stream().emit('changed', {});
  expect(refreshed).not.toHaveBeenCalled();
  expect(f.gathered).toHaveLength(1);
  f.gather();
  expect(refreshed).toHaveBeenCalledTimes(1);
  // The next burst is read again too.
  f.stream().emit('changed', {});
  f.gather();
  expect(refreshed).toHaveBeenCalledTimes(2);
});

// Review: rows the console read while no conversation was in view, or another one was, belong to
// no conversation that comes into view after; and a project whose queue gets its first segment
// is still the same conversation.
test('a conversation comes into view with none of the rows read for the overview or for another conversation', async () => {
  const f = fixture((call) => (call.path === '/api/messages?limit=50' ? { messages: [{ ...inbound('x', '等归属的'), project_id: null, segment_id: null }] }
    : call.path === '/api/messages?segment=s2&limit=50' ? { messages: [{ ...inbound('02', '乙的'), project_id: 'p2', segment_id: 's2' }] } : undefined));
  f.live.focusOn(null);
  await f.started();
  await f.connected();
  expect(f.live.getState().messages.size).toBe(0);
  f.live.focusOn({ project: 'p2', segment: 's2' });
  expect(f.live.getState().messages.size).toBe(0);
  await tick();
  expect(f.texts()).toEqual(['乙的']);
});

test('a project whose queue is given its first segment keeps what it shows while that segment is read', async () => {
  const f = fixture((call) => (call.path === '/api/messages?project=p3&limit=50' ? { messages: [{ ...inbound('01', '第一句', 'received'), project_id: 'p3', segment_id: null }] } : undefined));
  f.live.focusOn({ project: 'p3', segment: null });
  await f.started();
  await f.connected();
  expect(f.live.getState().loaded).toBe(true);
  f.live.focusOn({ project: 'p3', segment: 'new' });
  expect(f.live.getState()).toMatchObject({ loaded: true });
  expect(f.texts()).toEqual(['第一句']);
});

test('a conversation brought into view reads its own messages and nothing else, and one shown again starts from what was read', async () => {
  const f = fixture((call) => (call.path === '/api/messages?segment=s1&limit=50' ? { messages: [inbound('01', '甲的')] }
    : call.path === '/api/messages?segment=s2&limit=50' ? { messages: [{ ...inbound('02', '乙的'), project_id: 'p2', segment_id: 's2' }] } : undefined));
  await f.started();
  await f.connected();
  f.gather();
  expect(f.live.getState().loaded).toBe(true);
  const before = f.reads.length;
  const refreshed = vi.spyOn(f.client, 'invalidateQueries');
  f.live.focusOn({ project: 'p2', segment: 's2' });
  // Not read yet: the page shows the shape of what is coming, not the rows of the one before.
  expect(f.live.getState().loaded).toBe(false);
  await tick();
  expect(f.reads.slice(before)).toEqual(['/api/messages?segment=s2&limit=50']);
  expect(f.live.getState().loaded).toBe(true);
  f.gather();
  expect(refreshed).not.toHaveBeenCalled();
  // Back to the first: what was read of it is there at once, and read again behind it.
  f.live.focusOn({ project: 'p1', segment: 's1' });
  expect(f.live.getState().loaded).toBe(true);
  expect(f.live.getState().messages.get('01')!.text).toBe('甲的');
  await tick();
  // Leaving every conversation reads nothing.
  const left = f.reads.length;
  f.live.focusOn(null);
  await tick();
  expect(f.reads.slice(left)).toEqual([]);
});
