// Guards the pages of a project's setup — the list of projects (#/projects), a project's
// settings (#/projects/:id/settings) and its triggers (#/projects/:id/triggers) — against:
// a project's logins shown with an order of their own, an order the page pretends to edit
// (which tiers try first is the accounts page's), a save offered when nothing moved, a refused
// save that loses the edit, an empty console that says nothing about where projects come from,
// a change sent with only half of the two lists, and the code sources left out of a save that
// touched something else. And the code sources as an ordered list: the first item not marked
// default, no way to add a repository or a folder, a folder whose machine is gone not asking for
// one, or one the migration left without a machine (an empty registration) not asking for one and
// not saving the pick, and a new source sent with an id of its own — with the page read again
// after the save, so the order, the default item and the new source are the saved ones and not
// the ones the fake answered with before. And the switch that lets a project's tasks
// spawn machines: not shown, not sent when flipped, or sent with a save that did not flip
// it. And the logins offered: every
// account, and a machine's own login only once its two tiers are set — one the machine merely
// reports takes no work. And the login mode (project-sessions §1): not switchable either way,
// the chosen list lost on the way to every login and back, a switch undone still offered as a
// save, a save of another field that moves the mode, and an empty choice that does not say it
// dispatches nothing. And a machine list emptied, or cleared of deleted entries, saved as
// "any machine" without asking, or a machine range that does not say a folder source is pinned
// to its own machine whatever the range says; and a trigger deleted before it was confirmed.
// And what the Router may do without asking: a switch per step that is not shown, or not saved
// with the page. And the logins a project already names being hidden while the list of all
// logins cannot be read, the page saying there is nothing to choose when that list is what
// failed, and a login deleted since it was chosen neither shown nor possible to take off.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { deferred, holdClock, open, pass, refusal, type Call, type Handler } from '@/test/harness';

const account = (id: string) => ({ id, name: id, executor: 'claude', credential: 'set', tiers: { execute: '/tiers/execute.json' }, permission_mode: null, timeout_ms: null, max_runs: null, queued_tasks: 0 });
const repo = (id: string, url: string) => ({ id, kind: 'repo', url, default: false, label: `仓库 ${url}` });
const folder = (id: string, machine: string, path: string) => ({ id, kind: 'folder', machine_uid: machine, path, default: false, label: `${machine} 上的 ${path}` });
const project = (over: object = {}) => ({
  id: 'p1', name: '试跑',
  sources: [{ ...repo('s1', 'https://example.com/app.git'), default: true }, folder('s2', 'uid-h1', '/work/app')],
  login_mode: 'selected', logins: ['t2', 't1'], machines: [{ uid: 'uid-h1', name: 'h1' }], spawn_machines: false, moving: 2, waiting: 1, pool: ['t2', 't1'] as string[], ...over,
});

const own = (machine: string, executor: string, configured: boolean) => ({
  id: configured ? `${machine}/${executor}` : null, name: `${machine}/${executor}`, machine, kind: 'machine', executor, signed_in: true, configured, tiers: configured ? { execute: { kind: 'content', text: 'x' } } : {},
  permission_mode: null, timeout_ms: null, max_runs: null, status: { active: 0, limit: null, rest: null, usage: [] }, queued_tasks: 0,
});

// What a saved source list is handed in as, and what the service makes of it: a new item gets
// an id, the order is the one that was sent, and the first item is the default. The page reads
// the project again after a save, so a fake that does not hold this answers with the list it
// had before and hides whether the save worked.
type SavedSource = { id?: string; kind: string; url?: string; machine_uid?: string; path?: string };
type ProjectSource = ReturnType<typeof project>['sources'][number];
const savedSources = (sent: SavedSource[]): ProjectSource[] => sent.map((item, index) => (item.kind === 'repo'
  ? { id: item.id ?? `s${index + 10}`, kind: 'repo', url: item.url, default: index === 0, label: `仓库 ${item.url}` }
  : { id: item.id ?? `s${index + 10}`, kind: 'folder', machine_uid: item.machine_uid, path: item.path, default: index === 0, label: `${item.machine_uid} 上的 ${item.path}` })) as ProjectSource[];
const savedSourcesOf = (call: Call): ProjectSource[] => savedSources((call.body as { sources: SavedSource[] }).sources);

function listed(projects: object[], answer: Handler = () => undefined): Handler {
  return (call: Call) => {
    if (call.method === 'GET' && call.path === '/api/projects') return { projects };
    if (call.path === '/api/accounts') return { accounts: [account('t1'), account('t2'), account('t3')], executors: ['claude'], permission_modes: ['default'] };
    if (call.path === '/api/machines') return { machines: [{ id: 'h1', uid: 'uid-h1', host: 'h1', note: null, logins: [own('h1', 'codex', true), own('h1', 'dsh', false)] }, { id: 'h2', uid: 'uid-h2', host: 'h2', note: null }] };
    return answer(call);
  };
}

const SETTINGS = '#/projects/p1/settings';
const TRIGGERS = '#/projects/p1/triggers';
// A project's setup is a page of its own, split into horizontal sub-tabs.
const card = (name = '试跑') => screen.findByRole('article', { name: `项目 ${name}` });
const tab = (where: HTMLElement, name: string | RegExp): HTMLElement => within(where).getByRole('tab', { name });
const part = (where: HTMLElement, what: string, name = '试跑'): HTMLElement => within(where).getByRole('region', { name: `${name} ${what}` });
const order = (where: HTMLElement): string[] => within(within(where).getByRole('list', { name: '允许的登录' }))
  .getAllByRole('checkbox').filter((box) => (box as HTMLInputElement).checked).map((box) => box.closest('label')!.textContent!.trim());
const picked = (where: HTMLElement): string[] => within(within(where).getByRole('list', { name: '允许的机器' })).getAllByRole('checkbox').filter((box) => (box as HTMLInputElement).checked).map((box) => box.closest('label')!.textContent!.trim());
// "保存" and "取消" stand in a bar that is there only while something was changed.
const save = (where: HTMLElement): HTMLElement => within(where).getByRole('button', { name: '保存' });
const noSave = (where: HTMLElement): void => {
  expect(within(where).queryByRole('button', { name: '保存' })).toBeNull();
  expect(within(where).queryByRole('button', { name: '取消' })).toBeNull();
};

test('project login choices keep opaque ids and describe machines as machine logins', async () => {
  const first = '01K00000000000000000000021';
  const second = '01K00000000000000000000022';
  const calls: Call[] = [];
  let current = project({ logins: [first] });
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') return { accounts: [] };
    if (call.method === 'GET' && call.path === '/api/machines') return { machines: [
      { id: 'h1', uid: 'uid-h1', logins: [{ ...own('h1', 'claude', true), id: first }] },
      { id: 'h2', uid: 'uid-h2', logins: [{ ...own('h2', 'claude', true), id: second }] },
    ] };
    if (call.method === 'PUT') {
      calls.push(call);
      current = project({ logins: [first, second] });
      return { project: current };
    }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  await waitFor(() => expect(order(one)).toEqual(['机器 h1 上的 claude 登录']));
  await user.click(within(one).getByRole('checkbox', { name: '机器 h2 上的 claude 登录' }));
  await user.click(save(one));
  expect(calls).toEqual([{ method: 'PUT', path: '/api/projects/p1', body: { login_mode: 'selected', logins: [first, second] } }]);
  expect(one).not.toHaveTextContent(first);
  expect(one).not.toHaveTextContent(second);
});

test('deleted machine entries survive a save of another field', async () => {
  const calls: Call[] = [];
  let current = project({ machines: [], machines_gone: 1 });
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') { calls.push(call); current = { ...current, spawn_machines: true }; return { project: current }; }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  expect(part(one, '允许的机器')).toHaveTextContent('现在哪台机器都不会接它的活');
  // Nothing moved: there is nothing to save.
  noSave(one);
  await user.click(within(one).getByRole('switch', { name: '允许派生机器' }));
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { spawn_machines: true } }]));
  expect(one).toHaveTextContent('现在哪台机器都不会接它的活');
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test.each([false, true])('explicitly clearing deleted entries keeps selected machines when present (%s)', async (hasLive) => {
  holdClock();
  const calls: Call[] = [];
  let current = project({ machines: hasLive ? [{ uid: 'uid-h1', name: 'h1' }] : [], machines_gone: 1 });
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') { calls.push(call); current = project({ ...current, machines_gone: 0 }); return { project: current }; }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  await user.click(within(one).getByRole('button', { name: '去掉已删除的机器条目' }));
  expect(one).toHaveTextContent('保存后去掉');
  await user.click(save(one));
  if (!hasLive) {
    const confirm = await screen.findByRole('alertdialog', { name: '允许哪台机器都接活？' });
    expect(confirm).toHaveTextContent('保存后不再限制机器，哪台机器都行');
    await pass();
    expect(calls).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: '取消' }));
    await pass();
    expect(calls).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // The edit is still there to save.
    expect(save(one)).toBeEnabled();
    await user.click(save(one));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认不限制机器并保存' }));
  }
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { machines: hasLive ? ['uid-h1'] : [] } }]));
  await waitFor(() => noSave(one));
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('unticking the last machine requires confirmation before saving an unrestricted list', async () => {
  holdClock();
  const { user, calls } = open(SETTINGS, listed([project()], (call) => call.method === 'PUT' ? { project: project({ machines: [] }) } : undefined));
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  await user.click(within(one).getByRole('checkbox', { name: 'h1' }));
  await user.click(save(one));
  const confirm = await screen.findByRole('alertdialog');
  expect(confirm).toHaveTextContent('哪台机器都行');
  await pass();
  expect(calls).toEqual([]);
  await user.click(within(confirm).getByRole('button', { name: '确认不限制机器并保存' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { machines: [] } }]));
});

const EMPTY_PROJECT = { id: 'p2', name: '空项目', sources: [], logins: [], machines: [], moving: 0, waiting: 0 };

test('every project is listed with where its code is and the work on it, and leads to its own pages', async () => {
  open('#/projects', listed([project(), project(EMPTY_PROJECT)]));
  const list = await within(screen.getByRole('main')).findByRole('list', { name: '项目' });
  expect(within(list).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['#/projects/p1', '#/projects/p2']);
  const one = within(list).getByRole('link', { name: '项目 试跑' });
  expect(one).toHaveTextContent('在进行 2');
  expect(one).toHaveTextContent('等你 1');
  expect(one).toHaveTextContent('仓库 https://example.com/app.git');
  expect(one).toHaveTextContent('等 2 个来源');
  const other = within(list).getByRole('link', { name: '项目 空项目' });
  expect(other).toHaveTextContent('在进行 0');
  expect(other).toHaveTextContent('等你 0');
  expect(other).toHaveTextContent('没有代码来源');
});

test('a project\'s settings show which logins it allows, its machines and its code sources', async () => {
  const first = open(SETTINGS, listed([project(), project(EMPTY_PROJECT)]));
  const one = await card();
  const sources = part(one, '的代码来源');
  expect(within(sources).getByRole('list', { name: '代码来源（按顺序）' })).toBeInTheDocument();
  expect(within(sources).getAllByRole('listitem')).toHaveLength(2);
  // 第一项是默认：建任务时没说用哪个，就用它。
  expect(within(within(sources).getAllByRole('listitem')[0]!).getByText('默认')).toBeInTheDocument();
  expect(within(sources).getByRole('textbox', { name: '第 1 个来源的仓库地址' })).toHaveValue('https://example.com/app.git');
  expect(within(sources).getByRole('combobox', { name: '第 2 个来源的机器' })).toHaveValue('uid-h1');
  expect(within(sources).getByRole('textbox', { name: '第 2 个来源的文件夹' })).toHaveValue('/work/app');
  await first.user.click(tab(one, '登录与机器'));
  await waitFor(() => expect(order(one)).toEqual(['账号 t1', '账号 t2']));
  await waitFor(() => expect(picked(one)).toEqual(['h1']));
  // 仓库按这里的范围派发，机器上的文件夹固定派到它指定的那台机器。
  expect(part(one, '允许的机器')).toHaveTextContent('仓库来源的活按这里的范围派发');
  expect(part(one, '允许的机器')).toHaveTextContent('机器上的文件夹来源固定派到它指定的那台机器，不受这里限制');
  // The tab beside the settings carries what waits in the project.
  expect(within(screen.getByRole('navigation', { name: '项目的页面' })).getByRole('link', { name: /工作/ })).toHaveTextContent('1');
  first.unmount();

  const second = open('#/projects/p2/settings', listed([project(), project(EMPTY_PROJECT)]));
  const other = await card('空项目');
  expect(part(other, '的代码来源', '空项目')).toHaveTextContent('没有代码来源：这个项目的活会在空的任务目录里干。');
  await second.user.click(tab(other, '登录与机器'));
  expect(part(other, '允许的登录', '空项目')).toHaveTextContent('只用所选，一个都没选：这个项目的任务不派发');
  await waitFor(() => expect(part(other, '允许的机器', '空项目')).toHaveTextContent('不限制：在线的机器都可以'));
});

test('one save sends the login choice and the machine list together', async () => {
  const calls: Call[] = [];
  let current = project();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') { calls.push(call); current = { ...current, logins: ['t2'], machines: [{ uid: 'uid-h1', name: 'h1' }, { uid: 'uid-h2', name: 'h2' }] }; return { project: current }; }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  // Nothing changed: there is nothing to send.
  noSave(one);
  await user.click(await within(one).findByRole('checkbox', { name: '账号 t1' }));
  await user.click(within(one).getByRole('checkbox', { name: 'h2' }));
  expect(order(one)).toEqual(['账号 t2']);
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { login_mode: 'selected', logins: ['t2'], machines: ['uid-h1', 'uid-h2'] } }]));
  // The answer is the project as the service now has it, and the edit is over.
  await waitFor(() => noSave(one));
  expect(order(one)).toEqual(['账号 t2']);
});

test('the sources are reordered, removed and added, and one save sends the list in its new order', async () => {
  const calls: Call[] = [];
  let current = project();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') {
      calls.push(call);
      // 保存替身照服务端那样把请求落到状态上，页面保存后会重新读它。
      current = { ...current, sources: savedSourcesOf(call) };
      return { project: current };
    }
    return listed([current])(call);
  });
  const one = await card();
  const sources = part(one, '的代码来源');
  // 什么都不动就没有要保存的。
  noSave(one);
  // 第二项提到最前：顺序就是项目挑来源的偏好，第一项是默认。
  await user.click(within(sources).getByRole('button', { name: '把第 2 个来源往前挪' }));
  let rows = within(sources).getAllByRole('listitem');
  expect(within(rows[0]!).getByText('默认')).toBeInTheDocument();
  expect(within(rows[0]!).getByRole('combobox', { name: '第 1 个来源的机器' })).toHaveValue('uid-h1');
  expect(within(rows[1]!).getByRole('textbox', { name: '第 2 个来源的仓库地址' })).toHaveValue('https://example.com/app.git');
  // 去掉原来那一项，再加一个新的仓库。
  await user.click(within(sources).getByRole('button', { name: '去掉第 2 个来源' }));
  await user.click(within(sources).getByRole('button', { name: '加一个仓库' }));
  await user.type(within(sources).getByRole('textbox', { name: '第 2 个来源的仓库地址' }), '  https://example.com/new.git  ');
  rows = within(sources).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/projects/p1', method: 'PUT',
    body: {
      sources: [
        { id: 's2', kind: 'folder', machine_uid: 'uid-h1', path: '/work/app' },
        { kind: 'repo', url: 'https://example.com/new.git' },
      ],
    },
  }]));
  // 重读回来的是保存后的顺序、第一项默认和那个新来源，不是保存前的列表。
  await waitFor(() => noSave(one));
  rows = within(part(one, '的代码来源')).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(within(rows[0]!).getByText('默认')).toBeInTheDocument();
  expect(within(rows[0]!).getByRole('combobox', { name: '第 1 个来源的机器' })).toHaveValue('uid-h1');
  expect(within(rows[1]!).getByRole('textbox', { name: '第 2 个来源的仓库地址' })).toHaveValue('https://example.com/new.git');
});

test('a folder whose machine the service no longer knows is said, and a machine can be picked for it', async () => {
  const calls: Call[] = [];
  let stale = project({ sources: [{ id: 's1', kind: 'folder', machine_uid: 'uid-gone', path: '/work/app', default: true, label: '已删除的机器上的 /work/app' }] });
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') {
      calls.push(call);
      stale = { ...stale, sources: savedSourcesOf(call) };
      return { project: stale };
    }
    return listed([stale])(call);
  });
  const one = await card();
  const sources = part(one, '的代码来源');
  expect(sources).toHaveTextContent('这一项记的机器不在了：选一台机器。');
  await user.selectOptions(within(sources).getByRole('combobox', { name: '第 1 个来源的机器' }), 'uid-h1');
  expect(sources).not.toHaveTextContent('这一项记的机器不在了');
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/projects/p1', method: 'PUT',
    body: { sources: [{ id: 's1', kind: 'folder', machine_uid: 'uid-h1', path: '/work/app' }] },
  }]));
  // 重读回来：这项记得的机器就是保存时选的那台。
  await waitFor(() => noSave(one));
  expect(within(part(one, '的代码来源')).getByRole('combobox', { name: '第 1 个来源的机器' })).toHaveValue('uid-h1');
  expect(part(one, '的代码来源')).not.toHaveTextContent('这一项记的机器不在了');
});

// docs/design/code-sources.md §5, §8: the migration leaves a folder whose host machine could
// not be confirmed with an empty registration, so the owner picks one.
test('a folder the migration left without a machine asks for one, and the pick is saved', async () => {
  const calls: Call[] = [];
  let current = project({ sources: [{ id: 's1', kind: 'folder', machine_uid: '', path: '/work/app', default: true, label: '机器上的文件夹 /work/app' }] });
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') {
      calls.push(call);
      current = { ...current, sources: savedSourcesOf(call) };
      return { project: current };
    }
    return listed([current])(call);
  });
  const one = await card();
  const sources = part(one, '的代码来源');
  expect(sources).toHaveTextContent('这一项还没选机器：选一台，活才知道派到哪儿。');
  await user.selectOptions(within(sources).getByRole('combobox', { name: '第 1 个来源的机器' }), 'uid-h1');
  expect(sources).not.toHaveTextContent('这一项还没选机器');
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/projects/p1', method: 'PUT',
    body: { sources: [{ id: 's1', kind: 'folder', machine_uid: 'uid-h1', path: '/work/app' }] },
  }]));
  // 重读回来：机器已经记在来源上，提示不再出现。
  await waitFor(() => noSave(one));
  const reread = part(one, '的代码来源');
  expect(within(reread).getByRole('combobox', { name: '第 1 个来源的机器' })).toHaveValue('uid-h1');
  expect(reread).not.toHaveTextContent('这一项还没选机器');
});

test('a login is ticked and unticked, and one taken off can be put back', async () => {
  const calls: Call[] = [];
  let current = project();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') { calls.push(call); current = { ...current, logins: ['t2', 't3', 'h1/codex'], machines: [{ uid: 'uid-h1', name: 'h1' }, { uid: 'uid-h2', name: 'h2' }] }; return { project: current }; }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  await waitFor(() => expect(picked(one)).toEqual(['h1']));
  await user.click(within(one).getByRole('checkbox', { name: 'h2' }));
  expect(picked(one)).toEqual(['h1', 'h2']);
  await user.click(await within(one).findByRole('checkbox', { name: '账号 t1' }));
  // The accounts not listed yet, and the machine's own login that has its tiers; the one
  // still without tiers is not offered at all.
  expect(within(within(one).getByRole('list', { name: '允许的登录' })).getAllByRole('checkbox').map((box) => box.closest('label')!.textContent!.trim())).toEqual(['账号 t1', '账号 t2', '账号 t3', '机器 h1 上的 codex 登录']);
  await user.click(within(one).getByRole('checkbox', { name: '账号 t3' }));
  await user.click(within(one).getByRole('checkbox', { name: '机器 h1 上的 codex 登录' }));
  expect(order(one)).toEqual(['账号 t2', '账号 t3', '机器 h1 上的 codex 登录']);
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { login_mode: 'selected', logins: ['t2', 't3', 'h1/codex'], machines: ['uid-h1', 'uid-h2'] } }]));
});

test('the logins a project names stay visible, read-only, while the list of logins cannot be read', async () => {
  const read = deferred();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'GET' && call.path === '/api/accounts') return read.promise;
    return listed([project()])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  const logins = () => part(one, '允许的登录');
  // Not answered yet: the two logins it names are rows, each unable to change, and the page
  // does not claim there is nothing to choose.
  await waitFor(() => expect(order(one)).toEqual(['登录信息未读到', '登录信息未读到']));
  expect(within(logins()).queryByText('还没有可选的登录')).toBeNull();
  expect(within(logins()).getAllByRole('checkbox').every((box) => (box as HTMLInputElement).disabled)).toBe(true);
  // And the same once the read has failed: no empty choice, no lost names.
  await act(async () => { read.reject(refusal('读不到账号', 503)); });
  await waitFor(() => expect(within(logins()).getAllByRole('listitem')).toHaveLength(2));
  expect(within(logins()).queryByText('还没有可选的登录')).toBeNull();
  expect(order(one)).toEqual(['登录信息未读到', '登录信息未读到']);
});

test('a login deleted since it was chosen is shown as deleted and can be taken off', async () => {
  const calls: Call[] = [];
  let current = project({ logins: ['t2', 'gone'] });
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') { calls.push(call); current = project({ logins: ['t2'] }); return { project: current }; }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  // Known logins first, then the one that no longer exists, said as such.
  await waitFor(() => expect(within(within(one).getByRole('list', { name: '允许的登录' })).getAllByRole('listitem').map((row) => row.querySelector('label')!.textContent!.trim()))
    .toEqual(['账号 t1', '账号 t2', '账号 t3', '机器 h1 上的 codex 登录', '已删除的登录']));
  expect(order(one)).toEqual(['账号 t2', '已删除的登录']);
  await user.click(within(one).getByRole('checkbox', { name: '已删除的登录' }));
  expect(order(one)).toEqual(['账号 t2']);
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { login_mode: 'selected', logins: ['t2'] } }]));
  await waitFor(() => noSave(one));
});

test('a refused save keeps the edit and says why, and 取消 drops it', async () => {
  const { user } = open(SETTINGS, listed([project()], (call) => {
    if (call.method !== 'PUT') return undefined;
    throw refusal('账号不存在：t9', 400);
  }));
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  await user.click(await within(one).findByRole('checkbox', { name: '账号 t1' }));
  await user.click(save(one));
  expect(await within(one).findByRole('alert')).toHaveTextContent('账号不存在：t9');
  expect(order(one)).toEqual(['账号 t2']);
  expect(save(one)).toBeEnabled();
  await user.click(within(one).getByRole('button', { name: '取消' }));
  expect(order(one)).toEqual(['账号 t1', '账号 t2']);
  expect(within(one).queryByRole('alert')).toBeNull();
  noSave(one);
});

// docs/design/project-sessions.md §5, docs/design/code-sources.md §4: a project is made from the
// list of projects, with a name and any code sources; the rest is under "高级". Then its
// conversation opens.
test('an empty console says where projects come from; one is made with a name and the two kinds of source, and opens its conversation', async () => {
  const calls: Call[] = [];
  const { user } = open('#/projects', (call) => {
    if (call.method === 'POST' && call.path === '/api/projects') {
      calls.push(call);
      return { project: project({ id: 'p1', logins: [], login_mode: 'all' }) };
    }
    return listed([])(call);
  });
  const main = screen.getByRole('main');
  expect(await within(main).findByText('还没有项目')).toBeInTheDocument();
  expect(main).toHaveTextContent('建一个，就能和它的负责人说话：只要名字，代码来源可以不填。');
  // In the page's bar, and again where the list would be.
  const make = within(main).getAllByRole('button', { name: '新建项目' });
  expect(make).toHaveLength(2);
  await user.click(make.at(-1)!);
  const form = await screen.findByRole('dialog', { name: '新建项目' });
  expect(within(form).getByRole('button', { name: '建立' })).toBeDisabled();
  await user.type(within(form).getByRole('textbox', { name: '项目名' }), '新项目');
  // 讲清代码从哪来、改完去哪，没有 bundle、凭据这类词。
  expect(within(form).getByText(/仓库：干活的机器自己拉一份，改完推分支、开 PR/)).toBeInTheDocument();
  await user.click(within(form).getByRole('button', { name: '加一个仓库' }));
  await user.type(within(form).getByRole('textbox', { name: '第 1 个来源的仓库地址' }), 'https://example.com/new.git');
  await user.click(within(form).getByRole('button', { name: '加一个机器上的文件夹' }));
  await user.selectOptions(within(form).getByRole('combobox', { name: '第 2 个来源的机器' }), 'uid-h1');
  await user.type(within(form).getByRole('textbox', { name: '第 2 个来源的文件夹' }), '/work/new');
  await user.click(within(form).getByRole('button', { name: '建立' }));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/projects', method: 'POST',
    body: {
      name: '新项目',
      sources: [
        { kind: 'repo', url: 'https://example.com/new.git' },
        { kind: 'folder', machine_uid: 'uid-h1', path: '/work/new' },
      ],
    },
  }]));
  await waitFor(() => expect(window.location.hash).toBe('#/projects/p1'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('a project can be made with no source at all', async () => {
  const calls: Call[] = [];
  const { user } = open('#/projects', (call) => {
    if (call.method === 'POST' && call.path === '/api/projects') {
      calls.push(call);
      return { project: project({ id: 'p2', logins: [], login_mode: 'all' }) };
    }
    return listed([])(call);
  });
  const main = screen.getByRole('main');
  await user.click((await within(main).findAllByRole('button', { name: '新建项目' })).at(-1)!);
  const form = await screen.findByRole('dialog', { name: '新建项目' });
  await user.type(within(form).getByRole('textbox', { name: '项目名' }), '空项目');
  expect(within(form).getByText('没有代码来源：这个项目的活会在空的任务目录里干。')).toBeInTheDocument();
  await user.click(within(form).getByRole('button', { name: '建立' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects', method: 'POST', body: { name: '空项目' } }]));
});

test('a refused project stays in the form with the reason', async () => {
  const { user } = open('#/projects', (call) => {
    if (call.method === 'POST' && call.path === '/api/projects') throw refusal('仓库地址用不了：不是网络地址');
    return listed([project()])(call);
  });
  const main = screen.getByRole('main');
  await within(main).findByRole('list', { name: '项目' });
  await user.click(within(main).getByRole('button', { name: '新建项目' }));
  const form = await screen.findByRole('dialog', { name: '新建项目' });
  await user.type(within(form).getByRole('textbox', { name: '项目名' }), '新项目');
  await user.click(within(form).getByRole('button', { name: '建立' }));
  expect(await within(form).findByRole('alert')).toHaveTextContent('不是网络地址');
  expect(within(form).getByRole('textbox', { name: '项目名' })).toHaveValue('新项目');
  expect(within(form).getByRole('button', { name: '建立' })).toBeEnabled();
  expect(window.location.hash).toBe('#/projects');
});

test('what the Router may do without asking is a switch per step, saved with the page', async () => {
  const calls: Call[] = [];
  let current = { ...project(), grants: ['accept'] };
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') { calls.push(call); current = { ...current, grants: (call.body as { grants: string[] }).grants }; return { project: current }; }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '负责人与权限'));
  const grants = part(one, '负责人可以自己做');
  expect(grants).toHaveTextContent('审阅这道关不因为这里打开而放松');
  expect(within(grants).getByRole('switch', { name: '验收' })).toBeChecked();
  expect(within(grants).getByRole('switch', { name: '并入主线' })).not.toBeChecked();
  expect(within(grants).getByRole('switch', { name: '上线' })).not.toBeChecked();
  await user.click(within(grants).getByRole('switch', { name: '并入主线' }));
  await user.click(within(grants).getByRole('switch', { name: '上线' }));
  expect(calls).toEqual([]);
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { grants: ['accept', 'integrate', 'release'] } }]));
  await waitFor(() => noSave(one));
  expect(within(part(one, '负责人可以自己做')).getByRole('switch', { name: '上线' })).toBeChecked();
});

test('an older service that says nothing of grants gets no switches for them', async () => {
  open(SETTINGS, listed([project()]));
  const one = await card();
  expect(within(one).queryByRole('tab', { name: '负责人与权限' })).toBeNull();
  expect(within(one).queryByRole('region', { name: '试跑 负责人可以自己做' })).toBeNull();
});

test('the spawn switch is off by default, says what it does, and a save that flips it sends it', async () => {
  const calls: Call[] = [];
  let current = project();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') { calls.push(call); current = { ...current, spawn_machines: true }; return { project: current }; }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  const spawn = part(one, '允许派生机器');
  expect(spawn).toHaveTextContent('关着');
  expect(spawn).toHaveTextContent('不用你逐台放行');
  const toggle = within(spawn).getByRole('switch', { name: '允许派生机器' });
  expect(toggle).not.toBeChecked();
  await user.click(toggle);
  expect(toggle).toBeChecked();
  // Flipped, not sent: nothing goes before "保存".
  expect(calls).toEqual([]);
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { spawn_machines: true } }]));
  await waitFor(() => noSave(one));
  expect(part(one, '允许派生机器')).toHaveTextContent('开着');

  // Flipped back and forth is no edit at all.
  await user.click(within(one).getByRole('switch', { name: '允许派生机器' }));
  expect(save(one)).toBeEnabled();
  await user.click(within(one).getByRole('switch', { name: '允许派生机器' }));
  noSave(one);
});

// docs/design/triggers.md §1, §7: a project's triggers on their own page — the list with the next
// moment in its zone and UTC, the refusals counted, the recent occurrences as they stand (a turn that
// did not end said as "未确认完成"); a new one, an edit, a stop and a delete each one request of the
// whole definition; a refused save keeping the form and saying why.
const aTrigger = (over: object = {}) => ({
  id: 'tr1', project_id: 'p1', name: '早检', enabled: true, source: 'schedule',
  schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' }, event: null, schedule_text: 'cron 0 8 * * *（时区 Asia/Shanghai）',
  instruction: '检查构建', missed: 'latest', expires_at: null, push_final: false, revision: 1, created_by: 'router',
  created_at: '2030-01-01T00:00:00.000Z', updated_at: '2030-01-01T00:00:00.000Z', zone: 'Asia/Shanghai',
  next_at: '2030-01-02T00:00:00.000Z', next_local: '2030-01-02 08:00', ended: null,
  rejected: { count: 2, at: '2030-01-01T00:00:00.000Z', reason: 'queue_full', text: '项目里待处理的触发消息满了' }, ...over,
});
const aFire = { id: 'f1', created_at: '2030-01-01T00:00:05.000Z', trigger_id: 'tr1', trigger_name: '早检', event_id: 'e', scheduled_at: '2030-01-01T00:00:00.000Z', revision: 1, outcome: 'delivered', merged_into: null, merged_count: 2, merged_capped: false, message_id: 'm1', message_state: 'unverified', push_final: false, data: {} };

function withTriggers(triggers: object[], answer: Handler = () => undefined): Handler {
  return listed([project()], (call) => {
    if (call.method === 'GET' && call.path === '/api/projects/p1/triggers') return { triggers, recent: triggers.length ? [aFire] : [], zone: 'Asia/Shanghai', min_interval_ms: 300_000 };
    return answer(call);
  });
}
const triggersOf = () => screen.findByRole('region', { name: '试跑 的触发器' });
// A trigger is made, and changed, in a drawer beside the list.
const drawer = (name: '新建触发器' | '修改触发器') => screen.findByRole('dialog', { name });
const noDrawer = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

test('a project\'s triggers show when they fire next, what they refused and what became of their occurrences', async () => {
  open(TRIGGERS, withTriggers([aTrigger()]));
  const section = await triggersOf();
  expect(await within(section).findByRole('listitem', { name: '触发器 早检' })).toBeInTheDocument();
  const detail = await within(section).findByRole('article', { name: '触发器详情 早检' });
  expect(detail).toHaveTextContent('cron 0 8 * * *');
  expect(detail).toHaveTextContent('下一次：2030-01-02 08:00（Asia/Shanghai），UTC 2030-01-02 00:00');
  expect(detail).toHaveTextContent('拒收 2 次');
  expect(detail).toHaveTextContent('项目里待处理的触发消息满了');
  expect(within(section).getByRole('list', { name: '最近的触发记录' })).toHaveTextContent('已投递 · 合并了 2 个时刻 · 未确认完成');
});

test('a new trigger is one request of the whole definition, and a refused one keeps the form and says why', async () => {
  const calls: Call[] = [];
  let refuse = true;
  const { user } = open(TRIGGERS, withTriggers([], (call) => {
    if (call.method === 'POST' && call.path === '/api/projects/p1/triggers') {
      calls.push(call);
      if (refuse) throw refusal('两次触发最近只隔 60 秒，比最小间隔还密');
      return { trigger: aTrigger() };
    }
    return undefined;
  }));
  const section = await triggersOf();
  expect(await within(section).findByText('还没有触发器')).toBeInTheDocument();
  await user.click(within(section).getByRole('button', { name: '新建触发器' }));
  const form = await drawer('新建触发器');
  await user.type(within(form).getByRole('textbox', { name: '触发器的名字' }), '早检');
  await user.type(within(form).getByRole('textbox', { name: '固定指令' }), '检查构建');
  const cron = within(form).getByRole('textbox', { name: 'cron 表达式' });
  await user.clear(cron);
  await user.type(cron, '* * * * *');
  await user.click(within(form).getByRole('button', { name: '保存触发器' }));
  expect(await within(form).findByRole('alert')).toHaveTextContent('比最小间隔还密');
  expect(within(form).getByRole('textbox', { name: '触发器的名字' })).toHaveValue('早检');
  refuse = false;
  await user.click(within(form).getByRole('button', { name: '保存触发器' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]!.body).toEqual({
    name: '早检', instruction: '检查构建', source: 'schedule', schedule: { kind: 'cron', expr: '* * * * *', zone: 'Asia/Shanghai' }, missed: 'latest', expires_at: null, push_final: false, broadcast_groups: false, broadcast_group_ids: [],
  });
  // Saved, the drawer is gone.
  await noDrawer();
});

test('an edit, a stop and a delete of a trigger are each one request, and the delete asks first', async () => {
  const calls: Call[] = [];
  const { user } = open(TRIGGERS, withTriggers([aTrigger()], (call) => {
    if (call.method !== 'GET') { calls.push(call); return call.method === 'DELETE' ? {} : { trigger: aTrigger() }; }
    return undefined;
  }));
  const section = await triggersOf();
  const detail = await within(section).findByRole('article', { name: '触发器详情 早检' });
  await user.click(within(detail).getByRole('button', { name: '停用' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ path: '/api/triggers/tr1/enabled', method: 'POST', body: { enabled: false } }));
  await waitFor(() => expect(within(detail).getByRole('button', { name: '修改' })).toBeEnabled());
  await user.click(within(detail).getByRole('button', { name: '修改' }));
  const form = await drawer('修改触发器');
  const instruction = within(form).getByRole('textbox', { name: '固定指令' });
  expect(instruction).toHaveValue('检查构建');
  await user.type(instruction, '和测试');
  await user.click(within(form).getByRole('switch', { name: '推送本回合终稿' }));
  await user.click(within(form).getByRole('button', { name: '保存触发器' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({
    path: '/api/triggers/tr1', method: 'PUT',
    body: { name: '早检', instruction: '检查构建和测试', source: 'schedule', schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' }, missed: 'latest', expires_at: null, push_final: true, broadcast_groups: false, broadcast_group_ids: [] },
  }));
  await noDrawer();
  await user.click(within(await within(section).findByRole('article', { name: '触发器详情 早检' })).getByRole('button', { name: '删除' }));
  const confirm = await screen.findByRole('alertdialog', { name: '删除触发器 早检？' });
  // Asked, not yet done.
  expect(calls).toHaveLength(2);
  await user.click(within(confirm).getByRole('button', { name: '确认删除 早检' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ path: '/api/triggers/tr1', method: 'DELETE', body: undefined }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
});

test('a delete that is called off sends nothing, and one the service refuses says why where it was asked', async () => {
  const calls: Call[] = [];
  const { user } = open(TRIGGERS, withTriggers([aTrigger()], (call) => {
    if (call.method !== 'GET') { calls.push(call); throw refusal('账本不可用', 503); }
    return undefined;
  }));
  const section = await triggersOf();
  const detail = await within(section).findByRole('article', { name: '触发器详情 早检' });
  await user.click(within(detail).getByRole('button', { name: '删除' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(calls).toEqual([]);
  await user.click(within(detail).getByRole('button', { name: '删除' }));
  const confirm = await screen.findByRole('alertdialog');
  await user.click(within(confirm).getByRole('button', { name: '确认删除 早检' }));
  expect(await within(confirm).findByRole('alert')).toHaveTextContent('账本不可用');
  expect(calls.map(({ path, method }) => ({ path, method }))).toEqual([{ path: '/api/triggers/tr1', method: 'DELETE' }]);
  expect(within(confirm).getByRole('button', { name: '确认删除 早检' })).toBeEnabled();
});

// Review of step 1: a field shows minutes; an edit of the name alone sends every time back as held.
test('changing only a trigger\'s name sends its moment and deadline back to the millisecond', async () => {
  const calls: Call[] = [];
  const once = aTrigger({ schedule: { kind: 'once', at: '2030-01-01T00:00:42.123Z' }, expires_at: '2030-02-01T00:00:59.999Z', rejected: null });
  const { user } = open(TRIGGERS, withTriggers([once], (call) => {
    if (call.method === 'PUT') { calls.push(call); return { trigger: once }; }
    return undefined;
  }));
  const section = await triggersOf();
  await user.click(within(await within(section).findByRole('article', { name: '触发器详情 早检' })).getByRole('button', { name: '修改' }));
  const form = await drawer('修改触发器');
  const name = within(form).getByRole('textbox', { name: '触发器的名字' });
  await user.clear(name);
  await user.type(name, '晨检');
  await user.click(within(form).getByRole('button', { name: '保存触发器' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.body).toMatchObject({ name: '晨检', schedule: { kind: 'once', at: '2030-01-01T00:00:42.123Z' }, expires_at: '2030-02-01T00:00:59.999Z' });
});

// docs/design/triggers.md §2.3: an internal-event trigger is made from the same form — the event and
// the one Task it watches go out, no time rule and no missed policy; an existing one keeps its
// source, says what it subscribes to and has no next moment.
test('an internal-event trigger is made and edited from the same form, and keeps its source', async () => {
  const calls: Call[] = [];
  const subscribed = aTrigger({
    id: 'tr2', name: '合入后', source: 'event', schedule: null, event: { kind: 'merged', task_id: 't9' },
    schedule_text: '内部事件：已合入（只看任务 t9 和它下面的任务）', next_at: null, next_local: null, rejected: null,
  });
  const { user } = open(TRIGGERS, withTriggers([subscribed], (call) => {
    if (call.method !== 'GET') { calls.push(call); return { trigger: subscribed }; }
    return undefined;
  }));
  const section = await triggersOf();
  expect(await within(section).findByRole('listitem', { name: '触发器 合入后' })).toBeInTheDocument();
  const detail = await within(section).findByRole('article', { name: '触发器详情 合入后' });
  expect(detail).toHaveTextContent('内部事件：已合入');
  expect(detail).toHaveTextContent('订阅的事件发生时触发');
  expect(detail).not.toHaveTextContent('错过的时刻');

  await user.click(within(detail).getByRole('button', { name: '修改' }));
  const edit = await drawer('修改触发器');
  expect(within(edit).getByRole('combobox', { name: '来源' })).toBeDisabled();
  expect(within(edit).queryByRole('textbox', { name: 'cron 表达式' })).toBeNull();
  expect(within(edit).getByRole('textbox', { name: '只看这个任务' })).toHaveValue('t9');
  await user.selectOptions(within(edit).getByRole('combobox', { name: '事件' }), 'accepted');
  await user.clear(within(edit).getByRole('textbox', { name: '只看这个任务' }));
  await user.click(within(edit).getByRole('button', { name: '保存触发器' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({
    path: '/api/triggers/tr2', method: 'PUT',
    body: { name: '合入后', instruction: '检查构建', source: 'event', event: { kind: 'accepted', task_id: null }, expires_at: null, push_final: false, broadcast_groups: false, broadcast_group_ids: [] },
  }));

  await noDrawer();
  await user.click(within(section).getByRole('button', { name: '新建触发器' }));
  const form = await drawer('新建触发器');
  await user.type(within(form).getByRole('textbox', { name: '触发器的名字' }), '就绪后');
  await user.type(within(form).getByRole('textbox', { name: '固定指令' }), '接着做');
  await user.selectOptions(within(form).getByRole('combobox', { name: '来源' }), 'event');
  expect(within(form).queryByRole('combobox', { name: '错过怎么办' })).toBeNull();
  await user.type(within(form).getByRole('textbox', { name: '只看这个任务' }), 't9');
  await user.click(within(form).getByRole('button', { name: '保存触发器' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({
    path: '/api/projects/p1/triggers', method: 'POST',
    body: { name: '就绪后', instruction: '接着做', source: 'event', event: { kind: 'work_ready', task_id: 't9' }, expires_at: null, push_final: false, broadcast_groups: false, broadcast_group_ids: [] },
  }));
});

test('a project goes to every login and back to the chosen ones, and the list waits for it', async () => {
  const calls: Call[] = [];
  let current = project();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') {
      calls.push(call);
      const body = call.body as { login_mode?: 'all' | 'selected'; machines?: string[] };
      current = { ...current, login_mode: body.login_mode ?? current.login_mode, ...(body.machines ? { machines: body.machines.map((uid) => ({ uid, name: uid.replace('uid-', '') })) } : {}), pool: ['t1', 't2', 't3', 'h1/codex'] };
      return { project: current };
    }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  const logins = () => part(one, '允许的登录');
  expect(within(logins()).getByRole('radio', { name: '只用所选' })).toBeChecked();
  expect(within(logins()).getByRole('radio', { name: '全部登录' })).not.toBeChecked();
  await user.click(within(logins()).getByRole('radio', { name: '全部登录' }));
  expect(within(logins()).queryByRole('list', { name: '允许的登录' })).toBeNull();
  expect(logins()).toHaveTextContent('选过的 2 个登录留着');
  // Switched back is no edit: the list is the one it was.
  await user.click(within(logins()).getByRole('radio', { name: '只用所选' }));
  expect(order(one)).toEqual(['账号 t1', '账号 t2']);
  noSave(one);
  await user.click(within(logins()).getByRole('radio', { name: '全部登录' }));
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { login_mode: 'all' } }]));
  await waitFor(() => noSave(one));
  expect(logins()).toHaveTextContent('全部登录：派发时按每个档位的全局顺序挑（现在 4 个）');
  expect(within(logins()).getByRole('radio', { name: '全部登录' })).toBeChecked();

  // Another field saved says nothing of the mode.
  await user.click(within(one).getByRole('checkbox', { name: 'h2' }));
  await user.click(save(one));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]!.body).toEqual({ machines: ['uid-h1', 'uid-h2'] });
  await waitFor(() => noSave(one));

  // And back: the kept list is what it runs as again.
  await user.click(within(logins()).getByRole('radio', { name: '只用所选' }));
  expect(order(one)).toEqual(['账号 t1', '账号 t2']);
  await user.click(save(one));
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2]!.body).toEqual({ login_mode: 'selected' });
});

test('choosing none of the logins says the project dispatches nothing', async () => {
  const { user } = open(SETTINGS, listed([project({ logins: ['t1'] })]));
  const one = await card();
  await user.click(tab(one, '登录与机器'));
  await user.click(await within(one).findByRole('checkbox', { name: '账号 t1' }));
  expect(part(one, '允许的登录')).toHaveTextContent('只用所选，一个都没选：这个项目的任务不派发');
});

// The pause (project-sessions, "按项目暂停") acts at once and is no part of the draft: pressing it
// sends one request and leaves no save to make; the project's pages, the list and the side column
// all say a paused project is paused, and the notice on its page resumes it.
test('pausing a project is one press in effect at once, apart from the save, and its pages say so with a way back', async () => {
  const calls: Call[] = [];
  let current: ReturnType<typeof project> & { paused_at?: string | null } = project();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'POST' && call.path === '/api/projects/p1/pause') {
      calls.push(call);
      current = { ...current, paused_at: (call.body as { paused: boolean }).paused ? '2030-01-01T00:00:00Z' : null };
      return { project: current };
    }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '生命周期与危险区'));
  const pause = within(one).getByRole('region', { name: '暂停 试跑' });
  expect(pause).toHaveTextContent('在运行');
  await user.click(within(pause).getByRole('button', { name: '暂停这个项目' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1/pause', method: 'POST', body: { paused: true } }]));
  await waitFor(() => expect(pause).toHaveTextContent('已暂停'));
  noSave(one);
  const notice = await screen.findByRole('status', { name: '项目已暂停' });
  expect(notice).toHaveTextContent('负责人不接新消息');
  // The side column's row of the project carries the mark.
  expect(screen.getAllByLabelText('已暂停').length).toBeGreaterThan(0);
  await user.click(within(notice).getByRole('button', { name: '恢复' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ path: '/api/projects/p1/pause', method: 'POST', body: { paused: false } }));
  await waitFor(() => expect(screen.queryByRole('status', { name: '项目已暂停' })).toBeNull());
});

test('the list of projects marks a paused one', async () => {
  open('#/projects', listed([project({ paused_at: '2030-01-01T00:00:00Z' }), project({ ...EMPTY_PROJECT })]));
  const paused = await screen.findByRole('link', { name: '项目 试跑' });
  expect(within(paused).getByText('已暂停')).toBeInTheDocument();
  expect(within(screen.getByRole('link', { name: '项目 空项目' })).queryByText('已暂停')).toBeNull();
});

// The life of a project (docs/design/project-sessions.md, "项目的生命周期"): a name edited with
// the same save, an archive that acts at once behind a non-danger confirmation, a restore with
// no question, and a delete offered only when the service says nothing points at it.
test('a project is renamed as one field of the page\'s save', async () => {
  const calls: Call[] = [];
  let current = project();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') {
      calls.push(call);
      current = project({ name: '新名字' });
      return { project: current };
    }
    return listed([current])(call);
  });
  const one = await card();
  const field = within(one).getByRole('textbox', { name: '项目名' });
  expect(field).toHaveValue('试跑');
  await user.clear(field);
  await user.type(field, '  新名字  ');
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'PUT', body: { name: '新名字' } }]));
  await waitFor(() => noSave(one));
  expect(within(one).getByRole('textbox', { name: '项目名' })).toHaveValue('新名字');
});

test('archiving asks first in plain words, acts at once, and the restore asks nothing', async () => {
  const calls: Call[] = [];
  // Not the sum of moving and waiting: the confirmation counts every work still under way,
  // as the service's unfinished does.
  let current = project({ unfinished: 5 });
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'POST' && call.path === '/api/projects/p1/archive') {
      calls.push(call);
      current = project({ unfinished: 5, archived_at: (call.body as { archived: boolean }).archived ? '2030-01-01T00:00:00Z' : null });
      return { project: current };
    }
    return listed([current])(call);
  });
  const one = await card();
  await user.click(tab(one, '生命周期与危险区'));
  const archiveRegion = (): HTMLElement => within(one).getByRole('region', { name: '归档 试跑' });
  expect(within(archiveRegion()).getByRole('button', { name: '归档这个项目' })).toBeInTheDocument();
  expect(calls).toEqual([]);
  await user.click(within(archiveRegion()).getByRole('button', { name: '归档这个项目' }));
  const confirm = await screen.findByRole('alertdialog', { name: '归档项目 试跑？' });
  expect(confirm).toHaveTextContent('收起来不再接活，侧栏和企微里不再出现，记录都保留，随时可以恢复');
  expect(confirm).toHaveTextContent('还有 5 项工作没结束：在跑的那一轮会做完，其余停在原地，恢复后接着做');
  await user.click(within(confirm).getByRole('button', { name: '归档' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1/archive', method: 'POST', body: { archived: true } }]));
  await waitFor(() => expect(archiveRegion()).toHaveTextContent('已归档'));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(within(archiveRegion()).getByRole('button', { name: '恢复' })).toBeInTheDocument();
  await user.click(within(archiveRegion()).getByRole('button', { name: '恢复' }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ path: '/api/projects/p1/archive', method: 'POST', body: { archived: false } }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('a project is deleted from the bottom of its settings only after its name is typed again', async () => {
  const calls: Call[] = [];
  const { user } = open(SETTINGS, listed([project({
    deletable: {
      allowed: true, reason: null,
      counts: [{ label: '工作', count: 2, unit: '项' }, { label: '轮次', count: 3, unit: '轮' }, { label: '消息', count: 1, unit: '条' }],
      scope_removed: [{ label: '知识', count: 2, unit: '条' }],
      canceled: [{ label: '知识把关/整理任务', count: 1, unit: '个' }],
      reduced: [{ label: '知识把关/整理任务', count: 2, unit: '个' }],
      finished: [{ label: '知识把关/整理任务', count: 3, unit: '个' }],
    },
  })], (call) => {
    if (call.method === 'DELETE') { calls.push(call); return { deleted: true }; }
    return undefined;
  }));
  const one = await card();
  await user.click(tab(one, '生命周期与危险区'));
  await user.click(within(one).getByRole('button', { name: '删除这个项目' }));
  const confirm = await screen.findByRole('alertdialog', { name: '删除项目 试跑？' });
  expect(confirm).toHaveTextContent('删掉的东西不能恢复');
  expect(confirm).toHaveTextContent('会删掉：2 项工作、3 轮、1 条消息');
  expect(confirm).toHaveTextContent('会保留、但去掉这个项目：2 条知识');
  expect(confirm).toHaveTextContent('会中止：1 个知识把关/整理任务');
  expect(confirm).toHaveTextContent('会接着排队、材料里去掉这个项目：2 个知识把关/整理任务');
  expect(confirm).toHaveTextContent('已经结束、只是记录里不再提被删的内容：3 个知识把关/整理任务');
  expect(confirm).toHaveTextContent('会保留：适用于所有项目的知识、用量总数、主机上的代码目录和 GitHub 仓库');
  const done = within(confirm).getByRole('button', { name: '确认删除 试跑' });
  expect(done).toBeEnabled();
  expect(within(confirm).queryByRole('textbox', { name: '再写一遍项目名' })).toBeNull();
  await user.click(done);
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p1', method: 'DELETE', body: {} }]));
  await waitFor(() => expect(window.location.hash).toBe('#/projects'));
});

test('a project with history and no archive says only to archive it first', async () => {
  const { user } = open(SETTINGS, listed([project({ deletable: { allowed: false, reason: '先归档才能删除', counts: [{ label: '工作', count: 1, unit: '项' }], scope_removed: [], canceled: [], reduced: [], finished: [] } })]));
  const one = await card();
  await user.click(tab(one, '生命周期与危险区'));
  const region = within(one).getByRole('region', { name: '删除 试跑' });
  expect(region).toHaveTextContent('先归档才能删除');
  expect(within(region).queryByRole('button', { name: '删除这个项目' })).toBeNull();
});

// Picking a project lists the ones in sight, wherever the picker is: the side column, the palette
// and the project filter of the work list (project-sessions, "项目的生命周期").
test('the side column, the palette and the work list\'s project filter leave archived projects out', async () => {
  const older = project({ ...EMPTY_PROJECT, name: '旧项目', archived_at: '2030-01-01T00:00:00Z' });
  open('#/work?show=ended', listed([project(), older], (call) => {
    if (call.path.startsWith('/api/tasks/ended')) return { total: 0, next: null, works: [], children: [] };
    return undefined;
  }));
  const nav = await screen.findByRole('navigation', { name: '项目' });
  await waitFor(() => expect(within(nav).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['#/projects', '#/projects/p1', '#/projects#archived']));
  const filter = await screen.findByRole('combobox', { name: '项目' });
  expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual(['全部项目', '试跑']);
  // The palette reads the same list the side column keeps.
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const palette = await screen.findByRole('dialog', { name: '搜索或跳转' });
  expect(within(palette).queryByText('旧项目')).toBeNull();
  expect(within(palette).getByText('试跑')).toBeInTheDocument();
});

test('the projects page shows archived projects directly with inline restore and delete actions', async () => {
  const calls: Call[] = [];
  const older = project({ ...EMPTY_PROJECT, name: '旧项目', archived_at: '2030-01-01T00:00:00Z' });
  const { user } = open('#/projects', listed([project(), older], (call) => {
    if (call.method === 'DELETE' || call.method === 'POST') { calls.push(call); return { deleted: true, project: { ...older, archived_at: null } }; }
    return undefined;
  }));
  const list = await within(screen.getByRole('main')).findByRole('list', { name: '项目' });
  expect(within(list).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['#/projects/p1']);
  const archived = await within(screen.getByRole('main')).findByRole('list', { name: '已归档的项目' });
  expect(within(archived).getByRole('link', { name: '已归档的项目 旧项目' })).toHaveAttribute('href', '#/projects/p2');
  expect(within(archived).getByText('已归档')).toBeInTheDocument();
  await user.click(within(archived).getByRole('button', { name: '删除' }));
  const confirm = await screen.findByRole('alertdialog', { name: '删除项目 旧项目？' });
  await user.click(within(confirm).getByRole('button', { name: '确认删除 旧项目' }));
  await waitFor(() => expect(calls).toEqual([{ path: '/api/projects/p2', method: 'DELETE', body: {} }]));
});

// The project's standing rules are its knowledge entries: listed here, written through the
// knowledge page's own form as the owner's change, with the scope and loading already set.
test('a project\'s standing rules are its resident entries for any role, and a new one is proposed for this project, resident', async () => {
  const entry = (id: string, over: object) => ({ id, revision: 1, kind: 'knowledge', title: id, when_to_use: `用 ${id}`, body: '正文', project_ids: ['p1'], loading: 'resident', roles: [], proposal_id: 'x', published_by: 'owner', published_at: '2030-01-01T00:00:00Z', reviewed_at: null, created_at: '2030-01-01T00:00:00Z', state: 'active', retired_at: null, retired_by: null, retired_reason: null, replaced_by: null, ...over });
  const calls: Call[] = [];
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'GET' && call.path === '/api/knowledge') return {
      legacy: [], awaiting: [], to_review: [], proposals: [], clients: [], executors: ['claude'],
      projects: [{ id: 'p1', name: '试跑' }], roles: [{ id: 'implement', name: '实现' }],
      entries: [entry('本项目规则', {}), entry('按需的', { loading: 'on_demand' }), entry('限职能的', { roles: ['implement'] }), entry('别的项目的', { project_ids: ['p2'] }), entry('全局的', { project_ids: null }), entry('退役的', { state: 'retired' })],
    };
    if (call.method === 'POST' && call.path === '/api/knowledge/proposals') { calls.push(call); return { id: 'kp1' }; }
    return listed([project()])(call);
  });
  const one = await card();
  await user.click(tab(one, '常驻规则'));
  const rules = part(one, '的常驻规则');
  const list = await within(rules).findByRole('list', { name: '试跑 的常驻规则' });
  expect(within(list).getAllByRole('listitem').map((row) => row.querySelector('a span')!.textContent)).toEqual(['本项目规则']);
  expect(within(list).getByRole('link', { name: /本项目规则/ })).toHaveAttribute('href', '#/knowledge/entries/%E6%9C%AC%E9%A1%B9%E7%9B%AE%E8%A7%84%E5%88%99');
  expect(rules).toHaveTextContent('另有 1 条全局常驻的也适用');
  await user.click(within(rules).getByRole('button', { name: '新建规则' }));
  const form = await screen.findByRole('dialog', { name: '新建这个项目的规则' });
  expect(form).toBeInTheDocument();
  noSave(one);
});

test('editing across horizontal settings sub-tabs keeps all unsaved changes and saves them together', async () => {
  const calls: Call[] = [];
  let current = project();
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'PUT') {
      calls.push(call);
      current = project({
        name: '联合改名',
        logins: ['t2'],
        machines: [{ uid: 'uid-h1', name: 'h1' }, { uid: 'uid-h2', name: 'h2' }],
      });
      return { project: current };
    }
    return listed([current])(call);
  });
  const one = await card();
  const basicTab = tab(one, '基础与代码');
  const computeTab = tab(one, '登录与机器');
  const rulesTab = tab(one, '常驻规则');
  expect(basicTab).toHaveAttribute('aria-selected', 'true');
  expect(within(one).queryByRole('region', { name: '试跑 允许的机器' })).toBeNull();
  noSave(one);

  // Edit project name on 基础与代码 tab.
  const nameField = within(one).getByRole('textbox', { name: '项目名' });
  await user.clear(nameField);
  await user.type(nameField, '联合改名');
  expect(basicTab).toHaveAttribute('data-dirty', 'true');
  expect(computeTab).not.toHaveAttribute('data-dirty');
  expect(within(one).getByText('有改动还没保存')).toBeInTheDocument();
  expect(save(one)).toBeEnabled();

  // Switch to 登录与机器: unsaved bar stays visible and 基础与代码 stays marked dirty.
  await user.click(computeTab);
  expect(computeTab).toHaveAttribute('aria-selected', 'true');
  expect(basicTab).toHaveAttribute('aria-selected', 'false');
  expect(basicTab).toHaveAttribute('data-dirty', 'true');
  expect(within(one).queryByRole('textbox', { name: '项目名' })).toBeNull();
  expect(within(one).getByText('有改动还没保存')).toBeInTheDocument();

  // Edit both a login and a machine on 登录与机器.
  await user.click(await within(one).findByRole('checkbox', { name: '账号 t1' }));
  await user.click(within(one).getByRole('checkbox', { name: 'h2' }));
  expect(computeTab).toHaveAttribute('data-dirty', 'true');
  expect(basicTab).toHaveAttribute('data-dirty', 'true');

  // Peek at another tab (常驻规则): the unsaved bar remains visible and clickable.
  await user.click(rulesTab);
  expect(rulesTab).toHaveAttribute('aria-selected', 'true');
  expect(within(one).getByText('有改动还没保存')).toBeInTheDocument();

  // Save once from any tab: sends both 基础与代码 and 登录与机器 edits together.
  await user.click(save(one));
  await waitFor(() => expect(calls).toEqual([{
    path: '/api/projects/p1',
    method: 'PUT',
    body: {
      name: '联合改名',
      login_mode: 'selected',
      logins: ['t2'],
      machines: ['uid-h1', 'uid-h2'],
    },
  }]));
  await waitFor(() => noSave(one));
  expect(tab(one, '基础与代码')).not.toHaveAttribute('data-dirty');
  expect(tab(one, '登录与机器')).not.toHaveAttribute('data-dirty');

  // Verify saved values persist across tabs.
  await user.click(tab(one, '基础与代码'));
  expect(within(one).getByRole('textbox', { name: '项目名' })).toHaveValue('联合改名');
  await user.click(tab(one, '登录与机器'));
  expect(order(one)).toEqual(['账号 t2']);
  expect(picked(one)).toEqual(['h1', 'h2']);
});

test('project settings 群聊与通知 tab manages scoped group bindings, inline toggles, and quick-bind', async () => {
  const calls: Call[] = [];
  let bindings = [
    {
      id: 'gb1',
      created_at: '2030-01-01T00:00:00.000Z',
      updated_at: '2030-01-01T00:00:00.000Z',
      channel: 'wecom' as const,
      chat_id: 'wr_ops',
      chat_name: '试跑值班群',
      project_id: 'p1',
      project_name: '试跑',
      enabled: true,
      trigger_mode: 'mention_only' as const,
      allow_all_senders: false,
      allowed_senders: [],
      rule_keywords: [],
      cooldown_seconds: 15,
      inline_context_count: 10,
      accept_media: true,
      notify_events: true,
      last_triggered_at: null,
    },
  ];
  const discovered = [
    {
      channel: 'weixin' as const,
      chat_id: 'wx_new_group',
      last_seen_at: '2030-01-02T00:00:00.000Z',
      last_actor: 'alice',
      last_text: '请看下线上日志',
      message_count: 4,
    },
  ];
  const { user } = open(SETTINGS, (call) => {
    if (call.method === 'GET' && call.path === '/api/projects/p1/groups') return { bindings, discovered };
    if (call.method === 'PUT' && call.path === '/api/im/groups/gb1') {
      calls.push(call);
      const body = call.body as Record<string, unknown>;
      bindings = [{ ...bindings[0]!, ...body }];
      return { binding: bindings[0] };
    }
    if (call.method === 'POST' && call.path === '/api/im/groups') {
      calls.push(call);
      return { binding: { ...bindings[0]!, id: 'gb2', ...(call.body as object) } };
    }
    return listed([project()])(call);
  });

  const one = await screen.findByRole('article', { name: '项目 试跑' });
  await user.click(tab(one, '群聊与通知'));

  const row = await within(one).findByRole('listitem', { name: '群聊绑定 试跑值班群' });
  expect(row).toHaveTextContent('wr_ops');
  // Toggle notify_events inline.
  await user.click(within(row).getByRole('switch', { name: '接收播报 试跑值班群' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ path: '/api/im/groups/gb1', method: 'PUT', body: { notify_events: false, accept_media: true, enabled: true } });

  // Quick-bind discovered group to this project.
  await user.click(within(one).getByRole('button', { name: '绑定到此项目' }));
  const sheet = await screen.findByRole('dialog', { name: '绑定群聊' });
  expect(within(sheet).getByRole('textbox', { name: '群 ID' })).toHaveValue('wx_new_group');
  expect(within(sheet).getByRole('textbox', { name: '绑定项目' })).toHaveValue('试跑');
  await user.type(within(sheet).getByRole('textbox', { name: '群备注名' }), '微信通知群');
  await user.click(within(sheet).getByRole('button', { name: '确认绑定' }));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toMatchObject({
    path: '/api/im/groups',
    method: 'POST',
    body: { channel: 'weixin', chat_id: 'wx_new_group', chat_name: '微信通知群', project_id: 'p1' },
  });
});

test('project triggers support toggling group broadcast, pinning bound groups, and showing 播报群 badge', async () => {
  const calls: Call[] = [];
  const broadcastTrigger = aTrigger({ broadcast_groups: true, broadcast_group_ids: ['g1'] });
  const { user } = open(TRIGGERS, (call) => {
    if (call.method === 'GET' && call.path === '/api/projects/p1/triggers') {
      return {
        triggers: [broadcastTrigger],
        recent: [],
        zone: 'Asia/Shanghai',
        min_interval_ms: 300_000,
        groups: [
          { id: 'g1', channel: 'wecom', chat_id: 'wr_1', chat_name: '核心研发群', project_id: 'p1', enabled: true, notify_events: true },
          { id: 'g2', channel: 'weixin', chat_id: 'wx_2', chat_name: '测试播报群', project_id: 'p1', enabled: true, notify_events: true },
        ],
      };
    }
    if (call.method === 'PUT' && call.path === '/api/triggers/tr1') {
      calls.push(call);
      return { trigger: broadcastTrigger };
    }
    return listed([project()])(call);
  });

  const section = await triggersOf();
  const detail = await within(section).findByRole('article', { name: '触发器详情 早检' });
  expect(within(detail).getByText('播报群')).toBeInTheDocument();

  await user.click(within(detail).getByRole('button', { name: '修改' }));
  const form = await drawer('修改触发器');
  expect(within(form).getByRole('switch', { name: '同步播报到项目绑定群' })).toHaveAttribute('aria-checked', 'true');
  expect(within(form).getByRole('checkbox', { name: '核心研发群' })).toBeChecked();
  await user.click(within(form).getByRole('checkbox', { name: '测试播报群' }));
  await user.click(within(form).getByRole('button', { name: '保存触发器' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.body).toMatchObject({
    broadcast_groups: true,
    broadcast_group_ids: ['g1', 'g2'],
  });
});
