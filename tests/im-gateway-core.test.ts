import './guard.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  evaluateGroupFastPath,
  IM_CHANNEL_LABELS,
  IM_CHANNELS,
  IM_GROUP_CAPABLE_CHANNELS,
  IM_GROUP_TRIGGER_MODES,
  isGroupCapableChannel,
  parseRuleRegex,
  validateAllowedSenders,
  validateCooldownSeconds,
  validateInlineContextCount,
  validateRuleKeywords,
} from '../shared/im.ts';
import { ACTION_TEXT, LOGIN_METHOD_LABELS } from '../shared/labels.ts';
import { createAuth, deadLinkPage, enterPage, waitDeviceLoginPage } from '../service/auth.ts';
import { Db, SCHEMA_VERSION, verifySnapshot } from '../service/db.ts';
import { InputError } from '../service/errors.ts';
import { openLedger } from '../service/ledger.ts';
import { createProjectHome } from '../service/project-home.ts';
import { SETTINGS } from '../service/settings.ts';
import { fixture, tuned, USER } from './helpers.ts';

const ONE_HOUR = 3_600_000;
const ONE_DAY = 24 * ONE_HOUR;

test('schema migration v45 -> v46, verifySnapshot, and bindProjectHomeGuard', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-im-mig-'));
  let home: ReturnType<typeof createProjectHome> | undefined;
  let ledger: ReturnType<typeof openLedger> | undefined;
  t.after(() => {
    ledger?.close();
    home?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const dbPath = join(dir, 'ledger.db');

  // Create a fresh DB then roll it back to an authentic v45 layout.
  const initial = new Db(dbPath, false);
  initial.close();

  const raw = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
  raw.exec(`
    DROP TABLE im_group_binding;
    DROP TABLE im_group_context;
    ALTER TABLE message DROP COLUMN reply_to_external_id;
    ALTER TABLE inbound_source DROP COLUMN broadcast_groups;
    ALTER TABLE inbound_source DROP COLUMN broadcast_group_ids_json;
    ALTER TABLE trigger_rule DROP COLUMN broadcast_groups;
    ALTER TABLE trigger_rule DROP COLUMN broadcast_group_ids_json;
    ALTER TABLE trigger_fire DROP COLUMN broadcast_groups;
    ALTER TABLE trigger_fire DROP COLUMN broadcast_group_ids_json;
    UPDATE setting SET value_json = '45' WHERE key = 'schema_version';
  `);
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.close();

  // Standalone copy verifies as v45.
  const v45Snap = join(dir, 'v45.db');
  const copyConn = new DatabaseSync(dbPath);
  copyConn.prepare('VACUUM INTO ?').run(v45Snap);
  copyConn.close();
  assert.equal(verifySnapshot(v45Snap).get('schema_version'), '45');

  // Opening with projectHome guard runs MIGRATIONS[45..] -> SCHEMA_VERSION and binds guards for every table.
  assert.equal(SCHEMA_VERSION, 48);
  home = createProjectHome(dir);
  ledger = openLedger(dbPath, { projectHome: home, copyBeforeUpgrade: false });

  const projectId = ledger.createProject({ name: '迁移后项目' }, USER);
  const binding = ledger.createImGroupBinding({
    channel: 'wecom',
    chat_id: 'wr-mig-1',
    chat_name: '研发群',
    project_id: projectId,
  }, USER);
  assert.equal(binding.project_name, '迁移后项目');

  const ctxRow = ledger.recordImGroupContext({
    channel: 'weixin',
    chatId: 'wx-room-1',
    externalId: 'ext-1',
    actor: 'alice',
    text: '测试群消息',
    mentionedBot: false,
  });
  assert.equal(ctxRow.fresh, true);

  // Verify upgraded snapshot as current schema version.
  const v46Snap = join(dir, 'v46.db');
  const upgradedConn = new DatabaseSync(dbPath);
  upgradedConn.prepare('VACUUM INTO ?').run(v46Snap);
  upgradedConn.close();
  assert.equal(verifySnapshot(v46Snap).get('schema_version'), String(SCHEMA_VERSION));
});

test('evaluateGroupFastPath covers disabled, sender gate, mention, keywords/regex, cooldown, and ReDoS safety', () => {
  assert.deepEqual(IM_CHANNELS, ['wecom', 'weixin']);
  assert.equal(IM_CHANNEL_LABELS.wecom, '企业微信');
  assert.equal(IM_CHANNEL_LABELS.weixin, '微信');
  assert.deepEqual(IM_GROUP_TRIGGER_MODES, ['mention_only', 'mention_or_rules']);

  const baseBinding = {
    enabled: true,
    trigger_mode: 'mention_or_rules' as const,
    allow_all_senders: false,
    allowed_senders: ['bob'],
    rule_keywords: ['P0告警', '/^deploy\\s+prod/i'],
    cooldown_seconds: 60,
    last_triggered_at: null as string | null,
  };

  // Disabled binding
  assert.deepEqual(
    evaluateGroupFastPath({ ...baseBinding, enabled: false }, { actor: 'owner', text: 'P0告警', mentionedBot: true }, { isWhitelisted: true }),
    { pass: false, reason: 'disabled' },
  );

  // Sender gate: denied vs allowed_senders vs isWhitelisted vs allow_all_senders
  assert.deepEqual(
    evaluateGroupFastPath(baseBinding, { actor: 'stranger', text: 'P0告警', mentionedBot: true }, { isWhitelisted: false }),
    { pass: false, reason: 'sender_denied' },
  );
  assert.deepEqual(
    evaluateGroupFastPath(baseBinding, { actor: 'bob', text: '你好', mentionedBot: true }, { isWhitelisted: false }),
    { pass: true, reason: 'mention' },
  );
  assert.deepEqual(
    evaluateGroupFastPath(baseBinding, { actor: 'owner', text: '你好', mentionedBot: true }, { isWhitelisted: true }),
    { pass: true, reason: 'mention' },
  );
  assert.deepEqual(
    evaluateGroupFastPath({ ...baseBinding, allow_all_senders: true }, { actor: 'stranger', text: 'hello', mentionedBot: true }, { isWhitelisted: false }),
    { pass: true, reason: 'mention' },
  );

  // mention_only ignores keyword rules
  assert.deepEqual(
    evaluateGroupFastPath({ ...baseBinding, trigger_mode: 'mention_only' }, { actor: 'bob', text: 'P0告警 挂了', mentionedBot: false }, { isWhitelisted: false }),
    { pass: false, reason: 'no_mention_or_rule' },
  );

  // Substring case-insensitive match
  const t0 = Date.parse('2026-11-22T10:00:00.000Z');
  assert.deepEqual(
    evaluateGroupFastPath(baseBinding, { actor: 'bob', text: '收到 p0告警 请处理', mentionedBot: false }, { isWhitelisted: false, nowMs: t0 }),
    { pass: true, reason: 'rule', matchedKeyword: 'P0告警' },
  );

  // Regex match
  assert.deepEqual(
    evaluateGroupFastPath(baseBinding, { actor: 'bob', text: 'DEPLOY prod now', mentionedBot: false }, { isWhitelisted: false, nowMs: t0 }),
    { pass: true, reason: 'rule', matchedKeyword: '/^deploy\\s+prod/i' },
  );

  // Cooldown suppresses rule triggers, but @mention still passes
  const inCooldown = { ...baseBinding, last_triggered_at: '2026-11-22T09:59:30.000Z' };
  assert.deepEqual(
    evaluateGroupFastPath(inCooldown, { actor: 'bob', text: 'p0告警', mentionedBot: false }, { isWhitelisted: false, nowMs: t0 }),
    { pass: false, reason: 'cooldown', matchedKeyword: 'P0告警' },
  );
  assert.deepEqual(
    evaluateGroupFastPath(inCooldown, { actor: 'bob', text: 'p0告警', mentionedBot: true }, { isWhitelisted: false, nowMs: t0 }),
    { pass: true, reason: 'mention' },
  );
  // Cooldown elapsed passes
  assert.deepEqual(
    evaluateGroupFastPath(inCooldown, { actor: 'bob', text: 'p0告警', mentionedBot: false }, { isWhitelisted: false, nowMs: t0 + 30_000 }),
    { pass: true, reason: 'rule', matchedKeyword: 'P0告警' },
  );

  // Invalid regex, disallowed flags, >120 char regex, and catastrophic ReDoS pattern never throw or hang
  const hostileBinding = {
    ...baseBinding,
    rule_keywords: [
      '/[unclosed/i',
      '/foo/g',
      '/(a+)+$/',
      `/${'a'.repeat(121)}/i`,
      'safe-fallback',
    ],
  };
  const evilText = `${'a'.repeat(40)}! safe-fallback`;
  const started = Date.now();
  const decision = evaluateGroupFastPath(hostileBinding, { actor: 'bob', text: evilText, mentionedBot: false }, { isWhitelisted: false, nowMs: t0 });
  assert.ok(Date.now() - started < 500, 'ReDoS guard must finish almost instantly');
  assert.deepEqual(decision, { pass: true, reason: 'rule', matchedKeyword: 'safe-fallback' });

  // Validation helpers & ReDoS hardening
  assert.equal(validateRuleKeywords(['正常关键词', '/^P[01]/i', '/^(?:P0|P1)\\s+告警/i']).ok, true);
  for (const dangerous of [
    '/(a+)+$/',
    '/(a|a)+$/',
    '/(a?){25}a{25}/',
    '/(\\w+)\\1+$/',
    '/.*a.*a.*a.*a.*b/',
    '/a{1,101}/',
    '/(a{2,})/',
  ]) {
    const parsed = parseRuleRegex(dangerous);
    assert.equal(parsed.isRegex && !parsed.ok, true, `should reject ReDoS regex ${dangerous}`);
    assert.equal(validateRuleKeywords([dangerous]).ok, false, `validateRuleKeywords should reject ${dangerous}`);
  }
  assert.equal(validateRuleKeywords(['/foo/g']).ok, false);
  assert.equal(validateRuleKeywords(['/[bad/i']).ok, false);

  // evaluateGroupFastPath caps inspected text to 4096 chars
  const beyondCapText = `${'x'.repeat(4096)}P0告警`;
  assert.deepEqual(
    evaluateGroupFastPath(baseBinding, { actor: 'bob', text: beyondCapText, mentionedBot: false }, { isWhitelisted: false, nowMs: t0 }),
    { pass: false, reason: 'no_mention_or_rule' },
  );
  assert.equal(validateAllowedSenders(['u1', 'u2', 'u1']).ok, true);
  assert.equal(validateAllowedSenders(['']).ok, false);
  assert.equal(validateCooldownSeconds(0).ok, true);
  assert.equal(validateCooldownSeconds(86_400).ok, true);
  assert.equal(validateCooldownSeconds(-1).ok, false);
  assert.equal(validateCooldownSeconds(86_401).ok, false);
  assert.equal(validateInlineContextCount(0).ok, true);
  assert.equal(validateInlineContextCount(20).ok, true);
  assert.equal(validateInlineContextCount(21).ok, false);
});

test('im_group_binding CRUD, uniqueness, broadcast list, audit labels, and deleteProject cleanup', (t) => {
  const f = fixture(t);
  assert.equal(ACTION_TEXT['im.group_binding.create'], '绑定群聊到项目');
  assert.equal(ACTION_TEXT['im.group_binding.update'], '修改群聊绑定');
  assert.equal(ACTION_TEXT['im.group_binding.delete'], '解绑群聊');
  assert.equal(LOGIN_METHOD_LABELS.weixin, '微信放行');

  const p2Id = f.ledger.createProject({ name: '项目二' }, USER);

  const b1 = f.ledger.createImGroupBinding({
    channel: 'wecom',
    chat_id: 'chat-001',
    chat_name: '报警群',
    project_id: f.projectId,
    trigger_mode: 'mention_or_rules',
    allow_all_senders: true,
    rule_keywords: ['故障', '/^P0/i'],
    cooldown_seconds: 120,
    inline_context_count: 8,
    accept_media: true,
    notify_events: true,
  }, USER);
  assert.equal(b1.project_id, f.projectId);
  assert.equal(b1.trigger_mode, 'mention_or_rules');
  assert.deepEqual(b1.rule_keywords, ['故障', '/^P0/i']);
  assert.equal(b1.cooldown_seconds, 120);
  assert.equal(b1.inline_context_count, 8);
  assert.equal(b1.last_triggered_at, null);

  // Unique (channel, chat_id) enforcement
  assert.throws(
    () => f.ledger.createImGroupBinding({ channel: 'wecom', chat_id: 'chat-001', project_id: p2Id }, USER),
    (err: unknown) => err instanceof InputError && /已绑定/.test(err.message),
  );
  // Group channel capability guard: Weixin is DM-only and rejected for group bindings
  assert.deepEqual(IM_GROUP_CAPABLE_CHANNELS, ['wecom']);
  assert.equal(isGroupCapableChannel('wecom'), true);
  assert.equal(isGroupCapableChannel('weixin'), false);
  assert.throws(
    () => f.ledger.createImGroupBinding({
      channel: 'weixin',
      chat_id: 'chat-001',
      chat_name: '微信群',
      project_id: f.projectId,
    }, USER),
    (err: unknown) => err instanceof InputError && /暂只支持私聊/.test(err.message),
  );
  // A second WeCom group on the same project is allowed
  const b2 = f.ledger.createImGroupBinding({
    channel: 'wecom',
    chat_id: 'chat-002',
    chat_name: '研发二群',
    project_id: f.projectId,
    notify_events: false,
  }, USER);
  assert.equal(f.ledger.listImGroupBindings(f.projectId).length, 2);
  assert.equal(f.ledger.findImGroupBinding('wecom', 'chat-001')?.id, b1.id);

  // Broadcast groups only return enabled + notify_events = true + group-capable channels
  assert.deepEqual(f.ledger.listProjectBroadcastGroups(f.projectId).map((g) => g.id), [b1.id]);

  // Update & touch last_triggered_at
  const updated = f.ledger.updateImGroupBinding(b2.id, { notify_events: true, chat_name: '企微播报群' }, USER);
  assert.equal(updated.notify_events, true);
  assert.equal(updated.chat_name, '企微播报群');
  assert.deepEqual(f.ledger.listProjectBroadcastGroups(f.projectId).map((g) => g.id), [b1.id, b2.id]);
  assert.deepEqual(f.ledger.listProjectBroadcastGroups(f.projectId, [b2.id]).map((g) => g.id), [b2.id]);

  f.ledger.touchImGroupBindingTriggered(b1.id, '2026-11-22T12:00:00.000Z');
  assert.equal(f.ledger.getImGroupBinding(b1.id).last_triggered_at, '2026-11-22T12:00:00.000Z');

  // Record a context row linked to p2 and a message in p2, then delete p2 -> binding deleted, context unlinked
  const bP2 = f.ledger.createImGroupBinding({ channel: 'wecom', chat_id: 'chat-p2', project_id: p2Id }, USER);
  const received = f.ledger.frontReceive({
    channel: 'wecom',
    bot: 'bot1',
    externalId: 'ext-p2-1',
    actor: 'member-x',
    thread: 'chat-p2',
    text: '群里发一条',
    material: false,
    forcedProjectId: p2Id,
  });
  assert.equal(received.state, 'received');
  const ctx = f.ledger.recordImGroupContext({
    channel: 'wecom',
    chatId: 'chat-p2',
    externalId: 'ext-p2-1',
    actor: 'member-x',
    text: '群里发一条',
    mentionedBot: true,
    messageId: received.id,
    projectId: p2Id,
  });
  f.ledger.setProjectArchived(p2Id, true, USER);
  f.ledger.deleteProject(p2Id, '项目二', USER);

  assert.throws(() => f.ledger.getImGroupBinding(bP2.id), InputError);
  const afterCtx = f.ledger.findImGroupContextByExternalId('wecom', 'chat-p2', 'ext-p2-1');
  assert.ok(afterCtx);
  assert.equal(afterCtx.id, ctx.id);
  assert.equal(afterCtx.project_id, null);
  assert.equal(afterCtx.message_id, null);

  // Explicit deleteImGroupBinding
  f.ledger.deleteImGroupBinding(b2.id, USER);
  assert.equal(f.ledger.listImGroupBindings(f.projectId).length, 1);
});

test('im_group_context 200-row ring buffer pruning, discovered groups, cross-project isolation, and linked_task_ids', (t) => {
  const f = fixture(t);
  const p2Id = f.ledger.createProject({ name: '隔离项目' }, USER);

  // Unbound group shows up in listDiscoveredImGroups
  f.ledger.recordImGroupContext({
    channel: 'wecom',
    chatId: 'unbound-room',
    externalId: 'u-1',
    actor: 'bob',
    text: '第一条',
    mentionedBot: false,
  });
  f.ledger.recordImGroupContext({
    channel: 'wecom',
    chatId: 'unbound-room',
    externalId: 'u-2',
    actor: 'carol',
    text: '最新一条',
    mentionedBot: true,
  });
  // Deduplication on (channel, chat_id, external_id)
  const dup = f.ledger.recordImGroupContext({
    channel: 'wecom',
    chatId: 'unbound-room',
    externalId: 'u-2',
    actor: 'carol',
    text: '重复内容',
    mentionedBot: true,
  });
  assert.equal(dup.fresh, false);

  const discovered = f.ledger.listDiscoveredImGroups();
  assert.equal(discovered.length, 1);
  assert.deepEqual(
    {
      channel: discovered[0]!.channel,
      chat_id: discovered[0]!.chat_id,
      last_actor: discovered[0]!.last_actor,
      last_text: discovered[0]!.last_text,
      message_count: discovered[0]!.message_count,
    },
    { channel: 'wecom', chat_id: 'unbound-room', last_actor: 'carol', last_text: '最新一条', message_count: 2 },
  );

  // Bind group to f.projectId -> disappears from discovered list
  const ringBinding = f.ledger.createImGroupBinding({ channel: 'wecom', chat_id: 'ring-room', chat_name: '高频群', project_id: f.projectId }, USER);
  f.ledger.createImGroupBinding({ channel: 'wecom', chat_id: 'unbound-room', chat_name: '已绑定', project_id: p2Id }, USER);
  assert.equal(f.ledger.listDiscoveredImGroups().length, 0);

  // Insert 205 rows into ring-room -> pruned to latest 200
  const ids: string[] = [];
  for (let i = 1; i <= 205; i += 1) {
    const rec = f.ledger.recordImGroupContext({
      channel: 'wecom',
      chatId: 'ring-room',
      externalId: `msg-${i}`,
      actor: `user-${i % 3}`,
      text: `消息 #${i}`,
      mentionedBot: i === 200,
      ...(i === 200
        ? {
            attachmentsMeta: [
              {
                kind: 'image' as const,
                name: 'secret-shot.png',
                mime: 'image/png',
                size: 512,
                url: 'https://qyapi.weixin.qq.com/signed-secret-url?token=leak',
                aes_key: 'SUPER_SECRET_AES_KEY_SHOULD_NOT_LEAK',
                media_id: 'media-secret-1',
              },
            ],
          }
        : {}),
    });
    assert.equal(rec.fresh, true);
    ids.push(rec.id);
  }
  const totalInRing = f.peek<{ n: number }>(`SELECT count(*) AS n FROM im_group_context WHERE channel = 'wecom' AND chat_id = 'ring-room'`)[0]!.n;
  assert.equal(totalInRing, 200);
  assert.equal(f.ledger.findImGroupContextByExternalId('wecom', 'ring-room', 'msg-5'), undefined);
  assert.ok(f.ledger.findImGroupContextByExternalId('wecom', 'ring-room', 'msg-6'));
  assert.ok(f.ledger.findImGroupContextByExternalId('wecom', 'ring-room', 'msg-205'));

  // Link msg-200 to a real message + task created in that message's turn -> chained recall returns linked_task_ids
  const msg200 = f.ledger.frontReceive({
    channel: 'wecom',
    bot: 'bot1',
    externalId: 'msg-200',
    actor: 'user-2',
    thread: 'ring-room',
    text: '消息 #200',
    material: false,
    replyToExternalId: 'msg-199',
    forcedProjectId: f.projectId,
  });
  const storedMsg = f.ledger.getMessage(msg200.id);
  assert.equal(storedMsg.reply_to_external_id, 'msg-199');
  f.ledger.linkImGroupContextMessage(ids[199]!, msg200.id, f.projectId);
  const task = f.ledger.createTask(
    { roleId: 'implement', projectId: f.projectId, title: '跟进200', goal: '处理200', acceptance: '完成' },
    { actor: 'router', messageId: msg200.id },
  );

  // readGroupContextForProject with pagination + replyToExternalId + linked_task_ids + attachment sanitization
  const page1 = f.ledger.readGroupContextForProject(f.projectId, { limit: 10 });
  assert.equal(page1.binding.chat_id, 'ring-room');
  assert.equal(page1.items.length, 10);
  assert.equal(page1.items[0]!.external_id, 'msg-196');
  assert.equal(page1.items[9]!.external_id, 'msg-205');
  assert.ok(page1.next_before_id);
  const item200 = page1.items.find((each) => each.external_id === 'msg-200')!;
  assert.deepEqual(item200.linked_task_ids, [task.id]);
  assert.equal(item200.message_id, msg200.id);
  assert.equal(item200.project_id, f.projectId);
  assert.equal('attachments_meta_json' in item200, false, 'raw attachments_meta_json must not be exposed');
  assert.deepEqual(item200.attachments, [{ kind: 'image', name: 'secret-shot.png', mime: 'image/png', size: 512 }]);
  const serializedPage1 = JSON.stringify(page1);
  assert.equal(serializedPage1.includes('aes_key'), false, 'aes_key must never appear in readGroupContextForProject');
  assert.equal(serializedPage1.includes('signed-secret-url'), false, 'attachment url must never appear in readGroupContextForProject');
  assert.equal(serializedPage1.includes('media-secret-1'), false, 'media_id must never appear in readGroupContextForProject');

  const page2 = f.ledger.readGroupContextForProject(f.projectId, { beforeId: page1.next_before_id!, limit: 5 });
  assert.equal(page2.items.length, 5);
  assert.equal(page2.items[0]!.external_id, 'msg-191');
  assert.equal(page2.items[4]!.external_id, 'msg-195');

  const quoted = f.ledger.readGroupContextForProject(f.projectId, { replyToExternalId: 'msg-200', limit: 3 });
  assert.deepEqual(quoted.items.map((each) => each.external_id), ['msg-198', 'msg-199', 'msg-200']);
  assert.deepEqual(quoted.items[2]!.linked_task_ids, [task.id]);

  // Cross-project isolation: p2 MUST NOT read f.projectId's ring-room!
  assert.throws(
    () => f.ledger.readGroupContextForProject(p2Id, { chatId: 'ring-room' }),
    (err: unknown) => err instanceof InputError && /无权/.test(err.message),
  );

  // Cross-project rebind isolation: after rebinding ring-room to p2, old project's message_id/project_id/linked_task_ids are nulled!
  f.ledger.updateImGroupBinding(ringBinding.id, { project_id: p2Id }, USER);
  const afterRebind = f.ledger.readGroupContextForProject(p2Id, { chatId: 'ring-room', limit: 10 });
  const reboundItem200 = afterRebind.items.find((each) => each.external_id === 'msg-200')!;
  assert.equal(reboundItem200.message_id, null);
  assert.equal(reboundItem200.project_id, null);
  assert.deepEqual(reboundItem200.linked_task_ids, []);
});

test('frontReceive with forcedProjectId, attachments, paused/archived handling, and attachFilesToMessage', (t) => {
  const f = fixture(t);
  const file1 = f.ledger.createProjectFile({
    projectId: f.projectId,
    name: 'screenshot.png',
    mime: 'image/png',
    size: 128,
    sha256: 'abc1',
    kind: 'upload',
    origin: 'owner',
  });
  const file2 = f.ledger.createProjectFile({
    projectId: f.projectId,
    name: 'log.txt',
    mime: 'text/plain',
    size: 64,
    sha256: 'abc2',
    kind: 'upload',
    origin: 'owner',
  });

  // Group member not in global whitelist still routes directly via forcedProjectId
  const rec = f.ledger.frontReceive({
    channel: 'weixin',
    bot: 'wx-bot',
    externalId: 'wx-ext-1',
    actor: 'group-member-99',
    thread: 'wx-group-1',
    text: '看看这个截图',
    material: false,
    forcedProjectId: f.projectId,
    attachmentIds: [file1.id],
    replyToExternalId: 'wx-parent-0',
  });
  assert.equal(rec.fresh, true);
  assert.equal(rec.state, 'received');
  const msg = f.ledger.getMessage(rec.id);
  assert.equal(msg.project_id, f.projectId);
  assert.equal(msg.reply_to_external_id, 'wx-parent-0');
  assert.deepEqual(JSON.parse(msg.attachments_json!), [file1.id]);
  assert.equal(f.ledger.getProjectFile(f.projectId, file1.id)!.message_id, rec.id);

  // Lazy attachment linking via attachFilesToMessage merges cleanly and updates project_file.message_id
  f.ledger.attachFilesToMessage(f.projectId, rec.id, [file2.id]);
  assert.deepEqual(JSON.parse(f.ledger.getMessage(rec.id).attachments_json!), [file1.id, file2.id]);
  assert.equal(f.ledger.getProjectFile(f.projectId, file2.id)!.message_id, rec.id);

  // Paused project records message and notifies chat cleanly
  f.ledger.setChannels(['wecom', 'weixin']);
  f.ledger.setProjectPaused(f.projectId, true, USER);
  const pausedRec = f.ledger.frontReceive({
    channel: 'weixin',
    bot: 'wx-bot',
    externalId: 'wx-ext-paused',
    actor: 'group-member-99',
    thread: 'wx-group-1',
    text: '暂停中发消息',
    material: false,
    forcedProjectId: f.projectId,
  });
  assert.equal(pausedRec.state, 'received');
  const outboxRows = f.peek<{ channel: string; payload_json: string }>('SELECT channel, payload_json FROM outbox ORDER BY rowid DESC LIMIT 1');
  assert.equal(outboxRows[0]!.channel, 'weixin');
  assert.match(outboxRows[0]!.payload_json, /项目已暂停/);
});

test('auth.decideDeviceLogin supports weixin method, temporary sessions, and IM login page hints', (t) => {
  const f = fixture(t);
  let clock = Date.parse('2026-11-22T00:00:00.000Z');
  const auth = createAuth({
    ledger: f.ledger,
    linkTtlMs: tuned('login.linkTtlMs'),
    sessionDays: tuned('login.sessionDays'),
    temporarySessionMs: tuned('login.temporarySessionMs'),
    now: () => clock,
  });

  // Temporary weixin login: approved with method 'weixin', not refreshed by maybeRefreshSession
  const reqTemp = auth.createDeviceLogin(false, 'Chrome/120 Windows')!;
  const decidedTemp = auth.decideDeviceLogin(reqTemp.code, true, { actor: 'wx-owner' }, true, 'weixin');
  assert.ok(decidedTemp);
  const collectedTemp = auth.deviceLogin(reqTemp.credential, false);
  assert.equal(collectedTemp.state, 'approved');
  const tempCookie = collectedTemp.cookie.split(';')[0]!;
  const tempSession = auth.authenticate(tempCookie, false)!;
  assert.equal(tempSession.method, 'weixin');

  // Advance clock by 2 hours; temporary session is NOT extended even if we move past 1 day?
  // Wait: temporarySessionMs default is 12h, so test with 2h advance + check isTemporary prevents refresh
  // Better: set clock forward 2h with sessionDays=30 -> targetMs - deadline >= 29d > 1d, so a non-temporary session WOULD refresh, while temporary MUST NOT!
  clock += 2 * ONE_HOUR;
  assert.equal(auth.maybeRefreshSession(tempCookie, tempSession, false), undefined, 'temporary weixin session must not sliding-refresh');

  // Full-duration weixin login: sliding refresh works after > 1 day
  const reqFull = auth.createDeviceLogin(false, 'Safari/17 iPhone')!;
  assert.ok(auth.decideDeviceLogin(reqFull.code, true, { actor: 'wx-owner' }, false, 'weixin'));
  const collectedFull = auth.deviceLogin(reqFull.credential, false);
  assert.equal(collectedFull.state, 'approved');
  const fullCookie = collectedFull.cookie.split(';')[0]!;
  const fullSession = auth.authenticate(fullCookie, false)!;
  assert.equal(fullSession.method, 'weixin');
  clock += 2 * ONE_DAY;
  assert.ok(auth.maybeRefreshSession(fullCookie, fullSession, false), 'non-temporary weixin session refreshes normally');

  // Login page hints remain backward-compatible and support weixin / both
  assert.match(waitDeviceLoginPage(reqFull, true), /企业微信里私聊机器人发：登录/);
  assert.match(waitDeviceLoginPage(reqFull, { weixin: true }), /微信里私聊机器人发：登录/);
  assert.match(waitDeviceLoginPage(reqFull, { wecom: true, weixin: true }), /企业微信或微信里私聊机器人发：登录/);
  assert.doesNotMatch(waitDeviceLoginPage(reqFull, false), /私聊机器人发：登录/);
  assert.match(enterPage({ weixin: true }), /微信里私聊机器人发‘登录’/);
  assert.match(deadLinkPage({ wecom: true, weixin: true }), /企业微信或微信里私聊机器人发‘登录’/);
});

test('inbound_source and trigger_rule persist broadcast_groups and broadcast_group_ids into trigger_fire', (t) => {
  const f = fixture(t);
  const now = new Date('2030-01-01T00:00:00.000Z');
  const g1 = f.ledger.createImGroupBinding({ channel: 'wecom', chat_id: 'bc-1', project_id: f.projectId }, USER);

  // Trigger rule with broadcast_groups
  const trig = f.ledger.createTrigger(f.projectId, {
    name: '定时播报',
    instruction: '汇报状态',
    schedule: { kind: 'once', at: new Date(now.getTime() + 60_000).toISOString() },
    broadcast_groups: true,
    broadcast_group_ids: [g1.id],
  }, USER, now);
  assert.equal(trig.broadcast_groups, true);
  assert.deepEqual(trig.broadcast_group_ids, [g1.id]);

  // Update trigger rule broadcast_group_ids
  const trigUpdated = f.ledger.updateTrigger(trig.id, { broadcast_group_ids: [] }, USER, now);
  assert.equal(trigUpdated.broadcast_groups, true);
  assert.deepEqual(trigUpdated.broadcast_group_ids, []);

  f.ledger.fireDue(new Date(now.getTime() + 65_000));
  const [trigFire] = f.ledger.listTriggerFires({ triggerId: trig.id, limit: 10 });
  assert.ok(trigFire);
  assert.equal(trigFire.broadcast_groups, true);
  assert.deepEqual(trigFire.broadcast_group_ids, []);
  const byMsg = f.ledger.triggerFireOfMessage(trigFire.message_id!);
  assert.ok(byMsg);
  assert.equal(byMsg.broadcast_groups, 1);
  assert.deepEqual(byMsg.broadcast_group_ids, []);

  // Inbound source with broadcast_groups
  const src = f.ledger.createInboundSource({
    name: '告警源',
    kind: 'tycho-v1',
    project_ids: [f.projectId],
    broadcast_groups: true,
    broadcast_group_ids: [g1.id],
  }, USER, now);
  assert.equal(src.broadcast_groups, true);
  assert.deepEqual(src.broadcast_group_ids, [g1.id]);
  f.ledger.issueInboundKey(src.id, 'key-1', USER, now);

  const srcUpdated = f.ledger.updateInboundSource(src.id, { broadcast_groups: true, broadcast_group_ids: [g1.id] }, USER, now);
  assert.deepEqual(srcUpdated.broadcast_group_ids, [g1.id]);

  const body = Buffer.from(JSON.stringify({ alert: 'cpu' }));
  const res = f.ledger.receiveInbound({
    sourceId: src.id,
    keyId: 'key-1',
    body,
    verdict: {
      status: 'events',
      eventIdSigned: true,
      events: [{ eventId: 'ev-bc-1', projectId: f.projectId, data: { alert: 'cpu' } }],
    },
  }, now);
  assert.equal(res?.status, 'accepted');
  const receipt = res.status === 'accepted' ? res.receipts[0]! : undefined;
  assert.equal(receipt?.status, 'accepted');
  const inboundFire = receipt?.status === 'accepted' ? f.ledger.triggerFireOfMessage(receipt.message_id!) : undefined;
  assert.ok(inboundFire);
  assert.equal(inboundFire.broadcast_groups, 1);
  assert.deepEqual(inboundFire.broadcast_group_ids, [g1.id]);
});

test('settings group 消息通道 holds wecom and 6 im.* channel permission defaults', () => {
  assert.equal(SETTINGS['wecom.botId'].group, '消息通道');
  assert.equal(SETTINGS['wecom.owner'].group, '消息通道');
  assert.equal(SETTINGS['wecom.url'].group, '消息通道');
  assert.equal(SETTINGS['im.wecom.chat'].group, '消息通道');
  assert.equal(SETTINGS['im.wecom.chat'].default, true);
  assert.equal(SETTINGS['im.wecom.notify'].default, true);
  assert.equal(SETTINGS['im.wecom.approveLogin'].default, true);
  assert.equal(SETTINGS['im.weixin.chat'].default, true);
  assert.equal(SETTINGS['im.weixin.notify'].default, false);
  assert.equal(SETTINGS['im.weixin.approveLogin'].default, true);
});
