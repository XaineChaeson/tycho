// Guards an inbound source (docs/design/triggers.md §2.2, §4) against: a request taken without a
// signature made by one of the source's keys in force now, or with one that is not over exactly
// the version, the signing time, the event id, the project id and the raw body's bytes; a project
// header changed on the way taken; a signing time too old or too far ahead taken, or one at the
// edge of the allowance refused; an event with no project of the source's list accepted; a source
// whose key was never issued or that was deleted reachable from outside; a replaced key that stops
// at once, verifies past its transition, or has its end moved by a restart or a later change of
// the setting; a secret in the ledger; key files left behind once nothing verifies with them; and
// GitHub's repository routing by any of its written forms, its ping acknowledged and uncounted, or
// its delivery id not holding off a replay.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHmac } from 'node:crypto';
import { DEFAULT_TRIGGER_POLICY, type TriggerPolicy } from '../service/triggers.ts';
import { createInbounds, inboundSecretDir } from '../service/inbound.ts';
import { tychoSignature } from '../service/inbound/tycho-v1.ts';
import { ACTION_TEXT } from '../shared/labels.ts';
import { TYCHO_V1_HEADERS } from '../shared/triggers.ts';
import { fixture, USER } from './helpers.ts';

const T0 = new Date('2030-01-01T00:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const seconds = (date: Date): string => String(Math.floor(date.getTime() / 1000));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Headers = Record<string, string>;

function setup(t: TestContext, tuned: Partial<TriggerPolicy> = {}) {
  const policy: TriggerPolicy = { ...DEFAULT_TRIGGER_POLICY, ...tuned };
  const f = fixture(t, { triggerPolicy: () => policy });
  const inbounds = createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => policy.inboundSkewMs, log: () => {} });
  const source = f.ledger.createInboundSource({ name: 'CI', kind: 'tycho-v1', project_ids: [f.projectId], note: '看看 {{event_id}} 这次失败' }, USER, T0);
  const receive = (headers: Headers, body: string | Uint8Array, now: Date, sourceId = source.id) => {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    return inbounds.receive(sourceId, {
      header: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null,
      body: bytes,
    }, now);
  };
  // A caller sending the three headers and, when given, the project one, signed with `secret`.
  const send = (
    secret: string,
    eventId: string | null,
    body: string | Uint8Array,
    when: Date,
    now: Date = when,
    options: { project?: string; signature?: string | null; sourceId?: string; omitDelivery?: boolean } = {},
  ) => {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    const signedAt = seconds(when);
    const project = options.project ?? '';
    const signature = options.signature !== undefined ? options.signature : tychoSignature(secret, signedAt, eventId ?? '', project, bytes);
    const headers: Headers = {
      [TYCHO_V1_HEADERS.time]: signedAt,
      ...(options.omitDelivery ? {} : { [TYCHO_V1_HEADERS.event]: eventId ?? '' }),
      ...(signature === null ? {} : { [TYCHO_V1_HEADERS.signature]: signature }),
      ...(options.project === undefined ? {} : { [TYCHO_V1_HEADERS.project]: options.project }),
    };
    return receive(headers, bytes, now, options.sourceId ?? source.id);
  };
  const fires = (sourceId = source.id) => f.ledger.listTriggerFires({ sourceId, limit: 100 });
  const rejected = () => f.ledger.getInboundSource(source.id)!.rejected;
  return { f, policy, inbounds, source, send, receive, fires, rejected };
}

// The first receipt of a request that reached one project.
const one = (result: ReturnType<ReturnType<typeof setup>['send']>) => {
  assert.equal(result?.status, 'accepted');
  const first = result.status === 'accepted' ? result.receipts[0] : undefined;
  assert.ok(first);
  return first;
};

test('a request signed with the key in force is accepted once; the message says what came and from where', (t) => {
  const { f, inbounds, source, send, fires } = setup(t);
  const { secret } = inbounds.issue(source.id, USER, T0);
  const receipt = one(send(secret, 'build-41', '{"status":"failed","branch":"main"}', at(1000)));
  assert.equal(receipt.status === 'accepted' && receipt.outcome, 'delivered');
  assert.equal(fires().length, 1);
  const { message } = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(message.channel, 'trigger');
  assert.match(message.text, /^入站来源“CI”：收到 tycho-v1/);
  assert.match(message.text, /事件 build-41/);
  assert.match(message.text, /看看 \{\{event_id\}\} 这次失败/, '来源说明原样放进消息');
  assert.match(message.text, /"branch":"main"/, '正文作为附带资料');
  assert.match(message.text, /不是主人说的话/);
  assert.equal(fires()[0]!.revision, null, '来源的次数不冻结修订');
});

test('a signature made any other way is refused and counted, and leaves no record', (t) => {
  const { inbounds, source, send, receive, fires, rejected } = setup(t);
  const { secret } = inbounds.issue(source.id, USER, T0);
  const now = at(1000);
  const body = Buffer.from('{"a":1}');
  const signedAt = seconds(now);
  const wrong = [
    send('not-the-key', 'e1', body, now),
    // Signed over a body other than the bytes that came.
    receive({ [TYCHO_V1_HEADERS.event]: 'e1', [TYCHO_V1_HEADERS.time]: signedAt, [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, signedAt, 'e1', '', Buffer.from('{"a": 1}')) }, body, now),
    // Signed for another event id, or another signing time, than the headers say.
    receive({ [TYCHO_V1_HEADERS.event]: 'e1', [TYCHO_V1_HEADERS.time]: signedAt, [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, signedAt, 'e2', '', body) }, body, now),
    receive({ [TYCHO_V1_HEADERS.event]: 'e1', [TYCHO_V1_HEADERS.time]: signedAt, [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, seconds(at(2000)), 'e1', '', body) }, body, now),
    // The project header is signed with the rest: one changed on the way fails.
    receive({ [TYCHO_V1_HEADERS.event]: 'e1', [TYCHO_V1_HEADERS.time]: signedAt, [TYCHO_V1_HEADERS.project]: 'p-other', [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, signedAt, 'e1', '', body) }, body, now),
    // Upper-case hex is not the signature the protocol says.
    send(secret, 'e1', body, now, now, { signature: tychoSignature(secret, seconds(now), 'e1', '', body).toUpperCase() }),
    // Signed without the project a request does name.
    receive({ [TYCHO_V1_HEADERS.event]: 'e1', [TYCHO_V1_HEADERS.time]: signedAt, [TYCHO_V1_HEADERS.project]: 'p1', [TYCHO_V1_HEADERS.signature]: tychoSignature(secret, signedAt, 'e1', '', body) }, body, now),
  ];
  for (const result of wrong) assert.deepEqual(result && result.status === 'refused' ? result.reason : result, 'signature');
  assert.equal(fires().length, 0);
  assert.equal(rejected()!.count, wrong.length);
  assert.equal(one(send(secret, 'e1', body, now)).status, 'accepted', '拒收没有占用这个事件编号');
});

test('without an event id, a signing time or a signature it is refused before anything else', (t) => {
  const { inbounds, source, send, receive, fires } = setup(t);
  const { secret } = inbounds.issue(source.id, USER, T0);
  const now = at(1000);
  const refusals = [
    send(secret, null, 'x', now),
    send(secret, 'e1', 'x', now, now, { signature: null }),
    receive({ [TYCHO_V1_HEADERS.event]: 'e1', [TYCHO_V1_HEADERS.signature]: 'a'.repeat(64) }, Buffer.from('x'), now),
    send(secret, 'has space', 'x', now),
    send(secret, 'e1', 'x', now, now, { omitDelivery: true }),
  ];
  for (const result of refusals) assert.equal(result?.status === 'refused' && result.reason, 'unsigned');
  assert.equal(fires().length, 0);
});

test('a signing time too old or too far ahead is refused; at the edge of the allowance it is taken', (t) => {
  const { inbounds, source, send, fires, policy } = setup(t, { inboundSkewMs: 5 * MINUTE });
  const { secret } = inbounds.issue(source.id, USER, T0);
  const now = at(HOUR);
  const old = send(secret, 'old', 'x', at(HOUR - 5 * MINUTE - 1000), now);
  const ahead = send(secret, 'ahead', 'x', at(HOUR + 5 * MINUTE + 1000), now);
  assert.deepEqual([old, ahead].map((result) => result?.status === 'refused' && result.reason), ['stale', 'stale']);
  assert.equal(one(send(secret, 'edge-old', 'x', at(HOUR - policy.inboundSkewMs), now)).status, 'accepted');
  assert.equal(one(send(secret, 'edge-ahead', 'x', at(HOUR + policy.inboundSkewMs), now)).status, 'accepted');
  assert.deepEqual(fires().map(({ event_id }) => event_id).sort(), ['edge-ahead', 'edge-old']);
});

test('one millisecond outside the allowance, either way, is refused', (t) => {
  const { inbounds, source, send, fires } = setup(t, { inboundSkewMs: 5 * MINUTE });
  const { secret } = inbounds.issue(source.id, USER, T0);
  const signedAt = seconds(at(HOUR));
  const body = Buffer.from('x');
  const at_ = (id: string, now: Date) => send(secret, id, body, at(HOUR), now);
  const reason = (result: ReturnType<typeof at_>) => (result?.status === 'refused' ? result.reason : result?.status);
  assert.equal(reason(at_('late', at(HOUR + 5 * MINUTE + 1))), 'stale');
  assert.equal(reason(at_('early', at(HOUR - 5 * MINUTE - 1))), 'stale');
  assert.equal(reason(at_('late-edge', at(HOUR + 5 * MINUTE))), 'accepted');
  assert.equal(reason(at_('early-edge', at(HOUR - 5 * MINUTE))), 'accepted');
  assert.equal(fires().length, 2);
});

test('the named project must be one the source lets through; with one project and no name, that one gets it', (t) => {
  const { f, inbounds, source, send, fires } = setup(t);
  const { secret } = inbounds.issue(source.id, USER, T0);
  const other = f.ledger.createProject({ name: '乙', loginMode: 'all' }, USER);
  f.ledger.updateInboundSource(source.id, { project_ids: [f.projectId, other] }, USER, T0);
  assert.equal(one(send(secret, 'named', '{}', at(1000), at(1000), { project: other })).status, 'accepted');
  assert.equal(fires().length, 1);
  const unknown = send(secret, 'elsewhere', '{}', at(2000), at(2000), { project: 'not-a-project' });
  assert.equal(unknown?.status === 'refused' && unknown.reason, 'no_project');
  const ambiguous = send(secret, 'nobody', '{}', at(3000));
  assert.equal(ambiguous?.status === 'refused' && ambiguous.reason, 'no_project');
  assert.equal(fires().length, 1);
  // Back to one project: a request that names none is that project's.
  f.ledger.updateInboundSource(source.id, { project_ids: [f.projectId] }, USER, at(4000));
  assert.equal(one(send(secret, 'only-one', '{}', at(5000))).status, 'accepted');
  assert.equal(fires()[0]!.project_id, f.projectId);
});

test('a key whose file cannot be written is not issued; one the ledger refuses leaves no file', (t) => {
  const { f, inbounds, source } = setup(t);
  const dir = inboundSecretDir(f.dir);
  // Where the key files go is taken by a file: nothing can be written under it.
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(dir, 'not a directory');
  assert.throws(() => inbounds.issue(source.id, USER, T0), /没有存下来|ENOTDIR|EEXIST/);
  assert.equal(f.peek('SELECT 1 FROM inbound_key').length, 0, '账本里没有这把密钥');
  assert.equal(f.ledger.inboundTarget(source.id, T0), undefined, '外面照样投不进来');
  rmSync(dir);
  // The ledger refuses: no such source. The file written first goes again.
  const scheduled = f.ledger.createTrigger(f.projectId, { name: '定时', instruction: '看', schedule: { kind: 'once', at: at(HOUR).toISOString() } }, USER, T0);
  assert.throws(() => inbounds.issue(scheduled.id, USER, T0), /不存在/);
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
  const { key_id: keyId } = inbounds.issue(source.id, USER, T0);
  assert.deepEqual(readdirSync(dir), [keyId]);
});

test('every change an inbound source leaves behind has words the owner can read', (t) => {
  const { f, inbounds, source } = setup(t);
  f.ledger.updateInboundSource(source.id, { name: 'CI 改名' }, USER, T0);
  f.ledger.setInboundEnabled(source.id, false, USER, T0);
  inbounds.issue(source.id, USER, T0);
  f.ledger.deleteInboundSource(source.id, USER, T0);
  const actions = (f.peek<{ action: string }>(`SELECT DISTINCT action FROM change WHERE action LIKE 'inbound.%' ORDER BY action`) as { action: string }[]).map(({ action }) => action);
  assert.deepEqual(actions, ['inbound.create', 'inbound.delete', 'inbound.disable', 'inbound.key', 'inbound.update']);
  for (const action of actions) assert.ok(ACTION_TEXT[action], action);
});

test('the same event signed again later is the same event; the same id with another body is a conflict', (t) => {
  const { f, inbounds, source, send, fires } = setup(t);
  const { secret } = inbounds.issue(source.id, USER, T0);
  const first = one(send(secret, 'deploy-7', '{"v":1}', at(1000)));
  const again = one(send(secret, 'deploy-7', '{"v":1}', at(90_000)));
  assert.equal(first.status === 'accepted' && again.status === 'accepted' && again.fire_id, first.status === 'accepted' && first.fire_id);
  assert.equal(again.status === 'accepted' && again.duplicate, true);
  assert.equal(fires().length, 1);
  assert.equal(f.peek(`SELECT 1 FROM message WHERE channel = 'trigger'`).length, 1, '重签重试不再投一次');
  const other = send(secret, 'deploy-7', '{"v":2}', at(100_000));
  assert.equal(other?.status === 'refused' && other.reason, 'conflict');
  // Bodies are compared as bytes, not as what they decode to.
  const spaced = send(secret, 'deploy-7', '{"v": 1}', at(110_000));
  assert.equal(spaced?.status === 'refused' && spaced.reason, 'conflict');
  assert.equal(fires().length, 1);
  // Two projects are two independent acceptances of the same event id.
  const two = f.ledger.createProject({ name: '乙', loginMode: 'all' }, USER);
  f.ledger.updateInboundSource(source.id, { project_ids: [f.projectId, two] }, USER, at(120_000));
  assert.equal(one(send(secret, 'same-id', '{}', at(130_000), at(130_000), { project: two })).status, 'accepted');
  assert.equal(one(send(secret, 'same-id', '{}', at(130_000), at(130_000), { project: f.projectId })).status, 'accepted');
  assert.equal(fires().length, 3);
});

test('a project whose trigger queue is full refuses an event, and the event can be retried later', (t) => {
  const { f, inbounds, source, send } = setup(t, { queueMax: 1 });
  const { secret } = inbounds.issue(source.id, USER, T0);
  assert.equal(one(send(secret, 'a', 'x', at(1000))).status, 'accepted');
  const full = send(secret, 'b', 'x', at(2000));
  assert.equal(full?.status === 'refused' && full.reason, 'queue_full');
  const taken = f.ledger.takeNextTurn(f.projectId)!;
  f.ledger.finishMessage(taken.message.id, 'processed');
  assert.equal(one(send(secret, 'b', 'x', at(3000))).status, 'accepted', '队满没有占用这个事件编号');
});

test('a source whose key was never issued, or that is deleted, is reached by nothing', (t) => {
  const { f, inbounds, source, send } = setup(t);
  assert.equal(send('anything', 'e', 'x', at(1000)), undefined);
  assert.equal(f.ledger.getInboundSource(source.id)!.ready, false);
  const { secret } = inbounds.issue(source.id, USER, T0);
  assert.equal(f.ledger.getInboundSource(source.id)!.ready, true);
  assert.equal(send(secret, 'e', 'x', at(1000), at(1000), { sourceId: 'X'.repeat(26) }), undefined);
  f.ledger.deleteInboundSource(source.id, USER, at(2000));
  assert.equal(send(secret, 'e2', 'x', at(3000)), undefined);
  assert.throws(() => inbounds.issue(source.id, USER, at(4000)), /不存在/);
});

test('a disabled source still checks the signature, and then refuses', (t) => {
  const { f, inbounds, source, send, fires } = setup(t);
  const { secret } = inbounds.issue(source.id, USER, T0);
  f.ledger.setInboundEnabled(source.id, false, USER, T0);
  const wrong = send('wrong', 'e', 'x', at(1000));
  assert.equal(wrong?.status === 'refused' && wrong.reason, 'signature');
  const result = send(secret, 'e', 'x', at(1000));
  assert.equal(result?.status === 'refused' && result.reason, 'disabled');
  assert.match(f.ledger.getInboundSource(source.id)!.rejected!.text, /来源/, '拒绝的话说的是来源，不是触发器');
  assert.equal(fires().length, 0);
});

test('a replaced key verifies through its transition and not after, and a restart or a later setting does not move that', (t) => {
  const policy = { ...DEFAULT_TRIGGER_POLICY, inboundRotateMs: HOUR };
  const { f, inbounds, source, send } = setup(t, policy);
  const first = inbounds.issue(source.id, USER, T0);
  const second = inbounds.issue(source.id, USER, at(10 * MINUTE));
  assert.notEqual(first.secret, second.secret);
  const keys = f.peek<{ id: string; retires_at: string | null }>('SELECT id, retires_at FROM inbound_key ORDER BY rowid');
  assert.deepEqual(keys.map(({ id, retires_at }) => [id, retires_at]), [[first.key_id, at(70 * MINUTE).toISOString()], [second.key_id, null]]);
  assert.equal(one(send(first.secret, 'old-in-time', 'x', at(69 * MINUTE))).status, 'accepted');
  assert.equal(one(send(second.secret, 'new', 'x', at(69 * MINUTE))).status, 'accepted');

  // Opened again with a longer transition, as a restarted service with the setting changed.
  const reopened = f.open({ triggerPolicy: () => ({ ...policy, inboundRotateMs: 30 * 24 * HOUR }) });
  const after = createInbounds({ ledger: reopened, dataDir: f.dir, skewMs: () => policy.inboundSkewMs, log: () => {} });
  const late = (secret: string, id: string) => after.receive(source.id, {
    header: (name) => ({
      [TYCHO_V1_HEADERS.event.toLowerCase()]: id,
      [TYCHO_V1_HEADERS.time.toLowerCase()]: seconds(at(70 * MINUTE)),
      [TYCHO_V1_HEADERS.signature.toLowerCase()]: tychoSignature(secret, seconds(at(70 * MINUTE)), id, '', Buffer.from('x')),
    })[name.toLowerCase()] ?? null,
    body: Buffer.from('x'),
  }, at(70 * MINUTE));
  const old = late(first.secret, 'old-too-late');
  assert.equal(old?.status === 'refused' && old.reason, 'signature');
  assert.equal(one(late(second.secret, 'new-later')).status, 'accepted');
});

test('rotating twice keeps the first replaced key on its own end; a transition of zero ends it at once', (t) => {
  let rotate = HOUR;
  const f = fixture(t, { triggerPolicy: () => ({ ...DEFAULT_TRIGGER_POLICY, inboundRotateMs: rotate }) });
  const inbounds = createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => DEFAULT_TRIGGER_POLICY.inboundSkewMs, log: () => {} });
  const source = f.ledger.createInboundSource({ name: 'CI', kind: 'tycho-v1', project_ids: [f.projectId] }, USER, T0);
  const a = inbounds.issue(source.id, USER, T0);
  const b = inbounds.issue(source.id, USER, at(MINUTE));
  rotate = 0;
  const c = inbounds.issue(source.id, USER, at(2 * MINUTE));
  const keys = f.peek<{ id: string; retires_at: string | null }>('SELECT id, retires_at FROM inbound_key ORDER BY rowid');
  // b ended the moment c was issued; a keeps the end it was given.
  assert.deepEqual(keys.map(({ id, retires_at }) => [id, retires_at]), [[a.key_id, at(61 * MINUTE).toISOString()], [b.key_id, at(2 * MINUTE).toISOString()], [c.key_id, null]]);
  assert.deepEqual(f.ledger.inboundTarget(source.id, at(2 * MINUTE))!.keyIds, [a.key_id, c.key_id]);
});

test('no secret is in the ledger; key files go once nothing verifies with them, or nothing ever named them', (t) => {
  const { f, inbounds, source } = setup(t, { inboundRotateMs: HOUR });
  const first = inbounds.issue(source.id, USER, T0);
  const second = inbounds.issue(source.id, USER, at(MINUTE));
  const dir = inboundSecretDir(f.dir);
  assert.equal(readFileSync(join(dir, second.key_id), 'utf8').trim(), second.secret);
  f.ledger.close();
  const ledgerBytes = readFileSync(f.path).toString('latin1') + (existsSync(`${f.path}-wal`) ? readFileSync(`${f.path}-wal`).toString('latin1') : '');
  for (const secret of [first.secret, second.secret]) assert.ok(!ledgerBytes.includes(secret), '账本里没有密钥');
  const ledger = f.open();
  const later = createInbounds({ ledger, dataDir: f.dir, skewMs: () => DEFAULT_TRIGGER_POLICY.inboundSkewMs, log: () => {} });
  // A file whose issue never committed: nothing names it.
  writeFileSync(join(dir, '0'.repeat(26)), 'orphan\n');
  later.tidy(at(30 * MINUTE));
  assert.deepEqual(readdirSync(dir).sort(), [first.key_id, second.key_id].sort());
  later.tidy(at(2 * HOUR));
  assert.deepEqual(readdirSync(dir), [second.key_id]);
  ledger.deleteInboundSource(source.id, USER, at(3 * HOUR));
  later.tidy(at(3 * HOUR));
  assert.deepEqual(readdirSync(dir), []);
});

// ---- GitHub ----

function github(t: TestContext, repos: { id: string; repo: string | null }[]) {
  const f = fixture(t, { triggerPolicy: () => DEFAULT_TRIGGER_POLICY });
  const projects = repos.map(({ id, repo }, index) => {
    const project = id === f.projectId ? f.projectId : f.ledger.createProject({ name: id, loginMode: 'all' }, USER);
    if (repo !== null) {
      f.force('UPDATE project SET sources_json = ? WHERE id = ?', JSON.stringify([{ id: `src-${index}`, kind: 'repo', url: repo }]), project);
    }
    return { id: project, repo };
  });
  const inbounds = createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => DEFAULT_TRIGGER_POLICY.inboundSkewMs, log: () => {} });
  const source = f.ledger.createInboundSource({ name: 'GitHub', kind: 'github', project_ids: projects.map(({ id }) => id) }, USER, T0);
  const { secret } = inbounds.issue(source.id, USER, T0);
  const deliver = (payload: Record<string, unknown>, options: { event?: string; delivery?: string; secret?: string; signature?: string | null; now?: Date } = {}) => {
    const body = Buffer.from(JSON.stringify(payload));
    const event = options.event ?? 'push';
    const delivery = options.delivery ?? 'd-1';
    const key = options.secret ?? secret;
    const signature = options.signature !== undefined ? options.signature : `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
    const headers: Headers = { 'x-github-event': event, 'x-github-delivery': delivery, ...(signature === null ? {} : { 'x-hub-signature-256': signature }) };
    return inbounds.receive(source.id, { header: (name) => headers[name.toLowerCase()] ?? null, body }, options.now ?? at(1000));
  };
  const fires = () => f.ledger.listTriggerFires({ sourceId: source.id, limit: 100 });
  return { f, inbounds, source, secret, deliver, fires, projects };
}

const repository = (fullName: string): Record<string, unknown> => ({ repository: { full_name: fullName } });

test('GitHub events are routed by the repository, in any of its written forms and in any case', (t) => {
  const { f, deliver, fires, projects } = github(t, [
    { id: 'one', repo: 'https://github.com/Owner/Repo.git' },
    { id: 'two', repo: 'git@github.com:owner/repo' },
    // A clone URL with a trailing slash after `.git` is the same repository.
    { id: 'three', repo: 'ssh://git@github.com/Owner/Repo.git/' },
  ]);
  const result = deliver(repository('Owner/Repo'), { delivery: 'd-9' });
  assert.equal(result?.status, 'accepted');
  const receipts = result?.status === 'accepted' ? result.receipts : [];
  assert.deepEqual(receipts.map((receipt) => receipt.status === 'accepted' && receipt.message_id !== null), [true, true, true]);
  assert.deepEqual(fires().map(({ project_id }) => project_id).sort(), projects.map(({ id }) => id).sort());
  const { message } = f.ledger.takeNextTurn(projects[0]!.id)!;
  assert.match(message.text, /^入站来源“GitHub”：收到 GitHub 事件 d-9/);
  assert.match(message.text, /"repository":"owner\/repo"/);
});

test('GitHub events for no project of the source are refused; a ping is acknowledged and not counted', (t) => {
  const { f, deliver, fires, source } = github(t, [{ id: 'one', repo: 'owner/one' }]);
  const elsewhere = deliver(repository('owner/elsewhere'));
  assert.equal(elsewhere?.status === 'refused' && elsewhere.reason, 'no_project');
  assert.equal(f.ledger.getInboundSource(source.id)!.rejected!.count, 1);
  const ping = deliver({ zen: 'Keep it logically awesome.', hook_id: 1 }, { event: 'ping' });
  assert.equal(ping?.status, 'ping');
  assert.equal(fires().length, 0);
  assert.equal(f.ledger.getInboundSource(source.id)!.rejected!.count, 1, 'ping 不计数');
});

test('GitHub routing rejects malformed repository names and nested or foreign remotes', (t) => {
  const { deliver, fires } = github(t, [
    { id: 'valid', repo: 'ssh://git@github.com/Owner/Repo.git' },
    { id: 'nested', repo: 'https://github.com/git@github.com:owner/other.git' },
    { id: 'foreign', repo: 'https://git.example/owner/foreign.git' },
  ]);
  for (const [index, name] of [
    'https://github.com/owner/repo',
    'git@github.com:owner/repo',
    'https://github.com/git@github.com:owner/other',
    'https://git.example/owner/foreign',
    'owner/repo/extra',
    'owner/repo?query',
    'owner/../repo',
    'owner/other',
  ].entries()) {
    const result = deliver(repository(name), { delivery: `invalid-${index}` });
    assert.equal(result?.status === 'refused' && result.reason, 'no_project', name);
  }
  assert.equal(fires().length, 0);
  assert.equal(deliver(repository('OWNER/REPO'))?.status, 'accepted');
  assert.equal(fires().length, 1);
});

test('GitHub clone URLs ending in a slash still route to their repository', (t) => {
  const { deliver, fires } = github(t, [
    { id: 'https', repo: 'https://github.com/Owner/Repo.git/' },
    { id: 'ssh', repo: 'ssh://git@github.com/owner/repo.git/' },
  ]);
  assert.equal(deliver(repository('owner/repo'))?.status, 'accepted');
  assert.equal(fires().length, 2);
});

test('GitHub requests without their signature, or with one no key makes, are refused', (t) => {
  const { deliver, fires, source, f } = github(t, [{ id: 'one', repo: 'owner/one' }]);
  assert.equal((deliver(repository('owner/one'), { signature: null }) as { reason?: string }).reason, 'unsigned');
  assert.equal((deliver(repository('owner/one'), { signature: 'sha256=' + 'f'.repeat(64) }) as { reason?: string }).reason, 'signature');
  assert.equal((deliver(repository('owner/one'), { secret: 'not-the-key' }) as { reason?: string }).reason, 'signature');
  assert.equal(fires().length, 0);
  assert.equal(f.ledger.getInboundSource(source.id)!.rejected!.count, 3);
});

test('a GitHub delivery id is the event: the same one again is no new acceptance, another body is a conflict', (t) => {
  const { deliver, fires } = github(t, [{ id: 'one', repo: 'owner/one' }]);
  assert.equal(deliver(repository('owner/one'), { delivery: 'same' })?.status, 'accepted');
  const again = deliver(repository('owner/one'), { delivery: 'same' });
  assert.equal(again?.status === 'accepted' && again.receipts[0]!.status === 'accepted' && again.receipts[0]!.duplicate, true);
  assert.equal(fires().length, 1);
  const conflict = deliver({ ...repository('owner/one'), after: 'x' }, { delivery: 'same' });
  assert.equal(conflict?.status === 'refused' && conflict.reason, 'conflict');
});

test('changing unsigned GitHub headers cannot replay an accepted signed body', (t) => {
  const { deliver, fires, secret, f, projects } = github(t, [{ id: 'one', repo: 'owner/one' }]);
  const payload = repository('owner/one');
  const signature = `sha256=${createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')}`;
  const first = one(deliver(payload, { delivery: 'original', signature }));
  const replay = one(deliver(payload, { delivery: 'changed', event: 'issues', signature }));
  assert.equal(replay.status === 'accepted' && replay.duplicate, true);
  assert.equal(replay.status === 'accepted' && replay.fire_id, first.status === 'accepted' && first.fire_id);
  assert.equal(fires().length, 1);
  const { message } = f.ledger.takeNextTurn(projects[0]!.id)!;
  assert.match(message.text, /"event":"push"/);
  assert.equal(f.ledger.takeNextTurn(projects[0]!.id), undefined);
});

test('GitHub body replay protection survives restart and expires from the first acceptance', (t) => {
  const { deliver, f, source, inbounds } = github(t, [{ id: 'one', repo: 'owner/one' }]);
  const payload = repository('owner/one');
  const first = one(deliver(payload, { delivery: 'original' }));
  const { secret } = inbounds.issue(source.id, USER, at(2000));
  const ledger = f.open();
  const later = createInbounds({ ledger, dataDir: f.dir, skewMs: () => DEFAULT_TRIGGER_POLICY.inboundSkewMs });
  const replay = (now: Date, delivery: string) => {
    const body = Buffer.from(JSON.stringify(payload));
    const headers = {
      'x-github-event': 'push', 'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    };
    return later.receive(source.id, { header: (name) => headers[name.toLowerCase() as keyof typeof headers] ?? null, body }, now);
  };
  // A new key does not give a recorded body a new identity.
  const before = one(replay(at(DEFAULT_TRIGGER_POLICY.dedupeKeepMs), 'before-end'));
  assert.equal(before.status === 'accepted' && before.fire_id, first.status === 'accepted' && first.fire_id);
  const after = one(replay(at(1000 + DEFAULT_TRIGGER_POLICY.dedupeKeepMs), 'at-end'));
  assert.equal(after.status === 'accepted' && after.duplicate, false);
});

test('GitHub body replay protection is per project and a paused project can retry', (t) => {
  const { deliver, f, projects, fires } = github(t, [
    { id: 'one', repo: 'owner/one' }, { id: 'two', repo: 'owner/one' },
  ]);
  f.ledger.setProjectPaused(projects[1]!.id, true, USER);
  const payload = repository('owner/one');
  const first = deliver(payload, { delivery: 'original' });
  assert.equal(first?.status, 'accepted');
  assert.equal(fires().length, 1);
  f.ledger.setProjectPaused(projects[1]!.id, false, USER);
  const retried = deliver(payload, { delivery: 'changed' });
  assert.equal(retried?.status, 'accepted');
  const receipts = retried?.status === 'accepted' ? retried.receipts : [];
  assert.deepEqual(receipts.map((receipt) => receipt.status === 'accepted' && receipt.duplicate), [true, false]);
  assert.equal(fires().length, 2);
});
