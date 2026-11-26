// Guards Router launch records and context rotation against stale knowledge or excessive context.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Processes, RouterLaunch, SessionHost, SessionHostOptions, TurnObserver } from '../service/session-host.ts';
import type { RouterKnowledge } from '../service/knowledge-brief.ts';
import type { LedgerOptions } from '../service/ledger.ts';
import { hostProcesses } from '../service/processes.ts';
import { createSessionHost, RouterUnavailable } from '../service/session-host.ts';
import { routerMaterial } from '../service/router-material.ts';
import { claudeTier, fixture, ROUTER_TUNED, tuned, USER } from './helpers.ts';

import { hostLogin, openContext, TOKEN, FAKE, NO_STDIN, POSIX_ONLY, TOOLS, MCP_TOOLS, options, until, type LogEntry, childPids, type Barriers, setup, admitted, existingSession, closedStdin, steady } from './session-host-fixture.ts';

// --- what the running process was started with ---

test('the Host says what the process that runs was started with, and nothing while none runs', options, async (t) => {
  const { host, send, settled } = setup(t, {});
  assert.equal(host.status().launched, null);
  await host.start(1);
  assert.equal(host.status().launched, null, '没有消息就没有进程');
  assert.equal(await settled(send('先来一条')), 'processed');
  assert.deepEqual(host.status().launched, { claude: [process.execPath, FAKE], tier: claudeTier('tier.json') });
  assert.equal(await settled(send('崩溃')), 'unverified');
  assert.equal(host.status().launched, null);
});

// A project's Router is given the resident knowledge once, in full, when a context starts; a
// turn carries the catalog only when it changed; resident text that changed is a new context
// before the next message, never kept in the old one (docs/design/project-sessions.md §3). A
// read that fails sends the turn without the catalog and says so.
test('resident knowledge goes in with a new context, a changed catalog with the next turn, and changed resident text means a new context', options, async (t) => {
  let knowledge: RouterKnowledge | (() => never) = { resident: ['k1@1'], residentText: '[tycho 知识] 常驻：先分解差距', catalog: '[tycho 知识] 目录：甲' };
  const { f, host, send, settled, users, starts } = setup(t, {}, {
    knowledge: () => (typeof knowledge === 'function' ? knowledge() : knowledge),
    material: () => ({ text: `[tycho 内部事件] 材料 ${typeof knowledge === 'function' ? '' : knowledge.residentText}`, knowledge: [], more_requests: false }),
  });
  await host.start(1234);
  assert.equal(await settled(send('第一条')), 'processed');
  assert.equal(await settled(send('第二条')), 'processed');
  knowledge = { resident: ['k1@1'], residentText: '[tycho 知识] 常驻：先分解差距', catalog: '[tycho 知识] 目录：甲、乙' };
  assert.equal(await settled(send('第三条')), 'processed');
  const first = f.ledger.currentContext(f.projectId)!;
  knowledge = { resident: ['k1@2'], residentText: '[tycho 知识] 常驻：先量再改', catalog: '[tycho 知识] 目录：甲、乙' };
  assert.equal(await settled(send('第四条')), 'processed');
  knowledge = () => { throw new Error('账本读不出来'); };
  assert.equal(await settled(send('第五条')), 'processed');
  const said = users();
  assert.equal(said[0], '[tycho 内部事件] 材料 [tycho 知识] 常驻：先分解差距');
  assert.equal(said[1], '[tycho 知识] 目录：甲\n\n---\n\n第一条');
  assert.equal(said[2], '第二条', '目录没变就不再带');
  assert.equal(said[3], '[tycho 知识] 目录：甲、乙\n\n---\n\n第三条', '目录变了，下一回合带上新的，不换上下文');
  assert.equal(starts().length, 2, '常驻正文变了：下一条消息之前换了上下文');
  assert.deepEqual([f.ledger.getContext(first.id)!.state, f.ledger.getContext(first.id)!.closed_reason], ['closed', '适用知识的正文变了']);
  assert.equal(said[4], '[tycho 内部事件] 材料 [tycho 知识] 常驻：先量再改', '新上下文先收到新的常驻全文');
  assert.equal(JSON.parse(f.ledger.currentContext(f.projectId)!.knowledge_json!)[0], 'k1@2');
  assert.match(said.at(-1)!, /^\[tycho 知识\] 知识服务不可用，这一回合没有带上知识目录：Error: 账本读不出来\n\n---\n\n第五条$/);
});

// A Router context that has grown long is rebuilt from the ledger before the next message,
// the same way changed knowledge is, rather than left to the CLI's own lossy compaction
// (project-sessions §3, from Claude Code Projects). Guards against a size that is never read,
// one that rotates a context still under the limit, and one forgotten when the process exits
// or the service restarts, so that a long context is resumed after all.
test('a context whose last call was over the limit is rebuilt before the next message; one under it goes on', options, async (t) => {
  let limit = 30_000;
  const { f, host, send, settled, users, starts } = setup(t, {}, { contextTokens: () => limit });
  await host.start(1);
  assert.equal(await settled(send('开头一句')), 'processed');
  assert.equal(await settled(send('上下文很长')), 'processed');
  const first = f.ledger.currentContext(f.projectId)!;
  assert.equal(first.context_tokens, 26_123, '记下的是最后一次调用时的上下文大小');
  assert.equal(await settled(send('还没到上限')), 'processed');
  assert.equal(starts().length, 1, '没到上限就接着用');
  limit = 20_000;
  assert.equal(await settled(send('超过上限之后')), 'processed');
  assert.equal(starts().length, 2, '下一条消息之前换了上下文');
  assert.deepEqual([f.ledger.getContext(first.id)!.state, f.ledger.getContext(first.id)!.closed_reason], ['closed', '上下文超过设定的长度']);
  const said = users();
  assert.match(said.at(-2)!, /从账本重建/, '新上下文先收到从账本重建的材料');
  assert.equal(said.at(-1), '超过上限之后');
});

test('a long context left by an earlier process is rebuilt, not resumed; a limit of 0 never rotates', options, async (t) => {
  let limit = 0;
  const { f, host, make, send, settled, starts } = setup(t, {}, { contextTokens: () => limit });
  await host.start(1);
  assert.equal(await settled(send('上下文很长')), 'processed');
  assert.equal(await settled(send('上限为 0')), 'processed');
  assert.equal(starts().length, 1, '0 是不按长度换');
  const first = f.ledger.currentContext(f.projectId)!;
  await host.stop();
  limit = 20_000;
  // Stopped in the body: a hook added here would run after the fixture removed the directory.
  const again = make();
  try {
    await again.start(1);
    assert.equal(await settled(send('重启以后')), 'processed');
    const argv = starts().at(-1)!.argv!;
    assert.ok(!argv.includes('--resume'), '没有续接那个太长的会话');
    assert.equal(f.ledger.getContext(first.id)!.closed_reason, '上下文超过设定的长度');
  } finally {
    await again.stop();
  }
});

// A context this process opened that is already at the limit after its opening turn would be
// rebuilt as large: rebuilding it at every message would only lose the conversation. It goes on,
// and the log says once that the setting is below what a new context starts at.
test('a new context that starts over the limit is not rebuilt at every message, and the log says why once', options, async (t) => {
  const { f, host, send, settled, starts, logLines } = setup(t, {}, { contextTokens: () => 20_000 });
  await host.start(1);
  assert.equal(await settled(send('上下文很长')), 'processed');
  assert.equal(await settled(send('第二条')), 'processed');
  assert.equal(await settled(send('第三条')), 'processed');
  assert.equal(starts().length, 1, '没有每条消息都重建');
  assert.equal(f.ledger.currentContext(f.projectId)!.state, 'open');
  assert.equal(logLines.filter((line) => line.includes('开头就有')).length, 1);
});

// Review of step 1, B: only a resume the CLI itself refused — it ended on its own before any init,
// with no tool admitted — puts the message back. A process that is alive but cannot be talked to
// is a failure of the line, not a refusal, and the message ends unverified as any other.
test('a resumed process that never initialises because the line to it fails does not put the message back', options, async (t) => {
  const { f, host, send, settled } = closedStdin(t, {}, { initTimeoutMs: () => 1500 });
  existingSession(f);
  await host.start(1);
  const id = send('续接时线路坏了');
  assert.equal(await settled(id), 'unverified');
  assert.equal(f.peek(`SELECT 1 FROM change WHERE action = 'message.requeue'`).length, 0);
});

test('Gemini/Codex result.usage updates context_tokens every turn, rotates when over limit, and labels context with active executor', options, async (t) => {
  const f = fixture(t);
  const mockAgy = join(f.dir, 'mock-agy-usage.mjs');
  writeFileSync(mockAgy, `
import { createInterface } from 'node:readline';
const write = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
let turn = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new' || msg.method === 'session/load') {
    write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'gem-ctx-' + process.pid } });
    return;
  }
  if (msg.method === 'session/prompt') {
    turn += 1;
    const text = msg.params.prompt.map((b) => b.text || '').join('');
    if (text.includes('触发截断')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '半截回复' } } } });
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'max_tokens', usage: { inputTokens: 12000, outputTokens: 4000, cachedReadTokens: 2000, cachedWriteTokens: 0 } } });
      return;
    }
    const inputTokens = text.includes('第二轮超长') ? 25000 : 4000;
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok-' + turn } } } });
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens, outputTokens: 200, cachedReadTokens: 1000, cachedWriteTokens: 500 } } });
  }
});
`);

  let limit = 20_000;
  const host = createSessionHost({
    ...ROUTER_TUNED,
    ledger: f.ledger,
    dataDir: f.dir,
    launchWith: async () => ({ claude: [process.execPath, mockAgy], executor: 'gemini' }),
    toolNames: ['list_tasks'],
    contextTokens: () => limit,
    log: () => {},
    pollMs: 20,
    turnTimeoutMs: tuned('router.turnTimeoutMs'),
  });
  try {
    await host.start(1);

    const send = (text: string) => {
      const row = f.ledger.receiveMessage({ channel: 'console', externalId: randomUUID(), actor: 'user', text, projectId: f.projectId });
      host.kick(row.id);
      return row.id;
    };
    const settled = async (id: string) => {
      await until(() => {
        const s = f.ledger.getMessage(id).state;
        return s === 'processed' || s === 'unverified' ? s : false;
      }, `message ${id} settled`);
      return f.ledger.getMessage(id).state;
    };

    assert.equal(await settled(send('第一轮')), 'processed');
    const first = f.ledger.currentContext(f.projectId)!;
    assert.equal(first.login_name, `${hostname()}/gemini`, '非账号登录名应使用实际执行器 gemini 而非硬编码 claude');
    assert.equal(first.context_tokens, 4500, 'result.usage 应写入 context_tokens（input 3000 + cache_read 1000 + cache_write 500）');

    assert.equal(await settled(send('第二轮超长')), 'processed');
    assert.equal(f.ledger.getContext(first.id)!.context_tokens, 25500, '后续回合的 result.usage 应持续更新 context_tokens');

    assert.equal(await settled(send('触发自动换新')), 'processed');
    assert.deepEqual(
      [f.ledger.getContext(first.id)!.state, f.ledger.getContext(first.id)!.closed_reason],
      ['closed', '上下文超过设定的长度'],
    );
    const second = f.ledger.currentContext(f.projectId)!;
    assert.notEqual(second.id, first.id);

    // max_tokens truncated turn must route to unverified rather than processed!
    assert.equal(await settled(send('触发截断')), 'unverified');
  } finally {
    await host.stop();
  }
});
