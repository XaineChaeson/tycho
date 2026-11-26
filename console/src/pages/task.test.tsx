// Guards the task page against: the skills a Task names left unsaid, or one retired since not
// said to stop its next round; a round read as read-only because its role is, before
// read-only is carried out (it says there is no such guarantee); a first read that fails leaving an empty page with no
// reason; a task whose machine is out of contact offered "继续" (it goes on by itself)
// or denied "放弃", an interrupt offered with no Run to interrupt, or a stream opened for
// a Run that has ended; a finished Run's record that could not be loaded shown as an
// empty site; an interjection, a reason or a basis that can be changed or sent twice
// while it is on its way, lost when the service refuses it, or left in the box after it
// was taken; interjections offered on a task that is over; a dispatch note that shows
// the Task's current goal for a round sent under another revision; tool calls shown
// without what they did or how they ended; a report with no receipt reading as nothing;
// an interjection's fate (void, waiting, unconfirmed, bound) left unsaid; pushed events
// drawn out of order or past a hole, a hole never filled, a broken stream or a failed
// read not said; one round's site mixed with another's when one is picked; a trace that
// answers late showing in a drawer that was closed or belongs to another round, or a
// drawer left open on "this round" after the task went on to the next by itself; the
// keyboard's place lost when the drawer shuts; a stream kept open for a Run that has
// ended, or closed before the last of what it pushed was read; a page opened at its end
// instead of its head; one stream per mount left behind by StrictMode; and the detail
// column hidden on a wide page or forced open on a narrow one. And a round the quota
// ended reading as a failure or a loss, with no word that the Task goes on by itself or
// on which target each round ran; and a queued task that does not say what it waits for.
// And a long site with no way to its end, or past the events when only the reports are wanted.
// And a release card that says a version is not running when the record says it is, artifacts
// that did not come back said only in the answer that carried them, a second launch asked for
// while one is already under way, or a release the owner asked for that never finished going
// unmentioned. And a task waiting to be accepted with no way to send it back to work, a note
// or a revision that does not travel with that request. And the source a Task is pinned to
// left unsaid, or a source the project has changed or lost reading as if nothing happened, or
// a round's own source taken from the Task as it is now instead of that round's snapshot (a
// round from before code sources said as one that worked without any); a local landing offered
// again after the console stopped carrying code; a receipt that names a pull request not
// linking to it, or more than one (or one that is not a PR address) linked anyway instead of
// said with the rule's reason; and a review bound to a code source not saying which commit it
// was checked at. And a task's role, tier or tier source not shown, or shown
// from the task as it is now for a round that went out under another; an override's reason
// left out; a task from before roles that says nothing of it; a pick of role or tier that
// sends what was not moved, or loses the pick when the service refuses it; and a review's
// tier form naming the role's default when the next round follows the reviewed one. And a task that
// needs review offering an acceptance the service will refuse, with no word why and no way
// for the owner past it, or that way not saying it is on the record; a review page not
// saying what it is bound to, who may not review it, or what it concluded; a task not
// listing its reviews or the times a rejection moved it up a tier. And a knowledge gate or
// curation task, which belongs to no project, placed under a project in the crumbs, or not
// saying what it works on, where it came from and which projects decide where it may run.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { NO_ROLE_REASON, OLD_NO_ROLE_TEXT, PRESET_ROLES } from '@shared/roles.ts';
import { ESCALATED_REASON, NEEDS_PASS_TEXT, noReviewerText } from '@shared/review.ts';
import type { TaskSourceView } from '@shared/sources.ts';
import { pullRequestCountText, pullRequestShapeText } from '@shared/pull-request.ts';
import { formatTime } from '@shared/time.ts';
import { deferred, FakeEventSource, go, holdClock, open, pass, refusal, shellStream, sources, type Call, type Handler } from '@/test/harness';

const AT = '2026-11-05T00:00:00Z';
const later = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

const aTask = (over: object = {}) => ({ id: 'task', title: '工作', state: 'needs_verification', reason: null, goal: '目标', acceptance: '验收', revision: 2, login_id: 't1', login_name: 'login_id' in over && over.login_id === null ? null : 't1', role_id: 'implement', tier: 'execute', tier_source: 'default', tier_override: null, tier_reason: null, created_at: AT, ...over });
const ROLES = PRESET_ROLES.map((role) => ({ ...role, created_at: AT, updated_at: AT }));
const aRun = (over: object = {}) => ({
  id: 'run', task_id: 'task', state: 'unknown', task_revision: 1, login_id: 't1', login_name: 't1', host: 'h1', session_ref: null, exit_kind: null,
  executor: 'claude', receipt: null, error: null, created_at: AT, started_at: null, ended_at: null, ...over,
});
const ended = (over: object = {}) => aRun({ state: 'ended', exit_kind: 'completed', ended_at: later(5), ...over });

interface Site {
  task?: object;
  work?: object;
  runs?: object[];
  inputs?: object[];
  approvals?: object[];
  // What the page offers to put in place, and how the last time ended.
  releases?: object;
  // By Run: what its record holds. A function is asked each time.
  events?: Record<string, unknown>;
  snapshots?: Record<string, unknown>;
  // The Task's role as the page reads it; by default the one its role_id names.
  role?: object | null;
  // Review on the page: what a review is bound to, the reviews of a Task, its gate.
  review?: object;
  // Whether this Task can be landed into main.
  landable?: object | null;
  // Live automation status (Router resting or busy).
  automation?: object | null;
  // Visual/document deliverables attached to this Task.
  deliverables?: object[];
  // A gate or curation Task's work, source and projects.
  knowledge?: object;
  // The skills the Task names, as they are now.
  skills?: object[];
  // Anything else, and every change: undefined falls through to the above.
  on?: Handler;
}

function site(options: Site = {}): Handler {
  return (call: Call) => {
    const special = options.on?.(call);
    if (special !== undefined) return special;
    if (call.method !== 'GET') return {};
    const task = (options.task ?? aTask()) as { id: string; role_id?: string | null };
    if (call.path === '/api/roles') return { roles: ROLES };
    if (call.path === `/api/tasks/${task.id}`) {
      return {
        task,
        work: options.work ?? task,
        children: [],
        runs: options.runs ?? [aRun()],
        inputs: options.inputs ?? [],
        approvals: options.approvals ?? [],
        // The page requires every part of this, and a test that is about something else
        // gives none of it: what it does give wins.
        releases: { version: '1.0.0', last: null, intent: null, attempting: false, fetch: null, packages: [], ...(options.releases ?? {}) },
        role: options.role !== undefined ? options.role : ROLES.find((role) => role.id === task.role_id) ?? null,
        ...(options.review === undefined ? {} : { review: options.review }),
        ...(options.landable === undefined ? {} : { landable: options.landable }),
        ...(options.automation === undefined ? {} : { automation: options.automation }),
        ...(options.deliverables === undefined ? {} : { deliverables: options.deliverables }),
        ...(options.knowledge === undefined ? {} : { knowledge: options.knowledge }),
        ...(options.skills === undefined ? {} : { skills: options.skills }),
      };
    }
    const run = /^\/api\/runs\/([^/]+)\/(events|snapshot)$/.exec(call.path);
    if (!run) return undefined;
    const [, id, what] = run as unknown as [string, string, string];
    const held = what === 'events' ? options.events?.[id] : options.snapshots?.[id];
    const value = typeof held === 'function' ? (held as () => unknown)() : held;
    if (what === 'events') return value ?? { events: [], first_index: 0, loaded: true };
    return value ?? { snapshot: { brief: '旧格式' } };
  };
}

const runStreams = () => sources.filter((source) => source.url.startsWith('/api/stream?runs='));
const loaded = () => screen.findByRole('heading', { level: 1, name: '工作' });
const button = (name: string | RegExp) => screen.queryByRole('button', { name });
const tool = (name: string): HTMLElement => screen.getByText(name).closest('[data-tool]')!;
// What a call's folded line says: its title and how it ended.
const line = (name: string): string => tool(name).querySelector('summary')!.textContent!;

test('a first read that fails says why instead of leaving an empty page', async () => {
  open('#/task/task', site({ on: (call) => { if (call.path === '/api/tasks/task') throw refusal('任务不存在：task', 400); return undefined; } }));
  expect(await screen.findByText('任务不存在：task')).toBeInTheDocument();
  expect(document.querySelector('[data-slot="skeleton-page"]')).toBeNull();
  expect(runStreams()).toHaveLength(0);
});

test.each([['unknown', 1], ['none', 0]] as const)('a task whose machine is out of contact can be interrupted or given up, and has no "继续": it goes on by itself (Run %s)', async (runState, live) => {
  open('#/task/task', site({ runs: runState === 'none' ? [] : [aRun()] }));
  await loaded();
  // With no Run there is nothing that could open a stream later: the page is drawn.
  await waitFor(() => expect(runStreams()).toHaveLength(live));
  expect(button('继续'), '失联的任务自动接续，不提供“继续”').toBeNull();
  expect(button('放弃'), '放弃不该被失联卡住').not.toBeNull();
  expect(screen.queryAllByRole('button', { name: '中断' })).toHaveLength(live);
  expect(runStreams()).toHaveLength(live);
  if (live) expect(runStreams()[0]!.url).toBe('/api/stream?runs=run');
  else expect(screen.getByText('还没有执行记录，插话会在下一次执行时送达。')).toBeInTheDocument();
});

test('a stopped task still offers "继续", and a running one offers neither that nor abandon', async () => {
  const held = open('#/task/task', site({ task: aTask({ state: 'held' }), runs: [ended()] }));
  await loaded();
  expect(button('继续')).not.toBeNull();
  expect(button('放弃')).not.toBeNull();
  expect(button('中断')).toBeNull();
  held.unmount();

  open('#/task/task', site({ task: aTask({ state: 'running' }), runs: [aRun({ state: 'running' })] }));
  await loaded();
  expect([button('继续'), button('放弃'), button('验收通过')]).toEqual([null, null, null]);
  expect(screen.getAllByRole('button', { name: '中断' })).toHaveLength(1);
});

test('historical read failure states its cause and never shows an empty live site', async () => {
  open('#/task/task', site({ task: aTask({ state: 'held' }), runs: [ended()], events: { run: { events: [], loaded: false, reason: '原始文件不存在' } } }));
  expect(await screen.findByText('历史现场未加载：原始文件不存在')).toBeInTheDocument();
  expect(runStreams(), '已结束的 Run 不开流').toHaveLength(0);
});

test('task insertion is read-only while pending and failure preserves the draft', async () => {
  const gate = deferred();
  const { user, calls } = open('#/task/task', site({ on: (call) => (call.path.endsWith('/inputs') ? gate.promise : undefined) }));
  const box = await screen.findByRole('textbox', { name: '插话' });
  await user.type(box, '保留的插话');
  await user.click(screen.getByRole('button', { name: '插话' }));
  expect(box).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '发送中' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '发送中' }));
  expect(calls, '还没回来又发了一次').toHaveLength(1);
  gate.reject(refusal('离线', 503));
  expect(await screen.findByRole('button', { name: '插话' })).toBeEnabled();
  expect(box).toHaveValue('保留的插话');
  expect(box).not.toHaveAttribute('readonly');
  expect(screen.getByText('离线')).toBeInTheDocument();
});

test('successful task insertion clears only the submitted draft', async () => {
  const gate = deferred();
  const { user, calls } = open('#/task/task', site({ on: (call) => (call.path.endsWith('/inputs') ? gate.promise : undefined) }));
  const box = await screen.findByRole('textbox', { name: '插话' });
  await user.type(box, '已发送');
  await user.click(screen.getByRole('button', { name: '插话' }));
  expect(box).toHaveAttribute('readonly');
  fireEvent.change(box, { target: { value: '请求期间不可变' } });
  expect(box).toHaveValue('已发送');
  gate.resolve({ id: 'input' });
  await waitFor(() => expect(box).toHaveValue(''));
  expect(box).not.toHaveAttribute('readonly');
  expect(calls).toEqual([{ path: '/api/tasks/task/inputs', method: 'POST', body: { text: '已发送' } }]);
});

test('Enter sends an interjection, Shift+Enter is a new line in it', async () => {
  const { user, calls } = open('#/task/task', site());
  const box = await screen.findByRole('textbox', { name: '插话' });
  await user.type(box, '第一行{Shift>}{Enter}{/Shift}第二行{Enter}');
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.body).toEqual({ text: '第一行\n第二行' });
});

// 放弃 opens a focused inline confirmation panel before sending; 验收通过 accepts immediately with an optional basis.
test.each([
  ['held', '放弃', '放弃理由', 'abandon', { reason: '处理依据' }, '确认放弃'],
  ['ready', null, '验收依据', 'accept', { basis: '处理依据' }, '验收通过'],
] as const)(
  'acceptance and abandonment lock during submission, preserve failures and clear success (%s)',
  async (state, openButton, field, action, body, submitButton) => {
    let gate = deferred();
    const { user, calls } = open('#/task/task', site({ task: aTask({ state }), runs: [], on: (call) => (call.method === 'POST' ? gate.promise : undefined) }));
    await loaded();
    if (openButton) await user.click(screen.getByRole('button', { name: openButton }));
    const box = await screen.findByRole('textbox', { name: field });
    if (state === 'ready') {
      expect(screen.getByRole('button', { name: '验收通过' }), '正常验收备注可选').toBeEnabled();
      expect(screen.getByRole('button', { name: '退回返工' }), '退回返工按钮可直接点击展开').toBeEnabled();
    }
    await user.type(box, '处理依据');
    await user.click(screen.getByRole('button', { name: submitButton }));
    expect(box).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '发送中' })).toBeDisabled();
    fireEvent.change(box, { target: { value: '不应覆盖' } });
    expect(box).toHaveValue('处理依据');
    gate.reject(refusal('暂时离线', 503));
    expect(await screen.findByRole('button', { name: submitButton })).toBeEnabled();
    expect(box).toHaveValue('处理依据');
    expect(box).not.toHaveAttribute('readonly');
    expect(screen.getByRole('alert')).toHaveTextContent('暂时离线');

    gate = deferred();
    await user.click(screen.getByRole('button', { name: submitButton }));
    gate.resolve({});
    if (openButton) {
      await waitFor(() => expect(screen.queryByRole('textbox', { name: field })).toBeNull());
    } else {
      await waitFor(() => expect(box).toHaveValue(''));
      expect(box).not.toHaveAttribute('readonly');
    }
    expect(screen.queryByText('暂时离线'), '再试时上一次的失败不该还挂着').not.toBeInTheDocument();
    expect(calls[0]).toEqual({ path: `/api/tasks/task/${action}`, method: 'POST', body });
    expect(calls).toHaveLength(2);
  },
);

const aPackage = { run_id: 'run', at: AT, file: 'tycho-1.2.0.tar.gz', version: '1.2.0', bytes: 1024, sha256: 'a'.repeat(64) };
// What the owner asked for, while no result has answered it yet.
const anIntent = { at: later(1), run_id: 'run', name: aPackage.file, version: '1.2.0', sha256: aPackage.sha256, bytes: aPackage.bytes };

test('a task with a release package offers "上线", asks once more naming what it will hand over, and says the service is going down', async () => {
  const { user, calls } = open('#/task/task', site({ task: aTask({ state: 'done' }), runs: [ended()], releases: { version: '1.1.0', last: null, intent: null, attempting: false, fetch: null, packages: [aPackage] } }));
  await loaded();
  await user.click(screen.getByRole('button', { name: '上线' }));
  expect(screen.getByText(/要上线 tycho 1\.2\.0 吗？（sha256 aaaaaaaaaaaa…）/)).toBeInTheDocument();
  expect(screen.getByText(/服务会先让负责人把手头这一回合做完再停；起不来会自己退回上一版。/)).toBeInTheDocument();
  expect(calls, '确认之前不发').toEqual([]);
  await user.click(screen.getByRole('button', { name: '先不上' }));
  expect(screen.queryByText(/要上线 tycho 1\.2\.0 吗/)).toBeNull();

  await user.click(screen.getByRole('button', { name: '上线' }));
  await user.click(screen.getByRole('button', { name: '确认上线' }));
  // 上线 hands over the name, digest and size the owner confirmed, and nothing else.
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/releases/run/launch?confirm=1',
    method: 'POST',
    body: { name: aPackage.file, sha256: aPackage.sha256, bytes: aPackage.bytes },
  }]));
  expect(await screen.findByText(/正在上线 tycho 1\.2\.0：服务会按这个版本的流程停、换、再起来，这一页会自己连回来/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '已经在做' })).toBeDisabled();
});

test('a task with no release package has no "上线", and one that came back shows what came of it', async () => {
  const plain = open('#/task/task', site({ runs: [ended()] }));
  await loaded();
  expect(button('上线')).toBeNull();
  expect(screen.queryByLabelText('上线')).toBeNull();
  plain.unmount();

  open('#/task/task', site({
    runs: [ended()],
    releases: { version: '1.1.0', last: { at: AT, from: '1.1.0', to: '1.2.0', verified: true, ok: false, rolled_back: true, in_use: '1.1.0', lines: ['核对：控制台资源取不到', '已经退回 1.1.0，账本没有动'] }, intent: null, attempting: false, fetch: null, packages: [] },
  }));
  await loaded();
  expect(await screen.findByText(/从 tycho 1\.2\.0 退回了 tycho 1\.1\.0/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '上线' })).toBeNull();
});

// What a release that came back is told apart by: `in_use` is the version `current` points
// at now, and it — not "it must still be the old one" — says which version is running. A
// version that went in without ever having been started is not one that works: it is said
// as unverified, whichever version is in place.
test.each([
  ['升上去了', { verified: true, ok: true, rolled_back: false, in_use: '1.2.0' }, '1.2.0', /已升到 tycho 1\.2\.0$/, null],
  ['退回了上一版', { verified: true, ok: false, rolled_back: true, in_use: '1.1.0' }, '1.1.0', /从 tycho 1\.2\.0 退回了 tycho 1\.1\.0$/, null],
  ['没有切换，还在原来那一版', { verified: false, ok: false, rolled_back: false, in_use: '1.1.0' }, '1.1.0', /没有换成 tycho 1\.2\.0，还在 tycho 1\.1\.0（这次没有切换）$/, null],
  ['装上了新版但检查没过，也没有退回', { verified: true, ok: false, rolled_back: false, in_use: '1.2.0' }, '1.2.0', /装上了 tycho 1\.2\.0，但没通过检查、也没有退回$/, /还是在旧版本|没能升到/],
  ['装上了新版但还没有验证', { verified: false, ok: false, rolled_back: false, in_use: '1.2.0' }, '1.2.0', /装上了 tycho 1\.2\.0，但这一版还没有验证：下次启动才生效$/, /已升到|没通过检查/],
  ['新版在跑但核对没做完', { verified: false, ok: false, rolled_back: false, in_use: '1.2.0', pending: ['恢复清点尚未完成'] }, '1.2.0', /tycho 1\.2\.0 版本已在跑、核对没做完：恢复清点尚未完成$/, /已升到|下次启动才生效|没通过检查/],
  ['读不出 current', { verified: true, ok: false, rolled_back: false, in_use: null }, '1.1.0', /读不出 current，不确定现在在跑的是 tycho 1\.1\.0 还是 tycho 1\.2\.0$/, null],
] as const)('a release that came back says what is running now: %s', async (why, outcome, version, line, absent) => {
  open('#/task/task', site({
    task: aTask({ state: 'done' }),
    runs: [ended()],
    releases: { version, last: { at: AT, from: '1.1.0', to: '1.2.0', lines: ['核对：控制台资源取不到'], ...outcome }, intent: null, attempting: false, fetch: null, packages: [] },
  }));
  await loaded();
  expect(await screen.findByText(line)).toBeInTheDocument();
  expect(screen.getByText(`现在在跑的是 tycho ${version}`)).toBeInTheDocument();
  if (absent !== null) expect(screen.queryByText(absent), '新版装上了，就不能说还在旧版本').toBeNull();
  expect(within(screen.getByText('这次上线的记录').closest('details')!).getByText(/控制台资源取不到/), '上线记录原样留着').toBeInTheDocument();
});

test('artifacts that did not come back are said with why, and can be asked for again', async () => {
  const first = { version: '1.1.0', last: null, intent: null, attempting: false, packages: [], fetch: { registered: null, failed: { at: AT, problem: '连不上 h1：超时' } } };
  const options: Site = {
    task: aTask({ state: 'done' }),
    runs: [ended()],
    releases: first,
    on: (call) => {
      if (call.method !== 'POST' || call.path !== '/api/tasks/task/artifacts') return undefined;
      // The machine answered this time: the package is here and nothing is wrong any more.
      options.releases = { ...first, fetch: { registered: { at: later(1), files: [aPackage.file] }, failed: null }, packages: [aPackage] };
      return { stored: [aPackage.file], problem: null };
    },
  };
  const { user, calls } = open('#/task/task', site(options));
  await loaded();
  expect(await screen.findByText('这一轮的产物没取回来：连不上 h1：超时')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '重新取产物' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/tasks/task/artifacts', method: 'POST', body: {} }]));
  // Taken again, the page reads the Task again: the package is here and the reason is gone.
  expect(await screen.findByText(`这一轮带回了 tycho 1.2.0 的发布包（${aPackage.file}）`)).toBeInTheDocument();
  expect(screen.queryByText(/这一轮的产物没取回来/)).toBeNull();
});

test('a re-taking that failed is said beside the product still in use, with the way to ask again', async () => {
  const { user, calls } = open('#/task/task', site({
    task: aTask({ state: 'done' }),
    runs: [ended()],
    releases: {
      version: '1.1.0', last: null, intent: null, attempting: false, packages: [aPackage],
      fetch: { registered: { at: AT, files: [aPackage.file] }, failed: { at: later(1), problem: '连不上 h1：超时' } },
    },
    on: (call) => (call.path.endsWith('/artifacts') ? { stored: [aPackage.file], problem: null } : undefined),
  }));
  await loaded();
  expect(await screen.findByText('最近一次重新取产物没成功：连不上 h1：超时。现在用的还是之前取回的那一份。')).toBeInTheDocument();
  // The product kept is still the one offered.
  expect(screen.getByText(`这一轮带回了 tycho 1.2.0 的发布包（${aPackage.file}）`)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '重新取产物' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/tasks/task/artifacts', method: 'POST', body: {} }]));
});

test('a fetch asked for again that is refused says why, and the button is there to press once more', async () => {
  const { user, calls } = open('#/task/task', site({
    task: aTask({ state: 'done' }),
    runs: [ended()],
    releases: { version: '1.1.0', last: null, intent: null, attempting: false, packages: [], fetch: { registered: null, failed: { at: AT, problem: '连不上 h1：超时' } } },
    on: (call) => { if (call.path.endsWith('/artifacts')) throw refusal('任务 task 还没有验收，产物是在验收时取回的'); return undefined; },
  }));
  await loaded();
  await user.click(await screen.findByRole('button', { name: '重新取产物' }));
  expect(await screen.findByText('任务 task 还没有验收，产物是在验收时取回的')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新取产物' })).toBeEnabled();
  expect(calls).toHaveLength(1);
});

test('a release already under way takes no second request, whether the click started it or found one running', async () => {
  const options: Site = {
    task: aTask({ state: 'done' }),
    runs: [ended()],
    releases: { version: '1.1.0', last: null, intent: null, attempting: false, fetch: null, packages: [aPackage] },
    on: (call) => {
      if (!call.path.startsWith('/api/releases/')) return undefined;
      // One is already running: this answer is its state, not a second release.
      options.releases = { version: '1.1.0', last: null, attempting: true, fetch: null, packages: [aPackage], intent: anIntent };
      return { started: false, version: '1.2.0' };
    },
  };
  const { user, calls } = open('#/task/task', site(options));
  await loaded();
  await user.click(screen.getByRole('button', { name: '上线' }));
  await user.click(screen.getByRole('button', { name: '确认上线' }));
  expect(await screen.findByText(/正在上线 tycho 1\.2\.0：服务会按这个版本的流程停、换、再起来/)).toBeInTheDocument();
  const again = screen.getByRole('button', { name: '已经在做' });
  expect(again).toBeDisabled();
  await user.click(again);
  expect(button('上线'), '已经在做，就没有第二个上线入口').toBeNull();
  expect(calls, '收到 started:false 之后再点也不该发第二个请求').toHaveLength(1);
});

test('a release the owner asked for that never finished is said, and the way to ask again is there', async () => {
  const { user, calls } = open('#/task/task', site({
    task: aTask({ state: 'done' }),
    runs: [ended()],
    releases: { version: '1.1.0', last: null, intent: anIntent, attempting: false, fetch: null, packages: [aPackage] },
  }));
  await loaded();
  expect(await screen.findByText('上一次要求上线 tycho 1.2.0 没有下文（升级命令已经不在了），上线的记录里没有它的结果。')).toBeInTheDocument();
  expect(screen.queryByText('这次上线的记录'), '没有结果就没有上线的记录').toBeNull();
  await user.click(screen.getByRole('button', { name: '再上线一次' }));
  await user.click(screen.getByRole('button', { name: '确认上线' }));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/releases/run/launch?confirm=1',
    method: 'POST',
    body: { name: aPackage.file, sha256: aPackage.sha256, bytes: aPackage.bytes },
  }]));
});

test('a release the service refuses says why and leaves the button', async () => {
  const { user } = open('#/task/task', site({
    runs: [ended()],
    releases: { version: '1.1.0', last: null, intent: null, attempting: false, fetch: null, packages: [aPackage] },
    on: (call) => (call.path.startsWith('/api/releases/') ? (() => { throw refusal('这一轮没有可以上线的发布包'); })() : undefined),
  }));
  await loaded();
  await user.click(screen.getByRole('button', { name: '上线' }));
  await user.click(screen.getByRole('button', { name: '确认上线' }));
  expect(await screen.findByText('这一轮没有可以上线的发布包')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '确认上线' })).toBeEnabled();
});

// docs/design/code-sources.md §4: the Task page names the source this work is pinned to, and
// a project's source list has no local landing to press any more.
const aProject = {
  id: 'p', name: '试跑',
  sources: [{ id: 's1', kind: 'repo', url: 'https://example.com/app.git', default: true, label: '仓库 https://example.com/app.git' }],
  machines: [], moving: 0, waiting: 0,
};
const pinned = { source_id: 's1', pinned: { id: 's1', kind: 'repo', url: 'https://example.com/app.git' } };
const projectSite = (over: Partial<Site> = {}, on?: Handler): Site => ({
  task: aTask({ state: 'done', project_id: 'p', source: pinned, source_state: 'current', source_label: '仓库 https://example.com/app.git' }),
  runs: [ended()],
  releases: { version: '1.1.0', last: null, intent: null, attempting: false, fetch: null, packages: [] },
  ...over,
  on: (call) => {
    const mine = on?.(call);
    if (mine !== undefined) return mine;
    return call.path === '/api/projects' ? { projects: [aProject] } : undefined;
  },
});

test('the task page names the source in use, and offers no local landing at all', async () => {
  open('#/task/task', site(projectSite()));
  await loaded();
  const where = screen.getByText('任务详情').closest('details')!;
  expect(within(where).getByText('仓库 https://example.com/app.git')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /并入|合入/ })).toBeNull();
});

// The page reads the service's own projection of a Task's source — shared/sources.ts
// TaskSourceView, the very type service/ledger.ts taskSourceViewOf returns, which the console's
// Task extends and this fixture is typed by. So a service that changed the shape (as it once did,
// sending { id, label } while this page read a pin) cannot pass the console's own type check
// again; the fixture is not a copy of the service's code, it is the contract both sides compile
// against.
test('the source facts are read from the service projection, not from a shape copied beside it', async () => {
  const view: TaskSourceView = {
    source: { source_id: 's1', pinned: { id: 's1', kind: 'folder', machine_uid: 'u9', path: '/work/old' } },
    source_state: 'changed',
    source_label: 'h1 上的 /work/old',
  };
  open('#/task/task', site(projectSite(
    { task: aTask({ project_id: 'p', ...view }) },
    (call) => (call.path === '/api/projects' ? { projects: [{ ...aProject, sources: [{ id: 's1', kind: 'folder', machine_uid: 'u9', path: '/work/new', default: true, label: 'h1 上的 /work/new' }] }] } : undefined),
  )));
  await loaded();
  const where = screen.getByText('任务详情').closest('details')!;
  expect(within(where).getByText('h1 上的 /work/old')).toBeInTheDocument();
  expect(within(where).getByText('这一项在项目里改过了：现在是 h1 上的 /work/new，下一轮仍使用这件活选定时的来源；要使用现在的配置，需要改派这件活。')).toBeInTheDocument();
});

test('a source the project has changed is said, with what stands there now', async () => {
  const moved = { ...pinned, pinned: { id: 's1', kind: 'repo', url: 'https://example.com/old.git' } };
  open('#/task/task', site(projectSite({ task: aTask({ project_id: 'p', source: moved, source_state: 'changed', source_label: '仓库 https://example.com/old.git' }) })));
  await loaded();
  const where = screen.getByText('任务详情').closest('details')!;
  expect(within(where).getByText('仓库 https://example.com/old.git')).toBeInTheDocument();
  expect(within(where).getByText('这一项在项目里改过了：现在是 仓库 https://example.com/app.git，下一轮仍使用这件活选定时的来源；要使用现在的配置，需要改派这件活。')).toBeInTheDocument();
});

test('a pinned source the project no longer has is said as deleted', async () => {
  open('#/task/task', site(projectSite(
    { task: aTask({ project_id: 'p', source: pinned, source_state: 'removed', source_label: '仓库 https://example.com/app.git' }) },
    (call) => (call.path === '/api/projects' ? { projects: [{ ...aProject, sources: [] }] } : undefined),
  )));
  await loaded();
  const where = screen.getByText('任务详情').closest('details')!;
  expect(within(where).getByText('来源已删除：这件活在改到别的来源之前不会开工。')).toBeInTheDocument();
});

test('a task of a project with no source says its rounds work in an empty directory', async () => {
  open('#/task/task', site(projectSite(
    { task: aTask({ project_id: 'p', source: null, source_state: null, source_label: null }) },
    (call) => (call.path === '/api/projects' ? { projects: [{ ...aProject, sources: [] }] } : undefined),
  )));
  await loaded();
  const where = screen.getByText('任务详情').closest('details')!;
  expect(within(where).getByText('没有配代码来源。')).toBeInTheDocument();
  // 这一轮有没有代码，看的是这一轮自己的快照，不是这件活现在钉在哪儿。
  expect(await within(where).findByText('这一轮在空的任务目录里干活。')).toBeInTheDocument();
  expect(within(where).queryByText(/^仓库 /)).toBeNull();
});

// docs/design/code-sources.md §1: a round keeps the source its own snapshot recorded, which may
// not be the source the work is pinned to now after an update_task moved it.
test('each round says the source it used, apart from the source the work is pinned to now', async () => {
  const { user } = open('#/task/task', site(projectSite({
    runs: [
      ended({ id: 'r1', created_at: later(0), ended_at: later(1) }),
      ended({ id: 'r2', created_at: later(2), ended_at: later(3) }),
    ],
    snapshots: {
      r1: { snapshot: { source: { kind: 'repo', url: 'https://example.com/one.git', branch: 'main' } } },
      r2: { snapshot: { source: { kind: 'folder', path: '/work/app' } } },
    },
  })));
  await loaded();
  const where = screen.getByText('任务详情').closest('details')!;
  // 这件活钉着项目里那个仓库。
  expect(await within(where).findByText('这件活选定的来源')).toBeInTheDocument();
  expect(within(where).getByText('仓库 https://example.com/app.git')).toBeInTheDocument();
  // 最新一轮的快照说它用的是那台机器上的文件夹，不是这件活现在钉的仓库。
  expect(await within(where).findByText('h1 上的 /work/app')).toBeInTheDocument();
  // 换到第一轮：它记的是另一个仓库和当时工作的分支。
  await user.click(screen.getByRole('button', { name: /^第 1 轮/ }));
  expect(await within(where).findByText('仓库 https://example.com/one.git（分支 main）')).toBeInTheDocument();
  expect(within(where).queryByText('h1 上的 /work/app')).toBeNull();
});

// A round from before code sources kept a bundle instead of a source: the page says so rather
// than reading the missing source as a round without code.
test('a round from before code sources says its snapshot kept a bundle, not a source', async () => {
  open('#/task/task', site(projectSite({
    runs: [ended({ id: 'run' })],
    snapshots: { run: { snapshot: { repo: { commit: 'c0ffee1', remote: 'https://example.com/app.git' } } } },
  })));
  await loaded();
  const where = screen.getByText('任务详情').closest('details')!;
  expect(await within(where).findByText('这一轮的快照里没有记来源，只有代码包：它是代码来源之前的一轮。')).toBeInTheDocument();
  expect(within(where).queryByText('这一轮在空的任务目录里干活。')).toBeNull();
});

test('a round whose receipt names a pull request links to it', async () => {
  const PR = 'https://github.com/o/r/pull/7';
  open('#/task/task', site(projectSite({
    runs: [ended({ receipt: { status: 'completed', summary: '改好了', artifacts: [{ kind: 'pr', ref: PR }] } })],
  })));
  await loaded();
  const where = screen.getByText('任务详情').closest('details')!;
  const link = within(where).getByText(PR).closest('a')!;
  expect(link).toHaveAttribute('href', PR);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link.getAttribute('rel')).toContain('noopener');
});

// shared/pull-request.ts is the one reading of a receipt's pull request: its address is a link,
// and what it refuses is its reason — the page makes no reading of its own.
test('a receipt that names more than one pull request links to neither, and says why', async () => {
  const [one, two] = ['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/8'];
  open('#/task/task', site(projectSite({
    runs: [ended({ id: 'r1', receipt: { status: 'done', summary: '改好了', artifacts: [{ kind: 'pr', ref: one }, { kind: 'pr', ref: two }] } })],
  })));
  await loaded();
  await screen.findAllByText(one);
  expect(screen.queryByRole('link', { name: one })).toBeNull();
  expect(screen.queryByRole('link', { name: two })).toBeNull();
  // 回执那一处和右栏的产物说同一句话，都是判定给的。
  expect(screen.getAllByText(pullRequestCountText(2)).length).toBeGreaterThan(0);
});

test('a receipt whose pull request is not a valid URL links nowhere, and says why', async () => {
  const notPr = 'ftp://github.com/o/r/pull/7';
  open('#/task/task', site(projectSite({
    runs: [ended({ id: 'r1', receipt: { status: 'done', summary: '改好了', artifacts: [{ kind: 'pr', ref: notPr }] } })],
  })));
  await loaded();
  const shown = await screen.findAllByText(notPr);
  expect(screen.queryByRole('link', { name: notPr })).toBeNull();
  for (const each of shown) expect(each.tagName).toBe('CODE');
  expect(screen.getAllByText(pullRequestShapeText).length).toBeGreaterThan(0);
});

test('a round whose copies the retention rule cleared says so, and offers nothing to put in place', async () => {
  open('#/task/task', site(projectSite({
    releases: {
      version: '1.1.0', last: null, intent: null, attempting: false, fetch: null, packages: [],
      dropped: [{ run_id: 'run', at: AT }],
    },
  })));
  await loaded();
  expect(await screen.findByText(/这一轮的产物已在 .*按保留期清理（工作结束后过了保留期），要用就让任务重做一轮/)).toBeInTheDocument();
  expect(button('上线')).toBeNull();
});

test('a task waiting to be accepted can be sent back to work, with the note and the revision the page shows', async () => {
  const options = projectSite(
    { task: aTask({ state: 'ready', project_id: 'p' }), runs: [ended()] },
    (call) => (call.path === '/api/tasks/task/rework' ? { id: 'input', task: aTask({ state: 'queued', project_id: 'p' }) } : undefined),
  );
  const { user, calls } = open('#/task/task', site(options));
  await loaded();
  await user.click(screen.getByRole('button', { name: '退回返工' }));
  const box = screen.getByRole('textbox', { name: '退回说明' });
  const confirm = screen.getByRole('button', { name: '确认退回' });
  expect(confirm).toBeDisabled();
  await user.type(box, '最后一次测试之后你又改过文件，重跑一遍');
  await user.click(confirm);
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/tasks/task/rework',
    method: 'POST',
    // 修订跟着说明一起走：这个任务在页面画出之后被改过时，服务会拒。
    body: { note: '最后一次测试之后你又改过文件，重跑一遍', revision: 2 },
  }]));
});

test('a task sent back says later when it was not accepted, and the note is not lost', async () => {
  const options = projectSite(
    { task: aTask({ state: 'ready', project_id: 'p' }), runs: [ended()] },
    (call) => {
      if (call.path !== '/api/tasks/task/rework') return undefined;
      throw refusal('任务 task 已是修订 3，不是 2：看一遍再退回', 400);
    },
  );
  const { user } = open('#/task/task', site(options));
  await loaded();
  await user.click(screen.getByRole('button', { name: '退回返工' }));
  await user.type(screen.getByRole('textbox', { name: '退回说明' }), '再来一次');
  await user.click(screen.getByRole('button', { name: '确认退回' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('任务 task 已是修订 3，不是 2：看一遍再退回');
  expect(screen.getByRole('textbox', { name: '退回说明' })).toHaveValue('再来一次');
  expect(screen.getByRole('button', { name: '确认退回' })).toBeEnabled();
});

test('"继续" and "中断" go to the service as such, with no reason asked', async () => {  const held = open('#/task/task', site({ task: aTask({ state: 'held' }), runs: [ended()] }));
  await loaded();
  await held.user.click(screen.getByRole('button', { name: '继续' }));
  await waitFor(() => expect(held.calls).toEqual([{ path: '/api/tasks/task/resume', method: 'POST', body: {} }]));
  held.unmount();

  const running = open('#/task/task', site({ task: aTask({ state: 'running' }), runs: [aRun({ state: 'running' })] }));
  await loaded();
  await running.user.click(screen.getByRole('button', { name: '中断' }));
  await waitFor(() => expect(running.calls).toEqual([{ path: '/api/tasks/task/interrupt', method: 'POST', body: {} }]));
});

test('an abandoned task offers no composer', async () => {
  open('#/task/task', site({ task: aTask({ state: 'abandoned' }), runs: [ended()] }));
  await loaded();
  // The box is drawn, or not, in the same draw as the title.
  expect(screen.queryByRole('textbox', { name: '插话' })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: '继续发送指令' })).not.toBeInTheDocument();
});

test('a stopped task shows the follow-up composer and posts { note } to /continue', async () => {
  const { user, calls } = open('#/task/task', site({ task: aTask({ state: 'held' }), runs: [ended({ session_ref: 'sess-1' })] }));
  const box = await screen.findByRole('textbox', { name: '继续发送指令' });
  expect(box).toHaveAttribute('placeholder', '发送后续指令，续接原会话继续执行');
  await user.type(box, '  已补齐凭据，继续跑  ');
  await user.click(screen.getByRole('button', { name: '继续发送指令' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/tasks/task/continue', method: 'POST', body: { note: '已补齐凭据，继续跑' } }]));
  await waitFor(() => expect(box).toHaveValue(''));
});

test('the dispatch note shows what that round was sent out with, and the whole brief on request', async () => {
  const brief = '## 目标\n\n历史目标\n\n## 验收标准\n\n历史验收\n\n## 范围\n\n只动这个目录';
  const snapshot = deferred();
  open('#/task/task', site({ runs: [aRun({ state: 'running' })], snapshots: { run: () => snapshot.promise } }));
  await loaded();
  expect(await screen.findByRole('status', { name: '正在读取快照' })).toBeInTheDocument();
  expect(screen.getByText('快照尚未加载')).toBeInTheDocument();
  snapshot.resolve({ snapshot: { brief } });
  expect(await screen.findByText('历史目标')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: '正在读取快照' })).not.toBeInTheDocument();
  const note = screen.getByRole('heading', { name: '派发说明 · 第 1 轮' }).closest('section')!;
  expect(within(note).getByText(/ · 执行中$/)).toBeInTheDocument();
  expect(within(note).getByText('验收标准')).toBeInTheDocument();
  expect(within(note).getByText('历史验收')).toBeInTheDocument();
  // The Task as it stands now is said apart from the round, under its own heading.
  expect(within(note).queryByText('目标'), '另一个修订的轮次不拿任务现在的目标充数').not.toBeInTheDocument();
  expect(within(screen.getByText('现在的目标与验收标准').closest('details')!).getByText('目标')).toBeInTheDocument();
  const whole = screen.getByText('查看完整派发说明').closest('details')!;
  expect(within(whole).getByText(/只动这个目录/).tagName).toBe('PRE');
  expect(within(whole).getByText(/只动这个目录/).textContent).toBe(brief);
});

test('a round whose brief has no summary falls back to the Task only when it is the same revision', async () => {
  const other = open('#/task/task', site({ runs: [aRun({ state: 'running', task_revision: 1 })] }));
  expect(await screen.findByText('该轮派发说明未记录目标摘要')).toBeInTheDocument();
  expect(screen.getByText('该轮派发说明未记录验收摘要')).toBeInTheDocument();
  other.unmount();

  open('#/task/task', site({ runs: [aRun({ state: 'running', task_revision: 2 })] }));
  const round = (await screen.findByRole('heading', { name: '派发说明 · 第 1 轮' })).closest('section')!;
  expect(await within(round).findByText('目标')).toBeInTheDocument();
  expect(within(round).getByText('验收')).toBeInTheDocument();
});

const WORK_EVENTS = [
  { kind: 'text', text: '第一' }, { kind: 'text', text: '段。' },
  { kind: 'thinking', text: '想一想' },
  { kind: 'tool.start', id: 'a', category: 'read', name: 'Read', title: 'Read' }, { kind: 'tool.end', id: 'a', isError: false },
  { kind: 'tool.start', id: 'b', category: 'edit', name: 'Edit', title: 'Edit' }, { kind: 'tool.end', id: 'b', isError: true },
  { kind: 'tool.start', id: 'c', category: 'search', name: 'Grep', title: 'Grep' },
  { kind: 'tool.start', id: 'd', category: 'run', name: 'Bash', title: 'Bash' }, { kind: 'tool.end', id: 'd', isError: false },
  { kind: 'tool.start', id: 'e', category: 'other', name: 'WebFetch', title: 'WebFetch' }, { kind: 'tool.end', id: 'e', isError: false },
  { kind: 'usage', usage: {} }, { kind: 'turn.end' },
  { kind: 'diagnostic', level: 'recovering', message: '限流', attempt: 2, maxRetries: 5 },
  { kind: 'truncated', dropped: 12 },
  { kind: 'diagnostic', level: 'fatal', message: '额度用完', cause: 'quota' },
  { kind: 'interrupted' },
];

test('the site shows what the Worker said and each tool call with its kind and how it ended', async () => {
  open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: { events: WORK_EVENTS, first_index: 0, loaded: true } } }));
  expect(await screen.findByText('第一段。'), '连着的两段话是一段').toBeInTheDocument();
  // It went on to use tools: what it thought is a record now, folded.
  const thinking = screen.getByText('思考记录').closest('details')!;
  expect(thinking).not.toHaveAttribute('open');
  expect(within(thinking).getByText('想一想')).toBeInTheDocument();
  expect(screen.queryByText('思考中…')).toBeNull();

  const kinds = ['Read', 'Edit', 'Grep', 'Bash', 'WebFetch'].map((name) => [tool(name).dataset.tool, line(name)]);
  expect(kinds).toEqual([['read', 'Read完成'], ['edit', 'Edit失败'], ['search', 'Grep进行中'], ['run', 'Bash完成'], ['other', 'WebFetch完成']]);
  // The first drawing of a line is the mark that it folds; the second says what kind of call it is.
  const icon = (name: string): SVGElement => tool(name).querySelectorAll('svg')[1]!;
  for (const name of ['Read', 'Edit', 'Grep', 'Bash']) expect(icon(name)).toHaveAttribute('aria-hidden', 'true');
  const drawings = ['Read', 'Edit', 'Grep', 'Bash'].map((name) => icon(name).innerHTML);
  expect(new Set(drawings).size, '四类工具各有各的图标').toBe(4);
  expect(icon('WebFetch').innerHTML, '别的类别按命令画').toBe(icon('Bash').innerHTML);
  expect(tool('Grep').querySelector('[data-tone="running"]'), '进行中的有蓝点').not.toBeNull();
  expect(tool('Read').querySelector('[data-tone]')).toBeNull();

  // The retry is over (the round went on): it is one of the things folded into one line.
  expect(screen.getByText('受阻重试 1 次')).toBeInTheDocument();
  expect(screen.queryByText(/受阻重试中/)).toBeNull();
  expect(screen.getByText('更早的 12 条事件已丢弃，只保留最近 5000 条')).toBeInTheDocument();
  expect(screen.getByText('额度用完')).toHaveClass('text-destructive');
  expect(screen.getByText('执行已中断')).toBeInTheDocument();
});

test('a round in a retry says which attempt it is on, until it does something again', async () => {
  open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: { events: [
    { kind: 'text', text: '开始' },
    { kind: 'diagnostic', level: 'recovering', message: 'unknown', attempt: 2, maxRetries: 10 },
  ], first_index: 0, loaded: true } } }));
  expect(await screen.findByText('受阻重试中（第 2/10 次）')).toBeInTheDocument();
});

// The round the owner's screenshot showed (tests/fixtures/codex/0.162.0/site-windows.*),
// cut down to its shapes: a configuration warning Codex said twice, four reads of three
// files, a failed command, a table in the reply.
const NOISY = [
  { kind: 'diagnostic', level: 'warning', message: 'Codex is ignoring 1 unrecognized configuration setting.' },
  { kind: 'diagnostic', level: 'warning', message: 'Codex is ignoring 1 unrecognized configuration setting.' },
  { kind: 'text', text: '我先读取 brief。' },
  ...[['1', 'brief.md'], ['2', 'brief.md'], ['3', 'context.json'], ['4', 'skills/release.md']].flatMap(([id, path]) => [
    { kind: 'tool.start', id, category: 'read', name: 'command_execution', title: `Get-Content -Raw -LiteralPath '${path}'`, input: `"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content -Raw -LiteralPath '${path}'"`, paths: [path] },
    { kind: 'tool.end', id, isError: false, exitCode: 0, output: { text: `${path} 的内容` } },
  ]),
  { kind: 'tool.start', id: '7', category: 'run', name: 'command_execution', title: 'git status; rg --files adapters', input: '"powershell.exe" -Command "git status; rg --files adapters"' },
  { kind: 'tool.end', id: '7', isError: true, exitCode: 1, output: { text: "rg : 无法将“rg”项识别为 cmdlet\n    + CategoryInfo : ObjectNotFound", omittedBytes: 2048 } },
  { kind: 'text', text: '| 文件 | 职责 |\n|---|---|\n| `all.ts` | 注册 |' },
];

test('a noisy round reads quietly: warnings in one gray line, reads in one group, a failure by its state and reason', async () => {
  const { user } = open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: { events: NOISY, first_index: 0, loaded: true } } }));
  await screen.findByText('我先读取 brief。');
  // Said twice, shown as one, and not as an error.
  const said = screen.getByText('执行器告警 1 条');
  expect(said.closest('[data-diagnostics]')).not.toBeNull();
  expect(said.closest('details')).not.toHaveAttribute('open');
  const box = said.closest('[data-diagnostics]')!;
  expect(within(box as HTMLElement).getAllByText(/Codex is ignoring/)).toHaveLength(1);
  expect(within(box as HTMLElement).getByText('告警 · 出现 2 次')).toBeInTheDocument();
  expect(document.querySelector('.text-destructive')?.textContent ?? '').not.toMatch(/Codex is ignoring/);

  // Four reads, three files, one line.
  const group = screen.getByText('读取 4 次，3 个文件').closest('[data-group]')!;
  expect(group.querySelector('summary')!.textContent).toBe('读取 4 次，3 个文件完成');
  await user.click(group.querySelector('summary')!);
  expect(group.querySelectorAll('[data-tool="read"]')).toHaveLength(4);

  // The failed command: its title stays plain, its state and reason say it failed.
  const failed = tool('git status; rg --files adapters');
  expect(failed.dataset.status).toBe('failed');
  expect(failed.querySelector('summary span.truncate')).not.toHaveClass('text-destructive');
  expect(within(failed).getByText('失败')).toHaveClass('whitespace-nowrap', 'flex-none');
  expect(within(failed).getByText('退出码 1')).toHaveClass('text-destructive');
  await user.click(failed.querySelector('summary')!);
  expect(within(failed).getByText(/powershell\.exe" -Command/), '原文整条可查').toBeInTheDocument();
  expect(within(failed).getByText(/CommandNotFoundException|ObjectNotFound/)).toBeInTheDocument();
  expect(within(failed).getByText(/tycho 只留了开头和结尾，中间省略 2048 字节/)).toBeInTheDocument();
  expect(within(failed).getByText(/工具：command_execution · 退出码 1/)).toBeInTheDocument();

  // The reply's table is a table.
  expect(screen.getByRole('table')).toBeInTheDocument();
});

test('once a round has ended, its report comes first and its process is folded, failures counted on the fold', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'ready' }),
    runs: [ended({ receipt: { status: 'done', summary: '改好了', artifacts: [] } })],
    events: { run: { events: [
      ...NOISY,
      { kind: 'tool.start', id: 'w', category: 'edit', name: 'Write', title: 'src/a.ts', paths: ['src/a.ts'] },
      { kind: 'tool.end', id: 'w', isError: false, changes: [{ path: 'src/a.ts', op: 'add' }] },
      { kind: 'tool.end', id: 'f', isError: false, call: { category: 'edit', name: 'file_change', title: 'src/b.ts', paths: ['src/b.ts'] }, changes: [{ path: 'src/b.ts', op: 'update', patch: '@@ -1 +1 @@\n-a\n+b' }] },
    ], first_index: 0, loaded: true } },
  }));
  expect(await screen.findByText('改好了')).toBeInTheDocument();
  const fold = screen.getByText('过程记录 · 7 次工具调用，1 次失败').closest('details')!;
  expect(fold).not.toHaveAttribute('open');
  expect(within(fold).getByText('我先读取 brief。')).toBeInTheDocument();
  // What it changed stands outside the fold, a patch only where one was given.
  const changes = screen.getByRole('region', { name: '文件变化' });
  expect(fold.contains(changes)).toBe(false);
  expect([...changes.querySelectorAll('li')].map((item) => [item.dataset.change, item.querySelector('.font-mono')!.textContent])).toEqual([['add', 'src/a.ts'], ['update', 'src/b.ts']]);
  expect(within(changes).getAllByText('查看改动')).toHaveLength(1);
});

test('a tool call still open when its Run ended reads as unfinished, never as running', async () => {
  open('#/task/task', site({ task: aTask({ state: 'held' }), runs: [ended()], events: { run: { events: [{ kind: 'tool.start', id: 'c', category: 'search', name: 'Grep', title: 'Grep' }], first_index: 0, loaded: true } } }));
  await screen.findByText('Grep');
  expect(line('Grep')).toBe('Grep未完成');
  expect(tool('Grep').querySelector('[data-tone]')).toBeNull();
});

const report = (index: number): HTMLElement => screen.getAllByRole('heading', { name: '汇报' })[index]!.closest('section')!;

test('a report shows how the round ended and what it handed back, or why there is nothing', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'held', reason: '连续 3 次执行都丢失' }),
    runs: [
      ended({ id: 'r1', created_at: later(0), ended_at: later(1), receipt: {
        status: 'done', summary: '**做完了**', artifacts: [{ kind: 'commit', ref: 'abc123' }],
        ask: [{ question: '合并吗？' }], later: { at: later(600), about: '复查' },
      } }),
      ended({ id: 'r2', created_at: later(2), ended_at: later(3), exit_kind: 'failed', error: { reason: '回执格式不对' } }),
      ended({ id: 'r3', created_at: later(4), ended_at: later(5), exit_kind: 'interrupted', error: { message: '被中断了' } }),
      ended({ id: 'r4', created_at: later(6), ended_at: later(7), exit_kind: 'lost' }),
      ended({ id: 'r5', created_at: later(8), ended_at: later(9), exit_kind: 'lost' }),
    ],
  }));
  await loaded();
  await waitFor(() => expect(screen.getAllByRole('heading', { name: '汇报' })).toHaveLength(5));
  const first = report(0);
  expect(first.textContent).toMatch(/^汇报完成/);
  expect(within(first).getByText('已完成')).toBeInTheDocument();
  expect(within(first).getByText('做完了').tagName).toBe('STRONG');
  expect(within(first).getByText('abc123').parentElement!.textContent).toBe('commitabc123');
  expect(within(first).getByText('待决定：合并吗？')).toBeInTheDocument();
  expect(within(first).getByText(/^后续预约：.* · 复查$/)).toBeInTheDocument();
  expect(report(1).textContent).toMatch(/^汇报失败.*回执格式不对$/);
  expect(report(2).textContent).toMatch(/^汇报已中断.*被中断了$/);
  expect(report(3).textContent, '不是最后一轮，不拿任务现在的原因充数').toMatch(/^汇报执行丢失.*本轮没有可用回执，保留现场供核对。$/);
  expect(report(4).textContent).toMatch(/^汇报执行丢失.*连续 3 次执行都丢失$/);
  // The detail column gathers what every round handed back.
  expect(within(screen.getByText('任务详情').closest('details')!).getByText('abc123')).toBeInTheDocument();
});

test('an artifact that is a pull request is a link to it, and other artifacts stay as they were', async () => {
  const PR = 'https://github.com/o/r/pull/7';
  open('#/task/task', site({
    task: aTask({ state: 'held' }),
    runs: [ended({ id: 'r1', receipt: {
      status: 'done', summary: '改好了',
      artifacts: [{ kind: 'pr', ref: PR }, { kind: 'commit', ref: 'abc123' }],
    } })],
  }));
  await loaded();
  // 回执和右栏的“产物”都从一个列表画出来：两处都是外链，都带 noopener。
  const links = await screen.findAllByRole('link', { name: PR });
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link).toHaveAttribute('href', PR);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  }
  const commit = screen.getAllByText('abc123');
  expect(commit.length).toBeGreaterThan(0);
  for (const shown of commit) expect(shown.tagName).toBe('CODE');
});

test('a round that handed nothing back says there are no artifacts, and a Run still going has no report', async () => {
  open('#/task/task', site({ task: aTask({ state: 'running' }), runs: [ended({ id: 'r1', receipt: { status: 'waiting', summary: '等数据' } }), aRun({ id: 'r2', state: 'running', created_at: later(10) })] }));
  await loaded();
  await waitFor(() => expect(screen.getAllByRole('heading', { name: '汇报' })).toHaveLength(1));
  expect(within(report(0)).getByText('等待后续安排')).toBeInTheDocument();
  expect(within(report(0)).getByText('暂无产物')).toBeInTheDocument();
});

test('an interjection says what became of it: void, waiting, bound, or bound to a Run nobody can speak for', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'needs_verification' }),
    runs: [ended({ id: 'r1', ended_at: later(1) }), aRun({ id: 'r2', state: 'unknown', created_at: later(2) })],
    inputs: [
      { id: 'i1', run_id: null, text: '作废的话', state: 'void', created_at: later(3) },
      { id: 'i2', run_id: null, text: '排着的话', state: 'queued', created_at: later(4) },
      { id: 'i3', run_id: 'r1', text: '送到的话', state: 'bound', created_at: later(5) },
      { id: 'i4', run_id: 'r2', text: '不知道的话', state: 'bound', created_at: later(6) },
    ],
  }));
  await screen.findByText('作废的话');
  const label = (text: string): string => screen.getByText(text).parentElement!.querySelector('time')!.textContent!;
  expect(label('作废的话')).toMatch(/ · 插话已作废$/);
  expect(label('排着的话')).toMatch(/ · 等待下一次 Run$/);
  expect(label('送到的话')).toMatch(/ · 已绑定到第 1 轮$/);
  expect(label('不知道的话')).toMatch(/ · 是否执行未确认，不会自动重发$/);
});

test('an open question of the task is answered on its page', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'waiting_person' }), runs: [ended()],
    approvals: [
      { id: 'a1', task_id: 'task', state: 'open', questions: [{ question: '选哪个？', options: ['甲', '乙'] }], answers: null, answered_via: null },
      { id: 'a0', task_id: 'task', state: 'answered', questions: [{ question: '早先的问题' }], answers: ['好'], answered_via: 'console' },
    ],
  }));
  expect(await screen.findByText('选哪个？')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '等你决定 · 工作' })).toBeInTheDocument();
  expect(screen.queryByText('早先的问题'), '答过的问题不再占着任务页').not.toBeInTheDocument();
});

const emit = (data: object) => act(async () => { runStreams().at(-1)!.emit('run_event', data); });
const eventReads = (reads: string[]): number => reads.filter((path) => path === '/api/runs/run/events').length;

test('pushed events continue the snapshot by number, and a hole is filled by reading again before anything past it shows', async () => {
  let record: object[] = [{ kind: 'tool.start', id: 'a', category: 'read', name: 'Read', title: 'Read' }];
  let hold: Promise<unknown> | undefined;
  const { reads } = open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: async () => {
    const answer = { events: record, first_index: 0, loaded: true };
    await hold;
    return answer;
  } } }));
  await screen.findByText('Read');
  expect(line('Read')).toBe('Read进行中');
  const before = eventReads(reads);

  await emit({ run_id: 'run', index: 1, event: { kind: 'tool.end', id: 'a', isError: false } });
  expect(line('Read')).toBe('Read完成');
  await emit({ run_id: 'elsewhere', index: 2, event: { kind: 'text', text: '别的 Run 的话' } });
  expect(screen.queryByText('别的 Run 的话')).not.toBeInTheDocument();
  expect(eventReads(reads), '接得上就不用再读').toBe(before);

  // Number 2 never arrived. The record on the service has it.
  record = [...record, { kind: 'tool.end', id: 'a', isError: false }, { kind: 'tool.start', id: 'b', category: 'edit', name: 'Edit', title: 'Edit' }, { kind: 'tool.start', id: 'c', category: 'run', name: 'Bash', title: 'Bash' }];
  // The read is held back: until it answers, nothing past the hole may show.
  const hole = deferred();
  hold = hole.promise;
  await emit({ run_id: 'run', index: 3, event: { kind: 'tool.start', id: 'c', category: 'run', name: 'Bash', title: 'Bash' } });
  expect(screen.queryByText('Bash'), '缺口后面的事件抢先显示了').not.toBeInTheDocument();
  expect(eventReads(reads)).toBe(before + 1);
  hole.resolve(undefined);
  expect(await screen.findByText('Bash')).toBeInTheDocument();
  expect(screen.getByText('Edit'), '缺的那条补上了').toBeInTheDocument();
});

test('a hole that cannot be read is said, and goes away once it is filled', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let down = false;
    // How much of the record the service has when asked.
    let written = 1;
    const record = [{ kind: 'text', text: '开头' }, { kind: 'text', text: '，中间' }, { kind: 'text', text: '，结尾' }];
    open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: () => {
      if (down) throw refusal('断线', 503);
      return { events: record.slice(0, written), first_index: 0, loaded: true };
    } } }));
    await screen.findByText('开头');
    down = true;
    await emit({ run_id: 'run', index: 2, event: record[2]! });
    expect(await screen.findByText('现场读取失败，重试中')).toBeInTheDocument();
    expect(screen.queryByText(/结尾/)).not.toBeInTheDocument();
    down = false;
    written = 3;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(await screen.findByText('开头，中间，结尾')).toBeInTheDocument();
    expect(screen.queryByText('现场读取失败，重试中')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test('a broken stream is said, and the site is read again when the browser has connected it again', async () => {
  holdClock();
  let record: object[] = [{ kind: 'text', text: '断线之前' }];
  const { reads } = open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: () => ({ events: record, first_index: 0, loaded: true }) } }));
  await screen.findByText('断线之前');
  const before = eventReads(reads);
  await act(async () => { runStreams()[0]!.fail(); });
  expect(screen.getByText('现场连接已断开，重连后重新读取记录')).toBeInTheDocument();
  record = [...record, { kind: 'tool.start', id: 'x', category: 'run', name: '断线期间的命令', title: '断线期间的命令' }];
  // Nobody closed it: the browser connects it again by itself.
  await pass(FakeEventSource.RECONNECT_MS);
  expect(await screen.findByText('断线期间的命令')).toBeInTheDocument();
  expect(runStreams(), '页面不自己再开一条').toHaveLength(1);
  expect(screen.queryByText('现场连接已断开，重连后重新读取记录')).not.toBeInTheDocument();
  expect(eventReads(reads)).toBe(before + 1);
});

test('a first read of the site that fails is said and tried again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let down = true;
    open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: () => { if (down) throw refusal('断线', 503); return { events: [{ kind: 'text', text: '读到了' }], first_index: 0, loaded: true }; } } }));
    expect(await screen.findByText('现场读取失败，重试中')).toBeInTheDocument();
    down = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(await screen.findByText('读到了')).toBeInTheDocument();
    expect(screen.queryByText('现场读取失败，重试中')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

const TWO_ROUNDS: Site = {
  task: aTask({ state: 'running' }),
  runs: [ended({ id: 'r1', ended_at: later(1) }), aRun({ id: 'r2', state: 'running', created_at: later(2) })],
  events: {
    r1: { events: [{ kind: 'text', text: '第一轮的话' }], first_index: 0, loaded: true },
    r2: { events: [{ kind: 'text', text: '第二轮的话' }], first_index: 0, loaded: true },
  },
  inputs: [
    { id: 'i1', run_id: 'r2', text: '给第二轮的话', state: 'bound', created_at: later(3) },
    { id: 'i2', run_id: null, text: '还没送的话', state: 'queued', created_at: later(4) },
  ],
};

test('picking a round in the Run history shows that round alone, and "全部现场" brings them all back', async () => {
  const { user } = open('#/task/task', site(TWO_ROUNDS));
  await screen.findByText('第二轮的话');
  expect(screen.getByText('第一轮的话')).toBeInTheDocument();
  expect(runStreams().map((source) => source.url), '只有没结束的那一轮开流').toEqual(['/api/stream?runs=r2']);
  const all = screen.getByRole('button', { name: '全部现场' });
  const first = screen.getByRole('button', { name: /^第 1 轮 · 完成/ });
  const second = screen.getByRole('button', { name: /^第 2 轮 · 执行中/ });
  expect([all.getAttribute('aria-pressed'), first.getAttribute('aria-current'), second.getAttribute('aria-current')]).toEqual(['true', 'false', 'false']);

  await user.click(first);
  await screen.findByText('第一轮的话');
  expect(screen.queryByText('第二轮的话')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '派发说明 · 第 2 轮' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '派发说明 · 第 1 轮' })).toBeInTheDocument();
  expect(screen.getAllByRole('heading', { name: '汇报' })).toHaveLength(1);
  expect(screen.queryByText('给第二轮的话')).not.toBeInTheDocument();
  expect(screen.getByText('还没送的话'), '还没绑定的插话哪一轮都看得到').toBeInTheDocument();
  expect([all.getAttribute('aria-pressed'), first.getAttribute('aria-current'), second.getAttribute('aria-current')]).toEqual(['false', 'true', 'false']);
  expect(runStreams().map((source) => source.closed), '换了一轮，旧的流要关掉；已结束的不开新的').toEqual([true]);

  await user.click(second);
  await screen.findByText('第二轮的话');
  expect(screen.queryByText('第一轮的话')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '派发说明 · 第 2 轮' }), '轮次的编号不随筛选变').toBeInTheDocument();
  expect(runStreams().map((source) => [source.url, source.closed])).toEqual([['/api/stream?runs=r2', true], ['/api/stream?runs=r2', false]]);

  await user.click(all);
  await screen.findByText('第一轮的话');
  expect(screen.getByText('第二轮的话')).toBeInTheDocument();
  expect(screen.getByText('给第二轮的话')).toBeInTheDocument();
});

test('leaving the page closes its stream', async () => {
  const view = open('#/task/task', site({ runs: [aRun({ state: 'running' })] }));
  await loaded();
  await waitFor(() => expect(runStreams().map((source) => source.closed)).toEqual([false]));
  view.unmount();
  expect(runStreams().map((source) => source.closed)).toEqual([true]);
});

const TRACE = {
  trigger: { label: '负责人处理消息时派发', message: { text: '把**这个**做了' }, change: { at: later(1), actor: 'router', action: 'task.queue' } },
  inputs: [{ text: '顺便看下日志' }], session_ref: null, task_revision: 1,
  dispatchConditions: { paused: false, target: 't1' },
  changes: [{ at: later(1), actor: 'router', action: 'task.queue' }, { at: later(2), actor: 'runner', action: 'run.start' }],
};

test('the trace drawer says why the round started, and closes by its button or Escape', async () => {
  const gate = deferred();
  const { user, reads } = open('#/task/task', site({ runs: [aRun({ state: 'running' })], on: (call) => (call.path.endsWith('/trace') ? gate.promise : undefined) }));
  await loaded();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '为什么开始这一轮' }));
  const drawer = await screen.findByRole('dialog', { name: '第 1 轮为什么开始' });
  expect(within(drawer).getByText('正在读取…')).toBeInTheDocument();
  expect(reads).toContain('/api/runs/run/trace');
  gate.resolve(TRACE);
  expect(await within(drawer).findByText('负责人处理消息时派发')).toBeInTheDocument();
  expect(within(drawer).queryByText('正在读取…')).not.toBeInTheDocument();
  for (const heading of ['触发', '绑定的插话', '沿用的执行器会话', '派发时的条件']) expect(within(drawer).getByRole('heading', { name: heading })).toBeInTheDocument();
  expect(within(drawer).getByText('这个').tagName).toBe('STRONG');
  expect(within(drawer).getByText(/ · router · task\.queue$/)).toBeInTheDocument();
  expect(within(drawer).getByText('顺便看下日志')).toBeInTheDocument();
  expect(within(drawer).getByText('本轮新开')).toBeInTheDocument();
  expect(within(drawer).getByText('快照修订 1')).toBeInTheDocument();
  expect(within(drawer).getByText(/"target": "t1"/).tagName).toBe('PRE');
  const changes = within(drawer).getByText('相关状态变更').closest('details')!;
  expect(within(changes).getByText(/ · run\.start · runner$/)).toBeInTheDocument();

  await user.click(within(drawer).getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  await user.click(screen.getByRole('button', { name: '为什么开始这一轮' }));
  await screen.findByRole('dialog');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('a committed tool call is visible even when the model reply was interrupted', async () => {
  const { user } = open('#/task/task', site({
    runs: [aRun({ state: 'running' })],
    on: (call) => call.path.endsWith('/trace') ? {
      ...TRACE,
      trigger: { ...TRACE.trigger, tool_call: {
        id: 'create-call', name: 'create_task', message_ids: ['message'], started_at: later(1),
        request: '{"title":"QL 验证"}', result: null, result_state: 'interrupted', receipt_confirmed: false,
        committed: [{ action: 'task.create', task_id: 'task', run_id: null, at: later(1) }],
      } },
      settlement: { at: later(2), task_state: 'ready', exit_kind: 'completed', delivery: 'pending' },
    } : undefined,
  }));
  await loaded();
  await user.click(screen.getByRole('button', { name: '为什么开始这一轮' }));
  const drawer = await screen.findByRole('dialog');
  expect(await within(drawer).findByText('账本已提交操作。')).toBeVisible();
  expect(within(drawer).getByText('负责人是否收到结果未知。')).toBeVisible();
  await user.click(within(drawer).getByText('查看工具输入与结果'));
  expect(within(drawer).getByText(/QL 验证/)).toBeVisible();
  expect(within(drawer).getByText('结果正文未记录。')).toBeVisible();
  expect(within(drawer).getByText('结果通知已入出站队列。')).toBeVisible();
});

test('a trace with nothing recorded says so, part by part' , async () => {
  const { user } = open('#/task/task', site({
    runs: [aRun({ state: 'running' })],
    on: (call) => (call.path.endsWith('/trace') ? { trigger: { label: '定时唤醒' }, inputs: [], session_ref: 'sess-9', task_revision: 2, changes: [] } : undefined),
  }));
  await loaded();
  await user.click(screen.getByRole('button', { name: '为什么开始这一轮' }));
  const drawer = await screen.findByRole('dialog');
  expect(await within(drawer).findByText('定时唤醒')).toBeInTheDocument();
  expect(within(drawer).getByText('账本里未找到可核实的触发记录')).toBeInTheDocument();
  expect(within(drawer).getByText('没有绑定的插话')).toBeInTheDocument();
  expect(within(drawer).getByText('sess-9')).toBeInTheDocument();
  expect(within(drawer).getByText('这轮没有记录派发条件，无法还原')).toBeInTheDocument();
});

test('a trace that cannot be read shows why in the drawer', async () => {
  const { user } = open('#/task/task', site({ runs: [aRun({ state: 'running' })], on: (call) => { if (call.path.endsWith('/trace')) throw refusal('Run 不存在：run', 400); return undefined; } }));
  await loaded();
  await user.click(screen.getByRole('button', { name: '为什么开始这一轮' }));
  const drawer = await screen.findByRole('dialog');
  expect(await within(drawer).findByText('Run 不存在：run')).toBeInTheDocument();
  expect(within(drawer).queryByText('正在读取…')).not.toBeInTheDocument();
});

test('a trace that answers after its drawer was closed, or for another round, is not shown', async () => {
  holdClock();
  const gates: Record<string, ReturnType<typeof deferred>> = { r1: deferred(), r2: deferred() };
  const { user } = open('#/task/task', site({ ...TWO_ROUNDS, on: (call) => {
    const id = /^\/api\/runs\/(r\d)\/trace$/.exec(call.path)?.[1];
    return id ? gates[id]!.promise : undefined;
  } }));
  await screen.findByText('第二轮的话');
  // With every round in view, the trace is the latest round's.
  await user.click(screen.getByRole('button', { name: '为什么开始这一轮' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await act(async () => { gates.r2!.resolve({ ...TRACE, trigger: { label: '第二轮的触发' } }); });
  // Nothing to wait for: the answer must change nothing.
  await pass();
  expect(screen.queryByRole('dialog'), '关掉以后，迟到的答复不该把抽屉再打开').not.toBeInTheDocument();
  expect(screen.queryByText('第二轮的触发')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^第 1 轮/ }));
  await screen.findByText('第一轮的话');
  await user.click(screen.getByRole('button', { name: '为什么开始这一轮' }));
  const drawer = await screen.findByRole('dialog', { name: '第 1 轮为什么开始' });
  await act(async () => { gates.r1!.resolve({ ...TRACE, trigger: { label: '第一轮的触发' } }); });
  expect(await within(drawer).findByText('第一轮的触发'), '选了哪一轮就追溯哪一轮').toBeInTheDocument();
});

test('a round that starts by itself while a trace is on its way shuts the drawer, and the late answer shows in no drawer: opened again, it is the new round that is traced', async () => {
  holdClock();
  const gates: Record<string, ReturnType<typeof deferred>> = { r1: deferred(), r2: deferred() };
  const task: Site = {
    task: aTask({ state: 'needs_verification' }),
    runs: [aRun({ id: 'r1' })],
    on: (call) => {
      const id = /^\/api\/runs\/(r\d)\/trace$/.exec(call.path)?.[1];
      return id ? gates[id]!.promise : undefined;
    },
  };
  const { user } = open('#/task/task', site(task));
  await loaded();
  const trigger = screen.getByRole('button', { name: '为什么开始这一轮' });
  await user.click(trigger);
  expect(within(await screen.findByRole('dialog', { name: '第 1 轮为什么开始' })).getByText('正在读取…')).toBeInTheDocument();

  // The machine is judged gone and the task goes on by itself: a second round.
  task.task = aTask({ state: 'running' });
  task.runs = [ended({ id: 'r1', exit_kind: 'lost', ended_at: later(1) }), aRun({ id: 'r2', state: 'running', created_at: later(2) })];
  await act(async () => { shellStream().emit('changed', {}); });
  await screen.findByRole('heading', { name: '派发说明 · 第 2 轮' });
  await waitFor(() => expect(screen.queryByRole('dialog'), '轮次变了，抽屉还开着').not.toBeInTheDocument());

  await act(async () => { gates.r1!.resolve({ ...TRACE, trigger: { label: '第一轮的触发' } }); });
  // Nothing to wait for: the answer must change nothing.
  await pass();
  expect(screen.queryByRole('dialog'), '上一轮迟到的答复把抽屉又打开了').not.toBeInTheDocument();

  await user.click(trigger);
  const drawer = await screen.findByRole('dialog', { name: '第 2 轮为什么开始' });
  expect(within(drawer).getByText('正在读取…')).toBeInTheDocument();
  expect(within(drawer).queryByText('第一轮的触发'), '上一轮的答复出现在这一轮的抽屉里').not.toBeInTheDocument();
  await act(async () => { gates.r2!.resolve({ ...TRACE, trigger: { label: '第二轮的触发' } }); });
  expect(await within(drawer).findByText('第二轮的触发')).toBeInTheDocument();
});

test('when the trace drawer shuts, by its button or by Escape, the focus is back on the button that opened it', async () => {
  const { user } = open('#/task/task', site({ runs: [aRun({ state: 'running' })], on: (call) => (call.path.endsWith('/trace') ? TRACE : undefined) }));
  await loaded();
  const trigger = screen.getByRole('button', { name: '为什么开始这一轮' });
  for (const shut of [() => user.keyboard('{Escape}'), () => user.click(screen.getByRole('button', { name: '关闭' }))]) {
    await user.click(trigger);
    const drawer = await screen.findByRole('dialog');
    // The focus goes into the drawer while it is open.
    await waitFor(() => expect(drawer).toContainElement(document.activeElement as HTMLElement));
    await shut();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  }
});

test('a Run that ends has its stream closed, and its record read once more for what it pushed last', async () => {
  let record: object[] = [{ kind: 'text', text: '开头' }];
  const task: Site = { task: aTask({ state: 'running' }), runs: [aRun({ state: 'running' })], events: { run: () => ({ events: record, first_index: 0, loaded: true }) } };
  const { reads } = open('#/task/task', site(task));
  await screen.findByText('开头');
  await waitFor(() => expect(runStreams().map((source) => source.closed)).toEqual([false]));
  const before = eventReads(reads);

  // The Run is settled. Its last words went out on a stream this page may not have heard to the end.
  record = [...record, { kind: 'text', text: '，收尾' }];
  task.task = aTask({ state: 'ready' });
  task.runs = [ended()];
  await act(async () => { shellStream().emit('changed', {}); });
  await screen.findByRole('heading', { name: '汇报' });
  await waitFor(() => expect(runStreams().map((source) => source.closed), '已结束的 Run 还占着一条流').toEqual([true]));
  expect(await screen.findByText('开头，收尾')).toBeInTheDocument();
  expect(eventReads(reads)).toBe(before + 1);
});

test('coming back to a task page leaves one stream open for it, however many times the page was mounted', async () => {
  open('#/task/task', site({ runs: [aRun({ state: 'running' })] }));
  await loaded();
  await waitFor(() => expect(runStreams().filter((source) => !source.closed)).toHaveLength(1));
  await go('#/');
  expect(runStreams().filter((source) => !source.closed)).toHaveLength(0);
  // What it read is kept: this time the page has its Runs from the first draw, which
  // StrictMode makes twice.
  await go('#/task/task');
  await loaded();
  await waitFor(() => expect(runStreams().filter((source) => !source.closed)).toHaveLength(1));
  expect(sources.filter((source) => source.url === '/api/stream' && !source.closed), '负责人的流也只有一条').toHaveLength(1);
});

test('the task page opens at its head, and goes down with what the Worker adds only once the reader has gone to its end', async () => {
  const gate = deferred();
  const { container } = open('#/task/task', site({ runs: [aRun({ state: 'running' })], on: (call) => (call.path === '/api/tasks/task' ? gate.promise : undefined) }));
  await waitFor(() => expect(document.querySelector('[data-slot="skeleton-page"]')).not.toBeNull());
  const scroll = container.querySelector<HTMLElement>('[data-scroll]')!;
  let height = 2000;
  Object.defineProperty(scroll, 'scrollHeight', { get: () => height, configurable: true });
  Object.defineProperty(scroll, 'clientHeight', { get: () => 500, configurable: true });
  const task = aTask({ state: 'running' });
  await act(async () => { gate.resolve({ task, work: task, children: [], runs: [aRun({ state: 'running' })], inputs: [], approvals: [], releases: { version: '1.0.0', last: null, intent: null, attempting: false, fetch: null, packages: [] } }); });
  await loaded();
  expect(scroll.scrollTop, '一打开就被拉到了页尾').toBe(0);
  await waitFor(() => expect(runStreams()).toHaveLength(1));
  const say = async (index: number, text: string): Promise<void> => {
    height += 100;
    await emit({ run_id: 'run', index, event: { kind: 'tool.start', id: text, category: 'run', name: text, title: text } });
    await screen.findByText(text);
  };
  await say(0, '第一条命令');
  expect(scroll.scrollTop, '读者还在页首，新内容把页面拉走了').toBe(0);
  // The reader goes down to the end: from here on the page follows.
  scroll.scrollTop = height - 500;
  fireEvent.scroll(scroll);
  await say(1, '第二条命令');
  expect(scroll.scrollTop).toBe(2200);
});

// The page remembers which sections were opened, by task: each of these has its own.
const detailed = (id: string): Site => ({ ...DETAILED, task: aTask({ id, state: 'held' }) });
const DETAILED: Site = {
  task: aTask({ state: 'held' }),
  work: { id: 'work1', title: '上面的工作', state: 'draft' },
  runs: [ended({ session_ref: 'sess-1', executor: 'claude' })],
  snapshots: { run: { snapshot: { brief: '旧格式', tier: 'decide' } } },
};

test('on a narrow page the details fold under "任务详情" and open on request', async () => {
  const { user } = open('#/task/narrow', site(detailed('narrow')));
  await loaded();
  const details = screen.getByText('任务详情').closest('details')!;
  expect(details, '窄屏下默认收起').not.toHaveAttribute('open');
  expect(within(details).getByText('所属工作')).not.toBeVisible();
  await user.click(screen.getByText('任务详情'));
  await waitFor(() => expect(within(details).getByText('所属工作')).toBeVisible());
});

test('on a wide page the details stand open beside the site, with what the round ran on', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 1180px)', media: query, addEventListener() {}, removeEventListener() {} }));
  open('#/task/task', site(DETAILED));
  await loaded();
  const details = screen.getByText('任务详情').closest('details')!;
  expect(details).toHaveAttribute('open');
  expect(within(details).getByText('所属工作')).toBeVisible();
  expect(within(details).getByRole('link', { name: '上面的工作' })).toHaveAttribute('href', '#/work/work1');
  expect(await within(details).findByText('账号 t1 · h1 · 决策档'), '档位以那一轮的快照为准，按页面名显示').toBeInTheDocument();
  const tech = within(details).getByText('技术细节').closest('details')!;
  expect(within(tech).getByText('当前修订')).toBeInTheDocument();
  expect(within(tech).getByText('2')).toBeInTheDocument();
  expect(within(tech).getByText('这一轮的修订')).toBeInTheDocument();
  expect(within(tech).getByText('1')).toBeInTheDocument();
  expect(within(details).getByText('sess-1')).toBeInTheDocument();
  expect(within(details).getByText('在实例上 claude --resume sess-1 查看。人工操作后，请通过插话说明现场变化。')).toBeInTheDocument();
  expect(within(details).getByText('暂无产物')).toBeInTheDocument();
});

test('the detail column follows the window as it widens and narrows', async () => {
  let notify: (() => void) | undefined;
  const media = { matches: false, media: '', addEventListener: (_type: string, listener: () => void) => { notify = listener; }, removeEventListener() {} };
  vi.stubGlobal('matchMedia', () => media);
  open('#/task/elastic', site(detailed('elastic')));
  await loaded();
  const details = screen.getByText('任务详情').closest('details')!;
  expect(details).not.toHaveAttribute('open');
  media.matches = true;
  await act(async () => { notify?.(); });
  expect(details).toHaveAttribute('open');
});

test('how to look at the native session depends on whether the task is stopped and on the executor', async () => {
  const codex = open('#/task/task', site({ ...DETAILED, runs: [ended({ session_ref: 'sess-2', executor: 'codex' })] }));
  await loaded();
  expect(screen.getByText('可在实例上查阅原生记录。此账号的续接方式未提供。')).toBeInTheDocument();
  codex.unmount();

  open('#/task/task', site({ task: aTask({ state: 'running' }), runs: [aRun({ state: 'running', session_ref: 'sess-3' })] }));
  await loaded();
  expect(screen.getByText('执行期间请在这里查看现场。')).toBeInTheDocument();
  expect(screen.queryByText(/claude --resume/)).not.toBeInTheDocument();
});

test('a task with an appointment says when it starts again', async () => {
  open('#/task/task', site({ task: aTask({ state: 'waiting_timer', wake_at: later(90) }), runs: [ended()] }));
  await loaded();
  expect(screen.getByText(/^预约在 .* 重新开始$/)).toBeInTheDocument();
});

test('a round the quota ended reads as that, says where the Task goes from here, and the history shows which target each round ran on', async () => {
  const until = new Date();
  until.setDate(until.getDate() + 1);
  until.setHours(6, 40, 0, 0);
  open('#/task/task', site({
    task: aTask({ state: 'running', login_id: null }),
    runs: [
      ended({ id: 'r1', login_id: '01K00000000000000000000051', login_name: 'cluster-claude', exit_kind: 'quota', ended_at: later(1), error: { reason: '额度用完', quota: { login_id: 'cluster-claude', login_name: 'cluster-claude', message: 'limit', rest_until: until.toISOString() } } }),
      aRun({ id: 'r2', login_id: '01K00000000000000000000052', login_name: 'cluster-codex', host: 'h2', state: 'running', created_at: later(2), started_at: later(2) }),
    ],
    inputs: [{ id: 'i1', run_id: 'r1', text: '交给第一轮的话', state: 'bound', created_at: later(0) }],
  }));
  await loaded();
  await waitFor(() => expect(screen.getAllByRole('heading', { name: '汇报' })).toHaveLength(1));
  expect(report(0).textContent).toMatch(/^汇报额度用完.*账号 cluster-claude 的额度用完，它歇到 \d\d-\d\d 06:40。任务已回到队列：额度恢复后，或换到项目里别的登录上，自动接续$/);
  expect(report(0).textContent).not.toMatch(/失败|丢失|需要你/);
  const history = screen.getByText('执行记录').closest('section')!;
  expect(within(history).getByRole('button', { name: /第 1 轮/ })).toHaveTextContent('第 1 轮 · 额度用完 · 账号 cluster-claude');
  expect(within(history).getByRole('button', { name: /第 2 轮/ })).toHaveTextContent('第 2 轮 · 执行中 · 账号 cluster-codex');
  // What was handed to the round the quota cut short may or may not have been acted on.
  expect(screen.getByText('交给第一轮的话').parentElement!.querySelector('time')!.textContent).toMatch(/ · 是否执行未确认，不会自动重发$/);
});

test('a queued task says on its own page what it waits for, and one that names no target says the service picks', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'queued', login_id: null, waiting: { rest: null, full: ['cluster-codex'], no_machine: [] } }),
    runs: [],
  }));
  await loaded();
  const details = screen.getByText('任务详情').closest('details')!;
  // What it waits for is said at the head of the page, under its name.
  expect(screen.getByRole('heading', { level: 1 }).parentElement).toHaveTextContent('排队中：等 账号 cluster-codex 空出来');
  expect(details).toHaveTextContent('不指定，由服务挑 · 执行档');
});

test('a long site offers the way to its end and to leave the events out', async () => {
  const events = Array.from({ length: 31 }, (_, index) => ({ kind: 'tool.start', id: `t${index}`, category: 'run', name: 'Bash', title: `命令${index}` }));
  const scrolled = vi.mocked(Element.prototype.scrollIntoView);
  const { user } = open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: { events, first_index: 0, loaded: true } } }));
  await screen.findByText('命令0');
  expect(screen.getByText(/这段现场有 31 条过程记录/)).toBeInTheDocument();
  const only = screen.getByRole('button', { name: '只看汇报' });
  expect(only).toHaveAttribute('aria-pressed', 'false');
  await user.click(only);
  // The dispatch note stays; what the round did, step by step, goes.
  expect(screen.queryByText('命令0')).toBeNull();
  expect(screen.getByRole('heading', { name: '派发说明 · 第 1 轮' })).toBeInTheDocument();
  expect(screen.getByText('过程已收起（31 条），关掉“只看汇报”就能看到。')).toBeInTheDocument();
  await user.click(only);
  expect(screen.getByText('命令0')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '跳到最新' }));
  expect(scrolled).toHaveBeenCalledWith({ block: 'end' });
});

test('a short site offers neither button: there is nowhere to jump and nothing to fold', async () => {
  open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: { events: [{ kind: 'text', text: '一句话' }], first_index: 0, loaded: true } } }));
  await screen.findByText('一句话');
  expect(screen.queryByRole('button', { name: '跳到最新' })).toBeNull();
  expect(screen.queryByRole('button', { name: '只看汇报' })).toBeNull();
});

// Roles (docs/design/roles-and-tiers.md §3): what the page says a Task is and runs on, and
// what the owner's pick sends.
const details = async (): Promise<HTMLElement> => { await loaded(); return screen.getByText('任务详情').closest('details')!; };
const roleForm = (): HTMLElement => screen.getByRole('region', { name: '职能与档位' });
// The list of roles is a read of its own, after the task's.
const rolesListed = (): Promise<HTMLElement> => within(roleForm()).findByRole('option', { name: '审阅' });

test('a task shows its role, the tier it runs on now and where that tier came from', async () => {
  open('#/task/task', site({ task: aTask({ state: 'held' }), runs: [] }));
  const where = await details();
  expect(within(where).getByText('实现', { selector: 'p' })).toBeInTheDocument();
  expect(within(where).getByText('账号 t1 · 执行档（职能默认）')).toBeInTheDocument();
  expect(within(where).queryByText(/^理由：/)).toBeNull();
});

// An operate round on a login with no operate content ran on its execute content: the page
// says so as the snapshot recorded it (roles-and-tiers.md §10.3).
test('a round that ran on the substitute content says which tier it came from', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'held', role_id: 'verify', tier: 'operate', tier_source: 'default' }),
    runs: [ended()],
    snapshots: { run: { snapshot: { brief: '派发', tier: 'operate', tier_from: 'execute', tier_source: 'default', role: PRESET_ROLES.find((role) => role.id === 'verify')! } } },
  }));
  const where = await details();
  expect(await within(where).findByText('账号 t1 · h1 · 操作档（这个登录没填，用的执行档内容）')).toBeInTheDocument();
});

test('a review says its tier follows the round it reviews', async () => {
  const of = {
    task_id: 'base', run_id: 'base-run', revision: 1, title: '被审', goal: '改', scope: null, acceptance: '测试通过',
    files: [], writers: ['codex'], tier: 'execute', at: AT, reviewed_title: '被审的活', reviewed_state: 'ready',
  };
  open('#/task/task', site({
    task: aTask({ state: 'queued', role_id: 'review', tier: 'execute', tier_source: 'reviewed' }),
    runs: [],
    review: { of, verdict: null, reviews: [], needs_review: false, blocked: null, escalations: [] },
  }));
  const where = await details();
  expect(within(where).getByText('审阅', { selector: 'p' })).toBeInTheDocument();
  expect(within(where).getByText('账号 t1 · 执行档（跟着被审的那一轮）')).toBeInTheDocument();
  expect(within(where).queryByText(/^理由：/)).toBeNull();
  // With no override, what the next round runs on is the reviewed round's tier, not the role's.
  const form = roleForm();
  expect(within(form).getByRole('option', { name: '跟被审那一轮（执行档）' })).toBeInTheDocument();
  expect(within(form).queryByRole('option', { name: /跟职能默认/ })).toBeNull();
});

test('an override says so, with its reason when it has one', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'held', role_id: 'verify', tier: 'decide', tier_source: 'override', tier_override: 'decide', tier_reason: '复现很绕，要先想清楚' }),
    runs: [],
  }));
  const where = await details();
  expect(within(where).getByText('验证', { selector: 'p' })).toBeInTheDocument();
  expect(within(where).getByText('账号 t1 · 决策档（单独指定）')).toBeInTheDocument();
  expect(within(where).getByText('理由：复现很绕，要先想清楚')).toBeInTheDocument();
  // Not run yet: nothing is said about how a round would run.
  expect(within(where).queryByText(/^权限：/)).toBeNull();
});

// Against a page that promises read-only where the round ran writable, or says nothing of
// how far the read-only way reached (docs/design/roles-and-tiers.md §5): it is what the
// round's own snapshot recorded, and a round from before read-only ran writable.
const ACCESS_CASES: [string, Record<string, unknown>, string][] = [
  ['read-only to the tools', { access: { permission: 'read', layer: 'tools', args: ['--tools', 'Read,Grep,Glob'] } }, '权限：只读：工具层'],
  ['read-only to the file system', { access: { permission: 'read', layer: 'filesystem', args: ['--sandbox', 'read-only'] } }, '权限：只读：文件系统层'],
  ['writable', { access: { permission: 'write' } }, '权限：可写'],
  ['from before read-only', {}, '权限：可写'],
];
for (const [name, snapshot, text] of ACCESS_CASES) {
  test(`how a round ran is the one its snapshot recorded: ${name}`, async () => {
    const analyse = PRESET_ROLES.find((role) => role.id === 'analyse')!;
    open('#/task/task', site({
      task: aTask({ state: 'held', role_id: 'analyse', tier: 'decide', tier_source: 'default' }),
      runs: [ended()],
      snapshots: { run: { snapshot: { brief: '派发', tier: 'decide', tier_source: 'default', role: analyse, ...snapshot } } },
    }));
    const where = await details();
    expect(await within(where).findByText(text)).toBeInTheDocument();
  });
}

// Against a round whose snapshot looks like the whole of its input while its machine still gave
// it more (knowledge-and-skills.md §4.1, §1.3): the machine's global instruction file and the
// executor's own memory across tasks are each said kept out, or said still there.
test('what a round may still read on its machine is said as its snapshot recorded it', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'held', role_id: 'implement', tier: 'execute', tier_source: 'default' }),
    runs: [ended()],
    snapshots: { run: { snapshot: { brief: '派发', tier: 'execute', tier_source: 'default', access: { permission: 'write' }, machine_inputs: {
      instructions: { reads: 'codex 没有只让这一轮不读它的办法' },
      memory: { off: '带了 --disable memories，记忆功能不读不写' },
      knowledge_mcp: { absent: '机器报告的清单里没有开着的它' },
      config: { asked_at: '2026-11-11T09:00:00.000Z', kinds: [{ kind: 'mcp', names: ['github'] }, { kind: 'plugins', unknown: 'codex 没有不耗额度的问法' }] },
    } } } },
  }));
  const where = await details();
  expect(await within(where).findByText('这一轮还会读到 tycho 写在机器上的全局知识入口（codex 没有只让这一轮不读它的办法）')).toBeInTheDocument();
  expect(within(where).getByText('执行器自己跨任务的记忆：这一轮关掉了（带了 --disable memories，记忆功能不读不写）')).toBeInTheDocument();
  expect(within(where).getByText('机器上的知识 MCP：机器报告的清单里没有开着的它')).toBeInTheDocument();
  expect(within(where).getByText(`机器上执行器自己的配置照常生效（机器 ${formatTime('2026-11-11T09:00:00.000Z')} 报告）：MCP 服务器 github；插件未知（codex 没有不耗额度的问法）`)).toBeInTheDocument();
});

test('a round is shown as it went out: the role and tier of its snapshot, not the task as it is now', async () => {
  const then = { ...PRESET_ROLES.find((role) => role.id === 'verify')!, name: '当时的验证' };
  open('#/task/task', site({
    task: aTask({ state: 'held', role_id: 'analyse', tier: 'decide', tier_source: 'default' }),
    runs: [ended()],
    snapshots: { run: { snapshot: { brief: '派发', tier: 'execute', tier_source: 'default', role: then } } },
  }));
  const where = await details();
  expect(await within(where).findByText('当时的验证')).toBeInTheDocument();
  expect(within(where).getByText('账号 t1 · h1 · 执行档（职能默认）')).toBeInTheDocument();
  expect(within(where).queryByText('分析', { selector: 'p' })).toBeNull();
});

test('a round on an override shows the reason its own snapshot kept, whatever the task says now', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'held', role_id: 'analyse', tier: 'execute', tier_source: 'override', tier_override: 'execute', tier_reason: '后来改的理由' }),
    runs: [ended()],
    snapshots: { run: { snapshot: { brief: '派发', tier: 'execute', tier_source: 'override', tier_reason: '当时的理由', role: PRESET_ROLES.find((role) => role.id === 'analyse')! } } },
  }));
  const where = await details();
  expect(await within(where).findByText('理由：当时的理由')).toBeInTheDocument();
  expect(within(where).queryByText('理由：后来改的理由')).toBeNull();
});

test('a task that ended before roles says it has none, and offers no pick', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'done', role_id: null, tier: null, tier_source: null }),
    runs: [ended()],
    snapshots: { run: { snapshot: { brief: '旧格式', tier: 'execute' } } },
  }));
  const where = await details();
  expect(within(where).getByText(OLD_NO_ROLE_TEXT)).toBeInTheDocument();
  // The round from before roles ran on a tier the snapshot names, with no source to say.
  expect(await within(where).findByText('账号 t1 · h1 · 执行档')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '职能与档位' })).toBeNull();
});

test('a role, an override with its reason, and back to the default each send only what moved', async () => {
  let task = aTask({ state: 'held' }) as Record<string, unknown>;
  const calls: Call[] = [];
  const { user } = open('#/task/task', site({
    get task() { return task; },
    runs: [],
    on: (call) => {
      if (call.method !== 'PUT') return undefined;
      calls.push(call);
      const body = call.body as { role_id?: string; tier?: string | null; reason?: string };
      const role = PRESET_ROLES.find((each) => each.id === (body.role_id ?? task.role_id))!;
      const override = body.tier === undefined ? task.tier_override : body.tier;
      task = {
        ...task, role_id: role.id, tier_override: override, tier: override ?? role.default_tier, tier_source: override ? 'override' : 'default',
        tier_reason: body.tier === undefined ? task.tier_reason : body.reason ?? null,
      };
      return { task };
    },
  }));
  await loaded();
  await rolesListed();
  const form = roleForm();
  expect(within(form).getByRole('button', { name: '保存' }), '没改什么就没有可存的').toBeDisabled();
  expect(within(form).queryByRole('textbox', { name: '理由' }), '跟职能默认时不要理由').toBeNull();

  await user.selectOptions(within(form).getByRole('combobox', { name: '职能' }), 'analyse');
  expect(within(form).getByRole('option', { name: '跟职能默认（决策档）' })).toBeInTheDocument();
  await user.click(within(form).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls.map((call) => call.body)).toEqual([{ role_id: 'analyse' }]));
  expect(calls[0]!.path).toBe('/api/tasks/task/role');
  expect(await screen.findByText('账号 t1 · 决策档（职能默认）')).toBeInTheDocument();

  await user.selectOptions(within(roleForm()).getByRole('combobox', { name: '档位' }), 'execute');
  await user.type(within(roleForm()).getByRole('textbox', { name: '理由' }), '只是改个文档');
  await user.click(within(roleForm()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls.map((call) => call.body)).toEqual([{ role_id: 'analyse' }, { tier: 'execute', reason: '只是改个文档' }]));
  expect(await screen.findByText('理由：只是改个文档')).toBeInTheDocument();
  expect(screen.getByText('账号 t1 · 执行档（单独指定）')).toBeInTheDocument();

  await user.selectOptions(within(roleForm()).getByRole('combobox', { name: '档位' }), '');
  await user.click(within(roleForm()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls.map((call) => call.body).at(-1)).toEqual({ tier: null }));
  expect(await screen.findByText('账号 t1 · 决策档（职能默认）')).toBeInTheDocument();
});

test('an override the owner gives no reason for is sent without one', async () => {
  const calls: Call[] = [];
  const { user } = open('#/task/task', site({ task: aTask({ state: 'held' }), runs: [], on: (call) => (call.method === 'PUT' ? (calls.push(call), { task: aTask({ state: 'held' }) }) : undefined) }));
  await loaded();
  await user.selectOptions(within(roleForm()).getByRole('combobox', { name: '档位' }), 'decide');
  await user.click(within(roleForm()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls.map((call) => call.body)).toEqual([{ tier: 'decide' }]));
});

test('a task parked for want of a role is given one here, and then goes on with "继续"', async () => {
  let task = aTask({ state: 'waiting_person', reason: NO_ROLE_REASON, role_id: null, tier: null, tier_source: null }) as Record<string, unknown>;
  const calls: Call[] = [];
  const { user } = open('#/task/task', site({
    get task() { return task; },
    runs: [ended()],
    on: (call) => {
      if (call.method === 'GET') return undefined;
      calls.push(call);
      if (call.path === '/api/tasks/task/role') task = { ...task, role_id: 'implement', tier: 'execute', tier_source: 'default' };
      return { task };
    },
  }));
  const where = await details();
  expect(within(where).getByText(OLD_NO_ROLE_TEXT)).toBeInTheDocument();
  expect(within(roleForm()).getByRole('button', { name: '保存' }), '还没选职能').toBeDisabled();
  await rolesListed();
  await user.selectOptions(within(roleForm()).getByRole('combobox', { name: '职能' }), 'implement');
  await user.click(within(roleForm()).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/tasks/task/role', method: 'PUT', body: { role_id: 'implement' } }]));
  await waitFor(() => expect(within(where).queryByText(OLD_NO_ROLE_TEXT)).toBeNull());
  await user.click(screen.getByRole('button', { name: '继续' }));
  await waitFor(() => expect(calls.at(-1)!.path).toBe('/api/tasks/task/resume'));
});

test('a pick the service refuses keeps what was picked and says why', async () => {
  const { user } = open('#/task/task', site({ task: aTask({ state: 'held' }), runs: [], on: (call) => { if (call.method === 'PUT') throw refusal('任务已经结束，不能再改职能'); return undefined; } }));
  await loaded();
  await rolesListed();
  await user.selectOptions(within(roleForm()).getByRole('combobox', { name: '职能' }), 'review');
  await user.click(within(roleForm()).getByRole('button', { name: '保存' }));
  expect(await within(roleForm()).findByRole('alert')).toHaveTextContent('任务已经结束，不能再改职能');
  expect(within(roleForm()).getByRole('combobox', { name: '职能' })).toHaveValue('review');
});

const NO_REVIEW = { of: null, verdict: null, reviews: [], needs_review: true, blocked: NEEDS_PASS_TEXT, escalations: [] };

test('a task that needs a review says why it cannot be accepted, and the owner may accept it without review', async () => {
  const options = projectSite(
    { task: aTask({ state: 'ready', project_id: 'p' }), runs: [ended()], review: NO_REVIEW },
    (call) => (call.path === '/api/tasks/task/accept' ? { task: aTask({ state: 'done' }) } : undefined),
  );
  const { user, calls } = open('#/task/task', site(options));
  await loaded();
  expect(screen.getByText(NEEDS_PASS_TEXT)).toBeInTheDocument();
  expect(button('验收通过'), '服务会拒的验收不给按').toBeNull();
  expect(screen.queryByRole('link', { name: '检查可用登录' })).toBeNull();
  const trigger = screen.getByRole('button', { name: '不经审阅验收' });
  expect(trigger).toBeEnabled();
  await user.click(trigger);
  const confirm = screen.getByRole('button', { name: '确认不经审阅验收' });
  expect(confirm).toBeDisabled();
  expect(screen.getByText(/会记在这个任务的时间线上/)).toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: '不经审阅验收依据' }), '只有一个执行器，我自己看过了');
  await user.click(confirm);
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/tasks/task/accept', method: 'POST', body: { basis: '只有一个执行器，我自己看过了', without_review: true },
  }]));
});

test('a review page says what it is bound to, who may not review it, and what it concluded', async () => {
  const review = {
    ...NO_REVIEW, needs_review: false, blocked: null,
    of: {
      task_id: 'impl', run_id: 'run-a', revision: 2, title: '修缓存', goal: 'g', scope: null, acceptance: 'a',
      reviewed: { source_kind: 'repo', commit: 'c0ffee1' },
      files: [{ name: 'work.zip', sha256: 'ab'.repeat(32), bytes: 10 }], writers: ['claude'], at: AT, reviewed_title: '修缓存', reviewed_state: 'queued',
    },
    verdict: { result: 'reject', summary: '漏了一条', violations: [{ requirement: '测试通过', evidence: '两条失败', scope: 'a.ts' }], run_id: 'run', at: AT, current: false },
  };
  open('#/task/task', site({ task: aTask({ state: 'ready', role_id: 'review', tier: 'decide' }), runs: [ended()], review }));
  await loaded();
  expect(screen.getByRole('link', { name: '修缓存' })).toHaveAttribute('href', '#/task/impl');
  expect(screen.getByText('c0ffee1')).toBeInTheDocument();
  expect(screen.getByText(/work.zip/)).toBeInTheDocument();
  expect(screen.getByText('写过它的执行器：claude。有别的执行器能审时，写过的不能来审')).toBeInTheDocument();
  expect(screen.getByText('结论：打回 · 漏了一条')).toBeInTheDocument();
  expect(screen.getByText(/违反的要求：测试通过/)).toBeInTheDocument();
  expect(screen.getByText(/产物已经变了/), '过期的结论只留作记录').toBeInTheDocument();
});

// docs/design/code-sources.md §2: a review with a code source is bound to the commit the round
// handed over; the page shows which commit and where it lives.
test('a review bound to a repository says which commit and branch it was checked at', async () => {
  const review = {
    ...NO_REVIEW, needs_review: false, blocked: null,
    of: {
      task_id: 'impl', run_id: 'run-a', revision: 2, title: '修缓存', goal: 'g', scope: null, acceptance: 'a',
      reviewed: { source_kind: 'repo', commit: 'deadbee', branch: 'main', url: 'https://github.com/o/r.git' },
      files: [], writers: ['claude'], at: AT, reviewed_title: '修缓存', reviewed_state: 'ready',
    },
    verdict: null,
  };
  open('#/task/task', site({ task: aTask({ state: 'ready', role_id: 'review', tier: 'decide' }), runs: [ended()], review }));
  await loaded();
  expect(screen.getByText('审的是仓库 https://github.com/o/r.git main 分支上的提交')).toBeInTheDocument();
  expect(screen.getByText('deadbee')).toBeInTheDocument();
});

test('a review bound to a folder on a machine says so', async () => {
  const review = {
    ...NO_REVIEW, needs_review: false, blocked: null,
    of: {
      task_id: 'impl', run_id: 'run-a', revision: 2, title: '修缓存', goal: 'g', scope: null, acceptance: 'a',
      reviewed: { source_kind: 'folder', commit: 'feed123' },
      files: [], writers: ['claude'], at: AT, reviewed_title: '修缓存', reviewed_state: 'ready',
    },
    verdict: null,
  };
  open('#/task/task', site({ task: aTask({ state: 'ready', role_id: 'review', tier: 'decide' }), runs: [ended()], review }));
  await loaded();
  expect(screen.getByText('审的是机器上那个文件夹里的提交')).toBeInTheDocument();
  expect(screen.getByText('feed123')).toBeInTheDocument();
});

test('a task lists its reviews and when a rejection moved it up a tier', async () => {
  const review = {
    ...NO_REVIEW, blocked: null,
    reviews: [{ id: 'rev', title: '审一下', state: 'ready', reason: null, verdict: { result: 'pass', summary: '没问题', run_id: 'r', at: AT, current: true } }],
    escalations: [{ at: AT, review_task_id: 'rev', from: 'execute', to: 'decide', reason: ESCALATED_REASON }],
  };
  open('#/task/task', site({ task: aTask({ state: 'queued', tier: 'decide', tier_source: 'escalated', tier_override: 'decide', tier_reason: ESCALATED_REASON }), runs: [ended()], review }));
  await loaded();
  expect(screen.getByRole('link', { name: '审一下' })).toHaveAttribute('href', '#/task/rev');
  expect(screen.getByText('通过 · 没问题')).toBeInTheDocument();
  expect(screen.getByText(/审阅打回，从执行档升到决策档/)).toBeInTheDocument();
});

test('a review that ran on the executor that wrote its product says so on its round and on its verdict', async () => {
  const reason = '未换执行器：别的执行器现在都审不了（账号 t2 额度歇到 11-15 08:00），由写它的 claude 开新会话来审';
  const review = {
    ...NO_REVIEW, needs_review: false, blocked: null,
    of: {
      task_id: 'impl', run_id: 'run-a', revision: 2, title: '修缓存', goal: 'g', scope: null, acceptance: 'a',
      files: [], writers: ['claude'], at: AT, reviewed_title: '修缓存', reviewed_state: 'ready',
    },
    verdict: { result: 'pass', summary: '没问题', run_id: 'run', at: AT, current: true, same_executor: 'claude' },
  };
  open('#/task/task', site({
    task: aTask({ state: 'done', role_id: 'review', tier: 'decide' }), runs: [ended()], review,
    snapshots: { run: { snapshot: { brief: '审', tier: 'decide', same_executor: { executor: 'claude', reason } } } },
  }));
  await loaded();
  expect(await screen.findByText(reason)).toBeInTheDocument();
  expect(screen.getByText('结论：通过（未换执行器：claude 审的） · 没问题')).toBeInTheDocument();
});

test('a review that waits for an eligible reviewer says which executors wrote the product', async () => {
  open('#/task/task', site({ task: aTask({ state: 'held', role_id: 'review', reason: noReviewerText(['claude'], 'decide') }), runs: [ended()], review: { ...NO_REVIEW, blocked: null, needs_review: false } }));
  await loaded();
  expect(screen.getAllByText(noReviewerText(['claude'], 'decide')).length).toBeGreaterThan(0);
});

// A failure the executor explained only in what the call printed (Codex's MCP results,
// dsh's failed results) still says why beside its state: the first line of that output.
test('a failed call with no reason apart says why by the first line it printed', async () => {
  open('#/task/task', site({ runs: [aRun({ state: 'running' })], events: { run: { events: [
    { kind: 'tool.start', id: 'm', category: 'other', name: 'js', title: 'node_repl · js' },
    { kind: 'tool.end', id: 'm', isError: true, output: { text: "\nEPERM: operation not permitted, open 'mcp.txt'\n更多" } },
  ], first_index: 0, loaded: true } } }));
  await screen.findByText('node_repl · js');
  expect(within(tool('node_repl · js')).getByText("EPERM: operation not permitted, open 'mcp.txt'")).toHaveClass('text-destructive');
});

const PROJECTS = [{ id: 'p', name: '试跑', sources: [], logins: [], machines: [], moving: 0, waiting: 0 }, { id: 'q', name: '乙', sources: [], logins: [], machines: [], moving: 0, waiting: 0 }];
const projectsToo: Handler = (call) => (call.path === '/api/projects' ? { projects: PROJECTS } : undefined);

test('a knowledge task sits under 知识, not a project, and says what it works on, where it came from and which projects decide its machines', async () => {
  const gate = aTask({ project_id: null, role_id: 'analyse', title: '工作' });
  open('#/task/task', site({ task: gate, runs: [], knowledge: { kind: 'gate', proposal_id: 'kp1', source_project_id: 'p', projects: ['p', 'q'] }, on: projectsToo }));
  await loaded();
  const crumbs = screen.getByRole('navigation', { name: '所在位置' });
  expect(within(crumbs).getByRole('link', { name: '知识' })).toHaveAttribute('href', '#/knowledge');
  expect(screen.getByRole('link', { name: '把关一份知识提议' })).toHaveAttribute('href', '#/knowledge/proposals/kp1');
  expect(await screen.findByText('不属于任何项目。来自项目 试跑；材料涉及项目 试跑、乙，只派到它们都允许的机器')).toBeInTheDocument();
});

test('a curation task from no project, whose entries name no project, says so', async () => {
  const curation = aTask({ project_id: null, role_id: 'analyse', title: '工作' });
  open('#/task/task', site({ task: curation, runs: [], knowledge: { kind: 'curation', entries: ['k1', 'k2'], source_project_id: null, projects: [] }, on: projectsToo }));
  await loaded();
  expect(screen.getByText('整理 2 条知识')).toBeInTheDocument();
  expect(screen.getByText('不属于任何项目。不是从哪个项目来的；材料不涉及任何项目，机器不受项目限制')).toBeInTheDocument();
});

test('the skills a Task names are listed with their entries, and one retired since says the next round will not open', async () => {
  open('#/task/task', site({ skills: [
    { id: 's1', title: '部署到机器', revision: 2, state: 'active' },
    { id: 's2', title: '旧的发布步骤', revision: 1, state: 'retired' },
  ] }));
  await loaded();
  expect(screen.getByText('点名的技能')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '部署到机器' })).toHaveAttribute('href', '#/knowledge/entries/s1');
  expect(screen.getByRole('link', { name: '旧的发布步骤' }).parentElement).toHaveTextContent('已退役：下一轮不会开，要改掉这个点名');
});

test('the page shows the Router’s preference, its reason, and which group placed each round', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'held', prefer: { login_ids: ['账号 a', '账号 b'], reason: '审阅要交叉' } }),
    runs: [ended({ placed_by: 'spread' })],
  }));
  await loaded();
  expect(screen.getByText('优先名单')).toBeInTheDocument();
  expect(screen.getByText('账号 a、账号 b')).toBeInTheDocument();
  expect(screen.getByText('理由：审阅要交叉')).toBeInTheDocument();
  expect(screen.getByText('挑法：审阅分散')).toBeInTheDocument();
});

// docs/design/console.md, 数据怎么保持新: a round that is over and was read whole never changes
// again. Opened again, its record is drawn in the page's first draw and not read again; a round
// judged gone with its output unread may still have some to show, and is read again.
test('a finished round opened again is drawn at once from what was read; a round judged gone is read again', async () => {
  const app = open('#/task/task', site({
    runs: [
      ended({ id: 'r1' }),
      ended({ id: 'r2', exit_kind: 'lost', created_at: later(6), ended_at: later(7) }),
      // A stop settled after its machine was presumed gone: its output was never read to the end.
      ended({ id: 'r3', exit_kind: 'interrupted', error: { reason: '主人打断（机器失联）', lost: { basis: 'presumed' } }, created_at: later(8), ended_at: later(9) }),
    ],
    snapshots: { r1: { snapshot: { brief: '## 目标\n\n第一轮的目标' } } },
  }));
  expect(await screen.findByText('第一轮的目标')).toBeInTheDocument();
  const count = (path: string): number => app.reads.filter((each) => each === path).length;
  const gone = count('/api/runs/r2/events');
  const stopped = count('/api/runs/r3/events');
  expect(gone).toBeGreaterThan(0);
  await go('#/roles');
  await go('#/task/task');
  expect(screen.getByText('第一轮的目标')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: '正在读取快照' })).toBeNull();
  await waitFor(() => expect(count('/api/runs/r2/events')).toBeGreaterThan(gone));
  expect(count('/api/runs/r3/events')).toBeGreaterThan(stopped);
  expect(count('/api/runs/r1/events')).toBe(1);
  expect(count('/api/runs/r1/snapshot')).toBe(1);
});

test('待审阅的任务可以发起独立审阅并立即切换为审阅进行中', async () => {
  const options = projectSite(
    { task: aTask({ state: 'ready', project_id: 'p' }), runs: [ended()], review: NO_REVIEW },
    (call) => call.path === '/api/tasks/task/review' ? { task_id: 'review-1' } : undefined,
  );
  const { user, calls } = open('#/task/task', site(options));
  await loaded();
  await user.click(screen.getByRole('button', { name: '发起独立审阅' }));
  await waitFor(() => expect(calls).toContainEqual({ path: '/api/tasks/task/review', method: 'POST', body: {} }));
  expect(await screen.findByText('这一轮已交付，正在自动独立审阅')).toBeInTheDocument();
  expect(screen.getByText('已发起独立审阅')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看审阅任务' })).toHaveAttribute('href', '#/task/review-1');
});

test('a submitted report opens before acceptance without accepting the task or reading until asked', async () => {
  const ref = 'runs/run/artifacts/report.md';
  const reportPath = `/api/runs/run/report?ref=${encodeURIComponent(ref)}`;
  const app = open('#/task/task', site({
    task: aTask({ state: 'ready' }),
    runs: [ended({
      receipt: { status: 'done', summary: '本机验证完成', artifacts: [{ kind: 'report', ref }] },
      report_files: [{ ref, name: 'report.md' }],
    })],
    on: (call) => call.path === reportPath
      ? { run_id: 'run', ref, name: 'report.md', text: '# 实际报告\n\n系统版本已核对。', source: 'node' }
      : undefined,
  }));
  await loaded();
  expect(app.reads).not.toContain(reportPath);
  const report = screen.getByRole('heading', { name: '汇报' }).closest('section')!;
  await app.user.click(within(report).getByRole('button', { name: '查看报告 report.md' }));
  const dialog = await screen.findByRole('dialog', { name: 'report.md' });
  expect(await within(dialog).findByRole('heading', { name: '实际报告' })).toBeInTheDocument();
  expect(within(dialog).getByText('执行节点上的报告')).toBeInTheDocument();
  expect(app.reads).toContain(reportPath);
  expect(app.calls).toEqual([]);
});

test('reports with the same filename keep their own round and a disconnected report can be read again', async () => {
  let reachable = false;
  const app = open('#/task/task', site({
    runs: ['old', 'new'].map((id) => ended({
      id,
      receipt: { status: 'done', summary: `${id} 的汇报`, artifacts: [{ kind: 'report', ref: 'report.md' }] },
      report_files: [{ ref: 'report.md', name: 'report.md' }],
    })),
    on: (call) => {
      if (call.path === '/api/runs/old/report?ref=report.md') {
        if (!reachable) throw refusal('执行机器暂时连不上，请恢复节点后重新读取。', 503);
        return { run_id: 'old', ref: 'report.md', name: 'report.md', text: '旧轮报告正文', source: 'registered' };
      }
      if (call.path === '/api/runs/new/report?ref=report.md') {
        return { run_id: 'new', ref: 'report.md', name: 'report.md', text: '新轮报告正文', source: 'node' };
      }
      return undefined;
    },
  }));
  await loaded();
  const [oldReport, newReport] = screen.getAllByRole('heading', { name: '汇报' }).map((heading) => heading.closest('section')!);
  await app.user.click(within(oldReport!).getByRole('button', { name: '查看报告 report.md' }));
  let dialog = await screen.findByRole('dialog', { name: 'report.md' });
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('执行机器暂时连不上');
  reachable = true;
  await app.user.click(within(dialog).getByRole('button', { name: '重新读取' }));
  expect(await within(dialog).findByText('旧轮报告正文')).toBeInTheDocument();
  expect(within(dialog).getByText('已登记的产物副本')).toBeInTheDocument();
  await app.user.click(within(dialog).getByRole('button', { name: '关闭' }));
  await app.user.click(within(newReport!).getByRole('button', { name: '查看报告 report.md' }));
  dialog = await screen.findByRole('dialog', { name: 'report.md' });
  expect(await within(dialog).findByText('新轮报告正文')).toBeInTheDocument();
  expect(within(dialog).queryByText('旧轮报告正文')).toBeNull();
  expect(app.calls).toEqual([]);
});


// A final message is a report even without a file artifact or a receipt. Its source and
// truncation must stay visible, and an unavailable old report stays actionable for recovery.
test.each([
  { source: 'settlement', complete: true, state: 'saved', sourceText: '轮次结算时保存的最后回复' },
  { source: 'settlement', complete: false, state: 'truncated', sourceText: '轮次结算时保存的最后回复' },
])('最后回复显示完整正文、来源和保存边界：$state', async ({ source, complete, state, sourceText }) => {
  const ref = '最后一条消息';
  const path = `/api/runs/run/report?ref=${encodeURIComponent(ref)}`;
  const text = '# 最后回复正文\n\n第一段证据。\n\n最后一段建议。';
  const app = open('#/task/task', site({
    task: aTask({ state: 'ready' }),
    runs: [ended({
      receipt: { status: 'done', summary: '已完成', artifacts: [{ kind: 'report', ref }] },
      report_files: [{ ref, name: '最后回复', kind: 'final_message', state, bytes: 100, sha256: 'a'.repeat(64) }],
    })],
    on: (call) => call.path === path ? { run_id: 'run', ref, name: '最后回复', text, source, complete, bytes: 100, original_bytes: complete ? 100 : 200_000, sha256: 'a'.repeat(64), at: AT } : undefined,
  }));
  await loaded();
  expect(app.reads).not.toContain(path);
  const report = screen.getByRole('heading', { name: '汇报' }).closest('section')!;
  expect(within(report).queryByText(ref)).toBeNull();
  await app.user.click(within(report).getByRole('button', { name: '查看报告 最后回复' }));
  const dialog = await screen.findByRole('dialog', { name: '最后回复' });
  expect(await within(dialog).findByRole('heading', { name: '最后回复正文' })).toBeInTheDocument();
  expect(within(dialog).getByText('最后一段建议。')).toBeInTheDocument();
  expect(within(dialog).getByText(sourceText)).toBeInTheDocument();
  if (!complete) expect(within(dialog).getByText(/仅保存前128KiB/)).toBeInTheDocument();
  else expect(within(dialog).queryByText(/仅保存前128KiB/)).toBeNull();
  expect(app.reads).toContain(path);
  expect(app.calls).toEqual([]);
});

test('未保存的最后回复仍可打开并重试历史恢复，不要求文件artifact或可用回执', async () => {
  const ref = '最后一条消息';
  const path = `/api/runs/run/report?ref=${encodeURIComponent(ref)}`;
  let recovery = false;
  const app = open('#/task/task', site({
    runs: [ended({ receipt: null, report_files: [{ ref, name: '最后回复', kind: 'final_message', state: 'unavailable' }] })],
    on: (call) => {
      if (call.path !== path) return undefined;
      if (!recovery) throw refusal('历史原输出暂时不可读，请恢复节点后重试。', 503);
      return { run_id: 'run', ref, name: '最后回复', text: '从旧轮恢复的完整最后回复', source: 'recovered', complete: true, bytes: 100, original_bytes: 100, sha256: 'b'.repeat(64), at: AT };
    },
  }));
  await loaded();
  const report = screen.getByRole('heading', { name: '汇报' }).closest('section')!;
  await app.user.click(within(report).getByRole('button', { name: '查看报告 最后回复' }));
  const dialog = await screen.findByRole('dialog', { name: '最后回复' });
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('历史原输出暂时不可读');
  // Background revalidation may add reads; the user retry must issue a new read.
  const readsBeforeRetry = app.reads.filter((read) => read === path).length;
  recovery = true;
  await app.user.click(within(dialog).getByRole('button', { name: '重新读取' }));
  expect(await within(dialog).findByText('从旧轮恢复的完整最后回复')).toBeInTheDocument();
  expect(within(dialog).getByText('从历史原输出恢复（本次观察）')).toBeInTheDocument();
  expect(app.reads.filter((read) => read === path).length).toBeGreaterThan(readsBeforeRetry);
  expect(app.calls).toEqual([]);
});

test('没有文件artifact的最后回复仍按各自轮次读取，同一逻辑ref不能串轮', async () => {
  const ref = '最后一条消息';
  const app = open('#/task/task', site({
    runs: ['old', 'new'].map((id) => ended({
      id, receipt: { status: 'done', summary: `${id} 的最后汇报`, artifacts: [] },
      report_files: [{ ref, name: '最后回复', kind: 'final_message', state: 'saved' }],
    })),
    on: (call) => {
      const id = ['old', 'new'].find((run) => call.path === `/api/runs/${run}/report?ref=${encodeURIComponent(ref)}`);
      return id ? { run_id: id, ref, name: '最后回复', text: `${id} 的最后回复正文`, source: 'settlement', complete: true, bytes: 100, original_bytes: 100, sha256: 'c'.repeat(64), at: AT } : undefined;
    },
  }));
  await loaded();
  const reports = screen.getAllByRole('heading', { name: '汇报' }).map((heading) => heading.closest('section')!);
  for (const [index, id] of (['old', 'new'] as const).entries()) {
    const report = reports[index]!;
    await app.user.click(within(report).getByRole('button', { name: '查看报告 最后回复' }));
    const dialog = await screen.findByRole('dialog', { name: '最后回复' });
    expect(await within(dialog).findByText(`${id} 的最后回复正文`)).toBeInTheDocument();
    expect(within(dialog).queryByText(`${id === 'old' ? 'new' : 'old'} 的最后回复正文`)).toBeNull();
    await app.user.click(within(dialog).getByRole('button', { name: '关闭' }));
  }
  expect(app.reads).toContain(`/api/runs/old/report?ref=${encodeURIComponent(ref)}`);
  expect(app.reads).toContain(`/api/runs/new/report?ref=${encodeURIComponent(ref)}`);
  expect(app.calls).toEqual([]);
});

// A malformed report is an actionable delivery problem, not a read/retry button.
test('无法识别的报告引用保留原值并提示退回返工，不读取报告', async () => {
  const ref = '本条最终消息中的核验报告';
  const problem = '报告引用无法识别。请退回返工，让执行器重新交付报告。';
  const app = open('#/task/task', site({
    task: aTask({ state: 'ready' }),
    runs: [ended({ receipt: { status: 'done', summary: '已完成', artifacts: [{ kind: 'report', ref }] },
      report_files: [{ ref, name: ref, kind: 'invalid', problem }] })],
  }));
  await loaded();
  const report = screen.getByRole('heading', { name: '汇报' }).closest('section')!;
  expect(within(report).getByText(ref)).toBeInTheDocument();
  expect(within(report).getByRole('alert')).toHaveTextContent(problem);
  expect(within(report).queryByRole('button', { name: /查看报告|重新读取/ })).toBeNull();
  expect(app.reads.some(path => path.includes('/report?'))).toBe(false);
  expect(app.calls).toEqual([]);
});

test('State A (in_review): renders calm banner with live review link and collapsed manual overrides, never NEEDS_PASS_TEXT', async () => {
  const { user, calls } = open('#/task/task', site({
    task: aTask({
      state: 'ready',
      active_review: 'rev-live',
      review_gate: { kind: 'in_review', message: '正在独立审阅', review_task_id: 'rev-live', review_state: 'running' },
    }),
    runs: [ended()],
    review: {
      ...NO_REVIEW,
      blocked: NEEDS_PASS_TEXT,
      gate: { kind: 'in_review', message: '正在独立审阅', review_task_id: 'rev-live', review_state: 'running' },
    },
  }));
  await loaded();
  const region = screen.getByRole('region', { name: '审阅进行中' });
  expect(within(region).getByText('这一轮已交付，正在自动独立审阅')).toBeInTheDocument();
  expect(within(region).getByText('审阅状态：执行中')).toBeInTheDocument();
  expect(within(region).getByRole('link', { name: '查看审阅任务' })).toHaveAttribute('href', '#/task/rev-live');
  expect(within(region).queryByText(NEEDS_PASS_TEXT)).toBeNull();
  expect(within(region).queryByRole('link', { name: '检查可用登录' })).toBeNull();

  // Manual overrides are tucked inside collapsed details.
  const detailsEl = within(region).getByText('需要提前介入？').closest('details')!;
  expect(detailsEl).not.toHaveAttribute('open');
  await user.click(within(region).getByText('需要提前介入？'));
  await user.click(within(detailsEl).getByRole('button', { name: '放弃任务' }));
  await user.click(within(detailsEl).getByRole('button', { name: '确认放弃' }));
  await waitFor(() => expect(calls).toContainEqual({ path: '/api/tasks/task/abandon', method: 'POST', body: { reason: '' } }));
});

test('State B (review_held): renders amber banner with stop reason and primary link to the held review task', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'ready' }),
    runs: [ended()],
    review: {
      ...NO_REVIEW,
      gate: { kind: 'review_held', message: '独立审阅已停住', review_task_id: 'rev-stuck', review_state: 'held', review_reason: '没有可用登录' },
    },
  }));
  await loaded();
  const region = screen.getByRole('region', { name: '独立审阅已停住' });
  expect(within(region).getByText('没有可用登录')).toBeInTheDocument();
  expect(within(region).getByRole('link', { name: '前往处理审阅任务' })).toHaveAttribute('href', '#/task/rev-stuck');
  expect(within(region).getByRole('link', { name: '检查可用登录' })).toHaveAttribute('href', '#/accounts');
});

test('universal 放弃 is reachable on queued, waiting_timer, draft, waiting_person and ready; queued/waiting_timer also expose 暂停', async () => {
  for (const state of ['queued', 'waiting_timer'] as const) {
    const app = open('#/task/task', site({ task: aTask({ state }), runs: [] }));
    await loaded();
    await app.user.click(screen.getByRole('button', { name: '暂停' }));
    await waitFor(() => expect(app.calls).toContainEqual({ path: '/api/tasks/task/hold', method: 'POST', body: { reason: '' } }));
    await app.user.click(screen.getByRole('button', { name: '放弃' }));
    await app.user.click(screen.getByRole('button', { name: '确认放弃' }));
    await waitFor(() => expect(app.calls).toContainEqual({ path: '/api/tasks/task/abandon', method: 'POST', body: { reason: '' } }));
    app.unmount();
  }
  for (const state of ['draft', 'waiting_person', 'ready'] as const) {
    const app = open('#/task/task', site({ task: aTask({ state }), runs: [] }));
    await loaded();
    expect(screen.getByRole('button', { name: '放弃' })).toBeEnabled();
    app.unmount();
  }
});

test('ReviewFacts shows live review state and reason when verdict is null instead of static 还没有结论', async () => {
  open('#/task/task', site({
    task: aTask({ state: 'ready' }),
    runs: [ended()],
    review: {
      ...NO_REVIEW,
      blocked: null,
      reviews: [
        { id: 'rev-run', title: '自动审阅 #1', state: 'running', reason: null, verdict: null },
        { id: 'rev-hold', title: '自动审阅 #2', state: 'held', reason: '无可用登录', verdict: null },
      ],
    },
  }));
  await loaded();
  const section = screen.getByRole('region', { name: '审阅' });
  expect(within(section).getByText('执行中')).toBeInTheDocument();
  expect(within(section).getByText('已停住：无可用登录')).toBeInTheDocument();
  expect(within(section).queryByText('还没有结论')).toBeNull();
});

test('AutomationNotice shows Router quota rest time and router_busy handoff status', async () => {
  const future = new Date(Date.now() + 30 * 60_000).toISOString();
  open('#/task/task', site({
    task: aTask({ state: 'ready' }),
    runs: [ended()],
    automation: { router_busy: true, resting_until: future, active_review_id: null, active_review_state: null },
  }));
  await loaded();
  expect(screen.getByText(/负责人额度歇息中/)).toBeInTheDocument();
  expect(screen.getByText('负责人正在自动处理下一步…')).toBeInTheDocument();
});

test('LandCard offers 并入主线 for landable tasks and links to active landing task when merging', async () => {
  const PR = 'https://github.com/o/r/pull/42';
  const app = open('#/task/task', site({
    task: aTask({ state: 'done' }),
    runs: [ended()],
    landable: { landable: true, pr: PR, commit: 'abcdef123456', already_integrated: false, active_landing_task_id: null, reason: null },
    on: (call) => (call.path === '/api/tasks/task/integrate' ? { task_id: 'land-99' } : undefined),
  }));
  await loaded();
  const card = screen.getByRole('region', { name: '并入主线' });
  expect(within(card).getByRole('link', { name: PR })).toHaveAttribute('href', PR);
  await app.user.click(within(card).getByRole('button', { name: '并入主线' }));
  await waitFor(() => expect(app.calls).toContainEqual({ path: '/api/tasks/task/integrate', method: 'POST', body: {} }));
  expect(await within(card).findByRole('link', { name: '查看并入任务' })).toHaveAttribute('href', '#/task/land-99');
  app.unmount();
});

test('TaskComposer is hidden on waiting_person, abandoned, and ended review/knowledge tasks, and uses auto-continue placeholder on running and queued', async () => {
  for (const state of ['waiting_person', 'abandoned'] as const) {
    const app = open('#/task/task', site({ task: aTask({ state }), runs: [ended()] }));
    await loaded();
    expect(screen.queryByRole('textbox', { name: '插话' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '继续发送指令' })).toBeNull();
    app.unmount();
  }
  const endedKnowledge = open('#/task/task', site({
    task: aTask({ state: 'done', project_id: null }),
    runs: [ended()],
    knowledge: { kind: 'curation', entries: ['k1'], source_project_id: null, projects: [] },
  }));
  await loaded();
  expect(screen.queryByRole('textbox', { name: '插话' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: '继续发送指令' })).toBeNull();
  endedKnowledge.unmount();

  const endedReview = open('#/task/task', site({
    task: aTask({ state: 'done', role_id: 'review', project_id: 'p' }),
    runs: [ended()],
    review: {
      ...NO_REVIEW,
      needs_review: false,
      blocked: null,
      of: {
        task_id: 'impl', run_id: 'run-a', revision: 1, title: '修缓存', goal: 'g', scope: null, acceptance: 'a',
        files: [], writers: ['claude'], at: AT, reviewed_title: '修缓存', reviewed_state: 'done',
      },
    },
  }));
  await loaded();
  expect(screen.queryByRole('textbox', { name: '插话' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: '继续发送指令' })).toBeNull();
  endedReview.unmount();

  for (const state of ['running', 'queued'] as const) {
    const app = open('#/task/task', site({ task: aTask({ state }), runs: state === 'running' ? [aRun({ state: 'running' })] : [] }));
    await loaded();
    expect(screen.getByPlaceholderText('追加后续指令（本轮结束后自动续接原会话执行）')).toBeInTheDocument();
    app.unmount();
  }
});

test('a done task shows the follow-up composer and posts { note } to /api/tasks/:id/continue', async () => {
  const withSession = open('#/task/task', site({
    task: aTask({ state: 'done', project_id: 'p' }),
    runs: [ended({ session_ref: 'sess-done' })],
  }));
  await loaded();
  const box = screen.getByRole('textbox', { name: '继续发送指令' });
  expect(box).toHaveAttribute('placeholder', '发送后续指令，续接原会话继续执行');
  const submit = screen.getByRole('button', { name: '继续发送指令' });
  expect(submit).toHaveTextContent('继续');
  await withSession.user.type(box, '再补一组对比图');
  await withSession.user.click(submit);
  await waitFor(() => expect(withSession.calls).toEqual([
    { path: '/api/tasks/task/continue', method: 'POST', body: { note: '再补一组对比图' } },
  ]));
  await waitFor(() => expect(box).toHaveValue(''));
  withSession.unmount();

  const noSession = open('#/task/task', site({
    task: aTask({ state: 'done', project_id: 'p' }),
    runs: [ended({ session_ref: null })],
  }));
  await loaded();
  expect(screen.getByRole('textbox', { name: '继续发送指令' })).toHaveAttribute('placeholder', '发送后续指令，继续执行这个任务');
  noSession.unmount();
});

test('a ready task shows the follow-up composer and posts { note } to /api/tasks/:id/continue', async () => {
  const { user, calls } = open('#/task/task', site({
    task: aTask({ state: 'ready', project_id: 'p' }),
    runs: [ended({ session_ref: 'sess-ready' })],
  }));
  await loaded();
  const box = screen.getByRole('textbox', { name: '继续发送指令' });
  expect(box).toHaveAttribute('placeholder', '发送后续指令，续接原会话继续执行');
  await user.type(box, '把边界情况的回归测试加上');
  await user.click(screen.getByRole('button', { name: '继续发送指令' }));
  await waitFor(() => expect(calls).toEqual([
    { path: '/api/tasks/task/continue', method: 'POST', body: { note: '把边界情况的回归测试加上' } },
  ]));
  await waitFor(() => expect(box).toHaveValue(''));
});

test('multi-round ergonomics: collapses older rounds, deduplicates identical goal/acceptance, shows ?run= banner, groups queued inputs, and exposes copyable task ID', async () => {
  const sameBrief = '## 目标\n\n统一目标\n\n## 验收标准\n\n统一验收';
  const { user } = open('#/task/task-multi', site({
    task: aTask({ id: 'task-multi', state: 'running' }),
    runs: [
      ended({ id: 'r1', created_at: later(0), ended_at: later(1), receipt: { status: 'done', summary: '第一轮交付' } }),
      aRun({ id: 'r2', state: 'running', created_at: later(2) }),
    ],
    snapshots: {
      r1: { snapshot: { brief: sameBrief } },
      r2: { snapshot: { brief: sameBrief } },
    },
    inputs: [{ id: 'q1', run_id: null, text: '留给下一轮的提示', state: 'queued', created_at: later(3) }],
  }));
  await loaded();
  // Older round 1 is collapsed by default; latest round 2 deduplicates unchanged goal/acceptance.
  const round1Details = screen.getAllByText('第一轮交付')[0]!.closest('details')!;
  expect(round1Details).not.toHaveAttribute('open');
  expect(await screen.findByText('目标与验收标准同第 1 轮')).toBeInTheDocument();
  // Sticky toolbar appears for multi-round tasks even with few events.
  expect(screen.getByRole('button', { name: '跳到最新' })).toBeInTheDocument();
  // Queued inputs are grouped cleanly at the bottom under 待下一轮接收.
  const queuedRegion = screen.getByRole('region', { name: '待下一轮接收' });
  expect(within(queuedRegion).getByText('留给下一轮的提示')).toBeInTheDocument();
  // Copyable 任务编号 exists in 技术细节.
  const tech = screen.getByText('技术细节').closest('details')!;
  expect(within(tech).getByText('任务编号')).toBeInTheDocument();
  expect(within(tech).getByText('task-multi')).toBeInTheDocument();
  // Filtering to round 1 shows a clear top banner with 显示全部.
  await user.click(screen.getByRole('button', { name: /^第 1 轮/ }));
  expect(await screen.findByText('当前仅看第 1 轮')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '显示全部' }));
  await waitFor(() => expect(screen.queryByText('当前仅看第 1 轮')).toBeNull());
});

test('auto-syncs deliverables once when receipt hints at file artifacts and falls back to manual retry on error', async () => {
  const syncGate = deferred();
  const { calls } = open('#/task/task', site({
    task: aTask({ state: 'ready', project_id: 'p' }),
    runs: [ended({ receipt: { status: 'done', summary: '已出图', artifacts: [{ kind: 'image', ref: 'chart.png' }] } })],
    deliverables: [],
    on: (call) => (call.method === 'POST' && call.path === '/api/tasks/task/deliverables' ? syncGate.promise : undefined),
  }));
  await loaded();
  expect(await screen.findByText('正在自动同步产物…')).toBeInTheDocument();
  await waitFor(() => expect(calls).toEqual([{ path: '/api/tasks/task/deliverables', method: 'POST', body: {} }]));
  await act(async () => { syncGate.reject(refusal('节点离线', 503)); });
  expect(await screen.findByText('节点离线')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '从执行机器同步产物' })).toBeEnabled();
  // Must not auto-loop after a failed one-shot sync.
  expect(calls).toHaveLength(1);
});

test('LandCard persists active landing status across reloads and renders calm integrated state when already_integrated', async () => {
  const PR = 'https://github.com/o/r/pull/99';
  const landing = open('#/task/task', site({
    task: aTask({ state: 'done' }),
    runs: [ended()],
    landable: {
      landable: false,
      pr: PR,
      commit: 'deadbeef1234',
      already_integrated: false,
      active_landing_task_id: 'land-active-1',
      active_landing_task_state: 'running',
      active_landing_task_title: '并入 PR #99',
      reason: null,
    },
  }));
  await loaded();
  const card = screen.getByRole('region', { name: '并入主线' });
  expect(within(card).getByText('正在并入主线')).toBeInTheDocument();
  expect(within(card).getByText('执行中')).toBeInTheDocument();
  expect(within(card).getByRole('link', { name: '查看并入任务' })).toHaveAttribute('href', '#/task/land-active-1');
  landing.unmount();

  open('#/task/task', site({
    task: aTask({ state: 'done' }),
    runs: [ended()],
    landable: {
      landable: false,
      pr: PR,
      commit: 'deadbeef1234',
      already_integrated: true,
      active_landing_task_id: null,
      reason: null,
    },
  }));
  await loaded();
  const integratedCard = screen.getByRole('region', { name: '并入主线' });
  expect(within(integratedCard).getByText('已并入主线 ✓')).toBeInTheDocument();
  expect(within(integratedCard).getByRole('link', { name: PR })).toHaveAttribute('href', PR);
  expect(within(integratedCard).queryByRole('button', { name: '并入主线' })).toBeNull();
});

test('TaskComposer persists per-task drafts in sessionStorage across mounts and clears on send', async () => {
  const first = open('#/task/task-draft', site({
    task: aTask({ id: 'task-draft', state: 'done', project_id: 'p' }),
    runs: [ended()],
  }));
  await loaded();
  const input1 = screen.getByRole('textbox', { name: '继续发送指令' });
  await first.user.type(input1, '还没发完的跟进草稿');
  expect(JSON.parse(sessionStorage.getItem('tycho.taskDrafts') ?? '{}')).toEqual({ 'task-draft': '还没发完的跟进草稿' });
  first.unmount();

  const second = open('#/task/task-draft', site({
    task: aTask({ id: 'task-draft', state: 'done', project_id: 'p' }),
    runs: [ended()],
  }));
  await loaded();
  const input2 = screen.getByRole('textbox', { name: '继续发送指令' });
  expect(input2).toHaveValue('还没发完的跟进草稿');
  await second.user.click(screen.getByRole('button', { name: '继续发送指令' }));
  await waitFor(() => expect(input2).toHaveValue(''));
  expect(sessionStorage.getItem('tycho.taskDrafts')).toBeNull();
});

test('queued input card supports inline edit (PATCH), withdraw (DELETE), and immediate interrupt', async () => {
  const { user, calls } = open('#/task/task', site({
    task: aTask({ state: 'running' }),
    runs: [aRun({ state: 'running' })],
    inputs: [{ id: 'in-q1', run_id: null, text: '先修测试再改样式', state: 'queued', created_at: later(2) }],
  }));
  await loaded();

  const region = screen.getByRole('region', { name: '待下一轮接收' });
  await user.click(within(region).getByRole('button', { name: '编辑' }));
  const editBox = within(region).getByRole('textbox', { name: '编辑排队指令' });
  await user.clear(editBox);
  await user.type(editBox, '先修单测，样式延后');
  await user.click(within(region).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(calls).toContainEqual({
    path: '/api/tasks/task/inputs/in-q1',
    method: 'PATCH',
    body: { text: '先修单测，样式延后' },
  }));

  await user.click(within(region).getByRole('button', { name: '立刻中断插话' }));
  await waitFor(() => expect(calls).toContainEqual({
    path: '/api/tasks/task/interrupt',
    method: 'POST',
    body: {},
  }));

  await user.click(within(region).getByRole('button', { name: '撤回' }));
  await waitFor(() => expect(calls).toContainEqual({
    path: '/api/tasks/task/inputs/in-q1',
    method: 'DELETE',
    body: undefined,
  }));
});

test('renders failover banner, process/diff tab toggle, and large-paste collapsible chip in TaskComposer', async () => {
  const { user, calls, reads } = open('#/task/task', site({
    task: aTask({ state: 'done', project_id: 'p' }),
    runs: [ended()],
    on: (call) => {
      if (call.path === '/api/tasks/task') {
        return {
          task: aTask({ state: 'done', project_id: 'p' }),
          work: aTask({ state: 'done', project_id: 'p' }),
          children: [],
          runs: [ended()],
          inputs: [],
          approvals: [],
          releases: { version: '1.0.0', last: null, intent: null, attempting: false, fetch: null, packages: [] },
          role: ROLES[0],
          dispatch_info: {
            latest_login: 'claude-backup',
            latest_machine: 'gpu-1',
            failover_note: '主账号额度已用完，已自动切换至 claude-backup 继续执行。',
          },
        };
      }
      if (call.path === '/api/tasks/task/diff') {
        return {
          source: 'git',
          commit: '1234567890abcdef',
          base: '0000000000000000',
          branch: 'feat/test',
          truncated: false,
          files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,2 @@\n x\n+y' }],
        };
      }
      return undefined;
    },
  }));
  await loaded();

  expect(screen.getByText('主账号额度已用完，已自动切换至 claude-backup 继续执行。')).toBeInTheDocument();
  // Diff endpoint is NOT fetched until user switches to 代码变更 tab.
  expect(reads).not.toContain('/api/tasks/task/diff');

  await user.click(screen.getByRole('tab', { name: '代码变更' }));
  expect(await screen.findByText('权威 Git Diff')).toBeInTheDocument();
  expect(reads).toContain('/api/tasks/task/diff');
  await user.click(screen.getByRole('tab', { name: '过程' }));

  // Large paste (>16 KiB) creates collapsible chip and includes full text on submit.
  const box = screen.getByRole('textbox', { name: '继续发送指令' });
  const bigLog = 'LOG_LINE\n'.repeat(2500);
  fireEvent.paste(box, {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? bigLog : '') },
  });
  expect(await screen.findByText('长文本片段')).toBeInTheDocument();
  expect(box).toHaveValue('');
  await user.click(screen.getByRole('button', { name: '继续发送指令' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.path).toBe('/api/tasks/task/continue');
  expect((calls[0]!.body as { note: string }).note).toContain('LOG_LINE');
});
