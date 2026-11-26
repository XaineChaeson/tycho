// Guards expired and changed logins against repeated failures and resuming under the wrong identity.
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

// --- a login that stops working under a running Router ---

// From the moment the file exists, the fake CLI answers every turn as a login the API
// no longer takes.
function loginSwitch(dir: string): string {
  const lost = join(dir, 'login-lost');
  process.env.FAKE_CLAUDE_LOGIN_LOST = lost;
  return lost;
}

test('a login that expires under a running Router costs the message in hand and no other: the Host stops once with the reason, and a restart takes the rest in order', options, async (t) => {
  const reasons: string[] = [];
  const { f, host, send, settled, state, starts, users } = setup(t, {}, { onHalt: (reason: string) => reasons.push(reason) });
  const lost = loginSwitch(f.dir);
  await host.start(1);
  assert.equal(await settled(send('先来一条')), 'processed');
  const session = f.ledger.currentContext(f.projectId)!;
  writeFileSync(lost, '');
  const [first, second, third] = [send('甲'), send('乙'), send('丙')];
  assert.equal(await settled(first), 'unverified');
  await until(() => !host.status().alive || state(third) !== 'received', '失效的进程收尾');
  await sleep(200);
  assert.deepEqual([state(second), state(third)], ['received', 'received'], '还没交给负责人的消息被逐条变成了待核实');
  assert.match(host.status().error!, /Claude 登录已失效.*设置 › 负责人.*重启负责人/);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /Claude 登录已失效/);
  assert.deepEqual(await hostProcesses.find(session.marker), []);
  assert.equal(f.ledger.currentContext(f.projectId)?.id, session.id, '会话留着，重启后续接');

  rmSync(lost);
  await host.restart();
  assert.equal(await settled(second), 'processed');
  assert.equal(await settled(third), 'processed');
  assert.deepEqual(users().slice(-2), ['乙', '丙']);
  assert.ok(starts()[1]?.argv?.includes('--resume'));
  assert.deepEqual([host.status().error, reasons.length], [null, 1]);
});

test('an authentication failure on the overview turn stops the Host the same way', options, async (t) => {
  const { f, host, send, settled, state, users } = setup(t);
  writeFileSync(loginSwitch(f.dir), '');
  await host.start(1);
  const [first, second] = [send('甲'), send('乙')];
  assert.equal(await settled(first), 'unverified');
  await until(() => !host.status().alive || state(second) !== 'received', '失效的进程收尾');
  await sleep(200);
  assert.equal(state(second), 'received');
  assert.match(host.status().error!, /Claude 登录已失效/);
  assert.equal(users().length, 1);
  assert.match(users()[0]!, /从账本重建/);
});

test('non-Claude executor auth and quota messages name the active executor and login command', options, async (t) => {
  for (const spec of [
    { executor: 'gemini' as const, label: 'Gemini', cmdPattern: /agy|GEMINI_API_KEY/ },
    { executor: 'codex' as const, label: 'Codex', cmdPattern: /codex login/ },
  ]) {
    const f = fixture(t);
    const logs: string[] = [];
    const mockScript = join(f.dir, `mock-${spec.executor}-auth.mjs`);
    if (spec.executor === 'gemini') {
      writeFileSync(mockScript, `
import { createInterface } from 'node:readline';
const write = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') { write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }); return; }
  if (msg.method === 'session/new') { write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'gem-auth-1' } }); return; }
  if (msg.method === 'session/prompt') {
    const text = msg.params.prompt.map((b) => b.text || '').join('');
    if (text.includes('额度')) { write({ jsonrpc: '2.0', id: msg.id, error: { code: 429, message: 'RESOURCE_EXHAUSTED' } }); return; }
    if (text.includes('失效')) { write({ jsonrpc: '2.0', id: msg.id, error: { code: 401, message: 'UNAUTHENTICATED' } }); return; }
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`);
    } else {
      writeFileSync(mockScript, `
import { createInterface } from 'node:readline';
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
  if (m.method === 'config/read') { send({ id: m.id, result: { config: { mcp_servers: {} } } }); return; }
  if (m.method === 'thread/start') { send({ id: m.id, result: { thread: { id: 'thr-auth-1' }, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false }, model: 'gpt-5' } }); return; }
  if (m.method === 'mcpServerStatus/list') { send({ id: m.id, result: { data: [{ name: 'tycho', runtimeStatus: 'connected', tools: { list_tasks: {} }, toolsError: null }], nextCursor: null } }); return; }
  if (m.method === 'turn/start') {
    const text = m.params.input.map((b) => b.text || '').join('');
    const turnId = 'turn-' + Math.random();
    send({ id: m.id, result: { turn: { id: turnId } } });
    if (text.includes('额度')) {
      send({ method: 'turn/completed', params: { threadId: 'thr-auth-1', turn: { id: turnId, status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } } });
    } else if (text.includes('失效')) {
      send({ method: 'turn/completed', params: { threadId: 'thr-auth-1', turn: { id: turnId, status: 'failed', error: { codexErrorInfo: 'unauthorized' } } } });
    } else {
      send({ method: 'item/completed', params: { threadId: 'thr-auth-1', turnId, item: { type: 'agentMessage', text: 'ok' } } });
      send({ method: 'turn/completed', params: { threadId: 'thr-auth-1', turn: { id: turnId, status: 'completed' } } });
    }
    return;
  }
  send({ id: m.id, result: {} });
});
`);
    }

    const host = createSessionHost({
      ...ROUTER_TUNED,
      ledger: f.ledger,
      dataDir: f.dir,
      launchWith: async () => ({ claude: [process.execPath, mockScript], executor: spec.executor }),
      toolNames: ['list_tasks'],
      log: (line) => logs.push(line),
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
      const waitSettled = async (id: string) => {
        await until(() => {
          const s = f.ledger.getMessage(id).state;
          return s === 'processed' || s === 'unverified' ? s : false;
        }, `${spec.executor} ${id}`);
      };
      await waitSettled(send('先打招呼'));
      assert.equal(f.ledger.currentContext(f.projectId)!.login_name, `${hostname()}/${spec.executor}`);
      await waitSettled(send('触发额度'));
      assert.ok(logs.some((line) => line.includes(`${spec.label} 登录额度用完了`)), `${spec.executor} quota log should name ${spec.label}: ${JSON.stringify(logs)}`);
      await waitSettled(send('触发失效'));
      const err = host.status().error ?? '';
      assert.match(err, new RegExp(`负责人用的 ${spec.label} 登录已失效`), `${spec.executor} auth error should name ${spec.label}`);
      assert.match(err, spec.cmdPattern, `${spec.executor} auth fix should name active executor command`);
      assert.equal(err.includes('Claude'), false, `${spec.executor} auth error must not hardcode Claude`);
    } finally {
      await host.stop();
    }
  }
});
