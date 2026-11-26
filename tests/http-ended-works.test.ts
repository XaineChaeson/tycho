// Guards against ended work piling up on every page read (the side column's listing and the
// overview carrying every work the ledger ever held), and against what is cut from them being
// lost: an ended work no page reaches, a page of the ended list that skips or repeats one, a
// filter by project or by words that lets the wrong work through, and a work with a child
// still going counted as ended.
import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workSummaries } from '../service/work-summary.ts';
import { RECENT_ENDED } from '../shared/labels.ts';
import { consoleApp } from './console-helpers.ts';
import { USER } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();
const ids = (rows: { id: string }[]): string[] => rows.map(({ id }) => id);

// `count` works ended one minute apart, the last one ended first in the returned list.
function endWorks(f: Awaited<ReturnType<typeof consoleApp>>['f'], count: number, title = (n: number) => `已结束 ${n}`): string[] {
  const ended: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const task = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: title(n), goal: '目标' }, USER);
    f.ledger.abandonTask(task.id, '不要了', USER);
    f.force('UPDATE task SET closed_at = ? WHERE id = ?', new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(), task.id);
    ended.push(task.id);
  }
  return ended.reverse();
}

test('the listing carries every open work and only the most recent ended ones; the ended list pages through all of them', async (t) => {
  const { f, get } = await consoleApp(t);
  const ended = endWorks(f, RECENT_ENDED + 3);
  const open = [f.queuedTask().id, f.queuedTask().id];

  const listing = await json(await get('/api/tasks?top=1'));
  assert.deepEqual(new Set(ids(listing.tasks)), new Set([...open, ...ended.slice(0, RECENT_ENDED)]));

  const overview = await json(await get('/api/overview'));
  assert.deepEqual(ids(overview.recent), ended.slice(0, RECENT_ENDED));
  assert.deepEqual(new Set(ids(overview.moving)), new Set(open));

  const first = await json(await get('/api/tasks/ended?limit=4'));
  assert.equal(first.total, ended.length);
  assert.deepEqual(ids(first.works), ended.slice(0, 4));
  assert.equal(first.works[0].summary.ended_at, '2026-11-01T00:10:00.000Z');
  assert.equal(first.works[0].summary.dot, 'done');
  const rest = await json(await get(`/api/tasks/ended?limit=4&after=${encodeURIComponent(first.next)}`));
  const last = await json(await get(`/api/tasks/ended?limit=4&after=${encodeURIComponent(rest.next)}`));
  assert.deepEqual([...ids(first.works), ...ids(rest.works), ...ids(last.works)], ended);
  assert.equal(last.next, null);
  assert.equal((await get('/api/tasks/ended', {})).status, 401);
});

test('the ended list filters by project and by words in the title, and refuses a page it cannot read', async (t) => {
  const { f, get } = await consoleApp(t);
  const [deploy] = endWorks(f, 1, () => '部署 Deploy 脚本');
  endWorks(f, 1, () => '别的事');
  const other = f.ledger.createProject({ name: '另一个', loginMode: 'all' }, USER);
  const elsewhere = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '另一个项目里的', goal: '目标' }, USER);
  f.ledger.abandonTask(elsewhere.id, '不要了', USER);

  assert.deepEqual(ids((await json(await get('/api/tasks/ended?q=deploy'))).works), [deploy]);
  assert.deepEqual(ids((await json(await get(`/api/tasks/ended?q=${encodeURIComponent(deploy!)}`))).works), [deploy], '编号也能搜到');
  const theirs = await json(await get(`/api/tasks/ended?project=${other}`));
  assert.deepEqual([ids(theirs.works), theirs.total], [[elsewhere.id], 1]);
  assert.equal((await json(await get(`/api/tasks/ended?project=${f.projectId}`))).total, 2);
  for (const bad of ['limit=0', 'limit=abc', 'limit=1000', 'after=nonsense']) assert.equal((await get(`/api/tasks/ended?${bad}`)).status, 400, bad);
});

test('a work is ended only when everything under it has ended, at the time its last part did', async (t) => {
  const { f, get } = await consoleApp(t);
  const work = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, title: '有子任务的工作', goal: '目标' }, USER);
  const child = f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, parentId: work.id, title: '子任务', goal: '目标', acceptance: '测试通过' }, USER);
  f.ledger.queueTask(child.id, USER);
  assert.equal((await json(await get('/api/tasks/ended'))).total, 0);
  const listing = await json(await get('/api/tasks?top=1'));
  assert.deepEqual([ids(listing.tasks), ids(listing.children)], [[work.id], [child.id]]);

  f.ledger.abandonTask(child.id, '不要了', USER);
  f.force('UPDATE task SET closed_at = ? WHERE id = ?', '2026-11-02T03:04:05.000Z', child.id);
  const ended = await json(await get('/api/tasks/ended'));
  assert.deepEqual(ids(ended.works), [work.id]);
  assert.equal(ended.works[0].summary.ended_at, '2026-11-02T03:04:05.000Z');
  assert.deepEqual(ids(ended.children), [child.id], '列表上能画出它的子任务');
});

// Each change alone: together, one newer and one fewer cancel out and an offset reads right.
for (const [change, alter] of [
  ['a newer work ends', (f: Awaited<ReturnType<typeof consoleApp>>['f']) => {
    endWorks(f, 1, () => '刚结束的');
    f.force("UPDATE task SET closed_at = '2026-11-05T00:00:00.000Z' WHERE title = '刚结束的'");
  }],
  ['the first work read reopens', (f: Awaited<ReturnType<typeof consoleApp>>['f'], first: string) => {
    f.ledger.queueTask(f.ledger.createTask({ roleId: 'implement', projectId: f.projectId, parentId: first, title: '子任务', goal: '目标', acceptance: '测试通过' }, USER).id, USER);
  }],
] as const) {
  test(`${change} between two pages: the next page starts after the last work read, with nothing repeated or missed`, async (t) => {
    const { f, get } = await consoleApp(t);
    const [a, b, c] = endWorks(f, 3);
    const first = await json(await get('/api/tasks/ended?limit=2'));
    assert.deepEqual(ids(first.works), [a, b]);
    alter(f, a!);
    const second = await json(await get(`/api/tasks/ended?limit=2&after=${encodeURIComponent(first.next)}`));
    assert.deepEqual([ids(second.works), second.next], [[c], null]);
  });
}

test('summaries of a work with many tasks under it are computed in time that grows with the tasks, not their square', () => {
  const wide = (n: number) => [{ id: 'w', parent_id: null, state: 'draft' }, ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, parent_id: 'w', state: 'done' }))];
  const time = (n: number): number => {
    const tasks = wide(n);
    const start = performance.now();
    for (let i = 0; i < 5; i += 1) workSummaries(tasks, [])('w');
    return performance.now() - start;
  };
  time(1000);
  const small = time(20_000);
  const large = time(80_000);
  assert.equal(workSummaries(wide(3), [])('w').dot, 'done');
  assert.ok(large < small * 10, `四倍的任务用了 ${(large / small).toFixed(1)} 倍的时间`);
});