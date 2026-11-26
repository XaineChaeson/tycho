import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputError } from '../service/errors.ts';
import { createInbounds } from '../service/inbound.ts';
import { decodeStandardWebhookKey, standardWebhookSignature, translateStandardWebhooks } from '../service/inbound/standard-webhooks.ts';
import { STANDARD_WEBHOOK_HEADERS, TYCHO_V1_HEADERS } from '../shared/triggers.ts';
import { fixture, USER } from './helpers.ts';

function headersOf(map: Record<string, string>) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lower.get(name.toLowerCase()) ?? null;
}

test('standard-webhooks translator verifies v1,<base64> signatures with whsec_ keys, multiple rotation tokens, and timestamp skew', () => {
  const secret1 = `whsec_${Buffer.alloc(32, 0x11).toString('base64')}`;
  const secret2 = `whsec_${Buffer.alloc(32, 0x22).toString('base64')}`;
  const now = new Date('2026-11-22T10:00:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = Buffer.from(JSON.stringify({
    schema_version: 1,
    event_id: 'msg_0123456789abcdef0123456789abcdef',
    event_type: 'task.run.failed',
    severity: 'error',
    summary: '任务 daily_backtest 执行失败：exit_code=1',
  }), 'utf8');
  const sig2 = standardWebhookSignature(secret2, 'msg_0123456789abcdef0123456789abcdef', ts, body);

  // Space-separated multi-signature header (key rotation)
  const ok = translateStandardWebhooks(
    {
      header: headersOf({
        [STANDARD_WEBHOOK_HEADERS.id]: 'msg_0123456789abcdef0123456789abcdef',
        [STANDARD_WEBHOOK_HEADERS.time]: ts,
        [STANDARD_WEBHOOK_HEADERS.signature]: `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${sig2}`,
      }),
      body,
      now,
      skewMs: 300_000,
    },
    [{ id: 'k1', secret: secret1 }, { id: 'k2', secret: secret2 }],
    [{ id: 'proj_1', repos: [] }],
  );
  assert.equal(ok.status, 'signed');
  assert.equal(ok.keyId, 'k2');
  assert.equal(ok.eventIdSigned, true);
  assert.equal(ok.events.length, 1);
  assert.equal(ok.events[0]!.projectId, 'proj_1');
  assert.equal(ok.events[0]!.eventId, 'msg_0123456789abcdef0123456789abcdef');
  assert.equal((ok.events[0]!.data.body as { event_type: string }).event_type, 'task.run.failed');

  // Stale timestamp rejected
  const stale = translateStandardWebhooks(
    {
      header: headersOf({
        [STANDARD_WEBHOOK_HEADERS.id]: 'msg_stale',
        [STANDARD_WEBHOOK_HEADERS.time]: String(Number(ts) - 600),
        [STANDARD_WEBHOOK_HEADERS.signature]: standardWebhookSignature(secret2, 'msg_stale', String(Number(ts) - 600), body),
      }),
      body,
      now,
      skewMs: 300_000,
    },
    [{ id: 'k2', secret: secret2 }],
    [{ id: 'proj_1', repos: [] }],
  );
  assert.deepEqual(stale, { status: 'refused', reason: 'stale' });

  // Bad signature rejected
  const badSig = translateStandardWebhooks(
    {
      header: headersOf({
        [STANDARD_WEBHOOK_HEADERS.id]: 'msg_bad',
        [STANDARD_WEBHOOK_HEADERS.time]: ts,
        [STANDARD_WEBHOOK_HEADERS.signature]: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      }),
      body,
      now,
      skewMs: 300_000,
    },
    [{ id: 'k2', secret: secret2 }],
    [{ id: 'proj_1', repos: [] }],
  );
  assert.deepEqual(badSig, { status: 'refused', reason: 'signature' });

  // Multiple projects are ALWAYS refused even when an unsigned X-Tycho-Project header is sent
  const multiNoProject = translateStandardWebhooks(
    {
      header: headersOf({
        [STANDARD_WEBHOOK_HEADERS.id]: 'msg_multi',
        [STANDARD_WEBHOOK_HEADERS.time]: ts,
        [STANDARD_WEBHOOK_HEADERS.signature]: standardWebhookSignature(secret2, 'msg_multi', ts, body),
      }),
      body,
      now,
      skewMs: 300_000,
    },
    [{ id: 'k2', secret: secret2 }],
    [{ id: 'proj_1', repos: [] }, { id: 'proj_2', repos: [] }],
  );
  assert.deepEqual(multiNoProject, { status: 'refused', reason: 'no_project' });

  const multiWithUnsignedHeader = translateStandardWebhooks(
    {
      header: headersOf({
        [STANDARD_WEBHOOK_HEADERS.id]: 'msg_multi_2',
        [STANDARD_WEBHOOK_HEADERS.time]: ts,
        [STANDARD_WEBHOOK_HEADERS.signature]: standardWebhookSignature(secret2, 'msg_multi_2', ts, body),
        [TYCHO_V1_HEADERS.project]: 'proj_2',
      }),
      body,
      now,
      skewMs: 300_000,
    },
    [{ id: 'k2', secret: secret2 }],
    [{ id: 'proj_1', repos: [] }, { id: 'proj_2', repos: [] }],
  );
  assert.deepEqual(multiWithUnsignedHeader, { status: 'refused', reason: 'no_project' });

  // webhook-id containing '.' is rejected to prevent "<id>.<ts>.<body>" canonical ambiguity
  const dottedId = translateStandardWebhooks(
    {
      header: headersOf({
        [STANDARD_WEBHOOK_HEADERS.id]: 'msg.with.dot',
        [STANDARD_WEBHOOK_HEADERS.time]: ts,
        [STANDARD_WEBHOOK_HEADERS.signature]: standardWebhookSignature(secret2, 'msg.with.dot', ts, body),
      }),
      body,
      now,
      skewMs: 300_000,
    },
    [{ id: 'k2', secret: secret2 }],
    [{ id: 'proj_1', repos: [] }],
  );
  assert.deepEqual(dottedId, { status: 'refused', reason: 'unsigned' });

  // Invalid / empty / too-short whsec_ keys are rejected rather than signing with a 0-byte key
  for (const badSecret of ['whsec_', 'whsec_!!!not-base64!!!', 'whsec_AAAA', `whsec_${Buffer.alloc(15, 1).toString('base64')}`]) {
    assert.equal(decodeStandardWebhookKey(badSecret), null, `should reject key ${badSecret}`);
    assert.throws(() => standardWebhookSignature(badSecret, 'msg_1', ts, body));
    const res = translateStandardWebhooks(
      {
        header: headersOf({
          [STANDARD_WEBHOOK_HEADERS.id]: 'msg_badkey',
          [STANDARD_WEBHOOK_HEADERS.time]: ts,
          [STANDARD_WEBHOOK_HEADERS.signature]: sig2,
        }),
        body,
        now,
        skewMs: 300_000,
      },
      [{ id: 'kbad', secret: badSecret }],
      [{ id: 'proj_1', repos: [] }],
    );
    assert.deepEqual(res, { status: 'refused', reason: 'signature' });
  }
});

test('createInboundSource and updateInboundSource reject multi-project standard-webhooks sources', (t) => {
  const f = fixture(t);
  const p2 = f.ledger.createProject({ name: '第二项目' }, USER);

  assert.throws(
    () =>
      f.ledger.createInboundSource({
        name: '多项目标准钩子',
        kind: 'standard-webhooks',
        project_ids: [f.projectId, p2],
      }, USER),
    (err: unknown) => err instanceof InputError && /只能放行一个项目/.test(err.message),
  );

  const single = f.ledger.createInboundSource({
    name: '单项目标准钩子',
    kind: 'standard-webhooks',
    project_ids: [f.projectId],
  }, USER);
  assert.throws(
    () => f.ledger.updateInboundSource(single.id, { project_ids: [f.projectId, p2] }, USER),
    (err: unknown) => err instanceof InputError && /只能放行一个项目/.test(err.message),
  );

  // Switching an existing multi-project tycho-v1 source to standard-webhooks is also rejected
  const multi = f.ledger.createInboundSource({
    name: '多项目通用钩子',
    kind: 'tycho-v1',
    project_ids: [f.projectId, p2],
  }, USER);
  assert.throws(
    () => f.ledger.updateInboundSource(multi.id, { kind: 'standard-webhooks' }, USER),
    (err: unknown) => err instanceof InputError && /只能放行一个项目/.test(err.message),
  );
});

test('createInbounds issues whsec_<base64> secret for standard-webhooks and delivers into ledger', (t) => {
  const f = fixture(t);
  const projectId = f.ledger.createProject({ name: '集群监控' }, USER);
  const inbounds = createInbounds({ ledger: f.ledger, dataDir: f.dir, skewMs: () => 300_000 });
  const source = f.ledger.createInboundSource({
    name: '集群任务告警',
    kind: 'standard-webhooks',
    project_ids: [projectId],
    push_final: true,
    broadcast_groups: true,
  }, USER);

  const issued = inbounds.issue(source.id, USER);
  assert.match(issued.secret, /^whsec_[A-Za-z0-9+/=]{43,44}$/);
  assert.equal(Buffer.from(issued.secret.slice(6), 'base64').byteLength, 32);

  const now = new Date('2026-11-22T10:15:00Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = Buffer.from(JSON.stringify({
    schema_version: 1,
    event_id: 'msg_cluster_alert_001',
    event_type: 'alert.test',
    severity: 'info',
    summary: '测试连通告警',
  }), 'utf8');
  const sig = standardWebhookSignature(issued.secret, 'msg_cluster_alert_001', ts, body);

  const result = inbounds.receive(source.id, {
    header: headersOf({
      [STANDARD_WEBHOOK_HEADERS.id]: 'msg_cluster_alert_001',
      [STANDARD_WEBHOOK_HEADERS.time]: ts,
      [STANDARD_WEBHOOK_HEADERS.signature]: sig,
    }),
    body,
  }, now);

  assert.ok(result);
  assert.equal(result.status, 'accepted');
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]!.status, 'accepted');
  const fires = f.ledger.listTriggerFires({ sourceOnly: true, limit: 5 });
  assert.equal(fires[0]!.project_id, projectId);
  assert.equal(fires[0]!.event_id, 'msg_cluster_alert_001');
  assert.equal(fires[0]!.broadcast_groups, true);
});
