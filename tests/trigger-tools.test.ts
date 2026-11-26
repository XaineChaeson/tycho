// Guards the project Router's trigger tools (docs/design/triggers.md §7, project-sessions §4)
// against: a Router seeing, changing or stopping another project's trigger, or one of no project;
// a trigger made in a project the call was not bound to; a rule the ledger would refuse taken by
// the tool another way (closer than the minimum interval, a cron without its zone); the Router
// deleting a trigger, which only the owner does in the console; a trigger's maker not recorded as
// the turn that made it; and the list not saying when a trigger fires next, in which zone, what
// it last refused and what became of its recent occurrences; an internal-event subscription to
// another project's Task, or of a kind not declared, taken.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createMachines } from '../service/machines.ts';
import { createTools } from '../service/tools.ts';
import { hostZone } from '../service/schedule.ts';
import { fixture, memoryLogins, USER } from './helpers.ts';

function setup(t: TestContext) {
  const f = fixture(t);
  const other = f.ledger.createProject({ name: '乙', loginMode: 'all' }, USER);
  const { id: messageId } = f.ledger.receiveMessage({ channel: 'console', externalId: 'm', actor: 'user', text: '每天早上 8 点检查一下构建', projectId: f.projectId });
  const tools = createTools({
    ledger: f.ledger,
    runner: { interrupt: async () => 'ended', events: () => [], abandon: async () => {} },
    logins: memoryLogins({}),
    machines: createMachines({ ledger: f.ledger }),
    accept: { register: async () => ({}), accept: async () => {} } as never,
  });
  const ctx = { actor: 'router', messageId };
  const call = async (name: string, args: unknown = {}, projectId = f.projectId) => {
    const result = await tools.call(name, args, ctx, { projectId });
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  const created = async (args: Record<string, unknown> = {}, projectId = f.projectId) => {
    const answer = await call('create_trigger', { name: '早检', instruction: '检查昨晚的构建', schedule: { kind: 'cron', cron: '0 8 * * *', zone: 'Asia/Shanghai' }, ...args }, projectId);
    assert.equal(answer.isError, false, answer.text);
    return /触发器已建：([0-9A-Z]+)/.exec(answer.text)![1]!;
  };
  return { f, other, tools, call, created, messageId };
}

test('the Router manages its own project\'s triggers: make, read, change, stop — and never delete', async (t) => {
  const { f, tools, call, created, messageId } = setup(t);
  assert.ok(['list_triggers', 'create_trigger', 'update_trigger', 'set_trigger_enabled'].every((name) => tools.names.includes(name)));
  assert.equal(tools.names.some((name) => /delete.*trigger|trigger.*delete/.test(name)), false, '删除只在控制台');
  const id = await created();
  const trigger = f.ledger.getTrigger(id)!;
  assert.deepEqual([trigger.project_id, trigger.created_by, trigger.schedule], [f.projectId, 'router', { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' }]);
  const made = f.peek<{ message_id: string }>(`SELECT message_id FROM change WHERE action = 'trigger.create'`);
  assert.deepEqual(made.map(({ message_id }) => message_id), [messageId], '记在建它的那一回合下');

  const listed = JSON.parse((await call('list_triggers')).text) as { triggers: { id: string; next_local: string; zone: string; next_at: string }[]; recent: unknown[] };
  assert.equal(listed.triggers[0]!.id, id);
  assert.match(listed.triggers[0]!.next_local, / 08:00$/);
  assert.equal(listed.triggers[0]!.zone, 'Asia/Shanghai');
  assert.ok(listed.triggers[0]!.next_at.endsWith('Z'), '同时给 UTC 时刻');

  assert.equal((await call('update_trigger', { trigger_id: id, instruction: '检查构建和测试' })).isError, false);
  assert.equal(f.ledger.getTrigger(id)!.revision, 2);
  assert.equal((await call('set_trigger_enabled', { trigger_id: id, enabled: false })).isError, false);
  assert.equal(f.ledger.getTrigger(id)!.enabled, false);
});

test('another project\'s trigger reads as one that is not there, and nothing of it changes', async (t) => {
  const { f, other, call, created } = setup(t);
  const theirs = await created({ name: '乙的' }, other);
  for (const [name, args] of [['update_trigger', { trigger_id: theirs, name: '改掉' }], ['set_trigger_enabled', { trigger_id: theirs, enabled: false }]] as const) {
    const answer = await call(name, args);
    assert.equal(answer.isError, true);
    assert.match(answer.text, /触发器不存在/);
  }
  assert.deepEqual(JSON.parse((await call('list_triggers')).text).triggers, []);
  const kept = f.ledger.getTrigger(theirs)!;
  assert.deepEqual([kept.name, kept.enabled, kept.revision], ['乙的', true, 1]);
});

test('a rule is taken as the ledger takes it: the minimum interval holds and a cron keeps the host zone', async (t) => {
  const { f, call, created } = setup(t);
  const dense = await call('create_trigger', { name: '太密', instruction: '看', schedule: { kind: 'every', every_minutes: 1 } });
  assert.equal(dense.isError, true);
  assert.match(dense.text, /最小间隔/);
  const id = await created({ schedule: { kind: 'cron', cron: '30 7 * * 1-5' } });
  assert.equal((f.ledger.getTrigger(id)!.schedule as { zone: string }).zone, hostZone());
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const once = await created({ name: '一次', schedule: { kind: 'once', at: later }, push_final: true, missed: 'skip' });
  assert.deepEqual([f.ledger.getTrigger(once)!.push_final, f.ledger.getTrigger(once)!.missed], [true, 'skip']);
  const wrong = await call('create_trigger', { name: '缺', instruction: '看', schedule: { kind: 'once' } });
  assert.equal(wrong.isError, true);
});

// Review of step 1: a count of missed moments that reached its cap is a lower bound, and says so.
test('the Router reads a capped count of moments as at least that many', async (t) => {
  const { f, call } = setup(t);
  const now = new Date();
  const trigger = f.ledger.createTrigger(f.projectId, { name: '密', instruction: '看', schedule: { kind: 'every', every_ms: 5 * 60_000, anchor: now.toISOString() } }, USER, now);
  f.ledger.fireDue(new Date(now.getTime() + 40 * 86_400_000));
  const { recent } = JSON.parse((await call('list_triggers')).text) as { recent: { trigger_id: string; moments: number; moments_at_least: boolean }[] };
  assert.deepEqual(recent.filter(({ trigger_id }) => trigger_id === trigger.id).map(({ moments, moments_at_least }) => [moments, moments_at_least]), [[10_000, true]]);
});

// docs/design/triggers.md §2.3, §7: the Router subscribes its project to an internal event, one of
// its own Tasks at most; another project's Task, an unknown kind and a change of source are refused.
test('the Router subscribes its project to an internal event, and only to its own Tasks', async (t) => {
  const { f, other, call } = setup(t);
  const mine = f.newTask();
  const theirs = f.ledger.createTask({ roleId: 'implement', projectId: other, title: '乙的', goal: '目标', acceptance: '通过' }, USER);
  const made = await call('create_trigger', { name: '合入后', instruction: '接着做 {{task_id}}', source: 'event', event: { kind: 'merged', task_id: mine.id } });
  assert.equal(made.isError, false, made.text);
  const id = /触发器已建：([0-9A-Z]+)/.exec(made.text)![1]!;
  assert.deepEqual([f.ledger.getTrigger(id)!.source, f.ledger.getTrigger(id)!.event], ['event', { kind: 'merged', task_id: mine.id }]);
  const listed = JSON.parse((await call('list_triggers')).text) as { triggers: { id: string; source: string; schedule: string; event: unknown }[] };
  assert.deepEqual(listed.triggers.map(({ source, event }) => [source, event]), [['event', { kind: 'merged', task_id: mine.id }]]);
  assert.match(listed.triggers[0]!.schedule, /已合入/);

  assert.match((await call('create_trigger', { name: 'x', instruction: 'y', source: 'event', event: { kind: 'merged', task_id: theirs.id } })).text, /只能看本项目/);
  assert.equal((await call('create_trigger', { name: 'x', instruction: 'y', source: 'event', event: { kind: 'stopped' } })).isError, true);
  assert.equal((await call('update_trigger', { trigger_id: id, event: { kind: 'released' } })).isError, false);
  assert.deepEqual(f.ledger.getTrigger(id)!.event, { kind: 'released', task_id: null });
});
