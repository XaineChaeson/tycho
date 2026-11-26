// Guards the triggers of docs/design/triggers.md (§1, §3, §4, §5, §6) against:
// - a rule kept that cannot work: no name or instruction, a one-time moment already past, an
//   interval or cron closer than the minimum interval, an unknown missed policy, a deadline without
//   a zone, a project that does not exist; a cron stored without its zone;
// - an occurrence accepted without its record, message and cursor in one transaction, or half of
//   them standing after a crash on either side of the commit;
// - a normal scan delay taken as a miss, or a miss past the grace period delivered as if on time;
//   the missed policy ignored (skip delivering, latest delivering every moment one by one);
// - a deadline overridden by the missed policy, or "expired" said more than once;
// - a disabled trigger piling up moments it then delivers when enabled; an edited rule reaching
//   back to moments before the edit; a clock set back firing a moment again; a clock jumping
//   forward delivering every skipped moment;
// - a periodic trigger putting more than one message in the queue, merging into a message the
//   Router has already taken, or merging an occurrence of a new revision into an old one;
// - independent occurrences queued without bound, crowding out the owner's messages, or a refused
//   one writing a trigger record; rate and size limits not applied; a refusal not counted;
// - an identity occupied by an occurrence that was refused; the same identity and content not
//   answered with the original receipt (or refused because the queue is full now); different
//   content under the same identity accepted; the retention of an identity counted from a retry,
//   or never ending;
// - a trigger turn's work not carrying where it came from, so that its later events could set
//   triggers off again; an event that does carry it accepted, counted or recorded;
// - the global pause stopping triggers; schedule_wake changed by the shared scan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from '../service/triggers.ts';
import type { MessageRow } from '../service/messages.ts';
import { hostZone } from '../service/schedule.ts';
import { InputError } from '../service/errors.ts';
import type { LedgerOptions } from '../service/ledger.ts';
import { DONE, fixture, LOGIN, RUN_LIMIT_MS, USER } from './helpers.ts';

const MIN = 60_000;
const T0 = new Date('2030-01-01T00:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
class Crash extends Error {}

function setup(t: TestContext, policy: Partial<TriggerPolicy> = {}, options: LedgerOptions = {}) {
  const held: TriggerPolicy = { ...DEFAULT_TRIGGER_POLICY, graceMs: 2 * MIN, minIntervalMs: MIN, ...policy };
  const f = fixture(t, { triggerPolicy: () => held, ...options });
  const make = (fields: Record<string, unknown>, now = T0, projectId = f.projectId) =>
    f.ledger.createTrigger(projectId, { name: '早检', instruction: '检查一下昨晚的构建', ...fields }, USER, now);
  const every = (minutes: number, fields: Record<string, unknown> = {}, now = T0) =>
    make({ schedule: { kind: 'every', every_ms: minutes * MIN, anchor: now.toISOString() }, ...fields }, now);
  const fires = (triggerId: string) => f.ledger.listTriggerFires({ triggerId, limit: 1000 }).reverse();
  const messages = (): MessageRow[] => f.peek<MessageRow>(`SELECT * FROM message WHERE channel = 'trigger' ORDER BY rowid`);
  const pending = (): MessageRow[] => messages().filter((row) => row.state === 'received');
  return { f, held, make, every, fires, messages, pending };
}

test('a rule that cannot work is refused before anything is written, and a cron keeps the zone it runs in', (t) => {
  const { f, make, every } = setup(t, { minIntervalMs: 10 * MIN });
  const refused = (fields: Record<string, unknown>, pattern: RegExp) => assert.throws(() => make(fields), (err: Error) => err instanceof InputError && pattern.test(err.message));
  refused({ name: ' ', schedule: { kind: 'once', at: at(MIN).toISOString() } }, /名字/);
  refused({ instruction: '', schedule: { kind: 'once', at: at(MIN).toISOString() } }, /指令/);
  refused({ schedule: { kind: 'once', at: at(-MIN).toISOString() } }, /已经过了/);
  refused({ schedule: { kind: 'every', every_ms: 5 * MIN, anchor: T0.toISOString() } }, /最小间隔/);
  refused({ schedule: { kind: 'cron', expr: '*/5 * * * *', zone: 'UTC' } }, /最小间隔/);
  refused({ schedule: { kind: 'once', at: at(MIN).toISOString() }, missed: 'all' }, /错过/);
  refused({ schedule: { kind: 'once', at: at(MIN).toISOString() }, expires_at: '2030-02-01T00:00:00' }, /截止/);
  assert.throws(() => make({ schedule: { kind: 'once', at: at(MIN).toISOString() } }, T0, 'nope'), /项目不存在/);
  assert.equal(f.count('trigger_rule'), 0);
  assert.equal(f.count('trigger_cursor'), 0);

  const cron = make({ schedule: { kind: 'cron', expr: '0 8 * * *' } });
  assert.equal(cron.schedule?.kind === 'cron' && cron.schedule.zone, hostZone(), '默认主机时区，并且存下来');
  assert.deepEqual([cron.enabled, cron.missed, cron.push_final, cron.revision, cron.source], [true, 'latest', false, 1, 'schedule']);
  const periodic = every(10);
  assert.equal(periodic.next_at, at(10 * MIN).toISOString());
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'trigger.create'`).length, 2);
});

test('an edit is judged as a new rule only when the time rule changed', (t) => {
  const { f, make, held } = setup(t, { minIntervalMs: MIN });
  const once = make({ schedule: { kind: 'once', at: at(MIN).toISOString() } });
  f.ledger.fireDue(at(MIN));
  // The page sends the whole definition back; the rule as it was is not refused for being past.
  const edited = f.ledger.updateTrigger(once.id, { name: '改名', schedule: { kind: 'once', at: at(MIN).toISOString() } }, USER, at(10 * MIN));
  assert.equal(edited.name, '改名');
  assert.throws(() => f.ledger.updateTrigger(once.id, { schedule: { kind: 'once', at: at(5 * MIN).toISOString() } }, USER, at(10 * MIN)), /已经过了/);
  // A rule kept from before the minimum interval was raised can still have its name changed.
  const cron = make({ name: '密', schedule: { kind: 'cron', expr: '*/2 * * * *', zone: 'UTC' } });
  held.minIntervalMs = 10 * MIN;
  assert.doesNotThrow(() => f.ledger.updateTrigger(cron.id, { name: '还是密', schedule: { kind: 'cron', expr: '*/2 * * * *', zone: 'UTC' } }, USER, at(10 * MIN)));
  assert.equal(f.ledger.getTrigger(cron.id)!.revision, 2);
  assert.equal(f.ledger.updateTrigger(cron.id, { name: '还是密' }, USER, at(11 * MIN)).revision, 2, '没有变化不算新修订');
});

test('an occurrence on time is one record, one message to the project and the cursor moved, in one go', (t) => {
  const { f, make, fires, messages } = setup(t);
  const trigger = make({ schedule: { kind: 'once', at: at(5 * MIN).toISOString() } });
  assert.equal(f.ledger.fireDue(at(5 * MIN - 1)).fired, 0, '没到点不触发');
  assert.equal(f.ledger.fireDue(at(5 * MIN + 30_000)).fired, 1);
  const [fire] = fires(trigger.id);
  assert.equal(fire!.outcome, 'delivered');
  assert.equal(fire!.event_id, at(5 * MIN).toISOString());
  assert.equal(fire!.scheduled_at, at(5 * MIN).toISOString());
  assert.equal(fire!.revision, 1);
  const [message] = messages();
  assert.equal(message!.id, fire!.message_id);
  assert.deepEqual([message!.project_id, message!.state, message!.basis, message!.direction], [f.projectId, 'received', 'trigger', 'in']);
  assert.match(message!.text.split('\n')[0]!, /触发器“早检”/);
  assert.match(message!.text, /不是主人说的话/);
  assert.match(message!.text, /检查一下昨晚的构建/);
  assert.equal(f.ledger.getTrigger(trigger.id)!.next_at, null, '一次性的触发过了就没有下一次');
  assert.equal(f.ledger.fireDue(at(60 * MIN)).fired, 0);
  assert.equal(fires(trigger.id).length, 1);
});

test('a scan within the grace period is on time; past it the missed policy decides', (t) => {
  const { f, make, fires, messages } = setup(t);
  const late = make({ name: '晚到', schedule: { kind: 'once', at: at(MIN).toISOString() }, missed: 'skip' });
  const lateLatest = make({ name: '补投', schedule: { kind: 'once', at: at(MIN).toISOString() } });
  const onTime = make({ name: '宽限内', schedule: { kind: 'once', at: at(10 * MIN).toISOString() }, missed: 'skip' });
  f.ledger.fireDue(at(MIN + 2 * MIN + 1000));
  assert.deepEqual(fires(late.id).map(({ outcome }) => outcome), ['missed'], '跳过：只记错过，不投消息');
  assert.equal(fires(late.id)[0]!.message_id, null);
  assert.deepEqual(fires(lateLatest.id).map(({ outcome }) => outcome), ['delivered'], '一次性的默认补投');
  assert.equal((fires(lateLatest.id)[0]!.data as { late: boolean }).late, true);
  f.ledger.fireDue(at(10 * MIN + 2 * MIN - 1000));
  assert.deepEqual(fires(onTime.id).map(({ outcome }) => outcome), ['delivered'], '正常的扫描延迟不算错过');
  assert.equal(messages().length, 2);
});

test('moments missed while the service was down: latest delivers one that says how many; skip delivers none of the late ones', (t) => {
  const { f, every, fires, messages } = setup(t);
  const latest = every(10);
  const skip = every(10, { name: '跳过', missed: 'skip' });
  f.ledger.fireDue(at(65 * MIN));
  const [one] = fires(latest.id);
  assert.equal(fires(latest.id).length, 1);
  assert.equal(one!.outcome, 'delivered');
  assert.equal(one!.event_id, at(60 * MIN).toISOString(), '补的是最近一次');
  assert.equal(one!.merged_count, 6, '记下合并了几个时刻');
  assert.match(messages()[0]!.text, /6 个时刻/);
  assert.deepEqual(fires(skip.id).map(({ outcome, merged_count }) => [outcome, merged_count]), [['missed', 6]]);
  assert.equal(messages().length, 1);

  // Skip with the last moment on time: that one goes, the late ones are recorded as missed.
  const { f: g, every: every2, fires: fires2 } = setup(t);
  const mixed = every2(10, { missed: 'skip' });
  g.ledger.fireDue(at(60 * MIN + 30_000));
  assert.deepEqual(fires2(mixed.id).map(({ outcome, merged_count, event_id }) => [outcome, merged_count, event_id]), [
    ['missed', 5, at(50 * MIN).toISOString()],
    ['delivered', 1, at(60 * MIN).toISOString()],
  ]);
});

test('past the deadline an occurrence is only recorded as expired, whatever the policy, and only once', (t) => {
  const { f, every, fires, messages } = setup(t);
  const trigger = every(10, { expires_at: at(25 * MIN).toISOString() });
  f.ledger.fireDue(at(10 * MIN));
  f.ledger.fireDue(at(20 * MIN));
  // A long stop across the deadline: the moments before it follow the policy, the one after expires.
  f.ledger.fireDue(at(30 * MIN));
  f.ledger.fireDue(at(500 * MIN));
  assert.deepEqual(fires(trigger.id).map(({ outcome }) => outcome), ['delivered', 'merged', 'expired']);
  assert.equal(fires(trigger.id).at(-1)!.event_id, at(30 * MIN).toISOString());
  assert.equal(messages().length, 1);
  const view = f.ledger.getTrigger(trigger.id)!;
  assert.deepEqual([view.next_at, view.ended], [null, 'expired']);
  // Nothing left to do: later scans leave it alone rather than walking its moments forever.
  assert.deepEqual(f.peek<{ done_at: string }>('SELECT done_at FROM trigger_cursor WHERE trigger_id = ?', trigger.id).map(({ done_at }) => done_at), [at(30 * MIN).toISOString()]);
  const once = setup(t);
  const gone = once.make({ schedule: { kind: 'once', at: at(10 * MIN).toISOString() }, expires_at: at(5 * MIN).toISOString() });
  once.f.ledger.fireDue(at(11 * MIN));
  assert.deepEqual(once.fires(gone.id).map(({ outcome }) => outcome), ['expired']);
  assert.equal(once.messages().length, 0);
});

test('a disabled trigger keeps no backlog, and an edited one starts from its first future moment', (t) => {
  const { f, every, fires } = setup(t);
  const trigger = every(10);
  f.ledger.setTriggerEnabled(trigger.id, false, USER, at(MIN));
  f.ledger.fireDue(at(45 * MIN));
  assert.equal(fires(trigger.id).length, 0);
  f.ledger.setTriggerEnabled(trigger.id, true, USER, at(45 * MIN));
  f.ledger.fireDue(at(46 * MIN));
  assert.equal(fires(trigger.id).length, 0, '重新启用后不补停用期间的时刻');
  f.ledger.fireDue(at(50 * MIN));
  assert.deepEqual(fires(trigger.id).map(({ event_id }) => event_id), [at(50 * MIN).toISOString()]);

  const edited = f.ledger.updateTrigger(trigger.id, { instruction: '换个说法' }, USER, at(75 * MIN));
  assert.equal(edited.revision, 2);
  f.ledger.fireDue(at(76 * MIN));
  assert.equal(fires(trigger.id).length, 1, '改规则不追溯 60、70 分');
  f.ledger.fireDue(at(80 * MIN));
  assert.deepEqual(fires(trigger.id).map(({ revision }) => revision), [1, 2]);
  const changes = f.peek<{ action: string }>(`SELECT action FROM change WHERE action LIKE 'trigger.%' ORDER BY seq`).map(({ action }) => action);
  assert.deepEqual(changes, ['trigger.create', 'trigger.disable', 'trigger.enable', 'trigger.update']);
});

test('the cursor only moves forward: a clock set back fires nothing again, a clock jumping forward follows the missed policy', (t) => {
  const { f, every, fires } = setup(t);
  const trigger = every(60);
  f.ledger.fireDue(at(60 * MIN));
  f.ledger.fireDue(at(30 * MIN));
  f.ledger.fireDue(at(60 * MIN + 1000));
  assert.equal(fires(trigger.id).length, 1, '回拨后同一时刻不再触发');
  f.ledger.fireDue(at(4 * 60 * MIN + 1000));
  const jumped = fires(trigger.id);
  assert.equal(jumped.length, 2);
  assert.deepEqual([jumped[1]!.event_id, jumped[1]!.merged_count], [at(240 * MIN).toISOString(), 3]);
  // Edited after the clock went back: still never behind what was dealt with.
  f.ledger.updateTrigger(trigger.id, { name: '新名字' }, USER, at(30 * MIN));
  f.ledger.fireDue(at(240 * MIN + 2000));
  assert.equal(fires(trigger.id).length, 2);
});

test('a periodic trigger holds one taken and one waiting: what comes while one waits merges into it', (t) => {
  const { f, every, fires, messages, pending } = setup(t);
  const trigger = every(10);
  f.ledger.fireDue(at(10 * MIN));
  f.ledger.fireDue(at(20 * MIN));
  assert.equal(messages().length, 1);
  const [first, second] = fires(trigger.id);
  assert.deepEqual([second!.outcome, second!.merged_into, second!.message_id], ['merged', first!.id, first!.message_id]);
  assert.equal(fires(trigger.id)[0]!.merged_count, 2);
  assert.match(messages()[0]!.text, /2 个时刻/, '合并后的消息说清并进了几次');

  // Taken: its input is fixed; the next moment starts a new waiting message.
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(taken.message.id, first!.message_id);
  const frozen = taken.message.text;
  f.ledger.fireDue(at(30 * MIN));
  f.ledger.fireDue(at(40 * MIN));
  assert.equal(f.ledger.getMessage(first!.message_id!).text, frozen, '取走之后不再改');
  assert.equal(messages().length, 2);
  assert.equal(pending().length, 1);
  assert.equal(fires(trigger.id).filter(({ outcome }) => outcome === 'merged').length, 2);

  // A new revision replaces the waiting message of the old one instead of merging into it.
  f.ledger.updateTrigger(trigger.id, { instruction: '新指令' }, USER, at(41 * MIN));
  f.ledger.fireDue(at(50 * MIN));
  const all = fires(trigger.id);
  const replaced = all.find(({ event_id }) => event_id === at(30 * MIN).toISOString())!;
  assert.equal(replaced.outcome, 'replaced');
  assert.equal(f.ledger.getMessage(replaced.message_id!).state, 'ignored');
  assert.equal(pending().length, 1);
  assert.match(pending()[0]!.text, /新指令/);
  assert.equal(all.at(-1)!.revision, 2);

  // An unverified one is not taken as never run, and does not hold a new one back.
  f.ledger.finishMessage(first!.message_id!, 'unverified');
  f.ledger.fireDue(at(60 * MIN));
  assert.equal(pending().length, 1);
  assert.equal(f.ledger.getMessage(first!.message_id!).state, 'unverified');
});

test('independent occurrences wait in a bounded queue of the project; a refusal counts and writes no record', (t) => {
  const { f, make, every, fires, messages } = setup(t, { queueMax: 2 });
  f.ledger.receiveMessage({ channel: 'console', externalId: 'owner-1', actor: 'user', text: '主人的话', projectId: f.projectId });
  const ones = [1, 2, 3].map((n) => make({ name: `一次-${n}`, schedule: { kind: 'once', at: at(5 * MIN).toISOString() } }));
  const periodic = every(5, { name: '周期' });
  f.ledger.fireDue(at(5 * MIN));
  assert.deepEqual(ones.map(({ id }) => fires(id).length), [1, 1, 0], '主人的消息不占位，满了就拒');
  assert.equal(fires(periodic.id).length, 1, '周期性的靠合并限住，不占队列');
  const refused = f.ledger.getTrigger(ones[2]!.id)!;
  assert.equal(refused.rejected?.count, 1);
  assert.equal(refused.rejected?.reason, 'queue_full');
  assert.equal(messages().length, 3);
  // The refused moment is not retried on every scan.
  f.ledger.fireDue(at(6 * MIN));
  assert.equal(f.ledger.getTrigger(ones[2]!.id)!.rejected?.count, 1);
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action LIKE 'trigger.reject%'`).length, 0, '拒收不写审计行，免得风暴写满账本');
});

test('the same identity and content answer with the original receipt; other content is a conflict; refused ones occupy nothing', (t) => {
  const { f, make, fires } = setup(t, { queueMax: 1, dedupeKeepMs: 60 * MIN });
  const trigger = make({ schedule: { kind: 'once', at: at(24 * 60 * MIN).toISOString() } });
  const other = make({ name: '占位', schedule: { kind: 'once', at: at(24 * 60 * MIN).toISOString() } });
  const send = (eventId: string, content: string, now: Date, triggerId = trigger.id) =>
    f.ledger.acceptTriggerEvent({ triggerId, source: 'schedule', eventId, content, data: { content } }, now);

  const first = send('e1', '甲', at(MIN));
  assert.equal(first.status, 'accepted');
  // The queue is full now; the same event is still answered as accepted, with the same receipt.
  const again = send('e1', '甲', at(2 * MIN));
  assert.deepEqual(again, { ...first, duplicate: true });
  assert.equal(fires(trigger.id).length, 1);
  const conflict = send('e1', '乙', at(3 * MIN));
  assert.deepEqual([conflict.status, conflict.status === 'refused' && conflict.reason], ['refused', 'conflict']);
  assert.equal(f.ledger.getTrigger(trigger.id)!.rejected?.count, 1);

  // Refused for a full queue: the identity stays free, and a retry once there is room is new.
  const full = send('e9', '丙', at(4 * MIN), other.id);
  assert.equal(full.status === 'refused' && full.reason, 'queue_full');
  f.ledger.takeNextTurn(f.projectId);
  assert.equal(send('e9', '丙', at(5 * MIN), other.id).status, 'accepted');

  // Kept from the first acceptance, not from a retry: past it the same identity is new.
  assert.equal((send('e1', '甲', at(60 * MIN)) as { duplicate?: boolean }).duplicate, true);
  f.ledger.finishMessage(f.ledger.listMessages({ limit: 100 }).find((row) => row.state === 'processing')!.id, 'processed');
  f.ledger.takeNextTurn(f.projectId);
  const later = send('e1', '甲', at(61 * MIN + 1000));
  assert.equal(later.status, 'accepted');
  assert.equal((later as { duplicate: boolean }).duplicate, false);
  assert.notEqual((later as { fire_id: string }).fire_id, (first as { fire_id: string }).fire_id);
  assert.equal(fires(trigger.id).length, 2);
});

test('rate and size limits apply before a model is woken, each refusal counted with its reason', (t) => {
  const { f, make } = setup(t, { perTriggerPerMinute: 2, perMinute: 3, dataLimitBytes: 64, queueMax: 100 });
  const a = make({ name: '甲', schedule: { kind: 'once', at: at(24 * 60 * MIN).toISOString() } });
  const b = make({ name: '乙', schedule: { kind: 'once', at: at(24 * 60 * MIN).toISOString() } });
  const send = (triggerId: string, eventId: string, data: Record<string, unknown> = {}) =>
    f.ledger.acceptTriggerEvent({ triggerId, source: 'schedule', eventId, content: eventId, data }, at(MIN));
  assert.equal(send(a.id, '1').status, 'accepted');
  assert.equal(send(a.id, '2').status, 'accepted');
  const third = send(a.id, '3');
  assert.equal(third.status === 'refused' && third.reason, 'rate_trigger');
  assert.equal(send(b.id, '1').status, 'accepted');
  const global = send(b.id, '2');
  assert.equal(global.status === 'refused' && global.reason, 'rate_global');
  const big = send(b.id, '3', { blob: 'x'.repeat(200) });
  assert.equal(big.status === 'refused' && big.reason, 'too_large');
  assert.equal(f.ledger.getTrigger(b.id)!.rejected?.count, 2);
  assert.equal(f.ledger.getTrigger(b.id)!.rejected?.reason, 'too_large');
  // A disabled trigger accepts nothing.
  f.ledger.setTriggerEnabled(a.id, false, USER, at(MIN));
  const off = f.ledger.acceptTriggerEvent({ triggerId: a.id, source: 'schedule', eventId: '9', content: '9', data: {} }, at(10 * MIN));
  assert.equal(off.status === 'refused' && off.reason, 'disabled');
  const wrong = f.ledger.acceptTriggerEvent({ triggerId: b.id, source: 'nonsense', eventId: '9', content: '9', data: {} }, at(10 * MIN));
  assert.equal(wrong.status === 'refused' && wrong.reason, 'source');
});

test('work a trigger turn starts carries where it came from, and an event carrying it sets off no trigger', (t) => {
  const { f, make, fires } = setup(t, { queueMax: 100 });
  const trigger = make({ schedule: { kind: 'once', at: at(5 * MIN).toISOString() } });
  f.ledger.fireDue(at(5 * MIN));
  const { message } = f.ledger.takeNextTurn(f.projectId)!;
  const fire = fires(trigger.id)[0]!;
  const turn = { actor: 'router', messageId: message.id };
  const task = f.ledger.createTask({ projectId: f.projectId, title: '例行检查', goal: '查', acceptance: '报', roleId: 'analyse' }, turn);
  assert.equal(task.trigger_fire_id, fire.id);
  const child = f.ledger.createTask({ projectId: f.projectId, parentId: task.id, title: '子', goal: '查', acceptance: '报', roleId: 'analyse' }, USER);
  assert.equal(child.trigger_fire_id, fire.id, '子任务沿父任务带下去');
  const owner = f.ledger.receiveMessage({ channel: 'console', externalId: 'o', actor: 'user', text: '主人', projectId: f.projectId });
  const mine = f.ledger.createTask({ projectId: f.projectId, title: '主人的', goal: '做', acceptance: '好', roleId: 'analyse' }, { actor: 'router', messageId: owner.id });
  assert.equal(mine.trigger_fire_id, null);

  const listener = make({ name: '听事件', schedule: { kind: 'once', at: at(24 * 60 * MIN).toISOString() } });
  const before = f.dump();
  const looped = f.ledger.acceptTriggerEvent({ triggerId: listener.id, source: 'schedule', eventId: 'x', content: 'x', data: {}, origin: child.trigger_fire_id }, at(6 * MIN));
  assert.deepEqual(looped, { status: 'skipped', reason: 'loop' });
  assert.deepEqual(f.dump().trigger_fire, before.trigger_fire);
  assert.equal(f.ledger.getTrigger(listener.id)!.rejected, null, '不是拒收，不计数');
});

test('a crash before the commit leaves no record, message or cursor move; after it, nothing is delivered twice', (t) => {
  let crash: 'before' | 'after' | undefined = 'before';
  const options: LedgerOptions = {
    testHooks: {
      beforeCommit(actions) { if (crash === 'before' && actions.includes('trigger.fire')) throw new Crash(); },
      afterCommit(actions) { if (crash === 'after' && actions.includes('trigger.fire')) { crash = undefined; throw new Crash(); } },
    },
  };
  const { f, every, fires, messages } = setup(t, {}, options);
  const trigger = every(10);
  assert.throws(() => f.ledger.fireDue(at(10 * MIN)));
  assert.deepEqual([fires(trigger.id).length, messages().length], [0, 0]);
  assert.equal(f.ledger.getTrigger(trigger.id)!.next_at, at(10 * MIN).toISOString(), '游标没动');
  crash = 'after';
  assert.throws(() => f.ledger.fireDue(at(10 * MIN + 1000)));
  assert.deepEqual([fires(trigger.id).length, messages().length], [1, 1]);
  f.ledger.fireDue(at(10 * MIN + 2000));
  assert.deepEqual([fires(trigger.id).length, messages().length], [1, 1]);
});

test('the shared scan fires due wakes as before, and the global pause stops neither', (t) => {
  const { f, every, fires } = setup(t);
  const task = f.queuedTask();
  f.ledger.scheduleWake(task.id, at(10 * MIN), USER);
  const trigger = every(10);
  f.ledger.setPause(true, USER);
  const due = f.ledger.fireDue(at(10 * MIN));
  assert.deepEqual(due.woken, [task.id]);
  assert.equal(f.ledger.getTask(task.id).state, 'queued');
  assert.equal(fires(trigger.id).length, 1);
  assert.equal(f.ledger.listTriggers(f.projectId).length, 1);
});

// ---- Review of step 1 ----

test('the grace period includes its end: a moment taken up exactly at it is on time', (t) => {
  const { f, make, fires } = setup(t);
  const edge = make({ schedule: { kind: 'once', at: at(MIN).toISOString() }, missed: 'skip' });
  f.ledger.fireDue(at(MIN + 2 * MIN));
  assert.deepEqual(fires(edge.id).map(({ outcome }) => outcome), ['delivered']);
});

test('a count of missed moments that reached its cap is said as a lower bound, in the record, the message and what is read back', (t) => {
  const { f, every, fires, messages } = setup(t);
  const trigger = every(1);
  f.ledger.fireDue(at(14 * 24 * 60 * MIN));
  const [fire] = fires(trigger.id);
  assert.equal(fire!.merged_count, 10_000);
  assert.equal(fire!.merged_capped, true);
  assert.match(messages()[0]!.text, /至少 10000 个时刻/);
  assert.equal((fire!.data as { moments_at_least?: boolean }).moments_at_least, true);
  const skip = setup(t);
  const skipped = skip.every(1, { missed: 'skip' });
  skip.f.ledger.fireDue(at(14 * 24 * 60 * MIN));
  assert.deepEqual(skip.fires(skipped.id).map(({ outcome, merged_capped }) => [outcome, merged_capped]), [['missed', true], ['delivered', false]], '最后一个时刻正在宽限期内，照投');
});

test('what is merged keeps every occurrence\'s lateness; each record\'s own data stays as it was accepted', (t) => {
  const { f, every, fires, messages } = setup(t);
  const trigger = every(10);
  f.ledger.fireDue(at(10 * MIN));
  // The 20-minute moment taken up at 25: past the grace period, delivered late.
  f.ledger.fireDue(at(25 * MIN));
  f.ledger.fireDue(at(30 * MIN));
  const all = fires(trigger.id);
  assert.deepEqual(all.map(({ outcome }) => outcome), ['delivered', 'merged', 'merged']);
  assert.match(messages()[0]!.text, /合并了 3 个时刻，是迟到补投的/);
  const shown = JSON.parse(messages()[0]!.text.split('\n').at(-1)!) as { late: boolean; missed: number; moments: number };
  assert.deepEqual([shown.moments, shown.late, shown.missed], [3, true, 1]);
  assert.deepEqual(all.map(({ data }) => (data as { late: boolean }).late), [false, true, false], '每条记录的原始数据不变');
});

test('work started from an internal event about a Task a trigger began carries that trigger, all the way along', (t) => {
  const { f, make, fires } = setup(t, { queueMax: 100 });
  const trigger = make({ schedule: { kind: 'once', at: at(5 * MIN).toISOString() } });
  f.ledger.fireDue(at(5 * MIN));
  const turn = f.ledger.takeNextTurn(f.projectId)!.message;
  const fire = fires(trigger.id)[0]!;
  const a = f.ledger.createTask({ projectId: f.projectId, title: 'A', goal: '做', acceptance: '好', roleId: 'implement' }, { actor: 'router', messageId: turn.id });
  f.ledger.finishMessage(turn.id, 'processed');
  assert.equal(a.trigger_fire_id, fire.id);
  f.ledger.queueTask(a.id, USER);
  const run = f.ledger.createRun(a.id, { ...f.login, snapshot: { timeout_ms: RUN_LIMIT_MS } }, USER);
  f.ledger.markRunRunning(run.id);
  f.ledger.settleRun(run.id, 0, DONE);
  // The settlement's internal message is the Router's next turn; what it starts is A's follow-up.
  const event = f.ledger.takeNextTurn(f.projectId)!.message;
  assert.equal(event.external_id, `run:${run.id}`);
  const b = f.ledger.createTask({ projectId: f.projectId, title: 'B', goal: '接着做', acceptance: '好', roleId: 'implement' }, { actor: 'router', messageId: event.id });
  assert.equal(b.trigger_fire_id, fire.id);
  // An internal event about a Task no trigger began passes on nothing.
  f.ledger.finishMessage(event.id, 'processed');
  const plain = f.newTask();
  f.ledger.queueTask(plain.id, USER);
  const plainRun = f.ledger.createRun(plain.id, f.login, USER);
  f.ledger.markRunRunning(plainRun.id);
  f.ledger.settleRun(plainRun.id, 0, DONE);
  const plainEvent = f.ledger.takeNextTurn(f.projectId)!.message;
  assert.equal(plainEvent.external_id, `run:${plainRun.id}`);
  const c = f.ledger.createTask({ projectId: f.projectId, title: 'C', goal: '做', acceptance: '好', roleId: 'implement' }, { actor: 'router', messageId: plainEvent.id });
  assert.equal(c.trigger_fire_id, null);
});

// A paused project runs none of its triggers (project-sessions §5): an occurrence is refused and
// counted, the cursor moves past it, nothing waits to flood the Router at the resume, and the
// refusals are no problem of the trigger's to push to the owner.
test('a paused project refuses its triggers without a message or a problem; the resume takes the next one', (t) => {
  const { f, every, messages } = setup(t, { queueMax: 1 });
  const trigger = every(10);
  f.ledger.setProjectPaused(f.projectId, true, USER);
  for (let n = 1; n <= 5; n += 1) f.ledger.fireDue(at(n * 10 * MIN));
  assert.equal(messages().length, 0, '暂停期间不投递');
  const shown = f.ledger.getTrigger(trigger.id)!;
  assert.equal(shown.rejected?.reason, 'project_paused');
  assert.equal(shown.problem, null, '项目暂停不是触发器的问题');
  assert.equal(f.peek(`SELECT 1 FROM push`).length, 0, '不推给主人');
  f.ledger.setProjectPaused(f.projectId, false, USER);
  f.ledger.fireDue(at(60 * MIN));
  assert.equal(messages().length, 1, '恢复以后照常，只有到点的那一次');
});

// An archived project is held back the same way, in its own words (project-sessions,
// "项目的生命周期"): refused and counted, the cursor moves on, nothing waits for the restore.
test('an archived project refuses its triggers by its own reason; the restore takes the next one', (t) => {
  const { f, every, messages } = setup(t, { queueMax: 1 });
  const trigger = every(10);
  f.ledger.setProjectArchived(f.projectId, true, USER);
  for (let n = 1; n <= 5; n += 1) f.ledger.fireDue(at(n * 10 * MIN));
  assert.equal(messages().length, 0, '归档期间不投递');
  const shown = f.ledger.getTrigger(trigger.id)!;
  assert.equal(shown.rejected?.reason, 'project_archived');
  assert.equal(shown.rejected?.text, '项目已归档，到点的不投递');
  assert.equal(shown.problem, null, '项目归档不是触发器的问题');
  assert.equal(f.peek(`SELECT 1 FROM push`).length, 0, '不推给主人');
  f.ledger.setProjectArchived(f.projectId, false, USER);
  f.ledger.fireDue(at(60 * MIN));
  assert.equal(messages().length, 1, '恢复以后照常，只有到点的那一次');
});
