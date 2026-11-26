// Guards the Worker's site as the task page draws it: split Worker paragraphs, tool
// results paired with the wrong call, a tool still shown as running after its Run ended,
// a failed first read that never retries, live events lost or unbounded while a read is
// under way, a log that stays behind a hole in the numbering when the Worker goes quiet,
// a catch-up that fails without saying so or hammers the service, numbering that breaks
// across a truncated snapshot, a closed log that keeps reading, and a dispatch note that
// shows the Task's current goal for a round sent out under an earlier revision. And the
// noise: a warning shown once per time it was said, a read and a file counted as the same
// thing, a failed call folded out of sight into a group, a call reported only at its end
// left without a row, a change claimed for a call that failed, and "思考中" on a round
// that has stopped thinking.
import { expect, test } from 'vitest';
import { createRunEvents, createTimelineReader, diagnosticsSummary, dispatchSummary, groupSummary, projectSite, type ToolRow } from './timeline.ts';
import type { NormalizedEvent } from './types.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const call = (id: string, category: 'read' | 'search' | 'run' | 'edit' | 'other', title = id, paths?: string[]): NormalizedEvent =>
  ({ kind: 'tool.start', id, category, name: category === 'run' ? 'command_execution' : category, title, ...(paths ? { paths } : {}) });
const done = (id: string, isError = false, more: object = {}): NormalizedEvent => ({ kind: 'tool.end', id, isError, ...more });
const tools = (rows: ReturnType<typeof projectSite>['rows']): ToolRow[] => rows.flatMap((row) => (row.kind === 'tool' ? [row] : row.kind === 'group' ? row.tools : []));

test('consecutive Worker text merges without swallowing intervening steps', () => {
  const { rows } = projectSite([
    { kind: 'text', text: '第一' }, { kind: 'text', text: '段。' },
    { kind: 'thinking', text: '想一想' }, { kind: 'text', text: '下一段' },
    { kind: 'turn.end' }, { kind: 'text', text: '另一轮' },
  ], false);
  expect(rows.map((row) => [row.kind, 'text' in row ? row.text : null])).toEqual([
    ['text', '第一段。'], ['thinking', '想一想'], ['text', '下一段'], ['text', '另一轮'],
  ]);
});

test('thinking is "still thinking" only while it is the last thing a running round did', () => {
  const thinking: NormalizedEvent = { kind: 'thinking', text: '想' };
  expect(projectSite([thinking], false).rows[0]).toMatchObject({ kind: 'thinking', live: true });
  expect(projectSite([thinking], true).rows[0]).toMatchObject({ live: false });
  expect(projectSite([thinking, { kind: 'text', text: '好' }], false).rows[0]).toMatchObject({ live: false });
});

test('tool results pair by id even when tools complete in a different order, and keep what they said', () => {
  const { rows, calls, failures } = projectSite([
    call('a', 'edit'), call('b', 'run'),
    done('b', true, { exitCode: 1, output: { text: '错了' } }),
    done('a', false, { reason: undefined }),
  ], false);
  expect(rows.map((row) => row.kind === 'tool' && [row.id, row.status, row.exitCode, row.output?.text])).toEqual([
    ['a', 'completed', undefined, undefined], ['b', 'failed', 1, '错了'],
  ]);
  expect([calls, failures]).toEqual([2, 1]);
});

test('an unpaired tool is incomplete once the Run ends; rendering does not mutate events', () => {
  const events: NormalizedEvent[] = [call('a', 'edit')];
  expect(tools(projectSite(events, false).rows)[0]?.status).toBe('running');
  expect(tools(projectSite(events, true).rows)[0]?.status).toBe('incomplete');
  expect(events).toEqual([call('a', 'edit')]);
});

test('a call reported only at its end has a row where it ended; one with nothing to show has none', () => {
  const { rows } = projectSite([
    { kind: 'text', text: '改一下' },
    done('f', false, { call: { category: 'edit', name: 'file_change', title: 'a.ts', paths: ['a.ts'] }, changes: [{ path: 'a.ts', op: 'update' }] }),
    done('ghost'),
  ], true);
  expect(rows.map((row) => row.kind === 'tool' ? [row.id, row.status, row.call.title] : row.kind)).toEqual(['text', ['f', 'completed', 'a.ts']]);
});

test('neighbouring reads and searches fold into a group; a failed one stays out, and a lone one is a line', () => {
  const { rows } = projectSite([
    call('r1', 'read', 'brief', ['brief.md']), done('r1'),
    call('r2', 'read', 'brief again', ['brief.md']), done('r2'),
    call('r3', 'read', 'context', ['context.json']), done('r3'),
    call('s1', 'search', 'rg'), done('s1'),
    call('r4', 'read', 'gone', ['gone.md']), done('r4', true, { reason: '没有这个文件' }),
    call('r5', 'read', 'one', ['one.md']), done('r5'),
    call('x', 'run', 'npm test'), done('x'),
    call('r6', 'read', 'two', ['two.md']), done('r6'),
  ], true);
  expect(rows.map((row) => (row.kind === 'group' ? row.tools.map((each) => each.id) : row.kind === 'tool' ? row.id : row.kind))).toEqual([
    ['r1', 'r2', 'r3', 's1'], 'r4', 'r5', 'x', 'r6',
  ]);
  const group = rows[0]!;
  expect(group.kind === 'group' && groupSummary(group.tools)).toBe('读取 3 次，2 个文件，搜索 1 次');
});

test('a group says calls and files apart, and a running group holds its current call', () => {
  const rows = projectSite([call('a', 'read', 'a', ['a']), done('a'), call('b', 'read', 'b', ['b']), call('c', 'search', 'rg x')], false).rows;
  expect(rows).toHaveLength(1);
  const group = rows[0]!;
  expect(group.kind === 'group' && group.tools.map((each) => each.status)).toEqual(['completed', 'running', 'running']);
  expect(group.kind === 'group' && groupSummary(group.tools)).toBe('读取 2 个文件，搜索 1 次');
  expect(groupSummary([{ kind: 'tool', id: 'q', status: 'completed', call: { category: 'read', name: 'Read', title: 'q' } }])).toBe('读取 1 次');
});

test('warnings and retries fold into one list, each said once with how often; a fatal one stays in the rows', () => {
  const warning: NormalizedEvent = { kind: 'diagnostic', level: 'warning', message: 'Codex is ignoring 1 unrecognized configuration setting.' };
  const site = projectSite([
    warning, warning,
    { kind: 'diagnostic', level: 'recovering', message: 'unknown', attempt: 1, maxRetries: 10 },
    { kind: 'diagnostic', level: 'recovering', message: 'unknown', attempt: 2, maxRetries: 10 },
    { kind: 'text', text: '开始' },
    { kind: 'diagnostic', level: 'fatal', message: '连不上', cause: 'other' },
    { kind: 'diagnostic', level: 'fatal', message: '连不上', cause: 'other' },
  ], true);
  expect(site.diagnostics).toEqual([
    { level: 'warning', message: warning.kind === 'diagnostic' ? warning.message : '', count: 2 },
    { level: 'recovering', message: 'unknown', count: 2 },
  ]);
  expect(diagnosticsSummary(site.diagnostics)).toBe('执行器告警 1 条，受阻重试 2 次');
  expect(site.rows.map((row) => row.kind)).toEqual(['text', 'fatal']);
  expect(site.rows[1]).toMatchObject({ message: '连不上', count: 2 });
  expect(site.retrying).toBeUndefined();
});

test('a running round in a retry says so until it does something again', () => {
  const retry: NormalizedEvent = { kind: 'diagnostic', level: 'recovering', message: 'unknown', attempt: 2, maxRetries: 5 };
  expect(projectSite([retry], false).retrying).toEqual({ attempt: 2, maxRetries: 5 });
  expect(projectSite([retry, { kind: 'usage', usage: [{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }] }], false).retrying).toEqual({ attempt: 2, maxRetries: 5 });
  expect(projectSite([retry, { kind: 'text', text: '好了' }], false).retrying).toBeUndefined();
  expect(projectSite([retry], true).retrying).toBeUndefined();
});

test('the files changed are what completed edits report, one entry per file', () => {
  const { changes } = projectSite([
    call('w', 'edit', 'a.py', ['a.py']), done('w', false, { changes: [{ path: 'a.py', op: 'add' }] }),
    call('e', 'edit', 'a.py', ['a.py']), done('e', false, { changes: [{ path: 'a.py', op: 'update', patch: '@@ -1 +1 @@\n-a\n+b' }] }),
    call('d', 'edit', 'b.txt', ['b.txt']), done('d'),
    call('f', 'edit', 'c.txt', ['c.txt']), done('f', true),
    call('r', 'read', 'd.txt', ['d.txt']), done('r'),
    call('o', 'edit', 'open.txt', ['open.txt']),
  ], false);
  expect(changes).toEqual([
    { path: 'a.py', op: 'add', patch: '@@ -1 +1 @@\n-a\n+b' },
    { path: 'b.txt' },
  ]);
});

test('timeline initialization retries after failure and then renders live events', async () => {
  const timers: { fn: () => void; delay: number }[] = [];
  const statuses: string[] = [];
  const events: number[] = [];
  let reads = 0;
  const reader = createTimelineReader<string, number>({
    load: async () => { if (++reads === 1) throw new Error('断线'); return 'snapshot'; },
    onLoad: (value) => { expect(value).toBe('snapshot'); },
    onEvent: (value) => events.push(value), onStatus: (value) => statuses.push(value),
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {},
  });
  await reader.read();
  expect(statuses.at(-1)).toMatch(/现场读取失败，重试中/);
  expect(timers[0]?.delay).toBe(1000);
  reader.push(1);
  timers.shift()!.fn();
  await tick();
  reader.push(2);
  expect(events).toEqual([2]);
  expect(statuses.at(-1)).toBe('');
  reader.close();
});

test('timeline buffers at most 2000 events and reports omitted events', async () => {
  let finish!: (value: null) => void;
  const events: number[] = [];
  const statuses: string[] = [];
  const reader = createTimelineReader<null, number>({
    load: () => new Promise<null>((resolve) => { finish = resolve; }),
    onLoad: () => {}, onEvent: (value) => events.push(value), onStatus: (value) => statuses.push(value),
  });
  const reading = reader.read();
  for (let index = 0; index < 2100; index += 1) reader.push(index);
  expect(reader.bufferedCount()).toBe(2000);
  finish(null);
  await reading;
  expect(events.length).toBe(2000);
  expect(events[0]).toBe(100);
  expect(statuses.at(-1)).toMatch(/较早的事件已省略/);
  reader.close();
});

function runEventsFixture(load: () => Promise<{ events: number[]; first_index?: number }>) {
  const timers: { fn: () => void; delay: number }[] = [];
  const statuses: string[] = [];
  const log = createRunEvents<number>({
    load, onChange: () => {}, onStatus: (value) => statuses.push(value),
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {},
  });
  const fire = async (): Promise<void> => { timers.shift()!.fn(); await tick(); };
  return { log, timers, statuses, fire };
}
const upTo = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

test('over 2000 events between two reads, then silence: the log still catches up', async () => {
  let total = 1000;
  let finish!: () => void;
  let hold: Promise<void> | undefined = new Promise((resolve) => { finish = resolve; });
  const { log, timers, fire, statuses } = runEventsFixture(async () => {
    const snapshot = { events: upTo(total), first_index: 0 };
    await hold;
    return snapshot;
  });
  log.reset({ events: upTo(500), first_index: 0 });
  log.push({ index: 999, event: 999 });
  // The read took its snapshot at 1000; the Worker writes 3000 more before it comes back.
  total = 4000;
  for (let index = 1000; index < total; index += 1) log.push({ index, event: index });
  hold = undefined;
  finish();
  await tick();
  expect(log.events().length, '这次读到的快照追不上').toBe(1000);
  expect(log.gap()).toBe(true);
  expect(timers.length, '缺口还在，不能等下一条事件来触发').toBe(1);
  expect(timers[0]!.delay).toBe(1000);
  expect(statuses.at(-1)).toMatch(/较早的事件已省略/);
  await fire();
  expect(log.events(), '随后不再有输出，也要追平').toEqual(upTo(4000));
  expect([log.gap(), timers.length, statuses.at(-1)]).toEqual([false, 0, '']);
});

test('a catch-up read that fails says so and backs off from 1s to 30s until it works', async () => {
  let failing = true;
  const { log, timers, fire, statuses } = runEventsFixture(async () => {
    if (failing) throw new Error('断线');
    return { events: upTo(11), first_index: 0 };
  });
  log.reset({ events: [0], first_index: 0 });
  log.push({ index: 10, event: 10 });
  await tick();
  const delays: number[] = [];
  for (let round = 0; round < 7; round += 1) {
    expect(statuses.at(-1)).toBe('现场读取失败，重试中');
    delays.push(timers[0]!.delay);
    await fire();
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  failing = false;
  await fire();
  expect(log.events()).toEqual(upTo(11));
  expect([timers.length, statuses.at(-1)]).toEqual([0, '']);
});

test('events line up across a snapshot that starts past a truncation', () => {
  const { log } = runEventsFixture(async () => ({ events: [], first_index: 0 }));
  log.reset({ events: [7000, 7001], first_index: 7000 });
  log.push({ index: 7001, event: 7001 });
  log.push({ index: 7002, event: 7002 });
  expect(log.events()).toEqual([7000, 7001, 7002]);
  expect(log.gap()).toBe(false);
});

test('a closed log neither reads again nor reports', async () => {
  let finish!: (value: { events: number[] }) => void;
  const { log, timers, statuses } = runEventsFixture(() => new Promise((resolve) => { finish = resolve; }));
  log.push({ index: 5, event: 5 });
  log.close();
  finish({ events: [] });
  await tick();
  expect([timers.length, statuses.length]).toEqual([0, 0]);
});

test('dispatch fallback only uses Task fields for the recorded revision', () => {
  const task = { revision: 2, goal: '当前目标', acceptance: '当前验收' };
  expect(dispatchSummary(task, { task_revision: 2 }, { brief: '旧格式' })).toEqual({ goal: '当前目标', acceptance: '当前验收', brief: '旧格式' });
  expect(dispatchSummary(task, { task_revision: 1 }, { brief: '旧格式' }).goal).toBe('该轮派发说明未记录目标摘要');
  expect(dispatchSummary(task, { task_revision: 1 }, { brief: '## 目标\n\n历史目标\n## 验收标准\n\n历史验收' }).goal).toBe('历史目标');
});

// Review (run-scene): "still thinking" and "retrying" are both about what the round is
// doing now, so both come from the last thing it did that the page shows: never both at
// once, and a warning or a fatal word after a retry ends the retry.
test('what a running round is doing now comes from its last shown event alone', () => {
  const thinking: NormalizedEvent = { kind: 'thinking', text: '想' };
  const retry: NormalizedEvent = { kind: 'diagnostic', level: 'recovering', message: 'unknown', attempt: 1, maxRetries: 3 };
  const now = (events: NormalizedEvent[]) => {
    const site = projectSite(events, false);
    return { live: site.rows.some((row) => row.kind === 'thinking' && row.live), retrying: site.retrying !== undefined };
  };
  expect(now([thinking, retry])).toEqual({ live: false, retrying: true });
  expect(now([retry, thinking])).toEqual({ live: true, retrying: false });
  expect(now([retry, { kind: 'diagnostic', level: 'warning', message: '告警' }])).toEqual({ live: false, retrying: false });
  expect(now([retry, { kind: 'diagnostic', level: 'fatal', message: '停了', cause: 'other' }])).toEqual({ live: false, retrying: false });
  expect(now([thinking, { kind: 'diagnostic', level: 'warning', message: '告警' }])).toEqual({ live: false, retrying: false });
});
