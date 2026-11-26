// Guards "a trigger's or an inbound source's own problem waits for the owner" (docs/design/triggers.md
// §8) against: a source whose signatures keep failing, a project whose trigger queue stays full,
// or a rule the service cannot work out any more going unreported; one problem pushed more than
// once, or a failure here and there, broken by an acceptance, pushed as if it were one; a reminder
// going out for a problem that is gone — judged by anything but the ledger's facts, or judged
// differently when a reminder is queued and when it goes out; one broken rule holding the others
// back; a broken rule that cannot be listed, renamed or stopped; a full queue drained that leaves
// its problem in the ledger, to come back when another source fills the queue or to swallow the
// next run; and failures anyone can make, between good requests, pushing the owner again and again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createInbounds } from '../service/inbound.ts';
import { tychoSignature } from '../service/inbound/tycho-v1.ts';
import { createNotify } from '../service/notify.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { DEFAULT_PUSH_POLICY } from '../service/pushes.ts';
import { DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from '../service/triggers.ts';
import { TYCHO_V1_HEADERS } from '../shared/triggers.ts';
import { fixture, USER } from './helpers.ts';

const OWNER = 'zhang';
const T0 = new Date('2030-01-01T00:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const seconds = (date: Date): string => String(Math.floor(date.getTime() / 1000));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function setup(t: TestContext, tuned: Partial<TriggerPolicy> = {}) {
  const policy: TriggerPolicy = { ...DEFAULT_TRIGGER_POLICY, problemAfter: 3, ...tuned };
  const f = fixture(t, { triggerPolicy: () => policy, pushPolicy: () => ({ ...DEFAULT_PUSH_POLICY, remindMs: HOUR, remindMax: 2 }) });
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER, publicUrl: () => 'https://tycho.example', direct: async () => {} });
  const rows = (kind: string): OutboxRow[] => f.peek<OutboxRow>(`SELECT * FROM outbox WHERE channel = 'wecom' AND kind = ? ORDER BY rowid`, kind);
  const said = (row: OutboxRow): string | undefined => {
    const out = notify.render(row);
    return out && out.body.msgtype === 'markdown' ? out.body.markdown.content : undefined;
  };
  const inbounds = createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => policy.inboundSkewMs, log: () => {} });
  const source = f.ledger.createInboundSource({ name: 'CI', kind: 'tycho-v1', project_ids: [f.projectId] }, USER, T0);
  const { secret } = inbounds.issue(source.id, USER, T0);
  const deliver = (key: string, eventId: string, when: Date, sourceId = source.id) => {
    const signedAt = seconds(when);
    const body = Buffer.from('{}');
    const headers: Record<string, string> = {
      [TYCHO_V1_HEADERS.event]: eventId,
      [TYCHO_V1_HEADERS.time]: signedAt,
      [TYCHO_V1_HEADERS.signature]: tychoSignature(key, signedAt, eventId, '', body),
    };
    return inbounds.receive(sourceId, { header: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null, body }, when);
  };
  return { f, policy, rows, said, source, secret, deliver, inbounds };
}

test('signatures that keep failing are pushed once as waiting for the owner, reminded while they go on, and dropped once one verifies', (t) => {
  const { f, rows, said, source, secret, deliver } = setup(t);
  for (let n = 0; n < 2; n += 1) deliver('wrong', `bad-${n}`, at(n * 1000));
  assert.equal(rows('trigger_problem').length, 0, '两次还不算');
  assert.equal(f.ledger.getInboundSource(source.id)!.problem, null);
  for (let n = 2; n < 8; n += 1) deliver('wrong', `bad-${n}`, at(n * 1000));
  assert.equal(rows('trigger_problem').length, 1, '同一个问题只推一次');
  assert.match(said(rows('trigger_problem')[0]!)!, /入站来源“CI”出了问题：入站来源一直验不过签名/);
  assert.equal(f.ledger.getInboundSource(source.id)!.problem?.kind, 'signature');

  f.ledger.pushTick(at(2 * HOUR));
  assert.equal(rows('remind').length, 1);
  assert.match(said(rows('remind')[0]!)!, /再次提醒（1\/2）：入站来源“CI”的问题还在/);

  // One request that verifies ends it: what is queued says nothing, and nothing more is queued.
  assert.equal(deliver(secret, 'good', at(2 * HOUR + 1000))?.status, 'accepted');
  assert.equal(f.ledger.getInboundSource(source.id)!.problem, null);
  assert.equal(said(rows('remind')[0]!), undefined, '发出去之前再问一次账本');
  assert.equal(said(rows('trigger_problem')[0]!), undefined);
  f.ledger.pushTick(at(4 * HOUR));
  assert.equal(rows('remind').length, 1);
});

test('failures broken by an acceptance are not a problem; the same problem coming back later is a new one', (t) => {
  // No alert window: here it is the run that is counted (the window has a test of its own below).
  const { rows, secret, deliver } = setup(t, { problemAlertWindowMs: 0 });
  deliver('wrong', 'a', at(1000));
  deliver('wrong', 'b', at(2000));
  deliver(secret, 'ok', at(3000));
  deliver('wrong', 'c', at(4000));
  deliver('wrong', 'd', at(5000));
  assert.equal(rows('trigger_problem').length, 0);
  deliver('wrong', 'e', at(6000));
  assert.equal(rows('trigger_problem').length, 1);
  deliver(secret, 'ok2', at(7000));
  for (const id of ['f', 'g', 'h']) deliver('wrong', id, at(8000));
  assert.equal(rows('trigger_problem').length, 2, '好过之后又出的，是另一个问题');
});

test('a project trigger queue that stays full is a problem only while it is full', (t) => {
  const { f, rows, source, secret, deliver } = setup(t, { queueMax: 1, problemAfter: 2 });
  assert.equal(deliver(secret, 'first', at(1000))?.status, 'accepted');
  deliver(secret, 'second', at(2000));
  deliver(secret, 'third', at(3000));
  assert.equal(rows('trigger_problem').length, 1);
  const payload = JSON.parse(rows('trigger_problem')[0]!.payload_json) as Record<string, unknown>;
  assert.equal(payload.problem, 'queue_full');
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', payload), true);
  // The Router takes what waited: the queue is no longer full, though nothing new came.
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  f.ledger.finishMessage(taken.message.id, 'processed');
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', payload), false);
  assert.equal(f.ledger.getInboundSource(source.id)!.problem, null);
});

test('a stopped source has no problem to remind of, and started again counts afresh', (t) => {
  const { f, rows, source, deliver } = setup(t);
  for (const id of ['a', 'b', 'c']) deliver('wrong', id, at(1000));
  const payload = JSON.parse(rows('trigger_problem')[0]!.payload_json) as Record<string, unknown>;
  f.ledger.setInboundEnabled(source.id, false, USER, at(2000));
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', payload), false);
  f.ledger.setInboundEnabled(source.id, true, USER, at(3000));
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', payload), false, '重新启用后从头数');
});

test('a rule the service cannot work out becomes a problem scan after scan, and holds no other rule back', (t) => {
  const { f, rows, said } = setup(t, { problemAfter: 2 });
  const broken = f.ledger.createTrigger(f.projectId, { name: '早检', instruction: '看', schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' } }, USER, T0);
  const fine = f.ledger.createTrigger(f.projectId, { name: '一次', instruction: '看', schedule: { kind: 'once', at: at(MINUTE).toISOString() } }, USER, T0);
  // What an upgrade could leave: a zone this program no longer knows.
  f.force(`UPDATE trigger_rule SET params_json = ? WHERE id = ?`, JSON.stringify({ kind: 'cron', expr: '0 8 * * *', zone: 'Nowhere/Never' }), broken.id);
  assert.throws(() => f.ledger.fireDue(at(MINUTE)));
  assert.equal(f.ledger.listTriggerFires({ triggerId: fine.id, limit: 5 }).length, 1, '坏的那条不拦别的');
  assert.equal(rows('trigger_problem').length, 0);
  assert.throws(() => f.ledger.fireDue(at(2 * MINUTE)));
  assert.equal(rows('trigger_problem').length, 1);
  assert.match(said(rows('trigger_problem')[0]!)!, /触发器“早检”出了问题：规则失效了/);
  const payload = JSON.parse(rows('trigger_problem')[0]!.payload_json) as Record<string, unknown>;
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', payload), true);
  // Changed to a rule that can be worked out: no longer broken.
  f.ledger.updateTrigger(broken.id, { schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' } }, USER, at(3 * MINUTE));
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', payload), false);
  f.ledger.fireDue(at(4 * MINUTE));
});

// Review of step 3, B1: the problem was told, and the page that lists the rule, the edit and the
// stop all failed on the same rule they were there to deal with.
test('a rule that cannot be worked out is still listed, renamed and stopped, and says its next moment is unknown', (t) => {
  const { f } = setup(t, { problemAfter: 1 });
  const broken = f.ledger.createTrigger(f.projectId, { name: '早检', instruction: '看', schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Asia/Shanghai' } }, USER, T0);
  const other = f.ledger.createTrigger(f.projectId, { name: '另一条', instruction: '看', schedule: { kind: 'cron', expr: '0 9 * * *', zone: 'Asia/Shanghai' } }, USER, T0);
  f.force(`UPDATE trigger_rule SET params_json = ? WHERE id = ?`, JSON.stringify({ kind: 'cron', expr: '0 8 * * *', zone: 'Nowhere/Never' }), broken.id);
  assert.throws(() => f.ledger.fireDue(at(MINUTE)));
  const seen = f.ledger.getTrigger(broken.id)!;
  assert.deepEqual([seen.next_at, seen.next_local, seen.ended, seen.problem?.kind], [null, null, null, 'broken']);
  assert.match(seen.next_error!, /Nowhere\/Never/);
  assert.deepEqual(seen.schedule, { kind: 'cron', expr: '0 8 * * *', zone: 'Nowhere/Never' }, '定义照样给出');
  assert.deepEqual(f.ledger.listTriggers(f.projectId).map(({ name, next_error }) => [name, next_error === null]), [['早检', false], ['另一条', true]]);
  // Renamed with its rule sent back as it is, as the page does.
  const renamed = f.ledger.updateTrigger(broken.id, { name: '早检（坏了）', schedule: seen.schedule }, USER, at(2 * MINUTE));
  assert.deepEqual([renamed.name, renamed.revision], ['早检（坏了）', 2]);
  assert.throws(() => f.ledger.updateTrigger(broken.id, { schedule: { kind: 'cron', expr: '0 8 * * *', zone: 'Nowhere/Else' } }, USER), /时区/);
  const stopped = f.ledger.setTriggerEnabled(broken.id, false, USER, at(3 * MINUTE));
  assert.equal(stopped.enabled, false);
  assert.deepEqual(f.peek<{ enabled: number }>('SELECT enabled FROM trigger_rule WHERE id = ?', broken.id).map(({ enabled }) => enabled), [0], '停用提交了');
  assert.equal(f.ledger.setTriggerEnabled(other.id, false, USER, at(3 * MINUTE)).enabled, false, '同项目别的规则照常管理');
  f.ledger.fireDue(at(4 * MINUTE));
});

// Review of step 3, B2: the queue drained left the old problem in the ledger, so another source
// filling the queue brought it back, and a new run of refusals after its push was closed was
// never told.
test('a full queue drained ends the problem in the ledger: refilled by another source it does not come back, and a new run is told again', (t) => {
  const { f, rows, secret, deliver, source, inbounds } = setup(t, { queueMax: 1, problemAfter: 2 });
  const other = f.ledger.createInboundSource({ name: 'B', kind: 'tycho-v1', project_ids: [f.projectId] }, USER, T0);
  const otherKey = inbounds.issue(other.id, USER, T0).secret;
  const drain = () => {
    const taken = f.ledger.takeNextTurn(f.projectId)!;
    f.ledger.finishMessage(taken.message.id, 'processed');
  };
  assert.equal(deliver(secret, 'a1', at(1000))?.status, 'accepted');
  deliver(secret, 'a2', at(2000));
  deliver(secret, 'a3', at(3000));
  assert.equal(rows('trigger_problem').length, 1);
  const first = JSON.parse(rows('trigger_problem')[0]!.payload_json) as Record<string, unknown>;
  drain();
  assert.deepEqual({ ...f.peek<{ streak_count: number; problem_since: string | null }>('SELECT streak_count, problem_since FROM inbound_source WHERE id = ?', source.id)[0] }, { streak_count: 0, problem_since: null }, '在账本里结束');
  assert.equal(deliver(otherKey, 'b1', at(4000), other.id)?.status, 'accepted', 'B 把队列填满');
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', first), false, '旧问题不复活');
  assert.equal(f.ledger.getInboundSource(source.id)!.problem, null);
  f.ledger.pushTick(at(2 * HOUR));
  // A new run of refusals is a new problem, told again.
  deliver(secret, 'a4', at(2 * HOUR + 1000));
  assert.equal(rows('trigger_problem').length, 1, '一次还不算');
  deliver(secret, 'a5', at(2 * HOUR + 2000));
  assert.equal(rows('trigger_problem').length, 2);
  const second = JSON.parse(rows('trigger_problem')[1]!.payload_json) as Record<string, unknown>;
  assert.notEqual(second.since, first.since);
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', second), true);
});

// Review of step 3, B3: anyone who knows the address could have the owner pushed again and again
// by failing between the caller's own good requests.
test('signature failures between good requests are told once per source and window; the window\'s edge holds to the millisecond', (t) => {
  const { f, rows, secret, deliver, source } = setup(t, { problemAfter: 2, problemAlertWindowMs: HOUR });
  let n = 0;
  const round = (base: number) => {
    deliver('wrong', `bad-${n++}`, at(base));
    deliver('wrong', `bad-${n++}`, at(base + 1));
    assert.equal(deliver(secret, `good-${n++}`, at(base + 2))?.status, 'accepted');
  };
  // The first failing run is told at 2 ms; the window ends an hour after that.
  round(1);
  const told = JSON.parse(rows('trigger_problem')[0]!.payload_json) as { since: string };
  assert.equal(told.since, at(2).toISOString());
  for (let base = 10; base < 50; base += 10) round(base);
  assert.equal(rows('trigger_problem').length, 1, '时间窗内只推一次');
  assert.equal(f.ledger.getInboundSource(source.id)!.rejected!.count, 10, '拒收照常计数');
  // A later run within the window keeps the told one standing, and is shown on the page.
  deliver('wrong', 'later-1', at(60));
  deliver('wrong', 'later-2', at(61));
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', told), true);
  assert.equal(f.ledger.getInboundSource(source.id)!.problem?.kind, 'signature');
  deliver(secret, 'good-again', at(62));
  // Exactly at the window's end it is still inside; one millisecond after, it is outside.
  deliver('wrong', 'edge-1', at(2 + HOUR - 1));
  deliver('wrong', 'edge-2', at(2 + HOUR));
  assert.equal(rows('trigger_problem').length, 1, '正好在时间窗边上不推');
  deliver(secret, 'good-edge', at(2 + HOUR));
  deliver('wrong', 'out-1', at(2 + HOUR));
  deliver('wrong', 'out-2', at(2 + HOUR + 1));
  assert.equal(rows('trigger_problem').length, 2, '时间窗外 1 毫秒再推');
  assert.equal(f.ledger.pushStillWaiting('trigger_problem', told), false, '新推的那条接替旧的');
});
