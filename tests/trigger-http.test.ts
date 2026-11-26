// Guards the console's triggers of a project (docs/design/triggers.md §1, §7) against: the list
// not saying when a trigger fires next in its zone and in UTC, what it last refused and how often,
// or what became of its recent occurrences (delivered, merged, missed, expired — and a turn that
// did not end as "未确认完成", not as done); a definition the ledger refuses taken by this
// entrance another way, or a refused change writing anything; a project's page listing another
// project's triggers; a deleted trigger still listed, or its records lost with it; and a
// change made while the service cannot record it; and a rule the service can no longer work out
// taking the whole list down with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleApp } from './console-helpers.ts';
import { fixture, USER } from './helpers.ts';

const json = async (response: Response): Promise<any> => response.json();
const SOON = () => new Date(Date.now() + 3_600_000).toISOString();

test('a trigger made on the page is listed with its next moment, its zone and UTC, and audited as the console\'s', async (t) => {
  const { f, get, send } = await consoleApp(t);
  const made = await send('POST', `/api/projects/${f.projectId}/triggers`, {
    name: '早检', instruction: '检查构建', schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' }, missed: 'skip', push_final: true,
  });
  assert.equal(made.status, 201);
  const { trigger } = await json(made);
  assert.deepEqual([trigger.name, trigger.missed, trigger.push_final, trigger.zone], ['早检', 'skip', true, 'Asia/Shanghai']);
  const page = await json(await get(`/api/projects/${f.projectId}/triggers`));
  assert.equal(page.triggers.length, 1);
  assert.match(page.triggers[0].next_local, / 08:00$/);
  assert.ok(page.triggers[0].next_at.endsWith('Z'));
  assert.equal(typeof page.zone, 'string', '新建表单用的主机时区');
  assert.equal(typeof page.min_interval_ms, 'number');
  assert.deepEqual(f.peek<{ actor: string }>(`SELECT actor FROM change WHERE action = 'trigger.create'`).map(({ actor }) => actor), ['console']);
});

test('recent occurrences and refusals are shown as they stand', async (t) => {
  const { f, get } = await consoleApp(t);
  const now = new Date();
  const at = (ms: number) => new Date(now.getTime() + ms);
  const once = f.ledger.createTrigger(f.projectId, { name: '一次', instruction: '看', schedule: { kind: 'once', at: at(60_000).toISOString() }, push_final: true }, USER, now);
  f.ledger.fireDue(at(61_000));
  const { message } = f.ledger.takeNextTurn(f.projectId)!;
  f.ledger.finishMessage(message.id, 'unverified');
  f.ledger.acceptTriggerEvent({ triggerId: once.id, source: 'nonsense', eventId: 'x', content: 'x', data: {} }, at(62_000));
  const page = await json(await get(`/api/projects/${f.projectId}/triggers`));
  assert.deepEqual(page.recent.map(({ outcome, message_state }: { outcome: string; message_state: string }) => [outcome, message_state]), [['delivered', 'unverified']]);
  assert.equal(page.triggers[0].rejected.count, 1);
  assert.equal(page.triggers[0].rejected.reason, 'source');
  assert.ok(page.triggers[0].rejected.text);
});

test('an edit, a stop and a delete go through the ledger; a refused one writes nothing; another project\'s is out of reach', async (t) => {
  const { f, get, send } = await consoleApp(t);
  const other = f.ledger.createProject({ name: '乙', loginMode: 'all' }, USER);
  const mine = (await json(await send('POST', `/api/projects/${f.projectId}/triggers`, { name: '早检', instruction: '看', schedule: { kind: 'once', at: SOON() } }))).trigger;
  const edited = await send('PUT', `/api/triggers/${mine.id}`, { instruction: '仔细看' });
  assert.equal(edited.status, 200);
  assert.equal((await json(edited)).trigger.revision, 2);
  const refused = await send('PUT', `/api/triggers/${mine.id}`, { schedule: { kind: 'every', every_ms: 1000, anchor: SOON() } });
  assert.equal(refused.status, 400);
  assert.match((await json(refused)).error, /固定间隔至少|最小间隔/);
  assert.equal(f.ledger.getTrigger(mine.id)!.revision, 2);

  const stopped = await send('POST', `/api/triggers/${mine.id}/enabled`, { enabled: false });
  assert.equal((await json(stopped)).trigger.enabled, false);
  assert.equal((await send('POST', `/api/triggers/${mine.id}/enabled`, { enabled: 'no' })).status, 400);

  const theirs = f.ledger.createTrigger(other, { name: '乙的', instruction: '看', schedule: { kind: 'once', at: SOON() } }, USER);
  const wrongPlace = await send('POST', `/api/projects/${f.projectId}/triggers`, { name: '', instruction: '看', schedule: { kind: 'once', at: SOON() } });
  assert.equal(wrongPlace.status, 400);
  assert.equal((await send('DELETE', `/api/triggers/${mine.id}`)).status, 200);
  assert.deepEqual((await json(await get(`/api/projects/${f.projectId}/triggers`))).triggers, []);
  assert.equal((await json(await get(`/api/projects/${other}/triggers`))).triggers[0].id, theirs.id);
  assert.equal(f.peek(`SELECT 1 FROM trigger_rule WHERE id = ?`, mine.id).length, 1, '删除不抹掉记录');
  assert.equal((await send('PUT', `/api/triggers/${mine.id}`, { name: '复活' })).status, 400);
});

test('no trigger is made or changed while the service is taking stock', async (t) => {
  let recovering = false;
  const f = fixture(t, { recovery: { recovering: () => recovering } });
  const { send } = await consoleApp(t, { f });
  const mine = f.ledger.createTrigger(f.projectId, { name: '早检', instruction: '看', schedule: { kind: 'once', at: SOON() } }, USER);
  recovering = true;
  const made = await send('POST', `/api/projects/${f.projectId}/triggers`, { name: '晚检', instruction: '看', schedule: { kind: 'once', at: SOON() } });
  assert.equal(made.status, 503);
  assert.equal((await send('POST', `/api/triggers/${mine.id}/enabled`, { enabled: false })).status, 503);
  assert.equal(f.count('trigger_rule'), 1);
  assert.equal(f.ledger.getTrigger(mine.id)!.enabled, true);
});

test('a rule the service can no longer work out is listed with why, and stopped from the page', async (t) => {
  const { f, get, send } = await consoleApp(t);
  const broken = f.ledger.createTrigger(f.projectId, { name: '坏了', instruction: '看', schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' } }, USER);
  f.force('UPDATE trigger_rule SET params_json = ? WHERE id = ?', JSON.stringify({ kind: 'cron', expr: '0 8 * * *', zone: 'Nowhere/Never' }), broken.id);
  const page = await get(`/api/projects/${f.projectId}/triggers`);
  assert.equal(page.status, 200);
  const listed = (await json(page)).triggers[0];
  assert.deepEqual([listed.name, listed.next_at], ['坏了', null]);
  assert.match(listed.next_error, /Nowhere\/Never/);
  const stopped = await send('POST', `/api/triggers/${broken.id}/enabled`, { enabled: false });
  assert.equal(stopped.status, 200);
  assert.equal((await json(stopped)).trigger.enabled, false);
});
