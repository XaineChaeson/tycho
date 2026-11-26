// Guards the list of all work against: work filed under the wrong heading (stopped work
// among what is over, a machine out of contact under "等你"), ended work mixed into what
// is still going, a task that is its own work reading as a count with its reason dropped,
// the progress of a work's tasks told by colour alone, a list that does not say which
// project a work belongs to; and the ended list against: reading everything at once, a
// filter that is not sent to the service, a link to one project's ended work that opens
// unfiltered, and a page that claims there is nothing when the read failed.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { deferred, holdClock, open, pass, refusal, type Handler } from '@/test/harness';

const leaf = (dot: string) => ({ dot, text: '', counts: {}, leaf: true });
const work = (id: string, state: string, more: object = {}) => ({ id, title: `工作 ${id}`, state, reason: null, project_id: 'p1', summary: leaf(state), ...more });
const PROJECTS = { projects: [{ id: 'p1', name: '试跑', moving: 0, waiting: 0, logins: [], machines: [] }, { id: 'p2', name: '量化', moving: 0, waiting: 0, logins: [], machines: [] }] };
const listing = (tasks: object[], children: object[] = []): Handler => (call) =>
  (call.path === '/api/tasks?top=1' ? { tasks, children } : call.path === '/api/projects' ? PROJECTS : undefined);
const group = (name: string): HTMLElement => screen.getByRole('region', { name });
const hrefs = (name: string): string[] => within(group(name)).getAllByRole('link').map((link) => link.getAttribute('href')!);

test('work that is not over is filed by who it waits for: stopped work waits for the owner, a machine out of contact does not, and what ended is not here', async () => {
  open('#/work', listing([
    work('done', 'done'), work('lost', 'needs_verification'), work('ask', 'running', { summary: leaf('waiting_person') }),
    work('held', 'held', { reason: '派发失败' }), work('ready', 'ready'), work('run', 'running'), work('gone', 'abandoned', { summary: leaf('done') }),
  ]));
  await screen.findByRole('link', { name: /工作 held/ });
  expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['等你', '在推进', '待验收']);
  expect(hrefs('等你')).toEqual(['#/work/ask', '#/work/held']);
  expect(hrefs('在推进')).toEqual(['#/work/lost', '#/work/run']);
  expect(hrefs('待验收')).toEqual(['#/work/ready']);
  expect(screen.queryByRole('link', { name: /工作 done/ })).toBeNull();
  expect(screen.queryByRole('link', { name: /工作 gone/ })).toBeNull();
  // Each says which project it is of.
  expect(screen.getByRole('link', { name: /工作 held/ })).toHaveTextContent('试跑');
});

test('a heading with nothing under it is not shown, and with nothing going the page says so', async () => {
  const { unmount } = open('#/work', listing([work('run', 'running')]));
  await screen.findByRole('link', { name: /工作 run/ });
  expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['在推进']);
  unmount();
  open('#/work', listing([work('done', 'done')]));
  expect(await screen.findByText('没有在办的工作')).toBeInTheDocument();
});

test('a work with no tasks under it reads as its own state and reason; one with tasks reads as counts and shows their progress in words too', async () => {
  open('#/work', listing(
    [work('solo', 'held', { reason: '派发失败：没有可用的账号', summary: { ...leaf('held'), text: '1 个已停住' } }),
      work('many', 'draft', { summary: { dot: 'running', text: '1 个在执行，1 个待验收', counts: {}, leaf: false } })],
    [{ id: 'c1', parent_id: 'many', title: '甲', state: 'done' }, { id: 'c2', parent_id: 'many', title: '乙', state: 'running' }, { id: 'c3', parent_id: 'many', title: '丙', state: 'held', reason: '等你' }],
  ));
  const solo = await screen.findByRole('link', { name: /工作 solo/ });
  expect(solo).toHaveTextContent('已停住：派发失败：没有可用的账号');
  expect(solo.textContent).not.toMatch(/1 个已停住/);
  expect(within(solo).queryByRole('img')).toBeNull();
  const many = screen.getByRole('link', { name: /工作 many/ });
  expect(many).toHaveTextContent('1 个在执行，1 个待验收');
  const progress = within(many).getByRole('img', { name: '子任务进度，1/3 已完成' });
  expect([...progress.children].map((segment) => [segment.getAttribute('data-tone'), segment.getAttribute('title')])).toEqual([
    ['success', '甲：已完成'], ['running', '乙：执行中'], ['failed', '丙：已停住：等你'],
  ]);
});

const ended = (id: string, at: string, more: object = {}) => work(id, 'done', { summary: { ...leaf('done'), ended_at: at }, ...more });

test('what is over is a list of its own, read a page at a time, the most recently ended first as the service sends it', async () => {
  const all = Array.from({ length: 60 }, (_, index) => ended(`e${index}`, `2026-11-0${1 + (index % 9)}T00:00:00Z`));
  const { user, reads } = open('#/work?show=ended', (call) => {
    if (call.path === '/api/projects') return PROJECTS;
    if (!call.path.startsWith('/api/tasks/ended?')) return undefined;
    const asked = new URLSearchParams(call.path.split('?')[1]);
    const offset = Number(asked.get('after') ?? 0);
    const end = offset + Number(asked.get('limit'));
    return { total: all.length, next: end < all.length ? String(end) : null, works: all.slice(offset, end), children: [] };
  });
  const list = await screen.findByRole('list', { name: '已结束的工作' });
  expect(within(list).getAllByRole('link')).toHaveLength(50);
  expect(screen.getByText('共 60 项')).toBeInTheDocument();
  // The first page only (read again once the console is connected, like every page).
  expect([...new Set(reads.filter((path) => path.startsWith('/api/tasks/ended')))]).toEqual(['/api/tasks/ended?limit=50']);
  await user.click(screen.getByRole('button', { name: '再读一页' }));
  await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(60));
  expect(reads.filter((path) => path.startsWith('/api/tasks/ended')).at(-1)).toBe('/api/tasks/ended?limit=50&after=50');
  expect(screen.queryByRole('button', { name: '再读一页' })).toBeNull();
  // The tab in view is the ended one.
  const tabs = within(screen.getByRole('navigation', { name: '哪些工作' })).getAllByRole('link');
  expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-current')])).toEqual([['在办', null], ['已结束', 'page']]);
});

test('ended work is found by a word or a number and by project, and the filter is the service\'s to apply', async () => {
  const { user, reads } = open('#/work?show=ended&project=p2', (call) => {
    if (call.path === '/api/projects') return PROJECTS;
    if (call.path.startsWith('/api/tasks/ended?')) return { total: 1, next: null, works: [ended('e1', '2026-11-01T00:00:00Z', { project_id: 'p2' })], children: [] };
    return undefined;
  });
  await screen.findByRole('list', { name: '已结束的工作' });
  // A link to one project's ended work opens filtered to it.
  expect(screen.getByRole('combobox', { name: '项目' })).toHaveValue('p2');
  expect([...new Set(reads.filter((path) => path.startsWith('/api/tasks/ended')))]).toEqual(['/api/tasks/ended?limit=50&project=p2']);
  await user.type(screen.getByRole('textbox', { name: '按标题或编号找' }), '回归');
  await waitFor(() => expect(reads.at(-1)).toBe(`/api/tasks/ended?limit=50&project=p2&q=${encodeURIComponent('回归')}`));
  await user.selectOptions(screen.getByRole('combobox', { name: '项目' }), '');
  await waitFor(() => expect(reads.at(-1)).toBe(`/api/tasks/ended?limit=50&q=${encodeURIComponent('回归')}`));
});

test('a filter on an archived project still says which project it is, marked archived and not offered', async () => {
  const archived = { ...PROJECTS.projects[1]!, archived_at: '2030-01-01T00:00:00Z' };
  const { reads } = open('#/work?show=ended&project=p2', (call) => {
    if (call.path === '/api/projects') return { projects: [PROJECTS.projects[0]!, archived] };
    if (call.path.startsWith('/api/tasks/ended?')) return { total: 0, next: null, works: [], children: [] };
    return undefined;
  });
  const filter = await screen.findByRole('combobox', { name: '项目' });
  // The link that got here opened this project's ended work: the box shows it, not a blank.
  await waitFor(() => expect(filter).toHaveValue('p2'));
  await waitFor(() => expect(within(filter).getAllByRole('option').map((option) => [option.textContent, (option as HTMLOptionElement).disabled])).toEqual([
    ['全部项目', false], ['试跑', false], ['量化（已归档）', true],
  ]));
  await waitFor(() => expect([...new Set(reads.filter((path) => path.startsWith('/api/tasks/ended')))]).toEqual(['/api/tasks/ended?limit=50&project=p2']));
});

test('an ended list that cannot be read says why, and never that there is nothing', async () => {
  open('#/work?show=ended', (call) => {
    if (call.path.startsWith('/api/tasks/ended?')) throw refusal('账本不可用', 503);
    return undefined;
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('账本不可用');
  expect(screen.queryByText('没有符合条件的已结束工作')).toBeNull();
});

test('ended search debounces 250ms and keeps previous rows dimmed while fetching new results', async () => {
  holdClock();
  const nextResult = deferred();
  const { reads } = open('#/work?show=ended', (call) => {
    if (call.path === '/api/projects') return PROJECTS;
    if (!call.path.startsWith('/api/tasks/ended?')) return undefined;
    if (call.path.includes('q=')) return nextResult.promise;
    return { total: 1, next: null, works: [ended('e1', '2026-11-01T00:00:00Z')], children: [] };
  });
  await screen.findByRole('link', { name: /工作 e1/ });

  const box = screen.getByRole('textbox', { name: '按标题或编号找' });
  fireEvent.change(box, { target: { value: '回' } });
  fireEvent.change(box, { target: { value: '回归' } });
  // Before 250ms debounce elapses, no filtered search query is fired yet.
  await pass(150);
  expect(reads.filter((path) => path.includes('q='))).toEqual([]);

  // After 250ms, one debounced query fires and previous rows stay visible (dimmed) instead of flashing a skeleton.
  await pass(150);
  await waitFor(() => expect(reads.filter((path) => path.includes('q='))).toEqual([`/api/tasks/ended?limit=50&q=${encodeURIComponent('回归')}`]));
  const list = screen.getByRole('list', { name: '已结束的工作' });
  expect(within(list).getByRole('link', { name: /工作 e1/ })).toBeInTheDocument();
  expect(list).toHaveAttribute('aria-busy', 'true');
  expect(list.parentElement).toHaveClass('opacity-60');

  await act(async () => {
    nextResult.resolve({ total: 1, next: null, works: [ended('e2', '2026-11-02T00:00:00Z')], children: [] });
  });
  expect(await screen.findByRole('link', { name: /工作 e2/ })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: '已结束的工作' })).not.toHaveAttribute('aria-busy');
});
