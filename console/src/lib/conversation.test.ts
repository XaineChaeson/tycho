// Guards what the conversation is made of: a reply drawn twice or away from the message
// it answers, an internal event showing its JSON payload, an ignored message (someone
// off the whitelist) showing at all, an unfinished request that does not list what it
// had committed, an open question dropped because it is older than the page of messages,
// a reply still being written marked as cut off, and the "since you last opened" line
// naming things that did not happen.
import { expect, test } from 'vitest';
import { conversationItems, dateLabel, dayKey, hasTurn, summaryLine } from './conversation.ts';
import type { Approval, Message, TurnChanges } from './types.ts';

const inbound = (id: string, text: string, more: Partial<Message> = {}): Message => ({ id, direction: 'in', channel: 'console', external_id: `x-${id}`, text, state: 'processed', ...more });
const reply = (id: string, to: string, text: string, final = 1): Message => ({ id, direction: 'out', external_id: `reply:${to}`, text, state: null, final });
const card = (id: string, state = 'open'): Approval => ({ id, task_id: 't', task_title: '任务', state, questions: [{ question: '选哪个？' }], answers: null, answered_via: null });
const items = (messages: Message[], more: { changes?: Map<string, TurnChanges>; approvals?: Approval[]; sending?: string | null } = {}) =>
  conversationItems({ messages, changes: more.changes ?? new Map(), approvals: more.approvals ?? [], sending: more.sending ?? null });
const shape = (list: ReturnType<typeof items>) => list.map((item) => [item.kind, 'text' in item ? item.text : item.key]);

test('each reply stands once, under the message it answers, in the order things happened', () => {
  const list = items([reply('04', '03', '第二个答复'), inbound('03', '第二句'), reply('02', '01', '第一个答复'), inbound('01', '第一句')]);
  expect(shape(list)).toEqual([['mine', '第一句'], ['reply', '第一个答复'], ['mine', '第二句'], ['reply', '第二个答复']]);
});

test('a reply whose message is not on the page, and one that answers nothing, still show', () => {
  const list = items([reply('02', 'gone', '没有上文的答复'), { id: '03', direction: 'out', external_id: 'notice:1', text: '通知', state: null, final: 1 }]);
  expect(shape(list)).toEqual([['reply', '没有上文的答复'], ['reply', '通知']]);
});

test('an internal event is one line: its sentence, with states in words and no payload', () => {
  const [note] = items([inbound('01', '任务“甲”的 Run 已结算，任务转为 ready\n{"task_id":"t","receipt":null}', { channel: 'internal' })]);
  expect(note).toEqual({ key: 'in:01', kind: 'note', text: '任务“甲”的 Run 已结算，任务转为 待验收' });
});

test('processed internal and trigger messages in a project can open the turn that used them', () => {
  const list = items([
    inbound('01', '内部事件', { channel: 'internal', project_id: 'p' }),
    inbound('02', '签名来源', { channel: 'trigger', project_id: 'p' }),
    inbound('03', '尚未处理', { channel: 'trigger', project_id: 'p', state: 'received' }),
  ]);
  expect(list).toEqual([
    { key: 'in:01', kind: 'note', text: '内部事件', messageId: '01' },
    { key: 'in:02', kind: 'note', text: '签名来源', messageId: '02' },
    { key: 'in:03', kind: 'note', text: '尚未处理' },
  ]);
});

// docs/design/triggers.md §6: a trigger's message is not the owner's words; its first line says
// which trigger it was, and its reply sits under it like any other.
test('a trigger\'s message is one line of the service, not the owner\'s bubble, with its reply under it', () => {
  const list = items([
    inbound('01', '触发器“早检”：原定 2030-01-02 08:00（Asia/Shanghai）的时刻到了\n这条消息来自触发器 tr1（修订 1），不是主人说的话。', { channel: 'trigger' }),
    reply('02', '01', '构建正常'),
  ]);
  expect(shape(list)).toEqual([['note', '触发器“早检”：原定 2030-01-02 08:00（Asia/Shanghai）的时刻到了'], ['reply', '构建正常']]);
});

test('a message from someone the service ignores is not part of the conversation', () => {
  expect(shape(items([inbound('01', '外人的话', { state: 'ignored' })]))).toEqual([['empty', 'empty']]);
});

test('an unfinished request lists what it had committed, says when it committed nothing, and that it is unknown while unread', () => {
  const changes = new Map([
    ['01', { changes: [{ action: 'task.create', at: '2026-11-05T00:00:00Z' }], tasks: [{ id: 't', title: '探针', state: 'queued' }] }],
    ['02', { changes: [], tasks: [] }],
  ]);
  const list = items([inbound('01', '建任务', { state: 'unverified' }), inbound('02', '再来', { state: 'unverified' }), inbound('03', '没读到', { state: 'unverified' })], { changes });
  expect(list.map(({ kind }) => kind)).toEqual(['mine', 'unverified', 'capsules', 'mine', 'unverified', 'mine', 'unverified']);
  expect(list[1]).toMatchObject({ changes: [{ action: 'task.create' }] });
  expect(list[4]).toMatchObject({ changes: [] });
  expect(list[6]).toMatchObject({ changes: null });
});

test('a reply is cut off only when its turn is over: one being written is not', () => {
  const written = (state: string) => items([inbound('01', '问', { state }), reply('02', '01', '写到一半', 0)])[1];
  expect(written('processing')).toMatchObject({ kind: 'reply', incomplete: false });
  expect(written('unverified')).toMatchObject({ kind: 'reply', incomplete: true });
  expect(items([inbound('01', '问'), reply('02', '01', '写完了', 1)])[1]).toMatchObject({ incomplete: false });
});

test('a question stands where it was asked, and one still open shows however old it is', () => {
  const list = items([inbound('05', '后来的话')], { approvals: [card('01'), card('02', 'answered'), card('06', 'answered')] });
  // 01 is older than the page but still open; 02 is older and settled; 06 came after.
  expect(shape(list)).toEqual([['card', 'card:01'], ['mine', '后来的话'], ['card', 'card:06']]);
});

test('what was just sent shows last until the ledger shows it back', () => {
  expect(shape(items([inbound('01', '早先')], { sending: '刚发的' }))).toEqual([['mine', '早先'], ['mine', '刚发的']]);
});

test('only a message the Router took up has a turn to read changes for', () => {
  expect(['received', 'ignored', 'processing', 'processed', 'unverified'].map((state) => hasTurn(inbound('01', 'x', { state })))).toEqual([false, false, true, true, true]);
  expect(hasTurn(reply('02', '01', 'y'))).toBe(false);
});

test('the line about the time away names only what happened', () => {
  expect(summaryLine({ delivered: 2, running: 1, waiting: 3 })).toBe('上次打开以来：交付 2 件，1 项在推进，3 件等你决定');
  expect(summaryLine({ delivered: 0, running: 1, waiting: 0 })).toBe('上次打开以来：1 项在推进');
  expect(summaryLine({ delivered: 0, running: 0, waiting: 0 })).toBe('');
});

test('a day between two days of a conversation, and none within one day', () => {
  const now = new Date('2026-11-06T12:00:00');
  expect(dateLabel('2026-11-06T09:00:00', now)).toBe('今天');
  expect(dateLabel('2026-11-05T23:59:00', now)).toBe('昨天');
  expect(dateLabel('2026-10-31T09:00:00', now)).toBe('2026 年 10 月 31 日');
  expect(dayKey('2026-11-06T23:30:00')).toBe(dayKey('2026-11-06T00:10:00'));
  expect(dayKey('2026-11-07T00:10:00')).not.toBe(dayKey('2026-11-06T23:30:00'));
});

test('messages of one day stand together; another day is told apart by a line', () => {
  const on = (dayOffset: number): string => {
    const at = new Date();
    at.setDate(at.getDate() + dayOffset);
    at.setHours(9, 0, 0, 0);
    return at.toISOString();
  };
  const list = items([
    inbound('01', '昨天的话', { created_at: on(-1) }),
    inbound('02', '今天的话', { created_at: on(0) }),
  ]);
  expect(list.map(({ kind }) => kind)).toEqual(['date', 'mine', 'date', 'mine']);
  const [first, , second] = list;
  expect(first).toMatchObject({ kind: 'date', text: '昨天' });
  expect(second).toMatchObject({ kind: 'date', text: '今天' });
  // A reply with no time of its own stays under the message it answers, in that day.
  const withReply = items([inbound('01', '问', { created_at: on(0) }), reply('02', '01', '答')]);
  expect(withReply.map(({ kind }) => kind)).toEqual(['date', 'mine', 'reply']);
});

test('replies after midnight stay under their question and date dividers never jump backward', () => {
  // Two questions asked before midnight, each answered just after it, followed by a message today:
  // paired replies keep their own timestamp without splitting the Q&A block or jumping back to "昨天".
  const at = (dayOffset: number, hours: number, minutes: number): string => {
    const when = new Date();
    when.setDate(when.getDate() + dayOffset);
    when.setHours(hours, minutes, 0, 0);
    return when.toISOString();
  };
  const list = items([
    inbound('01', '睡前问的', { created_at: at(-1, 23, 58) }),
    inbound('02', '接着又问', { created_at: at(-1, 23, 59) }),
    { ...reply('03', '01', '过了午夜才答'), created_at: at(0, 0, 1) },
    { ...reply('04', '02', '这条也是'), created_at: at(0, 0, 2) },
    inbound('05', '今天再问', { created_at: at(0, 0, 5) }),
  ]);
  expect(list.map(({ kind }) => kind)).toEqual(['date', 'mine', 'reply', 'mine', 'reply', 'date', 'mine']);
  expect(list.map((item) => ('text' in item ? item.text : ''))).toEqual(['昨天', '睡前问的', '过了午夜才答', '接着又问', '这条也是', '今天', '今天再问']);
  // Replies still keep their own midnight timestamps for display.
  expect(list[2]).toHaveProperty('at', at(0, 0, 1));
  expect(list[4]).toHaveProperty('at', at(0, 0, 2));
  // Every day line stands before something dated, and each carries a key of its own.
  const keys = list.map(({ key }) => key);
  expect(new Set(keys).size).toBe(keys.length);
  list.forEach((item, index) => {
    if (item.kind === 'date') expect(list[index + 1]!, `第 ${index + 1} 条分隔线后面没有东西`).toHaveProperty('at');
  });
});
