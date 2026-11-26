// Guards the step from ledger version 39 to 40 (docs/design/triggers.md §2.2, step 4) against:
// a Webhook trigger left behind as a trigger, or turned into a source that lets through the wrong
// projects; its fixed instruction lost instead of becoming the source's note; its keys or their
// retirement times lost; its occurrence records dropped, or left pointing at a rule that is gone;
// a rule's occurrence records moved to a source; an occurrence the old trigger accepted no longer
// holding its identity under the source; the settings that governed a webhook not
// following it; a ledger with no Webhook trigger left without the two new tables; and a crash on
// either side of the step's commit leaving a ledger between the two versions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { createInbounds, inboundSecretDir } from '../service/inbound.ts';
import { openLedger } from '../service/ledger.ts';
import { putSecret } from '../service/secrets.ts';
import { PRESET_ROLES } from '../shared/roles.ts';
import { TYCHO_V1_HEADERS } from '../shared/triggers.ts';
import { tychoSignature } from '../service/inbound/tycho-v1.ts';
import { USER } from './helpers.ts';

const V39 = new URL('./fixtures/ledger/schema-v39.sql', import.meta.url);
const AT = '2026-11-01T00:00:00.000Z';
class Crash extends Error {}

const SECRET = 'the-secret-that-was-under-the-old-key';
const K1 = 'K'.repeat(26);
const K2 = 'M'.repeat(26);
const K3 = 'N'.repeat(26);

function version39(t: TestContext, webhook = true): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-migrate39-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const path = join(dir, 'ledger.db');
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(readFileSync(V39, 'utf8'));
  const run = (sql: string, ...params: (string | number | null)[]) => conn.prepare(sql).run(...params);
  run(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-version', ?, 'schema_version', '39')`, AT);
  run(`INSERT INTO setting (id, created_at, key, value_json) VALUES ('s-tunables', ?, 'tunables', ?)`, AT,
    JSON.stringify({ 'triggers.webhookSkewMs': 60_000, 'triggers.webhookRotateMs': 3_600_000, 'triggers.queueMax': 9 }));
  const role = conn.prepare(`INSERT INTO role (id, created_at, updated_at, name, description, default_tier, permission, deliverable, needs_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const each of PRESET_ROLES) role.run(each.id, AT, AT, each.name, each.description, each.default_tier, each.permission, each.deliverable, each.needs_review ? 1 : 0);
  run(`INSERT INTO project (id, created_at, name, login_mode) VALUES ('p1', ?, '甲', 'all')`, AT);
  run(`INSERT INTO project (id, created_at, name, login_mode) VALUES ('p2', ?, '乙', 'all')`, AT);
  const rule = conn.prepare(`INSERT INTO trigger_rule (id, created_at, updated_at, project_id, name, enabled, source, params_json, instruction, missed, expires_at, push_final, revision, created_by, deleted_at, rejected_count, rejected_at, rejected_reason, streak_reason, streak_count, problem_since, alerted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A scheduled rule that must stay one.
  rule.run('r1', AT, AT, 'p1', '早检', 1, 'schedule', '{"kind":"once","at":"2030-01-01T00:00:00.000Z"}', '看看构建', 'latest', null, 0, 1, 'router', null, 0, null, null, null, 0, null, null);
  run(`INSERT INTO trigger_cursor (trigger_id, done_at) VALUES ('r1', ?)`, AT);
  if (webhook) {
    // Two live sources and one the owner had deleted; each carried its own instruction, keys and
    // run of refusals.
    rule.run('h1', AT, AT, 'p1', 'CI', 1, 'webhook', '{}', '看看这次构建', 'latest', null, 1, 1, 'router', null, 3, AT, 'queue_full', 'queue_full', 3, AT, null);
    rule.run('h2', AT, AT, 'p2', '监控', 0, 'webhook', '{}', '看看报警', 'latest', null, 0, 1, 'router', null, 1, AT, 'signature', null, 0, null, null);
    rule.run('h3', AT, AT, 'p1', '已删的', 0, 'webhook', '{}', '旧的', 'latest', null, 0, 1, 'router', AT, 0, null, null, null, 0, null, null);
    const key = conn.prepare(`INSERT INTO trigger_key (id, trigger_id, created_at, created_by, retires_at) VALUES (?, ?, ?, 'console', ?)`);
    key.run(K1, 'h1', AT, '2099-01-02T00:00:00.000Z');
    key.run(K2, 'h1', AT, null);
    key.run(K3, 'h2', AT, null);
    // Occurrences of a webhook trigger and of the scheduled rule.
    const fire = conn.prepare(`INSERT INTO trigger_fire (id, created_at, trigger_id, project_id, event_id, digest, scheduled_at, revision, periodic, data_json, message_id, outcome, merged_into, merged_count, merged_capped, push_final, keep_until, released_at)
      VALUES (?, ?, ?, ?, ?, 'd', NULL, ?, 0, '{}', NULL, ?, NULL, 1, 0, ?, ?, NULL)`);
    fire.run('f-h1', AT, 'h1', 'p1', 'e-h1', 1, 'delivered', 1, AT);
    fire.run('f-h2', AT, 'h2', 'p2', 'e-h2', 1, 'expired', 0, AT);
    fire.run('f-r1', AT, 'r1', 'p1', 'e-r1', 1, 'delivered', 1, AT);
    // A migrated occurrence keeps its content and its keep-until, so the same event signed again
    // after the upgrade is the same acceptance and not a second one.
    run(`UPDATE trigger_fire SET digest = ?, keep_until = ? WHERE id = 'f-h1'`, createHash('sha256').update('{"ok":true}').digest('hex'), '2030-01-02T00:00:00.000Z');
    // What the owner was told about h1's full queue: a notice waiting in both the outbox and
    // the push table names the trigger as the thing to ask about again.
    const problem = { external_id: `trigger-problem:h1:${AT}`, trigger_id: 'h1', name: 'CI', problem: 'queue_full', since: AT, detail: '项目里待处理的触发消息满了' };
    run(`INSERT INTO outbox (id, created_at, channel, kind, payload_json, state, next_at) VALUES ('o1', ?, 'wecom', 'trigger_problem', ?, 'pending', ?)`, AT, JSON.stringify(problem), AT);
    run(`INSERT INTO push (id, created_at, key, level, kind, project_id, payload_json, state) VALUES ('u1', ?, 'trigger-problem:h1', 'waiting', 'trigger_problem', 'p1', ?, 'open')`, AT, JSON.stringify(problem));
  }
  conn.close();
  return { dir, path };
}

const version = (path: string): string => {
  const conn = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.parse((conn.prepare(`SELECT value_json FROM setting WHERE key = 'schema_version'`).get() as { value_json: string }).value_json) as string;
  } finally {
    conn.close();
  }
};

test('a version 39 ledger turns each Webhook trigger into a tycho-v1 source of its own project, with its keys, note and records', async (t) => {
  const { dir, path } = version39(t);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  t.after(() => ledger.close());
  assert.equal(String(version(path)), String(SCHEMA_VERSION));
  const raw = new DatabaseSync(path);
  try {
    const sources = raw.prepare('SELECT * FROM inbound_source ORDER BY rowid').all() as Record<string, unknown>[];
    assert.deepEqual(sources.map(({ id, name, kind, projects_json, note, push_final, enabled, deleted_at }) => ({ id, name, kind, projects_json, note, push_final, enabled, deleted_at })), [
      { id: 'h1', name: 'CI', kind: 'tycho-v1', projects_json: '["p1"]', note: '看看这次构建', push_final: 1, enabled: 1, deleted_at: null },
      { id: 'h2', name: '监控', kind: 'tycho-v1', projects_json: '["p2"]', note: '看看报警', push_final: 0, enabled: 0, deleted_at: null },
      { id: 'h3', name: '已删的', kind: 'tycho-v1', projects_json: '["p1"]', note: '旧的', push_final: 0, enabled: 0, deleted_at: AT },
    ]);
    assert.deepEqual(sources.map(({ rejected_count, rejected_reason, streak_reason, streak_count }) => ({ rejected_count, rejected_reason, streak_reason, streak_count })), [
      { rejected_count: 3, rejected_reason: 'queue_full', streak_reason: 'queue_full', streak_count: 3 },
      { rejected_count: 1, rejected_reason: 'signature', streak_reason: null, streak_count: 0 },
      { rejected_count: 0, rejected_reason: null, streak_reason: null, streak_count: 0 },
    ]);
    // The keys moved as they were, retirement times included, and the old table is gone.
    assert.deepEqual(raw.prepare('SELECT id, source_id, retires_at FROM inbound_key ORDER BY rowid').all().map((row) => ({ ...row })), [
      { id: K1, source_id: 'h1', retires_at: '2099-01-02T00:00:00.000Z' },
      { id: K2, source_id: 'h1', retires_at: null },
      { id: K3, source_id: 'h2', retires_at: null },
    ]);
    assert.deepEqual(raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trigger_key'`).all(), []);
    // The scheduled rule stayed one; no Webhook trigger did.
    assert.deepEqual(raw.prepare('SELECT id, source FROM trigger_rule ORDER BY rowid').all().map((row) => ({ ...row })), [{ id: 'r1', source: 'schedule' }]);
    // Occurrences: a source's keep their own id and lose the rule's revision; a rule's do not move.
    assert.deepEqual(raw.prepare('SELECT id, trigger_id, source_id, revision, outcome FROM trigger_fire ORDER BY rowid').all().map((row) => ({ ...row })), [
      { id: 'f-h1', trigger_id: null, source_id: 'h1', revision: null, outcome: 'delivered' },
      { id: 'f-h2', trigger_id: null, source_id: 'h2', revision: null, outcome: 'expired' },
      { id: 'f-r1', trigger_id: 'r1', source_id: null, revision: 1, outcome: 'delivered' },
    ]);
    // The settings that governed a webhook govern a source now, at the same values.
    assert.deepEqual(JSON.parse((raw.prepare(`SELECT value_json FROM setting WHERE key = 'tunables'`).get() as { value_json: string }).value_json), {
      'triggers.inboundSkewMs': 60_000, 'triggers.inboundRotateMs': 3_600_000, 'triggers.queueMax': 9, 'knowledge.externalEntry': true,
    });
    // What waits for the owner about the source names it as a source, so asking again finds it.
    for (const table of ['outbox', 'push']) {
      const payload = JSON.parse((raw.prepare(`SELECT payload_json FROM ${table} ORDER BY rowid LIMIT 1`).get() as { payload_json: string }).payload_json) as Record<string, unknown>;
      assert.equal(payload.source_id, 'h1', `${table} 的通知改说来源`);
      assert.equal(Object.hasOwn(payload, 'trigger_id'), false, `${table} 的通知不再说触发器`);
    }
  } finally {
    raw.close();
  }
  // The source's last problem is still the one the owner was told about.
  assert.equal(ledger.pushStillWaiting('trigger_problem', { source_id: 'h1', problem: 'queue_full', since: AT }), false, '队满已经不满');
  const seen = ledger.getInboundSource('h1')!;
  assert.deepEqual([seen.kind, seen.project_ids, seen.note, seen.push_final, seen.keys.length], ['tycho-v1', ['p1'], '看看这次构建', true, 2]);
  // A request signed with a key that migrated is taken, through the same folder and protocol.
  putSecret(join(inboundSecretDir(dir), K1), SECRET);
  const inbounds = createInbounds({ ledger, dataDir: dir, skewMs: () => 60_000, log: () => {} });
  const signedAt = String(Math.floor(Date.parse(AT) / 1000));
  const body = Buffer.from('{"ok":true}');
  const headers: Record<string, string> = {
    [TYCHO_V1_HEADERS.event]: 'after-upgrade',
    [TYCHO_V1_HEADERS.time]: signedAt,
    [TYCHO_V1_HEADERS.signature]: tychoSignature(SECRET, signedAt, 'after-upgrade', 'p1', body),
    [TYCHO_V1_HEADERS.project]: 'p1',
  };
  const result = inbounds.receive('h1', { header: (name) => headers[name] ?? null, body }, new Date(AT));
  assert.equal(result?.status, 'accepted');
  const receipt = result?.status === 'accepted' ? result.receipts[0] : undefined;
  assert.equal(receipt?.status === 'accepted' && receipt.outcome, 'delivered');
  // An occurrence the old Webhook trigger accepted still holds its identity under the source: the
  // same event, signed again, answers with the record that was already there.
  const replayHeaders: Record<string, string> = { ...headers, [TYCHO_V1_HEADERS.event]: 'e-h1', [TYCHO_V1_HEADERS.signature]: tychoSignature(SECRET, signedAt, 'e-h1', 'p1', body) };
  const replay = inbounds.receive('h1', { header: (name) => replayHeaders[name] ?? null, body }, new Date(AT));
  assert.equal(replay?.status, 'accepted');
  const replayed = replay?.status === 'accepted' ? replay.receipts[0] : undefined;
  assert.equal(replayed?.status === 'accepted' && replayed.duplicate, true);
  assert.equal(replayed?.status === 'accepted' && replayed.fire_id, 'f-h1');
  ledger.close();
  assert.equal(verifySnapshot(path).get('schema_version'), String(SCHEMA_VERSION));
});

test('a ledger with no Webhook trigger still gains inbound sources without any existing grants and keeps its rules', (t) => {
  const { path } = version39(t, false);
  const ledger = openLedger(path, { copyBeforeUpgrade: false });
  t.after(() => ledger.close());
  assert.deepEqual(ledger.listInboundSources(), []);
  assert.deepEqual(ledger.listTriggers('p1').map(({ id, source }) => [id, source]), [['r1', 'schedule']]);
  const raw = new DatabaseSync(path);
  try {
    assert.deepEqual(raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'inbound_%' ORDER BY name`).all().map((row) => ({ ...row })), [{ name: 'inbound_key' }, { name: 'inbound_receipt_reply' }, { name: 'inbound_source' }]);
    assert.equal((raw.prepare('SELECT count(*) AS n FROM trigger_fire').get() as { n: number }).n, 0);
    assert.equal((raw.prepare(`SELECT count(*) AS n FROM change WHERE action = 'inbound.migrate'`).get() as { n: number }).n, 0, '没有旧触发器就不写迁移审计');
  } finally {
    raw.close();
  }
  ledger.close();
});

test('a crash on either side of the step\'s commit leaves version 39 or 40 whole, and the next open finishes', (t) => {
  for (const side of ['before', 'after'] as const) {
    const { path } = version39(t);
    assert.throws(() => new Db(path, false, {
      [side === 'before' ? 'beforeMigrationCommit' : 'afterMigrationCommit']: (from: number) => { if (from === 39) throw new Crash(); },
    }, { copyBeforeUpgrade: false }), Crash);
    assert.equal(String(version(path)), side === 'before' ? '39' : '40');
    const db = new Db(path, false, {}, { copyBeforeUpgrade: false });
    assert.deepEqual(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_source'`).length, 1);
    assert.deepEqual({ ...db.get<{ note: string; kind: string }>(`SELECT note, kind FROM inbound_source WHERE id = 'h1'`) }, { note: '看看这次构建', kind: 'tycho-v1' });
    assert.deepEqual(db.all<{ id: string }>('SELECT id FROM trigger_rule ORDER BY rowid').map(({ id }) => id), ['r1']);
    db.close();
  }
});
