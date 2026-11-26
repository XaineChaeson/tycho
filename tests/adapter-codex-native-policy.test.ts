import './guard.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexAdapter } from '../adapters/codex.ts';
import { encodeCodexOAuthLease, materializeCodexWorkerHome, removeCodexAuthFile } from '../adapters/codex-auth.ts';
import { roundTurn } from '../runner/snapshot.ts';
import { fillPlaces } from '../node/watch.ts';
const turn = roundTurn({ brief: 'b', history: [], executor: 'codex', tier: 'execute', tier_value: { kind: 'content', text: 'model="m"\n' }, timeout_ms: 60_000 }, 'r1');
test('writable launch defaults to danger-full-access without --approve-for-me/--sandbox, and inherit-machine defers to native config', () => {
  const made = codexAdapter.launch(turn).argv;
  assert.ok(made.includes('approval_policy="never"'));
  assert.ok(made.includes('sandbox_mode="danger-full-access"'));
  assert.ok(!made.includes('--approve-for-me'));
  assert.ok(!made.includes('--sandbox'));
  assert.ok(!made.includes('--ask-for-approval'));
  const inherited = codexAdapter.launch({ ...turn, permissionMode: 'inherit-machine' }).argv;
  assert.ok(inherited.includes('approval_policy="never"'));
  assert.ok(!inherited.some((arg) => arg.startsWith('sandbox_mode=')));
  for (const artifacts of ['C:\\Program Files\\tycho data\\artifacts', "C:\\O'Brien 的目录\\artifacts", '/tmp/$& and spaces/artifacts']) {
    const argv = fillPlaces(made, { materials: '/m', artifacts });
    assert.equal(argv[argv.indexOf('--add-dir') + 1], artifacts);
    assert.ok(!argv.some(arg => arg.includes('writable_roots')));
    assert.ok(!argv.some(arg => /dangerously|ignore-user-config|ignore-rules/.test(arg)));
  }
});
test('readonly launch keeps native harness without overlaying --sandbox read-only and still passes --add-dir artifacts', () => {
  const argv = codexAdapter.launch({ ...turn, readOnly: true }).argv;
  assert.ok(!argv.includes('--sandbox'));
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(!argv.includes('--approve-for-me'));
  assert.equal(argv[argv.indexOf('--add-dir') + 1], turn.artifactsDir);
  assert.ok(!argv.some(arg => arg.includes('writable_roots')));
  assert.equal(codexAdapter.minVersion, undefined);
});
test('tiers pass through native Codex config keys without an extra key blacklist, while enforcing key=value syntax', () => {
  for (const text of [
    'model="m"\nmodel_reasoning_effort="low"\n',
    'sandbox_mode="danger-full-access"\n',
    'windows.sandbox="unelevated"\n',
    'default_permissions=":workspace"\n',
    'approvals_reviewer="user"\n',
    'model_instructions="text: permissions= and approvals_reviewer= are data"\n',
  ]) assert.equal(codexAdapter.checkTier!({ kind: 'content', text }), undefined, text);
  assert.match(codexAdapter.checkTier!({ kind: 'content', text: 'model=m\nno_equals_here\n' }) ?? '', /第 2 行没有 =/);
  assert.match(codexAdapter.checkTier!({ kind: 'content', text: '=value\n' }) ?? '', /键是空的/);
});
test('CLI non-zero exits surface original stderr without special-case rewriting', () => {
  const raw = "error: unexpected argument '--unknown' found\n\nUsage: codex exec [OPTIONS] [PROMPT]\n";
  const reading = codexAdapter.result('', 2, raw);
  assert.equal(reading.finished, false);
  assert.equal(reading.error?.kind, 'other');
  assert.equal(reading.error?.message, raw.trim());
  assert.equal(codexAdapter.result('{"type":"turn.completed"}', 0, raw).error, undefined);
});

test('materializeCodexWorkerHome preserves native .sandbox state directories and leaves config.toml sandbox settings untouched', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-codex-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseHome = join(root, 'base');
  const targetHome = join(root, 'worker');
  mkdirSync(join(baseHome, '.sandbox'), { recursive: true });
  mkdirSync(join(baseHome, '.sandbox-bin'), { recursive: true });
  mkdirSync(join(baseHome, '.sandbox-secrets'), { recursive: true });
  writeFileSync(join(baseHome, '.sandbox', 'setup_marker.json'), '{"version":5}\n');
  writeFileSync(join(baseHome, '.sandbox-bin', 'marker.txt'), 'bin\n');
  writeFileSync(join(baseHome, '.sandbox-secrets', 'sandbox_users.json'), '{}\n');
  const nativeConfig = 'sandbox_mode = "danger-full-access"\n[windows]\nsandbox = "elevated"\n';
  writeFileSync(join(baseHome, 'config.toml'), nativeConfig);

  materializeCodexWorkerHome(
    { id_token: 'id-tok', access_token: 'acc-tok', account_id: 'acct-1', last_refresh: '2026-11-24T00:00:00Z' },
    targetHome,
    baseHome,
  );

  assert.equal(readFileSync(join(targetHome, 'config.toml'), 'utf8'), nativeConfig);
  assert.equal(existsSync(join(targetHome, '.sandbox', 'setup_marker.json')), true);
  assert.equal(existsSync(join(targetHome, '.sandbox-bin', 'marker.txt')), true);
  assert.equal(existsSync(join(targetHome, '.sandbox-secrets', 'sandbox_users.json')), true);
});

test('persistent per-task codex-home preserves sessions and sqlite state across rounds while cleaning up only auth.json', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tycho-codex-home-persist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskDir = join(root, 'task-1');
  const persistentHome = join(taskDir, 'codex-home');

  const lease1 = encodeCodexOAuthLease({ id_token: 'id-1', access_token: 'acc-round-1', account_id: 'acct-1', last_refresh: '2026-11-24T00:00:00Z' });
  const env1 = codexAdapter.prepareCredential!({
    variable: 'CODEX_API_KEY',
    credential: lease1,
    scratchDir: join(root, 'run-1', 'scratch'),
    taskDir,
  });
  assert.equal(env1.CODEX_HOME, persistentHome);

  // Round 1 writes Codex sessions rollout file and SQLite state directly into persistent CODEX_HOME
  mkdirSync(join(persistentHome, 'sessions'), { recursive: true });
  writeFileSync(join(persistentHome, 'sessions', 'thread-abc.jsonl'), '{"type":"session_meta","id":"thread-abc"}\n');
  writeFileSync(join(persistentHome, 'state.sqlite'), 'sqlite-bytes');

  // Per-round finally cleanup removes ONLY auth.json, preserving sessions and SQLite state
  removeCodexAuthFile(persistentHome);
  assert.equal(existsSync(join(persistentHome, 'auth.json')), false);
  assert.equal(existsSync(join(persistentHome, 'sessions', 'thread-abc.jsonl')), true);
  assert.equal(readFileSync(join(persistentHome, 'state.sqlite'), 'utf8'), 'sqlite-bytes');

  // Round 2 refreshes auth.json in place on the same persistent codex-home
  const lease2 = encodeCodexOAuthLease({ id_token: 'id-2', access_token: 'acc-round-2', account_id: 'acct-1', last_refresh: '2026-11-24T01:00:00Z' });
  const env2 = codexAdapter.prepareCredential!({
    variable: 'CODEX_API_KEY',
    credential: lease2,
    scratchDir: join(root, 'run-2', 'scratch'),
    taskDir,
  });
  assert.equal(env2.CODEX_HOME, persistentHome);
  assert.equal(
    readFileSync(join(env2.CODEX_HOME!, 'sessions', 'thread-abc.jsonl'), 'utf8'),
    '{"type":"session_meta","id":"thread-abc"}\n',
  );
  assert.equal(readFileSync(join(env2.CODEX_HOME!, 'state.sqlite'), 'utf8'), 'sqlite-bytes');
  const auth2 = JSON.parse(readFileSync(join(env2.CODEX_HOME!, 'auth.json'), 'utf8')) as { tokens: { access_token: string } };
  assert.equal(auth2.tokens.access_token, 'acc-round-2');
});
