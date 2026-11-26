// Guards "推送本回合终稿" (docs/design/triggers.md §8) against: the Router's final reply to a
// trigger's or an inbound source's message pushed when it did not ask for it, or not pushed when
// it did; the switch read as it is now rather than as it was when the occurrence was accepted; the
// push sent twice for one message, or written apart from the end of the turn; a turn that did not
// end as it should pushed as if it had, instead of saying plainly that it is not confirmed; a
// trigger's message taken for the owner's words — counted among the owner's open requests, or
// answered on WeCom as if he had written it there; and a source's push called a trigger's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createInbounds } from '../service/inbound.ts';
import { tychoSignature } from '../service/inbound/tycho-v1.ts';
import { createNotify } from '../service/notify.ts';
import type { OutboxRow } from '../service/outbox.ts';
import { TYCHO_V1_HEADERS } from '../shared/triggers.ts';
import { fixture, USER } from './helpers.ts';

const OWNER = 'zhang';
const T0 = new Date('2030-01-01T00:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

function setup(t: TestContext) {
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: [OWNER], console: ['console'] }, USER);
  const notify = createNotify({ ledger: f.ledger, owner: () => OWNER, publicUrl: () => 'https://tycho.example', direct: async () => {} });
  const rows = (): OutboxRow[] => f.peek<OutboxRow>(`SELECT * FROM outbox WHERE channel = 'wecom' ORDER BY rowid`);
  const texts = (): string[] => rows().flatMap((row) => {
    const out = notify.render(row);
    return out && out.body.msgtype === 'markdown' ? [out.body.markdown.content] : [];
  });
  // A trigger fires and its message is taken, as a Router's turn would take it.
  const fired = (push_final: boolean) => {
    const trigger = f.ledger.createTrigger(f.projectId, { name: '日报', instruction: '写日报', schedule: { kind: 'once', at: at(60_000).toISOString() }, push_final }, USER, T0);
    f.ledger.fireDue(at(60_000));
    const { message } = f.ledger.takeNextTurn(f.projectId)!;
    return { trigger, message };
  };
  // An inbound source fires and its message is taken, as a Router's turn would take it.
  const sourced = (push_final: boolean) => {
    const inbounds = createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => 60_000, log: () => {} });
    const source = f.ledger.createInboundSource({ name: 'CI', kind: 'tycho-v1', project_ids: [f.projectId], push_final }, USER, T0);
    const { secret } = inbounds.issue(source.id, USER, T0);
    const body = Buffer.from('{"status":"failed"}');
    const signedAt = String(Math.floor(at(1000).getTime() / 1000));
    const result = inbounds.receive(source.id, {
      header: (name) => ({
        [TYCHO_V1_HEADERS.event]: 'build-1',
        [TYCHO_V1_HEADERS.time]: signedAt,
        [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, signedAt, 'build-1', '', body),
      })[name] ?? null,
      body,
    }, at(1000));
    assert.equal(result?.status, 'accepted');
    return { source, message: f.ledger.takeNextTurn(f.projectId)!.message };
  };
  // How the Session Host ends a turn: the reply, the end and what is said of it, in one transaction.
  const finish = (message: ReturnType<typeof fired>['message'], text: string) => f.ledger.transaction(() => {
    const reply = f.ledger.writeOutbound({ channel: 'console', thread: message.thread, text, final: true, replyTo: message.id });
    f.ledger.finishMessage(message.id, 'processed');
    notify.finalReply(message, reply);
  });
  return { f, notify, rows, texts, fired, sourced, finish };
}

test('a trigger that asked for it has its turn\'s final reply pushed once, marked with its project', (t) => {
  const { fired, finish, rows, texts } = setup(t);
  const { message } = fired(true);
  finish(message, '今天的日报：一切正常');
  assert.equal(rows().length, 1);
  assert.match(texts()[0]!, /【试跑】/);
  assert.match(texts()[0]!, /日报/);
  assert.match(texts()[0]!, /今天的日报：一切正常/);
  assert.equal(JSON.parse(rows()[0]!.payload_json).external_id, `trigger-final:${message.id}`);
});

test('an inbound source that asked for it has its turn pushed once, and is named as a source', (t) => {
  const { sourced, finish, rows, texts } = setup(t);
  const { message } = sourced(true);
  finish(message, '构建失败了，已经派任务');
  assert.equal(rows().length, 1);
  assert.match(texts()[0]!, /入站来源“CI”这一次的结果/);
  assert.doesNotMatch(texts()[0]!, /触发器/);
  assert.match(texts()[0]!, /构建失败了，已经派任务/);
  assert.equal(JSON.parse(rows()[0]!.payload_json).external_id, `trigger-final:${message.id}`);
});

test('without the switch nothing is pushed, and the switch is the one frozen at acceptance', (t) => {
  const { f, fired, finish, rows } = setup(t);
  const { trigger, message } = fired(false);
  f.ledger.updateTrigger(trigger.id, { push_final: true }, USER, at(90_000));
  finish(message, '日报');
  assert.equal(rows().length, 0, '受理时没开，后来开了也不推这一条');
});

test('a turn that did not end as it should is said to be unconfirmed, not pushed as done', (t) => {
  const { f, notify, fired, texts, rows } = setup(t);
  const { message } = fired(true);
  f.ledger.transaction(() => {
    f.ledger.finishMessage(message.id, 'unverified');
    notify.unverified(f.ledger.getMessage(message.id));
  });
  assert.equal(rows().length, 1);
  assert.match(texts()[0]!, /未确认完成/);
});

test('a trigger\'s message is not the owner\'s words: not among his open requests, and its reply stays off WeCom', (t) => {
  const { f, fired, finish, rows } = setup(t);
  const { message } = fired(false);
  finish(message, '好的');
  assert.deepEqual(f.ledger.openRequests(f.projectId, { limit: 10 }), []);
  assert.equal(rows().length, 0);
});
