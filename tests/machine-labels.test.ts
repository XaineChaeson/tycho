import './guard.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexAdapter } from '../adapters/codex.ts';
import { dshAdapter } from '../adapters/dsh.ts';
import { probeExecutors, questionsFrom } from '../node/executors.ts';

test('Codex account/read 只投影 ChatGPT 邮箱的脱敏身份且不泄漏原始域名', () => {
  const probe = codexAdapter.identityTalk!;
  const steps = probe.steps('1');
  assert.deepEqual(JSON.parse(steps[1]!.say[1]!), { id: 2, method: 'account/read', params: { refreshToken: false } });
  const answer = (account: unknown) => JSON.stringify({ id: 2, result: { account } });
  const first = probe.parse(answer({ type: 'chatgpt', email: 'owner@example.test' }));
  assert.equal(first.accountLabel, 'owner@e***.test');
  assert.match(first.quotaOwner!, /^v1:[0-9a-f]{64}$/);
  assert.equal(first.quotaOwner, probe.parse(answer({ type: 'chatgpt', email: 'OWNER@example.test' })).quotaOwner);
  assert.notEqual(first.quotaOwner, probe.parse(answer({ type: 'chatgpt', email: 'owner@other.test' })).quotaOwner);
  assert.equal(JSON.stringify(first).includes('example.test'), false);
  assert.deepEqual(probe.parse(answer({ type: 'apiKey', email: 'owner@example.test' })), { accountLabel: null, quotaOwner: null });
  assert.deepEqual(probe.parse(answer(null)), { accountLabel: null, quotaOwner: null });
  assert.deepEqual(probe.parse(answer({ type: 'chatgpt', email: 'bad name@example.test' })), {});
  assert.deepEqual(probe.parse('{invalid'), {});
  assert.deepEqual(probe.parse(JSON.stringify({ id: 2, error: { message: 'secret' } })), {});
});

test('可选对话失败不改变登录状态或清除名称；退出不查询身份', async () => {
  const questions = questionsFrom({ codex: { ...codexAdapter, readOnly: undefined, listModels: undefined, config: undefined } });
  const run = async (argv: string[]) => ({ stdout: argv.includes('--version') ? 'codex-cli 0.167.1' : '', stderr: '', code: 0 });
  let reads = 0;
  const talk = async () => {
    reads++;
    return { answer: null, failure: 'timeout' };
  };
  const first = (await probeExecutors({ questions, run, talk })).executors[0]!;
  assert.equal(first.logged_in, true);
  assert.equal(first.identity, undefined);
  // Keep the version probe successful while the login exits nonzero.
  const logout = await probeExecutors({ questions, run: async (argv) => ({ stdout: 'codex-cli 0.167.1', stderr: '', code: argv.includes('--version') ? 0 : 1 }), talk });
  assert.equal(logout.executors[0]!.logged_in, false);
  assert.equal(logout.executors[0]!.identity, undefined);
  assert.equal(reads, 1);
});

test('dsh 从同一模型配置输出读取默认线路，其他条目和秘密不外传', async () => {
  const questions = questionsFrom({ dsh: { ...dshAdapter, config: undefined, credentialCheck: undefined } });
  const dump = '- id: other\n  config:\n    provider: wrong\n- id: agent-default-model\n  config:\n    provider: customgw\n    model: sample-model\n    api_key: secret\n- id: later\n  config:\n    provider: wrong2\n';
  let dumps = 0;
  const report = await probeExecutors({ questions, run: async (argv) => {
    if (argv.includes('--dump-config')) { dumps++; return { stdout: dump, stderr: '', code: 0 }; }
    return { stdout: 'dsh 0.2.2-rc.1', stderr: '', code: 0 };
  } });
  assert.equal(dumps, 1);
  assert.equal(report.executors[0]!.identity?.routeLabel, 'customgw');
  assert.equal(JSON.stringify(report).includes('secret'), false);
  const query = dshAdapter.listModels!({});
  assert.equal(query.kind, 'command');
  assert.equal(query.identity!(dump.replace('customgw', 'https://secret.example')).routeLabel, null);
});
