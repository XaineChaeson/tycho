// Guards a project's conversation (#/projects/:id) against: a reply that only appears once it is finished
// (no streaming), an internal event showing its JSON, a question answered by a stray
// tap (picking must not send), an answer sent with a question left open, a refused
// answer that vanishes without its reason, no sign that the Router is at work or no way
// to interrupt it, an unfinished request that hides what it had already committed, a
// sent message lost when the service refuses it, Enter sending while an input method is
// still composing, new lines dragging a reader who has scrolled up back to the bottom,
// what was typed and not sent gone after a look at another page, a text refused while
// the owner was on another page neither back in the box nor explained, and the late
// answer to a connection that broke turning a finished reply back into a half-written
// one with the Router shown as at work.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { Message } from '@/lib/types';
import { deferred, go, holdClock, open, pass, refusal, shellStream, type Call, type Handler } from '@/test/harness';

const inbound = (id: string, text: string, more: Partial<Message> = {}): Message => ({ id, direction: 'in', channel: 'console', external_id: `x-${id}`, text, state: 'processed', ...more });
const reply = (id: string, to: string, text: string, final = 1): Message => ({ id, direction: 'out', external_id: `reply:${to}`, text, state: null, final });
// The conversation's read, with what each request's turn committed.
const withMessages = (messages: Message[], more: Handler = () => undefined, changes: Record<string, unknown> = {}): Handler => (call) =>
  more(call) ?? (call.path === '/api/messages?segment=s1&limit=50' ? { messages, changes } : undefined);
const log = (): HTMLElement => screen.getByRole('log');
const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: '给负责人发消息' });
const push = (type: string, data: unknown): Promise<void> => act(async () => { shellStream().emit(type, data); });

test.each([false, true])('the trajectory shows the saved tool definitions, with legacy availability %s', async (legacy) => {
  const catalog = legacy ? null : {
    basis: 'service_available',
    tools: [{
      name: 'create_task', description: '当时的建任务定义',
      inputSchema: { type: 'object', properties: { source: { enum: ['old-source'] }, api_key: { type: 'string' } } },
    }],
  };
  const app = open('#/projects/p1', withMessages([inbound('m1', '建立验证任务', { project_id: 'p1' })], (call) => (
    call.path === '/api/messages/m1/trajectory' ? {
      message_id: 'm1', turn_message_id: 'm1', calls: [], next_call: null,
      exchanges: [{
        id: 'e1', phase: 'request', started_at: '2026-11-05T00:00:00Z', finished_at: '2026-11-05T00:00:01Z',
        outcome: 'completed', template: '当时的固定提示词', input: '当时发给负责人的消息', output: '已处理', tool_catalog: catalog,
      }],
    } : undefined
  )));
  await app.user.click(await screen.findByRole('button', { name: '查看经过' }));
  const dialog = await screen.findByRole('dialog', { name: '这条消息的处理经过' });
  await app.user.click(await within(dialog).findByText('发给负责人的本轮输入'));
  expect(within(dialog).getByText('当时发给负责人的消息')).toBeInTheDocument();
  await app.user.click(within(dialog).getByText('查看固定提示词'));
  expect(within(dialog).getByText('当时的固定提示词')).toBeInTheDocument();
  await app.user.click(within(dialog).getByText('查看 Tycho 工具定义'));
  if (legacy) {
    expect(within(dialog).getByText('当时没有保存工具定义。')).toBeInTheDocument();
    expect(within(dialog).queryByText('create_task')).toBeNull();
  } else {
    expect(within(dialog).getByText('这回合开始时 Tycho 可提供的工具定义。执行器的接收状态未知。')).toBeInTheDocument();
    await app.user.click(within(dialog).getByText('create_task'));
    expect(within(dialog).getByText('当时的建任务定义')).toBeInTheDocument();
    expect(within(dialog).getByText(/"old-source"/)).toHaveTextContent('"api_key"');
  }
  expect(app.reads).toContain('/api/messages/m1/trajectory');
  expect(app.reads.some((path) => path.includes('/tools'))).toBe(false);
});

test('an empty conversation invites the owner to speak', async () => {
  open('#/projects/p1');
  expect(await screen.findByText('还没有对话')).toBeInTheDocument();
  expect(screen.queryByText('负责人在处理')).toBeNull();
});

test('the conversation shows what was said, the reply under it, what the turn created, and what happened while away', async () => {
  open('#/projects/p1', withMessages(
    [inbound('01', '建个探针任务'), reply('02', '01', '建好了，**已入队**。'), inbound('03', '任务“探针”的 Run 已结算，任务转为 ready\n{"task_id":"t1","receipt":null}', { channel: 'internal' })],
    (call) => (call.path === '/api/summary' ? { delivered: 1, running: 2, waiting: 0 } : undefined),
    { '01': { changes: [{ action: 'task.create', at: '2026-11-05T00:00:00Z' }], tasks: [{ id: 't 1', title: '探针', state: 'queued' }] } },
  ));
  expect(await screen.findByText('建个探针任务')).toBeInTheDocument();
  expect(within(log()).getByText('上次打开以来：交付 1 件，2 项在推进')).toBeInTheDocument();
  expect(screen.getByText('已入队').tagName).toBe('STRONG');
  // The reply is marked as the Router's.
  expect(screen.getByText('已入队').closest('[id="reply-02"]')).toHaveTextContent(/^负责人/);
  const capsule = within(log()).getByRole('button', { name: /探针/ });
  expect(capsule).toHaveTextContent('排队中');
  // An internal event is its sentence and nothing more.
  expect(screen.getByText('任务“探针”的 Run 已结算，任务转为 待验收')).toBeInTheDocument();
  expect(log().textContent).not.toMatch(/task_id|receipt/);
  // What happened while away first, then the conversation in the order it went.
  expect([...log().children].map((node) => node.textContent!.replace(/^负责人/, '').slice(0, 4))).toEqual(['上次打开', '建个探针', '建好了，', '探针排队', '任务“探']);
});

test('the project workspace rail shows active and recent resumable threads, files, and knowledge for this project only', async () => {
  const work = (id: string, title: string, state: string, project: string, resumable = true) => ({
    id,
    title,
    state,
    project_id: project,
    reason: null,
    resumable,
    summary: { dot: state, text: '', counts: {}, leaf: true },
  });
  const { user } = open('#/projects/p1', (call) => {
    if (call.path === '/api/tasks?top=1') {
      return {
        tasks: [
          work('w1', '在跑的工作', 'running', 'p1'),
          work('w2', '做完的工作', 'done', 'p1', true),
          work('w3', '别的项目的工作', 'running', 'p2'),
        ],
        children: [],
      };
    }
    if (call.path === '/api/knowledge') {
      return {
        entries: [
          {
            id: 'k1',
            kind: 'knowledge',
            title: '本机控制器约束',
            body: '只做调度，不跑重计算。',
            when_to_use: '派发集群任务时',
            loading: 'resident',
            state: 'active',
            project_ids: ['p1'],
            roles: [],
            revision: 1,
          },
        ],
        entry_machines: { k1: ['DEV-WORKSTATION'] },
        proposals: [],
        clients: [],
        directory_skills: [],
      };
    }
    if (call.path === '/api/tasks/w2') {
      return {
        task: { id: 'w2', title: '做完的工作', state: 'done', project_id: 'p1', revision: 1, created_at: '2026-11-05T00:00:00Z', goal: '完成分析' },
        work: { id: 'w2', title: '做完的工作', project_id: 'p1' },
        runs: [{ id: 'r1', task_id: 'w2', state: 'ended', exit_kind: 'completed', session_ref: 'sess-1', created_at: '2026-11-05T00:00:00Z', ended_at: '2026-11-05T00:05:00Z', snapshot_json: '{}', receipt_json: '{"status":"done","summary":"已交付"}' }],
        inputs: [],
        approvals: [],
        releases: { packages: [], last: null, intent: null, attempting: false, fetch: null, dropped: [], running: '0.1.848' },
        deliverables: [],
      };
    }
    return undefined;
  });
  const rail = await screen.findByRole('complementary', { name: '项目工作台' });
  expect(await within(rail).findByRole('button', { name: /在跑的工作/ })).toBeInTheDocument();
  // Completed resumable threads are collapsed by default when active work exists to avoid noise.
  expect(within(rail).queryByRole('button', { name: /做完的工作/ })).toBeNull();
  await user.click(within(rail).getByRole('button', { name: /近期可续接/ }));
  expect(within(rail).getByRole('button', { name: /做完的工作/ })).toHaveTextContent('可续接');
  expect(within(rail).queryByText('别的项目的工作')).toBeNull();
  expect(within(rail).getByRole('link', { name: /全部工作/ })).toHaveAttribute('href', '#/projects/p1/work');

  // Switching to Knowledge tab shows applicable active entries + machine badge.
  await user.click(within(rail).getByRole('tab', { name: /知识/ }));
  expect(await within(rail).findByText('本机控制器约束')).toBeInTheDocument();
  expect(within(rail).getByText(/DEV-WORKSTATION/)).toBeInTheDocument();

  // Clicking a resumable thread opens it in the Split Thread Pane without leaving /projects/p1.
  await user.click(within(rail).getByRole('tab', { name: /线程/ }));
  await user.click(within(rail).getByRole('button', { name: /近期可续接/ }));
  await user.click(within(rail).getByRole('button', { name: /做完的工作/ }));
  expect(window.location.hash).toContain('thread=w2');
  expect(await screen.findByRole('textbox', { name: '继续发送指令' })).toBeInTheDocument();
});

test('a task capsule reads its state in the same colour as the dot beside it, never as a finished one', async () => {
  open('#/projects/p1', withMessages([inbound('01', '做了几件事')], undefined, {
    '01': {
      changes: [{ action: 'task.create', at: '2026-11-05T00:00:00Z' }],
      tasks: [
        { id: 't1', title: '待验收的', state: 'ready' },
        { id: 't2', title: '停住的', state: 'held' },
        { id: 't3', title: '等你的', state: 'waiting_person' },
        { id: 't4', title: '排队的', state: 'queued' },
        { id: 't5', title: '做完的', state: 'done' },
      ],
    },
  }));
  // The badge and the dot are the two things that carry the state: a badge of its own
  // colour, saying something else than the dot, is a contradiction on one line.
  const tones = async (title: string): Promise<(string | null)[]> => {
    const capsule = await within(log()).findByRole('button', { name: new RegExp(`^${title}`) });
    const sign = capsule.querySelector('svg[data-state]')!;
    return [capsule.querySelector('[data-slot="badge"]')!.getAttribute('data-tone'), sign.getAttribute('data-tone'), sign.getAttribute('data-state')];
  };
  // The one that was accepted is green; nothing that is not over reads as ended.
  for (const [title, tone, state] of [['待验收的', 'waiting', 'ready'], ['停住的', 'failed', 'held'], ['等你的', 'waiting', 'waiting_person'], ['排队的', 'running', 'queued'], ['做完的', 'success', 'done']] as const) {
    expect(await tones(title), title).toEqual([tone, tone, state]);
  }
});

test('a reply is shown while it is written, with the Router marked as at work and a way to interrupt it', async () => {
  const { user, calls } = open('#/projects/p1', withMessages([inbound('01', '长活', { state: 'processing' })], (call) => (call.path === '/api/interrupt' ? { interrupted: true } : undefined)));
  expect(await screen.findByText('负责人在处理')).toBeInTheDocument();
  await push('delta', { message_id: '02', text: '我先', reply_to: '01', project_id: 'p1', segment_id: 's1' });
  expect(screen.getByText('我先')).toBeInTheDocument();
  await push('delta', { message_id: '02', text: '我先看一下', reply_to: '01', project_id: 'p1', segment_id: 's1' });
  expect(screen.getByText('我先看一下')).toBeInTheDocument();
  expect(screen.queryByText('我先')).toBeNull();
  // Still being written: not "cut off".
  expect(screen.queryByText('回复没有写完')).toBeNull();
  await user.click(screen.getByRole('button', { name: '打断' }));
  expect(calls).toEqual([{ path: '/api/interrupt', method: 'POST', body: { project_id: 'p1' } }]);
  await push('message', reply('02', '01', '我先看一下，好了。'));
  await push('message', inbound('01', '长活'));
  expect(screen.getByText('我先看一下，好了。')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('负责人在处理')).toBeNull());
  expect(screen.queryByRole('button', { name: '打断' })).toBeNull();
});

test('a reply that never got its last word is marked, and an interrupt the service refuses says why', async () => {
  const { user } = open('#/projects/p1', withMessages(
    [inbound('01', '上一次', { state: 'unverified' }), reply('02', '01', '写到一半', 0), inbound('03', '这一次', { state: 'processing' })],
    (call) => { if (call.path === '/api/interrupt') throw refusal('账本不可用', 503); return undefined; },
  ));
  expect(await screen.findByText('回复没有写完')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '打断' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('账本不可用');
});

test('an unfinished request says so and lists what it had already committed', async () => {
  open('#/projects/p1', withMessages([inbound('01', '建两个任务', { state: 'unverified' }), inbound('02', '什么都没来得及做', { state: 'unverified' })], undefined,
    { '01': { changes: [{ action: 'task.create', at: '2026-11-05T00:00:00Z' }, { action: 'made.up', at: '2026-11-05T00:00:01Z' }], tasks: [] } }));
  const blocks = await screen.findAllByText('该请求未完成，已提交的操作如下');
  expect(blocks).toHaveLength(2);
  // Each block is one row of the conversation.
  const rows = blocks.map((block) => [...log().children].find((row) => row.contains(block)) as HTMLElement);
  const items = within(rows[0]!).getAllByRole('listitem');
  expect(items.map((item) => item.textContent!.replace(/^.*?\d\d:\d\d /, ''))).toEqual(['创建任务', 'made.up']);
  expect(rows[0]).not.toHaveTextContent('没有已提交的操作');
  expect(rows[1]).toHaveTextContent('没有已提交的操作');
  expect(within(rows[1]!).queryByRole('listitem')).toBeNull();
});

const QUESTION = {
  id: '05', task_id: 't1', task_title: '选型', state: 'open', answers: null, answered_via: null,
  questions: [{ question: '用哪个库？', about: '影响后面的接口', options: ['甲', '乙'], recommend: 1 }, { question: '还有什么要求？' }],
};

test('a question stands in the conversation; picking an option only marks it, and nothing is sent before "提交答复"', async () => {
  let approvals = [QUESTION];
  const { user, calls } = open('#/projects/p1', withMessages([inbound('04', '开始吧')], (call) => {
    if (call.path === '/api/approvals') return { approvals };
    if (call.path === '/api/approvals/05/answer') { approvals = [{ ...QUESTION, state: 'answered', answers: ['乙', '要快'], answered_via: 'console' } as never]; return { status: 'accepted' }; }
    return undefined;
  }));
  const card = await screen.findByRole('region', { name: '等你决定 · 选型' });
  expect(card).toHaveTextContent('用哪个库？');
  expect(card).toHaveTextContent('影响后面的接口');
  // It is part of the conversation, after the message that came before it.
  expect(log().lastElementChild).toContainElement(card);
  const [first, second] = [within(card).getByRole('button', { name: '甲' }), within(card).getByRole('button', { name: '乙' })];
  // The recommended one says so, and nothing is picked for the owner.
  expect([first.getAttribute('aria-description'), second.getAttribute('aria-description')]).toEqual([null, '推荐']);
  expect([first.getAttribute('aria-pressed'), second.getAttribute('aria-pressed')]).toEqual(['false', 'false']);
  await user.click(first);
  expect(first).toHaveAttribute('aria-pressed', 'true');
  await user.click(second);
  expect([first.getAttribute('aria-pressed'), second.getAttribute('aria-pressed')]).toEqual(['false', 'true']);
  expect(calls).toEqual([]);
  // One question still has no answer.
  await user.click(within(card).getByRole('button', { name: '提交答复' }));
  expect(within(card).getByRole('alert')).toHaveTextContent('每个问题都要答复');
  expect(calls).toEqual([]);
  // A question with no options is answered in words.
  await user.type(within(card).getAllByRole('textbox', { name: '其他答复' }).at(-1)!, ' 要快 ');
  await user.click(within(card).getByRole('button', { name: '提交答复' }));
  expect(calls).toEqual([{ path: '/api/approvals/05/answer', method: 'POST', body: { answers: ['乙', '要快'] } }]);
  // Settled: what was answered and through where, and nothing left to press.
  await waitFor(() => expect(card).toHaveTextContent('已回答（来自 console）'));
  expect(card).toHaveTextContent('答：乙');
  expect(card).toHaveTextContent('答：要快');
  expect(within(card).queryByRole('button')).toBeNull();
});

test('"其他" lets the owner answer in their own words instead of an option', async () => {
  const { user, calls } = open('#/projects/p1', (call) => {
    if (call.path === '/api/approvals') return { approvals: [{ ...QUESTION, id: '06', questions: [QUESTION.questions[0]] }] };
    if (call.method === 'POST') return { status: 'accepted' };
    return undefined;
  });
  const card = await screen.findByRole('region', { name: '等你决定 · 选型' });
  expect(within(card).queryByRole('textbox')).toBeNull();
  await user.click(within(card).getByRole('button', { name: '甲' }));
  await user.click(within(card).getByRole('button', { name: '其他' }));
  expect(within(card).getByRole('button', { name: '甲' })).toHaveAttribute('aria-pressed', 'false');
  await user.type(within(card).getByRole('textbox', { name: '其他答复' }), '都不用');
  await user.click(within(card).getByRole('button', { name: '提交答复' }));
  expect(calls.at(-1)!.body).toEqual({ answers: ['都不用'] });
});

test('an answer the service refuses stays on the card with the reason', async () => {
  const { user } = open('#/projects/p1', (call) => {
    if (call.path === '/api/approvals') return { approvals: [{ ...QUESTION, id: '07', questions: [QUESTION.questions[0]] }] };
    if (call.method === 'POST') throw refusal('问题已关闭', 409);
    return undefined;
  });
  const card = await screen.findByRole('region', { name: '等你决定 · 选型' });
  await user.click(within(card).getByRole('button', { name: '甲' }));
  await user.click(within(card).getByRole('button', { name: '提交答复' }));
  expect(await within(card).findByRole('alert')).toHaveTextContent('问题已关闭');
  expect(within(card).getByRole('button', { name: '甲' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(card).getByRole('button', { name: '提交答复' })).toBeEnabled();
});

test('a closed question says so and offers nothing to press', async () => {
  // Settled before the oldest message on the page, it would not show: here it is newer.
  open('#/projects/p1', withMessages([inbound('01', '早先的话')], (call) => (call.path === '/api/approvals' ? { approvals: [{ ...QUESTION, id: '08', state: 'closed' }] } : undefined)));
  const card = await screen.findByRole('region', { name: '等你决定 · 选型' });
  expect(card).toHaveTextContent('问题已关闭');
  expect(within(card).queryByRole('button')).toBeNull();
});

test('sending shows the message at once, holds the box until the service has it, and Enter sends', async () => {
  const answer = deferred();
  const { user, calls } = open('#/projects/p1', (call) => (call.path === '/api/messages' && call.method === 'POST' ? answer.promise : undefined));
  await screen.findByText('还没有对话');
  // Shift+Enter is a new line, not a send.
  await user.type(box(), '第一行{Shift>}{Enter}{/Shift}第二行');
  expect(calls).toEqual([]);
  await user.type(box(), '{Enter}');
  expect(calls).toEqual([{ path: '/api/messages', method: 'POST', body: { text: '第一行\n第二行', project_id: 'p1' } }]);
  expect(within(log()).getByText(/第一行/)).toBeInTheDocument();
  expect(box()).toHaveValue('');
  expect(box()).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  await act(async () => { answer.resolve({ id: '01' }); });
  await push('message', inbound('01', '第一行\n第二行', { state: 'received' }));
  expect(box()).not.toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  // Shown once: the pending copy gave way to the ledger's.
  expect(within(log()).getAllByText(/第一行/)).toHaveLength(1);
});

test('nothing is sent for an empty box, or by the Enter that confirms an input method candidate', async () => {
  const { user, calls } = open('#/projects/p1', (call) => (call.method === 'POST' ? { id: '01' } : undefined));
  await screen.findByText('还没有对话');
  await user.click(screen.getByRole('button', { name: '发送' }));
  await user.type(box(), '   {Enter}');
  expect(calls).toEqual([]);
  await user.clear(box());
  await user.type(box(), 'ni hao');
  fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
  expect(calls).toEqual([]);
  expect(box()).toHaveValue('ni hao');
});

test('a message the service refuses goes back into the box, with the reason', async () => {
  const { user } = open('#/projects/p1', (call) => { if (call.method === 'POST') throw refusal('账本不可用，服务处于降级模式', 503); return undefined; });
  await screen.findByText('还没有对话');
  await user.type(box(), '发不出去的话');
  await user.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('账本不可用，服务处于降级模式');
  expect(box()).toHaveValue('发不出去的话');
  expect(box()).not.toHaveAttribute('readonly');
  expect(within(log()).queryByText('发不出去的话')).toBeNull();
});

test('what was typed and not sent is still in the box after a look at another page', async () => {
  const { user, calls } = open('#/projects/p1');
  await screen.findByText('还没有对话');
  await user.type(box(), '那台机器叫');
  await user.click(screen.getByRole('link', { name: '机器' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '给负责人发消息' })).toBeNull());
  await go('#/projects/p1');
  expect(await screen.findByRole('textbox', { name: '给负责人发消息' })).toHaveValue('那台机器叫');
  await user.type(box(), ' gpu-1{Enter}');
  expect(calls).toEqual([{ path: '/api/messages', method: 'POST', body: { text: '那台机器叫 gpu-1', project_id: 'p1' } }]);
});

test('a message refused while the owner is on another page is back in the box when they return, with the reason', async () => {
  const answer = deferred();
  const { user } = open('#/projects/p1', (call) => (call.path === '/api/messages' && call.method === 'POST' ? answer.promise : undefined));
  await screen.findByText('还没有对话');
  await user.type(box(), '走开时发的话{Enter}');
  await go('#/machines');
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '给负责人发消息' })).toBeNull());
  await act(async () => { answer.reject(refusal('账本不可用，服务处于降级模式', 503)); });
  await go('#/projects/p1');
  await waitFor(() => expect(box()).toHaveValue('走开时发的话'));
  expect(box()).not.toHaveAttribute('readonly');
  expect(screen.getByRole('alert')).toHaveTextContent('没有发出去：账本不可用，服务处于降级模式');
  expect(within(log()).queryByText('走开时发的话')).toBeNull();
  // Typing over it lets the reason go.
  await user.type(box(), '！');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('each message can say when it was said, and another day is a line between them', async () => {
  const on = (dayOffset: number, hour: number): string => {
    const at = new Date();
    at.setDate(at.getDate() + dayOffset);
    at.setHours(hour, 30, 0, 0);
    return at.toISOString();
  };
  const { user } = open('#/projects/p1', withMessages([
    inbound('01', '昨天说的话', { created_at: on(-1, 9) }),
    inbound('02', '今天说的话', { created_at: on(0, 9) }),
  ]));
  expect(await screen.findByText('昨天说的话')).toBeInTheDocument();
  expect(screen.getAllByRole('separator').map((node) => node.textContent)).toEqual(['昨天', '今天']);
  // The time is one press or one hover away, and the keyboard can reach it too.
  const stamps = screen.getAllByRole('button', { name: /^时间：/ });
  expect(stamps).toHaveLength(2);
  expect(stamps[0]).toHaveAttribute('aria-pressed', 'false');
  await user.click(stamps[0]!);
  expect(stamps[0]).toHaveAttribute('aria-pressed', 'true');
});

test('the answer to a connection that broke, coming back after the reconnect, does not bring the half-written reply back', async () => {
  holdClock();
  const gates: ReturnType<typeof deferred>[] = [];
  open('#/projects/p1', (call) => {
    if (call.path !== '/api/messages?segment=s1&limit=50') return undefined;
    gates.push(deferred());
    return gates.at(-1)!.promise;
  });
  // Connection A asks for its snapshot and breaks before the answer.
  await waitFor(() => expect(gates).toHaveLength(1));
  await act(async () => { shellStream().fail(); });
  // A second later the console connects again, and B reads the finished reply.
  await pass(1000);
  await waitFor(() => expect(gates).toHaveLength(2));
  await act(async () => { gates[1]!.resolve({ messages: [inbound('01', '问'), reply('02', '01', '写完了。')] }); });
  expect(await screen.findByText('写完了。')).toBeInTheDocument();
  // A's answer, from when the reply was half written.
  await act(async () => { gates[0]!.resolve({ messages: [inbound('01', '问', { state: 'processing' }), reply('02', '01', '写到一', 0)] }); });
  // Nothing to wait for: the answer must change nothing.
  await pass();
  expect(screen.getByText('写完了。')).toBeInTheDocument();
  expect(screen.queryByText('写到一')).toBeNull();
  expect(screen.queryByText('负责人在处理')).toBeNull();
  expect(screen.queryByRole('status'), '定稿在，页面却说已断开').toBeNull();
});

test('new lines pull the view down only while the reader is near the bottom', async () => {
  const { container } = open('#/projects/p1', withMessages([inbound('01', '第一句')]));
  await screen.findByText('第一句');
  const scroll = container.querySelector<HTMLElement>('[data-scroll]')!;
  let height = 1000;
  Object.defineProperty(scroll, 'scrollHeight', { get: () => height, configurable: true });
  Object.defineProperty(scroll, 'clientHeight', { get: () => 500, configurable: true });
  const say = (id: string): Promise<void> => { height += 100; return push('message', inbound(id, `第 ${id} 句`)); };

  // Opened at the latest line, and kept there as more arrives.
  await say('02');
  expect(scroll.scrollTop).toBe(1100);
  // Reading further up: the place is kept.
  scroll.scrollTop = 200;
  fireEvent.scroll(scroll);
  await say('03');
  expect(scroll.scrollTop).toBe(200);
  // Back within reach of the bottom: following again.
  scroll.scrollTop = 1200 - 500 - 60;
  fireEvent.scroll(scroll);
  await say('04');
  expect(scroll.scrollTop).toBe(1300);
});

// docs/design/project-sessions.md §1–§3, §6: a project's conversation shows only its own
// segment; an earlier segment is read only; "新话题" starts the next one; the old global
// record is read only.
const CONVERSATION = '/api/projects/p1/conversation';
const segments = [
  { id: 's1', seq: 1, state: 'closed', created_at: '2026-11-01T00:00:00Z', closed_at: '2026-11-02T00:00:00Z' },
  { id: 's2', seq: 2, state: 'current', created_at: '2026-11-02T00:00:00Z', closed_at: null },
];

test('a project shows its current segment only, an earlier one read only, and never another project\'s messages', async () => {
  const { user } = open('#/projects/p1', (call) => {
    if (call.path === CONVERSATION) return { project: { id: 'p1', name: '试跑' }, segments, segment: 's2', writable: true, contexts: [], legacy: 2, busy: null };
    if (call.path === `${CONVERSATION}?segment=s1`) return { project: { id: 'p1', name: '试跑' }, segments, segment: 's1', writable: false, contexts: [], legacy: 2, busy: null };
    if (call.path === '/api/messages?segment=s2&limit=50') return { messages: [inbound('21', '新话题里说的', { project_id: 'p1', segment_id: 's2' })] };
    if (call.path === '/api/messages?segment=s1&limit=50') return { messages: [inbound('11', '旧话题里说的', { project_id: 'p1', segment_id: 's1' })] };
    return undefined;
  });
  expect(await screen.findByText('新话题里说的')).toBeInTheDocument();
  // Pushed by the stream for another project: not this conversation.
  await push('message', inbound('99', '别的项目的', { project_id: 'p2', segment_id: 'x' }));
  expect(screen.queryByText('别的项目的')).toBeNull();
  // The old record is among the things done less often.
  await user.click(screen.getByRole('button', { name: '更多' }));
  expect(await screen.findByRole('menuitem', { name: '旧全局记录里有 2 条和它有关' })).toHaveAttribute('href', '#/legacy?project=p1');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull());
  await user.selectOptions(screen.getByRole('combobox', { name: '哪一段对话' }), 's1');
  expect(await screen.findByText('旧话题里说的')).toBeInTheDocument();
  expect(screen.queryByText('新话题里说的')).toBeNull();
  expect(screen.getByText(/之前的一段对话，只能看/)).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: '给负责人发消息' })).toBeNull();
});

test('"新话题" asks for confirmation, requests the next segment and shows it', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    let current = 's1';
    const { user, calls } = open('#/projects/p1', (call) => {
      if (call.method === 'POST' && call.path === '/api/projects/p1/new-topic') { current = 's2'; return { segment: segments[1] }; }
      if (call.path === CONVERSATION) {
        return current === 's1'
          ? { project: { id: 'p1', name: '试跑' }, segments: [{ ...segments[0], state: 'current', closed_at: null }], segment: 's1', writable: true, contexts: [], legacy: 0, busy: null }
          : { project: { id: 'p1', name: '试跑' }, segments, segment: 's2', writable: true, contexts: [], legacy: 0, busy: null };
      }
      if (call.path === '/api/messages?segment=s1&limit=50') return { messages: [inbound('11', '旧话题里说的', { project_id: 'p1', segment_id: 's1' })] };
      if (call.path === '/api/messages?segment=s2&limit=50') return { messages: [] };
      return undefined;
    });
    expect(await screen.findByText('旧话题里说的')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新话题' }));
    expect(confirmSpy).toHaveBeenCalledWith('开启新话题会将当前对话归档为只读，确定吗？');
    expect(calls.map(({ path, method }) => ({ path, method }))).toEqual([{ path: '/api/projects/p1/new-topic', method: 'POST' }]);
    await waitFor(() => expect(screen.queryByText('旧话题里说的')).toBeNull());
    expect(await screen.findByText('还没有对话')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '给负责人发消息' })).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test('"新话题" does nothing when confirmation is canceled, and is disabled when empty or busy', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    const emptyApp = open('#/projects/p1');
    await screen.findByText('还没有对话');
    expect(screen.getByRole('button', { name: '新话题' })).toBeDisabled();
    emptyApp.unmount();

    const busyApp = open('#/projects/p1', withMessages([inbound('11', '处理中', { state: 'processing' })]));
    await screen.findByText('处理中');
    expect(screen.getByRole('button', { name: '新话题' })).toBeDisabled();
    busyApp.unmount();

    const activeApp = open('#/projects/p1', withMessages([inbound('11', '还在聊')]));
    await screen.findByText('还在聊');
    await activeApp.user.click(screen.getByRole('button', { name: '新话题' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(activeApp.calls).toEqual([]);
    expect(screen.getByText('还在聊')).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test('"新话题" the service refuses says why and stays in the segment it was in', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    const { user } = open('#/projects/p1', withMessages([inbound('11', '旧话题里说的')], (call) => { if (call.method === 'POST') throw refusal('负责人正在处理，稍后再开新话题', 409); return undefined; }));
    expect(await screen.findByText('旧话题里说的')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新话题' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('负责人正在处理，稍后再开新话题');
    expect(screen.getByText('旧话题里说的')).toBeInTheDocument();
  } finally {
    confirmSpy.mockRestore();
  }
});

test('narrow-screen collapsible work-status bar surfaces active and waiting work above the chat', async () => {
  const work = (id: string, title: string, state: string, project: string) => ({ id, title, state, project_id: project, reason: null, summary: { dot: state, text: '', counts: {}, leaf: true } });
  const { user } = open('#/projects/p1', (call) => (call.path === '/api/tasks?top=1'
    ? { tasks: [work('w1', '在跑的工作', 'running', 'p1'), work('w2', '待验收的工作', 'ready', 'p1')], children: [] }
    : undefined));
  const bar = await screen.findByRole('region', { name: '在办工作状态' });
  const toggle = within(bar).getByRole('button', { name: /在办的工作（2）/ });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(bar).toHaveTextContent('1 件待处理 · 1 项进行中');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(within(bar).getByRole('button', { name: /在跑的工作/ })).toBeInTheDocument();
  expect(within(bar).getByRole('button', { name: /待验收的工作/ })).toBeInTheDocument();
  await user.click(within(bar).getByRole('button', { name: /在跑的工作/ }));
  expect(window.location.hash).toContain('thread=w1');
});

// What the owner sent with no project is given one on the overview: home.test.tsx.

// Review of step 1: what an unfinished request of the old record committed is read from the
// ledger, with the record itself: one read, and a record that cannot be read says so whole.
test('an unfinished request of the old record lists what it committed, in the same read as the record', async () => {
  open('#/legacy', (call) => (call.path === '/api/messages?legacy=1&limit=200'
    ? { messages: [inbound('01', '做到一半的', { basis: 'legacy', state: 'unverified' }), inbound('02', '没做成的', { basis: 'legacy', state: 'unverified' })], changes: { '01': { changes: [{ action: 'task.create', at: '2026-11-05T00:00:00Z' }], tasks: [] } } }
    : undefined));
  const record = await screen.findByRole('log', { name: '旧全局记录' });
  expect(await within(record).findByText(/创建任务/)).toBeInTheDocument();
  expect(within(record).getByText('没有已提交的操作')).toBeInTheDocument();
});

test('an old record that cannot be read says why', async () => {
  open('#/legacy', (call) => { if (call.path === '/api/messages?legacy=1&limit=200') throw refusal('账本读不出来', 503); return undefined; });
  expect(await screen.findByText('账本读不出来')).toBeInTheDocument();
});

test('the old global record is read only', async () => {
  open('#/legacy', (call) => (call.path === '/api/messages?legacy=1&limit=200' ? { messages: [inbound('01', '以前说的', { basis: 'legacy' })] } : undefined));
  expect(await screen.findByText('以前说的')).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: '给负责人发消息' })).toBeNull();
});

// An archived project still opens; its conversation is read only until the restore, and says
// so where the box was (project-sessions, "项目的生命周期").
test('an archived project\'s conversation is read only, says why, and offers the restore', async () => {
  const calls: Call[] = [];
  let archivedAt: string | null = '2030-01-01T00:00:00Z';
  const project = () => ({ id: 'p1', name: '试跑', sources: [], logins: [], login_mode: 'all', machines: [], spawn_machines: false, moving: 0, waiting: 0, archived_at: archivedAt });
  const { user } = open('#/projects/p1', (call) => {
    if (call.path === '/api/projects') return { projects: [project()] };
    if (call.path === '/api/projects/p1/conversation') {
      return { project: { id: 'p1', name: '试跑', archived_at: archivedAt }, segments: [], segment: null, writable: true, contexts: [], legacy: 0, busy: null };
    }
    if (call.method === 'POST' && call.path === '/api/projects/p1/archive') {
      calls.push(call);
      archivedAt = null;
      return { project: project() };
    }
    return undefined;
  });
  const notice = await screen.findByRole('status', { name: '项目已归档' });
  expect(notice).toHaveTextContent('负责人不接新消息，也不派新任务');
  expect(screen.queryByRole('textbox', { name: '给负责人发消息' })).toBeNull();
  await user.click(within(notice).getByRole('button', { name: '恢复' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1/archive', method: 'POST', body: { archived: false } }]));
  expect(await screen.findByRole('textbox', { name: '给负责人发消息' })).toBeInTheDocument();
});

test('narrow-screen thread sheet avoids duplicate title and close buttons via hideHeaderChrome', async () => {
  const work = { id: 'w1', title: '修复窄屏标题', state: 'running', project_id: 'p1', reason: null, summary: { dot: 'running', text: '', counts: {}, leaf: true } };
  open('#/projects/p1?thread=w1', (call) => {
    if (call.path === '/api/tasks?top=1') return { tasks: [work], children: [] };
    if (call.path === '/api/tasks/w1') {
      return {
        task: { id: 'w1', title: '修复窄屏标题', state: 'running', project_id: 'p1', revision: 1, created_at: '2026-11-05T00:00:00Z', goal: '目标' },
        work: { id: 'w1', title: '修复窄屏标题', project_id: 'p1' },
        children: [],
        runs: [],
        inputs: [],
        approvals: [],
        releases: { version: '1.0.0', packages: [], last: null, intent: null, attempting: false, fetch: null, dropped: [] },
        deliverables: [],
      };
    }
    return undefined;
  });

  const dialog = await screen.findByRole('dialog', { name: '修复窄屏标题' });
  expect(within(dialog).getAllByRole('heading', { name: '修复窄屏标题' })).toHaveLength(1);
  expect(within(dialog).getByRole('button', { name: '关闭' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: '关闭线程面板' })).toBeNull();
  expect(within(dialog).getByRole('link', { name: '在独立页面打开' })).toBeInTheDocument();
});

test('wide-screen split thread pane supports resize persistence, 1-click focus mode, and composer dimming', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width: 1180px)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const work = { id: 'w1', title: '分屏测试线程', state: 'done', project_id: 'p1', reason: null, resumable: true, summary: { dot: 'done', text: '', counts: {}, leaf: true } };
  const { user, container } = open('#/projects/p1?thread=w1', (call) => {
    if (call.path === '/api/tasks?top=1') return { tasks: [work], children: [] };
    if (call.path === '/api/tasks/w1') {
      return {
        task: { id: 'w1', title: '分屏测试线程', state: 'done', project_id: 'p1', revision: 1, created_at: '2026-11-05T00:00:00Z', goal: '目标' },
        work: { id: 'w1', title: '分屏测试线程', project_id: 'p1' },
        children: [],
        runs: [],
        inputs: [],
        approvals: [],
        releases: { version: '1.0.0', packages: [], last: null, intent: null, attempting: false, fetch: null, dropped: [] },
        deliverables: [],
      };
    }
    return undefined;
  });

  const threadAside = await screen.findByRole('complementary', { name: '执行线程' });
  expect(threadAside).toHaveStyle({ width: '540px' });

  // Resize via keyboard on divider persists width in localStorage, and double-click resets to 540.
  const divider = screen.getByRole('separator', { name: '调整线程面板宽度' });
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  expect(threadAside).toHaveStyle({ width: '564px' });
  expect(localStorage.getItem('tycho.threadPaneWidth')).toBe('564');
  fireEvent.doubleClick(divider);
  expect(threadAside).toHaveStyle({ width: '540px' });
  expect(localStorage.getItem('tycho.threadPaneWidth')).toBe('540');

  // Visual focus dimming: focusing thread composer dims project composer.
  const threadInput = await within(threadAside).findByRole('textbox', { name: '继续发送指令' });
  fireEvent.focus(threadInput);
  const projectForm = screen.getByText('发给项目负责人').closest('form')!;
  expect(projectForm.className).toContain('opacity-75');

  // 1-click focus mode collapses chat column and swaps button to 恢复分屏.
  await user.click(within(threadAside).getByRole('button', { name: '专注此线程' }));
  const chatPane = container.querySelector('[data-pane="chat"]')!;
  expect(chatPane.className).toContain('hidden');
  await user.click(within(threadAside).getByRole('button', { name: '恢复分屏' }));
  expect(chatPane.className).not.toContain('hidden');
});

test('project composer auto-converts >16 KiB plain-text paste into an uploaded .txt attachment', async () => {
  const uploadedNames: string[] = [];
  const origFetch = globalThis.fetch;
  open('#/projects/p1');
  await screen.findByText('还没有对话');

  // Intercept binary upload endpoint cleanly alongside harness fetch.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/projects/p1/files' && init?.method === 'POST') {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const name = decodeURIComponent(headers['X-File-Name'] ?? 'pasted.txt');
      uploadedNames.push(name);
      return {
        status: 200,
        ok: true,
        json: async () => ({
          file: {
            id: 'f-paste-1',
            project_id: 'p1',
            name,
            mime: 'text/plain',
            size: 18_000,
            kind: 'upload',
            origin: 'owner',
            summary: null,
            message_id: null,
            created_at: '2026-11-05T00:00:00Z',
            updated_at: '2026-11-05T00:00:00Z',
            previewable: false,
            is_image: false,
          },
        }),
      } as Response;
    }
    return origFetch(input, init);
  });

  const hugeText = 'A'.repeat(17 * 1024);
  fireEvent.paste(box(), {
    clipboardData: {
      items: [],
      files: [],
      getData: (type: string) => (type === 'text/plain' ? hugeText : ''),
    },
  });

  expect(await screen.findByText('已将长文本转为附件')).toBeInTheDocument();
  await waitFor(() => expect(uploadedNames).toHaveLength(1));
  expect(uploadedNames[0]).toMatch(/^pasted-log-.*\.txt$/);
  expect(await screen.findByText(uploadedNames[0]!)).toBeInTheDocument();
  expect(box()).toHaveValue('');
});

test('a project router failure from /api/state surfaces an alert banner with one-click restart', async () => {
  const app = open('#/projects/p1', (call) => {
    if (call.path === '/api/state') {
      return {
        router: {
          alive: false,
          error: null,
          host_error: null,
          restarting: false,
          turn: null,
          projects: [{ project_id: 'p1', alive: false, error: '负责人启动失败：找不到 agy' }],
        },
        dispatch: { degraded: false, recovering: false, paused: null },
        channels: { wecom: null },
        gateway: { state: 'off', since: null, error: null },
        launching_runs: [],
      };
    }
    if (call.path === '/api/router/restart' && call.method === 'POST') {
      return { waiting_for_turn: null };
    }
    return undefined;
  });

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('项目负责人已停摆');
  expect(alert).toHaveTextContent('负责人启动失败：找不到 agy');

  await app.user.click(within(alert).getByRole('button', { name: '重启负责人' }));
  await waitFor(() => {
    expect(app.calls.some((c) => c.path === '/api/router/restart' && c.method === 'POST')).toBe(true);
  });
});
