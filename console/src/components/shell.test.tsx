// Guards what surrounds every page: a side column that does not lead to every place, or
// marks the wrong one as the one in view; the number beside 总览 counting works instead of
// what actually waits for the owner; a project shown without what waits and moves in it; a
// degraded service, a stopped Router, a pause or a restore that the top of the page does
// not say (or says without the way to put it right), a break in the stream that leaves
// the page looking current, a restore confirmed while tasks still wait, a login that has
// expired leaving a dead page, a logout that leaves the session alive, the last page's
// failure following the owner to the next page, a phone whose menu cannot be opened, or
// stays open over the page it just went to, or that the keyboard cannot get into, shut
// with Escape, or come back from to where it was; a palette that cannot be opened from the
// keyboard or does not go where it says; and more than one stream held at once: one for
// each mount under StrictMode, or the browser's own reconnect of a broken stream beside
// the console's.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { session } from '@/lib/api';
import { FakeEventSource, go, holdClock, IDLE_STATE, open, pass, refusal, shellStream, sources, type Handler } from '@/test/harness';

const leaf = (dot: string) => ({ dot, text: '', counts: {}, leaf: true });
const work = (id: string, state: string, more: object = {}) => ({ id, title: `工作 ${id}`, state, reason: null, summary: leaf(state), ...more });
const listing = (tasks: object[], children: object[] = []): Handler => (call) => (call.path === '/api/tasks?top=1' ? { tasks, children } : undefined);
const stateOf = (state: object, more: Handler = () => undefined): Handler => (call) => more(call) ?? (call.path === '/api/state' ? { ...IDLE_STATE, ...state } : undefined);
const banner = (): HTMLElement[] => screen.queryAllByRole('status');
const project = (id: string, name: string, more: object = {}) => ({ id, name, sources: [], logins: [], login_mode: 'all', machines: [], spawn_machines: false, moving: 0, waiting: 0, ...more });
const projects = (...list: object[]): Handler => (call) => (call.path === '/api/projects' ? { projects: list } : undefined);
// The overview has been read and drawn.
const home = () => screen.findByRole('heading', { level: 1, name: '总览' });
const side = () => document.getElementById('side')!;

test('the side column leads to every place, and the one in view is marked', async () => {
  const { user } = open('#/');
  await home();
  const links = (name: string) => within(screen.getByRole('navigation', { name })).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')]);
  expect(links('视图')).toEqual([['总览', '#/', 'page'], ['工作', '#/work', null], ['用量', '#/usage', null]]);
  expect(links('配置')).toEqual([['知识', '#/knowledge', null], ['职能', '#/roles', null], ['账号', '#/accounts', null], ['机器', '#/machines', null], ['入站来源', '#/inbound', null], ['设置', '#/settings', null]]);
  await user.click(within(screen.getByRole('navigation', { name: '视图' })).getByRole('link', { name: '工作' }));
  expect(await screen.findByRole('heading', { level: 1, name: '工作' })).toBeInTheDocument();
  expect(links('视图')).toEqual([['总览', '#/', null], ['工作', '#/work', 'page'], ['用量', '#/usage', null]]);
});

test('the number beside 总览 is what waits for the owner: every task on a question, a stop or an acceptance, the ones under a work included', async () => {
  open('#/', listing(
    [work('held', 'held'), work('run', 'running'), work('many', 'draft', { summary: { dot: 'waiting_person', text: '1 个待验收，1 个等你决定', counts: {}, leaf: false } }), work('done', 'done')],
    [{ id: 'c1', parent_id: 'many', title: '甲', state: 'ready' }, { id: 'c2', parent_id: 'many', title: '乙', state: 'waiting_person' }, { id: 'c3', parent_id: 'many', title: '丙', state: 'running' }],
  ));
  await home();
  // The stopped work, and the two tasks under the other one: the work they are under is not counted again.
  expect(await screen.findByLabelText('3 件等你')).toHaveTextContent('3');
});

test('nothing waiting leaves 总览 without a number', async () => {
  open('#/', listing([work('run', 'running'), work('done', 'done')]));
  await home();
  expect(screen.queryByLabelText(/件等你/)).toBeNull();
});

test('ready tasks currently in automatic independent review are excluded from the 总览 attention badge, while review_held and no_review stay counted', async () => {
  open('#/', listing([
    work('in-rev-1', 'ready', { active_review: 'rev-1', review_gate: { kind: 'in_review', message: '审阅中', review_task_id: 'rev-1' }, summary: leaf('running') }),
    work('in-rev-2', 'ready', { summary: leaf('running') }),
    work('rev-held', 'ready', { review_gate: { kind: 'review_held', message: '审阅已停住', review_task_id: 'rev-2' }, summary: leaf('ready') }),
    work('no-rev', 'ready', { review_gate: { kind: 'no_review', message: '待审阅' }, summary: leaf('ready') }),
  ]));
  await home();
  expect(await screen.findByLabelText('2 件等你')).toHaveTextContent('2');
});

test('the side column shows subtle waiting badges on 知识 and 放行 when overview reports pending items', async () => {
  open('#/', (call) => {
    if (call.path === '/api/overview') {
      return {
        counts: { waiting: 0, moving: 0, ready: 0, knowledge_awaiting: 3, pending_joins: 2 },
        approvals: [],
        moving: [],
        recent: [],
        state: IDLE_STATE,
      };
    }
    return undefined;
  });
  await home();
  expect(await screen.findByLabelText('3 条知识待定')).toHaveTextContent('3');
  expect(await screen.findByLabelText('2 台机器待放行')).toHaveTextContent('2');
});

test('every project is in the side column with what waits and moves in it, and the one in view is marked on each of its pages', async () => {
  open('#/projects/p1/settings', projects(project('p1', '试跑', { waiting: 2, moving: 1 }), project('p2', '量化')));
  const nav = await screen.findByRole('navigation', { name: '项目' });
  const mine = await within(nav).findByRole('link', { name: /试跑/ });
  expect(mine).toHaveAttribute('href', '#/projects/p1');
  expect(mine).toHaveAttribute('aria-current', 'page');
  expect(mine).toHaveTextContent('在进行 1 · 等你 2');
  const other = within(nav).getByRole('link', { name: /量化/ });
  expect(other).not.toHaveAttribute('aria-current');
  expect(other).toHaveTextContent('在进行 0 · 等你 0');
  // The heading of the list leads to all of them.
  expect(within(nav).getByRole('link', { name: '项目' })).toHaveAttribute('href', '#/projects');
});

test('a project is made from the side column: only the name is needed, and it opens', async () => {
  let made = false;
  const { user, calls } = open('#/', (call) => {
    if (call.path === '/api/projects' && call.method === 'POST') { made = true; return { project: project('p9', '新项目') }; }
    if (call.path === '/api/projects') return { projects: made ? [project('p9', '新项目')] : [] };
    if (call.path === '/api/accounts') return { accounts: [], executors: [], permission_modes: {}, tier_forms: {}, credential_executors: [] };
    if (call.path === '/api/machines') return { machines: [], invites: [] };
    if (call.path === '/api/projects/p9/conversation') return { project: { id: 'p9', name: '新项目' }, segments: [], segment: null, writable: true, contexts: [], legacy: 0, busy: null };
    if (call.path === '/api/messages?project=p9&limit=50') return { messages: [] };
    return undefined;
  });
  await home();
  await user.click(within(screen.getByRole('navigation', { name: '项目' })).getByRole('button', { name: '新建项目' }));
  const form = await screen.findByRole('dialog', { name: '新建项目' });
  expect(within(form).getByRole('button', { name: '建立' })).toBeDisabled();
  await user.type(within(form).getByRole('textbox', { name: '项目名' }), '新项目');
  await user.click(within(form).getByRole('button', { name: '建立' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects', method: 'POST', body: { name: '新项目' } }]));
  await waitFor(() => expect(window.location.hash).toBe('#/projects/p9'));
  expect(await screen.findByRole('heading', { level: 1, name: '新项目' })).toBeInTheDocument();
});

test('Ctrl K opens one box that goes to any page, project or work', async () => {
  const { user } = open('#/', (call) => listing([work('w1', 'running')])(call) ?? projects(project('p1', '试跑'))(call));
  await home();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const palette = await screen.findByRole('dialog', { name: '搜索或跳转' });
  const options = () => within(palette).getAllByRole('option').map((option) => option.textContent);
  await waitFor(() => expect(options()).toEqual(expect.arrayContaining(['总览', '工作', '知识', '职能', '账号', '机器', '入站来源', '设置', '新建项目'])));
  expect(options().some((text) => text?.startsWith('试跑'))).toBe(true);
  expect(options().some((text) => text?.startsWith('工作 w1'))).toBe(true);
  await user.type(within(palette).getByRole('combobox', { name: '搜索或跳转' }), '机器');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(window.location.hash).toBe('#/machines'));
  expect(screen.queryByRole('dialog', { name: '搜索或跳转' })).toBeNull();
});

test('with the service in its normal state nothing stands above the page', async () => {
  open('#/');
  await home();
  await screen.findByText('一切正常');
  expect(banner()).toEqual([]);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('the top of the page says what is not normal, in order, and where a stopped Router is put right', async () => {
  open('#/', stateOf({
    dispatch: { degraded: true, recovering: false, paused: true },
    router: { alive: false, error: '在 PATH 里没有找到 claude', restarting: false, turn: null },
    channels: { wecom: { error: '没有设置 Secret' } },
    launching_runs: [{ id: 'r1', task_id: 't1', task_title: '探针', host: 'h1', unconfirmed: true }, { id: 'r2', task_id: 't2', task_title: '回归', host: 'h2' }],
  }));
  const top = await screen.findByText(/账本写入失败，派发已停止/);
  expect(top).toHaveTextContent('账本写入失败，派发已停止 · 派发已暂停 · 负责人已停摆：在 PATH 里没有找到 claude去设置 · 企微已停止：没有设置 Secret');
  expect(within(top).getByRole('link', { name: '去设置' })).toHaveAttribute('href', '#/settings/router.cli');
  // The side column carries the same state, always in sight, and names what a pause does
  // not reach: which task may still start, where it was headed, and whether its start was
  // ever confirmed.
  const health = screen.getByLabelText('运行状况');
  expect(within(health).getByText('派发')).toBeInTheDocument();
  expect(within(health).getAllByText('已停止').length).toBeGreaterThan(0);
  const stillComing = within(health).getByText(/暂停前已取得启动资格、可能随后启动：/);
  expect(stillComing).toHaveTextContent('探针（h1，启动未确认，仍可能迟到启动）、回归（h2）');
});

test('a pause with nothing about to start says only that', async () => {
  open('#/', stateOf({ dispatch: { ...IDLE_STATE.dispatch, paused: true } }));
  await waitFor(() => expect(banner().map((node) => node.textContent)).toEqual(['派发已暂停']));
  const health = screen.getByLabelText('运行状况');
  expect(within(health).getByText('派发')).toBeInTheDocument();
  expect(health).toHaveTextContent('正在跑的不受影响，新的不再开始。');
  expect(health).not.toHaveTextContent('可能随后启动');
});

test('a break in the stream is said with when the page last heard anything, and is gone once it is back', async () => {
  holdClock();
  const { reads } = open('#/');
  await home();
  // Connected: the snapshot was read to its last part.
  await waitFor(() => expect(reads).toContain('/api/state'));
  await act(async () => { shellStream().fail(); });
  const [note] = banner();
  expect(note).toHaveTextContent(/^已断开，上次更新 \d\d:\d\d$/);
  expect(note!.title).toMatch(/2\d{3}/);
  // A second later the console connects again.
  await pass(1000);
  await waitFor(() => expect(banner()).toEqual([]));
  // One stream, not the console's and the browser's own beside it.
  await pass(FakeEventSource.RECONNECT_MS);
  expect(sources.filter((source) => !source.closed)).toHaveLength(1);
});

test('the console opens one stream, also where everything is mounted twice', async () => {
  const { reads } = open('#/');
  await home();
  await waitFor(() => expect(reads).toContain('/api/state'));
  expect(sources).toHaveLength(1);
  expect(reads.filter((path) => path === '/api/messages?limit=50'), '快照读了不止一遍').toHaveLength(1);
});

const RESTORE = { from: 'D:/backup', backup_at: '2026-11-05T00:00:00Z', restored_at: '2026-11-05T01:00:00Z', held_tasks: [{ id: 't', title: '旧任务' }], unverified_messages: [], runs: [], orphan_runs: [] };

test('the side column folds every part into one line while all is well, with what each says a hover away', async () => {
  open('#/');
  await home();
  const line = await screen.findByText('一切正常');
  expect(screen.queryByLabelText('运行状况')).toBeNull();
  // Folded, not lost: what each part says is one hover away.
  expect(line.title).toContain('负责人：运行中');
  expect(line.title).toContain('门牌：还没有填对外地址');
});

test('the colour scheme is this browser\'s choice: 跟随系统, 浅色 or 深色', async () => {
  const { user } = open('#/');
  await home();
  const group = screen.getByRole('radiogroup', { name: '深浅色' });
  expect(within(group).getByRole('radio', { name: '跟随系统' })).toBeChecked();
  await user.click(within(group).getByRole('radio', { name: '深色' }));
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(localStorage.getItem('tycho.theme')).toBe('dark');
  await user.click(within(group).getByRole('radio', { name: '浅色' }));
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  expect(within(group).getByRole('radio', { name: '浅色' })).toBeChecked();
});

test('a restored ledger is said at the top of every page, and cannot be confirmed while tasks still wait', async () => {
  const { user, calls } = open('#/machines', stateOf({ restore: RESTORE }));
  // It leads to the overview, where what waits to be confirmed is listed.
  const link = await screen.findByRole('link', { name: /的备份恢复，以下项目等你确认/ });
  expect(link).toHaveAttribute('href', '#/');
  const confirm = screen.getByRole('button', { name: '确认清点完成' });
  expect(confirm).toBeDisabled();
  expect(confirm).toHaveAttribute('title', '还有 1 个任务等你确认');
  await user.click(confirm);
  expect(calls).toEqual([]);
});

test('confirming a restore asks the service, and the banner goes once the service says it is over', async () => {
  let restore: object | null = { ...RESTORE, held_tasks: [] };
  const { user, calls } = open('#/machines', (call) => {
    if (call.path === '/api/restore/confirm') { restore = null; return { confirmed: true }; }
    return call.path === '/api/state' ? { ...IDLE_STATE, restore } : undefined;
  });
  await user.click(await screen.findByRole('button', { name: '确认清点完成' }));
  expect(calls).toEqual([{ path: '/api/restore/confirm', method: 'POST', body: {} }]);
  await waitFor(() => expect(screen.queryByRole('button', { name: '确认清点完成' })).toBeNull());
});

test('a confirmation the service refuses says why and leaves the banner', async () => {
  const { user } = open('#/work', stateOf({ restore: { ...RESTORE, held_tasks: [] } }, (call) => { if (call.method === 'POST') throw refusal('还有任务没有确认', 400); return undefined; }));
  await user.click(await screen.findByRole('button', { name: '确认清点完成' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('还有任务没有确认');
  expect(screen.getByRole('button', { name: '确认清点完成' })).toBeInTheDocument();
  // Said in one place, which the owner can put away.
  await user.click(screen.getByRole('button', { name: '知道了' }));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a login that has expired sends the owner to the login page', async () => {
  open('#/', (call) => { if (call.path === '/api/tasks?top=1') throw refusal('需要登录', 401); return undefined; });
  await waitFor(() => expect(session.toLogin).toHaveBeenCalled());
});

test('the side column opens device management, where this device logs out after confirmation', async () => {
  const { user, calls } = open('#/', (call) => {
    if (call.path === '/api/logout') return {};
    if (call.path === '/api/console-sessions') return { sessions: [{ id: 'current', device: 'Safari · iPhone', entry: 'outside', method: 'link', created_at: '2026-11-06T00:00:00Z', last_seen_at: '2026-11-06T01:00:00Z', expires_at: '2026-12-06T00:00:00Z', current: true }], session_days: 30, temporary_ms: 43_200_000 };
    return undefined;
  });
  expect(screen.queryByRole('button', { name: '注销' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '设备' }));
  await user.click(await screen.findByRole('button', { name: '注销' }));
  await user.click(within(screen.getByRole('alertdialog', { name: '注销这一台？' })).getByRole('button', { name: '确认注销' }));
  expect(calls).toEqual([{ path: '/api/logout', method: 'POST', body: {} }]);
  await waitFor(() => expect(session.toLogin).toHaveBeenCalledTimes(1));
});

test('on a phone the side column is a menu: it opens, says so, names the page beside it, and shuts when a page is chosen', async () => {
  const { user } = open('#/');
  const menu = await screen.findByRole('button', { name: '菜单' });
  expect(menu.getAttribute('aria-controls')).toBe('side');
  expect(menu).toHaveAttribute('aria-expanded', 'false');
  expect(side()).toHaveAttribute('data-open', 'false');
  expect(menu.parentElement).toHaveTextContent('总览');
  await user.click(menu);
  expect(menu).toHaveAttribute('aria-expanded', 'true');
  expect(side()).toHaveAttribute('data-open', 'true');
  await user.click(menu);
  expect(side()).toHaveAttribute('data-open', 'false');
  await user.click(menu);
  await user.click(within(side()).getByRole('link', { name: '职能' }));
  // The page come to has a bar of its own, and its own button for the menu.
  await waitFor(() => expect(screen.getByRole('button', { name: '菜单' }).parentElement).toHaveTextContent('职能'));
  expect(screen.getByRole('button', { name: '菜单' })).toHaveAttribute('aria-expanded', 'false');
  expect(side()).toHaveAttribute('data-open', 'false');
  // The page already in view: choosing it again changes no address, and still shuts the menu.
  await user.click(screen.getByRole('button', { name: '菜单' }));
  await user.click(within(side()).getByRole('link', { name: '职能' }));
  expect(side()).toHaveAttribute('data-open', 'false');
  // A page come to without the menu, as by the browser's back button, shuts it too.
  await user.click(screen.getByRole('button', { name: '菜单' }));
  await go('#/work');
  await waitFor(() => expect(side()).toHaveAttribute('data-open', 'false'));
  expect(screen.getByRole('button', { name: '菜单' }).parentElement).toHaveTextContent('工作');
});

test('on a phone the menu takes the focus when it opens, shuts on Escape, and gives the focus back to its button', async () => {
  const { user } = open('#/');
  const menu = await screen.findByRole('button', { name: '菜单' });
  await user.click(menu);
  expect(side()).toContainElement(document.activeElement as HTMLElement);
  expect(document.activeElement).toBe(within(side()).getByRole('link', { name: '总览' }));
  await user.keyboard('{Escape}');
  expect(menu).toHaveAttribute('aria-expanded', 'false');
  expect(side()).toHaveAttribute('data-open', 'false');
  expect(menu).toHaveFocus();
  // Shut by choosing a page: what had the focus is gone from view, so the button has it.
  await user.click(menu);
  await user.click(within(side()).getByRole('link', { name: '工作' }));
  expect(side()).toHaveAttribute('data-open', 'false');
  await waitFor(() => expect(screen.getByRole('button', { name: '菜单' })).toHaveFocus());
  // Escape with the menu shut moves nothing.
  screen.getByRole('link', { name: '设置' }).focus();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('link', { name: '设置' })).toHaveFocus();
});

test('the failure of one page does not follow the owner to the next', async () => {
  const { user } = open('#/projects/p1', (call) => {
    if (call.method === 'POST') throw refusal('账本不可用', 503);
    return call.path === '/api/messages?segment=s1&limit=50' ? { messages: [{ id: '01', direction: 'in', channel: 'console', external_id: 'x-01', text: '长活', state: 'processing' }] } : undefined;
  });
  await user.click(await screen.findByRole('button', { name: '打断' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('账本不可用');
  await user.click(screen.getByRole('link', { name: '职能' }));
  await waitFor(() => expect(screen.queryByText('账本不可用')).toBeNull());
});

const TASK_PAGE = {
  task: { id: 'child', title: '子任务甲', state: 'running', project_id: 'p1', goal: '目标', acceptance: '验收', revision: 1, created_at: '2026-11-05T00:00:00Z', summary: leaf('running') },
  work: { id: 'w1', title: '工作 w1', state: 'draft', project_id: 'p1', summary: leaf('running') },
  children: [], runs: [], inputs: [], approvals: [], releases: { version: '1.0.0', last: null, intent: null, attempting: false, fetch: null, packages: [] },
};

test('a task\'s page says where it sits — its project, its work — and no place of the side column is marked as the one in view', async () => {
  open('#/task/child', (call) => projects(project('p1', '试跑'))(call) ?? (call.path === '/api/tasks/child' ? TASK_PAGE : undefined));
  const where = await screen.findByRole('navigation', { name: '所在位置' });
  await waitFor(() => expect(within(where).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['试跑', '#/projects/p1/work'], ['工作 w1', '#/work/w1']]));
  expect(where).toHaveTextContent('子任务甲');
  for (const name of ['视图', '配置']) {
    for (const link of within(screen.getByRole('navigation', { name })).getAllByRole('link')) expect(link).not.toHaveAttribute('aria-current');
  }
});

test('the side column names the program with the version the build baked in, word for word', async () => {
  open('#/', listing([]));
  expect(__TYCHO_VERSION__).toMatch(/\S/);
  const brand = await screen.findByText(__TYCHO_VERSION__, { exact: true });
  expect(brand.closest('[data-slot="brand"]')).toHaveTextContent(`tycho${__TYCHO_VERSION__}`);
});


// Run this file with TYCHO_RELEASE_VERSION=0.1.711 to exercise a packed release too.
// The normal development build must deliberately keep this notice absent.
test('an open project keeps its unsent draft while state announces another release, and failed reads cannot invent an upgrade', async () => {
  const released = /^\d+\.\d+\.\d+$/.test(__TYCHO_VERSION__);
  let version = __TYCHO_VERSION__;
  let failed = false;
  const app = open('#/projects/p1', (call) => {
    if (call.path === '/api/state') {
      if (failed) throw refusal('连接中断');
      return { ...IDLE_STATE, version };
    }
    return undefined;
  });
  const draft = await screen.findByRole('textbox', { name: '给负责人发消息' });
  await app.user.type(draft, '尚未发送的要求');
  expect(screen.queryByRole('status', { name: '页面版本提示' })).toBeNull();
  const reads = app.reads.filter((path) => path === '/api/state').length;
  version = '99.0.1';
  await act(async () => { shellStream().emit('changed', {}); });
  await waitFor(() => expect(app.reads.filter((path) => path === '/api/state').length).toBeGreaterThan(reads));
  if (released) expect(await screen.findByRole('status', { name: '页面版本提示' })).toHaveTextContent('99.0.1');
  else expect(screen.queryByRole('status', { name: '页面版本提示' })).toBeNull();
  expect(draft).toHaveValue('尚未发送的要求');
  expect(side().querySelector('[data-slot="brand"]')).toHaveTextContent(__TYCHO_VERSION__);
  expect(window.location.hash).toBe('#/projects/p1');
  expect(app.calls).toEqual([]);
  failed = true;
  await act(async () => { shellStream().emit('changed', {}); });
  await waitFor(() => expect(screen.queryByRole('status', { name: '页面版本提示' })).toBeNull());
  expect(draft).toHaveValue('尚未发送的要求');
  failed = false;
  version = '0.1.700';
  await act(async () => { shellStream().emit('changed', {}); });
  if (released) expect(await screen.findByRole('status', { name: '页面版本提示' })).toHaveTextContent('0.1.700');
  await act(async () => { shellStream().fail(); });
  if (released) expect(screen.getByRole('status', { name: '页面版本提示' })).toHaveTextContent('0.1.700');
  expect(draft).toHaveValue('尚未发送的要求');
  expect(app.calls).toEqual([]);
});


test('HTTP polling reports release changes while SSE stays disconnected, and failed or unknown HTTP reads do not reuse cached versions', async () => {
  holdClock();
  FakeEventSource.autoOpen = false;
  const released = /^\d+\.\d+\.\d+$/.test(__TYCHO_VERSION__);
  let version: string | undefined = __TYCHO_VERSION__;
  let failed = false;
  const app = open('#/projects/p1', (call) => {
    if (call.path !== '/api/state') return undefined;
    if (failed) throw refusal('HTTP 读取失败');
    return { ...IDLE_STATE, version };
  });
  const draft = await screen.findByRole('textbox', { name: '给负责人发消息' });
  await app.user.type(draft, '保留草稿');
  const notice = () => screen.queryByRole('status', { name: '页面版本提示' });
  const nextPoll = async () => {
    const before = app.reads.filter((path) => path === '/api/state').length;
    await pass(15_000);
    expect(app.reads.filter((path) => path === '/api/state').length).toBeGreaterThan(before);
  };
  expect(notice()).toBeNull();
  version = '99.0.1';
  await nextPoll();
  if (released) expect(notice()).toHaveTextContent('99.0.1');
  else expect(notice()).toBeNull();
  version = '0.1.700';
  await nextPoll();
  if (released) expect(notice()).toHaveTextContent('0.1.700');
  failed = true;
  await nextPoll();
  expect(notice()).toBeNull();
  failed = false;
  version = undefined;
  await nextPoll();
  expect(notice()).toBeNull();
  version = __TYCHO_VERSION__;
  await nextPoll();
  expect(notice()).toBeNull();
  version = '0.1 开发版';
  await nextPoll();
  expect(notice()).toBeNull();
  expect(draft).toHaveValue('保留草稿');
  expect(side().querySelector('[data-slot="brand"]')).toHaveTextContent(__TYCHO_VERSION__);
  expect(window.location.hash).toBe('#/projects/p1');
  expect(app.calls).toEqual([]);
});

test('the side column footer mounts the multi-account quota chip when accounts are available', async () => {
  const future = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const { user } = open('#/', (call) => {
    if (call.path === '/api/accounts') {
      return {
        accounts: [
          {
            id: 'a1',
            name: '主力 Codex',
            executor: 'codex',
            credential: 'set',
            can_route: true,
            tiers: {},
            permission_mode: null,
            timeout_ms: null,
            max_runs: null,
            queued_tasks: 0,
            status: {
              active_runs: 0,
              max_runs: 2,
              rest: null,
              usage: [{ window: 'five_hour', used: 0.28, resets_at: future, at: new Date().toISOString() }],
            },
          },
        ],
        executors: ['codex'],
        permission_modes: {},
        tier_forms: {},
        credential_executors: [],
      };
    }
    if (call.path === '/api/machines') return { machines: [], invites: [] };
    return undefined;
  });
  await home();
  const quotaChip = await within(side()).findByRole('button', { name: /Codex 72%/ });
  await user.click(quotaChip);
  const popover = await screen.findByRole('dialog', { name: '账号与额度' });
  expect(within(popover).getByText('主力 Codex')).toBeInTheDocument();
  expect(within(popover).getByText('剩 72%')).toBeInTheDocument();
});

test('sidebar constrains horizontal overflow, truncates long thread titles, enriches assignment tooltip, and only lists resumable === true done threads', async () => {
  const longTitle = '这是一个非常非常非常长而且不应该把侧边栏撑出横向滚动条的任务标题用于回归测试';
  open('#/projects/p1', (call) => {
    if (call.path === '/api/projects') return { projects: [project('p1', '试跑', { moving: 1 })] };
    if (call.path === '/api/tasks?top=1') {
      return {
        tasks: [
          work('t-run', 'running', {
            project_id: 'p1',
            title: longTitle,
            assignment: {
              role_id: 'implement',
              role_name: '实现者',
              tier: 'execute',
              tier_source: 'default',
              login_name: 'DEV-WORKSTATION/gemini',
              executor: 'gemini',
              machine_name: 'DEV-WORKSTATION',
              placed_by: 'order',
              is_live: true,
            },
          }),
          work('t-done-yes', 'done', { project_id: 'p1', title: '可续接已完成', resumable: true }),
          work('t-done-undef', 'done', { project_id: 'p1', title: '未标可续接已完成' }),
          work('t-done-no', 'done', { project_id: 'p1', title: '不可续接已完成', resumable: false }),
        ],
        children: [],
      };
    }
    return undefined;
  });

  const nav = await within(side()).findByRole('navigation', { name: '项目' });
  const scrollBox = nav.parentElement!;
  expect(scrollBox.className).toContain('overflow-x-hidden');
  expect(scrollBox.className).toContain('min-w-0');
  expect(nav.className).toContain('grid-cols-[minmax(0,1fr)]');
  expect(nav.className).toContain('min-w-0');

  const threadLink = await within(nav).findByRole('link', { name: longTitle });
  expect(threadLink.className).toContain('min-w-0');
  expect(threadLink.className).toContain('max-w-full');
  expect(threadLink.className).toContain('overflow-hidden');
  expect(threadLink.parentElement!.className).toContain('grid-cols-[minmax(0,1fr)]');
  expect(threadLink.parentElement!.className).toContain('min-w-0');
  expect(threadLink.querySelector('span')?.className).toContain('truncate');
  expect(threadLink).toHaveAttribute('title', `${longTitle} · 实现者 · 执行档 · gemini @ DEV-WORKSTATION`);

  // Active threads stay in the sidebar; completed tasks are suppressed while active work exists.
  expect(within(nav).queryByRole('link', { name: '可续接已完成' })).toBeNull();
  expect(within(nav).queryByRole('link', { name: '未标可续接已完成' })).toBeNull();
  expect(within(nav).queryByRole('link', { name: '不可续接已完成' })).toBeNull();
});

test('sidebar shows only resumable completed threads when a project has no active work', async () => {
  open('#/projects/p1', (call) => {
    if (call.path === '/api/projects') return { projects: [project('p1', '试跑')] };
    if (call.path === '/api/tasks?top=1') {
      return {
        tasks: [
          work('t-done-yes', 'done', { project_id: 'p1', title: '可续接已完成', resumable: true }),
          work('t-done-undef', 'done', { project_id: 'p1', title: '未标可续接已完成' }),
          work('t-done-no', 'done', { project_id: 'p1', title: '不可续接已完成', resumable: false }),
        ],
        children: [],
      };
    }
    return undefined;
  });

  const nav = await within(side()).findByRole('navigation', { name: '项目' });
  expect(await within(nav).findByRole('link', { name: '可续接已完成' })).toBeInTheDocument();
  expect(within(nav).queryByRole('link', { name: '未标可续接已完成' })).toBeNull();
  expect(within(nav).queryByRole('link', { name: '不可续接已完成' })).toBeNull();

  // Regression guard: sidebar ThemeSwitch segmented control must stay flex-nowrap so it never stacks vertically.
  const schemeGroup = within(side()).getByRole('radiogroup', { name: '深浅色' });
  expect(schemeGroup.className).toContain('flex-nowrap');
  expect(schemeGroup.className).toContain('flex-none');
});
