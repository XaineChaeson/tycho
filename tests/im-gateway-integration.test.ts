import './guard.ts';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWecom } from '../channels/wecom.ts';
import { createAuth } from '../service/auth.ts';
import { createImGateway, downloadWecomMedia } from '../service/im-gateway.ts';
import { createNotify } from '../service/notify.ts';
import { readProjectFileBytes } from '../service/project-files.ts';
import { createTools } from '../service/tools.ts';
import { createWeixin } from '../service/weixin.ts';
import type { ImChannelPermissions } from '../shared/im.ts';
import { consoleApp } from './console-helpers.ts';
import { fixture, tuned, USER } from './helpers.ts';
import { startGateway } from './wecom-gateway.mjs';

// Valid 1x1 transparent PNG bytes.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

const WX_AUTH = {
  token: 'private-test-token',
  botId: 'wx-bot-1',
  userId: 'wx-owner',
  baseUrl: 'https://ilinkai.weixin.qq.com',
};

const wxMsg = (id: string, text: string, from = WX_AUTH.userId) => ({
  message_id: id,
  from_user_id: from,
  message_type: 1,
  message_state: 2,
  context_token: `ctx-${id}`,
  item_list: [{ type: 1, text_item: { text } }],
});

test('Weixin device login approval, ephemeral direct login link, join decision, and permission toggles', async (t) => {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'weixin']);
  f.ledger.setWhitelist({ weixin: [WX_AUTH.userId] }, USER);

  const auth = createAuth({
    ledger: f.ledger,
    linkTtlMs: tuned('login.linkTtlMs'),
    sessionDays: tuned('login.sessionDays'),
    temporarySessionMs: tuned('login.temporarySessionMs'),
  });

  const logs: string[] = [];
  let failNextSend = false;
  const sentDirect: { to: string; text: string; context: string; id: string }[] = [];
  const api = {
    qr: async () => ({ qrcode: 'qr-1', content: 'https://example.test/qr' }),
    qrStatus: async () => ({
      status: 'confirmed',
      bot_token: WX_AUTH.token,
      ilink_bot_id: WX_AUTH.botId,
      ilink_user_id: WX_AUTH.userId,
      baseurl: WX_AUTH.baseUrl,
    }),
    updates: async () => {
      throw new Error('not polling');
    },
    send: async (_auth: unknown, to: string, text: string, context: string, id: string) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error(`transport echoed body: ${text}`);
      }
      sentDirect.push({ to, text, context, id });
    },
  };

  let perms: ImChannelPermissions = { chat: true, notify: false, approve_login: true };
  let publicUrl = 'https://tycho.example';
  const kicked: string[] = [];
  const secretLinks: string[] = [];
  const joinDecisions: { code: string; approve: boolean; actor: string }[] = [];
  const file = join(f.dir, 'weixin.json');

  const wx = createWeixin({
    file,
    ledger: f.ledger,
    api,
    poll: false,
    publicUrl: () => publicUrl,
    loginValidity: () => auth.linkValidity(),
    createLoginUrl: () => {
      const link = `${publicUrl}/login#${auth.createLink().credential}`;
      secretLinks.push(link);
      return link;
    },
    approveDeviceLogin: (code, actor, temporary) =>
      auth.decideDeviceLogin(code, true, { actor: `weixin:${actor}` }, temporary, 'weixin'),
    decideJoin: (code, approve, actor) => {
      joinDecisions.push({ code, approve, actor });
      return {
        state: approve ? 'approved' : 'rejected',
        join: { id: 'j1', code, name: 'worker-01', hostname: 'h1', platform: 'linux', created_at: 0, expires_at: 1000 },
        ...(approve ? { machine: { id: 'm1' } as never } : {}),
      } as never;
    },
    permissions: () => perms,
    onMessage: (id) => kicked.push(id),
    onChanged: () => {},
    log: (line) => logs.push(line),
  });
  t.after(() => wx.stop());

  await wx.login();
  await wx.checkLogin();
  assert.equal(wx.status().state, 'connected');

  // 1. Device login approval (normal + temporary)
  const devNormal = auth.createDeviceLogin(true, 'Chrome/120 Windows')!;
  const devTemp = auth.createDeviceLogin(true, 'Version/17 Safari/605 iPhone')!;
  await wx.receive(
    [wxMsg('m-dev-1', `登录 ${devNormal.code}`), wxMsg('m-dev-2', `登录 ${devTemp.code} 临时`)],
    'cur-1',
  );
  assert.equal(kicked.length, 0, 'device login commands must not enter frontReceive / router');
  assert.equal(f.peek('SELECT * FROM message').length, 0);

  const collectedNormal = auth.deviceLogin(devNormal.credential, true);
  assert.equal(collectedNormal.state, 'approved');
  const collectedTemp = auth.deviceLogin(devTemp.credential, true);
  assert.equal(collectedTemp.state, 'approved');

  const devOutbox = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox ORDER BY rowid');
  assert.equal(devOutbox.length, 2);
  assert.match(devOutbox[0]!.payload_json, /已放行：Chrome · Windows/);
  assert.match(devOutbox[1]!.payload_json, /已放行：Safari · iPhone/);
  assert.match(devOutbox[1]!.payload_json, /12 小时/);

  // 2. Direct ephemeral `登录` link: sent via api.send directly, NEVER persisted in outbox or weixin.json!
  const outboxBeforeLogin = f.peek('SELECT * FROM outbox').length;
  await wx.receive([wxMsg('m-link-1', '登录')], 'cur-2');
  assert.equal(sentDirect.length, 1);
  assert.equal(secretLinks.length, 1);
  assert.ok(sentDirect[0]!.text.includes(secretLinks[0]!));
  assert.equal(f.peek('SELECT * FROM outbox').length, outboxBeforeLogin, 'login link must never enter outbox');
  const journalText = readFileSync(file, 'utf8');
  assert.equal(journalText.includes(secretLinks[0]!), false, 'login link must never be persisted to weixin.json');
  const parsedJournal = JSON.parse(journalText) as { controls: Record<string, string>; sends: Record<string, string> };
  assert.equal(Object.keys(parsedJournal.controls).length, 0, 'login link must not touch journal controls');
  assert.equal(Object.keys(parsedJournal.sends).length, 0, 'direct send must not touch journal sends');

  // 3. Machine join command via Weixin
  await wx.receive([wxMsg('m-join-1', '放行 654321')], 'cur-3');
  assert.deepEqual(joinDecisions, [{ code: '654321', approve: true, actor: WX_AUTH.userId }]);

  // 4. Permission toggle: approve_login = false blocks `登录`, `登录 123456`, AND `放行 654321`
  perms = { chat: true, notify: false, approve_login: false };
  const devBlocked = auth.createDeviceLogin(true, 'Chrome/120 Windows')!;
  await wx.receive(
    [wxMsg('m-blk-1', `登录 ${devBlocked.code}`), wxMsg('m-blk-2', '登录'), wxMsg('m-blk-3', '放行 112233')],
    'cur-4',
  );
  assert.equal(auth.deviceLogin(devBlocked.credential, true).state, 'pending', 'blocked device login must stay pending');
  assert.equal(sentDirect.length, 1, 'blocked direct login must not send link');
  assert.equal(joinDecisions.length, 1, 'blocked join command must not invoke decideJoin');
  const blockedNotices = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox ORDER BY rowid DESC LIMIT 3');
  assert.match(blockedNotices[0]!.payload_json, /未开启控制台放行权限/);
  assert.match(blockedNotices[1]!.payload_json, /未开启控制台放行权限/);
  assert.match(blockedNotices[2]!.payload_json, /未开启控制台放行权限/);

  // 4b. When direct login link send fails, the credential URL must NEVER be written to logs
  perms = { chat: true, notify: false, approve_login: true };
  failNextSend = true;
  await wx.receive([wxMsg('m-link-fail', '登录')], 'cur-4b');
  assert.equal(secretLinks.length, 2);
  assert.ok(logs.some((line) => line.includes('微信发送登录链接失败')));
  assert.equal(logs.some((line) => line.includes(secretLinks[1]!)), false, 'failed login send must scrub URL from logs');

  // 5. Permission toggle: chat = false blocks normal project chat
  perms = { chat: false, notify: false, approve_login: true };
  await wx.receive([wxMsg('m-chat-blk', '帮我跑一下测试')], 'cur-5');
  assert.equal(kicked.length, 0);
  assert.equal(f.peek('SELECT * FROM message').length, 0);
  const chatDisabledNotice = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox ORDER BY rowid DESC LIMIT 1')[0]!;
  assert.match(chatDisabledNotice.payload_json, /未开启项目对话权限/);

  // 6. Missing publicUrl tells owner cleanly without calling createLoginUrl
  publicUrl = '';
  await wx.receive([wxMsg('m-no-pub', '登录')], 'cur-6');
  assert.equal(sentDirect.length, 1);
  const noPubNotice = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox ORDER BY rowid DESC LIMIT 1')[0]!;
  assert.match(noPubNotice.payload_json, /还没配置对外地址/);
});

test('Unified IM Gateway Fast/Slow Path: unbound fallback, non-mention drop, @mention + inline context + reply_to anchor, rules + cooldown', async (t) => {
  const f = fixture(t);
  let clock = Date.parse('2026-11-22T10:00:00.000Z');
  let downloadCalls = 0;

  const gateway = createImGateway({
    ledger: f.ledger,
    dataDir: f.dir,
    isWhitelisted: (_ch, actor) => actor === 'owner',
    downloadMedia: async () => {
      downloadCalls += 1;
      return { bytes: TINY_PNG, mime: 'image/png', name: 'pic.png' };
    },
    now: () => clock,
  });

  // 1. Unbound group returns handled=false and records ambient context into discovered groups
  const unbound = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-unbound',
    chatType: 'group',
    externalId: 'ext-u1',
    actor: 'alice',
    text: '大家好',
    mentionedBot: false,
    attachments: [],
  });
  assert.equal(unbound.handled, false);
  assert.equal(f.ledger.listDiscoveredImGroups().some((g) => g.chat_id === 'wr-unbound'), true);
  assert.equal(f.peek('SELECT * FROM message').length, 0);

  // Bind group with mention_or_rules + cooldown 60s + inline_context_count 3
  const binding = f.ledger.createImGroupBinding(
    {
      channel: 'wecom',
      chat_id: 'wr-ops',
      chat_name: '值班群',
      project_id: f.projectId,
      trigger_mode: 'mention_or_rules',
      allow_all_senders: true,
      rule_keywords: ['P0告警', '/^deploy\\s+prod/i'],
      cooldown_seconds: 60,
      inline_context_count: 3,
      accept_media: true,
    },
    USER,
  );

  // 2. Ambient non-mention message in bound group -> dropped (0 messages created, 0 downloads)
  const dropped = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-ops',
    chatType: 'group',
    externalId: 'ext-1',
    actor: 'alice',
    actorName: 'Alice',
    text: '今天发布窗口是几点？',
    mentionedBot: false,
    attachments: [{ kind: 'image', url: 'https://cdn.example.com/ambient.png', name: 'ambient.png' }],
  });
  assert.equal(dropped.handled, true);
  assert.equal(dropped.admitted, false);
  assert.equal(dropped.reason, 'no_mention_or_rule');
  assert.equal(downloadCalls, 0, 'ambient message must NOT download media');
  assert.equal(f.peek('SELECT * FROM message').length, 0, 'ambient message must NOT create ledger message');

  // 3. Rule trigger passes via keyword & links a task for reply_to anchor testing
  const rulePass = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-ops',
    chatType: 'group',
    externalId: 'ext-2',
    actor: 'bob',
    text: '收到 P0告警：支付接口 502',
    mentionedBot: false,
    attachments: [],
  });
  assert.equal(rulePass.handled, true);
  assert.equal(rulePass.admitted, true);
  assert.equal(rulePass.reason, 'rule');
  assert.equal(rulePass.matchedKeyword, 'P0告警');
  assert.equal(rulePass.binding.id, binding.id);

  // Create a task tied to ext-2's message so ext-4 replying to ext-2 anchors the task ID!
  const task = f.ledger.createTask(
    { roleId: 'implement', projectId: f.projectId, title: '排查502', goal: '定位支付502', acceptance: '恢复正常' },
    { actor: 'router', messageId: rulePass.received.id },
  );

  // 4. Another rule match within 60s cooldown is suppressed
  clock += 15_000;
  const cooled = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-ops',
    chatType: 'group',
    externalId: 'ext-3',
    actor: 'bob',
    text: 'DEPLOY prod immediately',
    mentionedBot: false,
    attachments: [],
  });
  assert.equal(cooled.handled, true);
  assert.equal(cooled.admitted, false);
  assert.equal(cooled.reason, 'cooldown');

  // 5. @mention still passes during cooldown, includes inline context + reply_to anchor with task_id
  clock += 5_000;
  const mentioned = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-ops',
    chatType: 'group',
    externalId: 'ext-4',
    actor: 'carol',
    text: '请重点查一下上面这条告警的日志',
    mentionedBot: true,
    replyToExternalId: 'ext-2',
    attachments: [],
  });
  assert.equal(mentioned.handled, true);
  assert.equal(mentioned.admitted, true);
  assert.equal(mentioned.reason, 'mention');

  const stored = f.ledger.getMessage(mentioned.received.id);
  assert.equal(stored.project_id, f.projectId);
  assert.equal(stored.reply_to_external_id, 'ext-2');
  assert.match(stored.text, /值班群 \(wr-ops\)/);
  assert.match(stored.text, /@提及/);
  assert.match(stored.text, new RegExp(`ext_id=ext-2.*msg_id=${rulePass.received.id}.*task_id=${task.id}`));
  assert.match(stored.text, /ext_id=ext-1/);
  assert.match(stored.text, /read_group_context/);
});

test('downloadWecomMedia SSRF guard + AES-256-CBC decryption, and Lazy Multimodal Media Ingest', async (t) => {
  const f = fixture(t);

  // 1. SSRF / protocol / non-public IPv6 / redirect / DNS-rebinding checks
  await assert.rejects(
    () => downloadWecomMedia({ kind: 'image', url: 'http://cdn.example.com/a.png' }),
    /HTTPS/,
  );
  for (const badUrl of [
    'https://127.0.0.1/secret.png',
    'https://localhost/secret.png',
    'https://192.168.1.10/secret.png',
    'https://10.0.0.5/secret.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/secret.png',
    'https://[::127.0.0.1]/secret.png',
    'https://[::7f00:1]/secret.png',
    'https://[::ffff:127.0.0.1]/secret.png',
    'https://[::ffff:0:127.0.0.1]/secret.png',
    'https://[64:ff9b::127.0.0.1]/secret.png',
    'https://[64:ff9b:1::1]/secret.png',
    'https://[2002:7f00:1::1]/secret.png',
    'https://[fc00::1]/secret.png',
    'https://[fe80::1]/secret.png',
    'https://[ff02::1]/secret.png',
    'https://[100::1]/secret.png',
    'https://[2001:db8::1]/secret.png',
  ]) {
    await assert.rejects(
      () => downloadWecomMedia({ kind: 'image', url: badUrl }),
      /回环或内网/,
      `should reject ${badUrl}`,
    );
  }

  // Redirects are refused with redirect: 'error'
  let observedRedirect: string | undefined;
  await assert.rejects(
    () =>
      downloadWecomMedia(
        { kind: 'image', url: 'https://qyapi.weixin.qq.com/media/redir' },
        {
          fetchImpl: (async (_input, init) => {
            observedRedirect = init?.redirect;
            return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
          }) as typeof fetch,
        },
      ),
    /重定向/,
  );
  assert.equal(observedRedirect, 'error');

  // DNS resolution returning a private IP is rejected inside pinned https lookup before connecting
  await assert.rejects(
    () =>
      downloadWecomMedia(
        { kind: 'image', url: 'https://rebind.example.com/media/1' },
        {
          lookupImpl: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ],
        },
      ),
    /回环或内网/,
  );

  // 2. AES-256-CBC encryption -> downloadWecomMedia decrypts + sniffs PNG
  const aesKeyBuf = randomBytes(32);
  const iv = aesKeyBuf.subarray(0, 16);
  const cipher = createCipheriv('aes-256-cbc', aesKeyBuf, iv);
  const encryptedPng = Buffer.concat([cipher.update(TINY_PNG), cipher.final()]);
  // Test WeCom style base64 without trailing '=' padding
  const aesKeyBase64NoPad = aesKeyBuf.toString('base64').replace(/=+$/, '');

  let fetchCalls = 0;
  const mockFetch = (async (input: string | URL | Request) => {
    fetchCalls += 1;
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (urlStr.includes('broken.png')) {
      return new Response('not found', { status: 404 });
    }
    return new Response(new Uint8Array(encryptedPng), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }) as typeof fetch;

  const directDecrypted = await downloadWecomMedia(
    { kind: 'image', url: 'https://qyapi.weixin.qq.com/media/12345', aes_key: aesKeyBase64NoPad },
    { fetchImpl: mockFetch },
  );
  assert.deepEqual(directDecrypted.bytes, TINY_PNG);
  assert.equal(directDecrypted.mime, 'image/png');
  assert.match(directDecrypted.name, /\.png$/);
  assert.equal(fetchCalls, 1);

  // 3. Lazy multimodal ingest: user sends image first (NOT downloaded), then @bot "看看上面那张图" -> downloaded & linked!
  f.ledger.createImGroupBinding(
    {
      channel: 'wecom',
      chat_id: 'wr-design',
      chat_name: '设计群',
      project_id: f.projectId,
      trigger_mode: 'mention_only',
      allow_all_senders: true,
      accept_media: true,
    },
    USER,
  );

  const gateway = createImGateway({
    ledger: f.ledger,
    dataDir: f.dir,
    isWhitelisted: () => true,
    downloadMedia: (_ch, ref) => downloadWecomMedia(ref, { fetchImpl: mockFetch }),
    log: () => {},
  });

  fetchCalls = 0;
  const step1 = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-design',
    chatType: 'group',
    externalId: 'img-msg-1',
    actor: 'designer',
    text: '',
    mentionedBot: false,
    attachments: [
      {
        kind: 'image',
        url: 'https://qyapi.weixin.qq.com/media/design-draft',
        aes_key: aesKeyBase64NoPad,
        name: 'mockup',
      },
    ],
  });
  assert.equal(step1.handled, true);
  assert.equal(step1.admitted, false);
  assert.equal(fetchCalls, 0, 'ambient image must NOT trigger download');
  assert.equal(f.ledger.listProjectFiles(f.projectId).length, 0);

  // Follow-up @mention from same actor within 3 minutes triggers lazy download!
  const step2 = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-design',
    chatType: 'group',
    externalId: 'ask-msg-2',
    actor: 'designer',
    text: '看看上面那张图有什么问题',
    mentionedBot: true,
    attachments: [],
  });
  assert.equal(step2.handled, true);
  assert.equal(step2.admitted, true);
  assert.equal(fetchCalls, 1, 'lazy download should execute exactly once when @mentioned');
  assert.equal(step2.uploadedFileIds.length, 1);

  const fileId = step2.uploadedFileIds[0]!;
  const projectFile = f.ledger.getProjectFile(f.projectId, fileId);
  assert.ok(projectFile);
  assert.equal(projectFile.mime, 'image/png');
  assert.equal(projectFile.kind, 'upload');
  assert.equal(projectFile.message_id, step2.received.id);
  assert.deepEqual(readProjectFileBytes(f.dir, f.projectId, fileId), TINY_PNG);

  const linkedMessage = f.ledger.getMessage(step2.received.id);
  assert.deepEqual(JSON.parse(linkedMessage.attachments_json!), [fileId]);

  // 4. Single-file download failure appends failure note without dropping the message
  const step3 = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-design',
    chatType: 'group',
    externalId: 'ask-msg-3',
    actor: 'designer',
    text: '顺便看下这个坏链',
    mentionedBot: true,
    attachments: [{ kind: 'image', url: 'https://qyapi.weixin.qq.com/media/broken.png', name: 'broken.png' }],
  });
  assert.equal(step3.handled, true);
  assert.equal(step3.admitted, true);
  assert.equal(step3.uploadedFileIds.length, 0);
  assert.match(f.ledger.getMessage(step3.received.id).text, /\[附件下载失败: broken\.png\]/);

  // 5. In-flight deduplication: concurrent callbacks for the same externalId only download once
  let concurrentDownloads = 0;
  let releaseDownload!: () => void;
  const slowGateway = createImGateway({
    ledger: f.ledger,
    dataDir: f.dir,
    isWhitelisted: () => true,
    downloadMedia: async () => {
      concurrentDownloads += 1;
      await new Promise<void>((resolve) => {
        releaseDownload = resolve;
      });
      return { bytes: TINY_PNG, mime: 'image/png', name: 'dup.png' };
    },
    log: () => {},
  });
  const dupMsg = {
    channel: 'wecom' as const,
    botId: 'bot-1',
    chatId: 'wr-design',
    chatType: 'group' as const,
    externalId: 'concurrent-msg-1',
    actor: 'designer',
    text: '并发测试',
    mentionedBot: true,
    attachments: [{ kind: 'image' as const, url: 'https://qyapi.weixin.qq.com/media/dup.png', name: 'dup.png' }],
  };
  const pA = slowGateway.ingestGroupMessage(dupMsg);
  const pB = slowGateway.ingestGroupMessage(dupMsg);
  releaseDownload();
  const [resA, resB] = await Promise.all([pA, pB]);
  assert.equal(concurrentDownloads, 1, 'concurrent duplicate deliveries must share in-flight work');
  assert.equal(resA.handled && resA.admitted, true);
  assert.equal(resB.handled && resB.admitted, true);
  assert.equal(resA.handled && resA.admitted ? resA.received.id : '', resB.handled && resB.admitted ? resB.received.id : '');

  // 6. Project writability guard: non-writable project returns handled=true, admitted=false, reason='disabled' cleanly
  let roDownloads = 0;
  const roLedger = Object.assign(Object.create(Object.getPrototypeOf(f.ledger)), f.ledger, {
    mayWriteProject: () => false,
  });
  const roGateway = createImGateway({
    ledger: roLedger,
    dataDir: f.dir,
    isWhitelisted: () => true,
    downloadMedia: async () => {
      roDownloads += 1;
      return { bytes: TINY_PNG, mime: 'image/png', name: 'ro.png' };
    },
  });
  const roRes = await roGateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-design',
    chatType: 'group',
    externalId: 'ro-msg-1',
    actor: 'designer',
    text: '只读项目消息',
    mentionedBot: true,
    attachments: [{ kind: 'image', url: 'https://qyapi.weixin.qq.com/media/ro.png', name: 'ro.png' }],
  });
  assert.equal(roRes.handled, true);
  assert.equal(roRes.admitted, false);
  if (roRes.handled && !roRes.admitted) assert.equal(roRes.reason, 'disabled');
  assert.equal(roDownloads, 0, 'non-writable project must not download media');
});

test('Lead MCP tool read_group_context returns chronological messages + linked_task_ids and blocks cross-project access', async (t) => {
  const f = fixture(t);
  const otherProjectId = f.ledger.createProject({ name: '其他项目' }, USER);

  const bindingA = f.ledger.createImGroupBinding(
    { channel: 'wecom', chat_id: 'wr-proj-a', chat_name: '项目A群', project_id: f.projectId, allow_all_senders: true },
    USER,
  );
  f.ledger.createImGroupBinding(
    { channel: 'wecom', chat_id: 'wr-proj-b', chat_name: '项目B群', project_id: otherProjectId, allow_all_senders: true },
    USER,
  );

  const gateway = createImGateway({
    ledger: f.ledger,
    dataDir: f.dir,
    isWhitelisted: () => true,
  });

  await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-proj-a',
    chatType: 'group',
    externalId: 'a-1',
    actor: 'u1',
    text: '第一条闲聊',
    mentionedBot: false,
    attachments: [
      {
        kind: 'image',
        name: 'trace.png',
        mime: 'image/png',
        size: 123,
        url: 'https://qyapi.weixin.qq.com/secret-download?sig=123',
        aes_key: 'SECRET_AES_KEY_XYZ',
      },
    ],
  });
  const admitted = await gateway.ingestGroupMessage({
    channel: 'wecom',
    botId: 'bot-1',
    chatId: 'wr-proj-a',
    chatType: 'group',
    externalId: 'a-2',
    actor: 'u2',
    text: '帮我修登录 bug',
    mentionedBot: true,
    attachments: [],
  });
  assert.equal(admitted.handled && admitted.admitted, true);
  const task = f.ledger.createTask(
    { roleId: 'implement', projectId: f.projectId, title: '修登录bug', goal: '修复登录', acceptance: '通过测试' },
    { actor: 'router', messageId: admitted.handled && admitted.admitted ? admitted.received.id : '' },
  );

  const tools = createTools({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: { interrupt: async () => 'stopped', events: () => [], abandon: async () => {} } as never,
    logins: { get: () => undefined, list: () => [] } as never,
    machines: { list: () => [] },
    accept: {} as never,
  });

  // Valid call from owning project
  const okRes = await tools.call(
    'read_group_context',
    { limit: 10 },
    { actor: 'router' },
    { projectId: f.projectId },
  );
  assert.notEqual(okRes.isError, true);
  const rawToolText = okRes.content[0]!.text;
  assert.equal(rawToolText.includes('aes_key'), false, 'read_group_context must never leak aes_key');
  assert.equal(rawToolText.includes('secret-download'), false, 'read_group_context must never leak signed url');
  const payload = JSON.parse(rawToolText) as {
    binding: { chat_id: string };
    items: Array<{ external_id: string; message_id: string | null; project_id: string | null; attachments: Array<Record<string, unknown>>; linked_task_ids: string[] }>;
    next_before_id: string | null;
  };
  assert.equal(payload.binding.chat_id, 'wr-proj-a');
  assert.deepEqual(payload.items.map((i) => i.external_id), ['a-1', 'a-2']);
  assert.deepEqual(payload.items[0]!.attachments, [{ kind: 'image', name: 'trace.png', mime: 'image/png', size: 123 }]);
  assert.deepEqual(payload.items[1]!.linked_task_ids, [task.id]);

  // Cross-project isolation: project B must be refused when asking for project A's chat_id
  const blockedRes = await tools.call(
    'read_group_context',
    { chat_id: 'wr-proj-a' },
    { actor: 'router' },
    { projectId: otherProjectId },
  );
  assert.equal(blockedRes.isError, true);
  assert.match(blockedRes.content[0]!.text, /无权/);

  // Rebind wr-proj-a to otherProjectId -> project A's message_id/project_id/linked_task_ids must be nulled
  f.ledger.updateImGroupBinding(bindingA.id, { project_id: otherProjectId }, USER);
  const reboundRes = await tools.call(
    'read_group_context',
    { chat_id: 'wr-proj-a' },
    { actor: 'router' },
    { projectId: otherProjectId },
  );
  assert.notEqual(reboundRes.isError, true);
  const reboundPayload = JSON.parse(reboundRes.content[0]!.text) as {
    items: Array<{ external_id: string; message_id: string | null; project_id: string | null; linked_task_ids: string[] }>;
  };
  const reboundA2 = reboundPayload.items.find((i) => i.external_id === 'a-2')!;
  assert.equal(reboundA2.message_id, null);
  assert.equal(reboundA2.project_id, null);
  assert.deepEqual(reboundA2.linked_task_ids, []);
});

test('Inbound source & trigger broadcast_groups enqueues chat_type=2 group outbox without duplicating to owner DM', (t) => {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'wecom', 'weixin']);
  const now = new Date('2030-01-01T00:00:00.000Z');

  const g1 = f.ledger.createImGroupBinding(
    {
      channel: 'wecom',
      chat_id: 'wr-alert-group',
      chat_name: '生产告警群',
      project_id: f.projectId,
      notify_events: true,
    },
    USER,
  );
  // Disabled or notify_events=false group must NOT receive broadcasts
  f.ledger.createImGroupBinding(
    {
      channel: 'wecom',
      chat_id: 'wr-muted-group',
      chat_name: '静音群',
      project_id: f.projectId,
      notify_events: false,
    },
    USER,
  );

  const src = f.ledger.createInboundSource(
    {
      name: 'Prometheus 告警',
      kind: 'tycho-v1',
      project_ids: [f.projectId],
      push_final: false,
      broadcast_groups: true,
      broadcast_group_ids: [g1.id],
    },
    USER,
    now,
  );
  f.ledger.issueInboundKey(src.id, 'k1', USER, now);

  const accepted = f.ledger.receiveInbound(
    {
      sourceId: src.id,
      keyId: 'k1',
      body: Buffer.from('{"alert":"high_cpu"}'),
      verdict: {
        status: 'events',
        eventIdSigned: true,
        events: [{ eventId: 'ev-cpu-1', projectId: f.projectId, data: { alert: 'high_cpu' } }],
      },
    },
    now,
  );
  assert.equal(accepted?.status, 'accepted');
  const receipt = accepted.status === 'accepted' ? accepted.receipts[0]! : undefined;
  assert.equal(receipt?.status, 'accepted');
  const inboundMsg = f.ledger.getMessage(receipt!.status === 'accepted' ? receipt!.message_id! : '');

  const notify = createNotify({
    ledger: f.ledger,
    owner: () => 'owner-userid',
    direct: async () => {},
  });

  // 1. finalReply broadcasts ONLY to the bound group (chat_type: 2), NOT to owner DM (push_final is false)
  notify.finalReply(inboundMsg, { ...inboundMsg, direction: 'out', text: 'CPU 飙升已定位并扩容恢复。' });

  const outboxRows = f.peek<{ channel: string; kind: string; payload_json: string }>(
    'SELECT channel, kind, payload_json FROM outbox ORDER BY rowid',
  );
  assert.equal(outboxRows.length, 1, 'must enqueue exactly 1 group broadcast and 0 owner DMs');
  const payload = JSON.parse(outboxRows[0]!.payload_json) as {
    external_id: string;
    target: { chatid: string; chat_type: number };
    content: string;
  };
  assert.equal(outboxRows[0]!.channel, 'wecom');
  assert.deepEqual(payload.target, { chatid: 'wr-alert-group', chat_type: 2 });
  assert.equal(payload.external_id, `trigger-group:${inboundMsg.id}:wecom:wr-alert-group`);
  assert.match(payload.content, /Prometheus 告警/);
  assert.match(payload.content, /CPU 飙升已定位并扩容恢复/);

  // 2. unverified also broadcasts to bound groups when broadcast_groups=1
  const accepted2 = f.ledger.receiveInbound(
    {
      sourceId: src.id,
      keyId: 'k1',
      body: Buffer.from('{"alert":"oom"}'),
      verdict: {
        status: 'events',
        eventIdSigned: true,
        events: [{ eventId: 'ev-oom-2', projectId: f.projectId, data: { alert: 'oom' } }],
      },
    },
    now,
  );
  const receipt2 = accepted2?.status === 'accepted' ? accepted2.receipts[0]! : undefined;
  const inboundMsg2 = f.ledger.getMessage(receipt2?.status === 'accepted' ? receipt2.message_id! : '');
  notify.unverified(inboundMsg2);

  const afterUnverified = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox ORDER BY rowid');
  assert.equal(afterUnverified.length, 2);
  const payload2 = JSON.parse(afterUnverified[1]!.payload_json) as {
    target: { chatid: string; chat_type: number };
    content: string;
  };
  assert.deepEqual(payload2.target, { chatid: 'wr-alert-group', chat_type: 2 });
  assert.match(payload2.content, /未确认完成/);
});

test('HTTP API CRUD for /api/im/groups, /api/projects/:id/groups, broadcast fields, and Weixin login page hints', async (t) => {
  const app = await consoleApp(t, {
    channels: () => ({ wecom: { connected: true, since: null, error: null }, weixin: { state: 'connected' } }),
  });

  // Record an unbound group so `discovered` is populated
  app.f.ledger.recordImGroupContext({
    channel: 'wecom',
    chatId: 'wr-discovered',
    externalId: 'd-1',
    actor: 'u1',
    text: '待绑定群消息',
    mentionedBot: false,
  });

  // GET /api/im/groups
  const listBefore = await app.get('/api/im/groups');
  assert.equal(listBefore.status, 200);
  const listBeforeBody = (await listBefore.json()) as {
    bindings: unknown[];
    discovered: Array<{ chat_id: string }>;
  };
  assert.equal(listBeforeBody.bindings.length, 0);
  assert.equal(listBeforeBody.discovered.length, 1);
  assert.equal(listBeforeBody.discovered[0]!.chat_id, 'wr-discovered');

  // POST /api/im/groups
  const createdRes = await app.post('/api/im/groups', {
    channel: 'wecom',
    chat_id: 'wr-discovered',
    chat_name: '核心研发群',
    project_id: app.f.projectId,
    trigger_mode: 'mention_or_rules',
    rule_keywords: ['线上告警'],
    cooldown_seconds: 30,
    notify_events: true,
  });
  assert.equal(createdRes.status, 201);
  const { group: created } = (await createdRes.json()) as {
    group: { id: string; chat_name: string; rule_keywords: string[] };
  };
  assert.equal(created.chat_name, '核心研发群');
  assert.deepEqual(created.rule_keywords, ['线上告警']);

  // GET /api/projects/:id/groups
  const projGroupsRes = await app.get(`/api/projects/${app.f.projectId}/groups`);
  assert.equal(projGroupsRes.status, 200);
  const projGroupsBody = (await projGroupsRes.json()) as { bindings: Array<{ id: string }> };
  assert.deepEqual(projGroupsBody.bindings.map((g) => g.id), [created.id]);

  // PUT /api/im/groups/:id
  const updatedRes = await app.send('PUT', `/api/im/groups/${created.id}`, {
    chat_name: '核心研发值班群',
    inline_context_count: 10,
  });
  assert.equal(updatedRes.status, 200);
  const { group: updated } = (await updatedRes.json()) as {
    group: { chat_name: string; inline_context_count: number };
  };
  assert.equal(updated.chat_name, '核心研发值班群');
  assert.equal(updated.inline_context_count, 10);

  // Inbound & Trigger APIs include `groups` and persist `broadcast_groups` / `broadcast_group_ids`
  const createInboundRes = await app.post('/api/inbound', {
    name: 'Sentry',
    kind: 'tycho-v1',
    project_ids: [app.f.projectId],
    broadcast_groups: true,
    broadcast_group_ids: [created.id],
  });
  assert.equal(createInboundRes.status, 201);
  const inboundPageRes = await app.get('/api/inbound');
  const inboundPageBody = (await inboundPageRes.json()) as {
    sources: Array<{ broadcast_groups: boolean; broadcast_group_ids: string[] }>;
    groups: Array<{ id: string; chat_name: string }>;
  };
  assert.equal(inboundPageBody.sources[0]!.broadcast_groups, true);
  assert.deepEqual(inboundPageBody.sources[0]!.broadcast_group_ids, [created.id]);
  assert.equal(inboundPageBody.groups[0]!.id, created.id);

  const createTrigRes = await app.post(`/api/projects/${app.f.projectId}/triggers`, {
    name: '日报',
    instruction: '汇总进展',
    schedule: { kind: 'once', at: '2035-01-01T09:00:00+08:00' },
    broadcast_groups: true,
    broadcast_group_ids: [created.id],
  });
  assert.equal(createTrigRes.status, 201);
  const trigPageRes = await app.get(`/api/projects/${app.f.projectId}/triggers`);
  const trigPageBody = (await trigPageRes.json()) as {
    triggers: Array<{ broadcast_groups: boolean; broadcast_group_ids: string[] }>;
    groups: Array<{ id: string }>;
  };
  assert.equal(trigPageBody.triggers[0]!.broadcast_groups, true);
  assert.deepEqual(trigPageBody.triggers[0]!.broadcast_group_ids, [created.id]);
  assert.equal(trigPageBody.groups[0]!.id, created.id);

  // Login page reflects both WeCom and connected Weixin when approveLogin settings are enabled
  const loginHtml = await (await fetch(`http://127.0.0.1:${app.port}/login`)).text();
  assert.match(loginHtml, /企业微信或微信/);

  // Turning off im.weixin.approveLogin hides Weixin from login page hints; turning off both hides IM hints completely
  await app.send('PUT', '/api/settings/im.weixin.approveLogin', { value: false });
  const loginHtmlWecomOnly = await (await fetch(`http://127.0.0.1:${app.port}/login`)).text();
  assert.match(loginHtmlWecomOnly, /请私聊机器人发‘登录’/);
  assert.doesNotMatch(loginHtmlWecomOnly, /企业微信或微信/);
  await app.send('PUT', '/api/settings/im.wecom.approveLogin', { value: false });
  const loginHtmlNone = await (await fetch(`http://127.0.0.1:${app.port}/login`)).text();
  assert.doesNotMatch(loginHtmlNone, /私聊机器人/);

  // DELETE /api/im/groups/:id
  const delRes = await app.send('DELETE', `/api/im/groups/${created.id}`);
  assert.equal(delRes.status, 200);
  const afterDel = (await (await app.get('/api/im/groups')).json()) as { bindings: unknown[] };
  assert.equal(afterDel.bindings.length, 0);
});

test('WeCom channel integration: permissions enforcement, group Fast Path + unbound fallback, and DM image attachment ingest', async (t) => {
  const ws = await startGateway();
  const f = fixture(t);
  f.ledger.setWhitelist({ wecom: ['owner'] }, USER);
  f.ledger.frontReceive({ bot: 'bot-1', externalId: 'enter-0', actor: 'owner', thread: 'owner', text: '进入 试跑', material: false });

  f.ledger.createImGroupBinding(
    {
      channel: 'wecom',
      chat_id: 'wr-bound',
      chat_name: '项目绑定群',
      project_id: f.projectId,
      trigger_mode: 'mention_only',
      allow_all_senders: true,
      accept_media: true,
    },
    USER,
  );

  let perms: ImChannelPermissions = { chat: true, notify: true, approve_login: true };
  let downloaded = 0;
  const imGateway = createImGateway({
    ledger: f.ledger,
    dataDir: f.dir,
    isWhitelisted: (_ch, actor) => actor === 'owner',
    downloadMedia: async (_ch, ref) => {
      downloaded += 1;
      return { bytes: TINY_PNG, mime: 'image/png', name: ref.name ?? 'dm-image.png' };
    },
  });

  const delivered: string[] = [];
  let loginUrlCalls = 0;
  const wecom = createWecom({
    url: ws.url,
    botId: 'bot-1',
    secret: 'sec-1',
    publicUrl: () => 'https://private-tycho.example.com',
    ledger: f.ledger,
    createLoginUrl: () => {
      loginUrlCalls += 1;
      return 'https://tycho.example/login#abc';
    },
    loginValidity: () => '10 分钟',
    permissions: () => perms,
    imGateway,
    onMessage: (id) => delivered.push(id),
    log: () => {},
    firstBackoffMs: 20,
    maxBackoffMs: 80,
    streamTiming: { bodyMs: 10, statusMs: 10, timerMs: 10, ackMs: 60, retryMs: 5 },
  });
  t.after(async () => {
    wecom.stop();
    await ws.close();
  });

  wecom.start();
  await ws.until(() => wecom.status().connected, '订阅成功');

  // 1. approve_login = false blocks `登录`
  perms = { chat: true, notify: true, approve_login: false };
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-login-off' },
    body: { msgid: 'm-login-off', from: { userid: 'owner' }, chattype: 'single', msgtype: 'text', text: { content: '登录' } },
  });
  await ws.until(() => ws.sent('aibot_respond_msg').some((f) => f.headers.req_id === 'req-login-off'), '登录权限关闭回复');
  const loginReply = ws.sent('aibot_respond_msg').find((f) => f.headers.req_id === 'req-login-off')!;
  assert.match(loginReply.body.stream.content, /未开启控制台放行权限/);

  // 2. chat = false blocks single chat AND project-menu:open card callbacks
  perms = { chat: false, notify: true, approve_login: true };
  ws.inject({
    cmd: 'aibot_event_callback',
    headers: { req_id: 'req-card-chat-off' },
    body: {
      from: { userid: 'owner' },
      chattype: 'single',
      event: { eventtype: 'template_card_event', template_card_event: { event_key: 'project-menu:open', task_id: 'tycho_project_menu' } },
    },
  });
  // sendLoginLink refuses unknown/missing chattype without minting a login URL
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-login-unknown-chattype' },
    body: { msgid: 'm-login-unknown', from: { userid: 'owner' }, msgtype: 'text', text: { content: '登录' } },
  });
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-chat-off' },
    body: { msgid: 'm-chat-off', from: { userid: 'owner' }, chattype: 'single', msgtype: 'text', text: { content: '你好' } },
  });
  await ws.until(() => ws.sent('aibot_respond_msg').some((f) => f.headers.req_id === 'req-chat-off'), '对话权限关闭回复');
  const chatReply = ws.sent('aibot_respond_msg').find((f) => f.headers.req_id === 'req-chat-off')!;
  assert.match(chatReply.body.stream.content, /未开启项目对话权限/);
  assert.equal(delivered.length, 0);
  assert.equal(loginUrlCalls, 0, 'missing chattype must not mint login URL');
  assert.equal(
    ws.sent('aibot_respond_update_msg').some((f) => f.headers.req_id === 'req-card-chat-off'),
    false,
    'project-menu:open card must be ignored when perms().chat is false',
  );

  // 3. Re-enable chat: bound group non-mention is silently dropped (0 replies, 0 delivered)
  perms = { chat: true, notify: true, approve_login: true };
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-grp-drop' },
    body: {
      msgid: 'm-grp-drop',
      from: { userid: 'member-1' },
      chatid: 'wr-bound',
      chattype: 'group',
      msgtype: 'text',
      mentioned_bot: false,
      text: { content: '普通闲聊' },
    },
  });
  await ws.until(() => f.ledger.findImGroupContextByExternalId('wecom', 'wr-bound', 'm-grp-drop') !== undefined, '记录群上下文');
  assert.equal(delivered.length, 0);
  assert.equal(ws.sent('aibot_respond_msg').some((f) => f.headers.req_id === 'req-grp-drop'), false);

  // 4. Bound group @mention opens ReplyStream and delivers to project; stream drafts redact publicUrl
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-grp-hit' },
    body: {
      msgid: 'm-grp-hit',
      from: { userid: 'member-1' },
      chatid: 'wr-bound',
      chattype: 'group',
      msgtype: 'text',
      text: { content: '请帮我查日志' },
      quote: { msgid: 'm-grp-drop' },
    },
  });
  await ws.until(() => delivered.length === 1, '群消息送达');
  const groupMsgId = delivered[0]!;
  const groupStream = wecom.streamFor(groupMsgId);
  assert.ok(groupStream, 'admitted group message must open ReplyStream');
  assert.equal(f.ledger.getMessage(groupMsgId).reply_to_external_id, 'm-grp-drop');
  groupStream.update({ body: '中间草稿 https://private-tycho.example.com/#/projects/secret [在控制台打开](https://private-tycho.example.com/#/projects/secret)' });
  await ws.until(
    () => ws.streams().some((frame) => frame.reqId === 'req-grp-hit' && frame.content.includes('[私有控制台链接已隐藏]')),
    '绑定群流式草稿脱敏',
  );
  assert.equal(
    await groupStream.finish('最终结论 https://private-tycho.example.com/#/task/9\n\n[在控制台打开](https://private-tycho.example.com/#/task/9)'),
    'delivered',
  );
  for (const frame of ws.streams().filter((each) => each.reqId === 'req-grp-hit')) {
    assert.doesNotMatch(frame.content, /private-tycho\.example\.com/);
    assert.doesNotMatch(frame.content, /在控制台打开/);
  }

  // 5. Unbound group MUST NOT leak other projects via template_card: replies neutrally,
  // records the group for console discovery, and DMs the whitelisted owner privately.
  const privateProject = f.ledger.createProject({ name: '私密个人项目' }, USER);
  assert.ok(privateProject);
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-grp-unbound' },
    body: {
      msgid: 'm-grp-unbound',
      from: { userid: 'owner' },
      chatid: 'wr-not-bound',
      chattype: 'group',
      msgtype: 'text',
      text: { content: '帮我看一下' },
    },
  });
  await ws.until(
    () => ws.sent('aibot_respond_msg').some((frame) => frame.headers.req_id === 'req-grp-unbound'),
    '未绑定群收到中性提示',
  );
  const unboundReplies = ws.sent('aibot_respond_msg').filter((frame) => frame.headers.req_id === 'req-grp-unbound');
  assert.equal(unboundReplies.length, 1);
  assert.notEqual(unboundReplies[0]!.body.msgtype, 'template_card');
  const unboundText = String(unboundReplies[0]!.body.stream?.content ?? unboundReplies[0]!.body.markdown?.content ?? '');
  assert.match(unboundText, /尚未绑定项目/);
  assert.doesNotMatch(unboundText, /私密个人项目/);
  assert.ok(f.ledger.listDiscoveredImGroups().some((g) => g.chat_id === 'wr-not-bound'), '未绑定群已自动登记供控制台发现');
  await ws.until(
    () => ws.sent('aibot_send_msg').some((frame) => frame.body.chatid === 'owner' && frame.body.chat_type === 1 && String(frame.body.markdown?.content ?? '').includes('wr-not-bound')),
    '私聊通知主人去控制台绑定',
  );

  // Clicking a legacy project-menu card inside a group must wipe it with a neutral card (zero project names)
  ws.inject({
    cmd: 'aibot_event_callback',
    headers: { req_id: 'req-grp-old-menu' },
    body: {
      from: { userid: 'owner' },
      chatid: 'wr-not-bound',
      chattype: 'group',
      event: {
        eventtype: 'template_card_event',
        template_card_event: { event_key: 'menu:old123:next', task_id: 'menu_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      },
    },
  });
  await ws.until(
    () => ws.sent('aibot_respond_update_msg').some((frame) => frame.headers.req_id === 'req-grp-old-menu'),
    '旧群项目卡被中性卡片替换',
  );
  const wipedCard = ws.sent('aibot_respond_update_msg').find((frame) => frame.headers.req_id === 'req-grp-old-menu')!;
  const wipedJson = JSON.stringify(wipedCard.body);
  assert.match(wipedJson, /保护其他项目隐私/);
  assert.doesNotMatch(wipedJson, /私密个人项目/);

  // 6. Image-only DM attachment lazy ingest into current project
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-dm-img' },
    body: {
      msgid: 'm-dm-img',
      from: { userid: 'owner' },
      chattype: 'single',
      msgtype: 'image',
      image: { url: 'https://qyapi.weixin.qq.com/media/dm-1', name: 'err.png' },
    },
  });
  await ws.until(() => delivered.length === 2, '单聊图片消息送达');
  const dmMsg = f.ledger.getMessage(delivered[1]!);
  assert.equal(downloaded, 1);
  assert.equal(dmMsg.text, '[用户发送了图片/文件]');
  const dmAttachmentIds = JSON.parse(dmMsg.attachments_json!) as string[];
  assert.equal(dmAttachmentIds.length, 1);
  assert.equal(f.ledger.getProjectFile(f.projectId, dmAttachmentIds[0]!)!.name, 'err.png');

  // 7. Group chat messages and broadcasts must NEVER expose the owner's private console URL
  const notifyWithPublicUrl = createNotify({
    ledger: f.ledger,
    owner: () => 'owner',
    publicUrl: () => 'https://private-tycho.example.com',
    direct: async () => {},
  });
  const groupOutbox = f.ledger.outbox.enqueue('wecom', 'markdown', {
    external_id: 'privacy-group-reply',
    target: { chatid: 'wr-bound', chat_type: 2 },
    content: '已排查完毕，详见 https://private-tycho.example.com/#/projects/abc',
    project_id: f.projectId,
    path: `/projects/${f.projectId}`,
  });
  const dmOutbox = f.ledger.outbox.enqueue('wecom', 'markdown', {
    external_id: 'privacy-dm-reply',
    target: { chatid: 'owner', chat_type: 1 },
    content: '私聊汇报完毕',
    project_id: f.projectId,
    path: `/projects/${f.projectId}`,
  });
  const renderedGroup = notifyWithPublicUrl.render(groupOutbox)!;
  const renderedDm = notifyWithPublicUrl.render(dmOutbox)!;
  assert.equal(renderedGroup.body.msgtype, 'markdown');
  assert.doesNotMatch(renderedGroup.body.markdown.content, /private-tycho\.example\.com/);
  assert.doesNotMatch(renderedGroup.body.markdown.content, /在控制台打开/);
  assert.equal(renderedDm.body.msgtype, 'markdown');
  assert.match(renderedDm.body.markdown.content, /https:\/\/private-tycho\.example\.com/);
  assert.match(renderedDm.body.markdown.content, /在控制台打开/);
  assert.ok(wecom.streamFor(dmMsg.id), 'image-only DM with attachment should open ReplyStream');

  // 8. AUDIT-P1-07: DM mixed message with project prefix (`ProjectB: <image>`) must download attachment
  // into Project B rather than the previous current project (Project A / 试跑).
  const projectBId = f.ledger.createProject({ name: 'ProjectB' }, USER);
  const projectAFilesBefore = f.ledger.listProjectFiles(f.projectId).length;
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-dm-prefix-img' },
    body: {
      msgid: 'm-dm-prefix-img',
      from: { userid: 'owner' },
      chattype: 'single',
      msgtype: 'mixed',
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: 'ProjectB: 请看这张截图' } },
          { msgtype: 'image', image: { url: 'https://qyapi.weixin.qq.com/media/proj-b-1', name: 'proj-b.png' } },
        ],
      },
    },
  });
  await ws.until(() => delivered.length === 3, '带项目前缀的单聊图片消息送达');
  const prefixedMsg = f.ledger.getMessage(delivered[2]!);
  assert.equal(prefixedMsg.project_id, projectBId, 'message must route to ProjectB');
  assert.equal(f.ledger.listProjectFiles(f.projectId).length, projectAFilesBefore, 'Project A must NOT receive ProjectB attachment');
  const projBAttachmentIds = JSON.parse(prefixedMsg.attachments_json!) as string[];
  assert.equal(projBAttachmentIds.length, 1);
  const projBFile = f.ledger.getProjectFile(projectBId, projBAttachmentIds[0]!);
  assert.ok(projBFile, 'attachment must be stored under ProjectB');
  assert.equal(projBFile.name, 'proj-b.png');
  assert.equal(projBFile.message_id, prefixedMsg.id, 'project_file.message_id must link to the ProjectB message');

  // Non-project colon prefix falls back to current project (now ProjectB); forwarded material ignores prefix.
  ws.inject({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-dm-fwd-img' },
    body: {
      msgid: 'm-dm-fwd-img',
      from: { userid: 'owner' },
      chattype: 'single',
      msgtype: 'mixed',
      compat_info: { source: '转发' },
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: '试跑：这是转发的资料' } },
          { msgtype: 'image', image: { url: 'https://qyapi.weixin.qq.com/media/fwd-1', name: 'fwd.png' } },
        ],
      },
    },
  });
  await ws.until(() => delivered.length === 4, '转发的单聊图片消息送达');
  const fwdMsg = f.ledger.getMessage(delivered[3]!);
  assert.equal(fwdMsg.project_id, projectBId, 'forwarded material must stay in current project (ProjectB)');
  const fwdIds = JSON.parse(fwdMsg.attachments_json!) as string[];
  assert.equal(f.ledger.getProjectFile(projectBId, fwdIds[0]!)!.message_id, fwdMsg.id);
  assert.equal(f.ledger.listProjectFiles(f.projectId).length, projectAFilesBefore);
});

test('post_group_update broadcasts only to authorized project groups and strips private console links', async (t) => {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'wecom']);
  const otherProj = f.ledger.createProject({ name: '其他项目' }, USER);
  const gAllowed = f.ledger.createImGroupBinding({
    channel: 'wecom', chat_id: 'wr-ok', chat_name: '运维群', project_id: f.projectId, notify_events: true,
  }, USER);
  f.ledger.createImGroupBinding({
    channel: 'wecom', chat_id: 'wr-muted', chat_name: '静默群', project_id: f.projectId, notify_events: false,
  }, USER);
  f.ledger.createImGroupBinding({
    channel: 'wecom', chat_id: 'wr-other', chat_name: '别项目群', project_id: otherProj, notify_events: true,
  }, USER);

  const tools = createTools({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: { interrupt: async () => 'stopped', events: () => [], abandon: async () => {} } as never,
    logins: { get: () => undefined, list: () => [] } as never,
    machines: { list: () => [] },
    accept: {} as never,
  });
  const here = { projectId: f.projectId };
  const routerMsg = f.ledger.receiveMessage({
    channel: 'console', externalId: 'ext-turn-1', actor: 'user', text: '汇报一下进展', projectId: f.projectId,
  });
  const ctx = { actor: 'router', messageId: routerMsg.id };

  // Calling without chat_id broadcasts only to notify_events=true groups of this project
  const ok = await tools.call('post_group_update', { content: '根因已确认：上游未推 Status 字段，已放行水位。' }, ctx, here);
  assert.equal(ok.isError, undefined);
  const parsed = JSON.parse(ok.content[0]!.text) as { sent: { channel: string; chat_id: string }[] };
  assert.deepEqual(parsed.sent.map((s) => s.chat_id), [gAllowed.chat_id]);

  // Refuses muted group and foreign project group
  const refusedMuted = await tools.call('post_group_update', { content: 'hi', chat_id: 'wr-muted' }, ctx, here);
  assert.equal(refusedMuted.isError, true);
  const refusedOther = await tools.call('post_group_update', { content: 'hi', chat_id: 'wr-other' }, ctx, here);
  assert.equal(refusedOther.isError, true);

  // Rendered group payload never contains private console URL
  const notify = createNotify({
    ledger: f.ledger,
    owner: () => 'owner-userid',
    publicUrl: () => 'https://private.example.com',
    direct: async () => {},
  });
  const rows = f.ledger.outbox.takeDue(new Date('2999-01-01'));
  const groupRow = rows.find((r) => JSON.parse(r.payload_json).target?.chatid === 'wr-ok')!;
  const rendered = notify.render(groupRow)!;
  assert.equal(rendered.target.chat_type, 2);
  assert.equal(rendered.body.msgtype, 'markdown');
  assert.ok(!rendered.body.markdown.content.includes('private.example.com'), 'group broadcast must never include private console URL');
  assert.match(rendered.body.markdown.content, /根因已确认/);
});

test('automatic closure broadcast routes inbound-derived and group-mention-derived task conclusions back to originating group with dedup', async (t) => {
  const f = fixture(t);
  f.ledger.setChannels(['console', 'wecom']);
  const group = f.ledger.createImGroupBinding({
    channel: 'wecom', chat_id: 'wr-prod-ops', chat_name: '生产运维群', project_id: f.projectId, notify_events: true,
  }, USER);
  const notify = createNotify({
    ledger: f.ledger,
    owner: () => 'owner-userid',
    publicUrl: () => 'https://private.example.com',
    direct: async () => {},
  });

  // 1. Inbound source with broadcast_groups=1 -> creates a task -> task finishes -> conclusion auto-broadcasts back to group
  const now = new Date('2026-11-24T12:00:00Z');
  const src = f.ledger.createInboundSource({
    name: 'DM-生产播报',
    kind: 'tycho-v1',
    project_ids: [f.projectId],
    push_final: false,
    broadcast_groups: true,
    broadcast_group_ids: [group.id],
  }, USER, now);
  f.ledger.issueInboundKey(src.id, 'k1', USER, now);
  const acc = f.ledger.receiveInbound({
    sourceId: src.id,
    keyId: 'k1',
    body: Buffer.from('{"alert":"reconcile"}'),
    verdict: { status: 'events', eventIdSigned: true, events: [{ eventId: 'ev-r1', projectId: f.projectId, data: { alert: 'reconcile' } }] },
  }, now);
  assert.equal(acc?.status, 'accepted');
  const firstReceipt = acc && acc.status === 'accepted' ? acc.receipts[0] : undefined;
  assert.equal(firstReceipt?.status, 'accepted');
  const inboundMsgId = firstReceipt?.status === 'accepted' ? firstReceipt.message_id! : '';
  // Take and finish the initial inbound message turn (simulating Router accepting alert and creating inboundTask)
  const inboundTurn = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(inboundTurn.message.id, inboundMsgId);
  const inboundTask = f.ledger.createTask({
    projectId: f.projectId, title: '诊断对账失败', goal: '查根因', acceptance: '出报告', roleId: 'verify',
    tierOverride: { tier: 'execute', reason: '测试' },
  }, { actor: 'router', messageId: inboundMsgId });
  f.ledger.finishMessage(inboundMsgId, 'processed');
  f.ledger.queueTask(inboundTask.id, USER);
  const run1 = f.ledger.createRun(inboundTask.id, f.login, USER);
  f.ledger.markRunRunning(run1.id);
  f.ledger.settleRun(run1.id, 0, { status: 'done', summary: '上游缺失 Status 行' });
  const settleMsg1 = f.ledger.takeNextTurn(f.projectId)!.message;

  notify.finalReply(settleMsg1, { ...settleMsg1, direction: 'out', text: '根因已核实：上游未推送 OrderType=Status，建议放行。' }, { turnMessageId: settleMsg1.id });
  f.ledger.finishMessage(settleMsg1.id, 'processed');
  const groupOut1 = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox ORDER BY rowid')
    .map((r) => JSON.parse(r.payload_json) as { external_id?: string; target?: { chatid: string; chat_type: number }; content?: string })
    .filter((p) => p.external_id?.startsWith('task-group:'));
  assert.equal(groupOut1.length, 1);
  assert.deepEqual(groupOut1[0]!.target, { chatid: 'wr-prod-ops', chat_type: 2 });
  assert.match(groupOut1[0]!.content!, /OrderType=Status/);

  // 2. Group @mention -> creates task -> if Router already called post_group_update in the closure turn, no duplicate auto-broadcast
  const mentionMsg = f.ledger.frontReceive({
    channel: 'wecom', bot: 'bot1', externalId: 'ext-mention-1', actor: 'colleague-a', thread: 'wr-prod-ops',
    text: '@tycho 帮忙复跑放行水位', material: false, forcedProjectId: f.projectId,
  });
  const mentionTurn = f.ledger.takeNextTurn(f.projectId)!;
  assert.equal(mentionTurn.message.id, mentionMsg.id);
  const groupTask = f.ledger.createTask({
    projectId: f.projectId, title: '放行并复跑水位', goal: '写断言并复跑', acceptance: '水位推进', roleId: 'verify',
    tierOverride: { tier: 'execute', reason: '测试' },
  }, { actor: 'router', messageId: mentionMsg.id });
  f.ledger.finishMessage(mentionMsg.id, 'processed');
  f.ledger.queueTask(groupTask.id, USER);
  const run2 = f.ledger.createRun(groupTask.id, f.login, USER);
  f.ledger.markRunRunning(run2.id);
  f.ledger.settleRun(run2.id, 0, { status: 'done', summary: '水位已推进到 2026-11-24' });
  const settleMsg2 = f.ledger.takeNextTurn(f.projectId)!.message;

  // Router explicitly broadcasts during settleMsg2 turn -> finalReply must NOT send a second copy
  f.ledger.postGroupUpdate(f.projectId, { content: '已完成放行复跑，4 张表水位均推进至 2026-11-24。', taskId: groupTask.id }, { actor: 'router', messageId: settleMsg2.id });
  notify.finalReply(settleMsg2, { ...settleMsg2, direction: 'out', text: '复跑完成。' }, { turnMessageId: settleMsg2.id });
  f.ledger.finishMessage(settleMsg2.id, 'processed');

  const allGroupOut = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox ORDER BY rowid')
    .map((r) => JSON.parse(r.payload_json) as { external_id?: string; target?: { chatid: string; chat_type: number } })
    .filter((p) => p.target?.chatid === 'wr-prod-ops');
  assert.equal(allGroupOut.filter((p) => p.external_id?.startsWith(`group-update:${settleMsg2.id}:`)).length, 1);
  assert.equal(allGroupOut.filter((p) => p.external_id?.startsWith(`task-group:${settleMsg2.id}:`)).length, 0, 'must not double-broadcast when Router already called post_group_update');

  // 3. Group @mention -> task concludes without explicit post_group_update -> auto-broadcasts back to originating group
  const mentionMsg2 = f.ledger.frontReceive({
    channel: 'wecom', bot: 'bot1', externalId: 'ext-mention-2', actor: 'colleague-b', thread: 'wr-prod-ops',
    text: '@tycho 查一下集群磁盘', material: false, forcedProjectId: f.projectId,
  });
  f.ledger.takeNextTurn(f.projectId);
  const groupTask2 = f.ledger.createTask({
    projectId: f.projectId, title: '核查集群磁盘', goal: '查磁盘', acceptance: '出结论', roleId: 'verify',
    tierOverride: { tier: 'execute', reason: '测试' },
  }, { actor: 'router', messageId: mentionMsg2.id });
  f.ledger.finishMessage(mentionMsg2.id, 'processed');
  f.ledger.queueTask(groupTask2.id, USER);
  const run3 = f.ledger.createRun(groupTask2.id, f.login, USER);
  f.ledger.markRunRunning(run3.id);
  f.ledger.settleRun(run3.id, 0, { status: 'done', summary: '磁盘余量充足' });
  const settleMsg3 = f.ledger.takeNextTurn(f.projectId)!.message;
  notify.finalReply(settleMsg3, { ...settleMsg3, direction: 'out', text: '集群磁盘使用率 61%，无告警风险。' }, { turnMessageId: settleMsg3.id });
  const groupOut3 = f.peek<{ payload_json: string }>('SELECT payload_json FROM outbox ORDER BY rowid')
    .map((r) => JSON.parse(r.payload_json) as { external_id?: string; target?: { chatid: string; chat_type: number }; content?: string })
    .filter((p) => p.external_id === `task-group:${settleMsg3.id}:wecom:wr-prod-ops`);
  assert.equal(groupOut3.length, 1);
  assert.match(groupOut3[0]!.content!, /磁盘使用率 61%/);
});
