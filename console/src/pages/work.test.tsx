// Guards the work page against: a first read that fails leaving an empty page; the
// tasks of a work listed out of the order they were made in, without their state and
// reason, without when they last ran, or with a Run of unknown fate reading as in
// progress; a work with no tasks showing an empty list, or a stop on the way, instead of
// its own site; a work that does not say what it is for; the actions of a stopped, running
// or delivered work missing or sent as something else, whether it has tasks under it or is
// its own task; "在对话里谈这项工作" arriving at the conversation with an empty box; and a
// work with many tasks opening at the end of its list, past its title and state.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { deferred, open, refusal, shellStream, type Call, type Handler } from '@/test/harness';

const AT = '2026-11-05T00:00:00Z';
const later = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const aWork = (over: object = {}) => ({ id: 'work', title: '迁移报表', state: 'draft', reason: null, goal: '把**旧报表**迁到新库', acceptance: '新库里能查到', revision: 1, created_at: AT, ...over });
const aRun = (over: object = {}) => ({
  id: 'run', task_id: 'work', state: 'running', task_revision: 1, login_id: 't1', host: 'h1', session_ref: null, exit_kind: null,
  executor: 'claude', receipt: null, error: null, created_at: AT, started_at: AT, ended_at: null, ...over,
});
const aChild = (over: object = {}) => ({ id: 'c1', title: '第一个', state: 'running', reason: null, created_at: later(1), latest_run: null, ...over });
const RELEASES = { version: '1.0.0', last: null, intent: null, attempting: false, fetch: null, packages: [] };
const page = (work: object, children: object[], runs: object[]) => ({ task: work, work, children, runs, inputs: [], approvals: [], releases: RELEASES, role: null });

function site({ work = aWork(), children = [], runs = [] }: { work?: object; children?: object[]; runs?: object[] } = {}): Handler {
  return (call: Call) => {
    if (call.method !== 'GET') return {};
    if (call.path === '/api/tasks/work') return page(work, children, runs);
    // A work with no tasks under it is drawn as its task's site, which reads these too.
    if (call.path === '/api/roles') return { roles: [] };
    if (/^\/api\/runs\/[^/]+\/events$/.test(call.path)) return { events: [], first_index: 0, loaded: true };
    if (/^\/api\/runs\/[^/]+\/snapshot$/.test(call.path)) return { snapshot: { brief: '旧格式' } };
    return undefined;
  };
}

const loaded = () => screen.findByRole('heading', { level: 1, name: '迁移报表' });

test('a first read that fails says why instead of leaving an empty page', async () => {
  open('#/work/work', (call) => { if (call.path === '/api/tasks/work') throw refusal('任务不存在：work', 400); return undefined; });
  expect(await screen.findByText('任务不存在：work')).toBeInTheDocument();
  expect(document.querySelector('[data-slot="skeleton-page"]')).toBeNull();
});

test('a work lists its tasks in the order they were made, each with its state, its reason and when it last ran', async () => {
  open('#/work/work', site({
    work: aWork({ summary: { dot: 'held', text: '1 个在执行，1 个已停住', leaf: false, counts: {} } }),
    children: [
      { id: 'c3', title: '第三个', state: 'needs_verification', reason: '执行机器失联，核实中', created_at: later(3), latest_run: aRun({ id: 'r3', state: 'unknown' }) },
      { id: 'c1', title: '第一个', state: 'held', reason: '派发失败', created_at: later(1), summary: { dot: 'held', text: '1 个已停住', leaf: true, counts: {} }, latest_run: null },
      { id: 'c 2', title: '第二个', state: 'running', reason: null, created_at: later(2), latest_run: aRun({ id: 'r2', started_at: new Date(Date.now() - 10 * 60_000).toISOString() }) },
    ],
  }));
  await loaded();
  expect(screen.getByText('1 个在执行，1 个已停住'), '有子任务的工作显示各状态的个数').toBeInTheDocument();
  expect(screen.getByText(/^创建于 /)).toBeInTheDocument();
  const tasks = screen.getByRole('region', { name: '任务' });
  const rows = within(tasks).getAllByRole('link');
  expect(rows.map((row) => row.getAttribute('href'))).toEqual(['#/task/c1', '#/task/c%202', '#/task/c3']);
  // The held child is also surfaced in the top attention section with its full stop reason.
  const attention = screen.getByRole('region', { name: '待你处理的子任务' });
  expect(within(attention).getByRole('link', { name: '已停住：第一个' })).toHaveAttribute('href', '#/task/c1');
  expect(within(attention).getByText('派发失败')).toBeInTheDocument();
  expect(within(rows[0]!).getByText('第一个')).toBeInTheDocument();
  expect(within(rows[0]!).getByText('已停住：派发失败'), '没有子任务的任务显示自己的状态和原因').toBeInTheDocument();
  expect(within(rows[0]!).getByText('尚未执行')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('执行中')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('进行中 10 分钟')).toBeInTheDocument();
  expect(within(rows[2]!).getByText('执行情况未知'), '状态未知的 Run 不显示“进行中”').toBeInTheDocument();
  expect(within(rows[2]!).queryByText(/进行中/)).not.toBeInTheDocument();
  // Each task's sign is its own state's.
  expect(rows.map((row) => row.querySelector('svg[data-state]')!.getAttribute('data-tone'))).toEqual(['failed', 'running', 'running']);
});

test('a work with no tasks under it is its own task: its page is that task\'s site, with no stop on the way', async () => {
  open('#/work/work', site({ runs: [aRun({ state: 'ended', exit_kind: 'completed', ended_at: later(5) })] }));
  await loaded();
  // The site itself: the rounds, the facts of the task, and the word to its Worker.
  expect(await screen.findByRole('heading', { name: '派发说明 · 第 1 轮' })).toBeInTheDocument();
  expect(screen.getByRole('complementary', { name: '任务详情' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '继续发送指令' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '任务' }), '没有子任务，却画了一张空的任务清单').toBeNull();
  expect(screen.queryByRole('link', { name: '查看任务现场' })).toBeNull();
  expect(window.location.hash).toBe('#/work/work');
});

test('the goal of a work with tasks under it is on its page, drawn as written', async () => {
  open('#/work/work', site({ children: [aChild()] }));
  await loaded();
  const goal = screen.getByRole('region', { name: '工作目标' });
  expect(within(goal).getByText('旧报表').tagName).toBe('STRONG');
  // In sight without unfolding anything.
  expect(within(goal).getByText('旧报表').closest('details')).toBeNull();
});

// A work with no tasks is drawn as its task's site; before its first round no dispatch note
// says what it is for, so the page says it itself.
test('a work with no tasks that has not run yet still says what it is for', async () => {
  open('#/work/work', site({ work: aWork({ state: 'held', reason: '派发失败' }) }));
  await loaded();
  expect(screen.getByText('旧报表').tagName).toBe('STRONG');
});

test.each([
  ['its own task', [] as object[]],
  ['with tasks under it', [aChild()] as object[]],
])('a stopped work can go on or be given up; a running one can only be interrupted; a delivered one is accepted with a basis (%s)', async (_, children) => {
  const held = open('#/work/work', site({ work: aWork({ state: 'held', reason: '派发失败' }), children }));
  await loaded();
  expect(screen.getByRole('button', { name: '放弃' })).toBeEnabled();
  expect(screen.queryByRole('textbox', { name: '放弃理由' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '中断' })).not.toBeInTheDocument();
  await held.user.click(screen.getByRole('button', { name: '放弃' }));
  expect(screen.getByRole('textbox', { name: '放弃理由' })).toBeInTheDocument();
  await held.user.click(screen.getByRole('button', { name: '取消' }));
  await held.user.click(screen.getByRole('button', { name: '继续' }));
  await waitFor(() => expect(held.calls).toEqual([{ path: '/api/tasks/work/resume', method: 'POST', body: {} }]));
  held.unmount();

  const running = open('#/work/work', site({ work: aWork({ state: 'running' }), children, runs: [aRun()] }));
  await loaded();
  expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '放弃' })).not.toBeInTheDocument();
  await running.user.click(screen.getByRole('button', { name: '中断' }));
  await waitFor(() => expect(running.calls).toEqual([{ path: '/api/tasks/work/interrupt', method: 'POST', body: {} }]));
  running.unmount();

  const ready = open('#/work/work', site({ work: aWork({ state: 'ready' }), children }));
  await loaded();
  await ready.user.type(screen.getByRole('textbox', { name: '验收依据' }), '  跑过了回归  ');
  await ready.user.click(screen.getByRole('button', { name: '验收通过' }));
  await waitFor(() => expect(ready.calls).toEqual([{ path: '/api/tasks/work/accept', method: 'POST', body: { basis: '跑过了回归' } }]));
});

test('待你处理的子任务 surfaces child approvals, actionable accept cards (excluding in-review), and full held reasons', async () => {
  const longReason = '第一行详细错误：上游接口返回 502\n第二行详细错误：请检查节点网络代理配置后再继续执行';
  const children = [
    aChild({ id: 'c-ask', title: '子任务问答', state: 'waiting_person', created_at: later(1) }),
    aChild({ id: 'c-ready', title: '子任务可验收', state: 'ready', created_at: later(2) }),
    aChild({ id: 'c-reviewing', title: '子任务审阅中', state: 'ready', active_review: 'rev-1', review_gate: { kind: 'in_review', message: '审阅中', review_task_id: 'rev-1' }, created_at: later(3) }),
    aChild({ id: 'c-held', title: '子任务停住', state: 'held', reason: longReason, created_at: later(4) }),
  ];
  const approval = {
    id: 'ap-child-1', task_id: 'c-ask', task_title: '子任务问答', state: 'open',
    questions: [{ question: '用哪个表？', options: ['表 A', '表 B'] }], answers: null, answered_via: null,
  };
  open('#/work/work', (call) => {
    if (call.path === '/api/approvals') return { approvals: [approval] };
    return site({ work: aWork({ project_id: 'p1', goal: '查看 [说明](file:f1)' }), children })(call);
  });
  await loaded();
  const attention = screen.getByRole('region', { name: '待你处理的子任务' });
  expect(within(attention).getByRole('region', { name: '等你决定 · 子任务问答' })).toBeInTheDocument();
  expect(within(attention).getByRole('region', { name: '待验收 · 子任务可验收' })).toBeInTheDocument();
  expect(within(attention).queryByText('子任务审阅中')).toBeNull();
  expect(within(attention).getByText(/第二行详细错误：请检查节点网络代理配置后再继续执行/)).toBeInTheDocument();
});

test('the work page opens at its head, and goes down with new tasks only once the reader has gone to the end of the list', async () => {
  const gate = deferred();
  const child = (index: number) => ({ id: `c${index}`, title: `第 ${index} 个`, state: 'done', reason: null, created_at: later(index), latest_run: null });
  let children = [child(1), child(2)];
  const work = aWork();
  // jsdom lays nothing out. The part of the page that scrolls is drawn anew once the work
  // turns out to have tasks, so its size is given to whichever element is that part.
  let height = 2000;
  const sized = (px: () => number) => ({ get(this: HTMLElement) { return this.hasAttribute('data-scroll') ? px() : 0; }, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', sized(() => height));
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', sized(() => 500));
  try {
    open('#/work/work', (call) => (call.path === '/api/tasks/work' ? gate.promise.then(() => page(work, children, [])) : undefined));
    await waitFor(() => expect(document.querySelector('[data-slot="skeleton-page"]')).not.toBeNull());
    await act(async () => { gate.resolve(undefined); });
    await loaded();
    const scroll = within(screen.getByRole('main')).getByRole('article').closest<HTMLElement>('[data-scroll]')!;
    expect(scroll.scrollTop, '一打开就被拉到了列表末尾').toBe(0);
    const add = async (index: number): Promise<void> => {
      children = [...children, child(index)];
      height += 100;
      await act(async () => { shellStream().emit('changed', {}); });
      await screen.findByText(`第 ${index} 个`);
    };
    await add(3);
    expect(scroll.scrollTop, '读者还在页首，新任务把页面拉走了').toBe(0);
    scroll.scrollTop = height - 500;
    fireEvent.scroll(scroll);
    await add(4);
    expect(scroll.scrollTop).toBe(2200);
  } finally {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
});

test('"在对话里谈这项工作" opens the conversation of its project with the sentence begun and the caret in it', async () => {
  const { user } = open('#/work/work', site({ work: aWork({ project_id: 'p1' }), children: [aChild()] }));
  await loaded();
  await user.click(screen.getByRole('button', { name: '在对话里谈这项工作' }));
  const box = await screen.findByRole('textbox', { name: '给负责人发消息' });
  expect(box).toHaveValue('关于工作 迁移报表（work）：');
  expect(box).toHaveFocus();
  expect(window.location.hash).toBe('#/projects/p1');
});

test('a work that is its own task is talked about as that task, in the conversation of its project', async () => {
  const { user } = open('#/work/work', site({ work: aWork({ project_id: 'p1' }) }));
  await loaded();
  expect(screen.queryByRole('button', { name: '在对话里谈这项工作' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '在对话里谈这个任务' }));
  const box = await screen.findByRole('textbox', { name: '给负责人发消息' });
  expect(box).toHaveValue('关于任务 迁移报表（work）：');
  expect(box).toHaveFocus();
  expect(window.location.hash).toBe('#/projects/p1');
});
