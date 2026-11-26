import './guard.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../adapters/all.ts';
import { snapshotFiles, type Snapshot } from '../runner/snapshot.ts';
import { createDispatcher } from '../service/dispatcher.ts';
import { createMachines } from '../service/machines.ts';
import {
  MAX_TURN_IMAGE_TOTAL_BYTES,
  readProjectFileBytes,
  removeProjectFileBytes,
  writeProjectFileBytes,
} from '../service/project-files.ts';
import { createSessionHost } from '../service/session-host.ts';
import { createTools } from '../service/tools.ts';
import {
  accepting,
  claudeTier,
  DISPATCH_TUNED,
  fixture,
  memoryLogins,
  ROUTER_TUNED,
  tuned,
  USER,
} from './helpers.ts';

const GEMINI_BRIDGE = fileURLToPath(new URL('../service/router-gemini.ts', import.meta.url));
const CODEX_BRIDGE = fileURLToPath(new URL('../service/router-codex.ts', import.meta.url));

// Minimal valid 1x1 PNG bytes.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const TINY_PNG_B64 = TINY_PNG.toString('base64');

async function until<T>(read: () => T | undefined | false | null, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await sleep(20);
  }
}

test('router-gemini forwards multimodal text and base64 image blocks to ACP session/prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-mm-gemini-'));
  try {
    const mockScript = join(dir, 'mock-acp.mjs');
    writeFileSync(
      mockScript,
      `
import { createInterface } from 'node:readline';
const write = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new') {
    write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'gem-mm-1' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify(msg.params.prompt) },
        },
      },
    });
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
    );

    const cfg = join(dir, 'config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, mockScript],
        prompt: 'SYSTEM',
        tools: ['list_project_files'],
        mcp: { command: process.execPath, args: ['proxy.ts'], env: {} },
      }),
    );

    const child = spawn(process.execPath, [GEMINI_BRIDGE, '--marker', 'mm-gem', '--config', cfg], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const events: Record<string, any>[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => events.push(JSON.parse(line)));

    await until(() => events.some((e) => e.type === 'system' && e.subtype === 'init'), 'gemini init');

    // Turn 1: text + image block
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        session_id: '',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '请看这张截图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } },
          ],
        },
        parent_tool_use_id: null,
      })}\n`,
    );
    await until(() => events.some((e) => e.type === 'result'), 'gemini turn 1 result');
    const firstResult = events.find((e) => e.type === 'result')!;
    assert.equal(firstResult.is_error, false);
    const forwardedPrompt = JSON.parse(firstResult.result);
    assert.deepEqual(forwardedPrompt, [
      { type: 'text', text: '请看这张截图' },
      { type: 'image', mimeType: 'image/png', data: TINY_PNG_B64 },
    ]);

    // Turn 2: empty content falls back to a text block
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        session_id: '',
        message: { role: 'user', content: [] },
        parent_tool_use_id: null,
      })}\n`,
    );
    await until(() => events.filter((e) => e.type === 'result').length >= 2, 'gemini turn 2 result');
    const secondResult = events.filter((e) => e.type === 'result')[1]!;
    assert.deepEqual(JSON.parse(secondResult.result), [{ type: 'text', text: '' }]);

    child.stdin.end();
    await once(child, 'close');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router-codex materializes base64 images as localImage temp files and cleans them up after turn/completed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycho-mm-codex-'));
  try {
    const server = join(dir, 'mock-codex.cjs');
    writeFileSync(
      server,
      `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
let turnSeq = 0;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
  if (m.method === 'config/read') { send({ id: m.id, result: { config: { mcp_servers: {} } } }); return; }
  if (m.method === 'thread/start') {
    send({ id: m.id, result: { thread: { id: 'thr-mm' }, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false }, model: 'test-model' } });
    return;
  }
  if (m.method === 'mcpServerStatus/list') {
    send({ id: m.id, result: { data: [{ name: 'tycho', runtimeStatus: 'connected', tools: { list_project_files: {} }, toolsError: null }], nextCursor: null } });
    return;
  }
  if (m.method === 'turn/start') {
    turnSeq += 1;
    if (turnSeq === 2) {
      // Simulate turn/start rejection to test temp file cleanup on failure too.
      const imgEntry = m.params.input.find((item) => item.type === 'localImage');
      const existsAtReject = imgEntry ? fs.existsSync(imgEntry.path) : false;
      fs.writeFileSync(process.env.REJECT_INFO_FILE, JSON.stringify({ path: imgEntry?.path ?? null, existsAtReject }));
      send({ id: m.id, error: { code: -32001, message: 'rejected' } });
      return;
    }
    const turnId = 'turn-' + turnSeq;
    const inspected = m.params.input.map((item) => {
      if (item.type === 'localImage') {
        const bytes = fs.readFileSync(item.path);
        return { type: 'localImage', path: item.path, bytesBase64: bytes.toString('base64') };
      }
      return item;
    });
    send({ id: m.id, result: { turn: { id: turnId } } });
    send({ method: 'item/completed', params: { threadId: 'thr-mm', turnId, item: { type: 'agentMessage', text: JSON.stringify(inspected) } } });
    send({ method: 'turn/completed', params: { threadId: 'thr-mm', turn: { id: turnId, status: 'completed' } } });
    return;
  }
  send({ id: m.id, result: {} });
});
`,
    );

    const cfg = join(dir, 'config.json');
    const rejectInfoFile = join(dir, 'reject-info.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, server],
        prompt: 'SYSTEM',
        tools: ['list_project_files'],
        mcp: { command: process.execPath, args: ['proxy.ts'], env: {} },
      }),
    );

    const child = spawn(process.execPath, [CODEX_BRIDGE, '--marker', 'mm-codex', '--config', cfg], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: '', REJECT_INFO_FILE: rejectInfoFile },
    });
    const events: Record<string, any>[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => events.push(JSON.parse(line)));

    await until(() => events.some((e) => e.type === 'system' && e.subtype === 'init'), 'codex init');

    // Turn 1: succeeds; image bytes match during turn and file+dir are removed after turn/completed.
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        session_id: '',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } },
          ],
        },
        parent_tool_use_id: null,
      })}\n`,
    );
    await until(() => events.some((e) => e.type === 'result'), 'codex turn 1 result');
    const turn1 = events.find((e) => e.type === 'result')!;
    assert.equal(turn1.is_error, false);
    const inspected = JSON.parse(turn1.result) as Array<Record<string, any>>;
    assert.equal(inspected.length, 2);
    assert.deepEqual(inspected[0], { type: 'text', text: '看看这张图', text_elements: [] });
    assert.equal(inspected[1]!.type, 'localImage');
    assert.match(inspected[1]!.path, /\.png$/);
    assert.equal(inspected[1]!.bytesBase64, TINY_PNG_B64);
    assert.equal(existsSync(inspected[1]!.path), false, 'turn/completed 后临时图片应已删除');
    assert.equal(existsSync(dirname(inspected[1]!.path)), false, 'turn/completed 后临时目录应已删除');

    // Turn 2: turn/start rejected; temp image must still be cleaned up.
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        session_id: '',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '第二张' },
            { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: TINY_PNG_B64 } },
          ],
        },
        parent_tool_use_id: null,
      })}\n`,
    );
    await until(() => events.filter((e) => e.type === 'result').length >= 2, 'codex turn 2 result');
    const turn2 = events.filter((e) => e.type === 'result')[1]!;
    assert.equal(turn2.is_error, true);
    const rejectInfo = JSON.parse(readFileSync(rejectInfoFile, 'utf8')) as { path: string; existsAtReject: boolean };
    assert.equal(rejectInfo.existsAtReject, true);
    assert.match(rejectInfo.path, /\.webp$/);
    assert.equal(existsSync(rejectInfo.path), false, 'turn/start 失败后临时图片也应已删除');
    assert.equal(existsSync(dirname(rejectInfo.path)), false, 'turn/start 失败后临时目录也应已删除');

    child.stdin.end();
    await once(child, 'close');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session-host attaches up to 4 base64 images, degrades cleanly on missing disk bytes, and never logs base64 to SQLite', async (t) => {
  const f = fixture(t);
  const captureFile = join(f.dir, 'captured-users.ndjson');
  const mockCli = join(f.dir, 'mock-claude-mm.mjs');
  writeFileSync(
    mockCli,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = process.env.CAPTURE_FILE;
const tools = ['Read', 'Grep', 'Glob', 'Bash', 'mcp__tycho__list_project_files'];
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
let initSent = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'user') return;
  if (!initSent) {
    initSent = true;
    emit({ type: 'system', subtype: 'init', session_id: 'sess-mm', tools });
  }
  appendFileSync(capture, JSON.stringify(msg) + '\\n');
  emit({ type: 'result', subtype: 'success', is_error: false, result: '收到' });
});
`,
  );

  const prevCapture = process.env.CAPTURE_FILE;
  process.env.CAPTURE_FILE = captureFile;

  const host = createSessionHost({
    ...ROUTER_TUNED,
    ledger: f.ledger,
    dataDir: f.dir,
    launchWith: async () => ({ claude: [process.execPath, mockCli], tier: claudeTier('sonnet') }),
    toolNames: ['list_project_files'],
    log: () => {},
    pollMs: 20,
    turnTimeoutMs: tuned('router.turnTimeoutMs'),
  });
  try {
  // Seed 5 valid PNGs, 1 PNG missing from disk, and 1 text doc.
  const imgIds: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    const id = `img_${i}`;
    const { size, sha256 } = writeProjectFileBytes(f.dir, f.projectId, id, TINY_PNG);
    f.ledger.createProjectFile({
      id,
      projectId: f.projectId,
      name: `shot-${i}.png`,
      mime: 'image/png',
      size,
      sha256,
      kind: 'upload',
      origin: 'owner',
      summary: `截图 ${i}`,
    });
    imgIds.push(id);
  }
  const missingId = 'img_missing';
  f.ledger.createProjectFile({
    id: missingId,
    projectId: f.projectId,
    name: 'gone.png',
    mime: 'image/png',
    size: TINY_PNG.length,
    sha256: '0'.repeat(64),
    kind: 'upload',
    origin: 'owner',
  });
  const docId = 'doc_1';
  const docBytes = Buffer.from('# Spec\nhello', 'utf8');
  const docWritten = writeProjectFileBytes(f.dir, f.projectId, docId, docBytes);
  f.ledger.createProjectFile({
    id: docId,
    projectId: f.projectId,
    name: 'spec.md',
    mime: 'text/markdown',
    size: docWritten.size,
    sha256: docWritten.sha256,
    kind: 'doc',
    origin: 'owner',
  });

  await host.start(1);
  const received = f.ledger.receiveMessage({
    channel: 'console',
    externalId: randomUUID(),
    actor: 'user',
    text: '请分析这些附件',
    projectId: f.projectId,
    attachmentIds: [missingId, docId, ...imgIds],
  });
  host.kick(received.id);

  await until(() => f.ledger.getMessage(received.id).state === 'processed', 'multimodal turn processed');

  const captured = readFileSync(captureFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  // First user message is recovery material; second is the request turn.
  const requestMsg = captured.at(-1)!;
  const blocks = requestMsg.message.content as Array<Record<string, any>>;
  assert.equal(blocks[0]!.type, 'text');
  assert.match(blocks[0]!.text, /\[项目附件\]/);
  assert.match(blocks[0]!.text, /gone\.png.*磁盘文件缺失/);
  assert.match(blocks[0]!.text, /spec\.md \(id=doc_1, mime=text\/markdown/);
  assert.match(blocks[0]!.text, /shot-5\.png.*最多附带 4 张图片/);

  const images = blocks.filter((b) => b.type === 'image');
  assert.equal(images.length, 4, '单回合最多发送 4 张位图');
  for (const img of images) {
    assert.deepEqual(img, {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
    });
  }

  // Audit log in SQLite must NOT contain raw base64 image data.
  const exchanges = f.peek<{ phase: string; input: string }>(
    'SELECT phase, input FROM router_exchange WHERE message_id = ? AND phase = ?',
    received.id,
    'request',
  );
  assert.equal(exchanges.length, 1);
  assert.match(exchanges[0]!.input, /\[项目附件\]/);
  assert.match(exchanges[0]!.input, /附带 4 张图片/);
  assert.equal(exchanges[0]!.input.includes(TINY_PNG_B64), false, 'SQLite 审计日志绝不能写入原始 base64 图片数据');

  // Turn 2: spoofed PNG magic bytes degrade cleanly + MAX_TURN_IMAGE_TOTAL_BYTES (12 MiB) cap enforced.
  const spoofId = 'img_spoof';
  const spoofBytes = Buffer.from('not-actually-a-png-file', 'utf8');
  const spoofWritten = writeProjectFileBytes(f.dir, f.projectId, spoofId, spoofBytes);
  f.ledger.createProjectFile({
    id: spoofId,
    projectId: f.projectId,
    name: 'fake.png',
    mime: 'image/png',
    size: spoofWritten.size,
    sha256: spoofWritten.sha256,
    kind: 'upload',
    origin: 'owner',
  });

  // Two valid PNGs of 7 MiB each -> first attaches (7 MiB <= 12 MiB), second skipped (14 MiB > 12 MiB).
  const largeSize = 7 * 1024 * 1024;
  assert.ok(largeSize * 2 > MAX_TURN_IMAGE_TOTAL_BYTES);
  const largePng = Buffer.alloc(largeSize);
  TINY_PNG.copy(largePng, 0);
  const big1Written = writeProjectFileBytes(f.dir, f.projectId, 'img_big_1', largePng);
  f.ledger.createProjectFile({
    id: 'img_big_1',
    projectId: f.projectId,
    name: 'big-1.png',
    mime: 'image/png',
    size: big1Written.size,
    sha256: big1Written.sha256,
    kind: 'upload',
    origin: 'owner',
  });
  const big2Written = writeProjectFileBytes(f.dir, f.projectId, 'img_big_2', largePng);
  f.ledger.createProjectFile({
    id: 'img_big_2',
    projectId: f.projectId,
    name: 'big-2.png',
    mime: 'image/png',
    size: big2Written.size,
    sha256: big2Written.sha256,
    kind: 'upload',
    origin: 'owner',
  });

  const received2 = f.ledger.receiveMessage({
    channel: 'console',
    externalId: randomUUID(),
    actor: 'user',
    text: '测试图片魔数和总大小上限',
    projectId: f.projectId,
    attachmentIds: [spoofId, 'img_big_1', 'img_big_2'],
  });
  host.kick(received2.id);

  await until(() => f.ledger.getMessage(received2.id).state === 'processed', 'turn 2 processed');
  const capturedAfterTurn2 = readFileSync(captureFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const turn2Msg = capturedAfterTurn2.at(-1)!;
  const turn2Blocks = turn2Msg.message.content as Array<Record<string, any>>;
  assert.equal(turn2Blocks[0]!.type, 'text');
  assert.match(turn2Blocks[0]!.text, /fake\.png.*文件内容与图片格式不符，未作为视觉输入发送/);
  assert.match(turn2Blocks[0]!.text, /big-2\.png.*超过单回合图片总大小上限/);
  const turn2Images = turn2Blocks.filter((b) => b.type === 'image');
  assert.equal(turn2Images.length, 1, '仅有第一张 7 MiB 合法图片被附带，伪造图片与超预算第二张均被优雅降级');
  } finally {
    try {
      await host.stop();
    } finally {
      if (prevCapture === undefined) delete process.env.CAPTURE_FILE;
      else process.env.CAPTURE_FILE = prevCapture;
    }
  }
});

test('Router MCP project file tools and create_task file_ids -> dispatcher snapshot work end to end', async (t) => {
  const f = fixture(t);
  const otherProjectId = f.ledger.createProject({ name: '其他项目' }, USER);

  const login = {
    id: 'acc-1',
    name: 'Claude Account',
    executor: 'claude',
    tiers: {
      execute: claudeTier('sonnet'),
      decide: claudeTier('opus'),
    },
  };
  const logins = memoryLogins({ [login.id]: login }, f.ledger);
  const machines = createMachines({ ledger: f.ledger });

  const tools = createTools({
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      interrupt: async () => 'ended',
      events: () => [],
      abandon: async () => {},
    },
    logins,
    machines,
    accept: accepting(f.ledger),
  });

  const here = { projectId: f.projectId };
  const callTool = async (name: string, args: Record<string, unknown>, scope = here) => {
    const res = await tools.call(name, args, { actor: 'router' }, scope);
    return { isError: res.isError === true, text: res.content[0]!.text };
  };

  // Fails cleanly outside a project.
  const noScope = await callTool('list_project_files', {}, { projectId: '' });
  assert.equal(noScope.isError, true);
  assert.match(noScope.text, /项目上下文/);

  // 1. write_project_file creates HTML artifact and returns tycho-file://<id>.
  const htmlV1 = '<!doctype html><html><body><h1>Dashboard v1</h1></body></html>';
  const w1 = await callTool('write_project_file', {
    name: 'reports/dashboard.html',
    content: htmlV1,
    summary: '初版仪表盘',
  });
  assert.equal(w1.isError, false, w1.text);
  const w1Data = JSON.parse(w1.text);
  assert.equal(w1Data.file.name, 'dashboard.html');
  assert.equal(w1Data.file.mime, 'text/html');
  assert.equal(w1Data.file.kind, 'artifact');
  assert.equal(w1Data.file.origin, 'router');
  assert.equal(w1Data.previewable, true);
  assert.equal(w1Data.ref, `tycho-file://${w1Data.file.id}`);
  assert.match(w1Data.tip, new RegExp(`tycho-file://${w1Data.file.id}`));

  // 2. Second write with the same name updates in place keeping the SAME id!
  const htmlV2 = '<!doctype html><html><body><h1>Dashboard v2</h1><p>Updated</p></body></html>';
  const w2 = await callTool('write_project_file', {
    name: 'dashboard.html',
    content: htmlV2,
    summary: '迭代版仪表盘',
  });
  assert.equal(w2.isError, false, w2.text);
  const w2Data = JSON.parse(w2.text);
  assert.equal(w2Data.file.id, w1Data.file.id, '同名 router 文件应原地更新保留相同 id');
  assert.equal(w2Data.file.summary, '迭代版仪表盘');
  assert.equal(readProjectFileBytes(f.dir, f.projectId, w1Data.file.id)?.toString('utf8'), htmlV2);

  // 3. Seed an owner PNG + an owner text spec + a cross-project file.
  const pngWritten = writeProjectFileBytes(f.dir, f.projectId, 'owner_png', TINY_PNG);
  f.ledger.createProjectFile({
    id: 'owner_png',
    projectId: f.projectId,
    name: 'ui.png',
    mime: 'image/png',
    size: pngWritten.size,
    sha256: pngWritten.sha256,
    kind: 'upload',
    origin: 'owner',
  });
  const specText = '# API 设计说明\n1. 支持多模态输入\n2. 产物可沙箱预览\n';
  const specWritten = writeProjectFileBytes(f.dir, f.projectId, 'owner_spec', Buffer.from(specText, 'utf8'));
  f.ledger.createProjectFile({
    id: 'owner_spec',
    projectId: f.projectId,
    name: 'api-spec.md',
    mime: 'text/markdown',
    size: specWritten.size,
    sha256: specWritten.sha256,
    kind: 'doc',
    origin: 'owner',
  });
  const otherWritten = writeProjectFileBytes(f.dir, otherProjectId, 'other_doc', Buffer.from('secret', 'utf8'));
  f.ledger.createProjectFile({
    id: 'other_doc',
    projectId: otherProjectId,
    name: 'other.txt',
    mime: 'text/plain',
    size: otherWritten.size,
    sha256: otherWritten.sha256,
    kind: 'doc',
    origin: 'owner',
  });

  // 4. list_project_files returns only this project's files.
  const listed = await callTool('list_project_files', {});
  assert.equal(listed.isError, false);
  const listData = JSON.parse(listed.text);
  assert.equal(listData.files.length, 3);
  assert.deepEqual(
    new Set(listData.files.map((item: { id: string }) => item.id)),
    new Set([w1Data.file.id, 'owner_png', 'owner_spec']),
  );

  // 5. read_project_file reads text (with truncation support), refuses binary dumping cleanly, and rejects cross-project ids.
  const readFull = await callTool('read_project_file', { file_id: w1Data.file.id });
  assert.equal(readFull.isError, false);
  assert.deepEqual(JSON.parse(readFull.text).content, htmlV2);
  assert.equal(JSON.parse(readFull.text).truncated, false);

  const readShort = await callTool('read_project_file', { file_id: 'owner_spec', max_chars: 10 });
  assert.equal(readShort.isError, false);
  const shortData = JSON.parse(readShort.text);
  assert.equal(shortData.content, specText.slice(0, 10));
  assert.equal(shortData.truncated, true);

  const readBin = await callTool('read_project_file', { file_id: 'owner_png' });
  assert.equal(readBin.isError, false);
  const binData = JSON.parse(readBin.text);
  assert.equal(binData.readable_as_text, false);
  assert.equal('content' in binData, false);
  assert.match(binData.note, /视觉上下文/);

  const readCross = await callTool('read_project_file', { file_id: 'other_doc' });
  assert.equal(readCross.isError, true);
  assert.match(readCross.text, /项目里没有这个文件/);

  // 6. Reject > 2 MiB write cleanly, reject non-text MIME (application/pdf), and return non-preview tip for .md.
  const tooLarge = await callTool('write_project_file', {
    name: 'huge.txt',
    content: 'a'.repeat(2 * 1024 * 1024 + 1),
  });
  assert.equal(tooLarge.isError, true);
  assert.match(tooLarge.text, /2 MiB/);

  const badPdf = await callTool('write_project_file', {
    name: 'report.pdf',
    content: '%PDF-1.4\n%EOF\n',
  });
  assert.equal(badPdf.isError, true);
  assert.match(badPdf.text, /仅支持写入文本、HTML、SVG 或文档类文件/);

  const badPdfMime = await callTool('write_project_file', {
    name: 'disguised.txt',
    mime: 'application/pdf',
    content: 'not allowed',
  });
  assert.equal(badPdfMime.isError, true);
  assert.match(badPdfMime.text, /仅支持写入文本、HTML、SVG 或文档类文件/);

  const mdRes = await callTool('write_project_file', {
    name: 'CON.md',
    content: '# Notes\nhello markdown\n',
  });
  assert.equal(mdRes.isError, false, mdRes.text);
  const mdData = JSON.parse(mdRes.text);
  assert.equal(mdData.previewable, false);
  assert.equal(mdData.tip, '文件已保存到项目文件区，可在“项目文件”抽屉查看或下载。');
  assert.equal(mdData.tip.includes('tycho-file://'), false);

  // 7. create_task with file_ids validates cross-project isolation loudly.
  const badCrossTask = await callTool('create_task', {
    title: '跨项目文件测试',
    goal: '检查隔离',
    acceptance: '应被拒',
    role_id: 'implement',
    file_ids: ['other_doc'],
  });
  assert.equal(badCrossTask.isError, true);
  assert.match(badCrossTask.text, /项目里没有这个文件/);

  // 8. create_task with valid text AND binary file_ids passes them through dispatcher into Worker snapshot files!
  // Also include Windows reserved filename CON.md to verify safeSnapshotFileName prefixes it with file-.
  const createdRes = await callTool('create_task', {
    title: '实现 API 规范',
    goal: '按参考文档实现接口',
    acceptance: '通过所有单元测试',
    scope: '仅修改 service/',
    role_id: 'implement',
    file_ids: ['owner_spec', w1Data.file.id, mdData.file.id, 'owner_png'],
  });
  assert.equal(createdRes.isError, false, createdRes.text);
  const taskIdMatch = createdRes.text.match(/任务已创建并排队：([A-Z0-9]+)/);
  assert.ok(taskIdMatch, `unexpected create_task reply: ${createdRes.text}`);
  const taskId = taskIdMatch[1]!;
  const task = f.ledger.getTask(taskId);
  assert.match(task.scope ?? '', /\[项目参考文件\]/);
  assert.match(task.scope ?? '', /api-spec\.md \(tycho-file:\/\/owner_spec\)/);

  // Dispatch the task and verify the Run's snapshot materializes project-files/!
  const launchedRuns: Array<{ id: string; snapshot_json: string }> = [];
  const dispatcher = createDispatcher({
    ...DISPATCH_TUNED,
    ledger: f.ledger,
    dataDir: f.dir,
    runner: {
      launch: async (run) => { launchedRuns.push(run); },
      watch: async () => {},
      findMachine: async (_login, offered) => offered[0],
      lostCandidates: () => [],
      presume: async () => 'ended',
      sweep: async () => {},
    },
    logins,
    machines,
    executors: ADAPTERS,
    runTimeoutMs: () => 60_000,
    log: () => {},
  });

  await dispatcher.tick();
  assert.equal(launchedRuns.length, 1);
  const snapshot = JSON.parse(launchedRuns[0]!.snapshot_json) as Snapshot;
  assert.equal(snapshot.project_files?.length, 4);
  assert.match(snapshot.brief, /## 项目参考文件/);
  assert.match(snapshot.brief, /`project-files\/api-spec\.md`/);
  assert.match(snapshot.brief, /`project-files\/dashboard\.html`/);
  assert.match(snapshot.brief, /`project-files\/file-CON\.md`/);
  assert.match(snapshot.brief, /`project-files\/ui\.png`/);

  const files = snapshotFiles(snapshot);
  const specSnap = files.find((item) => item.path === 'project-files/api-spec.md');
  const htmlSnap = files.find((item) => item.path === 'project-files/dashboard.html');
  const conSnap = files.find((item) => item.path === 'project-files/file-CON.md');
  const pngSnap = files.find((item) => item.path === 'project-files/ui.png');
  assert.equal(specSnap?.text, specText);
  assert.equal(htmlSnap?.text, htmlV2);
  assert.equal(conSnap?.text, '# Notes\nhello markdown\n');
  assert.equal(pngSnap?.encoding, 'base64');
  assert.deepEqual(Buffer.from(pngSnap?.text ?? '', 'base64'), TINY_PNG);

  // Clean up test disk artifact check: removing disk bytes fails loudly on read_project_file.
  removeProjectFileBytes(f.dir, f.projectId, 'owner_spec');
  const missingRead = await callTool('read_project_file', { file_id: 'owner_spec' });
  assert.equal(missingRead.isError, true);
  assert.match(missingRead.text, /不存在/);
});
