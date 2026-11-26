// Guards deleted accounts and rejected credentials against further work, leaked tokens and wrong attribution.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// --- the account a running process holds ---

test('an account gone from under a running Router stops it before the next message', options, async (t) => {
  let problem: string | null = null;
  const observed: [string, string | undefined][] = [];
  const { host, send, settled, state, starts } = setup(t, {}, {
    account: 'internal-account-id', accountName: 'one',
    bindingProblem: (id, name) => { observed.push([id, name]); return problem; },
  });
  await host.start(1);
  assert.equal(await settled(send('先来一条')), 'processed');
  // Deleted in the console with the process still up. Nobody asked for a restart.
  problem = '负责人用的账号 one 已经不在了。改绑一个账号或添回它，然后点“重启负责人”';
  const waiting = send('后来的一条');
  await until(() => host.status().error !== null, '账号没了以后停摆');
  assert.equal(host.status().error, problem);
  assert.deepEqual(observed.at(-1), ['internal-account-id', 'one'], '删除后的提示仍持有启动时的名字');
  await until(() => !host.status().alive, '进程也停下');
  await sleep(200);
  assert.equal(state(waiting), 'received', '排队的那条原样留着');
  assert.equal(starts().length, 1, '没有再起一个');
  // What stopped it is forgotten only by a restart, which is the owner's.
  problem = null;
  await sleep(100);
  assert.equal(state(waiting), 'received');
});

test('a token the Router was refused for marks the account for the Workers too, and none of it is logged', options, async (t) => {
  const REF = 'ref-0000-0000-0000-00000000000a';
  const { f, host, send, settled, logLines } = setup(t, {}, { account: 't1', credentialRef: REF, token: TOKEN });
  f.ledger.putAccount({ id: 't1', name: 't1', executor: 'claude', tiers: {} }, USER, REF);
  await host.start(1);
  assert.equal(await settled(send('回显令牌')), 'unverified');
  await until(() => host.status().error !== null, '登录被拒以后停摆');
  const reason = host.status().error!;
  assert.ok(!reason.includes(TOKEN), `停摆理由里有令牌：${reason}`);
  assert.match(reason, /令牌已隐去/);
  // What the process wrote about it lands in the log too, and it is the whole reason for
  // taking the token out at the reading end: waiting for that line is what shows it.
  await until(() => logLines.some((line) => line.includes('负责人进程退出')), '被拒的进程退出并记日志');
  assert.ok(!logLines.join('\n').includes(TOKEN), '服务日志里有令牌');
  // The statement is the account's, from the number this process was started with.
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, REF);
  const notices = f.peek<{ kind: string; payload_json: string }>(`SELECT * FROM outbox`);
  assert.deepEqual(notices.map(({ kind }) => kind), ['account_credential_rejected']);
  assert.ok(!JSON.stringify(notices).includes(TOKEN));
});

test('a rejection from a token the owner has since replaced marks nothing', options, async (t) => {
  const REF = 'ref-0000-0000-0000-00000000000a';
  const NEW = 'ref-0000-0000-0000-00000000000b';
  const { f, host, send, settled } = setup(t, {}, { account: 't1', credentialRef: REF, token: TOKEN });
  f.ledger.putAccount({ id: 't1', name: 't1', executor: 'claude', tiers: {} }, USER, REF);
  await host.start(1);
  // The owner fills in a new one while the process holds the old.
  f.ledger.recordAccountCredential('t1', NEW, USER);
  assert.equal(await settled(send('回显令牌')), 'unverified');
  await until(() => host.status().error !== null, '登录被拒以后停摆');
  assert.equal(f.ledger.loginState('t1').credential_rejected_ref, null, '失败说的是它启动时的那个编号');
  assert.equal(f.count('outbox'), 0, '新令牌没有被这件事封住');
});
